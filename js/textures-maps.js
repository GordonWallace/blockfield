// Item sprites for the cartography items: paper, compass, blank maps and the filled map. Painters register on BF.texKit.SPRITES.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
if (!BF.texKit) return;
const { SPRITES, put, hex, mul, mix, lighten, WHITE } = BF.texKit;

// A sheet of paper, slightly rolled at the top left.
SPRITES.paper = (G, m) => {
  const hi = lighten(m, 0.3), lo = mul(m, 0.78), line = mul(m, 0.62);
  for (let y = 2; y <= 13; y++) for (let x = 3; x <= 12; x++) put(G, x, y, x === 12 || y === 13 ? lo : x === 3 || y === 2 ? hi : m);
  for (const [x, y] of [[3, 2], [4, 2], [3, 3]]) put(G, x, y, lo);
  for (let x = 5; x <= 10; x += 1) { put(G, x, 5, line); if (x <= 9) put(G, x, 8, line); if (x <= 8) put(G, x, 11, line); }
};

// Compass: iron ring, dark face, red needle pointing up-right and a pale tail.
SPRITES.compass = (G, m) => {
  const ring = hex("#9a9aa4"), ringHi = hex("#d4d4dc"), ringLo = hex("#5e5e68"), face = hex("#2a2f3a");
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d <= 6.6) put(G, x, y, d > 5.2 ? (x + y < 15 ? ringHi : ringLo) : d > 4.6 ? ring : face);
  }
  put(G, 7, 0, ring); put(G, 8, 0, ring); put(G, 7, 1, ringLo); put(G, 8, 1, ringLo);
  const red = hex("#d83a30"), tail = hex("#e8e8ec");
  for (let i = 0; i < 5; i++) { put(G, 8 + i - (i > 2 ? 0 : 0), 8 - i, red); put(G, 7 + i, 8 - i, mul(red, 0.8)); }
  for (let i = 1; i < 4; i++) { put(G, 7 - i, 8 + i, tail); put(G, 8 - i, 8 + i, mul(tail, 0.8)); }
  put(G, 7, 7, hex("#f0d870")); put(G, 8, 8, hex("#f0d870"));
};

// Maps: parchment with a brown border; the filled one shows land and water.
function sheet(G, filled) {
  const edge = hex("#7a5a30"), edgeLo = hex("#5a4020"), par = hex("#d8c890"), parLo = hex("#c4b078");
  for (let y = 1; y <= 14; y++) for (let x = 2; x <= 13; x++) {
    const border = x === 2 || x === 13 || y === 1 || y === 14;
    put(G, x, y, border ? (x === 13 || y === 14 ? edgeLo : edge) : (x + y) % 6 === 0 ? parLo : par);
  }
  if (!filled) {
    for (const [x, y] of [[5, 5], [6, 5], [7, 6], [9, 8], [10, 8], [8, 10], [6, 10]]) put(G, x, y, mix(par, edge, 0.35));
    return;
  }
  const grass = hex("#5a9a3a"), grassLo = hex("#468a2c"), water = hex("#3f76e4"), sand = hex("#dbd3a0"), rock = hex("#7f7f7f");
  for (let y = 3; y <= 12; y++) for (let x = 4; x <= 11; x++) {
    const n = Math.sin(x * 1.3 + y * 0.7) + Math.cos(y * 1.1 - x * 0.5);
    put(G, x, y, n < -0.9 ? water : n < -0.5 ? sand : n > 1.1 ? rock : (x + y) & 1 ? grass : grassLo);
  }
  put(G, 7, 7, hex("#ffffff")); put(G, 8, 8, hex("#ffffff"));
}
SPRITES.filled_map = G => sheet(G, true);
for (let k = 1; k <= 5; k++) SPRITES["blank_map_" + k] = G => sheet(G, false);
})();
