// Blockfield 1.6, the realistic look: js/real/assets-biomes.js. Owner: the Biome assets thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
// Fills the registry BF.real.assets (docs/REALISTIC_CONTRACT.md section 5) for every biome but the foundation's Forest and Taiga
// examples: which real species stands in for which Blockfield tree, plant and rock in which biome, one consistent real-world plant
// community per biome (the table is BIOMES below, also exported as BF.real.assets.biomes for labels and the wiki).
// The models and textures themselves are js/real/assets-trees.js, assets-cover.js and assets-ground.js, built with js/real/assets-kit.js.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || !BF.real.akit) return;
const K = BF.real.akit, T = globalThis.THREE, A = BF.real.assets;

// One real place per biome. rocks: ids of js/real/assets-cover.js; ground: the typical ground colour (labels, the viewer). trees: [species id, log block, options]; options: logs [min, max] (the log-column heights it suits),
// weight, leafless, opts(rand) -> extra build options.
const BIOMES = {
  "Plains":          { place: "North American tallgrass prairie (Flint Hills, Kansas)", trees: [["bur_oak", "oak_log"]], rocks: ["prairie_limestone"], ground: "#5a6a2e" },
  "Flower Forest":   { place: "Appalachian cove forest in spring (Great Smoky Mountains)", trees: [["flowering_dogwood", "oak_log"], ["eastern_redbud", "birch_log"]], rocks: ["glacial_erratic"], ground: "#3f5226" },
  "Birch Forest":    { place: "Northern hardwood forest (Great Lakes, Quebec)", trees: [["paper_birch", "birch_log"], ["english_oak", "oak_log"]], rocks: ["glacial_erratic"], ground: "#4a5a2c" },
  "Dark Forest":     { place: "Old beech and oak wood (Central European lowland)", trees: [["european_beech", "dark_oak_log"], ["english_oak", "oak_log"], ["giant_fly_agaric", "mushroom_stem", { leafless: true }]], rocks: ["mossy_sandstone"], ground: "#3a3a22" },
  "Swamp":           { place: "Bald cypress swamp (Atchafalaya basin, Louisiana)", trees: [["bald_cypress", "oak_log"]], rocks: ["cypress_knee"], ground: "#3a3c26" },
  "Mangrove Swamp":  { place: "Red mangrove shore (Everglades, Caribbean)", trees: [["red_mangrove", "mangrove_log"]], rocks: [], ground: "#4a4436" },
  "Desert":          { place: "Sonoran Desert (Arizona uplands)", trees: [["saguaro", "cactus", { leafless: true }]], rocks: ["desert_granite"], ground: "#c8a878" },
  "Badlands":        { place: "Colorado Plateau canyon country (Utah)", trees: [["tree_cholla", "cactus", { leafless: true }]], rocks: ["red_sandstone"], ground: "#b0603a" },
  "Savanna":         { place: "East African savanna (Serengeti)", trees: [["umbrella_thorn", "acacia_log"]], rocks: ["kopje_granite", "termite_mound"], ground: "#a08a4a" },
  "Jungle":          { place: "Amazon lowland rainforest", trees: [["kapok", "jungle_log", { logs: [16, 99] }], ["cecropia", "jungle_log", { logs: [6, 15] }], ["acai_palm", "jungle_log", { logs: [0, 5] }]], rocks: ["jungle_laterite"], ground: "#3a3220" },
  "Sparse Jungle":   { place: "Amazon forest edge and regrowth", trees: [["cecropia", "jungle_log", { logs: [6, 99] }], ["acai_palm", "jungle_log", { logs: [0, 5] }], ["cecropia", "oak_log"]], rocks: ["jungle_laterite"], ground: "#4a4a26" },
  "Snowy Plains":    { place: "Subarctic tundra edge (Hudson Bay lowlands)", trees: [["black_spruce", "spruce_log"]], rocks: ["frost_gneiss"], ground: "#e8ecf0" },
  "Ice Spikes":      { place: "Subarctic tundra edge (Hudson Bay lowlands)", trees: [["black_spruce", "spruce_log"]], rocks: ["frost_gneiss"], ground: "#e8ecf0" },
  "Meadow":          { place: "Rocky Mountain subalpine meadow (Colorado)", trees: [["quaking_aspen", "birch_log"]], rocks: ["alpine_granite"], ground: "#5a7a34" },
  "Cherry Grove":    { place: "Japanese hill cherry grove in spring (Yoshino)", trees: [["yoshino_cherry", "cherry_log"]], rocks: ["garden_andesite"], ground: "#4f6a30" },
  "Windswept Hills": { place: "Scottish Highlands (Caledonian pinewood edge)", trees: [["scots_pine", "spruce_log"]], rocks: ["highland_gneiss"], ground: "#6a6a3a" },
  "Mushroom Fields": { place: "Not a real place: giant fly agarics and parasols", trees: [["giant_fly_agaric", "mushroom_stem", { leafless: true }]], rocks: ["garden_andesite"], ground: "#6a5a6a" },
  // biomes with no trees or plant blocks of their own: rocks only
  "Beach":           { place: "A temperate sand beach", trees: [], rocks: ["shore_cobble"], ground: "#d8cc9c" },
  "Snowy Beach":     { place: "A subarctic shore", trees: [], rocks: ["shore_cobble", "frost_gneiss"], ground: "#e0e4e8" },
  "Stony Shore":     { place: "A basalt cobble shore", trees: [], rocks: ["shore_cobble"], ground: "#6a6a6c" },
  "River":           { place: "A gravel-bedded river", trees: [], rocks: ["shore_cobble"], ground: "#8a8474" },
  "Snowy Slopes":    { place: "Alpine snowfield (Colorado Front Range)", trees: [], rocks: ["frost_gneiss"], ground: "#e8ecf0" },
  "Jagged Peaks":    { place: "Alpine summit (Colorado Front Range)", trees: [], rocks: ["alpine_granite", "frost_gneiss"], ground: "#8a8a8c" },
  "Stony Peaks":     { place: "Alpine talus (Colorado Front Range)", trees: [], rocks: ["alpine_granite"], ground: "#8a8680" },
};

// ---------- trees ----------
const EMPTY = new T.BufferGeometry();
EMPTY.setAttribute("position", new T.Float32BufferAttribute([], 3)); EMPTY.setAttribute("normal", new T.Float32BufferAttribute([], 3));
EMPTY.setAttribute("uv", new T.Float32BufferAttribute([], 2)); EMPTY.setAttribute("color", new T.Float32BufferAttribute([], 3));
EMPTY.setAttribute("aWind", new T.Float32BufferAttribute([], 2));
let noFoliage = null;
const rng = rand => (typeof rand === "function" ? rand : K.mulberry(((rand || 0) * 1e6) | 0 || 1));
const byKey = {};
function tree(id, log, biome, o) {
  const sp = K.trees[id]; o = o || {};
  if (!sp) return;
  const key = id + "|" + log + "|" + (o.logs || "") + "|" + (o.brown ? 1 : 0);
  if (byKey[key]) { byKey[key].biomes.push(biome); return; }       // one entry per species and log, listing every biome it stands in
  A.species.push(byKey[key] = {
    id: id + (o.brown ? "_brown" : ""), kind: "tree", name: sp.name, latin: sp.latin, note: sp.note, log, biomes: [biome], weight: o.weight || 1, variants: o.variants || 4,
    logs: o.logs, leafless: !!o.leafless, height: sp.h,
    build(rand, detail) {
      const r = rng(rand), h = sp.h[0] + (sp.h[1] - sp.h[0]) * r();
      K.low = detail >= 2;
      let g;
      try { g = sp.build(r, h, detail ? 0 : 1, o.brown ? { brown: true } : undefined); } finally { K.low = false; }
      return { bark: g.b, foliage: g.f || EMPTY };
    },
    barkMaterial: () => sp.mats().bark,
    foliageMaterial: () => sp.mats().foliage || noFoliage || (noFoliage = new T.MeshBasicMaterial({ visible: false })),
    depthMaterial: () => sp.mats().depth,
  });
}
for (const b in BIOMES) for (const t of BIOMES[b].trees) tree(t[0], t[1], b, t[2]);
tree("giant_fly_agaric", "mushroom_stem", "Mushroom Fields", { leafless: true, brown: true });
tree("giant_fly_agaric", "mushroom_stem", "Dark Forest", { leafless: true, brown: true });

// ---------- ground cover: every plant of a biome's set, drawn from that biome's one atlas ----------
const seen = new Map();
for (const b of Object.keys(K.cover)) {
  const set = K.cover[b];
  if (seen.has(set)) { for (const e of seen.get(set)) e.biomes.push(b); continue; }
  const list = [];
  for (const p of set.plants) {
    const e = { id: p.id, kind: "cover", name: p.name, latin: p.latin, block: p.block, biomes: b === "*" ? undefined : [b], density: p.density, scatter: p.scatter || 0,
      build: (rand, detail) => p.build(rng(rand), detail), material: () => set.mats().foliage, depthMaterial: () => set.mats().depth };
    A.cover.push(e); if (e.biomes) list.push(e);
  }
  seen.set(set, list);
}
// ---------- rocks ----------
const rocks = {};
for (const b in BIOMES) for (const id of BIOMES[b].rocks || []) {
  const r = K.rocks[id];
  if (!r) continue;
  if (rocks[id]) { rocks[id].biomes.push(b); continue; }
  A.rocks.push(rocks[id] = { id, kind: "rock", name: r.name, biomes: [b], size: r.size, build: (rand, detail) => r.build(rng(rand), detail), material: () => r.material() });
}

A.biomes = BIOMES;
A.groundFor = b => (BIOMES[b] ? BIOMES[b].ground : null);
})();
