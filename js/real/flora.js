// Blockfield 1.6, the realistic look: js/real/flora.js. Owner: the Foundation thread (docs/REALISTIC_CONTRACT.md sections 4, 5).
// The tree toolkit of the Cascade Creek prototype (BF.real.kit: branch geometry and painted leaf and needle atlases), the three
// example species (spruce, oak, birch) and the simple placer that turns the mesher's flora list into instanced trees and
// plants, a batch per chunk. Drawing only. Nothing here may run unless BF.real.on.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
const real = BF.real;
(function () {
  var T = THREE, V3 = T.Vector3, R = Math.random;
  var windU = real.U.uTime, sunVU = { value: new T.Vector3(0, 1, 0) }, sunCU = { value: new T.Color(1, 0.95, 0.85) };
  var BW = 1.0, BH = 2.0, WHITE = [1, 1, 1], TAU = 6.2831853;
  function rr(a, b) { return a + (b - a) * R(); }
  function pick(a) { return a[(R() * a.length) | 0]; }
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // =====================================================================
  //  BARK TEXTURES (color + height)
  // =====================================================================
  function barkTex(kind) {
    var W = 512, H = 1024, c = canvas(W, H), g = c.getContext('2d'), b = canvas(W, H), h = b.getContext('2d'), i, x, y, k, pts, lw, len;
    function poly(cx, p, col, w, a, dx) {
      var ox, oy, q;
      cx.strokeStyle = col; cx.lineWidth = w; cx.globalAlpha = a; cx.lineCap = 'round'; cx.lineJoin = 'round';
      for (ox = -1; ox <= 1; ox++) for (oy = -1; oy <= 1; oy++) {
        cx.beginPath();
        for (q = 0; q < p.length; q += 2) { if (q) cx.lineTo(p[q] + ox * W + (dx || 0), p[q + 1] + oy * H); else cx.moveTo(p[q] + ox * W + (dx || 0), p[q + 1] + oy * H); }
        cx.stroke();
      }
    }
    function blob(cx, bx, by, rx, ry, rot, col, a) {
      var ox, oy; cx.fillStyle = col; cx.globalAlpha = a;
      for (ox = -1; ox <= 1; ox++) for (oy = -1; oy <= 1; oy++) { cx.beginPath(); cx.ellipse(bx + ox * W, by + oy * H, rx, ry, rot, 0, TAU); cx.fill(); }
    }
    function furrow(fx, fy, flen, wob, step) { var p = [], s; for (s = 0; s <= flen; s += step) { p.push(fx, fy + s); fx += rr(-wob, wob); } return p; }
    function grain(n, cols, hl, wmax, hmax) {
      for (var q = 0; q < n; q++) {
        var gx = R() * W, gy = R() * H, gw = rr(1, wmax), gh = rr(3, hmax);
        g.globalAlpha = rr(0.06, 0.25); g.fillStyle = pick(cols); g.fillRect(gx, gy, gw, gh);
        h.globalAlpha = rr(0.08, 0.3); h.fillStyle = R() < 0.5 ? '#303030' : hl; h.fillRect(gx, gy, gw, gh);
      }
    }
    function fill(c1, c2) { g.globalAlpha = 1; g.fillStyle = c1; g.fillRect(0, 0, W, H); h.globalAlpha = 1; h.fillStyle = c2; h.fillRect(0, 0, W, H); }

    if (kind === 'fir') {
      fill('#6a5949', '#a0a0a0');
      grain(3200, ['#3a2c22', '#8a7866', '#54463a', '#7b6a5a', '#9a8a78'], '#d8d8d8', 6, 46);
      for (i = 0; i < 150; i++) {
        len = rr(150, 620); lw = rr(11, 26); pts = furrow(R() * W, R() * H, len, 6, 16);
        poly(h, pts, '#0c0c0c', lw, 0.92);
        poly(g, pts, '#241912', lw, 0.9);
        poly(g, pts, '#7c4b2a', lw * 0.28, 0.55);
        poly(g, pts, '#150f0b', lw * 0.12, 0.8);
        poly(g, pts, '#93826f', 2.5, 0.4, lw * 0.5 + 2);
        poly(h, pts, '#e8e8e8', 3, 0.5, lw * 0.5 + 2);
      }
      for (i = 0; i < 260; i++) {
        x = R() * W; y = R() * H; len = rr(8, 36); pts = [x, y, x + len * 0.5, y + rr(-3, 3), x + len, y + rr(-3, 3)];
        lw = rr(1.5, 4); poly(g, pts, '#2a1f17', lw, rr(0.4, 0.8)); poly(h, pts, '#202020', lw, 0.7);
      }
      for (i = 0; i < 110; i++) blob(g, R() * W, R() * H, rr(3, 14), rr(3, 10), R() * 3, pick(['#8e9a84', '#6b7a52', '#a9ad9c']), rr(0.12, 0.3));
    } else if (kind === 'cedar') {
      fill('#7a5440', '#909090');
      for (i = 0; i < 1000; i++) {
        len = rr(180, 1000); lw = rr(1.2, 5); pts = furrow(R() * W, R() * H, len, 1.6, 34);
        poly(g, pts, pick(['#4e3122', '#8d6a52', '#a08672', '#5f3d2b', '#93715a', '#6b4633', '#b09a88']), lw, rr(0.45, 0.9));
        poly(h, pts, R() < 0.5 ? '#3a3a3a' : '#d4d4d4', lw, 0.6);
      }
      for (i = 0; i < 70; i++) {
        len = rr(250, 900); lw = rr(4, 9); pts = furrow(R() * W, R() * H, len, 2.2, 30);
        poly(g, pts, '#2c1a12', lw, 0.85); poly(h, pts, '#101010', lw, 0.9);
        poly(g, pts, '#b39c88', 1.6, 0.4, lw * 0.5 + 1.5);
      }
      for (i = 0; i < 40; i++) blob(g, R() * W, R() * H, rr(10, 30), rr(40, 160), 0, pick(['#9a948c', '#8a8a82']), rr(0.06, 0.16));
    } else if (kind === 'hemlock') {
      fill('#5b4b3f', '#989898');
      grain(2600, ['#3b2e26', '#75645a', '#4a3d34', '#6c5a4e'], '#d0d0d0', 5, 30);
      for (i = 0; i < 420; i++) {
        len = rr(60, 240); lw = rr(3.5, 9); pts = furrow(R() * W, R() * H, len, 3.2, 12);
        poly(h, pts, '#141414', lw, 0.85); poly(g, pts, '#281e18', lw, 0.85);
        poly(g, pts, '#6e3f2c', lw * 0.3, 0.4);
        poly(g, pts, '#85756a', 1.8, 0.35, lw * 0.5 + 1.5);
      }
      for (i = 0; i < 520; i++) {
        x = R() * W; y = R() * H; len = rr(6, 24); pts = [x, y, x + len, y + rr(-2, 2)];
        lw = rr(1.2, 3); poly(g, pts, '#2d231c', lw, rr(0.35, 0.7)); poly(h, pts, '#252525', lw, 0.6);
      }
      for (i = 0; i < 90; i++) blob(g, R() * W, R() * H, rr(3, 12), rr(3, 9), R() * 3, pick(['#7f8b74', '#667550', '#9ea592']), rr(0.12, 0.3));
    } else if (kind === 'alder') {
      fill('#a2a298', '#b4b4b4');
      for (i = 0; i < 1500; i++) blob(g, R() * W, R() * H, rr(3, 16), rr(3, 12), R() * 3, pick(['#8f9088', '#b4b4aa', '#96978c', '#a9a99d', '#84867c']), rr(0.08, 0.2));
      for (i = 0; i < 95; i++) {
        x = R() * W; y = R() * H; var lc = R() < 0.72 ? pick(['#dedfd4', '#e6e6dc', '#d2d4c8']) : pick(['#8f9a80', '#7c8a6a', '#a3a890']), la = rr(0.45, 0.85);
        for (k = 0; k < 6; k++) blob(g, x + rr(-22, 22), y + rr(-18, 18), rr(8, 30), rr(6, 22), R() * 3, lc, la * rr(0.5, 1));
        blob(h, x, y, rr(14, 30), rr(10, 22), R() * 3, '#c8c8c8', 0.3);
      }
      for (i = 0; i < 16; i++) { x = R() * W; y = R() * H; for (k = 0; k < 4; k++) blob(g, x + rr(-14, 14), y + rr(-14, 14), rr(8, 22), rr(6, 16), R() * 3, '#55564f', rr(0.2, 0.42)); }
      for (i = 0; i < 12; i++) blob(g, R() * W, R() * H, rr(4, 10), rr(3, 8), R() * 3, '#b89a48', rr(0.25, 0.5));
      for (i = 0; i < 300; i++) {
        x = R() * W; y = R() * H; len = rr(7, 42); pts = [x, y, x + len * 0.5, y + rr(-1.2, 1.2), x + len, y + rr(-1.2, 1.2)];
        lw = rr(1.4, 3.2); poly(g, pts, pick(['#33322c', '#45433b', '#2a2924']), lw, rr(0.45, 0.85)); poly(h, pts, '#e0e0e0', lw, 0.6);
      }
      for (i = 0; i < 11; i++) {
        x = R() * W; y = R() * H; var sw = rr(9, 16);
        blob(g, x, y, sw, sw * 0.6, 0, '#2c2a25', 0.9); blob(g, x, y, sw * 0.45, sw * 0.25, 0, '#57534a', 0.8); blob(h, x, y, sw, sw * 0.6, 0, '#303030', 0.9);
        for (k = 1; k <= 3; k++) {
          poly(g, [x - sw * (1 + k * 0.5), y + k * 7 + 5, x - sw * 0.4, y - k * 3, x, y - sw * 0.6 - k * 4, x + sw * 0.4, y - k * 3, x + sw * (1 + k * 0.5), y + k * 7 + 5], '#3a3832', 2, 0.55);
        }
      }
    } else { // maple
      fill('#6e6957', '#a0a0a0');
      grain(2200, ['#4c483b', '#868069', '#5d5848', '#7a755f'], '#cfcfcf', 4, 36);
      for (i = 0; i < 150; i++) {
        len = rr(80, 400); lw = rr(2, 4.5); pts = furrow(R() * W, R() * H, len, 2.5, 18);
        poly(g, pts, '#39342a', lw, rr(0.4, 0.7)); poly(h, pts, '#1c1c1c', lw, 0.7);
      }
      for (i = 0; i < 130; i++) {
        x = R() * W; y = R() * H; var mc = pick(['#5d7a2e', '#7a9440', '#4c6a2a', '#8aa048']), ma = rr(0.45, 0.85);
        for (k = 0; k < 7; k++) blob(g, x + rr(-26, 26), y + rr(-34, 34), rr(6, 24), rr(8, 30), R() * 3, mc, ma * rr(0.5, 1));
        for (k = 0; k < 5; k++) blob(h, x + rr(-22, 22), y + rr(-28, 28), rr(5, 14), rr(5, 14), R() * 3, R() < 0.5 ? '#e0e0e0' : '#808080', 0.4);
      }
      for (i = 0; i < 40; i++) blob(g, R() * W, R() * H, rr(5, 16), rr(4, 12), R() * 3, '#c9cbbf', rr(0.3, 0.6));
    }
    g.globalAlpha = 1; h.globalAlpha = 1;
    var map = new T.CanvasTexture(c), bump = new T.CanvasTexture(b);
    map.encoding = T.sRGBEncoding; map.wrapS = map.wrapT = bump.wrapS = bump.wrapT = T.RepeatWrapping; map.anisotropy = bump.anisotropy = 8;
    return { map: map, bump: bump };
  }
  function barkMat(kind, bumpScale) {
    var t = barkTex(kind);
    return new T.MeshStandardMaterial({ map: t.map, bumpMap: t.bump, bumpScale: bumpScale, roughness: 0.95, metalness: 0, vertexColors: true });
  }

  // =====================================================================
  //  FOLIAGE ATLASES (1024, 2x2 cells of 512)
  // =====================================================================
  function cells(c, fn) {
    var g = c.getContext('2d'), i;
    for (i = 0; i < 4; i++) {
      g.save(); g.translate((i % 2) * 512, (i >> 1) * 512); g.beginPath(); g.rect(6, 6, 500, 500); g.clip();
      g.lineCap = 'round'; g.lineJoin = 'round'; g.globalAlpha = 1;
      fn(g, i); g.restore();
    }
  }
  function atlasTex(c, mr, mg, mb) {
    var g = c.getContext('2d'), img = g.getImageData(0, 0, c.width, c.height), d = img.data, n = d.length, i, a;
    for (i = 0; i < n; i += 4) {
      a = d[i + 3];
      if (a < 10) { d[i] = mr; d[i + 1] = mg; d[i + 2] = mb; d[i + 3] = 0; }
      else { a = a * 1.7; d[i + 3] = a > 255 ? 255 : a; }
    }
    var t = new T.DataTexture(new Uint8Array(d.buffer), c.width, c.height, T.RGBAFormat);
    t.encoding = T.sRGBEncoding; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
    t.anisotropy = 8; t.flipY = false; t.needsUpdate = true;
    return t;
  }
  // cell uv rect (DataTexture, flipY=false: v == canvas y / H). vb = twig base (cell bottom), vt = tip.
  function cellUV(i) { var cx = (i % 2) * 0.5, cy = (i >> 1) * 0.5; return { u0: cx + 0.014, u1: cx + 0.486, vb: cy + 0.486, vt: cy + 0.014 }; }
  var CELLS = null;

  // recursive branchlet. ang: 0 = up, + = clockwise
  function spray(g, x, y, ang, len, depth, P) {
    var dx = Math.sin(ang), dy = -Math.cos(ang), s, side = R() < 0.5 ? 1 : -1, step;
    if (depth < P.woody) {
      g.globalAlpha = 1; g.strokeStyle = P.stem; g.lineWidth = Math.max(1.3, P.stemW * Math.pow(0.55, depth));
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx * len, y + dy * len); g.stroke();
    }
    if (depth < P.maxDepth) {
      step = P.step[depth];
      for (s = step * (depth ? 0.7 : 1.3); s < len - step * 0.4; s += step * rr(0.8, 1.2)) {
        spray(g, x + dx * s, y + dy * s, ang + side * P.ang * rr(0.85, 1.12), (len - s) * P.ratio * rr(0.8, 1.1) + P.minLen, depth + 1, P);
        side = -side;
      }
    }
    P.leaf(g, x, y, dx, dy, ang, len, depth);
  }
  function needles(g, x, y, dx, dy, ang, len, s0, nl, sp, lw, C, brush) {
    var s, t, a, l, px, py, sd, c;
    for (s = s0; s < len + 1; s += sp) {
      t = s / len; px = x + dx * s; py = y + dy * s;
      for (sd = -1; sd <= 1; sd += 2) {
        a = ang + sd * rr(0.8, 1.25) * (t > 0.93 ? 0.45 : 1); l = nl * rr(0.72, 1.1) * (t > 0.9 ? 0.8 : 1);
        c = t > 0.78 ? C.tip : (R() < 0.38 ? C.dark : C.mid);
        g.strokeStyle = pick(c); g.lineWidth = lw * rr(0.8, 1.2);
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(a) * l, py - Math.cos(a) * l); g.stroke();
      }
      if (R() < brush) {
        a = ang + rr(-0.55, 0.55); l = nl * rr(0.4, 0.75);
        g.strokeStyle = pick(R() < 0.5 ? C.dark : C.mid); g.lineWidth = lw;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(a) * l, py - Math.cos(a) * l); g.stroke();
      }
    }
  }
  function firAtlas() {
    var c = canvas(1024, 1024);
    var C = { dark: ['#1d3a22', '#234428', '#1a3320', '#27402a'], mid: ['#2f5a2c', '#386630', '#2a5230', '#3d6a2e'], tip: ['#5d8a3a', '#6f9a42', '#4f7d36', '#7aa048'] };
    cells(c, function (g, i) {
      var P = { woody: 3, maxDepth: 2, step: [38 + i * 3, 25], ang: 0.82 + i * 0.04, ratio: 0.5, minLen: 12, stem: '#4a3524', stemW: 6,
        leaf: function (g2, x, y, dx, dy, ang, len, depth) { needles(g2, x, y, dx, dy, ang, len, depth ? 2 : len * 0.2, 15, 2.5, 2.3, C, 0.5); } };
      spray(g, 256, 506, rr(-0.04, 0.04), 474, 0, P);
    });
    return atlasTex(c, 45, 85, 45);
  }
  function hemlockAtlas() {
    var c = canvas(1024, 1024);
    var C = { dark: ['#16301f', '#1b3a24', '#1a3522'], mid: ['#28502c', '#2f5a30', '#234a2c', '#31602f'], tip: ['#4a7a38', '#5a8a40', '#67963f'] };
    cells(c, function (g, i) {
      var P = { woody: 3, maxDepth: 2, step: [29 + i * 2, 16], ang: 0.98, ratio: 0.5, minLen: 9, stem: '#4b3a2a', stemW: 4,
        leaf: function (g2, x, y, dx, dy, ang, len, depth) { needles(g2, x, y, dx, dy, ang, len, depth ? 2 : len * 0.15, 9.5, 2.1, 1.9, C, 0.12); } };
      spray(g, 256, 506, rr(-0.04, 0.04), 470, 0, P);
    });
    return atlasTex(c, 38, 75, 42);
  }
  function cedarAtlas() {
    var c = canvas(1024, 1024), cols = ['#5a7d2e', '#6b8f38', '#7a9a3c', '#4d7030', '#86a046', '#64862f'];
    cells(c, function (g, i) {
      var P = { woody: 2, maxDepth: 3, step: [36 + i * 2, 17, 9], ang: 0.78, ratio: 0.5, minLen: 6, stem: '#6a4a2c', stemW: 5,
        leaf: function (g2, x, y, dx, dy, ang, len, depth) {
          var w = depth >= 3 ? 4.2 : (depth === 2 ? 5.2 : 6.5), s, old = R() < 0.05;
          g2.strokeStyle = 'rgba(30,50,15,0.4)'; g2.lineWidth = 1;
          for (s = depth === 0 ? len * 0.4 : (depth === 1 ? len * 0.15 : 0); s < len; s += w * 0.95) {
            g2.fillStyle = old ? pick(['#9a8a3a', '#a07a36']) : pick(cols);
            g2.beginPath(); g2.ellipse(x + dx * s, y + dy * s, w * 0.62, w * 0.82, ang, 0, TAU); g2.fill(); g2.stroke();
          }
        } };
      spray(g, 256, 506, rr(-0.04, 0.04), 472, 0, P);
    });
    return atlasTex(c, 100, 135, 55);
  }
  function alderLeaf(g, x, y, ang, L, hue, sat, lit, flaw) {
    var pl = L * 0.14, hw = L * rr(0.3, 0.36), N = 54, k, t, w, skew = rr(-0.04, 0.04) * L;
    function prof(tt) { return tt >= 1 ? 0 : hw * Math.pow(Math.sin(Math.PI * Math.pow(tt, 0.72)), 0.75); }
    g.save(); g.translate(x, y); g.rotate(ang);
    g.globalAlpha = 1; g.strokeStyle = '#6f7a3a'; g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -pl); g.stroke();
    g.translate(0, -pl);
    g.beginPath(); g.moveTo(0, 0);
    for (k = 1; k <= N; k++) { t = k / N; w = prof(t) * (1 + 0.09 * ((k % 3) / 2 - 0.5)); g.lineTo(w + skew * Math.sin(t * 3.14), -t * L); }
    for (k = N - 1; k >= 0; k--) { t = k / N; w = prof(t) * (1 + 0.09 * ((k % 3) / 2 - 0.5)); g.lineTo(-w + skew * Math.sin(t * 3.14), -t * L); }
    g.closePath();
    g.fillStyle = 'hsl(' + hue + ',' + sat + '%,' + lit + '%)'; g.fill();
    g.save(); g.clip();
    g.fillStyle = 'rgba(0,0,0,0.13)'; g.fillRect(0, -L, hw * 1.3, L);
    g.fillStyle = 'rgba(255,255,200,0.07)'; g.fillRect(-hw * 1.3, -L, hw * 1.3, L);
    if (flaw > 0.55) {
      for (k = 0; k < 5; k++) { g.fillStyle = pick(['rgba(196,176,60,0.5)', 'rgba(150,110,50,0.45)', 'rgba(210,200,90,0.4)']); g.beginPath(); g.arc(rr(-hw, hw), -rr(0.1, 0.95) * L, rr(3, L * 0.12), 0, TAU); g.fill(); }
    }
    // pinnate veins (straight, parallel) with slight impressed shading
    for (k = 0; k < 10; k++) {
      t = 0.06 + k * 0.085; var t2 = Math.min(0.98, t + 0.15), wv = prof(t2) * 0.97;
      g.lineWidth = 1.3; g.strokeStyle = 'rgba(30,55,20,0.6)';
      g.beginPath(); g.moveTo(0, -t * L); g.lineTo(wv, -t2 * L); g.moveTo(0, -t * L); g.lineTo(-wv, -t2 * L); g.stroke();
      g.lineWidth = 1; g.strokeStyle = 'rgba(200,225,140,0.22)';
      g.beginPath(); g.moveTo(0, -t * L - 2.5); g.lineTo(wv, -t2 * L - 2.5); g.moveTo(0, -t * L - 2.5); g.lineTo(-wv, -t2 * L - 2.5); g.stroke();
    }
    g.strokeStyle = 'rgba(205,220,150,0.9)'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(0, 0); g.lineTo(skew * 0.5, -L * 0.97); g.stroke();
    g.restore();
    if (flaw > 0.78) {
      for (k = 0; k < 2; k++) {
        var hx = rr(-hw * 0.5, hw * 0.5), hy = -rr(0.25, 0.75) * L, hr = rr(3, 7);
        g.strokeStyle = 'rgba(110,80,40,0.9)'; g.lineWidth = 2; g.beginPath(); g.arc(hx, hy, hr + 1, 0, TAU); g.stroke();
        g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(hx, hy, hr, 0, TAU); g.fill(); g.globalCompositeOperation = 'source-over';
      }
    }
    g.restore();
  }
  function alderAtlas() {
    var c = canvas(1024, 1024);
    cells(c, function (g, i) {
      var x = 256, y = 506, a = rr(-0.1, 0.1), k, n = 7, st = 61, side = R() < 0.5 ? 1 : -1, pts = [], yel = i === 3;
      for (k = 0; k < n; k++) { pts.push([x, y, a]); x += Math.sin(a) * st; y -= Math.cos(a) * st; a += rr(-0.13, 0.13); if (x < 216) a += 0.1; if (x > 296) a -= 0.1; }
      g.strokeStyle = '#4a3a2c'; g.lineWidth = 5; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (k = 1; k < n; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
      g.strokeStyle = '#7b6a52'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(pts[0][0] - 1.5, pts[0][1]);
      for (k = 1; k < n; k++) g.lineTo(pts[k][0] - 1.5, pts[k][1]); g.stroke();
      function leaf(p, la, L) {
        var f = R(), hue = yel && R() < 0.5 ? rr(58, 72) : rr(84, 112), lit = hue < 75 ? rr(36, 44) : rr(22, 33);
        alderLeaf(g, p[0], p[1], la, L, hue | 0, rr(36, 52) | 0, lit | 0, f);
      }
      for (k = 1; k < n - 1; k++) {
        leaf(pts[k], pts[k][2] + side * rr(0.7, 1.12), rr(118, 160));
        if (R() < 0.35) leaf(pts[k], pts[k][2] - side * rr(0.9, 1.3), rr(80, 115));
        side = -side;
      }
      leaf(pts[n - 1], pts[n - 1][2] + rr(-0.15, 0.15), rr(96, 112));
      leaf(pts[n - 1], pts[n - 1][2] + side * rr(0.8, 1.0), rr(90, 120));
    });
    return atlasTex(c, 62, 100, 42);
  }
  function mapleLeaf(g, x, y, ang, Rr, col, nl, sinus, big) {
    var m = (nl - 1) / 2, k, sp = big ? 0.8 : 0.6, a, L, pts = [[0, 0]], tips = [], i;
    function P(aa, r) { return [Math.sin(aa) * r, -Math.cos(aa) * r]; }
    for (k = -m; k <= m; k++) {
      a = k * sp + rr(-0.04, 0.04); L = Rr * (1 - 0.12 * Math.abs(k)) * rr(0.93, 1.05);
      if (k > -m) pts.push(P(a - sp * 0.5, Rr * sinus * rr(0.9, 1.1)));
      if (big) { pts.push(P(a - sp * 0.21, L * 0.6)); pts.push(P(a - sp * 0.28, L * 0.77)); pts.push(P(a - sp * 0.12, L * 0.8)); }
      else { pts.push(P(a - sp * 0.26, L * 0.66)); pts.push(P(a - sp * 0.2, L * 0.8)); pts.push(P(a - sp * 0.1, L * 0.86)); }
      pts.push(P(a, L)); tips.push(P(a, L * 0.94));
      if (big) { pts.push(P(a + sp * 0.12, L * 0.8)); pts.push(P(a + sp * 0.28, L * 0.77)); pts.push(P(a + sp * 0.21, L * 0.6)); }
      else { pts.push(P(a + sp * 0.1, L * 0.86)); pts.push(P(a + sp * 0.2, L * 0.8)); pts.push(P(a + sp * 0.26, L * 0.66)); }
    }
    g.save(); g.translate(x, y); g.rotate(ang); g.globalAlpha = 1;
    g.beginPath(); g.moveTo(0, 0); for (i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath();
    g.fillStyle = col; g.fill();
    g.save(); g.clip();
    g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(0, -Rr * 1.2, Rr * 1.2, Rr * 2.4);
    if (R() < 0.3) for (i = 0; i < 4; i++) { g.fillStyle = pick(['rgba(215,190,60,0.45)', 'rgba(170,120,50,0.4)']); g.beginPath(); g.arc(rr(-Rr, Rr) * 0.7, rr(-Rr, Rr * 0.3) * 0.8, rr(3, Rr * 0.14), 0, TAU); g.fill(); }
    for (i = 0; i < tips.length; i++) {
      var tx = tips[i][0], ty = tips[i][1];
      g.strokeStyle = 'rgba(40,70,20,0.45)'; g.lineWidth = 1.1; g.beginPath();
      for (k = 1; k <= 3; k++) {
        var f = 0.25 + k * 0.17, bx = tx * f, by = ty * f, px = -ty * 0.16, py = tx * 0.16;
        g.moveTo(bx, by); g.lineTo(bx + tx * 0.13 + px, by + ty * 0.13 + py); g.moveTo(bx, by); g.lineTo(bx + tx * 0.13 - px, by + ty * 0.13 - py);
      }
      g.stroke();
      g.strokeStyle = 'rgba(222,232,160,0.85)'; g.lineWidth = big ? 2.2 : 1.7; g.beginPath(); g.moveTo(0, 0); g.lineTo(tx, ty); g.stroke();
    }
    g.restore(); g.restore();
  }
  function mapleAtlas() {
    var c = canvas(1024, 1024);
    cells(c, function (g, i) {
      var big = i >= 2, x = 256, y = 506, a = rr(-0.08, 0.08), nodes = big ? 2 : 3, st = big ? 165 : 112, k, sd;
      var pts = [];
      for (k = 0; k <= nodes; k++) { pts.push([x, y, a]); x += Math.sin(a) * st; y -= Math.cos(a) * st; a += rr(-0.12, 0.12); }
      g.strokeStyle = big ? '#5a4a34' : '#6a4a3a'; g.lineWidth = big ? 6 : 4; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (k = 1; k <= nodes; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
      function leaf(p, la, pl, Rr) {
        var ex = p[0] + Math.sin(la) * pl, ey = p[1] - Math.cos(la) * pl;
        g.globalAlpha = 1; g.strokeStyle = big ? '#8a9a48' : '#a0683c'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(ex, ey); g.stroke();
        var hue = rr(70, 94), col = 'hsl(' + (hue | 0) + ',' + (rr(52, 66) | 0) + '%,' + (rr(34, 45) | 0) + '%)';
        mapleLeaf(g, ex, ey, la * rr(0.75, 0.95), Rr, col, big ? 5 : 7, big ? 0.34 : 0.56, big);
      }
      for (k = 1; k <= nodes; k++) {
        var last = k === nodes;
        for (sd = -1; sd <= 1; sd += 2) {
          if (big) leaf(pts[k], pts[k][2] + sd * (last ? rr(0.5, 0.7) : rr(1.0, 1.3)), rr(60, 85), rr(108, 138));
          else leaf(pts[k], pts[k][2] + sd * (last ? rr(0.4, 0.6) : rr(0.95, 1.3)), rr(40, 62), rr(68, 92));
        }
      }
    });
    return atlasTex(c, 128, 158, 52);
  }

  // =====================================================================
  //  MATERIALS
  // =====================================================================
  var WIND_GLSL = [
    '#ifdef USE_INSTANCING',
    '  float wPh = instanceMatrix[3][0] * 0.31 + instanceMatrix[3][2] * 0.17;',
    '#else',
    '  float wPh = 0.0;',
    '#endif',
    'float wA = aWind.x; float wP = aWind.y + wPh;',
    'float wG = 0.6 + 0.4 * sin(uTime * 0.31 + wPh * 0.5);',
    'transformed.x += wA * wG * (sin(uTime * 1.7 + wP) * 0.05 + sin(uTime * 4.3 + wP * 2.3) * 0.012);',
    'transformed.z += wA * wG * (cos(uTime * 1.3 + wP * 1.3) * 0.04 + sin(uTime * 3.7 + wP * 1.9) * 0.012);',
    'transformed.y += wA * wG * sin(uTime * 2.1 + wP * 1.7) * 0.025;'
  ].join('\n');
  var TRANS_GLSL = [
    '{',
    '  vec3 tV = normalize( vViewPosition );',
    '  float tB = clamp( dot( -tV, uSunV ), 0.0, 1.0 );',
    '  tB = tB * tB;',
    '  totalEmissiveRadiance += diffuseColor.rgb * uSunC * vec3( 1.0, 0.95, 0.42 ) * ( uTrans * tB );',
    '}'
  ].join('\n');
  function foliageMat(tex, trans) {
    var m = new T.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: T.DoubleSide, roughness: 0.78, metalness: 0, vertexColors: true });
    m.onBeforeCompile = function (sh) {
      try {
        var vs = sh.vertexShader, fs = sh.fragmentShader;
        if (vs.indexOf('#include <begin_vertex>') >= 0) {
          sh.uniforms.uTime = windU;
          vs = 'attribute vec2 aWind;\nuniform float uTime;\n' + vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_GLSL);
        }
        if (fs.indexOf('#include <emissivemap_fragment>') >= 0 && fs.indexOf('vViewPosition') >= 0) {
          sh.uniforms.uSunV = sunVU; sh.uniforms.uSunC = sunCU; sh.uniforms.uTrans = { value: trans };
          fs = 'uniform vec3 uSunV;\nuniform vec3 uSunC;\nuniform float uTrans;\n' + fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + TRANS_GLSL);
        }
        // keep the outward-bent vertex normals on back faces too (soft volumetric crown lighting)
        if (fs.indexOf('#include <normal_fragment_begin>') >= 0 && T.ShaderChunk && T.ShaderChunk.normal_fragment_begin) {
          fs = fs.replace('#include <normal_fragment_begin>', T.ShaderChunk.normal_fragment_begin.replace(/normal\s*=\s*normal\s*\*\s*faceDirection\s*;/, ''));
        }
        sh.vertexShader = vs; sh.fragmentShader = fs;
      } catch (e) { /* leave stock shader */ }
    };
    return m;
  }
  function depthMat(tex) { return new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: tex, alphaTest: 0.4, side: T.DoubleSide }); }

  // =====================================================================
  //  GEOMETRY BUILDERS
  // =====================================================================
  function Geo() { this.p = []; this.n = []; this.u = []; this.c = []; this.w = []; this.i = []; this.nv = 0; }
  function toGeo(G, fol) {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(G.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(G.n, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(G.u, 2));
    g.setAttribute('color', new T.Float32BufferAttribute(G.c, 3));
    if (fol) g.setAttribute('aWind', new T.Float32BufferAttribute(G.w, 2));
    g.setIndex(G.i);
    return g;
  }
  var _tan, _nx, _bx;
  function tube(B, pts, rad, seg, o) {
    o = o || {};
    var n = pts.length, k, j, v = o.v0 || 0, base = B.nv, urep = Math.max(1, Math.round(TAU * rad[0] / BW)), a, ca, sa, r, p, cl, x, y, z, b;
    for (k = 0; k < n; k++) {
      if (k === 0) _tan.subVectors(pts[1], pts[0]); else if (k === n - 1) _tan.subVectors(pts[k], pts[k - 1]); else _tan.subVectors(pts[k + 1], pts[k - 1]);
      _tan.normalize();
      if (k === 0) { if (Math.abs(_tan.x) > 0.9) _nx.set(0, 0, 1); else _nx.set(1, 0, 0); }
      _nx.addScaledVector(_tan, -_nx.dot(_tan)).normalize(); _bx.crossVectors(_tan, _nx);
      if (k > 0) v += pts[k].distanceTo(pts[k - 1]) / BH;
      p = pts[k]; cl = o.col ? o.col(k, p) : WHITE;
      for (j = 0; j <= seg; j++) {
        a = j / seg * TAU; ca = Math.cos(a); sa = Math.sin(a);
        r = rad[k]; if (o.flare) r *= o.flare(a, p.y);
        x = _nx.x * ca + _bx.x * sa; y = _nx.y * ca + _bx.y * sa; z = _nx.z * ca + _bx.z * sa;
        B.p.push(p.x + x * r, p.y + y * r, p.z + z * r); B.n.push(x, y, z); B.u.push(j / seg * urep, v); B.c.push(cl[0], cl[1], cl[2]);
      }
    }
    for (k = 0; k < n - 1; k++) for (j = 0; j < seg; j++) { a = base + k * (seg + 1) + j; b = a + seg + 1; B.i.push(a, a + 1, b, a + 1, b + 1, b); }
    B.nv += n * (seg + 1);
  }
  function path(o, d, len, n, bendFn, jit) {
    var pts = [o.clone()], p = o.clone(), dir = d.clone().normalize(), k, st = len / n;
    for (k = 1; k <= n; k++) {
      dir.y += bendFn((k - 0.5) / n); dir.x += rr(-jit, jit); dir.z += rr(-jit, jit); dir.normalize();
      p = p.clone().addScaledVector(dir, st); pts.push(p);
    }
    return pts;
  }
  function at(pts, t, P, D) {
    var n = pts.length - 1, f = Math.min(n - 1e-4, Math.max(0, t * n)), i = f | 0;
    P.lerpVectors(pts[i], pts[i + 1], f - i); D.subVectors(pts[i + 1], pts[i]).normalize();
  }
  // foliage card: 3 rows along dir (bent by droop), 2 or 3 columns (vee != 0 -> folded along the twig)
  function card(F, P, dir, len, wid, cell, droop, vee, roll, cc, col, bw) {
    var sx = -dir.z, sz = dir.x, sy = 0, sl = Math.sqrt(sx * sx + sz * sz), nx, ny, nz, cr, sr, tx, ty, tz;
    if (sl < 1e-3) { sx = 1; sz = 0; sl = 1; }
    sx /= sl; sz /= sl;
    nx = -sz * dir.y; ny = sz * dir.x - sx * dir.z; nz = sx * dir.y;          // side x dir (up-ish)
    if (roll) { cr = Math.cos(roll); sr = Math.sin(roll); tx = sx * cr + nx * sr; ty = ny * sr; tz = sz * cr + nz * sr; nx = nx * cr - sx * sr; ny = ny * cr; nz = nz * cr - sz * sr; sx = tx; sy = ty; sz = tz; }
    var nc = vee ? 3 : 2, r, c, t, cx, cy, cz, cc2, e, hw = wid * 0.5, cv = Math.cos(vee), sv = Math.sin(vee), base = F.nv, px, py, pz, ox, oy, oz, ol, ph = R() * TAU, u, a, b, k;
    for (r = 0; r < 3; r++) {
      t = r * 0.5;
      cx = P.x + dir.x * len * t; cy = P.y + dir.y * len * t - droop * len * t * t; cz = P.z + dir.z * len * t;
      for (c = 0; c < nc; c++) {
        cc2 = nc === 3 ? c - 1 : c * 2 - 1; e = Math.abs(cc2);
        px = cx + sx * hw * cc2 * cv + nx * hw * e * sv; py = cy + sy * hw * cc2 * cv + ny * hw * e * sv; pz = cz + sz * hw * cc2 * cv + nz * hw * e * sv;
        ox = (px - cc.x) / cc.rx + nx * 0.3; oy = (py - cc.y) / cc.ry + 0.35 + ny * 0.3; oz = (pz - cc.z) / cc.rx + nz * 0.3;
        ol = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
        F.p.push(px, py, pz); F.n.push(ox / ol, oy / ol, oz / ol);
        u = cell.u0 + (cell.u1 - cell.u0) * (cc2 + 1) * 0.5;
        F.u.push(u, cell.vb + (cell.vt - cell.vb) * t);
        k = 1 + 0.12 * t;
        F.c.push(col[0] * k, col[1] * k, col[2] * k);
        F.w.push(bw + t * (0.45 + 0.55 * e), ph);
      }
    }
    for (r = 0; r < 2; r++) for (c = 0; c < nc - 1; c++) { a = base + r * nc + c; b = a + nc; F.i.push(a, a + 1, b, a + 1, b + 1, b); }
    F.nv += 3 * nc;
  }
  function fcol(ao) { return [ao * rr(0.88, 1.06), ao * rr(0.92, 1.08), ao * rr(0.82, 1.02)]; }

  // ---------------------------------------------------------------- conifers
  function conifer(sp, detail) {
    var B = new Geo(), F = new Geo(), H = sp.h * rr(0.86, 1.12), r0 = sp.r * (H / sp.h) * rr(0.9, 1.12), nT = 17, k, t, y, tp = [], tr = [];
    var wob = rr(0, TAU), ph = rr(0, TAU), la = rr(0, TAU);
    for (k = 0; k <= nT; k++) {
      t = k === 0 ? 0 : Math.pow((k - 1) / (nT - 1), 1.7); y = k === 0 ? -0.7 : H * t;
      var p = new V3(Math.sin(y * 0.11 + wob) * 0.28 * t, y, Math.cos(y * 0.09 + wob * 1.7) * 0.28 * t);
      if (sp.leader && k >= nT - 1) { var lo = k === nT ? 1.0 : 0.25; p.x += Math.cos(la) * lo; p.z += Math.sin(la) * lo; if (k === nT) p.y -= 0.55; }
      tp.push(p); tr.push(r0 * Math.pow(Math.max(0, 1 - t), 0.85) + 0.025);
    }
    function flare(a, yy) { return 1 + sp.flare * Math.exp(-Math.max(0, yy) / sp.flareH) * (0.4 + 0.6 * Math.pow(Math.abs(Math.cos(a * sp.lobes * 0.5 + ph)), 1.5)); }
    function tcol(kk, pp) { var m = Math.max(0, 1 - Math.max(0, pp.y) / 1.6) * 0.75, s = rr(0.92, 1.05); return [s * (1 - m * 0.3), s * (1 + m * 0.25), s * (1 - m * 0.5)]; }
    tube(B, tp.slice(0, 9), tr.slice(0, 9), detail ? 14 : 9, { flare: flare, col: tcol });
    tube(B, tp.slice(8), tr.slice(8), detail ? 8 : 5, { col: tcol, v0: 3.1 });
    function trunkAt(yy, out) {
      for (var q = 1; q < nT; q++) if (tp[q + 1].y >= yy) break;
      if (q >= nT) q = nT - 1;
      var f = Math.min(1, Math.max(0, (yy - tp[q].y) / (tp[q + 1].y - tp[q].y || 1))); out.lerpVectors(tp[q], tp[q + 1], f);
      return tr[q] + (tr[q + 1] - tr[q]) * f;
    }
    var cb = H * sp.clear * rr(0.9, 1.1), az = rr(0, TAU), cc = { x: 0, y: (cb + H) * 0.5, z: 0, rx: sp.L * (H / sp.h) * 0.9, ry: (H - cb) * 0.55 };
    var O = new V3(), P = new V3(), D = new V3(), S = new V3(), dir = new V3(), limbC = [0.8, 0.78, 0.74], rt, tc, L, e, d, pts, rad, n, cl, ns, s, side, ao, len, cell;
    // dead stubs on the clear bole
    if (detail) for (k = 0; k < sp.stubs; k++) {
      y = cb * rr(0.45, 0.98); rt = trunkAt(y, O); az += 2.4; e = rr(-0.3, 0.2); L = rr(0.4, 1.6);
      d = new V3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e));
      pts = path(O.clone(), d, L + rt, 2, function () { return -0.1; }, 0.08);
      tube(B, pts, [0.05, 0.035, 0.012], 4, { col: function () { return [0.6, 0.6, 0.6]; } });
    }
    y = cb;
    var dyl = sp.dy * (detail ? 1 : 1.5);
    while (y < H - 0.7) {
      tc = (y - cb) / (H - cb);
      if (R() < sp.gap && tc < 0.8) { y += dyl; az += 1.3; continue; }
      L = sp.L * (H / sp.h) * Math.pow(1 - tc, sp.pw) * Math.min(1, 0.4 + tc * sp.low) * rr(0.62, 1.12) + 0.45;
      az += 2.4 + rr(-0.5, 0.5);
      rt = trunkAt(y, O);
      e = sp.e0 + sp.e1 * tc + rr(-0.12, 0.12);
      d = new V3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e));
      n = detail ? 5 : 3;
      pts = path(O.clone(), d, L, n, (function (tcc) { return function (tt) { return sp.bend(tt, tcc) * (5 / n); }; })(tc), 0.035);
      rad = []; var lr = Math.min(rt * 0.6, 0.02 + 0.017 * L);
      for (k = 0; k <= n; k++) rad.push(lr * (1 - 0.86 * k / n) + 0.007);
      tube(B, pts, rad, detail ? 4 : 3, { col: function () { return limbC; } });
      cl = sp.card * (detail ? 1 : 1.5);
      ns = Math.max(2, Math.round(L / (cl * (detail ? 0.5 : 0.42))));
      side = R() < 0.5 ? 1 : -1;
      for (s = 0; s < ns; s++) {
        t = Math.min(0.97, 0.2 + 0.8 * (s + R() * 0.6) / ns);
        at(pts, t, P, D);
        S.set(-D.z, 0, D.x); if (S.lengthSq() < 1e-4) S.set(1, 0, 0); S.normalize();
        len = cl * rr(0.8, 1.15) * (1 - 0.3 * t);
        dir.copy(D).multiplyScalar(sp.fwd).addScaledVector(S, side * rr(0.75, 1.1)); dir.y += sp.cardY + rr(-0.15, 0.15); dir.normalize();
        ao = (0.55 + 0.45 * t) * (0.8 + 0.2 * tc);
        cell = CELLS[(R() * 4) | 0];
        card(F, P, dir, len, len * sp.cw, cell, sp.droop * rr(0.7, 1.3), detail ? sp.vee : 0, rr(-0.25, 0.25), cc, fcol(ao), 0.25 * t);
        side = -side;
      }
      at(pts, 1, P, D); P.addScaledVector(D, -0.12 * cl);
      dir.copy(D); dir.y += sp.cardY * 0.4; dir.normalize();
      card(F, P, dir, cl * rr(0.85, 1.1), cl * sp.cw, CELLS[(R() * 4) | 0], sp.droop * 0.8, detail ? sp.vee : 0, rr(-0.2, 0.2), cc, fcol(0.95 + 0.1 * tc), 0.3);
      y += dyl * rr(0.7, 1.3) * (1 - 0.25 * tc);
    }
    // leader
    at(tp, 1, P, D);
    for (k = 0; k < 5; k++) {
      az += 1.3; P.copy(tp[nT]); P.y -= k * 0.22;
      if (sp.leader) { dir.copy(D); dir.x += Math.cos(az) * 0.5; dir.z += Math.sin(az) * 0.5; dir.y -= 0.2; }
      else dir.set(Math.cos(az) * 0.75, 0.55 - k * 0.12, Math.sin(az) * 0.75);
      dir.normalize();
      card(F, P, dir, sp.card * rr(0.7, 0.95), sp.card * sp.cw * 0.8, CELLS[(R() * 4) | 0], sp.droop, detail ? sp.vee : 0, 0, cc, fcol(1.05), 0.35);
    }
    return { b: toGeo(B, false), f: toGeo(F, true) };
  }

  // ---------------------------------------------------------------- broadleaf recursion
  var _phi = 0;
  function branch(B, F, S, o, d, len, r, depth, cc) {
    var n = S.n[depth], seg = S.seg[depth], k, t, rad = [], P = new V3(), D = new V3(), sd = new V3(), up = new V3(), dir = new V3(), cs, sn, nch, cl;
    var pts = path(o, d, len, n, function () { return S.bend[depth] * (3 / n); }, S.jit);
    for (k = 0; k <= n; k++) rad.push(Math.max(0.005, r * (1 - 0.72 * k / n)));
    tube(B, pts, rad, seg, { col: (function (c) { return function (kk, pp) { return S.moss && depth === 0 ? [c[0] * (1 - 0.25 * Math.max(0, 1 - pp.y)), c[1] * (1 + 0.2 * Math.max(0, 1 - pp.y)), c[2] * (1 - 0.4 * Math.max(0, 1 - pp.y))] : c; }; })(S.col[depth]) });
    function perp(Dv, spread) {
      sd.set(-Dv.z, 0, Dv.x); if (sd.lengthSq() < 1e-4) sd.set(1, 0, 0); sd.normalize(); up.crossVectors(Dv, sd);
      _phi += 2.4 + rr(-0.4, 0.4); cs = Math.cos(_phi); sn = Math.sin(_phi);
      dir.set(sd.x * cs + up.x * sn, sd.y * cs + up.y * sn, sd.z * cs + up.z * sn).multiplyScalar(Math.sin(spread)).addScaledVector(Dv, Math.cos(spread));
      return dir;
    }
    if (depth >= S.maxD) {
      for (k = 0; k < S.cards; k++) {
        t = 0.2 + 0.8 * k / (S.cards - 1);
        at(pts, t, P, D);
        perp(D, k === S.cards - 1 ? 0.25 : rr(0.7, 1.2));
        if (S.flat) dir.y = dir.y * 0.3 + 0.02; else dir.y -= 0.22;
        dir.normalize();
        cl = S.cardLen * rr(0.82, 1.18);
        var hd = Math.sqrt((P.x - cc.x) * (P.x - cc.x) + (P.z - cc.z) * (P.z - cc.z)) / cc.rx, ao = Math.min(1.08, 0.62 + 0.42 * hd + 0.12 * (P.y - cc.y) / cc.ry);
        card(F, P, dir, cl, cl * 0.98, CELLS[S.cells[(R() * S.cells.length) | 0]], S.droop * rr(0.5, 1.5), 0, S.flat ? rr(-0.35, 0.35) : rr(-1.1, 1.1), cc, fcol(ao), 0.35 + 0.3 * t);
      }
      return;
    }
    nch = S.kids[depth];
    for (k = 0; k < nch; k++) {
      t = S.t0 + (1 - S.t0) * (k + rr(0.15, 0.85)) / nch;
      at(pts, t, P, D);
      perp(D, S.spread * rr(0.8, 1.2)); dir.y += S.up; dir.normalize();
      branch(B, F, S, P.clone(), dir.clone(), len * S.ratio * rr(0.75, 1.12) * (1 - 0.3 * t), Math.max(0.006, r * (1 - 0.72 * t) * 0.62), depth + 1, cc);
    }
    at(pts, 1, P, D);
    branch(B, F, S, P.clone(), D.clone(), len * 0.3, r * 0.26, S.maxD, cc);
  }
  function alder() {
    var B = new Geo(), F = new Geo(), H = rr(11, 16), r0 = rr(0.16, 0.26), n = 11, k, t, tr = [];
    var tp = path(new V3(0, -0.5, 0), new V3(rr(-0.08, 0.08), 1, rr(-0.08, 0.08)), H + 0.5, n, function () { return 0.02; }, 0.045);
    for (k = 0; k <= n; k++) tr.push(r0 * (1 - 0.82 * k / n) + 0.012);
    function flare(a, y) { return 1 + 0.55 * Math.exp(-Math.max(0, y) / 0.3); }
    function tcol(kk, pp) { var m = Math.max(0, 1 - Math.max(0, pp.y) / 1.1) * 0.8, s = rr(0.94, 1.04); return [s * (1 - m * 0.45), s * (1 - m * 0.12), s * (1 - m * 0.68)]; }
    tube(B, tp.slice(0, 6), tr.slice(0, 6), 12, { flare: flare, col: tcol });
    tube(B, tp.slice(5), tr.slice(5), 7, { col: tcol, v0: 3.3 });
    var cc = { x: 0, y: H * 0.68, z: 0, rx: H * 0.3, ry: H * 0.36 }, P = new V3(), D = new V3(), az = rr(0, TAU), e, np = 11;
    var S = { maxD: 3, n: [0, 4, 3, 1], seg: [0, 5, 3, 3], kids: [0, 4, 3], ratio: 0.55, spread: 0.75, up: 0.28, jit: 0.07, bend: [0, 0.07, 0.03, 0], t0: 0.3, cards: 6,
      cardLen: 0.4, cells: [0, 1, 2, 3], flat: false, droop: 0.25, col: [WHITE, [0.95, 0.95, 0.93], [0.78, 0.76, 0.72], [0.5, 0.42, 0.36]] };
    for (k = 0; k < np; k++) {
      t = 0.36 + 0.6 * (k + R() * 0.5) / np; at(tp, t, P, D);
      az += 2.4 + rr(-0.4, 0.4); e = 0.45 + 0.55 * t + rr(-0.1, 0.1);
      branch(B, F, S, P.clone(), new V3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e)), H * 0.3 * (1 - 0.5 * t) * rr(0.8, 1.15), (tr[0] * (1 - 0.82 * t)) * 0.5, 1, cc);
    }
    at(tp, 1, P, D);
    branch(B, F, S, P.clone(), D.clone(), 1.3, 0.02, 2, cc);
    return { b: toGeo(B, false), f: toGeo(F, true) };
  }
  function maple(big) {
    var B = new Geo(), F = new Geo(), ns = big ? 2 : 4 + ((R() * 2) | 0), k, az = rr(0, TAU), H = big ? rr(7, 9) : rr(4, 6.5), e;
    var cc = { x: 0, y: H * 0.6, z: 0, rx: H * 0.55, ry: H * 0.45 };
    var S = { maxD: 2, n: [7, 3, 1], seg: [big ? 9 : 7, 4, 3], kids: [6, 3], ratio: 0.42, spread: 0.9, up: 0.05, jit: 0.07, bend: [big ? -0.03 : -0.085, -0.03, 0], t0: 0.35, cards: 5,
      cardLen: big ? 0.72 : 0.45, cells: big ? [2, 3] : [0, 1], flat: true, droop: 0.14, moss: true,
      col: [[0.95, 1.05, 0.85], [0.85, 0.95, 0.72], [0.6, 0.5, 0.42]] };
    for (k = 0; k < ns; k++) {
      az += TAU / ns + rr(-0.4, 0.4); e = big ? rr(1.15, 1.4) : rr(0.95, 1.25);
      branch(B, F, S, new V3(Math.cos(az) * 0.12, -0.2, Math.sin(az) * 0.12), new V3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e)),
        H * rr(0.85, 1.15), big ? rr(0.11, 0.15) : rr(0.045, 0.075), 0, cc);
    }
    return { b: toGeo(B, false), f: toGeo(F, true) };
  }
  _tan = new V3(); _nx = new V3(); _bx = new V3();
  CELLS = [cellUV(0), cellUV(1), cellUV(2), cellUV(3)];
  // a seeded generator for the builders (mulberry32); build functions get it as rand and the kit draws from it while they run
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function withRand(rand, fn) { var old = R; R = rand; try { return fn(); } finally { R = old; } }
  // (the prototype's sun was gentler than the game's: the albedo comes down to match the ground's)
  var lit = function (m, key) { m.color.multiplyScalar(key === "bark" ? 0.6 : 0.42); return real.lit(m, { light: "open", key: key }); };
  real.kit = {
    Geo: Geo, toGeo: toGeo, tube: tube, path: path, at: at, card: card, branch: branch, spray: spray, needles: needles, cells: cells, cellUV: cellUV,
    atlasTex: atlasTex, barkTex: barkTex, rng: rng, withRand: withRand,
    conifer: function (sp, detail) { var g = conifer(sp, detail); return { bark: g.b, foliage: g.f }; },
    broadleaf: function () { var g = alder(); return { bark: g.b, foliage: g.f }; },
    // a single-trunk broadleaf sized for a block world: o = { h, r, limbs, cards, cardLen, crown: [from, width, height], spread, up, droop, flat }
    broadleafP: function (o, detail) {
      var dl = detail | 0, lim = dl === 2 ? Math.max(3, Math.round(o.limbs * 0.4)) : dl === 1 ? Math.max(4, Math.round(o.limbs * 0.7)) : o.limbs;
      var B = new Geo(), F = new Geo(), H = o.h * rr(0.9, 1.1), r0 = o.r * rr(0.85, 1.15), n = 8, k, t, tr = [];
      var tp = path(new V3(0, -0.4, 0), new V3(rr(-0.06, 0.06), 1, rr(-0.06, 0.06)), H + 0.4, n, function () { return 0.015; }, 0.04);
      for (k = 0; k <= n; k++) tr.push(r0 * (1 - 0.8 * k / n) + 0.02);
      function flare(a, y) { return 1 + 0.5 * Math.exp(-Math.max(0, y) / 0.35); }
      tube(B, tp, tr, dl === 2 ? 4 : dl === 1 ? 5 : 7, { flare: flare });
      var c0 = o.crown[0], cc = { x: 0, y: H * (c0 + (1 - c0) * 0.55), z: 0, rx: H * o.crown[1], ry: H * o.crown[2] }, P = new V3(), D = new V3(), az = rr(0, TAU), e;
      var S = { maxD: 2, n: [0, dl ? 2 : 3, dl === 2 ? 1 : 2], seg: [0, dl ? 3 : 4, 3], kids: [0, dl === 2 ? 2 : dl === 1 ? 3 : 4], ratio: 0.62, spread: o.spread || 0.8, up: o.up == null ? 0.25 : o.up, jit: 0.07, bend: [0, 0.05, 0.02], t0: 0.3,
        cards: dl === 2 ? Math.max(2, Math.round(o.cards * 0.4)) : dl === 1 ? Math.max(3, Math.round(o.cards * 0.6)) : o.cards, cardLen: o.cardLen * (dl === 2 ? 1.7 : dl === 1 ? 1.25 : 1), cells: [0, 1, 2, 3], flat: !!o.flat, droop: o.droop == null ? 0.25 : o.droop, col: [WHITE, [0.9, 0.9, 0.88], [0.7, 0.66, 0.6]] };
      for (k = 0; k < lim; k++) {
        t = c0 + (0.97 - c0) * (k + R() * 0.6) / lim; at(tp, t, P, D);
        az += 2.4 + rr(-0.4, 0.4); e = 0.25 + 0.75 * t + rr(-0.1, 0.1);
        branch(B, F, S, P.clone(), new V3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e)), H * o.crown[1] * (1.15 - 0.55 * t) * rr(0.85, 1.15), Math.max(0.03, r0 * (1 - 0.8 * t) * 0.55), 1, cc);
      }
      at(tp, 1, P, D);
      branch(B, F, S, P.clone(), D.clone(), H * 0.14, 0.03, 2, cc);
      return { bark: toGeo(B, false), foliage: toGeo(F, true) };
    },
    // a conifer sized for a block world: whorls of whole boughs (one card each) on a straight trunk.
    // o = { h, r, clear, L (lowest boughs' length), dy (whorl spacing), per (boughs a whorl), e0, e1 (bough pitch at the base and the top), droop, width }
    coniferP: function (o, detail) {
      var dl = detail | 0, dys = dl === 2 ? 2.6 : dl === 1 ? 1.6 : 1, pern = dl === 2 ? 4 : dl === 1 ? o.per - 1 : o.per, wide = dl === 2 ? 1.5 : dl === 1 ? 1.2 : 1;
      var B = new Geo(), F = new Geo(), H = o.h * rr(0.9, 1.1), r0 = o.r * rr(0.85, 1.15), n = 8, k, tr = [];
      var tp = path(new V3(0, -0.4, 0), new V3(rr(-0.03, 0.03), 1, rr(-0.03, 0.03)), H + 0.4, n, function () { return 0; }, 0.02);
      for (k = 0; k <= n; k++) tr.push(r0 * (1 - 0.9 * k / n) + 0.015);
      tube(B, tp, tr, dl === 2 ? 4 : 6, { flare: function (a, y) { return 1 + 0.4 * Math.exp(-Math.max(0, y) / 0.3); } });
      var cb = H * o.clear, cc = { x: 0, y: (cb + H) * 0.5, z: 0, rx: o.L * 0.9, ry: (H - cb) * 0.55 }, P = new V3(), D = new V3(), dir = new V3(), az = rr(0, TAU), y = cb, t, L, e, j, per;
      while (y < H - 0.3) {
        t = (y - cb) / (H - cb);
        L = o.L * Math.pow(1 - t, 0.85) * Math.min(1, 0.55 + t * 3) + 0.35;
        per = Math.max(3, Math.round(pern * (1 - 0.4 * t)));
        at(tp, (y + 0.4) / (H + 0.4), P, D);
        for (j = 0; j < per; j++) {
          az += TAU / per + rr(-0.25, 0.25); e = o.e0 + (o.e1 - o.e0) * t + rr(-0.1, 0.1);
          dir.set(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e));
          card(F, P, dir, L * rr(0.85, 1.12), L * o.width * wide * rr(0.9, 1.1), CELLS[(R() * 4) | 0], o.droop * rr(0.7, 1.3), 0.3, rr(-0.15, 0.15), cc, fcol(0.62 + 0.4 * t), 0.3);
        }
        az += 0.6;
        y += o.dy * dys * rr(0.8, 1.2) * (1 - 0.3 * t);
      }
      at(tp, 1, P, D); P.y -= 0.5;
      for (j = 0; j < 4; j++) { az += 1.6; dir.set(Math.cos(az) * 0.35, 1, Math.sin(az) * 0.35).normalize(); card(F, P, dir, 0.9, 0.5, CELLS[(R() * 4) | 0], 0, 0.3, 0, cc, fcol(1.05), 0.35); }
      return { bark: toGeo(B, false), foliage: toGeo(F, true) };
    },
    shrubTree: function (big) { var g = maple(big); return { bark: g.b, foliage: g.f }; },
    barkMat: function (kind, bump) { return lit(barkMat(kind, bump), "bark"); },
    foliageMat: function (tex, trans) { return lit(foliageMat(tex, trans), "foliage"); },
    depthMat: depthMat,
    atlases: { fir: firAtlas, hemlock: hemlockAtlas, cedar: cedarAtlas, alder: alderAtlas, maple: mapleAtlas },
    sunV: sunVU, sunC: sunCU,
  };
})();
const kit = real.kit, T = THREE;

// ---------- the example species ----------
const memo = fn => { let v; return () => v || (v = fn()); };
(() => {
  const firTex = memo(kit.atlases.fir), alderTex = memo(kit.atlases.alder), mapleTex = memo(kit.atlases.maple);
  real.assets.species.push({
    id: "spruce", kind: "tree", log: "spruce_log", weight: 1, variants: 3, height: [10, 14], modelHeight: 12,
    build: (rand, detail) => kit.withRand(rand, () => kit.coniferP({ h: 12, r: 0.24, clear: 0.12, L: 3.0, dy: 0.62, per: 6, e0: -0.35, e1: 0.25, droop: 0.3, width: 0.62 }, detail)),
    barkMaterial: memo(() => kit.barkMat("fir", 0.05)), foliageMaterial: memo(() => kit.foliageMat(firTex(), 0.22)),
  }, {
    id: "oak", kind: "tree", log: "oak_log", weight: 1, variants: 3, height: [7, 9], modelHeight: 8,
    build: (rand, detail) => kit.withRand(rand, () => kit.broadleafP({ h: 8, r: 0.3, limbs: 10, cards: 8, cardLen: 0.85, crown: [0.38, 0.42, 0.36], spread: 0.85, up: 0.12, droop: 0.2, flat: true }, detail)),
    barkMaterial: memo(() => kit.barkMat("maple", 0.03)), foliageMaterial: memo(() => kit.foliageMat(mapleTex(), 0.5)),
  }, {
    id: "birch", kind: "tree", log: "birch_log", weight: 1, variants: 3, height: [8, 10], modelHeight: 9,
    build: (rand, detail) => kit.withRand(rand, () => kit.broadleafP({ h: 9, r: 0.2, limbs: 10, cards: 8, cardLen: 0.66, crown: [0.42, 0.26, 0.34], spread: 0.6, up: 0.35, droop: 0.35 }, detail)),
    barkMaterial: memo(() => kit.barkMat("alder", 0.012)), foliageMaterial: memo(() => kit.foliageMat(alderTex(), 0.42)),
  });
})();

// ---------- the simple placer ----------
// One batch (an InstancedMesh for each part of each model in use) per chunk, as direct children of the scene at the chunk's corner.
// The performance thread replaces place and remove with its scheduler; a record keeps its meaning (contract section 4).
const batches = new Map();   // chunk key -> { objs, cx, cz, y }
const models = new Map();    // species or cover entry -> variant -> [{ geo, mat }]
let byBlock = null;
function candidates(block) {
  if (!byBlock) {
    byBlock = new Map();
    const put = (name, e) => { const id = BF.B[name]; if (id == null) return; if (!byBlock.has(id)) byBlock.set(id, []); byBlock.get(id).push(e); };
    for (const s of real.assets.species) put(s.log, s);
    for (const c of real.assets.cover) put(c.block, c);
  }
  return byBlock.get(block) || null;
}
function resolve(block, biome, logs, seed) {
  const all = candidates(block);
  if (!all) return null;
  let list = all.filter(e => (!e.biomes || e.biomes.includes(biome)) && (!e.logs || (logs >= e.logs[0] && logs <= e.logs[1])));
  if (!list.length) list = all.filter(e => !e.biomes);
  if (!list.length) list = all;
  let w = 0; for (const e of list) w += e.weight || 1;
  let r = seed * w;
  for (const e of list) { r -= e.weight || 1; if (r <= 0) return e; }
  return list[list.length - 1];
}
function parts(entry, variant) {
  let m = models.get(entry);
  if (!m) models.set(entry, (m = []));
  if (m[variant]) return m[variant];
  const rand = kit.rng(((entry.id || "").split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) ^ (variant * 2654435761)) >>> 0);
  const detail = 2 - Math.max(0, Math.min(2, real.quality.level));
  const g = entry.build(rand, detail);
  const out = [];
  if (g && g.isBufferGeometry) out.push({ geo: g, mat: entry.material() });
  else if (g) {
    if (g.bark && g.bark.index && g.bark.index.count) out.push({ geo: g.bark, mat: entry.barkMaterial() });
    if (g.foliage && g.foliage.index && g.foliage.index.count) out.push({ geo: g.foliage, mat: entry.foliageMaterial(), foliage: true });
  }
  return (m[variant] = out);
}
const M4 = new T.Matrix4(), Q = new T.Quaternion(), P3 = new T.Vector3(), S3 = new T.Vector3(), YA = new T.Vector3(0, 1, 0), COL = new T.Color();
real.flora.remove = function (key) {
  const b = batches.get(key);
  if (!b) return;
  for (const o of b.objs) { real.scene.remove(o); if (o.dispose) o.dispose(); }
  batches.delete(key);
};
real.flora.place = function (key, ox, oz, F) {
  real.flora.remove(key);
  if (!F || !F.length || !real.scene) return;
  let biome = "";
  try { const b = BF.worldgen.biomeAt(ox + 8, oz + 8); biome = typeof b === "string" ? b : (b && b.name) || ""; } catch (_) { /* unknown */ }
  const groups = new Map();
  let ysum = 0, n = 0;
  for (let i = 0; i < F.length; i += 8) {
    const block = F[i + 4], logs = F[i + 5], seed = F[i + 6];
    const e = resolve(block, biome, logs, (seed * 7.13) % 1);
    if (!e) continue;
    const v = Math.floor(seed * 9973) % Math.max(1, e.variants || 1);
    const k = (e.id || block) + ":" + v;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { e, v, recs: [] }));
    g.recs.push(i);
    ysum += F[i + 1]; n++;
  }
  if (!n) return;
  const objs = [];
  for (const g of groups.values()) {
    let ps;
    try { ps = parts(g.e, g.v); } catch (err) { console.error("BF.real flora: " + (g.e.id || "?") + " failed to build", err); g.e.build = () => null; continue; }
    for (const p of ps) {
      const im = new T.InstancedMesh(p.geo, p.mat, g.recs.length);
      g.recs.forEach((i, j) => {
        const kind = F[i + 3], logs = F[i + 5], seed = F[i + 6], extra = F[i + 7];
        const tree = kind === 0 || kind === 4;
        // a tree's model reaches a little past its log column (the crown the leaf blocks made)
        const want = tree ? logs + 2.5 : 1, mh = g.e.modelHeight || (g.e.height ? (g.e.height[0] + g.e.height[1]) / 2 : 1);
        const s = tree ? (want / mh) * (0.92 + 0.16 * ((seed * 13.7) % 1)) * (kind === 4 ? 1.5 : 1) : 0.85 + 0.3 * ((seed * 13.7) % 1);
        P3.set(F[i], F[i + 1], F[i + 2]); Q.setFromAxisAngle(YA, seed * 6.2831853); S3.set(s, s, s);
        im.setMatrixAt(j, M4.compose(P3, Q, S3));
        const sky = (extra % 16) / 15, l = (0.35 + 0.65 * sky) * (0.9 + 0.2 * ((seed * 5.3) % 1));
        im.setColorAt(j, COL.setRGB(l, l, l));
      });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.position.set(ox, 0, oz);
      im.frustumCulled = false;   // (its bounds are one model's: frame() below hides whole batches instead)
      im.castShadow = true; im.receiveShadow = !p.foliage;
      real.scene.add(im); objs.push(im);
    }
  }
  batches.set(key, { objs, cx: ox + 8, cz: oz + 8, y: ysum / n });
};
real.flora.batches = batches;
real.flora.resolve = resolve;

// Batches out of view or too far away are hidden (cheap: a sphere a chunk). The performance thread's scheduler replaces this.
const fr = new T.Frustum(), pm = new T.Matrix4(), cm = new T.Matrix4(), inv = new T.Matrix4(), ONE = new T.Vector3(1, 1, 1), sph = new T.Sphere(), tr = [0, 0, 0];
function cull() {
  const cam = real.camera;
  if (!cam) return;
  // in atlas coordinates, where the camera's own matrix lives (near the ground the view only moves the origin to the eye)
  cm.compose(cam.position, cam.quaternion, ONE); inv.copy(cm).invert();
  kit.sunV.value.copy(real.U.uSunDir.value).transformDirection(inv);
  kit.sunC.value.copy(BF.atmos.sunColor).multiplyScalar(Math.min(1, BF.atmos.sunIntensity / 2.2));
  fr.setFromProjectionMatrix(pm.multiplyMatrices(cam.projectionMatrix, inv));
  const far = real.quality.level >= 2 ? 176 : real.quality.level === 1 ? 128 : 96, px = cam.position.x, pz = cam.position.z;
  for (const b of batches.values()) {
    const dx = b.cx - px, dz = b.cz - pz, d2 = dx * dx + dz * dz;
    let vis;
    if (d2 > 1e6) {   // across a face edge of the planet: the atlas is cut there, so ask the view
      const p = BF.view.toRender(b.cx, b.y, b.cz, tr);
      vis = !!p && p[0] * p[0] + p[2] * p[2] < far * far;
    } else {
      sph.center.set(b.cx, b.y + 8, b.cz); sph.radius = 40;
      vis = d2 < far * far && fr.intersectsSphere(sph);
    }
    if (real.flora.nocull) vis = true;
    for (const o of b.objs) o.visible = vis;
  }
}
// (run by the view once it has placed the camera for the frame, js/view.js; hidden batches are not placed by it at all)
real.module({ name: "flora", init() { BF.view.onBegin(cull); } });
})();
