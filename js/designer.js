// The sandbox structure designer (spec idea-051): describe a structure, Claude draws it (debug/claude.js /claude/blueprint, through the
// local server, which holds the API key), and Build here stamps it into the sandbox world at once (no builders, no materials) so it can be
// walked round, changed by hand, captured back into the drawing and sent to Claude again. Sandbox worlds only; G opens it.
// - Build here: the design's front (its door, else its south side) turned to face the player, 3 blocks ahead, centred, its ground layer
//   in place of the grass. Through idea-050's stamp (js/sandbox.js), so every host applies it and a recorded session replays it. A stamp
//   that would cut into blocks that aren't the plain (another stamp, a scene object, hand building) asks "Build anyway?" first.
// - Rebuild: the last stamp's cells back to the plain and the shown version in the same spot and facing (one stamp). Clear: the plain back.
// - Capture: the blocks in the last stamp's box plus 2 blocks round it and above (the plain itself counts as air) read back into a
//   drawing in the design's own frame, hand edits included (js/housedesign.js fromCells); it becomes the next version and what the next
//   request sends. Blocks outside the palette keep their names (and are offered to Claude with the palette) and are flagged.
// - Versions: every design, capture, library load and restore is a numbered version: preview, build or restore any of them.
// - Save: sandbox/structures/<name>.json (the design as drawn, plus {format: "bf-structure-1"}) through the local server (debug/sandbox.js);
//   the Library lists them and builds from them, and scene files name them ({"structure": "<name>"}, js/sandbox.js loads them first).
// - Without an API key (or without the local server) the panel says so and offers nothing else. The spend cap reached: it says so and
//   Build, Rebuild, Clear and Capture still work.
// Game log ("designer"): INFO for a design received, a build, rebuild, clear, capture and save; ERROR for a failed request, save or stamp.
// API: BF.designer = { open(), close(), isOpen(), state, api(path, body?) -> Promise<json> (tests replace it), request(text), build(v, force),
//        rebuild(), clear(), capture(), save(name), library(), loadLibrary(name), showVersion(n), restore(n), placement(v) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.page) return;

const H = () => BF.houseDesign;
const glog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "designer", text); };
const AHEAD = 3, MARGIN = 2, MODEL_KEY = "bf.designer.model";
const st = {
  open: false, el: null, preview: null, status: null, versions: [], cur: -1, stamp: null, busy: false, pending: null, msg: "", bad: false,
  lib: [], big: false, upTo: Infinity,
};
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const rot90 = (x, z, k) => { for (let i = 0; i < (k & 3); i++) { const t = x; x = -z; z = t; } return [x, z]; };   // as js/blueprints.js
const plainAt = y => BF.flatgen.plainAt(y);
const ground = () => BF.flatgen.TOP;
let model = null;
try { model = localStorage.getItem(MODEL_KEY); } catch (e) { /* storage off: the server's default */ }

// ---------------------------------------------------------------- the server
function api(p, body) {
  const o = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-cache" };
  return fetch(p, o).then(r => r.json().catch(() => ({ error: "HTTP " + r.status })).then(j => (r.ok ? j : Object.assign({ error: "HTTP " + r.status }, j, { httpStatus: r.status }))));
}
const call = (p, body) => D.api(p, body);
function refreshStatus() {
  return call("claude/status").then(s => { st.status = s && !s.error && s.configured != null ? s : Object.assign({ configured: false }, s); }, () => { st.status = { configured: false, offline: true }; })
    .then(() => { if (st.status && st.status.configured && (!model || !(st.status.models || []).includes(model))) model = st.status.model; render(); });
}

// ---------------------------------------------------------------- versions
function addVersion(design, src, extra) {
  const r = H().toBlueprint(design);
  const v = Object.assign({ n: st.versions.length + 1, design, src, t: Date.now(), r: r.error ? null : r, error: r.error || null, warnings: (r.warnings || []).slice(), problems: [], T: null }, extra || {});
  st.versions.push(v);
  st.cur = st.versions.length - 1;
  showPreview();
  render();
  return v;
}
const current = () => st.versions[st.cur] || null;
function showVersion(n) { const i = st.versions.findIndex(v => v.n === n); if (i >= 0) { st.cur = i; showPreview(); render(); } return current(); }
function restore(n) {
  const v = st.versions.find(x => x.n === n);
  if (!v) return null;
  return addVersion(JSON.parse(JSON.stringify(v.design)), "restore of v" + n, { T: v.T, warnings: v.warnings.slice() });
}

// ---------------------------------------------------------------- Claude
// the palette for a request: the game's, plus any game blocks the current drawing keeps (a capture's hand edits)
function paletteFor(design) {
  const pal = H().palette(), have = new Set(pal.map(p => p.name));
  for (const e of (design && design.legend) || []) if (e && !have.has(e.block) && BF.B[e.block] != null) { have.add(e.block); pal.push({ name: e.block, about: "kept from a change made by hand" }); }
  return pal;
}
function request(text) {
  text = String(text || "").trim();
  if (!text || st.busy) return Promise.resolve(null);
  const prev = current(), body = { request: text, palette: paletteFor(prev && prev.design), previous: prev ? prev.design : undefined, model: model || undefined };
  st.busy = true; say(prev ? "Asking Claude to change v" + prev.n + "..." : "Asking Claude for a design...");
  return call("claude/blueprint", body).then(j => {
    st.busy = false;
    if (!j || j.error) {
      const m = (j && j.error) || "no answer";
      glog("ERROR", "Design request failed: " + m);
      say(j && j.capped ? m + ". Build, Rebuild, Clear and Capture still work." : "Couldn't get a design: " + m, true);
      refreshStatus();
      return null;
    }
    if (!j.design) { glog("ERROR", "Design request: " + (j.refused ? "Claude declined the request" : "no design came back")); say(j.refused ? "Claude declined that request." : "No design came back.", true); return null; }
    const v = addVersion(j.design, "Claude (" + (j.model || "?") + ")", { T: prev ? prev.T : null, request: text, attempts: j.attempts, cost: j.cost || 0 });
    v.problems = j.problems || [];
    glog("INFO", "Design v" + v.n + " \"" + (j.design.name || "?") + "\" from " + (j.model || "?") + ": " + (j.attempts || 1) + " attempt(s), $" + (j.cost || 0).toFixed(4) +
      (v.problems.length ? ", " + v.problems.length + " problems left" : "") + (v.error ? ", unusable: " + v.error : ""));
    say(v.error ? "v" + v.n + " can't be built: " + v.error : "v" + v.n + ": " + (j.design.name || "design") + (v.problems.length ? " (with problems, see below)" : ""), !!v.error);
    refreshStatus();
    return v;
  }, e => { st.busy = false; glog("ERROR", "Design request failed: " + (e && e.message || e)); say("Couldn't reach the local server: " + (e && e.message || e), true); return null; });
}

// ---------------------------------------------------------------- placing
// the player's forward grid direction, 0 north (-z) .. 3 west
function playerDir() {
  const y = BF.player.yaw != null ? BF.player.yaw : (BF.camera && BF.camera.rotation ? BF.camera.rotation.y : 0);
  const fx = -Math.sin(y), fz = -Math.cos(y);
  return Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 1 : 3) : (fz > 0 ? 2 : 0);
}
const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];
// where version v goes for Build here: {ox, oz, k} (world cell = (ox, oz) + rot90(grid x, z, k)), its front facing the player
function placement(v) {
  const r = v.r, p = BF.player.position, px = Math.floor(p.x), pz = Math.floor(p.z), d = playerDir();
  const k = (((d + 2) & 3) - H().frontOf(r)) & 3, [fx, fz] = DIRV[d], lx = -fz, lz = fx;
  let minA = Infinity, minL = Infinity, maxL = -Infinity;
  for (const c of r.cells) { const [x, z] = rot90(c[0], c[2], k); const a = x * fx + z * fz, l = x * lx + z * lz; minA = Math.min(minA, a); minL = Math.min(minL, l); maxL = Math.max(maxL, l); }
  const A = px * fx + pz * fz + AHEAD - minA, L = px * lx + pz * lz - Math.floor((minL + maxL) / 2);
  return { ox: fx * A + lx * L, oz: fz * A + lz * L, k };
}
function worldCells(v, T) {
  const y0 = ground(), out = [];
  for (const c of v.r.cells) { const [x, z] = rot90(c[0], c[2], T.k); out.push([T.ox + x, y0 + c[1], T.oz + z, BF.blueprints.rotId(c[3], T.k)]); }
  return out;
}
// cells of the target that already hold something other than the plain, and aren't the stamp being replaced
function conflicts(cells, replacing) {
  const W = BF.world, mine = new Set((replacing || []).map(c => c[0] + "," + c[1] + "," + c[2]));
  let n = 0;
  for (const c of cells) {
    if (mine.has(c[0] + "," + c[1] + "," + c[2]) || !W.isLoaded(c[0], c[2])) continue;
    if (W.getBlock(c[0], c[1], c[2]) !== plainAt(c[1])) n++;
  }
  return n;
}
function stampCells(label, put, takeBack) {
  const flat = [];
  for (const c of takeBack || []) flat.push(c[0], c[1], c[2], plainAt(c[1]));
  for (const c of put || []) flat.push(c[0], c[1], c[2], c[3]);
  return BF.sandbox.stamp({ label, cells: flat, mobs: [] });
}
function doBuild(v, T, label, takeBack, force) {
  if (!BF.sandbox || !BF.sandbox.on()) { say("The designer builds in sandbox worlds only", true); return Promise.resolve({ ok: false, why: "not a sandbox world" }); }
  if (!v || !v.r) { say("Nothing to build" + (v && v.error ? ": " + v.error : ""), true); return Promise.resolve({ ok: false, why: "nothing to build" }); }
  const cells = worldCells(v, T), n = force ? 0 : conflicts(cells, takeBack);
  if (n) {
    st.pending = { v, T, label, takeBack };
    say("This would cut into " + n + " blocks of something already there. Build anyway?", true);
    render();
    return Promise.resolve({ ok: false, conflict: n });
  }
  st.pending = null;
  return stampCells(label + " v" + v.n, cells, takeBack).then(res => {
    if (!res.ok) { glog("ERROR", label + " v" + v.n + " refused: " + (res.why || "?")); say("Couldn't build: " + (res.why || "?"), true); return res; }
    st.stamp = { v: v.n, T, cells };
    glog("INFO", label + " v" + v.n + " \"" + (v.design.name || "?") + "\" at " + T.ox + ", " + ground() + ", " + T.oz + " turned " + T.k + ": " + cells.length + " blocks");
    say(label + " v" + v.n + ": " + cells.length + " blocks");
    render();
    return Object.assign({ cells: cells.length }, res);
  });
}
function build(v, force) { v = v || current(); return doBuild(v, v && v.r ? placement(v) : null, "Built", null, force); }
function rebuild(force) {
  const v = current();
  if (!st.stamp) return build(v, force);
  return doBuild(v, v && v.T ? v.T : st.stamp.T, "Rebuilt", st.stamp.cells, force);
}
function clear() {
  if (!st.stamp) { say("Nothing built to clear", true); return Promise.resolve({ ok: false }); }
  const s = st.stamp;
  return stampCells("Cleared v" + s.v, null, s.cells).then(res => {
    if (!res.ok) { glog("ERROR", "Clear refused: " + (res.why || "?")); say("Couldn't clear: " + (res.why || "?"), true); return res; }
    st.stamp = null;
    glog("INFO", "Cleared v" + s.v + ": " + s.cells.length + " blocks back to the plain");
    say("Cleared"); render();
    return res;
  });
}
// the blocks of the last stamp's box (plus MARGIN round it and above), the plain counting as air, back into a drawing
function capture() {
  const s = st.stamp, W = BF.world;
  if (!s) { say("Build something first: Capture reads the last build's box", true); return null; }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = -Infinity;
  for (const c of s.cells) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); z0 = Math.min(z0, c[2]); z1 = Math.max(z1, c[2]); y1 = Math.max(y1, c[1]); }
  const y0 = ground(), T = s.T, back = (4 - T.k) & 3, cells = [];
  for (let y = y0; y <= y1 + MARGIN; y++) for (let z = z0 - MARGIN; z <= z1 + MARGIN; z++) for (let x = x0 - MARGIN; x <= x1 + MARGIN; x++) {
    if (!W.isLoaded(x, z)) continue;
    const id = W.getBlock(x, y, z);
    if (!id || id === plainAt(y)) continue;
    const [gx, gz] = rot90(x - T.ox, z - T.oz, back);
    cells.push([gx, y - y0, gz, BF.blueprints.rotId(id, back)]);
  }
  const prev = st.versions.find(v => v.n === s.v), f = H().fromCells(cells, prev ? prev.design.name : "captured structure");
  if (prev) { f.design.summary = prev.design.summary || f.design.summary; f.design.notes = prev.design.notes || ""; }
  const [dx, dz] = rot90(f.x0 || 0, f.z0 || 0, T.k);
  const v = addVersion(f.design, "capture of the build of v" + s.v, { T: { ox: T.ox + dx, oz: T.oz + dz, k: T.k } });
  v.warnings = f.warnings.concat(v.warnings.filter(w => !/outside the palette/.test(w)));
  glog("INFO", "Captured v" + v.n + " from the build of v" + s.v + ": " + cells.length + " blocks" + (f.warnings.length ? " (" + f.warnings.join("; ") + ")" : ""));
  say("Captured v" + v.n + (f.warnings.length ? ": " + f.warnings.join("; ") : ""));
  return v;
}

// ---------------------------------------------------------------- library
function save(name) {
  const v = current();
  name = String(name || "").trim();
  if (!v) { say("Nothing to save", true); return Promise.resolve({ ok: false }); }
  if (!/^[\w-]{1,64}$/.test(name)) { say("A name is letters, digits, - and _", true); return Promise.resolve({ ok: false }); }
  const data = Object.assign({ format: "bf-structure-1" }, v.design);
  return call("sandbox/api/save", { dir: "structures", name, data }).then(j => {
    if (!j || !j.ok) { glog("ERROR", "Saving structure \"" + name + "\" failed: " + (j && j.error || "no answer")); say("Couldn't save: " + (j && j.error || "no answer"), true); return { ok: false }; }
    if (BF.sandbox) BF.sandbox.structures[name] = v.design;
    glog("INFO", "Saved v" + v.n + " as " + j.path);
    say("Saved as " + j.path);
    return library().then(() => j);
  }, e => { glog("ERROR", "Saving structure \"" + name + "\" failed: " + e); say("Couldn't save: " + e, true); return { ok: false }; });
}
function library() {
  return call("sandbox/api/list?dir=structures").then(j => { st.lib = (j && j.names) || []; render(); return st.lib; }, () => { st.lib = []; render(); return []; });
}
function fetchStructure(name) {
  return fetch("sandbox/structures/" + name + ".json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("no structure called " + name); return r.json(); });
}
function loadLibrary(name) {
  return fetchStructure(name).then(d => { if (BF.sandbox) BF.sandbox.structures[name] = d; const v = addVersion(d, "library: " + name); say("Loaded " + name + " as v" + v.n); return v; },
    e => { glog("ERROR", "Loading structure \"" + name + "\" failed: " + (e && e.message || e)); say(String(e && e.message || e), true); return null; });
}

// a library design as cells for a scene's structure entry (js/sandbox.js): door facing north, ground layer at y 0
function designCells(design) {
  const r = H().toBlueprint(design);
  if (r.error) throw new Error(r.error);
  const k = (0 - H().frontOf(r)) & 3;
  return r.cells.map(c => { const [x, z] = rot90(c[0], c[2], k); return [x, c[1], z, BF.blueprints.rotId(c[3], k)]; });
}
if (BF.sandbox) { BF.sandbox.designCells = designCells; BF.sandbox.fetchStructure = fetchStructure; }

// ---------------------------------------------------------------- the panel
const css = `
.bfd-wrap{position:fixed;top:12px;right:12px;bottom:12px;width:min(440px,calc(100vw - 24px));display:none;z-index:40}
.bfd-wrap.open{display:block}.bfd-wrap.big{width:min(820px,calc(100vw - 24px))}
.bfd{height:100%;overflow:auto;background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font:12px var(--mono);color:var(--ink);box-sizing:border-box}
.bfd h3{margin:0;font:13px var(--display);letter-spacing:.04em;display:flex;gap:8px;align-items:center}.bfd h3 .g{flex:1}
.bfd h4{margin:4px 0 0;font:12px var(--display);color:var(--muted)}
.bfd [hidden]{display:none!important}.bfd-on{display:flex;flex-direction:column;gap:8px}
.bfd .m{color:var(--muted);white-space:pre-wrap}.bfd .m.bad{color:var(--danger)}
.bfd textarea,.bfd input,.bfd select{font:12px var(--mono);padding:5px 7px;color:var(--ink);background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px;box-sizing:border-box}
.bfd textarea{width:100%;min-height:56px;resize:vertical}
.bfd .r{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bfd button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:4px 9px;cursor:pointer}
.bfd button:hover{background:rgba(127,191,77,.38)}.bfd button:disabled{opacity:.45;cursor:default}
.bfd button.warn{border-color:var(--danger);background:rgba(200,80,60,.25)}
.bfd canvas{width:100%;height:220px;background:rgba(0,0,0,.3);border-radius:3px;touch-action:none}.bfd-wrap.big canvas{height:440px}
.bfd ul{margin:0;padding-left:18px}.bfd .vl div{display:flex;gap:6px;align-items:center;padding:2px 4px;border-radius:3px;cursor:pointer}
.bfd .vl div.sel{background:rgba(127,191,77,.18)}.bfd .vl span.s{flex:1;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
function buildPanel() {
  if (st.el) return;
  const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  const r = st.el = document.createElement("div");
  r.className = "bfd-wrap";
  // fixed parts (the request box, the preview, the name field) stay put so typing and the 3D view survive a redraw; the rest is redrawn
  r.innerHTML = `<div class="bfd" role="dialog" aria-label="Structure designer"><h3><span class="g">Structure designer</span><button data-a="big" title="A bigger preview">Enlarge</button><button data-a="close">Close</button></h3>` +
    `<div class="m bfd-off"></div><div class="bfd-on" hidden><div class="r bfd-cfg"></div>` +
    `<textarea></textarea><div class="r bfd-send"></div><div class="m bfd-msg"></div><div class="r bfd-pend"></div>` +
    `<canvas></canvas><div class="r"><span class="m">Layers</span><input type="range" data-a="cut" min="1" max="1" value="1" style="flex:1"></div>` +
    `<div class="bfd-info"></div><h4>Library</h4><div class="r"><input data-a="name" placeholder="name" style="flex:1"><button data-a="save">Save</button></div><div class="vl bfd-lib"></div></div></div>`;
  (document.getElementById("ui") || document.body).appendChild(r);
  r.addEventListener("click", onClick);
  const cut = e => { if (e.target.dataset.a === "cut") { st.upTo = +e.target.value >= +e.target.max ? Infinity : +e.target.value; if (st.preview) st.preview.cut(st.upTo); } };
  r.addEventListener("change", e => {
    if (e.target.dataset.a === "model") { model = e.target.value; try { localStorage.setItem(MODEL_KEY, model); } catch (err) { /* not kept */ } }
    cut(e);
  });
  r.addEventListener("input", cut);
}
function onClick(e) {
  const b = e.target.closest("[data-a]");
  if (!b || b.tagName === "SELECT" || b.tagName === "INPUT" || b.disabled) return;
  const a = b.dataset.a, n = +b.dataset.n, q = sel => st.el.querySelector(sel);
  if (a === "close") close();
  else if (a === "send") { const t = q("textarea"); request(t.value).then(v => { if (v) t.value = ""; }); }
  else if (a === "new") { st.cur = -1; showPreview(); say("The next request starts a new design"); }
  else if (a === "build") build();
  else if (a === "rebuild") rebuild();
  else if (a === "anyway" && st.pending) { const p = st.pending; doBuild(p.v, p.T, p.label, p.takeBack, true); }
  else if (a === "clear") clear();
  else if (a === "capture") capture();
  else if (a === "big") { st.big = !st.big; st.el.classList.toggle("big", st.big); render(); if (st.preview) st.preview.draw(); }
  else if (a === "ver") showVersion(n);
  else if (a === "vbuild") build(st.versions.find(v => v.n === n));
  else if (a === "restore") restore(n);
  else if (a === "save") save(q('[data-a="name"]').value);
  else if (a === "lload") loadLibrary(b.dataset.name);
  else if (a === "lbuild") loadLibrary(b.dataset.name).then(v => v && build(v));
}
function say(t, bad) { st.msg = t; st.bad = !!bad; if (st.el) { const m = st.el.querySelector(".bfd-msg"); if (m) { m.textContent = t; m.classList.toggle("bad", !!bad); } } }
function showPreview() {
  const v = current(), cv = st.el && st.el.querySelector("canvas"), sl = st.el && st.el.querySelector('[data-a="cut"]');
  if (sl) { const h = v && v.r ? v.r.bp.hgt : 1; sl.max = String(h); sl.value = String(h); }
  if (!cv || !st.open || typeof THREE === "undefined" || cv.closest("[hidden]")) return;
  try {
    if (!st.preview) st.preview = new (H().Preview)(cv);
    st.upTo = Infinity;
    st.preview.show(v && v.r ? v.r.bp : null);
  } catch (e) { console.error(e); }
}
function render() {
  if (!st.el || !st.open) return;
  const S = st.status, q = sel => st.el.querySelector(sel), off = q(".bfd-off"), on = q(".bfd-on");
  q('[data-a="big"]').textContent = st.big ? "Smaller" : "Enlarge";
  const ready = !!(S && S.configured);
  on.hidden = !ready; off.hidden = ready;
  if (!S) { off.textContent = "Checking for the designer's local server..."; off.classList.remove("bad"); return; }
  if (!ready) {
    off.classList.add("bad");
    off.textContent = S.offline || S.httpStatus === 404 ? "The designer needs the game served by its local server: start it with ./run.sh (node debug/server.js) and open http://localhost:8000."
      : "The designer has no Claude API key (" + (S.error || "not set") + "). Set ANTHROPIC_API_KEY, or put the key in ~/.config/blockfield/anthropic-key, run npm install in debug/, and restart the server.";
    return;
  }
  const v = current(), spend = S.hour != null ? `$${(+S.hour).toFixed(3)} of $${S.hourCap} this hour` : "";
  q(".bfd-cfg").innerHTML = `<span class="m">Model</span><select data-a="model">${(S.models || [S.model]).map(m => `<option${m === model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select><span class="m">${esc(spend)}</span>`;
  q("textarea").placeholder = v ? "What to change in v" + v.n : "Describe a structure: a two-storey spruce cottage with a chimney...";
  q(".bfd-send").innerHTML = `<button data-a="send"${st.busy ? " disabled" : ""}>${st.busy ? "Waiting for Claude..." : v ? "Revise v" + v.n : "Design"}</button>${v ? `<button data-a="new">New design</button>` : ""}`;
  say(st.msg, st.bad);
  q(".bfd-pend").innerHTML = st.pending ? `<button class="warn" data-a="anyway">Build anyway</button>` : "";
  const warn = v ? v.problems.map(p => "Claude's design: " + p).concat(v.warnings) : [];
  const mats = v && v.r ? v.r.materials.slice(0, 12).map(m => m.count + " " + m.name).join(", ") + (v.r.materials.length > 12 ? ", ..." : "") : "";
  q(".bfd-info").innerHTML =
    (v ? `<div><b>v${v.n} ${esc(v.design.name || "")}</b> <span class="m">(${esc(v.src)}${v.r ? ", " + v.r.bp.w + "x" + v.r.bp.d + "x" + v.r.bp.hgt : ""})</span></div>` +
      (v.design.summary ? `<div>${esc(v.design.summary)}</div>` : "") + (v.design.notes ? `<div class="m">${esc(v.design.notes)}</div>` : "") +
      (warn.length ? `<ul class="m bad">${warn.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : "") + (mats ? `<div class="m">Materials: ${esc(mats)}</div>` : "") : "") +
    `<div class="r" style="margin-top:6px"><button data-a="build"${v && v.r ? "" : " disabled"}>Build here</button><button data-a="rebuild"${v && v.r && st.stamp ? "" : " disabled"}>Rebuild</button>` +
    `<button data-a="clear"${st.stamp ? "" : " disabled"}>Clear</button><button data-a="capture"${st.stamp ? "" : " disabled"}>Capture</button></div>` +
    `<h4>Versions</h4><div class="vl">${st.versions.length ? st.versions.slice().reverse().map(x => `<div data-a="ver" data-n="${x.n}" class="${x === v ? "sel" : ""}"><b>v${x.n}</b><span class="s">${esc(x.design.name || "")} \u00b7 ${esc(x.src)}</span>` +
      `<button data-a="vbuild" data-n="${x.n}"${x.r ? "" : " disabled"}>Build</button><button data-a="restore" data-n="${x.n}">Restore</button></div>`).join("") : `<span class="m">None yet.</span>`}</div>`;
  const ni = q('[data-a="name"]');
  if (v && ni.dataset.v !== String(v.n)) { ni.dataset.v = String(v.n); ni.value = String(v.design.name || "").toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); }
  q('[data-a="save"]').disabled = !v;
  q(".bfd-lib").innerHTML = st.lib.length ? st.lib.map(n => `<div><span class="s">${esc(n)}</span><button data-a="lload" data-name="${esc(n)}">Load</button><button data-a="lbuild" data-name="${esc(n)}">Build</button></div>`).join("") : `<span class="m">No saved structures.</span>`;
  if (!st.preview) showPreview();
}
function canOpen() { const p = BF.player; return !!(p && (!p.canOpenUI || p.canOpenUI())); }
function open() {
  if (st.open) return true;
  if (!BF.sandbox || !BF.sandbox.on()) { if (BF.player && BF.player.actionBar) BF.player.actionBar("The structure designer works in sandbox worlds"); return false; }
  if (!canOpen()) return false;
  buildPanel();
  st.open = true;
  try { if (BF.player.uiOpen) BF.player.uiOpen(); } catch (e) { console.error(e); }
  st.el.classList.add("open");
  render();
  refreshStatus().then(() => library());
  return true;
}
function close() {
  if (!st.open) return;
  st.open = false;
  st.el.classList.remove("open");   // (the preview's WebGL view is kept for the next time: a canvas gets one context)
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
// G opens it in a sandbox world; while open, keys go to its fields (Escape closes). Capture phase at load time, like js/coords.js.
addEventListener("keydown", e => {
  if (st.open) {
    e.stopImmediatePropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if ((e.key === "Enter" || e.key === "NumpadEnter") && e.target && e.target.tagName === "TEXTAREA" && !e.shiftKey) { e.preventDefault(); onClick({ target: st.el.querySelector('[data-a="send"]') }); return; }
    if (e.key === "Tab" || e.key === "F3" || e.key === "F1") { e.preventDefault(); return; }
    return;
  }
  if (e.code !== "KeyG" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!BF.sandbox || !BF.sandbox.on() || !canOpen() || !(BF.player && BF.player.menu && !BF.player.menu())) return;
  if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  open();
}, true);

const D = BF.designer = {
  open, close, isOpen: () => st.open, state: st, api, request, build, rebuild, clear, capture, save, library, loadLibrary, showVersion, restore, placement,
  addVersion, current, designCells, refreshStatus,
};
})();
