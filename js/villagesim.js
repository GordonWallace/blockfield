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
const MAX_SPAN = 12;      // chunks per axis, cap for oversized footprints (classic villages)
const MAX_SPAN_SIZED = 20; // ...and for sized villages (village generator 2, up to ~250 blocks across)
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
  const cx = Math.floor(v.x / CS), cz = Math.floor(v.z / CS), half = (v.pop ? MAX_SPAN_SIZED : MAX_SPAN) >> 1;
  x0 = Math.max(x0, cx - half); x1 = Math.min(x1, cx + half); z0 = Math.max(z0, cz - half); z1 = Math.min(z1, cz + half);
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

// Called from world.update every frame; cheap (re-evaluates about every 1.5 s). Returns true when the kept set changed.
function update(px, pz) {
  const now = performance.now() / 1000;
  if (now - lastT < 1.5 && !pinDirty) return false;
  lastT = now;
  const pinChange = pinDirty;
  pinDirty = false;
  const wg = BF.worldgen;
  if (!wg || typeof wg.villagesNear !== "function") return false;
  let near;
  try { near = wg.villagesNear(px, pz, DROP) || []; } catch (e) { return false; }
  const cand = [];
  for (const v of near) if (v && v.x != null && v.minX != null) cand.push({ v, key: vKey(v), d: Math.hypot(v.x - px, v.z - pz) });
  cand.sort((a, b) => a.d - b.d);
  const next = new Map();
  let kept = 0;
  // pinned villages first, outside MAX and the chunk budget
  for (const p of pins.values()) for (const v of [p.a, p.b]) { const k = vKey(v); if (!next.has(k)) next.set(k, active.get(k) || { v, keys: footprint(v), pinned: true }); }
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
  let changed = pinChange || next.size !== active.size;
  for (const k of next.keys()) if (!active.has(k)) changed = true;
  for (const k of active.keys()) if (!next.has(k)) pending.delete(k);
  const fresh = [...next].filter(([k]) => !active.has(k));
  active.clear();
  for (const [k, e] of next) active.set(k, e);
  for (const [k, e] of fresh) startCatchUp(k, e);
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
  reset() { active.clear(); seen.clear(); pending.clear(); keepKeys.clear(); pins.clear(); lastT = 0; pinDirty = false; },
  init() { BF.world.onChunkLoad(onChunkLoad); },
};
})();
