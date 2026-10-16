// Generator 4, the planet (spec r14-08): Blockfield's generator-3 terrain on the cube-sphere. worldgen.js runs generator 3's own code
// for the planet (relief, plateaus and escarpments, massifs, badlands, swamps, mushroom islands, caves, ores, trees and plants); this
// file supplies what differs on a sphere:
//  - the noise sampler. Every 2D field of generator 3 keeps its wavelength, amplitude and offsets but is 3D noise at the column's
//    sea-level point on the sphere, R * dir(f, u, v); a domain warp is a 3D noise vector laid along the ground in the asking face's grid
//    frame; 3D fields (caves) are sampled at R + y along the column's direction. An atlas position in a face's margin reads the canonical
//    point, so every field runs on seamlessly across face edges. Generator 3's 4-block lattice and 320-block slope-limiter grid both
//    divide N, so the unfold maps lattice nodes onto lattice nodes.
//  - the continents: generator 3's continent field in 3D, turned per seed by one rotation (the best of up to 300) so that every cube
//    corner lies in open sea that is part of a real ocean; a corner still short of it gets a gulf out to the sea, and land fades out
//    near each corner (the round-planet prototype's method, GordonWallace/blockfield-round js/terrain.js). The climate isn't turned.
//  - the spawn search (until r14-19's spawn rules).
// The sampling path uses no window or document, so it also runs in a Web Worker (r14-05); it needs BF.state.gen = 4 for BF.planet.canon.
(() => {
"use strict";
const G = typeof window !== "undefined" ? window : self;   // self: the generator also runs in a Web Worker (r14-05)
const BF = (G.BF = G.BF || {});
const P = BF.planet;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const R = P.R;
let noise = null, nR = null, nC = null, seedv = 0;

// ---------- the point on the sphere of an atlas position ----------
// A small cache: generator 3 asks for the same few positions over and over (a column, its lattice nodes, a cave grid).
const CN = 64, CX = new Float64Array(CN).fill(NaN), CZ = new Float64Array(CN), CD = new Float64Array(CN * 3);
const cc = {}, dv = [0, 0, 0];
function pt(x, z) {
  const s = ((x * 7 + z * 13) | 0) & (CN - 1);
  if (CX[s] === x && CZ[s] === z) return s * 3;
  const c = P.canon(x, z, cc);
  if (c.off) { dv[0] = 1; dv[1] = 0; dv[2] = 0; }   // outside every face square (never asked for in practice)
  else P.dir(c.f, c.u, c.v, dv);
  CX[s] = x; CZ[s] = z;
  CD[s * 3] = dv[0]; CD[s * 3 + 1] = dv[1]; CD[s * 3 + 2] = dv[2];
  return s * 3;
}
// a third offset for the third axis, so fields that differ only by their 2D offsets stay independent
const third = (a, b) => 0.61 * a - 0.37 * b + 17.3;
function N2(x, z, L, a, b) {
  const i = pt(x, z), s = R / L;
  return noise.n3(CD[i] * s + a, CD[i + 1] * s + b, CD[i + 2] * s + third(a, b));
}
function FB(x, z, L, a, b, o) {
  const i = pt(x, z), s = R / L;
  return noise.fbm3(CD[i] * s + a, CD[i + 1] * s + b, CD[i + 2] * s + third(a, b), o);
}
// A warp: the point moved along the ground by 3D noise vectors (each term's component across the ground has the spread of one 2D warp
// field), as an atlas position in the asking position's own face frame. The moved point is a point on the sphere, so the warp is the
// same whichever face's frame asks (a lattice node on an edge line belongs to both faces), and the noise sampled there agrees.
const wq = [0, 0, 0], wg = {};
function warpTerm(i, L, A, a, b) {
  const s = R / L, X = CD[i] * s, Y = CD[i + 1] * s, Z = CD[i + 2] * s;
  const g0 = noise.n3(X + a, Y + b, Z + third(a, b)), g1 = noise.n3(X + b + 5.3, Y - a + 2.9, Z + a - 7.1), g2 = noise.n3(X - a + 1.9, Y + b - 3.7, Z - b + 9.4);
  const k = g0 * CD[i] + g1 * CD[i + 1] + g2 * CD[i + 2];   // along the ground: the vertical part taken out
  wq[0] += (g0 - k * CD[i]) * A; wq[1] += (g1 - k * CD[i + 1]) * A; wq[2] += (g2 - k * CD[i + 2]) * A;
}
function WARP(x, z, L, A, ax, az, bx, bz, L2, A2, ax2, az2, bx2, bz2, out) {
  const i = pt(x, z);
  wq[0] = CD[i] * R; wq[1] = CD[i + 1] * R; wq[2] = CD[i + 2] * R;
  warpTerm(i, L, A, ax + bx, az - bz); warpTerm(i, L2, A2, ax2 + bx2, az2 - bz2);
  // the moved point in the frame of the face square that (x, z) lies in
  const f0 = P.face(x, z), g = P.fromDir(wq[0], wq[1], wq[2], wg);
  if (f0 < 0 || g.f === f0) { const a = P.atlas(g.f, g.u, g.v, wg); out[0] = a.x; out[1] = a.z; return; }
  const e = P.UNFOLD[f0][g.f];
  if (!e) { const a = P.atlas(g.f, g.u, g.v, wg); out[0] = a.x; out[1] = a.z; return; }   // (only next to a corner: open sea)
  const U = e.A[0] * g.u + e.A[1] * g.v + e.t[0], V = e.A[2] * g.u + e.A[3] * g.v + e.t[1];
  out[0] = P.W * f0 + P.N + U; out[1] = P.N + V;
}
function C3(x, y, z, LH, LV, a, b, c) {
  const i = pt(x, z), s = R / LH + y / LV;
  return noise.n3(CD[i] * s + a, CD[i + 1] * s + b, CD[i + 2] * s + c);
}

// ---------- continents ----------
// Generator 3's continent field (worldgen.js contRaw3: wavelength 90,000, contrast 5, a slow warp of 0.12 wavelengths at 1.2 wavelengths,
// a weak rough octave, the same bias) in 3D: about 30 to 35% of the planet is land.
const LC = 90000, CK = 5.0, WL = LC * 1.2, WAMP = LC * 0.12, ROUGH = 0.15, BIAS = -0.875;
const SEA_C = -0.1;      // continentalness below this is open water (generator 3's coast runs from about -0.08 to 0)
let RM = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// continentalness at unit direction (x, y, z), before the corner rules
function contRaw(x, y, z) {
  const X = (RM[0] * x + RM[1] * y + RM[2] * z) * R, Y = (RM[3] * x + RM[4] * y + RM[5] * z) * R, Z = (RM[6] * x + RM[7] * y + RM[8] * z) * R;
  const wx = noise.n3(X / WL + 7.7, Y / WL - 3.1, Z / WL + 2.9) * WAMP;
  const wy = noise.n3(X / WL - 13.9, Y / WL + 21.3, Z / WL - 5.3) * WAMP;
  const wz = noise.n3(X / WL + 31.1, Y / WL + 4.4, Z / WL + 11.7) * WAMP;
  const cx = X + wx, cy = Y + wy, cz = Z + wz;
  const big = noise.fbm3(cx / LC - 517.1, cy / LC + 229.9, cz / LC + 61.3, 3);
  const rough = noise.n3(cx / (LC * 0.11) + 91.3, cy / (LC * 0.11) - 37.7, cz / (LC * 0.11) + 12.9) * ROUGH;
  return big * CK + rough + BIAS;
}
// distance (blocks along the ground) from unit direction (x, y, z) to the nearest cube corner
const cornerDist = (x, y, z) => Math.acos(Math.min(1, (Math.abs(x) + Math.abs(y) + Math.abs(z)) / Math.sqrt(3))) * R;

// Corners in the sea. Open sea: 40 km of unbroken sea along a straight line from the corner, too long for an inland lake.
const KS = [];   // per corner: unit direction c, its gulf's end g, the gulf's plane normal n and length a (as an angle); g null for none
for (let k = 0; k < 8; k++) { const l = Math.sqrt(3); KS.push({ c: [(k & 1 ? -1 : 1) / l, (k & 2 ? -1 : 1) / l, (k & 4 ? -1 : 1) / l], g: null, n: null, a: 0, reach: 0 }); }
const DIRS = 12, STEP = 2000, OPEN = 40000;
function ray(c, i, r) {   // direction at distance r from corner c, heading i of DIRS
  let ex = -c[1], ey = c[0]; const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
  const fx = -c[2] * ey, fy = c[2] * ex, fz = c[0] * ey - c[1] * ex;
  const t = r / R, cs = Math.cos(t), sn = Math.sin(t), a = i * 2 * Math.PI / DIRS, ca = Math.cos(a), sa = Math.sin(a);
  return [c[0] * cs + (ex * ca + fx * sa) * sn, c[1] * cs + (ey * ca + fy * sa) * sn, c[2] * cs + fz * sa * sn];
}
// distance (under limit) from corner c to where open sea starts along the best heading, and that heading
function reach(c, limit) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < DIRS; i++) {
    let run = 0;
    for (let r = 0; r < Math.min(best, limit) + OPEN; r += STEP) {
      const d = ray(c, i, r);
      if (contRaw(d[0], d[1], d[2]) < SEA_C) { run += STEP; if (run >= OPEN) { best = r - OPEN + STEP; bi = i; break; } }
      else { run = 0; if (r >= Math.min(best, limit)) break; }
    }
  }
  return [best, bi];
}
let cornerSea = 0, searchMs = 0;
function placeCorners(tries = 300) {   // (tries: tests force gulfs with fewer)
  const t0 = Date.now();
  RM = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let best = 80000, bestM = RM, order = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < tries && best > 0; i++) {
    // a uniformly random rotation (Shoemake's quaternion)
    const u1 = nR.hash(i, 1), u2 = nR.hash(i, 2) * 2 * Math.PI, u3 = nR.hash(i, 3) * 2 * Math.PI;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1), qx = a * Math.sin(u2), qy = a * Math.cos(u2), qz = b * Math.sin(u3), qw = b * Math.cos(u3);
    RM = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)];
    let worst = 0;
    for (let n = 0; n < 8 && worst < best; n++) {
      const d = reach(KS[order[n]].c, best)[0];
      if (d > worst) { worst = d; if (d >= best) order = [order[n], ...order.filter((o) => o !== order[n])]; }   // the hard corner first next time
    }
    if (worst < best) { best = worst; bestM = RM; }
  }
  RM = bestM;
  cornerSea = best;
  for (const K of KS) {
    K.g = null; K.n = null; K.a = 0;
    const [d, i] = reach(K.c, Infinity);
    K.reach = d; K.heading = i;
    if (!(d > 0) || d === Infinity) continue;
    K.g = ray(K.c, i, d + 3000);
    const n = [K.c[1] * K.g[2] - K.c[2] * K.g[1], K.c[2] * K.g[0] - K.c[0] * K.g[2], K.c[0] * K.g[1] - K.c[1] * K.g[0]], nl = Math.hypot(n[0], n[1], n[2]);
    K.n = n.map((v) => v / nl); K.a = (d + 3000) / R;
  }
  searchMs = Date.now() - t0;
}
// How far (blocks) direction (x, y, z), next to corner K, is from K's gulf (Infinity without one). The centre line wanders.
function gulf(K, x, y, z) {
  if (!K.g) return Infinity;
  const c = K.c, n = K.n, off = x * n[0] + y * n[1] + z * n[2];
  const t = [n[1] * c[2] - n[2] * c[1], n[2] * c[0] - n[0] * c[2], n[0] * c[1] - n[1] * c[0]];
  const along = Math.atan2(x * t[0] + y * t[1] + z * t[2], x * c[0] + y * c[1] + z * c[2]);
  const side = Math.abs(off * R + nC.n3(x * R / 9000, y * R / 9000, z * R / 9000) * 2500);
  if (along < 0) return Math.hypot(side, along * R);
  if (along > K.a) return Math.hypot(side, (along - K.a) * R);
  return side;
}
// Continentalness at unit direction (x, y, z) with the corner rules: land fades out from 4 km to 1.5 km of a corner, and a gulf 3 to 6 km
// wide runs from a corner that needs one out to the open sea. Both blend the field towards deep sea (generator 3's continentalness
// reaches 2 and more inland, so lowering it by a fixed amount would leave a high interior standing).
const DEEP = -0.6;
function contDir(x, y, z) {
  let c = contRaw(x, y, z);
  const cd = cornerDist(x, y, z);
  if (cd < 4000) c = Math.min(c, c + (DEEP - 0.4 - c) * smooth(4000, 1500, cd));
  if (cd < 90000) {
    const K = KS[(x < 0 ? 1 : 0) + (y < 0 ? 2 : 0) + (z < 0 ? 4 : 0)];
    if (K.g) {
      const g = gulf(K, x, y, z), w = 2200 + 1200 * nC.n3(x * R / 7000 + 50, y * R / 7000, z * R / 7000);
      if (g < w + 2000) c = Math.min(c, c + (DEEP - c) * smooth(w + 2000, w, g));
    }
  }
  return c;
}
// worldgen.js cont3 on the planet: continentalness at atlas position (x, z)
function cont(x, z) { const i = pt(x, z); return contDir(CD[i], CD[i + 1], CD[i + 2]); }
// within 8 km of a cube corner (no mushroom islands there: the corners stay open sea)
function nearCorner(x, z) { const i = pt(x, z); return cornerDist(CD[i], CD[i + 1], CD[i + 2]) < 8000; }

// Where a new world starts (until r14-19's spawn rules): a spiral search for dry land from latitude 35 N on face 4's middle meridian,
// far from every face edge and corner. The continent field picks candidates cheaply; the full height confirms one.
function spawnSearch() {
  const W = BF.worldgen, a = P.atlasOfLatLon(35, 0, {}), x0 = Math.floor(a.x), z0 = Math.floor(a.z);
  for (let r = 0; r < 60000; r += 32) {
    const t = r * 0.0137, x = x0 + Math.round(Math.cos(t) * r), z = z0 + Math.round(Math.sin(t) * r);
    if (cont(x, z) < 0.1) continue;
    if (W.heightAt(x, z) > BF.SEA + 1 && W.heightAt(x, z) >= W.waterLevelAt(x, z)) return [x, z];
  }
  return [x0, z0];
}

// Called by worldgen.init for generator 4 with the world's noise; returns the sampler worldgen's generator-3 code runs on.
function init(n) {
  noise = n; seedv = n.seed | 0;
  nR = BF.makeNoise(seedv ^ 0x2c1b3c6d); nC = BF.makeNoise(seedv + 7777);
  CX.fill(NaN);
  placeCorners();
  return { N2, FB, WARP, C3 };
}

BF.planetgen = {
  init, cont, contDir, contRaw, cornerDist, nearCorner, spawnSearch, SEA_C, ray, placeCorners,
  corners: () => KS.map(K => ({ c: K.c.slice(), gulf: !!K.g, reach: K.reach, heading: K.heading, n: K.n && K.n.slice() })),
  get cornerSea() { return cornerSea; }, get searchMs() { return searchMs; }, get rotation() { return RM.slice(); }, get seed() { return seedv; },
};
})();
