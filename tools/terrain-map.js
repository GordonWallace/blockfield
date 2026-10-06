// Top-down overview map of the terrain generator, rendered in node (no browser needed).
// Usage: node tools/terrain-map.js out.png seed biomeScale centreX centreZ spanBlocks pixels [gen]
//   e.g. node tools/terrain-map.js /tmp/map.png 1337 2 0 0 30000 700 3
// Colours are biomes, shaded by height; rivers are drawn thicker than they are when RV=<blocks> is set (e.g. RV=14).
// Env: ELEV=1 draws an elevation (hypsometric) map instead of biome colours (gen 3: bands 0/100/500/900/1400/2000, plateaus stand out);
//      Q=<n> quantizes to an n-colour palette PNG (default 48; Q=0 for full colour) to keep files small;
//      HS=<k> hill-shade strength multiplier (default 1); EL=1 tints land above the plateau threshold.
// Generator 3 uses BF.setLimits(gen) (MIN_Y -64, H 3072, SEA 0); heights, the ocean-depth tint and the shading scale with the generator.
const fs = require("fs"), vm = require("vm"), zlib = require("zlib"), path = require("path");
const R = path.join(__dirname, "..", "js") + path.sep;
global.window = global; global.THREE = {}; global.document = {};
const load = f => vm.runInThisContext(fs.readFileSync(R + f, "utf8"), { filename: f });
load("blocks.js"); load("noise.js");
BF.CS = 16;
load("rivers.js"); load("worldgen.js");
const [, , out, seed, scale, cx, cz, span, px, gen] = process.argv;
const G = +(gen || 2);
BF.setLimits(G);
BF.noise = BF.makeNoise(+seed); BF.worldgen.init(BF.noise, { gen: G, biomeScale: +scale });   // (init sets the limits too)
const w = BF.worldgen, SEA = BF.SEA, g3 = G >= 3;
// per-generator height scales: ocean depth tint range, land shading range, plateau tint threshold
const OCEAN_D = g3 ? 60 : 30, SH_LO = g3 ? 0 : 40, SH_RNG = g3 ? 2400 : 150, EL_T = g3 ? 900 : 100;
const HSM = +(process.env.HS || 1);
const N = +px, S = +span / N, x0 = +cx - +span / 2, z0 = +cz - +span / 2;
const col = {0:[40,70,160],1:[230,215,150],2:[235,235,220],3:[130,130,130],4:[60,120,220],5:[130,190,80],6:[50,130,40],7:[200,120,200],8:[110,170,70],9:[30,80,30],10:[80,110,60],11:[90,90,50],12:[235,210,130],13:[200,110,60],14:[180,170,70],15:[100,170,50],16:[20,150,40],17:[40,110,80],18:[30,90,70],19:[235,240,250],20:[170,220,255],21:[160,200,200],22:[150,210,120],23:[250,170,200],24:[150,150,150],25:[220,230,240],26:[255,255,255],27:[170,170,170],28:[170,100,170]};
// hypsometric ramp for ELEV=1 (gen 3 heights; gen 2 is stretched to the same colours)
const RAMP = [[0, [90, 170, 90]], [100, [140, 200, 100]], [500, [215, 200, 110]], [900, [225, 150, 70]], [1400, [170, 90, 60]], [2000, [140, 130, 135]], [2500, [255, 255, 255]]];
function ramp(h) {
  if (!g3) h = h < SEA ? h : (h - SEA) * (2500 / 130);
  if (h <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) if (h < RAMP[i][0]) { const t = (h - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]); return RAMP[i - 1][1].map((v, k) => v + (RAMP[i][1][k] - v) * t); }
  return RAMP[RAMP.length - 1][1];
}
const rgb = new Uint8Array(N * N * 3); const stats = {};
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const x = Math.floor(x0 + i * S), z = Math.floor(z0 + j * S), h = w.heightAt(x, z), b = w.biomeAt(x, z);
  let c = col[b.id] || [255, 0, 255]; stats[b.id] = (stats[b.id] || 0) + 1;
  const hE = w.heightAt(x + Math.max(1, S | 0), z + Math.max(1, S | 0));
  if (b.id === 0) { const d = Math.max(0, Math.min(1, (SEA - h) / OCEAN_D)); c = [40 - d * 25, 80 - d * 40, 170 - d * 70]; }
  else if (b.id === 4 && !process.env.ELEV) c = [70, 130, 230];
  else {
    const sh = Math.max(-0.35, Math.min(0.35, (h - hE) / (S * 0.9 + 6) * (g3 ? 0.5 * 0.05 : 0.5) * HSM));
    if (process.env.ELEV) { const r = ramp(h); c = r.map(v => Math.max(0, Math.min(255, v * (0.85 + sh * 1.4)))); }
    else {
      const k = 0.7 + 0.45 * Math.max(0, Math.min(1, (h - SH_LO) / SH_RNG)) + sh;
      c = c.map(v => Math.max(0, Math.min(255, v * k)));
      if (process.env.EL && h > EL_T) c = [c[0] * 0.6 + 100, c[1] * 0.6 + 60, c[2] * 0.6 + 40];
    }
  }
  if (process.env.ELEV && b.id === 0) { const d = Math.max(0, Math.min(1, -h / OCEAN_D)); c = [40 - d * 25, 90 - d * 40, 180 - d * 70]; }
  if (process.env.RV && b.id !== 0) { const o2 = {}; if (BF.rivers.at(x, z, o2) && o2.sd < (+process.env.RV)) c = [30, 90, 255]; }
  const o = (j * N + i) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
}
function crc(b) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const Q = process.env.Q == null ? 48 : +process.env.Q;
let png;
if (!Q) {
  const buf = Buffer.alloc(N * (N * 3 + 1));
  for (let j = 0; j < N; j++) { buf[j * (N * 3 + 1)] = 0; for (let i = 0; i < N * 3; i++) buf[j * (N * 3 + 1) + 1 + i] = rgb[j * N * 3 + i]; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(N, 0); ih.writeUInt32BE(N, 4); ih[8] = 8; ih[9] = 2;
  png = Buffer.concat([SIG, chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(buf, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
} else {
  // palette quantization: popularity-weighted median cut on a 5-bit histogram
  const hist = new Map();
  for (let p = 0; p < N * N; p++) { const k = ((rgb[p * 3] >> 3) << 10) | ((rgb[p * 3 + 1] >> 3) << 5) | (rgb[p * 3 + 2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); }
  let boxes = [[...hist.entries()].map(([k, n]) => ({ r: (k >> 10) << 3, g: ((k >> 5) & 31) << 3, b: (k & 31) << 3, n }))];
  while (boxes.length < Q) {
    let bi = -1, bs = 0, bax = 0;
    boxes.forEach((bx, i) => { if (bx.length < 2) return; for (const ax of ["r", "g", "b"]) { let lo = 255, hi = 0; for (const e of bx) { lo = Math.min(lo, e[ax]); hi = Math.max(hi, e[ax]); } const sc = (hi - lo) * Math.sqrt(bx.reduce((a, e) => a + e.n, 0)); if (sc > bs) { bs = sc; bi = i; bax = ax; } } });
    if (bi < 0) break;
    const bx = boxes[bi].sort((a, b) => a[bax] - b[bax]); const tot = bx.reduce((a, e) => a + e.n, 0); let acc = 0, cut = 1;
    for (let k = 0; k < bx.length - 1; k++) { acc += bx[k].n; if (acc >= tot / 2) { cut = k + 1; break; } cut = k + 1; }
    boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
  }
  const pal = boxes.map(bx => { let n = 0, r = 0, g = 0, b = 0; for (const e of bx) { n += e.n; r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; } return [Math.round(r / n + 3), Math.round(g / n + 3), Math.round(b / n + 3)]; });
  const cache = new Map();
  const nearest = (r, g, b) => { const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); let v = cache.get(k); if (v === undefined) { let bd = 1e9; v = 0; for (let i = 0; i < pal.length; i++) { const d = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2; if (d < bd) { bd = d; v = i; } } cache.set(k, v); } return v; };
  const bits = pal.length <= 16 ? 4 : 8, buf = Buffer.alloc(N * (1 + (bits === 4 ? (N + 1) >> 1 : N)));
  const rowB = 1 + (bits === 4 ? (N + 1) >> 1 : N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = (j * N + i) * 3, v = nearest(rgb[p], rgb[p + 1], rgb[p + 2]);
    if (bits === 8) buf[j * rowB + 1 + i] = v; else buf[j * rowB + 1 + (i >> 1)] |= i & 1 ? v : v << 4;
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(N, 0); ih.writeUInt32BE(N, 4); ih[8] = bits; ih[9] = 3;
  png = Buffer.concat([SIG, chunk("IHDR", ih), chunk("PLTE", Buffer.from(pal.flat())), chunk("IDAT", zlib.deflateSync(buf, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync(out, png);
console.log(JSON.stringify(stats), JSON.stringify(BF.rivers._debug()), (png.length / 1024).toFixed(0) + " KB");
