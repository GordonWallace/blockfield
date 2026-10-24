// World storage, progressive chunk loading, meshing, edits, raycasting and collision.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const CS = 16;      // chunk width/depth
// World limits (BF.MIN_Y lowest y, BF.H exclusive top, BF.SEA sea level, BF.SY0/SY1 section range) are the mile-high ones,
// -64 / 3072 / 0, set by BF.setLimits() (js/worldgen.js, again by worldgen.init). Read them at call time. See docs/MILE_HIGH_CONTRACT.md.
if (!BF.setLimits) BF.setLimits = () => {
  BF.MIN_Y = -64; BF.H = 3072; BF.SEA = 0; BF.SY0 = BF.MIN_Y >> 4; BF.SY1 = BF.H >> 4;
};
if (BF.H == null) BF.setLimits();
BF.CS = CS;

// A chunk is a 16x16 column of 16-high sections. c.secs[sy - c.lo] is a Uint16Array(4096) (index (ly << 8 | lz << 4 | lx)) or a
// number (the whole section is that block id). Sections outside [c.lo, c.hi) are not loaded: below = stone, above = air.
const SECN = 4096;

// ---------- shared memory (spec r15-35) ----------
// Section arrays (blocks here, block light in js/light.js, sky light in js/skylight.js) are allocated by BF.secArray: on a
// SharedArrayBuffer when the page is cross-origin isolated (debug/server.js, so ./run.sh, sends the COOP / COEP headers), so simulation
// workers can read blocks without copying (r15-38, r15-39); else (opened as a file, the Artifact, a server without the headers) on an
// ordinary ArrayBuffer. The views are the same typed arrays either way, so no other code changes.
// Write rule: only the thread that owns a chunk writes its arrays (the main thread, until r15-39 gives regions to workers). Other threads
// read start-of-tick state (the two-phase tick, r15-17): they never read while the owner writes, so there are no locks or Atomics.
// Saves hold block edits only (js/save.js), never section arrays; anything that does store or send one must copy it first (a.slice()
// returns an unshared copy), because IndexedDB can't store a SharedArrayBuffer in every browser, and postMessage would share it
// (and can't transfer it: meshJob(c, true) copies the sections it sends to the mesher workers, r15-03).
// An unloaded chunk's arrays are freed like any other object, once nothing references the chunk.
const SHARED = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
BF.shared = {
  on: SHARED,
  text: SHARED ? "Shared memory: on" : "Shared memory: off: page not isolated",
  // bytes of section arrays (blocks, block light, sky light) held by loaded chunks, and how many arrays
  usage() {
    let bytes = 0, arrays = 0;
    const add = list => { if (list) for (const a of list) if (a && typeof a === "object") { bytes += a.byteLength; arrays++; } };
    for (const c of world.chunks.values()) { add(c.secs); add(c.light); add(c.sky); }
    return { bytes, arrays };
  },
};
BF.secArray = SHARED
  ? (Ctor, n) => new Ctor(new SharedArrayBuffer(n * Ctor.BYTES_PER_ELEMENT))
  : (Ctor, n) => new Ctor(n);
const vIdx = (x, y, z) => (y * CS + z) * CS + x;      // index inside a legacy full-height window (y from 0)
BF.vIdx = vIdx;
const ckey = (cx, cz) => cx + "," + cz;

// ---------- the planet (generator 4): atlas coordinates (js/planet.js, specs r14-01 / r14-02) ----------
// On the planet every x/z is an atlas address: each face owns a square of the plane with its real grid in the middle and the unfolded
// neighbouring faces in the margin around it. Chunks, edits and every key are stored at canonical addresses only; the public block
// functions accept margin addresses and resolve them to the canonical cell (res), so neighbour walks, collision and meshing carry on
// across face edges. A block with a facing read through a margin address is turned by the edge's turn, so it looks and collides the
// same from both sides; written through one, it is turned back. Corner wedges (past two edges at once) read as air and refuse writes.
const PN = BF.planet.N, PW = 3 * PN;
let RX = 0, RZ = 0, RT = 0;          // res() output: canonical cell and quarter turns (margin frame = canonical frame turned by RT)
const CCELL = {};
function res(x, z) {                 // x, z integers
  RT = 0;
  const f = Math.floor(x / PW), u = x - PW * f - PN, v = z - PN;
  if (f >= 0 && f < 6 && u >= 0 && u < PN && v >= 0 && v < PN) { RX = x; RZ = z; return true; }
  const c = BF.planet.canonCell(x, z, CCELL);
  if (c.wedge || c.off) return false;
  RX = c.x; RZ = c.z; RT = c.turn;
  return true;
}
// The canonical chunk coordinates of chunk (cx, cz) (chunks line up across face edges, so a margin chunk shows one whole canonical
// chunk, turned), or null inside a corner wedge / off the atlas. Sets RT like res().
const CCH = [0, 0];
function resChunk(cx, cz) {
  if (!res(cx * CS + 8, cz * CS + 8)) return null;
  CCH[0] = Math.floor(RX / CS); CCH[1] = Math.floor(RZ / CS);
  return CCH;
}
// Block ids turned by k quarter turns (doors, beds, stairs, ladders, wall torches, gates, furnaces, chests, signs, tents), built on first use.
let TURN = null;
function turnOnce(id, k) {
  const b = BF.blocks[id];
  if (!b) return id;
  if (b.shape && b.shape.kind === "stairs") { const fam = BF.SHAPES && BF.SHAPES[b.shape.base]; const t = fam && fam.stairs[b.shape.top ? 1 : 0][(b.shape.f + k) & 3]; return t != null ? t : id; }
  if (b.sign) { const t = BF.B[b.sign.wood + (b.sign.wall ? "_wall_sign_" : "_sign_") + "nesw"[(b.sign.f + k) & 3]]; return t != null ? t : id; }
  if (b.tent) { const t = BF.B["tent_" + (b.tent.up ? "up_" : "") + b.tent.r + "_" + b.tent.l + "_" + "nesw"[(b.tent.f + k) & 3]]; return t != null ? t : id; }
  return BF.blueprints && BF.blueprints.rotId ? BF.blueprints.rotId(id, k) : id;
}
function turnId(id, k) {
  k &= 3;
  if (!k || !id) return id;
  if (!TURN) {
    if (!BF.blueprints) return turnOnce(id, k);   // (only before every pack has loaded)
    TURN = [null];
    for (let q = 1; q < 4; q++) { const a = new Uint16Array(BF.MAX_BLOCK + 1); for (let i = 0; i <= BF.MAX_BLOCK; i++) a[i] = turnOnce(i, q); TURN.push(a); }
  }
  return TURN[k][id];
}

const FACES = BF.mesher.FACES;   // (js/mesher.js)

const world = {
  chunks: new Map(),      // key -> chunk
  edits: new Map(),       // key -> Map(localIndex -> blockId); survives unloading
  viewDist: 6,
  queueLength: 0,
  _loadL: [], _viewLoadL: [], _unloadL: [],
  _dirty: new Set(),
  // The page's copy of a world simulated in a Web Worker (spec r15-38, js/simhost.js): chunks are generated and lit here as usual, but the
  // edits come from the simulation (applyEdits) and nothing here simulates: no village loading, and only the drawing's chunk-load hooks run.
  replica: false,
  _faceUV: null,
  daylight: 1,
  // The planet (spec r14-07): far chunks keep only their meshes (key -> meshes), and chunks load only while blocks are big enough to see:
  // up to chunkCeiling blocks above the ground, or less where a block is under a pixel (pxScale blocks: the screen's pixels per radian).
  farMeshes: new Map(),
  chunkCeiling: 1500,
  high: false,
};
BF.world = world;

// ---------- materials ----------
let solidMat, liquidMat, scene;
const dayUniform = { value: 1 };

world.init = function (sceneRef) {
  scene = sceneRef;
  const tex = BF.textures.build();
  solidMat = new THREE.MeshBasicMaterial({ map: tex.texture, vertexColors: true, alphaTest: 0.5, side: THREE.FrontSide });
  liquidMat = new THREE.MeshBasicMaterial({ map: tex.texture, vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
  // Precompute per-block per-face atlas rects.
  world._faceUV = [];
  for (const b of BF.blocks) {
    if (!b.tiles) continue;
    for (let f = 0; f < 6; f++) world._faceUV[b.id * 6 + f] = BF.textures.uv(b.tiles[f === (b.frontFace != null ? b.frontFace : 4) ? "front" : FACES[f].kind]);
  }
  // Biome tint per face: 0 none, 1 grass, 2 foliage, 3 water, 4 grass side (untinted dirt + tinted overlay quad)
  const tinted = BF.textures.tinted || {};
  const inList = (k, n) => Array.isArray(tinted[k]) && tinted[k].includes(n);
  world._faceTint = new Uint8Array((BF.MAX_BLOCK + 1) * 6);
  const hasOverlay = BF.textures.has ? BF.textures.has("grass_side_overlay") : false;
  world._overlayUV = hasOverlay ? BF.textures.uv("grass_side_overlay") : null;
  world._dirtUV = BF.textures.uv("dirt");
  for (const b of BF.blocks) {
    if (!b.tiles) continue;
    for (let f = 0; f < 6; f++) {
      const n = b.tiles[f === (b.frontFace != null ? b.frontFace : 4) ? "front" : FACES[f].kind];
      let t = 0;
      if (n === "grass_side" && hasOverlay) t = 4;
      else if (inList("grass", n)) t = 1;
      else if (inList("foliage", n)) t = 2;
      else if (inList("water", n)) t = 3;
      world._faceTint[b.id * 6 + f] = t;
    }
  }
  // Sky light is a per-vertex attribute scaled by the time of day in the shader,
  // so covered areas (caves, interiors) stay dim at noon and don't brighten at night.
  for (const m of [solidMat, liquidMat]) {
    m.onBeforeCompile = sh => {
      sh.uniforms.uDay = dayUniform;
      // bl: block light 0..1 (level / 15); > 1.5 marks an emissive part (torch flame): full brightness, no tint
      sh.vertexShader = "attribute float skyl;\nattribute float bl;\nvarying float vSky;\nvarying float vBl;\n" +
        sh.vertexShader.replace("#include <color_vertex>", "#include <color_vertex>\nvSky = skyl; vBl = bl;");
      sh.fragmentShader = "uniform float uDay;\nvarying float vSky;\nvarying float vBl;\n" +
        sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
{
  // deep cover is darker than the old flat 0.3 floor; open sky (vSky = 1) is unchanged
  float sk = max(0.1, vSky * (0.6 + 0.4 * smoothstep(0.3, 0.7, vSky)) * uDay);
  if (vBl > 1.5) { diffuseColor.rgb *= 1.0; }
  else {
    float bb = min(1.0, 1.1 * pow(clamp(vBl, 0.0, 1.0), 1.25));
    float w = smoothstep(sk * 0.6, sk * 1.2 + 0.05, bb);
    diffuseColor.rgb *= max(sk, bb) * mix(vec3(1.0), vec3(1.0, 0.85, 0.63), w);
  }
}`);
    };
  }
  world.solidMat = solidMat; world.liquidMat = liquidMat;
  TBL = null;   // the mesher's tables (face rects) are built again
};

// ---------- the round drawing (planet only) ----------
// On the planet every chunk mesh also carries where each vertex really is on the sphere ("sphere", relative to the chunk's
// anchor: its centre at sea level), and the shader mixes the flat and round positions by world.roundK (0 near the ground; near
// the cube corners js/view.js raises it so the three faces close up). The round position goes through a per-mesh matrix sphM
// (js/view.js sets it each frame, mapping the anchor-relative sphere into the mesh's own flat frame), so each planet mesh has
// its own copy of the material; the copies share one shader program.
const roundK = { value: 0 };
world.roundK = roundK;
world.dayUniform = dayUniform;   // distant terrain (js/lod.js) is lit like an open-sky block
// Debug face tints (js/view.js setDebug, the debug screen's Planet section): each face's chunks drawn in its own colour.
const faceTintOn = { value: 0 };
world.faceTintOn = faceTintOn;
const FACE_TINT = [[1, 0.55, 0.55], [0.55, 1, 0.55], [0.6, 0.7, 1], [1, 1, 0.5], [1, 0.6, 1], [0.5, 1, 1]];
function planetMaterial(base, face) {
  const m = base.clone();
  m.userData.planet = true;
  const sphM = { value: new THREE.Matrix4() };
  m.userData.sphM = sphM.value;
  const inner = base.onBeforeCompile;
  m.onBeforeCompile = sh => {
    inner(sh);
    sh.uniforms.uK = roundK; sh.uniforms.sphM = sphM;
    sh.uniforms.uTintOn = faceTintOn; sh.uniforms.uFaceCol = { value: new THREE.Vector3(...(FACE_TINT[face] || [1, 1, 1])) };
    sh.fragmentShader = "uniform float uTintOn;\nuniform vec3 uFaceCol;\n" + sh.fragmentShader.replace("#include <color_fragment>",
      "#include <color_fragment>\nif (uTintOn > 0.5) diffuseColor.rgb *= uFaceCol;");
    sh.vertexShader = "attribute vec3 sphere;\nuniform float uK;\nuniform mat4 sphM;\n" + sh.vertexShader.replace("#include <begin_vertex>",
      "vec3 transformed = vec3(position);\nif (uK > 0.0) transformed = mix(transformed, (sphM * vec4(sphere, 1.0)).xyz, uK);");
  };
  m.customProgramCacheKey = () => "bf-planet-" + (base === liquidMat ? "l" : "s");
  return m;
}
// Unit directions at the 17 x 17 block corners of the chunk at atlas (ox, oz), and its anchor (centre, sea level) on the sphere.
function sphereFrame(ox, oz) {
  const P = BF.planet, f = P.face(ox, oz), u0 = ox - PW * f - PN, v0 = oz - PN, dirs = new Float64Array(17 * 17 * 3), d = [0, 0, 0];
  for (let z = 0; z <= CS; z++) for (let x = 0; x <= CS; x++) {
    P.dir(f, u0 + x, v0 + z, d);
    const o = (z * 17 + x) * 3; dirs[o] = d[0]; dirs[o + 1] = d[1]; dirs[o + 2] = d[2];
  }
  return { dirs, anchor: P.pos(f, u0 + 8, v0 + 8, BF.SEA, [0, 0, 0]) };
}

// Render-space position of an atlas point this frame (js/view.js).
world.toRender = (x, y, z, out) => BF.view.toRender(x, y, z, out);

world.getBlockLight = (x, y, z) => (BF.light ? BF.light.get(x, y, z) : 0); // block light 0..15 (see light.js)

world.setDaylight = function (l) {
  world.daylight = l;
  dayUniform.value = l;
};

// fn(cx, cz, chunk) when a chunk is created. view: the hook draws (it runs in the page's copy of the world too, r15-38); the others are
// the simulation's (villages, wildlife, block entities...).
world.onChunkLoad = (fn, view) => { world._loadL.push(fn); if (view) world._viewLoadL.push(fn); };
// fn(chunk, editIndex, id) after every block change (setBlock): the simulation/client protocol's blockChanges (js/protocol.js, r15-36)
const setL = [];
world.onBlockSet = fn => setL.push(fn);
world.onChunkUnload = fn => world._unloadL.push(fn);

// Removes every chunk, edit and mesh (used for a new world / new seed).
world.reset = function () {
  for (const k of [...world.chunks.keys()]) unload(k);
  for (const k of [...world.farMeshes.keys()]) dropFar(k);
  world.edits.clear();
  world._dirty.clear();
  staleFar.clear();
  fluidQ.clear();
  growing.clear();
  if (BF.farmland) BF.farmland.reset();
  lastCenter = null; genList = []; meshList = []; simList = [];
  MP.queue.clear(); TBL = null;   // (answers still in workers are for chunks that are gone: dropped)
  if (BF.villageSim) BF.villageSim.reset();   // force a fresh load plan even if the spawn chunk is unchanged
};

// ---------- block access ----------
// chunkAt: the chunk holding column (x, z), through the margin on the planet (its own cx / cz are canonical: index it with world.cell
// when x / z may be a margin address). rawChunk: canonical coordinates only.
// The last chunk looked up is kept (most lookups land in the same chunk as the one before; on the planet the keys are long atlas
// strings, so building and hashing one is not free), until a chunk is added or removed (CGEN).
let LCX = NaN, LCZ = NaN, LC, LGEN = -1, CGEN = 0;
const rawChunk = (x, z) => {
  const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
  if (cx === LCX && cz === LCZ && LGEN === CGEN) return LC;
  LCX = cx; LCZ = cz; LGEN = CGEN;
  return (LC = world.chunks.get(ckey(cx, cz)));
};
function chunkAt(x, z) {
  return res(Math.floor(x), Math.floor(z)) ? rawChunk(RX, RZ) : undefined;
}
world.chunkAt = chunkAt;
world.isLoaded = (x, z) => !!chunkAt(Math.floor(x), Math.floor(z));
// The cell at column (x, z): out = { c (the chunk, or null when not loaded or in a corner wedge), lx, lz (local in c), x, z (canonical
// column), turn (quarter turns from c's frame to the frame of the address: turnId(id, turn) shows a canonical block there) }.
world.cell = function (x, z, out) {
  out = out || {};
  x = Math.floor(x); z = Math.floor(z);
  if (!res(x, z)) { out.c = null; out.lx = out.lz = 0; out.x = x; out.z = z; out.turn = 0; return out; }
  const c = rawChunk(RX, RZ) || null;
  out.c = c; out.x = RX; out.z = RZ; out.turn = RT;
  out.lx = RX - Math.floor(RX / CS) * CS; out.lz = RZ - Math.floor(RZ / CS) * CS;
  return out;
};
// A module's reusable out object for world.cell: its .c is cleared when that chunk unloads, so a long-lived scratch object never keeps an
// unloaded chunk's arrays alive (r15-35). Per-call out objects ({}) need nothing.
const scratchCells = [];
world.scratchCell = () => { const o = { c: null }; scratchCells.push(o); return o; };
const forgetChunk = c => { if (LC === c) LC = undefined; for (const o of scratchCells) if (o.c === c) o.c = null; };
// The chunk at chunk coordinates (cx, cz), through the margin (canonical coordinates are a plain lookup).
world.chunkC = (cx, cz) => {
  const k = resChunk(cx, cz);
  return k ? world.chunks.get(ckey(k[0], k[1])) : undefined;
};
// The canonical column of (x, z) as [x, z], or null in a corner wedge or off the atlas. Block entities (chests,
// furnaces, signs...) are keyed by canonical cells.
world.canonXZ = (x, z) => res(Math.floor(x), Math.floor(z)) ? [RX, RZ] : null;
world.turnId = turnId;

let STONE_ID = 0, BEDROCK_ID = 0;
// Block in chunk c at local (lx, lz) and absolute y: below the loaded band stone (bedrock below MIN_Y), above it air.
function cblock(c, lx, y, lz) {
  if (y < c.y0) return y < BF.MIN_Y ? BEDROCK_ID : STONE_ID;
  if (y >= c.y1) return 0;
  const s = c.secs[(y >> 4) - c.lo];
  return typeof s === "number" ? s : s[((y & 15) << 8) | (lz << 4) | lx];
}
world.chunkBlock = cblock;

// Block id at integer world coords. Unloaded -> 0 (air); below MIN_Y -> bedrock; above H -> air.
world.getBlock = function (x, y, z) {
  if (y < BF.MIN_Y) return BEDROCK_ID;
  if (y >= BF.H) return 0;
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (!res(x, z)) return 0;
  const c = rawChunk(RX, RZ);
  if (!c) return 0;
  const id = cblock(c, RX - c.cx * CS, y, RZ - c.cz * CS);
  return RT ? turnId(id, RT) : id;
};

// Solid for collision. Unloaded chunks count as solid so nothing falls out of the world.
world.isSolid = function (x, y, z) {
  if (y < BF.MIN_Y) return true;
  if (y >= BF.H) return false;
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (!res(x, z)) return true;
  x = RX; z = RZ;   // (solidity doesn't depend on facing)
  const c = rawChunk(x, z);
  if (!c) return !world.high;   // not loaded: solid (nothing falls into it), except above the chunk ceiling, where nothing loads
  return BF.SOLID[cblock(c, x - c.cx * CS, y, z - c.cz * CS)] === 1;
};

// Writes one voxel into chunk c (inside its band); a uniform section becomes a real array first.
function secSet(c, lx, y, lz, id) {
  const si = (y >> 4) - c.lo;
  let s = c.secs[si];
  if (typeof s === "number") {
    if (s === id) return;
    const a = BF.secArray(Uint16Array, SECN); if (s) a.fill(s);
    c.secs[si] = s = a;
  }
  s[((y & 15) << 8) | (lz << 4) | lx] = id;
}

// Slices a generated window (starting at section sy0) into section storage: uniform sections collapse to a number.
function sliceSections(data, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * SECN, f = data[o];
    let uni = true;
    for (let k = 1; k < SECN; k++) if (data[o + k] !== f) { uni = false; break; }
    if (uni) out[i] = f;
    else { const a = BF.secArray(Uint16Array, SECN); a.set(data.subarray(o, o + SECN)); out[i] = a; }
  }
  return out;
}

// Loads more sections below the band (generated lazily, deterministic from the seed) so the chunk reaches section newLo.
function extendDown(c, newLo) {
  newLo = Math.max(BF.SY0, newLo);
  if (newLo >= c.lo) return;
  const n = c.lo - newLo, add = sliceSections(BF.worldgen.generateRange(c.cx, c.cz, newLo, c.lo), n);
  const oldY0 = c.y0;
  c.secs = add.concat(c.secs);
  if (c.light) c.light = new Array(n).concat(c.light);
  if (c.sky) c.sky = new Array(n).fill(0).concat(c.sky);
  c.lo = newLo; c.y0 = newLo * 16; c.ver++; for (let i = 0; i < CS * CS; i++) c.colVer[i]++;
  const e = world.edits.get(c.key);       // edits are applied when the chunk is created; deeper ones are only possible if the band was shorter then
  if (e) for (const [i, id] of e) { const y = (i >> 8) + BF.MIN_Y; if (y >= c.y0 && y < oldY0) secSet(c, i & 15, y, (i >> 4) & 15, id); }
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) if (c.top[z * CS + x] < oldY0) updateColumn(c, x, z);
  if (BF.light && c.light !== undefined) BF.light.onExtended(c, oldY0);
  if (BF.skyLight) BF.skyLight.onExtended(c);   // a shaft may reach the new sections: recompute (js/skylight.js)
  markNeighboursDirty(c);
  if (c.mesh !== undefined) world._dirty.add(c.key);
}
// Makes room above the band (all air).
function extendUp(c, newHi) {
  newHi = Math.min(BF.SY1, newHi);
  if (newHi <= c.hi) return;
  for (let i = c.hi; i < newHi; i++) c.secs.push(0);
  if (c.light) for (let i = c.hi; i < newHi; i++) c.light.push(undefined);
  const oldHi = c.hi;
  c.hi = newHi; c.y1 = newHi * 16; c.ver++; for (let i = 0; i < CS * CS; i++) c.colVer[i]++;
  if (BF.skyLight) BF.skyLight.onExtendedUp(c, oldHi);
}
function markNeighboursDirty(c) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dz) continue;
    const n = world.chunkC(c.cx + dx, c.cz + dz);
    if (n && n.mesh !== undefined) world._dirty.add(n.key);
  }
}
// Makes sure the sections covering y0..y1 are loaded in the chunk holding (x, z). False if that chunk is not loaded.
world.ensureRange = function (x, z, y0, y1) {
  const c = chunkAt(x, z);   // (sections are whole-chunk, so the local column doesn't matter)
  if (!c) return false;
  if (y0 < c.y0) extendDown(c, Math.max(BF.MIN_Y, y0) >> 4);
  if (y1 >= c.y1) extendUp(c, (Math.min(BF.H - 1, y1) >> 4) + 1);
  return true;
};

// Sets a block, records the edit, and schedules remeshing. Returns false if the chunk isn't loaded.
world.setBlock = function (x, y, z, id) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (y < BF.MIN_Y || y >= BF.H) return false;
  // a margin address writes the canonical cell (turned back into its frame); hooks below see canonical coordinates
  if (!res(x, z)) return false;
  if (RT) id = turnId(id, 4 - RT);
  x = RX; z = RZ;
  const c = rawChunk(x, z);
  if (!c) return false;
  if (y < c.y0) extendDown(c, y >> 4); else if (y >= c.y1) extendUp(c, (y >> 4) + 1);
  const lx = x - c.cx * CS, lz = z - c.cz * CS, i = ((y - BF.MIN_Y) * CS + lz) * CS + lx;   // edit index (legacy limits: the old vIdx)
  const oldId = cblock(c, lx, y, lz);
  if (oldId === id) return true;
  secSet(c, lx, y, lz, id);
  c.ver++; c.colVer[(lz << 4) | lx]++;
  let e = world.edits.get(c.key);
  if (!e) world.edits.set(c.key, (e = new Map()));
  e.set(i, id);
  for (let k = 0; k < setL.length; k++) setL[k](c, i, id);   // (the protocol's block changes, js/protocol.js)
  updateColumn(c, lx, lz);
  world._dirty.add(c.key);
  scheduleFluid(x, y, z, true);
  if (BF.light) { BF.light.onSet(x, y, z, oldId, id); BF.light.popUnsupported(x, y, z, id); } // block light + torches losing support
  if (BF.skyLight) BF.skyLight.onSet(x, y, z, oldId, id);   // sky light (js/skylight.js)
  if (BF.mobs && BF.mobs.onSet) BF.mobs.onSet(x, y, z, oldId, id); // monster spawn wait restarts where it got darker (js/mobs.js)
  if (BF.signs) BF.signs.onSet(x, y, z, oldId, id); // sign groups re-merge / text moves / signs pop without support (js/signs.js)
  if (BF.isChest(oldId) && BF.inventory && BF.inventory.chestRemoved) BF.inventory.chestRemoved(x, y, z); // a chest spills its contents (js/inventory.js)
  if (BF.isFurnace(oldId) && !BF.isFurnace(id) && BF.inventory && BF.inventory.furnaceRemoved) BF.inventory.furnaceRemoved(x, y, z); // a furnace stops and spills (js/inventory.js)
  if (BF.baker && BF.baker.isOven(oldId) && !BF.baker.isOven(id)) BF.baker.ovenRemoved(x, y, z); // a baker's oven spills (js/baker.js)
  if (BF.blocks[id] && (BF.blocks[id].growsInto || BF.blocks[id].growsUp)) growing.add(fkey(x, y, z));
  if (y > BF.MIN_Y) { const bl = BF.blocks[cblock(c, lx, y - 1, lz)]; if (bl && bl.growsUp && id !== bl.id) growing.add(fkey(x, y - 1, z)); }   // cane cut back: the top left grows again
  if (BF.farmland) BF.farmland.onSet(x, y, z, oldId, id);   // farmland hydration clock (js/farmland.js)
  if (BF.bees) BF.bees.onSet(x, y, z, oldId, id);   // bee homes placed and broken, flowers planted and picked (js/bees.js)
  if (BF.regions) BF.regions.onSet(x, y, z, oldId, id);   // block entities in the region index (js/regions.js)
  // plants and crops pop off when the block under them goes away or water floods them
  if (y + 1 < BF.H && !BF.SOLID[id]) {
    const above = cblock(c, lx, y + 1, lz);
    if (BF.RENDER[above] === 4 || above === BF.B.wheat) {
      world.setBlock(x, y + 1, z, 0);
      if (BF.drops && !(BF.inventory && BF.inventory.isCreative && BF.inventory.isCreative())) BF.drops.spawnAt(BF.rollDrops(above), x, y + 1, z);
    }
  }
  // doors and beds pop off (one drop) when their support goes; an upper half left without its lower half vanishes
  if (y + 1 < BF.H) {
    const aid = cblock(c, lx, y + 1, lz), ab = BF.blocks[aid], nb = BF.blocks[id];
    if (ab && ab.door && ab.door.upper && !(nb && nb.door && !nb.door.upper)) world.setBlock(x, y + 1, z, 0);
    else if (ab && !BF.SOLID[id] && ((ab.door && !ab.door.upper) || ab.bed)) {
      world.removePartner(x, y + 1, z, aid);
      world.setBlock(x, y + 1, z, 0);
      if (BF.drops && !(BF.inventory && BF.inventory.isCreative && BF.inventory.isCreative())) BF.drops.spawnAt(BF.rollDrops(aid), x, y + 1, z);
    }
  }
  // ladders pop off (one drop) when the wall block behind them stops being a full solid block
  if (!BF.ladderSupport(id)) for (let f = 0; f < 4; f++) {
    const nx = x + BF.DIRS[f][0], nz = z + BF.DIRS[f][1], lid = world.getBlock(nx, y, nz), lb = BF.blocks[lid]; // ladder at (nx, nz) with its wall at (x, z) has facing f
    if (lb && lb.ladder && lb.ladder.f === f) {
      world.setBlock(nx, y, nz, 0);
      if (BF.drops && !(BF.inventory && BF.inventory.isCreative && BF.inventory.isCreative())) BF.drops.spawnAt(BF.rollDrops(lid), nx, y, nz);
    }
  }
  // neighbours share faces / AO / shading at the border
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dz) continue;
    const nx = lx + dx, nz = lz + dz;
    if (nx >= 0 && nx < CS && nz >= 0 && nz < CS) continue;
    const n = world.chunkC(c.cx + dx, c.cz + dz);
    if (n && n.mesh !== undefined) world._dirty.add(n.key);
  }
  return true;
};

// ---------- the page's copy of a world simulated elsewhere (spec r15-38) ----------
// The simulation's edits, as the protocol sends them (js/protocol.js: edits, blockChanges): chunks [[key, [[edit index, id], ...]], ...].
// full: every edit the world holds, replacing these. A loaded chunk takes each cell at once (blocks, light, remesh), as setBlock does
// without any of its consequences (drops, popping plants, fluids): the simulation makes those and sends them as edits too. A chunk that
// is only a far mesh is marked stale and loaded again, so it is remeshed; a loaded chunk that loses edits (full) is generated again.
const staleFar = new Set();
function applyCell(key, i, id) {
  let e = world.edits.get(key);
  if (!e) world.edits.set(key, (e = new Map()));
  e.set(i, id);
  const c = world.chunks.get(key);
  if (!c) { if (world.farMeshes.has(key) && !staleFar.has(key)) { staleFar.add(key); lastCenter = null; } return; }
  const y = (i >> 8) + BF.MIN_Y, lx = i & 15, lz = (i >> 4) & 15;
  if (y < c.y0) extendDown(c, y >> 4); else if (y >= c.y1) extendUp(c, (y >> 4) + 1);
  const oldId = cblock(c, lx, y, lz);
  if (oldId === id) return;
  secSet(c, lx, y, lz, id);
  c.ver++; c.colVer[(lz << 4) | lx]++;
  updateColumn(c, lx, lz);
  world._dirty.add(key);
  const x = c.cx * CS + lx, z = c.cz * CS + lz;
  if (BF.light) BF.light.onSet(x, y, z, oldId, id);
  if (BF.skyLight) BF.skyLight.onSet(x, y, z, oldId, id);
  if (lx === 0 || lz === 0 || lx === CS - 1 || lz === CS - 1) markNeighboursDirty(c);
}
world.applyEdits = function (chunks, full) {
  let gone = null;
  if (full) {
    const before = new Map(world.edits);
    world.edits.clear();
    const now = new Map(chunks);
    for (const [k, m] of before) {
      const c = world.chunks.get(k), n = now.get(k);
      if (!c || !m.size) continue;
      const nm = n ? new Map(n) : null;
      for (const [i, id] of m) if (!nm || nm.get(i) !== id) { (gone || (gone = [])).push(k); break; }
    }
  }
  for (const [k, cells] of chunks) for (const [i, id] of cells) applyCell(k, i, id);
  if (gone) { for (const k of gone) unload(k); lastCenter = null; }   // (generated again with the edits it has now)
};

// Calls cb(lx, y, lz, id) for every block of chunk c (optionally only y in [ya, yb]) whose flag[id] > thr (default 0).
world.scanFlagged = function (c, flag, cb, thr, ya, yb) {
  thr = thr || 0;
  const lo = ya == null ? c.y0 : Math.max(c.y0, ya), hi = yb == null ? c.y1 - 1 : Math.min(c.y1 - 1, yb);
  for (let si = 0; si < c.secs.length; si++) {
    const s = c.secs[si], by = (c.lo + si) * 16;
    if (by + 15 < lo || by > hi) continue;
    if (typeof s === "number") {
      if (!(flag[s] > thr)) continue;
      for (let i = 0; i < 4096; i++) { const y = by + (i >> 8); if (y >= lo && y <= hi) cb(i & 15, y, (i >> 4) & 15, s); }
      continue;
    }
    for (let i = 0; i < 4096; i++) {
      const id = s[i];
      if (!(flag[id] > thr)) continue;
      const y = by + (i >> 8);
      if (y >= lo && y <= hi) cb(i & 15, y, (i >> 4) & 15, id);
    }
  }
};

// Highest solid y at column (x, z) in the loaded band, or BF.MIN_Y - 1 when the column is not loaded.
world.heightAt = function (x, z) {
  x = Math.floor(x); z = Math.floor(z);
  if (!res(x, z)) return BF.MIN_Y - 1;
  x = RX; z = RZ;
  const c = rawChunk(x, z);
  if (!c) return BF.MIN_Y - 1;
  const lx = x - c.cx * CS, lz = z - c.cz * CS, SOLID = BF.SOLID;
  for (let si = c.hi - c.lo - 1; si >= 0; si--) {
    const s = c.secs[si];
    if (typeof s === "number") { if (SOLID[s]) return (c.lo + si) * 16 + 15; continue; }
    for (let ly = 15; ly >= 0; ly--) if (SOLID[s[(ly << 8) | (lz << 4) | lx]]) return (c.lo + si) * 16 + ly;
  }
  return c.y0 - 1;   // nothing solid in the band: solid stone below it
};

function updateColumn(c, lx, lz) {
  // light-blocking top (opaque blocks and leaves): rain and snow stop here (js/weather.js); sky light is js/skylight.js
  let y = c.y1 - 1;
  for (; y >= c.y0; y--) { const b = cblock(c, lx, y, lz); if (BF.OPAQUE[b] || BF.RENDER[b] === 2 || BF.LIGHTBLOCK[b]) break; }
  c.top[lz * CS + lx] = y;
}

// ---------- loading ----------
function createChunk(cx, cz) {
  if (!STONE_ID) { STONE_ID = BF.B.stone; BEDROCK_ID = BF.B.bedrock; }
  const g = BF.worldgen;
  const r = g.generateBand(cx, cz), lo = r.lo, hi = r.hi, data = r.vox;
  const key = ckey(cx, cz);
  // ver counts the block changes since the chunk was created (setBlock, the band growing), colVer the same per column (lz * 16 + lx):
  // caches of block scans keyed by (chunk, ver) stay right without listening for every change, and a reloaded chunk is a new object,
  // so they rebuild from it (r15-07). mapCols (js/maps.js) and logBases (js/forester.js) are such caches, declared here so every chunk keeps
  // one shape (a property added later would slow every block lookup down)
  const c = { cx, cz, key, lo, hi, y0: lo * 16, y1: hi * 16, secs: sliceSections(data, hi - lo), top: new Int16Array(CS * CS), ver: 0, colVer: new Uint32Array(CS * CS), mapCols: null, logBases: null, mesh: undefined, meshes: [], light: undefined, sky: undefined };
  const e = world.edits.get(key);
  if (e) {
    // the band must cover every edited cell (builds above it, tunnels below it)
    let minY = 1e9, maxY = -1e9;
    for (const i of e.keys()) { const y = (i >> 8) + BF.MIN_Y; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (minY < c.y0) { c.light = undefined; extendDownRaw(c, minY >> 4); }
    if (maxY >= c.y1) extendUp(c, (maxY >> 4) + 1);
    for (const [i, id] of e) secSet(c, i & 15, (i >> 8) + BF.MIN_Y, (i >> 4) & 15, id);
  }
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) updateColumn(c, x, z);
  world.chunks.set(key, c); CGEN++;
  if (BF.light) BF.light.onChunkCreated(c);
  if (BF.skyLight) BF.skyLight.onChunkCreated(c);   // sky light spreading (js/skylight.js)
  if (e) for (const [i, id] of e) if (BF.blocks[id] && (BF.blocks[id].growsInto || BF.blocks[id].growsUp)) {
    growing.add(fkey(cx * CS + (i & 15), (i >> 8) + BF.MIN_Y, cz * CS + ((i >> 4) & 15)));
  }
  for (const fn of world.replica ? world._viewLoadL : world._loadL) { try { fn(cx, cz, c); } catch (err) { console.error(err); } }
  // a far chunk's data again (it came near, or a neighbour needs it for its mesh): it takes back its mesh, which is still right (pitfall 9:
  // left dirty, it would be meshed again every frame)
  const fm = world.farMeshes.get(key);
  if (fm) {
    world.farMeshes.delete(key);
    c.meshes = fm; c.mesh = true;
    for (const m of fm) m.userData.chunk = c;
    if (staleFar.delete(key)) world._dirty.add(key);   // (the page's copy: edited while it was only a mesh, r15-38)
    else world._dirty.delete(key);
  }
  return c;
}
// extendDown for a chunk that is not registered yet (no light, no meshes, no neighbours to notify).
function extendDownRaw(c, newLo) {
  newLo = Math.max(BF.SY0, newLo);
  if (newLo >= c.lo) return;
  const n = c.lo - newLo;
  c.secs = sliceSections(BF.worldgen.generateRange(c.cx, c.cz, newLo, c.lo), n).concat(c.secs);
  c.lo = newLo; c.y0 = newLo * 16;
}

function unload(key) {
  const c = world.chunks.get(key);
  if (!c) return;
  disposeMeshes(c);
  world.chunks.delete(key); CGEN++; forgetChunk(c);   // (caches must not keep its arrays alive, r15-35)
  world._dirty.delete(key);
  MP.queue.delete(c);
  for (const fn of world._unloadL) { try { fn(c.cx, c.cz, c); } catch (err) { console.error(err); } }
}

// Keeps only chunk key's meshes (its block data goes, as on unloading): it is far from the player, meshed and unchanged. The meshes' arrays
// are freed once they are on the GPU.
const FAR = { far: true };
function purge(key) {
  const c = world.chunks.get(key);
  if (!c) return;
  world.farMeshes.set(key, c.meshes);
  for (const m of c.meshes) {
    m.userData.chunk = FAR;
    const g = m.geometry;
    for (const a of [...Object.values(g.attributes), g.index]) if (a) { if (a.uploaded) a.array = NOARR; else a.onUpload(freeArray); }
  }
  c.meshes = [];
  world.chunks.delete(key); CGEN++; forgetChunk(c);   // (caches must not keep its arrays alive, r15-35)
  world._dirty.delete(key);
  world.purged = (world.purged || 0) + 1;
  for (const fn of world._unloadL) { try { fn(c.cx, c.cz, c); } catch (err) { console.error(err); } }
}
const NOARR = new Float32Array(0);
function freeArray() { this.array = NOARR; }
function markUploaded() { this.uploaded = true; }
function dropFar(key) {
  staleFar.delete(key);
  for (const m of world.farMeshes.get(key) || []) { scene.remove(m); m.geometry.dispose(); if (m.material.userData.planet) m.material.dispose(); }
  world.farMeshes.delete(key);
}

function disposeMeshes(c) {
  for (const m of c.meshes) { scene.remove(m); m.geometry.dispose(); if (m.material.userData.planet) m.material.dispose(); }
  c.meshes = [];
}

function neighboursReady(cx, cz) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const k = resChunk(cx + dx, cz + dz);   // a corner wedge has nothing to wait for
    if (k && !world.chunks.has(ckey(k[0], k[1]))) return false;
  }
  return true;
}

let lastCenter = null, genList = [], meshList = [], simList = [], edgeList = [];
const TW = {};
let fwdX = 0, fwdZ = -1, lastPlanT = 0;
let roundPlan = false;
const TV2 = new THREE.Vector2();
function plan(pcx, pcz) {
  const R = world.viewDist;
  lastPlanT = performance.now();
  if (BF.camera) {
    const e = BF.camera.matrixWorld.elements; // camera looks down -Z
    const fx = -e[8], fz = -e[10], l = Math.hypot(fx, fz);
    if (l > 1e-3) { fwdX = fx / l; fwdZ = fz / l; }
  }
  genList = []; meshList = []; edgeList = [];
  const keep = new Set(), spots = new Map();
  // above the chunk ceiling nothing is wanted (distant terrain shows the ground, js/lod.js)
  const RL = world.high ? -2 : R;
  for (let dz = -RL - 1; dz <= RL + 1; dz++) for (let dx = -RL - 1; dx <= RL + 1; dx++) {
    const d2 = dx * dx + dz * dz;
    if (d2 > (R + 1.5) * (R + 1.5)) continue;
    let cx = pcx + dx, cz = pcz + dz;
    // the wanted set is built in the player's face frame, extended into the margin; each spot is a canonical chunk
    let ck = resChunk(cx, cz);
    if (!ck) {   // corner wedge: nothing to draw flat, but near a corner the round view fills it from the nearest face (js/view.js)
      if (!roundPlan) continue;
      const w = BF.planet.canonCell(cx * CS + 8, cz * CS + 8, CCELL);
      if (w.off) continue;
      ck = CCH; CCH[0] = Math.floor(w.x / CS); CCH[1] = Math.floor(w.z / CS);
    }
    cx = ck[0]; cz = ck[1];
    const k = ckey(cx, cz);
    if (keep.has(k)) continue;
    keep.add(k);
    // chunks in front of the camera load first; behind ones are weighted as further away
    const len = Math.sqrt(d2) || 1;
    const dot = (dx * fwdX + dz * fwdZ) / len;
    const score = d2 <= 2 ? d2 : d2 * (1 + 1.5 * Math.max(0, -dot) + 0.5 * (1 - Math.abs(dot)));
    edgeList.push([cx, cz, dx, dz, d2 <= R * R]);
    spots.set(dx + "," + dz, [cx, cz, score, d2, k]);
  }
  // block data only within KEEP chunks, and where a chunk still to be meshed needs it (itself and its neighbours); further
  // chunks that already have meshes keep only those (purged below)
  const data = new Set(), K = Math.min(R, KEEP) + 1.5;
  for (const [dk, sp] of spots) {
    const [cx, cz, score, d2, k] = sp, c = world.chunks.get(k);
    if (d2 <= K * K || staleFar.has(k)) data.add(k);
    if (d2 > R * R || (c ? c.mesh !== undefined : world.farMeshes.has(k))) continue;
    meshList.push([cx, cz, score, d2]);
    const [dx, dz] = dk.split(",").map(Number);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const n = spots.get((dx + i) + "," + (dz + j)); if (n) data.add(n[4]); }
  }
  for (const sp of spots.values()) if (data.has(sp[4]) && !world.chunks.has(sp[4])) genList.push([sp[0], sp[1], sp[2]]);
  genList.sort((a, b) => a[2] - b[2]);
  meshList.sort((a, b) => a[2] - b[2]);
  // villages simulated beyond view distance (js/villagesim.js): their chunks stay loaded as data, never meshed
  simList = [];
  if (BF.villageSim) for (const k of BF.villageSim.keepKeys) {
    keep.add(k);
    if (world.chunks.has(k)) continue;
    const [cx, cz] = k.split(",").map(Number);
    simList.push([cx, cz, (cx - pcx) * (cx - pcx) + (cz - pcz) * (cz - pcz)]);
  }
  simList.sort((a, b) => a[2] - b[2]);
  const far = (cx, cz, r) => {   // hysteresis: only chunks clearly out of range
    const t = BF.planet.toward({ x: pcx * CS + 8, z: pcz * CS + 8 }, { x: cx * CS + 8, z: cz * CS + 8 }, TW), dx = t.x / CS, dz = t.z / CS;
    return dx * dx + dz * dz > r * r;
  };
  const RU = world.high ? -1 : R;
  for (const k of [...world.chunks.keys()]) {
    const c = world.chunks.get(k);
    if (!keep.has(k)) { if (far(c.cx, c.cz, RU + 3)) unload(k); continue; }
    if (!data.has(k) && c.mesh === true && !c.meshJob && !world._dirty.has(k) && !world.edits.has(k) && !(BF.villageSim && BF.villageSim.keepKeys.has(k)) &&
      far(c.cx, c.cz, Math.min(R, KEEP) + 3)) purge(k);
  }
  for (const k of [...world.farMeshes.keys()]) {
    if (keep.has(k)) continue;
    const [cx, cz] = k.split(",").map(Number);
    if (far(cx, cz, RU + 3)) dropFar(k);
  }
}
// Remeshes the dirty chunks. batch (fast-forward): a chunk outside the player's 3x3 (through chunkC, so across face edges too) waits
// until remeshFFms() after its last mesh and stays dirty meanwhile. world.lastRemesh counts this frame's work: near, far, held, and its ms.
// The wait grows with the speed: a big village's far chunks mostly change a few seconds apart, so only a long wait merges their edits
// (seed 3 at 1000x: 400 ms cut remeshes ~5%, 2 s ~25%, 5 s ~55%; reports/r15-02.md).
const REMESH_FF_MS = 400;
const remeshFFms = () => BF.warp.speed >= 1000 ? 5000 : BF.warp.speed >= 100 ? 2000 : REMESH_FF_MS;
const nearKeys = new Set();
let ffHeld = 0, ffFar = 0, ffSince = 0;   // fast-forward totals since batching started (logged when it ends)
// The player's 3x3 are meshed here at once (breaking and placing feel instant); the others go to the mesher workers (r15-03), or are
// meshed here too without workers or with all (flushDirty).
function remeshDirty(pcx, pcz, batch, all) {
  const now = performance.now(), st = world.lastRemesh;
  st.near = st.far = st.held = 0;
  const wait = batch ? remeshFFms() : 0;
  if (!all && world._dirty.size) {
    nearKeys.clear();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const c = world.chunkC(pcx + dx, pcz + dz); if (c) nearKeys.add(c.key); }
  }
  for (const k of world._dirty) {
    const c = world.chunks.get(k);
    if (!c || c.mesh === undefined) { world._dirty.delete(k); continue; }
    const near = all || nearKeys.has(k);
    if (batch && !near && now - (c.meshT || 0) < wait) { st.held++; continue; }
    if (near || MP.inline) buildMesh(c);
    else { c.meshT = now; enqueue(c, chunkD2(c, pcx, pcz)); }
    world._dirty.delete(k);
    if (near) st.near++; else st.far++;
  }
  if (all) for (const c of [...MP.queue, ...MP.workers.flatMap(w => w.busy.map(it => it.c))]) if (world.chunks.get(c.key) === c) buildMesh(c);
  st.ms = performance.now() - now;
}
// Fast-forward totals: batching starts, adds up, and is logged when fast-forward drops below 10x.
function ffTrack(batch) {
  const now = performance.now(), st = world.lastRemesh;
  if (batch) {
    if (!ffSince) { ffSince = now; ffHeld = ffFar = 0; }
    ffHeld += st.held; ffFar += st.far;
  } else if (ffSince) {
    if (BF.glog) BF.glog.log("DEBUG", "remesh", "Fast-forward remesh batching ended after " + ((now - ffSince) / 1000).toFixed(1) + " s: " +
      ffFar + " far remeshes, " + ffHeld + " chunk-frames held back");
    ffSince = 0;
  }
}
world.lastRemesh = { near: 0, far: 0, held: 0, ms: 0 };
// Remeshes every dirty chunk now, and the ones waiting for or in a mesher worker (tests reading meshes right after fast-forward).
world.flushDirty = () => remeshDirty(0, 0, false, true);

const KEEP = 12;   // chunks from the player that keep their block data on the planet (the spec's 8 would shrink wild mobs' range below 1.3's)

// Squared distance in chunks from the player's chunk to chunk c (across face edges too): the mesher workers' order.
function chunkD2(c, pcx, pcz) {
  const t = BF.planet.toward({ x: pcx * CS + 8, z: pcz * CS + 8 }, { x: c.cx * CS + 8, z: c.cz * CS + 8 }, TW), dx = t.x / CS, dz = t.z / CS;
  return dx * dx + dz * dz;
}
let loadQ = 0;   // chunks still to generate or mesh for the view (queueLength without the mesher workers' jobs)

// Called every frame with the player position. budgetMs bounds generation+meshing time.
world.update = function (px, pz, budgetMs = 8) {
  const pcx = Math.floor(px / CS), pcz = Math.floor(pz / CS);
  if (BF.villageSim && !world.replica && BF.villageSim.update(px, pz)) lastCenter = null;   // simulated-village set changed: re-plan
  roundPlan = !!(BF.view && BF.view.roundAt(px, pz) > 0);   // near a cube corner: the round view wants the wedge filled
  // the chunk ceiling: above min(pxScale, chunkCeiling) over the ground no chunks load; back below 90% of it they do
  if (BF.player && BF.player.position) {
    let g = BF.SEA;
    try { g = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(px), Math.floor(pz))); } catch (_) {}
    let ceil = world.chunkCeiling;
    if (BF.renderer && BF.camera) ceil = Math.min(ceil, BF.renderer.getDrawingBufferSize(TV2).y / (2 * Math.tan(BF.camera.fov * Math.PI / 360)));
    const above = BF.player.position.y - g;
    if (!world.high && above > ceil) world.high = true;
    else if (world.high && above < 0.9 * ceil) world.high = false;
  } else world.high = false;
  const center = pcx + "," + pcz + "," + world.viewDist + "," + roundPlan + "," + world.high;
  // re-plan on chunk change, and periodically while loading so turning re-prioritises
  if (center !== lastCenter || (loadQ > 0 && performance.now() - lastPlanT > 1000)) { lastCenter = center; plan(pcx, pcz); }
  if (loadQ > 40) budgetMs = Math.max(budgetMs, 12);
  if (!MP.started || (BF.meshInline && !MP.inline)) poolStart();

  // vertical streaming: columns near the player load sections down to ~40 blocks below them (digging, caves, falling)
  if (BF.player && BF.player.position) {
    const want = Math.max(BF.SY0, (Math.floor(BF.player.position.y) - 40) >> 4);
    let budget = 3;
    for (let dz = -2; dz <= 2 && budget > 0; dz++) for (let dx = -2; dx <= 2 && budget > 0; dx++) {
      const c = world.chunkC(pcx + dx, pcz + dz);
      if (c && c.lo > want) { extendDown(c, dx || dz ? Math.max(want, c.lo - 8) : want); budget--; }
    }
  }

  // edits first: remesh dirty chunks immediately so breaking/placing feels instant. In fast-forward (10x and up) a chunk outside the
  // player's 3x3 is remeshed at most every REMESH_FF_MS, so villager doors, crops and trees don't remesh a big village every frame.
  const ffBatch = !!(BF.warp && BF.warp.speed >= 10);
  remeshDirty(pcx, pcz, ffBatch);
  ffTrack(ffBatch);

  // a real-time budget (spec r15-16 allows it): it decides what is drawn and when chunk data arrives, never what villagers do, since they
  // and their jobs wait for unloaded chunks (js/villagesim.js)
  const t0 = performance.now();
  let gi = 0, mi = 0;
  while (performance.now() - t0 < budgetMs) {
    // mesh the nearest chunk whose neighbours exist; otherwise generate the nearest missing data
    while (mi < meshList.length) {
      const [cx, cz] = meshList[mi];
      const c = world.chunks.get(ckey(cx, cz));
      if (c && c.mesh === undefined && neighboursReady(cx, cz)) break;
      if ((c && c.mesh !== undefined) || (!c && world.farMeshes.has(ckey(cx, cz)))) { meshList.splice(mi, 1); continue; }
      mi++;
    }
    while (gi < genList.length && world.chunks.has(ckey(genList[gi][0], genList[gi][1]))) genList.splice(gi, 1);
    const meshCand = mi < meshList.length ? meshList[mi] : null;
    const genCand = gi < genList.length ? genList[gi] : null;
    if (!meshCand && !genCand) {
      // everything in view is ready: spend the rest of the budget on data-only chunks of far villages
      while (simList.length && world.chunks.has(ckey(simList[0][0], simList[0][1]))) simList.shift();
      if (!simList.length) break;
      const [sx, sz] = simList.shift();
      createChunk(sx, sz);
      continue;
    }
    if (meshCand && (!genCand || meshCand[2] <= genCand[2] + 2)) {
      const c = world.chunks.get(ckey(meshCand[0], meshCand[1]));
      if (MP.inline) buildMesh(c); else { c.mesh = null; enqueue(c, meshCand[2]); }
      meshList.splice(mi, 1);
    } else {
      createChunk(genCand[0], genCand[1]);
      genList.splice(gi, 1);
      mi = 0; // newly generated data may unblock a nearer mesh
    }
  }
  pump();
  loadQ = genList.length + meshList.filter(m => { const k = ckey(m[0], m[1]), c = world.chunks.get(k); return c ? c.mesh === undefined : !world.farMeshes.has(k); }).length;
  world.queueLength = loadQ + poolPending();   // (chunks waiting for or in a mesher worker count as still loading)
  // how far out every wanted chunk has a mesh, in blocks: distant terrain (js/lod.js) leaves its hole only that far while chunks load
  // (the distance from the player to the nearest chunk square, in the planned set or just past it, that has no mesh)
  const lx = px - pcx * CS, lz = pz - pcz * CS;
  let gap = Infinity;
  for (const e of edgeList) {
    if (e[4]) { const k = ckey(e[0], e[1]), c = world.chunks.get(k); if (c ? c.mesh : world.farMeshes.has(k)) continue; }
    const ex = Math.max(e[2] * CS - lx, 0, lx - (e[2] + 1) * CS), ez = Math.max(e[3] * CS - lz, 0, lz - (e[3] + 1) * CS);
    if (ex * ex + ez * ez < gap) gap = ex * ex + ez * ez;
  }
  world.covered = world.high ? 0 : gap === Infinity ? world.viewDist * CS : Math.sqrt(gap);
};

world.setViewDist = function (d) { world.viewDist = d; lastCenter = null; };
world.meshedCount = () => { let n = 0; for (const c of world.chunks.values()) if (c.mesh) n++; return n; };

// ---------- meshing ----------
// The mesher itself is js/mesher.js. The player's own edits (the 3x3 chunks around the player) are meshed here at once, so breaking and
// placing feel instant; every other chunk is meshed by a pool of mesher workers (js/meshworker.js, spec r15-03), nearest first, and the
// page only wraps the arrays in geometry. Without workers (no Worker, a file: page, BF.meshInline) everything is meshed here.
// Chunk fields: mesh (undefined: never meshed; null: its first mesh is queued or being built; true: meshed), meshJob (0 none, 1 queued,
// 2 in a worker), meshAgain (changed while in a worker: one more job when the answer comes), meshV / meshShown (the last job started /
// the job whose mesh is shown: an answer older than the shown mesh is dropped).
const M = BF.mesher;
const MODELS = M.MODELS;
world.MODELS = MODELS; // extra packs register models here (js/signs.js: MODELS.sign); models get (get, x, y, z, id, worldX, worldZ)
BF.DYNBOXES = BF.DYNBOXES || []; // id -> fn(get, x, y, z, id) -> collision boxes in blocks (checked by boxHit before CBOXES / CBOX)
for (const b of BF.blocks) if (b && b.model === "pane") BF.DYNBOXES[b.id] = (get, x, y, z) => M.paneBoxes(meshTables(), get, x, y, z).map(q => [q[0] / 16, q[1] / 16, q[2] / 16, q[3] / 16, q[4] / 16, q[5] / 16]);
// A ladder needs a full solid opaque block behind it (the cell at pos + DIRS[f]).
BF.ladderSupport = id => BF.SOLID[id] === 1 && BF.OPAQUE[id] === 1;
const EDGE_NB = { edge: true };   // meshJob: a neighbour chunk across a face edge

// The mesher's tables (see js/mesher.js), built on first use and again after world.init / world.reset. TBLV counts the builds, so the
// workers are sent new ones.
let TBL = null, TBLV = 0, WTBL = null, FOREIGN = null;
function meshTables() {
  if (TBL) return TBL;
  const tiles = {}, draw = !!scene;   // headless (no scene, js/boot.js): the collision boxes only (pane boxes), no texture atlas
  if (draw) for (const b of BF.blocks) if (b && Array.isArray(b.boxes)) for (const q of b.boxes) if (q && typeof q[6] === "string" && !(q[6] in tiles)) tiles[q[6]] = BF.textures.uv(q[6]);
  TBL = {
    RENDER: BF.RENDER, OPAQUE: BF.OPAQUE, FLUID: BF.FLUID, SOLID: BF.SOLID, SATT: BF.skyLight.ATT, SKB: BF.skyLight.BRIGHT,
    faceUV: world._faceUV, faceTint: world._faceTint, dirtUV: world._dirtUV, overlayUV: world._overlayUV, tiles, tile0: draw ? BF.textures.uv("\u0000") : null,
    blocks: BF.blocks, DIRS: BF.DIRS, STONE: BF.B.stone, BEDROCK: BF.B.bedrock, PATH: BF.B.dirt_path, FARM: BF.B.farmland, FARM_DRY: BF.B.farmland_dry,
    MINY: BF.MIN_Y, HTOP: BF.H,
  };
  // blocks whose model is not one of the mesher's own (signs read their group from the world): their boxes are worked out here
  FOREIGN = new Uint8Array(BF.MAX_BLOCK + 1);
  for (const b of BF.blocks) if (b && BF.RENDER[b.id] === 5 && MODELS[b.model] && MODELS[b.model] !== M.BUILTIN[b.model]) FOREIGN[b.id] = 1;
  TBLV++; WTBL = null;
  return TBL;
}
// The tables as a worker gets them (the block list cut down to what the mesher and its models read).
function workerTables() {
  if (WTBL) return WTBL;
  const t = Object.assign({}, meshTables());
  t.blocks = BF.blocks.map(b => b && { model: b.model, translucent: b.translucent, boxes: b.boxes, gate: b.gate && { axis: b.gate.axis }, wallTorch: b.wallTorch && { f: b.wallTorch.f }, name: b.name, render: b.render });
  return (WTBL = t);
}

// The mesher's job for chunk c (see js/mesher.js): its sections (copied when copy, for a worker), the ring of cells around it read from
// its neighbours, the biome tints, the boxes of world-state models and, on the planet, its frame on the sphere.
const NB = new Array(9);
function meshJob(c, copy) {
  const T = meshTables(), ox = c.cx * CS, oz = c.cz * CS;
  // 3x3 neighbourhood. A neighbour across a face edge is EDGE_NB: its cells are read through the world (resolved and turned
  // into this face's frame) rather than by local index.
  for (let dz = -1, i = 0; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++, i++) {
    const k = resChunk(c.cx + dx, c.cz + dz);
    NB[i] = !k ? undefined : k[0] === c.cx + dx && k[1] === c.cz + dz ? world.chunks.get(ckey(k[0], k[1])) : EDGE_NB;
  }
  // the ring: blocks (stone below a neighbour's band, air above it and where it is not loaded), block light (0 where unknown) and sky
  // light (15 where not loaded or above the band, 0 below it)
  const Y0 = c.y0 - 2, Y1 = c.y1 + 2, NY = Y1 - Y0, RW = CS + 4;
  const rb = new Uint16Array(M.RN * NY), rl = new Uint8Array(M.RN * NY), rs = new Uint8Array(M.RN * NY);
  for (let z = -2; z < CS + 2; z++) for (let x = -2; x < CS + 2; x++) {
    const r = M.RING[(z + 2) * RW + x + 2];
    if (r < 0) continue;
    const ix = x < 0 ? 0 : x >= CS ? 2 : 1, iz = z < 0 ? 0 : z >= CS ? 2 : 1, ch = NB[iz * 3 + ix], o = r * NY;
    if (!ch) { rs.fill(15, o, o + NY); continue; }
    if (ch === EDGE_NB) {
      for (let i = 0, y = Y0; i < NY; i++, y++) {
        rb[o + i] = world.getBlock(ox + x, y, oz + z);
        if (y >= BF.MIN_Y && y < BF.H) rl[o + i] = world.getBlockLight(ox + x, y, oz + z);
        rs[o + i] = BF.skyLight.get(ox + x, y, oz + z);
      }
      continue;
    }
    const col = ((z - (iz - 1) * CS) << 4) | (x - (ix - 1) * CS), secs = ch.secs, light = ch.light, sky = ch.sky;
    for (let i = 0, y = Y0; i < NY; i++, y++) {
      if (y < ch.y0) { rb[o + i] = T.STONE; rs[o + i] = sky ? 0 : 15; continue; }
      if (y >= ch.y1) { rs[o + i] = 15; continue; }
      const si = (y >> 4) - ch.lo, k = ((y & 15) << 8) | col, s = secs[si];
      rb[o + i] = typeof s === "number" ? s : s[k];
      const ls = light && light[si];
      if (ls) rl[o + i] = ls[k];
      if (!sky) rs[o + i] = 15;
      else { const ss = sky[si]; rs[o + i] = typeof ss === "number" ? ss : ss[k]; }
    }
  }
  // biome tint per column over an 18x18 area (1-block border)
  const tintFn = BF.worldgen.tintAt, TW = CS + 2, tint = new Float32Array(TW * TW * 9);
  for (let z = -1; z <= CS; z++) for (let x = -1; x <= CS; x++) {
    const o = ((z + 1) * TW + (x + 1)) * 9;
    let t = null;
    try { t = tintFn ? tintFn(ox + x, oz + z) : null; } catch (_) { t = null; }
    const g = (t && t.grass) || [1, 1, 1], fo = (t && t.foliage) || [1, 1, 1], w = (t && t.water) || [1, 1, 1];
    tint[o] = g[0]; tint[o + 1] = g[1]; tint[o + 2] = g[2];
    tint[o + 3] = fo[0]; tint[o + 4] = fo[1]; tint[o + 5] = fo[2];
    tint[o + 6] = w[0]; tint[o + 7] = w[1]; tint[o + 8] = w[2];
  }
  // models that read world state (signs): their boxes, with tile names turned into atlas rects
  let ext = null;
  const wget = (x, y, z) => world.getBlock(ox + x, y, oz + z);
  world.scanFlagged(c, FOREIGN, (lx, y, lz, id) => {
    const boxes = MODELS[BF.blocks[id].model](wget, lx, y, lz, id, ox + lx, oz + lz);
    (ext || (ext = {}))[((y - c.y0) << 8) | (lz << 4) | lx] = boxes.map(q => {
      if (typeof q[6] !== "string") return q;
      q = q.slice(); q[6] = BF.textures.uv(q[6]); return q;
    });
  });
  const cp = a => typeof a === "number" || !a ? a : a.slice();
  return {
    ox, oz, lo: c.lo, hi: c.hi, y0: c.y0, y1: c.y1,
    secs: copy ? c.secs.map(cp) : c.secs, light: copy && c.light ? c.light.map(cp) : c.light, sky: copy && c.sky ? c.sky.map(cp) : c.sky,
    Y0, Y1, rb, rl, rs, tint, ext,
    sph: Object.assign(sphereFrame(ox, oz), { R: BF.planet.R, sea: BF.SEA }),
  };
}
// The arrays of a job copied for a worker (to transfer them).
function jobBuffers(J) {
  const a = [J.rb.buffer, J.rl.buffer, J.rs.buffer, J.tint.buffer];
  for (const l of [J.secs, J.light, J.sky]) if (l) for (const s of l) if (s && typeof s === "object") a.push(s.buffer);
  a.push(J.sph.dirs.buffer);
  return a;
}

// Shows a mesher result as chunk c's meshes (anchor: its anchor on the sphere).
function applyMesh(c, R, anchor) {
  const ox = c.cx * CS, oz = c.cz * CS;
  disposeMeshes(c);
  const make = (T, mat, order) => {
    if (!T) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(T.pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(T.uv, 2));
    g.setAttribute("color", new THREE.BufferAttribute(T.col, 3));
    g.setAttribute("skyl", new THREE.BufferAttribute(T.sky, 1));
    g.setAttribute("bl", new THREE.BufferAttribute(T.bl, 1));
    if (T.sphere) g.setAttribute("sphere", new THREE.BufferAttribute(T.sphere, 3));
    g.setIndex(new THREE.BufferAttribute(T.ind, 1));
    g.computeBoundingSphere();
    for (const a of [...Object.values(g.attributes), g.index]) a.onUpload(markUploaded);   // (see purge)
    const m = new THREE.Mesh(g, planetMaterial(mat, BF.planet.face(ox, oz)));
    m.renderOrder = order;
    m.matrixAutoUpdate = false;
    m.position.set(ox, 0, oz); m.updateMatrix();
    m.userData.chunk = c;
    m.userData.anchor = anchor;
    scene.add(m);
    c.meshes.push(m);
  };
  make(R.S, solidMat, 0);
  make(R.L, liquidMat, 1);
  c.mesh = true;
}

// Meshes chunk c here and now.
function buildMesh(c) {
  const t0 = performance.now();
  c.meshT = t0;   // fast-forward remesh batching (remeshDirty)
  if (!scene) { c.mesh = true; c.meshAgain = false; return; }   // headless (js/boot.js): nothing is drawn; the chunk streams as if shown
  c.meshV = (c.meshV || 0) + 1;
  if (c.meshJob === 1) { MP.queue.delete(c); c.meshJob = 0; }
  c.meshAgain = false;   // (an answer still in a worker is older than this mesh: it is dropped)
  const J = meshJob(c, false);
  applyMesh(c, M.build(J, meshTables()), J.sph.anchor);
  c.meshShown = c.meshV; c.meshBy = "page";
  MP.pageMeshes++; MP.pageMs += performance.now() - t0;
}
world.buildMeshNow = buildMesh;   // (tests)
world.meshJobFor = (c, copy) => meshJob(c, copy);   // (tests, profiling)
// (tests) the arrays the page's mesher makes for chunk c now, without showing them; and the arrays of c's meshes as shown
world.meshArrays = c => M.build(meshJob(c, false), meshTables());
world.shownArrays = c => {
  const out = { S: null, L: null };
  for (const m of c.meshes) {
    const g = m.geometry, a = g.attributes;
    out[m.renderOrder ? "L" : "S"] = { pos: a.position.array, uv: a.uv.array, col: a.color.array, sky: a.skyl.array, bl: a.bl.array, sphere: a.sphere ? a.sphere.array : null, ind: g.index.array };
  }
  return out;
};

// ---- the mesher workers ----
// MP: workers (each with busy: its jobs, oldest first; a worker answers in order), queue (chunks waiting for a worker), inline (no
// workers: mesh in the page), counters for the debug screen and tests.
const MP = (world.meshPool = { workers: [], queue: new Set(), inline: true, started: false, sent: 0, done: 0, dropped: 0, workMs: 0, prepMs: 0, pageMeshes: 0, pageMs: 0 });
const glog = (level, text) => { if (BF.glog) BF.glog.log(level, "meshing", text); };
function poolStart() {
  MP.started = true;
  const left = [...MP.queue];   // (started again: BF.meshInline turned on)
  for (const w of MP.workers) { for (const it of w.busy) left.push(it.c); w.terminate(); }
  MP.workers = []; MP.queue.clear();
  const k = Math.min(4, ((globalThis.navigator && navigator.hardwareConcurrency) || 2) - 1);   // every core but the page's, up to 4
  MP.inline = !scene || !!BF.meshInline || typeof Worker === "undefined" || location.protocol === "file:" || k < 1 || !BF.workerUrl;
  if (!MP.inline) for (let i = 0; i < k; i++) {
    let w;
    try { w = new Worker(BF.workerUrl("js/meshworker.js")); } catch (e) { poolFail(e && e.message); return; }
    w.busy = []; w.tv = -1;
    w.onmessage = e => { const it = w.busy.shift(); if (it) answer(it, e.data); pump(); };
    w.onerror = e => poolFail(e && e.message);
    MP.workers.push(w);
  }
  glog("INFO", !scene ? "Headless: chunks are not meshed (nothing is drawn)" : MP.inline ? "Chunks are meshed in the page (no mesher workers)" : "Chunks are meshed in " + MP.workers.length + " worker threads");
  for (const c of left) { c.meshJob = 0; if (world.chunks.get(c.key) !== c) continue; if (MP.inline) buildMesh(c); else enqueue(c, c.meshPrio || 0); }
}
// A worker that can't load or fails: everything is meshed in the page from now on, starting with the chunks the workers had.
function poolFail(why) {
  if (MP.inline) return;
  MP.inline = true;
  const left = [...MP.queue];
  for (const w of MP.workers) { for (const it of w.busy) left.push(it.c); w.terminate(); }
  MP.workers = []; MP.queue.clear();
  glog("ERROR", "A mesher worker failed (" + (why || "unknown error") + "); chunks are meshed in the page from now on");
  for (const c of left) { c.meshJob = 0; if (world.chunks.get(c.key) === c) buildMesh(c); }
}
// Queues chunk c for a worker (prio: lower first). A chunk already in a worker gets one more job when its answer comes.
function enqueue(c, prio) {
  if (c.meshJob === 2) { c.meshAgain = true; return; }
  c.meshPrio = prio;
  if (c.meshJob === 1) return;
  c.meshJob = 1;
  MP.queue.add(c);
}
// Hands queued chunks to free workers, nearest first, two jobs a worker (so it starts the next at once). The job's data is read now, so a
// chunk that changed while it waited is meshed as it is.
function pump() {
  if (MP.inline) return;
  for (let k = 0; k < 2; k++) for (const w of MP.workers) {
    if (w.busy.length > k) continue;
    let c = null;
    for (const q of MP.queue) if (!c || q.meshPrio < c.meshPrio) c = q;
    if (!c) return;
    MP.queue.delete(c);
    const t0 = performance.now();
    c.meshV = (c.meshV || 0) + 1; c.meshJob = 2; c.meshAgain = false;
    const J = meshJob(c, true);
    if (w.tv !== TBLV) { w.postMessage({ tables: workerTables() }); w.tv = TBLV; }
    w.busy.push({ c, v: c.meshV, anchor: J.sph.anchor });
    w.postMessage({ job: J }, jobBuffers(J));
    MP.sent++; MP.prepMs += performance.now() - t0;
  }
}
// A worker's answer for job it: shown unless the chunk is gone (unloaded, purged, a new world) or a newer mesh is already shown.
function answer(it, r) {
  const c = it.c;
  MP.done++; MP.workMs += r.ms || 0;
  if (world.chunks.get(c.key) !== c) { MP.dropped++; return; }
  c.meshJob = 0;
  if (it.v > (c.meshShown || 0)) { applyMesh(c, r, it.anchor); c.meshShown = it.v; c.meshBy = "worker"; } else MP.dropped++;
  if (c.meshAgain) { c.meshAgain = false; enqueue(c, c.meshPrio); }
}
// Jobs waiting for or in a worker.
const poolPending = () => MP.queue.size + MP.workers.reduce((n, w) => n + w.busy.length, 0);
world.meshStats = () => ({ workers: MP.workers.length, inline: MP.inline, queued: MP.queue.size, inWorkers: poolPending() - MP.queue.size, sent: MP.sent, done: MP.done,
  dropped: MP.dropped, workMs: Math.round(MP.workMs), prepMs: Math.round(MP.prepMs), pageMeshes: MP.pageMeshes, pageMs: Math.round(MP.pageMs) });

// ---------- flowing water ----------
// Cellular water like Minecraft: sources (FLUID 8) feed flowing cells whose level rises
// by one per block (1 next to a source .. 7 thinnest). Water falls first; flowing water only
// spreads sideways when it rests on something. Two sources feeding a cell on solid ground
// make a new source. Cells are re-evaluated only after something near them changed.
const fluidQ = new Set();
let fluidLast = 0;
const FLUID_TICK = 0.25; // seconds per spread step
const fkey = (x, y, z) => x + "," + y + "," + z;

// queued by canonical cell (neighbours of a cell by a face edge are margin addresses)
function qf(x, y, z) {
  if (!res(x, z)) return;
  x = RX; z = RZ;
  fluidQ.add(fkey(x, y, z));
}
function scheduleFluid(x, y, z, withNeighbours) {
  if (y < BF.MIN_Y || y >= BF.H) return;
  qf(x, y, z);
  if (withNeighbours) {
    qf(x + 1, y, z); qf(x - 1, y, z);
    qf(x, y, z + 1); qf(x, y, z - 1);
    if (y + 1 < BF.H) qf(x, y + 1, z);
    if (y > BF.MIN_Y) qf(x, y - 1, z);
  }
}
world.scheduleFluid = scheduleFluid;

const HN = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Level this cell should have given its neighbours: 8 source, 1..7 flowing, 0 dry.
function desiredLevel(x, y, z, cur) {
  const FLUID = BF.FLUID, get = world.getBlock;
  if (cur === 8) return 8;
  if (FLUID[get(x, y + 1, z)]) return 1; // falling water
  let best = 99, sources = 0;
  for (const [dx, dz] of HN) {
    const nx = x + dx, nz = z + dz;
    const f = FLUID[get(nx, y, nz)];
    if (!f) continue;
    if (f === 8) { sources++; best = Math.min(best, 1); continue; }
    // flowing water only spreads sideways when it rests on something
    const below = get(nx, y - 1, nz);
    if (BF.REPLACEABLE[below] && !FLUID[below]) continue;
    if (FLUID[below] && FLUID[below] !== 8) continue;
    best = Math.min(best, f + 1);
  }
  if (sources >= 2) {
    const below = get(x, y - 1, z);
    if (BF.SOLID[below] || FLUID[below] === 8) return 8;
  }
  return best <= 7 ? best : 0;
}

// "x,y,z" cell keys as [x, y, z, key], sorted by x, then z, then y: the block ticks' fixed order (spec r15-17)
function canonOrder(keys) {
  const a = [];
  for (const k of keys) { const p = k.split(","); a.push([+p[0], +p[1], +p[2], k]); }
  return a.sort((p, q) => p[0] - q[0] || p[2] - q[2] || p[1] - q[1]);
}
function fluidTick() {
  const now = BF.simNow();
  if (now - fluidLast < FLUID_TICK) return;
  fluidLast = now;
  if (!fluidQ.size) return;
  const FLUID = BF.FLUID, REPL = BF.REPLACEABLE;
  const batch = canonOrder(fluidQ);   // in canonical cell order (spec r15-17), so the budget's cut doesn't depend on history
  fluidQ.clear();
  let budget = 3000;
  const changes = [];
  for (const [x, y, z, k] of batch) {
    if (budget-- <= 0) { fluidQ.add(k); continue; }
    if (!world.isLoaded(x, z)) continue;
    const id = world.getBlock(x, y, z);
    const cur = FLUID[id];
    if (!cur && BF.hardenPowder && BF.blocks[id] && BF.blocks[id].hardensTo != null && BF.hardenPowder(x, y, z, id)) continue; // concrete powder next to water
    if (!cur && !REPL[id]) continue; // solid or non-replaceable: water can't be here
    // nothing wet nearby? skip quickly
    const want = desiredLevel(x, y, z, cur);
    if (want === cur) continue;
    if (!cur && !want) continue;
    changes.push([x, y, z, want]);
  }
  // apply after evaluating so one tick spreads exactly one block
  for (const [x, y, z, want] of changes) {
    const id = want === 8 ? BF.B.water : want ? BF.waterFlowId(want) : 0;
    world.setBlock(x, y, z, id);
  }
}

// ---------- crop growth ----------
// Young crops (blocks with growsInto) mature after ~4 minutes (1/5 game day) on average, only on farmland; on dehydrated
// farmland at a third of that speed (js/farmland.js).
const growing = new Set();
let growLast = 0;
const GROW_CHANCE_PER_S = 1 / 240;   // ~4 minutes (a fifth of the 1200 s game day) on average
function growTick() {
  const now = BF.simNow();
  if (now - growLast < 1) return;
  const dt = Math.min(5, now - growLast);
  growLast = now;
  for (const [x, y, z, k] of canonOrder(growing)) {
    if (!world.isLoaded(x, z)) continue; // keeps waiting until its chunk is back
    const id = world.getBlock(x, y, z), b = BF.blocks[id];
    if (b && b.growsUp) { if (caneTick(x, y, z, id, b, dt)) growing.delete(k); continue; }
    if (!b || !b.growsInto) { growing.delete(k); continue; }
    const soil = world.getBlock(x, y - 1, z);
    if (soil !== BF.B.farmland && soil !== BF.B.farmland_dry) continue;
    const f = soil === BF.B.farmland_dry ? (BF.farmland ? BF.farmland.growFactor(soil) : 1 / 3) : 1;
    // crops grow 1.5x faster while it rains (js/weather.js), 1.25x by day near a home with bees (js/bees.js)
    if (BF.rand.at("grow", x, z, null, y).next() < GROW_CHANCE_PER_S * dt * f * (BF.weather && BF.weather.raining ? 1.5 : 1) * (BF.bees ? BF.bees.cropFactor(x, y, z) : 1)) { growing.delete(k); world.setBlock(x, y, z, b.growsInto); }
  }
}
// Sugar cane (blocks with growsUp: their tallest height) grows a block on top, at the crop rate, while the column is shorter than that and its
// bottom stands on dirt, grass or sand beside water (vanilla). Only cane someone placed or cut back is tracked (an edit), so wild cane stays as
// generated until it is cut. Returns true when the cell is done (not the top, full height, or no water).
function caneTick(x, y, z, id, b, dt) {
  const up = world.getBlock(x, y + 1, z);
  if (up !== 0) return true;
  let h = 1, by = y - 1;
  while (by > BF.MIN_Y && world.getBlock(x, by, z) === id) { h++; by--; }
  if (h >= b.growsUp) return true;
  const g = BF.blocks[world.getBlock(x, by, z)], gn = g ? g.name : "";
  if (!/^(grass|dirt|coarse_dirt|podzol|sand|red_sand|snow_grass)$/.test(gn)) return true;
  if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => BF.FLUID[world.getBlock(x + dx, by, z + dz)])) return true;
  if (BF.rand.at("cane", x, z, null, y).next() < GROW_CHANCE_PER_S * dt * (BF.weather && BF.weather.raining ? 1.5 : 1)) { world.setBlock(x, y + 1, z, id); return true; }
  return false;
}
world.growingCount = () => growing.size;
// The rest of each simulation tick (spec r15-17, js/requests.js), after the sky, mobs, drops, boats and furnaces:
// - think hooks (world.onThink: villages, their stats and economy, foresters), the end of the think phase;
// - apply: the tick's requests (BF.req.apply);
// - block ticks (world.onBlockTick: fluid spread, crop growth, farmland, grass), in registration order, each in canonical cell order;
// - deliver: the requests' results.
// All on the simulation clock (BF.simNow), once per tick, so fast-forward (js/timewarp.js) speeds them up too.
const thinkHooks = [], blockHooks = [fluidTick, growTick];
world.onThink = fn => { thinkHooks.push(fn); };
world.onBlockTick = fn => { blockHooks.push(fn); };
function blockTicks() { for (const f of blockHooks) f(); }
world.tickSim = () => {
  for (const f of thinkHooks) f();
  const R = BF.req;
  if (!R) { blockTicks(); return; }
  R.apply();
  R.blocks(blockTicks);
  R.deliver();
  R.endTick();
};

// ---------- raycast ----------
// DDA voxel raycast. Returns {x,y,z,id,normal:[nx,ny,nz],dist} for the first block where
// pred(id) is true (default: any non-air, non-liquid block), or null.
world.raycast = function (origin, dir, maxDist, pred) {
  pred = pred || (id => id !== 0 && BF.RENDER[id] !== 3);
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const dx = dir.x, dy = dir.y, dz = dir.z;
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity;
  let tx = dx ? ((sx > 0 ? x + 1 - origin.x : origin.x - x) * tdx) : Infinity;
  let ty = dy ? ((sy > 0 ? y + 1 - origin.y : origin.y - y) * tdy) : Infinity;
  let tz = dz ? ((sz > 0 ? z + 1 - origin.z : origin.z - z) * tdz) : Infinity;
  let normal = [0, 0, 0], t = 0;
  for (let i = 0; i < 256 && t <= maxDist; i++) {
    const id = world.getBlock(x, y, z);
    if (id && pred(id)) return { x, y, z, id, normal, dist: t };
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; normal = [-sx, 0, 0]; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; normal = [0, -sy, 0]; }
    else { z += sz; t = tz; tz += tdz; normal = [0, 0, -sz]; }
  }
  return null;
};

// ---------- doors and beds ----------
// The other half of a door or bed at (x, y, z), as [x, y, z], or null.
world.partnerOf = function (x, y, z, id) {
  const b = BF.blocks[id == null ? world.getBlock(x, y, z) : id];
  if (b && b.door) return [x, b.door.upper ? y - 1 : y + 1, z];
  if (b && b.bed) { const [dx, dz] = BF.DIRS[b.bed.f], s = b.bed.head ? -1 : 1; return [x + dx * s, y, z + dz * s]; }
  return null;
};
// After a door/bed half is removed, removes the other half too (no drop).
world.removePartner = function (x, y, z, id) {
  const p = world.partnerOf(x, y, z, id), b = BF.blocks[id];
  if (!p) return;
  const o = BF.blocks[world.getBlock(p[0], p[1], p[2])];
  if (o && ((b.door && o.door) || (b.bed && o.bed))) world.setBlock(p[0], p[1], p[2], 0);
};
// Opens/closes the door at (x, y, z) (either half; open = undefined toggles). Returns the new state or null.
world.setDoor = function (x, y, z, open) {
  const d = BF.blocks[world.getBlock(x, y, z)].door;
  if (!d) return null;
  if (open == null) open = !d.open;
  const by = d.upper ? y - 1 : y;
  for (const up of [0, 1]) if (BF.blocks[world.getBlock(x, by + up, z)].door) world.setBlock(x, by + up, z, BF.doorId(d.f, up, open, d.wood));
  return open;
};

// Opens (open = true), closes (false) or toggles (undefined) the fence gate at (x, y, z). Returns the new state, or null.
world.setGate = function (x, y, z, open) {
  const g = BF.blocks[world.getBlock(x, y, z)].gate;
  if (!g) return null;
  if (open == null) open = !g.open;
  if (open !== g.open) world.setBlock(x, y, z, BF.gateId(g.axis, open, g.wood));
  return open;
};

// ---------- collision ----------
// Union of the collision boxes of solid blocks overlapping an entity box (filled by boxHit).
// With axis/prev, boxes the entity already overlapped at coordinate prev on that axis are ignored, so an entity caught
// inside a door slab can walk out of it. For the player (moveBox opts.firm) there is one exception: when this axis is the
// one the player is least far into the box and the move takes it deeper, it still collides (HIT.inside is set, and
// moveAxis keeps the player where it was), so the player can't walk through a block it is only slightly inside, while
// walking along a block it grazes still works. Mobs keep walking out of anything they end up inside (their AI and
// saved spots rely on it).
const HIT = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, inside: false };
let firmInside = false;   // set by moveBox for the player (opts.firm): see boxHit
function boxHit(px, py, pz, hw, h, axis, prev) {
  HIT.inside = false;
  const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw - 1e-6);
  const y0 = Math.floor(py), y1 = Math.floor(py + h - 1e-6);
  const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw - 1e-6);
  let hit = false;
  for (let y = y0 - 1; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (y < y0 && !BF.TALLBOX[world.getBlock(x, y, z)]) continue;   // the layer below the feet only matters for fences / gates (1.5 tall)
    if (!world.isSolid(x, y, z)) continue;
    const bid = world.getBlock(x, y, z);
    const cbl = (BF.DYNBOXES[bid] && BF.DYNBOXES[bid](world.getBlock, x, y, z, bid)) || BF.CBOXES[bid] || (BF.CBOX[bid] ? [BF.CBOX[bid]] : [null]); // slabs/stairs: several boxes, each tested on its own
    for (const cb of cbl) {
    let ax = x, ay = y, az = z, bx = x + 1, by = y + 1, bz = z + 1;
    if (cb) {
      ax += cb[0]; ay += cb[1]; az += cb[2]; bx = x + cb[3]; by = y + cb[4]; bz = z + cb[5];
      if (ax >= px + hw || bx <= px - hw || ay >= py + h || by <= py || az >= pz + hw || bz <= pz - hw) continue;
    }
    if (axis === "x" ? ax < prev + hw && bx > prev - hw : axis === "z" ? az < prev + hw && bz > prev - hw :
      axis === "y" && ay < prev + h && by > prev) {
      // how far the entity (at prev) was into the box on each axis; it only pushes through a face it is shallowest in
      const qx = axis === "x" ? prev : px, qy = axis === "y" ? prev : py, qz = axis === "z" ? prev : pz;
      const ox = Math.min(bx, qx + hw) - Math.max(ax, qx - hw), oy = Math.min(by, qy + h) - Math.max(ay, qy), oz = Math.min(bz, qz + hw) - Math.max(az, qz - hw);
      const o = axis === "x" ? ox : axis === "y" ? oy : oz;
      const mv = (axis === "x" ? px : axis === "y" ? py : pz) - prev;
      const mid = axis === "x" ? (ax + bx) / 2 - prev : axis === "y" ? (ay + by) / 2 - (prev + h / 2) : (az + bz) / 2 - prev;
      if (!firmInside || o > Math.min(ox, oy, oz) || mv * mid <= 0) continue;   // a mob, grazing it along another face, or leaving it
      HIT.inside = true;
    }
    if (!hit) { HIT.x0 = ax; HIT.y0 = ay; HIT.z0 = az; HIT.x1 = bx; HIT.y1 = by; HIT.z1 = bz; hit = true; continue; }
    HIT.x0 = Math.min(HIT.x0, ax); HIT.y0 = Math.min(HIT.y0, ay); HIT.z0 = Math.min(HIT.z0, az);
    HIT.x1 = Math.max(HIT.x1, bx); HIT.y1 = Math.max(HIT.y1, by); HIT.z1 = Math.max(HIT.z1, bz);
    }
  }
  return hit;
}
// True if an axis-aligned box (feet-centre pos, half-width hw, height h) overlaps any solid block
// (doors and beds collide with their smaller box).
world.boxCollides = (px, py, pz, hw, h) => boxHit(px, py, pz, hw, h);

// Moves an entity box through the world with per-axis collision.
// pos: {x,y,z} feet centre (mutated). vel: {x,y,z} (mutated: blocked axes zeroed).
// opts.stepUp: max auto-step height in blocks (1.05 climbs one-block ledges; 0 disables).
// opts.swim: the box is swimming (it was in water last step): it steps up onto a ledge too, as off the ground, so a mob swimming in a
// channel or a pond flush with the land climbs out onto the bank (only a bank no higher than stepUp above its feet).
// Returns {onGround, hitX, hitZ, hitCeil, inWater}.
world.moveBox = function (pos, vel, hw, h, dt, opts) {
  const stepUp = (opts && opts.stepUp) || 0;
  firmInside = !!(opts && opts.firm);
  const res = { onGround: false, hitX: false, hitZ: false, hitCeil: false, inWater: false };
  let top = 0; // top of the last obstacle hit (for stepping up onto beds and blocks)
  const moveAxis = (axis, d) => {
    const n = Math.max(1, Math.ceil(Math.abs(d) / 0.45));
    const step = d / n;
    for (let i = 0; i < n; i++) {
      const prev = pos[axis];
      pos[axis] += step;
      if (boxHit(pos.x, pos.y, pos.z, hw, h, axis, prev)) {
        if (HIT.inside) { pos[axis] = prev; if (axis === "y" && step < 0) res.onGround = true; top = HIT.y1; return true; }
        if (axis === "y") {
          if (step < 0) { pos.y = HIT.y1; res.onGround = true; }
          else { pos.y = HIT.y0 - h - 1e-4; res.hitCeil = true; }
        } else {
          pos[axis] = step > 0 ? HIT[axis + "0"] - hw - 1e-4 : HIT[axis + "1"] + hw + 1e-4;
        }
        top = HIT.y1;
        return true;
      }
    }
    return false;
  };
  if (moveAxis("y", vel.y * dt)) vel.y = 0;
  const wasGround = res.onGround || (vel.y <= 0 && world.boxCollides(pos.x, pos.y - 0.05, pos.z, hw, 0.05));
  for (const axis of ["x", "z"]) {
    const d = vel[axis] * dt;
    if (!d) continue;
    const save = { x: pos.x, y: pos.y, z: pos.z };
    if (moveAxis(axis, d)) {
      // auto step-up onto a ledge
      if (stepUp && (wasGround || (opts && opts.swim))) {
        const lift = { x: save.x, y: save.y, z: save.z };
        lift.y = top > save.y ? top : Math.floor(save.y + 1e-3) + 1; // top of the block we bumped into
        if (lift.y - save.y <= stepUp && !world.boxCollides(lift.x, lift.y, lift.z, hw, h)) {
          lift[axis] += d;
          if (!world.boxCollides(lift.x, lift.y, lift.z, hw, h)) { pos.x = lift.x; pos.y = lift.y; pos.z = lift.z; continue; }
        }
      }
      vel[axis] = 0;
      if (axis === "x") res.hitX = true; else res.hitZ = true;
    }
  }
  if (!res.onGround && vel.y <= 0 && world.boxCollides(pos.x, pos.y - 0.02, pos.z, hw, 0.02)) res.onGround = true;
  res.inWater = BF.RENDER[world.getBlock(pos.x, pos.y + 0.4, pos.z)] === 3;
  res.headInWater = BF.RENDER[world.getBlock(pos.x, pos.y + h - 0.15, pos.z)] === 3;
  firmInside = false;
  return res;
};
})();
