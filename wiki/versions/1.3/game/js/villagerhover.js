// Villager hover card: looking at a villager (crosshair on it, not hidden behind a block) shows its name, occupation and
// what it is doing in a small card at the top centre of the screen, in survival and creative alike. Hidden while any screen
// or menu is open and when the player is dead. Called once per frame from main.js.
// API: BF.villagerHover = { init(), update(dt), shown() -> mob|null }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

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

// The villager under the crosshair, or null: the nearest mob the look ray hits, if it is a villager and no block is in front of it.
function lookedAt() {
  const P = BF.player;
  if (!P || P.dead || !BF.mobs || !BF.mobs.raycast || !P.eyePos) return null;
  if (P.screenOpen && P.screenOpen()) return null;
  if (P.menu && P.menu()) return null;
  const e = P.eyePos(), d = P.lookDir();
  const hit = BF.mobs.raycast(e, d, RANGE);
  if (!hit || !hit.mob || hit.mob.type !== "villager") return null;
  const b = BF.world && BF.world.raycast ? BF.world.raycast(e, d, hit.dist) : null;
  return b && b.dist < hit.dist ? null : hit.mob;
}

function fill(m) {
  nameEl.textContent = BF.vlog ? BF.vlog.nameOf(m) : "Villager";
  profEl.textContent = m.child ? "Child" : pretty(m.profession || "villager");
  const st = BF.villagerStatus ? BF.villagerStatus.text(m) : "";
  actEl.textContent = st;
  actEl.style.display = st ? "" : "none";
}

function update(dt) {
  if (!el) init();
  if (!el) return;
  let m = null;
  try { m = lookedAt(); } catch (_) { m = null; }
  if (m !== cur) { cur = m; refreshT = 0; }
  if (!m) { el.style.display = "none"; return; }
  refreshT -= dt;
  if (refreshT <= 0) { refreshT = REFRESH; fill(m); }
  el.style.display = "block";
}

BF.villagerHover = { init, update, shown: () => cur };
})();
