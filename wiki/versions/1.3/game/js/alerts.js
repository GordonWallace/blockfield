// Alerts from the debug screen. The user sets alerts up on the debug screen (debug/index.html), with the same choices as its
// log filters (villager type, action, event type, plus words the entry must contain); the debug server keeps them in a file and
// hands them to the game with its answers to the feed (js/debugfeed.js). Every village log entry (js/villagelog.js) is checked
// against the enabled ones, and when one matches the game:
//   - drops to 0x straight away (js/timewarp.js: the world freezes, even part-way through a fast-forward frame),
//   - frees the mouse (as Z does), and
//   - shows a notice in the top-left corner with the log line, its village and, when the entry has a location, how far away
//     it is and a Teleport button that puts the player a few blocks from it, looking at it.
// Right arrow (or any speed change) dismisses the notice, takes the mouse back if the alert freed it and resumes at 1x.
// API: BF.alerts = { set(list, av), list, av, hits, check(rec, entry), active, dismiss(), teleport(), fire(alert, rec, entry) }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

let list = [], av = null, active = null, el = null, freed = false;
const hits = {};   // alert id -> { n, text, day } (sent back to the debug screen)

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LM = () => BF.logmatch || window.BFLog;

function ui() {
  if (el || !document.body) return el;
  const st = document.createElement("style");
  st.textContent = "#bf-alert{position:fixed;top:10px;left:10px;z-index:40;max-width:min(520px,calc(100vw - 20px));padding:10px 12px;border-radius:6px;" +
    "background:rgba(20,16,8,.88);border:2px solid #f2c66d;color:#fff;font:14px/1.4 'Courier New',monospace;box-shadow:0 6px 20px rgba(0,0,0,.5);text-shadow:1px 1px 0 #000}" +
    "#bf-alert .h{color:#f2c66d;font-weight:700;letter-spacing:1px;margin-bottom:4px}#bf-alert .v{color:#cfe8b0;font-size:12px}#bf-alert .tx{margin:4px 0 6px}" +
    "#bf-alert .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}#bf-alert .d{color:#ddd}" +
    "#bf-alert button{font:600 13px 'Courier New',monospace;background:#7fbf4d;color:#10140f;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}" +
    "#bf-alert button:hover{background:#a6dc72}#bf-alert .k{color:#aaa;font-size:12px;margin-top:6px}";
  document.head.appendChild(st);
  el = document.createElement("div");
  el.id = "bf-alert";
  el.hidden = true;
  el.addEventListener("click", e => { if (e.target.closest("[data-act=tp]")) { e.stopPropagation(); teleport(); } });
  el.addEventListener("mousedown", e => e.stopPropagation());   // a click on the notice isn't a click on the game
  document.body.appendChild(el);
  return el;
}

function distTo(p) {
  const pp = BF.player && BF.player.position;
  return pp && p ? Math.round(Math.hypot(p[0] + 0.5 - pp.x, p[1] - pp.y, p[2] + 0.5 - pp.z)) : null;
}
function render() {
  const e = ui();
  if (!e) return;
  if (!active) { e.hidden = true; return; }
  const A = active, at = A.entry[3], L = BF.vlog, d = distTo(at);
  const vname = (BF.signs && BF.signs.villageName && BF.signs.villageName(A.rec.key)) || "Village";
  e.innerHTML = `<div class="h">⚠ ALERT: ${esc(LM() ? LM().describe(A.alert) : "alert")}${A.more ? ` <span class="v">(+${A.more} more)</span>` : ""}</div>` +
    `<div class="v">${esc(vname)} · ${esc(L ? L.stamp(A.entry[0]) : "")}</div>` +
    `<div class="tx">${esc(A.entry[2])}</div>` +
    (at ? `<div class="row"><span class="d" data-d>${d} blocks away</span> <span class="v">(${at.join(", ")})</span><button data-act="tp">Teleport</button></div>` :
      `<div class="row"><span class="d">No location for this event</span></div>`) +
    `<div class="k">Time is frozen (0×). → resumes at 1× and dismisses this.</div>`;
  e.hidden = false;
  A.shownD = d;
}
// keep the distance current as the player moves
function tick() {
  requestAnimationFrame(tick);
  if (!active || !el || el.hidden) return;
  const at = active.entry[3];
  if (!at) return;
  const d = distTo(at);
  if (d !== active.shownD) { active.shownD = d; const s = el.querySelector("[data-d]"); if (s) s.textContent = d + " blocks away"; }
}

function fire(alert, rec, entry) {
  const h = hits[alert.id] || (hits[alert.id] = { n: 0 });
  h.n++; h.text = entry[2]; h.day = entry[0];
  if (active) { active = { alert, rec, entry, more: active.more + 1 }; render(); return; }   // already frozen: show the newest
  active = { alert, rec, entry, more: 0 };
  if (BF.warp) BF.warp.freeze();
  freed = !!(BF.player && BF.player.freeMouse && BF.player.freeMouse());
  render();
  if (BF.audio && BF.audio.play) { try { BF.audio.play("xp"); } catch (_) { /* optional */ } }
  if (BF.emit) BF.emit("alertFired", alert, entry);
}
function check(rec, entry) {
  if (!list.length || !LM()) return;
  for (const a of list) if (a.on !== false && LM().matches(a, entry)) { fire(a, rec, entry); return; }
}
function dismiss() {
  if (!active) return;
  active = null; render();
  if (freed && BF.player && BF.player.relock) BF.player.relock();   // only from a key press or click: browsers need one for the lock
  freed = false;
}

// A standing spot a few blocks from the event with room for the player, then turn to face it.
function teleport() {
  if (!active || !active.entry[3]) return;
  const [ex, ey, ez] = active.entry[3], W = BF.world, P = BF.player;
  const fits = (x, y, z) => W.isSolid(x, y - 1, z) && !W.isSolid(x, y, z) && !W.isSolid(x, y + 1, z);
  let spot = null;
  for (const r of [4, 3, 5, 2, 6]) {
    for (let i = 0; i < 8 && !spot; i++) {
      const a = i * Math.PI / 4, x = Math.round(ex + Math.sin(a) * r), z = Math.round(ez + Math.cos(a) * r);
      if (!W.isLoaded(x, z)) continue;
      for (let dy = 0; dy <= 6 && !spot; dy++) for (const y of dy ? [ey + dy, ey - dy] : [ey]) if (fits(x, y, z)) { spot = { x, y, z }; break; }
    }
    if (spot) break;
  }
  if (!spot) {   // nothing nearby: on top of the event's own column
    let y = ey;
    while (y < BF.H - 2 && !(fits(ex, y, ez))) y++;
    spot = { x: ex, y, z: ez };
  }
  P.teleport(spot.x + 0.5, spot.y + 0.01, spot.z + 0.5);
  const dx = ex + 0.5 - (spot.x + 0.5), dz = ez + 0.5 - (spot.z + 0.5), dy = ey + 0.5 - (spot.y + P.eye);
  if (P.setLook) P.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  freed = false;
  if (P.relock) P.relock();   // the click on Teleport counts as the gesture the pointer lock needs
  render();
}

// any speed change out of 0x (Right arrow, or a command) dismisses the alert
function hook() { if (BF.on) BF.on("warpResume", dismiss); else setTimeout(hook, 0); }
hook();
if (document.body) ui(); else addEventListener("DOMContentLoaded", ui);
requestAnimationFrame(tick);

BF.alerts = {
  // from the debug server: [{ id, who, act, kind, text, on }]
  set(l, v) { list = Array.isArray(l) ? l.filter(a => a && a.id) : []; av = v == null ? null : v; },
  get list() { return list; },
  get av() { return av; },
  get active() { return active; },
  hits, check, fire, dismiss, teleport,
};
})();
