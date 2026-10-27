// Cluster tick (spec r15-39b, item C1). With BF.ctick.on, the simulation runs by clusters (js/clusters.js): groups of villages and the
// land round them that don't affect each other between meetings, which come every MEET ticks (one game second). Off by default: the
// game ticks as before (js/boot.js simStep) until the systems are converted (items C2-C6) and the workers that use it exist (C7).
//   a tick      the global part once (the clock, the tick counter, the sky and weather), then the scoped part once per group (mobs,
//               day timelines, drops, boats, furnaces, the think hooks, apply, block ticks, deliver), each with the group's own context;
//   contexts    per group: its requests (queue, inboxes, results, sequence: js/requests.js), the ranges its new mob ids and creation
//               numbers come from (js/ids.js, js/rand.js range: handed out at each meeting, so they don't depend on the order groups run
//               in), and the repeats of this tick's random keys (js/rand.js reps);
//   seeing      while a converted system runs for a group, BF.ids.get and the region index's queries (js/regions.js) don't see other
//               groups' mobs: to the group they are gone, in every order and on every worker alike;
//   requests    a request aimed at another group (its target mob's cluster, else the target cell's region's) waits for the next meeting;
//               one sent between ticks goes straight to its target's group;
//   meetings    every MEET ticks (the tick counter a multiple of MEET), before the tick: the clusters are worked out again
//               (BF.clusters.rebuild), the requests still queued are filed again by target into the new groups, the requests that
//               waited for the meeting apply (one list, in requester order) and their results are delivered, and each group gets its id
//               ranges. The requests that cross carry their sender's tick and a due tick (the meeting's) and apply by due tick, then
//               sending cluster, then sending order.
//   clocks      each cluster keeps its own tick (BF.ctick.tickOf). For now every loaded cluster keeps one clock, and a meeting that finds
//               one on another tick logs an ERROR; a later spec may let a cluster nobody watches run behind (idea 3, not turned on).
// Two orders give the same world when no system reads across groups (test/cluster-isolation.js checks it):
//   "tick"      every group each tick (the game's order, and how one worker runs several groups);
//   "cluster"   a whole interval group by group: the global part runs the interval's ticks first, keeping what each tick's clock read
//               (a view), and each group then runs its ticks on those views. What the multi-worker runtime (C7) does, one group per worker.
// Systems: each system of the scoped part runs through sys(name, fn). A converted system (SYSTEMS[name] true) runs once per group and
// filters its own loops to the group (BF.ctick.filter); one not converted yet runs once a tick, in the first group's pass, seeing the
// whole world as before. The isolation test names the parts that differ, so the threads converting them see what is left.
// F3 and the debug screen: groups, mobs per group, ms per group, requests that waited for a meeting. Game log: INFO when it is turned on
// or off, INFO "clusters" once a game hour while the debug overlay or debug screen is on, ERROR when a group's pass throws.
// API: BF.ctick = { MEET, on (get / set), order (get / set: "tick" | "cluster"), cur (the running group), filter (the running group's
//                   mob test, or null when every mob is seen), mobs() (the running group's mobs, removed ones included, or null as filter),
//                   added(m), stale(), epoch, mine(m), hidden(o), sys(name, fn), local(name, init), step(h), interval(h),
//                   meet(), groups(), SYSTEMS, converted() -> [names], only (a Set of system names, or null: all), system (the running one),
//                   trace, traced() -> [["system file:line", count]], owned(name, {snap, apply}), ownedMap(name, map, groupOfKey, enc, dec, ver), ownedSet(name, set, groupOfKey),
//                   ofVillage(key), ofCell(x, z), ofMob(m), mineVillage(key), mineCell(x, z), tables(), table(name), onMeet(fn, name, when), tickOf(base), clocks() -> Map base -> tick, stats(), text(), hourly(),
//                   reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const MEET = 20;       // ticks between meetings (js/clusters.js MEET)
const RANGE = 256;     // ids (and creation numbers) in one range
const DYN_RANGE = 4;   // dynamic item ids (map items, js/blocks.js) in one range: rare, and the item list skips the unused ones
const HOUR = 1200 / 24;

// The scoped part's systems: the item that converts each, and whether it runs per group yet (one per line: the threads converting them
// each change their own lines). Names are those given at the call sites (js/mobs.js update, js/boot.js, js/world.js hooks, js/bees.js).
const SYSTEMS = {
  mobloop: true,        // C1: the think loop, A* grants, separation grid, positions kept for drawing (js/mobs.js update)
  arrows: true,         // C2: mobs core and wild
  spawn: true,          // C2
  wildlife: true,       // C2
  despawn: true,        // C2
  aiTick: true,         // C2
  mobSave: true,        // C2
  drops: true,          // C2
  boats: true,          // C2
  builder: true,        // C3: village systems
  villageLife: true,    // C3
  jobs: true,           // C3
  breeding: true,       // C3
  storage: true,        // C3
  baker: true,          // C3
  explorer: true,       // C3 (explorers' tents left camping, js/explorer.js)
  restock: true,        // C3
  villages: true,       // C3 (js/mobs.js updateVillages: village records come and go)
  dayTimeline: true,    // C3
  vstats: true,         // C3 (village stats and economy, js/villagelog.js)
  forester: true,       // C3
  signs: true,          // C3
  shepherd: true,       // C4: animals
  horses: true,         // C4
  stables: true,        // C4
  poultry: true,        // C4
  cowherd: true,        // C4
  pigFarmer: true,      // C4
  bees: true,           // C4
  merchant: true,       // C5: merchants and caravans
  villageSim: true,     // C5 (which villages are simulated, trip pins: js/villagesim.js)
  fluids: true,         // C6: world
  growth: true,         // C6
  farmland: true,       // C6
  grass: true,          // C6
  saplings: true,       // C6
  catchUp: true,        // C6
  furnaces: true,       // C6 (the furnaces' block tick, js/playerinv.js)
  furnaceClock: true,   // C6 (furnaces' and ovens' game time, js/playerinv.js simTick)
};

let on = false, order = "tick";
let cur = null, legacy = false;
let groups = [], byKey = new Map();
let between = null;               // the contexts between ticks (and at meetings): a slot of its own, after the groups'
let deferred = [];                // requests for another group, applied at the next meeting
let needMeet = true;
const NOWHERE = { key: null };    // the target of a request for a cluster no group runs this interval
const S = { meetings: 0, deferred: 0, refiled: 0, ticks: 0, lastDeferred: 0, ms: new Map(), err: 0 };
const H = { ticks: 0, deferred: 0, meetings: 0 };
let hourAt = null;

const CL = () => BF.clusters;
const W = () => (BF.cworkers && BF.cworkers.active ? BF.cworkers : null);   // several workers (C7, js/cworkers.js)
const groupOfBase = b => byKey.get(CL().groupOf(b)) || NOWHERE;
// m is the running group's (a mob with no cluster yet goes with the first group)
function mine(m) { return m.cl === undefined ? cur === groups[0] : CL().groupOf(m.cl) === cur.key; }
// o belongs to another group than the running one (BF.ids.hidden while a converted system runs)
function hidden(o) { return o.cl !== undefined && cur !== null && !legacy && CL().groupOf(o.cl) !== cur.key; }
// Each group's mobs, so a converted system's loops over mobs read only the running group's (BF.ctick.mobs) instead of testing every mob
// in the world with mine (that cost every group a pass over all mobs, several times a tick). A mob's cluster changes only at meetings
// and when it is made (js/clusters.js place), so the lists are made at the first use after a meeting, in BF.mobs.list order, and a new
// mob goes at the end of its group's (BF.mobs.added), as it does in BF.mobs.list. Removed mobs stay in until the next meeting: skip them.
let lists = null, epoch = 0;   // (epoch: counts the times the lists went out of date: other modules key their own lists by group on it, js/bees.js)
const NONE = [];
const groupKeyOf = m => (m.cl === undefined ? (groups[0] ? groups[0].key : null) : CL().groupOf(m.cl));
function mobLists() {
  if (lists) return lists;
  lists = new Map();
  for (const m of BF.mobs.list) { const k = groupKeyOf(m); const a = lists.get(k); if (a) a.push(m); else lists.set(k, [m]); }
  return lists;
}
// the running group's mobs (removed ones included), or null when every mob is seen (as filter)
function mobs() { return cur && !legacy ? mobLists().get(cur.key) || NONE : null; }
function added(m) { if (!lists) return; const k = groupKeyOf(m), a = lists.get(k); if (a) a.push(m); else lists.set(k, [m]); }
const stale = () => { lists = null; epoch++; };

// ---------------------------------------------------------------- id and creation-number ranges
// At a meeting, range j of slot i (the groups, then the between-ticks slot) is [h + (j * n + i) * RANGE, + RANGE), n = groups + 1; the
// next meeting starts past the last range any slot took (and past any id seen meanwhile).
// Dynamic items (dyn) move on only past a meeting where one was made, so the item ids stay close together.
const R2 = { ids: { h: 0, j: 0, n: 1 }, made: { h: 0, j: 0, n: 1 }, dyn: { h: 0, j: 0, n: 1 } };
function rangeOf(kind, i) {
  const k = R2[kind], size = kind === "dyn" ? DYN_RANGE : RANGE;
  let j = 0;
  const at = jj => k.h + (jj * k.n + i) * size;
  const more = () => { j++; if (j > k.j) k.j = j; const a = at(j); return [a, a + size]; };
  return { next: at(0), lim: at(0) + size, more };
}
function newRanges(n) {
  for (const kind of ["ids", "made"]) {
    const k = R2[kind], top = kind === "ids" ? BF.ids.range.top : BF.rand.made + 1;
    k.h = Math.max(k.h + (k.j + 1) * k.n * RANGE, top);
    k.j = 0; k.n = n;
  }
  const d = R2.dyn, top = BF.dynRange.top;
  if (top > d.h) d.h = Math.max(d.h + (d.j + 1) * d.n * DYN_RANGE, top);
  d.j = 0; d.n = n;
}
function startRanges() {
  R2.ids.h = BF.ids.range.top; R2.made.h = BF.rand.made + 1; R2.dyn.h = BF.dynRange.top;
  for (const k of [R2.ids, R2.made, R2.dyn]) { k.j = 0; k.n = 1; }
}

// ---------------------------------------------------------------- contexts
function slot(key, i, g) {
  return Object.assign(g || { key }, { i, req: BF.req.newCtx(), ids: rangeOf("ids", i), made: rangeOf("made", i), dyn: Object.assign(rangeOf("dyn", i), { i }), reps: { tick: -1, map: new Map() }, ms: 0, sent: 0, locals: new Map() });
}
function useSlot(s) { BF.req.useCtx(s.req); BF.ids.range.set(s.ids); BF.rand.range.set(s.made); BF.dynRange.set(s.dyn); BF.rand.reps.set(s.reps); }
function keepSlot(s) { s.req = BF.req.ctx(); s.ids = BF.ids.range.get(); s.made = BF.rand.range.get(); s.dyn = BF.dynRange.get(); s.reps = BF.rand.reps.get(); }
function enter(g) { keepSlot(between); cur = g; useSlot(g); BF.ids.hidden = hider(); }
function leave() { if (!cur) return; keepSlot(cur); cur = null; BF.ids.hidden = null; useSlot(between); }

// ---------------------------------------------------------------- requests across groups
function targetOf(req, k) {
  const t = req.target;
  if (typeof t === "string" && t.charCodeAt(0) === 101 && /^e\d+$/.test(t)) { const m = BF.ids.live(t); if (m && m.cl !== undefined) return groupOfBase(m.cl); }
  if (k >= 0) return groupOfBase(CL().ofRegion(k));
  return null;
}
// BF.req.away: true when the request doesn't go in the context in use
function away(req, k) {
  if (!on || !groups.length) return false;
  const g = targetOf(req, k);
  if (cur) {
    if (!g || g === cur) return false;
    // stamped with the sending cluster's tick and the tick it is due (the next meeting's: at most MEET later, the lookahead), and
    // numbered in its group's sending order, so the order they apply in doesn't depend on the order groups ran in
    req._from = cur.key; req._n = cur.sent++; req._at = BF.rand.tick; req._due = Math.ceil(BF.rand.tick / MEET) * MEET;
    deferred.push(req); S.deferred++; H.deferred++;
    // its callbacks (req.then) live only where it was sent: on several workers (C7) the meeting may run elsewhere. A crossing request
    // must carry what it needs in its data and use its kind's onResult. Logged once per kind (thrown under BF.req.strict).
    closures(req);
    return true;
  }
  if (!g || g === NOWHERE) return false;
  BF.req.fileIn(g.req, req);
  return true;
}
// A crossing request that has (or gets) req.then callbacks: noted, once per kind
const closureKinds = new Set();
function closures(req) {
  const note = () => {
    S.closures = (S.closures || 0) + 1;
    if (BF.req.strict) throw new Error("request " + req.kind + " to another cluster has callbacks (req.then): use its kind's onResult (js/ctick.js)");
    if (!closureKinds.has(req.kind)) { closureKinds.add(req.kind); if (BF.glog) BF.glog.log("ERROR", "clusters", "Request " + req.kind + " from " + (req.from || "nobody") + " to another cluster has callbacks (req.then), which several workers can't carry: give its kind an onResult"); }
  };
  if (req.cbs) { note(); return; }
  const then = req.then;   // (then() is usually chained right after send(): catch it when it comes)
  req.then = fn => { if (req._due !== undefined && !req.delivered) { req.then = then; note(); } return then(fn); };
}

// The mobs a request that waited for the meeting may read or change: its requester, its target mob, the mobs its data names, and the
// mobs in its target region (a blast's part there, js/mobs.js explode)
function involved(list) {
  const out = [], regs = new Set(), isMob = x => x && typeof x === "object" && x.id !== undefined && BF.ids.live(x.id) === x && BF.mobs.list.includes(x);
  for (const r of list) {
    for (const id of [r.from, r.target]) if (typeof id === "string" && /^e\d+$/.test(id)) { const m = BF.ids.live(id); if (m) out.push(m); }
    const d = r.data;
    if (d && typeof d === "object") for (const k of Object.keys(d)) if (isMob(d[k])) out.push(d[k]);
    if (r.region != null && r.region >= 0) regs.add(r.region);
  }
  if (regs.size && BF.regions) for (const m of BF.mobs.list) if (!m.removed && regs.has(BF.regions.keyOf(m.position.x, 0, m.position.z))) out.push(m);
  return out;
}
// a request still queued at a meeting, into its new group (no place: its requester's group; neither: between ticks)
function refile(req) {
  let g = targetOf(req, req.region != null ? req.region : -1);
  if (!g && req.from != null) { const m = BF.ids.live(req.from); if (m && m.cl !== undefined) g = groupOfBase(m.cl); }
  BF.req.fileIn(g && g !== NOWHERE ? g.req : between.req, req);
  S.refiled++;
}

// ---------------------------------------------------------------- the meeting
// Each cluster's own tick (idea 3 of notes/sim-scaling-fable-ideas.md, Gordon 2026-10-26: built in, not used yet): the tick its last
// pass reached. Every loaded cluster keeps one clock for now (the whole loaded world moves at one speed), so at a meeting they all read
// the meeting's tick; the requests that cross carry their sender's tick and their due tick, so a later spec can let a cluster nobody
// watches run behind without changing the meeting.
const clocks = new Map();   // base cluster -> tick
function meet() {
  const t0 = performance.now();
  leave();
  // every cluster that ran must have reached the meeting's tick (one clock)
  let behind = 0, eg = null;
  for (const g of groups) if (g.bases && g.tick !== undefined && g.tick !== BF.rand.tick) { behind++; eg = eg || g.key + " at tick " + g.tick; }
  if (behind && BF.glog) BF.glog.log("ERROR", "clusters", behind + " cluster group(s) reached the meeting at tick " + BF.rand.tick + " on another clock (" + eg + ")");
  meetHooksRun("start");   // (before the queued requests are gathered: what a hook sends is filed into the new groups with them)
  const pending = [];
  for (const g of groups) { useSlot(g); for (const r of BF.req.pending()) pending.push(r); }
  if (between) { useSlot(between); for (const r of BF.req.pending()) pending.push(r); }
  CL().rebuild();
  stale();
  const list = CL().groups();
  BF.dynRange.settle();   // (the map items the groups made: one id under each name)
  newRanges(list.length + 1);
  groups = list.map((g, i) => slot(g.key, i, { key: g.key, bases: g.bases, player: g.player }));
  if (!groups.length) groups = [slot("w:none", 0)];   // (nothing anywhere: the block ticks still run, in a group of their own)
  byKey = new Map(groups.map(g => [g.key, g]));
  between = slot("between", groups.length);
  useSlot(between);
  for (const r of pending) refile(r);
  // the requests that waited: one list in requester order, applied and delivered now; what they send goes to its target's group
  // the requests due now (by due tick, then sending cluster, then sending order), each due tick's batch in requester order
  const T = BF.rand.tick, by = (a, b) => a._due - b._due || (a._from < b._from ? -1 : a._from > b._from ? 1 : 0) || a._n - b._n;
  const waited = deferred.filter(r => r._due <= T).sort(by);
  deferred = deferred.filter(r => r._due > T);   // (none while every cluster keeps one clock)
  S.lastDeferred = waited.length;
  if (waited.length && W() && W().fetch) W().fetch(involved(waited));   // (partial copies: what they read and change, current here)
  for (let i = 0; i < waited.length;) {
    let j = i; while (j < waited.length && waited[j]._due === waited[i]._due) j++;
    const keep = BF.req.ctx();
    BF.req.useCtx(BF.req.newCtx(waited.slice(i, j)));
    try { BF.req.apply(); BF.req.deliver(); }
    finally { const left = BF.req.pending(); BF.req.useCtx(keep); between.req = keep; for (const r of left) refile(r); }
    i = j;
  }
  meetHooksRun("end");
  needMeet = false;
  if (W()) W().met(groups);   // (which worker runs each group, and what each worker sends at the next meeting)
  S.meetings++; H.meetings++; S.since = 0;
  S.meetMs = performance.now() - t0;
}

// ---------------------------------------------------------------- the tick
const sky = () => BF.sky, wx = () => BF.weather;
function global(h) {
  BF.warp.advance(h);
  BF.rand.step();   // the tick that keys world-event rolls (js/rand.js)
  BF.req.beginTick();
  BF.state.time += h;
  BF.sky.advance(h);   // the clock, weather and light
}
// what a tick's clock reads: the simulation clock, the tick counter, game time, the sky and the weather
function view() {
  const s = sky(), w = wx();
  return [BF.warp.clock, BF.rand.tick, BF.state.time, s.time, s.day, s.light, w ? w.type : null, w ? w.remaining : 0, w ? w.intensity : 0, w ? w.thunder : 0, w ? w.flash : 0];
}
function setView(v) {
  const s = sky(), w = wx();
  BF.warp.clock = v[0]; BF.rand.tick = v[1]; BF.state.time = v[2]; s.time = v[3]; s.day = v[4]; s.light = v[5];
  if (w) { w.type = v[6]; w.remaining = v[7]; w.intensity = v[8]; w.thunder = v[9]; w.flash = v[10]; }
}
function scoped(h) {
  BF.req.think();
  BF.mobs.update(h);
  if (BF.dayTimeline) sys("dayTimeline", () => BF.dayTimeline.update());   // villagers' day timelines (js/daytimeline.js)
  sys("drops", () => BF.drops.update(h));
  sys("boats", () => BF.boats.update(h));
  if (BF.inventory.simTick) sys("furnaceClock", () => BF.inventory.simTick(h));
  BF.world.tickParts.think();
  BF.world.tickParts.apply();
  if (BF.regions) BF.regions.tick(mobs());   // (the running group's mobs: no other moved in its pass)
}
function pass(g, h) {
  if (W() && !W().pull && !W().owns(g)) { g.tick = BF.rand.tick; if (g.bases) for (const b of g.bases) clocks.set(b, g.tick); return; }   // (another worker runs it)
  const t0 = performance.now();
  enter(g);
  try { scoped(h); }
  catch (e) { S.err++; if (S.err <= 20 && BF.glog) BF.glog.log("ERROR", "clusters", "Cluster " + g.key + " failed a tick: " + (e && e.message || e)); console.error(e); }
  finally {
    leave(); g.ms += performance.now() - t0;
    g.tick = BF.rand.tick;
    if (g.bases) for (const b of g.bases) clocks.set(b, g.tick);
  }
}
// The interval's end: the shared table's rows worked out (js/sharedtable.js collect: on several workers each its own villages', in
// js/cworkers.js sync), then the workers swap
function endInterval() {
  if (BF.sharedTable && BF.sharedTable.collect && !(W() && W().active)) BF.sharedTable.collect();
  if (W()) W().sync();
}
const due = () => needMeet || BF.rand.tick % MEET === 0 && S.metAt !== BF.rand.tick;
function meetNow() { meet(); S.metAt = BF.rand.tick; if (warming && groups.length) { warming = false; for (const fn of warmers) fn(); } }
// One tick, every group in turn (the "tick" order; BF.simStep with the cluster tick on).
let ahead = 0;
function step(h) {
  if (W() && W().pull) {   // (the cluster order on several workers: the interval runs at its first step, the next MEET - 1 steps are done)
    if (ahead > 0) { ahead--; return; }
    if (BF.rand.tick % MEET === 0) { interval(h); ahead = MEET - 1; return; }
  }
  if (due()) meetNow();
  global(h);
  if (BF.regions) BF.regions.tick();   // (what moved between ticks; each pass then keeps its own group's mobs, js/regions.js tick(some))
  for (const g of groups) pass(g, h);
  BF.req.endTick();
  S.ticks++; H.ticks++; S.since++;
  hourly();
  if (BF.rand.tick % MEET === 0) endInterval();   // (the interval's last tick: the workers swap what their clusters changed)
}
// MEET ticks, from the next meeting: in the "tick" order MEET steps; in the "cluster" order the global part first, then each group's
// whole interval on the clock views. Returns the ticks run.
function interval(h) {
  let n = 0;
  while (BF.rand.tick % MEET !== 0) { step(h); n++; }
  if (order === "tick") { for (let t = 0; t < MEET; t++) step(h); return n + MEET; }
  if (due()) meetNow();
  if (BF.regions) BF.regions.tick();   // (what moved between ticks, as step)
  const views = [];
  for (let t = 0; t < MEET; t++) { global(h); views.push(view()); }
  // every group in turn; on several workers each takes the next group from the shared queue when it is free (js/cworkers.js claim)
  const pull = W() && W().pull;
  for (let i = 0, g; (g = pull ? W().claim() : groups[i]); i++) for (let t = 0; t < MEET; t++) { setView(views[t]); pass(g, h); }
  if (pull) for (const g of groups) if (g.tick !== views[MEET - 1][1]) { g.tick = views[MEET - 1][1]; if (g.bases) for (const b of g.bases) clocks.set(b, g.tick); }   // (another worker ran it)
  for (let t = 0; t < MEET; t++) { setView(views[t]); BF.req.endTick(); S.ticks++; H.ticks++; S.since++; hourly(); }
  endInterval();
  return n + MEET;
}

// A system of the scoped part: per group once converted, else once a tick in the first group's pass, seeing every group. With only
// set (a Set of names: test/cluster-isolation.js profiles), the systems not in it don't run at all, in either order.
let running = "mobloop";
function sys(name, fn) {
  if (only && !only.has(name)) return undefined;
  const was = running;
  running = name;
  try {
    if (SYSTEMS[name] === true || !cur) return fn();
    if (cur !== groups[0]) return undefined;
    const wl = legacy;
    legacy = true;
    try { return fn(); } finally { legacy = wl; }
  } finally { running = was; }
}
let only = null;

// A converted system's module state that must be the running group's own (timers, accumulators, cursors, counters): local(name, init)
// -> the running group's instance (made by init() the first time), or the one outside groups when none runs. A group's are new at each
// meeting, so keep only what lasts an interval there (what must last longer goes on mobs or village records).
const outside = new Map();
function local(name, init) {
  const m = cur ? cur.locals : outside;
  let v = m.get(name);
  if (v === undefined) { v = init(); m.set(name, v); }
  return v;
}

// Module tables that last longer than an interval and aren't on a mob or village record (claims, records keyed by village, a cell's
// stamps): each registers how to take the part a group owns and put it back, so the multi-worker runtime (C7) can send it at meetings.
// owned(name, {snap(groupKey, all?) -> plain JSON, apply(groupKey, plain)}); tables() -> the registered names. Unused on one worker.
const tables = new Map();
// warm(fn): a system's set-up (its owned tables, listeners, chunk scans) that it otherwise does at its first tick. With the cluster tick
// on, every system sets up at the first meeting with groups, on one worker as on several (js/cworkers.js), so a worker that hasn't run
// a system yet still takes the others' parts and events, and finds what it scans at the same moment as the others.
const warmers = [];
let warming = false;
const warm = fn => { warmers.push(fn); };
// (js/cworkers.js setup: workers that start after that first meeting set up at once, alike; each set-up runs once per worker)
const warmed = () => { if (!warming) for (const fn of warmers) fn(); };
function owned(name, t) {
  if (!t || typeof t.snap !== "function" || typeof t.apply !== "function") throw new Error("BF.ctick.owned(name, {snap, apply})");
  tables.set(name, t);
}

// The common shapes of owned tables, and what a converted system's loops filter by:
//   ownedMap(name, map, groupOfKey, enc?, dec?)  a Map whose every entry belongs to one group (groupOfKey(key, value) -> group key): a group's part
//                                                is its keys' entries, values as plain JSON (enc(v, k) -> JSON, dec(j, k) -> value);
//                                                applying it updates the group's keys in place (the map's order stays), adds its new
//                                                ones at the end in the owner's order and drops its gone ones
//                                                ver(k, v) too: only the entries whose ver changed since they were last swapped go
//   ownedSet(name, set, groupOfKey)              the same for a Set of keys
//   ofVillage(key), ofCell(x, z), ofMob(m)       the group a village key, a block cell or a mob belongs to (a mob with no cluster: null)
//   mineVillage(key), mineCell(x, z)             true when the running group's (always, outside groups or in a system not converted)
const ofVillage = k => CL().groupOf("v:" + k);
const ofCell = (x, z) => CL().groupOf(CL().ofRegion(BF.regions.keyOf(x, 0, z)));
const ofMob = m => (m && m.cl !== undefined ? CL().groupOf(m.cl) : null);
const mineVillage = k => !cur || legacy || ofVillage(k) === cur.key;
const mineCell = (x, z) => !cur || legacy || ofCell(x, z) === cur.key;
// A table's keys by group, in the table's order, for the owned tables' snap and apply (keysOf(coll, g, groupOf(k, v)): a Map's or a
// Set's): made once per swap step (tablesStep: js/cworkers.js, around its snaps and around its applies) instead of every group's snap
// and apply testing every key. Within a step a key doesn't change group and an apply changes only its own group's keys (applied(coll, g)
// after it); made again when the table's size changed some other way. Outside a step (one worker, tests) made at each call.
let tstep = 0, inStep = false;
const parts = new WeakMap();   // coll -> {at, size, m: group -> [keys]}
const NO_KEYS = [];
function keysOf(coll, g, groupOf) {
  let c = inStep ? parts.get(coll) : undefined;
  if (!c || c.at !== tstep || c.size !== coll.size || c.m.get(g) === null) {
    c = { at: tstep, size: coll.size, m: new Map() };
    const isMap = coll instanceof Map;
    for (const e of coll) { const k = isMap ? e[0] : e, gk = isMap ? groupOf(k, e[1]) : groupOf(k), a = c.m.get(gk); if (a) a.push(k); else c.m.set(gk, [k]); }
    if (inStep) parts.set(coll, c);
  }
  return c.m.get(g) || NO_KEYS;
}
function applied(coll, g) { const c = parts.get(coll); if (c && c.at === tstep) { c.size = coll.size; c.m.set(g, null); } }
function tablesStep(on) { inStep = !!on; tstep++; }

function ownedMap(name, map, groupOfKey, enc, dec, ver) {
  if (ver) return ownedLog(name, map, groupOfKey, enc, dec, ver);
  owned(name, {
    snap(g) { const o = []; for (const k of keysOf(map, g, groupOfKey)) o.push([k, enc ? enc(map.get(k), k) : map.get(k)]); return o; },
    apply(g, list) {
      const got = new Set();
      for (const [k] of list) got.add(k);
      for (const k of keysOf(map, g, groupOfKey)) if (!got.has(k)) map.delete(k);
      for (const [k, v] of list) map.set(k, dec ? dec(v, k) : v);
      applied(map, g);
    },
  });
}
// ver(k, v) given (big tables that change a little at a time: logs, histories): only the entries whose ver changed since this worker last
// sent or got them go, with the group's key list (for the gone ones); snap(g, true) puts them all (tests: a part sent and snapped again)
function ownedLog(name, map, groupOfKey, enc, dec, ver) {
  const had = new Map();   // key -> the ver every worker has
  owned(name, {
    snap(g, all) {
      const keys = [], put = [];
      for (const k of keysOf(map, g, groupOfKey)) {
        const v = map.get(k);
        keys.push(k);
        const n = ver(k, v);
        if (all || had.get(k) !== n) { had.set(k, n); put.push([k, enc ? enc(v, k) : v]); }
      }
      return { keys, put };
    },
    apply(g, o) {
      const got = new Set(o.keys);
      for (const k of keysOf(map, g, groupOfKey)) if (!got.has(k)) { map.delete(k); had.delete(k); }
      for (const [k, j] of o.put) { const v = dec ? dec(j, k) : j; map.set(k, v); had.set(k, ver(k, v)); }
      applied(map, g);
    },
  });
}
function ownedSet(name, set, groupOfKey) {
  owned(name, {
    snap(g) { return keysOf(set, g, groupOfKey).slice(); },
    apply(g, list) { const got = new Set(list); for (const k of keysOf(set, g, groupOfKey)) if (!got.has(k)) set.delete(k); for (const k of list) set.add(k); applied(set, g); },
  });
}

// What must change only at meetings: onMeet(fn, name, when) runs fn at each meeting, on every worker alike, outside every group (between
// ticks), in registration order. when "start" (the default): first, before the queued requests are gathered (so what it sends is
// filed into the new groups) and the clusters are worked out again (village records first met,
// js/mobs.js; the simulated set); "end": after the requests that waited are applied and delivered (the explorer camps). A hook decides
// only from what every worker has alike (the player, mobs, village records, owned tables); mobs it makes take the between-ticks ids.
const meetHooks = { start: [], end: [] };
function onMeet(fn, name, when) {
  const L = meetHooks[when || "start"];
  if (!L) throw new Error('BF.ctick.onMeet(fn, name, "start" | "end")');
  L.push([fn, name || fn.name || "meet"]);
}
function meetHooksRun(when) {
  for (const [fn, name] of meetHooks[when]) {
    try { fn(); } catch (e) { S.err++; if (S.err <= 20 && BF.glog) BF.glog.log("ERROR", "clusters", "Meeting hook " + name + " (" + when + ") failed: " + (e && e.message || e)); console.error(e); }
  }
}

// Tracing (tests): the reads of another group's objects that BF.ids.get and the region queries hid, by system and calling code.
let trace = null;
function traced(o) {
  const h = hidden(o);
  if (h) {
    const st = String(new Error().stack).split("\n").slice(2).find(l => /\/js\/[\w-]+\.js/.test(l) && !/\/js\/(ids|regions|ctick)\.js/.test(l)) || "";
    const at = (/\/js\/([\w-]+\.js):(\d+)/.exec(st) || [, "?", 0]).slice(1).join(":");
    const k = running + " " + at;
    trace.set(k, (trace.get(k) || 0) + 1);
  }
  return h;
}
const hider = () => (trace ? traced : hidden);

// ---------------------------------------------------------------- on and off
function setOn(v) {
  v = !!v;
  if (v === on) return;
  if (v && BF.rworkers && BF.rworkers.active) throw new Error("the cluster tick can't run with region workers (js/rworkers.js)");
  if (v) {
    on = true; needMeet = true; warming = true; groups = []; byKey = new Map(); deferred = [];
    startRanges();
    between = slot("between", 0); between.req = BF.req.ctx();
    BF.req.away = away;
    for (const m of BF.mobs.list) if (!m.removed) CL().place(m);
    stale();
  } else {
    leave();
    // everything still queued goes back to the one context
    const pending = [];
    for (const g of groups) { useSlot(g); for (const r of BF.req.pending()) pending.push(r); }
    useSlot(between);
    for (const r of deferred) pending.push(r);
    BF.req.away = null;
    BF.ids.range.set(null); BF.rand.range.set(null); BF.dynRange.set(null); BF.dynRange.settle();
    for (const r of pending) BF.req.fileIn(BF.req.ctx(), r);
    groups = []; byKey = new Map(); deferred = []; on = false;
  }
  if (BF.glog) BF.glog.log("INFO", "clusters", "Cluster tick " + (on ? "on (" + order + " order, meetings every " + MEET + " ticks)" : "off"));
}
function setOrder(o) {
  if (o !== "tick" && o !== "cluster") throw new Error('BF.ctick.order is "tick" or "cluster"');
  order = o;
}

// ---------------------------------------------------------------- reporting
function stats() {
  const per = new Map();
  for (const m of BF.mobs.list) if (!m.removed && m.cl !== undefined) { const g = CL().groupOf(m.cl); per.set(g, (per.get(g) || 0) + 1); }
  return {
    on, order, meetings: S.meetings, ticks: S.ticks, deferred: S.deferred, lastDeferred: S.lastDeferred, refiled: S.refiled, closures: S.closures || 0, meetMs: S.meetMs || 0,
    groups: groups.map(g => ({ key: g.key, bases: g.bases ? g.bases.length : 0, player: !!g.player, mobs: per.get(g.key) || 0, ms: g.ms / Math.max(1, S.since) })),
    converted: converted(), legacy: Object.keys(SYSTEMS).filter(k => !SYSTEMS[k]),
  };
}
const converted = () => Object.keys(SYSTEMS).filter(k => SYSTEMS[k]);
const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
// The F3 line: "Clusters 5 (tick): 3.10 ms most (v:12,40 180 mobs), 2 waited for the meeting"
function text(s) {
  s = s || stats();
  if (!s.on) return "Clusters off";
  const top = s.groups.slice().sort((a, b) => b.ms - a.ms)[0];
  return "Clusters " + s.groups.length + " (" + s.order + ")" + (top ? ": " + f2(top.ms) + " ms most (" + top.key + " " + top.mobs + " mobs)" : "") +
    ", " + s.lastDeferred + " waited for the meeting";
}
function hourly() {
  const now = BF.simNow ? BF.simNow() : 0;
  if (hourAt == null || now < hourAt) { hourAt = now; return; }
  if (now - hourAt < HOUR) return;
  hourAt = now;
  const live = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (live && H.ticks && BF.glog) {
    const s = stats();
    BF.glog.log("INFO", "clusters", "Cluster tick in the last game hour: " + s.groups.length + " groups (" + s.groups.map(g => g.key + " " + g.mobs).join(", ") + "), " +
      H.meetings + " meetings, " + H.deferred + " requests waited for a meeting");
  }
  H.ticks = H.deferred = H.meetings = 0;
}
function reset() {
  leave();
  groups = []; byKey = new Map(); deferred = []; needMeet = true; between = null; hourAt = null;
  S.meetings = S.deferred = S.refiled = S.ticks = S.lastDeferred = S.err = 0; S.metAt = undefined; S.meetMs = 0; S.closures = 0; closureKinds.clear();
  H.ticks = H.deferred = H.meetings = 0;
  if (CL()) CL().reset();
  clocks.clear();
  stale();
  if (on) {
    startRanges();
    between = slot("between", 0); between.req = BF.req.ctx();
  }
}

BF.ctick = {
  MEET, SYSTEMS,
  get on() { return on; }, set on(v) { setOn(v); },
  get order() { return order; }, set order(o) { setOrder(o); },
  get cur() { return cur; },
  get filter() { return cur && !legacy ? mine : null; },
  mobs, added, stale, get epoch() { return epoch; },   // the running group's mobs (removed ones included), or null when every mob is seen; a new
  // mob; the lists out of date; how many times they were (a module's own lists by group are made again when it changes)
  owned, tables: () => [...tables.keys()], table: name => tables.get(name), onMeet, warm, warmed,
  ownedMap, ownedSet, ofVillage, ofCell, ofMob, mineVillage, mineCell,
  tickOf: b => clocks.get(b), clocks: () => new Map(clocks),   // each cluster's own tick (one clock for now)
  mine, hidden, sys, local, step, interval, meet: meetNow, groups: () => groups, converted, stats, text, hourly, reset,
  get only() { return only; }, set only(v) { only = v ? new Set(v) : null; },
  get system() { return running; },
  // for several workers (js/cworkers.js): the ranges' counters, the requests waiting for the meeting, a group's queued requests
  inner: {
    R2, RANGE,
    get deferred() { return deferred; }, set deferred(v) { deferred = v; },
    pendingOf(g) { keepSlot(between); useSlot(g); try { return BF.req.pending(); } finally { useSlot(between); } },
    setPending(g, list) { g.req = BF.req.newCtx(); for (const r of list) BF.req.fileIn(g.req, r); },
    tablesStep,
  },
  keysOf, applied,   // an owned table's keys of one group, in its order (see keysOf); after applying a group's part
  // trace: true starts counting hidden reads ("system file:line" -> count), traced() reads them, trace = false stops
  get trace() { return !!trace; }, set trace(v) { trace = v ? new Map() : null; },
  traced: () => (trace ? [...trace].sort((a, b) => b[1] - a[1]) : []),
};
if (BF.on) BF.on("newWorld", reset);
})();
