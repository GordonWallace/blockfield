// Cartography recipes, registered through BF.recipeHooks. There is no redstone, so the compass is four iron ingots around a gold ingot (the needle).
// A map is eight paper around a compass (vanilla). Surrounding a map with paper gives the next size: computed in js/maps.js (BF.craftHooks).
const BF = window.BF;
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped }) => {
  const I = BF.I;
  addShaped(I.compass, 1, [" N ", "NGN", " N "], { N: I.iron_ingot, G: I.gold_ingot }, "4 Iron Ingots around a Gold Ingot → Compass");
  addShaped(I.blank_map_1, 1, ["PPP", "PCP", "PPP"], { P: I.paper, C: I.compass }, "8 Paper around a Compass → Map (8×8 chunks)");
});
