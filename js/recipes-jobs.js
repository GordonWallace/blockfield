// Jobsite pack recipes (vanilla shapes), registered through BF.recipeHooks. Substitutes where the vanilla ingredient does not exist:
// brewing stand uses a gold ingot for the blaze rod; the drafting table (builder, not vanilla) is paper + blue dye over 4 planks.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, fuel }) => {
  const I = BF.I;
  if (I.composter === undefined) return;
  const names = BF.blocks.filter(b => b && !b.hidden).map(b => b.name);
  const ids = list => list.map(n => I[n]).filter(x => x !== undefined);
  const PLANKS = ids(names.filter(n => n === "planks" || /_planks$/.test(n)));
  const LOGS = ids(names.filter(n => /_(log|wood)$/.test(n)));
  const WSLAB = ids(["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"].map(s => s + "_slab"));
  addShaped(I.composter, 1, ["S S", "S S", "SSS"], { S: WSLAB }, "7 Wooden Slabs (U) → Composter");
  addShaped(I.lectern, 1, ["SSS", " B ", " S "], { S: WSLAB, B: I.bookshelf }, "Wooden Slabs around a Bookshelf → Lectern");
  addShaped(I.brewing_stand, 1, [" G ", "CCC"], { G: I.gold_ingot, C: I.cobblestone }, "Gold Ingot over 3 Cobblestone → Brewing Stand");
  addShaped(I.blast_furnace, 1, ["III", "IFI", "SSS"], { I: I.iron_ingot, F: I.furnace, S: I.smooth_stone }, "5 Iron + Furnace + 3 Smooth Stone → Blast Furnace");
  addShaped(I.grindstone, 1, ["TST", "P P"], { T: I.stick, S: I.stone_slab, P: PLANKS }, "Sticks, Stone Slab, Planks → Grindstone");
  addShaped(I.smithing_table, 1, ["II", "PP", "PP"], { I: I.iron_ingot, P: PLANKS }, "2 Iron Ingots over 4 Planks → Smithing Table");
  addShaped(I.smoker, 1, [" L ", "LFL", " L "], { L: LOGS, F: I.furnace }, "4 Logs around a Furnace → Smoker");
  addShaped(I.barrel, 1, ["PSP", "P P", "PSP"], { P: PLANKS, S: WSLAB }, "6 Planks + 2 Wooden Slabs → Barrel");
  addShaped(I.loom, 1, ["SS", "PP"], { S: I.string, P: PLANKS }, "2 String over 2 Planks → Loom");
  addShaped(I.fletching_table, 1, ["FF", "PP", "PP"], { F: I.flint, P: PLANKS }, "2 Flint over 4 Planks → Fletching Table");
  addShaped(I.stonecutter, 1, [" I ", "SSS"], { I: I.iron_ingot, S: I.stone }, "Iron Ingot over 3 Stone → Stonecutter");
  addShaped(I.cauldron, 1, ["I I", "I I", "III"], { I: I.iron_ingot }, "7 Iron Ingots (U) → Cauldron");
  addShaped(I.cartography_table, 1, ["PP", "WW", "WW"], { P: I.paper, W: PLANKS }, "2 Paper over 4 Planks → Cartography Table");
  addShaped(I.drafting_table, 1, ["PD", "WW", "WW"], { P: I.paper, D: I.blue_dye, W: PLANKS }, "Paper + Blue Dye over 4 Planks → Drafting Table");
  if (I.survey_table !== undefined && I.compass !== undefined) addShaped(I.survey_table, 1, ["PC", "WW", "WW"], { P: I.paper, C: I.compass, W: PLANKS }, "Paper + Compass over 4 Planks → Survey Table (explorer)");
  const WOOL = ids(names.filter(n => n === "wool" || /_wool$/.test(n)));
  if (I.tent !== undefined) addShaped(I.tent, 1, ["WWW", "WWW", "S S"], { W: WOOL, S: I.stick }, "6 Wool (any colour) over 2 Sticks → Tent");
  fuel(ids(["composter", "lectern", "barrel", "loom", "fletching_table", "smithing_table", "cartography_table", "drafting_table", "survey_table"]), 15);
});
})();
