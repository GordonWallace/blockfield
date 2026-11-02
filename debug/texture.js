// The sandbox texture studio's server side (spec idea-052): the page's texture requests go to a provider (debug/providers/<name>.js,
// any company's model: Claude by default), whose answer comes back as pixels or a recipe; saves textures to sandbox/textures/ and keeps
// the adoption record (sandbox/adopted.json, plus sandbox/adopted.js, which the game loads in every world: js/textures.js).
// Routes on the game port (debug/sandbox.js hands them over; posts: this computer, the game's own origin, JSON):
//   GET  /sandbox/api/texture/status  -> { providers: [{name, label, models, model, configured, error}], provider, hour, hourCap }
//   POST /sandbox/api/texture         { provider?, model?, request, tile (base64 32x32 RGBA), screenshot? (base64 PNG), history, face, block,
//                                       tileName, tinted } -> { kind: "pixels", rgba (base64), from: "grid" | "image", fixes, notes }
//                                       | { kind: "recipe", steps, notes } | { error, refused? }
//   POST /sandbox/api/texture/save    { name, rgba, meta } -> writes sandbox/textures/<name>.png and <name>.json -> { ok, png, json }
//   POST /sandbox/api/texture/adopt   { name, tile, block, face } -> { ok, warning? }   (a newer record for the same tile replaces the older)
//   POST /sandbox/api/texture/unadopt { tile } -> { ok }
// A grid with the wrong size or unknown symbols is fixed where it can be (rows and columns padded or cut, unknown symbols to the
// commonest colour) and the fixes listed; past FIX_LIMIT it is refused and the provider asked once more with the reasons. An image is
// fitted to 32x32: downscaled, reduced to at most 32 colours, its edges blended so it tiles.
// The spend caps and the API calls panel are debug/claude.js's (meter), for every provider; a provider reports each call's cost.
"use strict";
const fs = require("fs"), path = require("path");
const png = require("./png.js"), sandbox = require("./sandbox.js"), claude = require("./claude.js");

const TS = 32, TILE_BYTES = TS * TS * 4, MAX_BODY = 4 * 1024 * 1024, FIX_LIMIT = 0.25;
const ROOT = sandbox.ROOT, TEX = path.join(ROOT, "textures"), ADOPTED = path.join(ROOT, "adopted.json"), ADOPTED_JS = path.join(ROOT, "adopted.js");
const json = sandbox.json, m = claude.meter;

// ---------------------------------------------------------------- providers
const providers = new Map();
function loadProviders() {
  const dir = path.join(__dirname, "providers");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".js")).sort(); } catch (e) { /* none */ }
  for (const f of files) {
    try { const p = require(path.join(dir, f)); if (p && p.name && p.name !== "template" && typeof p.texture === "function") providers.set(p.name, p); }
    catch (e) { console.error("[texture] provider " + f + " didn't load: " + e.message); }
  }
}
loadProviders();
const DEFAULT = () => (providers.has(process.env.BF_TEXTURE_PROVIDER) ? process.env.BF_TEXTURE_PROVIDER : providers.has("anthropic") ? "anthropic" : [...providers.keys()][0]);
const addProvider = p => providers.set(p.name, p);   // tests
function status() {
  return { providers: [...providers.values()].map(p => { const c = p.configured(); return { name: p.name, label: p.label || p.name, models: p.models, model: p.model, configured: c === true, error: c === true ? null : c }; }),
    provider: DEFAULT(), hour: +m.hourSpend().toFixed(4), hourCap: m.PER_HOUR_USD };
}

// ---------------------------------------------------------------- results to pixels
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function colour(c) {
  if (String(c).toLowerCase() === "transparent") return [0, 0, 0, 0];
  if (!HEX.test(String(c))) return null;
  let h = String(c).slice(1);
  if (h.length === 3) h = h.split("").map(x => x + x).join("");
  const n = [0, 2, 4, 6].map(i => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
  return n;
}
// grid -> {rgba, fixes} or {error}
function gridPixels(g) {
  const fixes = [], pal = new Map();
  for (const e of (g.palette || []).slice(0, 64)) {
    const s = e && typeof e.symbol === "string" ? [...e.symbol][0] : null, c = e && colour(e.color);
    if (!s) continue;
    if (!c) { fixes.push(`colour ${JSON.stringify(e.color)} of "${s}" isn't a colour`); continue; }
    pal.set(s, c);
  }
  if (!pal.size) return { error: "the palette has no usable colours" };
  if (pal.size > 16) fixes.push(`${pal.size} colours (16 asked for)`);
  let rows = (g.rows || []).map(r => [...String(r)]);
  if (rows.length < 8) return { error: `only ${rows.length} rows (32 needed)` };
  let fixed = 0;
  if (rows.length !== TS) { fixes.push(`${rows.length} rows, ${rows.length > TS ? "cut" : "padded"} to 32`); fixed += Math.abs(rows.length - TS) * TS; }
  while (rows.length < TS) rows.push(rows[rows.length - 1].slice());
  rows = rows.slice(0, TS);
  const count = new Map();
  for (const r of rows) for (const s of r) if (pal.has(s)) count.set(s, (count.get(s) || 0) + 1);
  const common = [...count].sort((a, b) => b[1] - a[1])[0];
  const fallback = common ? common[0] : [...pal.keys()][0];
  let bad = 0, len = 0;
  const unknown = new Set();
  rows = rows.map(r => {
    if (r.length !== TS) { len++; fixed += Math.abs(r.length - TS); }
    while (r.length < TS) r.push(r.length ? r[r.length - 1] : fallback);
    return r.slice(0, TS).map(s => { if (pal.has(s)) return s; bad++; unknown.add(s); return fallback; });
  });
  if (len) fixes.push(`${len} rows not 32 symbols long, padded or cut`);
  if (bad) fixes.push(`${bad} cells with symbols not in the palette (${[...unknown].slice(0, 8).map(s => JSON.stringify(s)).join(", ")}) given the commonest colour`);
  fixed += bad;
  if (fixed > TILE_BYTES / 4 * FIX_LIMIT) return { error: "too much to fix: " + fixes.join("; ") };
  const rgba = new Uint8ClampedArray(TILE_BYTES);
  rows.forEach((r, y) => r.forEach((s, x) => rgba.set(pal.get(s), (y * TS + x) * 4)));
  return { rgba, fixes };
}
// any-size image -> 32x32: area downscale, at most 32 colours, edges blended into the opposite edges so it tiles
function fitImage(buf) {
  const d = png.decode(buf);
  let rgba = png.resize(d.rgba, d.w, d.h, TS, TS);
  const fixes = [d.w + "x" + d.h + " image fitted to 32x32"];
  // edges first (so the colour limit holds on the blended pixels too)
  const out = new Uint8ClampedArray(rgba), B = 3;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const ex = Math.min(x, TS - 1 - x), ey = Math.min(y, TS - 1 - y);
    if (ex >= B && ey >= B) continue;
    const ox = TS - 1 - x, oy = TS - 1 - y, i = (y * TS + x) * 4;
    const tx = ex < B ? 0.5 * (1 - ex / B) : 0, ty = ey < B ? 0.5 * (1 - ey / B) : 0;
    for (let c = 0; c < 4; c++) {
      let v = rgba[i + c];
      if (tx) v = v * (1 - tx) + rgba[(y * TS + ox) * 4 + c] * tx;
      if (ty) v = v * (1 - ty) + rgba[(oy * TS + x) * 4 + c] * ty;
      out[i + c] = v;
    }
  }
  fixes.push("edges blended so it tiles");
  rgba = out;
  // colours: 5 bits a channel, then the 32 commonest; the rest to the nearest of those
  const key = i => ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3), n = new Map();
  for (let i = 0; i < rgba.length; i += 4) n.set(key(i), (n.get(key(i)) || 0) + 1);
  if (n.size > 32) {
    const keep = [...n].sort((a, b) => b[1] - a[1]).slice(0, 32).map(([k]) => [(k >> 10) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4]);
    for (let i = 0; i < rgba.length; i += 4) {
      let best = 0, bd = Infinity;
      keep.forEach((c, j) => { const dd = (c[0] - rgba[i]) ** 2 + (c[1] - rgba[i + 1]) ** 2 + (c[2] - rgba[i + 2]) ** 2; if (dd < bd) { bd = dd; best = j; } });
      rgba[i] = keep[best][0]; rgba[i + 1] = keep[best][1]; rgba[i + 2] = keep[best][2];
    }
    fixes.push("reduced to 32 colours");
  }
  return { rgba, fixes };
}
const RECIPE_OPS = new Set(["fill", "noise", "stone", "cobble", "bricks", "planks", "bark", "log_top", "leaves", "ore_specks", "moss", "frame", "rect", "pixels", "relief"]);
function checkRecipe(steps) {
  if (!Array.isArray(steps) || !steps.length) return { error: "the recipe has no steps" };
  const out = [], fixes = [];
  for (const s of steps.slice(0, 40)) {
    if (!s || !RECIPE_OPS.has(s.op)) { fixes.push("unknown step " + JSON.stringify(s && s.op) + " left out"); continue; }
    const colors = (s.colors || []).filter(c => colour(c));
    if ((s.colors || []).length !== colors.length) fixes.push("a colour in step " + s.op + " isn't a colour");
    out.push({ op: s.op, colors, amount: +s.amount || 0, x: s.x | 0, y: s.y | 0, w: s.w | 0, h: s.h | 0, pixels: (s.pixels || []).slice(0, 1024).filter(p => p && colour(p.color)).map(p => ({ x: p.x | 0, y: p.y | 0, color: p.color })) });
  }
  if (!out.length) return { error: "no step of the recipe is usable: " + fixes.join("; ") };
  return { steps: out, fixes };
}

// ---------------------------------------------------------------- a request
const b64 = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
function enlarged(rgba) {
  const S = 8, big = new Uint8ClampedArray(TS * S * TS * S * 4);
  for (let y = 0; y < TS * S; y++) for (let x = 0; x < TS * S; x++) big.set(rgba.subarray(((y >> 3) * TS + (x >> 3)) * 4, ((y >> 3) * TS + (x >> 3)) * 4 + 4), (y * TS * S + x) * 4);
  return png.encode(TS * S, TS * S, big).toString("base64");
}
async function request(body) {
  const prov = providers.get(body.provider || DEFAULT());
  if (!prov) return [400, { error: "no provider called " + body.provider }];
  const c = prov.configured();
  if (c !== true) return [503, { error: c }];
  const text = String(body.request || "").trim().slice(0, 2000);
  let tile;
  try { tile = new Uint8ClampedArray(Buffer.from(String(body.tile || ""), "base64")); } catch (e) { tile = null; }
  if (!text || !tile || tile.length !== TILE_BYTES) return [400, { error: "bad texture request" }];
  const model = body.model || prov.model;
  if (prov.models && !prov.models.includes(model)) return [400, { error: "unknown model " + model + " for " + prov.name }];
  const limited = m.allow();
  if (limited) return [429, { error: limited, capped: /spend cap/.test(limited) }];
  const input = { request: text, tile: body.tile, screenshot: typeof body.screenshot === "string" && body.screenshot.length < 3e6 ? body.screenshot.replace(/^data:image\/png;base64,/, "") : null,
    history: (Array.isArray(body.history) ? body.history : []).slice(-12).map(h => String(h).slice(0, 400)), face: String(body.face || "all"), block: String(body.block || "").slice(0, 64),
    tileName: String(body.tileName || "").slice(0, 64), tinted: body.tinted ? String(body.tinted) : null };
  const rec = m.startCall("texture", prov.name + " " + model, {}, "", [{ role: "user", content: text }], null);
  const ctx = { model, tilePng: enlarged(tile), feedback: null, meter: m };
  let out = null, problems = [];
  try {
    for (let attempt = 1; attempt <= 2 && !out; attempt++) {
      const r = await prov.texture(input, ctx), L = r.log || {};
      if (attempt === 1) { rec.system = L.system || ""; rec.params = L.params || {}; rec.messages = JSON.parse(JSON.stringify(L.messages || rec.messages)); }
      let fixed = null, why = null;
      if (r.kind === "refused") { m.roundDone(rec, L.reply || { content: [] }, L.ms || 0, null, L.cost); m.endCall(rec, "refused"); return [200, { refused: true, error: prov.label + " declined the request" }]; }
      if (r.kind === "error") why = r.error;
      else if (r.kind === "grid") { fixed = gridPixels(r); if (fixed.error) why = fixed.error; else out = { kind: "pixels", from: "grid", rgba: b64(fixed.rgba), fixes: fixed.fixes, notes: r.notes || "" }; }
      else if (r.kind === "image") {
        try { fixed = fitImage(Buffer.isBuffer(r.png) ? r.png : Buffer.from(String(r.png || ""), "base64")); out = { kind: "pixels", from: "image", rgba: b64(fixed.rgba), fixes: fixed.fixes, notes: r.notes || "" }; }
        catch (e) { why = "the image couldn't be read: " + e.message; }
      } else if (r.kind === "recipe") { fixed = checkRecipe(r.steps); if (fixed.error) why = fixed.error; else out = { kind: "recipe", steps: fixed.steps, fixes: fixed.fixes, notes: r.notes || "" }; }
      else why = "an answer of unknown kind " + JSON.stringify(r.kind);
      const next = !out && attempt < 2 ? { role: "user", content: "Problems: " + why + ". Send a corrected answer." } : null;
      m.roundDone(rec, L.reply || { content: [{ type: "text", text: "[" + r.kind + "]" }], usage: {} }, L.ms || 0, next, L.cost);
      if (!out) { problems.push(why); ctx.feedback = why; }
    }
    if (!out) { m.endCall(rec, "problems", { problems }); return [200, { error: "the answer couldn't be used: " + problems.join("; ") }]; }
    m.endCall(rec, out.fixes.length ? "problems" : "ok", { problems: out.fixes });
    return [200, Object.assign(out, { provider: prov.name, model, cost: rec.cost })];
  } catch (e) {
    const msg = e && e.message || String(e);
    m.endCall(rec, "error", { error: msg });
    return [e && e.status === 400 ? 400 : 502, { error: prov.label + ": " + msg }];
  }
}

// ---------------------------------------------------------------- library and adoption
function readAdopted() { try { const a = JSON.parse(fs.readFileSync(ADOPTED, "utf8")); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
// adopted.json -> adopted.js (the pixels the game loads in every world, by tile; the newest record for a tile wins)
function writeAdopted(list) {
  const by = {};
  for (const r of list) {
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(TEX, r.texture + ".json"), "utf8")); } catch (e) { continue; }
    if (t && t.rgba) by[r.tile] = { rgba: t.rgba, texture: r.texture, block: r.block || null, face: r.face || null };
  }
  fs.writeFileSync(ADOPTED, JSON.stringify(list, null, 1) + "\n");
  fs.writeFileSync(ADOPTED_JS, "// Sandbox textures adopted for every world (spec idea-052): written by the local server (debug/texture.js) from sandbox/adopted.json\n" +
    "// when a texture is adopted or unadopted in the texture studio. Each entry overrides one tile by name (js/textures.js paintTile), the\n" +
    "// way js/faithful.js does: {tile: {rgba: base64 32x32 RGBA, texture, block, face}}. Commit this file with adopted.json to keep them.\n" +
    "globalThis.BF = globalThis.BF || {}; BF.adoptedTextures = " + JSON.stringify(by) + ";\n");
  return by;
}
function save(b) {
  if (!sandbox.NAME.test(String(b.name || ""))) return [400, { error: "a name is letters, digits, - and _ (64 at most)" }];
  let rgba;
  try { rgba = new Uint8ClampedArray(Buffer.from(String(b.rgba || ""), "base64")); } catch (e) { rgba = null; }
  if (!rgba || rgba.length !== TILE_BYTES) return [400, { error: "the texture must be 32x32 RGBA" }];
  const meta = b.meta && typeof b.meta === "object" ? b.meta : {};
  const rec = { format: "bf-texture-1", name: b.name, face: meta.face || null, block: meta.block || null, tile: meta.tile || null, provider: meta.provider || null,
    model: meta.model || null, history: Array.isArray(meta.history) ? meta.history.slice(-50) : [], recipe: meta.recipe || null, grid: meta.grid || null, rgba: b.rgba, saved: new Date().toISOString() };
  fs.mkdirSync(TEX, { recursive: true });
  fs.writeFileSync(path.join(TEX, b.name + ".png"), png.encode(TS, TS, rgba));
  fs.writeFileSync(path.join(TEX, b.name + ".json"), JSON.stringify(rec, null, 1) + "\n");
  return [200, { ok: true, png: "sandbox/textures/" + b.name + ".png", json: "sandbox/textures/" + b.name + ".json" }];
}
function adopt(b) {
  if (!sandbox.NAME.test(String(b.name || "")) || !fs.existsSync(path.join(TEX, b.name + ".json"))) return [400, { error: "no saved texture called " + b.name }];
  if (!/^[\w]{1,64}$/.test(String(b.tile || ""))) return [400, { error: "a target tile is needed" }];
  let list = readAdopted();
  const old = list.filter(r => r.tile === b.tile);
  list = list.filter(r => r.tile !== b.tile);
  list.push({ texture: b.name, tile: b.tile, block: b.block || null, face: b.face || null, at: new Date().toISOString() });
  const by = writeAdopted(list);
  return [200, { ok: true, rgba: by[b.tile] && by[b.tile].rgba, warning: old.length ? "replaced the earlier adoption of " + old.map(r => r.texture).join(", ") + " on " + b.tile : null }];
}
function unadopt(b) {
  const list = readAdopted(), left = list.filter(r => r.tile !== b.tile);
  if (left.length === list.length) return [400, { error: "nothing is adopted on " + b.tile }];
  writeAdopted(left);
  return [200, { ok: true }];
}

sandbox.route((req, res, rel) => {
  if (!rel.startsWith("/sandbox/api/texture")) return false;
  if (rel === "/sandbox/api/texture/status" && req.method === "GET") { json(res, 200, status()); return true; }
  const run = { "/sandbox/api/texture": request, "/sandbox/api/texture/save": save, "/sandbox/api/texture/adopt": adopt, "/sandbox/api/texture/unadopt": unadopt }[rel];
  if (!run || req.method !== "POST") { json(res, 404, { error: "no such texture call" }); return true; }
  sandbox.readJson(req, res, MAX_BODY, b => {
    Promise.resolve().then(() => run(b || {})).then(([code, o]) => json(res, code, o), e => json(res, 500, { error: String(e && e.message || e) }));
  });
  return true;
});

module.exports = { status, request, save, adopt, unadopt, gridPixels, fitImage, checkRecipe, addProvider, providers, readAdopted, TS };
