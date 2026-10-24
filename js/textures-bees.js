// Bees pack tiles and sprites (procedural 32px tiles, 16px item sprites), registered on BF.texKit before the atlas is first drawn (loaded after
// textures-jobs.js). Faithful has none of these, so they are drawn in the style of the game's own blocks:
//   bee_nest_*        : a straw-gold nest with dark comb holes, a slot entrance in the front
//   beehive_*         : plank box with a honey-gold band and an entrance slot, comb-patterned top
//   honey_extractor_* : the beekeeper's jobsite (not vanilla): an oak drum with iron hoops and a crank on the front
//   candle, candle_top: model textures. The wax (box x 6..10/16, y 0..6/16) is on rows 20..31, columns 12..19; the flame box (x 7.5..8.5,
//                       y 6..8.5) samples rows 15..19, columns 15..16, and is drawn at full brightness (world.js `glow`)
//   candle_icon       : the inventory sprite
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-bees: BF.texKit missing (textures.js must load first)"); return; }
const { T, SPRITES, TS, hex, pal, mix, ramp, jit, planksBase, SPRITE_TILES, WOOD_OAK } = K;

const STRAW = pal(["#8a6420", "#a87c2a", "#c49634", "#d8ac44", "#e8c25a"]);
const HONEY = pal(["#a85e08", "#c87810", "#e0961c", "#f0b02a", "#f8c848"]);
const IRON = pal(["#3a3a40", "#55555c", "#707078", "#8e8e96", "#b0b0b8"]);
const rect = (p, x0, y0, x1, y1, col, h = 0.6, j = 0.05) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { p.set(x, y, jit(p, typeof col === "function" ? col(x, y) : col, j)); p.setH(x, y, h); }
};
// straw layers: horizontal bands of woven straw
function straw(p, salt) {
  p.fill((x, y) => {
    const band = Math.floor(y / 4), weave = ((x + band * 2) % 6) < 3 ? 0.12 : -0.05;
    const t = 0.45 + weave + (p.noise(x, y, 8, 2, salt) - 0.5) * 0.5 - (y % 4 === 3 ? 0.3 : 0);
    p.set(x, y, jit(p, ramp(STRAW, t), 0.05)); p.setH(x, y, y % 4 === 3 ? 0.2 : 0.7);
  });
}
// comb cells: small dark hexagon-ish holes in a grid
function combHoles(p, x0, y0, x1, y1, dark) {
  for (let y = y0; y <= y1; y += 4) for (let x = x0 + ((y - y0) / 4 % 2 ? 2 : 0); x <= x1; x += 4) {
    p.set(x, y, jit(p, hex(dark), 0.05)); p.set(x + 1, y, jit(p, hex(dark), 0.05)); p.setH(x, y, 0); p.setH(x + 1, y, 0);
  }
}

// ---------- bee nest ----------
T.bee_nest_side = p => { straw(p, 401); combHoles(p, 3, 6, 28, 26, "#5a3a10"); p.relief(1.2); };
T.bee_nest_front = p => {
  straw(p, 402);
  rect(p, 10, 14, 21, 17, hex("#24160a"), 0);   // the entrance slot
  rect(p, 9, 18, 22, 19, ramp(STRAW, 0.85), 0.9);
  p.relief(1.2);
};
T.bee_nest_top = p => {
  p.fill((x, y) => { const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16); p.set(x, y, jit(p, ramp(STRAW, 0.7 - d / 40 + (p.noise(x, y, 8, 2, 403) - 0.5) * 0.3), 0.05)); p.setH(x, y, 0.6); });
  combHoles(p, 6, 6, 25, 25, "#7a5216");
  p.relief(1.1);
};
T.bee_nest_bottom = p => { T.bee_nest_top(p); };

// ---------- beehive ----------
T.beehive_side = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  rect(p, 0, 12, TS - 1, 15, (x, y) => ramp(HONEY, 0.4 + p.noise(x, y, 8, 2, 411) * 0.4), 0.8, 0.04);   // a honey-gold band
  p.relief(1.2);
};
T.beehive_front = p => {
  T.beehive_side(p);
  rect(p, 11, 18, 20, 20, hex("#20140a"), 0);   // the entrance slot
  p.relief(1.0);
};
T.beehive_top = p => {
  p.fill((x, y) => { p.set(x, y, jit(p, ramp(HONEY, 0.5 + (p.noise(x, y, 8, 2, 412) - 0.5) * 0.5), 0.05)); p.setH(x, y, 0.6); });
  combHoles(p, 3, 3, 28, 28, "#7a4408");
  for (let i = 0; i < TS; i++) for (const e of [0, 1, TS - 2, TS - 1]) { p.set(i, e, jit(p, ramp(WOOD_OAK, 0.4), 0.05)); p.set(e, i, jit(p, ramp(WOOD_OAK, 0.4), 0.05)); }
  p.relief(1.1);
};
T.beehive_bottom = p => { planksBase(p, WOOD_OAK, "#3d2c18"); p.relief(1.2); };

// ---------- honey extractor (beekeeper, not vanilla) ----------
const hoop = (p, y0, y1) => rect(p, 0, y0, TS - 1, y1, (x, y) => ramp(IRON, y === y0 ? 0.8 : 0.35), 0.9, 0.03);
T.honey_extractor_side = p => { planksBase(p, WOOD_OAK, "#3d2c18"); hoop(p, 3, 5); hoop(p, 26, 28); p.relief(1.2); };
T.honey_extractor_front = p => {
  T.honey_extractor_side(p);
  rect(p, 15, 10, 16, 21, ramp(IRON, 0.6), 1, 0.02);      // the crank's shaft
  rect(p, 15, 10, 22, 11, ramp(IRON, 0.75), 1, 0.02);     // its arm
  rect(p, 21, 12, 22, 15, ramp(WOOD_OAK, 0.2), 1, 0.03);  // its handle
  rect(p, 12, 23, 19, 25, ramp(HONEY, 0.6), 0.8, 0.04);   // a honey spout dripping
  p.relief(1.0);
};
T.honey_extractor_top = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
    if (d > 13) continue;
    p.set(x, y, jit(p, d > 11.5 ? ramp(IRON, 0.6) : ramp(HONEY, 0.35 + (13 - d) / 30), 0.04)); p.setH(x, y, d > 11.5 ? 0.9 : 0.2);
  }
  p.relief(1.1);
};

// ---------- candle ----------
const WAX = pal(["#c8b07a", "#dcc48e", "#e8d4a4", "#f2e2ba", "#faf0d2"]);
const FLAME = ["#e0561a", "#f58a1f", "#ffb62e", "#ffd957", "#fff4b0"].map(hex);
const flamePx = (p, x, y, t) => p.set(x, y, jit(p, FLAME[Math.max(0, Math.min(4, Math.round(t * 4)))], 0.02));
T.candle = p => {
  p.clear();
  for (let y = 20; y <= 31; y++) for (let x = 12; x <= 19; x++) p.set(x, y, jit(p, ramp(WAX, x === 12 ? 0.9 : x === 19 ? 0.15 : 0.55 - (y - 20) * 0.02), 0.03));
  for (let y = 15; y <= 19; y++) for (let x = 15; x <= 16; x++) flamePx(p, x, y, y === 19 ? 0.15 : 1 - (y - 15) * 0.18);
};
T.candle_top = p => {
  p.clear();
  for (let y = 12; y <= 19; y++) for (let x = 12; x <= 19; x++) p.set(x, y, jit(p, ramp(WAX, 0.75), 0.03));
  for (let y = 15; y <= 16; y++) for (let x = 15; x <= 16; x++) flamePx(p, x, y, 0.9);
};
T.candle_icon = p => {
  p.clear();
  for (let y = 14; y <= 29; y++) for (let x = 12; x <= 19; x++) p.set(x, y, jit(p, ramp(WAX, x <= 13 ? 0.95 : x >= 18 ? 0.2 : 0.6), 0.03));
  for (let y = 12; y <= 13; y++) p.set(16, y, hex("#3a2a1a"));   // the wick
  for (let y = 5; y <= 11; y++) for (let x = 14; x <= 18; x++) {
    const t = 1 - Math.abs(x - 16) / 3 - (y - 5) / 12;
    if (t > 0.1) flamePx(p, x, y, t);
  }
};
SPRITE_TILES.add("candle"); SPRITE_TILES.add("candle_top"); SPRITE_TILES.add("candle_icon");

// ---------- item sprites (16px grid) ----------
if (SPRITES) {
  const { put } = K;
  SPRITES.honeycomb = G => {   // a cluster of gold comb cells
    const C = [hex("#b86a08"), hex("#e0961c"), hex("#f8c848"), hex("#7a4408")];
    for (let y = 3; y <= 12; y++) for (let x = 2; x <= 13; x++) {
      if (Math.hypot((x + 0.5 - 8) / 6.2, (y + 0.5 - 8) / 5.2) > 1) continue;
      const cx = x % 3, cy = (y + (Math.floor(x / 3) % 2)) % 3;
      put(G, x, y, cx === 0 || cy === 0 ? C[0] : cx === 1 && cy === 1 ? C[2] : C[1]);
    }
    put(G, 5, 6, C[3]); put(G, 9, 9, C[3]);
  };
  SPRITES.honey_bottle = G => {   // a round bottle of honey with a cork
    const glass = hex("#c8dce4"), rim = hex("#8fb4c4"), hi = hex("#f4fbff"), cork = hex("#9a6a3a"), corkD = hex("#6e4826"), honey = hex("#f0a020"), honeyD = hex("#c87810");
    for (let y = 1; y <= 3; y++) for (let x = 6; x <= 9; x++) put(G, x, y, x === 6 || y === 1 ? cork : corkD);
    for (let y = 4; y <= 6; y++) for (let x = 6; x <= 9; x++) put(G, x, y, x === 6 || x === 9 ? rim : y >= 6 ? honey : glass);
    for (let y = 7; y <= 14; y++) for (let x = 2; x <= 13; x++) {
      const d = Math.hypot((x + 0.5 - 8) / 6, (y + 0.5 - 10.8) / 4.4);
      if (d > 1) continue;
      put(G, x, y, d > 0.82 ? rim : y >= 12 ? honeyD : honey);
    }
    put(G, 4, 9, hi); put(G, 4, 10, hi); put(G, 5, 8, hi); put(G, 7, 5, hi);
  };
}
})();
