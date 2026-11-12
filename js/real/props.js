// Blockfield 1.6, the realistic look: js/real/props.js. Objects that are a full block to the game but are not cube shaped in the
// world: a pumpkin, a beehive (docs/REALISTIC_CONTRACT.md section 4, "props").
// Drawing only. Nothing here may run unless BF.real.on, and nothing here changes the game: a prop is still one block, with the
// block's collision box, light and rules.
//
// - The registry. BF.real.assets.props lists the blocks drawn as models: { block, variants, build(variant, detail) -> BufferGeometry
//   (position, normal, color, uv; 1 unit = 1 block, origin at the middle of the block's floor, y up, front towards +z), material(),
//   turn (a random turn about y), size [min, max], lean (how far it tips with the ground, 0 .. 1), sink (blocks per unit of slope),
//   shade (the radius of the soft shadow on the ground under it, drawn while the sun casts no shadows: BF.real.quality.shadows off) }.
//   js/real/terrain.js puts those blocks in the mesher's PROP table; js/real/mesh.js leaves their cubes out and lists each as a
//   flora record of kind 6: [x, y, z, 6, block, 1, seed, extra] (extra as for a ground plant: light and the seat on the ground).
// - The placer. This file sits in front of the flora placer (BF.real.flora.place / remove, in front of js/real/fell.js), takes the
//   records of kind 6 out of the list and draws them: per chunk one InstancedMesh per model and level of detail, a direct child of
//   the scene at the chunk's corner (contract section 2). Light is the instance colour, as for plants.
//
// API: BF.real.props = { config, models() -> names, geometry(block, variant, detail), stats() -> { chunks, props, meshes } }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
const real = BF.real;
try { if (/[?&]props=off/.test(location.search)) return; } catch (_) { /* no page */ }   // (for comparing: the blocks stay cubes)
const PROP = 6;
const config = {
  near: 40,          // blocks: the full model up to here, the coarse one beyond
  hive: "box",       // "box": a wooden hive of stacked boxes under a gabled roof; "skep": a coiled straw dome on a stool
  enabled: true,
};
try { const q = /[?&]hive=(\w+)/.exec(location.search); if (q) config.hive = q[1]; } catch (_) { /* no page */ }
const registry = (real.assets.props = real.assets.props || []);
const T = typeof THREE === "undefined" ? null : THREE;

// ---------------------------------------------------------------- geometry
const TAU = Math.PI * 2;
const ALB = 0.55;   // albedos stay low: the sun runs to about 3 under ACES (contract section 5)
function lin(hex) {
  const f = i => { const v = parseInt(hex.substr(i, 2), 16) / 255; return (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * ALB; };
  return [f(1), f(3), f(5)];
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(a) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class Geo {
  constructor() { this.p = []; this.n = []; this.c = []; this.u = []; this.i = []; }
  // A surface over a grid: f(u, v, out) fills out.p [x, y, z], out.c [r, g, b], out.uv [u, v]. Smooth normals; wrap: the u = 0 and
  // u = 1 columns are the same points (their normals are shared).
  grid(nu, nv, f, wrap) {
    const o = this.p.length / 3, W = nu + 1, out = { p: [0, 0, 0], c: [1, 1, 1], uv: [0, 0] };
    const P = new Float32Array(W * (nv + 1) * 3), N = new Float32Array(W * (nv + 1) * 3);
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      f(i / nu, j / nv, out);
      const k = (j * W + i) * 3;
      P[k] = out.p[0]; P[k + 1] = out.p[1]; P[k + 2] = out.p[2];
      this.c.push(out.c[0], out.c[1], out.c[2]); this.u.push(out.uv[0], out.uv[1]);
    }
    const tri = (a, b, c) => {
      const ax = P[b * 3] - P[a * 3], ay = P[b * 3 + 1] - P[a * 3 + 1], az = P[b * 3 + 2] - P[a * 3 + 2];
      const bx = P[c * 3] - P[a * 3], by = P[c * 3 + 1] - P[a * 3 + 1], bz = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      for (const v of [a, b, c]) { N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz; }
      this.i.push(o + a, o + b, o + c);
    };
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      tri(a, c, b); tri(b, c, d);
    }
    if (wrap) for (let j = 0; j <= nv; j++) {
      const a = (j * W) * 3, b = (j * W + nu) * 3;
      for (let k = 0; k < 3; k++) { const s = N[a + k] + N[b + k]; N[a + k] = N[b + k] = s; }
    }
    for (let v = 0; v < W * (nv + 1); v++) {
      let x = N[v * 3], y = N[v * 3 + 1], z = N[v * 3 + 2], l = Math.hypot(x, y, z);
      if (l < 1e-9) { x = 0; y = 1; z = 0; l = 1; }
      this.p.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); this.n.push(x / l, y / l, z / l);
    }
    return this;
  }
  // A flat polygon (a fan), with its own normal. pts: [[x, y, z], ...] counter-clockwise seen from outside. uv: planar, k per block.
  poly(pts, col, k, ua, va) {
    const o = this.p.length / 3, a = pts[0], b = pts[1], c = pts[2];
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2], bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    // the texture runs along ua (default: the face's level direction) and va
    if (!ua) { ua = Math.abs(ny) > 0.9 ? [1, 0, 0] : [-nz, 0, nx]; const ul = Math.hypot(ua[0], ua[2]) || 1; ua = [ua[0] / ul, 0, ua[2] / ul]; }
    if (!va) va = [ny * ua[2] - nz * ua[1], nz * ua[0] - nx * ua[2], nx * ua[1] - ny * ua[0]];
    for (const q of pts) {
      this.p.push(q[0], q[1], q[2]); this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]);
      this.u.push((q[0] * ua[0] + q[1] * ua[1] + q[2] * ua[2]) * k, (q[0] * va[0] + q[1] * va[1] + q[2] * va[2]) * k);
    }
    for (let i = 1; i < pts.length - 1; i++) this.i.push(o, o + i, o + i + 1);
    return this;
  }
  // A box from (x0, y0, z0) to (x1, y1, z1); m (optional): fn([x, y, z]) -> [x, y, z] applied to its corners (a turn, a slope).
  box(x0, y0, z0, x1, y1, z1, col, k, m) {
    const v = (x, y, z) => (m ? m([x, y, z]) : [x, y, z]);
    const c = [v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0), v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)];
    k = k || 1;
    this.poly([c[4], c[5], c[6], c[7]], col, k);        // +z
    this.poly([c[1], c[0], c[3], c[2]], col, k);        // -z
    this.poly([c[5], c[1], c[2], c[6]], col, k);        // +x
    this.poly([c[0], c[4], c[7], c[3]], col, k);        // -x
    this.poly([c[7], c[6], c[2], c[3]], mul(col, 1.04), k);   // top
    this.poly([c[0], c[1], c[5], c[4]], mul(col, 0.8), k);    // bottom
    return this;
  }
  build() {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new T.Float32BufferAttribute(this.n, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(this.c, 3));
    g.setAttribute("uv", new T.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- textures (painted once, in code)
const texs = {};
function canvasTex(name, w, h, paint, repeat) {
  if (texs[name]) return texs[name];
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  paint(c.getContext("2d"), w, h, rng(name.length * 7919 + w));
  const t = new T.CanvasTexture(c);
  t.encoding = T.sRGBEncoding; t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = T.RepeatWrapping;
  return (texs[name] = t);
}
// pumpkin skin: pale, faintly streaked along the ribs and freckled; the colour itself is in the vertices
function paintSkin(g, w, h, r) {
  g.fillStyle = "#f2f0ee"; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    const x = r() * w, y = r() * h, l = 10 + r() * 50;
    g.strokeStyle = r() < 0.5 ? "rgba(255,255,255,0.10)" : "rgba(120,90,60,0.07)"; g.lineWidth = 0.6 + r() * 1.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y + l); g.stroke();
  }
  for (let i = 0; i < 500; i++) {
    g.fillStyle = r() < 0.6 ? "rgba(110,70,30,0.10)" : "rgba(255,250,235,0.14)";
    g.beginPath(); g.arc(r() * w, r() * h, 0.5 + r() * 1.8, 0, TAU); g.fill();
  }
  for (let i = 0; i < 14; i++) {   // a few scars and warts
    const x = r() * w, y = r() * h;
    g.strokeStyle = "rgba(150,120,80,0.35)"; g.lineWidth = 1 + r();
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + (r() - 0.5) * 16, y + (r() - 0.5) * 10, x + (r() - 0.5) * 22, y + (r() - 0.5) * 16); g.stroke();
  }
}
// sawn boards: grain along u, a few knots
function paintWood(g, w, h, r) {
  g.fillStyle = "#e9e6e2"; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 520; i++) {
    const y = r() * h, x = r() * w, l = 30 + r() * 140, d = r();
    g.strokeStyle = d < 0.55 ? "rgba(70,50,30," + (0.05 + r() * 0.12) + ")" : "rgba(255,255,255," + (0.05 + r() * 0.1) + ")";
    g.lineWidth = 0.5 + r() * 1.4;
    g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + l * 0.3, y + (r() - 0.5) * 3, x + l * 0.6, y + (r() - 0.5) * 3, x + l, y + (r() - 0.5) * 2); g.stroke();
    if (x + l > w) { g.beginPath(); g.moveTo(x - w, y); g.lineTo(x + l - w, y); g.stroke(); }
  }
  for (let i = 0; i < 2; i++) {
    const x = r() * w, y = r() * h, s = 1.5 + r() * 2;
    for (let k = 3; k > 0; k--) { g.strokeStyle = "rgba(60,40,20," + 0.12 * k + ")"; g.lineWidth = 1; g.beginPath(); g.ellipse(x, y, s * k * 0.9, s * k * 0.5, 0, 0, TAU); g.stroke(); }
    g.fillStyle = "rgba(50,32,16,0.5)"; g.beginPath(); g.ellipse(x, y, s * 0.7, s * 0.4, 0, 0, TAU); g.fill();
  }
}
// a skep: u once around (the front, +z, at u = 0.25), v from the rim (the canvas's bottom) to the crown. Coils of straw rope bound
// with a darker stitch, and the flight hole at the foot of the front.
const SKEP_COILS = 13;
function paintSkep(g, w, h, r) {
  g.fillStyle = "#f0ede6"; g.fillRect(0, 0, w, h);
  const ch = h / SKEP_COILS;
  for (let k = 0; k < SKEP_COILS; k++) {
    const y0 = k * ch;
    const gr = g.createLinearGradient(0, y0, 0, y0 + ch);
    gr.addColorStop(0, "rgba(60,40,10,0.42)"); gr.addColorStop(0.22, "rgba(255,255,255,0.05)"); gr.addColorStop(0.5, "rgba(255,255,255,0.16)");
    gr.addColorStop(0.8, "rgba(80,55,20,0.10)"); gr.addColorStop(1, "rgba(50,32,8,0.48)");
    g.fillStyle = gr; g.fillRect(0, y0, w, ch);
    for (let i = 0; i < 260; i++) {   // straws along the coil
      const x = r() * w, y = y0 + ch * (0.12 + r() * 0.76), l = 8 + r() * 26;
      g.strokeStyle = r() < 0.5 ? "rgba(255,250,225,0.20)" : "rgba(110,80,30,0.16)"; g.lineWidth = 0.6 + r() * 0.8;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (r() - 0.5) * 1.6); g.stroke();
    }
    const step = w / 46, off = (k % 2) * step * 0.5;   // the binding: slanted stitches, staggered coil to coil
    for (let x = off; x < w + step; x += step) {
      g.strokeStyle = "rgba(96,62,22,0.55)"; g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(x - 2.5, y0 + ch * 0.08); g.lineTo(x + 2.5, y0 + ch * 0.92); g.stroke();
      g.strokeStyle = "rgba(255,240,200,0.22)"; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x - 1, y0 + ch * 0.1); g.lineTo(x + 4, y0 + ch * 0.9); g.stroke();
    }
  }
  // the flight hole: a low arch in the first coil and a half
  const cx = w * 0.25, aw = w * 0.028, ah = ch * 1.5;
  g.fillStyle = "#1c1208";
  g.beginPath(); g.moveTo(cx - aw, h); g.lineTo(cx - aw, h - ah * 0.5); g.quadraticCurveTo(cx - aw, h - ah, cx, h - ah); g.quadraticCurveTo(cx + aw, h - ah, cx + aw, h - ah * 0.5); g.lineTo(cx + aw, h); g.closePath(); g.fill();
  g.strokeStyle = "rgba(70,45,15,0.8)"; g.lineWidth = 2.5; g.stroke();
}
function litMat(map, rough) {
  const m = new T.MeshStandardMaterial({ map, vertexColors: true, roughness: rough, metalness: 0 });
  return real.lit(m, { light: "open" });
}

// ---------------------------------------------------------------- the pumpkin
// A field pumpkin: a flattened globe of ribs with a dip at each pole, a dry ribbed stalk, paler where it lay on the ground.
// Variants differ in build (squat, round, tall, lopsided), rib count and colour.
const PUMPKINS = [
  { R: 0.47, H: 0.70, ribs: 10, hue: 0.00, lop: 0.04 },
  { R: 0.44, H: 0.78, ribs: 9, hue: 0.35, lop: 0.07 },
  { R: 0.48, H: 0.62, ribs: 11, hue: 0.65, lop: 0.03 },
  { R: 0.42, H: 0.84, ribs: 8, hue: 0.15, lop: 0.09 },
  { R: 0.46, H: 0.72, ribs: 12, hue: 1.00, lop: 0.05 },
];
function pumpkinGeo(variant, detail) {
  const V = PUMPKINS[variant % PUMPKINS.length], r = rng(1300 + variant * 97), g = new Geo();
  const nu = detail ? 28 : V.ribs * 6, nv = detail ? 8 : 18;
  const ph = r() * TAU, lopA = r() * TAU, spotA = r() * TAU, wob = 0.05 + r() * 0.05;
  const orange = mix(lin("#e07a16"), lin("#c9611a"), V.hue), deep = lin("#8a3a10"), pale = lin("#e2b25a"), stemEnd = lin("#5a5a2c");
  const ribW = []; for (let i = 0; i < V.ribs; i++) ribW.push(0.82 + r() * 0.36);   // each rib its own swell
  const topDip = 0.085, botDip = 0.05;
  const shape = (u, v, out) => {
    const th = u * TAU, t2 = th + wob * Math.sin(3 * th + ph);
    const fi = v * Math.PI, s = Math.sin(fi), c = -Math.cos(fi);
    const a = (t2 * V.ribs / TAU + 1000) % 1, rib = Math.pow(Math.sin(a * Math.PI), 0.5), ri = Math.floor((t2 * V.ribs / TAU + 1000) % V.ribs);
    const sw = ribW[ri] * (1 - 0) ;
    let rad = V.R * Math.pow(s, 0.7);
    rad *= 1 - 0.17 * (1 - rib) * (0.55 + 0.45 * s) + 0.035 * (sw - 1) * rib;
    rad *= 1 + V.lop * Math.cos(th - lopA) * (0.4 + 0.6 * c * c);
    let y = V.H * 0.5 * (1 + Math.sign(c) * Math.pow(Math.abs(c), 0.86));
    const q = rad / V.R;
    y -= topDip * Math.exp(-q * q / 0.07) * (c > 0 ? 1 : 0);
    y += botDip * Math.exp(-q * q / 0.09) * (c < 0 ? 1 : 0);
    y += V.lop * 0.35 * rad * Math.cos(th - lopA) * Math.max(0, c);   // the crown sits a little off level
    out.p[0] = rad * Math.cos(th); out.p[1] = y; out.p[2] = rad * Math.sin(th);
    let col = mix(orange, deep, 0.62 * Math.pow(1 - rib, 1.6));                       // the grooves are darker
    col = mix(col, mul(orange, 1.12), 0.35 * rib * sstep(0.35, 0.8, v));              // the shoulders catch the light
    const spot = Math.exp(-Math.pow(((th - spotA + Math.PI * 3) % TAU) - Math.PI, 2) / 0.5) * sstep(0.5, 0.12, v);
    col = mix(col, pale, 0.55 * spot);                                                // the ground spot
    col = mix(col, stemEnd, 0.55 * sstep(0.2, 0.0, q) * (c > 0 ? 1 : 0));             // green-brown around the stalk
    col = mul(col, 0.72 + 0.28 * sstep(0.0, 0.3, v));                                 // darker under the belly
    out.c[0] = col[0]; out.c[1] = col[1]; out.c[2] = col[2];
    out.uv[0] = u * 3; out.uv[1] = v * 1.5;
  };
  g.grid(nu, nv, shape, true);
  // the stalk: five ridges, thick where it meets the fruit, bent over, cut off square
  const sh = 0.17 + r() * 0.07, bend = 0.05 + r() * 0.07, ba = r() * TAU, base = V.H - topDip - 0.01;
  const tan = lin("#8f7f4c"), dark = lin("#4f4a26");
  const sn = detail ? 5 : 10, sm = detail ? 3 : 7;
  g.grid(sn, sm, (u, v, out) => {
    const th = u * TAU, k = v * v;
    const rad = (0.105 * Math.pow(1 - v, 2.2) + 0.042 + 0.008 * v) * (1 + 0.16 * Math.cos(5 * th + v * 2.2));
    const cx = Math.cos(ba) * bend * k, cz = Math.sin(ba) * bend * k;
    out.p[0] = cx + rad * Math.cos(th); out.p[1] = base + sh * v - 0.03 * (1 - v) * 0; out.p[2] = cz + rad * Math.sin(th);
    const col = mix(dark, tan, 0.25 + 0.75 * v * (0.6 + 0.4 * Math.cos(5 * th + v * 2.2)));
    out.c[0] = col[0]; out.c[1] = col[1]; out.c[2] = col[2];
    out.uv[0] = u; out.uv[1] = v * 0.5;
  }, true);
  const cap = [];
  for (let i = 0; i < sn; i++) { const th = i / sn * TAU, rad = 0.05 * (1 + 0.16 * Math.cos(5 * th + 2.2)); cap.push([Math.cos(ba) * bend + rad * Math.cos(-th), base + sh, Math.sin(ba) * bend + rad * Math.sin(-th)]); }
  g.poly(cap, lin("#b6a878"), 1);
  return g.build();
}

// ---------------------------------------------------------------- the beehive: stacked boxes
// A wooden hive as beekeepers keep them: a stand on four legs, a floor with a landing board under the flight slot, a deep brood
// box and a shallower honey super with hand holds, and a gabled roof with a metal ridge. The front faces +z.
function boxHiveGeo(variant, detail) {
  const g = new Geo();
  const leg = lin("#6f573a"), floor = lin("#8a6d48"), paint = lin("#efe6cc"), paint2 = lin("#e3bb5c"), slot = lin("#17110a"), hold = lin("#6a5c44");
  const roof = lin("#6a6660"), ridge = lin("#8a8780"), eave = lin("#d9cfb6"), honey = lin("#c98a1e");
  const K = 2.2;
  // the stand
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.box(sx * 0.30 - 0.04, 0, sz * 0.28 - 0.04, sx * 0.30 + 0.04, 0.16, sz * 0.28 + 0.04, leg, K);
  if (!detail) for (const sz of [-1, 1]) g.box(-0.30, 0.09, sz * 0.28 - 0.02, 0.30, 0.14, sz * 0.28 + 0.02, mul(leg, 0.9), K);
  // the floor and the landing board (it slopes down and out)
  g.box(-0.37, 0.16, -0.36, 0.37, 0.20, 0.36, floor, K);
  g.box(-0.24, 0.17, 0.36, 0.24, 0.195, 0.455, mul(floor, 1.1), K, p => [p[0], p[1] - (p[2] - 0.36) * 0.4, p[2]]);
  // the brood box and the super, the super a hair wider so the joint shows
  const b0 = 0.20, b1 = 0.535, s0 = 0.545, s1 = 0.775, hw = 0.345, hd = 0.335;
  g.box(-hw, b0, -hd, hw, b1, hd, paint, K);
  g.box(-hw, b1, -hd + 0.004, hw, s0, hd - 0.004, mul(paint, 0.45), K);   // the shadow line between the boxes
  g.box(-hw - 0.004, s0, -hd - 0.004, hw + 0.004, s1, hd + 0.004, paint2, K);
  // the flight slot and a smear of propolis and honey under it
  g.poly([[-0.17, b0 + 0.004, hd + 0.002], [0.17, b0 + 0.004, hd + 0.002], [0.17, b0 + 0.036, hd + 0.002], [-0.17, b0 + 0.036, hd + 0.002]], slot, K);
  if (!detail) {
    g.poly([[-0.2, b0 + 0.036, hd + 0.0015], [0.2, b0 + 0.036, hd + 0.0015], [0.19, b0 + 0.05, hd + 0.0015], [-0.19, b0 + 0.05, hd + 0.0015]], mix(paint, honey, 0.55), K);
    // hand holds: a routed recess on each face of each box
    for (const [y, w] of [[(b0 + b1) / 2 + 0.03, 0.15], [(s0 + s1) / 2, 0.15]]) {
      const e = y > s0 ? 0.004 : 0;
      for (const sx of [-1, 1]) g.poly(sx > 0
        ? [[hw + e + 0.002, y - 0.022, w / 2], [hw + e + 0.002, y - 0.022, -w / 2], [hw + e + 0.002, y + 0.022, -w / 2], [hw + e + 0.002, y + 0.022, w / 2]]
        : [[-hw - e - 0.002, y - 0.022, -w / 2], [-hw - e - 0.002, y - 0.022, w / 2], [-hw - e - 0.002, y + 0.022, w / 2], [-hw - e - 0.002, y + 0.022, -w / 2]], hold, K);
      g.poly([[-w / 2, y - 0.022, hd + e + 0.002], [w / 2, y - 0.022, hd + e + 0.002], [w / 2, y + 0.022, hd + e + 0.002], [-w / 2, y + 0.022, hd + e + 0.002]], hold, K);
      g.poly([[w / 2, y - 0.022, -hd - e - 0.002], [-w / 2, y - 0.022, -hd - e - 0.002], [-w / 2, y + 0.022, -hd - e - 0.002], [w / 2, y + 0.022, -hd - e - 0.002]], hold, K);
    }
  }
  // the roof: a rim that sits over the super, two gables, two sloped sheets with an overhang, a ridge cap
  const r0 = s1 - 0.03, r1 = s1 + 0.035, rw = 0.385, rd = 0.375, apex = 0.985, ov = 0.045;
  g.box(-rw, r0, -rd, rw, r1, rd, eave, K);
  for (const sz of [-1, 1]) {
    const z = sz * rd, tri = [[-rw, r1, z], [rw, r1, z], [0, apex - 0.02, z]];
    g.poly(sz > 0 ? tri : [tri[1], tri[0], tri[2]], eave, K);
  }
  const ex = rw + ov, ey = r1 - ov * (apex - r1) / rw, zf = rd + ov;
  for (const sx of [-1, 1]) {
    const a = [sx * ex, ey, zf], b = [sx * ex, ey, -zf], c = [0, apex, -zf], d = [0, apex, zf];
    g.poly(sx > 0 ? [a, b, c, d] : [b, a, d, c], roof, K, [0, 0, 1]);
    const t = 0.018, dn = p => [p[0], p[1] - t, p[2]];   // the sheet's underside and its edges
    g.poly(sx > 0 ? [dn(d), dn(c), dn(b), dn(a)] : [dn(c), dn(d), dn(a), dn(b)], mul(roof, 0.6), K, [0, 0, 1]);
    g.poly(sx > 0 ? [dn(a), dn(b), b, a] : [dn(b), dn(a), a, b], mul(roof, 0.85), K);
    g.poly(sx > 0 ? [dn(d), dn(a), a, d] : [dn(a), dn(d), d, a], mul(roof, 0.8), K);
    g.poly(sx > 0 ? [dn(b), dn(c), c, b] : [dn(c), dn(b), b, c], mul(roof, 0.8), K);
  }
  g.box(-0.035, apex - 0.012, -zf - 0.006, 0.035, apex + 0.012, zf + 0.006, ridge, K);
  return g.build();
}

// ---------------------------------------------------------------- the beehive: a skep
// The old straw hive: a dome of coiled straw rope with a flight hole at its foot, on a round board on three legs.
function skepGeo(variant, detail) {
  const g = new Geo();
  const straw = lin("#d6ad56"), strawD = lin("#a67c34"), wood = lin("#7b6040"), legc = lin("#644d32");
  const y0 = 0.2, hgt = 0.74, R = 0.4;
  const nu = detail ? 20 : 56, nv = detail ? 13 : SKEP_COILS * 5;
  g.grid(nu, nv, (u, v, out) => {
    const th = u * TAU;
    const coil = Math.abs(Math.sin(v * SKEP_COILS * Math.PI));
    const prof = Math.pow(Math.cos(Math.pow(v, 1.75) * Math.PI / 2), 0.72);
    const rad = (R * prof + 0.004) * (1 + 0.03 * (coil - 0.5) * (detail ? 0 : 1) / Math.max(0.35, prof));
    out.p[0] = rad * Math.cos(th); out.p[1] = y0 + hgt * (v + 0.012 * (coil - 0.5) * 0); out.p[2] = rad * Math.sin(th);
    const col = mix(strawD, straw, 0.35 + 0.65 * (detail ? 0.7 : coil));
    const k = 0.9 + 0.1 * Math.sin(th * 3 + v * 9);
    out.c[0] = col[0] * k; out.c[1] = col[1] * k; out.c[2] = col[2] * k;
    out.uv[0] = u; out.uv[1] = v;
  }, true);
  // the crown's loop (what it is lifted by)
  g.grid(detail ? 6 : 10, detail ? 3 : 6, (u, v, out) => {
    const a = v * Math.PI, th = u * TAU, rr = 0.016, RR = 0.045;
    const cx = Math.cos(a) * RR, cy = Math.sin(a) * RR;
    out.p[0] = cx + Math.cos(a) * rr * Math.cos(th); out.p[1] = y0 + hgt - 0.012 + cy + Math.sin(a) * rr * Math.cos(th); out.p[2] = rr * Math.sin(th);
    out.c[0] = strawD[0]; out.c[1] = strawD[1]; out.c[2] = strawD[2];
    out.uv[0] = u * 0.2 + 0.6; out.uv[1] = 0.5 + v * 0.03;
  }, true);
  // the board, an alighting lip under the hole, three legs
  const n = detail ? 10 : 24, top = [], rb = 0.455, b0 = 0.155;
  for (let i = 0; i < n; i++) { const th = i / n * TAU, lip = 1 + 0.16 * Math.exp(-Math.pow(th - Math.PI / 2, 2) / 0.06); top.push([rb * lip * Math.cos(th), y0, rb * lip * Math.sin(th)]); }
  g.poly(top.slice().reverse(), wood, 2.2);
  g.poly(top.map(p => [p[0], b0, p[2]]), mul(wood, 0.7), 2.2);
  for (let i = 0; i < n; i++) { const a = top[i], b = top[(i + 1) % n]; g.poly([[a[0], b0, a[2]], [a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], b0, b[2]]], mul(wood, 0.92), 2.2); }
  for (let i = 0; i < 3; i++) {
    const th = Math.PI / 2 + Math.PI + i * TAU / 3 + Math.PI, cx = Math.cos(th), cz = Math.sin(th);
    g.box(-0.035, 0, -0.035, 0.035, b0, 0.035, legc, 2.2, p => { const k = 0.30 + (b0 - p[1]) * 0.42; return [p[0] + cx * k, p[1], p[2] + cz * k]; });
  }
  return g.build();
}

// ---------------------------------------------------------------- the registry
let mats = null;
function materials() {
  return mats || (mats = {
    pumpkin: litMat(canvasTex("skin", 256, 256, paintSkin, true), 0.62),
    wood: litMat(canvasTex("wood", 256, 256, paintWood, true), 0.86),
    skep: litMat(canvasTex("skep", 1024, 512, paintSkep, false), 0.95),
  });
}
registry.push(
  { block: "pumpkin", variants: PUMPKINS.length, turn: true, size: [0.84, 1], lean: 0.6, sink: 0.25, shade: 0.82,
    build: pumpkinGeo, material: () => materials().pumpkin },
  { block: "beehive", variants: 1, turn: false, size: [1, 1], lean: 0, sink: 0.45, shade: 0.8,
    build: (v, d) => (config.hive === "skep" ? skepGeo(v, d) : boxHiveGeo(v, d)), material: () => (config.hive === "skep" ? materials().skep : materials().wood) },
);

// ---------------------------------------------------------------- the shadow under a prop
// Without shadow maps (BF.real.quality.shadows is off by default) an object set on the ground looks afloat. A soft dark disc under
// each prop that stands under open sky ties it down: one quad per prop, laid on the ground's slope.
let shadeGeo = null, shadeMat = null;
function shadeParts() {
  if (shadeMat) return;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(0,0,0,0.7)"); gr.addColorStop(0.5, "rgba(0,0,0,0.6)"); gr.addColorStop(0.78, "rgba(0,0,0,0.22)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  shadeGeo = new T.PlaneGeometry(2, 2); shadeGeo.rotateX(-Math.PI / 2);
  shadeMat = new T.MeshBasicMaterial({ map: new T.CanvasTexture(c), color: 0x000000, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}

// ---------------------------------------------------------------- the placer
const byBlock = new Map();    // block id -> registry entry
const geos = new Map();       // "block:variant:detail" -> geometry
const chunks = new Map();     // chunk key -> { ox, oz, recs: Float32Array (8 a record), meshes: [{ near, far }] }
let scene = null, inner = null;
function entryOf(block) {
  if (!byBlock.size) for (const e of registry) { const id = BF.B[e.block]; if (id != null) byBlock.set(id, e); }
  return byBlock.get(block) || null;
}
function geometry(block, variant, detail) {
  const e = entryOf(block), k = block + ":" + variant + ":" + detail;
  if (!e) return null;
  let g = geos.get(k);
  if (!g) geos.set(k, g = e.build(variant, detail));
  return g;
}
function tintOf(extra, seed, out) {   // sky and block light as the lit patch weighs them (js/real/core.js), and a little variety
  const sky = ((extra | 0) & 15) / 15, bl = (((extra | 0) >> 4) & 15) / 15;
  const s = Math.max(0.06, sky * (0.6 + 0.4 * Math.min(1, Math.max(0, (sky - 0.3) / 0.4))));
  const b = Math.min(1, 1.1 * Math.pow(bl, 1.25)) * 0.9, v = 0.92 + 0.16 * ((seed * 5.3) % 1);
  out[0] = (s + b) * v; out[1] = (s + b * 0.72) * v; out[2] = (s + b * 0.42) * v;
  return out;
}
function drop(c) {
  for (const m of c.meshes) for (const o of [m.near, m.far]) { if (scene) scene.remove(o); o.dispose && o.dispose(); }
  if (c.shade) { if (scene) scene.remove(c.shade); c.shade.dispose(); c.shade = null; }
  c.meshes = [];
}
function draw(c) {
  drop(c);
  if (!scene || !T || !config.enabled) return;
  const R = c.recs, groups = new Map();
  for (let o = 0; o < R.length; o += 8) {
    const e = entryOf(R[o + 4] | 0);
    if (!e) continue;
    const variant = Math.floor(R[o + 6] * 9973) % Math.max(1, e.variants | 0), k = (R[o + 4] | 0) + ":" + variant;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { e, block: R[o + 4] | 0, variant, list: [] });
    g.list.push(o);
  }
  const M = new T.Matrix4(), Q = new T.Quaternion(), Q2 = new T.Quaternion(), P = new T.Vector3(), S = new T.Vector3(), UP = new T.Vector3(0, 1, 0), N = new T.Vector3();
  const seat = [0, 0, 0], tint = [1, 1, 1], shadows = !!(real.quality && real.quality.shadows);
  const blobs = [];
  for (const g of groups.values()) {
    const n = g.list.length, e = g.e, pair = {};
    const mats4 = new Float32Array(n * 16), cols = new Float32Array(n * 3);
    g.list.forEach((o, i) => {
      const seed = R[o + 6], extra = R[o + 7];
      real.seat(extra, seat);
      const s = e.size[0] + (e.size[1] - e.size[0]) * ((seed * 7.7) % 1), slope = Math.hypot(seat[1], seat[2]);
      P.set(R[o], R[o + 1] + seat[0] - e.sink * slope, R[o + 2]);
      Q.setFromAxisAngle(UP, e.turn ? seed * TAU * 3 : 0);
      if (e.lean && slope > 0) { N.set(-seat[1] * e.lean, 1, -seat[2] * e.lean).normalize(); Q2.setFromUnitVectors(UP, N); Q.premultiply(Q2); }
      S.set(s, s, s);
      M.compose(P, Q, S).toArray(mats4, i * 16);
      tintOf(extra, seed, tint); cols.set(tint, i * 3);
      if (e.shade && !shadows && ((extra | 0) & 15) >= 8) {
        // on the ground under it, on the ground's own slope (only where the mesher found ground: seat known)
        const k = e.shade * s;
        N.set(-seat[1], 1, -seat[2]).normalize(); Q2.setFromUnitVectors(UP, N);
        P.set(R[o], R[o + 1] + seat[0] + 0.03, R[o + 2]); S.set(k, 1, k);
        if (Math.floor(extra / 256)) blobs.push(new T.Matrix4().compose(P, Q2, S));
      }
    });
    for (const lv of [0, 1]) {
      const m = new T.InstancedMesh(geometry(g.block, g.variant, lv), e.material(), n);
      m.instanceMatrix = new T.InstancedBufferAttribute(mats4, 16);
      m.instanceColor = new T.InstancedBufferAttribute(cols, 3);
      m.position.set(c.ox, 0, c.oz);
      m.frustumCulled = false;
      m.castShadow = shadows && lv === 0; m.receiveShadow = true;
      m.visible = lv === 0;
      m.userData.prop = g.e.block;
      scene.add(m);
      pair[lv ? "far" : "near"] = m;
    }
    c.meshes.push(pair);
  }
  if (blobs.length) {
    shadeParts();
    const m = new T.InstancedMesh(shadeGeo, shadeMat, blobs.length);
    blobs.forEach((b, i) => m.setMatrixAt(i, b));
    m.position.set(c.ox, 0, c.oz); m.frustumCulled = false; m.renderOrder = 1;
    scene.add(m); c.shade = m;
  }
}
function setProps(key, ox, oz, recs) {
  let c = chunks.get(key);
  if (!recs || !recs.length) { if (c) { drop(c); chunks.delete(key); } return; }
  if (c && c.ox === ox && c.oz === oz && c.recs.length === recs.length && c.recs.every((v, i) => v === recs[i]) && c.meshes.length) return;   // (nothing changed)
  if (!c) chunks.set(key, c = { ox, oz, recs, meshes: [] });
  c.ox = ox; c.oz = oz; c.recs = recs;
  draw(c);
}
function place(key, ox, oz, F) {
  const n = F ? Math.floor(F.length / 8) : 0;
  let mine = 0;
  for (let i = 0; i < n; i++) if ((F[i * 8 + 3] | 0) === PROP) mine++;
  let G = F, recs = null;
  if (mine) {
    recs = new Float32Array(mine * 8);
    G = n > mine ? new Float32Array((n - mine) * 8) : null;
    for (let i = 0, a = 0, b = 0; i < n; i++) {
      const r = F.subarray(i * 8, i * 8 + 8);
      if ((r[3] | 0) === PROP) { recs.set(r, a); a += 8; } else { G.set(r, b); b += 8; }
    }
  }
  inner.place.call(real.flora, key, ox, oz, G);
  try { setProps(key, ox, oz, recs); } catch (e) { console.error("BF.real.props", e); }
}
function remove(key) {
  setProps(key, 0, 0, null);
  inner.remove.call(real.flora, key);
}
// Stands in front of whatever placer is installed (again at init: js/real/lod.js and fell.js install themselves there once more).
function wrap() {
  const f = real.flora;
  if (!f || !f.place || f.place === place) return;
  inner = { place: f.place, remove: f.remove };
  f.place = place; f.remove = remove;
}
wrap();
// near chunks show the full models, the rest the coarse ones
function frame() {
  const p = BF.player && BF.player.position;
  if (!p || !chunks.size) return;
  for (const c of chunks.values()) {
    if (!c.meshes.length) continue;
    const dx = Math.max(0, Math.abs(p.x - c.ox - 8) - 8), dz = Math.max(0, Math.abs(p.z - c.oz - 8) - 8);
    const near = dx * dx + dz * dz < config.near * config.near;
    for (const m of c.meshes) { m.near.visible = near; m.far.visible = !near; }
  }
}

real.props = {
  config, geometry,
  models: () => registry.map(e => e.block),
  redraw() { geos.clear(); for (const c of chunks.values()) draw(c); },
  stats() { let props = 0, meshes = 0; for (const c of chunks.values()) { props += c.recs.length / 8; meshes += c.meshes.length; } return { chunks: chunks.size, props, meshes }; },
  _test: { chunks, Geo },
};
real.module({
  name: "props",
  init(ctx) { scene = ctx.scene; wrap(); for (const c of chunks.values()) draw(c); },
  frame,
});
})();
