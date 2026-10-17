// Terrain generation: continuous climate (temperature, humidity, continentalness, erosion, weirdness)
// drives smoothly blended heights and climate-adjacent biomes; caves, ores, trees, plants and villages.
// API: BF.worldgen = { init(noise, {biomeScale, villages}), generateBand(cx, cz) -> {lo, hi, vox},
//                      generateRange(cx, cz, sy0, sy1) -> Uint16Array, heightAt(x, z), biomeAt(x, z), tintAt(x, z),
//                      villagesNear(x, z, r), nearestVillage(x, z) }
// One world: the planet (generator 4, js/planet.js atlas coordinates). It works in absolute signed y with the mile-high limits
// BF.MIN_Y = -64, BF.H = 3072, BF.SEA = 0. The flat generators 1 to 3 were retired in 1.4 (spec r14-24); the terrain they left is
// generator 3's ("mile high"), which the planet samples on the sphere, so its functions keep their names (relief3, climate3, caves3...).
(() => {
"use strict";
const G = typeof window !== "undefined" ? window : self;   // self: the generator also runs in a Web Worker (r14-05)
const BF = (G.BF = G.BF || {});
let noise;
// The terrain's noise fields at an atlas position (x, z), from js/planetgen.js (set by init): they sample 3D noise at the point on the
// sphere, so the terrain is seamless across face edges. N2 / FB: simplex noise and fbm with wavelength L and offsets a, b. WARP: the
// position (x, z) moved by a domain warp of two terms (wavelength L, amplitude A, fields at offsets ax, az for x and bx, bz for z; then
// the same with L2, A2), into out. C3: a 3D field at block height y, wavelength LH across and LV up, offsets a, b, c.
let N2, FB, WARP, C3;

// ---------- biomes ----------
const OCEAN = 0, BEACH = 1, SNOWY_BEACH = 2, STONY_SHORE = 3, RIVER = 4, PLAINS = 5, FOREST = 6, FLOWER_FOREST = 7,
  BIRCH = 8, DARK_FOREST = 9, SWAMP = 10, MANGROVE = 11, DESERT = 12, BADLANDS = 13, SAVANNA = 14, SPARSE_JUNGLE = 15,
  JUNGLE = 16, TAIGA = 17, OLD_TAIGA = 18, SNOWY_PLAINS = 19, ICE_SPIKES = 20, SNOWY_TAIGA = 21, MEADOW = 22,
  CHERRY = 23, MOUNTAINS = 24, SNOWY_SLOPES = 25, PEAKS = 26, STONY_PEAKS = 27, MUSHROOM = 28, FROZEN_OCEAN = 29;
const NAMES = ["Ocean", "Beach", "Snowy Beach", "Stony Shore", "River", "Plains", "Forest", "Flower Forest",
  "Birch Forest", "Dark Forest", "Swamp", "Mangrove Swamp", "Desert", "Badlands", "Savanna", "Sparse Jungle",
  "Jungle", "Taiga", "Old Growth Taiga", "Snowy Plains", "Ice Spikes", "Snowy Taiga", "Meadow",
  "Cherry Grove", "Windswept Hills", "Snowy Slopes", "Jagged Peaks", "Stony Peaks", "Mushroom Fields", "Frozen Ocean"];   // (29: the planet only)
// Tree probability per 4x4 cell, and ground plants per column: [short_grass, fern, flowers, dead_bush, mushrooms]
const TREE_DENSITY = [], PLANTS = [];
(function () {
  const t = (b, d, g, f, fl, db, m) => { TREE_DENSITY[b] = d; PLANTS[b] = [g, f, fl, db, m]; };
  for (let b = 0; b <= FROZEN_OCEAN; b++) t(b, 0, 0, 0, 0, 0, 0);
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
function patchField(x, z, s, o, ox, oz, jit) {
  const key = s * 1000 + o;
  let g = fieldCache.get(key);
  if (!g) {
    g = new Float32Array(81);
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) g[j * 9 + i] = N2(ox + i * 2, oz + j * 2, s, o, -o * 0.7);
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

// temperature / humidity band thresholds (fbm units; roughly 16/22/27/19/16 % of the world)
const BANDS = [-0.3, -0.1, 0.12, 0.3];
const band = v => (v < BANDS[0] ? 0 : v < BANDS[1] ? 1 : v < BANDS[2] ? 2 : v < BANDS[3] ? 3 : 4);

// The relative biome size of the current world (1 = original size; it scales the climate noise). Set by init().
let SC = 1;
// Village generator of the current world (BF.state.villages): 1 = classic (8-25 buildings, roster capped at 24, kept for saved worlds),
// 2 = each village draws a population of 2-100 villagers and its layout grows until it has a bed for every one of them.
// 3 = as 2, with at least 4 villagers (a miner, a farmer, a forester and a toolsmith, js/mobs.js villageRoster) and a garden with trees in desert villages.
// 4 = as 3, and a village of 8 or more villagers has a poultry keeper with a chicken coop (js/poultry.js). Worlds saved with 3 keep 3: no coops appear in them.
// 5 = as 4, and a village of 10 or more villagers on grass has a cowherd with a fenced pasture (js/cowherd.js). Worlds saved with 4 keep 4: no pastures appear in them.
// 6 = as 5, and a village of 15 or more villagers has a baker per 15 villagers, with a baker's oven placed by the jobs plan (js/baker.js, js/mobs.js
//     villageRoster, js/jobs.js planVillage); no plot of its own, so layouts are the same as 5. Worlds saved with 5 keep 5: their bakers come when an oven is placed.
// 7 = as 6, and windows are glass panes instead of glass blocks; a village with natural sand within 64 blocks (sandNear) starts with a glassmaker,
//     a glass kiln and a furnace 80% of the time (js/glassmaker.js, js/mobs.js villageRoster, js/jobs.js planVillage). Worlds saved with 6 keep 6:
//     their buildings keep their glass blocks (builders build panes everywhere: recordBuilding).
// 8 = as 7, and bees (js/bees.js): about 3% of oak and birch trees in forests, meadows and plains carry a bee nest; a grass village of 6 or more
//     villagers starts with a beekeeper, its honey extractor, 2 beehives of 8-12 bees and a small flower bed by the farms (js/beekeeper.js,
//     js/mobs.js villageRoster, js/jobs.js planVillage). Worlds saved with 7 keep 7: no nests appear in their trees.
// 9 = as 8, and a village of 10 or more villagers on grass gets a pig farmer 60% of the time (js/mobs.js villageRoster, drawn from the village
//     key), with a 7x8 sty added after every other plot (so nothing else moves) and its feed trough beside the gate (js/pigfarmer.js,
//     js/jobs.js planVillage). Worlds saved with 8 or less keep theirs: no sties appear in them.
// 10 = as 9, with one rule for animal keepers (idea-044, paddockPlan): the village's size and the animals native to its biome decide how many
//     paddocks it gets (no population or grass thresholds), a weighted roll picks each one's animal, and each paddock has its own keeper
//     (shepherd, cowherd, poultry keeper, pig farmer or stable hand, js/mobs.js villageRoster). Pens are no longer rolled among the plots,
//     a pasture always has a grass floor, a horse paddock is a stable laid out as the builder's (blueprints.js "stable"). There is no spawn
//     village: every village is a region village on the strict site rules. Worlds saved with 9 or less keep theirs.
let VGEN = 1;
let PG = null;            // BF.planetgen (js/planetgen.js): the 3D noise sampler, the continents, the climate bands and the spawn search
let REC = false;          // recordBuilding is running (builders' blueprints): windows are panes whatever the world's village generator
const winB = () => (VGEN >= 7 || REC ? BF.B.glass_pane : BF.B.glass);
const BAKER_POP = 15;     // village generator 6: a baker per this many villagers (js/mobs.js villageRoster reads BF.worldgen.BAKER_POP)
const PIG_POP = 10;       // village generator 8: villages of this many villagers on grass may get a pig farmer and a sty (js/mobs.js villageRoster reads BF.worldgen.PIG_POP)
const COWHERD_POP = 10;   // village generator 5: villages of this many villagers on grass get a cowherd and a pasture (js/mobs.js villageRoster reads BF.worldgen.COWHERD_POP)
// World limits (see docs/MILE_HIGH_CONTRACT.md): MIN_Y, H (exclusive top), SEA, and the section range SY0 .. SY1
BF.setLimits = function () {
  BF.MIN_Y = -64; BF.H = 3072; BF.SEA = 0; BF.SY0 = BF.MIN_Y >> 4; BF.SY1 = BF.H >> 4;
};
// Slow climate fields at a (warped) position. Writes into K.
const WA1 = [0, 0];
const K = { t: 0, hu: 0, c: 0, e: 0, wd: 0, wx: 0, wz: 0, u: 0, p: 0, pm: 0, lo: 0, mt: 0, sp: 0, mp: 0, el: 0 };
// The slow fields: climate zones scale with SC; the continents are js/planetgen.js's, and so are temperature and humidity (its climate bands).
function rawFields(x, z) {
  const q = Math.sqrt(SC), wl = 230 * q, wa = 48 * q;
  WARP(x, z, wl, wa, 11.1, -7.7, -31.3, 5.5, 60, 8, 3.3, 0, 0, -9.9, WA1);
  const wx = WA1[0], wz = WA1[1];
  K.wx = wx; K.wz = wz;
  const LT = 2400 * SC, LH = 2000 * SC;
  K.t = FB(wx, wz, LT, 41.37, -17.71, 2) * 0.85;
  K.hu = FB(wx, wz, LH, 311.7, -173.3, 2) * 0.85;
  K.c = cont3(x, z);
  PG.climate(wx, wz, K.c, K);   // temperature and humidity from the planet's climate bands (K.el: climate latitude)
  const LE = 1700 * q, LW = 600 * Math.pow(SC, 0.6), LU = 3600 * q;
  K.e = FB(wx, wz, LE, 77.7, 901.3, 3);
  K.wd = FB(wx, wz, LW, -201.1, 44.4, 2);
  K.u = FB(wx, wz, LU, 613.3, -88.8, 3);
  // plateau level selector and plateau coverage mask (very long wavelengths)
  // unwarped coordinates: the short-wavelength biome warp would squeeze these slow fields into steep steps
  const LL = 12000 * q;
  K.p = FB(x, z, LL, 905.1, -311.3, 2);
  K.pm = 0; K.mt = 0;
  if (OPEN_SEA && K.c <= -0.13) K.sp = K.mp = K.lo = 0;   // (open sea: relief3 doesn't read them there, see riverCol)
  else limWeights(x, z);     // K.sp plateau weight, K.mp massif weight, K.lo low-plateau weight (all slope limited)
}
// continentalness alone (as rawFields), for the coarse slope-limiter grid
function contOnly(x, z) { return cont3(x, z); }
// The continents are js/planetgen.js's (generator 3's continent field in 3D, turned per seed to keep the cube corners in open sea).
function cont3(x, z) { return PG.cont(x, z); }
// Slope-limited plateau and massif weights on a coarse grid (CG blocks). Raw weights at the nodes may change abruptly (continent
// edges are steep in continentalness); each node then takes min over a disc of (raw weight + slope * distance), which caps
// how fast the weight (and so the height) can rise anywhere, so escarpments become long ramps and massifs broad domes.
// Pure function of the seed: nodes are cached, any order gives the same values.
const CG = 320, SL_P = 1 / 6000, SL_M = 1 / 2600, SL_L = 1 / 2600, LIM_R = Math.ceil(6000 / CG);
// Node values are cached in 32 x 32 tiles of a Float64Array (NaN = not worked out yet): the disc scans read ~1000 nodes each, and
// typed-array reads are far quicker than map lookups (r14-23). A cache past its tile limit starts over.
const TS = 32, TN = TS * TS;
function tileCache(width, limit, extra = 0) {   // (extra: more values after the nodes')
  const tiles = new Map();
  let lastK = NaN, lastA = null;
  const c = {
    A: null,   // the tile array of the last at()
    at(i, j) {   // offset of node (i, j) in c.A
      const ti = Math.floor(i / TS), tj = Math.floor(j / TS), k = ti * 1048576 + tj;
      if (k !== lastK) {
        lastA = tiles.get(k);
        if (!lastA) { if (tiles.size >= limit) tiles.clear(); lastA = new Float64Array(TN * width + extra).fill(NaN); tiles.set(k, lastA); }
        lastK = k;
      }
      c.A = lastA;
      return ((i - ti * TS) * TS + (j - tj * TS)) * width;
    },
    clear() { tiles.clear(); lastK = NaN; lastA = null; c.A = null; },
  };
  return c;
}
const CRAW = tileCache(3, 1600, 2 * (TN / 16)), CLIS = tileCache(2, 600), CLIM = tileCache(3, 400);
function rawFill(A, o, i, j) {
  const x = i * CG, z = j * CG, q = Math.sqrt(SC);
  const c = contOnly(x, z);
  const pm = FB(x, z, 18000 * q, 1234.5, -777.7, 2), mt = FB(x, z, 14000 * q, 333.3, -444.4, 2);
  const inland = smooth(0.15, 0.3, c);   // a coastal plain before the ramps start
  const pl = inland * smooth(-0.75, -0.3, pm);
  const lo = FB(x, z, 14000 * q, 55.5, -99.9, 2);
  A[o] = pl; A[o + 1] = pl * smooth(0.05, 0.45, mt); A[o + 2] = smooth(-0.03, -0.22, lo);
}
// offset in CRAW.A of node (i, j)'s raw weights [plateau, massif, low plateau]
function rawAt(i, j) {
  const o = CRAW.at(i, j), A = CRAW.A;
  if (A[o] !== A[o]) rawFill(A, o, i, j);
  return o;
}
function nodeRaw(i, j) { const o = rawAt(i, j), A = CRAW.A; return [A[o], A[o + 1], A[o + 2]]; }
// disc offsets sorted by distance: a scan stops once slope * distance exceeds the current minimum (raw weights are >= 0)
const LIM_OFF = (() => {
  const o = [];
  for (let b = -LIM_R; b <= LIM_R; b++) for (let a = -LIM_R; a <= LIM_R; a++) { const d = Math.hypot(a, b) * CG; if (d <= LIM_R * CG + 1) o.push([a, b, d]); }
  o.sort((p, q) => p[2] - q[2] || p[1] - q[1] || p[0] - q[0]);
  return [].concat(...o);
})();
// The disc scan of pass 1 goes by 4 x 4 blocks of nodes, nearest first, and skips a block when even its lowest raw weights plus the
// slope from its nearest node can't lower the minimum: the same nodes decide the result, so the values are exactly the plain scan's.
// Inside plateaus, where every node in the disc has to be ruled out, this reads ~100 block minimums instead of ~1100 nodes.
// BLK[p]: for a node at position p = (i & 3) * 4 + (j & 3) within its block, the blocks touching its disc as
// [block offset i, block offset j, nearest distance, first node, node count], nodes in BLKN[p] as [offset i, offset j, distance]
const BLK = [], BLKN = [];
for (let pi = 0; pi < 4; pi++) for (let pj = 0; pj < 4; pj++) {
  const bl = [];
  for (let bi = Math.floor((pi - LIM_R) / 4); bi <= Math.floor((pi + LIM_R) / 4); bi++) for (let bj = Math.floor((pj - LIM_R) / 4); bj <= Math.floor((pj + LIM_R) / 4); bj++) {
    const nodes = [];
    for (let u = 0; u < 4; u++) for (let v = 0; v < 4; v++) {
      const a = bi * 4 + u - pi, b = bj * 4 + v - pj, d = Math.hypot(a, b) * CG;
      if (d <= LIM_R * CG + 1) nodes.push(a, b, d);
    }
    if (nodes.length) bl.push({ bi, bj, dmin: Math.min(...nodes.filter((_, k) => k % 3 === 2)), nodes });
  }
  bl.sort((p, q) => p.dmin - q.dmin);
  const B = [], Nd = [];
  for (const k of bl) { B.push(k.bi, k.bj, k.dmin, Nd.length, k.nodes.length / 3); Nd.push(...k.nodes); }
  BLK.push(Float64Array.from(B)); BLKN.push(Float64Array.from(Nd));
}
// offset in CRAW.A of block (bi, bj)'s lowest plateau and low-plateau raw weights (filling its 16 nodes the first time)
function blockMinAt(bi, bj) {
  const i0 = bi * 4, j0 = bj * 4;
  CRAW.at(i0, j0);
  const li = i0 - Math.floor(i0 / TS) * TS, lj = j0 - Math.floor(j0 / TS) * TS, m = TN * 3 + ((li >> 2) * (TS >> 2) + (lj >> 2)) * 2;
  let A = CRAW.A;
  if (A[m] !== A[m]) {
    let m0 = Infinity, m2 = Infinity;
    for (let u = 0; u < 4; u++) for (let v = 0; v < 4; v++) { const o = rawAt(i0 + u, j0 + v); A = CRAW.A; if (A[o] < m0) m0 = A[o]; if (A[o + 2] < m2) m2 = A[o + 2]; }
    A[m] = m0; A[m + 1] = m2;
  }
  return m;
}
// pass 1: plateau and low-plateau weights; offset in CLIS.A
function limSAt(i, j) {
  let o = CLIS.at(i, j), V = CLIS.A;
  if (V[o] !== V[o]) {
    let r = rawAt(i, j), A = CRAW.A;
    let sp = A[r], lw = A[r + 2];
    const p = (i & 3) * 4 + (j & 3), B = BLK[p], Nd = BLKN[p], bi = i >> 2, bj = j >> 2;
    for (let k = 0; k < B.length; k += 5) {
      const dm = B[k + 2];
      if (dm * SL_P >= sp && dm * SL_L >= lw) break;
      const m = blockMinAt(bi + B[k], bj + B[k + 1]); A = CRAW.A;
      if (A[m] + dm * SL_P >= sp && A[m + 1] + dm * SL_L >= lw) continue;
      for (let n = B[k + 3], e = n + B[k + 4] * 3; n < e; n += 3) {
        const d = Nd[n + 2];
        r = rawAt(i + Nd[n], j + Nd[n + 1]); A = CRAW.A;
        const a = A[r] + d * SL_P, l = A[r + 2] + d * SL_L;
        if (a < sp) sp = a;
        if (l < lw) lw = l;
      }
    }
    o = CLIS.at(i, j); V = CLIS.A;
    V[o] = sp; V[o + 1] = lw;
  }
  return o;
}
// pass 2: massifs only start where the plateau is (nearly) complete, so their flanks never add to an escarpment
const mRaw = (i, j) => { const o = rawAt(i, j), r = CRAW.A[o + 1]; if (!(r > 0)) return 0; const so = limSAt(i, j); return r * smooth(0.85, 1.0, CLIS.A[so]); };
// [plateau, massif, low plateau] limited weights of node (i, j): offset in CLIM.A
function limAt(i, j) {
  let o = CLIM.at(i, j), V = CLIM.A;
  if (V[o] !== V[o]) {
    const so = limSAt(i, j), s0 = CLIS.A[so], s1 = CLIS.A[so + 1];
    let mp = mRaw(i, j);
    for (let n = 0; n < LIM_OFF.length; n += 3) {
      const d = LIM_OFF[n + 2];
      if (d * SL_M >= mp) break;
      const b = mRaw(i + LIM_OFF[n], j + LIM_OFF[n + 1]) + d * SL_M;
      if (b < mp) mp = b;
    }
    o = CLIM.at(i, j); V = CLIM.A;
    V[o] = s0; V[o + 1] = mp; V[o + 2] = s1;
  }
  return o;
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
  let o = limAt(i, j), V = CLIM.A; const a0 = V[o], a1 = V[o + 1], a2 = V[o + 2];
  o = limAt(i + 1, j); V = CLIM.A; const b0 = V[o], b1 = V[o + 1], b2 = V[o + 2];
  o = limAt(i, j + 1); V = CLIM.A; const c0 = V[o], c1 = V[o + 1], c2 = V[o + 2];
  o = limAt(i + 1, j + 1); V = CLIM.A; const d0 = V[o], d1 = V[o + 1], d2 = V[o + 2];
  K.sp = lerp(lerp(a0, b0, tu), lerp(c0, d0, tu), tw);
  K.mp = lerp(lerp(a1, b1, tu), lerp(c1, d1, tu), tw);
  K.lo = lerp(lerp(a2, b2, tu), lerp(c2, d2, tu), tw);
}
// The slow fields are sampled on a 4-block lattice (cached) and bilinearly interpolated: identical results
// for any call order, and ~10x cheaper per column. Nodes live in one preallocated buffer (LAT maps key -> offset): wide auto maps touch
// millions of fresh nodes, and a typed array per node let the browser grow by gigabytes of short-lived buffers before freeing them.
const LAT = new Map(), LAT_MAX = 60000, LAT_W = 15, LATB = new Float64Array(LAT_MAX * LAT_W);
function lattice(lx, lz) {
  const key = lx * 1048576 + lz;
  let o = LAT.get(key);
  if (o === undefined) {
    rawFields(lx * 4, lz * 4);
    o = LAT.size * LAT_W;
    LATB[o] = K.t; LATB[o + 1] = K.hu; LATB[o + 2] = K.c; LATB[o + 3] = K.e; LATB[o + 4] = K.wd; LATB[o + 5] = K.wx - lx * 4; LATB[o + 6] = K.wz - lz * 4;
    LATB[o + 7] = K.u; LATB[o + 8] = K.p; LATB[o + 9] = K.pm; LATB[o + 10] = K.lo; LATB[o + 11] = K.mt; LATB[o + 12] = K.sp; LATB[o + 13] = K.mp; LATB[o + 14] = K.el;
    LAT.set(key, o);
  }
  return o;
}
function fields(x, z) {
  const lx = Math.floor(x / 4), lz = Math.floor(z / 4), fx = (x - lx * 4) / 4, fz = (z - lz * 4) / 4;
  if (LAT.size > LAT_MAX - 4) LAT.clear();   // here, not in lattice(): the four nodes below must not be overwritten while in use
  // a node with no weight isn't computed (exactly the same result; distant terrain samples whole columns on lattice points, js/grid.js)
  const L = LATB, a = lattice(lx, lz), b = fx ? lattice(lx + 1, lz) : a, c = fz ? lattice(lx, lz + 1) : a, d = fx && fz ? lattice(lx + 1, lz + 1) : fx ? b : c;
  const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
  K.t = L[a + 0] * w00 + L[b + 0] * w10 + L[c + 0] * w01 + L[d + 0] * w11;
  K.hu = L[a + 1] * w00 + L[b + 1] * w10 + L[c + 1] * w01 + L[d + 1] * w11;
  K.c = L[a + 2] * w00 + L[b + 2] * w10 + L[c + 2] * w01 + L[d + 2] * w11;
  K.e = L[a + 3] * w00 + L[b + 3] * w10 + L[c + 3] * w01 + L[d + 3] * w11;
  K.wd = L[a + 4] * w00 + L[b + 4] * w10 + L[c + 4] * w01 + L[d + 4] * w11;
  K.wx = x + L[a + 5] * w00 + L[b + 5] * w10 + L[c + 5] * w01 + L[d + 5] * w11;
  K.wz = z + L[a + 6] * w00 + L[b + 6] * w10 + L[c + 6] * w01 + L[d + 6] * w11;
  K.u = L[a + 7] * w00 + L[b + 7] * w10 + L[c + 7] * w01 + L[d + 7] * w11;
  K.p = L[a + 8] * w00 + L[b + 8] * w10 + L[c + 8] * w01 + L[d + 8] * w11;
  K.pm = L[a + 9] * w00 + L[b + 9] * w10 + L[c + 9] * w01 + L[d + 9] * w11;
  K.lo = L[a + 10] * w00 + L[b + 10] * w10 + L[c + 10] * w01 + L[d + 10] * w11;
  K.mt = L[a + 11] * w00 + L[b + 11] * w10 + L[c + 11] * w01 + L[d + 11] * w11;
  K.sp = L[a + 12] * w00 + L[b + 12] * w10 + L[c + 12] * w01 + L[d + 12] * w11;
  K.mp = L[a + 13] * w00 + L[b + 13] * w10 + L[c + 13] * w01 + L[d + 13] * w11;
  K.el = L[a + 14] * w00 + L[b + 14] * w10 + L[c + 14] * w01 + L[d + 14] * w11;
}

// Full column climate. Writes into C (no allocation) and returns the terrain surface height.
// C.wl is the water level of the column (sea level, or the surface of a river or lake), C.rv is 1 inside a river channel and its banks.
const C = { S: 0, h: 0, t: 0, hu: 0, c: 0, e: 0, wd: 0, m: 0, rf: 0, sw: 0, bw: 0, mi: 0, biome: 0, tb: 0, hb: 0, wl: 48, rv: 0, lk: 0 };
// A margin address (the unfolded neighbouring face) is the canonical cell it shows, so a column is the same whichever face's
// frame asks for it. Outside every face square there is nothing: deep sea.
const CCELL = {};
const ownCell = (x, z) => { const c = BF.planet.canonCell(x, z, CCELL); return !c.off && c.x === x && c.z === z; };
// Features across face edges (r14-11). Trees, jungle bushes and pumpkin / melon patches are laid out on grids of the face they grow
// on, and decided there, in that face's own coordinates; a chunk near an edge also draws those of the neighbouring face within reach,
// turned into its own frame, so a tree that straddles an edge is the same tree on both sides. A map takes the neighbour's atlas blocks
// into this face's frame: an integer quarter turn plus offset, X = m0 x + m1 z + m2, Z = m3 x + m4 z + m5 (the exact unfold of
// js/planet.js EDGE). edgeMaps lists the neighbours whose margin the area [x0, x1) x [z0, z1) of face f reaches into, each with the box
// of the neighbour's own blocks that maps into the area (corner wedges excluded: open sea).
const mapX = (m, x, z) => m[0] * x + m[1] * z + m[2], mapZ = (m, x, z) => m[3] * x + m[4] * z + m[5];
const unmapX = (m, X, Z) => m[0] * (X - m[2]) + m[3] * (Z - m[5]), unmapZ = (m, X, Z) => m[1] * (X - m[2]) + m[4] * (Z - m[5]);
function edgeMaps(f, x0, x1, z0, z1) {
  const Pl = BF.planet, N = Pl.N, W = Pl.W, out = [];
  if (!(f >= 0 && f < 6)) return out;   // off the atlas (no face: x < 0, z < 0 or past the last face): open sea, no neighbours
  const u0 = x0 - W * f - N, u1 = x1 - W * f - N, v0 = z0 - N, v1 = z1 - N;
  for (let s = 0; s < 4; s++) {
    if (!(s === 0 ? u0 < 0 : s === 1 ? u1 > N : s === 2 ? v0 < 0 : v1 > N)) continue;
    const e = Pl.EDGE[f][s], g = e.g, A = e.A, t = e.t;
    const T = (xg, zg, o) => {
      const ug = xg - W * g - N + 0.5, vg = zg - N + 0.5;
      o[0] = Math.floor(W * f + N + A[0] * ug + A[1] * vg + t[0]); o[1] = Math.floor(N + A[2] * ug + A[3] * vg + t[1]); return o;
    };
    const bx = W * g + N, bz = N, p = T(bx, bz, [0, 0]), px = T(bx + 1, bz, [0, 0]), pz = T(bx, bz + 1, [0, 0]);
    const m = [px[0] - p[0], pz[0] - p[0], 0, px[1] - p[1], pz[1] - p[1], 0];
    m[2] = p[0] - m[0] * bx - m[1] * bz; m[5] = p[1] - m[3] * bx - m[4] * bz;
    // the part of the area past this side only (not past two sides: a corner's wedge)
    const a0 = s < 2 ? (s === 0 ? x0 : W * f + 2 * N) : Math.max(x0, W * f + N), a1 = s < 2 ? (s === 0 ? W * f + N : x1) : Math.min(x1, W * f + 2 * N);
    const b0 = s >= 2 ? (s === 2 ? z0 : 2 * N) : Math.max(z0, N), b1 = s >= 2 ? (s === 2 ? N : z1) : Math.min(z1, 2 * N);
    if (a1 <= a0 || b1 <= b0) continue;
    const xs = [unmapX(m, a0, b0), unmapX(m, a1 - 1, b1 - 1)], zs = [unmapZ(m, a0, b0), unmapZ(m, a1 - 1, b1 - 1)];
    out.push({ g, m, a0, a1, b0, b1, gx0: Math.min(xs[0], xs[1]), gx1: Math.max(xs[0], xs[1]) + 1, gz0: Math.min(zs[0], zs[1]), gz1: Math.max(zs[0], zs[1]) + 1 });
  }
  return out;
}
// whether a mapped position lies in a map's part of the area
const inMap = (E, X, Z) => X >= E.a0 && X < E.a1 && Z >= E.b0 && Z < E.b1;
function climate(x, z) {
  const c = BF.planet.canonCell(x, z, CCELL);
  if (!c.off) return climate3(c.x, c.z);
  C.h = BF.MIN_Y + 6; C.t = C.hu = C.e = C.wd = C.m = C.rf = C.sw = C.bw = C.mi = C.rv = C.S = 0; C.c = -1.4;
  C.biome = OCEAN; C.tb = 2; C.hb = 2; C.wl = BF.SEA; C.lk = 0;
  return C.h;
}
const RV = { d: 0, w: 0, rs: 0, sd: 0 };

// ---------- the terrain (generator 3's, "mile high"): sea level y = 0, ocean floors down to -58, high plains around y 900-1300, ranges up to ~2500 ----------
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
// Terrain height without rivers (K must hold the fields at x, z). `detail`: local hills and the full ridged-noise mountains.
// Plateau weight S, massif weight m and low-plateau weight K.lo come from the slope-limited coarse grid (see nodeLim), so
// escarpments are ramps ~5 km long (after a 1-2 km coastal plain) and massifs domes ~5 km across.
function relief3(x, z, detail) {
  const { t, hu, c, e } = K;
  const hills = detail ? FB(x, z, 170, 71.3, -33.1, 4) : 0;
  const land = smooth(-0.13, -0.02, c);
  const wet = smooth(-0.35, 0.45, hu), hot = smooth(-0.1, 0.45, t);
  const S = Math.min(1, K.sp) * land;
  const amp = 4 + 6 * wet + 6 * wet * hot + 3 * smooth(-0.2, 0.2, e < 0 ? -e : 0);
  const hA = lerp(4, amp, land);
  // near sea level the hills fade out, so the shoreline is one clean line instead of a belt of islets and puddles
  const bz = contBase3(c), hk = 0.12 + 0.88 * smooth(0, 12, Math.abs(bz - BF.SEA));
  const low = bz + hills * hA * hk + 2.5 * wet * land;
  // plateau top: level ~910..1110 (the p field tilts it very gently), some regions are lower plateaus (~390..590), plus long low swells
  const lvl = 1010 + 100 * Math.tanh(K.p / 0.45) - 520 * smooth(0, 1, Math.min(1, K.lo));
  const swell = 5 * N2(x, z, 520, 19.7, -4.4) + (detail ? 0.3 * N2(x, z, 90, -8.2, 13.1) : 0);
  const top = lvl + swell + hills * hA * 0.03;
  const Sn = Math.min(1, S / 0.88), Ss = Sn * Sn * (3 - 2 * Sn);   // the ramp eases in at the foot and levels off into the plain
  let h = lerp(low, top, Ss);
  // rolling foothills along the escarpment
  const fa = 4 * Ss * (1 - Ss);
  if (fa > 0.02) h += fa * (45 * (FB(x, z, 700, 3.3, -8.8, 2) + 0.15) + hills * 6);
  // mountain massifs on the plateaus: domes rising as m^2 (gentle foot, steeper summit) up to ~2000 above the plain (ceil3 compresses)
  const m = Math.min(1, K.mp) * land;
  if (m > 0) {
    const q = Math.sqrt(SC);
    let r = 0.7 * (1 - Math.abs(N2(x, z, 2600 * q, -401.2, 133.4)));
    r += 0.3 * (1 - Math.abs(N2(x, z, 1000 * q, 17.1, -9.3)));
    const g = m * m;
    h += g * (2100 * (0.75 + 0.25 * r) + (detail ? hills * 10 : 0));
  }
  return { h, m, land, hills, S };
}
// Ground height before rivers (K must hold the fields at x, z): relief3 plus badlands mesas, swamps and mushroom islands. Writes the
// weights climate3 goes on with into G3S.
const G3S = { m: 0, land: 0, hills: 0, S: 0, bw: 0, sw: 0, mi: 0 };
function ground3(x, z) {
  const SEA = BF.SEA;
  const { t, hu, c, wd } = K;
  const R = relief3(x, z, true), m = R.m, land = R.land, hills = R.hills, S = R.S;
  let h = R.h;
  // badlands mesas (hot, dry, weird): terraced bumps on top of the local ground
  const bw = smooth(0.26, 0.36, t) * (1 - smooth(-0.14, -0.04, hu)) * smooth(0.0, 0.18, wd) * land * (1 - m);
  if (bw > 0) {
    const p = h + 14 + (FB(x, z, 160, 5.5, -8.8, 2) + 0.3) * 26;
    const step = Math.floor(p / 6) * 6, f = p - step;
    const terr = step + (f > 3 ? (f - 3) * 2 : 0);
    if (terr > h) h = lerp(h, terr, bw);
  }
  // swamps / mangroves: low, wet, warm-ish coasts and lowlands
  // (only on low ground: pulling a ramp or plateau towards sea level would cut cliffs into it)
  const sw = smooth(0.2, 0.36, hu) * smooth(-0.2, -0.06, t) * (1 - smooth(0.02, 0.3, c)) * land * (1 - m) * (1 - S) * (1 - smooth(SEA + 12, SEA + 45, h));
  if (sw > 0) h = lerp(h, SEA + 0.35 + hills * 2.6, sw);
  let mi = 0;
  if (c < -0.8 && !(PG.nearCorner(x, z) || t < -0.1)) {   // (not at the cube corners, which stay open sea, nor in cold seas)
    mi = smooth(0.7, 0.8, N2(x, z, 520, 77.7, -55.5)) * smooth(-0.8, -0.95, c);
    if (mi > 0) h = lerp(h, SEA + 3 + hills * 7, mi);
  }
  G3S.m = m; G3S.land = land; G3S.hills = hills; G3S.S = S; G3S.bw = bw; G3S.sw = sw; G3S.mi = mi;
  return ceil3(h);
}
// The planet's rivers (js/planetrivers.js, spec r14-10): one drainage network for the whole planet, solved once per world the first time
// a river is looked up (or by solveRivers, a step of the loading screen). Its samplers take a unit direction. Routing height is
// relief3 without local hills plus 250 x continentalness (generator 3's phi = p + 150c, at the prototype's weight): the gentle rise
// from the coast inland is what gathers tributaries into trunk rivers. A node is sea where the ground is ocean floor (climate3's rule).
// Ground is ground3, the height before rivers. Both read the raw fields (exact, and no lattice cache filled with scattered points);
// K and G3S are kept, since ground is also sampled lazily from inside climate3 (a river's full profile is read on first use).
let PRIV = null, PSOLVE = null, PSEED = null;   // (PSEED: the network's key, seed and biome size, which both shape the terrain)
// networks solved earlier in this session, by key, most recent last: switching back to one of the last few worlds (the title screen,
// tests) doesn't solve it again (each is about 50 MB, so two besides the current one)
const PCACHE = new Map(), PCACHE_N = 2;
const RIM = 6;   // a lake's rim is raised by at most this much (lower ground past it stays: rare, where a gap runs on below the water)
const RT = { e: 0, hf: 0, land: 0, rain: 0, elat: 0 }, RG = {}, RA = {}, KSV = {}, GSV = {};
// The river samplers skip the plateau weights at sea (continentalness up to -0.13, where relief3's land weight is 0 and the weights
// change nothing): most of the planet is sea, and its slope-limited grid would be most of the solve's time.
let OPEN_SEA = false;
function riverCol(dx, dy, dz) {
  const P = BF.planet, g = P.fromDir(dx, dy, dz, RG);
  P.atlas(g.f, g.u, g.v, RA);
  OPEN_SEA = true;
  try { rawFields(Math.floor(RA.x), Math.floor(RA.z)); } finally { OPEN_SEA = false; }
  return RA;
}
let INSLICE = false;   // inside a solve slice, which keeps K and G3S once for all its samples
function riverSample(dx, dy, dz) {
  if (!INSLICE) { Object.assign(KSV, K); Object.assign(GSV, G3S); }
  const a = riverCol(dx, dy, dz), x = Math.floor(a.x), z = Math.floor(a.z);
  RT.hf = ground3(x, z);
  RT.e = ceil3(relief3(x, z, false).h) + 250 * Math.max(0, K.c / 2.5);
  RT.land = RT.hf < BF.SEA - 1 && K.c < -0.08 ? -1 : 1;
  RT.rain = Math.max(0, K.hu / 1.1 + 0.37); RT.elat = K.el;
  if (!INSLICE) { Object.assign(K, KSV); Object.assign(G3S, GSV); }
  return RT;
}
function riverGround(dx, dy, dz) {
  if (!INSLICE) { Object.assign(KSV, K); Object.assign(GSV, G3S); }
  const a = riverCol(dx, dy, dz), h = ground3(Math.floor(a.x), Math.floor(a.z));
  if (!INSLICE) { Object.assign(K, KSV); Object.assign(G3S, GSV); }
  return h;
}
// The network, solving it now if it isn't yet. solveRivers() solves it in slices instead: each call runs one slice and returns the
// fraction done (1 when ready), for the loading screen (js/main.js prepareWorld, which may hand the first call the node samples, worked
// out in workers).
function planetRivers() {
  if (PRIV) return PRIV;
  while (solveRivers() < 1);
  return PRIV;
}
// Copies of the network in workers (the distant land's, js/lodworker.js) start from riverState(): the node samples and a tape of every
// ground sample the solve took, in order, which adoptRivers replays (each checked against the direction asked for; a mismatch goes
// back to sampling). The worker then only redoes the solve's own sums, about a fifth of its time, and gets the same network.
let TAPE = null, TMODE = 0, TK = 0;   // TMODE 1: recording, 2: replaying, 0: sampling
const tapeKey = (dx, dy, dz) => Math.fround(dx + 2 * dy + 3 * dz);
function groundT(dx, dy, dz) {
  if (TMODE === 2) {
    if (TK < TAPE.v.length && TAPE.c[TK] === tapeKey(dx, dy, dz)) return TAPE.v[TK++];
    TMODE = 0; TAPE.miss = TK;
  }
  const h = riverGround(dx, dy, dz);
  if (TMODE === 1) { TAPE.v.push(h); TAPE.c.push(tapeKey(dx, dy, dz)); }
  return h;
}
function solveRivers(pre) {
  if (PRIV) return 1;
  if (!PSOLVE) { PSOLVE = BF.planetRivers.steps(noise.seed, riverSample, groundT, pre || null); if (TMODE !== 2) { TAPE = { v: [], c: [] }; TMODE = 1; } }
  const ks = Object.assign({}, K), gs = Object.assign({}, G3S);
  let r;
  INSLICE = true;
  try { r = PSOLVE.next(); } finally { INSLICE = false; Object.assign(K, ks); Object.assign(G3S, gs); }
  if (r.done) {
    PRIV = r.value; PSOLVE = null;
    if (TMODE === 1) { TAPE = { v: Float64Array.from(TAPE.v), c: Float32Array.from(TAPE.c) }; }
    TMODE = 0;   // (later samples, a river's profile read on first use, aren't on the tape)
    return 1;
  }
  return Math.min(0.99, r.value);
}
// the network's starting state for a copy in a worker (solving it here first if needed)
function riverState() {
  planetRivers();
  return TAPE && TAPE.v instanceof Float64Array ? { seed: PSEED, pre: PRIV.pre, v: TAPE.v, c: TAPE.c } : null;
}
// solve the network from riverState() (in a worker, after init with the same seed); false if it isn't for this world
function adoptRivers(st) {
  if (!st || st.seed !== PSEED) return false;
  if (PRIV) return true;
  PSOLVE = null; TAPE = { v: st.v, c: st.c, miss: -1 }; TMODE = 2; TK = 0;
  while (solveRivers(st.pre) < 1);
  return true;
}
function climate3(x, z) {
  const SEA = BF.SEA, MINY = BF.MIN_Y;
  fields(x, z);
  const { t, hu, c, e, wd } = K;
  let h = ground3(x, z);
  const { m, land, S, bw, sw, mi } = G3S, h0 = h;
  // rivers: a valley floor at the water surface with a flat floodplain, blended into the surrounding terrain
  let wl = SEA, rv = 0, chan = false, lake = false;
  const rl = Math.max(land, smooth(SEA - 3, SEA + 1, h));   // dry shore ground counts as land for rivers (outlets cut through coastal ridges)
  if (rl > 0.3 && mi === 0 && BF.rivers.at(x, z, RV)) {
    const rs = Math.max(SEA, Math.floor(RV.rs)), sd = RV.sd, w = RV.w;
    let hr;
    if (sd < 0) { const q = RV.d / w; hr = rs - 1.4 - (3.2 + Math.min(4, Math.max(0, w - 7) * 0.15)) * (1 - q * q); }   // wide rivers run a little deeper
    else hr = rs + 1.4 + smooth(0, 14, sd) * 1.5;
    const vw = Math.min(BF.rivers.REACH - 3, Math.max(27, (h > hr ? h - hr : 1.6 * (hr - h)) * 1.4));
    const fp = (1 - smooth(w + 3, w + 3 + vw, RV.d)) * rl;
    if (!(h < SEA - 1 && hr > h)) h = h + (hr - h) * fp;     // never raise the sea floor (outlets run on into open water)
    if (sd < 0 && fp > 0.9) { chan = true; wl = rs; if (h > rs - 1) h = rs - 1; }
    else if (sd < 3 && h < rs + 1 && h >= SEA - 1) h = rs + 1;   // banks, but no levees out into the sea (they would dam the mouth)
    if (sd < 6) rv = 1;
  }
  // lakes: water up to the lake's level wherever the ground (before river valleys were cut) is below it
  if (mi === 0 && h < BF.H) {
    const lw = BF.rivers.lakeAt(x, z);
    if (lw >= SEA && h0 < lw && h < lw) { lake = true; rv = 1; if (lw > wl) wl = lw; }
    else if (lw < 0 && !chan) {   // just past the drawn water, ground a little below the lake is its rim, raised to the water
      const rim = BF.rivers.lakeRim(x, z);
      if (rim > SEA && h < rim && rim - h <= RIM) h = rim;
    }
  }
  h = Math.floor(h);
  if (h < MINY + 6) h = MINY + 6; else if (h > BF.H - 6) h = BF.H - 6;

  // ---- discrete biome (dithered borders) ----
  const sc = Math.pow(SC, 0.7);
  const dj = N2(x, z, 22 * sc, 7.1, 0) * 0.02 + (noise.hash(x, z, 77) - 0.5) * 0.008 * (1 + 0.45 * (SC - 1));
  // altitude cools slowly; the high plains are a little drier (rain shadow of the escarpment): more steppe and savanna, fewer forests
  const tb = band(t - PG.cool(K.el, h) + dj), hb = band(hu - 0.16 * S - dj);
  let b;
  if (mi > 0.5 && h >= SEA - 1) b = MUSHROOM;
  else if (h < SEA - 1 && c < -0.08) b = tb === 0 ? FROZEN_OCEAN : OCEAN;   // (arctic seas)
  else if (chan || lake) b = RIVER;
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
  // the planet's bands are wide: meadows on temperate high plains, cherry groves in mild subtropical forest
  if (b === PLAINS && tb === 2 && h >= 900 + dj * 2000) b = MEADOW;
  else if (b === FOREST && tb === 3 && wd > 0.24) b = CHERRY;

  C.h = h; C.t = t; C.hu = hu; C.c = c; C.e = e; C.wd = wd; C.m = m; C.rf = chan ? 1 : 0; C.sw = sw; C.bw = bw; C.mi = mi;
  C.biome = b; C.tb = tb; C.hb = hb; C.wl = wl; C.rv = rv; C.S = S; C.lk = lake ? 1 : 0;
  return h;
}

function biomeAt(x, z) {
  climate(Math.floor(x), Math.floor(z));
  const id = C.biome;
  let name = NAMES[id];
  if (id === FROZEN_OCEAN) name = (C.h < -30 ? "Deep " : "") + "Frozen Ocean";
  else if (id === OCEAN) name = (C.h < -30 ? "Deep " : "") + ["Frozen ", "Cold ", "", "Lukewarm ", "Warm "][C.tb] + "Ocean";
  else if (id === RIVER && C.lk) name = C.tb === 0 ? "Frozen Lake" : "Lake";   // (the planet's lakes)
  else if (id === RIVER && C.tb === 0) name = "Frozen River";
  return { name, id, height: C.h, temperature: +C.t.toFixed(2), humidity: +C.hu.toFixed(2) };
}

// ---------- tints (grass / foliage / water multipliers) ----------
// Climate-based colormap, continuous in temperature/humidity so borders blend smoothly.
const tintCache = new Map();   // chunk key -> Float32Array(256 * 9), filled by generate()
const TINT_MAX = 1500;
function tintCompute(x, z, out, o) {
  fields(x, z);
  tintK(out, o);
}
// the tints of the fields last computed (K)
function tintK(out, o) {
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
  { const c = BF.planet.canonCell(x, z, CCELL); if (!c.off) { x = c.x; z = c.z; } }
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
const entranceAt = (x, z) => N2(x, z, 90, 33.3, -71.1) > 0.62;

// ---------- villages ----------
// One candidate per REGION x REGION area, so a village never crosses a region border. There is no spawn village.
const REGION = 384, RHALF = 192, VLIM = 70;
const VILLAGE_BIOMES = [PLAINS, SAVANNA, DESERT, SNOWY_PLAINS, TAIGA, MEADOW];
const villageCache = new Map();

// Village regions on the planet (r14-12, the chart method: each face's grid is a flat world for village code). The region grid is laid
// on each face's own grid (u, v) from its corner, so a region lines up with chunks and never spans two faces. Region (rx, rz) of face
// f has rx = f * RF + ru and rz = rv, and covers u in [ru * REGION, (ru + 1) * REGION), v likewise. 384 doesn't divide N, so the last
// row and column of a face are partial. A region whose square comes within EDGE_KEEP of an edge holds no village (the first and last
// row and column: about 0.9% of regions). A village keeps 4 blocks inside its region, so it, its farms and paths, and its builders'
// sites (js/builder.js SITE_RANGE outside its box) all stay well clear of the edge. Siting reads C.rv, so villages keep off rivers
// and lakes (r14-10).
const RF = 1024, EDGE_KEEP = 64;
let PN = 0, PW = 0;                // the planet's N and atlas face width (set by init)
// The region (as [rx, rz]) holding canonical atlas column (x, z); null off every face's grid square (a margin address: callers
// canonicalise first when they may be in a margin).
function pRegion(x, z) {
  const f = Math.floor(x / PW), u = x - PW * f - PN, v = z - PN;
  if (f < 0 || f > 5 || u < 0 || u >= PN || v < 0 || v >= PN) return null;
  return [f * RF + Math.floor(u / REGION), Math.floor(v / REGION)];
}
// The atlas centre of planet region (rx, rz), or null when the region is too near an edge to hold a village.
function pRegionCentre(rx, rz) {
  const f = Math.floor(rx / RF), ru = rx - f * RF;
  if (f < 0 || f > 5) return null;
  for (const r of [ru, rz]) if (r * REGION < EDGE_KEEP || (r + 1) * REGION > PN - EDGE_KEEP) return null;
  return [PW * f + PN + ru * REGION + RHALF, PN + rz * REGION + RHALF];
}
const pc = {};
function canonXZ(x, z) {
  const c = BF.planet.canonCell(x, z, pc);
  return c.off ? null : c;
}

// relaxed: 0 strict (region villages), 1 also forests/snowy taiga, 2 also beaches, hills, cherry groves, 3 almost anywhere
function siteOK(x, z, relaxed) {
  const SEA = BF.SEA;
  const h0 = climate(x, z), b = C.biome;
  if (h0 <= SEA || C.rv) return false;
  if (!(VILLAGE_BIOMES.includes(b) || (relaxed && (b === FOREST || b === BIRCH || b === SNOWY_TAIGA || b === FLOWER_FOREST)) ||
      (relaxed > 1 && (b === BEACH || b === MOUNTAINS || b === CHERRY || b === SPARSE_JUNGLE)) ||
      (relaxed > 2 && b !== OCEAN && b !== FROZEN_OCEAN && b !== RIVER && b !== PEAKS && b !== STONY_PEAKS && b !== MUSHROOM))) return false;
  let lo = h0, hi = h0, wet = 0, bad = 0;
  for (let dz = -28; dz <= 28; dz += 7) for (let dx = -28; dx <= 28; dx += 7) {
    const h = climate(x + dx, z + dz), bb = C.biome;
    if (h <= SEA || C.rv) wet++;
    if (h < lo) lo = h; if (h > hi) hi = h;
    if ((bb === MOUNTAINS && relaxed < 2) || bb === PEAKS || bb === STONY_PEAKS || bb === SNOWY_SLOPES || bb === OCEAN || bb === FROZEN_OCEAN ||
        bb === RIVER || bb === JUNGLE || bb === SWAMP || bb === MANGROVE || bb === DARK_FOREST || bb === BADLANDS) bad++;
  }
  return wet <= [4, 8, 10, 14][relaxed] && hi - lo <= [9, 12, 15, 18][relaxed] && bad <= [3, 8, 12, 81][relaxed];
}

// Village population (village generator 2): a shifted gamma draw, 2 + Gamma(k = 2.5, theta = 32/3), so the mode is 18, the mean ~29 and
// the right tail is long (about 1 village in 20 has 60+, 1 in 500 reaches the maximum of 100). Redrawn above 100. Deterministic from (a, b, salt).
const POP_MIN = 2, POP_MIN3 = 4, POP_MAX = 100, POP_K = 2.5, POP_THETA = 32 / 3;
function villagePop(a, b, salt) {
  let s = ((noise.hash(a, b, salt) * 4294967296) >>> 0) || 1;
  const u = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
  const normal = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const d = POP_K - 1 / 3, c = 1 / Math.sqrt(9 * d);   // Marsaglia-Tsang
  for (let tries = 0; tries < 64; tries++) {
    const x = normal(), v = Math.pow(1 + c * x, 3);
    if (v <= 0 || Math.log(u()) >= 0.5 * x * x + d - d * v + d * Math.log(v)) continue;
    const n = Math.round(POP_MIN + d * v * POP_THETA);
    if (n <= POP_MAX) return Math.max(VGEN >= 3 ? POP_MIN3 : POP_MIN, n);   // village generator 3: at least a miner, a farmer, a forester and a toolsmith
  }
  return 18;
}
// Half-width of the square a village of `pop` villagers may spread over around its centre (72 for the classic generator).
const villageExtent = pop => Math.min(150, Math.max(56, Math.round(40 + 36 * Math.sqrt(pop / 18))));

// Village generator 10 (idea-044): the paddocks of a village of `pop` villagers centred at (x, z), in roll order, e.g. ["sheep", "cow", "sheep"].
// Native animals are the village biome's wild animals (js/wildlife.js HABITAT: open land 5, woods 3, snow 1, else none). The count is
// E = pop / 10 x (0.4 + 0.15 x native types) x a factor of 0.6-1.4, its fractional part rounding up by chance; each paddock's animal is a
// weighted roll, 4 for a native animal and 1 for another, halved for each paddock of it already drawn. A village has one stable at most
// (js/stables.js keeps one stable hand per village), so a horse is not drawn again. Deterministic from the village key and the world seed.
const PADDOCK_ANIMALS = ["chicken", "sheep", "pig", "cow", "horse"];
const KEEPER_OF = { chicken: "poultry_keeper", sheep: "shepherd", pig: "pig_farmer", cow: "cowherd", horse: "stable_hand" };
function nativeAnimals(biomeId) {
  const tbl = (BF.wildlife && BF.wildlife.HABITAT && BF.wildlife.HABITAT[biomeId]) || [];
  return PADDOCK_ANIMALS.filter(a => tbl.some(t => t[0] === a));
}
// The planet: is there wild-horse land within HORSE_R blocks of (x, z), a chunk whose herd region (js/wildlife.js ZONE, zoneKind) is a horse
// one? Only a village there may draw a stable: elsewhere its stable hand would find no wild horse in reach and give up every day (as a builder
// only puts up a stable where wild horses live). Cached per village centre.
const HORSE_R = 100;   // js/stables.js CATCH_R
const horseCache = new Map();
function horseLand(x, z) {
  const W = BF.wildlife;
  if (!W || !W.zoneKind) return true;
  const key = Math.round(x) + "," + Math.round(z);
  let ok = horseCache.get(key);
  if (ok !== undefined) return ok;
  ok = false;
  const CS = 16, Z = W.ZONE, c0x = Math.floor((x - HORSE_R) / CS), c1x = Math.floor((x + HORSE_R) / CS), c0z = Math.floor((z - HORSE_R) / CS), c1z = Math.floor((z + HORSE_R) / CS);
  for (let cz = c0z; cz <= c1z && !ok; cz++) for (let cx = c0x; cx <= c1x && !ok; cx++) {
    const bx = cx * CS + 8, bz = cz * CS + 8;
    if (Math.hypot(bx - x, bz - z) > HORSE_R) continue;
    const tbl = W.HABITAT[biomeAt(bx, bz).id];
    if (!tbl || !tbl.some(t => t[0] === "horse")) continue;
    if (W.zoneKind(tbl, tbl.reduce((s, t) => s + t[1], 0), Math.floor(cx / Z), Math.floor(cz / Z)) === "horse") ok = true;
  }
  horseCache.set(key, ok);
  return ok;
}
function paddockPlan(x, z, pop, biomeId) {
  if (!pop || !noise) return [];
  if (biomeId == null) { climate(Math.floor(x), Math.floor(z)); biomeId = C.biome; }
  const nat = nativeAnimals(biomeId);
  const noHorse = !horseLand(x, z);
  const E = pop / 10 * (0.4 + 0.15 * nat.length) * (0.6 + 0.8 * noise.hash(x, z, 701));
  let n = Math.floor(E);
  if (noise.hash(x, z, 702) < E - n) n++;
  const have = {}, out = [];
  for (let k = 0; k < n; k++) {
    const w = PADDOCK_ANIMALS.map(a => (a === "horse" && (have.horse || noHorse)) ? 0 : (nat.includes(a) ? 4 : 1) / Math.pow(2, have[a] || 0));
    let r = noise.hash(x + 7 * k, z, 703) * w.reduce((s, q) => s + q, 0), i = 0;
    while (i < w.length - 1 && (r -= w[i]) >= 0) i++;
    while (!w[i]) i--;   // float edge: never the horse a second time
    have[PADDOCK_ANIMALS[i]] = (have[PADDOCK_ANIMALS[i]] || 0) + 1;
    out.push(PADDOCK_ANIMALS[i]);
  }
  return out;
}

function villageRegion(rx, rz) {
  const key = rx + "," + rz;
  let v = villageCache.get(key);
  if (v !== undefined) return v;
  v = null;
  const c = pRegionCentre(rx, rz);
  if (!c) { villageCache.set(key, v); return v; }
  const [rcx, rcz] = c;
  if (noise.hash(rx, rz, 501) < 0.85) {
    const pop = VGEN >= 2 ? villagePop(rx, rz, 530) : 0;
    const E = pop ? villageExtent(pop) : 72, lim = pop ? Math.min(VLIM, RHALF - 4 - E) : VLIM;   // the village stays inside its region
    for (let k = 0; k < 12 && !v; k++) {
      const x = rcx + Math.round((noise.hash(rx, rz, 510 + k) * 2 - 1) * lim);
      const z = rcz + Math.round((noise.hash(rx, rz, 520 + k) * 2 - 1) * lim);
      if (siteOK(x, z, 0)) v = layoutVillage(x, z, pop);
    }
  }
  villageCache.set(key, v);
  return v;
}
function inVillage(v, x, z, m) { return !!v && x >= v.minX - m && x <= v.maxX + m && z >= v.minZ - m && z <= v.maxZ + m; }
function villageAt(x, z, m) {
  let r = pRegion(x, z);
  if (!r) { const c = canonXZ(x, z); if (!c) return null; x = c.x; z = c.z; r = pRegion(x, z); if (!r) return null; }
  const v = villageRegion(r[0], r[1]);
  return inVillage(v, x, z, m) ? v : null;
}

const PASSES10 = [[3, 0], [3, 1], [12, 0], [21, 0], [30, 1], [30, 0], [39, 0], [39, 1]];   // village generator 10: paddock plots, nearest first (back from the road, past its end)
const BTYPES = {
  house: [5, 5], house2: [5, 6], lhouse: [7, 7], big: [7, 7], library: [9, 7], church: [5, 10],
  smith: [7, 6], farm: [9, 7], bigfarm: [13, 9], pen: [9, 8], hay: [3, 3], garden: [11, 11], coop: [7, 7], pasture: [11, 9], sty: [7, 8], stable: [13, 7],
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

// Village layout: plaza + well + bell, up to 4 main roads with side streets, lamps.
// Classic (pop = 0): 8-25 buildings. Sized (pop > 0, village generator 2): the street network is laid out for the village's extent
// (villageExtent), plots are filled from the plaza outward until there is a bed for each of the pop villagers, then streets are trimmed
// back to their last building; null when the site cannot hold them all.
function layoutVillage(cx, cz, pop) {
  const SEA = BF.SEA;
  const y0 = climate(cx, cz), biome = C.biome;
  const style = biome === DESERT ? 1 : (biome === SNOWY_PLAINS || biome === SNOWY_TAIGA || C.tb === 0) ? 2 :
    biome === SAVANNA ? 3 : (biome === TAIGA || C.tb === 1) ? 4 : 0;
  let s = ((noise.hash(cx, cz, 601) * 4294967296) >>> 0) || 1;
  const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const v = { x: cx, y: y0, z: cz, biome: NAMES[biome], style, pads: [], roads: [], lamps: [], decor: [], buildings: [], houses: [],
    minX: cx - 7, maxX: cx + 7, minZ: cz - 7, maxZ: cz + 7, minY: y0 };
  if (pop) v.pop = pop;
  if (VGEN >= 10) v.biomeId = biome;   // village generator 10: the roster's paddock plan reads it (paddockPlan)
  v.ground = biome === DESERT ? 1 : style === 2 ? 2 : 0;   // set again at the end (unchanged); known this early for the roster (js/mobs.js villageRoster: cowherds on grass)
  const E = pop ? villageExtent(pop) : 72, RL = E - 8;    // building / road reach from the centre
  const sc = pop ? Math.max(1, Math.sqrt(pop / 18)) : 1; // street length scale
  let occ = [];
  const overlaps = a => occ.some(o => a[0] <= o[2] && a[2] >= o[0] && a[1] <= o[3] && a[3] >= o[1]);
  const plaza = [cx - 7, cz - 7, cx + 7, cz + 7];
  occ.push(plaza);
  v.pads.push({ x0: plaza[0], z0: plaza[1], x1: plaza[2], z1: plaza[3], y: y0, path: true });

  // roads: walk outward from (sx, sz) along (dx, dz) following terrain
  const roads = [];
  function addRoad(sx, sz, dx, dz, maxLen, minLen, parent, at) {
    let prev = climate(sx, sz), end = -1;
    if (prev < SEA || C.rv) return null;
    for (let t = 0; t <= maxLen; t++) {
      const x = sx + dx * t, z = sz + dz * t;
      if (Math.abs(x - cx) > RL || Math.abs(z - cz) > RL) break;
      const h = climate(x, z);
      if (h < SEA || C.rv || Math.abs(h - prev) > 2) break;
      prev = h; end = t;
    }
    if (end < minLen) return null;
    const ex = sx + dx * end, ez = sz + dz * end;
    const box = [Math.min(sx, ex) - (dz ? 1 : 0), Math.min(sz, ez) - (dx ? 1 : 0), Math.max(sx, ex) + (dz ? 1 : 0), Math.max(sz, ez) + (dx ? 1 : 0)];
    if (overlaps(box)) return null;
    const road = { sx, sz, dx, dz, end, x0: box[0], z0: box[1], x1: box[2], z1: box[3] };
    if (pop) Object.defineProperty(road, "_p", { value: { parent: parent || null, at: at || 0, need: 0, box }, enumerable: false });
    roads.push(road); v.roads.push(road); occ.push(box);
    return road;
  }
  const mains = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const r = addRoad(cx + dx * 8, cz + dz * 8, dx, dz, Math.round((30 + ((rand() * 20) | 0)) * sc), 10);
    if (r) mains.push(r);
  }
  if (mains.length < 2) return null;
  if (!pop) {
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
  } else {
    // a street grid that grows with the village: side streets every ~16 blocks along each road (both sides once the village is
    // big), cross streets off the side streets, a third level for the largest villages
    const lvl = sc >= 1.8 ? 3 : sc >= 1.25 ? 2 : 1;
    let gen = mains.slice();
    for (let L = 1; L <= lvl; L++) {
      const next = [];
      for (const r of gen) {
        for (let t = 10 + ((rand() * 6) | 0); t <= r.end - 4; t += 14 + ((rand() * 6) | 0)) {
          for (const side of rand() < 0.5 ? [1, -1] : [-1, 1]) {
            if (L === 1 && sc < 1.25 && side === -1 && rand() < 0.7) continue;   // small villages: mostly one-sided, like the classic layout
            const px = r.dz ? side : 0, pz = r.dx ? side : 0;
            const len = Math.round((14 + ((rand() * 14) | 0)) * (L === 1 ? Math.min(sc, 1.8) : 1));
            const c = addRoad(r.sx + r.dx * t + px * 2, r.sz + r.dz * t + pz * 2, px, pz, len, 8, r, t);
            if (c) next.push(c);
          }
        }
      }
      gen = next;
    }
  }

  // buildings beside the roads
  const cm = pop ? Math.max(1, Math.round(pop / 24)) : 1;
  const caps = { smith: cm, church: cm, library: cm, pen: 3 * cm, bigfarm: 2 * cm }, count = {};
  const pick = () => {
    const r = rand();
    const ty = r < 0.24 ? "house" : r < 0.36 ? "house2" : r < 0.46 ? "lhouse" : r < 0.55 ? "big" : r < 0.6 ? "library" :
      r < 0.65 ? "church" : r < 0.7 ? "smith" : r < 0.82 ? "farm" : r < 0.87 ? "bigfarm" : r < 0.94 ? (VGEN >= 10 ? "hay" : "pen") : "hay";   // village generator 10: pens come only with shepherds (below)
    if (caps[ty] && (count[ty] || 0) >= caps[ty]) return "house";
    return ty;
  };
  let beds = 0;
  // tries one plot of the next picked type at t along road / side; returns the step to the next plot
  function plot(road, side) {
    const { dx, dz } = road, t = road._t[side < 0 ? 1 : 0];
    const sx = dz ? side : 0, sz = dx ? side : 0;       // unit vector away from the road
    const type = pick();
    let [w, d] = BTYPES[type];
    if (type === "house" && rand() < 0.5) d = 6;
    if (t + w - 1 > road.end + 1) return Infinity;
    const bx = road.sx + dx * t + sx * 3, bz = road.sz + dz * t + sz * 3;
    const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
    const c0 = P(0, 0), c1 = P(w - 1, d - 1);
    const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
    let ok = Math.abs(box[0] - cx) < E && Math.abs(box[2] - cx) < E && Math.abs(box[1] - cz) < E && Math.abs(box[3] - cz) < E &&
      !overlaps(box);
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
    if (!ok) return 2;
    count[type] = (count[type] || 0) + 1;
    const b = { type, w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
      x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 607) };
    v.buildings.push(b);
    occ.push(box);
    v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
    if (LIVABLE[type]) {
      const bp = bedPlan(b).map(([u, q, a]) => { const p = P(u, q); return { x: p[0], y: y + 1, z: p[1], f: bedFacing(b, a) }; });
      v.houses.push({ x: b.x0, y, z: b.z0, w: b.x1 - b.x0 + 1, d: b.z1 - b.z0 + 1, doorX: b.doorX, doorZ: b.doorZ,
        outX: front[0], outZ: front[1], type, beds: bp });
      beds += Math.max(1, bp.length);
    }
    if (road._p) road._p.need = Math.max(road._p.need, t + w);
    return w + 2;
  }
  if (!pop) {
    for (const road of roads) for (const side of [1, -1]) {
      const k = side < 0 ? 1 : 0;
      road._t = road._t || [0, 0];
      road._t[k] = 1 + ((rand() * 3) | 0);
      while (road._t[k] < road.end && v.buildings.length < 25) {
        const st = plot(road, side);
        if (st === Infinity) break;
        road._t[k] += st;
      }
    }
    for (const road of roads) delete road._t;
    if (v.buildings.length < 8) return null;
  } else {
    // plots nearest the plaza first, until every villager has a bed
    const cur = [];
    for (const road of roads) {
      Object.defineProperty(road, "_t", { value: [1 + ((rand() * 3) | 0), 1 + ((rand() * 3) | 0)], writable: true, enumerable: false });
      for (const side of [1, -1]) cur.push({ road, side });
    }
    const distOf = c => { const r = c.road, t = r._t[c.side < 0 ? 1 : 0]; return Math.max(Math.abs(r.sx + r.dx * t - cx), Math.abs(r.sz + r.dz * t - cz)); };
    while (beds < pop && cur.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < cur.length; i++) { const d = distOf(cur[i]); if (d < bd) { bd = d; bi = i; } }
      const c = cur[bi], k = c.side < 0 ? 1 : 0;
      if (c.road._t[k] >= c.road.end) { cur.splice(bi, 1); continue; }
      const st = plot(c.road, c.side);
      if (st === Infinity) cur.splice(bi, 1); else c.road._t[k] += st;
    }
    if (beds < pop) return null;
    // trim each street back to its last building (and to the streets branching off it); drop streets with nothing on them
    for (let i = roads.length - 1; i >= 0; i--) {
      const r = roads[i], p = r._p;
      if (p.parent) p.parent._p.need = Math.max(p.parent._p.need, p.need > 0 ? p.at + 2 : 0);
    }
    v.roads = roads.filter(r => r._p.need > 0 || (!r._p.parent && mains.indexOf(r) < 2));
    for (const r of v.roads) {
      const end = Math.min(r.end, Math.max(r._p.parent ? 4 : 6, r._p.need + 1)), ex = r.sx + r.dx * end, ez = r.sz + r.dz * end;
      r.end = end;
      r.x0 = Math.min(r.sx, ex) - (r.dz ? 1 : 0); r.z0 = Math.min(r.sz, ez) - (r.dx ? 1 : 0);
      r.x1 = Math.max(r.sx, ex) + (r.dz ? 1 : 0); r.z1 = Math.max(r.sz, ez) + (r.dx ? 1 : 0);
    }
    roads.length = 0; roads.push(...v.roads);
    occ = [plaza].concat(roads.map(r => [r.x0, r.z0, r.x1, r.z1]), v.pads.slice(1).map(p => [p.x0, p.z0, p.x1, p.z1]));
  }

  // Shepherd pens: the jobs plan (js/jobs.js) makes some villagers shepherds, and each one is given a fenced pen with its loom
  // beside it. Pens the layout already rolled are used first; missing ones are added here, after everything else, so no other plot moves.
  // v.nb0 keeps the building count of the original layout: the villager roster keys off it (js/mobs.js), so these pens never change it.
  v.nb0 = v.buildings.length;
  // village generator 10: one paddock per keeper of the roster's paddock plan (paddockPlan), no cap, and reaching as far as the village does
  let keepers = null;
  if (VGEN >= 10 && BF.jobs && BF.jobs.keeperCounts) { try { keepers = BF.jobs.keeperCounts(v); } catch (e) { keepers = {}; } }
  const K10 = p => (keepers && keepers[p]) || 0, RCH = keepers ? Math.max(80, E + 8) : 0;
  if (BF.jobs && BF.jobs.shepherdCount) {
    let need = 0;
    if (keepers) need = K10("shepherd");
    else try { need = Math.min(BF.jobs.shepherdCount(v), 4); } catch (e) { need = 0; }
    let have = v.buildings.filter(b => b.type === "pen").length;
    const [w, d] = BTYPES.pen;
    // A pen plot at step t along a road, `back` blocks off its side: true when it fit and was added.
    const tryPen = (road, side, t, back) => {
      const { dx, dz } = road, sx = dz ? side : 0, sz = dx ? side : 0;
      const bx = road.sx + dx * t + sx * back, bz = road.sz + dz * t + sz * back;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(0, 0), c1 = P(w - 1, d - 1);
      const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
      const lim = RCH || 72;
      if (!(Math.abs(box[0] - cx) < lim && Math.abs(box[2] - cx) < lim && Math.abs(box[1] - cz) < lim && Math.abs(box[3] - cz) < lim) || overlaps(box)) return false;
      const du = w >> 1, door = P(du, 0), front = P(du, -1);
      const y = climate(front[0], front[1]);
      if (y < SEA || C.rv) return false;
      for (let q = -1; q <= d; q++) for (let u = -1; u <= w; u += (q === -1 || q === d) ? 1 : w + 1) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      for (let q = 1; q < d - 1; q += 2) for (let u = 1; u < w - 1; u += 2) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      v.buildings.push({ type: "pen", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
        x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 607) });
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      have++;
      return true;
    };
    // Free road frontage first; when the layout already filled it (large villages), past the road ends, then a row further back.
    const passes = keepers ? PASSES10 : [[3, 0], [3, 1], [12, 0], [21, 0]];
    for (const [back, beyond] of passes) for (const road of roads) for (const side of [1, -1]) {
      const t0 = beyond ? road.end + 2 : 1, t1 = beyond ? road.end + 24 : road.end + 2 - w;
      for (let t = t0; t <= t1 && have < need; t += 2) if (tryPen(road, side, t, back)) t += w;
    }
  }

  // Desert garden (village generator 3): sand grows no saplings, so a desert village gets a square of grass with one or two oak trees
  // for its forester (js/forester.js). It goes just past the end of a road, clear of the buildings, so the forester may replant there.
  if (VGEN >= 3 && style === 1) {
    const [w, d] = BTYPES.garden, M = 3;
    const tryGarden = (road, t, back) => {
      const { dx, dz } = road, sx = dz ? 1 : 0, sz = dx ? 1 : 0;
      const bx = road.sx + dx * t + sx * back, bz = road.sz + dz * t + sz * back;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(0, 0), c1 = P(w - 1, d - 1);
      const box = [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])];
      if (Math.max(Math.abs(box[0] - cx), Math.abs(box[2] - cx), Math.abs(box[1] - cz), Math.abs(box[3] - cz)) > E + 16) return false;
      if (overlaps([box[0] - M, box[1] - M, box[2] + M, box[3] + M])) return false;
      const mid = P(w >> 1, d >> 1), y = climate(mid[0], mid[1]);
      if (y < SEA || C.rv) return false;
      for (let q = 0; q < d; q += 2) for (let u = 0; u < w; u += 2) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      v.buildings.push({ type: "garden", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du: w >> 1, doorX: P(w >> 1, -1)[0], doorZ: P(w >> 1, -1)[1],
        x0: box[0], z0: box[1], x1: box[2], z1: box[3], h: noise.hash(bx, bz, 631) });
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      return true;
    };
    // straight on past a road's end first, then beside the end of it
    const order = mains.filter(r => roads.indexOf(r) >= 0).concat(roads.filter(r => mains.indexOf(r) < 0));
    found: for (const back of [-(d >> 1), 3, -d - 2]) for (const road of order) for (let t = road.end + 3; t <= road.end + 12; t += 3) if (tryGarden(road, t, back)) break found;
  }

  // Chicken coop (village generator 4): a village of 8 or more villagers has a poultry keeper (js/mobs.js villageRoster), who gets a fenced coop
  // with its nesting box beside it (js/jobs.js planVillage, js/poultry.js). Added last, like the pens, so no other plot moves.
  const nCoop = keepers ? K10("poultry_keeper") : VGEN >= 4 && (v.pop || 0) >= 8 ? 1 : 0;
  if (nCoop > 0) {
    const [w, d] = BTYPES.coop;
    let have = 0;
    const tryCoop = (road, side, t, back) => {
      const { dx, dz } = road, sx = dz ? side : 0, sz = dx ? side : 0;
      const bx = road.sx + dx * t + sx * back, bz = road.sz + dz * t + sz * back;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(-1, 0), c1 = P(w, d - 1);   // one column more on each side: the nesting box stands beside the fence
      const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
      const lim = RCH || 72;
      if (!(Math.abs(box[0] - cx) < lim && Math.abs(box[2] - cx) < lim && Math.abs(box[1] - cz) < lim && Math.abs(box[3] - cz) < lim) || overlaps(box)) return false;
      const du = w >> 1, door = P(du, 0), front = P(du, -1);
      const y = climate(front[0], front[1]);
      if (y < SEA || C.rv) return false;
      for (let q = -1; q <= d; q++) for (let u = -1; u <= w; u++) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      v.buildings.push({ type: "coop", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
        x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 641) });
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      return true;
    };
    const passes = keepers ? PASSES10 : [[3, 0], [3, 1], [12, 0], [21, 0]];
    found: for (const [back, beyond] of passes) for (const road of roads) for (const side of [1, -1]) {
      const t0 = beyond ? road.end + 2 : 2, t1 = beyond ? road.end + 24 : road.end + 1 - w;
      for (let t = t0; t <= t1; t += 2) if (tryCoop(road, side, t, back)) { if (++have >= nCoop) break found; t += w; }
    }
  }

  // Pasture (village generator 5): a village of 10 or more villagers on grass has a cowherd (js/mobs.js villageRoster, when one of its residents
  // can make way), who gets a fenced pasture with its milk churn beside it (js/jobs.js planVillage, js/cowherd.js). Added last, after the coop, so no other plot moves.
  let cowherd = 0;
  if (keepers) cowherd = K10("cowherd");
  else if (VGEN >= 5 && (v.pop || 0) >= COWHERD_POP && v.ground === 0 && BF.jobs && BF.jobs.cowherdCount) { try { cowherd = BF.jobs.cowherdCount(v); } catch (e) { cowherd = 0; } }
  if (cowherd > 0) {   // only when the roster has room for the cowherd (a village whose residents are all tradespeople it cannot replace has none)
    const [w, d] = BTYPES.pasture;
    let have = 0;
    const tryPasture = (road, side, t, back) => {
      const { dx, dz } = road, sx = dz ? side : 0, sz = dx ? side : 0;
      const bx = road.sx + dx * t + sx * back, bz = road.sz + dz * t + sz * back;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(-1, 0), c1 = P(w, d - 1);   // one column more on each side: the churn stands beside the fence
      const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
      const lim = RCH || 80;
      if (!(Math.abs(box[0] - cx) < lim && Math.abs(box[2] - cx) < lim && Math.abs(box[1] - cz) < lim && Math.abs(box[3] - cz) < lim) || overlaps(box)) return false;
      const du = w >> 1, door = P(du, 0), front = P(du, -1);
      const y = climate(front[0], front[1]);
      if (y < SEA || C.rv) return false;
      for (let q = -1; q <= d; q++) for (let u = -1; u <= w; u++) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      v.buildings.push({ type: "pasture", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
        x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 651) });
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      return true;
    };
    const passes = keepers ? PASSES10 : [[3, 0], [3, 1], [12, 0], [21, 0], [30, 1]];
    found: for (const [back, beyond] of passes) for (const road of roads) for (const side of [1, -1]) {
      const t0 = beyond ? road.end + 2 : 2, t1 = beyond ? road.end + 24 : road.end + 1 - w;
      for (let t = t0; t <= t1; t += 2) if (tryPasture(road, side, t, back)) { if (++have >= cowherd) break found; t += w; }
    }
  }

  // Sty (village generator 8): a village of PIG_POP (10) or more villagers on grass whose roster drew a pig farmer (js/mobs.js villageRoster, 60%)
  // gets a fenced sty with the feed trough beside its gate (js/jobs.js planVillage, js/pigfarmer.js). Added last, after the pasture, so no other plot moves.
  let pigs = 0;
  if (keepers) pigs = K10("pig_farmer");
  else if (VGEN >= 9 && (v.pop || 0) >= PIG_POP && v.ground === 0 && BF.jobs && BF.jobs.pigFarmerCount) { try { pigs = BF.jobs.pigFarmerCount(v); } catch (e) { pigs = 0; } }
  if (pigs > 0) {
    const [w, d] = BTYPES.sty;
    let have = 0;
    const trySty = (road, side, t, back) => {
      const { dx, dz } = road, sx = dz ? side : 0, sz = dx ? side : 0;
      const bx = road.sx + dx * t + sx * back, bz = road.sz + dz * t + sz * back;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(-1, 0), c1 = P(w, d - 1);   // one column more on each side, and the row in front of the fence: the trough stands beside the gate
      const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
      const lim = RCH || 80;
      if (!(Math.abs(box[0] - cx) < lim && Math.abs(box[2] - cx) < lim && Math.abs(box[1] - cz) < lim && Math.abs(box[3] - cz) < lim) || overlaps(box)) return false;
      const du = w >> 1, door = P(du, 0), front = P(du, -1);
      const y = climate(front[0], front[1]);
      if (y < SEA || C.rv) return false;
      for (let q = -1; q <= d; q++) for (let u = -1; u <= w; u++) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      v.buildings.push({ type: "sty", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
        x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 661) });
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      return true;
    };
    const passes = keepers ? PASSES10 : [[3, 0], [3, 1], [12, 0], [21, 0], [30, 1]];
    found: for (const [back, beyond] of passes) for (const road of roads) for (const side of [1, -1]) {
      const t0 = beyond ? road.end + 2 : 2, t1 = beyond ? road.end + 24 : road.end + 1 - w;
      for (let t = t0; t <= t1; t += 2) if (trySty(road, side, t, back)) { if (++have >= pigs) break found; t += w; }
    }
  }

  // Stable (village generator 10): a village whose paddock plan drew a horse gets the builder's stable (blueprints.js "stable": a shelter
  // and an 8x7 paddock with a double gate), its gate facing the road; the tack rack inside is the jobs plan's (js/jobs.js planVillage,
  // js/stables.js stableOf reads the building's rot and corner).
  if (K10("stable_hand") > 0 && BF.blueprints) {
    const [w, d] = BTYPES.stable;
    const tryStable = (road, side, t, back) => {
      const { dx, dz } = road, sx = dz ? side : 0, sz = dx ? side : 0;
      const bx = road.sx + dx * t + sx * back, bz = road.sz + dz * t + sz * back;
      const P = (u, q) => [bx + dx * u + sx * q, bz + dz * u + sz * q];
      const c0 = P(0, 0), c1 = P(w - 1, d - 1);
      const box = [Math.min(c0[0], c1[0]) - 1, Math.min(c0[1], c1[1]) - 1, Math.max(c0[0], c1[0]) + 1, Math.max(c0[1], c1[1]) + 1];
      if (!(Math.abs(box[0] - cx) < RCH && Math.abs(box[2] - cx) < RCH && Math.abs(box[1] - cz) < RCH && Math.abs(box[3] - cz) < RCH) || overlaps(box)) return false;
      const du = 8, front = P(du, -1);
      const y = climate(front[0], front[1]);
      if (y < SEA || C.rv) return false;
      for (let q = -1; q <= d; q++) for (let u = -1; u <= w; u++) {
        const p = P(u, q), h = climate(p[0], p[1]);
        if (h < SEA || C.rv || Math.abs(h - y) > 3) return false;
      }
      // the blueprint turn whose gate looks onto the road (local q = -1 in front of it)
      const ox = box[0] + 1, oz = box[1] + 1, qOf = (X, Z) => dx ? (Z - bz) * sz : (X - bx) * sx;
      let rot = -1, bp = null;
      for (let k = 0; k < 4 && rot < 0; k++) {
        const g = BF.blueprints.get("stable", k, style, 0.5, null, "oak");
        if (g && g.marks.out && g.marks.out.every(([mx, mz]) => qOf(ox + mx, oz + mz) === -1)) { rot = k; bp = g; }
      }
      if (rot < 0) return false;
      const door = [ox + bp.marks.out[0][0], oz + bp.marks.out[0][1]], rk = bp.marks.rack[0];
      v.buildings.push({ type: "stable", w, d, y, bx, bz, ax: dx, az: dz, sx, sz, du, doorX: door[0], doorZ: door[1],
        x0: box[0] + 1, z0: box[1] + 1, x1: box[2] - 1, z1: box[3] - 1, h: noise.hash(bx, bz, 671), rot, ox, oz, rack: [ox + rk[0], oz + rk[1]] });
      occ.push(box);
      v.pads.push({ x0: box[0], z0: box[1], x1: box[2], z1: box[3], y, path: false });
      return true;
    };
    found: for (const [back, beyond] of PASSES10) for (const road of roads) for (const side of [1, -1]) {
      const t0 = beyond ? road.end + 2 : 2, t1 = beyond ? road.end + 24 : road.end + 1 - w;
      for (let t = t0; t <= t1; t += 2) if (tryStable(road, side, t, back)) break found;
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
    try { v.arch = BF.signs.planArch(v, { climate: (x, z) => climate(x, z), region: pRegion(cx, cz) || [0, 0] }); } catch (e) { console.error(e); v.arch = null; }
    if (v.arch) occ.push(v.arch.box);
  }
  for (const o of occ) {
    v.minX = Math.min(v.minX, o[0]); v.minZ = Math.min(v.minZ, o[1]);
    v.maxX = Math.max(v.maxX, o[2]); v.maxZ = Math.max(v.maxZ, o[3]);
  }
  for (const [x, z] of v.lamps) {
    v.minX = Math.min(v.minX, x); v.maxX = Math.max(v.maxX, x); v.minZ = Math.min(v.minZ, z); v.maxZ = Math.max(v.maxZ, z);
  }
  // signposts to nearby villages (js/signs.js): sites at the main road ends and on the plaza, inside the village box as it stands
  // (they never grow it, so which villages a world has stays the same); which ones stand is decided when the village is drawn
  if (BF.signs && BF.signs.planPosts) {
    try { v.posts = BF.signs.planPosts(v, { climate: (x, z) => climate(x, z) }); } catch (e) { console.error(e); v.posts = null; }
  }
  for (const p of v.pads) v.minY = Math.min(v.minY, p.y);
  v.ground = biome === DESERT ? 1 : style === 2 ? 2 : 0;
  if (pop) v.reach = Math.max(48, Math.round(Math.hypot(Math.max(cx - v.minX, v.maxX - cx), Math.max(cz - v.minZ, v.maxZ - cz))));   // jobsite search radius (js/jobs.js)
  return v;
}

function padAt(v, x, z) {
  for (const p of v.pads) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return p;
  return null;
}

// Regions are walked in the caller's face frame, past an edge into its margin, each sample mapped to its canonical face's
// region; villages are canonical records, measured with the planet's distance (x, z may be a margin address).
function villagesNear(x, z, radius) {
  const out = [], seen = new Set(), a = { x, z }, step = RHALF;
  const n = Math.ceil(2 * radius / step);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const sx = Math.floor(Math.min(x + radius, x - radius + i * step)), sz = Math.floor(Math.min(z + radius, z - radius + j * step));
    let r = pRegion(sx, sz);
    if (!r) { const c = canonXZ(sx, sz); if (!c || c.wedge) continue; r = pRegion(c.x, c.z); if (!r) continue; }
    const key = r[0] + "," + r[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const v = villageRegion(r[0], r[1]);
    if (v && BF.planet.distance(a, v) <= radius) out.push(v);
  }
  return out;
}
const vdist = (v, x, z) => BF.planet.distance({ x, z }, v);
function nearestVillage(x, z) {
  let best = null, bd = Infinity;
  for (const v of villagesNear(x, z, REGION * 1.5)) {
    const d = vdist(v, x, z);
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
  // villager jobsites are planned before the buildings are drawn: the plan marks the farms no farmer works (b.untended, drawn run down)
  if (BF.jobs && BF.jobs.planVillage && !v.jobsites) v.jobsites = BF.jobs.planVillage(v);
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
  if (v.posts && BF.signs && BF.signs.drawPosts) {   // signposts to nearby villages (js/signs.js); finding the neighbours lays them out, so keep C
    if (!v.posts.assigned) { const c0 = Object.assign({}, C); try { BF.signs.assignPosts(v); } catch (e) { console.error(e); } Object.assign(C, c0); }
    BF.signs.drawPosts(v, set, styles()[v.style]);
  }
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
  const G = winB();
  for (let u = u0 + 2; u < u0 + w - 2; u += 2) { P(u, y, q0 + d - 1, G); if (!skipFront && w >= 7) P(u, y, q0, G); }
  for (let q = q0 + 2; q < q0 + d - 1; q += 2) { P(u0, y, q, G); P(u0 + w - 1, y, q, G); }
}

let YOUNG = null;   // mature crop block -> its young block
const youngOf = id => { if (!YOUNG) { YOUNG = new Map(); for (const b of BF.blocks) if (b && b.growsInto != null) YOUNG.set(b.growsInto, b.id); } return YOUNG.get(id); };
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
      // a farm no farmer works at spawn (b.untended, set by js/jobs.js planVillage, village generator 3) is run down by a seeded
      // amount s: up to 0.6 the water is there and the farmland intact, with fewer crops the higher s (30% down to a handful);
      // above 0.6 the channels are dry, the farmland dehydrated (js/farmland.js) and more and more of it back to dirt (all of it from 0.92)
      const s = b.untended ? noise.hash(b.bx, b.bz, 640) : -1, dry = s >= 0.6 && B.farmland_dry != null;
      const cropFrac = s < 0 ? 1 : dry ? 0.04 : 0.3 - 0.45 * s, dirtFrac = dry ? Math.min(1, (s - 0.6) / 0.32) : 0;
      const cellR = (u, q, k) => noise.hash(b.bx * 31 + u, b.bz * 17 + q, k);
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        if (u === 0 || u === w - 1 || q === 0 || q === d - 1) { P(u, y, q, S.log); continue; }
        if (mids.includes(u)) { P(u, y, q, dry ? 0 : B.water); continue; }   // a dry channel is an empty trench
        let sec = 0; for (const m of mids) if (u > m) sec++;
        const bandIx = (q - 1) >> 1;
        if (sec === 0 && bandIx === pumpkinBand) {            // a small pumpkin patch on plain soil
          P(u, y, q, v_ground(style)); P(u, y + 1, q, (u + q) % 3 === 0 ? B.pumpkin : 0);
          continue;
        }
        if (s < 0) { P(u, y, q, B.farmland); P(u, y + 1, q, pickCrop(noise.hash(b.bx * 7 + sec, b.bz * 13 + bandIx, 623))); continue; }
        if (cellR(u, q, 641) < dirtFrac) { P(u, y, q, B.dirt); continue; }
        P(u, y, q, dry ? B.farmland_dry : B.farmland);
        if (cellR(u, q, 642) < cropFrac) {   // the crops that are left, half of them still young
          const crop = pickCrop(noise.hash(b.bx * 7 + sec, b.bz * 13 + bandIx, 623));
          P(u, y + 1, q, cellR(u, q, 643) < 0.5 && youngOf(crop) != null ? youngOf(crop) : crop);
        }
      }
      return;
    }
    case "garden": {
      // grass over dirt, and one or two oak trees (trunks 3 in from the edge, so their leaves stay inside)
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) { P(u, y, q, B.grass); for (let k = 1; k <= 8; k++) P(u, y - k, q, B.dirt); }   // no foundation under it: the forester plants nowhere near built blocks
      const trees = b.h < 0.5 ? [[3, 3], [w - 4, d - 4]] : [[w >> 1, d >> 1]];
      trees.forEach(([tu, tq], i) => {
        const top = y + 1 + 4 + ((noise.hash(b.bx + i, b.bz, 632) * 3) | 0);
        for (let yy = y + 1; yy < top; yy++) P(tu, yy, tq, B.oak_log);
        for (let yy = top - 3; yy <= top; yy++) {
          const r = yy >= top - 1 ? 1 : 2;
          for (let dq = -r; dq <= r; dq++) for (let du2 = -r; du2 <= r; du2++) {
            if (!du2 && !dq && yy < top) continue;   // the trunk
            if (Math.abs(du2) === r && Math.abs(dq) === r && (yy === top || noise.hash(b.bx + tu + du2, yy, b.bz + tq + dq) < 0.5)) continue;   // ragged corners
            P(tu + du2, yy, tq + dq, B.oak_leaves);
          }
        }
      });
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
      // fenced animal pen with a gate facing the road, a trough and hay
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const edge = u === 0 || u === w - 1 || q === 0 || q === d - 1;
        if (edge && !(q === 0 && u === du)) P(u, y + 1, q, B.oak_fence);
      }
      if (BF.gateId) P(du, y + 1, 0, BF.gateId(b.ax !== 0 ? "x" : "z", 0));
      P(1, y + 1, d - 2, B.hay_bale); P(2, y + 1, d - 2, B.hay_bale); P(w - 2, y, d - 2, B.water);
      P(du, y, -1, B.dirt_path);
      return;
    }
    case "pasture": {
      // cow pasture (js/cowherd.js): a fenced grass field with a gate facing the road, hay bales and a sunken water trough along the back; the churn beside it is the jobs plan's
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const edge = u === 0 || u === w - 1 || q === 0 || q === d - 1;
        if (edge && !(q === 0 && u === du)) P(u, y + 1, q, B.oak_fence);
        else if (!edge) P(u, y, q, VGEN >= 10 ? B.grass : v_ground(style));   // village generator 10: a grass floor, in a desert or snowy village too
      }
      if (BF.gateId) P(du, y + 1, 0, BF.gateId(b.ax !== 0 ? "x" : "z", 0));
      P(1, y + 1, d - 2, B.hay_bale); P(2, y + 1, d - 2, B.hay_bale);
      for (let u = w - 5; u <= w - 2; u++) P(u, y, d - 2, B.water);
      P(du, y, -1, B.dirt_path);
      return;
    }
    case "sty": {
      // pig sty (js/pigfarmer.js): a fenced pen with a gate facing the road, a muddy coarse-dirt corner by the gate, a sunken water trough in
      // the back row and a small plank-roofed shelter over the back corner; the feed trough beside the gate is the jobs plan's
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const edge = u === 0 || u === w - 1 || q === 0 || q === d - 1;
        if (edge && !(q === 0 && u === du)) P(u, y + 1, q, B.oak_fence);
        else if (!edge) P(u, y, q, (u <= 2 && q <= 2 && !(u === 2 && q === 2)) || (u === 1 && q === 3) ? B.coarse_dirt : v_ground(style));
      }
      if (BF.gateId) P(du, y + 1, 0, BF.gateId(b.ax !== 0 ? "x" : "z", 0));
      P(1, y, d - 2, B.water); P(2, y, d - 2, B.water);
      for (const [u, q] of [[w - 1, d - 3], [w - 3, d - 1], [w - 1, d - 1]]) P(u, y + 2, q, B.oak_fence);   // the shelter's posts (on the fence; none in the pen)
      for (let q = d - 3; q < d; q++) for (let u = w - 3; u < w; u++) P(u, y + 3, q, B.planks);
      P(du, y, -1, B.dirt_path);
      return;
    }
    case "stable": {
      // stable (village generator 10, js/stables.js): the builder's blueprint, turned so its gate faces the road (layoutVillage picked b.rot);
      // blueprint level 0 stands on the pad. The tack rack is the jobs plan's (js/jobs.js planVillage puts it on the rack mark).
      const bp = BF.blueprints.get("stable", b.rot, style, 0.5, null, "oak");
      for (const c of bp.cells) {
        if (c.id === B.tack_rack) continue;
        const X = b.ox + c.x, Z = b.oz + c.z;
        const u = b.ax ? (X - b.bx) * b.ax : (Z - b.bz) * b.az, q = b.ax ? (Z - b.bz) * b.sz : (X - b.bx) * b.sx;
        P(u, y + 1 + c.y, q, c.id);
      }
      for (const [mx, mz] of bp.marks.out) { const X = b.ox + mx, Z = b.oz + mz; P(b.ax ? (X - b.bx) * b.ax : (Z - b.bz) * b.az, y, -1, B.dirt_path); }
      return;
    }
    case "coop": {
      // chicken coop (js/poultry.js): a fenced run with a gate facing the road and hay bales in the back corners; the nesting box beside it is the jobs plan's
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++) {
        const edge = u === 0 || u === w - 1 || q === 0 || q === d - 1;
        if (edge && !(q === 0 && u === du)) P(u, y + 1, q, B.oak_fence);
        else if (!edge) P(u, y, q, noise.hash(b.bx + u, b.bz + q, 642) < 0.35 ? B.coarse_dirt : v_ground(style));   // scratched-up ground
      }
      if (BF.gateId) P(du, y + 1, 0, BF.gateId(b.ax !== 0 ? "x" : "z", 0));
      P(1, y + 1, d - 2, B.hay_bale); P(w - 2, y + 1, d - 2, B.hay_bale);
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
      door(); P(1, y + 2, 0, winB()); P(w - 2, y + 2, 0, winB());
      const cq = VGEN >= 3 ? d - 3 : d - 2;   // village generator 3: chest in front of the table, so its lid is clear; older worlds keep the 1.0 spot, where their saved chest contents are
      P(1, y + 1, d - 2, BF.furnaceId(out)); P(2, y + 1, d - 2, BF.furnaceId(out)); P(w - 2, y + 1, cq, BF.chestId(out)); P(w - 2, y + 1, 2 * d - 5 - cq, B.crafting_table);
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
      door(); P(du, y + 3, 0, winB());
      for (let q = 2; q < d - 1; q += 2) { P(0, y + 2, q, winB()); P(0, y + 3, q, winB()); P(w - 1, y + 2, q, winB()); P(w - 1, y + 3, q, winB()); }
      P(2, y + 1, d - 2, B.crafting_table);
      return;
    }
    case "library": {
      box(P, S, 0, 0, w, d, y, 5, S.wall, S.floor);
      windows(P, 0, 0, w, d, y + 2, false); windows(P, 0, 0, w, d, y + 3, false);
      if (flat) flatRoof(P, 0, 0, w, d, y + 6, S.roof, 0); else roof(P, S, 0, 0, w, d, y + 5, S.wall, S.roof);
      door();
      for (let u = 1; u < w - 1; u++) { P(u, y + 1, d - 2, u % 2 ? BF.chestId(out) : S.wall); P(u, y + 2, d - 2, S.wall); }   // shelves
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
      P(1, y + 2, 0, winB()); P(w - 2, y + 2, 0, winB()); P(side + 1, y + 2, d - 1, winB());
      P(side === 0 ? w - 2 : 1, y + 1, 2, B.crafting_table);
      return;
    }
    case "house2": {
      // two storeys: upper floor with a hatch in the middle of the back wall and a ladder up to it, log band between storeys
      const lu = w >> 1;                                   // ladder column: between the two beds, straight back from the door
      box(P, S, 0, 0, w, d, y, 7, S.wall, S.floor);
      for (let q = 1; q < d - 1; q++) for (let u = 1; u < w - 1; u++) if (!(u === lu && q === d - 2)) P(u, y + 4, q, S.floor);
      for (let q = 1; q < d - 1; q++) { P(0, y + 4, q, S.log); P(w - 1, y + 4, q, S.log); }
      windows(P, 0, 0, w, d, y + 2, true); windows(P, 0, 0, w, d, y + 6, false); P(1, y + 6, 0, winB()); P(w - 2, y + 6, 0, winB());
      P(lu, y + 2, d - 1, S.wall);                         // no window behind the ladder (ladders need a solid wall)
      for (let k = 1; k <= 5; k++) P(lu, y + k, d - 2, BF.ladderId(out));   // against the back wall, one rung above the upper floor to step off
      if (flat) flatRoof(P, 0, 0, w, d, y + 8, S.roof, 0); else roof(P, S, 0, 0, w, d, y + 7, S.wall, S.roof);
      door();
      P(1, y + 1, 1, B.crafting_table); P(1, y + 5, d - 2, BF.chestId(out));
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
      if (b.type === "big") { P(w - 2, y + 1, d - 2, BF.chestId(out)); P(w - 2, y + 1, 1, B.lantern); }
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

// What a tree-grid candidate grows (null for nothing), in the candidate's own frame: { kind, x, y, z, a, b }. Shared by chunk
// generation and treesIn (the planet's distant stand-ins, r14-07), so both agree. Kinds and their a, b: mangrove (height, ground y),
// cactus (extra height 0-2), ice_spike (height, radius), boulder, jungle (height, big), jungle_oak / oak / swamp_oak
// (height), oak_nest / birch_nest (height: bee-nest trees, js/bees.js), spruce (height), mega_spruce (height), acacia (height, branch
// bits), giant_mushroom (red), dark_oak (height), cherry (height).
const grassy = b => !(b === OCEAN || b === FROZEN_OCEAN || b === BEACH || b === SNOWY_BEACH || b === STONY_SHORE || b === DESERT || b === BADLANDS ||
  b === RIVER || b === PEAKS || b === STONY_PEAKS || b === SNOWY_SLOPES);
function treeOf(cd) {
  const { gx, gz, tx, tz, r, h, b } = cd, SEA = BF.SEA;
  const r2 = noise.hash(gx, gz, 104), r3 = noise.hash(gx, gz, 105);
  const T = (kind, y, a, bb) => ({ kind, x: tx, y, z: tz, a, b: bb });
  if (b === MANGROVE) return r < TREE_DENSITY[b] && h >= SEA - 3 ? T("mangrove", Math.max(h, SEA) + 1, 4 + ((r3 * 3) | 0), h + 1) : null;
  if (h <= cd.wl) return null;
  if (b === DESERT || b === BADLANDS) return r < (b === DESERT ? 0.14 : 0.03) ? T("cactus", h + 1, (r2 * 3) | 0) : null;
  if (b === ICE_SPIKES) {
    if (r >= 0.06) return null;
    const big = r2 < 0.12;
    return T("ice_spike", h + 1, big ? 22 + ((r3 * 10) | 0) : 6 + ((r3 * 8) | 0), big ? 2.6 : 1.3);
  }
  if (b === OLD_TAIGA && r >= 0.86 && r < 0.9 && !entranceAt(tx, tz)) return T("boulder", h + 1);
  if (r >= TREE_DENSITY[b] || !grassy(b)) return null;
  if (h <= SEA + 1 && b !== SWAMP) return null;                 // shore sand
  if (b === MOUNTAINS && h > 1800) return null;
  if (entranceAt(tx, tz)) return null;
  const ty = h + 1;
  switch (b) {
    case JUNGLE:
      if (r2 < 0.18) return T("jungle", ty, 18 + ((r3 * 9) | 0), true);
      if (r2 < 0.6) return T("jungle", ty, 9 + ((r3 * 6) | 0), false);
      return T("jungle_oak", ty, 4 + ((r3 * 2) | 0));
    case SPARSE_JUNGLE:
      if (r2 < 0.45) return T("jungle", ty, 7 + ((r3 * 4) | 0), false);
      if (r2 < 0.75) return T("jungle_oak", ty, 4 + ((r3 * 2) | 0));
      return T("oak", ty, 4 + ((r3 * 2) | 0));
    case TAIGA: case SNOWY_TAIGA: case SNOWY_PLAINS: case MOUNTAINS:
      return T("spruce", ty, 6 + ((r3 * 5) | 0));
    case OLD_TAIGA:
      return r2 < 0.45 ? T("mega_spruce", ty, 18 + ((r3 * 10) | 0)) : T("spruce", ty, 7 + ((r3 * 5) | 0));
    case SAVANNA: return T("acacia", ty, 5 + ((r2 * 2) | 0), (r3 * 8) | 0);
    case DARK_FOREST:
      if (r2 < 0.07) return T("giant_mushroom", ty, 0, r3 < 0.5);
      if (r2 < 0.85) return T("dark_oak", ty, 6 + ((r3 * 3) | 0));
      return T("oak", ty, 5);
    case CHERRY: return T("cherry", ty, 4 + ((r3 * 3) | 0));
    case MUSHROOM: return T("giant_mushroom", ty, 0, r2 < 0.5);
    case BIRCH: case MEADOW:
      return r2 < 0.85 || b === MEADOW ? T("birch_nest", ty, 5 + ((r3 * 3) | 0)) : T("oak_nest", ty, 4 + ((r3 * 3) | 0));
    case FOREST: case FLOWER_FOREST:
      return r2 < 0.3 ? T("birch_nest", ty, 5 + ((r3 * 3) | 0)) : T("oak_nest", ty, 4 + ((r3 * 3) | 0));
    default:
      if (b === PLAINS) return T("oak_nest", ty, 4 + ((r3 * 3) | 0));
      return T(b === SWAMP ? "swamp_oak" : "oak", ty, 4 + ((r3 * 3) | 0));
  }
}

// The trees (and other tree-grid features) of face f's 4 x 4 cells cu0 <= cu < cu1, cv0 <= cv < cv1 (face grid u / 4, v / 4), as treeOf
// gives them, at atlas positions (BF.planetgen.treesIn). Exactly the features chunk generation draws, without villages' clearings
// (r14-12 adds those).
function treesIn(f, cu0, cv0, cu1, cv1) {
  const Pl = BF.planet, X0 = (Pl.W * f + Pl.N) >> 2, Z0 = Pl.N >> 2, n = Pl.N >> 2, out = [];
  cu0 = Math.max(0, cu0); cv0 = Math.max(0, cv0); cu1 = Math.min(n, cu1); cv1 = Math.min(n, cv1);
  for (let gz = Z0 + cv0; gz < Z0 + cv1; gz++) for (let gx = X0 + cu0; gx < X0 + cu1; gx++) {
    const t = treeAt(gx, gz);
    if (t) out.push(t);
  }
  return out;
}
// The tree-grid feature of atlas cell (gx, gz) (cells are 4 x 4 blocks), as treesIn gives it, or null. With col ({ h, biome, wl }: a
// nearby column standing in for the tree's own), the column's climate isn't worked out: distant stand-ins far out (js/grid.js) use
// the sample they belong to (and with noVillages, villages' clearings aren't looked up either: far out, where stand-ins are a pixel).
function treeAt(gx, gz, col, noVillages) {
  const r = noise.hash(gx, gz, 101);
  if (r >= 0.92) return null;
  const tx = gx * 4 + ((noise.hash(gx, gz, 102) * 3) | 0), tz = gz * 4 + ((noise.hash(gx, gz, 103) * 3) | 0);
  if (!noVillages && villageAt(tx, tz, 3)) return null;
  if (col) return treeOf({ gx, gz, tx, tz, r, h: col.h, b: col.biome, wl: col.wl });
  const h = climate(tx, tz);
  return treeOf({ gx, gz, tx, tz, r, h, b: C.biome, wl: C.wl });
}

// Per-chunk data shared by the generation passes (filled by prep): column caches, villages and the tree-grid candidates.
const P = { cx: 0, cz: 0, ox: 0, oz: 0, maxH: 0, minH: 0, topY: 0, hc: 0, vils: [], cands: [], maps: [], ext: 0, vMin: 0, vMax: 0 };
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
  // villages touching this chunk (a chunk never straddles two regions)
  const pr = pRegion(ox, oz);   // (a chunk in a margin is past an edge, where villages never reach)
  const vils = P.vils = [pr && villageRegion(pr[0], pr[1])].filter(v => v &&
    v.maxX + 2 >= ox && v.minX - 2 < ox + CS && v.maxZ + 2 >= oz && v.minZ - 2 < oz + CS);
  // tree-grid candidates (4x4 cells, margin M around the chunk)
  const cands = P.cands = [];
  let ext = 0;
  const x0 = ox - M, x1 = ox + CS + M, z0 = oz - M, z1 = oz + CS + M;
  // a candidate (cell gx, gz of the grid it grows on, at tx, tz in that grid's frame; m: the map into this chunk's frame, or null)
  const add = (gx, gz, m, E) => {
    const r = noise.hash(gx, gz, 101);
    if (r >= 0.92) return;
    const tx = gx * 4 + ((noise.hash(gx, gz, 102) * 3) | 0), tz = gz * 4 + ((noise.hash(gx, gz, 103) * 3) | 0);
    if (m) { if (!inMap(E, mapX(m, tx, tz), mapZ(m, tx, tz))) return; }
    else if (tx < x0 || tx >= x1 || tz < z0 || tz >= z1) return;
    if (villageAt(tx, tz, 3)) return;
    if (!m && !ownCell(tx, tz)) return;   // (the neighbouring face's own cells come through its map)
    const h = climate(tx, tz), b = C.biome, wl = C.wl;
    cands.push({ gx, gz, tx, tz, r, h, b, wl, m });
    if ((r < TREE_DENSITY[b] || (b === DESERT && r < 0.14) || (b === BADLANDS && r < 0.03) || (b === ICE_SPIKES && r < 0.06) ||
        (b === OLD_TAIGA && r >= 0.86 && r < 0.9))) ext = Math.max(ext, h + TREE_EXT[b]);
  };
  for (let gz = Math.floor(z0 / 4); gz <= Math.floor((z1 - 1) / 4); gz++)
    for (let gx = Math.floor(x0 / 4); gx <= Math.floor((x1 - 1) / 4); gx++) add(gx, gz, null, null);
  P.maps = edgeMaps(BF.planet.face(ox, oz), x0 - 3, x1 + 3, z0 - 3, z1 + 3);   // (3: the jungle bushes' reach, see core)
  for (const E of P.maps) {
    const F0 = BF.planet.W * E.g + BF.planet.N, F1 = F0 + BF.planet.N, N0 = BF.planet.N, N1 = 2 * N0;   // the neighbour's own square
    const Ec = { a0: Math.max(E.a0, x0), a1: Math.min(E.a1, x1), b0: Math.max(E.b0, z0), b1: Math.min(E.b1, z1) };
    for (let gz = Math.floor(Math.max(E.gz0, N0) / 4); gz <= Math.floor((Math.min(E.gz1, N1) - 1) / 4); gz++)
      for (let gx = Math.floor(Math.max(E.gx0, F0) / 4); gx <= Math.floor((Math.min(E.gx1, F1) - 1) / 4); gx++) add(gx, gz, E.m, Ec);
  }
  // one drawing order whichever face's chunk draws them (overlapping crowns: the first one drawn keeps the block), by cell
  if (P.maps.length) cands.sort((p, q) => (p.gz - q.gz) * 4194304 + (p.gx - q.gx));
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
    g3A[gi] = C3(wx, wy, wz, 44, 22, 0, 0, 0);
    g3B[gi] = C3(wx, wy, wz, 44, 22, 57.3, 11.1, -33.7);
    g3C[gi] = C3(wx, wy, wz, 72, 36, -91.7, 0, 19.3);
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
  // salt, veins per bucket, size, kind, a, b, block, deepslate variant, depth curve (ORE_CURVE: veins per bucket are scaled by it)
  [201, 1.3, 30, "d", 8, 99999, "gravel"], [202, 0.25, 18, "d", 20, 300, "clay"], [203, 1.1, 22, "d", 6, 300, "dirt"],
  // coal, iron and copper: rare in surface rock (exposed rock above the chunk's surface too), most common about 100 down, gone by about 210
  [211, 11.0, 10, "d", -9999, 210, "coal_ore", "deepslate_coal_ore", "c"],
  [212, 8.0, 8, "d", -9999, 210, "iron_ore", "deepslate_iron_ore", "c"],
  [217, 6.5, 7, "d", -9999, 210, "copper_ore", "deepslate_copper_ore", "c"],
  // the rarer ores are placed by depth below the surface too, so every village's miner can reach them (js/miner.js DIG_DEPTH): an apprentice
  // reaches gold, a journeyman diamonds and redstone. They begin at the same depth wherever the land is and grow richer all the way down.
  [213, 3.3, 6, "d", 32, 99999, "gold_ore", "deepslate_gold_ore", "r"],
  [214, 2.4, 5, "d", 48, 99999, "diamond_ore", "deepslate_diamond_ore", "r"],
  [215, 1.0, 6, "d", 24, 99999, "lapis_ore", "deepslate_lapis_ore", "r"],
  [216, 3.5, 6, "d", 48, 99999, "redstone_ore", "deepslate_redstone_ore", "r"],
  [219, 0.03, 1, "d", 24, 99999, "emerald_ore", "deepslate_emerald_ore", "r"],
  [218, 1.1, 1, "d", 3, 500, "emerald_ore", "deepslate_emerald_ore", 0, "mtn"],
  [221, 1.6, 70, "d", 5, 99999, "granite"], [222, 1.6, 70, "d", 5, 99999, "diorite"], [223, 1.6, 70, "d", 5, 99999, "andesite"],
  [224, 1.0, 60, "y", -64, 16, "tuff", "tuff"], [225, 0.35, 40, "d", 30, 250, "dripstone_block"],
  [231, 0.4, 14, "d", 10, 99999, "water", "water"],               // water pockets at every height
  [232, 0.8, 12, "y", -64, -8, "magma_block", "magma_block"],     // there is no lava block: deep magma pockets
  [233, 0.15, 9, "d", 40, 99999, "magma_block", "magma_block"],
];
// Depth curves (d = blocks below the chunk's centre surface, negative above it), as a multiple of the row's veins per bucket.
//   "c": 0.1 in surface rock and above, rising smoothly to 1 at 100 down, falling smoothly to 0 at 200 (and nothing deeper).
//   "r": 1 where the band begins (a blocks down), rising towards 3; half of the gain comes within 210 blocks, so it changes quickly near the
//        top of the band and barely at all a kilometre down.
const ORE_CURVE = {
  c: { max: 1, at: (d) => d <= 0 ? 0.1 : d < 100 ? 0.1 + 0.9 * Math.sin(Math.PI / 2 * d / 100) ** 2 : d < 200 ? Math.cos(Math.PI / 2 * (d - 100) / 100) ** 2 : 0 },
  r: { max: 3, at: (d, a) => 3 - 2 * Math.exp(-Math.max(0, d - a) / 300) },
};
function ores3(vox, Y0, Y1, cx, cz) {
  const { CS, B } = BF, MINY = BF.MIN_Y, STONE = B.stone, DEEP = B.deepslate, hc = P.hc;
  const eb = bCache[((CS >> 1) + 1) * HW + (CS >> 1) + 1], mtn = eb === MOUNTAINS || eb === SNOWY_SLOPES || eb === PEAKS || eb === STONY_PEAKS;
  for (let q = 0; q < ORE3.length; q++) {
    const sp = ORE3[q], id = B[sp[6]];
    if (id === undefined || (sp[9] === "mtn" && !mtn)) continue;
    if (sp[0] === 219 && mtn) continue;
    // (gravel also runs through deepslate, as in Minecraft: a village near sea level digs its shaft in deepslate, and its miner
    // finds the gravel it sifts for the fletcher's flint there)
    const ds = sp[7] !== undefined ? B[sp[7]] : sp[6] === "gravel" ? id : undefined, size = sp[2];
    let lo, hi;
    if (sp[3] === "d") { lo = Math.max(MINY + 5, hc - sp[5]); hi = hc - sp[4]; } else { lo = sp[4]; hi = sp[5]; }
    const curve = sp[8] ? ORE_CURVE[sp[8]] : null;
    if (sp[8] === "c") hi = Math.min(hi, P.maxH); else if (hi > hc - 3) hi = hc - 3;   // common ores reach exposed rock above the surface
    const reach = Math.ceil(size * 1.2) + 1;
    const wLo = Math.max(lo, Y0 - reach), wHi = Math.min(hi, Y1 - 1 + reach);
    if (wHi < wLo) continue;
    for (let bk = wLo >> 5; bk <= wHi >> 5; bk++) {
      const bl = Math.max(lo, bk * 32), bh = Math.min(hi, bk * 32 + 31);
      if (bh < bl) continue;
      const len = bh - bl + 1;
      const cnt = sp[1] * len / 32 * (curve ? curve.max : 1);
      rs = (noise.hash3(cx, bk, cz, sp[0]) * 4294967296) >>> 0 || 1;
      let n = cnt | 0; if (rnd() < cnt - n) n++;
      for (let k = 0; k < n; k++) {
        let px = (rnd() * CS) | 0, pz = (rnd() * CS) | 0, py = bl + ((rnd() * len) | 0);
        const sz = size * (0.6 + rnd() * 0.6);
        if (curve && rnd() * curve.max >= curve.at(hc - py, sp[4])) continue;   // thinned to the curve at the vein's own depth
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

// The band of a column: the sections [lo, hi) that hold everything non-trivial (terrain surface, water, trees, plants, villages and
// ~3 sections of stone below the lowest ground); everything above is air, everything below is what generateRange produces.
function generateBand(cx, cz) {
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
  sy0 = Math.max(sy0, BF.SY0); sy1 = Math.min(sy1, BF.SY1);
  if (sy1 <= sy0) return new Uint16Array(0);
  prep(cx, cz);
  const vox = new Uint16Array((sy1 - sy0) * 4096);
  core(cx, cz, vox, sy0 * 16, (sy1 - sy0) * 16);
  return vox;
}

// Fills `vox` (zeroed, window-indexed: ((y - Y0) * 16 + z) * 16 + x) with absolute y in [Y0, Y0 + NY). Everything written outside the window is skipped.
function core(cx, cz, vox, Y0, NY) {
  const { CS, H, SEA, B } = BF;
  const ox = cx * CS, oz = cz * CS;
  const STONE = B.stone, WATER = B.water, AIR = 0;
  const step = CS * CS;
  const Y1 = Y0 + NY, MINY = BF.MIN_Y;
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
    const patch = N2(wx, wz, 13, 3.1, -7.3);

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
        const snowLine = (b === SNOWY_SLOPES ? 1450 : b === PEAKS ? 1800 : 1950) + N2(wx, wz, 23, 0, 0) * 30;
        const snowy = b !== STONY_PEAKS && h >= snowLine;
        if (snowy) {
          top = slope >= 4 ? STONE : B.snow; fill = slope >= 3 ? STONE : B.snow; depth = 1 + (r * 2 | 0);
          if (b === PEAKS && patch > 0.5 && slope < 3) top = B.packed_ice;
        } else if (b === STONY_PEAKS) top = fill = ((h + (patch * 3 | 0)) % 7 === 0) ? B.calcite : STONE;
        else if (slope >= 2 || h > 1850 + r * 30) { top = STONE; fill = STONE; }
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
    const strataY = h - 36 + r * 4;
    for (let y = yStart; y <= yEnd; y++, i += step) {
      let v;
      if (y === MINY) v = B.bedrock;
      else if (y - MINY <= 4 && noise.hash3(wx, y, wz, 9) < 0.85 - (y - MINY) * 0.17) v = B.bedrock;
      else if (y > h) v = (y === wl && ice) ? B.ice : WATER;
      else if (strata) {
        if (y > h - depth) v = y === h ? top : fill;
        else if (y > strataY) v = STRATA[(y + ((N2(wx, wz, 160, 0, 0) * 3) | 0) + 64) & 63];
        else v = stone3(wx, y, wz);
      }
      else if (y === h) v = top;
      else if (y > h - depth) v = fill;
      else if (y > h - depth - depth2) v = under;
      else v = stone3(wx, y, wz);
      vox[i] = v;
    }
  }

  const vils = P.vils;
  // structures (villages, trees, plants) cannot reach a window that lies far below the lowest ground of the chunk
  const skipTop = Y1 <= P.minH - 48;

  // ---- caves (coarse 3D noise grid, interpolated) ----
  caves3(vox, Y0, Y1, cx, cz);

  // ---- ores and pockets ----
  ores3(vox, Y0, Y1, cx, cz);

  // ---- villages ----
  if (!skipTop) for (const vil of vils) drawVillage(vil, ox, oz, vox, (x, z) => hCache[(z - oz + 1) * HW + x - ox + 1]);

  // ---- trees and large features ----
  const RENDER = BF.RENDER;
  let cm = null;   // the map of the feature being drawn (it is drawn in its own face's frame), or null
  const putLog = (x, y, z, id) => {
    if (cm) { const X = mapX(cm, x, z); z = mapZ(cm, x, z); x = X; }
    const lx = x - ox, lz = z - oz;
    if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y <= MINY || y >= H || y < Y0 || y >= Y1) return;
    const vi = ((y - Y0) * CS + lz) * CS + lx, cur = vox[vi];
    if (cur === AIR || cur === WATER || RENDER[cur] === 2 || RENDER[cur] === 4) vox[vi] = id;
  };
  const putLeaf = (x, y, z, id) => {
    if (cm) { const X = mapX(cm, x, z); z = mapZ(cm, x, z); x = X; }
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
  // Village generator 8 (js/bees.js): about 3% of the oak and birch trees of forests, birch forests, meadows and plains (biomes with flowers)
  // carry a bee nest on one side of the trunk, just under the leaves. Older worlds keep their trees as they were.
  function nestTree(tx, ty, tz, log, leaf, hgt, wide) {
    oakTree(tx, ty, tz, log, leaf, hgt, wide);
    if (VGEN < 8 || BF.B.bee_nest == null || noise.hash(tx, tz, 777) >= 0.03) return;
    const [dx, dz] = BF.DIRS[(noise.hash(tx, tz, 778) * 4) | 0];
    putLog(tx + dx, Math.max(ty + 1, ty + hgt - 4), tz + dz, BF.B.bee_nest);
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
      const lx = (cm ? mapX(cm, tx + dx, tz + dz) : tx + dx) - ox, lz = (cm ? mapZ(cm, tx + dx, tz + dz) : tz + dz) - oz, y = ty + dy;
      if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y < Y0 || y >= Y1) continue;
      vox[((y - Y0) * CS + lz) * CS + lx] = noise.hash3(tx + dx, y, tz + dz, 92) < 0.7 ? B.mossy_cobblestone : B.cobblestone;
    }
  }
  const inChunk = (x, z) => x >= ox && x < ox + CS && z >= oz && z < oz + CS;
  if (!skipTop) for (const cd of P.cands) {
    const t = treeOf(cd);
    if (!t) continue;
    cm = cd.m;
    const tx = t.x, ty = t.y, tz = t.z, a = t.a;
    switch (t.kind) {
      case "mangrove": mangrove(tx, ty, tz, a, t.b); break;
      case "cactus":
        if (!cm && inChunk(tx, tz)) {   // (a cactus stands on its own column: never in a neighbouring face's chunk)
          const h = ty - 1, top = h >= Y0 && h < Y1 ? vox[((h - Y0) * CS + tz - oz) * CS + tx - ox] : 0;
          if (top === B.sand || top === B.red_sand) for (let y = ty; y <= ty + a; y++) putLog(tx, y, tz, B.cactus);
        }
        break;
      case "ice_spike": iceSpike(tx, ty, tz, a, t.b); break;
      case "boulder": boulder(tx, ty, tz); break;
      case "jungle": jungleTree(tx, ty, tz, a, t.b); break;
      case "jungle_oak": oakTree(tx, ty, tz, B.jungle_log, B.jungle_leaves, a, false); break;
      case "oak": oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, a, false); break;
      case "swamp_oak": oakTree(tx, ty, tz, B.oak_log, B.oak_leaves, a, true); break;
      case "oak_nest": nestTree(tx, ty, tz, B.oak_log, B.oak_leaves, a, false); break;
      case "birch_nest": nestTree(tx, ty, tz, B.birch_log, B.birch_leaves, a, false); break;
      case "spruce": spruceTree(tx, ty, tz, a); break;
      case "mega_spruce": megaSpruce(tx, ty, tz, a); break;
      case "acacia": acacia(tx, ty, tz, a, t.b); break;
      case "giant_mushroom": giantMushroom(tx, ty, tz, t.b); break;
      case "dark_oak": darkOak(tx, ty, tz, a); break;
      case "cherry": cherry(tx, ty, tz, a); break;
    }
  }
  cm = null;
  // jungle undergrowth bushes on a 3-grid
  // (on the planet: this face's own cells, then the neighbouring faces' cells within reach, through their maps; at an edge all of them
  // are drawn in one order by cell, whichever face's chunk draws them)
  const bushes = [];
  const bush = (gx, gz, E) => {
    if (noise.hash(gx, gz, 121) >= 0.45) return;
    const tx = gx * 3 + ((noise.hash(gx, gz, 122) * 3) | 0), tz = gz * 3 + ((noise.hash(gx, gz, 123) * 3) | 0);
    if (E) { if (!inMap(E, mapX(E.m, tx, tz), mapZ(E.m, tx, tz))) return; }
    else if (tx < ox - 3 || tx >= ox + CS + 3 || tz < oz - 3 || tz >= oz + CS + 3 || !(ownCell(gx * 3, gz * 3) && ownCell(gx * 3 + 2, gz * 3 + 2))) return;   // (cells cut by an edge: none, on either side)
    const h = climate(tx, tz);
    if (C.biome !== JUNGLE || h <= SEA + 1 || entranceAt(tx, tz) || villageAt(tx, tz, 3)) return;
    if (P.maps.length) { bushes.push({ gx, gz, tx, h, tz, m: E ? E.m : null }); return; }
    drawBush(tx, h, tz, null);
  };
  const drawBush = (tx, h, tz, m) => {
    cm = m;
    putLog(tx, h + 1, tz, B.jungle_log);
    disc(tx, h + 1, tz, 2, B.jungle_leaves, 0.8); disc(tx, h + 2, tz, 1, B.jungle_leaves, 0.5);
    cm = null;
  };
  if (!skipTop) {
    for (let gz = Math.floor((oz - 3) / 3); gz <= Math.floor((oz + CS + 2) / 3); gz++)
      for (let gx = Math.floor((ox - 3) / 3); gx <= Math.floor((ox + CS + 2) / 3); gx++) bush(gx, gz, null);
    for (const E of P.maps) {
      const F0 = BF.planet.W * E.g + BF.planet.N, F1 = F0 + BF.planet.N, N0 = BF.planet.N, N1 = 2 * N0;
      const Eb = { m: E.m, a0: Math.max(E.a0, ox - 3), a1: Math.min(E.a1, ox + CS + 3), b0: Math.max(E.b0, oz - 3), b1: Math.min(E.b1, oz + CS + 3) };
      for (let gz = Math.floor(Math.max(E.gz0, N0) / 3); gz <= Math.floor((Math.min(E.gz1, N1) - 1) / 3); gz++)
        for (let gx = Math.floor(Math.max(E.gx0, F0) / 3); gx <= Math.floor((Math.min(E.gx1, F1) - 1) / 3); gx++) {
          if (gx * 3 < F0 || gx * 3 + 2 >= F1 || gz * 3 < N0 || gz * 3 + 2 >= N1) continue;   // (cells cut by the edge: the 3-grid doesn't divide N)
          bush(gx, gz, Eb);
        }
    }
    bushes.sort((p, q) => (p.gz - q.gz) * 4194304 + (p.gx - q.gx));
    for (const u of bushes) drawBush(u.tx, u.h, u.tz, u.m);
  }

  // ---- ground plants (per column, chunk-local) ----
  const FLOWERS = [B.poppy, B.dandelion, B.cornflower];
  const isGrass = id => id === B.grass || id === B.podzol || id === B.coarse_dirt || id === B.dirt;
  // pumpkin (kind 1, 40-block cells) and melon (kind 2, jungle only, 36-block cells) patch centres near this chunk
  fieldCache.clear();
  const patches = [];
  for (let kind = 1; kind <= 2; kind++) {
    const CELL = kind === 1 ? 40 : 36, salt = kind === 1 ? 631 : 641, pr = kind === 1 ? 0.2 : 0.34;
    // (on the planet: a cell cut by a face edge has no patch, and the neighbouring faces' patches within reach come through their maps)
    const cut = (gx, gz) => !(ownCell(gx * CELL, gz * CELL) && ownCell(gx * CELL + CELL - 1, gz * CELL + CELL - 1));
    const patch = (gx, gz, m) => {
      if (noise.hash(gx, gz, salt) >= pr) return;
      const R = 3.5 + noise.hash(gx, gz, salt + 3) * 2.5;
      let px = gx * CELL + noise.hash(gx, gz, salt + 1) * CELL, pz = gz * CELL + noise.hash(gx, gz, salt + 2) * CELL;
      if (m) { const qx = px - 0.5, qz = pz - 0.5; px = mapX(m, qx, qz) + 0.5; pz = mapZ(m, qx, qz) + 0.5; }   // (a point, not a block)
      patches.push(px, pz, R, kind, 0.1 + noise.hash(gx, gz, salt + 4) * 0.1);
    };
    for (let gz = Math.floor((oz - 8) / CELL); gz <= Math.floor((oz + CS + 7) / CELL); gz++)
      for (let gx = Math.floor((ox - 8) / CELL); gx <= Math.floor((ox + CS + 7) / CELL); gx++) if (!cut(gx, gz)) patch(gx, gz, null);
    for (const E of P.maps) {
      // the neighbour's cells whose centres can fall within 8 blocks of this chunk: its box, widened by a cell
      const X0 = Math.max(E.a0, ox - 8), X1 = Math.min(E.a1, ox + CS + 8), Z0 = Math.max(E.b0, oz - 8), Z1 = Math.min(E.b1, oz + CS + 8);
      if (X1 <= X0 || Z1 <= Z0) continue;
      const xs = [unmapX(E.m, X0, Z0), unmapX(E.m, X1 - 1, Z1 - 1)], zs = [unmapZ(E.m, X0, Z0), unmapZ(E.m, X1 - 1, Z1 - 1)];
      for (let gz = Math.floor(Math.min(zs[0], zs[1]) / CELL); gz <= Math.floor(Math.max(zs[0], zs[1]) / CELL); gz++)
        for (let gx = Math.floor(Math.min(xs[0], xs[1]) / CELL); gx <= Math.floor(Math.max(xs[0], xs[1]) / CELL); gx++) {
          if (BF.planet.face(gx * CELL, gz * CELL) !== E.g || cut(gx, gz)) continue;
          patch(gx, gz, E.m);
        }
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
        if (d2 < R * R && (patches[k + 3] === 2 ? b === JUNGLE || b === SPARSE_JUNGLE : b !== OCEAN && b !== FROZEN_OCEAN) &&
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
  REC = true;
  try { drawShell(b, (u, y, q, id) => { cells.set(u + "," + y + "," + q, [u, y, q, id]); }, styles()[style] || styles()[0], style); } finally { REC = false; }
  return [...cells.values()];
}
// Natural sand open to the sky within r (64) blocks of (x, z): desert, beach and river-bank sand above the water, from the climate (no chunks
// needed; a grid every 8 blocks). Villages of generator 7 with it start with a glassmaker (js/mobs.js villageRoster); builders want a glassworks
// (js/builder.js). Memoised per spot; keeps C (it runs during chunk generation, from js/jobs.js planVillage).
const sandCache = new Map();
function sandNear(x, z, r) {
  r = r || 64; x = Math.round(x); z = Math.round(z);
  const k = x + "," + z + "," + r;
  if (sandCache.has(k)) return sandCache.get(k);
  const c0 = Object.assign({}, C);
  let found = false;
  try {
    for (let dz = -r; dz <= r && !found; dz += 8) for (let dx = -r; dx <= r && !found; dx += 8) {
      if (dx * dx + dz * dz > r * r) continue;
      climate(x + dx, z + dz);
      const b = C.biome, dry = C.h >= C.wl;
      if (dry && (b === DESERT || b === BEACH || b === RIVER || (b === SNOWY_BEACH && C.h < BF.SEA + 1))) found = true;
    }
  } finally { Object.assign(C, c0); }
  if (sandCache.size > 4000) sandCache.clear();
  sandCache.set(k, found);
  return found;
}
// House and building rectangles of the planet's villages on face f inside the face grid area { u0, v0, u1, v1 }, without placing
// blocks (r14-12, for r14-07's house stand-ins): [{ x0, z0, x1, z1 (atlas), y (floor), h (height above it), type, village }], from the
// same cached layouts chunk generation draws. Each region in the area is sited once (siteOK's samples), so keep areas to what is needed.
const FOOT_H = { house: 7, house2: 7, lhouse: 8, big: 9, library: 9, church: 13, smith: 7, farm: 1, bigfarm: 1, pen: 2, hay: 3, garden: 2, coop: 4, pasture: 2, sty: 2, stable: 6 };
function villageFootprints(f, area) {
  const out = [];
  const r0 = Math.max(0, Math.floor(area.u0 / REGION)), r1 = Math.min(Math.ceil(PN / REGION) - 1, Math.floor(area.u1 / REGION));
  const q0 = Math.max(0, Math.floor(area.v0 / REGION)), q1 = Math.min(Math.ceil(PN / REGION) - 1, Math.floor(area.v1 / REGION));
  const ax0 = PW * f + PN + area.u0, ax1 = PW * f + PN + area.u1, az0 = PN + area.v0, az1 = PN + area.v1;
  for (let rz = q0; rz <= q1; rz++) for (let ru = r0; ru <= r1; ru++) {
    const v = villageRegion(f * RF + ru, rz);
    if (!v || v.maxX < ax0 || v.minX > ax1 || v.maxZ < az0 || v.minZ > az1) continue;
    for (const b of v.buildings) out.push({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, y: b.y, h: FOOT_H[b.type] || 5, type: b.type, village: v });
  }
  return out;
}
// Whether the atlas rectangle [x0, x1] x [z0, z1] lies on one face's grid, at least m blocks from every edge. Builders (js/builder.js) keep their sites to it, so nothing a village builds reaches past an edge.
function insideFace(x0, z0, x1, z1, m) {
  const f = Math.floor(x0 / PW), u0 = x0 - PW * f - PN, u1 = x1 - PW * f - PN, v0 = z0 - PN, v1 = z1 - PN;
  return f >= 0 && f < 6 && u0 >= m && v0 >= m && u1 < PN - m && v1 < PN - m;
}
const bedPlanOf = (kind, w, d, h) => bedPlan({ type: kind, w, d, du: w >> 1, h: h == null ? 0.5 : h });

BF.worldgen = {
  COWHERD_POP,
  BAKER_POP,
  paddockPlan, horseLand, nativeAnimals, KEEPER_OF, PADDOCK_ANIMALS,
  PIG_POP,
  setCoarse(v) { COARSE = !!v; },   // overview maps: approximate (cheap) plateau weights, see limWeights
  init(n, opts) {
    noise = n; VGEN = (opts && opts.villages) || 1; BF.setLimits(); SC = Math.max(1, (opts && opts.biomeScale) || 1);
    PG = BF.planetgen; PN = BF.planet.N; PW = BF.planet.W;
    // 3D noise and js/planetgen.js's continents (set by the planet's size); biome size (SC) scales its climate noise and the
    // biome-scale fields (spec r14-19)
    const S = PG.init(n, SC);
    N2 = S.N2; FB = S.FB; WARP = S.WARP; C3 = S.C3;
    const pkey = n.seed + ":" + SC;
    if (pkey !== PSEED) {   // (a network solved for this seed and biome size is kept)
      const c = PCACHE.get(pkey);
      if (c) PCACHE.delete(pkey);
      if (PRIV && PSEED !== null) { PCACHE.set(PSEED, { net: PRIV, tape: TAPE }); while (PCACHE.size > PCACHE_N) PCACHE.delete(PCACHE.keys().next().value); }
      PRIV = c ? c.net : null; TAPE = c ? c.tape : null; PSOLVE = null; PSEED = pkey; TMODE = 0;
    }
    C.lk = 0; BF.rivers.usePlanet(planetRivers);   // (the network: planetRivers(), solved the first time it is needed)
    LAT.clear(); CRAW.clear(); CLIM.clear(); CLIS.clear(); villageCache.clear(); horseCache.clear(); tintCache.clear(); sandCache.clear(); STRATA = null; },
  generateBand, generateRange, heightAt,
  _layoutVillage: (x, z, pop) => layoutVillage(x, z, pop),   // tools / tests: lay out a village of pop villagers at (x, z)
  _villagePop: (a, b, salt) => villagePop(a, b, salt),
  _fields(x, z) { fields(x, z); const R = relief3(x, z, false); return { cd: K.sp, cl: K.mp, mt: K.mt, c: K.c, pm: K.pm, p: K.p, e: K.e, t: K.t, hu: K.hu, S: R.S, m: R.m, rh: R.h, lo: K.lo }; },
  waterLevelAt(x, z) { climate(Math.floor(x), Math.floor(z)); return C.wl; },
  // distant terrain (js/grid.js, spec r14-05): a column's climate in one pass (h, wl, biome, tb, t, hu...; read it before the next call),
  // and the tree probability per 4x4 cell of each biome
  // (with tint, a Float32Array(9): also its grass, foliage and water tints, as tintAt)
  surfaceAt(x, z, tint) { climate(Math.floor(x), Math.floor(z)); if (tint) tintK(tint, 0); return C; },
  TREE_DENSITY,
  biomeAt, tintAt,
  villagesNear: (x, z, radius) => villagesNear(x, z, radius),   // the planet: across face edges, canonical records, planet distance
  nearestVillage: (x, z) => nearestVillage(x, z),
  villageAt: (x, z, m) => villageAt(Math.floor(x), Math.floor(z), m || 0),   // the village whose box holds column (x, z) (margin m), or null
  villageFootprints, insideFace, EDGE_KEEP,
  _planetRegion: (x, z) => pRegion(x, z), _planetRegionCentre: (rx, rz) => pRegionCentre(rx, rz),
  _villageRegion: (rx, rz) => villageRegion(rx, rz),   // the village of region (rx, rz) (see pRegion), or null
  padAt,
  sandNear,
  treesIn, treeAt,
  hash: (x, z, salt) => noise.hash(x, z, salt),   // the world's 2D hash (distant stand-ins pick and vary trees with it)
  solveRivers: pre => solveRivers(pre),   // the planet's river network, one slice per call: the fraction done (1: ready); pre: node samples (riverNodes) for the first call
  riversReady: () => !!PRIV,
  riverState, adoptRivers,   // a copy of the solved network for a worker (js/lodworker.js)
  tapeMiss: () => (TAPE ? TAPE.miss : null),
  riverNodes: (from, to, out) => BF.planetRivers.nodeSamples(noise.seed, riverSample, from, to, out),   // the network's terrain samples (js/riverworker.js)
  planetRivers: () => planetRivers(),
  bandAt: (x, z) => (climate(Math.floor(x), Math.floor(z)), C.tb),   // climate band of a column (0 coldest .. 4 hottest), after altitude
  NAMES,
  recordBuilding,
  bedPlan: bedPlanOf,
  palette: style => styles()[style | 0] || styles()[0],
  BTYPES,
};
})();
