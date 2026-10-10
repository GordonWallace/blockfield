// Far-village simulation. Villagers only exist while their chunks are loaded, so this keeps the terrain data
// (no meshes) of the nearest few villages loaded out to RADIUS blocks, letting their villagers run their
// normal AI while the player is beyond view distance. Also catches up crops when a village is revisited.
// Trips (js/merchant.js) pin both villages and a corridor of chunks between them: pinned villages run whatever the player's distance, outside
// MAX and the chunk budget, until the trip ends (unpin). At most MAX_PINS trips at a time; pins are saved with the game ("pin:<id>").
// API: BF.villageSim = { RADIUS, MAX, MAX_PINS, keepKeys, update(px, pz) -> changed, isActive(key), status(), pin(id, a, b, keys) -> ok, unpin(id),
//                        pins(), pinned() -> [worldgen villages], corridor(a, b) -> chunk keys, exportSeen(out), importSeen(o), reset() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

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
let t = 0, lastT = 0, pinDirty = false;

const vKey = v => Math.round(v.x) + "," + Math.round(v.z);
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
// (a third of the speed on dehydrated farmland, js/farmland.js).
function catchUpChunk(c, away) {
  const rate = f => 1 - Math.exp(-away * CROP_SECS_PER_DAY * GROW_RATE * f), G = growsTable(), CS = BF.CS, W = BF.world;
  const pWet = rate(1), pDry = rate(BF.farmland ? BF.farmland.DRY_GROWTH : 1 / 3), DRY = BF.B.farmland_dry;
  const found = [];
  W.scanFlagged(c, G, (x, y, z, id) => { const s = W.chunkBlock(c, x, y - 1, z); if (s === BF.B.farmland || s === DRY) found.push([x, y, z, id, s === DRY]); }, 0, BF.MIN_Y + 2);
  for (const [x, y, z, id, dry] of found) if (Math.random() < (dry ? pDry : pWet)) W.setBlock(c.cx * CS + x, y, c.cz * CS + z, G[id]);
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
// The chunks a walk from village a to village b crosses, plus one chunk either side.
function corridor(a, b) {
  const CS = BF.CS, out = new Set(), d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(d / 4));
  for (let i = 0; i <= n; i++) {
    const cx = Math.floor((a.x + (b.x - a.x) * i / n) / CS), cz = Math.floor((a.z + (b.z - a.z) * i / n) / CS);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.add((cx + dx) + "," + (cz + dz));
  }
  return [...out];
}
function pin(id, a, b, keys) {
  if (!pins.has(id) && pins.size >= MAX_PINS) return false;
  pins.set(id, { a, b, keys: keys || corridor(a, b) });
  pinDirty = true; lastT = 0;
  return true;
}
function unpin(id) { if (pins.delete(id)) { pinDirty = true; lastT = 0; } }
const pinnedKeys = () => { const s = new Set(); for (const p of pins.values()) { s.add(vKey(p.a)); s.add(vKey(p.b)); } return s; };

// Distance from a point to the village's edge (its bounds), 0 inside.
const edgeDist = (v, px, pz) => Math.hypot(Math.max(0, v.minX - px, px - v.maxX), Math.max(0, v.minZ - pz, pz - v.maxZ));

// ---- the unload countdown
// A village that would stop (the player is too far, or it lost its place among the nearest few) keeps running until its villagers' tasks are
// done: the longest estimate sets the timer. When it ends, the village and all its villagers unload together; any task still running is logged.
const ending = new Map();        // village key -> {t0, until (game day), est: [{who, task, secs}], max}
const errors = [];               // loading errors, newest last (shown on the debug screen)
const nowDay = () => dayNow();
function logError(kind, data) { errors.push(Object.assign({ kind, t: +nowDay().toFixed(3) }, data)); if (errors.length > 100) errors.shift(); }
const nameOf = m => (BF.vlog && BF.vlog.nameOf ? BF.vlog.nameOf(m) : "villager");
// Seconds of game time the villager still needs to finish what it is doing (0 = nothing that must finish). Sets taskLeft.errand when the
// task is an errand beyond the village (or a caravan trip): only those are errors if they are still running when the timer ends.
function taskLeft(m, rec) {
  taskLeft.errand = false;
  if (m.dead || m.removed || m.child || m.sleeping || m.type !== "villager") return 0;
  if (m.profession === "explorer") return 0;                         // explorers are carved out: they unload with their village wherever they are
  if (m.profession === "merchant" && m.mc && m.mc.trip && BF.merchant && BF.merchant.leftSecs) { taskLeft.errand = true; return Math.min(MAXT, BF.merchant.leftSecs(m)); }
  const v = rec.wg;
  const out = v && v.minX != null ? edgeDist(v, m.position.x, m.position.z) : Math.max(0, Math.hypot(m.position.x - rec.x, m.position.z - rec.z) - 40);
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
  for (const p of pts || []) { if (!p) continue; const px = p.x != null ? p.x : p[0], pz = p.z != null ? p.z : p[1]; d += Math.hypot(px - x, pz - z); x = px; z = pz; }
  return d * 1.3 / sp;
}
// The villager is about to start a task of `secs` game seconds (`what` names it for the debug screen). Returns false, and the task must not
// start, when its village is counting down and the task would not finish before the timer ends; otherwise records it and returns true.
function begin(m, secs, what) {
  if (!m || !m.village) return true;
  secs = Math.max(1, Math.round(secs || 0));
  if (!mayStart(m.village.key, secs)) { m.vdenied = { what, secs, t: nowDay() }; return false; }
  m.vtask = { what: what || "", secs, end: nowDay() + secs / DAY_S };
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
    if (s > 0) { list.push({ who: nameOf(m), task: BF.villagerStatus ? BF.villagerStatus.text(m) : "", secs: Math.round(s), errand: taskLeft.errand }); max = Math.max(max, s); }
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
const LIMITS = { chunks: 1500, aiMs: 6, villages: 10 };
let aiCoolUntil = 0;
const JOBS = () => [BF.toolsmith, BF.eggCook, BF.baker];
// Stops what the village's villagers are doing so that it can unload: merchants go home with their cargo, furnace and oven workers empty
// them, led animals are let go, trades are cancelled and villagers out on an errand are put back at their bed. Each one is logged.
function forceStop(rec, why) {
  const L = BF.mobs.list, key = rec.key;
  for (const m of L.slice()) {
    if (m.type !== "villager" || m.village !== rec || m.dead || m.removed) continue;
    const acts = [], task = BF.villagerStatus ? BF.villagerStatus.text(m) : "";
    if (m.tradingWith) { m.tradingWith = null; acts.push("cancelled the trade"); }
    if (m.profession === "merchant" && BF.merchant && BF.merchant.forceHome && BF.merchant.forceHome(m, why)) acts.push("went home with its cargo");
    for (const j of JOBS()) { const a = j && j.forceStop && j.forceStop(m); if (a) acts.push(a); }
    for (const o of L) if (o.ledBy === m) { o.ledBy = null; acts.push("let go of a " + o.type); }
    const v = rec.wg;
    if (m.profession !== "explorer" && !acts.length && v && v.minX != null && edgeDist(v, m.position.x, m.position.z) > 4 && BF.mobs.sendHome) { BF.mobs.sendHome(m); acts.push("went home"); }
    if (acts.length) logError("forced-stop", { village: key, who: nameOf(m), task, action: acts.join(", "), why });
  }
}
// Trips towards or from a village end when it is forced off.
function forceTrips(key, why) {
  if (!BF.merchant || !BF.merchant.forceHome) return;
  for (const m of BF.mobs.list) if (m.mc && m.mc.trip && (m.mc.trip.home === key || m.mc.trip.dest === key) && m.type === "villager") {
    BF.merchant.forceHome(m, why);
    logError("forced-stop", { village: key, who: nameOf(m), task: "caravan trip", action: "went home with its cargo", why });
  }
}
// The village to stop first, or null: 1. counting down, farthest first; 2. caravan destinations; 3. running villages beyond ALWAYS; never within ALWAYS.
function victim(next, px, pz) {
  let best = null, bs = -1;
  const dests = new Set();
  for (const p of pins.values()) dests.add(vKey(p.b));
  for (const [k, e] of next) {
    const d = edgeDist(e.v, px, pz);
    if (d <= ALWAYS) continue;
    const rank = ending.has(k) ? 3 : dests.has(k) ? 2 : 1;
    const sc = rank * 1e6 + d;
    if (sc > bs) { bs = sc; best = k; }
  }
  return best;
}
function heldChunks(next) {
  const all = new Set(winKeys);
  for (const e of next.values()) for (const k of e.keys) all.add(k);
  return all.size;
}
function overLimit(next, now) {
  if (next.size > LIMITS.villages) return "village count";
  if (heldChunks(next) > LIMITS.chunks) return "held chunks";
  if (now >= aiCoolUntil && BF.mobs.aiTime && BF.mobs.aiTime() > LIMITS.aiMs) return "AI time";
  return null;
}

// ---- chunks kept around villagers outside their village
const winKeys = new Set();
let winT = 0;
function windows() {
  const CS = BF.CS, next = new Set(), L = BF.mobs && BF.mobs.list;
  if (L) for (const m of L) {
    const rec = m.village;
    if (!rec || m.type !== "villager" || m.dead || m.removed || !m.position) continue;
    const ent = active.get(rec.key);
    if (!ent) continue;
    if (!ent.set) ent.set = new Set(ent.keys);
    const cx = Math.floor(m.position.x / CS), cz = Math.floor(m.position.z / CS);
    if (ent.set.has((cx - WIN) + "," + (cz - WIN)) && ent.set.has((cx + WIN) + "," + (cz + WIN)) && ent.set.has((cx - WIN) + "," + (cz + WIN)) && ent.set.has((cx + WIN) + "," + (cz - WIN))) continue;   // well inside its village
    for (let dz = -WIN; dz <= WIN; dz++) for (let dx = -WIN; dx <= WIN; dx++) next.add((cx + dx) + "," + (cz + dz));
  }
  let same = next.size === winKeys.size;
  if (same) for (const k of next) if (!winKeys.has(k)) { same = false; break; }
  if (same) return false;
  winKeys.clear();
  for (const k of next) winKeys.add(k);
  return true;
}

// Called from world.update every frame; cheap (re-evaluates about every 1.5 s). Returns true when the kept set changed.
function update(px, pz) {
  const now = performance.now() / 1000;
  let winChanged = false;
  if (now - winT >= 0.5) { winT = now; winChanged = windows(); }
  if (now - lastT < 1.5 && !pinDirty) { if (winChanged) rebuild(); return winChanged; }
  lastT = now;
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
  // a village that would stop waits for its villagers' tasks (the countdown); one the player came back to cancels it
  const nd = nowDay();
  for (const k of [...ending.keys()]) if (next.has(k) || !active.has(k)) ending.delete(k);
  for (const [k, e] of active) {
    if (next.has(k)) continue;
    let en = ending.get(k);
    if (!en) {
      const est = estimates(k);
      if (!(est.max > 0)) continue;                                  // nothing out on a task: it unloads now
      en = { t0: nd, until: nd + est.max / DAY_S, est: est.list, max: est.max };
      ending.set(k, en);
    }
    if (nd < en.until || nd < en.t0) { next.set(k, e); continue; }   // still counting down
    const rec = BF.mobs.villages.get(k);
    for (const x of estimates(k).list) if (x.errand) logError("task-running", { village: rec ? rec.key : k, who: x.who, task: x.task, estimate: x.secs, ran: Math.round((nd - en.t0) * DAY_S), why: "the unload timer ended" });
    ending.delete(k);
  }
  // over a limit: stop villages in priority order until it is fine (never one within ALWAYS of the player)
  for (let guard = 0; guard < 16; guard++) {
    const why = overLimit(next, now);
    if (!why) break;
    const k = victim(next, px, pz);
    if (k == null) break;
    const rec = BF.mobs && BF.mobs.villages && BF.mobs.villages.get(k);
    if (why === "AI time") aiCoolUntil = now + 5;
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
  for (const [k, e] of fresh) startCatchUp(k, e);
  for (const k of dropped) if (BF.merchant && BF.merchant.remember) BF.merchant.remember(k, true);   // its prices are written down for merchants elsewhere
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
  pinned: () => { const out = [], seenK = new Set(); for (const p of pins.values()) for (const v of [p.a, p.b]) if (!seenK.has(vKey(v))) { seenK.add(vKey(v)); out.push(v); } return out; },
  isPinned: key => pinnedKeys().has(key),
  isActive: key => active.has(key),
  LIMITS, mayStart, begin, done, walkSecs, timeLeft, countdown, errors: () => errors, estimates, ALWAYS, MAXT,
  status: () => `${active.size} sim village${active.size === 1 ? "" : "s"}, ${keepKeys.size} kept chunks` + (pins.size ? `, ${pins.size} trip${pins.size === 1 ? "" : "s"} pinned` : ""),
  exportSeen(out) {
    for (const [k, d] of seen) out["seen:" + k] = +d.toFixed(3);
    for (const [id, p] of pins) out["pin:" + id] = { a: vKey(p.a), b: vKey(p.b) };   // the corridor is worked out again on load
  },
  importSeen(o) {
    seen.clear(); pins.clear(); pinDirty = true;
    if (o) for (const k in o) {
      if (k.slice(0, 5) === "seen:") seen.set(k.slice(5), +o[k]);
      else if (k.slice(0, 4) === "pin:" && o[k] && typeof o[k].a === "string" && typeof o[k].b === "string") {
        const a = villageByKey(o[k].a), b = villageByKey(o[k].b);
        if (a && b && pins.size < MAX_PINS) pins.set(k.slice(4), { a, b, keys: corridor(a, b) });
      }
    }
  },
  reset() { winT = 0; active.clear(); ending.clear(); errors.length = 0; winKeys.clear(); seen.clear(); pending.clear(); keepKeys.clear(); pins.clear(); lastT = 0; pinDirty = false; },
  init() { BF.world.onChunkLoad(onChunkLoad); },
};
})();
