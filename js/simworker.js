// The world simulation in a Web Worker (spec r15-38). The page (js/simhost.js) starts this worker at boot, sends {boot} once, then
// speaks the simulation/client protocol (js/protocol.js) to it: the page only draws and takes input, and keeps its own copy of the world
// (the protocol's replica option) to draw, light and collide with. Everything that changes the world happens here.
// Loads Three.js (for its maths: the page's copy, else the repo's test copy), the simulation's files (js/simfiles.js, the same list
// as the headless boot, js/boot.js), the debug feed's snapshot (js/debugfeed.js) and the slash commands (js/commands.js), then runs the tick loop on its own timer:
// fixed ticks (r15-10) at the speed the page asks for, within its own budget (BF.warp.BUDGET_MS a loop), streaming chunks round the
// player the page reports, flushing the protocol after every loop and autosaving like the page did (js/save.js writes IndexedDB here).
// Worlds start by the protocol's world message: demo (the title screen's world), create (a new saved world, its meta made by the page)
// or load (a saved world by id). Each takes the page's solved river network (js/worldgen.js riverState), so it isn't solved twice.
// The page's menus pause it (speed message with pause); a hidden tab pauses it too, as 1.4 stopped with the page's frames.
// A crash (an error out of the loop) stops the loop, goes to the game log and to the page as {crash}; the page offers a reload.
// Game log: INFO "worker" when the worker has loaded (files, time) and when each world starts here; ERROR for a crash.
(() => {
"use strict";
const Q = self.location.search;   // the ?v= stamp of the page's scripts (BF.workerUrl, js/grid.js): imports carry it on
let BF = null, sim = null, crashed = false;
const early = [];   // packets that came before the simulation was ready

function boot(o) {
  const t0 = performance.now();
  let three = false;
  for (const u of [o.three, "../.three-test.min.js"]) {   // three.js r128: the page's copy (the CDN), else the repo's copy the tests use
    if (!u || three) continue;
    try { importScripts(u); three = typeof THREE !== "undefined"; } catch (e) { /* the next one */ }
  }
  if (!three) throw new Error("three.js would not load in the worker");
  importScripts("simfiles.js" + Q);
  BF = self.BF;
  importScripts(...BF.SIM_FILES.map(f => "../" + f + Q));
  importScripts("debugfeed.js" + Q);   // (its snapshot only: the page sends it to the debug server)
  importScripts("commands.js" + Q);    // (the slash commands: the page's command line sends them as "command" requests)
  BF.boot.initSim();
  BF.glog.setSink(e => { if (e.l === "ERROR") post({ errorLine: e.x }); });   // (the page shows the latest error with a crash)
  BF.worker = { feed: o.feed || null };
  sim = BF.proto.host(p => post(p, p.b ? [p.b] : []), { replica: true, world: worldOp, onView: v => { if (v.dist > 0 && v.dist !== BF.world.viewDist) BF.world.setViewDist(v.dist); } });
  BF.glog.log("INFO", "worker", "Simulation worker loaded: " + BF.SIM_FILES.length + " files in " + Math.round(performance.now() - t0) + " ms");
  for (const p of early.splice(0)) sim.receive(p);
  post({ ready: true });
  last = performance.now();
  loop();
}
function post(m, transfer) { self.postMessage(m, transfer || []); }

// ---- worlds
// The planet's river network: the page's copy replayed (r14-23), so the worker doesn't solve it again; its key is "seed:biome size".
// False when there is none or it isn't for this world (newWorld then solves it here).
function rivers(seed, st) {
  if (!st) return false;
  BF.worldgen.init(BF.makeNoise(seed >>> 0), { biomeScale: +String(st.seed).split(":")[1] || 1, villages: 10 });
  return !!BF.worldgen.adoptRivers(st);
}
// js/save.js load() asks for the rivers first (the page's loading screen, BF.prepareWorld); here they come with the world message
let riverSt = null;
function worldOp(op, a) {
  // the world server (r15-41, server/simthread.js): the world held paused since its page closed, picked again: it goes on as it is
  if (op === "load" && BF.worker.held && BF.save.current && BF.save.current.id === a.id) return BF.worker.held(a);
  BF.worker.held = null;
  const t0 = performance.now();
  riverSt = a.rivers || null;
  BF.prepareWorld = seed => { rivers(seed, riverSt); return Promise.resolve(); };
  const S = BF.save;
  const started = what => {
    BF.glog.log("INFO", "worker", what + " in the simulation worker in " + ((performance.now() - t0) / 1000).toFixed(1) + " s" + (riverSt ? " (the page's river network)" : ""));
    last = performance.now();
  };
  if (op === "demo" || op === "create") {
    const o = a.opts || {};
    const replayed = rivers(a.seed, riverSt);
    BF.newWorld(a.seed, o);
    if (op === "demo") { S.current = null; started("Title screen world seed " + BF.state.seed + " started"); return { seed: BF.state.seed, rivers: replayed }; }
    S.current = a.meta;
    BF.emit("worldLoaded", a.meta);
    started("World \"" + a.meta.name + "\" created");
    return S.saveNow().then(ok => ({ meta: S.current, saved: ok, rivers: replayed }));
  }
  if (op === "load") return S.load(a.id).then(meta => { started("World \"" + meta.name + "\" loaded"); return { meta }; });
  throw new Error("unknown world op " + op);
}

// ---- the loop: a frame of ticks, chunks round the player, autosave, the protocol's flush
let last = 0, timer = 0, crashNext = false;
function loop() {
  timer = 0;
  if (crashed) return;
  const now = performance.now(), raw = Math.max(0, (now - last) / 1000);
  last = now;
  try {
    if (crashNext) { crashNext = false; throw new Error("a test crash (test/sim-worker.js)"); }
    const W = BF.warp, p = BF.player.position;
    BF.world.update(p.x, p.z, W.speed >= 10 ? 3 : 8);   // (generation only: nothing is meshed here)
    if (!BF.state.paused) {
      const n = BF.boot.ticks(raw);
      W.done(n, n * W.TICK, raw);
      if (BF.save) BF.save.update(Math.min(raw, W.MAX_FRAME));
    }
    BF.proto.flush();
    if (BF.stateHash) BF.stateHash.update();   // the state hash in the game log as each game day starts
  } catch (e) { crash(e); return; }
  // at 1x a loop about every frame (a tick every 50 ms); fast-forward goes again at once, leaving room for the page's messages
  const W = BF.warp, busy = !BF.state.paused && W.speed > 1;
  timer = setTimeout(loop, busy ? 0 : Math.max(4, 16 - (performance.now() - now)));
}
function crash(e) {
  if (crashed) return;
  crashed = true;
  const text = String(e && e.stack || e).split("\n").slice(0, 8).join("\n");
  try { BF.glog.log("ERROR", "worker", "The simulation worker stopped: " + text); BF.glog.flush(); BF.proto.flush(); } catch (_) { /* as far as it goes */ }
  post({ crash: text });
}
self.addEventListener("error", ev => { if (BF) crash(ev.error || ev.message); });
self.addEventListener("unhandledrejection", ev => { if (BF && BF.glog) BF.glog.log("ERROR", "uncaught", "unhandled promise rejection in the simulation worker: " + String(ev.reason && ev.reason.stack || ev.reason)); });

self.onmessage = ev => {
  const d = ev.data;
  if (d && d.boot) { try { boot(d.boot); } catch (e) { post({ failed: String(e && e.message || e) }); } return; }
  if (d && d.test === "crash") { crashNext = true; return; }   // (test/sim-worker.js: the crash path)
  if (!d || d.h == null) return;
  if (!sim) { early.push(d); return; }
  if (crashed) return;
  try {
    sim.receive(d);
    // a speed change or unpause: the next loop now rather than at the next timer
    if (d.h.startsWith('{"t":"speed"')) { clearTimeout(timer); timer = setTimeout(loop, 0); }
  } catch (e) { crash(e); }
};
})();
