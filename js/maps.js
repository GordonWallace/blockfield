// Maps and compasses (vanilla-like). Five map sizes; the smallest covers 8x8 chunks (128x128 blocks, 1 block per pixel), each next size doubles the
// side (scale 2, 4, 8, 16 blocks per pixel). A blank map becomes a filled map when it is used (right click): it is bound to the 8x8-chunk ZONE the
// player stands in (zone = floor(block / 128) on both axes) and centred on that zone, so every use inside a zone gives the same boundaries.
// Bigger maps keep the centre of the zone and just cover more (a paper ring around a map makes the next size, used or not).
// Filled maps are items named "filled_map_<size>_<zoneX>_<zoneZ>" (created on demand by BF.resolveItem, saved by name); all copies of one
// size and zone share the explored pixels, which live in BF.maps (saved in the world file). A map only fills in while it is in the hand:
// pixels near the player are sampled from the loaded world each frame. Held view: js/player.js asks heldTexture() for a canvas texture.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PX = 128, ZONE = 128, MAX_SIZE = 5;
// Fill radius while a map is held, in blocks: 40 on the smallest map, shrinking with the square root of the scale (28, 20, 14, ...) down to a floor of 16,
// so big maps fill in more slowly per block walked (never less than ~1.5 pixels). Same rule for anything that calls explore(), e.g. explorer villagers.
const revealBlocks = size => Math.max(16, 40 / Math.sqrt(scale(size)));
const revealPx = size => Math.max(1.5, revealBlocks(size) / scale(size));
const BUDGET = 900;         // pixel samples per frame
const side = s => ZONE * Math.pow(2, s - 1);      // blocks per side of a size-s map
const scale = s => Math.pow(2, s - 1);            // blocks per pixel
const keyOf = (s, zx, zz) => s + "_" + zx + "_" + zz;
const nameOf = (s, zx, zz) => "filled_map_" + keyOf(s, zx, zz);
const centre = z => z * ZONE + ZONE / 2;
const originX = (s, zx) => centre(zx) - side(s) / 2;

const data = new Map();     // key -> {size, zx, zz, px: Uint16Array(PX*PX) (RGB565, 0 = unexplored), ver, cur, merged: {size: ver of that smaller map when last merged in}}
function getData(s, zx, zz, create = true) {
  const k = keyOf(s, zx, zz);
  let d = data.get(k);
  if (!d && create) { d = { size: s, zx, zz, px: new Uint16Array(PX * PX), ver: 0, cur: 0, merged: {} }; data.set(k, d); }
  return d || null;
}
const zoneOf = v => Math.floor(v / ZONE);
const dataOfItem = it => (it && it.map ? getData(it.map.size, it.map.zx, it.map.zz) : null);

// ---------------------------------------------------------------- sampling the world
const RGB = new Map();
function rgbOf(id) {
  let c = RGB.get(id);
  if (c) return c;
  const b = BF.blocks[id], m = b && /^#([0-9a-f]{6})$/i.exec(b.color || "");
  c = m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16)] : [127, 127, 127];
  RGB.set(id, c);
  return c;
}
const WATER = [63, 118, 228];
// Top visible block of a column: {id, y} or {water: true, depth, bottom, y}; null when the chunk is not loaded.
function column(wx, wz) {
  const c = BF.world.chunkAt(wx, wz);
  if (!c) return null;
  const lx = wx - c.cx * 16, lz = wz - c.cz * 16;
  const W = BF.world, MIN_Y = BF.MIN_Y;
  for (let y = c.y1 - 1; y >= c.y0; y--) {
    const id = W.chunkBlock(c, lx, y, lz);
    if (!id) continue;
    if (BF.FLUID[id]) {
      let d = 1, yy = y - 1, b = 0;
      for (; yy >= c.y0; yy--) { b = W.chunkBlock(c, lx, yy, lz); if (!BF.FLUID[b]) break; d++; }
      return { water: true, depth: d, bottom: yy >= c.y0 && b ? b : BF.B.dirt, y };
    }
    if (!BF.SOLID[id] || BF.RENDER[id] === 4) continue;   // plants, torches, air-like blocks
    return { id, y };
  }
  return { id: BF.B.stone, y: c.y0 - 1 };
}
function pack(r, g, b) {
  const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  return v || 1;
}
// Colour of a column as a packed pixel; `north` is the column one pixel further north (relief shading, as in vanilla).
function shade(col, north) {
  let rgb, k;
  if (col.water) {
    const base = rgbOf(col.bottom), t = Math.min(0.94, 0.5 + col.depth * 0.07);
    rgb = [base[0] + (WATER[0] - base[0]) * t, base[1] + (WATER[1] - base[1]) * t, base[2] + (WATER[2] - base[2]) * t];
    k = col.depth < 3 ? 0.98 : col.depth < 6 ? 0.88 : col.depth < 10 ? 0.76 : 0.64;
  } else {
    rgb = rgbOf(col.id);
    const dy = north && !north.water ? col.y - north.y : north ? col.y - north.y : 0;
    k = dy > 0 ? 1.12 : dy < 0 ? 0.72 : 0.88;
  }
  return pack(Math.min(255, rgb[0] * k) | 0, Math.min(255, rgb[1] * k) | 0, Math.min(255, rgb[2] * k) | 0);
}
function sample(wx, wz, s) {
  const col = column(wx, wz);
  if (!col) return 0;
  const north = col.water ? null : column(wx, wz - s);
  return shade(col, north);
}

// Samples the pixels of `d` around the world position (x, z). Returns true when something changed.
function explore(d, x, z, budget) {
  const s = scale(d.size), ox = originX(d.size, d.zx), oz = originX(d.size, d.zz);
  const pi = (x - ox) / s, pj = (z - oz) / s, R = revealPx(d.size), RI = Math.ceil(R);
  if (pi < -R || pj < -R || pi > PX + R || pj > PX + R) return false;
  const n = 2 * RI + 1, i0 = Math.floor(pi) - RI, j0 = Math.floor(pj) - RI;
  let changed = false, done = 0, guard = budget * 4;
  while (done < budget && guard-- > 0) {
    const idx = d.cur++ % (n * n), i = i0 + idx % n, j = j0 + ((idx / n) | 0);
    if (i < 0 || j < 0 || i >= PX || j >= PX) continue;
    const dx = i + 0.5 - pi, dz = j + 0.5 - pj;
    if (dx * dx + dz * dz > R * R) continue;
    done++;
    const v = sample(Math.floor(ox + (i + 0.5) * s), Math.floor(oz + (j + 0.5) * s), s);
    if (v && d.px[j * PX + i] !== v) { d.px[j * PX + i] = v; changed = true; }
  }
  if (changed) d.ver++;
  return changed;
}

// ---------------------------------------------------------------- bigger maps
// Copies what a smaller map has seen into the next size up (same centre), keeping anything the bigger map already knows.
function upgradeData(s, zx, zz) {
  if (s >= MAX_SIZE) return null;
  const from = getData(s, zx, zz, false), to = getData(s + 1, zx, zz);
  if (!from || to.merged[s] === from.ver) return to;   // nothing new on the smaller map since the last merge
  to.merged[s] = from.ver;
  const fs = scale(s), ts = scale(s + 1), fo = originX(s, zx), fz = originX(s, zz), to_x = originX(s + 1, zx), to_z = originX(s + 1, zz);
  let changed = false;
  for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
    if (to.px[j * PX + i]) continue;
    const fi = Math.floor((to_x + (i + 0.5) * ts - fo) / fs), fj = Math.floor((to_z + (j + 0.5) * ts - fz) / fs);
    if (fi < 0 || fj < 0 || fi >= PX || fj >= PX) continue;
    const v = from.px[fj * PX + fi];
    if (v) { to.px[j * PX + i] = v; changed = true; }
  }
  if (changed) to.ver++;
  return to;
}
const isPaper = id => id === BF.I.paper;
// Crafting grid hook (inventory.js): 8 paper around one map of size < 5 gives the next size; a used map stays used and keeps its pixels.
function craftHook(grid, gw) {
  if (gw !== 3 || grid.length !== 9) return null;
  const mid = grid[4];
  if (!mid || mid.count < 1) return null;
  for (let k = 0; k < 9; k++) if (k !== 4 && !(grid[k] && isPaper(grid[k].id))) return null;
  const it = BF.items[mid.id];
  if (!it) return null;
  if (it.mapSize) return it.mapSize < MAX_SIZE ? { id: BF.I["blank_map_" + (it.mapSize + 1)], count: 1 } : null;
  if (it.map && it.map.size < MAX_SIZE) {
    const m = it.map;
    upgradeData(m.size, m.zx, m.zz);
    return { id: BF.resolveItem(nameOf(m.size + 1, m.zx, m.zz)), count: 1 };
  }
  return null;
}
(BF.craftHooks = BF.craftHooks || []).push(craftHook);

// ---------------------------------------------------------------- using a blank map
// Right click with a blank map: it becomes a filled map of the player's zone. Returns an action-bar message or null.
function use(sel, it) {
  if (!it || !it.mapSize) return null;
  const p = BF.player.position, zx = zoneOf(p.x), zz = zoneOf(p.z);
  const id = BF.resolveItem(nameOf(it.mapSize, zx, zz));
  const d = getData(it.mapSize, zx, zz);
  const inv = BF.inventory, slots = inv.slots;
  const i = slots.indexOf(sel);
  explore(d, p.x, p.z, BUDGET);
  if (sel.count === 1 && i >= 0) inv.setSlot(i, { id, count: 1 });
  else { inv.consumeSelected(1); const left = inv.add(id, 1); if (left > 0 && BF.emit) BF.emit("itemDropped", id, left); }
  return "Map created";
}

// ---------------------------------------------------------------- held view (canvas textures for the first-person model)
const T = 152, M0 = 12;      // held map texture: backing + frame, map pixels at (M0, M0)
let viewTex = null, view = null, vg = null, mapC = null, mapG = null, mapImg = null, last = { ver: -1 };
function ensureView() {
  if (viewTex) return;
  view = document.createElement("canvas"); view.width = view.height = T; vg = view.getContext("2d");
  mapC = document.createElement("canvas"); mapC.width = mapC.height = PX; mapG = mapC.getContext("2d");
  mapImg = mapG.createImageData(PX, PX);
  viewTex = new THREE.CanvasTexture(view);
  viewTex.magFilter = viewTex.minFilter = THREE.NearestFilter; viewTex.generateMipmaps = false;
}
function paintMap(d) {
  const o = mapImg.data, px = d.px;
  for (let k = 0; k < px.length; k++) {
    const v = px[k], q = k * 4;
    if (!v) { o[q + 3] = 0; continue; }
    o[q] = ((v >> 11) & 31) * 255 / 31; o[q + 1] = ((v >> 5) & 63) * 255 / 63; o[q + 2] = (v & 31) * 255 / 31; o[q + 3] = 255;
  }
  mapG.putImageData(mapImg, 0, 0);
}
// The player's arrow, pointing the way they face. Off the map it sits on the frame edge (slightly smaller, greyer) and still shows the heading.
function marker(g, x, y, ang, onMap) {
  g.save(); g.translate(x, y); g.rotate(ang);
  if (!onMap) g.scale(0.85, 0.85);
  g.beginPath(); g.moveTo(5, 0); g.lineTo(-3.5, 3.6); g.lineTo(-1.6, 0); g.lineTo(-3.5, -3.6); g.closePath();
  g.fillStyle = onMap ? "#fff" : "#d8d8d8"; g.strokeStyle = "#101010"; g.lineWidth = 1.4; g.stroke(); g.fill();
  g.restore();
}
function drawView(d) {
  const p = BF.player.position, s = scale(d.size);
  if (d.ver !== last.paint || last.key !== d) { paintMap(d); last.paint = d.ver; }
  drawFrame(mapC, (p.x - originX(d.size, d.zx)) / s, (p.z - originX(d.size, d.zz)) / s, false);
}
// Draws the framed held map: `src` (a canvas of any size, shown in the 128 px map area) and the player arrow at (mx, mz) in map pixels.
function drawFrame(src, mx, mz, smooth) {
  const P = BF.player;
  const ang = Math.atan2(-Math.cos(P.yaw), -Math.sin(P.yaw));         // heading on the map: +x right, +z down
  vg.imageSmoothingEnabled = !!smooth; if (smooth) vg.imageSmoothingQuality = "high";
  vg.fillStyle = "#3f2f18"; vg.fillRect(0, 0, T, T);
  vg.fillStyle = "#a88f58"; vg.fillRect(2, 2, T - 4, T - 4);
  vg.fillStyle = "#c9b27a"; vg.fillRect(4, 4, T - 8, T - 8);
  vg.fillStyle = "#d9c897"; vg.fillRect(M0 - 2, M0 - 2, PX + 4, PX + 4);
  vg.drawImage(src, 0, 0, src.width || 1, src.height || 1, M0, M0, PX, PX);
  vg.strokeStyle = "#6b5430"; vg.lineWidth = 1; vg.strokeRect(M0 - 1.5, M0 - 1.5, PX + 3, PX + 3);
  const inside = mx >= 0 && mz >= 0 && mx < PX && mz < PX;
  const ex = Math.max(7, Math.min(T - 7, M0 + mx)), ez = Math.max(7, Math.min(T - 7, M0 + mz));
  marker(vg, inside ? M0 + mx : ex, inside ? M0 + mz : ez, ang, inside);
  viewTex.needsUpdate = true;
}
// The compass: a small dial whose red needle points at the world spawn, relative to where the player looks.
const CT = 32;
let cView = null, cTex = null, cg = null, cLast = "";
function drawCompass() {
  if (!cView) {
    cView = document.createElement("canvas"); cView.width = cView.height = CT; cg = cView.getContext("2d");
    cTex = new THREE.CanvasTexture(cView); cTex.magFilter = cTex.minFilter = THREE.NearestFilter; cTex.generateMipmaps = false;
  }
  const P = BF.player, p = P.position, sp0 = BF.spawnPoint || { x: 8.5, z: 8.5 }, sp = sp0.bed && sp0.world ? sp0.world : sp0;
  const dx = sp.x - p.x, dz = sp.z - p.z, y = P.yaw;
  const sx = dx * Math.cos(y) + dz * -Math.sin(y), su = dx * -Math.sin(y) + dz * -Math.cos(y);   // right / forward components
  const a = Math.round((Math.hypot(dx, dz) < 1.5 ? performance.now() / 400 : Math.atan2(sx, su)) * 16 / Math.PI) / 16 * Math.PI;
  const k = a.toFixed(3);
  if (k === cLast) return cTex;
  cLast = k;
  cg.clearRect(0, 0, CT, CT);
  const c = CT / 2;
  cg.beginPath(); cg.arc(c, c, 15, 0, Math.PI * 2); cg.fillStyle = "#8e8e98"; cg.fill();
  cg.beginPath(); cg.arc(c, c, 13, 0, Math.PI * 2); cg.fillStyle = "#c8c8d2"; cg.fill();
  cg.beginPath(); cg.arc(c, c, 11, 0, Math.PI * 2); cg.fillStyle = "#262b36"; cg.fill();
  cg.fillStyle = "#6a7080"; for (let i = 0; i < 4; i++) { const t = i * Math.PI / 2; cg.fillRect(c + Math.sin(t) * 9 - 0.5, c - Math.cos(t) * 9 - 0.5, 1.5, 1.5); }
  cg.save(); cg.translate(c, c); cg.rotate(a);
  cg.beginPath(); cg.moveTo(0, -10); cg.lineTo(3, 0); cg.lineTo(-3, 0); cg.closePath(); cg.fillStyle = "#e0372c"; cg.fill();
  cg.beginPath(); cg.moveTo(0, 8); cg.lineTo(3, 0); cg.lineTo(-3, 0); cg.closePath(); cg.fillStyle = "#e8e8ec"; cg.fill();
  cg.restore();
  cg.fillStyle = "#f0d870"; cg.fillRect(c - 1, c - 1, 2, 2);
  cTex.needsUpdate = true;
  return cTex;
}

const api = {
  // Non-player use (e.g. explorer villagers): item id of the filled map a blank map of `size` becomes at world position (x, z).
  filledIdAt(size, x, z) { return BF.resolveItem(nameOf(size, zoneOf(x), zoneOf(z))); },
  // Fraction of a map's pixels that are explored (0..1); `filled(it)` is true once all of them are.
  progress(it) { const d = dataOfItem(it); if (!d) return 0; let n = 0; for (let k = 0; k < d.px.length; k++) if (d.px[k]) n++; return n / d.px.length; },
  filled(it) { return api.progress(it) >= 1; },
  PX, ZONE, MAX_SIZE, side, scale, zoneOf, nameOf, centre, originX, getData, dataOfItem, explore, revealBlocks, revealPx, upgradeData, use, craftHook, sample, column,
  // bounds of a map in world blocks: {x0, z0, x1, z1}
  bounds(s, zx, zz) { const o = originX(s, zx), p = originX(s, zz); return { x0: o, z0: p, x1: o + side(s), z1: p + side(s) }; },
  // Per-frame work for the held item (called by player.js). Returns the texture to show, or null when the item has no dynamic view.
  heldTexture(it) {
    if (!it) return null;
    if (it.name === "compass") { try { return drawCompass(); } catch (e) { console.error(e); return cTex; } }
    if (it.auto) return BF.mapview ? BF.mapview.held(it) : null;   // auto-filling maps (js/mapview.js)
    if (!it.map) return null;
    ensureView();
    const d = dataOfItem(it), p = BF.player.position;
    if (BF.world) explore(d, p.x, p.z, BUDGET);
    const sig = d.ver + "|" + p.x.toFixed(1) + "|" + p.z.toFixed(1) + "|" + BF.player.yaw.toFixed(2);
    if (sig !== last.sig || last.key !== d) { drawView(d); last.sig = sig; last.key = d; }
    return viewTex;
  },
  // Held view of a map whose pixels live elsewhere (js/mapview.js): `key` identifies the map, `ver` its content version, `src` the canvas.
  heldCanvas(key, ver, src, mx, mz) {
    ensureView();
    const p = BF.player.position;
    const sig = ver + "|" + p.x.toFixed(1) + "|" + p.z.toFixed(1) + "|" + BF.player.yaw.toFixed(2);
    if (sig !== last.sig || last.key !== key) { drawFrame(src, mx, mz, true); last.sig = sig; last.key = key; }
    return viewTex;
  },
  // Pixels of a normal map for the full-screen view: {src (128x128 canvas), side, x0, z0, N, scale, ver}.
  snapshot(it) {
    const d = dataOfItem(it);
    if (!d.cv) { d.cv = document.createElement("canvas"); d.cv.width = d.cv.height = PX; d.cvG = d.cv.getContext("2d"); d.cvImg = d.cvG.createImageData(PX, PX); d.cvVer = -1; }
    if (d.cvVer !== d.ver) {
      const o = d.cvImg.data, px = d.px;
      for (let k = 0; k < px.length; k++) {
        const v = px[k], q = k * 4;
        if (!v) { o[q + 3] = 0; continue; }
        o[q] = ((v >> 11) & 31) * 255 / 31; o[q + 1] = ((v >> 5) & 63) * 255 / 63; o[q + 2] = (v & 31) * 255 / 31; o[q + 3] = 255;
      }
      d.cvG.putImageData(d.cvImg, 0, 0); d.cvVer = d.ver;
    }
    const b = api.bounds(d.size, d.zx, d.zz);
    return { d, src: d.cv, side: side(d.size), x0: b.x0, z0: b.z0, N: PX, scale: scale(d.size), ver: d.ver };
  },
  textureFor(it) { return it && (it.map || it.auto || it.name === "compass") ? (it.map || it.auto ? (ensureView(), viewTex) : drawCompass()) : null; },
  serialize() {
    const out = {};
    for (const [k, d] of data) {
      if (!d.ver) continue;
      let bin = "";
      const u8 = new Uint8Array(d.px.buffer, d.px.byteOffset, d.px.byteLength);
      for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      out[k] = btoa(bin);
    }
    return out;
  },
  deserialize(o) {
    data.clear(); last = { ver: -1 };
    for (const k in o || {}) {
      const m = /^([1-5])_(-?\d+)_(-?\d+)$/.exec(k);
      if (!m || typeof o[k] !== "string") continue;
      try {
        const bin = atob(o[k]), u8 = new Uint8Array(PX * PX * 2);
        for (let i = 0; i < u8.length && i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const d = getData(+m[1], +m[2], +m[3]);
        d.px = new Uint16Array(u8.buffer); d.ver = 1;
      } catch (e) { console.error(e); }
    }
  },
  reset() { data.clear(); last = { ver: -1 }; },
  _data: data,
};
addEventListener("load", () => { if (BF.on) BF.on("newWorld", () => api.reset()); }); // main.js (the bus) loads after this file
BF.maps = api;
})();
