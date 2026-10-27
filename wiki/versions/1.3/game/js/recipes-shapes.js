// Slab and stairs recipes (vanilla): 3 of a material in a row -> 6 slabs, 6 in a stair pattern -> 4 stairs (mirror allowed by the matcher).
// Wood slabs/stairs need their own species' planks. Wooden slabs burn 7.5 s, wooden stairs 15 s. Registered through BF.recipeHooks.
(() => {
"use strict";
const BF = window.BF;
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, fuel }) => {
  const I = BF.I, nm = s => s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const WOOD = new Set(BF.WOOD_SPECIES.map(sp => (sp === "oak" ? "planks" : sp + "_planks")));
  const slabs = [], stairs = [];
  for (const baseId in BF.SHAPES) {
    const fam = BF.SHAPES[baseId], base = BF.blocks[baseId], slab = fam.slab[0], stair = fam.stairs[0][2];
    const label = nm(base.name);
    addShaped(slab, 6, ["MMM"], { M: +baseId }, "3 " + label + " in a row → 6 " + nm(BF.blocks[slab].name));
    addShaped(stair, 4, ["M  ", "MM ", "MMM"], { M: +baseId }, "6 " + label + " (stair shape) → 4 " + nm(BF.blocks[stair].name));
    if (WOOD.has(base.name)) { slabs.push(slab); stairs.push(stair); }
  }
  fuel(slabs, 7.5, "Wooden slabs");
  fuel(stairs, 15, "Wooden stairs");
});
})();
