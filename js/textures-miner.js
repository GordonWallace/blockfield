// Miner pack tiles (procedural 32px, not vanilla): the miner's mining bench, a stone-topped spruce bench with an iron pickaxe and lumps of
// coal on top and an ore crate built into its front. Registered on BF.texKit before the atlas is first drawn (loaded after textures-jobs.js).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-miner: BF.texKit missing (textures.js must load first)"); return; }
const { T, TS, hex, pal, mix, ramp, jit, planksBase, stoneBase, cobbleBase, WOOD_SPRUCE } = K;

const IRON = pal(["#3a3a40", "#55555c", "#707078", "#8e8e96", "#b0b0b8"]);
const COAL = pal(["#101012", "#1c1c20", "#28282c", "#3a3a40", "#4a4a50"]);
const ORE = pal(["#8a6a50", "#a07a5a", "#b88c66", "#d0a078", "#e2b48a"]);
function rect(p, x0, y0, x1, y1, col, h = 0.6, j = 0.05) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { p.set(x, y, jit(p, typeof col === "function" ? col(x, y) : col, j)); p.setH(x, y, h); }
}
const line = (p, x0, y0, x1, y1, c, h = 0.95, w = 1) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= n; s++) {
    const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n);
    for (let k = 0; k < w; k++) { const c2 = typeof c === "function" ? c(s / n) : hex(c); p.set(x + k, y, c2); p.setH(x + k, y, h); }
  }
};
const lump = (p, cx, cy, r, cols, salt) => {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    const d = Math.hypot(x - cx, y - cy) + (p.noise(x, y, 4, 2, salt) - 0.5) * 1.2;
    if (d > r) continue;
    p.set(x, y, jit(p, ramp(cols, 0.85 - d / r * 0.6), 0.05)); p.setH(x, y, 1 - d / r * 0.4);
  }
};

// top: a smooth stone slab with an iron pickaxe lying across it and three lumps of coal
T.mining_bench_top = p => {
  stoneBase(p, undefined, 41);
  rect(p, 0, 0, TS - 1, 1, hex("#4a4a4c"), 0.3, 0.03); rect(p, 0, TS - 2, TS - 1, TS - 1, hex("#4a4a4c"), 0.3, 0.03);
  line(p, 7, 26, 22, 11, () => jit(p, ramp(WOOD_SPRUCE, 0.7), 0.05), 0.9, 2);          // handle
  for (let k = -7; k <= 7; k++) {                                                       // head: a curved bar across the handle's end
    const x = 22 + Math.round(k * 0.72) + 1, y = 11 + Math.round(k * 0.72) - Math.round((k * k) / 14);
    p.set(x, y, jit(p, ramp(IRON, 0.55 + (Math.abs(k) > 5 ? -0.2 : 0.1)), 0.03)); p.setH(x, y, 1);
    p.set(x, y + 1, jit(p, ramp(IRON, 0.35), 0.03)); p.setH(x, y + 1, 0.95);
  }
  lump(p, 7, 8, 2.6, COAL, 300); lump(p, 11, 5, 2.0, COAL, 301); lump(p, 25, 25, 2.4, ORE, 302);
  p.relief(1.0);
};
// side: a spruce frame around a cobblestone panel
T.mining_bench_side = p => {
  cobbleBase(p, { count: 22 });
  rect(p, 0, 0, TS - 1, 4, (x, y) => ramp(WOOD_SPRUCE, 0.75 - y * 0.08 + p.noise(x, y, 8, 2, 310) * 0.2), 0.9, 0.04);
  for (const x0 of [0, TS - 4]) rect(p, x0, 5, x0 + 3, TS - 1, (x) => mix(ramp(WOOD_SPRUCE, 0.45), hex("#24190e"), x === x0 + 3 || x === x0 ? 0.35 : 0.05), 0.85, 0.04);
  rect(p, 4, TS - 3, TS - 5, TS - 1, (x, y) => ramp(WOOD_SPRUCE, 0.4 + p.noise(x, y, 8, 2, 311) * 0.2), 0.8, 0.04);
  p.relief(1.1);
};
// front: the side with an open ore crate: coal and iron ore lumps behind a dark opening
T.mining_bench_front = p => {
  T.mining_bench_side(p);
  rect(p, 6, 9, TS - 7, TS - 6, hex("#17120c"), 0.15, 0.04);
  lump(p, 10, 22, 3, COAL, 320); lump(p, 16, 21, 3.2, ORE, 321); lump(p, 22, 22, 3, COAL, 322); lump(p, 13, 16, 2.4, ORE, 323); lump(p, 20, 15, 2.2, COAL, 324);
  rect(p, 5, 8, TS - 6, 8, hex("#24190e"), 0.9, 0.02);
  p.relief(1.0);
};
})();
