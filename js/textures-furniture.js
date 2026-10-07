// Furniture pack tiles (procedural 32px, not vanilla): the furniture maker's carpentry bench, an oak workbench with a bench vice, a hand saw
// and a roll of red wool. Registered on BF.texKit before the atlas is first drawn (loaded after textures-jobs.js).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-furniture: BF.texKit missing (textures.js must load first)"); return; }
const { T, TS, hex, pal, mix, ramp, jit, planksBase, WOOD_OAK } = K;

const IRON = pal(["#3a3a40", "#55555c", "#707078", "#8e8e96", "#b0b0b8"]);
const RED = pal(["#6a1414", "#8a1e1e", "#a82828", "#c03838", "#d04a4a"]);
function rect(p, x0, y0, x1, y1, col, h = 0.6, j = 0.05) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { p.set(x, y, jit(p, typeof col === "function" ? col(x, y) : col, j)); p.setH(x, y, h); }
}
const line = (p, x0, y0, x1, y1, c, h = 0.95) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= n; s++) { const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n); p.set(x, y, hex(c)); p.setH(x, y, h); }
};

// top: worn oak boards, a pencil line and a few shavings; a red wool roll lies along the back edge
T.carpentry_bench_top = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  for (let x = 2; x < TS - 2; x++) for (let y = 3; y <= 8; y++) {          // the wool roll
    const t = 0.25 + 0.6 * Math.sin(Math.PI * (y - 2.5) / 7) + (p.noise(x, y, 8, 4, 270) - 0.5) * 0.25;
    p.set(x, y, jit(p, ramp(RED, t), 0.03)); p.setH(x, y, 0.6 + 0.4 * Math.sin(Math.PI * (y - 2.5) / 7));
  }
  for (let y = 3; y <= 8; y++) p.blend(2, y, hex("#4a0e0e"), 0.5);
  line(p, 5, 24, 26, 20, "#2a2a30", 0.75);                                   // pencil line
  for (const [x, y] of [[9, 14], [13, 17], [20, 13], [24, 26], [7, 28]]) { p.set(x, y, hex("#e0c890")); p.set(x + 1, y, hex("#d0b480")); p.setH(x, y, 0.9); }   // shavings
  p.relief(1.0);
};
// side: oak boards with a darker apron rail and two legs
T.carpentry_bench_side = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  rect(p, 0, 0, TS - 1, 4, (x, y) => ramp(WOOD_OAK, 0.75 - y * 0.08 + p.noise(x, y, 8, 2, 271) * 0.2), 0.9, 0.04);
  rect(p, 0, 5, TS - 1, 6, hex("#3d2c18"), 0.2, 0.03);
  for (const x0 of [2, TS - 6]) rect(p, x0, 7, x0 + 3, TS - 1, (x, y) => mix(ramp(WOOD_OAK, 0.3), hex("#3d2c18"), x === x0 + 3 ? 0.5 : 0.1), 0.8, 0.04);
  p.relief(1.1);
};
// front: the side plus an iron bench vice with its screw handle, and a hand saw hanging below
T.carpentry_bench_front = p => {
  T.carpentry_bench_side(p);
  rect(p, 11, 1, 20, 6, (x) => ramp(IRON, 0.35 + (x % 3) * 0.15), 1, 0.03);  // vice jaw
  rect(p, 15, 7, 16, 11, hex("#8e8e96"), 1, 0.02);                            // screw
  rect(p, 12, 11, 19, 12, hex("#b0b0b8"), 1, 0.02);                           // handle
  for (let y = 15; y <= 24; y++) for (let x = 9; x <= 22; x++) {              // saw blade (a tapering triangle)
    if (x - 9 > (y - 15) * 1.4 + 3) continue;
    p.set(x, y, jit(p, ramp(IRON, 0.55 + (y === 24 ? -0.2 : 0)), 0.03)); p.setH(x, y, 0.95);
  }
  for (let x = 9; x <= 13; x += 2) p.set(x, 24, hex("#3a3a40"));
  rect(p, 20, 14, 23, 17, hex("#6b3a1a"), 1, 0.04);                           // saw handle
  p.relief(1.0);
};
})();
