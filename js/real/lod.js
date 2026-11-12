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
// - Each level of a model covers a band of distance from the camera. Level 0 is the registry's full model (build(rand, 0)); levels 1
//   and 2 are that same mesh thinned here (thin(): its small branches dropped, a share of its leaf cards kept and enlarged), so a
//   tree is the same tree at every distance. (The registry's own build(rand, 1 or 2) grows a different tree from the same seed: its
//   coarser levels draw fewer random numbers.) A region builds the batches of every level whose band it reaches into, and the vertex
//   shader drops each instance outside its batch's band, so the level is picked per plant, not per region. Every plant's switch
//   distances are shifted by a hash of its position (jitter), so levels change tree by tree instead of along a line, and ground
//   cover thins out instead of ending at an edge.
// - Past its last mesh level a tree is an impostor: a card that faces the camera and shows the tree from that direction (the two
//   nearest of FRAMES baked views, blended), plus a level card with its crown seen from above, so a forest holds up from the air.
//   Every variant of every species has its own row of one atlas, baked from its own mesh (bakeRow()). A region's impostors of every
//   species are one draw call. The same cards draw the trees past the loaded chunks (js/lod.js, through BF.real.lod.cards).
// - Geometry is built the first time a level is needed, at most one build a frame; batches are (re)built a few per frame, nearest
//   first, within config.budgetMs. A region keeps showing its old batches until the new ones are ready, so nothing blinks while
//   chunks stream in or a tree is felled.
// - BF.real.quality.level scales every distance (QUALITY below).
// Batches are direct scene children at their region's corner (atlas coordinates) with instance positions relative to it, so
// js/view.js places them from the floating origin (contract section 2).
// Light: a plant's sky and block light (the record's `extra`) go into its instance colour; the materials' own cell light stays open.
//
// API: BF.real.lod = { config, place(key, ox, oz, F), remove(key), clear(), update(camera), stats(), bake(), impostor, models,
//                      bandsOf(model), cards }
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
  // Tuned on the 1.6 models: a tree is about 4,400 triangles in full and 2,500 / 900 thinned, and a tuft of ground cover 36, so a
  // dense forest (10 trees a chunk) is about 2 million triangles of trees all round, under half of that in view, and ground cover
  // costs draw calls rather than triangles (two levels, variants only near the player). The full model reaches well past where a
  // walker looks at a tree. A tree never shares (3): it keeps its own variant all the way out, as a mesh and as a card.
  kinds: [
    { dist: [48, 100, 160], impostor: true, maxDist: 0, jitter: 0.2, share: 3 },
    { dist: [18, 44, 110], impostor: false, maxDist: 110, jitter: 0.4, share: 3 },
    { dist: [28, 72, 72], impostor: false, maxDist: 72, jitter: 0.5, share: 1 },
    { dist: [24, 60, 220], impostor: false, maxDist: 220, jitter: 0.3, share: 3 },
    { dist: [56, 110, 190], impostor: true, maxDist: 0, jitter: 0.2, share: 3 },
  ],
  // levels 1 and 2 of a model, from its level 0: the share of its wood (largest branches first) and of its leaf cards that stay, and
  // how much larger the leaf cards that stay are drawn (the crown keeps its cover). A part of fewer than minParts pieces is left whole.
  // The first step is small (walking up to a tree, the switch to the full model is the one seen closest).
  thin: { wood: [1, 0.6, 0.2], leaves: [1, 0.55, 0.2], grow: [1, 1.3, 2.0], minParts: 24 },
  fade: 0.25,             // a level gives way to the next over this share of the switch distance, dissolving pixel by pixel
  scale: 1,               // multiplies every distance (set from BF.real.quality.level each frame unless fixedScale)
  fixedScale: false,
  budgetMs: 2,            // batch building per frame
  keepMs: 4000,           // a batch no longer wanted is kept this long (walking back and forth across a band's edge)
  frames: 7, cellW: 64, cellH: 128,    // impostor atlas: directions per row (one more cell holds the view from above), pixels per cell
                          // (a 12-block tree is about 80 pixels tall where its card takes over)
  crown: 2.5,             // a tree stands this many blocks taller than its log column
  big: 1.5,               // a 2 x 2 trunk's tree is this much larger
  lean: 0.5,              // how far a ground plant leans with its slope: 0 straight up, 1 square to the ground
  sink: 0.12,             // and how far it goes into the ground, by the slope's rise per block (its downhill side must not hang)
  enabled: true,
};
const QUALITY = [0.55, 0.8, 1];   // config.scale by BF.real.quality.level
const MAXROW = 64;        // rows of the impostor atlas (one per variant of a species; the size of the shaders' row tables)
const VARROWS = 40;       // past this many rows a new variant shares a row of its species (a species always gets its first row)
const COLS = 2;           // rows side by side in the atlas
const STRIDE = 9;         // x, y, z (atlas), height, seed, sky light, block light, the ground's rise per block along x and z

const models = new Map(), modelById = [];   // "kind:species:variant" -> model
const rows = [];             // impostor atlas rows: the model each one is baked from
const toBake = [];           // rows not baked yet
const chunks = new Map();    // chunk key -> { rk, by: Map(model id -> Float32Array(n * STRIDE)) }
const regions = new Map();   // "rx,rz" -> region
let scene = null, builtThisFrame = false;
const st = { buildMs: 0, built: 0, pending: 0, drawn: 0, batches: 0, tris: 0, inst: 0, geo: 0 };

// ---------------------------------------------------------------- models
const HASH = "fract(sin(dot(P, vec2(12.9898, 78.233))) * 43758.5453) - 0.5";
// Across the last part of its band (rlFadeW of the switch distance) a level dissolves into the next: rlFade holds how far it has
// come in and how far it has gone out, and each pixel is kept by the level whose turn it is in a fixed screen pattern (FADE_FRAG), so
// the two levels never both draw a pixel and there is no moment at which the tree changes.
const CULL_VERT = `
rlFade = vec2(1.0, 0.0);
#ifdef USE_INSTANCING
{
  vec2 P = instanceMatrix[3].xz;
  float rlD = length((modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz) * (1.0 + rlJit * (${HASH}));
  float rlA = rlRange.x * (1.0 - rlFadeW);
  if (rlD < rlA || rlD >= rlRange.y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  rlFade = vec2(rlRange.x > 0.0 ? clamp((rlD - rlA) / (rlRange.x * rlFadeW), 0.0, 1.0) : 1.0, clamp((rlD - rlRange.y * (1.0 - rlFadeW)) / (rlRange.y * rlFadeW), 0.0, 1.0));
}
#endif
`;
const DITHER = "fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))";
const FADE_FRAG = `
{
  float rlN = ${DITHER};
  if (rlN >= rlFade.x || rlN < rlFade.y) discard;
}
`;
const fadeW = { value: config.fade };
const canCull = m => !m.isShaderMaterial || m.vertexShader.includes("#include <project_vertex>");
// A copy of a registry material for one level of one model: the same look, plus the per-instance distance band.
function levelMaterial(src, range, jit) {
  const m = src.clone();
  if (src.isShaderMaterial) m.uniforms = Object.assign({}, src.uniforms);   // (shared holders: the owner's wind, sun... keep driving it)
  const patch = sh => {
    if (!sh.vertexShader.includes("#include <project_vertex>")) return;
    sh.uniforms.rlRange = range; sh.uniforms.rlJit = jit; sh.uniforms.rlFadeW = fadeW;
    sh.vertexShader = "uniform vec2 rlRange;\nuniform float rlJit;\nuniform float rlFadeW;\nvarying vec2 rlFade;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>" + CULL_VERT);
    if (sh.fragmentShader.includes("#include <clipping_planes_fragment>"))
      sh.fragmentShader = "varying vec2 rlFade;\n" + sh.fragmentShader.replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>" + FADE_FRAG);
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
  M = { id: modelById.length, key, kind, def, variant, K, jit: { value: K.jitter }, lods: [null, null, null], modelH: def.modelHeight || (def.height ? (def.height[0] + def.height[1]) / 2 : 0), row: -1,
    cull: true, seed: (di * 7919 + variant * 104729 + 17) | 0, failed: false, flat: false };
  if (K.impostor) {
    // an atlas row of its own (a tree's card is its own variant's picture); when the atlas is nearly full, a row of its species
    const owner = rows.find(r => r.def === def);
    if (rows.length < (owner ? VARROWS : MAXROW)) { M.row = rows.length; rows.push(M); toBake.push(M); }
    else if (owner) M.row = owner.row;
  }
  models.set(key, M); modelById.push(M);
  // from its kind's share level on, a model is drawn as its entry's first variant (far enough that they can't be told apart): a
  // region then draws an entry's far plants in one batch per part, not one per variant
  M.far = variant === 0 || K.share > 2 ? M : modelOf(kind, def, 0);
  return M;
}
// The pieces of a geometry (sets of triangles that share no vertex: one per branch tube or leaf card), each with its triangles, its
// area and its middle.
function piecesOf(g) {
  const pos = g.attributes.position, ix = g.index ? g.index.array : null;
  if (!ix) return null;
  const n = pos.count, par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let i = 0; i < ix.length; i += 3) { const a = find(ix[i]); par[find(ix[i + 1])] = a; par[find(ix[i + 2])] = a; }
  const of = new Map(), list = [];
  for (let i = 0; i < ix.length; i += 3) {
    const r = find(ix[i]);
    let c = of.get(r);
    if (!c) { of.set(r, c = { tris: [], area: 0, nv: 0, cx: 0, cy: 0, cz: 0 }); list.push(c); }
    c.tris.push(i);
    const a = ix[i], b = ix[i + 1], d = ix[i + 2];
    const ux = pos.getX(b) - pos.getX(a), uy = pos.getY(b) - pos.getY(a), uz = pos.getZ(b) - pos.getZ(a);
    const vx = pos.getX(d) - pos.getX(a), vy = pos.getY(d) - pos.getY(a), vz = pos.getZ(d) - pos.getZ(a);
    c.area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  for (let v = 0; v < n; v++) { const c = of.get(find(v)); if (c) { c.nv++; c.cx += pos.getX(v); c.cy += pos.getY(v); c.cz += pos.getZ(v); } }
  for (const c of list) { c.cx /= c.nv; c.cy /= c.nv; c.cz /= c.nv; }
  return list;
}
// A geometry with only the pieces `keep` picks (a list of piecesOf's), each scaled by `grow` about its middle.
function subset(g, keep, grow) {
  const ix = g.index.array, n = g.attributes.position.count, map = new Int32Array(n).fill(-1), from = [], centre = [], idx = [];
  for (const c of keep) for (const t of c.tris) for (let k = 0; k < 3; k++) {
    const v = ix[t + k];
    if (map[v] < 0) { map[v] = from.length; from.push(v); centre.push(c); }
    idx.push(map[v]);
  }
  const out = new THREE.BufferGeometry();
  for (const name in g.attributes) {
    const a = g.attributes[name], m = a.itemSize, arr = new a.array.constructor(from.length * m);
    for (let i = 0; i < from.length; i++) for (let k = 0; k < m; k++) arr[i * m + k] = a.array[from[i] * m + k];
    if (name === "position" && grow !== 1) for (let i = 0; i < from.length; i++) {
      const c = centre[i];
      arr[i * 3] = c.cx + (arr[i * 3] - c.cx) * grow; arr[i * 3 + 1] = c.cy + (arr[i * 3 + 1] - c.cy) * grow; arr[i * 3 + 2] = c.cz + (arr[i * 3 + 2] - c.cz) * grow;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, m, a.normalized));
  }
  out.setIndex(idx);
  out.computeBoundingBox();
  return out;
}
// Level `lod` (1 or 2) of a level-0 part: the same mesh with less in it. Wood keeps its largest pieces (the trunk and main limbs: the
// twigs go first); leaves keep an even share of their cards, drawn larger. A part too simple to thin comes back as it is.
function thin(part, lod, leafy) {
  const T = config.thin, P = part.pieces;
  if (!P || P.length < T.minParts) return part.geometry;
  if (part.foliage) {
    const f = T.leaves[lod], keep = P.filter((c, i) => (i * 0.6180339887) % 1 < f);
    return keep.length ? subset(part.geometry, keep, T.grow[lod]) : part.geometry;
  }
  if (!leafy) return part.geometry;   // (a cactus or a bare tree is all wood: its shape is its branches)
  const total = P.reduce((a, c) => a + c.tris.length, 0), keep = [];
  let got = 0;
  for (const c of P.slice().sort((a, b) => b.area - a.area)) { if (got >= total * T.wood[lod] && keep.length) break; keep.push(c); got += c.tris.length; }
  return subset(part.geometry, keep, 1);
}
// Level i of a model, built on first use: [{geometry, material, depthMaterial}] plus its band uniform and triangle count. Level 0 is
// the registry's model; levels 1 and 2 are thinned from it.
function levelOf(M, i) {
  if (M.lods[i]) return M.lods[i];
  if (M.failed) return null;
  const range = { value: new THREE.Vector2(0, 1e9) }, count = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  if (i > 0) {
    const L0 = levelOf(M, 0);
    if (!L0) return null;
    const leafy = L0.parts.some(p => p.foliage);
    let tris = 0;
    const parts = L0.parts.map(p => {
      const g = thin(p, i, leafy);
      tris += count(g);
      return { geometry: g, src: p.src, foliage: p.foliage, material: levelMaterial(p.src, range, M.jit), depthMaterial: p.depthMaterial };
    });
    return (M.lods[i] = { parts, range, tris });
  }
  let out;
  try { out = M.def.build(mulberry(M.seed), 0); } catch (e) { console.error("BF.real.lod: build failed for " + (M.def.id || M.key), e); M.failed = true; return null; }
  st.geo++; builtThisFrame = true;
  const named = out && out.isBufferGeometry ? [["one", out]] : Object.keys(out || {}).filter(k => out[k] && out[k].isBufferGeometry).map(k => [k, out[k]])
    .filter(([, g]) => g.attributes.position && (g.index ? g.index.count : g.attributes.position.count) > 0);   // (a leafless tree's foliage is empty)
  if (!named.length) { M.failed = true; return null; }
  let tris = 0, top = 0;
  const parts = named.map(([name, g]) => {
    const src = partMaterial(M.def, name);
    if (!canCull(src)) M.cull = false;
    tris += count(g);
    if (!g.boundingBox) g.computeBoundingBox();
    top = Math.max(top, g.boundingBox.max.y);
    return { geometry: g, src, foliage: name === "foliage", pieces: piecesOf(g), material: levelMaterial(src, range, M.jit), depthMaterial: (out.depth && out.depth[name]) || null };
  });
  if (!M.modelH) M.modelH = top || 1;   // (an entry that doesn't declare its model's height: measured)
  // a model with nothing to thin is one mesh at every distance: its levels below the share level are drawn as level 0 (bandsOf)
  const leafy = parts.some(p => p.foliage);
  M.flat = parts.every(p => thin(p, 1, leafy) === p.geometry);
  return (M.lods[0] = { parts, range, tris });
}
// A plant's scale from its record, as the foundation's simple placer sizes it: a tree's model reaches a little past its log column
// (the crown the leaf blocks made), a big tree (2 x 2 trunk) is half as large again; the rest keep the model's size. All vary a little.
function scaleOf(M, height, seed) {
  const v = (seed * 13.7) % 1;
  if (M.kind === TREE || M.kind === BIG) return (height + config.crown) / (M.modelH || 1) * (0.92 + 0.16 * v) * (M.kind === BIG ? config.big : 1);
  return 0.85 + 0.3 * v;
}

// The distance bands of a model at the current settings: [from, to) of mesh levels 0 to 2, then the impostor's (or null).
const ready = M => M.row >= 0 && cardU.uRow.value[M.row].y > 0;   // its card is baked
function bandsOf(M) {
  const k = config.scale, K = M.K, end = K.maxDist ? K.maxDist * k : 1e9, card = ready(M), to = [0, 0, 0], out = [];
  for (let i = 0; i < 3; i++) to[i] = i === 2 && !card ? end : Math.min(end, K.dist[i] * k);
  // (a model that can't be thinned: each level below the share level is the same mesh as the one before, which draws its band too)
  if (M.flat) for (let i = 2; i >= 1; i--) if (i < K.share) to[i - 1] = to[i];
  let from = 0;
  for (let i = 0; i < 3; i++) { out.push([from, Math.max(from, to[i])]); from = Math.max(from, to[i]); }
  out.push(card ? [from, Math.max(from, end)] : null);
  return out;
}

// ---------------------------------------------------------------- impostors
// A tree as cards (shared with js/lod.js, which draws the trees past the loaded chunks with them: BF.real.lod.cards). Per atlas row,
// uRow holds the model's size (crown radius, height, lowest point, crown height above the foot; a height of 0: not baked yet, nothing
// is drawn) and uRowCol its average colour (for trees a few pixels tall).
const cardU = { map: { value: null }, uGrid: { value: new THREE.Vector3(config.frames, COLS, 4) }, uRow: { value: [] }, uRowCol: { value: [] } };
for (let i = 0; i < MAXROW; i++) { cardU.uRow.value.push(new THREE.Vector4()); cardU.uRowCol.value.push(new THREE.Vector3()); }
// rlCard(): the view-space place of one corner of a tree's cards (w = 0: not drawn). foot, up, xV, zV: the tree's foot and the
// world's up, x and z axes in view space; corner: x -1..1, y 0..1, z 0 for the upright card or 1 for the level one; s: the tree's
// scale; yaw: its turn.
// The upright card faces the camera round the tree's axis and shows it from that side (the two nearest baked views, blended by
// vMix); it leans back as the camera rises, so it isn't seen edge-on from the air. The level card lies in the crown and shows the
// tree from above; it is drawn once the camera is well above the tree, and the upright one is dropped straight overhead.
const CARD_VERT = `
uniform vec4 uRow[${MAXROW}];
uniform vec3 uGrid;   // views round the tree, rows side by side, lines of rows
varying vec2 vUv;
varying vec2 vUv2;
varying float vMix;
varying float vX;
varying float vTop;
varying float vY;      // height on the upright card, 0 to 1
varying float vLean;   // how far the upright card's normal leans up: more from above, where the crown's sunlit top is what shows
varying float vShow;   // how much of the card is drawn (dithered): the level card comes in as the eye rises, the upright one goes
varying vec3 vRight;
varying vec3 vFront;
varying vec3 vUp;
varying vec3 vCam;     // from the tree's foot to the eye
vec4 rlCard(vec3 foot, vec3 up, vec3 xV, vec3 zV, vec3 corner, float row, float s, float yaw) {
  vec4 I = uRow[int(row + 0.5)];
  if (I.y <= 0.0) return vec4(0.0);
  vec3 toCam = normalize(-foot);
  float el = dot(toCam, up);
  vec3 side = cross(up, toCam);
  float sl = length(side);
  vec3 right = sl > 1e-3 ? side / sl : xV;
  vec3 front = cross(right, up);
  float cells = uGrid.x + 1.0, col = mod(floor(row + 0.5), uGrid.y), line = floor((row + 0.5) / uGrid.y);
  vX = corner.x; vY = corner.y; vTop = corner.z; vRight = right; vFront = front; vUp = up; vCam = toCam;
  if (corner.z < 0.5) {
    if (el > 0.93) return vec4(0.0);
    vShow = 1.0 - smoothstep(0.8, 0.93, el);
    vLean = 0.45 + 0.7 * max(el, 0.0);
    float fr = fract((atan(dot(toCam, xV), dot(toCam, zV)) - yaw) / 6.2831853) * uGrid.x;
    float f0 = floor(fr), f1 = mod(f0 + 1.0, uGrid.x), v = (line + 0.02 + corner.y * 0.96) / uGrid.z;
    vMix = smoothstep(0.25, 0.75, fr - f0);
    vUv = vec2((col * cells + f0 + 0.5 + corner.x * 0.48) / (uGrid.y * cells), v);
    vUv2 = vec2((col * cells + f1 + 0.5 + corner.x * 0.48) / (uGrid.y * cells), v);
    float a = el > 0.0 ? min(asin(min(el, 1.0)), 1.0) * 0.8 : 0.0;
    vec3 upC = up * cos(a) - front * sin(a);
    return vec4(foot + up * ((I.z + 0.5 * I.y) * s) + right * (corner.x * I.x * s) + upC * ((corner.y - 0.5) * I.y * s), 1.0);
  }
  if (el < 0.3) return vec4(0.0);
  vShow = smoothstep(0.3, 0.62, el);
  float c = cos(yaw), sn = sin(yaw), z = corner.y * 2.0 - 1.0;
  vec3 xT = xV * c - zV * sn, zT = xV * sn + zV * c;
  vMix = 0.0;
  vUv = vec2((col * cells + uGrid.x + 0.5 - corner.x * 0.48) / (uGrid.y * cells), (line + (0.5 + z * 0.48) * CARD_SQUARE) / uGrid.z);
  vUv2 = vUv;
  return vec4(foot + up * (I.w * s) + (xT * corner.x + zT * z) * (I.x * s), 1.0);
}`;
// rlCardTexel(): the card's baked surface colour (sRGB) and cover. rlCardNormal(): the card shaded as the round crown it stands for
// (a normal that turns from one edge to the other and leans up; straight up on the level card), so a tree lit from one side stays lit
// from that side as a card and a backlit forest stays dark: the switch from mesh to card doesn't change a tree's brightness.
const CARD_FRAG = `
uniform sampler2D map;
varying vec2 vUv;
varying vec2 vUv2;
varying float vMix;
varying float vX;
varying float vTop;
varying float vY;      // height on the upright card, 0 to 1
varying float vLean;   // how far the upright card's normal leans up: more from above, where the crown's sunlit top is what shows
varying float vShow;   // how much of the card is drawn (dithered): the level card comes in as the eye rises, the upright one goes
varying vec3 vRight;
varying vec3 vFront;
varying vec3 vUp;
varying vec3 vCam;
vec4 rlCardTexel() {
  vec4 c = texture2D(map, vUv);
  if (vMix > 0.0) c = mix(c, texture2D(map, vUv2), vMix);
  if (${DITHER} >= vShow) c.a = 0.0;
  return c;
}
vec3 rlCardNormal() {
  if (vTop > 0.5) return normalize(vUp);
  float x = clamp(vX, -1.0, 1.0) * 0.85;
  // (a crown is lit from above and dim underneath: the normal turns up with height on the card)
  return normalize(vRight * x + vFront * sqrt(1.0 - x * x) + vUp * (vLean * (2.0 * vY - 0.35)));
}`;
// rlCardGlow(sunV): the sun coming through the leaves towards the eye, as the models' foliage has it (js/real/assets-kit.js
// TRANS_GLSL, trees' share 0.3), as a share of the sun's colour to add to the light: a tree seen against the sun is as light as a card
// as it is as a model.
const CARD_GLOW = `
vec3 rlCardGlow(vec3 sunV) {
  float tB = clamp(dot(-normalize(vCam), sunV), 0.0, 1.0);
  return vec3(0.45, 0.43, 0.19) * (0.3 * tB * tB);
}`;
const CARD_DEFINES = () => ({ CARD_SQUARE: (config.cellW / config.cellH).toFixed(4) });
// the two cards of a tree: corners as rlCard takes them
const CARD_QUADS = { pos: new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0, -1, 0, 1, 1, 0, 1, 1, 1, 1, -1, 1, 1]), idx: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] };

const IMP_VERT = `
attribute vec4 iA;   // x, y, z (from the region's corner), yaw
attribute vec3 iB;   // scale, atlas row, kind
attribute vec3 iC;   // tint
uniform vec2 uRange[5];   // by kind: the cards' band of distance
uniform float uJit[5];
uniform float rlFadeW;
varying vec3 vTint;
varying float vFade;
#include <fog_pars_vertex>
` + CARD_VERT + `
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iA.xyz, 1.0);
  int kind = int(iB.z + 0.5);
  vec2 P = iA.xz;
  float d = length(mvPosition.xyz) * (1.0 + uJit[kind] * (${HASH}));
  vec3 up = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 xV = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz), zV = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec4 q = rlCard(mvPosition.xyz, up, xV, zV, position, iB.y, iB.x, iA.w);
  vTint = iC;
  mvPosition.xyz = q.xyz;
  gl_Position = projectionMatrix * mvPosition;
  // (the card comes in as the last mesh level goes out: CULL_VERT)
  float a = uRange[kind].x * (1.0 - rlFadeW);
  vFade = clamp((d - a) / (uRange[kind].x * rlFadeW), 0.0, 1.0);
  if (q.w < 0.5 || d < a || d >= uRange[kind].y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <fog_vertex>
}`;
const IMP_FRAG = `
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
varying vec3 vTint;
varying float vFade;
#include <common>
#include <fog_pars_fragment>
` + CARD_FRAG + CARD_GLOW + `
void main() {
  if (${DITHER} >= vFade) discard;
  vec4 c = rlCardTexel();
  if (c.a < 0.4) discard;
  vec3 n = rlCardNormal();
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  // (a crown lets the sun through: its far side isn't black)
  vec3 light = mix(uGroundCol, uSkyCol, 0.5 + 0.5 * dot(n, normalize(vUp))) + uSunCol * (max(dot(n, sunV), 0.0) + 0.3 * max(-dot(n, sunV), 0.0) + rlCardGlow(sunV));
  gl_FragColor = vec4(pow(c.rgb, vec3(2.2)) * vTint * light, 1.0);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
  #include <fog_fragment>
}`;
const imp = { baked: [], material: null, atlas: null, data: null, lines: 0, rows: 0, dirty: false, flushed: 0, waiting: [], rt: null, scene: null };
function impostorMaterial() {
  if (imp.material) return imp.material;
  const ranges = [], jits = [];
  for (let i = 0; i < 5; i++) { ranges.push(new THREE.Vector2(1e9, 1e9)); jits.push(0); }
  const U = real.U;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uRange: { value: ranges }, uJit: { value: jits } }]);
  Object.assign(uniforms, cardU);
  uniforms.rlFadeW = fadeW;
  uniforms.uSunCol = U.uSunCol; uniforms.uSunDir = U.uSunDir; uniforms.uSkyCol = U.uSkyCol; uniforms.uGroundCol = U.uGroundCol;   // (shared by reference, contract section 3)
  imp.material = new THREE.ShaderMaterial({ uniforms, defines: CARD_DEFINES(), vertexShader: IMP_VERT, fragmentShader: IMP_FRAG, fog: true, side: THREE.DoubleSide });
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

// The atlas: COLS rows side by side, each FRAMES views round the tree and one from above; lines of rows are added as species are met
// (the texture doubles in height when it runs out).
function atlasFor(nRows) {
  const W = COLS * (config.frames + 1) * config.cellW, need = Math.ceil(nRows / COLS);
  let lines = imp.lines || 4;
  while (lines < need) lines *= 2;
  if (imp.data && lines === imp.lines) return;
  const data = new Uint8Array(W * lines * config.cellH * 4);
  if (imp.data) data.set(imp.data);
  const tex = new THREE.DataTexture(data, W, lines * config.cellH, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  const mips = [{ data, width: W, height: lines * config.cellH }];
  for (let w = W, h = lines * config.cellH; w > 1 || h > 1;) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); mips.push({ data: new Uint8Array(w * h * 4), width: w, height: h }); }
  tex.mipmaps = mips;
  if (imp.atlas) imp.atlas.dispose();
  imp.atlas = tex; imp.data = data; imp.lines = lines;
  cardU.map.value = tex; cardU.uGrid.value.set(config.frames, COLS, lines);
  for (const row of imp.baked) mipRow(row);
}
// A row's smaller copies (the atlas' mip levels), made here and not by the graphics card: a tree far off is drawn from them, and plain
// halving would leave it thin and dark (a crown's gaps averaged in: fewer texels pass the cards' alpha test, and the empty texels'
// black gets into the leaves' colour). Colour is averaged by cover, and each line of a view has its cover scaled so the share of it that
// passes the test (0.4) stays the share that passes in the full picture.
const CUT = 102;   // 0.4 of 255: the cards' alpha test
function mipRow(row) {
  const F = config.frames, cw = config.cellW, ch = config.cellH, W = (F + 1) * cw, m = imp.atlas.mipmaps;
  const x0 = (row % COLS) * W, y0 = Math.floor(row / COLS) * ch;
  for (let l = 1; l < m.length; l++) {
    const S = m[l - 1], D = m[l], sd = S.data, dd = D.data;
    const X = x0 >> l, Y = y0 >> l, w = Math.min(D.width - X, Math.max(1, W >> l)), h = Math.min(D.height - Y, Math.max(1, ch >> l));
    for (let y = Y; y < Y + h; y++) for (let x = X; x < X + w; x++) {
      let r = 0, g = 0, b = 0, a = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const o = (Math.min(S.height - 1, 2 * y + (k >> 1)) * S.width + Math.min(S.width - 1, 2 * x + (k & 1))) * 4, wt = sd[o + 3] + 1;
        r += sd[o] * wt; g += sd[o + 1] * wt; b += sd[o + 2] * wt; a += sd[o + 3]; ws += wt;
      }
      const o = (y * D.width + x) * 4;
      dd[o] = r / ws; dd[o + 1] = g / ws; dd[o + 2] = b / ws; dd[o + 3] = a / 4;
    }
    // each line of each view keeps the share of its texels that pass in the full picture (one at least where any does: a trunk a
    // texel wide stays), by scaling the line's cover
    const c = cw >> l, d0 = m[0].data, w0 = m[0].width, n0 = 1 << l;
    if (c < 1) continue;
    const line = new Uint8Array(c);
    for (let f = 0; f <= F; f++) {
      const hh = (f < F ? ch : cw) >> l, xa = X + f * c;
      for (let y = 0; y < hh; y++) {
        let pass = 0;
        for (let yy = 0; yy < n0; yy++) for (let xx = 0; xx < cw; xx++) if (d0[((y0 + y * n0 + yy) * w0 + x0 + f * cw + xx) * 4 + 3] >= CUT) pass++;
        if (!pass) continue;
        const want = Math.max(1, Math.round(pass / (cw * n0) * c)), o = ((Y + y) * D.width + xa) * 4 + 3;
        for (let x = 0; x < c; x++) line[x] = dd[o + x * 4];
        line.sort();
        const at = line[c - want];
        if (at >= CUT || !at) continue;
        const k = Math.min(16, CUT / at);
        for (let x = 0; x < c; x++) dd[o + x * 4] = Math.min(255, Math.ceil(dd[o + x * 4] * k));
      }
    }
  }
}
// Bakes one row: the model's medium mesh from FRAMES directions round it and from above, lit from above and white so the card holds
// surface colour. Needs the renderer. False while it can't be done yet (no renderer, or the mesh's geometry has to wait a frame).
function bakeRow(M) {
  const R = real.renderer || BF.renderer;
  if (!R) return false;
  if (!M.lods[0] && builtThisFrame) return false;
  const L = levelOf(M, 1) || levelOf(M, 0);
  if (!L) return true;
  const F = config.frames, cw = config.cellW, ch = config.cellH, W = (F + 1) * cw, row = M.row;
  atlasFor(rows.length);
  if (!imp.rt) {
    imp.rt = new THREE.WebGLRenderTarget(W, ch, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat });
    imp.rt.texture.encoding = THREE.sRGBEncoding;
    const bs = (imp.scene = new THREE.Scene());
    bs.add(new THREE.AmbientLight(0xffffff, 0.6));
    imp.sun = new THREE.DirectionalLight(0xffffff, 0.55); bs.add(imp.sun); bs.add(imp.sun.target);
    imp.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  }
  const rt = imp.rt, bs = imp.scene, sun = imp.sun, cam = imp.cam;
  const prev = { rt: R.getRenderTarget(), color: R.getClearColor(new THREE.Color()), alpha: R.getClearAlpha(), auto: R.autoClear, tone: R.toneMapping,
    shadow: R.shadowMap.autoUpdate };
  R.shadowMap.autoUpdate = false; R.toneMapping = THREE.NoToneMapping;
  R.setClearColor(0x000000, 0); R.autoClear = false;
  rt.scissorTest = false; rt.viewport.set(0, 0, W, ch);
  R.setRenderTarget(rt); R.clear(true, true, true);
  // (the registry's own materials: a level's copy would cut the tree by the bake camera's distance)
  const srcs = L.parts.map(p => { const m = new THREE.Mesh(p.geometry, p.src); m.frustumCulled = false; bs.add(m); return m; });
  const box = new THREE.Box3();
  let rad = 0, cy = 0, cn = 0;
  for (const p of L.parts) {
    box.union(p.geometry.boundingBox);
    const a = p.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) rad = Math.max(rad, Math.hypot(a.getX(i), a.getZ(i)));
    if (p.foliage) for (let i = 0; i < a.count; i++) { cy += a.getY(i); cn++; }
  }
  rad *= 1.04;
  const y0 = box.min.y, hgt = (box.max.y - box.min.y) * 1.04, D = rad * 4 + hgt + 10;
  rt.scissorTest = true;
  for (let f = 0; f <= F; f++) {
    if (f < F) {
      const a = f / F * Math.PI * 2;
      cam.left = -rad; cam.right = rad; cam.bottom = y0; cam.top = y0 + hgt;
      cam.position.set(Math.sin(a) * D, 0, Math.cos(a) * D); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0);
      sun.position.set(Math.sin(a) * D, D * 1.8, Math.cos(a) * D);   // (from above, on the camera's side: the crown's clumps keep their lit tops and dim undersides, so a card reads as a tree with depth)
      rt.viewport.set(f * cw, 0, cw, ch); rt.scissor.set(f * cw, 0, cw, ch);
    } else {
      // from above, x to the left and z up the picture (rlCard's level card reads it so)
      cam.left = -rad; cam.right = rad; cam.bottom = -rad; cam.top = rad;
      cam.position.set(0, y0 + hgt + D, 0); cam.up.set(0, 0, 1); cam.lookAt(0, 0, 0);
      sun.position.set(D * 0.3, D, D * 0.3);
      rt.viewport.set(f * cw, 0, cw, cw); rt.scissor.set(f * cw, 0, cw, cw);
    }
    cam.near = 0.1; cam.far = D * 3; cam.updateProjectionMatrix();
    R.setRenderTarget(rt);
    R.clearDepth();
    R.render(bs, cam);
  }
  for (const m of srcs) bs.remove(m);
  let px = new Uint8Array(W * ch * 4);
  R.readRenderTargetPixels(rt, 0, 0, W, ch, px);
  R.setRenderTarget(prev.rt); R.setClearColor(prev.color, prev.alpha); R.autoClear = prev.auto; R.toneMapping = prev.tone; R.shadowMap.autoUpdate = prev.shadow;
  // the tree's average colour (linear, as the cards' shader reads the atlas)
  let cr = 0, cg = 0, cb = 0, n = 0;
  for (let o = 0; o < px.length; o += 4) if (px[o + 3] > 127) { cr += Math.pow(px[o] / 255, 2.2); cg += Math.pow(px[o + 1] / 255, 2.2); cb += Math.pow(px[o + 2] / 255, 2.2); n++; }
  px = dilate(px, W, ch, 4);
  const AW = COLS * W, x0 = (row % COLS) * W, y1 = Math.floor(row / COLS) * ch;
  for (let y = 0; y < ch; y++) imp.data.set(px.subarray(y * W * 4, (y + 1) * W * 4), ((y1 + y) * AW + x0) * 4);
  imp.baked.push(row); mipRow(row);
  imp.dirty = true;
  imp.waiting.push({ row, info: [rad, hgt, y0, cn ? cy / cn : y0 + hgt * 0.6], col: n ? [cr / n, cg / n, cb / n] : [0.1, 0.2, 0.05] });
  return true;
}
// Bakes the rows that wait (one a frame), and shows the baked ones once the atlas is uploaded with them (a few times a second at most:
// the whole texture goes up again).
function bake(all) {
  let did = false;
  while (toBake.length && (all || !did)) {
    if (!bakeRow(toBake[0])) break;
    toBake.shift(); did = true;
  }
  const now = performance.now();
  if (imp.dirty && (all || now - imp.flushed > 250)) {
    imp.atlas.needsUpdate = true; imp.dirty = false; imp.flushed = now; imp.rows = rows.length;
    for (const w of imp.waiting) { cardU.uRow.value[w.row].set(w.info[0], w.info[1], w.info[2], w.info[3]); cardU.uRowCol.value[w.row].set(w.col[0], w.col[1], w.col[2]); }
    imp.waiting.length = 0;
  }
  return !toBake.length;
}
// For the trees past the loaded chunks (js/lod.js): the atlas row and scale of the tree a flora record would give ([row, scale], or
// null when the registry has no tree for it). far: its species' first variant (a few pixels tall, variants can't be told apart).
function cardFor(kind, block, biomeName, logs, seed, far) {
  let M = modelFor(kind, block, biomeName, logs, seed);
  if (!M || !M.K.impostor) return null;
  if (far && M.variant) M = modelOf(kind, M.def, 0);
  if (M.row < 0) return null;
  return [M.row, scaleOf(M, logs, seed)];
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
const seat = [0, 0, 0];
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
    real.seat(ex, seat);   // (on a slope the smooth ground is not at the block top: the plant stands on the ground)
    a[q] = ox + F[o]; a[q + 1] = F[o + 1] + seat[0]; a[q + 2] = oz + F[o + 2]; a[q + 3] = F[o + 5]; a[q + 4] = F[o + 6];
    a[q + 5] = skyOf(ex); a[q + 6] = blockOf(ex); a[q + 7] = seat[1]; a[q + 8] = seat[2];
    if (M.kind === COVER) a[q + 1] -= config.sink * Math.hypot(seat[1], seat[2]);
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
      if (M.kind === COVER && (a[i + 7] || a[i + 8])) {
        // a ground plant leans with its slope: its up axis goes part of the way (config.lean) from straight up to the ground's normal
        let ux = -a[i + 7] * config.lean, uz = -a[i + 8] * config.lean;
        const uy = 1 / Math.hypot(ux, 1, uz), k = 1 / (1 + uy);
        ux *= uy; uz *= uy;
        const xx = 1 - ux * ux * k, xz = -ux * uz * k, zz = 1 - uz * uz * k;   // the turn that takes up to (ux, uy, uz)
        mats[o] = c * xx - sn * xz; mats[o + 1] = -c * ux + sn * uz; mats[o + 2] = c * xz - sn * zz;
        mats[o + 4] = s * ux; mats[o + 5] = s * uy; mats[o + 6] = s * uz;
        mats[o + 8] = sn * xx + c * xz; mats[o + 9] = -sn * ux - c * uz; mats[o + 10] = sn * xz + c * zz;
      }
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
  for (const [id, c] of r.count) if (modelById[id].row >= 0) n += c;
  const b = { ver: r.ver, meshes: [], n, tris: n * 4, last: 0 };
  if (!n) return b;
  const A = new Float32Array(n * 4), B = new Float32Array(n * 3), C = new Float32Array(n * 3);
  let o = 0, q = 0;
  for (const k of r.chunks) for (const [id, a] of chunks.get(k).by) {
    const M = modelById[id];
    if (M.row < 0) continue;
    for (let i = 0; i < a.length; i += STRIDE) {
      A[o] = a[i] - r.ox; A[o + 1] = a[i + 1] - r.oy; A[o + 2] = a[i + 2] - r.oz; A[o + 3] = a[i + 4] * 6.2831853;
      B[q] = scaleOf(M, a[i + 3], a[i + 4]); B[q + 1] = M.row; B[q + 2] = M.kind;
      tintOf(a, i, C, q);
      o += 4; q += 3;
    }
  }
  const mat = impostorMaterial(), g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(CARD_QUADS.pos, 3));
  g.setIndex(CARD_QUADS.idx);
  g.setAttribute("iA", new THREE.InstancedBufferAttribute(A, 4));
  g.setAttribute("iB", new THREE.InstancedBufferAttribute(B, 3));
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
  fadeW.value = Math.max(0.001, config.fade);
  if (toBake.length || imp.dirty) bake();
  // this frame's bands
  const mat = imp.material, bands = [];
  for (const M of modelById) {
    const bd = bandsOf(M); bands.push(bd);
    for (let i = 0; i < 3; i++) if (M.lods[i]) M.lods[i].range.value.set(bd[i][0], bd[i][1]);
  }
  // (cards: from the end of the last mesh level, the same for every model of a kind; a tree whose card isn't baked yet stays a mesh)
  if (mat) config.kinds.forEach((K, i) => {
    if (!K.impostor) return;
    mat.uniforms.uRange.value[i].set(K.dist[2] * config.scale, K.maxDist ? K.maxDist * config.scale : 1e9);
    mat.uniforms.uJit.value[i] = K.jitter;
  });
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
        const hit = M.cull ? rc.min * (1 - j) < band[1] && rc.max * (1 + j) >= band[0] * (1 - fadeW.value) : rc.mid >= band[0] && rc.mid < band[1];
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

real.lod = { config, models, place, remove, clear, update, stats, bake, impostor: imp, bandsOf,
  cards: { uniforms: cardU, VERT: CARD_VERT, FRAG: CARD_FRAG + CARD_GLOW, defines: CARD_DEFINES, quads: CARD_QUADS, rowOf: cardFor, MAXROW } };
// Take over the flora placer (contract section 4): now, and again at init in case the foundation's placer was installed after this file.
function takeOver() { real.flora = real.flora || {}; real.flora.place = place; real.flora.remove = remove; }
takeOver();
real.module({
  name: "lod",
  init(ctx) { scene = ctx.scene; takeOver(); },
  frame() { update(real.camera || BF.camera); },
});
})();
