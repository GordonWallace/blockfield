// Far-village simulation. Villagers only exist while their chunks are loaded, so this keeps the terrain data
// (no meshes) of the nearest few villages loaded out to RADIUS blocks, letting their villagers run their
// normal AI while the player is beyond view distance. Also catches up crops when a village is revisited.
// API: BF.villageSim = { RADIUS, MAX, keepKeys, update(px, pz) -> changed, isActive(key), status(),
//                        onCatchUp(fn(mob, rec, awayDays)), exportSeen(out), importSeen(o), reset() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const RADIUS = 200;       // a village this close to the player is simulated
const DROP = 216;         // ...and keeps being simulated until it is this far (hysteresis)
const MAX = 4;            // nearest N villages at a time
const MARGIN = 16;        // blocks of terrain kept beyond the village bounds (farms, paths)
const MAX_SPAN = 12;      // chunks per axis, cap for oversized footprints
const CROP_SECS_PER_DAY = 600, GROW_RATE = 1 / 120;   // matches sky.dayLength and world.js GROW_CHANCE_PER_S

const active = new Map();        // village key -> { v, keys: [chunk keys] }
const seen = new Map();          // village key -> game day it was last simulated
const pending = new Map();       // village key -> { away, todo: Set(chunk keys) } crops still to catch up
const awayOf = new Map();        // village key -> { away, done: Set(mobs), ready } villagers still to catch up
const hooks = [];                // fn(mob, villageRec, awayDays), see onCatchUp
const keepKeys = new Set();
let t = 0, lastT = 0;

const vKey = v => Math.round(v.x) + "," + Math.round(v.z);
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);

function footprint(v) {
  const CS = BF.CS;
  let x0 = Math.floor((v.minX - MARGIN) / CS), x1 = Math.floor((v.maxX + MARGIN) / CS);
  let z0 = Math.floor((v.minZ - MARGIN) / CS), z1 = Math.floor((v.maxZ + MARGIN) / CS);
  const cx = Math.floor(v.x / CS), cz = Math.floor(v.z / CS), half = MAX_SPAN >> 1;
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

// Young crops on farmland that sat unloaded for `away` game days: each matures with the chance it would have had.
function catchUpChunk(c, away) {
  const p = 1 - Math.exp(-away * CROP_SECS_PER_DAY * GROW_RATE), G = growsTable(), CS = BF.CS, W = BF.world;
  const vox = c.vox, top = Math.min(BF.H - 1, c.maxY + 1);
  for (let y = 2; y <= top; y++) for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const id = vox[BF.vIdx(x, y, z)];
    if (!G[id] || vox[BF.vIdx(x, y - 1, z)] !== BF.B.farmland) continue;
    if (Math.random() < p) W.setBlock(c.cx * CS + x, y, c.cz * CS + z, G[id]);
  }
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
  awayOf.set(key, { away, done: new Set(), ready: null });
}

// Villagers of a village that was away run the registered hooks once, when its crops have caught up and every chunk
// of its footprint is loaded (so a hook may place and break blocks anywhere around the village).
function catchUpVillagers(now) {
  for (const [key, a] of awayOf) {
    const ent = active.get(key);
    if (!ent) { awayOf.delete(key); continue; }
    if (pending.has(key) || !ent.keys.every(k => BF.world.chunks.has(k))) continue;
    if (a.ready == null) a.ready = now;
    if (now - a.ready > 90) { awayOf.delete(key); continue; }   // the roster has had its chance to spawn
    const rec = BF.mobs && BF.mobs.villages && BF.mobs.villages.get(key);
    if (!rec) continue;
    for (const m of rec.members) {
      if (m.removed || m.dead || m.type !== "villager" || a.done.has(m)) continue;
      a.done.add(m);
      for (const fn of hooks) { try { fn(m, rec, a.away); } catch (e) { console.error(e); } }
    }
  }
}

function rebuild() {
  keepKeys.clear();
  for (const ent of active.values()) for (const k of ent.keys) keepKeys.add(k);
}

// Called from world.update every frame; cheap (re-evaluates about every 1.5 s). Returns true when the kept set changed.
function update(px, pz) {
  const now = performance.now() / 1000;
  if (now - lastT < 1.5) return false;
  lastT = now;
  const wg = BF.worldgen;
  if (!wg || typeof wg.villagesNear !== "function") return false;
  let near;
  try { near = wg.villagesNear(px, pz, DROP) || []; } catch (e) { return false; }
  const cand = [];
  for (const v of near) if (v && v.x != null && v.minX != null) cand.push({ v, key: vKey(v), d: Math.hypot(v.x - px, v.z - pz) });
  cand.sort((a, b) => a.d - b.d);
  const next = new Map();
  for (const c of cand) {
    if (next.size >= MAX) break;
    if (c.d <= RADIUS || (active.has(c.key) && c.d <= DROP)) next.set(c.key, active.get(c.key) || { v: c.v, keys: footprint(c.v) });
  }
  let changed = next.size !== active.size;
  for (const k of next.keys()) if (!active.has(k)) changed = true;
  for (const k of active.keys()) if (!next.has(k)) { pending.delete(k); awayOf.delete(k); }
  const fresh = [...next].filter(([k]) => !active.has(k));
  active.clear();
  for (const [k, e] of next) active.set(k, e);
  for (const [k, e] of fresh) startCatchUp(k, e);
  // stamp villages whose centre is loaded: the last stamp is when the village stopped being simulated
  const d = dayNow();
  for (const [k, e] of active) if (BF.world.isLoaded(e.v.x, e.v.z)) seen.set(k, d);
  catchUpVillagers(now);
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

BF.villageSim = {
  RADIUS, MAX,
  keepKeys,
  update,
  isActive: key => active.has(key),
  // fn(mob, villageRec, awayDays): called once per villager of a village that was out of range for more than 0.1 game day.
  // Apply what the villager would have got done meanwhile (builders, farmers; explorers hook in the same way).
  onCatchUp(fn) { hooks.push(fn); },
  status: () => `${active.size} sim village${active.size === 1 ? "" : "s"}, ${keepKeys.size} kept chunks`,
  exportSeen(out) { for (const [k, d] of seen) out["seen:" + k] = +d.toFixed(3); },
  importSeen(o) { seen.clear(); if (o) for (const k in o) if (k.slice(0, 5) === "seen:") seen.set(k.slice(5), +o[k]); },
  reset() { active.clear(); seen.clear(); pending.clear(); awayOf.clear(); keepKeys.clear(); lastT = 0; },
  init() { BF.world.onChunkLoad(onChunkLoad); },
};
})();
