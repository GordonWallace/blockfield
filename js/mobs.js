// Mobs: blocky Minecraft-style animals and monsters built from boxes with baked per-pixel vertex colours.
// Passive: pig, cow, sheep, chicken. Hostile: zombie, skeleton, creeper, spider.
// API (CONTRACT.md): BF.mobs = { list, init, update, raycast, hit, clear } plus spawn(type, x, y, z) for debugging.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PX = 1 / 16;
const GRAVITY = 26;
const PASSIVE_CAP = 16, HOSTILE_CAP = 12;
const DESPAWN_DIST = 100;

let scene = null;
const list = [];
const arrows = [];
const puffs = [];
let spawnT = 0;
let baseMat = null, arrowMat = null, fireMat = null, puffMat = null, puffMatDark = null;
let fireGeo = null, puffGeo = null, arrowGeo = null;

// ---------- small helpers ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
function hash(a, b, c, d) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function wrapAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
const player = () => BF.player;
function playerAlive() { const p = BF.player; return !!(p && p.position && !p.dead); }
function creative() { const p = BF.player; return !!(p && p.gameMode === "creative"); }
function skyLight() { return BF.sky && typeof BF.sky.light === "number" ? BF.sky.light : 1; }
function isNight() {
  if (BF.sky && typeof BF.sky.isNight === "function") return !!BF.sky.isNight();
  return skyLight() < 0.4;
}
// Sky exposure at a world position, matching world.js' sky-shade model.
// Returns {open, factor}: open = no light-blocking block above; factor = darkening under cover.
const OPEN_SKY = { open: true, factor: 1 };
function skyAt(x, y, z) {
  const w = BF.world, c = w.chunkAt ? w.chunkAt(Math.floor(x), Math.floor(z)) : null;
  if (!c || !c.top) return OPEN_SKY;
  const lx = Math.floor(x) - c.cx * BF.CS, lz = Math.floor(z) - c.cz * BF.CS;
  const top = c.top[lz * BF.CS + lx];
  const by = Math.floor(y);
  if (by > top) return OPEN_SKY;
  return { open: false, factor: Math.max(0.22, 0.92 - (top - by) * 0.07) };
}
function isWater(id) { return BF.RENDER[id] === 3; }

// ---------- geometry builder ----------
// A box is {min:[x,y,z], max:[x,y,z], paint}, in pixels (1/16 block). paint is a hex colour or
// fn(face, u, v, W, H) -> hex|null. Faces are split into 1px cells with slight jitter so they read as pixel art.
// u runs left->right as seen from outside, v bottom->top.
const FACE_DEFS = [
  // name, origin, u axis, v axis, dims (u, v), shade
  ["front",  b => [b[0], b[1], b[5]], [1, 0, 0],  [0, 1, 0],  "WH", 0.86],
  ["back",   b => [b[3], b[1], b[2]], [-1, 0, 0], [0, 1, 0],  "WH", 0.72],
  ["right",  b => [b[3], b[1], b[5]], [0, 0, -1], [0, 1, 0],  "DH", 0.78],
  ["left",   b => [b[0], b[1], b[2]], [0, 0, 1],  [0, 1, 0],  "DH", 0.78],
  ["top",    b => [b[0], b[4], b[5]], [1, 0, 0],  [0, 0, -1], "WD", 1.0],
  ["bottom", b => [b[0], b[1], b[2]], [1, 0, 0],  [0, 0, 1],  "WD", 0.55],
];
const tmpC = new THREE.Color();
function buildGeometry(boxes, seed) {
  const pos = [], col = [];
  boxes.forEach((bx, bi) => {
    const b = [bx.min[0], bx.min[1], bx.min[2], bx.max[0], bx.max[1], bx.max[2]];
    const dims = { W: b[3] - b[0], H: b[4] - b[1], D: b[5] - b[2] };
    FACE_DEFS.forEach(([name, org, ua, va, dk, shade], fi) => {
      const Wf = dims[dk[0]], Hf = dims[dk[1]];
      const nu = Math.max(1, Math.round(Wf)), nv = Math.max(1, Math.round(Hf));
      const cu = Wf / nu, cv = Hf / nv;
      const o = org(b);
      const p = (du, dv) => [
        (o[0] + ua[0] * du + va[0] * dv) * PX,
        (o[1] + ua[1] * du + va[1] * dv) * PX,
        (o[2] + ua[2] * du + va[2] * dv) * PX,
      ];
      for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) {
        let hex = typeof bx.paint === "function" ? bx.paint(name, u, v, nu, nv) : bx.paint;
        if (hex == null) hex = 0xff00ff;
        tmpC.setHex(hex);
        const j = (1 + (hash(u, v, fi + bi * 7, seed) - 0.5) * 0.14) * shade;
        const r = tmpC.r * j, g = tmpC.g * j, bl = tmpC.b * j;
        const p00 = p(u * cu, v * cv), p10 = p((u + 1) * cu, v * cv), p11 = p((u + 1) * cu, (v + 1) * cv), p01 = p(u * cu, (v + 1) * cv);
        pos.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
        for (let k = 0; k < 6; k++) col.push(r, g, bl);
      }
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const box = (min, max, paint) => ({ min, max, paint });

// ---------- painters ----------
// base colour everywhere, faceFn(u, v) may override pixels on the front face (returns null to keep base)
function facePaint(base, faceFn) {
  return (f, u, v, W, H) => {
    if (f === "front") { const c = faceFn(u, v, W, H); if (c != null) return c; }
    return typeof base === "function" ? base(f, u, v, W, H) : base;
  };
}
const pick = (pal, u, v, s) => pal[Math.floor(hash(u, v, s, 99) * pal.length)];

// ---------- mob models (pixel units, mob faces +Z, origin = feet centre) ----------
function quadLegs(px, pz, len, w, paint) {
  const hw = w / 2, b = () => [box([-hw, -len, -hw], [hw, 0, hw], paint)];
  return [
    { name: "legFL", pivot: [-px, len, pz], swing: 1, boxes: b() },
    { name: "legFR", pivot: [px, len, pz], swing: -1, boxes: b() },
    { name: "legBL", pivot: [-px, len, -pz], swing: -1, boxes: b() },
    { name: "legBR", pivot: [px, len, -pz], swing: 1, boxes: b() },
  ];
}
function eyes(row, wh, bk) {
  return (u, v) => {
    if (v === row && (u === 1 || u === 6)) return wh;
    if (v === row && (u === 2 || u === 5)) return bk;
    return null;
  };
}

// Villager professions -> outfit. robe/trim override the biome robe; apron covers the front; sash is a belt line.
const VILLAGER_OUTFITS = {
  farmer:        { hat: { kind: "straw", color: 0xd8b45a, color2: 0xc9a24a }, sash: 0xc9a24a },
  librarian:     { robe: 0xe6e3da, trim: 0xa8322a, hat: { kind: "brim", color: 0x8a2a24, color2: 0xa8322a } },
  cleric:        { robe: 0x7a3c9c, trim: 0xd8b84a, sash: 0xd8b84a },
  armorer:       { apron: 0x1c1c1c, mask: true },
  weaponsmith:   { apron: 0x2a2a2e, eyepatch: true, sash: 0x8a6a40 },
  toolsmith:     { apron: 0x3a3a3a, sash: 0xd8b84a, trim: 0x2a2a2a },
  butcher:       { apron: 0xf2f2f2, headband: 0xc02a2a, sash: 0xc02a2a },
  fisherman:     { hat: { kind: "bucket", color: 0x4f6f7a, color2: 0x5f8590 }, sash: 0x2a6aa8 },
  shepherd:      { hat: { kind: "brim", color: 0x5a3a20, color2: 0x6b4a2a }, sash: 0xe9e9e6, trim: 0xe9e9e6 },
  fletcher:      { hat: { kind: "feather", color: 0x3f7a34, color2: 0x2e5c26 }, sash: 0x3f7a34 },
  mason:         { apron: 0x8e8e94, sash: 0x55555c, trim: 0x55555c },
  leatherworker: { apron: 0xa8642e, sash: 0x5a3216, headband: 0x8a5a2a },
  cartographer:  { monocle: true, sash: 0x2a4a9a, trim: 0x2a4a9a },
  // explorer (16th, not vanilla): khaki field robe, wide brim hat, leather strap sash; seeks maps from the cartographer (js/explorer.js)
  explorer:      { robe: 0x8c7a4c, trim: 0x4a3a20, hat: { kind: "brim", color: 0x4a3c22, color2: 0x5c4a2a }, sash: 0x3a2a14 },
  nitwit:        { robe: 0x3f8a3a, trim: 0x2e6a2a },
  // builder (15th): orange hi-vis vest with reflective band and straps, brown overalls, yellow hard hat, a hammer in hand
  builder:       { robe: 0xe8741c, trim: 0x6b4a2a, vest: true, sash: 0x4a3220, hammer: true, hat: { kind: "hard", color: 0xf5c518, color2: 0xe3b012 } },
  // no jobsite (js/jobs.js): the plain biome robe of a vanilla unemployed villager; never in the roster pool
  unemployed:    {},
};
const PROFESSIONS = Object.keys(VILLAGER_OUTFITS);
const PROF_ALIAS = { smith: "toolsmith" };
const VILLAGE_STYLES = ["plains", "desert", "snowy", "savanna", "taiga"];

const MODELS = {
  pig() {
    const pink = 0xf0a5a2;
    const leg = (f, u, v) => (v === 0 ? 0xb9706c : pink);
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-5, 6, -8], [5, 14, 8], pink)] },
      { name: "head", pivot: [0, 12, 7], head: true, boxes: [
        box([-4, -4, -1], [4, 4, 7], facePaint(pink, eyes(4, 0xffffff, 0x1d1010))),
        box([-2, -3, 7], [2, 0, 8], (f, u, v) => (f === "front" && v === 1 && (u === 0 || u === 3) ? 0x8a4848 : 0xe48a8e)),
      ] },
      ...quadLegs(3, 5, 6, 4, leg),
    ];
  },
  cow() {
    const brown = 0x4a3324, white = 0xe8e2dc;
    const spots = (f, u, v) => (hash(u >> 2, v >> 2, f.length, 5) < 0.3 ? white : (hash(u, v, 3, 1) < 0.15 ? 0x3a281c : brown));
    const leg = (f, u, v) => (v < 3 ? (v === 0 ? 0x5a5048 : white) : brown);
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-6, 12, -9], [6, 22, 9], spots)] },
      { name: "head", pivot: [0, 20, 9], head: true, boxes: [
        box([-4, -4, 0], [4, 4, 6], facePaint(brown, (u, v) => (v === 4 && (u === 1 || u === 6) ? 0x111111 : v === 4 && (u === 2 || u === 5) ? 0xffffff : v >= 5 && u >= 3 && u <= 4 ? white : null))),
        box([-3, -4, 6], [3, -1, 7], (f, u, v) => (f === "front" && v === 1 && (u === 1 || u === 4) ? 0x3a2a24 : 0xbfa894)),
        box([-5, 2, 1], [-4, 5, 2], 0xd8d0c0),
        box([4, 2, 1], [5, 5, 2], 0xd8d0c0),
      ] },
      ...quadLegs(4, 7, 12, 4, leg),
    ];
  },
  sheep() {
    const wool = 0xe9e9e6, skin = 0xd6c1a4;
    const leg = (f, u, v) => (v >= 7 ? wool : skin);
    const head = (f, u, v) => {
      if (f === "front") { if (v >= 5) return wool; if (v === 3 && (u === 1 || u === 4)) return 0x1d1a16; return skin; }
      if (f === "top" || f === "back") return wool;
      if (f === "bottom") return skin;
      return v >= 3 ? wool : skin;
    };
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-6, 11, -8], [6, 21, 8], (f, u, v) => (hash(u, v, 2, 7) < 0.2 ? 0xd4d4d0 : wool))] },
      { name: "head", pivot: [0, 18, 7], head: true, boxes: [box([-3, -3, 0], [3, 4, 8], head)] },
      ...quadLegs(3, 5, 12, 4, leg),
    ];
  },
  chicken() {
    const wh = 0xf6f6f2, orange = 0xe8a23a;
    const leg = () => [box([-0.5, -5, -0.5], [0.5, 0, 0.5], orange), box([-1.5, -5, -0.5], [1.5, -4.5, 2.5], orange)];
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-3, 5, -4], [3, 11, 4], wh)] },
      { name: "head", pivot: [0, 10, 3], head: true, boxes: [
        box([-2, 0, 0], [2, 6, 3], facePaint(wh, (u, v) => (v === 4 && (u === 0 || u === 3) ? 0x111111 : null))),
        box([-2, 2, 3], [2, 4, 5], orange),
        box([-1, 0, 3], [1, 2, 4], 0xd02a2a),
      ] },
      { name: "wingL", pivot: [-3, 10, 0], wing: -1, boxes: [box([-1, -4, -3], [0, 0, 3], wh)] },
      { name: "wingR", pivot: [3, 10, 0], wing: 1, boxes: [box([0, -4, -3], [1, 0, 3], wh)] },
      { name: "legL", pivot: [-1.5, 5, 0], swing: 1, boxes: leg() },
      { name: "legR", pivot: [1.5, 5, 0], swing: -1, boxes: leg() },
    ];
  },
  zombie() {
    const green = 0x6a9e4c, shirt = 0x2aa2a8, pants = 0x3d3b9c;
    const head = (f, u, v) => {
      if (f === "top") return 0x4f7a38;
      if (f === "front") {
        if (v === 3 && (u === 1 || u === 2 || u === 5 || u === 6)) return u === 2 || u === 5 ? 0x14240f : 0x355d27;
        if (v === 1 && u >= 2 && u <= 5) return 0x3f6a2e;
      }
      if (f !== "bottom" && v === 7) return 0x4f7a38;
      return green;
    };
    const arm = (f, u, v, W, H) => (f === "top" || v >= H - 4 ? shirt : green);
    const leg = (f, u, v) => (v < 2 ? 0x4a4a4a : pants);
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-4, 12, -2], [4, 24, 2], (f, u, v) => (v < 1 ? 0x2b2a7a : shirt))] },
      { name: "head", pivot: [0, 24, 0], head: true, boxes: [box([-4, 0, -4], [4, 8, 4], head)] },
      { name: "armL", pivot: [-6, 22, 0], arm: -1, boxes: [box([-2, -10, -2], [2, 2, 2], arm)] },
      { name: "armR", pivot: [6, 22, 0], arm: 1, boxes: [box([-2, -10, -2], [2, 2, 2], arm)] },
      { name: "legL", pivot: [-2, 12, 0], swing: 1, boxes: [box([-2, -12, -2], [2, 0, 2], leg)] },
      { name: "legR", pivot: [2, 12, 0], swing: -1, boxes: [box([-2, -12, -2], [2, 0, 2], leg)] },
    ];
  },
  skeleton() {
    const bone = 0xc9c9c4, dark = 0x3a3a3a;
    const head = (f, u, v) => {
      if (f === "front") {
        if ((v === 3 || v === 4) && (u === 1 || u === 2 || u === 5 || u === 6)) return 0x262626;
        if (v === 2 && (u === 3 || u === 4)) return 0x4a4a4a;
        if (v === 1 && u >= 1 && u <= 6 && u % 2 === 0) return 0x5a5a5a;
      }
      return bone;
    };
    const ribs = (f, u, v, W, H) => {
      if (f === "top" || f === "bottom") return bone;
      if (v >= H - 2) return bone;              // shoulders
      if (v < 2) return v === 0 ? dark : bone;  // pelvis
      if (u === Math.floor(W / 2) || u === Math.floor(W / 2) - 1) return bone; // spine
      return v % 2 === 0 ? bone : dark;
    };
    const bow = 0x6b4a2a;
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-4, 12, -1], [4, 24, 1], ribs)] },
      { name: "head", pivot: [0, 24, 0], head: true, boxes: [box([-4, 0, -4], [4, 8, 4], head)] },
      { name: "armL", pivot: [-5, 22, 0], arm: -1, boxes: [box([-1, -10, -1], [1, 2, 1], bone)] },
      { name: "armR", pivot: [5, 22, 0], arm: 1, boxes: [
        box([-1, -10, -1], [1, 2, 1], bone),
        box([-0.5, -11, -4], [0.5, -10, 4], bow),
        box([-0.5, -10, -6], [0.5, -9, -4], bow),
        box([-0.5, -10, 4], [0.5, -9, 6], bow),
        box([-0.25, -9, -5], [0.25, -8.5, 5], 0xdddddd),
      ] },
      { name: "legL", pivot: [-2, 12, 0], swing: 1, boxes: [box([-1, -12, -1], [1, 0, 1], bone)] },
      { name: "legR", pivot: [2, 12, 0], swing: -1, boxes: [box([-1, -12, -1], [1, 0, 1], bone)] },
    ];
  },
  creeper() {
    const pal = [0x5fb84c, 0x4f9c3e, 0x7fd06c, 0x3d7d2f, 0x5fb84c, 0x9bd98a, 0x4f9c3e];
    const skin = (f, u, v) => pick(pal, u, v, f.length);
    const faceDark = (u, v) => {
      if ((v === 4 || v === 5) && (u === 1 || u === 2 || u === 5 || u === 6)) return true;
      if (v === 3 && (u === 3 || u === 4)) return true;
      if ((v === 1 || v === 2) && u >= 2 && u <= 5) return true;
      if (v === 0 && (u === 2 || u === 5)) return true;
      return false;
    };
    const head = (f, u, v) => (f === "front" && faceDark(u, v) ? 0x101410 : skin(f, u, v));
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-4, 6, -2], [4, 18, 2], skin)] },
      { name: "head", pivot: [0, 18, 0], head: true, boxes: [box([-4, 0, -4], [4, 8, 4], head)] },
      ...quadLegs(2, 4, 6, 4, (f, u, v) => (v === 0 ? 0x2a4a22 : skin(f, u, v + 3))),
    ];
  },
  // variant = "profession" or "profession/style" (style: village palette 0 plains, 1 desert, 2 snowy, 3 savanna, 4 taiga)
  villager(variant) {
    const [prof, st] = String(variant || "farmer").split("/");
    const style = +st || 0;
    const O = VILLAGER_OUTFITS[prof] || VILLAGER_OUTFITS.farmer;
    const BASE = [ // biome robe base + trim
      [0x7a5636, 0x5a3e26], [0xbf9a62, 0x9a7442], [0x40507a, 0x2c3858], [0x9a4f2e, 0x74371e], [0x4f3b2a, 0x36281c],
    ][style] || [0x7a5636, 0x5a3e26];
    const robeC = O.robe != null ? O.robe : BASE[0], trimC = O.trim != null ? O.trim : BASE[1];
    const skin = 0xb98d6c, skinD = 0x9c7457, hair = 0x4a3020;
    const head = (f, u, v) => {
      if (f === "front") {
        if (O.mask && v >= 2 && v <= 7) return v === 4 || v === 5 ? (u >= 1 && u <= 6 ? 0x1a2a20 : 0x3a3a3a) : 0x3a3a3a; // welding mask
        if (O.eyepatch && ((v >= 3 && v <= 5 && u >= 1 && u <= 3) || v === 6)) return 0x141414; // patch + strap
        if (O.headband && v === 7) return O.headband;
        if (O.monocle && ((v === 3 || v === 5) && u >= 4 && u <= 7 || v === 4 && (u === 4 || u === 7) || v === 2 && u === 7)) return 0xe0b83a;
        if (v === 4 && (u === 1 || u === 6)) return 0xffffff;
        if (v === 4 && (u === 2 || u === 5)) return 0x2d7a2d;
        if (v === 5 && u >= 1 && u <= 6) return hair; // brow
        if (v === 1 && u >= 2 && u <= 5) return skinD;
        if (v >= 8) return hair;
        return skin;
      }
      if (O.headband && v === 7 && f !== "top" && f !== "bottom") return O.headband;
      if (O.eyepatch && v === 6 && f !== "top" && f !== "bottom") return 0x141414;
      if (f === "top" || (f !== "bottom" && v >= 8)) return hair;
      return skin;
    };
    const robe = (f, u, v, W, H) => {
      if (O.apron != null && f === "front" && u >= 1 && u < W - 1 && v < H - 2) return O.apron;
      if (O.sash != null && f !== "top" && f !== "bottom" && v <= 1) return O.sash; // belt
      if (O.vest && f !== "top" && f !== "bottom") {
        if (v === 4 || v === 5) return 0xdfe6b8;                                          // reflective band
        if ((f === "front" || f === "back") && v >= 6 && (u === 1 || u === W - 2)) return 0xe9e04a; // hi-vis straps
      }
      if (v === 0 || (f === "front" && (u === 0 || u === W - 1))) return trimC;
      return robeC;
    };
    const lower = (f, u, v, W, H) => {
      if (O.apron != null && f === "front" && u >= 1 && u < W - 1) return O.apron;
      if (v === 0) return trimC;
      return robeC;
    };
    const headBoxes = [
      box([-4, 0, -4], [4, 10, 4], head),
      box([-1, 1, 4], [1, 5, 6], (f) => (f === "bottom" ? skinD : 0xa77b5c)), // the nose
    ];
    const H = O.hat;
    if (H) {
      const c = H.color, c2 = H.color2 != null ? H.color2 : c;
      if (H.kind === "straw") { headBoxes.push(box([-7, 9, -7], [7, 10, 7], c), box([-4.2, 10, -4.2], [4.2, 12, 4.2], c2)); }
      else if (H.kind === "brim") { headBoxes.push(box([-6, 9, -6], [6, 10, 6], c), box([-4.2, 10, -4.2], [4.2, 13, 4.2], c2)); }
      else if (H.kind === "bucket") { headBoxes.push(box([-5, 8, -5], [5, 9, 5], c), box([-4.3, 9, -4.3], [4.3, 12, 4.3], c2)); }
      else if (H.kind === "hard") {
        headBoxes.push(box([-4.5, 9, -4.5], [4.5, 12, 4.5], c), box([-4.5, 9.5, 4.5], [4.5, 10.5, 6.8], c2), box([-0.9, 12, -4.5], [0.9, 13, 4.5], c2));
      }
      else if (H.kind === "feather") {
        headBoxes.push(box([-4.3, 9, -4.3], [4.3, 11, 4.3], c), box([-4.6, 8.5, -4.6], [4.6, 9.2, 4.6], c2));
        headBoxes.push(box([3.6, 10, -2], [4.6, 16, -1], 0xf2f2f2), box([3.6, 14, -2], [4.6, 16, -1], 0xc23a2a));
      }
    }
    const parts = [
      { name: "body", pivot: [0, 0, 0], boxes: [
        box([-4, 12, -3], [4, 24, 3], robe),
        box([-4.5, 4, -3.5], [4.5, 12, 3.5], lower), // lower robe over the legs
      ] },
      { name: "head", pivot: [0, 24, 0], head: true, boxes: headBoxes },
      { name: "arms", pivot: [0, 20, 1], folded: true, boxes: [
        box([-4, -2, 3], [4, 2, 6], (f) => (f === "front" ? trimC : robeC)),
        box([-6, -3, -2], [-4, 3, 6], robeC),
        box([4, -3, -2], [6, 3, 6], robeC),
        box([-2, -2, 6], [2, 2, 6.5], skin),
        ...(O.hammer ? [box([2.2, -7, 5.6], [3.4, 2.5, 6.8], 0x7a5530), box([1.0, 2.5, 5.0], [4.6, 5.5, 7.4], (f, u, v) => (v === 0 ? 0x5a5a62 : 0x8e8e98))] : []),
      ] },
      { name: "legL", pivot: [-2, 12, 0], swing: 1, boxes: [box([-2, -12, -2], [2, 0, 2], (f, u, v) => (v < 1 ? 0x3a2a1c : trimC))] },
      { name: "legR", pivot: [2, 12, 0], swing: -1, boxes: [box([-2, -12, -2], [2, 0, 2], (f, u, v) => (v < 1 ? 0x3a2a1c : trimC))] },
    ];
    return parts;
  },
  iron_golem() {
    const iron = 0xd2ccc4, ironD = 0xbab3aa, vine = 0x4f7f2e;
    const metal = (f, u, v) => {
      if (hash(u >> 1, v >> 1, f.length, 21) < 0.06 && hash(u, v, 1, 2) < 0.7) return vine;
      return hash(u >> 1, v >> 1, f.length, 22) < 0.3 ? ironD : iron;
    };
    const head = (f, u, v) => {
      if (f === "front") {
        if (v === 5 && (u === 2 || u === 5)) return 0x8a1a12;
        if (v === 6 && u >= 1 && u <= 6) return 0x8e8880;
      }
      return metal(f, u, v);
    };
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [
        box([-9, 21, -5.5], [9, 33, 5.5], metal),
        box([-4.5, 16, -3], [4.5, 21, 3], metal),
      ] },
      { name: "head", pivot: [0, 31, 1], head: true, boxes: [
        box([-4, 0, -3], [4, 10, 5], head),
        box([-1, 1, 5], [1, 5, 7], ironD),
      ] },
      { name: "armL", pivot: [-11, 31, 0], golemArm: -1, boxes: [box([-2, -30, -3], [2, 2, 3], (f, u, v) => (v < 6 ? ironD : metal(f, u, v)))] },
      { name: "armR", pivot: [11, 31, 0], golemArm: 1, boxes: [box([-2, -30, -3], [2, 2, 3], (f, u, v) => (v < 6 ? ironD : metal(f, u, v)))] },
      { name: "legL", pivot: [-4, 16, 0], swing: 1, boxes: [box([-3, -16, -2.5], [3, 0, 2.5], metal)] },
      { name: "legR", pivot: [4, 16, 0], swing: -1, boxes: [box([-3, -16, -2.5], [3, 0, 2.5], metal)] },
    ];
  },
  spider() {
    const c1 = 0x3a3029, c2 = 0x29221d;
    const fur = (f, u, v) => (hash(u, v, f.length, 3) < 0.35 ? c2 : c1);
    const head = (f, u, v) => {
      if (f === "front") {
        if ((v === 4 || v === 5) && (u === 1 || u === 2 || u === 5 || u === 6)) return 0xe01c1c;
        if (v === 6 && (u === 3 || u === 4)) return 0xb01212;
        if (v === 3 && (u === 0 || u === 7)) return 0xb01212;
      }
      return fur(f, u, v);
    };
    const parts = [
      { name: "body", pivot: [0, 0, 0], boxes: [
        box([-3, 4, -3], [3, 10, 3], fur),
        box([-5, 3, -15], [5, 12, -3], (f, u, v) => (f === "top" && (u === 4 || u === 5) && v % 3 === 0 ? 0x5a1a14 : fur(f, u, v))),
      ] },
      { name: "head", pivot: [0, 7, 3], head: true, boxes: [box([-4, -4, 0], [4, 4, 8], head)] },
    ];
    const zs = [2, 0, -2, -4], spread = [0.6, 0.2, -0.2, -0.6];
    zs.forEach((z, i) => {
      parts.push({ name: "legR" + i, pivot: [3, 8, z], spiderLeg: 1, idx: i, spread: -spread[i], boxes: [box([0, -1, -1], [15, 1, 1], fur)] });
      parts.push({ name: "legL" + i, pivot: [-3, 8, z], spiderLeg: -1, idx: i, spread: spread[i], boxes: [box([-15, -1, -1], [0, 1, 1], fur)] });
    });
    return parts;
  },
};

// ---------- type table ----------
const TYPES = {
  pig:      { hostile: false, hp: 10, hw: 0.45, h: 0.9,  speed: 1.3, flee: 3.4, drops: [["raw_porkchop", 1, 3]] },
  cow:      { hostile: false, hp: 10, hw: 0.45, h: 1.4,  speed: 1.1, flee: 3.0, drops: [["raw_beef", 1, 3], ["leather", 0, 2]] },
  sheep:    { hostile: false, hp: 8,  hw: 0.45, h: 1.3,  speed: 1.2, flee: 3.2, drops: [["wool", 1, 1], ["raw_mutton", 1, 2]] },
  chicken:  { hostile: false, hp: 4,  hw: 0.2,  h: 0.75, speed: 1.1, flee: 3.0, drops: [["raw_chicken", 1, 1], ["feather", 0, 2]], slowFall: true },
  zombie:   { hostile: true,  hp: 20, hw: 0.3,  h: 1.95, speed: 2.2, attack: 3, burns: true, drops: [["rotten_flesh", 0, 2]] },
  skeleton: { hostile: true,  hp: 20, hw: 0.3,  h: 1.99, speed: 2.3, burns: true, drops: [["bone", 0, 2], ["arrow", 0, 2]] },
  creeper:  { hostile: true,  hp: 20, hw: 0.3,  h: 1.7,  speed: 1.9, drops: [["gunpowder", 0, 2]] },
  spider:   { hostile: true,  hp: 16, hw: 0.7,  h: 0.9,  speed: 3.4, attack: 2, climbs: true, drops: [["string", 0, 2]] },
  villager: { hostile: false, hp: 20, hw: 0.3,  h: 1.95, speed: 0.9, flee: 2.8, village: true, variants: PROFESSIONS, drops: [] },
  iron_golem: { hostile: false, hp: 100, hw: 0.7, h: 2.7, speed: 1.4, attack: 10, village: true, golem: true, noKnock: true, drops: [["iron_ingot", 3, 5]] },
};
const PASSIVE_TYPES = ["pig", "cow", "sheep", "chicken"];
const HOSTILE_WEIGHTS = [["zombie", 0.33], ["skeleton", 0.25], ["creeper", 0.24], ["spider", 0.18]];

const partCache = new Map();
function typeParts(name, variant) {
  const key = name + ":" + (variant || "");
  let parts = partCache.get(key);
  if (!parts) {
    let seed = 0; for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
    parts = MODELS[name](variant).map((p, i) => Object.assign({}, p, { geo: buildGeometry(p.boxes, seed + i) }));
    partCache.set(key, parts);
  }
  return parts;
}

// ---------- audio (tiny, optional; only plays once the page has an unlocked AudioContext) ----------
let actx = null, noiseBuf = null;
function audio() {
  try {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !(navigator.userActivation && navigator.userActivation.hasBeenActive)) return null;
      actx = new AC();
      noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (actx.state === "suspended") actx.resume().catch(() => {});
    return actx.state === "running" ? actx : null;
  } catch (_) { return null; }
}
function noiseSound(dur, freq, vol, pos) {
  if (BF.audio) return; // js/audio.js plays these through events
  const ac = audio(); if (!ac) return;
  let v = vol;
  if (pos && playerAlive()) { const d = pos.distanceTo(player().position); v *= Math.max(0, 1 - d / 24); }
  if (v <= 0.01) return;
  try {
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const filt = ac.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = freq;
    const g = ac.createGain(); g.gain.setValueAtTime(v, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    src.connect(filt); filt.connect(g); g.connect(ac.destination);
    src.start(); src.stop(ac.currentTime + dur);
  } catch (_) {}
}

// ---------- creation / removal ----------
function styleAt(x, z) {
  let name = "";
  try { const b = BF.worldgen && BF.worldgen.biomeAt ? BF.worldgen.biomeAt(x, z) : null; name = (b && b.name) || ""; } catch (_) {}
  if (/desert|badland|mesa/i.test(name)) return 1;
  if (/snow|frozen|ice/i.test(name)) return 2;
  if (/savanna/i.test(name)) return 3;
  if (/taiga/i.test(name)) return 4;
  return 0;
}
function createMob(type, x, y, z, variant, style) {
  const T = TYPES[type];
  if (!T) return null;
  if (T.variants) {
    variant = PROF_ALIAS[variant] || variant;
    if (!T.variants.includes(variant)) variant = T.variants[Math.floor(Math.random() * T.variants.length)];
    if (typeof style === "string") style = VILLAGE_STYLES.indexOf(style);
    if (!(style >= 0 && style <= 4)) style = styleAt(x, z);
  }
  const parts = typeParts(type, T.variants ? variant + "/" + style : null);
  const root = new THREE.Group();
  const model = new THREE.Group();
  root.add(model);
  const mat = baseMat.clone();
  const meshes = {};
  for (const p of parts) {
    const m = new THREE.Mesh(p.geo, mat);
    m.position.set(p.pivot[0] * PX, p.pivot[1] * PX, p.pivot[2] * PX);
    m.rotation.order = "YXZ";
    m.userData.part = p;
    if (p.spiderLeg) { m.rotation.z = -0.6 * p.spiderLeg; m.rotation.y = p.spread; }
    model.add(m);
    meshes[p.name] = m;
  }
  root.position.set(x, y, z);
  const yaw = Math.random() * Math.PI * 2 - Math.PI;
  model.rotation.y = yaw;
  scene.add(root);
  const mob = {
    type, hostile: T.hostile, def: T, variant: T.variants ? variant : null, profession: T.variants ? variant : undefined,
    style: T.variants ? VILLAGE_STYLES[style] : undefined, tradingWith: null, level: T.variants ? 1 : undefined, badge: null, badgeLevel: 0,
    village: null, home: null, tradeCd: 0,
    position: root.position, vel: new THREE.Vector3(),
    hp: T.hp, maxHp: T.hp, halfWidth: T.hw, height: T.h,
    root, model, meshes, material: mat,
    yaw, headYaw: 0, headPitch: 0, lookAt: null,
    walkPhase: Math.random() * 6, walkAmt: 0,
    onGround: false, inWater: false, headInWater: false, fallStart: y,
    hurtT: 0, invuln: 0, knockT: 0, dead: false, deathT: 0, removed: false,
    ai: { t: rnd(0.5, 3), mode: "idle", tx: x, tz: z, fleeT: 0, target: false, losT: 0, los: false, attackCd: 0,
          shootCd: rnd(1, 2), fuse: 0, strafe: Math.random() < 0.5 ? 1 : -1, lookT: 0, swingT: 0, provoked: 0, burnT: 0, aiming: false },
    age: 0, fire: null,
  };
  if (type === "villager" && BF.trades) BF.trades.init(mob); // level, offers, inventory with starting stock
  list.push(mob);
  return mob;
}

function removeMob(m) {
  const i = list.indexOf(m);
  if (i >= 0) list.splice(i, 1);
  if (scene) scene.remove(m.root);
  m.material.dispose();
  if (m.type === "villager" && !m.dead) { const k = villagerKey(m); if (k && m.inv) villagerSaves.set(k, BF.trades.pack(m)); }
  m.removed = true;
}

// ---------- particles ----------
function puff(pos, n, spread, dark, speed) {
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(puffGeo, dark ? puffMatDark : puffMat);
    mesh.position.set(pos.x + rnd(-spread, spread), pos.y + rnd(0, spread * 1.5), pos.z + rnd(-spread, spread));
    const s = rnd(0.6, 1.4); mesh.scale.setScalar(s);
    scene.add(mesh);
    const v = new THREE.Vector3(rnd(-1, 1), rnd(0.2, 1.2), rnd(-1, 1)).multiplyScalar(speed || 1);
    puffs.push({ mesh, vel: v, life: rnd(0.4, 0.8), s });
  }
}
function updatePuffs(dt) {
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.life -= dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(Math.max(0, 1 - dt * 2));
    p.mesh.scale.setScalar(Math.max(0.01, p.s * Math.min(1, p.life * 2)));
    if (p.life <= 0) { scene.remove(p.mesh); puffs.splice(i, 1); }
  }
  const l = Math.max(0.25, skyLight());
  puffMat.color.setRGB(0.91 * l, 0.91 * l, 0.91 * l);
}

// ---------- damage ----------
function damageMob(m, amount, knockDir, byPlayer) {
  if (!m || m.dead || m.removed || m.invuln > 0) return false;
  if (m.sleeping) wake(m);
  m.hp -= amount;
  m.invuln = 0.45;
  m.hurtT = 0.3;
  if (BF.emit) BF.emit("mobHurt", m, amount);
  if (knockDir && !m.def.noKnock) {
    const k = new THREE.Vector3(knockDir.x, 0, knockDir.z);
    if (k.lengthSq() > 1e-6) k.normalize();
    const s = byPlayer ? 6 : 4;
    m.vel.x = k.x * s; m.vel.z = k.z * s;
    m.vel.y = Math.max(m.vel.y, 4.5);
    m.knockT = 0.3;
  }
  if (byPlayer) {
    if (m.hostile) { m.ai.target = true; m.ai.provoked = 30; }
    else if (m.def.golem) m.ai.provoked = creative() ? 0 : 60;
    else m.ai.fleeT = rnd(3, 5);
    // hurting a villager or a golem angers the village's golems
    if (m.village && !creative()) { m.village.angryT = 60; for (const g of list) if (g.def.golem && g.village === m.village) g.ai.provoked = 60; }
  } else if (m.type === "villager") m.ai.fleeT = rnd(3, 5);
  if (m.hp <= 0) kill(m, byPlayer);
  return true;
}

function kill(m, byPlayer) {
  m.dead = true;
  m.deathT = 0;
  m.hp = 0;
  m.ai.fuse = 0;
  if (m.fire) m.fire.visible = false;
  if (m.village) m.village.killed[m.type] = (m.village.killed[m.type] || 0) + 1;
  if (m.type === "creeper") m.model.scale.set(1, 1, 1);
  if (byPlayer) giveDrops(m);
  if (BF.emit) BF.emit("mobKilled", m);
}

function giveDrops(m) {
  const inv = BF.inventory;
  if (!inv || typeof inv.add !== "function") return;
  for (const [name, lo, hi] of m.def.drops || []) {
    const id = (BF.I && BF.I[name] != null) ? BF.I[name] : (BF.B && BF.B[name]);
    if (id == null) continue;
    const n = irnd(lo, hi);
    if (n <= 0) continue;
    const p = m.pos || m.position;
    if (BF.drops && p) BF.drops.spawn(id, n, p.x, p.y + 0.5, p.z);
    else { try { inv.add(id, n); } catch (e) { console.error(e); } }
  }
}

// ---------- creeper explosion ----------
function explode(m) {
  const c = new THREE.Vector3(m.position.x, m.position.y + 0.8, m.position.z);
  const R = 3;
  const w = BF.world, bedrock = BF.B.bedrock;
  const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z);
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > R - Math.random() * 0.8) continue;
    const x = cx + dx, y = cy + dy, z = cz + dz;
    const id = w.getBlock(x, y, z);
    if (!id || id === bedrock || isWater(id)) continue;
    w.setBlock(x, y, z, 0);
    if (w.removePartner) w.removePartner(x, y, z, id);
  }
  if (playerAlive()) {
    const p = player();
    const pc = new THREE.Vector3(p.position.x, p.position.y + (p.height || 1.8) / 2, p.position.z);
    const d = pc.distanceTo(c);
    if (d < 7) {
      const dmg = Math.round(22 * Math.pow(1 - d / 7, 1.3));
      if (dmg > 0 && p.damage) p.damage(dmg, c.clone());
    }
  }
  for (const o of list.slice()) {
    if (o === m || o.dead) continue;
    const d = o.position.distanceTo(c);
    if (d < 6) damageMob(o, Math.max(1, Math.round(18 * (1 - d / 6))), o.position.clone().sub(c), false);
  }
  puff(c, 26, 1.6, false, 4);
  puff(c, 10, 1.0, true, 3);
  noiseSound(1.2, 500, 0.9, c);
  m.exploded = true;
  if (BF.emit) BF.emit("mobExploded", m, c);
  removeMob(m);
}

// ---------- arrows ----------
function shootArrow(m, target) {
  const from = new THREE.Vector3(m.position.x, m.position.y + 1.5, m.position.z);
  const to = target.clone();
  const dist = from.distanceTo(to);
  const speed = 22;
  const t = dist / speed;
  to.y += 0.5 * 20 * t * t; // gravity compensation
  const dir = to.sub(from).normalize();
  dir.x += rnd(-0.03, 0.03); dir.y += rnd(-0.03, 0.03); dir.z += rnd(-0.03, 0.03);
  dir.normalize();
  from.addScaledVector(dir, 0.5);
  const mesh = new THREE.Mesh(arrowGeo, arrowMat);
  mesh.position.copy(from);
  scene.add(mesh);
  arrows.push({ mesh, pos: mesh.position, vel: dir.multiplyScalar(speed), life: 6, stuck: false, owner: m });
  noiseSound(0.15, 2500, 0.25, from);
  if (BF.emit) BF.emit("arrowShot", m, from);
}
const _look = new THREE.Vector3();
function updateArrows(dt) {
  const p = playerAlive() ? player() : null;
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.life -= dt;
    if (a.life <= 0) { scene.remove(a.mesh); arrows.splice(i, 1); continue; }
    if (a.stuck) continue;
    a.vel.y -= 20 * dt;
    const steps = Math.max(1, Math.ceil(a.vel.length() * dt / 0.25));
    let hitPlayer = false;
    for (let s = 0; s < steps; s++) {
      a.pos.addScaledVector(a.vel, dt / steps);
      if (BF.world.isSolid(a.pos.x, a.pos.y, a.pos.z)) {
        a.stuck = true; a.life = Math.min(a.life, 3);
        a.pos.addScaledVector(a.vel, -dt / steps * 0.3);
        break;
      }
      if (p) {
        const pp = p.position, hw = (p.halfWidth || 0.3) + 0.1, h = p.height || 1.8;
        if (a.pos.x > pp.x - hw && a.pos.x < pp.x + hw && a.pos.z > pp.z - hw && a.pos.z < pp.z + hw && a.pos.y > pp.y && a.pos.y < pp.y + h) {
          if (p.damage) p.damage(irnd(2, 4), a.owner && !a.owner.removed ? a.owner.position.clone() : a.pos.clone().sub(a.vel));
          hitPlayer = true;
          break;
        }
      }
    }
    if (hitPlayer) { scene.remove(a.mesh); arrows.splice(i, 1); continue; }
    if (!a.stuck) { _look.copy(a.pos).add(a.vel); a.mesh.lookAt(_look); }
  }
}

// ---------- AI helpers ----------
function hasLineOfSight(m, target) {
  const from = new THREE.Vector3(m.position.x, m.position.y + m.height * 0.85, m.position.z);
  const dir = target.clone().sub(from);
  const dist = dir.length();
  if (dist < 0.01) return true;
  dir.divideScalar(dist);
  const hit = BF.world.raycast(from, dir, dist);
  return !hit || hit.dist >= dist - 0.3;
}
function dropAhead(m, dx, dz) {
  const x = m.position.x + dx * (m.halfWidth + 0.6), z = m.position.z + dz * (m.halfWidth + 0.6);
  const y0 = Math.floor(m.position.y);
  for (let k = 0; k <= 4; k++) if (BF.world.isSolid(x, y0 - 1 - k, z) || BF.world.isSolid(x, y0 - k, z)) return k;
  return 5;
}
function waterAhead(m, dx, dz) {
  const x = m.position.x + dx * (m.halfWidth + 0.6), z = m.position.z + dz * (m.halfWidth + 0.6);
  const y0 = Math.floor(m.position.y);
  return isWater(BF.world.getBlock(x, y0, z)) || isWater(BF.world.getBlock(x, y0 - 1, z));
}
function pickWander(m, r) {
  const a = Math.random() * Math.PI * 2, d = rnd(3, r);
  m.ai.tx = m.position.x + Math.cos(a) * d;
  m.ai.tz = m.position.z + Math.sin(a) * d;
}

// Sets out.x/out.z to the desired horizontal velocity; sets m.lookAt.
function wanderAI(m, dt, out) {
  const ai = m.ai, T = m.def;
  ai.t -= dt;
  if (ai.t <= 0) {
    if (ai.mode === "idle" && Math.random() < 0.6) { ai.mode = "walk"; pickWander(m, 8); ai.t = rnd(3, 7); }
    else { ai.mode = "idle"; ai.t = rnd(2, 6); }
  }
  ai.lookT -= dt;
  if (ai.lookT <= 0) {
    ai.lookT = rnd(1.5, 4);
    if (playerAlive() && player().position.distanceTo(m.position) < 8 && Math.random() < 0.6) m.lookAt = "player";
    else m.lookAt = { yaw: rnd(-1, 1), pitch: rnd(-0.4, 0.3) };
  }
  if (ai.mode === "walk") {
    const dx = ai.tx - m.position.x, dz = ai.tz - m.position.z, d = Math.hypot(dx, dz);
    if (d < 0.6) { ai.mode = "idle"; ai.t = rnd(2, 5); return; }
    const nx = dx / d, nz = dz / d;
    if (!m.inWater && (dropAhead(m, nx, nz) > 3 || (!T.hostile && waterAhead(m, nx, nz)))) { ai.mode = "idle"; ai.t = rnd(1, 3); return; }
    const sp = T.hostile ? T.speed * 0.4 : T.speed;
    out.x = nx * sp; out.z = nz * sp;
  }
}

function hostileAI(m, dt, out) {
  const ai = m.ai, T = m.def;
  const p = playerAlive() && !creative() ? player() : null;
  ai.aiming = false;
  if (!p) { ai.target = false; ai.fuse = Math.max(0, ai.fuse - dt); if (!zombieHuntVillagers(m, dt, out)) wanderAI(m, dt, out); return; }
  const eye = p.eyePos ? p.eyePos() : new THREE.Vector3(p.position.x, p.position.y + 1.6, p.position.z);
  const dx = p.position.x - m.position.x, dz = p.position.z - m.position.z, dy = p.position.y - m.position.y;
  const hd = Math.hypot(dx, dz), dist = Math.hypot(hd, dy);
  ai.losT -= dt;
  if (ai.losT <= 0) { ai.losT = rnd(0.25, 0.4); ai.los = dist < 24 && hasLineOfSight(m, eye); }
  ai.provoked = Math.max(0, ai.provoked - dt);
  // spiders are neutral in bright light unless provoked
  const calm = m.type === "spider" && ai.provoked <= 0 && skyLight() * skyAt(m.position.x, m.position.y + 0.5, m.position.z).factor > 0.6;
  if (!calm && dist < 16 && ai.los) ai.target = true;
  if (dist > 28 || calm) ai.target = false;
  if (!ai.target) { ai.fuse = Math.max(0, ai.fuse - dt); if (!zombieHuntVillagers(m, dt, out)) wanderAI(m, dt, out); return; }

  m.lookAt = "player";
  out.faceTarget = true;
  const nx = hd > 0.01 ? dx / hd : 0, nz = hd > 0.01 ? dz / hd : 0;
  ai.attackCd -= dt;
  const reach = m.halfWidth + (p.halfWidth || 0.3) + 0.55;

  if (m.type === "creeper") {
    if (dist < 3 && ai.los) {
      if (ai.fuse === 0) noiseSound(1.5, 1800, 0.35, m.position);
      ai.fuse += dt;
    } else if (dist > 6 || !ai.los) ai.fuse = Math.max(0, ai.fuse - dt);
    else if (ai.fuse > 0) ai.fuse += dt; // once lit, keeps hissing unless you run
    if (ai.fuse <= 0 && hd > 1.2) { out.x = nx * T.speed; out.z = nz * T.speed; }
    if (ai.fuse >= 1.5) explode(m);
    return;
  }

  if (m.type === "skeleton") {
    let sp = 0, sx = 0, sz = 0;
    if (dist > 11 || !ai.los) { sx = nx; sz = nz; sp = T.speed; }
    else if (dist < 5) { sx = -nx; sz = -nz; sp = T.speed * 0.8; }
    else { sx = -nz * ai.strafe; sz = nx * ai.strafe; sp = T.speed * 0.4; if (Math.random() < dt * 0.3) ai.strafe *= -1; }
    if (sp && !m.inWater && dropAhead(m, sx, sz) > 3) sp = 0;
    out.x = sx * sp; out.z = sz * sp;
    ai.shootCd -= dt;
    ai.aiming = ai.los && dist < 16;
    if (ai.aiming && ai.shootCd <= 0) {
      ai.shootCd = rnd(1.6, 2.4);
      shootArrow(m, new THREE.Vector3(p.position.x, p.position.y + (p.height || 1.8) * 0.6, p.position.z));
    }
    return;
  }

  // melee: zombie, spider
  if (hd > reach * 0.8) { out.x = nx * T.speed; out.z = nz * T.speed; }
  if (m.type === "spider" && m.onGround && hd > 2 && hd < 4 && ai.attackCd <= 0 && Math.random() < dt * 2) {
    m.vel.y = 5.5; m.vel.x = nx * 6; m.vel.z = nz * 6; m.knockT = 0.4; // pounce
  }
  if (hd < reach && Math.abs(dy + (p.height || 1.8) / 2 - m.height / 2) < 1.6 && ai.attackCd <= 0) {
    ai.attackCd = 1.0;
    ai.swingT = 0.35;
    if (p.damage) p.damage(T.attack || 2, m.position.clone());
  }
}

// Finds the nearest living mob matching pred within r blocks (horizontal + vertical box).
function nearestMob(m, r, pred) {
  let best = null, bd = r;
  for (const o of list) {
    if (o === m || o.dead || o.removed || !pred(o)) continue;
    const d = o.position.distanceTo(m.position);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
// Walks toward another mob and hits it in melee range. Returns false if the target is gone.
function chaseAndHit(m, o, dt, out, dmg, cd) {
  const ai = m.ai, T = m.def;
  if (!o || o.dead || o.removed) return false;
  const dx = o.position.x - m.position.x, dz = o.position.z - m.position.z, hd = Math.hypot(dx, dz);
  const nx = hd > 0.01 ? dx / hd : 0, nz = hd > 0.01 ? dz / hd : 0;
  const reach = m.halfWidth + o.halfWidth + 0.55;
  if (hd > reach * 0.8) { out.x = nx * T.speed; out.z = nz * T.speed; }
  out.faceX = o.position.x; out.faceZ = o.position.z;
  m.lookAt = o;
  ai.attackCd -= dt;
  if (hd < reach && Math.abs(o.position.y - m.position.y) < 1.6 && ai.attackCd <= 0) {
    ai.attackCd = cd;
    ai.swingT = 0.35;
    const k = new THREE.Vector3(nx, 0, nz);
    if (m.def.golem) { o.invuln = 0; damageMob(o, dmg, k, false); if (!o.dead) o.vel.y = 8; }
    else damageMob(o, dmg, k, false);
  }
  return true;
}
function zombieHuntVillagers(m, dt, out) {
  if (m.type !== "zombie") return false;
  const ai = m.ai;
  ai.vScanT = (ai.vScanT || 0) - dt;
  if (ai.vScanT <= 0) { ai.vScanT = 0.6; ai.vTarget = nearestMob(m, 16, o => o.type === "villager"); }
  if (ai.vTarget && chaseAndHit(m, ai.vTarget, dt, out, 3, 1.0)) return true;
  ai.vTarget = null;
  return false;
}

// Zombies with a target that stay pressed against a closed door for 3 s break it (both halves, one oak_door drops).
function zombieBreakDoor(m, dt, out) {
  const ai = m.ai, W = BF.world;
  let hit = null;
  if ((ai.target || ai.vTarget) && !creative() && (out.x || out.z)) {
    const l = Math.hypot(out.x, out.z), d = m.halfWidth + 0.4;
    const y = Math.floor(m.position.y + 0.1);
    scan: for (const k of [0, d]) for (const dy of [0, 1]) {
      const x = Math.floor(m.position.x + out.x / l * k), z = Math.floor(m.position.z + out.z / l * k);
      const b = BF.blocks[W.getBlock(x, y + dy, z)];
      if (b && b.door && !b.door.open) { hit = [x, y + dy - (b.door.upper ? 1 : 0), z]; break scan; }
    }
  }
  if (!hit) { ai.doorT = 0; ai.doorAt = null; return; }
  if (!ai.doorAt || ai.doorAt.join() !== hit.join()) { ai.doorAt = hit; ai.doorT = 0; }
  ai.doorT += dt;
  if (ai.doorT < 3) return;
  const id = W.getBlock(hit[0], hit[1], hit[2]);
  ai.doorT = 0; ai.doorAt = null;
  if (!BF.blocks[id].door) return;
  W.removePartner(hit[0], hit[1], hit[2], id);
  W.setBlock(hit[0], hit[1], hit[2], 0);
  if (BF.drops) BF.drops.spawnAt(BF.rollDrops(id), hit[0], hit[1], hit[2]);
  noiseSound(0.4, 300, 0.3, m.position);
  if (BF.emit) BF.emit("doorBroken", m, hit[0], hit[1], hit[2]);
}

// ---------- villager nights: walk home along a grid path, open doors on the way, sleep in their bed ----------
const bedtime = () => { const t = BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.3; return t > 0.52 && t < 0.985; };
const blockAt = (x, y, z) => BF.blocks[BF.world.getBlock(x, y, z)] || BF.blocks[0];
function bedOK(bed) { const b = blockAt(bed.x, bed.y, bed.z).bed; return !!(b && !b.head && b.f === bed.f); }
// A cell a villager can stand in: solid floor (not a bed/door/fence top), feet and head free or a door it can open.
function walkCell(x, y, z) {
  const W = BF.world;
  if (!W.isLoaded(x, z) || y < 1 || y + 2 >= BF.H) return false;
  const fl = blockAt(x, y - 1, z), feet = blockAt(x, y, z), head = blockAt(x, y + 1, z);
  if (!fl.solid || fl.door || fl.bed || fl.model === "fence") return false;
  return (!feet.solid || !!feet.door) && (!head.solid || !!head.door) && feet.render !== "liquid";
}
// A* over walkable cells (4-way, step up 1, drop up to 3). goal(x, y, z) -> bool. Returns cells after start, or null.
let planBudget = 0;
function findPath(sx, sy, sz, goal, maxNodes = 3000) {
  const key = (x, y, z) => x + "," + y + "," + z;
  const gx = goal.x, gz = goal.z, hh = (x, z) => Math.abs(x - gx) + Math.abs(z - gz);
  const open = [[sx, sy, sz, 0, hh(sx, sz)]], from = new Map([[key(sx, sy, sz), null]]), cost = new Map([[key(sx, sy, sz), 0]]);
  for (let n = 0; open.length && n < maxNodes; n++) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][4] < open[bi][4]) bi = i;
    const [x, y, z, g] = open[bi];
    open[bi] = open[open.length - 1]; open.pop();
    if (goal.at(x, y, z)) {
      const out = [];
      for (let k = key(x, y, z), c = [x, y, z]; c; k = c && key(...c)) { out.push(c); c = from.get(k); }
      out.pop();
      return out.reverse();
    }
    for (const [dx, dz] of BF.DIRS) for (const dy of [0, 1, -1, -2, -3]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!walkCell(nx, ny, nz)) continue;
      if (dy > 0 && blockAt(x, y + 2, z).solid) break;            // no room to jump
      if (dy < 0 && blockAt(nx, y + 1, nz).solid) break;          // wall: cannot step off
      const k = key(nx, ny, nz), ng = g + 1 + (dy ? 0.5 : 0) + (blockAt(nx, ny, nz).door ? 1 : 0);
      if (cost.has(k) && cost.get(k) <= ng) break;
      cost.set(k, ng); from.set(k, [x, y, z]);
      open.push([nx, ny, nz, ng, ng + hh(nx, nz)]);
      break;
    }
  }
  return null;
}
const feetCell = m => [Math.floor(m.position.x), Math.floor(m.position.y + 0.01), Math.floor(m.position.z)];
// Route to a cell beside the bed (same floor).
function pathToBed(m) {
  const b = m.bed, [fx, fz] = BF.DIRS[b.f], hx = b.x + fx, hz = b.z + fz;
  const at = (x, y, z) => y === b.y && (Math.abs(x - b.x) + Math.abs(z - b.z) === 1 || Math.abs(x - hx) + Math.abs(z - hz) === 1);
  const [x, y, z] = feetCell(m);
  return findPath(x, y, z, { x: b.x, z: b.z, at });
}
function pathOut(m) {
  const H = m.home;
  if (!H || H.outX == null) return null;
  const [x, y, z] = feetCell(m);
  return findPath(x, y, z, { x: H.outX, z: H.outZ, at: (cx, cy, cz) => cx === H.outX && cz === H.outZ }, 1200);
}
// Steers along ai.route. Returns "done", "stuck" or "going".
function followRoute(m, dt, out, speed) {
  const ai = m.ai, r = ai.route;
  if (!r || ai.ri >= r.length) return "done";
  const c = r[ai.ri], dx = c[0] + 0.5 - m.position.x, dz = c[2] + 0.5 - m.position.z, d = Math.hypot(dx, dz);
  if (d < 0.3 && Math.abs(m.position.y - c[1]) < 1.1) { ai.ri++; ai.stuckT = 0; return ai.ri >= r.length ? "done" : "going"; }
  ai.stuckT = (ai.stuckT || 0) + dt;
  if (ai.stuckT > 6) return "stuck";
  const s = Math.min(speed, d * 4 + 0.3);
  out.x = dx / d * s; out.z = dz / d * s;
  m.lookAt = null;
  return "going";
}
function isOccupied(x, y, z) {
  const hit = (p, hw, h) => p.x + hw > x && p.x - hw < x + 1 && p.z + hw > z && p.z - hw < z + 1 && p.y < y + 2 && p.y + h > y;
  if (playerAlive() && hit(player().position, 0.3, 1.8)) return true;
  return list.some(o => !o.dead && !o.removed && hit(o.position, o.halfWidth, o.height));
}
// Villagers open closed doors just ahead on their route and close the ones they opened once clear of them.
function villagerDoors(m) {
  const ai = m.ai, W = BF.world;
  if (ai.route && !m.sleeping) for (let k = ai.ri; k < Math.min(ai.route.length, ai.ri + 2); k++) {
    const [x, y, z] = ai.route[k], d = blockAt(x, y, z).door;
    if (d && !d.open && Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z) < 1.7) {
      W.setDoor(x, y, z, true);
      (ai.doors || (ai.doors = [])).push([x, y, z]);
    }
  }
  if (ai.doors && ai.doors.length) ai.doors = ai.doors.filter(([x, y, z]) => {
    if (Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z) < 1.5 || isOccupied(x, y, z)) return true;
    const d = blockAt(x, y, z).door;
    if (d && d.open) W.setDoor(x, y, z, false);
    return false;
  });
}
let lidGeo = null;
function eyelids(m, on) {
  const head = m.meshes.head;
  if (!head) return;
  if (!m.lids && on) {
    if (!lidGeo) lidGeo = buildGeometry([box([-3, 4, 4], [-1, 5, 4.25], 0x9c7457), box([1, 4, 4], [3, 5, 4.25], 0x9c7457)], 5);
    m.lids = new THREE.Mesh(lidGeo, m.material);
    head.add(m.lids);
  }
  if (m.lids) m.lids.visible = on;
}
// Lying flat on the bed, head on the pillow (re-applied every frame while asleep).
function sleepPose(m) {
  const b = m.bed, [fx, fz] = BF.DIRS[b.f];
  m.position.set(b.x + 0.5 - fx * 0.5, b.y + 0.5625 + 0.22, b.z + 0.5 - fz * 0.5);
  m.vel.set(0, 0, 0);
  m.model.rotation.order = "YXZ";
  m.model.rotation.set(-Math.PI / 2, Math.atan2(-fx, -fz), 0);
}
function lieDown(m) {
  m.sleeping = true; m.tradingWith = null;
  m.headYaw = m.headPitch = 0; m.walkAmt = 0; m.ai.swingT = 0;
  sleepPose(m); animate(m);
  eyelids(m, true);
}
function wake(m) {
  const ai = m.ai, b = m.bed;
  m.sleeping = false;
  m.model.rotation.order = "XYZ";
  m.model.rotation.set(0, m.yaw, 0);
  eyelids(m, false);
  const at = ai.route && ai.route.length ? ai.route[ai.route.length - 1] : null;
  if (at) m.position.set(at[0] + 0.5, at[1], at[2] + 0.5);
  else if (b) { const s = findStand(b.x, b.y, b.z, m.def); if (s) m.position.set(s[0], s[1], s[2]); }
  ai.route = null; ai.night = null;
  ai.leaving = !bedtime();
}
// Night: head for bed and sleep; without a usable bed stand still indoors or by the village bell.
function nightAI(m, dt, out) {
  const ai = m.ai, T = m.def, V = m.village, H = m.home;
  ai.mode = "idle"; ai.t = rnd(1, 3); ai.leaving = false;
  const n = ai.night || (ai.night = { fails: 0, retryT: 0 });
  if (ai.routeKind !== "bed") ai.route = null;
  if (m.bed && bedOK(m.bed) && n.fails < 3) {
    if (!ai.route && (n.retryT -= dt) <= 0 && planBudget > 0) {
      planBudget--;
      ai.route = pathToBed(m); ai.ri = 0; ai.stuckT = 0; ai.routeKind = "bed";
      if (!ai.route) { n.fails++; n.retryT = 8; }
    }
    if (ai.route) {
      const st = followRoute(m, dt, out, T.speed * 1.3);
      if (st === "done") { ai.route = [feetCell(m)]; lieDown(m); }
      else if (st === "stuck") { ai.route = null; n.fails++; n.retryT = 1; }
    }
    return;
  }
  const inside = H && m.position.x >= H.x && m.position.x <= H.x + H.w && m.position.z >= H.z && m.position.z <= H.z + H.d;
  if (inside || !V) return;
  const dx = V.x + 0.5 - m.position.x, dz = V.z + 0.5 - m.position.z, d = Math.hypot(dx, dz);
  if (d > 3.5) { out.x = dx / d * T.speed; out.z = dz / d * T.speed; }
}
// Morning: walk out of the house through the door before wandering again.
function morningAI(m, dt, out) {
  const ai = m.ai;
  if (!ai.route) {
    if (planBudget <= 0) return true;
    planBudget--;
    ai.route = pathOut(m); ai.ri = 0; ai.stuckT = 0; ai.routeKind = "out";
    if (!ai.route) { ai.leaving = false; ai.leaveEnd = "nopath"; return false; }
  }
  const st = followRoute(m, dt, out, m.def.speed);
  if (st === "stuck" && (ai.leaveTries = (ai.leaveTries || 0) + 1) < 3) { ai.route = null; return true; }
  if (st === "going") return true;
  ai.leaving = false; ai.route = null; ai.leaveTries = 0; ai.leaveEnd = st;
  if (st === "done") { // keep walking away from the door so it gets closed behind them
    const H = m.home;
    ai.mode = "walk"; ai.t = 5; ai.tx = H.outX + 0.5 + (H.outX - H.doorX) * 5; ai.tz = H.outZ + 0.5 + (H.outZ - H.doorZ) * 5;
  }
  return false;
}

// ---------- village mobs ----------
function villagerAI(m, dt, out) {
  const ai = m.ai, T = m.def, V = m.village;
  if (m.tradingWith) {
    // auto-release if the trade screen closed without telling us
    const inv = BF.inventory;
    if (m.dead || !playerAlive() || (inv && typeof inv.isOpen === "function" && !inv.isOpen()) || m.position.distanceTo(player().position) > 8) m.tradingWith = null;
    else { out.faceTarget = true; m.lookAt = "player"; ai.mode = "idle"; ai.t = 2; ai.fleeT = 0; return; }
  }
  // flee nearby zombies
  ai.zScanT = (ai.zScanT || 0) - dt;
  if (ai.zScanT <= 0) { ai.zScanT = 0.5; ai.threat = nearestMob(m, 8, o => o.type === "zombie"); }
  if (ai.threat && !ai.threat.dead && !ai.threat.removed) ai.fleeT = Math.max(ai.fleeT, 1);
  if (ai.fleeT > 0) {
    ai.fleeT -= dt;
    const src = ai.threat && !ai.threat.removed ? ai.threat.position : (playerAlive() ? player().position : null);
    let fx = Math.cos(m.yaw), fz = Math.sin(m.yaw);
    if (src) { fx = m.position.x - src.x; fz = m.position.z - src.z; }
    ai.fleeJitter = (ai.fleeJitter || Math.random() * 6) + rnd(-3, 3) * dt;
    const a = Math.atan2(fz, fx) + Math.sin(ai.fleeJitter) * 0.6;
    out.x = Math.cos(a) * T.flee; out.z = Math.sin(a) * T.flee;
    m.lookAt = null;
    return;
  }
  if (bedtime()) { nightAI(m, dt, out); return; }
  ai.night = null;
  if (ai.leaving && morningAI(m, dt, out)) return;
  if (m.love && BF.breeding && BF.breeding.ai(m, dt, out)) return;   // breeding pair: stand still, face each other (js/breeding.js)
  if (BF.villageLife && BF.villageLife.ai(m, dt, out)) return;   // buys food when hungry, farmers farm (js/villagelife.js)
  if (m.profession === "builder" && BF.builder && BF.builder.ai(m, dt, out)) return;   // builds / shops for materials (js/builder.js)
  if (m.profession === "cartographer" && BF.cartography && BF.cartography.ai(m, dt, out)) return;   // buys compass / map ingredients (js/cartography.js)
  if (m.profession === "explorer" && BF.explorer && BF.explorer.ai(m, dt, out)) return;   // fetches a map from a cartographer, explores until it is filled (js/explorer.js)
  if (BF.jobs && BF.jobs.ai(m, dt, out)) return;   // daytime visits to the jobsite; villagers without a job walk to a free one (js/jobs.js)
  // farmers sometimes go tend the village fields
  if (m.profession === "farmer" && V && ai.mode === "idle" && ai.t < 0.2 && Math.random() < 0.5 && BF.B.farmland != null) {
    for (let k = 0; k < 12; k++) {
      const fx = Math.floor(V.x + rnd(-18, 18)), fz = Math.floor(V.z + rnd(-18, 18));
      if (!BF.world.isLoaded(fx, fz)) continue;
      const fy = BF.world.heightAt(fx, fz);
      if (fy > 0 && BF.world.getBlock(fx, fy, fz) === BF.B.farmland) { ai.mode = "walk"; ai.tx = fx + 0.5; ai.tz = fz + 0.5; ai.t = rnd(6, 10); break; }
    }
  }
  if (V) {
    const dx = V.x - m.position.x, dz = V.z - m.position.z, d = Math.hypot(dx, dz);
    if (d > 40) { // wandered too far: head back toward the centre
      ai.mode = "walk"; ai.tx = V.x + rnd(-6, 6); ai.tz = V.z + rnd(-6, 6); ai.t = rnd(5, 8);
    } else if (ai.mode === "walk" && Math.hypot(ai.tx - V.x, ai.tz - V.z) > 36) {
      ai.tx = V.x + rnd(-20, 20); ai.tz = V.z + rnd(-20, 20);
    }
  }
  wanderAI(m, dt, out);
  if (m.child && BF.breeding) BF.breeding.childMove(m, dt, out);   // children run about (js/breeding.js)
}

function golemAI(m, dt, out) {
  const ai = m.ai, T = m.def;
  ai.provoked = Math.max(0, ai.provoked - dt);
  ai.hScanT = (ai.hScanT || 0) - dt;
  if (ai.hScanT <= 0) { ai.hScanT = 0.5; ai.foe = nearestMob(m, 16, o => o.hostile); }
  if (ai.foe && chaseAndHit(m, ai.foe, dt, out, irnd(7, 14), 1.2)) return;
  ai.foe = null;
  if (creative()) ai.provoked = 0;
  if (ai.provoked > 0 && playerAlive()) {
    const p = player();
    const dx = p.position.x - m.position.x, dz = p.position.z - m.position.z, hd = Math.hypot(dx, dz);
    if (hd < 24) {
      const nx = dx / (hd || 1), nz = dz / (hd || 1);
      const reach = m.halfWidth + (p.halfWidth || 0.3) + 0.6;
      if (hd > reach * 0.8) { out.x = nx * T.speed * 1.2; out.z = nz * T.speed * 1.2; }
      out.faceTarget = true; m.lookAt = "player";
      ai.attackCd -= dt;
      if (hd < reach && Math.abs(p.position.y - m.position.y) < 2 && ai.attackCd <= 0) {
        ai.attackCd = 1.3; ai.swingT = 0.35;
        if (p.damage) p.damage(irnd(5, 9), m.position.clone());
      }
      return;
    }
  }
  // patrol near the village centre, slowly
  const V = m.village;
  if (V && Math.hypot(V.x - m.position.x, V.z - m.position.z) > 14) { ai.mode = "walk"; ai.tx = V.x + rnd(-5, 5); ai.tz = V.z + rnd(-5, 5); ai.t = rnd(5, 8); }
  wanderAI(m, dt, out);
  out.x *= 0.6; out.z *= 0.6;
}

// ---------- per-mob update ----------
const _desired = { x: 0, z: 0, faceTarget: false };
function updateMob(m, dt) {
  const T = m.def, ai = m.ai;
  m.age += dt;
  m.hurtT -= dt; m.invuln -= dt; m.knockT -= dt; ai.swingT -= dt;

  const light = Math.max(0.12, skyLight() * skyAt(m.position.x, m.position.y + 0.5, m.position.z).factor,
    Math.pow(BF.world.getBlockLight(m.position.x, m.position.y + 0.5, m.position.z) / 15, 1.5));

  if (m.dead) {
    m.deathT += dt;
    m.model.rotation.z = Math.min(1, m.deathT / 0.45) * Math.PI / 2;
    m.material.color.setRGB(light * 1.5, light * 0.35, light * 0.35);
    m.vel.x *= 0.8; m.vel.z *= 0.8; m.vel.y -= GRAVITY * dt;
    BF.world.moveBox(m.position, m.vel, m.halfWidth, Math.min(m.height, 0.5), dt, { stepUp: 0 });
    if (m.deathT > 1.0) {
      puff(new THREE.Vector3(m.position.x, m.position.y + 0.2, m.position.z), 8, 0.4, false, 1);
      removeMob(m);
    }
    return;
  }

  if (m.type === "villager") villagerDoors(m);
  if (m.sleeping) {
    if (bedtime() && bedOK(m.bed)) { sleepPose(m); m.material.color.setScalar(light); return; }
    wake(m);
  }

  // ---- AI ----
  _desired.x = 0; _desired.z = 0; _desired.faceTarget = false; _desired.faceX = null; _desired.faceZ = null;
  if (T.hostile) { hostileAI(m, dt, _desired); if (m.type === "zombie") zombieBreakDoor(m, dt, _desired); }
  else if (m.type === "villager") villagerAI(m, dt, _desired);
  else if (T.golem) golemAI(m, dt, _desired);
  else if (ai.fleeT > 0) {
    ai.fleeT -= dt;
    let fx = Math.cos(m.yaw), fz = Math.sin(m.yaw);
    if (playerAlive()) { fx = m.position.x - player().position.x; fz = m.position.z - player().position.z; }
    ai.fleeJitter = (ai.fleeJitter || Math.random() * 6) + rnd(-3, 3) * dt;
    const a = Math.atan2(fz, fx) + Math.sin(ai.fleeJitter) * 0.8;
    _desired.x = Math.cos(a) * T.flee; _desired.z = Math.sin(a) * T.flee;
    m.lookAt = null;
  } else wanderAI(m, dt, _desired);
  if (m.removed) return; // exploded

  // ---- physics ----
  if (m.knockT <= 0) {
    const k = Math.min(1, dt * (m.onGround ? 10 : m.inWater ? 4 : 2.5));
    m.vel.x += (_desired.x - m.vel.x) * k;
    m.vel.z += (_desired.z - m.vel.z) * k;
  }
  if (m.inWater) {
    m.vel.y += (m.headInWater || m.type === "chicken" ? 22 : 9) * dt; // buoyancy: float up
    m.vel.y -= GRAVITY * 0.5 * dt;
    m.vel.y = Math.max(-2, Math.min(m.vel.y, 2.5));
  } else {
    m.vel.y -= GRAVITY * dt;
    if (T.slowFall && m.vel.y < -2) m.vel.y = -2;
    if (m.vel.y < -40) m.vel.y = -40;
  }
  separate(m, dt);

  const wasGround = m.onGround;
  const res = BF.world.moveBox(m.position, m.vel, m.halfWidth, m.height, dt, { stepUp: 1.05 });
  m.onGround = res.onGround; m.inWater = res.inWater; m.headInWater = !!res.headInWater;
  const wants = Math.abs(_desired.x) + Math.abs(_desired.z) > 0.1;
  if ((res.hitX || res.hitZ) && wants) {
    if (T.climbs && (ai.target || ai.mode === "walk")) m.vel.y = 3.2;  // spiders climb walls
    else if (res.onGround) m.vel.y = 7.6;                              // jump obstacles
    else if (m.inWater) m.vel.y = 4;
    if (!T.hostile && ai.mode === "walk" && Math.random() < 0.3) pickWander(m, 8);
  }
  // fall damage
  const climbing = T.climbs && (res.hitX || res.hitZ);
  if (m.onGround || m.inWater || climbing) {
    if (m.onGround && !wasGround && !T.slowFall && !m.inWater) {
      const fall = m.fallStart - m.position.y;
      if (fall > 3.5) { m.invuln = 0; damageMob(m, Math.floor(fall - 3), null, false); }
    }
    m.fallStart = m.position.y;
  } else if (m.position.y > m.fallStart) m.fallStart = m.position.y;
  if (m.dead) return;

  // ---- daylight burning ----
  let burning = false;
  if (T.burns && !m.inWater && skyLight() > 0.55 && !isNight()) {
    if (skyAt(m.position.x, m.position.y + m.height - 0.1, m.position.z).open &&
        !(BF.weather && BF.weather.rainingAt && BF.weather.rainingAt(m.position.x, m.position.y + m.height, m.position.z))) { // rain/snow shields undead
      burning = true;
      ai.burnT += dt;
      if (ai.burnT >= 1) { ai.burnT = 0; m.invuln = 0; damageMob(m, 1, null, false); }
    }
  }
  updateFire(m, burning && !m.dead, dt);
  if (m.dead) return;

  // ---- orientation ----
  const hs = Math.hypot(m.vel.x, m.vel.z);
  let targetYaw = m.yaw;
  if (_desired.faceTarget && playerAlive()) {
    const p = player().position;
    targetYaw = Math.atan2(p.x - m.position.x, p.z - m.position.z);
  } else if (_desired.faceX != null) targetYaw = Math.atan2(_desired.faceX - m.position.x, _desired.faceZ - m.position.z);
  else if (hs > 0.3 && m.knockT <= 0) targetYaw = Math.atan2(m.vel.x, m.vel.z);
  m.yaw = wrapAngle(m.yaw + Math.max(-7 * dt, Math.min(7 * dt, wrapAngle(targetYaw - m.yaw))));
  m.model.rotation.y = m.yaw;

  // head look
  let hy = 0, hp = 0;
  if (m.lookAt === "player" && playerAlive()) {
    const p = player(), e = p.eyePos ? p.eyePos() : p.position;
    const dx = e.x - m.position.x, dz = e.z - m.position.z, dy = e.y - (m.position.y + m.height * 0.85);
    hy = wrapAngle(Math.atan2(dx, dz) - m.yaw);
    hp = Math.atan2(dy, Math.hypot(dx, dz));
  } else if (m.lookAt && m.lookAt.position) {
    const o = m.lookAt, dx = o.position.x - m.position.x, dz = o.position.z - m.position.z;
    const dy = o.position.y + o.height * 0.85 - (m.position.y + m.height * 0.85);
    hy = wrapAngle(Math.atan2(dx, dz) - m.yaw);
    hp = Math.atan2(dy, Math.hypot(dx, dz));
  } else if (m.lookAt && typeof m.lookAt === "object") { hy = m.lookAt.yaw; hp = m.lookAt.pitch; }
  hy = Math.max(-1.1, Math.min(1.1, hy)); hp = Math.max(-0.7, Math.min(0.7, hp));
  const kk = Math.min(1, dt * 6);
  m.headYaw += (hy - m.headYaw) * kk; m.headPitch += (hp - m.headPitch) * kk;

  // ---- animation ----
  const walkTarget = Math.min(1, hs / 1.4);
  m.walkAmt += (walkTarget - m.walkAmt) * Math.min(1, dt * 8);
  m.walkPhase += dt * (3 + hs * 3.2);
  animate(m);

  // ---- colour: light, hurt flash, creeper fuse ----
  const col = m.material.color;
  if (m.hurtT > 0) col.setRGB(light * 1.5, light * 0.35, light * 0.35);
  else if (m.type === "creeper" && ai.fuse > 0) {
    const f = ai.fuse / 1.5;
    col.setScalar(Math.sin(ai.fuse * (8 + f * 24)) > 0.2 ? Math.max(2.5, light * 3) : light);
  } else col.setScalar(light);
  if (m.type === "villager") updateBadge(m);
  if (m.type === "creeper") {
    const f = Math.min(1, ai.fuse / 1.5);
    const s = 1 + f * 0.22 + (f > 0 ? Math.sin(ai.fuse * 40) * 0.02 : 0);
    m.model.scale.set(s, 1 + f * 0.12, s);
  }
}

// Villager level badge on the belt (level >= 2): iron, gold, emerald, diamond.
const BADGE_COLORS = [null, null, 0xd8d8d8, 0xf2d64b, 0x2fd06a, 0x5ddfe0];
const badgeMats = [];
let badgeGeo = null;
function updateBadge(m) {
  const lv = Math.max(1, Math.min(5, m.level | 0 || 1));
  if (lv === m.badgeLevel) return;
  m.badgeLevel = lv;
  if (lv < 2) { if (m.badge) m.badge.visible = false; return; }
  if (!badgeGeo) badgeGeo = new THREE.BoxGeometry(3 * PX, 3 * PX, 0.6 * PX);
  if (!badgeMats[lv]) badgeMats[lv] = new THREE.MeshBasicMaterial({ color: BADGE_COLORS[lv] });
  if (!m.badge) {
    m.badge = new THREE.Mesh(badgeGeo, badgeMats[lv]);
    m.badge.position.set(0, 14 * PX, 3.4 * PX);
    m.model.add(m.badge);
  }
  m.badge.material = badgeMats[lv];
  m.badge.visible = true;
}

function animate(m) {
  const amp = m.walkAmt, ph = m.walkPhase, ai = m.ai;
  const sw = Math.sin(ph);
  for (const name in m.meshes) {
    const mesh = m.meshes[name], p = mesh.userData.part;
    if (p.head) { mesh.rotation.y = m.headYaw; mesh.rotation.x = -m.headPitch; }
    else if (p.swing) mesh.rotation.x = sw * 0.75 * amp * p.swing;
    else if (p.folded) mesh.rotation.x = ai.swingT > 0 ? -Math.sin(ai.swingT / 0.35 * Math.PI) * 0.85 : 0;   // builders swing the folded arms as they place a block
    else if (p.arm) {
      if (m.type === "zombie") {
        mesh.rotation.x = -Math.PI / 2 + Math.sin(m.age * 2 + p.arm) * 0.06 + (ai.swingT > 0 ? Math.sin(ai.swingT / 0.35 * Math.PI) * 0.7 : 0);
        mesh.rotation.z = Math.sin(m.age * 1.3 + p.arm) * 0.04;
      } else if (ai.aiming) { // skeleton drawing the bow
        mesh.rotation.x = -Math.PI / 2 - m.headPitch;
        mesh.rotation.y = p.arm > 0 ? 0.15 : 0.6;
      } else {
        mesh.rotation.x = -sw * 0.6 * amp * p.arm;
        mesh.rotation.y = 0;
      }
    } else if (p.golemArm) {
      const lift = ai.swingT > 0 ? Math.sin(ai.swingT / 0.35 * Math.PI) * 1.6 : 0;
      mesh.rotation.x = -sw * 0.5 * amp * p.golemArm - lift;
      mesh.rotation.z = 0.06 * p.golemArm;
    } else if (p.wing) {
      mesh.rotation.z = (m.onGround ? 0 : Math.abs(Math.sin(m.age * 20)) * 1.1) * p.wing;
    } else if (p.spiderLeg) {
      const side = p.spiderLeg, alt = (p.idx % 2 === 0 ? 1 : -1) * side;
      mesh.rotation.y = p.spread + Math.sin(ph * 1.6) * 0.35 * amp * alt;
      mesh.rotation.z = -0.6 * side + Math.max(0, Math.cos(ph * 1.6) * alt) * 0.25 * amp * side;
    }
  }
  // chickens bob their head while walking
  if (m.type === "chicken" && m.meshes.head) m.meshes.head.position.z = (3 + Math.sin(ph * 2) * 0.6 * amp) * PX;
}

function updateFire(m, on, dt) {
  if (!on) { if (m.fire) m.fire.visible = false; return; }
  if (!m.fire) {
    m.fire = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const f = new THREE.Mesh(fireGeo, fireMat);
      f.position.set(rnd(-m.halfWidth, m.halfWidth), rnd(0, m.height), rnd(-m.halfWidth, m.halfWidth));
      m.fire.add(f);
    }
    m.root.add(m.fire);
  }
  m.fire.visible = true;
  for (const f of m.fire.children) {
    f.position.y += dt * 1.5;
    if (f.position.y > m.height + 0.15 || Math.random() < dt * 4) {
      f.position.set(rnd(-m.halfWidth - 0.05, m.halfWidth + 0.05), rnd(0, m.height * 0.6), rnd(-m.halfWidth - 0.05, m.halfWidth + 0.05));
      f.scale.setScalar(rnd(0.6, 1.4));
    }
  }
}

function separate(m, dt) {
  for (const o of list) {
    if (o === m || o.dead) continue;
    const dx = m.position.x - o.position.x, dz = m.position.z - o.position.z;
    const min = m.halfWidth + o.halfWidth;
    if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
    if (m.position.y > o.position.y + o.height || o.position.y > m.position.y + m.height) continue;
    const d = Math.hypot(dx, dz) || 0.01;
    m.vel.x += (dx / d) * 6 * dt; m.vel.z += (dz / d) * 6 * dt;
  }
  if (playerAlive()) {
    const p = player();
    const dx = m.position.x - p.position.x, dz = m.position.z - p.position.z;
    const min = m.halfWidth + (p.halfWidth || 0.3);
    if (Math.abs(dx) < min && Math.abs(dz) < min && m.position.y < p.position.y + (p.height || 1.8) && p.position.y < m.position.y + m.height) {
      const d = Math.hypot(dx, dz) || 0.01;
      m.vel.x += (dx / d) * 8 * dt; m.vel.z += (dz / d) * 8 * dt;
    }
  }
}

// ---------- spawning ----------
// Needs a solid block below and air (not water/plants) for the mob's height.
function standable(x, y, z, hw, h) {
  const w = BF.world;
  if (y < 1 || y + Math.ceil(h) >= BF.H) return false;
  if (!w.isSolid(x, y - 1, z)) return false;
  for (let k = 0; k < Math.max(2, Math.ceil(h)); k++) if (w.getBlock(x, y + k, z) !== 0) return false;
  return !w.boxCollides(x + 0.5, y, z + 0.5, hw, h);
}
function countMobs() {
  let p = 0, h = 0;
  for (const m of list) if (!m.dead && !m.def.village) { if (m.hostile) h++; else p++; }
  return { p, h };
}
function tryPassiveSpawn() {
  if (!playerAlive()) return;
  if (isNight() && Math.random() > 0.12) return;
  const pp = player().position, w = BF.world, grass = BF.B.grass;
  const a = Math.random() * Math.PI * 2, d = rnd(24, 64);
  const x = Math.floor(pp.x + Math.cos(a) * d), z = Math.floor(pp.z + Math.sin(a) * d);
  if (!w.isLoaded(x, z)) return;
  const gy = w.heightAt(x, z);
  if (gy < 1 || w.getBlock(x, gy, z) !== grass) return;
  const type = PASSIVE_TYPES[Math.floor(Math.random() * PASSIVE_TYPES.length)];
  const T = TYPES[type];
  if (!standable(x, gy + 1, z, T.hw, T.h)) return;
  const n = irnd(2, 4);
  let spawned = 0;
  for (let i = 0; i < n * 3 && spawned < n; i++) {
    const sx = x + (i === 0 ? 0 : irnd(-3, 3)), sz = z + (i === 0 ? 0 : irnd(-3, 3));
    if (!w.isLoaded(sx, sz)) continue;
    const sy = w.heightAt(sx, sz);
    if (sy < 1 || w.getBlock(sx, sy, sz) !== grass || !standable(sx, sy + 1, sz, T.hw, T.h)) continue;
    if (list.some(o => Math.abs(o.position.x - sx - 0.5) < 0.9 && Math.abs(o.position.z - sz - 0.5) < 0.9)) continue;
    createMob(type, sx + 0.5, sy + 1, sz + 0.5);
    spawned++;
    if (countMobs().p >= PASSIVE_CAP) break;
  }
}
function pickHostileType() {
  let r = Math.random();
  for (const [t, wgt] of HOSTILE_WEIGHTS) { if ((r -= wgt) <= 0) return t; }
  return "zombie";
}
function tryHostileSpawn() {
  if (!playerAlive()) return;
  const pp = player().position, w = BF.world;
  const type = pickHostileType(), T = TYPES[type];
  const surface = isNight() && Math.random() < 0.6;
  const a = Math.random() * Math.PI * 2, d = surface ? rnd(24, 48) : rnd(12, 40);
  const x = Math.floor(pp.x + Math.cos(a) * d), z = Math.floor(pp.z + Math.sin(a) * d);
  if (!w.isLoaded(x, z)) return;
  if (surface) {
    const gy = w.heightAt(x, z);
    if (gy < 1 || !BF.OPAQUE[w.getBlock(x, gy, z)]) return;
    if (!standable(x, gy + 1, z, T.hw, T.h)) return;
    if (w.getBlockLight(x, gy + 1, z) > 7) return; // torch/lantern-lit ground stays safe
    if (Math.hypot(x + 0.5 - pp.x, gy + 1 - pp.y, z + 0.5 - pp.z) < 24) return;
    createMob(type, x + 0.5, gy + 1, z + 0.5);
    return;
  }
  // cave: a dark, covered air pocket in this column
  const c = w.chunkAt(x, z);
  if (!c || !c.top) return;
  const top = c.top[(z - c.cz * BF.CS) * BF.CS + (x - c.cx * BF.CS)];
  if (top < 8) return;
  const yMin = Math.max(2, Math.floor(pp.y) - 24), yMax = Math.min(top - 3, Math.floor(pp.y) + 24);
  if (yMax <= yMin) return;
  for (let tries = 0; tries < 6; tries++) {
    const y = irnd(yMin, yMax);
    if (!standable(x, y, z, T.hw, T.h)) continue;
    if (!BF.OPAQUE[w.getBlock(x, y - 1, z)]) continue;
    const s = skyAt(x, y, z);
    if (s.open || s.factor > 0.6) continue;
    if (w.getBlockLight(x, y, z) > 7) continue; // lit caves are safe
    if (Math.hypot(x + 0.5 - pp.x, y - pp.y, z + 0.5 - pp.z) < 20) continue;
    createMob(type, x + 0.5, y, z + 0.5);
    return;
  }
}

// ---------- villages ----------
// Villages come from BF.worldgen.villagesNear (optional). Each is tracked once by its centre so villagers are
// not duplicated; villagers/golems removed by chunk unloading are replaced when the village loads again,
// but killed ones stay dead.
const villages = new Map();
let villageT = 0;
// Villager trading state by stable key (village "x,z" + roster slot index): kept while unloaded and saved with the world.
const villagerSaves = new Map();
function villagerKey(m) { return m.village && m.slot ? m.village.key + "#" + m.slot.idx : null; }
let restockT = 0;
function restockVillagers(dt) { // once per in-game day, never while someone is trading with the villager
  restockT -= dt;
  if (restockT > 0 || !BF.trades || !BF.sky) return;
  restockT = 2;
  for (const m of list) if (m.type === "villager" && !m.dead && !m.removed && !m.tradingWith && !m.child) BF.trades.restock(m, BF.sky.day);
}
const VILLAGERS_PER_VILLAGE = 24;
const EXPLORER_CHANCE = 0.7;   // per cartographer in the roster
function findStand(x, y, z, T) {
  x = Math.floor(x); z = Math.floor(z);
  const base = Math.floor(y);
  const dys = [0, 1, -1, 2, -2, 3, -3, 4];
  for (let r = 0; r <= 3; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    if (!BF.world.isLoaded(x + dx, z + dz)) continue;
    for (const dy of dys) if (standable(x + dx, base + dy, z + dz, T.hw, T.h)) return [x + dx + 0.5, base + dy, z + dz + 0.5];
  }
  return null;
}
// Deterministic villager roster for a village: one slot per bed, special buildings first, each with a profession.
function seededRand(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h ^= (BF.state && BF.state.seed) | 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SPECIAL_PROF = { library: () => "librarian", church: () => "cleric", smith: r => ["armorer", "weaponsmith", "toolsmith"][Math.floor(r() * 3)] };
function villageRoster(rec) {
  const r = seededRand("village:" + rec.key);
  const slots = [];
  // one villager per bed (houses without beds hold one, big ones two)
  rec.houses.forEach((h, i) => {
    const n = h && h.beds ? Math.max(1, h.beds.length) : h && h.type === "big" ? 2 : 1;
    for (let k = 0; k < n; k++) slots.push({ house: h, idx: i * 2 + k, bed: (h && h.beds && h.beds[k]) || null, prof: null });
  });
  if (!slots.length) slots.push({ house: null, idx: 0, prof: null });
  // special buildings first so they always get their tradesperson, then a seeded shuffle of the rest
  const special = slots.filter(sl => sl.house && SPECIAL_PROF[sl.house.type]);
  const rest = slots.filter(sl => !special.includes(sl));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const nBuilders = BF.builder ? (rec.nb >= 19 ? 2 : rec.nb >= 6 ? 1 : 0) : 0;   // builders count toward the cap of 24
  const ordered = special.concat(rest).slice(0, VILLAGERS_PER_VILLAGE - nBuilders);
  const used = {};
  for (const sl of ordered) if (sl.house && SPECIAL_PROF[sl.house.type]) { sl.prof = SPECIAL_PROF[sl.house.type](r); used[sl.prof] = (used[sl.prof] || 0) + 1; }
  // others cycle through a shuffled pool, least-used first, so nothing repeats while others are missing
  const pool = PROFESSIONS.filter(p => p !== "nitwit" && p !== "builder" && p !== "unemployed" && p !== "explorer");   // builders are never part of the shuffled pool: the roster of old saves must not shift
  let bag = [];
  for (const sl of ordered) {
    if (sl.prof) continue;
    if (r() < 0.1) { sl.prof = "nitwit"; continue; }
    if (!bag.length) {
      const min = Math.min(...pool.map(p => used[p] || 0));
      bag = pool.filter(p => (used[p] || 0) === min);
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    sl.prof = bag.pop();
    used[sl.prof] = (used[sl.prof] || 0) + 1;
  }
  // builder slots go at the END with their own key range (<village key>#1000+n): other slots keep their persistence keys
  for (let k = 0; k < nBuilders; k++) ordered.push({ house: null, idx: 1000 + k, bed: null, prof: "builder" });
  // explorers: a village that has cartographers gets an explorer for each of them with 70% probability (own seeded stream, so nothing else shifts);
  // never in a village without a cartographer, never beyond the village cap. Own key range <village key>#1100+n.
  if (BF.explorer) {
    const re = seededRand("explorers:" + rec.key);
    let nE = 0;
    for (const sl of ordered) if (sl.prof === "cartographer" && re() < EXPLORER_CHANCE) nE++;
    nE = Math.min(nE, Math.max(0, VILLAGERS_PER_VILLAGE - ordered.length));
    for (let k = 0; k < nE; k++) ordered.push({ house: null, idx: 1100 + k, bed: null, prof: "explorer" });
  }
  return ordered;
}

function updateVillages(dt) {
  for (const rec of villages.values()) rec.angryT = Math.max(0, rec.angryT - dt);
  villageT -= dt;
  if (villageT > 0) return;
  villageT = 1;
  const wg = BF.worldgen;
  if (!wg || typeof wg.villagesNear !== "function" || !playerAlive()) return;
  const pp = player().position;
  let vs;
  try { vs = wg.villagesNear(pp.x, pp.z, 96) || []; } catch (e) { return; }
  for (const v of vs) {
    if (!v || v.x == null) continue;
    const key = Math.round(v.x) + "," + Math.round(v.z);
    let rec = villages.get(key);
    if (!rec) { rec = { key, x: v.x, y: v.y, z: v.z, biome: v.biome, houses: v.houses || [], killed: {}, angryT: 0, members: [], wg: v, nb: (v.buildings || []).length }; villages.set(key, rec); }
    if (Math.hypot(v.x - pp.x, v.z - pp.z) > 80) continue;
    if (!BF.world.isLoaded(v.x, v.z)) continue;
    const loadedHouse = h => BF.world.isLoaded(h.x, h.z) && BF.world.isLoaded(h.x + (h.w || 1), h.z + (h.d || 1));
    rec.members = rec.members.filter(m => !m.removed);
    const alive = t => rec.members.filter(m => m.type === t && !m.dead && !m.bred).length;   // newborns (js/breeding.js) are not roster slots
    if (!rec.roster) rec.roster = villageRoster(rec);
    const wantV = rec.roster.length - (rec.killed.villager || 0);
    let haveV = alive("villager");
    if (rec.style == null) rec.style = typeof v.style === "number" ? v.style : styleAt(v.x, v.z);
    const taken = new Set(rec.members.filter(m => m.type === "villager" && !m.dead).map(m => m.slot));
    for (const sl of rec.roster) {
      if (haveV >= wantV) break;
      if (taken.has(sl)) continue;
      const H = sl.house;
      if (H && !loadedHouse(H)) continue;
      const sx = H ? H.x + (H.w || 1) / 2 : v.x + rnd(-6, 6), sz = H ? H.z + (H.d || 1) / 2 : v.z + rnd(-6, 6);
      const sy = H && H.y != null ? H.y : (v.y != null ? v.y : BF.world.heightAt(sx, sz) + 1);
      let at = findStand(sx, sy, sz, TYPES.villager);
      if (!at && H && H.doorX != null) at = findStand(H.doorX, sy, H.doorZ, TYPES.villager);
      if (!at) continue;
      const m = createMob("villager", at[0], at[1], at[2], sl.prof, rec.style);
      m.village = rec; m.home = H; m.slot = sl; m.bed = sl.bed; rec.members.push(m); haveV++;
      m.ai.leaving = !bedtime(); // spawned indoors by day: walk out through the door
      const sv = villagerSaves.get(villagerKey(m));
      if (sv) BF.trades.unpack(m, sv); // inventory/level/xp survive unload/reload and saved games
      if (BF.jobs) BF.jobs.onSpawn(m, rec, sv);   // jobsite claim / saved profession (js/jobs.js)
      if (sl.prof === "builder" && BF.builder) BF.builder.onSpawn(m, rec);
    }
    const wantG = (rec.houses.length >= 12 ? 2 : 1) - (rec.killed.iron_golem || 0);
    if (alive("iron_golem") < wantG) {
      const gy = v.y != null ? v.y : BF.world.heightAt(v.x, v.z) + 1;
      const at = findStand(v.x, gy, v.z, TYPES.iron_golem) || findStand(v.x + 3, BF.world.heightAt(v.x + 3, v.z) + 1, v.z, TYPES.iron_golem);
      if (at) { const g = createMob("iron_golem", at[0], at[1], at[2]); g.village = rec; rec.members.push(g); }
    }
  }
}

function despawn(dt) {
  if (!BF.player || !BF.player.position) return;
  const pp = BF.player.position;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const d = m.position.distanceTo(pp);
    if (d > DESPAWN_DIST || !BF.world.isLoaded(m.position.x, m.position.z)) { removeMob(m); continue; }
    if (m.hostile && !m.dead && d > 48 && m.age > 20 && Math.random() < dt * 0.03) removeMob(m);
  }
}

// ---------- ray vs mobs ----------
function rayAABB(o, d, mn, mx) {
  let t0 = 0, t1 = Infinity;
  const os = [o.x, o.y, o.z], ds = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-9) { if (os[a] < mn[a] || os[a] > mx[a]) return null; continue; }
    let ta = (mn[a] - os[a]) / ds[a], tb = (mx[a] - os[a]) / ds[a];
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

// ---------- public API ----------
BF.mobs = {
  list,
  types: Object.keys(TYPES),
  init(sceneRef) {
    scene = sceneRef;
    baseMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    arrowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    fireMat = new THREE.MeshBasicMaterial({ color: 0xffa020, transparent: true, opacity: 0.9, depthWrite: false });
    puffMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8, transparent: true, opacity: 0.85, depthWrite: false });
    puffMatDark = new THREE.MeshBasicMaterial({ color: 0x4a4a4a, transparent: true, opacity: 0.85, depthWrite: false });
    fireGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    puffGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
    // arrow points along +Z (Object3D.lookAt aims +Z at the target)
    arrowGeo = buildGeometry([
      box([-0.5, -0.5, -4], [0.5, 0.5, 3], 0x8a6a40),
      box([-0.75, -0.75, 3], [0.75, 0.75, 4.5], 0x9a9a9a),
      box([-1.5, -0.25, -4.5], [1.5, 0.25, -2.5], 0xf0f0f0),
      box([-0.25, -1.5, -4.5], [0.25, 1.5, -2.5], 0xf0f0f0),
    ], 11);
    BF.world.onChunkUnload((cx, cz) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (Math.floor(m.position.x / BF.CS) === cx && Math.floor(m.position.z / BF.CS) === cz) removeMob(m);
      }
      for (let i = arrows.length - 1; i >= 0; i--) {
        const a = arrows[i];
        if (Math.floor(a.pos.x / BF.CS) === cx && Math.floor(a.pos.z / BF.CS) === cz) { scene.remove(a.mesh); arrows.splice(i, 1); }
      }
    });
  },
  update(dt) {
    if (!scene) return;
    dt = Math.min(dt, 0.05);
    planBudget = 2; // A* searches per frame
    for (const m of list.slice()) {
      if (m.removed) continue;
      try { updateMob(m, dt); } catch (e) { console.error(e); removeMob(m); }
    }
    updateArrows(dt);
    updatePuffs(dt);
    if (BF.builder) BF.builder.tick(dt);
    if (BF.villageLife) BF.villageLife.tick(dt);   // villager meals, farm scans (js/villagelife.js)
    if (BF.jobs) BF.jobs.tick(dt);   // jobsite validation, unemployed villagers look for work (js/jobs.js)
    if (BF.breeding) BF.breeding.tick(dt);   // encounters, hearts, children (js/breeding.js)
    arrowMat.color.setScalar(Math.max(0.15, skyLight()));
    for (let i = 2; i < badgeMats.length; i++) if (badgeMats[i]) badgeMats[i].color.setHex(BADGE_COLORS[i]).multiplyScalar(Math.max(0.15, skyLight()));
    spawnT -= dt;
    if (spawnT <= 0 && BF.mobs.spawning !== false) {
      spawnT = 0.4;
      const c = countMobs();
      if (c.p < PASSIVE_CAP && Math.random() < 0.5) tryPassiveSpawn();
      if (c.h < HOSTILE_CAP) tryHostileSpawn();
    }
    try { updateVillages(dt); restockVillagers(dt); } catch (e) { console.error(e); }
    despawn(dt);
  },
  // Nearest living mob whose AABB the ray hits within maxDist: {mob, dist} or null.
  raycast(origin, dir, maxDist) {
    let best = null;
    const mn = [0, 0, 0], mx = [0, 0, 0];
    for (const m of list) {
      if (m.dead || m.removed) continue;
      const p = m.position, hw = m.halfWidth;
      mn[0] = p.x - hw; mn[1] = p.y; mn[2] = p.z - hw;
      mx[0] = p.x + hw; mx[1] = p.y + m.height; mx[2] = p.z + hw;
      const t = rayAABB(origin, dir, mn, mx);
      if (t != null && t <= maxDist && (!best || t < best.dist)) best = { mob: m, dist: t };
    }
    return best;
  },
  // Player attack. Returns true if the hit landed (false while the mob is briefly invulnerable).
  hit(mob, damage, knockDir) { return damageMob(mob, damage, knockDir, true); },
  // /kill (commands.js): kills outright, no knockback, no golem anger; drops as a normal death. Returns false if already dead.
  kill(mob) { if (!mob || mob.dead || mob.removed) return false; kill(mob, true); return true; },
  // Debug helper: spawn a mob with its feet at (x, y, z). Villagers take a profession and a style
  // ("plains" | "desert" | "snowy" | "savanna" | "taiga" or 0..4; default from the biome).
  spawn(type, x, y, z, variant, style) { return scene ? createMob(type, x, y, z, variant, style) : null; },
  villages,
  // Villager trading state for saved games: {key -> {inv, level, xp, day}} (see CONTRACT.md); loaded ones override stored.
  exportVillagers() {
    const out = {};
    for (const [k, v] of villagerSaves) out[k] = v;
    for (const m of list) if (m.type === "villager" && !m.dead && m.inv) { const k = villagerKey(m); if (k) out[k] = BF.trades.pack(m); }
    if (BF.builder) BF.builder.exportAll(out);   // "built:<village key>" -> structures the builders have placed (progress included)
    if (BF.breeding) BF.breeding.exportAll(out);   // newborns "<village key>#2000+k" (+ .bred), "breeding:cd"
    return out;
  },
  importVillagers(o) {
    villagerSaves.clear();
    if (o && typeof o === "object") for (const k in o) if (k.slice(0, 6) !== "built:") villagerSaves.set(k, o[k]);
    if (BF.builder) BF.builder.importAll(o);
    if (BF.jobs) BF.jobs.importAll(o);   // jobsite claims of saved villagers
    if (BF.breeding) BF.breeding.importAll(o);
  },
  // Right-click on a mob (called by the player module). Opens the trade screen when the inventory module has one
  // (returns null); otherwise falls back to a simple 3 wheat -> 1 emerald trade and returns a message string.
  interact(mob) {
    if (!mob || mob.dead || mob.removed || mob.type !== "villager") return null;
    if (mob.sleeping) return "Villager is sleeping";
    if (mob.child) { mob.lookAt = "player"; mob.ai.lookT = 1.5; return "The child is too young to trade"; }
    mob.lookAt = "player"; mob.ai.lookT = 3; mob.ai.mode = "idle"; mob.ai.t = 3;
    if (mob.profession === "nitwit") { mob.ai.lookT = 1; return "The nitwit just stares at you"; }
    if (mob.profession === "unemployed") { mob.ai.lookT = 1; return "This villager has no job yet"; }
    const inv = BF.inventory, I = BF.I || {};
    if (inv && typeof inv.openTrade === "function") {
      try { inv.openTrade(mob); } catch (e) { console.error(e); }
      return null;
    }
    const now = performance.now() / 1000;
    if (now < mob.tradeCd) return null;
    mob.tradeCd = now + 0.6;
    if (!inv || typeof inv.remove !== "function" || I.wheat_item == null || I.emerald == null) return "The villager has nothing to trade";
    if (typeof inv.count === "function" && inv.count(I.wheat_item) < 3) return "The " + mob.profession + " wants 3 wheat for an emerald";
    const got = inv.remove(I.wheat_item, 3);
    if (got !== 3) { if (got > 0) inv.add(I.wheat_item, got); return "The " + mob.profession + " wants 3 wheat for an emerald"; }
    const left = inv.add(I.emerald, 1);
    if (left > 0) { inv.add(I.wheat_item, 3); inv.remove(I.emerald, 1 - left); return "Your inventory is full"; }
    puff(new THREE.Vector3(mob.position.x, mob.position.y + 2.1, mob.position.z), 4, 0.2, false, 0.6);
    return "Traded 3 wheat for 1 emerald";
  },
  // Called by the trade screen: while trading the villager stands still and faces the player.
  setTrading(mob, on) {
    if (!mob || mob.removed) return;
    mob.tradingWith = on ? BF.player : null;
    if (on) { mob.vel.x = mob.vel.z = 0; mob.ai.mode = "idle"; mob.ai.t = 2; mob.lookAt = "player"; }
  },
  professions: PROFESSIONS,
  // js/jobs.js: the deterministic roster of a village record ({key, houses, nb}) and in-place profession change (rebuilds the outfit)
  roster: villageRoster,
  setProfession(m, prof) {
    prof = PROF_ALIAS[prof] || prof;
    if (!m || m.type !== "villager" || !PROFESSIONS.includes(prof) || !m.model) return false;
    const style = Math.max(0, VILLAGE_STYLES.indexOf(m.style));
    for (const k in m.meshes) { m.model.remove(m.meshes[k]); delete m.meshes[k]; }
    m.lids = null;
    for (const p of typeParts("villager", prof + "/" + style)) {
      const mesh = new THREE.Mesh(p.geo, m.material);
      mesh.position.set(p.pivot[0] * PX, p.pivot[1] * PX, p.pivot[2] * PX);
      mesh.rotation.order = "YXZ"; mesh.userData.part = p;
      m.model.add(mesh); m.meshes[p.name] = mesh;
    }
    m.variant = prof; m.profession = prof;
    return true;
  },
  // Navigation helpers for js/builder.js (A* over walkable cells, route following, per-frame search budget).
  nav: { findPath, followRoute, feetCell, walkCell, blockAt, takePlan() { if (planBudget > 0) { planBudget--; return true; } return false; } },
  spawning: true,
  clear() {
    for (const m of list.slice()) removeMob(m);
    list.length = 0;
    if (scene) { for (const a of arrows) scene.remove(a.mesh); for (const p of puffs) scene.remove(p.mesh); }
    arrows.length = 0;
    puffs.length = 0;
    villages.clear();
    villagerSaves.clear();
    if (BF.builder) BF.builder.reset();
    if (BF.villageLife) BF.villageLife.reset();
    if (BF.jobs) BF.jobs.reset();
  },
};
})();
