// Blockfield 1.6, the realistic look: js/real/assets-kit.js. Owner: the Biome assets thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
// The plant and rock toolkit behind the species registry (BF.real.akit): geometry builders (tubes for wood, bent cards for foliage, a
// recursive broadleaf, a whorled conifer, palms, ribbed succulents, tufts, shrubs, displaced-sphere rocks), canvas painters (bark colour
// + height maps, foliage atlases with alpha, leaf / frond / blade / flower painters) and the materials they are drawn with (sway and
// back-lit translucency patched into MeshStandardMaterial, then BF.real.lit). Grown from Cascade Creek's flora module and made
// parametric, so a species is a parameter set plus a bark painter and an atlas painter (js/real/assets-trees.js, assets-cover.js).
// 1 unit = 1 block; every model's origin is the ground at its base. Nothing here touches the scene or the world; everything random
// comes from the rand passed to withRand (a function, or a number used as a seed).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
const T = globalThis.THREE, V3 = T.Vector3, TAU = Math.PI * 2;
const BW = 1.0, BH = 2.0, WHITE = [1, 1, 1];           // bark texture repeat: 1 block around, 2 blocks up

// ---------- randomness: every builder and painter draws from R, set by withRand ----------
let R = Math.random, _phi = 0;
const rr = (a, b) => a + (b - a) * R();
const pick = a => a[(R() * a.length) | 0];
function mulberry(seed) {
  let a = (seed | 0) || 1;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function withRand(rand, fn) {
  const old = R;
  R = typeof rand === "number" ? mulberry(rand) : rand || Math.random;
  _phi = 0;                                     // (the branching's running azimuth: every build starts from the same state)
  try { return fn(); } finally { R = old; }
}
function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
const hsl = (h, s, l, a) => "hsla(" + (h | 0) + "," + (s | 0) + "%," + (l | 0) + "%," + (a == null ? 1 : a) + ")";

const K = { texScale: 1, low: false };   // low: the lightest build (the registry's detail 2), set around a build by the caller       // 0.5 halves every texture's resolution (set before the first material is asked for)

// =====================================================================
//  BARK (colour + height map, tiling). paint(P) draws in a 512 x 1024 space whatever the real resolution.
// =====================================================================
function barkTex(paint, opts) {
  opts = opts || {};
  const W = opts.w || 512, H = opts.h || 1024, s = K.texScale;
  const c = canvas(W * s, H * s), g = c.getContext("2d"), b = canvas(W * s, H * s), h = b.getContext("2d");
  g.scale(s, s); h.scale(s, s);
  const P = {
    g, h, W, H,
    fill(c1, c2) { g.globalAlpha = 1; g.fillStyle = c1; g.fillRect(0, 0, W, H); h.globalAlpha = 1; h.fillStyle = c2 || "#909090"; h.fillRect(0, 0, W, H); },
    // a polyline drawn 9 times so it wraps at the edges
    poly(cx, p, col, w, a, dx) {
      cx.strokeStyle = col; cx.lineWidth = w; cx.globalAlpha = a; cx.lineCap = "round"; cx.lineJoin = "round";
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        cx.beginPath();
        for (let q = 0; q < p.length; q += 2) { if (q) cx.lineTo(p[q] + ox * W + (dx || 0), p[q + 1] + oy * H); else cx.moveTo(p[q] + ox * W + (dx || 0), p[q + 1] + oy * H); }
        cx.stroke();
      }
    },
    blob(cx, bx, by, rx, ry, rot, col, a) {
      cx.fillStyle = col; cx.globalAlpha = a;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) { cx.beginPath(); cx.ellipse(bx + ox * W, by + oy * H, rx, ry, rot, 0, TAU); cx.fill(); }
    },
    // a wandering vertical line (a furrow) / horizontal line (a lenticel)
    furrow(fx, fy, flen, wob, step) { const p = []; for (let q = 0; q <= flen; q += step) { p.push(fx, fy + q); fx += rr(-wob, wob); } return p; },
    dash(x, y, len, wob) { return [x, y, x + len * 0.5, y + rr(-wob, wob), x + len, y + rr(-wob, wob)]; },
    grain(n, cols, hl, wmax, hmax) {
      for (let q = 0; q < n; q++) {
        const gx = R() * W, gy = R() * H, gw = rr(1, wmax), gh = rr(3, hmax);
        g.globalAlpha = rr(0.06, 0.25); g.fillStyle = pick(cols); g.fillRect(gx, gy, gw, gh);
        h.globalAlpha = rr(0.08, 0.3); h.fillStyle = R() < 0.5 ? "#303030" : hl; h.fillRect(gx, gy, gw, gh);
      }
    },
    // n furrows: dark groove, warm inner line, pale lit edge
    furrows(n, len, lw, wob, step, dark, warm, edge) {
      for (let i = 0; i < n; i++) {
        const w = rr(lw[0], lw[1]), pts = P.furrow(R() * W, R() * H, rr(len[0], len[1]), wob, step);
        P.poly(h, pts, "#0c0c0c", w, 0.9); P.poly(g, pts, dark, w, 0.88);
        if (warm) P.poly(g, pts, warm, w * 0.28, 0.5);
        if (edge) { P.poly(g, pts, edge, Math.max(1.5, w * 0.14), 0.4, w * 0.5 + 2); P.poly(h, pts, "#e8e8e8", 2.5, 0.5, w * 0.5 + 2); }
      }
    },
    // blocky plates: a jittered grid of cracks (pine, oak, juniper, alligator bark)
    plates(cw, ch, lw, dark, jit, a) {
      for (let x = 0; x < W; x += cw) {
        const pts = P.furrow(x + rr(-jit, jit), 0, H, jit * 0.5, 24);
        P.poly(g, pts, dark, lw * rr(0.7, 1.3), a); P.poly(h, pts, "#0a0a0a", lw * 1.2, 0.9);
        for (let y = rr(0, ch); y < H; y += ch * rr(0.6, 1.5)) {
          const d = P.dash(x + rr(-jit, jit), y, cw + rr(-jit, jit), jit * 0.6);
          P.poly(g, d, dark, lw * rr(0.4, 0.9), a * 0.85); P.poly(h, d, "#141414", lw * 0.8, 0.8);
        }
      }
    },
    lenticels(n, len, lw, col, a, hcol) {
      for (let i = 0; i < n; i++) {
        const d = P.dash(R() * W, R() * H, rr(len[0], len[1]), 1.4), w = rr(lw[0], lw[1]);
        P.poly(g, d, pick(col), w, rr(a * 0.6, a)); P.poly(h, d, hcol || "#404040", w, 0.6);
      }
    },
    mottle(n, cols, r0, r1, a0, a1, hcol) {
      for (let i = 0; i < n; i++) {
        const x = R() * W, y = R() * H, rx = rr(r0, r1), ry = rr(r0, r1) * rr(0.6, 1.4), ro = R() * 3;
        P.blob(g, x, y, rx, ry, ro, pick(cols), rr(a0, a1));
        if (hcol) P.blob(h, x, y, rx, ry, ro, hcol, 0.25);
      }
    },
  };
  paint(P);
  g.globalAlpha = 1; h.globalAlpha = 1;
  const map = new T.CanvasTexture(c), bump = new T.CanvasTexture(b);
  map.encoding = T.sRGBEncoding; map.wrapS = map.wrapT = bump.wrapS = bump.wrapT = T.RepeatWrapping; map.anisotropy = bump.anisotropy = 8;
  return { map, bump };
}
function barkMat(tex, bumpScale, rough) {
  return lit(new T.MeshStandardMaterial({ map: tex.map, bumpMap: tex.bump, bumpScale: bumpScale == null ? 0.04 : bumpScale, roughness: rough == null ? 0.95 : rough, metalness: 0, vertexColors: true }), "bark");
}

// =====================================================================
//  FOLIAGE ATLASES: n x n cells in a 1024 space (n = 2: trees, 512 cells; n = 4: ground cover, 256 cells).
//  paint(g, i, S) draws cell i in a S x S box, the twig or stem base at the bottom centre (S/2, S - 6), growing up.
// =====================================================================
function atlas(n, paint, matte) {
  const s = K.texScale, c = canvas(1024 * s, 1024 * s), g = c.getContext("2d"), S = 1024 / n;
  g.scale(s, s);
  for (let i = 0; i < n * n; i++) {
    g.save(); g.translate((i % n) * S, ((i / n) | 0) * S); g.beginPath(); g.rect(4, 4, S - 8, S - 8); g.clip();
    g.lineCap = "round"; g.lineJoin = "round"; g.globalAlpha = 1;
    paint(g, i, S); g.restore();
  }
  // transparent texels take the foliage's average colour (no dark fringes in the mipmaps); alpha is firmed up for the alpha test
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data, len = d.length;
  let mr = 0, mg = 0, mb = 0, mn = 0;
  if (matte) { mr = matte[0]; mg = matte[1]; mb = matte[2]; }
  else {
    for (let i = 0; i < len; i += 16) if (d[i + 3] > 200) { mr += d[i]; mg += d[i + 1]; mb += d[i + 2]; mn++; }
    if (mn) { mr = mr / mn | 0; mg = mg / mn | 0; mb = mb / mn | 0; }
  }
  for (let i = 0; i < len; i += 4) {
    let a = d[i + 3];
    if (a < 10) { d[i] = mr; d[i + 1] = mg; d[i + 2] = mb; d[i + 3] = 0; }
    else { a = a * 1.7; d[i + 3] = a > 255 ? 255 : a; }
  }
  const t = new T.DataTexture(new Uint8Array(d.buffer), c.width, c.height, T.RGBAFormat);
  t.encoding = T.sRGBEncoding; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
  t.anisotropy = 8; t.flipY = false; t.needsUpdate = true;
  return t;
}
// cell uv rect (flipY = false: v = canvas y / H). vb = the twig base (cell bottom), vt = the tip.
function cellUV(i, n) {
  const w = 1 / n, cx = (i % n) * w, cy = ((i / n) | 0) * w, p = 0.028 / n;
  return { u0: cx + p, u1: cx + w - p, vb: cy + w - p, vt: cy + p };
}
const UV2 = [0, 1, 2, 3].map(i => cellUV(i, 2)), UV4 = [];
for (let i = 0; i < 16; i++) UV4.push(cellUV(i, 4));

// ---- painters (all in cell pixels; ang 0 = up, + = clockwise) ----
// recursive branchlet: P = { woody, maxDepth, step[], ang, ratio, minLen, stem, stemW, leaf(g, x, y, dx, dy, ang, len, depth) }
function spray(g, x, y, ang, len, depth, P) {
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  let side = R() < 0.5 ? 1 : -1;
  if (depth < P.woody) {
    g.globalAlpha = 1; g.strokeStyle = P.stem; g.lineWidth = Math.max(1.3, P.stemW * Math.pow(0.55, depth));
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx * len, y + dy * len); g.stroke();
  }
  if (depth < P.maxDepth) {
    const step = P.step[depth];
    for (let s = step * (depth ? 0.7 : 1.3); s < len - step * 0.4; s += step * rr(0.8, 1.2)) {
      spray(g, x + dx * s, y + dy * s, ang + side * P.ang * rr(0.85, 1.12), (len - s) * P.ratio * rr(0.8, 1.1) + P.minLen, depth + 1, P);
      side = -side;
    }
  }
  P.leaf(g, x, y, dx, dy, ang, len, depth);
}
// two ranks of needles along a twig (C = { dark[], mid[], tip[] }); brush = chance of forward needles too
function needles(g, x, y, dx, dy, ang, len, s0, nl, sp, lw, C, brush, splay) {
  splay = splay || 1;
  for (let s = s0; s < len + 1; s += sp) {
    const t = s / len, px = x + dx * s, py = y + dy * s;
    for (let sd = -1; sd <= 1; sd += 2) {
      const a = ang + sd * rr(0.8, 1.25) * splay * (t > 0.93 ? 0.45 : 1), l = nl * rr(0.72, 1.1) * (t > 0.9 ? 0.8 : 1);
      const c = t > 0.78 ? C.tip : (R() < 0.38 ? C.dark : C.mid);
      g.strokeStyle = pick(c); g.lineWidth = lw * rr(0.8, 1.2);
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(a) * l, py - Math.cos(a) * l); g.stroke();
    }
    if (R() < brush) {
      const a = ang + rr(-0.55, 0.55), l = nl * rr(0.4, 0.75);
      g.strokeStyle = pick(R() < 0.5 ? C.dark : C.mid); g.lineWidth = lw;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(a) * l, py - Math.cos(a) * l); g.stroke();
    }
  }
}
// a tuft of long needles fanning from a point (pines)
function needleTuft(g, x, y, ang, nl, n, fan, lw, C) {
  for (let i = 0; i < n; i++) {
    const a = ang + rr(-fan, fan), l = nl * rr(0.7, 1.08), bend = rr(-0.25, 0.25);
    g.strokeStyle = pick(R() < 0.3 ? C.dark : (R() < 0.75 ? C.mid : C.tip)); g.lineWidth = lw * rr(0.8, 1.25);
    g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.sin(a) * l * 0.55, y - Math.cos(a) * l * 0.55, x + Math.sin(a + bend) * l, y - Math.cos(a + bend) * l); g.stroke();
  }
}
// One simple leaf at (x, y), growing along ang, blade length L. o: { w (half width / L), pos (where the widest point sits, 0.3 ovate ..
// 0.5 elliptic .. 0.65 obovate), tip (0 blunt .. 1 long drip tip), teeth (serration depth), lobes (count per side), lobeD (sinus depth),
// petiole (length / L), col, vein (colour), nv (side veins), gloss, flaw (0..1 chance of spots), fold }
function leaf(g, x, y, ang, L, o) {
  const pl = L * (o.petiole == null ? 0.12 : o.petiole), hw = L * o.w * rr(0.92, 1.08), N = 40, pos = o.pos || 0.4, tip = o.tip || 0;
  const skew = rr(-0.04, 0.04) * L, lob = o.lobes || 0, lobD = o.lobeD || 0, teeth = o.teeth || 0;
  const ex = Math.log(0.5) / Math.log(pos);              // t^ex puts the widest point at pos
  const prof = t => {
    if (t >= 1) return 0;
    let w = Math.pow(Math.sin(Math.PI * Math.pow(t, ex)), 0.8 + tip * 1.4 * t);
    if (tip) w *= 1 - tip * 0.55 * Math.pow(t, 3);
    if (lob) w *= 1 - lobD * (0.5 + 0.5 * Math.cos(t * lob * TAU + 0.6)) * Math.min(1, t * 5) * (1 - 0.3 * t);
    return hw * w;
  };
  g.save(); g.translate(x, y); g.rotate(ang); g.globalAlpha = 1;
  if (pl > 0.5) { g.strokeStyle = o.stalk || o.vein || "#6f7a3a"; g.lineWidth = Math.max(1.2, L * 0.02); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -pl); g.stroke(); }
  g.translate(0, -pl);
  g.beginPath(); g.moveTo(0, 0);
  for (let k = 1; k <= N; k++) { const t = k / N, w = prof(t) * (1 + teeth * ((k % 2) - 0.5)); g.lineTo(w + skew * Math.sin(t * 3.14), -t * L); }
  for (let k = N - 1; k >= 0; k--) { const t = k / N, w = prof(t) * (1 + teeth * ((k % 2) - 0.5)); g.lineTo(-w + skew * Math.sin(t * 3.14), -t * L); }
  g.closePath();
  g.fillStyle = o.col; g.fill();
  g.save(); g.clip();
  g.fillStyle = "rgba(0,0,0,0.13)"; g.fillRect(0, -L, hw * 1.4, L);                 // one half in its own shade (the fold)
  g.fillStyle = "rgba(255,255,200," + (o.gloss ? 0.16 : 0.07) + ")"; g.fillRect(-hw * 1.4, -L, hw * 1.4, L);
  if (o.gloss) { g.fillStyle = "rgba(255,255,235,0.16)"; g.beginPath(); g.ellipse(-hw * 0.45, -L * 0.55, hw * 0.16, L * 0.3, 0.1, 0, TAU); g.fill(); }
  if (o.flaw && R() < o.flaw) for (let k = 0; k < 4; k++) {
    g.fillStyle = pick(["rgba(196,176,60,0.5)", "rgba(150,110,50,0.45)", "rgba(210,200,90,0.4)"]);
    g.beginPath(); g.arc(rr(-hw, hw), -rr(0.1, 0.95) * L, rr(1.5, L * 0.1), 0, TAU); g.fill();
  }
  const nv = o.nv == null ? 7 : o.nv, vc = o.veinDark || "rgba(30,55,20,0.5)";
  for (let k = 0; k < nv; k++) {
    const t = 0.08 + k * (0.8 / nv), t2 = Math.min(0.98, t + (o.veinRise == null ? 0.16 : o.veinRise)), wv = prof(t2) * 0.96;
    g.lineWidth = Math.max(0.7, L * 0.009); g.strokeStyle = vc;
    g.beginPath(); g.moveTo(0, -t * L); g.lineTo(wv, -t2 * L); g.moveTo(0, -t * L); g.lineTo(-wv, -t2 * L); g.stroke();
  }
  g.strokeStyle = o.vein || "rgba(205,220,150,0.9)"; g.lineWidth = Math.max(1, L * 0.016); g.beginPath(); g.moveTo(0, 0); g.lineTo(skew * 0.5, -L * 0.97); g.stroke();
  g.restore(); g.restore();
}
// A twig with alternate (or opposite) leaves filling a cell. o: { n (nodes), L [min, max] (leaf length in px for a 512 cell), leaf (leaf
// opts, or fn(g, x, y, ang, L)), stem, stemW, opp, ang [min, max] (leaf angle off the twig), col() -> fill, sub (side twigs), extra(g, pts) }
function leafySpray(g, S, o) {
  const k0 = S / 512, n = o.n || 7, st = (S * 0.93 - (o.top || S * 0.2)) / n, pts = [];
  let x = S / 2, y = S - 6, a = rr(-0.1, 0.1), side = R() < 0.5 ? 1 : -1;
  for (let k = 0; k < n; k++) {
    pts.push([x, y, a]); x += Math.sin(a) * st; y -= Math.cos(a) * st; a += rr(-0.13, 0.13);
    if (x < S * 0.42) a += 0.1; if (x > S * 0.58) a -= 0.1;
  }
  g.strokeStyle = o.stem || "#4a3a2c"; g.lineWidth = (o.stemW || 5) * k0; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < n; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
  const A = o.ang || [0.7, 1.12], Lr = o.L || [110, 150];
  const one = (p, la, L) => {
    if (typeof o.leaf === "function") o.leaf(g, p[0], p[1], la, L);
    else { const lo = Object.assign({}, o.leaf); lo.col = o.col ? o.col() : lo.col; leaf(g, p[0], p[1], la, L, lo); }
  };
  for (let k = 1; k < n - 1; k++) {
    const L = rr(Lr[0], Lr[1]) * k0 * (1 - 0.18 * k / n);
    one(pts[k], pts[k][2] + side * rr(A[0], A[1]), L);
    if (o.opp || R() < 0.35) one(pts[k], pts[k][2] - side * rr(A[0], A[1]) * 1.05, L * (o.opp ? rr(0.9, 1.05) : rr(0.65, 0.85)));
    side = -side;
  }
  const e = pts[n - 1];
  one(e, e[2] + rr(-0.15, 0.15), rr(Lr[0], Lr[1]) * k0 * 0.8);
  one(e, e[2] + side * rr(0.7, 1.0), rr(Lr[0], Lr[1]) * k0 * 0.8);
  if (o.extra) o.extra(g, pts, k0);
}
// A pinnate frond or compound leaf filling a cell: a rachis with leaflets both sides. o: { n, len (leaflet length / S), w (leaflet half
// width / its length), ang (leaflet angle off the rachis), taper (how much leaflets shorten toward the tip), base (first leaflet at this
// fraction), col() -> fill, rib, curve, twice (bipinnate: each leaflet is itself a small frond), droop }
function frondCell(g, S, o) {
  const n = o.n || 16, x0 = S / 2, y0 = S - 6, H = S * 0.93, curve = (o.curve || 0) * rr(-1, 1);
  const P = t => [x0 + curve * S * t * t, y0 - H * t];
  g.strokeStyle = o.rib || "#5a6a2c"; g.lineWidth = Math.max(1.5, S * (o.ribW || 0.012)); g.beginPath(); g.moveTo(x0, y0);
  for (let k = 1; k <= 12; k++) { const p = P(k / 12); g.lineTo(p[0], p[1]); } g.stroke();
  const b = o.base == null ? 0.12 : o.base;
  for (let k = 0; k < n; k++) {
    const t = b + (1 - b) * (k + 0.5) / n, p = P(t), shape = Math.pow(Math.sin(Math.PI * Math.pow(t, o.peak || 0.7)), o.taper == null ? 0.7 : o.taper);
    const L = S * (o.len || 0.3) * (0.25 + 0.75 * shape) * rr(0.9, 1.08);
    for (let sd = -1; sd <= 1; sd += 2) {
      const a = sd * ((o.ang || 1.15) - 0.45 * t * (o.sweep == null ? 1 : o.sweep)) + rr(-0.06, 0.06) + curve * t * 0.8;
      if (o.twice) {
        g.save(); g.translate(p[0], p[1]); g.rotate(a);
        g.strokeStyle = o.rib || "#5a6a2c"; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -L); g.stroke();
        const m = Math.max(4, (L / (S * 0.02)) | 0);
        for (let j = 0; j < m; j++) for (let s2 = -1; s2 <= 1; s2 += 2) {
          const tt = (j + 0.6) / m, l2 = L * 0.24 * (1 - 0.5 * tt);
          g.fillStyle = o.col(); g.beginPath(); g.ellipse(s2 * l2 * 0.5, -tt * L, l2 * 0.52, l2 * (o.w || 0.3), s2 * 0.25, 0, TAU); g.fill();
        }
        g.restore();
      } else {
        g.save(); g.translate(p[0], p[1]); g.rotate(a);
        const hw = L * (o.w || 0.12);
        g.fillStyle = o.col(); g.beginPath(); g.moveTo(0, 0);
        g.quadraticCurveTo(hw * 1.5, -L * 0.35, sd * L * (o.droop || 0) * 0.3, -L); g.quadraticCurveTo(-hw * 1.5, -L * 0.35, 0, 0); g.fill();
        if (o.mid) { g.strokeStyle = o.mid; g.lineWidth = 0.8; g.beginPath(); g.moveTo(0, 0); g.lineTo(sd * L * (o.droop || 0) * 0.3, -L * 0.96); g.stroke(); }
        g.restore();
      }
    }
  }
}
// A clump of grass blades filling a cell. o: { n, h [min, max] (fraction of S), w (blade width px at S = 256), lean, col() -> stroke,
// curl, head(g, x, y, ang, k0) (a seed head drawn at some blade tips), headP (chance), dead (fraction of straw blades), deadCol() }
function bladeCell(g, S, o) {
  const k0 = S / 256, n = o.n || 34, x0 = S / 2, y0 = S - 5, heads = [];
  for (let i = 0; i < n; i++) {
    const u = (i + R()) / n * 2 - 1, bx = x0 + u * S * (o.base == null ? 0.16 : o.base), h = S * rr(o.h[0], o.h[1]) * (1 - 0.25 * Math.abs(u));
    const lean = u * (o.lean == null ? 0.5 : o.lean) + rr(-0.18, 0.18), curl = (o.curl || 0.25) * rr(0.3, 1.4) * (lean < 0 ? -1 : 1);
    const mx = bx + Math.sin(lean) * h * 0.55, my = y0 - Math.cos(lean) * h * 0.55;
    let ex = bx + Math.sin(lean + curl) * h, ey = y0 - Math.cos(lean + curl) * h;
    ex = Math.max(8, Math.min(S - 8, ex)); ey = Math.max(8, ey);
    const dead = R() < (o.dead || 0), w = (o.w || 3) * k0 * rr(0.7, 1.25);
    g.strokeStyle = dead ? o.deadCol() : o.col(); g.lineCap = "round";
    // tapering blade: three strokes of decreasing width
    for (let q = 0; q < 3; q++) {
      const f = [1, 0.72, 0.4][q];
      g.lineWidth = w * [1, 0.7, 0.36][q];
      g.beginPath(); g.moveTo(bx, y0);
      g.quadraticCurveTo(mx, my, mx + (ex - mx) * (f * 1.0), my + (ey - my) * f); g.stroke();
      if (q === 0) { g.strokeStyle = dead ? o.deadCol() : o.col(); }
    }
    if (o.head && R() < (o.headP == null ? 0.2 : o.headP)) heads.push([ex, ey, lean + curl]);
  }
  for (const hd of heads) o.head(g, hd[0], hd[1], hd[2], k0);
}
// A flowering stem filling a cell. o: { h (fraction of S), stem, leaves (n), leafO (leaf opts), leafL (px at 256), head(g, x, y, ang, k0),
// heads (n; extra ones on side stalks), basal (n basal leaves) }
function flowerCell(g, S, o) {
  const k0 = S / 256, x0 = S / 2 + rr(-8, 8) * k0, y0 = S - 5, h = S * (o.h || 0.8) * rr(0.88, 1), lean = rr(-0.1, 0.1), bend = rr(-0.12, 0.12);
  const P = t => [x0 + Math.sin(lean + bend * t) * h * t, y0 - Math.cos(lean + bend * t) * h * t];
  for (let i = 0; i < (o.basal || 0); i++) {
    const a = rr(-1.25, 1.25), lo = Object.assign({}, o.leafO); lo.col = o.leafCol ? o.leafCol() : lo.col;
    leaf(g, x0 + rr(-4, 4) * k0, y0, a, (o.basalL || o.leafL || 60) * k0 * rr(0.75, 1.1), lo);
  }
  g.strokeStyle = o.stem || "#5c7a34"; g.lineWidth = (o.stemW || 2.6) * k0; g.beginPath(); g.moveTo(x0, y0);
  for (let k = 1; k <= 8; k++) { const p = P(k / 8); g.lineTo(p[0], p[1]); } g.stroke();
  let side = R() < 0.5 ? 1 : -1;
  for (let i = 0; i < (o.leaves || 0); i++) {
    const t = 0.1 + 0.6 * (i + 0.5) / o.leaves, p = P(t), lo = Object.assign({}, o.leafO); lo.col = o.leafCol ? o.leafCol() : lo.col;
    leaf(g, p[0], p[1], side * rr(0.6, 1.1), (o.leafL || 50) * k0 * (1 - 0.4 * t) * rr(0.85, 1.1), lo);
    if (o.opp) leaf(g, p[0], p[1], -side * rr(0.6, 1.1), (o.leafL || 50) * k0 * (1 - 0.4 * t) * rr(0.85, 1.1), lo);
    side = -side;
  }
  for (let i = 1; i < (o.heads || 1); i++) {
    const t = rr(0.5, 0.8), p = P(t), a = side * rr(0.4, 0.8), l = h * rr(0.18, 0.3), ex = p[0] + Math.sin(a) * l, ey = p[1] - Math.cos(a) * l;
    g.strokeStyle = o.stem || "#5c7a34"; g.lineWidth = (o.stemW || 2.6) * k0 * 0.7; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(ex, ey); g.stroke();
    o.head(g, ex, ey, a, k0 * 0.85); side = -side;
  }
  const e = P(1);
  if (o.head) o.head(g, e[0], e[1], lean + bend, k0);
}
// flower heads for flowerCell / bladeCell (each returns a head(g, x, y, ang, k0) painter)
const heads = {
  // ray flower: petals around a disc (coneflower droop > 0, daisies, sunflowers, asters)
  daisy(petal, disc, r, n, droop, discR) {
    return (g, x, y, ang, k0) => {
      const Rr = r * k0;
      g.save(); g.translate(x, y); g.rotate(ang);
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU + rr(-0.1, 0.1), l = Rr * rr(0.85, 1.1), sq = 1 - (droop || 0) * 0.6;
        g.save(); g.rotate(a); g.scale(1, 1); g.fillStyle = pick(petal);
        g.beginPath(); g.ellipse(0, -l * 0.55 * (Math.cos(a) > 0 ? sq : 1), l * 0.17, l * 0.5, 0, 0, TAU); g.fill(); g.restore();
      }
      g.fillStyle = disc; g.beginPath(); g.ellipse(0, -(droop || 0) * Rr * 0.25, Rr * (discR || 0.3), Rr * (discR || 0.3) * (1 + (droop || 0) * 0.5), 0, 0, TAU); g.fill();
      g.fillStyle = "rgba(255,230,160,0.35)"; for (let i = 0; i < 10; i++) { g.beginPath(); g.arc(rr(-1, 1) * Rr * 0.2, rr(-1, 1) * Rr * 0.2 - (droop || 0) * Rr * 0.25, 0.8 * k0, 0, TAU); g.fill(); }
      g.restore();
    };
  },
  // a raceme / spike of florets (lupine, fireweed, heather, bistort, cattail with one dark colour)
  spike(cols, len, w, n, o) {
    o = o || {};
    return (g, x, y, ang, k0) => {
      g.save(); g.translate(x, y); g.rotate(ang);
      const L = len * k0;
      for (let i = 0; i < n; i++) {
        const t = i / n, yy = L * 0.25 - t * L, ww = w * k0 * (o.club ? 1 : (1 - 0.75 * t)) * rr(0.8, 1.1);
        for (let sd = -1; sd <= 1; sd += 2) {
          g.fillStyle = pick(t > 0.8 && o.bud ? o.bud : cols);
          g.beginPath(); g.ellipse(sd * ww * 0.5, yy, ww * 0.62, Math.max(1.2 * k0, L / n * 0.75), sd * 0.5, 0, TAU); g.fill();
        }
      }
      g.restore();
    };
  },
  // a cup / poppy: few broad petals
  cup(cols, r, centre) {
    return (g, x, y, ang, k0) => {
      const Rr = r * k0;
      g.save(); g.translate(x, y); g.rotate(ang);
      for (let i = 0; i < 5; i++) { const a = -0.9 + i * 0.45; g.fillStyle = pick(cols); g.beginPath(); g.ellipse(Math.sin(a) * Rr * 0.45, -Math.cos(a) * Rr * 0.45, Rr * 0.5, Rr * 0.62, a, 0, TAU); g.fill(); }
      if (centre) { g.fillStyle = centre; g.beginPath(); g.arc(0, -Rr * 0.2, Rr * 0.2, 0, TAU); g.fill(); }
      g.restore();
    };
  },
  // a fluffy ball or plume (cotton grass, dandelion clock, pampas plumes with long = 1)
  puff(cols, r, long) {
    return (g, x, y, ang, k0) => {
      const Rr = r * k0;
      g.save(); g.translate(x, y); g.rotate(ang);
      for (let i = 0; i < 60; i++) {
        const a = rr(0, TAU), d = Math.sqrt(R()) * Rr;
        g.strokeStyle = pick(cols); g.globalAlpha = rr(0.5, 0.95); g.lineWidth = rr(0.8, 1.8) * k0;
        const px = Math.cos(a) * d * (long ? 0.4 : 1), py = Math.sin(a) * d * (long ? 1.6 : 1) - (long ? Rr : 0);
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + rr(-2, 2) * k0, py - rr(1, 5) * k0); g.stroke();
      }
      g.globalAlpha = 1; g.restore();
    };
  },
  // an open panicle of small spikelets (bluestem's turkey foot with n = 3, oat grass, fescues)
  panicle(cols, len, n, spread) {
    return (g, x, y, ang, k0) => {
      for (let i = 0; i < n; i++) {
        const a = ang + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0) + rr(-0.08, 0.08), L = len * k0 * rr(0.8, 1.1);
        g.strokeStyle = pick(cols); g.lineWidth = 1.1 * k0;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * L, y - Math.cos(a) * L); g.stroke();
        for (let s = 0.15; s < 1; s += 0.11) {
          g.fillStyle = pick(cols);
          g.beginPath(); g.ellipse(x + Math.sin(a) * L * s, y - Math.cos(a) * L * s, 1.5 * k0, 3.4 * k0, a + rr(-0.5, 0.5), 0, TAU); g.fill();
        }
      }
    };
  },
};

// =====================================================================
//  MATERIALS
// =====================================================================
const U = BF.real.U;
const lit = (m, key) => (BF.real.lit ? BF.real.lit(m, { light: "cell", key: "akit-" + key }) : m);
const WIND_GLSL = [
  "#ifdef USE_INSTANCING",
  "  float wPh = instanceMatrix[3][0] * 0.31 + instanceMatrix[3][2] * 0.17;",
  "#else",
  "  float wPh = 0.0;",
  "#endif",
  "float wA = aWind.x * (0.35 + 2.0 * uWind.z); float wP = aWind.y + wPh;",
  "float wG = 0.6 + 0.4 * sin(uTime * 0.31 + wPh * 0.5);",
  "transformed.x += wA * wG * (sin(uTime * 1.7 + wP) * 0.05 + sin(uTime * 4.3 + wP * 2.3) * 0.012);",
  "transformed.z += wA * wG * (cos(uTime * 1.3 + wP * 1.3) * 0.04 + sin(uTime * 3.7 + wP * 1.9) * 0.012);",
  "transformed.y += wA * wG * sin(uTime * 2.1 + wP * 1.7) * 0.025;",
].join("\n");
const TRANS_GLSL = [
  "{",
  "  vec3 tV = normalize( vViewPosition );",
  "  vec3 tS = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );",
  "  float tB = clamp( dot( -tV, tS ), 0.0, 1.0 );",
  "  tB = tB * tB;",
  "  totalEmissiveRadiance += diffuseColor.rgb * uSunCol * vec3( 0.45, 0.43, 0.19 ) * ( uTrans * tB * clamp( vBFL.x, 0.0, 1.0 ) );",
  "}",
].join("\n");
// alpha-tested, double-sided foliage: sways by the aWind attribute (x = amount, y = phase) with the shared time and wind, glows when
// back-lit by the sun (trans), keeps its bent normals on back faces, and is lit like everything else (BF.real.lit, cell light)
function foliageMat(tex, trans, rough) {
  const m = new T.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: T.DoubleSide, roughness: rough == null ? 0.78 : rough, metalness: 0, vertexColors: true });
  m.onBeforeCompile = function (sh) {
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    sh.uniforms.uTime = U.uTime; sh.uniforms.uWind = U.uWind;
    vs = "attribute vec2 aWind;\nuniform float uTime;\nuniform vec3 uWind;\n" + vs.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + WIND_GLSL);
    sh.uniforms.uSunDir = U.uSunDir; sh.uniforms.uSunCol = U.uSunCol; sh.uniforms.uTrans = { value: trans || 0 };
    fs = "uniform vec3 uSunDir;\nuniform vec3 uSunCol;\nuniform float uTrans;\n" + fs.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + TRANS_GLSL);
    if (T.ShaderChunk && T.ShaderChunk.normal_fragment_begin) {
      fs = fs.replace("#include <normal_fragment_begin>", T.ShaderChunk.normal_fragment_begin.replace(/normal\s*=\s*normal\s*\*\s*faceDirection\s*;/, ""));
    }
    sh.vertexShader = vs; sh.fragmentShader = fs;
  };
  return lit(m, "foliage");
}
function depthMat(tex) { return new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: tex, alphaTest: 0.4, side: T.DoubleSide }); }

// =====================================================================
//  GEOMETRY
// =====================================================================
function Geo() { this.p = []; this.n = []; this.u = []; this.c = []; this.w = []; this.i = []; this.nv = 0; }
function toGeo(G, fol) {
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(G.p, 3));
  g.setAttribute("normal", new T.Float32BufferAttribute(G.n, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(G.u, 2));
  g.setAttribute("color", new T.Float32BufferAttribute(G.c, 3));
  if (fol) g.setAttribute("aWind", new T.Float32BufferAttribute(G.w, 2));
  g.setIndex(G.i);
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}
const _tan = new V3(), _nx = new V3(), _bx = new V3();
// a tube along pts with radii rad. o: { v0, col(k, p) -> [r, g, b], flare(a, y) -> radius factor, urep (texture repeats around), cap }
function tube(B, pts, rad, seg, o) {
  o = o || {};
  const n = pts.length, base = B.nv, urep = o.urep || Math.max(1, Math.round(TAU * rad[0] / BW));
  let v = o.v0 || 0;
  for (let k = 0; k < n; k++) {
    if (k === 0) _tan.subVectors(pts[1], pts[0]); else if (k === n - 1) _tan.subVectors(pts[k], pts[k - 1]); else _tan.subVectors(pts[k + 1], pts[k - 1]);
    _tan.normalize();
    if (k === 0) { if (Math.abs(_tan.x) > 0.9) _nx.set(0, 0, 1); else _nx.set(1, 0, 0); }
    _nx.addScaledVector(_tan, -_nx.dot(_tan)).normalize(); _bx.crossVectors(_tan, _nx);
    if (k > 0) v += pts[k].distanceTo(pts[k - 1]) / BH;
    const p = pts[k], cl = o.col ? o.col(k, p) : WHITE;
    for (let j = 0; j <= seg; j++) {
      const a = j / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      let r = rad[k]; if (o.flare) r *= o.flare(a, p.y, k);
      const x = _nx.x * ca + _bx.x * sa, y = _nx.y * ca + _bx.y * sa, z = _nx.z * ca + _bx.z * sa;
      B.p.push(p.x + x * r, p.y + y * r, p.z + z * r); B.n.push(x, y, z); B.u.push(j / seg * urep, v); B.c.push(cl[0], cl[1], cl[2]);
    }
  }
  for (let k = 0; k < n - 1; k++) for (let j = 0; j < seg; j++) { const a = base + k * (seg + 1) + j, b = a + seg + 1; B.i.push(a, a + 1, b, a + 1, b + 1, b); }
  B.nv += n * (seg + 1);
}
// a wandering path of n steps from o along d; bendFn(t) is added to the direction's y each step
function path(o, d, len, n, bendFn, jit) {
  const pts = [o.clone()], dir = d.clone().normalize(), st = len / n;
  let p = o.clone();
  for (let k = 1; k <= n; k++) {
    dir.y += bendFn((k - 0.5) / n); dir.x += rr(-jit, jit); dir.z += rr(-jit, jit); dir.normalize();
    p = p.clone().addScaledVector(dir, st); pts.push(p);
  }
  return pts;
}
function at(pts, t, P, D) {
  const n = pts.length - 1, f = Math.min(n - 1e-4, Math.max(0, t * n)), i = f | 0;
  P.lerpVectors(pts[i], pts[i + 1], f - i); D.subVectors(pts[i + 1], pts[i]).normalize();
}
// A foliage card: rows of vertices along dir (bent down by droop), 2 or 3 columns (vee != 0: folded along the twig). Normals point
// away from the crown centre cc ({ x, y, z, rx, ry }), so a crown is lit as one soft volume. bw = sway at the base; rows defaults to 3.
function card(F, P, dir, len, wid, cell, droop, vee, roll, cc, col, bw, rows) {
  let sx = -dir.z, sz = dir.x, sy = 0, sl = Math.sqrt(sx * sx + sz * sz);
  if (sl < 1e-3) { sx = 1; sz = 0; sl = 1; }
  sx /= sl; sz /= sl;
  let nx = -sz * dir.y, ny = sz * dir.x - sx * dir.z, nz = sx * dir.y;          // side x dir (up-ish)
  if (roll) {
    const cr = Math.cos(roll), sr = Math.sin(roll), tx = sx * cr + nx * sr, ty = ny * sr, tz = sz * cr + nz * sr;
    nx = nx * cr - sx * sr; ny = ny * cr; nz = nz * cr - sz * sr; sx = tx; sy = ty; sz = tz;
  }
  const nr = rows || 3, nc = vee ? 3 : 2, hw = wid * 0.5, cv = Math.cos(vee), sv = Math.sin(vee), base = F.nv, ph = R() * TAU;
  for (let r = 0; r < nr; r++) {
    const t = r / (nr - 1);
    const cx = P.x + dir.x * len * t, cy = P.y + dir.y * len * t - droop * len * t * t, cz = P.z + dir.z * len * t;
    for (let c = 0; c < nc; c++) {
      const cc2 = nc === 3 ? c - 1 : c * 2 - 1, e = Math.abs(cc2);
      const px = cx + sx * hw * cc2 * cv + nx * hw * e * sv, py = cy + sy * hw * cc2 * cv + ny * hw * e * sv, pz = cz + sz * hw * cc2 * cv + nz * hw * e * sv;
      const ox = (px - cc.x) / cc.rx + nx * 0.3, oy = (py - cc.y) / cc.ry + 0.35 + ny * 0.3, oz = (pz - cc.z) / cc.rx + nz * 0.3;
      const ol = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      F.p.push(px, py, pz); F.n.push(ox / ol, oy / ol, oz / ol);
      F.u.push(cell.u0 + (cell.u1 - cell.u0) * (cc2 + 1) * 0.5, cell.vb + (cell.vt - cell.vb) * t);
      const k = 1 + 0.12 * t;
      F.c.push(col[0] * k, col[1] * k, col[2] * k);
      F.w.push(bw + t * (0.45 + 0.55 * e), ph);
    }
  }
  for (let r = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++) { const a = base + r * nc + c, b = a + nc; F.i.push(a, a + 1, b, a + 1, b + 1, b); }
  F.nv += nr * nc;
}
const fcol = ao => [ao * rr(0.88, 1.06), ao * rr(0.92, 1.08), ao * rr(0.82, 1.02)];
const dirOf = (az, e) => new V3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e));

// ---------------------------------------------------------------- broadleaf recursion
// S: { maxD, n[], seg[], kids[], ratio, spread, up, jit, bend[] (number or fn(t)), t0, cards, cardLen, cardW, cells[], flat, droop,
//      col[] (wood tint per depth), moss, flatTop (y above which twigs level off: umbrella crowns), hang (cards hang straight down) }
function branch(B, F, S, o, d, len, r, depth, cc) {
  const n = S.n[depth], seg = S.seg[depth], rad = [], P = new V3(), D = new V3(), sd = new V3(), up = new V3(), dir = new V3();
  const bd = S.bend[depth], bendFn = typeof bd === "function" ? t => bd(t) * (3 / n) : () => bd * (3 / n);
  const pts = path(o, d, len, n, S.flatTop == null ? bendFn : t => bendFn(t), S.jit);
  if (S.flatTop != null) for (const p of pts) if (p.y > S.flatTop) p.y = S.flatTop + (p.y - S.flatTop) * 0.25;
  for (let k = 0; k <= n; k++) rad.push(Math.max(0.005, r * (1 - 0.72 * k / n)));
  const c0 = S.col[Math.min(depth, S.col.length - 1)];
  tube(B, pts, rad, seg, { col: S.moss && depth === 0 ? (kk, pp) => { const m = Math.max(0, 1 - pp.y); return [c0[0] * (1 - 0.25 * m), c0[1] * (1 + 0.2 * m), c0[2] * (1 - 0.4 * m)]; } : () => c0 });
  function perp(Dv, spread) {
    sd.set(-Dv.z, 0, Dv.x); if (sd.lengthSq() < 1e-4) sd.set(1, 0, 0); sd.normalize(); up.crossVectors(Dv, sd);
    _phi += 2.4 + rr(-0.4, 0.4);
    const cs = Math.cos(_phi), sn = Math.sin(_phi);
    dir.set(sd.x * cs + up.x * sn, sd.y * cs + up.y * sn, sd.z * cs + up.z * sn).multiplyScalar(Math.sin(spread)).addScaledVector(Dv, Math.cos(spread));
    return dir;
  }
  if (depth >= S.maxD) {
    for (let k = 0; k < S.cards; k++) {
      const t = S.cards > 1 ? 0.2 + 0.8 * k / (S.cards - 1) : 1;
      at(pts, t, P, D);
      perp(D, k === S.cards - 1 ? 0.25 : rr(0.7, 1.2));
      if (S.hang) { dir.x *= 0.25; dir.z *= 0.25; dir.y = -1; }
      else if (S.flat) dir.y = dir.y * 0.3 + 0.02; else dir.y -= 0.22;
      dir.normalize();
      const cl = S.cardLen * rr(0.82, 1.18);
      const hd = Math.sqrt((P.x - cc.x) * (P.x - cc.x) + (P.z - cc.z) * (P.z - cc.z)) / cc.rx, ao = Math.min(1.08, 0.62 + 0.42 * hd + 0.12 * (P.y - cc.y) / cc.ry);
      card(F, P, dir, cl, cl * (S.cardW || 0.98), (S.uv || UV2)[S.cells[(R() * S.cells.length) | 0]], S.droop * rr(0.5, 1.5), 0, S.flat ? rr(-0.35, 0.35) : rr(-1.1, 1.1), cc, fcol(ao), 0.35 + 0.3 * t);
    }
    return;
  }
  const nch = S.kids[depth];
  for (let k = 0; k < nch; k++) {
    const t = S.t0 + (1 - S.t0) * (k + rr(0.15, 0.85)) / nch;
    at(pts, t, P, D);
    perp(D, S.spread * rr(0.8, 1.2)); dir.y += S.up; dir.normalize();
    branch(B, F, S, P.clone(), dir.clone(), len * S.ratio * rr(0.75, 1.12) * (1 - 0.3 * t), Math.max(0.006, r * (1 - 0.72 * t) * 0.62), depth + 1, cc);
  }
  at(pts, 1, P, D);
  branch(B, F, S, P.clone(), D.clone(), len * 0.3, r * 0.26, S.maxD, cc);
}
// A broadleaf tree: a trunk with primary limbs, each a branch() recursion. sp: { h (total height), r (trunk radius at the ground),
// trunk (fraction of h the trunk runs before it is all crown; short = spreading), lean, jit, np (primary limbs), t0 (lowest limb, as a
// fraction of the trunk), e0, e1 (limb elevation at the lowest / highest limb), len (limb length / h), lenTop (factor at the top limb),
// flare, flareH, lobes (buttress lobes), base [r, g, b] tint low on the trunk, crown { y, rx, ry } (fractions of h), stems (several
// trunks from the ground), S (the recursion, depth 1 = primary limbs), top (length of the leader's own recursion) }
function broadleaf(sp, detail) {
  const B = new Geo(), F = new Geo(), H = sp.h, S = sp.S, P = new V3(), D = new V3();
  const cc = { x: 0, y: H * (sp.crown ? sp.crown.y : 0.68), z: 0, rx: H * (sp.crown ? sp.crown.rx : 0.35), ry: H * (sp.crown ? sp.crown.ry : 0.36) };
  const SS = detail ? S : K.low
    ? Object.assign({}, S, { seg: S.seg.map(() => 3), n: S.n.map(v => Math.min(v, 3)), kids: S.kids.map(k => Math.max(2, k - 1)), cards: Math.max(2, Math.round(S.cards * 0.4)), cardLen: S.cardLen * 2.0 })
    : Object.assign({}, S, { seg: S.seg.map(s => Math.max(3, s - 2)), cards: Math.max(2, Math.round(S.cards * 0.6)), cardLen: S.cardLen * 1.45 });
  const stems = sp.stems || 1, ph = rr(0, TAU);
  let az = rr(0, TAU);
  for (let s = 0; s < stems; s++) {
    const sa = s / stems * TAU + rr(-0.3, 0.3), off = stems > 1 ? sp.r * 0.9 : 0, lean = stems > 1 ? rr(0.18, 0.38) : (sp.lean || 0) * rr(0.3, 1);
    const la = stems > 1 ? sa : rr(0, TAU), n = 9, TH = H * sp.trunk * (stems > 1 ? rr(0.8, 1.1) : 1), r0 = sp.r * (stems > 1 ? 0.62 : 1), tr = [];
    const tp = path(new V3(Math.cos(sa) * off, -0.5, Math.sin(sa) * off), new V3(Math.cos(la) * lean, 1, Math.sin(la) * lean), TH + 0.5, n, () => sp.rise || 0.02, sp.jit == null ? 0.045 : sp.jit);
    const taper = sp.taper == null ? 0.6 : sp.taper;
    for (let k = 0; k <= n; k++) tr.push(r0 * (1 - taper * k / n) + 0.012);
    const fl = sp.flare || 0.5, fh = sp.flareH || 0.35, lob = sp.lobes || 0;
    const flare = (a, y) => 1 + fl * Math.exp(-Math.max(0, y) / fh) * (lob ? 0.4 + 0.6 * Math.pow(Math.abs(Math.cos(a * lob * 0.5 + ph)), 1.5) : 1);
    const bc = sp.base || [0.7, 0.95, 0.5];
    const tcol = (kk, pp) => { const m = Math.max(0, 1 - Math.max(0, pp.y) / 1.1) * 0.8, q = rr(0.94, 1.04); return [q * (1 - m * (1 - bc[0])), q * (1 - m * (1 - bc[1])), q * (1 - m * (1 - bc[2]))]; };
    tube(B, tp.slice(0, 5), tr.slice(0, 5), detail ? 12 : 7, { flare, col: tcol });
    tube(B, tp.slice(4), tr.slice(4), detail ? 8 : 5, { col: tcol, v0: TH * 0.45 / BH });
    const np = Math.max(1, Math.round(sp.np / (stems > 1 ? stems * 0.6 : 1)));
    for (let k = 0; k < np; k++) {
      const t = sp.t0 + (1 - sp.t0) * (k + R() * 0.5) / np, tc = np > 1 ? k / (np - 1) : 1;
      at(tp, t, P, D);
      az += 2.4 + rr(-0.4, 0.4);
      const e = sp.e0 + (sp.e1 - sp.e0) * tc + rr(-0.1, 0.1);
      const L = H * sp.len * (1 - (1 - (sp.lenTop == null ? 0.55 : sp.lenTop)) * tc) * rr(0.8, 1.15);
      branch(B, F, SS, P.clone(), dirOf(stems > 1 ? sa + rr(-1.2, 1.2) : az, e), L, Math.max(0.012, (r0 * (1 - taper * t)) * (sp.limbR || 0.5)), 1, cc);
    }
    at(tp, 1, P, D);
    branch(B, F, SS, P.clone(), D.clone(), sp.top == null ? H * 0.12 : sp.top, Math.max(0.01, tr[n] * 0.8), Math.min(SS.maxD, 2), cc);
  }
  return { b: toGeo(B, false), f: toGeo(F, true) };
}

// ---------------------------------------------------------------- conifers (whorled limbs with needle cards)
// sp: { h, r, clear (fraction of bare bole), L (lowest limb length), pw, low, dy (whorl spacing), gap, card, cw, cardY, droop, vee, fwd,
//       flare, flareH, lobes, e0, e1, stubs, leader, bend(t, tc), cells }
function conifer(sp, detail) {
  const B = new Geo(), F = new Geo(), H = sp.h, r0 = sp.r, nT = 17, tp = [], tr = [];
  const wob = rr(0, TAU), ph = rr(0, TAU), la = rr(0, TAU), sw = sp.sway == null ? 0.28 : sp.sway;
  for (let k = 0; k <= nT; k++) {
    const t = k === 0 ? 0 : Math.pow((k - 1) / (nT - 1), 1.7), y = k === 0 ? -0.7 : H * t;
    const p = new V3(Math.sin(y * 0.11 + wob) * sw * t, y, Math.cos(y * 0.09 + wob * 1.7) * sw * t);
    if (sp.leader && k >= nT - 1) { const lo = k === nT ? 1.0 : 0.25; p.x += Math.cos(la) * lo * H / 32; p.z += Math.sin(la) * lo * H / 32; if (k === nT) p.y -= 0.55 * H / 32; }
    tp.push(p); tr.push(r0 * Math.pow(Math.max(0, 1 - t), sp.taper || 0.85) + 0.025);
  }
  const flare = (a, yy) => 1 + sp.flare * Math.exp(-Math.max(0, yy) / sp.flareH) * (0.4 + 0.6 * Math.pow(Math.abs(Math.cos(a * sp.lobes * 0.5 + ph)), 1.5));
  const bc = sp.base || [0.7, 1.25, 0.5];
  const tcol = (kk, pp) => { const m = Math.max(0, 1 - Math.max(0, pp.y) / 1.6) * 0.75, q = rr(0.92, 1.05); return [q * (1 - m * (1 - bc[0])), q * (1 - m * (1 - bc[1])), q * (1 - m * (1 - bc[2]))]; };
  tube(B, tp.slice(0, 9), tr.slice(0, 9), detail ? 14 : 8, { flare, col: tcol });
  tube(B, tp.slice(8), tr.slice(8), detail ? 8 : 5, { col: tcol, v0: 3.1 });
  function trunkAt(yy, out) {
    let q = 1;
    for (; q < nT; q++) if (tp[q + 1].y >= yy) break;
    if (q >= nT) q = nT - 1;
    const f = Math.min(1, Math.max(0, (yy - tp[q].y) / (tp[q + 1].y - tp[q].y || 1))); out.lerpVectors(tp[q], tp[q + 1], f);
    return tr[q] + (tr[q + 1] - tr[q]) * f;
  }
  const cb = H * sp.clear * rr(0.9, 1.1), cc = { x: 0, y: (cb + H) * 0.5, z: 0, rx: sp.L * 0.9, ry: (H - cb) * 0.55 };
  const O = new V3(), P = new V3(), D = new V3(), Sd = new V3(), dir = new V3(), limbC = [0.8, 0.78, 0.74], cells = sp.cells || [0, 1, 2, 3];
  let az = rr(0, TAU);
  if (detail) for (let k = 0; k < (sp.stubs || 0); k++) {
    const y = cb * rr(0.45, 0.98), rt = trunkAt(y, O); az += 2.4;
    const pts = path(O.clone(), dirOf(az, rr(-0.3, 0.2)), rr(0.3, 1.2) * Math.min(1, H / 20) + rt, 2, () => -0.1, 0.08);
    tube(B, pts, [0.05, 0.035, 0.012], 4, { col: () => [0.6, 0.6, 0.6] });
  }
  let y = cb;
  const dyl = sp.dy * (detail ? 1 : K.low ? 2.4 : 1.5), topGap = Math.min(0.7, H * 0.05);
  while (y < H - topGap) {
    const tc = (y - cb) / (H - cb);
    if (R() < sp.gap && tc < 0.8) { y += dyl; az += 1.3; continue; }
    const L = sp.L * Math.pow(1 - tc, sp.pw) * Math.min(1, 0.4 + tc * sp.low) * rr(0.62, 1.12) + (sp.minL == null ? 0.45 : sp.minL);
    az += 2.4 + rr(-0.5, 0.5);
    const rt = trunkAt(y, O), e = sp.e0 + sp.e1 * tc + rr(-0.12, 0.12), n = detail ? 5 : 3;
    const pts = path(O.clone(), dirOf(az, e), L, n, tt => sp.bend(tt, tc) * (5 / n), 0.035);
    const rad = [], lr = Math.min(rt * 0.6, 0.02 + 0.017 * L);
    for (let k = 0; k <= n; k++) rad.push(lr * (1 - 0.86 * k / n) + 0.007);
    tube(B, pts, rad, detail ? 4 : 3, { col: () => limbC });
    const cl = sp.card * (detail ? 1 : K.low ? 2.1 : 1.5), ns = Math.max(2, Math.round(L / (cl * (detail ? 0.5 : 0.42))));
    let side = R() < 0.5 ? 1 : -1;
    for (let s = 0; s < ns; s++) {
      const t = Math.min(0.97, 0.2 + 0.8 * (s + R() * 0.6) / ns);
      at(pts, t, P, D);
      Sd.set(-D.z, 0, D.x); if (Sd.lengthSq() < 1e-4) Sd.set(1, 0, 0); Sd.normalize();
      const len = cl * rr(0.8, 1.15) * (1 - 0.3 * t);
      dir.copy(D).multiplyScalar(sp.fwd).addScaledVector(Sd, side * rr(0.75, 1.1)); dir.y += sp.cardY + rr(-0.15, 0.15); dir.normalize();
      const ao = (0.55 + 0.45 * t) * (0.8 + 0.2 * tc);
      card(F, P, dir, len, len * sp.cw, UV2[pick(cells)], sp.droop * rr(0.7, 1.3), detail ? sp.vee : 0, rr(-0.25, 0.25), cc, fcol(ao), 0.25 * t);
      side = -side;
    }
    at(pts, 1, P, D); P.addScaledVector(D, -0.12 * cl);
    dir.copy(D); dir.y += sp.cardY * 0.4; dir.normalize();
    card(F, P, dir, cl * rr(0.85, 1.1), cl * sp.cw, UV2[pick(cells)], sp.droop * 0.8, detail ? sp.vee : 0, rr(-0.2, 0.2), cc, fcol(0.95 + 0.1 * tc), 0.3);
    if (sp.moss && R() < sp.moss.p && tc < 0.8) {           // hanging epiphyte cards (Spanish moss, lichen beards)
      at(pts, rr(0.35, 0.9), P, D); dir.set(rr(-0.1, 0.1), -1, rr(-0.1, 0.1)).normalize();
      card(F, P, dir, sp.moss.len * rr(0.6, 1.3), sp.moss.len * 0.45, UV2[sp.moss.cell], -0.05, 0, rr(-1.5, 1.5), cc, [0.9, 0.9, 0.9], 0.5);
    }
    y += dyl * rr(0.7, 1.3) * (1 - 0.25 * tc);
  }
  at(tp, 1, P, D);
  for (let k = 0; k < 5; k++) {
    az += 1.3; P.copy(tp[nT]); P.y -= k * 0.22 * Math.min(1, H / 16);
    if (sp.leader) { dir.copy(D); dir.x += Math.cos(az) * 0.5; dir.z += Math.sin(az) * 0.5; dir.y -= 0.2; }
    else dir.set(Math.cos(az) * 0.75, 0.55 - k * 0.12, Math.sin(az) * 0.75);
    dir.normalize();
    card(F, P, dir, sp.card * rr(0.7, 0.95), sp.card * sp.cw * 0.8, UV2[pick(cells)], sp.droop, detail ? sp.vee : 0, 0, cc, fcol(1.05), 0.35);
  }
  return { b: toGeo(B, false), f: toGeo(F, true) };
}

// ---------------------------------------------------------------- palms and rosettes
// sp: { h (trunk height), r, lean, bulge (swollen base), fronds, fl (frond length), fw (width), droop, cells, skirt (dead fronds
//       hanging), vee, rows, e0, e1 (frond elevation: oldest .. newest), fan (stiff fan palms: no droop), crownshaft [r, g, b] }
function palm(sp, detail) {
  const B = new Geo(), F = new Geo(), H = sp.h, n = 10, tr = [], la = rr(0, TAU), lean = (sp.lean || 0) * rr(0.4, 1);
  const tp = path(new V3(0, -0.4, 0), new V3(Math.cos(la) * lean, 1, Math.sin(la) * lean), H + 0.4, n, () => (sp.rise == null ? 0.05 : sp.rise), 0.02);
  for (let k = 0; k <= n; k++) { const t = k / n; tr.push(sp.r * (1 + (sp.bulge || 0) * Math.exp(-t * 7)) * (1 - 0.18 * t)); }
  const cs = sp.crownshaft;
  tube(B, tp, tr, detail ? 10 : 6, { col: (k) => (cs && k >= n - 1 ? cs : WHITE) });
  const top = tp[n], cc = { x: top.x, y: top.y - sp.fl * 0.2, z: top.z, rx: sp.fl * 0.8, ry: sp.fl * 0.8 }, dir = new V3(), P = new V3();
  const nf = detail ? sp.fronds : Math.max(5, Math.round(sp.fronds * 0.65));
  let az = rr(0, TAU);
  for (let k = 0; k < nf; k++) {
    const t = k / (nf - 1), e = sp.e0 + (sp.e1 - sp.e0) * t + rr(-0.1, 0.1);
    az += 2.4 + rr(-0.25, 0.25);
    dir.copy(dirOf(az, e));
    P.copy(top).addScaledVector(dir, sp.r * 0.6);
    const L = sp.fl * rr(0.82, 1.1) * (0.8 + 0.2 * Math.sin(t * Math.PI));
    card(F, P, dir, L, L * sp.fw, UV2[pick(sp.cells)], sp.fan ? 0.05 : sp.droop * (1.5 - t) * rr(0.8, 1.2), sp.vee == null ? 0.3 : sp.vee, rr(-0.3, 0.3), cc, fcol(0.75 + 0.3 * t), 0.15, detail ? (sp.rows || 6) : 4);
  }
  for (let k = 0; k < (sp.skirt || 0); k++) {
    az += 2.4; dir.copy(dirOf(az, rr(-1.2, -0.8))); P.copy(top); P.y -= rr(0.1, 0.5);
    const L = sp.fl * rr(0.5, 0.8);
    card(F, P, dir, L, L * sp.fw, UV2[sp.deadCell == null ? pick(sp.cells) : sp.deadCell], 0.1, 0.2, rr(-0.4, 0.4), cc, sp.deadCell == null ? [0.75, 0.6, 0.35] : [0.9, 0.9, 0.9], 0.2, 4);
  }
  return { b: toGeo(B, false), f: toGeo(F, true) };
}
// A stemless rosette or clump of cards from the ground (ferns, grass tussocks, agaves, flowers). o: { n, len [min, max], wid (width /
// length), e [min, max] (elevation), cells (4 x 4 atlas indices), droop, vee, rows, spread (radius the bases are scattered over),
// tint [r, g, b], sway, upright (cards face the viewer more: flower stems) }
function tuft(F, o, ox, oz) {
  const cc = { x: ox || 0, y: -0.6, z: oz || 0, rx: 1, ry: 1 }, P = new V3(), tint = o.tint || WHITE;
  let az = rr(0, TAU);
  for (let k = 0; k < o.n; k++) {
    az += 2.4 + rr(-0.5, 0.5);
    const e = rr(o.e[0], o.e[1]), L = rr(o.len[0], o.len[1]), sr = (o.spread || 0) * Math.sqrt(R()), sa = rr(0, TAU);
    P.set((ox || 0) + Math.cos(sa) * sr, o.y == null ? -0.02 : o.y, (oz || 0) + Math.sin(sa) * sr);
    const q = rr(0.85, 1.1);
    card(F, P, dirOf(az, e), L, L * o.wid, UV4[pick(o.cells)], (o.droop || 0) * rr(0.6, 1.4), o.vee || 0, o.upright ? rr(-0.2, 0.2) : rr(-0.5, 0.5), cc,
      [tint[0] * q * rr(0.92, 1.06), tint[1] * q, tint[2] * q * rr(0.9, 1.05)], o.sway == null ? 0.1 : o.sway, o.rows || 3);
  }
}
// A small woody shrub: a few stems from the ground, each a short recursion with 4 x 4 atlas cards. o: { stems, h, r, S (as branch,
// cells are 4 x 4 atlas indices), e [min, max] }
function shrub(o, detail) {
  const B = new Geo(), F = new Geo(), cc = { x: 0, y: o.h * 0.55, z: 0, rx: o.h * 0.7, ry: o.h * 0.6 };
  const S = Object.assign({}, o.S, { uv: UV4 });
  let az = rr(0, TAU);
  const ns = detail ? o.stems : Math.max(2, Math.round(o.stems * 0.6));
  for (let k = 0; k < ns; k++) {
    az += TAU / ns + rr(-0.4, 0.4);
    const e = rr(o.e[0], o.e[1]);
    branch(B, F, S, new V3(Math.cos(az) * o.r * 2, -0.08, Math.sin(az) * o.r * 2), dirOf(az, e), o.h * rr(0.8, 1.15) / Math.max(0.5, Math.sin(e)), o.r, 0, cc);
  }
  return { b: toGeo(B, false), f: toGeo(F, true) };
}

// ---------------------------------------------------------------- columnar succulents (ribbed stems, no foliage)
// sp: { h, r, ribs, arms, armAt [min, max] (fraction of h), armLen [min, max], depth (rib depth) }
function succulent(sp, detail) {
  const B = new Geo(), ribs = sp.ribs, seg = detail ? ribs * 2 : ribs, dep = sp.depth == null ? 0.12 : sp.depth;
  const rib = a => 1 - dep * (0.5 - 0.5 * Math.cos(a * ribs));        // grooves where the texture's rib edges fall (u integer)
  function column(pts, r) {
    const n = pts.length, rad = [], out = pts.slice();
    for (let k = 0; k < n; k++) rad.push(r * (k === 0 ? 0.9 : 1));
    // domed tip: three closing rings
    const e = pts[n - 1], d = new V3().subVectors(e, pts[n - 2]).normalize();
    for (const [f, q] of [[0.45, 0.86], [0.8, 0.52], [0.97, 0.12]]) { out.push(e.clone().addScaledVector(d, r * f)); rad.push(r * q); }
    tube(B, out, rad, seg, { flare: rib, urep: ribs, col: (k, p) => { const q = rr(0.94, 1.04), m = Math.max(0, 1 - Math.max(0, p.y) / 0.8) * 0.5; return [q * (1 + m * 0.25), q * (1 - m * 0.1), q * (1 - m * 0.3)]; } });
  }
  const H = sp.h, main = path(new V3(0, -0.3, 0), new V3(rr(-0.03, 0.03), 1, rr(-0.03, 0.03)), H + 0.3, 7, () => 0.02, 0.012);
  column(main, sp.r);
  let az = rr(0, TAU);
  const P = new V3(), D = new V3();
  for (let k = 0; k < (sp.arms || 0); k++) {
    az += TAU / sp.arms + rr(-0.6, 0.6);
    const t = rr(sp.armAt[0], sp.armAt[1]), L = rr(sp.armLen[0], sp.armLen[1]), ar = sp.r * rr(0.6, 0.78), out = sp.r + ar * rr(1.1, 1.8);
    at(main, t, P, D);
    const pts = [P.clone(), P.clone().add(new V3(Math.cos(az) * out * 0.7, -0.05, Math.sin(az) * out * 0.7)), P.clone().add(new V3(Math.cos(az) * out, ar * 0.9, Math.sin(az) * out))];
    const steps = 4;
    for (let s = 1; s <= steps; s++) pts.push(new V3(P.x + Math.cos(az) * (out + rr(-0.04, 0.04)), P.y + ar * 0.9 + L * s / steps, P.z + Math.sin(az) * (out + rr(-0.04, 0.04))));
    column(pts, ar);
  }
  return { b: toGeo(B, false) };
}

// ---------------------------------------------------------------- rocks
function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf), L = (a, b, t) => a + (b - a) * t;
  const a = L(L(hash3(xi, yi, zi, s), hash3(xi + 1, yi, zi, s), u), L(hash3(xi, yi + 1, zi, s), hash3(xi + 1, yi + 1, zi, s), u), v);
  const b = L(L(hash3(xi, yi, zi + 1, s), hash3(xi + 1, yi, zi + 1, s), u), L(hash3(xi, yi + 1, zi + 1, s), hash3(xi + 1, yi + 1, zi + 1, s), u), v);
  return L(a, b, w) * 2 - 1;
}
function fbm(x, y, z, s, oct) {
  let f = 1, a = 1, sum = 0, n = 0;
  for (let i = 0; i < oct; i++) { sum += a * vnoise(x * f, y * f, z * f, s + i * 17); n += a; f *= 2.05; a *= 0.5; }
  return sum / n;
}
// A boulder of radius about 1 (scale the instance), sitting with its lower third below y = 0. o: { detail (icosphere subdivisions), flatten
// (height / width), amp (lumpiness), facets (fracture planes: 0 = water-worn, 8+ = angular), strata (ledges per unit height: bedded
// rock), strataD (ledge depth), top [r, g, b] / low [r, g, b] (vertex tint at the crown and the base: sun-bleached top, damp or
// lichen-free base), sink }
function rock(o) {
  o = o || {};
  const seed = (R() * 1e9) | 0, detail = o.detail == null ? 3 : o.detail, flat = o.flatten == null ? 0.75 : o.flatten, amp = o.amp == null ? 0.22 : o.amp;
  let geo = new T.IcosahedronGeometry(1, detail);
  if (geo.index) geo = geo.toNonIndexed();
  const pos = geo.attributes.position, n = pos.count, facets = [], nf = o.facets == null ? 4 + ((R() * 4) | 0) : o.facets;
  for (let f = 0; f < nf; f++) {
    const th = R() * TAU, cy = R() * 1.6 - 0.8, sr = Math.sqrt(1 - cy * cy);
    facets.push([Math.cos(th) * sr, cy, Math.sin(th) * sr, 0.62 + R() * 0.24]);
  }
  const ex = rr(0.85, 1.15), ez = rr(0.85, 1.15), colors = new Float32Array(n * 3), keys = new Array(n), uvs = new Float32Array(n * 2);
  const top = o.top || [1.06, 1.05, 1.02], low = o.low || [0.72, 0.72, 0.7], sink = o.sink == null ? 0.3 : o.sink, st = o.strata || 0, sd = o.strataD == null ? 0.07 : o.strataD;
  for (let i = 0; i < n; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.sqrt(x * x + y * y + z * z) || 1; x /= l; y /= l; z /= l;
    keys[i] = Math.round(x * 4096) + "_" + Math.round(y * 4096) + "_" + Math.round(z * 4096);
    let r = 0.86 + amp * fbm(x * 1.3 + 5, y * 1.3 + 9, z * 1.3 + 2, seed, 4) + amp * 0.18 * fbm(x * 6, y * 6, z * 6, seed + 99, 2);
    if (st) { const b = y * flat * st + 0.6 * fbm(x * 0.8, 0, z * 0.8, seed + 5, 2), fr = b - Math.floor(b); r *= 1 - sd * (fr < 0.18 ? 1 - fr / 0.18 : 0) - sd * 0.5 * hash3(Math.floor(b), 0, 0, seed); }
    let px = x * r, py = y * r, pz = z * r;
    for (const Fc of facets) {
      let d = px * Fc[0] + py * Fc[1] + pz * Fc[2] - Fc[3];
      if (d > 0) { d *= 0.86; px -= Fc[0] * d; py -= Fc[1] * d; pz -= Fc[2] * d; }
    }
    px *= ex; py = py * flat + flat * (1 - sink * 2) * 0.5; pz *= ez;
    pos.setXYZ(i, px, py, pz);
    // box-projected uv (about 1 repeat per unit), picked by the direction from the centre so each face of the boulder is continuous
    const axn = Math.abs(x), ayn = Math.abs(y), azn = Math.abs(z);
    if (ayn >= axn && ayn >= azn) { uvs[i * 2] = px * 0.5 + 0.5; uvs[i * 2 + 1] = pz * 0.5 + 0.5; }
    else if (axn >= azn) { uvs[i * 2] = pz * 0.5 + 0.5; uvs[i * 2 + 1] = py * 0.5 + 0.25; }
    else { uvs[i * 2] = px * 0.5 + 0.5; uvs[i * 2 + 1] = py * 0.5 + 0.25; }
    const g = fbm(x * 2.2, y * 2.2, z * 2.2, seed + 31, 3), tp = Math.max(0, Math.min(1, y * 0.6 + 0.5)), v = 0.9 + 0.12 * g;
    colors[i * 3] = v * (low[0] + (top[0] - low[0]) * tp); colors[i * 3 + 1] = v * (low[1] + (top[1] - low[1]) * tp); colors[i * 3 + 2] = v * (low[2] + (top[2] - low[2]) * tp);
  }
  // normals: welded smooth for worn rock; angular rock (facets >= 8) keeps a crease by blending toward the face normal
  const acc = {}, nrm = new Float32Array(n * 3), crease = nf >= 8 ? 0.55 : 0;
  const fn = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const ax = pos.getX(i + 1) - pos.getX(i), ay = pos.getY(i + 1) - pos.getY(i), az = pos.getZ(i + 1) - pos.getZ(i);
    const bx = pos.getX(i + 2) - pos.getX(i), by = pos.getY(i + 2) - pos.getY(i), bz = pos.getZ(i + 2) - pos.getZ(i);
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    for (let k = 0; k < 3; k++) {
      const A = acc[keys[i + k]] || (acc[keys[i + k]] = [0, 0, 0]);
      A[0] += nx; A[1] += ny; A[2] += nz;
      fn[(i + k) * 3] = nx / l; fn[(i + k) * 3 + 1] = ny / l; fn[(i + k) * 3 + 2] = nz / l;
    }
  }
  for (let i = 0; i < n; i++) {
    const A = acc[keys[i]], l = Math.sqrt(A[0] * A[0] + A[1] * A[1] + A[2] * A[2]) || 1;
    let x = A[0] / l * (1 - crease) + fn[i * 3] * crease, y = A[1] / l * (1 - crease) + fn[i * 3 + 1] * crease, z = A[2] / l * (1 - crease) + fn[i * 3 + 2] * crease;
    const m = Math.sqrt(x * x + y * y + z * z) || 1;
    nrm[i * 3] = x / m; nrm[i * 3 + 1] = y / m; nrm[i * 3 + 2] = z / m;
  }
  geo.setAttribute("normal", new T.BufferAttribute(nrm, 3));
  geo.setAttribute("color", new T.BufferAttribute(colors, 3));
  geo.setAttribute("uv", new T.BufferAttribute(uvs, 2));
  const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  geo.setIndex(new T.BufferAttribute(idx, 1));
  pos.needsUpdate = true;
  geo.computeBoundingSphere(); geo.computeBoundingBox();
  return geo;
}
// A square tiling stone texture (colour + height). paint(P) as barkTex, in a 512 x 512 space.
function rockTex(paint) { return barkTex(paint, { w: 512, h: 512 }); }
function rockMat(tex, bumpScale, rough) {
  return lit(new T.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, roughness: rough == null ? 0.88 : rough, metalness: 0, map: tex.map, bumpMap: tex.bump, bumpScale: bumpScale == null ? 0.03 : bumpScale }), "rock");
}

Object.assign(K, {
  withRand, mulberry, rr: (a, b) => rr(a, b), pick: a => pick(a), rand: () => R(), hsl, canvas,
  Geo, toGeo, tube, path, at, card, branch, broadleaf, conifer, palm, tuft, shrub, succulent, rock, dirOf, fcol,
  barkTex, rockTex, atlas, cellUV, UV2, UV4, spray, needles, needleTuft, leaf, leafySpray, frondCell, bladeCell, flowerCell, heads,
  barkMat, foliageMat, depthMat, rockMat, fbm,
});
BF.real.akit = K;
})();
