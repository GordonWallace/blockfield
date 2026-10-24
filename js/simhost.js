// The simulation's host in the page (spec r15-38): runs the world simulation in a Web Worker (js/simworker.js) and makes the page its
// client. The page then only draws and takes input: it keeps its own copy of the world (js/world.js replica: chunks generated and lit
// here, the edits from the worker) for drawing, the player's physics and aiming; it owns the player's body and reports it every frame
// (the protocol's player message); what the simulation does to the player (hurts, food, inventory, teleports) comes back in self
// messages. Saving goes through the worker (js/save.js), which owns the world state and writes IndexedDB itself.
// Where the worker can't run the game's scripts (no Worker, a page opened as a file) the simulation runs in the page as before, through
// the in-page transport (js/protocol.js local). Until the page draws everything from the client's copy (spec r15-37) the worker is
// opt-in: ?sim=worker (or localStorage blockfield.sim = "worker"); ?sim=page forces the page.
// Speed: the page's fast-forward keys and menus are sent on (speed, pause); a hidden tab pauses the simulation, as 1.4 stopped with
// the page's frames. The page's own clock (BF.warp) keeps time for drawing between ticks and shows the speed the worker achieved.
// A crash in the worker stops it; the page shows the error with a button that reloads the game (the last save, from the title screen).
// Game log: INFO "worker" when the simulation starts in the worker, WARN when it falls back to the page (and why), ERROR on a crash.
// API: BF.simHost = { mode ("worker" | "in page"), worker (bool), why (why in page), start() -> Promise(mode), world(op, args) -> Promise,
//   demo(seed, opts), ticks(raw) -> n, achieved(), frame(), sky(drawnDt), crashed (text or null), wanted() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const DEFAULT = "page";   // until r15-37 has moved the drawing and screens to the client's copy
const glog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "worker", text); };

const H = (BF.simHost = { mode: "in page", worker: false, why: "", crashed: null, lastError: null });

H.wanted = function () {
  let v = null;
  try { v = new URLSearchParams(location.search).get("sim"); } catch (_) { /* none */ }
  if (!v) try { v = localStorage.getItem("blockfield.sim"); } catch (_) { /* none */ }
  return (v || DEFAULT) === "worker";
};
const cannot = () => typeof Worker === "undefined" ? "this browser has no Web Workers" :
  !/^https?:$/.test(location.protocol) ? "the page was opened as a file, so a worker can't load the game's scripts" : "";

function inPage(why) {
  H.mode = "in page"; H.worker = false; H.why = why;
  if (BF.proto && BF.proto.worker.on) BF.proto.worker.disconnect();
  BF.world.replica = false;
  if (BF.glog) BF.glog.remote(null);
}

// Starts the worker (when wanted and possible). Resolves "worker" once it has loaded the simulation, or "in page".
H.start = function () {
  if (!H.wanted()) { inPage("the default"); return Promise.resolve(H.mode); }
  const no = cannot();
  if (no) { inPage(no); glog("WARN", "The simulation runs in the page: " + no); return Promise.resolve(H.mode); }
  return new Promise(resolve => {
    const t0 = performance.now();
    let w, settled = false;
    const fail = why => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { w.terminate(); } catch (_) { /* gone */ }
      inPage(why);
      glog("WARN", "The simulation worker could not start (" + why + "); the simulation runs in the page");
      resolve(H.mode);
    };
    const timer = setTimeout(() => fail("it did not start in 60 s"), 60000);
    try { w = new Worker(BF.workerUrl("js/simworker.js")); } catch (e) { fail(String(e && e.message || e)); return; }
    const client = BF.proto.worker.connect(w);   // first, so the worker's hello finds it
    hook(client);
    w.onmessage = ev => {
      const d = ev.data;
      if (d && d.h != null) { BF.proto.worker.receive(d); return; }
      if (!d) return;
      if (d.ready && !settled) {
        settled = true; clearTimeout(timer);
        H.mode = "worker"; H.worker = true; H.why = "";
        BF.world.replica = true;
        BF.glog.remote(list => client.log(list));
        glog("INFO", "The simulation runs in a Web Worker (started in " + Math.round(performance.now() - t0) + " ms)");
        resolve(H.mode);
      } else if (d.failed) fail(d.failed);
      else if (d.crash) crashed(d.crash);
      else if (d.errorLine) H.lastError = d.errorLine;
    };
    w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); if (!settled) fail(ev && ev.message || "it could not load"); else crashed(ev && ev.message || "the worker failed"); };
    const three = document.querySelector('script[src*="three"]');
    w.postMessage({ boot: { three: three ? three.src : null } });
  });
};

// ---- the client: the world's edits into the page's copy, what the simulation did to the player
function hook(C) {
  C.onEdits = (chunks, full) => BF.world.applyEdits(chunks, full);
  C.onLog = list => { if (BF.glog) BF.glog.ingest(list); };
  C.onSelf = m => {
    const P = BF.player;
    if (m.hurt) for (const h of m.hurt) {
      if (h.kill) P.kill();
      else P.damage(h.a, h.from ? { x: h.from[0], y: h.from[1], z: h.from[2] } : null, h.cause || undefined);
    }
    if (m.health != null) P.health = m.health;
    if (m.hunger != null) P.hunger = m.hunger;
    if (m.gameMode && m.gameMode !== P.gameMode) P.setGameMode(m.gameMode);
    if (m.pos) P.teleport(m.pos[0], m.pos[1], m.pos[2]);
    if (m.inv && BF.inventory.setOwn) BF.inventory.setOwn(m.inv);
    if (m.spawn) BF.spawnPoint = m.spawn;
    sentPlayer = "";   // (the next frame reports the player again, so the simulation's baseline is the page's)
  };
}

// A world in the worker: op "demo" (the title screen's world, not saved), "create" or "load" (js/save.js). The page's solved river
// network goes along, so the worker replays it instead of solving it again.
H.world = function (op, args) {
  if (!H.worker) return Promise.resolve({ ok: false, why: "in page" });
  const a = Object.assign({ rivers: BF.worldgen.riverState ? BF.worldgen.riverState() : null }, args);
  sentPlayer = ""; lastClock = null;
  return new Promise(resolve => BF.client.worldOp(op, a, resolve));
};
H.demo = (seed, opts) => H.world("demo", { seed, opts: opts || {} });

// ---- each frame (js/main.js)
let sentPlayer = "", sentSpeed = null, sentPause = null, lastClock = null;
// The page's clock for drawing: the ticks a frame would run, counted but not run (they run in the worker). Returns how many.
H.ticks = function (raw) {
  const W = BF.warp, plan = W.plan(raw);
  W.advance(plan.n * plan.h);
  return plan.n;
};
H.achieved = () => { const c = BF.client && BF.client.world.clock; return c ? c.achieved : undefined; };
// The player's body and the speed to the worker, when they changed
H.frame = function () {
  if (!H.worker || H.crashed) return;
  const C = BF.client, P = BF.player;
  const st = P.serialize(), k = JSON.stringify(st);
  if (k !== sentPlayer) { sentPlayer = k; C.player(st); }
  speedNow();
};
function speedNow() {
  const W = BF.warp, sp = W.speed, pause = !!BF.state.paused || (typeof document !== "undefined" && document.hidden);
  if (sp !== sentSpeed || pause !== sentPause) { sentSpeed = sp; sentPause = pause; BF.client.speed(sp, pause); }
}
// The sky at the worker's clock: its time and weather when a clock message came, moving on by the drawn game time in between
H.sky = function (drawnDt) {
  if (!H.worker) return;
  const S = BF.sky, c = BF.client.world.clock;
  if (c && c !== lastClock) {
    lastClock = c;
    S.day = c.day; S.time = c.time;
    if (c.weather && BF.weather && BF.weather.deserialize) BF.weather.deserialize(c.weather);
  } else if (drawnDt > 0) {
    S.time += drawnDt / S.dayLength;
    if (S.time >= 1) { S.time -= 1; S.day++; }
  }
  S.advance(0);   // the light level and the weather's drawing for that time (no clock, no weather steps)
};
// a hidden tab: the simulation pauses at once (the page's frames have stopped)
document.addEventListener("visibilitychange", () => { if (H.worker && !H.crashed) speedNow(); });

// ---- a crash
function crashed(text) {
  if (H.crashed) return;
  H.crashed = text;
  BF.glog.remote(null);   // (the worker's log has the error; the page's own entries stay here now)
  console.error("The simulation worker stopped:", text);
  const el = document.createElement("div");
  el.id = "bf-crash";
  el.style.cssText = "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(10,12,11,.8);color:var(--ink);font:13px var(--mono)";
  el.innerHTML = '<div style="max-width:560px;background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:20px 22px">' +
    '<div style="font:18px var(--display);color:var(--danger,#e0533d);margin-bottom:8px">The simulation stopped</div>' +
    '<div>The world simulation hit an error and stopped. Your world is as it was at its last save; the error is in its game log.</div>' +
    '<pre style="white-space:pre-wrap;max-height:40vh;overflow:auto;background:rgba(0,0,0,.35);padding:8px;margin:12px 0"></pre>' +
    '<button style="font:14px var(--display);background:var(--accent);color:#14200c;border:0;border-radius:3px;padding:10px 14px;cursor:pointer">Reload from the last save</button></div>';
  el.querySelector("pre").textContent = text + (H.lastError && text.indexOf(H.lastError) < 0 ? "\n\n" + H.lastError : "");
  el.querySelector("button").onclick = () => location.reload();
  document.body.appendChild(el);
  BF.state.paused = true;
  if (BF.player && BF.player.uiOpen) BF.player.uiOpen();
}
})();
