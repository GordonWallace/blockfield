// Stone / ore / mineral pack: procedural 32px tile painters and item sprites for the Tier 1 blocks.
// Loaded right after textures.js; registers painters on the shared kit (BF.texKit) before the atlas is first drawn.
// Tile names are the vanilla texture names so a texture pack can be mapped onto them by name later.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-stone: BF.texKit missing (textures.js must load first)"); return; }
const { T, SPRITES, TS, hex, pal, mul, mix, ramp, clamp01, smooth, jit, dome, voronoi, WHITE, lighten, put, stroke, blob,
  smoothBase, frame, bricks, cobbleBase, mossOver, sandBase, planksBase, STONE, SANDSTONE, WOOD_OAK } = K;

// ---------- shared helpers ----------
// mottled base: fbm blotches + fine grain. cols = palette (dark -> light).
function blotch(p, cols, o = {}) {
  const C = typeof cols[0] === "string" ? pal(cols) : cols, f = o.freq || 5, s = o.salt || 0;
  p.fill((x, y) => {
    const n = p.fbm(x, y, f, 4, 300 + s), m = p.noise(x, y, o.f2 || 10, o.f2 || 10, 310 + s);
    p.set(x, y, jit(p, ramp(C, (n - 0.5) * (o.contrast || 1.6) + 0.5 + (m - 0.5) * 0.3 + (p.rand() - 0.5) * (o.grain || 0.12)), o.jit || 0.05));
    p.setH(x, y, n * 0.6 + m * 0.3);
  });
}
// stretched noise: px/py = noise cells across x / y (px small, py large = horizontal streaks)
function streaks(p, cols, px, py, o = {}) {
  const C = typeof cols[0] === "string" ? pal(cols) : cols, s = o.salt || 0;
  p.fill((x, y) => {
    const a = p.noise(x, y, px, py, 320 + s), b = p.noise(x, y, px * 2, py * 2, 321 + s), n = p.fbm(x, y, 4, 3, 322 + s);
    p.set(x, y, jit(p, ramp(C, a * 0.5 + b * 0.25 + n * 0.25 + (p.rand() - 0.5) * (o.grain || 0.1)), o.jit || 0.05));
    p.setH(x, y, a * 0.5 + b * 0.3);
  });
}
function specks(p, n, cols, rmin, rmax, h = 0.5) {
  const C = typeof cols[0] === "string" ? pal(cols) : cols;
  for (let i = 0; i < n; i++) dome(p, p.ri(TS), p.ri(TS), rmin + p.rand() * (rmax - rmin), rmin + p.rand() * (rmax - rmin), p.pick(C), h, 0.35, 0.06);
}
function cracks(p, n, dark = 0.55) {
  for (let i = 0; i < n; i++) {
    let x = p.rand() * TS, y = p.rand() * TS, a = p.rand() * Math.PI * 2;
    const L = 7 + p.ri(8);
    for (let k = 0; k < L; k++) {
      p.set(x, y, mul(p.get(x, y), dark)); p.setH(x, y, 0.05);
      a += (p.rand() - 0.5) * 1.1; x += Math.cos(a); y += Math.sin(a);
    }
  }
}
// voronoi plates with darker seams
function plates(p, cols, count, o = {}) {
  const C = typeof cols[0] === "string" ? pal(cols) : cols, V = voronoi(p, count), tone = [];
  for (let i = 0; i < count; i++) tone.push(p.rand());
  p.fill((x, y) => {
    const [k, d1, d2] = V(x, y), e = d2 - d1, n = p.fbm(x, y, 4, 3, 330);
    const edge = e < (o.edge || 1.0);
    let c = ramp(C, tone[k] * 0.75 + n * 0.25 + (p.rand() - 0.5) * 0.08);
    if (edge) c = mul(c, o.edgeDark || 0.68);
    p.set(x, y, jit(p, c, 0.05)); p.setH(x, y, edge ? 0.1 : 0.5 + tone[k] * 0.35 + n * 0.15);
  });
}
// polished: smooth + bevel; grid = optional tile seam spacing
function polishedTile(p, cols, grid = 0) {
  smoothBase(p, cols, 0.3);
  p.fill((x, y) => {
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y);
    if (e === 0) { p.scale(x, y, 0.72); p.setH(x, y, 0.2); } else if (e === 1) { p.scale(x, y, 1.1); }
    if (grid && e > 1) {
      if (x % grid === 0 || y % grid === 0) { p.scale(x, y, 0.72); p.setH(x, y, 0.2); }
      else if (x % grid === 1 || y % grid === 1) p.scale(x, y, 1.1);
    }
  });
}
// concentric square rings (log-top style); ring colours from cols
function ringsTop(p, cols, period = 3.4) {
  const C = pal(cols);
  p.fill((x, y) => {
    const dx = x - 15.5, dy = y - 15.5, ed = Math.min(x, y, TS - 1 - x, TS - 1 - y);
    const r = Math.max(Math.abs(dx), Math.abs(dy)) + (p.noise(x, y, 4, 4, 340) - 0.5) * 2;
    let t = 0.5 + 0.28 * Math.sin(r * Math.PI * 2 / period) + (p.rand() - 0.5) * 0.1;
    if (ed < 2) t = ed === 0 ? 0.15 : 0.85;
    p.set(x, y, jit(p, ramp(C, t), 0.05)); p.setH(x, y, ed < 2 ? 0.7 : 0.5 + 0.2 * Math.sin(r * Math.PI * 2 / period));
  });
}
// Ore clusters painted over the current base (same look as textures.js oreTile).
function oreOver(p, colors, opts = {}) {
  const [dark, mid, light, hi] = colors.map(hex);
  const clusters = opts.clusters || 5;
  for (let c = 0; c < clusters; c++) {
    const cx = p.ri(TS), cy = p.ri(TS), n = (opts.n || 3) + p.ri(opts.nr || 4);
    for (let k = 0; k < n; k++) {
      const x0 = cx + p.ri(7) - 3, y0 = cy + p.ri(7) - 3, r = (opts.rmin || 0.9) + p.rand() * (opts.size || 1.2);
      const R = Math.ceil(r) + 1;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d > 1.45) continue;
        if (d > 1) { p.scale(x0 + dx, y0 + dy, 0.8); continue; }
        const s = -(dx + dy) / (2 * r);
        const col = s > 0.45 ? hi : s > 0 ? light : s > -0.45 ? mid : dark;
        p.set(x0 + dx, y0 + dy, jit(p, col, 0.06)); p.setH(x0 + dx, y0 + dy, 0.95 + (1 - d) * 0.2);
      }
    }
  }
}

// ---------- base painters (colour + height, no lighting) ----------
const DS = pal(["#26262a", "#303035", "#3b3b41", "#46464d", "#52525a"]);
function stoneB(p) { // same as T.stone without relief (plain stone host for ores)
  K.stoneBase(p);
}
function deepslateSide(p) {
  streaks(p, DS, 2, 14, { salt: 1 });
  p.fill((x, y) => { if (p.noise(x, y, 2, 24, 350) < 0.08) { p.scale(x, y, 0.72); p.setH(x, y, 0.2); } });
}

// ---------- stone family ----------
const GRANITE = ["#7a4a3a", "#8a5848", "#9a6654", "#a67562", "#b4846f"];
T.granite = p => {
  blotch(p, GRANITE, { salt: 2, contrast: 1.4 });
  specks(p, 26, ["#b88a74", "#c89a82", "#5e382c"], 0.7, 1.5);
  p.relief(1.3);
};
T.diorite = p => {
  blotch(p, ["#9c9c9c", "#b2b2b2", "#c6c6c6", "#d6d6d6", "#e6e6e6"], { salt: 3, contrast: 1.2 });
  specks(p, 30, ["#6a6a6a", "#7c7c7c", "#5a5a5a"], 0.7, 1.7);
  p.relief(1.3);
};
T.andesite = p => {
  blotch(p, ["#707070", "#7e7e7e", "#8a8a8a", "#979797", "#a4a4a4"], { salt: 4, contrast: 1.3 });
  specks(p, 22, ["#5e5e5e", "#b0b0b0", "#6a6a6a"], 0.6, 1.5);
  p.relief(1.3);
};
T.polished_granite = p => { polishedTile(p, GRANITE); p.relief(0.8); };
T.polished_diorite = p => { polishedTile(p, ["#a8a8a8", "#bcbcbc", "#cecece", "#dcdcdc", "#eaeaea"]); p.relief(0.8); };
T.polished_andesite = p => { polishedTile(p, ["#7a7a7a", "#868686", "#929292", "#9e9e9e", "#aaaaaa"]); p.relief(0.8); };
const SBRICK = { bw: 16, bh: 16, mortar: 1, offset: 8, cols: pal(["#5e5e5e", "#6c6c6c", "#7a7a7a", "#888888", "#969696"]), mortarCol: hex("#4a4a4a"), bevel: 2, vary: 0.35, bias: 0.25 };
T.stone_bricks = p => { bricks(p, SBRICK); p.relief(1.1); };
T.mossy_stone_bricks = p => { bricks(p, SBRICK); mossOver(p, 0.38); p.relief(0.7); };
T.cracked_stone_bricks = p => { bricks(p, SBRICK); cracks(p, 7, 0.5); p.relief(1.1); };
T.chiseled_stone_bricks = p => {
  bricks(p, { ...SBRICK, bw: 32, bh: 32, offset: 0, mortar: 1 });
  p.fill((x, y) => {
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y);
    if (e >= 3 && e <= 4) { p.scale(x, y, e === 3 ? 0.62 : 1.18); p.setH(x, y, e === 3 ? 0.15 : 0.9); }
    else if (e > 4 && e < 14) p.scale(x, y, 0.93);
  });
  for (let x = 6; x < 26; x++) for (const y of [14, 17]) { p.scale(x, y, 0.65); }
  p.relief(1.1);
};
T.smooth_stone = p => {
  smoothBase(p, ["#8c8c8c", "#979797", "#a1a1a1", "#ababab", "#b5b5b5"], 0.25, 8, "#838383");
  p.relief(0.6);
};
T.deepslate_top = p => { ringsTop(p, ["#222226", "#2e2e33", "#3a3a40", "#46464d", "#5a5a62"]); p.relief(1.0); };
T.deepslate = p => { deepslateSide(p); p.relief(1.3); };
T.cobbled_deepslate = p => { cobbleBase(p, { cols: DS.map(c => mul(c, 1.05)), mortar: "#121214" }); };
const DSP = ["#2c2c31", "#36363c", "#404047", "#4a4a52", "#56565f"];
T.polished_deepslate = p => { polishedTile(p, DSP, 16); p.relief(0.9); };
T.deepslate_bricks = p => { bricks(p, { bw: 16, bh: 8, mortar: 1, offset: 8, cols: pal(DSP), mortarCol: hex("#18181b"), bevel: 2, vary: 0.45, bias: 0.2 }); p.relief(1.2); };
T.deepslate_tiles = p => { bricks(p, { bw: 8, bh: 8, mortar: 1, offset: 4, cols: pal(["#24242a", "#2e2e34", "#38383f", "#424249", "#4c4c54"]), mortarCol: hex("#141417"), bevel: 2, vary: 0.45, bias: 0.15 }); p.relief(1.2); };
T.tuff = p => {
  blotch(p, ["#4c4e44", "#585a4e", "#656759", "#727464", "#808272"], { salt: 5, freq: 4, contrast: 1.9, f2: 8 });
  specks(p, 14, ["#8a8c7c", "#464840", "#6e7060"], 1.0, 2.6, 0.45);
  p.relief(1.2);
};
T.dripstone_block = p => {
  streaks(p, ["#5e4636", "#6e5444", "#7e6252", "#8e7160", "#9c7f6c"], 12, 3, { salt: 2 });
  specks(p, 12, ["#4a362a", "#a68a76"], 0.7, 1.6);
  p.relief(1.4);
};
T.obsidian = p => {
  smoothBase(p, ["#0a0614", "#120c22", "#1a1230", "#241a40", "#30245a"], 0.5, 22, "#4a3a82");
  p.fill((x, y) => { if (Math.abs(p.noise(x, y, 3, 3, 360) - 0.5) < 0.02) p.scale(x, y, 1.5); });
  p.relief(1.6);
};

// ---------- sandstone variants ----------
function sandstoneTop(p, cols) { sandBase(p, cols, false); }
function sandstoneSide(p, cols) {
  sandBase(p, cols, false);
  const bands = [[0, 6, 0.75], [6, 20, 0.45], [20, 26, 0.55], [26, 32, 0.35]];
  for (const [a, b, tone] of bands) for (let y = a; y < b; y++) for (let x = 0; x < TS; x++) {
    const streak = p.noise(x, y, 2, 16, 200);
    p.set(x, y, jit(p, ramp(cols, tone + (streak - 0.5) * 0.35 + (p.rand() - 0.5) * 0.1), 0.04));
    p.setH(x, y, 0.8 - (y - a) / (b - a) * 0.35);
    if (y === b - 1) { p.scale(x, y, 0.82); p.setH(x, y, 0.1); }
  }
}
const REDSS = pal(["#7e3e18", "#8e4a1e", "#9c5424", "#a95d2a", "#b56832"]);
const SANDSS = SANDSTONE;
function cutFace(p, cols) { // flat sandstone face with a thin outline box and a seam
  sandBase(p, cols, false);
  p.fill((x, y) => {
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y);
    if (e === 0) { p.scale(x, y, 0.78); p.setH(x, y, 0.2); } else if (e === 1) p.scale(x, y, 1.08);
  });
}
function chiseledFace(p, cols) {
  cutFace(p, cols);
  const dk = 0.66;
  p.fill((x, y) => {
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y);
    if (e === 4) { p.scale(x, y, dk); p.setH(x, y, 0.2); }
  });
  // carved wave
  for (let x = 6; x < 26; x++) {
    const y = 16 + Math.round(Math.sin(x * 0.9) * 3);
    p.scale(x, y, 0.6); p.scale(x, y + 1, 0.8); p.setH(x, y, 0.1);
  }
  for (let x = 6; x < 26; x++) { p.scale(x, 9, 0.72); p.scale(x, 23, 0.72); }
}
T.cut_sandstone = p => { cutFace(p, SANDSS); p.relief(0.8); };
T.chiseled_sandstone = p => { chiseledFace(p, SANDSS); p.relief(1.0); };
T.red_sandstone_top = p => { sandstoneTop(p, REDSS); p.relief(0.6); };
T.red_sandstone = p => { sandstoneSide(p, REDSS); p.relief(1.1); };
T.red_sandstone_bottom = p => { sandstoneTop(p, REDSS); for (let i = 0; i < 40; i++) { const x = p.ri(TS), y = p.ri(TS); p.set(x, y, mul(p.get(x, y), 0.82)); p.setH(x, y, 0); } p.relief(1.0); };
T.cut_red_sandstone = p => { cutFace(p, REDSS); p.relief(0.8); };
T.chiseled_red_sandstone = p => { chiseledFace(p, REDSS); p.relief(1.0); };

// ---------- mud, prismarine, nether, end, quartz ----------
const MUD = ["#5a3e2e", "#6b4a37", "#7a5640", "#86604a", "#926b52"];
T.mud_bricks = p => { bricks(p, { bw: 16, bh: 8, mortar: 1, offset: 8, cols: pal(MUD), mortarCol: hex("#4e3426"), bevel: 2, vary: 0.4, bias: 0.25 }); p.relief(1.1); };
T.packed_mud = p => { smoothBase(p, MUD, 0.5, 30); specks(p, 12, ["#5a3e2e", "#9a7258"], 0.6, 1.2, 0.45); p.relief(0.9); };
T.prismarine = p => { plates(p, ["#3d7f70", "#4a9282", "#59a595", "#68b6a6", "#7ac6b6"], 14, { edge: 0.9 }); p.relief(1.2); };
T.prismarine_bricks = p => { bricks(p, { bw: 16, bh: 16, mortar: 1, offset: 0, cols: pal(["#4c9484", "#58a494", "#64b2a2", "#72c0b0", "#80ccbc"]), mortarCol: hex("#2c6458"), bevel: 2, vary: 0.4, bias: 0.3 }); p.relief(1.2); };
T.dark_prismarine = p => { plates(p, ["#1e3e34", "#264e42", "#2e5c50", "#386a5c", "#43786a"], 14, { edge: 0.9 }); p.relief(1.2); };
T.sea_lantern = p => {
  plates(p, ["#9ccac4", "#b8dcd6", "#d0eae6", "#e6f6f3", "#fbffff"], 20, { edge: 1.4, edgeDark: 0.62 });
  p.fill((x, y) => { const d = Math.hypot(x - 15.5, y - 15.5); if (d < 3) p.set(x, y, [255, 255, 255]); });
  p.relief(0.5);
};
T.blackstone_top = p => { blotch(p, ["#14111a", "#1b1822", "#23202b", "#2c2834", "#37323f"], { salt: 6, contrast: 1.6 }); specks(p, 10, ["#0c0a10", "#403a48"], 0.7, 1.6); p.relief(1.3); };
T.blackstone = p => { blotch(p, ["#181419", "#201c22", "#29242b", "#322d35", "#3d3740"], { salt: 7, contrast: 1.8 }); specks(p, 12, ["#0e0b10", "#4a4350", "#6a5a30"], 0.6, 1.4); p.relief(1.3); };
T.polished_blackstone = p => { polishedTile(p, ["#1f1b22", "#27222b", "#302a35", "#39333f", "#443d4a"]); p.relief(0.9); };
T.basalt_side = p => { streaks(p, ["#2e2e34", "#3a3a41", "#46464e", "#52525b", "#5e5e68"], 10, 2, { salt: 3 }); p.relief(1.5); };
T.basalt_top = p => { ringsTop(p, ["#34343a", "#40404a", "#4c4c56", "#585862", "#686872"], 4.2); p.relief(1.0); };
T.smooth_basalt = p => { smoothBase(p, ["#34343a", "#3e3e46", "#48484f", "#52525a", "#5c5c65"], 0.35, 10, "#2a2a30"); p.relief(0.7); };
T.netherrack = p => {
  p.fill((x, y) => {
    const n = p.fbm(x, y, 6, 4, 370), m = p.noise(x, y, 14, 14, 371);
    p.set(x, y, jit(p, ramp(pal(["#4a1f20", "#5e2828", "#733233", "#873d3c", "#9a4a46"]), (n - 0.5) * 1.8 + 0.5 + (m - 0.5) * 0.5 + (p.rand() - 0.5) * 0.25), 0.07));
    p.setH(x, y, n * 0.6 + m * 0.4);
  });
  specks(p, 16, ["#3a1618", "#b05a54"], 0.7, 1.4);
  p.relief(1.8);
};
T.nether_bricks = p => { bricks(p, { bw: 16, bh: 8, mortar: 1, offset: 8, cols: pal(["#241014", "#2e161b", "#391c22", "#44222a", "#502a32"]), mortarCol: hex("#150a0d"), bevel: 2, vary: 0.35, bias: 0.3 }); p.relief(1.1); };
T.soul_sand = p => {
  blotch(p, ["#33261d", "#3e2f24", "#4a3a2c", "#574534", "#665140"], { salt: 8, freq: 6, contrast: 1.5 });
  for (let i = 0; i < 9; i++) { // darker hollows, like faces pressed into the sand
    const cx = p.ri(TS), cy = p.ri(TS), r = 1.4 + p.rand() * 1.8;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy) / r;
      if (d < 1) { p.scale(cx + dx, cy + dy, 0.55 + d * 0.25); p.setH(cx + dx, cy + dy, 0.1); }
    }
  }
  p.relief(1.2);
};
T.glowstone = p => {
  plates(p, ["#9a5818", "#c07a28", "#e09a3c", "#f4bc5c", "#ffe08c"], 22, { edge: 1.2, edgeDark: 0.6 });
  p.fill((x, y) => { const c = p.get(x, y); p.set(x, y, [Math.min(255, c[0] * 1.12), Math.min(255, c[1] * 1.1), c[2] * 1.05]); });
  p.relief(0.6);
};
T.magma = p => {
  const V = voronoi(p, 14), tone = [];
  for (let i = 0; i < 14; i++) tone.push(p.rand());
  const rock = pal(["#2a0c06", "#3a1208", "#4a1a0c", "#5c2410"]), glow = pal(["#c8380a", "#f06a10", "#ffa030", "#ffe070"]);
  p.fill((x, y) => {
    const [k, d1, d2] = V(x, y), e = d2 - d1, n = p.fbm(x, y, 4, 3, 380);
    if (e < 1.7 + n * 1.2) { p.set(x, y, jit(p, ramp(glow, 1 - e / 2.6 + (p.rand() - 0.5) * 0.25), 0.04)); p.setH(x, y, 0.2); }
    else { p.set(x, y, jit(p, ramp(rock, tone[k] * 0.7 + n * 0.3), 0.06)); p.setH(x, y, 0.6 + tone[k] * 0.3); }
  });
  p.relief(0.8);
};
const QUARTZ = ["#d2cbc0", "#e0dad0", "#eae5dc", "#f2eee7", "#faf7f2"];
function quartzFace(p) {
  smoothBase(p, QUARTZ, 0.25);
  p.fill((x, y) => { const v = p.noise(x, y, 2, 12, 390); if (v < 0.2) p.scale(x, y, 0.95); });
}
T.quartz_block_side = p => { quartzFace(p); p.relief(0.5); };
T.quartz_block_top = p => { quartzFace(p); frame(p, 2, "#cfc8bd", "#f6f2ec"); p.relief(0.5); };
T.quartz_block_bottom = p => { smoothBase(p, QUARTZ, 0.2); p.relief(0.4); };
T.chiseled_quartz_block = p => {
  quartzFace(p); frame(p, 3, "#c4bdb2", "#f8f5f0");
  for (const y of [9, 12, 15, 18, 21]) for (let x = 5; x < 27; x++) { p.scale(x, y, 0.72); p.scale(x, y + 1, 1.06); }
  p.relief(0.7);
};
T.chiseled_quartz_block_top = p => { quartzFace(p); frame(p, 3, "#c4bdb2", "#f8f5f0"); p.fill((x, y) => { if (Math.min(x, y, 31 - x, 31 - y) === 6) p.scale(x, y, 0.82); }); p.relief(0.6); };
T.quartz_pillar = p => {
  quartzFace(p);
  p.fill((x, y) => {
    const m = x % 16;
    if (m === 0) { p.scale(x, y, 0.74); p.setH(x, y, 0.15); }
    else if (m === 1) p.scale(x, y, 1.06);
    else if (m === 8) p.scale(x, y, 0.9);
  });
  p.relief(0.6);
};
T.quartz_pillar_top = p => { quartzFace(p); frame(p, 2, "#cfc8bd", "#f6f2ec"); p.fill((x, y) => { if (Math.min(x, y, 31 - x, 31 - y) === 5) p.scale(x, y, 0.88); }); p.relief(0.5); };
T.quartz_bricks = p => { bricks(p, { bw: 16, bh: 8, mortar: 1, offset: 8, cols: pal(QUARTZ), mortarCol: hex("#bdb6aa"), bevel: 2, vary: 0.2, bias: 0.45 }); p.relief(0.6); };
T.end_stone = p => {
  blotch(p, ["#b6b678", "#c6c688", "#d4d296", "#e0dea4", "#ecebb8"], { salt: 9, freq: 5, contrast: 1.4 });
  specks(p, 16, ["#a0a062", "#f0eec0"], 0.8, 1.8);
  p.relief(1.3);
};
const PURPUR = ["#82528a", "#925f9a", "#a26cac", "#b27cbc", "#c28cc8"];
function purpurFace(p) {
  smoothBase(p, PURPUR, 0.35, 0);
  p.fill((x, y) => {
    const e = Math.min(x % 16, y % 16, 15 - (x % 16), 15 - (y % 16));
    if (e === 0) { p.scale(x, y, 0.72); p.setH(x, y, 0.2); }
    else if (e === 1) p.scale(x, y, 1.08);
  });
  for (const cx of [3, 19]) for (const cy of [3, 19]) { p.set(cx, cy, hex("#d8a8de")); p.set(cx + 9, cy + 9, hex("#6a3c74")); }
}
T.purpur_block = p => { purpurFace(p); p.relief(0.9); };
T.purpur_pillar = p => {
  smoothBase(p, PURPUR, 0.35, 0);
  p.fill((x, y) => {
    const m = x % 16;
    if (m === 0) { p.scale(x, y, 0.72); p.setH(x, y, 0.2); } else if (m === 1) p.scale(x, y, 1.1);
    else if (m === 8) p.scale(x, y, 0.9);
    if (y % 8 === 3 && (m === 4 || m === 12)) p.set(x, y, hex("#d8a8de"));
  });
  p.relief(0.9);
};
T.purpur_pillar_top = p => { purpurFace(p); frame(p, 2, "#764880", "#c490cc"); p.relief(0.9); };
const BONE = ["#b8b09a", "#ccc5ae", "#dcd6c0", "#e8e3d0", "#f4f0e0"];
T.bone_block_side = p => {
  smoothBase(p, BONE, 0.2);
  p.fill((x, y) => {
    const m = (x + Math.round((p.noise(x, y, 4, 4, 395) - 0.5) * 1.5)) % 8;
    if (m === 0) { p.scale(x, y, 0.62); p.setH(x, y, 0.1); } else if (m === 1) p.scale(x, y, 1.1);
  });
  p.relief(0.8);
};
T.bone_block_top = p => {
  const C = pal(BONE);
  p.fill((x, y) => {
    const r = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5)), ed = Math.min(x, y, 31 - x, 31 - y);
    let t = 0.65 + (p.rand() - 0.5) * 0.15;
    if (ed < 2) t = ed === 0 ? 0.2 : 0.95;
    else if (Math.round(r) % 4 === 0) t = 0.3;
    else if (r < 3) t = 0.1;
    p.set(x, y, jit(p, ramp(C, t), 0.04)); p.setH(x, y, t);
  });
  p.relief(0.8);
};
T.blue_ice = p => {
  const C = pal(["#4a82e0", "#5a94ec", "#6ea6f4", "#86bafa", "#a6d2ff"]);
  p.fill((x, y) => {
    const n = p.fbm(x, y, 4, 4, 396);
    let c = ramp(C, n * 0.8 + (p.rand() - 0.5) * 0.1);
    if (Math.abs(p.noise(x, y, 3, 3, 397) - 0.5) < 0.02) c = mix(c, hex("#d8ecff"), 0.55);
    p.set(x, y, jit(p, c, 0.04)); p.setH(x, y, n * 0.5);
  });
  p.relief(0.7);
};
function spongeBase(p, cols, holeCol) {
  smoothBase(p, cols, 0.4, 40);
  for (let i = 0; i < 11; i++) {
    const cx = p.ri(TS), cy = p.ri(TS), r = 1.5 + p.rand() * 2.2;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.hypot(dx, dy) / r;
      if (d < 1) { p.set(cx + dx, cy + dy, jit(p, mix(holeCol, hex("#000000"), 0.2 + d * 0.25), 0.05)); p.setH(cx + dx, cy + dy, 0.05); }
    }
  }
}
T.sponge = p => { spongeBase(p, ["#b4a438", "#c4b440", "#d0c24c", "#dcce5c", "#e6da70"], hex("#8c7e28")); p.relief(1.4); };
T.wet_sponge = p => { spongeBase(p, ["#908a2c", "#a09a34", "#aca83e", "#b8b44c", "#c4c05c"], hex("#5e5a1c")); p.relief(1.4); };
function melonStripes(p, top) {
  const D = pal(["#2c5a18", "#366a1e", "#417a26", "#4e8a2e"]), L = pal(["#6aa63a", "#7ab648", "#8ac658"]);
  p.fill((x, y) => {
    const w = (p.noise(x, y, 4, 4, 398) - 0.5) * 3.5;
    const s = Math.sin((x + w) * Math.PI * 2 / 8);
    const inL = s > 0.35;
    const c = inL ? ramp(L, (s - 0.35) / 0.65 * 0.7 + (p.rand() - 0.5) * 0.3) : ramp(D, 0.4 + (p.rand() - 0.5) * 0.7 + s * 0.2);
    p.set(x, y, jit(p, c, 0.05)); p.setH(x, y, inL ? 0.7 : 0.4);
  });
  if (top) { // stem scar in the middle
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (Math.hypot(dx, dy) < 3.2) { p.set(15 + dx, 15 + dy, jit(p, hex("#6a5a2a"), 0.1)); p.setH(15 + dx, 15 + dy, 0.8); }
    p.fill((x, y) => { if (Math.min(x, y, 31 - x, 31 - y) < 1) p.scale(x, y, 0.7); });
  }
}
T.melon_side = p => { melonStripes(p, false); p.relief(1.0); };
T.melon_top = p => { melonStripes(p, true); p.relief(1.0); };
// TNT: red sticks, white band with "TNT"
const GLYPH = { T: ["111", "010", "010", "010", "010"], N: ["101", "111", "111", "101", "101"] };
function tntTop(p, hole) {
  const R = pal(["#8a2218", "#a02a1e", "#b43424", "#c43e2c"]);
  p.fill((x, y) => { p.set(x, y, jit(p, ramp(R, p.noise(x, y, 4, 4, 399) * 0.7 + (p.rand() - 0.5) * 0.2), 0.05)); p.setH(x, y, 0.5); });
  for (let x = 0; x < TS; x++) if (x % 8 === 0) { for (let y = 0; y < TS; y++) { p.scale(x, y, 0.7); p.setH(x, y, 0.2); } }
  frame(p, 2, "#7a1e14", "#d0503a");
  if (hole) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      if (r <= 4) { p.set(15 + dx, 15 + dy, r === 4 ? hex("#c8b08a") : r >= 3 ? hex("#e0cc9e") : hex("#2a2220")); p.setH(15 + dx, 15 + dy, r >= 3 ? 0.9 : 0.1); }
    }
    for (let i = 0; i < 3; i++) p.set(15 + i - 1, 15, hex("#6a5a4a"));
  }
}
T.tnt_top = p => { tntTop(p, true); p.relief(0.9); };
T.tnt_bottom = p => { tntTop(p, false); p.relief(0.9); };
T.tnt_side = p => {
  const R = pal(["#8a2218", "#a02a1e", "#b43424", "#c43e2c"]);
  p.fill((x, y) => { p.set(x, y, jit(p, ramp(R, p.noise(x, y, 4, 2, 400) * 0.7 + (p.rand() - 0.5) * 0.2), 0.05)); p.setH(x, y, 0.5); });
  for (let x = 0; x < TS; x++) if (x % 8 === 0) { for (let y = 0; y < TS; y++) { p.scale(x, y, 0.72); p.setH(x, y, 0.2); } }
  const W = pal(["#c8c0b0", "#d8d2c4", "#e8e4d8"]);
  for (let y = 9; y <= 22; y++) for (let x = 0; x < TS; x++) {
    p.set(x, y, jit(p, ramp(W, y === 9 ? 1 : y === 22 ? 0 : 0.55 + (p.rand() - 0.5) * 0.3), 0.04)); p.setH(x, y, y === 9 || y === 22 ? 0.9 : 0.7);
  }
  const ink = hex("#2a2420"); let x0 = 5;
  for (const ch of "TNT") {
    GLYPH[ch].forEach((row, gy) => row.split("").forEach((v, gx) => {
      if (v === "1") for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) { p.set(x0 + gx * 2 + sx, 11 + gy * 2 + sy, jit(p, ink, 0.05)); p.setH(x0 + gx * 2 + sx, 11 + gy * 2 + sy, 0.6); }
    }));
    x0 += 8;
  }
  p.relief(0.9);
};
T.bookshelf = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  const books = ["#8a2a2a", "#2a4a8a", "#2a7a3a", "#7a4a1a", "#6a2a7a", "#c8a030", "#3a3a3a", "#a85a2a"].map(hex);
  for (const [y0, y1] of [[6, 13], [18, 25]]) {
    for (let y = y0; y <= y1; y++) for (let x = 0; x < TS; x++) { p.set(x, y, mul(hex("#2a2016"), 0.8 + (p.rand() - 0.5) * 0.2)); p.setH(x, y, 0.05); }
    let x = 0;
    while (x < TS) {
      const w = 3 + p.ri(3), col = p.pick(books), top = y0 + (p.rand() < 0.35 ? 1 + p.ri(2) : 0);
      for (let bx = x; bx < Math.min(TS, x + w); bx++) for (let y = top; y <= y1; y++) {
        const e = bx === x ? 1.18 : bx === x + w - 1 ? 0.72 : 1;
        p.set(bx, y, jit(p, mul(col, e * (y === top ? 1.2 : 1) * (y === y1 ? 0.8 : 1)), 0.05)); p.setH(bx, y, 0.7);
      }
      if (w >= 4) for (let y = top + 2; y < top + 4; y++) for (let bx = x + 1; bx < x + w - 1; bx++) p.set(bx, y, jit(p, lighten(col, 0.5), 0.04));
      x += w;
    }
  }
  p.relief(1.0);
};

// ---------- ores (stone and deepslate hosts) ----------
const ORE = {
  lapis: { cols: ["#112a70", "#1c40a8", "#2e5cd0", "#6a96f0"], o: { size: 1.3, clusters: 5 } },
  redstone: { cols: ["#6a0c0c", "#a81616", "#dc2626", "#ff7060"], o: { size: 0.9, clusters: 6 } },
  emerald: { cols: ["#0c6a30", "#169a48", "#36cc70", "#b8ffd0"], o: { size: 1.0, clusters: 3 } },
  copper: { cols: ["#7a3e22", "#b4602f", "#dc8450", "#f6c098"], o: { size: 1.3, clusters: 5 } },
  coal: { cols: ["#141414", "#1f1f1f", "#2e2e2e", "#5a5a5a"], o: { size: 1.5 } },
  iron: { cols: ["#8a5e44", "#b48466", "#d6aa8a", "#f2d6c0"], o: {} },
  gold: { cols: ["#9a7212", "#d4a82a", "#f2d24a", "#fff6b0"], o: {} },
  diamond: { cols: ["#1c7a82", "#38b8c0", "#6ae4ea", "#e2ffff"], o: {} },
};
for (const k of ["lapis", "redstone", "emerald", "copper"]) T[k + "_ore"] = p => { stoneB(p); oreOver(p, ORE[k].cols, ORE[k].o); p.relief(1.5); };
for (const k of Object.keys(ORE)) T["deepslate_" + k + "_ore"] = p => {
  deepslateSide(p); oreOver(p, ORE[k].cols, ORE[k].o);
  p.relief(1.5);
};

// ---------- mineral blocks ----------
function metalBlock(p, cols, rim, hi, o = {}) {
  smoothBase(p, cols, 0.3, o.specks || 0, o.speckCol || null);
  frame(p, 2, rim, hi);
  if (o.after) o.after(p);
}
T.iron_block = p => { metalBlock(p, ["#c4c4c4", "#d2d2d2", "#dedede", "#e8e8e8", "#f4f4f4"], "#b0b0b0", "#fafafa"); p.relief(0.5); };
T.gold_block = p => { metalBlock(p, ["#d8ac1c", "#e8c030", "#f4d444", "#f8e468", "#fff4a8"], "#c09418", "#fff6b8"); p.relief(0.5); };
T.diamond_block = p => {
  metalBlock(p, ["#38b0b4", "#4cc8c8", "#62dcd8", "#80eee8", "#b0fffa"], "#2a9498", "#c8ffff", { after: q => {
    for (const [x, y] of [[8, 8], [22, 11], [12, 21], [24, 24], [6, 22]]) { q.set(x, y, WHITE); q.set(x + 1, y, hex("#d8ffff")); q.set(x, y + 1, hex("#d8ffff")); }
  } });
  p.relief(0.5);
};
T.emerald_block = p => { metalBlock(p, ["#18a044", "#22bc58", "#38d070", "#5ce490", "#a0ffc0"], "#12803a", "#b8ffd4", { specks: 10, speckCol: "#c8ffe0" }); p.relief(0.5); };
T.lapis_block = p => { metalBlock(p, ["#1c3c98", "#2450b8", "#2e62d4", "#4a7ee8", "#7ea6ff"], "#16307a", "#8ab0ff", { specks: 28, speckCol: "#d8c060" }); p.relief(0.7); };
T.redstone_block = p => {
  metalBlock(p, ["#8e1010", "#b01818", "#cc2020", "#e83830", "#ff6a5a"], "#6e0c0c", "#ff8070", { after: q => {
    for (let i = 0; i < 3; i++) cracks(q, 2, 1.25);
  } });
  p.relief(0.8);
};
T.coal_block = p => { smoothBase(p, ["#0a0a0a", "#141414", "#1e1e1e", "#2a2a2a", "#3a3a3a"], 0.7, 40, "#4a4a4a"); frame(p, 1, "#060606", "#202020"); p.relief(1.2); };
T.copper_block = p => {
  metalBlock(p, ["#b8603a", "#d07848", "#e08c58", "#ee9e6a", "#f8b886"], "#9c4c2a", "#f8c498", { after: q => {
    q.fill((x, y) => { if (x === 15 || x === 16 || y === 15 || y === 16) { q.scale(x, y, x === 15 || y === 15 ? 0.78 : 1.1); } });
  } });
  p.relief(0.6);
};
function rawBlock(p, cols, spec) {
  plates(p, cols, 12, { edge: 1.1, edgeDark: 0.6 });
  specks(p, 16, spec, 0.6, 1.4, 0.6);
}
T.raw_iron_block = p => { rawBlock(p, ["#6e5240", "#86664e", "#9c7c62", "#b09278", "#c4a88e"], ["#e0b898", "#4a3626"]); p.relief(1.5); };
T.raw_gold_block = p => { rawBlock(p, ["#a67c10", "#c49a1c", "#dcb42c", "#ecc84a", "#f8dc72"], ["#fff0a0", "#7a5a0c"]); p.relief(1.5); };
T.raw_copper_block = p => { rawBlock(p, ["#7a4426", "#9a5a34", "#b66e44", "#cc8458", "#e09c70"], ["#f0b890", "#4cb08a", "#5a2e18"]); p.relief(1.5); };
T.amethyst_block = p => {
  plates(p, ["#5a3898", "#6c46ae", "#8056c4", "#966ad8", "#b48cf0"], 13, { edge: 0.9, edgeDark: 0.62 });
  specks(p, 6, ["#d0b0ff", "#e8d4ff"], 0.5, 1.0, 0.8);
  p.relief(1.2);
};

// ---------- item sprites ----------
SPRITES.lapis_lazuli = (G, m) => {
  for (const [cx, cy, rx, ry] of [[5, 6, 2.8, 2.4], [10.5, 7, 3, 2.6], [7.5, 11, 3.2, 2.6]]) blob(G, cx, cy, rx, ry, m, lighten(m, 0.6), 0.55, 0.3);
  for (const [x, y] of [[4, 5], [10, 6], [7, 10], [11, 8]]) put(G, x, y, hex("#9cb8ff"));
  for (const [x, y] of [[6, 7], [12, 8], [9, 12]]) put(G, x, y, mul(m, 0.7));
};
SPRITES.redstone = (G, m, p) => {
  const tones = ["#5a0808", "#8a1010", "#b81818", "#e02a2a", "#ff6a5a"].map(hex);
  for (let y = 5; y < 14; y++) for (let x = 2; x < 14; x++)
    if (Math.abs(x - 7.5) <= (y - 4.5) * 0.75 + (p.rand() - 0.5)) put(G, x, y, tones[Math.min(4, Math.max(0, (p.ri(3) + (y > 9 ? 0 : 2))))]);
};
const rawLump = spec => (G, m, p) => {
  blob(G, 8, 9, 5.6, 4.4, m, lighten(m, 0.35), 0.45, 0.25);
  blob(G, 4.5, 7, 2.8, 2.4, m, lighten(m, 0.35), 0.45);
  blob(G, 11, 6, 3, 2.5, m, lighten(m, 0.35), 0.45);
  for (let i = 0; i < 22; i++) { const x = 2 + p.ri(12), y = 4 + p.ri(10); if (G[y][x]) G[y][x] = hex(spec[p.ri(spec.length)]); }
};
SPRITES.raw_iron = rawLump(["#e0b898", "#6e5240", "#a07a5c"]);
SPRITES.raw_gold = rawLump(["#fff0a0", "#a67c10", "#e8c040"]);
SPRITES.raw_copper = rawLump(["#f0b890", "#4cb08a", "#7a4426"]);
SPRITES.amethyst_shard = (G, m) => {
  for (let i = 0; i <= 9; i++) {
    const x = 3 + i, y = 13 - i, w = i < 1 ? 0 : i < 8 ? 1 : 0;
    for (let k = -w; k <= w; k++) put(G, x + k, y, k < 0 ? lighten(m, 0.55) : k > 0 ? mul(m, 0.7) : m);
  }
  put(G, 12, 3, lighten(m, 0.8)); put(G, 13, 2, lighten(m, 0.6)); put(G, 3, 14, mul(m, 0.6)); put(G, 4, 13, mul(m, 0.7));
};
SPRITES.quartz = (G, m) => {
  blob(G, 8, 8, 6, 3, m, WHITE, 0.6, -0.75);
  for (let i = 0; i < 8; i++) put(G, 4 + i, 11 - i, lighten(m, 0.85));
  for (let i = 0; i < 6; i++) put(G, 6 + i, 12 - i, mul(m, 0.82));
};
})();
