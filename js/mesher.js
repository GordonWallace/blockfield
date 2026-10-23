// The chunk mesher (spec r15-03): turns a chunk's blocks, light and sky light into vertex arrays. It runs in the page (js/world.js, for
// the player's own edits and when no worker is available) and in the mesher workers (js/meshworker.js), from the same job and tables, so
// both build the same arrays. It reads nothing from the world: everything comes in the job (built by meshJob in js/world.js) and the
// tables (meshTables there).
// job J: ox, oz (the chunk's corner), lo, hi, y0, y1, secs, light, sky (the chunk's sections, as chunk.secs / .light / .sky), Y0, Y1, rb,
//   rl, rs (blocks, block light and sky light of the ring of columns up to 2 blocks around the chunk, for y in [Y0, Y1), read from the 8
//   neighbours as the mesher saw them before: across a face edge through the world, turned), tint (Float32Array 18 x 18 x 9: biome tints
//   with a 1-block border), ext (cell -> boxes of models drawn from world state, such as signs), sph (on the planet: dirs, anchor, R, sea).
// tables TB: RENDER, OPAQUE, FLUID, SOLID, SATT, SKB, faceUV, faceTint, dirtUV, overlayUV, tiles (tile name -> atlas rect), tile0,
//   blocks (id -> { model, translucent, boxes, gate, wallTorch, name, render }), DIRS, STONE, BEDROCK, PATH, FARM, FARM_DRY, MINY, HTOP.
// build(J, TB) -> { S, L } (solid and blended passes), each null or { pos, uv, col, sky, bl, sphere (planet), ind } typed arrays.
(() => {
"use strict";
const G = typeof window !== "undefined" ? window : self;   // self: in a mesher worker
const BF = (G.BF = G.BF || {});
const CS = 16;
let TB = null;   // the tables of the build running now (the models read them)

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

// ---- the ring around a chunk ----
// Columns x, z in [-2, 18) that are not the chunk's own: RING[(z + 2) * 20 + x + 2] is the column's number (0..143), -1 inside the chunk.
const RW = CS + 4, RING = new Int16Array(RW * RW);
let RN = 0;
for (let z = -2; z < CS + 2; z++) for (let x = -2; x < CS + 2; x++) RING[(z + 2) * RW + x + 2] = x >= 0 && x < CS && z >= 0 && z < CS ? -1 : RN++;

// Box models in 1/16 block units: (get, x, y, z, id) -> [[x0,y0,z0,x1,y1,z1], ...]
// The models here read only the tables (TB), so they run in a worker too; models registered later on world.MODELS (js/signs.js) read
// world state and are worked out on the main thread (meshJob's ext).
const connects = (get, x, y, z, self, axis) => { const n = get(x, y, z), b = TB.blocks[n]; return n === self || (b && b.model === "fence") || (b && b.gate && b.gate.axis === axis) || (TB.OPAQUE[n] && TB.SOLID[n]); }; // fences of any wood connect to each other and to gates in line with them
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
    const hang = TB.SOLID[get(x, y + 1, z)] && !TB.SOLID[get(x, y - 1, z)] ? 1 : 0;
    const o = hang * 6;
    return [[5, o, 5, 11, o + 7, 11], [6, o + 7, 6, 10, o + 9, 10], ...(hang ? [[7.5, 15, 7.5, 8.5, 16, 8.5].map((v, i) => i === 1 ? o + 9 : v)] : [])];
  },
  // torches: boxes in 1/16; entry 8 = glow (flame drawn at full brightness), entry 9 = lean {dy, base, k, dx, dz} (wall torch)
  torch() { return [[7, 0, 7, 9, 7, 9], [7, 7, 7, 9, 10, 9, undefined, 0, 1]]; },
  wall_torch(get, x, y, z, id) {
    const [dx, dz] = TB.DIRS[TB.blocks[id].wallTorch.f], lean = { dy: 3, base: -6, k: 0.41, dx, dz };
    return [[7, 0, 7, 9, 7, 9, undefined, 0, 0, lean], [7, 7, 7, 9, 10, 9, undefined, 0, 1, lean]];
  },
  bell() { return [[4, 4, 4, 12, 6, 12], [5, 6, 5, 11, 13, 11], [7, 13, 7, 9, 16, 9]]; },
  chest() { return [[1, 0, 1, 15, 14, 15]]; },
  cactus() { return [[1, 0, 1, 15, 16, 15]]; },
  // doors and beds: per-state boxes precomputed in blocks.js (a 7th entry overrides the tile)
  door(get, x, y, z, id) { return TB.blocks[id].boxes; },
  gate(get, x, y, z, id) { return TB.blocks[id].boxes; },   // fence gates (per-state boxes from blocks.js gateDefs)
  bed(get, x, y, z, id) { return TB.blocks[id].boxes; },
  shape(get, x, y, z, id) { return TB.blocks[id].boxes; }, // slabs and stairs (per-state boxes from blocks.js)
};
// ---- panes, iron bars and ladders ----
// "pane" model (glass panes, stained panes, iron bars): a 2/16 post plus an arm towards every neighbour that is another pane/bars, a glass block
// or a full opaque solid block (a lone pane is a cross). One block id each; the arms are computed here (like fences) for the mesh and for collision (BF.DYNBOXES).
const isPane = n => { const b = TB.blocks[n]; return !!b && b.model === "pane"; };
const isGlassBlock = n => { const b = TB.blocks[n]; return !!b && b.render === "cutout" && /(^|_)glass$/.test(b.name); };
const paneJoins = n => isPane(n) || isGlassBlock(n) || (TB.OPAQUE[n] === 1 && TB.SOLID[n] === 1 && TB.RENDER[n] === 1);
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
MODELS.ladder = (get, x, y, z, id) => TB.blocks[id].boxes; // per-facing box precomputed in blocks.js
const BUILTIN = Object.assign({}, MODELS);   // (the models a worker has)
const tileRect = n => TB.tiles[n] || TB.tile0;

function build(J, tables) {
  TB = tables;
  const ox = J.ox, oz = J.oz, BL = TB.blocks, RENDER = TB.RENDER, OPAQUE = TB.OPAQUE, FLUID = TB.FLUID, SOLID = TB.SOLID;
  const MINY = TB.MINY, HTOP = TB.HTOP, STONE_ID = TB.STONE, BEDROCK_ID = TB.BEDROCK;
  const cy0 = J.y0, cy1 = J.y1, clo = J.lo, csecs = J.secs, clight = J.light, csky = J.sky;
  const Y0 = J.Y0, NY = J.Y1 - J.Y0, rb = J.rb, rl = J.rl, rs = J.rs, ext = J.ext;
  // ring cell index of (x, y, z) outside the chunk's own columns, or -1
  const ri = (x, y, z) => {
    const yy = y - Y0;
    if (x < -2 || x >= CS + 2 || z < -2 || z >= CS + 2 || yy < 0 || yy >= NY) return -1;
    const r = RING[(z + 2) * RW + x + 2];
    return r < 0 ? -1 : r * NY + yy;
  };
  const get = (x, y, z) => {
    if (y < MINY) return BEDROCK_ID;
    if (y >= HTOP) return 0;
    if (x >= 0 && x < CS && z >= 0 && z < CS) {
      if (y < cy0) return STONE_ID;
      if (y >= cy1) return 0;
      const s = csecs[(y >> 4) - clo];
      return typeof s === "number" ? s : s[((y & 15) << 8) | (z << 4) | x];
    }
    const i = ri(x, y, z);
    return i < 0 ? 0 : rb[i];
  };
  const occ = (x, y, z) => OPAQUE[get(x, y, z)];
  // block light (0..15) from the chunk.light arrays (0 where unloaded)
  const lget = (x, y, z) => {
    if (y < MINY || y >= HTOP) return 0;
    if (x >= 0 && x < CS && z >= 0 && z < CS) {
      if (!clight || y < cy0 || y >= cy1) return 0;
      const ls = clight[(y >> 4) - clo];
      return ls ? ls[((y & 15) << 8) | (z << 4) | x] : 0;
    }
    const i = ri(x, y, z);
    return i < 0 ? 0 : rl[i];
  };
  // sky light level 0..15 of a cell (15 where unloaded or above a band)
  const sgetN = (x, y, z) => {
    if (x >= 0 && x < CS && z >= 0 && z < CS) {
      if (!csky || y >= cy1) return 15;
      if (y < cy0) return 0;
      const s = csky[(y >> 4) - clo];
      return typeof s === "number" ? s : s[((y & 15) << 8) | (z << 4) | x];
    }
    const i = ri(x, y, z);
    return i < 0 ? (y < Y0 ? 0 : 15) : rs[i];
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
  const faceTint = TB.faceTint, faceUV = TB.faceUV;
  const B_PATH = TB.PATH, B_FARM = TB.FARM, B_FARM_DRY = TB.FARM_DRY;

  // Biome tint per column over an 18x18 area (1-block border) so AO-free tint blends at borders: grass rgb, foliage rgb, water rgb
  // (worked out on the main thread, js/world.js meshJob)
  const TW = CS + 2;
  const tint = J.tint;
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

  // sky light (js/skylight.js): level 0..15 of a cell (sgetN above), brightness through BRIGHT
  const SKB = TB.SKB, SATT = TB.SATT;
  // brightness of a cell; a cell that stops sky light (a slab, a stair, a solid block) takes its best neighbour
  const skyAt = (x, y, z) => {
    if (SATT[get(x, y, z)] !== 255) return SKB[sgetN(x, y, z)];
    let v = 0;
    for (let d = 0; d < 6; d++) { const n = sgetN(x + (d === 0) - (d === 1), y + (d === 2) - (d === 3), z + (d === 4) - (d === 5)); if (n > v) v = n; }
    return SKB[v];
  };
  const skv = [0, 0, 0, 0];

  // Emits one quad. corners: 4 [x,y,z] local; uvs: 4 [u,v] in 0..1 of rect; shade per vertex; tintKind
  function quad(T, rect, cs, uvs, shades, sky, tintKind, flip, lx, lz) {
    const v0 = T.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      const q = cs[k];
      T.pos.push(q[0], q[1], q[2]);   // chunk-local: the mesh is placed at the chunk's corner (floating origin, js/view.js)
      T.uv.push(rect[0] + (rect[2] - rect[0]) * uvs[k][0], rect[1] + (rect[3] - rect[1]) * uvs[k][1]);
      const l = shades[k];
      if (tintKind) {
        tintAtCorner(Math.max(0, Math.min(CS, Math.round(q[0]))), Math.max(0, Math.min(CS, Math.round(q[2]))), tintKind, tc);
        T.col.push(l * tc[0], l * tc[1], l * tc[2]);
      } else T.col.push(l, l, l);
      T.sky.push(sky < 0 ? skv[k] : sky);   // sky < 0: per-vertex (smooth) values in skv
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
      const rect = bx[6] ? (typeof bx[6] === "string" ? tileRect(bx[6]) : bx[6]) : faceUV[b * 6 + f];
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
      quad(BL[b].translucent ? L : S, rect, cs4, uvs, sh4, sky, faceTint[b * 6 + f] === 4 ? 1 : faceTint[b * 6 + f], false); // stained panes: blended pass
    }
  }

  for (let si = 0; si < J.hi - J.lo; si++) {
  const sec = J.secs[si];
  if (sec === 0) continue;                                   // all-air section
  const uni = typeof sec === "number", sy0 = (J.lo + si) * 16;
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
      const rect = faceUV[b * 6 + 2];
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
      const boxes = ext ? ext[((y - J.y0) << 8) | (z << 4) | x] : undefined;   // a model drawn from world state (signs): boxes from the main thread
      const make = boxes ? null : MODELS[BL[b].model];
      if (!boxes && !make) continue;
      for (const bx of boxes || make(get, x, y, z, b, ox + x, oz + z)) emitBox(b, x, y, z, bx);
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
      const rect = faceUV[b * 6 + f];
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
      const fs = sky;
      const lowTop = (b === B_PATH || b === B_FARM || b === B_FARM_DRY) && !SOLID[get(x, y + 1, z)];
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
        // smooth sky light the same way (cells that stop sky light, like slabs, are left out)
        let ss = fs, sn = 1;
        if (!o1 && SATT[get(p1[0], p1[1], p1[2])] !== 255) { ss += SKB[sgetN(p1[0], p1[1], p1[2])]; sn++; }
        if (!o2 && SATT[get(p2[0], p2[1], p2[2])] !== 255) { ss += SKB[sgetN(p2[0], p2[1], p2[2])]; sn++; }
        if (!o3 && !(o1 && o2) && SATT[get(p3[0], p3[1], p3[2])] !== 255) { ss += SKB[sgetN(p3[0], p3[1], p3[2])]; sn++; }
        skv[k] = ss / sn;
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
        quad(S, TB.dirtUV, cs4, uvs, sh4, -1, 0, flip);
        const e = 0.002;
        for (let k = 0; k < 4; k++) { cs4[k][0] += F.n[0] * e; cs4[k][1] += F.n[1] * e; cs4[k][2] += F.n[2] * e; }
        quad(S, TB.overlayUV, cs4, uvs, sh4, -1, 1, flip);
      } else {
        quad(BL[b].translucent ? L : S, rect, cs4, uvs, sh4, -1, tk, flip); // stained glass: blended pass
      }
    }
  }
  }


  const out = T => {
    if (!T.ind.length) return null;
    let max = 0;
    for (let i = 0; i < T.ind.length; i++) if (T.ind[i] > max) max = T.ind[i];
    return {
      pos: new Float32Array(T.pos), uv: new Float32Array(T.uv), col: new Float32Array(T.col), sky: new Float32Array(T.sky), bl: new Float32Array(T.bl),
      sphere: J.sph ? spherePositions(T.pos, J.sph) : null,
      ind: max > 65535 ? new Uint32Array(T.ind) : new Uint16Array(T.ind),   // (as three.js's setIndex picks)
    };
  };
  const r = { S: out(S), L: out(L) };
  return r;
}

// ---- the round drawing (planet only) ----
// Each chunk-local vertex (x, y, z) at its place on the sphere, relative to the anchor: the corner directions blended across its block
// (quads can sit at fractions of a block), at radius R + (y - sea). sph = { dirs (17 x 17 unit directions at the chunk's block corners),
// anchor, R, sea } (js/world.js sphereFrame).
function spherePositions(pos, sph) {
  const out = new Float32Array(pos.length), D = sph.dirs, A = sph.anchor, R = sph.R, sea = sph.sea;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2];
    const ix = Math.max(0, Math.min(CS - 1, Math.floor(x))), iz = Math.max(0, Math.min(CS - 1, Math.floor(z))), fx = x - ix, fz = z - iz;
    const a = (iz * 17 + ix) * 3, b = a + 3, c = a + 51, e = c + 3;
    let dx = 0, dy = 0, dz = 0;
    for (let k = 0; k < 3; k++) {
      const v = (D[a + k] * (1 - fx) + D[b + k] * fx) * (1 - fz) + (D[c + k] * (1 - fx) + D[e + k] * fx) * fz;
      if (k === 0) dx = v; else if (k === 1) dy = v; else dz = v;
    }
    const r = (R + pos[i + 1] - sea) / Math.hypot(dx, dy, dz);
    out[i] = dx * r - A[0]; out[i + 1] = dy * r - A[1]; out[i + 2] = dz * r - A[2];
  }
  return out;
}

// The arrays a result holds (to transfer them from a worker).
function buffers(r) {
  const a = [];
  for (const T of [r.S, r.L]) if (T) for (const k in T) if (T[k]) a.push(T[k].buffer);
  return a;
}

BF.mesher = {
  build, buffers, FACES, MODELS, BUILTIN, RING, RN,
  // pane arms for collision (BF.DYNBOXES, js/world.js), with the page's tables
  paneBoxes(tables, get, x, y, z) { TB = tables; return paneBoxes(get, x, y, z); },
};
})();
