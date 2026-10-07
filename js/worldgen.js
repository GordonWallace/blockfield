// Terrain generation: continuous climate (temperature, humidity, continentalness, erosion, weirdness)
// drives smoothly blended heights and climate-adjacent biomes; caves, ores, trees, plants and villages.
// API: BF.worldgen = { init(noise, {gen, biomeScale}), generate(cx, cz, vox) (gen 1/2, 192-high column), generateBand(cx, cz) -> {lo, hi, vox},
//                      generateRange(cx, cz, sy0, sy1) -> Uint16Array, heightAt(x, z), biomeAt(x, z), tintAt(x, z),
//                      villagesNear(x, z, r), nearestVillage(x, z) }
// Generator 3 ("mile high") works in absolute signed y with limits BF.MIN_Y = -64, BF.H = 3072, BF.SEA = 0 (BF.setLimits(gen)).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
let noise;

// ---------- biomes ----------
const OCEAN = 0, BEACH = 1, SNOWY_BEACH = 2, STONY_SHORE = 3, RIVER = 4, PLAINS = 5, FOREST = 6, FLOWER_FOREST = 7,
  BIRCH = 8, DARK_FOREST = 9, SWAMP = 10, MANGROVE = 11, DESERT = 12, BADLANDS = 13, SAVANNA = 14, SPARSE_JUNGLE = 15,
  JUNGLE = 16, TAIGA = 17, OLD_TAIGA = 18, SNOWY_PLAINS = 19, ICE_SPIKES = 20, SNOWY_TAIGA = 21, MEADOW = 22,
  CHERRY = 23, MOUNTAINS = 24, SNOWY_SLOPES = 25, PEAKS = 26, STONY_PEAKS = 27, MUSHROOM = 28;
const NAMES = ["Ocean", "Beach", "Snowy Beach", "Stony Shore", "River", "Plains", "Forest", "Flower Forest",
  "Birch Forest", "Dark Forest", "Swamp", "Mangrove Swamp", "Desert", "Badlands", "Savanna", "Sparse Jungle",
  "Jungle", "Taiga", "Old Growth Taiga", "Snowy Plains", "Ice Spikes", "Snowy Taiga", "Meadow",
  "Cherry Grove", "Windswept Hills", "Snowy Slopes", "Jagged Peaks", "Stony Peaks", "Mushroom Fields"];
// Tree probability per 4x4 cell, and ground plants per column: [short_grass, fern, flowers, dead_bush, mushrooms]
const TREE_DENSITY = [], PLANTS = [];
(function () {
  const t = (b, d, g, f, fl, db, m) => { TREE_DENSITY[b] = d; PLANTS[b] = [g, f, fl, db, m]; };
  for (let b = 0; b <= MUSHROOM; b++) t(b, 0, 0, 0, 0, 0, 0);
  t(PLAINS, 0.03, 0.28, 0, 0.03, 0, 0);
  t(FOREST, 0.6, 0.18, 0.02, 0.012, 0, 0.004);
  t(FLOWER_FOREST, 0.35, 0.1, 0, 0.22, 0, 0);
  t(BIRCH, 0.65, 0.16, 0.01, 0.01, 0, 0);
  t(DARK_FOREST, 0.92, 0.08, 0.02, 0, 0, 0.03);
  t(SWAMP, 0.3, 0.14, 0.03, 0, 0, 0.03);
  t(MANGROVE, 0.6, 0.04, 0.02, 0, 0, 0);
  t(DESERT, 0, 0, 0, 0, 0.012, 0);
  t(BADLANDS, 0, 0, 0, 0, 0.025, 0);
  t(SAVANNA, 0.08, 0.38, 0, 0.004, 0, 0);
  t(SPARSE_JUNGLE, 0.28, 0.22, 0.1, 0.01, 0, 0);
  t(JUNGLE, 0.92, 0.12, 0.16, 0.004, 0, 0);
  t(TAIGA, 0.5, 0.08, 0.1, 0.004, 0, 0.004);
  t(OLD_TAIGA, 0.6, 0.06, 0.22, 0, 0, 0.01);
  t(SNOWY_PLAINS, 0.025, 0, 0, 0, 0, 0);
  t(SNOWY_TAIGA, 0.5, 0, 0.04, 0, 0, 0);
  t(MEADOW, 0.015, 0.42, 0, 0.2, 0, 0);
  t(CHERRY, 0.22, 0.32, 0, 0.04, 0, 0);
  t(MOUNTAINS, 0.08, 0.14, 0, 0.004, 0, 0);
  t(MUSHROOM, 0.07, 0, 0, 0, 0, 0.05);
})();

// ---- plant clustering: patch fields (see CONTRACT.md "Plant clustering") ----
// Quantiles of the (0.85 n2 + 0.15 n2*2.7) patch field, used to turn a wanted area fraction into a threshold.
const QP = [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.99, 1];
const QV = [-0.95, -0.751, -0.599, -0.507, -0.377, -0.252, 0.001, 0.254, 0.379, 0.509, 0.599, 0.751, 0.95];
function fieldQ(p) {   // value v with P(field > v) = 1 - p ... i.e. the p-quantile
  if (p <= 0) return QV[0]; if (p >= 1) return QV[QV.length - 1];
  let i = 1; while (QP[i] < p) i++;
  return QV[i - 1] + (QV[i] - QV[i - 1]) * (p - QP[i - 1]) / (QP[i] - QP[i - 1]);
}
// patch noise: wavelength s, own offset o per field so fields are independent. Sampled on a 2-block grid per chunk
// (9x9 n2 calls per field, bilinear in between) and cached per chunk; ragged edges come from a per-column hash jitter.
const fieldCache = new Map();
let curNoise = null;
function patchField(x, z, s, o, ox, oz, jit) {
  const key = s * 1000 + o;
  let g = fieldCache.get(key);
  if (!g) {
    const noise = curNoise;
    g = new Float32Array(81);
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) g[j * 9 + i] = noise.n2((ox + i * 2) / s + o, (oz + j * 2) / s - o * 0.7);
    fieldCache.set(key, g);
  }
  const lx = x - ox, lz = z - oz, i = lx >> 1, j = lz >> 1, fx = (lx & 1) * 0.5, fz = (lz & 1) * 0.5;
  const a = g[j * 9 + i], b = g[j * 9 + i + 1], c = g[j * 9 + i + 9], d = g[j * 9 + i + 10];
  const top = a + (b - a) * fx, bot = c + (d - c) * fx;
  return (top + (bot - top) * fz) * 0.95 + jit;
}
// density multiplier (mean ~1 over the world): patches cover fraction c of the area, `lo` between patches
const THR_CACHE = {};
function patchMult(q, c, lo) {
  const t = THR_CACHE[c] !== undefined ? THR_CACHE[c] : (THR_CACHE[c] = fieldQ(1 - c)), w = smooth(t - 0.07, t + 0.09, q);
  const hi = (1 - lo * (1 - c)) / c;
  return lo + (hi - lo) * w * (0.85 + 0.3 * smooth(t, t + 0.3, q));
}
// per biome: [wavelength, area fraction in patches, density between patches] for short grass / fern
const GRASS_PATCH = [], FERN_PATCH = [];
(function () {
  const g = (b, s, c, lo) => { GRASS_PATCH[b] = [s, c, lo]; };
  const f = (b, s, c, lo) => { FERN_PATCH[b] = [s, c, lo]; };
  for (let b = 0; b <= 28; b++) { g(b, 24, 0.4, 0.1); f(b, 20, 0.4, 0.08); }
  g(PLAINS, 36, 0.5, 0.08); g(SAVANNA, 34, 0.55, 0.1); g(MEADOW, 30, 0.6, 0.08); g(CHERRY, 28, 0.5, 0.08);
  g(FOREST, 20, 0.42, 0.13); g(BIRCH, 20, 0.42, 0.13); g(DARK_FOREST, 18, 0.42, 0.13); g(SWAMP, 22, 0.4, 0.1);
  g(TAIGA, 24, 0.4, 0.1); g(SPARSE_JUNGLE, 26, 0.45, 0.1); g(JUNGLE, 22, 0.4, 0.1);
  f(TAIGA, 22, 0.45, 0.06); f(OLD_TAIGA, 24, 0.5, 0.08); f(JUNGLE, 20, 0.45, 0.08); f(SPARSE_JUNGLE, 22, 0.45, 0.08);
  f(SAVANNA, 26, 0.4, 0.06); f(PLAINS, 26, 0.4, 0.06); f(MEADOW, 26, 0.5, 0.06); f(CHERRY, 26, 0.45, 0.06);
})();
// flowers: three independent patch fields (poppy, dandelion, cornflower), wavelengths 15/17/19
const FLOWER_S = [15, 17, 19], FLOWER_O = [31.7, 57.3, 83.1];
// mushrooms / dead bush / sugar cane: one patch field each
const FL_BAND1 = fieldQ(1 / 3) * 0.95, FL_BAND2 = fieldQ(2 / 3) * 0.95;
const FL_COVER = [], FL_THR = [], FL_DENS = [], MU_COVER = [], MU_THR = [], MU_DENS = [];
for (let b = 0; b <= MUSHROOM; b++) {
  const p = PLANTS[b], fc = Math.min(0.5, p[2] * 0.97 / 0.36 * 1.55);
  FL_COVER[b] = fc; FL_THR[b] = fieldQ(1 - fc); FL_DENS[b] = Math.min(1, p[2] * 0.97 / 0.36 * 1.55 / (fc || 1));
  const mc = Math.min(0.3, p[4] * 0.92 / 0.28);
  MU_COVER[b] = mc; MU_THR[b] = fieldQ(1 - mc); MU_DENS[b] = Math.min(1, p[4] * 0.92 / (mc || 1) / 0.3);
}
const MUSH_S = 14, DEAD_S = 22, CANE_S = 12;

const smooth = (a, b, x) => {
  let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// continentalness -> base height (piecewise linear)
const CONT_X = [-1.2, -0.4, -0.25, -0.15, -0.09, -0.02, 0.2, 0.5, 1.2];
const CONT_Y = [24, 29, 37, 44, 48.2, 50.5, 54, 60, 64];
function contBase(c) {
  if (c <= CONT_X[0]) return CONT_Y[0];
  for (let i = 1; i < CONT_X.length; i++)
    if (c < CONT_X[i]) return lerp(CONT_Y[i - 1], CONT_Y[i], (c - CONT_X[i - 1]) / (CONT_X[i] - CONT_X[i - 1]));
  return CONT_Y[CONT_Y.length - 1];
}
// temperature / humidity band thresholds (fbm units; roughly 16/22/27/19/16 % of the world)
const BANDS = [-0.3, -0.1, 0.12, 0.3];
const band = v => (v < BANDS[0] ? 0 : v < BANDS[1] ? 1 : v < BANDS[2] ? 2 : v < BANDS[3] ? 3 : 4);

// Generator version of the current world (BF.state.gen; 1 = the original generator, kept so saved worlds have no seams) and the
// relative biome size (1 = original size). Set by init().
let GEN = 1, SC = 1;
// World limits per generator (see docs/MILE_HIGH_CONTRACT.md): [MIN_Y, H (exclusive top), SEA]
BF.setLimits = function (gen) {
  const L = gen >= 3 ? [-64, 3072, 0] : [0, 192, 48];
  BF.MIN_Y = L[0]; BF.H = L[1]; BF.SEA = L[2]; BF.SY0 = L[0] >> 4; BF.SY1 = L[1] >> 4;
};
// Slow climate fields at a (warped) position. Writes into K.
const K = { t: 0, hu: 0, c: 0, e: 0, wd: 0, wx: 0, wz: 0, u: 0, p: 0, pm: 0, lo: 0, mt: 0, sp: 0, mp: 0 };
// v2 fields: climate zones and continents scale with SC, continents are big (thousands of blocks) and separated by open ocean.
function rawFields2(x, z) {
  const q = Math.sqrt(SC), wl = 230 * q, wa = 48 * q;
  const wx = x + noise.n2(x / wl + 11.1, z / wl - 7.7) * wa + noise.n2(x / 60 + 3.3, z / 60) * 8;
  const wz = z + noise.n2(x / wl - 31.3, z / wl + 5.5) * wa + noise.n2(x / 60, z / 60 - 9.9) * 8;
  K.wx = wx; K.wz = wz;
  const LT = 2400 * SC, LH = 2000 * SC;
  K.t = noise.fbm(wx / LT + 41.37, wz / LT - 17.71, 2) * 0.85;
  K.hu = noise.fbm(wx / LH + 311.7, wz / LH - 173.3, 2) * 0.85;
  // continentalness: its own big warp gives coastlines that wander; contrast keeps the oceans wide and the continents solid
  const d2 = x * x + z * z;     // land is forced around the origin so the default spawn is on a continent
  if (GEN >= 3) K.c = cont3(x, z);
  else {
    const LC = CONT_L * (1 + 0.12 * (SC - 1));
    const cx = x + noise.n2(x / (LC * 0.45) + 7.7, z / (LC * 0.45) - 3.1) * LC * 0.09, cz = z + noise.n2(x / (LC * 0.45) - 13.9, z / (LC * 0.45) + 21.3) * LC * 0.09;
    K.c = noise.fbm(cx / LC - 517.1, cz / LC + 229.9, 5) * 2.0 - 0.15 + 1.3 * (1 - smooth(62500, 5760000, d2));
  }
  const LE = 1700 * q, LW = 600 * Math.pow(SC, 0.6), LU = 3600 * q;
  K.e = noise.fbm(wx / LE + 77.7, wz / LE + 901.3, 3);
  K.wd = noise.fbm(wx / LW - 201.1, wz / LW + 44.4, 2);
  K.u = noise.fbm(wx / LU + 613.3, wz / LU - 88.8, 3);
  if (GEN >= 3) {       // v3: plateau level selector and plateau coverage mask (very long wavelengths)
    // unwarped coordinates: the short-wavelength biome warp would squeeze these slow fields into steep steps
    const LL = 12000 * q;
    K.p = noise.fbm(x / LL + 905.1, z / LL - 311.3, 2);
    K.pm = 0; K.mt = 0;
    limWeights(x, z);     // K.sp plateau weight, K.mp massif weight, K.lo low-plateau weight (all slope limited)
  }
}
const CONT_L = 14000;    // continent wavelength at biome scale 1
// v3 continents: wavelength (biome scale 1), contrast, bias (about 30% land), coast roughness, warp wavelength and amplitude (x wavelength), octaves
const CONT3_L = 90000, CONT3_K = 5.0, CONT3_BIAS = -0.875, CONT3_ROUGH = 0.15, CONT3_WL = 1.2, CONT3_WA = 0.12, CONT3_OCT = 3;
// v3: continentalness alone (same formula as rawFields2), for the coarse slope-limiter grid
function contOnly(x, z) { return cont3(x, z); }
// v3 continents: broad landmasses (Earth-like shapes, smaller): a smooth 3-octave field on a long wavelength with a large slow
// warp gives big bodies with a few peninsulas and bays; a weak short octave roughens the coastline without breaking it into
// arms and islands. Contrast is low so continentalness rises gently inland (wide lowlands before the plateau ramps).
function cont3(x, z) { return contRaw3(x + CONT3_OX, z + CONT3_OZ) + 1.3 * (1 - smooth(62500, 5760000, x * x + z * z)); }
// The continent field is shifted so the origin (default spawn) lies well inside a big landmass: init() searches for the point
// farthest inland (highest field) within one wavelength and moves it to the origin.
let CONT3_OX = 0, CONT3_OZ = 0;
function placeHome3() {
  CONT3_OX = CONT3_OZ = 0;
  const LC = CONT3_L * (1 + 0.12 * (SC - 1)), st = LC / 16;
  let best = -1e9, bx = 0, bz = 0;
  for (let j = -16; j <= 16; j++) for (let i = -16; i <= 16; i++) {
    const x = i * st, z = j * st, v = contRaw3(x, z) - 0.15 * (i * i + j * j) / 256;   // prefer nearby
    if (v > best) { best = v; bx = x; bz = z; }
  }
  CONT3_OX = Math.round(bx); CONT3_OZ = Math.round(bz);
}
function contRaw3(x, z) {
  const LC = CONT3_L * (1 + 0.12 * (SC - 1)), WL = LC * CONT3_WL, WA = LC * CONT3_WA;
  const cx = x + noise.n2(x / WL + 7.7, z / WL - 3.1) * WA, cz = z + noise.n2(x / WL - 13.9, z / WL + 21.3) * WA;
  const big = noise.fbm(cx / LC - 517.1, cz / LC + 229.9, CONT3_OCT);
  const rough = noise.n2(cx / (LC * 0.11) + 91.3, cz / (LC * 0.11) - 37.7) * CONT3_ROUGH;
  return big * CONT3_K + rough + CONT3_BIAS;
}
// Slope-limited plateau and massif weights on a coarse grid (CG blocks). Raw weights at the nodes may change abruptly (continent
// edges are steep in continentalness); each node then takes min over a disc of (raw weight + slope * distance), which caps
// how fast the weight (and so the height) can rise anywhere, so escarpments become long ramps and massifs broad domes.
// Pure function of the seed: nodes are cached, any order gives the same values.
const CG = 320, SL_P = 1 / 6000, SL_M = 1 / 2600, SL_L = 1 / 2600, LIM_R = Math.ceil(6000 / CG);
const CRAW = new Map(), CLIM = new Map(), CLIS = new Map();
function nodeRaw(i, j) {
  const k = i * 1048576 + j; let v = CRAW.get(k);
  if (v === undefined) {
    if (CRAW.size > 400000) CRAW.clear();
    const x = i * CG, z = j * CG, q = Math.sqrt(SC);
    const c = contOnly(x, z), d2 = x * x + z * z, home = 1 - smooth(360000, 9000000, d2);
    const pm = noise.fbm(x / (18000 * q) + 1234.5, z / (18000 * q) - 777.7, 2), mt = noise.fbm(x / (14000 * q) + 333.3, z / (14000 * q) - 444.4, 2);
    const inland = smooth(0.15, 0.3, c);   // a coastal plain before the ramps start
    const pl = inland * Math.max(smooth(-0.75, -0.3, pm), home);
    const lo = noise.fbm(x / (14000 * q) + 55.5, z / (14000 * q) - 99.9, 2);
    v = [pl, pl * smooth(0.05, 0.45, mt) * (1 - 0.97 * home), smooth(-0.03, -0.22, lo)];
    CRAW.set(k, v);
  }
  return v;
}
// disc offsets sorted by distance: a scan stops once slope * distance exceeds the current minimum (raw weights are >= 0)
const LIM_OFF = (() => {
  const o = [];
  for (let b = -LIM_R; b <= LIM_R; b++) for (let a = -LIM_R; a <= LIM_R; a++) { const d = Math.hypot(a, b) * CG; if (d <= LIM_R * CG + 1) o.push([a, b, d]); }
  o.sort((p, q) => p[2] - q[2] || p[1] - q[1] || p[0] - q[0]);
  return [].concat(...o);
})();
// pass 1: plateau and low-plateau weights
function nodeLimS(i, j) {
  const k = i * 1048576 + j; let v = CLIS.get(k);
  if (v === undefined) {
    if (CLIS.size > 400000) CLIS.clear();
    const r0 = nodeRaw(i, j);
    let sp = r0[0], lw = r0[2];
    for (let n = 0; n < LIM_OFF.length; n += 3) {
      const d = LIM_OFF[n + 2];
      if (d * SL_P >= sp && d * SL_L >= lw) break;
      const r = nodeRaw(i + LIM_OFF[n], j + LIM_OFF[n + 1]);
      const a = r[0] + d * SL_P, l = r[2] + d * SL_L;
      if (a < sp) sp = a;
      if (l < lw) lw = l;
    }
    v = [sp, lw]; CLIS.set(k, v);
  }
  return v;
}
// pass 2: massifs only start where the plateau is (nearly) complete, so their flanks never add to an escarpment
const mRaw = (i, j) => { const r = nodeRaw(i, j)[1]; return r > 0 ? r * smooth(0.85, 1.0, nodeLimS(i, j)[0]) : 0; };
function nodeLim(i, j) {
  const k = i * 1048576 + j; let v = CLIM.get(k);
  if (v === undefined) {
    if (CLIM.size > 200000) CLIM.clear();
    const s = nodeLimS(i, j);
    let mp = mRaw(i, j);
    for (let n = 0; n < LIM_OFF.length; n += 3) {
      const d = LIM_OFF[n + 2];
      if (d * SL_M >= mp) break;
      const b = mRaw(i + LIM_OFF[n], j + LIM_OFF[n + 1]) + d * SL_M;
      if (b < mp) mp = b;
    }
    v = [s[0], mp, s[1]]; CLIM.set(k, v);
  }
  return v;
}
// smooth interpolation of the limited node weights -> K.sp (plateau), K.mp (massif)
// Coarse mode (overview maps, setCoarse): the raw node weights without the disc scan, which is too slow when every pixel lands
// on new nodes. Escarpments come out steeper, but at 64+ blocks per pixel that's invisible.
let COARSE = false;
function limWeights(x, z) {
  if (COARSE) {
    const fi = x / CG, fj = z / CG, i = Math.floor(fi), j = Math.floor(fj), u = fi - i, w = fj - j;
    const r = (a, b) => { const v = nodeRaw(a, b); return [v[0], v[1] > 0 ? v[1] * smooth(0.85, 1.0, v[0]) : 0, v[2]]; };
    const a = r(i, j), b = r(i + 1, j), c = r(i, j + 1), d = r(i + 1, j + 1);
    K.sp = lerp(lerp(a[0], b[0], u), lerp(c[0], d[0], u), w);
    K.mp = lerp(lerp(a[1], b[1], u), lerp(c[1], d[1], u), w);
    K.lo = lerp(lerp(a[2], b[2], u), lerp(c[2], d[2], u), w);
    return;
  }
  const fi = x / CG, fj = z / CG, i = Math.floor(fi), j = Math.floor(fj), u = fi - i, w = fj - j;
  const tu = u, tw = w;
  const a = nodeLim(i, j), b = nodeLim(i + 1, j), c = nodeLim(i, j + 1), d = nodeLim(i + 1, j + 1);
  K.sp = lerp(lerp(a[0], b[0], tu), lerp(c[0], d[0], tu), tw);
  K.mp = lerp(lerp(a[1], b[1], tu), lerp(c[1], d[1], tu), tw);
  K.lo = lerp(lerp(a[2], b[2], tu), lerp(c[2], d[2], tu), tw);
}
function rawFields(x, z) {
  if (GEN >= 2) return rawFields2(x, z);
  // domain warp: organic, wiggly biome borders
  const wx = x + noise.n2(x / 230 + 11.1, z / 230 - 7.7) * 48 + noise.n2(x / 60 + 3.3, z / 60) * 8;
  const wz = z + noise.n2(x / 230 - 31.3, z / 230 + 5.5) * 48 + noise.n2(x / 60, z / 60 - 9.9) * 8;
  K.wx = wx; K.wz = wz;
  K.t = noise.fbm(wx / 2400 + 41.37, wz / 2400 - 17.71, 2) * 0.85;
  K.hu = noise.fbm(wx / 2000 + 311.7, wz / 2000 - 173.3, 2) * 0.85;
  // continentalness, biased toward land around the origin so the default spawn lands on a continent
  const d2 = x * x + z * z;
  K.c = noise.fbm(wx / 2600 - 517.1, wz / 2600 + 229.9, 4) + (d2 < 2250000 ? 0.32 * (1 - smooth(160000, 2250000, d2)) : 0);
  K.e = noise.fbm(wx / 1100 + 77.7, wz / 1100 + 901.3, 3);
  K.wd = noise.fbm(wx / 600 - 201.1, wz / 600 + 44.4, 2);
}
// The slow fields are sampled on a 4-block lattice (cached) and bilinearly interpolated: identical results
// for any call order, and ~10x cheaper per column.
const LAT = new Map();
function lattice(lx, lz) {
  const key = lx * 1048576 + lz;
  let a = LAT.get(key);
  if (!a) {
    if (LAT.size > 60000) LAT.clear();
    rawFields(lx * 4, lz * 4);
    a = new Float64Array([K.t, K.hu, K.c, K.e, K.wd, K.wx - lx * 4, K.wz - lz * 4, K.u, K.p, K.pm, K.lo, K.mt, K.sp, K.mp]);
    LAT.set(key, a);
  }
  return a;
}
function fields(x, z) {
  const lx = Math.floor(x / 4), lz = Math.floor(z / 4), fx = (x - lx * 4) / 4, fz = (z - lz * 4) / 4;
  const a = lattice(lx, lz), b = lattice(lx + 1, lz), c = lattice(lx, lz + 1), d = lattice(lx + 1, lz + 1);
  const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
  K.t = a[0] * w00 + b[0] * w10 + c[0] * w01 + d[0] * w11;
  K.hu = a[1] * w00 + b[1] * w10 + c[1] * w01 + d[1] * w11;
  K.c = a[2] * w00 + b[2] * w10 + c[2] * w01 + d[2] * w11;
  K.e = a[3] * w00 + b[3] * w10 + c[3] * w01 + d[3] * w11;
  K.wd = a[4] * w00 + b[4] * w10 + c[4] * w01 + d[4] * w11;
  K.wx = x + a[5] * w00 + b[5] * w10 + c[5] * w01 + d[5] * w11;
  K.wz = z + a[6] * w00 + b[6] * w10 + c[6] * w01 + d[6] * w11;
  K.u = a[7] * w00 + b[7] * w10 + c[7] * w01 + d[7] * w11;
  K.p = a[8] * w00 + b[8] * w10 + c[8] * w01 + d[8] * w11;
  K.pm = a[9] * w00 + b[9] * w10 + c[9] * w01 + d[9] * w11;
  K.lo = a[10] * w00 + b[10] * w10 + c[10] * w01 + d[10] * w11;
  K.mt = a[11] * w00 + b[11] * w10 + c[11] * w01 + d[11] * w11;
  K.sp = a[12] * w00 + b[12] * w10 + c[12] * w01 + d[12] * w11;
  K.mp = a[13] * w00 + b[13] * w10 + c[13] * w01 + d[13] * w11;
}

// Full column climate. Writes into C (no allocation) and returns the terrain surface height.
// C.wl is the water level of the column (sea level, or the surface of a v2 river), C.rv is 1 inside a river channel and its banks.
const C = { S: 0, h: 0, t: 0, hu: 0, c: 0, e: 0, wd: 0, m: 0, rf: 0, sw: 0, bw: 0, mi: 0, biome: 0, tb: 0, hb: 0, wl: 48, rv: 0 };
const climate = (x, z) => (GEN >= 3 ? climate3(x, z) : GEN >= 2 ? climate2(x, z) : climate1(x, z));
function climate1(x, z) {
  const SEA = BF.SEA;
  C.wl = SEA; C.rv = 0;
  fields(x, z);
  const { t, hu, c, e, wd } = K;
  const hills = noise.fbm(x / 150 + 71.3, z / 150 - 33.1, 4);
  const land = smooth(-0.13, -0.02, c);

  // continuous terrain shape from climate (no per-biome steps -> no cliffs at borders)
  const wet = smooth(-0.35, 0.45, hu), hot = smooth(-0.1, 0.45, t);
  const amp = 6 + 9 * wet + 10 * wet * hot + 4 * smooth(-0.2, 0.2, e < 0 ? -e : 0);
  let h = contBase(c) + hills * lerp(5, amp, land) + 2.5 * wet * land;

  // mountains where erosion is low, inland
  const m = smooth(-0.18, -0.45, e) * smooth(-0.06, 0.1, c);
  if (m > 0) {
    const r = 1 - Math.abs(noise.fbm(x / 260 - 401.2, z / 260 + 133.4, 5));
    h += m * (r * r * r * 66 + 12 + hills * 6);
  }
  // badlands plateaus (hot, dry, weird)
  const bw = smooth(0.26, 0.36, t) * (1 - smooth(-0.14, -0.04, hu)) * smooth(0.0, 0.18, wd) * land * (1 - m);
  if (bw > 0) {
    const p = 60 + (noise.fbm(x / 110 + 5.5, z / 110 - 8.8, 2) + 0.3) * 26;
    const step = Math.floor(p / 6) * 6, f = p - step;
    const terr = step + (f > 4.5 ? (f - 4.5) * 4 : 0);
    if (terr > h) h = lerp(h, terr, bw);
  }
  // swamps / mangroves: low, wet, warm-ish coasts and lowlands
  const sw = smooth(0.2, 0.36, hu) * smooth(-0.2, -0.06, t) * (1 - smooth(0.02, 0.3, c)) * land * (1 - m);
  if (sw > 0) h = lerp(h, SEA + 0.35 + hills * 2.6, sw);
  // mushroom islands, only far out in deep ocean
  let mi = 0;
  if (c < -0.34) {
    mi = smooth(0.6, 0.72, noise.n2(x / 520 + 77.7, z / 520 - 55.5)) * smooth(-0.34, -0.46, c);
    if (mi > 0) h = lerp(h, SEA + 3 + hills * 7, mi);
  }
  // rivers
  const rv = Math.abs(noise.fbm(K.wx / 640 + 1000.3, K.wz / 640 - 1000.7, 3));
  const rf = (1 - smooth(0.01, 0.035, rv)) * land * (1 - m * 0.75) * (1 - mi);
  if (rf > 0 && h > SEA - 3) h -= (h - (SEA - 3)) * rf;

  if (h > 96) h = 96 + (h - 96) * 0.55;
  h = Math.floor(h);
  if (h < 4) h = 4; else if (h > BF.H - 10) h = BF.H - 10;

  // ---- discrete biome (dithered borders) ----
  // border jitter: wavy at ~20-block scale plus a little per-block dither
  const dj = noise.n2(x / 22 + 7.1, z / 22) * 0.02 + (noise.hash(x, z, 77) - 0.5) * 0.008;
  const tb = band(t + dj), hb = band(hu - dj);
  let b;
  if (mi > 0.5 && h >= SEA - 1) b = MUSHROOM;
  else if (h < SEA - 1 && c < -0.08) b = OCEAN;
  else if (rf > 0.5 && h < SEA) b = RIVER;
  else if (c < -0.03 + dj && h <= SEA + 2 && sw < 0.5) b = smooth(-0.18, -0.45, e) > 0.45 ? STONY_SHORE : tb === 0 ? SNOWY_BEACH : BEACH;
  else if (c < 0.0 && m > 0.25 && h <= SEA + 7) b = STONY_SHORE;
  else if (bw > 0.5 + dj * 2) b = BADLANDS;
  else if (m > 0.3 + dj * 2 && h >= 68) {
    if (h >= 100) b = tb <= 2 ? PEAKS : STONY_PEAKS;
    else if (h >= 84) b = tb <= 1 ? SNOWY_SLOPES : tb === 2 ? MOUNTAINS : STONY_PEAKS;
    else if (tb <= 1) b = tb === 0 ? SNOWY_TAIGA : TAIGA;
    else if (tb >= 4) b = SAVANNA;
    else if (wd > 0.22) b = CHERRY;
    else b = hb <= 2 ? MEADOW : FOREST;
  } else if (sw > 0.5 + dj * 2) b = tb >= 3 && t > 0.0 ? MANGROVE : SWAMP;
  else if (tb === 0) b = hb <= 1 ? (wd > 0.3 ? ICE_SPIKES : SNOWY_PLAINS) : SNOWY_TAIGA;
  else if (tb === 1) b = hb === 4 ? OLD_TAIGA : TAIGA;
  else if (tb === 2) b = hb <= 1 ? PLAINS : hb === 2 ? (wd > 0.28 ? FLOWER_FOREST : FOREST) : hb === 3 ? BIRCH : DARK_FOREST;
  else if (tb === 3) b = hb === 0 ? SAVANNA : hb === 1 ? PLAINS : hb === 2 ? FOREST : hb === 3 ? SPARSE_JUNGLE : JUNGLE;
  else b = hb <= 1 ? DESERT : hb === 2 ? SAVANNA : hb === 3 ? SPARSE_JUNGLE : JUNGLE;

  C.h = h; C.t = t; C.hu = hu; C.c = c; C.e = e; C.wd = wd; C.m = m; C.rf = rf; C.sw = sw; C.bw = bw; C.mi = mi;
  C.biome = b; C.tb = tb; C.hb = hb;
  return h;
}

// ---------- generator v2 ----------
// continentalness -> base height: wide continental shelf, deep ocean basins, a long gentle rise inland
const CONT2_X = [-1.4, -0.6, -0.3, -0.12, -0.04, 0.03, 0.2, 0.5, 0.9, 1.6];
const CONT2_Y = [18, 22, 31, 42, 48.5, 51, 56, 63, 70, 78];
function contBase2(c) {
  if (c <= CONT2_X[0]) return CONT2_Y[0];
  for (let i = 1; i < CONT2_X.length; i++)
    if (c < CONT2_X[i]) return lerp(CONT2_Y[i - 1], CONT2_Y[i], (c - CONT2_X[i - 1]) / (CONT2_X[i] - CONT2_X[i - 1]));
  return CONT2_Y[CONT2_Y.length - 1];
}
// Uplands: broad, gently tilted plateaus on continental interiors (not mountains), up to ~y125.
const upland = (x, z) => 82 * smooth(-0.08, 0.5, K.u * 2.1) * smooth(0.05, 0.55, K.c) * (0.3 + 0.7 * smooth(250, 1500, Math.sqrt(x * x + z * z)));  // gentle lowlands around spawn
// soft ceiling: ~linear below 140, asymptote at the top of the world
function ceil2(h) {
  const top = BF.H - 8;
  return h <= 140 ? h : 140 + (top - 140) * Math.tanh((h - 140) / (top - 140));
}
// Terrain height without rivers (K must hold the fields at x, z). `detail`: local hills and the full ridged-noise mountains.
function relief2(x, z, detail) {
  const SEA = BF.SEA, { t, hu, c, e, wd } = K;
  const hills = detail ? noise.fbm(x / 150 + 71.3, z / 150 - 33.1, 4) : 0;
  const land = smooth(-0.13, -0.02, c);
  const wet = smooth(-0.35, 0.45, hu), hot = smooth(-0.1, 0.45, t);
  const hl = upland(x, z);
  const amp = 6 + 9 * wet + 10 * wet * hot + 4 * smooth(-0.2, 0.2, e < 0 ? -e : 0) + hl * 0.12;
  let h = contBase2(c) + hills * lerp(5, amp, land) + 2.5 * wet * land + hl;
  const m = smooth(-0.14, -0.42, e) * smooth(-0.06, 0.1, c);
  if (m > 0) {
    const r = 1 - Math.abs(noise.fbm(x / 300 - 401.2, z / 300 + 133.4, detail ? 5 : 3));
    h += m * (r * r * r * 96 + 14 + hills * 8);
  }
  return { h, m, land, hills, hl };
}
const MAC = { h: 0 };
// Smooth height (no local hills, 3-octave ridges) and continentalness for the river network.
function macro2(x, z, o) {
  fields(x, z);
  o.p = ceil2(relief2(x, z, false).h);
  o.c = K.c;
}
const RV = { d: 0, w: 0, rs: 0, sd: 0 };
function climate2(x, z) {
  const SEA = BF.SEA;
  fields(x, z);
  const { t, hu, c, e, wd } = K;
  const R = relief2(x, z, true), m = R.m, land = R.land, hills = R.hills;
  let h = R.h;
  const wet = smooth(-0.35, 0.45, hu);
  // badlands plateaus (hot, dry, weird)
  const bw = smooth(0.26, 0.36, t) * (1 - smooth(-0.14, -0.04, hu)) * smooth(0.0, 0.18, wd) * land * (1 - m);
  if (bw > 0) {
    const p = 60 + R.hl * 0.8 + (noise.fbm(x / 110 + 5.5, z / 110 - 8.8, 2) + 0.3) * 26;
    const step = Math.floor(p / 6) * 6, f = p - step;
    const terr = step + (f > 4.5 ? (f - 4.5) * 4 : 0);
    if (terr > h) h = lerp(h, terr, bw);
  }
  // swamps / mangroves: low, wet, warm-ish coasts and lowlands
  const sw = smooth(0.2, 0.36, hu) * smooth(-0.2, -0.06, t) * (1 - smooth(0.02, 0.3, c)) * land * (1 - m);
  if (sw > 0) h = lerp(h, SEA + 0.35 + hills * 2.6, sw);
  let mi = 0;
  if (c < -0.8) {
    mi = smooth(0.7, 0.8, noise.n2(x / 520 + 77.7, z / 520 - 55.5)) * smooth(-0.8, -0.95, c);
    if (mi > 0) h = lerp(h, SEA + 3 + hills * 7, mi);
  }
  h = ceil2(h);
  // rivers: a valley floor at the water surface with a flat floodplain, blended into the surrounding terrain
  let wl = SEA, rv = 0, chan = false;
  if (land > 0.3 && mi === 0 && BF.rivers.at(x, z, RV)) {
    const rs = Math.max(SEA, Math.floor(RV.rs)), sd = RV.sd, w = RV.w;
    const fp = (1 - smooth(w + 3, w + 30, RV.d)) * land;
    let hr;
    if (sd < 0) { const q = RV.d / w; hr = rs - 1.4 - 3.2 * (1 - q * q); }
    else hr = rs + 1.4 + smooth(0, 14, sd) * 1.5;
    h = h + (hr - h) * fp;
    if (sd < 0 && fp > 0.9) { chan = true; wl = rs; if (h > rs - 1) h = rs - 1; }
    else if (sd < 3 && h < rs + 1) h = rs + 1;
    if (sd < 6) rv = 1;
  }
  h = Math.floor(h);
  if (h < 4) h = 4; else if (h > BF.H - 6) h = BF.H - 6;

  // ---- discrete biome (dithered borders) ----
  // border jitter: wavy plus per-block dither; the dither band widens with biome size (gradients get shallower), so big biomes blend softly
  const sc = Math.pow(SC, 0.7);
  const dj = noise.n2(x / (22 * sc) + 7.1, z / (22 * sc)) * 0.02 + (noise.hash(x, z, 77) - 0.5) * 0.008 * (1 + 0.45 * (SC - 1));
  // thinner air up high: cooler bands, so tall plateaus and ranges turn to taiga and snow
  const tb = band(t - 0.5 * smooth(70, 175, h) + dj), hb = band(hu - dj);
  let b;
  if (mi > 0.5 && h >= SEA - 1) b = MUSHROOM;
  else if (h < SEA - 1 && c < -0.08) b = OCEAN;
  else if (chan) b = RIVER;
  else if (c < -0.03 + dj && h <= SEA + 2 && sw < 0.5) b = smooth(-0.18, -0.45, e) > 0.45 ? STONY_SHORE : tb === 0 ? SNOWY_BEACH : BEACH;
  else if (c < 0.0 && m > 0.25 && h <= SEA + 7) b = STONY_SHORE;
  else if (bw > 0.5 + dj * 2) b = BADLANDS;
  else if (m > 0.3 + dj * 2 && h >= 90) {
    if (h >= 135) b = tb <= 2 ? PEAKS : STONY_PEAKS;
    else if (h >= 115) b = tb <= 1 ? SNOWY_SLOPES : tb === 2 ? MOUNTAINS : STONY_PEAKS;
    else if (tb <= 1) b = tb === 0 ? SNOWY_TAIGA : TAIGA;
    else if (tb >= 4) b = SAVANNA;
    else if (wd > 0.22) b = CHERRY;
    else b = hb <= 2 ? MEADOW : FOREST;
  } else if (sw > 0.5 + dj * 2) b = tb >= 3 && t > 0.0 ? MANGROVE : SWAMP;
  else if (tb === 0) b = hb <= 1 ? (wd > 0.3 ? ICE_SPIKES : SNOWY_PLAINS) : SNOWY_TAIGA;
  else if (tb === 1) b = hb === 4 ? OLD_TAIGA : TAIGA;
  else if (tb === 2) b = hb <= 1 ? PLAINS : hb === 2 ? (wd > 0.28 ? FLOWER_FOREST : FOREST) : hb === 3 ? BIRCH : DARK_FOREST;
  else if (tb === 3) b = hb === 0 ? SAVANNA : hb === 1 ? PLAINS : hb === 2 ? FOREST : hb === 3 ? SPARSE_JUNGLE : JUNGLE;
  else b = hb <= 1 ? DESERT : hb === 2 ? SAVANNA : hb === 3 ? SPARSE_JUNGLE : JUNGLE;

  C.h = h; C.t = t; C.hu = hu; C.c = c; C.e = e; C.wd = wd; C.m = m; C.rf = chan ? 1 : 0; C.sw = sw; C.bw = bw; C.mi = mi;
  C.biome = b; C.tb = tb; C.hb = hb; C.wl = wl; C.rv = rv;
  return h;
}

// ---------- generator v3 ("mile high"): sea level y = 0, ocean floors down to -58, high plains around y 900-1300, ranges up to ~2500 ----------
// continentalness -> lowland base height: continental shelf, deep basins, coastal lowlands rising to ~100 in the interior
const CONT3_X = [-1.4, -0.7, -0.35, -0.15, -0.05, 0.03, 0.25, 0.6, 1.0, 1.7];
const CONT3_Y = [-58, -50, -34, -15, -4, 2.5, 18, 48, 80, 105];
function contBase3(c) {
  if (c <= CONT3_X[0]) return CONT3_Y[0];
  for (let i = 1; i < CONT3_X.length; i++)
    if (c < CONT3_X[i]) return lerp(CONT3_Y[i - 1], CONT3_Y[i], (c - CONT3_X[i - 1]) / (CONT3_X[i] - CONT3_X[i - 1]));
  return CONT3_Y[CONT3_Y.length - 1];
}
// soft ceiling: linear to 2000, then an asymptote at 2700 (the world is 3072 high; trees need ~40)
const ceil3 = h => (h <= 2000 ? h : 2000 + 700 * Math.tanh((h - 2000) / 700));
// thin air: the temperature band shifts down gently with altitude (a thousand blocks up is still cool-temperate)
const cool3 = h => 0.05 * smooth(0, 1300, h) + 0.6 * smooth(1300, 2600, h);
// Terrain height without rivers (K must hold the fields at x, z). `detail`: local hills and the full ridged-noise mountains.
// Plateau weight S, massif weight m and low-plateau weight K.lo come from the slope-limited coarse grid (see nodeLim), so
// escarpments are ramps ~5 km long (after a 1-2 km coastal plain) and massifs domes ~5 km across. Near the origin a plateau is forced (default spawn).
function relief3(x, z, detail) {
  const { t, hu, c, e } = K;
  const hills = detail ? noise.fbm(x / 170 + 71.3, z / 170 - 33.1, 4) : 0;
  const land = smooth(-0.13, -0.02, c);
  const wet = smooth(-0.35, 0.45, hu), hot = smooth(-0.1, 0.45, t);
  const d2 = x * x + z * z, home = 1 - smooth(360000, 9000000, d2);
  const S = Math.min(1, K.sp) * land;
  const amp = 4 + 6 * wet + 6 * wet * hot + 3 * smooth(-0.2, 0.2, e < 0 ? -e : 0);
  const hA = lerp(4, amp, land);
  // near sea level the hills fade out, so the shoreline is one clean line instead of a belt of islets and puddles
  const bz = contBase3(c), hk = 0.12 + 0.88 * smooth(0, 12, Math.abs(bz - BF.SEA));
  const low = bz + hills * hA * hk + 2.5 * wet * land;
  // plateau top: level ~910..1110 (the p field tilts it very gently), some regions are lower plateaus (~390..590), plus long low swells
  const lvl = lerp(1010 + 100 * Math.tanh(K.p / 0.45) - 520 * smooth(0, 1, Math.min(1, K.lo)), 1070, home);
  const swell = 5 * noise.n2(x / 520 + 19.7, z / 520 - 4.4) + (detail ? 0.3 * noise.n2(x / 90 - 8.2, z / 90 + 13.1) : 0);
  const top = lvl + swell + hills * hA * 0.03;
  const Sn = Math.min(1, S / 0.88), Ss = Sn * Sn * (3 - 2 * Sn);   // the ramp eases in at the foot and levels off into the plain
  let h = lerp(low, top, Ss);
  // rolling foothills along the escarpment
  const fa = 4 * Ss * (1 - Ss);
  if (fa > 0.02) h += fa * (45 * (noise.fbm(x / 700 + 3.3, z / 700 - 8.8, 2) + 0.15) + hills * 6);
  // mountain massifs on the plateaus: domes rising as m^2 (gentle foot, steeper summit) up to ~2000 above the plain (ceil3 compresses)
  const m = Math.min(1, K.mp) * land * (1 - 0.97 * home);
  if (m > 0) {
    const q = Math.sqrt(SC);
    let r = 0.7 * (1 - Math.abs(noise.n2(x / (2600 * q) - 401.2, z / (2600 * q) + 133.4)));
    r += 0.3 * (1 - Math.abs(noise.n2(x / (1000 * q) + 17.1, z / (1000 * q) - 9.3)));
    const g = m * m;
    h += g * (2100 * (0.75 + 0.25 * r) + (detail ? hills * 10 : 0));
  }
  return { h, m, land, hills, S };
}
// Smooth height (no local hills, 2-octave ridges) and continentalness for the river network.
function macro3(x, z, o) {
  rawFields2(x, z);       // nodes are sparse: the raw fields are cheaper than the 4-block lattice (and equal up to interpolation error)
  o.p = ceil3(relief3(x, z, true).h);
  o.c = K.c / 2.5;   // the river network's continentalness thresholds were tuned for the v2 contrast (cont3 is 2.5x steeper)
}
function climate3(x, z) {
  const SEA = BF.SEA, MINY = BF.MIN_Y;
  fields(x, z);
  const { t, hu, c, e, wd } = K;
  const R = relief3(x, z, true), m = R.m, land = R.land, hills = R.hills, S = R.S;
  let h = R.h;
  const wet = smooth(-0.35, 0.45, hu);
  // badlands mesas (hot, dry, weird): terraced bumps on top of the local ground
  const bw = smooth(0.26, 0.36, t) * (1 - smooth(-0.14, -0.04, hu)) * smooth(0.0, 0.18, wd) * land * (1 - m);
  if (bw > 0) {
    const p = h + 14 + (noise.fbm(x / 160 + 5.5, z / 160 - 8.8, 2) + 0.3) * 26;
    const step = Math.floor(p / 6) * 6, f = p - step;
    const terr = step + (f > 3 ? (f - 3) * 2 : 0);
    if (terr > h) h = lerp(h, terr, bw);
  }
  // swamps / mangroves: low, wet, warm-ish coasts and lowlands
  // (only on low ground: pulling a ramp or plateau towards sea level would cut cliffs into it)
  const sw = smooth(0.2, 0.36, hu) * smooth(-0.2, -0.06, t) * (1 - smooth(0.02, 0.3, c)) * land * (1 - m) * (1 - S) * (1 - smooth(SEA + 12, SEA + 45, h));
  if (sw > 0) h = lerp(h, SEA + 0.35 + hills * 2.6, sw);
  let mi = 0;
  if (c < -0.8) {
    mi = smooth(0.7, 0.8, noise.n2(x / 520 + 77.7, z / 520 - 55.5)) * smooth(-0.8, -0.95, c);
    if (mi > 0) h = lerp(h, SEA + 3 + hills * 7, mi);
  }
  h = ceil3(h);
  // rivers: a valley floor at the water surface with a flat floodplain, blended into the surrounding terrain
  let wl = SEA, rv = 0, chan = false;
  const rl = Math.max(land, smooth(SEA - 3, SEA + 1, h));   // dry shore ground counts as land for rivers (outlets cut through coastal ridges)
  if (rl > 0.3 && mi === 0 && BF.rivers.at(x, z, RV)) {
    const rs = Math.max(SEA, Math.floor(RV.rs)), sd = RV.sd, w = RV.w;
    let hr;
    if (sd < 0) { const q = RV.d / w; hr = rs - 1.4 - 3.2 * (1 - q * q); }
    else hr = rs + 1.4 + smooth(0, 14, sd) * 1.5;
    const vw = Math.min(BF.rivers.REACH - w - 3, Math.max(27, (h > hr ? h - hr : 1.6 * (hr - h)) * 1.4));
    const fp = (1 - smooth(w + 3, w + 3 + vw, RV.d)) * rl;
    if (!(h < SEA - 1 && hr > h)) h = h + (hr - h) * fp;     // never raise the sea floor (outlets run on into open water)
    if (sd < 0 && fp > 0.9) { chan = true; wl = rs; if (h > rs - 1) h = rs - 1; }
    else if (sd < 3 && h < rs + 1 && h >= SEA - 1) h = rs + 1;   // banks, but no levees out into the sea (they would dam the mouth)
    if (sd < 6) rv = 1;
  }
  h = Math.floor(h);
  if (h < MINY + 6) h = MINY + 6; else if (h > BF.H - 6) h = BF.H - 6;

  // ---- discrete biome (dithered borders) ----
  const sc = Math.pow(SC, 0.7);
  const dj = noise.n2(x / (22 * sc) + 7.1, z / (22 * sc)) * 0.02 + (noise.hash(x, z, 77) - 0.5) * 0.008 * (1 + 0.45 * (SC - 1));
  // altitude cools slowly; the high plains are a little drier (rain shadow of the escarpment): more steppe and savanna, fewer forests
  const tb = band(t - cool3(h) + dj), hb = band(hu - 0.16 * S - dj);
  let b;
  if (mi > 0.5 && h >= SEA - 1) b = MUSHROOM;
  else if (h < SEA - 1 && c < -0.08) b = OCEAN;
  else if (chan) b = RIVER;
  else if (c < -0.03 + dj && h <= SEA + 2 && sw < 0.5) b = smooth(-0.18, -0.45, e) > 0.45 ? STONY_SHORE : tb === 0 ? SNOWY_BEACH : BEACH;
  else if (c < 0.0 && m > 0.25 && h <= SEA + 7) b = STONY_SHORE;
  else if (bw > 0.5 + dj * 2) b = BADLANDS;
  else if (m > 0.3 + dj * 2 && h >= 700) {
    if (h >= 1750) b = tb <= 2 ? PEAKS : STONY_PEAKS;
    else if (h >= 1350) b = tb <= 1 ? SNOWY_SLOPES : tb === 2 ? MOUNTAINS : STONY_PEAKS;
    else if (tb <= 1) b = tb === 0 ? SNOWY_TAIGA : TAIGA;
    else if (tb >= 4) b = SAVANNA;
    else if (wd > 0.22) b = CHERRY;
    else b = hb <= 2 ? MEADOW : FOREST;
  } else if (sw > 0.5 + dj * 2) b = tb >= 3 && t > 0.0 ? MANGROVE : SWAMP;
  else if (tb === 0) b = hb <= 1 ? (wd > 0.3 ? ICE_SPIKES : SNOWY_PLAINS) : SNOWY_TAIGA;
  else if (tb === 1) b = hb === 4 ? OLD_TAIGA : TAIGA;
  else if (tb === 2) b = hb <= 1 ? PLAINS : hb === 2 ? (wd > 0.28 ? FLOWER_FOREST : FOREST) : hb === 3 ? BIRCH : DARK_FOREST;
  else if (tb === 3) b = hb === 0 ? SAVANNA : hb === 1 ? PLAINS : hb === 2 ? FOREST : hb === 3 ? SPARSE_JUNGLE : JUNGLE;
  else b = hb <= 1 ? DESERT : hb === 2 ? SAVANNA : hb === 3 ? SPARSE_JUNGLE : JUNGLE;

  C.h = h; C.t = t; C.hu = hu; C.c = c; C.e = e; C.wd = wd; C.m = m; C.rf = chan ? 1 : 0; C.sw = sw; C.bw = bw; C.mi = mi;
  C.biome = b; C.tb = tb; C.hb = hb; C.wl = wl; C.rv = rv; C.S = S;
  return h;
}

function biomeAt(x, z) {
  climate(Math.floor(x), Math.floor(z));
  const id = C.biome;
  let name = NAMES[id];
  if (id === OCEAN) name = (C.h < (GEN >= 3 ? -30 : 36) ? "Deep " : "") + ["Frozen ", "Cold ", "", "Lukewarm ", "Warm "][C.tb] + "Ocean";
  else if (id === RIVER && C.tb === 0) name = "Frozen River";
  return { name, id, height: C.h, temperature: +C.t.toFixed(2), humidity: +C.hu.toFixed(2) };
}

// ---------- tints (grass / foliage / water multipliers) ----------
// Climate-based colormap, continuous in temperature/humidity so borders blend smoothly.
const tintCache = new Map();   // chunk key -> Float32Array(256 * 9), filled by generate()
const TINT_MAX = 1500;
function tintCompute(x, z, out, o) {
  fields(x, z);
  const { t, hu, c } = K;
  const hot = smooth(-0.35, 0.45, t), wet = smooth(-0.35, 0.45, hu);
  const cold = 1 - smooth(-0.42, -0.12, t);
  // base: temperate green; hot+dry -> olive; hot+wet -> vivid jungle; cold -> blue-green
  let gr = 0.78, gg = 1.0, gb = 0.62;
  const dry = hot * (1 - wet), jung = hot * wet;
  gr += dry * 0.32 - jung * 0.18 - cold * 0.12; gg += -dry * 0.1 + jung * 0.12 - cold * 0.08; gb += -dry * 0.22 - jung * 0.14 + cold * 0.22;
  // swamp murk and badlands dullness use the same weights as the terrain
  const land = smooth(-0.13, -0.02, c);
  const sw = smooth(0.2, 0.36, hu) * smooth(-0.2, -0.06, t) * (1 - smooth(0.02, 0.3, c)) * land;
  const bw = smooth(0.26, 0.36, t) * (1 - smooth(-0.14, -0.04, hu)) * smooth(0.0, 0.18, K.wd) * land;
  gr = lerp(gr, 0.62, sw); gg = lerp(gg, 0.72, sw); gb = lerp(gb, 0.4, sw);
  gr = lerp(gr, 0.92, bw); gg = lerp(gg, 0.78, bw); gb = lerp(gb, 0.5, bw);
  out[o] = gr; out[o + 1] = gg; out[o + 2] = gb;
  out[o + 3] = gr * 0.9; out[o + 4] = gg * 0.95; out[o + 5] = gb * 0.88;        // foliage a bit deeper
  // water: temperate blue, warm turquoise, cold deep blue, swamp murky green
  let wr = 0.85, wg = 0.95, wb = 1.0;
  const warm = smooth(0.1, 0.45, t);
  wr += -warm * 0.25 - cold * 0.2; wg += warm * 0.2 - cold * 0.12; wb += -warm * 0.05 + cold * 0.05;
  wr = lerp(wr, 0.75, sw); wg = lerp(wg, 0.82, sw); wb = lerp(wb, 0.5, sw);
  out[o + 6] = wr; out[o + 7] = wg; out[o + 8] = wb;
}
const tintTmp = new Float32Array(9);
function tintAt(x, z) {
  x = Math.floor(x); z = Math.floor(z);
  const CS = BF.CS, cx = Math.floor(x / CS), cz = Math.floor(z / CS);
  const arr = tintCache.get(cx + "," + cz);
  let a = tintTmp, o = 0;
  if (arr) { a = arr; o = ((z - cz * CS) * CS + (x - cx * CS)) * 9; }
  else tintCompute(x, z, tintTmp, 0);
  return { grass: [a[o], a[o + 1], a[o + 2]], foliage: [a[o + 3], a[o + 4], a[o + 5]], water: [a[o + 6], a[o + 7], a[o + 8]] };
}
// Tint varies slowly: compute on a 4-block grid per chunk and interpolate.
function fillTint(cx, cz) {
  const CS = BF.CS, key = cx + "," + cz;
  if (tintCache.has(key)) return;
  const g = new Float32Array(25 * 9), out = new Float32Array(CS * CS * 9);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) tintCompute(cx * CS + i * 4, cz * CS + j * 4, g, (j * 5 + i) * 9);
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const i = x >> 2, j = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
    const a = (j * 5 + i) * 9, b = a + 9, c = a + 45, d = a + 54, o = (z * CS + x) * 9;
    for (let k = 0; k < 9; k++)
      out[o + k] = (g[a + k] * (1 - fx) + g[b + k] * fx) * (1 - fz) + (g[c + k] * (1 - fx) + g[d + k] * fx) * fz;
  }
  tintCache.set(key, out);
  if (tintCache.size > TINT_MAX) tintCache.delete(tintCache.keys().next().value);
}

// Caves may break through the surface only in these patches (trees avoid them).
const entranceAt = (x, z) => noise.n2(x / 90 + 33.3, z / 90 - 71.1) > 0.62;

// ---------- villages ----------
// One candidate per REGION x REGION area (regions centred on multiples of REGION, so a region village
// never crosses a region border). The spawn village is searched outward from the spawn point.
const REGION = 384, RHALF = 192, VLIM = 70;
const VILLAGE_BIOMES = [PLAINS, SAVANNA, DESERT, SNOWY_PLAINS, TAIGA, MEADOW];
const villageCache = new Map();
let spawnXZ = null;
const regionOf = v => Math.floor((v + RHALF) / REGION);

// Mirrors main.js's spawn search (terrain only); main then moves the player to the nearest village.
function findSpawn() {
  if (spawnXZ) return spawnXZ;
  let sx = 8, sz = 8;
  for (let r = 0; r < 400; r += 8) {
    const a = r * 0.7, x = Math.round(Math.cos(a) * r) + 8, z = Math.round(Math.sin(a) * r) + 8;
    if (climate(x, z) > BF.SEA + 1 && !C.rv) { sx = x; sz = z; break; }
  }
  return (spawnXZ = [sx, sz]);
}

// relaxed: 0 strict, 1 also forests/snowy taiga, 2 (spawn village only) also beaches, hills, cherry groves
function siteOK(x, z, relaxed) {
  const SEA = BF.SEA;
  const h0 = climate(x, z), b = C.biome;
  if (h0 <= SEA || C.rv) return false;
  if (!(VILLAGE_BIOMES.includes(b) || (relaxed && (b === FOREST || b === BIRCH || b === SNOWY_TAIGA || b === FLOWER_FOREST)) ||
      (relaxed > 1 && (b === BEACH || b === MOUNTAINS || b === CHERRY || b === SPARSE_JUNGLE)) ||
      (relaxed > 2 && b !== OCEAN && b !== RIVER && b !== PEAKS && b !== STONY_PEAKS && b !== MUSHROOM))) return false;
  let lo = h0, hi = h0, wet = 0, bad = 0;
  for (let dz = -28; dz <= 28; dz += 7) for (let dx = -28; dx <= 28; dx += 7) {
    const h = climate(x + dx, z + dz), bb = C.biome;
    if (h <= SEA || C.rv) wet++;
    if (h < lo) lo = h; if (h > hi) hi = h;
    if ((bb === MOUNTAINS && relaxed < 2) || bb === PEAKS || bb === STONY_PEAKS || bb === SNOWY_SLOPES || bb === OCEAN ||
        bb === RIVER || bb === JUNGLE || bb === SWAMP || bb === MANGROVE || bb === DARK_FOREST || bb === BADLANDS) bad++;
  }
  return wet <= [4, 8, 10, 14][relaxed] && hi - lo <= [9, 12, 15, 18][relaxed] && bad <= [3, 8, 12, 81][relaxed];
}

function villageRegion(rx, rz) {
  const key = rx + "," + rz;
  let v = villageCache.get(key);
  if (v !== undefined) return v;
  v = null;
  const rcx = rx * REGION, rcz = rz * REGION;
  const sv = spawnVillage();
  if (noise.hash(rx, rz, 501) < 0.85) {
    for (let k = 0; k < 12 && !v; k++) {
      const x = rcx + Math.round((noise.hash(rx, rz, 510 + k) * 2 - 1) * VLIM);
      const z = rcz + Math.round((noise.hash(rx, rz, 520 + k) * 2 - 1) * VLIM);
      if (sv && Math.abs(x - sv.x) < 260 && Math.abs(z - sv.z) < 260) continue;   // keep clear of the spawn village
      if (siteOK(x, z, 0)) v = layoutVillage(x, z, null);
    }
  }
  villageCache.set(key, v);
  return v;
}
let spawnV;
function spawnVillage() {
  if (spawnV !== undefined) return spawnV;
  spawnV = null;
  const [sx, sz] = findSpawn();
  outer: for (let r = 80; r <= 320; r += 8)  // a village somewhere nearby, but not on top of spawn
    for (const relaxed of r < 120 ? [0, 1, 2] : [0, 1, 2, 3]) {
      const n = Math.max(8, Math.round(r / 3));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r;
        const x = Math.round(sx + Math.cos(a) * r), z = Math.round(sz + Math.sin(a) * r);
        if (siteOK(x, z, relaxed) && (spawnV = layoutVillage(x, z, [sx, sz]))) break outer;
      }
    }
  return spawnV;
}
function inVillage(v, x, z, m) { return !!v && x >= v.minX - m && x <= v.maxX + m && z >= v.minZ - m && z <= v.maxZ + m; }
function villageAt(x, z, m) {
  const sv = spawnVillage();
  if (inVillage(sv, x, z, m)) return sv;
  const v = villageRegion(regionOf(x), regionOf(z));
  return inVillage(v, x, z, m) ? v : null;
}

const BTYPES = {
  house: [5, 5], house2: [5, 6], lhouse: [7, 7], big: [7, 7], library: [9, 7], church: [5, 10],
  smith: [7, 6], farm: [9, 7], bigfarm: [13, 9], pen: [9, 8], hay: [3, 3],
};
const LIVABLE = { house: 1, house2: 1, lhouse: 1, big: 1, library: 1, church: 1, smith: 1 };
// Beds of a building in its local coords (u along the road, q inward): [footU, footQ, axis the head lies along (+1)].
function bedPlan(b) {
  const { w, d, du } = b;
  switch (b.type) {
    case "house": return [[w - 2, d - 3, "q"]];
    case "big": return [[du - 1, d - 3, "q"], [du + 1, d - 3, "q"]];
    case "house2": return [[1, d - 3, "q"], [w - 2, d - 3, "q"]];
    case "lhouse": return [[(b.h < 0.5 ? 0 : w - 3) + 1, 4, "q"]];
    case "library": return [[w - 3, 3, "u"]];
    case "church": return [[1, d - 4, "q"]];
    case "smith": return [[du + 1, d - 3, "q"]];
  }
  return [];
}
const bedFacing = (b, axis) => axis === "u" ? BF.dirIndex(b.ax, b.az) : BF.dirIndex(b.sx, b.sz);

// Village layout: plaza + well + bell, up to 4 main roads with side streets, 8-25 buildings, lamps.
function layoutVillage(cx, cz, spawn) {
  const SEA = BF.SEA;
  const y0 = climate(cx, cz), biome = C.biome;
  const style = biome === DESERT ? 1 : (biome === SNOWY_PLAINS || biome === SNOWY_TAIGA || C.tb === 0) ? 2 :
    biome === SAVANNA ? 3 : (biome === TAIGA || C.tb === 1) ? 4 : 0;
  let s = ((noise.hash(cx, cz, 601) * 4294967296) >>> 0) || 1;
  const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const v = { x: cx, y: y0, z: cz, biome: NAMES[biome], style, pads: [], roads: [], lamps: [], decor: [], buildings: [], houses: [],
    minX: cx - 7, maxX: cx + 7, minZ: cz - 7, maxZ: cz + 7, minY: y0 };
  const occ = [];
  const overlaps = a => occ.some(o => a[0] <= o[2] && a[2] >= o[0] && a[1] <= o[3] && a[3] >= o[1]);
  const covers = (a, m) => spawn && spawn[0] >= a[0] - m && spawn[0] <= a[2] + m && spawn[1] >= a[1] - m && spawn[1] <= a[3] + m;
  const plaza = [cx - 7, cz - 7, cx + 7, cz + 7];
  if (covers(plaza, 1)) return null;
  occ.push(plaza);
  v.pads.push({ x0: plaza[0], z0: plaza[1], x1: plaza[2], z1: plaza[3], y: y0, path: true });

  // roads: walk outward from (sx, sz) along (dx, dz) following terrain
  const roads = [];
  function addRoad(sx, sz, dx, dz, maxLen, minLen) {
    let prev = climate(sx, sz), end = -1;
    if (prev < SEA || C.rv) return null;
    for (let t = 0; t <= maxLen; t++) {
      const x = sx + dx * t, z = sz + dz * t;
      if (Math.abs(x - cx) > 64 || Math.abs(z - cz) > 64) break;
      const h = climate(x, z);
      if (h < SEA || C.rv || Math.abs(h - prev) > 2) break;
      prev = h; end = t;
    }
    if (end < minLen) return null;
    const ex = sx + dx * end, ez = sz + dz * end;
    const box = [Math.min(sx, ex) - (dz ? 1 : 0), Math.min(sz, ez) - (dx ? 1 : 0), Math.max(sx, ex) + (dz ? 1 : 0), Math.max(sz, ez) + (dx ? 1 : 0)];
    if (overlaps(box)) return null;
    const road = { sx, sz, dx, dz, end, x0: box[0], z0: box[1], x1: box[2], z1: box[3] };
    roads.push(road); v.roads.push(road); occ.push(box);
    return road;
  }
  const mains = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const r = addRoad(cx + dx * 8, cz + dz * 8, dx, dz, 30 + ((rand() * 20) | 0), 10);
    if (r) mains.push(r);
  }
  if (mains.length < 2) return null;
  // side streets branching off the main roads
  for (const r of mains) {
    for (let k = 0; k < 2; k++) {
      const t = 10 + k * 16 + ((rand() * 6) | 0);
      if (t > r.end - 4) break;
      const side = rand() < 0.5 ? 1 : -1;
      const px = r.dz ? side : 0, pz = r.dx ? side : 0;
      addRoad(r.sx + r.dx * t + px * 2, r.sz + r.dz * t + pz * 2, px, pz, 14 + ((rand() * 14) | 0), 8);
    }
  }

  // buildings beside the roads
  const caps = { smith: 1, church: 1, library: 1, pen: 3, bigfarm: 2 }, count = {};
  const pick = () => {
    const r = rand();
    const ty = r < 0.24 ? "house" : r < 0.36 ? "house2" : r < 0.46 ? "lhouse" : r < 0.55 ? "big" : r < 0.6 ? "library" :
      r < 0.65 ? "church" : r < 0.7 ? "smith" : r < 0.82 ? "farm" : r < 0.87 ? "bigfarm" : r < 0.94 ? "pen" : "hay";
    if (caps[ty] && (count[ty] || 0) >= caps[ty]) return "house";
    return ty;
  };
  for (const road of roads) for (const side of [1, -1]) {
    const { dx, dz } = road;
    const sx = dz ? side : 0, sz = dx ? side : 0;       // unit vector away from the road
    let t = 1 + ((rand() * 3) | 0);
    while (t < road.end && v.buildings.length < 25) {
      const type = pick();
      let [w, d] = BTYPES[type];
      if (type === "house" && rand() < 0.5) d = 6;
      if (t + w - 1 > road.end + 1) break;
      const bx = road.sx + dx * t + sx * 3, bz = road.sz + dz * t + sz * 3;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(0, 0), c1 = P(w - 1, d - 1);
      const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
      let ok = Math.abs(box[0] - cx) < 72 && Math.abs(box[2] - cx) < 72 && Math.abs(box[1] - cz) < 72 && Math.abs(box[3] - cz) < 72 &&
        !overlaps(box) && !covers(box, 1);
      const du = w >> 1, door = P(du, 0), front = P(du, -1);
      const y = ok ? climate(front[0], front[1]) : 0;
      if (ok && (y < SEA || C.rv)) ok = false;
      const tol = type === "farm" || type === "bigfarm" || type === "hay" || type === "pen" ? 3 : 5;
      // check the plot's border ring and a sparse interior grid
      for (let q = -1; ok && q <= d; q++) for (let u = -1; u <= w; u += (q === -1 || q === d) ? 1 : w + 1) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > tol) { ok = false; break; }
      }
      for (let q = 1; ok && q < d - 1; q += 2) for (let u = 1; u < w - 1; u += 2) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > tol) { ok = false; break; }
      }
      if (!ok) { t += 2; continue; }
      count[type] = (count[type] || 0) + 1;
      const b = { type, w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
        x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 607) };
      v.buildings.push(b);
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      if (LIVABLE[type]) {
        const beds = bedPlan(b).map(([u, q, a]) => { const p = P(u, q); return { x: p[0], y: y + 1, z: p[1], f: bedFacing(b, a) }; });
        v.houses.push({ x: b.x0, y, z: b.z0, w: b.x1 - b.x0 + 1, d: b.z1 - b.z0 + 1, doorX: b.doorX, doorZ: b.doorZ,
          outX: front[0], outZ: front[1], type, beds });
      }
      t += w + 2;
    }
  }
  if (v.buildings.length < 8) return null;

  // Shepherd pens (gen 3+): the jobs plan (js/jobs.js) makes some villagers shepherds, and each one is given a fenced pen with its loom
  // beside it. Pens the layout already rolled are used first; missing ones are added here, after everything else, so no other plot moves.
  // v.nb0 keeps the building count of the original layout: the villager roster keys off it (js/mobs.js), so these pens never change it.
  v.nb0 = v.buildings.length;
  if (GEN >= 3 && BF.jobs && BF.jobs.shepherdCount) {
    let need = 0;
    try { need = Math.min(BF.jobs.shepherdCount(v), 4); } catch (e) { need = 0; }
    let have = v.buildings.filter(b => b.type === "pen").length;
    const [w, d] = BTYPES.pen;
    for (const road of roads) for (const side of [1, -1]) {
      const { dx, dz } = road, sx = dz ? side : 0, sz = dx ? side : 0;
      for (let t = 1; t + w - 1 <= road.end + 1 && have < need; t += 2) {
        const bx = road.sx + dx * t + sx * 3, bz = road.sz + dz * t + sz * 3;
        const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
        const c0 = P(0, 0), c1 = P(w - 1, d - 1);
        const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
        let ok = Math.abs(box[0] - cx) < 72 && Math.abs(box[2] - cx) < 72 && Math.abs(box[1] - cz) < 72 && Math.abs(box[3] - cz) < 72 && !overlaps(box) && !covers(box, 1);
        const du = w >> 1, door = P(du, 0), front = P(du, -1);
        const y = ok ? climate(front[0], front[1]) : 0;
        if (ok && (y < SEA || C.rv)) ok = false;
        for (let q = -1; ok && q <= d; q++) for (let u = -1; u <= w; u += (q === -1 || q === d) ? 1 : w + 1) {
          const p = P(u, q), h = climate(p[0], p[1]);
          if (h < SEA || C.rv || Math.abs(h - y) > 3) { ok = false; break; }
        }
        for (let q = 1; ok && q < d - 1; q += 2) for (let u = 1; u < w - 1; u += 2) {
          const p = P(u, q), h = climate(p[0], p[1]);
          if (h < SEA || C.rv || Math.abs(h - y) > 3) { ok = false; break; }
        }
        if (!ok) continue;
        v.buildings.push({ type: "pen", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
          x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 607) });
        occ.push(box);
        v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
        have++; t += w;
      }
    }
  }

  // lamps on the plaza corners and along road edges
  v.lamps.push([cx - 7, cz - 7], [cx + 7, cz - 7], [cx - 7, cz + 7], [cx + 7, cz + 7]);
  for (const road of roads) {
    let side = 1;
    for (let t = 4; t <= road.end; t += 9, side = -side) {
      const x = road.sx + road.dx * t + (road.dz ? side * 2 : 0), z = road.sz + road.dz * t + (road.dx ? side * 2 : 0);
      if (overlaps([x, z, x, z]) || climate(x, z) < SEA || C.rv) continue;
      v.lamps.push([x, z]);
    }
  }
  // meeting square decorations (keep the spawn spot cx+4, cz+4 clear)
  v.decor.push([cx - 5, cz + 5, "hay"], [cx - 6, cz + 5, "hay"], [cx - 5, cz + 6, "hay2"], [cx + 5, cz - 6, "stall"],
    [cx - 6, cz - 5, "flowers"], [cx + 6, cz + 1, "flowers"]);
  // entry arch + auto sign (js/signs.js): planned on the layout so its footprint is inside the village box (trees, caves, builders keep clear)
  if (BF.signs && BF.signs.planArch) {
    try { v.arch = BF.signs.planArch(v, { climate: (x, z) => climate(x, z), spawn: !!spawn, region: [regionOf(cx), regionOf(cz)] }); } catch (e) { console.error(e); v.arch = null; }
    if (v.arch) occ.push(v.arch.box);
  }
  for (const o of occ) {
    v.minX = Math.min(v.minX, o[0]); v.minZ = Math.min(v.minZ, o[1]);
    v.maxX = Math.max(v.maxX, o[2]); v.maxZ = Math.max(v.maxZ, o[3]);
  }
  for (const [x, z] of v.lamps) {
    v.minX = Math.min(v.minX, x); v.maxX = Math.max(v.maxX, x); v.minZ = Math.min(v.minZ, z); v.maxZ = Math.max(v.maxZ, z);
  }
  for (const p of v.pads) v.minY = Math.min(v.minY, p.y);
  v.ground = biome === DESERT ? 1 : style === 2 ? 2 : 0;
  return v;
}

function padAt(v, x, z) {
  for (const p of v.pads) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return p;
  return null;
}

function villagesNear(x, z, radius) {
  const out = [], sv = spawnVillage();
  if (sv && Math.hypot(sv.x - x, sv.z - z) <= radius) out.push(sv);
  for (let rz = regionOf(z - radius); rz <= regionOf(z + radius); rz++)
    for (let rx = regionOf(x - radius); rx <= regionOf(x + radius); rx++) {
      const v = villageRegion(rx, rz);
      if (v && Math.hypot(v.x - x, v.z - z) <= radius) out.push(v);
    }
  return out;
}
function nearestVillage(x, z) {
  let best = null, bd = Infinity;
  for (const v of villagesNear(x, z, REGION * 1.5)) {
    const d = Math.hypot(v.x - x, v.z - z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

// Village block palettes per style: 0 plains, 1 desert, 2 snowy, 3 savanna, 4 taiga.
let STY = null;
function styles() {
  const B = BF.B;
  return STY || (STY = [
    { found: B.cobblestone, wall: B.planks, corner: B.oak_log, roof: B.spruce_planks, floor: B.planks, well: B.cobblestone, flat: false, log: B.oak_log },
    { found: B.sandstone, wall: B.sandstone, corner: B.sandstone_bricks, roof: B.sandstone_bricks, floor: B.sandstone, well: B.sandstone_bricks, flat: true, log: B.sandstone_bricks },
    { found: B.cobblestone, wall: B.spruce_planks, corner: B.spruce_log, roof: B.planks, floor: B.spruce_planks, well: B.cobblestone, flat: false, log: B.spruce_log },
    { found: B.cobblestone, wall: B.acacia_planks, corner: B.acacia_log, roof: B.orange_terracotta, floor: B.acacia_planks, well: B.cobblestone, flat: false, log: B.acacia_log },
    { found: B.cobblestone, wall: B.spruce_planks, corner: B.spruce_log, roof: B.dark_oak_log, floor: B.spruce_planks, well: B.mossy_cobblestone, flat: false, log: B.spruce_log },
  ]);
}

// Writes the parts of village v inside chunk (ox, oz). hAt(x, z) = terrain height for in-chunk columns.
function drawVillage(v, ox, oz, vox, hAt) {
  const { CS, H, SEA, B } = BF;
  if (v.maxX < ox || v.minX >= ox + CS || v.maxZ < oz || v.minZ >= oz + CS) return;
  const S = styles()[v.style];
  const ground = [B.grass, B.sand, B.snow_grass][v.ground], fill = v.ground === 1 ? B.sand : B.dirt;
  const yLo = Math.max(WY0, BF.MIN_Y + 1), yHi = Math.min(WY1, H);
  const set = (x, y, z, id) => {
    x -= ox; z -= oz;
    if (x < 0 || x >= CS || z < 0 || z >= CS || y < yLo || y >= yHi) return;
    vox[((y - WY0) * CS + z) * CS + x] = id;
  };
  const isect = (x0, z0, x1, z1) => !(x1 < ox || x0 >= ox + CS || z1 < oz || z0 >= oz + CS);

  // levelled pads (terraced plots: fill below with a foundation, clear above)
  for (const p of v.pads) {
    if (!isect(p.x0, p.z0, p.x1, p.z1)) continue;
    for (let z = Math.max(p.z0, oz); z <= Math.min(p.z1, oz + CS - 1); z++)
      for (let x = Math.max(p.x0, ox); x <= Math.min(p.x1, ox + CS - 1); x++) {
        const h = hAt(x, z);
        for (let y = p.y + 1; y <= Math.max(h, SEA) + 1; y++) set(x, y, z, 0);
        for (let y = h; y < p.y; y++) set(x, y, z, y < p.y - 1 ? S.found : fill);
        set(x, p.y, z, p.path ? B.dirt_path : ground);
      }
  }
  // roads follow the terrain; planks bridge any water
  for (const r of v.roads) {
    if (!isect(r.x0, r.z0, r.x1, r.z1)) continue;
    for (let z = Math.max(r.z0, oz); z <= Math.min(r.z1, oz + CS - 1); z++)
      for (let x = Math.max(r.x0, ox); x <= Math.min(r.x1, ox + CS - 1); x++) {
        const h = hAt(x, z);
        if (h >= SEA) { set(x, h, z, B.dirt_path); set(x, h + 1, z, 0); set(x, h + 2, z, 0); }
        else set(x, SEA, z, B.planks);
      }
  }
  // well with a bell hanging under its roof
  const { x: cx, y: y0, z: cz } = v;
  if (isect(cx - 1, cz - 1, cx + 2, cz + 2)) {
    for (let z = cz - 1; z <= cz + 2; z++) for (let x = cx - 1; x <= cx + 2; x++) {
      const ring = x === cx - 1 || x === cx + 2 || z === cz - 1 || z === cz + 2;
      if (ring) { set(x, y0, z, S.well); set(x, y0 + 1, z, S.well); }
      else { for (let y = y0 - 2; y <= y0; y++) set(x, y, z, B.water); set(x, y0 - 3, z, S.well); }
      if ((x === cx - 1 || x === cx + 2) && (z === cz - 1 || z === cz + 2)) { set(x, y0 + 2, z, B.oak_fence); set(x, y0 + 3, z, B.oak_fence); }
      set(x, y0 + 4, z, S.well);
    }
    set(cx, y0 + 3, cz, B.bell);
  }
  // square decorations
  for (const [x, z, k] of v.decor) {
    if (x < ox - 1 || x >= ox + CS || z < oz || z >= oz + CS) continue;
    if (k === "hay") set(x, y0 + 1, z, B.hay_bale);
    else if (k === "hay2") { set(x, y0 + 1, z, B.hay_bale); set(x, y0 + 2, z, B.hay_bale); }
    else if (k === "stall") { set(x, y0 + 1, z, B.crafting_table); set(x + 1, y0 + 1, z, B.chest); }
    else if (k === "flowers") { set(x, y0, z, v.ground === 1 ? B.sand : B.grass); set(x, y0 + 1, z, v.ground === 1 ? B.dead_bush : B.poppy); }
  }
  // lamps
  for (const [x, z] of v.lamps) {
    if (x < ox || x >= ox + CS || z < oz || z >= oz + CS) continue;
    const p = padAt(v, x, z), g = p ? p.y : hAt(x, z);
    set(x, g + 1, z, B.oak_fence); set(x, g + 2, z, B.oak_fence); set(x, g + 3, z, B.lantern);
  }
  // buildings (local coords: u along the road, q away from it, door wall at q = 0)
  for (const b of v.buildings) {
    if (!isect(b.x0 - 1, b.z0 - 1, b.x1 + 1, b.z1 + 1)) continue;
    const P = (u, y, q, id) => set(b.bx + b.ax * u + b.sx * q, y, b.bz + b.az * u + b.sz * q, id);
    drawBuilding(b, P, S, v.style);
  }
  // villager jobsite blocks (js/jobs.js): planned once per village (count on a bell curve around the villagers who need a job), deterministic
  if (BF.jobs && BF.jobs.planVillage) {
    if (!v.jobsites) v.jobsites = BF.jobs.planVillage(v);
    for (const j of v.jobsites) if (j.id != null) set(j.x, j.y, j.z, j.id);
  }
  if (v.arch && BF.signs && BF.signs.drawArch) BF.signs.drawArch(v, set, styles()[v.style]); // entry arch + village sign (js/signs.js)
}

// A box room: foundation ring + floor at y, walls y+1..y+Hh, log corners, air inside.
function box(P, S, u0, q0, w, d, y, Hh, wall, floor) {
  for (let q = q0; q < q0 + d; q++) for (let u = u0; u < u0 + w; u++) {
    const eu = u === u0 || u === u0 + w - 1, eq = q === q0 || q === q0 + d - 1;
    P(u, y, q, eu || eq ? S.found : floor);
    for (let k = 1; k <= Hh; k++) P(u, y + k, q, eu && eq ? S.corner : eu || eq ? wall : 0);
  }
}
// Stepped gable roof over [u0, u0+w) x [q0, q0+d); ridge along the longer side; gable ends filled.
function roof(P, S, u0, q0, w, d, top, wall, mat) {
  const alongU = w >= d, Sx = alongU ? d : w, L = alongU ? w : d;
  for (let i = -1; i <= Sx; i++) {
    const rise = Math.min(i + 1, Sx - i), ry = top + rise;
    for (let j = 0; j < L; j++) {
      const u = u0 + (alongU ? j : i), q = q0 + (alongU ? i : j);
      P(u, ry, q, mat);
      if (i >= 0 && i < Sx && (j === 0 || j === L - 1)) for (let yy = top + 1; yy < ry; yy++) P(u, yy, q, wall);
    }
  }
}
function flatRoof(P, u0, q0, w, d, y, mat, rim) {
  for (let q = q0; q < q0 + d; q++) for (let u = u0; u < u0 + w; u++)
    P(u, y, q, rim && (u === u0 || u === u0 + w - 1 || q === q0 || q === q0 + d - 1) ? rim : mat);
}
function windows(P, u0, q0, w, d, y, skipFront) {
  const G = BF.B.glass;
  for (let u = u0 + 2; u < u0 + w - 2; u += 2) { P(u, y, q0 + d - 1, G); if (!skipFront && w >= 7) P(u, y, q0, G); }
  for (let q = q0 + 2; q < q0 + d - 1; q += 2) { P(u0, y, q, G); P(u0 + w - 1, y, q, G); }
}

const v_ground = style => style === 1 ? BF.B.sand : style === 2 ? BF.B.snow_grass : BF.B.grass;
function drawBuilding(b, P, S, style) {
  drawShell(b, P, S, style);
  for (const [u, q, a] of bedPlan(b)) {
    const f = bedFacing(b, a), hu = a === "u" ? 1 : 0;
    P(u, b.y + 1, q, BF.bedId(f, 0)); P(u + hu, b.y + 1, q + 1 - hu, BF.bedId(f, 1));
  }
}
function drawShell(b, P, S, style) {
  const B = BF.B;
  const { w, d, y, du } = b;
  const flat = S.flat;
  // a closed oak door in the front wall, facing out towards the road
  const out = BF.dirIndex(-b.sx, -b.sz);
  const door = () => { P(du, y + 1, 0, BF.doorId(out, 0, 0)); P(du, y + 2, 0, BF.doorId(out, 1, 0)); P(du, y, -1, B.dirt_path); };
  switch (b.type) {
    case "farm": case "bigfarm": {
      const mids = b.type === "farm" ? [w >> 1] : [4, 8];
      // crop weights per style [wheat, carrots, potatoes, beetroots]: desert few beets, snowy more potatoes
      const WT = [[4, 2, 2, 1.5], [5, 2, 2, 0.4], [2, 1.5, 4, 1.5], [4, 2.5, 1.5, 1], [3, 1.5, 3, 1.5]][style];
      const CROPS = [B.wheat, B.carrots, B.potatoes, B.beetroots], tot = WT[0] + WT[1] + WT[2] + WT[3];
      const pickCrop = r => { r *= tot; for (let k = 0; k < 4; k++) { if ((r -= WT[k]) < 0) return CROPS[k]; } return B.wheat; };
      // each section (between water channels) is split into bands of 2 rows; each band picks a crop
      const pumpkinBand = noise.hash(b.bx, b.bz, 621) < 0.25 ? 1 + ((noise.hash(b.bx, b.bz, 622) * ((d - 2) >> 1)) | 0) : -1;
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        if (u === 0 || u === w - 1 || q === 0 || q === d - 1) { P(u, y, q, S.log); continue; }
        if (mids.includes(u)) { P(u, y, q, B.water); continue; }
        let sec = 0; for (const m of mids) if (u > m) sec++;
        const bandIx = (q - 1) >> 1;
        if (sec === 0 && bandIx === pumpkinBand) {            // a small pumpkin patch on plain soil
          P(u, y, q, v_ground(style)); P(u, y + 1, q, (u + q) % 3 === 0 ? B.pumpkin : 0);
          continue;
        }
        P(u, y, q, B.farmland);
        P(u, y + 1, q, pickCrop(noise.hash(b.bx * 7 + sec, b.bz * 13 + bandIx, 623)));
      }
      return;
    }
    case "hay":
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const r = noise.hash(b.bx + u, b.bz + q, 611);
        if (r < 0.8) P(u, y + 1, q, B.hay_bale);
        if ((u === 1 && q === 1) || r < 0.2) P(u, y + 2, q, B.hay_bale);
      }
      return;
    case "pen": {
      // fenced animal pen with a gate facing the road (a gap before gen 3), a trough and hay
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const edge = u === 0 || u === w - 1 || q === 0 || q === d - 1;
        if (edge && !(q === 0 && u === du)) P(u, y + 1, q, B.oak_fence);
      }
      if (GEN >= 3 && BF.gateId) P(du, y + 1, 0, BF.gateId(b.ax !== 0 ? "x" : "z", 0));
      P(1, y + 1, d - 2, B.hay_bale); P(2, y + 1, d - 2, B.hay_bale); P(w - 2, y, d - 2, B.water);
      P(du, y, -1, B.dirt_path);
      return;
    }
    case "smith": {
      const wall = style === 1 ? B.sandstone : B.cobblestone;
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const eu = u === 0 || u === w - 1, eq = q === d - 1;
        P(u, y, q, S.found);
        for (let k = 1; k <= 3; k++) P(u, y + k, q, (eu && q === 0) ? B.oak_fence : eu || eq || q === 0 ? wall : 0);
      }
      flatRoof(P, 0, 0, w, d, y + 4, flat ? S.roof : B.planks, flat ? 0 : S.corner);
      door(); P(1, y + 2, 0, B.glass); P(w - 2, y + 2, 0, B.glass);
      P(1, y + 1, d - 2, B.furnace); P(2, y + 1, d - 2, B.furnace); P(w - 2, y + 1, d - 2, B.chest); P(w - 2, y + 1, d - 3, B.crafting_table);
      P(1, y + 1, 1, B.lantern);
      return;
    }
    case "church": {
      // nave at the front, bell tower over the back 5x5
      const wall = style === 1 ? B.sandstone_bricks : B.cobblestone;
      box(P, S, 0, 0, w, d, y, 5, wall, S.floor);
      for (let q = d - 5; q < d; q++) for (let u = 0; u < w; u++) {
        const eu = u === 0 || u === w - 1, eq = q === d - 5 || q === d - 1;
        if (!(eu || eq)) continue;
        for (let k = 6; k <= 12; k++) {
          const corner = eu && eq, open = k >= 10 && k <= 11 && !corner;
          P(u, y + k, q, open ? 0 : corner ? S.corner : wall);
        }
      }
      flatRoof(P, 0, d - 5, w, 5, y + 13, wall, 0);
      P(2, y + 11, d - 3, B.bell); P(2, y + 10, d - 3, B.oak_fence); P(2, y + 14, d - 3, B.lantern);
      if (flat) flatRoof(P, 0, 0, w, d - 5, y + 6, S.roof, 0);
      else roof(P, S, 0, 0, w, d - 4, y + 5, wall, S.roof);
      door(); P(du, y + 3, 0, B.glass);
      for (let q = 2; q < d - 1; q += 2) { P(0, y + 2, q, B.glass); P(0, y + 3, q, B.glass); P(w - 1, y + 2, q, B.glass); P(w - 1, y + 3, q, B.glass); }
      P(2, y + 1, d - 2, B.crafting_table);
      return;
    }
    case "library": {
      box(P, S, 0, 0, w, d, y, 5, S.wall, S.floor);
      windows(P, 0, 0, w, d, y + 2, false); windows(P, 0, 0, w, d, y + 3, false);
      if (flat) flatRoof(P, 0, 0, w, d, y + 6, S.roof, 0); else roof(P, S, 0, 0, w, d, y + 5, S.wall, S.roof);
      door();
      for (let u = 1; u < w - 1; u++) { P(u, y + 1, d - 2, u % 2 ? B.chest : S.wall); P(u, y + 2, d - 2, S.wall); }   // shelves
      P(1, y + 1, 1, B.crafting_table); P(w - 2, y + 1, 1, B.lantern);
      return;
    }
    case "lhouse": {
      // front wing along the road + back wing on one side
      const side = b.h < 0.5 ? 0 : w - 3;
      box(P, S, 0, 0, w, 4, y, 3, S.wall, S.floor);
      box(P, S, side, 3, 3, d - 3, y, 3, S.wall, S.floor);
      P(side + 1, y + 1, 3, 0); P(side + 1, y + 2, 3, 0);
      if (flat) { flatRoof(P, 0, 0, w, 4, y + 4, S.roof, 0); flatRoof(P, side, 3, 3, d - 3, y + 4, S.roof, 0); }
      else { roof(P, S, 0, 0, w, 4, y + 3, S.wall, S.roof); roof(P, S, side, 4, 3, d - 4, y + 3, S.wall, S.roof); }
      door();
      P(1, y + 2, 0, B.glass); P(w - 2, y + 2, 0, B.glass); P(side + 1, y + 2, d - 1, B.glass);
      P(side === 0 ? w - 2 : 1, y + 1, 2, B.crafting_table);
      return;
    }
    case "house2": {
      // two storeys: upper floor with a stair-hole, log band between storeys
      box(P, S, 0, 0, w, d, y, 7, S.wall, S.floor);
      for (let q = 1; q < d - 1; q++) for (let u = 1; u < w - 1; u++) if (!(u === w - 2 && q === d - 2)) P(u, y + 4, q, S.floor);
      for (let q = 1; q < d - 1; q++) { P(0, y + 4, q, S.log); P(w - 1, y + 4, q, S.log); }
      windows(P, 0, 0, w, d, y + 2, true); windows(P, 0, 0, w, d, y + 6, false); P(1, y + 6, 0, B.glass); P(w - 2, y + 6, 0, B.glass);
      if (flat) flatRoof(P, 0, 0, w, d, y + 8, S.roof, 0); else roof(P, S, 0, 0, w, d, y + 7, S.wall, S.roof);
      door();
      P(1, y + 1, 1, B.crafting_table); P(1, y + 5, d - 2, B.chest);
      return;
    }
    default: {
      // house / big
      const Hh = b.type === "big" ? 4 : 3;
      box(P, S, 0, 0, w, d, y, Hh, S.wall, S.floor);
      windows(P, 0, 0, w, d, y + 2, false);
      if (flat) flatRoof(P, 0, 0, w, d, y + Hh + 1, S.roof, 0); else roof(P, S, 0, 0, w, d, y + Hh, S.wall, S.roof);
      door();
      if (b.type === "big" || b.h < 0.6) P(1, y + 1, d - 2, B.crafting_table);
      if (b.type === "big") { P(w - 2, y + 1, d - 2, B.chest); P(w - 2, y + 1, 1, B.lantern); }
    }
  }
}

// Surface height (terrain, levelled under village plazas and building plots).
function heightAt(x, z) {
  x = Math.floor(x); z = Math.floor(z);
  const h = climate(x, z);
  const v = villageAt(x, z, 0);
  if (v) { const p = padAt(v, x, z); if (p) return p.y; }
  return h;
}

// ---------- generation ----------
const M = 6;                       // tree margin around the chunk
const HW = 16 + 2;                 // height cache width (1-block margin)
const hCache = new Int16Array(HW * HW);
const bCache = new Uint8Array(HW * HW);
const tbCache = new Uint8Array(HW * HW);
const wlCache = new Int16Array(HW * HW);   // water level per column (sea level, or a river's surface)
// coarse cave grid (every 4 blocks)
const GX = 5, GY_MAX = 50;
const gA = new Float32Array(GX * GX * GY_MAX), gB = new Float32Array(GX * GX * GY_MAX), gC = new Float32Array(GX * GX * GY_MAX);
const colA = new Float32Array(GY_MAX), colB = new Float32Array(GY_MAX), colC = new Float32Array(GY_MAX);
let STRATA = null;                 // badlands terracotta bands (built from the seed)

let rs = 1;
const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;

// Highest extent (blocks above the ground) of whatever a tree-grid candidate of a biome can build; used to size the generator-3 band.
const TREE_EXT = [];
(function () {
  for (let b = 0; b <= MUSHROOM; b++) TREE_EXT[b] = 14;
  TREE_EXT[PLAINS] = 10; TREE_EXT[FOREST] = 11; TREE_EXT[FLOWER_FOREST] = 11; TREE_EXT[BIRCH] = 11; TREE_EXT[MEADOW] = 11; TREE_EXT[SWAMP] = 11;
  TREE_EXT[SAVANNA] = 12; TREE_EXT[CHERRY] = 12; TREE_EXT[DESERT] = 6; TREE_EXT[BADLANDS] = 6; TREE_EXT[SPARSE_JUNGLE] = 16;
  TREE_EXT[JUNGLE] = 36; TREE_EXT[OLD_TAIGA] = 36; TREE_EXT[ICE_SPIKES] = 38; TREE_EXT[MANGROVE] = 16; TREE_EXT[DARK_FOREST] = 15;
})();

// Per-chunk data shared by the generation passes (filled by prep): column caches, villages and the tree-grid candidates.
const P = { cx: 0, cz: 0, ox: 0, oz: 0, maxH: 0, minH: 0, topY: 0, hc: 0, vils: [], cands: [], ext: 0, vMin: 0, vMax: 0 };
let WY0 = 0, WY1 = 0;              // the vertical window being generated: absolute y in [WY0, WY1)
function prep(cx, cz) {
  const { CS, SEA, B } = BF;
  const ox = cx * CS, oz = cz * CS;
  if (!STRATA) {
    const cols = [B.orange_terracotta, B.yellow_terracotta, B.orange_terracotta, B.white_terracotta,
      B.brown_terracotta, B.orange_terracotta, B.red_terracotta, B.yellow_terracotta];
    STRATA = new Uint16Array(64);
    for (let i = 0; i < 64; i++) STRATA[i] = noise.hash(i, 0, 919) < 0.45 ? B.terracotta : cols[(noise.hash(i, 1, 919) * cols.length) | 0];
  }
  fillTint(cx, cz);

  // heights with a 1-block margin (slopes / water adjacency)
  for (let z = -1; z <= CS; z++) for (let x = -1; x <= CS; x++) {
    const i = (z + 1) * HW + x + 1;
    hCache[i] = climate(ox + x, oz + z);
    bCache[i] = C.biome; tbCache[i] = C.tb; wlCache[i] = C.wl;
  }
  let maxH = SEA, minH = 1e9, topY = -1e9;
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const hi = (z + 1) * HW + x + 1, h = hCache[hi];
    if (h > maxH) maxH = h;
    if (h < minH) minH = h;
    const t = h > wlCache[hi] ? h : wlCache[hi];
    if (t > topY) topY = t;
  }
  P.cx = cx; P.cz = cz; P.ox = ox; P.oz = oz; P.maxH = maxH; P.minH = minH; P.topY = topY; P.hc = hCache[(CS / 2 + 1) * HW + CS / 2 + 1];
  // villages touching this chunk (a chunk never straddles two regions; the spawn village may lie anywhere)
  const vils = P.vils = [villageRegion(regionOf(ox), regionOf(oz)), spawnVillage()].filter(v => v &&
    v.maxX + 2 >= ox && v.minX - 2 < ox + CS && v.maxZ + 2 >= oz && v.minZ - 2 < oz + CS);
  // tree-grid candidates (4x4 cells, margin M around the chunk)
  const cands = P.cands = [];
  let ext = 0;
  const x0 = ox - M, x1 = ox + CS + M, z0 = oz - M, z1 = oz + CS + M;
  for (let gz = Math.floor(z0 / 4); gz <= Math.floor((z1 - 1) / 4); gz++)
    for (let gx = Math.floor(x0 / 4); gx <= Math.floor((x1 - 1) / 4); gx++) {
      const r = noise.hash(gx, gz, 101);
      if (r >= 0.92) continue;
      const tx = gx * 4 + ((noise.hash(gx, gz, 102) * 3) | 0), tz = gz * 4 + ((noise.hash(gx, gz, 103) * 3) | 0);
      if (tx < x0 || tx >= x1 || tz < z0 || tz >= z1) continue;
      if (villageAt(tx, tz, 3)) continue;
      const h = climate(tx, tz), b = C.biome, wl = C.wl;
      cands.push({ gx, gz, tx, tz, r, h, b, wl });
      if (GEN >= 3 && (r < TREE_DENSITY[b] || (b === DESERT && r < 0.14) || (b === BADLANDS && r < 0.03) || (b === ICE_SPIKES && r < 0.06) ||
          (b === OLD_TAIGA && r >= 0.86 && r < 0.9))) ext = Math.max(ext, h + TREE_EXT[b]);
    }
  P.ext = ext;
  // vertical extent of the villages (pads, buildings, arch)
  let vMin = 1e9, vMax = -1e9;
  for (const v of vils) {
    if (v.vMax === undefined) { let lo = v.y, hi = v.y; for (const p of v.pads) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); } v.vMin = lo - 4; v.vMax = hi + 26; }
    vMin = Math.min(vMin, v.vMin); vMax = Math.max(vMax, v.vMax);
  }
  P.vMin = vMin; P.vMax = vMax;
}

// ---------- generator 3 underground: pure functions of absolute coordinates (any vertical window gives the same blocks) ----------
// stone with a deepslate blend zone around y -8..8
function stone3(wx, y, wz) {
  const B = BF.B;
  if (y >= 8) return B.stone;
  if (y < -8) return B.deepslate;
  return noise.hash3(wx, y, wz, 77) < (8 - y) / 16 ? B.deepslate : B.stone;
}
let g3A = new Float32Array(0), g3B = new Float32Array(0), g3C = new Float32Array(0), g3a = new Float32Array(0), g3b = new Float32Array(0), g3c = new Float32Array(0);
// Caves: coarse 3D noise grid on absolute 4-block rows, interpolated. Spaghetti tunnels (wider with depth), large caverns, deep magma floors.
// The loop runs one cell above the window so that magma on a cave floor at the window top is decided identically in the window above.
function caves3(vox, Y0, Y1, cx, cz) {
  const { CS, SEA, B } = BF, MINY = BF.MIN_Y, step = CS * CS, ox = cx * CS, oz = cz * CS;
  const STONE = B.stone, DEEP = B.deepslate, WATER = B.water, ICE = B.ice, MAGMA = B.magma_block, BEDROCK = B.bedrock;
  const lowY = Math.max(Y0, MINY + 5), topY = Math.min(Y1, P.maxH + 2);
  if (lowY > topY) return;
  const r0 = lowY >> 2, r1 = (topY >> 2) + 1, NR = r1 - r0 + 1;
  if (g3A.length < GX * GX * NR) {
    const n = GX * GX * NR; g3A = new Float32Array(n); g3B = new Float32Array(n); g3C = new Float32Array(n);
  }
  if (g3a.length < NR + 1) { g3a = new Float32Array(NR + 1); g3b = new Float32Array(NR + 1); g3c = new Float32Array(NR + 1); }
  for (let iy = 0; iy < NR; iy++) for (let iz = 0; iz < GX; iz++) for (let ix = 0; ix < GX; ix++) {
    const wx = ox + ix * 4, wy = (r0 + iy) * 4, wz = oz + iz * 4, gi = (iy * GX + iz) * GX + ix;
    g3A[gi] = noise.n3(wx / 44, wy / 22, wz / 44);
    g3B[gi] = noise.n3(wx / 44 + 57.3, wy / 22 + 11.1, wz / 44 - 33.7);
    g3C[gi] = noise.n3(wx / 72 - 91.7, wy / 36, wz / 72 + 19.3);
  }
  const vils = P.vils;
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const hi = (z + 1) * HW + x + 1, h = hCache[hi];
    const minN = Math.min(hCache[hi - 1], hCache[hi + 1], hCache[hi - HW], hCache[hi + HW], h);
    let limit;
    if (minN <= SEA + 1 || wlCache[hi] > SEA || wlCache[hi - 1] > SEA || wlCache[hi + 1] > SEA || wlCache[hi - HW] > SEA || wlCache[hi + HW] > SEA)
      limit = minN - 5;                                        // near water (sea or a river): keep a thick seal
    else limit = entranceAt(ox + x, oz + z) ? h : h - 4;
    for (const vil of vils) if (inVillage(vil, ox + x, oz + z, 2)) limit = Math.min(limit, h - 8, vil.minY - 6);
    if (limit < MINY + 6) continue;
    const yHi = Math.min(limit, Y1);
    if (lowY > yHi) continue;
    const ix = x >> 2, iz = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    const rb = lowY >> 2, rt = (yHi >> 2) + 1;
    for (let iy = rb; iy <= rt; iy++) {
      const g = ((iy - r0) * GX + iz) * GX + ix, k = iy - rb;
      g3a[k] = g3A[g] * w00 + g3A[g + 1] * w10 + g3A[g + GX] * w01 + g3A[g + GX + 1] * w11;
      g3b[k] = g3B[g] * w00 + g3B[g + 1] * w10 + g3B[g + GX] * w01 + g3B[g + GX + 1] * w11;
      g3c[k] = g3C[g] * w00 + g3C[g + 1] * w10 + g3C[g + GX] * w01 + g3C[g + GX + 1] * w11;
    }
    const wx = ox + x, wz = oz + z;
    let i = x + z * CS + (lowY - Y0) * step;
    for (let y = lowY; y <= yHi; y++, i += step) {
      const iy = (y >> 2) - rb, fy = (y & 3) / 4, dd = h - y;
      const a = g3a[iy] + (g3a[iy + 1] - g3a[iy]) * fy, bb = g3b[iy] + (g3b[iy + 1] - g3b[iy]) * fy;
      // spaghetti tunnels (intersection of two noise zero-sets), wider deeper down
      const thr = y < MINY + 34 ? 0.0105 : 0.0066 + 0.0022 * (dd >= 160 ? 1 : dd <= 0 ? 0 : dd / 160);
      let carve = a * a + bb * bb < thr;
      if (!carve && y > MINY + 8 && dd > 14) {
        const c3 = g3c[iy] + (g3c[iy + 1] - g3c[iy]) * fy;           // large caverns
        carve = c3 > 0.64 + (dd < 44 ? (44 - dd) * 0.02 : 0) + (y < MINY + 30 ? (MINY + 30 - y) * 0.03 : 0);
      }
      if (carve) {
        if (y < Y1) { const v = vox[i]; if (v !== WATER && v !== BEDROCK && v !== ICE) vox[i] = 0; }
        if (y - 1 >= Y0 && y <= -15 && MAGMA !== undefined) {         // magma on deep cave floors
          const vv = vox[i - step];
          if ((vv === STONE || vv === DEEP) && noise.hash3(wx, y - 1, wz, 78) < 0.03) vox[i - step] = MAGMA;
        }
      }
    }
  }
}
// Ores, rocks and pockets: random-walk veins in 32-block buckets of absolute y (seeded by chunk and bucket), so any window agrees.
// kind 'd': y range by depth below the chunk's centre surface [hc - b, hc - a]; kind 'y': absolute [a, b].
const ORE3 = [
  // salt, veins per bucket, size, kind, a, b, block, deepslate variant, depth-weighted (more near the surface)
  [201, 1.3, 30, "d", 8, 99999, "gravel"], [202, 0.25, 18, "d", 20, 300, "clay"], [203, 1.1, 22, "d", 6, 300, "dirt"],
  [211, 6.5, 9, "d", 6, 99999, "coal_ore", "deepslate_coal_ore", 1],
  [212, 6.0, 7, "d", 6, 99999, "iron_ore", "deepslate_iron_ore", 1],
  [217, 5.5, 9, "d", 6, 99999, "copper_ore", "deepslate_copper_ore", 1],
  [213, 2.2, 6, "y", -64, 32, "gold_ore", "deepslate_gold_ore"],
  [214, 2.0, 5, "y", -64, 16, "diamond_ore", "deepslate_diamond_ore"],
  [215, 1.0, 6, "y", -64, 40, "lapis_ore", "deepslate_lapis_ore"],
  [216, 3.5, 6, "y", -64, 16, "redstone_ore", "deepslate_redstone_ore"],
  [219, 0.03, 1, "y", -64, 40, "emerald_ore", "deepslate_emerald_ore"],
  [218, 1.1, 1, "d", 3, 500, "emerald_ore", "deepslate_emerald_ore", 0, "mtn"],
  [221, 1.6, 70, "d", 5, 99999, "granite"], [222, 1.6, 70, "d", 5, 99999, "diorite"], [223, 1.6, 70, "d", 5, 99999, "andesite"],
  [224, 1.0, 60, "y", -64, 16, "tuff", "tuff"], [225, 0.35, 40, "d", 30, 250, "dripstone_block"],
  [231, 0.4, 14, "d", 10, 99999, "water", "water"],               // water pockets at every height
  [232, 0.8, 12, "y", -64, -8, "magma_block", "magma_block"],     // there is no lava block: deep magma pockets
  [233, 0.15, 9, "d", 40, 99999, "magma_block", "magma_block"],
];
function ores3(vox, Y0, Y1, cx, cz) {
  const { CS, B } = BF, MINY = BF.MIN_Y, STONE = B.stone, DEEP = B.deepslate, hc = P.hc;
  const eb = bCache[((CS >> 1) + 1) * HW + (CS >> 1) + 1], mtn = eb === MOUNTAINS || eb === SNOWY_SLOPES || eb === PEAKS || eb === STONY_PEAKS;
  for (let q = 0; q < ORE3.length; q++) {
    const sp = ORE3[q], id = B[sp[6]];
    if (id === undefined || (sp[9] === "mtn" && !mtn)) continue;
    if (sp[0] === 219 && mtn) continue;
    const ds = sp[7] !== undefined ? B[sp[7]] : undefined, size = sp[2];
    let lo, hi;
    if (sp[3] === "d") { lo = Math.max(MINY + 5, hc - sp[5]); hi = hc - sp[4]; } else { lo = sp[4]; hi = sp[5]; }
    if (hi > hc - 3) hi = hc - 3;
    const reach = Math.ceil(size * 1.2) + 1;
    const wLo = Math.max(lo, Y0 - reach), wHi = Math.min(hi, Y1 - 1 + reach);
    if (wHi < wLo) continue;
    for (let bk = wLo >> 5; bk <= wHi >> 5; bk++) {
      const bl = Math.max(lo, bk * 32), bh = Math.min(hi, bk * 32 + 31);
      if (bh < bl) continue;
      const len = bh - bl + 1;
      let cnt = sp[1] * len / 32;
      if (sp[8]) cnt *= 0.8 + 0.8 * Math.exp(-(hc - (bl + bh) / 2) / 150);
      rs = (noise.hash3(cx, bk, cz, sp[0]) * 4294967296) >>> 0 || 1;
      let n = cnt | 0; if (rnd() < cnt - n) n++;
      for (let k = 0; k < n; k++) {
        let px = (rnd() * CS) | 0, pz = (rnd() * CS) | 0, py = bl + ((rnd() * len) | 0);
        const sz = size * (0.6 + rnd() * 0.6);
        for (let s = 0; s < sz; s++) {
          if (px >= 0 && px < CS && pz >= 0 && pz < CS && py >= Y0 && py < Y1) {
            const vi = ((py - Y0) * CS + pz) * CS + px, cur = vox[vi];
            if (cur === STONE) vox[vi] = id; else if (ds !== undefined && cur === DEEP) vox[vi] = ds;
          }
          const d = (rnd() * 6) | 0;
          if (d === 0) px++; else if (d === 1) px--; else if (d === 2) pz++; else if (d === 3) pz--; else if (d === 4) py++; else py--;
        }
      }
    }
  }
}

// Generator 3 band of a column: the sections [lo, hi) that hold everything non-trivial (terrain surface, water, trees, plants, villages and
// ~3 sections of stone below the lowest ground); everything above is air, everything below is what generateRange produces.
function generateBand(cx, cz) {
  const { CS } = BF;
  if (GEN < 3) {
    const vox = new Uint16Array(CS * CS * BF.H); generate(cx, cz, vox);
    return { lo: 0, hi: BF.H >> 4, vox };
  }
  prep(cx, cz);
  let top = P.topY + 4;                     // plants, bushes, lamps
  if (P.ext > 0) top = Math.max(top, P.ext);
  let low = P.minH;
  if (P.vils.length) { top = Math.max(top, P.vMax); low = Math.min(low, P.vMin); }
  const lo = Math.max(BF.SY0, (low >> 4) - 3), hi = Math.min(BF.SY1, Math.max(lo + 1, (top >> 4) + 1));
  const vox = new Uint16Array((hi - lo) * 4096);
  core(cx, cz, vox, lo * 16, (hi - lo) * 16);
  return { lo, hi, vox };
}
// Terrain (and everything else the generator makes) for an arbitrary section range [sy0, sy1); agrees with generateBand on overlaps.
function generateRange(cx, cz, sy0, sy1) {
  const { CS } = BF;
  sy0 = Math.max(sy0, BF.SY0); sy1 = Math.min(sy1, BF.SY1);
  if (sy1 <= sy0) return new Uint16Array(0);
  if (GEN < 3) {
    const full = new Uint16Array(CS * CS * BF.H); generate(cx, cz, full);
    return full.slice(sy0 * 4096, sy1 * 4096);
  }
  prep(cx, cz);
  const vox = new Uint16Array((sy1 - sy0) * 4096);
  core(cx, cz, vox, sy0 * 16, (sy1 - sy0) * 16);
  return vox;
}

// Legacy full-column generation (generator 1/2: the 192-high column; generator 3: the window y 0..191).
function generate(cx, cz, vox) {
  prep(cx, cz);
  core(cx, cz, vox, 0, 192);
}
// Fills `vox` (zeroed, window-indexed: ((y - Y0) * 16 + z) * 16 + x) with absolute y in [Y0, Y0 + NY). Everything written outside the window is skipped.
function core(cx, cz, vox, Y0, NY) {
  const { CS, H, SEA, B } = BF;
  const ox = cx * CS, oz = cz * CS;
  const STONE = B.stone, WATER = B.water, AIR = 0;
  const step = CS * CS;
  const Y1 = Y0 + NY, G3 = GEN >= 3, MINY = BF.MIN_Y;
  WY0 = Y0; WY1 = Y1;
  const maxH = P.maxH;

  // ---- terrain columns ----
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const wx = ox + x, wz = oz + z;
    const hi = (z + 1) * HW + x + 1;
    const h = hCache[hi];
    const b = bCache[hi], tb = tbCache[hi], wl = wlCache[hi];
    const n0 = hCache[hi - 1], n1 = hCache[hi + 1], n2 = hCache[hi - HW], n3 = hCache[hi + HW];
    const slope = Math.max(Math.abs(n0 - h), Math.abs(n1 - h), Math.abs(n2 - h), Math.abs(n3 - h));
    const minN = Math.min(n0, n1, n2, n3);
    const r = noise.hash(wx, wz, 3);
    const patch = noise.n2(wx / 13 + 3.1, wz / 13 - 7.3);

    let top = B.grass, fill = B.dirt, depth = 3 + (r * 2 | 0), under = STONE, depth2 = 0, strata = false;
    if (h < wl) {
      // underwater floor
      if (b === SWAMP) { top = r < 0.4 ? B.clay : B.dirt; fill = B.dirt; }
      else if (b === MANGROVE) { top = fill = B.mud; depth = 4; }
      else if (b === RIVER) { top = fill = patch > 0.35 ? B.clay : patch < -0.4 ? B.gravel : B.sand; depth = 2; }
      else if (wl - h > 5) { top = fill = tb >= 3 ? B.sand : B.gravel; depth = 2; }
      else { top = fill = B.sand; depth = 3; if (patch > 0.55) top = fill = B.clay; }
      if (b === BADLANDS) top = fill = B.red_sand;
    } else switch (b) {
      case DESERT: top = fill = B.sand; under = B.sandstone; depth2 = 4; break;
      case BADLANDS: strata = true; top = slope >= 2 ? 0 : B.red_sand; fill = B.red_sand; depth = slope >= 2 ? 0 : 1 + (r * 2 | 0); break;
      case BEACH: case RIVER: top = fill = B.sand; depth = 3; under = B.sandstone; depth2 = 2; break;
      case SNOWY_BEACH: top = fill = B.sand; depth = 3; if (h >= SEA + 1) top = B.snow_grass; break;
      case STONY_SHORE: top = fill = patch > 0.3 ? B.gravel : STONE; depth = 2; break;
      case SNOWY_PLAINS: case SNOWY_TAIGA: top = B.snow_grass; break;
      case ICE_SPIKES: top = B.snow; break;
      case MUSHROOM: top = B.mycelium; break;
      case MANGROVE: top = fill = B.mud; depth = 4; break;
      case OLD_TAIGA: top = patch > 0.35 ? B.coarse_dirt : patch > -0.45 ? B.podzol : B.grass; break;
      case TAIGA: if (patch > 0.5) top = B.podzol; break;
      case DARK_FOREST: if (patch > 0.6) top = B.podzol; break;
      case SAVANNA: if (patch > 0.62) top = B.coarse_dirt; break;
      case MOUNTAINS: case SNOWY_SLOPES: case PEAKS: case STONY_PEAKS: {
        const snowLine = G3 ? (b === SNOWY_SLOPES ? 1450 : b === PEAKS ? 1800 : 1950) + noise.n2(wx / 23, wz / 23) * 30
          : (b === SNOWY_SLOPES ? 74 : b === PEAKS ? 92 : 100) + noise.n2(wx / 23, wz / 23) * 4;
        const snowy = b !== STONY_PEAKS && h >= snowLine;
        if (snowy) {
          top = slope >= 4 ? STONE : B.snow; fill = slope >= 3 ? STONE : B.snow; depth = 1 + (r * 2 | 0);
          if (b === PEAKS && patch > 0.5 && slope < 3) top = B.packed_ice;
        } else if (b === STONY_PEAKS) top = fill = ((h + (patch * 3 | 0)) % 7 === 0) ? B.calcite : STONE;
        else if (G3 ? (slope >= 2 || h > 1850 + r * 30) : (slope >= 3 || h > 90 + r * 4)) { top = STONE; fill = STONE; }
        else if (b === SNOWY_SLOPES) top = B.snow_grass;
        else if (slope >= 2 && r < 0.3) top = B.gravel;
        break;
      }
      default:
        if (h <= SEA + 1 && minN < SEA && b !== SWAMP) {
          if (tb === 0) top = B.snow_grass;
          else { top = fill = B.sand; depth = 3; }
        } else if (slope >= 6) { top = STONE; fill = STONE; }
    }
    // frozen water: frozen biomes freeze near shore and in broken floes further out; cold rivers freeze
    const ice = h < wl && b !== SWAMP && b !== MANGROVE && (tb === 0 || (tb === 1 && b === RIVER)) &&
      (wl - h < 4 || patch > -0.35);
    const topY = Math.max(h, wl);
    const yStart = Y0 > MINY ? Y0 : MINY, yEnd = topY < Y1 - 1 ? topY : Y1 - 1;
    let i = x + z * CS + (yStart - Y0) * step;
    const strataY = G3 ? h - 36 + r * 4 : 40 + r * 4;
    for (let y = yStart; y <= yEnd; y++, i += step) {
      let v;
      if (y === MINY) v = B.bedrock;
      else if (!G3 && y <= 3 && noise.hash3(wx, y, wz, 9) < 0.75 - y * 0.22) v = B.bedrock;
      else if (G3 && y - MINY <= 4 && noise.hash3(wx, y, wz, 9) < 0.85 - (y - MINY) * 0.17) v = B.bedrock;
      else if (y > h) v = (y === wl && ice) ? B.ice : WATER;
      else if (strata) {
        if (y > h - depth) v = y === h ? top : fill;
        else if (y > strataY) v = STRATA[(y + ((noise.n2(wx / 160, wz / 160) * 3) | 0) + 64) & 63];
        else v = G3 ? stone3(wx, y, wz) : STONE;
      }
      else if (y === h) v = top;
      else if (y > h - depth) v = fill;
      else if (y > h - depth - depth2) v = under;
      else v = G3 ? stone3(wx, y, wz) : STONE;
      vox[i] = v;
    }
  }

  const vils = P.vils;
  // structures (villages, trees, plants) cannot reach a window that lies far below the lowest ground of the chunk
  const skipTop = G3 && Y1 <= P.minH - 48;

  // ---- caves (coarse 3D noise grid, interpolated) ----
  if (G3) caves3(vox, Y0, Y1, cx, cz); else {
  const NY = Math.min(GY_MAX, ((maxH + 4) >> 2) + 1);
  for (let iy = 0; iy < NY; iy++) for (let iz = 0; iz < GX; iz++) for (let ix = 0; ix < GX; ix++) {
    const wx = ox + ix * 4, wy = iy * 4, wz = oz + iz * 4, gi = (iy * GX + iz) * GX + ix;
    gA[gi] = noise.n3(wx / 44, wy / 22, wz / 44);
    gB[gi] = noise.n3(wx / 44 + 57.3, wy / 22 + 11.1, wz / 44 - 33.7);
    gC[gi] = noise.n3(wx / 72 - 91.7, wy / 36, wz / 72 + 19.3);
  }
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const hi = (z + 1) * HW + x + 1, h = hCache[hi];
    const minN = Math.min(hCache[hi - 1], hCache[hi + 1], hCache[hi - HW], hCache[hi + HW], h);
    let limit;
    if (minN <= SEA + 1 || wlCache[hi] > SEA || wlCache[hi - 1] > SEA || wlCache[hi + 1] > SEA || wlCache[hi - HW] > SEA || wlCache[hi + HW] > SEA)
      limit = minN - 5;                                        // near water (sea or a river): keep a thick seal
    else limit = entranceAt(ox + x, oz + z) ? h : h - 4;
    for (const vil of vils) if (inVillage(vil, ox + x, oz + z, 2)) limit = Math.min(limit, h - 8, vil.minY - 6);
    if (limit < 5) continue;
    const ix = x >> 2, iz = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    const ny = Math.min(NY, (limit >> 2) + 2);
    for (let iy = 0; iy < ny; iy++) {
      const g = (iy * GX + iz) * GX + ix;
      colA[iy] = gA[g] * w00 + gA[g + 1] * w10 + gA[g + GX] * w01 + gA[g + GX + 1] * w11;
      colB[iy] = gB[g] * w00 + gB[g + 1] * w10 + gB[g + GX] * w01 + gB[g + GX + 1] * w11;
      colC[iy] = gC[g] * w00 + gC[g + 1] * w10 + gC[g + GX] * w01 + gC[g + GX + 1] * w11;
    }
    let i = x + z * CS + 4 * step;
    for (let y = 4; y <= limit; y++, i += step) {
      const iy = y >> 2, fy = (y & 3) / 4;
      const a = colA[iy] + (colA[iy + 1] - colA[iy]) * fy;
      const bb = colB[iy] + (colB[iy + 1] - colB[iy]) * fy;
      // spaghetti tunnels (intersection of two noise zero-sets), wider deeper down
      let carve = a * a + bb * bb < (y < 30 ? 0.0105 : 0.0075);
      if (!carve && y > 6 && y < 56) {
        const c3 = colC[iy] + (colC[iy + 1] - colC[iy]) * fy;           // large caverns
        carve = c3 > 0.56 + (y > 36 ? (y - 36) * 0.02 : 0) + (y < 12 ? (12 - y) * 0.03 : 0);
      }
      if (carve) {
        const v = vox[i];
        if (v !== WATER && v !== B.bedrock && v !== B.ice) vox[i] = AIR;
      }
    }
  }

  // ---- deepslate layer (below ~y16, noisy transition 12..20) and rare magma on deep cave floors ----
  const DEEP = B.deepslate, MAGMA = B.magma_block;
  if (DEEP !== undefined) {
    for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
      const wx = ox + x, wz = oz + z;
      let i = x + z * CS + step;
      for (let y = 1; y < 20; y++, i += step) {
        let v = vox[i];
        if (v === STONE && (y < 12 || noise.hash3(wx, y, wz, 77) < (20 - y) / 8)) { v = DEEP; vox[i] = DEEP; }
        if ((v === STONE || v === DEEP) && y >= 5 && y <= 16 && vox[i + step] === AIR && MAGMA !== undefined && noise.hash3(wx, y, wz, 78) < 0.03) vox[i] = MAGMA;
      }
    }
  }
  }   // end of the legacy (generator 1/2) caves and deepslate

  // ---- ores and pockets (random-walk veins, chunk-local) ----
  // dsId: block used instead of `id` where the vein passes through deepslate (ore variants; tuff blobs replace deepslate too)
  const DEEP = B.deepslate;
  function vein(salt, count, size, ymin, ymax, id, dsId) {
    rs = (noise.hash(cx, cz, salt) * 4294967296) >>> 0 || 1;
    let n = count | 0; if (rnd() < count - n) n++;
    for (let k = 0; k < n; k++) {
      let px = (rnd() * CS) | 0, pz = (rnd() * CS) | 0, py = ymin + ((rnd() * (ymax - ymin)) | 0);
      const sz = size * (0.6 + rnd() * 0.6);
      for (let s = 0; s < sz; s++) {
        if (px >= 0 && px < CS && pz >= 0 && pz < CS && py > 0 && py < H) {
          const vi = (py * CS + pz) * CS + px;
          const cur = vox[vi];
          if (cur === STONE) vox[vi] = id; else if (dsId !== undefined && cur === DEEP) vox[vi] = dsId;
        }
        const d = (rnd() * 6) | 0;
        if (d === 0) px++; else if (d === 1) px--; else if (d === 2) pz++; else if (d === 3) pz--; else if (d === 4) py++; else py--;
      }
    }
  }
  if (G3) ores3(vox, Y0, Y1, cx, cz); else {
  vein(201, 3.5, 30, 6, Math.min(90, maxH), B.gravel);
  vein(202, 0.7, 18, 20, 58, B.clay);
  vein(203, 3, 22, 8, 70, B.dirt);
  vein(211, 20, 9, 5, Math.min(100, maxH), B.coal_ore, B.deepslate_coal_ore);
  vein(212, 13, 7, 3, 64, B.iron_ore, B.deepslate_iron_ore);
  vein(213, 3, 6, 2, 32, B.gold_ore, B.deepslate_gold_ore);
  vein(214, 1.4, 5, 2, 16, B.diamond_ore, B.deepslate_diamond_ore);
  if (B.lapis_ore !== undefined) {
    vein(215, 1.5, 6, 2, 40, B.lapis_ore, B.deepslate_lapis_ore);
    vein(216, 4, 6, 2, 24, B.redstone_ore, B.deepslate_redstone_ore);
    vein(217, 8, 9, 20, 60, B.copper_ore, B.deepslate_copper_ore);
    // emerald: single blocks, common-ish in mountain biomes, very rare elsewhere
    const eb = bCache[((CS >> 1) + 1) * HW + (CS >> 1) + 1], mtn = eb === MOUNTAINS || eb === SNOWY_SLOPES || eb === PEAKS || eb === STONY_PEAKS;
    vein(218, mtn ? 3 : 0.12, 1, mtn ? 8 : 20, mtn ? Math.min(110, maxH - 3) : 60, B.emerald_ore, B.deepslate_emerald_ore);
    // stone variety blobs (granite / diorite / andesite in stone, tuff in the deep, dripstone in mid caves)
    vein(221, 4, 70, 5, 85, B.granite);
    vein(222, 4, 70, 5, 85, B.diorite);
    vein(223, 4, 70, 5, 85, B.andesite);
    vein(224, 2.5, 60, 2, 26, B.tuff, B.tuff);
    vein(225, 0.7, 40, 25, 55, B.dripstone_block);
  }
  }   // end of the legacy ores

  // ---- villages ----
  if (!skipTop) for (const vil of vils) drawVillage(vil, ox, oz, vox, (x, z) => hCache[(z - oz + 1) * HW + x - ox + 1]);

  // ---- trees and large features ----
  const RENDER = BF.RENDER;
  const putLog = (x, y, z, id) => {
    const lx = x - ox, lz = z - oz;
    if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y <= MINY || y >= H || y < Y0 || y >= Y1) return;
    const vi = ((y - Y0) * CS + lz) * CS + lx, cur = vox[vi];
    if (cur === AIR || cur === WATER || RENDER[cur] === 2 || RENDER[cur] === 4) vox[vi] = id;
  };
  const putLeaf = (x, y, z, id) => {
    const lx = x - ox, lz = z - oz;
    if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y <= MINY || y >= H || y < Y0 || y >= Y1) return;
    const vi = ((y - Y0) * CS + lz) * CS + lx;
    if (vox[vi] === AIR) vox[vi] = id;
  };
  const disc = (tx, y, tz, r, id, trim) => {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r + r * 0.8) continue;
      if (trim && Math.abs(dx) === r && Math.abs(dz) === r && noise.hash3(tx + dx, y, tz + dz, 31) < trim) continue;
      putLeaf(tx + dx, y, tz + dz, id);
    }
  };
  // ellipsoid blob of leaves, edge dithered by a world-coord hash
  const blob = (cx0, cy, cz0, rx, ry, id, salt) => {
    const ix = Math.ceil(rx) + 1, iy = Math.ceil(ry);
    const bx = Math.floor(cx0), bz = Math.floor(cz0);
    for (let dy = -iy; dy <= iy; dy++) for (let dz = -ix; dz <= ix; dz++) for (let dx = -ix; dx <= ix; dx++) {
      const x = bx + dx, z = bz + dz, y = cy + dy;
      const ex = (x - cx0) / rx, ez = (z - cz0) / rx, ey = dy / ry;
      if (ex * ex + ez * ez + ey * ey <= 1 - noise.hash3(x, y, z, salt) * 0.35) putLeaf(x, y, z, id);
    }
  };

  function oakTree(tx, ty, tz, log, leaf, hgt, wide) {
    const top = ty + hgt;
    for (let y = ty; y < top; y++) putLog(tx, y, tz, log);
    for (let y = top - 3; y <= top - 2; y++) disc(tx, y, tz, wide ? 3 : 2, leaf, 0.6);
    disc(tx, top - 1, tz, wide ? 2 : 1, leaf, 0);
    disc(tx, top, tz, 1, leaf, 0.99);
    putLeaf(tx, top, tz, leaf);
  }
  function spruceTree(tx, ty, tz, hgt) {
    const top = ty + hgt;
    for (let y = ty; y < top; y++) putLog(tx, y, tz, B.spruce_log);
    putLeaf(tx, top, tz, B.spruce_leaves);
    putLeaf(tx, top + 1, tz, B.spruce_leaves);
    let r = 0;
    const maxR = hgt > 7 ? 3 : 2;
    for (let y = top - 1; y >= ty + 2; y--) {
      r = r >= maxR ? 1 : r + 1;
      if (y >= top - 2) r = Math.min(r, 1);
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > r + (r > 1 ? 1 : 0)) continue;
        putLeaf(tx + dx, y, tz + dz, B.spruce_leaves);
      }
    }
  }
  function megaSpruce(tx, ty, tz, hgt) {
    const top = ty + hgt, L = B.spruce_log;
    for (let y = ty - 2; y < top; y++) { putLog(tx, y, tz, L); putLog(tx + 1, y, tz, L); putLog(tx, y, tz + 1, L); putLog(tx + 1, y, tz + 1, L); }
    const start = ty + Math.floor(hgt * 0.45);
    for (let y = start; y <= top + 1; y++) {
      const f = (top + 1 - y) / (top + 1 - start);
      const rr = y > top - 1 ? 1.2 : 1.7 + f * 3.2 * (((y - start) % 3 === 0) ? 1 : 0.72);
      const ri = Math.ceil(rr) + 1;
      for (let dz = -ri; dz <= ri + 1; dz++) for (let dx = -ri; dx <= ri + 1; dx++) {
        const ex = dx - 0.5, ez = dz - 0.5;
        if (ex * ex + ez * ez <= rr * rr) putLeaf(tx + dx, y, tz + dz, B.spruce_leaves);
      }
    }
  }
  function jungleTree(tx, ty, tz, hgt, big) {
    const top = ty + hgt, L = B.jungle_log, F = B.jungle_leaves;
    for (let y = ty - (big ? 3 : 0); y < top; y++) {
      putLog(tx, y, tz, L);
      if (big) { putLog(tx + 1, y, tz, L); putLog(tx, y, tz + 1, L); putLog(tx + 1, y, tz + 1, L); }
    }
    const ccx = big ? tx + 0.5 : tx, ccz = big ? tz + 0.5 : tz;
    const R = big ? 4.6 : 3.2;
    for (let y = top - 2; y <= top + 1; y++) {
      const rr = y >= top ? R - 1.6 - (y - top) : R - (top - 1 - y) * 0.6;
      const ri = Math.ceil(rr) + 1;
      for (let dz = -ri; dz <= ri + 1; dz++) for (let dx = -ri; dx <= ri + 1; dx++) {
        const px = tx + dx, pz = tz + dz, ex = px - ccx, ez = pz - ccz;
        if (ex * ex + ez * ez <= rr * rr + (noise.hash3(px, y, pz, 37) - 0.5) * 2) putLeaf(px, y, pz, F);
      }
    }
    for (let k = 0; k < (big ? 3 : 1); k++) {
      const hy = ty + 4 + ((noise.hash(tx + k, tz, 41) * (hgt - 7)) | 0);
      const dir = (noise.hash(tx, tz + k, 43) * 4) | 0;
      const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0, dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
      const bx = tx + dx * (big && dx > 0 ? 2 : 1), bz = tz + dz * (big && dz > 0 ? 2 : 1);
      putLog(bx, hy, bz, L);
      disc(bx, hy, bz, 2, F, 0.7); disc(bx, hy + 1, bz, 1, F, 0);
    }
  }
  function acacia(tx, ty, tz, hgt, dir) {
    const L = B.acacia_log, F = B.acacia_leaves;
    const dx = dir & 1 ? 1 : -1, dz = dir & 2 ? 1 : -1;
    let x = tx, z = tz, y = ty;
    for (; y < ty + hgt - 2; y++) putLog(x, y, z, L);
    for (let k = 0; k < 2; k++, y++) { x += dx; z += dz; putLog(x, y, z, L); }
    disc(x, y, z, 3, F, 1); disc(x, y + 1, z, 2, F, 0.7);
    if (dir & 4) {           // a second, smaller branch the other way
      putLog(tx - dx, ty + hgt - 3, tz - dz, L); putLog(tx - 2 * dx, ty + hgt - 2, tz - 2 * dz, L);
      disc(tx - 2 * dx, ty + hgt - 1, tz - 2 * dz, 2, F, 0.6);
    }
  }
  function darkOak(tx, ty, tz, hgt) {
    const L = B.dark_oak_log, F = B.dark_oak_leaves, top = ty + hgt;
    for (let y = ty - 1; y < top; y++) { putLog(tx, y, tz, L); putLog(tx + 1, y, tz, L); putLog(tx, y, tz + 1, L); putLog(tx + 1, y, tz + 1, L); }
    blob(tx + 0.5, top - 1, tz + 0.5, 4.2, 1.6, F, 51);
    blob(tx + 0.5, top + 1, tz + 0.5, 2.6, 1.2, F, 52);
    const d = (noise.hash(tx, tz, 53) * 4) | 0;
    putLog(tx + (d === 0 ? 2 : d === 1 ? -1 : 0), top - 2, tz + (d === 2 ? 2 : d === 3 ? -1 : 0), L);
  }
  function cherry(tx, ty, tz, hgt) {
    const L = B.cherry_log, F = B.cherry_leaves, top = ty + hgt;
    for (let y = ty; y < top; y++) putLog(tx, y, tz, L);
    const d = (noise.hash(tx, tz, 61) * 4) | 0, dx = d === 0 ? 1 : d === 1 ? -1 : 0, dz = d === 2 ? 1 : d === 3 ? -1 : 0;
    putLog(tx + dx, top - 1, tz + dz, L); putLog(tx + 2 * dx, top, tz + 2 * dz, L);
    blob(tx + dx, top + 1, tz + dz, 3.6, 2.0, F, 62);
  }
  function mangrove(tx, ty, tz, hgt, ground) {
    const L = B.mangrove_log, F = B.mangrove_leaves, base = ty + 2, top = base + hgt;
    for (let y = ground; y < top; y++) putLog(tx, y, tz, L);
    for (let k = 0; k < 4; k++) {                 // prop roots arching down to the mud
      if (noise.hash(tx + k, tz, 71) < 0.25) continue;
      const dx = k === 0 ? 1 : k === 1 ? -1 : 0, dz = k === 2 ? 1 : k === 3 ? -1 : 0;
      putLog(tx + dx, base, tz + dz, L);
      for (let y = base; y >= ground - 1; y--) putLog(tx + 2 * dx, y, tz + 2 * dz, L);
    }
    blob(tx, top, tz, 3.2, 2.0, F, 72);
  }
  function giantMushroom(tx, ty, tz, red) {
    const hgt = 5 + ((noise.hash(tx, tz, 81) * 3) | 0), top = ty + hgt;
    for (let y = ty; y < top; y++) putLog(tx, y, tz, B.mushroom_stem);
    if (red) {
      for (let y = top - 3; y < top; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        if (Math.abs(dx) === 2 || Math.abs(dz) === 2) putLeaf(tx + dx, y, tz + dz, B.red_mushroom_block);
      }
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) putLeaf(tx + dx, top, tz + dz, B.red_mushroom_block);
    } else {
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++)
        if (!(Math.abs(dx) === 3 && Math.abs(dz) === 3)) putLeaf(tx + dx, top, tz + dz, B.brown_mushroom_block);
    }
  }
  function iceSpike(tx, ty, tz, hgt, rad) {
    for (let y = ty - 2; y < ty + hgt; y++) {
      const f = 1 - (y - ty) / hgt, rr = Math.max(0.5, rad * f), ri = Math.ceil(rr);
      for (let dz = -ri; dz <= ri; dz++) for (let dx = -ri; dx <= ri; dx++)
        if (dx * dx + dz * dz <= rr * rr) putLog(tx + dx, y, tz + dz, B.packed_ice);
    }
  }
  function boulder(tx, ty, tz) {
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > (noise.hash3(tx + dx, ty + dy, tz + dz, 91) < 0.5 ? 1 : 2)) continue;
      const lx = tx + dx - ox, lz = tz + dz - oz, y = ty + dy;
      if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y < Y0 || y >= Y1) continue;
      vox[((y - Y0) * CS + lz) * CS + lx] = noise.hash3(tx + dx, y, tz + dz, 92) < 0.7 ? B.mossy_cobblestone : B.cobblestone;
    }
  }
  const grassy = b => !(b === OCEAN || b === BEACH || b === SNOWY_BEACH || b === STONY_SHORE || b === DESERT || b === BADLANDS ||
    b === RIVER || b === PEAKS || b === STONY_PEAKS || b === SNOWY_SLOPES);

  const inChunk = (x, z) => x >= ox && x < ox + CS && z >= oz && z < oz + CS;
  if (!skipTop) for (const cd of P.cands) {
      const { gx, gz, tx, tz, r, h, b } = cd;
      const r2 = noise.hash(gx, gz, 104), r3 = noise.hash(gx, gz, 105);
      if (b === MANGROVE) {
        if (r < TREE_DENSITY[b] && h >= SEA - 3) mangrove(tx, Math.max(h, SEA) + 1, tz, 4 + ((r3 * 3) | 0), h + 1);
        continue;
      }
      if (h <= cd.wl) continue;
      if (b === DESERT || b === BADLANDS) {
        if (r < (b === DESERT ? 0.14 : 0.03) && inChunk(tx, tz)) {
          const top = h >= Y0 && h < Y1 ? vox[((h - Y0) * CS + tz - oz) * CS + tx - ox] : 0;
          if (top === B.sand || top === B.red_sand) for (let y = h + 1; y <= h + 1 + ((r2 * 3) | 0); y++) putLog(tx, y, tz, B.cactus);
        }
        continue;
      }
      if (b === ICE_SPIKES) {
        if (r < 0.06) { const big = r2 < 0.12; iceSpike(tx, h + 1, tz, big ? 22 + ((r3 * 10) | 0) : 6 + ((r3 * 8) | 0), big ? 2.6 : 1.3); }
        continue;
      }
      if (b === OLD_TAIGA && r >= 0.86 && r < 0.9 && !entranceAt(tx, tz)) { boulder(tx, h + 1, tz); continue; }
      if (r >= TREE_DENSITY[b] || !grassy(b)) continue;
      if (h <= SEA + 1 && b !== SWAMP) continue;                 // shore sand
      if (b === MOUNTAINS && h > (G3 ? 1800 : 90)) continue;
      if (entranceAt(tx, tz)) continue;
      const ty = h + 1;
      switch (b) {
        case JUNGLE:
          if (r2 < 0.18) jungleTree(tx, ty, tz, 18 + ((r3 * 9) | 0), true);
          else if (r2 < 0.6) jungleTree(tx, ty, tz, 9 + ((r3 * 6) | 0), false);
          else oakTree(tx, ty, tz, B.jungle_log, B.jungle_leaves, 4 + ((r3 * 2) | 0), false);
          break;
        case SPARSE_JUNGLE:
          if (r2 < 0.45) jungleTree(tx, ty, tz, 7 + ((r3 * 4) | 0), false);
          else if (r2 < 0.75) oakTree(tx, ty, tz, B.jungle_log, B.jungle_leaves, 4 + ((r3 * 2) | 0), false);
          else oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, 4 + ((r3 * 2) | 0), false);
          break;
        case TAIGA: case SNOWY_TAIGA: case SNOWY_PLAINS: case MOUNTAINS:
          spruceTree(tx, ty, tz, 6 + ((r3 * 5) | 0)); break;
        case OLD_TAIGA:
          if (r2 < 0.45) megaSpruce(tx, ty, tz, 18 + ((r3 * 10) | 0)); else spruceTree(tx, ty, tz, 7 + ((r3 * 5) | 0));
          break;
        case SAVANNA: acacia(tx, ty, tz, 5 + ((r2 * 2) | 0), (r3 * 8) | 0); break;
        case DARK_FOREST:
          if (r2 < 0.07) giantMushroom(tx, ty, tz, r3 < 0.5);
          else if (r2 < 0.85) darkOak(tx, ty, tz, 6 + ((r3 * 3) | 0));
          else oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, 5, false);
          break;
        case CHERRY: cherry(tx, ty, tz, 4 + ((r3 * 3) | 0)); break;
        case MUSHROOM: giantMushroom(tx, ty, tz, r2 < 0.5); break;
        case BIRCH: case MEADOW:
          if (r2 < 0.85 || b === MEADOW) oakTree(tx, ty, tz, B.birch_log, B.birch_leaves, 5 + ((r3 * 3) | 0), false);
          else oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, 4 + ((r3 * 3) | 0), false);
          break;
        case FOREST: case FLOWER_FOREST:
          if (r2 < 0.3) oakTree(tx, ty, tz, B.birch_log, B.birch_leaves, 5 + ((r3 * 3) | 0), false);
          else oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, 4 + ((r3 * 3) | 0), false);
          break;
        default:
          oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, 4 + ((r3 * 3) | 0), b === SWAMP);
      }
    }
  // jungle undergrowth bushes on a 3-grid
  if (!skipTop) for (let gz = Math.floor((oz - 3) / 3); gz <= Math.floor((oz + CS + 2) / 3); gz++)
    for (let gx = Math.floor((ox - 3) / 3); gx <= Math.floor((ox + CS + 2) / 3); gx++) {
      if (noise.hash(gx, gz, 121) >= 0.45) continue;
      const tx = gx * 3 + ((noise.hash(gx, gz, 122) * 3) | 0), tz = gz * 3 + ((noise.hash(gx, gz, 123) * 3) | 0);
      if (tx < ox - 3 || tx >= ox + CS + 3 || tz < oz - 3 || tz >= oz + CS + 3) continue;
      const h = climate(tx, tz);
      if (C.biome !== JUNGLE || h <= SEA + 1 || entranceAt(tx, tz) || villageAt(tx, tz, 3)) continue;
      putLog(tx, h + 1, tz, B.jungle_log);
      disc(tx, h + 1, tz, 2, B.jungle_leaves, 0.8); disc(tx, h + 2, tz, 1, B.jungle_leaves, 0.5);
    }

  // ---- ground plants (per column, chunk-local) ----
  const FLOWERS = [B.poppy, B.dandelion, B.cornflower];
  const isGrass = id => id === B.grass || id === B.podzol || id === B.coarse_dirt || id === B.dirt;
  // pumpkin (kind 1, 40-block cells) and melon (kind 2, jungle only, 36-block cells) patch centres near this chunk
  fieldCache.clear(); curNoise = noise;
  const patches = [];
  for (let kind = 1; kind <= 2; kind++) {
    const CELL = kind === 1 ? 40 : 36, salt = kind === 1 ? 631 : 641, pr = kind === 1 ? 0.2 : 0.34;
    for (let gz = Math.floor((oz - 8) / CELL); gz <= Math.floor((oz + CS + 7) / CELL); gz++)
      for (let gx = Math.floor((ox - 8) / CELL); gx <= Math.floor((ox + CS + 7) / CELL); gx++) {
        if (noise.hash(gx, gz, salt) >= pr) continue;
        const R = 3.5 + noise.hash(gx, gz, salt + 3) * 2.5;
        patches.push(gx * CELL + noise.hash(gx, gz, salt + 1) * CELL, gz * CELL + noise.hash(gx, gz, salt + 2) * CELL, R, kind, 0.1 + noise.hash(gx, gz, salt + 4) * 0.1);
      }
  }
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const hi = (z + 1) * HW + x + 1, h = hCache[hi];
    if (skipTop || h < SEA || h + 4 >= H || h < Y0 || h + 1 >= Y1) continue;
    const vi = ((h - Y0) * CS + z) * CS + x, top = vox[vi];
    if (vox[vi + step] !== AIR || !BF.SOLID[top]) continue;
    const wx = ox + x, wz = oz + z;
    let skip = false;
    for (const vil of vils) if (inVillage(vil, wx, wz, 1)) { skip = true; break; }
    if (skip) continue;
    const b = bCache[hi];
    let r = noise.hash(wx, wz, 141);
    const jit = (noise.hash(wx, wz, 149) - 0.5) * 0.14;
    // sugar cane beside unfrozen water at sea level
    if (h === SEA && (isGrass(top) || top === B.sand || top === B.red_sand) && tbCache[hi] > 0 &&
        (hCache[hi - 1] < SEA || hCache[hi + 1] < SEA || hCache[hi - HW] < SEA || hCache[hi + HW] < SEA)) {
      if (r < 0.14 * 2.2 && r < 0.14 * patchMult(patchField(wx, wz, CANE_S, 23.9, ox, oz, jit), 0.45, 0.2)) {
        const n = 1 + ((noise.hash(wx, wz, 142) * 3) | 0);
        for (let k = 1; k <= n && h + k < Y1; k++) vox[vi + step * k] = B.sugar_cane;
      }
      continue;
    }
    const p = PLANTS[b];
    // pumpkin / melon patches (clumps around hashed centres)
    if (top === B.grass && patches.length) {
      let hit = 0;
      for (let k = 0; k < patches.length; k += 5) {
        const dx = wx - patches[k], dz = wz - patches[k + 1], R = patches[k + 2];
        const d2 = dx * dx + dz * dz;
        if (d2 < R * R && (patches[k + 3] === 2 ? b === JUNGLE || b === SPARSE_JUNGLE : b !== OCEAN) &&
            noise.hash(wx, wz, 633) < patches[k + 4] * (1.15 - d2 / (R * R))) { hit = patches[k + 3]; break; }
      }
      if (hit) { vox[vi + step] = hit === 2 ? B.melon : B.pumpkin; continue; }
    }
    // sugar cane clumps along the shore
    // short grass (r computed above, reused for sugar cane)
    const gp = GRASS_PATCH[b];
    if (p[0] > 0 && r < p[0] * 2.3 && (top === B.grass || top === B.podzol) &&
        r < p[0] * patchMult(patchField(wx, wz, gp[0], 5.3, ox, oz, jit), gp[1], gp[2])) { vox[vi + step] = B.short_grass; continue; }
    if (p[1] > 0 && isGrass(top)) {
      r = noise.hash(wx, wz, 145);
      const fp = FERN_PATCH[b];
      if (r < p[1] * 2.6 && r < p[1] * patchMult(patchField(wx, wz, fp[0], 12.9, ox, oz, jit), fp[1], fp[2])) { vox[vi + step] = B.fern; continue; }
    }
    if (p[2] > 0 && top === B.grass) {
      r = noise.hash(wx, wz, 146);
      if (r < p[2] * 0.03) { const sel = patchField(wx, wz, 64, 83.1, ox, oz, 0); vox[vi + step] = FLOWERS[sel < FL_BAND1 ? 0 : sel < FL_BAND2 ? 1 : 2]; continue; }   // strays (local colour)
      if (r < 0.42) {
        const cover = FL_COVER[b], thr = FL_THR[b];
        // one presence field for all flower patches; the colour comes from a slow selector field split into 3 bands
        // (wavelength 64, so a patch is almost always inside one band; columns near a band edge get no flowers)
        const q = patchField(wx, wz, 16, 31.7, ox, oz, jit);
        if (q > thr && r < 0.42 * smooth(thr, thr + 0.06, q) * FL_DENS[b]) {
          const sel = patchField(wx, wz, 64, 83.1, ox, oz, 0);
          if (Math.abs(sel - FL_BAND1) > 0.06 && Math.abs(sel - FL_BAND2) > 0.06) { vox[vi + step] = FLOWERS[sel < FL_BAND1 ? 0 : sel < FL_BAND2 ? 1 : 2]; continue; }
        }
      }
    }
    if (p[3] > 0) {
      r = noise.hash(wx, wz, 147);
      if (r < p[3] * 3 && (top === B.sand || top === B.red_sand || top === B.coarse_dirt || (top >= B.terracotta && top <= B.red_terracotta)) &&
          r < p[3] * patchMult(patchField(wx, wz, DEAD_S, 41.3, ox, oz, jit), 0.45, 0.25)) { vox[vi + step] = B.dead_bush; continue; }
    }
    if (p[4] > 0 && (top === B.mycelium || isGrass(top))) {
      r = noise.hash(wx, wz, 148);
      if (r < p[4] * 0.08) { vox[vi + step] = noise.hash(wx, wz, 144) < 0.5 ? B.red_mushroom : B.brown_mushroom; continue; }
      if (r < 0.4) {
        const cover = MU_COVER[b], thr = MU_THR[b];
        const q = patchField(wx, wz, MUSH_S, 67.9, ox, oz, jit);
        if (q > thr && r < 0.34 * smooth(thr, thr + 0.06, q) * MU_DENS[b]) { vox[vi + step] = noise.hash(wx, wz, 144) < 0.5 ? B.red_mushroom : B.brown_mushroom; continue; }
      }
    }
  }
  // rare mushrooms on cave floors
  rs = (noise.hash(cx, cz, 151) * 4294967296) >>> 0 || 1;
  if (!G3) for (let k = 0; k < 6; k++) {
    const x = (rnd() * CS) | 0, z = (rnd() * CS) | 0, pick = rnd(), kind = rnd();
    for (let y = 40; y > 6; y--) {
      const vi = (y * CS + z) * CS + x;
      if (vox[vi] === AIR && vox[vi - step] === STONE) { if (pick < 0.5) vox[vi] = kind < 0.5 ? B.red_mushroom : B.brown_mushroom; break; }
    }
  }
}

// ---------- blueprints (builder villagers, js/blueprints.js) ----------
// Runs a village building generator against a recording buffer instead of the world. Returns the cells [u, y, q, id] of a
// building of type `kind` (house, house2, lhouse, smith, ...) with size w x d in its local frame: u along the front wall,
// q away from the road, y 0 = floor level, front wall at q = 0 with the door facing local north (-z); last write wins.
// Beds are not recorded (see bedPlan). Nothing here is used by chunk generation.
function recordBuilding(kind, w, d, style, h) {
  style = style | 0;
  const b = { type: kind, w, d, y: 0, bx: 0, bz: 0, ax: 1, az: 0, sx: 0, sz: 1, du: w >> 1, doorX: 0, doorZ: 0, h: h == null ? 0.5 : h };
  const cells = new Map();
  drawShell(b, (u, y, q, id) => { cells.set(u + "," + y + "," + q, [u, y, q, id]); }, styles()[style] || styles()[0], style);
  return [...cells.values()];
}
const bedPlanOf = (kind, w, d, h) => bedPlan({ type: kind, w, d, du: w >> 1, h: h == null ? 0.5 : h });

BF.worldgen = {
  setCoarse(v) { COARSE = !!v; },   // overview maps: approximate (cheap) plateau weights, see limWeights
  init(n, opts) {
    noise = n; GEN = (opts && opts.gen) || 1; BF.setLimits(GEN); SC = GEN >= 2 ? Math.max(1, (opts && opts.biomeScale) || 1) : 1;
    if (GEN >= 3) placeHome3();
    if (GEN >= 3) BF.rivers.init(n, macro3, { sea: BF.SEA, ns: 168, nmax: 64, reach: 100, marg: 140, outlet: 260, mouth: -2, w0: 2.0, w1: 4.5, wlo: 2, whi: 1000, slo: 20, shi: 500, density: 0.09, hs: 10 });
    else if (GEN >= 2) BF.rivers.init(n, macro2, { sea: BF.SEA });
    LAT.clear(); CRAW.clear(); CLIM.clear(); CLIS.clear(); villageCache.clear(); tintCache.clear(); spawnXZ = null; spawnV = undefined; STRATA = null; },
  generate,
  generateBand,
  generateRange,
  heightAt,
  _fields(x, z) { fields(x, z); const R = GEN >= 3 ? relief3(x, z, false) : null; return { cd: K.sp, cl: K.mp, mt: K.mt, c: K.c, pm: K.pm, p: K.p, e: K.e, t: K.t, hu: K.hu, S: R && R.S, m: R && R.m, rh: R && R.h, lo: K.lo }; },
  waterLevelAt(x, z) { climate(Math.floor(x), Math.floor(z)); return C.wl; },
  biomeAt,
  tintAt,
  villagesNear,
  nearestVillage,
  recordBuilding,
  bedPlan: bedPlanOf,
  palette: style => styles()[style | 0] || styles()[0],
  BTYPES,
};
})();
