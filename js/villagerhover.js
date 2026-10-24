// Villager hover card: looking at a villager (crosshair on it, not hidden behind a block) shows its name, occupation and
// what it is doing in a small card at the top centre of the screen, in survival and creative alike. Hidden while any screen
// or menu is open and when the player is dead. Called once per frame from main.js.
// Spec r15-37: the villager is found among the mobs in the client's mirror (BF.client.world entities, js/protocol.js), its name and
// occupation are its mirrored fields, and what it is doing is the "villager" query's answer, asked again every REFRESH.
// API: BF.villagerHover = { init(), update(dt), shown() -> its entity in the mirror | null }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const RANGE = 32;        // blocks: far enough to read a villager across a field, not across the map
const REFRESH = 0.25;    // s between status-text refreshes while the same villager stays under the crosshair

let el = null, nameEl = null, profEl = null, actEl = null, cur = null, refreshT = 0;

const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function init() {
  if (el || typeof document === "undefined") return;
  const css = document.createElement("style");
  css.textContent =
    ".bfv-hover{position:fixed;left:50%;top:calc(8px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:15;" +
    "pointer-events:none!important;background:var(--panel);border:1px solid var(--panel-edge,rgba(255,255,255,.12));border-radius:3px;" +
    "padding:5px 12px 6px;text-align:center;color:var(--ink);text-shadow:1px 1px 0 #000;max-width:min(420px,calc(100vw - 32px));display:none}" +
    ".bfv-hover .n{font:14px/1.2 var(--display);color:var(--ink)}" +
    ".bfv-hover .p{font:11px/1.3 var(--display);color:var(--accent)}" +
    ".bfv-hover .a{font:12px/1.35 var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
  document.head.appendChild(css);
  el = document.createElement("div"); el.className = "bfv-hover"; el.setAttribute("aria-live", "polite");
  nameEl = document.createElement("div"); nameEl.className = "n";
  profEl = document.createElement("div"); profEl.className = "p";
  actEl = document.createElement("div"); actEl.className = "a";
  el.append(nameEl, profEl, actEl);
  (document.getElementById("ui") || document.body).appendChild(el);
}

// The nearest mob in the mirror the look ray hits (its box: half width hw, height h, seen from the eye's frame on the planet), or null.
const LQ = {};
function rayAABB(o, d, mn, mx) {
  let t0 = 0, t1 = Infinity;
  const os = [o.x, o.y, o.z], ds = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-9) { if (os[a] < mn[a] || os[a] > mx[a]) return null; continue; }
    let ta = (mn[a] - os[a]) / ds[a], tb = (mx[a] - os[a]) / ds[a];
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
function raycast(o, d, max) {
  const W = BF.client && BF.client.world;
  if (!W) return null;
  let best = null;
  const mn = [0, 0, 0], mx = [0, 0, 0], R2 = (max + 2) * (max + 2);
  for (const m of W.entities.values()) {
    if (m.kind !== "mob" || m.dead) continue;
    BF.planet.local(o, m, LQ);
    const x = LQ.x, z = LQ.z;
    if ((x - o.x) ** 2 + (m.y - o.y) ** 2 + (z - o.z) ** 2 > R2) continue;
    mn[0] = x - m.hw; mn[1] = m.y; mn[2] = z - m.hw;
    mx[0] = x + m.hw; mx[1] = m.y + m.h; mx[2] = z + m.hw;
    const t = rayAABB(o, d, mn, mx);
    if (t != null && t <= max && (!best || t < best.dist)) best = { mob: m, dist: t };
  }
  return best;
}
// The villager under the crosshair, or null: the nearest mob the look ray hits, if it is a villager and no block is in front of it.
function lookedAt() {
  const P = BF.player;
  if (!P || P.dead || !P.eyePos) return null;
  if (P.screenOpen && P.screenOpen()) return null;
  if (P.menu && P.menu()) return null;
  const e = P.eyePos(), d = P.lookDir();
  const hit = raycast(e, d, RANGE);
  if (!hit || !hit.mob || hit.mob.type !== "villager") return null;
  const b = BF.world && BF.world.raycast ? BF.world.raycast(e, d, hit.dist) : null;
  return b && b.dist < hit.dist ? null : hit.mob;
}

let asked = null;
function fill(m) {
  nameEl.textContent = m.name || "Villager";
  profEl.textContent = m.child ? "Child" : pretty(m.prof || "villager");
  if (asked === m.n || !BF.client) return;
  asked = m.n;
  BF.client.query("villager", { id: m.sid }, r => {
    asked = null;
    if (cur !== m) return;
    const st = r && r.ok ? r.status : "";
    actEl.textContent = st;
    actEl.style.display = st ? "" : "none";
  });
}

function update(dt) {
  if (!el) init();
  if (!el) return;
  let m = null;
  try { m = lookedAt(); } catch (_) { m = null; }
  if (m !== cur) { cur = m; refreshT = 0; asked = null; if (m) { actEl.textContent = ""; actEl.style.display = "none"; } }
  if (!m) { el.style.display = "none"; return; }
  refreshT -= dt;
  if (refreshT <= 0) { refreshT = REFRESH; fill(m); }
  el.style.display = "block";
}

BF.villagerHover = { init, update, shown: () => cur };
})();
