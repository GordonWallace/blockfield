// Wood and colour family tiles (planks, stripped logs, wool, terracotta, concrete, glass, glazed terracotta, dyes).
// Painters are registered into the shared painter kit (BF.texKit, see textures.js) at load time, so this file must
// load after textures.js. Colour families are generated from BF.DYE_COLOURS (blocks.js) so 16 colours cost one loop.
(() => {
"use strict";
const BF = window.BF;
const K = BF.texKit;
const { T, SPRITES, TS, hex, pal, mul, mix, ramp, jit, WHITE, blob, put, stroke, lighten, planksBase, woolBase, barkSide, logTop,
  SPRITE_TILES, WOOD_OAK, WOOD_SPRUCE, WOOD_ACACIA } = K;
const toHex = c => "#" + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
// five-stop ramp (dark .. light) around a base colour, as hex strings (for woolBase / pal)
const stops = (c, lo = 0.72, hi = 0.24) => [mul(c, lo), mul(c, (1 + lo) / 2), c, mix(c, WHITE, hi / 2), mix(c, WHITE, hi)].map(toHex);

// ---------- planks (birch, jungle, dark oak, mangrove, cherry; oak/spruce/acacia live in textures.js) ----------
const PLANK_PAL = {
  birch: [["#a89a62", "#b9aa6f", "#c5b77c", "#d1c48a", "#dccf98"], "#6b5f3a"],
  jungle: [["#8f6444", "#a1744f", "#b0825a", "#bc8f66", "#c89c72"], "#4a3220"],
  dark_oak: [["#2b1b0c", "#352211", "#412b16", "#4b331c", "#573d22"], "#150d05"],
  mangrove: [["#5d2a29", "#6b3230", "#7a3b37", "#86443f", "#934e48"], "#331413"],
  cherry: [["#c99c92", "#d6aaa0", "#e1b8ae", "#ebc6bc", "#f3d2c9"], "#8a5f5a"],
};
for (const sp in PLANK_PAL) { const [cols, gap] = PLANK_PAL[sp]; T[sp + "_planks"] = p => { planksBase(p, pal(cols), gap); p.relief(1.3); }; }
const PLANK_COLS = { oak: WOOD_OAK, spruce: WOOD_SPRUCE, acacia: WOOD_ACACIA };
for (const sp in PLANK_PAL) PLANK_COLS[sp] = pal(PLANK_PAL[sp][0]);

// ---------- fences (inventory icon painters; the placed model uses the species planks tile) ----------
for (const sp of BF.WOOD_SPECIES) {
  if (sp === "oak") continue;
  const cols = PLANK_COLS[sp];
  T[sp + "_fence"] = p => {
    p.clear();
    const draw = (x, y, e) => {
      const t = p.noise(x, y, 2, 16, 290) * 0.6 + 0.2 + (e === 0 ? 0.25 : e === 1 ? -0.25 : 0);
      p.set(x, y, jit(p, ramp(cols, t), 0.05)); p.setH(x, y, 1);
    };
    for (let y = 0; y < TS; y++) for (let x = 12; x <= 19; x++) draw(x, y, x === 12 ? 0 : x === 19 ? 1 : 2);
    for (const y0 of [6, 18]) for (let y = y0; y < y0 + 6; y++) for (let x = 0; x < TS; x++) if (x < 12 || x > 19) draw(x, y, y === y0 ? 0 : y === y0 + 5 ? 1 : 2);
  };
  SPRITE_TILES.add(sp + "_fence");
}

// ---------- stripped logs (side + top) ----------
const STRIPPED = { // 5-stop side ramp, then log-top ring colours (outer ring, inner ring, core)
  oak: [["#8f7347", "#a0824f", "#ae9059", "#bb9d64", "#c6a96f"], "#b48f5c", "#9a7748", "#7d5e38"],
  spruce: [["#5e4a2e", "#6b5535", "#785f3d", "#866b46", "#93774f"], "#8a6a46", "#755838", "#5e452c"],
  birch: [["#ad9d63", "#bdad70", "#c9ba7e", "#d5c88c", "#e0d59a"], "#d4bf92", "#c0a97c", "#a89066"],
  jungle: [["#8c6a42", "#9c784d", "#aa8556", "#b79262", "#c29e6d"], "#ad8a58", "#977546", "#7c5f38"],
  acacia: [["#8e4a2e", "#9c5434", "#a95e3b", "#b66a44", "#c2774f"], "#c06e44", "#a85a34", "#8e4a2a"],
  dark_oak: [["#392a17", "#443320", "#503c26", "#5c462d", "#695135"], "#6e5234", "#5a4228", "#463220"],
  mangrove: [["#5e2828", "#6d3030", "#7a3838", "#874240", "#944c49"], "#a65e48", "#904c3a", "#763c2e"],
  cherry: [["#c69690", "#d3a39c", "#dfb0a8", "#e9bdb5", "#f2cbc3"], "#dcaaa2", "#c48e88", "#a87470"],
};
for (const sp in STRIPPED) {
  const [cols, ra, rb, co] = STRIPPED[sp], C = pal(cols);
  T["stripped_" + sp + "_log"] = p => {
    p.fill((x, y) => {
      const g = p.noise(x, y, 8, 2, 330), f = p.noise(x, y, 16, 4, 331), n = p.noise(x, y, 4, 1, 332);
      let t = 0.18 + g * 0.45 + f * 0.22 + (n - 0.5) * 0.2 + (p.rand() - 0.5) * 0.06;
      if (f < 0.22) t -= 0.22; // thin dark grain streaks
      p.set(x, y, jit(p, ramp(C, t), 0.04)); p.setH(x, y, 0.45 + g * 0.35);
    });
    p.relief(1.3);
  };
  T["stripped_" + sp + "_log_top"] = p => { logTop(p, [cols[1], cols[2], cols[3], cols[0]], ra, rb, co); p.relief(0.9); };
}

// ---------- 16-colour families ----------
const COLOURS = BF.DYE_COLOURS.map(([name, h]) => ({ name, rgb: hex(h) }));
const TERRA = { white: "#d0b2a2", orange: "#a0531c", magenta: "#95586c", light_blue: "#716d8a", yellow: "#b8852a", lime: "#677535", pink: "#a24e4f",
  gray: "#392a23", light_gray: "#876b62", cyan: "#575b5b", purple: "#764556", blue: "#4a3b5b", brown: "#4d3324", green: "#4c532a", red: "#8f3d2e", black: "#251610" };
COLOURS.forEach(({ name, rgb }, idx) => {
  // wool (white_wool / wool are painted in textures.js)
  if (name !== "white") T[name + "_wool"] = p => { woolBase(p, stops(rgb, 0.74, 0.22)); p.relief(0.8); };
  // terracotta: the five originals are in textures.js, the rest are painted the same way
  if (!T[name + "_terracotta"]) T[name + "_terracotta"] = p => {
    const b = hex(TERRA[name]);
    p.fill((x, y) => {
      const f = p.fbm(x, y, 3, 4, 300), band = p.noise(x, y, 1, 6, 301);
      p.set(x, y, jit(p, mul(b, 0.86 + f * 0.18 + band * 0.06), 0.05)); p.setH(x, y, f * 0.5);
    });
    for (let i = 0; i < 8; i++) p.set(p.ri(TS), p.ri(TS), mul(b, p.rand() < 0.5 ? 0.85 : 1.1));
    p.relief(0.6);
  };
  // concrete: smooth, slightly darker than wool, faint mottling
  T[name + "_concrete"] = p => {
    const b = mul(rgb, 0.92);
    p.fill((x, y) => {
      const f = p.fbm(x, y, 3, 3, 340), n = p.noise(x, y, 16, 16, 341);
      p.set(x, y, jit(p, mul(b, 0.95 + f * 0.1 + (n - 0.5) * 0.04), 0.025)); p.setH(x, y, f * 0.2);
    });
    for (let i = 0; i < 10; i++) { const x = p.ri(TS), y = p.ri(TS); p.set(x, y, mul(b, p.rand() < 0.5 ? 0.9 : 1.08)); }
    p.relief(0.4);
  };
  // concrete powder: grainy and lighter
  T[name + "_concrete_powder"] = p => {
    const b = mix(rgb, WHITE, 0.08);
    p.fill((x, y) => {
      const f = p.fbm(x, y, 4, 4, 350);
      p.set(x, y, jit(p, mul(b, 0.88 + f * 0.2), 0.16, 0.5)); p.setH(x, y, f * 0.6 + p.rand() * 0.2);
    });
    for (let i = 0; i < 40; i++) { const x = p.ri(TS), y = p.ri(TS); p.set(x, y, mul(b, p.rand() < 0.55 ? 0.8 : 1.15)); }
    p.relief(0.7);
  };
  // stained glass: tinted translucent pane (rendered in the transparent pass, see world.js), opaque frame
  T[name + "_stained_glass"] = p => {
    const b = rgb;
    p.fill((x, y) => {
      const e = Math.min(x, y, 31 - x, 31 - y);
      if (e === 0) p.set(x, y, mul(b, 0.72), 255);
      else if (e === 1) p.set(x, y, mix(b, WHITE, 0.12), 255);
      else p.set(x, y, jit(p, b, 0.03), 150);
      p.setH(x, y, 0);
    });
    for (const [x, y, n] of [[6, 11, 6], [7, 14, 3], [20, 26, 6], [22, 27, 2]]) for (let k = 0; k < n; k++) { p.set(x + k, y - k, mix(b, WHITE, 0.75), 215); p.set(x + k + 1, y - k, mix(b, WHITE, 0.5), 190); }
  };
  // glazed terracotta: symmetric bevelled pattern (square ring, diamond, core), variant by colour index
  T[name + "_glazed_terracotta"] = p => {
    const b = rgb, lt = mix(b, WHITE, 0.55), mid = mix(b, WHITE, 0.2), dk = mul(b, 0.6), v = idx % 4;
    p.fill((x, y) => {
      const dx = Math.abs(x - 15.5), dy = Math.abs(y - 15.5), m = Math.max(dx, dy), s = dx + dy;
      let c = b, h = 0.55;
      if (m > 14.5) { c = dk; h = 0.15; }
      else if (m > 13.5) { c = mid; h = 0.85; }
      else if (m > 9.5 + v * 0.5 && m < 11.5 + v * 0.5) { c = lt; h = 0.9; }
      else if (Math.abs(s - (9 - v)) < 1.4) { c = dk; h = 0.3; }
      else if (s < 3.5) { c = lt; h = 1; }
      else if (s < 5.5) { c = mid; h = 0.8; }
      else if (s > 21 + v) { c = mid; h = 0.65; }
      p.set(x, y, jit(p, c, 0.03)); p.setH(x, y, h);
    });
    p.relief(1.1);
  };
  // dye item sprite: a small pile
  SPRITES[name + "_dye"] = (G, m) => {
    const base = mix(m, WHITE, 0.1);
    blob(G, 7.5, 9, 5.4, 3.6, base, WHITE, 0.35, -0.2);
    blob(G, 6.5, 6.5, 3, 2.2, base, WHITE, 0.4, -0.3);
    for (const [x, y] of [[10, 10], [9, 11], [5, 10]]) put(G, x, y, mul(base, 0.78));
  };
});
T.tinted_glass = p => {
  const b = [48, 40, 58];
  p.fill((x, y) => {
    const e = Math.min(x, y, 31 - x, 31 - y);
    if (e === 0) p.set(x, y, mul(b, 0.6), 255);
    else if (e === 1) p.set(x, y, mix(b, WHITE, 0.15), 255);
    else p.set(x, y, jit(p, b, 0.04), 200);
    p.setH(x, y, 0);
  });
  for (const [x, y, n] of [[6, 11, 6], [7, 14, 3], [20, 26, 6], [22, 27, 2]]) for (let k = 0; k < n; k++) p.set(x + k, y - k, mix(b, WHITE, 0.4), 235);
};
SPRITES.bone_meal = (G, m) => {
  blob(G, 7.5, 9.5, 5.2, 3.2, m, WHITE, 0.4, -0.2);
  stroke(G, 4, 6, 9, 4, WHITE, WHITE);
  for (const [x, y] of [[3, 6], [3, 5], [10, 3], [10, 4], [9, 5]]) put(G, x, y, lighten(m, 0.6));
  for (const [x, y] of [[10, 10], [6, 11]]) put(G, x, y, mul(m, 0.8));
};
})();
