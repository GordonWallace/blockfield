// Recipes for the wood/colour pack (dyes, dyeing, concrete powder, glazed terracotta, fences, tinted glass).
// Registered through BF.recipeHooks, which inventory.js calls from buildRecipes with its helpers.
(() => {
"use strict";
const BF = window.BF;
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, addShapeless, smelt, fuel }) => {
  const I = BF.I, names = Object.keys(I), C = BF.DYE_COLOURS.map(c => c[0]);
  const dye = c => I[c + "_dye"];
  const woolOf = c => (c === "white" ? I.white_wool : I[c + "_wool"]);
  const terraOf = c => I[c + "_terracotta"];
  const WOOL = C.map(woolOf);
  const TERRA = [I.terracotta, ...C.map(terraOf)];
  const POWDER = C.map(c => I[c + "_concrete_powder"]);
  const GLASS = [I.glass, ...C.map(c => I[c + "_stained_glass"])];
  const P = names.filter(n => n === "planks" || /_planks$/.test(n)).map(n => I[n]);

  // ---- dyes: sources and vanilla mixing (2 dyes -> 2) ----
  addShapeless(I.bone_meal, 3, [I.bone], "Bone → 3 Bone Meal");
  addShapeless(dye("white"), 1, [I.bone_meal], "Bone Meal → White Dye");
  addShapeless(dye("red"), 1, [I.poppy], "Poppy → Red Dye");
  addShapeless(dye("red"), 1, [I.beetroot], "Beetroot → Red Dye");
  addShapeless(dye("yellow"), 1, [I.dandelion], "Dandelion → Yellow Dye");
  addShapeless(dye("blue"), 1, [I.cornflower], "Cornflower → Blue Dye");
  addShapeless(dye("brown"), 1, [I.brown_mushroom], "Brown Mushroom → Brown Dye");
  addShapeless(dye("black"), 1, [[I.charcoal, I.coal]], "Charcoal or Coal → Black Dye");
  const mix = (out, a, b) => addShapeless(dye(out), 2, [dye(a), dye(b)], nm(a) + " + " + nm(b) + " Dye → 2 " + nm(out) + " Dye");
  const nm = c => c.replace(/_/g, " ").replace(/\b\w/g, x => x.toUpperCase());
  mix("orange", "red", "yellow"); mix("pink", "red", "white"); mix("light_blue", "blue", "white"); mix("purple", "blue", "red");
  mix("lime", "green", "white"); mix("cyan", "blue", "green"); mix("gray", "black", "white"); mix("light_gray", "gray", "white");
  mix("magenta", "purple", "pink");

  // ---- dyeing: dye + 8 of a family in a ring -> 8 of that colour; dye + 1 wool -> that wool ----
  const ring = ["XXX", "XDX", "XXX"];
  for (const c of C) {
    const first = c === "red", D = dye(c);
    addShaped(woolOf(c), 8, ring, { X: WOOL, D }, first ? "Dye + 8 Wool in a ring → 8 Wool of that colour" : undefined);
    addShaped(terraOf(c), 8, ring, { X: TERRA, D }, first ? "Dye + 8 Terracotta in a ring → 8 Terracotta of that colour" : undefined);
    addShaped(I[c + "_concrete_powder"], 8, ring, { X: POWDER, D }, first ? "Dye + 8 Concrete Powder in a ring → 8 of that colour" : undefined);
    addShaped(I[c + "_stained_glass"], 8, ring, { X: GLASS, D }, first ? "Dye + 8 Glass in a ring → 8 Stained Glass of that colour" : undefined);
    addShapeless(woolOf(c), 1, [D, WOOL], first ? "Dye + Wool → Wool of that colour" : undefined);
    addShapeless(I[c + "_concrete_powder"], 8, [D, [I.sand, I.red_sand], [I.sand, I.red_sand], [I.sand, I.red_sand], [I.sand, I.red_sand], I.gravel, I.gravel, I.gravel, I.gravel],
      first ? "Dye + 4 Sand + 4 Gravel → 8 Concrete Powder" : undefined);
    smelt(terraOf(c), I[c + "_glazed_terracotta"]);
  }
  addShaped(I.tinted_glass, 1, [" D ", "DGD", " D "], { D: dye("black"), G: I.glass }, "4 Black Dye around Glass → Tinted Glass");

  // ---- per-species fences (the oak recipe is in inventory.js; each fence takes its own species' planks, as for oak) ----
  for (const sp of BF.WOOD_SPECIES) if (sp !== "oak") {
    const pl = I[sp + "_planks"];
    addShaped(I[sp + "_fence"], 3, ["PSP", "PSP"], { P: pl, S: I.stick }, "Planks, Stick, Planks × 2 rows → 3 " + nm(sp) + " Fence (" + nm(sp) + " Planks)");
  }

  // ---- per-species doors and fence gates (oak's are in inventory.js / shepherd.js). As in Minecraft each takes its own species' planks;
  // sticks are one item whatever wood they were cut from. The recipe book shows the oak line ("... of one wood -> ... of that wood") only.
  for (const sp of BF.WOOD_SPECIES) if (sp !== "oak") {
    const pl = I[sp + "_planks"];
    addShaped(I[sp + "_door"], 3, ["PP", "PP", "PP"], { P: pl });
    addShaped(I[sp + "_fence_gate"], 1, ["SPS", "SPS"], { P: pl, S: I.stick });
  }
  // ---- wood and stripped wood: 4 logs of one species (2x2) -> 3 ----
  for (const sp of BF.WOOD_SPECIES) {
    const first = sp === "oak";
    addShaped(I[sp + "_wood"], 3, ["LL", "LL"], { L: I[sp + "_log"] }, first ? "4 Logs of one wood (2×2) → 3 Wood of that wood" : undefined);
    addShaped(I["stripped_" + sp + "_wood"], 3, ["LL", "LL"], { L: I["stripped_" + sp + "_log"] }, first ? "4 Stripped Logs of one wood (2×2) → 3 Stripped Wood" : undefined);
  }
  fuel(names.filter(n => /_door$/.test(n) && n !== "oak_door").map(n => I[n]), 15, "Other doors");
  fuel(names.filter(n => /_fence_gate$/.test(n) && n !== "oak_fence_gate").map(n => I[n]), 15, "Other fence gates");

  // ---- fuel: fences and wool (logs/woods/planks are covered by inventory.js patterns) ----
  fuel(names.filter(n => /_fence$/.test(n) && n !== "oak_fence").map(n => I[n]), 15, "Other fences");
  fuel(WOOL.filter(id => id !== I.white_wool), 5, "Coloured wool");
});
})();
