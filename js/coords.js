// Positions as the player reads and types them (spec r14-18). Atlas x / z are internal: the player sees the face, the grid position
// on it (u, v, both 0 to N - 1), the layer y, latitude / longitude and a compass facing. Commands take u / v on the player's current
// face (extended past its edges into the margin, so "~5" works across an edge).
// Also the teleport panel (P, creative only): the round-planet prototype's panel, as a front end to /tp.
// API: BF.coords = { describe(x, y, z), latLonText(x, z), facing(yaw, x, z), bearing(dx, dz, x, z), compass(deg), yawFor(deg, x, z, yaw0), here(),
//                    toAtlas(f, u, v), corner(n), CORNERS, panel: { open(), close(), isOpen() } }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const num = v => (Math.round(v * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const int = v => Math.floor(v).toLocaleString("en-US");

// "face 2  u 81,920  v 81,920  y 64" (canonical: a margin point reads as the face it shows).
const cc = {};
function describe(x, y, z, opts) {
  const whole = opts && opts.whole, n = whole ? int : num;
  const c = BF.planet.canon(x, z, cc);
  if (c.off) return `off the planet (${n(x)}, ${n(y)}, ${n(z)})`;
  return `face ${c.f}  u ${n(c.u)}  v ${n(c.v)}  y ${n(y)}`;
}
// "35.26°N 45.00°E" (null off the atlas)
function latLonText(x, z) {
  const ll = BF.planet.latLonAt(x, z, {});
  if (!ll) return null;
  return llText(ll.lat, ll.lon);
}
// "35.26°N 45.00°E" for a latitude / longitude in degrees (what rounds to 0.00 reads N / E, never "0.00°S").
function llText(lat, lon) {
  const r = v => (Math.abs(v) < 0.005 ? 0 : v);
  lat = r(lat); lon = r(lon);
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

// Compass bearing (degrees clockwise from north) of a grid direction (dx, dz) at atlas point (x, z): BF.planet.bearing. Null at a pole.
const bearing = (dx, dz, x, z) => BF.planet.bearing(x, z, dx, dz);
const compass = deg => (deg == null ? "at the pole" : BF.planet.compassPoint(deg));
// The player's facing (yaw: forward = (-sin yaw, -cos yaw)) as "north-east (37°)".
function facing(yaw, x, z) {
  const b = bearing(-Math.sin(yaw), -Math.cos(yaw), x, z);
  return b == null ? "at the pole" : `${compass(b)} (${Math.round(b) % 360}°)`;
}
// The yaw that faces compass bearing `deg` at atlas point (x, z) (yaw0 where the bearing is undefined, at a pole). Bearings run
// clockwise and yaw counter-clockwise (seen from above), so the error in bearing is added to the yaw; a few rounds converge.
function yawFor(deg, x, z, yaw0) {
  let yaw = yaw0 || 0;
  for (let i = 0; i < 4; i++) {
    const b = bearing(-Math.sin(yaw), -Math.cos(yaw), x, z);
    if (b == null) return yaw0 || 0;
    const d = ((b - deg + 540) % 360) - 180;
    yaw += d * Math.PI / 180;
    if (Math.abs(d) < 0.01) break;
  }
  return yaw;
}
// The player's face and grid position (null off the atlas).
function here() {
  const p = BF.player && BF.player.position;
  if (!p) return null;
  const c = BF.planet.canon(p.x, p.z, {});
  return c.off ? null : c;
}
const toAtlas = (f, u, v) => BF.planet.atlas(f, u, v, {});

// The 8 cube corners, as in the prototype: each by its direction, reached on the face fromDir picks.
const CORNERS = [];
for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
  const lat = Math.asin(sy / Math.sqrt(3)) * 180 / Math.PI, lon = Math.atan2(sx, sz) * 180 / Math.PI;
  CORNERS.push({ d: [sx, sy, sz], lat, lon });
}
// Corner n (1 to 8): its face and grid point, and a spot `inset` blocks in from it along both grid axes facing it.
function corner(n, inset) {
  const c = CORNERS[n - 1], P = BF.planet;
  if (!c) return null;
  const g = P.fromDir(c.d[0], c.d[1], c.d[2], {}), f = g.f, u = Math.round(g.u), v = Math.round(g.v);
  const su = u > 0 ? -1 : 1, sv = v > 0 ? -1 : 1, k = inset == null ? 40 : inset;
  const a = toAtlas(f, u + su * k + 0.5 * su, v + sv * k + 0.5 * sv);
  return { f, u, v, lat: c.lat, lon: c.lon, x: a.x, z: a.z, yaw: Math.atan2(su, sv) };   // forward (-sin yaw, -cos yaw) = (-su, -sv) / |.|
}

// ---------- teleport panel (P) ----------
const panel = { el: null, input: null, msg: null, open: false };
const css = `
.bft-wrap{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,10,9,.55);z-index:40}
.bft-wrap.open{display:flex}
.bft{background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;width:min(440px,calc(100vw - 24px));font:12px var(--mono);color:var(--ink)}
.bft h3{margin:0;font:13px var(--display);letter-spacing:.04em}
.bft .bft-msg{color:var(--muted);white-space:pre-wrap;min-height:16px}
.bft .bft-msg.bad{color:var(--danger)}
.bft input{font:14px var(--mono);padding:6px 8px;color:var(--ink);background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px}
.bft .bft-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bft button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:5px 10px;cursor:pointer}
.bft button:hover{background:rgba(127,191,77,.38)}
.bft .bft-lab{color:var(--muted);min-width:5.5em}`;
const HEIGHTS = [["Ground", "ground"], ["Up 1,000", "up 1000"], ["Up 10,000", "up 10000"], ["Up 25,000", "up 25000"]];
function build() {
  if (panel.el) return;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const r = panel.el = document.createElement("div");
  r.className = "bft-wrap";
  r.innerHTML = `<div class="bft" role="dialog" aria-label="Teleport"><h3>Teleport</h3><div class="bft-msg"></div>` +
    `<div class="bft-row"><input type="text" spellcheck="false" autocomplete="off" aria-label="Where to" style="flex:1"><button type="button" data-a="go">Go</button></div>` +
    `<div class="bft-row"><span class="bft-lab">Corners</span><span data-a="corners" class="bft-row"></span></div>` +
    `<div class="bft-row"><span class="bft-lab">Height</span><span data-a="heights" class="bft-row"></span></div>` +
    `<div class="bft-msg">face 2 81920 81920 · 35.26N 45E · corner 3 · up 5000 · u y v (this face) · Esc closes</div>` +
    `<div class="bft-row" style="justify-content:flex-end"><button type="button" data-a="close">Close</button></div></div>`;
  (document.getElementById("ui") || document.body).appendChild(r);
  panel.input = r.querySelector("input"); panel.msg = r.querySelector(".bft-msg");
  r.querySelector('[data-a="go"]').addEventListener("click", () => go(panel.input.value));
  r.querySelector('[data-a="close"]').addEventListener("click", close);
  r.addEventListener("mousedown", e => { if (e.target === r) close(); });
  const cs = r.querySelector('[data-a="corners"]');
  CORNERS.forEach((c, i) => {
    const b = document.createElement("button");
    b.textContent = String(i + 1);
    b.title = `${Math.abs(c.lat).toFixed(2)}°${c.lat > 0 ? "N" : "S"} ${Math.abs(c.lon).toFixed(0)}°${c.lon >= 0 ? "E" : "W"}`;
    b.addEventListener("click", () => go("corner " + (i + 1)));
    cs.appendChild(b);
  });
  const hs = r.querySelector('[data-a="heights"]');
  for (const [label, cmd] of HEIGHTS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => go(cmd));
    hs.appendChild(b);
  }
}
// Runs the text as /tp (the panel is a front end to the command). Closes on success; shows the error otherwise. True or false, or null
// with the simulation off the page (the answer comes later).
function go(text) {
  const t = String(text || "").trim().replace(/^\/?(tp|teleport)\s+/i, "");
  if (!t) return false;
  const r = BF.commands ? BF.commands.execute("/tp " + t) : { ok: false, msg: "Commands not available" };
  if (r.pending && r.done) { r.done.then(answer); return null; }   // the simulation in a worker or on the world server: its answer comes later
  return answer(r);
}
function answer(r) {
  if (r.ok) { close(); if (BF.player && BF.player.actionBar) BF.player.actionBar(r.msg); return true; }
  if (panel.msg) { panel.msg.textContent = r.msg; panel.msg.classList.add("bad"); }
  return false;
}
function canOpen() {
  const p = BF.player;
  return !!(p && (!p.canOpenUI || p.canOpenUI()));
}
function open() {
  const p = BF.player;
  if (!canOpen()) return false;
  if (p.gameMode !== "creative") { if (p.actionBar) p.actionBar("The teleport panel is a creative tool (use /tp)"); return false; }
  build();
  panel.open = true;   // before releasing the lock (player.js treats this as an open screen)
  try { if (p.uiOpen) p.uiOpen(); } catch (e) { console.error(e); }
  const pp = p.position;
  panel.msg.classList.remove("bad");
  panel.msg.textContent = "Now: " + describe(pp.x, pp.y, pp.z, { whole: true }) + "\n" + (latLonText(pp.x, pp.z) || "");
  panel.input.value = "";
  panel.el.classList.add("open");
  panel.input.focus();
  return true;
}
function close() {
  if (!panel.open) return;
  panel.open = false;
  panel.el.classList.remove("open");
  panel.input.blur();
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
// Every key goes to the open panel; P opens it (capture phase at load time, like commands.js). The page only: the simulation loads this
// file for the commands' planet forms and messages (js/simworker.js).
if (BF.page) addEventListener("keydown", e => {
  if (panel.open) {
    e.stopImmediatePropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter" || e.key === "NumpadEnter") { e.preventDefault(); go(panel.input.value); return; }
    if (e.key === "Tab" || e.key === "F3" || e.key === "F1") { e.preventDefault(); return; }
    if (e.target !== panel.input) panel.input.focus();
    return;
  }
  if (e.code !== "KeyP" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!canOpen() || !(BF.player && BF.player.menu && !BF.player.menu())) return;
  if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  open();
}, true);

BF.coords = {
  describe, latLonText, llText, facing, bearing, compass, yawFor, here, toAtlas, corner, CORNERS,
  panel: { open, close, isOpen: () => panel.open, go },
};
})();
