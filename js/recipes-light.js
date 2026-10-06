// Torch recipe (vanilla): coal or charcoal over a stick makes 4 torches. Registered through BF.recipeHooks.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped }) => {
  const I = BF.I;
  if (I.torch === undefined) return;
  addShaped(I.torch, 4, ["C", "S"], { C: [I.coal, I.charcoal], S: I.stick }, "Coal or Charcoal over Stick → 4 Torches");
});
})();
