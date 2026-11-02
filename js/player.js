// First-person player: input (keyboard/mouse/pointer lock/touch), physics, camera, block
// breaking/placing, attacking mobs, survival stats (health/hunger/air), HUD and menus.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

// ---------- tuning ----------
const GRAVITY = 32, JUMP_V = 8.4, WALK = 4.3, SPRINT = 5.6, SNEAK = 1.3;
const TURBO_MULT = 10, TURBO_LOOKAHEAD = 3;   // boost (fly + hold W and R): 10x the normal flying speed
const FLY = 10.9, FLY_SPRINT = 21.6, CFLY = 16, CFLY_SPRINT = 32, SWIM = 2.2, REACH = 5, MOB_REACH = 3.5;
const BASE_FOV = 75, AIR_MAX = 10, ATTACK_CD = 0.4, EAT_TIME = 1.2, PLACE_REPEAT = 0.22;
const HW = 0.3, HEIGHT = 1.8, EYE = 1.62, SNEAK_EYE = 1.47;
// Bow (vanilla): full draw takes 1 s; power f = (t^2 + 2t) / 3 for t = draw seconds, capped at 1, and below 0.1 nothing is fired.
// The arrow leaves at 60 f blocks/s (3 blocks a tick) and deals ceil(6 f); a full-draw arrow is critical 1 time in 5 (+1..3, so up to 9).
const BOW_DRAW = 1, BOW_SPEED = 60, BOW_DAMAGE = 6, BOW_CRIT = 0.2, BOW_MIN = 0.1;

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
let wasHigh = false;          // above the chunk ceiling last frame
let onGround = false, inWater = false, headInWater = false;
let flying = false, sprinting = false, sneaking = false, turbo = false;
let lastSpaceTap = 0, lastWTap = 0, wTaps = 0;
let fallStart = null;
let eyeOffset = EYE, bobPhase = 0, bobAmt = 0, fov = BASE_FOV;
let exhaustion = 0, saturation = 5, regenT = 0, starveT = 0, drownT = 0, air = AIR_MAX;
let hurtCd = 0, flashT = 0, attackCd = 0, swingT = 0;
let hurtAmt = 0;   // the hit that started the current hurtCd window (Infinity: spawn protection)
let mouseL = false, mouseR = false;
let breakTarget = null, breakProgress = 0, breakCd = 0;
let placeCd = 0, eatT = 0;
let drawT = 0, drawStack = null;   // bow: seconds the string has been held back (0 = not drawing) and the bow stack being drawn
let target = null;            // current block raycast hit
// What the player rides (a boat, js/boats.js), or null. A vehicle carries `ctl`, its module's riding interface:
//   drive(v, dt, input {fwd, turn, strafe, jump}) -> yaw change, seatOf(v, "player") -> {x, y, z}, sitEye(v) -> eye above the seat,
//   canBoard(v), exitSpot(v, hw, h) -> {x, y, z}, onLeave(v) (e.g. a boat lets its mob passenger out too).
// Shift held when it was boarded must be let go first.
let vehicle = null, rideShift = false;
let offPlanet = false;        // the planet, above layer 20,000: the camera faces the planet and dragging turns it (js/view.js)
// Render distances (chunks). The planet keeps block data only near the player and far chunks as meshes (js/world.js, spec r14-07), so the
// largest is the default; automated browsers (the tests) start at world.js's 6, so their timings don't change.
const VIEW_OPTS = [4, 6, 8, 10, 12, 16, 20, 24, 28, 32];
const store = {
  get(k) { try { return localStorage.getItem("blockfield." + k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem("blockfield." + k, String(v)); } catch (_) {} },
};
let gameMode = store.get("gameMode") === "creative" ? "creative" : "survival";
const creative = () => gameMode === "creative";
const isTouch = !!(globalThis.matchMedia && matchMedia("(pointer: coarse)").matches);

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
  get vehicle() { return vehicle; },
  get offPlanet() { return offPlanet; },
  get boat() { return vehicle && vehicle.kind === "boat" ? vehicle : null; },
});

// ---------- small helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = () => BF.inventory || {};
const invOpen = () => { try { return !!(inv().isOpen && inv().isOpen()) || !!(BF.commands && BF.commands.isOpen()) || !!(BF.signs && BF.signs.isOpen()) || !!(BF.mapview && BF.mapview.isOpen()) || !!(BF.coords && BF.coords.panel.isOpen()) || !!(BF.designer && BF.designer.isOpen()); } catch (_) { return false; } }; // the command line (commands.js) counts as a screen
const selectedItem = () => {
  try { const s = inv().selected && inv().selected(); return s && s.count > 0 ? s : null; } catch (_) { return null; }
};
// A cell the player reached across a face edge has a margin address (the raycast walks the unfolded neighbour). Block entities
// (chests, furnaces, jobsites, signs) and every blockPlaced / blockBroken listener key by the canonical cell, so these hand that on,
// with a block id turned back to the canonical face's frame. In a corner wedge they are the identity.
const canonCell = (x, y, z, id) => {
  const W = BF.world, c = W.cell ? W.cell(x, z, {}) : null;
  if (!c || (c.x === x && c.z === z)) return { x, y, z, id };
  return { x: c.x, y, z: c.z, id: id != null && c.turn ? W.turnId(id, (4 - c.turn) % 4) : id };
};
const emit = (...a) => {
  if (!BF.emit) return;
  if (a[0] === "blockPlaced" || a[0] === "blockBroken") { const c = canonCell(a[1], a[2], a[3], a[4]); a[1] = c.x; a[3] = c.z; a[4] = c.id; }
  BF.emit(...a);
};
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
.bfp-death .bfp-sub{white-space:pre-line}
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
.bfp-card.bfp-wide{max-width:840px}
.bfp-saveops{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}
.bfp-card .bfp-saveops button{width:auto;margin:0;padding:7px 9px;font-size:11px}
.bfp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 8px;font:400 15px/1 var(--display);color:var(--ink);text-align:left}
.bfp-card button.bfp-small{width:auto;margin:0;padding:8px 10px;font-size:12px}
.bfp-worlds{max-height:min(46vh,340px);overflow:auto;border:1px solid var(--panel-edge);border-radius:3px;background:rgba(0,0,0,.25);text-align:left}
.bfp-world{display:flex;align-items:center;gap:10px;padding:9px 10px;border-bottom:1px solid rgba(255,255,255,.07)}
.bfp-world:last-child{border-bottom:0}
.bfp-world .bfp-info{flex:1;min-width:0}
.bfp-wname{font:400 14px/1.2 var(--display);color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfp-wmeta{font:11px/1.5 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfp-wmeta b{color:var(--accent);font-weight:500}
.bfp-card button.bfp-copy{display:inline-block;width:auto;margin:0 0 0 3px;padding:0 4px;font:12px/16px var(--mono);vertical-align:baseline;background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px;color:var(--muted)}
.bfp-card button.bfp-copy:hover,.bfp-card button.bfp-copy:focus-visible{background:#4f6a3f;color:var(--ink)}
.bfp-card button.bfp-copy.done{color:var(--accent)}
.bfp-wbtns{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex-shrink:0;max-width:240px}
.bfp-card .bfp-wbtns button{width:auto;margin:0;padding:7px 9px;font-size:11px}
.bfp-card .bfp-wbtns button.danger{background:var(--danger);color:#fff}
.bfp-world input{width:100%;box-sizing:border-box;font:13px var(--mono);background:rgba(0,0,0,.4);color:var(--ink);border:1px solid var(--accent);border-radius:3px;padding:6px 8px}
.bfp-world.confirm{background:rgba(224,83,61,.14)}
.bfp-world.old .bfp-info{opacity:.5}
.bfp-world.opts{flex-wrap:wrap}
.bfp-world.opts .bfp-opts{flex-basis:100%}
.bfp-opts{text-align:left;font:12px var(--mono);color:var(--muted);margin:6px 0 0}
.bfp-optgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px}
.bfp-card .bfp-optgrid button{margin:0;padding:8px 10px;font-size:12px;background:rgba(0,0,0,.3);color:var(--muted);border-bottom:3px solid transparent}
.bfp-card .bfp-optgrid button.on{background:#3b4a35;color:var(--ink);border-bottom-color:var(--accent)}
.bfp-opts .bfp-hint{display:block;margin-top:4px;font-size:11px;opacity:.8}
.bfp-card .bfp-distant button{margin:3px 0;padding:8px 10px;font-size:12px;background:rgba(0,0,0,.3);color:var(--ink);text-align:left}
.bfp-card .bfp-distant button:disabled{opacity:.55;cursor:default}
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
@media (max-width:520px){.bfp-world{flex-wrap:wrap}.bfp-wbtns{width:100%;max-width:none}.bfp-card .bfp-wbtns button{flex:1}}
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
let ui, crossEl, hudCanvas, hudCtx, tintEl, flashEl, startEl, pauseEl, deathEl, touchEl, knobEl, pauseNote, viewBtn, budgetBtn, distantEl, hostBtn, helpEl;
const HELP_HTML = isTouch
  ? `<div><b>Stick</b> move</div><div><b>Drag</b> look</div><div><b>Tap</b> place / use / hit</div><div><b>Hold</b> break</div><div><b>Jump x2</b> fly</div><div><b>INV</b> inventory</div>`
  : `<div><b>WASD</b> move</div><div><b>Mouse</b> look</div><div><b>Space</b> jump / swim</div><div><b>Space x2</b> fly</div>
     <div><b>Shift</b> sneak</div><div><b>R / Ctrl / W x2</b> sprint</div><div><b>Z</b> free the mouse (game keeps running)</div><div><b>Fly + hold W and R</b> 10x boost</div><div><b>L-click</b> break / hit</div><div><b>R-click</b> place / use / eat</div>
     <div><b>1-9 / wheel</b> hotbar</div><div><b>E</b> inventory</div><div><b>Q</b> throw one item</div><div><b>Boat</b> R-click to get in, W/S row, A/D turn, Shift out</div><div><b>Esc</b> pause, <b>F3</b> debug</div><div><b>/</b> command line</div>`;

// Game options of a world (js/gameopts.js): one on/off button per monster (data-act="mon"), and the far villages switch (data-act="far",
// spec r15-64). o: {type: bool, coarse: bool}.
const farLabel = on => "Far villages: " + (on ? "Coarse (faster)" : "Full detail");
const optsHTML = o => { const G = BF.gameOpts, ts = G ? G.types() : []; return `<div class="bfp-opts">Monsters that spawn<div class="bfp-optgrid">` +
  ts.map(t => `<button type="button" data-act="mon" data-mon="${t}" class="${o[t] ? "on" : ""}" aria-pressed="${!!o[t]}">${G.name(t)}: ${o[t] ? "On" : "Off"}</button>`).join("") +
  `</div><span class="bfp-hint">Off: they never spawn, and any already in the world leave. The others spawn as often as before.</span>` +
  `<div class="bfp-optgrid"><button type="button" data-act="far" data-mon="coarse" class="${o.coarse ? "on" : ""}" aria-pressed="${!!o.coarse}">${farLabel(o.coarse)}</button></div>` +
  `<span class="bfp-hint">Coarse: villages beyond your view distance think a few times a second and walk their routes cell by cell. They do the same work, for less computer time.</span></div>`; };
const readOpts = box => { const o = {}; for (const b of box.querySelectorAll('[data-act="mon"], [data-act="far"]')) o[b.dataset.mon] = b.classList.contains("on"); return o; };
const flipOpt = b => { const on = !b.classList.contains("on"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); b.textContent = b.dataset.act === "far" ? farLabel(on) : BF.gameOpts.name(b.dataset.mon) + ": " + (on ? "On" : "Off"); return on; };
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
      <div class="bfp-head"><span class="bfp-where">Singleplayer</span><button data-act="show-create" class="primary bfp-small">Create New World</button></div>
      <div class="bfp-worlds" role="list"><p class="bfp-empty">Loading worlds…</p></div>
      <div class="bfp-saveops"><button data-act="import" title="Add a world from a .bfworld file (made by Export)">Import world…</button><button data-act="copy-browser" hidden title="Copy the worlds saved in this browser to the world server's saves folder; they stay in the browser too">Copy browser saves to the server</button><input type="file" class="bfp-importfile" accept=".bfworld,application/gzip,application/json" hidden></div>
      <p class="bfp-savenote"></p>
      <p class="bfp-credit">Block textures: <a href="https://faithfulpack.net" target="_blank" rel="noopener noreferrer">Faithful 32x</a> © Faithful Resource Pack, used under the <a href="https://faithfulpack.net/license" target="_blank" rel="noopener noreferrer">Faithful License</a>.</p>
      <details class="bfp-ctl"><summary>Controls</summary><div class="bfp-help">${HELP_HTML}</div></details>
    </div>
    <form class="bfp-view-create" hidden autocomplete="off">
      <div class="bfp-head"><span>Create New World</span></div>
      <label class="bfp-field">World name<input name="name" maxlength="40" value="New World" spellcheck="false"></label>
      <div class="bfp-field">World type<div class="bfp-mode bfp-wtype" role="group" aria-label="World type"><button type="button" data-act="wtype" data-wtype="planet">Planet</button><button type="button" data-act="wtype" data-wtype="flat">Sandbox</button></div><span class="bfp-hint bfp-wtypehint"></span></div>
      <label class="bfp-field bfp-scene" hidden>Scene<select name="scene"><option value="">None (the empty plain)</option></select><span class="bfp-hint">Placed at spawn: ready-made test worlds from sandbox/scenes.</span></label>
      <label class="bfp-field bfp-seedf">Seed<input name="seed" placeholder="Leave blank for a random seed" spellcheck="false"></label>
      <label class="bfp-field bfp-biomef">Biome size: <b class="bfp-bsl">${BIOME_SIZES[BIOME_DEF][1]}</b><input name="biome" type="range" min="0" max="${BIOME_SIZES.length - 1}" step="1" value="${BIOME_DEF}"><span class="bfp-hint">Relative size of biomes and climate zones. Small matches older worlds.</span></label>
      <div class="bfp-field">Game mode${modeRow}</div>
      <div class="bfp-field bfp-createopts"></div>
      <button class="primary" type="submit">Create and play</button>
      <button type="button" data-act="hide-create">Back</button>
      <p class="bfp-savenote"></p>
    </form></div>`);
  pauseEl = el("div", "bfp-screen bfp-pause", `<div class="bfp-card">
    <h2 class="bfp-title" style="font-size:30px">Paused</h2>
    <button class="primary" data-act="resume">Resume</button>
    <button data-act="view">Render distance: 6</button>
    <button data-act="budget" title="How many villages beyond the nearest four are simulated, and the limits on time, distance, memory and workers">Distant villages</button>
    <div class="bfp-distant" hidden></div>
    <button data-act="host" title="Where the world's simulation runs: Automatic takes the world server (./run.sh) when there is one, else a background worker in the browser, else this page. Applies the next time the game starts.">Simulation</button>
    ${modeRow}
    <button data-act="opts">Game options</button>
    <div class="bfp-pauseopts" hidden></div>
    <button data-act="help">Controls</button>
    <div class="bfp-help" hidden>${HELP_HTML}</div>
    <button data-act="quit">Save and Quit to Title</button>
    <div class="bfp-note"></div><div class="bfp-saved"></div></div>`);
  deathEl = el("div", "bfp-screen bfp-death", `<div class="bfp-card">
    <h2 class="bfp-title">You died!</h2><p class="bfp-sub" style="color:var(--muted)"></p>
    <button class="primary" data-act="respawn">Respawn</button></div>`);
  for (const e of [startEl, pauseEl, deathEl]) ui.appendChild(e);
  viewBtn = pauseEl.querySelector('[data-act="view"]');
  budgetBtn = pauseEl.querySelector('[data-act="budget"]');
  distantEl = pauseEl.querySelector(".bfp-distant");
  hostBtn = pauseEl.querySelector('[data-act="host"]');
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
    else if (a === "wtype") setWorldType(act.dataset.wtype);
    else if (a === "mon" || a === "far") flipOpt(act);   // the create form's and a world row's options (saved with Create / Save)
    else if (a === "options") renderWorlds({ options: id });
    else if (a === "options-ok") finishOptions(row);
    else if (a === "show-create") showStartView("create");
    else if (a === "hide-create") showStartView("list");
    else if (a === "copy-seed") copySeed(id, act);
    else if (a === "play") playWorld(id, act);
    else if (a === "rename") renderWorlds({ renaming: id });
    else if (a === "rename-ok") finishRename(row);
    else if (a === "delete") renderWorlds({ deleting: id });
    else if (a === "export") exportWorld(id, act);
    else if (a === "import") startEl.querySelector(".bfp-importfile").click();
    else if (a === "copy-browser") copyBrowser(act);
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
  startEl.querySelector(".bfp-importfile").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importWorld(f); });
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
    } else if (a === "budget") { distantEl.hidden = !distantEl.hidden; updateBudgetBtn(); }   // the Distant villages panel
    else if (a === "dv") {   // a Distant villages setting (js/active.js): held until the game resumes (distantApply)
      const f = act.dataset.f, s = distantPending || (BF.active && BF.active.settings());
      if (s && f in s) { const c = BF.active.CHOICES[f]; distantPending = Object.assign({}, s, { [f]: c[(c.indexOf(s[f]) + 1) % c.length] }); }
      updateBudgetBtn();
    } else if (a === "workers") {   // the Cluster workers setting (js/simhost.js): from the next world started
      const H = BF.simHost, c = H.WORKER_CHOICES;
      H.setWorkersPref(c[(c.indexOf(H.workersPref()) + 1) % c.length]);
      updateBudgetBtn();
      pauseNote.textContent = "Cluster workers apply from the next world started: save and quit, then play again.";
    }
    else if (a === "host") cycleHost();
    else if (a === "mode") setGameMode(act.dataset.mode);
    else if (a === "help") helpEl.hidden = !helpEl.hidden;
    else if (a === "opts") { const p = pauseEl.querySelector(".bfp-pauseopts"); p.hidden = !p.hidden; if (!p.hidden) p.innerHTML = optsHTML(BF.gameOpts.all()); }
    else if (a === "mon" || a === "far") {   // in game: applies at once (where the simulation is too: js/protocol.js meta), and saves
      BF.gameOpts.set(act.dataset.mon, flipOpt(act));
      if (BF.simHost && BF.simHost.worker && BF.client) BF.client.meta({ id: BF.save && BF.save.current ? BF.save.current.id : null, monsters: BF.gameOpts.all() });
      savePause();
    }
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

// The Distant villages settings chosen in the open pause menu: they take effect when the menu closes and the game resumes, so clicking
// through the choices doesn't act on each one on the way (Gordon, 2026-10-30: passing "Nearest only" let 27 villages go, and the next
// click loaded them all again). Then the page keeps them, and where the simulation is elsewhere it gets them too (bug-081).
let distantPending = null;
function distantApply() {
  const s = distantPending;
  distantPending = null;
  if (!s || !BF.active) return;
  const away = !!(BF.simHost && BF.simHost.worker);
  BF.active.adopt(s, away);
  if (away) BF.simHost.budget();
}
// "Simulated villages: 6 (budget 40%)" (spec r15-34, js/active.js); in a worker or on the world server the simulation's own line (the
// budget query, answered after the setting it was just sent: bug-081). The panel shows the settings chosen, applied or not.
function updateBudgetBtn() {
  if (!budgetBtn || !BF.active) return;
  const show = r => { budgetBtn.textContent = r.text; if (!distantEl.hidden) distantEl.innerHTML = distantHTML(distantPending || r.settings, r.auto); };
  if (!(BF.simHost && BF.simHost.worker && BF.client)) { show({ text: BF.active.text(), settings: BF.active.settings(), auto: BF.active.auto() }); return; }
  BF.client.query("budget", {}, r => { if (r && r.ok) show(r.settings ? r : Object.assign(r, { settings: BF.active.settings(), auto: BF.active.auto() })); });
}
// The Distant villages panel (Gordon, 2026-10-28): the settings (js/active.js; auto: the automatic values where the simulation is) and the
// Cluster workers setting (js/simhost.js). A click moves a line to its next choice.
function distantHTML(s, auto) {
  const pc = f => Math.round(f * 100) + "%", H = BF.simHost, nearest = s.villages === "nearest";
  const line = (f, text, title) => `<button type="button" data-act="dv" data-f="${f}"${nearest && f !== "villages" ? " disabled" : ""} title="${title}">${text}</button>`;
  let h = `<div class="bfp-opts">` +
    line("villages", "Villages: " + (nearest ? "Nearest only" : "Automatic (as many as run at 1x, nearest first)"), "Automatic adds villages beyond the nearest four, nearest first, while the simulation keeps up at normal speed within the limits below; Nearest only keeps the nearest four") +
    line("share", "Time limit: " + (s.share === "auto" ? "Automatic (" + pc(auto.share) + " of each second)" : pc(s.share) + " of each second"), "The most of each real second the simulation may take at normal speed. Automatic: 80% where it has a thread of its own (a worker or the world server), 40% in this page") +
    line("reach", "Distance limit: " + (s.reach > 0 ? s.reach + " blocks" : "None"), "How far away a simulated village may be") +
    line("mem", "Memory limit: " + (s.mem === "auto" ? "Automatic (" + auto.memMB + " MB)" : s.mem + " MB"), "The most memory the distant villages' chunks may take. Automatic: a quarter of the machine's memory");
  if (H && H.workersPref) {
    const now = H.workersNow(), why = now.why;
    h += `<button type="button" data-act="workers"${why ? " disabled" : ""} title="How many workers a world's simulation splits its villages over, from the next world started. Automatic: one per performance core">Cluster workers: ${why ? now.n + " (" + why + ")" : H.workersLabel(H.workersPref())}</button>`;
  }
  return h + `<span class="bfp-hint">Cluster workers apply from the next world started; the rest when you resume the game.</span></div>`;
}
// "Simulation: World server (1 thread)", and the setting when it forces a host (spec r15-43, js/simhost.js); a click cycles the setting
// (Automatic, World server, Browser (worker), Browser (this page)), which applies from the next start
function updateHostBtn() {
  const H = BF.simHost;
  if (!hostBtn || !H || !H.label) return;
  const p = H.pref();
  hostBtn.textContent = "Simulation: " + H.label() + (p === "auto" ? "" : " (setting: " + H.prefLabel(p) + ")");
}
function cycleHost() {
  const H = BF.simHost;
  if (!H || !H.setPref) return;
  const p = H.CHOICES[(H.CHOICES.indexOf(H.pref()) + 1) % H.CHOICES.length];
  H.setPref(p);
  updateHostBtn();
  pauseNote.textContent = "Simulation from the next start: " + H.prefLabel(p) + (p === "auto" ? " (the world server, else a worker, else this page)" : "") + ". Save and quit, then reload the page.";
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
  if (!BF.page) return;   // (the simulation worker, r15-38: no screens)
  for (const b of document.querySelectorAll(".bfp-mode button[data-mode]")) {
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
  if (menuOpen === "pause" && name !== "pause") distantApply();   // (the pause menu closing: its Distant villages settings take effect)
  menuOpen = name;
  startEl.classList.toggle("on", name === "start");
  pauseEl.classList.toggle("on", name === "pause");
  deathEl.classList.toggle("on", name === "death");
  if (name === "pause") { updateViewBtn(); updateBudgetBtn(); updateHostBtn(); updateModeUI(); pauseNote.textContent = ""; savePause(); }
  if (name === "start") { showStartView("list"); refreshWorlds(); }
  touchEl.classList.toggle("on", isTouch && started && !name);
  const a = document.activeElement;   // a slider or button left focused in a hidden menu would keep taking the keys
  if (a && a !== document.body && a.closest && a.closest(".bfp-screen") && !a.closest(".bfp-screen.on")) a.blur();
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
  if (BF.simHost && BF.simHost.server) return Promise.resolve((saveOk = true));   // (the world server's saves, on its disk)
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
  const H = BF.simHost || {};
  const t = saveOk === false ? "Saving unavailable in this browser. You can still play; worlds won't be kept."
    : H.refused ? "World in use: another page is playing on this world server, so this page runs its own simulation and keeps its worlds in this browser." : "";
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
    setWorldType("planet");
    if (BF.gameOpts) createForm.querySelector(".bfp-createopts").innerHTML = "Game options" + optsHTML(BF.gameOpts.normalize());
    updateModeUI();
    setTimeout(() => { try { createForm.elements.name.select(); } catch (_) {} }, 0);
  }
}
let listN = 0, listP = null;
function refreshWorlds() {
  probeStorage().then(setSaveNote);
  const server = !!(BF.simHost && BF.simHost.server);
  startEl.querySelector(".bfp-where").textContent = server ? "Singleplayer · on the world server" : "Singleplayer";
  startEl.querySelector('[data-act="import"]').hidden = !hasSave() || !BF.save.importFile;
  // "Copy browser saves to the server": when this browser has worlds of its own (spec r15-42)
  const copyBtn = startEl.querySelector('[data-act="copy-browser"]');
  copyBtn.hidden = true;
  if (server && hasSave() && BF.save.browserList) BF.save.browserList().then(l => { const n = l.filter(w => BF.save.playable(w)).length; copyBtn.hidden = !n; copyBtn.textContent = "Copy browser saves to the server (" + n + ")"; });
  if (!hasSave()) { worldsCache = []; renderWorlds({}); return Promise.resolve(); }
  const n = ++listN;   // (only the newest list is shown: the browser's, asked for before the world server answered, can come back after it)
  const p = Promise.resolve(BF.save.list()).catch(() => []).then(list => { if (n === listN) { worldsCache = list || []; renderWorlds({}); } });
  listP = p;
  return p.then(() => (n === listN ? undefined : listP));   // (a list overtaken by a newer one resolves once that one is shown)
}
function renderWorlds(st) {
  if (!worldsCache.length) {
    worldsEl.innerHTML = `<p class="bfp-empty">No saved worlds yet. Create one to start playing.</p>`;
    return;
  }
  worldsEl.innerHTML = worldsCache.map(w => {
    const id = esc(w.id), meta = `${fmtDate(w.lastPlayed)} · <b>${w.gameMode === "creative" ? "Creative" : "Survival"}</b> · seed ${esc(w.seed)}<button type="button" class="bfp-copy" data-act="copy-seed" title="Copy seed to clipboard" aria-label="Copy seed ${esc(w.seed)}">⧉</button> · ${w.world === "flat" ? '<b class="bfp-sandtag">Sandbox</b>' : biomeLabel(w.biomeScale) + " biomes"}`;
    if (st.renaming === w.id) return `<div class="bfp-world" role="listitem" data-id="${id}">
      <div class="bfp-info"><input value="${esc(w.name)}" maxlength="40" aria-label="New world name"></div>
      <div class="bfp-wbtns"><button class="primary" data-act="rename-ok">Save</button><button data-act="cancel">Cancel</button></div></div>`;
    if (st.options === w.id) return `<div class="bfp-world opts" role="listitem" data-id="${id}">
      <div class="bfp-info"><div class="bfp-wname">${esc(w.name)}: game options</div></div>
      <div class="bfp-wbtns"><button class="primary" data-act="options-ok">Save</button><button data-act="cancel">Cancel</button></div>${optsHTML(BF.gameOpts.normalize(w.monsters))}</div>`;
    if (st.deleting === w.id) return `<div class="bfp-world confirm" role="listitem" data-id="${id}">
      <div class="bfp-info"><div class="bfp-wname">Delete “${esc(w.name)}”?</div><div class="bfp-wmeta">This can't be undone.</div></div>
      <div class="bfp-wbtns"><button class="danger" data-act="delete-ok">Delete</button><button data-act="cancel">Cancel</button></div></div>`;
    if (BF.save.playable && !BF.save.playable(w)) return `<div class="bfp-world old" role="listitem" data-id="${id}" aria-disabled="true">
      <div class="bfp-info"><div class="bfp-wname">${esc(w.name)}</div><div class="bfp-wmeta">${esc(BF.save.tooOld(w))}</div></div>
      <div class="bfp-wbtns"><button data-act="delete">Delete</button></div></div>`;   // spec r14-19, r15-42: no older releases' saves (Delete only)
    return `<div class="bfp-world" role="listitem" data-id="${id}">
      <div class="bfp-info"><div class="bfp-wname">${esc(w.name)}</div><div class="bfp-wmeta">${meta}</div></div>
      <div class="bfp-wbtns"><button class="primary" data-act="play">Play</button><button data-act="options">Options</button><button data-act="rename">Rename</button><button data-act="export" title="Download this world as a .bfworld file">Export</button><button data-act="delete">Delete</button></div></div>`;
  }).join("");
  const inp = worldsEl.querySelector("input");
  if (inp) { inp.focus(); inp.select(); }
}
// Puts a saved world's seed on the clipboard (handy when reporting a bug). The button shows a tick for a moment.
function copySeed(id, btn) {
  const w = worldsCache.find(x => x.id === id);
  if (!w) return;
  const text = String(w.seed);
  const done = ok => { btn.textContent = ok ? "✓" : "✗"; btn.classList.toggle("done", ok); btn.title = ok ? "Copied" : "Couldn't copy";
    setTimeout(() => { btn.textContent = "⧉"; btn.classList.remove("done"); btn.title = "Copy seed to clipboard"; }, 1200); };
  const fallback = () => {   // file:// pages and older browsers have no async clipboard
    const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove(); return ok;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(fallback()));
  else done(fallback());
}
function finishOptions(row) {
  const id = row.dataset.id, o = readOpts(row);
  Promise.resolve(BF.save.setMonsters ? BF.save.setMonsters(id, o) : null).catch(e => console.error(e)).then(() => refreshWorlds());
}
function finishRename(row) {
  const id = row.dataset.id, inp = row.querySelector("input"), name = inp && inp.value.trim();
  if (!name) { renderWorlds({}); return; }
  Promise.resolve(BF.save.rename(id, name)).catch(e => console.error(e)).then(() => refreshWorlds());
}
function startNote(t) { for (const n of startEl.querySelectorAll(".bfp-savenote")) n.textContent = t; }
function playWorld(id, btn) {
  if (!hasSave() || !id) return;
  const w = worldsCache.find(x => x.id === id);
  if (w && BF.save.playable && !BF.save.playable(w)) { startNote(BF.save.tooOld(w)); return; }
  requestLock();                       // inside the click so the browser allows it
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  const t0 = performance.now();
  loading("Loading " + (w && w.name || "the world"));
  Promise.resolve(BF.save.load(id)).then(() => { loaded("Loaded", t0); beginPlay(); }).catch(e => {
    console.error(e); exitLock(); loading(null);
    if (btn) { btn.disabled = false; btn.textContent = "Play"; }
    startNote("Couldn't load that world: " + (e && e.message || e));
  });
}
// Export, import and copying browser saves to the server (spec r15-42, js/save.js)
function exportWorld(id, btn) {
  if (!BF.save.exportFile) return;
  btn.disabled = true;
  Promise.resolve(BF.save.exportFile(id)).then(() => startNote(""), e => { console.error(e); startNote("Couldn't export that world: " + (e && e.message || e)); })
    .then(() => { btn.disabled = false; });
}
function importWorld(file) {
  startNote("Importing " + file.name + "…");
  Promise.resolve(BF.save.importFile(file)).then(m => refreshWorlds().then(() => startNote("Imported “" + m.name + "”")),
    e => { console.error(e); startNote("Couldn't import " + file.name + ": " + (e && e.message || e)); });
}
function copyBrowser(btn) {
  btn.disabled = true;
  startNote("Copying this browser's worlds to the world server…");
  BF.save.copyToServer().then(r => {
    const bits = [r.copied.length + " copied"];
    if (r.skipped.length) bits.push(r.skipped.length + " already there");
    if (r.old.length) bits.push(r.old.length + " too old to open");
    if (r.failed.length) bits.push(r.failed.length + " failed (" + r.failed.join("; ") + ")");
    return refreshWorlds().then(() => startNote("Browser saves: " + bits.join(", ") + ". They are still in this browser too."));
  }, e => startNote("Couldn't copy the browser saves: " + (e && e.message || e))).then(() => { btn.disabled = false; });
}
// The loading screen over the start screen from Create or Play until play starts (js/main.js BF.loading, bug-093): in a worker or on
// the world server the world starts there after the page's river step, and the start screen showed again meanwhile.
function loading(text) { if (BF.loading) { if (text) BF.loading.show(text); else BF.loading.hide(); } }
function loaded(what, t0) {
  loading(null);
  if (BF.glog) BF.glog.log("INFO", "save", what + " world \"" + (BF.save && BF.save.current ? BF.save.current.name : "?") + "\": playing after " + ((performance.now() - t0) / 1000).toFixed(1) + " s of loading");
}
// The New World screen's world type (spec idea-050): Planet, or Sandbox (the planet with an empty grass plain for ground, nothing spawning;
// no seed or biome size to pick, creative to start with, and a Scene list of sandbox/scenes to place at spawn).
let createWorldType = "planet";
function setWorldType(t) {
  createWorldType = t === "flat" ? "flat" : "planet";
  const flat = createWorldType === "flat";
  for (const b of createForm.querySelectorAll('[data-act="wtype"]')) b.classList.toggle("on", b.dataset.wtype === createWorldType);
  createForm.querySelector(".bfp-wtypehint").textContent = flat ? "An empty grass plain on the planet. Nothing spawns: build, summon and try things out." : "The round planet with its biomes, villages and wildlife.";
  createForm.querySelector(".bfp-scene").hidden = !flat;
  createForm.querySelector(".bfp-seedf").hidden = flat;
  createForm.querySelector(".bfp-biomef").hidden = flat;
  const nm = createForm.elements.name;
  if (flat && nm.value === "New World") nm.value = "Sandbox";
  else if (!flat && nm.value === "Sandbox") nm.value = "New World";
  if (flat) { createMode = "creative"; updateModeUI(); }
  if (flat && BF.sandbox) BF.sandbox.list().then(names => {
    const sel = createForm.elements.scene, cur = sel.value;
    sel.innerHTML = '<option value="">None (the empty plain)</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = names.includes(cur) ? cur : "";
  });
}
// A fresh sandbox world (#sandbox or #sandbox=<scene>, js/main.js): created, saved and played at once, the scene placed at spawn.
function createSandbox(scene) {
  if (!createForm) return;
  showStartView("create");
  setWorldType("flat");
  createForm.elements.name.value = scene ? "Sandbox " + scene : "Sandbox";
  const sel = createForm.elements.scene;
  if (scene && ![...sel.options].some(o => o.value === scene)) sel.insertAdjacentHTML("beforeend", `<option value="${esc(scene)}">${esc(scene)}</option>`);
  sel.value = scene || "";
  if (BF.glog) BF.glog.log("INFO", "sandbox", "New sandbox world from the address" + (scene ? ", scene \"" + scene + "\"" : ""));
  createWorld();
}
function createWorld() {
  const f = createForm.elements;
  const name = f.name.value.trim() || "New World", seedText = f.seed.value.trim(), mode = createMode || gameMode;
  const biomeScale = BIOME_SIZES[f.biome.value | 0][0], monsters = readOpts(createForm);
  const world = createWorldType === "flat" ? "flat" : undefined, scene = world ? f.scene.value : "";   // a sandbox world (spec idea-050) and its scene
  requestLock();
  const btn = createForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  const t0 = performance.now();
  loading("Creating " + name);
  const done = () => { loaded("Created", t0); btn.disabled = false; beginPlay(); if (scene && BF.sandbox) BF.sandbox.openWhenReady(scene); };
  if (hasSave() && BF.save.create) {
    Promise.resolve(BF.save.create({ name, seed: seedText, gameMode: mode, biomeScale, monsters, world }))
      .catch(e => { console.error(e); if (BF.glog) BF.glog.log("ERROR", "save", "Creating world \"" + name + "\" failed: " + (e && e.message || e)); }).then(done);
  } else {
    const sd = parseSeed(seedText);
    BF.prepareWorld(sd, world).then(() => {   // (the planet works out its rivers first)
      try { BF.newWorld(sd, { gameMode: mode, biomeScale, monsters, world }); } catch (e) { console.error(e); }
      setGameMode(mode);
      done();
    });
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
  else if (ok === false) savedEl.textContent = "Couldn't save" + (BF.save.lastError ? " (" + BF.save.lastError + ")" : "") + (t ? " · last saved " + fmtDate(t) : "");
  else savedEl.textContent = t ? "Saved " + new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}
function quitToTitle(btn) {
  btn.disabled = true; btn.textContent = "Saving…";
  savePause().then(() => {
    btn.disabled = false; btn.textContent = "Save and Quit to Title";
    if (BF.save) { if (BF.save.quit) BF.save.quit(); else BF.save.current = null; }     // the world stays as the title background, unsaved
    started = false;
    keys.clear(); mouseL = mouseR = false; resetBreak();
    exitLock();
    BF.state.paused = false;
    showScreen("start");
  });
}

// ---------- pointer lock ----------
// Escape that closes a screen (inventory, map, sign, chat) or the pause menu re-captures the mouse, but not while the key is
// still down: Chrome handles a held Escape as "leave pointer lock", so a lock granted on keydown is dropped at once and the
// unlock reads as a pause. The request waits for the Escape keyup instead.
// Some browsers still drop that lock, or swallow it, at Escape's release (macOS): an unlock within ESC_GRACE seconds of an
// Escape that closed a screen leaves you in the game with the mouse free (the next click captures it) instead of pausing.
// The grace also lasts ESC_GRACE_FRAMES rendered frames, so a machine too slow to draw a frame a second still gets it.
const ESC_GRACE = 1, ESC_GRACE_FRAMES = 30;
let frameNo = 0, escClosedFrame = -1e9;
const markEsc = () => { escClosedAt = performance.now(); escClosedFrame = frameNo; };
const inEscGrace = () => performance.now() - escClosedAt < ESC_GRACE * 1000 || frameNo - escClosedFrame < ESC_GRACE_FRAMES;
let lockOnEscUp = false, escClosedAt = -1e9, escCloseEvent = null, escCloseHeld = false, escRelock = false;
// When the browser refuses or drops that re-lock (Chrome on macOS refuses one for about a second after any Escape), the game
// still wants the mouse back: it asks once more when that second is up, and on the next key press or click (both count as a
// user gesture, which every browser accepts).
const ESC_RETRY_MS = 1300;
let wantLock = false, escRetryT = 0;
function relockLater() {
  wantLock = true;
  if (escRetryT) return;
  actionBar("Click or press a key to capture the mouse");
  escRetryT = setTimeout(() => {
    escRetryT = 0;
    if (wantLock && !locked && started && !P.dead && !menuOpen && !invOpen()) requestLock();
  }, ESC_RETRY_MS);
}
function stopRelock() { wantLock = false; if (escRetryT) { clearTimeout(escRetryT); escRetryT = 0; } }
if (BF.page) addEventListener("keyup", e => {
  if (e.key !== "Escape") return;
  if (escCloseHeld) { escCloseHeld = false; markEsc(); }   // the grace runs from the release, when the re-lock goes out
  if (!lockOnEscUp) return;
  lockOnEscUp = false;
  if (started && !P.dead && !invOpen() && (!menuOpen || menuOpen === "pause")) { requestLock(); escRelock = inEscGrace(); }
}, true);
if (BF.page) addEventListener("blur", () => { lockOnEscUp = escCloseHeld = escRelock = false; });
// A screen is closing: note it when Escape did it, so neither that key press nor an unlock in the next ESC_GRACE seconds pauses.
function screenClosed() {
  const ev = window.event;
  if (ev && ev.type === "keydown" && ev.key === "Escape") { markEsc(); escCloseEvent = ev; escCloseHeld = true; }
}
function requestLock() {
  if (isTouch || offPlanet) return;   // off the planet the mouse stays free to drag it (closing a screen or the teleport panel up there must not take it)
  const ev = window.event;
  lockOnEscUp = escRelock = false;
  if (ev && ev.type === "keydown" && ev.key === "Escape") { lockOnEscUp = true; return; }
  const cv = canvas();
  if (!cv.requestPointerLock) { dragMode = true; return; }
  try {
    const r = cv.requestPointerLock();
    if (r && r.catch) r.catch(() => onLockError());
  } catch (_) { onLockError(); }
}
function onLockError() {
  if (escRelock && !locked && !escRetryT) relockLater();
  escRelock = false;
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
  if (!dragMode && !isTouch && !offPlanet) {
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
  stopRelock();
  exitLock();
}

// Z frees the mouse without pausing (to use the debug screen while the game runs); a click on the game takes it back.
let mouseFreed = false;
function releaseMouse() {
  mouseFreed = true; stopRelock();
  keys.clear(); mouseL = mouseR = false; resetBreak();
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
// keys typed into a text box are its own; a focused slider, checkbox or button doesn't stop game keys (Escape in the pause menu)
const typingIn = t => !!t && (t.tagName === "TEXTAREA" || t.isContentEditable || (t.tagName === "INPUT" && !/^(range|checkbox|radio|button|submit|reset|color)$/i.test(t.type)));
function bindInput() {
  const cv = canvas();
  addEventListener("keydown", e => {
    const c = e.code;
    if (typingIn(e.target)) return;
    if (c === "Space" || c === "Tab" || (e.ctrlKey && /^Key[WASDQE]$/.test(c))) e.preventDefault();
    if (c === "Escape") {
      if (e.repeat || e === escCloseEvent) return;   // a held Escape, or the one that just closed a screen, must not go on to open the pause menu
      if (invOpen()) { deferredToggle(true); return; }
      if ((dragMode || !locked) && started && !P.dead) { if (menuOpen === "pause") resume(); else if (!menuOpen) pause(); }
      return;
    }
    // invscreen.js handles E/Esc itself (capture phase) while it is open; deferredToggle copes either way
    if (c === "KeyE" && started && !menuOpen && !P.dead && !e.repeat) { deferredToggle(false); return; }
    if (menuOpen || invOpen() || P.dead) return;
    if (wantLock && !locked && !dragMode) requestLock();   // a key press is a user gesture: take the mouse back that Escape's re-lock missed
    if (c === "KeyZ" && !e.repeat && !e.ctrlKey && !e.metaKey && locked) { releaseMouse(); return; }
    if (c === "KeyQ" && !e.ctrlKey && !e.metaKey) throwSelected(); // holding Q keeps throwing at the key-repeat rate, as in Minecraft
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
    keys.add(c);
  });
  addEventListener("keyup", e => keys.delete(e.code));
  addEventListener("blur", () => { keys.clear(); mouseL = mouseR = false; });

  document.addEventListener("pointerlockchange", () => {
    const was = locked;
    locked = document.pointerLockElement === cv;
    if (locked) {
      lockWorked = true; dragMode = false; stopRelock();
      if (escRelock) { escRelock = false; markEsc(); }   // the grace also runs from when that re-lock lands, however slow
      if (menuOpen === "pause") { showScreen(null); BF.state.paused = false; }
    } else if (was) {
      keys.clear(); mouseL = mouseR = false; resetBreak();
      if (mouseFreed) { mouseFreed = false; actionBar(offPlanet ? "Off the planet: drag to turn it, fly down below 19,400 to look around" : "Mouse free: click the game to take it back"); }
      else if (expectUnlock) { expectUnlock = false; if (!invOpen() && started && !menuOpen && !P.dead) requestLock(); }
      else if (!invOpen() && !P.dead && started && !menuOpen && !inEscGrace()) pause();
      else if (!invOpen() && !P.dead && started && !menuOpen && !escRetryT) relockLater();   // dropped just after Escape: ask again
    }
  });
  document.addEventListener("pointerlockerror", onLockError);
  // a save that failed (a full disk, spec r15-42): said on the action bar and the pause menu; the previous save is kept
  let failSaid = 0;
  if (BF.on) BF.on("saveFailed", e => {
    if (BF.save) BF.save.lastError = String(e && e.message || e);
    updateSavedLabel(false);
    if (Date.now() - failSaid > 10000) { failSaid = Date.now(); actionBar("Couldn't save the world: " + (BF.save && BF.save.lastError || "unknown error") + ". The last save is kept."); }
  });
  if (BF.on) BF.on("inventoryClosed", () => {
    screenClosed();
    if (started && !menuOpen && !P.dead && !dragMode && !isTouch && !locked && !offPlanet) requestLock();
  });

  // (a lock that lands off the planet anyway, say one requested just before climbing past 20,000, is let go next frame; until then
  // a drag with the button held still turns the planet)
  document.addEventListener("mousemove", e => { if (!locked) return; if (!offPlanet) look(e.movementX, e.movementY); else if (e.buttons & 1) turnPlanet(e.movementX, e.movementY); });

  // Drag-to-look fallback when there is no pointer lock (mouse or pen; touch handled separately)
  let drag = null;
  cv.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch" || !started || menuOpen || invOpen()) return;
    if (e.button !== 0 && locked === false && dragMode) return; // right / middle click must not start a look-drag
    if (!locked && !dragMode && !offPlanet) requestLock();
    if (!locked) drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id || locked) return;
    if (offPlanet) turnPlanet(e.clientX - drag.x, e.clientY - drag.y);
    else look(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  addEventListener("pointerup", e => { if (drag && e.pointerId === drag.id) drag = null; });

  // No pick block: a middle click uses, like a right click. Ubuntu trackpads report some two-finger right clicks as middle clicks.
  let ctrlRight = false;
  cv.addEventListener("mousedown", e => {
    if (!started || menuOpen || P.dead || invOpen()) { logClick(e, "ignored: " + (!started ? "not started" : menuOpen ? "menu open" : P.dead ? "dead" : "screen open")); return; }
    if (!locked && !dragMode) { logClick(e, "takes the mouse"); return; } // this click only captures the mouse
    e.preventDefault();
    if (e.button === 0 && e.ctrlKey && /Mac/.test(navigator.platform || "")) { ctrlRight = true; mouseR = true; placeCd = 0; logClick(e, "use (ctrl+click)", useNow()); } // macOS ctrl+click = right click
    else if (e.button === 0) { mouseL = true; primaryDown(); logClick(e, "attack / break"); }
    else if (e.button === 2 || e.button === 1) { mouseR = true; placeCd = 0; logClick(e, "use", useNow()); }
    else logClick(e, "no action");
  });
  addEventListener("mouseup", e => {
    if (e.button === 0) { mouseL = false; resetBreak(); if (ctrlRight) { ctrlRight = false; mouseR = false; eatT = 0; } }
    if (e.button === 2 || e.button === 1) { if (drawT > 0) logClick(e, "release bow", bowPower(drawT).toFixed(2)); mouseR = false; eatT = 0; }   // right and middle both draw and release a bow (Ubuntu trackpads)
  });
  cv.addEventListener("contextmenu", e => { e.preventDefault(); logClick(e, ""); });
  cv.addEventListener("auxclick", e => logClick(e, ""));
  addEventListener("wheel", e => {
    if (!started || menuOpen || invOpen() || !e.deltaY) return;
    const I = inv(); if (!I.select) return;
    const cur = I.selectedIndex | 0;
    I.select((cur + (e.deltaY > 0 ? 1 : -1) + 9) % 9);
  }, { passive: true });

  if (isTouch) bindTouch(cv);
}

// Right click on press: use the block / item in front (secondaryDown). Returns what it was aimed at, for the click log.
function useNow() { const r = secondaryDown(); return drawT > 0 ? "draw bow" : targetName() + (r ? "" : " (nothing happened)"); }
function targetName() { const b = target && BF.blocks[target.id]; return b ? b.name : "no block"; }
// Click log for the F3 overlay: the raw mouse fields of the last few presses and what the game did with each.
const clickLog = [];
function logClick(e, action, aim) {
  const mods = ["ctrl", "shift", "alt", "meta"].filter(m => e[m + "Key"]).join("+");
  clickLog.push(`${e.type} button ${e.button} buttons ${e.buttons}${mods ? " " + mods : ""}${e.pointerType ? " " + e.pointerType : ""}${locked ? " locked" : dragMode ? " drag" : ""}` +
    (action ? ` -> ${action}${aim ? " " + aim : ""}` : ""));
  if (clickLog.length > 6) clickLog.shift();
}

function look(dx, dy) {
  if (offPlanet) return;   // off-planet the mouse drags the planet instead
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
  const box = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const bp = box.attributes.position, bn = box.attributes.normal, bu = box.attributes.uv, bi = box.index;
  const faces = ["side", "side", "top", "bottom", "side", "side"];  // BoxGeometry order: +x -x +y -y +z -z
  const shade = [0.8, 0.8, 1, 0.55, 0.68, 0.68];
  const worldFace = [2, 3, 0, 1, 4, 5];  // BoxGeometry face -> js/world.js FACES index (top, bottom, +x, -x, +z, -z)
  // Grey tiles (grass top, leaves) are tinted by biome in the world (js/world.js _faceTint), so tint them here with the biome
  // the player stands in, or the hotbar's default tint, else the held grass block shows a stone-grey top. Grass sides are
  // drawn as in the world: plain dirt with the tinted fringe overlay just outside it.
  let biome = null;
  try { biome = BF.worldgen.tintAt(pos.x, pos.z); } catch (_) {}
  const deft = BF.textures.defaultTint || {};
  const tintFor = k => (k === 1 || k === 4 ? (biome && biome.grass) || deft.grass : k === 2 ? (biome && biome.foliage) || deft.foliage : k === 3 ? (biome && biome.water) || deft.water : null);
  const P = [], N = [], U = [], C = [], I = [];
  const quad = (f, r, t, push) => {
    const v0 = P.length / 3, s = shade[f], c = t ? [s * t[0], s * t[1], s * t[2]] : [s, s, s];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      P.push(bp.getX(i) + bn.getX(i) * push, bp.getY(i) + bn.getY(i) * push, bp.getZ(i) + bn.getZ(i) * push);
      N.push(bn.getX(i), bn.getY(i), bn.getZ(i));
      U.push(r ? r[0] + (r[2] - r[0]) * bu.getX(i) : bu.getX(i), r ? r[1] + (r[3] - r[1]) * bu.getY(i) : bu.getY(i));
      C.push(c[0], c[1], c[2]);
    }
    for (let k = 0; k < 6; k++) I.push(bi.getX(f * 6 + k) - f * 4 + v0);
  };
  const overlays = [];
  for (let f = 0; f < 6; f++) {
    let r = null;
    try { r = BF.textures.uv(b.tiles[faces[f]]); } catch (_) {}
    const tk = BF.world._faceTint ? BF.world._faceTint[id * 6 + worldFace[f]] : 0;
    if (tk === 4 && BF.world._overlayUV) { quad(f, BF.world._dirtUV, null, 0); overlays.push(f); }
    else quad(f, r, tintFor(tk), 0);
  }
  for (const f of overlays) quad(f, BF.world._overlayUV, tintFor(4), 0.002);
  box.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  g.userData.cube = true;
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
// Drawn bow sprites (js/textures.js bowPull): stage 0..2 as vanilla bow_pulling_0/1/2, picked like vanilla's pull predicate
// (draw time under 0.65 s, under 0.9 s, then fully drawn); -1 when not drawing.
const bowTex = [];
function bowTexture(stage) {
  if (bowTex[stage]) return bowTex[stage];
  const t = new THREE.Texture();
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  try { const img = new Image(); img.onload = () => { t.image = img; t.needsUpdate = true; }; img.src = BF.textures.bowPull(stage); } catch (_) {}
  return (bowTex[stage] = t);
}
const bowStage = () => (drawT <= 0 ? -1 : drawFrac() < 0.65 ? 0 : drawFrac() < 0.9 ? 1 : 2);
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
  else if (it.isBlock && it.tiles && BF.world.solidMat && !(BF.textures.iconIsFlat && BF.textures.iconIsFlat(it))) { // flowers, saplings, torches...: a flat sprite, as in the hotbar
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
    vm.visible = started && !P.dead && !offPlanet;
    return;
  }
  // drawing a bow: the drawn sprite, turned so the arrow points ahead towards the crosshair, brought in and up a little
  const bowSt = vmMesh && vmMesh !== hand && isBow(held) ? bowStage() : -2;
  if (bowSt > -2 && vmMesh.userData.bowStage !== bowSt) {
    vmMesh.userData.bowStage = bowSt;
    vmMesh.material.map = bowSt < 0 ? iconTexture(held.id) : bowTexture(bowSt);
    if (bowSt < 0) { vmMesh.rotation.set(0, -0.5, 0.15); vmMesh.position.set(0, 0.06, 0); }
    else { vmMesh.rotation.set(0, -1.0, -Math.PI * 0.75); vmMesh.position.set(-0.02, 0.1, 0); }
  }
  const dr = bowSt >= 0 ? Math.min(1, drawT * 6) : 0, shake = bowSt === 2 ? Math.sin(drawT * 40) * 0.003 : 0;   // a full draw trembles slightly
  vm.position.set(0.48 + bx - s * 0.12 - (eating ? 0.25 : 0) - dr * 0.2, -0.42 - by + s * 0.08 + eat + (eating ? 0.12 : 0) + dr * 0.1 + shake, -0.72 - s * 0.12 + dr * 0.08);
  vm.rotation.set(-s * 0.9, s * 0.4, 0);
  vm.visible = started && !P.dead && !offPlanet;
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
  const mountHud = vehicle && vehicle.ctl.hud ? vehicle.ctl.hud(vehicle) : null;   // riding a horse: its health in place of hunger
  const h = Math.max(0, Math.ceil(P.health)), f = mountHud ? Math.max(0, Math.ceil(mountHud.hp / mountHud.max * 20)) : Math.max(0, Math.ceil(P.hunger));
  const showAir = headInWater || air < AIR_MAX - 0.01;
  const bubbles = Math.ceil(air - 0.01);
  const blink = hurtBlink > 0 && Math.floor(hurtBlink * 8) % 2 === 0;
  const vis = started && !P.dead && menuOpen !== "start" && !creative();
  const key = h + "|" + f + "|" + (showAir ? bubbles : -1) + "|" + blink + "|" + vis + "|" + !!mountHud;
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
    const ic = mountHud ? HEART : FOOD;
    drawIcon(g, ic, x, y, PAL_EMPTY);
    if (v >= 2) drawIcon(g, ic, x, y, PAL);
    else if (v === 1) drawIcon(g, ic, x, y, PAL, 4, 9);
  }
  if (showAir) for (let i = 0; i < bubbles && i < 10; i++) drawIcon(g, BUBBLE, 189 - ((i * 9.5) | 0), 1, PAL_BUB);
}

// ---------- world actions as requests (spec r15-20) ----------
// What the player does to the world goes through act(): a tick-stamped request from "player", applied at once at this tick
// boundary (js/requests.js player()), so it feels instant and orders before the next tick's villagers. act returns the result
// ({ok, ...}). The handlers (onAct) take what they need from the request's data (cells, the hotbar slot it was made with, mob and
// boat ids), never from the moment's input, so a recorded session replays the same (BF.req.record / replay).
const cellKey = (x, y, z) => x + "," + y + "," + z;
const cellOf = t => String(t).split(",").map(Number);
const vec = a => new THREE.Vector3(a[0], a[1], a[2]);
const arr = v => [v.x, v.y, v.z];
// With the simulation in a Web Worker (r15-38) the result comes later: act goes on as if it worked ({ok: true, pending: true}), and the
// world's edits and the player's inventory follow from the simulation; a refused action just doesn't happen there.
function act(kind, target, data) {
  data = data || {};
  if (data.slot == null && BF.inventory) data.slot = BF.inventory.selectedIndex;
  if (!BF.req || !BF.req.player) return { ok: false, why: "no request queue" };
  const req = BF.req.player(kind, target, data);
  if (!req.delivered && BF.client && BF.client.mode === "worker") return { ok: true, pending: true, then: fn => req.then(fn) };
  return req.result || { ok: false, why: "pending" };
}
// Off the page act's answer comes later, so a right click that only sometimes does something checks what the page knows first, and one
// that always does (a cake, a hive, a blank map) takes its message when the answer comes.
const offPage = () => !!(BF.client && BF.client.mode === "worker");
function leadsHorse() {   // a horse on the player's lead, as the protocol's mob views show it (their lead field)
  const M = BF.client && BF.client.world;
  if (!M || !M.entities) return false;
  for (const e of M.entities.values()) if (e.kind === "mob" && e.lead === "player") return true;
  return false;
}
const later = (a, fn) => { if (a.pending) a.then(res => fn(res && res.r)); else fn(a.r); };
// A right click on a mob (player.mob): the module's answer, or true while it is on its way (the simulation in a worker answers later)
function mobAct(data) {
  const a = act("player.mob", null, data);
  if (!a.pending) return a.r;
  a.then(res => { const r = res && res.r; if (typeof r === "string") actionBar(r); else if (r && r.msg) actionBar(r.msg); });   // (its message when it comes)
  return true;
}
function onAct(kind, fn) {
  if (!BF.req) return;
  BF.req.on(kind, req => {
    const d = req.data, I2 = inv();
    if (d.slot != null && I2.select && I2.selectedIndex !== d.slot) I2.select(d.slot);
    return fn(d, req.target, req) || { ok: true };
  });
}
const mobOf = id => (id != null && BF.ids ? BF.ids.get(id) : null);
const idOf = m => (m && m.mirror ? m.sid : m && BF.ids ? BF.ids.idOf(m) : null);   // (a stand-in from the client's mirror: its sid)
function consumeHeld(n) { if (n > 0) { try { if (inv().consumeSelected) inv().consumeSelected(n); } catch (e) { console.error(e); } } }
function giveOrDrop(id, n) { const left = inv().add ? inv().add(id, n) : n; if (left > 0 && BF.drops) BF.drops.spawn(id, left, pos.x, pos.y + 1, pos.z); }

// Breaking: {id: the block broken (refused if it has changed), harvest, shears, wear}.
onAct("player.break", (d, t) => {
  const W = BF.world, [x, y, z] = cellOf(t), b = BF.blocks[d.id];
  if (W.getBlock(x, y, z) !== d.id) return { ok: false, why: "changed" };
  if (!W.setBlock(x, y, z, 0)) return { ok: false, why: "refused" };
  if (d.harvest && b) {
    try {
      const drops = d.shears ? [{ id: d.id, count: 1 }]   // shearing leaves drops the leaves
        : BF.rollDrops ? BF.rollDrops(d.id) : (b.drop != null ? [{ id: b.drop, count: 1 }] : []);
      if (BF.drops) BF.drops.spawnAt(drops, x, y, z);
      else for (const s of drops || []) if (s && s.id != null && s.count > 0 && inv().add) inv().add(s.id, s.count);
    } catch (e) { console.error(e); }
  }
  if (!creative()) exhaustion += 0.005;
  if (d.wear) wearHeld(d.wear);
  emit("blockBroken", x, y, z, d.id);
  return { ok: true };
});
// Placing: {cells: [[x, y, z, id, was]...] (refused if any cell no longer holds `was`), consume, wear}. Also tilling, stripping,
// planting, slabs merging (the cell's slab becomes the full block) and two-block doors and beds.
onAct("player.place", d => {
  const W = BF.world;
  if (!d.cells.every(c => W.isLoaded(c[0], c[2]) && W.getBlock(c[0], c[1], c[2]) === c[4])) return { ok: false, why: "changed" };
  const set = [];
  for (const [x, y, z, id] of d.cells) if (W.setBlock(x, y, z, id)) set.push([x, y, z, id]);
  if (!set.length) return { ok: false, why: "refused" };
  consumeHeld(d.consume);
  if (d.wear) wearHeld(d.wear);
  for (const [x, y, z, id] of set) emit("blockPlaced", x, y, z, id);
  return { ok: true };
});
// Cells to place as [x, y, z, id]; true when placed.
function place(cells, o) {
  const W = BF.world;
  return act("player.place", cellKey(cells[0][0], cells[0][1], cells[0][2]),
    { cells: cells.map(c => [c[0], c[1], c[2], c[3], W.getBlock(c[0], c[1], c[2])]), consume: (o && o.consume) || 0, wear: (o && o.wear) || 0 }).ok;
}
onAct("player.door", (d, t) => { const [x, y, z] = cellOf(t); if (d.gate) BF.world.setGate(x, y, z); else BF.world.setDoor(x, y, z); });
onAct("player.tie", (d, t) => { const [x, y, z] = cellOf(t); return { ok: !!(BF.horses && BF.horses.tieToPost(x, y, z)), why: "nothing to tie" }; });
onAct("player.tent", (d, t) => {
  const [x, y, z] = cellOf(t);
  if (!(BF.tents && BF.tents.place(x, y, z, d.f, cellBlockedByEntity))) return { ok: false, why: "no room" };
  consumeHeld(d.consume);
});
// Right click on a mob with the held item: {mob, what}. The result's r is the module's answer (a message, true, or the horse's plan).
onAct("player.mob", d => {
  const m = mobOf(d.mob), sel = selectedItem();
  if (!m || m.dead || m.removed) return { ok: false, why: "gone" };
  let r = null;
  if (d.what === "villager") r = BF.mobs.interact(m);
  else if (d.what === "sheep") { r = BF.shepherd.playerUse(m, sel); const sh = selectedItem(); if (r === true && sh && BF.items[sh.id].name === "shears") wearHeld(1); }
  else if (d.what === "cow") r = BF.cowherd.playerUse(m, sel);
  else if (d.what === "pig") r = BF.pigFarmer.playerUse(m, sel);
  else if (d.what === "chicken") r = BF.poultry.playerUse(m, sel);
  else if (d.what === "horse") {
    r = BF.horses.playerUse(m, sel, !!d.sneak);
    if (r && r.consume) consumeHeld(r.consume);
    if (r && r.give && BF.I[r.give] != null) giveOrDrop(BF.I[r.give], 1);
  }
  return { ok: true, r };
});
onAct("player.hit", d => {   // a melee hit: {mob, dmg, d: knockback, wear}
  const m = mobOf(d.mob);
  if (!m || m.dead || m.removed) return { ok: false, why: "gone" };
  try { BF.mobs.hit(m, d.dmg, vec(d.d)); } catch (e) { console.error(e); }
  if (d.wear) wearHeld(d.wear);
  if (!creative()) exhaustion += 0.1;
});
onAct("player.hitBoat", d => {
  const b = BF.boats && BF.boats.list && BF.boats.list.find(b => idOf(b) === d.boat);
  if (!b) return { ok: false, why: "gone" };
  return { ok: true, r: BF.boats.hit(b, !!d.creative) };
});
onAct("player.shoot", d => {   // a bow shot: {from, vel, damage, crit, pickup, arrow: one used}
  const a = BF.mobs.shootArrow(vec(d.from), vec(d.vel), { damage: d.damage, crit: d.crit, pickup: d.pickup });
  if (d.arrow) { try { inv().remove(BF.I.arrow, 1); } catch (e) { console.error(e); } }
  wearHeld(1);
  return { ok: true, a };
});
onAct("player.throw", d => {   // Q: one of the held item, thrown from {at} at {vel}
  const sel = selectedItem();
  if (!sel || !BF.drops || !inv().consumeSelected) return { ok: false, why: "nothing held" };
  const id = sel.id, wear = sel.wear || 0;
  try { if (!(inv().consumeSelected(1) > 0)) return { ok: false, why: "nothing held" }; } catch (e) { console.error(e); return { ok: false, why: "error" }; }
  BF.drops.spawn(id, 1, d.at[0], d.at[1], d.at[2], { vel: vec(d.vel), pickupDelay: THROW_PICKUP_DELAY, wear });
  emit("itemThrown", id);
});
onAct("player.eat", () => {
  const sel = selectedItem(), it = sel && BF.items[sel.id];
  if (!it || !it.food) return { ok: false, why: "nothing to eat" };
  finishEating(it);
});
onAct("player.cake", (d, t) => {
  const [x, y, z] = cellOf(t), r = BF.baker.eatCake(x, y, z, P, !!d.creative);
  if (r === true) saturation = Math.min(P.hunger, saturation + 0.4);
  return { ok: true, r };
});
onAct("player.hive", d => {   // a bee nest or beehive: {cell: the targeted block}
  const r = BF.bees.playerUse(d.cell, selectedItem());
  if (r && r.give) {
    if (r.consume && !d.creative) consumeHeld(r.consume);
    if (r.wear) wearHeld(r.wear);
    giveOrDrop(r.give.id, r.give.n);
  }
  return { ok: true, r };
});
onAct("player.bucket", d => ({ ok: !!(BF.villageLife.useBucket(BF.items[selectedItem() ? selectedItem().id : 0], d.cell)), why: "nothing to do" }));
onAct("player.map", () => { const sel = selectedItem(), it = sel && BF.items[sel.id]; return { ok: true, r: it ? BF.maps.use(sel, it) : null }; });
// The creative auto map's width prompt (js/mapview.js, on the page): the held blank auto map becomes the filled one named {name}
onAct("player.autoMap", d => {
  const sel = selectedItem(), it = sel && BF.items[sel.id], I2 = inv();
  if (!it || !it.autoBlank || !/^auto_map_\d+_-?\d+_-?\d+$/.test(d.name || "")) return { ok: false, why: "not a blank auto map" };
  const id = BF.resolveItem(d.name);
  if (sel.count === 1) I2.setSlot(I2.selectedIndex, { id, count: 1 });
  else { I2.setSlot(I2.selectedIndex, { id: sel.id, count: sel.count - 1 }); giveOrDrop(id, 1); }
});
onAct("player.boat", d => {
  if (!BF.boats.placeFromPlayer(d.boat, vec(d.eye), vec(d.dir), d.yaw, REACH)) return { ok: false, why: "no room" };
  consumeHeld(1);
});
// Riding (spec r15-44 part 2): getting on and off are requests, so the simulation decides wherever it runs. {id}: the boat or horse.
onAct("player.mount", d => {
  const v = vehicleOf(d.id);
  if (!v) return { ok: false, why: "gone" };
  if (v.kind === "horse" && !BF.horses.canRide(v)) return { ok: false, why: "You can't ride that horse" };
  if (vehicle !== v && !mount(v)) return { ok: false, why: v.kind === "boat" ? (v.rider ? "Someone is already in that boat" : "No room to sit in that boat") : "No room to get on that horse" };
  return Object.assign({ ok: true, id: d.id }, rideInfo(v));
});
onAct("player.dismount", d => { dismount(!!d.stay); });
onAct("player.horseEgg", (d, t) => {
  const [x, y, z] = cellOf(t);
  if (!BF.horses.spawn(x + 0.5, y + 1, z + 0.5)) return { ok: false, why: "no room" };
  consumeHeld(1);
});
onAct("player.sign", d => {
  const sel = selectedItem(), it = sel && BF.items[sel.id];
  if (!(BF.signs && BF.signs.place(d.cell, it))) return { ok: false, why: "no room" };
  consumeHeld(1);
});
// Sleeping: the spawn point at the bed or tent ({spawn}), then waking ("player.wake") the next morning. The simulation's own clock
// decides: with the simulation off the page, the page's clock can lag behind it just after a wake, so a quick second click on the bed
// asks again in the morning; that sleep is refused and its wake moves no day on (bug-041). (A sleep whose wake never came, e.g. the
// page closed, stops counting after 10 game seconds.)
let asleepAt = null;
onAct("player.sleep", d => {
  const S = BF.sky, now = BF.state.time;
  if (asleepAt != null && now >= asleepAt && now - asleepAt < 10) return { ok: false, why: "asleep" };
  if (!S || !(S.isNight() || (S.stormy && S.stormy()))) return { ok: false, why: "not night" };
  asleepAt = now;
  BF.spawnPoint = d.spawn;
});
onAct("player.wake", () => {
  if (asleepAt == null) return { ok: false, why: "not asleep" };
  asleepAt = null;
  wakeUp();
});

// ---------- world interaction ----------
function eyeVec() { return new THREE.Vector3(pos.x, pos.y + eyeOffset, pos.z); }
function dirVec() { return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)); }

// Q: throw one item from the selected hotbar slot forward as a dropped item. The player can't catch it again for 2 seconds.
// In creative the slot keeps its count (consumeSelected doesn't deduct there), as in Minecraft.
const THROW_SPEED = 6, THROW_LIFT = 1.5, THROW_PICKUP_DELAY = 2;
function throwSelected() {
  const sel = selectedItem();
  if (!sel || !BF.drops || !inv().consumeSelected) return;
  const d = dirVec(), e = eyeVec();
  const vel = d.clone().multiplyScalar(THROW_SPEED); vel.y += THROW_LIFT;
  act("player.throw", null, { at: [e.x + d.x * 0.3, e.y - 0.3, e.z + d.z * 0.3], vel: arr(vel) });
}

function boatHit() {
  if (remoteSim()) return mirrorHit("boat");
  try { return BF.boats ? BF.boats.raycast(eyeVec(), dirVec(), MOB_REACH, vehicle) : null; } catch (_) { return null; }
}
function mobHit() {
  if (remoteSim()) return mirrorHit("mob");
  try { return BF.mobs && BF.mobs.raycast ? BF.mobs.raycast(eyeVec(), dirVec(), MOB_REACH, vehicle) : null; } catch (_) { return null; }
}
// With the simulation in a worker (r15-38) the page has no simulated mobs or boats: it aims at the client's mirror of them
// (BF.client.world.entities). A stand-in carries what this file reads (type, position, box, rider, hostile) and the simulation's id (sid)
// that the request names. Returns {mob | boat: stand-in, dist} like BF.mobs.raycast / BF.boats.raycast, or null.
const remoteSim = () => !!(BF.client && BF.client.mode === "worker");
const MLQ = {};
function standIn(e, x, z) {
  const boat = e.kind === "boat";
  return { mirror: true, kind: e.kind, sid: e.sid, type: e.type, position: new THREE.Vector3(x, e.y, z), pos: new THREE.Vector3(x, e.y, z),
    halfWidth: boat ? BF.boats.HW : e.hw, height: boat ? BF.boats.H : e.h, dead: !!e.dead, rider: e.rider, hostile: !boat && !!(BF.mobs && BF.mobs.isHostile && BF.mobs.isHostile(e.type)),
    lying: !boat && e.sleeping && e.bedF != null ? e : null };   // asleep on a bed: aimed at by its flat box (BF.mobView.rayBoxOf)
}
function mirrorEntities(kind, o, r) {   // the mirror's living mobs (or boats) within r of o, as stand-ins seen from o's frame
  const W = BF.client && BF.client.world, out = [];
  if (!W) return out;
  for (const e of W.entities.values()) {
    if (e.kind !== kind || e.dead || e.sid == null) continue;
    BF.planet.local(o, e, MLQ);
    if ((MLQ.x - o.x) ** 2 + (e.y - o.y) ** 2 + (MLQ.z - o.z) ** 2 <= r * r) out.push(standIn(e, MLQ.x, MLQ.z));
  }
  return out;
}
function mirrorHit(kind) {
  const o = eyeVec(), d = dirVec();
  let best = null;
  for (const m of mirrorEntities(kind, o, MOB_REACH + 2)) {
    if (vehicle && vehicle.sid === m.sid) continue;
    const p = m.position, mn = [p.x - m.halfWidth, p.y, p.z - m.halfWidth], mx = [p.x + m.halfWidth, p.y + m.height, p.z + m.halfWidth];
    if (m.lying && BF.mobView && BF.mobView.rayBoxOf) BF.mobView.rayBoxOf(o, m.lying, mn, mx);
    const t = rayBox(o, d, mn, mx);
    if (t != null && t <= MOB_REACH && (!best || t < best.dist)) best = { [kind === "boat" ? "boat" : "mob"]: m, dist: t };
  }
  return best;
}
function rayBox(o, d, mn, mx) {   // distance along the ray to the box, or null
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
// The mobs whose boxes block a placement or a rest: the simulation's, or the mirror's stand-ins with the simulation in a worker
// (r15-32). Through a face edge (bug-091): a mob kept in another frame is given as a copy at its spot seen from the player's frame.
const nearMobList = r => remoteSim() ? mirrorEntities("mob", pos, r) : BF.regions ? BF.regions.mobsAround(pos.x, pos.z, r, null, { local: true, label: "player near" }).map(seenMob) : (BF.mobs && BF.mobs.list) || [];
function seenMob(m) {
  BF.planet.local(pos, m.position, MLQ);
  if (MLQ.x === m.position.x && MLQ.z === m.position.z) return m;
  return { type: m.type, position: new THREE.Vector3(MLQ.x, m.position.y, MLQ.z), halfWidth: m.halfWidth, height: m.height, dead: m.dead, hostile: m.hostile };
}
// Attacks the mob under the crosshair if it is closer than the targeted block. Returns true if a mob was targeted.
function tryAttack() {
  const bh = boatHit(), m0 = mobHit();
  if (bh && (!target || bh.dist < target.dist) && (!m0 || bh.dist < m0.dist)) {   // hitting a boat: lets its mob out, else damages it (js/boats.js)
    swing();
    if (attackCd > 0) return true;
    attackCd = ATTACK_CD;
    const r = act("player.hitBoat", null, { boat: idOf(bh.boat), creative: creative() }).r;
    emit("boatHit", r);
    return true;
  }
  const m = m0;
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
  act("player.hit", null, { mob: idOf(m.mob), dmg, d: arr(d), wear: it && it.tool ? (it.tool.type === "sword" ? 1 : 2) : 0 });   // a sword wears 1 use per hit, other tools 2 (Minecraft)
  return true;
}
function primaryDown() {
  updateTarget();
  if (tryAttack()) { mouseL = false; return; }
  swing();
}
function resetBreak() { breakTarget = null; breakProgress = 0; if (crackMesh) crackMesh.visible = false; if (BF.cracks) BF.cracks.hide(); }

// Wears the held tool (js/blocks.js BF.wearStack, survival only); a used-up tool breaks with a message and a clink.
function wearHeld(n) {
  try {
    const sel = selectedItem();
    if (!sel || !inv().wearSelected || inv().wearSelected(n) !== "broken") return;
    actionBar("Your " + BF.itemName(sel.id) + " broke");
    if (BF.audio) BF.audio.play("dig.metal", { pitch: 1.5 });
  } catch (e) { console.error(e); }
}
function heldTool() { const sel = selectedItem(), it = sel && BF.items[sel.id]; return (it && it.tool) || null; }
// Vanilla Minecraft mining: each tick deals speed / hardness / (30 if the block will drop, else 100) of a block; it breaks
// once that adds up to 1 (a full block in one tick breaks instantly). speed is the tool's (wood 2, stone 4, iron 6, diamond 8)
// when it is the block's tool type, whatever its tier; a too-low tier still mines at that speed but drops nothing.
// Shears (leaves 15, wool 5) and swords (leaves, pumpkins, melons 1.5) have their own speeds. Mining with the head under
// water or with the feet off the ground is 5x slower each.
function toolSpeed(block, tool) {
  if (!tool) return 1;
  if (tool.type === "shears" && block.shearSpeed) return block.shearSpeed;
  if (tool.type === "sword" && block.swordSpeed) return block.swordSpeed;
  return block.tool && tool.type === block.tool ? tool.speed || 1 : 1;
}
// slow: the extra divisor (5 head under water, x5 feet off the ground).
function mineSeconds(block, tool, slow) {
  if (!block || !isFinite(block.hardness)) return Infinity;
  if (block.hardness <= 0) return 0;
  const perTick = toolSpeed(block, tool) / (slow || 1) / block.hardness / (harvestsWith(block, tool) ? 30 : 100);
  return perTick >= 1 ? 0 : Math.ceil(1 / perTick) / 20;
}
function harvestsWith(block, tool) {
  if (!block.needsTool) return true;
  return !!(tool && tool.type === block.tool && (tool.tier || 0) >= (block.minTier || 0)); // minTier: 1 wood, 2 stone, 3 iron, 4 diamond
}
function breakTime(block) { return mineSeconds(block, heldTool(), (headInWater ? 5 : 1) * (!onGround && !flying ? 5 : 1)); }
function canHarvest(block) { return harvestsWith(block, heldTool()); }
// For tests and villagers: seconds to mine block id `blockId` with item id `itemId` (null = bare hand) standing on dry ground,
// and whether that drops anything.
const toolOf = itemId => (itemId != null && BF.items[itemId] && BF.items[itemId].tool) || null;
P.mineSeconds = (blockId, itemId) => mineSeconds(BF.blocks[blockId], toolOf(itemId), 1);
P.minedDrops = (blockId, itemId) => !!BF.blocks[blockId] && harvestsWith(BF.blocks[blockId], toolOf(itemId));

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
    const { x, y, z, id } = breakTarget, tool = heldTool();
    const r = act("player.break", cellKey(x, y, z), { id, harvest: !creative() && canHarvest(b), shears: !!(b.shearSelf && tool && tool.type === "shears"),
      wear: b.hardness > 0 ? (tool && tool.type === "sword" ? 2 : 1) : 0 });   // tools wear 1 use per block, swords 2 (Minecraft)
    if (!r.ok) { resetBreak(); return; }   // the block changed under the crosshair
    spawnParticles(x, y, z, id);
    resetBreak();
    breakCd = t === 0 && !creative() ? 0.05 : 0.25;   // vanilla: 5 ticks after a break (also the creative repeat), 1 tick for instant breaks
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
  if (boxOverlapsCell(pos.x, pos.y, pos.z, HW, HEIGHT, x, y, z)) return true;   // full box: no block may be placed inside the player
  const list = nearMobList(8);
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
// Places a two-block door (facing the player) or bed (head away from the player) at cell (x, y, z), using up one of the held item.
// wood: species of a door / fence gate item.
function placeMulti(kind, x, y, z, wood) {
  const W = BF.world, f = lookFacing();
  if (kind === "tent") return !!BF.tents && act("player.tent", cellKey(x, y, z), { f, consume: 1 }).ok;   // 3x2 tent, js/tents.js
  if (kind === "gate") {   // fence gate: spans across the player's view
    if (!(y < BF.H && W.isLoaded(x, z) && freeCell(x, y, z))) return false;
    return place([[x, y, z, BF.gateId(BF.DIRS[f][0] === 0 ? "x" : "z", 0, wood)]], { consume: 1 });
  }
  if (!BF.SOLID[W.getBlock(x, y - 1, z)]) return false;
  let cells;
  if (kind === "door") cells = [[x, y, z, BF.doorId((f + 2) % 4, 0, 0, wood)], [x, y + 1, z, BF.doorId((f + 2) % 4, 1, 0, wood)]];
  else {
    const hx = x + BF.DIRS[f][0], hz = z + BF.DIRS[f][1];
    if (!BF.SOLID[W.getBlock(hx, y - 1, hz)]) return false;
    cells = [[x, y, z, BF.bedId(f, 0)], [hx, y, hz, BF.bedId(f, 1)]];
  }
  if (!cells.every(c => c[1] < BF.H && W.isLoaded(c[0], c[2]) && freeCell(c[0], c[1], c[2]))) return false;
  return place(cells, { consume: 1 });
}
// ---------- slabs and stairs ----------
// Placement for items whose block has `shape` (blocks.js): slabs pick bottom/top from the clicked face and merge into the
// full base block on the open half; stairs ascend away from the player. Returns true if something was placed.
function overlapsEntityBoxes(x, y, z, boxes) {
  const hits = (px, py, pz, hw, h) => boxes.some(b => px + hw > x + b[0] / 16 && px - hw < x + b[3] / 16 && py + h > y + b[1] / 16 && py < y + b[4] / 16 && pz + hw > z + b[2] / 16 && pz - hw < z + b[5] / 16);
  if (hits(pos.x, pos.y, pos.z, HW - 0.01, HEIGHT)) return true;
  for (const m of nearMobList(8)) {
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
    if (!place([[x, y, z, id]], { consume: 1 })) return false;
    swing(); placeCd = PLACE_REPEAT; return true;
  };
  const merge = (x, y, z, top) => { // top = the half to fill; a slab of this family on the other half becomes the full block
    const c = BF.blocks[W.getBlock(x, y, z)];
    if (sh.kind !== "slab" || !c || !c.shape || c.shape.kind !== "slab" || c.shape.base !== sh.base || c.shape.top === top) return false;
    if (overlapsEntityBoxes(x, y, z, [top ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16]])) return false; // someone stands in the open half
    return done(x, y, z, sh.base);
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
  return done(x, y, z, id);
}
// Places a ladder against the clicked side face (facing = the face normal), or extends the clicked ladder's column up/down, using up one.
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
  return place([[x, y, z, BF.ladderId(f)]], { consume: 1 });
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
let falling = false;   // asleep and fading out: more clicks on the bed do nothing until you wake (else each one adds a day, bug-041)
function trySleep(t) {
  if (falling) return;
  if (!BF.sky || !(BF.sky.isNight() || (BF.sky.stormy && BF.sky.stormy()))) { actionBar("You can only sleep at night"); return; }
  const b = BF.blocks[t.id], tent = !!b.tent;
  const near = !tent && nearMobList(9).some(m => m.hostile && !m.dead && m.position.distanceTo(pos) < 8);
  if (near) { actionBar("You may not rest now, there are monsters nearby"); return; }
  let foot, sy = 0.5625;
  if (tent) { const o = BF.tents.originOf(t.x, t.y, t.z, t.id); foot = [o.x, o.y, o.z]; sy = 0.125; }
  else foot = b.bed.head ? BF.world.partnerOf(t.x, t.y, t.z, t.id) : [t.x, t.y, t.z];
  const sp = BF.spawnPoint || {};
  act("player.sleep", null, { spawn: { x: foot[0] + 0.5, y: foot[1] + sy, z: foot[2] + 0.5, bed: foot, world: sp.bed ? sp.world : sp } });
  if (tent) { P.hiddenInTent = true; setTimeout(() => { P.hiddenInTent = false; }, 2200); }   // monsters lose sight of the sleeper (mobs.js hostileAI)
  sleepFade();
  falling = true;
  setTimeout(() => { falling = false; act("player.wake"); actionBar("Respawn point set"); emit("playerSlept"); }, 700);
}
// Waking up is the next morning: the day counter moves on unless it is already early morning (sleeping in a daytime storm moves to tomorrow too).
function wakeUp() {
  const S = BF.sky;
  if (S.time > 0.01) S.day = (S.day || 0) + 1;
  S.setTime(0.01);
}
// Inside the world (false for NaN): a point on a face or in a margin that shows one (not past the atlas, nor in a corner wedge).
const inWorld = (x, z) => Number.isFinite(x) && Number.isFinite(z) && !!BF.world.canonXZ(x, z);
// The fallback respawnPoint uses when there is no spawn point or it is off the world: the spawn newWorld chose (BF.worldSpawn: dry
// temperate land on face 4, js/planetgen.js spawnSearch); 8.5, 8.5 only if there is none.
const worldSpawn = () => {
  const w = BF.worldSpawn;
  return w && inWorld(w.x, w.z) ? { x: w.x, z: w.z } : { x: 8.5, z: 8.5 };
};
// Where to stand when respawning at a bed: on it if there is headroom, else on the floor beside it (either half), as in vanilla.
// A bed in a room with a 2-high ceiling has no headroom on top, and the spawn lift would otherwise put you on the roof. Null if
// nowhere near the bed fits.
function bedStandSpot(sp) {
  const W = BF.world, fits = (x, y, z) => !W.boxCollides(x, y, z, HW, HEIGHT) && W.boxCollides(x, y - 0.1, z, HW, 0.1);
  if (!W.boxCollides(sp.x, sp.y + 0.01, sp.z, HW, HEIGHT)) return [sp.x, sp.y + 0.01, sp.z];
  const [bx, by, bz] = sp.bed, id = W.getBlock(bx, by, bz), b = BF.blocks[id];
  const halves = [[bx, bz]];
  if (b && b.bed && W.partnerOf) { const o = W.partnerOf(bx, by, bz, id); if (o) halves.push([o[0], o[2]]); }
  for (const dy of [0, -1, 1]) for (const [hx, hz] of halves) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const x = hx + dx + 0.5, z = hz + dz + 0.5, y = by + dy + 0.01;
    if (fits(x, y, z)) return [x, y, z];
  }
  return null;
}
let bedRespawn = null;   // the bed spawn point while its chunk loads (P.update picks the standing spot then)
// Where to respawn: at the bed if it still stands (or its chunk isn't loaded to check), else the world spawn.
function respawnPoint() {
  let sp = BF.spawnPoint || worldSpawn();
  if (!inWorld(sp.x, sp.z)) BF.spawnPoint = sp = worldSpawn();   // a spawn point past the border (older saves): back to the world spawn
  bedRespawn = null;
  if (sp.bed) {
    const [bx, by, bz] = sp.bed, b = BF.blocks[BF.world.getBlock(bx, by, bz)];
    if (!BF.world.isLoaded(bx, bz)) { bedRespawn = sp; return [sp.x, sp.y + 0.01, sp.z]; }
    if (b && (b.bed || b.tent)) return bedStandSpot(sp) || [sp.x, sp.y + 0.01, sp.z];
    setTimeout(() => actionBar("You have no home bed"), 300);
    BF.spawnPoint = sp = sp.world && sp.world.x != null && inWorld(sp.world.x, sp.world.z) ? sp.world : worldSpawn();
  }
  if (sp.y != null && sp.y >= BF.MIN_Y && sp.y < BF.H) return [sp.x, sp.y + 0.01, sp.z];   // /spawnpoint x y z (lifted out if it's inside blocks)
  return [sp.x, surfaceY(sp.x, sp.z), sp.z];
}

// Right click: open a crafting table, start eating, or place a block. Returns true if something happened.
function secondaryDown() {
  updateTarget();
  const mh = mobHit(), bh = boatHit();
  if (bh && (!target || bh.dist < target.dist) && (!mh || bh.dist < mh.dist)) {   // right click on a boat: get in (js/boats.js)
    mouseR = false;
    if (mountReq(idOf(bh.boat), bh.boat.rider ? "Someone is already in that boat" : "No room to sit in that boat")) swing();
    return true;
  }
  if (mh && mh.mob && mh.mob.type === "villager" && BF.mobs.interact && (!target || mh.dist < target.dist)) {
    mouseR = false;
    const msg = mobAct({ mob: idOf(mh.mob), what: "villager" });
    if (invOpen()) { // the trading screen opened
      if (locked) expectUnlock = true;
      keys.clear(); mouseL = false; resetBreak();
      exitLock();
    }
    if (typeof msg === "string") actionBar(msg);
    return true;
  }
  if (mh && mh.mob && mh.mob.type === "sheep" && BF.shepherd && (!target || mh.dist < target.dist)) {   // wheat feeds a sheep, shears shear it (js/shepherd.js)
    const r = mobAct({ mob: idOf(mh.mob), what: "sheep" });
    if (r) { mouseR = false; swing(); if (typeof r === "string") actionBar(r); return true; }
  }
  if (mh && mh.mob && mh.mob.type === "cow" && BF.cowherd && (!target || mh.dist < target.dist)) {   // wheat feeds a cow, a bucket milks it (js/cowherd.js)
    const r = mobAct({ mob: idOf(mh.mob), what: "cow" });
    if (r) { mouseR = false; swing(); if (typeof r === "string") actionBar(r); return true; }
  }
  if (mh && mh.mob && mh.mob.type === "pig" && BF.pigFarmer && (!target || mh.dist < target.dist)) {   // a carrot, potato or beetroot feeds a pig (js/pigfarmer.js)
    const r = mobAct({ mob: idOf(mh.mob), what: "pig" });
    if (r) { mouseR = false; swing(); if (typeof r === "string") actionBar(r); return true; }
  }
  if (mh && mh.mob && mh.mob.type === "chicken" && BF.poultry && (!target || mh.dist < target.dist)) {   // seeds feed a chicken (js/poultry.js)
    const r = mobAct({ mob: idOf(mh.mob), what: "chicken" });
    if (r) { mouseR = false; swing(); if (typeof r === "string") actionBar(r); return true; }
  }
  if (mh && mh.mob && mh.mob.type === "horse" && BF.horses && (!target || mh.dist < target.dist)) {   // horses: feed, saddle, lead, ride (js/horses.js)
    const id = idOf(mh.mob), a = act("player.mob", null, { mob: id, what: "horse", sneak: sneaking });
    const after = r => {   // the horse's answer: get on (a request too), or its message
      if (r && r.mount) mountReq(id, "No room to get on that horse");
      if (r && r.msg) actionBar(r.msg);
    };
    if (a.pending) { a.then(res => after(res && res.r)); mouseR = false; swing(); return true; }   // (the simulation in a worker answers later)
    if (a.r) { mouseR = false; swing(); after(a.r); return true; }
  }
  const useBlk = !sneaking || !selectedItem(); // sneaking with an item in hand = place; empty-handed sneak still uses blocks (as in Minecraft)
  if (target && target.id === BF.B.crafting_table && useBlk) { openInventory("crafting"); mouseR = false; return true; }
  const tb = target && BF.blocks[target.id];
  if (tb && tb.door && useBlk) { act("player.door", cellKey(target.x, target.y, target.z), {}); swing(); mouseR = false; return true; }
  if (tb && /_fence$/.test(tb.name) && BF.horses && (!offPage() || leadsHorse()) && act("player.tie", cellKey(target.x, target.y, target.z), {}).ok) { swing(); mouseR = false; return true; }   // tie led horses to a fence post
  if (tb && tb.gate && useBlk) { act("player.door", cellKey(target.x, target.y, target.z), { gate: true }); swing(); mouseR = false; return true; }
  if (tb && (tb.bed || tb.tent) && useBlk) { trySleep(target); mouseR = false; return true; }
  if (tb && BF.baker && BF.baker.isCake(target.id) && useBlk) {   // a placed cake: eat a slice (js/baker.js)
    later(act("player.cake", cellKey(target.x, target.y, target.z), { creative: creative() }), r => {
      if (r === true) swing(); else if (typeof r === "string") actionBar(r);
    });
    mouseR = false; return true;
  }
  if (tb && BF.baker && BF.baker.isOven(target.id) && useBlk) { actionBar(BF.baker.ovenText(target.x, target.y, target.z)); mouseR = false; return true; }   // what a baker's oven holds
  if (tb && BF.bees && BF.bees.isHome(target.id) && useBlk) {   // a bee nest or beehive: shears or a glass bottle harvest a full one, otherwise how it is (js/bees.js)
    const a = act("player.hive", null, { cell: Object.assign({}, target), creative: creative() });
    if (a.pending) {   // the sim keeps a record for every loaded hive, so the click is the hive's: its answer comes later
      a.then(res => { const r = res && res.r; if (r && r.give) swing(); if (r && r.msg) actionBar(r.msg); });
      mouseR = false; return true;
    }
    const r = a.r;
    if (r) {
      mouseR = false;
      if (r.give) swing();
      if (r.msg) actionBar(r.msg);
      return true;
    }
  }
  if (target && BF.isFurnace(target.id) && useBlk) {
    openInventory("furnace", canonCell(target.x, target.y, target.z)); mouseR = false; return true;
  }
  if (target && BF.isChest(target.id) && useBlk) {
    openInventory("chest", canonCell(target.x, target.y, target.z)); swing(); mouseR = false; return true;
  }
  if (tb && tb.sign && useBlk && BF.signs) { BF.signs.interact(Object.assign({}, target, canonCell(target.x, target.y, target.z, target.id))); mouseR = false; return true; } // sign editor (js/signs.js)
  if (isBow(selectedItem()) && (creative() || inv().count(BF.I.arrow) > 0)) {   // bow with arrows: start drawing (released in updateDraw); never places or uses a block
    if (drawT <= 0) { drawT = 1e-4; drawStack = selectedItem(); }
    return true;
  }
  const sel = selectedItem(); if (!sel) return false;
  const it = BF.items[sel.id]; if (!it) return false;
  // hoe: till grass / dirt / path into farmland (top face, air above)
  if (it.tool && it.tool.type === "hoe" && target && target.normal[1] === 1 && BF.B.farmland != null &&
      (target.id === BF.B.grass || target.id === BF.B.dirt || target.id === BF.B.dirt_path) &&
      BF.world.getBlock(target.x, target.y + 1, target.z) === 0) {
    const { x, y, z, id } = target, fid = BF.farmland ? BF.farmland.tillId(x, y, z) : BF.B.farmland;   // hydrated only with water or rain (js/farmland.js)
    if (!place([[x, y, z, fid]], { wear: 1 })) return false;
    swing(); spawnParticles(x, y + 0.6, z, id, 6);
    placeCd = PLACE_REPEAT;
    return true;
  }
  // axe: strip a log / wood block (oak_log -> stripped_oak_log, birch_wood -> stripped_birch_wood)
  if (it.tool && it.tool.type === "axe" && target && BF.blocks[target.id] && /^(?!stripped_).+_(log|wood)$/.test(BF.blocks[target.id].name) &&
      BF.B["stripped_" + BF.blocks[target.id].name] != null) {
    const { x, y, z, id } = target, nid = BF.B["stripped_" + BF.blocks[id].name];
    if (!place([[x, y, z, nid]], { wear: 1 })) return false;
    swing(); spawnParticles(x, y + 0.6, z, id, 6);
    placeCd = PLACE_REPEAT;
    return true;
  }
  // planting: seeds / carrot / potato on the top face of farmland (hydrated or not, never dirt) with air above (takes priority over eating)
  if (it.plants && target && (target.id === BF.B.farmland || target.id === BF.B.farmland_dry) && target.normal[1] === 1 &&
      BF.world.getBlock(target.x, target.y + 1, target.z) === 0) {
    if (!place([[target.x, target.y + 1, target.z, it.plants]], { consume: 1 })) return false;
    swing();
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (BF.villageLife && BF.villageLife.useBucket && (it.name === "bucket" || it.name === "water_bucket") && act("player.bucket", null, { cell: target && Object.assign({}, target) }).ok) { swing(); placeCd = PLACE_REPEAT; return true; }   // buckets (js/villagelife.js)
  if ((it.map || it.auto || it.autoBlank) && BF.mapview) { // right click with a filled map opens it full screen; the creative auto map asks for a width (js/mapview.js)
    if (BF.mapview.use(sel, it)) { swing(); mouseR = false; placeCd = PLACE_REPEAT; return true; }
  }
  if (it.mapSize && BF.maps) { // blank map: bind it to the 8x8-chunk zone the player stands in (js/maps.js)
    const a = act("player.map", null, {});
    if (a.pending) { a.then(res => { if (res && res.r) actionBar(res.r); }); swing(); mouseR = false; placeCd = PLACE_REPEAT; return true; }
    if (a.r) { swing(); actionBar(a.r); mouseR = false; placeCd = PLACE_REPEAT; return true; }
  }
  if (it.boat && BF.boats) {   // boat: on the water (or the ground) in front, facing the way the player looks
    if (!act("player.boat", null, { boat: it.boat, eye: arr(eyeVec()), dir: arr(dirVec()), yaw }).ok) return false;
    swing(); mouseR = false;
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.name === "horse_spawn_egg" && BF.horses && target && target.normal[1] === 1) {   // creative spawn item: a wild horse on the ground in front
    if (!act("player.horseEgg", cellKey(target.x, target.y, target.z), {}).ok) return false;
    swing(); mouseR = false; placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.food) { if (P.hunger < P.maxHunger) { if (eatT <= 0) eatT = 0.0001; return true; } return false; }
  if (it.places === "sign" && target) { // signs (js/signs.js): standing on a top face, wall sign on a side face; opens the editor
    if (!(BF.signs && act("player.sign", null, { cell: Object.assign({}, target) }).ok)) return false;
    swing(); mouseR = false;
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.places === "ladder" && target) { // ladders: only on the side face of a solid block (or extending a ladder column up/down)
    if (!placeLadder()) return false;
    swing();
    placeCd = PLACE_REPEAT;
    return true;
  }
  if (it.places && target) {
    const into = BF.REPLACEABLE && BF.REPLACEABLE[target.id];
    const x = into ? target.x : target.x + target.normal[0], y = into ? target.y : target.y + target.normal[1], z = into ? target.z : target.z + target.normal[2];
    if (!placeMulti(it.places, x, y, z, it.wood)) return false;
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
  placeId = BF.facedId(placeId, BF.openFacing({ x, y, z }, P.position));   // furnaces and chests open towards the player (an open side)
  if (!place([[x, y, z, placeId]], { consume: 1 })) return false;
  swing();
  placeCd = PLACE_REPEAT;
  return true;
}
// After eating or drinking `it`: its container (blocks.js `container`: milk bucket -> bucket, milk bottle -> glass bottle) goes into the
// emptied hand slot, else the inventory, else drops. Creative mode used nothing up, so nothing comes back.
function leaveContainer(it) {
  const back = it && it.container ? BF.I[it.container] : null, I2 = inv();
  if (back == null || P.gameMode === "creative" || !I2) return;
  if (!I2.selected() && I2.setSlot) { I2.setSlot(I2.selectedIndex, { id: back, count: 1 }); return; }
  const left = I2.add(back, 1);
  if (left > 0 && BF.drops) BF.drops.spawn(back, left, P.position.x, P.position.y + 1, P.position.z);
}
// The end of eating the selected item `it`: hunger, the item used up, its container left (also BF.player.finishEating, for tests).
function finishEating(it) {
  P.hunger = Math.min(P.maxHunger, P.hunger + it.food);
  saturation = Math.min(P.hunger, saturation + it.food * 0.6);
  try { if (inv().consumeSelected) inv().consumeSelected(1); } catch (e) { console.error(e); }
  try { leaveContainer(it); } catch (e) { console.error(e); }   // milk: the empty bucket or bottle stays in hand (js/cowherd.js)
  emit("playerAte", it.id);
}
P.finishEating = finishEating;
function updateUse(dt) {
  if (placeCd > 0) placeCd -= dt;
  if (drawT > 0) { updateDraw(dt); return; }
  if (eatT > 0) {
    const sel = selectedItem(), it = sel && BF.items[sel.id];
    if (!mouseR || !it || !it.food || P.hunger >= P.maxHunger) { eatT = 0; return; }
    eatT += dt;
    emit("playerEating", it.id); // per frame while eating (audio crunch)
    if (eatT >= EAT_TIME) {
      eatT = 0;
      act("player.eat");
      placeCd = 0.3;
    }
    return;
  }
  if (mouseR && placeCd <= 0 && !secondaryDown()) placeCd = PLACE_REPEAT;
}

// ---------- bow ----------
const isBow = s => { const it = s && BF.items[s.id]; return !!(it && it.tool && it.tool.type === "bow"); };
function bowPower(t) { const f = t / BOW_DRAW; return Math.min(1, (f * f + 2 * f) / 3); }
const bowDamage = f => Math.ceil(BOW_DAMAGE * f);
// While the button is held the draw builds up; on release the arrow flies. Switching away from the bow, running out of arrows
// or opening a screen cancels the draw without firing.
function updateDraw(dt) {
  const sel = selectedItem();
  if (sel !== drawStack || !isBow(sel) || invOpen() || (!creative() && !(inv().count(BF.I.arrow) > 0))) { drawT = 0; drawStack = null; return; }
  if (mouseR) { drawT += dt; return; }
  const f = bowPower(drawT);
  drawT = 0; drawStack = null; placeCd = PLACE_REPEAT;
  if (f >= BOW_MIN) fireArrow(f);
}
function fireArrow(f) {
  if (!BF.mobs || !BF.mobs.shootArrow) return null;
  const d = dirVec();
  for (const k of ["x", "y", "z"]) d[k] += (Math.random() - 0.5) * 0.015;   // vanilla's small spread
  d.normalize();
  const from = eyeVec().addScaledVector(d, 0.4); from.y -= 0.1;
  const crit = f >= 1 && Math.random() < BOW_CRIT, damage = bowDamage(f);   // the player's own rolls: the request carries them (replays the same)
  // creative: arrows are free; 1 use of the bow's 384 per shot (survival; js/playerinv.js wearSelected)
  const a = act("player.shoot", null, { from: arr(from), vel: arr(d.multiplyScalar(BOW_SPEED * f)), damage, crit, pickup: creative() ? 2 : 1, arrow: !creative() }).a;
  P.lastShot = { power: +f.toFixed(3), damage, crit, speed: +(BOW_SPEED * f).toFixed(2) };
  emit("playerShot", P.lastShot);
  return a;
}
const drawFrac = () => Math.min(1, drawT / BOW_DRAW);

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
  // Vanilla invulnerability: during the half second after a hit, a stronger hit still deals the difference (a creeper
  // blast right after a zombie punch), a weaker or equal one does nothing.
  let dealt = amount;
  if (!cause) {
    if (hurtCd > 0) { if (amount <= hurtAmt) return; dealt = amount - hurtAmt; hurtAmt = amount; }
    else { hurtCd = 0.5; hurtAmt = amount; }
  }
  P.health = Math.max(0, P.health - dealt);
  lastCause = cause || (fromPos ? "slain" : "hurt");
  flashT = 0.45; hurtBlink = 0.5;
  if (fromPos) {
    let dx = pos.x - fromPos.x, dz = pos.z - fromPos.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    vel.x += dx * 7; vel.z += dz * 7;
    if (!flying) vel.y = Math.max(vel.y, 5);
  }
  exhaustion += 0.1;
  emit("playerDamaged", dealt);
  if (P.health <= 0) die();
};
P.heal = function (n) { if (!P.dead) P.health = Math.min(P.maxHealth, P.health + n); };

const DEATH_MSG = { killed: "You were killed", fell: "You hit the ground too hard", drowned: "You drowned", starved: "You starved to death", slain: "You were slain", lightning: "You were struck by lightning", hurt: "You died" };
function die() {
  dismount();
  P.dead = true; P.health = 0;
  resetBreak(); mouseL = mouseR = false; keys.clear(); eatT = 0; drawT = 0; flying = false; turbo = false;
  if (invOpen()) {   // every screen closes (the command line closes itself on playerDied)
    try { inv().close(); } catch (_) {}
    try { if (BF.signs && BF.signs.isOpen()) BF.signs.closeEditor(); } catch (_) {}
    try { if (BF.mapview && BF.mapview.isOpen()) BF.mapview.close(); } catch (_) {}
    try { if (BF.coords && BF.coords.panel.isOpen()) BF.coords.panel.close(); } catch (_) {}
    try { if (BF.designer && BF.designer.isOpen()) BF.designer.close(); } catch (_) {}
  }
  const where = BF.coords ? "\n" + BF.coords.describe(pos.x, pos.y, pos.z, { whole: true }) + "  " + (BF.coords.latLonText(pos.x, pos.z) || "") : "";   // planet: where it happened (spec r14-18)
  deathEl.querySelector(".bfp-sub").textContent = (DEATH_MSG[lastCause] || "You died") + where;
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
  hurtCd = 1; hurtAmt = Infinity; flashT = 0; regenT = starveT = drownT = 0; eatT = 0;
  dismount(true);
  resetBreak();
}

// ---------- physics ----------
const LADDER_UP = 2.35, LADDER_DOWN = 3;   // blocks/s
let ladderHit = false;                      // pushed against a wall last frame (forward then climbs)
function onLadder() {                       // a ladder cell at the feet or at the waist (so a ladder one block up can be grabbed)
  const W = BF.world, a = BF.blocks[W.getBlock(pos.x, pos.y + 0.001, pos.z)], b = BF.blocks[W.getBlock(pos.x, pos.y + 1, pos.z)];
  return !!((a && a.ladder) || (b && b.ladder));
}
// Riding (a boat, js/boats.js): W/S forward and back, A/D turn (the view turns with the vehicle), Space jump, Shift gets off.
function ridePhysics(dt, k) {
  const shift = k.has("ShiftLeft") || k.has("ShiftRight");
  if (shift && !rideShift) { leave(); return 0; }
  rideShift = shift;
  let fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
  let turn = (k.has("KeyA") ? 1 : 0) - (k.has("KeyD") ? 1 : 0);
  if (stick.id != null) { fwd = -stick.y; turn = -stick.x; }
  if (eatT > 0) fwd *= 0.35;
  rideStep(dt, { fwd, turn, strafe: -turn, jump: k.has("Space"), yaw });
  onGround = true; inWater = false; flying = false; sprinting = false; sneaking = false; turbo = false; fallStart = null;
  headInWater = BF.RENDER[BF.world.getBlock(pos.x, pos.y + eyeOffset, pos.z)] === 3;
  return 0;   // no head bob or walking hunger
}
function rideStep(dt, input) {
  const v = vehicle;
  yaw += v.ctl.drive(v, dt, input) || 0;
  if (vehicle !== v) return;   // thrown off
  const s = v.ctl.seatOf(v, "player");
  pos.set(s.x, s.y, s.z);
  const vv = v.vel || { x: 0, y: 0, z: 0 };
  vel.x = vv.x; vel.y = vv.y; vel.z = vv.z;
}
// Gets in boat b (fromSave: back into the boat the player was saved in, without the room check). Returns true if seated.
function mount(v, fromSave) {
  if (!v || !v.ctl || P.dead) return false;
  if (vehicle === v) return true;
  if (!fromSave && !v.ctl.canBoard(v)) return false;
  if (vehicle) dismount();
  vehicle = v; v.rider = true; rideShift = true;
  if (v.ctl.onMount) v.ctl.onMount(v);
  flying = false; sprinting = false; sneaking = false; turbo = false; fallStart = null; resetBreak();
  const s = v.ctl.seatOf(v, "player");
  pos.set(s.x, s.y, s.z); vel.x = vel.y = vel.z = 0;
  emit("mounted", v);
  return true;
}
// Gets out: onto the nearest solid block beside the boat, else into the water. A mob passenger gets out too.
// stay: leave the player where they are (teleport, respawn, a new world).
// The page's copy of a vehicle (the simulation in a worker, ridePose): the simulation gets the player off (player.dismount) and sends
// where they landed; the page only lets go of its copy.
function dismount(stay) {
  const v = vehicle;
  if (!v) return;
  vehicle = null; v.rider = false;
  if (v.local) { mirrorRide = null; act("player.dismount", null, { stay: !!stay }); emit("dismounted", v); return; }
  if (stay) return;
  if (v.ctl.onLeave) v.ctl.onLeave(v);
  const s = v.ctl.exitSpot(v, HW, HEIGHT);
  pos.set(s.x, s.y, s.z); vel.x = vel.y = vel.z = 0; fallStart = null;
  emit("dismounted", v);
}
// Shift: get off, a request (the simulation runs onLeave and finds the spot, js/boats.js / js/horses.js)
function leave() {
  if (!vehicle) return;
  if (vehicle.local) { dismount(); return; }
  act("player.dismount", null, {});
}
// A right click's request to get on {id}; no: the action bar's message when it's refused. True unless refused at once.
function mountReq(id, no) {
  const a = act("player.mount", null, { id });
  const done = r => { if (!r || !r.ok) actionBar(r && r.why && r.why !== "gone" && r.why !== "pending" ? r.why : no); };
  if (a.pending) { a.then(done); return true; }
  done(a);
  return !!a.ok;
}
const vehicleOf = id => {
  if (id == null) return null;
  const b = BF.boats && BF.boats.list.find(b => idOf(b) === id);
  if (b) return b;
  const m = mobOf(id);
  return m && m.kind === "horse" && m.ctl && !m.dead && !m.removed ? m : null;
};
const rideInfo = v => (v.kind === "boat" ? BF.boats.rideInfo(v) : BF.horses.rideInfo(v));

// ---- riding with the simulation in a worker (spec r15-44 part 2). Whoever steers moves the vehicle, as for the player's body (r15-38):
// the page rows a boat and rides a saddled, tamed horse with its own copy (js/boats.js / js/horses.js localCopy, driven by the same
// drive()) and reports where it is (rideReport, the player message's ride); the simulation sets the real one there (ridePose). An untamed
// horse steers itself: the simulation drives it (simRide) and the page sits the player on the mirror's horse (mirrorRide). What the
// simulation does to the ride comes back in self.mount (rideState / rideSelf): getting on (a request, or a save), being thrown or put
// off (the horse died or went under, the boat broke, a teleport), and the horse's health for the HUD.
let mirrorRide = null;   // {id, e: the mirror entity} that the page draws where its copy is
function mirrorOf(id) {
  const W = BF.client && BF.client.world;
  if (!W) return null;
  if (mirrorRide && mirrorRide.id === id && W.entities.get(mirrorRide.n) === mirrorRide.e) return mirrorRide.e;
  for (const [n, e] of W.entities) if (e.sid === id && !e.dead) { mirrorRide = { id, n, e }; return e; }
  return null;
}
// The page's stand-in for a horse the simulation steers: it sits the player on the mirror's horse
const MIRROR_CTL = {
  drive(v) {
    const e = mirrorOf(v.sid);
    if (e) { BF.planet.local(pos, e, MLQ); v.position.set(MLQ.x, e.y, MLQ.z); v.yaw = e.yaw; }
    return 0;
  },
  seatOf: v => ({ x: v.position.x, y: v.position.y + v.info.seat, z: v.position.z }),
  sitEye: v => v.info.sitEye,
  canBoard: () => true,
  exitSpot: v => ({ x: v.position.x, y: v.position.y, z: v.position.z }),
  hud: v => ({ hp: v.info.hp, max: v.info.max }),
};
function pageCopy(id, info, pose) {
  if (info.kind === "boat") return BF.boats.localCopy(id, info, pose);
  if (info.steer === "page") return BF.horses.localCopy(id, info, pose);
  return { local: true, sid: id, kind: "horse", ctl: MIRROR_CTL, info, position: new THREE.Vector3(pose.x, pose.y, pose.z), vel: new THREE.Vector3(), yaw: pose.yaw || 0 };
}
// page: self.mount, what the simulation says the player rides (null: nothing; {id, kind, steer, ..., pose} from rideInfo)
P.rideSelf = function (m) {
  if (!m) { if (vehicle && vehicle.local) { const v = vehicle; vehicle = null; v.rider = false; mirrorRide = null; emit("dismounted", v); } return; }
  const v = vehicle;
  if (v && v.local && v.sid === m.id && (v.info ? v.info.steer : "page") === m.steer) {   // the same ride: its health, passenger, a horse tamed
    if (v.info) v.info = Object.assign(v.info, m);
    if (v.kind === "horse" && v.maxHp != null) { v.hp = m.hp; v.maxHp = m.max; }
    if (v.kind === "boat") BF.boats.setPassenger(v, m.pass);
    return;
  }
  if (v) { vehicle = null; v.rider = false; }
  mount(pageCopy(m.id, m, m.pose || { x: pos.x, y: pos.y, z: pos.z, yaw: 0 }), true);
};
// page: the player message's ride, the pose of the copy the page steers (null when the simulation steers or nothing is ridden)
P.rideReport = function () {
  const v = vehicle;
  if (!v || !v.local || v.ctl === MIRROR_CTL) return null;
  const p = v.pos || v.position, r = { id: v.sid, x: p.x, y: p.y, z: p.z, yaw: v.yaw, vel: [v.vel.x, v.vel.y, v.vel.z] };
  if (v.rowing) r.rowing = v.rowing.slice();
  if (v.fall) { r.fall = v.fall; v.fall = 0; }
  return r;
};
// page, each frame: the mirror's boat or horse drawn where the page's copy is (the simulation's lags a message behind)
function syncMirrorRide() {
  const v = vehicle;
  if (!v || !v.local || v.ctl === MIRROR_CTL) return;
  const e = mirrorOf(v.sid);
  if (!e) return;
  const p = v.pos || v.position;
  e.x = p.x; e.y = p.y; e.z = p.z; e.yaw = v.yaw;
  if (e.prev) { e.prev.x = p.x; e.prev.y = p.y; e.prev.z = p.z; e.prev.yaw = v.yaw; }
  if (v.rowing && e.rowing) { e.rowing = v.rowing.slice(); e.row = v.row.slice(); }
}
// simulation: what the player rides, for self.mount (null when nothing)
P.rideState = function () {
  const v = vehicle;
  if (!v || v.local) return null;
  return Object.assign({ id: idOf(v) }, rideInfo(v));
};
P.ridePose = function () { const v = vehicle; if (!v || v.local) return null; const p = v.pos || v.position; return { x: p.x, y: p.y, z: p.z, yaw: v.yaw }; };
// simulation: the page's ride (player message): its boat or horse goes where the page rowed or rode it; a fall hurts the horse
P.rideIn = function (r) {
  const v = vehicle;
  if (!v || v.local || !r || idOf(v) !== r.id || rideInfo(v).steer !== "page") return;
  const p = v.pos || v.position;
  p.set(r.x, r.y, r.z); v.yaw = r.yaw;
  if (Array.isArray(r.vel)) v.vel.set(r.vel[0], r.vel[1], r.vel[2]);
  if (Array.isArray(r.rowing) && v.rowing) { v.rowing[0] = r.rowing[0]; v.rowing[1] = r.rowing[1]; }
  if (r.fall > 0 && v.kind === "horse" && BF.mobs) BF.mobs.hurt(v, r.fall, "a fall");
};
// simulation, each loop in real time (js/simworker.js): an untamed horse carries the player where it likes and throws them; the
// player is put off a boat or horse that is gone (died, unloaded) whoever steers it
P.simRide = function (dt) {
  const v = vehicle;
  if (!v || v.local) return;
  if (v.dead || v.removed || (v.kind === "boat" && !BF.boats.list.includes(v))) { dismount(); return; }
  if (P.dead || (BF.state && BF.state.paused) || rideInfo(v).steer !== "sim") return;
  rideStep(Math.min(dt, 0.1), { fwd: 0, turn: 0, strafe: 0, jump: false, yaw });
};
function physics(dt) {
  const k = touchKeys.size ? new Set([...keys, ...touchKeys]) : keys;
  if (vehicle) return ridePhysics(dt, k);
  const wantJump = k.has("Space");
  const shift = k.has("ShiftLeft") || k.has("ShiftRight");
  sneaking = shift && !flying;
  let fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
  let strafe = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
  if (stick.id != null) { fwd = -stick.y; strafe = stick.x; if (fwd > 0.92) sprinting = true; }
  if ((k.has("ControlLeft") || k.has("ControlRight") || k.has("KeyR")) && fwd > 0) sprinting = true;
  if (fwd <= 0 || sneaking || (P.hunger <= 6 && !flying) || eatT > 0 || drawT > 0) sprinting = false;
  turbo = flying && k.has("KeyR") && fwd > 0 && !!(k.has("KeyW") || k.has("ArrowUp") || stick.id != null);   // flying with W + R held; releasing either (or landing) ends the boost
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
  // the planet, creative flight: speed grows with the height above the ground, so a few seconds of Space (with R for the boost)
  // reach orbit and you can get around the planet from high up (spec r14-04, the prototype's curve: the boost times height / 150).
  // Above 150 R alone boosts vertical flight too, and climbing is as fast as flying forward. (Not the prototype's Ctrl for double:
  // Ctrl+R reloads the page and Ctrl+W closes it in a browser.)
  let vert = 0.75;
  if (flying && creative() && BF.view) {
    const above = pos.y - BF.view.groundAt(pos.x, pos.z);
    if (above > 150) {
      if (k.has("KeyR")) speed = CFLY * TURBO_MULT;
      speed *= above / 150;
      vert = 1;
      // below the chunk ceiling (js/world.js) chunks still load, and ones not loaded yet read as solid: don't outrun them
      if (!BF.world.high && speed > CFLY * 2) {
        const sp = Math.hypot(vel.x, vel.z);
        if (sp > 1) {
          const ahead = Math.max(TURBO_LOOKAHEAD * 16, sp * 0.5);
          if (!BF.world.chunks.has(Math.floor((pos.x + vel.x / sp * ahead) / 16) + "," + Math.floor((pos.z + vel.z / sp * ahead) / 16))) speed = CFLY * 2;
        }
      }
    }
  }
  if ((eatT > 0 || drawT > 0) && !flying) speed *= 0.35;   // eating or drawing a bow: slowed, as in vanilla

  const climbing = !flying && !inWater && onLadder();   // body in a ladder cell: gravity is replaced by climbing
  const accel = flying ? 10 : inWater ? 6 : onGround ? 14 : 2.6;
  const a = 1 - Math.exp(-accel * dt);
  vel.x += (mx * speed - vel.x) * a;
  vel.z += (mz * speed - vel.z) * a;

  if (flying) {
    const vy = (wantJump ? 1 : 0) - (shift ? 1 : 0);
    vel.y += (vy * speed * vert - vel.y) * (1 - Math.exp(-10 * dt));
    if (vert === 1 && pos.y > 3 * BF.planet.R && vel.y > 0) vel.y = 0;   // flight tops out at three planet radii up, as in the prototype
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
  const res = BF.world.moveBox(pos, vel, HW, HEIGHT, dt, { stepUp: 0.6, firm: true }); // vanilla step height: slabs, stairs and beds, not full blocks
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

// The planet (generator 4): when the player (or the boat or horse they ride) leaves their face's square, they carry on from the
// same spot on the next face, with facing and speed turned by that edge's quarter turns (spec r14-03). The view switches faces in
// the same frame (js/view.js), so the picture doesn't move. Past two edges at once (a corner's wedge, deep in the ocean) the
// nearest face takes them.
const cc = {}, ct = [0, 0];
function turnBy(q, holder, v) {
  if (!q) return;
  const PL = BF.planet;
  if (holder) holder.yaw = PL.turnYaw(q, holder.yaw);
  if (v) { PL.turnVec(q, v.x, v.z, ct); v.x = ct[0]; v.z = ct[1]; }
}
function recanonAt(p, holder, v) {   // p: {x, z}; holder: has a yaw (or null); v: {x, z} velocity (or null). The quarter turns applied, or -1 if not moved.
  const c = BF.planet.canon(p.x, p.z, cc);
  if (c.off || (c.x === p.x && c.z === p.z)) return -1;
  p.x = c.x; p.z = c.z;
  const q = (4 - c.turn) % 4;
  turnBy(q, holder, v);
  return q;
}
const me = { yaw: 0 };
function crossEdge() {
  if (vehicle) {
    const vp = vehicle.pos || vehicle.position;
    const q = vp ? recanonAt(vp, vehicle, vehicle.vel) : -1;
    if (q >= 0) {   // the rider crosses with it: the view and velocity turn by the same quarter turns
      me.yaw = yaw; turnBy(q, me, vel); yaw = me.yaw;
      if (vehicle.ctl.seatOf) { const st = vehicle.ctl.seatOf(vehicle, "player"); pos.set(st.x, st.y, st.z); }
      else recanonAt(pos, null, null);
      if (breakTarget) resetBreak();
      emit("crossedEdge", { x: pos.x, z: pos.z });
      return;
    }
  }
  me.yaw = yaw;
  if (recanonAt(pos, me, vel) >= 0) {
    yaw = me.yaw;
    if (breakTarget) resetBreak();
    emit("crossedEdge", { x: pos.x, z: pos.z });
  }
}

// High up on the planet (the view more than half round) facing is kept as a direction on the sphere across each step, so long
// flights follow great circles and don't bend where grid lines do (spec r14-04). yaw stays the one source of truth: the 3D facing is
// derived from it before the step and yaw is derived back after.
function frameHere() {
  const PL = BF.planet, c = PL.canon(pos.x, pos.z, cc);
  return c.off ? null : PL.frame(c.f, c.u, c.v, pos.y, {});
}
function roundHeading() {
  if (!BF.view || BF.view.kAt(pos.x, pos.y, pos.z) <= 0.5) return null;
  const fr = frameHere();
  if (!fr) return null;
  const du = -Math.sin(yaw), dv = -Math.cos(yaw), up = fr.up;
  const h = [fr.eu[0] * du + fr.ev[0] * dv, fr.eu[1] * du + fr.ev[1] * dv, fr.eu[2] * du + fr.ev[2] * dv];
  const d = h[0] * up[0] + h[1] * up[1] + h[2] * up[2];
  return [h[0] - up[0] * d, h[1] - up[1] * d, h[2] - up[2] * d];
}
function yawToward(h) {   // yaw facing 3D tangent direction h at the player's position (h is projected onto the tangent plane)
  const fr = frameHere();
  if (!fr) return yaw;
  const up = fr.up, d = h[0] * up[0] + h[1] * up[1] + h[2] * up[2];
  const g = BF.planet.toGrid([h[0] - up[0] * d, h[1] - up[1] * d, h[2] - up[2] * d], fr);
  return Math.hypot(g[0], g[1]) > 1e-9 ? Math.atan2(-g[0], -g[1]) : yaw;
}
function keepHeading(h3) {
  if (!h3) return;
  const y = yawToward(h3);
  // turn the velocity with the facing, so the flight carries on along the great circle
  const dq = y - yaw, c = Math.cos(dq), sn = Math.sin(dq), vx = vel.x, vz = vel.z;
  vel.x = vx * c + vz * sn; vel.z = -vx * sn + vz * c;
  yaw = y;
}

// Off-planet mode (spec r14-04, Gordon's design from the prototype): above layer 20,000 the camera looks straight down at the
// planet's centre with north at the top, the pointer lock is let go, and dragging turns the planet under the player at the same
// height. Back below 19,400 the mouse looks around again, starting from straight down.
function updateOffPlanet() {
  const V = BF.view, on = !!V && pos.y > (offPlanet ? V.OFF_BACK : V.OFF);
  if (on === offPlanet) { if (on) { faceNorth(); if (locked) { mouseFreed = true; exitLock(); } } return; }
  offPlanet = on;
  if (on) { resetBreak(); if (locked) releaseMouse(); faceNorth(); }
  else { pitch = -1.5; }
}
function faceNorth() {
  const fr = frameHere();
  if (!fr) return;
  const u = fr.up, n = [-u[0] * u[1], 1 - u[1] * u[1], -u[2] * u[1]];   // the planet's axis (y), flattened onto the ground
  if (Math.hypot(n[0], n[1], n[2]) > 1e-4) yaw = yawToward(n);
  pitch = -1.5;
}
// Drags by (dx, dy) pixels: the ground under the middle of the screen follows the mouse. Radians per pixel min(h, R + h) / (pxScale R),
// longitude scaled by 1 / cos(latitude), latitude kept within 89 degrees.
function turnPlanet(dx, dy) {
  const PL = BF.planet, c = PL.canon(pos.x, pos.z, cc);
  if (c.off) return;
  const d = PL.dir(c.f, c.u, c.v, [0, 0, 0]), h = Math.max(1, pos.y - BF.SEA);
  let lat = Math.asin(d[1]), lon = Math.atan2(d[0], d[2]);
  const pxScale = BF.renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(BF.camera.fov * Math.PI / 360));
  const a = Math.min(h, PL.R + h) / (pxScale * PL.R), lim = 89 * Math.PI / 180;
  lon -= dx * a / Math.max(0.05, Math.cos(lat));
  lat = Math.max(-lim, Math.min(lim, lat + dy * a));
  const g = PL.fromDir(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon), {}), at = PL.atlas(g.f, g.u, g.v);
  pos.x = at.x; pos.z = at.z; vel.x = vel.z = 0;
  flying = true;
  faceNorth();
}
P.turnPlanet = turnPlanet;   // tests
P.showMenu = name => showScreen(name || null);   // tests: a menu shown or closed as a player would, without starting play (test/budget-menu.js)

// ---------- camera ----------
function syncCamera(dt) {
  const want = vehicle ? vehicle.ctl.sitEye(vehicle) : sneaking ? SNEAK_EYE : EYE;
  eyeOffset += (want - eyeOffset) * Math.min(1, dt * 14);
  if (!BF.camera) return;   // headless (js/boot.js): no camera
  const by = Math.abs(Math.sin(bobPhase)) * 0.06 * bobAmt, bx = Math.cos(bobPhase) * 0.035 * bobAmt;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  BF.camera.position.set(pos.x + rx * bx, pos.y + eyeOffset + by, pos.z + rz * bx);
  BF.camera.rotation.set(pitch, yaw, 0, "YXZ");
  const df = drawT > 0 ? drawFrac() : 0;
  const wantFov = BASE_FOV * (turbo ? 1.25 : sprinting ? 1.12 : 1) * (1 - df * df * 0.15);   // drawing a bow zooms in up to 15% (vanilla)
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
  target = P.dead || offPlanet ? null : BF.world.raycast(eyeVec(), dirVec(), REACH);
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
  if (VIEW_OPTS.includes(vd)) { if (vd !== BF.world.viewDist) setViewDist(vd, false); else updateFar(); }
  else if (!navigator.webdriver) setViewDist(VIEW_OPTS[VIEW_OPTS.length - 1], false);
  else updateFar();
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
  hurtCd = 2; hurtAmt = Infinity;
  if (menuOpen === "death") { showScreen(null); BF.state.paused = false; }
  syncCamera(0.016);
};

P.eyePos = () => eyeVec();
P.lookDir = () => dirVec();
P.setLook = function (y, p) { yaw = y; pitch = clamp(p, -1.55, 1.55); };
P.setFlying = function (on) { flying = !!on; vel.y = 0; };   // tests
// tests: the mob under the crosshair ({type, id, dist} or null; the mirror's with the simulation in a worker) and a left click's attack
P.aimedMob = () => { const h = mobHit(); return h && h.mob ? { type: h.mob.type, id: idOf(h.mob), dist: h.dist } : null; };
P.attack = () => { updateTarget(); attackCd = 0; return tryAttack(); };
P.start = beginPlay;                 // dismiss the start screen without a click (tests / embeds)
P.refreshWorlds = () => refreshWorlds();   // the title screen's world list again (tests)
P.createSandbox = scene => createSandbox(scene);   // a fresh sandbox world, its scene at spawn (#sandbox=<name>, spec idea-050)
P.isLocked = () => locked;
P.clickLog = () => clickLog.slice();   // F3 overlay: last mouse presses and what they did
P.escGrace = () => inEscGrace();   // tests: still inside the grace after an Escape closed a screen
P.frame = () => frameNo;
P.menu = () => menuOpen;
P.respawn = respawn;
P.setGameMode = setGameMode;
// commands.js hooks: an overlay that takes the keyboard (releases the pointer lock without pausing, then re-locks)
P.screenOpen = () => !!menuOpen || invOpen();   // any menu or in-game screen; main.js fades the debug panels behind it (new screens: add them to invOpen)
P.canOpenUI = () => started && !menuOpen && !P.dead && !invOpen();
P.actionBar = actionBar;
P.uiOpen = function () { if (locked) expectUnlock = true; keys.clear(); mouseL = mouseR = false; drawT = 0; resetBreak(); exitLock(); };
P.uiClose = function () { screenClosed(); if (!dragMode && !isTouch && started && !menuOpen && !P.dead && !locked) requestLock(); };
// alerts (js/alerts.js): free the mouse like Z, and take it back (from a key press or click, which browsers require)
P.freeMouse = function () { if (locked) { releaseMouse(); return true; } return false; };
P.relock = function () { if (!dragMode && !isTouch && started && !menuOpen && !P.dead && !invOpen() && !locked) requestLock(); };
P.teleport = function (x, y, z) {
  dismount(true);
  pos.set(x, y, z); vel.x = vel.y = vel.z = 0; fallStart = null; resetBreak();
  if (!BF.world.isLoaded(x, z)) waitingForChunk = true;   // hold still until the destination chunk exists
  if (y < BF.MIN_Y + 5) waitingForChunk = true;           // in the bedrock floor: lifted to the surface if stuck (bedrock can't be dug out)
  syncCamera(0.016);
};
P.kill = function () { if (P.dead || !started) return; lastCause = "killed"; die(); };
P.feed = function () { if (P.dead) return; P.hunger = P.maxHunger; saturation = 5; exhaustion = 0; starveT = 0; };
P.spawnParticles = (x, y, z, id, n) => spawnParticles(x, y, z, id, n);
P.mount = mount;                     // js/boats.js: get in a boat (right click, or a save made in one)
P.dismount = () => dismount();       // get off (Shift); also when the boat breaks
P.ride = function (fwd, turn, dt, jump) {  // tests: one real-time step of what the player rides with this input; false when riding nothing
  if (!vehicle) return false;
  rideStep(dt, { fwd, turn, strafe: -turn, jump: !!jump, yaw });
  crossEdge();   // as the real frame does after physics (a face edge on the planet)
  return true;
};
// the food meter's hidden part (r15-43): with the simulation off the page, eating runs there and the page's body drains it, so it
// crosses the protocol both ways (js/protocol.js playerIn / flushSelf, js/simhost.js)
Object.defineProperty(P, "saturation", { get: () => saturation, set: v => { if (typeof v === "number" && isFinite(v)) saturation = v; } });
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
  let sp = BF.spawnPoint || { x: pos.x, z: pos.z };
  if (!inWorld(sp.x, sp.z)) BF.spawnPoint = sp = worldSpawn();
  if (o.dead || num(o.health, 20) <= 0 || !isFinite(o.x) || !isFinite(o.y) || !isFinite(o.z) || !inWorld(o.x, o.z)) {
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
  hurtCd = 2; hurtAmt = Infinity;
  if (menuOpen === "death") { showScreen(null); BF.state.paused = false; }
  hudKey = "";
  syncCamera(0.016);
};
P.viewModel = function () { // test hook: what the held view model is ("hand", "cube" or "sprite") and a cube's top-face vertex colour
  if (!vmMesh) return null;
  if (vmMesh === hand) return { kind: "hand" };
  const g = vmMesh.geometry, col = g.attributes.color;
  if (g.userData.cube) return { kind: "cube", top: col ? [col.getX(8), col.getY(8), col.getZ(8)] : null, faces: g.index.count / 6 };
  return vmMesh.userData.bowStage != null ? { kind: "sprite", bow: vmMesh.userData.bowStage } : { kind: "sprite" };   // bow: drawn stage 0..2, -1 resting
};
// Bow (tests, debug): drawing seconds, the power it would fire at, the view-model stage; power(t) / damage(f) as used on release.
P.bow = { get drawing() { return drawT; }, get pull() { return drawT > 0 ? bowPower(drawT) : 0; }, get stage() { return bowStage(); }, power: bowPower, damage: bowDamage, DRAW: BOW_DRAW };
P.setMouse = function (left, right) { // test hook: simulate held mouse buttons
  if (left && !mouseL) { mouseL = true; primaryDown(); } else if (!left) { mouseL = false; resetBreak(); }
  if (right && !mouseR) { mouseR = true; placeCd = 0; secondaryDown(); } else if (!right) { mouseR = false; eatT = 0; }
};

P.update = function (dt) {
  frameNo++;
  if (hurtCd > 0) hurtCd -= dt;
  if (attackCd > 0) attackCd -= dt;

  // coming down through the chunk ceiling (js/world.js) onto chunks not loaded yet, which read as solid again: hold still until they are
  if (wasHigh && !BF.world.high && !BF.world.isLoaded(pos.x, pos.z)) waitingForChunk = true;
  wasHigh = BF.world.high;
  // spawn: wait until the ground under the player is loaded, then lift out of terrain if needed
  if (waitingForChunk) {
    const W = BF.world;
    // (above the chunk ceiling no chunks load, and there is nothing to wait for: js/world.js)
    if (W.high || W.isLoaded(pos.x, pos.z) && W.isLoaded(pos.x + 1, pos.z + 1) && W.isLoaded(pos.x - 1, pos.z - 1) &&
        W.isLoaded(pos.x + 1, pos.z - 1) && W.isLoaded(pos.x - 1, pos.z + 1)) {
      waitingForChunk = false;
      const bed = !vehicle && bedRespawn && W.boxCollides(pos.x, pos.y, pos.z, HW, HEIGHT) && bedStandSpot(bedRespawn);
      bedRespawn = null;
      if (bed) pos.set(bed[0], bed[1], bed[2]);
      else if (pos.y < BF.MIN_Y || (!vehicle && W.boxCollides(pos.x, pos.y, pos.z, HW, HEIGHT))) pos.y = Math.max(pos.y, W.heightAt(pos.x, pos.z) + 1.01);   // in a boat the boat holds the player
      fallStart = null; vel.y = 0;
      if (faceOpen) { faceOpen = false; faceOpenDirection(); }
    } else { syncCamera(dt); updateViewModel(dt); updateOverlays(dt); return; }
  }

  let moved = 0;
  if (!P.dead) {
    if (isTouch) touchUpdate();
    if (invOpen() && keys.size) keys.clear();
    const h3 = roundHeading();
    moved = physics(dt);
    crossEdge();
    syncMirrorRide();
    keepHeading(h3);
    updateOffPlanet();
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
  frameNo++;
  if (hurtCd > 0) hurtCd -= dt;
  syncCamera(dt);
  updateParticles(dt);
  updateViewModel(dt);
  updateOverlays(dt);
};
})();
