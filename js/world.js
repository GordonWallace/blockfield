// World storage, progressive chunk loading, meshing, edits, raycasting and collision.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const CS = 16;      // chunk width/depth
// World limits are per world (BF.MIN_Y lowest y, BF.H exclusive top, BF.SEA sea level, BF.SY0/SY1 section range) and are set by
// BF.setLimits(gen) (worldgen.init). Legacy generators (1, 2): 0 / 192 / 48; generator 3 (mile-high): -64 / 3072 / 0.
// Never cache them at load time. See docs/MILE_HIGH_CONTRACT.md.
if (!BF.setLimits) BF.setLimits = gen => {
  const L = gen >= 3 ? [-64, 3072, 0] : [0, 192, 48];
  BF.MIN_Y = L[0]; BF.H = L[1]; BF.SEA = L[2]; BF.SY0 = L[0] >> 4; BF.SY1 = L[1] >> 4;
};
if (BF.H == null) BF.setLimits(1);
BF.CS = CS;

// A chunk is a 16x16 column of 16-high sections. c.secs[sy - c.lo] is a Uint16Array(4096) (index (ly << 8 | lz << 4 | lx)) or a
// number (the whole section is that block id). Sections outside [c.lo, c.hi) are not loaded: below = stone, above = air.
const SECN = 4096;
const vIdx = (x, y, z) => (y * CS + z) * CS + x;      // index inside a legacy full-height window (y from 0)
BF.vIdx = vIdx;
const ckey = (cx, cz) => cx + "," + cz;

// Faces: normal, tangent axes (u, v) and the 4 corners in CCW order seen from outside.
const FACES = [
  { n: [0, 1, 0],  c: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], shade: 1.0,  kind: "top" },
  { n: [0, -1, 0], c: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], shade: 0.55, kind: "bottom" },
  { n: [1, 0, 0],  c: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]], shade: 0.8,  kind: "side" },
  { n: [-1, 0, 0], c: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], shade: 0.8,  kind: "side" },
  { n: [0, 0, 1],  c: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], shade: 0.68, kind: "side" },
  { n: [0, 0, -1], c: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], shade: 0.68, kind: "side" },
];
// UV order matching the corner order above (bottom-left, bottom-right, top-right, top-left)
const SIDE_UV = [[0,0],[1,0],[1,1],[0,1]];
const TOP_UV = [[0,0],[1,0],[1,1],[0,1]];
const AO_CURVE = [0.45, 0.65, 0.82, 1.0];

const world = {
  chunks: new Map(),      // key -> chunk
  edits: new Map(),       // key -> Map(localIndex -> blockId); survives unloading
  viewDist: 6,
  queueLength: 0,
  _loadL: [], _unloadL: [],
  _dirty: new Set(),
  _faceUV: null,
  daylight: 1,
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
    for (let f = 0; f < 6; f++) world._faceUV[b.id * 6 + f] = BF.textures.uv(b.tiles[f === 4 ? "front" : FACES[f].kind]);
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
      const n = b.tiles[f === 4 ? "front" : FACES[f].kind];
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
};

world.getBlockLight = (x, y, z) => (BF.light ? BF.light.get(x, y, z) : 0); // block light 0..15 (see light.js)

world.setDaylight = function (l) {
  world.daylight = l;
  dayUniform.value = l;
};

world.onChunkLoad = fn => world._loadL.push(fn);
world.onChunkUnload = fn => world._unloadL.push(fn);

// Removes every chunk, edit and mesh (used for a new world / new seed).
world.reset = function () {
  for (const k of [...world.chunks.keys()]) unload(k);
  world.edits.clear();
  world._dirty.clear();
  fluidQ.clear();
  growing.clear();
  lastCenter = null; genList = []; meshList = []; simList = [];
  if (BF.villageSim) BF.villageSim.reset();   // force a fresh load plan even if the spawn chunk is unchanged
};

// ---------- block access ----------
function chunkAt(x, z) { return world.chunks.get(ckey(Math.floor(x / CS), Math.floor(z / CS))); }
world.chunkAt = chunkAt;
world.isLoaded = (x, z) => !!chunkAt(Math.floor(x), Math.floor(z));

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
  const c = chunkAt(x, z);
  if (!c) return 0;
  return cblock(c, x - c.cx * CS, y, z - c.cz * CS);
};

// Solid for collision. Unloaded chunks count as solid so nothing falls out of the world.
world.isSolid = function (x, y, z) {
  if (y < BF.MIN_Y) return true;
  if (y >= BF.H) return false;
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  const c = chunkAt(x, z);
  if (!c) return true;
  return BF.SOLID[cblock(c, x - c.cx * CS, y, z - c.cz * CS)] === 1;
};

// Writes one voxel into chunk c (inside its band); a uniform section becomes a real array first.
function secSet(c, lx, y, lz, id) {
  const si = (y >> 4) - c.lo;
  let s = c.secs[si];
  if (typeof s === "number") {
    if (s === id) return;
    const a = new Uint16Array(SECN); if (s) a.fill(s);
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
    out[i] = uni ? f : data.slice(o, o + SECN);
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
  c.lo = newLo; c.y0 = newLo * 16;
  const e = world.edits.get(c.key);       // edits are applied when the chunk is created; deeper ones are only possible if the band was shorter then
  if (e) for (const [i, id] of e) { const y = (i >> 8) + BF.MIN_Y; if (y >= c.y0 && y < oldY0) secSet(c, i & 15, y, (i >> 4) & 15, id); }
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) if (c.top[z * CS + x] < oldY0) updateColumn(c, x, z);
  if (BF.light && c.light !== undefined) BF.light.onExtended(c, oldY0);
  markNeighboursDirty(c);
  if (c.mesh !== undefined) world._dirty.add(c.key);
}
// Makes room above the band (all air).
function extendUp(c, newHi) {
  newHi = Math.min(BF.SY1, newHi);
  if (newHi <= c.hi) return;
  for (let i = c.hi; i < newHi; i++) c.secs.push(0);
  if (c.light) for (let i = c.hi; i < newHi; i++) c.light.push(undefined);
  c.hi = newHi; c.y1 = newHi * 16;
}
function markNeighboursDirty(c) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dz) continue;
    const n = world.chunks.get(ckey(c.cx + dx, c.cz + dz));
    if (n && n.mesh !== undefined) world._dirty.add(n.key);
  }
}
// Makes sure the sections covering y0..y1 are loaded in the chunk holding (x, z). False if that chunk is not loaded.
world.ensureRange = function (x, z, y0, y1) {
  const c = chunkAt(x, z);
  if (!c) return false;
  if (y0 < c.y0) extendDown(c, Math.max(BF.MIN_Y, y0) >> 4);
  if (y1 >= c.y1) extendUp(c, (Math.min(BF.H - 1, y1) >> 4) + 1);
  return true;
};

// Sets a block, records the edit, and schedules remeshing. Returns false if the chunk isn't loaded.
world.setBlock = function (x, y, z, id) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (y < BF.MIN_Y || y >= BF.H) return false;
  const c = chunkAt(x, z);
  if (!c) return false;
  if (y < c.y0) extendDown(c, y >> 4); else if (y >= c.y1) extendUp(c, (y >> 4) + 1);
  const lx = x - c.cx * CS, lz = z - c.cz * CS, i = ((y - BF.MIN_Y) * CS + lz) * CS + lx;   // edit index (legacy limits: the old vIdx)
  const oldId = cblock(c, lx, y, lz);
  if (oldId === id) return true;
  secSet(c, lx, y, lz, id);
  let e = world.edits.get(c.key);
  if (!e) world.edits.set(c.key, (e = new Map()));
  e.set(i, id);
  updateColumn(c, lx, lz);
  world._dirty.add(c.key);
  scheduleFluid(x, y, z, true);
  if (BF.light) { BF.light.onSet(x, y, z, oldId, id); BF.light.popUnsupported(x, y, z, id); } // block light + torches losing support
  if (BF.signs) BF.signs.onSet(x, y, z, oldId, id); // sign groups re-merge / text moves / signs pop without support (js/signs.js)
  if (oldId === BF.B.chest && BF.inventory && BF.inventory.chestRemoved) BF.inventory.chestRemoved(x, y, z); // a chest spills its contents (js/inventory.js)
  if (BF.blocks[id] && BF.blocks[id].growsInto) growing.add(fkey(x, y, z));
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
    const n = world.chunks.get(ckey(c.cx + dx, c.cz + dz));
    if (n && n.mesh !== undefined) world._dirty.add(n.key);
  }
  return true;
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

// Highest solid y at column (x, z) in the loaded band, or BF.MIN_Y - 1 (-1 for legacy worlds) when the column is not loaded.
world.heightAt = function (x, z) {
  x = Math.floor(x); z = Math.floor(z);
  const c = chunkAt(x, z);
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
  // light-blocking top (opaque blocks and leaves) for the simple sky-shade model
  let y = c.y1 - 1;
  for (; y >= c.y0; y--) { const b = cblock(c, lx, y, lz); if (BF.OPAQUE[b] || BF.RENDER[b] === 2 || BF.LIGHTBLOCK[b]) break; }
  c.top[lz * CS + lx] = y;
}

// ---------- loading ----------
function createChunk(cx, cz) {
  if (!STONE_ID) { STONE_ID = BF.B.stone; BEDROCK_ID = BF.B.bedrock; }
  const g = BF.worldgen;
  let lo, hi, data;
  if (g.generateBand) { const r = g.generateBand(cx, cz); lo = r.lo; hi = r.hi; data = r.vox; }
  else { hi = BF.H >> 4; lo = 0; data = new Uint16Array(CS * CS * BF.H); g.generate(cx, cz, data); }
  const key = ckey(cx, cz);
  const c = { cx, cz, key, lo, hi, y0: lo * 16, y1: hi * 16, secs: sliceSections(data, hi - lo), top: new Int16Array(CS * CS), mesh: undefined, meshes: [], light: undefined };
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
  world.chunks.set(key, c);
  if (BF.light) BF.light.onChunkCreated(c);
  if (e) for (const [i, id] of e) if (BF.blocks[id] && BF.blocks[id].growsInto) {
    growing.add(fkey(cx * CS + (i & 15), (i >> 8) + BF.MIN_Y, cz * CS + ((i >> 4) & 15)));
  }
  for (const fn of world._loadL) { try { fn(cx, cz, c); } catch (err) { console.error(err); } }
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
  world.chunks.delete(key);
  world._dirty.delete(key);
  for (const fn of world._unloadL) { try { fn(c.cx, c.cz, c); } catch (err) { console.error(err); } }
}

function disposeMeshes(c) {
  for (const m of c.meshes) { scene.remove(m); m.geometry.dispose(); }
  c.meshes = [];
}

function neighboursReady(cx, cz) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
    if (!world.chunks.has(ckey(cx + dx, cz + dz))) return false;
  return true;
}

let lastCenter = null, genList = [], meshList = [], simList = [];
let fwdX = 0, fwdZ = -1, lastPlanT = 0;
function plan(pcx, pcz) {
  const R = world.viewDist;
  lastPlanT = performance.now();
  if (BF.camera) {
    const e = BF.camera.matrixWorld.elements; // camera looks down -Z
    const fx = -e[8], fz = -e[10], l = Math.hypot(fx, fz);
    if (l > 1e-3) { fwdX = fx / l; fwdZ = fz / l; }
  }
  genList = []; meshList = [];
  const keep = new Set();
  for (let dz = -R - 1; dz <= R + 1; dz++) for (let dx = -R - 1; dx <= R + 1; dx++) {
    const d2 = dx * dx + dz * dz;
    if (d2 > (R + 1.5) * (R + 1.5)) continue;
    const cx = pcx + dx, cz = pcz + dz, k = ckey(cx, cz);
    keep.add(k);
    // chunks in front of the camera load first; behind ones are weighted as further away
    const len = Math.sqrt(d2) || 1;
    const dot = (dx * fwdX + dz * fwdZ) / len;
    const score = d2 <= 2 ? d2 : d2 * (1 + 1.5 * Math.max(0, -dot) + 0.5 * (1 - Math.abs(dot)));
    if (!world.chunks.has(k)) genList.push([cx, cz, score]);
    if (d2 <= R * R) meshList.push([cx, cz, score]);
  }
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
  for (const k of [...world.chunks.keys()]) {
    if (keep.has(k)) continue;
    // hysteresis: only unload chunks clearly out of range
    const c = world.chunks.get(k);
    const dx = c.cx - pcx, dz = c.cz - pcz;
    if (dx * dx + dz * dz > (R + 3) * (R + 3)) unload(k);
  }
}

// Called every frame with the player position. budgetMs bounds generation+meshing time.
world.update = function (px, pz, budgetMs = 8) {
  const pcx = Math.floor(px / CS), pcz = Math.floor(pz / CS);
  if (BF.villageSim && BF.villageSim.update(px, pz)) lastCenter = null;   // simulated-village set changed: re-plan
  const center = pcx + "," + pcz + "," + world.viewDist;
  // re-plan on chunk change, and periodically while loading so turning re-prioritises
  if (center !== lastCenter || (world.queueLength > 0 && performance.now() - lastPlanT > 1000)) { lastCenter = center; plan(pcx, pcz); }
  if (world.queueLength > 40) budgetMs = Math.max(budgetMs, 12);

  // vertical streaming: columns near the player load sections down to ~40 blocks below them (digging, caves, falling)
  if (BF.player && BF.player.position) {
    const want = Math.max(BF.SY0, (Math.floor(BF.player.position.y) - 40) >> 4);
    let budget = 3;
    for (let dz = -2; dz <= 2 && budget > 0; dz++) for (let dx = -2; dx <= 2 && budget > 0; dx++) {
      const c = world.chunks.get(ckey(pcx + dx, pcz + dz));
      if (c && c.lo > want) { extendDown(c, dx || dz ? Math.max(want, c.lo - 8) : want); budget--; }
    }
  }

  // edits first: remesh dirty chunks immediately so breaking/placing feels instant
  for (const k of world._dirty) { const c = world.chunks.get(k); if (c && c.mesh !== undefined) buildMesh(c); }
  world._dirty.clear();

  const t0 = performance.now();
  let gi = 0, mi = 0;
  while (performance.now() - t0 < budgetMs) {
    // mesh the nearest chunk whose neighbours exist; otherwise generate the nearest missing data
    while (mi < meshList.length) {
      const [cx, cz] = meshList[mi];
      const c = world.chunks.get(ckey(cx, cz));
      if (c && c.mesh === undefined && neighboursReady(cx, cz)) break;
      if (c && c.mesh !== undefined) { meshList.splice(mi, 1); continue; }
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
      buildMesh(world.chunks.get(ckey(meshCand[0], meshCand[1])));
      meshList.splice(mi, 1);
    } else {
      createChunk(genCand[0], genCand[1]);
      genList.splice(gi, 1);
      mi = 0; // newly generated data may unblock a nearer mesh
    }
  }
  world.queueLength = genList.length + meshList.filter(m => { const c = world.chunks.get(ckey(m[0], m[1])); return !c || c.mesh === undefined; }).length;
};

world.setViewDist = function (d) { world.viewDist = d; lastCenter = null; };
world.meshedCount = () => { let n = 0; for (const c of world.chunks.values()) if (c.mesh !== undefined) n++; return n; };

// ---------- meshing ----------
// Box models in 1/16 block units: (get, x, y, z, id) -> [[x0,y0,z0,x1,y1,z1], ...]
const connects = (get, x, y, z, self, axis) => { const n = get(x, y, z), b = BF.blocks[n]; return n === self || (b && b.model === "fence") || (b && b.gate && b.gate.axis === axis) || (BF.OPAQUE[n] && BF.SOLID[n]); }; // fences of any wood connect to each other and to gates in line with them
const MODELS = {
  fence(get, x, y, z, id) {
    const out = [[6, 0, 6, 10, 16, 10]];
    if (connects(get, x + 1, y, z, id, "x")) out.push([10, 6, 7, 16, 9, 9], [10, 12, 7, 16, 15, 9]);
    if (connects(get, x - 1, y, z, id, "x")) out.push([0, 6, 7, 6, 9, 9], [0, 12, 7, 6, 15, 9]);
    if (connects(get, x, y, z + 1, id, "z")) out.push([7, 6, 10, 9, 9, 16], [7, 12, 10, 9, 15, 16]);
    if (connects(get, x, y, z - 1, id, "z")) out.push([7, 6, 0, 9, 9, 6], [7, 12, 0, 9, 15, 6]);
    return out;
  },
  lantern(get, x, y, z) {
    // hangs from the block above when there is one, otherwise stands on the ground
    const hang = BF.SOLID[get(x, y + 1, z)] && !BF.SOLID[get(x, y - 1, z)] ? 1 : 0;
    const o = hang * 6;
    return [[5, o, 5, 11, o + 7, 11], [6, o + 7, 6, 10, o + 9, 10], ...(hang ? [[7.5, 15, 7.5, 8.5, 16, 8.5].map((v, i) => i === 1 ? o + 9 : v)] : [])];
  },
  // torches: boxes in 1/16; entry 8 = glow (flame drawn at full brightness), entry 9 = lean {dy, base, k, dx, dz} (wall torch)
  torch() { return [[7, 0, 7, 9, 7, 9], [7, 7, 7, 9, 10, 9, undefined, 0, 1]]; },
  wall_torch(get, x, y, z, id) {
    const [dx, dz] = BF.DIRS[BF.blocks[id].wallTorch.f], lean = { dy: 3, base: -6, k: 0.41, dx, dz };
    return [[7, 0, 7, 9, 7, 9, undefined, 0, 0, lean], [7, 7, 7, 9, 10, 9, undefined, 0, 1, lean]];
  },
  bell() { return [[4, 4, 4, 12, 6, 12], [5, 6, 5, 11, 13, 11], [7, 13, 7, 9, 16, 9]]; },
  chest() { return [[1, 0, 1, 15, 14, 15]]; },
  cactus() { return [[1, 0, 1, 15, 16, 15]]; },
  // doors and beds: per-state boxes precomputed in blocks.js (a 7th entry overrides the tile)
  door(get, x, y, z, id) { return BF.blocks[id].boxes; },
  gate(get, x, y, z, id) { return BF.blocks[id].boxes; },   // fence gates (per-state boxes from blocks.js gateDefs)
  bed(get, x, y, z, id) { return BF.blocks[id].boxes; },
  shape(get, x, y, z, id) { return BF.blocks[id].boxes; }, // slabs and stairs (per-state boxes from blocks.js)
};
// ---- panes, iron bars and ladders ----
// "pane" model (glass panes, stained panes, iron bars): a 2/16 post plus an arm towards every neighbour that is another pane/bars, a glass block
// or a full opaque solid block (a lone pane is a cross). One block id each; the arms are computed here (like fences) for the mesh and for collision (BF.DYNBOXES).
const isPane = n => { const b = BF.blocks[n]; return !!b && b.model === "pane"; };
const isGlassBlock = n => { const b = BF.blocks[n]; return !!b && b.render === "cutout" && /(^|_)glass$/.test(b.name); };
const paneJoins = n => isPane(n) || isGlassBlock(n) || (BF.OPAQUE[n] === 1 && BF.SOLID[n] === 1 && BF.RENDER[n] === 1);
const PANE_ARMS = [[7, 0, 0, 9, 16, 7], [9, 0, 7, 16, 16, 9], [7, 0, 9, 9, 16, 16], [0, 0, 7, 7, 16, 9]]; // north (-z), east (+x), south (+z), west (-x)
// face bits (emitBox 8th entry): 0 top, 1 bottom, 2 +x, 3 -x, 4 +z, 5 -z
const ARM_HIDE = [(1 << 5) | (1 << 4), (1 << 2) | (1 << 3), (1 << 4) | (1 << 5), (1 << 3) | (1 << 2)]; // cap at the cell edge + face towards the post
const POST_HIDE = [1 << 5, 1 << 2, 1 << 4, 1 << 3];                                                     // post face on the side of arm i
function paneArms(get, x, y, z) {
  const a = [paneJoins(get(x, y, z - 1)), paneJoins(get(x + 1, y, z)), paneJoins(get(x, y, z + 1)), paneJoins(get(x - 1, y, z))];
  return a[0] || a[1] || a[2] || a[3] ? a : [true, true, true, true];
}
function paneBoxes(get, x, y, z) {
  const arms = paneArms(get, x, y, z);
  const upA = isPane(get(x, y + 1, z)) ? paneArms(get, x, y + 1, z) : null, dnA = isPane(get(x, y - 1, z)) ? paneArms(get, x, y - 1, z) : null;
  let post = (upA ? 1 : 0) | (dnA ? 2 : 0);
  const out = [];
  for (let i = 0; i < 4; i++) if (arms[i]) {
    post |= POST_HIDE[i];
    out.push([...PANE_ARMS[i], 0, ARM_HIDE[i] | (upA && upA[i] ? 1 : 0) | (dnA && dnA[i] ? 2 : 0)]);
  }
  out.unshift([7, 0, 7, 9, 16, 9, 0, post]);
  return out;
}
MODELS.pane = (get, x, y, z) => paneBoxes(get, x, y, z);
MODELS.ladder = (get, x, y, z, id) => BF.blocks[id].boxes; // per-facing box precomputed in blocks.js
world.MODELS = MODELS; // extra packs register models here (js/signs.js: MODELS.sign); models get (get, x, y, z, id, worldX, worldZ)
BF.DYNBOXES = BF.DYNBOXES || []; // id -> fn(get, x, y, z, id) -> collision boxes in blocks (checked by boxHit before CBOXES / CBOX)
for (const b of BF.blocks) if (b && b.model === "pane") BF.DYNBOXES[b.id] = (get, x, y, z) => paneBoxes(get, x, y, z).map(q => [q[0] / 16, q[1] / 16, q[2] / 16, q[3] / 16, q[4] / 16, q[5] / 16]);
// A ladder needs a full solid opaque block behind it (the cell at pos + DIRS[f]).
BF.ladderSupport = id => BF.SOLID[id] === 1 && BF.OPAQUE[id] === 1;
const tileRects = {};
const tileRect = n => tileRects[n] || (tileRects[n] = BF.textures.uv(n));

function buildMesh(c) {
  const ox = c.cx * CS, oz = c.cz * CS;
  // 3x3 neighbourhood for border lookups
  const nb = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(world.chunks.get(ckey(c.cx + dx, c.cz + dz)));
  const MINY = BF.MIN_Y, HTOP = BF.H;
  const get = (x, y, z) => {
    if (y < MINY) return BEDROCK_ID;
    if (y >= HTOP) return 0;
    const ix = x < 0 ? 0 : x >= CS ? 2 : 1, iz = z < 0 ? 0 : z >= CS ? 2 : 1;
    const ch = nb[iz * 3 + ix];
    if (!ch) return 0;
    if (y < ch.y0) return STONE_ID;
    if (y >= ch.y1) return 0;
    const s = ch.secs[(y >> 4) - ch.lo];
    return typeof s === "number" ? s : s[((y & 15) << 8) | ((z - (iz - 1) * CS) << 4) | (x - (ix - 1) * CS)];
  };
  const topAt = (x, z) => {
    const ix = x < 0 ? 0 : x >= CS ? 2 : 1, iz = z < 0 ? 0 : z >= CS ? 2 : 1;
    const ch = nb[iz * 3 + ix];
    if (!ch) return -1;
    return ch.top[(z - (iz - 1) * CS) * CS + (x - (ix - 1) * CS)];
  };
  const occ = (x, y, z) => BF.OPAQUE[get(x, y, z)];
  // block light (0..15) from the neighbourhood's chunk.light arrays (0 where unloaded)
  const lget = (x, y, z) => {
    if (y < MINY || y >= HTOP) return 0;
    const ix = x < 0 ? 0 : x >= CS ? 2 : 1, iz = z < 0 ? 0 : z >= CS ? 2 : 1;
    const ch = nb[iz * 3 + ix];
    if (!ch || !ch.light || y < ch.y0 || y >= ch.y1) return 0;
    const ls = ch.light[(y >> 4) - ch.lo];
    return ls ? ls[((y & 15) << 8) | ((z - (iz - 1) * CS) << 4) | (x - (ix - 1) * CS)] : 0;
  };
  // light of the cell a model / plant occupies; a cell that is itself opaque takes the best neighbour
  const cellLight = (x, y, z) => {
    let v = lget(x, y, z);
    if (OPAQUE[get(x, y, z)] || !v) {
      if (OPAQUE[get(x, y, z)]) { v = 0; for (let d = 0; d < 6; d++) { const n = lget(x + (d === 0) - (d === 1), y + (d === 2) - (d === 3), z + (d === 4) - (d === 5)); if (n > v) v = n; } }
    }
    return v / 15;
  };
  const blv = [0, 0, 0, 0];

  const S = { pos: [], uv: [], col: [], sky: [], bl: [], ind: [] };
  const L = { pos: [], uv: [], col: [], sky: [], bl: [], ind: [] };
  const RENDER = BF.RENDER, OPAQUE = BF.OPAQUE, FLUID = BF.FLUID;
  const faceTint = world._faceTint;
  const B_PATH = BF.B.dirt_path, B_FARM = BF.B.farmland;

  // Biome tint per column over an 18x18 area (1-block border) so AO-free tint blends at borders.
  const tintFn = BF.worldgen.tintAt;
  const TW = CS + 2;
  const tint = new Float32Array(TW * TW * 9); // grass rgb, foliage rgb, water rgb
  for (let z = -1; z <= CS; z++) for (let x = -1; x <= CS; x++) {
    const o = ((z + 1) * TW + (x + 1)) * 9;
    let t = null;
    try { t = tintFn ? tintFn(ox + x, oz + z) : null; } catch (_) { t = null; }
    const g = (t && t.grass) || [1, 1, 1], fo = (t && t.foliage) || [1, 1, 1], w = (t && t.water) || [1, 1, 1];
    tint[o] = g[0]; tint[o + 1] = g[1]; tint[o + 2] = g[2];
    tint[o + 3] = fo[0]; tint[o + 4] = fo[1]; tint[o + 5] = fo[2];
    tint[o + 6] = w[0]; tint[o + 7] = w[1]; tint[o + 8] = w[2];
  }
  // tint at a vertex corner: average of the 4 columns around it (smooth gradients across borders)
  const tintAtCorner = (vx, vz, kind, out) => {
    // vx, vz are local corner coords 0..CS
    out[0] = out[1] = out[2] = 0;
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const o = ((vz + dz + 1) * TW + (vx + dx + 1)) * 9 + (kind - 1) * 3;
      out[0] += tint[o]; out[1] += tint[o + 1]; out[2] += tint[o + 2];
    }
    out[0] *= 0.25; out[1] *= 0.25; out[2] *= 0.25;
  };
  const tc = [1, 1, 1];

  // water surface height of a cell: -1 not water, 1 if water above, else by level
  const fluidH = (x, y, z) => {
    const f = FLUID[get(x, y, z)];
    if (!f) return -1;
    if (FLUID[get(x, y + 1, z)]) return 1;
    return f === 8 ? 0.889 : (8 - f) / 9;
  };
  const cornerH = (x, y, z, cx, cz) => {
    // corner shared by cells (x+cx-1 .. x+cx, z+cz-1 .. z+cz)
    let sum = 0, n = 0;
    for (let dz = cz - 1; dz <= cz; dz++) for (let dx = cx - 1; dx <= cx; dx++) {
      const h = fluidH(x + dx, y, z + dz);
      if (h >= 1) return 1;
      if (h >= 0) { sum += h; n++; }
    }
    return n ? sum / n : 0.889;
  };

  const sideAxes = [];
  for (let f = 0; f < 6; f++) { const a = []; for (let i = 0; i < 3; i++) if (FACES[f].n[i] === 0) a.push(i); sideAxes.push(a); }
  const p = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];
  const lowUV = [[0, 0], [0, 0], [0, 0], [0, 0]], aoVals = [0, 0, 0, 0], vh = [0, 0, 0, 0];

  const skyAt = (ax, ay, az) => {
    const top = topAt(ax, az);
    return ay > top ? 1 : Math.max(0.3, 0.92 - (top - ay) * 0.06);
  };

  // Emits one quad. corners: 4 [x,y,z] local; uvs: 4 [u,v] in 0..1 of rect; shade per vertex; tintKind
  function quad(T, rect, cs, uvs, shades, sky, tintKind, flip, lx, lz) {
    const v0 = T.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      const q = cs[k];
      T.pos.push(ox + q[0], q[1], oz + q[2]);
      T.uv.push(rect[0] + (rect[2] - rect[0]) * uvs[k][0], rect[1] + (rect[3] - rect[1]) * uvs[k][1]);
      const l = shades[k];
      if (tintKind) {
        tintAtCorner(Math.max(0, Math.min(CS, Math.round(q[0]))), Math.max(0, Math.min(CS, Math.round(q[2]))), tintKind, tc);
        T.col.push(l * tc[0], l * tc[1], l * tc[2]);
      } else T.col.push(l, l, l);
      T.sky.push(sky);
      T.bl.push(blv[k]);
    }
    if (flip) T.ind.push(v0 + 1, v0 + 2, v0 + 3, v0 + 1, v0 + 3, v0);
    else T.ind.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  }

  const CROSS = [
    [[0.15, 0, 0.15], [0.85, 0, 0.85], [0.85, 1, 0.85], [0.15, 1, 0.15]],
    [[0.85, 0, 0.85], [0.15, 0, 0.15], [0.15, 1, 0.15], [0.85, 1, 0.85]],
    [[0.15, 0, 0.85], [0.85, 0, 0.15], [0.85, 1, 0.15], [0.15, 1, 0.85]],
    [[0.85, 0, 0.15], [0.15, 0, 0.85], [0.15, 1, 0.85], [0.85, 1, 0.15]],
  ];
  const cs4 = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const sh4 = [0, 0, 0, 0];

  // Emits a box given in 1/16 units inside cell (x,y,z); UVs follow the box's position in the cell.
  const UVAX = [[0, 2], [0, 2], [2, 1], [2, 1], [0, 1], [0, 1]]; // per face: [u axis, v axis]
  function emitBox(b, x, y, z, bx) {
    const lo = [bx[0] / 16, bx[1] / 16, bx[2] / 16], hi = [bx[3] / 16, bx[4] / 16, bx[5] / 16];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      if (bx[7] & (1 << f)) continue; // 8th entry: bitmask of faces hidden by a joined neighbour (panes)
      // a face flush with the cell edge is hidden by an opaque neighbour
      const axis = F.n[0] ? 0 : F.n[1] ? 1 : 2, dir = F.n[axis];
      if ((dir > 0 ? hi[axis] >= 1 : lo[axis] <= 0) && OPAQUE[get(x + F.n[0], y + F.n[1], z + F.n[2])]) continue;
      const rect = bx[6] ? tileRect(bx[6]) : world._faceUV[b * 6 + f];
      if (!rect) continue;
      const sky = skyAt(x + (dir > 0 && axis === 0 ? 1 : 0), y + (axis === 1 && dir > 0 ? 1 : 0), z + (dir > 0 && axis === 2 ? 1 : 0));
      const [ua, va] = UVAX[f];
      const uvs = [[0, 0], [0, 0], [0, 0], [0, 0]];
      const glow = bx[8], lean = bx[9], cl = glow ? 2 : cellLight(x, y, z);
      for (let k = 0; k < 4; k++) {
        const cc = F.c[k];
        const lp = [cc[0] ? hi[0] : lo[0], cc[1] ? hi[1] : lo[1], cc[2] ? hi[2] : lo[2]];
        cs4[k][0] = x + lp[0]; cs4[k][1] = y + lp[1]; cs4[k][2] = z + lp[2];
        if (lean) { const o = (lean.base + lean.k * lp[1] * 16) / 16; cs4[k][0] += lean.dx * o; cs4[k][2] += lean.dz * o; cs4[k][1] += lean.dy / 16; }
        uvs[k][0] = lp[ua]; uvs[k][1] = lp[va];
        sh4[k] = glow ? 1 : F.shade;
        blv[k] = cl;
      }
      quad(BF.blocks[b].translucent ? L : S, rect, cs4, uvs, sh4, sky, faceTint[b * 6 + f] === 4 ? 1 : faceTint[b * 6 + f], false); // stained panes: blended pass
    }
  }

  for (let si = 0; si < c.hi - c.lo; si++) {
  const sec = c.secs[si];
  if (sec === 0) continue;                                   // all-air section
  const uni = typeof sec === "number", sy0 = (c.lo + si) * 16;
  for (let ly = 0; ly < 16; ly++) for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    let b;
    if (uni) {
      // inside a uniform opaque block nothing is visible: only the shell of the section can show faces
      if (OPAQUE[sec] && ly > 0 && ly < 15 && z > 0 && z < 15 && x > 0 && x < 15) { x = 14; continue; }
      b = sec;
    } else b = sec[(ly << 8) | (z << 4) | x];
    if (!b) continue;
    const y = sy0 + ly;
    const r = RENDER[b];

    if (r === 4) { // crossed-quad plant
      const rect = world._faceUV[b * 6 + 2];
      if (!rect) continue;
      const sky = skyAt(x, y, z), crossL = cellLight(x, y, z);
      const tk = faceTint[b * 6 + 2];
      // small deterministic offset so fields of grass don't look gridded
      const h = ((ox + x) * 73856093 ^ (oz + z) * 19349663) >>> 0;
      const jx = ((h & 255) / 255 - 0.5) * 0.3, jz = (((h >> 8) & 255) / 255 - 0.5) * 0.3;
      for (const q of CROSS) {
        for (let k = 0; k < 4; k++) { cs4[k][0] = x + q[k][0] + jx; cs4[k][1] = y + q[k][1]; cs4[k][2] = z + q[k][2] + jz; sh4[k] = q[k][1] ? 0.95 : 0.75; blv[k] = crossL; }
        quad(S, rect, cs4, SIDE_UV, sh4, sky, tk === 4 ? 1 : tk, false);
      }
      continue;
    }

    if (r === 5) { // small-box model (fence, lantern, chest...)
      const make = MODELS[BF.blocks[b].model];
      if (!make) continue;
      for (const bx of make(get, x, y, z, b, ox + x, oz + z)) emitBox(b, x, y, z, bx);
      continue;
    }

    const isFluid = r === 3;
    if (isFluid) {
      vh[0] = vh[1] = vh[2] = vh[3] = 1;
    }
    let fluidTopComputed = false;

    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const ax = x + F.n[0], ay = y + F.n[1], az = z + F.n[2];
      const n = get(ax, ay, az);
      if (isFluid) {
        if (FLUID[n] || OPAQUE[n]) continue;
      } else if (r === 2) {
        if (OPAQUE[n] || n === b) continue;
      } else if (OPAQUE[n]) continue;
      const rect = world._faceUV[b * 6 + f];
      if (!rect) continue;
      const sky = skyAt(ax, ay, az);
      let uvs = F.kind === "side" ? SIDE_UV : TOP_UV;
      const flL = isFluid ? lget(ax, ay, az) / 15 : 0;

      if (isFluid) {
        if (!fluidTopComputed) {
          fluidTopComputed = true;
          if (!FLUID[get(x, y + 1, z)]) {
            // per-corner heights; vh index matches the corner's (cx, cz)
            vh[0] = cornerH(x, y, z, 0, 0); vh[1] = cornerH(x, y, z, 1, 0);
            vh[2] = cornerH(x, y, z, 0, 1); vh[3] = cornerH(x, y, z, 1, 1);
          }
        }
        for (let k = 0; k < 4; k++) {
          const cc = F.c[k];
          cs4[k][0] = x + cc[0]; cs4[k][2] = z + cc[2];
          cs4[k][1] = y + (cc[1] ? vh[cc[2] * 2 + cc[0]] : 0);
          sh4[k] = F.shade;
          blv[k] = flL;
        }
        quad(L, rect, cs4, uvs, sh4, sky, faceTint[b * 6 + f] ? 3 : 0, false);
        continue;
      }

      // solid / cutout cube face with ambient occlusion (paths and farmland sit 1/16 lower)
      const lowTop = (b === B_PATH || b === B_FARM) && !BF.SOLID[get(x, y + 1, z)];
      const ua = sideAxes[f][0], va = sideAxes[f][1];
      for (let k = 0; k < 4; k++) {
        const cc = F.c[k];
        cs4[k][0] = x + cc[0]; cs4[k][1] = y + cc[1] - (lowTop && cc[1] ? 0.0625 : 0); cs4[k][2] = z + cc[2];
        const du = cc[ua] ? 1 : -1, dv = cc[va] ? 1 : -1;
        p[0] = ax; p[1] = ay; p[2] = az;
        p1[0] = ax; p1[1] = ay; p1[2] = az; p1[ua] += du;
        p2[0] = ax; p2[1] = ay; p2[2] = az; p2[va] += dv;
        p3[0] = ax; p3[1] = ay; p3[2] = az; p3[ua] += du; p3[va] += dv;
        const o1 = occ(p1[0], p1[1], p1[2]), o2 = occ(p2[0], p2[1], p2[2]), o3 = occ(p3[0], p3[1], p3[2]);
        const ao = o1 && o2 ? 0 : 3 - o1 - o2 - o3;
        aoVals[k] = ao;
        sh4[k] = F.shade * AO_CURVE[ao];
        // smooth block light: mean of the face cell and the non-opaque cells around this corner
        let ls = lget(ax, ay, az), ln = 1;
        if (!o1) { ls += lget(p1[0], p1[1], p1[2]); ln++; }
        if (!o2) { ls += lget(p2[0], p2[1], p2[2]); ln++; }
        if (!o3 && !(o1 && o2)) { ls += lget(p3[0], p3[1], p3[2]); ln++; }
        blv[k] = ls / ln / 15;
      }
      // a lowered block's sides crop the tile's top 1/16 (as vanilla does) instead of squeezing it, or the tile's top row shows as a strip
      if (lowTop && F.kind === "side") {
        for (let k = 0; k < 4; k++) { lowUV[k][0] = SIDE_UV[k][0]; lowUV[k][1] = F.c[k][1] ? (SIDE_UV[k][1] ? 0.9375 : 0.0625) : SIDE_UV[k][1]; }
        uvs = lowUV;
      }
      const flip = aoVals[0] + aoVals[2] < aoVals[1] + aoVals[3];
      const tk = faceTint[b * 6 + f];
      if (tk === 4) {
        // grass side: plain dirt, then a tinted fringe overlay pushed out slightly
        quad(S, world._dirtUV, cs4, uvs, sh4, sky, 0, flip);
        const e = 0.002;
        for (let k = 0; k < 4; k++) { cs4[k][0] += F.n[0] * e; cs4[k][1] += F.n[1] * e; cs4[k][2] += F.n[2] * e; }
        quad(S, world._overlayUV, cs4, uvs, sh4, sky, 1, flip);
      } else {
        quad(BF.blocks[b].translucent ? L : S, rect, cs4, uvs, sh4, sky, tk, flip); // stained glass: blended pass
      }
    }
  }
  }

  disposeMeshes(c);
  const make = (T, mat, order) => {
    if (!T.ind.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(T.pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(T.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(T.col, 3));
    g.setAttribute("skyl", new THREE.Float32BufferAttribute(T.sky, 1));
    g.setAttribute("bl", new THREE.Float32BufferAttribute(T.bl, 1));
    g.setIndex(T.ind);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = order;
    m.matrixAutoUpdate = false;
    scene.add(m);
    c.meshes.push(m);
  };
  make(S, solidMat, 0);
  make(L, liquidMat, 1);
  c.mesh = true;
}

// ---------- flowing water ----------
// Cellular water like Minecraft: sources (FLUID 8) feed flowing cells whose level rises
// by one per block (1 next to a source .. 7 thinnest). Water falls first; flowing water only
// spreads sideways when it rests on something. Two sources feeding a cell on solid ground
// make a new source. Cells are re-evaluated only after something near them changed.
const fluidQ = new Set();
let fluidLast = 0;
const FLUID_TICK = 0.25; // seconds per spread step
const fkey = (x, y, z) => x + "," + y + "," + z;

function scheduleFluid(x, y, z, withNeighbours) {
  if (y < BF.MIN_Y || y >= BF.H) return;
  fluidQ.add(fkey(x, y, z));
  if (withNeighbours) {
    fluidQ.add(fkey(x + 1, y, z)); fluidQ.add(fkey(x - 1, y, z));
    fluidQ.add(fkey(x, y, z + 1)); fluidQ.add(fkey(x, y, z - 1));
    if (y + 1 < BF.H) fluidQ.add(fkey(x, y + 1, z));
    if (y > BF.MIN_Y) fluidQ.add(fkey(x, y - 1, z));
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

function fluidTick() {
  const now = BF.simNow();
  if (now - fluidLast < FLUID_TICK) return;
  fluidLast = now;
  if (!fluidQ.size) return;
  const FLUID = BF.FLUID, REPL = BF.REPLACEABLE;
  const batch = [...fluidQ];
  fluidQ.clear();
  let budget = 3000;
  const changes = [];
  for (const k of batch) {
    if (budget-- <= 0) { fluidQ.add(k); continue; }
    const [x, y, z] = k.split(",").map(Number);
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
// Young crops (blocks with growsInto) mature after ~4 minutes (1/5 game day) on average, only on farmland.
const growing = new Set();
let growLast = 0;
const GROW_CHANCE_PER_S = 1 / 240;   // ~4 minutes (a fifth of the 1200 s game day) on average
function growTick() {
  const now = BF.simNow();
  if (now - growLast < 1) return;
  const dt = Math.min(5, now - growLast);
  growLast = now;
  for (const k of growing) {
    const [x, y, z] = k.split(",").map(Number);
    if (!world.isLoaded(x, z)) continue; // keeps waiting until its chunk is back
    const id = world.getBlock(x, y, z), b = BF.blocks[id];
    if (!b || !b.growsInto) { growing.delete(k); continue; }
    if (world.getBlock(x, y - 1, z) !== BF.B.farmland) continue;
    // crops grow 1.5x faster while it rains (js/weather.js)
    if (Math.random() < GROW_CHANCE_PER_S * dt * (BF.weather && BF.weather.raining ? 1.5 : 1)) { growing.delete(k); world.setBlock(x, y, z, b.growsInto); }
  }
}
world.growingCount = () => growing.size;
// Fluid spread and crop growth run on the simulation clock (BF.simNow), once per sim step, so fast-forward (js/timewarp.js) speeds them up too.
world.tickSim = () => { fluidTick(); growTick(); };

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
// With axis/prev, boxes the entity already overlapped at coordinate prev on that axis are ignored,
// so an entity caught inside a door slab can walk out of it.
const HIT = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };
function boxHit(px, py, pz, hw, h, axis, prev) {
  const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw - 1e-6);
  const y0 = Math.floor(py), y1 = Math.floor(py + h - 1e-6);
  const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw - 1e-6);
  let hit = false;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
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
      axis === "y" && ay < prev + h && by > prev) continue;
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
// Returns {onGround, hitX, hitZ, hitCeil, inWater}.
world.moveBox = function (pos, vel, hw, h, dt, opts) {
  const stepUp = (opts && opts.stepUp) || 0;
  const res = { onGround: false, hitX: false, hitZ: false, hitCeil: false, inWater: false };
  let top = 0; // top of the last obstacle hit (for stepping up onto beds and blocks)
  const moveAxis = (axis, d) => {
    const n = Math.max(1, Math.ceil(Math.abs(d) / 0.45));
    const step = d / n;
    for (let i = 0; i < n; i++) {
      const prev = pos[axis];
      pos[axis] += step;
      if (boxHit(pos.x, pos.y, pos.z, hw, h, axis, prev)) {
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
      if (stepUp && wasGround) {
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
  return res;
};
})();
