// Block and item registry. Shared by every module; ids are stable.
// Block ids are 0..BF.MAX_BLOCK (4095; 0 = air); voxels are Uint16 so any id up to 4095 fits. Ids 0..255 are the
// original blocks and must never be renumbered (saved worlds store block ids in their edit lists). Non-block items
// use ids >= BF.ITEM_BASE (4096) in declaration order; saves store items by name, so moving the base is safe.
// BF.items is sparse between the last block id and ITEM_BASE: always skip holes when iterating.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// Facing 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x).
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
// Rotates a box [x0,y0,z0,x1,y1,z1(,tile)] in 1/16 units, drawn for facing south, to facing f.
function rotBox(b, f) {
  const r = (x, z) => f === 2 ? [x, z] : f === 0 ? [16 - x, 16 - z] : f === 1 ? [z, 16 - x] : [16 - z, x];
  const [ax, az] = r(b[0], b[2]), [bx, bz] = r(b[3], b[5]);
  return [Math.min(ax, bx), b[1], Math.min(az, bz), Math.max(ax, bx), b[4], Math.max(az, bz), ...b.slice(6)];
}
// Two-block doors (lower/upper half, open/closed, facing = side the closed slab sits on, towards the placer)
// and beds (foot/head, facing = foot -> head). One block id per state.
const doorDefs = [], bedDefs = [];
for (let f = 0; f < 4; f++) for (const upper of [0, 1]) for (const open of [0, 1]) {
  const box = rotBox(open ? [0, 0, 0, 3, 16, 16] : [0, 0, 13, 16, 16, 16], f);
  doorDefs.push({ name: "oak_door_" + (upper ? "upper" : "lower") + (open ? "_open_" : "_") + "nesw"[f], tiles: upper ? "oak_door_top" : "oak_door_bottom",
    render: "model", model: "door", solid: !open, hardness: 3, tool: "axe", drop: "oak_door", item: "oak_door", hidden: true,
    door: { f, upper: !!upper, open: !!open }, boxes: [box], box, color: "#9a7448" });
}
for (let f = 0; f < 4; f++) for (const head of [0, 1]) {
  const legs = head ? [[0, 0, 13, 3, 3, 16], [13, 0, 13, 16, 3, 16]] : [[0, 0, 0, 3, 3, 3], [13, 0, 0, 16, 3, 3]];
  const top = head ? [[0, 3, 0, 16, 9, 10], [0, 3, 10, 16, 8, 16], [0, 8, 10, 16, 9, 16, "bed_pillow"]] : [[0, 3, 0, 16, 9, 16]];
  bedDefs.push({ name: "red_bed_" + (head ? "head_" : "foot_") + "nesw"[f], tiles: { top: "bed_top", side: "bed_side", bottom: "planks" },
    render: "model", model: "bed", hardness: 0.2, drop: "red_bed", item: "red_bed", hidden: true,
    bed: { f, head: !!head }, boxes: [...top, ...legs].map(b => rotBox(b, f)), box: [0, 0, 0, 16, 9, 16], color: "#a82828" });
}

// tiles: atlas tile names (see textures.js). One string = all faces,
// or {top, side, bottom}.
// solid: collides. opaque: hides neighbour faces and blocks light.
// render: "cube" (default), "cutout" (alpha-tested, e.g. leaves/glass), "liquid", "cross" (plants),
// "model" (small boxes defined in world.js MODELS by `model`; e.g. fence, lantern, chest).
// replaceable: placing a block or flowing water may overwrite it. fluidLevel: flowing water depth 1..7.
// hardness: seconds to break by hand (Infinity = unbreakable). tool: preferred tool type.
// drop: item id/name dropped when broken (default: itself; null = nothing).
// ---- wood/colour pack data (used by woodColourDefs below)
const WOOD_SPECIES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"];
const WOOD_COLOR = { oak: "#a2834f", spruce: "#6f5232", birch: "#c8b77a", jungle: "#b0825a", acacia: "#a85a32", dark_oak: "#412b16", mangrove: "#7a3b37", cherry: "#e1b8ae" };
const DYE_COLOURS = [["white", "#e9ecec"], ["orange", "#f07613"], ["magenta", "#bd44b3"], ["light_blue", "#3aafd9"], ["yellow", "#f8c527"], ["lime", "#70b919"],
  ["pink", "#ed8dac"], ["gray", "#3e4447"], ["light_gray", "#8e8e86"], ["cyan", "#158991"], ["purple", "#792aac"], ["blue", "#35399d"],
  ["brown", "#724728"], ["green", "#546d1b"], ["red", "#a12722"], ["black", "#141519"]];
const TERRA_OLD = ["orange", "yellow", "white", "brown", "red"]; // terracotta colours that already exist (worldgen / trades use them)
BF.WOOD_SPECIES = WOOD_SPECIES; BF.WOOD_COLOR = WOOD_COLOR; BF.DYE_COLOURS = DYE_COLOURS;
const BLOCK_DEFS = [
  { name: "air", solid: false, opaque: false },
  { name: "grass", tiles: { top: "grass_top", side: "grass_side", bottom: "dirt" }, hardness: 0.6, tool: "shovel", drop: "dirt", extraDrops: [["wheat_seeds", 1, 1, 0.08]], color: "#6aa84f" },
  { name: "dirt", tiles: "dirt", hardness: 0.5, tool: "shovel", color: "#866043" },
  { name: "stone", tiles: "stone", hardness: 1.5, tool: "pickaxe", needsTool: true, drop: "cobblestone", color: "#7f7f7f" },
  { name: "cobblestone", tiles: "cobblestone", hardness: 2, tool: "pickaxe", needsTool: true, color: "#6e6e6e" },
  { name: "sand", tiles: "sand", hardness: 0.5, tool: "shovel", color: "#dbd3a0" },
  { name: "sandstone", tiles: { top: "sandstone_top", side: "sandstone_side", bottom: "sandstone_bottom" }, hardness: 0.8, tool: "pickaxe", needsTool: true, color: "#d8cb92" },
  { name: "gravel", tiles: "gravel", hardness: 0.6, tool: "shovel", extraDrops: [["flint", 1, 1, 0.1]], color: "#837e7c" },
  { name: "snow_grass", tiles: { top: "snow", side: "snow_side", bottom: "dirt" }, hardness: 0.6, tool: "shovel", drop: "dirt", color: "#f0f4f8" },
  { name: "snow", tiles: "snow", hardness: 0.3, tool: "shovel", color: "#f4f8fb" },
  { name: "ice", tiles: "ice", hardness: 0.5, tool: "pickaxe", render: "cutout", opaque: false, drop: null, color: "#a5c8f5" },
  { name: "water", tiles: "water", solid: false, opaque: false, render: "liquid", hardness: Infinity, drop: null, color: "#3f76e4" },
  { name: "oak_log", tiles: { top: "oak_log_top", side: "oak_log", bottom: "oak_log_top" }, hardness: 2, tool: "axe", color: "#6b5233" },
  { name: "oak_leaves", tiles: "oak_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#3d7a2a" },
  { name: "birch_log", tiles: { top: "birch_log_top", side: "birch_log", bottom: "birch_log_top" }, hardness: 2, tool: "axe", color: "#d8d3c5" },
  { name: "birch_leaves", tiles: "birch_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#5c8a3c" },
  { name: "spruce_log", tiles: { top: "spruce_log_top", side: "spruce_log", bottom: "spruce_log_top" }, hardness: 2, tool: "axe", color: "#3b2a18" },
  { name: "spruce_leaves", tiles: "spruce_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#2f4f32" },
  { name: "planks", tiles: "planks", hardness: 2, tool: "axe", color: "#a2834f" },
  { name: "cactus", tiles: { top: "cactus_top", side: "cactus_side", bottom: "cactus_bottom" }, render: "model", model: "cactus", opaque: false, hardness: 0.4, color: "#4f8a2b" },
  { name: "bedrock", tiles: "bedrock", hardness: Infinity, drop: null, color: "#333" },
  { name: "coal_ore", tiles: "coal_ore", hardness: 3, tool: "pickaxe", needsTool: true, drop: "coal", color: "#555" },
  { name: "iron_ore", tiles: "iron_ore", hardness: 3, tool: "pickaxe", needsTool: true, minTier: 2, color: "#a58a75" },
  { name: "gold_ore", tiles: "gold_ore", hardness: 3, tool: "pickaxe", needsTool: true, minTier: 3, color: "#c8b24a" },
  { name: "diamond_ore", tiles: "diamond_ore", hardness: 3, tool: "pickaxe", needsTool: true, minTier: 3, drop: "diamond", color: "#5ddfe0" },
  { name: "clay", tiles: "clay", hardness: 0.6, tool: "shovel", drop: "clay_ball", extraDrops: [["clay_ball", 3, 3, 1]], color: "#a0a6b4" },
  { name: "glass", tiles: "glass", render: "cutout", opaque: false, hardness: 0.3, drop: null, color: "#cfe9f0" },
  { name: "crafting_table", tiles: { top: "crafting_table_top", side: "crafting_table_side", front: "crafting_table_front", bottom: "planks" }, hardness: 2.5, tool: "axe", color: "#7a5a33" },
  { name: "bricks", tiles: "bricks", hardness: 2, tool: "pickaxe", needsTool: true, color: "#96503f" },
  { name: "wool", tiles: "wool", hardness: 0.8, color: "#eaeaea" },
  { name: "mossy_cobblestone", tiles: "mossy_cobblestone", hardness: 2, tool: "pickaxe", needsTool: true, color: "#61724a" },
  { name: "jungle_log", tiles: { top: "jungle_log_top", side: "jungle_log", bottom: "jungle_log_top" }, hardness: 2, tool: "axe", color: "#594420" },
  { name: "jungle_leaves", tiles: "jungle_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#2f8a1a" },
  { name: "pumpkin", tiles: { top: "pumpkin_top", side: "pumpkin_side", bottom: "pumpkin_top" }, hardness: 1, tool: "axe", color: "#c87a1a" },
  { name: "furnace", tiles: { top: "furnace_top", side: "furnace_side", front: "furnace_front", bottom: "furnace_top" }, hardness: 3.5, tool: "pickaxe", needsTool: true, color: "#5e5e5e" },
  // village blocks
  { name: "dirt_path", tiles: { top: "dirt_path_top", side: "dirt_path_side", bottom: "dirt" }, opaque: false, hardness: 0.6, tool: "shovel", drop: "dirt", color: "#94793f" },
  { name: "farmland", tiles: { top: "farmland", side: "dirt", bottom: "dirt" }, opaque: false, hardness: 0.6, tool: "shovel", drop: "dirt", color: "#5a3c22" },
  { name: "wheat", tiles: "wheat", render: "cross", solid: false, opaque: false, hardness: 0, drop: "wheat_item", extraDrops: [["wheat_seeds", 1, 3, 1]], color: "#d6c25a" },
  { name: "hay_bale", tiles: { top: "hay_bale_top", side: "hay_bale_side", bottom: "hay_bale_top" }, hardness: 0.5, color: "#c9a62c" },
  { name: "bell", tiles: { top: "bell_top", side: "bell", bottom: "bell_bottom" }, render: "model", model: "bell", opaque: false, hardness: 5, tool: "pickaxe", color: "#e8c547" },
  { name: "spruce_planks", tiles: "spruce_planks", hardness: 2, tool: "axe", color: "#6f5232" },
  { name: "sandstone_bricks", tiles: { top: "sandstone_top", side: "sandstone_bricks", bottom: "sandstone_top" }, hardness: 0.8, tool: "pickaxe", needsTool: true, color: "#d8cb92" },
  { name: "lantern", tiles: { top: "lantern_top", side: "lantern", bottom: "lantern_bottom" }, render: "model", model: "lantern", opaque: false, emit: 15, hardness: 3.5, tool: "pickaxe", color: "#f2b84b" },
  { name: "white_wool", tiles: "white_wool", hardness: 0.8, color: "#f0f0f0" },
  { name: "oak_fence", tiles: "planks", icon: "oak_fence", render: "model", model: "fence", opaque: false, hardness: 2, tool: "axe", color: "#a2834f" },
  { name: "chest", tiles: { top: "chest_top", side: "chest_side", front: "chest_front", bottom: "chest_bottom" }, render: "model", model: "chest", opaque: false, hardness: 2.5, tool: "axe", color: "#a0742e" },
  // flowing water: level 1 (next to a source) .. 7 (thinnest). Never placed by worldgen.
  ...[1, 2, 3, 4, 5, 6, 7].map(l => ({ name: "water_flow_" + l, tiles: "water", solid: false, opaque: false, render: "liquid", hardness: Infinity, drop: null, color: "#3f76e4", replaceable: true, fluidLevel: l })),
  // plants (render "cross": two diagonal quads, no collision, broken by flowing water)
  { name: "short_grass", tiles: "short_grass", render: "cross", solid: false, opaque: false, hardness: 0, drop: null, extraDrops: [["wheat_seeds", 1, 1, 0.125]], replaceable: true, color: "#6aa84f" },
  { name: "fern", tiles: "fern", render: "cross", solid: false, opaque: false, hardness: 0, drop: null, extraDrops: [["wheat_seeds", 1, 1, 0.08]], replaceable: true, color: "#4f8a3a" },
  { name: "dead_bush", tiles: "dead_bush", render: "cross", solid: false, opaque: false, hardness: 0, drop: "stick", replaceable: true, color: "#8a6a3a" },
  { name: "poppy", tiles: "poppy", render: "cross", solid: false, opaque: false, hardness: 0, color: "#d8302a" },
  { name: "dandelion", tiles: "dandelion", render: "cross", solid: false, opaque: false, hardness: 0, color: "#f2d64b" },
  { name: "cornflower", tiles: "cornflower", render: "cross", solid: false, opaque: false, hardness: 0, color: "#4a6ed8" },
  { name: "red_mushroom", tiles: "red_mushroom", render: "cross", solid: false, opaque: false, hardness: 0, color: "#c8302a" },
  { name: "brown_mushroom", tiles: "brown_mushroom", render: "cross", solid: false, opaque: false, hardness: 0, color: "#9a7050" },
  { name: "sugar_cane", tiles: "sugar_cane", render: "cross", solid: false, opaque: false, hardness: 0, color: "#8ac85a" },
  // new biome blocks
  { name: "red_sand", tiles: "red_sand", hardness: 0.5, tool: "shovel", color: "#b8622a" },
  { name: "terracotta", tiles: "terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: "#9a5a40" },
  { name: "orange_terracotta", tiles: "orange_terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: "#a0531c" },
  { name: "yellow_terracotta", tiles: "yellow_terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: "#b8852a" },
  { name: "white_terracotta", tiles: "white_terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: "#d0b2a2" },
  { name: "brown_terracotta", tiles: "brown_terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: "#4d3324" },
  { name: "red_terracotta", tiles: "red_terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: "#8f3d2e" },
  { name: "mycelium", tiles: { top: "mycelium_top", side: "mycelium_side", bottom: "dirt" }, hardness: 0.6, tool: "shovel", drop: "dirt", color: "#6f6265" },
  { name: "podzol", tiles: { top: "podzol_top", side: "podzol_side", bottom: "dirt" }, hardness: 0.6, tool: "shovel", drop: "dirt", color: "#5a3f1c" },
  { name: "mushroom_stem", tiles: "mushroom_stem", hardness: 0.2, tool: "axe", color: "#cfc8b8" },
  { name: "red_mushroom_block", tiles: "red_mushroom_block", hardness: 0.2, tool: "axe", drop: "red_mushroom", color: "#b82a24" },
  { name: "brown_mushroom_block", tiles: "brown_mushroom_block", hardness: 0.2, tool: "axe", drop: "brown_mushroom", color: "#957052" },
  { name: "dark_oak_log", tiles: { top: "dark_oak_log_top", side: "dark_oak_log", bottom: "dark_oak_log_top" }, hardness: 2, tool: "axe", color: "#3c2a16" },
  { name: "dark_oak_leaves", tiles: "dark_oak_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#2a5a1a" },
  { name: "cherry_log", tiles: { top: "cherry_log_top", side: "cherry_log", bottom: "cherry_log_top" }, hardness: 2, tool: "axe", color: "#3a2228" },
  { name: "cherry_leaves", tiles: "cherry_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#f0a8c8" },
  { name: "acacia_log", tiles: { top: "acacia_log_top", side: "acacia_log", bottom: "acacia_log_top" }, hardness: 2, tool: "axe", color: "#676157" },
  { name: "acacia_leaves", tiles: "acacia_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#5a8a22" },
  { name: "mangrove_log", tiles: { top: "mangrove_log_top", side: "mangrove_log", bottom: "mangrove_log_top" }, hardness: 2, tool: "axe", color: "#6a2a24" },
  { name: "mangrove_leaves", tiles: "mangrove_leaves", render: "cutout", opaque: false, hardness: 0.2, tool: "shears", drop: null, color: "#4a7a1a" },
  { name: "mud", tiles: "mud", hardness: 0.5, tool: "shovel", color: "#3c3632" },
  { name: "packed_ice", tiles: "packed_ice", hardness: 0.5, tool: "pickaxe", drop: null, color: "#8db4f0" },
  { name: "calcite", tiles: "calcite", hardness: 0.75, tool: "pickaxe", needsTool: true, color: "#e0e0dc" },
  { name: "moss_block", tiles: "moss_block", hardness: 0.1, tool: "axe", color: "#5a7a2a" },
  { name: "coarse_dirt", tiles: "coarse_dirt", hardness: 0.5, tool: "shovel", color: "#77553b" },
  { name: "acacia_planks", tiles: "acacia_planks", hardness: 2, tool: "axe", color: "#a85a32" },
  // more village crops (crossed-quad plants on farmland)
  { name: "carrots", tiles: "carrots", render: "cross", solid: false, opaque: false, hardness: 0, drop: "carrot", extraDrops: [["carrot", 1, 3, 1]], color: "#e8892a" },
  { name: "potatoes", tiles: "potatoes", render: "cross", solid: false, opaque: false, hardness: 0, drop: "potato", extraDrops: [["potato", 1, 3, 1]], color: "#c8a85a" },
  // young crops: planted from seeds/items on farmland, grow into the mature block (growsInto)
  { name: "wheat_young", tiles: "wheat_young", render: "cross", solid: false, opaque: false, hardness: 0, drop: "wheat_seeds", growsInto: "wheat", color: "#6aa84f" },
  { name: "carrots_young", tiles: "carrots_young", render: "cross", solid: false, opaque: false, hardness: 0, drop: "carrot", growsInto: "carrots", color: "#5a9a3a" },
  { name: "potatoes_young", tiles: "potatoes_young", render: "cross", solid: false, opaque: false, hardness: 0, drop: "potato", growsInto: "potatoes", color: "#5a9a3a" },
  { name: "beetroots_young", tiles: "beetroots_young", render: "cross", solid: false, opaque: false, hardness: 0, drop: "beetroot_seeds", growsInto: "beetroots", color: "#5a9a3a" },
  { name: "beetroots", tiles: "beetroots", render: "cross", solid: false, opaque: false, hardness: 0, drop: "beetroot", extraDrops: [["beetroot_seeds", 1, 3, 1]], color: "#a8323a" },
  ...doorDefs, ...bedDefs,
  // ---- stone/ore pack ----
  { name: "granite", tiles: "granite", hardness: 1.5, color: "#9a6b5a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "diorite", tiles: "diorite", hardness: 1.5, color: "#bdbdbd", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "andesite", tiles: "andesite", hardness: 1.5, color: "#888888", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "polished_granite", tiles: "polished_granite", hardness: 1.5, color: "#a06b5a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "polished_diorite", tiles: "polished_diorite", hardness: 1.5, color: "#c4c4c4", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "polished_andesite", tiles: "polished_andesite", hardness: 1.5, color: "#8c8c8c", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "stone_bricks", tiles: "stone_bricks", hardness: 1.5, color: "#7a7a7a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "mossy_stone_bricks", tiles: "mossy_stone_bricks", hardness: 1.5, color: "#6f7a62", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "cracked_stone_bricks", tiles: "cracked_stone_bricks", hardness: 1.5, color: "#767676", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "chiseled_stone_bricks", tiles: "chiseled_stone_bricks", hardness: 1.5, color: "#7a7a7a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "smooth_stone", tiles: "smooth_stone", hardness: 2, color: "#9e9e9e", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "deepslate", tiles: { top: "deepslate_top", side: "deepslate", bottom: "deepslate_top" }, hardness: 3, color: "#505054", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1, drop: "cobbled_deepslate" },
  { name: "cobbled_deepslate", tiles: "cobbled_deepslate", hardness: 3.5, color: "#4a4a4e", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "polished_deepslate", tiles: "polished_deepslate", hardness: 3.5, color: "#4c4c50", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "deepslate_bricks", tiles: "deepslate_bricks", hardness: 3.5, color: "#4a4a4e", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "deepslate_tiles", tiles: "deepslate_tiles", hardness: 3.5, color: "#46464a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "tuff", tiles: "tuff", hardness: 1.5, color: "#6d6d62", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "dripstone_block", tiles: "dripstone_block", hardness: 1.5, color: "#866b5a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "obsidian", tiles: "obsidian", hardness: 50, color: "#14101e", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 4 },
  { name: "cut_sandstone", tiles: { top: "sandstone_top", side: "cut_sandstone", bottom: "sandstone_top" }, hardness: 0.8, color: "#d8cb92", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "chiseled_sandstone", tiles: { top: "sandstone_top", side: "chiseled_sandstone", bottom: "sandstone_top" }, hardness: 0.8, color: "#d8cb92", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "smooth_sandstone", tiles: "sandstone_top", hardness: 2, color: "#dccf98", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "red_sandstone", tiles: { top: "red_sandstone_top", side: "red_sandstone", bottom: "red_sandstone_bottom" }, hardness: 0.8, color: "#b4602a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "cut_red_sandstone", tiles: { top: "red_sandstone_top", side: "cut_red_sandstone", bottom: "red_sandstone_top" }, hardness: 0.8, color: "#b4602a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "chiseled_red_sandstone", tiles: { top: "red_sandstone_top", side: "chiseled_red_sandstone", bottom: "red_sandstone_top" }, hardness: 0.8, color: "#b4602a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "smooth_red_sandstone", tiles: "red_sandstone_top", hardness: 2, color: "#b8642c", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "mud_bricks", tiles: "mud_bricks", hardness: 1.5, color: "#8a674f", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "packed_mud", tiles: "packed_mud", hardness: 1, color: "#8e6b50", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "prismarine", tiles: "prismarine", hardness: 1.5, color: "#63a897", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "prismarine_bricks", tiles: "prismarine_bricks", hardness: 1.5, color: "#5fa393", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "dark_prismarine", tiles: "dark_prismarine", hardness: 1.5, color: "#335f50", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "sea_lantern", tiles: "sea_lantern", emit: 15, hardness: 0.3, color: "#c8e8e0", creativeTab: "building" },
  { name: "blackstone", tiles: { top: "blackstone_top", side: "blackstone", bottom: "blackstone_top" }, hardness: 1.5, color: "#2c282c", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "polished_blackstone", tiles: "polished_blackstone", hardness: 2, color: "#35303a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "basalt", tiles: { top: "basalt_top", side: "basalt_side", bottom: "basalt_top" }, hardness: 1.25, color: "#4a4a50", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "smooth_basalt", tiles: "smooth_basalt", hardness: 1.25, color: "#48484e", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "netherrack", tiles: "netherrack", hardness: 0.4, color: "#6f3434", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "nether_bricks", tiles: "nether_bricks", hardness: 2, color: "#2c1418", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "soul_sand", tiles: "soul_sand", hardness: 0.5, color: "#51402f", creativeTab: "natural", tool: "shovel" },
  { name: "glowstone", tiles: "glowstone", emit: 15, hardness: 0.3, color: "#e8b868", creativeTab: "natural" },
  { name: "magma_block", tiles: "magma", emit: 3, hardness: 0.5, color: "#8a3010", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "quartz_block", tiles: { top: "quartz_block_top", side: "quartz_block_side", bottom: "quartz_block_bottom" }, hardness: 0.8, color: "#ece6df", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "chiseled_quartz_block", tiles: { top: "chiseled_quartz_block_top", side: "chiseled_quartz_block", bottom: "chiseled_quartz_block_top" }, hardness: 0.8, color: "#ece6df", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "quartz_pillar", tiles: { top: "quartz_pillar_top", side: "quartz_pillar", bottom: "quartz_pillar_top" }, hardness: 0.8, color: "#ece6df", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "quartz_bricks", tiles: "quartz_bricks", hardness: 0.8, color: "#ece6df", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "smooth_quartz", tiles: "quartz_block_bottom", hardness: 2, color: "#ece6df", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "end_stone", tiles: "end_stone", hardness: 3, color: "#dcdc9c", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "purpur_block", tiles: "purpur_block", hardness: 1.5, color: "#a77aa7", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "purpur_pillar", tiles: { top: "purpur_pillar_top", side: "purpur_pillar", bottom: "purpur_pillar_top" }, hardness: 1.5, color: "#a77aa7", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "bone_block", tiles: { top: "bone_block_top", side: "bone_block_side", bottom: "bone_block_top" }, hardness: 2, color: "#e2dcc4", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "blue_ice", tiles: "blue_ice", hardness: 2.8, color: "#74a8f0", creativeTab: "natural", tool: "pickaxe" },
  { name: "sponge", tiles: "sponge", hardness: 0.6, color: "#c8c04a", creativeTab: "natural" },
  { name: "wet_sponge", tiles: "wet_sponge", hardness: 0.6, color: "#a8a040", creativeTab: "natural" },
  { name: "melon", tiles: { top: "melon_top", side: "melon_side", bottom: "melon_top" }, hardness: 1, color: "#6a9a2a", creativeTab: "natural", tool: "axe" },
  { name: "tnt", tiles: { top: "tnt_top", side: "tnt_side", bottom: "tnt_bottom" }, hardness: 0, color: "#c83a2a", creativeTab: "functional" },
  { name: "bookshelf", tiles: { top: "planks", side: "bookshelf", bottom: "planks" }, hardness: 1.5, color: "#7a5a33", creativeTab: "functional", tool: "axe" },
  { name: "lapis_ore", tiles: "lapis_ore", hardness: 3, color: "#2a4aa8", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 2, drop: "lapis_lazuli", extraDrops: [["lapis_lazuli", 3, 7, 1]] },
  { name: "redstone_ore", tiles: "redstone_ore", hardness: 3, color: "#a82020", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 3, drop: "redstone", extraDrops: [["redstone", 3, 4, 1]] },
  { name: "emerald_ore", tiles: "emerald_ore", hardness: 3, color: "#2fd06a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 3, drop: "emerald" },
  { name: "copper_ore", tiles: "copper_ore", hardness: 3, color: "#c0704a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 2, drop: "raw_copper", extraDrops: [["raw_copper", 1, 4, 1]] },
  { name: "deepslate_coal_ore", tiles: "deepslate_coal_ore", hardness: 4.5, color: "#3a3a3c", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 1, drop: "coal" },
  { name: "deepslate_iron_ore", tiles: "deepslate_iron_ore", hardness: 4.5, color: "#8a6a58", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 2, drop: "iron_ore" },
  { name: "deepslate_gold_ore", tiles: "deepslate_gold_ore", hardness: 4.5, color: "#b89a30", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 3, drop: "gold_ore" },
  { name: "deepslate_diamond_ore", tiles: "deepslate_diamond_ore", hardness: 4.5, color: "#4ac8d0", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 3, drop: "diamond" },
  { name: "deepslate_lapis_ore", tiles: "deepslate_lapis_ore", hardness: 4.5, color: "#2a4aa8", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 2, drop: "lapis_lazuli", extraDrops: [["lapis_lazuli", 3, 7, 1]] },
  { name: "deepslate_redstone_ore", tiles: "deepslate_redstone_ore", hardness: 4.5, color: "#a82020", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 3, drop: "redstone", extraDrops: [["redstone", 3, 4, 1]] },
  { name: "deepslate_emerald_ore", tiles: "deepslate_emerald_ore", hardness: 4.5, color: "#2fd06a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 3, drop: "emerald" },
  { name: "deepslate_copper_ore", tiles: "deepslate_copper_ore", hardness: 4.5, color: "#c0704a", creativeTab: "natural", tool: "pickaxe", needsTool: true, minTier: 2, drop: "raw_copper", extraDrops: [["raw_copper", 1, 4, 1]] },
  { name: "iron_block", tiles: "iron_block", hardness: 5, color: "#d8d8d8", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 2 },
  { name: "gold_block", tiles: "gold_block", hardness: 3, color: "#f2d64b", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 3 },
  { name: "diamond_block", tiles: "diamond_block", hardness: 5, color: "#5ddfe0", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 3 },
  { name: "emerald_block", tiles: "emerald_block", hardness: 5, color: "#2fd06a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 3 },
  { name: "lapis_block", tiles: "lapis_block", hardness: 3, color: "#2a4aa8", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 2 },
  { name: "redstone_block", tiles: "redstone_block", hardness: 5, color: "#a82020", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "coal_block", tiles: "coal_block", hardness: 5, color: "#1c1c1c", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 1 },
  { name: "copper_block", tiles: "copper_block", hardness: 3, color: "#c0704a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 2 },
  { name: "raw_iron_block", tiles: "raw_iron_block", hardness: 5, color: "#c8a888", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 2 },
  { name: "raw_gold_block", tiles: "raw_gold_block", hardness: 5, color: "#e0b838", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 3 },
  { name: "raw_copper_block", tiles: "raw_copper_block", hardness: 5, color: "#b8704a", creativeTab: "building", tool: "pickaxe", needsTool: true, minTier: 2 },
  { name: "amethyst_block", tiles: "amethyst_block", hardness: 1.5, color: "#8a5ac8", creativeTab: "building", tool: "pickaxe" },
  // ---- end stone/ore pack ----
  // ---- wood/colour pack ---- (appended; ids are saved numerically: only ever append after this line)
  ...woodColourDefs(),
  // ---- end wood/colour pack ----
  // ---- slabs/stairs pack ---- (appended; ids are saved numerically: only ever append after this line)
  ...shapeDefs(),
  // ---- end slabs/stairs pack ----
  // ---- panes/ladders pack ---- (appended; ids are saved numerically: only ever append after this line)
  ...panesLadderDefs(),
  // ---- end panes/ladders pack ----
  // ---- torch pack ---- (appended; ids are saved numerically: only ever append after this line)
  ...torchDefs(),
  // ---- end torch pack ----
  // ---- jobsite pack ---- (appended; ids are saved numerically: only ever append after this line)
  ...jobsiteDefs(),
  // ---- end jobsite pack ----
  // ---- sign pack ---- (appended; ids are saved numerically: only ever append after this line; see CONTRACT.md "Signs")
  ...signDefs(),
  // ---- end sign pack ----
  // ---- explorer pack ---- (appended; ids are saved numerically: only ever append after this line; see CONTRACT.md "Explorers")
  // survey table: the explorer villager's jobsite (not vanilla): a compass rose inlaid in a spruce table
  { name: "survey_table", jobsite: "explorer", tiles: { top: "survey_table_top", side: "survey_table_side", front: "survey_table_front", bottom: "spruce_planks" }, hardness: 2.5, tool: "axe", creativeTab: "functional", color: "#5a3f24" },
  // tent (item `tent`): a 3 wide, 2 long, 2 high A-frame: 12 block states (6 floor, 6 above) x 4 facings, see tentDefs()
  ...tentDefs(),
  // ---- end explorer pack ----
];

// ---- slabs/stairs pack runtime: shape placeholders get their base block's tiles / hardness / tool / colour ----
{
  const byName = new Map(BLOCK_DEFS.map(d => [d.name, d]));
  for (const d of BLOCK_DEFS) if (d.shape) {
    const base = byName.get(d.shape.baseName);
    if (!base) throw new Error("slab/stairs base block missing: " + d.shape.baseName);
    d.tiles = typeof base.tiles === "string" ? base.tiles : Object.assign({}, base.tiles);
    d.hardness = base.hardness !== undefined ? base.hardness : 1;
    d.tool = base.tool || null; d.needsTool = !!base.needsTool; d.color = base.color;
    if (base.minTier != null) d.minTier = base.minTier;
  }
}

// ---- slabs/stairs pack: generator (see CONTRACT.md "Slabs and stairs") ----
// [base block, vanilla name prefix]. A double slab is the base block itself. States: slab bottom/top (2 ids), stairs 2 halves x 4 facings (8 ids).
// The bottom slab (`<p>_slab`) and the south-facing bottom stairs (`<p>_stairs`) are the items; all other states are hidden and drop/pick them.
function shapeDefs() {
  const SHAPE_MATERIALS = [["planks", "oak"], ["spruce_planks", "spruce"], ["birch_planks", "birch"], ["jungle_planks", "jungle"], ["acacia_planks", "acacia"],
    ["dark_oak_planks", "dark_oak"], ["mangrove_planks", "mangrove"], ["cherry_planks", "cherry"], ["cobblestone", "cobblestone"], ["mossy_cobblestone", "mossy_cobblestone"],
    ["stone", "stone"], ["smooth_stone", "smooth_stone"], ["stone_bricks", "stone_brick"], ["mossy_stone_bricks", "mossy_stone_brick"], ["granite", "granite"],
    ["diorite", "diorite"], ["andesite", "andesite"], ["polished_granite", "polished_granite"], ["polished_diorite", "polished_diorite"],
    ["polished_andesite", "polished_andesite"], ["sandstone", "sandstone"], ["cut_sandstone", "cut_sandstone"], ["smooth_sandstone", "smooth_sandstone"],
    ["red_sandstone", "red_sandstone"], ["cut_red_sandstone", "cut_red_sandstone"], ["smooth_red_sandstone", "smooth_red_sandstone"], ["bricks", "brick"],
    ["mud_bricks", "mud_brick"], ["quartz_block", "quartz"], ["smooth_quartz", "smooth_quartz"], ["deepslate_bricks", "deepslate_brick"],
    ["cobbled_deepslate", "cobbled_deepslate"], ["polished_deepslate", "polished_deepslate"], ["deepslate_tiles", "deepslate_tile"], ["blackstone", "blackstone"],
    ["polished_blackstone", "polished_blackstone"], ["prismarine", "prismarine"], ["prismarine_bricks", "prismarine_brick"], ["purpur_block", "purpur"],
    ["nether_bricks", "nether_brick"], ["terracotta", "terracotta"]];
  const out = [], WOODS = new Set(SHAPE_MATERIALS.slice(0, 8).map(m => m[0]));
  for (const [base, pre] of SHAPE_MATERIALS) for (const top of [0, 1]) {
    const box = top ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16];
    out.push({ name: pre + "_slab" + (top ? "_top" : ""), render: "model", model: "shape", opaque: false, shape: { kind: "slab", baseName: base, top, f: 0 },
      boxes: [box], box, cboxes: [box], ...(top ? { hidden: true, drop: pre + "_slab", item: pre + "_slab" } : { creativeTab: "building" }), ...(WOODS.has(base) ? { fuel: 7.5 } : {}) });
  }
  for (const [base, pre] of SHAPE_MATERIALS) for (const top of [0, 1]) for (let f = 0; f < 4; f++) {
    // box drawn for a staircase ascending to the south (+z, facing 2); rotBox turns it towards facing f. Top-half stairs are mirrored vertically.
    const low = top ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16], step = top ? [0, 0, 8, 16, 8, 16] : [0, 8, 8, 16, 16, 16];
    const boxes = [rotBox(low, f), rotBox(step, f)], canon = !top && f === 2;
    out.push({ name: pre + "_stairs" + (canon ? "" : (top ? "_top_" : "_bottom_") + "nesw"[f]), render: "model", model: "shape", opaque: false,
      shape: { kind: "stairs", baseName: base, top, f }, boxes, box: top ? [0, 0, 0, 16, 16, 16] : [0, 0, 0, 16, 16, 16], cboxes: boxes,
      ...(canon ? { creativeTab: "building" } : { hidden: true, drop: pre + "_stairs", item: pre + "_stairs" }), ...(WOODS.has(base) ? { fuel: 15 } : {}) });
  }
  return out;
}

// ---- wood/colour pack: generators (names follow vanilla texture names; see CONTRACT.md "wood and colour families") ----
function woodColourDefs() {
  const out = [], axe = { hardness: 2, tool: "axe" };
  const planksOf = sp => (sp === "oak" ? "planks" : sp + "_planks");
  for (const sp of WOOD_SPECIES) if (sp !== "oak" && sp !== "spruce" && sp !== "acacia")
    out.push({ name: sp + "_planks", tiles: sp + "_planks", ...axe, color: WOOD_COLOR[sp] });
  for (const sp of WOOD_SPECIES) out.push({ name: "stripped_" + sp + "_log", tiles: { top: "stripped_" + sp + "_log_top", side: "stripped_" + sp + "_log", bottom: "stripped_" + sp + "_log_top" }, ...axe, creativeTab: "building", color: WOOD_COLOR[sp] });
  for (const sp of WOOD_SPECIES) out.push({ name: sp + "_wood", tiles: sp + "_log", ...axe, color: WOOD_COLOR[sp] });
  for (const sp of WOOD_SPECIES) out.push({ name: "stripped_" + sp + "_wood", tiles: "stripped_" + sp + "_log", ...axe, color: WOOD_COLOR[sp] });
  for (const sp of WOOD_SPECIES) if (sp !== "oak")
    out.push({ name: sp + "_fence", tiles: planksOf(sp), icon: sp + "_fence", render: "model", model: "fence", opaque: false, ...axe, color: WOOD_COLOR[sp] });
  for (const [c, col] of DYE_COLOURS) if (c !== "white") out.push({ name: c + "_wool", tiles: c + "_wool", hardness: 0.8, color: col });
  for (const [c, col] of DYE_COLOURS) if (!TERRA_OLD.includes(c)) out.push({ name: c + "_terracotta", tiles: c + "_terracotta", hardness: 1.25, tool: "pickaxe", needsTool: true, color: col });
  for (const [c, col] of DYE_COLOURS) out.push({ name: c + "_concrete", tiles: c + "_concrete", hardness: 1.8, tool: "pickaxe", needsTool: true, color: col });
  for (const [c, col] of DYE_COLOURS) out.push({ name: c + "_concrete_powder", tiles: c + "_concrete_powder", hardness: 0.5, tool: "shovel", hardensTo: c + "_concrete", color: col });
  for (const [c, col] of DYE_COLOURS) out.push({ name: c + "_stained_glass", tiles: c + "_stained_glass", render: "cutout", translucent: true, opaque: false, hardness: 0.3, drop: null, color: col });
  for (const [c, col] of DYE_COLOURS) out.push({ name: c + "_glazed_terracotta", tiles: c + "_glazed_terracotta", hardness: 1.4, tool: "pickaxe", needsTool: true, color: col });
  out.push({ name: "tinted_glass", tiles: "tinted_glass", render: "cutout", translucent: true, opaque: false, hardness: 0.3, drop: null, color: "#2c2630" });
  return out;
}

// ---- panes/ladders pack: generator. Glass panes, stained panes, iron bars (model "pane": post + arms computed by world.js) and ladders (4 facings) ----
function panesLadderDefs() {
  const out = [];
  out.push({ name: "glass_pane", tiles: { top: "glass_pane_top", side: "glass", bottom: "glass_pane_top" }, icon: "glass", render: "model", model: "pane", opaque: false,
    hardness: 0.3, drop: null, creativeTab: "building", color: "#cfe9f0" });
  for (const [c, col] of DYE_COLOURS)
    out.push({ name: c + "_stained_glass_pane", tiles: { top: c + "_stained_glass_pane_top", side: c + "_stained_glass", bottom: c + "_stained_glass_pane_top" }, icon: c + "_stained_glass",
      render: "model", model: "pane", opaque: false, translucent: true, hardness: 0.3, drop: null, creativeTab: "building", color: col });
  out.push({ name: "iron_bars", tiles: { top: "iron_bars_top", side: "iron_bars", bottom: "iron_bars_top" }, icon: "iron_bars", render: "model", model: "pane", opaque: false,
    hardness: 5, tool: "pickaxe", creativeTab: "building", color: "#a8a8ac" });
  // ladders: f = direction the ladder faces (away from the wall); the supporting wall block is at pos - DIRS[f]. Box drawn for facing south (wall at -z).
  for (let f = 0; f < 4; f++) {
    const box = rotBox([0, 0, 0, 16, 16, 2], f);
    out.push({ name: "ladder_" + "nesw"[f], tiles: { top: "ladder", side: "ladder", bottom: "ladder" }, render: "model", model: "ladder", solid: false, opaque: false,
      hardness: 0.4, tool: "axe", drop: "ladder", item: "ladder", hidden: true, ladder: { f }, boxes: [box], color: "#a2834f" });
  }
  return out;
}

// ---- torch pack: `torch` (standing) and four hidden wall variants (f = outward facing; the torch leans on the block at -DIRS[f]).
// `emit` (0..15) is the block-light level a block gives off (any pack can set it; see CONTRACT.md "Block light").
function torchDefs() {
  const base = { render: "model", model: "torch", solid: false, opaque: false, hardness: 0, emit: 14, color: "#f2a93b" };
  const out = [{ name: "torch", tiles: "torch", icon: "torch_icon", creativeTab: "functional", ...base }];
  for (let f = 0; f < 4; f++) out.push({ name: "wall_torch_" + ["north", "east", "south", "west"][f], tiles: "torch", icon: "torch_icon", ...base, hidden: true, drop: "torch", item: "torch", wallTorch: { f } });
  return out;
}

// ---- sign pack: per wood species 4 standing signs (`<sp>_sign_<nesw>`) then 4 wall signs (`<sp>_wall_sign_<nesw>`); f = the direction
// the text faces (a wall sign's wall is at pos - DIRS[f]). Model "sign" (js/signs.js) merges neighbours into one board; `boxes` = the lone shape.
function signDefs() {
  const out = [];
  for (const sp of WOOD_SPECIES) for (const wall of [0, 1]) for (let f = 0; f < 4; f++) {
    const planks = sp === "oak" ? "planks" : sp + "_planks";
    const boxes = (wall ? [[0, 4, 0, 16, 12, 2]] : [[0, 8, 7, 16, 16, 9], [7, 0, 7, 9, 8, 9, sp + "_log"]]).map(b => rotBox(b, f));
    out.push({ name: sp + (wall ? "_wall_sign_" : "_sign_") + "nesw"[f], tiles: { top: planks, side: planks, bottom: planks, post: sp + "_log" }, render: "model", model: "sign",
      solid: false, opaque: false, hardness: 1, tool: "axe", drop: sp + "_sign", item: sp + "_sign", hidden: true, sign: { wood: sp, wall, f }, boxes, color: WOOD_COLOR[sp] });
  }
  return out;
}

// ---- jobsite pack: villager workstations (see CONTRACT.md "Jobsites"). `jobsite` = the profession the block employs (js/jobs.js).
// Cubes use tiles {top, side, front (+z), bottom}; the non-cube ones are box models (model "shape" draws `boxes`, 1/16 units; a 7th
// entry names the tile of that box; it must be one of the block's own tiles so it is in the atlas). No facing: fronts look south (+z).
function jobsiteDefs() {
  const wood = { hardness: 2.5, tool: "axe", creativeTab: "functional" }, rock = { tool: "pickaxe", needsTool: true, minTier: 1, creativeTab: "functional" };
  const model = (boxes, box) => ({ render: "model", model: "shape", opaque: false, boxes, box });
  return [
    { name: "composter", jobsite: "farmer", tiles: { top: "composter_top", side: "composter_side", bottom: "composter_bottom" }, ...wood, hardness: 0.6, color: "#8a6a3a" },
    { name: "lectern", jobsite: "librarian", tiles: { top: "lectern_top", side: "lectern_side", front: "lectern_front", bottom: "lectern_base" }, ...wood,
      ...model([[0, 0, 0, 16, 2, 16, "lectern_base"], [4, 2, 4, 12, 12, 12], [0, 12, 11, 16, 14, 16], [0, 12, 0, 16, 16, 11]], [0, 0, 0, 16, 15, 16]), color: "#a07a48" },
    { name: "brewing_stand", jobsite: "cleric", tiles: { top: "brewing_stand_top", side: "brewing_stand_side", bottom: "brewing_stand_rod" }, ...rock, hardness: 0.5,
      ...model([[2, 0, 2, 14, 2, 14], [7, 2, 7, 9, 15, 9, "brewing_stand_rod"], [10, 2, 6, 14, 9, 10], [2, 2, 2, 6, 9, 6], [2, 2, 10, 6, 9, 14]], [2, 0, 2, 14, 14, 14]), color: "#7a6a5a" },
    { name: "blast_furnace", jobsite: "armorer", tiles: { top: "blast_furnace_top", side: "blast_furnace_side", front: "blast_furnace_front", bottom: "blast_furnace_top" }, ...rock, hardness: 3.5, color: "#55555a" },
    { name: "grindstone", jobsite: "weaponsmith", tiles: { top: "grindstone_round", side: "grindstone_side", bottom: "grindstone_leg" }, ...rock, hardness: 2,
      ...model([[2, 0, 6, 4, 13, 10, "grindstone_leg"], [12, 0, 6, 14, 13, 10, "grindstone_leg"], [4, 4, 2, 12, 16, 14]], [2, 0, 2, 14, 16, 14]), color: "#8c8c8c" },
    { name: "smithing_table", jobsite: "toolsmith", tiles: { top: "smithing_table_top", side: "smithing_table_side", front: "smithing_table_front", bottom: "smithing_table_bottom" }, ...wood, color: "#3a2c2a" },
    { name: "smoker", jobsite: "butcher", tiles: { top: "smoker_top", side: "smoker_side", front: "smoker_front", bottom: "smoker_bottom" }, ...rock, hardness: 3.5, color: "#5a4a3a" },
    { name: "barrel", jobsite: "fisherman", tiles: { top: "barrel_top", side: "barrel_side", bottom: "barrel_bottom" }, ...wood, color: "#86643a" },
    { name: "loom", jobsite: "shepherd", tiles: { top: "loom_top", side: "loom_side", front: "loom_front", bottom: "loom_bottom" }, ...wood, color: "#b49a6a" },
    { name: "fletching_table", jobsite: "fletcher", tiles: { top: "fletching_table_top", side: "fletching_table_side", front: "fletching_table_front", bottom: "birch_planks" }, ...wood, color: "#c8b77a" },
    { name: "stonecutter", jobsite: "mason", tiles: { top: "stonecutter_top", side: "stonecutter_side", bottom: "stonecutter_saw" }, ...rock, hardness: 3.5,
      ...model([[0, 0, 0, 16, 9, 16], [1, 9, 8, 15, 16, 8, "stonecutter_saw"]], [0, 0, 0, 16, 9, 16]), color: "#7a7a7a" },
    { name: "cauldron", jobsite: "leatherworker", tiles: { top: "cauldron_top", side: "cauldron_side", bottom: "cauldron_bottom" }, ...rock, hardness: 2,
      ...model([[0, 3, 0, 16, 16, 2], [0, 3, 14, 16, 16, 16], [0, 3, 2, 2, 16, 14], [14, 3, 2, 16, 16, 14], [2, 3, 2, 14, 5, 14],
        [0, 0, 0, 4, 3, 4], [12, 0, 0, 16, 3, 4], [0, 0, 12, 4, 3, 16], [12, 0, 12, 16, 3, 16]], [0, 0, 0, 16, 16, 16]), color: "#3c3c40" },
    { name: "cartography_table", jobsite: "cartographer", tiles: { top: "cartography_table_top", side: "cartography_table_side", front: "cartography_table_front", bottom: "dark_oak_planks" }, ...wood, color: "#4a3a2a" },
    // builder (not vanilla): a drafting table with a blueprint pinned on its sloped top
    { name: "drafting_table", jobsite: "builder", tiles: { top: "drafting_table_top", side: "drafting_table_side", front: "drafting_table_front", bottom: "planks" }, ...wood, color: "#3a64a8" },
  ];
}

// Tent parts (explorer pack): `tent: {f, r, l, up}` = facing f (foot -> head, like beds), row r (0 foot, 1 head), lateral cell l (0 left .. 2 right, seen from the foot
// looking at the head). Placed from the cell the player targets: that cell is (r 0, l 1), the tent covers one cell to each side of it and one row further. Boxes
// are drawn for facing south: z = length, x = across; a floor mat plus a stepped canvas shell that peaks two blocks high over the middle cell (`up` parts are the layer above the floor). Not `bed`, so villagers' bed
// checks never pick a tent up; js/tents.js and player.js treat `tent` as a bed that sleeps through monsters.
function tentDefs() {
  // Canvas height (1/16 blocks) of each of the 12 steps across the 3 cells: a stepped A-frame whose ridge is two blocks (32) high. Steps above 16 live in the
  // upper layer, a second block state per cell stacked on the first.
  const STEP_H = [6, 11, 16, 22, 27, 32, 32, 27, 22, 16, 11, 6], out = [];
  for (let up = 0; up < 2; up++) for (let f = 0; f < 4; f++) for (let r = 0; r < 2; r++) for (let l = 0; l < 3; l++) {
    const lo = up ? 16 : 0, boxes = up ? [] : [[0, 0, 0, 16, 2, 16]];
    let top = up ? 0 : 2;
    for (let s = 4 * l; s < 4 * l + 4; s++) {
      const h = STEP_H[s], a = Math.max(Math.max(2, h - 6), lo) - lo, b = Math.min(h, lo + 16) - lo;
      if (b > a) { boxes.push([4 * (s - 4 * l), a, 0, 4 * (s - 4 * l) + 4, b, 16]); top = Math.max(top, b); }
    }
    out.push({ name: "tent_" + (up ? "up_" : "") + r + "_" + l + "_" + "nesw"[f], tiles: { top: "tent_cloth", side: "tent_cloth", bottom: "tent_cloth" }, render: "model", model: "shape", opaque: false,
      hardness: 0.3, drop: "tent", item: "tent", hidden: true, tent: { f, r, l, up: !!up }, boxes: boxes.map(b => rotBox(b, f)), box: rotBox([0, 0, 0, 16, top, 16], f), color: "#c9b27a" });
  }
  return out;
}

// Non-block items. tool: {type, tier, speed, damage}. food: hunger points restored.
const ITEM_DEFS = [
  { name: "stick", color: "#8a6a3a" },
  { name: "coal", color: "#222" },
  { name: "iron_ingot", color: "#d8d8d8" },
  { name: "gold_ingot", color: "#f2d64b" },
  { name: "diamond", color: "#5ddfe0" },
  { name: "wooden_pickaxe", tool: { type: "pickaxe", tier: 1, speed: 2, damage: 2 }, color: "#a2834f" },
  { name: "stone_pickaxe", tool: { type: "pickaxe", tier: 2, speed: 4, damage: 3 }, color: "#7f7f7f" },
  { name: "iron_pickaxe", tool: { type: "pickaxe", tier: 3, speed: 6, damage: 4 }, color: "#d8d8d8" },
  { name: "diamond_pickaxe", tool: { type: "pickaxe", tier: 4, speed: 8, damage: 5 }, color: "#5ddfe0" },
  { name: "wooden_axe", tool: { type: "axe", tier: 1, speed: 2, damage: 3 }, color: "#a2834f" },
  { name: "stone_axe", tool: { type: "axe", tier: 2, speed: 4, damage: 4 }, color: "#7f7f7f" },
  { name: "iron_axe", tool: { type: "axe", tier: 3, speed: 6, damage: 5 }, color: "#d8d8d8" },
  { name: "diamond_axe", tool: { type: "axe", tier: 4, speed: 8, damage: 6 }, color: "#5ddfe0" },
  { name: "wooden_shovel", tool: { type: "shovel", tier: 1, speed: 2, damage: 1 }, color: "#a2834f" },
  { name: "stone_shovel", tool: { type: "shovel", tier: 2, speed: 4, damage: 2 }, color: "#7f7f7f" },
  { name: "iron_shovel", tool: { type: "shovel", tier: 3, speed: 6, damage: 3 }, color: "#d8d8d8" },
  { name: "diamond_shovel", tool: { type: "shovel", tier: 4, speed: 8, damage: 4 }, color: "#5ddfe0" },
  { name: "wooden_sword", tool: { type: "sword", tier: 1, speed: 1, damage: 4 }, color: "#a2834f" },
  { name: "stone_sword", tool: { type: "sword", tier: 2, speed: 1, damage: 5 }, color: "#7f7f7f" },
  { name: "iron_sword", tool: { type: "sword", tier: 3, speed: 1, damage: 6 }, color: "#d8d8d8" },
  { name: "diamond_sword", tool: { type: "sword", tier: 4, speed: 1, damage: 7 }, color: "#5ddfe0" },
  { name: "raw_porkchop", food: 3, color: "#e89a9a" },
  { name: "cooked_porkchop", food: 8, color: "#c8763c" },
  { name: "raw_beef", food: 3, color: "#c0443a" },
  { name: "steak", food: 8, color: "#8a4a22" },
  { name: "raw_mutton", food: 2, color: "#d0605a" },
  { name: "cooked_mutton", food: 6, color: "#a4582c" },
  { name: "raw_chicken", food: 2, color: "#f0c8a8" },
  { name: "cooked_chicken", food: 6, color: "#d09a5a" },
  { name: "feather", color: "#f4f4f4" },
  { name: "apple", food: 4, color: "#d8302a" },
  { name: "rotten_flesh", food: 2, color: "#7a5a3a" },
  { name: "bone", color: "#ece8d8" },
  { name: "arrow", color: "#9a9a9a" },
  { name: "gunpowder", color: "#5a5a5a" },
  { name: "string", color: "#f0f0f0" },
  { name: "wheat_item", color: "#d6c25a" },
  { name: "wheat_seeds", plants: "wheat_young", color: "#6aa84f" },
  { name: "beetroot_seeds", plants: "beetroots_young", color: "#8a3a2a" },
  { name: "wooden_hoe", tool: { type: "hoe", tier: 1, speed: 2, damage: 1 }, color: "#a2834f" },
  { name: "stone_hoe", tool: { type: "hoe", tier: 2, speed: 4, damage: 1 }, color: "#7f7f7f" },
  { name: "iron_hoe", tool: { type: "hoe", tier: 3, speed: 6, damage: 1 }, color: "#d8d8d8" },
  { name: "diamond_hoe", tool: { type: "hoe", tier: 4, speed: 8, damage: 1 }, color: "#5ddfe0" },
  { name: "carrot", food: 3, plants: "carrots_young", color: "#e8892a" },
  { name: "potato", food: 1, plants: "potatoes_young", color: "#c8a85a" },
  { name: "baked_potato", food: 5, color: "#d8a040" },
  { name: "beetroot", food: 1, color: "#a8323a" },
  { name: "bread", food: 5, color: "#b98a3a" },
  { name: "emerald", color: "#2fd06a" },
  { name: "flint", color: "#3a3a3c" },
  { name: "clay_ball", color: "#a0a6b4" },
  { name: "brick", color: "#b0583e" },
  { name: "charcoal", color: "#2a241e" },
  { name: "paper", color: "#f0ece0" },
  { name: "book", color: "#7a3e22" },
  { name: "leather", color: "#8a4e2a" },
  { name: "raw_cod", food: 2, color: "#b8a888" },
  { name: "cooked_cod", food: 5, color: "#d8b888" },
  { name: "bow", tool: { type: "bow", tier: 1, speed: 1, damage: 1 }, color: "#8a6a3a" },
  { name: "oak_door", places: "door", color: "#9a7448" },
  { name: "red_bed", places: "bed", color: "#a82828" },
  // ---- stone/ore pack items ----
  { name: "lapis_lazuli", color: "#2a4aa8" },
  { name: "redstone", color: "#c01818" },
  { name: "raw_iron", color: "#c8a888" },
  { name: "raw_gold", color: "#e8c040" },
  { name: "raw_copper", color: "#c07848" },
  { name: "copper_ingot", color: "#d8805a" },
  { name: "amethyst_shard", color: "#a878e0" },
  { name: "quartz", color: "#eee8e0" },
  // ---- end stone/ore pack items ----
  // ---- wood/colour pack ---- (items appended; saved by name)
  { name: "bone_meal", color: "#e8e4d4" },
  ...DYE_COLOURS.map(([c, col]) => ({ name: c + "_dye", color: col, dye: c })),
  // ---- end wood/colour pack items ----
  // ---- panes/ladders pack items ----
  { name: "ladder", places: "ladder", color: "#a2834f", creativeTab: "functional" },
  // ---- end panes/ladders pack items ----
  // ---- sign pack items ----
  ...WOOD_SPECIES.map(sp => ({ name: sp + "_sign", places: "sign", stack: 16, color: WOOD_COLOR[sp], creativeTab: "functional", wood: sp })),
  // ---- end sign pack items ----
  // ---- village life items (js/villagelife.js) ----
  { name: "bucket", stack: 16, color: "#c8c8c8" },
  { name: "water_bucket", stack: 1, color: "#3f76e4" },
  // ---- end village life items ----
  // ---- cartography items (js/maps.js, js/cartography.js) ----
  { name: "compass", color: "#a8a8b0" },
  ...[1, 2, 3, 4, 5].map(n => ({ name: "blank_map_" + n, color: "#d8c890", mapSize: n, label: "Blank Map (" + 8 * Math.pow(2, n - 1) + "x" + 8 * Math.pow(2, n - 1) + " chunks)" })),
  // ---- end cartography items ----
  // ---- explorer items (append-only) ----
  { name: "tent", places: "tent", stack: 1, color: "#c9b27a", creativeTab: "functional" },
  // ---- end explorer items ----
];

const MAX_BLOCK = 4095, ITEM_BASE = 4096;
BF.MAX_BLOCK = MAX_BLOCK; BF.ITEM_BASE = ITEM_BASE;
const blocks = [], items = [], B = {}, I = {};
BLOCK_DEFS.forEach((d, id) => {
  if (id > MAX_BLOCK) throw new Error("too many blocks: id " + id + " > MAX_BLOCK");
  const def = Object.assign({ solid: true, opaque: true, render: "cube", hardness: 1, tool: null, needsTool: false }, d, { id, isBlock: true });
  if (def.render !== "cube" && d.opaque === undefined) def.opaque = false;
  if (typeof def.tiles === "string") def.tiles = { top: def.tiles, side: def.tiles, bottom: def.tiles };
  if (def.tiles && !def.tiles.front) def.tiles.front = def.tiles.side; // front = the +z (south) face
  blocks[id] = def; items[id] = def; B[def.name] = id; I[def.name] = id;
});
ITEM_DEFS.forEach((d, i) => {
  const id = ITEM_BASE + i;
  const def = Object.assign({ isBlock: false, stack: d.tool ? 1 : 64 }, d, { id });
  items[id] = def; I[def.name] = id;
});
// resolve drop names to ids
for (const b of blocks) {
  if (b.drop === undefined) b.drop = b.id;
  else if (typeof b.drop === "string") b.drop = I[b.drop];
}
for (const b of blocks) if (b.stack === undefined) b.stack = 64;
for (const b of blocks) if (typeof b.item === "string") b.item = I[b.item];
for (const it of items) if (it && typeof it.plants === "string") it.plants = B[it.plants];
for (const b of blocks) if (typeof b.growsInto === "string") b.growsInto = B[b.growsInto];

// Fast lookup tables for the mesher / physics.
const SOLID = new Uint8Array(MAX_BLOCK + 1), OPAQUE = new Uint8Array(MAX_BLOCK + 1), RENDER = new Uint8Array(MAX_BLOCK + 1); // 0 none,1 cube,2 cutout,3 liquid,4 cross
// FLUID: 0 not water, 8 = source, 1..7 = flowing level (8 - FLUID gives depth step)
const FLUID = new Uint8Array(MAX_BLOCK + 1), REPLACEABLE = new Uint8Array(MAX_BLOCK + 1);
for (const b of blocks) {
  SOLID[b.id] = b.solid ? 1 : 0;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  RENDER[b.id] = b.id === 0 ? 0 : b.render === "cutout" ? 2 : b.render === "liquid" ? 3 : b.render === "cross" ? 4 : b.render === "model" ? 5 : 1;
}

BF.blocks = blocks;   // by block id
BF.items = items;     // by item id (blocks included)
BF.B = B;             // block name -> id
BF.I = I;             // item name -> id (blocks included)
for (const b of blocks) {
  if (b.name === "water") FLUID[b.id] = 8;
  else if (b.fluidLevel) FLUID[b.id] = b.fluidLevel;
  REPLACEABLE[b.id] = b.id === 0 || b.replaceable ? 1 : 0;
}
const EMIT = new Uint8Array(MAX_BLOCK + 1); // block light emitted (0..15), from the `emit` field of a block def
for (const b of blocks) EMIT[b.id] = b.emit ? Math.max(0, Math.min(15, b.emit | 0)) : 0;
BF.EMIT = EMIT;
BF.SOLID = SOLID; BF.OPAQUE = OPAQUE; BF.RENDER = RENDER; BF.FLUID = FLUID; BF.REPLACEABLE = REPLACEABLE;
BF.waterFlowId = l => B["water_flow_" + l];
// Collision box [x0,y0,z0,x1,y1,z1] in blocks for solid blocks smaller than a full cube (doors, beds), else undefined.
const CBOX = [];
for (const b of blocks) if (b.box) CBOX[b.id] = b.box.slice(0, 6).map(v => v / 16);
BF.CBOX = CBOX;
// Slabs/stairs: collision box LIST in blocks (CBOXES[id]; world.js boxHit prefers it over CBOX) and the families by base block id.
// BF.SHAPES[baseId] = {slab: [bottomId, topId], stairs: [[bottom f0..f3], [top f0..f3]], name}; blocks carry shape = {kind, base (id), top, f}.
// BF.LIGHTBLOCK[id] = 1 for them: world.js counts them as sky-light blocking for the column top (they are not opaque for face culling).
const CBOXES = [], SHAPES = {}, LIGHTBLOCK = new Uint8Array(MAX_BLOCK + 1);
for (const b of blocks) if (b.shape) {
  const sh = b.shape; sh.base = B[sh.baseName];
  const fam = SHAPES[sh.base] || (SHAPES[sh.base] = { slab: [], stairs: [[], []], name: sh.baseName });
  if (sh.kind === "slab") fam.slab[sh.top] = b.id; else fam.stairs[sh.top][sh.f] = b.id;
  CBOXES[b.id] = b.cboxes.map(c => c.slice(0, 6).map(v => v / 16));
  LIGHTBLOCK[b.id] = 1;
  if (b.fuel === undefined) delete b.fuel;
}
BF.CBOXES = CBOXES; BF.SHAPES = SHAPES; BF.LIGHTBLOCK = LIGHTBLOCK;
BF.DIRS = DIRS;
BF.rotBox = rotBox;
BF.dirIndex = (dx, dz) => Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0);
BF.doorId = (f, upper, open) => B["oak_door_" + (upper ? "upper" : "lower") + (open ? "_open_" : "_") + "nesw"[f & 3]];
BF.ladderId = f => B["ladder_" + "nesw"[f & 3]]; // ladder facing f (away from its wall)
BF.tentId = (f, r, l, up) => B["tent_" + (up ? "up_" : "") + r + "_" + l + "_" + "nesw"[f & 3]];
BF.bedId = (f, head) => B["red_bed_" + (head ? "head_" : "foot_") + "nesw"[f & 3]];
// Item by name, creating the per-zone filled map items ("filled_map_<size>_<zoneX>_<zoneZ>", see js/maps.js) on demand: saves store items by name.
// Dynamic items get ids from ITEM_BASE + 0x10000 up; undefined for names that are not items.
let dynItem = ITEM_BASE + 0x10000;
BF.resolveItem = name => {
  if (I[name] !== undefined) return I[name];
  const m = /^filled_map_([1-5])_(-?\d+)_(-?\d+)$/.exec(name || "");
  if (!m) return undefined;
  const size = +m[1], zx = +m[2], zz = +m[3], side = 8 * Math.pow(2, size - 1), id = dynItem++;
  items[id] = { name, id, isBlock: false, stack: 1, color: "#d8c890", sprite: "filled_map", map: { size, zx, zz }, label: "Map (" + side + "x" + side + " chunks)" };
  I[name] = id;
  return id;
};
// Items dropped when a block breaks: its `drop` plus `extraDrops` [[itemName, min, max, chance], ...].
// Returns [{id, count}]. Mature crops' extra drops replace nothing: wheat gives wheat + 1-3 seeds.
BF.rollDrops = function (blockId) {
  const b = blocks[blockId], out = [];
  if (!b) return out;
  if (b.drop != null) out.push({ id: b.drop, count: 1 });
  for (const [name, min, max, chance] of b.extraDrops || []) {
    if (Math.random() >= chance) continue;
    const id = I[name];
    if (id === undefined) continue;
    const n = min + Math.floor(Math.random() * (max - min + 1));
    const same = out.find(o => o.id === id);
    if (same) same.count += n; else out.push({ id, count: n });
  }
  return out;
};
BF.itemName = id => (items[id] ? items[id].label || items[id].name.replace(/_item$/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "?");
// ---- wood/colour pack runtime ----
for (const b of blocks) if (typeof b.hardensTo === "string") b.hardensTo = B[b.hardensTo];
// Concrete powder turns into concrete when water (source or flowing) touches it from the sides or above.
// Called from world.js fluidTick for queued cells and by anything that places a powder block.
BF.hardenPowder = (x, y, z, id) => {
  const b = blocks[id], w = BF.world;
  if (!b || b.hardensTo == null || !w) return false;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]])
    if (FLUID[w.getBlock(x + dx, y + dy, z + dz)]) { w.setBlock(x, y, z, b.hardensTo); return true; }
  return false;
};
})();
