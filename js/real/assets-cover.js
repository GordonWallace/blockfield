// Blockfield 1.6, the realistic look: js/real/assets-cover.js. Owner: the Biome assets thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
// Ground cover and rocks, per biome (BF.real.akit.cover, .rocks): the grasses, ferns, flowers and shrubs that stand in for Blockfield's
// plant blocks, and the boulders of each biome's bedrock. Each biome paints one 4 x 4 foliage atlas (lazily, on first use) and its
// plants are tufts of cards or small shrubs cut from it, so a biome's whole ground cover is one material. js/real/assets-biomes.js
// registers them. A cover def: { id, name, latin, block (the plant block it replaces, or null: scatter-only extras), build(detail) ->
// BufferGeometry }; a rock def: { id, name, tex, build(detail) -> BufferGeometry, size [min, max] }.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || !BF.real.akit) return;
const K = BF.real.akit, T = globalThis.THREE, V3 = T.Vector3, TAU = Math.PI * 2;
const { rr, pick, hsl } = K, R = () => K.rand(), H = K.heads, P = K.paint;
const col = (h0, h1, s0, s1, l0, l1) => () => hsl(rr(h0, h1), rr(s0, s1), rr(l0, l1));
const WOOD_CELL = 15;

// ---------- cell painters (each returns paint(g, S)) ----------
const C = {
  blades: o => (g, S) => K.bladeCell(g, S, o),
  flower: o => (g, S) => K.flowerCell(g, S, o),
  frond: o => (g, S) => K.frondCell(g, S, o),
  spray: o => (g, S) => K.leafySpray(g, S, Object.assign({ top: S * 0.12 }, o)),
  // a twig of tiny leaves or scales in whorls (heather, sagebrush, creosote, dwarf willow): many short strokes along a branching stem
  scrub: o => (g, S) => {
    const k0 = S / 256;
    const tw = (x, y, a, len, d) => {
      const ex = x + Math.sin(a) * len, ey = y - Math.cos(a) * len;
      g.strokeStyle = o.stem; g.lineWidth = Math.max(1, (3.2 - d) * k0); g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
      for (let s = d ? 0.1 : 0.35; s < 1; s += o.gap / (len / k0)) {
        const px = x + (ex - x) * s, py = y + (ey - y) * s;
        if (d < 2 && R() < o.fork) tw(px, py, a + (R() < 0.5 ? -1 : 1) * rr(0.35, 0.8), len * (1 - s) * rr(0.7, 1) + 12 * k0, d + 1);
        for (let q = 0; q < o.per; q++) {
          const la = a + rr(-1, 1) * o.splay, l = rr(o.len[0], o.len[1]) * k0;
          g.strokeStyle = o.col(); g.lineWidth = o.w * k0 * rr(0.8, 1.2);
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(la) * l, py - Math.cos(la) * l); g.stroke();
        }
      }
      if (o.tip && d > 0 && R() < o.tipP) o.tip(g, ex, ey, a, k0);
      else if (o.tip && d === 0) o.tip(g, ex, ey, a, k0);
    };
    for (let i = 0; i < (o.stems || 3); i++) tw(S / 2 + rr(-10, 10) * k0, S - 5, rr(-0.5, 0.5), S * rr(0.6, 0.86), 0);
  },
  // a fan of stiff blades from one point (saw palmetto, iris, yucca, agave with wide blades)
  fan: o => (g, S) => {
    const k0 = S / 256, n = o.n;
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1) - 0.5) * o.spread + rr(-0.05, 0.05), L = S * rr(o.h[0], o.h[1]) * (1 - 0.25 * Math.abs(i / (n - 1) - 0.5) * 2 * (o.round || 0));
      g.save(); g.translate(S / 2, S - 5); g.rotate(a);
      const w = o.w * k0;
      g.fillStyle = o.col(); g.beginPath(); g.moveTo(-w * 0.35, 0); g.quadraticCurveTo(-w, -L * 0.45, 0, -L); g.quadraticCurveTo(w, -L * 0.45, w * 0.35, 0); g.fill();
      g.strokeStyle = o.rib || "rgba(220,230,170,0.5)"; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -L * 0.96); g.stroke();
      g.restore();
    }
    if (o.head) o.head(g, S / 2 + rr(-6, 6) * k0, S * (1 - o.headH), rr(-0.1, 0.1), k0);
  },
  // a small group of cap mushrooms
  shrooms: o => (g, S) => {
    const k0 = S / 256;
    for (let i = 0; i < o.n; i++) {
      const x = S * (0.5 + (i - (o.n - 1) / 2) * 0.24 + rr(-0.04, 0.04)), h = S * rr(o.h[0], o.h[1]), w = S * rr(o.w[0], o.w[1]), y = S - 5;
      g.fillStyle = o.stem; g.beginPath(); g.moveTo(x - w * 0.16, y); g.quadraticCurveTo(x - w * 0.1, y - h * 0.5, x - w * 0.11, y - h); g.lineTo(x + w * 0.11, y - h); g.quadraticCurveTo(x + w * 0.1, y - h * 0.5, x + w * 0.2, y); g.fill();
      g.fillStyle = "rgba(0,0,0,0.25)"; g.beginPath(); g.ellipse(x, y - h + w * 0.04, w * 0.42, w * 0.07, 0, 0, TAU); g.fill();
      g.fillStyle = pick(o.cap); g.beginPath(); g.moveTo(x - w * 0.5, y - h + w * 0.03); g.bezierCurveTo(x - w * 0.5, y - h - w * o.dome, x + w * 0.5, y - h - w * o.dome, x + w * 0.5, y - h + w * 0.03); g.closePath(); g.fill();
      g.fillStyle = "rgba(255,255,255,0.14)"; g.beginPath(); g.ellipse(x - w * 0.15, y - h - w * o.dome * 0.42, w * 0.16, w * 0.07, -0.3, 0, TAU); g.fill();
      if (o.warts) for (let q = 0; q < 12; q++) { g.fillStyle = "#f4eedc"; g.beginPath(); g.arc(x + rr(-0.38, 0.38) * w, y - h - rr(0.08, 0.62) * w * o.dome, rr(1.2, 3) * k0, 0, TAU); g.fill(); }
    }
  },
  // a tall jointed cane with strap leaves (giant cane, common reed, bamboo)
  cane: o => (g, S) => {
    const k0 = S / 256;
    for (let i = 0; i < o.n; i++) {
      const x0 = S * (0.5 + (i - (o.n - 1) / 2) * 0.2 + rr(-0.03, 0.03)), lean = rr(-0.07, 0.07), Hh = S * rr(0.82, 0.95);
      const P2 = t => [x0 + Math.sin(lean) * Hh * t, S - 5 - Math.cos(lean) * Hh * t];
      g.strokeStyle = pick(o.stem); g.lineWidth = o.w * k0; g.beginPath(); g.moveTo(x0, S - 5); const e = P2(1); g.lineTo(e[0], e[1]); g.stroke();
      let side = R() < 0.5 ? 1 : -1;
      for (let t = 0.14; t < 0.98; t += o.node) {
        const p = P2(t);
        g.strokeStyle = o.joint; g.lineWidth = 1.4 * k0; g.beginPath(); g.moveTo(p[0] - o.w * k0 * 0.6, p[1]); g.lineTo(p[0] + o.w * k0 * 0.6, p[1]); g.stroke();
        if (t > o.leafFrom) { K.leaf(g, p[0], p[1], lean + side * rr(0.55, 1.05), rr(o.leaf[0], o.leaf[1]) * k0, { w: o.lw || 0.07, pos: 0.3, tip: 0.6, nv: 0, petiole: 0, col: o.col(), vein: "rgba(225,235,170,0.6)" }); side = -side; }
      }
      if (o.head) o.head(g, e[0], e[1], lean, k0);
    }
  },
  wood: o => (g, S) => {
    g.fillStyle = o.base; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) { g.strokeStyle = pick(o.cols); g.globalAlpha = rr(0.3, 0.8); g.lineWidth = rr(1, 3); const x = R() * S; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + rr(-6, 6), S); g.stroke(); }
    g.globalAlpha = 1;
  },
  // floating pads (water lily) seen from above: the card lies flat
  pads: o => (g, S) => {
    for (let i = 0; i < 3; i++) {
      const x = S * rr(0.3, 0.7), y = S * (0.25 + i * 0.25), r = S * rr(0.13, 0.19), a0 = rr(0, TAU);
      g.fillStyle = o.col(); g.beginPath(); g.moveTo(x, y); g.arc(x, y, r, a0 + 0.12, a0 + TAU - 0.12); g.closePath(); g.fill();
      g.strokeStyle = "rgba(210,230,150,0.45)"; g.lineWidth = 1; for (let k = 0; k < 9; k++) { const a = a0 + 0.4 + k * 0.62; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * r * 0.92, y + Math.sin(a) * r * 0.92); g.stroke(); }
      if (o.flower && i === 1) H.daisy(o.flower, "#e8c040", 11, 12, 0, 0.25)(g, x + r * 0.5, y - r * 0.4, 0, S / 256);
    }
  },
};
const leafO = (w, pos, tip, x) => Object.assign({ w, pos, tip, nv: 5, petiole: 0.05 }, x || {});
const GRASS = "#6f8a3a";

// ---------- geometry: tufts and shrubs out of one 4 x 4 atlas ----------
function tuftGeo(parts) {
  const F = new K.Geo();
  for (const p of parts) K.tuft(F, p, p.x || 0, p.z || 0);
  return K.toGeo(F, true);
}
// a shrub in one geometry: the twigs are mapped into the atlas's wood cell
function shrubGeo(o, detail) {
  const B = new K.Geo(), F = new K.Geo(), cc = { x: 0, y: o.h * 0.55, z: 0, rx: o.h * 0.7, ry: o.h * 0.6 }, S = Object.assign({}, o.S, { uv: K.UV4 });
  if (detail) { S.cards = Math.max(2, Math.round(S.cards * 0.6)); S.cardLen *= 1.4; S.seg = S.seg.map(() => 3); }
  const ns = detail ? Math.max(2, Math.round(o.stems * 0.6)) : o.stems;
  let az = rr(0, TAU);
  for (let k = 0; k < ns; k++) {
    az += TAU / ns + rr(-0.4, 0.4);
    const e = rr(o.e[0], o.e[1]);
    K.branch(B, F, S, new V3(Math.cos(az) * o.r * 2, -0.06, Math.sin(az) * o.r * 2), K.dirOf(az, e), o.h * rr(0.8, 1.15) / Math.max(0.5, Math.sin(e)), o.r, 0, cc);
  }
  const uv = K.UV4[WOOD_CELL], base = F.nv, frac = v => v - Math.floor(v);
  for (let i = 0; i < B.nv; i++) {
    F.p.push(B.p[i * 3], B.p[i * 3 + 1], B.p[i * 3 + 2]); F.n.push(B.n[i * 3], B.n[i * 3 + 1], B.n[i * 3 + 2]);
    F.u.push(uv.u0 + frac(B.u[i * 2]) * (uv.u1 - uv.u0), uv.vt + frac(B.u[i * 2 + 1]) * (uv.vb - uv.vt));
    F.c.push(B.c[i * 3], B.c[i * 3 + 1], B.c[i * 3 + 2]); F.w.push(0, 0);
  }
  for (const i of B.i) F.i.push(base + i);
  F.nv += B.nv;
  return K.toGeo(F, true);
}
// small shrubs (deep: false) are stems with one level of twigs; taller ones get two
const SHRUB_S = (o) => (o.deep
  ? { maxD: 2, n: [3, 3, 1], seg: [4, 3, 3], kids: [o.kids || 3, 3], ratio: 0.6, spread: 0.8, up: o.up == null ? 0.25 : o.up, jit: 0.12, bend: [0.02, 0, 0], t0: 0.3,
      cards: o.cards || 4, cardLen: o.cardLen, cells: o.cells, flat: false, droop: o.droop || 0.1, col: [[1, 1, 1], [0.9, 0.9, 0.9], [0.8, 0.8, 0.8]] }
  : { maxD: 1, n: [3, 1], seg: [3, 3], kids: [o.kids || 3], ratio: 0.55, spread: 0.8, up: o.up == null ? 0.25 : o.up, jit: 0.12, bend: [0.02, 0], t0: 0.25,
      cards: o.cards || 4, cardLen: o.cardLen, cells: o.cells, flat: false, droop: o.droop || 0.1, col: [[1, 1, 1], [0.85, 0.85, 0.85]] });

// shorthand cover builders
const grass = (cells, h, n, o) => d => tuftGeo([Object.assign({ n: d ? Math.ceil(n * 0.6) : n, len: [h * 0.8, h * 1.15], wid: 0.6, e: [0.95, 1.5], cells, droop: 0.12, spread: 0.22, sway: 0.25, rows: 3 }, o || {})]);
const fern = (cells, len, n, o) => d => tuftGeo([Object.assign({ n: d ? Math.ceil(n * 0.6) : n, len: [len * 0.8, len * 1.15], wid: 0.42, e: [0.55, 1.15], cells, droop: 0.45, vee: 0.25, spread: 0.05, sway: 0.2, rows: d ? 3 : 4 }, o || {})]);
const flower = (cells, h, n, base, o) => d => tuftGeo([Object.assign({ n: d ? Math.max(2, n - 1) : n, len: [h * 0.85, h * 1.1], wid: 0.55, e: [1.2, 1.55], cells, droop: 0.03, spread: 0.14, sway: 0.3, upright: true }, o || {})]
  .concat(base ? [{ n: d ? 3 : 5, len: [base.h * 0.8, base.h * 1.1], wid: 0.6, e: [0.9, 1.4], cells: base.cells, droop: 0.12, spread: 0.2, sway: 0.2 }] : []));
const shrub = (h, cells, o) => d => shrubGeo(Object.assign({ stems: 5, h, r: 0.012 + h * 0.012, e: [0.6, 1.35], S: SHRUB_S(Object.assign({ cells, cardLen: h * 0.42, deep: h >= 1.2 }, o || {})) }, o && o.form || {}), d);
const flat = (cells, r, n) => () => tuftGeo([{ n, len: [r * 0.8, r * 1.2], wid: 0.9, e: [0.02, 0.1], cells, droop: 0, spread: r * 0.6, sway: 0.02, y: 0.04 }]);

// =====================================================================
//  THE BIOMES' GROUND COVER. cells: up to 15 painters (cell 15 is the shrubs' wood); plants: [id, name, latin, block, build, extra]
// =====================================================================
const dry = col(42, 52, 40, 55, 52, 66);
const COVER = {};
function biome(name, cells, plants, wood) {
  let mats = null;
  const set = COVER[name] = {
    name,
    mats() {
      if (mats) return mats;
      return K.withRand(K.mulberry(name.length * 7919 + name.charCodeAt(0) * 31 + name.charCodeAt(name.length - 1)), () => {
        const tex = K.atlas(4, (g, i, S) => { if (i === WOOD_CELL) C.wood(wood || { base: "#5a4a3c", cols: ["#3a2e26", "#7a6a58", "#4a3c30"] })(g, S); else if (cells[i]) cells[i](g, S); });
        return (mats = { foliage: K.foliageMat(tex, 0.45, undefined, "cover"), depth: K.depthMat(tex) });
      });
    },
    plants: plants.map(p => ({ id: p[0], name: p[1], latin: p[2], block: p[3], density: (p[5] && p[5].density) || 0.5, scatter: p[5] && p[5].scatter,
      build: (rand, detail) => K.withRand(rand, () => p[4](detail ? 1 : 0)) })),
  };
  return set;
}
const stemG = "#5c7a34";

biome("Plains", [
  C.blades({ n: 30, h: [0.62, 0.95], w: 3.2, lean: 0.55, col: col(70, 96, 34, 50, 30, 44), dead: 0.25, deadCol: dry, head: H.panicle(["#8a5a48", "#a06a50", "#74504a"], 30, 3, 0.7), headP: 0.3 }),   // big bluestem, turkey-foot heads
  C.blades({ n: 44, h: [0.4, 0.72], w: 2, lean: 0.7, col: col(60, 90, 30, 45, 34, 48), dead: 0.4, deadCol: col(22, 34, 45, 60, 48, 60), head: H.puff(["#e8e0d0", "#d8cdb8"], 5, 1), headP: 0.3, curl: 0.4 }),   // little bluestem
  C.flower({ h: 0.8, stem: stemG, leaves: 5, opp: 1, leafO: leafO(0.13, 0.4, 0.4), leafL: 56, leafCol: col(84, 100, 38, 50, 28, 38), head: (g, x, y, a, k0) => { for (let i = 0; i < 16; i++) H.cup(["#f08a1c", "#e8741a", "#f8a030"], 6)(g, x + rr(-17, 17) * k0, y + rr(-4, 12) * k0, rr(-0.4, 0.4), k0); } }),   // butterfly milkweed
  C.flower({ h: 0.82, stem: "#5a6a30", leaves: 3, leafO: leafO(0.2, 0.4, 0.3), leafL: 60, leafCol: col(80, 96, 34, 46, 28, 38), heads: 3, head: H.daisy(["#f4c21c", "#eeb010", "#f8d030"], "#3a2418", 26, 13, 0, 0.3) }),   // black-eyed Susan
  C.flower({ h: 0.9, stem: "#5a6a30", leaves: 3, leafO: leafO(0.16, 0.38, 0.5), leafL: 66, leafCol: col(84, 100, 34, 46, 26, 36), heads: 2, head: H.daisy(["#c668a4", "#b85a98", "#d47ab0"], "#8a3e1c", 30, 14, 1, 0.3) }),   // purple coneflower
  C.blades({ n: 16, h: [0.3, 0.55], w: 2.4, lean: 0.9, col: dry, curl: 0.5 }),
], [
  ["big_bluestem", "Big bluestem", "Andropogon gerardii", "short_grass", grass([0, 0, 1], 1.15, 9), { density: 1 }],
  ["little_bluestem", "Little bluestem", "Schizachyrium scoparium", "fern", grass([1, 1, 5], 0.7, 10)],
  ["butterfly_milkweed", "Butterfly milkweed", "Asclepias tuberosa", "poppy", flower([2], 0.6, 4, { h: 0.35, cells: [1] })],
  ["black_eyed_susan", "Black-eyed Susan", "Rudbeckia hirta", "dandelion", flower([3], 0.65, 4, { h: 0.35, cells: [1] })],
  ["purple_coneflower", "Purple coneflower", "Echinacea purpurea", "cornflower", flower([4], 0.8, 4, { h: 0.4, cells: [1] })],
]);

biome("Flower Forest", [
  C.blades({ n: 36, h: [0.35, 0.6], w: 2, lean: 1.0, col: col(88, 108, 36, 50, 28, 40), curl: 0.6 }),                                                      // Pennsylvania sedge
  C.frond({ n: 24, len: 0.2, w: 0.22, ang: 1.3, taper: 0.35, base: 0.16, curve: 0.08, col: col(100, 118, 40, 52, 20, 30), rib: "#5a5a2c" }),              // Christmas fern
  (g, S) => { const k0 = S / 256, x = S / 2, y = S * 0.42; g.strokeStyle = "#6a7a3a"; g.lineWidth = 3 * k0; g.beginPath(); g.moveTo(x, S - 5); g.lineTo(x, y); g.stroke();       // red trillium: three leaves, three petals
    for (let i = 0; i < 3; i++) K.leaf(g, x, y, i * TAU / 3 + 0.4, 84 * k0, leafO(0.36, 0.38, 0.4, { col: hsl(rr(96, 110), 42, rr(26, 34)), petiole: 0 }));
    for (let i = 0; i < 3; i++) K.leaf(g, x, y, i * TAU / 3 + 0.4 + TAU / 6, 46 * k0, leafO(0.3, 0.4, 0.5, { col: pick(["#8e1c2c", "#a22434", "#7a1626"]), petiole: 0, vein: "rgba(60,0,10,0.5)", nv: 3 })); g.fillStyle = "#e8d890"; g.beginPath(); g.arc(x, y, 5 * k0, 0, TAU); g.fill(); },
  C.flower({ h: 0.6, stem: "#8a6a4a", basal: 2, basalL: 120, leafO: leafO(0.2, 0.45, 0.3, { flaw: 1 }), leafCol: col(88, 104, 30, 42, 30, 38), head: (g, x, y, a, k0) => { for (let i = 0; i < 6; i++) K.leaf(g, x, y + 4 * k0, Math.PI + (i - 2.5) * 0.5, 34 * k0, leafO(0.2, 0.4, 0.5, { col: pick(["#f2d020", "#eac418", "#f8dc40"]), petiole: 0, nv: 0, vein: "rgba(200,150,0,0.5)" })); } }),   // trout lily
  C.flower({ h: 0.8, stem: "#7a8a5a", leaves: 4, leafO: leafO(0.3, 0.45, 0.2), leafL: 80, leafCol: col(100, 120, 26, 36, 36, 46), head: (g, x, y, a, k0) => { for (let i = 0; i < 9; i++) { const px = x + rr(-22, 22) * k0, py = y + rr(0, 30) * k0; g.fillStyle = pick(["#5a86d8", "#6a94e0", "#7aa0e8", "#c890c8"]); g.beginPath(); g.moveTo(px - 3 * k0, py - 8 * k0); g.lineTo(px + 3 * k0, py - 8 * k0); g.lineTo(px + 7 * k0, py + 9 * k0); g.lineTo(px - 7 * k0, py + 9 * k0); g.fill(); } } }),   // Virginia bluebells
  C.spray({ n: 8, L: [60, 80], stem: "#5a4a3a", stemW: 3, leaf: leafO(0.26, 0.45, 0.3, { gloss: 1 }), col: col(96, 116, 40, 52, 22, 32),
    extra: (g, pts, k0) => { for (let i = 2; i < pts.length; i += 2) for (let q = 0; q < 5; q++) P.blossom(g, pts[i][0] + rr(-14, 14) * k0, pts[i][1] + rr(-14, 14) * k0, 9 * k0, 5, ["#f6c6dc", "#f0a8c8", "#fbe0ea"], "#c8587a"); } }),   // mountain laurel
], [
  ["pennsylvania_sedge", "Pennsylvania sedge", "Carex pensylvanica", "short_grass", grass([0], 0.55, 12, { e: [0.6, 1.3], droop: 0.4 }), { density: 1 }],
  ["christmas_fern", "Christmas fern", "Polystichum acrostichoides", "fern", fern([1], 0.6, 9)],
  ["red_trillium", "Red trillium", "Trillium erectum", "poppy", flower([2], 0.5, 5)],
  ["trout_lily", "Trout lily", "Erythronium americanum", "dandelion", flower([3], 0.42, 6)],
  ["virginia_bluebells", "Virginia bluebells", "Mertensia virginica", "cornflower", flower([4], 0.65, 6)],
  ["mountain_laurel", "Mountain laurel", "Kalmia latifolia", null, shrub(1.3, [5]), { scatter: 0.01 }],
]);

biome("Birch Forest", [
  C.blades({ n: 30, h: [0.5, 0.85], w: 2.2, lean: 0.6, col: col(84, 104, 34, 48, 30, 42), dead: 0.15, deadCol: dry, head: H.panicle(["#b8a070", "#a89060"], 28, 5, 1.0), headP: 0.2 }),   // bluejoint
  C.frond({ n: 12, len: 0.42, w: 0.2, ang: 1.2, taper: 1.3, peak: 0.42, base: 0.3, twice: 1, col: col(88, 108, 40, 52, 26, 36), rib: "#7a7a3c", ribW: 0.014 }),                  // bracken
  C.flower({ h: 0.85, stem: "#7a5a4a", leaves: 3, leafO: leafO(0.42, 0.5, 0, { lobes: 1.5, lobeD: 0.4 }), leafL: 40, leafCol: col(96, 116, 30, 40, 32, 42), heads: 3, head: (g, x, y, a, k0) => { for (let i = 0; i < 5; i++) K.leaf(g, x, y - 6 * k0, Math.PI + (i - 2) * 0.42, 26 * k0, leafO(0.24, 0.4, 0.6, { col: pick(["#d83a2c", "#c82c24", "#e04a34"]), petiole: 0, nv: 0, vein: "rgba(250,210,60,0.8)" })); g.fillStyle = "#f2d040"; g.beginPath(); g.arc(x, y + 2 * k0, 4 * k0, 0, TAU); g.fill(); } }),   // wild columbine
  C.flower({ h: 0.7, stem: "#6a7a3a", basal: 3, basalL: 110, leafO: leafO(0.24, 0.5, 0.2, { gloss: 1 }), leafCol: col(96, 112, 40, 52, 26, 34), heads: 3, head: H.cup(["#e8dc50", "#dcd040", "#f0e468"], 9) }),   // bluebead lily
  C.flower({ h: 0.85, stem: "#5a4a5a", leaves: 4, leafO: leafO(0.42, 0.3, 0.4, { teeth: 0.2 }), leafL: 70, leafCol: col(96, 112, 32, 44, 26, 36), heads: 4, head: H.daisy(["#9a8ad8", "#8a7acc", "#b0a0e4"], "#e8c040", 12, 14, 0, 0.28) }),   // large-leaved aster
  (g, S) => { const k0 = S / 256; for (let q = 0; q < 2; q++) { const x = S * (0.35 + q * 0.3), y = S * (0.5 + q * 0.12); g.strokeStyle = "#7a6a4a"; g.lineWidth = 2 * k0; g.beginPath(); g.moveTo(x, S - 5); g.lineTo(x, y); g.stroke();
    for (let i = 0; i < 6; i++) K.leaf(g, x, y, i * TAU / 6, 44 * k0, leafO(0.3, 0.5, 0.3, { col: hsl(rr(96, 112), 44, rr(24, 32)), petiole: 0, veinRise: 0.4 })); P.blossom(g, x, y, 15 * k0, 4, ["#fbfaf0", "#f2f0e2"], "#5a6a3a"); } },   // bunchberry
], [
  ["bluejoint", "Bluejoint reedgrass", "Calamagrostis canadensis", "short_grass", grass([0], 0.75, 9), { density: 1 }],
  ["bracken", "Bracken fern", "Pteridium aquilinum", "fern", fern([1], 0.95, 6, { e: [0.75, 1.3], droop: 0.6, wid: 0.9 })],
  ["wild_columbine", "Wild columbine", "Aquilegia canadensis", "poppy", flower([2], 0.7, 6)],
  ["bluebead_lily", "Bluebead lily", "Clintonia borealis", "dandelion", flower([3], 0.5, 6)],
  ["large_leaved_aster", "Large-leaved aster", "Eurybia macrophylla", "cornflower", flower([4], 0.7, 6)],
  ["bunchberry", "Bunchberry", "Cornus canadensis", null, flower([5], 0.3, 7, null, { e: [0.9, 1.4] }), { scatter: 0.15 }],
]);

biome("Dark Forest", [
  C.blades({ n: 22, h: [0.3, 0.6], w: 4.2, lean: 1.0, col: col(96, 116, 36, 48, 22, 32), curl: 0.6, head: H.panicle(["#7a5a3a", "#8a6a48"], 16, 4, 1.2), headP: 0.15 }),   // great wood-rush
  C.frond({ n: 26, len: 0.24, w: 0.2, ang: 1.25, taper: 0.5, base: 0.1, curve: 0.06, twice: 0, col: col(100, 120, 40, 54, 20, 30), rib: "#6a6a34", mid: "rgba(20,40,10,0.4)" }),   // male fern
  C.spray({ n: 9, L: [50, 68], stem: "#4a3a30", stemW: 2.5, leaf: leafO(0.42, 0.35, 0.3, { lobes: 1.5, lobeD: 0.35, gloss: 1, vein: "rgba(225,235,200,0.9)" }), col: col(110, 130, 36, 48, 16, 25) }),   // ivy
  C.flower({ h: 0.5, stem: "#6a8a4a", basal: 3, basalL: 70, leafO: leafO(0.2, 0.5, 0.2), leafCol: col(96, 112, 38, 48, 28, 36), heads: 3, head: H.cup(["#fbfbf4", "#f2f2e8"], 9, "#e8d060") }),   // wood anemone
  C.blades({ n: 14, h: [0.2, 0.4], w: 3, lean: 1.1, col: col(28, 40, 35, 50, 22, 34), curl: 0.3 }),                                                           // beech litter
], [
  ["wood_rush", "Great wood-rush", "Luzula sylvatica", "short_grass", grass([0], 0.55, 10, { e: [0.6, 1.3], droop: 0.35, wid: 0.75 }), { density: 0.7 }],
  ["male_fern", "Male fern", "Dryopteris filix-mas", "fern", fern([1], 0.9, 9)],
  ["ivy", "Common ivy", "Hedera helix", null, flat([2], 0.7, 6), { scatter: 0.08 }],
  ["wood_anemone", "Wood anemone", "Anemone nemorosa", null, flower([3], 0.32, 7), { scatter: 0.1 }],
]);

biome("Swamp", [
  C.blades({ n: 46, h: [0.55, 0.92], w: 1.6, lean: 0.9, col: col(76, 100, 34, 48, 30, 44), dead: 0.35, deadCol: dry, curl: 0.7 }),                              // tussock sedge
  C.frond({ n: 18, len: 0.26, w: 0.16, ang: 1.15, taper: 0.6, base: 0.2, twice: 1, col: col(92, 110, 44, 56, 30, 40), rib: "#8a8a4c" }),                        // royal fern
  C.cane({ n: 3, stem: ["#6a8a3a", "#7a9444"], w: 3.4, node: 2, joint: "#6a8a3a", leafFrom: 9, leaf: [0, 0], col: col(80, 100, 40, 50, 30, 40), head: H.spike(["#5a3a22", "#4a2e1a", "#6a4428"], 44, 9, 16, { club: 1 }) }),   // cattail heads
  C.fan({ n: 9, spread: 0.9, h: [0.7, 0.93], w: 6, col: col(78, 98, 38, 50, 30, 42), rib: "rgba(220,235,170,0.4)" }),                                           // cattail leaves
  C.pads({ col: col(96, 120, 40, 52, 26, 36), flower: ["#fbfbf2", "#f4f0e0"] }),                                                                                // fragrant water lily
  C.fan({ n: 11, spread: 2.6, h: [0.55, 0.8], w: 9, round: 0.3, col: col(84, 104, 36, 48, 28, 38) }),                                                          // saw palmetto fan
], [
  ["tussock_sedge", "Tussock sedge", "Carex stricta", "short_grass", grass([0], 0.75, 12, { e: [0.6, 1.5], droop: 0.35, spread: 0.12 }), { density: 1 }],
  ["royal_fern", "Royal fern", "Osmunda regalis", "fern", fern([1], 1.1, 8, { e: [0.9, 1.4] })],
  ["cattail", "Broadleaf cattail", "Typha latifolia", "sugar_cane", d => tuftGeo([{ n: d ? 4 : 7, len: [1.6, 2.2], wid: 0.22, e: [1.3, 1.55], cells: [3], droop: 0.04, spread: 0.2, sway: 0.3 }, { n: 3, len: [1.7, 2.3], wid: 0.3, e: [1.4, 1.56], cells: [2], droop: 0, spread: 0.15, sway: 0.3, upright: true }])],
  ["water_lily", "Fragrant water lily", "Nymphaea odorata", null, flat([4], 0.6, 3), { scatter: 0.05, onWater: true }],
  ["saw_palmetto", "Saw palmetto", "Serenoa repens", null, d => tuftGeo([{ n: d ? 5 : 8, len: [0.8, 1.2], wid: 1.0, e: [0.4, 1.3], cells: [5], droop: 0.1, vee: 0.3, spread: 0.1, sway: 0.15 }]), { scatter: 0.03 }],
]);

biome("Mangrove Swamp", [
  C.blades({ n: 34, h: [0.6, 0.94], w: 2.6, lean: 0.45, col: col(72, 96, 36, 50, 32, 44), dead: 0.2, deadCol: dry, head: H.spike(["#c8b880", "#b8a870"], 30, 4, 10), headP: 0.2 }),   // smooth cordgrass
  C.frond({ n: 14, len: 0.3, w: 0.13, ang: 1.0, taper: 0.4, base: 0.2, col: col(98, 118, 40, 52, 22, 32), rib: "#8a7a3c", ribW: 0.018, mid: "rgba(210,225,150,0.5)" }),   // golden leather fern
  C.scrub({ stem: "#8a6a5a", stems: 4, gap: 7, per: 2, splay: 1.0, len: [6, 10], w: 3.4, fork: 0.2, col: col(84, 130, 30, 50, 34, 46) }),                        // saltwort (succulent)
], [
  ["cordgrass", "Smooth cordgrass", "Sporobolus alterniflorus", "short_grass", grass([0], 0.9, 9, { e: [1.1, 1.55] }), { density: 1 }],
  ["leather_fern", "Golden leather fern", "Acrostichum aureum", "fern", fern([1], 1.6, 8, { e: [0.9, 1.45], droop: 0.25, wid: 0.5 })],
  ["saltwort", "Saltwort", "Batis maritima", null, grass([2], 0.45, 9, { e: [0.5, 1.3] }), { scatter: 0.08 }],
]);

biome("Desert", [
  C.scrub({ stem: "#5a4a3c", stems: 3, gap: 9, per: 3, splay: 1.2, len: [5, 9], w: 2.6, fork: 0.5, col: col(66, 84, 34, 46, 30, 40), tip: (g, x, y, a, k0) => { if (R() < 0.5) H.cup(["#f0d020", "#e8c818"], 5)(g, x, y, a, k0); }, tipP: 0.5 }),   // creosote bush
  C.scrub({ stem: "#8a8272", stems: 4, gap: 10, per: 2, splay: 1.0, len: [8, 14], w: 3.6, fork: 0.35, col: () => hsl(rr(80, 110), rr(8, 16), rr(58, 70)), tip: H.daisy(["#f4d020", "#eec418"], "#c89a10", 9, 10, 0, 0.35), tipP: 0.6 }),   // brittlebush
  C.blades({ n: 26, h: [0.4, 0.8], w: 1.5, lean: 0.8, col: dry, curl: 0.5, head: H.puff(["#f0e8d8", "#e0d4bc"], 6, 1), headP: 0.3 }),                            // big galleta, cured
  (g, S) => { const k0 = S / 256; for (let i = 0; i < 9; i++) { const a = (i / 8 - 0.5) * 1.5 + rr(-0.06, 0.06), L = S * rr(0.75, 0.93); g.save(); g.translate(S / 2, S - 5); g.rotate(a);      // ocotillo: thorny wands with a red flame at the tip
      g.strokeStyle = pick(["#6a6a52", "#7a7860", "#5c5c48"]); g.lineWidth = 4 * k0; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(a * 14 * k0, -L * 0.5, 0, -L); g.stroke();
      for (let s = 0.1; s < 0.95; s += 0.035) { g.fillStyle = hsl(rr(84, 104), 42, rr(30, 40)); g.beginPath(); g.ellipse((R() < 0.5 ? -1 : 1) * 4 * k0, -L * s, 3.4 * k0, 1.8 * k0, rr(-1, 1), 0, TAU); g.fill(); }
      H.spike(["#e23a1c", "#d02c14", "#f04a24"], 22, 5, 9)(g, 0, -L, 0, k0); g.restore(); } },
], [
  ["creosote_bush", "Creosote bush", "Larrea tridentata", "dead_bush", shrub(1.25, [0], { deep: false, kids: 5, cards: 5, form: { stems: 7, e: [0.75, 1.4] } }), { density: 1 }],
  ["brittlebush", "Brittlebush", "Encelia farinosa", null, shrub(0.6, [1], { form: { stems: 6, e: [0.5, 1.3] }, cardLen: 0.34 }), { scatter: 0.02 }],
  ["big_galleta", "Big galleta grass", "Hilaria rigida", null, grass([2], 0.5, 7), { scatter: 0.03 }],
  ["ocotillo", "Ocotillo", "Fouquieria splendens", null, d => tuftGeo([{ n: d ? 3 : 5, len: [2.6, 3.6], wid: 0.8, e: [1.35, 1.56], cells: [3], droop: 0, spread: 0.05, sway: 0.08, upright: true }]), { scatter: 0.004 }],
], { base: "#6a5a4a", cols: ["#4a3e32", "#8a7a66", "#3a3028"] });

biome("Badlands", [
  C.scrub({ stem: "#6a6052", stems: 4, gap: 7, per: 3, splay: 0.9, len: [7, 12], w: 3, fork: 0.5, col: () => hsl(rr(90, 130), rr(8, 18), rr(52, 66)), tip: H.spike(["#c8c08a", "#b8b078"], 18, 3, 8), tipP: 0.3 }),   // big sagebrush
  C.scrub({ stem: "#8a8a5a", stems: 5, gap: 8, per: 2, splay: 0.6, len: [9, 15], w: 1.6, fork: 0.4, col: col(66, 86, 26, 38, 44, 56), tip: (g, x, y, a, k0) => { for (let i = 0; i < 7; i++) { g.fillStyle = pick(["#eec81c", "#f4d430", "#e0b810"]); g.beginPath(); g.arc(x + rr(-9, 9) * k0, y + rr(-6, 6) * k0, rr(2.5, 4.5) * k0, 0, TAU); g.fill(); } }, tipP: 0.85 }),   // rubber rabbitbrush
  C.blades({ n: 30, h: [0.45, 0.85], w: 1.3, lean: 0.7, col: dry, curl: 0.6, head: H.panicle(["#d8c8a0", "#c8b888"], 34, 5, 1.6), headP: 0.4 }),               // Indian ricegrass
  C.spray({ n: 6, L: [40, 60], stem: "#4a3c30", stemW: 4, leaf: (g, x, y, a, L) => K.needles(g, x, y, Math.sin(a), -Math.cos(a), a, L, 2, 9, 3, 2.4, { dark: ["#3a5a3a"], mid: ["#4a6a44", "#567a4c"], tip: ["#6a8a58"] }, 0.5) }),   // Utah juniper sprig
], [
  ["big_sagebrush", "Big sagebrush", "Artemisia tridentata", "dead_bush", shrub(0.95, [0], { kids: 4, cards: 5, form: { stems: 6, e: [0.6, 1.4] } }), { density: 1 }],
  ["rabbitbrush", "Rubber rabbitbrush", "Ericameria nauseosa", null, shrub(0.75, [1], { form: { stems: 7, e: [0.8, 1.45] } }), { scatter: 0.015 }],
  ["indian_ricegrass", "Indian ricegrass", "Achnatherum hymenoides", null, grass([2], 0.5, 7), { scatter: 0.04 }],
  ["utah_juniper", "Utah juniper", "Juniperus osteosperma", null, shrub(2.4, [3], { kids: 4, cards: 6, cardLen: 0.7, form: { stems: 4, r: 0.07, e: [0.7, 1.3] } }), { scatter: 0.003 }],
], { base: "#7a6a5a", cols: ["#4a3e34", "#9a8a78", "#5a4a3e"] });

biome("Savanna", [
  C.blades({ n: 34, h: [0.6, 0.95], w: 2, lean: 0.55, col: col(48, 70, 40, 56, 44, 58), dead: 0.5, deadCol: col(26, 38, 50, 62, 44, 56), head: H.panicle(["#a8502c", "#b86034", "#8a4428"], 30, 4, 1.3), headP: 0.4 }),   // red oat grass
  C.blades({ n: 40, h: [0.35, 0.7], w: 1.6, lean: 0.8, col: col(56, 84, 36, 50, 40, 54), dead: 0.4, deadCol: dry, curl: 0.5, head: H.puff(["#f4eee0", "#e8dcc4"], 6, 1), headP: 0.25 }),   // Guinea / finger grass
  C.flower({ h: 0.7, stem: "#7a8a4a", basal: 3, basalL: 120, leafO: leafO(0.22, 0.5, 0.3), leafCol: col(92, 108, 40, 50, 28, 36), head: (g, x, y, a, k0) => H.puff(["#e8281c", "#f03a22", "#d81c14", "#f85a30"], 26)(g, x, y, a, k0) }),   // fireball lily
  C.flower({ h: 0.4, stem: "#7a7a3a", leaves: 6, opp: 1, leafO: leafO(0.2, 0.5, 0.1), leafL: 30, leafCol: col(80, 96, 36, 46, 34, 44), heads: 4, head: H.cup(["#f4d820", "#eccc18"], 8, "#c89a10") }),   // devil's thorn
  C.flower({ h: 0.55, stem: "#6a8a4a", leaves: 5, leafO: leafO(0.2, 0.4, 0.5), leafL: 54, leafCol: col(92, 110, 40, 50, 30, 40), heads: 3, head: H.cup(["#3a6ae0", "#4a7aea", "#2c5ad0"], 9, "#f2e040") }),   // blue commelina
  C.spray({ n: 8, L: [44, 60], stem: "#6a5a4a", stemW: 3, leaf: (g, x, y, a, L) => P.pinnate(g, x, y, a, L, 8, 0.22, col(74, 96, 36, 48, 30, 40), "#6f7a3a") }),   // whistling thorn sprig
], [
  ["red_oat_grass", "Red oat grass", "Themeda triandra", "short_grass", grass([0, 0, 1], 1.05, 10), { density: 1 }],
  ["guinea_grass", "Guinea grass", "Megathyrsus maximus", "fern", grass([1], 0.7, 10)],
  ["fireball_lily", "Fireball lily", "Scadoxus multiflorus", "poppy", flower([2], 0.6, 5)],
  ["devils_thorn", "Devil's thorn", "Tribulus terrestris", "dandelion", flower([3], 0.32, 8, null, { e: [0.5, 1.2] })],
  ["blue_commelina", "Blue commelina", "Commelina benghalensis", "cornflower", flower([4], 0.45, 6)],
  ["whistling_thorn", "Whistling thorn", "Vachellia drepanolobium", "dead_bush", shrub(1.5, [5], { kids: 4, form: { stems: 4, e: [0.8, 1.4] } })],
]);

const JUNGLE_CELLS = [
  C.spray({ n: 6, L: [84, 110], stem: "#5a6a3a", stemW: 3, leaf: leafO(0.26, 0.42, 0.5, { nv: 9, gloss: 1, veinDark: "rgba(240,250,220,0.35)" }), col: col(104, 128, 44, 58, 20, 30) }),   // prayer plant / calathea
  C.frond({ n: 26, len: 0.26, w: 0.14, ang: 1.2, taper: 0.5, base: 0.12, curve: 0.08, col: col(98, 120, 46, 60, 24, 34), rib: "#5a4a2c", ribW: 0.014, mid: "rgba(210,230,150,0.4)" }),   // tree-fern frond
  C.flower({ h: 0.92, stem: "#6a8a3a", stemW: 4, basal: 3, basalL: 170, leafO: leafO(0.2, 0.5, 0.3, { nv: 12, gloss: 1 }), leafCol: col(100, 120, 46, 58, 24, 34), head: (g, x, y, a, k0) => { for (let i = 0; i < 6; i++) { const sd = i % 2 ? 1 : -1, yy = y + i * 13 * k0; g.fillStyle = pick(["#e02a1c", "#d02014", "#ee3a22"]); g.beginPath(); g.moveTo(x, yy + 8 * k0); g.quadraticCurveTo(x + sd * 22 * k0, yy + 4 * k0, x + sd * 34 * k0, yy - 12 * k0); g.quadraticCurveTo(x + sd * 14 * k0, yy - 4 * k0, x, yy - 2 * k0); g.fill(); g.fillStyle = "#f2d020"; g.beginPath(); g.arc(x + sd * 31 * k0, yy - 10 * k0, 2.6 * k0, 0, TAU); g.fill(); } } }),   // heliconia
  C.flower({ h: 0.7, stem: "#5a6a3a", leaves: 6, opp: 1, leafO: leafO(0.34, 0.38, 0.3, { teeth: 0.16 }), leafL: 46, leafCol: col(96, 112, 40, 52, 26, 36), heads: 4, head: (g, x, y, a, k0) => { for (let i = 0; i < 14; i++) { g.fillStyle = pick(["#f4c81c", "#f09a18", "#e85a20", "#f8de40"]); g.beginPath(); g.arc(x + rr(-9, 9) * k0, y + rr(-7, 7) * k0, 3 * k0, 0, TAU); g.fill(); } } }),   // lantana
  C.flower({ h: 0.9, stem: "#7a5a7a", stemW: 3.4, leaves: 5, leafO: leafO(0.2, 0.45, 0.5, { gloss: 1 }), leafL: 80, leafCol: col(100, 120, 44, 56, 24, 32), head: H.spike(["#4a52d8", "#5a62e4", "#3c44c8", "#6a70ea"], 46, 12, 12) }),   // blue ginger
  (g, S) => { const k0 = S / 256, x = S / 2, y = S * 0.52; g.strokeStyle = "#5a7a3a"; g.lineWidth = 5 * k0; g.beginPath(); g.moveTo(x, S - 5); g.lineTo(x, y); g.stroke();          // elephant ear / philodendron: one huge heart leaf
    K.leaf(g, x, y + 30 * k0, 0, 150 * k0, leafO(0.42, 0.3, 0.45, { nv: 8, gloss: 1, col: hsl(rr(104, 122), 50, rr(22, 30)), petiole: 0, vein: "rgba(215,235,160,0.9)", veinRise: 0.2 })); },
  C.frond({ n: 20, len: 0.34, w: 0.07, ang: 1.1, taper: 0.4, peak: 0.6, base: 0.2, curve: 0.05, droop: 0.5, col: col(96, 116, 44, 56, 26, 36), rib: "#7a8a3c", ribW: 0.016 }),   // understorey palm frond
  C.spray({ n: 7, L: [60, 80], stem: "#4a3a2a", stemW: 4, leaf: leafO(0.3, 0.45, 0.5, { gloss: 1, nv: 7 }), col: col(104, 126, 44, 56, 20, 30) }),            // shrub layer
];
const JUNGLE_PLANTS = [
  ["calathea", "Calathea", "Goeppertia lutea", "short_grass", d => tuftGeo([{ n: d ? 4 : 6, len: [0.5, 0.8], wid: 0.9, e: [0.7, 1.4], cells: [0], droop: 0.25, spread: 0.12, sway: 0.12 }]), { density: 1 }],
  ["tree_fern", "Tree fern", "Cyathea", "fern", fern([1], 1.3, 10, { e: [0.5, 1.3], wid: 0.5 })],
  ["heliconia", "Lobster-claw heliconia", "Heliconia rostrata", "poppy", flower([2], 1.5, 4, null, { wid: 0.8, e: [1.05, 1.5], droop: 0.1 })],
  ["lantana", "Lantana", "Lantana camara", "dandelion", flower([3], 0.7, 5)],
  ["blue_ginger", "Blue ginger", "Dichorisandra thyrsiflora", "cornflower", flower([4], 1.1, 4)],
  ["philodendron", "Elephant ear", "Philodendron giganteum", null, d => tuftGeo([{ n: d ? 3 : 5, len: [1.0, 1.5], wid: 0.9, e: [0.7, 1.3], cells: [5], droop: 0.3, spread: 0.1, sway: 0.1 }]), { scatter: 0.05 }],
  ["chamaedorea", "Parlour palm", "Chamaedorea elegans", null, fern([6], 1.5, 7, { e: [0.6, 1.4], wid: 0.55 }), { scatter: 0.04 }],
  ["jungle_shrub", "Wild coffee", "Psychotria poeppigiana", "jungle_leaves", shrub(1.5, [7], { kids: 4, cards: 5, cardLen: 0.55, form: { stems: 5 } })],
];
biome("Jungle", JUNGLE_CELLS, JUNGLE_PLANTS);
COVER["Sparse Jungle"] = COVER["Jungle"];

biome("Snowy Plains", [
  C.blades({ n: 22, h: [0.5, 0.9], w: 1.4, lean: 0.5, col: col(46, 62, 34, 48, 48, 60), dead: 0.5, deadCol: dry, head: H.puff(["#ffffff", "#f6f4ee", "#eceae2"], 12), headP: 0.5 }),   // cotton grass
  C.scrub({ stem: "#6a4a3a", stems: 4, gap: 9, per: 3, splay: 1.3, len: [5, 9], w: 3.4, fork: 0.5, col: col(70, 100, 30, 44, 32, 44) }),                         // dwarf willow / birch
  C.scrub({ stem: "#5a3a34", stems: 5, gap: 6, per: 4, splay: 1.3, len: [3, 6], w: 2.6, fork: 0.4, col: () => (R() < 0.3 ? hsl(rr(0, 14), 60, rr(30, 40)) : hsl(rr(84, 110), 36, rr(22, 30))) }),   // crowberry / lingonberry mat
  (g, S) => { const k0 = S / 256; for (let i = 0; i < 90; i++) { const x = S / 2 + rr(-1, 1) * S * 0.36, y = S - 5 - R() * S * 0.3; g.strokeStyle = pick(["#d8dcc8", "#c4ccb4", "#e8eadc", "#b8c0a8"]); g.lineWidth = 2 * k0; g.beginPath(); g.moveTo(x, y); g.lineTo(x + rr(-7, 7) * k0, y - rr(5, 14) * k0); g.stroke(); } },   // reindeer lichen
], [
  ["cotton_grass", "Cotton grass", "Eriophorum vaginatum", null, grass([0], 0.45, 8), { scatter: 0.15 }],
  ["dwarf_willow", "Dwarf willow", "Salix herbacea", null, shrub(0.4, [1], { form: { stems: 6, e: [0.3, 1.0] } }), { scatter: 0.04 }],
  ["crowberry", "Crowberry", "Empetrum nigrum", null, grass([2], 0.2, 7, { e: [0.2, 0.9], wid: 0.9 }), { scatter: 0.08 }],
  ["reindeer_lichen", "Reindeer lichen", "Cladonia rangiferina", null, grass([3], 0.14, 6, { e: [0.4, 1.3], wid: 1.6, sway: 0 }), { scatter: 0.1 }],
]);
COVER["Ice Spikes"] = COVER["Snowy Plains"];

biome("Meadow", [
  C.blades({ n: 46, h: [0.45, 0.8], w: 1.5, lean: 0.7, col: col(78, 102, 40, 54, 34, 46), dead: 0.12, deadCol: dry, curl: 0.5, head: H.panicle(["#c8b890", "#b8a87c", "#9a8a6a"], 26, 5, 1.4), headP: 0.3 }),   // tufted hairgrass
  C.blades({ n: 30, h: [0.3, 0.55], w: 2.6, lean: 1.0, col: col(84, 106, 40, 52, 30, 40), curl: 0.6 }),                                                        // sedge
  C.flower({ h: 0.78, stem: "#7a6a4a", leaves: 7, leafO: leafO(0.1, 0.4, 0.6), leafL: 44, leafCol: col(84, 100, 34, 46, 32, 42), head: H.spike(["#e83a1c", "#f04a24", "#d82c14", "#f8682c"], 46, 16, 9) }),   // scarlet paintbrush
  C.flower({ h: 0.5, stem: "#8a8a6a", basal: 4, basalL: 60, leafO: leafO(0.12, 0.5, 0.3), leafCol: () => hsl(rr(90, 110), 14, rr(50, 60)), head: H.daisy(["#f6d420", "#f0c818", "#f8e040"], "#b88a10", 30, 20, 0, 0.34) }),   // alpine sunflower
  (g, S) => { const k0 = S / 256, o = { h: 0.86, stem: "#6a7a4a", head: H.spike(["#5a62d0", "#6a70dc", "#4a52c0", "#8a8ae4", "#e8e4f4"], 70, 13, 14, { bud: ["#8a9a6a"] }) };            // silvery lupine: palmate leaves below a blue spike
    K.flowerCell(g, S, o); for (let i = 0; i < 4; i++) P.palmate(g, S / 2 + rr(-6, 6) * k0, S - 5 - i * 22 * k0, (i % 2 ? 1 : -1) * rr(0.6, 1.1), 30 * k0, 36 * k0, 7, 2.6, { w: 0.14, pos: 0.55, nv: 0, even: 1, stalk: "#7a8a5a" }, () => hsl(rr(96, 116), 26, rr(40, 50))); },
  C.flower({ h: 0.7, stem: "#6a8a4a", leaves: 4, leafO: leafO(0.14, 0.4, 0.5), leafL: 60, leafCol: col(92, 108, 38, 48, 30, 40), heads: 2, head: H.spike(["#fbf8f4", "#f4eee8", "#f8dce4"], 26, 9, 10, { club: 1 }) }),   // American bistort
], [
  ["tufted_hairgrass", "Tufted hairgrass", "Deschampsia cespitosa", "short_grass", grass([0, 0, 1], 0.6, 10), { density: 1 }],
  ["scarlet_paintbrush", "Scarlet paintbrush", "Castilleja miniata", "poppy", flower([2], 0.5, 4, { h: 0.3, cells: [1] })],
  ["alpine_sunflower", "Old-man-of-the-mountain", "Hymenoxys grandiflora", "dandelion", flower([3], 0.28, 4, { h: 0.25, cells: [1] })],
  ["silvery_lupine", "Silvery lupine", "Lupinus argenteus", "cornflower", flower([4], 0.65, 5, { h: 0.3, cells: [1] })],
  ["bistort", "American bistort", "Bistorta bistortoides", "fern", flower([5], 0.5, 4, { h: 0.3, cells: [0] })],
]);

biome("Cherry Grove", [
  C.cane({ n: 2, stem: ["#6a7a3a", "#7a8a44"], w: 2.6, node: 0.2, joint: "#4a5a2a", leafFrom: 0.3, leaf: [56, 84], lw: 0.13, col: col(88, 108, 40, 52, 28, 40) }),   // dwarf bamboo (kumazasa: pale-edged in winter)
  C.frond({ n: 20, len: 0.22, w: 0.2, ang: 1.25, taper: 0.5, base: 0.14, col: col(96, 116, 40, 52, 24, 34), rib: "#5a4a2c" }),                                  // Japanese shield fern
  (g, S) => { const k0 = S / 256, x = S / 2, y = S * 0.22; g.strokeStyle = "#6a8a4a"; g.lineWidth = 3 * k0; g.beginPath(); g.moveTo(x, S - 5); g.lineTo(x, y); g.stroke();        // red spider lily: recurved petals and long stamens
    for (let i = 0; i < 26; i++) { const a = rr(-1.9, 1.9), L = rr(26, 44) * k0; g.strokeStyle = pick(["#d81c24", "#e82a2c", "#c41420"]); g.lineWidth = (i < 12 ? 3.4 : 1) * k0; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.sin(a) * L, y - Math.cos(a) * L, x + Math.sin(a * 1.5) * L * 1.15, y - Math.cos(a * 1.5) * L * 0.8); g.stroke(); } },
  C.spray({ n: 7, L: [40, 54], stem: "#5a7a3a", stemW: 2.5, leaf: leafO(0.26, 0.4, 0.5, { teeth: 0.2 }), col: col(92, 108, 44, 54, 34, 44),
    extra: (g, pts, k0) => { for (let i = 1; i < pts.length; i++) if (R() < 0.8) P.blossom(g, pts[i][0] + rr(-12, 12) * k0, pts[i][1] + rr(-8, 8) * k0, 12 * k0, 5, ["#f8cc18", "#f2c010", "#fad838"], "#e09a08"); } }),   // kerria
  C.fan({ n: 7, spread: 0.7, h: [0.6, 0.86], w: 5, col: col(88, 106, 38, 50, 30, 40), headH: 0.8, head: (g, x, y, a, k0) => { for (let i = 0; i < 3; i++) K.leaf(g, x, y, i * TAU / 3 + 0.5, 38 * k0, leafO(0.34, 0.6, 0.1, { col: pick(["#5a48c0", "#6a58cc", "#4a3ab0"]), petiole: 0, nv: 4, vein: "rgba(250,230,90,0.9)", veinDark: "rgba(30,20,80,0.5)" })); for (let i = 0; i < 3; i++) K.leaf(g, x, y, i * TAU / 3 + 0.5 + TAU / 6, 22 * k0, leafO(0.3, 0.5, 0.2, { col: "#8a7ae0", petiole: 0, nv: 0 })); } }),   // Japanese iris
  (g, S) => { const k0 = S / 256; for (let i = 0; i < 46; i++) { g.fillStyle = pick(["#f8dce4", "#f4c8d6", "#fbeaf0", "#f0b4c8"]); g.beginPath(); g.ellipse(S / 2 + rr(-1, 1) * S * 0.42, S / 2 + rr(-1, 1) * S * 0.42, rr(4, 7) * k0, rr(3, 5) * k0, rr(0, 3), 0, TAU); g.fill(); } },   // fallen petals
], [
  ["kumazasa", "Dwarf bamboo", "Sasa veitchii", "short_grass", grass([0], 0.7, 8, { e: [0.9, 1.5], wid: 0.8 }), { density: 1 }],
  ["shield_fern", "Japanese shield fern", "Dryopteris erythrosora", "fern", fern([1], 0.7, 8)],
  ["red_spider_lily", "Red spider lily", "Lycoris radiata", "poppy", flower([2], 0.5, 4)],
  ["kerria", "Japanese kerria", "Kerria japonica", "dandelion", shrub(0.8, [3], { form: { stems: 6, e: [0.9, 1.45] }, droop: 0.4 })],
  ["japanese_iris", "Japanese iris", "Iris sanguinea", "cornflower", flower([4], 0.65, 4)],
  ["fallen_petals", "Fallen cherry petals", "Prunus × yedoensis", null, flat([5], 0.9, 3), { scatter: 0.25 }],
]);

biome("Windswept Hills", [
  C.blades({ n: 40, h: [0.45, 0.85], w: 1.6, lean: 0.8, col: col(54, 84, 36, 50, 38, 50), dead: 0.45, deadCol: col(30, 42, 50, 62, 46, 58), curl: 0.7, head: H.panicle(["#6a4a6a", "#7a5a70", "#5a4458"], 30, 1, 0), headP: 0.3 }),   // purple moor grass
  C.scrub({ stem: "#5a4034", stems: 5, gap: 5, per: 4, splay: 0.7, len: [3, 6], w: 2, fork: 0.5, col: col(86, 116, 26, 40, 24, 34), tip: H.spike(["#b86ab4", "#c87cc4", "#a85aa4", "#d894d0"], 22, 4, 10), tipP: 0.5 }),   // ling heather
  C.scrub({ stem: "#4a3a30", stems: 4, gap: 6, per: 4, splay: 1.0, len: [4, 7], w: 2.2, fork: 0.4, col: col(96, 120, 34, 46, 22, 30), tip: (g, x, y, a, k0) => { for (let i = 0; i < 6; i++) { g.fillStyle = pick(["#c42c7c", "#d43c8c", "#b01c6c"]); g.beginPath(); g.ellipse(x + rr(-6, 6) * k0, y + rr(-2, 9) * k0, 2.6 * k0, 4 * k0, 0, 0, TAU); g.fill(); } }, tipP: 0.7 }),   // bell heather
  C.flower({ h: 0.4, stem: "#7a7a3a", leaves: 5, leafO: leafO(0.2, 0.5, 0.1, { teeth: 0.3 }), leafL: 22, leafCol: col(88, 104, 38, 48, 30, 40), heads: 4, head: H.cup(["#f4dc20", "#eed018"], 7, "#d8a010") }),   // tormentil
  C.flower({ h: 0.8, stem: "#6a7a4a", stemW: 1.6, leaves: 4, leafO: leafO(0.06, 0.5, 0.5), leafL: 40, leafCol: col(88, 104, 34, 44, 34, 44), heads: 3, head: (g, x, y, a, k0) => { g.fillStyle = pick(["#6a80e0", "#7a8eea", "#5a70d4"]); g.beginPath(); g.moveTo(x - 4 * k0, y); g.lineTo(x + 4 * k0, y); g.lineTo(x + 10 * k0, y + 18 * k0); g.lineTo(x + 4 * k0, y + 14 * k0); g.lineTo(x, y + 19 * k0); g.lineTo(x - 4 * k0, y + 14 * k0); g.lineTo(x - 10 * k0, y + 18 * k0); g.fill(); } }),   // harebell
  C.frond({ n: 12, len: 0.42, w: 0.2, ang: 1.2, taper: 1.3, peak: 0.42, base: 0.3, twice: 1, col: () => (R() < 0.3 ? hsl(rr(30, 44), 50, rr(34, 44)) : hsl(rr(80, 100), 40, rr(28, 38))), rib: "#8a7a3c" }),   // bracken, turning
], [
  ["purple_moor_grass", "Purple moor grass", "Molinia caerulea", "short_grass", grass([0], 0.6, 11), { density: 1 }],
  ["ling_heather", "Heather", "Calluna vulgaris", "fern", shrub(0.5, [1], { kids: 4, cards: 5, form: { stems: 8, e: [0.5, 1.4] }, cardLen: 0.26 })],
  ["bell_heather", "Bell heather", "Erica cinerea", "poppy", shrub(0.4, [2], { kids: 4, cards: 5, form: { stems: 7, e: [0.5, 1.4] }, cardLen: 0.22 })],
  ["tormentil", "Tormentil", "Potentilla erecta", "dandelion", flower([3], 0.22, 5, { h: 0.3, cells: [0] })],
  ["harebell", "Harebell", "Campanula rotundifolia", "cornflower", flower([4], 0.4, 5, { h: 0.3, cells: [0] })],
  ["hill_bracken", "Bracken", "Pteridium aquilinum", null, fern([5], 0.9, 6, { e: [0.75, 1.3], droop: 0.6, wid: 0.9 }), { scatter: 0.05 }],
]);

// Plants that look the same wherever they grow: mushrooms, the waterside cane, and a plain lawn grass for biomes with no set of their own.
biome("*", [
  C.shrooms({ n: 3, h: [0.3, 0.62], w: [0.3, 0.44], stem: "#f0ead8", cap: ["#c82a1c", "#d83a24", "#b82016"], dome: 0.5, warts: 1 }),
  C.shrooms({ n: 3, h: [0.26, 0.5], w: [0.32, 0.5], stem: "#e0d2b8", cap: ["#8a5a34", "#9a6a40", "#7a4c2a"], dome: 0.42 }),
  C.cane({ n: 3, stem: ["#8a9a4a", "#9aa858", "#7a8a40"], w: 4.2, node: 0.11, joint: "#5a6a30", leafFrom: 0.3, leaf: [70, 110], lw: 0.06, col: col(78, 100, 40, 52, 34, 46), head: H.puff(["#c8b8a0", "#b8a48a", "#d8ccb8", "#a89078"], 13, 1) }),
  C.blades({ n: 40, h: [0.4, 0.8], w: 2, lean: 0.75, col: col(82, 106, 40, 54, 30, 42), dead: 0.1, deadCol: dry, curl: 0.5 }),
  C.frond({ n: 22, len: 0.22, w: 0.2, ang: 1.25, taper: 0.5, base: 0.12, twice: 1, col: col(96, 116, 42, 54, 24, 34), rib: "#6a6a34" }),
  C.blades({ n: 20, h: [0.3, 0.6], w: 1.6, lean: 0.9, col: dry, curl: 0.6 }),
  C.scrub({ stem: "#6a5a48", stems: 4, gap: 12, per: 1, splay: 1.2, len: [4, 9], w: 1.4, fork: 0.7, col: () => pick(["#8a765a", "#7a6850", "#9a866a"]) }),   // a dead, leafless bush
], [
  ["fly_agaric", "Fly agaric", "Amanita muscaria", "red_mushroom", d => tuftGeo([{ n: 2, len: [0.22, 0.34], wid: 1.0, e: [1.45, 1.57], cells: [0], droop: 0, spread: 0.1, sway: 0, upright: true }])],
  ["penny_bun", "Penny bun", "Boletus edulis", "brown_mushroom", d => tuftGeo([{ n: 2, len: [0.18, 0.28], wid: 1.0, e: [1.45, 1.57], cells: [1], droop: 0, spread: 0.1, sway: 0, upright: true }])],
  ["giant_cane", "Giant cane", "Arundo donax", "sugar_cane", d => tuftGeo([{ n: d ? 3 : 5, len: [1.0, 1.15], wid: 0.7, e: [1.4, 1.57], cells: [2], droop: 0.02, spread: 0.18, sway: 0.35, upright: true }])],
  ["meadow_grass", "Meadow grass", "Poa pratensis", "short_grass", grass([3], 0.5, 9), { density: 1 }],
  ["lady_fern", "Lady fern", "Athyrium filix-femina", "fern", fern([4], 0.75, 8)],
  ["dead_bush", "Dead shrub", "", "dead_bush", grass([6], 0.7, 5, { e: [0.8, 1.5], wid: 0.9, sway: 0.05 })],
]);

// =====================================================================
//  ROCKS: one bedrock per biome. tex paints a tiling stone; geo shapes the boulder.
// =====================================================================
const speck = (P2, n, cols, s0, s1, a) => { for (let i = 0; i < n; i++) { P2.g.globalAlpha = a * rr(0.5, 1); P2.g.fillStyle = pick(cols); P2.g.fillRect(R() * P2.W, R() * P2.H, rr(s0, s1), rr(s0, s1)); const v = (R() * 255) | 0; P2.h.globalAlpha = 0.2; P2.h.fillStyle = "rgb(" + v + "," + v + "," + v + ")"; P2.h.fillRect(R() * P2.W, R() * P2.H, rr(s0, s1) + 1, rr(s0, s1) + 1); } P2.g.globalAlpha = 1; P2.h.globalAlpha = 1; };
const cracks = (P2, n, col2) => { for (let i = 0; i < n; i++) { let x = R() * P2.W, y = R() * P2.H, a = R() * TAU; const pts = [x, y]; for (let s = 0; s < 12; s++) { a += rr(-0.5, 0.5); x += Math.cos(a) * 16; y += Math.sin(a) * 16; pts.push(x, y); } P2.poly(P2.g, pts, col2, rr(1, 2.4), 0.6); P2.poly(P2.h, pts, "#101010", 2.4, 0.8); } };
const lichen = (P2, n, cols) => { for (let i = 0; i < n; i++) { const x = R() * P2.W, y = R() * P2.H, r = rr(6, 24), c = pick(cols); for (let j = 0; j < 22; j++) { const a = R() * TAU, d = Math.sqrt(R()) * r; P2.blob(P2.g, x + Math.cos(a) * d, y + Math.sin(a) * d, rr(1.5, r * 0.3), rr(1.5, r * 0.3), 0, c, rr(0.1, 0.28)); } } };
const beds = (P2, n, cols, a) => { for (let i = 0; i < n; i++) { const y = R() * P2.H, pts = []; for (let x = -10; x <= P2.W + 10; x += 40) pts.push(x, y + rr(-3, 3)); P2.poly(P2.g, pts, pick(cols), rr(2, 16), a * rr(0.4, 1)); if (R() < 0.4) P2.poly(P2.h, pts, "#202020", rr(1.5, 4), 0.7); } };
const STONE = {
  limestone: P2 => { P2.fill("#cfc8b4", "#909090"); P2.mottle(260, ["#b8b09a", "#ddd8c8", "#c4bca6", "#a8a08c"], 12, 60, 0.08, 0.2, "#a0a0a0"); beds(P2, 26, ["#a39a84", "#e4dfd0", "#b4ab95"], 0.5); speck(P2, 9000, ["#9a927e", "#e8e4d6", "#b0a892"], 1, 2.6, 0.35); cracks(P2, 14, "#6a6252"); lichen(P2, 20, ["#8a8a80", "#c8c4a0", "#6a6e62"]); },
  granite: (P2, o) => { o = o || {}; P2.fill(o.base || "#a8a09a", "#909090"); P2.mottle(200, o.mottle || ["#948c86", "#bcb4ae", "#a09892"], 14, 60, 0.08, 0.2, "#a0a0a0"); speck(P2, 26000, o.speck || ["#3a3836", "#e8e2da", "#c89a8a", "#6a6662", "#f4f0e8", "#b0847a"], 1, 3.2, 0.6); cracks(P2, 8, "#4a4642"); lichen(P2, o.lichen == null ? 30 : o.lichen, o.lichenCols || ["#c4c9aa", "#a8b48c", "#d6ce9c", "#96a096", "#d0aa6e"]); },
  sandstone: (P2, o) => { o = o || {}; P2.fill(o.base || "#b4623a", "#909090"); P2.mottle(220, o.mottle || ["#a05230", "#c87a4c", "#b86a40", "#8e4428"], 14, 70, 0.08, 0.22, "#a0a0a0"); beds(P2, 60, o.beds || ["#8a3e24", "#d89468", "#a85432", "#e0b48c", "#70301c"], 0.55); speck(P2, 14000, o.speck || ["#8a4428", "#dca078", "#5a2a1a"], 1, 2.2, 0.3); cracks(P2, 10, o.crack || "#4a2014"); if (o.varnish) P2.mottle(60, ["#2a1c18", "#3a2620", "#1c1412"], 20, 90, 0.15, 0.4); },
  basalt: P2 => { P2.fill("#4a4a4c", "#909090"); P2.mottle(200, ["#3c3c40", "#5a5a5c", "#444448"], 14, 60, 0.1, 0.25, "#a0a0a0"); speck(P2, 22000, ["#2a2a2e", "#6a6a6e", "#8a8a8a"], 1, 2.6, 0.4); for (let i = 0; i < 900; i++) P2.blob(P2.g, R() * P2.W, R() * P2.H, rr(0.6, 2.4), rr(0.6, 2.4), 0, "#1c1c20", rr(0.3, 0.7)); cracks(P2, 12, "#1a1a1c"); lichen(P2, 26, ["#b0b49a", "#8a947a", "#c8be8c"]); },
  gneiss: P2 => { P2.fill("#8c8e90", "#909090"); for (let i = 0; i < 90; i++) { let y = R() * P2.H; const pts = []; for (let x = -10; x <= P2.W + 10; x += 28) { y += rr(-7, 7); pts.push(x, y); } P2.poly(P2.g, pts, pick(["#5a5c60", "#c4c4c0", "#74767a", "#dcd8d0", "#b89a90"]), rr(2, 14), rr(0.25, 0.7)); } speck(P2, 16000, ["#3e4044", "#e0deda", "#6a6c70"], 1, 2.4, 0.4); cracks(P2, 14, "#3a3c40"); lichen(P2, 40, ["#c8ccb0", "#a4b08c", "#d8d0a0", "#e0c070", "#7a8478"]); },
  laterite: P2 => { P2.fill("#6e4a3a", "#909090"); P2.mottle(260, ["#5a3a2c", "#8a5a44", "#4a342a", "#7a5040"], 10, 50, 0.1, 0.26, "#a0a0a0"); speck(P2, 14000, ["#3a2a22", "#a0705a", "#2a1e1a"], 1, 3, 0.4); for (let i = 0; i < 500; i++) P2.blob(P2.g, R() * P2.W, R() * P2.H, rr(1, 4), rr(1, 4), 0, "#2a1c16", rr(0.3, 0.6)); P2.mottle(160, ["#4a6a2c", "#5a7a34", "#3c5a26", "#6a8a40"], 10, 50, 0.2, 0.5); },
  earth: P2 => { P2.fill("#a2583a", "#909090"); P2.mottle(300, ["#8e4a30", "#b86a48", "#9a5236", "#c47a54"], 10, 50, 0.1, 0.25, "#a0a0a0"); speck(P2, 16000, ["#7a3e28", "#d08a64", "#5a2c1c"], 1, 3, 0.35); cracks(P2, 26, "#5a2a1a"); },
};
const ROCKS = {};
function rockDef(id, name, stone, sopts, geo, extra) {
  let mat = null;
  ROCKS[id] = Object.assign({
    id, name, size: [0.5, 1.4],
    material() { return mat || (mat = K.withRand(K.mulberry(id.length * 131 + id.charCodeAt(0)), () => K.rockMat(K.rockTex(P2 => STONE[stone](P2, sopts)), extra && extra.bump))); },
    build: (rand, detail) => K.withRand(rand, () => (typeof geo === "function" ? geo(detail) : K.rock(Object.assign({ detail: detail ? 2 : 3 }, geo)))),
  }, extra || {});
}
rockDef("prairie_limestone", "Flint Hills limestone ledge", "limestone", null, { flatten: 0.42, amp: 0.16, facets: 9, strata: 5, strataD: 0.1, top: [1.08, 1.07, 1.02], low: [0.74, 0.72, 0.66] }, { size: [0.6, 1.5] });
rockDef("glacial_erratic", "Glacial erratic (granite)", "granite", null, { flatten: 0.78, amp: 0.2, facets: 3, top: [1.04, 1.04, 1.0], low: [0.6, 0.68, 0.52] }, { size: [0.5, 1.8] });
rockDef("mossy_sandstone", "Mossed sandstone block", "sandstone", { base: "#8a8474", mottle: ["#747060", "#9c9684", "#6a6a58"], beds: ["#646050", "#a8a290", "#585848"], speck: ["#54503e", "#b4ae9a"], crack: "#34322a" }, { flatten: 0.6, amp: 0.16, facets: 8, strata: 2.5, top: [0.62, 0.86, 0.42], low: [0.62, 0.66, 0.56] }, { size: [0.5, 1.5] });
rockDef("desert_granite", "Desert-varnished granite", "granite", { base: "#b8946e", mottle: ["#a07e5c", "#c8a684", "#8e6e50"], speck: ["#5a4636", "#e4cdb0", "#8a6a50", "#3a2c24"], lichen: 0 }, { flatten: 0.8, amp: 0.26, facets: 2, top: [1.05, 1.0, 0.94], low: [0.66, 0.56, 0.5] }, { size: [0.5, 2.2] });
rockDef("red_sandstone", "Entrada sandstone slab", "sandstone", { varnish: 1 }, { flatten: 0.5, amp: 0.14, facets: 10, strata: 6, strataD: 0.12, top: [1.06, 1.0, 0.95], low: [0.8, 0.7, 0.66] }, { size: [0.6, 2.4] });
rockDef("kopje_granite", "Kopje granite boulder", "granite", { base: "#a89a8c", speck: ["#3a3632", "#e8e0d4", "#c8a08a", "#6a625a"], lichenCols: ["#d8a850", "#c8c8a8", "#e0b860", "#9a9a8a"] }, { flatten: 0.86, amp: 0.2, facets: 2, top: [1.06, 1.03, 0.98], low: [0.7, 0.66, 0.62] }, { size: [0.8, 3] });
rockDef("termite_mound", "Termite mound", "earth", null, d => {          // a fluted spire of red earth: a lumpy cone, not a boulder
  const B = new K.Geo(), Hh = rr(1.6, 3.2), n = 9, pts = [], rad = [], ph = rr(0, TAU), lob = 3 + ((R() * 3) | 0);
  for (let k = 0; k <= n; k++) { const t = k / n; pts.push(new V3(Math.sin(t * 3 + ph) * 0.12 * t, -0.3 + (Hh + 0.3) * t, Math.cos(t * 2.3 + ph) * 0.12 * t)); rad.push(Math.max(0.03, Hh * 0.3 * Math.pow(1 - t, 0.8) * rr(0.85, 1.12))); }
  K.tube(B, pts, rad, d ? 8 : 14, { flare: (a, y) => 1 + 0.28 * Math.pow(Math.abs(Math.cos(a * lob * 0.5 + ph + y * 0.5)), 1.5), col: (k, p) => { const q = rr(0.9, 1.05); return [q, q * 0.98, q * 0.95]; } });
  return K.toGeo(B, false);
}, { size: [0.8, 1.3], bump: 0.05 });
rockDef("jungle_laterite", "Mossed laterite boulder", "laterite", null, { flatten: 0.7, amp: 0.24, facets: 3, top: [0.8, 1.0, 0.6], low: [0.7, 0.66, 0.6] }, { size: [0.4, 1.6] });
rockDef("frost_gneiss", "Frost-shattered gneiss", "gneiss", null, { flatten: 0.55, amp: 0.18, facets: 12, top: [1.5, 1.52, 1.56], low: [0.8, 0.82, 0.86] }, { size: [0.4, 1.4] });
rockDef("alpine_granite", "Lichened talus granite", "granite", { base: "#b0aaa6", lichen: 60, lichenCols: ["#c8d048", "#b4c040", "#e8e0b0", "#3a3a36", "#d07a30"] }, { flatten: 0.66, amp: 0.2, facets: 11, top: [1.05, 1.05, 1.03], low: [0.72, 0.72, 0.72] }, { size: [0.4, 2] });
rockDef("garden_andesite", "Mossed garden stone", "basalt", null, { flatten: 0.7, amp: 0.2, facets: 4, top: [0.95, 1.5, 0.7], low: [1.1, 1.12, 1.1] }, { size: [0.4, 1.2] });
rockDef("highland_gneiss", "Lewisian gneiss outcrop", "gneiss", null, { flatten: 0.6, amp: 0.2, facets: 9, top: [1.04, 1.04, 1.0], low: [0.7, 0.72, 0.7] }, { size: [0.5, 2.2] });
rockDef("shore_cobble", "Sea-worn basalt cobble", "basalt", null, { flatten: 0.6, amp: 0.1, facets: 0, top: [1.3, 1.3, 1.32], low: [0.8, 0.82, 0.86] }, { size: [0.15, 0.7] });
rockDef("cypress_knee", "Cypress knees", "earth", null, d => {            // not stone: the root spires round a bald cypress, in the same registry so they scatter with it
  const B = new K.Geo(), n = 3 + ((R() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const a = R() * TAU, r = rr(0.1, 0.9), Hh = rr(0.3, 1.0), x = Math.cos(a) * r, z = Math.sin(a) * r, w = rr(0.07, 0.13);
    K.tube(B, [new V3(x, -0.3, z), new V3(x, Hh * 0.5, z), new V3(x + rr(-0.03, 0.03), Hh * 0.9, z), new V3(x, Hh, z)], [w * 1.5, w, w * 0.7, w * 0.25], d ? 5 : 7, { col: () => [0.62, 0.5, 0.44] });
  }
  return K.toGeo(B, false);
}, { size: [0.9, 1.2] });

K.cover = COVER; K.rocks = ROCKS;
})();
