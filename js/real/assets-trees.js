// Realistic render mode: the tree species (BF.realSpecies.trees). Each is a real species, as a parameter set for a js/realistic/
// flora-kit.js builder plus a bark painter and a foliage-atlas painter. Which species stands where is js/realistic/biome-assets.js.
// A species: { id, name, latin, h: [min, max] (natural height in blocks), mats() -> { bark, foliage, depth } (made on first use, then
// shared), build(rand, h, detail, opts) -> { b: wood geometry, f: foliage geometry or undefined } } with the origin on the ground at the
// trunk. detail 1 = near (full), 0 = far (fewer, larger cards and coarser tubes; same silhouette).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || !BF.real.akit) return;
const K = BF.real.akit, T = globalThis.THREE, V3 = T.Vector3, TAU = Math.PI * 2;
const { rr, pick, hsl } = K;
const R = () => K.rand();
const WHITE = [1, 1, 1];

// ---------- leaf painters shared by several species ----------
// n leaflets radiating from the end of a petiole (kapok, cecropia with lobes, horse chestnut, lupine)
function palmate(g, x, y, ang, pl, L, n, fan, lo, col) {
  const ex = x + Math.sin(ang) * pl, ey = y - Math.cos(ang) * pl;
  g.globalAlpha = 1; g.strokeStyle = lo.stalk || "#7a8a48"; g.lineWidth = Math.max(1.5, L * 0.03); g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) - 0.5 : 0, o = Object.assign({ petiole: 0.02 }, lo); o.col = col();
    K.leaf(g, ex, ey, ang + f * fan + rr(-0.05, 0.05), L * (1 - 0.45 * Math.abs(f) * 2 * (lo.even ? 0 : 1)) * rr(0.92, 1.06), o);
  }
}
// a small pinnate leaf: a rachis with paired elliptic leaflets (acacia pinnae, locust, ash)
function pinnate(g, x, y, ang, L, n, w, col, rib) {
  g.save(); g.translate(x, y); g.rotate(ang); g.globalAlpha = 1;
  g.strokeStyle = rib; g.lineWidth = Math.max(0.8, L * 0.012); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -L); g.stroke();
  for (let j = 0; j < n; j++) for (let sd = -1; sd <= 1; sd += 2) {
    const t = (j + 0.7) / n, l = L * w * (1 - 0.35 * t);
    g.fillStyle = col(); g.beginPath(); g.ellipse(sd * l * 0.55, -t * L, l * 0.56, l * 0.2, sd * 0.3, 0, TAU); g.fill();
  }
  g.restore();
}
// a flower of n petals (blossom, dogwood bracts)
function blossom(g, x, y, r, n, cols, centre, notch) {
  const a0 = R() * TAU;
  for (let i = 0; i < n; i++) {
    const a = a0 + i / n * TAU;
    g.save(); g.translate(x, y); g.rotate(a);
    g.fillStyle = pick(cols); g.beginPath(); g.ellipse(0, -r * 0.55, r * (n <= 4 ? 0.42 : 0.36), r * 0.5, 0, 0, TAU); g.fill();
    if (notch) { g.fillStyle = notch; g.beginPath(); g.arc(0, -r * 1.02, r * 0.1, 0, TAU); g.fill(); }
    g.restore();
  }
  g.fillStyle = centre; g.beginPath(); g.arc(x, y, r * 0.16, 0, TAU); g.fill();
}
const green = (h0, h1, s0, s1, l0, l1) => () => hsl(rr(h0, h1), rr(s0, s1), rr(l0, l1));

// ---------- bark painters ----------
const BARK = {
  oak(P, o) {                      // deep interlacing ridges, grey-brown
    o = o || {};
    P.fill(o.base || "#6b6258", "#a0a0a0");
    P.grain(3000, o.grain || ["#3d352d", "#8a8072", "#544a40", "#7b7062", "#9a9082"], "#d8d8d8", 6, 40);
    P.furrows(150, [120, 480], [9, 22], 7, 16, o.dark || "#2a231d", o.warm || "#5a4030", "#9a9082");
    P.lenticels(220, [8, 30], [1.5, 4], ["#2a221b"], 0.7, "#202020");
    P.mottle(90, ["#8e9a84", "#7a8a62", "#a9ad9c", "#b9b6a2"], 3, 14, 0.12, 0.3);
  },
  birch(P) {                       // chalk-white, peeling, with dark lenticels and branch scars
    P.fill("#e8e5da", "#b8b8b8");
    P.mottle(900, ["#d9d5c8", "#f2f0e8", "#cfc8b8", "#e2d8cc", "#d8c8b8"], 4, 26, 0.1, 0.3);
    P.lenticels(520, [6, 70], [1.2, 3.6], ["#3a342e", "#5a5048", "#2c2824", "#7a6e62"], 0.85, "#505050");
    for (let i = 0; i < 26; i++) {                           // curls of peeling bark: a pale band with a shadow under it
      const x = R() * P.W, y = R() * P.H, len = rr(60, 220), d = P.dash(x, y, len, 3);
      P.poly(P.g, d, "#b9a48c", rr(3, 7), 0.5, 0); P.poly(P.g, d.map((v, k) => (k % 2 ? v - 4 : v)), "#faf8f2", rr(2, 4), 0.8); P.poly(P.h, d, "#e8e8e8", 5, 0.7);
    }
    for (let i = 0; i < 9; i++) {                            // black triangular scars under old branches
      const x = R() * P.W, y = R() * P.H, s = rr(14, 30);
      P.blob(P.g, x, y, s, s * 0.55, 0, "#1f1c19", 0.92); P.blob(P.h, x, y, s, s * 0.55, 0, "#282828", 0.9);
      for (let k = 1; k <= 3; k++) P.poly(P.g, [x - s * (1 + k * 0.5), y + k * 8 + 4, x, y - s * 0.5 - k * 5, x + s * (1 + k * 0.5), y + k * 8 + 4], "#3a3530", 2.2, 0.55);
    }
  },
  aspen(P) {                       // smooth greenish cream with black eyes and scars
    P.fill("#d3d4c0", "#b4b4b4");
    P.mottle(1100, ["#c4c7ae", "#dcdccc", "#b9bea4", "#cfd0b8", "#e4e2d2"], 4, 22, 0.08, 0.22);
    P.lenticels(160, [6, 34], [1.2, 3], ["#55524a", "#3a3832"], 0.7, "#484848");
    for (let i = 0; i < 12; i++) {
      const x = R() * P.W, y = R() * P.H, s = rr(10, 22);
      P.blob(P.g, x, y, s, s * 0.5, 0, "#22201c", 0.92); P.blob(P.g, x, y, s * 0.4, s * 0.2, 0, "#5a564c", 0.8); P.blob(P.h, x, y, s, s * 0.5, 0, "#303030", 0.9);
      for (let k = 1; k <= 3; k++) P.poly(P.g, [x - s * (1 + k * 0.5), y + k * 7 + 4, x - s * 0.4, y - k * 3, x, y - s * 0.6 - k * 4, x + s * 0.4, y - k * 3, x + s * (1 + k * 0.5), y + k * 7 + 4], "#3a3832", 2, 0.5);
    }
    P.mottle(14, ["#c8a040", "#b89a48"], 4, 10, 0.25, 0.5);
  },
  beech(P) {                       // smooth silver-grey with lichen blotches and faint horizontal wrinkles
    P.fill("#757a76", "#a8a8a8");
    P.mottle(1300, ["#666a66", "#878b85", "#70746e", "#8f918a", "#5e625c"], 4, 24, 0.08, 0.2);
    P.mottle(120, ["#a9b49a", "#8fa07c", "#c4c8b4", "#6f7f5c"], 8, 34, 0.12, 0.36, "#b0b0b0");
    P.lenticels(260, [10, 70], [1, 2.4], ["#5c605c", "#484c48"], 0.5, "#606060");
    P.furrows(14, [60, 200], [2, 4], 2, 14, "#3c403c");
  },
  fibrous(P, o) {                  // long stringy strips (bald cypress, junipers)
    o = o || {};
    P.fill(o.base || "#7d6a5c", "#909090");
    const cols = o.cols || ["#59483c", "#94806e", "#a89684", "#6a5648", "#8c7868", "#b0a090"];
    for (let i = 0; i < 950; i++) {
      const lw = rr(1.2, 5), pts = P.furrow(R() * P.W, R() * P.H, rr(180, 900), 1.8, 34);
      P.poly(P.g, pts, pick(cols), lw, rr(0.45, 0.9)); P.poly(P.h, pts, R() < 0.5 ? "#3a3a3a" : "#d4d4d4", lw, 0.6);
    }
    P.furrows(60, [250, 800], [4, 9], 2.4, 30, o.dark || "#2e2019", null, "#b39c88");
    P.mottle(40, ["#9a968c", "#8a9a82"], 10, 40, 0.06, 0.18);
  },
  plated(P, o) {                   // blocky or scaly plates (pines, spruces, dogwood, acacia)
    P.fill(o.base, "#a4a4a4");
    P.grain(2400, o.grain, "#d0d0d0", 5, 30);
    P.plates(o.cw, o.ch, o.lw, o.dark, o.jit || 10, 0.9);
    if (o.flake) P.mottle(o.flakeN || 160, o.flake, 6, 26, 0.2, 0.55, "#c8c8c8");
    P.mottle(60, ["#8f9a84", "#a9ad9c"], 3, 10, 0.1, 0.25);
  },
  smooth(P, o) {                   // thin smooth bark with horizontal lenticels or ring scars (cherry, kapok, cecropia, palms)
    P.fill(o.base, "#a8a8a8");
    P.mottle(1000, o.mottle, 4, 22, 0.08, 0.24);
    if (o.rings) for (let y = rr(0, o.rings); y < P.H; y += o.rings * rr(0.8, 1.2)) {
      const d = P.furrow(0, 0, 0, 0, 1); d.length = 0;
      for (let x = -10; x <= P.W + 10; x += 32) d.push(x, y + rr(-2.5, 2.5));
      P.poly(P.g, d, o.ringCol || "#5a554c", rr(2, 4.5), 0.75); P.poly(P.h, d, "#383838", 4, 0.8);
      P.poly(P.g, d.map((v, k) => (k % 2 ? v - 4 : v)), o.ringLight || "#c8c4b6", 1.6, 0.5);
    }
    if (o.lent) P.lenticels(o.lentN || 380, o.lentLen || [10, 80], [1.5, 4.5], o.lent, 0.85, "#d8d8d8");
    if (o.lichen) P.mottle(90, o.lichen, 8, 30, 0.14, 0.4);
    if (o.cracks) P.furrows(o.cracks, [80, 300], [2, 5], 2.5, 16, o.crackCol || "#2a2420");
  },
  // one rib of a columnar cactus per tile: a rounded green ridge, grooves at the left and right edges, areoles with spines down the crest
  cactus(P, o) {
    const g = P.g, h = P.h, W = P.W, H = P.H;
    const gr = g.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, o.groove); gr.addColorStop(0.22, o.mid); gr.addColorStop(0.5, o.crest); gr.addColorStop(0.78, o.mid); gr.addColorStop(1, o.groove);
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const hg = h.createLinearGradient(0, 0, W, 0);
    hg.addColorStop(0, "#202020"); hg.addColorStop(0.5, "#e0e0e0"); hg.addColorStop(1, "#202020");
    h.fillStyle = hg; h.fillRect(0, 0, W, H);
    P.mottle(500, o.mottle, 3, 16, 0.06, 0.2);
    P.mottle(30, ["#8a7a52", "#6a5a3a", "#a09060"], 4, 14, 0.2, 0.5);                     // corky scars
    for (let y = o.gap * 0.5; y < H; y += o.gap) {
      const x = W / 2 + rr(-3, 3);
      P.blob(g, x, y, o.ar, o.ar * 0.8, 0, "#cbbf9e", 0.95); P.blob(h, x, y, o.ar, o.ar, 0, "#f0f0f0", 0.9);
      for (let k = 0; k < o.spines; k++) {
        const a = rr(0, TAU), l = rr(o.sl * 0.5, o.sl);
        P.poly(g, [x, y, x + Math.cos(a) * l, y + Math.sin(a) * l * 0.8], pick(o.spineCol), rr(1, 2), rr(0.6, 0.95));
      }
    }
  },
};

// ---------- foliage atlases (2 x 2 cells) ----------
const ATLAS = {
  // lobed oak leaves; o: { hue, lobes, lobeD, pos }
  oak: o => K.atlas(2, (g, i, S) => K.leafySpray(g, S, {
    n: 7, L: [112, 150], stem: "#4a3d30", stemW: 5, ang: [0.6, 1.05],
    leaf: { w: o.w || 0.3, pos: o.pos || 0.6, lobes: o.lobes || 3.5, lobeD: o.lobeD || 0.5, nv: 6, petiole: 0.08, flaw: 0.3, veinRise: 0.14 },
    col: green(o.hue[0], o.hue[1], 38, 52, i === 3 ? 30 : 23, i === 3 ? 38 : 33),
  })),
  // simple leaves along a twig; o: leafySpray options with hue / sat / lit ranges
  simple: o => K.atlas(2, (g, i, S) => K.leafySpray(g, S, Object.assign({}, o, {
    col: () => (o.autumn && i === 3 && R() < o.autumn ? hsl(rr(48, 62), rr(60, 75), rr(42, 50)) : hsl(rr(o.hue[0], o.hue[1]), rr(o.sat[0], o.sat[1]), rr(o.lit[0], o.lit[1]))),
  }))),
  // needle sprays; o: { C, step, ang, nl, sp, lw, brush, stem }
  needle: o => K.atlas(2, (g, i, S) => {
    const P = { woody: 3, maxDepth: 2, step: [o.step[0] + i * 3, o.step[1]], ang: o.ang + i * 0.03, ratio: 0.5, minLen: 12, stem: o.stem, stemW: o.stemW || 5,
      leaf(g2, x, y, dx, dy, ang, len, depth) { K.needles(g2, x, y, dx, dy, ang, len, depth ? 2 : len * 0.2, o.nl, o.sp, o.lw, o.C, o.brush, o.splay); } };
    K.spray(g, S / 2, S - 6, rr(-0.04, 0.04), S * 0.925, 0, P);
  }),
};

// =====================================================================
//  SPECIES
// =====================================================================
const trees = {};
function def(id, s) {
  let mats = null;
  const sp = {
    id, name: s.name, latin: s.latin, h: s.h, form: s.form, note: s.note || "",
    mats() {
      if (mats) return mats;
      return K.withRand(K.mulberry(hashStr(id)), () => {
        const bt = s.bark(), at = s.atlas ? s.atlas() : null;
        mats = { bark: K.barkMat(bt, s.bump == null ? 0.04 : s.bump, s.rough), foliage: at ? K.foliageMat(at, s.trans == null ? 0.3 : s.trans) : null, depth: at ? K.depthMat(at) : null };
        return mats;
      });
    },
    build(rand, h, detail, opts) {
      const H = h || (s.h[0] + s.h[1]) / 2;
      return K.withRand(rand, () => s.build(H, detail === undefined ? 1 : detail, opts || {}));
    },
  };
  trees[id] = sp;
  return sp;
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h | 0; }

// wood tint per branch depth: trunk, limb, branch, twig
const WOOD = [WHITE, [0.95, 0.95, 0.93], [0.8, 0.78, 0.74], [0.55, 0.47, 0.4]];

// ---- oaks: short trunk, heavy spreading limbs, rounded crown wider than tall ----
function oakForm(H, o) {
  o = o || {};
  return { h: H, r: H * (o.r || 0.05), trunk: o.trunk || 0.42, lean: 0.06, jit: 0.05, np: o.np || 9, t0: 0.5, e0: o.e0 == null ? 0.3 : o.e0, e1: 1.15, len: o.len || 0.46, lenTop: 0.7,
    flare: 0.7, flareH: H * 0.045, lobes: 5, crown: { y: 0.66, rx: 0.5, ry: 0.36 }, top: H * 0.3, limbR: 0.62,
    S: { maxD: 3, n: [0, 5, 3, 1], seg: [0, 6, 4, 3], kids: [0, 5, 4], ratio: 0.6, spread: 0.85, up: 0.22, jit: 0.1, bend: [0, t => (t < 0.5 ? 0.09 : -0.05), 0.02, 0], t0: 0.3,
      cards: 7, cardLen: H * (o.card || 0.115), cells: [0, 1, 2, 3], flat: false, droop: 0.22, col: WOOD } };
}
def("bur_oak", {
  name: "Bur oak", latin: "Quercus macrocarpa", h: [8, 14], form: "broadleaf", note: "the lone spreading oak of the tallgrass prairie",
  bark: () => K.barkTex(P => BARK.oak(P)), bump: 0.06,
  atlas: () => ATLAS.oak({ hue: [86, 104], lobes: 3.2, lobeD: 0.55, pos: 0.64, w: 0.32 }), trans: 0.35,
  build: (H, d) => K.broadleaf(oakForm(H), d),
});
def("english_oak", {
  name: "English oak", latin: "Quercus robur", h: [8, 13], form: "broadleaf", note: "the lighter tree of the old beech-oak wood",
  bark: () => K.barkTex(P => BARK.oak(P, { base: "#63594e", dark: "#241d18", warm: "#4c3a2c" })), bump: 0.06,
  atlas: () => ATLAS.oak({ hue: [92, 112], lobes: 4.5, lobeD: 0.42, pos: 0.58, w: 0.27 }), trans: 0.35,
  build: (H, d) => K.broadleaf(oakForm(H, { trunk: 0.48, e0: 0.3, len: 0.42 }), d),
});

// ---- birch and aspen: one slender pale stem, light open crown of ascending branches ----
function birchForm(H, o) {
  o = o || {};
  return { h: H, r: H * (o.r || 0.022), trunk: 0.95, lean: o.lean == null ? 0.08 : o.lean, jit: 0.04, np: o.np || 15, t0: o.t0 || 0.38, e0: o.e0 == null ? 0.5 : o.e0, e1: 1.05, len: o.len || 0.24, lenTop: 0.4,
    flare: 0.5, flareH: H * 0.03, taper: 0.82, base: o.base || [0.55, 0.52, 0.45], crown: { y: 0.7, rx: 0.26, ry: 0.34 }, top: H * 0.1, limbR: 0.42,
    S: { maxD: 3, n: [0, 4, 3, 1], seg: [0, 5, 3, 3], kids: [0, 5, 4], ratio: 0.55, spread: 0.75, up: o.up == null ? 0.2 : o.up, jit: 0.07, bend: [0, o.bend == null ? -0.02 : o.bend, -0.04, o.weep || 0], t0: 0.3,
      cards: 6, cardLen: H * (o.card || 0.075), cells: [0, 1, 2, 3], flat: false, droop: o.droop || 0.35, col: [WHITE, [0.95, 0.95, 0.93], [0.62, 0.52, 0.45], [0.4, 0.3, 0.26]] } };
}
def("paper_birch", {
  name: "Paper birch", latin: "Betula papyrifera", h: [8, 13], form: "broadleaf", note: "white peeling bark; the northern hardwood forest",
  bark: () => K.barkTex(BARK.birch), bump: 0.014, rough: 0.8,
  atlas: () => ATLAS.simple({ n: 8, L: [84, 112], stem: "#4a2e26", stemW: 3.5, ang: [0.75, 1.2], hue: [84, 104], sat: [42, 56], lit: [27, 37], autumn: 0.45,
    leaf: { w: 0.36, pos: 0.34, tip: 0.45, teeth: 0.14, nv: 8, petiole: 0.2, flaw: 0.2 } }), trans: 0.48,
  build: (H, d) => K.broadleaf(birchForm(H, { weep: -0.06, droop: 0.45 }), d),
});
def("quaking_aspen", {
  name: "Quaking aspen", latin: "Populus tremuloides", h: [8, 13], form: "broadleaf", note: "pale-stemmed groves at the edge of mountain meadows",
  bark: () => K.barkTex(BARK.aspen), bump: 0.012, rough: 0.82,
  atlas: () => ATLAS.simple({ n: 8, L: [66, 88], stem: "#5a5038", stemW: 3, ang: [0.7, 1.25], hue: [88, 106], sat: [40, 54], lit: [31, 41], autumn: 0.5,
    leaf: { w: 0.5, pos: 0.4, tip: 0.2, teeth: 0.06, nv: 5, petiole: 0.42, veinRise: 0.22 } }), trans: 0.52,
  build: (H, d) => K.broadleaf(birchForm(H, { t0: 0.5, np: 14, len: 0.19, e0: 0.6, base: [0.42, 0.42, 0.38], card: 0.062, droop: 0.2, up: 0.3 }), d),
});

// ---- European beech: tall smooth grey column, high dense dome that shades everything under it ----
def("european_beech", {
  name: "European beech", latin: "Fagus sylvatica", h: [11, 17], form: "broadleaf", note: "smooth grey boles under a closed, dark canopy",
  bark: () => K.barkTex(BARK.beech), bump: 0.01, rough: 0.8,
  atlas: () => ATLAS.simple({ n: 9, L: [84, 108], stem: "#4a4036", stemW: 3.5, ang: [0.8, 1.2], hue: [98, 118], sat: [44, 58], lit: [20, 29],
    leaf: { w: 0.31, pos: 0.44, tip: 0.3, teeth: 0.04, nv: 9, petiole: 0.1, gloss: 1, veinRise: 0.12 } }), trans: 0.42,
  build: (H, d) => K.broadleaf({ h: H, r: H * 0.042, trunk: 0.6, lean: 0.03, jit: 0.03, np: 13, t0: 0.45, e0: 0.35, e1: 1.2, len: 0.4, lenTop: 0.75,
    flare: 0.9, flareH: H * 0.035, lobes: 6, base: [0.75, 0.95, 0.6], crown: { y: 0.72, rx: 0.42, ry: 0.32 }, top: H * 0.25, limbR: 0.55,
    S: { maxD: 3, n: [0, 5, 3, 1], seg: [0, 6, 4, 3], kids: [0, 6, 4], ratio: 0.58, spread: 0.8, up: 0.16, jit: 0.07, bend: [0, 0.03, -0.02, 0], t0: 0.25,
      cards: 7, cardLen: H * 0.085, cells: [0, 1, 2, 3], flat: true, droop: 0.2, col: [WHITE, WHITE, [0.85, 0.85, 0.82], [0.55, 0.5, 0.45]] } }, d),
});

// ---- bald cypress: fluted, buttressed base in standing water, knees, feathery crown hung with Spanish moss ----
def("bald_cypress", {
  name: "Bald cypress", latin: "Taxodium distichum", h: [10, 18], form: "conifer", note: "buttressed trunks, knees and Spanish moss in blackwater",
  bark: () => K.barkTex(P => BARK.fibrous(P, { base: "#84705f" })), bump: 0.035,
  atlas: () => K.atlas(2, (g, i, S) => {
    if (i === 3) {                                         // Spanish moss (Tillandsia usneoides): grey-green strands; the cell's bottom hangs from the limb
      for (let k = 0; k < 46; k++) {
        let x = S / 2 + rr(-26, 26), y = S - 6;
        const len = rr(0.45, 0.95) * S, drift = rr(-0.5, 0.5);
        g.strokeStyle = pick(["#9aa392", "#8a9484", "#b0b6a6", "#7c8778", "#a4aa98"]); g.lineWidth = rr(1.6, 3.6); g.globalAlpha = rr(0.75, 1);
        g.beginPath(); g.moveTo(x, y);
        for (let s = 0; s < len; s += 14) { x += rr(-7, 7) + drift * 3; y -= 14; x = Math.max(40, Math.min(S - 40, x)); g.lineTo(x, y); }
        g.stroke();
      }
      g.globalAlpha = 1; return;
    }
    const C = { dark: ["#3f6a2c", "#467432"], mid: ["#5a8a38", "#66963e", "#528236"], tip: ["#86ac4c", "#94b856", "#7aa244"] };
    const P = { woody: 2, maxDepth: 2, step: [34 + i * 3, 20], ang: 0.9, ratio: 0.55, minLen: 14, stem: "#6a4e36", stemW: 4,
      leaf(g2, x, y, dx, dy, ang, len, depth) { K.needles(g2, x, y, dx, dy, ang, len, depth ? 2 : len * 0.25, 12, 3.2, 1.7, C, 0.05, 0.95); } };
    K.spray(g, S / 2, S - 6, rr(-0.04, 0.04), S * 0.92, 0, P);
  }), trans: 0.45,
  build(H, d, o) {
    const t = K.conifer({ h: H, r: H * 0.034, clear: 0.4, L: H * 0.34, pw: 0.4, low: 3.5, dy: H * 0.017, gap: 0.06, card: H * 0.11, cw: 0.8, cardY: -0.1, droop: 0.25, vee: -0.2, fwd: 0.7,
      flare: 2.1, flareH: H * 0.075, lobes: 7, e0: 0.05, e1: 0.5, stubs: 3, leader: false, minL: H * 0.05, taper: 0.7, sway: 0.1, cells: [0, 1, 2],
      base: [0.62, 0.66, 0.6], bend: tt => (tt < 0.5 ? 0.02 : -0.08), moss: { p: 0.5, len: H * 0.13, cell: 3 } }, d);
    return t;
  },
});

// ---- red mangrove: a crown held above the tide on arching prop roots ----
def("red_mangrove", {
  name: "Red mangrove", latin: "Rhizophora mangle", h: [5, 9], form: "mangrove", note: "stilt roots over brackish water; opts.root = height of the stilts",
  bark: () => K.barkTex(P => BARK.smooth(P, { base: "#74655a", mottle: ["#5c5048", "#8a7c70", "#6a5a4e", "#93867a", "#7c5a4a"], cracks: 60, lichen: ["#a8a89a", "#8a947c"] })), bump: 0.02,
  atlas: () => ATLAS.simple({ n: 6, L: [92, 120], stem: "#6a5a40", stemW: 5, ang: [0.5, 0.95], opp: 1, hue: [100, 122], sat: [40, 54], lit: [20, 29], autumn: 0.25,
    leaf: { w: 0.24, pos: 0.52, tip: 0.05, nv: 0, petiole: 0.12, gloss: 1, vein: "rgba(190,205,120,0.9)" } }), trans: 0.2,
  build(H, d, o) {
    const B = new K.Geo(), F = new K.Geo(), root = o.root == null ? Math.max(1.2, H * 0.3) : Math.max(0.6, o.root), r0 = H * 0.022 + 0.05;
    const cc = { x: 0, y: root + (H - root) * 0.6, z: 0, rx: H * 0.45, ry: (H - root) * 0.5 }, hub = new V3(rr(-0.15, 0.15), root, rr(-0.15, 0.15));
    const rc = [0.92, 0.72, 0.6];                                              // prop roots run redder than the trunk
    const nr = d ? 9 : 5;
    let az = rr(0, TAU);
    for (let k = 0; k < nr; k++) {                                              // prop roots: out and over in an arc, then straight down
      az += TAU / nr + rr(-0.3, 0.3);
      const out = rr(0.5, 1.15) * (0.5 + root * 0.45), y0 = root * rr(0.55, 1.05), n = 6, pts = [], rad = [];
      for (let s = 0; s <= n; s++) {
        const t = s / n, a = t * Math.PI * 0.5;
        pts.push(new V3(hub.x + Math.cos(az) * out * Math.sin(a) + rr(-0.03, 0.03), y0 + (root * 0.12) * Math.sin(a * 2) - (y0 + 0.5) * (1 - Math.cos(a)), hub.z + Math.sin(az) * out * Math.sin(a) + rr(-0.03, 0.03)));
        rad.push(r0 * (0.55 - 0.25 * t));
      }
      K.tube(B, pts, rad, d ? 5 : 3, { col: () => rc });
      if (d && R() < 0.6) {                                                     // a second arch off the first
        const p = pts[3], a2 = az + rr(-0.9, 0.9), o2 = out * rr(0.35, 0.6);
        K.tube(B, [p.clone(), new V3(p.x + Math.cos(a2) * o2 * 0.6, p.y - 0.05, p.z + Math.sin(a2) * o2 * 0.6), new V3(p.x + Math.cos(a2) * o2, p.y - (p.y + 0.5) * 0.5, p.z + Math.sin(a2) * o2), new V3(p.x + Math.cos(a2) * o2 * 1.05, -0.5, p.z + Math.sin(a2) * o2 * 1.05)],
          [r0 * 0.3, r0 * 0.27, r0 * 0.22, r0 * 0.18], 3, { col: () => rc });
      }
    }
    const S = { maxD: 3, n: [5, 4, 3, 1], seg: [d ? 7 : 5, 5, 3, 3], kids: [4, 4, 3], ratio: 0.6, spread: 0.85, up: 0.12, jit: 0.1, bend: [0.02, -0.02, 0, 0], t0: 0.35,
      cards: d ? 5 : 3, cardLen: H * (d ? 0.075 : 0.11), cells: [0, 1, 2, 3], flat: false, droop: 0.15, col: WOOD };
    // the trunk proper starts where the roots meet, then breaks early into a low, wide crown
    const ns = 3;
    for (let k = 0; k < ns; k++) {
      az += TAU / ns + rr(-0.5, 0.5);
      K.branch(B, F, S, hub.clone().add(new V3(0, -0.25, 0)), K.dirOf(az, rr(0.85, 1.25)), (H - root) * rr(0.8, 1.05), r0 * 0.9, 0, cc);
    }
    if (d) for (let k = 0; k < 5; k++) {                                        // aerial roots dropping from the limbs
      az += 2.4; const rad2 = rr(0.3, 1) * H * 0.25, x = Math.cos(az) * rad2, z = Math.sin(az) * rad2, y1 = root + (H - root) * rr(0.25, 0.5);
      K.tube(B, [new V3(x, y1, z), new V3(x + rr(-0.05, 0.05), y1 * 0.5, z + rr(-0.05, 0.05)), new V3(x, -0.4, z)], [0.022, 0.02, 0.018], 3, { col: () => rc });
    }
    return { b: K.toGeo(B, false), f: K.toGeo(F, true) };
  },
});

// ---- saguaro and tree cholla: ribbed columns ----
def("saguaro", {
  name: "Saguaro", latin: "Carnegiea gigantea", h: [3, 9], form: "succulent", note: "the Sonoran Desert's columnar cactus; arms only on tall, old plants",
  bark: () => K.barkTex(P => BARK.cactus(P, { groove: "#2c4426", mid: "#557a40", crest: "#7a9a58", mottle: ["#4a6a38", "#6a8a4c", "#86a264"], gap: 36, ar: 5, spines: 9, sl: 22, spineCol: ["#d8d2bc", "#a89a80", "#f0ece0", "#7a6a58"] }), { w: 128, h: 512 }),
  bump: 0.05, rough: 0.7,
  build(H, d, o) {
    const arms = o.arms == null ? (H > 5.5 ? 2 + ((R() * 3) | 0) : H > 4 ? (R() * 2) | 0 : 0) : o.arms;
    return K.succulent({ h: H, r: Math.min(0.34, 0.2 + H * 0.02), ribs: 14, arms, armAt: [0.3, 0.55], armLen: [H * 0.18, H * 0.42], depth: 0.16 }, d);
  },
});
def("tree_cholla", {
  name: "Tree cholla", latin: "Cylindropuntia imbricata", h: [1.4, 3], form: "succulent", note: "the branching cane cactus of the high plateau",
  bark: () => K.barkTex(P => BARK.cactus(P, { groove: "#35482c", mid: "#5c7646", crest: "#86986a", mottle: ["#4c6238", "#70885a"], gap: 22, ar: 4, spines: 12, sl: 34, spineCol: ["#e8e0c4", "#c8b88c", "#f4f0e2", "#b09a6a"] }), { w: 128, h: 512 }),
  bump: 0.07, rough: 0.75,
  build(H, d) {
    return K.succulent({ h: H, r: 0.085 + H * 0.012, ribs: 7, arms: 3 + ((R() * 4) | 0), armAt: [0.3, 0.9], armLen: [H * 0.2, H * 0.5], depth: 0.2 }, d);
  },
});

// ---- umbrella thorn: bare forked trunk under a flat, layered parasol ----
def("umbrella_thorn", {
  name: "Umbrella thorn", latin: "Vachellia tortilis", h: [5, 9], form: "broadleaf", note: "the flat-topped acacia of the East African savanna",
  bark: () => K.barkTex(P => BARK.plated(P, { base: "#5c5148", grain: ["#3a322c", "#7a6e62", "#4a4038", "#8a7e70"], cw: 58, ch: 150, lw: 9, dark: "#231d19", jit: 14 })), bump: 0.06,
  atlas: () => K.atlas(2, (g, i, S) => {
    const k0 = S / 512, n = 6, pts = [];
    let x = S / 2, y = S - 6, a = rr(-0.1, 0.1), side = R() < 0.5 ? 1 : -1;
    for (let k = 0; k < n; k++) { pts.push([x, y, a]); x += Math.sin(a) * 74 * k0; y -= Math.cos(a) * 74 * k0; a += rr(-0.22, 0.22) + (x < S * 0.4 ? 0.15 : x > S * 0.6 ? -0.15 : 0); }
    g.strokeStyle = "#5a4636"; g.lineWidth = 4 * k0; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < n; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
    const col = green(72, 96, 36, 50, 30, 40);
    for (let k = 1; k < n; k++) {
      for (let q = 0; q < 2; q++) {                               // paired white thorns at each node
        g.strokeStyle = "#e4dcc8"; g.lineWidth = 1.6 * k0; const ta = pts[k][2] + (q ? 1 : -1) * rr(0.9, 1.3);
        g.beginPath(); g.moveTo(pts[k][0], pts[k][1]); g.lineTo(pts[k][0] + Math.sin(ta) * 24 * k0, pts[k][1] - Math.cos(ta) * 24 * k0); g.stroke();
      }
      // a bipinnate leaf: a short stalk carrying 4-6 pairs of pinnae, each with many tiny leaflets
      for (let q = 0; q < 2; q++) {
        const la = pts[k][2] + side * rr(0.5, 1.2), L = rr(110, 150) * k0, np = 5;
        for (let j = 0; j < np; j++) for (let sd = -1; sd <= 1; sd += 2) {
          const t = (j + 0.8) / np, bx = pts[k][0] + Math.sin(la) * L * t, by = pts[k][1] - Math.cos(la) * L * t;
          pinnate(g, bx, by, la + sd * rr(0.75, 1.0), L * 0.42 * (1 - 0.25 * t), 9, 0.2, col, "#6f7a3a");
        }
        g.strokeStyle = "#6f7a3a"; g.lineWidth = 1.6 * k0; g.beginPath(); g.moveTo(pts[k][0], pts[k][1]); g.lineTo(pts[k][0] + Math.sin(la) * L, pts[k][1] - Math.cos(la) * L); g.stroke();
        side = -side;
      }
    }
  }), trans: 0.4,
  build: (H, d) => K.broadleaf({ h: H, r: H * 0.042, trunk: 0.56, lean: 0.14, jit: 0.07, np: 5, t0: 0.72, e0: 0.5, e1: 0.95, len: 0.62, lenTop: 0.8,
    flare: 0.5, flareH: H * 0.04, base: [0.9, 0.85, 0.75], crown: { y: 0.9, rx: 0.7, ry: 0.14 }, top: H * 0.3, limbR: 0.68,
    S: { maxD: 3, n: [0, 6, 4, 1], seg: [0, 6, 4, 3], kids: [0, 5, 4], ratio: 0.62, spread: 0.9, up: 0.3, jit: 0.12, bend: [0, t => (t < 0.45 ? 0.05 : -0.16), -0.06, 0], t0: 0.4,
      cards: 7, cardLen: H * 0.11, cells: [0, 1, 2, 3], flat: true, droop: 0.05, flatTop: H * 0.94, col: WOOD } }, d),
});

// ---- the rainforest: kapok emergent, cecropia in the gaps, acai palms beneath ----
def("kapok", {
  name: "Kapok", latin: "Ceiba pentandra", h: [22, 34], form: "broadleaf", note: "the buttressed emergent that stands above the canopy",
  bark: () => K.barkTex(P => BARK.smooth(P, { base: "#96958a", mottle: ["#84857a", "#a8a89c", "#7c8272", "#b4b2a4", "#8e9a80"], rings: 150, ringCol: "#6c6c62", lichen: ["#7f9a6a", "#a9b89a", "#d0cdbc", "#c8a890"], cracks: 30, crackCol: "#4a4a42" })), bump: 0.018,
  atlas: () => K.atlas(2, (g, i, S) => {
    const k0 = S / 512, col = green(96, 118, 42, 55, 22, 31), pts = [];
    let x = S / 2, y = S - 6, a = rr(-0.08, 0.08), side = R() < 0.5 ? 1 : -1;
    for (let k = 0; k < 4; k++) { pts.push([x, y, a]); x += Math.sin(a) * 105 * k0; y -= Math.cos(a) * 105 * k0; a += rr(-0.15, 0.15); }
    g.strokeStyle = "#5a5040"; g.lineWidth = 6 * k0; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < 4; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
    const lo = { w: 0.15, pos: 0.55, tip: 0.5, nv: 9, gloss: 1, stalk: "#8a7a48" };
    for (let k = 1; k < 4; k++) { palmate(g, pts[k][0], pts[k][1], pts[k][2] + side * rr(0.7, 1.1), rr(50, 80) * k0, rr(120, 150) * k0, 7, 2.4, lo, col); side = -side; }
    palmate(g, pts[3][0], pts[3][1], pts[3][2] - side * 0.5, 50 * k0, 130 * k0, 6, 2.2, lo, col);
  }), trans: 0.32,
  build: (H, d) => K.broadleaf({ h: H, r: H * 0.03, trunk: 0.78, lean: 0.02, jit: 0.025, np: 10, t0: 0.78, e0: 0.05, e1: 0.85, len: 0.34, lenTop: 0.85,
    flare: 3.4, flareH: H * 0.075, lobes: 5, taper: 0.4, base: [0.8, 0.95, 0.7], crown: { y: 0.88, rx: 0.42, ry: 0.16 }, top: H * 0.16, limbR: 0.6,
    S: { maxD: 3, n: [0, 6, 4, 1], seg: [0, 7, 4, 3], kids: [0, 6, 4], ratio: 0.6, spread: 0.85, up: 0.2, jit: 0.1, bend: [0, t => (t < 0.5 ? 0.06 : -0.06), 0, 0], t0: 0.3,
      cards: 7, cardLen: H * 0.07, cells: [0, 1, 2, 3], flat: true, droop: 0.2, flatTop: H * 1.0, col: WOOD } }, d),
});
def("cecropia", {
  name: "Trumpet tree", latin: "Cecropia peltata", h: [8, 16], form: "broadleaf", note: "pale ringed stems and great hand-shaped leaves, silver beneath",
  bark: () => K.barkTex(P => BARK.smooth(P, { base: "#a39f92", mottle: ["#8f8c80", "#b6b3a6", "#989888", "#c4c0b2"], rings: 60, ringCol: "#5c5a50", lichen: ["#d8d4c4", "#c0a898", "#8a9a7a"] })), bump: 0.02,
  atlas: () => K.atlas(2, (g, i, S) => {
    const k0 = S / 512, silver = i === 3, cx = S / 2 + rr(-10, 10), cy = S * 0.5, n = 9, a0 = rr(-0.2, 0.2);
    g.strokeStyle = "#8a8a5a"; g.lineWidth = 7 * k0; g.beginPath(); g.moveTo(S / 2, S - 6); g.lineTo(cx, cy); g.stroke();
    const col = silver ? () => hsl(rr(80, 100), rr(10, 18), rr(62, 74)) : green(92, 112, 40, 52, 24, 33);
    for (let k = 0; k < n; k++) {
      const a = a0 + k / n * TAU, L = (Math.cos(a) > -0.3 ? rr(205, 232) : rr(165, 195)) * k0;
      K.leaf(g, cx, cy, a, L, { w: 0.2, pos: 0.66, tip: 0.1, nv: 10, petiole: 0, col: col(), vein: silver ? "rgba(150,150,110,0.9)" : "rgba(215,225,160,0.95)", veinRise: 0.1 });
    }
    g.fillStyle = silver ? "#c8c8a8" : "#c8d290"; g.beginPath(); g.arc(cx, cy, 8 * k0, 0, TAU); g.fill();
  }), trans: 0.5,
  build: (H, d) => K.broadleaf({ h: H, r: H * 0.018 + 0.03, trunk: 0.8, lean: 0.12, jit: 0.035, np: 7, t0: 0.6, e0: 0.5, e1: 1.0, len: 0.24, lenTop: 0.8,
    flare: 0.6, flareH: 0.3, taper: 0.45, crown: { y: 0.85, rx: 0.3, ry: 0.18 }, top: H * 0.08, limbR: 0.7,
    S: { maxD: 2, n: [0, 4, 2], seg: [0, 5, 4], kids: [0, 3], ratio: 0.6, spread: 0.8, up: 0.4, jit: 0.06, bend: [0, 0.1, 0.08], t0: 0.45,
      cards: 7, cardLen: H * 0.085 + 0.25, cardW: 1, cells: [0, 1, 2, 0, 1, 2, 3], flat: true, droop: 0.3, col: [WHITE, WHITE, [0.9, 0.92, 0.85]] } }, d),
});
def("acai_palm", {
  name: "Açaí palm", latin: "Euterpe oleracea", h: [5, 11], form: "palm", note: "slender grey stems and drooping feather fronds in the understorey",
  bark: () => K.barkTex(P => BARK.smooth(P, { base: "#8c867a", mottle: ["#7a7468", "#9e988c", "#6e6a60", "#a8a498"], rings: 42, ringCol: "#55504a", lichen: ["#b8b8a8", "#8a9a7a"] })), bump: 0.02,
  atlas: () => K.atlas(2, (g, i, S) => {
    const dead = i === 3;
    K.frondCell(g, S, { n: 30, len: 0.36, w: 0.055, ang: 1.25, sweep: 1.3, taper: 0.5, peak: 0.6, base: 0.14, curve: 0.06, droop: dead ? 1.2 : 0.7, rib: dead ? "#8a6a3a" : "#7a8a3c", ribW: 0.016,
      col: dead ? () => hsl(rr(30, 42), rr(35, 50), rr(30, 42)) : green(94, 116, 42, 56, 23, 33), mid: dead ? null : "rgba(200,220,140,0.5)" });
  }), trans: 0.45,
  build: (H, d) => K.palm({ h: H * 0.78, r: 0.07 + H * 0.006, lean: 0.14, bulge: 0.5, fronds: 15, fl: H * 0.34 + 1.1, fw: 0.5, droop: 0.55, cells: [0, 1, 2], skirt: 2, deadCell: 3,
    e0: -0.15, e1: 1.15, vee: 0.35, rows: 6, crownshaft: [0.55, 0.85, 0.4] }, d),
});

// ---- black spruce: a narrow, ragged spire with a clubbed top, stunted on frozen ground ----
const SPRUCE_C = { dark: ["#1c3428", "#22402e", "#1b362a"], mid: ["#2e5644", "#346048", "#2a5040", "#3a684c"], tip: ["#4f7e64", "#5a8c6c", "#689a76"] };
def("black_spruce", {
  name: "Black spruce", latin: "Picea mariana", h: [5, 11], form: "conifer", note: "thin, dark spires scattered over the snowfields",
  bark: () => K.barkTex(P => BARK.plated(P, { base: "#5a4c46", grain: ["#3a2f2a", "#75645a", "#4a3d36", "#6c5a4e"], cw: 34, ch: 44, lw: 4, dark: "#201814", jit: 8, flake: ["#7a6a60", "#8a6a58", "#6a5a52"] })), bump: 0.035,
  atlas: () => ATLAS.needle({ C: SPRUCE_C, step: [30, 17], ang: 0.9, nl: 9, sp: 2, lw: 2, brush: 0.6, stem: "#4a3626", stemW: 5 }), trans: 0.15,
  build: (H, d) => K.conifer({ h: H, r: H * 0.016 + 0.03, clear: 0.06, L: H * 0.17, pw: 0.55, low: 4, dy: H * 0.016, gap: 0.12, card: H * 0.06 + 0.2, cw: 0.8, cardY: -0.3, droop: 0.3, vee: -0.25, fwd: 0.7,
    flare: 0.3, flareH: 0.4, lobes: 4, e0: -0.55, e1: 0.75, stubs: 3, leader: false, minL: H * 0.035, sway: 0.08,
    bend: (tt, tc) => (tt < 0.5 ? -0.1 : 0.22) * (1.2 - 0.6 * tc) }, d),
});

// ---- Scots pine: bare orange upper stem, a flat, wind-carved crown of blue-green tufts ----
def("scots_pine", {
  name: "Scots pine", latin: "Pinus sylvestris", h: [7, 13], form: "broadleaf", note: "orange-barked, wind-flagged pines on the open hills",
  bark: () => K.barkTex(P => BARK.plated(P, { base: "#96603e", grain: ["#7a4628", "#c08050", "#8a5230", "#b87848"], cw: 72, ch: 120, lw: 8, dark: "#3a2a20", jit: 16, flake: ["#8a7e74", "#6a6058", "#9a8e84", "#c89868"], flakeN: 240 })), bump: 0.05,
  atlas: () => K.atlas(2, (g, i, S) => {
    const k0 = S / 512, C = { dark: ["#20382c", "#263e30"], mid: ["#38584a", "#42644e", "#325244"], tip: ["#5a7e68", "#688a70", "#789a7c"] };
    const P = { woody: 3, maxDepth: 1, step: [70], ang: 0.75, ratio: 0.5, minLen: 40 * k0, stem: "#5a4030", stemW: 7 * k0,
      leaf(g2, x, y, dx, dy, ang, len) {
        for (let s = len * 0.25; s <= len; s += 15 * k0) K.needleTuft(g2, x + dx * s, y + dy * s, ang + rr(-0.3, 0.3), 58 * k0, 10, 1.25, 2.4 * k0, C);
        K.needleTuft(g2, x + dx * len, y + dy * len, ang, 64 * k0, 22, 0.9, 2.4 * k0, C);
      } };
    K.spray(g, S / 2, S - 6, rr(-0.05, 0.05), S * 0.8, 0, P);
  }), trans: 0.15,
  build: (H, d) => K.broadleaf({ h: H, r: H * 0.03, trunk: 0.84, lean: 0.2, jit: 0.05, np: 7, t0: 0.6, e0: 0.05, e1: 0.75, len: 0.34, lenTop: 0.7,
    flare: 0.4, flareH: 0.4, taper: 0.5, base: [0.62, 0.52, 0.5], crown: { y: 0.84, rx: 0.42, ry: 0.2 }, top: H * 0.12, limbR: 0.5,
    S: { maxD: 3, n: [0, 5, 3, 1], seg: [0, 6, 4, 3], kids: [0, 4, 3], ratio: 0.55, spread: 0.8, up: 0.35, jit: 0.12, bend: [0, t => (t < 0.5 ? -0.05 : 0.12), 0.08, 0.05], t0: 0.45,
      cards: 4, cardLen: H * 0.062, cells: [0, 1, 2, 3], flat: false, droop: -0.1, col: [WHITE, [1.05, 0.9, 0.8], [0.9, 0.75, 0.65], [0.6, 0.5, 0.42]] } }, d),
});

// ---- flowering trees: Yoshino cherry, flowering dogwood, eastern redbud ----
function flowerTwig(g, S, o) {
  const k0 = S / 512, n = o.n || 7, st = S * 0.74 / n, pts = [];
  let x = S / 2, y = S - 6, a = rr(-0.12, 0.12), side = R() < 0.5 ? 1 : -1;
  for (let k = 0; k < n; k++) { pts.push([x, y, a]); x += Math.sin(a) * st; y -= Math.cos(a) * st; a += rr(-0.16, 0.16) + (x < S * 0.42 ? 0.1 : x > S * 0.58 ? -0.1 : 0); }
  g.strokeStyle = o.stem; g.lineWidth = (o.stemW || 5) * k0; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < n; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
  for (let k = 1; k < n; k++) {
    const p = pts[k];
    if (o.leaf && R() < o.leafP) { const lo = Object.assign({}, o.leaf); lo.col = o.leafCol(); K.leaf(g, p[0], p[1], p[2] + side * rr(0.6, 1.1), rr(o.leafL[0], o.leafL[1]) * k0, lo); }
    for (let q = 0; q < o.clusters; q++) {
      const ca = p[2] - side * rr(0.4, 1.4) * (q % 2 ? -1 : 1), cl = rr(o.reach[0], o.reach[1]) * k0, cx = p[0] + Math.sin(ca) * cl, cy = p[1] - Math.cos(ca) * cl;
      g.strokeStyle = o.pedicel; g.lineWidth = 1.4 * k0; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(cx, cy); g.stroke();
      for (let f = 0; f < o.per; f++) o.flower(g, cx + rr(-1, 1) * o.scatter * k0, cy + rr(-1, 1) * o.scatter * k0, k0);
    }
    side = -side;
  }
  const e = pts[n - 1];
  for (let f = 0; f < o.per + 1; f++) o.flower(g, e[0] + rr(-1, 1) * o.scatter * k0, e[1] - rr(0, 1.4) * o.scatter * k0, k0);
}
function ornamentalForm(H, o) {
  o = o || {};
  return { h: H, r: H * (o.r || 0.04), trunk: o.trunk || 0.36, lean: 0.12, jit: 0.07, np: o.np || 7, t0: 0.55, e0: o.e0 == null ? 0.3 : o.e0, e1: 1.05, len: o.len || 0.52, lenTop: 0.75,
    flare: 0.5, flareH: 0.3, crown: { y: 0.66, rx: 0.55, ry: 0.32 }, top: H * 0.28, limbR: 0.62,
    S: { maxD: 3, n: [0, 5, 3, 1], seg: [0, 6, 4, 3], kids: [0, 5, 4], ratio: 0.6, spread: 0.85, up: o.up == null ? 0.12 : o.up, jit: 0.1, bend: [0, t => (t < 0.5 ? 0.07 : -0.07), -0.03, o.weep || 0], t0: 0.3,
      cards: 7, cardLen: H * (o.card || 0.125), cells: [0, 1, 2, 3], flat: !!o.flat, droop: o.droop == null ? 0.2 : o.droop, col: o.col || WOOD } };
}
def("yoshino_cherry", {
  name: "Yoshino cherry", latin: "Prunus × yedoensis", h: [6, 10], form: "broadleaf", note: "in full blossom: clouds of pale pink on dark, banded limbs",
  bark: () => K.barkTex(P => BARK.smooth(P, { base: "#5a3c36", mottle: ["#4a302c", "#6c4a42", "#523832", "#7a5a50", "#40302c"], lent: ["#b89c86", "#a88a74", "#c8ac96"], lentN: 420, lentLen: [14, 110], cracks: 24, lichen: ["#8a9a84", "#a8a89a"] })), bump: 0.018, rough: 0.7,
  atlas: () => K.atlas(2, (g, i, S) => flowerTwig(g, S, { stem: "#3c2a26", stemW: 5, clusters: 2, per: i === 3 ? 3 : 4, scatter: 26, reach: [26, 64], pedicel: "#7a5a3a",
    flower: (g2, x, y, k0) => blossom(g2, x, y, rr(17, 23) * k0, 5, ["#f9dfe6", "#f5c9d6", "#fbe9ee", "#efb4c6", "#f6d3dd"], "#c8587a", "rgba(226,130,160,0.6)"),
    leaf: { w: 0.26, pos: 0.42, tip: 0.5, teeth: 0.1, nv: 7 }, leafP: i === 3 ? 0.9 : 0.25, leafL: [70, 100], leafCol: () => hsl(rr(28, 70), rr(40, 55), rr(30, 40)) })), trans: 0.6,
  build: (H, d) => K.broadleaf(ornamentalForm(H, { weep: -0.05, e0: 0.5, len: 0.46, trunk: 0.4 }), d),
});
def("flowering_dogwood", {
  name: "Flowering dogwood", latin: "Cornus florida", h: [5, 8], form: "broadleaf", note: "tiered branches set with white four-bract flowers in spring",
  bark: () => K.barkTex(P => BARK.plated(P, { base: "#5c5650", grain: ["#3e3a36", "#7a746c", "#4c4842", "#8a847a"], cw: 30, ch: 34, lw: 4.5, dark: "#1f1c1a", jit: 7 })), bump: 0.045,
  atlas: () => K.atlas(2, (g, i, S) => flowerTwig(g, S, { stem: "#4c3a34", stemW: 4, clusters: 1, per: 1, scatter: 5, reach: [40, 80], pedicel: "#6a7a3a",
    flower: (g2, x, y, k0) => { blossom(g2, x, y, rr(38, 48) * k0, 4, ["#fbfaf2", "#f4f2e4", "#fffef8"], "#a8b450", "rgba(180,120,110,0.75)"); },
    leaf: { w: 0.3, pos: 0.45, tip: 0.4, nv: 6, veinRise: 0.3 }, leafP: 0.75, leafL: [70, 96], leafCol: green(88, 104, 42, 54, 32, 42) })), trans: 0.55,
  build: (H, d) => K.broadleaf(ornamentalForm(H, { flat: true, up: 0.02, droop: 0.1, len: 0.55, e0: 0.4, trunk: 0.36, card: 0.13 }), d),
});
def("eastern_redbud", {
  name: "Eastern redbud", latin: "Cercis canadensis", h: [5, 8], form: "broadleaf", note: "magenta-pink flowers straight from the bare twigs",
  bark: () => K.barkTex(P => BARK.plated(P, { base: "#4a3832", grain: ["#32241f", "#6a5046", "#3e2e28", "#7a5a48"], cw: 44, ch: 90, lw: 5, dark: "#1c1411", jit: 10, flake: ["#7a4a38", "#8a5a40"] })), bump: 0.04,
  atlas: () => K.atlas(2, (g, i, S) => flowerTwig(g, S, { stem: "#2e2220", stemW: 4.5, clusters: 3, per: 6, scatter: 15, reach: [6, 22], pedicel: "#8a3a5a",
    flower: (g2, x, y, k0) => { g2.fillStyle = pick(["#d2569a", "#c2408a", "#e070ac", "#b83880", "#dc8ab8"]); g2.beginPath(); g2.ellipse(x, y, rr(5, 8) * k0, rr(7, 11) * k0, rr(0, 3), 0, TAU); g2.fill(); },
    leaf: { w: 0.5, pos: 0.3, tip: 0.35, nv: 5, petiole: 0.3, veinRise: 0.3 }, leafP: i === 3 ? 0.7 : 0.12, leafL: [50, 70], leafCol: () => hsl(rr(60, 95), rr(40, 52), rr(32, 42)) })), trans: 0.55,
  build: (H, d) => K.broadleaf(Object.assign(ornamentalForm(H, { r: 0.03, trunk: 0.3, len: 0.55, e0: 0.5, up: 0.25, card: 0.085 }), { stems: 3 }), d),
});

// ---- giant mushroom fields: a fly agaric at tree size (the one fantasy stand-in; the cap is a lathe, not a card crown) ----
def("giant_fly_agaric", {
  name: "Giant fly agaric", latin: "Amanita muscaria (giant)", h: [5, 8], form: "mushroom", note: "opts.brown: a parasol (Macrolepiota procera) instead",
  bark: () => K.barkTex(P => {             // top half of the tile: cap skin; bottom half: stem and gills
    const g = P.g, W = P.W, H = P.H;
    g.fillStyle = "#c22a1c"; g.fillRect(0, 0, W, H / 2);
    for (let i = 0; i < 500; i++) P.blob(g, R() * W, R() * H / 2 * 0.98, rr(5, 30), rr(5, 20), R() * 3, pick(["#a81e14", "#d83a24", "#b4241a", "#e04a2a"]), rr(0.1, 0.3));
    for (let i = 0; i < 70; i++) { const x = R() * W, y = rr(0.04, 0.46) * H, s = rr(8, 22); g.globalAlpha = 1; g.fillStyle = pick(["#f4eedc", "#e8e0c8", "#fbf8ee"]); g.beginPath(); for (let k = 0; k < 7; k++) { const a = k / 7 * TAU, r = s * rr(0.7, 1.1); g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8); } g.fill(); }
    g.globalAlpha = 1; g.fillStyle = "#ece4d0"; g.fillRect(0, H / 2, W, H / 2);
    for (let x = 0; x < W; x += 6) { g.strokeStyle = pick(["#cfc4a8", "#f6f0e0", "#bcb094", "#e0d6bc"]); g.globalAlpha = rr(0.4, 0.9); g.lineWidth = rr(1, 3); g.beginPath(); g.moveTo(x + rr(-2, 2), H / 2); g.lineTo(x + rr(-2, 2), H); g.stroke(); }
    P.h.fillStyle = "#909090"; P.h.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 6) { P.h.strokeStyle = R() < 0.5 ? "#505050" : "#c8c8c8"; P.h.lineWidth = 2; P.h.beginPath(); P.h.moveTo(x, H / 2); P.h.lineTo(x, H); P.h.stroke(); }
  }), bump: 0.02, rough: 0.6,
  build(H, d, o) {
    const B = new K.Geo(), seg = d ? 20 : 10, tint = o.brown ? [0.75, 0.62, 0.45] : WHITE, R0 = H * 0.42, sr = H * 0.06;
    // v runs 0..0.5 over the cap (top half of the tile) and 0.5..1 down gills and stem; tube() spaces v by length / 2, so set uvs after
    const ring = (pts, rad, v0, v1) => {
      const b0 = B.nv; K.tube(B, pts, rad, seg, { urep: 4, col: () => tint });
      const n = pts.length; for (let k = 0; k < n; k++) for (let j = 0; j <= seg; j++) B.u[(b0 + k * (seg + 1) + j) * 2 + 1] = 1 - (v0 + (v1 - v0) * k / (n - 1));
    };
    const cap = [], cr = [];
    for (let k = 0; k <= 7; k++) { const a = k / 7 * Math.PI * 0.5; cap.push(new V3(0, H - R0 * 0.55 * (1 - Math.cos(a)) * 1.0 - 0.001 * k, 0)); cr.push(Math.max(0.01, R0 * Math.sin(a))); }
    cap.reverse(); cr.reverse();
    ring(cap, cr, 0.48, 0.02);
    const yb = H - R0 * 0.55;
    ring([new V3(0, yb, 0), new V3(0, yb + R0 * 0.1, 0), new V3(0, yb + R0 * 0.16, 0)], [R0, R0 * 0.55, sr * 1.1], 0.52, 0.98);     // gills, seen from below
    ring([new V3(0, -0.4, 0), new V3(0, 0.15, 0), new V3(0, H * 0.3, 0), new V3(0, yb + R0 * 0.16, 0)], [sr * 1.9, sr * 1.5, sr * 1.05, sr], 0.98, 0.52);
    ring([new V3(0, H * 0.6, 0), new V3(0, H * 0.585, 0), new V3(0, H * 0.55, 0)], [sr * 1.05, sr * 2.1, sr * 2.5], 0.6, 0.9);       // the skirt
    return { b: K.toGeo(B, false) };
  },
});

K.trees = trees;
K.paint = { palmate, pinnate, blossom, green, BARK, ATLAS, flowerTwig };
})();
