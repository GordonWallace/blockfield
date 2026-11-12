// Blockfield 1.6, the realistic look: js/real/water.js. Owner: the Water thread (docs/REALISTIC_CONTRACT.md sections 6 and 7).
// Drawing only. Nothing here may run unless BF.real.on.
//
// Flowing water: the Cascade Creek shallow-water simulation and water shader, run in a window of WB x WB blocks that follows the
// player, and the same colours for the chunks' block water everywhere else. Nothing here changes a block, and the game's simulation
// never reads it: water physics stays 1.5's fluid simulation.
//
// How it meets block water (the rules; docs/REALISTIC_WATER.md has them in full):
//  1. Block water is the truth. Where the game has water blocks (sea, rivers, lakes, farm channels, wells, a poured bucket) the
//     window has water, and the level the blocks give is the level this water rests at. Farmland, swimming, buckets, boats and
//     villagers keep reading blocks.
//  2. Each column of the window is read from the blocks: its top water block (the surface) and the ground under that run of water
//     (the bed). A dry column gives only its ground, which is a bank. The window's cells (CPB a block) take their bed and their
//     rest level from their column.
//  3. A river is simulated resting at the river network's own continuous surface (BF.rivers.at, rs) instead of the blocks'
//     whole-block steps, so it runs downhill all the way. It is drawn close to the blocks' level (at most LOWER below it: boats,
//     swimmers and the player's own waterline are at the blocks' level), so each block step shows as a low riffle.
//  4. The simulation moves water between cells (virtual pipes), only ever into cells whose column has block water; every cell is
//     also pulled back towards its rest level. So a dam, a dug trench or a dropped block bends the flow and makes waves and foam, but
//     the water always settles to what the blocks say.
//  5. Inside the window the chunks' own water faces are not drawn for the water this owns (between a column's bed and its surface);
//     water under that (a cave lake under a river) and everything outside the window stays block water, drawn by the chunk meshes
//     in the same colours. The two cross-fade over the window's outer EDGE blocks.
//  6. The window is off (block water everywhere) while the view is round (high up, near the planet's cube corners) or the window
//     would straddle two faces of the planet.
//
// API (the contract's): BF.real.water.material(base) -> the material for the chunks' liquid pass; BF.real.water.frame(dt, t);
//      BF.real.splash(x, y, z, strength).
// And for the other threads (creatures, sound, boats' wakes): BF.real.water = { active, covers(x, z), depthAt(x, z), surfaceAt(x, z),
//      flowAt(x, z, out), foamAt(x, z), disturb(x, z, amount, radius), setEnabled(on), bedSource (null, or (x, z) -> the smooth
//      terrain's height or null, so the two shores agree), window, stats }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;
const RU = BF.real.U;
let RW = null;

const WB = 80, CPB = 2, N = WB * CPB, NN = N * N, CELL = 1 / CPB, V = N + 1, VV = V * V;
const SNAP = 8, MOVE = 12;      // the window moves in steps of SNAP blocks once the player is MOVE from its centre
const YUP = 16, YDN = 44, YH = YUP + YDN;   // the blocks read above and below the player's feet
const RIM = 10;                 // blocks over which the surface eases to the blocks' level at the rim
const EDGE = 5;                 // blocks of cross-fade to block water at the window's rim
const G = 9.81, NONE = -1e9, WET = 0.004, DEEP = 6;
const FILL = 1.2, EASE = 0.3, SEEP = 0.5;   // per second: towards the rest level from below / from above, and off dry columns
const WARM = 60;
const LOWER = 0.25;              // how much of a river's slope below its blocks' level is drawn (rule 3)
const HEAP = 0.6;               // water never stands more than this above its rest level (under a fall, behind a dam)
const SRC_H = 0.889;            // a source block's surface in its cell (as the mesher draws it)

// ---------- fields ----------
// per column (WB x WB): surface (rest level, NONE dry), bed, known (its chunk was loaded when read), soft (natural ground, may be smoothed)
const cSurf = new Float32Array(WB * WB).fill(NONE), cBed = new Float32Array(WB * WB), cKnown = new Uint8Array(WB * WB), cSoft = new Uint8Array(WB * WB);
const cSink = new Uint8Array(WB * WB);   // no ground in the heights read (it is further down): water that gets here is gone, not held up
const cBlk = new Float32Array(WB * WB);   // the surface as the blocks give it (cSurf differs on a river, rule 3)
const cVer = new Uint32Array(WB * WB), cTopY = new Int16Array(WB * WB), cBedY = new Int16Array(WB * WB);
// per cell (N x N)
const sink = new Uint8Array(NN);
const lift = new Float32Array(NN);   // drawn above the simulated surface by this much (rule 3)
const bed = new Float32Array(NN), tgt = new Float32Array(NN).fill(NONE), deep = new Float32Array(NN), fresh = new Uint8Array(NN).fill(1);
const d = new Float32Array(NN), fL = new Float32Array(NN), fR = new Float32Array(NN), fU = new Float32Array(NN), fD = new Float32Array(NN);
const vx = new Float32Array(NN), vz = new Float32Array(NN), foam = new Float32Array(NN), foam2 = new Float32Array(NN);
const CELLF = [lift, sink, bed, tgt, deep, d, fL, fR, fU, fD, vx, vz, foam], COLF = [cSurf, cBed, cKnown, cSoft, cVer, cTopY, cBedY, cBlk, cSink];
const tmpF = new Float32Array(NN), tmpC = new Float64Array(WB * WB);

let ox = 0, oz = 0, baseY = 0, placed = false, enabled = true, active = false, seedKey = "";
let isBed = null, isSoft = null;
const RV = {};
const stats = { scans: 0, wet: 0, stray: 0, stepMs: 0, meshMs: 0 };

function tables() {
  const n = BF.blocks.length;
  isBed = new Uint8Array(n + 1); isSoft = new Uint8Array(n + 1);
  const SOFT = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|sand|red_sand|gravel|stone|deepslate|andesite|diorite|granite|tuff|sandstone|red_sandstone|snow_block|terracotta|.*_terracotta|moss_block|dirt_path)$/;
  for (const b of BF.blocks) {
    if (!b || !b.id) continue;
    const r = BF.RENDER[b.id];
    isBed[b.id] = BF.SOLID[b.id] && (r === 1 || r === 2) && !/leaves$/.test(b.name) ? 1 : 0;
    isSoft[b.id] = SOFT.test(b.name) ? 1 : 0;
  }
}

// ---------- reading the blocks ----------
// Reads column (i, j) of the window. Returns true when what it holds changed.
function scanColumn(i, j) {
  const W = BF.world, x = ox + i, z = oz + j, q = i + j * WB, FL = BF.FLUID;
  const c = W.chunkAt(x, z);
  const pS = cSurf[q], pB = cBed[q], pK = cKnown[q];
  stats.scans++;
  if (!c) { cSurf[q] = NONE; cBed[q] = baseY + YH; cKnown[q] = 0; cSoft[q] = 0; cSink[q] = 0; cTopY[q] = cBedY[q] = 0; cVer[q] = 0; return pK !== 0; }
  cVer[q] = c.colVer[((z - c.cz * 16) << 4) | (x - c.cx * 16)] + 1;
  let surf = NONE, blk = 0, bedH = NONE, soft = 0, topY = 0, bedY = 0, cover = -1, air = false;
  const get = W.getBlock;
  for (let y = baseY + YH - 1; y >= baseY; y--) {
    const id = get(x, y, z), f = FL[id];
    if (surf === NONE) {
      if (f) {
        if (cover >= 0 && !air) { bedH = cover + 1; break; }          // water sealed right under ground: not this column's surface
        surf = blk = y + (f === 8 ? SRC_H : (8 - f) / 9); topY = y;
        if (f === 8 && BF.rivers && y >= BF.SEA) {
          // a river's own surface instead of the blocks' step (rule 3): within the top block, never above the blocks' level
          let hit = false;
          try { hit = BF.rivers.at(x, z, RV); } catch (_) { hit = false; }
          if (hit && RV.rs >= BF.SEA && Math.floor(RV.rs) === y && RV.d < RV.w + 6) surf = y + SRC_H - 1 + (RV.rs - y);
        }
        continue;
      }
      if (isBed[id]) {
        if (cover < 0) { cover = y; soft = isSoft[id]; }
        else if (y < cover - 7 || !air) { bedH = cover + 1; break; }   // solid ground: no open water under a roof or a bridge here
      } else if (cover >= 0) air = true;
    } else if (!f) {
      if (isBed[id] || y === baseY) { bedH = y + 1; bedY = y + 1; soft = isSoft[id]; break; }
    }
  }
  if (surf !== NONE && bedH === NONE) { bedH = baseY; bedY = baseY; }      // water deeper than the window reads
  const pSink = cSink[q];
  cSink[q] = surf === NONE && cover < 0 && bedH === NONE ? 1 : 0;
  if (surf === NONE) bedH = cover >= 0 ? cover + 1 : bedH === NONE ? baseY : bedH;
  if (surf !== NONE && surf - bedH < 0.12) surf = bedH + 0.12;
  if (surf === NONE || blk < surf) blk = surf;
  cSurf[q] = surf; cBed[q] = bedH; cKnown[q] = 1; cSoft[q] = soft; cBlk[q] = blk;
  cTopY[q] = surf === NONE ? 0 : topY + 1 - baseY; cBedY[q] = surf === NONE ? 0 : Math.max(0, bedY - baseY);
  if (!pK) for (let b = 0; b < CPB; b++) for (let a = 0; a < CPB; a++) fresh[i * CPB + a + (j * CPB + b) * N] = 1;   // just loaded: starts at rest
  return surf !== pS || bedH !== pB || !pK || pSink !== cSink[q];
}

// Cells of columns [i0, i1] x [j0, j1] from their columns (and the columns around them, where the ground is smoothed).
function buildCells(i0, j0, i1, j1) {
  const src = RW.bedSource;
  i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(WB - 1, i1); j1 = Math.min(WB - 1, j1);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const q = i + j * WB, s = cSurf[q], b0 = cBed[q];
    for (let b = 0; b < CPB; b++) for (let a = 0; a < CPB; a++) {
      const ci = i * CPB + a, cj = j * CPB + b, k = ci + cj * N;
      let h = b0;
      if (src) {
        // the realistic terrain's own height (natural ground only): the shore is where that ground meets the water
        const g = cSoft[q] ? src(ox + (ci + 0.5) * CELL, oz + (cj + 0.5) * CELL) : null;
        if (g != null && isFinite(g)) h = g;
      }
      let t = s;
      if (t === NONE && src) {
        // smoothed ground can dip under a neighbouring column's water: that water reaches in
        const ni = a ? i + 1 : i - 1, nj = b ? j + 1 : j - 1;
        let best = NONE;
        if (ni >= 0 && ni < WB && cSurf[ni + j * WB] > best) best = cSurf[ni + j * WB];
        if (nj >= 0 && nj < WB && cSurf[i + nj * WB] > best) best = cSurf[i + nj * WB];
        if (best !== NONE && best > h + 0.02) t = best;
      }
      let dp = 0;
      if (t !== NONE && t - h > DEEP) { dp = t - h - DEEP; h = t - DEEP; }   // deep water is simulated as DEEP deep (waves stay slow enough to step)
      bed[k] = h; tgt[k] = t; deep[k] = dp; sink[k] = cSink[q];
      lift[k] = s !== NONE && cBlk[q] > s ? (cBlk[q] - s) * (1 - LOWER) : 0;
      if (fresh[k]) {
        fresh[k] = 0;
        d[k] = t !== NONE && t > h ? t - h : 0;
        fL[k] = fR[k] = fU[k] = fD[k] = vx[k] = vz[k] = foam[k] = 0;
      }
    }
  }
  ownDirty = true;
}

// ---------- the window ----------
const chunkSeen = new Map();   // chunk key -> [chunk, ver]
function place(px, py, pz, force) {
  const nx = Math.round((px - WB / 2) / SNAP) * SNAP, nz = Math.round((pz - WB / 2) / SNAP) * SNAP;
  const cx = ox + WB / 2, cz = oz + WB / 2;
  const far = !placed || Math.abs(px - cx) > MOVE || Math.abs(pz - cz) > MOVE;
  const yOff = py - (baseY + YDN), yMove = !placed || yOff > 9 || yOff < -9;
  if (!force && !far && !yMove) return;
  const dx = placed && !force ? nx - ox : WB, dz = placed && !force ? nz - oz : WB;
  const whole = force || !placed || Math.abs(dx) >= WB || Math.abs(dz) >= WB;
  if (far || whole) {
    if (whole) { fresh.fill(1); cKnown.fill(0); cSurf.fill(NONE); cVer.fill(0); }
    else if (dx || dz) shift(dx, dz);
    ox = nx; oz = nz;
  }
  if (yMove || whole) baseY = Math.floor(py) - YDN;
  placed = true;
  chunkSeen.clear();
  // read every column whose content isn't known for this placement (all of them when the heights read changed)
  for (let j = 0; j < WB; j++) for (let i = 0; i < WB; i++) if (yMove || whole || !cKnown[i + j * WB]) scanColumn(i, j);
  buildCells(0, 0, WB - 1, WB - 1);
  mesh.position.set(ox, baseY, oz); mesh.updateMatrix();
  if (whole) for (let q = 0; q < WARM; q++) simStep(0.03);   // a fresh window: rivers already running, not starting from rest
}
// Moves what the window holds by (-dx, -dz) blocks; the columns and cells that come in are marked unknown / fresh.
function shift(dx, dz) {
  const mv = (a, n, per, T, fillV) => {
    T.set(a);
    const sx = dx * per, sz = dz * per;
    for (let j = 0; j < n; j++) {
      const sj = j + sz;
      for (let i = 0; i < n; i++) { const si = i + sx; a[i + j * n] = si >= 0 && si < n && sj >= 0 && sj < n ? T[si + sj * n] : fillV; }
    }
  };
  for (const a of CELLF) mv(a, N, CPB, tmpF, 0);
  for (const a of COLF) mv(a, WB, 1, tmpC, 0);
  for (let j = 0; j < WB; j++) for (let i = 0; i < WB; i++) {
    const si = i + dx, sj = j + dz, inb = si >= 0 && si < WB && sj >= 0 && sj < WB;
    if (inb) continue;
    cKnown[i + j * WB] = 0; cSurf[i + j * WB] = NONE;
    for (let b = 0; b < CPB; b++) for (let a = 0; a < CPB; a++) fresh[i * CPB + a + (j * CPB + b) * N] = 1;
  }
}
// Columns whose blocks changed since they were read (chunk.ver / colVer, js/world.js), or whose chunk has come or gone.
function refresh() {
  const W = BF.world;
  let i0 = WB, j0 = WB, i1 = -1, j1 = -1, budget = 1600;
  for (let cz = oz >> 4; cz <= (oz + WB - 1) >> 4; cz++) for (let cx = ox >> 4; cx <= (ox + WB - 1) >> 4; cx++) {
    const c = W.chunkAt(cx * 16, cz * 16), key = cx + "," + cz, seen = chunkSeen.get(key);
    if (seen && seen[0] === c && (!c || seen[1] === c.ver)) continue;
    let all = true;
    const a0 = Math.max(0, cx * 16 - ox), a1 = Math.min(WB - 1, cx * 16 + 15 - ox), b0 = Math.max(0, cz * 16 - oz), b1 = Math.min(WB - 1, cz * 16 + 15 - oz);
    for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) {
      const q = i + j * WB;
      const now = c ? c.colVer[((oz + j - cz * 16) << 4) | (ox + i - cx * 16)] + 1 : 0;
      if (cKnown[q] === (c ? 1 : 0) && cVer[q] === now) continue;
      if (budget <= 0) { all = false; continue; }
      budget--;
      if (scanColumn(i, j)) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    }
    if (all) chunkSeen.set(key, [c, c ? c.ver : 0]);
  }
  if (i1 >= 0) buildCells(i0 - 1, j0 - 1, i1 + 1, j1 + 1);
}

// ---------- the simulation (virtual pipes, as Cascade Creek's) ----------
function simStep(dt) {
  const A = dt * G * CELL, cc = CELL * CELL;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = i + j * N, dk = d[k];
    if (dk <= 1e-5 && fL[k] === 0 && fR[k] === 0 && fU[k] === 0 && fD[k] === 0) continue;
    const h = bed[k] + dk, damp = 1 / (1 + dt * (0.06 + 0.11 / (dk + 0.08)));
    // water only moves into cells the blocks give water (rule 1): never out over a bank or a lip the block water itself doesn't cross
    let l = i > 0 && tgt[k - 1] !== NONE ? fL[k] * damp + A * (h - bed[k - 1] - d[k - 1]) : 0, r = i < N - 1 && tgt[k + 1] !== NONE ? fR[k] * damp + A * (h - bed[k + 1] - d[k + 1]) : 0;
    let u = j > 0 && tgt[k - N] !== NONE ? fU[k] * damp + A * (h - bed[k - N] - d[k - N]) : 0, dn = j < N - 1 && tgt[k + N] !== NONE ? fD[k] * damp + A * (h - bed[k + N] - d[k + N]) : 0;
    if (l < 0) l = 0; if (r < 0) r = 0; if (u < 0) u = 0; if (dn < 0) dn = 0;
    const sum = l + r + u + dn;
    if (sum > 0) { const K = dk * cc / (sum * dt); if (K < 1) { l *= K; r *= K; u *= K; dn *= K; } }
    fL[k] = l; fR[k] = r; fU[k] = u; fD[k] = dn;
  }
  const s = dt / cc, kf = Math.min(1, FILL * dt), ke = Math.min(1, EASE * dt), ks = Math.min(1, SEEP * dt);
  let wet = 0, stray = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = i + j * N;
    const inL = i > 0 ? fR[k - 1] : 0, inR = i < N - 1 ? fL[k + 1] : 0, inU = j > 0 ? fD[k - N] : 0, inD = j < N - 1 ? fU[k + N] : 0;
    const out = fL[k] + fR[k] + fU[k] + fD[k], tot = inL + inR + inU + inD, t = tgt[k];
    let nd = d[k];
    if (out === 0 && tot === 0) { vx[k] *= 0.9; vz[k] *= 0.9; }
    else {
      nd += s * (tot - out); if (nd < 0) nd = 0;
      const da = Math.max(0.5 * (d[k] + nd), 0.04) * CELL * 2;
      let ux = (inL - fL[k] + fR[k] - inR) / da, uz = (inU - fU[k] + fD[k] - inD) / da;
      const sp = ux * ux + uz * uz;
      if (sp > 16) { const q = 4 / Math.sqrt(sp); ux *= q; uz *= q; }
      vx[k] = ux; vz[k] = uz;
    }
    // back towards what the blocks say (rule 4)
    if (t !== NONE) { const want = t - bed[k]; nd += (want - nd) * (nd < want ? kf : ke); if (nd > want + HEAP) nd = want + HEAP; if (nd < 0) nd = 0; }
    else if (nd > 0) { nd -= nd * ks + 0.02 * dt; if (nd < 0) nd = 0; if (nd > WET) stray++; }
    if (sink[k]) nd = 0;   // over the edge of what is read: it falls out of the picture
    if (i < 2 || j < 2 || i > N - 3 || j > N - 3) nd = t !== NONE && t > bed[k] ? t - bed[k] : 0;   // the rim is held at rest: water comes and goes through it
    d[k] = nd;
    if (nd > WET) wet++;
  }
  stats.wet = wet; stats.stray = stray;
}

// ---------- the mesh ----------
// Vertices sit on cell corners (so on block edges and block centres): water fills a one-block channel between cubes exactly. A corner
// takes the mean of the wet cells round it; a quad is drawn where its corners carry water, so the surface runs a little way under a bank.
const wPos = new Float32Array(VV * 3), wNor = new Float32Array(VV * 3), wDepth = new Float32Array(VV), wVel = new Float32Array(VV * 2), wFoam = new Float32Array(VV);
for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) { const q = i + j * V; wPos[q * 3] = i * CELL; wPos[q * 3 + 2] = j * CELL; wNor[q * 3 + 1] = 1; }
const idx = new Uint32Array(N * N * 6);
{ let q = 0; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = i + j * V, b = a + 1, c = a + V, e = c + 1; idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = e; } }
const geo = new THREE.BufferGeometry();
geo.setIndex(new THREE.BufferAttribute(idx, 1));
const aPos = new THREE.BufferAttribute(wPos, 3), aNor = new THREE.BufferAttribute(wNor, 3), aDepth = new THREE.BufferAttribute(wDepth, 1),
  aVel = new THREE.BufferAttribute(wVel, 2), aFoam = new THREE.BufferAttribute(wFoam, 1);
for (const a of [aPos, aNor, aDepth, aVel, aFoam]) a.setUsage(THREE.DynamicDrawUsage);
geo.setAttribute("position", aPos); geo.setAttribute("normal", aNor); geo.setAttribute("aDepth", aDepth); geo.setAttribute("aVel", aVel); geo.setAttribute("aFoam", aFoam);
geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(WB / 2, YH / 2, WB / 2), WB);

function hash2(x, y) { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; }
function tileNoise(S, baseP, oct) {
  const o = new Float32Array(S * S); let amp = 0.5, P = baseP;
  for (let q = 0; q < oct; q++) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / S * P, fy = y / S * P, xi = Math.floor(fx), yi = Math.floor(fy), xf = fx - xi, yf = fy - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash2(xi % P + q * 71, yi % P), b = hash2((xi + 1) % P + q * 71, yi % P), c = hash2(xi % P + q * 71, (yi + 1) % P), e = hash2((xi + 1) % P + q * 71, (yi + 1) % P);
      o[x + y * S] += amp * (a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v);
    }
    amp *= 0.5; P *= 2;
  }
  return o;
}
function makeNoise() {
  const S = 256, hN = tileNoise(S, 6, 5), fN = tileNoise(S, 12, 4), nd = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = x + y * S, xl = hN[(x + S - 1) % S + y * S], xr = hN[(x + 1) % S + y * S], yu = hN[x + ((y + S - 1) % S) * S], yd = hN[x + ((y + 1) % S) * S];
    nd[k * 4] = Math.max(0, Math.min(255, 128 + (xl - xr) * 1400)); nd[k * 4 + 1] = Math.max(0, Math.min(255, 128 + (yu - yd) * 1400));
    nd[k * 4 + 2] = Math.max(0, Math.min(255, (fN[k] - 0.2) * 1.7 * 255)); nd[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(nd, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}
const noiseTex = makeNoise();

// What both water shaders share: the sky a ripple reflects, the water's own colour and the foam. Light, sky and fog come from the
// look's shared uniforms (BF.real.U). The texture scales are multiples of 1 / SNAP, so the pattern doesn't jump when the window moves.
const U = {
  uRwTime: { value: 0 }, uRwNoise: { value: noiseTex }, uRwOn: { value: 0 }, uRwOrg: { value: new THREE.Vector3() }, uRwOwn: { value: null },
  uSunDir: RU.uSunDir, uSunCol: RU.uSunCol, uSkyCol: RU.uSkyCol, uFogCol: RU.uFogCol, uFogNear: RU.uFogNear, uFogFar: RU.uFogFar, uDay: RU.uDay,
};
const GLSL_DAY = "uniform float uDay;\n", GLSL_COMMON = `
uniform float uRwTime, uFogNear, uFogFar; uniform sampler2D uRwNoise; uniform vec3 uSunDir, uSunCol, uSkyCol, uFogCol;
vec3 rwSky(vec3 r) { float y = clamp(r.y, 0.0, 1.0); return mix(uFogCol * 0.9, uSkyCol * vec3(0.55, 0.75, 1.1), pow(y, 0.55)); }
// Nn: surface normal; Vd: towards the eye; lit: how much sky reaches the water (0 in a cave)
vec3 rwShade(vec3 Nn, vec3 Vd, float depth, float foamAmt, float foamNoise, float lit, out float alpha) {
  float up = step(0.0, Vd.y);                      // 0: seen from under the surface
  vec3 Nv = mix(-Nn, Nn, up);
  vec3 R = reflect(-Vd, Nv); R.y = abs(R.y);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(Nv, Vd), 0.0), 5.0);
  float sd = max(dot(R, uSunDir), 0.0);
  vec3 refl = (rwSky(R) + uSunCol * (pow(sd, 700.0) * 6.0 + pow(sd, 60.0) * 0.1)) * lit;
  vec3 T = exp(-depth * vec3(2.4, 1.05, 1.35) * 0.55);
  vec3 body = vec3(0.018, 0.075, 0.06) * (0.25 + 0.75 * max(uSunDir.y, 0.0)) * max(lit * uDay, 0.04);
  vec3 col = mix(body, refl, F * mix(0.35, 1.0, up));
  alpha = mix(1.0 - dot(T, vec3(0.3333)) * 0.95, 1.0, F);
  alpha = mix(min(alpha, 0.55), alpha, up);
  float fo = smoothstep(0.78 - foamAmt * 0.75, 0.98 - foamAmt * 0.55, foamNoise) * step(0.03, foamAmt);
  vec3 foamC = vec3(0.86, 0.9, 0.9) * (0.2 * uSkyCol + uSunCol * 0.3 * (0.4 + 0.6 * max(dot(Nn, uSunDir), 0.0))) * lit;
  col = mix(col, foamC, fo); alpha = max(alpha, fo * 0.92);
  return col;
}`;
const mat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: U,
  vertexShader: `attribute float aDepth; attribute vec2 aVel; attribute float aFoam;
varying vec3 vW; varying vec3 vL; varying vec3 vN; varying float vDepth; varying vec2 vVel; varying float vFoam;
void main() { vN = normal; vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vDepth = aDepth; vVel = aVel; vFoam = aFoam; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: GLSL_DAY + GLSL_COMMON + `
varying vec3 vW; varying vec3 vL; varying vec3 vN; varying float vDepth; varying vec2 vVel; varying float vFoam;
void main() {
  if (vDepth <= 0.0) discard;
  float sp = length(vVel);
  float p0 = fract(uRwTime * 0.5), p1 = fract(uRwTime * 0.5 + 0.5), w = abs(1.0 - 2.0 * p0);
  vec2 xz = vL.xz, uv = xz * 0.25, uv2 = xz * 0.875;
  // still water still moves a little: a slow drift of the two ripple layers against each other
  vec2 dr = vec2(uRwTime * 0.012, uRwTime * 0.007);
  vec4 a0 = texture2D(uRwNoise, uv - vVel * p0 * 0.42 + dr), a1 = texture2D(uRwNoise, uv + 0.37 - vVel * p1 * 0.42 + dr);
  vec4 b0 = texture2D(uRwNoise, uv2 - vVel * p0 * 1.66 - dr * 1.7), b1 = texture2D(uRwNoise, uv2 + 0.61 - vVel * p1 * 1.66 - dr * 1.7);
  // moving water: two phases of each layer carried by the flow, swapped as they stretch; still water: the layers as they are
  // (the same picture the chunks' block water draws, so the two meet without a seam)
  float mv = smoothstep(0.03, 0.3, sp);
  vec4 a = mix(texture2D(uRwNoise, uv + dr), mix(a0, a1, w), mv), b = mix(texture2D(uRwNoise, uv2 - dr * 1.7), mix(b0, b1, w), mv);
  vec2 n = (a.xy - 0.5) * 2.0 + (b.xy - 0.5) * 1.2;
  float e = min(min(vL.x, vL.z), min(${WB}.0 - vL.x, ${WB}.0 - vL.z));
  // towards the rim the flow's roughness eases to still water's, which is what the chunks' block water beyond it draws
  float st = 0.07 + 0.42 * clamp(sp, 0.0, 2.2) * smoothstep(${EDGE}.0, ${EDGE + 14}.0, e);
  vec4 c0 = texture2D(uRwNoise, xz * 3.0 - vVel * p0 * 5.8), c1 = texture2D(uRwNoise, xz * 3.0 + 0.23 - vVel * p1 * 5.8);
  vec4 c = mix(texture2D(uRwNoise, xz * 3.0), mix(c0, c1, w), mv);
  vec2 n3 = c.xy - 0.5;
  vec3 Nn = normalize(normalize(vN) * vec3(1.5, 1.0, 1.5) + vec3((n.x + n3.x * 1.4) * st, 0.0, (n.y + n3.y * 1.4) * st));
  vec3 Vd = normalize(-vW);                        // render space: the eye is the origin
  float fn = b.z * 0.45 + a.z * 0.3 + c.z * 0.25, alpha;
  vec3 col = rwShade(Nn, Vd, vDepth, vFoam, fn, 1.0, alpha);
  alpha *= smoothstep(0.0, 0.03, vDepth);
  // cross-fade to the chunks' block water at the window's rim (rule 5)
  alpha *= smoothstep(1.0, ${EDGE}.0, e);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogCol, smoothstep(uFogNear, uFogFar, length(vW)));
}`,
});
const mesh = new THREE.Mesh(geo, mat);
mesh.renderOrder = 2; mesh.matrixAutoUpdate = false; mesh.visible = false; mesh.frustumCulled = false;

function updateMesh(dt) {
  // foam, per cell: made where the water is fast for its depth, shears or drops; carried by the flow; fading
  const dec = Math.exp(-dt / 2.4), adv = dt / CELL;
  foam2.set(foam);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = i + j * N, dk = d[k];
    if (dk <= WET) { foam[k] = foam2[k] * 0.9; continue; }
    const sp = Math.sqrt(vx[k] * vx[k] + vz[k] * vz[k]), fr = sp / Math.sqrt(G * Math.max(dk, 0.03));
    let f = (fr - 0.5) * 1.5, a = 0; if (f < 0) f = 0;
    if (i > 0 && i < N - 1 && j > 0 && j < N - 1) {
      // (a dry neighbour, a bank, counts as this cell: a bank is not a shear line or a drop, or every shore would be a white strip)
      const a1 = d[k + 1] > WET ? k + 1 : k, a0 = d[k - 1] > WET ? k - 1 : k, b1 = d[k + N] > WET ? k + N : k, b0 = d[k - N] > WET ? k - N : k;
      const sh = Math.abs(vx[a1] - vx[a0]) + Math.abs(vz[b1] - vz[b0]) + Math.abs(vx[b1] - vx[b0]) + Math.abs(vz[a1] - vz[a0]);
      if (sh > 0.7) f += (sh - 0.7) * 0.5;
      const hd = Math.abs(bed[a1] + d[a1] + lift[a1] - bed[a0] - d[a0] - lift[a0]) + Math.abs(bed[b1] + d[b1] + lift[b1] - bed[b0] - d[b0] - lift[b0]);
      if (hd > 0.12 && sp > 0.3) f += (hd - 0.12) * 2.5;
      let fx = i - vx[k] * adv, fz = j - vz[k] * adv;
      if (fx < 0) fx = 0; else if (fx > N - 1.001) fx = N - 1.001; if (fz < 0) fz = 0; else if (fz > N - 1.001) fz = N - 1.001;
      const ii = fx | 0, jj = fz | 0, u = fx - ii, v = fz - jj, kk = ii + jj * N;
      a = (foam2[kk] * (1 - u) + foam2[kk + 1] * u) * (1 - v) + (foam2[kk + N] * (1 - u) + foam2[kk + N + 1] * u) * v;
    }
    if (f > 1) f = 1; f *= Math.min(1, dk * 12);
    const cur = a * dec; foam[k] = cur > f ? cur : cur + (f - cur) * 0.2;
  }
  // corners
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const q = i + j * V;
    let n = 0, sy = 0, sd = 0, sx = 0, sz = 0, sf = 0, lo = 1e9;
    for (let b = j - 1; b <= j; b++) {
      if (b < 0 || b >= N) continue;
      for (let a = i - 1; a <= i; a++) {
        if (a < 0 || a >= N) continue;
        const k = a + b * N, dk = d[k];
        if (bed[k] < lo) lo = bed[k];
        if (dk <= WET) continue;
        n++; sy += bed[k] + dk + lift[k]; sd += dk + deep[k]; sx += vx[k]; sz += vz[k]; sf += foam[k];
      }
    }
    if (n) {
      const r = 1 / n;
      let y = sy * r;
      // at the rim the surface eases to the level the blocks draw, so it meets the chunks' water (a river's blocks sit up to a block higher)
      const e = Math.min(i, j, N - i, N - j) * CELL;
      if (e < RIM) {
        const c = cBlk[Math.min(WB - 1, i >> 1) + Math.min(WB - 1, j >> 1) * WB];
        if (c !== NONE && c > y) { const t = e <= 1 ? 1 : 1 - (e - 1) / (RIM - 1); y += (c - y) * t * t * (3 - 2 * t); }
      }
      wPos[q * 3 + 1] = y - baseY; wDepth[q] = sd * r; wVel[q * 2] = sx * r; wVel[q * 2 + 1] = sz * r; wFoam[q] = sf * r;
    } else { wPos[q * 3 + 1] = lo - 0.05 - baseY; wDepth[q] = -0.4; wVel[q * 2] = wVel[q * 2 + 1] = 0; wFoam[q] = 0; }
  }
  // a dry corner next to wet ones sits at their level, so the surface meets a bank or a cube wall level instead of diving
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const q = i + j * V;
    if (wDepth[q] > 0) continue;
    let n = 0, sy = 0;
    if (i > 0 && wDepth[q - 1] > 0) { sy += wPos[(q - 1) * 3 + 1]; n++; }
    if (i < V - 1 && wDepth[q + 1] > 0) { sy += wPos[(q + 1) * 3 + 1]; n++; }
    if (j > 0 && wDepth[q - V] > 0) { sy += wPos[(q - V) * 3 + 1]; n++; }
    if (j < V - 1 && wDepth[q + V] > 0) { sy += wPos[(q + V) * 3 + 1]; n++; }
    if (n) { wPos[q * 3 + 1] = sy / n; wDepth[q] = -0.02; }
  }
  for (let j = 1; j < V - 1; j++) for (let i = 1; i < V - 1; i++) {
    const q = i + j * V;
    if (wDepth[q] <= 0) { wNor[q * 3] = 0; wNor[q * 3 + 1] = 1; wNor[q * 3 + 2] = 0; continue; }
    let hx = wPos[(q + 1) * 3 + 1] - wPos[(q - 1) * 3 + 1], hz = wPos[(q + V) * 3 + 1] - wPos[(q - V) * 3 + 1];
    if (wDepth[q + 1] <= -0.1 || wDepth[q - 1] <= -0.1) hx = 0; if (wDepth[q + V] <= -0.1 || wDepth[q - V] <= -0.1) hz = 0;
    if (hx > 0.5) hx = 0.5; else if (hx < -0.5) hx = -0.5; if (hz > 0.5) hz = 0.5; else if (hz < -0.5) hz = -0.5;
    const l = 1 / Math.sqrt(hx * hx + hz * hz + 4 * CELL * CELL);
    wNor[q * 3] = -hx * l; wNor[q * 3 + 1] = 2 * CELL * l; wNor[q * 3 + 2] = -hz * l;
  }
  aPos.needsUpdate = aNor.needsUpdate = aDepth.needsUpdate = aVel.needsUpdate = aFoam.needsUpdate = true;
}

// ---------- the chunks' block water (rules 5 and 6) ----------
// Which water the window owns, for the chunk liquid shader: per column, the top of its surface block and its bed, in blocks above baseY.
const ownData = new Uint8Array(WB * WB * 4);
const ownTex = new THREE.DataTexture(ownData, WB, WB, THREE.RGBAFormat);
ownTex.minFilter = ownTex.magFilter = THREE.NearestFilter;
U.uRwOwn.value = ownTex;
let ownDirty = true;
function updateOwn() {
  ownDirty = false;
  for (let q = 0; q < WB * WB; q++) {
    const own = cKnown[q] && cSurf[q] !== NONE;
    ownData[q * 4] = own ? Math.min(255, cTopY[q]) : 0; ownData[q * 4 + 1] = own ? Math.min(255, cBedY[q]) : 0; ownData[q * 4 + 3] = own ? 255 : 0;
  }
  ownTex.needsUpdate = true;
}
// The chunks' liquid material (the contract's BF.real.water.material): js/world.js's own, with the same colours as the flowing water
// (the block water beyond the window, under it and on the round planet), and not drawing the water the window owns.
// Sky light and block light still dim it (a cave pool is dark; a torch warms it).
let liquid = null, liquidBase = null;
function material(base) {
  if (liquid && liquidBase === base) return liquid;
  liquidBase = base;
  liquid = base.clone();
  liquid.userData.realWater = true;
  const inner = base.onBeforeCompile;
  liquid.onBeforeCompile = (sh, r) => {
    if (inner) inner(sh, r);
    for (const k of Object.keys(U)) sh.uniforms[k] = U[k];
    sh.vertexShader = "varying vec3 vRwPos;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\nvRwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = "varying vec3 vRwPos;\nuniform float uRwOn; uniform vec3 uRwOrg; uniform sampler2D uRwOwn;\n" + GLSL_DAY + GLSL_COMMON + "\n" +
      sh.fragmentShader.replace("uniform float uDay;", "").replace("#include <color_fragment>", `#include <color_fragment>
float rwLit = diffuseColor.r;   // (set below)
{
  // the game's own light, as a factor: open sky by day 1, a cave pool nearly 0, torchlight in between
  float sk = clamp(vSky * (0.6 + 0.4 * smoothstep(0.3, 0.7, vSky)), 0.0, 1.0);
  rwLit = max(sk, 0.6 * min(1.0, 1.1 * pow(clamp(vBl, 0.0, 1.0), 1.25)));
}
if (uRwOn > 0.5) {
  vec3 q = vRwPos - uRwOrg;
  float e = min(min(q.x, q.z), min(${WB}.0 - q.x, ${WB}.0 - q.z));
  if (e > 1.0) {
    // a face on the edge of a column belongs to the columns on both sides of it: owned if either owns its height
    bool own = false;
    for (int t = 0; t < 4; t++) {
      vec2 off = vec2(t == 0 || t == 2 ? -0.03 : 0.03, t < 2 ? -0.03 : 0.03);
      vec4 o = texture2D(uRwOwn, (q.xz + off) / ${WB}.0);
      if (o.a > 0.5 && q.y <= o.r * 255.0 + 0.03 && q.y >= o.g * 255.0 - 0.03) own = true;
    }
    if (own) {
      float keep = 1.0 - smoothstep(1.0, ${EDGE}.0, e);
      if (keep < 0.02) discard;
      diffuseColor.a *= keep;
    }
  }
}`).replace("#include <tonemapping_fragment>", `{
  vec3 Vd = normalize(-vRwPos);
  vec3 P = vRwPos - uRwOrg;
  vec2 dr = vec2(uRwTime * 0.012, uRwTime * 0.007);
  vec2 n = (texture2D(uRwNoise, P.xz * 0.25 + dr).xy - 0.5) * 2.0 + (texture2D(uRwNoise, P.xz * 0.875 - dr * 1.7).xy - 0.5) * 1.2;
  vec3 Ng = normalize(cross(dFdx(vRwPos), dFdy(vRwPos)));
  float flat_ = smoothstep(0.5, 0.9, abs(Ng.y));
  vec2 n3 = texture2D(uRwNoise, P.xz * 3.0).xy - 0.5;
  vec3 Nn = normalize(vec3((n.x + n3.x * 1.4) * 0.07, 1.0, (n.y + n3.y * 1.4) * 0.07));
  float alpha;
  vec3 col = rwShade(Nn, Vd, 1.6, 0.0, 0.0, rwLit, alpha);
  // falling water and the sides of a body of water: its own colour, a little sky
  vec3 side = vec3(0.018, 0.075, 0.06) * max(rwLit * uDay, 0.04) + rwSky(vec3(0.0, 0.4, 0.0)) * rwLit * 0.22;
  gl_FragColor = vec4(mix(side, col, flat_), mix(0.78, alpha, flat_) * (diffuseColor.a / 0.75));
}
#include <tonemapping_fragment>`);
  };
  liquid.customProgramCacheKey = () => "bfreal-water";
  return liquid;
}

// ---------- each frame ----------
let tSim = 0;
function frame(dtReal) {
  const P = BF.player, W = BF.world, cam = BF.camera;
  dtReal = Math.min(0.05, Math.max(0, dtReal || 0));
  let on = enabled && !!(P && P.position && W && W.chunkAt && BF.blocks && cam);
  const pp = on ? (P.viewPos ? P.viewPos() : P.position) : null;
  if (on) {
    // rule 6: flat drawing only, one face of the planet
    const k = BF.view && BF.view.kAt ? BF.view.kAt(pp.x, pp.y, pp.z) : 0;
    if (k > 0) on = false;
    else if (BF.planet) {
      const f = BF.planet.face(pp.x, pp.z), h = WB / 2 + SNAP + 2;
      if (f < 0 || BF.planet.face(pp.x - h, pp.z - h) !== f || BF.planet.face(pp.x + h, pp.z + h) !== f || BF.planet.face(pp.x - h, pp.z + h) !== f || BF.planet.face(pp.x + h, pp.z - h) !== f) on = false;
    }
  }
  active = RW.active = on;
  mesh.visible = on;
  U.uRwOn.value = on ? 1 : 0;
  const frozen = BF.state.paused || (BF.warp && BF.warp.frozen);
  const dt = frozen ? 0 : dtReal;
  tSim = (tSim + dt) % 3600;
  U.uRwTime.value = tSim;
  if (!on) { placed = false; return; }
  if (!mesh.parent) BF.scene.add(mesh);
  if (!isBed) tables();
  const key = String(BF.state.seed);
  const t0 = performance.now();
  place(pp.x, pp.y, pp.z, key !== seedKey);
  seedKey = key;
  refresh();
  if (dt > 0) { const h = Math.min(dt, 0.033) * 0.8; simStep(h); simStep(h); }
  const t1 = performance.now();
  updateMesh(dt * 1.6);
  if (ownDirty) updateOwn();
  stats.stepMs += (t1 - t0 - stats.stepMs) * 0.1; stats.meshMs += (performance.now() - t1 - stats.meshMs) * 0.1;
  U.uRwOrg.value.set(ox - cam.position.x, baseY - cam.position.y, oz - cam.position.z);
}

// A push on the water at atlas (x, z): amount blocks of water added over radius blocks (a splash, a wake, something falling in).
// It spreads as waves and settles back (rule 4).
function disturb(x, z, amount, radius) {
  if (!active) return false;
  const r = Math.max(CELL, radius || 1), ci = (x - ox) * CPB, cj = (z - oz) * CPB, rc = Math.ceil(r * CPB);
  let hit = false;
  for (let j = Math.max(2, Math.floor(cj - rc)); j <= Math.min(N - 3, Math.ceil(cj + rc)); j++) for (let i = Math.max(2, Math.floor(ci - rc)); i <= Math.min(N - 3, Math.ceil(ci + rc)); i++) {
    const k = i + j * N, q = Math.hypot(i + 0.5 - ci, j + 0.5 - cj) / (r * CPB);
    if (q >= 1 || d[k] <= WET) continue;
    d[k] = Math.max(0.01, d[k] + amount * (1 - q * q)); foam[k] = Math.min(1, foam[k] + Math.abs(amount) * 2 * (1 - q)); hit = true;
  }
  return hit;
}

// ---------- API ----------
function cellAt(x, z) {
  if (!active) return -1;
  const fx = (x - ox) * CPB, fz = (z - oz) * CPB;
  if (fx < 0 || fz < 0 || fx >= N || fz >= N) return -1;
  return (fx | 0) + (fz | 0) * N;
}
RW = BF.real.water = {
  material, frame,
  active: false,
  // Off: every water is block water again (in the look's colours). On by default.
  setEnabled(on) { enabled = !!on; if (!enabled) { placed = false; mesh.visible = false; U.uRwOn.value = 0; active = RW.active = false; } return enabled; },
  get enabled() { return enabled; },
  bedSource: null,
  covers: (x, z) => cellAt(x, z) >= 0,
  // Depth of the flowing water at atlas (x, z) in blocks (0 dry or outside the window), its surface height (null where dry or
  // outside), its speed in blocks a second (out.x, out.z) and its foam (0..1).
  depthAt(x, z) { const k = cellAt(x, z); return k < 0 || d[k] <= WET ? 0 : d[k] + deep[k]; },
  surfaceAt(x, z) { const k = cellAt(x, z); return k < 0 || d[k] <= WET ? null : bed[k] + d[k] + lift[k]; },
  flowAt(x, z, out) { out = out || { x: 0, z: 0 }; const k = cellAt(x, z); out.x = k < 0 ? 0 : vx[k]; out.z = k < 0 ? 0 : vz[k]; return out; },
  foamAt(x, z) { const k = cellAt(x, z); return k < 0 ? 0 : foam[k]; },
  disturb,
  // Reads the whole window again (after bedSource changes, say).
  rebuild() { placed = false; },
  mesh, uniforms: U, stats,
  get window() { return { x: ox, z: oz, y: baseY, size: WB, height: YH, cells: N }; },
  _fields: { d, bed, tgt, vx, vz, foam, cSurf, cBed, cKnown, cSink },
};
// Splashes (the contract's BF.real.splash, atlas coordinates): for now the water's own answer, a ring of waves and foam.
BF.real.splash = (x, y, z, strength) => { const s = Math.max(0.1, Math.min(3, strength || 1)); return disturb(x, z, 0.12 * s, 0.6 + 0.5 * s); };
BF.real.module({ name: "water", init() { if (BF.scene && !mesh.parent) BF.scene.add(mesh); }, frame });
BF.on && BF.on("newWorld", () => { placed = false; seedKey = ""; });
})();
