// Blockfield 1.6, the realistic look: js/real/assets-ground.js. Owner: the Biome assets thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
// The colours of natural ground (BF.real.assets.ground): what each natural block looks like as smooth terrain. An entry is
// { id, blocks: [names], color: [r, g, b] (sRGB, 0 .. 1; written here as "#hex"), layer: 0 soil and turf | 1 rock | 2 sand and gravel | 3 snow and ice, tint: the biome's
// grass colour multiplies it }. A later entry for a block wins, so these override the foundation's defaults (js/real/terrain.js); the
// shared detail texture adds the grain. Colours are of the dry material in open shade, measured against soil and rock references
// rather than the block textures, so turf is not lawn green and stone is not flat grey.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
const G = BF.real.assets.ground;
// (the terrain tables read a colour as [r, g, b] in sRGB, 0 .. 1)
const rgb = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const add = (id, layer, color, blocks, tint) => G.push({ id, blocks, color: rgb(color), layer, tint: !!tint });
// soil and turf
add("turf", 0, "#80876b", ["grass"], true);          // near-neutral, so the biome's grass colour decides the hue
add("loam", 0, "#5e4a38", ["dirt"]);
add("stony_soil", 0, "#6e5c48", ["coarse_dirt"]);
add("needle_litter", 0, "#5a4028", ["podzol"]);
add("mud", 0, "#3c342c", ["mud"]);
add("clay", 0, "#8e9498", ["clay"]);
add("mycelium", 0, "#7a6a78", ["mycelium"]);
add("moss", 0, "#51702c", ["moss_block"]);
// sand and gravel
add("quartz_sand", 2, "#d6c8a0", ["sand"]);
add("red_sand", 2, "#b8683c", ["red_sand"]);
add("gravel", 2, "#85807a", ["gravel"]);
// rock
add("stone", 1, "#7e7c78", ["stone", "coal_ore", "iron_ore", "gold_ore", "diamond_ore", "lapis_ore", "redstone_ore", "emerald_ore", "copper_ore"]);
add("granite", 1, "#a07868", ["granite"]);
add("diorite", 1, "#b4b2ae", ["diorite"]);
add("andesite", 1, "#84868a", ["andesite"]);
add("tuff", 1, "#6c6c62", ["tuff"]);
add("calcite", 1, "#dcdad2", ["calcite"]);
add("deepslate", 1, "#4a4a50", ["deepslate", "deepslate_coal_ore", "deepslate_iron_ore", "deepslate_gold_ore", "deepslate_diamond_ore", "deepslate_lapis_ore",
  "deepslate_redstone_ore", "deepslate_emerald_ore", "deepslate_copper_ore"]);
add("sandstone", 1, "#cdb98a", ["sandstone"]);
add("red_sandstone", 1, "#b05e34", ["red_sandstone"]);
// the banded clays of the badlands
add("clay_band_brown", 1, "#8e5a44", ["terracotta", "brown_terracotta"]);
add("clay_band_orange", 1, "#b4683a", ["orange_terracotta"]);
add("clay_band_yellow", 1, "#c49a58", ["yellow_terracotta"]);
add("clay_band_white", 1, "#cdbcae", ["white_terracotta"]);
add("clay_band_red", 1, "#8a4232", ["red_terracotta"]);
// snow and ice
add("snow", 3, "#eef2f6", ["snow", "snow_grass"]);
add("ice", 3, "#a8c8e8", ["ice"]);
add("glacier_ice", 3, "#8cb4dc", ["packed_ice"]);
})();
