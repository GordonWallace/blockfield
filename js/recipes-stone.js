// Stone / ore / mineral pack recipes, registered through the BF.recipeHooks hook that inventory.js runs at the end of
// buildRecipes(). Recipes that name missing items are skipped by inventory.js's helpers.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, addShapeless, smelt }) => {
  const I = BF.I;
  const two = (out, n, inp, d) => addShaped(I[out], n, ["SS", "SS"], { S: I[inp] }, d);
  const nm = s => s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  // 2x2 -> 4 families
  for (const [out, inp] of [["polished_granite", "granite"], ["polished_diorite", "diorite"], ["polished_andesite", "andesite"],
    ["stone_bricks", "stone"], ["polished_deepslate", "cobbled_deepslate"], ["deepslate_bricks", "polished_deepslate"],
    ["deepslate_tiles", "deepslate_bricks"], ["polished_blackstone", "blackstone"], ["cut_sandstone", "sandstone"],
    ["cut_red_sandstone", "red_sandstone"], ["mud_bricks", "packed_mud"], ["quartz_bricks", "quartz_block"]])
    two(out, 4, inp, "4 " + nm(inp) + " (2×2) → 4 " + nm(out));
  // 2x2 -> 1
  addShaped(I.red_sandstone, 1, ["SS", "SS"], { S: I.red_sand }, "4 Red Sand (2×2) → Red Sandstone");
  addShaped(I.quartz_block, 1, ["QQ", "QQ"], { Q: I.quartz }, "4 Quartz (2×2) → Quartz Block");
  addShaped(I.amethyst_block, 1, ["AA", "AA"], { A: I.amethyst_shard }, "4 Amethyst Shard (2×2) → Amethyst Block");
  // chiseled / pillar: two blocks stacked (or side by side for chiseled quartz)
  const stacked = (out, n, inp, d) => addShaped(I[out], n, ["S", "S"], { S: I[inp] }, d);
  stacked("chiseled_stone_bricks", 1, "stone_bricks", "2 Stone Bricks (stacked) → Chiseled Stone Bricks");
  stacked("chiseled_sandstone", 1, "sandstone", "2 Sandstone (stacked) → Chiseled Sandstone");
  stacked("chiseled_red_sandstone", 1, "red_sandstone", "2 Red Sandstone (stacked) → Chiseled Red Sandstone");
  stacked("quartz_pillar", 2, "quartz_block", "2 Quartz Blocks (stacked) → 2 Quartz Pillars");
  stacked("purpur_pillar", 1, "purpur_block", "2 Purpur Blocks (stacked) → Purpur Pillar");
  addShaped(I.chiseled_quartz_block, 1, ["QQ"], { Q: I.quartz_block }, "2 Quartz Blocks (side by side) → Chiseled Quartz Block");
  // mossy / stone variants
  addShapeless(I.mossy_stone_bricks, 1, [I.stone_bricks, I.moss_block], "Stone Bricks + Moss Block → Mossy Stone Bricks");
  addShapeless(I.diorite, 2, [I.cobblestone, I.cobblestone, I.quartz, I.quartz], "2 Cobblestone + 2 Quartz → 2 Diorite");
  addShapeless(I.granite, 1, [I.diorite, I.quartz], "Diorite + Quartz → Granite");
  addShapeless(I.andesite, 2, [I.diorite, I.cobblestone], "Diorite + Cobblestone → 2 Andesite");
  addShapeless(I.packed_mud, 1, [I.mud, I.wheat_item], "Mud + Wheat → Packed Mud");
  addShaped(I.blue_ice, 1, ["PPP", "PPP", "PPP"], { P: I.packed_ice }, "9 Packed Ice → Blue Ice");
  // decor
  addShaped(I.bookshelf, 1, ["PPP", "BBB", "PPP"], { P: [I.planks, I.spruce_planks, I.acacia_planks, I.birch_planks, I.jungle_planks, I.dark_oak_planks, I.cherry_planks, I.mangrove_planks, I.oak_planks], B: I.book }, "6 Planks + 3 Books → Bookshelf");
  addShaped(I.tnt, 1, ["GSG", "SGS", "GSG"], { G: I.gunpowder, S: I.sand }, "5 Gunpowder + 4 Sand (checkered) → TNT");
  // storage blocks <-> 9 items
  const store = (block, item, label) => {
    addShaped(I[block], 1, ["III", "III", "III"], { I: I[item] }, "9 " + label + " → " + nm(block));
    addShapeless(I[item], 9, [I[block]], nm(block) + " → 9 " + label);
  };
  store("iron_block", "iron_ingot", "Iron Ingot"); store("gold_block", "gold_ingot", "Gold Ingot");
  store("diamond_block", "diamond", "Diamond"); store("emerald_block", "emerald", "Emerald");
  store("lapis_block", "lapis_lazuli", "Lapis Lazuli"); store("redstone_block", "redstone", "Redstone");
  store("coal_block", "coal", "Coal"); store("copper_block", "copper_ingot", "Copper Ingot");
  store("raw_iron_block", "raw_iron", "Raw Iron"); store("raw_gold_block", "raw_gold", "Raw Gold");
  store("raw_copper_block", "raw_copper", "Raw Copper");

  // smelting
  smelt(I.stone, I.smooth_stone);
  smelt(I.sandstone, I.smooth_sandstone);
  smelt(I.red_sandstone, I.smooth_red_sandstone);
  smelt(I.quartz_block, I.smooth_quartz);
  smelt(I.cobbled_deepslate, I.deepslate);
  smelt(I.stone_bricks, I.cracked_stone_bricks);
  smelt(I.basalt, I.smooth_basalt);
  smelt(I.wet_sponge, I.sponge);
  smelt([I.raw_copper, I.copper_ore, I.deepslate_copper_ore], I.copper_ingot);
  smelt([I.raw_iron, I.deepslate_iron_ore], I.iron_ingot);
  smelt([I.raw_gold, I.deepslate_gold_ore], I.gold_ingot);
  smelt([I.lapis_ore, I.deepslate_lapis_ore], I.lapis_lazuli);
  smelt([I.redstone_ore, I.deepslate_redstone_ore], I.redstone);
  smelt([I.emerald_ore, I.deepslate_emerald_ore], I.emerald);
  smelt([I.deepslate_diamond_ore], I.diamond);
  smelt([I.deepslate_coal_ore], I.coal);
});
})();
