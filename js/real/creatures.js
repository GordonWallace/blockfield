// Blockfield 1.6, the realistic look: js/real/creatures.js. Drawing only. Nothing here may run unless BF.real.on.
//
// Smooth models for the farm animals (pig, cow, sheep, chicken, horse) in place of js/mobview.js's boxes. Only the shapes and their
// painted colours change: a model is still a list of parts with the same names, pivots and animation flags as the box model
// (body, head, legFL .. legBR, wingL / wingR, tail, saddle), so js/mobview.js animates, lights, tints and scales it exactly as before,
// and js/real/mobs.js lights it. Its one hook is in js/mobview.js typeParts: with the look on, parts(type, variant) is asked first and
// the boxes are used when it returns null (every other mob, and an animal whose style is "boxes").
//
// Two styles are built for every animal while the look is being chosen:
//   "a" soft:    the box model's proportions and colours, rounded into smooth volumes.
//   "b" natural: the build and markings of a real breed (Old Spot pig, Hereford cow, Suffolk sheep, red hen, a horse with joints, mane and tail).
// Which is drawn: BF.real.creatures.pick[type] ("a", "b" or null = boxes). ?creatures=a | b | boxes sets all of them, ?creatures=pig:a,cow:b
// some; without the parameter the DEFAULT table below is used.
//
// Models are authored in the box models' units (1/16 block, the animal faces +z, feet at y = 0, x to its left) from two primitives:
// loft (a tube through a list of elliptical rings, smoothed, with rounded ends) and ball. Colours are painted per vertex.
// API: BF.real.creatures = { parts(type, variant) -> [{name, pivot, geo, ...flags}] | null, pick, TYPES, build(type, variant, style) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;

const PX = 1 / 16;
const DEFAULT = { pig: null, cow: null, sheep: null, chicken: null, horse: null };   // until the looks are approved: the boxes

// ---------- small maths ----------
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
const sm = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
const ramp = (v, a, b) => clamp01((v - a) / (b - a));
const C = h => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
const mix = (a, b, t) => { t = clamp01(t); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
function h3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h3(xi, yi, zi), h3(xi + 1, yi, zi), fx), l(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), fx), fy),
           l(l(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), fx), l(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}
const fbm = (x, y, z) => vnoise(x, y, z) * 0.6 + vnoise(x * 2.1 + 7, y * 2.1 + 3, z * 2.1 + 5) * 0.28 + vnoise(x * 4.3 + 1, y * 4.3 + 9, z * 4.3 + 2) * 0.12;
// distance to the nearest of a jittered grid of points (0 at a point .. about 1): the lumps of a fleece
function cells(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const X = xi + a, Y = yi + b, Z = zi + c;
    const dx = X + h3(X, Y, Z) - x, dy = Y + h3(X + 31, Y, Z) - y, dz = Z + h3(X, Y + 57, Z) - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ---------- geometry ----------
// A part's geometry under construction: positions in model pixels, colours as painted (sRGB), triangles by index.
function Geo() { return { pos: [], col: [], idx: [] }; }
const P = { x: 0, y: 0, z: 0, u: 0, v: 0, up: 0, d: 0 };   // what a painter is told about a vertex
function vert(g, x, y, z, paint) {
  P.x = x; P.y = y; P.z = z;
  const c = typeof paint === "function" ? paint(P) : paint;
  g.pos.push(x, y, z); g.col.push(c[0], c[1], c[2]);
  return g.pos.length / 3 - 1;
}
const crom = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
const X_AXIS = [1, 0, 0];
// A tube through rings [x, y, z, rx, ry | [ryUp, ryDown], n]: rx is the half width along `side`, ry the half height along (path x side),
// which is up for a path running forward, forward for a path running down; n the squareness of the section (2 an ellipse).
// o: seg (vertices round), sub (smoothing steps between rings), cap [start, end] (length of the rounded ends; 0 flat),
//    side (default x), disp(P) -> pixels pushed outward, n (default squareness).
function loft(g, rings, paint, o) {
  o = o || {};
  const N = o.seg || 12, sub = o.sub || 3, side = o.side || X_AXIS;
  const K = rings.map(r => [r[0], r[1], r[2], r[3], Array.isArray(r[4]) ? r[4][0] : r[4], Array.isArray(r[4]) ? r[4][1] : r[4], r[5] || o.n || 2]);
  const S = [];
  for (let i = 0; i < K.length - 1; i++) {
    const a = K[Math.max(0, i - 1)], b = K[i], c = K[i + 1], d = K[Math.min(K.length - 1, i + 2)];
    for (let s = 0; s < sub; s++) { const q = []; for (let k = 0; k < 7; k++) q.push(crom(a[k], b[k], c[k], d[k], s / sub)); S.push(q); }
  }
  S.push(K[K.length - 1].slice());
  const n = S.length, T = [];
  for (let i = 0; i < n; i++) {
    const a = S[Math.max(0, i - 1)], b = S[Math.min(n - 1, i + 1)];
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(t[0], t[1], t[2]) || 1;
    T.push([t[0] / l, t[1] / l, t[2] / l]);
  }
  // the rings to draw: [centre, tangent, scale, v], with the rounded ends
  const F = [], capLen = e => { const s = S[e ? n - 1 : 0], d = o.cap ? o.cap[e] : null; return d != null ? d : 0.6 * Math.min(s[3], (s[4] + s[5]) / 2); };
  const c0 = capLen(0), c1 = capLen(1), CAP = [72, 48, 24];
  if (c0 > 0) for (const deg of CAP) { const a = deg * Math.PI / 180, s = S[0], t = T[0], k = c0 * Math.sin(a); F.push([[s[0] - t[0] * k, s[1] - t[1] * k, s[2] - t[2] * k], 0, Math.cos(a), 0]); }
  for (let i = 0; i < n; i++) F.push([[S[i][0], S[i][1], S[i][2]], i, 1, i / (n - 1)]);
  if (c1 > 0) for (let q = 2; q >= 0; q--) { const a = CAP[q] * Math.PI / 180, s = S[n - 1], t = T[n - 1], k = c1 * Math.sin(a); F.push([[s[0] + t[0] * k, s[1] + t[1] * k, s[2] + t[2] * k], n - 1, Math.cos(a), 1]); }
  const base = g.pos.length / 3;
  for (const [c, i, sc, v] of F) {
    const s = S[i], t = T[i];
    let sx = side[0], sy = side[1], sz = side[2];
    const dt = sx * t[0] + sy * t[1] + sz * t[2];
    sx -= t[0] * dt; sy -= t[1] * dt; sz -= t[2] * dt;
    const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
    const ux = t[1] * sz - t[2] * sy, uy = t[2] * sx - t[0] * sz, uz = t[0] * sy - t[1] * sx;   // t x side
    const e = 2 / s[6];
    for (let j = 0; j < N; j++) {
      const a = (j / N) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      const px = Math.sign(cs) * Math.pow(Math.abs(cs), e) * s[3] * sc, py = Math.sign(sn) * Math.pow(Math.abs(sn), e) * (sn >= 0 ? s[4] : s[5]) * sc;
      let x = c[0] + sx * px + ux * py, y = c[1] + sy * px + uy * py, z = c[2] + sz * px + uz * py;
      P.u = j / N; P.v = v; P.up = sn; P.d = 0;
      if (o.disp) {
        P.x = x; P.y = y; P.z = z;
        const d = o.disp(P), dx = x - S[i][0], dy = y - S[i][1], dz = z - S[i][2], dl = Math.hypot(dx, dy, dz) || 1;
        x += dx / dl * d; y += dy / dl * d; z += dz / dl * d;
      }
      vert(g, x, y, z, paint);
    }
  }
  const R = F.length;
  for (let r = 0; r < R - 1; r++) for (let j = 0; j < N; j++) {
    const A = base + r * N + j, B = base + r * N + (j + 1) % N, Cc = base + (r + 1) * N + (j + 1) % N, D = base + (r + 1) * N + j;
    g.idx.push(A, B, Cc, A, Cc, D);
  }
  // the two ends
  P.u = 0; P.up = 0; P.d = 0;
  P.v = 0; { const s = S[0], t = T[0], p = vert(g, s[0] - t[0] * c0, s[1] - t[1] * c0, s[2] - t[2] * c0, paint); for (let j = 0; j < N; j++) g.idx.push(p, base + (j + 1) % N, base + j); }
  P.v = 1; { const s = S[n - 1], t = T[n - 1], p = vert(g, s[0] + t[0] * c1, s[1] + t[1] * c1, s[2] + t[2] * c1, paint), b = base + (R - 1) * N; for (let j = 0; j < N; j++) g.idx.push(p, b + j, b + (j + 1) % N); }
}
// An ellipsoid: centre, radii [x, y, z] (or one number).
function ball(g, c, r, paint, seg) {
  const [rx, ry, rz] = typeof r === "number" ? [r, r, r] : r;
  loft(g, [[c[0], c[1], c[2] - rz * 0.9, rx * 0.44, ry * 0.44], [c[0], c[1], c[2] - rz * 0.55, rx * 0.835, ry * 0.835], [c[0], c[1], c[2], rx, ry],
    [c[0], c[1], c[2] + rz * 0.55, rx * 0.835, ry * 0.835], [c[0], c[1], c[2] + rz * 0.9, rx * 0.44, ry * 0.44]], paint, { seg: seg || 10, sub: 2, cap: [rz * 0.1, rz * 0.1] });
}
// The same piece on both sides: fn(g, s) with s = 1 (the animal's left, +x) then -1.
const both = (g, fn) => { fn(g, 1); fn(g, -1); };

const _c = new THREE.Color();
function finish(g, pivot) {
  const n = g.pos.length / 3, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3), p = g.pos, ix = g.idx;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz; nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz; nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0; i < n; i++) {
    const k = i * 3, l = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
    nrm[k] /= l; nrm[k + 1] /= l; nrm[k + 2] /= l;
    pos[k] = (p[k] - pivot[0]) * PX; pos[k + 1] = (p[k + 1] - pivot[1]) * PX; pos[k + 2] = (p[k + 2] - pivot[2]) * PX;
    const sh = 0.9 + 0.1 * nrm[k + 1];   // a touch darker underneath, where the sky's light is already weakest
    _c.setRGB(clamp01(g.col[k]), clamp01(g.col[k + 1]), clamp01(g.col[k + 2])).convertSRGBToLinear();
    col[k] = _c.r * sh; col[k + 1] = _c.g * sh; col[k + 2] = _c.b * sh;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(ix), 1) : new THREE.BufferAttribute(new Uint16Array(ix), 1));
  geo.computeBoundingSphere();
  return geo;
}
// One part of a model: fn(g) draws it in model pixels; the pivot is taken off afterwards.
function part(name, pivot, flags, fn) {
  const g = Geo();
  fn(g);
  return Object.assign({ name, pivot, boxes: [], geo: finish(g, pivot) }, flags);
}

// ---------- shared pieces ----------
const EYE = C(0x15100e);
const eye = (g, x, y, z, r) => ball(g, [x, y, z], r, EYE, 8);
// A leg hanging from its hip (x, top, z). o: r (thickness), paint, hoof (colour), hoofH, natural: "front" | "hind" (jointed), fat (thigh).
function leg(g, x, top, z, o) {
  const L = top, r = o.r, J = (o.joint != null ? o.joint : 1) * top, hoofH = o.hoofH != null ? o.hoofH : 1.3;
  const paint = Q => (Q.y < hoofH ? o.hoof : o.paint(Q));
  if (!o.natural) {
    loft(g, [[x, L + 2.2, z, r * 1.12, r * 1.12], [x, L * 0.6, z, r, r], [x, hoofH + 0.2, z, r * 0.8, r * 0.8], [x, hoofH * 0.6, z, r * 0.9, r * 0.92], [x, 0, z, r * 0.92, r * 0.95]],
      paint, { seg: 10, sub: 3, cap: [r * 0.7, 0] });
    return;
  }
  const f = o.fat || 1;
  // rings as [height / L, forward / J, half width / r, front / r, back / r]; the first two carry the thigh (x f)
  const prof = o.natural === "front"
    ? [[1.22, 0.02, 1.2 * f, 1.45 * f, 1.45 * f], [0.86, 0.03, 1.0, 1.15, 1.1], [0.5, 0.04, 0.72, 0.76, 0.72], [0.3, 0.02, 0.52, 0.54, 0.54], [0.14, 0.01, 0.5, 0.52, 0.52],
       [0.09, 0.015, 0.62, 0.66, 0.66], [0.045, 0.04, 0.66, 0.78, 0.64], [0, 0.06, 0.8, 0.95, 0.72]]
    : [[1.25, 0.04, 1.2 * f, 1.6 * f, 1.6 * f], [0.92, 0.06, 1.1 * f, 1.4 * f, 1.4 * f], [0.68, 0, 0.85, 1.0, 1.0], [0.48, -0.11, 0.62, 0.66, 0.72], [0.3, -0.085, 0.5, 0.52, 0.52],
       [0.14, -0.05, 0.5, 0.52, 0.52], [0.09, -0.035, 0.62, 0.66, 0.66], [0.045, 0, 0.66, 0.78, 0.64], [0, 0.02, 0.8, 0.95, 0.72]];
  loft(g, prof.map(q => [x, L * q[0], z + q[1] * J, r * q[2], [r * q[3], r * q[4]]]), paint, { seg: 10, sub: 3, cap: [r, 0] });
}
// The four legs of a quadruped, with the box model's names, pivots and swing: hips at (+-px, len, +-pz).
function quadLegs(px, pz, len, o) {
  const one = (name, sx, sz, swing) => part(name, [sx * px, len, sz * pz], { swing }, g =>
    leg(g, sx * px, len, sz * pz, Object.assign({}, o, o.natural ? { natural: sz > 0 ? "front" : "hind" } : null, sz > 0 ? o.frontLeg : o.hindLeg)));
  return [one("legFL", -1, 1, 1), one("legFR", 1, 1, -1), one("legBL", -1, -1, -1), one("legBR", 1, -1, 1)];
}
// A flap (an ear, a feather): a flattened tube from a to b, w wide in the middle, th thick.
function flap(g, a, b, w, th, paint, side, o) {
  const m = k => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const bend = (o && o.bend) || [0, 0, 0], q = (k, wk) => { const p = m(k), s = Math.sin(k * Math.PI); return [p[0] + bend[0] * s, p[1] + bend[1] * s, p[2] + bend[2] * s, w * wk, th * (0.5 + wk * 0.5)]; };
  loft(g, [q(0, (o && o.root) || 0.55), q(0.3, 1), q(0.62, 0.92), q(0.88, 0.5), q(1, 0.16)], paint, { seg: 8, sub: 2, side, cap: [th * 0.5, th * 0.6] });
}

// ---------- pig ----------
function pig(style) {
  const nat = style === "b";
  const pink = nat ? C(0xe3b3a0) : C(0xefa9a6), belly = nat ? C(0xeec7b6) : C(0xf6c2bc), dark = nat ? C(0x35302c) : null, hoof = nat ? C(0x5b4a44) : C(0xb26f6d);
  const skin = Q => {
    let c = mix(pink, belly, ramp(Q.y, 9, 5.5) * 0.8);
    c = mul(c, 0.96 + 0.08 * fbm(Q.x * 0.7, Q.y * 0.7, Q.z * 0.7));
    if (nat) {   // Old Spot: a few big dark blotches, mostly on the back and flanks
      const s = fbm((Q.x + Q.z * 0.6) * 0.2 + 4.2, (Q.y + Q.x * 0.5) * 0.2 + 1.3, (Q.z - Q.y * 0.6) * 0.18 + 8.1);
      c = mix(c, dark, sm(ramp(s, 0.53, 0.59)) * 0.9 * ramp(Q.y, 6.5, 9.5));
    }
    return c;
  };
  const snoutC = nat ? C(0xd99a8c) : C(0xe58d90), nostril = C(0x7a3f42);
  const body = part("body", [0, 0, 0], {}, g => {
    if (nat) loft(g, [[0, 10.3, -8.6, 3.6, [3.4, 3.2]], [0, 10.6, -5.5, 5.0, [4.5, 4.6]], [0, 10.4, -1, 5.3, [4.5, 5.1]], [0, 10.0, 3.5, 5.0, [4.2, 4.9]], [0, 10.2, 7.2, 4.2, [3.9, 4.2]], [0, 10.5, 9.4, 3.5, [3.5, 3.6]]],
      skin, { seg: 28, sub: 6, cap: [2.2, 1.5] });
    else loft(g, [[0, 10.2, -7.6, 4.3, 3.9], [0, 10.4, -4, 5.5, [4.5, 4.8]], [0, 10.3, 1, 5.6, [4.4, 4.9]], [0, 10.5, 6, 5.0, [4.3, 4.5]], [0, 10.8, 8.6, 4.1, 3.9]], skin, { seg: 18, sub: 4, cap: [3, 2] });
    // a curly tail
    const tail = [], z0 = nat ? -10.6 : -10.4;
    for (let k = 0; k <= 9; k++) { const a = k * 0.85; tail.push([Math.sin(a) * 0.9 * Math.min(1, k / 2), 11.6 + (1 - Math.cos(a)) * 0.8, z0 - k * 0.22, 0.42 - k * 0.025, 0.42 - k * 0.025]); }
    loft(g, tail, pink, { seg: 6, sub: 2 });
  });
  const head = part("head", [0, 12, 7], { head: true }, g => {
    if (nat) {
      loft(g, [[0, 11.4, 7.5, 3.9, [3.9, 4.0]], [0, 11.6, 10, 4.1, [3.9, 4.1]], [0, 11.3, 12.6, 3.3, [3.0, 3.3]], [0, 10.5, 15, 2.3, [1.9, 2.0]], [0, 10.0, 16.8, 2.0, [1.6, 1.6]]], skin, { seg: 16, sub: 4, cap: [2.5, 0] });
      loft(g, [[0, 10.0, 16.7, 2.1, 1.7], [0, 9.95, 17.3, 2.15, 1.75]], snoutC, { seg: 12, sub: 1, cap: [0, 0.35] });
      both(g, (g, s) => { ball(g, [s * 0.85, 10.0, 17.6], [0.36, 0.5, 0.25], nostril, 6); eye(g, s * 2.75, 12.6, 13.4, 0.55); });
      // lop ears, falling forward over the eyes
      both(g, (g, s) => flap(g, [s * 2.6, 14.6, 9.4], [s * 3.5, 13.0, 14.0], 2.0, 0.5, Q => mix(skin(Q), C(0xd58f88), 0.35), [1, 0, 0], { bend: [s * 0.4, 1.3, 0], root: 0.8 }));
    } else {
      ball(g, [0, 11.9, 10.8], [4.4, 4.2, 4.4], skin, 16);
      loft(g, [[0, 10.7, 14.2, 2.4, 2.0], [0, 10.6, 16.0, 2.3, 1.9]], Q => (Q.z > 16.05 ? C(0xd77d84) : snoutC), { seg: 12, sub: 2, cap: [0, 0.4] });
      both(g, (g, s) => { ball(g, [s * 0.85, 10.7, 16.35], [0.38, 0.55, 0.22], nostril, 6); eye(g, s * 2.75, 13.0, 14.0, 0.68); });
      both(g, (g, s) => flap(g, [s * 2.5, 15.0, 10.6], [s * 4.3, 17.6, 12.0], 1.9, 0.55, Q => mix(skin(Q), C(0xdf8f92), 0.4), [0, 0.2, 1], { bend: [0, 0, 0.7], root: 0.85 }));
    }
  });
  return [body, head, ...quadLegs(3, 5, 6, { r: nat ? 1.75 : 2.0, paint: skin, hoof, hoofH: nat ? 1.0 : 1.2, natural: nat, fat: 0.85, joint: 0.6 })];
}

// ---------- cow ----------
function cow(style) {
  const nat = style === "b";
  const brown = C(0x4e3526), white = C(0xe9e3da), red = C(0x743c24), hoof = C(0x3b332d), muzzle = nat ? C(0xd9a79a) : C(0xc9ad98), horn = C(0xd9d0bd);
  const coat = Q => {
    let c;
    if (nat) {   // Hereford: red body, white face, chest, belly, socks and the line of the back at the withers
      const n = fbm(Q.x * 0.22 + 2, Q.y * 0.22, Q.z * 0.22 + 5) - 0.5;
      const under = Math.abs(Q.x) < 4.6 ? sm(ramp(Q.y + n * 2 + Math.abs(Q.x) * 0.25, 12.4, 11.4)) : 0;   // the belly, not the legs beside it
      const front = sm(ramp(Q.z + n * 4 - Math.max(0, Q.y - 19) * 0.9 + Math.max(0, 15 - Q.y) * 0.5, 12.6, 14.0));   // face, throat and brisket
      const crest = Q.y > 20.4 && Q.z > 2 && Q.z < 12 ? sm(ramp(Math.abs(Q.x), 2.0, 0.8)) * sm(ramp(Q.y, 20.4, 21.4)) * sm(ramp(Q.z, 2, 5)) : 0;
      const w = Math.max(under, front, crest, sm(ramp(Q.y + n * 3, 5.2, 4.0)));
      c = mix(red, white, w);
      c = mul(c, 0.9 + 0.2 * fbm(Q.x * 0.9, Q.y * 0.9, Q.z * 0.9));
    } else {     // the box model's cow: dark brown with white patches
      const s = fbm((Q.x + Q.z * 0.5) * 0.16 + 9.1, (Q.y - Q.x * 0.4) * 0.16 + 3.3, (Q.z + Q.y * 0.5) * 0.14 + 1.7);
      c = mix(brown, white, sm(ramp(s, 0.56, 0.6)));
      c = mul(c, 0.94 + 0.12 * fbm(Q.x * 0.8, Q.y * 0.8, Q.z * 0.8));
    }
    return c;
  };
  const legPaint = nat ? coat : Q => (Q.y < 3.4 ? white : coat(Q));
  const body = part("body", [0, 0, 0], {}, g => {
    if (nat) loft(g, [[0, 17.4, -10, 4.6, [4.4, 4.6]], [0, 17.2, -7, 6.0, [5.0, 5.6]], [0, 16.6, -2, 6.4, [5.3, 6.2]], [0, 16.5, 3, 6.2, [5.4, 6.0]], [0, 16.8, 7.5, 5.5, [5.3, 5.9]], [0, 17.6, 10.6, 4.2, [4.4, 5.4]]],
      coat, { seg: 22, sub: 4, cap: [2.2, 2.4], n: 2.25 });
    else loft(g, [[0, 17, -9, 5.2, 4.6], [0, 17, -5, 6.4, [5.0, 5.3]], [0, 16.9, 1, 6.5, [5.0, 5.4]], [0, 17, 6.5, 6.0, [5.0, 5.2]], [0, 17.4, 9.4, 4.9, 4.6]], coat, { seg: 20, sub: 4, cap: [3, 2.4], n: 2.3 });
    ball(g, [0, nat ? 11.0 : 11.9, -4.2], [2.5, 1.8, 2.9], C(0xe2b1a6), 10);   // udder
    both(g, (g, s) => ball(g, [s * 1.1, nat ? 9.5 : 10.5, -4.2], [0.36, 0.7, 0.36], C(0xd79c94), 6));
    // tail: down from the rump to a dark tuft
    loft(g, [[0, 21, -11.2, 0.55, 0.55], [0, 18, -12.6, 0.45, 0.45], [0, 12, -12.9, 0.4, 0.4], [0, 8.6, -12.6, 0.42, 0.42]], Q => coat({ x: 0, y: 19, z: -9 }), { seg: 6, sub: 3, cap: [0.3, 0.3] });
    ball(g, [0, 7.3, -12.5], [0.75, 1.6, 0.75], nat ? white : C(0x2e2018), 8);
    if (nat) loft(g, [[0, 14.6, 11.2, 0.9, 1.6], [0, 12.2, 9.4, 1.2, 1.5], [0, 11.2, 6.5, 0.8, 0.9]], coat, { seg: 8, sub: 3 });   // dewlap and brisket
  });
  const head = part("head", [0, 20, 9], { head: true }, g => {
    if (nat) {
      loft(g, [[0, 19.6, 8.2, 3.8, [4.4, 4.6]], [0, 20.2, 11.0, 3.5, [3.8, 4.2]], [0, 20.6, 13.4, 3.7, [3.5, 3.8]], [0, 19.4, 16.0, 3.2, [2.7, 3.2]], [0, 17.6, 18.6, 2.6, [2.0, 2.4]], [0, 16.4, 20.2, 2.5, [1.8, 2.0]]],
        Q => mix(coat(Q), muzzle, sm(ramp(Q.z - (Q.y - 17) * 0.6, 19.2, 20.2))), { seg: 16, sub: 4, cap: [2, 1.1], n: 2.3 });
      both(g, (g, s) => {
        eye(g, s * 3.15, 20.6, 15.0, 0.6); ball(g, [s * 1.0, 16.2, 21.15], [0.42, 0.34, 0.25], C(0x4c342f), 6);
        flap(g, [s * 3.2, 21.6, 12.6], [s * 7.4, 21.0, 12.2], 1.5, 0.5, Q => mix(red, C(0xd9a79a), sm(ramp(Q.z, 12.3, 13.2)) * 0.5), [0, 0.5, 1], { bend: [0, 0.6, 0], root: 0.7 });
        loft(g, [[s * 2.4, 23.0, 12.4, 0.8, 0.8], [s * 4.2, 23.5, 12.5, 0.65, 0.65], [s * 5.4, 24.6, 13.0, 0.45, 0.45], [s * 5.6, 25.9, 13.6, 0.18, 0.18]], horn, { seg: 7, sub: 3, side: [0, 0, 1] });
      });
    } else {
      loft(g, [[0, 20, 9.4, 4.3, 4.2], [0, 20, 12, 4.3, [4.2, 4.2]], [0, 19.2, 14.6, 3.8, [3.4, 3.6]], [0, 18.2, 16.2, 3.2, [2.4, 2.4]]],
        Q => mix(mix(coat(Q), white, sm(ramp(Math.abs(Q.x), 1.9, 1.1)) * ramp(Q.y, 19.5, 21) * ramp(Q.z, 10.5, 12.5)), muzzle, sm(ramp(Q.z - (Q.y - 18) * 0.5, 15.6, 16.4))), { seg: 16, sub: 4, cap: [2.4, 1.2], n: 2.5 });
      both(g, (g, s) => {
        eye(g, s * 3.0, 20.6, 15.3, 0.7); ball(g, [s * 1.1, 17.9, 17.45], [0.42, 0.36, 0.22], C(0x3f2c27), 6);
        flap(g, [s * 3.8, 21.2, 11.4], [s * 7.0, 21.6, 11.2], 1.4, 0.5, Q => mix(brown, C(0xd9a79a), sm(ramp(Q.z, 11.3, 12.0)) * 0.45), [0, 0.4, 1], { root: 0.7 });
        loft(g, [[s * 2.6, 23.4, 11.4, 0.8, 0.8], [s * 3.9, 24.6, 11.5, 0.6, 0.6], [s * 4.3, 26.0, 11.7, 0.25, 0.25]], horn, { seg: 7, sub: 3, side: [0, 0, 1] });
      });
    }
  });
  return [body, head, ...quadLegs(4, 7, 12, { r: nat ? 1.9 : 2.1, paint: legPaint, hoof, hoofH: 1.4, natural: nat, fat: 1.2 })];
}

// ---------- sheep ----------
function sheep(style, variant) {
  const nat = style === "b", shorn = variant === "shorn";
  const wool = nat ? C(0xe6dfcf) : C(0xeeeeea), crease = nat ? C(0xb9ad97) : C(0xcfcfca), skin = nat ? C(0x2b2724) : C(0xd9c4a7), hoof = nat ? C(0x191614) : C(0x8c7862);
  const shornC = nat ? C(0xdccfbd) : C(0xe6c9b6);
  const F = nat ? 0.42 : 0.3, A = nat ? 1.25 : 1.0;   // lump size and depth
  const lump = Q => { const d = cells(Q.x * F, Q.y * F, Q.z * F); return (Q.d = sm(1 - d * 1.25)) * A; };
  const fleece = Q => mul(mix(crease, wool, 0.25 + 0.75 * Q.d), 0.95 + 0.1 * vnoise(Q.x * 1.5, Q.y * 1.5, Q.z * 1.5));
  const shornP = Q => mul(shornC, 0.9 + 0.2 * fbm(Q.x * 1.1, Q.y * 1.1, Q.z * 1.1));
  const hide = Q => mul(skin, 0.92 + 0.16 * fbm(Q.x, Q.y, Q.z));
  const body = part("body", [0, 0, 0], {}, g => {
    if (shorn) loft(g, [[0, 16.2, -7.4, 3.4, 3.4], [0, 16.2, -4, 4.6, [4.0, 4.3]], [0, 16, 1, 4.7, [3.9, 4.4]], [0, 16.2, 5.5, 4.3, [3.9, 4.1]], [0, 16.8, 7.6, 3.3, 3.4]], shornP, { seg: 18, sub: 4, cap: [2.2, 1.6] });
    else if (nat) loft(g, [[0, 16.4, -8.2, 4.6, [4.6, 4.4]], [0, 16.4, -4.5, 6.0, [5.3, 5.4]], [0, 16.2, 0.5, 6.2, [5.3, 5.7]], [0, 16.4, 5, 5.9, [5.4, 5.5]], [0, 17.2, 8.2, 4.6, [4.8, 4.8]]],
      fleece, { seg: 30, sub: 7, cap: [3, 2.6], disp: lump });
    else loft(g, [[0, 16.2, -7.6, 5.2, 4.8], [0, 16.3, -3.5, 6.5, [5.6, 5.4]], [0, 16.3, 2, 6.5, [5.6, 5.4]], [0, 16.6, 7, 5.6, [5.2, 5.0]]], fleece, { seg: 26, sub: 7, cap: [3.6, 3.2], disp: lump });
    if (shorn) ball(g, [0, 17.6, -9.2], [0.9, 1.0, 1.0], shornP, 8);
    else ball(g, [0, 17.4, nat ? -11.2 : -11], [1.5, 1.6, 1.4], Q => mix(crease, wool, 0.7), 8);   // tail
  });
  const head = part("head", [0, 18, 7], { head: true }, g => {
    if (nat) {
      if (!shorn) loft(g, [[0, 18.6, 6.4, 4.0, [4.2, 4.2]], [0, 19.4, 9.2, 3.6, [3.6, 3.9]], [0, 20.4, 11.0, 2.6, [2.4, 2.6]]], fleece, { seg: 18, sub: 4, cap: [1, 1.2], disp: Q => lump(Q) * 0.7 });   // woolly neck
      else loft(g, [[0, 18.4, 6.4, 2.6, 2.9], [0, 19.6, 9.6, 2.4, 2.6]], shornP, { seg: 12, sub: 3 });
      loft(g, [[0, 20.6, 9.6, 2.7, [2.6, 2.7]], [0, 20.4, 12, 2.7, [2.5, 2.6]], [0, 19.0, 14.6, 2.2, [1.9, 2.0]], [0, 17.6, 16.6, 1.7, [1.4, 1.4]]], hide, { seg: 14, sub: 4, cap: [1.6, 0.9] });
      both(g, (g, s) => {
        ball(g, [s * 2.35, 20.7, 13.2], 0.5, C(0xb08a3a), 8); ball(g, [s * 2.55, 20.7, 13.35], [0.3, 0.2, 0.42], C(0x0c0a09), 6);
        flap(g, [s * 2.4, 21.4, 10.6], [s * 6.2, 19.9, 10.4], 1.3, 0.45, hide, [0, 0.3, 1], { bend: [0, 0.5, 0], root: 0.7 });
        ball(g, [s * 0.6, 17.2, 17.35], [0.3, 0.22, 0.2], C(0x0c0a09), 6);
      });
    } else {
      ball(g, [0, 18.6, 11.4], [3.2, 3.5, 4.2], Q => mul(skin, 0.95 + 0.1 * fbm(Q.x, Q.y, Q.z)), 14);
      if (!shorn) loft(g, [[0, 20.4, 7.6, 3.6, [2.6, 3.0]], [0, 20.8, 10.2, 3.6, [2.6, 2.6]], [0, 20.6, 12.6, 3.0, [2.0, 1.4]]], fleece, { seg: 18, sub: 4, cap: [1.5, 1.2], disp: Q => lump(Q) * 0.7 });   // wool cap
      both(g, (g, s) => {
        eye(g, s * 2.35, 18.9, 14.1, 0.62);
        flap(g, [s * 2.7, 19.6, 10.6], [s * 5.6, 18.6, 10.8], 1.2, 0.45, Q => mul(skin, 0.92), [0, 0.3, 1], { root: 0.7 });
      });
      ball(g, [0, 17.6, 15.5], [0.75, 0.5, 0.3], C(0xc49a8c), 6);   // nose
    }
  });
  const woolTop = shorn || nat ? null : 6.5;   // soft style: wool down to the knees
  const legPaint = Q => (woolTop != null && Q.y > woolTop ? mix(crease, wool, 0.8) : hide(Q));
  return [body, head, ...quadLegs(3, 5, 12, { r: nat ? 1.35 : 1.5, paint: legPaint, hoof, hoofH: 1.2, natural: nat, fat: 1.1 })];
}

// ---------- chicken ----------
function chicken(style) {
  const nat = style === "b";
  const wh = C(0xf4f3ee), cream = C(0xe2ddd0), orange = nat ? C(0xd9a441) : C(0xe8a23a), red = C(0xc9302b);
  const rust = C(0x8e4a25), dkRust = C(0x5e2e18), gold = C(0xc48a3c), tailC = C(0x2a2622);
  // feathers: scallops in rows down the body
  const scale = Q => { const r = Q.y * 0.9 - Q.z * 0.35, row = r - Math.floor(r), k = Q.x * 0.8 + Q.z * 0.8 + (Math.floor(r) & 1) * 0.5; return row * (0.55 + 0.45 * Math.abs(Math.sin(k * Math.PI))); };
  const plum = nat
    ? Q => mul(mix(dkRust, mix(rust, gold, ramp(Q.y, 9, 13) * 0.6 + ramp(Q.z, 1, 4) * 0.25), 0.35 + 0.65 * scale(Q)), 0.92 + 0.16 * vnoise(Q.x * 2, Q.y * 2, Q.z * 2))
    : Q => mix(cream, wh, 0.35 + 0.65 * ramp(Q.y, 5.5, 8.5));
  const body = part("body", [0, 0, 0], {}, g => {
    if (nat) {
      loft(g, [[0, 9.6, -4.6, 1.5, [1.4, 1.5]], [0, 8.9, -3, 2.6, [2.3, 2.6]], [0, 8.2, -0.6, 3.1, [2.8, 3.1]], [0, 8.0, 1.6, 3.0, [2.9, 3.0]], [0, 8.8, 3.4, 2.3, [2.5, 2.5]], [0, 9.8, 4.2, 1.6, [1.8, 1.8]]], plum, { seg: 16, sub: 4, cap: [0.8, 1.0] });
      // tail: a fan of dark feathers
      for (let k = -2; k <= 2; k++) flap(g, [k * 0.35, 9.6, -4.2], [k * 1.15, 14.6 - Math.abs(k) * 0.9, -7.6 + Math.abs(k) * 0.5], 1.05, 0.22, Q => mix(tailC, dkRust, ramp(Q.y, 12, 9.5) * 0.8), [1, 0, 0], { bend: [0, 0.2, -0.9], root: 0.8 });
    } else {
      loft(g, [[0, 8.2, -4, 2.3, 2.3], [0, 8.1, -1.5, 3.3, [3.1, 3.1]], [0, 8.2, 1.5, 3.2, [3.1, 3.1]], [0, 9, 3.7, 2.3, 2.4]], plum, { seg: 16, sub: 4, cap: [1.6, 1.4] });
      flap(g, [0, 9.4, -4.4], [0, 12.4, -6.4], 2.0, 0.7, wh, [1, 0, 0], { bend: [0, -0.2, -0.6], root: 0.9 });
    }
  });
  const head = part("head", [0, 10, 3], { head: true }, g => {
    const hy = nat ? 14.8 : 14.1, hz = nat ? 4.9 : 4.6;
    if (nat) loft(g, [[0, 9.2, 3.0, 1.9, 2.0], [0, 11.4, 3.8, 1.45, 1.5], [0, 13.4, 4.4, 1.15, 1.2], [0, hy, hz - 0.2, 1.2, 1.3]], Q => mix(plum(Q), gold, ramp(Q.y, 10.5, 12.5) * 0.75), { seg: 12, sub: 3, cap: [1, 0.4] });
    else loft(g, [[0, 9.4, 3.0, 2.0, 2.0], [0, 11.6, 3.8, 1.75, 1.75], [0, 13.6, 4.4, 1.6, 1.6]], wh, { seg: 12, sub: 3, cap: [1, 0.6] });
    ball(g, [0, hy, hz], nat ? [1.35, 1.4, 1.65] : [1.8, 1.85, 1.95], nat ? Q => mix(rust, gold, 0.55) : wh, 12);
    const bz = hz + (nat ? 1.3 : 1.6);
    loft(g, [[0, hy - 0.25, bz, 0.72, [0.5, 0.45]], [0, hy - 0.5, bz + 1.0, 0.42, [0.3, 0.25]], [0, hy - 0.85, bz + 1.75, 0.08, 0.08]], orange, { seg: 8, sub: 2, cap: [0, 0.1] });
    // comb and wattles
    const ct = nat ? 1.0 : 1.25;
    loft(g, [[0, hy + 1.2, hz + 1.5, 0.3, [0.5, 0.3]], [0, hy + 1.7, hz + 0.8, 0.34, [ct, 0.4]], [0, hy + 1.75, hz + 0.25, 0.32, [ct * 0.55, 0.4]], [0, hy + 1.7, hz - 0.3, 0.34, [ct * 1.1, 0.4]], [0, hy + 1.5, hz - 0.85, 0.3, [ct * 0.5, 0.4]],
      [0, hy + 1.25, hz - 1.3, 0.3, [ct * 0.8, 0.3]], [0, hy + 0.8, hz - 1.7, 0.2, [0.3, 0.2]]], red, { seg: 8, sub: 2, cap: [0.2, 0.2] });
    both(g, (g, s) => { ball(g, [s * 0.38, hy - 1.5, bz + 0.1], [0.3, 0.75, 0.42], red, 6); eye(g, s * (nat ? 1.18 : 1.6), hy + 0.3, hz + 0.75, nat ? 0.3 : 0.36); });
  });
  const wing = (name, s) => part(name, [-s * 3, 10, 0], { wing: -s }, g => {   // (the box model: wingL at -x)
    const x = -s * (nat ? 3.05 : 3.25);
    if (nat) {
      loft(g, [[x, 9.6, 2.4, 0.5, [1.2, 1.4]], [x, 9.2, 0.6, 0.75, [1.7, 2.2]], [x, 9.0, -1.6, 0.7, [1.5, 2.0]], [x, 9.4, -3.6, 0.45, [0.9, 1.1]], [x, 10.0, -5.0, 0.2, [0.3, 0.4]]],
        Q => mul(mix(dkRust, rust, 0.3 + 0.7 * Math.abs(Math.sin((Q.z * 1.4 + Q.y * 0.5) * Math.PI / 1.6))), 0.9), { seg: 10, sub: 3, cap: [0.5, 0.3] });
    } else ball(g, [x, 8.4, -0.3], [0.75, 2.3, 3.2], Q => mix(cream, wh, 0.5 + 0.5 * ramp(Q.y, 6.5, 9)), 10);
  });
  const foot = (name, s, swing) => part(name, [s * 1.5, 5, 0], { swing }, g => {
    const x = s * 1.5, r = nat ? 0.32 : 0.42;
    loft(g, [[x, 5.6, 0, r * 1.5, r * 1.5], [x, 4.2, 0, r, r], [x, 0.5, 0.1, r, r]], Q => (Q.y > 4.6 ? plum(Q) : orange), { seg: 6, sub: 2, cap: [0.4, 0.2] });
    for (const [dx, dz] of [[-0.9, 1.7], [0, 2.3], [0.9, 1.7], [0, -1.1]])
      loft(g, [[x, 0.5, 0.1, r * 0.9, r * 0.8], [x + dx * 0.6, 0.3, dz * 0.6, r * 0.75, r * 0.6], [x + dx, 0.2, dz, r * 0.4, r * 0.35]], orange, { seg: 6, sub: 2, cap: [0.1, 0.25] });
  });
  return [body, head, wing("wingL", 1), wing("wingR", -1), foot("legL", -1, 1), foot("legR", 1, -1)];
}

// ---------- horse ----------
const COATS = { white: 0xe6e1d6, creamy: 0xc8a06a, chestnut: 0xa25e2c, brown: 0x6e4628, black: 0x2a2420, gray: 0x7e7873, dark_brown: 0x40291a };
function horse(style, variant) {
  const nat = style === "b";
  const [coatName, mark] = String(variant || "brown/none").split("/");
  const coat = C(COATS[coatName] != null ? COATS[coatName] : COATS.brown), dk = mul(coat, 0.6);
  const mane = coatName === "white" || coatName === "creamy" ? C(0x8a7a64) : coatName === "chestnut" && nat ? C(0x5a2f14) : C(0x1e1814);
  const WHITE = C(0xf2efe8), BLACK = C(0x221c18), hoof = C(0x2e2620), leather = C(0x6b3e1e), iron = C(0xa8a8b0);
  const fur = Q => {
    let c = mul(coat, 0.9 + 0.2 * fbm(Q.x * 0.5, Q.y * 0.5, Q.z * 0.5));
    if (nat) c = mix(c, dk, ramp(Q.y, 7, 2) * 0.55);   // darker lower legs
    if (mark === "white_field") c = mix(c, WHITE, sm(ramp(fbm((Q.x + Q.z * 0.5) * 0.15 + 3.1, (Q.y - Q.x * 0.4) * 0.15 + 7.7, (Q.z + Q.y * 0.5) * 0.13 + 1.9), 0.5, 0.54)));
    else if (mark === "white_dots") c = mix(c, WHITE, sm(ramp(cells(Q.x * 0.45, Q.y * 0.45, Q.z * 0.45), 0.34, 0.24)) * ramp(Q.y, 9, 13));
    else if (mark === "black_dots") c = mix(c, BLACK, sm(ramp(cells(Q.x * 0.45 + 9, Q.y * 0.45, Q.z * 0.45), 0.36, 0.26)) * ramp(Q.y, 9, 13));
    else if (mark === "white") c = mix(c, WHITE, sm(ramp(Q.y + (fbm(Q.x, 0, Q.z) - 0.5) * 2, 4.6, 3.8)));   // socks
    return c;
  };
  const face = Q => (mark === "white" ? mix(fur(Q), WHITE, sm(ramp(Math.abs(Q.x), 1.5, 0.9)) * ramp(Q.z, nat ? 13.5 : 13, nat ? 15 : 14.5)) : fur(Q));
  const body = part("body", [0, 0, 0], {}, g => {
    if (nat) loft(g, [[0, 17.2, -10.6, 3.6, [3.8, 3.6]], [0, 16.9, -7.6, 5.0, [4.7, 4.6]], [0, 16.0, -2.5, 4.9, [4.2, 4.9]], [0, 15.6, 2.5, 5.0, [4.4, 5.2]], [0, 16.0, 7, 4.9, [5.0, 5.4]], [0, 17.2, 10.4, 3.8, [4.4, 5.0]]],
      fur, { seg: 22, sub: 4, cap: [1.8, 2.0], n: 2.15 });
    else loft(g, [[0, 16.4, -10, 4.3, 4.4], [0, 16.3, -6, 5.3, [4.9, 5.0]], [0, 15.9, 0, 5.2, [4.6, 5.2]], [0, 16, 6, 5.2, [4.9, 5.2]], [0, 16.8, 10.4, 4.3, 4.6]], fur, { seg: 20, sub: 4, cap: [2.6, 2.2], n: 2.2 });
  });
  const head = part("head", [0, 19, 10], { head: true }, g => {
    if (nat) {
      loft(g, [[0, 17.6, 8.6, 3.4, [4.8, 4.8]], [0, 21, 10.4, 2.9, [4.0, 3.9]], [0, 25, 11.9, 2.4, [3.3, 3.0]], [0, 28.6, 13.2, 2.1, [2.7, 2.5]], [0, 30.4, 14.0, 2.0, [2.2, 2.2]]], fur, { seg: 14, sub: 4, cap: [1, 0.6] });   // arched neck
      loft(g, [[0, 30.6, 13.0, 2.3, [2.3, 2.8]], [0, 30.0, 15.2, 2.6, [2.4, 3.3]], [0, 28.4, 17.8, 2.2, [1.9, 2.8]], [0, 26.6, 20.2, 1.75, [1.5, 2.0]], [0, 25.4, 21.9, 1.8, [1.5, 1.7]]],
        Q => mix(face(Q), mul(coat, 0.45), sm(ramp(Q.z - (Q.y - 25.6) * 0.7, 21.0, 22.2)) * 0.8), { seg: 14, sub: 4, cap: [1.3, 0.9] });
      // mane: a fall of hair down the crest and one side, and a forelock
      loft(g, [[0, 31.9, 14.0, 0.7, [0.9, 0.6]], [0, 30.6, 12.0, 0.95, [1.3, 0.8]], [0.3, 27.2, 10.2, 1.2, [1.6, 0.8]], [0.5, 23, 8.4, 1.3, [1.6, 0.8]], [0.5, 20.6, 7.2, 1.0, [1.2, 0.6]]],
        Q => mul(mane, 0.8 + 0.5 * vnoise(Q.x * 3, Q.y * 0.6, Q.z * 3)), { seg: 10, sub: 4, cap: [0.5, 0.8] });
      for (let k = 0; k < 6; k++) { const y = 30.6 - k * 1.75, z = 12.3 - k * 0.72; flap(g, [0.6, y, z], [2.3 + (k % 2) * 0.3, y - 3.6, z - 0.5], 1.15, 0.4, Q => mul(mane, 0.8 + 0.5 * vnoise(Q.x * 3, Q.y * 0.5, Q.z * 3)), [0, 0.4, 1], { bend: [0.6, 0, 0], root: 0.9 }); }
      flap(g, [0, 31.8, 14.2], [0.3, 29.6, 17.4], 1.0, 0.4, mane, [1, 0, 0], { bend: [0, 0.5, 0.4], root: 0.9 });
      both(g, (g, s) => {
        eye(g, s * 2.4, 30.0, 16.0, 0.52); ball(g, [s * 1.0, 25.6, 22.5], [0.4, 0.5, 0.3], C(0x120d0b), 6);
        flap(g, [s * 1.4, 31.6, 13.4], [s * 1.9, 34.6, 13.9], 0.85, 0.4, fur, [s * 0.5, 0, 1], { root: 0.8 });
      });
    } else {
      loft(g, [[0, 18, 8.8, 2.9, 3.9], [0, 22, 10.2, 2.6, 3.2], [0, 26, 11.4, 2.4, 2.8], [0, 29.2, 12.4, 2.4, 2.6]], fur, { seg: 14, sub: 4, cap: [1, 0.8] });
      loft(g, [[0, 30, 11.6, 2.7, 2.7], [0, 29.2, 14.6, 3.0, [2.8, 2.9]], [0, 27.4, 17.6, 2.5, [2.2, 2.3]], [0, 25.9, 20.2, 2.15, [1.9, 1.9]]],
        Q => mix(face(Q), mul(coat, 0.55), sm(ramp(Q.z - (Q.y - 26) * 0.6, 19.6, 20.6)) * 0.6), { seg: 14, sub: 4, cap: [1.8, 1.3] });
      loft(g, [[0, 32.2, 12.6, 0.8, [1.0, 0.7]], [0, 31.6, 10.6, 0.9, [1.3, 0.8]], [0, 27, 8.6, 0.9, [1.4, 0.8]], [0, 22, 7.0, 0.9, [1.3, 0.8]], [0, 19.8, 6.6, 0.7, [0.9, 0.6]]], mane, { seg: 8, sub: 3, cap: [0.5, 0.6] });
      both(g, (g, s) => {
        eye(g, s * 2.75, 29.3, 15.4, 0.62); ball(g, [s * 1.1, 25.8, 21.3], [0.4, 0.5, 0.25], C(0x1a1410), 6);
        flap(g, [s * 1.6, 31.6, 11.8], [s * 2.1, 34.4, 12.1], 0.95, 0.45, fur, [s * 0.4, 0, 1], { root: 0.8 });
      });
    }
  });
  const hair = Q => mul(mane, 0.8 + 0.5 * vnoise(Q.x * 3, Q.y * 0.5, Q.z * 3));
  const tail = part("tail", [0, 20, -10], {}, g => {
    if (nat) loft(g, [[0, 20.2, -10.6, 0.9, 0.9], [0, 20.4, -12.6, 1.1, 1.1], [0, 17, -14.6, 1.6, 1.5], [0, 11, -15.0, 1.9, 1.6], [0, 6, -14.2, 1.5, 1.2], [0, 3.4, -13.6, 0.6, 0.5]], hair, { seg: 10, sub: 4, cap: [0.5, 0.8] });
    else loft(g, [[0, 20.4, -10.2, 1.2, 1.2], [0, 19.6, -12.4, 1.5, 1.4], [0, 14, -13.2, 1.7, 1.5], [0, 8.6, -12.8, 1.4, 1.2]], mane, { seg: 10, sub: 4, cap: [0.6, 1.2] });
  });
  const saddle = part("saddle", [0, 0, 0], {}, g => {
    const yb = nat ? 15.8 : 16, up = nat ? 5.0 : 5.3, rx = nat ? 5.45 : 5.7;
    loft(g, [[0, yb, -3.8, rx, [up + 0.9, 0.5]], [0, yb, -2.4, rx + 0.15, [up + 0.55, 0.5]], [0, yb, 1, rx + 0.15, [up + 0.5, 0.5]], [0, yb, 3.8, rx + 0.1, [up + 0.7, 0.5]], [0, yb + 0.1, 5.0, rx - 0.3, [up + 1.5, 0.5]]],
      Q => mul(leather, (Q.y < yb + 1.2 ? 0.7 : 1) * (0.9 + 0.2 * vnoise(Q.x * 1.3, Q.y * 1.3, Q.z * 1.3))), { seg: 18, sub: 3, cap: [0.4, 0.4], n: 2.2 });
    both(g, (g, s) => {
      loft(g, [[s * (rx + 0.35), yb + 2, 0.5, 0.18, 0.5], [s * (rx + 0.5), 12.6, 0.5, 0.18, 0.45]], C(0x3a2414), { seg: 6, sub: 1 });
      loft(g, [[s * (rx + 0.5), 12.7, -0.6, 0.3, 0.3], [s * (rx + 0.5), 11.3, -0.5, 0.3, 0.3], [s * (rx + 0.5), 11.3, 1.5, 0.3, 0.3], [s * (rx + 0.5), 12.7, 1.6, 0.3, 0.3]], iron, { seg: 6, sub: 2 });
    });
  });
  return [body, head, tail, saddle, ...quadLegs(3, 8, 11, { r: nat ? 1.55 : 1.95, paint: fur, hoof, hoofH: 1.5, natural: nat, fat: 1.25 })];
}

// ---------- the registry ----------
const TYPES = { pig, cow, sheep, chicken, horse };
function pickFromUrl() {
  const pick = Object.assign({}, DEFAULT);
  let q = null;
  try { q = new URLSearchParams(location.search).get("creatures"); } catch (_) {}
  if (!q) return pick;
  const ok = s => (s === "a" || s === "b" ? s : null);
  for (const tok of q.split(",")) {
    const [k, v] = tok.split(":");
    if (v === undefined) for (const t in TYPES) pick[t] = ok(k);
    else if (TYPES[k]) pick[k] = ok(v);
  }
  return pick;
}
const cache = new Map();
const creatures = {
  TYPES: Object.keys(TYPES), pick: pickFromUrl(),
  build: (type, variant, style) => TYPES[type](style, variant),
  // The parts js/mobview.js draws a mob of this type and variant with, or null for its own boxes.
  parts(type, variant) {
    const style = creatures.pick[type];
    if (!style || !TYPES[type]) return null;
    const key = type + ":" + (variant || "") + ":" + style;
    let p = cache.get(key);
    if (!p) cache.set(key, (p = TYPES[type](style, variant)));
    return p;
  },
};
BF.real.creatures = creatures;
})();
