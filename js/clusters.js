// Clusters (spec r15-39b): the unit the simulation is split by. A cluster is a village and the land round it, so the village's
// villagers, animals, golems and the monsters and wild animals near it all belong to one cluster, and cluster borders fall in the empty
// land between villages (they are about 1,000 blocks apart). Clusters don't affect each other between meetings (every MEET ticks):
// what crosses a border waits for the next meeting, on one worker as on several (js/ctick.js), which is what lets each worker run its
// clusters on its own.
//   base clusters  "v:<village key>" for each simulated village (js/mobs.js village records); a 64-block region (js/regions.js) belongs
//                  to the nearest village's cluster within REACH blocks of its centre, else to the wild cluster of its CELL x CELL
//                  regions block, "w:<face>:<a>:<b>";
//   groups         base clusters merged for one meeting interval: every base with a region within the player's reach (the view, at most
//                  TOUCH blocks, and a margin that grows with the player's speed) goes in one group, the player's, so everything the
//                  player can touch runs together (further out in view, mobs run where the plan puts them and the page sees them as
//                  they were at the last meeting); every other base in view is a group of its own. A group is what runs on one
//                  worker; its key is its smallest base key. Merges are decided from the world's state only (the player's position,
//                  the village records), never from timing, so every worker count draws the same groups;
//   a mob's base   its village's ("v:<key>") when it belongs to a simulated village (a member, a pen animal, a stable's horse, an animal
//                  a villager is working on), else its region's; a merchant walking or dealing away on a trip, the region's it stands in. Kept on the mob (m.cl) and moved only at a meeting: a mob that walks
//                  into another cluster stays in its own until then.
// rebuild() runs at a meeting (js/ctick.js) and works all of it out again from the state then; between meetings the answers don't
// change, except for regions first met (worked out with the meeting's village list and player position) and new mobs (placed by
// where they are made).
// API: BF.clusters = { MEET, setMeet(n) (benchmarks, through BF.ctick.setMeet), REACH, rebuild(), ofRegion(key) -> base, groupOf(base) -> group key, groups() -> [{key, bases}], baseOf(mob)
//                      -> base (worked out now), place(mob) (sets m.cl), of(mob) -> m.cl, summary(mob) -> what rebuild reads of it, remote
//                      (set: id -> summary, the other workers' mobs for the next rebuild), stats(), text(), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

let MEET = Math.max(1, Math.round(8 / BF.warp.TICK));      // ticks between meetings: 160 at 0.05 s, eight game seconds at any tick (idea-049) (eight game seconds. A meeting costs about the same however long the interval: Gordon chose 40
                     // on 2026-10-28, 80 on 2026-10-30, when 8 workers on test4 went from 0.83 to 1.05 of one thread, then 160 on 2026-11-02,
                     // 18% faster than 80 on the laptop at 100x (test4, 8 workers); setMeet: benchmarks)
const REACH = 256;   // blocks from a village's centre that its cluster reaches at most: the village, its fields and pens (its chunks
                     // load out to about 120 blocks), and a margin. It was 600 (half the usual distance to the next village, plus some),
                     // but every region in the player's view takes its base into the player's group, which runs on the first worker, so a
                     // village whose outskirts merely reached into the view went there whole: Gordon's game, 2026-11-03, 17 villages, the
                     // first worker holding 173 regions at 57% busy with 3 workers holding no village. The land between villages is
                     // the wild clusters' now (cheap: few mobs, no village), and the player's group takes only the villages whose own land
                     // is in view.
const CELL = 8;      // regions along a side of a wild cluster (512 blocks)
const VIEW_PAD = 48; // blocks past the view distance that still go in the player's group (plus how far it moved since the last meeting)
const TOUCH = 96;    // ...but no further than this: the land the player can reach or be reached from before the next meeting (a monster
                     // chasing from 40 blocks, plus the 25 or so it walks in a meeting's 8 game seconds). Past it, a cluster in view runs
                     // where the plan puts it and the page sees its mobs as the last meeting left them (they move in steps, once a
                     // meeting). Gordon's laptop, 2026-11-03, 60 villages at view 32: 13 villages in the player's group, the first worker
                     // at 47% busy against 33-37% on the others. (Sending those mobs to the page every tick instead was measured
                     // 2026-11-04 and dropped: fast-forward 33-41% slower, no gain at 1x.)
// NEAR: off (BF_NEAR=0 in the world server's environment, or BF.clusters.setNear(false) through a test's eval, which every copy runs;
// it takes effect at the next meeting) puts everything in view in the player's group again, so every mob in view moves every tick
let NEAR = !(globalThis.process && process.env && process.env.BF_NEAR === "0");
const MAX_RUN = 512; // a move further than this between meetings is a jump (a teleport), not a speed: it adds nothing

let villages = [];               // [key, x, z] of the simulated villages at the last meeting, by key
let player = null;               // {x, z, r} at the last meeting
const regionBase = new Map();    // region key -> base cluster
let groupOfBase = new Map();     // base -> group key (bases in no merge: themselves)
let groupList = [];              // [{key, bases}] by key
let meetings = 0;

const P = () => BF.planet;
function nearestVillage(x, z) {
  let best = null, bd = REACH;
  const a = { x, z };
  for (const v of villages) {
    const d = P().distance(a, { x: v[1], z: v[2] });
    if (d < bd || (d === bd && best && v[0] < best)) { bd = d; best = v[0]; }
  }
  return best;
}
function ofRegion(k) {
  if (k == null || k < 0) return "w:none";
  let b = regionBase.get(k);
  if (b !== undefined) return b;
  const R = BF.regions, bx = R.bounds(k), v = nearestVillage((bx.x0 + bx.x1) / 2, (bx.z0 + bx.z1) / 2);
  if (v != null) b = "v:" + v;
  else { const p = R.parts(k); b = "w:" + p.f + ":" + Math.floor(p.ru / CELL) + ":" + Math.floor(p.rv / CELL); }
  regionBase.set(k, b);
  return b;
}

// A mob's own village, when that village is simulated (its record exists): what rworkers' units used (js/rworkers.js unitOf), with
// the animals a villager is working on (a keeper fetching a wild chicken) going with that villager's village.
const PEN_KEYS = ["penKey", "coopKey", "styKey", "pastureKey"];
const TASKS = ["pkp", "shp", "cwk", "pgk", "stb"];
let claimed = null;
function villageOf(m) {
  const v = ownVillage(m);
  if (v == null && claimed) { const c = claimed.get(m.id); if (c != null) return c; }
  return v;
}
// its village by its own fields (the claims of the villagers working on it aside)
function ownVillage(m) {
  let v = m.villageId != null ? m.villageId : m.penVillageId;
  if (v == null) for (const f of PEN_KEYS) {
    const p = m[f];
    if (typeof p !== "string") continue;
    const i = p.indexOf(":"), j = p.indexOf("|", i);
    if (i >= 0) { v = j > i ? p.slice(i + 1, j) : p.slice(i + 1); break; }
  }
  const r = v == null && m.horse;
  if (r) {
    if (typeof r.owner === "string" && r.owner.startsWith("stable:")) v = r.owner.slice(7);
    else if (r.lead && r.lead.kind === "mob" && r.lead.mob && r.lead.mob.villageId != null) v = r.lead.mob.villageId;
  }
  return v == null ? null : v;
}
// What a meeting reads of a mob to place it: [x, z, its own village (or null), roaming (1 / 0), the mob ids its tasks claim (a living
// villager of a village; else none), y, dead (1 / 0)]. With partial copies (js/cworkers.js) the mobs another worker runs come as these,
// worked out by it (BF.clusters.remote: id -> summary, for the next rebuild; the place and dead go into the stale copy too, for the
// meeting's other readers: js/villagesim.js windows); every mode places every mob by its summary alike.
function summary(m) {
  const tasks = [];
  if (m.type === "villager" && m.villageId != null && !m.dead) for (const f of TASKS) { const t = m[f] && m[f].task; if (t && t.mobId != null) tasks.push(t.mobId); }
  return [m.position.x, m.position.z, ownVillage(m), BF.merchant && BF.merchant.roaming(m) ? 1 : 0, tasks, m.position.y, m.dead ? 1 : 0];
}
let remote = null;
const sumOf = m => (remote && remote.get(m.id)) || summary(m);
function baseFrom(s, id) {
  const ground = () => ofRegion(BF.regions ? BF.regions.keyOf(s[0], 0, s[1]) : -1);
  if (s[3]) return ground();   // (a caravan on the road: the ground's, js/merchant.js)
  let v = s[2];
  if (v == null && claimed) { const c = claimed.get(id); if (c != null) v = c; }
  if (v != null && BF.mobs.villages.has(v)) return "v:" + v;
  return ground();
}
function baseOf(m) { return baseFrom(summary(m), m.id); }
function place(m) { m.cl = baseOf(m); }

function rebuild() {
  meetings++;
  villages = [...BF.mobs.villages.values()].map(r => [r.key, r.x, r.z]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // the player's reach: its view, VIEW_PAD, and as far again as it moved since the last meeting, so a player flying fast has the
  // villages ahead in its group before they come into view (they would run on another worker for up to a meeting: still between
  // meetings, and slow to answer what the player does to them)
  const pp = BF.player && BF.player.position, was = player;
  const run = pp && was ? P().distance(was, { x: pp.x, z: pp.z }) : 0;
  const vr = ((BF.world && BF.world.viewDist) || 8) * (BF.CS || 16) + VIEW_PAD, rr = run <= MAX_RUN ? run : 0;
  player = pp ? { x: pp.x, z: pp.z, r: Math.min(vr, NEAR ? TOUCH : Infinity) + rr, view: vr + rr } : null;
  regionBase.clear();
  // every mob by its summary; the animals villagers are working on (as js/rworkers.js claims) go with their villages
  claimed = new Map();
  for (const m of BF.regions ? BF.regions.ofType("villager") : BF.mobs.list) {
    if (m.removed) continue;
    const s = sumOf(m);
    for (const id of s[4]) if (!claimed.has(id)) claimed.set(id, s[2]);
  }
  const close = [];   // (the bases of the mobs within the player's reach, by their summaries: what every copy has alike)
  for (const m of BF.mobs.list) if (!m.removed) {
    const s = sumOf(m);
    m.cl = baseFrom(s, m.id);
    if (player && P().distance(player, { x: s[0], z: s[1] }) <= player.r) close.push(m.cl);
  }
  claimed = null; remote = null;
  // groups: the bases the player's view touches go together
  const bases = new Set();
  for (const m of BF.mobs.list) if (!m.removed) bases.add(m.cl);
  for (const v of villages) bases.add("v:" + v[0]);
  const near = new Set();
  if (player && BF.regions) for (const k of BF.regions.around(player.x, player.z, player.r)) near.add(ofRegion(k));
  // and the base of every mob within that reach, wherever its base is: a mob keeps its village's base wherever it walks (an explorer out
  // mapping, a villager visiting), and one near the player from a village that runs on another worker would move on the page only at
  // meetings, and answer the player only at meetings. Its village comes into the player's group while it is near.
  for (const b of close) near.add(b);
  for (const v of villages) if (near.has("v:" + v[0])) bases.add("v:" + v[0]);
  for (const b of near) bases.add(b);
  // and every base in view past that is a group of its own (with NEAR: the plan puts it on a worker), so the chunks that load there as
  // the player looks round belong to a group: land in no group goes to the first group, and the tables that file things by base
  // (js/horses.js recGroup: the records of horses rolled on a chunk there) never sent it (cluster-view: horses at the view's edge on one
  // copy only)
  if (player && BF.regions && player.view > player.r) for (const k of BF.regions.around(player.x, player.z, player.view)) bases.add(ofRegion(k));
  const sorted = [...bases].sort();
  const pkey = near.size ? [...near].sort()[0] : null;
  groupOfBase = new Map();
  const byKey = new Map();
  for (const b of sorted) {
    const g = near.has(b) ? pkey : b;
    groupOfBase.set(b, g);
    if (!byKey.has(g)) byKey.set(g, []);
    byKey.get(g).push(b);
  }
  groupList = [...byKey].map(([key, bs]) => ({ key, bases: bs, player: key === pkey })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
const groupOf = b => { const g = groupOfBase.get(b); return g !== undefined ? g : b; };

function stats() {
  const per = new Map();
  for (const m of BF.mobs.list) if (!m.removed) { const g = groupOf(m.cl); per.set(g, (per.get(g) || 0) + 1); }
  return { meetings, groups: groupList.map(g => ({ key: g.key, bases: g.bases.length, mobs: per.get(g.key) || 0, player: g.player })) };
}
const text = () => { const s = stats(); return "Clusters: " + s.groups.length + " (" + s.groups.map(g => g.key + (g.player ? "*" : "") + " " + g.mobs).join(", ") + ")"; };
function reset() { villages = []; player = null; regionBase.clear(); groupOfBase = new Map(); groupList = []; meetings = 0; claimed = null; remote = null; }

BF.clusters = { get MEET() { return MEET; }, setMeet(n) { MEET = n; }, REACH, TOUCH, get near() { return NEAR; }, setNear(on) { NEAR = !!on; }, rebuild, ofRegion, groupOf, groups: () => groupList, baseOf, place, summary, set remote(r) { remote = r; }, of: m => m.cl, villageOf, stats, text, reset };
})();
