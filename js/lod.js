// Distant terrain on the planet (spec r14-05): rings of height-field meshes around the player, each twice as coarse as the last, so the
// land beyond the loaded chunks shows its true shape and colours out to the horizon, at every height. Brought over from the round-planet
// prototype (GordonWallace/blockfield-round js/lod.js); see /mnt/project-files/notes/round-planet-lessons.md sections 6 and 8.
//
// - Eight rings have a cell every 4, 8, 16, ... 512 blocks, each reaching HALF = 128 cells from its own centre (its mesh reaches 136,
//   so moving rings and morph targets always have samples): ring 0 reaches 512 blocks and ring 7 65 km. A cell is 1/64 to 1/128 of
//   its distance, so every ring's cells are under 15 pixels across on a 1080p screen (r14-07 halved HALF from the 256 of r14-05: 4.1
//   million triangles took most of the frame in software rendering; now about 0.8 million, fewer once the covered middles are skipped).
// - Only the cells within a ring's disc are indexed, nearest the centre first, and the middle that the finer ring or the loaded chunks
//   certainly cover is skipped (covered()); the per-pixel cuts below do the rest.
// - From 10x fast-forward rings that are built aren't moved (the frame goes to the simulation).
// - Each ring is drawn as a disc around its own centre, minus the next finer ring's disc and the loaded chunks' disc, so a ring still
//   being rebuilt never leaves a gap: the coarser one shows there instead. The cuts are measured per pixel: the fragment shader finds the
//   pixel's own face and grid position from its direction and maps it into the grid each cut belongs to (CHARTS below). Near a cube
//   corner unfolding depends on the route round the corner, and cuts measured in each mesh's own grid left black slivers there.
// - Along a finer ring's corner wedge (where its grid has no samples) and round the corner point, the next coarser ring keeps drawing
//   in a strip 2 x cell + 8 blocks wide; strips nest down to the coarsest ring.
// - Across 60 to 95% of its radius each vertex moves to where the next coarser ring puts it (MORPH), so detail fades instead of stepping.
// - A ring is rebuilt once the player is a fifth of its radius from its centre, reusing the samples still inside (keep), and isn't moved
//   while the player outruns it. It is hidden once its cells are about two pixels across from straight above (altitude > 1,500 x cell).
// - Colours are the blocks' own (js/grid.js), with the canopy colour of the area's trees over the ground where trees grow.
// - Rivers: drawn as ribbons along their curves once the planet has a river network (r14-10; see ribbons()).
// Each ring is a top-level scene object at its centre's atlas position with userData.anchor, so js/view.js places it like a chunk mesh
// (its face's unfold near the ground, the sphere by world.roundK); the shader mixes flat and round positions the same way.
//
// API: BF.lod = { reset(scene), update(), radius(), levels, stats() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const CELLS = [4, 8, 16, 32, 64, 128, 256, 512];
const HALF = 128, EXT = 136;   // cells from a ring's centre to the edge of its disc, and of its mesh
const HIDE = 1500;             // a ring is hidden above this many times its cell size (its cells are then about 2 pixels)
const MOVE = 0.2;              // a ring is rebuilt once the player is this fraction of its radius from its centre
const HOLE = 0.97, MORPH0 = 0.6, MORPH1 = 0.95;   // fractions of a ring's radius
const RIBBON_HIDE = 9000, MINW = 3;   // river ribbons: hidden above this height; half-width at least this
const STAND_LEVELS = 6;        // rings with tree and building stand-ins (cells of 4 to 128 blocks)
const STAND_MAX = 14000;       // blocks from the player: stand-ins further out are never shown (a 10-block patch is under a pixel on any
                               // screen up to 4K), so none are made past that plus how far a ring moves (MOVE)
const BOX_LEVELS = 1;          // of those, the ones drawn as boxes (the rest as points)
const THIN = [0, 1, 2, 3, 4, 5];   // ring by ring: one tree cell kept in each square of 2^m x 2^m (js/grid.js): each ring draws about as many
                                   // stand-ins as the last (the ground's canopy colour stands in for the rest)
const HOUSE_LEVELS = 5;        // rings with village buildings, out to 8 km (beyond, a building is under a pixel before the ring starts)
const pxScale = { value: 900 };   // pixels per radian at the middle of the screen: drawing-buffer height / (2 tan(fov / 2))

const lod = (BF.lod = { EXT, THIN, levels: [], active: false, eyeHole: 0, ribbon: null, scene: null, view: { f: 0, u: 0, v: 0 }, standIns: true });

// ---- materials ----
const P = () => BF.planet;
const VERT = `
attribute vec3 sphere;
attribute vec3 col;
attribute vec3 mflat;
attribute vec3 msph;
attribute vec3 mcol;
attribute vec4 canopy;
uniform mat4 sphM;
uniform float uK;
uniform vec2 morph;    // distances from the ring's centre (in its grid) where morphing starts and ends
uniform vec3 anchor;   // what sphere positions are relative to
varying vec3 vColor;
varying vec4 vCanopy;
varying vec3 vP;       // position relative to the planet's centre
varying vec2 vG;       // grid position relative to the ring's centre
varying float vDist;
#include <fog_pars_vertex>
void main() {
  vec3 a = position, s = sphere, c = col;
#ifdef MORPH
  float m = smoothstep(morph.x, morph.y, length(position.xz));
  if (m > 0.0) { a = mix(a, mflat, m); s = mix(s, msph, m); c = mix(c, mcol, m); }
#endif
  vP = anchor + s;
  vG = position.xz;
  vec3 t = a;
  if (uK > 0.0) t = mix(a, (sphM * vec4(s, 1.0)).xyz, uK);
  vec4 mvPosition = modelViewMatrix * vec4(t, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vColor = c;
  vCanopy = canopy;
  vDist = length(mvPosition.xyz);
#include <fog_vertex>
}`;
const FRAG = `
uniform vec3 hole;     // the loaded chunks' disc: centre (view face grid) and radius
uniform vec3 hole2;    // the next finer ring's disc: centre (its grid) and radius
uniform vec3 outer;    // this ring's own disc (its grid, relative to its centre)
uniform float uDay;
uniform vec3 faceN[6];
uniform vec3 faceA[6];
uniform vec3 faceB[6];
uniform mat3 toHole[6];
uniform mat3 toHole2[6];
uniform float seam2;   // width of the strip along the finer ring's corner wedge that it leaves to this ring
uniform float stand;   // the share of tree cells this ring draws as stand-ins (0: none)
uniform vec2 edge;     // stand-ins fade out between these distances from the ring's centre (the last ring that has them)
uniform float pxScale;
varying vec3 vColor;
varying vec4 vCanopy;
varying vec3 vP;
varying vec2 vG;
varying float vDist;
// how far stand-ins show at distance d: fully while a 10-block patch is 2 pixels or more, not at all from 1 pixel
#define NEAR(d) clamp(10.0 * pxScale / (d) - 1.0, 0.0, 1.0)
#include <fog_pars_fragment>
void main() {
  // this pixel's own face and grid position (as BF.planet.fromDir), then mapped into each cut's grid
  float best = -2.0;
  int fi = 0;
  vec3 fa = faceA[0], fb = faceB[0];
  for (int i = 0; i < 6; i++) {
    float c = dot(vP, faceN[i]);
    if (c > best) { best = c; fi = i; fa = faceA[i]; fb = faceB[i]; }
  }
  vec3 g = vec3((vec2(atan(dot(vP, fa) / best), atan(dot(vP, fb) / best)) / 0.7853981633974483 + 1.0) * (FACE_N * 0.5), 1.0);
  vec2 gh = vec2(1e9), gh2 = vec2(1e9);
  for (int i = 0; i < 6; i++) if (i == fi) { gh = (toHole[i] * g).xy; gh2 = (toHole2[i] * g).xy; }
  bool inner = hole2.z > 0.0 && length(gh2 - hole2.xy) < hole2.z;
  // the finer ring can't join the two faces beyond a cube corner of its grid: the strip along its wedge and round the corner is left here
  bool nu = gh2.x < seam2 || gh2.x > FACE_N - seam2, nv = gh2.y < seam2 || gh2.y > FACE_N - seam2;
  if (nu && nv) inner = false;
  bool eye = hole.z > 0.0 && length(gh - hole.xy) < hole.z;
  if (eye || inner || (outer.z > 0.0 && length(vG - outer.xy) > outer.z)) discard;
  // tree crowns: the canopy's colour over the share of ground it covers, giving way to the stand-ins where they show (each ring draws
  // a share of the trees); daylight as on an open-sky block
  float a = vCanopy.a * (1.0 - stand * NEAR(vDist) * (1.0 - smoothstep(edge.x, edge.y, length(vG))));
  vec3 col = mix(vColor, vCanopy.rgb, a) * max(0.1, uDay);
  gl_FragColor = vec4(col, 1.0);
#include <fog_fragment>
}`;
let shared = null;
function material(morph) {
  const Pl = P();
  if (!shared) {
    shared = {
      faceN: { value: Pl.FACES.map((F) => new THREE.Vector3(...F.n)) },
      faceA: { value: Pl.FACES.map((F) => new THREE.Vector3(...F.a)) },
      faceB: { value: Pl.FACES.map((F) => new THREE.Vector3(...F.b)) },
    };
  }
  const sphM = new THREE.Matrix4();
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, fog: true,
    defines: Object.assign({ FACE_N: Pl.N.toFixed(1) }, morph ? { MORPH: 1 } : {}),
    uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), shared, {
      sphM: { value: sphM }, uK: BF.world.roundK, uDay: BF.world.dayUniform,
      morph: { value: new THREE.Vector2(1e30, 2e30) }, anchor: { value: new THREE.Vector3() },
      hole: { value: new THREE.Vector3() }, hole2: { value: new THREE.Vector3() }, outer: { value: new THREE.Vector3() }, seam2: { value: 0 },
      toHole: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Matrix3()) }, toHole2: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Matrix3()) },
      stand: { value: 0 }, edge: { value: new THREE.Vector2(1e30, 2e30) }, pxScale,
    }),
  });
  m.userData.sphM = sphM;   // js/view.js sets it each frame (the round placement in the mesh's own frame)
  return m;
}

// Stand-ins for trees and buildings (js/grid.js stand()): instanced, one per tree or building, as two boxes (BOXES: trunk and crown, or
// walls and roof; position is a corner of a unit box) or as one square point the crown's size. Each is placed at its foot (base: flat, in
// the ring's grid relative to its centre; sph: round, relative to its anchor) and built out along the grid axes there (frame: grid u, up
// and grid v as planet-space vectors at the ring's centre, close enough across a ring). Cut like the ring's ground (whole stand-ins: by
// their foot), so they never show over the loaded chunks or the finer ring.
const STAND_VERT = `
attribute vec3 base;
attribute vec3 sph;
attribute vec3 top;
attribute vec3 low;
attribute vec4 a;   // trunk width x, z, height, crown top width (of 255, of the crown's width)
attribute vec4 b;   // crown width x, z, height, random byte
attribute float c;  // crown bottom
#ifdef BOXES
attribute float part;
attribute float shade;
#endif
uniform mat4 sphM;
uniform mat3 frame;
uniform float uK;
uniform float pxScale;
uniform vec2 edge;
uniform vec3 hole;
uniform vec3 hole2;
uniform vec3 outer;
uniform vec2 centre;   // the ring's centre in its face's grid
uniform mat3 toHole;   // the ring's face grid into the view face's (the loaded chunks' disc)
uniform mat3 toHole2;  // into the finer ring's face
uniform float seam2;
varying vec3 vColor;
#include <fog_pars_vertex>
#define NEAR(d) clamp(10.0 * pxScale / (d) - 1.0, 0.0, 1.0)
void main() {
#ifndef BOXES
  gl_PointSize = 1.0;   // dropped points still need a size, or some drivers draw them huge
#endif
  vec3 g = vec3(base.xz + centre, 1.0);
  vec2 gh = (toHole * g).xy, gh2 = (toHole2 * g).xy;
  bool inner = hole2.z > 0.0 && length(gh2 - hole2.xy) < hole2.z;
  bool nu = gh2.x < seam2 || gh2.x > FACE_N - seam2, nv = gh2.y < seam2 || gh2.y > FACE_N - seam2;
  if (nu && nv) inner = false;
  if (inner || (hole.z > 0.0 && length(gh - hole.xy) < hole.z) || length(base.xz - outer.xy) > outer.z) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 w0 = base;
  if (uK > 0.0) w0 = mix(base, (sphM * vec4(sph, 1.0)).xyz, uK);
  float d = length((modelViewMatrix * vec4(w0, 1.0)).xyz);
  // shown while a 10-block patch is a pixel or more (the ground's canopy colour takes over beyond, and across the outer part of the last
  // ring with stand-ins); smaller than a pixel, drawn as one pixel by a share of them that keeps the covered area right. The random byte
  // decides which ones, so no line follows the player.
  float px = max(max(b.x, b.y), max(a.x, a.y)) * pxScale / d;
  float show = NEAR(d) * (1.0 - smoothstep(edge.x, edge.y, length(base.xz))) * min(1.0, px * px);
  if (b.w >= 256.0 * show) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
#ifndef BOXES
  // a point this big belongs to a finer ring still being built (the boxes come with it): not drawn meanwhile
  if (px > 24.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
#endif
#ifdef BOXES
  bool up = part > 0.5;
  vec2 wd = up ? b.xy * mix(1.0, a.w / 255.0, position.y) : a.xy;
  vec3 l = vec3(position.x * wd.x, up ? c + position.y * b.z : position.y * a.z, position.z * wd.y);
  vColor = (up ? top : low) * shade;
#else
  vec3 l = vec3(0.0, b.z > 0.0 ? c + 0.5 * b.z : 0.5 * a.z, 0.0);
  vColor = (b.x > 0.0 ? top : low) * 0.85;
  gl_PointSize = max(px, 1.0);
#endif
  vec3 t = base + l;
  if (uK > 0.0) t = mix(t, (sphM * vec4(sph + frame * l, 1.0)).xyz, uK);
  vec4 mvPosition = modelViewMatrix * vec4(t, 1.0);
  gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`;
const STAND_FRAG = `
uniform float uDay;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4(vColor * max(0.1, uDay), 1.0);
#include <fog_fragment>
}`;
function standMaterial(boxes) {
  const sphM = new THREE.Matrix4();
  const m = new THREE.ShaderMaterial({
    vertexShader: STAND_VERT, fragmentShader: STAND_FRAG, fog: true,
    defines: Object.assign({ FACE_N: P().N.toFixed(1) }, boxes ? { BOXES: 1 } : {}),
    uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
      sphM: { value: sphM }, uK: BF.world.roundK, uDay: BF.world.dayUniform, pxScale, frame: { value: new THREE.Matrix3() },
      edge: { value: new THREE.Vector2(1e30, 2e30) }, hole: { value: new THREE.Vector3() }, hole2: { value: new THREE.Vector3() },
      outer: { value: new THREE.Vector3() }, centre: { value: new THREE.Vector2() }, toHole: { value: new THREE.Matrix3() },
      toHole2: { value: new THREE.Matrix3() }, seam2: { value: 0 },
    }),
  });
  m.userData.sphM = sphM;
  return m;
}
// A unit box's top and sides, twice (part 0: trunk or walls; part 1: crown or roof), each face shaded as the blocks' faces are; corners at
// x, z = -0.5 or 0.5 and y = 0 or 1.
let BOX = null;
function box() {
  if (BOX) return BOX;
  const pos = [], part = [], shade = [], idx = [];
  const face = (q, s, pt) => { const n = pos.length / 3; for (const v of q) pos.push(...v); for (let i = 0; i < 4; i++) { part.push(pt); shade.push(s); } idx.push(n, n + 1, n + 2, n, n + 2, n + 3); };
  for (const pt of [0, 1]) {
    face([[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]], 1, pt);
    // (each face counter-clockwise seen from outside, so the back faces are culled)
    for (const x of [-0.5, 0.5]) { const q = [[x, 0, -0.5], [x, 1, -0.5], [x, 1, 0.5], [x, 0, 0.5]]; face(x < 0 ? q.reverse() : q, 0.8, pt); }
    for (const z of [-0.5, 0.5]) { const q = [[-0.5, 0, z], [-0.5, 1, z], [0.5, 1, z], [0.5, 0, z]]; face(z > 0 ? q.reverse() : q, 0.65, pt); }
  }
  BOX = { pos: new THREE.Float32BufferAttribute(pos, 3), part: new THREE.Float32BufferAttribute(part, 1), shade: new THREE.Float32BufferAttribute(shade, 1), idx: new THREE.Uint16BufferAttribute(idx, 1) };
  return BOX;
}
// the stand-ins S (joined arrays, see keep) as boxes or points, one instance each
const SK = { base: 3, sph: 3, top: 3, low: 3, a: 4, b: 4, c: 1, bin: 2 };
const SA = { base: Float32Array, sph: Float32Array, bin: Uint16Array };
// (points as plain vertices: software rendering draws instances one by one, tens of times slower)
function standGeometry(S, boxes) {
  if (!boxes) {
    const g = new THREE.BufferGeometry();
    for (const k in SK) if (k !== "bin") g.setAttribute(k, new THREE.BufferAttribute(S[k], SK[k], k === "top" || k === "low"));
    g.setAttribute("position", g.getAttribute("base"));
    return g;
  }
  const g = new THREE.InstancedBufferGeometry(), B = box();
  g.setAttribute("position", B.pos); g.setAttribute("part", B.part); g.setAttribute("shade", B.shade); g.setIndex(B.idx);
  for (const k in SK) if (k !== "bin") g.setAttribute(k, new THREE.InstancedBufferAttribute(S[k], SK[k], k === "top" || k === "low"));
  g.instanceCount = S.c.length;
  return g;
}
// The stand-ins of old ring L on the samples that new ring b keeps (columns i0 to i1 and rows j0 to j1 of b, which are di and dj further
// on in L), moved to b's centre and anchor.
function keep(L, b, i0, i1, j0, j1, di, dj) {
  const S = L.stand, n = S ? S.c.length : 0, idx = [];
  for (let q = 0; q < n; q++) {
    const i = S.bin[2 * q] - di, j = S.bin[2 * q + 1] - dj;
    if (i >= i0 && i < i1 && j >= j0 && j < j1) idx.push(q);
  }
  const out = {};
  for (const k in SK) {
    const m = SK[k], src = S && S[k], a = (out[k] = new (SA[k] || Uint8Array)(idx.length * m));
    for (let p = 0; p < idx.length; p++) for (let x = 0; x < m; x++) a[p * m + x] = src[idx[p] * m + x];
  }
  if (!idx.length) return out;
  const du = L.cu - b.cu, dv = L.cv - b.cv, an = L.anchor;
  const ax = an[0] - b.anchor[0], ay = an[1] - b.anchor[1], az = an[2] - b.anchor[2];
  for (let p = 0; p < idx.length; p++) {
    out.base[3 * p] += du; out.base[3 * p + 2] += dv;
    out.sph[3 * p] += ax; out.sph[3 * p + 1] += ay; out.sph[3 * p + 2] += az;
    out.bin[2 * p] -= di; out.bin[2 * p + 1] -= dj;
  }
  return out;
}
function join(parts) {
  const out = {};
  for (const k in SK) {
    let len = 0;
    for (const p of parts) len += p[k].length;
    const a = new (SA[k] || Uint8Array)(len);
    let o = 0;
    for (const p of parts) { a.set(p[k], o); o += p[k].length; }
    out[k] = a;
  }
  return out;
}

// ---- the palette: average colour of each block's top texture (js/grid.js colours the samples with it) ----
function palette() {
  const img = BF.textures.build().texture.image, W = img.width, H = img.height, d = img.data;
  const top = [], side = [], tint = [];
  const avg = (tile, out) => {
    const r = BF.textures.uv(tile);
    const x0 = Math.round(r[0] * W), x1 = Math.round(r[2] * W), y0 = Math.round((1 - r[3]) * H), y1 = Math.round((1 - r[1]) * H);
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4, a = d[o + 3];
      if (a < 128) continue;
      sr += d[o] * a; sg += d[o + 1] * a; sb += d[o + 2] * a; sa += a;
    }
    return sa ? [sr / sa / 255, sg / sa / 255, sb / sa / 255] : out;
  };
  for (let id = 0; id <= BF.MAX_BLOCK; id++) {
    const b = BF.blocks[id];
    top[id] = [0.5, 0.5, 0.5]; side[id] = top[id]; tint[id] = 0;
    if (!b || !b.tiles) continue;
    top[id] = avg(b.tiles.top, top[id]);
    side[id] = b.tiles.side ? avg(b.tiles.side, top[id]) : top[id];   // (logs' bark, walls: the stand-ins' trunks and houses)
    const t = BF.world._faceTint ? BF.world._faceTint[id * 6] : 0;
    tint[id] = t === 4 ? 0 : t;
  }
  return { top, side, tint };
}

// ---- rings ----
lod.reset = function (scene) {
  lod.scene = scene || lod.scene;
  for (const L of lod.levels) { if (L.mesh) dispose(L.mesh); if (L.si) dispose(L.si); }
  if (lod.ribbon) dispose(lod.ribbon);
  lod.ribbon = null; lod.ribbonAt = null;
  lod.levels = CELLS.map((cell, lv) => ({ lv, cell, half: cell * HALF, mesh: null, raw: null, building: null, f: -1, cu: 0, cv: 0, gu0: 0, gv0: 0, buildMs: 0, meshMs: 0, show: false }));
  // off by switch: ?nolod in the page's address, or BF.lodOff set before the game starts (tests served over http that time things under
  // software rendering, where seven rings slow every frame)
  lod.active = !!(BF.planet && BF.planet.isPlanet()) && !lod.disabled();
  last = null; speed = 0;
  if (!lod.active) { if (BF.sampler) BF.sampler.reset(null); return; }
  if (!lod.pal) lod.pal = palette();
  if (!fullIdx) { const d = BF.gridJob.discIndex(2 * EXT + 1, EXT, HALF); fullIdx = new THREE.BufferAttribute(d.idx, 1); fullCounts = d.counts; }   // made once here
  BF.gridJob.palette(lod.pal);
  // (rivers: the page's river network, for the workers' copies: js/worldgen.js riverState)
  BF.sampler.reset({ gen: BF.state.gen, seed: BF.state.seed, villages: BF.state.villages, biomeScale: BF.state.biomeScale, rivers: BF.worldgen.riverState() });
  // Without workers (a page opened as a file rather than through run.sh, where browsers refuse them) there is no distant terrain: sampling
  // in the page fills one ring in minutes, and seven rings drawn in software rendering slow every frame. BF.lodInline forces it on.
  if (BF.sampler.inline && !BF.lodInline) off();
};
lod.disabled = () => !!BF.lodOff || (typeof location !== "undefined" && /(^|[?&])nolod(=|&|$)/.test(location.search.slice(1)));
function off() {
  lod.active = false;
  for (const L of lod.levels) { if (L.mesh) { dispose(L.mesh); L.mesh = null; } if (L.si) { dispose(L.si); L.si = null; } L.stand = null; }
  if (lod.ribbon) { dispose(lod.ribbon); lod.ribbon = null; }
  BF.sampler.reset(null);
}
function dispose(m) {
  if (m.parent) m.parent.remove(m);
  m.geometry.dispose(); m.material.dispose();
}

// Starts rebuilding ring L around grid point (cu, cv) of face f: copies what the old ring already has and asks the workers for the rest.
function start(L, f, cu, cv) {
  const Pl = P(), c = L.cell, n = 2 * EXT + 1, gu0 = cu - EXT * c, gv0 = cv - EXT * c;
  const anchor = Pl.pos(f, cu, cv, BF.SEA, [0, 0, 0]);
  const stand = L.lv < STAND_LEVELS && lod.standIns ? { cu, cv, anchor, gu0, gv0, m: THIN[L.lv], max: STAND_MAX + MOVE * L.half, exact: L.lv === 0,
    houses: L.lv < HOUSE_LEVELS, villages: L.lv < HOUSE_LEVELS } : null;
  const b = { f, cu, cv, gu0, gv0, n, anchor, pending: 0, t0: performance.now(), raw: BF.gridJob.alloc({ nx: n, ny: n }), fresh: true, parts: stand ? [] : null };
  let rects = [[0, n, 0, n]];   // [j0, j1, i0, i1] still to sample
  const old = L.raw && L.f === f ? L : null;
  if (old) {
    const di = (gu0 - old.gu0) / c, dj = (gv0 - old.gv0) / c;
    if (Math.abs(di) < n && Math.abs(dj) < n) {
      const i0 = Math.max(0, -di), i1 = Math.min(n, n - di), j0 = Math.max(0, -dj), j1 = Math.min(n, n - dj);
      for (let j = j0; j < j1; j++) {
        const d = j * n, s = (j + dj) * n + di;
        b.raw.y.set(old.raw.y.subarray(s + i0, s + i1), d + i0);
        b.raw.ok.set(old.raw.ok.subarray(s + i0, s + i1), d + i0);
        b.raw.col.set(old.raw.col.subarray(3 * (s + i0), 3 * (s + i1)), 3 * (d + i0));
        b.raw.dir.set(old.raw.dir.subarray(3 * (s + i0), 3 * (s + i1)), 3 * (d + i0));
        b.raw.can.set(old.raw.can.subarray(4 * (s + i0), 4 * (s + i1)), 4 * (d + i0));
      }
      if (stand && L.stand) b.parts.push(keep(old, b, i0, i1, j0, j1, di, dj));   // the old ring's stand-ins on the samples kept
      b.fresh = false;
      rects = [];
      if (j0 > 0) rects.push([0, j0, 0, n]);
      if (j1 < n) rects.push([j1, n, 0, n]);
      if (i0 > 0) rects.push([j0, j1, 0, i0]);
      if (i1 < n) rects.push([j0, j1, i1, n]);
    }
  }
  L.building = b;
  // a ring built from nothing (a new world, a teleport): coarse rings first, so the whole view fills in quickly and sharpens; a ring
  // moving with the player: the finest first
  const prio = b.fresh ? -1 - L.lv : L.lv;
  for (const [j0, j1, i0, i1] of rects) {
    // about 12,000 samples a job (a few hundred ms in a worker): few enough answers that a slow frame doesn't leave workers idle
    const w = i1 - i0, step = Math.max(1, Math.floor(12000 / w));
    for (let j = j0; j < j1; j += step) {
      const job = { f, u0: gu0 + i0 * c, v0: gv0 + j * c, cell: c, nx: w, ny: Math.min(step, j1 - j), stand };
      b.pending++;
      BF.sampler.request(job, prio, (res) => {
        if (L.building !== b) return;
        for (let jj = 0; jj < job.ny; jj++) {
          const s = jj * w, d = (j + jj) * n + i0;
          b.raw.y.set(res.y.subarray(s, s + w), d);
          b.raw.ok.set(res.ok.subarray(s, s + w), d);
          b.raw.col.set(res.col.subarray(3 * s, 3 * (s + w)), 3 * d);
          b.raw.dir.set(res.dir.subarray(3 * s, 3 * (s + w)), 3 * d);
          b.raw.can.set(res.can.subarray(4 * s, 4 * (s + w)), 4 * d);
        }
        if (res.stand && b.parts) b.parts.push(res.stand);
        if (--b.pending === 0) build(L, b);
      }, L);
    }
  }
  if (!b.pending) build(L, b);
}

// Builds ring L's mesh from its samples (in a worker), then swaps it in.
function build(L, b) {
  const p = { n: b.n, c: L.cell, gu0: b.gu0, gv0: b.gv0, cu: b.cu, cv: b.cv, anchor: b.anchor, bridge: L.lv === CELLS.length - 1, ext: EXT, disc: HALF };
  const raw = b.raw;
  b.tm = performance.now();
  const copy = BF.sampler.inline ? raw : { y: raw.y.slice(), col: raw.col.slice(), can: raw.can.slice(), ok: raw.ok.slice(), dir: raw.dir.slice() };
  BF.sampler.request({ mesh: true, p, raw: copy }, -100, (m) => { if (L.building === b) finish(L, b, m); }, L);
}
let fullIdx = null, fullCounts = null;
function finish(L, b, m) {
  const t0 = performance.now(), Pl = P();
  const g = new THREE.BufferGeometry();
  const attr = (a, k, norm) => { const x = new THREE.BufferAttribute(a, k, !!norm); x.onUpload(free); return x; };
  g.setAttribute("position", attr(m.pos, 3));
  g.setAttribute("sphere", attr(m.sph, 3));
  g.setAttribute("col", attr(m.col, 3, true));
  g.setAttribute("mflat", attr(m.mpos, 3));
  g.setAttribute("msph", attr(m.msph, 3));
  g.setAttribute("mcol", attr(m.mcol, 3, true));
  g.setAttribute("canopy", attr(m.can, 4, true));
  if (m.idx) g.setIndex(attr(m.idx, 1));
  else g.setIndex(fullIdx);
  L.counts = m.idx ? m.counts : fullCounts;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), L.cell * EXT * 1.5 + 4000);
  // the ring keeps its material: freeing it would drop its shader program, compiled again for the new mesh (tens of ms)
  const mesh = new THREE.Mesh(g, L.mesh ? L.mesh.material : material(L.lv < CELLS.length - 1));
  const a = Pl.atlas(b.f, b.cu, b.cv);
  mesh.matrixAutoUpdate = false;
  mesh.position.set(a.x, 0, a.z); mesh.updateMatrix();
  mesh.userData = { anchor: b.anchor, lod: L.lv };
  mesh.material.uniforms.anchor.value.set(b.anchor[0], b.anchor[1], b.anchor[2]);
  if (L.mesh) { L.mesh.parent && L.mesh.parent.remove(L.mesh); L.mesh.geometry.dispose(); }
  // the stand-ins: their own object, placed the same way (kept with their material, like the ring)
  const S = b.parts ? join(b.parts) : null;
  mesh.material.uniforms.stand.value = S ? 1 / (1 << 2 * THIN[L.lv]) : 0;   // the share of tree cells drawn as stand-ins
  if (L.si) { L.si.parent && L.si.parent.remove(L.si); L.si.geometry.dispose(); }
  if (S) {
    const boxes = L.lv < BOX_LEVELS, mat = L.si ? L.si.material : standMaterial(boxes), geo = standGeometry(S, boxes);
    geo.boundingSphere = g.boundingSphere;   // (js/view.js culls by it while the view is flat)
    const si = boxes ? new THREE.Mesh(geo, mat) : new THREE.Points(geo, mat);
    const fr = Pl.frame(b.f, b.cu, b.cv, BF.SEA, {}), U = fr.eu, Up = fr.up, W = fr.ev;
    mat.uniforms.frame.value.set(U[0], Up[0], W[0], U[1], Up[1], W[1], U[2], Up[2], W[2]);
    mat.uniforms.centre.value.set(b.cu, b.cv);
    si.frustumCulled = false; si.matrixAutoUpdate = false;
    si.position.copy(mesh.position); si.updateMatrix();
    si.userData = { anchor: b.anchor, lod: L.lv, stand: true };
    si.visible = false;
    L.si = si;
    lod.scene.add(si);
  } else L.si = null;
  L.stand = S; L.anchor = b.anchor;
  L.mesh = mesh; L.raw = b.raw; L.f = b.f; L.cu = b.cu; L.cv = b.cv; L.gu0 = b.gu0; L.gv0 = b.gv0;
  L.buildMs = performance.now() - b.t0; L.meshMs = b.tm ? t0 - b.tm : 0; L.building = null; L.builds = (L.builds || 0) + 1;
  lod.scene.add(mesh);
  lod.mainMs = Math.max(lod.mainMs || 0, performance.now() - t0);
  (lod.swaps || (lod.swaps = [])).push(Math.round(performance.now() - t0)); if (lod.swaps.length > 64) lod.swaps.shift();
}
function free() { if (this.array !== (fullIdx && fullIdx.array)) this.array = null; }

// How far point (f, u, v) is from ring L's centre, in blocks of f's grid (Infinity when L's face can't be unfolded next to f).
function offset(L, f, u, v) {
  if (L.f < 0) return Infinity;
  const e = L.f === f ? ID : P().UNFOLD[f][L.f];
  if (!e) return Infinity;
  const U = e.A[0] * L.cu + e.A[1] * L.cv + e.t[0], W = e.A[2] * L.cu + e.A[3] * L.cv + e.t[1];
  return Math.max(Math.abs(U - u), Math.abs(W - v));
}
const ID = { A: [1, 0, 0, 1], t: [0, 0] };

// The radius covered by the coarsest ring drawn (0 if none), for fog and the far clip plane.
lod.radius = function () {
  let r = 0;
  if (lod.active) for (const L of lod.levels) if (L.mesh && L.show) r = L.half;
  return r;
};

// Sets m to the map from face g's grid into face f's (3x3), or far away when g is opposite f.
function unfoldMatrix(m, f, g) {
  const e = f === g ? ID : P().UNFOLD[f][g];
  if (!e) m.set(0, 0, 1e9, 0, 0, 1e9, 0, 0, 1);
  else m.set(e.A[0], e.A[1], e.t[0], e.A[2], e.A[3], e.t[1], 0, 0, 1);
  return m;
}

// Called each frame on the planet, after the world update.
let last = null, speed = 0;
lod.update = function (budgetMs = 4) {
  if (!lod.active || !BF.player || !BF.player.position) return;
  if (BF.sampler.inline && !BF.lodInline) { off(); return; }   // the workers failed to load
  const t0 = performance.now();
  update(budgetMs);
  // main-thread time per frame (without inline sampling, which has its own budget): for the budget test
  const ms = performance.now() - t0 - (BF.sampler.inline ? Math.min(budgetMs, lod.sampleMs || 0) : 0);
  lod.frameMs = ms; if (ms > (lod.maxFrameMs || 0)) lod.maxFrameMs = ms;
  lod.frames = (lod.frames || 0) + 1; if (ms > 25) lod.slowFrames = (lod.slowFrames || 0) + 1;
};
function update(budgetMs) {
  const Pl = P(), pp = BF.player.position, gr = Pl.grid(pp.x, pp.z);
  if (gr.f < 0) return;
  const V = lod.view, now = performance.now();
  V.f = gr.f; V.u = gr.u; V.v = gr.v;
  const ts = performance.now();
  BF.sampler.tick(budgetMs);
  lod.sampleMs = performance.now() - ts;
  // speed over the ground (blocks per second), to leave rings alone while the player outruns them
  if (last && last.f === V.f && now > last.t) {
    const dt = (now - last.t) / 1000;
    speed += (Math.hypot(V.u - last.u, V.v - last.v) / dt - speed) * Math.min(1, dt * 2);
  }
  last = { f: V.f, u: V.u, v: V.v, t: now };
  // height above the ground
  let ground = BF.SEA;
  try { ground = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(pp.x), Math.floor(pp.z))); } catch (_) {}
  const above = Math.max(0, pp.y - ground);
  lod.above = above;
  if (BF.renderer && BF.camera) pxScale.value = BF.renderer.getDrawingBufferSize(tmpV2).y / (2 * Math.tan(BF.camera.fov * Math.PI / 360));
  const top = lod.levels[lod.levels.length - 1];
  // fast-forward from 10x: built rings stay where they are and rivers aren't re-laid, leaving the frame to the simulation (a ring the
  // player leaves behind is still drawn; the coarser rings cover beyond it)
  const ff = !!(BF.warp && BF.warp.speed >= 10);
  for (const L of lod.levels) {
    L.show = above < HIDE * L.cell;
    if (!L.show) { if (L.building) { BF.sampler.cancel(L); L.building = null; } if (L.si) L.si.visible = false; continue; }
    if (L.building || (L.mesh && (ff || offset(L, V.f, V.u, V.v) <= MOVE * L.half))) continue;
    if (L.mesh && speed * L.buildMs / 1000 > 0.5 * L.half) continue;   // too fast for this ring: coarser rings cover until the player slows
    const c = L.cell * 4;
    start(L, V.f, Math.round(V.u / c) * c, Math.round(V.v / c) * c);
  }
  if (above < RIBBON_HIDE && !(ff && lod.ribbon)) ribbons(V, top);
  // cut each ring to its disc, minus the next finer ring's disc and the loaded chunks
  lod.eyeHole = Math.min(BF.world.viewDist * BF.CS, BF.world.covered || 0) * 0.95;
  let prev = null;
  const lastStand = lod.levels[STAND_LEVELS - 1];
  for (const L of lod.levels) {
    if (!L.mesh) continue;
    L.mesh.visible = L.show;
    if (!L.show) continue;
    const u = L.mesh.material.uniforms, fine = prev && prev.mesh && prev.show ? prev : null;
    cuts(u, V, lod.eyeHole, fine);
    u.outer.value.set(0, 0, L.half);
    // the middle that the finer ring or the loaded chunks certainly cover isn't drawn at all (its cells come first in the index)
    const g = L.mesh.geometry, idx = g.index;
    g.setDrawRange(6 * L.counts[Math.min(L.counts.length - 1, Math.floor(covered(L, V, fine) / L.cell))], Infinity);
    L.tris = Math.max(0, idx.count - g.drawRange.start) / 3;
    u.morph.value.set(L === top ? 1e30 : L.half * MORPH0, L === top ? 2e30 : L.half * MORPH1);
    // stand-ins fade out across the outer part of the last ring that has them
    if (L === lastStand) u.edge.value.set(L.half * 0.7, L.half * 0.95);
    if (L.si) {
      // too far to show from this height (a 10-block patch under a pixel straight down), all of it beyond where any is shown (its inner
      // edge, the finer ring's disc, past 10 blocks a pixel), or all among the loaded chunks: not drawn at all
      const inner = fine ? fine.half * (HOLE - MOVE) : 0;
      L.si.visible = 10 * pxScale.value > Math.max(above, inner) && lod.eyeHole < L.half * 0.95;
      const s = L.si.material.uniforms;
      s.hole.value.copy(u.hole.value); s.hole2.value.copy(u.hole2.value); s.seam2.value = u.seam2.value; s.outer.value.copy(u.outer.value);
      unfoldMatrix(s.toHole.value, V.f, L.f);
      if (fine) unfoldMatrix(s.toHole2.value, fine.f, L.f);
      s.edge.value.copy(u.edge.value);
    }
    prev = L;
  }
  if (lod.ribbon) {
    lod.ribbon.visible = above < RIBBON_HIDE;
    const u = lod.ribbon.material.uniforms;
    cuts(u, V, lod.eyeHole, null);
    u.outer.value.set(0, 0, top.half);
  }
}
const tmpV2 = new THREE.Vector2();
// How far from ring L's centre it is certainly covered by the loaded chunks or the finer ring (blocks; 0 if unsure): measured only within
// one face's grid, and not near a cube corner, where the finer ring leaves a strip along its wedge and unfolding depends on the route.
function covered(L, V, fine) {
  const N = P().N, c = L.cell;
  let r = 0;
  if (L.f === V.f) r = lod.eyeHole - Math.hypot(V.u - L.cu, V.v - L.cv);
  if (fine && fine.f === L.f) r = Math.max(r, fine.half * HOLE - Math.hypot(fine.cu - L.cu, fine.cv - L.cv));
  r -= 2 * c;
  if (r <= 0) return 0;
  const corner = Math.hypot(Math.min(L.cu, N - L.cu), Math.min(L.cv, N - L.cv));
  return corner < r + (fine ? 2 * fine.cell + 8 : 0) + 4 * c ? 0 : r;
}
// The cuts of a ring material: the loaded chunks' disc around the player in the view face's grid, and the finer ring's disc in its grid.
function cuts(u, V, r, fine) {
  u.hole.value.set(V.u, V.v, r);
  for (let i = 0; i < 6; i++) unfoldMatrix(u.toHole.value[i], V.f, i);
  if (!fine) { u.hole2.value.set(0, 0, 0); u.seam2.value = 0; return; }
  u.hole2.value.set(fine.cu, fine.cv, fine.half * HOLE);
  for (let i = 0; i < 6; i++) unfoldMatrix(u.toHole2.value[i], fine.f, i);
  u.seam2.value = 2 * fine.cell + 8;
}

// ---- rivers as ribbons ----
// A sampled grid shows a river narrower than its cells only as a broken line, so out where the rings are, rivers are ribbons along the
// river network's own curves, at least MINW blocks either side of the centre line, at the water surface; a segment whose end lies at sea
// is dropped (the sea is drawn already). Needs the planet's river network (r14-10, the prototype's rivers.js API: link, down, rs, sea,
// geom(li), inFace(f, node, out), view(li, f)); until then there is nothing to draw.
function ribbons(V, top) {
  const RV = BF.planetRivers || null;
  if (!RV || !RV.link) return;
  const ext = top.half * EXT / HALF, c = top.cell * 4;
  if (lod.ribbon && lod.ribbonAt && offset({ f: lod.ribbonAt[0], cu: lod.ribbonAt[1], cv: lod.ribbonAt[2] }, V.f, V.u, V.v) <= top.half * MOVE) return;
  const Pl = P(), f = V.f, cu = Math.round(V.u / c) * c, cv = Math.round(V.v / c) * c;
  if (lod.ribbon) { dispose(lod.ribbon); lod.ribbon = null; }
  lod.ribbonAt = [f, cu, cv];
  const anchor = Pl.pos(f, cu, cv, BF.SEA, [0, 0, 0]), flat = [], sph = [], col = [], idx = [], g = {}, q = [0, 0, 0];
  const W = lod.pal.top[BF.B.water], wc = [W[0] * 0.85 * 255, W[1] * 0.95 * 255, W[2] * 255];
  for (let li = 0; li < RV.link.length; li++) {
    const n = RV.link[li];
    const A = RV.inFace(f, n, [0, 0]), Bq = RV.inFace(f, RV.down[n], [0, 0]);
    if (!A || !Bq || Math.min(Math.abs(A[0] - cu), Math.abs(Bq[0] - cu)) > ext + 2000 || Math.min(Math.abs(A[1] - cv), Math.abs(Bq[1] - cv)) > ext + 2000) continue;
    const cv0 = RV.view(li, f), r0 = RV.rs[n], r1 = RV.rs[RV.down[n]], hw = Math.max(MINW, cv0.w), K = cv0.xs.length - 1;
    const prof = RV.geom(li).r, mouth = RV.sea[RV.down[n]];
    let wetPrev = false;
    for (let k = 0; k <= K; k++) {
      const x = cv0.xs[k], y = cv0.ys[k];
      const k0 = Math.max(0, k - 1), k1 = Math.min(K, k + 1), tx = cv0.xs[k1] - cv0.xs[k0], ty = cv0.ys[k1] - cv0.ys[k0], tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl * hw, ny = tx / tl * hw;
      // lifted by half a ring cell at this distance, since coarse cells bridge across narrow valleys
      const h = (prof ? prof[k] : r0 + (r1 - r0) * k / K) + 0.9 + Math.hypot(x - cu, y - cv) / (2 * HALF);
      const base = flat.length / 3;
      for (const sgn of [-1, 1]) {
        const px = x + nx * sgn, py = y + ny * sgn;
        flat.push(px - cu, h, py - cv);
        Pl.wrap(f, px, py, g); Pl.dir(g.f, g.u, g.v, q);
        const rr = Pl.R + (h - BF.SEA);
        sph.push(q[0] * rr - anchor[0], q[1] * rr - anchor[1], q[2] * rr - anchor[2]);
        col.push(wc[0], wc[1], wc[2]);
      }
      let wet = false;
      if (mouth) { Pl.wrap(f, x, y, g); const a = Pl.atlas(g.f, g.u, g.v); wet = BF.worldgen.heightAt(a.x, a.z) < BF.SEA; }
      if (k > 0 && !wet && !wetPrev && Math.abs(x - cu) <= ext && Math.abs(y - cv) <= ext) idx.push(base - 2, base, base - 1, base - 1, base, base + 1);
      wetPrev = wet;
    }
  }
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry(), nv = flat.length / 3;
  geo.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  geo.setAttribute("sphere", new THREE.Float32BufferAttribute(sph, 3));
  geo.setAttribute("col", new THREE.BufferAttribute(new Uint8Array(col), 3, true));
  geo.setAttribute("canopy", new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true));
  geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  const mat = material(false);
  mat.side = THREE.DoubleSide;
  mat.uniforms.anchor.value.set(anchor[0], anchor[1], anchor[2]);
  const mesh = new THREE.Mesh(geo, mat);
  const a = Pl.atlas(f, cu, cv);
  mesh.matrixAutoUpdate = false;
  mesh.position.set(a.x, 0, a.z); mesh.updateMatrix();
  mesh.userData = { anchor, lod: "ribbon" };
  lod.ribbon = mesh;
  lod.scene.add(mesh);
}

// Numbers for tests and the debug overlay.
lod.stats = () => ({
  active: lod.active, above: lod.above, eyeHole: lod.eyeHole, pending: BF.sampler ? BF.sampler.pending() : 0, inline: BF.sampler && BF.sampler.inline,
  rings: lod.levels.map((L) => ({ cell: L.cell, show: L.show, built: !!L.mesh, building: !!L.building, builds: L.builds || 0, f: L.f, cu: L.cu, cv: L.cv, buildMs: Math.round(L.buildMs), meshMs: Math.round(L.meshMs),
    stands: L.stand ? L.stand.c.length : 0, standsShown: !!(L.si && L.si.visible), tris: L.mesh && L.mesh.visible ? L.tris || 0 : 0 })),
  pxScale: pxScale.value,
  mainMs: lod.mainMs || 0, frames: lod.frames || 0, slowFrames: lod.slowFrames || 0, swaps: lod.swaps || [], maxFrameMs: lod.maxFrameMs || 0, workers: BF.sampler ? BF.sampler.workers.length : 0,
  samples: BF.sampler ? BF.sampler.samples : 0, msPerSample: BF.sampler && BF.sampler.samples ? BF.sampler.workMs / BF.sampler.samples : 0,
});
})();
