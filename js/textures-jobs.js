// Jobsite pack tiles (procedural 32px, vanilla texture names where vanilla has one): composter, lectern, brewing stand, blast furnace,
// grindstone, smithing table, smoker, barrel, loom, fletching table, stonecutter, cauldron, cartography table and the builder's
// drafting table (not vanilla). Registered on BF.texKit before the atlas is first drawn (loaded after textures-shapes.js).
// Box-model blocks (lectern, brewing stand, grindstone, stonecutter, cauldron) sample each tile at the box's position in the cell:
// row 0 is the top of the block (y = 16/16), row 31 the bottom; columns follow x (or z) in 1/16 * 2.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-jobs: BF.texKit missing (textures.js must load first)"); return; }
const { T, ICON_T, TS, hex, pal, mul, mix, ramp, jit, WHITE, lighten, smoothBase, frame, planksBase, cobbleBase, bricks, SPRITE_TILES, WOOD_OAK, WOOD_SPRUCE } = K;

const BIRCH = pal(["#a8975e", "#b8a66c", "#c4b37a", "#cfbf88", "#d8ca96"]);
const DARK_OAK = pal(["#2e1f0f", "#38270f", "#432f16", "#4e381c", "#5a4224"]);
const SMITH_W = pal(["#2a1e22", "#33252a", "#3d2d31", "#47353a", "#513e43"]);
const IRON = pal(["#3a3a40", "#55555c", "#707078", "#8e8e96", "#b0b0b8"]);
const STONE_G = ["#5f5f60", "#6c6c6c", "#7a7a79", "#878786", "#949493"];
const DSTONE = ["#3a3a3c", "#454547", "#505052", "#5b5b5d", "#666668"];

// fill rows/cols inclusive with a colour (array or palette+t), height h
function rect(p, x0, y0, x1, y1, col, h = 0.6, j = 0.05) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { p.set(x, y, jit(p, typeof col === "function" ? col(x, y) : col, j)); p.setH(x, y, h); }
}
// vertical boards (staves): width w, dark seam on the right edge of each board
function vboards(p, cols, w, seam, y0 = 0, y1 = TS - 1) {
  const g = hex(seam);
  for (let x = 0; x < TS; x++) {
    const b = Math.floor(x / w), tone = (K.ihash(b, p.seed, 5) - 0.5) * 0.3;
    for (let y = y0; y <= y1; y++) {
      if (x % w === w - 1) { p.set(x, y, jit(p, g, 0.08)); p.setH(x, y, 0); continue; }
      const grain = p.noise(x, y, 16, 2, 140 + b), fine = p.noise(x, y, 32, 4, 150 + b);
      let t = 0.45 + tone + (grain - 0.5) * 0.9 + (fine - 0.5) * 0.4;
      if (Math.abs(fine - 0.5) < 0.03) t -= 0.25;
      p.set(x, y, jit(p, ramp(cols, t), 0.04)); p.setH(x, y, 0.7 + grain * 0.15 - (x % w === 0 ? 0 : 0.05));
    }
  }
}
const band = (p, y0, y1, cols, h = 0.85) => rect(p, 0, y0, TS - 1, y1, (x, y) => ramp(cols, y === y0 ? 0.85 : y === y1 ? 0.15 : 0.45 + p.noise(x, y, 8, 2, 160) * 0.3), h, 0.04);
const rivet = (p, x, y) => { p.set(x, y, hex("#c8c8d0")); p.set(x + 1, y + 1, hex("#3a3a40")); p.setH(x, y, 1); };
function circle(p, cx, cy, r, fn) { for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= r) fn(x, y, d); } }
const clearTile = p => p.fill((x, y) => { p.set(x, y, [0, 0, 0], 0); p.setH(x, y, 0); });

// ---------- composter (farmer) ----------
T.composter_side = p => { vboards(p, WOOD_OAK, 8, "#3d2c18"); band(p, 0, 2, WOOD_SPRUCE); band(p, 29, 31, WOOD_SPRUCE); p.relief(1.3); };
T.composter_top = p => {
  const C = pal(["#2c1e10", "#3a2814", "#4a341c", "#5a4224", "#6a5030"]);
  p.fill((x, y) => { const n = p.fbm(x, y, 4, 3, 170); p.set(x, y, jit(p, ramp(C, n * 0.8 + (p.rand() - 0.5) * 0.2), 0.08)); p.setH(x, y, n * 0.5); });
  for (let i = 0; i < 26; i++) { const x = 4 + p.ri(24), y = 4 + p.ri(24); p.set(x, y, hex(p.rand() < 0.6 ? "#4a7a2a" : "#8a6a2a")); p.setH(x, y, 0.8); }
  frame(p, 3, "#5a4224", "#94734a");
  p.relief(1.2, 0.3);
};
T.composter_bottom = p => { planksBase(p, WOOD_OAK, "#3d2c18"); p.relief(1.3); };

// ---------- lectern (librarian): board rows 0-7 (y 12-16), post rows 8-27, base rows 28-31 ----------
T.lectern_base = p => { planksBase(p, WOOD_SPRUCE, "#2a1e10"); p.relief(1.2); };
T.lectern_side = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  vboards(p, WOOD_SPRUCE, 8, "#2a1e10", 8, 27);
  band(p, 0, 3, WOOD_OAK); band(p, 4, 7, WOOD_SPRUCE);
  band(p, 28, 31, WOOD_SPRUCE);
  p.relief(1.3);
};
T.lectern_front = p => {
  T.lectern_side(p);
  const books = ["#8a2a2a", "#2a4a8a", "#2a7a3a", "#7a4a1a", "#6a2a7a", "#c8a030"].map(hex);
  for (const [y0, y1] of [[10, 16], [19, 25]]) {
    rect(p, 8, y0, 23, y1, hex("#2a2016"), 0.05, 0.1);
    for (let x = 8; x <= 23;) { const w = 2 + p.ri(2), c = p.pick(books), top = y0 + p.ri(2); rect(p, x, top, Math.min(23, x + w - 1), y1, c, 0.7, 0.05); x += w; }
  }
  p.relief(0.8);
};
T.lectern_top = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  frame(p, 2, "#5a4224", "#a08053");
  // open book on the raised desk (rows 12-20: inside the raised part whichever way the top face maps z)
  rect(p, 4, 11, 27, 21, hex("#5a2a1a"), 0.8, 0.04);
  rect(p, 5, 12, 15, 20, hex("#efe8d4"), 0.9, 0.03); rect(p, 16, 12, 26, 20, hex("#e6dfca"), 0.9, 0.03);
  for (let y = 13; y <= 19; y += 2) { rect(p, 6, y, 13, y, hex("#9a9284"), 0.85, 0.05); rect(p, 18, y, 25, y, hex("#9a9284"), 0.85, 0.05); }
  rect(p, 15, 12, 16, 20, hex("#b8ae98"), 0.7, 0.02);
  p.relief(1.0);
};

// ---------- brewing stand (cleric): base rows 28-31, bottles rows 13-27 ----------
T.brewing_stand_top = p => { cobbleBase(p, { count: 30, cols: pal(DSTONE) }); p.relief(1.2); };
T.brewing_stand_side = p => {
  p.fill((x, y) => { p.set(x, y, jit(p, mix(hex("#b8d4e0"), WHITE, 0.2), 0.03)); p.setH(x, y, 0.6); });
  const liq = [hex("#7a3ab8"), hex("#c03040"), hex("#3a6ad0"), hex("#7a3ab8")];
  for (let y = 18; y <= 27; y++) for (let x = 0; x < TS; x++) { const c = liq[Math.floor(x / 8)]; p.set(x, y, jit(p, mix(c, WHITE, (27 - y) * 0.02), 0.05)); }
  for (let x = 0; x < TS; x++) { p.set(x, 13, hex("#8a6a3a")); p.set(x, 14, hex("#a07a48")); } // corks
  for (let y = 13; y <= 27; y++) for (const x of [0, 7, 8, 15, 16, 23, 24, 31]) p.scale(x, y, 0.75);
  rect(p, 0, 28, 31, 31, (x, y) => ramp(pal(DSTONE), 0.3 + p.noise(x, y, 8, 4, 180) * 0.5), 0.7);
  p.relief(0.8);
};
T.brewing_stand_rod = p => {
  const C = pal(["#a8501a", "#d07a1a", "#eea52a", "#ffd050", "#fff0a0"]);
  p.fill((x, y) => { const t = 0.5 + 0.35 * Math.sin((x % 4) / 4 * Math.PI * 2) + p.noise(x, y, 4, 16, 190) * 0.2; p.set(x, y, jit(p, ramp(C, t), 0.04)); p.setH(x, y, t); });
  p.relief(0.8);
};
ICON_T.brewing_stand = p => {
  clearTile(p);
  const rod = pal(["#a8501a", "#eea52a", "#fff0a0"]);
  rect(p, 15, 3, 16, 25, (x) => rod[x === 15 ? 2 : 1], 0.8, 0.04);
  rect(p, 4, 26, 27, 29, (x, y) => ramp(pal(DSTONE), 0.3 + (y === 26 ? 0.5 : 0)), 0.8, 0.05);
  const bottle = (cx, cy, c) => {
    circle(p, cx, cy, 4.2, (x, y, d) => { p.set(x, y, d > 3.3 ? hex("#dfeef4") : jit(p, mix(c, WHITE, y < cy - 1 ? 0.35 : 0), 0.05)); p.setH(x, y, 0.8); });
    rect(p, cx - 1, cy - 7, cx, cy - 4, hex("#dfeef4"), 0.8, 0.02); rect(p, cx - 1, cy - 8, cx, cy - 8, hex("#8a6a3a"), 0.8, 0.02);
  };
  bottle(7, 20, hex("#7a3ab8")); bottle(25, 20, hex("#c03040")); bottle(16, 14, hex("#3a6ad0"));
};

// ---------- blast furnace (armorer) ----------
T.blast_furnace_top = p => { smoothBase(p, DSTONE, 0.4, 10); frame(p, 3, "#3a3a3e", "#8a8a92"); rect(p, 10, 10, 21, 21, hex("#1a1a1c"), 0.1, 0.05); p.relief(1.3); };
T.blast_furnace_side = p => {
  bricks(p, { bw: 16, bh: 8, mortar: 1, offset: 8, cols: pal(STONE_G), mortarCol: hex("#3e3e3e"), bevel: 2, vary: 0.4, bias: 0.1 });
  band(p, 0, 3, IRON); band(p, 28, 31, IRON);
  for (const x of [3, 15, 27]) { rivet(p, x, 1); rivet(p, x, 29); }
  p.relief(1.3);
};
T.blast_furnace_front = p => {
  T.blast_furnace_side(p);
  rect(p, 6, 8, 25, 26, hex("#2a2a2e"), 0.9, 0.04);
  for (let y = 10; y <= 24; y++) for (let x = 8; x <= 23; x++) {
    const bar = x % 3 === 1;
    p.set(x, y, bar ? jit(p, hex("#6a6a72"), 0.05) : mix(hex("#0e0c0a"), hex("#ff7a1a"), Math.max(0, (y - 16) / 9) * 0.8)); p.setH(x, y, bar ? 0.9 : 0.05);
  }
  p.relief(1.2);
};

// ---------- grindstone (weaponsmith): wheel faces x (side tile), rolling surface on top ----------
T.grindstone_side = p => {
  smoothBase(p, STONE_G, 0.4, 14);
  circle(p, 16, 12, 12, (x, y, d) => { if (d > 10.6) { p.set(x, y, mul(p.get(x, y), 0.72)); p.setH(x, y, 0.2); } });
  circle(p, 16, 12, 2.6, (x, y) => { p.set(x, y, hex("#3a2c1c")); p.setH(x, y, 1); });
  p.relief(1.2);
};
T.grindstone_round = p => {
  smoothBase(p, STONE_G, 0.4, 10);
  for (let y = 0; y < TS; y += 4) for (let x = 0; x < TS; x++) { p.scale(x, y, 0.82); p.setH(x, y, 0.2); }
  p.relief(1.1);
};
T.grindstone_leg = p => { vboards(p, DARK_OAK, 4, "#1a120a"); p.relief(1.1); };

// ---------- smithing table (toolsmith) ----------
T.smithing_table_top = p => {
  smoothBase(p, ["#202024", "#28282c", "#303034", "#38383c", "#404044"], 0.3, 12);
  frame(p, 2, "#5a5a62", "#a0a0a8");
  for (const [x, y] of [[3, 3], [27, 3], [3, 27], [27, 27]]) rivet(p, x, y);
  p.relief(1.2);
};
T.smithing_table_bottom = p => { planksBase(p, SMITH_W, "#1a1214"); p.relief(1.1); };
T.smithing_table_side = p => {
  planksBase(p, SMITH_W, "#1a1214");
  band(p, 0, 4, IRON); band(p, 27, 31, SMITH_W.map(c => mul(c, 0.8)));
  rivet(p, 4, 1); rivet(p, 26, 1);
  p.relief(1.2);
};
T.smithing_table_front = p => {
  T.smithing_table_side(p);
  const m = hex("#b8b8c0"), h = hex("#6a4a2a");
  rect(p, 7, 9, 16, 12, m, 1, 0.04); rect(p, 11, 13, 12, 23, h, 1, 0.04);   // hammer
  rect(p, 20, 9, 22, 22, m, 1, 0.04); rect(p, 19, 22, 23, 24, h, 1, 0.04);  // chisel
  p.relief(1.0);
};

// ---------- smoker (butcher) ----------
T.smoker_bottom = p => { smoothBase(p, STONE_G, 0.4, 8); p.relief(1.1); };
T.smoker_top = p => { smoothBase(p, STONE_G, 0.4, 10); frame(p, 4, "#3a2818", "#6a4a28"); rect(p, 11, 11, 20, 20, hex("#1c1814"), 0.1, 0.06); p.relief(1.3); };
T.smoker_side = p => {
  vboards(p, pal(["#2a1e12", "#3a2a18", "#4a3620", "#584228", "#664e30"]), 6, "#1a120a", 12, 31);
  rect(p, 0, 0, 31, 11, (x, y) => ramp(pal(STONE_G), 0.3 + p.noise(x, y, 6, 3, 200) * 0.5), 0.7, 0.05);
  band(p, 10, 12, IRON);
  p.relief(1.3);
};
T.smoker_front = p => {
  T.smoker_side(p);
  rect(p, 7, 15, 24, 28, hex("#2a2420"), 0.9, 0.04);
  for (let y = 17; y <= 26; y++) for (let x = 9; x <= 22; x++) {
    const bar = y % 3 === 0;
    p.set(x, y, bar ? jit(p, hex("#5a5a60"), 0.05) : mix(hex("#100c0a"), hex("#ff8a2a"), Math.max(0, (y - 20) / 7) * 0.7)); p.setH(x, y, bar ? 0.9 : 0.05);
  }
  p.relief(1.2);
};

// ---------- barrel (fisherman) ----------
T.barrel_side = p => { vboards(p, WOOD_SPRUCE, 6, "#2a1e10"); band(p, 5, 7, IRON); band(p, 24, 26, IRON); p.relief(1.3); };
T.barrel_top = p => {
  planksBase(p, WOOD_SPRUCE, "#2a1e10");
  frame(p, 3, "#4a4a52", "#9a9aa2");
  rect(p, 12, 12, 19, 19, hex("#3a2a18"), 0.3, 0.05); rect(p, 14, 14, 17, 17, hex("#1a120a"), 0.05, 0.05);
  p.relief(1.3);
};
T.barrel_bottom = p => { planksBase(p, WOOD_SPRUCE, "#2a1e10"); frame(p, 3, "#4a4a52", "#9a9aa2"); p.relief(1.3); };

// ---------- loom (shepherd) ----------
T.loom_bottom = p => { planksBase(p, BIRCH, "#6a5a38"); p.relief(1.2); };
T.loom_top = p => {
  planksBase(p, BIRCH, "#6a5a38");
  frame(p, 2, "#7a6440", "#d8ca96");
  circle(p, 16, 16, 6, (x, y, d) => { p.set(x, y, jit(p, mix(hex("#e8e8e4"), hex("#b8b8b0"), (Math.sin(d * 2.2) + 1) / 2 * 0.6), 0.03)); p.setH(x, y, 1 - d / 8); }); // yarn spool
  p.relief(1.2);
};
T.loom_side = p => {
  planksBase(p, BIRCH, "#6a5a38");
  band(p, 0, 3, WOOD_OAK); band(p, 28, 31, WOOD_OAK);
  for (let x = 6; x <= 26; x += 4) rect(p, x, 4, x, 27, hex("#f0f0ec"), 0.8, 0.03);   // warp threads
  p.relief(1.1);
};
T.loom_front = p => {
  T.loom_side(p);
  const cols = ["#c03a3a", "#e8c040", "#3a6ad0", "#e8e8e4"].map(hex);
  for (let y = 8; y <= 23; y++) for (let x = 5; x <= 26; x++) { p.set(x, y, jit(p, cols[Math.floor((y - 8) / 4 + (x % 8 < 4 ? 0 : 1)) % 4], 0.06)); p.setH(x, y, (x + y) % 2 ? 0.75 : 0.6); }
  rect(p, 3, 4, 28, 6, ramp(WOOD_OAK, 0.3), 0.9, 0.04);
  p.relief(1.0);
};

// ---------- fletching table (fletcher) ----------
T.fletching_table_top = p => {
  planksBase(p, BIRCH, "#6a5a38");
  frame(p, 2, "#7a6440", "#d8ca96");
  for (let k = 0; k < 18; k++) { p.set(7 + k, 24 - k, hex("#5a4224")); p.setH(7 + k, 24 - k, 1); }          // arrow shaft
  rect(p, 23, 4, 27, 8, hex("#9a9a9a"), 1, 0.05);                                                          // flint head
  for (let k = 0; k < 4; k++) { p.set(5 + k, 22 - k, WHITE); p.set(8 + k, 25 - k, hex("#e8e8e8")); }      // fletching
  p.relief(1.0);
};
T.fletching_table_side = p => { planksBase(p, BIRCH, "#6a5a38"); band(p, 0, 4, WOOD_OAK); p.relief(1.2); };
T.fletching_table_front = p => {
  T.fletching_table_side(p);
  circle(p, 16, 18, 8, (x, y, d) => { p.set(x, y, d > 6 ? hex("#e8e4d8") : d > 4 ? hex("#c83a3a") : d > 2 ? hex("#e8e4d8") : hex("#c83a3a")); p.setH(x, y, 0.9); }); // target
  p.relief(0.9);
};

// ---------- stonecutter (mason): body rows 13-31 (y 0-9), saw blade sprite above it ----------
T.stonecutter_side = p => {
  smoothBase(p, STONE_G, 0.4, 10);
  band(p, 13, 15, pal(DSTONE)); band(p, 29, 31, pal(DSTONE));
  p.relief(1.2);
};
T.stonecutter_top = p => {
  smoothBase(p, STONE_G, 0.4, 10);
  frame(p, 2, "#4a4a4c", "#9a9a9a");
  rect(p, 2, 15, 29, 16, hex("#1a1a1c"), 0.05, 0.05);   // blade slot
  p.relief(1.2);
};
T.stonecutter_saw = p => {
  clearTile(p);
  circle(p, 16, 14, 13, (x, y, d) => {
    if (y > 13) return;
    const ang = Math.atan2(y + 0.5 - 14, x + 0.5 - 16), tooth = d > 11.5 && Math.sin(ang * 22) < 0;
    if (tooth) return;
    p.set(x, y, jit(p, d > 10 ? hex("#dcdce4") : ramp(IRON, 0.55 + (x - y) * 0.01), 0.04)); p.setH(x, y, 0.8);
  });
};
SPRITE_TILES.add("stonecutter_saw");

// ---------- cauldron (leatherworker): walls rows 0-25 (y 3-16), legs rows 26-31 ----------
T.cauldron_side = p => {
  smoothBase(p, ["#2e2e32", "#36363a", "#3e3e42", "#46464a", "#4e4e52"], 0.3, 12);
  band(p, 0, 2, IRON);
  for (const x of [4, 14, 24]) { rivet(p, x, 5); rivet(p, x, 21); }
  rect(p, 0, 26, 31, 31, (x, y) => ramp(IRON, 0.25 + p.noise(x, y, 4, 4, 210) * 0.3), 0.7, 0.04);
  p.relief(1.2);
};
T.cauldron_top = p => {
  rect(p, 0, 0, 31, 31, (x, y) => ramp(pal(["#141416", "#1c1c1f", "#242428"]), p.noise(x, y, 4, 4, 220)), 0.1, 0.05);
  p.fill((x, y) => { const e = Math.min(x, y, 31 - x, 31 - y); if (e < 4) { p.set(x, y, jit(p, ramp(IRON, e === 0 || e === 3 ? 0.35 : 0.7), 0.04)); p.setH(x, y, 0.9); } });
  p.relief(1.1);
};
T.cauldron_bottom = p => { smoothBase(p, ["#2e2e32", "#36363a", "#3e3e42", "#46464a", "#4e4e52"], 0.3, 8); p.relief(1.0); };

// ---------- cartography table (cartographer) ----------
T.cartography_table_top = p => {
  planksBase(p, DARK_OAK, "#1a120a");
  rect(p, 3, 3, 28, 28, (x, y) => mix(hex("#e8dcb8"), hex("#c8b88a"), p.noise(x, y, 4, 4, 230)), 0.8, 0.03);  // the map
  p.fill((x, y) => {
    if (x < 4 || y < 4 || x > 27 || y > 27) return;
    const n = p.fbm(x, y, 3, 3, 231);
    if (n < 0.38) p.set(x, y, jit(p, hex("#5a8ac8"), 0.05)); else if (n > 0.66) p.set(x, y, jit(p, hex("#6a9a4a"), 0.05));
  });
  for (let k = 4; k <= 27; k += 6) for (let i = 4; i <= 27; i++) { p.scale(k, i, 0.85); p.scale(i, k, 0.85); }
  p.relief(0.8);
};
T.cartography_table_side = p => { planksBase(p, DARK_OAK, "#1a120a"); band(p, 0, 3, DARK_OAK.map(c => mul(c, 1.3))); rect(p, 4, 6, 27, 9, hex("#e8dcb8"), 0.9, 0.04); p.relief(1.2); };
T.cartography_table_front = p => {
  planksBase(p, DARK_OAK, "#1a120a"); band(p, 0, 3, DARK_OAK.map(c => mul(c, 1.3)));
  rect(p, 6, 7, 25, 24, hex("#e8dcb8"), 0.9, 0.04);
  for (let k = 0; k < 14; k++) { p.set(9 + k, 20 - Math.round(Math.sin(k / 2) * 3 + k * 0.4), hex("#8a3a2a")); }   // a trail on the map
  rect(p, 20, 9, 22, 11, hex("#c83a3a"), 1, 0.02);
  p.relief(1.0);
};

// ---------- drafting table (builder, not vanilla): a blueprint pinned on an oak table ----------
T.drafting_table_top = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  rect(p, 3, 3, 28, 28, (x, y) => mix(hex("#1f4f9a"), hex("#2a62b8"), p.noise(x, y, 4, 4, 240)), 0.8, 0.03);
  for (let k = 5; k <= 27; k += 4) for (let i = 4; i <= 27; i++) { p.blend(k, i, hex("#5a8ad8"), 0.5); p.blend(i, k, hex("#5a8ad8"), 0.5); }  // grid
  const L = (x0, y0, x1, y1) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let s = 0; s <= n; s++) { const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n); p.set(x, y, hex("#f2f6ff")); p.setH(x, y, 0.9); } };
  L(9, 15, 22, 15); L(9, 15, 9, 24); L(22, 15, 22, 24); L(9, 24, 22, 24); L(8, 15, 15, 8); L(15, 8, 23, 15); L(14, 19, 14, 24); L(17, 19, 17, 24); L(14, 19, 17, 19); // house sketch
  for (const [x, y] of [[4, 4], [27, 4], [4, 27], [27, 27]]) { p.set(x, y, hex("#d83a3a")); p.setH(x, y, 1); }                                            // pins
  p.relief(0.9);
};
T.drafting_table_side = p => {
  planksBase(p, WOOD_OAK, "#3d2c18"); band(p, 0, 3, WOOD_SPRUCE);
  rect(p, 3, 7, 28, 10, hex("#e8c840"), 0.9, 0.03);                                     // folding ruler
  for (let x = 4; x <= 27; x += 2) p.set(x, 7 + (x % 4 ? 1 : 2), hex("#3a2a10"));
  p.relief(1.1);
};
T.drafting_table_front = p => {
  T.drafting_table_side(p);
  for (let k = 0; k < 12; k++) { p.set(9 + Math.round(k * 0.4), 14 + k, hex("#b0b0b8")); p.set(22 - Math.round(k * 0.4), 14 + k, hex("#b0b0b8")); } // drafting compass legs
  rect(p, 14, 12, 17, 15, hex("#8a8a92"), 1, 0.03);
  for (let k = 0; k < 14; k++) { p.set(19 + Math.round(k * 0.3), 13 + k, hex("#e8a83a")); p.setH(19, 13 + k, 1); }                                      // pencil
  p.relief(1.0);
};
// ---------- survey table (explorer, not vanilla): a compass rose inlaid in a spruce table, a rolled map and a brass spyglass on the sides ----------
const SPRUCE = pal(["#2a1c0e", "#35240f", "#412c14", "#4f361a", "#5e4222"]);
T.survey_table_top = p => {
  planksBase(p, SPRUCE, "#1a1108");
  rect(p, 3, 3, 28, 28, (x, y) => mix(hex("#d8c890"), hex("#bfae78"), p.noise(x, y, 4, 4, 250)), 0.8, 0.03);      // parchment
  circle(p, 16, 16, 10, (x, y, d) => { if (d > 8.4) { p.set(x, y, jit(p, hex("#7a5a2a"), 0.04)); p.setH(x, y, 0.9); } });   // ring
  const L = (x0, y0, x1, y1, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let s = 0; s <= n; s++) { const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n); p.set(x, y, hex(c)); p.setH(x, y, 0.95); } };
  L(16, 5, 16, 27, "#3a2a14"); L(5, 16, 27, 16, "#3a2a14");                                                    // axes
  for (let k = 0; k < 7; k++) { const w = 3 - Math.floor(k / 2); for (let x = 16 - w; x <= 16 + w; x++) if (Math.abs(x - 16) <= w - (k % 2)) { p.set(x, 15 - k, hex("#c83a3a")); p.setH(x, 15 - k, 1); } }   // north needle
  rect(p, 15, 17, 17, 24, hex("#e8e4d4"), 0.95, 0.02);                                                         // south tail
  p.relief(0.8);
};
T.survey_table_side = p => { planksBase(p, SPRUCE, "#1a1108"); band(p, 0, 3, SPRUCE.map(c => mul(c, 1.3))); rect(p, 0, 14, 31, 16, hex("#b8923a"), 0.9, 0.04); p.relief(1.2); };
T.survey_table_front = p => {
  T.survey_table_side(p);
  rect(p, 5, 19, 14, 26, hex("#d8c890"), 0.95, 0.03); rect(p, 5, 19, 6, 26, hex("#a8946a"), 1, 0.03);        // rolled map
  rect(p, 17, 22, 27, 24, (x) => ramp(IRON, 0.3 + (x % 3) * 0.2), 0.95, 0.03); rect(p, 17, 21, 19, 25, hex("#b8923a"), 1, 0.03);   // spyglass
  p.relief(1.0);
};
// ---------- tent (explorer): canvas cloth, 8-pixel panels with darker seams and a rust stripe along every other panel; item sprite is a small A-frame ----------
const CANVAS = pal(["#a8935c", "#b8a46c", "#c6b27a", "#d2bf88", "#ddcb97"]);
T.tent_cloth = p => {
  p.fill((x, y) => {
    const panel = Math.floor(x / 8), seam = x % 8 === 7, weave = ((x + y) % 2 ? 0.04 : -0.03) + (p.noise(x, y, 8, 3, 260) - 0.5) * 0.3;
    let c = seam ? mul(ramp(CANVAS, 0.15), 0.8) : ramp(CANVAS, 0.55 + weave + (panel % 2 ? 0.08 : 0));
    if (!seam && panel % 2 === 1 && (y % 16 < 3)) c = hex("#9a4a2a");
    p.set(x, y, jit(p, c, 0.03)); p.setH(x, y, seam ? 0 : 0.6 + weave);
  });
  p.relief(0.9);
};
const { SPRITES, put } = K;
if (SPRITES) SPRITES.tent = (G, m) => {
  const cloth = hex("#d2bf88"), lo = hex("#a8935c"), pole = hex("#5a3f24"), door = hex("#3a2a14");
  for (let y = 3; y <= 12; y++) { const w = Math.round((y - 3) * 0.75); for (let x = 8 - w - 1; x <= 8 + w; x++) put(G, x, y, x <= 7 ? cloth : lo); }
  for (let y = 8; y <= 12; y++) { const w = Math.round((y - 8) * 0.5) + 1; for (let x = 8 - w; x < 8 + w; x++) put(G, x, y, door); }
  put(G, 7, 2, pole); put(G, 8, 2, pole); put(G, 7, 1, hex("#c83a3a")); put(G, 8, 1, hex("#c83a3a"));
  for (let x = 1; x <= 14; x++) put(G, x, 13, pole);
};
// ---------- tack rack (stable hand, not vanilla): a dark board on oak posts; the front carries a saddle on its peg, the sides a bridle and
// a coiled lead on hooks, the top the rack's shelf with a brush. Leather browns over spruce so it reads apart from the plank blocks. ----------
const LEATHER = pal(["#3e200e", "#552d14", "#6b3e1e", "#80502a", "#966438"]);
const BRASS = hex("#c8a040");
T.tack_rack_side = p => {
  vboards(p, SPRUCE, 8, "#1a1108");
  band(p, 0, 2, WOOD_OAK); band(p, 29, 31, WOOD_OAK);
  rect(p, 2, 8, 29, 9, hex("#2a1a0c"), 0.95, 0.03);                                                            // the hook rail
  for (const x of [8, 23]) { rect(p, x, 7, x + 1, 10, (xx, y) => (y === 7 ? BRASS : mul(BRASS, 0.7)), 1, 0.02); }   // brass hooks
  // bridle: headstall loop hanging from the left hook, a brass bit ring at the bottom
  for (let a = 0; a < 40; a++) { const t = a / 40 * Math.PI * 2, x = Math.round(9 + Math.sin(t) * 4), y = Math.round(18 + Math.cos(t) * 7.5); if (y > 10) { p.set(x, y, jit(p, ramp(LEATHER, 0.35 + (x < 9 ? 0.25 : 0)), 0.03)); p.setH(x, y, 0.95); } }
  circle(p, 9, 26.5, 1.8, (x, y, d) => { if (d > 0.9) { p.set(x, y, BRASS); p.setH(x, y, 1); } });
  // lead: a coil on the right hook
  for (let r = 3; r <= 5; r += 2) for (let a = 0; a < 36; a++) { const t = a / 36 * Math.PI * 2, x = Math.round(24 + Math.cos(t) * r), y = Math.round(16 + Math.sin(t) * (r + 1)); p.set(x, y, jit(p, hex(a % 6 < 3 ? "#a07a4a" : "#7a5a32"), 0.03)); p.setH(x, y, 0.9); }
  p.relief(1.1);
};
T.tack_rack_front = p => {
  vboards(p, SPRUCE, 8, "#1a1108");
  band(p, 0, 2, WOOD_OAK); band(p, 29, 31, WOOD_OAK);
  rect(p, 4, 9, 27, 11, (x, y) => ramp(WOOD_OAK, y === 9 ? 0.85 : 0.35), 1, 0.03);                              // the saddle peg (a rail)
  // saddle: seat curving over the peg, cantle and pommel raised, skirts hanging down, stirrups on irons
  for (let x = 5; x <= 26; x++) {
    const u = (x - 15.5) / 10.5, top = Math.round(8 - (1 - u * u) * 2 + (Math.abs(u) > 0.8 ? -2 : 0));
    for (let y = top; y <= 16; y++) { p.set(x, y, jit(p, ramp(LEATHER, 0.75 - (y - top) * 0.05 + (y === top ? 0.15 : 0)), 0.03)); p.setH(x, y, 1 - (y - top) * 0.03); }
  }
  rect(p, 7, 17, 24, 22, (x, y) => ramp(LEATHER, 0.4 - (y - 17) * 0.04 + (x === 7 || x === 24 ? -0.15 : 0)), 0.85, 0.03);   // skirt
  for (let x = 7; x <= 24; x += 3) p.set(x, 20, hex("#2a140a"));                                                // stitching
  for (const x of [9, 22]) {
    rect(p, x, 23, x, 26, hex("#3e200e"), 0.8, 0.02);                                                           // stirrup leathers
    rect(p, x - 2, 27, x + 2, 27, hex("#b0b0b8"), 1, 0.02); p.set(x - 2, 26, hex("#8e8e96")); p.set(x + 2, 26, hex("#8e8e96"));   // irons
  }
  p.relief(1.0);
};
T.tack_rack_top = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  frame(p, 2, "#2a1c0e", "#5e4222");
  rect(p, 6, 13, 25, 17, (x, y) => ramp(WOOD_SPRUCE, y === 13 ? 0.8 : 0.4), 0.9, 0.03);                         // a grooming brush on the shelf
  for (let x = 7; x <= 24; x += 2) { p.set(x, 18, hex("#c8a878")); p.set(x, 19, hex("#a88858")); }               // its bristles
  p.relief(1.0);
};

ICON_T.grindstone = p => {
  clearTile(p);
  rect(p, 4, 14, 7, 30, (x) => ramp(DARK_OAK, x === 4 ? 0.8 : 0.4), 0.8, 0.05);
  rect(p, 24, 14, 27, 30, (x) => ramp(DARK_OAK, x === 24 ? 0.8 : 0.4), 0.8, 0.05);
  circle(p, 16, 14, 11, (x, y, d) => { p.set(x, y, jit(p, ramp(pal(STONE_G), d > 9.5 ? 0.2 : 0.55 + (y < 10 ? 0.25 : 0)), 0.04)); p.setH(x, y, 0.9); });
  circle(p, 16, 14, 2.2, (x, y) => p.set(x, y, hex("#3a2c1c")));
};
})();
