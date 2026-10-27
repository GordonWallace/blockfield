// Clusters (spec r15-39b): the unit the simulation is split by. A cluster is a village and the land round it, so the village's
// villagers, animals, golems and the monsters and wild animals near it all belong to one cluster, and cluster borders fall in the empty
// land between villages (they are about 1,000 blocks apart). Clusters don't affect each other between meetings (every MEET ticks):
// what crosses a border waits for the next meeting, on one worker as on several (js/ctick.js), which is what lets each worker run its
// clusters on its own.
//   base clusters  "v:<village key>" for each simulated village (js/mobs.js village records); a 64-block region (js/regions.js) belongs
//                  to the nearest village's cluster within REACH blocks of its centre, else to the wild cluster of its CELL x CELL
//                  regions block, "w:<face>:<a>:<b>";
//   groups         base clusters merged for one meeting interval: every base with a region within the player's view (and a margin) goes
//                  in one group, the player's, so everything the player can see or touch runs together. A group is what runs on one
//                  worker; its key is its smallest base key. Merges are decided from the world's state only (the player's position,
//                  the village records), never from timing, so every worker count draws the same groups;
//   a mob's base   its village's ("v:<key>") when it belongs to a simulated village (a member, a pen animal, a stable's horse, an animal
//                  a villager is working on), else its region's; a merchant walking or dealing away on a trip, the region's it stands in. Kept on the mob (m.cl) and moved only at a meeting: a mob that walks
//                  into another cluster stays in its own until then.
// rebuild() runs at a meeting (js/ctick.js) and works all of it out again from the state then; between meetings the answers don't
// change, except for regions first met (worked out with the meeting's village list and player position) and new mobs (placed by
// where they are made).
// API: BF.clusters = { MEET, REACH, rebuild(), ofRegion(key) -> base, groupOf(base) -> group key, groups() -> [{key, bases}], baseOf(mob)
//                      -> base (worked out now), place(mob) (sets m.cl), of(mob) -> m.cl, stats(), text(), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const MEET = 20;     // ticks between meetings (one game second)
const REACH = 600;   // blocks from a village's centre that its cluster reaches at most (half the usual distance to the next, plus some)
const CELL = 8;      // regions along a side of a wild cluster (512 blocks)
const VIEW_PAD = 48; // blocks past the view distance that still go in the player's group

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
  if (v == null && claimed) { const c = claimed.get(m.id); if (c != null) v = c; }
  return v;
}
function baseOf(m) {
  if (BF.merchant && BF.merchant.roaming(m)) return ofRegion(BF.regions ? BF.regions.keyOf(m.position.x, 0, m.position.z) : -1);   // (a caravan on the road: the ground's, js/merchant.js)
  const v = villageOf(m);
  if (v != null && BF.mobs.villages.has(v)) return "v:" + v;
  return ofRegion(BF.regions ? BF.regions.keyOf(m.position.x, 0, m.position.z) : -1);
}
function place(m) { m.cl = baseOf(m); }

function rebuild() {
  meetings++;
  villages = [...BF.mobs.villages.values()].map(r => [r.key, r.x, r.z]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const pp = BF.player && BF.player.position;
  player = pp ? { x: pp.x, z: pp.z, r: ((BF.world && BF.world.viewDist) || 8) * (BF.CS || 16) + VIEW_PAD } : null;
  regionBase.clear();
  // the animals villagers are working on (as js/rworkers.js claims)
  claimed = new Map();
  for (const m of BF.regions ? BF.regions.ofType("villager") : BF.mobs.list) {
    if (m.villageId == null || m.dead || m.removed) continue;
    for (const f of TASKS) { const t = m[f] && m[f].task; if (t && t.mobId != null && !claimed.has(t.mobId)) claimed.set(t.mobId, m.villageId); }
  }
  for (const m of BF.mobs.list) if (!m.removed) place(m);
  claimed = null;
  // groups: the bases the player's view touches go together
  const bases = new Set();
  for (const m of BF.mobs.list) if (!m.removed) bases.add(m.cl);
  for (const v of villages) bases.add("v:" + v[0]);
  const near = new Set();
  if (player && BF.regions) for (const k of BF.regions.around(player.x, player.z, player.r)) near.add(ofRegion(k));
  for (const v of villages) if (near.has("v:" + v[0])) bases.add("v:" + v[0]);
  for (const b of near) bases.add(b);
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
function reset() { villages = []; player = null; regionBase.clear(); groupOfBase = new Map(); groupList = []; meetings = 0; claimed = null; }

BF.clusters = { MEET, REACH, rebuild, ofRegion, groupOf, groups: () => groupList, baseOf, place, of: m => m.cl, villageOf, stats, text, reset };
})();
