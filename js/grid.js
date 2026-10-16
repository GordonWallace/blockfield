// Terrain surfaces sampled on regular grids of a planet face, for distant terrain (js/lod.js, spec r14-05). Brought over from the
// round-planet prototype (GordonWallace/blockfield-round js/grid.js).
//
// BF.gridJob does the sampling and runs the same way in the page and in js/lodworker.js. Each sample is one column of generator 4,
// read through BF.worldgen.surfaceAt (one climate pass): its drawn height, its colour (the average colour of its top block's Faithful
// texture, tinted by the biome like the blocks, water darker with depth) and its canopy (the average colour of the area's tree crowns and
// the share of ground they cover). The colours of the textures come from the page (BF.gridJob.palette, made by lod.js from the texture
// atlas), since a worker can't draw the atlas.
//
// BF.sampler hands jobs to a few background workers, lowest priority number first, so the page keeps its frame rate while distant
// terrain is sampled. If workers can't start (the page opened from a file), it runs the jobs in the page instead, a few rows per frame.
(() => {
"use strict";
const G = typeof window !== "undefined" ? window : self;   // self: in a Web Worker
const BF = (G.BF = G.BF || {});

// Biome ids (js/worldgen.js)
const OCEAN = 0, BEACH = 1, SNOWY_BEACH = 2, STONY_SHORE = 3, RIVER = 4, PLAINS = 5, FOREST = 6, FLOWER_FOREST = 7, BIRCH = 8,
  DARK_FOREST = 9, SWAMP = 10, MANGROVE = 11, DESERT = 12, BADLANDS = 13, SAVANNA = 14, SPARSE_JUNGLE = 15, JUNGLE = 16, TAIGA = 17,
  OLD_TAIGA = 18, SNOWY_PLAINS = 19, ICE_SPIKES = 20, SNOWY_TAIGA = 21, MEADOW = 22, CHERRY = 23, MOUNTAINS = 24, SNOWY_SLOPES = 25,
  PEAKS = 26, STONY_PEAKS = 27, MUSHROOM = 28;

// The top block of a column, as worldgen.js generate() picks it, without the slope rules (a distant sample stands for a whole cell of
// columns; steep mountainsides are drawn as rock all over).
function topOf(c, B, SEA) {
  const b = c.biome, h = c.h, wl = c.wl;
  if (h < wl) {
    if (b === BADLANDS) return B.red_sand;
    if (b === SWAMP) return B.dirt;
    if (b === MANGROVE) return B.mud;
    if (b === RIVER) return B.sand;
    return wl - h > 5 ? (c.tb >= 3 ? B.sand : B.gravel) : B.sand;
  }
  switch (b) {
    case DESERT: case BEACH: case RIVER: return B.sand;
    case BADLANDS: return B.red_sand;
    case SNOWY_BEACH: return h >= SEA + 1 ? B.snow_grass : B.sand;
    case STONY_SHORE: return B.stone;
    case SNOWY_PLAINS: case SNOWY_TAIGA: case SNOWY_SLOPES: return h >= 1450 ? B.snow : B.snow_grass;
    case ICE_SPIKES: return B.snow;
    case MUSHROOM: return B.mycelium;
    case MANGROVE: return B.mud;
    case OLD_TAIGA: return B.podzol;
    case MOUNTAINS: return h >= 1950 ? B.snow : B.stone;
    case PEAKS: return h >= 1800 ? B.snow : B.stone;
    case STONY_PEAKS: return B.stone;
  }
  if (h <= SEA + 1 && b !== SWAMP) return c.tb === 0 ? B.snow_grass : B.sand;
  return B.grass;
}

// Tree crowns by biome, for the canopy: [leaf block, share] pairs as generate() mixes its trees, and the area of one crown seen from
// above (blocks). Trees per 4 x 4 cell come from worldgen's TREE_DENSITY. A biome not listed has no trees.
const CROWNS = [];
(function () {
  const c = (b, area, ...leaves) => { CROWNS[b] = { area, leaves }; };
  c(PLAINS, 21, ["oak_leaves", 1]);
  c(FOREST, 21, ["oak_leaves", 0.7], ["birch_leaves", 0.3]);
  c(FLOWER_FOREST, 21, ["oak_leaves", 0.7], ["birch_leaves", 0.3]);
  c(BIRCH, 21, ["birch_leaves", 0.85], ["oak_leaves", 0.15]);
  c(MEADOW, 21, ["birch_leaves", 1]);
  c(SWAMP, 25, ["oak_leaves", 1]);
  c(DARK_FOREST, 40, ["dark_oak_leaves", 0.8], ["oak_leaves", 0.13], ["red_mushroom_block", 0.035], ["brown_mushroom_block", 0.035]);
  c(MANGROVE, 25, ["mangrove_leaves", 1]);
  c(SAVANNA, 30, ["acacia_leaves", 1]);
  c(SPARSE_JUNGLE, 22, ["jungle_leaves", 0.75], ["oak_leaves", 0.25]);
  c(JUNGLE, 36, ["jungle_leaves", 1]);
  c(TAIGA, 13, ["spruce_leaves", 1]);
  c(SNOWY_TAIGA, 13, ["spruce_leaves", 1]);
  c(SNOWY_PLAINS, 13, ["spruce_leaves", 1]);
  c(MOUNTAINS, 13, ["spruce_leaves", 1]);
  c(OLD_TAIGA, 22, ["spruce_leaves", 1]);
  c(CHERRY, 35, ["cherry_leaves", 1]);
  c(MUSHROOM, 25, ["red_mushroom_block", 0.5], ["brown_mushroom_block", 0.5]);
})();
const SHADOW = 0.8;   // a crown seen from afar is darker than its leaf texture: the gaps between leaves show shade

// The palette (made in the page by lod.js, sent to the workers): per block id, the average colour of its top texture (r, g, b in 0-1,
// alpha-weighted) and its biome tint (0 none, 1 grass, 2 foliage, 3 water, as world.js tints the top face).
let PAL = null;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// multiplies out[o..o+2] by tint kind k (1 grass, 2 foliage, 3 water) of the 9 tints t (grass, foliage, water rgb)
const tint = (out, o, k, t) => { if (k >= 1 && k <= 3) { const a = 3 * (k - 1); out[o] *= t[a]; out[o + 1] *= t[a + 1]; out[o + 2] *= t[a + 2]; } };
const tmp = new Float32Array(4), TB = new Float32Array(9);

// A job samples nx x ny points of face f's grid, starting at (u0, v0) and `cell` blocks apart. Points past one face edge are wrapped onto
// the next face; points in a cube corner's empty wedge are skipped (ok 0).
BF.gridJob = {
  palette(p) { PAL = p; },
  alloc(job) {
    const n = job.nx * job.ny;
    return { id: job.id, y: new Float32Array(n), col: new Uint8Array(3 * n), can: new Uint8Array(4 * n), ok: new Uint8Array(n), dir: new Float32Array(3 * n) };
  },
  rows(job, out, j0, j1) {
    const P = BF.planet, N = P.N, WG = BF.worldgen, B = BF.B, SEA = BF.SEA, w = {}, d = [0, 0, 0];
    const TD = WG.TREE_DENSITY;
    for (let j = j0; j < j1; j++) for (let i = 0; i < job.nx; i++) {
      const u = job.u0 + i * job.cell, v = job.v0 + j * job.cell, o = j * job.nx + i;
      if ((u < 0 || u >= N) && (v < 0 || v >= N)) continue;
      P.wrap(job.f, u, v, w);
      const g = w.f, gu = Math.min(N - 1, Math.max(0, Math.floor(w.u))), gv = Math.min(N - 1, Math.max(0, Math.floor(w.v)));
      const x = P.W * g + N + gu, z = N + gv;
      const c = WG.surfaceAt(x, z, TB), h = c.h, wl = c.wl, b = c.biome, wet = wl > h;
      const top = topOf(c, B, SEA);
      // the drawn height: the water surface, or the top of the ground (as the blocks are drawn)
      out.y[o] = wet ? wl + 0.875 : h + 1;
      // colour: the top block's texture, tinted like the blocks; the sea and lakes darker with depth, over a sandy floor near the shore
      const ice = wet && c.tb === 0 && (wl - h < 4 || ((gu * 7 + gv * 13) & 3) !== 0);
      const t = TB;
      let r, gg, bb;
      if (wet && !ice) {
        const W = PAL.top[B.water], depth = wl - h;
        tmp[0] = W[0]; tmp[1] = W[1]; tmp[2] = W[2]; tint(tmp, 0, 3, t);
        const k = 1 - 0.55 * smooth(2, 60, depth), F = PAL.top[top], s = 0.45 * (1 - smooth(1, 6, depth));
        r = (tmp[0] * k) * (1 - s) + F[0] * s; gg = (tmp[1] * k) * (1 - s) + F[1] * s; bb = (tmp[2] * k) * (1 - s) + F[2] * s;
      } else {
        const T = PAL.top[ice ? B.ice : top];
        tmp[0] = T[0]; tmp[1] = T[1]; tmp[2] = T[2];
        if (!ice) tint(tmp, 0, PAL.tint[top], t);
        r = tmp[0]; gg = tmp[1]; bb = tmp[2];
      }
      out.col[3 * o] = Math.min(255, r * 255); out.col[3 * o + 1] = Math.min(255, gg * 255); out.col[3 * o + 2] = Math.min(255, bb * 255);
      // canopy: where generate() grows trees (grassy ground above the shore; mangroves stand in shallow water)
      const cr = CROWNS[b], dens = TD && TD[b] ? TD[b] * 0.92 : 0;
      let cover = 0;
      if (cr && dens > 0 && (b === MANGROVE ? h >= SEA - 3 : !wet && h > SEA + 1 && (top === B.grass || top === B.snow_grass || top === B.podzol || top === B.mycelium) &&
          !(b === MOUNTAINS && h > 1800))) {
        cover = 1 - Math.exp(-dens * cr.area / 16);
        let cr0 = 0, cg = 0, cb = 0;
        for (const [name, share] of cr.leaves) {
          const id = B[name], L = PAL.top[id];
          tmp[0] = L[0]; tmp[1] = L[1]; tmp[2] = L[2]; tint(tmp, 0, PAL.tint[id], t);
          cr0 += tmp[0] * share; cg += tmp[1] * share; cb += tmp[2] * share;
        }
        out.can[4 * o] = Math.min(255, cr0 * SHADOW * 255); out.can[4 * o + 1] = Math.min(255, cg * SHADOW * 255); out.can[4 * o + 2] = Math.min(255, cb * SHADOW * 255);
      }
      out.can[4 * o + 3] = Math.round(cover * 255);
      out.ok[o] = 1;
      P.dir(g, gu + 0.5, gv + 0.5, d);
      out.dir[3 * o] = d[0]; out.dir[3 * o + 1] = d[1]; out.dir[3 * o + 2] = d[2];
    }
  },
  buffers(out) { return [out.y.buffer, out.col.buffer, out.can.buffer, out.ok.buffer, out.dir.buffer]; },
  mesh, meshBuffers: (m) => [m.pos, m.sph, m.col, m.mpos, m.msph, m.mcol, m.can, m.idx].filter(Boolean).map((a) => a.buffer),
  topOf, CROWNS,
};

// ---- a ring's mesh from its samples (js/lod.js; in a worker when there are workers, so the page doesn't stall) ----
// Slope shading of sample (i, j) of an n x n grid, measured s samples either side, in true 3D so it agrees across faces: light from
// above, a little from the east and the south. Flat ground comes out at 1, like the top of a block.
const pa = [0, 0, 0], pb = [0, 0, 0];
function point(raw, o, out) { const r = BF.planet.R + raw.y[o] - BF.SEA; out[0] = raw.dir[3 * o] * r; out[1] = raw.dir[3 * o + 1] * r; out[2] = raw.dir[3 * o + 2] * r; return out; }
function shade(raw, n, i, j, s) {
  const o = j * n + i;
  const at = (ii, jj) => { ii = Math.min(n - 1, Math.max(0, ii)); jj = Math.min(n - 1, Math.max(0, jj)); const q = jj * n + ii; return raw.ok[q] ? q : o; };
  point(raw, at(i + s, j), pa); point(raw, at(i - s, j), pb);
  const ax = pa[0] - pb[0], ay = pa[1] - pb[1], az = pa[2] - pb[2];
  point(raw, at(i, j + s), pa); point(raw, at(i, j - s), pb);
  const bx = pa[0] - pb[0], by = pa[1] - pb[1], bz = pa[2] - pb[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const ux = raw.dir[3 * o], uy = raw.dir[3 * o + 1], uz = raw.dir[3 * o + 2];
  if (nx * ux + ny * uy + nz * uz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const nl = Math.hypot(nx, ny, nz);
  if (!nl) return 1;
  // east (around the pole axis, y) and north at this point
  let ex = uz, ez = -ux;
  const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
  const tx = uy * ez, ty = uz * ex - ux * ez, tz = -uy * ex;
  const lx = 0.8 * ux + 0.45 * ex - 0.4 * tx, ly = 0.8 * uy - 0.4 * ty, lz = 0.8 * uz + 0.45 * ez - 0.4 * tz;
  const k = (0.6 + 0.4 * Math.max(0, (nx * lx + ny * ly + nz * lz) / (nl * Math.hypot(lx, ly, lz)))) / FLAT;
  return Math.min(1.08, k);
}
const FLAT = 0.6 + 0.4 * 0.8 / Math.hypot(0.8, 0.45, 0.4);
// p: { n (samples across), c (cell), gu0, gv0 (the first sample's grid point), cu, cv (the ring's centre), anchor (its centre on the sphere,
// at sea level) }. Positions are flat ones relative to the centre in the ring's face grid (x = u, y = layer, z = v) and round ones relative
// to the anchor. Morph targets (m*): where the next coarser ring (every other sample) puts each vertex. idx is null when every sample is
// there (the ring uses the shared index of a full grid).
function mesh(p, raw) {
  const n = p.n, c = p.c, NV = n * n, A = p.anchor, R = BF.planet.R, SEA = BF.SEA;
  const pos = new Float32Array(NV * 3), sph = new Float32Array(NV * 3), col = new Uint8Array(NV * 3), can = new Uint8Array(NV * 4);
  const mpos = new Float32Array(NV * 3), msph = new Float32Array(NV * 3), mcol = new Uint8Array(NV * 3);
  const C = (v) => Math.min(255, Math.round(v));
  let full = true;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = j * n + i;
    if (!raw.ok[o]) { full = false; continue; }
    const r = R + raw.y[o] - SEA;
    pos[o * 3] = p.gu0 + i * c - p.cu; pos[o * 3 + 1] = raw.y[o]; pos[o * 3 + 2] = p.gv0 + j * c - p.cv;
    for (let k = 0; k < 3; k++) sph[o * 3 + k] = raw.dir[o * 3 + k] * r - A[k];
    const sh = shade(raw, n, i, j, 1);
    for (let k = 0; k < 3; k++) col[o * 3 + k] = C(raw.col[o * 3 + k] * sh);
    for (let k = 0; k < 3; k++) can[o * 4 + k] = C(raw.can[o * 4 + k] * sh);
    can[o * 4 + 3] = raw.can[o * 4 + 3];
  }
  // a point on the coarser grid (even i and j) stays put and takes the coarser ring's shading; any other point goes to the middle of the
  // coarser triangle edge it lies on (that ring splits its cells along the same diagonal)
  for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
    const o = j * n + i;
    if (!raw.ok[o]) continue;
    const sh = shade(raw, n, i, j, 2);
    for (let k = 0; k < 3; k++) { mpos[o * 3 + k] = pos[o * 3 + k]; msph[o * 3 + k] = sph[o * 3 + k]; mcol[o * 3 + k] = C(raw.col[o * 3 + k] * sh); }
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!(i & 1) && !(j & 1)) continue;
    const o = j * n + i;
    if (!raw.ok[o]) continue;
    let a, e;
    if (!(j & 1)) { a = o - 1; e = o + 1; }               // on a row of the coarser grid
    else if (!(i & 1)) { a = o - n; e = o + n; }          // on a column
    else { a = o - n + 1; e = o + n - 1; }                // on a cell's diagonal: (i + 1, j - 1) to (i - 1, j + 1)
    if (a < 0 || e >= NV || !raw.ok[a] || !raw.ok[e]) {
      for (let k = 0; k < 3; k++) { mpos[o * 3 + k] = pos[o * 3 + k]; msph[o * 3 + k] = sph[o * 3 + k]; mcol[o * 3 + k] = col[o * 3 + k]; }
      continue;
    }
    for (let k = 0; k < 3; k++) {
      mpos[o * 3 + k] = (pos[a * 3 + k] + pos[e * 3 + k]) / 2;
      msph[o * 3 + k] = (sph[a * 3 + k] + sph[e * 3 + k]) / 2;
      mcol[o * 3 + k] = (mcol[a * 3 + k] + mcol[e * 3 + k]) >> 1;
    }
  }
  let idx = null;
  if (!full) {
    const q = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      if (raw.ok[a] && raw.ok[a + 1] && raw.ok[a + n] && raw.ok[a + n + 1]) q.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
    if (p.bridge) bridge(p, raw, pos, q);
    idx = new Uint32Array(q);
  }
  return { pos, sph, col, mpos, msph, mcol, can, idx };
}
// The coarsest ring has no coarser ring to fill the strip along its corner wedge (see js/lod.js), so it closes the wedge itself: the
// samples along one side of the wedge are joined to those the same distance along the other side, which are neighbours on the sphere,
// and the three samples round the corner point make one triangle. In the flat view these triangles fan across the open wedge.
function bridge(p, raw, pos, q) {
  const N = BF.planet.N, n = p.n, c = p.c;
  const at = (u, v) => { const i = (u - p.gu0) / c, j = (v - p.gv0) / c; return i >= 0 && j >= 0 && i < n && j < n && raw.ok[j * n + i] ? j * n + i : -1; };
  const tri = (a, b, d) => {
    if (a < 0 || b < 0 || d < 0) return;
    const x1 = pos[b * 3] - pos[a * 3], z1 = pos[b * 3 + 2] - pos[a * 3 + 2], x2 = pos[d * 3] - pos[a * 3], z2 = pos[d * 3 + 2] - pos[a * 3 + 2];
    if (z1 * x2 - x1 * z2 >= 0) q.push(a, b, d); else q.push(a, d, b);   // counter-clockwise seen from above, as the grid's own
  };
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    const cu = su > 0 ? N : 0, cv = sv > 0 ? N : 0;
    if (Math.abs(cu - p.cu) > c * n || Math.abs(cv - p.cv) > c * n) continue;
    const uIn = su > 0 ? N - c : 0, uOut = su > 0 ? N : -c, vIn = sv > 0 ? N - c : 0, vOut = sv > 0 ? N : -c;
    tri(at(uIn, vIn), at(uOut, vIn), at(uIn, vOut));
    for (let k = 0; k < n; k++) {
      const r0 = at(uOut + su * k * c, vIn), r1 = at(uOut + su * (k + 1) * c, vIn), d0 = at(uIn, vOut + sv * k * c), d1 = at(uIn, vOut + sv * (k + 1) * c);
      if (r0 < 0 && d0 < 0) break;
      tri(r0, r1, d1); tri(r0, d1, d0);
    }
  }
}
// The index of a full n x n grid (counter-clockwise seen from above: x = u, y up, z = v)
function fullIndex(n) {
  const q = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i;
    q[k++] = a; q[k++] = a + n; q[k++] = a + 1; q[k++] = a + 1; q[k++] = a + n; q[k++] = a + n + 1;
  }
  return q;
}
BF.gridJob.fullIndex = fullIndex;

if (typeof document === "undefined") return;   // in a worker: only the sampling above is needed

// ---- the job queue ----
// request(job, prio, done, tag): prio is a number (lower first); done(result) gets the arrays from BF.gridJob.alloc. cancel(tag) drops
// queued jobs with that tag (and ignores the answers of running ones).
const S = (BF.sampler = { workers: [], queue: [], world: null, inline: false, running: null, seq: 0, workMs: 0, samples: 0 });
S.reset = function (world) {
  for (const w of S.workers) w.terminate();
  S.workers = []; S.queue = []; S.running = null; S.world = world;
  S.inline = !!BF.lodInline || typeof Worker === "undefined" || location.protocol === "file:";
  if (S.inline) return;
  const k = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));   // every core but the page's, up to 6
  for (let i = 0; i < k; i++) {
    let w;
    try { w = new Worker("js/lodworker.js"); } catch (e) { S.inline = true; break; }
    w.busy = [];   // jobs posted to this worker, oldest first (it answers in order)
    w.postMessage({ init: world, palette: PAL });
    w.onmessage = (e) => { const it = w.busy.shift(); if (e.data.ms) { S.workMs += e.data.ms; S.samples += e.data.ok.length; } if (it && !it.dead) it.done(e.data); pump(); };
    w.onerror = (e) => {
      // a worker that can't load: sample in the page instead
      console.warn("distant terrain: worker failed, sampling in the page", e && e.message);
      S.inline = true;
      for (const x of S.workers) { for (const it of x.busy) if (!it.dead) S.queue.push(it); x.terminate(); }
      S.workers = [];
    };
    S.workers.push(w);
  }
};
function next() {
  let b = -1, bp = Infinity;
  for (let i = 0; i < S.queue.length; i++) { const p = S.queue[i].prio; if (p < bp) { bp = p; b = i; } }
  if (b < 0) return null;
  const it = S.queue[b];
  S.queue[b] = S.queue[S.queue.length - 1]; S.queue.pop();
  return it;
}
function pump() {
  if (S.inline) return;
  // two jobs a worker, so it starts the next one at once instead of waiting for the page to take the last answer (a slow frame)
  for (let k = 0; k < 2; k++) for (const w of S.workers) {
    if (w.busy.length > k) continue;
    const it = next();
    if (!it) return;
    w.busy.push(it);
    w.postMessage(it.job);
  }
}
S.request = function (job, prio, done, tag = null) {
  job.id = ++S.seq;
  S.queue.push({ job, prio, done, tag, dead: false });
  pump();
};
S.cancel = function (tag) {
  S.queue = S.queue.filter((it) => it.tag !== tag);
  for (const w of S.workers) for (const it of w.busy) if (it.tag === tag) it.dead = true;
  if (S.running && S.running.tag === tag) S.running = null;
};
S.pending = () => S.queue.length + S.workers.reduce((n, w) => n + w.busy.length, 0) + (S.running ? 1 : 0);
// Called each frame: hands out work, or (without workers) samples rows in the page within the budget.
S.tick = function (budgetMs) {
  if (!S.inline) { pump(); return; }
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    if (!S.running) {
      const it = next();
      if (!it) return;
      if (it.job.mesh) { it.done(BF.gridJob.mesh(it.job.p, it.job.raw)); continue; }
      it.out = BF.gridJob.alloc(it.job); it.row = 0;
      S.running = it;
    }
    const it = S.running;
    BF.gridJob.rows(it.job, it.out, it.row, it.row + 1);
    if (++it.row >= it.job.ny) { S.running = null; it.done(it.out); }
  }
};
})();
