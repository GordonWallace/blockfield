// The simulation's host in the page (spec r15-38): runs the world simulation in a Web Worker (js/simworker.js) and makes the page its
// client. The page then only draws and takes input: it keeps its own copy of the world (js/world.js replica: chunks generated and lit
// here, the edits from the worker) for drawing, the player's physics and aiming; it owns the player's body and reports it every frame
// (the protocol's player message); what the simulation does to the player (hurts, food, inventory, teleports) comes back in self
// messages. Saving goes through the worker (js/save.js), which owns the world state and writes IndexedDB itself.
// Where the worker can't run the game's scripts (no Worker, a page opened as a file) the simulation runs in the page as before, through
// the in-page transport (js/protocol.js local).
// Choosing the host (spec r15-43): at start-up, the world server if it says hello on the page's socket within 1 s, else a Web Worker if
// the page can run one, else the page. ?sim=auto|server|worker|page, or the pause menu's Simulation setting (localStorage blockfield.sim),
// forces one; F3 and the pause menu show where it runs: "World server (N threads)", "Browser (worker)" or "Browser (this page)".
// Speed: the page's fast-forward keys and menus are sent on (speed, pause); a hidden tab pauses the simulation, as 1.4 stopped with
// the page's frames. The page's own clock (BF.warp) keeps time for drawing between ticks and shows the speed the worker achieved.
// A crash in the worker stops it; the page shows the error with a button that reloads the game (the last save, from the title screen).
// The world server (spec r15-41, server/world.js): served by ./run.sh, the page can be a client of the simulation in the Node process
// instead, over a WebSocket on its own host (/sim). The socket is wrapped to look like a Worker, so everything here is the same for
// both; the server's saved worlds are its own (H.saves, js/save.js), a hidden tab doesn't pause it, and if its connection closes by
// itself the page shows "World server stopped" with the game log's last lines. ?sim=server asks for it (waiting up to 3 s for its hello),
// ?sim=auto (the default) takes it when the page has one and a worker otherwise; ?sim=worker always takes the Web Worker.
// Game log: INFO "worker" when the simulation starts in the worker, on the world server, or in the page because it was asked for, and
// when the Simulation setting changes; WARN when it falls back (and why), ERROR on a crash or when the world server stops.
// API: BF.simHost = { mode ("server" | "worker" | "in page"), worker (bool: the simulation is not in the page), server (bool), why (why in
//   page), start() -> Promise("worker" | "in page"), world(op, args) -> Promise, demo(seed, opts), ticks(raw) -> n, achieved(), frame(),
//   sky(drawnDt), crashed (text or null), wanted() -> "server" | "worker" | "auto" | null, saves(q) -> Promise (the server's worlds), post(m),
//   refused (why the world server turned this page away: another page plays on it; else undefined),
//   label() -> the host as the player sees it, threads (the world server's), CHOICES, pref() / setPref(v) / prefLabel(v) (the setting),
//   eval(src, arg) -> Promise (tests only: test/bft.js BFT.sim) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const glog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "worker", text); };

const H = (BF.simHost = { mode: "in page", worker: false, server: false, why: "", crashed: null, lastError: null });

// Which host the page asks for (spec r15-43): ?sim= in the address, else the setting (localStorage blockfield.sim, the pause menu's
// "Simulation" button), else DEFAULT. "auto" (the default): the world server when the page has one (it says hello within 1 s), else a
// Web Worker when the page can run one, else the page. "server", "worker" and "page" force one (a forced host that can't run falls back
// the same way: server, worker, page).
H.CHOICES = ["auto", "server", "worker", "page"];
H.pref = function () { try { const v = localStorage.getItem("blockfield.sim"); return H.CHOICES.includes(v) ? v : "auto"; } catch (_) { return "auto"; } };
H.setPref = function (v) {
  if (!H.CHOICES.includes(v)) return;
  try { if (v === "auto") localStorage.removeItem("blockfield.sim"); else localStorage.setItem("blockfield.sim", v); } catch (_) { /* not kept */ }
  glog("INFO", "Simulation setting: " + H.prefLabel(v) + " (from the next start)");
};
H.prefLabel = v => ({ auto: "Automatic", server: "World server", worker: "Browser (worker)", page: "Browser (this page)" })[v] || v;
H.wanted = function () {
  let v = null;
  try { v = new URLSearchParams(location.search).get("sim"); } catch (_) { /* none */ }
  if (!H.CHOICES.includes(v)) v = H.pref();
  return v === "page" ? null : v;
};
// What the player is shown (F3, the pause menu): where the simulation runs now
H.label = function () {
  if (H.server) { const n = H.threads || 1; return "World server (" + n + " thread" + (n === 1 ? "" : "s") + ")"; }
  return H.worker ? "Browser (worker)" : "Browser (this page)";
};
const cannot = () => typeof Worker === "undefined" ? "this browser has no Web Workers" :
  !/^https?:$/.test(location.protocol) ? "the page was opened as a file, so a worker can't load the game's scripts" : "";

// the line saying the simulation runs in the page, and why: logged now and again as each world starts (the game log drops what was logged
// before the first world, js/gamelog.js)
let pageNote = null;
const notePage = (lvl, text) => { pageNote = [lvl, text]; glog(lvl, text); };
function inPage(why) {
  H.mode = "in page"; H.worker = false; H.server = false; H.why = why;
  if (BF.proto && BF.proto.worker.on) BF.proto.worker.disconnect();
  BF.world.replica = false;
  if (BF.glog) BF.glog.remote(null);
  logLater();
}

// Starts the simulation's host (when wanted and possible): the world server (spec r15-41) or a Web Worker. Resolves "worker" once the
// simulation has loaded there (H.mode says which: "server" or "worker"), or "in page".
H.start = function () {
  // (after the game log's own newWorld listener has started the world's log: it registers later, at the page's load)
  if (BF.on) BF.on("newWorld", () => setTimeout(() => { if (pageNote && !H.worker) glog(pageNote[0], pageNote[1]); }, 0));
  const want = H.wanted();
  if (!want) { inPage("asked for"); notePage("INFO", "The simulation runs in the page (asked for: ?sim=page or the Simulation setting)"); return Promise.resolve(H.mode); }
  if (want === "worker") return startWorker();
  if (!/^https?:$/.test(location.protocol) || typeof WebSocket === "undefined") {   // a file or the Artifact: no world server there
    if (want === "server") later.push(["WARN", "No world server: the page was not served by ./run.sh"]);
    return startWorker();
  }
  return serverSocket(want === "server" ? 3000 : 1000).then(w => {
    if (w.sock) return run(w.sock, "server");
    if (w.refused) H.refused = w.why;   // (the title screen says "World in use", spec r15-42)
    if (want === "server") later.push(["WARN", "No world server (" + w.why + "): the simulation runs in a Web Worker instead"]);
    return startWorker();
  });
};
// lines for the game log once it is clear where the simulation runs (the log the page shows is that host's)
const later = [];
const logLater = () => { for (const [l, x] of later.splice(0)) glog(l, x); };
function startWorker() {
  const no = cannot();
  if (no) { inPage(no); notePage(H.wanted() === "auto" ? "INFO" : "WARN", "The simulation runs in the page: " + no); return Promise.resolve(H.mode); }
  let w;
  try { w = new Worker(BF.workerUrl("js/simworker.js")); } catch (e) { inPage(String(e && e.message || e)); notePage("WARN", "The simulation worker could not start (" + H.why + "); the simulation runs in the page"); return Promise.resolve(H.mode); }
  return run(w, "worker");
}
// w: a Web Worker, or the world server's socket wrapped to look like one (serverSocket)
function run(w, via) {
  const server = via === "server", what = server ? "world server" : "simulation worker";
  return new Promise(resolve => {
    const t0 = performance.now();
    let settled = false;
    const fail = why => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { w.terminate(); } catch (_) { /* gone */ }
      if (server) { BF.proto.worker.disconnect(); later.push(["WARN", "The world server could not start the simulation (" + why + "); it runs in a Web Worker instead"]); startWorker().then(resolve); return; }
      inPage(why);
      notePage("WARN", "The simulation worker could not start (" + why + "); the simulation runs in the page");
      resolve(H.mode);
    };
    const timer = setTimeout(() => fail("it did not start in 60 s"), 60000);
    const client = BF.proto.worker.connect(w, via);   // first, so the worker's hello finds it
    hook(client);
    w.onmessage = ev => {
      const d = ev.data;
      if (d && d.h != null) { BF.proto.worker.receive(d); return; }
      if (!d) return;
      if (d.ready && !settled) {
        settled = true; clearTimeout(timer);
        H.mode = server ? "server" : "worker"; H.worker = true; H.server = server; H.why = "";
        H.threads = server ? (w.hello && w.hello.threads) || 1 : 1;
        if (globalThis.BF_TEST) w.postMessage({ test: "eval" });
        // an automated browser starts the budget off (js/active.js); the world server's Node has a navigator of its own that never says so
        if (navigator.webdriver && !/(?:^|[?&])budget=/.test(location.search.slice(1))) w.postMessage({ auto: true });   // (tests: BFT.sim runs code where the simulation is, protocol query eval)
        BF.world.replica = true;
        BF.glog.remote(list => client.log(list));
        glog("INFO", server ? "The simulation runs on the world server (" + location.host + ", ready in " + Math.round(performance.now() - t0) + " ms)" + (w.hello.held ? "; it holds world \"" + w.hello.held.name + "\", paused since its page closed" : "")
          : "The simulation runs in a Web Worker (started in " + Math.round(performance.now() - t0) + " ms)");
        logLater();
        resolve("worker");   // (either way the page is the simulation's client: js/main.js)
      } else if (d.failed) fail(d.failed);
      else if (d.crash) crashed(d.crash);
      else if (d.errorLine) H.lastError = d.errorLine;
      else if (d.saves) { const f = asked.get(d.saves.rid); if (f) { asked.delete(d.saves.rid); f(d.saves); } }
      else if (d.feedAck) { if (BF.debugFeed && BF.debugFeed.serverAck) BF.debugFeed.serverAck(d.feedAck); }
      else if (d.gone) gone(d.gone);
    };
    w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); if (!settled) fail(ev && ev.message || "it could not load"); else crashed(ev && ev.message || "the " + what + " failed"); };
    const three = document.querySelector('script[src*="three"]');
    w.postMessage({ boot: { three: three ? three.src : null, build: window.BF_BUILD || null } });   // (build: the checkout's commit, for the game log's header)
  });
}

// ---- the world server's socket (ws://<this page's host>/sim, server/world.js), made to look like a Worker for run(): protocol packets
// as binary frames ([header length u32 LE][1 if a binary part follows][header JSON][binary part]), everything else as JSON text. Resolves {sock} once the server
// has said hello, else {why} (no server, refused: another page plays, or no answer within 3 s).
function serverSocket(wait) {
  return new Promise(resolve => {
    let ws, done = false, closing = false;
    const end = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { end({ why: "no answer in " + wait / 1000 + " s" }); try { ws.close(); } catch (_) { /* gone */ } }, wait);
    try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/sim"); } catch (e) { end({ why: String(e && e.message || e) }); return; }
    ws.binaryType = "arraybuffer";
    const enc = new TextEncoder(), dec = new TextDecoder();
    const sock = {
      hello: null, onmessage: null, onerror: null,
      postMessage(m) {
        if (ws.readyState !== 1) return;
        if (m && m.h != null) {
          const h = enc.encode(m.h), n = m.b ? m.b.byteLength : 0, out = new Uint8Array(5 + h.length + n);
          new DataView(out.buffer).setUint32(0, h.length, true); out[4] = m.b ? 1 : 0; out.set(h, 5);
          if (n) out.set(new Uint8Array(m.b), 5 + h.length);
          ws.send(out);
        } else ws.send(JSON.stringify(m));
      },
      terminate() { closing = true; try { ws.close(); } catch (_) { /* gone */ } },
    };
    ws.onmessage = ev => {
      let d;
      if (typeof ev.data === "string") {
        try { d = JSON.parse(ev.data); } catch (_) { return; }
        if (!done) { if (d.hello) { sock.hello = d.hello; end({ sock }); } else if (d.refused) { closing = true; end({ why: d.refused, refused: true }); } return; }
      } else {
        const u = new Uint8Array(ev.data), n = new DataView(ev.data).getUint32(0, true);
        d = { h: dec.decode(u.subarray(5, 5 + n)), b: u[4] ? ev.data.slice(5 + n) : null };
      }
      if (sock.onmessage) sock.onmessage({ data: d });
    };
    ws.onerror = () => end({ why: "no world server at " + location.host });
    ws.onclose = () => {
      if (!done) { end({ why: "no world server at " + location.host }); return; }
      if (!closing && sock.onmessage) sock.onmessage({ data: { gone: "its connection closed" } });
    };
    addEventListener("pagehide", () => { closing = true; });   // (the page is going: the server pauses the world and saves)
  });
}
// a request about the server's saved worlds (js/save.js): resolves its answer
const asked = new Map();
let askN = 1;
H.saves = function (q) {
  if (!H.server) return Promise.resolve({ ok: false, why: "no world server" });
  const rid = askN++;
  return new Promise(resolve => { asked.set(rid, resolve); BF.proto.worker.w.postMessage({ saves: Object.assign({ rid }, q) }); });
};
// Tests (test/bft.js BFT.sim, spec r15-43): runs a function's source where the simulation is, with arg, and resolves its (awaited,
// structured-clone or JSON) result. In the page it runs here; in a worker or on the world server through the protocol's eval query,
// which only a page with BF_TEST set turns on (and on the world server only one started with --test).
H.eval = function (src, arg) {
  if (!H.worker) return Promise.resolve().then(() => (0, eval)("(" + src + ")")(arg));
  return new Promise((resolve, reject) => BF.client.query("eval", { src, arg }, r => (r && r.ok ? resolve(r.value) : reject(new Error("in the simulation: " + (r && (r.error || r.why)))))));
};
// to the world server, outside the protocol (the debug feed's page part, js/debugfeed.js)
H.post = m => { if (H.server && BF.proto.worker.w) BF.proto.worker.w.postMessage(m); };

// ---- the client: the world's edits into the page's copy, what the simulation did to the player
function hook(C) {
  C.onEdits = (chunks, full) => BF.world.applyEdits(chunks, full);
  C.onLog = list => {
    if (BF.glog) BF.glog.ingest(list);
    // a save that failed there (an autosave, a full disk: spec r15-42): the page says so, as when it saves itself
    for (const e of list) if (e.k === "save" && e.l === "ERROR" && Date.now() - e.s < 30000) { const m = /failed \((.*)\); the previous save is kept$/.exec(e.x); BF.emit("saveFailed", new Error(m ? m[1] : e.x)); }
  };
  C.onSelf = m => {
    const P = BF.player;
    if (m.hurt) for (const h of m.hurt) {
      if (h.kill) P.kill();
      else P.damage(h.a, h.from ? { x: h.from[0], y: h.from[1], z: h.from[2] } : null, h.cause || undefined);
    }
    if (m.health != null) P.health = m.health;
    if (m.hunger != null) P.hunger = m.hunger;
    if (m.saturation != null) P.saturation = m.saturation;   // (eating, in the simulation: r15-43)
    if (m.gameMode && m.gameMode !== P.gameMode) P.setGameMode(m.gameMode);
    if (m.mount !== undefined) P.rideSelf(m.mount);   // got on or off a boat or horse (r15-44 part 2), before a teleport off it
    if (m.pos) P.teleport(m.pos[0], m.pos[1], m.pos[2]);
    if (m.look) P.setLook(m.look[0], m.look[1]);
    if (m.flying != null && P.flying !== m.flying) P.setFlying(m.flying);
    if (m.inv && BF.inventory.setOwn) BF.inventory.setOwn(m.inv);
    if (m.spawn) BF.spawnPoint = m.spawn;
    sentPlayer = "";   // (the next frame reports the player again, so the simulation's baseline is the page's)
  };
}

// A world in the worker: op "demo" (the title screen's world, not saved), "create" or "load" (js/save.js). The page's solved river
// network goes along, so the worker replays it instead of solving it again.
H.world = function (op, args) {
  if (!H.worker) return Promise.resolve({ ok: false, why: "in page" });
  // (not to the world server: the network is tens of megabytes, and the server keeps the ones it has solved, server/world.js)
  const a = Object.assign({ rivers: !H.server && BF.worldgen.riverState ? BF.worldgen.riverState() : null }, args);
  sentPlayer = ""; lastClock = null; sentSpeed = sentPause = null;
  return new Promise(resolve => BF.client.worldOp(op, a, r => {
    if (r && r.resumed && r.speed != null) {   // a world the server held paused, picked again: it goes on at the speed it had
      const W = BF.warp, i = W.SPEEDS.indexOf(r.speed);
      if (!r.speed) W.freeze(); else if (i >= 0) W.set(i);
      glog("INFO", "The world server's held world \"" + (r.meta && r.meta.name) + "\" goes on at " + r.speed + "x");
    }
    resolve(r);
  }));
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
  const st = P.serialize();
  st.sel = BF.inventory.selectedIndex;   // the hotbar slot: the page's (r15-44)
  const ride = P.rideReport();   // the boat or saddled horse the page steers (r15-44 part 2)
  if (ride) st.ride = ride;
  const k = JSON.stringify(st);
  if (k !== sentPlayer) { sentPlayer = k; C.player(st); }
  speedNow();
};
function speedNow() {
  // (a hidden tab pauses the worker as 1.4 stopped; the world server goes on: it has no tab to throttle, and its page is still open)
  const W = BF.warp, sp = W.speed, pause = !!BF.state.paused || (!H.server && typeof document !== "undefined" && document.hidden);
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
// the world server's connection closed by itself (the server stopped, or crashed): the same overlay, with the game log's newest lines
function gone(why) {
  const LM = BF.logmatch, tail = (BF.glog ? BF.glog.recent(20) : []).map(e => (LM && LM.gameLine ? LM.gameLine(e) : e.l + " " + e.k + " " + e.x)).join("\n");
  glog("ERROR", "World server stopped: " + why);
  crashed("The world server stopped (" + why + "). Start ./run.sh again; your world is as it was at its last save.\n\nThe game log's last lines:\n" + tail, "World server stopped");
}
function crashed(text, title) {
  if (H.crashed) return;
  H.crashed = text;
  BF.glog.remote(null);   // (the worker's log has the error; the page's own entries stay here now)
  console.error(title ? title + ":" : "The simulation worker stopped:", text);
  const el = document.createElement("div");
  el.id = "bf-crash";
  el.style.cssText = "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(10,12,11,.8);color:var(--ink);font:13px var(--mono)";
  el.innerHTML = '<div style="max-width:560px;background:var(--panel);border:1px solid var(--panel-edge);border-radius:4px;padding:20px 22px">' +
    '<div style="font:18px var(--display);color:var(--danger,#e0533d);margin-bottom:8px"></div>' +
    '<div>' + (title ? "The page lost the world server, which runs the simulation." : "The world simulation hit an error and stopped. Your world is as it was at its last save; the error is in its game log.") + '</div>' +
    '<pre style="white-space:pre-wrap;max-height:40vh;overflow:auto;background:rgba(0,0,0,.35);padding:8px;margin:12px 0"></pre>' +
    '<button style="font:14px var(--display);background:var(--accent);color:#14200c;border:0;border-radius:3px;padding:10px 14px;cursor:pointer">Reload from the last save</button></div>';
  el.firstChild.firstChild.textContent = title || "The simulation stopped";
  el.querySelector("pre").textContent = text + (H.lastError && text.indexOf(H.lastError) < 0 ? "\n\n" + H.lastError : "");
  el.querySelector("button").onclick = () => location.reload();
  document.body.appendChild(el);
  BF.state.paused = true;
  if (BF.player && BF.player.uiOpen) BF.player.uiOpen();
}
})();
