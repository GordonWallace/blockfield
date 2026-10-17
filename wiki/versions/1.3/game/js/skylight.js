// Sky light: integer 0..15 per voxel that spreads like Minecraft's. Straight down from open sky it stays 15 through clear
// blocks (air, glass, plants); leaves, water and ice take it down to 14; every other step (sideways, up, or down from below 15)
// loses 1; opaque blocks, slabs and stairs stop it. So a cell beside open ground is 14, the spot under a single pillar is 14
// (lit from the side), a room with a doorway grades from 14 at the door to dark at the back, and a deep cave is 0.
// Storage: chunk.sky[sectionIndex - chunk.lo] = a number (the whole section is that value) or Uint8Array(4096), same
// in-section index as the block sections (world.js). Above a chunk's loaded band is open air (15), below it is 0.
// Works across chunk borders through loaded chunks (a chunk that loads later pulls light in from its loaded neighbours and
// pushes its own out). Derived data: never saved, recomputed when a chunk is created.
// The mesher (world.js) turns levels into per-vertex brightness (bright()); js/mobs.js reads levels for monster spawning
// (a cave spot at 7 or less) and burning (12 or more at the head).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const CS = 16;
const sky = (BF.skyLight = {});
const world = () => BF.world;

// ATT[id]: 255 stops sky light; 1 takes straight-down sunlight from 15 to 14; 0 is clear
const ATT = new Uint8Array(BF.MAX_BLOCK + 1);
for (const b of BF.blocks) {
  if (!b) continue;
  if (BF.OPAQUE[b.id] || BF.LIGHTBLOCK[b.id]) ATT[b.id] = 255;
  else if (/_leaves$/.test(b.name) || BF.FLUID[b.id] || b.name === "ice") ATT[b.id] = 1;
}
sky.ATT = ATT;
// level -> brightness 0..1 for the shader's skyl attribute: Minecraft's curve with its default (50%) brightness lift
// (15 is 1, 14 0.91, 12 0.77, 10 0.62, 7 0.44, 3 0.17, 0 0)
const BRIGHT = new Float32Array(16);
for (let l = 0; l < 16; l++) { const f = l / 15, b = f / (3 - 2 * f); BRIGHT[l] = 0.5 * b + 0.5 * (1 - Math.pow(1 - b, 4)); }
sky.BRIGHT = BRIGHT;
sky.bright = l => BRIGHT[l < 0 ? 0 : l > 15 ? 15 : l | 0];

// ---------- queues (typed arrays, grown on demand) ----------
let ax = new Int32Array(1 << 15), ay = new Int32Array(1 << 15), az = new Int32Array(1 << 15);
let rx = new Int32Array(1 << 14), ry = new Int32Array(1 << 14), rz = new Int32Array(1 << 14), rv = new Uint8Array(1 << 14);
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
const idx = (x, y, z) => ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
// level on chunk c (with c.sky) at absolute y: 15 above the band, 0 below
function sget(c, x, y, z) {
  if (y >= c.y1) return 15;
  if (y < c.y0) return 0;
  const s = c.sky[(y >> 4) - c.lo];
  return typeof s === "number" ? s : s[idx(x, y, z)];
}
function sset(c, x, y, z, v) {   // y inside the band
  const si = (y >> 4) - c.lo;
  let s = c.sky[si];
  if (typeof s === "number") {
    if (s === v) return;
    const a = new Uint8Array(4096); if (s) a.fill(s);
    c.sky[si] = s = a;
  }
  s[idx(x, y, z)] = v;
}
function blockAt(c, x, y, z) {
  const s = c.secs[(y >> 4) - c.lo];
  return typeof s === "number" ? s : s[idx(x, y, z)];
}

// ---------- dirty tracking: chunks whose light changed (and neighbours that sample their border cells) ----------
let touched = [], stamp = 1;
function mark(c, x, z) {
  if (c._ss !== stamp) { c._ss = stamp; c._sb = 0; touched.push(c); }
  const lx = x & 15, lz = z & 15;
  if (lx === 0) c._sb |= 1; else if (lx === 15) c._sb |= 2;
  if (lz === 0) c._sb |= 4; else if (lz === 15) c._sb |= 8;
}
function flush() {
  const W = world();
  for (const c of touched) {
    if (c.mesh !== undefined) W._dirty.add(c.key);
    const b = c._sb;
    if (b) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      if (dx === -1 && !(b & 1) || dx === 1 && !(b & 2) || dz === -1 && !(b & 4) || dz === 1 && !(b & 8)) continue;
      const n = W.chunks.get((c.cx + dx) + "," + (c.cz + dz));
      if (n && n.mesh !== undefined) W._dirty.add(n.key);
    }
  }
  touched = []; stamp++;
}

const DX = [1, -1, 0, 0, 0, 0], DY = [0, 0, 1, -1, 0, 0], DZ = [0, 0, 0, 0, 1, -1];
// light reaching a cell with attenuation a from a neighbour at level L (down = the neighbour is right above it)
const step = (L, a, down) => down && L === 15 ? 15 - a : L - 1;

// Breadth-first flood fill from the add queue.
function propagate() {
  while (ah < at) {
    const x = ax[ah], y = ay[ah], z = az[ah]; ah++;
    const c = chunkOf(x, z);
    if (!c || !c.sky) continue;
    const L = sget(c, x, y, z);
    if (L <= 1) continue;
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      const nc = chunkOf(nx, nz);
      if (!nc || !nc.sky || ny < nc.y0 || ny >= nc.y1) continue;   // above a band is open sky already
      const a = ATT[blockAt(nc, nx, ny, nz)];
      if (a === 255) continue;
      const v = step(L, a, d === 3);
      if (v <= sget(nc, nx, ny, nz)) continue;
      sset(nc, nx, ny, nz, v);
      mark(nc, nx, nz);
      pushAdd(nx, ny, nz);
    }
  }
  ah = at = 0;
}

// Minecraft-style removal: zero every cell that was lit through (x,y,z) (value v); brighter cells around become sources for the refill.
function removeFrom(c, x, y, z, v) {
  sset(c, x, y, z, 0); mark(c, x, z);
  pushRem(x, y, z, v);
  while (rh < rt) {
    const px = rx[rh], py = ry[rh], pz = rz[rh], pv = rv[rh]; rh++;
    for (let d = 0; d < 6; d++) {
      const nx = px + DX[d], ny = py + DY[d], nz = pz + DZ[d];
      const nc = chunkOf(nx, nz);
      if (!nc || !nc.sky || ny < nc.y0) continue;
      if (ny >= nc.y1) { pushAdd(nx, ny, nz); continue; }   // open sky above the band
      const n = sget(nc, nx, ny, nz);
      if (!n) continue;
      if (n < pv || (d === 3 && pv === 15 && n >= 14)) {
        sset(nc, nx, ny, nz, 0); mark(nc, nx, nz);
        pushRem(nx, ny, nz, n);
      } else pushAdd(nx, ny, nz);
    }
  }
  rh = rt = 0;
}

// ---------- chunk creation ----------
let colBuf = new Uint8Array(0);
const floorOf = new Int32Array(CS * CS);   // per column: lowest y still at 15 (y1 if the band's top cell is shaded)
// Straight-down pass of chunk c into c.sky; fills floorOf. Returns nothing.
function columnPass(c) {
  const H = c.y1 - c.y0, n = CS * CS * H;
  if (colBuf.length < n) colBuf = new Uint8Array(n);
  else colBuf.fill(0, 0, n);
  for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
    const col = (lz * CS + lx) * H;
    let L = 15, fl = c.y1;
    for (let y = c.y1 - 1; y >= c.y0; y--) {
      const a = ATT[blockAt(c, lx, y, lz)];
      if (a === 255) break;
      L = step(L, a, true);
      if (L <= 0) break;
      colBuf[col + y - c.y0] = L;
      if (L === 15) fl = y;
    }
    floorOf[lz * CS + lx] = fl;
  }
  // into sections, uniform ones as a number
  const ns = c.hi - c.lo;
  c.sky = new Array(ns);
  for (let si = 0; si < ns; si++) {
    const s = new Uint8Array(4096), by = si * 16;
    let first = -1, uni = true;
    for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
      const col = (lz * CS + lx) * H + by;
      for (let ly = 0; ly < 16; ly++) {
        const v = colBuf[col + ly];
        s[(ly << 8) | (lz << 4) | lx] = v;
        if (first < 0) first = v; else if (v !== first) uni = false;
      }
    }
    c.sky[si] = uni ? first : s;
  }
}
// lowest y at 15 in column (x, z) of a chunk with sky data (scans down from the band's top)
function floorAt(c, x, z) {
  let y = c.y1 - 1;
  while (y >= c.y0) {
    const s = c.sky[(y >> 4) - c.lo];
    if (typeof s === "number") { if (s !== 15) break; y = ((y >> 4) << 4) - 1; continue; }
    if (s[idx(x, y, z)] !== 15) break;
    y--;
  }
  return y + 1;
}
// Seeds the fill for chunk c: its 15-cells beside lower neighbouring columns, its cells under leaves and water, and light
// coming in from loaded neighbours across the border.
function seed(c) {
  const ox = c.cx * CS, oz = c.cz * CS, W = world();
  const nbs = [W.chunks.get((c.cx - 1) + "," + c.cz), W.chunks.get((c.cx + 1) + "," + c.cz), W.chunks.get(c.cx + "," + (c.cz - 1)), W.chunks.get(c.cx + "," + (c.cz + 1))];
  for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
    const fl = floorOf[lz * CS + lx], x = ox + lx, z = oz + lz;
    let hi = fl;
    for (let d = 0; d < 4; d++) {
      const nx = lx + DX[d], nz = lz + DZ[d === 2 ? 4 : d === 3 ? 5 : d];
      let nf;
      if (nx >= 0 && nx < CS && nz >= 0 && nz < CS) nf = floorOf[nz * CS + nx];
      else {
        const n = nbs[nx < 0 ? 0 : nx >= CS ? 1 : nz < 0 ? 2 : 3];
        if (!n || !n.sky) continue;
        nf = Math.min(floorAt(n, (nx + CS) & 15, (nz + CS) & 15), n.y1);
        // the neighbour's own 15-cells next to our shaded ones light us
        for (let y = Math.max(nf, c.y0); y < fl && y < n.y1; y++) pushAdd(n.cx * CS + ((nx + CS) & 15), y, n.cz * CS + ((nz + CS) & 15));
      }
      if (nf > hi) hi = nf;
    }
    for (let y = fl; y < hi && y < c.y1; y++) pushAdd(x, y, z);
    // under leaves / water: the fading straight-down light spreads too
    for (let y = fl - 1; y >= c.y0; y--) { const v = sget(c, x, y, z); if (v <= 1) break; pushAdd(x, y, z); }
  }
  // shaded light (below 15) in the neighbours' border cells flows in too
  for (let d = 0; d < 4; d++) {
    const n = nbs[d];
    if (!n || !n.sky) continue;
    const blx = d === 0 ? CS - 1 : d === 1 ? 0 : -1, blz = d === 2 ? CS - 1 : d === 3 ? 0 : -1;
    for (let si = 0; si < n.sky.length; si++) {
      const s = n.sky[si];
      if (typeof s === "number") continue;   // uniform: all 15 (handled above) or all dark
      const by = (n.lo + si) * 16;
      for (let t = 0; t < CS; t++) {
        const lx = blx >= 0 ? blx : t, lz = blz >= 0 ? blz : t;
        for (let ly = 0; ly < 16; ly++) { const v = s[(ly << 8) | (lz << 4) | lx]; if (v > 1 && v < 15) pushAdd(n.cx * CS + lx, by + ly, n.cz * CS + lz); }
      }
    }
  }
}

// ---------- hooks called by world.js ----------
// A chunk was created (blocks and edits in place): compute its sky light and exchange light with loaded neighbours.
sky.onChunkCreated = function (c) {
  reset();
  columnPass(c);
  seed(c);
  propagate();
  flush();
};
// Sections were added below the band: recompute the chunk (light only grows, so neighbours need no removal).
sky.onExtended = function (c) {
  if (!c.sky) return;
  sky.onChunkCreated(c);
};
// The band grew upward: the new sections are open air.
sky.onExtendedUp = function (c, oldHi) {
  if (c.sky) for (let i = oldHi; i < c.hi; i++) c.sky.push(15);
};

// A block changed from oldId to newId at world (x,y,z) (world.setBlock, after the voxel was written).
sky.onSet = function (x, y, z, oldId, newId) {
  const ao = ATT[oldId], an = ATT[newId];
  if (ao === an) return;
  reset();
  const c = chunkOf(x, z);
  if (!c || !c.sky || y < c.y0 || y >= c.y1) return;
  const cur = sget(c, x, y, z);
  if (an > ao && cur > 0) removeFrom(c, x, y, z, cur);
  if (an !== 255) {
    let nl = 0;
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      const nc = chunkOf(nx, nz);
      if (!nc || !nc.sky || ny < nc.y0) continue;
      const v = step(sget(nc, nx, ny, nz), an, d === 2);
      if (v > nl) nl = v;
    }
    if (nl > sget(c, x, y, z)) { sset(c, x, y, z, nl); mark(c, x, z); pushAdd(x, y, z); }
  }
  propagate();
  flush();
};

// Level 0..15 at world coords: 15 in unloaded chunks and above a band, 0 below it.
sky.get = function (x, y, z) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  const c = world().chunks.get((x >> 4) + "," + (z >> 4));
  if (!c || !c.sky) return 15;
  return sget(c, x, y, z);
};

// Throws everything away and recomputes all loaded chunks (tests / debugging); returns ms taken.
sky.recomputeAll = function () {
  const t0 = performance.now(), W = world();
  for (const c of W.chunks.values()) c.sky = undefined;
  for (const c of W.chunks.values()) sky.onChunkCreated(c);
  for (const c of W.chunks.values()) if (c.mesh !== undefined) W._dirty.add(c.key);
  return performance.now() - t0;
};
})();
