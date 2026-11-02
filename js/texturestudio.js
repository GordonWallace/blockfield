// The sandbox texture studio (spec idea-052): look at a block, press K, ask a model to change its texture, and every placed block with
// that tile changes at once (js/textures.js edit.setPixels: one atlas cell and its mip levels re-uploaded, no reload). Undo, versions per
// tile, compare with the game's tile, a texture library (sandbox/textures/), and "Use in all worlds" (sandbox/adopted.json, loaded by
// every world through sandbox/adopted.js). Sandbox worlds only: in-progress and library textures go back to the game's tiles when a
// normal world is open; only adopted ones stay.
// - The model is the local server's provider (debug/texture.js, debug/providers/): Claude by default, or another company's image model.
//   It answers with pixels (a grid or a fitted image, made 32x32 by the server) or a recipe: steps on the game's own painters, painted
//   here (paintRecipe, RECIPE_OPS) so the result has the game's look and tiles seamlessly.
// - Each request also sends a close-up of the block in the world (the view round the crosshair, lit as the game draws it).
// - Faces: top, side, bottom or all (every distinct tile of the block gets the result). Tinted tiles (grass, leaves) are edited grey and
//   the panel says the biome colours them; animated tiles (water, lava) can't be edited.
// Game log ("textures"): INFO for each change, undo, restore, save, library apply, adopt and unadopt; ERROR for a failed request, save or adoption.
// API: BF.textureStudio = { open(), close(), isOpen(), state, api(path, body?) (tests replace it), request(text, face?), apply(tile, rgba, src),
//        undo(), restore(tile, n), compare(on), save(name), library(), applyLibrary(name), adopt(name, block, face), unadopt(tile),
//        paintRecipe(steps, tile) -> {rgba, problems}, faces(blockId), revertAll() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.page) return;

const TS = 32, PROV_KEY = "bf.textures.provider", MODEL_KEY = "bf.textures.model";
const glog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "textures", text); };
const E = () => BF.textures.edit;
const st = {
  open: false, el: null, block: null, face: "side", status: null, provider: null, model: null, busy: false, msg: "", bad: false,
  versions: {}, history: {}, comparing: false, lib: [], adopted: [], adoptFor: null,
};
try { st.provider = localStorage.getItem(PROV_KEY); st.model = localStorage.getItem(MODEL_KEY); } catch (e) { /* the server's defaults */ }
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const b64 = a => { let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const r = atob(s), a = new Uint8ClampedArray(r.length); for (let i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; };

// ---------------------------------------------------------------- the server
function api(p, body) {
  const o = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-cache" };
  return fetch(p, o).then(r => r.json().catch(() => ({ error: "HTTP " + r.status })).then(j => (r.ok ? j : Object.assign({ error: "HTTP " + r.status }, j, { httpStatus: r.status }))));
}
const call = (p, body) => S.api(p, body);
function refreshStatus() {
  return call("sandbox/api/texture/status").then(s => { st.status = s && Array.isArray(s.providers) ? s : { providers: [], offline: true }; }, () => { st.status = { providers: [], offline: true }; })
    .then(() => {
      const ps = st.status.providers, ok = ps.filter(p => p.configured);
      if (!ps.some(p => p.name === st.provider && p.configured)) st.provider = (ok.find(p => p.name === st.status.provider) || ok[0] || {}).name || null;
      const p = ps.find(x => x.name === st.provider);
      if (p && !(p.models || []).includes(st.model)) st.model = p.model;
      render();
    });
}

// ---------------------------------------------------------------- faces and tiles
const FACE_KEYS = ["top", "side", "bottom", "front"];
// the block's tiles by face: {top, side, bottom, front?}
function faces(id) {
  const b = BF.blocks[id];
  if (!b || !b.tiles) return null;
  const out = {};
  for (const k of FACE_KEYS) if (b.tiles[k] && (k !== "front" || b.tiles.front !== b.tiles.side)) out[k] = b.tiles[k];
  return out;
}
function tilesFor(face) {
  const f = faces(st.block);
  if (!f) return [];
  return face === "all" ? [...new Set(Object.values(f))] : f[face] ? [f[face]] : [];
}
function pickTarget() {
  const t = BF.player && BF.player.target;
  if (t && t.id && faces(t.id)) { st.block = t.id; if (!faces(t.id)[st.face] && st.face !== "all") st.face = "side"; }
  return st.block;
}

// ---------------------------------------------------------------- recipes: the game's painters
const RECIPE_OPS = ["fill", "noise", "stone", "cobble", "bricks", "planks", "bark", "log_top", "leaves", "ore_specks", "moss", "frame", "rect", "pixels", "relief"];
function rgbaOf(c) {
  if (String(c).toLowerCase() === "transparent") return [0, 0, 0, 0];
  let h = String(c || "").replace("#", "");
  if (h.length === 3) h = h.split("").map(x => x + x).join("");
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  return [0, 2, 4, 6].map(i => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
}
const toHex = c => "#" + c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
// steps -> 32x32 RGBA, painted over the tile's current pixels (so moss, specks and touch-ups go over what is there)
function paintRecipe(steps, tile) {
  const K = BF.texKit, p = new K.Px(tile || "recipe"), problems = [], cur = tile ? E().pixels(tile) : null;
  for (let i = 0; i < TS * TS * 4; i++) p.c[i] = cur ? cur[i] : (i & 3) === 3 ? 255 : 128;
  p.h.fill(0.5);
  for (const s of steps || []) {
    const cols = (s.colors || []).map(rgbaOf).filter(Boolean), hexes = cols.map(toHex), rgb = cols.map(c => c.slice(0, 3));
    const need = (n, dflt) => (hexes.length >= n ? hexes : dflt);
    try {
      switch (s.op) {
        case "fill": case "rect": {
          const c = cols[0] || [255, 0, 255, 255], x0 = s.op === "rect" || s.w > 0 ? s.x | 0 : 0, y0 = s.op === "rect" || s.h > 0 ? s.y | 0 : 0;
          const w = s.op === "rect" || s.w > 0 ? Math.max(1, s.w | 0) : TS, h = s.op === "rect" || s.h > 0 ? Math.max(1, s.h | 0) : TS;
          for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) p.set(x, y, c, c[3]);
          break;
        }
        case "noise": {
          const C = rgb.length >= 2 ? rgb : [[90, 90, 90], [150, 150, 150]], k = s.amount > 0 ? s.amount : 0.6;
          p.fill((x, y) => p.set(x, y, K.jit(p, K.ramp(C, 0.5 + (p.fbm(x, y, 4, 4, 900) - 0.5) * k * 2.2), 0.04), p.a(x, y) || 255));
          break;
        }
        case "stone": K.stoneBase(p, rgb.length >= 2 ? rgb : K.STONE); break;
        case "cobble": K.cobbleBase(p, rgb.length >= 3 ? { cols: rgb.slice(0, -1), mortar: hexes[hexes.length - 1] } : { cols: rgb.length >= 2 ? rgb : K.STONE }); break;
        case "bricks": {
          const C = rgb.length >= 3 ? rgb.slice(0, -1) : [[120, 50, 40], [150, 70, 55]], mort = rgb.length >= 3 ? rgb[rgb.length - 1] : [150, 145, 135];
          const bw = s.w > 1 ? Math.min(32, s.w | 0) : 8, bh = s.h > 1 ? Math.min(32, s.h | 0) : 4;
          K.bricks(p, { bw, bh, offset: bw >> 1, mortar: 1, mortarCol: mort, cols: C });
          break;
        }
        case "planks": { const C = rgb.length >= 2 ? rgb : K.WOOD_OAK; K.planksBase(p, C, toHex(K.mul(C[0], 0.55))); break; }
        case "bark": K.barkSide(p, rgb.length >= 2 ? rgb : K.WOOD_SPRUCE); break;
        case "log_top": { const h = need(4, ["#4a3622", "#b8945f", "#8a6a40", "#6d5135"]); K.logTop(p, [h[0], h[0]], h[1], h[2], h[3]); break; }
        case "leaves": K.leafTile(p, need(2, ["#4d5549", "#5f685a", "#717a6a", "#848c7b", "#979f8c"])); break;
        case "ore_specks": {
          const C = rgb.length ? rgb : [[60, 40, 30], [200, 160, 60]], n = Math.max(1, Math.min(14, Math.round(s.amount) || 5));
          for (let c = 0; c < n; c++) {
            const cx = p.ri(TS), cy = p.ri(TS), m = 3 + p.ri(4);
            for (let k = 0; k < m; k++) {
              const x0 = cx + p.ri(7) - 3, y0 = cy + p.ri(7) - 3, r = 0.9 + p.rand() * 1.2, R = Math.ceil(r) + 1;
              for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                const d = Math.hypot(dx, dy) / r;
                if (d > 1.45) continue;
                if (d > 1) { p.scale(x0 + dx, y0 + dy, 0.8); continue; }
                const lit = -(dx + dy) / (2 * r), j = Math.max(0, Math.min(C.length - 1, Math.round((lit + 0.5) * (C.length - 1))));
                p.set(x0 + dx, y0 + dy, K.jit(p, C[j], 0.06)); p.setH(x0 + dx, y0 + dy, 1);
              }
            }
          }
          break;
        }
        case "moss": K.mossOver(p, s.amount > 0 ? Math.min(1, s.amount) : 0.3); break;
        case "frame": K.frame(p, Math.max(1, Math.min(15, s.w | 0 || 2)), hexes[0] || "#555555", hexes[1]); break;
        case "pixels": for (const q of s.pixels || []) { const c = rgbaOf(q.color); if (c) p.set(q.x | 0, q.y | 0, c, c[3]); } break;
        case "relief": p.relief(s.amount > 0 ? Math.min(3, s.amount) : 1.2); break;
        default: problems.push("unknown step " + JSON.stringify(s.op) + " left out");
      }
    } catch (err) { problems.push("step " + s.op + " failed: " + (err && err.message)); }
  }
  const out = new Uint8ClampedArray(TS * TS * 4);
  for (let i = 0; i < out.length; i++) out[i] = p.c[i];
  return { rgba: out, problems };
}

// ---------------------------------------------------------------- applying and versions
function vers(tile) { return st.versions[tile] || (st.versions[tile] = [{ n: 0, rgba: E().base(tile), src: "the game's tile", at: 0 }]); }
function apply(tile, rgba, src, extra) {
  if (!E().setPixels(tile, rgba)) return null;
  const list = vers(tile), v = Object.assign({ n: list.length, rgba: new Uint8ClampedArray(rgba), src }, extra || {});
  list.push(v);
  list.cur = v.n;
  st.comparing = false;
  return v;
}
function current(tile) { const l = vers(tile); return l[l.cur != null ? l.cur : 0]; }
function restore(tile, n) {
  const l = vers(tile), v = l.find(x => x.n === n);
  if (!v) return false;
  E().setPixels(tile, n === 0 ? null : v.rgba);
  l.cur = n; st.comparing = false;
  glog("INFO", "Restored " + tile + " to " + (n ? "v" + n : "the game's tile"));
  render();
  return true;
}
function undo() {
  const tiles = tilesFor(st.face);
  let any = false;
  for (const t of tiles) { const l = vers(t), c = l.cur || 0; if (c > 0) { restore(t, c - 1); any = true; } }
  if (!any) say("Nothing to undo", true);
  return any;
}
// show the game's tile (on) or the current version (off) on every placed block, to compare
function compare(on) {
  st.comparing = !!on;
  for (const t of tilesFor(st.face)) { const v = current(t); E().setPixels(t, on || !v.n ? null : v.rgba); }
  render();
}

// ---------------------------------------------------------------- the close-up
function screenshot() {
  try {
    const R = BF.renderer, cv = R && R.domElement;
    if (!cv || !BF.scene || !BF.camera) return null;
    R.render(BF.scene, BF.camera);   // drawn now, so the canvas holds this frame (no preserveDrawingBuffer needed)
    const s = Math.floor(Math.min(cv.width, cv.height) * 0.3), o = document.createElement("canvas");
    o.width = o.height = 128;
    o.getContext("2d").drawImage(cv, (cv.width - s) >> 1, (cv.height - s) >> 1, s, s, 0, 0, 128, 128);
    return o.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- a request
function request(text, face) {
  text = String(text || "").trim();
  if (face) st.face = face;
  if (!text || st.busy) return Promise.resolve(null);
  if (!BF.sandbox || !BF.sandbox.on()) { say("The texture studio works in sandbox worlds only", true); return Promise.resolve(null); }
  const tiles = tilesFor(st.face).filter(t => E().editable(t).ok);
  if (!tiles.length) { say(st.block ? "That face can't be edited (" + (tilesFor(st.face).map(t => E().editable(t).why).join(", ") || "no tile") + ")" : "Look at a block first", true); return Promise.resolve(null); }
  const ref = tiles.includes(faces(st.block).side) ? faces(st.block).side : tiles[0], ed = E().editable(ref), b = BF.blocks[st.block];
  const body = { provider: st.provider, model: st.model, request: text, tile: b64(E().pixels(ref)), screenshot: screenshot(), history: (st.history[ref] || []).slice(-12),
    face: st.face, block: b.name, tileName: ref, tinted: ed.tinted ? ed.tint : null };
  st.busy = true; say("Asking " + (st.provider || "the model") + "..."); render();
  return call("sandbox/api/texture", body).then(j => {
    st.busy = false;
    if (!j || j.error) {
      const m = (j && j.error) || "no answer";
      glog("ERROR", "Texture request for " + b.name + " (" + st.face + ") failed: " + m);
      say((j && j.capped ? m : "Couldn't change the texture: " + m) + ". The tile is unchanged.", true);
      refreshStatus();
      return null;
    }
    let rgba, problems = j.fixes || [];
    if (j.kind === "recipe") { const r = paintRecipe(j.steps, ref); rgba = r.rgba; problems = problems.concat(r.problems); }
    else rgba = unb64(j.rgba);
    const out = [];
    for (const t of tiles) {
      (st.history[t] = st.history[t] || []).push(text);
      const v = apply(t, rgba, (j.provider || "?") + " " + (j.model || ""), { request: text, kind: j.kind === "recipe" ? "recipe" : j.from, recipe: j.steps || null, notes: j.notes || "", problems, cost: j.cost || 0 });
      if (v) out.push(v);
    }
    glog("INFO", "Texture of " + b.name + " (" + st.face + ": " + tiles.join(", ") + ") changed by " + (j.provider || "?") + " " + (j.model || "") + " as a " + (j.kind === "recipe" ? "recipe" : j.from) +
      ", $" + (+j.cost || 0).toFixed(4) + (problems.length ? " (" + problems.join("; ") + ")" : ""));
    say((j.notes || "Changed.") + (problems.length ? " Fixed: " + problems.join("; ") : ""));
    refreshStatus();
    return out[0] || null;
  }, e => { st.busy = false; glog("ERROR", "Texture request failed: " + (e && e.message || e)); say("Couldn't reach the local server: " + (e && e.message || e), true); render(); return null; });
}

// ---------------------------------------------------------------- library and adoption
function selTile() { const t = tilesFor(st.face); return t.includes(faces(st.block || 0) && faces(st.block).side) ? faces(st.block).side : t[0]; }
function save(name) {
  name = String(name || "").trim();
  const tile = selTile();
  if (!tile) { say("Look at a block first", true); return Promise.resolve({ ok: false }); }
  if (!/^[\w-]{1,64}$/.test(name)) { say("A name is letters, digits, - and _", true); return Promise.resolve({ ok: false }); }
  const v = current(tile);
  const meta = { face: st.face, block: BF.blocks[st.block].name, tile, provider: st.provider, model: st.model, history: st.history[tile] || [], recipe: v.recipe || null };
  return call("sandbox/api/texture/save", { name, rgba: b64(E().pixels(tile)), meta }).then(j => {
    if (!j || !j.ok) { glog("ERROR", "Saving texture \"" + name + "\" failed: " + (j && j.error || "no answer")); say("Couldn't save: " + (j && j.error || "no answer"), true); return { ok: false }; }
    glog("INFO", "Saved the texture of " + tile + " as " + j.png);
    say("Saved as " + j.png);
    return library().then(() => j);
  });
}
function library() {
  return Promise.all([
    call("sandbox/api/list?dir=textures").then(j => (j && j.names) || [], () => []),
    fetch("sandbox/adopted.json", { cache: "no-cache" }).then(r => (r.ok ? r.json() : []), () => []).catch(() => []),
  ]).then(([names, adopted]) => { st.lib = names; st.adopted = Array.isArray(adopted) ? adopted : []; render(); return st.lib; });
}
const fetchTexture = name => fetch("sandbox/textures/" + name + ".json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("no texture called " + name); return r.json(); });
function applyLibrary(name) {
  if (!BF.sandbox || !BF.sandbox.on()) { say("Library textures apply in sandbox worlds only", true); return Promise.resolve(null); }
  return fetchTexture(name).then(t => {
    const tiles = tilesFor(st.face).filter(x => E().editable(x).ok);
    if (!tiles.length) { say("Look at a block first", true); return null; }
    const rgba = unb64(t.rgba);
    for (const x of tiles) apply(x, rgba, "library: " + name, { recipe: t.recipe || null });
    glog("INFO", "Applied library texture " + name + " to " + tiles.join(", "));
    say("Applied " + name + " to " + tiles.join(", ")); render();
    return tiles;
  }, e => { glog("ERROR", "Library texture " + name + ": " + (e && e.message || e)); say(String(e && e.message || e), true); return null; });
}
function tileOf(blockName, face) {
  const id = BF.B[String(blockName || "").toLowerCase()], f = id != null ? faces(id) : null;
  return f ? f[face] || f.side || Object.values(f)[0] : null;
}
function adopt(name, blockName, face) {
  const tile = tileOf(blockName, face || "side");
  if (!tile) { say("No block called " + blockName, true); return Promise.resolve({ ok: false }); }
  if (!E().editable(tile).ok) { say(tile + " can't take a texture: " + E().editable(tile).why, true); return Promise.resolve({ ok: false }); }
  return call("sandbox/api/texture/adopt", { name, tile, block: blockName, face: face || "side" }).then(j => {
    if (!j || !j.ok) { glog("ERROR", "Adopting " + name + " on " + tile + " failed: " + (j && j.error || "no answer")); say("Couldn't adopt: " + (j && j.error || "no answer"), true); return { ok: false }; }
    BF.adoptedTextures = BF.adoptedTextures || {};
    BF.adoptedTextures[tile] = { rgba: j.rgba, texture: name, block: blockName, face };
    E().setPixels(tile, null);   // the game's tile is now the adopted one, in every world
    delete st.versions[tile];
    glog("INFO", "Adopted texture " + name + " for " + tile + " (" + blockName + ", " + (face || "side") + ") in every world" + (j.warning ? ": " + j.warning : ""));
    say("Adopted " + name + " for " + blockName + " in every world" + (j.warning ? " (" + j.warning + ")" : "") + ". Commit sandbox/adopted.json and adopted.js to keep it in the repo.");
    st.adoptFor = null;
    return library().then(() => j);
  });
}
function unadopt(tile) {
  return call("sandbox/api/texture/unadopt", { tile }).then(j => {
    if (!j || !j.ok) { glog("ERROR", "Unadopting " + tile + " failed: " + (j && j.error || "no answer")); say("Couldn't unadopt: " + (j && j.error || "no answer"), true); return { ok: false }; }
    if (BF.adoptedTextures) delete BF.adoptedTextures[tile];
    E().setPixels(tile, null);
    delete st.versions[tile];
    glog("INFO", "Unadopted the texture on " + tile + ": the game's own tile is back");
    say("The game's own " + tile + " is back");
    return library().then(() => j);
  });
}
// outside a sandbox world, every edited tile goes back to the game's (adopted ones are the game's now)
function revertAll() {
  const ed = E().edited();
  for (const t of ed) E().setPixels(t, null);
  st.versions = {}; st.history = {};
  if (ed.length) glog("INFO", "Sandbox textures put back to the game's tiles (" + ed.length + ") outside the sandbox");
  return ed.length;
}
setInterval(() => { try { if (BF.textures && BF.textures.edit && E().edited().length && !(BF.sandbox && BF.sandbox.on())) revertAll(); } catch (e) { /* the atlas isn't up yet */ } }, 1000);

// ---------------------------------------------------------------- the panel
const css = `
.bfx-wrap{position:fixed;top:12px;right:12px;bottom:12px;width:min(420px,calc(100vw - 24px));display:none;z-index:40}
.bfx-wrap.open{display:block}
.bfx{height:100%;overflow:auto;background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font:12px var(--mono);color:var(--ink);box-sizing:border-box}
.bfx [hidden]{display:none!important}
.bfx h3{margin:0;font:13px var(--display);letter-spacing:.04em;display:flex;gap:8px;align-items:center}.bfx h3 .g{flex:1}
.bfx h4{margin:4px 0 0;font:12px var(--display);color:var(--muted)}
.bfx .m{color:var(--muted);white-space:pre-wrap}.bfx .m.bad{color:var(--danger)}
.bfx textarea,.bfx input,.bfx select{font:12px var(--mono);padding:5px 7px;color:var(--ink);background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px;box-sizing:border-box}
.bfx textarea{width:100%;min-height:52px;resize:vertical}
.bfx .r{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bfx button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:4px 9px;cursor:pointer}
.bfx button:hover{background:rgba(127,191,77,.38)}.bfx button:disabled{opacity:.45;cursor:default}.bfx button.on{background:rgba(127,191,77,.55)}
.bfx .tiles{display:flex;gap:8px}.bfx .tiles div{display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;padding:3px;border:1px solid transparent;border-radius:3px}
.bfx .tiles div.sel{border-color:var(--accent)}.bfx canvas{width:96px;height:96px;image-rendering:pixelated;background:rgba(0,0,0,.3)}
.bfx .vl div{display:flex;gap:6px;align-items:center;padding:2px 4px;border-radius:3px}.bfx .vl div.sel{background:rgba(127,191,77,.18)}
.bfx .vl canvas{width:24px;height:24px}.bfx .vl span.s{flex:1;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
function buildPanel() {
  if (st.el) return;
  const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  const r = st.el = document.createElement("div");
  r.className = "bfx-wrap";
  r.innerHTML = `<div class="bfx" role="dialog" aria-label="Texture studio"><h3><span class="g">Texture studio</span><button data-a="close">Close</button></h3>` +
    `<div class="m bfx-off"></div><div class="bfx-on" hidden style="display:contents"><div class="bfx-block"></div><div class="tiles"></div><div class="r bfx-faces"></div><div class="m bfx-note"></div>` +
    `<div class="r bfx-cfg"></div><textarea placeholder="What to change: mossier, with gold veins, a red brick pattern..."></textarea><div class="r bfx-send"></div><div class="m bfx-msg"></div>` +
    `<h4>Versions</h4><div class="vl bfx-vers"></div><h4>Library</h4><div class="r"><input data-a="name" placeholder="name" style="flex:1"><button data-a="save">Save</button></div>` +
    `<div class="vl bfx-lib"></div><div class="bfx-adopt"></div><h4>Used in all worlds</h4><div class="vl bfx-adopted"></div></div></div>`;
  (document.getElementById("ui") || document.body).appendChild(r);
  r.addEventListener("click", onClick);
  r.addEventListener("change", e => {
    const a = e.target.dataset.a;
    if (a === "provider") { st.provider = e.target.value; try { localStorage.setItem(PROV_KEY, st.provider); } catch (err) { /* not kept */ } refreshStatus(); }
    if (a === "model") { st.model = e.target.value; try { localStorage.setItem(MODEL_KEY, st.model); } catch (err) { /* not kept */ } }
  });
}
function onClick(e) {
  const b = e.target.closest("[data-a]");
  if (!b || b.tagName === "SELECT" || b.tagName === "INPUT" || b.disabled) return;
  const a = b.dataset.a, q = sel => st.el.querySelector(sel);
  if (a === "close") close();
  else if (a === "face") { if (st.comparing) compare(false); st.face = b.dataset.face; render(); }
  else if (a === "send") { const t = q("textarea"); request(t.value).then(v => { if (v) t.value = ""; render(); }); }
  else if (a === "undo") { undo(); render(); }
  else if (a === "compare") compare(!st.comparing);
  else if (a === "restore") restore(b.dataset.tile, +b.dataset.n);
  else if (a === "save") save(q('[data-a="name"]').value);
  else if (a === "lapply") applyLibrary(b.dataset.name);
  else if (a === "ladopt") { st.adoptFor = b.dataset.name; render(); }
  else if (a === "adoptgo") adopt(st.adoptFor, q('[data-a="ablock"]').value, q('[data-a="aface"]').value);
  else if (a === "adoptx") { st.adoptFor = null; render(); }
  else if (a === "unadopt") unadopt(b.dataset.tile);
}
function say(t, bad) { st.msg = t; st.bad = !!bad; if (st.el) { const m = st.el.querySelector(".bfx-msg"); if (m) { m.textContent = t; m.classList.toggle("bad", !!bad); } } }
function draw(cv, rgba) { if (!cv || !rgba) return; cv.width = cv.height = TS; cv.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), TS, TS), 0, 0); }
function render() {
  if (!st.el || !st.open) return;
  const q = sel => st.el.querySelector(sel), S = st.status, off = q(".bfx-off"), on = q(".bfx-on");
  const ready = !!(S && S.providers.some(p => p.configured));
  on.hidden = !ready; off.hidden = ready;
  if (!S) { off.textContent = "Checking for the texture studio's local server..."; off.classList.remove("bad"); return; }
  if (!ready) {
    off.classList.add("bad");
    off.textContent = S.offline ? "The texture studio needs the game served by its local server: start it with ./run.sh (node debug/server.js) and open http://localhost:8000."
      : "No texture provider is set up: " + S.providers.map(p => p.label + ": " + p.error).join("; ") + ". For Claude, set ANTHROPIC_API_KEY (or ~/.config/blockfield/anthropic-key), run npm install in debug/, and restart the server.";
    return;
  }
  const f = st.block != null ? faces(st.block) : null, b = st.block != null ? BF.blocks[st.block] : null;
  q(".bfx-block").innerHTML = b ? `<b>${esc(b.label || b.name)}</b> <span class="m">(${esc(b.name)})</span>` : `<span class="m bad">Look at a block and press K again.</span>`;
  const tiles = q(".tiles");
  tiles.innerHTML = f ? Object.entries(f).map(([k, t]) => `<div data-a="face" data-face="${k}" class="${st.face === k || st.face === "all" ? "sel" : ""}"><canvas data-t="${esc(t)}"></canvas><span class="m">${k}</span></div>`).join("") : "";
  tiles.querySelectorAll("canvas").forEach(cv => draw(cv, E().pixels(cv.dataset.t)));
  q(".bfx-faces").innerHTML = f ? ["top", "side", "bottom"].concat(f.front ? ["front"] : []).concat(["all"]).map(k => `<button data-a="face" data-face="${k}" class="${st.face === k ? "on" : ""}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("") +
    `<button data-a="undo">Undo</button><button data-a="compare" class="${st.comparing ? "on" : ""}" title="Show the game's own tile on every block, to compare">${st.comparing ? "Showing original" : "Compare"}</button>` : "";
  const ts = f ? tilesFor(st.face) : [], notes = [];
  for (const t of ts) { const e = E().editable(t); if (!e.ok) notes.push(t + ": " + e.why); else if (e.tinted) notes.push(t + " is tinted by the biome: it is edited grey and the " + e.tint + " colour is added in the world."); }
  q(".bfx-note").textContent = notes.join("\n");
  const ps = S.providers.filter(p => p.configured), cp = ps.find(p => p.name === st.provider);
  q(".bfx-cfg").innerHTML = `<select data-a="provider">${ps.map(p => `<option value="${esc(p.name)}"${p.name === st.provider ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select>` +
    `<select data-a="model">${(cp ? cp.models : []).map(m => `<option${m === st.model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>` +
    `<span class="m">$${(+S.hour || 0).toFixed(3)} of $${S.hourCap} this hour</span>`;
  q(".bfx-send").innerHTML = `<button data-a="send"${st.busy || !ts.length ? " disabled" : ""}>${st.busy ? "Waiting..." : "Change " + st.face}</button>`;
  say(st.msg, st.bad);
  const sel = ts[0];
  q(".bfx-vers").innerHTML = sel ? vers(sel).slice().reverse().map(v => `<div class="${(vers(sel).cur || 0) === v.n ? "sel" : ""}"><canvas data-v="${v.n}"></canvas><b>${v.n ? "v" + v.n : "game"}</b><span class="s">${esc(v.request || v.src)}</span>` +
    `<button data-a="restore" data-tile="${esc(sel)}" data-n="${v.n}">${v.n ? "Restore" : "Original"}</button></div>`).join("") : "";
  q(".bfx-vers").querySelectorAll("canvas").forEach(cv => draw(cv, vers(sel).find(v => v.n === +cv.dataset.v).rgba));
  q(".bfx-lib").innerHTML = st.lib.length ? st.lib.map(n => `<div><span class="s">${esc(n)}</span><button data-a="lapply" data-name="${esc(n)}">Apply</button><button data-a="ladopt" data-name="${esc(n)}">Use in all worlds</button></div>`).join("") : `<span class="m">No saved textures.</span>`;
  q(".bfx-adopt").innerHTML = st.adoptFor ? `<div class="r"><span class="m">Use ${esc(st.adoptFor)} in every world on</span><input data-a="ablock" value="${esc(b ? b.name : "")}" style="width:130px"><select data-a="aface">${["side", "top", "bottom", "front"].map(k => `<option${k === (st.face === "all" ? "side" : st.face) ? " selected" : ""}>${k}</option>`).join("")}</select><button data-a="adoptgo">Adopt</button><button data-a="adoptx">Cancel</button></div>` : "";
  q(".bfx-adopted").innerHTML = st.adopted.length ? st.adopted.map(r => `<div><span class="s">${esc(r.texture)} on ${esc(r.tile)} (${esc(r.block || "?")}, ${esc(r.face || "?")})</span><button data-a="unadopt" data-tile="${esc(r.tile)}">Unadopt</button></div>`).join("") : `<span class="m">None.</span>`;
}
function canOpen() { const p = BF.player; return !!(p && (!p.canOpenUI || p.canOpenUI())); }
function open() {
  if (st.open) return true;
  if (!BF.sandbox || !BF.sandbox.on()) { if (BF.player && BF.player.actionBar) BF.player.actionBar("The texture studio works in sandbox worlds"); return false; }
  if (!canOpen()) return false;
  pickTarget();
  buildPanel();
  st.open = true;
  try { if (BF.player.uiOpen) BF.player.uiOpen(); } catch (e) { console.error(e); }
  st.el.classList.add("open");
  render();
  refreshStatus().then(library);
  return true;
}
function close() {
  if (!st.open) return;
  st.open = false;
  st.el.classList.remove("open");
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
// K opens it on the block in view (sandbox worlds); while open, keys go to its fields. Capture phase at load time, like js/coords.js.
addEventListener("keydown", e => {
  if (st.open) {
    e.stopImmediatePropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if ((e.key === "Enter" || e.key === "NumpadEnter") && e.target && e.target.tagName === "TEXTAREA" && !e.shiftKey) { e.preventDefault(); onClick({ target: st.el.querySelector('[data-a="send"]') }); return; }
    if (e.key === "Tab" || e.key === "F3" || e.key === "F1") { e.preventDefault(); return; }
    return;
  }
  if (e.code !== "KeyK" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!BF.sandbox || !BF.sandbox.on() || !canOpen() || !(BF.player && BF.player.menu && !BF.player.menu())) return;
  if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  open();
}, true);

const S = BF.textureStudio = {
  open, close, isOpen: () => st.open, state: st, api, request, apply, undo, restore, compare, save, library, applyLibrary, adopt, unadopt, paintRecipe, faces, revertAll,
  tilesFor, setBlock: id => { st.block = id; render(); }, refreshStatus, RECIPE_OPS, b64, unb64,
};
})();
