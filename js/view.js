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
// drawing change (begin() before renderer.render, end() after). With no player yet, or off the atlas, only the onBegin hooks run.
//
// Debug toggles (spec r14-21; the prototype's B / C / R keys), all off by default: F3 + B, F3 + C, F3 + R in the game, or the debug
// screen's Planet section. tints: each face's chunks tinted its own colour; wedge: no round drawing near the cube corners, so the
// open wedge where three faces meet shows (cornerRound off); sphere: the true sphere everywhere (k = 1) for comparison.
//
// API: BF.view = { begin(scene, camera), end(), onBegin(fn), toRender(x, y, z, out), state, cornerRound, debug, setDebug(o) }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// the corner blend: fully round within CORNER1 blocks of a cube corner, flat beyond CORNER0
const CORNER0 = 1200, CORNER1 = 500;
// the height blend (spec r14-04, Gordon's prototype heights): flat up to ALT0 blocks above the ground, fully round from ALT1. The
// ground is the higher of sea level and the smoothed terrain under the player, so a player on a plateau is still drawn flat.
const ALT0 = 250, ALT1 = 2500;
// off-planet mode above layer OFF (camera at the planet's centre, north up, drag to turn the planet), back below OFF_BACK
const OFF = 20000, OFF_BACK = 19400;
// the sky fades to space between these heights above the ground
const SPACE0 = 3000, SPACE1 = 60000;

const hooks = [];
const state = { on: false, f: 0, eyeU: 0, eyeV: 0, eyeY: 0, eye: [0, 0, 0], M: [1, 0, 0, 0, 1, 0, 0, 0, 1], k: 0, corner: Infinity,
  ground: 0, above: 0, kAlt: 0, offPlanet: false };
const view = { state, cornerRound: true, CORNER0, CORNER1, ALT0, ALT1, OFF, OFF_BACK, SPACE0, SPACE1 };
BF.view = view;

view.debug = { tints: false, wedge: false, sphere: false };
// Sets any of the debug toggles ({tints, wedge, sphere}: true / false); returns the toggles now.
view.setDebug = function (o) {
  const d = view.debug;
  for (const k of ["tints", "wedge", "sphere"]) if (o && typeof o[k] === "boolean") d[k] = o[k];
  view.cornerRound = !d.wedge;
  if (BF.world && BF.world.faceTintOn) BF.world.faceTintOn.value = d.tints ? 1 : 0;
  return { ...d };
};

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
// Before the first frame with a player (or off the atlas): the point itself.
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

// The corner blend k at atlas point (x, z): 0 away from the cube corners (and off the atlas), 1 within CORNER1 blocks of one.
view.roundAt = function (x, z) {
  const P = BF.planet;
  if (!view.cornerRound) return 0;
  const f = P.face(x, z);
  if (f < 0) return 0;
  const N = P.N, u = x - P.W * f - N, v = z - N;
  return smooth(CORNER0, CORNER1, Math.hypot(Math.min(Math.abs(u), Math.abs(N - u)), Math.min(Math.abs(v), Math.abs(N - v))));
};

// The smoothed ground under atlas point (x, z): the mean of the terrain at the point and 8 points 48 blocks around it, and never
// below sea level. Cached per 32-block cell of the current world (the key names the world, so a new world never reuses the old one's
// ground).
let gKey = null, gVal = 0;
view.groundAt = function (x, z) {
  const S = BF.state || {}, key = S.seed + "/" + S.gen + "/" + S.biomeScale + ":" + Math.floor(x / 32) + "," + Math.floor(z / 32);
  if (key === gKey) return gVal;
  let sum = 0, n = 0;
  const G = BF.worldgen;
  for (const [dx, dz] of [[0, 0], [48, 0], [-48, 0], [0, 48], [0, -48], [34, 34], [-34, 34], [34, -34], [-34, -34]]) {
    const c = BF.planet.canonCell(Math.floor(x + dx), Math.floor(z + dz), {});
    if (c.off) continue;
    let h = BF.SEA;
    try { h = G.heightAt(c.x, c.z); } catch (_) { /* before the world exists */ }
    sum += Math.max(BF.SEA, h); n++;
  }
  gKey = key; gVal = n ? sum / n : BF.SEA;
  return gVal;
};
// The whole blend k for an eye at atlas (x, y, z): the larger of the corner blend and the height blend.
view.kAt = function (x, y, z) {
  return Math.max(view.roundAt(x, z), smooth(ALT0, ALT1, y - view.groundAt(x, z)));
};
// How far the sky has faded to space (0 to 1) for the last frame drawn (js/sky.js).
view.spaceFade = () => (state.on ? smooth(SPACE0, SPACE1, state.above) : 0);

// Runs fn at the start of every frame's drawing, before world matrices are worked out (on any world): for modules that keep
// their geometry relative to a moving reference point.
view.onBegin = function (fn) { hooks.push(fn); };

let tmpM = null, sphR = null, hidden = [], live = false, sceneRef = null, cameraRef = null;
const tr = [0, 0, 0];
view.begin = function (scene, camera) {
  for (const fn of hooks) { try { fn(); } catch (err) { console.error(err); } }
  const P = BF.planet, s = state;
  s.on = !!(BF.player && BF.player.position);
  if (!s.on) { if (BF.world.roundK) BF.world.roundK.value = 0; if (axis) axis.visible = false; return; }
  if (!tmpM) { tmpM = new THREE.Matrix4(); sphR = new THREE.Matrix4(); }
  const pp = BF.player.position, f = P.face(pp.x, pp.z);
  if (f < 0) { s.on = false; return; }
  const N = P.N, cam = camera.position;
  s.f = f; s.eyeU = cam.x - P.W * f - N; s.eyeV = cam.z - N; s.eyeY = cam.y;
  // the nearest cube corner is one of this face's own four
  const du = Math.min(Math.abs(s.eyeU), Math.abs(N - s.eyeU)), dv = Math.min(Math.abs(s.eyeV), Math.abs(N - s.eyeV));
  s.corner = Math.hypot(du, dv);
  s.ground = view.groundAt(cam.x, cam.z); s.above = s.eyeY - s.ground;
  s.kAlt = smooth(ALT0, ALT1, s.above);
  s.k = view.debug.sphere ? 1 : Math.max(view.roundAt(cam.x, cam.z), s.kAlt);
  s.offPlanet = !!(BF.player.offPlanet);
  BF.world.roundK.value = s.k;
  setPlacements();
  setupClip(scene, camera);
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
    if (ud.renderSpace) { c.matrixWorld.copy(m); continue; }   // already in render space (the planet's axis)
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
        (Array.isArray(c.material) ? c.material[0] : c.material).userData.sphM.multiplyMatrices(tmpM.copy(c.matrixWorld).invert(), sphR);
      }
    } else {
      if (k > 0 && view.toRender(m.elements[12], m.elements[13], m.elements[14], tr)) {
        const w = c.matrixWorld.elements; w[12] = tr[0]; w[13] = tr[1]; w[14] = tr[2];
      }
      for (const ch of c.children) ch.updateMatrixWorld(true);
    }
  }
  // the camera: at the origin, turned like everything on its own face (not at all). Once the view is partly round it is aimed
  // along the facing as drawn: the grid direction flat, the true direction on the sphere round (the two differ where the grid is
  // skewed, near the cube corners), mixed by k. Off-planet it looks straight down at the planet's centre with the facing (north)
  // at the top of the screen.
  camera.matrixWorld.multiplyMatrices(L[f], camera.matrix);
  if (k > 0 || s.offPlanet) aimCamera(camera, fr);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  for (const ch of camera.children) ch.updateMatrixWorld(true);
  drawAxis(scene);
  scene.autoUpdate = false;
  live = true;
};
// Fog, clip planes and the far view by height (the prototype's setupView). Near the ground sky.js's fog stands. From ALT0 up the
// fog is pushed out towards the horizon (sqrt(h (2R + h))) and, high up, away entirely; the near plane grows with height so depth
// precision holds, and the far plane reaches the horizon once the view is round.
const lerpLog = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
function setupClip(scene, camera) {
  const s = state, h = Math.max(0, s.eyeY - BF.SEA), above = Math.max(0, s.above);
  const horizon = Math.sqrt(h * (2 * BF.planet.R + h)), r = ((BF.world && BF.world.viewDist) || 6) * 16;
  const kf = smooth(ALT0, ALT0 + 500, above);
  if (kf > 0 && scene.fog && !(BF.player && BF.player.headInWater)) {
    // (from where sky.js leaves it: past the distant rings once they are built, so climbing through ALT0 never pulls the fog in)
    const low = Math.max(r, BF.lod && BF.lod.radius ? BF.lod.radius() : 0) * 0.95 + above;
    const far = lerpLog(low, Math.max(low, horizon * 1.25 + 1), kf) * (1 + 1e4 * smooth(ALT1, 4 * ALT1, above));
    scene.fog.far = far; scene.fog.near = far * (0.58 - 0.18 * kf);
  }
  const near = Math.max(0.05, Math.min(500, (above - 200) * 0.01));
  // the far plane: past the fog low down; the loaded area or, once round, the horizon (never the fog's far, which runs off to
  // nearly infinity high up, where it would ruin depth precision)
  const want = s.k > 0 ? Math.max(r * 1.6 + 400 + above, horizon * 1.2 + 2000) : Math.max(scene.fog ? scene.fog.far + 64 : 1000, r * 1.6 + 400 + above);
  if (Math.abs(camera.near - near) > 1e-6 || Math.abs(camera.far - want) > 1) { camera.near = near; camera.far = want; camera.updateProjectionMatrix(); }
}

// Off-planet mode: a thin red line along the planet's axis, 1.25 R out past each pole (drawn straight in render space).
let axis = null;
function drawAxis(scene) {
  const s = state;
  if (!s.offPlanet) { if (axis) axis.visible = false; return; }
  if (!axis) {
    axis = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff2a2a, fog: false }));
    axis.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    axis.frustumCulled = false; axis.userData.renderSpace = true; axis.matrixAutoUpdate = false;
    scene.add(axis);
    axis.updateMatrixWorld(true);
  }
  axis.visible = true;
  const M = s.M, e = s.eye, a = axis.geometry.attributes.position, R = BF.planet.R;
  [1.25, -1.25].forEach((q, i) => {
    const dx = -e[0], dy = q * R - e[1], dz = -e[2];
    a.array[i * 3] = M[0] * dx + M[1] * dy + M[2] * dz;
    a.array[i * 3 + 1] = M[3] * dx + M[4] * dy + M[5] * dz;
    a.array[i * 3 + 2] = M[6] * dx + M[7] * dy + M[8] * dz;
  });
  a.needsUpdate = true;
}
view.axis = () => axis;

const v3a = typeof THREE !== "undefined" ? new THREE.Vector3() : null, v3b = v3a && new THREE.Vector3();
function aimCamera(camera, fr) {
  const s = state, k = s.k, M = s.M, yaw = BF.player.yaw, pitch = BF.player.pitch;
  const du = -Math.sin(yaw), dv = -Math.cos(yaw);
  // the facing on the sphere: grid step (du, dv) in the tangent plane, then into render space
  const up = fr.up, h = [fr.eu[0] * du + fr.ev[0] * dv, fr.eu[1] * du + fr.ev[1] * dv, fr.eu[2] * du + fr.ev[2] * dv];
  const hd = h[0] * up[0] + h[1] * up[1] + h[2] * up[2];
  h[0] -= up[0] * hd; h[1] -= up[1] * hd; h[2] -= up[2] * hd;
  const sx = M[0] * h[0] + M[1] * h[1] + M[2] * h[2], sz = M[6] * h[0] + M[7] * h[1] + M[8] * h[2], sl = Math.hypot(sx, sz) || 1;
  let fx = du + (sx / sl - du) * k, fz = dv + (sz / sl - dv) * k;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const e = camera.matrixWorld.elements, px = e[12], py = e[13], pz = e[14];
  if (s.offPlanet) {
    camera.up.set(fx, 0, fz);
    v3a.set(px, py - 1, pz);
  } else {
    camera.up.set(0, 1, 0);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    v3a.set(px + fx * cp, py + sp, pz + fz * cp);
  }
  tmpM.lookAt(v3b.set(px, py, pz), v3a, camera.up);
  camera.matrixWorld.extractRotation(tmpM);
  e[12] = px; e[13] = py; e[14] = pz;
  camera.up.set(0, 1, 0);
}
view.end = function () {
  if (!live) return;
  live = false;
  sceneRef.autoUpdate = true;
  for (const c of hidden) c.visible = true;
  hidden = [];
  cameraRef.updateMatrixWorld(true);   // back to atlas coordinates for anything that reads it between frames
};
})();
