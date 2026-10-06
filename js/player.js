// First-person player: input (keyboard/mouse/pointer lock/touch), physics, camera, block
// breaking/placing, attacking mobs, survival stats (health/hunger/air), HUD and menus.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// ---------- tuning ----------
const GRAVITY = 32, JUMP_V = 8.4, WALK = 4.3, SPRINT = 5.6, SNEAK = 1.3;
const TURBO_MULT = 10, TURBO_LOOKAHEAD = 3;   // boost (fly + hold W, then hold E): 10x the normal flying speed
const FLY = 10.9, FLY_SPRINT = 21.6, CFLY = 16, CFLY_SPRINT = 32, SWIM = 2.2, REACH = 5, MOB_REACH = 3.5;
const BASE_FOV = 75, AIR_MAX = 10, ATTACK_CD = 0.4, EAT_TIME = 1.2, PLACE_REPEAT = 0.22;
const HW = 0.3, HEIGHT = 1.8, EYE = 1.62, SNEAK_EYE = 1.47;

// ---------- state ----------
const pos = new THREE.Vector3(8, 80, 8);
const vel = { x: 0, y: 0, z: 0 };
const keys = new Set();
let yaw = -0.8, pitch = -0.3;
let started = false;          // start screen dismissed
let locked = false;           // pointer lock active
let lockWorked = false;       // pointer lock succeeded at least once
let dragMode = false;         // fallback look mode (no pointer lock)
let menuOpen = null;          // null | "start" | "pause" | "death"
let waitingForChunk = true;   // spawn: no physics until the ground is loaded
let onGround = false, inWater = false, headInWater = false;
let flying = false, sprinting = false, sneaking = false, turbo = false;
let lastSpaceTap = 0, lastWTap = 0, wTaps = 0, boostE = false;   // boostE: E went down while flying with W held, so it boosts instead of opening the inventory
let fallStart = null;
let eyeOffset = EYE, bobPhase = 0, bobAmt = 0, fov = BASE_FOV;
let exhaustion = 0, saturation = 5, regenT = 0, starveT = 0, drownT = 0, air = AIR_MAX;
let hurtCd = 0, flashT = 0, attackCd = 0, swingT = 0;
let mouseL = false, mouseR = false;
let breakTarget = null, breakProgress = 0, breakCd = 0;
let placeCd = 0, eatT = 0;
let target = null;            // current block raycast hit
const VIEW_OPTS = [4, 6, 8, 10, 12, 16, 20, 24];
const store = {
  get(k) { try { return localStorage.getItem("blockfield." + k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem("blockfield." + k, String(v)); } catch (_) {} },
};
let gameMode = store.get("gameMode") === "creative" ? "creative" : "survival";
const creative = () => gameMode === "creative";
const isTouch = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);

const P = (BF.player = {
  position: pos,
  velocity: vel,
  halfWidth: HW, height: HEIGHT, eye: EYE,
  health: 20, maxHealth: 20, hunger: 20, maxHunger: 20, dead: false,
  get flying() { return flying; },
  get onGround() { return onGround; },
  get inWater() { return inWater; },
  get headInWater() { return headInWater; },
  get sneaking() { return sneaking; },
  get sprinting() { return sprinting; },
  get turbo() { return turbo; },
  get air() { return air; },
  get target() { return target; },
  get yaw() { return yaw; },
  get gameMode() { return gameMode; },
  set gameMode(m) { setGameMode(m); },
  get pitch() { return pitch; },
});

// ---------- small helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = () => BF.inventory || {};
const invOpen = () => { try { return !!(inv().isOpen && inv().isOpen()) || !!(BF.commands && BF.commands.isOpen()) || !!(BF.signs && BF.signs.isOpen()) || !!(BF.mapview && BF.mapview.isOpen()); } catch (_) { return false; } }; // the command line (commands.js) counts as a screen
const selectedItem = () => {
  try { const s = inv().selected && inv().selected(); return s && s.count > 0 ? s : null; } catch (_) { return null; }
};
const emit = (...a) => { if (BF.emit) BF.emit(...a); };
const canvas = () => BF.renderer.domElement;

// ---------- CSS ----------
const css = `
.bfp-cross{position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none!important;mix-blend-mode:difference}
.bfp-cross::before,.bfp-cross::after{content:"";position:absolute;background:#fff}
.bfp-cross::before{left:10px;top:0;width:2px;height:22px}
.bfp-cross::after{top:10px;left:0;height:2px;width:22px}
.bfp-hud{position:fixed;left:50%;bottom:calc(14px + min(44px, calc((100vw - 24px) / 9)) + env(safe-area-inset-bottom,0px));transform:translateX(-50%);pointer-events:none!important;image-rendering:pixelated;width:min(396px, calc(100vw - 24px));aspect-ratio:198/20;height:auto}
.bfp-tint{position:fixed;inset:0;pointer-events:none!important;background:rgba(16,44,130,.55);display:none}
.bfp-flash{position:fixed;inset:0;pointer-events:none!important;background:radial-gradient(ellipse at center,rgba(200,20,10,.08) 30%,rgba(200,20,10,.6) 100%);opacity:0}
.bfp-screen{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:50;padding:16px;box-sizing:border-box;overflow:auto}
.bfp-screen.on{display:flex}
.bfp-start{background:linear-gradient(180deg,rgba(14,19,16,.45),rgba(14,19,16,.8))}
.bfp-pause{background:rgba(10,12,11,.55)}
.bfp-death{background:rgba(120,10,6,.5)}
.bfp-card{background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:22px 24px;max-width:440px;width:100%;box-sizing:border-box;text-align:center;color:var(--ink);margin:auto}
.bfp-title{font:400 44px/1 var(--display);letter-spacing:1px;margin:0 0 8px;color:var(--ink);text-shadow:3px 3px 0 #2d4a1a}
.bfp-death .bfp-title{text-shadow:3px 3px 0 #3a0a06}
.bfp-sub{font:400 13px/1.3 var(--display);color:var(--accent);margin:0 0 14px}
.bfp-card button{font:400 14px/1 var(--display);background:#3b4a35;color:var(--ink);border:1px solid var(--panel-edge);border-bottom:3px solid rgba(0,0,0,.45);padding:11px 14px;border-radius:3px;cursor:pointer;width:100%;margin:5px 0;box-sizing:border-box}
.bfp-card button:hover,.bfp-card button:focus-visible{background:#4f6a3f;outline:none}
.bfp-card button.primary{background:var(--accent);color:#14200c}
.bfp-card button.primary:hover{background:#93d25e}
.bfp-row{display:flex;gap:8px;margin:10px 0 0}
.bfp-row input{flex:1;min-width:0;font:13px var(--mono);background:rgba(0,0,0,.35);color:var(--ink);border:1px solid var(--panel-edge);border-radius:3px;padding:8px 10px}
.bfp-row button{width:auto;margin:0;white-space:nowrap}
.bfp-help{text-align:left;margin:12px 0 2px;font:12px/1.7 var(--mono);color:var(--muted);columns:2;column-gap:18px}
.bfp-help b{color:var(--ink);font-weight:500}
.bfp-help div{break-inside:avoid}
.bfp-play{font:400 18px/1 var(--display);color:var(--ink);margin:12px 0 6px;animation:bfp-blink 1.6s ease-in-out infinite}
@keyframes bfp-blink{50%{opacity:.45}}
.bfp-mode{display:flex;gap:0;margin:10px 0 0;border:1px solid var(--panel-edge);border-radius:3px;overflow:hidden}
.bfp-card .bfp-mode button{margin:0;border:0;border-radius:0;background:rgba(0,0,0,.3);color:var(--muted);border-bottom:3px solid transparent}
.bfp-card .bfp-mode button.on{background:#3b4a35;color:var(--ink);border-bottom-color:var(--accent)}
.bfp-modehint{font:12px var(--mono);color:var(--muted);margin:6px 0 0;min-height:1em}
.bfp-card.bfp-wide{max-width:520px}
.bfp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 8px;font:400 15px/1 var(--display);color:var(--ink);text-align:left}
.bfp-card button.bfp-small{width:auto;margin:0;padding:8px 10px;font-size:12px}
.bfp-worlds{max-height:min(46vh,340px);overflow:auto;border:1px solid var(--panel-edge);border-radius:3px;background:rgba(0,0,0,.25);text-align:left}
.bfp-world{display:flex;align-items:center;gap:10px;padding:9px 10px;border-bottom:1px solid rgba(255,255,255,.07)}
.bfp-world:last-child{border-bottom:0}
.bfp-world .bfp-info{flex:1;min-width:0}
.bfp-wname{font:400 14px/1.2 var(--display);color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfp-wmeta{font:11px/1.5 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfp-wmeta b{color:var(--accent);font-weight:500}
.bfp-wbtns{display:flex;gap:6px;flex-shrink:0}
.bfp-card .bfp-wbtns button{width:auto;margin:0;padding:7px 9px;font-size:11px}
.bfp-card .bfp-wbtns button.danger{background:var(--danger);color:#fff}
.bfp-world input{width:100%;box-sizing:border-box;font:13px var(--mono);background:rgba(0,0,0,.4);color:var(--ink);border:1px solid var(--accent);border-radius:3px;padding:6px 8px}
.bfp-world.confirm{background:rgba(224,83,61,.14)}
.bfp-empty{font:12px var(--mono);color:var(--muted);padding:16px 12px;margin:0;text-align:center}
.bfp-savenote{font:12px var(--mono);color:var(--muted);margin:8px 0 0;min-height:0}
.bfp-savenote:empty{display:none}
.bfp-credit{margin:10px 0 0;font:11px var(--mono);color:var(--muted);text-align:center;opacity:.85}.bfp-credit a{color:inherit;text-decoration:underline}
.bfp-field{display:block;text-align:left;font:12px var(--mono);color:var(--muted);margin:10px 0 0}
.bfp-field input{display:block;width:100%;box-sizing:border-box;margin-top:4px;font:13px var(--mono);background:rgba(0,0,0,.35);color:var(--ink);border:1px solid var(--panel-edge);border-radius:3px;padding:8px 10px}
.bfp-field .bfp-mode{margin-top:4px}
.bfp-field input[type=range]{padding:0;border:0;background:none;accent-color:var(--accent);cursor:pointer}
.bfp-field .bfp-hint{display:block;margin-top:2px;font-size:11px;opacity:.8}
.bfp-view-create>button.primary{margin-top:14px}
.bfp-ctl{margin-top:10px;text-align:left}
.bfp-ctl summary{cursor:pointer;font:12px var(--mono);color:var(--muted)}
.bfp-saved{font:11px var(--mono);color:var(--muted);margin-top:4px;min-height:1em}
@media (max-width:520px){.bfp-world{flex-wrap:wrap}.bfp-wbtns{width:100%}.bfp-card .bfp-wbtns button{flex:1}}
.bfp-note{font:12px var(--mono);color:var(--muted);margin-top:8px;min-height:1em}
.bfp-touch{position:fixed;inset:0;pointer-events:none!important;display:none}
.bfp-touch.on{display:block}
.bfp-touch>*{pointer-events:auto;position:absolute;touch-action:none}
.bfp-stick{left:calc(22px + env(safe-area-inset-left,0px));bottom:calc(24px + env(safe-area-inset-bottom,0px));width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.25)}
.bfp-knob{position:absolute;left:36px;top:36px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.35);pointer-events:none}
.bfp-tbtn{width:58px;height:58px;border-radius:8px;background:rgba(255,255,255,.12);border:2px solid rgba(255,255,255,.28);color:#fff;font:400 11px/1 var(--display);display:flex;align-items:center;justify-content:center;user-select:none;-webkit-user-select:none}
.bfp-tbtn.down{background:rgba(255,255,255,.32)}
.bfp-jump{right:calc(22px + env(safe-area-inset-right,0px));bottom:calc(96px + env(safe-area-inset-bottom,0px))}
.bfp-sneak{right:calc(88px + env(safe-area-inset-right,0px));bottom:calc(96px + env(safe-area-inset-bottom,0px))}
.bfp-tinv{right:calc(16px + env(safe-area-inset-right,0px));top:calc(16px + env(safe-area-inset-top,0px));width:46px;height:40px}
.bfp-tpause{right:calc(70px + env(safe-area-inset-right,0px));top:calc(16px + env(safe-area-inset-top,0px));width:46px;height:40px}
@media (max-width:520px){.bfp-help{columns:1}.bfp-title{font-size:34px}}
`;

// ---------- DOM ----------
const BIOME_SIZES = [[1, "Small (classic)"], [2, "Large"], [3, "Larger"], [4.5, "Huge"], [6, "Vast"]], BIOME_DEF = 1;   // biomeScale, label
const biomeLabel = s => (BIOME_SIZES.find(b => b[0] === s) || [0, "Large"])[1];
let savedEl, worldsEl, createForm, createMode = null, worldsCache = [], saveOk = null;
let ui, crossEl, hudCanvas, hudCtx, tintEl, flashEl, startEl, pauseEl, deathEl, touchEl, knobEl, pauseNote, viewBtn, helpEl;
const HELP_HTML = isTouch
  ? `<div><b>Stick</b> move</div><div><b>Drag</b> look</div><div><b>Tap</b> place / use / hit</div><div><b>Hold</b> break</div><div><b>Jump x2</b> fly</div><div><b>INV</b> inventory</div>`
  : `<div><b>WASD</b> move</div><div><b>Mouse</b> look</div><div><b>Space</b> jump / swim</div><div><b>Space x2</b> fly</div>
     <div><b>Shift</b> sneak</div><div><b>R / W x2</b> sprint</div><div><b>Fly + hold W, then E</b> 10x boost</div><div><b>L-click</b> break / hit</div><div><b>R-click</b> place / use / eat</div>
     <div><b>1-9 / wheel</b> hotbar</div><div><b>E</b> inventory</div><div><b>Q</b> drop item</div><div><b>Esc</b> pause, <b>F3</b> debug</div><div><b>/</b> command line</div>`;

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function buildDOM() {
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  ui = document.getElementById("ui") || document.body;
  tintEl = el("div", "bfp-tint"); ui.appendChild(tintEl);
  flashEl = el("div", "bfp-flash"); ui.appendChild(flashEl);
  crossEl = el("div", "bfp-cross"); ui.appendChild(crossEl);
  hudCanvas = el("canvas", "bfp-hud"); hudCanvas.width = 198; hudCanvas.height = 20; ui.appendChild(hudCanvas);
  hudCtx = hudCanvas.getContext("2d");

  const modeRow = `<div class="bfp-mode" role="group" aria-label="Game mode"><button type="button" data-act="mode" data-mode="survival">Survival</button><button type="button" data-act="mode" data-mode="creative">Creative</button></div><p class="bfp-modehint"></p>`;
  startEl = el("div", "bfp-screen bfp-start", `<div class="bfp-card bfp-wide">
    <h1 class="bfp-title">Blockfield</h1><p class="bfp-sub">a blocky survival sandbox</p>
    <div class="bfp-view-list">
      <div class="bfp-head"><span>Singleplayer</span><button data-act="show-create" class="primary bfp-small">Create New World</button></div>
      <div class="bfp-worlds" role="list"><p class="bfp-empty">Loading worlds…</p></div>
      <p class="bfp-savenote"></p>
      <p class="bfp-credit">Block textures: <a href="https://faithfulpack.net" target="_blank" rel="noopener noreferrer">Faithful 32x</a> © Faithful Resource Pack, used under the <a href="https://faithfulpack.net/license" target="_blank" rel="noopener noreferrer">Faithful License</a>.</p>
      <details class="bfp-ctl"><summary>Controls</summary><div class="bfp-help">${HELP_HTML}</div></details>
    </div>
    <form class="bfp-view-create" hidden autocomplete="off">
      <div class="bfp-head"><span>Create New World</span></div>
      <label class="bfp-field">World name<input name="name" maxlength="40" value="New World" spellcheck="false"></label>
      <label class="bfp-field">Seed<input name="seed" placeholder="Leave blank for a random seed" spellcheck="false"></label>
      <label class="bfp-field">Biome size: <b class="bfp-bsl">${BIOME_SIZES[BIOME_DEF][1]}</b><input name="biome" type="range" min="0" max="${BIOME_SIZES.length - 1}" step="1" value="${BIOME_DEF}"><span class="bfp-hint">Relative size of biomes and climate zones. Small matches older worlds.</span></label>
      <div class="bfp-field">Game mode${modeRow}</div>
      <button class="primary" type="submit">Create and play</button>
      <button type="button" data-act="hide-create">Back</button>
      <p class="bfp-savenote"></p>
    </form></div>`);
  pauseEl = el("div", "bfp-screen bfp-pause", `<div class="bfp-card">
    <h2 class="bfp-title" style="font-size:30px">Paused</h2>
    <button class="primary" data-act="resume">Resume</button>
    <button data-act="view">Render distance: 6</button>
    ${modeRow}
    <button data-act="help">Controls</button>
    <div class="bfp-help" hidden>${HELP_HTML}</div>
    <button data-act="quit">Save and Quit to Title</button>
    <div class="bfp-note"></div><div class="bfp-saved"></div></div>`);
  deathEl = el("div", "bfp-screen bfp-death", `<div class="bfp-card">
    <h2 class="bfp-title">You died!</h2><p class="bfp-sub" style="color:var(--muted)"></p>
    <button class="primary" data-act="respawn">Respawn</button></div>`);
  for (const e of [startEl, pauseEl, deathEl]) ui.appendChild(e);
  viewBtn = pauseEl.querySelector('[data-act="view"]');
  pauseNote = pauseEl.querySelector(".bfp-note");
  helpEl = pauseEl.querySelector(".bfp-help");
  savedEl = pauseEl.querySelector(".bfp-saved");
  worldsEl = startEl.querySelector(".bfp-worlds");
  createForm = startEl.querySelector(".bfp-view-create");

  startEl.addEventListener("click", e => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act, row = act.closest("[data-id]"), id = row && row.dataset.id;
    if (a === "mode") { createMode = act.dataset.mode; updateModeUI(); }
    else if (a === "show-create") showStartView("create");
    else if (a === "hide-create") showStartView("list");
    else if (a === "play") playWorld(id, act);
    else if (a === "rename") renderWorlds({ renaming: id });
    else if (a === "rename-ok") finishRename(row);
    else if (a === "delete") renderWorlds({ deleting: id });
    else if (a === "delete-ok") { Promise.resolve(BF.save.remove(id)).catch(err => console.error(err)).then(() => refreshWorlds()); }
    else if (a === "cancel") renderWorlds({});
  });
  startEl.addEventListener("keydown", e => {
    e.stopPropagation();
    const row = e.target.closest && e.target.closest("[data-id]");
    if (row && e.target.tagName === "INPUT") {
      if (e.key === "Enter") { e.preventDefault(); finishRename(row); }
      else if (e.key === "Escape") renderWorlds({});
    }
  });
  startEl.addEventListener("keyup", e => e.stopPropagation());
  const biomeIn = createForm.elements.biome, biomeLbl = createForm.querySelector(".bfp-bsl");
  biomeIn.addEventListener("input", () => { biomeLbl.textContent = BIOME_SIZES[biomeIn.value | 0][1]; });
  createForm.addEventListener("submit", e => { e.preventDefault(); createWorld(); });
  pauseEl.addEventListener("click", e => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "resume") resume();
    else if (a === "view") {
      const i = VIEW_OPTS.indexOf(BF.world.viewDist);
      setViewDist(i < 0 ? VIEW_OPTS.find(v => v > BF.world.viewDist) || VIEW_OPTS[0] : VIEW_OPTS[(i + 1) % VIEW_OPTS.length]);
    } else if (a === "mode") setGameMode(act.dataset.mode);
    else if (a === "help") helpEl.hidden = !helpEl.hidden;
    else if (a === "quit") quitToTitle(act);
  });
  deathEl.addEventListener("click", e => { if (e.target.closest('[data-act="respawn"]')) respawn(); });

  // touch controls
  touchEl = el("div", "bfp-touch", `<div class="bfp-stick"><div class="bfp-knob"></div></div>
    <div class="bfp-tbtn bfp-jump" data-t="jump">JUMP</div><div class="bfp-tbtn bfp-sneak" data-t="sneak">SNEAK</div>
    <div class="bfp-tbtn bfp-tinv" data-t="inv">INV</div><div class="bfp-tbtn bfp-tpause" data-t="pause">II</div>`);
  ui.appendChild(touchEl);
  knobEl = touchEl.querySelector(".bfp-knob");
}

function updateViewBtn() {
  const d = BF.world.viewDist;
  if (viewBtn) viewBtn.textContent = `Render distance: ${d} chunks (${d * (BF.CS || 16)} blocks)`;
}
// Sets the render distance, keeps the camera far plane beyond it, and remembers the choice.
function setViewDist(d, persist = true) {
  d = Math.max(2, Math.min(32, d | 0));
  try { BF.world.setViewDist(d); } catch (e) { console.error(e); }
  updateFar();
  if (persist) store.set("viewDist", d);
  updateViewBtn();
}
function updateFar() {
  const need = (BF.world.viewDist || 6) * (BF.CS || 16) * 1.5 + 32;
  if (BF.camera && BF.camera.far < need) { BF.camera.far = need; BF.camera.updateProjectionMatrix(); }
}
const MODE_HINT = {
  survival: "Gather, craft and stay alive.",
  creative: "Fly, build freely, no damage. Blocks break instantly.",
};
function updateModeUI() {
  for (const b of document.querySelectorAll(".bfp-mode button")) {
    const on = b.dataset.mode === (startEl && startEl.contains(b) ? (createMode || gameMode) : gameMode);
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
  }
  for (const h of document.querySelectorAll(".bfp-modehint")) h.textContent = MODE_HINT[startEl && startEl.contains(h) ? (createMode || gameMode) : gameMode];
  hudKey = "";
}
function setGameMode(m) {
  m = m === "creative" ? "creative" : "survival";
  const changed = m !== gameMode;
  gameMode = m;
  store.set("gameMode", m);
  if (creative()) {
    P.health = P.maxHealth; P.hunger = P.maxHunger; air = AIR_MAX; fallStart = null;
    drownT = starveT = 0; flashT = 0;
  }
  resetBreak();
  updateModeUI();
  if (changed) emit("gameModeChanged", m);
}

function parseSeed(s) {
  s = (s || "").trim();
  if (!s) return (Math.random() * 2 ** 31) >>> 0;
  if (/^\d+$/.test(s)) return (+s) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function newWorldFrom(inputId) {
  const i = document.getElementById(inputId);
  const seed = parseSeed(i && i.value);
  try { BF.newWorld(seed); } catch (e) { console.error(e); }
  if (i) i.value = "";
}

function showScreen(name) {
  menuOpen = name;
  startEl.classList.toggle("on", name === "start");
  pauseEl.classList.toggle("on", name === "pause");
  deathEl.classList.toggle("on", name === "death");
  if (name === "pause") { updateViewBtn(); updateModeUI(); pauseNote.textContent = ""; savePause(); }
  if (name === "start") { showStartView("list"); refreshWorlds(); }
  touchEl.classList.toggle("on", isTouch && started && !name);
}

// ---------- saved worlds (start screen) ----------
const hasSave = () => !!(BF.save && BF.save.list);
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtDate(ms) {
  if (!ms) return "never";
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "today " + time;
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) + " " + time;
}
function probeStorage() {
  if (saveOk !== null) return Promise.resolve(saveOk);
  if (!hasSave() || BF.save.supported === false || typeof indexedDB === "undefined") return Promise.resolve((saveOk = false));
  return new Promise(res => {
    try {
      const r = indexedDB.open("blockfield-probe");
      r.onsuccess = () => { try { r.result.close(); } catch (_) {} res((saveOk = true)); };
      r.onerror = () => res((saveOk = false));
      r.onblocked = () => res((saveOk = true));
    } catch (_) { res((saveOk = false)); }
  });
}
function setSaveNote() {
  const t = saveOk === false ? "Saving unavailable in this browser. You can still play; worlds won't be kept." : "";
  for (const n of startEl.querySelectorAll(".bfp-savenote")) n.textContent = t;
}
function showStartView(v) {
  startEl.querySelector(".bfp-view-list").hidden = v !== "list";
  createForm.hidden = v !== "create";
  if (v === "create") {
    createMode = createMode || gameMode;
    createForm.elements.name.value = "New World";
    createForm.elements.seed.value = "";
    createForm.elements.biome.value = BIOME_DEF; createForm.querySelector(".bfp-bsl").textContent = BIOME_SIZES[BIOME_DEF][1];
    updateModeUI();
    setTimeout(() => { try { createForm.elements.name.select(); } catch (_) {} }, 0);
  }
}
function refreshWorlds() {
  probeStorage().then(setSaveNote);
  if (!hasSave()) { worldsCache = []; renderWorlds({}); return Promise.resolve(); }
  return Promise.resolve(BF.save.list()).catch(() => []).then(list => { worldsCache = list || []; renderWorlds({}); });
}
function renderWorlds(st) {
  if (!worldsCache.length) {
    worldsEl.innerHTML = `<p class="bfp-empty">No saved worlds yet. Create one to start playing.</p>`;
    return;
  }
  worldsEl.innerHTML = worldsCache.map(w => {
    const id = esc(w.id), meta = `${fmtDate(w.lastPlayed)} · <b>${w.gameMode === "creative" ? "Creative" : "Survival"}</b> · seed ${esc(w.seed)}${w.gen >= 2 ? " · " + biomeLabel(w.biomeScale) + " biomes" : ""}`;
    if (st.renaming === w.id) return `<div class="bfp-world" role="listitem" data-id="${id}">
      <div class="bfp-info"><input value="${esc(w.name)}" maxlength="40" aria-label="New world name"></div>
      <div class="bfp-wbtns"><button class="primary" data-act="rename-ok">Save</button><button data-act="cancel">Cancel</button></div></div>`;
    if (st.deleting === w.id) return `<div class="bfp-world confirm" role="listitem" data-id="${id}">
      <div class="bfp-info"><div class="bfp-wname">Delete “${esc(w.name)}”?</div><div class="bfp-wmeta">This can't be undone.</div></div>
      <div class="bfp-wbtns"><button class="danger" data-act="delete-ok">Delete</button><button data-act="cancel">Cancel</button></div></div>`;
    return `<div class="bfp-world" role="listitem" data-id="${id}">
      <div class="bfp-info"><div class="bfp-wname">${esc(w.name)}</div><div class="bfp-wmeta">${meta}</div></div>
      <div class="bfp-wbtns"><button class="primary" data-act="play">Play</button><button data-act="rename">Rename</button><button data-act="delete">Delete</button></div></div>`;
  }).join("");
  const inp = worldsEl.querySelector("input");
  if (inp) { inp.focus(); inp.select(); }
}
function finishRename(row) {
  const id = row.dataset.id, inp = row.querySelector("input"), name = inp && inp.value.trim();
  if (!name) { renderWorlds({}); return; }
  Promise.resolve(BF.save.rename(id, name)).catch(e => console.error(e)).then(() => refreshWorlds());
}
function startNote(t) { for (const n of startEl.querySelectorAll(".bfp-savenote")) n.textContent = t; }
function playWorld(id, btn) {
  if (!hasSave() || !id) return;
  requestLock();                       // inside the click so the browser allows it
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  Promise.resolve(BF.save.load(id)).then(() => beginPlay()).catch(e => {
    console.error(e); exitLock();
    if (btn) { btn.disabled = false; btn.textContent = "Play"; }
    startNote("Couldn't load that world: " + (e && e.message || e));
  });
}
function createWorld() {
  const f = createForm.elements;
  const name = f.name.value.trim() || "New World", seedText = f.seed.value.trim(), mode = createMode || gameMode;
  const biomeScale = BIOME_SIZES[f.biome.value | 0][0];
  requestLock();
  const btn = createForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  const done = () => { btn.disabled = false; beginPlay(); };
  if (hasSave() && BF.save.create) {
    Promise.resolve(BF.save.create({ name, seed: seedText, gameMode: mode, biomeScale })).catch(e => { console.error(e); }).then(done);
  } else {
    try { BF.newWorld(parseSeed(seedText), { gameMode: mode, biomeScale }); } catch (e) { console.error(e); }
    setGameMode(mode);
    done();
  }
}
function savePause() {
  if (!hasSave() || !BF.save.saveNow) { savedEl.textContent = ""; return Promise.resolve(false); }
  if (!BF.save.current) { savedEl.textContent = "This world isn't saved"; return Promise.resolve(false); }
  savedEl.textContent = "Saving…";
  return Promise.resolve(BF.save.saveNow()).catch(() => false).then(ok => { updateSavedLabel(ok); return ok; });
}
function updateSavedLabel(ok) {
  if (!savedEl) return;
  const t = BF.save && BF.save.lastSaved;
  if (ok === false && !(BF.save && BF.save.current)) savedEl.textContent = "This world isn't saved";
  else if (ok === false) savedEl.textContent = "Couldn't save" + (t ? " · last saved " + fmtDate(t) : "");
  else savedEl.textContent = t ? "Saved " + new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}
function quitToTitle(btn) {
  btn.disabled = true; btn.textContent = "Saving…";
  savePause().then(() => {
    btn.disabled = false; btn.textContent = "Save and Quit to Title";
    if (BF.save) BF.save.current = null;     // the world stays as the title background, unsaved
    started = false;
    keys.clear(); mouseL = mouseR = false; resetBreak();
    exitLock();
    BF.state.paused = false;
    showScreen("start");
  });
}

// ---------- pointer lock ----------
function requestLock() {
  if (isTouch) return;
  const cv = canvas();
  if (!cv.requestPointerLock) { dragMode = true; return; }
  try {
    const r = cv.requestPointerLock();
    if (r && r.catch) r.catch(() => onLockError());
  } catch (_) { onLockError(); }
}
function onLockError() {
  if (locked) return;
  if (lockWorked) { if (menuOpen === "pause") pauseNote.textContent = "Click Resume again to capture the mouse."; return; }
  dragMode = true;
  if (menuOpen === "pause") { showScreen(null); BF.state.paused = false; }
}
function exitLock() { try { if (document.pointerLockElement) document.exitPointerLock(); } catch (_) {} }

function beginPlay() {
  started = true;
  showScreen(null);
  BF.state.paused = false;
  if (isTouch) dragMode = true; else requestLock();
}
function resume() {
  if (P.dead) return;
  if (!dragMode && !isTouch) {
    requestLock();
    // the pause menu stays until the lock arrives (pointerlockchange hides it)
    setTimeout(() => {
      if (!locked && menuOpen === "pause" && (dragMode || !lockWorked)) { dragMode = true; showScreen(null); BF.state.paused = false; }
    }, 400);
    return;
  }
  showScreen(null);
  BF.state.paused = false;
}
function pause() {
  if (!started || P.dead || menuOpen) return;
  keys.clear(); mouseL = mouseR = false; resetBreak();
  showScreen("pause");
  BF.state.paused = true;
  exitLock();
}

let expectUnlock = false;     // we released the lock for the inventory: the unlock event must not pause
function openInventory(mode, arg) {
  if (locked) expectUnlock = true;
  keys.clear(); mouseL = mouseR = false; resetBreak();
  try { if (inv().open) inv().open(mode, arg); } catch (e) { console.error(e); }
  exitLock();
}
function closeInventory() {
  try { if (inv().close) inv().close(); } catch (e) { console.error(e); }
  if (!dragMode && !isTouch && started && !menuOpen) requestLock();
}
// Toggle after the other keydown listeners ran, so an inventory module that also handles E/Esc doesn't double-toggle.
function deferredToggle(closeOnly) {
  const was = invOpen();
  setTimeout(() => {
    if (invOpen() !== was) { if (!invOpen() && !dragMode && !isTouch && !menuOpen) requestLock(); return; }
    if (was) closeInventory(); else if (!closeOnly) openInventory();
  }, 0);
}

// ---------- input ----------
function bindInput() {
  const cv = canvas();
  addEventListener("keydown", e => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const c = e.code;
    if (c === "Space" || c === "Tab" || (e.ctrlKey && /^Key[WASDQE]$/.test(c))) e.preventDefault();
    if (c === "Escape") {
      if (invOpen()) { deferredToggle(true); return; }
      if ((dragMode || !locked) && started && !P.dead) { if (menuOpen === "pause") resume(); else if (!menuOpen) pause(); }
      return;
    }
    // inventory.js handles E/Esc itself (capture phase) while it is open; deferredToggle copes either way
    if (c === "KeyE" && started && !menuOpen && !P.dead && !e.repeat) {
      // flying with W held: E is the 10x boost (held), not the inventory key. In every other case E opens/closes the inventory.
      if (flying && !invOpen() && (keys.has("KeyW") || keys.has("ArrowUp"))) { boostE = true; e.preventDefault(); return; }
      deferredToggle(false); return;
    }
    if (menuOpen || invOpen() || P.dead) return;
    if (e.repeat) { keys.add(c); return; }
    const now = performance.now();
    if (c === "Space") {
      if (now - lastSpaceTap < 300) { flying = !flying; vel.y = 0; lastSpaceTap = 0; } else lastSpaceTap = now;
    }
    if (c === "KeyW") {
      wTaps = now - lastWTap < 300 ? wTaps + 1 : 1;
      if (wTaps >= 2) sprinting = true;
      lastWTap = now;
    }
    if (c === "KeyQ") { try { if (selectedItem() && inv().consumeSelected) inv().consumeSelected(1); } catch (_) {} }
    keys.add(c);
  });
  addEventListener("keyup", e => { keys.delete(e.code); if (e.code === "KeyE") boostE = false; });
  addEventListener("blur", () => { boostE = false; keys.clear(); mouseL = mouseR = false; });

  document.addEventListener("pointerlockchange", () => {
    const was = locked;
    locked = document.pointerLockElement === cv;
    if (locked) {
      lockWorked = true; dragMode = false;
      if (menuOpen === "pause") { showScreen(null); BF.state.paused = false; }
    } else if (was) {
      keys.clear(); mouseL = mouseR = false; resetBreak();
      if (expectUnlock) { expectUnlock = false; if (!invOpen() && started && !menuOpen && !P.dead) requestLock(); }
      else if (!invOpen() && !P.dead && started && !menuOpen) pause();
    }
  });
  document.addEventListener("pointerlockerror", onLockError);
  if (BF.on) BF.on("inventoryClosed", () => {
    if (started && !menuOpen && !P.dead && !dragMode && !isTouch && !locked) requestLock();
  });

  document.addEventListener("mousemove", e => { if (locked) look(e.movementX, e.movementY); });

  // Drag-to-look fallback when there is no pointer lock (mouse or pen; touch handled separately)
  let drag = null;
  cv.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch" || !started || menuOpen || invOpen()) return;
    if (e.button !== 0 && locked === false && dragMode) return; // right / middle click must not start a look-drag
    if (!locked && !dragMode) requestLock();
    if (!locked) drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id || locked) return;
    look(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  addEventListener("pointerup", e => { if (drag && e.pointerId === drag.id) drag = null; });

  let ctrlRight = false;
  cv.addEventListener("mousedown", e => {
    if (!started || menuOpen || P.dead || invOpen()) return;
    if (!locked && !dragMode) return; // this click only captures the mouse
    e.preventDefault();
    if (e.button === 0 && e.ctrlKey && /Mac/.test(navigator.platform || "")) { ctrlRight = true; mouseR = true; placeCd = 0; secondaryDown(); } // macOS ctrl+click = right click
    else if (e.button === 0) { mouseL = true; primaryDown(); }
    else if (e.button === 2) { mouseR = true; placeCd = 0; secondaryDown(); }
    else if (e.button === 1) pickBlock();
  });
  addEventListener("mouseup", e => {
    if (e.button === 0) { mouseL = false; resetBreak(); if (ctrlRight) { ctrlRight = false; mouseR = false; eatT = 0; } }
    if (e.button === 2) { mouseR = false; eatT = 0; }
  });
  cv.addEventListener("contextmenu", e => e.preventDefault());
  addEventListener("wheel", e => {
    if (!started || menuOpen || invOpen() || !e.deltaY) return;
    const I = inv(); if (!I.select) return;
    const cur = I.selectedIndex | 0;
    I.select((cur + (e.deltaY > 0 ? 1 : -1) + 9) % 9);
  }, { passive: true });

  if (isTouch) bindTouch(cv);
}

function look(dx, dy) {
  yaw -= dx * 0.0024;
  pitch = clamp(pitch - dy * 0.0024, -1.55, 1.55);
}

// ---------- touch ----------
const stick = { x: 0, y: 0, id: null };
const touchKeys = new Set();
const touches = new Map();
function bindTouch(cv) {
  const stickEl = touchEl.querySelector(".bfp-stick");
  const setStick = e => {
    const r = stickEl.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    stick.x = dx; stick.y = dy;
    knobEl.style.transform = `translate(${dx * 38}px,${dy * 38}px)`;
  };
  stickEl.addEventListener("pointerdown", e => { stick.id = e.pointerId; try { stickEl.setPointerCapture(e.pointerId); } catch (_) {} setStick(e); e.preventDefault(); });
  stickEl.addEventListener("pointermove", e => { if (e.pointerId === stick.id) setStick(e); });
  const endStick = e => { if (e.pointerId !== stick.id) return; stick.id = null; stick.x = stick.y = 0; knobEl.style.transform = ""; };
  stickEl.addEventListener("pointerup", endStick); stickEl.addEventListener("pointercancel", endStick);

  for (const b of touchEl.querySelectorAll(".bfp-tbtn")) {
    const t = b.dataset.t;
    b.addEventListener("pointerdown", e => {
      e.preventDefault(); b.classList.add("down");
      if (t === "jump") {
        const now = performance.now();
        if (now - lastSpaceTap < 300) { flying = !flying; vel.y = 0; lastSpaceTap = 0; } else lastSpaceTap = now;
        touchKeys.add("Space");
      } else if (t === "sneak") touchKeys.add("ShiftLeft");
      else if (t === "inv") { if (invOpen()) closeInventory(); else openInventory(); }
      else if (t === "pause") pause();
    });
    const up = () => { b.classList.remove("down"); if (t === "jump") touchKeys.delete("Space"); if (t === "sneak") touchKeys.delete("ShiftLeft"); };
    b.addEventListener("pointerup", up); b.addEventListener("pointercancel", up); b.addEventListener("pointerleave", up);
  }

  // drag = look, short tap = hit / use / place, long press = break
  cv.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch" || !started || menuOpen || P.dead || invOpen()) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false, breaking: false });
  });
  cv.addEventListener("pointermove", e => {
    const t = touches.get(e.pointerId); if (!t) return;
    look((e.clientX - t.x) * 1.6, (e.clientY - t.y) * 1.6);
    t.x = e.clientX; t.y = e.clientY;
    if (Math.hypot(t.x - t.sx, t.y - t.sy) > 12) t.moved = true;
  });
  const end = e => {
    const t = touches.get(e.pointerId); if (!t) return;
    touches.delete(e.pointerId);
    if (t.breaking) { mouseL = false; resetBreak(); return; }
    if (!t.moved && performance.now() - t.t < 300 && e.type === "pointerup" && !tryAttack()) {
      const sel = selectedItem(), it = sel && BF.items[sel.id];
      if (it && it.food) { mouseR = true; placeCd = 0; secondaryDown(); setTimeout(() => { mouseR = false; }, (EAT_TIME + 0.1) * 1000); }
      else secondaryDown();
    }
  };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
}
function touchUpdate() {
  for (const t of touches.values()) {
    if (!t.breaking && !t.moved && performance.now() - t.t > 350) {
      t.breaking = true; mouseL = true;
      if (tryAttack()) mouseL = false;
    }
  }
}

// ---------- three.js objects: outline, cracks, particles, view model ----------
let outline, crackMesh, partGeo, vm, vmMesh, vmKey = -1, hand;
const crackMats = [], particles = [], partMats = {};
function buildScene() {
  const eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
  outline = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
  outline.visible = false;
  BF.scene.add(outline);

  // 10 crack stages drawn on small canvas textures
  for (let s = 0; s < 10; s++) {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const g = c.getContext("2d");
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.fillStyle = "rgba(0,0,0,0.78)";
    const n = 3 + s;
    for (let k = 0; k < n; k++) {
      let x = 7.5 + (rnd() - 0.5) * 4, y = 7.5 + (rnd() - 0.5) * 4;
      const dir = rnd() * Math.PI * 2, len = 3 + s * 1.1;
      for (let i = 0; i < len; i++) {
        x += Math.cos(dir + (rnd() - 0.5) * 1.4); y += Math.sin(dir + (rnd() - 0.5) * 1.4);
        g.fillRect(Math.floor(x), Math.floor(y), 1, 1);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    crackMats.push(new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  }
  crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.008, 1.008, 1.008), crackMats[0]);
  crackMesh.visible = false; crackMesh.renderOrder = 2;
  BF.scene.add(crackMesh);

  partGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);

  // held-item view model, attached to the camera
  vm = new THREE.Group();
  vm.position.set(0.48, -0.42, -0.72);
  BF.camera.add(vm);
  hand = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.5), new THREE.MeshBasicMaterial({ color: 0xc8956b, depthTest: false }));
  hand.rotation.set(0.25, 0.1, 0);
  hand.position.set(0.12, -0.1, 0.16);
}

function blockColor(id) { const b = BF.blocks[id]; return (b && b.color) || "#888"; }

function spawnParticles(x, y, z, id, n = 14) {
  const key = blockColor(id);
  let m = partMats[key];
  if (!m) m = partMats[key] = new THREE.MeshBasicMaterial({ color: new THREE.Color(key) });
  for (let i = 0; i < n; i++) {
    const p = new THREE.Mesh(partGeo, m);
    p.position.set(x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6, z + 0.2 + Math.random() * 0.6);
    p.scale.setScalar(0.6 + Math.random() * 0.8);
    p.userData = { vx: (Math.random() - 0.5) * 3, vy: 1.5 + Math.random() * 3, vz: (Math.random() - 0.5) * 3, life: 0.5 + Math.random() * 0.4 };
    BF.scene.add(p); particles.push(p);
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i], u = p.userData;
    u.life -= dt; u.vy -= 18 * dt;
    p.position.x += u.vx * dt; p.position.z += u.vz * dt;
    const ny = p.position.y + u.vy * dt;
    if (u.vy < 0 && BF.world.isSolid(p.position.x, ny - 0.05, p.position.z)) { u.vy = 0; u.vx *= 0.6; u.vz *= 0.6; } else p.position.y = ny;
    if (u.life <= 0) { BF.scene.remove(p); particles.splice(i, 1); }
  }
  if (particles.length) {
    const l = BF.world.daylight != null ? BF.world.daylight : 1;
    for (const k in partMats) partMats[k].color.set(k).multiplyScalar(l);
  }
}

// held item view model
const iconTex = {};
function cubeGeometry(id) {
  const b = BF.blocks[id];
  const g = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const uv = g.attributes.uv, col = [];
  const faces = ["side", "side", "top", "bottom", "side", "side"];  // BoxGeometry order: +x -x +y -y +z -z
  const shade = [0.8, 0.8, 1, 0.55, 0.68, 0.68];
  for (let f = 0; f < 6; f++) {
    let r = null;
    try { r = BF.textures.uv(b.tiles[faces[f]]); } catch (_) {}
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (r) uv.setXY(i, r[0] + (r[2] - r[0]) * uv.getX(i), r[1] + (r[3] - r[1]) * uv.getY(i));
      col.push(shade[f], shade[f], shade[f]);
    }
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}
function iconTexture(id) {
  if (iconTex[id]) return iconTex[id];
  const t = new THREE.Texture();
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  try {
    const img = new Image();
    img.onload = () => { t.image = img; t.needsUpdate = true; };
    img.src = BF.textures.icon(id);
  } catch (_) {}
  return (iconTex[id] = t);
}
// Held map: fixed relative to the body, not the camera. It sits `fwd` ahead of and `down` below the eye, tilted back by atan(down / fwd) (~61 degrees
// from vertical) so it faces the eye when looking down at it: only its top edge shows when looking straight ahead, and it fills the view when looking down.
const MAP_VM = { size: 0.75, fwd: 0.38, down: 0.7, side: 0.06 };
MAP_VM.tilt = Math.atan2(MAP_VM.down, MAP_VM.fwd);
function setViewModel(sel) {
  const id = sel ? sel.id : 0;
  if (id === vmKey) return;
  vmKey = id;
  if (vmMesh) { vm.remove(vmMesh); if (vmMesh !== hand) { vmMesh.geometry.dispose(); vmMesh.material.dispose(); } }
  const it = BF.items[id];
  if (!id || !it) vmMesh = hand;
  else if (it.isBlock && it.tiles && BF.world.solidMat) {
    const mat = new THREE.MeshBasicMaterial({ map: BF.world.solidMat.map, vertexColors: true, alphaTest: 0.5, depthTest: false, transparent: it.render === "liquid" });
    vmMesh = new THREE.Mesh(cubeGeometry(id), mat);
    vmMesh.rotation.set(0.1, 0.75, 0);
  } else if (BF.maps && BF.maps.textureFor(it)) { // filled map / compass: live canvas texture (js/maps.js)
    const mat = new THREE.MeshBasicMaterial({ map: BF.maps.textureFor(it), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, depthTest: false });
    vmMesh = new THREE.Mesh(new THREE.PlaneGeometry(it.map || it.auto ? MAP_VM.size : 0.3, it.map || it.auto ? MAP_VM.size : 0.3), mat);
    vmMesh.rotation.set(0, it.map || it.auto ? 0 : -0.5, 0);
  } else {
    const mat = new THREE.MeshBasicMaterial({ map: iconTexture(id), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, depthTest: false });
    vmMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), mat);
    vmMesh.rotation.set(0, -0.5, 0.15);
    vmMesh.position.set(0, 0.06, 0);
  }
  vmMesh.renderOrder = 10;
  vm.add(vmMesh);
}
function updateViewModel(dt) {
  const held = selectedItem();
  setViewModel(held);
  const heldIt = held && BF.items[held.id], mapHeld = !!(heldIt && (heldIt.map || heldIt.auto));
  if (heldIt && BF.maps && (heldIt.map || heldIt.auto || heldIt.name === "compass")) { try { BF.maps.heldTexture(heldIt); } catch (e) { console.error(e); } }
  const l = BF.world.daylight != null ? BF.world.daylight : 1;
  if (vmMesh && vmMesh.material && vmMesh.material.color && vmMesh !== hand) vmMesh.material.color.setScalar(Math.max(0.3, l));
  if (vmMesh === hand) hand.material.color.setHex(0xc8956b).multiplyScalar(Math.max(0.3, l));
  if (swingT > 0) swingT = Math.max(0, swingT - dt);
  const s = swingT > 0 ? Math.sin((1 - swingT / 0.25) * Math.PI) : 0;
  const eating = eatT > 0;
  const eat = eating ? Math.sin(eatT * 25) * 0.02 : 0;
  const bx = Math.cos(bobPhase) * 0.025 * bobAmt, by = Math.abs(Math.sin(bobPhase)) * 0.03 * bobAmt;
  if (mapHeld) { // world-fixed tilt: undo the camera pitch (position rotated by -pitch, orientation = tilt - pitch)
    const c = Math.cos(pitch), n = Math.sin(pitch), wy = -MAP_VM.down - by * 0.5, wz = -MAP_VM.fwd;
    vm.position.set(MAP_VM.side + bx * 0.5, wy * c + wz * n, -wy * n + wz * c);
    vm.rotation.set(-MAP_VM.tilt - pitch, 0, 0);
    vm.visible = started && !P.dead;
    return;
  }
  vm.position.set(0.48 + bx - s * 0.12 - (eating ? 0.25 : 0), -0.42 - by + s * 0.08 + eat + (eating ? 0.12 : 0), -0.72 - s * 0.12);
  vm.rotation.set(-s * 0.9, s * 0.4, 0);
  vm.visible = started && !P.dead;
}
function swing() { if (swingT <= 0.08) swingT = 0.25; }

// ---------- HUD (hearts / hunger / air), drawn as 9px pixel icons on a 198x20 canvas scaled 2x ----------
const HEART = [".KKK.KKK.", "KRRWKRRRK", "KRWRRRRRK", "KRRRRRRRK", ".KRRRRRK.", "..KRRRK..", "...KRK...", "....K...."];
const FOOD = [".....KKK.", "....KMMMK", "...KMLMMK", "...KMMMMK", "..KMMMMK.", ".KBKKKK..", "KBBK.....", ".KK......"];
const BUBBLE = ["..KKKK..", ".KWBBBK.", "KWBBBBBK", "KBBBBBBK", "KBBBBBBK", ".KBBBBK.", "..KKKK.."];
const PAL = { K: "#1a0d0d", R: "#d8222a", W: "#ffd0d0", M: "#b06a2c", L: "#e8a868", B: "#e8e8e0" };
const PAL_EMPTY = { K: "#141414", R: "#3a2626", W: "#3a2626", M: "#3a3026", L: "#3a3026", B: "#3a3a36" };
const PAL_WHITE = { K: "#fff", R: "#fff", W: "#fff" };
const PAL_BUB = { K: "#1c3c74", W: "#ffffff", B: "#8ad0ff" };
function drawIcon(g, pat, ox, oy, pal, fromCol, toCol) {
  for (let y = 0; y < pat.length; y++) for (let x = 0; x < pat[y].length; x++) {
    if (fromCol != null && (x < fromCol || x >= toCol)) continue;
    const ch = pat[y][x]; if (ch === ".") continue;
    g.fillStyle = pal[ch] || "#f0f"; g.fillRect(ox + x, oy + y, 1, 1);
  }
}
let hudKey = "", hurtBlink = 0;
function drawHUD() {
  const h = Math.max(0, Math.ceil(P.health)), f = Math.max(0, Math.ceil(P.hunger));
  const showAir = headInWater || air < AIR_MAX - 0.01;
  const bubbles = Math.ceil(air - 0.01);
  const blink = hurtBlink > 0 && Math.floor(hurtBlink * 8) % 2 === 0;
  const vis = started && !P.dead && menuOpen !== "start" && !creative();
  const key = h + "|" + f + "|" + (showAir ? bubbles : -1) + "|" + blink + "|" + vis;
  if (key === hudKey) return;
  hudKey = key;
  const g = hudCtx;
  g.clearRect(0, 0, 198, 20);
  hudCanvas.style.visibility = vis ? "visible" : "hidden";
  for (let i = 0; i < 10; i++) { // hearts, left half, filled left to right
    const x = (i * 9.5) | 0, y = 11, v = h - i * 2;
    drawIcon(g, HEART, x, y, blink ? PAL_WHITE : PAL_EMPTY);
    if (v >= 2) drawIcon(g, HEART, x, y, PAL);
    else if (v === 1) drawIcon(g, HEART, x, y, PAL, 0, 5);
  }
  for (let i = 0; i < 10; i++) { // hunger, right half, filled right to left
    const x = 189 - ((i * 9.5) | 0), y = 11, v = f - i * 2;
    drawIcon(g, FOOD, x, y, PAL_EMPTY);
    if (v >= 2) drawIcon(g, FOOD, x, y, PAL);
    else if (v === 1) drawIcon(g, FOOD, x, y, PAL, 4, 9);
  }
  if (showAir) for (let i = 0; i < bubbles && i < 10; i++) drawIcon(g, BUBBLE, 189 - ((i * 9.5) | 0), 1, PAL_BUB);
}

// ---------- world interaction ----------
function eyeVec() { return new THREE.Vector3(pos.x, pos.y + eyeOffset, pos.z); }
function dirVec() { return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)); }

function mobHit() {
  try { return BF.mobs && BF.mobs.raycast ? BF.mobs.raycast(eyeVec(), dirVec(), MOB_REACH) : null; } catch (_) { return null; }
}
// Attacks the mob under the crosshair if it is closer than the targeted block. Returns true if a mob was targeted.
function tryAttack() {
  const m = mobHit();
  if (!m || !m.mob || (target && target.dist < m.dist)) return false;
  swing();
  if (attackCd > 0) return true;
  attackCd = ATTACK_CD;
  const sel = selectedItem(), it = sel && BF.items[sel.id];
  const dmg = (it && it.tool && it.tool.damage) || 1;
  const d = dirVec(); d.y = 0;
  if (d.lengthSq() < 1e-6) d.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  d.normalize();
  if (sprinting) { d.multiplyScalar(1.6); sprinting = false; }
  try { BF.mobs.hit(m.mob, dmg, d); } catch (e) { console.error(e); }
  exhaustion += 0.1;
  return true;
}
function primaryDown() {
  updateTarget();
  if (tryAttack()) { mouseL = false; return; }
  swing();
}
function resetBreak() { breakTarget = null; breakProgress = 0; if (crackMesh) crackMesh.visible = false; if (BF.cracks) BF.cracks.hide(); }

function heldTool() { const sel = selectedItem(), it = sel && BF.items[sel.id]; return (it && it.tool) || null; }
function breakTime(block) {
  if (!isFinite(block.hardness)) return Infinity;
  const tool = heldTool();
  let t = block.hardness;
  if (tool && block.tool && tool.type === block.tool && (tool.tier || 0) >= (block.minTier || 0)) t /= tool.speed || 1;
  else if (block.needsTool) t *= 5;
  if (tool && tool.type === "sword" && block.tool === "shears") t /= 1.5;
  return t;
}
function canHarvest(block) {
  if (!block.needsTool) return true;
  const tool = heldTool();
  return !!(tool && tool.type === block.tool && (tool.tier || 0) >= (block.minTier || 0)); // minTier: 1 wood, 2 stone, 3 iron, 4 diamond
}

function updateBreaking(dt) {
  if (breakCd > 0) breakCd -= dt;
  if (!mouseL) { if (breakTarget) resetBreak(); return; }
  if (!target || breakCd > 0) { resetBreak(); return; }
  const b = BF.blocks[target.id];
  if (!b || !isFinite(b.hardness) || b.render === "liquid") { resetBreak(); return; }
  if (!breakTarget || breakTarget.x !== target.x || breakTarget.y !== target.y || breakTarget.z !== target.z || breakTarget.id !== target.id) {
    breakTarget = { x: target.x, y: target.y, z: target.z, id: target.id }; breakProgress = 0;
  }
  const t = creative() ? 0 : breakTime(b);
  breakProgress += t > 0 ? dt / t : 1;
  if (swingT <= 0) swing();
  if (breakProgress >= 1) {
    const { x, y, z, id } = breakTarget;
    BF.world.setBlock(x, y, z, 0);
    spawnParticles(x, y, z, id);
    if (!creative() && canHarvest(b)) {
      try {
        const drops = BF.rollDrops ? BF.rollDrops(id) : (b.drop != null ? [{ id: b.drop, count: 1 }] : []);
        if (BF.drops) BF.drops.spawnAt(drops, x, y, z);
        else for (const d of drops || []) if (d && d.id != null && d.count > 0 && inv().add) inv().add(d.id, d.count);
      } catch (e) { console.error(e); }
    }
    exhaustion += 0.005;
    emit("blockBroken", x, y, z, id);
    resetBreak();
    breakCd = 0.2;   // also the creative repeat interval while held
    target = null; outline.visible = false;
    return;
  }
  // cracks.js: shaped destroy-stage decal, hit ticks every 0.25 s (debris + "blockHit" event); restart the swing on each hit
  if (BF.cracks && BF.cracks.show) { if (BF.cracks.show(breakTarget.x, breakTarget.y, breakTarget.z, breakTarget.id, breakProgress, target.normal, dt)) swingT = 0.25; return; }
  crackMesh.visible = true;
  crackMesh.position.set(breakTarget.x + 0.5, breakTarget.y + 0.5, breakTarget.z + 0.5);
  crackMesh.material = crackMats[Math.min(9, Math.floor(breakProgress * 10))];
}

function boxOverlapsCell(px, py, pz, hw, h, x, y, z) {
  return px + hw > x && px - hw < x + 1 && py + h > y && py < y + 1 && pz + hw > z && pz - hw < z + 1;
}
function cellBlockedByEntity(x, y, z) {
  if (boxOverlapsCell(pos.x, pos.y, pos.z, HW - 0.01, HEIGHT, x, y, z)) return true;
  const list = (BF.mobs && BF.mobs.list) || [];
  for (const m of list) {
    if (!m || m.dead) continue;
    const p = m.position || m.pos; if (!p) continue;
    const hw = m.halfWidth != null ? m.halfWidth : m.hw != null ? m.hw : 0.4;
    const h = m.height != null ? m.height : m.h != null ? m.h : 1.6;
    if (boxOverlapsCell(p.x, p.y, p.z, hw, h, x, y, z)) return true;
  }
  return false;
}

// Short message above the hotbar (villager trades etc).
let actionEl = null, actionTimer = 0;
function actionBar(text) {
  if (!actionEl) {
    actionEl = document.createElement("div");
    actionEl.style.cssText = "position:fixed;left:50%;bottom:calc(150px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);" +
      "background:var(--panel);border:1px solid var(--panel-edge);color:var(--ink);font:13px var(--mono);padding:4px 10px;border-radius:3px;pointer-events:none;transition:opacity .3s";
    document.getElementById("ui").appendChild(actionEl);
  }
  actionEl.textContent = text;
  actionEl.style.opacity = "1";
  clearTimeout(actionTimer);
  actionTimer = setTimeout(() => { actionEl.style.opacity = "0"; }, 2500);
}

// ---------- doors and beds ----------
const lookFacing = () => BF.dirIndex(-Math.sin(yaw), -Math.cos(yaw));
const freeCell = (x, y, z) => { const c = BF.world.getBlock(x, y, z); return (c === 0 || BF.RENDER[c] === 3 || !!BF.REPLACEABLE[c]) && !cellBlockedByEntity(x, y, z); };
// Places a two-block door (facing the player) or bed (head away from the player) at cell (x, y, z).
function placeMulti(kind, x, y, z) {
  const W = BF.world, f = lookFacing();
  if (kind === "tent") return !!(BF.tents && BF.tents.place(x, y, z, f, cellBlockedByEntity));   // 3x2 tent, js/tents.js
  if (!BF.SOLID[W.getBlock(x, y - 1, z)]) return false;
  let cells;
  if (kind === "door") cells = [[x, y, z, BF.doorId((f + 2) % 4, 0, 0)], [x, y + 1, z, BF.doorId((f + 2) % 4, 1, 0)]];
  else {
    const hx = x + BF.DIRS[f][0], hz = z + BF.DIRS[f][1];
    if (!BF.SOLID[W.getBlock(hx, y - 1, hz)]) return false;
    cells = [[x, y, z, BF.bedId(f, 0)], [hx, y, hz, BF.bedId(f, 1)]];
  }
  if (!cells.every(c => c[1] < BF.H && W.isLoaded(c[0], c[2]) && freeCell(c[0], c[1], c[2]))) return false;
  for (const [cx, cy, cz, id] of cells) { W.setBlock(cx, cy, cz, id); emit("blockPlaced", cx, cy, cz, id); }
  return true;
}
// ---------- slabs and stairs ----------
// Placement for items whose block has `shape` (blocks.js): slabs pick bottom/top from the clicked face and merge into the
// full base block on the open half; stairs ascend away from the player. Returns true if something was placed.
function overlapsEntityBoxes(x, y, z, boxes) {
  const hits = (px, py, pz, hw, h) => boxes.some(b => px + hw > x + b[0] / 16 && px - hw < x + b[3] / 16 && py + h > y + b[1] / 16 && py < y + b[4] / 16 && pz + hw > z + b[2] / 16 && pz - hw < z + b[5] / 16);
  if (hits(pos.x, pos.y, pos.z, HW - 0.01, HEIGHT)) return true;
  for (const m of (BF.mobs && BF.mobs.list) || []) {
    if (!m || m.dead) continue;
    const p = m.position || m.pos; if (!p) continue;
    if (hits(p.x, p.y, p.z, m.halfWidth != null ? m.halfWidth : m.hw != null ? m.hw : 0.4, m.height != null ? m.height : m.h != null ? m.h : 1.6)) return true;
  }
  return false;
}
function placeShaped(sel, it) {
  const W = BF.world, sh = it.shape, fam = BF.SHAPES[sh.base], t = target, tb = BF.blocks[t.id];
  const d = dirVec(), e = eyeVec();
  const fy = e.y + d.y * (t.dist + 1e-4) - t.y; // height of the click inside the clicked cell
  const n = t.normal;
  const wantTop = n[1] === 1 ? 0 : n[1] === -1 ? 1 : fy > 0.5 ? 1 : 0;
  const done = (x, y, z, id) => {
    try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (err) { console.error(err); }
    swing(); emit("blockPlaced", x, y, z, id); placeCd = PLACE_REPEAT; return true;
  };
  const merge = (x, y, z, top) => { // top = the half to fill; a slab of this family on the other half becomes the full block
    const c = BF.blocks[W.getBlock(x, y, z)];
    if (sh.kind !== "slab" || !c || !c.shape || c.shape.kind !== "slab" || c.shape.base !== sh.base || c.shape.top === top) return false;
    if (overlapsEntityBoxes(x, y, z, [top ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16]])) return false; // someone stands in the open half
    return W.setBlock(x, y, z, sh.base) && done(x, y, z, sh.base);
  };
  if (sh.kind === "slab" && tb && tb.shape && tb.shape.kind === "slab" && tb.shape.base === sh.base) { // clicked a slab of this family
    const openTop = tb.shape.top ? (n[1] === -1 || (n[1] === 0 && fy < 0.5)) : (n[1] === 1 || (n[1] === 0 && fy > 0.5));
    if (openTop) return merge(t.x, t.y, t.z, tb.shape.top ? 0 : 1);
  }
  const into = BF.REPLACEABLE && BF.REPLACEABLE[t.id];
  const x = into ? t.x : t.x + n[0], y = into ? t.y : t.y + n[1], z = into ? t.z : t.z + n[2];
  if (y < BF.MIN_Y || y >= BF.H || !W.isLoaded(x, z)) return false;
  if (sh.kind === "slab" && merge(x, y, z, wantTop)) return true; // placing next to/onto a slab whose open half faces us
  const cur = W.getBlock(x, y, z);
  if (cur !== 0 && BF.RENDER[cur] !== 3 && !(BF.REPLACEABLE && BF.REPLACEABLE[cur])) return false;
  const id = sh.kind === "slab" ? fam.slab[wantTop] : fam.stairs[wantTop][lookFacing()];
  if (overlapsEntityBoxes(x, y, z, BF.blocks[id].cboxes)) return false;
  if (!W.setBlock(x, y, z, id)) return false;
  return done(x, y, z, id);
}
// Places a ladder against the clicked side face (facing = the face normal), or extends the clicked ladder's column up/down.
function placeLadder() {
  const W = BF.world, t = target, n = t.normal, tb = BF.blocks[t.id];
  let x, y, z, f;
  if (tb && tb.ladder) { if (!n[1]) return false; x = t.x; y = t.y + n[1]; z = t.z; f = tb.ladder.f; }
  else {
    if (n[1]) return false;
    f = BF.dirIndex(n[0], n[2]);
    const into = BF.REPLACEABLE && BF.REPLACEABLE[t.id];
    x = into ? t.x : t.x + n[0]; y = t.y; z = into ? t.z : t.z + n[2];
  }
  if (y < BF.MIN_Y || y >= BF.H || !W.isLoaded(x, z)) return false;
  const cur = W.getBlock(x, y, z);
  if ((cur !== 0 && !BF.REPLACEABLE[cur]) || BF.FLUID[cur]) return false;
  if (!BF.ladderSupport(W.getBlock(x - BF.DIRS[f][0], y, z - BF.DIRS[f][1]))) return false;
  const id = BF.ladderId(f);
  if (!W.setBlock(x, y, z, id)) return false;
  emit("blockPlaced", x, y, z, id);
  return true;
}
let fadeEl = null;
function sleepFade() {
  if (!fadeEl) {
    fadeEl = el("div");
    fadeEl.style.cssText = "position:fixed;inset:0;background:#05070c;opacity:0;transition:opacity .6s;pointer-events:none";
    document.getElementById("ui").appendChild(fadeEl);
  }
  fadeEl.style.opacity = "1";
  setTimeout(() => { fadeEl.style.opacity = "0"; }, 1300);
}
// Right-click on a bed: at night with no monsters near, sleep until morning and set the respawn point here.
// A tent (js/tents.js) works the same, but monsters cannot see anyone asleep in it, so nearby monsters do not stop you.
function trySleep(t) {
  if (!BF.sky || !BF.sky.isNight()) { actionBar("You can only sleep at night"); return; }
  const b = BF.blocks[t.id], tent = !!b.tent;
  const near = !tent && ((BF.mobs && BF.mobs.list) || []).some(m => m.hostile && !m.dead && m.position.distanceTo(pos) < 8);
  if (near) { actionBar("You may not rest now, there are monsters nearby"); return; }
  let foot, sy = 0.5625;
  if (tent) { const o = BF.tents.originOf(t.x, t.y, t.z, t.id); foot = [o.x, o.y, o.z]; sy = 0.125; }
  else foot = b.bed.head ? BF.world.partnerOf(t.x, t.y, t.z, t.id) : [t.x, t.y, t.z];
  const sp = BF.spawnPoint || {};
  BF.spawnPoint = { x: foot[0] + 0.5, y: foot[1] + sy, z: foot[2] + 0.5, bed: foot, world: sp.bed ? sp.world : sp };
  if (tent) { P.hiddenInTent = true; setTimeout(() => { P.hiddenInTent = false; }, 2200); }   // monsters lose sight of the sleeper (mobs.js hostileAI)
  sleepFade();
  setTimeout(() => { BF.sky.setTime(0.01); actionBar("Respawn point set"); emit("playerSlept"); }, 700);
}
// Where to respawn: on the bed if it still stands (or its chunk isn't loaded to check), else the world spawn.
function respawnPoint() {
  let sp = BF.spawnPoint || { x: 8.5, z: 8.5 };
  if (sp.bed) {
    const [bx, by, bz] = sp.bed, b = BF.blocks[BF.world.getBlock(bx, by, bz)];
    if (!BF.world.isLoaded(bx, bz) || (b && (b.bed || b.tent))) return [sp.x, sp.y + 0.01, sp.z];
    setTimeout(() => actionBar("You have no home bed"), 300);
    BF.spawnPoint = sp = sp.world && sp.world.x != null ? sp.world : { x: 8.5, z: 8.5 };
  }
  return [sp.x, surfaceY(sp.x, sp.z), sp.z];
}

// Right click: open a crafting table, start eating, or place a block. Returns true if something happened.
function secondaryDown() {
  updateTarget();
  const mh = mobHit();
  if (mh && mh.mob && mh.mob.type === "villager" && BF.mobs.interact && (!target || mh.dist < target.dist)) {
    mouseR = false;
    const msg = BF.mobs.interact(mh.mob);
    if (invOpen()) { // the trading screen opened
      if (locked) expectUnlock = true;
      keys.clear(); mouseL = false; resetBreak();
      exitLock();
    }
    if (msg) actionBar(msg);
    return true;
  }
  const useBlk = !sneaking || !selectedItem(); // sneaking with an item in hand = place; empty-handed sneak still uses blocks (as in Minecraft)
  if (target && target.id === BF.B.crafting_table && useBlk) { openInventory("crafting"); mouseR = false; return true; }
  const tb = target && BF.blocks[target.id];
  if (tb && tb.door && useBlk) { BF.world.setDoor(target.x, target.y, target.z); swing(); mouseR = false; return true; }
  if (tb && (tb.bed || tb.tent) && useBlk) { trySleep(target); mouseR = false; return true; }
  if (target && target.id === BF.B.furnace && useBlk) {
    openInventory("furnace", { x: target.x, y: target.y, z: target.z }); mouseR = false; return true;
  }
  if (tb && tb.sign && useBlk && BF.signs) { BF.signs.interact(target); mouseR = false; return true; } // sign editor (js/signs.js)
  const sel = selectedItem(); if (!sel) return false;
  const it = BF.items[sel.id]; if (!it) return false;
  // hoe: till grass / dirt / path into farmland (top face, air above)
  if (it.tool && it.tool.type === "hoe" && target && target.normal[1] === 1 && BF.B.farmland != null &&
      (target.id === BF.B.grass || target.id === BF.B.dirt || target.id === BF.B.dirt_path) &&
      BF.world.getBlock(target.x, target.y + 1, target.z) === 0) {
    const { x, y, z, id } = target;
    if (!BF.world.setBlock(x, y, z, BF.B.farmland)) return false;
    swing(); spawnParticles(x, y + 0.6, z, id, 6);
    emit("blockPlaced", x, y, z, BF.B.farmland);
    placeCd = PLACE_REPEAT;
    return true;
  }
  // axe: strip a log / wood block (oak_log -> stripped_oak_log, birch_wood -> stripped_birch_wood)
  if (it.tool && it.tool.type === "axe" && target && BF.blocks[target.id] && /^(?!stripped_).+_(log|wood)$/.test(BF.blocks[target.id].name) &&
      BF.B["stripped_" + BF.blocks[target.id].name] != null) {
    const { x, y, z, id } = target, nid = BF.B["stripped_" + BF.blocks[id].name];
    if (!BF.world.setBlock(x, y, z, nid)) return false;
    swing(); spawnParticles(x, y + 0.6, z, id, 6);
    emit("blockPlaced", x, y, z, nid);
    placeCd = PLACE_REPEAT;
    return true;
  }
  // planting: seeds / carrot / potato on the top face of farmland with air above (takes priority over eating)
  if (it.plants && target && target.id === BF.B.farmland && target.normal[1] === 1 &&
      BF.world.getBlock(target.x, target.y + 1, target.z) === 0) {
    const x = target.x, y = target.y + 1, z = target.z;
    if (!BF.world.setBlock(x, y, z, it.plants)) return false;
    try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
    swing();
    emit("blockPlaced", x, y, z, it.plants);
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (BF.villageLife && BF.villageLife.useBucket && BF.villageLife.useBucket(it, target)) { swing(); placeCd = PLACE_REPEAT; return true; }   // buckets (js/villagelife.js)
  if ((it.map || it.auto || it.autoBlank) && BF.mapview) { // right click with a filled map opens it full screen; the creative auto map asks for a width (js/mapview.js)
    if (BF.mapview.use(sel, it)) { swing(); mouseR = false; placeCd = PLACE_REPEAT; return true; }
  }
  if (it.mapSize && BF.maps) { // blank map: bind it to the 8x8-chunk zone the player stands in (js/maps.js)
    const msg = BF.maps.use(sel, it);
    if (msg) { swing(); actionBar(msg); mouseR = false; placeCd = PLACE_REPEAT; return true; }
  }
  if (it.food) { if (P.hunger < P.maxHunger) { if (eatT <= 0) eatT = 0.0001; return true; } return false; }
  if (it.places === "sign" && target) { // signs (js/signs.js): standing on a top face, wall sign on a side face; opens the editor
    if (!(BF.signs && BF.signs.place(target, it))) return false;
    try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
    swing(); mouseR = false;
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.places === "ladder" && target) { // ladders: only on the side face of a solid block (or extending a ladder column up/down)
    if (!placeLadder()) return false;
    try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
    swing();
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.places && target) {
    const into = BF.REPLACEABLE && BF.REPLACEABLE[target.id];
    const x = into ? target.x : target.x + target.normal[0], y = into ? target.y : target.y + target.normal[1], z = into ? target.z : target.z + target.normal[2];
    if (!placeMulti(it.places, x, y, z)) return false;
    try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
    swing();
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.shape && target) return placeShaped(sel, it); // slabs and stairs
  if (!it.isBlock || !target) return false;
  // clicking a tall-grass style plant replaces it instead of placing beside it
  const into = BF.REPLACEABLE && BF.REPLACEABLE[target.id];
  const x = into ? target.x : target.x + target.normal[0], y = into ? target.y : target.y + target.normal[1], z = into ? target.z : target.z + target.normal[2];
  if (y < BF.MIN_Y || y >= BF.H || !BF.world.isLoaded(x, z)) return false;
  const cur = BF.world.getBlock(x, y, z);
  if (cur !== 0 && BF.RENDER[cur] !== 3 && !(BF.REPLACEABLE && BF.REPLACEABLE[cur])) return false;
  let placeId = sel.id;
  if (BF.light && BF.light.isTorchItem(placeId)) { placeId = BF.light.torchPlace(x, y, z, into ? [0, 1, 0] : target.normal); if (!placeId) return false; } // standing or wall torch
  if (BF.RENDER[sel.id] === 4 && !BF.SOLID[BF.world.getBlock(x, y - 1, z)]) return false; // plants need ground
  if (BF.blocks[sel.id] && BF.blocks[sel.id].sapling && BF.forester && !BF.forester.canSurvive(x, y, z)) return false;   // saplings need soil (js/forester.js)
  if (BF.SOLID[sel.id] && cellBlockedByEntity(x, y, z)) return false;
  if (!BF.world.setBlock(x, y, z, placeId)) return false;
  try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
  swing();
  emit("blockPlaced", x, y, z, placeId);
  placeCd = PLACE_REPEAT;
  return true;
}
function updateUse(dt) {
  if (placeCd > 0) placeCd -= dt;
  if (eatT > 0) {
    const sel = selectedItem(), it = sel && BF.items[sel.id];
    if (!mouseR || !it || !it.food || P.hunger >= P.maxHunger) { eatT = 0; return; }
    eatT += dt;
    emit("playerEating", it.id); // per frame while eating (audio crunch)
    if (eatT >= EAT_TIME) {
      eatT = 0;
      P.hunger = Math.min(P.maxHunger, P.hunger + it.food);
      saturation = Math.min(P.hunger, saturation + it.food * 0.6);
      try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
      emit("playerAte", it.id);
      placeCd = 0.3;
    }
    return;
  }
  if (mouseR && placeCd <= 0 && !secondaryDown()) placeCd = PLACE_REPEAT;
}

function pickBlock() {
  if (!target) return;
  const I = inv();
  const tb = BF.blocks[target.id];
  const tid = tb && tb.item != null ? tb.item : target.id; // door/bed halves pick their item
  if (creative() && BF.items[tid] && I.select) {
    // creative: put the block into the hotbar (an existing slot with it, else an empty one, else the selected one)
    try {
      const slots = I.slots || I.hotbar;
      if (slots) {
        let i = -1;
        for (let k = 0; k < 9; k++) if (slots[k] && slots[k].id === tid) { i = k; break; }
        if (i < 0) {
          const cur = I.selectedIndex | 0;
          i = !slots[cur] ? cur : -1;
          for (let k = 0; i < 0 && k < 9; k++) if (!slots[k]) i = k;
          if (i < 0) i = cur;
          if (I.setSlot) I.setSlot(i, { id: tid, count: 1 });
          else slots[i] = { id: tid, count: 1 };
          if (BF.emit) BF.emit("inventoryChanged");
        }
        I.select(i);   // also re-renders the hotbar
        return;
      }
    } catch (e) { console.error(e); }
  }
  // best effort: if the inventory exposes hotbar slots, select the one holding this block
  try {
    const slots = I.hotbar || (I.slots && I.slots.slice(0, 9));
    if (slots && I.select) { const i = slots.findIndex(s => s && s.id === tid); if (i >= 0) I.select(i); }
  } catch (_) {}
}

// ---------- survival ----------
function survivalTick(dt) {
  if (!started || P.dead) return;
  if (creative()) { air = AIR_MAX; drownT = starveT = regenT = 0; exhaustion = 0; return; }
  exhaustion += dt * 0.02;
  while (exhaustion >= 4) {
    exhaustion -= 4;
    if (saturation > 0) saturation = Math.max(0, saturation - 1);
    else P.hunger = Math.max(0, P.hunger - 1);
  }
  if (P.hunger >= 18 && P.health < P.maxHealth) {
    regenT += dt;
    if (regenT >= 3) { regenT = 0; P.heal(1); exhaustion += 3; }
  } else regenT = 0;
  if (P.hunger <= 0) {
    starveT += dt;
    if (starveT >= 4) { starveT = 0; P.damage(1, null, "starved"); }
  } else starveT = 0;
  if (headInWater && !flying) {
    air = Math.max(0, air - dt);
    if (air <= 0) { drownT += dt; if (drownT >= 1) { drownT = 0; P.damage(2, null, "drowned"); } }
  } else { air = Math.min(AIR_MAX, air + dt * 4); drownT = 0; }
}

let lastCause = "";
// amount in half-hearts. fromPos (optional) knocks the player away. cause (optional) is used for
// environmental damage, which ignores the post-hit invulnerability window.
P.damage = function (amount, fromPos, cause) {
  if (creative() || P.dead || !started || waitingForChunk || !(amount > 0)) return;
  if (hurtCd > 0 && !cause) return;
  if (!cause) hurtCd = 0.5;
  P.health = Math.max(0, P.health - amount);
  lastCause = cause || (fromPos ? "slain" : "hurt");
  flashT = 0.45; hurtBlink = 0.5;
  if (fromPos) {
    let dx = pos.x - fromPos.x, dz = pos.z - fromPos.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    vel.x += dx * 7; vel.z += dz * 7;
    if (!flying) vel.y = Math.max(vel.y, 5);
  }
  exhaustion += 0.1;
  emit("playerDamaged", amount);
  if (P.health <= 0) die();
};
P.heal = function (n) { if (!P.dead) P.health = Math.min(P.maxHealth, P.health + n); };

const DEATH_MSG = { killed: "You were killed", fell: "You hit the ground too hard", drowned: "You drowned", starved: "You starved to death", slain: "You were slain", hurt: "You died" };
function die() {
  P.dead = true; P.health = 0;
  resetBreak(); mouseL = mouseR = false; keys.clear(); eatT = 0; flying = false; turbo = false; boostE = false;
  if (invOpen()) { try { inv().close(); } catch (_) {} }
  deathEl.querySelector(".bfp-sub").textContent = DEATH_MSG[lastCause] || "You died";
  showScreen("death");
  BF.state.paused = true;
  exitLock();
  emit("playerDied");
}
function surfaceY(x, z) {
  let h = BF.world.heightAt(x, z);
  if (h < 0 && BF.worldgen && BF.worldgen.heightAt) h = BF.worldgen.heightAt(Math.floor(x), Math.floor(z));
  return h + 1.01;
}
function respawn() {
  const sp = respawnPoint();
  resetStats();
  pos.set(sp[0], sp[1], sp[2]);
  waitingForChunk = true;
  showScreen(null);
  BF.state.paused = false;
  if (!isTouch && !dragMode) requestLock();
  syncCamera(0.016);
  emit("playerRespawned");
}
function resetStats() {
  vel.x = vel.y = vel.z = 0;
  P.health = P.maxHealth; P.hunger = P.maxHunger; P.dead = false;
  saturation = 5; exhaustion = 0; air = AIR_MAX; fallStart = null; flying = false; sprinting = false;
  hurtCd = 1; flashT = 0; regenT = starveT = drownT = 0; eatT = 0;
  resetBreak();
}

// ---------- physics ----------
const LADDER_UP = 2.35, LADDER_DOWN = 3;   // blocks/s
let ladderHit = false;                      // pushed against a wall last frame (forward then climbs)
function onLadder() {                       // a ladder cell at the feet or at the waist (so a ladder one block up can be grabbed)
  const W = BF.world, a = BF.blocks[W.getBlock(pos.x, pos.y + 0.001, pos.z)], b = BF.blocks[W.getBlock(pos.x, pos.y + 1, pos.z)];
  return !!((a && a.ladder) || (b && b.ladder));
}
function physics(dt) {
  const k = touchKeys.size ? new Set([...keys, ...touchKeys]) : keys;
  const wantJump = k.has("Space");
  const shift = k.has("ShiftLeft") || k.has("ShiftRight");
  sneaking = shift && !flying;
  let fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
  let strafe = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
  if (stick.id != null) { fwd = -stick.y; strafe = stick.x; if (fwd > 0.92) sprinting = true; }
  if ((k.has("ControlLeft") || k.has("ControlRight") || k.has("KeyR")) && fwd > 0) sprinting = true;
  if (fwd <= 0 || sneaking || (P.hunger <= 6 && !flying) || eatT > 0) sprinting = false;
  turbo = flying && boostE && fwd > 0 && !!(k.has("KeyW") || k.has("ArrowUp") || stick.id != null);   // releasing W or E (or landing) ends the boost
  // forward (sx, sz) and right (-sz, sx) in the horizontal plane
  const sx = -Math.sin(yaw), sz = -Math.cos(yaw);
  let mx = sx * fwd - sz * strafe, mz = sz * fwd + sx * strafe;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }

  let speed;
  if (flying) {
    speed = creative() ? (sprinting ? CFLY_SPRINT : CFLY) : (sprinting ? FLY_SPRINT : FLY);
    if (turbo) {
      const base = creative() ? CFLY : FLY;
      // don't outrun terrain: drop to sprint speed when the chunks ahead aren't generated yet
      const sp = Math.hypot(vel.x, vel.z) || 1, ahead = TURBO_LOOKAHEAD * 16;
      const ax = Math.floor((pos.x + vel.x / sp * ahead) / 16), az = Math.floor((pos.z + vel.z / sp * ahead) / 16);
      speed = BF.world.chunks.has(ax + "," + az) ? base * TURBO_MULT : Math.max(speed, base * 2);   // ahead not generated yet: fall back to a fast sprint
    }
  }
  else if (inWater) speed = SWIM * (sprinting ? 1.4 : 1);
  else speed = sneaking ? SNEAK : sprinting ? SPRINT : WALK;
  if (eatT > 0 && !flying) speed *= 0.35;

  const climbing = !flying && !inWater && onLadder();   // body in a ladder cell: gravity is replaced by climbing
  const accel = flying ? 10 : inWater ? 6 : onGround ? 14 : 2.6;
  const a = 1 - Math.exp(-accel * dt);
  vel.x += (mx * speed - vel.x) * a;
  vel.z += (mz * speed - vel.z) * a;

  if (flying) {
    const vy = (wantJump ? 1 : 0) - (shift ? 1 : 0);
    vel.y += (vy * speed * 0.75 - vel.y) * (1 - Math.exp(-10 * dt));
  } else if (inWater) {
    // standing in shallow water: a normal jump works (otherwise you can't hop out of a 1-deep pool)
    if (wantJump && onGround) vel.y = JUMP_V;
    const up = Math.max(3, vel.y);
    vel.y -= (headInWater ? 9 : 20) * dt;
    if (wantJump) vel.y += 22 * dt;
    if (sneaking) vel.y -= 6 * dt;
    vel.y *= Math.exp(-2.5 * dt);
    vel.y = clamp(vel.y, -4, up);
  } else if (climbing) {
    // jump, or forward against the wall: up 2.35 b/s; sneak holds position; otherwise slide down 3 b/s
    vel.x = clamp(vel.x, -3, 3); vel.z = clamp(vel.z, -3, 3);
    vel.y = wantJump || (fwd > 0 && ladderHit) ? LADDER_UP : sneaking ? 0 : -LADDER_DOWN;
  } else {
    vel.y = Math.max(-60, vel.y - GRAVITY * dt);
    if (wantJump && onGround) {
      vel.y = JUMP_V;
      exhaustion += sprinting ? 0.2 : 0.05;
      if (sprinting) { vel.x += sx * 1.4; vel.z += sz * 1.4; }
    }
  }

  // sneaking: never walk off an edge
  if (sneaking && onGround && !inWater) {
    const sup = (x, z) => BF.world.boxCollides(x, pos.y - 0.1, z, HW, 0.1);
    const dx = vel.x * dt, dz = vel.z * dt;
    if (dx && !sup(pos.x + dx, pos.z)) vel.x = 0;
    if (dz && !sup(pos.x + vel.x * dt, pos.z + dz)) vel.z = 0;
  }

  const ox = pos.x, oz = pos.z;
  const res = BF.world.moveBox(pos, vel, HW, HEIGHT, dt, { stepUp: 0.6 }); // vanilla step height: slabs, stairs and beds, not full blocks
  const wasGround = onGround;
  onGround = res.onGround; inWater = res.inWater; headInWater = !!res.headInWater; ladderHit = res.hitX || res.hitZ;
  if (inWater && wantJump && (res.hitX || res.hitZ)) vel.y = Math.max(vel.y, 6.5); // climb out onto a ledge
  if (flying && onGround && !wasGround) flying = false;                             // landing ends flight

  // fall damage: 1 per block beyond 3
  if (flying || inWater || climbing) fallStart = null;
  else if (!onGround) { if (fallStart == null || pos.y > fallStart) fallStart = pos.y; }
  else {
    if (fallStart != null) { const d = Math.floor(fallStart - pos.y - 3 + 1e-3); if (d > 0) P.damage(d, null, "fell"); }
    fallStart = null;
  }

  const moved = Math.hypot(pos.x - ox, pos.z - oz);
  if (sprinting && !flying) exhaustion += moved * 0.1;
  else if (inWater && !flying) exhaustion += moved * 0.01;
  if ((res.hitX || res.hitZ) && sprinting && !inWater && !flying) sprinting = false;
  return moved;
}

// ---------- camera ----------
function syncCamera(dt) {
  const want = sneaking ? SNEAK_EYE : EYE;
  eyeOffset += (want - eyeOffset) * Math.min(1, dt * 14);
  const by = Math.abs(Math.sin(bobPhase)) * 0.06 * bobAmt, bx = Math.cos(bobPhase) * 0.035 * bobAmt;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  BF.camera.position.set(pos.x + rx * bx, pos.y + eyeOffset + by, pos.z + rz * bx);
  BF.camera.rotation.set(pitch, yaw, 0, "YXZ");
  const wantFov = BASE_FOV * (turbo ? 1.25 : sprinting ? 1.12 : 1);
  if (Math.abs(fov - wantFov) > 0.01 || BF.camera.fov !== fov) {
    fov += (wantFov - fov) * Math.min(1, dt * 10);
    if (Math.abs(fov - wantFov) <= 0.01) fov = wantFov;
    BF.camera.fov = fov; BF.camera.updateProjectionMatrix();
  }
}

function updateOverlays(dt) {
  const eyeId = BF.world.getBlock(pos.x, pos.y + eyeOffset, pos.z);
  tintEl.style.display = BF.RENDER[eyeId] === 3 ? "block" : "none";
  if (flashT > 0) flashT = Math.max(0, flashT - dt);
  flashEl.style.opacity = (flashT / 0.45).toFixed(3);
  if (hurtBlink > 0) hurtBlink = Math.max(0, hurtBlink - dt);
  crossEl.style.display = started && !menuOpen && !P.dead ? "block" : "none";
  drawHUD();
}

function updateTarget() {
  target = P.dead ? null : BF.world.raycast(eyeVec(), dirVec(), REACH);
  if (target) {
    outline.visible = true;
    const ob = BF.blocks[target.id], bb = ob && ob.shape ? ob.cboxes.reduce((m, c) => [Math.min(m[0], c[0]), Math.min(m[1], c[1]), Math.min(m[2], c[2]), Math.max(m[3], c[3]), Math.max(m[4], c[4]), Math.max(m[5], c[5])], [16, 16, 16, 0, 0, 0]) : null;
    if (bb) { // slabs / stairs: outline the real box
      outline.scale.set((bb[3] - bb[0]) / 16, (bb[4] - bb[1]) / 16, (bb[5] - bb[2]) / 16);
      outline.position.set(target.x + (bb[0] + bb[3]) / 32, target.y + (bb[1] + bb[4]) / 32, target.z + (bb[2] + bb[5]) / 32);
    } else { outline.scale.set(1, 1, 1); outline.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5); }
  } else outline.visible = false;
}

// On a fresh spawn, look toward the most open horizontal direction instead of into a hillside.
let faceOpen = false;
function faceOpenDirection() {
  let best = yaw, bestD = -1;
  const e = eyeVec();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const d = new THREE.Vector3(-Math.sin(a) * 0.96, -0.28, -Math.cos(a) * 0.96);
    const h = BF.world.raycast(e, d, 24);
    const dist = h ? h.dist : 24;
    if (dist > bestD + 0.5) { bestD = dist; best = a; }
  }
  yaw = best; pitch = -0.12;
}

// ---------- public API ----------
P.init = function () {
  buildDOM();
  buildScene();
  bindInput();
  showScreen("start");
  const vd = parseInt(store.get("viewDist"), 10);
  if (VIEW_OPTS.includes(vd) && vd !== BF.world.viewDist) setViewDist(vd, false); else updateFar();
  updateModeUI();
  emit("gameModeChanged", gameMode);
  // breaking either half of a door or bed removes the other half (the broken half dropped the item)
  if (BF.on) BF.on("blockBroken", (x, y, z, id) => { if (BF.blocks[id] && (BF.blocks[id].door || BF.blocks[id].bed)) BF.world.removePartner(x, y, z, id); else if (BF.blocks[id] && BF.blocks[id].tent) BF.tents.remove(x, y, z, id); });
};

P.spawn = function (x, y, z) {
  resetStats();
  pos.set(x, y, z);
  waitingForChunk = true;
  faceOpen = true;
  hurtCd = 2;
  if (menuOpen === "death") { showScreen(null); BF.state.paused = false; }
  syncCamera(0.016);
};

P.eyePos = () => eyeVec();
P.lookDir = () => dirVec();
P.setLook = function (y, p) { yaw = y; pitch = clamp(p, -1.55, 1.55); };
P.start = beginPlay;                 // dismiss the start screen without a click (tests / embeds)
P.isLocked = () => locked;
P.menu = () => menuOpen;
P.respawn = respawn;
P.setGameMode = setGameMode;
// commands.js hooks: an overlay that takes the keyboard (releases the pointer lock without pausing, then re-locks)
P.canOpenUI = () => started && !menuOpen && !P.dead && !invOpen();
P.actionBar = actionBar;
P.uiOpen = function () { if (locked) expectUnlock = true; keys.clear(); mouseL = mouseR = false; resetBreak(); exitLock(); };
P.uiClose = function () { if (!dragMode && !isTouch && started && !menuOpen && !P.dead && !locked) requestLock(); };
P.teleport = function (x, y, z) {
  pos.set(x, y, z); vel.x = vel.y = vel.z = 0; fallStart = null; resetBreak();
  if (!BF.world.isLoaded(x, z)) waitingForChunk = true;   // hold still until the destination chunk exists
  syncCamera(0.016);
};
P.kill = function () { if (P.dead || !started) return; lastCause = "killed"; die(); };
P.feed = function () { if (P.dead) return; P.hunger = P.maxHunger; saturation = 5; exhaustion = 0; starveT = 0; };
P.spawnParticles = (x, y, z, id, n) => spawnParticles(x, y, z, id, n);
// Save-game state. deserialize() expects the world (seed) to be set up already, e.g. right after BF.newWorld.
P.serialize = function () {
  return {
    x: pos.x, y: pos.y, z: pos.z, yaw, pitch,
    health: P.health, hunger: P.hunger, saturation, exhaustion, air,
    gameMode, flying, dead: P.dead,
  };
};
P.deserialize = function (o) {
  o = o || {};
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  if (o.gameMode) setGameMode(o.gameMode);
  resetStats();
  const sp = BF.spawnPoint || { x: pos.x, z: pos.z };
  if (o.dead || num(o.health, 20) <= 0 || !isFinite(o.x) || !isFinite(o.y) || !isFinite(o.z)) {
    pos.set(sp.x, surfaceY(sp.x, sp.z), sp.z);           // saved while dead (or broken data): back to spawn
  } else {
    pos.set(o.x, o.y, o.z);
    P.health = clamp(num(o.health, P.maxHealth), 1, P.maxHealth);
    P.hunger = clamp(num(o.hunger, P.maxHunger), 0, P.maxHunger);
    saturation = num(o.saturation, saturation); exhaustion = num(o.exhaustion, 0);
    air = clamp(num(o.air, AIR_MAX), 0, AIR_MAX);
    flying = !!o.flying;
  }
  yaw = num(o.yaw, yaw); pitch = clamp(num(o.pitch, pitch), -1.55, 1.55);
  waitingForChunk = true;   // no physics until the chunks around the saved position are loaded
  faceOpen = false;         // keep the saved look direction
  hurtCd = 2;
  if (menuOpen === "death") { showScreen(null); BF.state.paused = false; }
  hudKey = "";
  syncCamera(0.016);
};
P.setMouse = function (left, right) { // test hook: simulate held mouse buttons
  if (left && !mouseL) { mouseL = true; primaryDown(); } else if (!left) { mouseL = false; resetBreak(); }
  if (right && !mouseR) { mouseR = true; placeCd = 0; secondaryDown(); } else if (!right) { mouseR = false; eatT = 0; }
};

P.update = function (dt) {
  if (hurtCd > 0) hurtCd -= dt;
  if (attackCd > 0) attackCd -= dt;

  // spawn: wait until the ground under the player is loaded, then lift out of terrain if needed
  if (waitingForChunk) {
    const W = BF.world;
    if (W.isLoaded(pos.x, pos.z) && W.isLoaded(pos.x + 1, pos.z + 1) && W.isLoaded(pos.x - 1, pos.z - 1) &&
        W.isLoaded(pos.x + 1, pos.z - 1) && W.isLoaded(pos.x - 1, pos.z + 1)) {
      waitingForChunk = false;
      if (W.boxCollides(pos.x, pos.y, pos.z, HW, HEIGHT)) pos.y = Math.max(pos.y, W.heightAt(pos.x, pos.z) + 1.01);
      fallStart = null; vel.y = 0;
      if (faceOpen) { faceOpen = false; faceOpenDirection(); }
    } else { syncCamera(dt); updateViewModel(dt); updateOverlays(dt); return; }
  }

  let moved = 0;
  if (!P.dead) {
    if (isTouch) touchUpdate();
    if (invOpen() && keys.size) keys.clear();
    moved = physics(dt);
    updateTarget();
    updateBreaking(dt);
    updateUse(dt);
    survivalTick(dt);
  }
  // head bob
  const sp = moved / Math.max(dt, 1e-4);
  const want = onGround && !flying && sp > 0.5 ? Math.min(1, sp / WALK) : 0;
  bobAmt += (want - bobAmt) * Math.min(1, dt * 8);
  if (want) bobPhase += dt * sp * 2.2;

  syncCamera(dt);
  updateParticles(dt);
  updateViewModel(dt);
  updateOverlays(dt);
};

P.updatePaused = function (dt) {
  if (hurtCd > 0) hurtCd -= dt;
  syncCamera(dt);
  updateParticles(dt);
  updateViewModel(dt);
  updateOverlays(dt);
};
})();
