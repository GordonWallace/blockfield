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
// - Even detail from planet height (Gordon, 1.6): a ring's cells grow with the distance along the ground, but from high up everything
//   in view is about as far away as the ground straight below, so the land round the middle and out to the rim was drawn several times
//   coarser than the middle. From FINE_PRE blocks up each tile in view is split in four (twice the detail, down to a cell every 32
//   blocks, FINE_LEVELS levels) while its cells are wider than PX pixels on screen (see wide()); the four are sampled by the same workers on demand and take the tile's place once all of them are built, and are dropped
//   again a while after the view has left them. From FINE_ON up, once the finer tiles in view are built, the rings whose cells are
//   wider than PX pixels straight below are left to the globe (BF.lod.cap): what stays is the ring or two straight below that are as fine
//   as the globe round them.
//
// API: BF.globe = { reset(scene), update(), tiles, built, hidden, fine, stats() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const T = 64, TILES = 10, CELLS = T * TILES;   // cells per tile edge, tiles per face edge, cells per face edge
const n = T + 5;                               // samples across a tile: its T + 1 vertices and two more each side
const PEAK = 300;                              // blocks: how high a mountain past the horizon can still show over it
const FINE_LEVELS = 3;                         // levels of finer tiles: cells of 128, 64 and 32 blocks
const PX = 2;                                  // a tile is split while its cells are wider than this many pixels on screen
const PX_SCALE = 800;                          // ... counted on a screen no finer than this many pixels per radian (a 1200-line window)
const FLAT = 0.44;                             // ... and up to 1 / sqrt(FLAT) = 1.5 times wider where the ground is seen at a slant
const KEEP = 0.85;                             // ... and joined again once they are narrower than this share of that (no flicker between)
const FINE_PRE = 13000, FINE_ON = 16000;       // blocks above the ground: finer tiles are built from the first, and take over from the second
const DROP_MS = 10000, MAX_FINE = 900;         // finer tiles out of use this long are dropped (at once, oldest first, beyond MAX_FINE)

const globe = (BF.globe = { tiles: [], built: 0, active: false, scene: null, t0: 0, doneMs: 0, fine: true, fineBuilt: 0, missing: 0 });

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
  for (const t of globe.tiles) drop(t, true);
  if (BF.sampler) BF.sampler.cancel(globe);
  globe.tiles = []; globe.built = 0; globe.doneMs = 0; globe.fineBuilt = 0; globe.missing = 0;
  if (BF.lod) BF.lod.cap = Infinity;
  globe.active = !!(BF.lod && BF.lod.active);   // no workers, no distant terrain: no globe either (in-page sampling would take many minutes)
  if (!globe.active) return;
  if (!idx) idx = index(null);
  globe.t0 = performance.now();
  for (let f = 0; f < 6; f++) for (let tj = 0; tj < TILES; tj++) for (let ti = 0; ti < TILES; ti++) {
    const tile = make(f, 0, ti, tj);
    globe.tiles.push(tile);
    request(tile);
  }
};
// The tile at (ti, tj) of face f, lv levels finer than the planet-scale tiles: (TILES << lv) tiles along a face edge, each T x T cells.
function make(f, lv, ti, tj) {
  const P = BF.planet, E = TILES << lv, CELL = P.N / (E * T);
  const cu = (ti + 0.5) * T * CELL, cv = (tj + 0.5) * T * CELL, d = [0, 0, 0], c = [0, 0, 0];
  P.dir(f, cu, cv, c);
  // the angle from the tile's centre to its farthest corner
  let radius = 0;
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    P.dir(f, (ti + a) * T * CELL, (tj + b) * T * CELL, d);
    radius = Math.max(radius, Math.acos(Math.min(1, d[0] * c[0] + d[1] * c[1] + d[2] * c[2])));
  }
  return { f, lv, ti, tj, c: CELL, cu, cv, dir: c.slice(), radius: radius * 1.02, mesh: null, corner: (ti === 0 || ti === E - 1) && (tj === 0 || tj === E - 1),
    kids: null, req: false, dead: false, live: false, split: false, used: 0, px: 0 };
}
// Takes a tile's finer tiles away (and the tile itself with all): their meshes, and their jobs still waiting.
function drop(t, all) {
  if (t.kids) { for (const k of t.kids) drop(k, true); t.kids = null; }
  if (!all) return;
  t.dead = true; t.live = false;
  if (t.mesh) { dispose(t.mesh); t.mesh = null; if (t.lv) globe.fineBuilt--; }
}
function dispose(m) {
  if (m.parent) m.parent.remove(m);
  m.geometry.dispose(); m.material.dispose();
}

// the eye's direction from the planet's centre and its distance (planet units), for priorities and the horizon
const eye = [0, 0, 0];
let eyeR = 0;
function where() {
  const P = BF.planet, p = BF.player && (BF.player.viewPos ? BF.player.viewPos() : BF.player.position);   // (the detached view's, r15-98)
  if (!p) return false;
  const g = P.grid(p.x, p.z);
  if (g.f < 0) return false;
  P.pos(g.f, g.u, g.v, p.y, eye);
  eyeR = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  return true;
}
const angle = (t) => Math.acos(Math.max(-1, Math.min(1, (eye[0] * t.dir[0] + eye[1] * t.dir[1] + eye[2] * t.dir[2]) / eyeR)));

function request(tile) {
  const P = BF.planet, f = tile.f, CELL = tile.c, u0 = (tile.ti * T - 2) * CELL, v0 = (tile.tj * T - 2) * CELL;
  const job = { f, u0, v0, cell: CELL, nx: n, ny: n };
  tile.req = true;
  // after the rings (their priorities are below 10), nearest the player first; the finer tiles after the planet-scale ones, coarser first
  const first = () => (tile.lv ? 11 + tile.lv : 10) + angle(tile) / 4, then = () => 9 + angle(tile) / 4;
  first.tile = then.tile = tile;   // (for sweep())
  BF.sampler.request(job, first, (raw) => {
    if (tile.dead) return;
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
    BF.sampler.request({ mesh: true, p, raw }, then, (m) => finish(tile, anchor, m, own), globe);
  }, globe);
}

function free() { if (this.array !== idx.array) this.array = null; }
function finish(tile, anchor, m, own) {
  if (!globe.active || tile.dead) return;   // from before a reset, or dropped since
  tile.req = false;
  const P = BF.planet, g = new THREE.BufferGeometry();
  const attr = (a, k, norm) => { const x = new THREE.BufferAttribute(a, k, !!norm); x.onUpload(free); return x; };
  g.setAttribute("position", attr(m.pos, 3));
  g.setAttribute("sphere", attr(m.sph, 3));
  g.setAttribute("col", attr(m.col, 3, true));
  g.setAttribute("canopy", attr(m.can, 4, true));
  g.setIndex(own || idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), T * tile.c + 4000);
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
  if (tile.lv) globe.fineBuilt++;
  else if (++globe.built === globe.tiles.length) globe.doneMs = performance.now() - globe.t0;
}

// Called as each frame is drawn (a js/view.js begin hook, so with the player where the camera is and the rings as they are now): shows
// the globe once the view is partly round, hides tiles past the horizon, and sets the cuts.
const ID = { A: [1, 0, 0, 1], t: [0, 0] };
function inRing(t, top) {
  const P = BF.planet, e = t.f === top.f ? ID : P.UNFOLD[top.f][t.f];
  if (!e) return false;
  const S = T * t.c, r = top.half - 2 * top.cell;
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const u = (t.ti + a) * S, v = (t.tj + b) * S;
    const U = e.A[0] * u + e.A[1] * v + e.t[0], W = e.A[2] * u + e.A[3] * v + e.t[1];
    if (Math.hypot(U - top.cu, W - top.cv) >= r) return false;
  }
  return true;
}
// The frame's view of the tiles: which are in view at all, which are split, and which wait for their finer tiles.
let horizon = 0, now = 0, refine = false, on = false, top = null, topW = null, alt = 1, px = PX_SCALE;
const need = (t) => angle(t) < horizon + t.radius && !(topW && !t.corner && inRing(t, topW));
// Whether tile t's cells are too wide for where it is: their width in pixels at the nearest part of the tile (never nearer than the
// eye's height). Seen at a slant a cell is as wide as ever across the view but squashed along it, so it may be wider by the square root
// of the squash (the cell covers the same number of pixels), up to 1.5 times: the rim of the planet keeps its detail.
function wide(t) {
  const P = BF.planet, R = P.R, x = eye[0] - t.dir[0] * R, y = eye[1] - t.dir[1] * R, z = eye[2] - t.dir[2] * R;
  const dc = Math.hypot(x, y, z) || 1, d = Math.max(alt, dc - t.radius * R);
  const slant = Math.max(FLAT, Math.min(1, (x * t.dir[0] + y * t.dir[1] + z * t.dir[2]) / dc + t.radius));
  t.px = t.c * px / d;
  return t.px * Math.sqrt(slant) > PX * (t.split ? KEEP : 1);
}
// Draws tile t (in view, with a mesh), or its finer tiles in its place once every one of them in view is built.
function show(t) {
  t.used = now; t.live = true;
  let split = refine && t.lv < FINE_LEVELS && wide(t);
  t.split = split;
  if (split) {
    if (!t.kids) { t.kids = []; for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) t.kids.push(make(t.f, t.lv + 1, 2 * t.ti + a, 2 * t.tj + b)); }
    for (const k of t.kids) {
      k.used = now;
      if (k.mesh || !need(k)) continue;
      split = false;
      if (!k.req) request(k);
    }
    if (!split) globe.missing++;
  }
  if (split) {
    t.mesh.visible = false;
    for (const k of t.kids) if (k.mesh && need(k)) show(k); else hide(k);
    return;
  }
  if (t.kids) for (const k of t.kids) hide(k);
  // (a tile wholly inside the coarsest ring drawn would only be cut away, pixel by pixel)
  const vis = on && !(top && top !== topW && !t.corner && inRing(t, top));
  t.mesh.visible = vis;
  if (vis) { globe.shown++; if (t.lv) globe.fineShown++; if (refine) { if (t.lv === FINE_LEVELS) wide(t); globe.maxPx = Math.max(globe.maxPx, t.px); } }
}
function hide(t) {
  if (!t.live) return;
  t.live = false;
  if (t.mesh) t.mesh.visible = false;
  if (t.kids) for (const k of t.kids) hide(k);
}
// Drops the finer tiles that have been out of use for a while (sooner when there are very many), and their jobs still in the queue.
let swept = 0;
function sweep() {
  if (now - swept < 1000) return;
  swept = now;
  const age = globe.fineBuilt > MAX_FINE ? 1000 : DROP_MS;
  let dropped = false;
  const walk = (t) => {
    if (!t.kids) return;
    let used = false;
    for (const k of t.kids) { walk(k); if (k.live || now - k.used < age || k.kids) used = true; }
    if (!used) { drop(t, false); dropped = true; }
  };
  for (const t of globe.tiles) walk(t);
  if (dropped) BF.sampler.queue = BF.sampler.queue.filter((it) => !(it.tag === globe && it.prio.tile && it.prio.tile.dead));
}
const size = new THREE.Vector2();
globe.update = function () {
  if (!globe.active) return;
  if (BF.sampler.inline && !BF.lodInline) { off(); return; }   // the workers failed: as the rings
  if (!where()) return;
  const P = BF.planet, p = (BF.player.viewPos ? BF.player.viewPos() : BF.player.position);
  const k = BF.view.kAt(p.x, p.y, p.z);
  on = k > 0 && !globe.hidden;   // hidden: for tests of the rings alone
  // the horizon from the eye, plus how far a mountain past it still shows
  const h = Math.max(eyeR, P.R);
  horizon = Math.acos(Math.min(1, P.R / h)) + Math.acos(Math.min(1, P.R / (P.R + PEAK))) + 0.01;
  alt = Math.max(1, eyeR - P.R - PEAK);
  now = performance.now();
  // the coarsest ring drawn: a tile wholly inside its disc isn't drawn at all (it would only be cut away, pixel by pixel), except a
  // face's corner tiles, which keep the strip along the ring's corner wedge. The disc is measured in its face's grid, where a tile on the
  // same face or an unfolded neighbour is a square: it is inside when its four corners are.
  const L = BF.lod, V = L.view, above = L.above || 0;
  // from planet height: the rings left to the globe are those with cells wider than PX pixels straight below (capW: the first such cell
  // size), and the finer tiles are built for the picture without them (topW: the coarsest ring that stays)
  refine = on && globe.fine && above >= FINE_PRE;
  let capW = Infinity;
  if (BF.renderer && BF.camera) px = Math.min(PX_SCALE, BF.renderer.getDrawingBufferSize(size).y / (2 * Math.tan(BF.camera.fov * Math.PI / 360)));
  if (refine) for (const R of L.levels) if (R.cell * px > PX * above) { capW = R.cell; break; }
  top = null; topW = null;
  for (const R of L.levels) if (R.mesh && R.show) { if (R.draw) top = R; if (R.cell < capW) topW = R; }
  globe.shown = 0; globe.fineShown = 0; globe.missing = 0; globe.maxPx = 0;
  for (const t of globe.tiles) {
    if (!t.mesh) continue;
    if (on && need(t)) show(t); else hide(t);
  }
  sweep();
  // the rings give way once the finer tiles that take their place are built, and come back at once
  if (capW >= L.cap || (above >= FINE_ON && globe.built === globe.tiles.length && !globe.missing)) L.cap = capW;
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
  for (const t of globe.tiles) { drop(t, false); if (t.mesh) { dispose(t.mesh); t.mesh = null; } }
  globe.built = 0;
  if (BF.lod) BF.lod.cap = Infinity;
}

if (BF.view) BF.view.onBegin(() => globe.update());

// Numbers for tests and the debug overlay.
globe.stats = () => ({ active: globe.active, tiles: globe.tiles.length, built: globe.built, shown: globe.shown || 0, doneMs: Math.round(globe.doneMs),
  fine: globe.fineBuilt, fineShown: globe.fineShown || 0, missing: globe.missing, maxPx: globe.maxPx || 0, cap: BF.lod && BF.lod.cap < Infinity ? BF.lod.cap : 0 });
})();
