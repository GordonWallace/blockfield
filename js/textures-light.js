// Torch tiles (procedural 32px), registered through BF.texKit like textures-stone.js.
//   torch      : model texture. The 2/16-wide post occupies tile columns 14..17: wooden stick on rows 18..31 (y 0..7/16) and the
//                flame on rows 12..17 (y 7..10/16; the top face of the flame box samples rows 14..17). Everything else is transparent.
//                The mesher draws the flame box at full brightness (see world.js, `glow` flag of the torch model).
//   torch_icon : bigger sprite for the inventory / hotbar.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-light: BF.texKit missing (textures.js must load first)"); return; }
const { T, TS, hex, mix, jit, SPRITE_TILES } = K;

const STICK = ["#4e3818", "#6a4e26", "#86663a", "#9c7a48"].map(hex);
const FLAME = ["#e0561a", "#f58a1f", "#ffb62e", "#ffd957", "#fff4b0"].map(hex);
const px = (p, x, y, c, j) => p.set(x, y, jit(p, c, j));

function stick(p, x0, x1, y0, y1) { // vertical post, shaded left light -> right dark
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const e = x === x0 ? 3 : x === x1 ? 0 : (y + x) % 3 === 0 ? 1 : 2;
    px(p, x, y, STICK[e], 0.04);
  }
}
function flame(p, x0, x1, y0, y1) { // glowing tip: hot white-yellow core, orange edges, darker base
  const cx = (x0 + x1) / 2, h = y1 - y0 + 1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = Math.abs(x - cx) / ((x1 - x0) / 2 + 0.5), t = 1 - (y - y0) / h;           // t: 1 at the top row, 0 at the bottom
    const heat = Math.max(0, Math.min(1, 0.95 - dx * 0.6 - (1 - t) * 0.55 + (p.rand() - 0.5) * 0.18));
    const i = heat * (FLAME.length - 1), a = Math.floor(i);
    px(p, x, y, mix(FLAME[a], FLAME[Math.min(FLAME.length - 1, a + 1)], i - a), 0.02);
  }
}
T.torch = p => {
  p.clear();
  stick(p, 14, 17, 18, 31);
  flame(p, 14, 17, 12, 17);
};
T.torch_icon = p => { // 32px sprite, slightly tilted like the inventory torches
  p.clear();
  for (let y = 12; y <= 30; y++) { const o = Math.round((30 - y) * 0.12); stick(p, 14 + o, 17 + o, y, y); }
  flame(p, 14 + 3, 17 + 3, 5, 11);
  for (let y = 4; y <= 12; y++) for (let x = 12; x <= 22; x++) if (p.a(x, y) === 0) { // soft glow halo around the flame
    const d = Math.hypot(x - 18, y - 8);
    if (d < 5.2 && d > 3) p.set(x, y, FLAME[1], 70);
  }
};
SPRITE_TILES.add("torch"); SPRITE_TILES.add("torch_icon");
})();
