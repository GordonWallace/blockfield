// Second-screen debug feed. Sends what the F3 overlay and village panel show (plus the village's villagers, map and full log)
// to the debug server (debug/server.js), which relays it to the debug screen on its own port. Covers every village the world
// has loaded, not just the one the player is in.
// Always on, whatever F3 is doing: it streams to port 8001 on the game's host (or the address the debug server injects as
// window.BF_DEBUG_FEED, or ?debugfeed=<port or url>; ?debugfeed=off stops it). It never changes what the game shows.
// Snapshots go out 4 times a second as small POSTs; the village layout, the log and the economy tallies are only re-sent when they change.
// The server's answer carries the alerts set up on the debug screen whenever the game's copy is out of date (js/alerts.js), and
// the villager picked there; while one is picked, snapshots carry its day timeline (js/daytimeline.js) whenever it changes.
// The game log (js/gamelog.js) goes along too, a few thousand entries per snapshot until the server has all of it, and the commit
// the game runs, so the server can say when the files on disk have changed (BF.glog.diskBuild).
// While no debug server is listening it just retries quietly, every 4 s at first and then every 15 s.
// With the simulation in a Web Worker (spec r15-38) the simulation's part of each snapshot (villages, mobs, the log, the hash...) is made
// there (js/simworker.js loads this file for it: the feed query, js/protocol.js) and the page adds its own (the F3 numbers, alerts,
// planet toggles) and sends it on as before; the server's answers go back to the worker in the next query (ack).
// API: BF.debugFeed = { url (current address), urls (candidates), snapshot(), simPart(ack), update(), live() (a debug screen is watching the feed) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

// Where to send: ?debugfeed=<port|url> or the address the debug server injected, else port 8001 on the game's own host, then
// on localhost and 127.0.0.1 (a game opened by a LAN address or a name like mymac.local still finds a server on this machine).
function feedUrls() {
  const q = new URLSearchParams(location.search).get("debugfeed");
  if (q === "off") return [];
  const port = u => /^\d+$/.test(u);
  const given = q || window.BF_DEBUG_FEED || "";
  if (given && !port(given)) return [given.replace(/\/+$/, "")];
  const p = given || "8001", h = location.hostname || "localhost";
  return [...new Set([h, "localhost", "127.0.0.1"].map(x => "http://" + (x.includes(":") && !x.startsWith("[") ? "[" + x + "]" : x) + ":" + p))];
}
const URLS = BF.page ? feedUrls() : [];
if (BF.page && !URLS.length) return;
let URL_ = URLS[0], urlIdx = 0, told = false, screens = 0;   // screens: debug screens open on the server (it says when that changes)

const EVERY = 250, RETRY = 4000, RETRY_SLOW = 15000;
let misses = 0, nextT = 0, busy = false, sent = 0;

const r1 = v => Math.round(v * 10) / 10;
const box = o => [o.x0, o.z0, o.x1, o.z1];

function layout(rec) {
  const v = rec.wg || {};
  return {
    key: rec.key, x: rec.x, z: rec.z, name: BF.vlog.panelData(rec).name, biome: rec.biome,
    bounds: [v.minX, v.minZ, v.maxX, v.maxZ],
    roads: (v.roads || []).map(box), plaza: (v.pads || []).filter(p => p.path).map(box),
    buildings: (v.buildings || []).map(b => [b.x0, b.z0, b.x1, b.z1, b.type]),
    lamps: v.lamps || [],
  };
}

function status(m) {
  if (BF.villagerStatus) return BF.villagerStatus.text(m);   // trade-screen status line, when that module is loaded
  return (BF.villageLife && BF.villageLife.statusText(m)) || (BF.builder && BF.builder.statusText ? BF.builder.statusText(m) : "") ||
    (BF.explorer ? BF.explorer.statusText(m) : "") || (m.sleeping ? "Sleeping" : m.ai && m.ai.mode === "walk" ? "Walking" : "Idle");
}

// A village counts as loaded while it has live villagers in the world (its chunks are loaded and its roster spawned).
const isLoaded = rec => (rec.members || []).some(m => m.type === "villager" && !m.dead && !m.removed && m.position);
const nameOf = key => (BF.signs && BF.signs.villageName && BF.signs.villageName(key)) || "Village";

// Full detail for one loaded village: the panel's numbers, its villagers, golems and free job blocks.
// Emeralds and food (bread-equivalent) a villager holds: its inventory plus every chest it owns.
function holdings(chestsOf, m) {
  const em = BF.I && BF.I.emerald, F = BF.food, cs = chestsOf.get(BF.storage && BF.storage.keyOf ? BF.storage.keyOf(m) : null) || [];
  const emIn = a => (a || []).reduce((n, st) => n + (st && st.id === em ? st.count : 0), 0), food = a => F ? F.breadEq(a || []) : 0;
  let ce = 0, cf = 0;
  for (const c of cs) { ce += emIn(c.slots); cf += food(c.slots); }
  return { em: emIn(m.inv), emChests: ce, food: r1(food(m.inv)), foodChests: r1(cf), chests: cs.length };
}
// A villager's inventory slots, compact: 0 for empty, [id, count] or [id, count, durability left 0-1] for a worn tool.
// Icons for item ids not sent yet go out once (snapshot.icons), like layouts.
function invOf(inv) {
  if (!inv) return null;
  return inv.map(s => {
    if (!s || !s.count) return 0;
    if (!sentIcons.has(s.id)) newIcons.add(s.id);
    const max = s.wear > 0 && BF.durability ? BF.durability(s.id) : 0;
    return max ? [s.id, s.count, Math.round(Math.max(0, 1 - s.wear / max) * 100) / 100] : [s.id, s.count];
  });
}
// A poultry keeper's flock (js/poultry.js), a cowherd's herd (js/cowherd.js) or a shepherd's (js/shepherd.js): {kind, n (all of them, unloaded ones too), young, eggs (in the nest)}.
function flockOf(m) {
  try {
    if (m.profession === "poultry_keeper" && BF.poultry) {
      const T = BF.poultry.tended(m), c = T.coop;
      return { kind: "chickens", n: T.size, young: T.flock.filter(o => o.chick).length, eggs: c ? c.eggs | 0 : null, coop: !!c };
    }
    if (m.profession === "cowherd" && BF.cowherd) return BF.cowherd.holdings(m);   // {kind: "cows", n, young, milked (today), culls, limit, coop: has a pasture} (js/cowherd.js)
    if (m.profession === "pig_farmer" && BF.pigFarmer) return BF.pigFarmer.holdings(m);   // {kind: "pigs", n, young, culls, limit, coop: has a sty} (js/pigfarmer.js)
    if (m.profession === "shepherd" && BF.shepherd) { const T = BF.shepherd.tended(m); return { kind: "sheep", n: T.pen && T.pen.sheep ? T.pen.sheep.length : T.flock.length, young: T.flock.filter(o => o.lamb).length, eggs: null, coop: !!T.pen }; }
  } catch (e) { /* not loaded yet */ }
  return null;
}
function icons() {
  const out = {};
  for (const id of newIcons) {
    let url = null;
    try { url = BF.inventory && BF.inventory.iconURL ? BF.inventory.iconURL(id) : BF.textures.icon(id); } catch (e) { url = null; }
    out[id] = { url, name: (BF.itemName ? BF.itemName(id) : (BF.items[id] || {}).name || "Item " + id).replace(/ Item$/, "") };
    sentIcons.add(id);
  }
  newIcons.clear();
  return out;
}
// The tool each job works with (js/miner.js, forester.js, villagelife.js, shepherd.js): a villager without one can't do its job.
const JOB_TOOL = { miner: /_pickaxe$/, forester: /(^|_)axe$/, farmer: /_hoe$/, shepherd: /^shears$/ };
function detail(rec) {
  const L = BF.vlog, d = L.panelData(rec);
  const chestsOf = new Map();   // owner key -> chests
  if (BF.inventory && BF.inventory.chests) for (const c of BF.inventory.chests.values()) if (c.owner) { const l = chestsOf.get(c.owner) || []; l.push(c); chestsOf.set(c.owner, l); }
  d.villagerList = [];
  d.golems = [];
  for (const m of rec.members || []) {
    if (m.dead || m.removed || !m.position) continue;
    if (m.type === "iron_golem") { d.golems.push({ x: r1(m.position.x), z: r1(m.position.z), hp: m.hp, maxHp: m.maxHp }); continue; }
    if (m.type !== "villager") continue;
    d.villagerList.push({
      id: BF.dayTimeline ? BF.dayTimeline.keyOf(m) : null,   // village key#slot: how the debug screen names the villager it picked (js/daytimeline.js)
      name: L.nameOf(m), prof: m.child ? "Child" : L.pretty(m.profession), child: !!m.child,
      status: status(m) || "", x: r1(m.position.x), y: r1(m.position.y), z: r1(m.position.z),
      hp: Math.round(m.hp), maxHp: m.maxHp, bed: !!(m.bed && !m.bed.tent ? m.bed : m.homeBed), tent: !!(m.bed && m.bed.tent), sleeping: !!m.sleeping,   // an explorer's pitched tent is not a bed: its own bed (homeBed) is
      job: m.jobsite ? [m.jobsite.x, m.jobsite.z] : null, starving: !!m.starving, ...holdings(chestsOf, m),
      age: m.life ? Math.round((m.life.lived || 0) * 10) / 10 : null,   // game days it has been loaded and active
      inv: invOf(m.inv),
      flock: flockOf(m),
      horses: BF.stables ? BF.stables.holdings(m) : null,   // a stable hand's paddock horses (js/stables.js)
      bakes: m.profession === "baker" && BF.baker ? BF.baker.holdings(m) : null,   // a baker's ingredients, baked goods and oven (js/baker.js)
    });
  }
  d.villagerList.sort((a, b) => a.name.localeCompare(b.name));
  d.jobsites = BF.jobs && BF.jobs.unclaimed ? BF.jobs.unclaimed(rec).map(s => [s.x, s.z, L.pretty(s.prof)]) : [];
  // structures the village's builders planned (js/builder.js rec.built): [x0, z0, x1, z1, type, finished 0|1]
  d.built = (rec.built || []).filter(e => e.state !== "abandoned" && e.w && e.d).map(e => [e.ox, e.oz, e.ox + e.w - 1, e.oz + e.d - 1, e.type, e.state === "done" ? 1 : 0]);
  // river crossings counted in the last 3 days on an 8-block grid, [x, z, n] (js/bridges.js): the debug map draws them as a faint heat layer
  d.cross = BF.bridges ? BF.bridges.heat(rec) : [];
  // villagers who have died here (js/mobs.js rec.deadInfo, saved): name, job, cause, game day, age in days loaded and active
  d.dead = (rec.deadInfo || []).map(e => ({ name: e.name || "Someone", prof: L.pretty(e.prof || "unknown"), cause: e.cause || null, day: e.day, age: e.age == null ? null : Math.round(e.age * 10) / 10 }));
  d.clock = BF.vlog.stamp(BF.sky.day + BF.sky.time);   // when these numbers were taken, shown once the village unloads
  d.day = +(BF.sky.day + BF.sky.time).toFixed(3);
  // for the comparison table: last week's events (js/happiness.js), the population change (js/villagestats.js), tool coverage
  const H = BF.happiness, wk = k => H && H.week ? H.week(rec.key, k) : null;
  d.week = { trade: wk("trade"), birth: wk("birth"), death: wk("death") };
  d.pop7 = BF.vstats ? BF.vstats.popChange(rec.key) : null;
  const toolJobs = d.villagerList.length ? (rec.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed && m.position && !m.child && JOB_TOOL[m.profession]) : [];
  d.noTools = [toolJobs.filter(m => !(m.inv || []).some(s => s && BF.items[s.id] && JOB_TOOL[m.profession].test(BF.items[s.id].name))).length, toolJobs.length];
  d.wild = BF.wildlife ? BF.wildlife.villageStats(rec) : null;   // hostiles in its area, wild animals within 128 blocks, the last 7 nights (js/wildlife.js)
  return d;
}

// Where (x, z) is from the player (spec r14-21): { dist, dx, dz, brg }. The distance is round the planet
// (BF.planet.toward / distance), dx / dz the way there in the player's grid frame (the great circle's first step when far), and
// brg the geographic bearing (degrees clockwise from true north; null at a pole).
const tw = {};
function seen(pp, x, z) {
  const P = BF.planet, t = P.toward(pp, { x, z }, tw), b = P.bearing(pp.x, pp.z, t.x, t.z);
  return { dist: Math.round(t.d), dx: Math.round(t.x), dz: Math.round(t.z), brg: b == null ? null : Math.round(b) };
}
// The player as drawn on a village's map: [x, z, yaw] in the frame of the village's face (its villagers and buildings keep that
// frame, r14-13), so the map stays local; null when the player is on the face opposite.
function meIn(x, z, pp) {
  const P = BF.planet, yaw = BF.player.yaw || 0, F = P.face(x, z);
  const r = F >= 0 ? P.inFrame(F, pp.x, pp.z, {}) : { x: pp.x, z: pp.z, turn: 0 };
  return r ? [r1(r.x), r1(r.z), +P.turnYaw(r.turn, yaw).toFixed(2)] : null;
}

// The unit grid [dx, dz] toward true north at (x, z), for a map's north arrow; null at a pole.
function northAt(x, z) {
  const n = BF.planet.north(x, z);
  return n ? [+n[0].toFixed(3), +n[1].toFixed(3)] : null;
}

// Every village this world has loaded: the ones the mob system knows this session, plus any with a saved log (earlier
// sessions). Each snapshot carries the list with distances, full detail for the loaded ones, new layouts and changed logs.
function villages(pp) {
  const L = BF.vlog, E = BF.econ, recs = BF.mobs.villages || new Map(), out = { villages: [], detail: {}, layouts: {}, logs: {}, econ: {} };
  const keys = new Set(recs.keys());
  for (const k in L.serialize()) keys.add(k);
  if (E) for (const k of E.keys()) keys.add(k);
  for (const key of keys) {
    const rec = recs.get(key), [kx, kz] = key.split(",").map(Number);
    const x = rec ? rec.x : kx, z = rec ? rec.z : kz, loaded = !!rec && isLoaded(rec);
    const va = BF.villageLife && BF.villageLife.villageAge ? BF.villageLife.villageAge(key) : null;   // game days loaded and active
    const H = BF.happiness, happy = H ? (loaded ? H.score(rec) : H.last(key)) : null;   // js/happiness.js; an unloaded village keeps its last score
    out.villages.push({ key, name: nameOf(key), x: Math.round(x), z: Math.round(z), ...seen(pp, x, z), me: meIn(x, z, pp), north: northAt(x, z), loaded, unload: BF.villageSim && BF.villageSim.countdown ? BF.villageSim.countdown(key) : null, age: va == null ? null : Math.round(va * 10) / 10, happy });
    if (loaded) out.detail[key] = detail(rec);
    if (rec && rec.wg && !sentLayouts.has(key)) { out.layouts[key] = layout(rec); sentLayouts.add(key); }
    const a = L.entries(key), last = a[a.length - 1], sig = a.length + "|" + (last ? last[0] + last[2] : "");
    if (logSigs.get(key) !== sig) { out.logs[key] = { key, cap: L.CAP, entries: a }; logSigs.set(key, sig); }
    // the Economy view's tallies (js/economy.js), like the log: only when they changed (or a new day dropped the oldest)
    const es = E ? E.version(key) + "|" + Math.floor(BF.sky.day + BF.sky.time) : "";
    if (E && econSigs.get(key) !== es) { out.econ[key] = E.view(key); econSigs.set(key, es); }
  }
  out.villages.sort((a, b) => (b.loaded - a.loaded) || a.dist - b.dist);   // loaded first, then by distance
  const inside = L.villageAt(pp.x, pp.z);
  out.inside = inside ? inside.key : null;
  if (!out.villages.length) {   // nothing loaded yet: point the way to the nearest generated village
    const v = BF.worldgen.nearestVillage && BF.worldgen.nearestVillage(pp.x, pp.z);
    if (v) { const key = Math.round(v.x) + "," + Math.round(v.z); out.nearest = { key, name: nameOf(key), ...seen(pp, v.x, v.z) }; }
  }
  return out;
}
const sentLayouts = new Set(), logSigs = new Map(), econSigs = new Map(), sentIcons = new Set(), newIcons = new Set();
let daySig = null;   // the picked villager's day timeline as last sent: "key|version"
const resync = () => { sentLayouts.clear(); logSigs.clear(); econSigs.clear(); sentIcons.clear(); daySig = null; if (BF.glog) BF.glog.feedReset(); };
// The day timeline of the villager picked on the debug screen (js/daytimeline.js), only when it changed; null once nothing is picked.
// undefined (left out) when nothing changed, so the feed stays as light as before while nobody is picked.
function dayline() {
  const D = BF.dayTimeline;
  if (!D) return undefined;
  const k = D.picked, sig = k ? k + "|" + D.version(k) : "";
  if (sig === daySig) return undefined;
  daySig = sig;
  return k ? D.view(k) || { key: k, none: true } : null;
}
let hooked = false;
let ptv = "0";   // the last planet-toggle request from the debug screen this game has applied (debug/server.js /planet)

// The Mobs map view (once a second): every loaded mob as [kind, x, z, y, village stock 0|1, doing], kinds and doings as tables, the loaded
// chunks, the running villages and the player.
const MOBMAP_EVERY = 1000;
let mobMapT = 0;
function doingOf(m) {
  const ai = m.ai || {};
  if (m.type === "villager") return status(m) || "";
  if (m.hostile) {
    if (ai.target) return "Chasing you";
    if (ai.golemFoe) return "Fighting an iron golem";
    if (ai.vTarget) return "Hunting a villager";
    return ai.mode === "walk" ? "Wandering" : "Idle";
  }
  if (m.def && m.def.golem) return ai.provoked > 0 ? "Angry at you" : m.lookAt && m.lookAt.hostile ? "Fighting a monster" : m.village ? "Guarding its village" : "Wandering";
  if (m.ledBy) return "Being led to a village";
  if (m.mate) return "Going to a mate";
  if (ai.fleeT > 0) return "Fleeing";
  if (m.rider) return "Ridden";
  const young = m.lamb || m.calf || m.chick || m.piglet || (m.horse && m.horse.growAt != null);
  const act = ai.mode === "walk" ? "wandering" : "idle";
  return young ? "Young, " + act : act[0].toUpperCase() + act.slice(1);
}
// On the planet everything is sent in the player's face frame (spec r14-21): a mob, chunk or village on a neighbouring face comes
// unfolded beside the player's face (BF.planet.inFrame), so the map reads straight across an edge; nothing is ever on the opposite
// face or in a corner wedge, so those stay blank. face: the player's face, sq: its square in that frame, north: the unit [dx, dz]
// toward the North Pole at the player (null at a pole).
function mobMap(pp) {
  const kinds = [], kIdx = new Map(), acts = [], aIdx = new Map(), mobs = [];
  const P = BF.planet, F = P.face(pp.x, pp.z), at = {}, CS = BF.CS;
  const inF = (x, z) => F < 0 ? (at.x = x, at.z = z, at) : P.inFrame(F, x, z, at);
  const idx = (map, arr, v) => { let i = map.get(v); if (i == null) { map.set(v, i = arr.length); arr.push(v); } return i; };
  for (const m of BF.mobs.list) {
    if (m.dead || m.removed || !m.position) continue;
    const kind = m.type === "villager" ? (m.profession === "merchant" ? "merchant" : "villager") : m.type;
    const stock = m.pen || m.coop || m.pasture || (m.horse && (m.horse.pen || (m.horse.owner && m.horse.owner !== "player"))) ? 1 : 0;   // pen, coop, pasture or paddock animals
    const q = inF(m.position.x, m.position.z);
    if (!q) continue;
    mobs.push([idx(kIdx, kinds, kind), r1(q.x), r1(q.z), Math.round(m.position.y), stock, idx(aIdx, acts, doingOf(m))]);
  }
  const chunks = [];
  for (const c of BF.world.chunks.values()) {
    const q = inF(c.cx * CS + CS / 2, c.cz * CS + CS / 2);   // the chunk's centre: chunks line up with face edges, so it maps to a whole chunk
    if (q) chunks.push(Math.floor(q.x / CS), Math.floor(q.z / CS));
  }
  const villages = [];
  if (BF.villageSim && BF.villageSim.areas) for (const a of BF.villageSim.areas()) {
    if (a.kind !== "village" || !a.v || a.v.minX == null) continue;
    const p = inF(a.v.minX, a.v.minZ), x0 = p && p.x, z0 = p && p.z, q = p && inF(a.v.maxX + 1, a.v.maxZ + 1);   // block corners, so a turned box stays whole
    if (q) villages.push([Math.min(x0, q.x), Math.min(z0, q.z), Math.max(x0, q.x) - 1, Math.max(z0, q.z) - 1, nameOf(a.key)]);
  }
  // regions holding mobs (js/regions.js, spec r15-30) for the map's Regions overlay: [x0, z0, x1, z1 (exclusive), mobs]. Corner cells'
  // centres are mapped, so a region on a neighbouring face comes out as the right (turned) box.
  const regions = [];
  if (BF.regions) for (const s of BF.regions.stats()) {
    if (!s.mobs) continue;
    const b = BF.regions.bounds(s.key), p = inF(b.x0 + 0.5, b.z0 + 0.5), x0 = p && p.x, z0 = p && p.z, q = p && inF(b.x1 - 0.5, b.z1 - 0.5);
    if (q) regions.push([Math.min(x0, q.x) - 0.5, Math.min(z0, q.z) - 0.5, Math.max(x0, q.x) + 0.5, Math.max(z0, q.z) + 0.5, s.mobs]);
  }
  const out = { kinds, acts, mobs, chunks, villages, regions, region: BF.regions ? BF.regions.REGION : 0, player: [r1(pp.x), r1(pp.z), +(BF.player.yaw || 0).toFixed(2)], cs: CS };
  if (F >= 0) {
    const x0 = P.W * F + P.N;
    Object.assign(out, { face: F, sq: [x0, P.N, x0 + P.N, 2 * P.N], north: northAt(pp.x, pp.z) });
  }
  return out;
}

// The world state hash (js/statehash.js) and its parts, for bug reports: worked out every HASH_EVERY ms (about 15 ms with a 55-villager village loaded), not on every snapshot.
const HASH_EVERY = 10000;
let hashT = -Infinity;
function stateHash() {
  if (!BF.stateHash) return undefined;
  if (Date.now() - hashT >= HASH_EVERY || !BF.stateHash.last) { hashT = Date.now(); BF.stateHash.full(); }
  return BF.stateHash.last;
}

// The simulation's part of a snapshot. ack: what the server answered last time, when the simulation is in a worker (its log position,
// the commit on disk, the picked villager, a resync).
function simPart(ack) {
  if (ack) applyAck(ack);
  const pp = BF.player.position;
  const mobs = {};
  for (const m of BF.mobs.list) if (!m.dead && !m.removed) { const k = m.type === "chicken" ? (m.coop ? "chicken (coop)" : "chicken (wild)") : m.type === "cow" ? (m.pasture ? "cow (pasture)" : "cow (wild)") : m.type === "pig" ? (m.sty ? "pig (sty)" : "pig (wild)") : m.type; mobs[k] = (mobs[k] || 0) + 1; }   // chickens: penned and wild (js/poultry.js)
  if (BF.boats) Object.assign(mobs, BF.boats.counts());   // boats by wood ("oak_boat": n) next to the mob types
  return { mobs, professions: (BF.mobs.professions || []).map(BF.vlog.pretty), ...villages(pp), icons: icons(),
    gt: +(BF.sky.day + BF.sky.time).toFixed(5),   // game time now (days), for the day timeline's "now" edge
    mobmap: Date.now() - mobMapT >= MOBMAP_EVERY ? (mobMapT = Date.now(), mobMap(pp)) : undefined,
    pick: BF.dayTimeline ? { pv: BF.dayTimeline.pv, key: BF.dayTimeline.picked } : null, day: dayline(),
    loadLimits: BF.villageSim && BF.villageSim.LIMITS && BF.mobs.aiTime ? { aiMs: BF.mobs.aiTime(), aiWork: BF.mobs.aiWork ? BF.mobs.aiWork() : 0, maxAiWork: BF.villageSim.LIMITS.aiWork, villages: BF.villageSim.status().split(" ")[0] | 0, maxVillages: BF.villageSim.LIMITS.villages } : null,
    loadErrors: BF.villageSim && BF.villageSim.errors ? BF.villageSim.errors().slice(-30) : [],   // loading errors (js/villagesim.js)
    routes: BF.merchant ? BF.merchant.routes().map(r => Object.assign(r, { an: nameOf(r.a), bn: nameOf(r.b) })) : null,   // caravan routes (js/merchant.js)
    // the villager-seconds meter (js/perf.js), on while the screen gets the feed: figures and the last 2 minutes of V·s/s
    perf: BF.perf && BF.perf.on ? Object.assign(BF.perf.stats() || {}, { hist: BF.perf.history() }) : undefined,
    budget: BF.active ? BF.active.feed() : undefined,   // the simulation budget and its decisions (js/active.js, spec r15-34)
    requests: BF.req ? BF.req.stats() : undefined,   // the request queue and transition-mode direct writes by module (js/requests.js)
    hash: stateHash(),   // the world state hash and its parts (js/statehash.js)
    glog: BF.glog ? BF.glog.feed() : undefined, build: BF.glog ? BF.glog.build.commit : undefined };   // the game log's new entries; the commit running
}
// The server's answer, the simulation's part of it. screens: how many debug screens are open (the villager-seconds meter runs while any
// is, js/perf.js); off the page the simulation hears it here (r15-43)
let simScreens = 0;
function applyAck(o) {
  if (o.screens != null) simScreens = o.screens | 0;
  if (o.glogAt != null && BF.glog) BF.glog.feedAt(o.glogAt);   // the server holds the game log up to there
  if (o.build && BF.glog) BF.glog.diskBuild(o.build);          // the commit on disk isn't the one running
  if ("pick" in o && BF.dayTimeline) BF.dayTimeline.pick(o.pick, o.pv);
  if (o.resync) resync();
}
if (!BF.page) {   // in the simulation worker: only the feed query (js/simworker.js)
  if (BF.proto) BF.proto.queries.feed = a => Object.assign({ ok: true }, simPart(a && a.ack));
  BF.debugFeed = { simPart, live: () => simScreens > 0 };
  return;
}
// With the simulation in a worker: its latest part (asked for once a snapshot; it comes back before the next one) and the answer to pass on
let remote = null, ack = null, remoteErr = null;
// With the page a client of the world server (r15-41): the server makes the snapshots itself (debug/server.js is the same process) and
// this page sends only its own part, over the server's socket; the answers for the page come back the same way (serverAck).
const onServer = () => !!(BF.simHost && BF.simHost.server);
const inWorker = () => !!(BF.client && BF.client.mode === "worker") && !onServer();
function snapshot() {
  const info = BF.debugInfo();
  let part;
  if (onServer()) part = {};
  else if (inWorker()) {
    BF.client.query("feed", { ack }, r => { if (r && r.ok) { delete r.ok; remote = r; } else if (r && r.error) remoteErr = r.error; });
    ack = null;
    if (remoteErr) { const e = remoteErr; remoteErr = null; throw new Error("in the simulation: " + e); }   // (the screen shows it, as one here)
    part = remote || {};
    remote = null;
    for (const id in part.icons || {}) if (part.icons[id] && !part.icons[id].url) { try { part.icons[id].url = BF.inventory.iconURL ? BF.inventory.iconURL(+id) : BF.textures.icon(+id); } catch (e) { /* none */ } }
  } else part = simPart();
  return Object.assign({ t: Date.now(), n: ++sent, info, text: BF.debugText(info), paused: !!BF.state.paused, hidden: document.hidden }, part, {
    // the planet debug toggles (js/view.js setDebug: F3 + B / C / R, or the debug screen's Planet section) and which request from the
    // screen they include (tv)
    pt: BF.view && BF.view.debug ? { tv: ptv, ...BF.view.debug } : null,
    // alerts (js/alerts.js): which set the game holds (the server answers with a newer one) and how often each has fired
    screens,
    alerts: BF.alerts ? { av: BF.alerts.av, hits: BF.alerts.hits, active: BF.alerts.active ? BF.alerts.active.alert.id : null } : null,
  });
}
// the simulation's part of the answer: here, or to the worker with the next query
const passAck = o => { if (inWorker()) ack = Object.assign(ack || {}, o); else applyAck(o); };

function update() {
  const now = performance.now();
  if (!hooked && BF.on) { hooked = true; BF.on("newWorld", resync); }   // main.js (which defines BF.on) loads after this file
  if (busy || now < nextT || !BF.debugInfo) return;
  nextT = now + EVERY;
  if (onServer()) {
    try { BF.simHost.post({ feedPage: snapshot() }); } catch (e) { console.warn("debug feed:", e); nextT = now + RETRY; }
    return;
  }
  let body;
  try { body = JSON.stringify(snapshot()); }
  catch (e) {   // tell the debug screen too, so it shows the error instead of waiting for the game
    console.warn("debug feed:", e); nextT = now + RETRY;
    body = JSON.stringify({ t: Date.now(), n: ++sent, error: String(e && e.stack || e).split("\n").slice(0, 3).join("\n") });
  }
  busy = true;
  // text/plain keeps it a "simple" cross-origin request (no CORS preflight)
  // gives up after 5 s, so a request that never gets an answer can't stop the feed for good
  const ctl = new AbortController(), stop = setTimeout(() => ctl.abort(), 5000);
  fetch(URL_ + "/push", { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: body.length < 60000, signal: ctl.signal })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(t => {
      if (t.charAt(0) === "{") {   // {resync?, alerts?, av?, pick?, pv?, screens?, glogAt?, build?}: the server's alerts / picked villager, when the game's copy is out of date
        const o = JSON.parse(t);
        const a = {};
        if (o.glogAt != null) a.glogAt = o.glogAt;
        if (o.build) a.build = o.build;
        if ("pick" in o) { a.pick = o.pick; a.pv = o.pv; }
        passAck(a);
        if (o.alerts && BF.alerts) BF.alerts.set(o.alerts, o.av);
        if (o.pt && BF.view && BF.view.setDebug) { ptv = o.ptv; BF.view.setDebug(o.pt); }   // a toggle clicked on the debug screen
        if (o.screens != null) { screens = o.screens | 0; if (inWorker()) passAck({ screens }); }
        t = o.resync ? "resync" : "ok";
      }
      if (t === "resync") { resync(); if (inWorker()) passAck({ resync: true }); }   // a restarted server asks for the layouts and logs again
    })
    .then(() => { if (!told) { told = true; console.info("Blockfield debug feed: sending to " + URL_); } misses = 0; })
    .catch(() => {                                // server down or not at this address: try the next one, resend everything when it's back
      misses++;
      if (misses === URLS.length * 2 && !told) console.info("Blockfield debug feed: no debug server at " + URLS.join(" or ") + ". Start ./run.sh (or node debug/server.js) to use the debug screen; the game plays normally without it.");
      URL_ = URLS[urlIdx = (urlIdx + 1) % URLS.length];
      BF.debugFeed.url = URL_;
      nextT = performance.now() + (misses > 5 * URLS.length ? RETRY_SLOW : RETRY / URLS.length);
      told = false; screens = 0; resync(); if (inWorker()) passAck({ resync: true });
    })
    .finally(() => { busy = false; clearTimeout(stop); });
}

// The world server's answers that are this page's: alerts, a planet toggle, how many screens are open, the item icons it lacks
function serverAck(o) {
  if (o.alerts && BF.alerts) BF.alerts.set(o.alerts, o.av);
  if (o.pt && BF.view && BF.view.setDebug) { ptv = o.ptv; BF.view.setDebug(o.pt); }
  if (o.screens != null) screens = o.screens | 0;
  if (o.resync) resync();
  told = true;
  if (o.icons) {
    const out = {};
    for (const id of o.icons) {
      let url = null;
      try { url = BF.inventory && BF.inventory.iconURL ? BF.inventory.iconURL(+id) : BF.textures.icon(+id); } catch (e) { url = null; }
      if (url) out[id] = { url };
    }
    BF.simHost.post({ feedIcons: out });
  }
}

BF.debugFeed = { url: URL_, urls: URLS, snapshot, simPart, update, serverAck, live: () => told && screens > 0 };   // live: a debug screen is watching the feed
// The game loop (requestAnimationFrame) stops while the game's tab is in the background, e.g. when the debug screen is opened
// as another tab in the same window. A timer keeps the feed going then (browsers still run it about once a second), so the
// debug screen can say the game is in the background instead of waiting for it.
setInterval(() => { if (document.hidden) update(); }, 1000);
})();
