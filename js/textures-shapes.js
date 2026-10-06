// Panes / bars / ladders pack: procedural 32px tiles (iron bars, ladder, pane edge strips) and the ladder item sprite.
// Loaded after textures-stone.js; registers painters on the shared kit (BF.texKit) before the atlas is first drawn.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-shapes: BF.texKit missing (textures.js must load first)"); return; }
const { T, SPRITES, TS, hex, pal, mul, mix, ramp, jit, WHITE, put, SPRITE_TILES, WOOD_OAK } = K;

const hexOf = h => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const clearTile = p => p.fill((x, y) => { p.set(x, y, [0, 0, 0], 0); p.setH(x, y, 0); });
// 4px wide cross of strips through the tile centre (cells 14..17): the top/bottom face of a pane post and its arms
const crossStrip = (p, col, a) => {
  clearTile(p);
  p.fill((x, y) => {
    const inV = x >= 14 && x <= 17, inH = y >= 14 && y <= 17;
    if (!inV && !inH) return;
    const e = inV && inH ? 1 : inV ? Math.abs(x - 15.5) : Math.abs(y - 15.5);
    p.set(x, y, e > 1 ? mul(col, 0.8) : jit(p, col, 0.03), a); p.setH(x, y, 0.5);
  });
};

// ---------- glass panes: the face reuses the glass / stained glass tiles, only the thin edge strip is new ----------
T.glass_pane_top = p => crossStrip(p, hex("#b9d4dc"), 255);
for (const [c, col] of BF.DYE_COLOURS) {
  const rgb = hexOf(col);
  T[c + "_stained_glass_pane_top"] = p => crossStrip(p, mix(rgb, WHITE, 0.1), 255);
  SPRITE_TILES.add(c + "_stained_glass_pane_top");
}
SPRITE_TILES.add("glass_pane_top");

// ---------- iron bars ----------
const IRON = pal(["#4c4c52", "#6e6e74", "#8c8c92", "#a8a8ae", "#c6c6cc"]);
T.iron_bars = p => {
  clearTile(p);
  // vertical rods: a 4px centre post (x 14..17, joins every arm) and 2px rods every 8px, plus rods on the cell edge so arms line up with their neighbours
  const rods = [[14, 17], [6, 7], [24, 25], [30, 31], [0, 1]];
  for (const [x0, x1] of rods) for (let x = x0; x <= x1; x++) for (let y = 0; y < TS; y++) {
    const t = (x1 === x0 + 1 ? (x === x0 ? 0.78 : 0.4) : [0.85, 0.65, 0.5, 0.3][x - x0]) + (p.noise(x, y, 4, 8, 410) - 0.5) * 0.2;
    p.set(x, y, jit(p, ramp(IRON, t), 0.04)); p.setH(x, y, 0.5 + t * 0.4);
  }
  // end caps (darker rim) at the top and bottom of each rod
  for (const [x0, x1] of rods) for (let x = x0; x <= x1; x++) for (const y of [0, 1, 30, 31]) { p.set(x, y, mul(p.get(x, y), 0.8)); }
  p.relief(0.8);
};
T.iron_bars_top = p => crossStrip(p, hex("#7c7c82"), 255);
SPRITE_TILES.add("iron_bars"); SPRITE_TILES.add("iron_bars_top");

// ---------- ladder: two wooden rails with rungs, cutout ----------
T.ladder = p => {
  clearTile(p);
  const put1 = (x, y, t, hh) => { p.set(x, y, jit(p, ramp(WOOD_OAK, t + (p.noise(x, y, 8, 8, 420) - 0.5) * 0.3), 0.05)); p.setH(x, y, hh); };
  for (let y = 0; y < TS; y++) {            // rails: x 3..6 and 25..28, lit on the left edge
    for (let x = 3; x <= 6; x++) put1(x, y, [0.75, 0.55, 0.45, 0.25][x - 3], 0.85);
    for (let x = 25; x <= 28; x++) put1(x, y, [0.75, 0.55, 0.45, 0.25][x - 25], 0.85);
  }
  for (const y0 of [2, 10, 18, 26]) for (let y = y0; y < y0 + 3; y++) for (let x = 7; x <= 24; x++) // rungs 3px thick, every 8px
    put1(x, y, y === y0 ? 0.85 : y === y0 + 2 ? 0.2 : 0.55, 0.7);
  p.relief(1.0);
};
SPRITE_TILES.add("ladder");

// item sprite (16x16 grid)
SPRITES.ladder = (G, m) => {
  const hi = mix(m, WHITE, 0.3), lo = mul(m, 0.7);
  for (let y = 1; y <= 14; y++) { put(G, 4, y, hi); put(G, 5, y, m); put(G, 10, y, m); put(G, 11, y, lo); }
  for (const y of [2, 5, 8, 11, 14]) for (let x = 6; x <= 9; x++) put(G, x, y, y === 2 ? hi : m);
};
})();
