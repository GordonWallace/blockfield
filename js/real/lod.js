// Blockfield 1.6, the realistic look: js/real/lod.js. Owner: the Performance thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
//
// Levels of detail for the realistic look's plants (trees, bushes, ground cover, rocks): what keeps an endless forest drawable.
// This file takes over BF.real.flora.place(key, ox, oz, F) and BF.real.flora.remove(key) (contract section 4): js/world.js hands it
// each loaded chunk's flora list, and it decides what is drawn where.
//
// - Plants are batched by region (32 x 32 blocks, the contract's limit for one rigid object): one InstancedMesh per region, model,
//   level and part, so a region out of view costs nothing (batches are culled against the camera here; three.js can't cull an
//   InstancedMesh by its instances). A model is one variant of one registry entry (BF.real.assets.species / cover / rocks).
// - Each level of a model (the registry's build(rand, detail), detail 0 to 2) covers a band of distance from the camera. A region
//   builds the batches of every level whose band it reaches into, and the vertex shader drops each instance outside its batch's band,
//   so the level is picked per plant, not per region. Every plant's switch distances are shifted by a hash of its position (jitter),
//   so levels change tree by tree instead of along a line, and ground cover thins out instead of ending at an edge.
// - Past its last mesh level a tree is an impostor: a camera-facing card showing the tree from the nearest of FRAMES directions,
//   baked from its medium mesh into one atlas for all species (bake()). A region's impostors of every species are one draw call.
// - Geometry is built the first time a level is needed, at most one build a frame; batches are (re)built a few per frame, nearest
//   first, within config.budgetMs. A region keeps showing its old batches until the new ones are ready, so nothing blinks while
//   chunks stream in or a tree is felled.
// - BF.real.quality.level scales every distance (QUALITY below).
// Batches are direct scene children at their region's corner (atlas coordinates) with instance positions relative to it, so
// js/view.js places them from the floating origin (contract section 2).
// Light: a plant's sky and block light (the record's `extra`) go into its instance colour; the materials' own cell light stays open.
//
// API: BF.real.lod = { config, place(key, ox, oz, F), remove(key), clear(), update(camera), stats(), bake(), impostor, models,
//                      bandsOf(model) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
if (typeof THREE === "undefined") return;
const real = BF.real;

const TREE = 0, BUSH = 1, COVER = 2, ROCK = 3, BIG = 4;   // a record's kind (BIG: a tree on a 2 x 2 trunk)
const config = {
  region: 32,             // blocks along a region's side
  // by kind (tree, bush, ground cover, rock, big tree): the far end of each mesh level's band (a level whose band is empty is never
  // built), whether an impostor follows, where the kind ends (0: never, while its chunk is loaded), how much a plant's switch
  // distances vary (a share of the distance), and the level from which all variants of an entry are drawn as its first one (share).
  // Tuned on the 1.6 models: a tree is about 4,400 / 1,300 / 370 triangles at detail 0 / 1 / 2 and a tuft of ground cover 36 / 24, so
  // a dense forest (10 trees a chunk) is about 1.3 million triangles of trees all round, under half of that in view, and ground cover
  // costs draw calls rather than triangles (two levels, variants only next to the player).
  kinds: [
    { dist: [24, 60, 120], impostor: true, maxDist: 0, jitter: 0.2, share: 2 },
    { dist: [18, 44, 110], impostor: false, maxDist: 110, jitter: 0.4, share: 2 },
    { dist: [12, 72, 72], impostor: false, maxDist: 72, jitter: 0.6, share: 1 },
    { dist: [24, 60, 220], impostor: false, maxDist: 220, jitter: 0.3, share: 1 },
    { dist: [30, 76, 150], impostor: true, maxDist: 0, jitter: 0.2, share: 2 },
  ],
  scale: 1,               // multiplies every distance (set from BF.real.quality.level each frame unless fixedScale)
  fixedScale: false,
  budgetMs: 2,            // batch building per frame
  keepMs: 4000,           // a batch no longer wanted is kept this long (walking back and forth across a band's edge)
  frames: 8, cellW: 128, cellH: 256,   // impostor atlas: directions per species, pixels per frame
  crown: 2.5,             // a tree stands this many blocks taller than its log column
  big: 1.5,               // a 2 x 2 trunk's tree is this much larger
  enabled: true,
};
const QUALITY = [0.55, 0.8, 1];   // config.scale by BF.real.quality.level
const MAXROW = 32;        // species with impostors (rows of the atlas, and the size of the shader's range table)
const STRIDE = 7;         // x, y, z (atlas), height, seed, sky light, block light

const models = new Map(), modelById = [];   // "kind:species:variant" -> model
const rows = [];             // impostor atlas rows: the model each one is baked from
const chunks = new Map();    // chunk key -> { rk, by: Map(model id -> Float32Array(n * STRIDE)) }
const regions = new Map();   // "rx,rz" -> region
let scene = null, atlasDirty = false, builtThisFrame = false;
const st = { buildMs: 0, built: 0, pending: 0, drawn: 0, batches: 0, tris: 0, inst: 0, geo: 0 };

// ---------------------------------------------------------------- models
const HASH = "fract(sin(dot(P, vec2(12.9898, 78.233))) * 43758.5453) - 0.5";
const CULL_VERT = `
#ifdef USE_INSTANCING
{
  vec2 P = instanceMatrix[3].xz;
  float rlD = length((modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz) * (1.0 + rlJit * (${HASH}));
  if (rlD < rlRange.x || rlD >= rlRange.y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
#endif
`;
const canCull = m => !m.isShaderMaterial || m.vertexShader.includes("#include <project_vertex>");
// A copy of a registry material for one level of one model: the same look, plus the per-instance distance band.
function levelMaterial(src, range, jit) {
  const m = src.clone();
  if (src.isShaderMaterial) m.uniforms = Object.assign({}, src.uniforms);   // (shared holders: the owner's wind, sun... keep driving it)
  const patch = sh => {
    if (!sh.vertexShader.includes("#include <project_vertex>")) return;
    sh.uniforms.rlRange = range; sh.uniforms.rlJit = jit;
    sh.vertexShader = "uniform vec2 rlRange;\nuniform float rlJit;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>" + CULL_VERT);
  };
  if (src.isShaderMaterial) patch(m);
  else {
    const base = src.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => { if (base) base.call(src, sh, r); patch(sh); };
    m.customProgramCacheKey = () => "rlod:" + src.uuid + ":" + (src.customProgramCacheKey ? src.customProgramCacheKey() : "");
  }
  return m;
}
function mulberry(a) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// The registry entry that draws a record: the foundation's rules (BF.real.flora.resolve: by block, biome, log count and seed) where
// its placer is loaded; otherwise the first entry made for the block.
const blockName = id => { const b = BF.blocks && BF.blocks[id]; return b ? b.name : ""; };
function resolve(kind, block, biome, logs, seed) {
  const f = real.flora;
  if (f && f.resolve) return f.resolve(block, biome, logs, seed) || null;
  const name = blockName(block), A = real.assets;
  if (kind === COVER) return A.cover.find(e => e.block === name) || null;
  if (kind === ROCK) return A.rocks[0] || null;
  return A.species.find(e => e.log === name || e.block === name) || null;
}
const defIds = new Map();   // registry entry -> a number for it
const matCache = new Map();   // registry entry -> { bark, foliage, one }
function materialsOf(def) {
  let m = matCache.get(def);
  if (!m) matCache.set(def, m = {});
  return m;
}
function partMaterial(def, name) {
  const m = materialsOf(def);
  if (name === "bark") return m.bark || (m.bark = def.barkMaterial ? def.barkMaterial() : def.material());
  if (name === "foliage") return m.foliage || (m.foliage = def.foliageMaterial ? def.foliageMaterial() : def.material());
  return m.one || (m.one = def.material ? def.material() : def.foliageMaterial());
}

// The model of a flora record: its registry entry and variant (null when the registry has nothing for it).
function modelFor(kind, block, biome, logs, seed) {
  const def = resolve(kind, block, biome, logs, (seed * 7.13) % 1);   // (the seed as the foundation's placer hands it to its rule)
  if (!def) return null;
  return modelOf(kind, def, Math.floor(seed * 9973) % Math.max(1, def.variants | 0));   // (the variant as the foundation's placer picks it)
}
function modelOf(kind, def, variant) {
  let di = defIds.get(def);
  if (di === undefined) defIds.set(def, di = defIds.size);
  const key = kind + ":" + di + ":" + variant;
  let M = models.get(key);
  if (M) return M;
  const K = config.kinds[kind] || config.kinds[TREE];
  M = { id: modelById.length, key, kind, def, variant, K, jit: { value: K.jitter }, lods: [null, null, null], modelH: def.modelHeight || (def.height ? (def.height[0] + def.height[1]) / 2 : 0), row: -1, imp: null,
    cull: true, seed: (di * 7919 + variant * 104729 + 17) | 0, failed: false };
  if (K.impostor) {
    // one atlas row per registry entry (variants share it: past the last mesh level they can't be told apart)
    const owner = rows.findIndex(r => r.def === def);
    if (owner >= 0) { M.row = owner; M.imp = rows[owner].imp; }
    else if (rows.length < MAXROW) { M.row = rows.length; rows.push(M); atlasDirty = true; }
  }
  models.set(key, M); modelById.push(M);
  // from its kind's share level on, a model is drawn as its entry's first variant (far enough that they can't be told apart): a
  // region then draws an entry's far plants in one batch per part, not one per variant
  M.far = variant === 0 ? M : modelOf(kind, def, 0);
  return M;
}
// Level i of a model, built on first use: [{geometry, material, depthMaterial}] plus its band uniform and triangle count.
function levelOf(M, i) {
  if (M.lods[i]) return M.lods[i];
  if (M.failed) return null;
  let out;
  try { out = M.def.build(mulberry(M.seed), i); } catch (e) { console.error("BF.real.lod: build failed for " + (M.def.id || M.key), e); M.failed = true; return null; }
  st.geo++; builtThisFrame = true;
  const named = out && out.isBufferGeometry ? [["one", out]] : Object.keys(out || {}).filter(k => out[k] && out[k].isBufferGeometry).map(k => [k, out[k]])
    .filter(([, g]) => g.attributes.position && (g.index ? g.index.count : g.attributes.position.count) > 0);   // (a leafless tree's foliage is empty)
  if (!named.length) { M.failed = true; return null; }
  const range = { value: new THREE.Vector2(0, 1e9) };
  let tris = 0, top = 0;
  const parts = named.map(([name, g]) => {
    const src = partMaterial(M.def, name);
    if (!canCull(src)) M.cull = false;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!g.boundingBox) g.computeBoundingBox();
    top = Math.max(top, g.boundingBox.max.y);
    return { geometry: g, src, foliage: name === "foliage", material: levelMaterial(src, range, M.jit), depthMaterial: (out.depth && out.depth[name]) || null };
  });
  if (!M.modelH) M.modelH = top || 1;   // (an entry that doesn't declare its model's height: measured)
  return (M.lods[i] = { parts, range, tris });
}
// A plant's scale from its record, as the foundation's simple placer sizes it: a tree's model reaches a little past its log column
// (the crown the leaf blocks made), a big tree (2 x 2 trunk) is half as large again; the rest keep the model's size. All vary a little.
function scaleOf(M, height, seed) {
  const v = (seed * 13.7) % 1;
  if (M.kind === TREE || M.kind === BIG) return (height + config.crown) / (M.modelH || 1) * (0.92 + 0.16 * v) * (M.kind === BIG ? config.big : 1);
  return 0.85 + 0.3 * v;
}

// The distance bands of a model at the current settings: [from, to) of mesh levels 0 to 2, then the impostor's (or null).
function bandsOf(M) {
  const k = config.scale, K = M.K, end = K.maxDist ? K.maxDist * k : 1e9, out = [];
  let from = 0;
  for (let i = 0; i < 3; i++) {
    let to = Math.min(end, K.dist[i] * k);
    if (i === 2 && !(M.row >= 0 && M.imp)) to = end;
    out.push([from, Math.max(from, to)]);
    from = Math.max(from, to);
  }
  out.push(M.row >= 0 && M.imp ? [from, Math.max(from, end)] : null);
  return out;
}

// ---------------------------------------------------------------- impostors
const IMP_VERT = `
attribute vec4 iA;   // x, y, z (from the region's corner), yaw
attribute vec4 iB;   // half width, height, base offset, atlas row
attribute vec3 iC;   // tint
uniform vec2 uRange[${MAXROW}];
uniform float uJit[${MAXROW}];
uniform vec2 uGrid;  // frames across, rows
varying vec2 vUv;
varying vec3 vTint;
varying float vX;
varying vec3 vRight;
varying vec3 vFront;
varying vec3 vUp;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iA.xyz, 1.0);
  int row = int(iB.w + 0.5);
  vec2 P = iA.xz;
  float d = length(mvPosition.xyz) * (1.0 + uJit[row] * (${HASH}));
  vec3 up = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 toCam = normalize(-mvPosition.xyz);
  vec3 right = normalize(cross(up, toCam));
  vec3 xV = (modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz, zV = (modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
  float ang = atan(dot(toCam, xV), dot(toCam, zV)) - iA.w;
  float f = mod(floor(fract(ang / 6.2831853) * uGrid.x + 0.5), uGrid.x);
  vUv = vec2((f + 0.5 + position.x * 0.48) / uGrid.x, (iB.w + 0.02 + position.y * 0.96) / uGrid.y);
  vTint = iC;
  vX = position.x; vRight = right; vUp = up; vFront = normalize(cross(right, up));
  mvPosition.xyz += right * (position.x * iB.x) + up * (iB.z + position.y * iB.y);
  gl_Position = projectionMatrix * mvPosition;
  if (d < uRange[row].x || d >= uRange[row].y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <fog_vertex>
}`;
// The card's colour is the baked surface colour under the frame's light. The card is shaded as the round crown it stands for (a
// normal that turns from one edge to the other and leans up), so a tree lit from one side stays lit from that side as a card, and a
// backlit forest stays dark: the switch from mesh to card doesn't change a tree's brightness.
const IMP_FRAG = `
uniform sampler2D map;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
varying vec2 vUv;
varying vec3 vTint;
varying float vX;
varying vec3 vRight;
varying vec3 vFront;
varying vec3 vUp;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.4) discard;
  float x = clamp(vX, -1.0, 1.0) * 0.85;
  vec3 n = normalize(vRight * x + vFront * sqrt(1.0 - x * x) + vUp * 0.45);
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vec3 light = mix(uGroundCol, uSkyCol, 0.5 + 0.5 * dot(n, vUp)) + uSunCol * max(dot(n, sunV), 0.0);
  gl_FragColor = vec4(pow(c.rgb, vec3(2.2)) * vTint * light, 1.0);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
  #include <fog_fragment>
}`;
const imp = { material: null, atlas: null, quad: null, rows: 0 };
function impostorMaterial() {
  if (imp.material) return imp.material;
  const ranges = [], jits = [];
  for (let i = 0; i < MAXROW; i++) { ranges.push(new THREE.Vector2(1e9, 1e9)); jits.push(0); }
  const U = real.U;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uRange: { value: ranges }, uJit: { value: jits },
    uGrid: { value: new THREE.Vector2(config.frames, 1) } }]);
  uniforms.uSunCol = U.uSunCol; uniforms.uSunDir = U.uSunDir; uniforms.uSkyCol = U.uSkyCol; uniforms.uGroundCol = U.uGroundCol;   // (shared by reference, contract section 3)
  imp.material = new THREE.ShaderMaterial({ uniforms, vertexShader: IMP_VERT, fragmentShader: IMP_FRAG, fog: true, side: THREE.DoubleSide });
  imp.quad = { pos: new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), idx: [0, 1, 2, 0, 2, 3] };
  return imp.material;
}

// Spreads the colour of drawn pixels into the empty ones next to them (a few rounds), so filtering and mipmaps at a card's edge
// mix in foliage colour instead of the cleared black.
function dilate(px, w, h, rounds) {
  let src = px, dst = new Uint8Array(px.length);
  for (let r = 0; r < rounds; r++) {
    dst.set(src);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (src[o + 3] > 0) continue;
      let R = 0, G = 0, B = 0, n = 0;
      for (let k = 0; k < 4; k++) {
        const xx = x + (k === 0) - (k === 1), yy = y + (k === 2) - (k === 3);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = (yy * w + xx) * 4;
        if (src[q + 3] > 0) { R += src[q]; G += src[q + 1]; B += src[q + 2]; n++; }
      }
      if (n) { dst[o] = R / n; dst[o + 1] = G / n; dst[o + 2] = B / n; dst[o + 3] = 1; }   // (alpha 1/255: counted as drawn next round, still cut by the alpha test)
    }
    const t = src; src = dst; dst = t;
  }
  return src;
}

// Bakes every impostor row into one atlas (again whenever a new species is first seen): each tree's medium mesh from FRAMES
// directions, lit flat and white so the card holds surface colour. Needs the renderer.
function bake() {
  const R = real.renderer || BF.renderer;
  if (!R) return false;
  atlasDirty = false;
  if (!rows.length) return true;
  const F = config.frames, cw = config.cellW, ch = config.cellH, W = F * cw, H = rows.length * ch;
  const rt = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat });
  rt.texture.encoding = THREE.sRGBEncoding;
  const bs = new THREE.Scene();
  bs.add(new THREE.AmbientLight(0xffffff, 0.82));
  const sun = new THREE.DirectionalLight(0xffffff, 0.3); bs.add(sun); bs.add(sun.target);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  const prev = { rt: R.getRenderTarget(), color: R.getClearColor(new THREE.Color()), alpha: R.getClearAlpha(), auto: R.autoClear, tone: R.toneMapping,
    shadow: R.shadowMap.autoUpdate };
  R.shadowMap.autoUpdate = false; R.toneMapping = THREE.NoToneMapping;
  R.setClearColor(0x000000, 0); R.autoClear = false;
  rt.scissorTest = false; rt.viewport.set(0, 0, W, H);
  R.setRenderTarget(rt); R.clear(true, true, true);
  const box = new THREE.Box3();
  rows.forEach((M, row) => {
    const L = levelOf(M, 1) || levelOf(M, 2) || levelOf(M, 0);
    if (!L) return;
    const srcs = L.parts.map(p => { const m = new THREE.Mesh(p.geometry, p.src)   /* the registry's own material: the level's copy would cut the tree by the bake camera's distance */; m.frustumCulled = false; bs.add(m); return m; });
    box.makeEmpty();
    let rad = 0;
    for (const p of L.parts) {
      box.union(p.geometry.boundingBox);
      const a = p.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) rad = Math.max(rad, Math.hypot(a.getX(i), a.getZ(i)));
    }
    rad *= 1.04;
    const y0 = box.min.y, hgt = (box.max.y - box.min.y) * 1.04, D = rad * 4 + 10;
    M.imp = { r: rad, h: hgt, y0 };
    for (const o of modelById) if (o.row === row) o.imp = M.imp;
    cam.left = -rad; cam.right = rad; cam.bottom = y0; cam.top = y0 + hgt; cam.near = 0.1; cam.far = D * 2; cam.updateProjectionMatrix();
    for (let f = 0; f < F; f++) {
      const a = f / F * Math.PI * 2;
      cam.position.set(Math.sin(a) * D, 0, Math.cos(a) * D); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0);
      sun.position.set(Math.sin(a) * D, D * 0.8, Math.cos(a) * D);   // (from the camera's side and above: only depth inside the crown is baked in) sun.target.position.set(0, y0 + hgt / 2, 0);
      rt.viewport.set(f * cw, row * ch, cw, ch); rt.scissor.set(f * cw, row * ch, cw, ch); rt.scissorTest = true;
      R.setRenderTarget(rt);
      R.clearDepth();
      R.render(bs, cam);
    }
    for (const m of srcs) bs.remove(m);
  });
  const px = new Uint8Array(W * H * 4);
  R.readRenderTargetPixels(rt, 0, 0, W, H, px);
  R.setRenderTarget(prev.rt); R.setClearColor(prev.color, prev.alpha); R.autoClear = prev.auto; R.toneMapping = prev.tone; R.shadowMap.autoUpdate = prev.shadow;
  rt.dispose();
  const tex = new THREE.DataTexture(dilate(px, W, H, 6), W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
  const mat = impostorMaterial();
  if (imp.atlas) imp.atlas.dispose();
  imp.atlas = tex; imp.rows = rows.length;
  mat.uniforms.map.value = tex; mat.uniforms.uGrid.value.set(F, rows.length);
  for (const r of regions.values()) r.ver++;   // rows and card sizes may have changed
  return true;
}
// ---------------------------------------------------------------- data in
function regionFor(x, z) {
  const S = config.region, rx = Math.floor(x / S), rz = Math.floor(z / S), rk = rx + "," + rz;
  let r = regions.get(rk);
  if (!r) {
    r = { rk, ox: rx * S, oz: rz * S, oy: 0, chunks: new Set(), ver: 0, built: new Map(), count: new Map(), n: 0, y0: 0, y1: 0, face: -1 };
    if (BF.planet && BF.planet.face) r.face = BF.planet.face(r.ox + S / 2, r.oz + S / 2);
    regions.set(rk, r);
  }
  return r;
}
// A region's totals from its chunks (count by model, height range).
function tally(r) {
  r.count.clear(); r.n = 0;
  let y0 = Infinity, y1 = -Infinity;
  for (const k of r.chunks) {
    const c = chunks.get(k);
    for (const [id, a] of c.by) {
      const n = a.length / STRIDE;
      r.count.set(id, (r.count.get(id) || 0) + n); r.n += n;
      for (let i = 1; i < a.length; i += STRIDE) { if (a[i] < y0) y0 = a[i]; if (a[i] > y1) y1 = a[i]; }
    }
  }
  if (r.n) { r.y0 = y0; r.y1 = y1; if (!r.built.size) r.oy = Math.floor(y0); }
  r.ver++;
}

// A record's `extra` is the sky light level at the plant's base (0..15) plus 16 x the block light level (0..15).
const skyOf = ex => ((ex | 0) & 15) / 15, blockOf = ex => (((ex | 0) >> 4) & 15) / 15;

// The flora of one chunk (contract section 4), replacing what it had: F holds 8 floats per plant, [x, y, z, kind, block, height,
// seed, extra], x and z from the chunk's corner (ox, oz); block is the log's or the plant's block id. An empty list is the same as
// remove.
function place(key, ox, oz, F) {
  const had = chunks.get(key), n = F ? Math.floor(F.length / 8) : 0;
  if (!n) { if (had) remove(key); return; }
  const cnt = new Map(), ms = new Array(n);
  let biome = "";
  try { const b = BF.worldgen && BF.worldgen.biomeAt && BF.worldgen.biomeAt(ox + 8, oz + 8); biome = b ? b.name : ""; } catch (_) { /* no world yet */ }
  for (let i = 0; i < n; i++) {
    const o = i * 8, M = modelFor(F[o + 3] | 0, F[o + 4] | 0, biome, F[o + 5], F[o + 6]);
    ms[i] = M;
    if (M) cnt.set(M.id, (cnt.get(M.id) || 0) + 1);
  }
  if (!cnt.size) { if (had) remove(key); return; }
  const by = new Map(), at = new Map();
  for (const [id, c] of cnt) { by.set(id, new Float32Array(c * STRIDE)); at.set(id, 0); }
  for (let i = 0; i < n; i++) {
    const M = ms[i];
    if (!M) continue;
    const o = i * 8, a = by.get(M.id), q = at.get(M.id), ex = F[o + 7];
    a[q] = ox + F[o]; a[q + 1] = F[o + 1]; a[q + 2] = oz + F[o + 2]; a[q + 3] = F[o + 5]; a[q + 4] = F[o + 6];
    a[q + 5] = skyOf(ex); a[q + 6] = blockOf(ex);
    at.set(M.id, q + STRIDE);
  }
  const r = regionFor(ox + 8, oz + 8);
  if (had && had.rk !== r.rk) remove(key);
  chunks.set(key, { rk: r.rk, by });
  r.chunks.add(key);
  tally(r);
}
function remove(key) {
  const c = chunks.get(key);
  if (!c) return;
  chunks.delete(key);
  const r = regions.get(c.rk);
  if (!r) return;
  r.chunks.delete(key);
  tally(r);
}
function dropBatch(b) {
  for (const m of b.meshes) {
    if (scene) scene.remove(m);
    if (m.isInstancedMesh) m.dispose(); else m.geometry.dispose();
  }
  b.meshes.length = 0;
}
function clear() {
  for (const r of regions.values()) for (const b of r.built.values()) dropBatch(b);
  regions.clear(); chunks.clear();
}

// ---------------------------------------------------------------- batches
// Sky and block light as an instance colour: what BF.real.lit does with a cell's light, folded into the plant's own colour (a little
// variety by seed on top).
function tintOf(a, i, out, q) {
  const sky = a[i + 5], bl = a[i + 6], seed = a[i + 4];
  const s = Math.max(0.06, sky * (0.6 + 0.4 * Math.min(1, Math.max(0, (sky - 0.3) / 0.4))));
  const b = Math.min(1, 1.1 * Math.pow(bl, 1.25)) * 0.9, v = 0.9 + 0.2 * ((seed * 5.3) % 1), w = 0.94 + 0.12 * ((seed * 9.1) % 1);
  out[q] = (s + b) * v; out[q + 1] = (s + b * 0.72) * v * w; out[q + 2] = (s + b * 0.42) * v;
}
function addToScene(mesh, r) {
  mesh.position.set(r.ox, r.oy, r.oz);
  mesh.updateMatrix();
  mesh.frustumCulled = false;   // culled here, by the region's box
  mesh.userData.rlod = true;
  scene.add(mesh);
}
function buildMeshBatch(r, M, lod) {
  // (a shared level is drawn with the entry's first variant for every variant, see modelOf)
  const L = levelOf(M, lod), ids = lod >= M.K.share ? modelById.filter(o => o.far === M).map(o => o.id) : [M.id];
  let n = 0;
  for (const id of ids) n += r.count.get(id) || 0;
  const b = { ver: r.ver, meshes: [], n, tris: L ? L.tris * n : 0, last: 0 };
  if (!n || !L) return b;
  const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3);
  let o = 0, q = 0;
  for (const k of r.chunks) for (const id of ids) {
    const a = chunks.get(k).by.get(id);
    if (!a) continue;
    for (let i = 0; i < a.length; i += STRIDE) {
      const s = scaleOf(M, a[i + 3], a[i + 4]), rot = a[i + 4] * 6.2831853, c = Math.cos(rot) * s, sn = Math.sin(rot) * s;
      mats[o] = c; mats[o + 2] = -sn; mats[o + 5] = s; mats[o + 8] = sn; mats[o + 10] = c;
      mats[o + 12] = a[i] - r.ox; mats[o + 13] = a[i + 1] - r.oy; mats[o + 14] = a[i + 2] - r.oz; mats[o + 15] = 1;
      tintOf(a, i, cols, q);
      o += 16; q += 3;
    }
  }
  const shadows = !!(real.quality && real.quality.shadows) && lod === 0 && M.kind !== COVER;   // (near trees only: the cost of a shadow pass is per triangle)
  for (const p of L.parts) {
    const m = new THREE.InstancedMesh(p.geometry, p.material, n);
    m.instanceMatrix = new THREE.InstancedBufferAttribute(mats, 16);
    m.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
    m.castShadow = shadows; m.receiveShadow = !p.foliage;
    if (p.depthMaterial) m.customDepthMaterial = p.depthMaterial;
    addToScene(m, r);
    b.meshes.push(m);
  }
  return b;
}
function buildImpostorBatch(r) {
  let n = 0;
  for (const [id, c] of r.count) { const M = modelById[id]; if (M.row >= 0 && M.imp) n += c; }
  const b = { ver: r.ver, meshes: [], n, tris: n * 2, last: 0 };
  if (!n) return b;
  const A = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 3);
  let o = 0, q = 0;
  for (const k of r.chunks) for (const [id, a] of chunks.get(k).by) {
    const M = modelById[id], I = M.imp;
    if (M.row < 0 || !I) continue;
    for (let i = 0; i < a.length; i += STRIDE) {
      const s = scaleOf(M, a[i + 3], a[i + 4]);
      A[o] = a[i] - r.ox; A[o + 1] = a[i + 1] - r.oy; A[o + 2] = a[i + 2] - r.oz; A[o + 3] = a[i + 4] * 6.2831853;
      B[o] = I.r * s; B[o + 1] = I.h * s; B[o + 2] = I.y0 * s; B[o + 3] = M.row;
      tintOf(a, i, C, q);
      o += 4; q += 3;
    }
  }
  const mat = impostorMaterial(), g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(imp.quad.pos, 3));
  g.setIndex(imp.quad.idx);
  g.setAttribute("iA", new THREE.InstancedBufferAttribute(A, 4));
  g.setAttribute("iB", new THREE.InstancedBufferAttribute(B, 4));
  g.setAttribute("iC", new THREE.InstancedBufferAttribute(C, 3));
  g.instanceCount = n;
  const m = new THREE.Mesh(g, mat);
  addToScene(m, r);
  b.meshes.push(m);
  return b;
}

// ---------------------------------------------------------------- per frame
const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), inv = new THREE.Matrix4(), bbox = new THREE.Box3();
const jobs = [], rc = { min: 0, max: 0, mid: 0 }, asked = new Set(), tr3 = [0, 0, 0];
// Nearest and farthest distance from the camera to a region's box.
function reach(r, cx, cy, cz, out) {
  const S = config.region;
  const x0 = r.ox, x1 = r.ox + S, z0 = r.oz, z1 = r.oz + S, y0 = r.y0, y1 = r.y1;
  const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0, dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0, dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0;
  const fx = Math.max(Math.abs(cx - x0), Math.abs(cx - x1)), fz = Math.max(Math.abs(cz - z0), Math.abs(cz - z1)), fy = Math.max(Math.abs(cy - y0), Math.abs(cy - y1));
  out.min = Math.hypot(dx, dy, dz); out.max = Math.hypot(fx, fy, fz);
  out.mid = Math.hypot(cx - (x0 + x1) / 2, cy - (y0 + y1) / 2, cz - (z0 + z1) / 2);
}

function update(camera) {
  camera = camera || real.camera || BF.camera; scene = scene || real.scene || BF.scene;
  if (!camera || !scene) return;
  const now = performance.now();
  if (!config.enabled) { for (const r of regions.values()) for (const b of r.built.values()) for (const m of b.meshes) m.visible = false; return; }
  if (!config.fixedScale && real.quality) config.scale = QUALITY[Math.max(0, Math.min(2, real.quality.level | 0))];
  builtThisFrame = false;
  if (atlasDirty) bake();
  // this frame's bands
  const mat = imp.material, bands = [];
  for (const M of modelById) {
    const bd = bandsOf(M); bands.push(bd);
    for (let i = 0; i < 3; i++) if (M.lods[i]) M.lods[i].range.value.set(bd[i][0], bd[i][1]);
    if (mat && M.row >= 0) {
      const ib = bd[3];
      mat.uniforms.uRange.value[M.row].set(ib ? ib[0] : 1e9, ib ? ib[1] : 1e9);
      mat.uniforms.uJit.value[M.row] = M.jit.value;
    }
  }
  // culling in atlas space holds while the view is flat and the region is on the camera's face (js/view.js); otherwise everything shows
  const V = BF.view && BF.view.state, flat = !V || !V.on || V.k <= 0, cp = camera.position;
  const camFace = BF.planet && BF.planet.face ? BF.planet.face(cp.x, cp.z) : -1;
  camera.updateMatrixWorld();
  frustum.setFromProjectionMatrix(pm.multiplyMatrices(camera.projectionMatrix, inv.copy(camera.matrixWorld).invert()));
  jobs.length = 0;
  st.drawn = 0; st.batches = 0; st.tris = 0; st.inst = 0;
  const S = config.region;
  for (const r of regions.values()) {
    if (!r.n) {
      for (const b of r.built.values()) dropBatch(b);
      r.built.clear();
      if (!r.chunks.size) regions.delete(r.rk);
      continue;
    }
    reach(r, cp.x, cp.y, cp.z, rc);
    if (r.face !== camFace && r.face >= 0 && BF.view && BF.view.toRender) {
      // across a face edge the atlas is cut, so the distance is asked of the view (render space: the camera is the origin)
      const q = BF.view.toRender(r.ox + S / 2, (r.y0 + r.y1) / 2, r.oz + S / 2, tr3);
      if (q) { const d = Math.hypot(q[0], q[1], q[2]), h = S * 0.71 + (r.y1 - r.y0) / 2; rc.min = Math.max(0, d - h); rc.max = d + h; rc.mid = d; }
    }
    bbox.min.set(r.ox - 16, r.y0 - 4, r.oz - 16); bbox.max.set(r.ox + S + 16, r.y1 + 64, r.oz + S + 16);
    const inView = !flat || r.face !== camFace || frustum.intersectsBox(bbox);
    for (const b of r.built.values()) b.want = false;
    asked.clear();
    let wantImp = false;
    for (const [id] of r.count) {
      const M = modelById[id], bd = bands[id], j = M.jit.value / 2;
      for (let i = 0; i <= 3; i++) {
        const band = bd[i];
        if (!band || band[1] <= band[0]) continue;
        // (a plant at distance d switches at d (1 +- j): the batch is needed if any of its plants can fall in the band)
        const hit = M.cull ? rc.min * (1 - j) < band[1] && rc.max * (1 + j) >= band[0] : rc.mid >= band[0] && rc.mid < band[1];
        if (!hit) continue;
        if (i === 3) { wantImp = true; continue; }
        const D = i >= M.K.share ? M.far : M, key = D.id + ":" + i, b = r.built.get(key);
        if (b) b.want = true;
        if ((!b || b.ver !== r.ver) && !asked.has(key)) { asked.add(key); jobs.push([rc.min + i, r, key, D, i]); }
      }
    }
    if (wantImp) {
      const b = r.built.get("imp");
      if (b) b.want = true;
      if (!b || b.ver !== r.ver) jobs.push([rc.min, r, "imp", null, 0]);
    }
    for (const [key, b] of r.built) {
      if (b.want) b.last = now;
      else if (now - b.last > config.keepMs || b.ver !== r.ver) { dropBatch(b); r.built.delete(key); continue; }
      const vis = b.want && inView;
      for (const m of b.meshes) m.visible = vis;
      st.batches += b.meshes.length;
      if (vis) { st.drawn += b.meshes.length; st.tris += b.tris; st.inst += b.n; }
    }
  }
  // build what's missing or out of date, nearest first; a level's geometry not built yet costs the frame its one build
  st.pending = jobs.length; st.built = 0; st.buildMs = 0;
  if (jobs.length) {
    jobs.sort((a, b) => a[0] - b[0]);
    const t0 = performance.now();
    for (const [, r, key, M, lod] of jobs) {
      if (M && !M.lods[lod] && builtThisFrame) continue;   // (its geometry waits for the next frame)
      const old = r.built.get(key);
      const b = key === "imp" ? buildImpostorBatch(r) : buildMeshBatch(r, M, lod);
      b.last = now; b.want = true;
      if (old) dropBatch(old);
      r.built.set(key, b);
      st.built++;
      if (performance.now() - t0 > config.budgetMs) break;
    }
    st.buildMs = performance.now() - t0;
    st.pending -= st.built;
  }
}

function stats() {
  let plants = 0;
  for (const r of regions.values()) plants += r.n;
  return { regions: regions.size, chunks: chunks.size, plants, batches: st.batches, drawn: st.drawn, instances: st.inst, tris: Math.round(st.tris),
    pending: st.pending, built: st.built, buildMs: +st.buildMs.toFixed(2), models: modelById.length, geometries: st.geo, rows: rows.length, scale: config.scale };
}

real.lod = { config, models, place, remove, clear, update, stats, bake, impostor: imp, bandsOf };
// Take over the flora placer (contract section 4): now, and again at init in case the foundation's placer was installed after this file.
function takeOver() { real.flora = real.flora || {}; real.flora.place = place; real.flora.remove = remove; }
takeOver();
real.module({
  name: "lod",
  init(ctx) { scene = ctx.scene; takeOver(); },
  frame() { update(real.camera || BF.camera); },
});
})();
