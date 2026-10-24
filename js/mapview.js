// Auto-filling maps (creative only) and the full-screen map view.
//  * "Auto Map" (item auto_map, creative menu): right click asks for a width in blocks, rounds it to whole 8x8-chunk zones (128 blocks) and turns the
//    item into a filled "auto_map_<zones>_<zoneX>_<zoneZ>" map centred on the zone the player stands in. Its pixels come straight from the world
//    generator (BF.worldgen, whichever version the world was made with), not from loaded chunks, so the whole area fills in by itself, coarse to fine,
//    a few milliseconds per frame (tick() is called from the main loop). Nothing is saved: the pixels regenerate from the seed when the map is next
//    held or viewed. Always 1024x1024 pixels at most (256 blocks wide and under: one block per pixel), so a 2048-block map is 2 blocks per pixel.
//  * Right click with any filled map (normal or auto) opens it full screen: zone grid, player arrow, block under the mouse (and biome / height on auto maps).
//    Click a point to select it; in creative mode a Teleport button takes you there, onto the surface (or the water surface).
//  * On the planet (generator 4, spec r14-18): M, or the Planet button in a map's view, opens the planet view: the whole globe, drag to turn it, scroll
//    to zoom, hover for latitude / longitude, face and grid position and biome, and (creative) click to travel there. Scrolling in past the closest
//    zoom switches to a local auto map of the spot in the middle (8,192 blocks wide); scrolling out of that map comes back to the globe. Auto maps are
//    drawn in the face frame of their centre with the neighbouring faces unfolded around it, are at most one face wide (1,280 zones), and leave the
//    corner wedges (past two face edges, where nothing lies flat) empty. Readouts show face / u / v, never atlas x / z.
// API: BF.mapview = { use(sel, it), held(it), tick(), open(it), close(), isOpen(), getAuto, nameOf, geometry, finish(d), paint(d), stats,
//                     planet: { open(), close(), isOpen(), state, zoomBy(f), turn(dx, dy), pick(px, py), clickAt(px, py), toLocal() } }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const ZONE = 128, MAX_PX = 1024, MAX_K = BF.AUTO_MAP_MAX_K || 4096, DEFAULT_W = 2048;   // 4096 zones = 524288 blocks, see js/blocks.js
const COARSE_SCALE = 64;      // above this many blocks per pixel, mile-high plateau weights are approximated (worldgen.setCoarse)
const RIVER_MAX_SCALE = 16;    // rivers (about 20 blocks wide) only on maps with at most 16 blocks per pixel; see step()
const STEPS = [16, 8, 4, 2, 1];
const keyOf = (k, zx, zz) => k + "_" + zx + "_" + zz;
const nameOf = (k, zx, zz) => "auto_map_" + keyOf(k, zx, zz);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const zoneOf = v => Math.floor(v / ZONE);
const maxK = () => Math.min(MAX_K, BF.planet.N / ZONE);   // an auto map is at most one face wide
const fmtN = v => Math.floor(v).toLocaleString("en-US");
// A point as map readouts show it: "face 2  u 81,920  v 81,920" (canonical).
function placeText(x, z) {
  const c = BF.planet.canonCell(x, z, {});
  return c.off || c.wedge ? "past the corner (nothing here)" : "face " + c.f + "  u " + fmtN(c.u) + "  v " + fmtN(c.v);
}
// The player's position and yaw in a map's frame (the map stays in its centre's face frame; the player may be on a neighbour).
const pin = {};
function playerIn(d) {
  const p = BF.player.position, yaw = BF.player.yaw;
  const r = BF.planet.rel({ x: d.x0 + d.side / 2, z: d.z0 + d.side / 2 }, p, {});
  if (r) { pin.x = r.x; pin.z = r.z; pin.yaw = BF.planet.turnYaw(r.turn, yaw); }
  else { pin.x = pin.z = -1e9; pin.yaw = yaw; }   // the far side of the planet: off the map
  return pin;
}

// ---------------------------------------------------------------- data
const maps = new Map();   // key -> generated map data
function geometry(k, zx, zz) {
  const side = k * ZONE, N = Math.min(MAX_PX, side);
  return { side, N, scale: side / N, x0: zx * ZONE + ZONE / 2 - side / 2, z0: zz * ZONE + ZONE / 2 - side / 2 };
}
function getAuto(k, zx, zz) {
  k = clamp(k, 1, maxK());
  const key = keyOf(k, zx, zz);
  let d = maps.get(key);
  if (!d) {
    const g = geometry(k, zx, zz), n = g.N * g.N;
    d = Object.assign({ key, k, zx, zz, hgt: new Int16Array(n), bio: new Uint8Array(n).fill(255), wl: new Int16Array(n), tn: new Uint8Array(n * 3), pass: 0, idx: 0, cells: 0, done: false, ver: 0, used: 0, cv: null, cvVer: -1, seed: BF.state && BF.state.seed }, g);
    maps.set(key, d);
  }
  d.used = performance.now();
  return d;
}
const dataOfItem = it => (it && it.auto ? getAuto(it.auto.k, it.auto.zx, it.auto.zz) : null);

// Samples the next cells of the progressive fill until `deadline` (performance.now() ms). Returns true when something changed.
function step(d, deadline) {
  const W = BF.worldgen, N = d.N, R = BF.rivers, tintOf = W.tintAt;
  let changed = false, n = 0;
  if (R && R.setEnabled && d.scale > RIVER_MAX_SCALE) R.setEnabled(false);   // the river network is traced per 768-block cell: far too slow and big for coarse maps
  if (W.setCoarse && d.scale > COARSE_SCALE) W.setCoarse(true);              // mile-high plateau weights: skip the slope-limit scan
  try {
  while (!d.done) {
    const s = STEPS[d.pass], per = Math.ceil(N / s);
    if (d.idx >= per * per) {
      if (++d.pass >= STEPS.length) { d.done = true; break; }
      d.idx = 0; continue;
    }
    const ci = d.idx % per, cj = (d.idx / per) | 0;
    d.idx++;
    if (d.pass > 0 && !(ci & 1) && !(cj & 1)) continue;          // already sampled by the coarser pass
    const i = ci * s, j = cj * s;
    const x = Math.floor(d.x0 + (i + 0.5) * d.scale), z = Math.floor(d.z0 + (j + 0.5) * d.scale);
    if (!BF.world.canonXZ(x, z)) {   // a corner wedge or off the atlas: left empty (transparent)
      for (let y = j; y < Math.min(N, j + s); y++) for (let xx = i; xx < Math.min(N, i + s); xx++) d.bio[y * N + xx] = 255;
      changed = true; d.cells++;
      continue;
    }
    const b = W.biomeAt(x, z), wl = W.waterLevelAt(x, z);
    const h = Math.round(b.height), id = b.id, w = Math.round(wl);
    let tr = 100, tg = 100, tb = 100;                              // grass tint x100 (only grass-topped biomes need it)
    if (TINTED[id] && tintOf) { const t = tintOf(x, z).grass; tr = Math.min(255, Math.round(t[0] * 100)); tg = Math.min(255, Math.round(t[1] * 100)); tb = Math.min(255, Math.round(t[2] * 100)); }
    for (let y = j; y < Math.min(N, j + s); y++) for (let xx = i; xx < Math.min(N, i + s); xx++) {
      const o = y * N + xx; d.hgt[o] = h; d.bio[o] = id; d.wl[o] = w; d.tn[o * 3] = tr; d.tn[o * 3 + 1] = tg; d.tn[o * 3 + 2] = tb;
    }
    changed = true; d.cells++;
    if ((++n & 15) === 0 && performance.now() > deadline) break;
  }
  } finally { if (R && R.setEnabled) R.setEnabled(true); if (W.setCoarse) W.setCoarse(false); }
  if (changed) d.ver++;
  return changed;
}
// Runs the whole fill at once (tests, tools).
function finish(d) { while (!d.done) step(d, Infinity); return d; }

// ---------------------------------------------------------------- colours
const COL = { 0: [40, 70, 160], 1: [230, 215, 150], 2: [235, 235, 220], 3: [130, 130, 130], 4: [60, 120, 220], 5: [130, 190, 80], 6: [50, 130, 40], 7: [200, 120, 200], 8: [110, 170, 70], 9: [30, 80, 30], 10: [80, 110, 60], 11: [90, 90, 50], 12: [235, 210, 130], 13: [200, 110, 60], 14: [180, 170, 70], 15: [100, 170, 50], 16: [20, 150, 40], 17: [40, 110, 80], 18: [30, 90, 70], 19: [235, 240, 250], 20: [170, 220, 255], 21: [160, 200, 200], 22: [150, 210, 120], 23: [250, 170, 200], 24: [150, 150, 150], 25: [220, 230, 240], 26: [255, 255, 255], 27: [170, 170, 170], 28: [170, 100, 170], 29: [200, 220, 235] };
// Ground colours: the colour of the block you would actually see from above, from the block colours in blocks.js (grass is multiplied by the
// world's grass tint, so it matches the green you see in game). The biome table above is the alternative, switched with the Colours button.
const GRASS = [106, 168, 79], SAND = [219, 211, 160], SNOW = [244, 248, 251], SNOWG = [240, 244, 248], STONE = [127, 127, 127], GRAVEL = [131, 126, 124],
  RSAND = [184, 98, 42], MYC = [111, 98, 101], MUD = [60, 54, 50], PODZOL = [90, 63, 28];
const TINTED = new Uint8Array(29);
for (const id of [5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 22, 23, 24]) TINTED[id] = 1;
const GROUND = { 1: SAND, 2: SAND, 3: GRAVEL, 11: MUD, 12: SAND, 13: RSAND, 19: SNOWG, 20: SNOW, 21: SNOWG, 25: SNOWG, 26: STONE, 27: STONE, 28: MYC };
// Colour of the surface for a biome id at height h, written to `out` (before the tint).
function groundOf(id, h, out) {
  let c = GROUND[id] || GRASS;
  // the mile-high snow lines (worldgen.js surface rules)
  if (id === 24) c = h > 1950 ? SNOW : h > 1850 ? STONE : GRASS;
  else if (id === 25 && h > 1450) c = SNOW;
  else if (id === 26 && h > 1800) c = SNOW;
  out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  if (id === 18) { out[0] = out[0] * 0.6 + PODZOL[0] * 0.4; out[1] = out[1] * 0.6 + PODZOL[1] * 0.4; out[2] = out[2] * 0.6 + PODZOL[2] * 0.4; }   // coarse dirt and podzol patches
  return TINTED[id] && c === GRASS;
}
let mode = 0;             // 0 = ground colours, 1 = biome colours
try { if (typeof localStorage !== "undefined" && localStorage.getItem("bf_mapcolours") === "biome") mode = 1; } catch (e) {}
function setMode(m) {
  mode = m ? 1 : 0;
  try { localStorage.setItem("bf_mapcolours", mode ? "biome" : "ground"); } catch (e) {}
}
const gtmp = [0, 0, 0];
let scratch = null;       // one shared ImageData (4 MB at 1024 px) for all maps
function paint(d) {
  const N = d.N;
  if (!d.cv) { d.cv = document.createElement("canvas"); d.cv.width = d.cv.height = N; }
  if (!scratch || scratch.width !== N) scratch = d.cv.getContext("2d").createImageData(N, N);
  const o = scratch.data, sea = BF.SEA, rel = d.scale * 0.9 + 6;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = j * N + i, q = p * 4, id = d.bio[p];
    if (id === 255) { o[q + 3] = 0; continue; }
    const h = d.hgt[p], wl = d.wl[p];
    let r, g, b;
    if (id === 0 || id === 4 || h < wl) {                       // ocean, river, or any column under water
      const dep = id === 4 ? 0 : clamp(((id === 0 ? sea : wl) - h) / (id === 0 ? 30 : 12), 0, 1);
      r = 70 - dep * 48; g = 130 - dep * 70; b = 230 - dep * 90;
      if (id === 0) { r = 40 - dep * 25 + 10; g = 80 - dep * 40 + 10; b = 170 - dep * 70 + 20; }
      else if (id === 29) { r = 205; g = 222; b = 238; }                // frozen ocean (the planet): sea ice
    } else {
      let c, tinted = false;
      if (mode) c = COL[id] || [255, 0, 255];
      else { tinted = groundOf(id, h, gtmp); c = gtmp; }
      const hn = i + 1 < N && j + 1 < N && d.bio[p + N + 1] !== 255 ? d.hgt[p + N + 1] : h;
      const sh = clamp((h - hn) / rel * 0.5, -0.35, 0.35), k = 0.7 + 0.45 * clamp((h - sea + 8) / 1350, 0, 1) + sh;
      r = c[0] * k; g = c[1] * k; b = c[2] * k;
      if (tinted) { const t = p * 3; r *= d.tn[t] / 100; g *= d.tn[t + 1] / 100; b *= d.tn[t + 2] / 100; }
    }
    o[q] = clamp(r, 0, 255); o[q + 1] = clamp(g, 0, 255); o[q + 2] = clamp(b, 0, 255); o[q + 3] = 255;
  }
  d.cv.getContext("2d").putImageData(scratch, 0, 0);
  d.cvVer = d.ver; d.cvMode = mode;
  return d.cv;
}
function canvasOf(d) {
  const now = performance.now();
  if ((d.cvVer !== d.ver || d.cvMode !== mode) && (!d.cv || d.done || now - d.paintAt > 400)) { paint(d); d.paintAt = now; }
  return d.cv;
}

// ---------------------------------------------------------------- scheduler
let budget = 10;
function tick() {
  if (!maps.size || !BF.worldgen || (BF.state && BF.state.paused && !view.open)) return;
  const list = [...maps.values()].filter(d => !d.done).sort((a, b) => b.used - a.used);
  if (!list.length) return;
  const t0 = performance.now(), deadline = t0 + (view.open || prompt.open ? 20 : budget);
  for (const d of list) { if (performance.now() >= deadline) break; step(d, deadline); }
}

// ---------------------------------------------------------------- held view (maps.js owns the framed texture)
const heldDraw = {};
function held(it) {
  const d = dataOfItem(it);
  if (!d || !BF.maps) return null;
  const src = canvasOf(d) || (heldDraw.blank || (heldDraw.blank = document.createElement("canvas")));
  const q = playerIn(d);
  return BF.maps.heldCanvas(d, d.ver + "|" + (d.cvVer) + "|" + mode, src, (q.x - d.x0) / d.scale * 128 / d.N, (q.z - d.z0) / d.scale * 128 / d.N);
}

// ---------------------------------------------------------------- normal maps' pixels (spec r15-37)
// A normal map's pixels are simulation state (js/maps.js fills them in as the player explores), so the page asks for them with the
// protocol's "map" query: {item, ver} answers the map's bounds, and its pixels (RGB565, base64) only when they changed since the version
// the page has. Kept here per item as a 128x128 canvas; asked again at most four times a second.
const snaps = new Map();   // item id -> {ver, cv, g, img, side, x0, z0, N, scale, at, asking}
function mapSnap(it) {
  let c = snaps.get(it.id);
  if (!c) {
    c = { ver: null, cv: document.createElement("canvas"), side: 0, x0: 0, z0: 0, N: 128, scale: 1, at: -1e9, asking: false };
    c.cv.width = c.cv.height = 128; c.g = c.cv.getContext("2d"); c.img = c.g.createImageData(128, 128);
    snaps.set(it.id, c);
  }
  const now = performance.now();
  if (!c.asking && now - c.at > 250 && BF.client) {
    c.at = now; c.asking = true;
    BF.client.query("map", { item: it.id, ver: c.ver }, r => {
      c.asking = false;
      if (!r || !r.ok) return;
      Object.assign(c, { side: r.side, x0: r.x0, z0: r.z0, N: r.N, scale: r.scale });
      if (r.px == null) return;
      const bin = atob(r.px), px = new Uint16Array(bin.length >> 1), o = c.img.data;
      for (let k = 0; k < px.length; k++) px[k] = bin.charCodeAt(2 * k) | (bin.charCodeAt(2 * k + 1) << 8);
      for (let k = 0; k < px.length; k++) {
        const v = px[k], q = k * 4;
        if (!v) { o[q + 3] = 0; continue; }
        o[q] = ((v >> 11) & 31) * 255 / 31; o[q + 1] = ((v >> 5) & 63) * 255 / 63; o[q + 2] = (v & 31) * 255 / 31; o[q + 3] = 255;
      }
      c.g.putImageData(c.img, 0, 0); c.ver = r.ver;
    });
  }
  return { src: c.cv, side: c.side, x0: c.x0, z0: c.z0, N: c.N, scale: c.scale, ver: c.ver };
}

// ---------------------------------------------------------------- item icons
// Inventory / hotbar / drop icon of a filled map (normal or auto): the map itself, shrunk into a framed sheet (brown frame for normal maps, teal for auto
// maps). textures.js icon() and inventory.js ask BF.mapIcon(item) -> {ver, url}; ver changes when the thumbnail does, and tick() refreshes the inventory
// icons about once a second while a map in the inventory is changing (generating, or being explored).
const thumbs = new Map();   // item id -> {ver, t, url}
function composeIcon(src, auto) {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#1c160d"; g.fillRect(4, 2, 56, 60);                       // outline, as the flat item sprites have
  g.fillStyle = auto ? "#1f5a5a" : "#7a5a30"; g.fillRect(8, 6, 48, 52);
  g.fillStyle = auto ? "#123c3c" : "#5a4020"; g.fillRect(52, 6, 4, 52); g.fillRect(8, 54, 48, 4);
  g.fillStyle = "#d8c890"; g.fillRect(12, 10, 40, 44);
  if (src && src.width) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, src.width, src.height, 14, 14, 36, 36); }
  g.strokeStyle = "rgba(60,40,10,0.55)"; g.lineWidth = 1; g.strokeRect(13.5, 13.5, 37, 37);
  return c.toDataURL();
}
function mapIcon(it) {
  if (!it || typeof document === "undefined") return null;
  let src, ver;
  try {
    if (it.auto) { const d = dataOfItem(it); src = canvasOf(d); ver = "a" + d.cvVer + "m" + mode; }
    else if (it.map) { const m = mapSnap(it); src = m.src; ver = "n" + m.ver; }
    else return null;
  } catch (e) { console.error(e); return null; }
  const now = performance.now();
  let t = thumbs.get(it.id);
  if (!t) thumbs.set(it.id, t = { ver: null, t: 0, url: null });
  if (t.ver !== ver && (!t.url || now - t.t > 700)) { t.url = composeIcon(src, !!it.auto); t.ver = ver; t.t = now; }
  return { ver: t.ver, url: t.url };
}
BF.mapIcon = mapIcon;
let iconT = 0, iconSeen = "";
function refreshIcons(now) {
  if (now - iconT < 1000 || !BF.inventory || !BF.inventory.slots) return;
  iconT = now;
  let sig = "";
  for (const s of BF.inventory.slots) { const it = s && BF.items[s.id]; if (it && (it.map || it.auto)) { const r = mapIcon(it); sig += s.id + ":" + (r ? r.ver : "") + ","; } }
  if (sig !== iconSeen) { iconSeen = sig; if (BF.inventory.refreshIcons) BF.inventory.refreshIcons(); }
}

// ---------------------------------------------------------------- UI
const view = { open: false, root: null, cv: null, g: null, title: null, info: null, it: null, d: null, S: 0, mouse: null, sig: "", sel: null, tp: null, pending: null };
const prompt = { open: false, root: null, input: null, hint: null, slot: -1 };
function css() {
  const st = document.createElement("style");
  st.textContent = `
.bfm-wrap{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,10,9,.7);z-index:40}
.bfm-wrap.open{display:flex}
.bfm-panel{background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:12px 14px 10px;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:calc(100vw - 16px)}
.bfm-title{font:13px var(--display);color:var(--ink);letter-spacing:.04em;text-align:center}
.bfm-board{line-height:0;box-shadow:0 6px 18px rgba(0,0,0,.5);cursor:crosshair}
.bfm-board canvas{display:block}
.bfm-info{font:12px var(--mono);color:var(--muted);min-height:16px;text-align:center;white-space:pre-wrap}
.bfm-info.bad{color:var(--danger)}
.bfm-row{display:flex;gap:8px}
.bfm-row button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:6px 18px;cursor:pointer}
.bfm-row button:hover{background:rgba(127,191,77,.38)}
.bfm-row button:disabled{opacity:.4;cursor:default;background:rgba(127,191,77,.12)}
.bfm-in{font:15px var(--mono);width:9em;padding:6px 8px;text-align:center;color:var(--ink);background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px}`;
  document.head.appendChild(st);
}
function mount(inner) {
  const r = document.createElement("div");
  r.className = "bfm-wrap";
  r.innerHTML = `<div class="bfm-panel">${inner}</div>`;
  (document.getElementById("ui") || document.body).appendChild(r);
  return r;
}
function buildView() {
  if (view.root) return;
  css();
  const r = view.root = mount(`<div class="bfm-title"></div><div class="bfm-board"><canvas></canvas></div><div class="bfm-info"></div><div class="bfm-row"><button type="button" data-a="col" hidden>Colours: ground</button><button type="button" data-a="tp" hidden disabled>Teleport</button><button type="button" data-a="planet">Planet</button><button type="button" data-a="close">Close</button></div>`);
  view.cv = r.querySelector("canvas"); view.g = view.cv.getContext("2d"); view.title = r.querySelector(".bfm-title"); view.info = r.querySelector(".bfm-info");
  r.querySelector('[data-a="close"]').addEventListener("click", closeView);
  view.col = r.querySelector('[data-a="col"]');
  view.col.addEventListener("click", () => { setMode(mode ? 0 : 1); view.sig = ""; drawView(); });
  view.tp = r.querySelector('[data-a="tp"]');
  view.tp.addEventListener("click", teleportToSelection);
  view.planet = r.querySelector('[data-a="planet"]');
  view.planet.addEventListener("click", () => openGlobe(!!(view.it && view.it.fromGlobe)));
  view.cv.addEventListener("wheel", e => {   // the local map opened from the planet view: scrolling out goes back to the globe
    if (!view.it || !view.it.fromGlobe) return;
    e.preventDefault();
    if (e.deltaY > 0) openGlobe(true);
  }, { passive: false });
  view.cv.addEventListener("click", e => {          // select a point (any map; the Teleport button only exists in creative mode)
    const m = view.d, b = view.cv.getBoundingClientRect();
    if (!m) return;
    const fx = (e.clientX - b.left) / b.width, fz = (e.clientY - b.top) / b.height;
    if (fx < 0 || fx >= 1 || fz < 0 || fz >= 1) return;
    view.sel = { x: Math.floor(m.x0 + fx * m.side), z: Math.floor(m.z0 + fz * m.side) };
    view.sig = ""; drawView();
  });
  r.addEventListener("mousedown", e => { if (e.target === r) closeView(); });
  r.addEventListener("contextmenu", e => e.preventDefault());
  view.cv.addEventListener("mousemove", e => { const b = view.cv.getBoundingClientRect(); view.mouse = { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height }; view.sig = ""; });
  view.cv.addEventListener("mouseleave", () => { view.mouse = null; view.sig = ""; });
}
// Source canvas and geometry of whatever map is being viewed.
function describe(it) {
  if (it.auto) {
    const d = dataOfItem(it);
    return { d, auto: true, src: canvasOf(d), side: d.side, x0: d.x0, z0: d.z0, N: d.N, scale: d.scale, ver: d.ver + "m" + mode, label: d.side + " x " + d.side + " blocks" };
  }
  const m = mapSnap(it);
  return Object.assign({ auto: false, label: m.side + " x " + m.side + " blocks" }, m);
}
function openView(it, swap) {   // swap: from the planet view, which already holds the screen (no pointer-lock change)
  if (typeof document === "undefined" || !it || !(it.map || it.auto)) return false;
  const P = BF.player;
  if (!swap && P && P.canOpenUI && !P.canOpenUI()) return false;
  buildView();
  view.it = it; view.d = describe(it);
  const avail = Math.max(160, Math.min(innerWidth - 48, innerHeight - 150));
  // normal maps are 128 px of chunky pixels: whole multiples keep them crisp; auto maps are smoothed to fit
  view.S = view.d.auto ? Math.floor(avail) : Math.max(128, Math.floor(avail / 128) * 128);
  view.cv.width = view.cv.height = view.S;
  view.cv.style.width = view.cv.style.height = view.S + "px";
  view.title.textContent = (it.title ? it.title + " - " : it.auto ? "Auto map - " : "Map - ") + view.d.label;
  view.open = true;                       // before releasing the lock: player.js must not pause or re-lock
  view.sig = ""; view.sel = null;
  view.col.hidden = !view.d.auto;
  view.tp.hidden = !(P && P.gameMode === "creative");   // like the creative-only auto map itself; /tp stays the survival route
  view.tp.disabled = true;
  if (!swap) { try { if (P && P.uiOpen) P.uiOpen(); } catch (e) { console.error(e); } }
  view.root.classList.add("open");
  drawView();
  return true;
}
function hideView() { view.open = false; view.it = null; view.d = null; view.root.classList.remove("open"); }
function closeView() {
  if (!view.open) return;
  hideView();
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
function drawView(force) {
  if (!view.open) return;
  let m;
  try { m = describe(view.it); } catch (e) { console.error(e); return; }
  const P = BF.player.position, S = view.S, ppb = S / m.side;
  const sig = m.ver + "|" + (P.x | 0) + "|" + (P.z | 0) + "|" + BF.player.yaw.toFixed(1) + "|" + (view.mouse ? view.mouse.x.toFixed(3) + view.mouse.y.toFixed(3) : "-");
  if (!force && sig === view.sig) return;
  view.sig = sig; view.d = m;
  view.col.textContent = "Colours: " + (mode ? "biome" : "ground");
  const g = view.g;
  g.imageSmoothingEnabled = !!m.auto;
  g.fillStyle = "#d9c897"; g.fillRect(0, 0, S, S);
  if (m.src && m.src.width) g.drawImage(m.src, 0, 0, m.src.width, m.src.height, 0, 0, S, S);
  // world-aligned grid, every 128 * 2^n blocks, at least ~56 px apart
  let gs = ZONE; while (gs * ppb < 56) gs *= 2;
  g.strokeStyle = "rgba(0,0,0,0.22)"; g.lineWidth = 1; g.beginPath();
  for (let x = Math.ceil(m.x0 / gs) * gs; x < m.x0 + m.side; x += gs) { const px = Math.round((x - m.x0) * ppb) + 0.5; g.moveTo(px, 0); g.lineTo(px, S); }
  for (let z = Math.ceil(m.z0 / gs) * gs; z < m.z0 + m.side; z += gs) { const pz = Math.round((z - m.z0) * ppb) + 0.5; g.moveTo(0, pz); g.lineTo(S, pz); }
  g.stroke();
  g.strokeStyle = "#5a4020"; g.lineWidth = 2; g.strokeRect(1, 1, S - 2, S - 2);
  // player arrow (clamped to the edge when off the map)
  const q = playerIn(m);
  const mx = (q.x - m.x0) * ppb, mz = (q.z - m.z0) * ppb, inside = mx >= 0 && mz >= 0 && mx < S && mz < S;
  const ang = Math.atan2(-Math.cos(q.yaw), -Math.sin(q.yaw));
  g.save(); g.translate(clamp(mx, 9, S - 9), clamp(mz, 9, S - 9)); g.rotate(ang); if (!inside) g.scale(0.85, 0.85); g.scale(1.9, 1.9);
  g.beginPath(); g.moveTo(5, 0); g.lineTo(-3.5, 3.6); g.lineTo(-1.6, 0); g.lineTo(-3.5, -3.6); g.closePath();
  g.fillStyle = inside ? "#fff" : "#d8d8d8"; g.strokeStyle = "#101010"; g.lineWidth = 1.2; g.stroke(); g.fill(); g.restore();
  // selected point
  if (view.sel) {
    const sx = (view.sel.x + 0.5 - m.x0) * ppb, sz = (view.sel.z + 0.5 - m.z0) * ppb;
    g.save(); g.translate(sx, sz); g.lineWidth = 2.5; g.strokeStyle = "#101010"; g.beginPath(); g.arc(0, 0, 8, 0, 6.2832); g.moveTo(-14, 0); g.lineTo(-4, 0); g.moveTo(4, 0); g.lineTo(14, 0); g.moveTo(0, -14); g.lineTo(0, -4); g.moveTo(0, 4); g.lineTo(0, 14); g.stroke();
    g.lineWidth = 1.2; g.strokeStyle = "#ff4a3a"; g.stroke(); g.restore();
  }
  view.tp.disabled = !view.sel;
  // readout
  let line = "";
  if (view.mouse && view.mouse.x >= 0 && view.mouse.x < 1 && view.mouse.y >= 0 && view.mouse.y < 1) {
    const x = Math.floor(m.x0 + view.mouse.x * m.side), z = Math.floor(m.z0 + view.mouse.y * m.side);
    line = placeText(x, z);
    if (m.auto && BF.worldgen) { const b = biomeFor(x, z, m.scale); line += "   " + b.name + "   height " + Math.round(b.height); }
  }
  if (view.sel) line += (line ? "\n" : "") + "selected  " + placeText(view.sel.x, view.sel.z) + (view.tp.hidden ? "" : "   (press Teleport)");
  const prog = m.auto && m.d ? (m.d.done ? "" : "   generating " + Math.floor(100 * progressOf(m.d)) + "%") : "";
  view.info.textContent = (line || "Move the mouse over the map for coordinates") + prog + "\ngrid lines every " + gs + " blocks (face grid)  |  " + (view.it && view.it.fromGlobe ? "scroll out for the planet  |  " : "") + "M planet view  |  Esc to close";
}
// biomeAt without the river network on coarse maps: tracing it for every hovered point far from the last would stall the page (see step()).
function biomeFor(x, z, scale) {
  const R = BF.rivers, G = BF.worldgen, off = R && R.setEnabled && scale > RIVER_MAX_SCALE, co = G.setCoarse && scale > COARSE_SCALE;
  if (off) R.setEnabled(false);
  if (co) G.setCoarse(true);
  try { return G.biomeAt(x, z); } finally { if (off) R.setEnabled(true); if (co) G.setCoarse(false); }
}
// Teleport to the selected point, landing on the surface (on the water surface over water). Far destinations are not loaded yet, so the height from
// the generator is used first and corrected by tick() once the chunk exists (trees, buildings).
function surfaceAt(x, z) {
  const W = BF.world, G = BF.worldgen;
  let h = W.isLoaded(x, z) ? W.heightAt(x, z) : BF.MIN_Y - 1, wl = BF.SEA;
  if (G) { if (h < BF.MIN_Y) h = G.heightAt(x, z); if (G.waterLevelAt) wl = Math.max(wl, G.waterLevelAt(x, z)); }
  return Math.max(h, wl) + 1.01;
}
function teleportToSelection() {
  const s = view.sel, P = BF.player;
  if (!s || !P || P.gameMode !== "creative") return;
  let cx = s.x, cz = s.z;
  { const c = BF.planet.canonCell(s.x, s.z, {}); if (c.off || c.wedge) return; cx = c.x; cz = c.z; }   // land at the canonical cell
  closeView();
  travel(cx, cz);
}
// Teleports the player onto the surface of canonical cell (cx, cz) (the water surface over water), keeping their compass facing.
function travel(cx, cz) {
  const P = BF.player, p = P.position, x = cx + 0.5, z = cz + 0.5, y = surfaceAt(cx, cz);
  let yaw = null;
  if (BF.coords) { const b = BF.coords.bearing(-Math.sin(P.yaw), -Math.cos(P.yaw), p.x, p.z); if (b != null) yaw = BF.coords.yawFor(b, x, z, P.yaw); }
  P.teleport(x, y, z);
  if (yaw != null && P.setLook) P.setLook(yaw, P.pitch || 0);
  view.pending = { x: cx, z: cz, t: 0 };
  if (P.actionBar) P.actionBar("Teleported to " + (BF.coords ? BF.coords.describe(x, y, z, { whole: true }) : cx + ", " + Math.floor(y) + ", " + cz));
}
// After a teleport to unloaded ground: once the chunk is there, stand on what is really on top.
function settle() {
  const p = view.pending, W = BF.world;
  if (!p) return;
  if (++p.t > 3600) { view.pending = null; return; }     // give up after about a minute
  if (!W.isLoaded(p.x, p.z)) return;
  view.pending = null;
  const h = W.heightAt(p.x, p.z), pos = BF.player.position;
  if (h >= BF.MIN_Y && Math.abs(pos.x - (p.x + 0.5)) < 2 && Math.abs(pos.z - (p.z + 0.5)) < 2) { const wl = BF.worldgen && BF.worldgen.waterLevelAt ? BF.worldgen.waterLevelAt(p.x, p.z) : BF.SEA; BF.player.teleport(pos.x, Math.max(h, wl, BF.SEA) + 1.01, pos.z); }
}
function progressOf(d) {
  if (d.done) return 1;
  let total = 0;
  for (let p = 0; p < STEPS.length; p++) { const per = Math.ceil(d.N / STEPS[p]); total += p ? per * per - Math.ceil(per / 2) * Math.ceil(per / 2) : per * per; }
  return clamp(d.cells / total, 0, 0.999);
}

// ---- width prompt
function buildPrompt() {
  if (prompt.root) return;
  css();
  const r = prompt.root = mount(`<div class="bfm-title">Auto map: width in blocks</div><input class="bfm-in" type="number" min="128" max="${MAX_K * ZONE}" step="128" autocomplete="off" aria-label="Map width in blocks"><div class="bfm-info"></div><div class="bfm-row"><button type="button" data-a="ok">Create</button><button type="button" data-a="cancel">Cancel</button></div>`);
  prompt.input = r.querySelector("input"); prompt.hint = r.querySelector(".bfm-info");
  r.querySelector('[data-a="ok"]').addEventListener("click", confirmPrompt);
  r.querySelector('[data-a="cancel"]').addEventListener("click", closePrompt);
  prompt.input.addEventListener("input", hint);
  r.addEventListener("mousedown", e => { if (e.target === r) closePrompt(); });
}
// Width in blocks -> number of 128-block zones per side (nearest, at least 1).
const zonesFor = w => clamp(Math.round(w / ZONE), 1, maxK());
function hint() {
  const w = parseFloat(prompt.input.value);
  if (!(w > 0)) { prompt.hint.textContent = "Enter a width, e.g. 2000"; prompt.hint.classList.add("bad"); return false; }
  const k = zonesFor(w), side = k * ZONE, sc = side / Math.min(MAX_PX, side);
  prompt.hint.classList.remove("bad");
  prompt.hint.textContent = "Becomes " + side + " x " + side + " blocks (" + k + " x " + k + " zones of 8x8 chunks), " + (+sc.toFixed(2)) + " block" + (sc === 1 ? "" : "s") + " per pixel" + (sc > RIVER_MAX_SCALE ? ", no rivers at this scale" : "") + (w > maxK() * ZONE ? "\n(largest allowed is " + maxK() * ZONE + ", one face of the planet)" : "");
  return true;
}
function openPrompt(sel) {
  if (typeof document === "undefined") return false;
  const P = BF.player;
  if (P && P.canOpenUI && !P.canOpenUI()) return false;
  buildPrompt();
  prompt.slot = BF.inventory.slots.indexOf(sel);
  prompt.input.value = DEFAULT_W; prompt.input.max = maxK() * ZONE;
  prompt.open = true;
  try { if (P && P.uiOpen) P.uiOpen(); } catch (e) { console.error(e); }
  prompt.root.classList.add("open");
  hint();
  prompt.input.focus(); prompt.input.select();
  return true;
}
function closePrompt() {
  if (!prompt.open) return;
  prompt.open = false;
  prompt.root.classList.remove("open"); prompt.input.blur();
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
// Turns the blank auto map in the chosen slot into a filled map `w` blocks wide, centred on the zone the player stands in.
function create(w, slot) {
  const inv = BF.inventory, sel = inv.slots[slot];
  if (!sel || !BF.items[sel.id] || !BF.items[sel.id].autoBlank) return false;
  const p = BF.player.position, k = zonesFor(w), zx = zoneOf(p.x), zz = zoneOf(p.z);
  const id = BF.resolveItem(nameOf(k, zx, zz));
  getAuto(k, zx, zz);
  if (sel.count === 1) inv.setSlot(slot, { id, count: 1 });
  else { inv.setSlot(slot, { id: sel.id, count: sel.count - 1 }); const left = inv.add(id, 1); if (left > 0) inv.dropOverflow(id, left); }
  return true;
}
function confirmPrompt() {
  if (!hint()) return;
  const w = parseFloat(prompt.input.value), slot = prompt.slot;
  closePrompt();
  if (create(w, slot) && BF.player.actionBar) BF.player.actionBar("Map created (" + zonesFor(w) * ZONE + " blocks wide)");
}

// ---------------------------------------------------------------- planet view (generator 4, spec r14-18)
// The globe is drawn per pixel on a 2D canvas: an orthographic view of the sphere, each pixel turned back into a direction, then a face and grid
// point (BF.planet.fromDir) and a colour. Colours come from a coarse per-face grid (GM x GM samples of the generator, filled once per seed, coarse to
// fine, a few milliseconds a frame) and, zoomed in, from a finer pass over the visible pixels that restarts whenever the view moves.
const GM = 128, GSTEPS = [16, 8, 4, 2, 1], ZMAX = 24, LOCAL_K = 64;   // LOCAL_K: the local map's width in zones (8,192 blocks), about the globe at ZMAX
const globe = { open: false, root: null, cv: null, g: null, info: null, tp: null, S: 0, RS: 0, img: null,
  right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], zoom: 1, drag: null, mouse: null, sel: null, sig: "", base: null, det: null };
// One colour for a generator sample, as paint() colours a map pixel (without the neighbour shading and grass tint, which need neighbours).
function sampleColour(x, z, out) {
  const G = BF.worldgen, b = G.biomeAt(x, z), wl = Math.round(G.waterLevelAt(x, z)), h = Math.round(b.height), id = b.id, sea = BF.SEA;
  if (id === 29) { out[0] = 205; out[1] = 222; out[2] = 238; }
  else if (id === 0 || id === 4 || h < wl) {
    const dep = id === 4 ? 0 : clamp(((id === 0 ? sea : wl) - h) / (id === 0 ? 30 : 12), 0, 1);
    if (id === 0) { out[0] = 50 - dep * 25; out[1] = 90 - dep * 40; out[2] = 190 - dep * 70; }
    else { out[0] = 70 - dep * 48; out[1] = 130 - dep * 70; out[2] = 230 - dep * 90; }
  } else {
    let c;
    if (mode) c = COL[id] || [255, 0, 255];
    else { groundOf(id, h, gtmp); c = gtmp; }
    const k = 0.7 + 0.45 * clamp((h - sea + 8) / 1350, 0, 1);
    out[0] = c[0] * k; out[1] = c[1] * k; out[2] = c[2] * k;
  }
  return out;
}
const scol = [0, 0, 0];
// The coarse per-face grid: colour (RGB) per cell, filled in passes of GSTEPS (a coarse pass paints whole blocks, finer ones refine them).
function baseGrid() {
  const seed = BF.state && BF.state.seed;
  if (!globe.base || globe.base.seed !== seed || globe.base.mode !== mode) {
    const c = new Uint8ClampedArray(6 * GM * GM * 3); c.fill(60);
    globe.base = { seed, mode, c, pass: 0, idx: 0, done: false, ver: 0 };
  }
  return globe.base;
}
function stepBase(deadline) {
  const B = baseGrid(), Pl = BF.planet, G = BF.worldgen, N = Pl.N, a = {};
  if (B.done) return false;
  let n = 0;
  const R = BF.rivers;
  if (R && R.setEnabled) R.setEnabled(false);   // planet scale: far too coarse for rivers (see step())
  if (G.setCoarse) G.setCoarse(true);
  try {
    while (!B.done) {
      const s = GSTEPS[B.pass], per = GM / s;
      if (B.idx >= 6 * per * per) { if (++B.pass >= GSTEPS.length) { B.done = true; break; } B.idx = 0; continue; }
      const f = (B.idx / (per * per)) | 0, r = B.idx % (per * per), ci = r % per, cj = (r / per) | 0;
      B.idx++;
      if (B.pass > 0 && !(ci & 1) && !(cj & 1)) continue;
      const i = ci * s, j = cj * s;
      Pl.atlas(f, (i + s / 2) / GM * N, (j + s / 2) / GM * N, a);
      sampleColour(Math.floor(a.x), Math.floor(a.z), scol);
      for (let y = j; y < j + s; y++) for (let x = i; x < i + s; x++) { const o = ((f * GM + y) * GM + x) * 3; B.c[o] = scol[0]; B.c[o + 1] = scol[1]; B.c[o + 2] = scol[2]; }
      if ((++n & 7) === 0 && performance.now() > deadline) break;
    }
  } finally { if (R && R.setEnabled) R.setEnabled(true); if (G.setCoarse) G.setCoarse(false); }
  B.ver++;
  return true;
}
// The fine pass, zoomed in (zoom >= 1.5): one sample per render pixel of the current view, coarse to fine; restarts when the view changes.
function viewKey() { return globe.fwd.map(v => v.toFixed(5)).join() + "|" + globe.up.map(v => v.toFixed(5)).join() + "|" + globe.zoom.toFixed(4) + "|" + mode + "|" + (BF.state && BF.state.seed); }
function stepDetail(deadline) {
  if (globe.zoom < 1.5) { globe.det = null; return false; }
  const key = viewKey(), RS = globe.RS;
  if (!globe.det || globe.det.key !== key || globe.det.RS !== RS) {
    globe.det = { key, RS, c: new Uint8ClampedArray(RS * RS * 3), have: new Uint8Array(RS * RS), pass: 0, idx: 0, done: false, ver: 0, idle: 0 };
  }
  const D = globe.det, Pl = BF.planet, G = BF.worldgen, a = {}, g = {}, d = [0, 0, 0];
  if (D.done) return false;
  if (++D.idle < 6) return false;   // wait until the view has held still for a few frames (dragging redraws from the coarse grid)
  let n = 0;
  const R = BF.rivers;
  if (R && R.setEnabled) R.setEnabled(false);
  if (G.setCoarse) G.setCoarse(true);
  try {
    while (!D.done) {
      const s = GSTEPS[D.pass], per = Math.ceil(RS / s);
      if (D.idx >= per * per) { if (++D.pass >= GSTEPS.length) { D.done = true; break; } D.idx = 0; continue; }
      const ci = D.idx % per, cj = (D.idx / per) | 0;
      D.idx++;
      if (D.pass > 0 && !(ci & 1) && !(cj & 1)) continue;
      const i = ci * s, j = cj * s;
      if (!dirAt(i + s / 2, j + s / 2, RS, d)) continue;
      Pl.fromDir(d[0], d[1], d[2], g); Pl.atlas(g.f, g.u, g.v, a);
      sampleColour(Math.floor(a.x), Math.floor(a.z), scol);
      for (let y = j; y < Math.min(RS, j + s); y++) for (let x = i; x < Math.min(RS, i + s); x++) { const o = y * RS + x; D.c[o * 3] = scol[0]; D.c[o * 3 + 1] = scol[1]; D.c[o * 3 + 2] = scol[2]; D.have[o] = 1; }
      if ((++n & 7) === 0 && performance.now() > deadline) break;
    }
  } finally { if (R && R.setEnabled) R.setEnabled(true); if (G.setCoarse) G.setCoarse(false); }
  D.ver++;
  return true;
}
// The direction under render pixel (px, py) of an RS-pixel render (false off the disc). The disc's radius is 0.46 of the view times the zoom.
function dirAt(px, py, RS, out) {
  const r = 0.46 * RS * globe.zoom, sx = (px - RS / 2) / r, sy = (RS / 2 - py) / r, q = sx * sx + sy * sy;
  if (q >= 1) return false;
  const sz = Math.sqrt(1 - q), R = globe.right, U = globe.up, F = globe.fwd;
  out[0] = sx * R[0] + sy * U[0] + sz * F[0]; out[1] = sx * R[1] + sy * U[1] + sz * F[1]; out[2] = sx * R[2] + sy * U[2] + sz * F[2];
  out.sz = sz;
  return true;
}
// The screen position (render pixels) of direction d, or null on the far side.
function screenOf(d, RS) {
  const F = globe.fwd, z = d[0] * F[0] + d[1] * F[1] + d[2] * F[2];
  if (z <= 0) return null;
  const r = 0.46 * RS * globe.zoom, R = globe.right, U = globe.up;
  return [RS / 2 + (d[0] * R[0] + d[1] * R[1] + d[2] * R[2]) * r, RS / 2 - (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) * r];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// Rotate v about unit axis k by angle t (Rodrigues).
function rot(v, k, t) {
  const c = Math.cos(t), s = Math.sin(t), d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c), x = cross(k, v);
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d];
}
// Looks straight down at direction d with north up (east right); at a pole, keeps the current up as near as it can.
function lookAt(d) {
  const F = unit(d);
  let U = [-F[0] * F[1], 1 - F[1] * F[1], -F[2] * F[1]];             // north: the pole axis less its part along F
  if (Math.hypot(U[0], U[1], U[2]) < 1e-3) U = globe.up;
  const Fd = F[0] * U[0] + F[1] * U[1] + F[2] * U[2];
  U = unit([U[0] - F[0] * Fd, U[1] - F[1] * Fd, U[2] - F[2] * Fd]);
  globe.fwd = F; globe.up = U; globe.right = cross(U, F);
}
// Turns the globe by a drag of (dx, dy) screen pixels: the surface follows the pointer.
function turn(dx, dy) {
  const k = 1 / (0.46 * globe.S * globe.zoom);
  if (dx) { const t = -dx * k; globe.fwd = rot(globe.fwd, globe.up, t); globe.right = rot(globe.right, globe.up, t); }
  if (dy) { const t = -dy * k; globe.fwd = rot(globe.fwd, globe.right, t); globe.up = rot(globe.up, globe.right, t); }
  globe.fwd = unit(globe.fwd); globe.up = unit(globe.up); globe.right = cross(globe.up, globe.fwd);
  globe.sig = "";
}
function zoomBy(f) {
  if (f > 1 && globe.zoom >= ZMAX - 1e-6) { toLocal(); return; }     // past the closest zoom: the local map of the middle
  globe.zoom = clamp(globe.zoom * f, 1, ZMAX); globe.sig = "";
}
// What lies under view pixel (px, py) (CSS pixels on the canvas): {f, u, v, x, z (canonical atlas), lat, lon} or null off the globe.
function pick(px, py) {
  const d = [0, 0, 0], k = globe.RS / globe.S;
  if (!dirAt(px * k, py * k, globe.RS, d)) return null;
  const Pl = BF.planet, g = Pl.fromDir(d[0], d[1], d[2], {}), a = Pl.atlas(g.f, g.u, g.v, {});
  const ll = Pl.latLon(g.f, g.u, g.v, {});
  return { f: g.f, u: Math.floor(g.u), v: Math.floor(g.v), x: Math.floor(a.x), z: Math.floor(a.z), lat: ll.lat, lon: ll.lon };
}
const llText = (lat, lon) => BF.coords.llText(lat, lon);
function buildGlobe() {
  if (globe.root) return;
  css();
  const r = globe.root = mount(`<div class="bfm-title">The planet</div><div class="bfm-board" style="cursor:grab"><canvas></canvas></div><div class="bfm-info"></div><div class="bfm-row"><button type="button" data-a="col">Colours: ground</button><button type="button" data-a="here">Find me</button><button type="button" data-a="close">Close</button></div>`);
  globe.cv = r.querySelector("canvas"); globe.g = globe.cv.getContext("2d"); globe.info = r.querySelector(".bfm-info");
  r.querySelector('[data-a="close"]').addEventListener("click", closeGlobe);
  globe.col = r.querySelector('[data-a="col"]');
  globe.col.addEventListener("click", () => { setMode(mode ? 0 : 1); globe.sig = ""; });
  r.querySelector('[data-a="here"]').addEventListener("click", () => { centreOnPlayer(); globe.sig = ""; });
  r.addEventListener("mousedown", e => { if (e.target === r) closeGlobe(); });
  r.addEventListener("contextmenu", e => e.preventDefault());
  const cv = globe.cv, at = e => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * globe.S / b.width, (e.clientY - b.top) * globe.S / b.height]; };
  cv.addEventListener("mousedown", e => { if (e.button !== 0) return; const p = at(e); globe.drag = { x: p[0], y: p[1], moved: 0 }; e.preventDefault(); });
  addEventListener("mousemove", e => {
    if (!globe.open) return;
    const p = at(e);
    if (globe.drag) { const dx = p[0] - globe.drag.x, dy = p[1] - globe.drag.y; globe.drag.moved += Math.abs(dx) + Math.abs(dy); globe.drag.x = p[0]; globe.drag.y = p[1]; turn(dx, dy); }
    globe.mouse = p[0] >= 0 && p[1] >= 0 && p[0] < globe.S && p[1] < globe.S ? p : null; globe.sig = "";
  });
  addEventListener("mouseup", e => {
    if (!globe.open || !globe.drag) return;
    const d = globe.drag; globe.drag = null;
    if (d.moved < 4) { const p = at(e); clickAt(p[0], p[1]); }
  });
  cv.addEventListener("mouseleave", () => { globe.mouse = null; globe.sig = ""; });
  cv.addEventListener("wheel", e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
}
// A click (not a drag) on the globe: selects the spot and, in creative, travels there (onto the surface).
function clickAt(px, py) {
  const h = pick(px, py);
  if (!h) return false;
  globe.sel = h; globe.sig = "";
  const P = BF.player;
  if (!P || P.gameMode !== "creative") return false;
  closeGlobe();
  travel(h.x, h.z);
  return true;
}
function centreOnPlayer() {
  const p = BF.player.position, c = BF.planet.canon(p.x, p.z, {});
  if (!c.off) lookAt(BF.planet.dir(c.f, c.u, c.v, [0, 0, 0]));
}
function sizeGlobe() {
  const avail = Math.max(160, Math.min(innerWidth - 48, innerHeight - 150));
  globe.S = Math.floor(avail); globe.RS = Math.min(globe.S, 360);
  globe.cv.width = globe.cv.height = globe.S;
  globe.cv.style.width = globe.cv.style.height = globe.S + "px";
  globe.img = globe.g.createImageData(globe.RS, globe.RS);
  if (!globe.off) globe.off = document.createElement("canvas");
  globe.off.width = globe.off.height = globe.RS;
}
// Opens the planet view (centred on the player unless `keep`: switching back from the local map keeps the view as it was).
function openGlobe(keep) {
  if (typeof document === "undefined") return false;
  const P = BF.player;
  const swap = view.open;   // from a map's view: swap screens without touching the pointer lock
  if (!swap && P && P.canOpenUI && !P.canOpenUI()) return false;
  buildGlobe();
  if (swap) hideView();
  sizeGlobe();
  if (!keep) { globe.zoom = 1; centreOnPlayer(); }
  globe.sel = null; globe.sig = ""; globe.drag = null;
  globe.open = true;
  if (!swap) { try { if (P && P.uiOpen) P.uiOpen(); } catch (e) { console.error(e); } }
  globe.root.classList.add("open");
  drawGlobe();
  return true;
}
function hideGlobe() { globe.open = false; globe.drag = null; globe.root.classList.remove("open"); }
function closeGlobe() {
  if (!globe.open) return;
  hideGlobe();
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
// Zoomed all the way in: swap to a local auto map (LOCAL_K zones wide) centred on the spot in the middle of the view.
function toLocal() {
  const Pl = BF.planet, g = Pl.fromDir(globe.fwd[0], globe.fwd[1], globe.fwd[2], {}), a = Pl.atlas(g.f, g.u, g.v, {});
  const it = { auto: { k: LOCAL_K, zx: zoneOf(a.x), zz: zoneOf(a.z) }, fromGlobe: true, title: "Planet - local map" };
  hideGlobe();
  return openView(it, true);
}
function drawGlobe() {
  if (!globe.open) return;
  const B = baseGrid(), D = globe.det, sig = viewKey() + "|" + B.ver + "|" + (D ? D.ver : -1) + "|" + (globe.mouse ? globe.mouse.join() : "-") + "|" + (BF.player.position.x | 0) + (BF.player.position.z | 0);
  if (sig === globe.sig) return;
  globe.sig = sig;
  const RS = globe.RS, o = globe.img.data, Pl = BF.planet, d = [0, 0, 0], g = {}, useD = D && D.key === viewKey() && D.RS === RS;
  const lw = 1.2 / (0.46 * RS * globe.zoom) * 180 / Math.PI;    // degrees per render pixel at the disc's centre (graticule width)
  for (let j = 0; j < RS; j++) for (let i = 0; i < RS; i++) {
    const q = (j * RS + i) * 4;
    if (!dirAt(i + 0.5, j + 0.5, RS, d)) { o[q] = 5; o[q + 1] = 7; o[q + 2] = 13; o[q + 3] = 255; continue; }
    let r, gg, b;
    const p = j * RS + i;
    if (useD && D.have[p]) { r = D.c[p * 3]; gg = D.c[p * 3 + 1]; b = D.c[p * 3 + 2]; }
    else {
      Pl.fromDir(d[0], d[1], d[2], g);
      const ci = Math.min(GM - 1, (g.u / Pl.N * GM) | 0), cj = Math.min(GM - 1, (g.v / Pl.N * GM) | 0), c = ((g.f * GM + cj) * GM + ci) * 3;
      r = B.c[c]; gg = B.c[c + 1]; b = B.c[c + 2];
    }
    let k = 0.55 + 0.45 * d.sz;                                  // a little light from the viewer, so it reads as a ball
    const lat = Math.asin(clamp(d[1], -1, 1)) * 180 / Math.PI, m30 = Math.abs(lat - Math.round(lat / 30) * 30);
    if (m30 < lw / Math.max(0.25, d.sz)) k *= 0.8;               // latitude lines every 30 degrees (the equator included)
    o[q] = r * k; o[q + 1] = gg * k; o[q + 2] = b * k; o[q + 3] = 255;
  }
  globe.off.getContext("2d").putImageData(globe.img, 0, 0);
  const S = globe.S, G2 = globe.g, s = S / RS;
  G2.imageSmoothingEnabled = true;
  G2.drawImage(globe.off, 0, 0, RS, RS, 0, 0, S, S);
  // the player (red dot) and the selected spot
  const p = BF.player.position, c = Pl.canon(p.x, p.z, {});
  if (!c.off) {
    const sp = screenOf(Pl.dir(c.f, c.u, c.v, [0, 0, 0]), RS);
    if (sp) { G2.beginPath(); G2.arc(sp[0] * s, sp[1] * s, 5, 0, 6.2832); G2.fillStyle = "#ff3a2a"; G2.strokeStyle = "#101010"; G2.lineWidth = 1.5; G2.fill(); G2.stroke(); }
  }
  if (globe.sel) {
    const sp = screenOf(Pl.dir(globe.sel.f, globe.sel.u + 0.5, globe.sel.v + 0.5, [0, 0, 0]), RS);
    if (sp) { G2.beginPath(); G2.arc(sp[0] * s, sp[1] * s, 8, 0, 6.2832); G2.strokeStyle = "#ffd35a"; G2.lineWidth = 2; G2.stroke(); }
  }
  globe.col.textContent = "Colours: " + (mode ? "biome" : "ground");
  let line = "";
  const h = globe.mouse && pick(globe.mouse[0], globe.mouse[1]);
  if (h) {
    line = llText(h.lat, h.lon) + "   face " + h.f + "  u " + fmtN(h.u) + "  v " + fmtN(h.v);
    if (BF.worldgen) { const b = biomeFor(h.x, h.z, 1e9); line += "   " + b.name; }
  }
  const prog = B.done ? (globe.det && !globe.det.done && globe.zoom >= 1.5 ? "   sharpening" : "") : "   drawing " + Math.floor(100 * (B.pass + B.idx / (6 * (GM / GSTEPS[B.pass]) ** 2)) / GSTEPS.length) + "%";
  const P = BF.player;
  globe.info.textContent = (line || "Drag to turn, scroll to zoom" + (P && P.gameMode === "creative" ? ", click to travel" : "")) + prog +
    "\nzoom " + globe.zoom.toFixed(1) + "x" + (globe.zoom >= ZMAX - 1e-6 ? " (scroll in for the local map)" : "") + "  |  red dot: you  |  Esc to close";
}
function tickGlobe() {
  if (!globe.open) return;
  const t0 = performance.now();
  if (!stepBase(t0 + 12)) stepDetail(t0 + 12);
  drawGlobe();
}

// every key goes to the open overlay (registered at load time, capture phase, like commands.js and signs.js)
addEventListener("keydown", e => {
  if (!view.open && !prompt.open && !globe.open) {   // M opens the planet view (with no other screen open)
    if (e.code !== "KeyM" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const P = BF.player, t = e.target;
    if (!P || (P.canOpenUI && !P.canOpenUI()) || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    openGlobe();
    return;
  }
  e.stopImmediatePropagation();
  if (e.key === "Escape") { e.preventDefault(); if (globe.open) closeGlobe(); else if (view.open) closeView(); else closePrompt(); return; }
  if (globe.open) {
    if (e.code === "KeyM" && !e.repeat) { e.preventDefault(); closeGlobe(); }
    else if (e.key === "Tab" || e.key === "F3" || e.key === "F1") e.preventDefault();
    return;
  }
  if (view.open) {
    if (e.code === "KeyM" && !e.repeat) { e.preventDefault(); openGlobe(!!(view.it && view.it.fromGlobe)); return; }
    if (e.key === "Tab" || e.key === "F3" || e.key === "F1") e.preventDefault();
    return;
  }
  if (e.key === "Enter" || e.key === "NumpadEnter") { e.preventDefault(); confirmPrompt(); return; }
  if (e.key === "Tab" || e.key === "F3" || e.key === "F1") { e.preventDefault(); return; }
  if (e.target !== prompt.input) prompt.input.focus();
}, true);

// Right click from player.js. Returns true when it did something.
function use(sel, it) {
  if (!it) return false;
  if (it.autoBlank) return openPrompt(sel);
  if (it.map || it.auto) return openView(it);
  return false;
}

BF.mapview = {
  setColourMode: setMode, colourMode: () => (mode ? "biome" : "ground"),
  use, held, open: openView, close: () => { closeView(); closePrompt(); closeGlobe(); }, isOpen: () => view.open || prompt.open || globe.open,
  tick() { tick(); tickGlobe(); if (view.open) drawView(); if (view.pending) settle(); refreshIcons(performance.now()); },
  planet: { open: openGlobe, close: closeGlobe, isOpen: () => globe.open, state: globe, zoomBy, turn, pick, clickAt, toLocal, lookAt,
    finishBase() { while (!baseGrid().done) stepBase(Infinity); }, draw() { globe.sig = ""; drawGlobe(); } },
  teleportToSelection, surfaceAt, getAuto, nameOf, geometry, finish, paint, create, zonesFor, dataOfItem, progress: progressOf,
  ZONE, MAX_PX, MAX_K,
  reset() { maps.clear(); thumbs.clear(); snaps.clear(); iconSeen = ""; },
  _maps: maps, _view: view, _prompt: prompt,
};
addEventListener("load", () => { if (BF.on) BF.on("newWorld", () => BF.mapview.reset()); });
})();
