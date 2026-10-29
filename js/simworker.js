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
// Region workers (spec r15-39, js/rplay.js): for each saved world it plays, this worker starts followers that keep copies of the world
// from its journal, and splits the regions' thinking over them when that pays (?workers=N and ?split=always|never on the page's URL).
// A crash (an error out of the loop, a follower's while split) stops the loop, goes to the game log and to the page as {crash}; the page offers a reload.
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
  if (o.build) self.BF_BUILD = o.build;   // the commit and branch debug/server.js gave the page, for the game log (js/gamelog.js)
  importScripts("simfiles.js" + Q);
  BF = self.BF;
  importScripts(...BF.SIM_FILES.map(f => "../" + f + Q));
  importScripts("threadload.js" + Q);  // (this thread's busy share, for the debug screen's Threads card)
  importScripts("debugfeed.js" + Q);   // (its snapshot only: the page sends it to the debug server)
  importScripts("coords.js" + Q);      // (the planet's positions, for the commands: /tp corner, latitude / longitude, face / u / v)
  importScripts("commands.js" + Q);    // (the slash commands: the page's command line sends them as "command" requests)
  importScripts("rplay.js" + Q);       // (region workers, spec r15-39: the followers this worker starts for each world)
  BF.boot.initSim();
  BF.glog.setSink(e => { if (e.l === "ERROR") post({ errorLine: e.x }); });   // (the page shows the latest error with a crash)
  BF.worker = { feed: o.feed || null };
  sim = BF.proto.host(p => post(p, p.b ? [p.b] : []), { replica: true, world: worldOp, onView: v => { if (v.dist > 0 && v.dist !== BF.world.viewDist) BF.world.setViewDist(v.dist); } });
  // region workers (spec r15-39): followers in Web Workers of their own (js/regionworker.js), or the world server's threads
  // (server/simthread.js gives BF_REGION_SPAWN); how many from the page (?workers=, ?split=) or the server's environment
  const spawn = self.BF_REGION_SPAWN || (typeof Worker === "function" ? (me, n) => {
    const w = new Worker("regionworker.js" + Q);
    return { post: m => w.postMessage(m), on: fn => { w.onmessage = e => fn(e.data); w.onerror = e => { e.preventDefault(); fn({ error: e.message || "the worker failed" }); }; }, terminate: () => w.terminate() };
  } : null);
  const nw = BF.rplay.setup({ workers: o.workers || self.BF_WORKERS, split: o.split || self.BF_SPLIT, kind: o.kind, verify: o.verify, cores: self.BF_CORES || (self.navigator && navigator.hardwareConcurrency), spawn, three: o.three });
  BF.on("worldRestored", (data, meta) => { if (loadingWorld) BF.rplay.begin({ op: "load", data, meta, rivers: riverSt }); });   // (a saved world: right as it is restored)
  BF.glog.log("INFO", "worker", "Simulation worker loaded: " + BF.SIM_FILES.length + " files in " + Math.round(performance.now() - t0) + " ms" + (nw > 1 ? "; " + nw + " region workers per world" : ""));
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
  BF.worker.replayed = false;
  if (!st) return false;
  BF.worldgen.init(BF.makeNoise(seed >>> 0), { biomeScale: +String(st.seed).split(":")[1] || 1, villages: 10 });
  return (BF.worker.replayed = !!BF.worldgen.adoptRivers(st));
}
// js/save.js load() asks for the rivers first (the page's loading screen, BF.prepareWorld); here they come with the world message
let riverSt = null, pageRivers = null;
function worldOp(op, a) {
  // the world server (r15-41, server/simthread.js): the world held paused since its page closed, picked again: it goes on as it is
  if (op === "load" && BF.worker.held && BF.save.current && BF.save.current.id === a.id) return BF.worker.held(a);
  BF.worker.held = null;
  const t0 = performance.now();
  riverSt = (a.rivers && pageRivers && pageRivers.seed === a.rivers ? pageRivers : null) || (BF.worker.rivers ? BF.worker.rivers() : null);   // (the world server's cache, server/simthread.js)
  pageRivers = null;
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
    if (op === "demo") { BF.rplay.end(); S.current = null; started("Title screen world seed " + BF.state.seed + " started"); return { seed: BF.state.seed, rivers: replayed }; }
    BF.rplay.begin({ op: "create", seed: a.seed, opts: o, rivers: riverSt });   // (region workers: the followers make the same world)
    S.current = a.meta;
    BF.emit("worldLoaded", a.meta);
    started("World \"" + a.meta.name + "\" created");
    return S.saveNow().then(ok => ({ meta: S.current, saved: ok, rivers: replayed }));
  }
  if (op === "load") {
    // no chunks are made while the save is read (on the world server that takes a while, spec r15-42): the rivers are set up before the
    // world is, and a chunk made in between had no terrain noise to make it from
    loadingWorld = true;
    const done = () => { loadingWorld = false; };
    return S.load(a.id).then(meta => { done(); started("World \"" + meta.name + "\" loaded"); return { meta }; }, e => { done(); throw e; });
  }
  throw new Error("unknown world op " + op);
}

// ---- the loop: a frame of ticks, chunks round the player, autosave, the protocol's flush
let last = 0, timer = 0, crashNext = false, loadingWorld = false;
// this thread's busy share for the debug screen (js/threadload.js): the loop and the messages are where it works
function timed(fn, a) { const TL = BF && BF.tload; if (TL) TL.begin(); try { fn(a); } finally { if (TL) TL.end(); } }
function loop() { timed(loopBody); }
function loopBody() {
  timer = 0;
  if (crashed) return;
  const now = performance.now(), raw = Math.max(0, (now - last) / 1000);
  last = now;
  try {
    if (crashNext) { crashNext = false; throw new Error("a test crash (test/sim-worker.js)"); }
    const W = BF.warp, p = BF.player.position;
    if (BF.debugOn && now - (BF.debugOnAt || 0) > 2000) BF.debugOn = false;   // the page's F3 overlay asks while it shows (js/protocol.js f3)
    BF.perf.frame();   // the villager-seconds meter on or off, its window's slices (js/perf.js; js/main.js in the page)
    if (!loadingWorld) BF.world.update(p.x, p.z, W.speed >= 10 ? 3 : 8);   // (generation only: nothing is meshed here)
    if (BF.rworkers.journal) BF.rworkers.rec(["f", raw]);   // (region workers: the followers run the same frame steps, js/rplay.js)
    BF.inventory.simFrame(raw);
    BF.maps.simFrame();   // the held map fills in round the player (js/maps.js)
    BF.player.simRide(raw);   // an untamed horse carries the player; a boat or horse gone puts them off (js/player.js, r15-44 part 2)   // a furnace watched in the pause cooks in real time; a gone villager's trade screen closes (js/playerinv.js)
    if (!BF.state.paused) {
      const n = BF.boot.ticks(raw);
      W.done(n, n * W.TICK, raw);
      if (BF.save) BF.save.update(Math.min(raw, W.MAX_FRAME));
    }
    BF.proto.flush();
    if (BF.stateHash) BF.stateHash.update();   // the state hash in the game log as each game day starts
    BF.rplay.frame();   // region workers: switch between one and several thinking, send the followers the journal (js/rplay.js)
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

self.onmessage = ev => timed(onMessage, ev);
function onMessage(ev) {
  const d = ev.data;
  if (d && d.boot) { try { boot(d.boot); } catch (e) { post({ failed: String(e && e.message || e) }); } return; }
  if (d && d.test === "crash") { crashNext = true; return; }   // (test/sim-worker.js: the crash path)
  if (d && d.test === "eval") { if (BF) BF.testEval = true; return; }
  if (d && d.rivers) { pageRivers = d.rivers; return; }   // the page's river network for the next world message (js/simhost.js world)
  if (d && d.budget) {   // the page's Distant villages settings (js/simhost.js budget, js/active.js), and its ?coarse= (js/gameopts.js)
    if (BF && BF.active) {
      BF.active.set(d.budget);
    }
    if (BF && BF.gameOpts && d.coarse != null) BF.gameOpts.override(d.coarse);
    // region workers: the followers take the same figures (the leader's automatic values: a follower's thread may work out others) and the
    // same ?coarse=, here between frames as the leader did (js/rplay.js "b")
    if (BF && BF.active && BF.rworkers.journal) {
      const o = BF.active.opts();
      BF.rworkers.rec(["b", { settings: BF.active.settings(), on: o.on, budget: o.budget, memMB: o.memMB, reach: o.reach }, BF.gameOpts ? BF.gameOpts.overridden() : null]);
    }
    return;
  }
  if (d && d.auto) { if (BF && BF.rplay && !d.workers) { BF.rplay.end(); BF.rplay.setup({ workers: 1 }); } return; }   // (an automated browser's page: one region worker unless the URL asks for more, ?workers= on the world server's page too; its budget comes as {budget})
  if (!d || d.h == null) return;
  if (!sim) { early.push(d); return; }
  if (crashed) return;
  try {
    // region workers: the packet goes in the journal, with the player as it left them (js/rplay.js)
    const op = BF.rworkers.journal ? ["p", d, null] : null;
    if (op) BF.rworkers.rec(op);
    sim.receive(d);
    if (op) op[2] = BF.rplay.player();
    // a speed change or unpause: the next loop now rather than at the next timer
    if (d.h.startsWith('{"t":"speed"')) { clearTimeout(timer); timer = setTimeout(loop, 0); }
  } catch (e) { crash(e); }
}
})();
