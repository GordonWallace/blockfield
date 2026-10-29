// Far-village simulation. Villagers only exist while their chunks are loaded, so this keeps the terrain data
// (no meshes) of the nearest few villages loaded out to RADIUS blocks, letting their villagers run their
// normal AI while the player is beyond view distance. Also catches up crops when a village is revisited.
// Trips (js/merchant.js) pin both villages and a corridor of chunks between them: pinned villages run whatever the player's distance, outside
// MAX and the chunk budget, until the trip ends (unpin). At most MAX_PINS trips at a time; pins are saved with the game ("pin:<id>").
// The rule above is the minimum (spec r15-34): js/active.js adds "extra" villages on top of it while the simulation has time to spare in
// each real second, and takes them off again (through the countdown below) when it hasn't. Extras don't count toward the force-unload limits.
// With the cluster tick on (spec r15-39b, js/ctick.js): the set is decided only at meetings (meet, a "start" hook: before the clusters are
// worked out again), so villages, their records and the trips' pins come and go only there, never between two clusters' passes; the
// countdowns that tasks read (mayStart, timeLeft) then hold for the whole interval in every cluster. Trips ask for their pin at the
// meeting too (js/merchant.js meet, run first): pin and unpin are called only between ticks then.
// API: BF.villageSim = { RADIUS, MAX, MAX_PINS, keepKeys, update(px, pz) -> changed, isActive(key), status(), count(), pin(id, a, b, keys) -> ok, unpin(id),
//                        pins(), pinned() -> [worldgen villages], simulated() -> [worldgen villages], corridor(a, b) -> chunk keys, exportSeen(out), importSeen(o), state() / load(s) (the checks' clocks and focus: js/rplay.js), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const RS = e => BF.rand.of(e);   // seeded random streams (js/rand.js)

const RADIUS = 200;       // a village this close to the player is simulated
const DROP = 216;         // ...and keeps being simulated until it is this far (hysteresis)
const MAX = 4;            // nearest N villages at a time
const CHUNK_BUDGET = 640; // ...holding at most this many chunks between them (4 classic villages fit; the nearest one always runs)
const MARGIN = 16;        // blocks of terrain kept beyond the village bounds (farms, paths)
const ALWAYS = 100;       // a village whose edge is this close to the player is always simulated (past MAX and the chunk budget)
const WIN = 2;            // chunks kept around every villager (5 x 5): the ground it walks on beyond its village
const MAXT = 2400;        // seconds (2 game days): the longest a village waits for its villagers' tasks before unloading
const DAY_S = 1200;
const CROP_SECS_PER_DAY = 1200, GROW_RATE = 1 / 240;   // matches sky.dayLength and world.js GROW_CHANCE_PER_S

const active = new Map();        // village key -> { v, keys: [chunk keys] }
const seen = new Map();          // village key -> game day it was last simulated
const pending = new Map();       // village key -> { away, todo: Set(chunk keys) } crops still to catch up
const keepKeys = new Set();
const MAX_PINS = 2;              // trips on the road at once, world-wide
const pins = new Map();          // trip id -> { a, b (worldgen villages), keys: [corridor chunk keys] }
let t = 0, pinDirty = false, hooked = false;

const vKey = v => Math.round(v.x) + "," + Math.round(v.z);
// The planet (spec r14-15): villages are canonical records, and villagers are kept in their village's frame even past a face edge (js/mobs.js
// frames), so a point is first seen from the village (BF.planet.local) before it is measured against the village's box; distances between
// two places use BF.planet.distance; chunk keys are always canonical (canonKey).
const PL = () => BF.planet;
const LQ = {}, CQ = {};
function canonKey(x, z) {
  const CS = BF.CS;
  const c = PL().canonCell(Math.floor(x), Math.floor(z), CQ);
  if (!c.off) { x = c.x; z = c.z; }
  return Math.floor(x / CS) + "," + Math.floor(z / CS);
}
const pdist = (a, b) => PL().distance(a, b);
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);

function footprint(v) {
  const CS = BF.CS;
  let x0 = Math.floor((v.minX - MARGIN) / CS), x1 = Math.floor((v.maxX + MARGIN) / CS);
  let z0 = Math.floor((v.minZ - MARGIN) / CS), z1 = Math.floor((v.maxZ + MARGIN) / CS);
  const keys = [];
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) keys.push(x + "," + z);
  return keys;
}

let GROWS = null;
function growsTable() {
  if (GROWS) return GROWS;
  GROWS = new Int32Array(BF.MAX_BLOCK + 1);
  for (const b of BF.blocks) if (b && b.growsInto) GROWS[b.id] = b.growsInto;
  return GROWS;
}

// Young crops on farmland that sat unloaded for `away` game days: each matures with the chance it would have had
// (a third of the speed on dehydrated farmland, js/farmland.js). A world block tick (spec r15-19): a chunk to catch up is queued, and the
// queue is worked in the tick's block phase in chunk order (catchUpTick), never as a write from the think phase or a chunk load.
const catchQ = new Map();   // chunk key -> game days away
// With the cluster tick on (spec r15-39b, item C6: js/ctick.js) the tick runs once per cluster group over the group's own chunks (a
// chunk's group: its centre's), and a chunk of another group queued during a group's pass is queued at the next meeting.
const CCs = () => BF.world.clusterCells;
const chunkGroup = (cx, cz) => CCs().cellGroup(cx * BF.CS + 8, cz * BF.CS + 8);
function catchUpChunk(c, away) {
  const CC = CCs(), g = CC && CC.cur();
  if (g && chunkGroup(c.cx, c.cz) !== g.key) { CC.toMeeting("catchUp", c.cx * BF.CS + 8, c.cz * BF.CS + 8, { x: c.cx, y: 0, z: c.cz, away }); return; }
  catchQ.set(c.cx + "," + c.cz, Math.max(away, catchQ.get(c.cx + "," + c.cz) || 0));
}
function catchUpTick() {
  if (!catchQ.size) return;
  const CC = CCs(), g = CC && CC.cur();
  let list = [...catchQ].map(([k, away]) => { const [cx, cz] = k.split(",").map(Number); return { k, cx, cz, away }; });
  if (g) list = list.filter(e => chunkGroup(e.cx, e.cz) === g.key);
  list.sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  if (g) for (const e of list) catchQ.delete(e.k); else catchQ.clear();
  for (const e of list) { const c = BF.world.chunks.get(e.k); if (c) catchUpNow(c, e.away); }
}
if (BF.world.clusterCells) {
  const CC = BF.world.clusterCells;
  CC.onMeeting("catchUp", d => { const c = BF.world.chunks.get(d.x + "," + d.z); if (c) catchUpChunk(c, d.away); });
  CC.later(() => BF.ctick.owned("catchUp", {   // (several workers, C7: a group's chunks waiting to catch up)
    snap: gk => [...catchQ].filter(([k]) => { const [cx, cz] = k.split(",").map(Number); return chunkGroup(cx, cz) === gk; }),
    apply: (gk, list) => {
      for (const k of [...catchQ.keys()]) { const [cx, cz] = k.split(",").map(Number); if (chunkGroup(cx, cz) === gk) catchQ.delete(k); }
      for (const [k, v] of list) catchQ.set(k, v);
    },
  }));
}
function catchUpNow(c, away) {
  const rate = f => 1 - Math.exp(-away * CROP_SECS_PER_DAY * GROW_RATE * f), G = growsTable(), CS = BF.CS, W = BF.world;
  const pWet = rate(1), pDry = rate(BF.farmland ? BF.farmland.DRY_GROWTH : 1 / 3), DRY = BF.B.farmland_dry;
  const found = [];
  W.scanFlagged(c, G, (x, y, z, id) => { const s = W.chunkBlock(c, x, y - 1, z); if (s === BF.B.farmland || s === DRY) found.push([x, y, z, id, s === DRY]); }, 0, BF.MIN_Y + 2);
  const day = Math.floor(BF.sky ? BF.sky.day || 0 : 0);   // seeded by the chunk and the visit day (js/rand.js)
  for (const [x, y, z, id, dry] of found) if (BF.rand.at("catchup", c.cx * CS + x, c.cz * CS + z, day, y).next() < (dry ? pDry : pWet)) W.setBlock(c.cx * CS + x, y, c.cz * CS + z, G[id]);
}

function startCatchUp(key, ent) {
  const last = seen.get(key);
  if (last == null) return;
  const away = dayNow() - last;
  if (!(away > 0.1)) return;
  const todo = new Set();
  for (const k of ent.keys) {
    const c = BF.world.chunks.get(k);
    if (c) catchUpChunk(c, away); else todo.add(k);
  }
  if (todo.size) pending.set(key, { away, todo });
}

function rebuild() {
  keepKeys.clear();
  for (const ent of active.values()) for (const k of ent.keys) keepKeys.add(k);
  for (const p of pins.values()) for (const k of p.keys) keepKeys.add(k);
  for (const k of winKeys) keepKeys.add(k);
}
// The chunks a walk from village a to village b crosses, plus one chunk either side: walk from a toward b in 4-block steps (BF.planet.toward: straight through an edge's unfold when close, along the great circle
// when far), keeping the walker on its canonical square, and add each step's chunk and the chunks either side in the walker's frame, mapped
// to their canonical keys.
function corridor(a, b) {
  const P = PL(), CS = BF.CS, out = new Set(), p = { x: a.x, z: a.z }, t = {}, c = {};
  for (let i = 0; i < 100000; i++) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.add(canonKey(p.x + dx * CS, p.z + dz * CS));
    P.toward(p, b, t);
    if (!(t.d > 4)) break;
    p.x += t.x / t.d * 4; p.z += t.z / t.d * 4;
    P.canon(p.x, p.z, c);
    if (c.off) break;
    p.x = c.x; p.z = c.z;
  }
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.add(canonKey(b.x + dx * CS, b.z + dz * CS));
  return [...out];
}
function pin(id, a, b, keys) {
  if (!pins.has(id) && pins.size >= MAX_PINS) return false;
  pins.set(id, { a, b, keys: keys || corridor(a, b) }); areasV++;
  pinDirty = true;
  return true;
}
function unpin(id) { if (pins.delete(id)) { pinDirty = true; areasV++; } }
const pinnedKeys = () => { const s = new Set(); for (const p of pins.values()) { s.add(vKey(p.a)); s.add(vKey(p.b)); } return s; };

// Distance from a point to the village's edge (its bounds), 0 inside.
// (The point is seen from the village first, so a player or villager just across a face edge measures true.)
function edgeDist(v, px, pz) {
  LQ.x = px; LQ.z = pz; PL().local(v, LQ, LQ); px = LQ.x; pz = LQ.z;
  return Math.hypot(Math.max(0, v.minX - px, px - v.maxX), Math.max(0, v.minZ - pz, pz - v.maxZ));
}

// ---- the unload countdown
// A village that would stop (the player is too far, or it lost its place among the nearest few) keeps running until its villagers' tasks are
// done: the longest estimate sets the timer. When it ends, the village and all its villagers unload together; any task still running is logged.
const ending = new Map();        // village key -> {t0, until (game day), est: [{who, task, secs}], max}
const errors = [];               // loading errors, newest last (shown on the debug screen)
const nowDay = () => dayNow();
function logError(kind, data, lvl) {
  if (!lvl) { errors.push(Object.assign({ kind, t: +nowDay().toFixed(3) }, data)); if (errors.length > 100) errors.shift(); }   // (a WARN is no loading error)
  if (BF.glog) BF.glog.log(lvl || "ERROR", "loading", kind === "task-running" ? data.who + "'s task was cut off when the village unloaded: " + data.task + " (estimate " + data.estimate + " s, ran " + data.ran + " s; " + data.why + ")"
    : data.who + " was stopped mid-task: " + data.task + " (" + data.action + "; " + data.why + ")", { village: data.village });   // js/gamelog.js
}
// At leisure: no task begun (begin) and doing one of the leisure things in js/villagerstatus.js. A task that runs past its estimate still counts.
const isLeisure = m => !m.vtask && !!(BF.villagerStatus && BF.villagerStatus.leisure && BF.villagerStatus.leisure(m));
const vlogLine = (rec, text, where) => { if (BF.vlog && rec) BF.vlog.log(rec, "loading", text, where); };   // the game log gets it at INFO (js/gamelog.js)
const nameOf = m => (BF.vlog && BF.vlog.nameOf ? BF.vlog.nameOf(m) : "villager");
// Seconds of game time the villager still needs to finish what it is doing (0 = nothing that must finish). Sets taskLeft.errand when the
// task is an errand beyond the village (or a caravan trip): only those are errors if they are still running when the timer ends.
function taskLeft(m, rec) {
  taskLeft.errand = false;
  if (m.dead || m.removed || m.child || m.sleeping || m.type !== "villager") return 0;
  if (m.profession === "explorer") return 0;                         // explorers are carved out: they unload with their village wherever they are
  if (m.profession === "merchant" && m.mc && m.mc.trip && BF.merchant && BF.merchant.leftSecs) { taskLeft.errand = true; return Math.min(MAXT, BF.merchant.leftSecs(m)); }
  if (isLeisure(m)) return 0;                                         // strolling, relaxing and the like: the village doesn't wait for them
  const v = rec.wg;
  const out = v && v.minX != null ? edgeDist(v, m.position.x, m.position.z) : Math.max(0, pdist(rec, m.position) - 40);
  const t = m.vtask, left = t && t.end > nowDay() ? (t.end - nowDay()) * DAY_S : 0;   // what its task's estimate says is left (begin)
  if (out > 4) { taskLeft.errand = true; return Math.min(MAXT, Math.max(left, out * 1.3 / (((m.def && m.def.speed) || 0.9) * travellerSpeed(m)))); }   // out beyond the edge: at least the walk back
  return Math.min(MAXT, left);
}
// ---- task estimates: a villager says how long a task will take before it starts it (begin). While its village counts down, a task that
// would not finish in the time left is not started (the job picks something shorter or waits), and the estimates set the timer.
const travellerSpeed = m => (m.profession === "merchant" || m.profession === "explorer" ? 1.5 : 1);
// Seconds to walk from the villager through the points ([x, z] or {x, z}) in turn: straight-line distance with a margin for paths.
function walkSecs(m, pts) {
  const sp = ((m.def && m.def.speed) || 0.9) * travellerSpeed(m);
  let x = m.position.x, z = m.position.z, d = 0;
  for (const p of pts || []) { if (!p) continue; const px = p.x != null ? p.x : p[0], pz = p.z != null ? p.z : p[1]; d += pdist({ x, z }, { x: px, z: pz }); x = px; z = pz; }
  return d * 1.3 / sp;
}
// The plan's margin on every task estimate: jobs work out the walk and the work, and real tasks run slower (paths, crowds, shopping in between).
const EST_MARGIN = 1.25;
// The villager is about to start a task of `secs` game seconds (`what` names it for the debug screen). Returns false, and the task must not
// start, when its village is counting down and the task would not finish before the timer ends; otherwise records it and returns true.
function begin(m, secs, what) {
  if (!m || !m.village) return true;
  secs = Math.max(1, Math.round((secs || 0) * EST_MARGIN));
  if (!mayStart(m.village.key, secs)) { m.vdenied = { what, secs, t: nowDay() }; return false; }
  m.vtask = { what: what || "", secs, t0: nowDay(), end: nowDay() + secs / DAY_S };
  return true;
}
// The task is over (or was given up): nothing left to wait for.
function done(m) { if (m) m.vtask = null; }
// Time left on the village's countdown in seconds (Infinity when it is not counting down), for jobs that size a task to fit.
function timeLeft(key) { const en = ending.get(key); return en ? Math.max(0, (en.until - nowDay()) * DAY_S) : Infinity; }
function estimates(key) {
  const rec = BF.mobs && BF.mobs.villages && BF.mobs.villages.get(key), list = [];
  let max = 0;
  if (rec) for (const m of rec.members) {
    const s = taskLeft(m, rec);
    if (s > 0) {
      const t = m.vtask, x = { who: nameOf(m), task: BF.villagerStatus ? BF.villagerStatus.text(m) : "", secs: Math.round(s), errand: taskLeft.errand };
      if (t && t.t0 != null) { x.est = t.secs; x.ran = Math.round((nowDay() - t.t0) * DAY_S); }   // the task's own estimate and how long it has run
      list.push(x); max = Math.max(max, s);
    }
  }
  list.sort((a, b) => b.secs - a.secs);
  return { list, max: Math.min(max, MAXT) };
}
// May a task of `secs` seconds start in this village now? (false while the countdown has less time left)
function mayStart(key, secs) {
  const en = ending.get(key);
  return !en || secs <= (en.until - nowDay()) * DAY_S;
}
function countdown(key) {
  const en = ending.get(key);
  if (!en) return null;
  return { left: Math.max(0, Math.round((en.until - nowDay()) * DAY_S)), est: en.est.slice(0, 6), max: Math.round(en.max) };
}

// ---- force unload: when the game would bog down, villages are stopped even with tasks running (each one logged as an error)
// aiWork: villager AI updates per game step (averaged over about 5 game seconds; BF.mobs.aiWork), a count rather than milliseconds so the
// same villages stop on a fast machine and a slow one (spec r15-16). 300 updates is about 6 ms of thinking at ~20 us an update.
const LIMITS = { chunks: 1500, aiWork: 300, villages: 10 };
let aiCoolUntil = 0;
const JOBS = () => [BF.toolsmith, BF.eggCook, BF.baker, BF.glassmaker, BF.beekeeper, BF.pigFarmer];
// Stops what the village's villagers are doing so that it can unload: merchants go home with their cargo, furnace and oven workers empty
// them, led animals are let go, trades are cancelled and villagers out on an errand are put back at their bed. Each one is logged.
function forceStop(rec, why) {
  const key = rec.key, led = new Map();   // (the led animals, found in one pass: a lead can be any length)
  for (const o of BF.mobs.list) { const by = o.ledBy; if (by) { if (!led.has(by)) led.set(by, []); led.get(by).push(o); } }
  for (const m of BF.regions.villageMobs(rec, m => m.type === "villager")) {   // (its own villagers, r15-32)
    if (m.type !== "villager" || m.village !== rec || m.dead || m.removed) continue;
    const acts = [], task = BF.villagerStatus ? BF.villagerStatus.text(m) : "", leisure = isLeisure(m);   // (before the jobs' stops below clear its task)
    if (m.tradingWith) { m.tradingWith = null; acts.push("cancelled the trade"); }
    if (m.profession === "merchant" && BF.merchant && BF.merchant.forceHome && BF.merchant.forceHome(m, why)) acts.push("went home with its cargo");
    const stopJob = j => j && j.forceStop && (BF.furnaceUse ? BF.furnaceUse.direct(() => j.forceStop(m)) : j.forceStop(m));   // furnaces emptied at once: it is packed next (js/furnaceuse.js)
    for (const j of JOBS()) { const a = stopJob(j); if (a) acts.push(a); }
    for (const o of led.get(m) || []) if (o.ledBy === m) { o.ledBy = null; acts.push("let go of a " + o.type); }
    const v = rec.wg;
    if (!acts.length && leisure) continue;                      // leisure ends quietly (endLeisure, when the village unloads)
    if (m.profession !== "explorer" && !acts.length && v && v.minX != null && edgeDist(v, m.position.x, m.position.z) > 4 && BF.mobs.sendHome) { BF.mobs.sendHome(m); acts.push("went home"); }
    if (acts.length) logError("forced-stop", { village: key, who: nameOf(m), task, action: acts.join(", "), why });
  }
}
// The village is unloading: leisure just ends, without an error. A villager at leisure out beyond the edge is put back home so that it
// isn't left out there; one line in the village log names them.
function endLeisure(key) {
  const rec = BF.mobs && BF.mobs.villages && BF.mobs.villages.get(key), v = rec && rec.wg;
  if (!rec || !BF.mobs.sendHome) return;
  const ended = [];
  for (const m of rec.members) {
    if (m.dead || m.removed || m.type !== "villager" || m.profession === "explorer" || !isLeisure(m)) continue;
    const task = BF.villagerStatus.text(m);
    if (v && v.minX != null && edgeDist(v, m.position.x, m.position.z) > 4) { BF.mobs.sendHome(m); ended.push(nameOf(m) + " (" + task.toLowerCase() + ")"); }
  }
  if (ended.length) vlogLine(rec, "Unloaded: " + ended.join(", ") + " stopped and went home");
}
// Trips towards or from a village end when it is forced off.
function forceTrips(key, why) {
  if (!BF.merchant || !BF.merchant.forceHome) return;
  for (const m of BF.regions.ofType("villager").slice()) if (m.mc && m.mc.trip && (m.mc.trip.home === key || m.mc.trip.dest === key)) {
    BF.merchant.forceHome(m, why);
    logError("forced-stop", { village: key, who: nameOf(m), task: "caravan trip", action: "went home with its cargo", why });
  }
}
// The village to stop first, or null: 1. counting down, farthest first; 2. caravan destinations; 3. running villages beyond ALWAYS; never within ALWAYS.
function victim(next, px, pz, extra) {
  let best = null, bs = -1;
  const dests = new Set();
  for (const p of pins.values()) dests.add(vKey(p.b));
  for (const [k, e] of next) {
    const d = edgeDist(e.v, px, pz);
    if (d <= ALWAYS || extra.has(k)) continue;
    const rank = ending.has(k) ? 3 : dests.has(k) ? 2 : 1;
    const sc = rank * 1e6 + d;
    if (sc > bs) { bs = sc; best = k; }
  }
  return best;
}
function heldChunks(next, extra) {
  const all = new Set(winKeys);
  for (const [k, e] of next) if (!extra.has(k)) for (const c of e.keys) all.add(c);
  return all.size;
}
// The limits hold the minimum set (and trips); budget extras (js/active.js) are left out of them: the budget takes them off gracefully when
// the game slows, so while any run the AI-time limit waits for that instead of forcing villages off.
function overLimit(next, now, extra) {
  if (next.size - extra.size > LIMITS.villages) return "village count";
  if (heldChunks(next, extra) > LIMITS.chunks) return "held chunks";
  if (!extra.size && now >= aiCoolUntil && BF.mobs.aiWork && BF.mobs.aiWork() > LIMITS.aiWork) return "AI time";
  return null;
}

// ---- chunks kept around villagers outside their village
const winKeys = new Set();
function windows() {
  const CS = BF.CS, next = new Set(), V = BF.mobs && BF.mobs.villages;
  if (V) for (const [key, ent] of active) for (const m of BF.regions.villageMobs(V.get(key), m => m.type === "villager" && !m.dead && !!m.position)) {   // (the running villages' own villagers, r15-32)
    if (!ent.set) ent.set = new Set(ent.keys);
    const x = m.position.x, z = m.position.z, K = (dx, dz) => canonKey(x + dx * CS, z + dz * CS);   // (canonical: a villager past an edge is kept in its village's frame)
    if (ent.set.has(K(-WIN, -WIN)) && ent.set.has(K(WIN, WIN)) && ent.set.has(K(-WIN, WIN)) && ent.set.has(K(WIN, -WIN))) continue;   // well inside its village
    for (let dz = -WIN; dz <= WIN; dz++) for (let dx = -WIN; dx <= WIN; dx++) next.add(K(dx, dz));
  }
  let same = next.size === winKeys.size;
  if (same) for (const k of next) if (!winKeys.has(k)) { same = false; break; }
  if (same) return false;
  winKeys.clear();
  for (const k of next) winKeys.add(k);
  areasV++;
  return true;
}

// The clock (spec r15-16): the set is re-checked on the simulation clock, from the game step (step(), hooked into world.tickSim), so countdowns
// end and limits act on the same game moments on any machine and at any speed. world.update calls update() every frame with the player's
// position, which step() then uses; only while the world doesn't step (0x or paused) does that frame call re-check on real time itself, so
// walking up to a village at 0x still loads it. Nothing in the simulation moves meanwhile, so that can't change what happens.
// Chunk data for the kept set is generated by world.update within its frame budget (real time), but that only decides when chunks arrive:
// villagers and their jobs never act on an unloaded chunk (they wait, or their village waits for them, js/mobs.js isLoaded checks).
let focusX = null, focusZ = null, stepChanged = false;
const simClock = { win: -1e9, last: -1e9 }, realClock = { win: -1e9, last: -1e9 };
const stepping = () => !(BF.warp && BF.warp.frozen) && !(BF.state && BF.state.paused);
const clustered = () => !!(BF.ctick && BF.ctick.on);
// Called from world.update every frame. Returns true when the kept set changed (here, or in a step since the last call).
function update(px, pz) {
  focusX = px; focusZ = pz;
  let changed = stepChanged;
  stepChanged = false;
  // (a trip pinned or unpinned since the last step is taken at once: nothing has stepped since, so it is the same moment the next step would see;
  // with the cluster tick on, at the next meeting)
  if ((!stepping() || (pinDirty && !clustered())) && check(px, pz, realClock, BF.rworkers.realNow() / 1000)) changed = true;
  return changed;
}
// Called every game step (world.tickSim); cheap (re-evaluates every 1.5 game seconds, the villager windows every 0.5). With the cluster
// tick on, at meetings instead (meet).
function step() {
  if (focusX == null || clustered()) return;
  if (check(focusX, focusZ, simClock, BF.simNow())) stepChanged = true;
}
// A meeting of the cluster tick: the trips' pin asks first (js/merchant.js), then the set (the clock check as step() does it).
// With partial copies (js/cworkers.js) the merchants come current first (merchant.meet reads and clears what they noted), and a
// village's mobs before the set reads their tasks or stops them (fetchVillage).
// (which mobs is asked of each one's current copy: a stale copy may not show yet that it joined the village or became a merchant)
const fetch = pred => { if (BF.cworkers && BF.cworkers.partial) BF.cworkers.fetch(BF.mobs.list, pred); };
// (at a meeting each village's mobs come over once, those of every village the set may stop in one exchange: fetched)
let fetched = null;
function fetchVillages(keys) {
  const ks = new Set(fetched ? keys.filter(k => !fetched.has(k)) : keys);
  if (!ks.size) return;
  if (fetched) for (const k of ks) fetched.add(k);
  fetch(m => ks.has(m.villageId) || ks.has(m.penVillageId) || (m.ledBy && ks.has(m.ledBy.villageId)));
}
const fetchVillage = key => fetchVillages([key]);
function meet() {
  if (BF.merchant && BF.merchant.meet) { if (!(BF.cworkers && BF.cworkers.merchantsCurrent && BF.cworkers.merchantsCurrent())) fetch(m => m.mc); BF.merchant.meet(); }   // (sent whole at the swap: js/cworkers.js)
  if (focusX == null) return;
  fetched = new Set();
  try { if (check(focusX, focusZ, simClock, BF.simNow())) stepChanged = true; } finally { fetched = null; }
}
function check(px, pz, clk, now) {
  let winChanged = false;
  if (now - clk.win >= 0.5 || now < clk.win) { clk.win = now; winChanged = windows(); }   // (the clock restarts with a new world)
  if (now - clk.last < 1.5 && now >= clk.last && !pinDirty) { if (winChanged) rebuild(); return winChanged; }
  clk.last = now;
  const pinChange = pinDirty;
  pinDirty = false;
  const wg = BF.worldgen;
  if (!wg || typeof wg.villagesNear !== "function") return false;
  let near;
  try { near = wg.villagesNear(px, pz, DROP + 200) || []; } catch (e) { return false; }   // the query is by centre: reach villages whose edge is near
  const cand = [];
  for (const v of near) if (v && v.x != null && v.minX != null) { const d = edgeDist(v, px, pz); if (d <= DROP) cand.push({ v, key: vKey(v), d }); }
  cand.sort((a, b) => a.d - b.d);
  const next = new Map();
  let kept = 0;
  // pinned villages first, outside MAX and the chunk budget
  for (const p of pins.values()) for (const v of [p.a, p.b]) { const k = vKey(v); if (!next.has(k)) next.set(k, active.get(k) || { v, keys: footprint(v), pinned: true }); }
  // then every village whose edge is within ALWAYS of the player
  for (const c of cand) if (c.d <= ALWAYS && !next.has(c.key)) { next.set(c.key, active.get(c.key) || { v: c.v, keys: footprint(c.v) }); }
  const nPinned = next.size;
  for (const c of cand) {
    if (next.size - nPinned >= MAX) break;
    if (next.has(c.key)) continue;
    if (!(c.d <= RADIUS || (active.has(c.key) && c.d <= DROP))) continue;
    const e = active.get(c.key) || { v: c.v, keys: footprint(c.v) };
    if (next.size > nPinned && kept + e.keys.length > CHUNK_BUDGET) continue;   // big (sized) villages: fewer of them at a time
    kept += e.keys.length;
    next.set(c.key, e);
  }
  // then the budget's extras (js/active.js), beyond the minimum
  // (an extra keeps its flag while it counts down after leaving the set, so the limits leave it alone then too)
  const extra = new Set();
  for (const e of next.values()) e.extra = false;
  if (BF.active) for (const x of BF.active.decide(px, pz, next)) if (!next.has(x.key)) { const e = active.get(x.key) || { v: x.v, keys: footprint(x.v) }; e.extra = true; next.set(x.key, e); extra.add(x.key); }
  // a village that would stop waits for its villagers' tasks (the countdown); one the player came back to cancels it
  const nd = nowDay();
  for (const k of [...ending.keys()]) if (next.has(k) || !active.has(k)) ending.delete(k);
  if (fetched) fetchVillages([...active.keys()].filter(k => { if (next.has(k)) return false; const en = ending.get(k); return !en || !(nd < en.until || nd < en.t0); }));   // (the ones the loop below reads: starting or ending their countdown)
  for (const [k, e] of active) {
    if (next.has(k)) continue;
    let en = ending.get(k);
    if (!en) {
      fetchVillage(k);
      const est = estimates(k);
      if (!(est.max > 0)) continue;                                  // nothing out on a task: it unloads now
      // an extra the budget let go (too slow, or past the player's distance limit) waits a short while only (js/active.js waitCap)
      const cap = BF.active && BF.active.waitCap ? BF.active.waitCap(k) : null;
      if (cap != null && est.max > cap) est.max = cap;
      en = { t0: nd, until: nd + est.max / DAY_S, est: est.list, max: est.max, cap: cap != null ? BF.active.waitWhy(k) : null };
      ending.set(k, en);
      const top = est.list[0];
      vlogLine(BF.mobs.villages.get(k), "Unloading in " + Math.round(est.max) + " s: waiting for " + est.list.length + " task" + (est.list.length === 1 ? "" : "s") + (top ? ", longest " + top.who + " (" + top.task + ")" : ""));
    }
    if (nd < en.until || nd < en.t0) { next.set(k, e); if (e.extra) extra.add(k); continue; }   // still counting down
    const rec = BF.mobs.villages.get(k);
    fetchVillage(k);
    // (cut short on purpose when the budget let it go: a WARN, not an error)
    for (const x of estimates(k).list) if (x.errand) logError("task-running", { village: rec ? rec.key : k, who: x.who, task: x.task, estimate: x.est != null ? x.est : x.secs, ran: x.ran != null ? x.ran : Math.round((nd - en.t0) * DAY_S), why: en.cap ? "the unload timer ended early: " + en.cap : "the unload timer ended" }, en.cap ? "WARN" : undefined);
    ending.delete(k);
  }
  // over a limit: stop villages in priority order until it is fine (never one within ALWAYS of the player)
  for (let guard = 0; guard < 16; guard++) {
    const why = overLimit(next, BF.simNow(), extra);
    if (!why) break;
    const k = victim(next, px, pz, extra);
    if (k == null) break;
    const rec = BF.mobs && BF.mobs.villages && BF.mobs.villages.get(k);
    if (why === "AI time") aiCoolUntil = BF.simNow() + 5;
    fetchVillage(k);
    if (rec) forceStop(rec, why);
    forceTrips(k, why);
    ending.delete(k);
    next.delete(k);
    if (why === "AI time") break;                                    // let the average settle before the next one
  }
  let changed = pinChange || next.size !== active.size || winChanged;
  for (const k of next.keys()) if (!active.has(k)) changed = true;
  for (const k of active.keys()) if (!next.has(k)) changed = true;
  for (const k of active.keys()) if (!next.has(k)) pending.delete(k);
  const dropped = [...active.keys()].filter(k => !next.has(k));
  const fresh = [...next].filter(([k]) => !active.has(k));
  active.clear();
  for (const [k, e] of next) active.set(k, e);
  areasV++;
  for (const [k, e] of fresh) startCatchUp(k, e);
  for (const k of dropped) fetchVillage(k);
  for (const k of dropped) if (BF.merchant && BF.merchant.remember) BF.merchant.remember(k, true);   // its prices are written down for merchants elsewhere
  for (const k of dropped) endLeisure(k);
  for (const k of dropped) if (BF.mobs && BF.mobs.unloadVillage) BF.mobs.unloadVillage(k);   // the village and all its villagers go together
  // stamp villages whose centre is loaded: the last stamp is when the village stopped being simulated
  const d = dayNow();
  for (const [k, e] of active) if (BF.world.isLoaded(e.v.x, e.v.z)) seen.set(k, d);
  if (changed) rebuild();
  return changed;
}

function onChunkLoad(cx, cz, c) {
  if (!pending.size) return;
  const k = cx + "," + cz;
  for (const [vk, p] of pending) {
    if (!p.todo.delete(k)) continue;
    catchUpChunk(c, p.away);
    if (!p.todo.size) pending.delete(vk);
  }
}

// The areas the kept chunks fall in, for js/wildlife.js's monster density cap: each running village with its margin, each trip's corridor, and
// each group of touching villager windows. A window group that overlaps or touches a village or a trip belongs to that area: it is the ground
// its villagers walk at the village's edge, and as a separate area of its own the monsters spawned in the village drifted into it (zombies
// after villagers walking the edge at dusk) and took it over its cap. Kept together, nothing loaded lies around the village to drift in from.
// [{kind: "village" | "trip" | "window", key, keys: [chunk keys]}], worked out again only when the running villages, the trips' pins or the
// windows changed (areasV; with clusters every group asks once per meeting): read it, don't change it
let areasV = 0, areasAt = -1, areasOut = null;
function areas() {
  if (areasAt === areasV && areasOut) return areasOut;
  areasOut = areasNow(); areasAt = areasV;
  return areasOut;
}
function areasNow() {
  const out = [], own = new Map();   // chunk key -> the village or trip area it is in
  for (const [k, e] of active) out.push({ kind: "village", key: k, keys: e.keys.slice(), v: e.v });
  for (const [id, p] of pins) out.push({ kind: "trip", key: id, keys: p.keys.slice() });
  for (const a of out) for (const k of a.keys) if (!own.has(k)) own.set(k, a);
  const left = new Set(winKeys);
  for (const k0 of winKeys) {
    if (!left.delete(k0)) continue;
    const keys = [k0];
    let to = null;
    for (let i = 0; i < keys.length; i++) {
      const [cx, cz] = keys[i].split(",").map(Number);
      to = to || own.get(keys[i]);
      for (const n of [(cx + 1) + "," + cz, (cx - 1) + "," + cz, cx + "," + (cz + 1), cx + "," + (cz - 1)]) { to = to || own.get(n); if (left.delete(n)) keys.push(n); }
    }
    if (to) { for (const k of keys) if (!own.has(k)) { own.set(k, to); to.keys.push(k); } }
    else out.push({ kind: "window", key: k0, keys });
  }
  return out;
}

// a saved village by its key: the worldgen village there
function villageByKey(key) {
  const [x, z] = key.split(",").map(Number);
  let vs = [];
  try { vs = BF.worldgen.villagesNear(x, z, 8) || []; } catch (e) { return null; }
  return vs.find(v => v && vKey(v) === key) || null;
}

BF.villageSim = {
  RADIUS, MAX, MAX_PINS,
  keepKeys,
  update,
  pin, unpin, corridor,
  pins: () => pins,
  count: () => active.size,   // villages simulated now (js/mobs.js: the A* searches a tick hands out)
  simulated: () => [...active.values()].map(e => e.v),   // every village simulated now (the minimum, pins and the budget's extras)
  pinned: () => { const out = [], seenK = new Set(); for (const p of pins.values()) for (const v of [p.a, p.b]) if (!seenK.has(vKey(v))) { seenK.add(vKey(v)); out.push(v); } return out; },
  isPinned: key => pinnedKeys().has(key),
  isActive: key => active.has(key),
  areas, get areasV() { return areasV; }, LIMITS, mayStart, begin, done, walkSecs, timeLeft, countdown, errors: () => errors, estimates, ALWAYS, MAXT, DROP, EST_MARGIN,
  _edgeDist: edgeDist, footprint, count: () => active.size,
  extraCount() { let n = 0; for (const e of active.values()) if (e.extra) n++; return n; },   // of count(): the budget's extras, counting down too (js/active.js)
  status: () => `${active.size} sim village${active.size === 1 ? "" : "s"}` + (BF.active && BF.active.extras().length ? ` (${BF.active.extras().length} extra)` : "") + `, ${keepKeys.size} kept chunks` + (pins.size ? `, ${pins.size} trip${pins.size === 1 ? "" : "s"} pinned` : ""),
  exportSeen(out) {
    for (const [k, d] of seen) out["seen:" + k] = +d.toFixed(3);
    for (const [id, p] of pins) out["pin:" + id] = { a: vKey(p.a), b: vKey(p.b) };   // the corridor is worked out again on load
  },
  importSeen(o) {
    seen.clear(); pins.clear(); pinDirty = true; areasV++;
    if (o) for (const k in o) {
      if (k.slice(0, 5) === "seen:") seen.set(k.slice(5), +o[k]);
      else if (k.slice(0, 4) === "pin:" && o[k] && typeof o[k].a === "string" && typeof o[k].b === "string") {
        const a = villageByKey(o[k].a), b = villageByKey(o[k].b);
        if (a && b && pins.size < MAX_PINS) { pins.set(k.slice(4), { a, b, keys: corridor(a, b) }); areasV++; }
      }
    }
  },
  // the clocks of the checks, the focus and what waits for the next one: module state no save holds, handed to the region workers as they
  // boot (js/rplay.js begin) so every copy checks the set on the same ticks
  state: () => ({ sim: [simClock.win, simClock.last], real: [realClock.win, realClock.last], pinDirty, stepChanged, focus: [focusX, focusZ], aiCoolUntil }),
  load(s) {
    if (!s) return;
    [simClock.win, simClock.last] = s.sim; [realClock.win, realClock.last] = s.real;
    pinDirty = !!s.pinDirty; stepChanged = !!s.stepChanged; [focusX, focusZ] = s.focus; aiCoolUntil = s.aiCoolUntil || 0;
  },
  // (the focus too: the title world's, kept into a loaded world, made the first tick check the set there on the leader only, and its copies
  // checked out of step from then on: villages joined a few ticks apart, Gordon's test4, 2026-10-29)
  reset() { if (BF.active) BF.active.reset(); simClock.win = simClock.last = realClock.win = realClock.last = -1e9; stepChanged = false; focusX = focusZ = null; aiCoolUntil = 0; active.clear(); catchQ.clear(); ending.clear(); errors.length = 0; winKeys.clear(); seen.clear(); pending.clear(); keepKeys.clear(); pins.clear(); pinDirty = false; areasV++; },
  init() {
    BF.world.onChunkLoad(onChunkLoad);
    BF.world.onThink(step, "villageSim");   // re-checks on the game clock (update), in the think phase (js/world.js tickSim)
    if (BF.world.onBlockTick) BF.world.onBlockTick(catchUpTick, "catchUp");   // crop catch-up, a block tick (spec r15-19)
    if (BF.ctick && !hooked) {   // the shared table published at meetings, first, then the set (spec r15-39b)
      hooked = true;
      if (BF.sharedTable) BF.ctick.onMeet(BF.sharedTable.publish, "shared", "start");
      BF.ctick.onMeet(meet, "villageSim", "start");
    }
  },
};
})();
