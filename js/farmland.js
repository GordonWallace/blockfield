// Farmland hydration (Minecraft-style). `farmland` is hydrated farmland, `farmland_dry` is dehydrated farmland.
// - Farmland is hydrated by water (any water block, source or flowing) within 3 blocks horizontally, at its own level or one
//   above, or by rain falling on it (rain only, not snow; open sky above the crop).
// - Hydrated farmland that has had neither for a day may dry out: the chance rises evenly from day 1 and is certain by day 3.
// - Dehydrated farmland becomes hydrated again as soon as water or rain reaches it.
// - Dehydrated farmland with no crop on it may revert to dirt: the chance rises evenly from 1 day after it dried out and is
//   certain after 14 days. A crop on it keeps it farmland (it can still revert once the crop is harvested).
// - Crops grow at a third of the speed on dehydrated farmland (js/world.js growTick, js/villagesim.js catch-up). Seeds can be
//   planted on either kind (js/player.js, js/villagelife.js), never on dirt.
// Each tracked block keeps one time stamp in game days: when it was last wet (hydrated farmland) or when it dried out
// (dehydrated farmland). The moment a block dries / reverts is fixed by a hash of its position and stamp (an even draw over the
// window), so the outcome does not depend on how often blocks are looked at, and a chunk that was unloaded catches up on load
// (rain while it was away counts, from the last time it rained anywhere). Stamps are saved with the world.
// API: BF.farmland = { isFarmland(id), isDry(id), tillId(x, y, z), hydrated(x, y, z), growFactor(id), tick(), onSet(x, y, z, old, id),
//                      check(x, y, z), checkAll(), stampOf(x, y, z), setStamp(x, y, z, day), serialize(), deserialize(a), stats() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const WET_R = 3;                 // water within 3 blocks (horizontally) hydrates
const DRY_FROM = 1, DRY_BY = 3;  // days without water or rain: drying may start / is certain
const DIRT_FROM = 1, DIRT_BY = 14;   // days dehydrated with no crop: reverting to dirt may start / is certain
const DRY_GROWTH = 1 / 3;        // crop growth speed on dehydrated farmland
const EVAL_EVERY = 20;           // sim seconds between looks at the same block
const MAX_PER_TICK = 2000;       // blocks looked at per sim step at most

const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const pk = (x, y, z) => x + "," + y + "," + z;
let WET = null, DRY = null;
const ids = () => { if (WET == null) { WET = BF.B.farmland; DRY = BF.B.farmland_dry; } };
const isFarmland = id => (ids(), id === WET || (id === DRY && DRY != null));
const isDry = id => (ids(), id === DRY && DRY != null);

const stamps = new Map();   // "x,y,z" -> game day (all farmland ever seen, loaded or not)
const tracked = new Map();  // "x,y,z" -> [x, y, z], farmland in loaded chunks
const due = new Set();      // keys to look at first (just loaded or placed)
let order = [], pos = 0, orderDirty = true, last = 0, carry = 0, lastRain = -1e9, hooked = false;

// even draw in [0, 1) from the block and its stamp
function u01(x, y, z, t, salt) {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791) ^ Math.imul(Math.round(t * 1e4) | 0, 2654435761) ^ Math.imul(salt, 40503)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const dryAfter = (x, y, z, t) => DRY_FROM + (DRY_BY - DRY_FROM) * u01(x, y, z, t, 1);
const dirtAfter = (x, y, z, t) => DIRT_FROM + (DIRT_BY - DIRT_FROM) * u01(x, y, z, t, 2);

// Water within reach: true, false, or null when part of the reach is not loaded (and no water was found in the loaded part).
function waterNear(x, y, z) {
  const W = BF.world;
  let unknown = false;
  for (let r = 0; r <= WET_R; r++) {          // nearest rings first: a watered field stops after a few looks
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      if (!W.isLoaded(x + dx, z + dz)) { unknown = true; continue; }
      for (let dy = 0; dy <= 1; dy++) {
        const id = W.getBlock(x + dx, y + dy, z + dz);
        if (BF.FLUID[id]) return true;   // water only (BF.FLUID marks water source / flowing levels)
      }
    }
  }
  return unknown ? null : false;
}
// Rain (not snow) reaches the block: a rainy biome at this height and nothing light-blocking above (crops don't count).
function rainExposed(x, y, z) {
  const Wt = BF.weather;
  if (!Wt || !Wt.precipAt || Wt.precipAt(x, z, y + 1) !== 1) return false;
  const c = BF.world.chunkAt(x, z);
  if (!c || !c.top) return false;
  return c.top[(z - c.cz * BF.CS) * BF.CS + (x - c.cx * BF.CS)] <= y;
}
const rainingNow = () => !!(BF.weather && BF.weather.raining);
function hydrated(x, y, z) {
  const w = waterNear(x, y, z);
  if (w) return true;
  if (rainingNow() && rainExposed(x, y, z)) return true;
  return w;   // false or null
}
// The block a hoe (or a farmer) makes at (x, y, z): hydrated farmland when water or rain reaches it, else dehydrated.
function tillId(x, y, z) { ids(); return DRY != null && hydrated(x, y, z) !== true ? DRY : WET; }

function track(x, y, z) {
  const k = pk(x, y, z);
  if (!tracked.has(k)) { tracked.set(k, [x, y, z]); orderDirty = true; }
  due.add(k);
}
function untrack(k) { if (tracked.delete(k)) orderDirty = true; due.delete(k); }

// Looks at one block now and applies any change it is due.
function check(x, y, z) {
  const W = BF.world, k = pk(x, y, z);
  if (!W.isLoaded(x, z)) return;
  const id = W.getBlock(x, y, z);
  if (!isFarmland(id)) { untrack(k); stamps.delete(k); return; }
  const now = dayNow(), h = hydrated(x, y, z);
  if (h === true) {
    stamps.set(k, now);
    if (isDry(id)) { W.setBlock(x, y, z, WET); stamps.set(k, now); }
    return;
  }
  let t = stamps.get(k);
  if (t == null) { stamps.set(k, now); return; }   // first sight (generated farms, old saves): the clock starts now
  if (h === null) return;                           // a neighbouring chunk is not loaded: wait for it
  if (!isDry(id)) {
    if (lastRain > t && lastRain <= now && rainExposed(x, y, z)) { t = lastRain; stamps.set(k, t); }   // it rained since (perhaps while unloaded)
    const after = dryAfter(x, y, z, t);
    if (now - t >= after && DRY != null) { W.setBlock(x, y, z, DRY); stamps.set(k, t + after); }
    return;
  }
  // dehydrated: reverts to dirt in time while nothing grows on it
  const above = W.getBlock(x, y + 1, z);
  if (above !== 0 && BF.RENDER[above] === 4) return;   // a crop (or any plant) keeps it
  if (now - t >= dirtAfter(x, y, z, t)) { untrack(k); stamps.delete(k); W.setBlock(x, y, z, BF.B.dirt); }
}

function tick() {
  hook();
  const now = BF.simNow ? BF.simNow() : performance.now() / 1000;
  const dt = Math.max(0, Math.min(5, now - last));
  last = now;
  if (rainingNow()) lastRain = dayNow();
  let n = 0;
  for (const k of due) {
    if (n >= MAX_PER_TICK) break;
    due.delete(k);
    const p = tracked.get(k);
    if (p) { check(p[0], p[1], p[2]); n++; }
  }
  if (!tracked.size) return;
  if (orderDirty) { order = [...tracked.keys()]; pos = Math.min(pos, order.length); orderDirty = false; }
  carry += order.length * dt / EVAL_EVERY;
  let m = Math.min(Math.floor(carry), MAX_PER_TICK - n, order.length);
  carry = Math.min(carry - Math.max(0, m), order.length);
  while (m-- > 0) {
    if (pos >= order.length) pos = 0;
    const p = tracked.get(order[pos++]);
    if (p) check(p[0], p[1], p[2]);
    if (orderDirty) { order = [...tracked.keys()]; pos = Math.min(pos, order.length); orderDirty = false; }
  }
}

// Called by world.setBlock for every change.
function onSet(x, y, z, old, id) {
  const was = isFarmland(old), is = isFarmland(id);
  if (!was && !is) return;
  const k = pk(x, y, z);
  if (!is) { untrack(k); stamps.delete(k); return; }
  if (!was) stamps.set(k, dayNow());   // fresh farmland: wet now (or, dehydrated, dry from now)
  track(x, y, z);
}

let SCANF = null;
function scanChunk(cx, cz, c) {
  ids();
  if (!SCANF) { SCANF = new Uint8Array(BF.MAX_BLOCK + 1); SCANF[WET] = 1; if (DRY != null) SCANF[DRY] = 1; }
  const CS = BF.CS;
  BF.world.scanFlagged(c, SCANF, (lx, y, lz) => track(cx * CS + lx, y, cz * CS + lz));
}
function hook() {
  if (hooked || !BF.world || !BF.world.onChunkLoad) return;
  hooked = true;
  BF.world.onChunkLoad(scanChunk);
  BF.world.onChunkUnload((cx, cz) => {
    const CS = BF.CS;
    for (const [k, p] of tracked) if (Math.floor(p[0] / CS) === cx && Math.floor(p[2] / CS) === cz) untrack(k);
  });
  for (const c of BF.world.chunks.values()) scanChunk(c.cx, c.cz, c);
}
function reset() { stamps.clear(); tracked.clear(); due.clear(); order = []; pos = 0; carry = 0; orderDirty = true; lastRain = -1e9; }

const farmland = {
  isFarmland, isDry, tillId, hydrated, tick, onSet, check, reset,   // reset: called by world.reset (new world / load)
  growFactor: id => (isDry(id) ? DRY_GROWTH : 1),
  checkAll() { hook(); for (const p of [...tracked.values()]) check(p[0], p[1], p[2]); },
  stampOf: (x, y, z) => stamps.get(pk(x, y, z)),
  setStamp(x, y, z, day) { stamps.set(pk(x, y, z), day); },
  get lastRain() { return lastRain; },
  set lastRain(d) { lastRain = d; },
  stats() {
    let wet = 0, dry = 0;
    for (const p of tracked.values()) { const id = BF.world.getBlock(p[0], p[1], p[2]); if (isDry(id)) dry++; else if (isFarmland(id)) wet++; }
    return { wet, dry, tracked: tracked.size, stamps: stamps.size };
  },
  // [lastRain, x, y, z, day, x, y, z, day, ...]
  serialize() {
    const a = [+lastRain.toFixed(4)];
    for (const [k, t] of stamps) { const [x, y, z] = k.split(",").map(Number); a.push(x, y, z, +t.toFixed(4)); }
    return a;
  },
  deserialize(a) {
    stamps.clear();
    if (!Array.isArray(a) || !a.length) { lastRain = -1e9; return; }   // old saves: every farmland block's clock starts when it is first seen
    lastRain = +a[0];
    for (let i = 1; i + 3 < a.length; i += 4) stamps.set(pk(a[i], a[i + 1], a[i + 2]), +a[i + 3]);
    for (const k of tracked.keys()) due.add(k);
  },
  DRY_GROWTH, WET_R, DRY_FROM, DRY_BY, DIRT_FROM, DIRT_BY,
};
BF.farmland = farmland;
{
  const world = BF.world;
  if (world && world.tickSim) { const prev = world.tickSim; world.tickSim = () => { prev(); tick(); }; }
  hook();
}
})();
