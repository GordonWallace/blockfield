// Mob drawing (spec r15-11): the render layer for the mobs of js/mobs.js. Since r15-37 it draws from the client's mirror, not the
// simulation: every mob in view is an entity of kind "mob" in BF.client.world.entities (js/protocol.js), with the hot fields x, y, z,
// yaw, headYaw, headPitch, walkPhase, walkAmt, age, deathT, fuse, swingT and the cold ones saying how it looks:
//   type, look (model variant), golem, scale / headScale (size), hw / h (half width, height), partVis (parts shown or hidden: a text of
//   name + 1/0), tint ("red": hurt or dying), held (item id of a villager's tool), onFire, sleeping and bedF (its bed's facing),
//   crackStage (iron golem), badgeLevel (villager level), aiming (a skeleton's bow), riding / rider (protocol numbers), dead.
// Once per drawn frame render() builds, updates and removes a Three.js model for each mob from those fields: it owns the models and
// their geometry, the animation (head look, limb swing, creeper swell and fuse flash, sleeping pose, eyelids, death roll), the light
// colour, level badges, golem cracks, held tools and fire. A mob too far away to draw (past the meshed terrain) gets no model until it
// comes near; one gone from the list loses its model on the next frame. The simulation never touches a scene object, so it can run
// where there is no screen (a worker or a server, specs r15-38 / r15-40).
// Drawn state: between the last two ticks of the fixed tick (r15-10), lerp(m.prev, m, k) of the position, yaw, head and walk angles and
// age, where m.prev is the tick before and k = BF.client.world.k(m, BF.warp.alpha) (1 when it stood still in the latest tick, or at
// fast-forward when several ticks went by). A sleeping mob, a ridden one and one that moved more than 4 blocks in a tick (a teleport) are
// drawn where they are; a rider is placed by its boat or horse every tick.
// API: BF.mobView = { init(scene), render(dt), viewOf(entity | protocol number | sim mob (tests)) -> {root, model, meshes, ...} | undefined,
//   drawPos(entity, out), rayBoxOf(o, entity, mn, mx), typeParts(type, variant), buildGeometry(boxes, seed), box(min, max, paint), PX, count() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const PX = 1 / 16;
const rnd = (a, b) => a + Math.random() * (b - a);   // visual (fire)
function hash(a, b, c, d) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const VILLAGER_OUTFITS = BF.mobs.outfits;   // profession -> outfit (js/mobs.js: the professions are simulation data)

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

// ---------- iron golem cracks ----------
// Damage shows as cracks in the golem's iron at 3 stages (below 75%, 50% and 25% health, like vanilla). Each box face gets
// its own deterministic crack network; every crack pixel stores the stage it appears at, so each stage only adds cracks.
const CRACK_DARK = 0x3b3632, CRACK_EDGE = 0x8f877e;
const crackMasks = new Map();
function crackMask(bi, f, W, H) {
  const key = bi + f + W + "x" + H;
  let mask = crackMasks.get(key);
  if (mask) return mask;
  mask = new Float32Array(W * H).fill(Infinity);
  let seed = (bi * 7919 + f.length * 104729 + f.charCodeAt(0) * 31 + W * 977 + H * 13) >>> 0;
  const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const mark = (x, y, st) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const k = y * W + x;
    if (st < mask[k]) mask[k] = st;
    return true;
  };
  const walk = (x, y, ang, len, stage, depth) => {
    for (let i = 0; i < len; i++) {
      ang += (r() - 0.5) * 0.9;
      x += Math.cos(ang); y += Math.sin(ang);
      if (!mark(Math.round(x), Math.round(y), stage + (i / len) * 1.6)) return;
      if (depth < 2 && r() < 0.12) walk(x, y, ang + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.8), (len - i) * 0.6, stage + (i / len) * 1.6, depth + 1);
    }
  };
  const n = Math.max(1, Math.round(W * H / 45));
  for (let k = 0; k < n; k++) {
    const stage = 1 + (k % 3) * 0.75;
    const x = r() * (W - 1), y = r() * (H - 1);
    mark(Math.round(x), Math.round(y), stage);
    const len = 3 + r() * Math.max(3, Math.sqrt(W * H) * 0.8), a = r() * Math.PI * 2;
    walk(x, y, a, len, stage, 0); walk(x, y, a + Math.PI + (r() - 0.5), len * 0.7, stage, 0);
  }
  crackMasks.set(key, mask);
  return mask;
}
// Wraps a painter so pixels cracked at `level` (0-3) are drawn dark, with a lighter chipped rim beside them.
function cracked(paint, bi, level) {
  if (!level) return paint;
  return (f, u, v, W, H) => {
    const mask = crackMask(bi, f, W, H);
    if (mask[v * W + u] <= level) return CRACK_DARK;
    if (u + 1 < W && mask[v * W + u + 1] <= level - 0.5 && hash(u, v, bi, 77) < 0.5) return CRACK_EDGE;
    return typeof paint === "function" ? paint(f, u, v, W, H) : paint;
  };
}

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
  sheep(variant) {
    const wool = 0xe9e9e6, skin = 0xd6c1a4, shorn = variant === "shorn", pink = 0xdcb8a4;
    const leg = (f, u, v) => (!shorn && v >= 7 ? wool : skin);
    const head = (f, u, v) => {
      if (f === "front") { if (!shorn && v >= 5) return wool; if (v === 3 && (u === 1 || u === 4)) return 0x1d1a16; return skin; }
      if (!shorn && (f === "top" || f === "back")) return wool;
      if (f === "bottom") return skin;
      return !shorn && v >= 3 ? wool : skin;
    };
    // shorn: a smaller, pinker body (the wool shell is gone)
    const body = shorn
      ? box([-4.5, 12, -7], [4.5, 20, 7], (f, u, v) => (hash(u, v, 5, 7) < 0.25 ? 0xd2a692 : pink))
      : box([-6, 11, -8], [6, 21, 8], (f, u, v) => (hash(u, v, 2, 7) < 0.2 ? 0xd4d4d0 : wool));
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [body] },
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
        if (H.lamp) headBoxes.push(box([-1.2, 10, 4.5], [1.2, 12, 5.6], 0x2a2a2e), box([-0.8, 10.4, 5.6], [0.8, 11.6, 5.8], 0xfff2a8));   // miner's lamp
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
        ...(O.pickaxe ? [box([2.2, -7, 5.6], [3.4, 3, 6.8], 0x5a3f26), box([-1.8, 3, 5.6], [7.4, 4.4, 6.8], (f, u, v) => (v === 0 ? 0x707078 : 0xb0b0b8))] : []),
        ...(O.hammer ? [box([2.2, -7, 5.6], [3.4, 2.5, 6.8], 0x7a5530), box([1.0, 2.5, 5.0], [4.6, 5.5, 7.4], (f, u, v) => (v === 0 ? 0x5a5a62 : 0x8e8e98))] : []),
      ] },
      { name: "legL", pivot: [-2, 12, 0], swing: 1, boxes: [box([-2, -12, -2], [2, 0, 2], (f, u, v) => (v < 1 ? 0x3a2a1c : trimC))] },
      { name: "legR", pivot: [2, 12, 0], swing: -1, boxes: [box([-2, -12, -2], [2, 0, 2], (f, u, v) => (v < 1 ? 0x3a2a1c : trimC))] },
    ];
    return parts;
  },
  iron_golem(crack) {
    const lvl = +crack || 0;
    let bi = 0;
    const cbox = (min, max, paint) => box(min, max, cracked(paint, bi++, lvl));
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
        cbox([-9, 21, -5.5], [9, 33, 5.5], metal),
        cbox([-4.5, 16, -3], [4.5, 21, 3], metal),
      ] },
      { name: "head", pivot: [0, 31, 1], head: true, boxes: [
        cbox([-4, 0, -3], [4, 10, 5], head),
        cbox([-1, 1, 5], [1, 5, 7], ironD),
      ] },
      { name: "armL", pivot: [-11, 31, 0], golemArm: -1, boxes: [cbox([-2, -30, -3], [2, 2, 3], (f, u, v) => (v < 6 ? ironD : metal(f, u, v)))] },
      { name: "armR", pivot: [11, 31, 0], golemArm: 1, boxes: [cbox([-2, -30, -3], [2, 2, 3], (f, u, v) => (v < 6 ? ironD : metal(f, u, v)))] },
      { name: "legL", pivot: [-4, 16, 0], swing: 1, boxes: [cbox([-3, -16, -2.5], [3, 0, 2.5], metal)] },
      { name: "legR", pivot: [4, 16, 0], swing: -1, boxes: [cbox([-3, -16, -2.5], [3, 0, 2.5], metal)] },
    ];
  },
  // Horse (js/horses.js): variant "<coat>/<marking>", 7 vanilla coats x 5 markings. The saddle part is always there and shown only on a saddled horse.
  horse(variant) {
    const [coatName, mark] = String(variant || "brown/none").split("/");
    const COATS = { white: 0xe6e1d6, creamy: 0xc8a06a, chestnut: 0xa25e2c, brown: 0x6e4628, black: 0x2a2420, gray: 0x7e7873, dark_brown: 0x40291a };
    const coat = COATS[coatName] != null ? COATS[coatName] : COATS.brown;
    const dk = new THREE.Color(coat).multiplyScalar(0.55).getHex(), mane = coatName === "white" || coatName === "creamy" ? 0x8a7a64 : 0x1e1814;
    const WHITE = 0xf2efe8, BLACK = 0x221c18;
    const spot = (u, v, s, k) => hash(u >> 1, v >> 1, s, 41) < k;
    const fur = s => (f, u, v) => {
      if (mark === "white_field" && spot(u, v, s, 0.45)) return WHITE;
      if (mark === "white_dots" && spot(u * 3, v * 3, s, 0.12)) return WHITE;
      if (mark === "black_dots" && spot(u * 3, v * 3, s, 0.14)) return BLACK;
      return hash(u, v, s, 3) < 0.12 ? dk : coat;
    };
    const legPaint = (f, u, v) => (v === 0 ? 0x2e2620 : mark === "white" && v <= 4 ? WHITE : fur(9)(f, u, v));
    const headPaint = (f, u, v, W, H) => {
      if (f === "front") return v >= 1 && v <= 2 && (u === 1 || u === W - 2) ? 0x1a1410 : mark === "white" && u >= 2 && u <= W - 3 ? WHITE : coat;   // nostrils, blaze
      if ((f === "left" || f === "right") && v === H - 2 && u === 3) return 0x111111;   // eyes
      if (mark === "white" && f === "top" && u >= 2 && u <= 3) return WHITE;
      return fur(5)(f, u, v);
    };
    const leather = 0x6b3e1e, iron = 0xa8a8b0;
    return [
      { name: "body", pivot: [0, 0, 0], boxes: [box([-5, 11, -10], [5, 21, 11], fur(1))] },
      { name: "head", pivot: [0, 19, 10], head: true, boxes: [
        box([-2.5, -1, -2], [2.5, 10, 4], fur(4)),                 // neck, rising from the chest
        box([-1, 2, -3], [1, 12, -2], mane),                        // mane down the back of the neck
        box([-3, 7, 1], [3, 12, 8], fur(6)),                        // head
        box([-2, 7, 8], [2, 11, 13], headPaint),                    // muzzle
        box([-2.5, 12, 1.5], [-1, 14, 3], coat), box([1, 12, 1.5], [2.5, 14, 3], coat),   // ears
      ] },
      { name: "tail", pivot: [0, 20, -10], boxes: [box([-1.5, -12, -3], [1.5, 1, 0], mane)] },
      { name: "saddle", pivot: [0, 0, 0], boxes: [
        box([-5.5, 20.5, -4], [5.5, 22, 5], leather), box([-2, 22, 3], [2, 23.5, 5], leather),
        box([-5.8, 13, 0], [-5.3, 20.5, 1], 0x3a2414), box([5.3, 13, 0], [5.8, 20.5, 1], 0x3a2414),
        box([-6.2, 12, -0.5], [-5.2, 13, 1.5], iron), box([5.2, 12, -0.5], [6.2, 13, 1.5], iron),
      ] },
      ...quadLegs(3, 8, 11, 4, legPaint),
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
// ---------- per-mob models ----------
let scene = null, baseMat = null, fireMat = null, fireGeo = null, badgeGeo = null, lidGeo = null;
const views = new Map();   // protocol number -> its view: {root, model, meshes, mat, look, lids, badge, badgeLv, heldMesh, heldId, fire, seen}
let frameNo = 0;
// the model variant a mob is drawn with: an iron golem's crack stage, else its look
const lookOf = m => (m.golem ? (m.crackStage ? String(m.crackStage) : null) : m.look);
function buildMeshes(v, m) {
  for (const k in v.meshes) v.model.remove(v.meshes[k]);
  v.meshes = {}; v.lids = null; v.heldMesh = null; v.heldId = null;
  v.look = lookOf(m);
  for (const p of typeParts(m.type, v.look)) {
    const mesh = new THREE.Mesh(p.geo, v.mat);
    mesh.position.set(p.pivot[0] * PX, p.pivot[1] * PX, p.pivot[2] * PX);
    mesh.rotation.order = "YXZ";
    mesh.userData.part = p;
    if (p.spiderLeg) { mesh.rotation.z = -0.6 * p.spiderLeg; mesh.rotation.y = p.spread; }
    v.model.add(mesh);
    v.meshes[p.name] = mesh;
  }
}
function createView(m) {
  const root = new THREE.Group(), model = new THREE.Group();
  root.add(model);
  const v = { root, model, meshes: {}, mat: baseMat.clone(), look: undefined, lids: null, badge: null, badgeLv: 0, heldMesh: null, heldId: null, fire: null, seen: 0 };
  buildMeshes(v, m);
  scene.add(root);
  return v;
}
function dropView(v) {
  if (scene) scene.remove(v.root);
  v.mat.dispose();
}

// ---------- drawn state ----------
const D = { x: 0, y: 0, z: 0, yaw: 0, headYaw: 0, headPitch: 0, walkPhase: 0, walkAmt: 0, age: 0 };
let M = null;   // the client's mirror (BF.client.world) this frame
const ent = n => (n != null && M ? M.entities.get(n) : null);
function tickK(m) {
  const a = BF.warp && BF.warp.alpha, p = m.prev;
  if (!p || !M || typeof a !== "number" || a >= 1 || m.sleeping || m.rider != null) return 1;
  const r = ent(m.riding);
  if (r && r.rider != null) return 1;
  const dx = m.x - p.x, dy = m.y - p.y, dz = m.z - p.z;
  return dx * dx + dy * dy + dz * dz > 16 ? 1 : M.k(m, a);
}
const mix = (a, b, k) => (typeof a === "number" ? a + (b - a) * k : b);
function drawState(m, out) {
  const k = tickK(m), p = m.prev, P = m;
  if (k >= 1) {
    out.x = P.x; out.y = P.y; out.z = P.z; out.yaw = m.yaw; out.headYaw = m.headYaw; out.headPitch = m.headPitch;
    out.walkPhase = m.walkPhase; out.walkAmt = m.walkAmt; out.age = m.age;
    return out;
  }
  out.x = mix(p.x, P.x, k); out.y = mix(p.y, P.y, k); out.z = mix(p.z, P.z, k);
  let dy = m.yaw - (typeof p.yaw === "number" ? p.yaw : m.yaw);
  while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
  out.yaw = m.yaw - dy * (1 - k);
  out.headYaw = mix(p.headYaw, m.headYaw, k); out.headPitch = mix(p.headPitch, m.headPitch, k);
  out.walkPhase = mix(p.walkPhase, m.walkPhase, k); out.walkAmt = mix(p.walkAmt, m.walkAmt, k); out.age = mix(p.age, m.age, k);
  return out;
}
const _ds = Object.assign({}, D);
// Where a mob is drawn this frame (labels over villagers, js/villagepanel.js; leads, js/entityview.js). m: its entity in the mirror.
function drawPos(m, out) {
  if (!M) M = BF.client && BF.client.world;
  if (m && m.position && !m.kind) m = ent(BF.proto.numberOf(m)) || { x: m.position.x, y: m.position.y, z: m.position.z };   // a sim mob (tests)
  drawState(m, _ds);
  return (out || new THREE.Vector3()).set(_ds.x, _ds.y, _ds.z);
}

// ---------- light ----------
function skyLight() { return BF.sky && typeof BF.sky.light === "number" ? BF.sky.light : 1; }
function lightAt(x, y, z) {
  let f = 1;
  if (BF.skyLight) { const l = BF.skyLight.get(x, y, z); if (l !== 15) f = BF.skyLight.bright(l); }   // (the sky light js/mobs.js burns the undead by)
  return Math.max(0.12, skyLight() * f, Math.pow(BF.world.getBlockLight(x, y, z) / 15, 1.5));
}

// ---------- eyelids (asleep) ----------
function eyelids(v, on) {
  const head = v.meshes.head;
  if (!head) return;
  if (!v.lids && on) {
    if (!lidGeo) lidGeo = buildGeometry([box([-3, 4, 4], [-1, 5, 4.25], 0x9c7457), box([1, 4, 4], [3, 5, 4.25], 0x9c7457)], 5);
    v.lids = new THREE.Mesh(lidGeo, v.mat);
    head.add(v.lids);
  }
  if (v.lids) v.lids.visible = on;
}

// ---------- level badge on the belt (level >= 2): iron, gold, emerald, diamond ----------
const BADGE_COLORS = [null, null, 0xd8d8d8, 0xf2d64b, 0x2fd06a, 0x5ddfe0];
const badgeMats = [];
function updateBadge(v, m) {
  const lv = m.badgeLevel | 0;
  if (lv === v.badgeLv) return;
  v.badgeLv = lv;
  if (lv < 2) { if (v.badge) v.badge.visible = false; return; }
  if (!badgeGeo) badgeGeo = new THREE.BoxGeometry(3 * PX, 3 * PX, 0.6 * PX);
  if (!badgeMats[lv]) badgeMats[lv] = new THREE.MeshBasicMaterial({ color: BADGE_COLORS[lv] });
  if (!v.badge) {
    v.badge = new THREE.Mesh(badgeGeo, badgeMats[lv]);
    v.badge.position.set(0, 14 * PX, 3.4 * PX);
    v.model.add(v.badge);
  }
  v.badge.material = badgeMats[lv];
  v.badge.visible = true;
}

// ---------- held tools ----------
// The tool a villager holds (m.held, from js/mobs.js toolHolders) is drawn in its folded hands (a child of the arms, so it swings with
// them). Shapes by tool type, head coloured from the item's colour. js/forester.js uses it for axes.
const heldGeos = new Map();
function heldGeo(id) {
  if (heldGeos.has(id)) return heldGeos.get(id);
  const it = BF.items[id], type = it && it.tool ? it.tool.type : "", wood = 0x5a3f26;
  const c = new THREE.Color(it && it.color ? it.color : "#b0b0b8").getHex(), dark = new THREE.Color(c).multiplyScalar(0.7).getHex();
  const head = (f, u, v) => (v === 0 ? dark : c);
  let boxes;
  if (type === "shears") boxes = [box([1.6, -1.5, 5.6], [2.8, 3, 6.6], c), box([3.0, -1.5, 5.6], [4.2, 3, 6.6], c), box([1.4, -3.5, 5.4], [4.4, -1.5, 6.8], 0x8a2a24)];
  else {
    boxes = [box([2.2, -3, 5.6], [3.4, 8, 6.8], wood)];   // held upright in front of the chest; a swing tips it back over the shoulder and down again
    if (type === "axe") boxes.push(box([1.9, 4.6, 6.8], [3.7, 8.2, 9.8], head), box([1.9, 5.8, 4.9], [3.7, 7.2, 5.6], dark));   // blade facing forward
    else if (type === "hoe") boxes.push(box([2.0, 6.8, 6.8], [3.6, 8.2, 9.8], head));
    else boxes.push(box([-1.8, 8, 5.6], [7.4, 9.4, 6.8], head));   // pickaxe and anything else
  }
  const g = buildGeometry(boxes, 77);
  heldGeos.set(id, g);
  return g;
}
function syncHeld(v, m) {
  const arms = v.meshes.arms, id = m.dead ? null : m.held;
  if (id == null || !arms || !BF.items[id]) { if (v.heldMesh) v.heldMesh.visible = false; return; }
  if (!v.heldMesh || v.heldMesh.parent !== arms) {   // first tool, or the outfit was rebuilt (a profession change)
    if (v.heldMesh && v.heldMesh.parent) v.heldMesh.parent.remove(v.heldMesh);
    v.heldMesh = new THREE.Mesh(heldGeo(id), v.mat); v.heldId = id;
    arms.add(v.heldMesh);
  }
  if (v.heldId !== id) { v.heldMesh.geometry = heldGeo(id); v.heldId = id; }
  v.heldMesh.visible = true;
}

// ---------- limbs ----------
function animate(v, m, S) {
  const amp = S.walkAmt, ph = S.walkPhase, swingT = m.swingT || 0, meshes = v.meshes;
  syncHeld(v, m);
  const sw = Math.sin(ph);
  for (const name in meshes) {
    const mesh = meshes[name], p = mesh.userData.part;
    if (p.head) { mesh.rotation.y = S.headYaw; mesh.rotation.x = -S.headPitch; }
    else if (p.swing) mesh.rotation.x = m.riding != null && meshes.legL && !meshes.legFL ? -Math.PI / 2 : sw * 0.75 * amp * p.swing;   // sitting in a boat: two-legged mobs put their legs forward
    else if (p.folded) mesh.rotation.x = swingT > 0 ? -Math.sin(swingT / 0.35 * Math.PI) * 0.85 : 0;   // builders swing the folded arms as they place a block
    else if (p.arm) {
      if (m.type === "zombie") {
        mesh.rotation.x = -Math.PI / 2 + Math.sin(S.age * 2 + p.arm) * 0.06 + (swingT > 0 ? Math.sin(swingT / 0.35 * Math.PI) * 0.7 : 0);
        mesh.rotation.z = Math.sin(S.age * 1.3 + p.arm) * 0.04;
      } else if (m.aiming) { // skeleton drawing the bow
        mesh.rotation.x = -Math.PI / 2 - S.headPitch;
        mesh.rotation.y = p.arm > 0 ? 0.15 : 0.6;
      } else {
        mesh.rotation.x = -sw * 0.6 * amp * p.arm;
        mesh.rotation.y = 0;
      }
    } else if (p.golemArm) {
      const lift = swingT > 0 ? Math.sin(swingT / 0.35 * Math.PI) * 1.6 : 0;
      mesh.rotation.x = -sw * 0.5 * amp * p.golemArm - lift;
      mesh.rotation.z = 0.06 * p.golemArm;
    } else if (p.wing) {
      mesh.rotation.z = (m.onGround ? 0 : Math.abs(Math.sin(S.age * 20)) * 1.1) * p.wing;
    } else if (p.spiderLeg) {
      const side = p.spiderLeg, alt = (p.idx % 2 === 0 ? 1 : -1) * side;
      mesh.rotation.y = p.spread + Math.sin(ph * 1.6) * 0.35 * amp * alt;
      mesh.rotation.z = -0.6 * side + Math.max(0, Math.cos(ph * 1.6) * alt) * 0.25 * amp * side;
    }
  }
  // chickens bob their head while walking
  if (m.type === "chicken" && meshes.head) meshes.head.position.z = (3 + Math.sin(ph * 2) * 0.6 * amp) * PX;
}

// ---------- fire (undead in the sun) ----------
function updateFire(v, m, on, dt) {
  if (!on) { if (v.fire) v.fire.visible = false; return; }
  if (!v.fire) {
    v.fire = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const f = new THREE.Mesh(fireGeo, fireMat);
      f.position.set(rnd(-m.hw, m.hw), rnd(0, m.h), rnd(-m.hw, m.hw));
      v.fire.add(f);
    }
    v.root.add(v.fire);
  }
  v.fire.visible = true;
  for (const f of v.fire.children) {
    f.position.y += dt * 1.5;
    if (f.position.y > m.h + 0.15 || Math.random() < dt * 4) {   // visual
      f.position.set(rnd(-m.hw - 0.05, m.hw + 0.05), rnd(0, m.h * 0.6), rnd(-m.hw - 0.05, m.hw + 0.05));
      f.scale.setScalar(rnd(0.6, 1.4));
    }
  }
}

// ---------- one mob, one frame ----------
const S = Object.assign({}, D);
function draw(v, m, dt) {
  if (v.look !== lookOf(m)) buildMeshes(v, m);   // a new variant: horse coat, shorn sheep, profession outfit, golem cracks
  const pos = drawState(m, S);
  v.root.position.set(pos.x, pos.y, pos.z);
  const r = v.model.rotation;
  if (m.sleeping && m.bedF != null && !m.dead) {   // lying flat on the bed, head on the pillow
    const [fx, fz] = BF.DIRS[m.bedF];
    r.order = "YXZ";
    r.set(-Math.PI / 2, Math.atan2(-fx, -fz), 0);
  } else {
    r.order = "XYZ";
    r.set(0, S.yaw, m.dead ? Math.min(1, m.deathT / 0.45) * Math.PI / 2 : 0);   // dying: it tips over
  }
  const fuse = m.type === "creeper" && !m.dead ? m.fuse : 0;
  if (m.type === "creeper") {   // swelling before it blows
    const f = Math.min(1, fuse / 1.5), s = 1 + f * 0.22 + (f > 0 ? Math.sin(fuse * 40) * 0.02 : 0);
    v.model.scale.set(s, 1 + f * 0.12, s);
  } else v.model.scale.setScalar(m.scale || 1);
  if (v.meshes.head) v.meshes.head.scale.setScalar(m.headScale || 1);
  if (m.partVis) { const pv = partsOf(m.partVis); for (const k in pv) if (v.meshes[k]) v.meshes[k].visible = pv[k]; }
  if (m.type === "villager") eyelids(v, !!m.sleeping && !m.dead);
  if (!m.dead) animate(v, m, S);   // (a dying mob keeps the pose it died in)
  // colour: light, hurt and death flash, creeper fuse
  const light = lightAt(pos.x, pos.y + 0.5, pos.z), col = v.mat.color;
  if (m.tint === "red") col.setRGB(light * 1.5, light * 0.35, light * 0.35);
  else if (fuse > 0 && !m.sleeping) {
    const f = fuse / 1.5;
    col.setScalar(Math.sin(fuse * (8 + f * 24)) > 0.2 ? Math.max(2.5, light * 3) : light);
  } else col.setScalar(light);
  if (m.type === "villager") updateBadge(v, m);
  updateFire(v, m, !!m.onFire && !m.dead, dt);
}

// partVis as the protocol sends it ("saddle1chest0": a part's name, then 1 shown or 0 hidden) -> {saddle: true, chest: false}
const pvCache = new Map();
function partsOf(t) {
  let o = pvCache.get(t);
  if (!o) {
    o = {};
    for (const [, k, on] of t.matchAll(/([^01]+)([01])/g)) o[k] = on === "1";
    if (pvCache.size > 200) pvCache.clear();
    pvCache.set(t, o);
  }
  return o;
}

// Mob positions are kept in frames on the planet (js/mobs.js keepFrame): the player's position seen from the mob's frame.
const LQ = {}, _q = new THREE.Vector3(), _mp = new THREE.Vector3();
function playerDist(m, pp) {
  BF.planet.local(_mp.set(m.x, m.y, m.z), pp, LQ);
  return _q.set(LQ.x, pp.y, LQ.z).distanceTo(_mp);
}

// A model that could not be drawn: logged once per mob type (the game log, js/gamelog.js); the mob itself plays on.
const failed = new Set();
function drawFailed(m, e) {
  console.error(e);
  if (failed.has(m.type)) return;
  failed.add(m.type);
  if (BF.glog) BF.glog.log("ERROR", "mobs", "Could not draw a " + String(m.type).replace(/_/g, " ") + " (" + (e && e.message ? e.message : e) + "); it may look wrong until the game is reloaded", { at: [Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)] });
}

// The ray box of a mob of the mirror, seen from point o's frame (planet), in mn / mx: standing, its upright hw x h box; asleep on a bed, the
// flat box draw() lays it in (feet at its position, head h along the bed's facing bedF), so the crosshair finds it where it is drawn
// (js/villagerhover.js, js/player.js mirrorHit; js/mobs.js raycast keeps the same box for the simulation's mobs).
const _bA = {}, _bB = {}, _bH = { x: 0, y: 0, z: 0 };
function rayBoxOf(o, e, mn, mx) {
  const hw = e.hw, p = BF.planet.local(o, e, _bA);
  if (e.sleeping && e.bedF != null && !e.dead) {
    const [fx, fz] = BF.DIRS[e.bedF];
    _bH.x = e.x + fx * e.h; _bH.y = e.y; _bH.z = e.z + fz * e.h;
    const h = BF.planet.local(o, _bH, _bB), alongX = Math.abs(h.x - p.x) > Math.abs(h.z - p.z);   // a bed over a face edge turns
    mn[0] = Math.min(p.x, h.x) - (alongX ? 0 : hw); mn[1] = e.y - hw; mn[2] = Math.min(p.z, h.z) - (alongX ? hw : 0);
    mx[0] = Math.max(p.x, h.x) + (alongX ? 0 : hw); mx[1] = e.y + hw; mx[2] = Math.max(p.z, h.z) + (alongX ? hw : 0);
  } else {
    mn[0] = p.x - hw; mn[1] = e.y; mn[2] = p.z - hw;
    mx[0] = p.x + hw; mx[1] = e.y + e.h; mx[2] = p.z + hw;
  }
  return p;
}

BF.mobView = {
  PX, box, buildGeometry, typeParts, drawPos, rayBoxOf,
  init(sceneRef) {
    scene = sceneRef;
    if (!baseMat) {
      baseMat = new THREE.MeshBasicMaterial({ vertexColors: true });
      fireMat = new THREE.MeshBasicMaterial({ color: 0xffa020, transparent: true, opacity: 0.9, depthWrite: false });
      fireGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    }
  },
  // Once per drawn frame (js/main.js), after the simulation steps; dt = game seconds the frame covered (0 when paused or frozen), for the fire.
  render(dt) {
    M = BF.client && BF.client.world;
    if (!scene || !M) return;
    frameNo++;
    const pp = BF.player && BF.player.position, far = (BF.world.viewDist + 1) * BF.CS;   // nothing to draw beyond the meshed terrain
    for (const m of M.entities.values()) {
      if (m.kind !== "mob") continue;
      let v = views.get(m.n);
      if (pp && playerDist(m, pp) > far) { if (v) { v.root.visible = false; v.seen = frameNo; } continue; }
      if (!v) { v = createView(m); views.set(m.n, v); }
      v.seen = frameNo;
      v.root.visible = true;
      try { draw(v, m, dt || 0); } catch (e) { drawFailed(m, e); }
    }
    for (const [n, v] of views) if (v.seen !== frameNo) { dropView(v); views.delete(n); }   // removed, or gone from the mirror
    const sl = Math.max(0.15, skyLight());
    for (let i = 2; i < badgeMats.length; i++) if (badgeMats[i]) badgeMats[i].color.setHex(BADGE_COLORS[i]).multiplyScalar(sl);
  },
  viewOf: m => views.get(typeof m === "number" ? m : m && m.kind ? m.n : m && BF.proto ? BF.proto.numberOf(m) : null),
  count: () => views.size,
};
})();
