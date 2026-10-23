// Minecraft-style command line ("/" opens it prefilled with "/", T opens plain chat). Single player with cheats on:
// commands run in survival too and mark the saved world's meta with `cheats: true`.
// While open, every key goes to the text box (window capture listener registered at load time, before the inventory's),
// the pointer lock is released through BF.player.uiOpen() and re-requested by uiClose(); player.js treats the open
// command line like an open inventory (no movement, no clicks, no hotkeys).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const HIST_KEY = "blockfield.cmdHistory", HIST_MAX = 30, LOG_MAX = 100, FADE_S = 10, MAX_FILL = 32768, MAX_GIVE = 64 * 36;
const PLAYER = "Player";

// ---------- CSS / DOM ----------
const css = `
.bfc{position:fixed;left:0;right:0;bottom:0;pointer-events:none!important;z-index:40;font:13px/1.4 var(--mono)}
.bfc-log{position:absolute;left:8px;bottom:calc(96px + env(safe-area-inset-bottom,0px));width:min(560px,calc(100vw - 16px));display:flex;flex-direction:column;justify-content:flex-end;max-height:40vh;overflow:hidden}
.bfc.open .bfc-log{bottom:calc(46px + env(safe-area-inset-bottom,0px));overflow-y:auto;pointer-events:auto}
.bfc-line{background:rgba(0,0,0,.45);color:#fff;padding:1px 6px;white-space:pre-wrap;word-break:break-word;text-shadow:1px 1px 0 #000a;transition:opacity .9s}
.bfc-line.err{color:#ff6b5e}.bfc-line.ok{color:#d6d6d6}.bfc-line.info{color:#fff}.bfc-line.dim{color:#a9a9a9}.bfc-line.gold{color:#ffd35a}
.bfc-line.gone{display:none}.bfc-line.fade{opacity:0}
.bfc.open .bfc-line.gone,.bfc.open .bfc-line.fade{display:block;opacity:1}
.bfc-bar{position:absolute;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));display:none;pointer-events:auto}
.bfc.open .bfc-bar{display:block}
.bfc-input{display:block;width:100%;box-sizing:border-box;background:rgba(0,0,0,.8);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:2px;padding:7px 8px;font:14px var(--mono);outline:none;caret-color:#fff}
.bfc-input:focus{border-color:rgba(255,255,255,.5)}
.bfc-sug{position:absolute;bottom:100%;margin-bottom:3px;background:rgba(0,0,0,.82);border:1px solid rgba(255,255,255,.12);min-width:120px;max-width:min(520px,calc(100vw - 16px));display:none;font:13px/1.45 var(--mono)}
.bfc-sug.on{display:block}
.bfc-sug div{padding:0 8px;color:#a9a9a9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bfc-sug div.sel{color:#ffd35a}
.bfc-sug .hint{color:#8d8d8d;font-style:italic}
`;
let root, logEl, barEl, inputEl, sugEl, open = false;
const lines = [];        // {el, t}
function buildDOM() {
  if (root) return;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  root = document.createElement("div"); root.className = "bfc";
  root.innerHTML = `<div class="bfc-log" aria-live="polite"></div><div class="bfc-bar"><div class="bfc-sug"></div>` +
    `<input class="bfc-input" type="text" maxlength="256" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Command line"></div>`;
  (document.getElementById("ui") || document.body).appendChild(root);
  logEl = root.querySelector(".bfc-log"); barEl = root.querySelector(".bfc-bar");
  inputEl = root.querySelector(".bfc-input"); sugEl = root.querySelector(".bfc-sug");
  inputEl.addEventListener("input", () => { tabState = null; histIdx = -1; refreshSuggestions(); });
  sugEl.addEventListener("mousedown", e => {
    const d = e.target.closest("[data-i]"); if (!d) return;
    e.preventDefault(); applyCandidate(+d.dataset.i); inputEl.focus();
  });
  setInterval(fadeTick, 250);
}

// ---------- chat log ----------
function print(text, kind = "info") {
  buildDOM();
  for (const part of String(text).split("\n")) {
    const el = document.createElement("div");
    el.className = "bfc-line " + kind;
    el.textContent = part;
    logEl.appendChild(el);
    lines.push({ el, t: performance.now() });
  }
  while (lines.length > LOG_MAX) lines.shift().el.remove();
  if (open) logEl.scrollTop = logEl.scrollHeight;
  fadeTick();
}
function fadeTick() {
  const now = performance.now();
  for (const l of lines) {
    const age = (now - l.t) / 1000;
    l.el.classList.toggle("fade", age > FADE_S - 1);
    l.el.classList.toggle("gone", age > FADE_S);
  }
}

// ---------- history (localStorage, best effort) ----------
function loadHistory() {
  try { const a = JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); return Array.isArray(a) ? a.filter(s => typeof s === "string").slice(-HIST_MAX) : []; } catch (_) { return []; }
}
function saveHistory() { try { localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(-HIST_MAX))); } catch (_) {} }
let history = loadHistory(), histIdx = -1, draft = "";
function pushHistory(s) {
  if (history[history.length - 1] !== s) history.push(s);
  if (history.length > HIST_MAX) history = history.slice(-HIST_MAX);
  saveHistory();
}
function histNav(d) {
  if (!history.length) return;
  if (histIdx === -1) { if (d > 0) return; draft = inputEl.value; histIdx = history.length; }
  histIdx += d;
  if (histIdx < 0) histIdx = 0;
  if (histIdx >= history.length) { histIdx = -1; setInput(draft); return; }
  setInput(history[histIdx]);
}
function setInput(v) { inputEl.value = v; const n = v.length; try { inputEl.setSelectionRange(n, n); } catch (_) {} tabState = null; refreshSuggestions(); }

// ---------- open / close ----------
const P = () => BF.player || {};
function canOpen() {
  const p = P();
  if (p.canOpenUI) return p.canOpenUI();
  const inv = BF.inventory;
  return !!(p.menu && !p.menu() && !p.dead && !(inv && inv.isOpen && inv.isOpen()));
}
function openChat(prefill) {
  buildDOM();
  open = true;                                   // before releasing the lock: player.js must not re-lock or pause
  try { if (P().uiOpen) P().uiOpen(); } catch (e) { console.error(e); }
  root.classList.add("open");
  histIdx = -1; tabState = null;
  setInput(prefill || "");
  inputEl.focus();
  logEl.scrollTop = logEl.scrollHeight;
}
function closeChat() {
  if (!open) return;
  open = false;
  root.classList.remove("open");
  sugEl.classList.remove("on");
  inputEl.blur();
  fadeTick();
  try { if (P().uiClose) P().uiClose(); } catch (e) { console.error(e); }
}
function submit() {
  const text = inputEl.value.trim();
  closeChat();
  if (!text) return;
  pushHistory(text);
  if (text[0] === "/") execute(text);
  else print(`<${PLAYER}> ${text}`, "info");
}

addEventListener("keydown", e => {
  if (open) {
    e.stopImmediatePropagation();               // nothing reaches the game (movement, E, Q, digits, F3...)
    if (e.target !== inputEl) inputEl.focus();
    const k = e.key;
    if (k === "Enter" || k === "NumpadEnter") { e.preventDefault(); submit(); }
    else if (k === "Escape") { e.preventDefault(); closeChat(); }
    else if (k === "Tab") { e.preventDefault(); complete(e.shiftKey ? -1 : 1); }
    else if (k === "ArrowUp") { e.preventDefault(); if (sugEl.classList.contains("on") && tabState) complete(-1); else histNav(-1); }
    else if (k === "ArrowDown") { e.preventDefault(); if (sugEl.classList.contains("on") && tabState) complete(1); else histNav(1); }
    else if (k === "F3" || k === "F1") e.preventDefault();
    return;
  }
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const slash = e.key === "/" || e.code === "Slash" || e.code === "NumpadDivide";
  if ((slash || e.code === "KeyT") && canOpen()) {
    e.preventDefault(); e.stopImmediatePropagation();
    openChat(slash ? "/" : "");
  }
}, true);

// ---------- helpers ----------
class CmdError extends Error {}
const fail = m => { throw new CmdError(m); };
const norm = s => String(s == null ? "" : s).trim().toLowerCase().replace(/^minecraft:/, "").replace(/\[.*$/, "");
const pos = () => P().position || { x: 0, y: 0, z: 0 };
const fmt = v => (Math.round(v * 100) / 100).toString();
const W = () => BF.world;
function displayName(id) { try { return BF.itemName ? BF.itemName(id) : BF.items[id].name; } catch (_) { return String(id); } }

function parseNum(tok, what, { int = false, min = -Infinity, max = Infinity } = {}) {
  if (tok == null || tok === "") fail(`Expected ${what}`);
  const v = Number(tok);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) || !isFinite(v)) fail(`Invalid ${int ? "integer" : "number"} '${tok}' for ${what}`);
  if (int && !Number.isInteger(v)) fail(`Invalid integer '${tok}' for ${what}`);
  if (v < min) fail(`${int ? "Integer" : "Number"} must not be less than ${min}, found ${v}`);
  if (v > max) fail(`${int ? "Integer" : "Number"} must not be more than ${max}, found ${v}`);
  return v;
}
// Coordinates: absolute, "~" (relative) or "~n". block = true floors (block positions); else integers get +0.5 on x/z (centre).
function parseCoord(tok, base, axis, block) {
  if (tok == null || tok === "") fail(`Expected coordinate ${axis}`);
  if (tok[0] === "^") fail("Local coordinates (^) are not supported");
  if (tok[0] === "~") {
    const rest = tok.slice(1), off = rest === "" ? 0 : parseNum(rest, "coordinate " + axis);
    return block ? Math.floor(base + off) : base + off;
  }
  const v = parseNum(tok, "coordinate " + axis);
  if (block) return Math.floor(v);
  return axis !== "y" && /^[+-]?\d+$/.test(tok) ? v + 0.5 : v;
}
function parsePos(args, i, block) {
  const b = userFrame();
  if (args.length < i + 3) fail(b.f >= 0 ? "Incomplete position (expected u y v)" : "Incomplete position (expected x y z)");
  const hx = b.f >= 0 ? "u" : "x", hz = b.f >= 0 ? "v" : "z";
  return [parseCoord(args[i], b.x, hx, block) + b.ox, parseCoord(args[i + 1], b.y, "y", block), parseCoord(args[i + 2], b.z, hz, block) + b.oz];
}

// ---------- planet coordinates (spec r14-18) ----------
// Commands read and print u / v on the player's current face (BF.coords), never atlas x / z. Typed
// positions may run past the face's edges into the margin (the neighbouring faces unfolded around it, out to one face width), so
// "~10" works across an edge; they are resolved to the canonical point before anything is placed there.
const ucan = {};
// The frame typed coordinates are in: atlas = typed + (ox, oz); x / y / z are the player's own position in it (the ~ base).
function userFrame() {
  const p = pos(), c = BF.planet.canon(p.x, p.z, ucan);
  if (!c.off) return { f: c.f, ox: BF.planet.W * c.f + BF.planet.N, oz: BF.planet.N, x: c.u, y: p.y, z: c.v };
  return { f: -1, ox: 0, oz: 0, x: p.x, y: p.y, z: p.z };
}
// The world border: within the current face's square (the face plus its margin).
function checkBorder(x, z) {
  const f = userFrame().f;
  if (BF.planet.face(x, z) !== f || f < 0) fail(`Invalid position: off the planet (u and v must be between ${(-BF.planet.N).toLocaleString("en-US")} and ${(2 * BF.planet.N - 1).toLocaleString("en-US")} on this face)`);
}
// A position as the player reads it (BF.coords): "face 2  u 81,920  v 81,920  y 64".
const where = (x, y, z) => (BF.coords ? BF.coords.describe(x, y, z) : `${fmt(x)}, ${fmt(y)}, ${fmt(z)}`);
function whereBlock(x, y, z) {
  const c = BF.planet.canonCell(x, z, {});
  return c.off ? `${x}, ${y}, ${z}` : `face ${c.f}  u ${c.u.toLocaleString("en-US")}  v ${c.v.toLocaleString("en-US")}  y ${y}`;
}
// The canonical point of a typed one (a corner wedge resolves to the nearest point on a face), with the quarter turns q from the
// typed frame to the point's own: a yaw given in the typed frame is turned by q so the player faces the same way.
function landing(x, z) {
  const c = BF.planet.canon(x, z, {});
  return { x: c.x, z: c.z, q: (4 - c.turn) % 4 };
}
// The highest layer a teleport may reach: high enough to see the whole globe.
const tpMaxY = () => BF.SEA + 300000;
const isCoord = t => /^(~[+-]?(\d+\.?\d*|\.\d+)?|[+-]?(\d+\.?\d*|\.\d+))$/.test(t || "");

// Ticks: "1000", "1000t", "50s", "1d" (vanilla time units).
function parseTicks(tok) {
  const m = /^(\d+(?:\.\d+)?)([tsd]?)$/i.exec(tok || "");
  if (!m) fail(`Invalid time '${tok == null ? "" : tok}' (use ticks, or a number with t, s or d)`);
  const n = Math.round(+m[1] * ({ "": 1, t: 1, s: 20, d: 24000 })[m[2].toLowerCase()]);
  if (!(n <= 2147483647)) fail(`Time must not be more than 2147483647 ticks, found '${tok}'`);   // vanilla's int limit; more breaks the day counter
  return n;
}

// Item / block names (with or without "minecraft:"), a few vanilla aliases.
const ALIAS = {
  grass_block: "grass", oak_planks: "planks", wheat: "wheat_item", hay_block: "hay_bale", snow_block: "snow",
  porkchop: "raw_porkchop", beef: "raw_beef", cooked_beef: "steak", chicken: "raw_chicken", mutton: "raw_mutton", cod: "raw_cod",
  wall_torch: "wall_torch_north", tall_grass: "short_grass", grass_path: "dirt_path", sugar_cane_block: "sugar_cane",
};
// Own keys only: BF.B, BF.I and the tables here are plain objects, so a bare lookup of 'constructor' or 'toString' finds a function (bug-044).
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
function lookupName(n) {
  const B = BF.B || {}, I = BF.I || {};
  for (const k of [n, own(ALIAS, n), n + "_item"]) {
    if (!k) continue;
    if (own(I, k) != null) return I[k];
    if (own(B, k) != null) return B[k];
  }
  return null;
}
function resolveItem(tok) {
  const n = norm(tok);
  if (!n) fail("Expected an item");
  let id = n === "wheat" ? BF.I && BF.I.wheat_item : lookupName(n);
  if (id == null || id === 0 || !BF.items[id]) fail(`Unknown item '${tok}'`);
  const b = BF.items[id];
  if (b.isBlock && b.item != null && BF.items[b.item]) id = b.item;         // door/bed halves, wall torches, top slabs...
  else if (b.isBlock && typeof b.item === "string" && lookupName(b.item) != null) id = lookupName(b.item);
  return id;
}
function resolveBlock(tok) {
  const n = norm(tok);
  if (!n) fail("Expected a block");
  const B = BF.B || {};
  const a = own(ALIAS, n);
  const id = n === "air" ? 0 : own(B, n) != null ? B[n] : a && own(B, a) != null ? B[a] : null;
  if (id == null) {
    const it = lookupName(n);
    if (it != null && BF.items[it] && !BF.items[it].isBlock) fail(`'${tok}' is an item, not a block`);
    fail(`Unknown block '${tok}'`);
  }
  return id;
}
let nameCache = null;
function names() {
  if (nameCache) return nameCache;
  const items = [], blocks = [];
  for (const it of BF.items || []) {
    if (!it || !it.name) continue;
    if (it.isBlock) { blocks.push(it.name); if (!it.hidden && it.id !== 0) items.push(it.name); }
    else items.push(it.name);
  }
  return (nameCache = { items: items.sort(), blocks: blocks.sort() });
}
const mobTypes = () => (BF.mobs && BF.mobs.types) || [];

function markCheats() {
  try { if (BF.save && BF.save.current && !BF.save.current.cheats) BF.save.current.cheats = true; } catch (_) {}
}
function needLoaded(x, z) {
  if (!W().canonXZ(x, z)) return;   // a corner wedge: nothing there to load (writes there are refused)
  if (!W().isLoaded(x, z)) fail("That position is not loaded");
}
function surfaceY(x, z) {
  let h = W().isLoaded(x, z) ? W().heightAt(x, z) : BF.MIN_Y - 1;
  if (h < BF.MIN_Y && BF.worldgen && BF.worldgen.heightAt) h = BF.worldgen.heightAt(Math.floor(x), Math.floor(z));
  return h + 1.01;
}
function killMob(m) {
  if (!m || m.dead || m.removed) return false;
  if (BF.mobs.kill) return BF.mobs.kill(m) !== false;
  m.invuln = 0;
  return !!BF.mobs.hit(m, 1e9, null);
}

// ---------- commands ----------
const CMDS = Object.create(null), ALIASES = Object.create(null);   // no prototype, so /constructor or /__proto__ is just an unknown command
function def(name, o) { o.name = name; CMDS[name] = o; for (const a of o.aliases || []) ALIASES[a] = name; }
const usage = c => fail("Usage: " + [].concat(CMDS[c].usage).join("\n       "));

// argument completers: (args, i, cur) -> candidates for token i
const C_COORD3 = (args, i) => { // x y z at i..i+2 (relative to the first coordinate token)
  const t0 = P().target, out = [];
  const k = args.slice(0, i).length;
  let t = t0;
  if (t0) { const b = userFrame(); t = { x: t0.x - b.ox, y: t0.y, z: t0.z - b.oz }; }   // typed coordinates are u / v
  if (k === 0) { out.push("~ ~ ~"); if (t) out.push(`${t.x} ${t.y} ${t.z}`); }
  else if (k === 1) { out.push("~ ~"); if (t) out.push(`${t.y} ${t.z}`); }
  else { out.push("~"); if (t) out.push(String(t.z)); }
  return out;
};
const coordsAt = (start, n = 3) => (args, i) => (i >= start && i < start + n ? C_COORD3(args.slice(start), i - start) : null);

def("help", {
  aliases: ["?"], usage: "/help [command]", desc: "Lists commands, or shows one command's usage",
  complete: (a, i) => (i === 0 ? Object.keys(CMDS) : null),
  run(a) {
    if (a[0]) {
      const c = CMDS[norm(a[0]).replace(/^\//, "")] || CMDS[ALIASES[norm(a[0]).replace(/^\//, "")]];
      if (!c) fail(`Unknown command '${a[0]}'`);
      print([].concat(c.usage).join("\n") + (c.desc ? "\n  " + c.desc : "") + (c.aliases && c.aliases.length ? "\n  aliases: /" + c.aliases.join(", /") : ""), "gold");
      return;
    }
    print("--- Commands (Tab completes, Up/Down history) ---", "gold");
    for (const k of Object.keys(CMDS)) print([].concat(CMDS[k].usage)[0], "ok");
  },
});

const TP_PLANET = ["/tp <u> <y> <v> [yaw] [pitch]  (on your face)", "/tp <u> <v>  (to the surface)", "/tp face <0-5> <u> <v> [y]",
  "/tp <lat> <lon> [y]  (e.g. 35.26N 45E)", "/tp corner <1-8>", "/tp up <blocks>  (above the ground here)", "/tp ground"];
const LATLON = /^([+-]?(?:\d+\.?\d*|\.\d+))°?([nsew])$/i;
def("tp", {
  aliases: ["teleport"], usage: TP_PLANET, desc: "Teleports you. ~ is relative to your position.",
  complete: (a, i) => {
    if (/^@/.test(a[0] || "")) { a = a.slice(1); i--; }
    if (i === 0) return C_COORD3(a, i).concat(["face", "corner", "up", "ground"]);
    if (/^(face|corner|up|ground)$/i.test(a[0] || "")) return norm(a[0]) === "corner" && i === 1 ? ["1", "2", "3", "4", "5", "6", "7", "8"] : null;
    return i < 3 ? C_COORD3(a, i) : null;
  },
  run(a) {
    if (/^@[spa]$/.test(a[0] || "")) a = a.slice(1);
    { const r = planetTp(a); if (r) return r; }
    if (a.length === 2) {
      const b = userFrame(), pl = b.f >= 0;
      const x = parseCoord(a[0], b.x, pl ? "u" : "x") + b.ox, z = parseCoord(a[1], b.z, pl ? "v" : "z") + b.oz;
      checkBorder(x, z);
      const L = landing(x, z), y = surfaceY(L.x, L.z);
      teleport(L.x, y, L.z, L.q ? BF.planet.turnYaw(L.q, P().yaw || 0) : null, P().pitch || 0);
      return `Teleported ${PLAYER} to ${where(L.x, y, L.z)}`;
    }
    if (a.length !== 3 && a.length !== 5) usage("tp");
    const [x, y, z] = parsePos(a, 0, false);
    if (y < BF.MIN_Y || y > tpMaxY()) fail(`Invalid position: y must be between ${BF.MIN_Y} and ${tpMaxY()}`);   // below MIN_Y is solid bedrock with no way out
    checkBorder(x, z);
    let yaw = null, pitch = null;
    if (a.length === 5) {
      const curYawMC = (Math.PI - (P().yaw || 0)) * 180 / Math.PI, curPitchMC = -(P().pitch || 0) * 180 / Math.PI;
      const ang = (t, base, w) => (t[0] === "~" ? base + (t.length > 1 ? parseNum(t.slice(1), w) : 0) : parseNum(t, w));
      const ym = ang(a[3], curYawMC, "yaw"), pm = Math.max(-90, Math.min(90, ang(a[4], curPitchMC, "pitch")));
      yaw = Math.PI - ym * Math.PI / 180; pitch = -pm * Math.PI / 180;     // vanilla yaw 0 = south (+z), pitch + = down
    }
    const L = landing(x, z);
    if (L.q) { if (yaw == null) { yaw = P().yaw || 0; pitch = P().pitch || 0; } yaw = BF.planet.turnYaw(L.q, yaw); }
    teleport(L.x, y, L.z, yaw, pitch);
    return `Teleported ${PLAYER} to ${where(L.x, y, L.z)}`;
  },
});
// The planet's own /tp forms (the round-planet prototype's teleport panel). Null when a is none of them (plain u y v / u v).
function planetTp(a) {
  const k = norm(a[0]), Pl = BF.planet, N = Pl.N;
  const ground = (x, z) => (BF.mapview && BF.mapview.surfaceAt ? BF.mapview.surfaceAt(x, z) : surfaceY(x, z));   // on the water over the sea, as the prototype
  const fly = on => { if (P().setFlying && P().gameMode === "creative") P().setFlying(on); };
  if (k === "face") {
    if (a.length < 4 || a.length > 5) usage("tp");
    const f = parseNum(a[1], "face", { int: true, min: 0, max: 5 });
    const u = parseNum(a[2], "u", { min: 0, max: N - 1e-6 }), v = parseNum(a[3], "v", { min: 0, max: N - 1e-6 });
    const cu = /^[+-]?\d+$/.test(a[2]) ? u + 0.5 : u, cv = /^[+-]?\d+$/.test(a[3]) ? v + 0.5 : v;
    const at = Pl.atlas(f, Math.min(cu, N - 1e-6), Math.min(cv, N - 1e-6), {});
    const y = a[4] != null ? parseNum(a[4], "y", { min: BF.MIN_Y, max: tpMaxY() }) : ground(at.x, at.z);
    if (a[4] != null) fly(y > ground(at.x, at.z) + 2);
    teleport(at.x, y, at.z, turnTo(at.x, at.z), P().pitch || 0);
    return `Teleported ${PLAYER} to ${where(at.x, y, at.z)}`;
  }
  if (k === "corner") {
    if (a.length !== 2) usage("tp");
    const n = parseNum(a[1], "corner", { int: true, min: 1, max: 8 });
    const c = BF.coords.corner(n, 40);
    const y = ground(c.x, c.z) + 30;
    fly(true);
    teleport(c.x, y, c.z, c.yaw, -0.35);
    return `Teleported ${PLAYER} to corner ${n} (${BF.coords.latLonText(c.x, c.z)}), 40 blocks in from it: ${where(c.x, y, c.z)}`;
  }
  if (k === "up") {
    if (a.length !== 2) usage("tp");
    const h = parseNum(a[1], "blocks", { min: 0, max: tpMaxY() });
    const p = pos(), y = Math.min(tpMaxY(), ground(p.x, p.z) + h);
    fly(true);
    teleport(p.x, y, p.z);
    return `Teleported ${PLAYER} to ${where(p.x, y, p.z)} (${Math.round(h).toLocaleString("en-US")} above the ground)`;
  }
  if (k === "ground") {
    if (a.length !== 1) usage("tp");
    const p = pos(), y = ground(p.x, p.z);
    fly(false);
    teleport(p.x, y, p.z);
    return `Teleported ${PLAYER} to ${where(p.x, y, p.z)}`;
  }
  const m1 = LATLON.exec(a[0] || ""), m2 = LATLON.exec(a[1] || "");
  if (m1 || m2) {   // latitude / longitude need their hemisphere letters (plain numbers are u / v)
    if (!m1 || !m2 || a.length > 3) fail("Usage: /tp <lat><N|S> <lon><E|W> [y], e.g. /tp 35.26N 45E");
    const lat = +m1[1] * (/s/i.test(m1[2]) ? -1 : 1), lon = +m2[1] * (/w/i.test(m2[2]) ? -1 : 1);
    if (!/[ns]/i.test(m1[2]) || !/[ew]/i.test(m2[2])) fail("Latitude comes first (N or S), then longitude (E or W)");
    if (Math.abs(lat) > 90) fail(`Latitude must be between 90S and 90N, found ${a[0]}`);
    if (Math.abs(lon) > 180) fail(`Longitude must be between 180W and 180E, found ${a[1]}`);
    const at = Pl.atlasOfLatLon(lat, lon, {});
    const y = a[2] != null ? parseNum(a[2], "y", { min: BF.MIN_Y, max: tpMaxY() }) : ground(at.x, at.z);
    if (a[2] != null) fly(y > ground(at.x, at.z) + 2);
    teleport(at.x, y, at.z, turnTo(at.x, at.z), P().pitch || 0);
    return `Teleported ${PLAYER} to ${where(at.x, y, at.z)} (${BF.coords.latLonText(at.x, at.z)})`;
  }
  return null;
}
// A far teleport keeps the player's compass facing: the yaw that faces the same bearing at (x, z) as now.
function turnTo(x, z) {
  const p = pos(), C = BF.coords, yaw = P().yaw || 0;
  if (!C) return yaw;
  const b = C.bearing(-Math.sin(yaw), -Math.cos(yaw), p.x, p.z);
  return b == null ? yaw : C.yawFor(b, x, z, yaw);
}
function teleport(x, y, z, yaw, pitch) {
  const p = P();
  if (W().ensureRange) W().ensureRange(x, z, Math.floor(y) - 24, Math.floor(y) + 4);   // lazily load the sections around the destination
  if (p.teleport) p.teleport(x, y, z);
  else { p.position.set(x, y, z); if (p.velocity) p.velocity.x = p.velocity.y = p.velocity.z = 0; }
  if (yaw != null && p.setLook) p.setLook(yaw, pitch);
}

const TIME_NAMES = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };
const ticksNow = () => Math.floor((BF.sky.time || 0) * 24000);
def("time", {
  usage: ["/time set <day|noon|sunset|night|midnight|sunrise|<ticks>>", "/time add <ticks>", "/time query <daytime|day|gametime>"],
  desc: "24000 ticks per day; 0 = sunrise (6:00), 6000 noon, 12000 sunset, 18000 midnight. Units: t, s, d.",
  complete: (a, i) => (i === 0 ? ["set", "add", "query"] : i === 1 && a[0] === "set" ? Object.keys(TIME_NAMES).concat(["0", "6000", "18000"]) : i === 1 && a[0] === "query" ? ["daytime", "day", "gametime"] : i === 1 && a[0] === "add" ? ["1000", "6000", "12000"] : null),
  run(a) {
    const sub = norm(a[0]), S = BF.sky;
    if (!S) fail("Time not available");
    if (sub === "set") {
      if (a.length !== 2) usage("time");
      const n = norm(a[1]);
      const t = own(TIME_NAMES, n) != null ? TIME_NAMES[n] : parseTicks(a[1]);
      S.setTime((t % 24000) / 24000);
      return `Set the time to ${t % 24000}`;
    }
    if (sub === "add") {
      if (a.length !== 2) usage("time");
      const t = parseTicks(a[1]);
      const total = (S.day || 0) * 24000 + (S.time || 0) * 24000 + t;
      S.day = Math.floor(total / 24000);
      S.setTime((total % 24000) / 24000);
      return `Set the time to ${ticksNow()}`;
    }
    if (sub === "query") {
      const q = norm(a[1] || "daytime");
      if (q === "daytime") return `The time is ${ticksNow()}`;
      if (q === "day") return `The time is ${S.day || 0}`;
      if (q === "gametime") return `The time is ${Math.floor(((S.day || 0) + (S.time || 0)) * 24000)}`;
      usage("time");
    }
    usage("time");
  },
});

const MODES = { survival: "survival", s: "survival", 0: "survival", creative: "creative", c: "creative", 1: "creative" };
def("gamemode", {
  aliases: ["gm"], usage: "/gamemode <survival|creative>", desc: "Also accepts s / c / 0 / 1",
  complete: (a, i) => (i === 0 ? ["survival", "creative"] : null),
  run(a) {
    const n = norm(a[0]);
    if (!n) usage("gamemode");
    if (n === "adventure" || n === "spectator" || n === "a" || n === "sp" || n === "2" || n === "3") fail(`Game mode '${a[0]}' is not available here (survival or creative)`);
    const m = own(MODES, n);
    if (!m) fail(`Unknown game mode '${a[0]}'`);
    if (P().gameMode === m) return `${PLAYER} is already in ${m === "creative" ? "Creative" : "Survival"} Mode`;
    if (P().setGameMode) P().setGameMode(m); else P().gameMode = m;
    return `Set own game mode to ${m === "creative" ? "Creative" : "Survival"} Mode`;
  },
});

def("give", {
  usage: "/give <item> [count]", desc: `Item or block names, with or without minecraft:. Count up to ${MAX_GIVE}.`,
  complete: (a, i) => { if (/^@/.test(a[0] || "")) i--; return i === 0 ? names().items : i === 1 ? ["1", "16", "64"] : null; },
  run(a) {
    if (/^@[spa]$/.test(a[0] || "")) a = a.slice(1);
    if (!a.length || a.length > 2) usage("give");
    const id = resolveItem(a[0]);
    const n = a[1] == null ? 1 : parseNum(a[1], "count", { int: true, min: 1, max: MAX_GIVE });
    const I = BF.inventory;
    if (!I || !I.add) fail("Inventory not available");
    const left = I.add(id, n);
    if (left > 0) {
      const p = pos();
      if (BF.drops && BF.drops.spawn) BF.drops.spawn(id, left, p.x, p.y + 1, p.z);
      return `Gave ${n} [${displayName(id)}] to ${PLAYER} (${left} dropped: inventory full)`;
    }
    return `Gave ${n} [${displayName(id)}] to ${PLAYER}`;
  },
});

def("clear", {
  usage: "/clear [item] [maxCount]", desc: "Clears your inventory, or only one item",
  complete: (a, i) => { if (/^@/.test(a[0] || "")) i--; return i === 0 ? names().items : null; },
  run(a) {
    if (/^@[spa]$/.test(a[0] || "")) a = a.slice(1);
    const I = BF.inventory;
    if (!I) fail("Inventory not available");
    if (!a.length) {
      const n = (I.slots || []).reduce((s, x) => s + (x ? x.count : 0), 0);
      if (!n) fail(`No items were found on player ${PLAYER}`);
      I.clear();
      return `Removed ${n} item${n === 1 ? "" : "s"} from player ${PLAYER}`;
    }
    const id = resolveItem(a[0]);
    const max = a[1] == null ? Infinity : parseNum(a[1], "maxCount", { int: true, min: 0 });
    const have = I.count ? I.count(id) : 0;
    if (!have) fail(`No items were found on player ${PLAYER}`);
    if (max === 0) return `Found ${have} matching item${have === 1 ? "" : "s"} on player ${PLAYER}`;
    const got = I.remove(id, Math.min(have, max));
    return `Removed ${got} item${got === 1 ? "" : "s"} from player ${PLAYER}`;
  },
});

def("summon", {
  usage: "/summon <mob> [x y z]", desc: "Mobs: " + "pig, cow, sheep, chicken, zombie, skeleton, creeper, spider, villager, iron_golem",
  complete: (a, i) => (i === 0 ? mobTypes() : i <= 3 ? C_COORD3(a.slice(1), i - 1) : i === 4 && norm(a[0]) === "villager" ? (BF.mobs.professions || []) : null),
  run(a) {
    if (!a.length || (a.length > 1 && a.length < 4) || a.length > 5) usage("summon");
    const type = norm(a[0]);
    if (!BF.mobs || !mobTypes().includes(type)) fail(`Unknown entity '${a[0]}'`);
    const p = pos();
    let [x, y, z] = a.length >= 4 ? parsePos(a, 1, false) : [p.x, p.y, p.z];
    if (y < BF.MIN_Y || y >= BF.H + 64) fail("Invalid position for summon");
    if (a.length >= 4) { checkBorder(x, z); const L = landing(x, z); x = L.x; z = L.z; }   // mobs live at canonical points
    needLoaded(x, z);
    let variant, child = false;
    if (a[4] != null) {
      variant = norm(a[4]);
      if (type === "villager" && (variant === "child" || variant === "baby") && BF.breeding) { child = true; variant = undefined; }   // js/breeding.js
      else if (type !== "villager" || !(BF.mobs.professions || []).includes(variant)) fail(`Unknown variant '${a[4]}'`);
    }
    const m = BF.mobs.spawn(type, x, y, z, variant);
    if (!m) fail("Unable to summon entity");
    if (child) { BF.breeding.makeChild(m); return "Summoned new Child Villager"; }
    return `Summoned new ${type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`;
  },
});

const HOSTILE = m => !!(m.hostile || (m.def && m.def.hostile));
def("kill", {
  usage: ["/kill [@s]", "/kill <@e | mobs | hostile | passive | items | <mob type>>", "/kill @e[type=<mob>]"],
  desc: "No target kills you. @e / mobs kill every mob (not you); items removes dropped items.",
  complete: (a, i) => (i === 0 ? ["@s", "@e", "mobs", "hostile", "passive", "items"].concat(mobTypes(), mobTypes().map(t => `@e[type=${t}]`)) : null),
  run(a) {
    if (a.length > 1) usage("kill");
    let t = (a[0] || "@s").trim().toLowerCase();
    if (t === "@s" || t === "@p" || t === "@a" || t === "me" || t === "self" || t === PLAYER.toLowerCase()) {
      if (P().dead) fail(`${PLAYER} is already dead`);
      if (P().kill) P().kill(); else fail("Can't kill the player here");
      return `Killed ${PLAYER}`;
    }
    if (t === "items" || t === "@e[type=item]" || t === "drops") {
      const n = (BF.drops && BF.drops.list && BF.drops.list.length) || 0;
      if (!n) fail("No entity was found");
      BF.drops.clear();
      return `Killed ${n} item${n === 1 ? "" : "s"}`;
    }
    if (!BF.mobs) fail("No entity was found");
    let pred;
    const m = /^@e\[type=(!?)(?:minecraft:)?([a-z_]+)\]$/.exec(t);
    if (m) {
      const ty = m[2];
      if (!mobTypes().includes(ty) && ty !== "player") fail(`Unknown entity type '${ty}'`);
      pred = m[1] ? (x => x.type !== ty) : (x => x.type === ty);
      if (ty === "player" && !m[1]) { if (P().kill) P().kill(); return `Killed ${PLAYER}`; }
    } else if (t === "@e" || t === "mobs" || t === "all") pred = () => true;
    else if (t === "hostile") pred = HOSTILE;
    else if (t === "passive") pred = x => !HOSTILE(x);
    else if (mobTypes().includes(norm(t))) { const ty = norm(t); pred = x => x.type === ty; }
    else fail(`Unknown target '${a[0]}'`);
    let n = 0;
    const only = m && !m[1] ? m[2] : mobTypes().includes(norm(t)) ? norm(t) : null;   // one type: only those (r15-32)
    for (const mob of (only && BF.regions ? BF.regions.ofType(only) : BF.mobs.list).slice()) if (!mob.dead && !mob.removed && pred(mob) && killMob(mob)) n++;
    if (!n) fail("No entity was found");
    return n === 1 ? "Killed 1 entity" : `Killed ${n} entities`;
  },
});

def("weather", {
  usage: "/weather <clear|rain|thunder> [duration]", desc: "Duration in seconds (or with a unit: 600t, 1d)",
  complete: (a, i) => (i === 0 ? ["clear", "rain", "thunder"] : i === 1 ? ["60", "300", "600"] : null),
  run(a) {
    const w = norm(a[0]);
    if (!["clear", "rain", "thunder"].includes(w) || a.length > 2) usage("weather");
    let secs;
    if (a[1] != null) {
      if (/^\d+(\.\d+)?$/.test(a[1])) secs = +a[1];
      else secs = parseTicks(a[1]) / 20;
      if (!(secs > 0) || secs > 1e6) fail(`Invalid duration '${a[1]}'`);
    }
    if (!BF.weather || typeof BF.weather.set !== "function") fail("Weather not available");
    BF.weather.set(w, secs);
    return w === "clear" ? "Changing to clear weather" : w === "rain" ? "Changing to rain" : "Changing to rain and thunder";
  },
});

def("seed", { usage: "/seed", desc: "Shows the world seed", cheat: false, run() { return `Seed: [${BF.state ? BF.state.seed : "?"}]`; } });

def("spawnpoint", {
  aliases: ["setworldspawn"], usage: "/spawnpoint [x y z]", desc: "Sets your respawn point (default: where you stand)",
  complete: coordsAt(0),
  run(a) {
    if (a.length && /^@[spa]$/.test(a[0])) a = a.slice(1);
    if (a.length && a.length !== 3) usage("spawnpoint");
    let [x, y, z] = a.length ? parsePos(a, 0, true) : [Math.floor(pos().x), Math.floor(pos().y), Math.floor(pos().z)];
    checkBorder(x, z);
    if (y < BF.MIN_Y || y >= BF.H) fail(`Invalid position: y must be between ${BF.MIN_Y} and ${BF.H - 1}`);
    { const c = BF.planet.canonCell(x, z, {}); x = c.x; z = c.z; }
    BF.spawnPoint = { x: x + 0.5, y, z: z + 0.5 };
    return `Set spawn point to ${whereBlock(x, y, z)} for ${PLAYER}`;
  },
});

function removeOld(x, y, z, old) {
  const b = BF.blocks[old];
  if (b && (b.door || b.bed) && W().removePartner) { try { W().removePartner(x, y, z, old); } catch (_) {} }
}
def("setblock", {
  usage: "/setblock <x> <y> <z> <block> [replace|keep|destroy]", desc: "Places one block",
  complete: (a, i) => (i < 3 ? C_COORD3(a, i) : i === 3 ? names().blocks : i === 4 ? ["replace", "keep", "destroy"] : null),
  run(a) {
    if (a.length < 4 || a.length > 5) usage("setblock");
    const [x, y, z] = parsePos(a, 0, true);
    const id = resolveBlock(a[3]);
    const mode = norm(a[4] || "replace");
    if (!["replace", "keep", "destroy"].includes(mode)) usage("setblock");
    if (y < BF.MIN_Y || y >= BF.H) fail("Cannot place block outside of the world");
    checkBorder(x, z);
    if (!W().canonXZ(x, z)) fail("Could not set the block (that spot is past a cube corner, between two faces)");
    needLoaded(x, z);
    const old = W().getBlock(x, y, z);
    if (old === id || (mode === "keep" && old !== 0)) fail("Could not set the block");
    if (mode === "destroy" && old) {
      try { if (BF.drops && BF.rollDrops && P().gameMode !== "creative") BF.drops.spawnAt(BF.rollDrops(old), x, y, z); } catch (_) {}
      if (P().spawnParticles) P().spawnParticles(x, y, z, old);
    }
    removeOld(x, y, z, old);
    if (!W().setBlock(x, y, z, id)) fail("Could not set the block");
    return `Changed the block at ${whereBlock(x, y, z)}`;
  },
});

def("fill", {
  usage: "/fill <x1> <y1> <z1> <x2> <y2> <z2> <block> [replace [filter]|keep|hollow|outline]", desc: `Fills a box (at most ${MAX_FILL} blocks)`,
  complete: (a, i) => (i < 3 ? C_COORD3(a, i) : i < 6 ? C_COORD3(a.slice(3), i - 3) : i === 6 ? names().blocks : i === 7 ? ["replace", "keep", "hollow", "outline"] : i === 8 && a[7] === "replace" ? names().blocks : null),
  run(a) {
    if (a.length < 7 || a.length > 9) usage("fill");
    const p1 = parsePos(a, 0, true), p2 = parsePos(a, 3, true);
    const id = resolveBlock(a[6]);
    const mode = norm(a[7] || "replace");
    if (!["replace", "keep", "hollow", "outline"].includes(mode)) usage("fill");
    if (a[8] != null && mode !== "replace") usage("fill");
    const filter = a[8] != null ? resolveBlock(a[8]) : null;
    const x0 = Math.min(p1[0], p2[0]), x1 = Math.max(p1[0], p2[0]), y0 = Math.min(p1[1], p2[1]), y1 = Math.max(p1[1], p2[1]), z0 = Math.min(p1[2], p2[2]), z1 = Math.max(p1[2], p2[2]);
    const vol = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (vol > MAX_FILL) fail(`Too many blocks in the specified area (maximum ${MAX_FILL}, specified ${vol})`);
    if (y0 < BF.MIN_Y || y1 >= BF.H) fail("Cannot place blocks outside of the world");
    checkBorder(x0, z0); checkBorder(x1, z1);
    for (let x = x0; x <= x1; x += 16) for (let z = z0; z <= z1; z += 16) needLoaded(x, z);
    needLoaded(x1, z1); needLoaded(x0, z1); needLoaded(x1, z0);
    const w = W();
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const shell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
      let want = id;
      if ((mode === "hollow" || mode === "outline") && !shell) { if (mode === "outline") continue; want = 0; }
      const old = w.getBlock(x, y, z);
      if (old === want) continue;
      if (mode === "keep" && old !== 0) continue;
      if (filter != null && old !== filter) continue;
      removeOld(x, y, z, old);
      if (w.setBlock(x, y, z, want)) n++;
    }
    if (!n) fail("No blocks were filled");
    return `Successfully filled ${n} block${n === 1 ? "" : "s"}`;     // dirty chunks remesh once on the next world.update
  },
});

def("locate", {
  usage: "/locate village", desc: "Finds the nearest village",
  complete: (a, i) => (i === 0 ? ["village", "structure"] : i === 1 && a[0] === "structure" ? ["village"] : null),
  run(a) {
    let what = norm(a[0]);
    if (what === "structure") what = norm(a[1]);
    if (!/^village(_\w+)?$/.test(what)) fail(what ? `Unknown structure '${what}' (try village)` : "Usage: /locate village");
    const G = BF.worldgen;
    if (!G || !G.nearestVillage) fail("Villages not available");
    const p = pos(), v = G.nearestVillage(p.x, p.z);
    if (!v) fail("Could not find a village within reasonable distance");
    const nm = BF.signs && BF.signs.villageName ? BF.signs.villageName(v) : null;
    // planet distance, compass direction, and a /tp that works from anywhere
    const Pl = BF.planet, d = Math.round(Pl.distance(p, v)), t = Pl.toward(p, v, {});
    const dir = BF.coords.compass(BF.coords.bearing(t.x, t.z, p.x, p.z)), c = Pl.canonCell(v.x, v.z, {});
    return `The nearest village${nm ? " (" + nm + ")" : ""} is ${d.toLocaleString("en-US")} blocks away to the ${dir}, at face ${c.f}  u ${c.u.toLocaleString("en-US")}  v ${c.v.toLocaleString("en-US")}. /tp face ${c.f} ${c.u} ${c.v} goes there.`;
  },
});

def("heal", {
  usage: "/heal [amount]", desc: "Restores health (half-hearts; default full)",
  run(a) {
    const p = P();
    if (p.dead) fail(`${PLAYER} is dead`);
    const n = a[0] == null ? p.maxHealth : parseNum(a[0], "amount", { min: 0, max: 1000 });
    if (p.heal) p.heal(n); else p.health = Math.min(p.maxHealth, p.health + n);
    return `Healed ${PLAYER} (${fmt(p.health)}/${p.maxHealth})`;
  },
});
def("feed", {
  usage: "/feed", desc: "Fills hunger and saturation",
  run() {
    const p = P();
    if (p.dead) fail(`${PLAYER} is dead`);
    if (p.feed) p.feed(); else p.hunger = p.maxHunger;
    return `Fed ${PLAYER}`;
  },
});
def("say", {
  usage: "/say <message>", desc: "Broadcasts a message", cheat: false,
  run(a, raw) {
    const msg = raw.replace(/^\s*\S+\s?/, "");
    if (!msg.trim()) usage("say");
    print(`[${PLAYER}] ${msg}`, "info");
  },
});

// ---------- execution ----------
function split(s) { return s.trim().split(/\s+/).filter(Boolean); }
function execute(text) {
  const body = String(text).replace(/^\//, "");
  const parts = split(body);
  if (!parts.length) return { ok: false, msg: "" };
  const name = parts[0].toLowerCase().replace(/^minecraft:/, "");
  const cmd = CMDS[name] || CMDS[ALIASES[name]];
  print("/" + body.trim(), "dim");
  if (!cmd) { const m = `Unknown command '${name}'. Type /help for a list.`; print(m, "err"); return { ok: false, msg: m }; }
  try {
    const out = cmd.run(parts.slice(1), body);
    if (cmd.cheat !== false) markCheats();
    if (out) print(out, "ok");
    BF.emit && BF.emit("commandExecuted", cmd.name, parts.slice(1));
    return { ok: true, msg: out || "" };
  } catch (e) {
    const m = e instanceof CmdError ? e.message : "An unexpected error occurred trying to execute that command" + (e && e.message ? ": " + e.message : "");
    print(m, "err");
    return { ok: false, msg: m };
  }
}

// ---------- tab completion / suggestions ----------
let tabState = null;           // {prefix, cands, i}
function candidatesFor(text) {
  if (!text.startsWith("/")) return { prefix: text, cur: "", cands: [] };
  const body = text.slice(1);
  const m = /^(.*?)(\S*)$/.exec(body);
  const before = m[1], cur = m[2];
  const toks = split(before);
  const prefix = "/" + before;
  if (!toks.length) {
    const all = Object.keys(CMDS).concat(Object.keys(ALIASES)).sort();
    return { prefix, cur, cands: filterCands(all, cur), cmdName: true };
  }
  const name = toks[0].toLowerCase(), cmd = CMDS[name] || CMDS[ALIASES[name]];
  if (!cmd) return { prefix, cur, cands: [] };
  const args = toks.slice(1), i = args.length;
  let list = null;
  try { list = cmd.complete ? cmd.complete(args, i, cur) : null; } catch (_) { list = null; }
  return { prefix, cur, cands: filterCands(list || [], cur), cmd };
}
function filterCands(list, cur) {
  const c = cur.toLowerCase(), bare = c.replace(/^minecraft:/, "");
  if (!c) return list.slice();
  const starts = [], inside = [];
  for (const s of list) {
    const l = s.toLowerCase();
    if (l === c) continue;
    if (l.startsWith(c) || l.startsWith(bare)) starts.push(s);
    else if (bare.length >= 2 && l.includes(bare)) inside.push(s);
  }
  return starts.concat(inside);
}
function refreshSuggestions() {
  if (!open) return;
  const text = inputEl.value;
  const st = tabState || candidatesFor(text);
  const cands = st.cands || [];
  let html = "";
  const sel = tabState ? tabState.i : -1;
  const show = cands.slice(Math.max(0, Math.min(sel - 4, cands.length - 10)), Math.max(0, Math.min(sel - 4, cands.length - 10)) + 10);
  const off = cands.indexOf(show[0]);
  show.forEach((c, k) => { html += `<div data-i="${off + k}"${off + k === sel ? ' class="sel"' : ""}>${esc(c)}</div>`; });
  const cmd = st.cmd || (() => { const n = split(text.slice(1))[0]; return n && (CMDS[n.toLowerCase()] || CMDS[ALIASES[n.toLowerCase()]]); })();
  if (text.startsWith("/") && cmd && /\s/.test(text)) html += `<div class="hint">${esc([].concat(cmd.usage)[0])}</div>`;
  sugEl.innerHTML = html;
  sugEl.classList.toggle("on", !!html);
  sugEl.style.left = Math.min(Math.max(0, measure(st.prefix || "") + 2), Math.max(0, barEl.clientWidth - 200)) + "px";
}
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let measureCtx = null;
function measure(s) {
  try {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = getComputedStyle(inputEl).font;
    return measureCtx.measureText(s).width + 8;
  } catch (_) { return 0; }
}
function complete(dir) {
  if (!tabState) {
    const st = candidatesFor(inputEl.value);
    if (!st.cands.length) return;
    tabState = { prefix: st.prefix, cands: st.cands, cmd: st.cmd, i: dir > 0 ? 0 : st.cands.length - 1 };
  } else tabState.i = (tabState.i + dir + tabState.cands.length) % tabState.cands.length;
  applyCandidate(tabState.i);
}
function applyCandidate(i) {
  if (!tabState) { const st = candidatesFor(inputEl.value); if (!st.cands.length) return; tabState = { prefix: st.prefix, cands: st.cands, cmd: st.cmd, i }; }
  tabState.i = i;
  const v = tabState.prefix + tabState.cands[i];
  inputEl.value = v;
  try { inputEl.setSelectionRange(v.length, v.length); } catch (_) {}
  refreshSuggestions();
}

// ---------- events / API ----------
function wire() {
  if (!BF.on) return;
  BF.on("playerDied", () => closeChat());
}
// main.js (the event bus) loads after this file: hook up once every script has run
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { wire(); buildDOM(); });
else setTimeout(() => { wire(); buildDOM(); }, 0);

BF.commands = {
  isOpen: () => open,
  open: prefill => { if (canOpen()) openChat(prefill == null ? "/" : prefill); },
  close: closeChat,
  execute,                     // execute("/tp 0 80 0") -> {ok, msg}
  print,                       // print(text, "ok" | "err" | "info" | "dim" | "gold")
  complete: text => candidatesFor(text).cands,
  get history() { return history.slice(); },
  list: CMDS,
};
})();
