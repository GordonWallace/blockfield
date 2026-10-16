// Where things are drawn (spec r14-03). On the planet (generator 4) every frame is drawn from a floating origin in the player's
// face frame:
//  - the camera sits at the render origin, and everything else is placed relative to it in doubles, so float32 vertex data stays
//    small and precise anywhere on the planet (atlas x reaches 2.9 million, where a float32 step is a quarter of a block);
//  - something on a neighbouring face is drawn by that face's unfold (BF.planet.UNFOLD: a quarter turn plus an offset), as one
//    rigid transform, so every block stays square; the opposite face is never drawn flat;
//  - near the 8 cube corners the flat drawing can't close the gap where only three faces meet, so the view blends towards the
//    true round drawing there (Gordon's "mode C"): k rises from 0 at 1,200 blocks from a corner to 1 at 500. Chunk meshes carry
//    their round positions too (js/world.js, the "sphere" attribute); the shader mixes them by k.
// Nothing is moved for good: positions stay canonical atlas coordinates, and only the world matrices used for this frame's
// drawing change (begin() before renderer.render, end() after). Off the planet only the onBegin hooks run.
//
// API: BF.view = { begin(scene, camera), end(), onBegin(fn), toRender(x, y, z, out), state, cornerRound }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// the corner blend: fully round within CORNER1 blocks of a cube corner, flat beyond CORNER0
const CORNER0 = 1200, CORNER1 = 500;

const hooks = [];
const state = { on: false, f: 0, eyeU: 0, eyeV: 0, eyeY: 0, eye: [0, 0, 0], M: [1, 0, 0, 0, 1, 0, 0, 0, 1], k: 0, corner: Infinity };
const view = { state, cornerRound: true, CORNER0, CORNER1 };
BF.view = view;

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Per-face flat placement for this frame: atlas point on face g -> render space (null: the opposite face, never drawn flat).
const L = [0, 1, 2, 3, 4, 5].map(() => (typeof THREE !== "undefined" ? new THREE.Matrix4() : null));
const Lok = [false, false, false, false, false, false];
const IDENT = { A: [1, 0, 0, 1], t: [0, 0] };
function setPlacements() {
  const P = BF.planet, N = P.N, W = P.W, s = state;
  for (let g = 0; g < 6; g++) {
    const e = g === s.f ? IDENT : P.UNFOLD[s.f][g];
    Lok[g] = !!e;
    if (!e) continue;
    const A = e.A, ox = -W * g - N, oz = -N;
    // render x = A0 u + A1 v + t0 - eyeU, z = A2 u + A3 v + t1 - eyeV, with u = x - W g - N, v = z - N
    L[g].set(
      A[0], 0, A[1], A[0] * ox + A[1] * oz + e.t[0] - s.eyeU,
      0, 1, 0, -s.eyeY,
      A[2], 0, A[3], A[2] * ox + A[3] * oz + e.t[1] - s.eyeV,
      0, 0, 0, 1);
  }
}

// Render-space position of atlas point (x, y, z) in this frame's view, or null when it isn't drawn (the opposite face, flat).
// Off the planet: the point itself.
const tp = [0, 0, 0];
view.toRender = function (x, y, z, out) {
  out = out || [0, 0, 0];
  const P = BF.planet;
  if (!state.on) { out[0] = x; out[1] = y; out[2] = z; return out; }
  const g = P.face(x, z);
  if (g < 0) return null;
  const s = state, k = s.k;
  let fx = 0, fy = y - s.eyeY, fz = 0;
  if (Lok[g]) { const e = L[g].elements; fx = e[0] * x + e[8] * z + e[12]; fz = e[2] * x + e[10] * z + e[14]; }
  else if (k < 1) return null;
  if (k <= 0) { out[0] = fx; out[1] = fy; out[2] = fz; return out; }
  P.pos(g, x - P.W * g - P.N, z - P.N, y, tp);
  const M = s.M, dx = tp[0] - s.eye[0], dy = tp[1] - s.eye[1], dz = tp[2] - s.eye[2];
  const sx = M[0] * dx + M[1] * dy + M[2] * dz, sy = M[3] * dx + M[4] * dy + M[5] * dz, sz = M[6] * dx + M[7] * dy + M[8] * dz;
  if (!Lok[g]) { out[0] = sx; out[1] = sy; out[2] = sz; return out; }
  out[0] = fx + (sx - fx) * k; out[1] = fy + (sy - fy) * k; out[2] = fz + (sz - fz) * k;
  return out;
};

// The corner blend k at atlas point (x, z): 0 away from the cube corners (and off the planet), 1 within CORNER1 blocks of one.
view.roundAt = function (x, z) {
  const P = BF.planet;
  if (!view.cornerRound || !P || !P.isPlanet()) return 0;
  const f = P.face(x, z);
  if (f < 0) return 0;
  const N = P.N, u = x - P.W * f - N, v = z - N;
  return smooth(CORNER0, CORNER1, Math.hypot(Math.min(Math.abs(u), Math.abs(N - u)), Math.min(Math.abs(v), Math.abs(N - v))));
};

// Runs fn at the start of every frame's drawing, before world matrices are worked out (on any world): for modules that keep
// their geometry relative to a moving reference point.
view.onBegin = function (fn) { hooks.push(fn); };

let tmpM = null, sphR = null, hidden = [], live = false, sceneRef = null, cameraRef = null;
const tr = [0, 0, 0];
view.begin = function (scene, camera) {
  for (const fn of hooks) { try { fn(); } catch (err) { console.error(err); } }
  const P = BF.planet, s = state;
  s.on = !!(P && P.isPlanet() && BF.player && BF.player.position);
  if (!s.on) { if (BF.world.roundK) BF.world.roundK.value = 0; return; }
  if (!tmpM) { tmpM = new THREE.Matrix4(); sphR = new THREE.Matrix4(); }
  const pp = BF.player.position, f = P.face(pp.x, pp.z);
  if (f < 0) { s.on = false; return; }
  const N = P.N, cam = camera.position;
  s.f = f; s.eyeU = cam.x - P.W * f - N; s.eyeV = cam.z - N; s.eyeY = cam.y;
  // the nearest cube corner is one of this face's own four
  const du = Math.min(Math.abs(s.eyeU), Math.abs(N - s.eyeU)), dv = Math.min(Math.abs(s.eyeV), Math.abs(N - s.eyeV));
  s.corner = Math.hypot(du, dv);
  s.k = view.roundAt(cam.x, cam.z);
  BF.world.roundK.value = s.k;
  setPlacements();
  // the round frame: rows are render x, y, z in planet space (grid u, up, grid v at the eye; x x up = v, see planet.js FACES)
  P.pos(f, s.eyeU, s.eyeV, s.eyeY, s.eye);
  const fr = P.frame(f, s.eyeU, s.eyeV, s.eyeY, {}), up = fr.up, e = fr.eu, d = e[0] * up[0] + e[1] * up[1] + e[2] * up[2];
  let x = [e[0] - up[0] * d, e[1] - up[1] * d, e[2] - up[2] * d];
  const l = Math.hypot(x[0], x[1], x[2]); x = [x[0] / l, x[1] / l, x[2] / l];
  const z = [x[1] * up[2] - x[2] * up[1], x[2] * up[0] - x[0] * up[2], x[0] * up[1] - x[1] * up[0]];
  s.M = [x[0], x[1], x[2], up[0], up[1], up[2], z[0], z[1], z[2]];

  scene.updateMatrixWorld();
  sceneRef = scene; cameraRef = camera; hidden = [];
  const M = s.M, k = s.k;
  for (const c of scene.children) {
    if (c === camera) continue;
    const m = c.matrix, ud = c.userData;
    const g = ud.anchor ? P.face(m.elements[12] + 1, m.elements[14] + 1) : P.face(m.elements[12], m.elements[14]);
    if (g < 0) continue;   // off the atlas: left as it is
    if (!Lok[g] && k < 1) { if (c.visible) { c.visible = false; hidden.push(c); } continue; }
    if (Lok[g]) c.matrixWorld.multiplyMatrices(L[g], m);
    else c.matrixWorld.copy(m);
    if (ud.anchor) {
      c.frustumCulled = k <= 0;   // its bounds are flat ones
      // a chunk mesh: its round placement, mapped into the mesh's own flat frame (the shader mixes the two by k)
      if (k > 0) {
        const a = ud.anchor, ax = a[0] - s.eye[0], ay = a[1] - s.eye[1], az = a[2] - s.eye[2];
        sphR.set(
          M[0], M[1], M[2], M[0] * ax + M[1] * ay + M[2] * az,
          M[3], M[4], M[5], M[3] * ax + M[4] * ay + M[5] * az,
          M[6], M[7], M[8], M[6] * ax + M[7] * ay + M[8] * az,
          0, 0, 0, 1);
        c.material.userData.sphM.multiplyMatrices(tmpM.copy(c.matrixWorld).invert(), sphR);
      }
    } else {
      if (k > 0 && view.toRender(m.elements[12], m.elements[13], m.elements[14], tr)) {
        const w = c.matrixWorld.elements; w[12] = tr[0]; w[13] = tr[1]; w[14] = tr[2];
      }
      for (const ch of c.children) ch.updateMatrixWorld(true);
    }
  }
  // the camera: at the origin, turned like everything on its own face (not at all)
  camera.matrixWorld.multiplyMatrices(L[f], camera.matrix);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  for (const ch of camera.children) ch.updateMatrixWorld(true);
  scene.autoUpdate = false;
  live = true;
};
view.end = function () {
  if (!live) return;
  live = false;
  sceneRef.autoUpdate = true;
  for (const c of hidden) c.visible = true;
  hidden = [];
  cameraRef.updateMatrixWorld(true);   // back to atlas coordinates for anything that reads it between frames
};
})();
