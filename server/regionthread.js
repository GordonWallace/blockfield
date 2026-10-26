// Region workers in Node (spec r15-39): the follower side, a worker_thread holding a copy of the simulation (js/rworkers.js), and
// spawn(), which the leader calls to start them. Headless: tools/headless.js --workers runs the leader. In play: the world server's
// simulation thread (server/simthread.js, through js/simworker.js and js/rplay.js) runs it.
// A follower loads the simulation's files into its own vm context (tools/headless.js load) and takes messages from the leader:
//   {boot: {seed, save, settings, rivers}}   the same world as the leader's (rivers: the leader's solved river network, not solved again);
//                                             answers {booted: hash}
//   {start: {shared, me, n}}                  joins the leader's mailboxes and barrier (BF.rworkers.setup) at this tick
//   {cstart: {shared, me, n, only, shuffle}}  the cluster tick on with those systems, and joins as a cluster worker (js/cworkers.js)
//   {ticks: k}                                k headless ticks in lockstep with the leader's (chunks stream with no budget, as the leader's)
//   {hash: true}                              answers {hash: full state hash} (tests)
//   {stop: true}                              leaves
// Every error goes to the leader as {error} after stopping the others (the barrier's stop flag), and the follower exits.
// In play (workerData.play, the world server's simulation thread) a follower is js/rplay.js's instead: see the end of this file.
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const path = require("path");

// ---------------------------------------------------------------- the leader's side
// spawn(n - 1 followers) -> { list: [{w, me, ask(msg) -> Promise of the first answer}], shared, stop() }
function spawn(n, opts = {}) {
  const list = [];
  for (let me = 1; me < n; me++) {
    const w = new Worker(__filename, { workerData: { me, n, log: opts.log || null }, resourceLimits: opts.resourceLimits });
    const waiting = [];
    w.on("message", m => { if (m && m.error) { for (const f of waiting.splice(0)) f.no(new Error("region worker " + me + ": " + m.error)); if (opts.onError) opts.onError(me, m.error); return; } const f = waiting.shift(); if (f) f.ok(m); });
    w.on("error", e => { for (const f of waiting.splice(0)) f.no(e); if (opts.onError) opts.onError(me, String(e && e.stack || e)); });
    w.on("exit", code => { for (const f of waiting.splice(0)) f.no(new Error("region worker " + me + " exited (" + code + ")")); });
    list.push({ w, me, ask: msg => new Promise((ok, no) => { waiting.push({ ok, no }); w.postMessage(msg); }), post: msg => w.postMessage(msg) });
  }
  return { list, stop() { for (const f of list) { try { f.w.postMessage({ stop: true }); } catch (e) { /* gone */ } setTimeout(() => f.w.terminate(), 2000).unref(); } } };
}
module.exports = { spawn };

// ---------------------------------------------------------------- a follower
if (!isMainThread && workerData && workerData.me != null && !workerData.saves && !workerData.play) {
  const { load } = require(path.join(__dirname, "..", "tools", "headless.js"));
  const { BF } = load();
  const { me, n } = workerData;
  let h = null;
  const fail = e => {
    const text = String(e && e.stack || e);
    try { if (BF.rworkers.link) BF.rworkers.link.stop(me); } catch (_) { /* already */ }
    parentPort.postMessage({ error: text });
    setTimeout(() => process.exit(1), 100);
  };
  parentPort.on("message", d => {
    try {
      if (d.boot) {
        const b = d.boot;
        if (b.rivers) {
          BF.worldgen.init(BF.makeNoise(b.seed >>> 0), { biomeScale: (b.settings && b.settings.biomeScale) || 1, villages: 10 });
          BF.worldgen.adoptRivers(b.rivers);
          BF.prepareWorld = () => Promise.resolve();
        }
        h = BF.boot.headless({ seed: b.seed, save: b.save || null, settings: b.settings || {} });
        parentPort.postMessage({ booted: h.stateHash().hash });
      } else if (d.start) {
        const s = d.start;
        BF.rworkers.verify = s.verify || 0;
        BF.rworkers.audit = !!s.audit;
        BF.rworkers.shuffle = s.shuffle || 0;
        BF.rworkers.setup({ n: s.n, me: s.me, link: BF.rworkers.attach(s.shared, s.me, s.n) });
        parentPort.postMessage({ started: true });
      } else if (d.cstart) {
        const s = d.cstart;
        BF.ctick.only = s.only; BF.ctick.on = true;
        BF.cworkers.shuffle = s.shuffle || 0;
        BF.cworkers.setup({ n: s.n, me: s.me, link: BF.rworkers.attach(s.shared, s.me, s.n) });
        parentPort.postMessage({ started: true });
      } else if (d.ticks) {
        h.tick(d.ticks);
        parentPort.postMessage({ ticked: h.ticks });
      } else if (d.hash) parentPort.postMessage({ hash: BF.stateHash.full(), mismatch: BF.rworkers.mismatch || null, mismatchText: d.text ? BF.rworkers.mismatchText || null : null, audits: BF.rworkers.audits || null, stats: BF.cworkers.active ? BF.cworkers.stats() : BF.rworkers.stats() });
      else if (d.stop) process.exit(0);
    } catch (e) { fail(e); }
  });
}

// ---------------------------------------------------------------- a follower in play (js/rplay.js)
// Started by the world server's simulation thread (server/simthread.js BF_REGION_SPAWN) for a world it plays: the simulation in a vm
// context with the thread's navigator and location (so js/active.js and the rest set themselves up as the leader's did), the slash
// commands (the client's command requests replay here too) and js/rplay.js, whose follower takes the leader's messages.
if (!isMainThread && workerData && workerData.play) {
  const { load } = require(path.join(__dirname, "..", "tools", "headless.js"));
  const { BF } = load({ globals: { navigator: globalThis.navigator, location: { search: "", hostname: "localhost", protocol: "node:", href: "node:server/regionthread.js" } },
    files: ["js/coords.js", "js/commands.js", "js/debugfeed.js", "js/rplay.js"] });
  const handle = BF.rplay.follower(m => parentPort.postMessage(m));
  parentPort.on("message", d => handle(d));
}
