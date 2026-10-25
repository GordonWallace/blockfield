// The world server's simulation thread (spec r15-41): runs js/simworker.js, the Web Worker's simulation (r15-38), unchanged in a Node
// worker_thread. This file is the thin host adapter: the worker globals simworker.js uses (self, postMessage, onmessage,
// addEventListener for errors, importScripts, location) on top of worker_threads' parentPort, and IndexedDB on files (server/idb.js),
// so js/save.js and the game log save to the server's disk. The server (server/world.js) sends it the same messages the page sends a
// Web Worker ({boot}, then protocol packets {h, b}), plus its own, marked server:
//   {server: "detach"}  the page closed: pause at once and save (Gordon, 2026-10-23); the world stays here, held, until a page picks it
//                       again (its load is answered at once from what's here, at the speed it had: simworker.js worldOp, BF.worker.held)
//   {server: "state", id}  the page's copy of the world being played (js/save.js restoreClient), for a page about to pick it again
//   {server: "feed", ack}  the debug screen's simulation part (js/debugfeed.js simPart), read here instead of through the page
//   {server: "shutdown"}  save and say so (Ctrl+C on ./run.sh)
//   {server: "rivers", st}  the next world's river network, solved before on this machine (the server's cache)
//   {server: "save"}  save now (an export, spec r15-42); {server: "writeFail", n, code} the next n writes fail (tests: a full disk)
// and it sends back {server: "world", id, name} whenever a world starts here (id null: the title screen's world), {server: "detached"},
// {server: "state"}, {server: "feed"}, {server: "save", ok, why}, {server: "shutdown"} (saved) and {server: "rivers", st} (a network it solved, for the cache).
// Game log: INFO "server" when the world pauses because its page closed, and when a page picks it up again.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, ".."), JS = path.join(ROOT, "js");
const idb = require("./idb.js").open(workerData.saves);

const listeners = { error: [], unhandledrejection: [] };
Object.assign(globalThis, {
  self: globalThis,
  location: { search: "", hostname: "localhost", protocol: "node:", href: "node:server/simthread.js" },
  BF_BUILD: workerData.build || undefined,   // the checkout's commit and branch, for the game log (js/gamelog.js), as the page gets them
  indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange,
  postMessage: (m, transfer) => { if (m && m.ready) ready(); parentPort.postMessage(m, transfer || []); },
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  // the scripts simworker.js asks for, by its relative URLs (from js/), the ?v= stamp dropped
  importScripts: (...urls) => {
    for (const u of urls) {
      const f = path.resolve(JS, String(u).split("?")[0]);
      if (!f.startsWith(ROOT + path.sep)) throw new Error("importScripts outside the game: " + u);
      vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
    }
  },
});
// region workers (spec r15-39, js/rplay.js): followers in worker_threads of their own (server/regionthread.js), as many as the server says
Object.assign(globalThis, {
  BF_WORKERS: workerData.workers || undefined, BF_SPLIT: workerData.split || undefined,
  BF_CORES: require("os").availableParallelism ? require("os").availableParallelism() : require("os").cpus().length,
  BF_REGION_SPAWN: (me, n) => {
    const { Worker } = require("worker_threads");
    const w = new Worker(path.join(__dirname, "regionthread.js"), { workerData: { me, n, play: true } });
    let fn = null, done = false;
    w.on("message", m => { if (fn) fn(m); });
    w.on("error", e => { if (fn && !done) fn({ error: String(e && e.stack || e) }); });
    w.on("exit", code => { if (code && fn && !done) fn({ error: "it exited (code " + code + ")" }); });
    return { post: m => w.postMessage(m), on: f => { fn = f; }, terminate: () => { done = true; w.terminate(); } };
  },
});
process.on("uncaughtException", e => { for (const fn of listeners.error) fn({ error: e, message: e && e.message }); if (!listeners.error.length) throw e; });
process.on("unhandledRejection", reason => { for (const fn of listeners.unhandledrejection) fn({ reason }); });

const post = m => parentPort.postMessage(m);
const BFx = () => globalThis.BF;
const glog = text => BFx().glog.log("INFO", "server", text);

// once the simulation has loaded: tell the server which world is here as worlds start
let riversIn = null;
function ready() {
  const BF = BFx();
  BF.state.paused = true;   // (a thread waiting for its page ticks nothing: the page's speed message starts it, after its world)
  BF.worker.rivers = () => { const st = riversIn; riversIn = null; return st; };
  // a network solved here goes to the server's cache, for the next world on this planet
  BF.on("newWorld", () => setTimeout(() => {
    if (!BF.worker.replayed) try { const st = BF.worldgen.riverState(); if (st) post({ server: "rivers", st }); } catch (e) { /* none */ }
  }, 0));
  BF.on("newWorld", () => post({ server: "world", id: null, seed: BF.state.seed }));
  BF.on("worldLoaded", m => post({ server: "world", id: m && m.id || null, name: m && m.name, seed: BF.state.seed }));
}

// ---- the page closed: pause, save, hold the world for the next page that picks it
let heldSpeed = null;
function detach() {
  const BF = BFx(), W = BF.warp, cur = BF.save.current;
  heldSpeed = W.speed;
  BF.state.paused = true;
  if (!cur) { post({ server: "detached", id: null, saved: false }); return; }
  glog("The page closed: world \"" + cur.name + "\" paused (it was at " + heldSpeed + "x) and saving");
  BF.worker.held = resume;
  BF.save.saveNow().then(ok => post({ server: "detached", id: cur.id, saved: !!ok }), () => post({ server: "detached", id: cur.id, saved: false }));
}
// a page picked the held world: its client starts over (hello, then every edit) and the world goes on at the speed it had
function resume() {
  const BF = BFx(), cur = BF.save.current;
  BF.worker.held = null;
  BF.proto.hosted().reset();
  glog("A page picked world \"" + cur.name + "\" up again: it goes on at " + heldSpeed + "x");
  return { meta: cur, resumed: true, speed: heldSpeed };
}
// what the page needs for its copy of the world being played (js/save.js restoreClient)
const CLIENT = ["version", "gen", "seed", "biomeScale", "villages", "monsters", "spawn", "rand", "time", "player", "inventory", "weather"];
function state() {
  const BF = BFx(), d = BF.save.snapshot(), out = {};
  for (const k of CLIENT) out[k] = d[k];
  return { meta: BF.save.current, data: out };
}

// (test/server.js) lockstep: paused, then ticks that load the chunks round the player before each one, with no time budget, as the
// headless boot's tick does (js/boot.js headless), so a run here can be compared with a headless run of as many ticks
function lockstep() {
  const BF = BFx(), W = BF.warp;
  BF.state.paused = true;
  BF.boot.ticks = raw => {
    const plan = W.plan(raw), t0 = performance.now();
    let n = 0;
    while (n < plan.n && !W.frozen && (n === 0 || performance.now() - t0 < W.BUDGET_MS)) { BF.boot.stream(); BF.simStep(plan.h); n++; }
    return n;
  };
  BF.proto.queries.partText = a => ({ ok: true, text: String(BF.stateHash.text(a.part)).slice(0, 4000) });   // (to show what differs)
  glog("Lockstep ticks (a test): chunks load before each tick, as headless");
}

parentPort.on("message", d => {
  if (d && d.test === "lockstep") { lockstep(); return; }
  if (d && d.server) {
    const BF = BFx();
    try {
      if (d.server === "rivers") riversIn = d.st;   // (the next world's network, from the server's cache: simworker.js worldOp)
      else if (d.server === "detach") detach();
      else if (d.server === "state") post(Object.assign({ server: "state", id: d.id }, BF.save.current && BF.save.current.id === d.id ? state() : { meta: null }));
      else if (d.server === "feed") post({ server: "feed", part: BF.debugFeed && BF.debugFeed.simPart ? BF.debugFeed.simPart(d.ack) : null });
      else if (d.server === "save") {   // (an export of the world being played or held: saved first)
        if (!BF.save || !BF.save.current) { post({ server: "save", ok: false, why: "no world here" }); return; }
        BF.save.saveNow().then(ok => post({ server: "save", ok: !!ok, why: BF.save.lastError }), e => post({ server: "save", ok: false, why: String(e && e.message || e) }));
      }
      else if (d.server === "writeFail") idb.worlds.failWrites(d.n, d.code);   // (test/server-saves.js: a full disk)
      else if (d.server === "shutdown") {
        if (!BF || !BF.save || !BF.save.current) { post({ server: "shutdown", ok: false }); return; }
        BF.state.paused = true;
        glog("The world server is stopping: saving world \"" + BF.save.current.name + "\"");
        BF.glog.flush();
        BF.save.saveNow().then(ok => { BF.glog.flush(); setTimeout(() => post({ server: "shutdown", ok: !!ok }), 50); });
      }
    } catch (e) { post({ server: d.server, error: String(e && e.stack || e) }); }
    return;
  }
  if (typeof globalThis.onmessage === "function") globalThis.onmessage({ data: d });
});

importScripts("simworker.js");
