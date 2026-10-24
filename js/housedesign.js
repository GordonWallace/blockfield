// House designer (experimental, branch exp-llm-villager): turns a house the Sage drew (JSON from /claude/blueprint, debug/claude.js)
// into a builder blueprint, and draws it.
// - A design is the model's drawing: { name, summary, notes, width, depth, legend: [{symbol, block}], layers: [{label, rows}] }, layers
//   bottom up (0 = the floor), rows north to south, characters west to east, "." air. The blocks it may use are PALETTE (names the model
//   sees, sent with the request); each resolves to a block id here.
// - toBlueprint(design) works out what the drawing leaves implicit: which way doors, beds, ladders, wall torches, furnaces and chests
//   face (from the walls and the outside air around them), the upper door half and the bed head, and a build phase per cell. The cells go
//   through BF.blueprints.custom, the same assembly as the builders' own designs, so the result has their blueprint shape (cells in
//   build order with item / cost / pair, req, door, beds): a builder can take it later as it takes a small house.
// - materials(bp): the items it takes, most first. Preview: a small three.js view of a blueprint with a layer cut-away.
// API: BF.houseDesign = { palette(), toBlueprint(design) -> { bp, materials, warnings } | { error }, materials(bp), Preview }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];           // facing 0 north (-z), 1 east, 2 south, 3 west (js/blocks.js)
const DIR_NAMES = ["north", "east", "south", "west"];
const SHAPES = [["oak", "oak planks"], ["spruce", "spruce planks"], ["birch", "birch planks"], ["dark_oak", "dark oak planks"],
  ["cobblestone", "cobblestone"], ["stone_brick", "stone bricks"], ["brick", "bricks"], ["sandstone", "sandstone"]];
// [name the model uses, what it is, block name if different]
const BASIC = [
  ["stone", "smooth grey stone"], ["cobblestone", "rough cobblestone"], ["mossy_cobblestone", "cobblestone with moss"], ["stone_bricks", "stone bricks"],
  ["smooth_stone", "smooth stone"], ["bricks", "red clay bricks"], ["sandstone", "sandstone"], ["cut_sandstone", "cut sandstone"], ["mud_bricks", "mud bricks"],
  ["deepslate_bricks", "dark deepslate bricks"], ["terracotta", "terracotta"], ["white_wool", "white wool"],
  ["oak_planks", "oak planks", "planks"], ["spruce_planks", "spruce planks"], ["birch_planks", "birch planks"], ["dark_oak_planks", "dark oak planks"],
  ["acacia_planks", "acacia planks"], ["jungle_planks", "jungle planks"], ["cherry_planks", "cherry planks"],
  ["oak_log", "oak log (posts, beams)"], ["spruce_log", "spruce log"], ["birch_log", "birch log"], ["dark_oak_log", "dark oak log"],
  ["glass", "glass block (window)"], ["glass_pane", "thin glass pane (window)"], ["oak_fence", "oak fence (railings)"], ["spruce_fence", "spruce fence"],
  ["oak_door", "oak door (two tall: draw only the lower half)"], ["spruce_door", "spruce door"], ["dark_oak_door", "dark oak door"],
  ["red_bed", "bed (draw both of its two cells)"], ["torch", "torch (on a floor or against a wall)"], ["lantern", "lantern (on a floor)"],
  ["furnace", "furnace"], ["chest", "chest"], ["crafting_table", "crafting table"], ["barrel", "barrel"], ["bookshelf", "bookshelf"],
  ["ladder", "ladder (against a wall)"], ["hay_bale", "hay bale"],
];
const FURNITURE = new Set(["torch", "lantern", "furnace", "chest", "crafting_table", "barrel", "bookshelf", "ladder"]);

let PAL = null;                                             // name -> { name, about, resolve }
function build() {
  if (PAL) return PAL;
  const B = BF.B || {};
  PAL = new Map();
  const add = (name, about, kind, id) => { if (kind !== "block" || id != null) PAL.set(name, { name, about, kind, id }); };
  for (const [name, about, blk] of BASIC) {
    const door = /^(.+)_door$/.exec(name);
    if (door) { if (BF.doorId && BF.doorId(0, 0, 0, door[1]) != null) add(name, about, "door"); continue; }
    if (name === "red_bed") { if (BF.bedId && BF.bedId(0, 0) != null) add(name, about, "bed"); continue; }
    if (name === "torch" || name === "ladder" || name === "furnace" || name === "chest") { if (B[name] != null || B[name + "_n"] != null) add(name, about, name); continue; }
    add(name, about, "block", B[blk || name]);
  }
  for (const [pre, mat] of SHAPES) {
    add(pre + "_slab", "half block of " + mat + ", lower half", "block", B[pre + "_slab"]);
    add(pre + "_slab_top", "half block of " + mat + ", upper half", "block", B[pre + "_slab_top"]);
    DIR_NAMES.forEach((dn, f) => add(pre + "_stairs_up_" + dn, mat + " stairs rising toward the " + dn, "block", B[pre + "_stairs" + (f === 2 ? "" : "_bottom_" + "nesw"[f])]));
  }
  return PAL;
}
const palette = () => [...build().values()].map(p => ({ name: p.name, about: p.about }));

// ---------------------------------------------------------------- design -> blueprint
function toBlueprint(design) {
  const P = build(), PH = BF.blueprints.PH, B = BF.B;
  const W = design && design.width | 0, D = design && design.depth | 0, layers = (design && design.layers) || [];
  if (!(W > 0 && D > 0 && layers.length)) return { error: "empty design" };
  const legend = new Map();
  for (const e of design.legend || []) if (e && P.has(e.block)) legend.set(e.symbol, P.get(e.block));
  const warnings = [];
  // g[y][z][x] = palette entry or null (air); unknown symbols count as air
  const g = layers.map(L => Array.from({ length: D }, (_, z) => { const cs = [...String((L.rows || [])[z] || "")]; return Array.from({ length: W }, (_, x) => legend.get(cs[x]) || null); }));
  const H = g.length, at = (x, y, z) => (x >= 0 && z >= 0 && x < W && z < D && y >= 0 && y < H ? g[y][z][x] : null);
  const solid = (x, y, z) => { const e = at(x, y, z); return !!e && e.kind === "block" && !/glass_pane|fence|slab|stairs/.test(e.name); };
  // outside air on each layer: flood fill from beyond the footprint through air
  const outside = g.map((L, y) => {
    const o = new Set(), q = [], key = (x, z) => x + "," + z;
    for (let x = -1; x <= W; x++) for (const z of [-1, D]) q.push([x, z]);
    for (let z = 0; z < D; z++) for (const x of [-1, W]) q.push([x, z]);
    while (q.length) {
      const [x, z] = q.pop(), k = key(x, z);
      if (o.has(k) || x < -1 || z < -1 || x > W || z > D) continue;
      if (x >= 0 && z >= 0 && x < W && z < D && at(x, y, z)) continue;
      o.add(k);
      for (const [dx, dz] of DIRS) q.push([x + dx, z + dz]);
    }
    return o;
  });
  const isOut = (x, y, z) => (x < 0 || z < 0 || x >= W || z >= D) || outside[y].has(x + "," + z);
  const inAir = (x, y, z) => x >= 0 && z >= 0 && x < W && z < D && !at(x, y, z) && !outside[y].has(x + "," + z);
  // the top layer that still has (most of) its outer wall: above it is roof
  let wallTop = 1;
  for (let y = 1; y < H; y++) {
    let n = 0, f = 0;
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) if (x === 0 || z === 0 || x === W - 1 || z === D - 1) { n++; if (at(x, y, z)) f++; }
    if (f >= n * 0.6) wallTop = y;
  }
  const cells = new Map(), put = (x, y, z, id, ph) => { if (id != null) cells.set(x + "," + y + "," + z, [x, y, z, id, ph]); };
  const bedDone = new Set();
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const e = at(x, y, z);
    if (!e) continue;
    if (e.kind === "door") {
      let f = DIRS.findIndex(([dx, dz]) => isOut(x + dx, y, z + dz));
      if (f < 0) { f = [z, W - 1 - x, D - 1 - z, x].indexOf(Math.min(z, W - 1 - x, D - 1 - z, x)); warnings.push("a door doesn't open to the outside"); }
      const wood = e.name.replace(/_door$/, "");
      put(x, y, z, BF.doorId(f, 0, 0, wood), PH.DOOR);
      put(x, y + 1, z, BF.doorId(f, 1, 0, wood), PH.DOOR);
    } else if (e.kind === "bed") {
      if (bedDone.has(x + "," + z + "," + y)) continue;
      const mates = DIRS.map((d, f) => [f, x + d[0], z + d[1]]).filter(([, a, b]) => { const m = at(a, y, b); return m && m.kind === "bed" && !bedDone.has(a + "," + b + "," + y); });
      if (!mates.length) { warnings.push("half a bed was left out"); continue; }
      // the head goes against a wall when one end is; the foot -> head direction is the bed's facing
      let foot = [x, z], head = [mates[0][1], mates[0][2]], f = mates[0][0];
      for (const [mf, a, b] of mates) {
        if (solid(a + DIRS[mf][0], y, b + DIRS[mf][1])) { foot = [x, z]; head = [a, b]; f = mf; break; }
        if (solid(x - DIRS[mf][0], y, z - DIRS[mf][1])) { foot = [a, b]; head = [x, z]; f = (mf + 2) & 3; break; }
      }
      const [fx, fz] = foot, [hx, hz] = head;
      put(fx, y, fz, BF.bedId(f, 0), PH.BED);
      put(hx, y, hz, BF.bedId(f, 1), PH.BED);
      bedDone.add(fx + "," + fz + "," + y); bedDone.add(hx + "," + hz + "," + y);
    } else if (e.kind === "ladder") {
      // a ladder hangs on a wall and faces away from it
      const k = DIRS.findIndex(([dx, dz]) => solid(x + dx, y, z + dz));
      if (k < 0) warnings.push("a ladder has no wall to hang on");
      put(x, y, z, BF.ladderId(k < 0 ? 0 : (k + 2) & 3), PH.LIGHT);
    } else if (e.kind === "torch") {
      const below = at(x, y - 1, z);
      if (below && below.kind === "block") { put(x, y, z, B.torch, PH.LIGHT); continue; }
      const k = DIRS.findIndex(([dx, dz]) => solid(x + dx, y, z + dz));
      put(x, y, z, k < 0 ? B.torch : B["wall_torch_" + DIR_NAMES[(k + 2) & 3]], PH.LIGHT);
    } else if (e.kind === "furnace" || e.kind === "chest") {
      // its front faces the room: an inside air cell, else any air, else south
      let f = DIRS.findIndex(([dx, dz]) => inAir(x + dx, y, z + dz));
      if (f < 0) f = DIRS.findIndex(([dx, dz]) => !at(x + dx, y, z + dz));
      put(x, y, z, (e.kind === "furnace" ? BF.furnaceId : BF.chestId)(f < 0 ? 2 : f), PH.LIGHT);
    } else {
      const ph = y === 0 ? PH.FLOOR : FURNITURE.has(e.name) ? PH.LIGHT : /glass/.test(e.name) ? PH.GLASS : /slab|stairs/.test(e.name) || y > wallTop ? PH.ROOF : PH.WALL;
      put(x, y, z, e.id, ph);
    }
  }
  // one wood per structure where the builders care (js/blueprints.js): the species with the most cells
  const woods = new Map();
  for (const c of cells.values()) { const w = BF.blueprints.woodOf(c[3]); if (w) woods.set(w[0], (woods.get(w[0]) || 0) + 1); }
  const wood = [...woods].sort((a, b) => b[1] - a[1])[0];
  const bp = BF.blueprints.custom({ cells: [...cells.values()], label: String(design.name || "custom house").slice(0, 60), house: true, wood: wood ? wood[0] : null });
  if (!bp) return { error: "the design has no blocks" };
  bp.design = design;
  if (!bp.door) warnings.push("no door");
  return { bp, materials: materials(bp), warnings: [...new Set(warnings)] };
}
function materials(bp) {
  return Object.keys(bp.req).map(k => ({ id: +k, name: BF.itemName(+k), count: bp.req[k] })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

// ---------------------------------------------------------------- preview
// Each cell is drawn as the boxes of its shape (16ths of a block), textured from the game's atlas.
const FACES = [   // as js/world.js: top, bottom, +x, -x, +z, -z
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.0 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.55 },
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.8 },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.8 },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.68 },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.68 },
];
const rotB = (b, f) => { let [x0, y0, z0, x1, y1, z1] = b; for (let i = 0; i < (f & 3); i++) [x0, z0, x1, z1] = [16 - z1, x0, 16 - z0, x1]; return [x0, y0, z0, x1, y1, z1]; };
function boxesOf(id) {
  const b = BF.blocks[id] || {};
  if (Array.isArray(b.boxes) && b.boxes.length) return b.boxes;
  if (b.door) return [rotB([0, 0, 13, 16, 16, 16], b.door.f + 2)];
  if (b.bed) return [[0, 0, 0, 16, 9, 16]];
  if (b.ladder) return [rotB([0, 0, 15, 16, 16, 16], b.ladder.f + 2)];
  if (b.wallTorch) return [rotB([7, 3, 13, 9, 13, 15], b.wallTorch.f + 2)];
  const n = b.name || "";
  if (n === "torch") return [[7, 0, 7, 9, 10, 9]];
  if (n === "lantern") return [[5, 0, 5, 11, 9, 11]];
  if (/fence/.test(n)) return [[6, 0, 6, 10, 16, 10]];
  if (n === "glass_pane" || n === "iron_bars") return [[0, 0, 7, 16, 16, 9], [7, 0, 0, 9, 16, 16]];
  if (/^chest/.test(n)) return [[1, 0, 1, 15, 14, 15]];
  return null;   // a full cube
}
class Preview {
  constructor(canvas) {
    this.canvas = canvas; this.bp = null; this.upTo = Infinity; this.yaw = 0.8; this.pitch = 0.6; this.zoom = 1;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
    this.mat = new THREE.MeshBasicMaterial({ map: BF.textures.build().texture, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide });
    this.mesh = null;
    let drag = null;
    canvas.addEventListener("pointerdown", e => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); e.stopPropagation(); });
    canvas.addEventListener("pointermove", e => {
      if (!drag) return;
      this.yaw -= (e.clientX - drag[0]) * 0.01; this.pitch = Math.max(-0.2, Math.min(1.45, this.pitch + (e.clientY - drag[1]) * 0.01));
      drag = [e.clientX, e.clientY]; this.draw();
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
    canvas.addEventListener("wheel", e => { e.preventDefault(); e.stopPropagation(); this.zoom = Math.max(0.4, Math.min(3, this.zoom * (e.deltaY > 0 ? 1.1 : 0.9))); this.draw(); }, { passive: false });
  }
  show(bp, upTo) { this.bp = bp; this.upTo = upTo == null ? Infinity : upTo; this.rebuild(); this.draw(); }
  cut(upTo) { this.upTo = upTo; this.rebuild(); this.draw(); }
  rebuild() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    const bp = this.bp;
    if (!bp) return;
    const UV = BF.world._faceUV || [], full = new Set(), pos = [], uv = [], col = [], idx = [];
    const vis = bp.cells.filter(c => c.y < this.upTo);
    for (const c of vis) { const b = BF.blocks[c.id]; if (!boxesOf(c.id) && b && b.opaque !== false) full.add(c.x + "," + c.y + "," + c.z); }
    const ox = bp.w / 2, oz = bp.d / 2;
    for (const c of vis) {
      const boxes = boxesOf(c.id) || [[0, 0, 0, 16, 16, 16]], cube = !boxesOf(c.id);
      for (const bx of boxes) {
        const lo = [bx[0] / 16, bx[1] / 16, bx[2] / 16], hi = [bx[3] / 16, bx[4] / 16, bx[5] / 16];
        FACES.forEach((F, f) => {
          if (cube && full.has((c.x + F.n[0]) + "," + (c.y + F.n[1]) + "," + (c.z + F.n[2]))) return;
          const r = UV[c.id * 6 + f] || [0, 0, 1, 1], base = pos.length / 3;
          const uvs = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
          F.c.forEach((k, i) => {
            pos.push(c.x - ox + (k[0] ? hi[0] : lo[0]), c.y + (k[1] ? hi[1] : lo[1]), c.z - oz + (k[2] ? hi[2] : lo[2]));
            uv.push(uvs[i][0], uvs[i][1]); col.push(F.shade, F.shade, F.shade);
          });
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        });
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.scene.add(this.mesh);
  }
  draw() {
    const cv = this.canvas, w = cv.clientWidth || 300, h = cv.clientHeight || 200;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const bp = this.bp, size = bp ? Math.max(bp.w, bp.d, bp.hgt) : 8, r = size * 2.1 * this.zoom, cy = bp ? bp.hgt * 0.4 : 2;
    this.camera.position.set(Math.cos(this.yaw) * Math.cos(this.pitch) * r, cy + Math.sin(this.pitch) * r, Math.sin(this.yaw) * Math.cos(this.pitch) * r);
    this.camera.lookAt(0, cy, 0);
    this.renderer.render(this.scene, this.camera);
  }
  dispose() { if (this.mesh) this.mesh.geometry.dispose(); this.mat.dispose(); this.renderer.dispose(); }
}

BF.houseDesign = { palette, toBlueprint, materials, Preview, boxesOf };
})();
