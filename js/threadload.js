// Thread load: how busy this thread is, for the debug screen's Threads card (Gordon, 2026-10-26: "which cores the program is utilizing, at
// what level"). A browser can't see the operating system's cores, so each thread of the game measures its own busy time, the share of
// the wall clock it spent working: the page's main thread, the simulation worker (a Web Worker, or the world server's thread) and each
// region worker (js/rplay.js followers). Time blocked at the region workers' barrier (js/rworkers.js link.waitMs) is waiting, not work,
// and is taken off. In Node (the world server's threads) the event loop's own measure is used (performance.eventLoopUtilization); in a
// browser the thread's entry points are timed: wrap(fn) or begin() / end() round them (the page's frame, the simulation's loop and
// messages, a follower's journal batches). The debug server adds the real per-core load of the computer it runs on (os.cpus).
// Samples every SAMPLE ms; keeps the last HIST of them (a minute) for the screen's sparkline.
// API: BF.tload = { begin(), end(), wrap(fn) -> fn, report() -> {busy (0..1, the last sample), avg (0..1, the last minute), hist: [0..100]}, total() -> ms,
//                   ELU (true in Node: the event loop's measure, not the timed entry points) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const SAMPLE = 1000;   // ms between samples
const HIST = 60;       // samples kept
const P = globalThis.performance;
const now = () => P.now();
const ELU = !!(P && typeof P.eventLoopUtilization === "function");

let depth = 0, t0 = 0, busyMs = 0;                 // (browser) time inside begin() / end()
let lastT = now(), lastBusy = 0, lastWait = 0, lastElu = ELU ? P.eventLoopUtilization() : null;
let cur = 0;
const hist = [];
function begin() { if (depth++ === 0) t0 = now(); }
function end() { if (depth > 0 && --depth === 0) { const t = now(); busyMs += t - t0; if (t - lastT >= SAMPLE) sample(); } }
function wrap(fn) { return function () { begin(); try { return fn.apply(this, arguments); } finally { end(); } }; }
const waitNow = () => { const RW = BF.rworkers; return RW && RW.link ? RW.link.waitMs || 0 : 0; };

function sample() {
  const t = now(), dt = t - lastT;
  if (dt < SAMPLE) return;
  let b;
  if (ELU) { const e = P.eventLoopUtilization(); b = e.active - lastElu.active; lastElu = e; }
  else { if (depth) { busyMs += t - t0; t0 = t; } b = busyMs - lastBusy; lastBusy = busyMs; }
  const w = waitNow(), dw = w >= lastWait ? w - lastWait : w;   // (a new link starts again from 0)
  lastWait = w;
  b = Math.max(0, Math.min(dt, b - dw));
  cur = b / dt;
  lastT = t;
  hist.push(Math.round(cur * 100));
  if (hist.length > HIST) hist.shift();
}
function report() {
  sample();
  const n = hist.length, avg = n ? hist.reduce((a, v) => a + v, 0) / n / 100 : 0;
  return { busy: cur, avg, hist: hist.slice() };
}

// The busy ms so far, the barrier's waits taken off: the simulation budget's measure where the simulation has a thread of its own
// (js/boot.js simFrame, js/active.js), so streaming chunks, the page's messages and everything else the thread does count, not only the
// ticks. (Node's measure counts a loop turn once it ends: the caller takes differences over many turns.)
function total() {
  const b = ELU ? P.eventLoopUtilization().active : busyMs + (depth ? now() - t0 : 0);
  return Math.max(0, b - waitNow());
}

BF.tload = { begin, end, wrap, report, total, ELU, SAMPLE, HIST };
})();
