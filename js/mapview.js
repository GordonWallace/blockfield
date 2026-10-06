// Auto-filling maps (creative only) and the full-screen map view.
//  * "Auto Map" (item auto_map, creative menu): right click asks for a width in blocks, rounds it to whole 8x8-chunk zones (128 blocks) and turns the
//    item into a filled "auto_map_<zones>_<zoneX>_<zoneZ>" map centred on the zone the player stands in. Its pixels come straight from the world
//    generator (BF.worldgen, whichever version the world was made with), not from loaded chunks, so the whole area fills in by itself, coarse to fine,
//    a few milliseconds per frame (tick() is called from the main loop). Nothing is saved: the pixels regenerate from the seed when the map is next
//    held or viewed. Always 1024x1024 pixels at most (256 blocks wide and under: one block per pixel), so a 2048-block map is 2 blocks per pixel.
//  * Right click with any filled map (normal or auto) opens it full screen: zone grid, player arrow, block under the mouse (and biome / height on auto maps).
//    Click a point to select it; in creative mode a Teleport button takes you there, onto the surface (or the water surface).
// API: BF.mapview = { use(sel, it), held(it), tick(), open(it), close(), isOpen(), getAuto, nameOf, geometry, finish(d), paint(d), stats }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const ZONE = 128, MAX_PX = 1024, MAX_K = 32768, DEFAULT_W = 2048;   // 32768 zones = 4194304 blocks: past +-2M blocks the generator's lattice cache keys collide
const COARSE_SCALE = 64;      // above this many blocks per pixel, mile-high plateau weights are approximated (worldgen.setCoarse)
const RIVER_MAX_SCALE = 16;    // rivers (about 20 blocks wide) only on maps with at most 16 blocks per pixel; see step()
const STEPS = [16, 8, 4, 2, 1];
const keyOf = (k, zx, zz) => k + "_" + zx + "_" + zz;
const nameOf = (k, zx, zz) => "auto_map_" + keyOf(k, zx, zz);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const zoneOf = v => Math.floor(v / ZONE);

// ---------------------------------------------------------------- data
const maps = new Map();   // key -> generated map data
function geometry(k, zx, zz) {
  const side = k * ZONE, N = Math.min(MAX_PX, side);
  return { side, N, scale: side / N, x0: zx * ZONE + ZONE / 2 - side / 2, z0: zz * ZONE + ZONE / 2 - side / 2 };
}
function getAuto(k, zx, zz) {
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
const COL = { 0: [40, 70, 160], 1: [230, 215, 150], 2: [235, 235, 220], 3: [130, 130, 130], 4: [60, 120, 220], 5: [130, 190, 80], 6: [50, 130, 40], 7: [200, 120, 200], 8: [110, 170, 70], 9: [30, 80, 30], 10: [80, 110, 60], 11: [90, 90, 50], 12: [235, 210, 130], 13: [200, 110, 60], 14: [180, 170, 70], 15: [100, 170, 50], 16: [20, 150, 40], 17: [40, 110, 80], 18: [30, 90, 70], 19: [235, 240, 250], 20: [170, 220, 255], 21: [160, 200, 200], 22: [150, 210, 120], 23: [250, 170, 200], 24: [150, 150, 150], 25: [220, 230, 240], 26: [255, 255, 255], 27: [170, 170, 170], 28: [170, 100, 170] };
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
  const t = BF.H > 192;   // mile-high worlds (generator 3) use their own snow lines (worldgen.js surface rules)
  if (id === 24) c = h > (t ? 1950 : 100) ? SNOW : h > (t ? 1850 : 90) ? STONE : GRASS;
  else if (id === 25 && h > (t ? 1450 : 74)) c = SNOW;
  else if (id === 26 && h > (t ? 1800 : 92)) c = SNOW;
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
  const o = scratch.data, sea = BF.SEA, tall = BF.H > 192 ? 9 : 1, rel = d.scale * 0.9 + 6;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = j * N + i, q = p * 4, id = d.bio[p];
    if (id === 255) { o[q + 3] = 0; continue; }
    const h = d.hgt[p], wl = d.wl[p];
    let r, g, b;
    if (id === 0 || id === 4 || h < wl) {                       // ocean, river, or any column under water
      const dep = id === 4 ? 0 : clamp(((id === 0 ? sea : wl) - h) / (id === 0 ? 30 : 12), 0, 1);
      r = 70 - dep * 48; g = 130 - dep * 70; b = 230 - dep * 90;
      if (id === 0) { r = 40 - dep * 25 + 10; g = 80 - dep * 40 + 10; b = 170 - dep * 70 + 20; }
    } else {
      let c, tinted = false;
      if (mode) c = COL[id] || [255, 0, 255];
      else { tinted = groundOf(id, h, gtmp); c = gtmp; }
      const hn = i + 1 < N && j + 1 < N && d.bio[p + N + 1] !== 255 ? d.hgt[p + N + 1] : h;
      const sh = clamp((h - hn) / rel * 0.5, -0.35, 0.35), k = 0.7 + 0.45 * clamp((h - sea + 8) / (150 * tall), 0, 1) + sh;
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
  const P = BF.player, p = P.position;
  return BF.maps.heldCanvas(d, d.ver + "|" + (d.cvVer) + "|" + mode, src, (p.x - d.x0) / d.scale * 128 / d.N, (p.z - d.z0) / d.scale * 128 / d.N);
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
    else if (it.map && BF.maps && BF.maps.snapshot) { const m = BF.maps.snapshot(it); src = m.src; ver = "n" + m.ver; }
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
  const r = view.root = mount(`<div class="bfm-title"></div><div class="bfm-board"><canvas></canvas></div><div class="bfm-info"></div><div class="bfm-row"><button type="button" data-a="col" hidden>Colours: ground</button><button type="button" data-a="tp" hidden disabled>Teleport</button><button type="button" data-a="close">Close</button></div>`);
  view.cv = r.querySelector("canvas"); view.g = view.cv.getContext("2d"); view.title = r.querySelector(".bfm-title"); view.info = r.querySelector(".bfm-info");
  r.querySelector('[data-a="close"]').addEventListener("click", closeView);
  view.col = r.querySelector('[data-a="col"]');
  view.col.addEventListener("click", () => { setMode(mode ? 0 : 1); view.sig = ""; drawView(); });
  view.tp = r.querySelector('[data-a="tp"]');
  view.tp.addEventListener("click", teleportToSelection);
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
  const m = BF.maps.snapshot(it);
  return Object.assign({ auto: false, label: m.side + " x " + m.side + " blocks" }, m);
}
function openView(it) {
  if (typeof document === "undefined" || !it || !(it.map || it.auto)) return false;
  const P = BF.player;
  if (P && P.canOpenUI && !P.canOpenUI()) return false;
  buildView();
  view.it = it; view.d = describe(it);
  const avail = Math.max(160, Math.min(innerWidth - 48, innerHeight - 150));
  // normal maps are 128 px of chunky pixels: whole multiples keep them crisp; auto maps are smoothed to fit
  view.S = view.d.auto ? Math.floor(avail) : Math.max(128, Math.floor(avail / 128) * 128);
  view.cv.width = view.cv.height = view.S;
  view.cv.style.width = view.cv.style.height = view.S + "px";
  view.title.textContent = (it.auto ? "Auto map - " : "Map - ") + view.d.label;
  view.open = true;                       // before releasing the lock: player.js must not pause or re-lock
  view.sig = ""; view.sel = null;
  view.col.hidden = !view.d.auto;
  view.tp.hidden = !(P && P.gameMode === "creative");   // like the creative-only auto map itself; /tp stays the survival route
  view.tp.disabled = true;
  try { if (P && P.uiOpen) P.uiOpen(); } catch (e) { console.error(e); }
  view.root.classList.add("open");
  drawView();
  return true;
}
function closeView() {
  if (!view.open) return;
  view.open = false; view.it = null; view.d = null;
  view.root.classList.remove("open");
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
  const mx = (P.x - m.x0) * ppb, mz = (P.z - m.z0) * ppb, inside = mx >= 0 && mz >= 0 && mx < S && mz < S;
  const ang = Math.atan2(-Math.cos(BF.player.yaw), -Math.sin(BF.player.yaw));
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
    line = "x " + x + "  z " + z;
    if (m.auto && BF.worldgen) { const b = biomeFor(x, z, m.scale); line += "   " + b.name + "   height " + Math.round(b.height); }
  }
  if (view.sel) line += (line ? "\n" : "") + "selected  x " + view.sel.x + "  z " + view.sel.z + (view.tp.hidden ? "" : "   (press Teleport)");
  const prog = m.auto && m.d ? (m.d.done ? "" : "   generating " + Math.floor(100 * progressOf(m.d)) + "%") : "";
  view.info.textContent = (line || "Move the mouse over the map for coordinates") + prog + "\ngrid lines every " + gs + " blocks (world coordinates)  |  Esc to close";
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
  const x = s.x + 0.5, z = s.z + 0.5, y = surfaceAt(s.x, s.z);
  closeView();
  P.teleport(x, y, z);
  view.pending = { x: s.x, z: s.z, t: 0 };
  if (P.actionBar) P.actionBar("Teleported to " + s.x + ", " + Math.floor(y) + ", " + s.z);
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
const zonesFor = w => clamp(Math.round(w / ZONE), 1, MAX_K);
function hint() {
  const w = parseFloat(prompt.input.value);
  if (!(w > 0)) { prompt.hint.textContent = "Enter a width, e.g. 2000"; prompt.hint.classList.add("bad"); return false; }
  const k = zonesFor(w), side = k * ZONE, sc = side / Math.min(MAX_PX, side);
  prompt.hint.classList.remove("bad");
  prompt.hint.textContent = "Becomes " + side + " x " + side + " blocks (" + k + " x " + k + " zones of 8x8 chunks), " + (+sc.toFixed(2)) + " block" + (sc === 1 ? "" : "s") + " per pixel" + (sc > RIVER_MAX_SCALE ? ", no rivers at this scale" : "") + (w > MAX_K * ZONE ? "\n(largest allowed is " + MAX_K * ZONE + ")" : "");
  return true;
}
function openPrompt(sel) {
  if (typeof document === "undefined") return false;
  const P = BF.player;
  if (P && P.canOpenUI && !P.canOpenUI()) return false;
  buildPrompt();
  prompt.slot = BF.inventory.slots.indexOf(sel);
  prompt.input.value = DEFAULT_W;
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
  else { inv.setSlot(slot, { id: sel.id, count: sel.count - 1 }); const left = inv.add(id, 1); if (left > 0 && BF.emit) BF.emit("itemDropped", id, left); }
  return true;
}
function confirmPrompt() {
  if (!hint()) return;
  const w = parseFloat(prompt.input.value), slot = prompt.slot;
  closePrompt();
  if (create(w, slot) && BF.player.actionBar) BF.player.actionBar("Map created (" + zonesFor(w) * ZONE + " blocks wide)");
}

// every key goes to the open overlay (registered at load time, capture phase, like commands.js and signs.js)
addEventListener("keydown", e => {
  if (!view.open && !prompt.open) return;
  e.stopImmediatePropagation();
  if (e.key === "Escape") { e.preventDefault(); if (view.open) closeView(); else closePrompt(); return; }
  if (view.open) { if (e.key === "Tab" || e.key === "F3" || e.key === "F1") e.preventDefault(); return; }
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
  use, held, open: openView, close: () => { closeView(); closePrompt(); }, isOpen: () => view.open || prompt.open,
  tick() { tick(); if (view.open) drawView(); if (view.pending) settle(); refreshIcons(performance.now()); },
  teleportToSelection, surfaceAt, getAuto, nameOf, geometry, finish, paint, create, zonesFor, dataOfItem, progress: progressOf,
  ZONE, MAX_PX, MAX_K,
  reset() { maps.clear(); thumbs.clear(); iconSeen = ""; },
  _maps: maps, _view: view, _prompt: prompt,
};
addEventListener("load", () => { if (BF.on) BF.on("newWorld", () => BF.mapview.reset()); });
})();
