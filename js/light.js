// Block light: integer 0..15 per voxel (chunk.light[sectionIndex - chunk.lo] = Uint8Array(4096) or undefined = all dark, same
// in-section index as the block sections, see world.js), flood-filled from
// emitting blocks (block def field `emit` 0..15, table BF.EMIT) and attenuating 1 per step through non-opaque blocks.
// Works across chunk borders (only through loaded chunks; a chunk that loads later pulls light in from its loaded
// neighbours' border cells). Light is derived data: it is never saved and is recomputed whenever a chunk is created.
// Loaded after world.js; world.js calls the hooks below (createChunk -> onChunkCreated, setBlock -> onSet) and the
// mesher reads chunk.light of the 3x3 chunk neighbourhood.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const CS = 16;
const light = (BF.light = {});
const world = () => BF.world;
const OPAQUE = BF.OPAQUE;
let EMIT = BF.EMIT;
if (!EMIT) { EMIT = new Uint8Array(BF.MAX_BLOCK + 1); for (const b of BF.blocks) if (b && b.emit) EMIT[b.id] = Math.min(15, b.emit | 0); BF.EMIT = EMIT; }

// ---------- queues (typed arrays, grown on demand) ----------
let cap = 1 << 14;
let ax = new Int32Array(cap), ay = new Int32Array(cap), az = new Int32Array(cap);       // add queue
let rx = new Int32Array(cap), ry = new Int32Array(cap), rz = new Int32Array(cap), rv = new Uint8Array(cap); // removal queue
let ah = 0, at = 0, rh = 0, rt = 0;
function grow(a, n) { const b = new a.constructor(n); b.set(a); return b; }
function pushAdd(x, y, z) {
  if (at === ax.length) { const n = ax.length * 2; ax = grow(ax, n); ay = grow(ay, n); az = grow(az, n); }
  ax[at] = x; ay[at] = y; az[at] = z; at++;
}
function pushRem(x, y, z, v) {
  if (rt === rx.length) { const n = rx.length * 2; rx = grow(rx, n); ry = grow(ry, n); rz = grow(rz, n); rv = grow(rv, n); }
  rx[rt] = x; ry[rt] = y; rz[rt] = z; rv[rt] = v; rt++;
}

// ---------- chunk lookup with a one-entry cache (reset at every entry point) ----------
let cCx = 1e9, cCz = 1e9, cC = null;
function chunkOf(x, z) {
  const cx = x >> 4, cz = z >> 4;
  if (cx === cCx && cz === cCz) return cC;
  cCx = cx; cCz = cz; cC = world().chunks.get(cx + "," + cz) || null;
  return cC;
}
const reset = () => { cCx = cCz = 1e9; cC = null; ah = at = rh = rt = 0; };
const idx = (x, y, z) => ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);   // index inside a section
// light value / writer on chunk c at absolute y (y must be inside c's loaded band); sections without light arrays read 0
function lget(c, x, y, z) { const s = c.light[(y >> 4) - c.lo]; return s ? s[idx(x, y, z)] : 0; }
function lset(c, x, y, z, v) {
  const si = (y >> 4) - c.lo;
  let s = c.light[si];
  if (!s) s = c.light[si] = new Uint8Array(4096);
  s[idx(x, y, z)] = v;
}
const inBand = (c, y) => y >= c.y0 && y < c.y1;
const blockAt = (c, x, y, z) => world().chunkBlock(c, x & 15, y, z & 15);

// ---------- dirty tracking: chunks whose light changed (and neighbours that sample their border cells) ----------
let touched = [], stamp = 1;
function mark(c, x, z) {
  if (c._ls !== stamp) { c._ls = stamp; c._lb = 0; touched.push(c); }
  const lx = x & 15, lz = z & 15;
  if (lx === 0) c._lb |= 1; else if (lx === 15) c._lb |= 2;
  if (lz === 0) c._lb |= 4; else if (lz === 15) c._lb |= 8;
}
function flush() {
  const W = world();
  for (const c of touched) {
    W._dirty.add(c.key);
    const b = c._lb;
    if (b) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      if (dx === -1 && !(b & 1) || dx === 1 && !(b & 2) || dz === -1 && !(b & 4) || dz === 1 && !(b & 8)) continue;
      const n = W.chunks.get((c.cx + dx) + "," + (c.cz + dz));
      if (n) W._dirty.add(n.key);
    }
  }
  touched = []; stamp++;
}

const DX = [1, -1, 0, 0, 0, 0], DY = [0, 0, 1, -1, 0, 0], DZ = [0, 0, 0, 0, 1, -1];

// Breadth-first flood fill from the add queue: each popped cell lights its non-opaque neighbours to (level - 1).
function propagate() {
  while (ah < at) {
    const x = ax[ah], y = ay[ah], z = az[ah]; ah++;
    const c = chunkOf(x, z);
    const L = lget(c, x, y, z);
    if (L <= 1) continue;
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      const nc = chunkOf(nx, nz);
      if (!nc) continue;
      // above a chunk's loaded band is all air: make room so light can spread there (a tall build next door)
      if (ny >= nc.y1 && ny < BF.H && nc.light) world().ensureRange(nx, nz, ny, ny);
      if (!inBand(nc, ny)) continue;
      if (OPAQUE[blockAt(nc, nx, ny, nz)] || lget(nc, nx, ny, nz) >= L - 1) continue;
      lset(nc, nx, ny, nz, L - 1);
      mark(nc, nx, nz);
      pushAdd(nx, ny, nz);
    }
  }
  ah = at = 0;
}

// Minecraft-style removal: zero every cell that was lit through (x,y,z); cells lit by something else (>= the removed
// value) become sources for the re-fill. Emitters inside the cleared region are restored afterwards.
function removeFrom(x, y, z, v) {
  const c = chunkOf(x, z);
  lset(c, x, y, z, 0); mark(c, x, z);
  pushRem(x, y, z, v);
  const emitters = [];
  while (rh < rt) {
    const px = rx[rh], py = ry[rh], pz = rz[rh], pv = rv[rh]; rh++;
    for (let d = 0; d < 6; d++) {
      const nx = px + DX[d], ny = py + DY[d], nz = pz + DZ[d];
      const nc = chunkOf(nx, nz);
      if (!nc || !inBand(nc, ny)) continue;
      const n = lget(nc, nx, ny, nz);
      if (!n) continue;
      if (n < pv) {
        lset(nc, nx, ny, nz, 0); mark(nc, nx, nz);
        pushRem(nx, ny, nz, n);
        if (EMIT[blockAt(nc, nx, ny, nz)]) emitters.push(nx, ny, nz);
      } else pushAdd(nx, ny, nz);
    }
  }
  rh = rt = 0;
  for (let i = 0; i < emitters.length; i += 3) {
    const ex = emitters[i], ey = emitters[i + 1], ez = emitters[i + 2], ec = chunkOf(ex, ez);
    lset(ec, ex, ey, ez, EMIT[blockAt(ec, ex, ey, ez)]);
    pushAdd(ex, ey, ez);
  }
}

// ---------- hooks called by world.js ----------
// A chunk was generated (vox filled, edits applied, maxY set): light its emitters and pull light in across its borders.
light.onChunkCreated = function (c) {
  reset();
  const W = world();
  c.light = new Array(c.hi - c.lo);
  seedEmitters(c);
  // light already present in loaded neighbours flows into this chunk through the shared border
  for (let d = 0; d < 4; d++) {
    const dx = d === 0 ? -1 : d === 1 ? 1 : 0, dz = d === 2 ? -1 : d === 3 ? 1 : 0;
    const n = W.chunks.get((c.cx + dx) + "," + (c.cz + dz));
    if (!n || !n.light) continue;
    for (let si = 0; si < n.light.length; si++) {
      const ls = n.light[si];
      if (!ls) continue;
      for (let t = 0; t < CS; t++) {
        const lx = dx === -1 ? CS - 1 : dx === 1 ? 0 : t, lz = dz === -1 ? CS - 1 : dz === 1 ? 0 : t;
        for (let ly = 0; ly < 16; ly++) if (ls[(ly << 8) | (lz << 4) | lx] > 1) pushAdd(n.cx * CS + lx, (n.lo + si) * 16 + ly, n.cz * CS + lz);
      }
    }
  }
  if (at > 0) { propagate(); flush(); }
  touched.length = 0;
};
// lights every emitter of chunk c (its sections) and queues it for the flood fill
function seedEmitters(c) {
  const ox = c.cx * CS, oz = c.cz * CS;
  for (let si = 0; si < c.secs.length; si++) {
    const s = c.secs[si], by = (c.lo + si) * 16;
    if (typeof s === "number") {
      if (!EMIT[s]) continue;
      for (let i = 0; i < 4096; i++) { lset(c, i & 15, by + (i >> 8), (i >> 4) & 15, EMIT[s]); pushAdd(ox + (i & 15), by + (i >> 8), oz + ((i >> 4) & 15)); }
      continue;
    }
    let ls = null;
    for (let i = 0; i < 4096; i++) {
      const e = EMIT[s[i]];
      if (!e) continue;
      if (!ls) ls = c.light[si] = c.light[si] || new Uint8Array(4096);
      ls[i] = e;
      pushAdd(ox + (i & 15), by + (i >> 8), oz + ((i >> 4) & 15));
    }
  }
}
// Sections were added below a chunk's band (oldY0 = its previous bottom): light the new emitters and pull light in from around.
light.onExtended = function (c, oldY0) {
  reset();
  const ox = c.cx * CS, oz = c.cz * CS;
  for (let si = 0; si < (oldY0 >> 4) - c.lo; si++) {
    const s = c.secs[si], by = (c.lo + si) * 16;
    if (typeof s === "number" && !EMIT[s]) continue;
    for (let i = 0; i < 4096; i++) {
      const v = typeof s === "number" ? s : s[i], e = EMIT[v];
      if (!e) continue;
      lset(c, i & 15, by + (i >> 8), (i >> 4) & 15, e);
      pushAdd(ox + (i & 15), by + (i >> 8), oz + ((i >> 4) & 15));
    }
  }
  if (at > 0) { propagate(); flush(); }
  touched.length = 0;
};

// A block changed from oldId to newId at world (x,y,z) (world.setBlock, after the voxel was written).
light.onSet = function (x, y, z, oldId, newId) {
  const eo = EMIT[oldId], en = EMIT[newId], oo = OPAQUE[oldId], on = OPAQUE[newId];
  if (!eo && !en && oo === on) return;                 // water/air/plant swaps: nothing to do
  reset();
  const c = chunkOf(x, z);
  if (!c || !c.light) return;
  if (!inBand(c, y)) return;
  const lv = lget(c, x, y, z);
  if (lv > 0 && (eo || on)) removeFrom(x, y, z, lv);  // was an emitter or is now opaque: clear what depended on it
  let nl = en;
  if (!on) {                                           // otherwise light may flow in from the neighbours
    let m = 0;
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      const nc = chunkOf(nx, nz);
      if (nc && nc.light && inBand(nc, ny)) { const v = lget(nc, nx, ny, nz); if (v > m) m = v; }
    }
    if (m - 1 > nl) nl = m - 1;
  }
  if (nl > lget(c, x, y, z)) { lset(c, x, y, z, nl); mark(c, x, z); pushAdd(x, y, z); }
  propagate();
  flush();
};

// Light level 0..15 at integer world coords (0 in unloaded chunks / out of range).
light.get = function (x, y, z) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  const c = world().chunks.get((x >> 4) + "," + (z >> 4));
  if (!c || !c.light || y < c.y0 || y >= c.y1) return 0;
  const s = c.light[(y >> 4) - c.lo];
  return s ? s[idx(x, y, z)] : 0;
};

// Throws everything away and recomputes all loaded chunks from scratch (tests / debugging); returns ms taken.
light.recomputeAll = function () {
  const t0 = performance.now(), W = world();
  reset();
  for (const c of W.chunks.values()) { c.light = new Array(c.hi - c.lo); seedEmitters(c); }
  propagate();
  for (const c of W.chunks.values()) if (c.mesh !== undefined) W._dirty.add(c.key);
  touched.length = 0;
  return performance.now() - t0;
};

// ---------- torches ----------
// A torch needs a full solid block (cube or cutout like glass/leaves) to stand on / lean against.
const canSupport = id => !!BF.SOLID[id] && (BF.RENDER[id] === 1 || BF.RENDER[id] === 2);
light.canSupport = canSupport;
const isTorch = id => { const b = BF.blocks[id]; return !!b && (id === BF.B.torch || !!b.wallTorch); };
light.isTorchItem = id => id === BF.B.torch;
// Block id to place when the torch item is used on a face with `normal` into cell (x,y,z), or 0 if it cannot go there.
light.torchPlace = function (x, y, z, normal) {
  const W = world();
  if (normal[1] === 1 || (!normal[0] && !normal[2] && normal[1] !== -1)) return canSupport(W.getBlock(x, y - 1, z)) ? BF.B.torch : 0;
  if (normal[1] === -1) return 0;
  const f = BF.dirIndex(normal[0], normal[2]);      // facing = outward direction = the clicked face normal
  if (!canSupport(W.getBlock(x - normal[0], y, z - normal[2]))) return canSupport(W.getBlock(x, y - 1, z)) ? BF.B.torch : 0;
  return BF.B["wall_torch_" + ["north", "east", "south", "west"][f]] || 0;
};
// After (x,y,z) became `newId`: torches that lost their support pop off (one drop, none in creative).
light.popUnsupported = function (x, y, z, newId) {
  if (canSupport(newId)) return;
  const W = world(), creative = !!(BF.inventory && BF.inventory.isCreative && BF.inventory.isCreative());
  const check = (tx, ty, tz, wantF) => {
    const id = W.getBlock(tx, ty, tz), b = BF.blocks[id];
    if (!b || !isTorch(id)) return;
    if (wantF === -1 ? id !== BF.B.torch : !(b.wallTorch && b.wallTorch.f === wantF)) return;
    W.setBlock(tx, ty, tz, 0);
    if (BF.drops && !creative) BF.drops.spawnAt(BF.rollDrops(id), tx, ty, tz);
  };
  check(x, y + 1, z, -1);
  for (let f = 0; f < 4; f++) check(x + BF.DIRS[f][0], y, z + BF.DIRS[f][1], f);   // torch facing f leans on the block at -DIRS[f]
};
})();
