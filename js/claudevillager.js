// Claude villager (experimental, branch exp-llm-villager): one villager beside the world spawn that talks through Claude.
// Right-clicking it opens a chat panel; each message goes to the game server's /claude/chat (debug/claude.js), which holds the
// API key and calls the Claude API. The page never sees the key. The villager only appears when the server says a key is set
// (GET /claude/status), so CI, the published Artifact and a checkout without a key play as before; ?claude=0 turns it off.
// It isn't part of any village and isn't saved: it is spawned again whenever the player comes near its spot, and the
// conversation lasts for the session (newWorld clears it). Its instructions: prompts/villager-system.md.
// Game log (kind "claude"): INFO when it appears and each exchange (lengths and tokens, not the words); ERROR when a reply fails.
// It carries a few random odds and ends (POOL). The prompt tells it what it started with; its check_inventory tool (debug/claude.js)
// reads what it holds now, which the page sends with each message.
// API: BF.claudeVillager = { isOpen(), open(mob) -> bool, close(), isChatting(mob), home(), mob(), status(), history(), inventory(), startingInventory() }
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
  m.claude = true; m.claudeHome = home; m.vname = NAME;
  // the same inventory all session: a Sage that despawns and comes back keeps what it had
  if (!start) start = startingStock();
  m.inv = start.slots;
  mob = m;
  if (!announced) { announced = true; glog("INFO", NAME + " (the Claude villager) appeared at the world spawn carrying " + (listText(contents(m.inv)) || "nothing"), m); }
}
setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, 1000);
if (typeof BF.on === "function") hook(); else addEventListener("load", hook);
function hook() { if (BF.on) BF.on("newWorld", () => { if (isOpen()) close(); mob = null; history = []; announced = false; deadAt = 0; start = null; }); }

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

// ---------------------------------------------------------------- chat panel
const ui = { root: null, log: null, ta: null, send: null, note: null };
function css() {
  const st = document.createElement("style");
  st.textContent = `
.bfcv-wrap{position:fixed;inset:0;display:none;align-items:flex-end;justify-content:center;background:rgba(8,10,9,.35);z-index:40;padding:0 16px 96px}
.bfcv-wrap.open{display:flex}
.bfcv-panel{background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:12px 14px;width:min(560px,100%);display:flex;flex-direction:column;gap:8px;user-select:text;-webkit-user-select:text}
.bfcv-title{font:13px var(--display);color:var(--accent);letter-spacing:.04em;display:flex;justify-content:space-between;align-items:baseline}
.bfcv-title span{font:11px var(--mono);color:var(--muted);letter-spacing:0}
.bfcv-log{max-height:min(46vh,380px);overflow-y:auto;display:flex;flex-direction:column;gap:6px;font:13px/1.45 var(--mono);color:var(--ink);padding-right:4px}
.bfcv-log .me{align-self:flex-end;background:rgba(127,191,77,.18);border-radius:3px;padding:4px 8px;max-width:85%;white-space:pre-wrap}
.bfcv-log .them{align-self:flex-start;max-width:92%;white-space:pre-wrap}
.bfcv-log .them b{color:var(--accent);font-weight:normal}
.bfcv-log .sys{color:var(--muted);font-size:12px;font-style:italic}
.bfcv-log .err{color:var(--danger,#e06c5a);font-size:12px}
.bfcv-row{display:flex;gap:8px}
.bfcv-row textarea{flex:1;resize:none;height:38px;font:13px var(--mono);color:var(--ink);background:rgba(0,0,0,.35);border:1px solid var(--panel-edge);border-radius:3px;padding:8px}
.bfcv-row button{font:12px var(--display);color:var(--ink);background:rgba(127,191,77,.22);border:1px solid var(--accent);border-radius:3px;padding:0 14px;cursor:pointer}
.bfcv-row button:disabled{opacity:.5;cursor:default}
.bfcv-note{font:11px var(--mono);color:var(--muted)}`;
  document.head.appendChild(st);
}
function build() {
  if (ui.root) return;
  css();
  const r = document.createElement("div");
  r.className = "bfcv-wrap";
  r.innerHTML = `<div class="bfcv-panel"><div class="bfcv-title">${NAME}<span></span></div><div class="bfcv-log"></div>
<div class="bfcv-row"><textarea maxlength="2000" spellcheck="true" placeholder="Say something..." aria-label="Message"></textarea><button type="button">Send</button></div>
<div class="bfcv-note">Enter sends, Shift+Enter for a new line, Esc to leave. Talks through Claude (Haiku 5.5) with your API key.</div></div>`;
  (document.getElementById("ui") || document.body).appendChild(r);
  ui.root = r; ui.log = r.querySelector(".bfcv-log"); ui.ta = r.querySelector("textarea"); ui.send = r.querySelector("button");
  ui.model = r.querySelector(".bfcv-title span");
  ui.send.addEventListener("click", () => send());
  r.addEventListener("mousedown", e => { if (e.target === r) { e.preventDefault(); close(); } });
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
  for (const m of history) m.role === "user" ? line("me", m.content) : line("them", m.content, NAME);
}

let chatting = null, wasPaused = false;
function isOpen() { return !!chatting; }
function open(m) {
  if (!m || !m.claude) return false;
  const P = BF.player;
  if (P && P.canOpenUI && !P.canOpenUI()) return false;
  build();
  chatting = m;
  m.lookAt = "player"; if (m.ai) { m.ai.mode = "idle"; m.ai.t = 3; }
  if (m.vel) m.vel.x = m.vel.z = 0;
  try { if (P && P.uiOpen) P.uiOpen(); } catch (e) { console.error(e); }
  wasPaused = !!BF.state.paused; BF.state.paused = true;   // the world waits while you talk, as at the trade screen
  ui.model.textContent = status && status.model ? status.model : "";
  if (!status || !status.sdk) ui.model.textContent = "not ready";
  ui.root.classList.add("open");
  redraw();
  if (status && status.configured && !status.sdk) line("err", status.error || "The Claude SDK isn't installed on the server");
  setBusy(busy);
  ui.ta.focus();
  return true;
}
function close() {
  if (!chatting) return;
  chatting = null;
  ui.root.classList.remove("open");
  ui.ta.blur();
  BF.state.paused = wasPaused;
  try { if (BF.player && BF.player.uiClose) BF.player.uiClose(); } catch (e) { console.error(e); }
}
function setBusy(b) { busy = b; if (ui.send) { ui.send.disabled = b; ui.send.textContent = b ? "..." : "Send"; } }

async function send() {
  const text = ui.ta.value.trim();
  if (!text || busy || !chatting) return;
  ui.ta.value = "";
  history.push({ role: "user", content: text.slice(0, 2000) });
  line("me", text);
  const wait = line("sys", NAME + " is thinking...");
  setBusy(true);
  const t0 = performance.now();
  let out = null, err = null;
  try {
    const r = await fetch("/claude/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ villager: { name: NAME, world: worldLine(), start: start ? start.list : [], inventory: contents(chatting && chatting.inv) },
        messages: history.slice(-MAX_TURNS) }) });
    out = await r.json().catch(() => null);
    if (!r.ok || !out || out.error) err = (out && out.error) || "server answered " + r.status;
  } catch (e) { err = "couldn't reach the game server (is it still running?)"; }
  wait.remove();
  setBusy(false);
  const ms = Math.round(performance.now() - t0);
  if (err) {
    history.pop();   // the message didn't land: keep the conversation well formed, put the words back to retry
    if (!ui.ta.value) ui.ta.value = text;
    line("err", "No answer: " + err);
    glog("ERROR", "Claude villager chat failed after " + ms + " ms: " + err, chatting);
    return;
  }
  let reply = out.reply || "";
  if (out.stop === "refusal" || !reply) {
    history.pop();
    line("sys", NAME + " shakes their head and won't answer that.");
    glog("INFO", "Claude villager declined to answer (" + (out.stop || "empty reply") + ", " + ms + " ms)", chatting);
    return;
  }
  if (out.stop === "max_tokens") reply += " ...";
  if (out.tools && out.tools.length) glog("INFO", NAME + " checked its inventory (" + (listText(contents(chatting && chatting.inv)) || "empty") + ")", chatting);
  history.push({ role: "assistant", content: reply });
  if (history.length > 200) history.splice(0, history.length - 200);
  if (chatting) line("them", reply, NAME);
  const u = out.usage || {};
  glog("INFO", "Chat with " + NAME + ": " + text.length + " characters in, " + reply.length + " out, " + (u.input || 0) + "/" + (u.output || 0) + " tokens, " + ms + " ms", chatting);
}

// every key goes to the panel while it is open (capture phase, like js/signs.js and js/commands.js)
addEventListener("keydown", e => {
  if (!chatting) return;
  e.stopImmediatePropagation();
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if ((e.key === "Enter" || e.key === "NumpadEnter") && !e.shiftKey) { e.preventDefault(); send(); return; }
  if (e.key === "Tab" || e.key === "F3" || e.key === "F1") { e.preventDefault(); return; }
  if (e.target !== ui.ta) ui.ta.focus();
}, true);

BF.claudeVillager = {
  isOpen, open, close,
  isChatting: m => !!chatting && chatting === m,
  home: () => home, mob: () => mob, status: () => status, history: () => history.slice(),
  inventory: () => contents(mob && mob.inv), startingInventory: () => (start ? start.list.slice() : null),
};
})();
