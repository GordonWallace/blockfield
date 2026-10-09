// Blueprints for builder villagers: data-driven block lists computed deterministically from (type, rotation, village style, variant).
// Houses reuse the village generators of worldgen.js through BF.worldgen.recordBuilding (a recording buffer instead of the world);
// the well, lamp posts, garden and market stall are small hand-made designs that use the same village palette.
// See CONTRACT.md "Builder villagers". Loaded after mobs.js; only calls other modules at runtime.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PH = { FLOOR: 1, WALL: 2, ROOF: 3, GLASS: 4, DOOR: 5, BED: 6, LIGHT: 7 };   // build order: floor, walls, roof, windows, door, beds, torches/furniture
const WALL_TOP = { house: 3, lhouse: 3, smith: 3 };                                // top wall level (y) of the generator types we reuse
const cache = new Map();

const pal = style => BF.worldgen.palette(style);
const nameOf = id => (BF.items[id] ? BF.items[id].name : "?");

// ---- block / item helpers ----
const rot90 = (x, z, k) => { for (let i = 0; i < (k & 3); i++) { const t = x; x = -z; z = t; } return [x, z]; };   // clockwise: north -> east
function rotId(id, k) {
  k &= 3;
  if (!k) return id;
  const b = BF.blocks[id];
  if (!b) return id;
  if (b.door) return BF.doorId((b.door.f + k) & 3, b.door.upper, b.door.open, b.door.wood);
  if (b.bed) return BF.bedId((b.bed.f + k) & 3, b.bed.head);
  if (b.wallTorch) return BF.B["wall_torch_" + ["north", "east", "south", "west"][(b.wallTorch.f + k) & 3]];
  if (b.ladder) return BF.ladderId((b.ladder.f + k) & 3);
  if (b.gate) return BF.gateId(k & 1 ? (b.gate.axis === "x" ? "z" : "x") : b.gate.axis, b.gate.open, b.gate.wood);   // a quarter turn swaps the axis the gate spans
  if (b.furnaceFacing != null) return BF.furnaceId(b.furnaceFacing + k);
  if (b.chestFacing != null) return BF.chestId(b.chestFacing + k);
  return id;
}
// The inventory item that places a block (doors, beds and wall torches are items of their own), or null for free blocks.
function itemOf(id) {
  const b = BF.blocks[id];
  if (!b || id === 0) return null;
  if (id === BF.B.water) return null;                          // water has no item of its own: the builder pours it from a full water bucket (builder.js)
  return b.item != null ? b.item : id;
}
// ---- wood: every structure is built from ONE wood species. A blueprint is drawn with the village palette (which mixes woods, e.g. oak walls
// under a spruce roof) and then every planks / log / fence cell is turned into the chosen species. Doors stay oak (the only door there is);
// crafting tables and chests are made from any planks.
const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"];
const WOOD_PARTS = ["planks", "log", "fence"];
const woodName = (sp, part) => (sp === "oak" && part === "planks" ? "planks" : sp + "_" + part);
let WOOD_OF = null;                                             // block id -> [species, part]
function woodTable() {
  if (WOOD_OF) return WOOD_OF;
  WOOD_OF = new Map();
  for (const sp of WOODS) for (const part of WOOD_PARTS) { const id = BF.B[woodName(sp, part)]; if (id != null) WOOD_OF.set(id, [sp, part]); }
  return WOOD_OF;
}
// [species, part] of a planks / log / fence block or item, else null.
const woodOf = id => woodTable().get(id) || null;
// The same part in another species: woodSwap(B.oak_log, "spruce") = B.spruce_log. Anything else comes back unchanged.
function woodSwap(id, sp) {
  const g = BF.blocks[id] && BF.blocks[id].gate;
  if (g && sp && g.wood !== sp) { const nid = BF.gateId(g.axis, g.open, sp); return nid != null ? nid : id; }   // fence gates (the stable's paddock) follow the wood too
  const w = woodOf(id);
  if (!w || !sp || w[0] === sp) return id;
  const nid = BF.B[woodName(sp, w[1])];
  return nid != null ? nid : id;
}
const woodItem = (sp, part) => (BF.I[woodName(sp, part)] != null ? BF.I[woodName(sp, part)] : null);
// The species a village style is drawn in (its walls / corner logs): plains oak, snowy spruce, savanna acacia, taiga spruce; desert oak.
function styleWood(style) {
  const S = pal(style);
  for (const id of [S.corner, S.wall, S.log, S.roof]) { const w = woodOf(id); if (w) return w[0]; }
  return "oak";
}
// Species a builder can use: planks, logs and fences all exist.
const woodsAvailable = () => WOODS.filter(sp => WOOD_PARTS.every(p => BF.B[woodName(sp, p)] != null));

// ---- specs: cells [u, y, q, blockId, phase?] in a local frame (u -> +x, q -> +z, y 0 = floor level, front/door side at q = 0 facing north) ----
function genSpec(kind, w, d, style, h, bedKind) {
  const B = BF.B, S = pal(style), cells = [];
  for (const [u, y, q, id0] of BF.worldgen.recordBuilding(kind, w, d, style, h)) {
    let id = id0;
    if (id === B.dirt_path) id = S.found;                       // the path stone in front of the door becomes a doorstep
    if (id === B.lantern) id = B.torch;                         // torches instead of lanterns (lanterns are scarce)
    if (id === B.dirt_path || id === 0) continue;               // generator air (carving) is not built
    cells.push([u, y, q, id]);
  }
  const beds = [];
  if (bedKind) for (const [u, q, a] of BF.worldgen.bedPlan(bedKind, w, d, h)) {
    const f = a === "u" ? 1 : 2, hu = a === "u" ? 1 : 0;       // local: head lies along +x (east, f 1) or +z (south, f 2)
    cells.push([u, 1, q, BF.bedId(f, 0)], [u + hu, 1, q + 1 - hu, BF.bedId(f, 1)]);
    beds.push([u, 1, q, f]);
  }
  // a torch inside and one outside the door, so a finished house is lit
  cells.push([1, 1, 1, B.torch]);
  cells.push([(w >> 1) + 1, 3, -1, B.wall_torch_north]);
  return { cells, beds, w, d, kind, wallTop: WALL_TOP[kind], house: !!bedKind };
}
const SPECS = {
  small_house: { label: "small house", weight: "house", gen: (st, h) => genSpec("house", 5, 5, st, 0.9, "house") },
  medium_house: { label: "medium house", weight: "house", gen: (st, h) => genSpec("house", 7, 5, st, 0.9, "house2") },
  cottage: { label: "cottage", weight: "house", gen: (st, h) => genSpec("lhouse", 7, 7, st, h < 0.5 ? 0.2 : 0.8, "lhouse") },
  workshop: { label: "workshop", weight: "other", gen: (st, h) => genSpec("smith", 7, 6, st, 0.5, null) },
  well: {
    label: "well", weight: "other",
    gen(st) {
      const B = BF.B, S = pal(st), c = [];
      for (let q = 0; q < 3; q++) for (let u = 0; u < 3; u++) {
        c.push([u, 0, q, S.well, PH.FLOOR]);
        c.push([u, 1, q, u === 1 && q === 1 ? B.water : S.well, PH.WALL]);
        c.push([u, 4, q, S.wall, PH.ROOF]);
      }
      for (const [u, q] of [[0, 0], [2, 0], [0, 2], [2, 2]]) c.push([u, 2, q, B.oak_fence, PH.WALL], [u, 3, q, B.oak_fence, PH.WALL]);
      c.push([1, 5, 1, B.torch, PH.LIGHT]);
      return { cells: c, beds: [], w: 3, d: 3 };
    },
  },
  lamp_posts: {
    label: "lamp posts", weight: "other",
    gen(st, h, opts) {
      const B = BF.B, S = pal(st), c = [];
      for (let i = 0; i < 3; i++) {
        const u = i * 4;
        c.push([u, 0, 0, S.found, PH.FLOOR], [u, 1, 0, B.oak_fence, PH.WALL], [u, 2, 0, B.oak_fence, PH.WALL]);
        c.push([u, 3, 0, opts && opts.lantern ? B.lantern : B.torch, PH.LIGHT]);
      }
      return { cells: c, beds: [], w: 9, d: 1 };
    },
  },
  garden: {
    label: "garden pen", weight: "other",
    gen(st, h, opts) {
      const B = BF.B, c = [], w = 7, d = 5;
      for (let q = 0; q < d; q++) for (let u = 0; u < w; u++)
        if ((u === 0 || u === w - 1 || q === 0 || q === d - 1) && !(q === 0 && u === 3)) c.push([u, 0, q, B.oak_fence, PH.WALL]);
      if (opts && opts.hay) c.push([1, 0, 3, B.hay_bale, PH.LIGHT], [2, 0, 3, B.hay_bale, PH.LIGHT]);
      return { cells: c, beds: [], w, d };
    },
  },
  market_stall: {
    label: "market stall", weight: "other",
    gen(st) {
      const B = BF.B, S = pal(st), c = [];
      for (const [u, q] of [[0, 0], [4, 0], [0, 2], [4, 2]]) c.push([u, 0, q, B.oak_fence, PH.WALL], [u, 1, q, B.oak_fence, PH.WALL]);
      for (let q = 0; q < 3; q++) for (let u = 0; u < 5; u++) c.push([u, 2, q, S.wall, PH.ROOF]);
      c.push([1, 0, 2, B.crafting_table, PH.LIGHT], [3, 0, 2, BF.chestId(0), PH.LIGHT], [2, 3, 1, B.torch, PH.LIGHT]);
      if (B.merchant_counter != null) c.push([2, 0, 2, B.merchant_counter, PH.LIGHT]);   // a merchant's jobsite in every stall (js/merchant.js)
      return { cells: c, beds: [], w: 5, d: 3 };
    },
  },
  // Stable (js/stables.js): a small open-sided shelter (5x5: plank floor, four log posts, a closed back wall, plank roof) with the stable
  // hand's tack rack against the back wall, and beside it a fenced paddock (8x7 ring, 6x5 inside) whose front holds a double fence gate
  // (2 wide, so a horse fits through). Only in villages on horse land (builder.js pickType / findSite). `marks` name the paddock's inside
  // corners, the gate cells and the cells in front of them, turned with the building (get).
  stable: {
    label: "stable", weight: "other",
    gen(st, h, opts) {
      const B = BF.B, c = [];
      for (let q = 0; q < 5; q++) for (let u = 0; u < 5; u++) { c.push([u, 0, q, B.planks, PH.FLOOR], [u, 4, q, B.planks, PH.ROOF]); }
      for (const [u, q] of [[0, 0], [4, 0], [0, 4], [4, 4]]) for (let y = 1; y <= 3; y++) c.push([u, y, q, B.oak_log, PH.WALL]);
      for (let u = 1; u <= 3; u++) for (let y = 1; y <= 3; y++) c.push([u, y, 4, B.planks, PH.WALL]);
      c.push([2, 1, 3, B.tack_rack, PH.LIGHT], [2, 3, 3, B.wall_torch_north, PH.LIGHT]);
      if (opts && opts.hay) c.push([1, 1, 3, B.hay_bale, PH.LIGHT], [3, 1, 3, B.hay_bale, PH.LIGHT]);
      const gate = BF.gateId("x", false, "oak");
      for (let q = 0; q < 7; q++) for (let u = 5; u < 13; u++) {
        if (!(u === 5 || u === 12 || q === 0 || q === 6)) continue;
        c.push([u, 0, q, q === 0 && (u === 8 || u === 9) ? gate : B.oak_fence, q === 0 && (u === 8 || u === 9) ? PH.DOOR : PH.WALL]);
      }
      return { cells: c, beds: [], w: 13, d: 7, marks: { paddock: [[6, 1], [11, 5]], gate: [[8, 0], [9, 0]], out: [[8, -1], [9, -1]], rack: [[2, 3]] } };
    },
  },
};
const TYPE_NAMES = Object.keys(SPECS);

function classify(spec, u, y, q, id) {
  const B = BF.B, b = BF.blocks[id];
  if (b.door) return PH.DOOR;
  if (b.bed) return PH.BED;
  if (b.emit || b.wallTorch || id === B.torch || id === B.crafting_table || BF.isChest(id) || BF.isFurnace(id) || id === B.bell) return PH.LIGHT;
  if (id === B.glass || b.model === "pane") return PH.GLASS;
  if (y === 0) return PH.FLOOR;
  if (spec.wallTop != null && (y > spec.wallTop || u < 0 || q < 0 || u >= spec.w || q >= spec.d)) return PH.ROOF;
  return PH.WALL;
}

// ---- assemble: rotate, normalise to the min corner, order for building, compute the material requirement ----
// rot 0..3: the building turns clockwise by rot quarter turns (the door faces north, east, south, west). h in [0,1): variant.
// opts: {lantern, hay}. Result cells: {x, y, z, id, item, cost, ph}: x/z relative to the min corner of the footprint box (eaves and
// doorstep included), y relative to the floor level; cost 1 = one inventory item per block (0 for the upper door half, the bed head, water).
function get(type, rot, style, h, opts, wood) {
  rot = rot & 3; style = style | 0; h = h == null ? 0.5 : h;
  if (!wood || !woodsAvailable().includes(wood)) wood = styleWood(style);
  const ck = [type, rot, style, h, opts && opts.lantern ? 1 : 0, opts && opts.hay ? 1 : 0, wood].join("|");
  let bp = cache.get(ck);
  if (bp) return bp;
  const T = SPECS[type];
  if (!T) return null;
  const spec = T.gen(style, h, opts);
  const raw = [];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxY = 0;
  for (const c of spec.cells) {
    const id = woodSwap(c[3], wood);
    if (!BF.blocks[id] || id === 0) continue;
    const [x, z] = rot90(c[0], c[2], rot);
    const nid = rotId(id, rot);
    const ph = c[4] != null ? c[4] : classify(spec, c[0], c[1], c[2], id);
    raw.push({ x, y: c[1], z, id: nid, ph });
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); maxY = Math.max(maxY, c[1]);
  }
  const cellsAt = new Map();
  for (const c of raw) { c.x -= minX; c.z -= minZ; cellsAt.set(c.x + "," + c.y + "," + c.z, c); }
  const w = maxX - minX + 1, d = maxZ - minZ + 1, cx = w / 2, cz = d / 2;
  const cells = [...cellsAt.values()];
  for (const c of cells) {
    const b = BF.blocks[c.id];
    c.item = itemOf(c.id);
    c.cost = c.item == null || (b.door && b.door.upper) || (b.bed && b.bed.head) ? 0 : 1;
    c.pair = !!((b.door && !b.door.upper) || (b.bed && !b.bed.head));       // lower door half / bed foot: the next cell is its other half
    c.ang = Math.atan2(c.z + 0.5 - cz, c.x + 0.5 - cx);
  }
  cells.sort((a, b) => a.ph - b.ph || a.y - b.y || (a.ph === PH.WALL ? a.ang - b.ang : (a.z - b.z) || ((a.z & 1) ? b.x - a.x : a.x - b.x)));
  // keep door/bed halves adjacent (lower first): sort ties by y already places lower before upper; beds sit on one level
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c.pair) continue;
    const bk = BF.blocks[c.id];
    const want = (bk.door ? BF.doorId(bk.door.f, 1, 0, bk.door.wood) : BF.bedId(bk.bed.f, 1));
    let j = -1;
    for (let k = i + 1; k < cells.length; k++) if (cells[k].id === want) { j = k; break; }
    if (j > i + 1) { const [e] = cells.splice(j, 1); cells.splice(i + 1, 0, e); }
  }
  const req = {}, exact = {}, free = {};
  for (const c of cells) {
    if (c.cost) { req[c.item] = (req[c.item] || 0) + 1; exact[c.item] = (exact[c.item] || 0) + 1; }
    else if (c.item == null) free[c.id] = (free[c.id] || 0) + 1;
  }
  let door = null, beds = [];
  for (const c of cells) {
    const bk = BF.blocks[c.id];
    if (bk.door && !bk.door.upper) door = { x: c.x, y: c.y, z: c.z, f: bk.door.f, outX: c.x + BF.DIRS[bk.door.f][0], outZ: c.z + BF.DIRS[bk.door.f][1] };
    if (bk.bed && !bk.bed.head) beds.push({ x: c.x, y: c.y, z: c.z, f: bk.bed.f });
  }
  // marks: named spots of the design ([u, q] in the local frame, js/stables.js reads the paddock's), in the same rotated, min-corner frame as the cells
  const marks = {};
  for (const k in spec.marks || {}) marks[k] = spec.marks[k].map(([u, q]) => { const [x, z] = rot90(u, q, rot); return [x - minX, z - minZ]; });
  bp = { type, label: T.label, rot, style, h, opts: opts || null, wood, woody: cells.some(c => woodOf(c.id)), w, d, hgt: maxY + 1, cells, n: cells.length, req, exact, free, door, beds, house: !!spec.house && !!door, marks };
  cache.set(ck, bp);
  return bp;
}

BF.blueprints = {
  PH, TYPES: TYPE_NAMES, SPECS, get, itemOf, rotId, nameOf,
  WOODS, woodOf, woodSwap, woodItem, woodName, styleWood, woodsAvailable,
  label: t => (SPECS[t] ? SPECS[t].label : t),
  // human readable material list, e.g. "48 Oak Planks, 12 Oak Log"
  describe(req) { return Object.keys(req).map(k => req[k] + " " + BF.itemName(+k)).join(", "); },
};
})();
