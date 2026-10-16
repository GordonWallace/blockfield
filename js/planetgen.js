// Generator 4, the planet: terrain on the cube-sphere (spec r14-02). This first version is the round-planet prototype's terrain and
// climate (GordonWallace/blockfield-round js/terrain.js and js/climate.js) as a stand-in, so the game runs on the planet until r14-08
// brings Blockfield's own terrain onto the sphere: no caves, ores, trees, plants, rivers or villages yet.
//
// Every value is a function of the column's direction from the planet's centre, sampled with 3D noise, so continents, coasts and
// climate run on seamlessly across face edges. Heights are rescaled to Blockfield's sea level 0, with the land's relief doubled so it
// isn't flat under the mile-high limits (the climate still reads the prototype's heights). The 8 cube corners are always open ocean
// (land fades out between 4 and 1.5 km from a corner). Chunk and column coordinates are atlas coordinates (js/planet.js); a margin
// address reads the canonical column. worldgen.js hands every call over here when the world's generator is 4.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const P = BF.planet;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// biome ids are Blockfield's (worldgen.js); the prototype's Frozen Ocean (29) shows as an ocean here until r14-09 adds it
const OCEAN = 0, BEACH = 1, SNOWY_BEACH = 2, PLAINS = 5, FOREST = 6, FLOWER_FOREST = 7, BIRCH = 8, DARK_FOREST = 9, SWAMP = 10,
  MANGROVE = 11, DESERT = 12, BADLANDS = 13, SAVANNA = 14, SPARSE_JUNGLE = 15, JUNGLE = 16, TAIGA = 17, OLD_TAIGA = 18,
  SNOWY_PLAINS = 19, ICE_SPIKES = 20, SNOWY_TAIGA = 21, MEADOW = 22, CHERRY = 23, MOUNTAINS = 24, SNOWY_SLOPES = 25,
  STONY_PEAKS = 27, FROZEN_OCEAN = 29;
const NAMES = ["Ocean", "Beach", "Snowy Beach", "Stony Shore", "River", "Plains", "Forest", "Flower Forest",
  "Birch Forest", "Dark Forest", "Swamp", "Mangrove Swamp", "Desert", "Badlands", "Savanna", "Sparse Jungle",
  "Jungle", "Taiga", "Old Growth Taiga", "Snowy Plains", "Ice Spikes", "Snowy Taiga", "Meadow",
  "Cherry Grove", "Windswept Hills", "Snowy Slopes", "Jagged Peaks", "Stony Peaks", "Mushroom Fields", "Frozen Ocean"];
const BANDS = ["arctic", "subarctic", "temperate", "subtropical", "tropical"];
// Band edges in effective latitude (degrees): arctic above 66, subarctic 55-66, temperate 35-55, subtropical 23-35, tropical below 23.
const EDGES = [66, 55, 35, 23];
// Rainfall by latitude (degrees): Earth's zonal pattern.
const RAIN_LAT = [[0, 0.88], [8, 0.78], [15, 0.45], [22, 0.14], [29, 0.22], [38, 0.48], [48, 0.62], [58, 0.58], [68, 0.42], [80, 0.25], [90, 0.2]];
function rainLat(a) {
  for (let k = 1; k < RAIN_LAT.length; k++) if (a <= RAIN_LAT[k][0]) {
    const [a0, r0] = RAIN_LAT[k - 1], [a1, r1] = RAIN_LAT[k], s = (a - a0) / (a1 - a0);
    return r0 + (r1 - r0) * s * s * (3 - 2 * s);
  }
  return 0.2;
}

const LAND = 0.1;    // continent noise threshold: about a third of the surface is land
let nA, nB, nC, nK, seedv = 0;
const R = P.R, SC = R / 10430, CONT = SC * 9000, WP = SC * 5000, WA = SC * 2600, MSK = SC * 6000, RG = 1600 * Math.sqrt(SC);

// The surface at unit direction (x, y, z) in prototype units (hp: height above sea level as the prototype made it).
const S = { hp: 0, h: 0, land: 0, lat: 0, elat: 0, band: 0, rain: 0, temp: 0, biome: 0, ice: false };
function sample(x, y, z) {
  const X = x * R, Y = y * R, Z = z * R;
  const wx = nB.fbm3(X / WP, Y / WP, Z / WP, 3) * WA;
  const wy = nB.fbm3(X / WP + 31.7, Y / WP, Z / WP, 3) * WA;
  const wz = nB.fbm3(X / WP + 57.3, Y / WP, Z / WP, 3) * WA;
  const c = nA.fbm3((X + wx) / CONT, (Y + wy) / CONT, (Z + wz) / CONT, 9);
  const corner = Math.acos(Math.min(1, (Math.abs(x) + Math.abs(y) + Math.abs(z)) / Math.sqrt(3))) * R;
  const land = c - LAND - 1.2 * smooth(4000, 1500, corner);
  let hp;
  if (land < 0) hp = -3 - 55 * smooth(0, 0.12, -land) + nC.n3(X / 60, Y / 60, Z / 60) * 3;
  else {
    const inland = smooth(0, 0.12, land);
    const hills = nC.fbm3(X / 400, Y / 400, Z / 400, 3) * 22 * inland;
    const ridge = 1 - Math.abs(nA.fbm3(X / RG + 100, Y / RG, Z / RG, 5));
    const mask = smooth(0, 0.3, nB.fbm3(X / MSK + 200, Y / MSK, Z / MSK, 3)) * smooth(0.03, 0.2, land);
    hp = 1 + 60 * smooth(0, 0.3, land) + hills + ridge * ridge * ridge * mask * 150;
  }
  hp = Math.floor(hp);
  S.hp = hp; S.land = land;
  // Blockfield's heights: sea level 0, the land's relief above the shore doubled, the sea floor above bedrock
  S.h = Math.max(BF.MIN_Y + 6, hp <= 1 ? hp : 1 + (hp - 1) * 2);
  climate(X, Y, Z, y, hp, land);
  return S;
}

// Climate and biome (the prototype's climate.js): five bands from the equator to the poles by "effective latitude" (latitude wandered
// by slow noise and raised by altitude), rainfall by latitude plus noise and a drier continental interior; the biome is picked within
// the band by rainfall and altitude, with no strict band-to-biome rule.
function climate(X, Y, Z, y, hp, land) {
  const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI, alat = Math.abs(lat);
  const wander = nK.fbm3(X / 60000, Y / 60000, Z / 60000, 3) * 11 + nK.fbm3(X / 9000 + 40, Y / 9000, Z / 9000, 2) * 3;
  const alt = Math.max(0, hp);
  const elat = Math.max(0, alat + wander + 22 * smooth(20, 220, alt));
  let band = 4;
  for (let k = 0; k < 4; k++) if (elat >= EDGES[k]) { band = k; break; }
  const dj = (nK.hash(Math.floor(X), Math.floor(Z), 77) - 0.5) * 0.03;
  const rain = Math.max(0, Math.min(1, rainLat(alat + wander * 0.5) + nK.fbm3(X / 25000 + 90, Y / 25000, Z / 25000, 3) * 0.35
    - 0.22 * smooth(0.12, 0.45, land) + dj));
  let b;
  if (hp < -1) b = band === 0 ? FROZEN_OCEAN : OCEAN;
  else if (hp <= 1 && land < 0.025) b = band === 0 ? SNOWY_BEACH : BEACH;
  else if (alt > 150) b = band <= 2 ? SNOWY_SLOPES : STONY_PEAKS;
  else if (alt > 105 && band <= 1) b = SNOWY_SLOPES;
  else if (alt > 105) b = MOUNTAINS;
  else if (band === 4) b = rain < 0.22 ? DESERT : rain < 0.4 ? SAVANNA : rain < 0.6 ? SPARSE_JUNGLE : alt < 6 && land < 0.08 ? MANGROVE : JUNGLE;
  else if (band === 3) b = rain < 0.25 ? (alt > 35 ? BADLANDS : DESERT) : rain < 0.42 ? SAVANNA : rain < 0.6 ? PLAINS :
    rain < 0.78 ? (nK.fbm3(X / 7000, Y / 7000, Z / 7000 + 33, 2) > 0.3 ? CHERRY : FOREST) : alt < 12 ? SWAMP : SPARSE_JUNGLE;
  else if (band === 2) b = rain < 0.3 ? PLAINS : rain < 0.45 ? (alt > 40 ? MEADOW : PLAINS) :
    rain < 0.62 ? (nK.fbm3(X / 6000 + 7, Y / 6000, Z / 6000, 2) > 0.25 ? FLOWER_FOREST : FOREST) : rain < 0.8 ? BIRCH : alt < 10 ? SWAMP : DARK_FOREST;
  else if (band === 1) b = rain < 0.25 ? SNOWY_PLAINS : elat > 61 ? SNOWY_TAIGA : rain > 0.7 ? OLD_TAIGA : TAIGA;
  else b = elat > 80 ? ICE_SPIKES : elat < 70 && rain > 0.55 ? SNOWY_TAIGA : SNOWY_PLAINS;
  S.lat = lat; S.elat = elat; S.band = band; S.rain = rain; S.temp = 1 - elat / 90; S.biome = b;
  S.ice = band === 0 || elat > 62;
}

// Ground blocks of a biome: [top, under the top]
function ground(b, hp, X, Y, Z, out) {
  const B = BF.B;
  if (hp < -1) { out[0] = out[1] = hp < -20 ? B.gravel : B.sand; return; }
  switch (b) {
    case BEACH: out[0] = out[1] = B.sand; return;
    case SNOWY_BEACH: out[0] = B.snow; out[1] = B.sand; return;
    case DESERT: out[0] = B.sand; out[1] = B.sandstone; return;
    case BADLANDS: out[0] = B.red_sand; out[1] = B.terracotta; return;
    case ICE_SPIKES: out[0] = B.snow; out[1] = B.ice; return;
    case SNOWY_PLAINS: case SNOWY_TAIGA: out[0] = B.snow_grass; out[1] = B.dirt; return;
    case SNOWY_SLOPES: out[0] = B.snow; out[1] = B.stone; return;
    case STONY_PEAKS: out[0] = out[1] = B.stone; return;
    case MOUNTAINS: if (nC.n3(X / 23, Y / 23, Z / 23) > 0.25) { out[0] = out[1] = B.stone; return; } break;
  }
  out[0] = B.grass; out[1] = B.dirt;
}

// ---------- columns, per chunk ----------
// The columns of a chunk, computed once and kept (a few hundred chunks): ground height, water level (SEA, or NOWATER on land), top and
// under-top blocks, biome, ice, temperature / rain for tints.
const NOWATER = -32768, CS = 16;
const cache = new Map(), CACHE_MAX = 1024;
const d3 = [0, 0, 0], cc = {}, gb = [0, 0];
function chunkData(cx, cz) {
  const key = cx + "," + cz;
  let D = cache.get(key);
  if (D) return D;
  D = { h: new Int16Array(256), wl: new Int16Array(256), top: new Uint16Array(256), sub: new Uint16Array(256), biome: new Uint8Array(256),
    ice: new Uint8Array(256), temp: new Float32Array(256), rain: new Float32Array(256), minH: 1e9, maxTop: -1e9 };
  const SEA = BF.SEA;
  for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
    const i = lz * CS + lx;
    const c = P.canon(cx * CS + lx + 0.5, cz * CS + lz + 0.5, cc);
    if (c.off) { D.h[i] = BF.MIN_Y + 6; D.wl[i] = SEA; D.top[i] = D.sub[i] = BF.B.gravel; D.biome[i] = OCEAN; continue; }
    P.dir(c.f, c.u, c.v, d3);
    const s = sample(d3[0], d3[1], d3[2]);
    ground(s.biome, s.hp, d3[0] * R, d3[1] * R, d3[2] * R, gb);
    D.h[i] = s.h; D.wl[i] = s.h < SEA ? SEA : NOWATER; D.top[i] = gb[0]; D.sub[i] = gb[1];
    D.biome[i] = s.biome; D.ice[i] = s.ice ? 1 : 0; D.temp[i] = s.temp; D.rain[i] = s.rain;
    if (s.h < D.minH) D.minH = s.h;
    const t = Math.max(s.h, D.wl[i]);
    if (t > D.maxTop) D.maxTop = t;
  }
  cache.set(key, D);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return D;
}
// The column data of world column (x, z) (margin addresses read the canonical column): [D, index].
const cell = {};
function columnAt(x, z) {
  x = Math.floor(x); z = Math.floor(z);
  const c = P.canonCell(x, z, cell);
  const X = c.off ? x : c.x, Z = c.off ? z : c.z, cx = Math.floor(X / CS), cz = Math.floor(Z / CS);
  colOut[0] = chunkData(cx, cz); colOut[1] = (Z - cz * CS) * CS + (X - cx * CS);
  return colOut;
}
const colOut = [null, 0];

// Fills the window of vox (zeroed, index ((y - Y0) * 16 + z) * 16 + x) for absolute y in [Y0, Y0 + NY) of chunk (cx, cz).
function fill(cx, cz, vox, Y0, NY) {
  const B = BF.B, D = chunkData(cx, cz), MIN_Y = BF.MIN_Y, Y1 = Y0 + NY;
  for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
    const i = lz * CS + lx, h = D.h[i], wl = D.wl[i], top = D.top[i], sub = D.sub[i], ice = D.ice[i];
    const ya = Math.max(Y0, MIN_Y), yb = Math.min(Y1 - 1, Math.max(h, wl));
    for (let y = ya; y <= yb; y++) {
      let b;
      if (y === MIN_Y) b = B.bedrock;
      else if (y < h - 3) b = B.stone;
      else if (y < h) b = sub;
      else if (y === h) b = top;
      else b = y === wl && ice ? B.ice : B.water;
      vox[((y - Y0) * CS + lz) * CS + lx] = b;
    }
  }
}

// ---------- the worldgen API (docs/MILE_HIGH_CONTRACT.md) ----------
function generateBand(cx, cz) {
  const D = chunkData(cx, cz);
  const lo = Math.max(BF.SY0, (D.minH >> 4) - 3), hi = Math.min(BF.SY1, Math.max(lo + 1, (D.maxTop >> 4) + 1));
  const vox = new Uint16Array((hi - lo) * 4096);
  fill(cx, cz, vox, lo * 16, (hi - lo) * 16);
  return { lo, hi, vox };
}
function generateRange(cx, cz, sy0, sy1) {
  sy0 = Math.max(sy0, BF.SY0); sy1 = Math.min(sy1, BF.SY1);
  if (sy1 <= sy0) return new Uint16Array(0);
  const vox = new Uint16Array((sy1 - sy0) * 4096);
  fill(cx, cz, vox, sy0 * 16, (sy1 - sy0) * 16);
  return vox;
}
function generate(cx, cz, vox) { fill(cx, cz, vox, 0, 192); }
function heightAt(x, z) { const [D, i] = columnAt(x, z); return D.h[i]; }
function waterLevelAt(x, z) { const [D, i] = columnAt(x, z); return D.wl[i] === NOWATER ? BF.SEA : D.wl[i]; }
function biomeAt(x, z) {
  const [D, i] = columnAt(x, z), id = D.biome[i];
  const t = D.temp[i] * 2 - 1, hu = D.rain[i] * 2 - 1;
  return { name: NAMES[id], id: id === FROZEN_OCEAN ? OCEAN : id, height: D.h[i], temperature: +t.toFixed(2), humidity: +hu.toFixed(2) };
}
// Grass / foliage / water multipliers from temperature and rain (the same colour model as worldgen.js tintCompute).
function tintAt(x, z) {
  const [D, i] = columnAt(x, z);
  const t = (D.temp[i] - 0.6) * 2.2, hu = (D.rain[i] - 0.45) * 1.6;
  const hot = smooth(-0.35, 0.45, t), wet = smooth(-0.35, 0.45, hu), cold = 1 - smooth(-0.42, -0.12, t);
  let gr = 0.78, gg = 1.0, gbl = 0.62;
  const dry = hot * (1 - wet), jung = hot * wet;
  gr += dry * 0.32 - jung * 0.18 - cold * 0.12; gg += -dry * 0.1 + jung * 0.12 - cold * 0.08; gbl += -dry * 0.22 - jung * 0.14 + cold * 0.22;
  const sw = D.biome[i] === SWAMP || D.biome[i] === MANGROVE ? 1 : 0;
  gr = lerp(gr, 0.62, sw); gg = lerp(gg, 0.72, sw); gbl = lerp(gbl, 0.4, sw);
  let wr = 0.85, wg = 0.95, wb = 1.0;
  const warm = smooth(0.1, 0.45, t);
  wr += -warm * 0.25 - cold * 0.2; wg += warm * 0.2 - cold * 0.12; wb += -warm * 0.05 + cold * 0.05;
  return { grass: [gr, gg, gbl], foliage: [gr * 0.9, gg * 0.95, gbl * 0.88], water: [wr, wg, wb] };
}
// Natural sand open to the sky near (x, z) (glassmakers; no villages on the planet yet)
function sandNear() { return false; }

// Where a new world starts (until r14-19's spawn rules): a spiral search for dry land from latitude 35 N on face 4's middle meridian,
// far from every face edge and corner.
function spawnSearch() {
  const a = P.atlasOfLatLon(35, 0, {}), x0 = Math.floor(a.x), z0 = Math.floor(a.z);
  for (let r = 0; r < 60000; r += 32) {
    const t = r * 0.0137, x = x0 + Math.round(Math.cos(t) * r), z = z0 + Math.round(Math.sin(t) * r);
    if (heightAt(x, z) > BF.SEA + 1) return [x, z];
  }
  return [x0, z0];
}

function init(seed) {
  seedv = seed | 0;
  nA = BF.makeNoise(seed); nB = BF.makeNoise(seed ^ 0x5bd1e995); nC = BF.makeNoise(seed + 7777); nK = BF.makeNoise(seed ^ 0x1b873593);
  cache.clear();
}

BF.planetgen = { init, generateBand, generateRange, generate, heightAt, waterLevelAt, biomeAt, tintAt, sandNear, spawnSearch, sample,
  NAMES, BANDS, columnAt, get seed() { return seedv; } };
})();
