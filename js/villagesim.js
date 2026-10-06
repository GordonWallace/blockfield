// Far-village simulation. Villagers only exist while their chunks are loaded, so this keeps the terrain data
// (no meshes) of the nearest few villages loaded out to RADIUS blocks, letting their villagers run their
// normal AI while the player is beyond view distance. Also catches up crops when a village is revisited.
// API: BF.villageSim = { RADIUS, MAX, keepKeys, update(px, pz) -> changed, isActive(key), status(),
//                        exportSeen(out), importSeen(o), reset() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const RADIUS = 200;       // a village this close to the player is simulated
const DROP = 216;         // ...and keeps being simulated until it is this far (hysteresis)
const MAX = 4;            // nearest N villages at a time
const MARGIN = 16;        // blocks of terrain kept beyond the village bounds (farms, paths)
const MAX_SPAN = 12;      // chunks per axis, cap for oversized footprints
const CROP_SECS_PER_DAY = 1200, GROW_RATE = 1 / 240;   // matches sky.dayLength and world.js GROW_CHANCE_PER_S

const active = new Map();        // village key -> { v, keys: [chunk keys] }
const seen = new Map();          // village key -> game day it was last simulated
const pending = new Map();       // village key -> { away, todo: Set(chunk keys) } crops still to catch up
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

BF.villageSim = {
  RADIUS, MAX,
  keepKeys,
  update,
  isActive: key => active.has(key),
  status: () => `${active.size} sim village${active.size === 1 ? "" : "s"}, ${keepKeys.size} kept chunks`,
  exportSeen(out) { for (const [k, d] of seen) out["seen:" + k] = +d.toFixed(3); },
  importSeen(o) { seen.clear(); if (o) for (const k in o) if (k.slice(0, 5) === "seen:") seen.set(k.slice(5), +o[k]); },
  reset() { active.clear(); seen.clear(); pending.clear(); keepKeys.clear(); lastT = 0; },
  init() { BF.world.onChunkLoad(onChunkLoad); },
};
})();
