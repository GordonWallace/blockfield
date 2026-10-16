// Rivers for the whole planet, worked out once when a world starts.
//
// The planet is finite, so unlike a flat endless world the whole drainage network can be solved at once:
//  1. A lattice of nodes, 160 x 160 per face (one per ~1 km, jittered), samples the terrain. Neighbours
//     across a face edge are found through the same exact unfold the game uses for blocks.
//  2. Priority flood from the ocean: nodes are reached in order of rising (filled) height, so every land
//     node, including ones in basins, gets a path to the sea that never climbs. Basins are filled just
//     enough to spill over their lowest rim (that is where lakes would go).
//  3. Each node drains to its steepest lower neighbour. Diagonal links that would cross another diagonal
//     are bent onto the shared side instead, so rivers never cross.
//  4. Flow (rain-weighted catchment) is summed from the sources down: tributaries join into larger rivers,
//     and a river is as wide as the water reaching it.
//  5. Each link is a smooth curve through the nodes (no corners where links meet), with meanders from 3D
//     noise at its world position, so the curve is the same whichever face it is looked at from.
//  6. Water surface, worked from the sources down: it sits just below the lowest nearby ground and never
//     rises, so a river fits into the land and cuts through any rise in its way instead of being built up
//     above it.
// Lakes (step 3b): pockets of ground below sea level inland (where the continent noise dips) hold water at
// sea level. Each lake a river reaches is a node of the network: rivers that reach its shore end there, and
// one outlet river leaves from the lowest point of its banks, downhill along the lowest way out of the lake's
// valley, with all of their water.
//
// at(f, u, v, out) returns the nearest river to a column: d (distance to the centre line), w (half width),
// rs (water surface), the same fields Blockfield's rivers.at() fills, so terrain carving ports across.
(() => {
"use strict";
const G = typeof window !== "undefined" ? window : self;   // self: also loaded in the sampling workers (r14-05)
const BF = (G.BF = G.BF || {});
const P = BF.planet, N = P.N;
const M = 160, NS = N / M;            // nodes per face edge; node spacing in blocks (1024)
const ACC_MIN = 6;                    // rain-weighted catchment (in nodes) at which a river starts
const WCAP = 40;                      // largest half width
const STEP = 16;                      // spacing of the meander polyline
const DROP = 1.5;                     // water surface this far below the lower bank
const SLACK = 3;                     // and this much further below the coarse samples along a river
const FLAT = 250;                     // blocks before a junction where the water is level with it
const REACH = 150;                    // how far from the water a river shapes its valley
const CELL = 512, KC = N / CELL;      // lookup cells per face edge
const LOWG = 60;                      // a river chord is searched for ground below sea level only where an end is lower than this
const MARGIN = REACH + WCAP + 110;    // a link is listed in every cell within this of its chord
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SIDE = [, , , , [0, 2], [0, 3], [1, 2], [1, 3]];   // a diagonal's two neighbouring straight directions

BF.planetRivers = { M, NS, ACC_MIN, WCAP, REACH };

// sample(x, y, z) -> { e (routing height), hf (ground), land, rain, elat } for a unit direction;
// ground(x, y, z) -> ground height (hf) alone, for the many samples along each river
// steps(...) is a generator: each next() runs a slice of the solve and yields the fraction done; it returns the network.
// make(...) runs it to the end.
BF.planetRivers.make = function (seed, sample, ground, pre) {
  const g = BF.planetRivers.steps(seed, sample, ground, pre);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
};
// Lattice node id's grid position on its face (jittered), into out = [u, v].
function nodeUV(nz, id, out) {
  const MM = M * M, j = ((id % MM) / M) | 0, i = id % M;
  out[0] = (i + 0.5 + (nz.hash(id, 1) - 0.5) * 0.6) * NS;
  out[1] = (j + 0.5 + (nz.hash(id, 2) - 0.5) * 0.6) * NS;
  return out;
}
// The terrain at lattice nodes from to to - 1 (the slow part of a solve, which js/riverworker.js splits between workers): fills
// out.e (routing height), out.p (ground), out.sea (1 at sea) and out.rain (rain-weighted water), arrays over all 6 * M * M nodes.
BF.planetRivers.nodeSamples = function (seed, sample, from, to, out) {
  const nz = BF.makeNoise(seed ^ 0x2c1b3c6d), MM = M * M, uv = [0, 0], d = [0, 0, 0];
  for (let id = from; id < to; id++) {
    nodeUV(nz, id, uv);
    P.dir((id / MM) | 0, uv[0], uv[1], d);
    const s = sample(d[0], d[1], d[2]);
    out.e[id] = s.e; out.p[id] = s.hf; out.sea[id] = s.land < 0 ? 1 : 0;
    // snow and ice sheets feed little water
    out.rain[id] = (0.25 + s.rain) * (0.25 + 0.75 * smooth(86, 70, s.elat));
  }
  return out;
};
BF.planetRivers.newSamples = () => { const n = 6 * M * M; return { e: new Float32Array(n), p: new Float32Array(n), sea: new Uint8Array(n), rain: new Float32Array(n) }; };
// pre: node samples already worked out (nodeSamples over every node), or null to work them out here.
BF.planetRivers.steps = function* (seed, sample, ground, pre) {
  const t0 = Date.now(), SEA = BF.SEA == null ? 0 : BF.SEA;
  const nz = BF.makeNoise(seed ^ 0x2c1b3c6d);
  // node ids: the lattice (0 to NN - 1), then one per lake (NN + lake index)
  const NN = 6 * M * M, MM = M * M, LMAX = 8192, NT = NN + LMAX;
  const U = new Float64Array(NT), V = new Float64Array(NT), D = new Float64Array(NT * 3);
  const e = new Float32Array(NT), p = new Float32Array(NT), rain = new Float32Array(NT), sea = new Uint8Array(NT);
  const nb = new Int32Array(NT * 8).fill(-1);
  const d = [0, 0, 0], w = {}, uv = [0, 0];

  // 1. nodes and neighbours
  if (!pre) {
    pre = BF.planetRivers.newSamples();
    for (let id = 0; id < NN; id += 4096) { yield 0.4 * id / NN; BF.planetRivers.nodeSamples(seed, sample, id, Math.min(NN, id + 4096), pre); }
  }
  e.set(pre.e); p.set(pre.p); sea.set(pre.sea); rain.set(pre.rain);
  for (let id = 0; id < NN; id++) {
    const f = (id / MM) | 0, j = ((id % MM) / M) | 0, i = id % M;
    nodeUV(nz, id, uv); U[id] = uv[0]; V[id] = uv[1];
    P.dir(f, U[id], V[id], d);
    D[id * 3] = d[0]; D[id * 3 + 1] = d[1]; D[id * 3 + 2] = d[2];
    for (let k = 0; k < 8; k++) {
      const ii = i + DIRS[k][0], jj = j + DIRS[k][1], off = ii < 0 || ii >= M || jj < 0 || jj >= M;
      if (!off) { nb[id * 8 + k] = f * MM + jj * M + ii; continue; }
      if (k >= 4) continue;   // no diagonal links across a face edge
      P.wrap(f, (ii + 0.5) * NS, (jj + 0.5) * NS, w);
      nb[id * 8 + k] = w.f * MM + Math.floor(w.v / NS) * M + Math.floor(w.u / NS);
    }
  }
  const tNodes = Date.now() - t0;
  yield 0.4;

  // 2. priority flood from the sea (binary min-heap on filled height, ties by id)
  const filled = new Float32Array(NT), rank0 = new Int32Array(NT).fill(-1), seen = new Uint8Array(NN);
  const order = new Int32Array(NN);
  const hk = new Float64Array(NN), hv = new Int32Array(NN);
  let hn = 0, no = 0;
  const less = (a, b) => hk[a] < hk[b] || (hk[a] === hk[b] && hv[a] < hv[b]);
  const swap = (a, b) => { const k = hk[a]; hk[a] = hk[b]; hk[b] = k; const v = hv[a]; hv[a] = hv[b]; hv[b] = v; };
  function push(key, id) {
    let c = hn++; hk[c] = key; hv[c] = id;
    while (c > 0) { const q = (c - 1) >> 1; if (!less(c, q)) break; swap(c, q); c = q; }
  }
  function pop() {
    const id = hv[0]; hn--; hk[0] = hk[hn]; hv[0] = hv[hn];
    let c = 0;
    for (;;) {
      const l = 2 * c + 1, r = l + 1; let m = c;
      if (l < hn && less(l, m)) m = l;
      if (r < hn && less(r, m)) m = r;
      if (m === c) break; swap(c, m); c = m;
    }
    return id;
  }
  for (let id = 0; id < NN; id++) if (sea[id]) { filled[id] = SEA - 1; seen[id] = 1; push(filled[id], id); }
  while (hn) {
    const c = pop();
    rank0[c] = no; order[no++] = c;
    for (let k = 0; k < 8; k++) {
      const m = nb[c * 8 + k];
      if (m < 0 || seen[m]) continue;
      seen[m] = 1; filled[m] = Math.max(e[m], filled[c] + 0.01);
      push(filled[m], m);
    }
  }
  // (a planet with no sea at all would leave nodes unranked; ours always has ocean)

  // 3. steepest descent on filled height, never crossing another diagonal
  const down = new Int32Array(NT).fill(-1);
  const dist = (a, b) => Math.acos(Math.min(1, D[a * 3] * D[b * 3] + D[a * 3 + 1] * D[b * 3 + 1] + D[a * 3 + 2] * D[b * 3 + 2])) * P.R;
  let bent = 0;
  for (let r = 0; r < no; r++) {
    const n = order[r];
    if (sea[n]) continue;
    let best = -1, bk = -1, bs = -Infinity;
    for (let k = 0; k < 8; k++) {
      const m = nb[n * 8 + k];
      if (m < 0 || rank0[m] > rank0[n]) continue;
      const s = (filled[n] - filled[m]) / dist(n, m);
      if (s > bs) { bs = s; best = m; bk = k; }
    }
    if (bk >= 4) {
      // the other diagonal of this 2 x 2 square runs between the two side neighbours a and b
      const a = nb[n * 8 + (DIRS[bk][0] > 0 ? 0 : 1)], b = nb[n * 8 + (DIRS[bk][1] > 0 ? 2 : 3)];
      if (down[a] === b) { best = a; bent++; } else if (down[b] === a) { best = b; bent++; }
    }
    down[n] = best;
  }

  // 4. flow, from the sources down (over `ord`, every node after the ones that drain into it)
  const acc = new Float32Array(NT);
  function flow(ord) {
    acc.fill(0);
    for (let r = ord.length - 1; r >= 0; r--) {
      const n = ord[r];
      if (sea[n]) continue;
      acc[n] += rain[n];
      acc[down[n]] += acc[n];
    }
  }
  flow(order.subarray(0, no));
  const faceOf = (n) => (n < NN ? (n / MM) | 0 : lakes[n - NN].g);
  // node m's grid position in face F's (extended) grid; false if m's face doesn't border F
  function inFace(F, m, out) {
    const g = faceOf(m);
    if (g === F) { out[0] = U[m]; out[1] = V[m]; return out; }
    const e = P.UNFOLD[F][g];
    if (!e) return false;
    const A = e.A;
    out[0] = A[0] * U[m] + A[1] * V[m] + e.t[0]; out[1] = A[2] * U[m] + A[3] * V[m] + e.t[1];
    return out;
  }
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const w3 = {}, d3 = [0, 0, 0];
  const groundAt = (F, x, y) => { P.wrap(F, x, y, w3); P.dir(w3.f, w3.u, w3.v, d3); return ground(d3[0], d3[1], d3[2]); };

  // 3b. lakes, found where a river's chord crosses ground below sea level that isn't open ocean, and at
  // small groups of sea nodes inland. A lake is the pocket of LC-block cells below sea level there; pockets
  // that turn out to be part of the ocean (they reach open sea, or grow past CAP cells) are left alone.
  const LC = 128, KL = N / LC, CAP = 4000, FS = 16;   // lake cells; most cells in one lake; fine step
  const HMIN = 6;   // how deep a highland basin must be (at its deepest node) to hold a lake
  const lakes = [], lakeCell = new Map(), lakeCoarse = new Set(), member = new Uint8Array(NN);
  const isLake = (n) => n >= NN;
  const wl3 = {};
  // canonical key of cell (cx, cy) of face F's extended grid; -1 inside a cube corner's empty wedge
  function ckey(F, cx, cy) {
    if ((cx < 0 || cx >= KL) && (cy < 0 || cy >= KL)) return -1;
    if (cx >= 0 && cx < KL && cy >= 0 && cy < KL) return (F * KL + cx) * KL + cy;
    P.wrap(F, cx * LC + LC / 2, cy * LC + LC / 2, wl3);
    return (wl3.f * KL + Math.min(KL - 1, Math.floor(wl3.u / LC))) * KL + Math.min(KL - 1, Math.floor(wl3.v / LC));
  }
  // the lake whose cells are at or next to point (x, y) of face F's grid, or -1
  function lakeNear(F, x, y) {
    const cx = Math.floor(x / LC), cy = Math.floor(y / LC);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = ckey(F, cx + dx, cy + dy), l = k < 0 ? undefined : lakeCell.get(k);
      if (l !== undefined) return l;
    }
    return -1;
  }
  // the lake that point (x, y) is in (near its cells and below its water level), or -1
  const inLake = (F, x, y) => { const l = lakeNear(F, x, y); return l >= 0 && groundAt(F, x, y) < lakes[l].wl ? l : -1; };
  // sea nodes in big groups are open ocean
  const comp = new Int32Array(NN).fill(0);
  for (let n = 0; n < NN; n++) {
    if (!sea[n] || comp[n]) continue;
    const st = [n], grp = [n]; comp[n] = -1;
    while (st.length) { const c = st.pop(); for (let k = 0; k < 8; k++) { const m = nb[c * 8 + k]; if (m >= 0 && sea[m] && !comp[m]) { comp[m] = -1; st.push(m); grp.push(m); } } }
    for (const m of grp) comp[m] = grp.length;
  }
  const OCEAN = 30;   // sea nodes in a group bigger than this are ocean
  const lakeStats = { calls: 0, cells: 0, probed: 0, ocean: 0, cap: 0, leak: 0, high: 0, lowered: 0 };
  // The pocket around (x, y) of face F's grid: the LC-block cells below sea level joined to it (and the
  // one it starts in), then the outlet: the lowest point of its banks, found on a FS-block grid around the
  // lowest bank cell, and the way out from there (downhill, or else straight out of the lake). null if the
  // pocket is part of the ocean or bigger than CAP cells.
  const cellH = new Map(), cellL = new Map();   // ground at lake cells' centres, and the lowest of five points in a cell, by cell key
  const PROBE = 12;
  function pocket(F, x, y, lvl = SEA, allowed = null) {
    lakeStats.calls++;
    const cx0 = Math.floor(x / LC), cy0 = Math.floor(y / LC), k0 = ckey(F, cx0, cy0);
    if (k0 < 0) return null;
    const seen2 = new Set([k0]), st = [[cx0, cy0, k0]], cells = [], bank = [];
    while (st.length) {
      const [cx, cy, key] = st.pop();
      let h = cellH.get(key);
      if (h === undefined) { h = groundAt(F, cx * LC + LC / 2, cy * LC + LC / 2); cellH.set(key, h); lakeStats.cells++; }
      // a bank cell whose centre is only a little above the water is probed further (four more points): low ground through it would
      // carry the water past the cells around the lake, where it isn't drawn (it would stand against air)
      if (lvl > SEA && h >= lvl && h < lvl + PROBE && key !== k0) {   // (below sea level every column holds water anyway)
        let lo = cellL.get(key);
        if (lo === undefined) {
          lo = h;
          for (let q = 4; q < 8; q++) lo = Math.min(lo, groundAt(F, cx * LC + LC / 2 + DIRS[q][0] * LC / 4, cy * LC + LC / 2 + DIRS[q][1] * LC / 4));
          cellL.set(key, lo); lakeStats.probed++;
        }
        if (lo < lvl) h = lo;
      }
      if (h >= lvl && key !== k0) { bank.push([h, cx, cy]); continue; }
      cells.push(key);
      if (cells.length > (allowed ? 4 * CAP : CAP)) { lakeStats.cap++; return null; }
      // the lattice node over this cell: open ocean?
      const g = (key / (KL * KL)) | 0, cu = ((key / KL) | 0) % KL, cv = key % KL;
      const n = g * MM + Math.min(M - 1, Math.floor(cv * LC / NS)) * M + Math.min(M - 1, Math.floor(cu * LC / NS));
      if (sea[n] && comp[n] > OCEAN) { lakeStats.ocean++; return null; }
      if (allowed && !allowed.has(n)) { lakeStats.leak++; return null; }   // spills out of its basin
      for (let k = 0; k < 8; k++) {
        const nx = cx + DIRS[k][0], ny = cy + DIRS[k][1], nk = ckey(F, nx, ny);
        if (nk < 0 || seen2.has(nk)) continue;
        seen2.add(nk);
        st.push([nx, ny, nk]);
      }
    }
    if (!bank.length) return null;
    return { F, wl: lvl, cells, bank, dead: false };
  }
  // Pocket L's outlet point (the lowest point of its banks, found on a grid around the lowest bank cell) and
  // the way out from there (downhill, or else straight out of the lake); false if there is none.
  function outlet(L) {
    const { F, cells, bank } = L, lvl = L.wl;
    const own = new Set(cells), mine = (px, py) => {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (own.has(ckey(F, Math.floor(px / LC) + dx, Math.floor(py / LC) + dy))) return true;
      return false;
    };
    // the lowest bank point: dry ground beside water, around the lowest bank cells
    bank.sort((a, b) => a[0] - b[0]);
    let O = null, Oh = Infinity, Ow = null;
    for (const [, bx, by] of bank.slice(0, 1)) {
      const BS = 2 * FS, n2 = (3 * LC) / BS, x0 = (bx - 1) * LC, y0 = (by - 1) * LC, gh = new Float32Array((n2 + 1) * (n2 + 1));
      for (let j = 0; j <= n2; j++) for (let i = 0; i <= n2; i++) {
        const px = x0 + i * BS, py = y0 + j * BS;
        gh[j * (n2 + 1) + i] = ckey(F, Math.floor(px / LC), Math.floor(py / LC)) < 0 ? Infinity : groundAt(F, px, py);
      }
      for (let j = 1; j < n2; j++) for (let i = 1; i < n2; i++) {
        const h = gh[j * (n2 + 1) + i];
        if (h < lvl || h >= Oh) continue;
        for (let k = 0; k < 4; k++) {
          const ii = i + DIRS[k][0], jj = j + DIRS[k][1];
          if (gh[jj * (n2 + 1) + ii] < lvl && mine(x0 + ii * BS, y0 + jj * BS)) { O = [x0 + i * BS, y0 + j * BS]; Oh = h; Ow = [x0 + ii * BS, y0 + jj * BS]; break; }
        }
      }
    }
    if (!O) return false;
    // the way out: the steepest way down from O over dry ground, else straight out of the water
    let best = 0, dir2 = unit(O[0] - Ow[0], O[1] - Ow[1]);
    for (let k = 0; k < 8; k++) {
      const st2 = 2 * FS / Math.hypot(DIRS[k][0], DIRS[k][1]), px = O[0] + DIRS[k][0] * st2, py = O[1] + DIRS[k][1] * st2;
      if (ckey(F, Math.floor(px / LC), Math.floor(py / LC)) < 0) continue;
      const h = groundAt(F, px, py);
      if (h < lvl) continue;
      const fall = (Oh - h) / (2 * FS);
      if (fall > best) { best = fall; dir2 = unit(DIRS[k][0], DIRS[k][1]); }
    }
    L.ox = O[0]; L.oy = O[1]; L.dx = O[0] + dir2[0] * LC; L.dy = O[1] + dir2[1] * LC; L.bank = null;
    return true;
  }
  function addLake(L) {
    if (lakes.length >= LMAX || (L.ox === undefined && !outlet(L))) return;
    const k = lakes.length;
    lakes.push(L);
    for (const key of L.cells) {
      const old = lakeCell.get(key);
      if (old !== undefined && old !== k) lakes[old].dead = true;   // a bigger lake took this one in
      lakeCell.set(key, k);
    }
  }
  const tLakes = Date.now();
  yield 0.41;
  // seeds: small groups of sea nodes inland, and river chords that cross low ground between land nodes
  for (let n = 0; n < NN; n++) {
    if (!sea[n] || comp[n] > OCEAN || inLake(faceOf(n), U[n], V[n]) >= 0) continue;
    const L = pocket(faceOf(n), U[n], V[n]);
    if (L) addLake(L);
  }
  const B0 = [0, 0];
  for (let n = 0; n < NN; n++) {
    if (n % 8192 === 0) yield 0.42 + 0.08 * n / NN;
    if (sea[n] || acc[n] < ACC_MIN) continue;
    const m = down[n], F = faceOf(n);
    if (sea[m] && comp[m] > OCEAN) continue;   // a river mouth
    let coast = false;
    for (let k = 0; k < 8 && !coast; k++) { const a = nb[n * 8 + k], b = nb[m * 8 + k]; coast = (a >= 0 && sea[a] && comp[a] > OCEAN) || (b >= 0 && sea[b] && comp[b] > OCEAN); }
    if (coast) continue;   // low ground by the coast is an inlet of the sea
    if (p[n] > SEA + LOWG && p[m] > SEA + LOWG) continue;   // (high ground at both ends: no hollow below sea level between them)
    if (!inFace(F, m, B0)) continue;
    const L0 = Math.hypot(B0[0] - U[n], B0[1] - V[n]), cnt = Math.ceil(L0 / 64);
    for (let s = 1; s < cnt; s++) {
      const x = U[n] + (B0[0] - U[n]) * s / cnt, y = V[n] + (B0[1] - V[n]) * s / cnt;
      if (groundAt(F, x, y) >= SEA) continue;
      if (lakeNear(F, x, y) < 0) { const L = pocket(F, x, y); if (L) addLake(L); }
      break;
    }
  }
  // highland lakes: basins in the ground itself (a second priority flood, on ground height from the sea).
  // Nodes filled to one spill level make one basin; deep enough, it holds a lake whose cells may not spill
  // past the basin's nodes and the ring around them (a lower gap between nodes would let it drain away), so
  // the level is lowered until the water stays in
  {
    const fg = filled.slice(0, NN).fill(Infinity), seenG = new Uint8Array(NN);
    for (let n = 0; n < NN; n++) if (sea[n]) { fg[n] = SEA; seenG[n] = 1; push(SEA, n); }
    while (hn) {
      const c = pop();
      for (let k = 0; k < 8; k++) {
        const m = nb[c * 8 + k];
        if (m < 0 || seenG[m]) continue;
        seenG[m] = 1; fg[m] = Math.max(p[m], fg[c]);
        push(fg[m], m);
      }
    }
    const basins = [], inB = new Uint8Array(NN);
    for (let n = 0; n < NN; n++) {
      if (inB[n] || sea[n] || fg[n] - p[n] < 0.01) continue;
      const st = [n], grp = [n];
      inB[n] = 1;
      let deep = n;
      while (st.length) {
        const c = st.pop();
        if (p[c] < p[deep]) deep = c;
        for (let k = 0; k < 8; k++) {
          const m = nb[c * 8 + k];
          if (m >= 0 && !inB[m] && !sea[m] && fg[m] === fg[c] && fg[m] - p[m] >= 0.01) { inB[m] = 1; st.push(m); grp.push(m); }
        }
      }
      if (fg[n] - p[deep] >= HMIN) basins.push({ grp, deep, top: fg[n] });
    }
    basins.sort((a, b) => b.grp.length - a.grp.length);
    // a rough water level for each river (the lowest ground along it so far, from the sources down): a lake
    // can't stand higher than a river that flows into it
    const rsE = new Float32Array(NN);
    for (let n = 0; n < NN; n++) rsE[n] = sea[n] ? SEA : p[n] - DROP - SLACK;
    for (let r = no - 1; r >= 0; r--) { const n = order[r], m = down[n]; if (!sea[n] && m >= 0) rsE[m] = Math.min(rsE[m], rsE[n]); }
    // the lowest water level among rivers whose chord reaches pocket L's water (from the nodes in `nodes`)
    const Bq = [0, 0];
    function inflowCap(L, nodes, lvl) {
      const own = new Set(L.cells), wet = (G, x, y) => {
        const cx = Math.floor(x / LC), cy = Math.floor(y / LC);
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) hit = own.has(ckey(G, cx + dx, cy + dy));
        return hit && groundAt(G, x, y) < lvl;
      };
      let cap = Infinity;
      for (const n of nodes) {
        const G = faceOf(n), m = down[n];
        if (sea[n] || m < 0 || rsE[n] >= lvl || wet(G, U[n], V[n])) continue;
        if (!inFace(G, m, Bq)) continue;
        const cnt = Math.max(2, Math.ceil(Math.hypot(Bq[0] - U[n], Bq[1] - V[n]) / 64));
        for (let s2 = 1; s2 <= cnt; s2++) if (wet(G, U[n] + (Bq[0] - U[n]) * s2 / cnt, V[n] + (Bq[1] - V[n]) * s2 / cnt)) { cap = Math.min(cap, rsE[n] - 1); break; }
      }
      return cap;
    }
    let nb2 = 0;
    for (const b of basins) {
      if (nb2++ % 16 === 0) yield 0.5 + 0.32 * nb2 / basins.length;
      const F = faceOf(b.deep);
      if (inLake(F, U[b.deep], V[b.deep]) >= 0) continue;
      const allowed = new Set(b.grp), gs = new Set(b.grp);
      for (const c of b.grp) for (let k = 0; k < 8; k++) if (nb[c * 8 + k] >= 0) allowed.add(nb[c * 8 + k]);
      const ring2 = new Set(allowed);
      for (const c of allowed) if (!gs.has(c)) for (let k = 0; k < 8; k++) if (nb[c * 8 + k] >= 0) ring2.add(nb[c * 8 + k]);
      // try the spill level, lower if the water spills out between nodes, and lower again until no river
      // that reaches the water runs below it
      let lvl = Math.floor(b.top);
      for (let t = 0; t < 6; t++) {
        if (lvl - p[b.deep] < HMIN / 2) break;
        const L = pocket(F, U[b.deep], V[b.deep], lvl, allowed);
        if (!L) { lvl = Math.floor(p[b.deep] + (lvl - p[b.deep]) * 0.7); continue; }
        const cap = inflowCap(L, ring2, lvl);
        if (cap >= lvl) { addLake(L); lakeStats.high++; break; }
        lvl = Math.floor(cap);
      }
    }
  }
  // drop lakes that a later one took in; renumber
  {
    const live = lakes.filter((L) => !L.dead);
    lakes.length = 0; lakeCell.clear();
    live.forEach((L) => addLake(L));
  }
  for (const L of lakes) for (const key of L.cells) {
    const g = (key / (KL * KL)) | 0, cu = ((key / KL) | 0) % KL, cv = key % KL;
    for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
      const x = (cu + du * 2 + 0.5) * LC, y = (cv + dv * 2 + 0.5) * LC;
      if ((x < 0 || x >= N) && (y < 0 || y >= N)) continue;
      P.wrap(g, x, y, wl3);
      lakeCoarse.add((wl3.f * KC + Math.min(KC - 1, Math.floor(wl3.u / CELL))) * KC + Math.min(KC - 1, Math.floor(wl3.v / CELL)));
    }
  }
  // lake nodes, at each lake's outlet (the lowest point of its banks)
  const entry = new Map();   // node -> where its chord reaches a lake's shore (in its own face's grid)
  const outDir = [];
  lakes.forEach((L, k) => {
    const id = NN + k;
    P.wrap(L.F, L.ox, L.oy, wl3);
    L.g = wl3.f; U[id] = wl3.u; V[id] = wl3.v;
    P.dir(L.g, U[id], V[id], d);
    D[id * 3] = d[0]; D[id * 3 + 1] = d[1]; D[id * 3 + 2] = d[2];
    p[id] = L.wl; e[id] = L.wl; filled[id] = L.wl;
    // the way out, in the outlet's own grid
    const T = L.g === L.F ? null : P.UNFOLD[L.g][L.F];
    const tr = (x, y) => (T ? [T.A[0] * x + T.A[1] * y + T.t[0], T.A[2] * x + T.A[3] * y + T.t[1]] : [x, y]);
    const o = tr(L.ox, L.oy), q2 = tr(L.dx, L.dy);
    outDir[k] = unit(q2[0] - o[0], q2[1] - o[1]);
  });
  const coarseOf = (n) => (faceOf(n) * KC + Math.min(KC - 1, Math.floor(U[n] / CELL))) * KC + Math.min(KC - 1, Math.floor(V[n] / CELL));
  // members drain into their lake; every chord that reaches a lake ends at its shore
  for (let n = 0; n < NN; n++) {
    const F = faceOf(n);
    if (sea[n] && comp[n] > OCEAN) continue;
    const near2 = lakeCoarse.has(coarseOf(n)), own = near2 ? inLake(F, U[n], V[n]) : -1;
    if (own >= 0) { member[n] = 1; sea[n] = 0; down[n] = NN + own; continue; }
    const m = down[n];
    if (sea[n] || m < 0) continue;
    if (!near2 && !lakeCoarse.has(coarseOf(m))) continue;
    if (!inFace(F, m, B0)) continue;
    const L0 = Math.hypot(B0[0] - U[n], B0[1] - V[n]), cnt = Math.max(2, Math.ceil(L0 / FS));
    for (let s = 1; s <= cnt; s++) {
      const x = U[n] + (B0[0] - U[n]) * s / cnt, y = V[n] + (B0[1] - V[n]) * s / cnt, l = inLake(F, x, y);
      if (l >= 0) { down[n] = NN + l; entry.set(n, [x, y, m]); break; }   // m: the node it ran towards
    }
  }
  // each lake's outlet runs downhill from its lowest bank (steepest descent in LC / 4 steps over dry ground)
  // and joins the network at the nearest node there that doesn't drain back into the lake (or at the next
  // lake, or the sea)
  const towards = (n) => { const en = entry.get(n); return en ? en[2] : down[n]; };   // where a link's chord heads
  const loops = (from, id) => { for (let c = from, k = 0; c >= 0 && !sea[c] && k < NT; c = down[c], k++) if (c === id) return true; return false; };
  const Eq = [0, 0], SD = LC / 4;
  const done = [];   // lakes whose outlets are placed
  // water from a lake at level wl can't get into a higher lake further down
  const climbs = (from, wl) => { for (let c = from, k = 0; c >= 0 && k < NT; c = down[c], k++) { if (isLake(c) && lakes[c - NN].wl > wl + 0.5) return true; if (sea[c]) return false; } return false; };
  lakes.forEach((L, k) => {
    const id = NN + k;
    const goesBack = (c) => loops(c, id) || climbs(c, L.wl);
    let x = L.dx, y = L.dy, h = groundAt(L.F, x, y), hit = -1;
    if (inLake(L.F, x, y) === k) { x = L.ox; y = L.oy; h = groundAt(L.F, x, y); }   // the way out ran back in
    for (let step = 0; step < 120; step++) {
      const l2 = h < SEA || lakeNear(L.F, x, y) >= 0 ? inLake(L.F, x, y) : -1;
      if (h < SEA || (l2 >= 0 && l2 !== k)) { hit = l2; break; }   // the sea, or another lake
      let bx = x, by = y, bh = h;
      for (let q = 0; q < 8; q++) {
        const sl = SD / Math.hypot(DIRS[q][0], DIRS[q][1]), nx = x + DIRS[q][0] * sl, ny = y + DIRS[q][1] * sl;
        if (ckey(L.F, Math.floor(nx / LC), Math.floor(ny / LC)) < 0) continue;
        const hh = groundAt(L.F, nx, ny);
        if (hh < bh && inLake(L.F, nx, ny) !== k) { bh = hh; bx = nx; by = ny; }
      }
      if (bx === x && by === y) break;
      x = bx; y = by; h = bh;
    }
    const cand = [];
    if (hit >= 0 && hit !== k) cand.push([0, NN + hit]);
    // lattice nodes around the end of the walk
    const w4 = P.wrap(L.F, x, y, {}), g = w4.f, eu = w4.u, ev = w4.v;
    const gi = Math.min(M - 1, Math.floor(eu / NS)), gj = Math.min(M - 1, Math.floor(ev / NS));
    const near = new Set([g * MM + gj * M + gi]), O2 = inFace(g, id, [0, 0]);
    for (let r = 0; r < 2; r++) for (const c of [...near]) for (let q = 0; q < 8; q++) { const m = nb[c * 8 + q]; if (m >= 0) near.add(m); }
    for (const c of near) {
      if (member[c] || !O2 || !inFace(g, c, Eq)) continue;
      const dd = Math.hypot(Eq[0] - eu, Eq[1] - ev);
      // the outlet's chord from the lake to c must not cross back over the lake
      const cn = Math.max(2, Math.ceil(Math.hypot(Eq[0] - O2[0], Eq[1] - O2[1]) / (2 * FS)));
      let back = false;
      for (let s2 = 2; s2 <= cn && !back; s2++) back = inLake(g, O2[0] + (Eq[0] - O2[0]) * s2 / cn, O2[1] + (Eq[1] - O2[1]) * s2 / cn) === k;
      if (back) continue;
      cand.push([dd + 30 * Math.max(0, p[c] - L.wl) + (h < SEA && !sea[c] ? 2000 : 0), c]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    // nor cross a river's chord (any link from the lattice nodes along the way)
    const along = (c) => {
      const set = new Set(), cn = Math.max(1, Math.ceil(Math.hypot(Eq[0] - O2[0], Eq[1] - O2[1]) / (NS / 2))), w5 = {};
      for (let s2 = 0; s2 <= cn; s2++) {
        P.wrap(g, O2[0] + (Eq[0] - O2[0]) * s2 / cn, O2[1] + (Eq[1] - O2[1]) * s2 / cn, w5);
        const b = w5.f * MM + Math.min(M - 1, Math.max(0, Math.floor(w5.v / NS))) * M + Math.min(M - 1, Math.max(0, Math.floor(w5.u / NS)));
        set.add(b);
        for (let q = 0; q < 8; q++) { const m = nb[b * 8 + q]; if (m >= 0) { set.add(m); for (let q2 = 0; q2 < 8; q2++) if (nb[m * 8 + q2] >= 0) set.add(nb[m * 8 + q2]); } }
      }
      return set;
    };
    const o3 = (a, b, c2) => (b[0] - a[0]) * (c2[1] - a[1]) - (b[1] - a[1]) * (c2[0] - a[0]);
    const P1 = [0, 0], P2 = [0, 0];
    // the links the chord from the lake to c crosses
    const crossed = (c) => {
      const out = [];
      if (!O2) return out;
      if (c === NN + hit) { Eq[0] = eu; Eq[1] = ev; } else if (!inFace(g, c, Eq)) return out;   // into the next lake: to its shore
      for (const q of [...along(c), ...done]) {
        if (member[q] || sea[q] || (!isLake(q) && acc[q] < ACC_MIN / 3) || q === c || (down[q] === c && !isLake(c)) || down[q] < 0 || down[q] === id) continue;
        if (!inFace(g, q, P1)) continue;
        const en = entry.get(q);
        if (en) { if (faceOf(q) !== g) continue; P2[0] = en[0]; P2[1] = en[1]; } else if (!inFace(g, down[q], P2)) continue;
        if (o3(O2, Eq, P1) * o3(O2, Eq, P2) < 0 && o3(P1, P2, O2) * o3(P1, P2, Eq) < 0) out.push(q);
      }
      return out;
    };
    down[id] = -1;
    // a node by the end of the walk that drains elsewhere (looking further if none does)
    for (const far of [1.5 * NS, 3 * NS]) {
      if (down[id] >= 0) break;
      for (const [d, c] of cand) if (d < far && !goesBack(c) && !crossed(c).length) { down[id] = c; break; }
      // or, where everything there drains back into the lake, the outlet takes over the lowest way out of the
      // lake's catchment from there: the nodes along it drain out instead (a best-first search for the path
      // whose highest node is lowest)
      if (down[id] < 0 && O2) for (const [d, e0] of cand) {
        if (d >= far || isLake(e0) || sea[e0] || crossed(e0).length) continue;
        // the outlets nearby, this one's included
        const chords = [[O2, inFace(g, e0, [0, 0])]];
        for (const o of done) {
          const en = entry.get(o), A = inFace(g, o, [0, 0]), B = A && (en ? (faceOf(o) === g ? en : null) : inFace(g, down[o], [0, 0]));
          if (B && Math.hypot(A[0] - O2[0], A[1] - O2[1]) < 12 * NS) chords.push([A, B]);
        }
        const lvl = new Map([[e0, p[e0]]]), from = new Map([[e0, -1]]), shut = new Set(), open = [e0];
        let exit = -1;
        while (open.length && shut.size < 1500) {
          let bi = 0;
          for (let i = 1; i < open.length; i++) if (lvl.get(open[i]) < lvl.get(open[bi])) bi = i;
          const c = open[bi];
          open[bi] = open[open.length - 1]; open.pop();
          if (shut.has(c)) continue;
          shut.add(c);
          if (!goesBack(c)) { exit = c; break; }
          for (let q = 0; q < 8; q++) {
            const m = nb[c * 8 + q];
            if (m < 0 || member[m] || shut.has(m)) continue;
            // a diagonal step mustn't cross a link between the square's other two corners
            if (q >= 4) { const a = nb[c * 8 + SIDE[q][0]], b = nb[c * 8 + SIDE[q][1]]; if (a < 0 || b < 0 || towards(a) === b || towards(b) === a) continue; }
            // nor any lake's outlet
            if (inFace(g, c, P1) && inFace(g, m, P2) && chords.some(([A, B]) => o3(A, B, P1) * o3(A, B, P2) < 0 && o3(P1, P2, A) * o3(P1, P2, B) < 0)) continue;
            const v = Math.max(lvl.get(c), p[m]) + (q >= 4 ? 1.4e-3 : 1e-3);
            if (!lvl.has(m) || v < lvl.get(m)) { lvl.set(m, v); from.set(m, c); open.push(m); }
          }
        }
        if (exit < 0) continue;
        for (let c = exit; from.get(c) >= 0; c = from.get(c)) { const b = from.get(c); entry.delete(b); down[b] = c; }
        down[id] = e0;
        break;
      }
    }
    if (down[id] < 0) for (const [, c] of cand) if (!goesBack(c) && !crossed(c).length) { down[id] = c; break; }
    if (down[id] < 0) {
      // every way out crosses a stream (on the coarse lattice, one running into the lake beside the outlet):
      // take the way out with fewest crossings, and those streams join the outlet instead
      let best = -1, bn = Infinity, bq = null;
      for (const [, c] of cand) {
        if (goesBack(c)) continue;
        const q = crossed(c);
        if (q.length < bn) { bn = q.length; best = c; bq = q; }
      }
      if (best >= 0) {
        down[id] = best;
        for (const q of bq) {
          if (loops(best, q)) continue;
          entry.delete(q);
          if (p[best] <= p[q]) { down[q] = best; continue; }
          // or, where that would run uphill, into the lake beside the outlet
          const F = faceOf(q), O3 = inFace(F, id, [0, 0]);
          if (!O3) continue;
          down[q] = id;
          const cnt = Math.max(2, Math.ceil(Math.hypot(O3[0] - U[q], O3[1] - V[q]) / FS));
          for (let s = 1; s < cnt; s++) {
            const x = U[q] + (O3[0] - U[q]) * s / cnt, y = V[q] + (O3[1] - V[q]) * s / cnt;
            if (inLake(F, x, y) === k) { entry.set(q, [x, y, -1]); break; }
          }
        }
      }
    }
    if (hit >= 0 && down[id] === NN + hit) entry.set(id, [x, y, -1]);   // into the next lake, at its shore
    if (down[id] < 0) sea[id] = 1;   // nowhere to go: the lake keeps its water
    else done.push(id);
  });
  const NL = NN + lakes.length;
  // a new order: every node after the one it drains into
  const dep = new Int32Array(NL).fill(-1);
  for (let n = 0; n < NL; n++) {
    if (dep[n] >= 0) continue;
    const st = [];
    let c = n;
    while (c >= 0 && dep[c] < 0 && !sea[c] && st.length < NL) { st.push(c); c = down[c]; }
    let d0 = c < 0 ? 0 : sea[c] ? (dep[c] = 0) : dep[c];
    if (d0 < 0) d0 = 0;
    for (let i = st.length - 1; i >= 0; i--) dep[st[i]] = ++d0;
  }
  const byDep = Array.from({ length: NL }, (_, i) => i).sort((a, b) => dep[a] - dep[b]);
  const ord = Int32Array.from(byDep), rank = new Int32Array(NT).fill(-1);
  ord.forEach((n, r) => { rank[n] = r; });
  flow(ord);
  const lakeMs = Date.now() - tLakes;
  yield 0.86;

  // 5. links (one per river node, to its downstream node); main[m] is the biggest river flowing into m
  const link = [];   // node ids that start a river link
  for (let n = 0; n < NL; n++) if (!sea[n] && !(n < NN && member[n]) && acc[n] >= ACC_MIN) link.push(n);
  link.sort((a, b) => rank[b] - rank[a]);   // sources before the rivers they feed
  const main = new Int32Array(NT).fill(-1);
  for (const n of link) { const m = down[n]; if (main[m] < 0 || acc[n] > acc[main[m]]) main[m] = n; }
  const halfWidth = (n) => Math.min(WCAP, 1 + 0.75 * Math.sqrt(acc[n]));

  // 6. each link's centre line: a smooth curve through the nodes (cubic Hermite, tangent at each node
  // pointing from the river above it to the river below, so a river bends gradually through a node instead
  // of turning a corner there), plus meanders from 3D noise at the world position, tapered to nothing at
  // the nodes so that every link through a node meets it on the same line.
  const curves = new Array(link.length);
  const A = [0, 0], B = [0, 0], C = [0, 0], q = [0, 0, 0];
  // level 0: curved and meandering; 1: curved, no meanders; 2: straight (used where rivers would touch)
  function build(li, level) {
    const n = link[li], F = faceOf(n), m = down[n], en = entry.get(n);
    A[0] = U[n]; A[1] = V[n];
    if (en) { B[0] = en[0]; B[1] = en[1]; } else inFace(F, m, B);   // a river into a lake ends at its shore
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]), ch = unit(B[0] - A[0], B[1] - A[1]);
    // tangent leaving n: along (m - the main river above n)
    let ta = ch, tb = ch;
    if (isLake(n)) ta = outDir[n - NN];   // a lake's outlet leaves its rim heading downhill
    else if (main[n] >= 0 && inFace(F, main[n], C)) ta = unit(B[0] - C[0], B[1] - C[1]);
    // tangent arriving at m: along the main river through m; a side river joins at a slant, half way
    // between its own direction and the main river's
    if (!en && !sea[m] && !isLake(m) && main[m] >= 0) {
      const D2 = [0, 0];
      if (inFace(F, down[m], D2) && inFace(F, main[m], C)) {
        const tm = unit(D2[0] - C[0], D2[1] - C[1]);
        tb = main[m] === n ? tm : unit(tm[0] + ch[0], tm[1] + ch[1]);
      }
    }
    // never let a tangent point back across the link (that would loop)
    if (ta[0] * ch[0] + ta[1] * ch[1] < 0.3) ta = unit(ta[0] + 2 * ch[0], ta[1] + 2 * ch[1]);
    if (tb[0] * ch[0] + tb[1] * ch[1] < 0.3) tb = unit(tb[0] + 2 * ch[0], tb[1] + 2 * ch[1]);
    if (level >= 2) { ta = ch; tb = ch; }
    const wn = halfWidth(n), amp = level >= 1 ? 0 : Math.min(L * 0.1, 80 + wn), cnt = Math.max(2, Math.ceil(L / STEP));
    const xs = new Float64Array(cnt + 1), ys = new Float64Array(cnt + 1);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k <= cnt; k++) {
      const t = k / cnt, t2 = t * t, t3 = t2 * t, s = t * L;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const d00 = 6 * t2 - 6 * t, d10 = 3 * t2 - 4 * t + 1, d01 = -6 * t2 + 6 * t, d11 = 3 * t2 - 2 * t;
      const x = h00 * A[0] + h10 * L * ta[0] + h01 * B[0] + h11 * L * tb[0];
      const y = h00 * A[1] + h10 * L * ta[1] + h01 * B[1] + h11 * L * tb[1];
      const tg = unit(d00 * A[0] + d10 * L * ta[0] + d01 * B[0] + d11 * L * tb[0], d00 * A[1] + d10 * L * ta[1] + d01 * B[1] + d11 * L * tb[1]);
      P.dir(F, x, y, q);
      const X = q[0] * P.R, Y = q[1] * P.R, Z = q[2] * P.R;
      const off = amp && (nz.n3(X / 900, Y / 900, Z / 900) * 0.6 + nz.n3(X / 260 + 9, Y / 260, Z / 260) * 0.4) * amp
        * smooth(0, 260, s) * smooth(0, 260, L - s);
      xs[k] = x - tg[1] * off; ys[k] = y + tg[0] * off;
      x0 = Math.min(x0, xs[k]); x1 = Math.max(x1, xs[k]); y0 = Math.min(y0, ys[k]); y1 = Math.max(y1, ys[k]);
    }
    curves[li] = { F, xs, ys, r: null, w: wn, L, x0, x1, y0, y1, views: [], level };
  }
  for (let li = 0; li < link.length; li++) build(li, 0);
  // a river that isn't meant to reach a lake must not wander into one: it loses its meanders, then its
  // curvature (its chord was checked above)
  const wet = (li) => {
    const c = curves[li], n = link[li], own = isLake(n) ? n - NN : -1, en = entry.has(n);
    for (let k = en ? 0 : 1; k < c.xs.length - (en ? 3 : 1); k++) {
      const l = inLake(c.F, c.xs[k], c.ys[k]);
      if (l >= 0 && !(l === own && k < 4)) return true;
    }
    return false;
  };
  for (let li = 0; li < link.length; li++) {
    if (!lakeCoarse.size) break;
    const c = curves[li];
    if (!lakeCoarse.has((c.F * KC + Math.min(KC - 1, Math.max(0, Math.floor(c.xs[c.xs.length >> 1] / CELL)))) * KC + Math.min(KC - 1, Math.max(0, Math.floor(c.ys[c.xs.length >> 1] / CELL)))) && !lakes.length) continue;
    for (let lv = 1; lv <= 2 && wet(li); lv++) build(li, lv);
  }
  // Rivers that don't meet must not touch: where two curves on one face come within their widths plus a
  // gap, both lose their meanders, then their curvature. (Their straight chords never cross.)
  const linkOf = new Int32Array(NT).fill(-1);
  link.forEach((n, li) => { linkOf[n] = li; });
  const meets = (a, b) => { const na = link[a], nb2 = link[b]; return down[na] === nb2 || down[nb2] === na || down[na] === down[nb2]; };
  let straightened = 0;
  for (let pass = 0; pass < 3; pass++) {
    const SC = 128, grid = new Map(), hit = new Set();
    curves.forEach((c, li) => {
      for (let k = 0; k < c.xs.length; k++) {
        const key = (c.F * 4096 + Math.floor(c.xs[k] / SC)) * 4096 + Math.floor(c.ys[k] / SC);
        let a = grid.get(key); if (!a) grid.set(key, (a = [])); if (a[a.length - 1] !== li) a.push(li);
      }
    });
    curves.forEach((c, li) => {
      for (let k = 0; k < c.xs.length; k++) {
        const cx = Math.floor(c.xs[k] / SC), cy = Math.floor(c.ys[k] / SC);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const a = grid.get((c.F * 4096 + cx + dx) * 4096 + cy + dy);
          if (a) for (const lj of a) {
            if (lj <= li || meets(li, lj) || (hit.has(li) && hit.has(lj))) continue;
            const o = curves[lj], gap = c.w + o.w + 8;
            for (let j = 0; j < o.xs.length; j++) {
              if (Math.abs(o.xs[j] - c.xs[k]) < gap && Math.abs(o.ys[j] - c.ys[k]) < gap && Math.hypot(o.xs[j] - c.xs[k], o.ys[j] - c.ys[k]) < gap) {
                hit.add(li); hit.add(lj); break;
              }
            }
          }
        }
      }
    });
    if (!hit.size) break;
    for (const li of hit) if (curves[li].level < 2) { build(li, curves[li].level + 1); straightened++; }
  }

  yield 0.92;
  // 7. water surface. The river fits the land: along each curve the water sits DROP below the lowest of the
  // ground at the centre line and just outside both banks, and where the ground ahead rises (a rise between
  // two dips) the river keeps the lower level and cuts through it, never being built up above the land.
  // Worked from the sources down, so a river never rises: rsN at a node is the lowest level any river
  // reaching it carries, and along a link
  //   rs = max(rsN at its end, min(rsN at its start, lowest ground so far - DROP, a gentle ramp to the end)),
  // level with the end for the last FLAT blocks, so where rivers join, their water meets at one level.
  // The network pass reads the ground every 64 blocks along each centre line (with SLACK to spare for what
  // lies between); the full profile, every 16 blocks and both banks, is read when a link is first used.
  const rsN = new Float32Array(NT), floor = new Float32Array(NL), fsrc = new Int32Array(NL);
  const low = new Float32Array(NT).fill(Infinity);
  for (let li = 0; li < link.length; li++) {
    const n = link[li], c = curves[li], cnt = c.xs.length - 1;
    for (let k = 2; k < cnt; k += 4) low[n] = Math.min(low[n], groundAt(c.F, c.xs[k], c.ys[k]) - DROP - SLACK);
  }
  for (const L of lakes) L.draw = L.wl;
  // Levels with each lake at L.draw. Nothing upstream of a lake runs below its surface; where that would
  // lift a river more than a block above its own level, the lake is lowered instead (returns true).
  function levels() {
    for (let n = 0; n < NL; n++) rsN[n] = isLake(n) ? lakes[n - NN].draw : sea[n] ? SEA : Math.max(SEA, p[n] - DROP - SLACK);
    for (let r = ord.length - 1; r >= 0; r--) {
      const n = ord[r], m = down[n];
      if (!sea[n] && !sea[m] && !isLake(m)) rsN[m] = Math.max(SEA, Math.min(rsN[m], rsN[n], low[n]));
    }
    let lowered = false;
    lakeStats.raised = 0;
    for (const n of ord) {
      const m = down[n], below = sea[n] || m < 0 ? SEA : floor[m];   // (a lake with no outlet counts as sea)
      floor[n] = isLake(n) ? Math.max(rsN[n], below) : below;
      fsrc[n] = isLake(n) && rsN[n] >= below ? n : sea[n] || m < 0 ? -1 : fsrc[m];
      // (and a lake drawn lower than one its outlet runs into: the lower one sets both, or its outlet would start above its water)
      if (!sea[n] && fsrc[n] >= 0 && (isLake(n) ? fsrc[n] !== n && floor[n] > rsN[n] : acc[n] >= ACC_MIN && floor[n] > rsN[n] + 1)) {
        const L = lakes[fsrc[n] - NN];
        L.draw = Math.min(L.draw, Math.max(SEA, Math.floor(rsN[n])));
        lowered = true; lakeStats.raised++;
      }
      rsN[n] = Math.max(rsN[n], floor[n]);
    }
    return lowered;
  }
  // (each lowering can change the levels above it: worked again until nothing is lowered)
  for (let k = 0; k < 8 && levels(); k++);
  // Nor is a lake higher than a river that runs through its water without flowing in or out (one whose
  // course was set before the lake, or that cuts across a corner of it): that river would drain it
  curves.forEach((c, li) => {
    const n = link[li], m = down[n];
    const lvl = Math.min(rsN[n], rsN[m]);
    for (let k = 0; k < c.xs.length; k++) {
      const x = c.xs[k], y = c.ys[k];
      if (x >= 0 && x < N && y >= 0 && y < N && !lakeCoarse.has((c.F * KC + Math.floor(x / CELL)) * KC + Math.floor(y / CELL))) continue;
      const l = lakeNear(c.F, x, y);
      if (l < 0 || NN + l === m || NN + l === n || lakes[l].draw <= lvl) continue;
      // (its banks too: the valley cut beside the channel would open the lake's water to air)
      const k0 = Math.max(0, k - 1), k1 = Math.min(c.xs.length - 1, k + 1), tg = unit(c.xs[k1] - c.xs[k0], c.ys[k1] - c.ys[k0]), o = c.w + 6;
      if (groundAt(c.F, x, y) < lakes[l].draw || groundAt(c.F, x - tg[1] * o, y + tg[0] * o) < lakes[l].draw || groundAt(c.F, x + tg[1] * o, y - tg[0] * o) < lakes[l].draw) {
        lakes[l].draw = Math.max(SEA, Math.floor(lvl)); lakeStats.lowered++;
      }
    }
  });
  for (let k = 0; k < 8 && levels(); k++);
  const rs = rsN;
  // links into each node
  const into = new Map();
  link.forEach((n, li) => { const m = down[n]; if (!into.has(m)) into.set(m, []); into.get(m).push(li); });
  function profile(li) {
    const n = link[li], m = down[n], c = curves[li], xs = c.xs, ys = c.ys, cnt = xs.length - 1, off = c.w + 2;
    const r = new Float32Array(cnt + 1);
    // two rivers heading for the same junction can run side by side before they get there; from where
    // their channels first touch, the water is already at the junction's level
    let joined = cnt + 1;
    for (const lj of into.get(m)) {
      if (lj === li) continue;
      const o = curves[lj], gap = c.w + o.w + 2;
      for (let k = 0; k < joined; k++) {
        let near = false;
        for (let j = 0; j < o.xs.length && !near; j++) near = Math.abs(o.xs[j] - xs[k]) < gap && Math.abs(o.ys[j] - ys[k]) < gap && Math.hypot(o.xs[j] - xs[k], o.ys[j] - ys[k]) < gap;
        if (near) { joined = k; break; }
      }
    }
    let run = rsN[n], left = false;
    for (let k = 0; k <= cnt; k++) {
      if (k >= joined) { r[k] = rsN[m]; continue; }
      const k0 = Math.max(0, k - 1), k1 = Math.min(cnt, k + 1), tg = unit(xs[k1] - xs[k0], ys[k1] - ys[k0]);
      const g = Math.min(groundAt(c.F, xs[k], ys[k]), groundAt(c.F, xs[k] - tg[1] * off, ys[k] + tg[0] * off),
        groundAt(c.F, xs[k] + tg[1] * off, ys[k] - tg[0] * off));
      // a lake's outlet stays at the lake's level until it is out of the lake's water (for good: once it has left, it never rises back)
      if (isLake(n) && !left && k < cnt && lakeNear(c.F, xs[k], ys[k]) === n - NN && g < rsN[n] + DROP) { r[k] = rsN[n]; continue; }
      if (k > 0) left = true;
      run = Math.min(run, g - DROP);
      // the last FLAT blocks before a node sit at the node's level, so rivers that join there run level
      r[k] = Math.max(rsN[m], Math.min(run, rsN[m] + Math.max(0, (1 - k / cnt) * c.L - FLAT) * 0.03));
    }
    r[0] = rsN[n]; r[cnt] = rsN[m];
    c.r = r;
  }
  // geom(li): the curve alone; curve(li): with its water surface
  const geom = (li) => curves[li];
  const curve = (li) => { if (!curves[li].r) profile(li); return curves[li]; };

  // lookup cells: every link is listed in each cell (on any face) within MARGIN of its curve
  const cells = new Map();
  const list = (f, cu, cv, li) => { const k = (f * KC + cu) * KC + cv; let a = cells.get(k); if (!a) cells.set(k, (a = [])); a.push(li); };
  for (let li = 0; li < link.length; li++) {
    const c = curves[li], F = c.F;
    const x0 = c.x0 - MARGIN, x1 = c.x1 + MARGIN, y0 = c.y0 - MARGIN, y1 = c.y1 + MARGIN;
    const reg = (f, a0, a1, b0, b1) => {
      const c0 = Math.max(0, Math.floor(a0 / CELL)), c1 = Math.min(KC - 1, Math.floor(a1 / CELL));
      const r0 = Math.max(0, Math.floor(b0 / CELL)), r1 = Math.min(KC - 1, Math.floor(b1 / CELL));
      for (let cu = c0; cu <= c1; cu++) for (let cv = r0; cv <= r1; cv++) list(f, cu, cv, li);
    };
    reg(F, x0, x1, y0, y1);
    // the parts of the box past each edge, moved onto that neighbour's grid
    for (let s = 0; s < 4; s++) {
      if ((s === 0 && x0 >= 0) || (s === 1 && x1 < N) || (s === 2 && y0 >= 0) || (s === 3 && y1 < N)) continue;
      const e = P.EDGE[F][s], g = e.g, back = P.UNFOLD[g][F];
      const cs = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [back.A[0] * x + back.A[1] * y + back.t[0], back.A[2] * x + back.A[3] * y + back.t[1]]);
      reg(g, Math.min(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[1])));
    }
  }

  // the same curve in face f's grid
  function view(li, f) {
    const c = curve(li);
    if (c.F === f) return c;
    let v = c.views[f];
    if (v) return v;
    const e = P.UNFOLD[f][c.F], A = e.A, xs = new Float64Array(c.xs.length), ys = new Float64Array(c.xs.length);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < xs.length; k++) {
      xs[k] = A[0] * c.xs[k] + A[1] * c.ys[k] + e.t[0]; ys[k] = A[2] * c.xs[k] + A[3] * c.ys[k] + e.t[1];
      x0 = Math.min(x0, xs[k]); x1 = Math.max(x1, xs[k]); y0 = Math.min(y0, ys[k]); y1 = Math.max(y1, ys[k]);
    }
    v = c.views[f] = { F: f, xs, ys, r: c.r, w: c.w, x0, x1, y0, y1 };
    return v;
  }

  // Nearest river to column (f, u, v): d, w, rs, and li (link index, -1 if none within reach).
  function at(f, u, v, out) {
    out.d = Infinity; out.w = 0; out.rs = SEA; out.li = -1;
    const a = cells.get((f * KC + Math.floor(u / CELL)) * KC + Math.floor(v / CELL));
    if (!a) return out;
    let best = Infinity;
    for (const li of a) {
      const c = view(li, f), lim = REACH + c.w;
      if (u < c.x0 - lim || u > c.x1 + lim || v < c.y0 - lim || v > c.y1 + lim) continue;
      const xs = c.xs, ys = c.ys;
      let bd = Infinity, bk = 0, bt = 0;
      for (let k = 0; k + 1 < xs.length; k++) {
        const ex = xs[k + 1] - xs[k], ey = ys[k + 1] - ys[k], px = u - xs[k], py = v - ys[k];
        const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
        const dx = px - ex * t, dy = py - ey * t, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; bk = k; bt = t; }
      }
      // nearest river, except that inside two channels at once (where rivers join) the lower water wins
      const dd = Math.sqrt(bd), r = c.r[bk] + (c.r[bk + 1] - c.r[bk]) * bt, e = dd - c.w;
      if (e < 0 && best < 0 ? r < out.rs : e < best) {
        best = Math.min(best, e);
        out.d = dd; out.w = c.w; out.li = li; out.rs = r;
      }
    }
    return out;
  }

  const stats = { lake: lakeStats, nodes: NN, links: link.length, lakes: lakes.length, bent, straightened, ms: Date.now() - t0, nodeMs: tNodes, lakeMs };
  // the water level of the lake whose cells are at or next to column (f, u, v), or -1 (the column itself
  // holds water only where its ground is below that level)
  const nearLakes = (f, u, v) => lakes.length > 0 && lakeCoarse.has((f * KC + Math.min(KC - 1, Math.floor(u / CELL))) * KC + Math.min(KC - 1, Math.floor(v / CELL)));
  const lakeAt = (f, u, v) => { const l = nearLakes(f, u, v) ? lakeNear(f, u, v) : -1; return l >= 0 ? lakes[l].draw : -1; };
  // The rim: the level of a lake whose cells are two cells from column (f, u, v) (just past where its water is drawn), or -1. Low ground
  // there, a little below the water, is raised to it (see worldgen climate3), so the water never stands against air at the edge.
  function lakeRim(f, u, v) {
    if (!nearLakes(f, u, v)) return -1;
    const cx = Math.floor(u / LC), cy = Math.floor(v / LC);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      if (dx > -2 && dx < 2 && dy > -2 && dy < 2) continue;
      const k = ckey(f, cx + dx, cy + dy), l = k < 0 ? undefined : lakeCell.get(k);
      if (l !== undefined) return lakes[l].draw;
    }
    return -1;
  }
  return { at, lakeAt, lakeRim, lakes, isLake, entry, geom, link, down, main, acc, rs, p, filled, rank, order: ord, sea, U, V, D, nb, curve, view, halfWidth, inFace, faceOf, stats, M, NS, NN };
};
})();
