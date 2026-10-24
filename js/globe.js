// The whole planet at planet scale (spec r14-06): every face as 10 x 10 tiles of 64 x 64 cells, a cell every 256 blocks (the spec's even
// planet-scale detail; the coarsest distant-terrain ring is a cell every 512, so the two overlap by two of its cells at the ring's edge, as
// the rings overlap each other). Brought over from the round-planet prototype
// (GordonWallace/blockfield-round js/globe.js); see /mnt/project-files/notes/round-planet-lessons.md.
//
// - Tiles are sampled by the distant-terrain workers (js/grid.js) from the moment a world starts, after the rings' first build, nearest the
//   player first, and meshed in a worker too, so nothing here delays entering the world or holds up a frame.
// - Each tile is a top-level scene object at its centre's atlas position with userData.anchor, so js/view.js places it like a ring; it
//   uses the rings' material (js/lod.js) and is drawn only once the view is partly round (k > 0).
// - Cuts, per pixel as for the rings: a hole where the coarsest ring drawn is (inside its disc by two cells, an overlap on the same
//   lattice), or where the loaded chunks are; the strip along the ring's corner wedge stays with the globe.
// - Tiles beyond the horizon (and a mountain's height past it) are hidden, and so are tiles wholly inside the coarsest ring's disc, so
//   lower down, where the rings reach the horizon, the globe draws nothing.
// - A tile's samples reach two cells past each edge (see index() below). The cube corner's own sample (both
//   grid coordinates past the face) has no column; it is filled from its neighbour inside, with the corner's own direction, so the three
//   faces meet at the corner with no gap (corners are open sea).
//
// API: BF.globe = { reset(scene), update(), tiles, built, hidden, stats() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const T = 64, TILES = 10, CELLS = T * TILES;   // cells per tile edge, tiles per face edge, cells per face edge
const n = T + 5;                               // samples across a tile: its T + 1 vertices and two more each side
const PEAK = 300;                              // blocks: how high a mountain past the horizon can still show over it

const globe = (BF.globe = { tiles: [], built: 0, active: false, scene: null, t0: 0, doneMs: 0 });

// A tile draws its own T x T cells and the first cell of each neighbouring tile too, the same samples as that tile's, so tiles overlap
// by a cell and no pixel slips through between two meshes (their vertices, worked out from different anchors, differ in the last bits).
// The samples one further out are only for shading the overlap as its own tile shades it.
let idx = null;     // the shared index: cells 1 to T + 2 of an n x n grid, split as the rings split theirs
function index(ok) {
  const q = [];
  for (let j = 1; j <= T + 2; j++) for (let i = 1; i <= T + 2; i++) {
    const a = j * n + i;
    if (ok && !(ok[a] && ok[a + 1] && ok[a + n] && ok[a + n + 1])) continue;   // past a cube corner
    q.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
  }
  return new THREE.BufferAttribute(new Uint32Array(q), 1);
}
// one set of cut uniforms for every tile (each tile keeps its own sphM and anchor)
let cutU = null;
const CUTS = ["hole", "hole2", "outer", "seam2", "toHole", "toHole2"];

globe.reset = function (scene) {
  globe.scene = scene || globe.scene;
  for (const t of globe.tiles) if (t.mesh) dispose(t.mesh);
  if (BF.sampler) BF.sampler.cancel(globe);
  globe.tiles = []; globe.built = 0; globe.doneMs = 0;
  globe.active = !!(BF.lod && BF.lod.active);   // no workers, no distant terrain: no globe either (in-page sampling would take many minutes)
  if (!globe.active) return;
  if (!idx) idx = index(null);
  globe.t0 = performance.now();
  const P = BF.planet, CELL = P.N / CELLS;
  for (let f = 0; f < 6; f++) for (let tj = 0; tj < TILES; tj++) for (let ti = 0; ti < TILES; ti++) {
    const cu = (ti + 0.5) * T * CELL, cv = (tj + 0.5) * T * CELL, d = [0, 0, 0], c = [0, 0, 0];
    P.dir(f, cu, cv, c);
    // the angle from the tile's centre to its farthest corner
    let radius = 0;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      P.dir(f, (ti + a) * T * CELL, (tj + b) * T * CELL, d);
      radius = Math.max(radius, Math.acos(Math.min(1, d[0] * c[0] + d[1] * c[1] + d[2] * c[2])));
    }
    const tile = { f, ti, tj, cu, cv, dir: c.slice(), radius: radius * 1.02, mesh: null, corner: (ti === 0 || ti === TILES - 1) && (tj === 0 || tj === TILES - 1) };
    globe.tiles.push(tile);
    request(tile, CELL);
  }
};
function dispose(m) {
  if (m.parent) m.parent.remove(m);
  m.geometry.dispose(); m.material.dispose();
}

// the eye's direction from the planet's centre and its distance (planet units), for priorities and the horizon
const eye = [0, 0, 0];
let eyeR = 0;
function where() {
  const P = BF.planet, p = BF.player && BF.player.position;
  if (!p) return false;
  const g = P.grid(p.x, p.z);
  if (g.f < 0) return false;
  P.pos(g.f, g.u, g.v, p.y, eye);
  eyeR = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  return true;
}
const angle = (t) => Math.acos(Math.max(-1, Math.min(1, (eye[0] * t.dir[0] + eye[1] * t.dir[1] + eye[2] * t.dir[2]) / eyeR)));

function request(tile, CELL) {
  const P = BF.planet, f = tile.f, u0 = (tile.ti * T - 2) * CELL, v0 = (tile.tj * T - 2) * CELL;
  const job = { f, u0, v0, cell: CELL, nx: n, ny: n };
  // after the rings (their priorities are below 10), nearest the player first
  BF.sampler.request(job, () => 10 + angle(tile), (raw) => {
    // the cube corner's own sample: from its neighbour inside, at the corner's direction
    const N = P.N, d = [0, 0, 0];
    let full = true;
    for (let j = 2; j <= T + 2; j++) for (let i = 2; i <= T + 2; i++) {
      const o = j * n + i;
      if (raw.ok[o]) continue;
      const q = (j - 1) * n + i - 1, u = Math.min(N, Math.max(0, u0 + i * CELL)), v = Math.min(N, Math.max(0, v0 + j * CELL));
      P.dir(f, u, v, d);
      const l = Math.hypot(d[0], d[1], d[2]);
      raw.y[o] = raw.y[q]; raw.ok[o] = 1;
      for (let k = 0; k < 3; k++) { raw.col[3 * o + k] = raw.col[3 * q + k]; raw.dir[3 * o + k] = d[k] / l; }
      for (let k = 0; k < 4; k++) raw.can[4 * o + k] = raw.can[4 * q + k];
    }
    for (let j = 1; j <= T + 3 && full; j++) for (let i = 1; i <= T + 3; i++) if (!raw.ok[j * n + i]) { full = false; break; }
    const own = full ? null : index(raw.ok.slice());
    const anchor = P.pos(f, tile.cu, tile.cv, BF.SEA, [0, 0, 0]);
    const p = { n, c: CELL, gu0: u0, gv0: v0, cu: tile.cu, cv: tile.cv, anchor, noMorph: true };
    BF.sampler.request({ mesh: true, p, raw }, () => 9 + angle(tile), (m) => finish(tile, anchor, m, own), globe);
  }, globe);
}

function free() { if (this.array !== idx.array) this.array = null; }
function finish(tile, anchor, m, own) {
  if (!globe.active || globe.tiles.indexOf(tile) < 0) return;   // from before a reset
  const P = BF.planet, g = new THREE.BufferGeometry();
  const attr = (a, k, norm) => { const x = new THREE.BufferAttribute(a, k, !!norm); x.onUpload(free); return x; };
  g.setAttribute("position", attr(m.pos, 3));
  g.setAttribute("sphere", attr(m.sph, 3));
  g.setAttribute("col", attr(m.col, 3, true));
  g.setAttribute("canopy", attr(m.can, 4, true));
  g.setIndex(own || idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), T * P.N / CELLS + 4000);
  const mat = BF.lod.material(false);
  if (!cutU) { cutU = {}; for (const k of CUTS) cutU[k] = mat.uniforms[k]; }
  else for (const k of CUTS) mat.uniforms[k] = cutU[k];
  mat.uniforms.anchor.value.set(anchor[0], anchor[1], anchor[2]);
  const mesh = new THREE.Mesh(g, mat);
  const a = P.atlas(tile.f, tile.cu, tile.cv);
  mesh.matrixAutoUpdate = false;
  mesh.position.set(a.x, 0, a.z); mesh.updateMatrix();
  mesh.userData = { anchor, globe: true };
  mesh.visible = false;   // update() shows it
  tile.mesh = mesh;
  globe.scene.add(mesh);
  if (++globe.built === globe.tiles.length) globe.doneMs = performance.now() - globe.t0;
}

// Called as each frame is drawn (a js/view.js begin hook, so with the player where the camera is and the rings as they are now): shows
// the globe once the view is partly round, hides tiles past the horizon, and sets the cuts.
const ID = { A: [1, 0, 0, 1], t: [0, 0] };
function inRing(t, top) {
  const P = BF.planet, e = t.f === top.f ? ID : P.UNFOLD[top.f][t.f];
  if (!e) return false;
  const S = T * P.N / CELLS, r = top.half - 2 * top.cell;
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const u = (t.ti + a) * S, v = (t.tj + b) * S;
    const U = e.A[0] * u + e.A[1] * v + e.t[0], W = e.A[2] * u + e.A[3] * v + e.t[1];
    if (Math.hypot(U - top.cu, W - top.cv) >= r) return false;
  }
  return true;
}
globe.update = function () {
  if (!globe.active) return;
  if (BF.sampler.inline && !BF.lodInline) { off(); return; }   // the workers failed: as the rings
  if (!where()) return;
  const P = BF.planet, p = BF.player.position;
  const k = BF.view.kAt(p.x, p.y, p.z), on = k > 0 && !globe.hidden;   // hidden: for tests of the rings alone
  // the horizon from the eye, plus how far a mountain past it still shows
  const h = Math.max(eyeR, P.R), horizon = Math.acos(Math.min(1, P.R / h)) + Math.acos(Math.min(1, P.R / (P.R + PEAK))) + 0.01;
  // the coarsest ring drawn: a tile wholly inside its disc isn't drawn at all (it would only be cut away, pixel by pixel), except a
  // face's corner tiles, which keep the strip along the ring's corner wedge. The disc is measured in its face's grid, where a tile on the
  // same face or an unfolded neighbour is a square: it is inside when its four corners are.
  const L = BF.lod, V = L.view;
  let top = null;
  for (const R of L.levels) if (R.mesh && R.show) top = R;
  globe.shown = 0;
  for (const t of globe.tiles) {
    if (!t.mesh) continue;
    let vis = on && angle(t) < horizon + t.radius;
    if (vis && top && !t.corner && inRing(t, top)) vis = false;
    t.mesh.visible = vis;
    if (vis) globe.shown++;
  }
  if (!on || !cutU) return;
  // the hole: the coarsest ring drawn, or else the loaded chunks
  L.cuts(cutU, V, L.eyeHole, top);
  if (top) cutU.hole2.value.z = top.half - 2 * top.cell;
  // (cuts() leaves the globe a strip along the ring's corner wedge, also for the coarsest ring: its own bridge across the wedge, made in
  // the flat grid, can leave a pixel open in the round view)
  cutU.outer.value.set(0, 0, 0);
};
function off() {
  globe.active = false;
  for (const t of globe.tiles) if (t.mesh) { dispose(t.mesh); t.mesh = null; }
  globe.built = 0;
}

if (BF.view) BF.view.onBegin(() => globe.update());

// Numbers for tests and the debug overlay.
globe.stats = () => ({ active: globe.active, tiles: globe.tiles.length, built: globe.built, shown: globe.shown || 0, doneMs: Math.round(globe.doneMs) });
})();
