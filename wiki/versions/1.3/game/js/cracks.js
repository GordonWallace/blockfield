// Block-breaking overlay: 10 progressive destroy stages (procedural 32px crack textures), drawn as a decal that hugs the
// block's real shape (model / collision boxes, full cubes inflated by 0.002), multiplied onto the lit framebuffer
// (blend src*dst*2 like vanilla, so it never glows in the dark), plus hit ticks every 0.25 s that emit
// BF.emit("blockHit", x, y, z, id, progress), throw block-coloured debris off the hit face and pulse the overlay.
// player.js calls BF.cracks.show(...) every frame while mining (survival) and BF.cracks.hide() from resetBreak().
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const STAGES = 10, TEX = 32, HIT_EVERY = 0.25, INFLATE = 0.002, MAX_QUADS = 192, POOL = 64;
const FULL = [[0, 0, 0, 16, 16, 16]];

// ---------- crack textures ----------
// One deterministic crack network: lines random-walk out from the centre (plus a few late seeds further out, which start
// when the front reaches them) and every pixel records the "time" (path length from the centre) it appears at. Stage s
// shows every pixel born before T(s), so each stage is a strict superset of the previous one.
function rng(seed) { return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296); }
function crackNetwork() {
  const birth = new Float32Array(TEX * TEX).fill(Infinity), shade = new Float32Array(TEX * TEX);
  const r = rng(0x6d2b79f5), C = TEX / 2 - 0.5;
  const mark = (px, py, t, v) => {
    if (px < 0 || py < 0 || px >= TEX || py >= TEX) return false;
    const k = py * TEX + px;
    if (t < birth[k]) { birth[k] = t; shade[k] = v; }
    return true;
  };
  const walk = (x, y, ang, t, len, depth) => {
    const wob = 0.35 + depth * 0.1;
    for (let i = 0; i < len; i++) {
      ang += (r() - 0.5) * wob;
      x += Math.cos(ang) * 0.6; y += Math.sin(ang) * 0.6; t += 0.6;
      if (!mark(Math.floor(x), Math.floor(y), t, 0.16 + r() * 0.12)) return;
      // thicker near the centre (the impact point)
      const d = Math.hypot(x - C, y - C);
      if (d < 1.5) mark(Math.floor(x + 1), Math.floor(y), t + 0.5, 0.24);
      if (depth < 3 && r() < 0.05) walk(x, y, ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.7), t, (len - i) * (0.45 + r() * 0.35), depth + 1);
    }
  };
  const n = 6;
  for (let k = 0; k < n; k++) walk(C, C, (k / n) * Math.PI * 2 + (r() - 0.5) * 0.7, 0, 26 + r() * 12, 0);
  // secondary cracks that open later, further out
  for (let k = 0; k < 14; k++) {
    const a = r() * Math.PI * 2, d = 7 + r() * 8, x = C + Math.cos(a) * d, y = C + Math.sin(a) * d;
    walk(x, y, a + (r() - 0.5) * 2.2, d * 1.1, 8 + r() * 10, 1);
  }
  // a lighter edge pixel below/right of crack pixels (the bevel the vanilla/Faithful textures have)
  const base = birth.slice();
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const k = y * TEX + x;
    if (base[k] === Infinity) continue;
    const q = (y + 1) * TEX + x + 1;
    if (x + 1 < TEX && y + 1 < TEX && base[q] === Infinity && birth[q] === Infinity && ((x * 7 + y * 13) % 3)) { birth[q] = base[k] + 0.3; shade[q] = 0.62; }
  }
  let max = 0;
  for (const t of birth) if (t !== Infinity && t > max) max = t;
  return { birth, shade, max };
}
function crackCanvases() {
  const net = crackNetwork(), out = [];
  for (let s = 0; s < STAGES; s++) {
    const T = net.max * (0.13 + 0.87 * Math.pow(s / (STAGES - 1), 1.1)) + 1e-3; // stage 0: short thin cracks around the centre
    const c = document.createElement("canvas"); c.width = c.height = TEX;
    const g = c.getContext("2d"), img = g.createImageData(TEX, TEX), d = img.data;
    for (let k = 0; k < TEX * TEX; k++) {
      if (!(net.birth[k] <= T)) continue;
      const v = Math.round(net.shade[k] * 255);
      d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = v; d[k * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    out.push(c);
  }
  return out;
}

// ---------- overlay geometry (preallocated, rewritten when the target changes) ----------
let mesh = null, geo = null, posArr, uvArr, mats = [], canvases = null;
let curKey = "", hitT = 0, pulse = 0, cx = 0, cy = 0, cz = 0;

function init() {
  if (mesh || !BF.scene || typeof THREE === "undefined") return !!mesh;
  canvases = crackCanvases();
  for (const c of canvases) {
    const t = new THREE.CanvasTexture(c);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    mats.push(new THREE.MeshBasicMaterial({
      map: t, transparent: true, alphaTest: 0.5, depthWrite: false, fog: false, side: THREE.FrontSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    }));
  }
  geo = new THREE.BufferGeometry();
  posArr = new Float32Array(MAX_QUADS * 4 * 3); uvArr = new Float32Array(MAX_QUADS * 4 * 2);
  const idx = new Uint16Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) { const v = q * 4, i = q * 6; idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2; idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3; }
  geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
  mesh = new THREE.Mesh(geo, mats[0]);
  mesh.visible = false; mesh.renderOrder = 3; mesh.frustumCulled = false;
  BF.scene.add(mesh);
  return true;
}

// Model boxes in 1/16 for block id at (x, y, z), or "cross" for crossed-quad plants.
const get = (x, y, z) => BF.world.getBlock(x, y, z);
const fenceJoin = (x, y, z, self) => { const n = get(x, y, z), b = BF.blocks[n]; return n === self || (b && b.model === "fence") || (BF.OPAQUE[n] && BF.SOLID[n]); };
function boxesFor(x, y, z, id) {
  const b = BF.blocks[id];
  if (!b) return FULL;
  const W = BF.world;
  if (typeof W.modelBoxes === "function") { try { const r = W.modelBoxes(x, y, z, id); if (r && r.length) return r; } catch (_) {} }
  const R = BF.RENDER[id];
  if (R === 4) return "cross";
  if (R === 5) {
    if (BF.DYNBOXES && BF.DYNBOXES[id]) { try { return BF.DYNBOXES[id](get, x, y, z, id).map(q => q.slice(0, 6).map(v => v * 16)); } catch (_) {} }
    if (b.boxes && b.boxes.length) return b.boxes;
    switch (b.model) {
      case "fence": {
        const o = [[6, 0, 6, 10, 16, 10]];
        if (fenceJoin(x + 1, y, z, id)) o.push([10, 6, 7, 16, 9, 9], [10, 12, 7, 16, 15, 9]);
        if (fenceJoin(x - 1, y, z, id)) o.push([0, 6, 7, 6, 9, 9], [0, 12, 7, 6, 15, 9]);
        if (fenceJoin(x, y, z + 1, id)) o.push([7, 6, 10, 9, 9, 16], [7, 12, 10, 9, 15, 16]);
        if (fenceJoin(x, y, z - 1, id)) o.push([7, 6, 0, 9, 9, 6], [7, 12, 0, 9, 15, 6]);
        return o;
      }
      case "lantern": {
        const o = BF.SOLID[get(x, y + 1, z)] && !BF.SOLID[get(x, y - 1, z)] ? 6 : 0;
        return [[5, o, 5, 11, o + 7, 11], [6, o + 7, 6, 10, o + 9, 10]];
      }
      case "torch":
        if (b.wallTorch) { const [dx, dz] = BF.DIRS[b.wallTorch.f], s = -4; return [[7 + dx * s, 3, 7 + dz * s, 9 + dx * s, 13, 9 + dz * s]]; } // leans towards its wall
        return [[7, 0, 7, 9, 10, 9]];
      case "bell": return [[4, 4, 4, 12, 6, 12], [5, 6, 5, 11, 13, 11], [7, 13, 7, 9, 16, 9]];
      case "chest": return [[1, 0, 1, 15, 14, 15]];
      case "cactus": return [[1, 0, 1, 15, 16, 15]];
    }
    if (b.box) return [b.box];
    return FULL;
  }
  if (b.boxes && b.boxes.length) return b.boxes;
  if (b.box) return [b.box];
  if (id === BF.B.dirt_path || id === BF.B.farmland || id === BF.B.farmland_dry) return [[0, 0, 0, 16, 15, 16]];
  return FULL;
}

let nq = 0;
function quad(p, u) { // p: 4 corners [x,y,z] relative to the cell centre, u: 4 [u,v]
  if (nq >= MAX_QUADS) return;
  for (let k = 0; k < 4; k++) {
    posArr[(nq * 4 + k) * 3] = p[k][0]; posArr[(nq * 4 + k) * 3 + 1] = p[k][1]; posArr[(nq * 4 + k) * 3 + 2] = p[k][2];
    uvArr[(nq * 4 + k) * 2] = u[k][0]; uvArr[(nq * 4 + k) * 2 + 1] = u[k][1];
  }
  nq++;
}
// Six outward-facing quads of a box (blocks, cell-local 0..1); UVs are the face position inside the cell (vanilla style:
// a slab shows the lower half of the crack texture, a pane only the strip it covers).
function emitBox(x0, y0, z0, x1, y1, z1) {
  const e = INFLATE; x0 -= e; y0 -= e; z0 -= e; x1 += e; y1 += e; z1 += e;
  const P = (x, y, z) => [x - 0.5, y - 0.5, z - 0.5];
  const cl = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  // +x (u along -z), -x (u along +z), +y (u +x, v -z), -y (u +x, v +z), +z (u +x), -z (u -x); v = height for the sides
  quad([P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)], [[cl(1 - z1), cl(y0)], [cl(1 - z0), cl(y0)], [cl(1 - z0), cl(y1)], [cl(1 - z1), cl(y1)]]);
  quad([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], [[cl(z0), cl(y0)], [cl(z1), cl(y0)], [cl(z1), cl(y1)], [cl(z0), cl(y1)]]);
  quad([P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)], [[cl(x0), cl(1 - z1)], [cl(x1), cl(1 - z1)], [cl(x1), cl(1 - z0)], [cl(x0), cl(1 - z0)]]);
  quad([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], [[cl(x0), cl(z0)], [cl(x1), cl(z0)], [cl(x1), cl(z1)], [cl(x0), cl(z1)]]);
  quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], [[cl(x0), cl(y0)], [cl(x1), cl(y0)], [cl(x1), cl(y1)], [cl(x0), cl(y1)]]);
  quad([P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)], [[cl(1 - x1), cl(y0)], [cl(1 - x0), cl(y0)], [cl(1 - x0), cl(y1)], [cl(1 - x1), cl(y1)]]);
}
function buildGeometry(x, y, z, id) {
  nq = 0;
  const boxes = boxesFor(x, y, z, id);
  if (boxes === "cross") { // two crossed planes, both sides
    const a = 0.15, b = 0.85, D = [[[a, 0, a], [b, 0, b], [b, 1, b], [a, 1, a]], [[a, 0, b], [b, 0, a], [b, 1, a], [a, 1, b]]];
    const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const q of D) {
      const p = q.map(c => [c[0] - 0.5, c[1] - 0.5, c[2] - 0.5]);
      quad(p, U); quad([p[1], p[0], p[3], p[2]], [U[0], U[1], U[2], U[3]]);
    }
  } else {
    for (const bx of boxes) {
      if (!bx || bx.length < 6) continue;
      emitBox(bx[0] / 16, bx[1] / 16, bx[2] / 16, bx[3] / 16, bx[4] / 16, bx[5] / 16);
    }
  }
  geo.setDrawRange(0, nq * 6);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.uv.needsUpdate = true;
}

// ---------- debris particles (pooled; block texture colours) ----------
const pool = [], live = [];
let partGeo = null, rafOn = false, lastT = 0;
const palettes = {};
function tilePalette(tile, color) {
  const key = tile + "|" + color;
  if (palettes[key]) return palettes[key];
  let pal = [];
  try {
    // the atlas texture's level-0 image is an ImageData: read it directly (no canvas readback)
    const built = BF.textures.build(), img = built.texture && built.texture.image, r = BF.textures.uv(tile);
    const src = img && img.data ? img : built.canvas.getContext("2d").getImageData(0, 0, built.canvas.width, built.canvas.height);
    const W = src.width, H = src.height, all = src.data;
    const x0 = Math.round(r[0] * W), y0 = Math.round((1 - r[3]) * H), w = Math.max(1, Math.round((r[2] - r[0]) * W)), h = Math.max(1, Math.round((r[3] - r[1]) * H));
    const px = i => { const k = i / 4, x = x0 + (k % w), y = y0 + Math.floor(k / w); return ((y * W) + x) * 4; };
    const tinted = BF.textures.tinted || {};
    const isTinted = Object.keys(tinted).some(k => Array.isArray(tinted[k]) && tinted[k].includes(tile));
    const tc = new THREE.Color(color || "#ffffff");
    const rr = rng(w * 31 + h);
    for (let k = 0; k < 48 && pal.length < 16; k++) {
      const i = px(Math.floor(rr() * w * h) * 4);
      if (all[i + 3] < 128) continue;
      const c = new THREE.Color(all[i] / 255, all[i + 1] / 255, all[i + 2] / 255).multiplyScalar(0.82); // ~ the mesher's side-face shade
      if (isTinted) c.multiply(tc).multiplyScalar(1.25);
      pal.push(c);
    }
  } catch (_) { pal = []; }
  if (!pal.length) pal = [new THREE.Color(color || "#888888")];
  return (palettes[key] = pal);
}
function faceTile(b, n) {
  const t = b && b.tiles;
  if (!t) return null;
  if (typeof t === "string") return t;
  return n[1] > 0 ? t.top : n[1] < 0 ? t.bottom : (t.side || t.front || t.top);
}
function lightAt(x, y, z) {
  const day = BF.world.daylight != null ? BF.world.daylight : 1;
  let bl = 0; try { bl = BF.world.getBlockLight(x, y, z) / 15; } catch (_) {}
  // roofed cells get less sky light (a cheap column check like the mesher's sky term)
  let sky = day;
  try { const h = BF.world.heightAt(x, z); if (h >= 0 && h > y) sky *= 0.45; } catch (_) {}
  return Math.max(0.12, sky, Math.min(1, bl * 1.1));
}
function spawnDebris(x, y, z, id, n, count) {
  if (!partGeo) partGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055);
  const b = BF.blocks[id];
  const tile = faceTile(b, n), pal = tile ? tilePalette(tile, b.color) : [new THREE.Color((b && b.color) || "#888")];
  // where the face is: the hit face of the cell (slabs: clamp into the real box height)
  const boxes = boxesFor(x, y, z, id);
  let top = 1, bot = 0;
  if (Array.isArray(boxes)) { top = 0; bot = 1; for (const q of boxes) { top = Math.max(top, q[4] / 16); bot = Math.min(bot, q[1] / 16); } }
  const L = lightAt(x + n[0], y + n[1], z + n[2]);
  for (let i = 0; i < count; i++) {
    let p = pool.pop();
    if (!p) {
      if (live.length >= POOL) break;
      p = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial());
      p.userData = {};
    }
    const c = pal[Math.floor(Math.random() * pal.length)];
    p.material.color.setRGB(c.r * L, c.g * L, c.b * L);
    const t1 = Math.random(), t2 = Math.random();
    let px, py, pz;
    if (n[0]) { px = x + (n[0] > 0 ? 1.04 : -0.04); py = y + bot + (top - bot) * t1; pz = z + 0.1 + t2 * 0.8; }
    else if (n[2]) { pz = z + (n[2] > 0 ? 1.04 : -0.04); py = y + bot + (top - bot) * t1; px = x + 0.1 + t2 * 0.8; }
    else { py = y + (n[1] > 0 ? top + 0.04 : bot - 0.04); px = x + 0.1 + t1 * 0.8; pz = z + 0.1 + t2 * 0.8; }
    p.position.set(px, py, pz);
    p.scale.setScalar(0.6 + Math.random() * 0.7);
    const u = p.userData, out = 0.6 + Math.random() * 1.2;
    u.vx = n[0] * out + (Math.random() - 0.5) * 1.6;
    u.vz = n[2] * out + (Math.random() - 0.5) * 1.6;
    u.vy = (n[1] > 0 ? 2.2 : n[1] < 0 ? -0.5 : 1.2) + Math.random() * 1.6;
    u.life = 0.35 + Math.random() * 0.35;
    BF.scene.add(p); live.push(p);
  }
  if (!rafOn) { rafOn = true; lastT = performance.now(); requestAnimationFrame(tick); }
}
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)); lastT = now;
  const frozen = BF.state && BF.state.paused;
  for (let i = live.length - 1; i >= 0; i--) {
    const p = live[i], u = p.userData;
    if (frozen) continue;
    u.life -= dt; u.vy -= 18 * dt;
    p.position.x += u.vx * dt; p.position.z += u.vz * dt;
    const ny = p.position.y + u.vy * dt;
    let solid = false; try { solid = BF.world.isSolid(p.position.x, ny - 0.03, p.position.z); } catch (_) {}
    if (u.vy < 0 && solid) { u.vy = 0; u.vx *= 0.5; u.vz *= 0.5; } else p.position.y = ny;
    if (u.life <= 0) { BF.scene.remove(p); live.splice(i, 1); pool.push(p); }
  }
  if (pulse > 0 && mesh) { pulse = Math.max(0, pulse - dt * 9); const s = 1 + 0.012 * pulse; mesh.scale.set(s, s, s); }
  if (live.length || pulse > 0) requestAnimationFrame(tick); else rafOn = false;
}

// ---------- public API ----------
BF.cracks = {
  STAGES, TEX,
  // Called every frame while a block is being mined. progress 0..1, normal = hit face. Returns true on a hit tick.
  show(x, y, z, id, progress, normal, dt) {
    if (!init()) return false;
    const key = x + "," + y + "," + z + "," + id;
    if (key !== curKey) { curKey = key; buildGeometry(x, y, z, id); hitT = 0; cx = x; cy = y; cz = z; }
    mesh.position.set(cx + 0.5, cy + 0.5, cz + 0.5);
    const stage = Math.max(0, Math.min(STAGES - 1, Math.floor(progress * STAGES)));
    mesh.material = mats[stage];
    mesh.visible = true;
    hitT -= dt || 0;
    if (hitT > 0) return false;
    hitT = HIT_EVERY;
    const n = normal || [0, 1, 0];
    pulse = 1;
    try { spawnDebris(x, y, z, id, n, 4); } catch (e) { console.error(e); }
    if (!rafOn) { rafOn = true; lastT = performance.now(); requestAnimationFrame(tick); }
    if (BF.emit) BF.emit("blockHit", x, y, z, id, progress);
    return true;
  },
  hide() {
    curKey = ""; hitT = 0; pulse = 0;
    if (mesh) { mesh.visible = false; mesh.scale.set(1, 1, 1); }
  },
  get visible() { return !!(mesh && mesh.visible); },
  get stage() { return mesh && mesh.visible ? mats.indexOf(mesh.material) : -1; },
  get particles() { return live.length; },
  canvases: () => (canvases || (canvases = crackCanvases())),
  boxesFor,
};
})();
