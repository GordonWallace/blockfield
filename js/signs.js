// Signs (see CONTRACT.md "Signs"): standing and wall signs for all 8 woods that merge into one board when placed side by side or
// stacked, a per-world text store keyed by each group's anchor sign, a modal editor that wraps text exactly like the in-world
// board, CanvasTexture text overlays, auto-updating signs (registry) and the village entry arch with its "Village of ..." sign.
// Hooks elsewhere (one line each): world.js setBlock -> onSet, world.js MODELS.sign + world coords for models, player.js
// interact/place/invOpen, worldgen.js layoutVillage -> planArch and drawVillage -> drawArch, save.js serialize/deserialize,
// builder.js keeps clear of v.arch.box, commands.js /locate prints the village name.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const COLS = 15, ROWS = 4;          // one sign: 4 lines x 15 characters (vanilla); a W x H group holds 4H lines x 15W characters
const MAXW = 4, MAXH = 4;           // largest group (bigger runs split into several boards)
const RIGHT = [[-1, 0], [0, -1], [1, 0], [0, 1]];   // the viewer's right (x, z) when reading a sign that faces f
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const PX = 192;                     // in-world texture pixels per block
const INK = "#1b130b";
const FONT = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const ck = (x, y, z) => x + "," + y + "," + z;
const pk = k => k.split(",").map(Number);

// ---------------------------------------------------------------- block tables
const IS = new Uint8Array((BF.MAX_BLOCK || 4095) + 1);
for (const b of BF.blocks || []) if (b && b.sign) IS[b.id] = 1;
const signOf = id => (IS[id] ? BF.blocks[id].sign : null);
const signId = (wood, wall, f) => BF.B[wood + (wall ? "_wall_sign_" : "_sign_") + "nesw"[f & 3]];
const creative = () => !!(BF.player && BF.player.gameMode === "creative");
const W = () => BF.world;
const wget = (x, y, z) => W().getBlock(x, y, z);

// ---------------------------------------------------------------- state
const data = new Map();       // anchor "x,y,z" -> {t: text, auto?: kind, ak?: auto key (village key)}
const seen = new Set();       // auto keys already turned into a sign (never recreated: breaking one is final)
const autoPlan = new Map();   // anchor -> {kind, ak, id, cells} generated auto signs waiting for their chunk (not saved; rebuilt by worldgen)
const autos = {};             // kind -> fn(entry, anchorKey) -> text | null
const groupCache = new Map(); // cell key -> group (world state; cleared on every sign change / chunk load)
const chunkSigns = new Map(); // chunk key -> Set(cell key) of sign cells in loaded chunks
const overlays = new Map();   // anchor key -> {mesh, sig, cell}
const vByKey = new Map();     // village key -> worldgen village object
let renderDirty = true;

// ---------------------------------------------------------------- grouping
// The plane of a sign: same block id (wood, kind, facing); neighbours to the viewer's left/right and above/below.
// A connected run is split into rectangles (<= MAXW x MAXH) greedily: the largest area first, ties to the lowest row,
// then the leftmost column, then the wider one. The anchor of a group is its bottom-left sign as seen from the front.
function component(get, x, y, z) {
  const id = get(x, y, z), s = signOf(id);
  if (!s) return null;
  const R = RIGHT[s.f], out = [], vis = new Set([ck(x, y, z)]), q = [[x, y, z]];
  const nb = [[R[0], 0, R[1]], [-R[0], 0, -R[1]], [0, 1, 0], [0, -1, 0]];
  while (q.length && out.length < 512) {
    const c = q.pop();
    out.push(c);
    for (const d of nb) {
      const n = [c[0] + d[0], c[1] + d[1], c[2] + d[2]], k = ck(n[0], n[1], n[2]);
      if (vis.has(k)) continue;
      vis.add(k);
      if (n[1] < 0 || n[1] >= BF.H) continue;
      if (get(n[0], n[1], n[2]) === id) q.push(n);
    }
  }
  return { id, s, cells: out };
}
function decompose(C) {
  const { id, s, cells } = C, R = RIGHT[s.f];
  const m = new Map();
  for (const c of cells) m.set((c[0] * R[0] + c[2] * R[1]) + "," + c[1], c);
  const free = new Set(m.keys()), groups = [];
  const has = (u, y) => free.has(u + "," + y);
  while (free.size) {
    let best = null;
    for (const k of free) {
      const [u, y] = pk(k);
      let wmin = MAXW;
      for (let h = 1; h <= MAXH; h++) {
        let run = 0;
        while (run < wmin && has(u + run, y + h - 1)) run++;
        wmin = run;
        if (!wmin) break;
        const a = wmin * h;
        if (!best || a > best.a || (a === best.a && (y < best.y || (y === best.y && (u < best.u || (u === best.u && wmin > best.w))))))
          best = { a, u, y, w: wmin, h };
      }
    }
    const g = { id, s, f: s.f, wall: !!s.wall, wood: s.wood, W: best.w, H: best.h, u0: best.u, y0: best.y, cells: [] };
    for (let j = 0; j < best.h; j++) for (let i = 0; i < best.w; i++) {
      const k = (best.u + i) + "," + (best.y + j);
      free.delete(k);
      g.cells.push(m.get(k));
    }
    g.anchor = g.cells[0];
    g.key = ck(g.anchor[0], g.anchor[1], g.anchor[2]);
    groups.push(g);
  }
  return groups;
}
function groupAt(x, y, z) {
  const k = ck(x, y, z);
  let g = groupCache.get(k);
  if (g) return g;
  const C = component(wget, x, y, z);
  if (!C) return null;
  for (const gg of decompose(C)) for (const c of gg.cells) groupCache.set(ck(c[0], c[1], c[2]), gg);
  return groupCache.get(k) || null;
}
const capacity = g => ({ cols: COLS * g.W, rows: ROWS * g.H });
// Board extent in the anchor's cell units (y offsets from y0): wall boards span 4/16 .. H-1 + 12/16, standing boards
// 8/16 (above the posts) or 0 (stacked on another standing sign) .. H.
function boardSpan(g, get) {
  get = get || wget;
  if (g.wall) return [4 / 16, g.H - 4 / 16];
  const [ax, ay, az] = g.anchor;
  return [get(ax, ay - 1, az) === g.id ? 0 : 8 / 16, g.H];
}

// world.js mesher model: per cell boxes so a group reads as one board without seams (wx, wz = world coords of the cell)
function signBoxes(get, x, y, z, id, wx, wz) {
  const b = BF.blocks[id], s = b.sign;
  if (wx === undefined) return b.boxes;
  const g = groupAt(wx, y, wz);
  if (!g) return b.boxes;
  const R = RIGHT[s.f], i = wx * R[0] + wz * R[1] - g.u0, j = y - g.y0;
  let out;
  if (s.wall) out = [[0, j === 0 ? 4 : 0, 0, 16, j === g.H - 1 ? 12 : 16, 2]];
  else {
    const posted = j === 0 && get(x, y - 1, z) !== id;
    out = [[0, posted ? 8 : 0, 7, 16, 16, 9]];
    if (posted && (g.W === 1 || i === 0 || i === g.W - 1)) out.push([7, 0, 7, 9, 8, 9, s.wood + "_log"]);
  }
  return out.map(q => BF.rotBox(q, s.f));
}
if (BF.world && BF.world.MODELS) BF.world.MODELS.sign = signBoxes;
else console.warn("signs.js: world.MODELS missing (world.js must load first)");

// ---------------------------------------------------------------- text layout
// Greedy word wrap to `cols` characters: explicit newlines are kept, a line breaks at its last space (the space is consumed),
// a word longer than a line is split. Returns {lines, pos}: pos[i] = [line, column] of the caret before character i.
function layout(text, cols) {
  const lines = [], pos = new Array(text.length + 1);
  let base = 0;
  for (const p of text.split("\n")) {
    let start = 0;
    if (!p.length) { pos[base] = [lines.length, 0]; lines.push(""); }
    while (start < p.length) {
      let end = start + cols, sp = false;
      if (end >= p.length) end = p.length;
      else { const br = p.lastIndexOf(" ", end); if (br > start) { end = br; sp = true; } }
      for (let k = start; k < end; k++) pos[base + k] = [lines.length, k - start];
      lines.push(p.slice(start, end));
      start = end;
      if (sp) { pos[base + start] = [lines.length - 1, lines[lines.length - 1].length]; start++; }   // the consumed space ends its line
    }
    pos[base + p.length] = [lines.length - 1, lines[lines.length - 1].length];
    base += p.length + 1;
  }
  return { lines, pos };
}
function clampText(text, cols, rows) {
  text = String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  const L = layout(text, cols);
  if (L.lines.length <= rows) return text;
  let cut = text.length;
  for (let i = 0; i <= text.length; i++) if (L.pos[i] && L.pos[i][0] >= rows) { cut = i; break; }
  return text.slice(0, cut).replace(/[\n ]+$/, "");
}
// Draws wrapped lines centred on a board of W x H signs into a w x h pixel area (shared by the world texture and the editor).
function textGeom(W_, H_, w, h) {
  const mx = w / W_ / 16, my = h * 0.04;
  const cw = (w - 2 * mx) / (COLS * W_);
  const slot = (h - 2 * my) / (ROWS * H_);
  const fs = Math.min(slot * 0.95, cw * 1.62);
  const lh = Math.min(slot, fs * 1.3);
  const top = (h - lh * ROWS * H_) / 2;
  return { mx, cw, fs, lh, top, w };
}
function drawLines(ctx, lines, G) {
  ctx.fillStyle = INK;
  ctx.font = `500 ${G.fs.toFixed(1)}px ${FONT}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((ln, k) => {
    const x0 = (G.w - ln.length * G.cw) / 2, y = G.top + G.lh * (k + 0.5);
    for (let i = 0; i < ln.length; i++) if (ln[i] !== " ") ctx.fillText(ln[i], x0 + (i + 0.5) * G.cw, y);
  });
}

// ---------------------------------------------------------------- text store API
function entryOf(g) { return g ? data.get(g.key) || null : null; }
function get(x, y, z) {
  const g = groupAt(x, y, z);
  if (!g) return null;
  const e = entryOf(g), c = capacity(g);
  return { anchor: g.anchor.slice(), W: g.W, H: g.H, wall: g.wall, f: g.f, wood: g.wood, cells: g.cells.map(c => c.slice()),
    text: e ? e.t || "" : "", auto: e && e.auto ? e.auto : null, autoKey: e && e.ak ? e.ak : null, cols: c.cols, rows: c.rows, lines: layout(e ? e.t || "" : "", c.cols).lines };
}
function setText(x, y, z, text, force) {
  const g = groupAt(x, y, z);
  if (!g) return false;
  const c = capacity(g), e = data.get(g.key);
  if (e && e.auto && !force) return false;
  const t = clampText(text, c.cols, c.rows);
  if (e) e.t = t;
  else if (t) data.set(g.key, { t });
  if (e && !e.t && !e.auto) data.delete(g.key);
  renderDirty = true;
  return true;
}

// ---------------------------------------------------------------- world changes
const nbrs = (x, y, z, s) => { const R = RIGHT[s.f]; return [[x + R[0], y, z + R[1]], [x - R[0], y, z - R[1]], [x, y + 1, z], [x, y - 1, z]]; };
function comps(get, seeds) {
  const out = [], done = new Set();
  for (const [x, y, z] of seeds) {
    if (done.has(ck(x, y, z))) continue;
    const C = component(get, x, y, z);
    if (!C) continue;
    for (const c of C.cells) done.add(ck(c[0], c[1], c[2]));
    out.push(C);
  }
  return out;
}
function dropFor(id, x, y, z) {
  if (!creative() && BF.drops) BF.drops.spawnAt(BF.rollDrops(id), x, y, z);
}
function pop(x, y, z, id) { if (W().setBlock(x, y, z, 0)) dropFor(id, x, y, z); }
function supported(x, y, z, id) {
  const s = signOf(id);
  if (!s) return true;
  if (s.wall) return BF.SOLID[wget(x - DIRS[s.f][0], y, z - DIRS[s.f][1])] === 1;
  const b = wget(x, y - 1, z);
  return BF.SOLID[b] === 1 || b === id;
}
function markDirty(cells) {
  const w = W(), CS = BF.CS, keys = new Set();
  for (const c of cells) keys.add(Math.floor(c[0] / CS) + "," + Math.floor(c[2] / CS));
  for (const k of keys) { const ch = w.chunks.get(k); if (ch && ch.mesh !== undefined) w._dirty.add(k); }
}
function trackCell(x, y, z, on) {
  const CS = BF.CS, k = Math.floor(x / CS) + "," + Math.floor(z / CS);
  let set = chunkSigns.get(k);
  if (on) { if (!set) chunkSigns.set(k, (set = new Set())); set.add(ck(x, y, z)); }
  else if (set) set.delete(ck(x, y, z));
}

// Called by world.setBlock after every change (oldId -> id at x, y, z).
function onSet(x, y, z, oldId, id) {
  const so = signOf(oldId), sn = signOf(id);
  if (so || sn) structural(x, y, z, oldId, id, so, sn);
  if (!sn || !so) {
    // things resting on this cell: a standing sign above, wall signs hanging on it
    const above = wget(x, y + 1, z), sa = signOf(above);
    if (sa && !sa.wall && !supported(x, y + 1, z, above)) pop(x, y + 1, z, above);
    if (!BF.SOLID[id]) for (let f = 0; f < 4; f++) {
      const nx = x + DIRS[f][0], nz = z + DIRS[f][1], nid = wget(nx, y, nz), s = signOf(nid);
      if (s && s.wall && s.f === f) pop(nx, y, nz, nid);
    }
  }
}
function structural(x, y, z, oldId, id, so, sn) {
  const cur = wget, prev = (a, b, c) => (a === x && b === y && c === z ? oldId : wget(a, b, c));
  const oldSeeds = [], newSeeds = [];
  if (so) { oldSeeds.push([x, y, z]); for (const n of nbrs(x, y, z, so)) if (cur(n[0], n[1], n[2]) === oldId) newSeeds.push(n); }
  if (sn) { newSeeds.push([x, y, z]); for (const n of nbrs(x, y, z, sn)) if (prev(n[0], n[1], n[2]) === id) oldSeeds.push(n); }
  const oldG = [].concat(...comps(prev, oldSeeds).map(decompose));
  const newG = [].concat(...comps(cur, newSeeds).map(decompose));
  const where = new Map();
  for (const g of newG) for (const c of g.cells) where.set(ck(c[0], c[1], c[2]), g);
  const moved = new Map();
  let autoBroken = null;
  for (const og of oldG) {
    const e = data.get(og.key);
    if (!e) continue;
    data.delete(og.key);
    if (e.auto && !sn && og.cells.some(c => c[0] === x && c[1] === y && c[2] === z)) { autoBroken = og; seen.add(e.ak); }
    let tgt = where.get(og.key) || null;
    if (!tgt) {
      let bestN = 0;
      for (const g of newG) {
        const n = og.cells.filter(c => where.get(ck(c[0], c[1], c[2])) === g).length;
        if (n > bestN) { bestN = n; tgt = g; }
      }
    }
    if (!tgt) continue;
    if (!moved.has(tgt)) moved.set(tgt, []);
    moved.get(tgt).push({ og, e });
  }
  for (const [g, list] of moved) {
    if (list.length === 1 && list[0].og.key === g.key && list[0].og.W === g.W && list[0].og.H === g.H) { data.set(g.key, list[0].e); continue; }
    list.sort((a, b) => (b.og.y0 - a.og.y0) || (a.og.u0 - b.og.u0));
    const c = capacity(g), t = clampText(list.map(l => l.e.t || "").filter(Boolean).join("\n"), c.cols, c.rows);
    if (t) data.set(g.key, { t });   // a changed group is an ordinary sign (the auto flag goes)
  }
  trackCell(x, y, z, !!sn);
  groupCache.clear();
  renderDirty = true;
  const all = [[x, y, z]];
  for (const g of oldG.concat(newG)) all.push(...g.cells);
  markDirty(all);
  // breaking any sign of an auto sign breaks the whole board: one sign item per sign block, and it never comes back
  if (autoBroken) for (const c of autoBroken.cells) {
    if (c[0] === x && c[1] === y && c[2] === z) continue;
    if (wget(c[0], c[1], c[2]) === autoBroken.id) pop(c[0], c[1], c[2], autoBroken.id);
  }
}

function onChunkLoad(cx, cz, c) {
  const CS = BF.CS, vox = c.vox, maxY = Math.min(BF.H - 1, c.maxY);
  let set = null, edge = false;
  for (let y = 0; y <= maxY; y++) for (let lz = 0; lz < CS; lz++) {
    const row = (y * CS + lz) * CS;
    for (let lx = 0; lx < CS; lx++) if (IS[vox[row + lx]]) {
      if (!set) set = new Set();
      set.add(ck(cx * CS + lx, y, cz * CS + lz));
      if (lx < MAXW || lx >= CS - MAXW || lz < MAXW || lz >= CS - MAXW) edge = true;
    }
  }
  if (!set) return;
  chunkSigns.set(cx + "," + cz, set);
  groupCache.clear();
  renderDirty = true;
  if (edge) { // groups crossing the border may have changed shape: remesh the neighbours
    const w = W();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const k = (cx + dx) + "," + (cz + dz), ch = w.chunks.get(k);
      if ((dx || dz) && ch && ch.mesh !== undefined) w._dirty.add(k);
    }
  }
  pendingAuto = true;
}
function onChunkUnload(cx, cz) {
  if (!chunkSigns.delete(cx + "," + cz)) return;
  groupCache.clear();
  renderDirty = true;
}
if (BF.world && BF.world.onChunkLoad) { BF.world.onChunkLoad(onChunkLoad); BF.world.onChunkUnload(onChunkUnload); }

// ---------------------------------------------------------------- in-world text overlays
function lightAt(x, y, z) {
  const w = W(), c = w.chunkAt(x, z), CS = BF.CS;
  let sky = 1;
  if (c) { const top = c.top[(z - c.cz * CS) * CS + (x - c.cx * CS)]; sky = y > top ? 1 : Math.max(0.3, 0.92 - (top - y) * 0.06); }
  const ss = Math.min(1, Math.max(0, (sky - 0.3) / 0.4)), sm = ss * ss * (3 - 2 * ss);
  const sk = Math.max(0.1, sky * (0.6 + 0.4 * sm) * (w.daylight == null ? 1 : w.daylight));
  const bl = (w.getBlockLight ? w.getBlockLight(x, y, z) : 0) / 15;
  return Math.max(sk, Math.min(1, 1.1 * Math.pow(bl, 1.25)));
}
function boardFrame(g) {
  const [ax, ay, az] = g.anchor, R = RIGHT[g.f], D = DIRS[g.f], [b0, b1] = boardSpan(g);
  const off = g.wall ? -0.5 + 2 / 16 + 0.004 : 1 / 16 + 0.004;
  return {
    x: ax + 0.5 + R[0] * (g.W - 1) / 2 + D[0] * off, z: az + 0.5 + R[1] * (g.W - 1) / 2 + D[1] * off,
    y: ay + (b0 + b1) / 2, w: g.W, h: b1 - b0, rotY: [Math.PI, Math.PI / 2, 0, -Math.PI / 2][g.f],
  };
}
function disposeOverlay(o) {
  if (!o) return;
  if (BF.scene) BF.scene.remove(o.mesh);
  o.mesh.geometry.dispose(); o.mesh.material.map.dispose(); o.mesh.material.dispose();
}
function buildOverlay(g, text) {
  const fr = boardFrame(g), c = capacity(g);
  const cv = document.createElement("canvas");
  cv.width = Math.round(fr.w * PX); cv.height = Math.max(8, Math.round(fr.h * PX));
  const ctx = cv.getContext("2d");
  drawLines(ctx, layout(text, c.cols).lines.slice(0, c.rows), textGeom(g.W, g.H, cv.width, cv.height));
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(fr.w, fr.h), mat);
  mesh.position.set(fr.x, fr.y, fr.z);
  mesh.rotation.y = fr.rotY;
  mesh.renderOrder = 2;
  mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
  BF.scene.add(mesh);
  const cell = [Math.round(fr.x - 0.5), g.anchor[1], Math.round(fr.z - 0.5)];
  return { mesh, cell };
}
function refresh() {
  renderDirty = false;
  if (!BF.scene || typeof THREE === "undefined") return;
  const want = new Map();
  for (const set of chunkSigns.values()) for (const k of set) {
    const [x, y, z] = pk(k), g = groupAt(x, y, z);
    if (g && !want.has(g.key)) want.set(g.key, g);
  }
  for (const [k, o] of overlays) if (!want.has(k)) { disposeOverlay(o); overlays.delete(k); }
  for (const [k, g] of want) {
    const e = data.get(k), t = e && e.t;
    const old = overlays.get(k);
    if (!t) { if (old) { disposeOverlay(old); overlays.delete(k); } continue; }
    const sig = g.id + "|" + g.W + "x" + g.H + "|" + boardSpan(g).join(",") + "|" + t;
    if (old && old.sig === sig) continue;
    disposeOverlay(old);
    const o = buildOverlay(g, t);
    o.sig = sig;
    o.mesh.material.color.setScalar(lightAt(o.cell[0], o.cell[1], o.cell[2]));
    overlays.set(k, o);
  }
}
function relight() {
  for (const o of overlays.values()) o.mesh.material.color.setScalar(lightAt(o.cell[0], o.cell[1], o.cell[2]));
}

// ---------------------------------------------------------------- placing and using
// target = player.js block target {x, y, z, id, normal}. Top face (or a replaceable plant) -> standing sign facing the player,
// side face -> wall sign on that block. Sneak-clicking a sign with a sign extends it: left/right edges add a column, the top of a
// standing sign stacks another standing sign, the top/bottom of a wall sign another wall sign. Opens the editor afterwards.
function place(target, it) {
  const w = W(), P = BF.player, n = target.normal, ts = signOf(target.id);
  const wood = (it && it.wood) || String(it && it.name || "oak_sign").replace(/_sign$/, "");
  let x, y, z, wall, f;
  if (ts) {
    const R = RIGHT[ts.f];
    wall = ts.wall; f = ts.f;
    if (n[1] === 1 || (n[1] === -1 && ts.wall) || (!n[1] && Math.abs(n[0] * R[0] + n[2] * R[1]) === 1)) { x = target.x + n[0]; y = target.y + n[1]; z = target.z + n[2]; }
    else return false;
  } else {
    const into = BF.REPLACEABLE && BF.REPLACEABLE[target.id] && !BF.FLUID[target.id];
    if (n[1] === -1 && !into) return false;
    x = into ? target.x : target.x + n[0]; y = into ? target.y : target.y + n[1]; z = into ? target.z : target.z + n[2];
    if (into || n[1] === 1) {
      wall = 0;
      f = BF.dirIndex(P.position.x - (x + 0.5), P.position.z - (z + 0.5));
      // line up with a standing sign of the same wood beside it (same plane, facing roughly the same way) so they merge
      for (let d = 0; d < 4; d++) {
        const nid = wget(x + DIRS[d][0], y, z + DIRS[d][1]), s = signOf(nid);
        if (s && !s.wall && s.wood === wood && s.f % 2 !== d % 2 && DIRS[s.f][0] * DIRS[f][0] + DIRS[s.f][1] * DIRS[f][1] >= 0) { f = s.f; break; }
      }
    } else { wall = 1; f = BF.dirIndex(n[0], n[2]); }
  }
  if (y < 0 || y >= BF.H || !w.isLoaded(x, z)) return false;
  const cur = wget(x, y, z);
  if ((cur !== 0 && !(BF.REPLACEABLE && BF.REPLACEABLE[cur])) || BF.FLUID[cur]) return false;
  const id = signId(wood, wall, f);
  if (id == null || !supported(x, y, z, id)) return false;
  if (!w.setBlock(x, y, z, id)) return false;
  if (BF.emit) BF.emit("blockPlaced", x, y, z, id);
  setTimeout(() => openEditor(x, y, z), 0);
  return true;
}
function interact(target) { return openEditor(target.x, target.y, target.z); }

// ---------------------------------------------------------------- editor
const ed = { open: false, root: null, cv: null, ta: null, info: null, title: null, g: null, cell: null, ro: false, prev: "", prevSel: 0, blinkT: 0, S: 100 };
function css() {
  const st = document.createElement("style");
  st.textContent = `
.bfs-wrap{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,10,9,.55);z-index:40}
.bfs-wrap.open{display:flex}
.bfs-panel{background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:14px 16px 12px;display:flex;flex-direction:column;align-items:center;gap:10px;max-width:calc(100vw - 32px)}
.bfs-title{font:13px var(--display);color:var(--ink);letter-spacing:.04em}
.bfs-board{position:relative;line-height:0;box-shadow:0 6px 18px rgba(0,0,0,.45);cursor:text}
.bfs-board canvas{image-rendering:pixelated;max-width:calc(100vw - 64px)}
.bfs-board textarea{position:absolute;inset:0;width:100%;height:100%;opacity:0;resize:none;border:0;padding:0;margin:0;cursor:text;font-size:16px}
.bfs-info{font:12px var(--mono);color:var(--muted);min-height:16px}
.bfs-info.full{color:var(--danger)}
.bfs-row{display:flex;gap:8px}
.bfs-row button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:6px 18px;cursor:pointer}
.bfs-row button:hover{background:rgba(127,191,77,.38)}`;
  document.head.appendChild(st);
}
function buildDOM() {
  if (ed.root) return;
  css();
  const r = document.createElement("div");
  r.className = "bfs-wrap";
  r.innerHTML = `<div class="bfs-panel"><div class="bfs-title"></div><div class="bfs-board"><canvas></canvas><textarea spellcheck="false" autocomplete="off" aria-label="Sign text"></textarea></div>
<div class="bfs-info"></div><div class="bfs-row"><button type="button" data-a="done">Done</button></div></div>`;
  (document.getElementById("ui") || document.body).appendChild(r);
  ed.root = r; ed.cv = r.querySelector("canvas"); ed.ta = r.querySelector("textarea");
  ed.info = r.querySelector(".bfs-info"); ed.title = r.querySelector(".bfs-title");
  r.querySelector('[data-a="done"]').addEventListener("click", () => closeEditor());
  r.addEventListener("mousedown", e => { if (e.target === r) { e.preventDefault(); } });
  const ta = ed.ta;
  const remember = () => { ed.prev = ta.value; ed.prevSel = ta.selectionStart; };
  ta.addEventListener("keydown", remember);
  ta.addEventListener("input", () => {
    const c = capacity(ed.g);
    let v = ta.value.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
    if (v !== ta.value) ta.value = v;
    if (layout(v, c.cols).lines.length > c.rows) {   // no room: refuse the edit (a paste is cut to what fits)
      const cut = clampText(v, c.cols, c.rows);
      ta.value = cut.length >= ed.prev.length ? cut : ed.prev;
      const p = Math.min(ta.value.length, ed.prevSel + Math.max(0, ta.value.length - ed.prev.length));
      ta.setSelectionRange(p, p);
      ed.info.classList.add("full");
      setTimeout(() => ed.info.classList.remove("full"), 400);
    }
    remember();
    drawEditor();
  });
  for (const ev of ["keyup", "click", "select", "focus"]) ta.addEventListener(ev, () => drawEditor());
}
let woodCache = {};
function woodTile(wood) {
  if (woodCache[wood]) return woodCache[wood];
  let c = null;
  try {
    const name = wood === "oak" ? "planks" : wood + "_planks", T = BF.textures.build(), img = T.canvas, uv = BF.textures.uv(name);
    const aw = img.width, ah = img.height, ts = Math.round((uv[2] - uv[0]) * aw);
    c = document.createElement("canvas"); c.width = c.height = ts;
    c.getContext("2d").drawImage(img, Math.round(uv[0] * aw), Math.round((1 - uv[3]) * ah), ts, ts, 0, 0, ts, ts);
  } catch (e) { c = null; }
  return (woodCache[wood] = c);
}
function drawEditor() {
  if (!ed.open) return;
  const g = ed.g, cv = ed.cv, ctx = cv.getContext("2d"), [b0, b1] = boardSpan(g), bh = b1 - b0, S = ed.S;
  const w = cv.width, h = cv.height;
  ctx.imageSmoothingEnabled = false;
  const tile = woodTile(g.wood);
  ctx.fillStyle = BF.WOOD_COLOR ? BF.WOOD_COLOR[g.wood] : "#a2834f";
  ctx.fillRect(0, 0, w, h);
  if (tile) for (let by = 0; by < Math.ceil(bh) + 1; by++) for (let bx = 0; bx < g.W; bx++) {
    // same texture alignment as the board in the world: the tile repeats per block, cut at the board edges
    const y0 = h - (by + 1) * S + (b0 % 1) * S;
    ctx.drawImage(tile, bx * S, y0, S, S);
  }
  ctx.fillStyle = "rgba(0,0,0,.18)";
  ctx.fillRect(0, 0, w, 2); ctx.fillRect(0, h - 2, w, 2); ctx.fillRect(0, 0, 2, h); ctx.fillRect(w - 2, 0, 2, h);
  const c = capacity(g), text = ed.ta.value, L = layout(text, c.cols), G = textGeom(g.W, g.H, w, h);
  drawLines(ctx, L.lines, G);
  // caret
  if (!ed.ro && document.activeElement === ed.ta && ((performance.now() - ed.blinkT) % 1000) < 600) {
    const p = L.pos[Math.min(ed.ta.selectionEnd, text.length)] || [0, 0], ln = L.lines[p[0]] || "";
    const x = (w - ln.length * G.cw) / 2 + p[1] * G.cw, y = G.top + G.lh * p[0];
    ctx.fillStyle = INK; ctx.fillRect(Math.round(x), Math.round(y + G.lh * 0.12), Math.max(2, Math.round(G.cw * 0.12)), Math.round(G.lh * 0.76));
  }
  const used = L.lines.length, last = L.lines[used - 1] || "";
  const left = Math.max(0, (c.rows - used) * c.cols + (c.cols - last.length));
  ed.info.textContent = ed.ro ? "This sign updates itself and cannot be edited"
    : `${g.W}×${g.H}: ${c.rows} lines × ${c.cols} characters · ${used}/${c.rows} lines used · ~${left} characters left`;
}
function openEditor(x, y, z) {
  const g = groupAt(x, y, z);
  if (!g || typeof document === "undefined") return false;
  const P = BF.player;
  if (ed.open) closeEditor();
  if (P && P.canOpenUI && !P.canOpenUI()) return false;
  buildDOM();
  const e = entryOf(g);
  ed.g = g; ed.cell = [x, y, z]; ed.ro = !!(e && e.auto);
  const [b0, b1] = boardSpan(g), bh = b1 - b0;
  ed.S = Math.floor(Math.max(60, Math.min(560 / g.W, 330 / bh, 230)));
  ed.cv.width = g.W * ed.S; ed.cv.height = Math.round(bh * ed.S);
  ed.ta.value = e ? e.t || "" : "";
  ed.ta.readOnly = ed.ro;
  ed.prev = ed.ta.value; ed.prevSel = ed.prev.length;
  ed.title.textContent = ed.ro ? "Village sign" : g.W * g.H > 1 ? `Edit sign (${g.W}×${g.H} board)` : "Edit sign";
  ed.open = true;                     // before releasing the lock: player.js must not pause or re-lock
  try { if (P && P.uiOpen) P.uiOpen(); } catch (err) { console.error(err); }
  ed.root.classList.add("open");
  ed.ta.focus();
  const n = ed.ta.value.length; ed.ta.setSelectionRange(n, n);
  ed.blinkT = performance.now();
  drawEditor();
  return true;
}
function closeEditor() {
  if (!ed.open) return;
  ed.open = false;
  ed.root.classList.remove("open");
  ed.ta.blur();
  if (!ed.ro) { const [x, y, z] = ed.cell; if (signOf(wget(x, y, z))) setText(x, y, z, ed.ta.value); }
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (err) { console.error(err); }
}
// every key goes to the editor while it is open (registered at load time, capture phase, like commands.js)
addEventListener("keydown", e => {
  if (!ed.open) return;
  e.stopImmediatePropagation();
  if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey || ed.ro))) { e.preventDefault(); closeEditor(); return; }
  if (e.key === "Tab" || e.key === "F3" || e.key === "F1") { e.preventDefault(); return; }
  if (e.target !== ed.ta) ed.ta.focus();
  ed.blinkT = performance.now();
}, true);

// ---------------------------------------------------------------- auto signs
function registerAuto(kind, fn) { autos[kind] = fn; }
function runAuto(onlyKey) {
  for (const [k, e] of data) {
    if (!e.auto || (onlyKey && k !== onlyKey)) continue;
    const [x, y, z] = pk(k);
    if (!W().isLoaded(x, z)) continue;
    const fn = autos[e.auto], g = groupAt(x, y, z);
    if (!fn || !g || g.key !== k) continue;
    let t = null;
    try { t = fn(e, k, g); } catch (err) { console.error(err); }
    if (t == null) continue;
    const c = capacity(g);
    t = clampText(t, c.cols, c.rows);
    if (t !== e.t) { e.t = t; renderDirty = true; }
  }
}
let pendingAuto = true;
// generated auto signs become text entries once all their blocks are loaded (and only once per auto key)
function tryAutoPlans() {
  pendingAuto = false;
  for (const [k, p] of autoPlan) {
    if (seen.has(p.ak)) { autoPlan.delete(k); continue; }
    if (!p.cells.every(c => W().isLoaded(c[0], c[2]))) continue;
    autoPlan.delete(k);
    seen.add(p.ak);
    const g = groupAt(p.cells[0][0], p.cells[0][1], p.cells[0][2]);
    if (!p.cells.every(c => wget(c[0], c[1], c[2]) === p.id) || !g || g.key !== k || g.W * g.H !== p.cells.length || data.has(k)) continue;
    data.set(k, { t: "", auto: p.kind, ak: p.ak });
    runAuto(k);
    renderDirty = true;
  }
}

// ---------------------------------------------------------------- villages: names, entry arch, the village sign
let namePerm = null, namePermSeed = null;
function nameFor(region, spawn) {
  const list = BF.VILLAGE_NAMES || ["Village"], n = list.length, seed = (BF.state && BF.state.seed) >>> 0;
  if (!namePerm || namePermSeed !== seed) {
    namePermSeed = seed; namePerm = list.map((_, i) => i);
    let h = (seed ^ 0x9e3779b9) >>> 0;
    const r = () => { h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [namePerm[i], namePerm[j]] = [namePerm[j], namePerm[i]]; }
  }
  // rx + 9 rz never repeats inside a 9 x 9 block of regions; the spawn village is offset by half the list
  const i = (((region[0] + 9 * region[1] + (spawn ? (n >> 1) : 0)) % n) + n) % n;
  return list[namePerm[i]];
}
const vkeyOf = v => Math.round(v.x) + "," + Math.round(v.z);
function villageName(v) {
  if (v && typeof v === "object") return v.name || (v.wg && v.wg.name) || null;
  const known = vByKey.get(String(v));
  if (known) return known.name || null;
  const [x, z] = String(v).split(",").map(Number), G = BF.worldgen;
  if (G && G.nearestVillage && isFinite(x)) { const nv = G.nearestVillage(x, z); if (nv && vkeyOf(nv) === String(v)) return nv.name || null; }
  return null;
}
function hash32(a, b, c) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
const SIGN_WOOD = ["oak", "birch", "spruce", "acacia", "spruce"];   // per village style: plains, desert, snowy, savanna, taiga

// Called by worldgen layoutVillage (after roads, buildings and lamps, before the village box is computed). Picks an entry arch site:
// a random edge (from the village position and seed); preferably over the main road leaving through that edge, as near its end as
// fits, else the edge midpoint. Returns {box, ...} (the box goes into the village box) or null.
function planArch(v, ctx) {
  const key = vkeyOf(v);
  vByKey.set(key, v);
  if (!v.name) v.name = nameFor(ctx.region || [0, 0], ctx.spawn);
  const C = ctx.climate, SEA = BF.SEA, seed = (BF.state && BF.state.seed) | 0;
  const h = hash32(v.x, v.z, seed ^ 0x51a7), start = h & 3, side = (h >> 2) & 1 ? 1 : -1;
  const inB = (x, z, b, m) => x >= b.x0 - m && x <= b.x1 + m && z >= b.z0 - m && z <= b.z1 + m;
  // pillars may stand on a plot's levelled ring (not inside a building, not in front of a door); the signs and the passage stay off plots
  const near = (x, z) => v.lamps.some(l => Math.abs(l[0] - x) <= 1 && Math.abs(l[1] - z) <= 1) || v.decor.some(d => z === d[1] && x >= d[0] - 1 && x <= d[0] + 2);
  const inHouse = (x, z) => v.buildings.some(b => inB(x, z, b, 0) || (Math.abs(x - (b.doorX - b.sx)) + Math.abs(z - (b.doorZ - b.sz)) <= 1));
  const padOf = (x, z) => v.pads.find(p => inB(x, z, p, 0));
  const onRoad = (x, z) => v.roads.some(r => inB(x, z, r, 0));
  let strict = true;   // first pass: pillars off every plot; second pass: a pillar may stand on a plot's levelled ring
  const site = (cx, cz, d, road) => {
    const L = [-d[1], d[0]], P = (k, t) => [cx + L[0] * k + d[0] * t, cz + L[1] * k + d[1] * t];
    const pillars = [P(-2, 0), P(2, 0)], under = [P(-1, 0), P(0, 0), P(1, 0)], signs = [2, 3, 4].map(k => P(side * k, 1));
    for (const c of pillars) if (inHouse(c[0], c[1]) || near(c[0], c[1]) || onRoad(c[0], c[1]) || (strict ? padOf(c[0], c[1]) : (padOf(c[0], c[1]) || {}).path)) return null;
    for (const c of signs) if (padOf(c[0], c[1]) || near(c[0], c[1]) || onRoad(c[0], c[1]) || inHouse(c[0], c[1])) return null;
    for (const c of under) if (padOf(c[0], c[1]) || near(c[0], c[1]) || (road && !onRoad(c[0], c[1]))) return null;
    const g = c => { const p = padOf(c[0], c[1]); return p ? p.y : C(c[0], c[1]); };
    const all = pillars.concat(under, signs).map(c => [c[0], c[1], g(c)]);
    if (all.some(c => c[2] <= SEA)) return null;
    const pg = pillars.map(g), ug = under.map(g), sg = signs.map(g), gs = sg[1];
    if (Math.abs(pg[0] - pg[1]) > 2 || Math.max(...ug) - Math.min(...ug) > 1 || sg.some(q => Math.abs(q - gs) > 1) || Math.abs(gs - ug[1]) > 2) return null;
    if (Math.max(...pg) - Math.min(...ug) > 2) return null;
    const top = Math.max(...pg, ...ug) + 5, f = BF.dirIndex(d[0], d[1]), wood = SIGN_WOOD[v.style] || "oak";
    const xs = all.map(c => c[0]), zs = all.map(c => c[1]);
    return { key, x: cx, z: cz, d, L, top, f, wood, path: !road, style: v.style,
      pillars: pillars.map((c, i) => [c[0], c[1], pg[i]]), under: under.map((c, i) => [c[0], c[1], ug[i]]),
      lintel: [-2, -1, 0, 1, 2].map(k => P(k, 0)), crown: [-1, 0, 1].map(k => P(k, 0)),
      signs: signs.map((c, i) => [c[0], gs + 1, c[1], sg[i]]),
      box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] };
  };
  let a = null;
  for (const pass of [true, false]) for (let k = 0; k < 4 && !a; k++) {
    strict = pass;
    const d = DIRS[(start + k) & 3];
    const road = v.roads.find(r => r.dx === d[0] && r.dz === d[1] && r.sx === v.x + d[0] * 8 && r.sz === v.z + d[1] * 8);
    if (!road) continue;
    const ts = [road.end, road.end + 1];
    for (let t = road.end - 1; t >= Math.max(4, road.end - 14); t--) ts.push(t);
    for (const t of ts) if (!a) { a = site(road.sx + d[0] * t, road.sz + d[1] * t, d, t <= road.end); if (a) a.onRoad = true; }
  }
  if (!a) { // no main road fits: the middle of an edge of the village's extent, facing out
    let x0 = v.x - 7, x1 = v.x + 7, z0 = v.z - 7, z1 = v.z + 7;
    for (const r of v.pads.concat(v.roads)) { x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1); z0 = Math.min(z0, r.z0); z1 = Math.max(z1, r.z1); }
    for (let k = 0; k < 4 && !a; k++) {
      const d = DIRS[(start + k) & 3], L = [-d[1], d[0]];
      const mx = d[0] > 0 ? x1 + 2 : d[0] < 0 ? x0 - 2 : Math.round((x0 + x1) / 2), mz = d[1] > 0 ? z1 + 2 : d[1] < 0 ? z0 - 2 : Math.round((z0 + z1) / 2);
      for (const s of [0, 4, -4, 8, -8]) if (!a) a = site(mx + L[0] * s, mz + L[1] * s, d, false);
    }
  }
  if (!a) return null;
  // the sign group's anchor (leftmost as read from the front) and the plan that turns it into an auto sign when it loads
  a.signId = signId(a.wood, 0, a.f);
  const R = RIGHT[a.f], cells = a.signs.map(s => [s[0], s[1], s[2]]).sort((p, q) => (p[0] * R[0] + p[2] * R[1]) - (q[0] * R[0] + q[2] * R[1]));
  a.anchor = cells[0];
  if (a.signId != null && !seen.has(key)) autoPlan.set(ck(cells[0][0], cells[0][1], cells[0][2]), { kind: "village", ak: key, id: a.signId, cells });
  pendingAuto = true;
  return a;
}
// Called by worldgen drawVillage with its chunk-clipped setter and the village palette.
function drawArch(v, set, S) {
  const a = v.arch, B = BF.B;
  if (!a) return;
  const post = S.corner || S.log, beam = S.log || S.corner;
  for (const [x, z, g] of a.under) {
    if (a.path) set(x, g, z, v.style === 1 ? B.sandstone : B.dirt_path);
    for (let y = g + 1; y < a.top; y++) set(x, y, z, 0);
  }
  for (const [x, z, g] of a.pillars) {
    set(x, g, z, S.found);
    for (let y = g + 1; y < a.top; y++) set(x, y, z, post);
  }
  a.lintel.forEach(([x, z], i) => set(x, a.top, z, i === 0 || i === 4 ? post : beam));
  a.crown.forEach(([x, z], i) => set(x, a.top + 1, z, i === 1 ? S.wall : (S.roof || S.wall)));
  set(a.crown[1][0], a.top - 1, a.crown[1][1], B.lantern);
  for (const [x, y, z, g] of a.signs) {
    for (let yy = g + 1; yy < y; yy++) set(x, yy, z, S.found);
    set(x, y, z, a.signId);
    set(x, y + 1, z, 0); set(x, y + 2, z, 0);
  }
}
function countBedsFallback(v) {
  let n = 0;
  for (const h of (v && v.houses) || []) for (const b of h.beds || []) {
    if (!W().isLoaded(b.x, b.z)) { n++; continue; }
    const d = BF.blocks[wget(b.x, b.y, b.z)];
    if (d && d.bed) n++;
  }
  return n;
}
registerAuto("village", (e) => {
  const key = e.ak, v = vByKey.get(key) || null;
  const name = villageName(key) || "Village";
  const M = BF.mobs, rec = M && M.villages && M.villages.get(key);
  let nv = 0, nb = 0;
  if (rec) {
    if (!rec.name) rec.name = name;
    const live = (rec.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed).length;
    let rl = rec.roster ? rec.roster.length : 0;   // mobs.js builds the roster once the village is near; until then use the same deterministic roster
    if (!rec.roster && M.roster) { try { rl = M.roster({ key, houses: rec.houses || [], nb: rec.nb || 0 }).length; } catch (err) { rl = 0; } }
    nv = rec.roster && BF.breeding && BF.breeding.villagerCount ? BF.breeding.villagerCount(rec)
      : Math.max(live, rl - ((rec.killed && rec.killed.villager) || 0));
    nb = BF.breeding && BF.breeding.bedCount ? BF.breeding.bedCount(rec) : countBedsFallback(rec.wg || v);
  } else if (v) {
    try { nv = M && M.roster ? M.roster({ key, houses: v.houses || [], nb: (v.buildings || []).length }).length : 0; } catch (err) { nv = 0; }
    nb = countBedsFallback(v);
  } else return null;
  return "Village of " + name + "\nVillagers: " + nv + "\nBeds: " + nb;
});

// ---------------------------------------------------------------- item sprites and recipes
const K = BF.texKit;
if (K && K.SPRITES) for (const sp of BF.WOOD_SPECIES || ["oak"]) {
  K.SPRITES[sp + "_sign"] = (G, m) => {
    const hi = K.mix(m, K.WHITE, 0.25), lo = K.mul(m, 0.72), post = K.mul(m, 0.55);
    for (let y = 2; y <= 9; y++) for (let x = 1; x <= 14; x++) K.put(G, x, y, y === 2 ? hi : y === 9 || x === 14 ? lo : m);
    for (const y of [4, 6, 8]) for (let x = 3; x <= 12; x++) if ((x + y) % 5) K.put(G, x, y, K.mul(m, 0.62));
    for (let y = 10; y <= 15; y++) { K.put(G, 7, y, post); K.put(G, 8, y, K.mul(post, 0.85)); }
  };
}
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, fuel }) => {
  const I = BF.I, list = [];
  for (const sp of BF.WOOD_SPECIES || ["oak"]) {
    const planks = I[sp === "oak" ? "planks" : sp + "_planks"], out = I[sp + "_sign"];
    if (planks == null || out == null) continue;
    addShaped(out, 3, ["PPP", "PPP", " S "], { P: planks, S: I.stick }, sp === "oak" ? "6 Planks of one wood + 1 Stick → 3 Signs of that wood" : undefined);
    list.push(out);
  }
  if (list.length) fuel(list, 10, "Sign");
});

// ---------------------------------------------------------------- save / reset / loop
function serialize() {
  const out = { v: 1, data: [], seen: [...seen] };
  for (const [k, e] of data) out.data.push([k, e.t || "", e.auto || null, e.ak || null]);
  return out;
}
function reset() {
  if (ed.open) { ed.ro = true; closeEditor(); }
  data.clear(); seen.clear(); groupCache.clear();
  for (const o of overlays.values()) disposeOverlay(o);
  overlays.clear();
  renderDirty = true; pendingAuto = true;
}
function deserialize(o) {
  data.clear(); seen.clear(); groupCache.clear(); renderDirty = true; pendingAuto = true;
  if (!o) return;
  for (const [k, t, auto, ak] of o.data || []) { const e = { t: t || "" }; if (auto) { e.auto = auto; e.ak = ak; } data.set(k, e); }
  for (const s of o.seen || []) seen.add(s);
  for (const [k, p] of autoPlan) if (seen.has(p.ak)) autoPlan.delete(k);
}
let lastHH = null, tSlow = 0, lastT = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.25, Math.max(0, (now - lastT) / 1000)); lastT = now;
  if (!BF.world || !BF.world.chunks) return;
  try {
    if (pendingAuto) tryAutoPlans();
    const S = BF.sky;
    if (S && !(BF.state && BF.state.paused)) {
      const hh = Math.floor(((S.day || 0) + (S.time || 0)) * 48);   // half an in-game hour = 1/48 day
      if (hh !== lastHH) { lastHH = hh; runAuto(); }
    }
    if (renderDirty) refresh();
    tSlow -= dt;
    if (tSlow <= 0) {
      tSlow = 0.4; relight();
      if (BF.mobs && BF.mobs.villages) for (const rec of BF.mobs.villages.values()) if (!rec.name && rec.wg && rec.wg.name) rec.name = rec.wg.name;
    }
    if (ed.open) drawEditor();
  } catch (err) { console.error(err); }
}
requestAnimationFrame(tick);
addEventListener("load", () => {
  if (BF.on) BF.on("newWorld", reset);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { for (const o of overlays.values()) o.sig = null; renderDirty = true; });
});

BF.signs = {
  COLS, ROWS, MAXW, MAXH,
  get, setText, groupAt: (x, y, z) => { const g = groupAt(x, y, z); return g ? { anchor: g.anchor.slice(), W: g.W, H: g.H, key: g.key, f: g.f, wall: g.wall, wood: g.wood, id: g.id } : null; },
  layout, clampText, capacity: (W_, H_) => ({ cols: COLS * W_, rows: ROWS * H_ }),
  onSet, place, interact, openEditor, closeEditor, isOpen: () => ed.open,
  registerAuto, runAuto, autos,
  planArch, drawArch, villageName, nameFor,
  serialize, deserialize, reset,
  isSign: id => !!IS[id], signId,
  _state: { data, seen, autoPlan, overlays, chunkSigns, groupCache, vByKey },
};
})();
