// The sandbox world's generator (spec idea-050): the planet (generator 4, atlas coordinates, round at altitude) with its ground replaced
// by an empty grass plain. Only the generator changes, so every 1.4+ system that assumes the planet keeps working.
// The plain: bedrock at BF.MIN_Y, stone up to TOP - 4, three blocks of dirt, grass at TOP. One biome (Plains), one grass tint; no
// villages, trees, plants, caves, ores, water or rivers (the river network is never solved: riversReady() is true at once).
// js/worldgen.js init(noise, {world: "flat"}) calls install(BF.worldgen): the terrain calls of BF.worldgen are swapped in place for the
// ones below (the same object, so code holding it sees the change); any other init calls uninstall() first, so normal worlds are untouched.
// spawn(): the centre of face 4 (about 80 km from every edge).
// API: BF.flatgen = { TOP, install(wg), uninstall(wg), on(), spawn() -> [x, z], plainAt(y) -> block id, drawTree... (worldgen's) }
(() => {
"use strict";
const G = globalThis;   // self: the generator also runs in Web Workers (meshing, distant terrain, the simulation)
const BF = (G.BF = G.BF || {});

const TOP = 4;            // the grass's y (BF.SEA = 0): a dry plain just above sea level
const PLAINS = 5, FACE = 4;
const TINT = { grass: [0.8, 0.98, 0.58], foliage: [0.72, 0.93, 0.51], water: [0.8, 0.97, 0.99] };

let saved = null;         // the planet's own calls while the flat ones are installed
// what surfaceAt returns (worldgen's climate record, js/worldgen.js C): read it before the next call
const C = { S: 0, h: TOP, t: 0.1, hu: -0.1, c: 0.5, e: 0, wd: 0, m: 0, rf: 0, sw: 0, bw: 0, mi: 0, biome: PLAINS, tb: 2, hb: 1, wl: 0, rv: 0, lk: 0 };

// the block at height y of every column
function plainAt(y) {
  const B = BF.B;
  if (y <= BF.MIN_Y) return B.bedrock;
  if (y > TOP) return 0;
  if (y === TOP) return B.grass;
  if (y > TOP - 4) return B.dirt;
  return B.stone;
}
// one column's ids for absolute y in [Y0, Y0 + NY), as worldgen's core fills a window ((y - Y0) * 16 + z) * 16 + x
function fill(vox, Y0, NY) {
  const n = 256;
  for (let y = Y0; y < Y0 + NY; y++) {
    const id = plainAt(y);
    if (id) vox.fill(id, (y - Y0) * n, (y - Y0 + 1) * n);
  }
}
function generateBand() {
  const lo = Math.max(BF.SY0, (TOP >> 4) - 3), hi = Math.min(BF.SY1, Math.max(lo + 1, ((TOP + 4) >> 4) + 1));
  const vox = new Uint16Array((hi - lo) * 4096);
  fill(vox, lo * 16, (hi - lo) * 16);
  return { lo, hi, vox };
}
function generateRange(cx, cz, sy0, sy1) {
  sy0 = Math.max(sy0, BF.SY0); sy1 = Math.min(sy1, BF.SY1);
  if (sy1 <= sy0) return new Uint16Array(0);
  const vox = new Uint16Array((sy1 - sy0) * 4096);
  fill(vox, sy0 * 16, (sy1 - sy0) * 16);
  return vox;
}
function surfaceAt(x, z, tint) {
  C.h = TOP; C.wl = BF.SEA; C.biome = PLAINS; C.tb = 2;
  if (tint) { const g = TINT.grass, f = TINT.foliage, w = TINT.water; tint[0] = g[0]; tint[1] = g[1]; tint[2] = g[2]; tint[3] = f[0]; tint[4] = f[1]; tint[5] = f[2]; tint[6] = w[0]; tint[7] = w[1]; tint[8] = w[2]; }
  return C;
}
const FLAT = {
  generateBand, generateRange,
  heightAt: () => TOP,
  surfaceAt,
  waterLevelAt: () => BF.SEA,
  biomeAt: () => ({ name: "Plains", id: PLAINS, height: TOP, temperature: C.t, humidity: C.hu }),
  tintAt: () => ({ grass: TINT.grass.slice(), foliage: TINT.foliage.slice(), water: TINT.water.slice() }),
  bandAt: () => 2,
  villagesNear: () => [], nearestVillage: () => null, villageAt: () => null, villageFootprints: () => [], padAt: () => null,
  sandNear: () => false,
  treesIn: () => [], treeAt: () => null,
  solveRivers: () => 1, riversReady: () => true, riverState: () => null, adoptRivers: () => true, tapeMiss: () => null,
  riverNodes: () => {}, planetRivers: () => null,
  _villageRegion: () => null,
};

function install(wg) {
  if (!saved) { saved = {}; for (const k in FLAT) saved[k] = wg[k]; }
  Object.assign(wg, FLAT);
  wg.world = "flat";
}
function uninstall(wg) {
  if (!saved) return;
  Object.assign(wg, saved);
  saved = null;
  wg.world = "planet";
}
// the spawn: the centre of face 4, far from every edge and corner
function spawn() { const P = BF.planet, h = P.N >> 1; return [P.W * FACE + P.N + h, P.N + h]; }

BF.flatgen = { TOP, PLAINS, install, uninstall, on: () => !!saved, spawn, plainAt };
})();
