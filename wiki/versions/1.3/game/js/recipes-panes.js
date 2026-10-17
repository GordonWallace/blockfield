// Panes / bars / ladders recipes, registered through BF.recipeHooks (inventory.js runs the hooks at the end of buildRecipes()).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, fuel }) => {
  const I = BF.I, C = BF.DYE_COLOURS.map(c => c[0]);
  const nm = c => c.replace(/_/g, " ").replace(/\b\w/g, x => x.toUpperCase());
  const PANES = [I.glass_pane, ...C.map(c => I[c + "_stained_glass_pane"])];
  // 6 glass (3x2) -> 16 panes; stained glass of a colour gives that colour's panes
  addShaped(I.glass_pane, 16, ["GGG", "GGG"], { G: I.glass }, "6 Glass (3×2) → 16 Glass Panes");
  // 8 panes (any kind) around a dye -> 8 stained panes of that colour (same ring as dyeing glass blocks)
  for (const c of C) {
    addShaped(I[c + "_stained_glass_pane"], 16, ["GGG", "GGG"], { G: I[c + "_stained_glass"] }, c === "red" ? "6 Stained Glass of one colour (3×2) → 16 Stained Panes of that colour" : undefined);
    addShaped(I[c + "_stained_glass_pane"], 8, ["XXX", "XDX", "XXX"], { X: PANES, D: I[c + "_dye"] }, c === "red" ? "Dye + 8 Glass Panes in a ring → 8 Stained Panes of that colour" : undefined);
  }
  addShaped(I.iron_bars, 16, ["III", "III"], { I: I.iron_ingot }, "6 Iron Ingots (3×2) → 16 Iron Bars");
  addShaped(I.ladder, 3, ["S S", "SSS", "S S"], { S: I.stick }, "7 Sticks in an H → 3 Ladders");
  fuel(I.ladder, 7.5, "Ladder");
});
})();
