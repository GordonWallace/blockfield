// Claude villager (experimental, branch exp-llm-villager): one villager beside the world spawn that talks through Claude.
// Right-clicking it opens the trade screen (no offers) with a side panel: Chat, and a House designer where it draws a blueprint from a
// description. Chat messages go to the game server's /claude/chat and designs to /claude/blueprint (debug/claude.js), which holds the
// API key and calls the Claude API; the page never sees the key. js/housedesign.js turns a drawing into a builder blueprint, draws it
// and lists its materials. The villager only appears when the server says a key is set (GET /claude/status), so CI, the published
// Artifact and a checkout without a key play as before; ?claude=0 turns it off.
// It isn't part of any village and isn't saved: it is spawned again whenever the player comes near its spot, and the conversation
// and designs last for the session (newWorld clears them). Its instructions: prompts/villager-system.md, prompts/house-designer.md.
// It carries a few random odds and ends (POOL). The prompt tells it what it started with and where it is (BF.claudeSight.where).
// Its tools (defined in debug/claude.js) are answered here, live, when the model calls them: the server hands the call back
// ({ pending }) and the page posts the answer. check_inventory reads its bag; look_around reads what it can see (js/claudesight.js).
// Nothing assumes the world is paused, so the same loop serves the Sage acting on its own later.
// Game log (kind "claude"): INFO when it appears, each exchange (lengths and tokens, not the words), each tool call and design;
// WARN for a design with problems left; ERROR when a reply or a design fails.
// API: BF.claudeVillager = { isOpen(), open(mob) -> bool, close(), isChatting(mob), design(), designs(), tab(name?), home(), mob(), status(),
//                            history(), inventory(), startingInventory(), tools() -> [names], runTool(name, mob?, input?) -> text,
//                            errand() -> the walk under way or null, events() -> world events waiting to be told }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const NAME = "Sage";
const PROFESSION = "unemployed";  // no trade: the plain robe of a villager without a jobsite (and none of the job AI, js/mobs.js claudeAI)
const NEAR = 64;                  // spawn it when the player is this close to its spot
const OFFSET = [3, 2];            // its spot: this many blocks from the world spawn (x, z)
const MAX_TURNS = 40;             // history sent with each message (the server caps it too)
// Its starting inventory: a few of these, like any villager's few odds and ends. [item, min, max]
const POOL = [["bread", 1, 4], ["apple", 1, 5], ["carrot", 2, 6], ["potato", 2, 6], ["wheat_seeds", 3, 12], ["emerald", 1, 6], ["book", 1, 2],
  ["paper", 2, 8], ["stick", 2, 10], ["torch", 2, 8], ["coal", 1, 6], ["flint", 1, 3], ["string", 1, 4], ["feather", 1, 5], ["white_wool", 1, 3],
  ["iron_ingot", 1, 2], ["cooked_cod", 1, 3], ["sugar_cane", 2, 6], ["compass", 1, 1], ["glass_bottle", 1, 3]];

const off = /[?&]claude=0\b/.test(location.search);
let status = null, mob = null, home = null, deadAt = 0, history = [], busy = false, announced = false, start = null;
const glog = (level, text, at) => { try { if (BF.glog) BF.glog.log(level, "claude", text, at ? { at } : undefined); } catch (e) { /* ignore */ } };

if (!off && typeof fetch === "function") {
  fetch("/claude/status", { cache: "no-store" }).then(r => (r.ok ? r.json() : null)).then(s => {
    status = s;
    if (s && !s.configured) console.info("[claude] villager chat is off: " + (s.error || "no API key") + " (see debug/claude.js)");
    if (s && s.configured && !s.sdk) console.warn("[claude] " + s.error);
  }).catch(() => { status = null; });   // not served by debug/server.js
}

// ---------------------------------------------------------------- the villager
function spot() {
  const w = BF.worldSpawn;
  if (!w || !BF.world || !BF.world.canonXZ) return null;
  const x = Math.floor(w.x) + OFFSET[0], z = Math.floor(w.z) + OFFSET[1];
  return BF.world.canonXZ(x + 0.5, z + 0.5) ? { x: x + 0.5, z: z + 0.5 } : null;
}
function tick() {
  if (!status || !status.configured || !BF.mobs || !BF.player || !BF.player.position || !BF.world) return;
  if (mob && (mob.removed || mob.dead)) { if (mob.dead) deadAt = performance.now(); if (isOpen()) close(); mob = null; }
  if (mob) return;
  if (performance.now() - deadAt < 30000) return;   // killed: back after a while
  home = spot();
  if (!home || !BF.world.isLoaded(home.x, home.z)) return;
  const p = BF.player.position;
  if (Math.hypot(p.x - home.x, p.z - home.z) > NEAR) return;
  const h = BF.world.heightAt(home.x, home.z);
  if (!(h > -1e6)) return;
  const m = BF.mobs.spawn("villager", home.x, h + 1.01, home.z, PROFESSION);
  if (!m) return;
  m.claude = true; m.claudeHome = home; m.vname = NAME; m.claudeTitle = "Wanderer"; m.trades = [];
  // the same inventory all session: a Sage that despawns and comes back keeps what it had
  if (!start) start = startingStock();
  m.inv = start.slots;
  mob = m;
  if (!announced) { announced = true; glog("INFO", NAME + " (the Claude villager) appeared at the world spawn carrying " + (listText(contents(m.inv)) || "nothing"), m); }
}
setInterval(() => { try { tick(); errandTick(); drainEvents(); } catch (e) { console.error(e); } }, 1000);
if (typeof BF.on === "function") hook(); else addEventListener("load", hook);
function hook() {
  if (BF.on) BF.on("newWorld", () => {
    if (isOpen()) close();
    mob = null; history = []; events.length = 0; announced = false; deadAt = 0; start = null; current = null; designs.length = 0;
    if (ui.dout) ui.dout.classList.remove("on");
  });
}

function startingStock() {
  const T = BF.trades, I = BF.I || {}, slots = T && T.inv ? T.inv.create() : [];
  const pool = POOL.filter(p => I[p[0]] != null), n = Math.min(pool.length, 3 + Math.floor(Math.random() * 4));   // 3-6 kinds of thing
  for (let k = 0; k < n; k++) {
    const [name, a, b] = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const c = a + Math.floor(Math.random() * (b - a + 1));
    if (T && T.inv) T.inv.add(slots, I[name], c); else slots.push({ id: I[name], count: c });
  }
  return { slots, list: contents(slots) };
}
// [{item, count}] with each kind once, in slot order
function contents(slots) {
  const out = [], at = new Map();
  for (const s of slots || []) {
    if (!s || !(s.count > 0)) continue;
    const name = BF.itemName ? BF.itemName(s.id) : String(s.id);
    if (at.has(name)) out[at.get(name)].count += s.count; else { at.set(name, out.length); out.push({ item: name, count: s.count }); }
  }
  return out;
}
const listText = l => l.map(e => e.count + " " + e.item).join(", ");

function worldLine() {
  const parts = [];
  try {
    const t = BF.sky ? BF.sky.time || 0 : 0, hr = ((t * 24 + 6) % 24 + 24) % 24;
    const part = hr < 5 ? "the middle of the night" : hr < 8 ? "early morning" : hr < 12 ? "morning" : hr < 17 ? "afternoon" : hr < 20 ? "evening" : "night";
    parts.push("day " + ((BF.sky ? BF.sky.day || 0 : 0) + 1) + ", " + part + " (" + String(Math.floor(hr)).padStart(2, "0") + ":" + String(Math.floor((hr % 1) * 60)).padStart(2, "0") + ")");
    if (BF.weather && BF.weather.type && BF.weather.type !== "clear") parts.push(BF.weather.type + (BF.weather.thunder > 0 ? " with thunder" : ""));
    else parts.push("clear skies");
    if (BF.player && BF.player.gameMode) parts.push("the traveller is in " + BF.player.gameMode + " mode");
  } catch (e) { /* best effort */ }
  return parts.join("; ") + ".";
}

// ---------------------------------------------------------------- side panel (beside the trade screen)
// The trade screen (js/inventory.js) owns pausing, the mouse and closing; the panel sits inside its backdrop, to its right, and goes
// when it goes.
const ui = { root: null };
function css() {
  const st = document.createElement("style");
  st.textContent = `
.bfcv-panel{position:fixed;background:rgba(18,22,20,.93);border:1px solid var(--panel-edge);border-radius:4px;padding:10px 12px;display:none;flex-direction:column;gap:8px;
  box-shadow:0 10px 40px rgba(0,0,0,.5);user-select:text;-webkit-user-select:text;z-index:21;box-sizing:border-box}
.bfcv-panel.open{display:flex}
.bfcv-tabs{display:flex;gap:4px;align-items:center}
.bfcv-tabs button{font:12px var(--display);color:var(--muted);background:transparent;border:1px solid var(--panel-edge);border-radius:3px;padding:5px 10px;cursor:pointer}
.bfcv-tabs button.on{color:var(--ink);border-color:var(--accent);background:rgba(127,191,77,.18)}
.bfcv-tabs span{margin-left:auto;font:11px var(--mono);color:var(--muted)}
.bfcv-page{display:none;flex-direction:column;gap:8px;flex:1;min-height:0}
.bfcv-page.on{display:flex}
.bfcv-log{flex:1;min-height:80px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;font:13px/1.45 var(--mono);color:var(--ink);padding-right:4px}
.bfcv-log .me{align-self:flex-end;background:rgba(127,191,77,.18);border-radius:3px;padding:4px 8px;max-width:85%;white-space:pre-wrap}
.bfcv-log .them{align-self:flex-start;max-width:92%;white-space:pre-wrap}
.bfcv-log .them b{color:var(--accent);font-weight:normal}
.bfcv-log .sys,.bfcv-dstat{color:var(--muted);font-size:12px;font-style:italic;align-self:center}
.bfcv-log .sys{align-self:auto}
.bfcv-log .err,.bfcv-dstat.err{color:var(--danger,#e06c5a);font-size:12px;font-style:normal}
.bfcv-row{display:flex;gap:8px}
.bfcv-panel textarea{flex:1;resize:none;height:38px;font:13px var(--mono);color:var(--ink);background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px;padding:8px}
.bfcv-panel .bfcv-dreq{flex:0 0 auto;height:58px}
.bfcv-row button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:6px 12px;cursor:pointer}
.bfcv-row button:disabled{opacity:.45;cursor:default}
.bfcv-note{font:11px var(--mono);color:var(--muted)}
.bfcv-dout{display:none;flex-direction:column;gap:6px;flex:1;min-height:0;overflow-y:auto}
.bfcv-dout.on{display:flex}
.bfcv-dname{font:13px var(--display);color:var(--accent)}
.bfcv-dname small{font:11px var(--mono);color:var(--muted);margin-left:6px}
.bfcv-dsum{font:12px/1.45 var(--mono);color:var(--ink);white-space:pre-wrap}
.bfcv-stage{display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
.bfcv-view{position:relative;height:clamp(260px,44vh,440px);background:radial-gradient(#2a3a30,#141a16);border-radius:3px}
.bfcv-big{position:absolute;top:6px;right:6px;font:11px var(--display);color:var(--ink);background:rgba(0,0,0,.45);border:1px solid var(--panel-edge);border-radius:3px;padding:4px 8px;cursor:pointer}
.bfcv-stage.big{position:fixed;inset:4vh 4vw;z-index:30;background:rgba(18,22,20,.97);border:1px solid var(--panel-edge);border-radius:4px;padding:10px 12px;box-shadow:0 10px 60px rgba(0,0,0,.7)}
.bfcv-stage.big .bfcv-view{flex:1;height:auto;min-height:0}
.bfcv-view canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}
.bfcv-cut{display:flex;align-items:center;gap:8px;font:11px var(--mono);color:var(--muted)}
.bfcv-cut input{flex:1}
.bfcv-mats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px 10px;font:12px var(--mono);color:var(--ink)}
.bfcv-mats div{display:flex;align-items:center;gap:6px}
.bfcv-mats img{width:18px;height:18px;image-rendering:pixelated}
.bfcv-mats b{color:var(--accent);font-weight:normal;min-width:2.2em;text-align:right}`;
  document.head.appendChild(st);
}
function el(tag, cls, parent, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; }
function build() {
  if (ui.root) return;
  css();
  const r = el("div", "bfcv-panel");
  r.setAttribute("role", "dialog"); r.setAttribute("aria-label", NAME);
  const tabs = el("div", "bfcv-tabs", r);
  ui.tabBtn = { chat: el("button", "on", tabs, "Chat"), design: el("button", "", tabs, "House designer") };
  for (const k in ui.tabBtn) { ui.tabBtn[k].type = "button"; ui.tabBtn[k].addEventListener("click", () => setTab(k)); }
  ui.model = el("span", "", tabs);
  // chat
  const pc = ui.pageChat = el("div", "bfcv-page on", r);
  ui.log = el("div", "bfcv-log", pc);
  const row = el("div", "bfcv-row", pc);
  ui.ta = el("textarea", "", row); ui.ta.maxLength = 2000; ui.ta.placeholder = "Say something..."; ui.ta.setAttribute("aria-label", "Message");
  ui.send = el("button", "", row, "Send"); ui.send.type = "button";
  ui.send.addEventListener("click", () => send());
  el("div", "bfcv-note", pc, "Enter sends, Shift+Enter for a new line. Talks through Claude (Haiku 5.5) with your API key.");
  // house designer
  const pd = ui.pageDesign = el("div", "bfcv-page", r);
  ui.dreq = el("textarea", "bfcv-dreq", pd); ui.dreq.maxLength = 2000;
  ui.dreq.placeholder = "Describe a house, e.g. stone with a wood roof, two stories, two beds, furnace on the ground floor";
  ui.dreq.setAttribute("aria-label", "House description");
  const drow = el("div", "bfcv-row", pd);
  ui.dgo = el("button", "", drow, "Design"); ui.dgo.type = "button"; ui.dgo.title = "A new blueprint from this description";
  ui.drev = el("button", "", drow, "Revise"); ui.drev.type = "button"; ui.drev.title = "Change the blueprint below as described"; ui.drev.disabled = true;
  ui.dstat = el("div", "bfcv-dstat", drow);
  ui.dgo.addEventListener("click", () => design(false));
  ui.drev.addEventListener("click", () => design(true));
  const out = ui.dout = el("div", "bfcv-dout", pd);
  ui.dname = el("div", "bfcv-dname", out);
  ui.stage = el("div", "bfcv-stage", out);
  ui.view = el("div", "bfcv-view", ui.stage);
  ui.canvas = el("canvas", "", ui.view);
  ui.big = el("button", "bfcv-big", ui.view, "Enlarge"); ui.big.type = "button"; ui.big.title = "Show the blueprint across the screen (Esc goes back)";
  ui.big.addEventListener("click", () => enlarge(!ui.stage.classList.contains("big")));
  const cut = el("label", "bfcv-cut", ui.stage);
  el("span", "", cut, "Layers");
  ui.cut = el("input", "", cut); ui.cut.type = "range"; ui.cut.min = 1;
  ui.cutText = el("span", "", cut);
  ui.cut.addEventListener("input", () => { ui.cutText.textContent = ui.cut.value + " / " + ui.cut.max; if (ui.preview) ui.preview.cut(+ui.cut.value); });
  ui.dsum = el("div", "bfcv-dsum", out);
  el("div", "bfcv-note", out, "Materials");
  ui.mats = el("div", "bfcv-mats", out);
  el("div", "bfcv-note", out, "Drag to turn, scroll to zoom, slide Layers to look inside. Builders can't build these yet.");
  // the trade screen's backdrop handles pointer events (dropping a held stack and so on); the panel keeps its own
  for (const ev of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"]) r.addEventListener(ev, e => e.stopPropagation());
  ui.root = r;
  addEventListener("resize", () => { if (chatting) place(); });
}
function setTab(k) {
  tab = k;
  for (const t in ui.tabBtn) ui.tabBtn[t].classList.toggle("on", t === k);
  ui.pageChat.classList.toggle("on", k === "chat"); ui.pageDesign.classList.toggle("on", k === "design");
  (k === "chat" ? ui.ta : ui.dreq).focus();
  if (k === "design" && ui.preview && current) ui.preview.draw();
}
function line(cls, text, who) {
  const d = document.createElement("div");
  d.className = cls;
  if (who) { const b = document.createElement("b"); b.textContent = who + ": "; d.appendChild(b); }
  d.appendChild(document.createTextNode(text));
  ui.log.appendChild(d);
  ui.log.scrollTop = ui.log.scrollHeight;
  return d;
}
function redraw() {
  ui.log.textContent = "";
  if (!history.length) line("sys", NAME + " looks up and smiles.");
  for (const m of history) m.event ? line("sys", m.content.replace(/^\(World event[^)]*\) /, "")) : m.role === "user" ? line("me", m.content) : line("them", m.content, NAME);
}

// The 3D view across most of the screen, with its layer slider, or back in the panel.
addEventListener("resize", () => { if (chatting && ui.preview && current) ui.preview.draw(); });
function enlarge(on) {
  if (!ui.stage) return;
  ui.stage.classList.toggle("big", on);
  ui.big.textContent = on ? "Shrink" : "Enlarge";
  if (ui.preview) ui.preview.draw();
}

// Sits to the right of the trade screen; the pair is centred together (the trade screen moves left to make room).
function place() {
  const inv = document.querySelector(".bf-inv-back .bf-inv");
  if (!inv || !ui.root) return;
  inv.style.left = "";
  const ib = inv.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, gap = 12;
  const pw = Math.max(320, Math.min(540, vw - ib.width - gap - 24)), ph = Math.min(vh - 24, Math.max(ib.height, 560));
  const total = ib.width + gap + pw;
  if (total <= vw - 16) {
    const left = (vw - total) / 2;
    inv.style.left = (left + ib.width / 2) + "px";   // .bf-inv is centred with translate(-50%, -50%)
    Object.assign(ui.root.style, { left: (left + ib.width + gap) + "px", top: Math.max(12, (vh - ph) / 2) + "px", width: pw + "px", height: ph + "px" });
  } else {   // too narrow for both side by side: over the right edge
    Object.assign(ui.root.style, { left: Math.max(8, vw - pw - 8) + "px", top: "12px", width: Math.min(pw, vw - 16) + "px", height: (vh - 24) + "px" });
  }
}

let chatting = null, tab = "chat", poll = 0;
function isOpen() { return !!chatting; }
// Called by BF.mobs.interact once the trade screen has opened for the Sage.
function open(m) {
  if (!m || !m.claude) return false;
  build();
  const back = document.querySelector(".bf-inv-back");
  if (back && ui.root.parentNode !== back) back.appendChild(ui.root);   // shown, hidden and stacked with the trade screen
  else if (!back && !ui.root.parentNode) (document.getElementById("ui") || document.body).appendChild(ui.root);
  chatting = m;
  ui.model.textContent = status && status.sdk ? status.model || "" : "not ready";
  ui.root.classList.add("open");
  redraw();
  if (status && status.configured && !status.sdk) line("err", status.error || "The Claude SDK isn't installed on the server");
  setBusy(busy);
  place();
  setTab(tab);
  clearInterval(poll);
  let lastW = 0;
  poll = setInterval(() => {
    if (!chatting) return;
    if (!(BF.inventory && BF.inventory.isOpen())) { close(); return; }   // the trade screen closed (Esc, E, death...)
    const inv = document.querySelector(".bf-inv-back .bf-inv"), w = inv ? inv.offsetWidth : 0;
    if (w !== lastW) { lastW = w; place(); }   // its header fills in after it opens and can widen it
  }, 150);
  return true;
}
function close() {
  if (!chatting) return;
  chatting = null;
  clearInterval(poll);
  enlarge(false);
  ui.root.classList.remove("open");
  if (document.activeElement && ui.root.contains(document.activeElement)) document.activeElement.blur();
  const inv = document.querySelector(".bf-inv-back .bf-inv"); if (inv) inv.style.left = "";
  if (BF.inventory && BF.inventory.isOpen()) BF.inventory.close();
}
function setBusy(b) { busy = b; if (ui.send) { ui.send.disabled = b; ui.send.textContent = b ? "..." : "Send"; } }

// ---------------------------------------------------------------- chat
// The model's tools, answered from the world as it is now. Each returns the text the model reads.
const TOOLS = {
  check_inventory(who) {
    const now = listText(contents(who.inv));
    glog("INFO", NAME + " checked its inventory (" + (now || "empty") + ")", who);
    return now ? "You are carrying: " + now + "." : "Your bag is empty.";
  },
  move_to(who, input) { return startErrand(who, input || {}); },
  look_around(who) {
    const o = BF.claudeSight.look(who);
    const kinds = Object.values(o.groups).reduce((n, g) => n + g.size, 0);
    glog("INFO", NAME + " looked around: " + o.mobs.length + " creatures and people, " + o.houses.length + " houses, " + kinds + " kinds of thing seen within " + o.range + " blocks (" + o.rays + " rays, " + o.ms + " ms)", who);
    return o.text;
  },
};
// ---------------------------------------------------------------- errands (move_to)
// The model sends the Sage somewhere: to the traveller, back home, to the nearest village, or some blocks off in a compass direction.
// js/mobs.js (claudeErrand) walks it there on villager routes; the tool returns at once ("you set off"), and when the walk ends the
// game tells the Sage in a new turn of its own (a world event), so it can look around and report. Its reply shows in the panel and,
// with the panel closed, in the game's chat. Where it arrives becomes the spot it wanders around.
const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const ERRAND_MAX = 100;   // blocks it will go in one errand
const events = [];        // world events waiting to be told to the Sage: [text]
let errandNote = false;   // an errand started during this exchange (the panel says it will set off once the screen closes)
const localOf = (who, p) => (BF.planet && BF.planet.local ? BF.planet.local(who.position, p, {}) : { x: p.x, z: p.z });
function compassFrom(who, p) {
  const P = BF.planet, t = P && P.toward ? P.toward(who.position, p, {}) : { x: p.x - who.position.x, z: p.z - who.position.z, d: Math.hypot(p.x - who.position.x, p.z - who.position.z) };
  const b = P && P.bearing ? P.bearing(who.position.x, who.position.z, t.x, t.z) : null;
  return { d: Math.round(t.d), dir: b == null ? "" : P.compassPoint(b) };
}
function startErrand(who, input) {
  const t = String(input.target || ""), W = BF.world;
  if (t === "stop") { const was = !!who.claudeErrand; who.claudeErrand = null; who.ai.route = null; who.claudeHome = { x: who.position.x, z: who.position.z }; return was ? "You stop where you are." : "You weren't going anywhere."; }
  let goal = null, label = "";
  if (t === "traveller") {
    if (!BF.player || !BF.player.position || BF.player.dead) return "You can't find the traveller.";
    goal = () => { const p = localOf(who, BF.player.position); return { x: Math.floor(p.x), z: Math.floor(p.z), r: 3 }; };
    label = "the traveller";
  } else if (t === "home") {
    if (!home) return "You don't know where home is.";
    const h = localOf(who, home); goal = () => ({ x: Math.floor(h.x), z: Math.floor(h.z), r: 2 }); label = "your usual spot by the world spawn";
  } else if (t === "village") {
    const v = BF.worldgen && BF.worldgen.nearestVillage && BF.worldgen.nearestVillage(who.position.x, who.position.z);
    if (!v) return "You don't know of any village near enough.";
    const c = localOf(who, v), d = Math.hypot(c.x - who.position.x, c.z - who.position.z);
    if (d > ERRAND_MAX) return "The nearest village is about " + Math.round(d / 10) * 10 + " blocks away, too far to walk to and back now (" + ERRAND_MAX + " blocks at most).";
    let name = null; try { name = BF.signs.villageName(v); } catch (e) { /* unnamed */ }
    goal = () => ({ x: Math.floor(c.x), z: Math.floor(c.z), r: 4 }); label = name ? "the village of " + name : "the nearest village";
  } else if (t === "direction") {
    const k = POINTS.indexOf(String(input.direction || "").toLowerCase());
    if (k < 0) return "Say which way: one of " + POINTS.join(", ") + ".";
    let dist = Math.round(+input.distance || 0);
    if (!(dist >= 3)) return "Say how far, in blocks (3 to " + ERRAND_MAX + ").";
    dist = Math.min(ERRAND_MAX, dist);
    const yaw = BF.coords && BF.coords.yawFor ? BF.coords.yawFor(k * 45, who.position.x, who.position.z, 0) : -k * Math.PI / 4;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let x = who.position.x + fx * dist, z = who.position.z + fz * dist;
    while (dist > 3 && !W.isLoaded(x, z)) { dist -= 4; x = who.position.x + fx * dist; z = who.position.z + fz * dist; }   // only as far as the known land
    const gx = Math.floor(x), gz = Math.floor(z);
    goal = () => ({ x: gx, z: gz, r: 2 }); label = "a spot about " + dist + " blocks " + POINTS[k];
  } else return "Unknown target: use traveller, home, village, direction (with direction and distance) or stop.";
  const g = goal(), d = Math.round(Math.hypot(g.x + 0.5 - who.position.x, g.z + 0.5 - who.position.z));
  if (d <= (g.r || 2)) return "You are already there.";
  who.claudeErrand = { goal, label, max: 60 + d * 3, from: { x: who.position.x, z: who.position.z }, t0: BF.simNow ? BF.simNow() : 0, why: String(input.reason || "").slice(0, 200) };
  who.ai.route = null;
  errandNote = true;
  glog("INFO", NAME + " set off for " + label + " (about " + d + " blocks)" + (who.claudeErrand.why ? ": " + who.claudeErrand.why : ""), who);
  return "You set off for " + label + ", about " + d + " blocks away. You'll be told when you get there (or if you can't), and can look around then.";
}
// Once a second: an errand that ended becomes a world event for the Sage.
function errandTick() {
  const m = mob, e = m && m.claudeErrand;
  if (!e || !e.result) return;
  m.claudeErrand = null;
  m.claudeHome = { x: m.position.x, z: m.position.z };   // it stays around where it ended up
  const secs = Math.round(e.t || 0), rel = BF.player && BF.player.position ? compassFrom(m, BF.player.position) : null;
  const where = rel ? " The traveller is about " + rel.d + " blocks " + (rel.dir || "away") + " of you." : "";
  if (e.result === "arrived") {
    glog("INFO", NAME + " arrived at " + e.label + " after " + secs + " s", m);
    events.push("You have arrived at " + e.label + "." + where);
  } else {
    const moved = Math.round(Math.hypot(m.position.x - e.from.x, m.position.z - e.from.z));
    glog("WARN", NAME + " didn't reach " + e.label + " (" + e.result.replace(/^failed: /, "") + ") after " + secs + " s, " + moved + " blocks from where it set off", m);
    events.push("You didn't make it to " + e.label + ": you " + e.result.replace(/^failed: /, "") + ". You stopped " + moved + " blocks from where you set off." + where);
  }
}
async function drainEvents() {
  if (!events.length || busy || !mob || !status || !status.configured) return;
  const text = events.shift();
  await turn(mob, { role: "user", content: "(World event, not the traveller speaking) " + text, event: true }, text);
}

async function post(body) {
  const r = await fetch("/claude/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out || out.error) throw new Error((out && out.error) || "server answered " + r.status);
  return out;
}
// One player message to a reply: the first request, then one more per round of tool calls the model makes.
async function converse(who, messages) {
  let out = await post({ villager: { name: NAME, world: worldLine(), surroundings: surroundings(who), start: start ? start.list : [] }, messages });
  for (let i = 0; out.pending && i < 8; i++) {
    const results = out.pending.calls.map(c => {
      const f = TOOLS[c.name];
      if (!f) return { id: c.id, content: "Unknown tool", is_error: true };
      try { return { id: c.id, content: String(f(who, c.input || {})) }; }
      catch (e) { console.error(e); return { id: c.id, content: "Couldn't do that just now (" + (e && e.message) + ")", is_error: true }; }
    });
    out = await post({ turn: out.pending.turn, results });
  }
  if (out.pending) throw new Error("too many tool calls");
  return out;
}
function surroundings(who) { try { return BF.claudeSight ? BF.claudeSight.where(who) : ""; } catch (e) { return ""; } }

async function send() {
  const text = ui.ta.value.trim();
  if (!text || busy || !chatting) return;
  ui.ta.value = "";
  await turn(chatting, { role: "user", content: text.slice(0, 2000) }, text);
}
// One exchange: msg (the player's words, or a world event) goes on the history, and the reply comes back through converse().
async function turn(who, msg, shown) {
  build();
  history.push(msg);
  line(msg.event ? "sys" : "me", shown);
  const wait = line("sys", NAME + " is thinking...");
  setBusy(true);
  errandNote = false;
  const t0 = performance.now(), text = msg.content;
  let out = null, err = null;
  try { out = await converse(who, history.slice(-MAX_TURNS)); }
  catch (e) { err = e instanceof TypeError ? "couldn't reach the game server (is it still running?)" : e.message; }
  wait.remove();
  setBusy(false);
  const ms = Math.round(performance.now() - t0);
  if (err) {
    history.pop();   // the message didn't land: keep the conversation well formed, put the words back to retry
    if (!msg.event && !ui.ta.value) ui.ta.value = text;
    line("err", "No answer: " + err);
    glog("ERROR", "Claude villager chat failed after " + ms + " ms: " + err, who);
    return;
  }
  let reply = out.reply || "";
  if (out.stop === "refusal" || !reply) {
    history.pop();
    line("sys", NAME + " shakes their head and won't answer that.");
    glog("INFO", "Claude villager declined to answer (" + (out.stop || "empty reply") + ", " + ms + " ms)", who);
    return;
  }
  if (out.stop === "max_tokens") reply += " ...";
  history.push({ role: "assistant", content: reply });
  if (history.length > 200) history.splice(0, history.length - 200);
  line("them", reply, NAME);
  if (!chatting && BF.commands && BF.commands.print) BF.commands.print("<" + NAME + "> " + reply, "gold");   // heard from afar: the game's chat
  if (errandNote && chatting) line("sys", "(" + NAME + " will set off once you close this screen.)");
  const u = out.usage || {};
  glog("INFO", (msg.event ? "World event told to " + NAME + ": " : "Chat with " + NAME + ": ") + text.length + " characters in, " + reply.length + " out, " + (u.input || 0) + "/" + (u.output || 0) + " tokens, " + ms + " ms" + (out.tools && out.tools.length ? ", tools: " + out.tools.join(", ") : ""), who);
}

// ---------------------------------------------------------------- house designer
let current = null, designing = false;     // current: { design, bp, materials, warnings, request }
const designs = [];                         // this session's, newest last
function setDesigning(b) {
  designing = b;
  if (!ui.dgo) return;
  ui.dgo.disabled = b; ui.drev.disabled = b || !current;
  ui.dgo.textContent = b ? "..." : "Design";
}
async function design(revise) {
  const text = ui.dreq.value.trim();
  if (!text || designing || !chatting) return;
  if (revise && !current) revise = false;
  setDesigning(true);
  ui.dstat.className = "bfcv-dstat"; ui.dstat.textContent = NAME + " is drawing" + (revise ? " the changes" : "") + "...";
  const t0 = performance.now(), who = chatting;
  let out = null, err = null;
  try {
    const r = await fetch("/claude/blueprint", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ villager: { name: NAME }, request: text, palette: BF.houseDesign.palette(), previous: revise ? current.design : undefined }) });
    out = await r.json().catch(() => null);
    if (!r.ok || !out || out.error) err = (out && out.error) || "server answered " + r.status;
  } catch (e) { err = "couldn't reach the game server (is it still running?)"; }
  setDesigning(false);
  const ms = Math.round(performance.now() - t0), u = (out && out.usage) || {};
  if (!err && out.refused) err = NAME + " won't draw that";
  let res = null;
  if (!err && out.design) { res = BF.houseDesign.toBlueprint(out.design); if (res.error) err = "the blueprint didn't work out: " + res.error; }
  else if (!err) err = "no blueprint came back";
  if (err) {
    ui.dstat.className = "bfcv-dstat err"; ui.dstat.textContent = "No blueprint: " + err;
    glog("ERROR", NAME + "'s house design failed after " + ms + " ms: " + err, who);
    return;
  }
  const left = out.problems || [];
  current = { design: out.design, bp: res.bp, materials: res.materials, warnings: res.warnings.concat(left), request: text };
  designs.push(current);
  showDesign();
  ui.dstat.className = "bfcv-dstat";
  ui.dstat.textContent = (out.attempts > 1 ? out.attempts + " drafts, " : "") + (ms / 1000).toFixed(1) + " s";
  const bp = res.bp;
  glog(left.length ? "WARN" : "INFO", NAME + " designed \"" + bp.label + "\" (" + bp.w + "x" + bp.d + ", " + bp.hgt + " high, " + bp.n + " blocks, " +
    bp.beds.length + " beds" + (revise ? ", a revision" : "") + "; " + out.attempts + " draft" + (out.attempts > 1 ? "s" : "") + ", " +
    (u.input || 0) + "/" + (u.output || 0) + " tokens, " + ms + " ms)" + (left.length ? "; problems left: " + left.join("; ") : ""), who);
}
function showDesign() {
  const c = current;
  if (!c || !ui.dout) return;
  ui.dout.classList.add("on");
  ui.drev.disabled = designing;
  const bp = c.bp;
  ui.dname.textContent = bp.label;
  el("small", "", ui.dname, bp.w + " x " + bp.d + ", " + bp.hgt + " high, " + bp.n + " blocks, " + bp.beds.length + " bed" + (bp.beds.length === 1 ? "" : "s"));
  ui.dsum.textContent = [c.design.summary, c.design.notes].filter(Boolean).join("\n") + (c.warnings.length ? "\n(Not quite right: " + c.warnings.join("; ") + ")" : "");
  ui.mats.textContent = "";
  for (const m of c.materials) {
    const d = el("div", "", ui.mats), img = el("img", "", d);
    img.alt = ""; try { img.src = BF.textures.icon(m.id) || ""; } catch (e) { /* no icon */ }
    el("b", "", d, String(m.count)); el("span", "", d, m.name);
  }
  ui.cut.max = bp.hgt; ui.cut.value = bp.hgt; ui.cutText.textContent = bp.hgt + " / " + bp.hgt;
  try {
    if (!ui.preview) ui.preview = new BF.houseDesign.Preview(ui.canvas);
    ui.preview.show(bp);
  } catch (e) { console.error(e); }
}

// Keys typed in the panel stay in the panel (capture phase, before the trade screen's E / digits / Q): Enter sends the message or the
// house description, Esc closes the trade screen and the panel. Keys anywhere else are the trade screen's.
addEventListener("keydown", e => {
  if (chatting && e.key === "Escape" && ui.stage && ui.stage.classList.contains("big")) { e.preventDefault(); e.stopImmediatePropagation(); enlarge(false); return; }
  if (!chatting || !ui.root || !ui.root.contains(e.target)) return;
  e.stopImmediatePropagation();
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if ((e.key === "Enter" || e.key === "NumpadEnter") && !e.shiftKey) {
    if (e.target === ui.ta) { e.preventDefault(); send(); }
    else if (e.target === ui.dreq) { e.preventDefault(); design(!!current); }
    return;
  }
  if (e.key === "Tab" || e.key === "F3" || e.key === "F1") e.preventDefault();
}, true);

BF.claudeVillager = {
  isOpen, open, close,
  isChatting: m => !!chatting && chatting === m,
  design: () => current, designs: () => designs.slice(), tab: k => (k && ui.root ? setTab(k) : tab),
  home: () => home, mob: () => mob, status: () => status, history: () => history.slice(),
  preview: () => ui.preview || null,
  inventory: () => contents(mob && mob.inv), tools: () => Object.keys(TOOLS), errand: () => (mob && mob.claudeErrand) || null, events: () => events.slice(), runTool: (name, who, input) => TOOLS[name](who || mob, input || {}), startingInventory: () => (start ? start.list.slice() : null),
};
})();
