// Seeded 2D/3D simplex noise, fbm, and integer hashing.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

BF.makeNoise = function makeNoise(seed) {
  const perm = new Uint8Array(512), perm12 = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0 || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; perm12[i] = perm[i] % 12; }
  const g3 = [1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  const F3 = 1 / 3, G3 = 1 / 6;

  // 2D simplex, range ~[-1, 1]
  function n2(x, y) {
    const t = (x + y) * F2, i = Math.floor(x + t), j = Math.floor(y + t);
    const t0 = (i + j) * G2, x0 = x - (i - t0), y0 = y - (j - t0);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, a, g;
    a = 0.5 - x0*x0 - y0*y0; if (a > 0) { g = perm12[ii + perm[jj]] * 3; a *= a; n += a * a * (g3[g]*x0 + g3[g+1]*y0); }
    a = 0.5 - x1*x1 - y1*y1; if (a > 0) { g = perm12[ii + i1 + perm[jj + j1]] * 3; a *= a; n += a * a * (g3[g]*x1 + g3[g+1]*y1); }
    a = 0.5 - x2*x2 - y2*y2; if (a > 0) { g = perm12[ii + 1 + perm[jj + 1]] * 3; a *= a; n += a * a * (g3[g]*x2 + g3[g+1]*y2); }
    return 70 * n;
  }

  // 3D simplex, range ~[-1, 1]
  function n3(x, y, z) {
    const s_ = (x + y + z) * F3;
    const i = Math.floor(x + s_), j = Math.floor(y + s_), k = Math.floor(z + s_);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; }
      else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; }
      else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; }
    } else {
      if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; }
      else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; }
      else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2*G3, y2 = y0 - j2 + 2*G3, z2 = z0 - k2 + 2*G3;
    const x3 = x0 - 1 + 3*G3, y3 = y0 - 1 + 3*G3, z3 = z0 - 1 + 3*G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, a, g;
    a = 0.6 - x0*x0 - y0*y0 - z0*z0; if (a > 0) { g = perm12[ii + perm[jj + perm[kk]]] * 3; a *= a; n += a*a*(g3[g]*x0 + g3[g+1]*y0 + g3[g+2]*z0); }
    a = 0.6 - x1*x1 - y1*y1 - z1*z1; if (a > 0) { g = perm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; a *= a; n += a*a*(g3[g]*x1 + g3[g+1]*y1 + g3[g+2]*z1); }
    a = 0.6 - x2*x2 - y2*y2 - z2*z2; if (a > 0) { g = perm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; a *= a; n += a*a*(g3[g]*x2 + g3[g+1]*y2 + g3[g+2]*z2); }
    a = 0.6 - x3*x3 - y3*y3 - z3*z3; if (a > 0) { g = perm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; a *= a; n += a*a*(g3[g]*x3 + g3[g+1]*y3 + g3[g+2]*z3); }
    return 32 * n;
  }

  function fbm(x, y, oct) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += a * n2(x * f, y * f); norm += a; a *= 0.5; f *= 2; }
    return sum / norm;
  }
  function fbm3(x, y, z, oct) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += a * n3(x * f, y * f, z * f); norm += a; a *= 0.5; f *= 2; }
    return sum / norm;
  }
  // Deterministic hash of integer coords (+ optional salt) -> [0, 1)
  function hash(x, z, salt) {
    let h = (x * 374761393 + z * 668265263 + (salt | 0) * 1442695041 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function hash3(x, y, z, salt) { return hash(x + y * 7919, z - y * 104729, salt); }
  return { n2, n3, fbm, fbm3, hash, hash3, seed };
};
})();
