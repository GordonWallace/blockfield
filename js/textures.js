// Procedural texture atlas + inventory icons.
// 32x32 tiles painted from seeded value noise (stable every run), each in a 64x64 atlas cell with
// 16px of wrapped/extruded padding. Mip levels are built by hand per cell (no bleeding between tiles,
// alpha coverage preserved for cutout tiles) and uploaded as ImageData so colours under alpha survive.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const TS = 32, CELL = 64, OFF = 16, ATLAS_W = 1024, PER_ROW = ATLAS_W / CELL;
const MIP_CELL_LEVELS = 7; // levels 0..6 are built per cell (cell 64 -> 1px)
const index = new Map();      // tile name -> cell index
const tileData = new Map();   // tile name -> ImageData (32x32, for icons)
const iconCache = new Map();
let built = null, atlasW = ATLAS_W, atlasH = 0, canvas = null;

// ---------- small helpers ----------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ihash(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 362437)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function hex(c) {
  c = c.replace("#", "");
  if (c.length === 3) c = c.split("").map(x => x + x).join("");
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const WHITE = [255, 255, 255];
const pal = arr => arr.map(hex);
function ramp(stops, t) {
  t = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  return mix(stops[i], stops[i + 1], t - i);
}

// Biome tint defaults (used for pre-coloured variants and icons; the mesher applies real biome tints).
const DEFAULT_TINT = { grass: [0.74, 0.98, 0.5], foliage: [0.64, 0.94, 0.42], water: [0.55, 0.8, 1.2] };
const TINTED = {
  grass: ["grass_top", "grass_side_overlay", "short_grass", "fern"],
  foliage: ["oak_leaves", "jungle_leaves", "acacia_leaves", "dark_oak_leaves", "mangrove_leaves"],
  water: ["water"],
};
const tintOf = name => (TINTED.grass.includes(name) ? DEFAULT_TINT.grass : TINTED.foliage.includes(name) ? DEFAULT_TINT.foliage : TINTED.water.includes(name) ? DEFAULT_TINT.water : null);
const tintC = (c, t) => [c[0] * t[0], c[1] * t[1], c[2] * t[2]];

// ---------- pixel buffer ----------
// 32x32 float RGBA + height map. Coordinates wrap, so painters are tileable by construction.
class Px {
  constructor(name) {
    this.n = TS;
    this.c = new Float32Array(TS * TS * 4);
    this.h = new Float32Array(TS * TS);
    this.seed = hashStr(name);
    this.r = rng(this.seed);
  }
  i(x, y) { x = Math.floor(x); y = Math.floor(y); return (((y % TS) + TS) % TS) * TS + (((x % TS) + TS) % TS); }
  set(x, y, c, a = 255) { const i = this.i(x, y) * 4; this.c[i] = c[0]; this.c[i + 1] = c[1]; this.c[i + 2] = c[2]; this.c[i + 3] = a; }
  get(x, y) { const i = this.i(x, y) * 4; return [this.c[i], this.c[i + 1], this.c[i + 2]]; }
  a(x, y) { return this.c[this.i(x, y) * 4 + 3]; }
  blend(x, y, c, t) { this.set(x, y, mix(this.get(x, y), c, t), this.a(x, y)); }
  scale(x, y, f) { this.set(x, y, mul(this.get(x, y), f), this.a(x, y)); }
  H(x, y) { return this.h[this.i(x, y)]; }
  setH(x, y, v) { this.h[this.i(x, y)] = v; }
  fill(fn) { for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) fn(x, y); }
  clear() { this.c.fill(0); }
  rand() { return this.r(); }
  ri(n) { return Math.floor(this.r() * n); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; }
  // periodic value noise: px cells across the tile in x, py in y (integers) -> [0,1]
  noise(x, y, px, py = px, salt = 0) {
    const u = (x + 0.5) / TS * px, v = (y + 0.5) / TS * py;
    const xi = Math.floor(u), yi = Math.floor(v), fx = u - xi, fy = v - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const s = (this.seed + salt * 7919) | 0;
    const g = (i, j) => ihash(((i % px) + px) % px, ((j % py) + py) % py, s);
    const a = g(xi, yi) + (g(xi + 1, yi) - g(xi, yi)) * sx;
    const b = g(xi, yi + 1) + (g(xi + 1, yi + 1) - g(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
  }
  fbm(x, y, p, oct = 4, salt = 0) {
    let s = 0, amp = 1, tot = 0;
    for (let k = 0; k < oct; k++) { s += this.noise(x, y, p << k, p << k, salt + k * 13) * amp; tot += amp; amp *= 0.5; }
    return s / tot;
  }
  // light from the top-left using the height map; ao darkens low areas
  relief(k, ao = 0) {
    const out = new Float32Array(TS * TS);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const d = this.H(x - 1, y - 1) - this.H(x + 1, y + 1);
      let f = 1 + k * d * 0.5;
      if (ao) f *= 1 - ao * (1 - clamp01(this.H(x, y)));
      out[y * TS + x] = Math.max(0.4, Math.min(1.55, f));
    }
    for (let i = 0; i < TS * TS; i++) {
      if (!this.c[i * 4 + 3]) continue;
      this.c[i * 4] *= out[i]; this.c[i * 4 + 1] *= out[i]; this.c[i * 4 + 2] *= out[i];
    }
  }
}
// per-pixel jitter: brightness plus a little hue/saturation drift
function jit(p, c, amt = 0.06, hue = 0.35) {
  const f = 1 + (p.rand() - 0.5) * amt;
  return [c[0] * f * (1 + (p.rand() - 0.5) * amt * hue), c[1] * f * (1 + (p.rand() - 0.5) * amt * hue), c[2] * f * (1 + (p.rand() - 0.5) * amt * hue)];
}
// raised oval (pebble / crystal / spot) painted into colour + height
function dome(p, cx, cy, rx, ry, col, hBase = 0.55, hAmp = 0.5, amt = 0.08) {
  const R = Math.ceil(Math.max(rx, ry));
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    if (d > 1) continue;
    p.set(cx + dx, cy + dy, jit(p, mul(col, 0.92 + 0.16 * (1 - d)), amt));
    p.setH(cx + dx, cy + dy, hBase + hAmp * Math.sqrt(1 - d));
  }
}
// wrapped voronoi helper -> (x,y) => [cellIndex, d1, d2]
function voronoi(p, count) {
  const pts = [];
  for (let i = 0; i < count; i++) pts.push([p.rand() * TS, p.rand() * TS]);
  return (x, y) => {
    let d1 = 1e9, d2 = 1e9, k = 0;
    const px = ((x % TS) + TS) % TS + 0.5, py = ((y % TS) + TS) % TS + 0.5;
    for (let i = 0; i < count; i++) {
      let dx = Math.abs(px - pts[i][0]), dy = Math.abs(py - pts[i][1]);
      dx = Math.min(dx, TS - dx); dy = Math.min(dy, TS - dy);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < d1) { d2 = d1; d1 = d; k = i; } else if (d < d2) d2 = d;
    }
    return [k, d1, d2];
  };
}

// ---------- palettes (slightly desaturated, natural) ----------
const DIRT = pal(["#3d2b1d", "#523a27", "#654830", "#77573b", "#876646"]);
const GRASS_N = pal(["#6a7064", "#80877a", "#959b8c", "#a8ad9d", "#babfad"]); // neutral, for tinting
const STONE = pal(["#5a5a5b", "#6a6a6a", "#787877", "#858584", "#939391"]);
const SAND = pal(["#bfb187", "#cbbf95", "#d6cba2", "#dfd5ae", "#e8e0bc"]);
const RED_SAND = pal(["#94502a", "#a25a2f", "#ae6436", "#b96f3f", "#c37c4b"]);
const SANDSTONE = pal(["#bba977", "#c8b784", "#d2c290", "#dbcc9c", "#e3d6a9"]);
const SNOW = pal(["#c9d3de", "#d9e1ea", "#e6ecf2", "#f0f3f7", "#f9fbfd"]);
const MOSS = pal(["#3b5320", "#466226", "#52702c", "#5e7d33", "#6a893b"]);
const WOOD_OAK = pal(["#77593a", "#866642", "#94734a", "#a08053", "#ab8b5d"]);
const WOOD_SPRUCE = pal(["#4a3622", "#563f28", "#62482e", "#6d5135", "#775a3c"]);
const WOOD_ACACIA = pal(["#87472a", "#96502e", "#a25a34", "#ac653b", "#b57044"]);
const WOOD_CHEST = pal(["#80531f", "#8f5f26", "#9c6b2e", "#a77736", "#b0823f"]);

// ---------- base painters (colour + height, no lighting) ----------
function dirtBase(p, opts = {}) {
  const cols = opts.cols || DIRT;
  p.fill((x, y) => {
    const n = p.fbm(x, y, 4, 4, 1), m = p.noise(x, y, 16, 16, 2);
    p.set(x, y, jit(p, ramp(cols, n * 0.7 + m * 0.3 + (p.rand() - 0.5) * 0.2), 0.07));
    p.setH(x, y, n * 0.5 + m * 0.3);
  });
  const peb = opts.pebbles === undefined ? 7 : opts.pebbles;
  const pc = pal(["#6f6156", "#7d6a58", "#5a4a3e", "#8a7a6a", "#66584c"]);
  for (let i = 0; i < peb; i++) dome(p, p.ri(TS), p.ri(TS), 0.9 + p.rand() * 1.3, 0.8 + p.rand() * 1.0, p.pick(pc), 0.5, 0.5);
  const roots = opts.roots === undefined ? 2 : opts.roots;
  for (let r = 0; r < roots; r++) { // thin pale roots
    let x = p.ri(TS), y = p.ri(TS), dir = p.rand() * Math.PI * 2;
    const len = 6 + p.ri(8);
    for (let k = 0; k < len; k++) {
      p.set(x, y, jit(p, hex("#9a8466"), 0.08)); p.setH(x, y, 0.75);
      dir += (p.rand() - 0.5) * 0.9; x += Math.cos(dir); y += Math.sin(dir);
    }
  }
}
function grassBlades(p, cols, count, len = [2, 4]) {
  for (let i = 0; i < count; i++) {
    let x = p.rand() * TS, y = p.rand() * TS;
    const a = p.rand() * Math.PI * 2, L = len[0] + p.ri(len[1] - len[0] + 1), base = p.rand() * 0.5;
    for (let k = 0; k < L; k++) {
      const t = base + (k / L) * 0.5;
      p.set(x, y, jit(p, ramp(cols, t), 0.05)); p.setH(x, y, 0.4 + t * 0.6);
      x += Math.cos(a); y += Math.sin(a);
    }
  }
}
function grassTopN(p) { // neutral (tintable) grass top
  p.fill((x, y) => {
    const n = p.fbm(x, y, 4, 3, 3);
    const t = n * 0.55 + p.rand() * 0.25;
    p.set(x, y, jit(p, ramp(GRASS_N, t), 0.05)); p.setH(x, y, t * 0.6);
  });
  grassBlades(p, GRASS_N, 230);
}
// a fringe hanging over the top of a side tile; cols coloured, depth range, returns per-column depth
function fringe(p, cols, dmin, dmax, opts = {}) {
  const depth = [];
  for (let x = 0; x < TS; x++) {
    let d = dmin + Math.floor(p.noise(x, 0, 8, 1, 31) * (dmax - dmin + 1));
    if (p.rand() < (opts.drip || 0.18)) d += 1 + p.ri(3);
    depth.push(d);
  }
  for (let x = 0; x < TS; x++) {
    const d = depth[x];
    for (let y = 0; y < d; y++) {
      const t = 0.25 + 0.6 * (1 - y / d) * 0.5 + p.noise(x, y, 8, 8, 32) * 0.35 + (p.rand() - 0.5) * 0.2;
      p.set(x, y, jit(p, ramp(cols, t), 0.06), 255); p.setH(x, y, 0.85 - (y / d) * 0.15);
    }
    if (opts.shadow !== false) { p.scale(x, d, 0.62); p.scale(x, d + 1, 0.82); }
    p.setH(x, d, 0.1);
  }
  return depth;
}
function stoneBase(p, cols = STONE, salt = 0) {
  p.fill((x, y) => {
    const n = p.fbm(x, y, 4, 5, 40 + salt), blot = p.noise(x, y, 6, 6, 44 + salt);
    const w = p.noise(x, y, 3, 3, 45 + salt) - 0.5;
    let c = ramp(cols, (n - 0.5) * 1.5 + 0.5 + (blot > 0.68 ? 0.18 : blot < 0.3 ? -0.15 : 0) + (p.rand() - 0.5) * 0.14);
    c = [c[0] + w * 10, c[1] + w * 3, c[2] - w * 8];
    let h = n;
    const crack = Math.abs(p.noise(x, y, 3, 3, 47 + salt) - 0.5);
    if (crack < 0.02) { c = mul(c, 0.68); h -= 0.35; }
    else if (Math.abs(p.noise(x, y, 5, 5, 49 + salt) - 0.5) < 0.012) c = mix(c, hex("#a9a8a3"), 0.45);
    p.set(x, y, jit(p, c, 0.05)); p.setH(x, y, h);
  });
}
// Irregular rounded stones (diameter ~5-12px) in dark mortar, matte dome shading lit from the top-left.
function cobbleBase(p, opts = {}) {
  const cols = opts.cols || STONE, mortar = hex(opts.mortar || "#2f2e2c");
  const stones = [];
  for (let tries = 0; tries < 400 && stones.length < (opts.count || 30); tries++) {
    const r = 2.6 + p.rand() * 3.4, x = p.rand() * TS, y = p.rand() * TS;
    let ok = true;
    for (const s of stones) {
      let dx = Math.abs(x - s.x), dy = Math.abs(y - s.y);
      dx = Math.min(dx, TS - dx); dy = Math.min(dy, TS - dy);
      if (Math.hypot(dx, dy) < (r + s.r) * 0.82) { ok = false; break; }
    }
    if (ok) stones.push({ x, y, r, ax: 0.8 + p.rand() * 0.45, tone: 0.2 + p.rand() * 0.55, warm: (p.rand() - 0.5) * 6 });
  }
  const L = [-0.55, -0.55, 0.63]; // light from the top-left
  p.fill((x, y) => {
    const px = x + 0.5 + (p.noise(x, y, 8, 8, 61) - 0.5) * 1.6, py = y + 0.5 + (p.noise(x, y, 8, 8, 62) - 0.5) * 1.6;
    let b1 = 1e9, b2 = 1e9, k = -1, bdx = 0, bdy = 0;
    for (let i = 0; i < stones.length; i++) {
      const s = stones[i];
      let dx = px - s.x, dy = py - s.y;
      dx -= Math.round(dx / TS) * TS; dy -= Math.round(dy / TS) * TS;
      const d = Math.hypot(dx * s.ax, dy / s.ax) / s.r;
      if (d < b1) { b2 = b1; b1 = d; k = i; bdx = dx * s.ax / s.r; bdy = dy / s.ax / s.r; } else if (d < b2) b2 = d;
    }
    const n = p.fbm(x, y, 4, 3, 60);
    const s = stones[k];
    if (k < 0 || b1 > 1.12 || (b2 - b1) * s.r < 0.9) { // mortar gap
      p.set(x, y, jit(p, mul(mortar, 0.85 + n * 0.3), 0.06)); p.setH(x, y, 0); return;
    }
    const d = Math.min(0.97, b1);
    const nz = Math.sqrt(1 - d * d * 0.85);
    const lam = Math.max(0, (bdx * L[0] + bdy * L[1]) * 0.9 + nz * L[2]) / 0.85;
    const shade = 0.66 + 0.42 * Math.min(1, lam) - smooth(0.8, 1.12, b1) * 0.12;
    let c = ramp(cols, s.tone + (n - 0.5) * 0.3 + (p.rand() - 0.5) * 0.08);
    c = [c[0] + s.warm, c[1], c[2] - s.warm];
    p.set(x, y, jit(p, mul(c, shade), 0.04)); p.setH(x, y, 0.5 + nz * 0.3);
  });
}
function mossOver(p, amount, salt = 70) {
  p.fill((x, y) => {
    const m = p.fbm(x, y, 3, 4, salt) + (0.45 - p.H(x, y)) * 0.25 + (p.rand() - 0.5) * 0.12;
    if (m > 1 - amount) {
      p.set(x, y, jit(p, ramp(MOSS, p.rand() * 0.6 + (m - (1 - amount)) * 2), 0.08));
      p.setH(x, y, p.H(x, y) + 0.2);
    }
  });
}
function sandBase(p, cols, ripples = true) {
  p.fill((x, y) => {
    const n = p.fbm(x, y, 4, 3, 80), g = p.rand();
    const r = ripples ? Math.sin((y + n * 7 + p.noise(x, y, 2, 2, 81) * 4) * Math.PI * 2 / 8) : 0;
    p.set(x, y, jit(p, ramp(cols, 0.3 + n * 0.35 + g * 0.22 + r * 0.06), 0.05));
    p.setH(x, y, r * 0.25 + n * 0.35 + g * 0.12);
  });
  for (let i = 0; i < 14; i++) p.set(p.ri(TS), p.ri(TS), jit(p, mul(ramp(cols, 0.5), p.rand() < 0.5 ? 0.8 : 1.12), 0.05));
}
// bricks/blocks layout with bevelled edges and recessed mortar
function bricks(p, o) {
  const tones = [];
  for (let i = 0; i < 64; i++) tones.push(p.rand());
  p.fill((x, y) => {
    const row = Math.floor(y / o.bh), ly = y % o.bh, off = row % 2 ? o.offset : 0;
    const xx = (x + off) % TS, bx = xx % o.bw, id = Math.floor(xx / o.bw) + row * 5;
    const n = p.fbm(x, y, 4, 3, 90);
    if (ly >= o.bh - o.mortar || bx >= o.bw - o.mortar) {
      p.set(x, y, jit(p, mul(o.mortarCol, 0.9 + n * 0.2), 0.06)); p.setH(x, y, 0.05); return;
    }
    const e = Math.min(ly, o.bh - o.mortar - 1 - ly, bx, o.bw - o.mortar - 1 - bx);
    p.set(x, y, jit(p, ramp(o.cols, tones[id % 64] * (o.vary || 0.5) + n * 0.35 + (p.rand() - 0.5) * 0.12 + (o.bias || 0.1)), 0.06));
    p.setH(x, y, Math.min(1, (e + 1) / (o.bevel || 2)) * 0.75 + n * 0.25);
  });
}
function planksBase(p, cols, gap) {
  const g = hex(gap);
  for (let b = 0; b < 4; b++) {
    const y0 = b * 8, tone = (ihash(b, p.seed, 3) - 0.5) * 0.3, joint = (b * 13 + 5 + p.ri(6)) % TS;
    for (let ly = 0; ly < 8; ly++) for (let x = 0; x < TS; x++) {
      const y = y0 + ly;
      if (ly === 7) { p.set(x, y, jit(p, g, 0.08)); p.setH(x, y, 0); continue; }
      const grain = p.noise(x, y, 2, 16, 100 + b), fine = p.noise(x, y, 4, 32, 110 + b);
      let t = 0.45 + tone + (grain - 0.5) * 0.9 + (fine - 0.5) * 0.45;
      if (Math.abs(fine - 0.5) < 0.03) t -= 0.25; // dark grain line
      let h = 0.7 + grain * 0.12 + (ly === 0 ? 0.12 : 0) - (ly === 6 ? 0.15 : 0);
      if (x === joint) { t -= 0.5; h = 0.1; }
      p.set(x, y, jit(p, ramp(cols, t), 0.04)); p.setH(x, y, h);
    }
  }
}
function barkSide(p, cols, opts = {}) {
  p.fill((x, y) => {
    const g1 = p.noise(x, y, 8, 2, 120), g2 = p.noise(x, y, 16, 4, 121), g3 = p.noise(x, y, 4, 1, 122);
    let h = g1 * 0.5 + g2 * 0.3 + g3 * 0.2;
    let t = smooth(0.3, 0.7, h) * 0.85 + (p.rand() - 0.5) * 0.12 + 0.1;
    if (h < 0.4) { t *= 0.45; h *= 0.6; } // deep groove
    const plate = p.noise(x, y, 4, 16, 123);
    if (plate < 0.12 && h > 0.45) { t -= 0.3; h -= 0.2; } // horizontal breaks between bark plates
    p.set(x, y, jit(p, ramp(cols, t), 0.05)); p.setH(x, y, h);
  });
  if (opts.after) opts.after(p);
}
function logTop(p, bark, ringA, ringB, core) {
  const bk = pal(bark), ra = hex(ringA), rb = hex(ringB), co = hex(core);
  const angles = [p.rand() * 6.28, p.rand() * 6.28];
  p.fill((x, y) => {
    const dx = x - 15.5, dy = y - 15.5, ed = Math.min(x, y, 31 - x, 31 - y);
    if (ed < 2) {
      const h = p.noise(x, y, 8, 8, 130);
      p.set(x, y, jit(p, ramp(bk, h), 0.06)); p.setH(x, y, ed === 0 ? 0.55 : 0.75 + h * 0.2); return;
    }
    const r = Math.max(Math.abs(dx), Math.abs(dy)) * 0.5 + Math.hypot(dx, dy) * 0.5 + (p.noise(x, y, 4, 4, 131) - 0.5) * 2.4;
    const ring = 0.5 + 0.5 * Math.sin(r * Math.PI * 2 / 3.4);
    let c = mix(ra, mul(rb, 0.85), smooth(0.62, 0.95, ring));
    if (r > 12) c = mul(c, 0.9);
    if (r < 1.8) c = co;
    const a = Math.atan2(dy, dx);
    for (const ca of angles) if (Math.abs(Math.atan2(Math.sin(a - ca), Math.cos(a - ca))) < 0.6 / Math.max(r, 1) && r > 2 && r < 11) c = mul(c, 0.65);
    p.set(x, y, jit(p, c, 0.05)); p.setH(x, y, 0.5 + ring * 0.12);
  });
}
// leaves: layered clusters of small oval leaves, dark inner shadow, clustered holes
function leafTile(p, cols, opts = {}) {
  const C = pal(cols), N = opts.count || 95, holeT = opts.holeT === undefined ? 0.56 : opts.holeT;
  const cover = new Uint8Array(TS * TS);
  for (let i = 0; i < N; i++) {
    const t = i / N, cx = p.rand() * TS, cy = p.rand() * TS, ang = p.rand() * Math.PI;
    const rx = (opts.rx || 2.2) + p.rand() * 1.4, ry = (opts.ry || 1.2) + p.rand() * 0.8;
    const base = ramp(C, 0.2 + t * 0.55 + (p.rand() - 0.5) * 0.25);
    const ca = Math.cos(ang), sa = Math.sin(ang), R = Math.ceil(rx);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca, d = (u * u) / (rx * rx) + (v * v) / (ry * ry);
      if (d > 1) continue;
      const lit = 1 + 0.22 * (-(dx + dy) / (rx + ry)) - 0.18 * d;
      const x = Math.floor(cx + dx), y = Math.floor(cy + dy);
      p.set(x, y, jit(p, mul(base, lit), 0.05)); p.setH(x, y, 0.3 + t * 0.4 + (1 - d) * 0.3);
      cover[p.i(x, y)] = 1;
    }
  }
  p.fill((x, y) => {
    if (cover[p.i(x, y)]) return;
    const hole = p.noise(x, y, 8, 8, 140) * 0.7 + p.rand() * 0.3 > holeT;
    if (hole) { p.set(x, y, mul(C[0], 0.7), 0); p.setH(x, y, 0); }
    else { p.set(x, y, jit(p, mul(C[0], 0.62), 0.06)); p.setH(x, y, 0.1); }
  });
  if (opts.extra) opts.extra(p, C);
}
function needleTile(p, cols) {
  const C = pal(cols);
  p.fill((x, y) => {
    const hole = p.noise(x, y, 8, 8, 150) * 0.7 + p.rand() * 0.3 > 0.6;
    p.set(x, y, jit(p, mul(C[0], 0.6), 0.06), hole ? 0 : 255); p.setH(x, y, 0);
  });
  for (let i = 0; i < 260; i++) {
    const t = i / 260, a = p.rand() * Math.PI * 2, L = 3 + p.ri(3);
    let x = p.rand() * TS, y = p.rand() * TS;
    const base = ramp(C, 0.15 + t * 0.7 + (p.rand() - 0.5) * 0.2);
    for (let k = 0; k < L; k++) {
      p.set(x, y, jit(p, mul(base, 0.9 + 0.2 * (k / L)), 0.05)); p.setH(x, y, 0.3 + t * 0.6);
      x += Math.cos(a); y += Math.sin(a);
    }
  }
}
function oreTile(p, colors, opts = {}) {
  stoneBase(p);
  const [dark, mid, light, hi] = colors.map(hex);
  const clusters = opts.clusters || 5;
  for (let c = 0; c < clusters; c++) {
    const cx = p.ri(TS), cy = p.ri(TS), n = 3 + p.ri(4);
    for (let k = 0; k < n; k++) {
      const x0 = cx + p.ri(7) - 3, y0 = cy + p.ri(7) - 3, r = 0.9 + p.rand() * (opts.size || 1.2);
      const R = Math.ceil(r) + 1;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d > 1.45) continue;
        if (d > 1) { p.scale(x0 + dx, y0 + dy, 0.8); continue; } // embedded rim shadow
        const s = -(dx + dy) / (2 * r); // facet towards top-left catches light
        const col = s > 0.45 ? hi : s > 0 ? light : s > -0.45 ? mid : dark;
        p.set(x0 + dx, y0 + dy, jit(p, col, 0.06)); p.setH(x0 + dx, y0 + dy, 0.95 + (1 - d) * 0.2);
      }
    }
  }
}
function woolBase(p, cols) {
  const C = pal(cols);
  p.fill((x, y) => {
    const w = p.noise(x, y, 4, 4, 160) * 9;
    const curl = Math.sin((x + w) * 1.3) * Math.cos((y - w) * 1.3) * 0.7;
    const n = p.fbm(x, y, 4, 3, 161);
    p.set(x, y, jit(p, ramp(C, 0.35 + curl * 0.2 + n * 0.35 + (p.rand() - 0.5) * 0.1), 0.03));
    p.setH(x, y, 0.5 + curl * 0.3 + n * 0.2);
  });
}
function smoothBase(p, cols, k = 0.5, specks = 0, speckCol = null) {
  const C = pal(cols);
  p.fill((x, y) => {
    const n = p.fbm(x, y, 3, 4, 170);
    p.set(x, y, jit(p, ramp(C, n * 0.75 + (p.rand() - 0.5) * 0.14 + 0.1), 0.04)); p.setH(x, y, n * k);
  });
  for (let i = 0; i < specks; i++) {
    const x = p.ri(TS), y = p.ri(TS);
    p.set(x, y, jit(p, speckCol ? hex(speckCol) : mul(ramp(C, 0.5), p.rand() < 0.5 ? 0.82 : 1.12), 0.08));
  }
}
function frame(p, w, col, hiCol) { // bevelled border
  const c = hex(col), hc = hiCol ? hex(hiCol) : mul(c, 1.25);
  p.fill((x, y) => {
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y);
    if (e >= w) return;
    p.set(x, y, jit(p, e === w - 1 ? hc : c, 0.06)); p.setH(x, y, 0.9);
  });
}

// ---------- tile painters ----------
const T = {};

T.dirt = p => { dirtBase(p); p.relief(1.4); };
T.coarse_dirt = p => {
  dirtBase(p, { pebbles: 26, roots: 0 });
  const g = pal(["#5a4a3e", "#6e6058", "#4a3c30", "#857a70"]);
  for (let i = 0; i < 30; i++) dome(p, p.ri(TS), p.ri(TS), 0.8 + p.rand() * 0.8, 0.7 + p.rand() * 0.6, p.pick(g), 0.5, 0.4);
  p.relief(1.6);
};
T.grass_top = p => { grassTopN(p); p.relief(1.1); };
T.grass_side_overlay = p => { // tinted fringe only, transparent elsewhere (drawn over plain dirt)
  p.clear();
  fringe(p, GRASS_N, 4, 8, { shadow: false });
  p.relief(0.9);
};
T.grass_side = p => { // pre-coloured (icons / fallback)
  dirtBase(p);
  fringe(p, GRASS_N.map(c => tintC(c, DEFAULT_TINT.grass)), 4, 8);
  p.relief(1.2);
};
T.snow = p => { smoothBase(p, ["#c9d3de", "#d9e1ea", "#e6ecf2", "#f0f3f7", "#f9fbfd"], 0.6); for (let i = 0; i < 14; i++) p.set(p.ri(TS), p.ri(TS), WHITE); p.relief(0.7); };
T.snow_side = p => { dirtBase(p); fringe(p, SNOW, 6, 10, { drip: 0.1 }); p.relief(1.2); };
T.mycelium_top = p => {
  smoothBase(p, ["#54474f", "#62545c", "#6e6067", "#7a6b72", "#867780"], 0.8);
  for (let i = 0; i < 26; i++) dome(p, p.ri(TS), p.ri(TS), 0.6, 0.6, hex(p.rand() < 0.5 ? "#a796a6" : "#8c7d8a"), 0.6, 0.3);
  p.relief(1.1);
};
T.mycelium_side = p => { dirtBase(p); fringe(p, pal(["#5a4c55", "#665760", "#71636a", "#7c6e74"]), 3, 6); p.relief(1.2); };
T.podzol_top = p => {
  smoothBase(p, ["#3a2712", "#473016", "#55391b", "#624321", "#714e28"], 0.6);
  grassBlades(p, pal(["#5a3a14", "#7a5220", "#946a30", "#3a2410"]), 120, [2, 4]);
  p.relief(1.2);
};
T.podzol_side = p => { dirtBase(p); fringe(p, pal(["#3a2712", "#4a3216", "#5a3d1c", "#6a4824"]), 3, 5); p.relief(1.2); };
T.moss_block = p => {
  p.fill((x, y) => { const n = p.fbm(x, y, 4, 3, 180); p.set(x, y, jit(p, ramp(MOSS, n * 0.6), 0.06)); p.setH(x, y, n * 0.4); });
  grassBlades(p, MOSS, 260, [1, 3]);
  p.relief(1.4);
};

T.stone = p => { stoneBase(p); p.relief(1.4); };
T.cobblestone = p => cobbleBase(p);
T.mossy_cobblestone = p => { cobbleBase(p); mossOver(p, 0.42); p.relief(0.5); };
T.bedrock = p => {
  const V = voronoi(p, 20), tone = []; for (let i = 0; i < 20; i++) tone.push(p.rand());
  const C = pal(["#151515", "#262626", "#363636", "#4c4c4c", "#666666"]);
  p.fill((x, y) => {
    const [k, d1, d2] = V(x, y), e = d2 - d1, n = p.fbm(x, y, 4, 3, 190);
    p.set(x, y, jit(p, ramp(C, e < 1 ? 0.05 : tone[k] * 0.8 + n * 0.3), 0.08)); p.setH(x, y, e < 1 ? 0 : 0.4 + tone[k] * 0.5 + n * 0.2);
  });
  p.relief(1.8);
};
T.gravel = p => {
  p.fill((x, y) => { p.set(x, y, jit(p, hex("#3f3b39"), 0.1)); p.setH(x, y, 0); });
  const g = pal(["#6e6a66", "#85807b", "#9a948e", "#7a6f66", "#5e5a58", "#a8a29a", "#8a7e72"]);
  for (let i = 0; i < 70; i++) dome(p, p.ri(TS), p.ri(TS), 1.4 + p.rand() * 1.8, 1.2 + p.rand() * 1.4, p.pick(g), 0.3, 0.6, 0.06);
  p.relief(1.7);
};
T.sand = p => { sandBase(p, SAND); p.relief(0.9); };
T.red_sand = p => { sandBase(p, RED_SAND); p.relief(0.9); };
T.sandstone_top = p => { sandBase(p, SANDSTONE, false); p.relief(0.6); };
T.sandstone_side = p => {
  sandBase(p, SANDSTONE, false);
  const bands = [[0, 6, 0.75], [6, 20, 0.45], [20, 26, 0.55], [26, 32, 0.35]];
  for (const [a, b, tone] of bands) for (let y = a; y < b; y++) for (let x = 0; x < TS; x++) {
    const streak = p.noise(x, y, 2, 16, 200);
    p.set(x, y, jit(p, ramp(SANDSTONE, tone + (streak - 0.5) * 0.35 + (p.rand() - 0.5) * 0.1), 0.04));
    p.setH(x, y, 0.8 - (y - a) / (b - a) * 0.35);
    if (y === b - 1) { p.scale(x, y, 0.82); p.setH(x, y, 0.1); }
  }
  p.relief(1.1);
};
T.sandstone_bricks = p => { bricks(p, { bw: 16, bh: 8, mortar: 1, offset: 8, cols: SANDSTONE, mortarCol: hex("#a8955f"), bevel: 2, bias: 0.15, vary: 0.4 }); p.relief(1.0); };
T.bricks = p => {
  bricks(p, { bw: 16, bh: 8, mortar: 2, offset: 8, cols: pal(["#6e3a2e", "#7d4334", "#8c4c3c", "#995746", "#a46351"]), mortarCol: hex("#9e978c"), bevel: 2, vary: 0.6, bias: 0.05 });
  p.relief(1.6);
};
T.clay = p => { smoothBase(p, ["#868c98", "#9198a3", "#9ca2ad", "#a6acb7", "#b0b6c0"], 0.6, 12); p.relief(0.7); };
T.ice = p => {
  const C = pal(["#7aa2da", "#88aee3", "#97baea", "#a6c6f0", "#b8d3f5"]);
  p.fill((x, y) => {
    const n = p.fbm(x, y, 3, 3, 210), s = p.noise(x, y, 2, 10, 211);
    let c = ramp(C, n * 0.6 + s * 0.3 + (p.rand() - 0.5) * 0.06);
    if (Math.abs(p.noise(x, y, 4, 4, 212) - 0.5) < 0.014) c = mix(c, hex("#e8f2ff"), 0.65);
    p.set(x, y, jit(p, c, 0.03)); p.setH(x, y, n * 0.4);
  });
  for (let i = 0; i < 8; i++) p.set(p.ri(TS), p.ri(TS), hex("#dbe9fb"));
  p.relief(0.5);
};
T.packed_ice = p => {
  const C = pal(["#82aae2", "#8fb4e8", "#9bbdec", "#a8c7f0", "#b5d0f4"]);
  p.fill((x, y) => {
    const n = p.fbm(x, y, 4, 4, 215);
    let c = ramp(C, n * 0.7 + (p.rand() - 0.5) * 0.12);
    if (Math.abs(p.noise(x, y, 3, 3, 216) - 0.5) < 0.016) c = mul(c, 0.82);
    p.set(x, y, jit(p, c, 0.04)); p.setH(x, y, n * 0.5);
  });
  p.relief(0.7);
};
// water: light neutral blue (tinted by biome). frame f of F for animation (loops seamlessly).
function waterPaint(p, f, F) {
  const C = pal(["#7d97bd", "#8ba5c9", "#9ab2d3", "#aac0dc", "#c9d8ec"]);
  const ph = f / F, o = ph * TS;
  p.fill((x, y) => {
    const a = p.fbm(x + o, y + o * 0.5, 3, 3, 220), b = p.fbm(x - o * 0.5, y - o, 4, 3, 221);
    const v = a * 0.55 + b * 0.45;
    const ridge = 1 - Math.abs(v - 0.5) * 2; // bright crest lines
    let c = ramp(C, 0.15 + v * 0.55 + Math.pow(ridge, 6) * 0.35);
    p.set(x, y, c); p.setH(x, y, v);
  });
  p.relief(0.5);
}
const WATER_FRAMES = 32;
T.water = p => waterPaint(p, 0, WATER_FRAMES);

// wood
T.oak_log = p => { barkSide(p, pal(["#33251a", "#47331f", "#5a4227", "#6a4f2f", "#7a5c38"])); p.relief(1.8); };
T.spruce_log = p => { barkSide(p, pal(["#1d150d", "#281c11", "#332416", "#3f2d1c", "#4a3622"])); p.relief(1.8); };
T.dark_oak_log = p => { barkSide(p, pal(["#1f160c", "#291d10", "#332414", "#3e2c19", "#48341f"])); p.relief(1.8); };
T.jungle_log = p => {
  barkSide(p, pal(["#3a2a13", "#493518", "#57401e", "#654b25", "#73562d"]), {
    after: p => { mossOver(p, 0.18, 230); },
  });
  p.relief(1.8);
};
T.acacia_log = p => { barkSide(p, pal(["#45413b", "#534e47", "#615b52", "#6d675d", "#7a7368"])); p.relief(1.7); };
T.mangrove_log = p => { barkSide(p, pal(["#3c1a14", "#4a221b", "#572b22", "#63342a", "#6f3d32"])); p.relief(1.8); };
T.cherry_log = p => {
  barkSide(p, pal(["#24141a", "#2f1b21", "#3a2329", "#452b31", "#503339"]), {
    after: p => { for (let i = 0; i < 16; i++) { const x = p.ri(TS), y = p.ri(TS), L = 3 + p.ri(6); for (let k = 0; k < L; k++) { p.set(x + k, y, jit(p, hex("#6a4a50"), 0.06)); p.setH(x + k, y, 0.7); } } },
  });
  p.relief(1.6);
};
T.birch_log = p => {
  const C = pal(["#b3aea2", "#c8c3b7", "#d8d3c8", "#e5e1d7", "#efece4"]);
  p.fill((x, y) => {
    const n = p.fbm(x, y, 3, 3, 240), s = p.noise(x, y, 2, 16, 241);
    p.set(x, y, jit(p, ramp(C, 0.35 + n * 0.4 + (s - 0.5) * 0.3), 0.03)); p.setH(x, y, 0.6 + n * 0.2);
  });
  const dark = pal(["#26221e", "#35302a", "#48423a"]);
  for (let i = 0; i < 22; i++) { // lenticels
    const x = p.ri(TS), y = p.ri(TS), L = 2 + p.ri(8), th = p.rand() < 0.3 ? 2 : 1;
    for (let k = 0; k < L; k++) for (let t = 0; t < th; t++) {
      p.set(x + k, y + t, jit(p, k === 0 || k === L - 1 ? dark[2] : p.pick(dark), 0.08)); p.setH(x + k, y + t, 0.2);
    }
  }
  for (let i = 0; i < 2; i++) dome(p, p.ri(TS), p.ri(TS), 2.5, 1.6, hex("#2e2925"), 0.1, 0.2);
  p.relief(1.0);
};
T.oak_log_top = p => { logTop(p, ["#33251a", "#47331f", "#5a4227", "#6a4f2f"], "#b48f5c", "#9a7748", "#7d5e38"); p.relief(0.9); };
T.spruce_log_top = p => { logTop(p, ["#1d150d", "#281c11", "#332416", "#3f2d1c"], "#8a6a46", "#755838", "#5e452c"); p.relief(0.9); };
T.dark_oak_log_top = p => { logTop(p, ["#1f160c", "#291d10", "#332414", "#3e2c19"], "#6e5234", "#5a4228", "#463220"); p.relief(0.9); };
T.jungle_log_top = p => { logTop(p, ["#3a2a13", "#493518", "#57401e", "#654b25"], "#ad8a58", "#977546", "#7c5f38"); p.relief(0.9); };
T.acacia_log_top = p => { logTop(p, ["#45413b", "#534e47", "#615b52", "#6d675d"], "#c06e44", "#a85a34", "#8e4a2a"); p.relief(0.9); };
T.mangrove_log_top = p => { logTop(p, ["#41160f", "#511d15", "#60251c", "#6d2d23"], "#a65e48", "#904c3a", "#763c2e"); p.relief(0.9); };
T.cherry_log_top = p => { logTop(p, ["#24141a", "#2f1b21", "#3a2329", "#452b31"], "#dcaaa2", "#c48e88", "#a87470"); p.relief(0.9); };
T.birch_log_top = p => { logTop(p, ["#d8d3c8", "#c8c3b7", "#e5e1d7", "#b3aea2"], "#d4bf92", "#c0a97c", "#a89066"); p.relief(0.9); };

// tintable (neutral) leaves
const LEAF_N = ["#4d5549", "#5f685a", "#717a6a", "#848c7b", "#979f8c"];
T.oak_leaves = p => { leafTile(p, LEAF_N); p.relief(1.0); };
T.jungle_leaves = p => { leafTile(p, ["#465046", "#566254", "#677363", "#7a8674", "#8d9986"], { rx: 2.8, ry: 1.6, count: 80, holeT: 0.62 }); p.relief(1.0); };
T.acacia_leaves = p => { leafTile(p, LEAF_N, { rx: 1.8, ry: 1.0, count: 110, holeT: 0.5 }); p.relief(1.0); };
T.dark_oak_leaves = p => { leafTile(p, ["#3f473c", "#4e584b", "#5e6959", "#6e7a68", "#7e8a77"], { count: 105, holeT: 0.6 }); p.relief(1.0); };
T.mangrove_leaves = p => { leafTile(p, LEAF_N, { rx: 2.4, ry: 1.0, count: 100 }); p.relief(1.0); };
// pre-coloured leaves
T.birch_leaves = p => { leafTile(p, ["#3f5a26", "#4e6c2e", "#5e7d38", "#6f8d44", "#829d52"], { rx: 1.9, ry: 1.2, count: 105 }); p.relief(1.0); };
T.spruce_leaves = p => { needleTile(p, ["#22382a", "#2c4533", "#36523c", "#416046", "#4d6d51"]); p.relief(1.0); };
T.cherry_leaves = p => {
  leafTile(p, ["#b06a8c", "#c97ea2", "#dc94b6", "#e8aac6", "#f2c2d6"], {
    rx: 1.6, ry: 1.3, count: 120, holeT: 0.5,
    extra: p => { for (let i = 0; i < 30; i++) { const x = p.ri(TS), y = p.ri(TS); if (p.a(x, y)) p.set(x, y, jit(p, hex(p.rand() < 0.6 ? "#fbe6ef" : "#a35a7c"), 0.04)); } },
  });
  p.relief(0.9);
};

T.planks = p => { planksBase(p, WOOD_OAK, "#3d2c18"); p.relief(1.3); };
T.spruce_planks = p => { planksBase(p, WOOD_SPRUCE, "#24190e"); p.relief(1.3); };
T.acacia_planks = p => { planksBase(p, WOOD_ACACIA, "#4a2210"); p.relief(1.3); };

T.cactus_side = p => {
  const C = pal(["#28491a", "#335a20", "#3f6a27", "#4b782f", "#588537"]);
  p.fill((x, y) => {
    const rib = 0.5 + 0.5 * Math.cos((x - 4) * Math.PI * 2 / 8);
    const n = p.noise(x, y, 4, 8, 250);
    let c = ramp(C, rib * 0.7 + n * 0.25 + (p.rand() - 0.5) * 0.08);
    if (x === 0 || x === 31) c = mul(c, 0.7);
    p.set(x, y, jit(p, c, 0.04)); p.setH(x, y, rib * 0.8);
  });
  for (const cx of [4, 12, 20, 28]) for (let y = p.ri(4); y < TS; y += 5 + p.ri(3)) {
    p.set(cx, y, hex("#e2dbb0")); p.set(cx + 1, y, hex("#c9c094")); p.setH(cx, y, 1.2); p.scale(cx, y + 1, 0.7);
  }
  p.relief(1.5);
};
T.cactus_top = p => {
  const C = pal(["#28491a", "#335a20", "#3f6a27", "#4b782f", "#588537"]);
  p.fill((x, y) => {
    const r = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5));
    const ring = 0.5 + 0.5 * Math.cos(r * Math.PI * 2 / 6);
    let c = ramp(C, ring * 0.6 + 0.2 + (p.rand() - 0.5) * 0.1);
    if (r > 12.5) c = mul(c, 0.7);
    p.set(x, y, jit(p, c, 0.04)); p.setH(x, y, ring * 0.5);
  });
  for (let i = 0; i < 8; i++) { const x = 6 + p.ri(20), y = 6 + p.ri(20); p.set(x, y, hex("#e2dbb0")); p.setH(x, y, 1); }
  p.relief(1.2);
};
T.cactus_bottom = p => {
  const C = pal(["#4a6a2a", "#5a7a34", "#6a8a3e", "#7a9a48"]);
  p.fill((x, y) => {
    const r = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5));
    p.set(x, y, jit(p, ramp(C, (r > 12.5 ? 0.1 : 0.6) + p.noise(x, y, 4, 4, 255) * 0.3), 0.05)); p.setH(x, y, r > 12.5 ? 0.2 : 0.5);
  });
  p.relief(1.0);
};

T.coal_ore = p => { oreTile(p, ["#141414", "#1f1f1f", "#2e2e2e", "#5a5a5a"], { size: 1.5 }); p.relief(1.5); };
T.iron_ore = p => { oreTile(p, ["#8a5e44", "#b48466", "#d6aa8a", "#f2d6c0"]); p.relief(1.5); };
T.gold_ore = p => { oreTile(p, ["#9a7212", "#d4a82a", "#f2d24a", "#fff6b0"]); p.relief(1.5); };
T.diamond_ore = p => { oreTile(p, ["#1c7a82", "#38b8c0", "#6ae4ea", "#e2ffff"]); p.relief(1.5); };

T.glass = p => {
  p.fill((x, y) => { p.set(x, y, [200, 225, 235], 0); p.setH(x, y, 0); });
  const fr = hex("#e4f2f6"), mid = hex("#b9d4dc"), dk = hex("#8aaab4");
  p.fill((x, y) => {
    const e = Math.min(x, y, 31 - x, 31 - y);
    if (e > 1) return;
    const tl = x <= 1 || y <= 1;
    p.set(x, y, e === 0 ? (tl ? fr : dk) : mid);
  });
  for (const [x, y, n] of [[6, 11, 6], [7, 14, 3], [20, 26, 6], [22, 27, 2]]) for (let k = 0; k < n; k++) { p.set(x + k, y - k, WHITE); p.set(x + k + 1, y - k, hex("#e8f6fa")); }
};
T.crafting_table_top = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  frame(p, 3, "#4a3219", "#6a4a28");
  const g = hex("#55391c");
  for (let i = 6; i <= 25; i++) for (const k of [6, 12, 19, 25]) { p.set(i, k, g); p.setH(i, k, 0.2); p.set(k, i, g); p.setH(k, i, 0.2); }
  p.relief(1.4);
};
T.crafting_table_front = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  const top = pal(["#5a3d20", "#6a4a28", "#4a3219"]);
  for (let x = 0; x < TS; x++) for (let y = 0; y < 6; y++) { p.set(x, y, jit(p, y === 0 || y === 5 ? top[2] : ramp(top, p.noise(x, y, 4, 8, 260)), 0.05)); p.setH(x, y, y === 5 ? 0.1 : 0.9); }
  for (let y = 6; y < TS; y++) for (const x of [0, 1, 30, 31]) { p.set(x, y, jit(p, top[2], 0.05)); p.setH(x, y, 0.9); }
  const m = hex("#b8b8b8"), md = hex("#7a7a7a"), h = hex("#5a3d1e");
  for (let x = 5; x <= 15; x++) { p.set(x, 11, m); p.set(x, 12, m); p.set(x, 13, x % 2 ? md : m); p.setH(x, 11, 1); p.setH(x, 12, 1); } // saw
  for (let x = 16; x <= 19; x++) for (let y = 10; y <= 13; y++) { p.set(x, y, h); p.setH(x, y, 1); }
  for (let y = 11; y <= 26; y++) { p.set(24, y, h); p.set(25, y, mul(h, 0.8)); p.setH(24, y, 1); } // hammer
  for (let x = 20; x <= 29; x++) for (let y = 8; y <= 11; y++) { p.set(x, y, y === 8 ? WHITE : y === 11 ? md : m); p.setH(x, y, 1); }
  p.relief(1.4);
};
T.crafting_table_side = p => {
  planksBase(p, WOOD_OAK, "#3d2c18");
  const top = pal(["#5a3d20", "#6a4a28", "#4a3219"]);
  for (let x = 0; x < TS; x++) for (let y = 0; y < 6; y++) { p.set(x, y, jit(p, y === 0 || y === 5 ? top[2] : ramp(top, p.noise(x, y, 4, 8, 260)), 0.05)); p.setH(x, y, y === 5 ? 0.1 : 0.9); }
  for (let y = 6; y < TS; y++) for (const x of [0, 1, 30, 31]) { p.set(x, y, jit(p, top[2], 0.05)); p.setH(x, y, 0.9); }
  const h = hex("#5a3d1e"), m = hex("#a8a8a8");
  for (let k = 0; k < 14; k++) { p.set(8 + k, 10 + k, h); p.set(22 - k, 10 + k, h); p.setH(8 + k, 10 + k, 1); p.setH(22 - k, 10 + k, 1); } // crossed tongs
  for (let x = 6; x <= 9; x++) for (let y = 8; y <= 10; y++) p.set(x, y, m);
  for (let x = 21; x <= 24; x++) for (let y = 8; y <= 10; y++) p.set(x, y, m);
  p.relief(1.4);
};
T.wool = p => { woolBase(p, ["#c8c8c6", "#d4d4d2", "#dfdfdd", "#e8e8e6", "#f0f0ee"]); p.relief(0.8); };
T.white_wool = p => { woolBase(p, ["#d6d6d4", "#e0e0de", "#eaeae8", "#f2f2f0", "#fafaf8"]); p.relief(0.8); };
T.pumpkin_side = p => {
  const C = pal(["#7c400e", "#9a5212", "#b26218", "#c47222", "#d18230"]);
  p.fill((x, y) => {
    const ph = (x % 8) / 8, h = Math.sin(Math.PI * ph);
    let c = ramp(C, h * 0.75 + p.noise(x, y, 4, 8, 270) * 0.2 + (p.rand() - 0.5) * 0.06);
    const ey = Math.min(y, 31 - y);
    if (ey < 3) c = mul(c, 0.8 + ey * 0.06);
    p.set(x, y, jit(p, c, 0.04)); p.setH(x, y, h * 0.8);
  });
  p.relief(1.5);
};
T.pumpkin_top = p => {
  const C = pal(["#7c400e", "#9a5212", "#b26218", "#c47222", "#d18230"]);
  p.fill((x, y) => {
    const a = Math.atan2(y - 15.5, x - 15.5), r = Math.hypot(x - 15.5, y - 15.5);
    const h = Math.abs(Math.sin(a * 4));
    p.set(x, y, jit(p, ramp(C, h * 0.7 + (r > 14 ? -0.15 : 0.1) + (p.rand() - 0.5) * 0.08), 0.04)); p.setH(x, y, h * 0.6);
  });
  for (let y = 13; y <= 18; y++) for (let x = 13; x <= 18; x++) {
    const e = Math.min(x - 13, y - 13, 18 - x, 18 - y);
    p.set(x, y, jit(p, hex(e === 0 ? "#3e4a16" : "#5a6a24"), 0.08)); p.setH(x, y, 1 + e * 0.2);
  }
  p.relief(1.3);
};
T.furnace_top = p => {
  smoothBase(p, ["#5c5c5c", "#666666", "#707070", "#7a7a7a", "#848484"], 0.4, 10);
  frame(p, 2, "#585858", "#8e8e8e");
  p.relief(1.2);
};
T.furnace_side = p => {
  smoothBase(p, ["#5c5c5c", "#666666", "#707070", "#7a7a7a", "#848484"], 0.4, 10);
  frame(p, 2, "#585858", "#8e8e8e");
  for (let x = 2; x < 30; x++) { p.set(x, 15, hex("#4e4e4e")); p.set(x, 16, hex("#8a8a8a")); p.setH(x, 15, 0.1); }
  p.relief(1.2);
};
T.furnace_front = p => {
  cobbleBase(p, { count: 30, cols: pal(["#525252", "#5e5e5e", "#6a6a6a", "#767676", "#828282"]) });
  frame(p, 2, "#4a4a4a", "#8a8a8a");
  const fr = hex("#3a3a3a"), inner = hex("#0e0d0c");
  for (let x = 8; x <= 23; x++) for (let y = 6; y <= 9; y++) { p.set(x, y, y === 6 || y === 9 ? fr : inner); p.setH(x, y, y === 6 ? 0.9 : 0.05); }
  for (let y = 15; y <= 27; y++) for (let x = 6; x <= 25; x++) {
    const edge = y < 17 || y > 25 || x < 8 || x > 23;
    if (edge) { p.set(x, y, jit(p, y === 15 || x === 6 ? hex("#8a8a8a") : fr, 0.06)); p.setH(x, y, 1); continue; }
    const heat = smooth(18, 25, y);
    p.set(x, y, mix(inner, hex("#6a2a08"), heat * 0.6)); p.setH(x, y, 0);
  }
  for (let x = 8; x <= 23; x++) {
    p.set(x, 25, p.rand() < 0.5 ? hex("#ffb23a") : hex("#ff7a1a"));
    if (p.rand() < 0.6) p.set(x, 24, p.rand() < 0.3 ? hex("#ffe08a") : hex("#e86a14"));
  }
  p.relief(1.6);
};

// village blocks
T.dirt_path_top = p => {
  smoothBase(p, ["#6f5832", "#7d653a", "#8a7142", "#957c4b", "#a08856"], 0.4);
  const g = pal(["#6a5a46", "#887458", "#5e4e3a"]);
  for (let i = 0; i < 10; i++) dome(p, p.ri(TS), p.ri(TS), 0.8, 0.7, p.pick(g), 0.4, 0.3);
  p.relief(0.9);
};
T.dirt_path_side = p => { dirtBase(p); fringe(p, pal(["#6f5832", "#7d653a", "#8a7142", "#957c4b"]), 5, 6, { drip: 0.05 }); p.relief(1.2); };
T.farmland = p => {
  const C = pal(["#2a1c10", "#352414", "#412c19", "#4c351e", "#573e24"]);
  p.fill((x, y) => {
    const ridge = 0.5 + 0.5 * Math.cos(y * Math.PI * 2 / 8), n = p.fbm(x, y, 4, 3, 280);
    p.set(x, y, jit(p, ramp(C, ridge * 0.55 + n * 0.35 + (p.rand() - 0.5) * 0.1), 0.06)); p.setH(x, y, ridge * 0.8 + n * 0.3);
  });
  for (let i = 0; i < 18; i++) dome(p, p.ri(TS), p.ri(TS), 0.9, 0.7, hex("#4e3820"), 0.6, 0.4);
  p.relief(1.8);
};
T.hay_bale_side = p => {
  const C = pal(["#8e7022", "#a5832a", "#b99532", "#c9a63e", "#d6b64c"]);
  p.fill((x, y) => { p.set(x, y, jit(p, ramp(C, 0.3 + p.rand() * 0.3), 0.05)); p.setH(x, y, 0.3); });
  for (let i = 0; i < 260; i++) { // straw fibres
    let x = p.rand() * TS, y = p.rand() * TS;
    const a = (p.rand() - 0.5) * 0.5, L = 4 + p.ri(7), col = ramp(C, p.rand());
    for (let k = 0; k < L; k++) { p.set(x, y, jit(p, col, 0.04)); p.setH(x, y, 0.5 + p.rand() * 0.3); x += Math.cos(a); y += Math.sin(a); }
  }
  const band = pal(["#4e3216", "#6a4620", "#82582a"]);
  for (const y0 of [5, 23]) for (let y = y0; y < y0 + 4; y++) for (let x = 0; x < TS; x++) {
    const tw = ((x + y) % 4) / 3;
    p.set(x, y, jit(p, ramp(band, y === y0 ? 0.9 : y === y0 + 3 ? 0.1 : tw), 0.05)); p.setH(x, y, y === y0 + 3 ? 0.4 : 0.95);
  }
  p.relief(1.3);
};
T.hay_bale_top = p => {
  const C = pal(["#8e7022", "#a5832a", "#b99532", "#c9a63e", "#d6b64c"]);
  p.fill((x, y) => { p.set(x, y, jit(p, ramp(C, 0.25 + p.rand() * 0.3), 0.05)); p.setH(x, y, 0.3); });
  for (let i = 0; i < 260; i++) {
    let x = p.rand() * TS, y = p.rand() * TS;
    const a = Math.atan2(y - 15.5, x - 15.5) + Math.PI / 2 + (p.rand() - 0.5) * 0.4, L = 3 + p.ri(5), col = ramp(C, p.rand());
    for (let k = 0; k < L; k++) { p.set(x, y, jit(p, col, 0.04)); p.setH(x, y, 0.5 + p.rand() * 0.3); x += Math.cos(a); y += Math.sin(a); }
  }
  const band = pal(["#4e3216", "#6a4620", "#82582a"]);
  for (const y0 of [5, 23]) for (let y = y0; y < y0 + 4; y++) for (let x = 0; x < TS; x++) { p.set(x, y, jit(p, ramp(band, ((x + y) % 4) / 3), 0.05)); p.setH(x, y, 0.95); }
  p.relief(1.3);
};
// Model blocks: side tiles are sampled by box position (model px m -> image x 2m, image y 32-2v).
const ICON_T = {}; // painters used only for flat inventory icons
ICON_T.bell = p => {
  p.clear();
  const G = pal(["#7a5c14", "#a8821e", "#d2a832", "#ecc650", "#fbe7a0"]), wood = pal(["#3a2a18", "#5a4228", "#6e5232"]);
  for (let y = 0; y < 5; y++) for (let x = 3; x < 29; x++) { p.set(x, y, jit(p, ramp(wood, y === 0 ? 1 : y === 4 ? 0 : 0.5), 0.06)); p.setH(x, y, 1); }
  for (let y = 5; y < 9; y++) for (let x = 14; x < 18; x++) { p.set(x, y, jit(p, hex("#4a4a4e"), 0.08)); p.setH(x, y, 1); }
  for (let y = 9; y <= 27; y++) {
    const half = y < 11 ? 4 : y < 24 ? 4 + (y - 11) * 0.45 : 11;
    for (let x = 0; x < TS; x++) {
      const dx = x - 15.5;
      if (Math.abs(dx) > half) continue;
      const t = 0.85 - (dx + half) / (2 * half) * 0.8 + (y >= 24 ? -0.15 : 0);
      p.set(x, y, jit(p, ramp(G, t), 0.03)); p.setH(x, y, 1);
    }
  }
  for (let y = 28; y <= 30; y++) for (let x = 14; x <= 17; x++) p.set(x, y, ramp(G, 0.2));
};
ICON_T.lantern = p => {
  p.clear();
  const fr = hex("#2e2e34"), frL = hex("#4c4c56"), frH = hex("#6a6a76");
  for (let y = 0; y < 8; y++) { const c = y % 3 === 1 ? frH : frL; p.set(15, y, c); p.set(16, y, y % 3 === 1 ? frL : fr); }
  for (let y = 8; y < 11; y++) for (let x = 10; x <= 21; x++) p.set(x, y, y === 8 ? frH : x === 10 || x === 21 ? fr : frL);
  for (let y = 11; y <= 27; y++) for (let x = 8; x <= 23; x++) {
    const edge = x <= 9 || x >= 22 || y === 11 || y === 27;
    if (edge) { p.set(x, y, x === 8 || y === 11 ? frL : fr); continue; }
    if (x === 15 || x === 16) { p.set(x, y, fr); continue; } // centre mullion
    const d = Math.hypot((x - 15.5) / 6, (y - 19) / 7.5);
    p.set(x, y, mix(hex("#fff4c8"), hex("#e0721a"), smooth(0.1, 1.0, d)));
  }
  for (let x = 9; x <= 22; x++) { p.set(x, 28, fr); p.set(x, 29, frL); }
};
T.oak_fence = p => {
  p.clear();
  const draw = (x, y, e) => {
    const t = p.noise(x, y, 2, 16, 290) * 0.6 + 0.2 + (e === 0 ? 0.25 : e === 1 ? -0.25 : 0);
    p.set(x, y, jit(p, ramp(WOOD_OAK, t), 0.05)); p.setH(x, y, 1);
  };
  for (let y = 0; y < TS; y++) for (let x = 12; x <= 19; x++) draw(x, y, x === 12 ? 0 : x === 19 ? 1 : 2);
  for (const y0 of [6, 18]) for (let y = y0; y < y0 + 6; y++) for (let x = 0; x < TS; x++) if (x < 12 || x > 19) draw(x, y, y === y0 ? 0 : y === y0 + 5 ? 1 : 2);
};
const GOLD = pal(["#7a5c14", "#a8821e", "#d2a832", "#ecc650", "#fbe7a0"]);
function goldRect(p, x0, y0, x1, y1, dark = 0) { // vertical cylinder-ish shading, lit from the left
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = 0.9 - (x - x0) / Math.max(1, x1 - x0) * 0.7 - dark + (p.rand() - 0.5) * 0.06;
    p.set(x, y, jit(p, ramp(GOLD, t), 0.03)); p.setH(x, y, 1);
  }
}
T.bell = p => {
  p.clear();
  goldRect(p, 14, 0, 17, 5, 0.1);   // stem (y 13..16)
  goldRect(p, 10, 6, 21, 19);       // body (y 6..13)
  for (let x = 10; x <= 21; x++) p.set(x, 6, ramp(GOLD, 0.95)); // shoulder highlight
  goldRect(p, 8, 20, 23, 23, 0.12); // rim (y 4..6)
  for (let x = 8; x <= 23; x++) p.set(x, 23, ramp(GOLD, 0.1));
};
T.bell_top = p => {
  p.fill((x, y) => { const r = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5)); p.set(x, y, jit(p, ramp(GOLD, 0.8 - r / 16 * 0.5), 0.03)); });
  for (let y = 14; y <= 17; y++) for (let x = 14; x <= 17; x++) p.set(x, y, ramp(GOLD, 0.45));
};
T.bell_bottom = p => {
  p.fill((x, y) => { const r = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5)); p.set(x, y, jit(p, ramp(GOLD, r > 6 ? 0.35 : 0.08), 0.03)); });
  for (let y = 14; y <= 17; y++) for (let x = 14; x <= 17; x++) p.set(x, y, hex("#3a3a3e")); // clapper
};
const IRON = pal(["#232328", "#2e2e34", "#3c3c44", "#4c4c56", "#6a6a76"]);
T.lantern = p => {
  p.clear();
  for (let y = 0; y < 14; y++) { p.set(15, y, IRON[y % 3 === 1 ? 4 : 3]); p.set(16, y, IRON[y % 3 === 1 ? 3 : 1]); } // chain
  for (let y = 14; y <= 17; y++) for (let x = 12; x <= 19; x++) p.set(x, y, jit(p, IRON[y === 14 ? 4 : x === 12 ? 3 : x === 19 ? 0 : 2], 0.05)); // cap
  for (let y = 18; y <= 31; y++) for (let x = 10; x <= 21; x++) { // body (y 0..7)
    const edge = x <= 11 || x >= 20 || y === 18 || y >= 30;
    if (edge) { p.set(x, y, IRON[x === 10 || y === 18 ? 3 : 1]); continue; }
    const d = Math.hypot((x - 15.5) / 4.5, (y - 24) / 6);
    p.set(x, y, mix(hex("#fff4c8"), hex("#e0721a"), smooth(0.05, 1.0, d)));
  }
};
T.lantern_top = p => {
  p.fill((x, y) => { const e = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5)); p.set(x, y, jit(p, IRON[e > 4.5 ? 1 : e > 3.5 ? 3 : 2], 0.06)); });
  for (let y = 15; y <= 16; y++) for (let x = 15; x <= 16; x++) p.set(x, y, IRON[0]);
};
T.lantern_bottom = p => p.fill((x, y) => p.set(x, y, jit(p, IRON[(x + y) % 5 ? 1 : 2], 0.06)));

// chest: box 1..15 wide, 0..14 tall -> visible tile area x/z 2..29, y 4..31 on the sides
function rectFrame(p, x0, y0, x1, y1, col, hiCol) {
  const c = hex(col), hc = hex(hiCol);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const e = Math.min(x - x0, y - y0, x1 - x, y1 - y);
    if (e > 1) continue;
    p.set(x, y, jit(p, e === 1 ? hc : c, 0.05)); p.setH(x, y, 0.9);
  }
}
T.chest_top = p => { planksBase(p, WOOD_CHEST, "#4a2e10"); rectFrame(p, 2, 2, 29, 29, "#3a2610", "#5e3e1c"); p.relief(1.3); };
T.chest_bottom = p => { planksBase(p, WOOD_CHEST, "#4a2e10"); rectFrame(p, 2, 2, 29, 29, "#3a2610", "#5e3e1c"); p.fill((x, y) => p.scale(x, y, 0.85)); p.relief(1.0); };
function chestSideBase(p) {
  planksBase(p, WOOD_CHEST, "#4a2e10");
  rectFrame(p, 2, 4, 29, 31, "#3a2610", "#5e3e1c");
  for (let x = 2; x <= 29; x++) { p.set(x, 13, hex("#2e1e0c")); p.setH(x, 13, 0); p.set(x, 14, hex("#5e3e1c")); } // lid seam (v 9.5)
}
T.chest_side = p => { chestSideBase(p); p.relief(1.3); };
T.chest_front = p => {
  chestSideBase(p);
  const m = pal(["#6a6a6a", "#9a9a9a", "#c8c8c8", "#eeeeee"]);
  for (let y = 10; y <= 18; y++) for (let x = 14; x <= 17; x++) {
    const e = Math.min(x - 14, y - 10, 17 - x, 18 - y);
    p.set(x, y, ramp(m, e === 0 ? (x === 14 || y === 10 ? 0.95 : 0.1) : 0.6)); p.setH(x, y, 1.1);
  }
  p.relief(1.3);
};

// oak door: vertical boards in a frame; the bottom half has two raised panels and the handle,
// the top half a four-pane window (transparent holes). Thin door edges sample the frame columns.
function doorBase(p) {
  p.fill((x, y) => {
    const board = x >> 3, grain = p.noise(x, y, 16, 2, 300 + board), fine = p.noise(x, y, 32, 4, 310 + board);
    let t = 0.5 + (ihash(board, 7, p.seed) - 0.5) * 0.3 + (grain - 0.5) * 0.8 + (fine - 0.5) * 0.4;
    let h = 0.7 + grain * 0.15;
    if (x % 8 === 7) { t -= 0.55; h = 0.1; }
    p.set(x, y, jit(p, ramp(WOOD_OAK, t), 0.04)); p.setH(x, y, h);
  });
  const fr = pal(["#5a4128", "#6e5232", "#86663e"]);
  p.fill((x, y) => {
    if (Math.min(x, 31 - x) > 2) return;
    p.set(x, y, jit(p, ramp(fr, Math.min(x, 31 - x) === 2 ? 0.2 : 0.7), 0.05)); p.setH(x, y, 1);
  });
}
T.oak_door_top = p => {
  doorBase(p);
  const fr = pal(["#5a4128", "#6e5232", "#86663e"]);
  for (let x = 3; x < 29; x++) for (const y of [0, 1]) { p.set(x, y, jit(p, ramp(fr, y ? 0.2 : 0.7), 0.05)); p.setH(x, y, 1); }
  for (let y = 5; y <= 22; y++) for (let x = 6; x <= 25; x++) {
    const e = Math.min(x - 6, y - 5, 25 - x, 22 - y), bar = x === 15 || x === 16 || y === 13 || y === 14;
    if (e >= 2 && !bar) { p.set(x, y, [70, 60, 45], 0); continue; }
    p.set(x, y, jit(p, ramp(fr, e === 0 ? 0.15 : 0.75), 0.05)); p.setH(x, y, e === 0 ? 0.2 : 0.95);
  }
  p.relief(1.3);
};
T.oak_door_bottom = p => {
  doorBase(p);
  const fr = pal(["#5a4128", "#6e5232", "#86663e"]);
  for (let x = 3; x < 29; x++) for (const y of [30, 31]) { p.set(x, y, jit(p, ramp(fr, y === 31 ? 0.1 : 0.6), 0.05)); p.setH(x, y, 1); }
  for (const [x0, y0, x1, y1] of [[6, 4, 14, 26], [17, 4, 25, 26]]) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const e = Math.min(x - x0, y - y0, x1 - x, y1 - y);
    if (e === 0) { p.set(x, y, jit(p, ramp(fr, x === x0 || y === y0 ? 0.05 : 0.9), 0.05)); p.setH(x, y, 0.3); }
    else if (e === 1) p.scale(x, y, 1.12);
  }
  const m = pal(["#2e2e34", "#5a5a64", "#9a9aa6"]);
  for (let y = 0; y <= 3; y++) for (let x = 25; x <= 27; x++) { p.set(x, y, ramp(m, x === 25 ? 0.95 : y === 3 ? 0 : 0.5)); p.setH(x, y, 1.2); }
  p.relief(1.3);
};
// bed: red blanket with a turned-down edge on top, white pillow tile at the head,
// sides = blanket over a white sheet line over the oak frame and legs (rows 24..31 = v 0..4).
const BED_RED = ["#7a1e1e", "#8e2424", "#a22a2a", "#b43232", "#c23c3a"];
T.bed_top = p => {
  woolBase(p, BED_RED);
  for (let x = 0; x < TS; x++) for (let y = 0; y < 3; y++) { p.scale(x, y, y === 2 ? 0.8 : 1.12); p.setH(x, y, y === 2 ? 0.2 : 0.9); }
  p.relief(0.9);
};
T.bed_pillow = p => {
  woolBase(p, ["#cfcfcb", "#dcdcd8", "#e6e6e2", "#f0f0ec", "#f8f8f4"]);
  p.fill((x, y) => { const e = Math.min(x, y, 31 - x, 31 - y); if (e < 2) p.scale(x, y, 0.88 + e * 0.04); p.setH(x, y, e < 2 ? 0.3 : 0.8); });
  p.relief(0.8);
};
T.bed_side = p => {
  woolBase(p, BED_RED);
  for (let x = 0; x < TS; x++) {
    for (const y of [22, 23]) { p.set(x, y, jit(p, hex(y === 22 ? "#f0eee8" : "#cfccc4"), 0.04)); p.setH(x, y, 0.7); }
    for (let y = 24; y < TS; y++) { p.set(x, y, jit(p, ramp(WOOD_OAK, 0.35 + p.noise(x, y, 4, 8, 330) * 0.5 - (y === 24 ? 0.3 : 0)), 0.04)); p.setH(x, y, y === 24 ? 0.2 : 0.8); }
  }
  p.relief(1.0);
};

// crops (cross quads)
function cropLeaves(p, n, hMin, hMax) {
  const C = pal(["#2e5a1c", "#3a6e24", "#4a8030", "#5c9238"]);
  for (let i = 0; i < n; i++) {
    let x = 2 + p.rand() * 28, y = 31;
    const a = -Math.PI / 2 + (p.rand() - 0.5) * 1.2, L = hMin + p.ri(hMax - hMin);
    for (let k = 0; k < L; k++) {
      p.set(x, y, jit(p, ramp(C, 0.2 + 0.7 * k / L), 0.05));
      if (k > 2 && k % 3 === 0) p.set(x + (a < -1.57 ? -1 : 1), y, jit(p, C[3], 0.05));
      x += Math.cos(a + k * 0.02); y += Math.sin(a);
    }
  }
}
T.carrots = p => {
  p.clear(); cropLeaves(p, 14, 10, 20);
  for (const x0 of [5, 15, 25]) for (let y = 28; y <= 31; y++) for (let x = x0 - 2; x <= x0 + 1; x++) p.set(x, y, jit(p, hex(y === 28 ? "#f0a040" : "#d8781e"), 0.05));
};
T.potatoes = p => {
  p.clear(); cropLeaves(p, 16, 8, 16);
  for (const x0 of [6, 16, 26]) for (let y = 28; y <= 31; y++) for (let x = x0 - 2; x <= x0 + 2; x++) if (Math.hypot(x - x0, (y - 30) * 1.4) <= 2.6) p.set(x, y, jit(p, hex(x < x0 ? "#d4b46a" : "#a88a48"), 0.05));
};
T.beetroots = p => {
  p.clear(); cropLeaves(p, 12, 8, 16);
  for (let i = 0; i < 6; i++) { const x = 4 + p.ri(24); for (let y = 20 + p.ri(4); y < 30; y++) p.set(x, y, jit(p, hex("#8a1e2e"), 0.05)); } // red stems
  for (const x0 of [8, 22]) for (let y = 27; y <= 31; y++) for (let x = x0 - 3; x <= x0 + 3; x++) if (Math.hypot(x - x0, (y - 30) * 1.2) <= 3) p.set(x, y, jit(p, hex(x < x0 ? "#b8323e" : "#8a1e2e"), 0.05));
};

// young crops: short sprouts
function sprouts(p, cols, n, hMin, hMax, extra) {
  p.clear();
  const C = pal(cols);
  for (let i = 0; i < n; i++) {
    const x0 = 2 + Math.floor(i * 28 / n) + p.ri(3), L = hMin + p.ri(hMax - hMin + 1), lean = (p.rand() - 0.5) * 0.5;
    let x = x0;
    for (let k = 0; k < L; k++) { p.set(x, 31 - k, jit(p, ramp(C, 0.2 + 0.7 * k / L), 0.05)); x += lean; }
    if (extra) extra(p, Math.round(x), 31 - L, C);
  }
}
const leafPair = (p, x, y, C) => { p.set(x - 1, y + 1, C[3]); p.set(x - 2, y + 1, C[2]); p.set(x + 1, y + 1, C[3]); p.set(x + 2, y, C[2]); };
T.wheat_young = p => sprouts(p, ["#4a8030", "#5c9238", "#74a842", "#8ab84e"], 9, 5, 9);
T.carrots_young = p => sprouts(p, ["#2e5a1c", "#3a6e24", "#4a8030", "#5c9238"], 6, 4, 7, (p, x, y, C) => { leafPair(p, x, y, C); p.set(x, y - 1, C[3]); });
T.potatoes_young = p => sprouts(p, ["#2e5a1c", "#3a6e24", "#4a8030", "#5c9238"], 5, 3, 6, (p, x, y, C) => { for (let dy = 0; dy < 2; dy++) for (let dx = -2; dx <= 2; dx++) p.set(x + dx, y + dy, jit(p, C[2 + (dx + dy & 1)], 0.05)); });
T.beetroots_young = p => sprouts(p, ["#8a1e2e", "#7a3a2a", "#4a8030", "#5c9238"], 6, 4, 7, leafPair);

// misc tiles for audit fixes
T.sandstone_bottom = p => { sandBase(p, SANDSTONE, false); for (let i = 0; i < 40; i++) { const x = p.ri(TS), y = p.ri(TS); p.set(x, y, mul(p.get(x, y), 0.82)); p.setH(x, y, 0); } p.relief(1.0); };
// terracotta & misc ground
for (const [n, c] of [["terracotta", "#9a5a40"], ["orange_terracotta", "#a0531c"], ["yellow_terracotta", "#b8852a"], ["white_terracotta", "#d0b2a2"], ["brown_terracotta", "#4d3324"], ["red_terracotta", "#8f3d2e"]]) {
  T[n] = p => {
    const b = hex(c);
    p.fill((x, y) => {
      const f = p.fbm(x, y, 3, 4, 300), band = p.noise(x, y, 1, 6, 301);
      p.set(x, y, jit(p, mul(b, 0.86 + f * 0.18 + band * 0.06), 0.05)); p.setH(x, y, f * 0.5);
    });
    for (let i = 0; i < 8; i++) p.set(p.ri(TS), p.ri(TS), mul(b, p.rand() < 0.5 ? 0.85 : 1.1));
    p.relief(0.6);
  };
}
T.mushroom_stem = p => {
  const C = pal(["#aea794", "#bfb8a6", "#cec8b8", "#dad5c8", "#e5e1d6"]);
  p.fill((x, y) => {
    const f = p.noise(x, y, 8, 1, 310) * 0.6 + p.noise(x, y, 16, 2, 311) * 0.4;
    p.set(x, y, jit(p, ramp(C, f * 0.8 + 0.1), 0.03)); p.setH(x, y, f * 0.6);
  });
  p.relief(1.0);
};
T.red_mushroom_block = p => {
  smoothBase(p, ["#861814", "#9c201a", "#ae2820", "#bc3128", "#c63c30"], 0.5);
  for (const [cx, cy, r] of [[6, 6, 3.4], [22, 4, 2.6], [16, 16, 4.2], [4, 22, 3], [26, 24, 3.4], [12, 28, 2.2], [27, 13, 2]])
    dome(p, cx, cy, r, r * 0.9, hex("#ece6da"), 0.6, 0.4, 0.04);
  p.relief(1.2);
};
T.brown_mushroom_block = p => {
  smoothBase(p, ["#664a34", "#74563c", "#826146", "#8d6b4f", "#98775a"], 0.6);
  for (let i = 0; i < 12; i++) dome(p, p.ri(TS), p.ri(TS), 1.5 + p.rand() * 2, 1.2 + p.rand() * 1.5, hex(p.rand() < 0.5 ? "#7a5a40" : "#9a7a5c"), 0.5, 0.2);
  p.relief(1.0);
};
T.mud = p => {
  smoothBase(p, ["#2f2a26", "#38322d", "#413a34", "#4a423b", "#544b43"], 1.0);
  p.relief(1.4);
  p.fill((x, y) => { if (p.H(x - 1, y - 1) - p.H(x + 1, y + 1) > 0.12 && p.rand() < 0.5) p.blend(x, y, hex("#7c7a78"), 0.35); }); // wet sheen
};
T.calcite = p => {
  smoothBase(p, ["#cbcbc6", "#d6d6d1", "#dfdfdb", "#e8e8e4", "#f1f1ed"], 0.5);
  for (let i = 0; i < 9; i++) dome(p, p.ri(TS), p.ri(TS), 0.9 + p.rand(), 0.7 + p.rand() * 0.6, hex("#a8a8a2"), 0.3, 0.2, 0.06);
  p.relief(0.8);
};

// ---------- plants (cross quads, transparent background) ----------
function stalk(p, x0, h, cols, lean = 0, width = 1) {
  let x = x0;
  for (let k = 0; k < h; k++) {
    const y = 31 - k, t = k / h;
    for (let w = 0; w < width; w++) { p.set(x + w, y, jit(p, mul(ramp(cols, 0.15 + t * 0.8), w ? 0.85 : 1), 0.05)); }
    x += lean * (0.4 + t);
    if (x < 0 || x > 31) break;
  }
}
T.short_grass = p => {
  p.clear();
  for (let i = 0; i < 26; i++) stalk(p, 1 + p.rand() * 29, 10 + p.ri(18), GRASS_N, (p.rand() - 0.5) * 0.45, p.rand() < 0.4 ? 2 : 1);
};
T.fern = p => {
  p.clear();
  const C = GRASS_N;
  const fronds = [[-1.57, 26, 0], [-1.95, 22, -1], [-1.2, 22, 1], [-2.35, 17, -1], [-0.8, 17, 1], [-2.7, 12, -1], [-0.45, 12, 1]];
  for (const [ang, len, side] of fronds) {
    let x = 15.5, y = 31.5;
    for (let k = 0; k < len; k++) {
      const t = k / len, a = ang + side * t * t * 0.9; // arch outward and droop
      x += Math.cos(a) * 0.9; y += Math.sin(a) * 0.9;
      p.set(x, y, jit(p, ramp(C, 0.15 + 0.25 * t), 0.05));
      if (k > 2 && k % 2 === 0) {
        const L = Math.max(1, Math.round((1 - t) * 4 + 0.5));
        for (const sg of [-1, 1]) for (let s2 = 1; s2 <= L; s2++) {
          const la = a + sg * 1.15;
          p.set(x + Math.cos(la) * s2, y + Math.sin(la) * s2 + s2 * 0.3, jit(p, ramp(C, 0.4 + 0.5 * (s2 / L)), 0.05));
        }
      }
    }
  }
};
T.dead_bush = p => {
  p.clear();
  const C = pal(["#5a3e1e", "#6e4e28", "#7e5c32", "#8e6a3c"]);
  const branch = (x, y, a, n, depth) => {
    for (let k = 0; k < n; k++) {
      p.set(x, y, jit(p, ramp(C, p.rand()), 0.05));
      x += Math.cos(a); y += Math.sin(a); a += (p.rand() - 0.5) * 0.4;
      if (y < 1 || x < 0 || x > 31) return;
      if (depth < 3 && k > 2 && p.rand() < 0.22) branch(x, y, a + (p.rand() < 0.5 ? -0.7 : 0.7), Math.floor(n * 0.6), depth + 1);
    }
  };
  branch(15, 31, -1.57, 18, 0); branch(15, 31, -2.2, 14, 0); branch(16, 31, -0.9, 14, 0); branch(15, 31, -1.3, 12, 1);
};
function flowerSprite(p, petals, center, kind, stemH) {
  p.clear();
  const st = pal(["#2e5a1c", "#3a6e24", "#4a8030"]);
  const top = 31 - stemH;
  for (let y = 31; y > top; y--) { p.set(15, y, jit(p, st[1], 0.05)); p.set(16, y, jit(p, st[0], 0.05)); }
  for (const [lx, ly, d] of [[14, 26, -1], [17, 24, 1]]) for (let k = 0; k < 4; k++) { p.set(lx + d * k, ly - (k >> 1), jit(p, st[2], 0.05)); p.set(lx + d * k, ly - (k >> 1) + 1, jit(p, st[1], 0.05)); }
  const P = pal(petals), C = hex(center), cy = top - 3;
  if (kind === "cup") {
    for (let y = cy - 4; y <= cy + 3; y++) for (let x = 10; x <= 21; x++) {
      const dx = (x - 15.5) / 5.5, dy = (y - cy) / 4.2;
      if (dx * dx + dy * dy > 1) continue;
      p.set(x, y, jit(p, ramp(P, 0.85 - (dx + dy) * 0.35 - (y > cy + 1 ? 0.3 : 0)), 0.04));
    }
    for (let y = cy - 1; y <= cy; y++) for (let x = 15; x <= 16; x++) p.set(x, y, C);
  } else if (kind === "ball") {
    for (let y = cy - 4; y <= cy + 2; y++) for (let x = 11; x <= 20; x++) {
      const d = Math.hypot((x - 15.5) / 4.5, (y - cy + 1) / 3.6);
      if (d > 1) continue;
      p.set(x, y, jit(p, ramp(P, (x + y) % 3 ? 0.75 - d * 0.3 : 0.35), 0.05));
    }
  } else {
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      for (let s = 1; s <= 4; s++) p.set(15.5 + Math.cos(a) * s, cy + Math.sin(a) * s * 0.8, jit(p, ramp(P, 0.9 - s * 0.15), 0.05));
    }
    p.set(15, cy, C); p.set(16, cy, C);
  }
}
T.poppy = p => flowerSprite(p, ["#6e1410", "#a01e18", "#c8302a", "#de4a3c"], "#1e1c12", "cup", 12);
T.dandelion = p => flowerSprite(p, ["#b08414", "#d4a828", "#ecc840", "#f8e070"], "#d4a828", "ball", 10);
T.cornflower = p => flowerSprite(p, ["#22357e", "#3352b0", "#4a6ed8", "#7a96ea"], "#e8e0a0", "star", 14);
function mushroomSprite(p, cap, spots) {
  p.clear();
  const stem = pal(["#a89e88", "#cfc6b0", "#e6dfcc"]), C = pal(cap);
  for (let y = 20; y <= 31; y++) for (let x = 13; x <= 18; x++) p.set(x, y, jit(p, ramp(stem, x < 15 ? 1 : x > 16 ? 0 : 0.6), 0.04));
  for (let y = 10; y <= 21; y++) for (let x = 5; x <= 26; x++) {
    const dx = (x - 15.5) / 10.5, dy = (y - 21) / 11;
    if (dx * dx + dy * dy > 1 || y > 21) continue;
    p.set(x, y, jit(p, ramp(C, 0.85 - dx * 0.3 + dy * 0.4 - (y === 21 ? 0.4 : 0)), 0.04));
  }
  if (spots) for (const [x, y] of [[11, 14], [18, 12], [21, 17], [8, 18], [15, 17]]) { p.set(x, y, hex("#f2ece0")); p.set(x + 1, y, hex("#dcd4c4")); p.set(x, y + 1, hex("#dcd4c4")); }
}
T.red_mushroom = p => mushroomSprite(p, ["#6a1410", "#9a2018", "#c0302a", "#d8483e"], true);
T.brown_mushroom = p => mushroomSprite(p, ["#4e3624", "#6e4e36", "#8a6648", "#a07c5c"], false);
T.sugar_cane = p => {
  p.clear();
  const C = pal(["#4f8a2e", "#6aa83c", "#88c058", "#a2d472"]), node = hex("#3e6e24");
  for (const x0 of [4, 14, 24]) {
    const off = p.ri(8);
    for (let y = 0; y < TS; y++) {
      const isNode = (y + off) % 10 === 0;
      for (let w = 0; w < 3; w++) p.set(x0 + w, y, isNode ? node : jit(p, ramp(C, w === 0 ? 0.85 : w === 1 ? 0.55 : 0.2), 0.04));
    }
    const ly = 6 + p.ri(16);
    for (let k = 0; k < 5; k++) { p.set(x0 + 3 + k, ly - k * 0.6, jit(p, C[2], 0.05)); p.set(x0 - 1 - k, ly + 6 - k * 0.6, jit(p, C[1], 0.05)); }
  }
};
T.wheat = p => {
  p.clear();
  const stalkC = pal(["#6e7a20", "#8a8c2a", "#a29a34"]), grain = pal(["#a8822a", "#c49e3a", "#d8b852", "#ead070"]);
  for (let i = 0; i < 9; i++) {
    let x = 1 + i * 3.5 + p.rand() * 1.5;
    const top = 2 + p.ri(7), head = 8 + p.ri(3);
    for (let y = 31; y >= top; y--) {
      if (y < top + head) {
        p.set(x, y, jit(p, ramp(grain, (y % 2 ? 0.8 : 0.4)), 0.05));
        if (y > top && y < top + head - 1) p.set(x + 1, y, jit(p, ramp(grain, (y % 2 ? 0.3 : 0.65)), 0.05));
      } else p.set(x, y, jit(p, ramp(stalkC, p.rand()), 0.05));
      if (y > top + head && p.rand() < 0.08) x += p.rand() < 0.5 ? -1 : 1;
    }
  }
};

// Fallback: a noisy tile in the block's colour (keeps unknown tile names usable).
function fallback(p, color) { smoothBase(p, [color || "#ff00ff", color || "#ff00ff"], 0.4); p.fill((x, y) => p.scale(x, y, 0.9 + p.fbm(x, y, 4, 3, 999) * 0.2)); }

// Tiles that are sprites (plants etc.): padded by edge clamping instead of wrapping.
const EXTRA_TILES = ["grass_side_overlay", "bed_pillow"];
const SPRITE_TILES = new Set(["wheat", "bell", "lantern", "oak_fence", "grass_side_overlay", "carrots", "potatoes", "beetroots", "wheat_young", "carrots_young", "potatoes_young", "beetroots_young"]);

// ---------- atlas + mipmaps ----------
// Float tile -> chain of tiles 32,16,8,4,2,1 (premultiplied box filter; cutout tiles keep their alpha coverage).
function tileMips(f, cutout) {
  // bleed colour into transparent texels so filtering never pulls in black
  if (cutout) {
    const has = new Uint8Array(TS * TS);
    for (let i = 0; i < TS * TS; i++) has[i] = f[i * 4 + 3] >= 128 ? 1 : 0;
    for (let it = 0; it < 6; it++) {
      const add = [];
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        const i = y * TS + x;
        if (has[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = (((y + dy + TS) % TS) * TS + ((x + dx + TS) % TS));
          if (has[j]) { r += f[j * 4]; g += f[j * 4 + 1]; b += f[j * 4 + 2]; n++; }
        }
        if (n) add.push([i, r / n, g / n, b / n]);
      }
      for (const [i, r, g, b] of add) { f[i * 4] = r; f[i * 4 + 1] = g; f[i * 4 + 2] = b; has[i] = 1; }
    }
  }
  const cov = a => { let c = 0; for (let i = 3; i < a.length; i += 4) if (a[i] >= 127.5) c++; return c / (a.length / 4); };
  const target = cutout ? cov(f) : 0;
  const out = [f];
  let cur = f, w = TS;
  while (w > 1) {
    const nw = w >> 1, d = new Float32Array(nw * nw * 4);
    for (let y = 0; y < nw; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, rr = 0, gg = 0, bb = 0;
      for (let k = 0; k < 4; k++) {
        const i = ((y * 2 + (k >> 1)) * w + x * 2 + (k & 1)) * 4, al = cur[i + 3];
        r += cur[i] * al; g += cur[i + 1] * al; b += cur[i + 2] * al; a += al;
        rr += cur[i]; gg += cur[i + 1]; bb += cur[i + 2];
      }
      const o = (y * nw + x) * 4;
      if (a > 0) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; } else { d[o] = rr / 4; d[o + 1] = gg / 4; d[o + 2] = bb / 4; }
      d[o + 3] = a / 4;
    }
    if (cutout && target > 0) { // scale alpha so the alpha-tested coverage matches level 0
      let lo = 0.5, hi = 4;
      const covAt = s => { let c = 0; for (let i = 3; i < d.length; i += 4) if (d[i] * s >= 127.5) c++; return c / (d.length / 4); };
      for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; if (covAt(m) < target) lo = m; else hi = m; }
      for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * hi);
    }
    out.push(d); cur = d; w = nw;
  }
  return out;
}
// One atlas cell at level k from a tile's mip chain. wrapX/wrapY pick wrapped or clamped padding.
function cellData(mips, k, wrapX, wrapY) {
  const cs = CELL >> k, out = new Uint8ClampedArray(cs * cs * 4);
  const lvl = Math.min(k, 5), ts = TS >> lvl, src = mips[lvl], off = OFF >> k;
  for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) {
    let tx = 0, ty = 0;
    if (ts > 1 && k <= 4) {
      tx = x - off; ty = y - off;
      tx = wrapX ? ((tx % ts) + ts) % ts : Math.max(0, Math.min(ts - 1, tx));
      ty = wrapY ? ((ty % ts) + ts) % ts : Math.max(0, Math.min(ts - 1, ty));
    }
    const i = (ty * ts + tx) * 4, o = (y * cs + x) * 4;
    out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3];
  }
  return out;
}
function boxDown(src, sw, sh) {
  const dw = Math.max(1, sw >> 1), dh = Math.max(1, sh >> 1), d = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const sx = Math.min(sw - 1, x * 2 + (k & 1)), sy = Math.min(sh - 1, y * 2 + (k >> 1));
      s += src[(sy * sw + sx) * 4 + c];
    }
    d[(y * dw + x) * 4 + c] = s / 4;
  }
  return { d, w: dw, h: dh };
}
const tileInfo = new Map(); // name -> {mips, wrapX, wrapY, cutout}
function paintTile(name, color, paintFn) {
  const p = new Px(name);
  for (let i = 3; i < p.c.length; i += 4) p.c[i] = 255;
  (paintFn || T[name] || (q => fallback(q, color)))(p);
  const f = p.c;
  const fa = BF.faithful && BF.faithful[name];
  if (fa && !paintFn) { // Faithful 32x override (raw RGBA), see FAITHFUL-LICENSE.txt
    const raw = atob(fa);
    // grass tiles are grey in Faithful and tinted by the game; foliage tiles are not overridden (original leaves kept)
    const gain = TINTED.grass.includes(name) ? 0.95 : 1;
    for (let i = 0; i < f.length; i++) f[i] = (i & 3) === 3 ? raw.charCodeAt(i) : raw.charCodeAt(i) * gain;
  }
  for (let i = 0; i < f.length; i++) f[i] = Math.max(0, Math.min(255, f[i]));
  let cutout = false;
  for (let i = 3; i < f.length; i += 4) if (f[i] < 128) { cutout = true; break; }
  return { f, cutout };
}
function padMode(name) {
  if (SPRITE_TILES.has(name) || crossTiles.has(name)) return [false, false];
  if (/_side$|_front$|_overlay$/.test(name)) return [true, false];
  return [true, true];
}
const crossTiles = new Set();

function drawAtlas() {
  if (atlasH) return;
  const names = [], colorOf = {};
  for (const b of BF.blocks) if (b && b.tiles) for (const k of ["top", "side", "bottom", "front", "icon"]) {
    const n = k === "icon" ? b.icon : b.tiles[k];
    if (b.render === "cross") crossTiles.add(n);
    if (n && !(n in colorOf)) { names.push(n); colorOf[n] = b.color; }
  }
  for (const n of EXTRA_TILES) if (!(n in colorOf)) { names.push(n); colorOf[n] = "#7a8a6a"; }
  const rows = Math.max(1, Math.ceil(names.length / PER_ROW));
  atlasH = CELL; while (atlasH < rows * CELL) atlasH *= 2;
  if (atlasH > 4096) console.warn("texture atlas is " + atlasH + "px tall (" + names.length + " tiles); widen ATLAS_W");
  const levels = [];
  for (let k = 0; k < MIP_CELL_LEVELS; k++) levels.push(new Uint8ClampedArray((atlasW >> k) * (atlasH >> k) * 4));
  names.forEach((n, i) => {
    const { f, cutout } = paintTile(n, colorOf[n]);
    const img = new ImageData(TS, TS);
    for (let j = 0; j < f.length; j++) img.data[j] = f[j];
    tileData.set(n, img);
    index.set(n, i);
    const [wx, wy] = padMode(n);
    const mips = tileMips(f, cutout);
    tileInfo.set(n, { wrapX: wx, wrapY: wy, cutout });
    const cx = i % PER_ROW, cy = Math.floor(i / PER_ROW);
    for (let k = 0; k < MIP_CELL_LEVELS; k++) {
      const cs = CELL >> k, W = atlasW >> k, cd = cellData(mips, k, wx, wy);
      for (let y = 0; y < cs; y++) levels[k].set(cd.subarray(y * cs * 4, (y + 1) * cs * 4), ((cy * cs + y) * W + cx * cs) * 4);
    }
  });
  const imgs = levels.map((d, k) => new ImageData(d, atlasW >> k, atlasH >> k));
  let w = atlasW >> (MIP_CELL_LEVELS - 1), h = atlasH >> (MIP_CELL_LEVELS - 1), cur = levels[MIP_CELL_LEVELS - 1];
  while (w > 1 || h > 1) { const r = boxDown(cur, w, h); imgs.push(new ImageData(r.d, r.w, r.h)); cur = r.d; w = r.w; h = r.h; }
  drawAtlas.levels = imgs;
  canvas = document.createElement("canvas");
  canvas.width = atlasW; canvas.height = atlasH;
  canvas.getContext("2d").putImageData(imgs[0], 0, 0);
}

function build() {
  if (built) return built;
  drawAtlas();
  const lv = drawAtlas.levels;
  const texture = new THREE.Texture(lv[0]);
  texture.mipmaps = lv;
  texture.generateMipmaps = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  try { texture.anisotropy = BF.renderer ? BF.renderer.capabilities.getMaxAnisotropy() : 1; } catch (_) {}
  texture.needsUpdate = true;
  built = { texture, canvas };
  return built;
}

function uv(name) {
  drawAtlas();
  const i = index.has(name) ? index.get(name) : 0;
  const x0 = (i % PER_ROW) * CELL + OFF, y0 = Math.floor(i / PER_ROW) * CELL + OFF;
  return [x0 / atlasW, 1 - (y0 + TS) / atlasH, (x0 + TS) / atlasW, 1 - y0 / atlasH];
}
function has(name) { drawAtlas(); return index.has(name); }

// ---------- water animation ----------
let water = null;
function initWater() {
  if (!index.has("water")) return null;
  const frames = [];
  const [wx, wy] = padMode("water");
  for (let f = 0; f < WATER_FRAMES; f++) {
    const { f: data } = paintTile("water", null, p => waterPaint(p, f, WATER_FRAMES));
    const mips = tileMips(data, false);
    const lv = [];
    for (let k = 0; k < MIP_CELL_LEVELS; k++) lv.push(new Uint8Array(cellData(mips, k, wx, wy).buffer));
    frames.push(lv);
  }
  const srcs = [];
  for (let k = 0; k < MIP_CELL_LEVELS; k++) srcs.push(new THREE.DataTexture(frames[0][k], CELL >> k, CELL >> k));
  return { frames, srcs, t: 0, cur: 0, pos: new THREE.Vector2() };
}
function update(dt) {
  if (!built || !BF.renderer || !BF.renderer.copyTextureToTexture) return;
  if (water === null) water = initWater() || false;
  if (!water) return;
  water.t += Math.max(0, dt || 0);
  const f = Math.floor(water.t * 6) % WATER_FRAMES;
  if (f === water.cur) return;
  water.cur = f;
  const i = index.get("water"), cx = i % PER_ROW, cy = Math.floor(i / PER_ROW);
  for (let k = 0; k < MIP_CELL_LEVELS; k++) {
    const cs = CELL >> k, src = water.srcs[k];
    src.image.data = water.frames[f][k];
    water.pos.set(cx * cs, (atlasH >> k) - (cy + 1) * cs);
    BF.renderer.copyTextureToTexture(water.pos, src, built.texture, k);
  }
}

// ---------- icons ----------
const ICON = 64;
function tileCanvas(name) {
  drawAtlas();
  const c = document.createElement("canvas"); c.width = c.height = TS;
  const src = tileData.get(name);
  if (src) {
    const img = new ImageData(new Uint8ClampedArray(src.data), TS, TS), t = tintOf(name);
    if (t) for (let i = 0; i < img.data.length; i += 4) { img.data[i] *= t[0]; img.data[i + 1] *= t[1]; img.data[i + 2] *= t[2]; }
    c.getContext("2d").putImageData(img, 0, 0);
  }
  return c;
}
function shadedFace(img, dark) {
  const c = document.createElement("canvas"); c.width = c.height = TS;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  if (dark) {
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = `rgba(0,0,0,${dark})`;
    g.fillRect(0, 0, TS, TS);
  }
  return c;
}
function iconTileCanvas(name) {
  const { f } = paintTile("icon:" + name, null, ICON_T[name]);
  const img = new ImageData(TS, TS);
  for (let j = 0; j < f.length; j++) img.data[j] = f[j];
  const c = document.createElement("canvas"); c.width = c.height = TS;
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}
function flatIcon(src) {
  const c = document.createElement("canvas"); c.width = c.height = ICON;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, ICON, ICON);
  return c.toDataURL();
}
// Slab / stairs icons: the isometric cube squashed to a half-height slab; stairs add a half-depth, half-height step on the far side.
function shapeIcon(g, c, top, side, front, sh) {
  const T = TS, H = T / 2, up = sh.top; // up: top-half (upside-down) variant
  const fr = shadedFace(front, 0.22), sd = shadedFace(side, 0.4);
  const draw = (img, a, bb, cc, d, e, f, sx, sy, sw, shh) => { g.setTransform(a, bb, cc, d, e, f); g.drawImage(img, sx, sy, sw, shh, 0, 0, T, T); };
  const slab = () => {
    const o = up ? 0 : 15; // bottom slab sits 15px lower in the icon than the cube top
    draw(fr, 28 / T, 14 / T, 0, 15 / T, 4, 18 + o, 0, up ? 0 : H, T, H);
    draw(sd, 28 / T, -14 / T, 0, 15 / T, 32, 32 + o, 0, up ? 0 : H, T, H);
    draw(top, 28 / T, -14 / T, 28 / T, 14 / T, 4, 18 + o, 0, 0, T, T);
  };
  const step = () => { // back half (u 0.5..1), upper half of the cube for bottom stairs, lower half for top stairs
    const o = up ? 15 : 0;
    draw(fr, 28 / T, 14 / T, 0, 15 / T, 18, 11 + o, 0, up ? H : 0, T, H);
    draw(sd, 14 / T, -7 / T, 0, 15 / T, 46, 25 + o, H, up ? H : 0, H, H);
    if (!up) draw(top, 14 / T, -7 / T, 28 / T, 14 / T, 18, 11, H, 0, H, T);
  };
  if (sh.kind === "stairs" && up) { step(); slab(); } else { slab(); if (sh.kind === "stairs") step(); }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return c.toDataURL();
}
// Blocks whose icon is a flat picture rather than an isometric cube; the held view model draws these flat too (js/player.js).
const iconIsFlat = b => !!(b && b.isBlock !== false && b.tiles && (b.icon || ICON_T[b.name] || b.render === "cross"));
function blockIcon(b) {
  if (b.icon) return flatIcon(tileCanvas(b.icon));
  if (ICON_T[b.name]) return flatIcon(iconTileCanvas(b.name));
  if (b.render === "cross") return flatIcon(tileCanvas(b.tiles.side));
  const c = document.createElement("canvas"); c.width = c.height = ICON;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  const top = tileCanvas(b.tiles.top), side = tileCanvas(b.tiles.side), front = tileCanvas(b.tiles.front || b.tiles.side);
  if (b.shape) return shapeIcon(g, c, top, side, front, b.shape);
  // isometric cube: top rhombus (4,18)-(32,4)-(60,18)-(32,32), sides 30px tall; left face = front
  const faces = [
    [shadedFace(front, 0.22), 28 / TS, 14 / TS, 0, 30 / TS, 4, 18],
    [shadedFace(side, 0.4), 28 / TS, -14 / TS, 0, 30 / TS, 32, 32],
    [top, 28 / TS, -14 / TS, 28 / TS, 14 / TS, 4, 18],
  ];
  for (const [img, a, bb, cc, d, e, f] of faces) { g.setTransform(a, bb, cc, d, e, f); g.drawImage(img, 0, 0); }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return c.toDataURL();
}

// Item sprites: a 16x16 colour grid with a dark 1px outline drawn around the shape, scaled to the icon size.
const spriteGrid = () => Array.from({ length: 16 }, () => new Array(16).fill(null));
function put(G, x, y, c) { if (x >= 0 && y >= 0 && x < 16 && y < 16) G[y][x] = c; }
function stroke(G, x0, y0, x1, y1, c, c2) { // diagonal 1-2px stroke
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
    put(G, x, y, c); if (c2) put(G, x + 1, y, c2);
  }
}
function blob(G, cx, cy, rx, ry, c, hi, hiAmt, tilt = 0) {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const dx = x - cx, dy = y - cy;
    const u = dx * Math.cos(tilt) + dy * Math.sin(tilt), v = -dx * Math.sin(tilt) + dy * Math.cos(tilt);
    if ((u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1) put(G, x, y, hi && dx + dy < -rx * 0.5 ? mix(c, hi, hiAmt) : c);
  }
}
const WOOD = hex("#7a5a30"), WOOD_L = hex("#a8854e");
const lighten = (m, t) => mix(m, WHITE, t);

// Tool heads: the stick runs bottom-left to top-right along x+y = const; s = x-y is the position along it.
const SPRITES = {
  stick(G) { stroke(G, 3, 13, 12, 4, WOOD, WOOD_L); },
  pickaxe(G, m) {
    const cx = 1.5, cy = 14.5;
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (x >= 2 && y <= 13 && r >= 10.1 && r <= 12.9) put(G, x, y, r > 12 ? lighten(m, 0.35) : r < 11 ? mul(m, 0.78) : m);
    }
    stroke(G, 2, 13, 8, 7, WOOD, WOOD_L);
  },
  axe(G, m) {
    // fan-shaped blade on the upper-left of the handle's top end, widening away from it
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
      const d = 15 - (x + y), sAlong = x - y;
      if (d < 0 || d > 8) continue;
      const half = 1.6 + d * 0.38;
      if (Math.abs(sAlong - 5) <= half) put(G, x, y, d >= 7 ? lighten(m, 0.4) : d <= 1 ? mul(m, 0.75) : m);
    }
    stroke(G, 2, 13, 10, 5, WOOD, WOOD_L);
  },
  shovel(G, m) {
    stroke(G, 2, 13, 7, 8, WOOD, WOOD_L);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
      const s = x - y, c = x + y - 15.5;
      const w = s <= 10 ? 3 : s <= 11 ? 2 : 1;
      if (s >= 3 && s <= 12 && Math.abs(c) <= w) put(G, x, y, c < -1 ? lighten(m, 0.3) : c > 1 ? mul(m, 0.78) : m);
    }
  },
  sword(G, m) {
    for (let i = 0; i <= 8; i++) { put(G, 5 + i, 9 - i, lighten(m, 0.35)); put(G, 5 + i, 10 - i, m); put(G, 6 + i, 10 - i, mul(m, 0.78)); }
    stroke(G, 1, 14, 4, 11, WOOD);
    const guard = hex("#4a3a2a");
    for (let i = -2; i <= 2; i++) put(G, 4 + i, 10 + i, guard);
  },
  bow(G) {
    for (let a = 0; a <= 1.0001; a += 0.04) {
      const bulge = Math.sin(a * Math.PI) * 3.5;
      const x = Math.round(2 + 11 * a + bulge), y = Math.round(13 - 11 * a + bulge);
      put(G, x, y, WOOD); put(G, x + 1, y, WOOD_L);
    }
    stroke(G, 2, 13, 13, 2, hex("#e8e8e8"));
  },
  coal(G, m, p) {
    blob(G, 7.5, 8, 5.2, 4.4, m, hex("#5a5a5a"), 0.6, 0.4);
    for (const [x, y] of [[3, 5], [11, 11], [12, 6], [5, 12]]) put(G, x, y, m);
    for (let i = 0; i < 5; i++) { const x = 4 + p.ri(8), y = 5 + p.ri(6); if (G[y][x]) G[y][x] = hex("#4a4a4a"); }
  },
  diamond(G, m) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x - 7.5), dy = y - 7;
      if (dy < -4 || dy > 6) continue;
      const w = dy < -1 ? 4.5 + (dy + 4) * 0.8 : 7 - (dy + 1) * 1.0;
      if (dx <= w) put(G, x, y, dy < -1 ? lighten(m, 0.45) : x < 8 ? m : mul(m, 0.8));
    }
  },
  ingot(G, m) {
    for (let y = 5; y <= 11; y++) for (let x = 1; x <= 14; x++) {
      const top = y <= 7;
      const left = top ? 2 + (7 - y) : 2, right = top ? 13 - (7 - y) : 13;
      if (x < left || x > right) continue;
      put(G, x, y, top ? lighten(m, 0.35) : m);
    }
  },
  meat(G, m, fat) {
    blob(G, 8, 8, 6, 4.3, m, lighten(m, 1), 0.25, -0.5);
    if (fat) for (let i = 0; i < 7; i++) put(G, 4 + i, 6 + Math.round(i * 0.5), fat);
  },
  drumstick(G, m) {
    blob(G, 6.5, 6.5, 4.5, 4, m, lighten(m, 1), 0.2, 0.8);
    const b = hex("#f0ece0");
    stroke(G, 9, 9, 12, 12, b);
    put(G, 13, 12, b); put(G, 12, 13, b); put(G, 13, 13, b);
  },
  apple(G, m) {
    blob(G, 7.5, 9, 5, 5, m, lighten(m, 1), 0.35);
    put(G, 7, 3, hex("#5a3a1a")); put(G, 8, 2, hex("#5a3a1a"));
    put(G, 9, 3, hex("#4a9a2a")); put(G, 10, 3, hex("#4a9a2a")); put(G, 10, 2, hex("#5aaa3a"));
  },
  bone(G, m) {
    stroke(G, 4, 11, 11, 4, m, m);
    for (const [x, y] of [[2, 11], [3, 12], [4, 13], [3, 10], [2, 12], [11, 2], [12, 3], [13, 4], [12, 5], [12, 2], [13, 3]]) put(G, x, y, m);
  },
  feather(G, m) {
    blob(G, 8.5, 6.5, 6, 2.6, m, null, 0, -Math.PI / 4);
    for (let i = 0; i < 5; i++) put(G, 6 + i * 2 - (i % 2), 9 - i * 2 + (i % 2), mul(m, 0.85));
    stroke(G, 2, 13, 12, 3, hex("#bdbdbd"));
  },
  arrow(G) {
    stroke(G, 3, 12, 11, 4, WOOD_L);
    const h = hex("#9a9a9a");
    put(G, 12, 3, h); put(G, 11, 3, h); put(G, 12, 4, h); put(G, 13, 2, hex("#cfcfcf")); put(G, 10, 3, h); put(G, 12, 5, h);
    const f = hex("#f0f0f0");
    for (const [x, y] of [[2, 12], [3, 13], [2, 13], [1, 14], [4, 13], [2, 11], [1, 12], [3, 14]]) put(G, x, y, f);
  },
  gunpowder(G, m, p) {
    const tones = ["#2e2e2e", "#4a4a4a", "#6a6a6a", "#8a8a8a"].map(hex);
    for (let y = 5; y < 14; y++) for (let x = 2; x < 14; x++)
      if (Math.abs(x - 7.5) <= (y - 4.5) * 0.75 + (p.rand() - 0.5)) put(G, x, y, tones[p.ri(4)]);
  },
  wheat_item(G, m) {
    const st = hex("#8f8a2a");
    for (const [x0, x1] of [[6, 4], [7, 7], [8, 10], [9, 12]]) stroke(G, x0, 14, x1, 7, st);
    for (const cx of [4, 7, 10, 12]) for (let y = 2; y <= 7; y++) {
      put(G, cx, y, (y + cx) % 2 ? lighten(m, 0.3) : m);
      if (y > 2 && y < 7) put(G, cx - 1, y, (y + cx) % 2 ? m : mul(m, 0.8));
    }
    for (let x = 5; x <= 9; x++) put(G, x, 11, hex("#6a5a1a")); // tie
  },
  bread(G, m) {
    blob(G, 8, 9, 6.5, 3.6, m, hex("#e0b060"), 0.5, -0.25);
    for (const x of [5, 8, 11]) { put(G, x, 7 - (x - 8) * 0.25 | 0, hex("#e8c070")); put(G, x + 1, 8 - (x - 8) * 0.25 | 0, mul(m, 0.75)); }
  },
  emerald(G, m) {
    for (let y = 2; y <= 13; y++) for (let x = 0; x < 16; x++) {
      const dy = Math.min(y - 2, 13 - y), half = Math.min(4.5, 1.5 + dy * 1.2);
      if (Math.abs(x - 7.5) <= half) put(G, x, y, y < 5 || x < 6 ? lighten(m, 0.45) : x > 9 ? mul(m, 0.7) : m);
    }
    put(G, 6, 5, WHITE); put(G, 6, 6, lighten(m, 0.7));
  },
  hoe(G, m) {
    stroke(G, 2, 13, 10, 5, WOOD, WOOD_L);
    for (let i = 0; i < 4; i++) { put(G, 8 + i, 2 + i, i === 0 ? lighten(m, 0.35) : m); put(G, 9 + i, 2 + i, mul(m, 0.8)); } // blade
    put(G, 7, 3, lighten(m, 0.3)); put(G, 7, 2, lighten(m, 0.3)); put(G, 8, 1, lighten(m, 0.35)); put(G, 9, 1, m);
  },
  wheat_seeds(G, m) { for (const [x, y] of [[5, 6], [9, 5], [7, 9], [11, 9], [4, 11], [9, 12], [12, 6]]) { put(G, x, y, m); put(G, x + 1, y, lighten(m, 0.3)); put(G, x, y + 1, mul(m, 0.75)); } },
  beetroot_seeds(G, m) { for (const [x, y] of [[5, 6], [9, 5], [7, 9], [11, 10], [4, 11], [10, 13]]) { put(G, x, y, lighten(m, 0.3)); put(G, x + 1, y, m); put(G, x, y + 1, m); put(G, x + 1, y + 1, mul(m, 0.75)); } },
  carrot(G, m) {
    for (let i = 0; i < 9; i++) { const w = i < 2 ? 0 : i < 6 ? 1 : 2; for (let k = -w; k <= w; k++) put(G, 3 + i + k, 13 - i + k, k < 0 ? lighten(m, 0.3) : k > 0 ? mul(m, 0.8) : m); }
    const g = hex("#4a9a2a"); put(G, 12, 3, g); put(G, 13, 2, g); put(G, 13, 4, g); put(G, 14, 3, g); put(G, 11, 2, g); put(G, 14, 5, hex("#3a7a22"));
  },
  potato(G, m) { blob(G, 8, 8.5, 5, 4, m, lighten(m, 1), 0.25, 0.4); for (const [x, y] of [[6, 7], [10, 9], [8, 11]]) put(G, x, y, mul(m, 0.7)); },
  baked_potato(G, m) { blob(G, 8, 8.5, 5.5, 4, m, hex("#f0d070"), 0.35, 0.3); for (let x = 5; x <= 10; x++) put(G, x, 8 - ((x - 5) >> 2), hex("#f4e4a0")); },
  beetroot(G, m) {
    blob(G, 8, 10, 4.2, 4, m, lighten(m, 1), 0.25);
    put(G, 8, 15, mul(m, 0.7));
    const g = hex("#4a8a2a"); stroke(G, 7, 6, 5, 2, g); stroke(G, 9, 6, 11, 2, g); stroke(G, 8, 6, 8, 1, hex("#5a9a34"));
  },
  oak_door(G, m) {
    for (let y = 1; y <= 14; y++) for (let x = 4; x <= 11; x++) {
      const e = Math.min(x - 4, y - 1, 11 - x, 14 - y), win = y >= 3 && y <= 6 && x >= 6 && x <= 9 && x !== 7 && y !== 4;
      put(G, x, y, win ? hex("#3a2c1c") : e === 0 ? mul(m, 0.7) : (x + y) % 5 === 0 ? mul(m, 0.88) : m);
    }
    put(G, 10, 9, hex("#5a5a64"));
  },
  red_bed(G, m) {
    for (let x = 1; x <= 14; x++) for (let y = 6; y <= 10; y++) put(G, x, y, y >= 9 ? WOOD_L : x <= 4 && y <= 7 ? hex("#f0f0ec") : y === 6 ? lighten(m, 0.25) : m);
    for (const x of [1, 14]) { put(G, x, 11, WOOD); put(G, x, 12, WOOD); }
  },
  string(G, m) {
    for (let x = 2; x <= 13; x++) put(G, x, Math.round(7 + Math.sin(x * 0.9) * 2.2), m);
    for (let x = 3; x <= 12; x++) put(G, x, Math.round(10 + Math.sin(x * 0.9 + 2) * 2), m);
  },
};
function renderGrid(G, outline = true) {
  const c = document.createElement("canvas"); c.width = c.height = ICON;
  const g = c.getContext("2d");
  const s = ICON / 16;
  const at = (x, y) => (x >= 0 && y >= 0 && x < 16 && y < 16 ? G[y][x] : null);
  const draw = (x, y, col) => { g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`; g.fillRect(x * s, y * s, s, s); };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const col = G[y][x];
    if (col) { draw(x, y, col); continue; }
    if (!outline) continue;
    const n = at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
    if (n) draw(x, y, mul(n, 0.32));
  }
  return c.toDataURL();
}
function itemIcon(it) {
  const G = spriteGrid();
  const m = hex(it.color || "#ff00ff");
  const p = new Px(it.name);
  const n = it.sprite || it.name;
  let outline = true;
  if (it.tool && SPRITES[it.tool.type]) SPRITES[it.tool.type](G, m);
  else if (n.endsWith("_ingot")) SPRITES.ingot(G, m);
  else if (SPRITES[n]) { SPRITES[n](G, m, p);  }
  else if (n.includes("chicken")) SPRITES.drumstick(G, m);
  else if (n === "rotten_flesh") {
    SPRITES.meat(G, m);
    for (let i = 0; i < 9; i++) { const x = 3 + p.ri(10), y = 5 + p.ri(6); if (G[y][x]) G[y][x] = hex(p.rand() < 0.5 ? "#6a8a3a" : "#4a3a2a"); }
  } else if (it.food) SPRITES.meat(G, m, n.startsWith("raw_") ? hex("#f4e4dc") : mix(m, [255, 230, 200], 0.4));
  else blob(G, 7.5, 7.5, 5.5, 5.5, m, WHITE, 0.15);
  return renderGrid(G, outline);
}


function icon(itemId) {
  const it0 = BF.items[itemId];
  if (it0 && (it0.map || it0.auto) && BF.mapIcon) { const r = BF.mapIcon(it0); if (r && r.url) return r.url; }   // filled maps: a thumbnail of the map itself (js/mapview.js), regenerated as it fills in
  if (iconCache.has(itemId)) return iconCache.get(itemId);
  const it = BF.items[itemId];
  let url;
  if (!it) { const G = spriteGrid(); blob(G, 7.5, 7.5, 5, 5, [255, 0, 255]); url = renderGrid(G); }
  else if (it.isBlock && it.tiles) url = blockIcon(it);
  else url = itemIcon(it);
  iconCache.set(itemId, url);
  return url;
}

// Painter kit for extra tile packs (js/textures-stone.js etc.): add painters to T / ICON_T / SPRITES at load time.
BF.texKit = { T, ICON_T, SPRITES, TS, Px, hex, pal, mul, mix, ramp, clamp01, smooth, jit, dome, voronoi, ihash, WHITE, lighten,
  put, stroke, blob, stoneBase, cobbleBase, mossOver, sandBase, bricks, smoothBase, frame, planksBase, grassBlades, STONE, SAND, RED_SAND, SANDSTONE, SNOW, MOSS, WOOD_OAK,
  woolBase, barkSide, logTop, SPRITE_TILES, WOOD_SPRUCE, WOOD_ACACIA };
BF.textures = { build, uv, icon, iconIsFlat, has, update, tinted: TINTED, defaultTint: DEFAULT_TINT, TILE: TS };
})();
