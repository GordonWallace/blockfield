// Region workers in play (spec r15-39): the simulation worker's side of js/rworkers.js. The simulation worker (js/simworker.js, the page's
// Web Worker or the world server's thread, server/simthread.js) is the leader; it starts the followers for each world it plays, and they
// keep whole copies of that world by replaying the leader's journal (js/rworkers.js rec): the client's protocol packets, the chunks
// streaming loaded and dropped, each tick, in the order the leader did them. A follower never streams, saves or talks to a client.
// Two modes, switched at a tick boundary by an op in the journal:
//   solo   (the start) the leader runs whole ticks alone; each follower runs the same ticks on its own copy when it gets to them;
//   split  the ticks run in lockstep and each worker thinks only its share of the regions (js/rworkers.js): the work of a tick is spread.
// Splitting isn't free (each worker sends what its mobs changed every tick), so the leader splits only when the simulation can't keep up
// (ticks dropped for a while) and the followers have caught up, then keeps the split only if ticks got faster (a trial of TRIAL ticks
// against the ticks before it); otherwise back to solo, and it tries again later (BACKOFF ticks, doubling). ?split=always splits as soon as
// the followers are ready, ?split=never never does. The followers' copies are compared now and then while split (VERIFY ticks): a
// difference logs an ERROR and the leader goes on alone. A follower that crashes while split stops the simulation (the page offers a
// reload: js/simworker.js crash); while solo the leader goes on alone. How many: settings.workers (the page's ?workers=, or the world
// server's BF_WORKERS); none unless asked (2026-10-27: while solo every follower replays every tick, about a core each, and no split has
// paid yet; clusters on workers, spec r15-39b, take over). One is none. They need SharedArrayBuffer (a cross-origin isolated page:
// ./run.sh).
// Game log: INFO "workers" when they start for a world (how many), each switch to split or solo (with ms a tick before and after), and
// when they stop; ERROR when one crashes, boots a different world or no longer matches.
// Each follower sends its thread's busy share (js/threadload.js) with a batch's answer about once a second: status().loads, for the
// debug screen's Threads card.
// Clusters (spec r15-39b, settings.kind "clusters": the page's ?clusters=1, the world server's --clusters): the split is the cluster tick on
// every copy, each worker running its own clusters with partial copies (js/cworkers.js), meeting every BF.ctick.MEET ticks; the journal still
// brings every copy the client's packets and the chunks, and goes out every tick while they meet. Back to one: at the next meeting every
// worker takes the whole world (cworkers.leave) and the leader goes on running every cluster, the followers replaying it; the cluster
// tick goes off only when the followers go (end: the copies' tables are in different orders after a split, which only the plain tick
// reads). A save waits for the next meeting (js/save.js). With ?verify=N the copies' gathered hashes are compared every N / 20 meetings;
// a difference goes back to one after the next meeting. A split that doesn't pay (auto) goes back to one, and then the followers go:
// the cluster tick on one with followers attached was 3.2 times slower than the plain tick on test4 (2026-10-29), and only their going
// turns it off. The first split waits until the plain tick has been measured for PLAIN_TICKS (not while the world loads: a trial on
// test4 was judged against 46.9 ms a tick measured then, against 8.6 once loaded).
// Running ahead (2026-10-30): while the clusters are split and the game fast-forwards, each interval opens at its meeting (an "open" op
// before the meeting tick's "t"), and the followers run their own clusters' ticks up to the interval's last without waiting for the
// leader's: clusters don't reach each other between meetings (js/clusters.js), so their ticks don't need the leader's, and neither the
// leader's slow ticks nor its time between frames (chunks, the client) hold them up any more (about 120 ms an interval of 640 locally,
// 2026-10-30). A follower ahead takes the leader's ops when they come, at the leader's tick (BF.ctick.setView), and the interval's last
// tick, with the swap, only once it has them all. What would reach the followers' clusters (the clock, the rules) can't come late, so
// while an interval is open the leader holds it for the next meeting (at most MEET ticks): a slash command, waking up (the next
// morning), the monster options, the Distant villages settings, a test's eval (hold, js/simworker.js).
// API: BF.rplay = { setup({workers, cores, spawn, split, kind}), begin(world), end(why), frame(raw), flush(), hold(fn, packet) -> true when it waits for the
//   next meeting, status(), text(), follower(post) }
//   spawn(me, n) -> {post(msg), on(fn(msg)), terminate()}: a follower (server/regionthread.js, the world server's Node threads; r15-77 dropped the browser's)
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const RW = BF.rworkers;
const now = () => performance.now();
const MAX = 8;            // the most worth asking for: each follower holds a whole copy of the world (memory), and the exchange grows with more
const TRIAL = 200;        // ticks of a split trial
const BACKOFF = 2000;     // ticks before trying a split again after one that didn't pay (doubles each time, up to 16x)
const BUSY_MS = 2000;     // real ms of dropped ticks before a split is tried
const VERIFY = 6000;      // split ticks between the copies' hash checks (5 game minutes)
const LAG = 10;           // ticks a follower may be behind for the split to start, or more if replaying them takes at most LAG_MS at the leader's
const LAG_MS = 2000;      // ms a tick (soloMs): the first meeting waits while they catch up (game seconds at the speed set were far too many on a slow
                          // machine at 100x: 4000 ticks, minutes of replay before the first meeting)

// ---------------------------------------------------------------- the leader
const L = {
  want: 1, spawn: null, policy: "auto", verify: VERIFY,
  list: [], world: null, epoch: 0, ticks: 0, ready: 0, split: false, trial: null, backoff: BACKOFF, retryAt: 0,
  busySince: null, soloMs: null, plainMs: null, splitMs: null, loopT0: null, loopTicks: 0, shared: null, why: "", lastText: "",
};
const log = (l, x) => { if (BF.glog) BF.glog.log(l, "workers", x); };
const TRIAL_CLUSTERS = 400;   // ticks of a clusters' split trial (the first meetings hand over whole clusters)
const PLAIN_TICKS = 1200;     // plain ticks measured before the first clusters' split (auto)
const clustered = () => !!(BF.cworkers && BF.cworkers.active);
// The clusters split over n workers, at this point of the journal on every worker alike: the cluster tick on (every system, the tick
// order), then this one joins as cluster worker me with partial copies. verify (ticks): the copies are compared every verify / 20 meetings.
function clusterOn(sh, me, n, link, verify) {
  BF.ctick.only = null; BF.ctick.on = true; BF.ctick.order = "tick";
  BF.cworkers.verify = verify > 0 ? Math.max(1, Math.round(verify / BF.ctick.MEET)) : 0;
  BF.cworkers.setup({ n, me, link, claims: sh.claims, partial: true });
  // (an exchange between ticks, a chunk unloading with mobs in it: the leader's journal must be out first, or the followers never get
  // the op that brings them to it)
  BF.cworkers.preExchange = me === 0 ? flush : null;
}
function setup(o) {
  const cores = Math.max(1, o.cores | 0 || 2);
  L.want = o.workers > 0 ? Math.max(1, o.workers | 0) : 1;
  if (!(o.workers > 0)) L.why = "region workers start only when asked (?workers=N; " + cores + " cores here)";
  L.spawn = o.spawn || null;
  L.three = o.three || null;
  L.policy = o.split === "always" || o.split === "never" ? o.split : "auto";
  L.kind = o.kind === "clusters" ? "clusters" : "regions";   // (what a split shares: the regions' thinking each tick, or the clusters, js/cworkers.js)
  L.verify = o.verify > 0 ? o.verify | 0 : VERIFY;   // (tests: ?verify=N compares the copies every N split ticks)
  L.trail = o.verify > 0;   // (the cells' trail only when ?verify= asks: noting the calls behind every block edit cost about 0.3 ms a tick on test4, for the rest of the session)
  if (L.want > 1 && !L.spawn) { L.why = "region workers run only on the world server (./run.sh)"; L.want = 1; }
  if (L.want > 1 && typeof SharedArrayBuffer !== "function") { L.why = "no SharedArrayBuffer here"; L.want = 1; }
  return L.want;
}
// A world starts on the leader (js/simworker.js worldOp): the followers for it. world: {op: "create", seed, opts, rivers} or {op:
// "load", data, meta, rivers}, taken right after the leader made or restored it (before anything else happens to it).
function begin(world) {
  end();
  if (L.want <= 1) { if (L.why && !L.saidWhy) { L.saidWhy = true; log("INFO", "One worker: " + L.why); } return; }
  const n = L.want, epoch = ++L.epoch;
  if (!world.rivers && BF.worldgen.riverState) world.rivers = BF.worldgen.riverState();   // (the followers don't solve them again)
  world.viewDist = BF.world.viewDist;
  world.active = BF.active ? (BF.active.state ? BF.active.state() : BF.active.opts()) : null;   // (the simulation budget's state: the leader's differs from a fresh copy's, js/active.js)
  world.testEval = !!BF.testEval;
  world.coarse = BF.gameOpts ? BF.gameOpts.overridden() : null;   // (a run's ?coarse= / --coarse: js/gameopts.js)
  world.dyn = BF.dynItems ? BF.dynItems() : [];   // (map items made in earlier worlds keep their ids: the follower makes them alike)
  world.beesHooked = !!(BF.bees && BF.bees.hooked && BF.bees.hooked());
  world.player = player();   // (the look and the rest the title world left: a new world keeps them)
  world.clock = BF.simNow();   // the simulation clock goes on from world to world (js/timewarp.js): a fresh follower starts where the leader is
  world.villageSim = BF.villageSim && BF.villageSim.state ? BF.villageSim.state() : null;   // (when it last checked the simulated set: js/villagesim.js)
  BF.world.trail = L.trail ? new Map() : null;   // (tests, ?verify=: who wrote each cell, for a cell that differs: js/world.js)
  L.world = world; L.ticks = 0; L.solo = new Map(); L.diff = null; L.recent = []; L.ready = 0; L.split = false; L.trial = null; L.backoff = BACKOFF; L.retryAt = 0; L.busySince = null;
  L.soloMs = null; L.plainMs = null; L.plainTicks = 0; L.splitMs = null; L.loopT0 = null; L.loopTicks = 0;
  { const h = BF.stateHash.full(); L.hash = h.hash; L.bootParts = h.parts; L.bootText = L.verify ? texts() : null; }   // (the followers must boot the same world)
  RW.journal = []; RW.clock = null;
  RW.onTick = onTick; RW.beforeTick = beforeTick;
  L.shared = L.kind === "clusters" ? BF.cworkers.makeShared(n) : RW.makeShared(n);
  L.list = [];
  for (let me = 1; me < n; me++) {
    const f = { me, booted: false, ticks: 0, h: L.spawn(me, n) };
    f.h.on(m => onFollower(f, epoch, m));
    f.h.post({ boot: { world, me, n, verify: L.verify, trail: L.trail, three: L.three } });
    L.list.push(f);
  }
  log("INFO", "Region workers: " + n + " for this world (" + (n - 1) + " followers starting; " + (L.kind === "clusters" ? "the clusters are" : "the regions' thinking is") + " split when it pays)");
}
function onFollower(f, epoch, m) {
  if (epoch !== L.epoch) return;
  if (m.error) {
    log("ERROR", "Region worker " + f.me + " crashed: " + String(m.error).split("\n").slice(0, 6).join(" | "));
    if (L.split) { L.crashed = "region worker " + f.me + " crashed: " + String(m.error).split("\n")[0]; return; }   // (the leader's tick stops at the barrier: frame() reports it)
    end("region worker " + f.me + " crashed");
    return;
  }
  if (m.booted != null) {
    if (m.booted !== L.hash) {
      const parts = Object.keys(L.bootParts).filter(k => m.parts && L.bootParts[k] !== m.parts[k]);
      log("ERROR", "Region worker " + f.me + " booted a different world (hash " + m.booted + ", not " + L.hash + "; parts " + parts.join(", ") + ")");
      if (L.bootText && m.texts) soloText(f, { textOf: -1, texts: m.texts }, L.bootText); end("a follower's world differs"); return; }
    f.booted = true; L.ready++;
    if (L.ready === L.list.length) log("INFO", "Region workers: all " + L.list.length + " followers ready (" + L.list.map(x => L.ticks - x.ticks).join("/") + " ticks behind)");
  }
  if (m.ticks != null) f.ticks = m.ticks;
  if (m.load) f.load = m.load;   // its thread's busy share (js/threadload.js), about once a second
  if (m.hashAt != null) soloCheck(f, m);
  if (m.textOf != null) soloText(f, m);
  if (m.trail) soloTrail(f, m);
}
const texts = () => { const t = {}; for (const k of BF.stateHash.PARTS) t[k] = BF.stateHash.text(k); return t; };
function soloText(f, m, text) {
  const mine = text ? { text } : L.solo.get(m.textOf);
  if (L.diff) L.diff.told = true;
  if (!mine) return;
  for (const k in m.texts) {
    const p = mine.text[k] || "", q = m.texts[k] || "";
    if (p === q) continue;
    let i = 0; while (i < p.length && p[i] === q[i]) i++;
    log("ERROR", "Region workers out of step: worker " + f.me + ", " + k + " from character " + i + ": leader ..." + p.slice(Math.max(0, i - 300), i + 200) + " / worker " + f.me + " ..." + q.slice(Math.max(0, i - 300), i + 200));
    // block edits: who last wrote each cell that differs, here and on the follower (js/world.js trail, on with ?verify=): see onFollower
    if (k === "edits") { const cells = BF.stateHash.editsDiff(p, q); f.trailMine = BF.world.trailOf(cells); f.h.post({ trailOf: cells }); }
  }
}
function soloTrail(f, m) {
  const mine = f.trailMine || {};
  for (const c of Object.keys(m.trail)) log("ERROR", "Region workers out of step: the last writes of cell " + c + " [tick, phase, by, id]: leader " + JSON.stringify(mine[c]) + " / worker " + f.me + " " + JSON.stringify(m.trail[c]));
}
function soloCheck(f, m) {
  const mine = L.solo.get(m.hashAt);
  if (!mine || L.diff) return;
  RW.checks = (RW.checks || 0) + 1;
  const parts = Object.keys(mine.parts).filter(k => mine.parts[k] !== m.parts[k]);
  if (!parts.length) { if (L.list.every(x => x.ticks >= m.hashAt)) for (const k of [...L.solo.keys()]) if (k <= m.hashAt) L.solo.delete(k); return; }
  L.diff = { tick: m.hashAt, worker: f.me, parts, at: now(), told: false };
  log("ERROR", "Region workers out of step: worker " + f.me + "'s copy differs from the leader's in " + parts.join(", ") + " at tick " + m.hashAt + " (one thinking)");
  f.h.post({ textAt: m.hashAt, parts });
  log("ERROR", "Region workers: the journal before tick " + m.hashAt + ": " + L.recent.filter(e => e[0] >= m.hashAt - 4 && e[0] <= m.hashAt).map(e => e[0] + ":" + JSON.stringify(e[1]).slice(0, 160)).join(" | "));   // (its text of those parts, kept from then, to say where)
  RW.mismatch = { tick: m.hashAt, worker: f.me, parts };
}
function onTick() {
  L.ticks++; L.loopTicks++;
  // (tests, ?verify=: while one thinks, the followers' copies are compared too, at the start of every verify-th tick: the journal
  // brought them everything that happened since the last)
  if (L.verify && !L.split && !clustered() && L.ticks % L.verify === 0 && !L.diff) L.solo.set(L.ticks, { parts: BF.stateHash.full().parts, text: texts() });
  if (L.loopT0 == null) L.loopT0 = now();
  if (L.split || clustered()) flush();   // (lockstep, or clusters that meet: the followers need this tick now)
}
// The journal so far to every follower.
function flush() {
  const ops = RW.journal;
  if (!ops || !ops.length || !L.list.length) return;
  RW.journal = [];
  if (L.verify) { let t = L.ticks - ops.filter(o => o[0] === "t").length; for (const o of ops) { if (o[0] === "t") t++; L.recent.push([t, o]); } if (L.recent.length > 3000) L.recent.splice(0, L.recent.length - 2000); }
  for (const f of L.list) f.h.post({ ops });
}
// After each loop of the simulation worker (its ticks run): the measure, the switches, the journal out.
function frame() {
  if (!L.list.length) return;
  if (L.crashed) { const why = L.crashed; L.crashed = null; throw new Error(why); }
  const t = now(), W = BF.warp;
  if (L.loopTicks > 0 && L.loopT0 != null) {
    const ms = (t - L.loopT0) / L.loopTicks, k = Math.min(1, L.loopTicks / 50);
    if (L.split) L.splitMs = L.splitMs == null ? ms : L.splitMs + (ms - L.splitMs) * k * 0.5;
    else L.soloMs = L.soloMs == null ? ms : L.soloMs + (ms - L.soloMs) * k * 0.5;
    // (the plain tick's, kept from before the first clusters' split: after a trial the cluster tick stays on, js/rplay.js toSolo, and a
    // split must beat one thread as it plays without workers, not the cluster tick on one, which was 1.65 times slower on test4)
    if (!L.split && !(BF.ctick && BF.ctick.on)) { L.plainMs = L.plainMs == null ? ms : L.plainMs + (ms - L.plainMs) * k * 0.5; L.plainTicks += L.loopTicks; }
  }
  const dropped = W && !BF.state.paused && W.speed > 1 && W.last < W.speed * 0.9;
  L.busySince = dropped ? (L.busySince == null ? t : L.busySince) : null;
  L.loopT0 = null; L.loopTicks = 0;
  if (RW.mismatch && L.diff && !L.diff.told && t - L.diff.at < 5000) return;   // (its text of the parts that differ first: soloText)
  if (L.endAfter && !clustered()) { const e = L.endAfter; L.endAfter = false; end(e.why, e.level); return; }
  if (RW.mismatch && L.kind === "clusters" && clustered()) {   // (each worker's own clusters are current only on it: back to one whole world at the next meeting first)
    if (!L.endAfter) { log("ERROR", "Region workers: the copies no longer match (" + RW.mismatch.parts.join(", ") + " at tick " + RW.mismatch.tick + "); going on with one after the next meeting"); toSolo("the copies differ"); L.endAfter = { why: "the copies differ" }; }
    flush();
    return;
  }
  if (RW.mismatch) { log("ERROR", "Region workers: the copies no longer match (" + RW.mismatch.parts.join(", ") + " at tick " + RW.mismatch.tick + "); going on with one"); end("the copies differ"); return; }
  if (!L.split) {
    const behind = Math.max(0, ...L.list.map(f => L.ticks - f.ticks));
    const ready = L.ready === L.list.length && (behind <= LAG || (L.soloMs != null && behind * L.soloMs <= LAG_MS)) && !clustered();
    const want = L.policy === "always" || (L.policy === "auto" && L.busySince != null && t - L.busySince >= BUSY_MS && L.ticks >= L.retryAt &&
      (L.kind !== "clusters" || L.plainTicks >= PLAIN_TICKS));
    if (ready && want && L.policy !== "never") startSplit();
  } else if (L.trial && L.ticks >= L.trial.end) {
    const before = L.trial.solo, after = L.splitMs;
    L.trial = null;
    if (L.policy === "auto" && before != null && after != null && after > before * 0.9) {
      toSolo("ticks took " + after.toFixed(1) + " ms split against " + before.toFixed(1) + " ms on one: not worth it");
      if (L.kind === "clusters") L.endAfter = { why: "a split doesn't pay on this world", level: "INFO" };   // (and the cluster tick goes off with them)
      else { L.retryAt = L.ticks + L.backoff; L.backoff = Math.min(BACKOFF * 16, L.backoff * 2); }
    } else if (L.policy !== "auto") log("INFO", "Region workers: split kept (split=" + L.policy + "; " + (after != null ? after.toFixed(1) : "?") + " ms a tick split, " + (before != null ? before.toFixed(1) : "?") + " ms on one)");
    else log("INFO", "Region workers: the split pays (" + (after != null ? after.toFixed(1) : "?") + " ms a tick split, " + (before != null ? before.toFixed(1) : "?") + " ms on one): kept");
  }
  flush();
}
function startSplit() {
  const n = L.list.length + 1;
  if (L.kind === "clusters") {
    RW.rec(["csplit", L.shared, n]);
    flush();
    clusterOn(L.shared, 0, n, L.link || (L.link = RW.attach(L.shared, 0, n)), L.verify);
    L.split = true; L.splitMs = null; L.ctick = true;
    const one = L.plainMs != null ? L.plainMs : L.soloMs;
    L.trial = { end: L.ticks + TRIAL_CLUSTERS, solo: one };
    log("INFO", "Region workers: the clusters are split over " + n + " workers (ticks took " + (one != null ? one.toFixed(1) + " ms" : "?") + " on one" +
      (one !== L.soloMs && L.soloMs != null ? ", " + L.soloMs.toFixed(1) + " ms with the cluster tick" : "") + ")");
    return;
  }
  RW.rec(["split", L.shared, n]);
  flush();
  RW.verify = L.verify;
  RW.setup({ n, me: 0, link: L.link || (L.link = RW.attach(L.shared, 0, n)) });
  L.split = true; L.splitMs = null;
  L.trial = { end: L.ticks + TRIAL, solo: L.soloMs };
  log("INFO", "Region workers: the regions' thinking is split over " + n + " workers (ticks took " + (L.soloMs != null ? L.soloMs.toFixed(1) + " ms" : "?") + " on one)");
}
function toSolo(why) {
  if (L.kind === "clusters") {
    RW.rec(["csolo"]);
    flush();
    // (at the next meeting every worker takes the whole world. The cluster tick stays on while there are followers: under it each copy
    // put its own clusters' table entries and mobs first and the others' at meetings, so the copies' tables and lists are in different
    // orders, which the cluster tick never reads across clusters but the plain tick does (Gordon's 2026-10-29 run: the followers drifted
    // and were stopped). end() turns it off once the followers are gone)
    BF.cworkers.leave();
    L.split = false; L.soloMs = null;
    log("INFO", "Region workers: back to one running the clusters (" + why + ")");
    return;
  }
  RW.rec(["solo"]);
  flush();
  RW.pause();
  L.split = false; L.soloMs = null;
  log("INFO", "Region workers: back to one thinking (" + why + ")");
}
// The followers go: a new world, a crash, a difference, or the page's own end.
// level: the game log line's (an ERROR when there is a why, unless given)
function end(why, level) {
  L.epoch++;   // (anything the old followers still say is ignored)
  if (RW.active) RW.pause();
  if (clustered()) BF.cworkers.stop(why ? "the followers go: " + why : "");
  if (L.ctick && BF.ctick && BF.ctick.on) BF.ctick.on = false;   // (the clusters' split turned it on: off once no copy has to stay in step)
  L.ctick = false; L.endAfter = false;
  RW.journal = null; RW.clock = null; RW.onTick = null; RW.beforeTick = null; RW.verify = 0; RW.mismatch = null;
  release();   // (alone now: what waited for a meeting goes in at once)
  if (L.list.length) {
    for (const f of L.list) { try { f.h.post({ end: true }); } catch (e) { /* gone */ } try { f.h.terminate(); } catch (e) { /* gone */ } }
    log(level || (why ? "ERROR" : "INFO"), "Region workers stopped" + (why ? ": " + why + "; the world goes on with one" : ""));
  }
  L.list = []; L.split = false; L.link = null; L.shared = null; L.world = null; L.crashed = null;
}
function status() {
  const s = RW.active ? RW.stats() : clustered() ? BF.cworkers.stats() : null;
  return { want: L.want, followers: L.list.length, ready: L.ready, split: L.split, policy: L.policy, ticks: L.ticks,
    behind: L.list.map(f => L.ticks - f.ticks), loads: L.list.map(f => f.load || null), soloMs: L.soloMs, splitMs: L.splitMs, why: L.why || null, stats: s };
}
// The F3 / debug screen line.
function text() {
  if (L.want <= 1) return "Workers 1" + (L.why ? " (" + L.why + ")" : "");
  if (!L.list.length) return "Workers " + L.want + " (none for this world)";
  if (L.split) return L.kind === "clusters" ? BF.cworkers.text() : RW.text();
  const f1 = v => (v == null ? "?" : v.toFixed(1));
  return "Workers " + (L.list.length + 1) + ": one thinks (" + L.ready + "/" + L.list.length + " followers ready, " + Math.max(0, ...L.list.map(f => L.ticks - f.ticks)) + " ticks behind; " +
    f1(L.soloMs) + " ms a tick" + (L.policy === "auto" ? (L.retryAt > L.ticks ? ", split again in " + (L.retryAt - L.ticks) + " ticks" : ", splits when ticks drop") : L.policy === "never" ? ", never splits" : "") + ")";
}

// ---------------------------------------------------------------- the player, as a packet left it
// The protocol host keeps its own idea of where the client has the player (js/protocol.js playerIn: a move made here wins for a while, by
// the wall clock), so the leader's journal carries the player as each packet left it, and a follower puts its player the same.
function player() {
  const P = BF.player, p = P.position;
  return [p.x, p.y, p.z, P.yaw, P.pitch, !!P.flying, P.gameMode, P.health, P.hunger, P.saturation, !!P.dead, BF.inventory ? BF.inventory.selectedIndex : 0];
}
function setPlayer(a) {
  const P = BF.player;
  P.position.set(a[0], a[1], a[2]);
  if (P.setLook && (P.yaw !== a[3] || P.pitch !== a[4])) P.setLook(a[3], a[4]);
  if (P.setFlying && !!P.flying !== a[5]) P.setFlying(a[5]);
  if (P.setGameMode && P.gameMode !== a[6]) P.setGameMode(a[6]);
  P.health = a[7]; P.hunger = a[8]; if (a[9] !== undefined) P.saturation = a[9]; P.dead = a[10];
  if (BF.inventory && BF.inventory.selectedIndex !== a[11]) BF.inventory.select(a[11]);
}

// ---------------------------------------------------------------- holding for the meeting (running ahead)
// The client's packets that reach every cluster: the monster options, a slash command, waking up (moves the clock on), a test's eval
const GLOBAL = /^\{"t":"(?:meta"|request","rid":\d+,"tick":[^,]*,"kind":"(?:command|player\.wake)"|query","qid":\d+,"what":"eval")/;
let held = [];
// (js/simworker.js) true when fn waits for the next meeting: d, a packet that reaches every cluster, or with no packet (the Distant
// villages settings) anything, while an interval is open
function hold(fn, d) {
  if (!(BF.cworkers && BF.cworkers.open) || (d && !GLOBAL.test(d.h))) return false;
  held.push(fn);
  return true;
}
const release = () => { for (const fn of held.splice(0)) fn(); };
// RW.beforeTick, before each tick's "t" on the leader: what waited goes in first (the swap is over: the followers are with the leader
// again), then a tick that meets opens the next interval, when it fast-forwards
function beforeTick() {
  if (held.length && !(BF.cworkers && BF.cworkers.open)) release();
  if (L.split && clustered() && BF.rand.tick % BF.ctick.MEET === 0 && BF.warp.speed > 1 && !BF.state.paused) { RW.rec(["open"]); BF.cworkers.open = true; }
}

// ---------------------------------------------------------------- a follower
// follower(post) -> the message handler: {boot: {world, me, n, verify, trail}}, {ops: [...]}, {end}. Answers {booted: hash}, {ticks: n} after each
// batch, {error} (and stops the barrier, so a split tick on the leader fails at once rather than waiting).
function follower(post) {
  let me = 0, n = 1, ticks = 0, host = null, link = null, verify = 0, trail = false;
  const kept = new Map();   // (tests) the texts of the copy at the last few solo checks
  // running ahead: ahead, the ticks run before the leader's "t" for them came; views, this interval's clock after each tick; h, a tick's length
  let ahead = 0, h = null;
  const views = new Map();
  const K = () => BF.ctick, CWk = () => BF.cworkers;
  const MEETk = () => K().MEET;
  // another tick of its own clusters before the leader's: in an open interval, short of its last tick (that one swaps: it waits for all the leader's ops first)
  const canRunAhead = () => h != null && CWk() && CWk().open && BF.rand.tick % MEETk() !== 0 && BF.rand.tick % MEETk() !== MEETk() - 1;
  function runAhead() { BF.simStep(h); ahead++; views.set(BF.rand.tick, K().view()); }
  const op = o => {
    // (an op the leader journaled at its tick, behind this one's: taken at the leader's clock, then this one's back)
    if (ahead > 0 && o[0] !== "t") {
      const mine = BF.rand.tick, at = views.get(mine - ahead);
      K().setView(at);
      try { op1(o); } finally { K().setView(views.get(mine)); }
      return;
    }
    op1(o);
  };
  const op1 = o => {
    switch (o[0]) {
      case "t":
        if (ahead > 0) { ahead--; RW.clock = o[2]; ticks++; break; }   // (run already)
        if (verify && !RW.active && !clustered() && (ticks + 1) % verify === 0) {   // (tests: the leader compares, js/rplay.js soloCheck)
          kept.set(ticks + 1, texts()); if (kept.size > Math.max(32, Math.ceil(400 / verify))) kept.delete(kept.keys().next().value);
          post({ hashAt: ticks + 1, parts: BF.stateHash.full().parts });
        }
        RW.clock = o[2]; BF.simStep((h = o[1])); ticks++;
        if (CWk() && CWk().open) views.set(BF.rand.tick, K().view());
        break;
      case "open": CWk().open = true; views.clear(); break;   // (the leader's meeting tick follows: then this one may run ahead)
      case "p": host.receive(o[1]);   /* (queries too: answering F3 or the debug screen works out things lazily that the world keeps, a poultry keeper's task state with a roll of its own) */ if (o[2]) setPlayer(o[2]); break;
      case "c": BF.world.replay.create(o[1], o[2]); break;
      case "ug": BF.world.replay.drops(o[1]); break;
      case "d": BF.world.replay.extendDown(o[1], o[2], o[3]); break;
      case "v": RW.clock = o[3]; BF.villageSim.update(o[1], o[2]); break;
      case "a": if (BF.active) BF.active.frame(o[1], o[2]); break;
      case "b": if (BF.active) BF.active.set(o[1], true); if (o.length > 2 && BF.gameOpts) BF.gameOpts.override(o[2]); break;   // (the player changed the distant-village settings: the leader's simworker.js journals them)
      case "f": BF.inventory.simFrame(o[1]); BF.maps.simFrame(); BF.player.simRide(o[1]); break;
      case "s": BF.save.snapshot(); break;
      case "feed": if (BF.debugFeed && BF.debugFeed.ack) BF.debugFeed.ack(o[1]); break;   // (the world server's debug screen: only what the server answered, how many screens watch. Reading the feed changes nothing (test/feed-pure.js), so the followers don't read it: about 35 ms each time, 2026-10-30)
      case "split": RW.verify = verify; RW.setup({ n: o[2], me, link: link || (link = RW.attach(o[1], me, o[2])) }); break;
      case "solo": RW.pause(); break;
      case "csplit": clusterOn(o[1], me, o[2], link || (link = RW.attach(o[1], me, o[2])), verify); break;
      case "csolo": BF.cworkers.leave(); break;
      case "sm": BF.cworkers.whenMet(ok => { if (ok) BF.cworkers.gathered(() => BF.save.snapshot({ quiet: true })); }); break;   // (a save at the next meeting, js/save.js)
      case "crash": if (o[1] === me) throw new Error("a test crash (test/multi-worker-play.js)"); break;
      default: throw new Error("region worker: unknown journal op " + o[0]);
    }
  };
  const fail = e => {
    const text = String(e && e.stack || e);
    try { if (link) link.stop(me); } catch (_) { /* already */ }
    post({ error: text });
  };
  // Messages are taken in order through a queue: a test's eval packet (BFT.sim) runs its function a microtask after the packet, on the
  // leader before anything else happens, so here the ops after it wait a turn of the event loop too.
  const queue = [];
  let busy = false, loadT = 0;
  const TL = BF.tload || { begin() {}, end() {}, report: () => null, SAMPLE: 1000 };   // (this thread's busy share for the debug screen)
  const EVAL = /^\{"t":"query","qid":\d+,"what":"eval"/;
  // (between ticks run ahead, a turn of the event loop: the leader's ops that came meanwhile go first)
  const soon = typeof setImmediate === "function" ? setImmediate : fn => setTimeout(fn, 0);
  async function pump() {
    if (busy) return;
    busy = true;
    TL.begin();
    let again = false;
    try {
      while (queue.length) {
        const d = queue.shift();
        if (d.boot) boot(d.boot);
        else if (d.ops) {
          for (const o of d.ops) {
            op(o);
            if (o[0] === "p" && EVAL.test(o[1].h)) { TL.end(); await new Promise(r => setTimeout(r, 0)); TL.begin(); }
          }
          BF.proto.flush();
          const t = now();
          if (t - loadT >= TL.SAMPLE) { loadT = t; post({ ticks, load: TL.report() }); }
          else post({ ticks });
        } else if (d.textAt != null) { const t = kept.get(d.textAt); if (t) { const o = {}; for (const k of d.parts) o[k] = t[k]; post({ textOf: d.textAt, texts: o }); } }
        else if (d.trailOf) post({ trail: BF.world.trailOf(d.trailOf) });
        else if (d.end) { if (RW.active) RW.pause(); if (clustered()) BF.cworkers.stop(); queue.length = 0; }
      }
      if (canRunAhead()) { runAhead(); again = true; }
    } catch (e) { queue.length = 0; fail(e); }
    TL.end();
    busy = false;
    if (again) soon(pump);
  }
  function boot(b) {
    const w = b.world;
    me = b.me; n = b.n; verify = b.verify || 0; trail = !!b.trail;
    BF.glog.setSink(null);
    BF.boot.initSim();
    if (w.rivers) {
      BF.worldgen.init(BF.makeNoise((w.op === "load" ? w.data.seed : w.seed) >>> 0), { biomeScale: +String(w.rivers.seed).split(":")[1] || 1, villages: 10 });
      BF.worldgen.adoptRivers(w.rivers);
    }
    BF.prepareWorld = () => Promise.resolve();
    if (w.testEval) BF.testEval = true;   // (the leader runs tests' functions: so does every copy, js/protocol.js eval)
    if (w.clock) BF.warp.advance(w.clock - BF.simNow());
    for (const [name, id] of w.dyn || []) BF.dynItemAs(name, id);
    if (w.viewDist > 0) BF.world.setViewDist(w.viewDist);
    if (w.active && BF.active) BF.active.set(w.active.opt || w.active);
    if (BF.gameOpts) BF.gameOpts.override(w.coarse);
    if (w.beesHooked && BF.bees && BF.bees.hook) BF.bees.hook();   // (homes found as chunks load, as the leader does after an earlier world)
    if (w.op === "load") BF.save.restore(w.data, w.meta);
    else BF.newWorld(w.seed, w.opts || {});
    if (w.player) setPlayer(w.player);
    if (w.active && w.active.opt && BF.active && BF.active.load) BF.active.load(w.active);   // (after the world: starting it resets the budget's state)
    if (w.villageSim && BF.villageSim && BF.villageSim.load) BF.villageSim.load(w.villageSim);   // (after the world too)
    BF.world.trail = trail ? new Map() : null;   // (tests: who wrote each cell, as on the leader)
    // a protocol host whose output goes nowhere: the client's packets do here what they did on the leader
    host = BF.proto.host(() => {}, { replica: true, follower: true, world: () => new Promise(() => {}), onView: v => { if (v.dist > 0 && v.dist !== BF.world.viewDist) BF.world.setViewDist(v.dist); } });
    { const h = BF.stateHash.full(); post({ booted: h.hash, parts: h.parts, texts: verify ? texts() : null }); }
  }
  return d => { queue.push(d); pump(); };
}

// (tests) follower me throws at this point of the journal: the crash path
const testCrash = me => { RW.rec(["crash", me | 0]); flush(); };
// (tests) back to one now (split=always splits again once the followers are ready)
const testSolo = () => { if (L.split) toSolo("a test"); };

BF.rplay = { setup, begin, end, frame, flush, hold, status, text, follower, player, testCrash, testSolo, MAX, TRIAL, VERIFY };
})();
