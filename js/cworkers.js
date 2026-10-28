// Clusters on several workers (spec r15-39b, item C7). Every worker holds the whole world (a replica, as js/rworkers.js) and runs the
// cluster tick (js/ctick.js) on all of it, except that each group's passes run only on the worker that owns it: the others skip them.
// Groups don't affect each other between meetings, so each worker runs its own for a whole interval with no waiting; at the end of the
// interval (the tick before a meeting) the workers swap what their groups changed, and then every worker runs the meeting alike:
//   mobs       the owned groups' mobs as diffs against their state at the last meeting (js/rworkers.js Shadow, diff, patch), the ones they
//              made in full (filled in under the same id: BF.mobs.blank / filled), the ones they removed;
//   villages   the owned groups' village records, as diffs;
//   blocks     the cells the owned passes set (world.onBlockSet), last value per cell, put in without their consequences
//              (world.applyEdits: the owner made those and sends them too);
//   tables     each module table registered with BF.ctick.owned, the owned groups' part (C2-C6 register them);
//   places     new keys in the place registry (js/ids.js onNew), as js/rworkers.js;
//   items      the map items the owned groups made (js/blocks.js BF.dynRange: ids from the slot's range, so the same everywhere);
//   requests   the requests waiting for the meeting (crossing to another group) and those still queued in an owned group, with their
//              stamps, so the meeting applies and files them as one worker would;
//   counters   how far each id and creation-number range went (js/ctick.js R2, js/ids.js range, js/rand.js range), so the meeting hands
//              out the same ranges everywhere;
//   ms         each owned group's run time this interval, from which every worker plans the next owners alike (plan below).
// The world after each meeting is the same on every worker and the same as on one (test/cluster-workers.js compares state hashes).
// It runs only when every system that runs is converted (BF.ctick.SYSTEMS, or BF.ctick.only within them): a system not converted yet
// sees the whole world from one group's pass, which another worker skips.
// The transport is js/rworkers.js's (shared-memory mailboxes and a barrier: makeShared, attach), one exchange a meeting.
// Game log: INFO "workers" when they start and stop and once a game hour while the debug overlay or debug screen is on; ERROR when two
// workers set the same cell, a request with callbacks changes worker, or a mob or record arrives that this worker doesn't have.
// API: BF.cworkers = { active, n, me, setup({n, me, link}), stop(why), owns(group), owners (group key -> worker), workerOf(group key) -> worker, sync(), met(groups),
//   shuffle (tests: owners by a hash of it at every meeting), fixed (tests, with shuffle: the same owners at every meeting), stats() (with x:
//   each kind of exchange's count, ms and ms waiting a meeting), text() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const now = () => performance.now();
const LEAD = 0.7;      // the share of a worker's load the first worker takes on (it also serves the player and the client)
const SOLO_MS = 0.6;   // below this many ms a tick in all, every group goes to the first worker (an exchange costs more than it saves)

const CW = { active: false, n: 1, me: 0, link: null, owners: new Map(), shuffle: 0, fixed: false };
const RW = () => BF.rworkers;
let shadows = new Map(), recShadows = new Map(), known = new Set();
// Partial copies (CW.partial): only the mobs a worker runs are current on it. mine: the ones it runs this interval; holder: mob id ->
// the worker whose copy is current, from the last sync (none: current everywhere, made at the meeting or sent whole)
let mine = new Set(), holder = new Map();
let journal = new Map();          // chunk key -> Map(cell -> block id): what the owned passes set
let regNew = [];
let groupMs = new Map(), lastMs = new Map(), meetings = 0;
const T = { meetings: 0, collect: 0, exchange: 0, adopt: 0, snap: 0, bytes: 0, run: 0, moved: 0, fetched: 0 };
let atMeeting = false;   // (partial copies: from the swap to the end of the meeting, when fetch may exchange)
let peers = [], hourAt = null, hourT = null, tRun = 0, warned = 0;

const C = () => BF.ctick;
// every exchange by what it is for (stats().x): how many, ms in all, ms of it waiting at the barrier for the other workers
const X = {};
function xchange(tag, msg) {
  if (CW.preExchange) CW.preExchange();   // (play: the leader's journal out first, js/rplay.js)
  const L = CW.link, t0 = now(), w0 = L.waitMs, all = L.exchange(msg), x = X[tag] || (X[tag] = { n: 0, ms: 0, wait: 0 });
  x.n++; x.ms += now() - t0; x.wait += L.waitMs - w0;
  return all;
}
// (tests, CW.prof an object: ms a part of the collect took, summed)
let lapT = 0;
const lap = k => { if (!CW.prof) return; const t = now(); if (k) CW.prof[k] = (CW.prof[k] || 0) + t - lapT; lapT = t; };
const groupOf = m => (m.cl !== undefined ? BF.clusters.groupOf(m.cl) : C().groups()[0] && C().groups()[0].key);
const ownsKey = k => (CW.pull ? ran.has(k) : (CW.owners.has(k) ? CW.owners.get(k) : 0) === CW.me);
function owns(g) { return ownsKey(g.key); }

// ---------------------------------------------------------------- pulling groups (the cluster order)
// In the cluster order (each group's whole interval in turn) nobody owns a group: after the meeting every worker holds the whole world as
// it is, so any of them can run any group. The groups are queued longest first (by their last time, the same list on every worker) and
// each worker takes the next one from a shared counter (Atomics) whenever it is free, so a slow interval on one group doesn't hold up
// the rest. A worker snaps the shadows of a group's mobs and record when it takes it.
let ranBy = new Map();   // group key -> the worker that ran it in the last interval
let ran = new Set(), queue = [], byGroup = new Map(), claims = null;
const slot = () => meetings & 1;   // (two counters in turn: the one for the next interval is cleared while this one is in use)
function claim() {
  if (!CW.pull) return null;
  const i = Atomics.add(claims, slot(), 1);
  if (i >= queue.length) return null;
  const g = queue[i], t0 = now(), R = RW();
  ran.add(g.key);
  for (const m of byGroup.get(g.key) || []) if (!m.removed) shadows.set(m, R.snap(m));
  for (const rec of BF.mobs.villages.values()) if (BF.clusters.groupOf("v:" + rec.key) === g.key) recShadows.set(rec, R.snap(rec));
  T.snap += now() - t0;
  return g;
}

function err(what) { if (warned++ < 20 && BF.glog) BF.glog.log("ERROR", "workers", "Cluster workers: " + what); }
function note(text) { if (BF.glog && CW.me === 0) BF.glog.log("INFO", "workers", "Cluster workers: " + text); }

// ---------------------------------------------------------------- what the owned passes change outside mobs and records
function onSet(c, i, id) {
  if (!CW.active || !C().cur || replaying) return;
  let e = journal.get(c.key);
  if (!e) journal.set(c.key, (e = new Map()));
  e.set(i, id);
}
let replaying = false;
// Module state a mob's thinking changes outside mobs (farm cell claims, bee homes, lures, maps: js/rworkers.js channels): the keys
// touched in the owned passes, sent with their state as the channel gives it
let touched = new Map();   // "name\u0000key" -> [name, key]
function onTouch(name, key) { if (CW.active && C().cur && !replaying) touched.set(name + "\u0000" + JSON.stringify(key), [name, key]); }
// New keys in the place registry while an owned pass runs: places (a ":" in the key) go to the others; mobs made here are sent in full
let bornHere = new Set();
const onNewPlace = (o, k) => {
  if (!CW.active || !C().cur || typeof k !== "string") return;
  if (k.includes(":")) regNew.push([k, o]); else if (k.charCodeAt(0) === 101) bornHere.add(o);
};

// ---------------------------------------------------------------- requests, as plain JSON
function reqOut(r) {
  const R = RW();
  return [r.kind, R.enc(r.target, null), R.encData(r), r.from, r.tick, r.region == null ? -1 : r.region, r._from, r._n, r._at, r._due, r.seq, r.by];
}
function reqIn(a) {
  const R = RW();
  const r = BF.req.revive({ kind: a[0], target: R.dec(a[1], null), data: R.dec(a[2], null), from: a[3], tick: a[4], region: a[5], seq: a[10], by: a[11] });
  if (a[6] !== undefined && a[6] !== null) { r._from = a[6]; r._n = a[7]; r._at = a[8]; r._due = a[9]; }
  return r;
}

// ---------------------------------------------------------------- the swap, at the end of each interval
function sync() {
  if (!CW.active) return;
  const t0 = now();
  T.run += t0 - tRun;
  lap(null);
  const R = RW(), K = C(), I = K.inner;
  // the shared table's rows of the villages this worker ran (js/sharedtable.js collect: published first thing at the meeting), worked
  // out first, as one worker does at the interval's end (js/ctick.js), so what they fill in on the villagers goes too; only the worker
  // that ran a village can (partial copies: only its villagers are current here; full copies: not before the swap)
  const rows = [];
  if (BF.sharedTable) for (const [k, row] of BF.sharedTable.collect(k => ownsKey(BF.clusters.groupOf("v:" + k)))) rows.push([k, row]);
  R.refs();
  // the shared index (objects that live inside an entity, sent as where they are) of the mobs and records this worker ran: nothing it
  // changed can reach into another group's between meetings
  R.indexScope = { mobs: new Set(CW.partial ? mine : shadows.keys()), recs: new Set(recShadows.keys()) };
  for (const m of BF.mobs.list) if (!known.has(m)) R.indexScope.mobs.add(m);
  lap("refs");
  // mobs not here at the last meeting that this worker made, or that every worker made between ticks (a chunk loading) and this one
  // runs: in full, every field (links by id), filled in under the same id
  // (one made between ticks in a place no group has yet, a chunk loading at the edge, ran nowhere: every worker has it as it was made)
  const born = [], live = new Set(K.groups().map(g => g.key));
  for (const m of BF.mobs.list) {
    if (m.removed || known.has(m)) continue;
    if (!bornHere.has(m)) { const gk = groupOf(m); if (!live.has(gk) || !ownsKey(gk)) continue; }
    const o = {};
    for (const k of Object.keys(m)) o[k] = m[k];   // (a plain copy, its own fields: the codec writes m itself as a reference)
    born.push([m.id, m.type, R.enc(o, m)]);
  }
  lap("born");
  const mobs = [], sums = [];
  for (const [m, s] of shadows) {
    if (m.removed) { mobs.push([m.id, null, 1]); continue; }
    const ops = R.diff(m, s);
    if (ops) mobs.push([m.id, ops]);
  }
  // partial copies: what the meeting reads of each mob this worker ran (js/clusters.js summary); one it removed goes whole, so every
  // copy is removed from the same state
  const gone = [];
  if (CW.partial) for (const m of mine) if (m.removed) gone.push(m); else sums.push([m.id, BF.clusters.summary(m)]);
  const goneE = gone.length ? [gone.map(m => m.id), R.encMany(gone.map(whole))] : null;
  lap("mobs");
  const recs = [];
  for (const [rec, s] of recShadows) { const ops = R.diff(rec, s); if (ops) recs.push([rec.key, ops]); }
  lap("recs");
  const edits = [];
  for (const [k, e] of journal) edits.push([k, [...e]]);
  journal = new Map();
  const tables = [];
  const gs = K.groups().filter(owns);
  I.tablesStep(true);   // (each table's keys by group made once for all the snaps)
  lap("edits");
  for (const name of K.tables()) { const t = K.table(name); for (const g of gs) tables.push([name, g.key, t.snap(g.key)]); if (CW.prof) lap("snap." + name); }
  I.tablesStep(false);
  const chans = [];
  for (const [name, key] of touched.values()) { const ch = R.chan(name), o = ch.get(key); chans.push([name, key, o == null ? null : ch.state(o)]); }
  touched = new Map();
  const reg = regNew.map(([k, o]) => [k, R.enc(o, null)]);
  regNew = [];
  const waited = [];
  for (const r of I.deferred) if (!r._cw) { r._cw = 1; waited.push(reqOut(r)); }
  const queued = gs.map(g => [g.key, I.pendingOf(g).map(reqOut)]).filter(q => q[1].length);
  const ms = gs.map(g => [g.key, +g.ms.toFixed(3)]);
  const counters = [I.R2.ids.j, I.R2.made.j, BF.ids.range.top, BF.rand.made, I.R2.dyn.j];
  const hand = CW.me === 0 && handOwn !== null ? +handOwn.toFixed(3) : null;
  const other = tRun > 0 ? +Math.max(0, t0 - tRun - gs.reduce((a, g) => a + g.ms, 0)).toFixed(3) : null;   // (this interval's time outside its groups)
  lap("rest");
  const dyn = BF.dynRange.fresh();
  const out = { born, mobs, sums, gone: goneE, rows, recs, edits, tables, chans, reg, dyn, waited, queued, ms, counters, hand, other };
  const msg = JSON.stringify(out);
  lap("json");
  if (CW.sizes) {   // (tests: what the bytes are, by part and by the mobs' and records' fields)
    const add = (k, v) => { CW.sizes[k] = (CW.sizes[k] || 0) + JSON.stringify(v).length; };
    for (const k in out) add(k, out[k]);
    for (const [, ops] of mobs) if (ops) for (const op of ops) add("mob." + op[0], op);
    for (const [, ops] of recs) for (const op of ops) add("rec." + op[0], op);
    for (const [name, , part] of tables) add("table." + name, part);
  }
  R.indexScope = null;
  const t1 = now();
  T.collect += t1 - t0;
  const all = xchange("swap", msg);
  const t2 = now();
  T.exchange += t2 - t1;
  T.bytes += msg.length;
  lap(null);
  const ps = all.map((x, w) => (w === CW.me ? null : JSON.parse(x)));
  lap("in.parse");
  peers = all.map((x, w) => ({ bytes: x.length }));
  // everything every worker measured (its own groups'), for the plan
  groupMs = new Map(); ranBy = new Map();
  const lift = [I.R2.ids.j, I.R2.made.j, BF.ids.range.top, BF.rand.made, I.R2.dyn.j];
  for (let w = 0; w < all.length; w++) {
    const p = w === CW.me ? { ms, counters } : ps[w];
    for (const [k, v] of p.ms) { groupMs.set(k, v); ranBy.set(k, w); }
    for (let i = 0; i < 5; i++) if (p.counters[i] > lift[i]) lift[i] = p.counters[i];
  }
  for (let w = 0; w < all.length; w++) {
    const v = w === CW.me ? other : ps[w].other;
    if (v === null || v === undefined) continue;
    base[w] = base[w] === undefined ? v : base[w] + SMOOTH * (v - base[w]);
  }
  const h0 = CW.me === 0 ? hand : ps[0].hand;
  if (h0 !== null && h0 !== undefined) handMs = h0;
  I.R2.ids.j = lift[0]; I.R2.made.j = lift[1]; BF.ids.range.lift(lift[2]); BF.rand.range.lift(lift[3]); I.R2.dyn.j = lift[4];
  const fresh = new Set();
  bornHere = new Set();
  // the others' changes: places and new mobs first (the changes may point at them), then records, mobs, blocks, tables, requests
  for (let w = 0; w < ps.length; w++) {
    const p = ps[w];
    if (!p) continue;
    for (const [name, id] of p.dyn) if (!BF.dynRange.adopt(name, id)) err("worker " + w + " made item " + name + " as " + id + ", which is another item here");
    for (const [k, e] of p.reg) if (BF.ids.live(k) === undefined) BF.ids.put(R.dec(e, null), k);
    for (const [id, type] of p.born) if (BF.ids.live(id) === undefined) { BF.mobs.blank(type, id); fresh.add(id); }
  }
  for (let w = 0; w < ps.length; w++) {
    const p = ps[w];
    if (!p) continue;
    for (const [id, , e] of p.born) { const m = BF.ids.live(id); if (m) BF.mobs.filled(m, R.dec(e, m), !fresh.has(id)); }
  }
  lap("in.born");
  // partial copies: the others' summaries for the meeting, the mobs they removed; who holds each current copy
  if (CW.partial) {
    holder = new Map();
    const remote = new Map();
    for (const m of mine) if (!m.removed) holder.set(m.id, CW.me);
    for (let w = 0; w < ps.length; w++) {
      const p = ps[w];
      if (!p) continue;
      for (const [id, sum] of p.sums) {
        const m = BF.ids.live(id);
        if (!m) { err("worker " + w + " ran mob " + id + ", which this worker doesn't have"); continue; }
        remote.set(id, sum); holder.set(id, w);
        m.position.x = sum[0]; m.position.z = sum[1]; m.position.y = sum[5];
        if (!!m.dead !== !!sum[6]) m.dead = !!sum[6];
      }
      if (p.gone) {
        const ms = p.gone[0].map(id => BF.ids.live(id));
        let os = null;
        R.atLater(() => { os = R.decAll(p.gone[1]); });   // (filled in once the objects sent as where they are are in place)
        const fresh = new Set(os[1]);
        refillAll(ms.map((m, i) => [m, os[0][i]]).filter(x => x[0]), fresh);
        for (const m of ms) if (m) BF.mobs.discard(m);
      }
    }
    BF.clusters.remote = remote;
  }
  // the shared table's rows the others worked out, for the meeting's publish (with this worker's own, collect)
  if (BF.sharedTable) { const given = new Map(); for (const p of ps) if (p) for (const [k, row] of p.rows) given.set(k, row); BF.sharedTable.given = given; }
  const cells = new Map();
  for (const [k, list] of edits) for (const [i] of list) cells.set(k + "|" + i, CW.me);
  I.tablesStep(true);   // (and once for all the applies)
  try { R.atLater(() => { for (let w = 0; w < ps.length; w++) {   // (objects sent as where they are: looked up once every worker's changes are in)
    const p = ps[w];
    if (!p) continue;
    lap(null);
    for (const [key, ops] of p.recs) { const rec = BF.mobs.villages.get(key); if (rec) R.patch(rec, ops); else err("worker " + w + " changed village " + key + ", which this worker doesn't have"); }
    for (const [id, ops, removed] of p.mobs) {
      const m = BF.ids.live(id);
      if (!m) { err("worker " + w + " changed mob " + id + ", which this worker doesn't have"); continue; }
      if (ops) R.patch(m, ops);
      if (removed && !m.removed) BF.mobs.discard(m);
    }
    lap("in.mobs");
    for (const [k, list] of p.edits) for (const [i] of list) { const at = k + "|" + i; if (cells.has(at) && cells.get(at) !== w) err("workers " + cells.get(at) + " and " + w + " both set cell " + i + " of chunk " + k); cells.set(at, w); }
    replaying = true;
    try { if (p.edits.length) BF.world.applyEdits(p.edits, false, true); } finally { replaying = false; }
    lap("in.edits");
    for (const [name, gk, data] of p.tables) { const t = K.table(name); if (t) t.apply(gk, data); if (CW.prof) lap("in.table." + name); }
    lap("in.tables");
    for (const [name, key, data] of p.chans) { const ch = R.chan(name); if (ch) ch.set(ch.get(key), data, key); }
  } }); } finally { I.tablesStep(false); }
  lap("in.atLater");
  // requests: the crossing ones join the meeting's list (it sorts them by due tick, sending group and order); the queued ones go back
  // into their groups' queues, in their order there, for the meeting to file again
  const byKey = new Map(K.groups().map(g => [g.key, g]));
  for (let w = 0; w < ps.length; w++) {
    const p = ps[w];
    if (!p) continue;
    for (const a of p.waited) { const r = reqIn(a); r._cw = 1; I.deferred.push(r); }
    for (const [gk, list] of p.queued) { const g = byKey.get(gk); if (g) I.setPending(g, list.map(reqIn)); }
  }
  // the groups no worker queued anything in: nothing queued (what this worker's copy held there ran on their owner)
  const queuedKeys = new Set();
  for (let w = 0; w < all.length; w++) for (const [gk] of (w === CW.me ? queued : ps[w].queued)) queuedKeys.add(gk);
  for (const g of K.groups()) if (!owns(g) && !queuedKeys.has(g.key)) I.setPending(g, []);
  lap("in.requests");
  if (BF.regions) BF.regions.tick();   // (the region index, for the mobs that moved on other workers)
  lap("in.regions");
  T.adopt += now() - t2;
  T.meetings++;
  atMeeting = CW.partial;
}

// ---------------------------------------------------------------- after the meeting: the next interval's owners, and the shadows
function met(groups) {
  if (!CW.active) return;
  const t0 = now();
  lap("meeting");
  plan(groups);
  lap("met.plan");
  const R = RW();
  R.refs();
  lap("met.refs");
  shadows = new Map(); recShadows = new Map(); known = new Set(BF.mobs.list);
  meetings++;
  if (CW.partial) {
    atMeeting = false;
    handover();
    lap("met.handover");
    mine = new Set();
    for (const m of BF.mobs.list) if (!m.removed && ownsKey(groupOf(m))) mine.add(m);
    lap("met.mine");
    for (const rec of BF.mobs.villages.values()) if (ownsKey(BF.clusters.groupOf("v:" + rec.key))) recShadows.set(rec, R.snap(rec));
    lap("met.recsnap");
    T.snap += now() - t0;
    afterMet();
    tRun = now();
    hourly();
    return;
  }
  if (CW.pull) {
    ran = new Set();
    queue = groups.slice().sort((a, b) => (est.get(b.key) || 0) - (est.get(a.key) || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    byGroup = new Map();
    for (const m of BF.mobs.list) { if (m.removed) continue; const k = groupOf(m); let a = byGroup.get(k); if (!a) byGroup.set(k, (a = [])); a.push(m); }
    if (CW.me === 0) Atomics.store(claims, slot() ^ 1, 0);
  } else {
    for (const m of BF.mobs.list) if (!m.removed && ownsKey(groupOf(m))) shadows.set(m, R.snap(m));
    for (const rec of BF.mobs.villages.values()) if (ownsKey(BF.clusters.groupOf("v:" + rec.key))) recShadows.set(rec, R.snap(rec));
  }
  T.snap += now() - t0;
  afterMet();
  tRun = now();
  hourly();
}
// ---------------------------------------------------------------- in play (js/rplay.js): at the end of a meeting, every worker alike
// whenMet(fn): fn at the end of the next meeting, when everything every worker sent is in (a save: js/save.js saveNow, inside gathered);
// queued at the same point of the leader's journal on every worker, so they all run it at the same meeting (fn(true); fn(false) if the
// workers stop first). leave(): at the end of the
// next meeting every worker takes every mob's current copy (partial copies) and goes on as one with a whole world (js/rplay.js back to
// one). CW.verify n (tests): every n meetings the workers compare their gathered state hashes; a difference sets rworkers.mismatch.
let atMet = [], leaving = false;
function whenMet(fn) { atMet.push(fn); }
function leave() { if (CW.active) leaving = true; }
function afterMet() {
  if (CW.verify && meetings % CW.verify === 0) check();
  const fns = atMet;
  atMet = [];
  for (const fn of fns) fn(true);
  if (!leaving) return;
  leaving = false;
  if (CW.partial) fetch(BF.mobs.list);
  CW.active = false; CW.partial = false; mine = new Set(); holder = new Map();
  shadows = new Map(); recShadows = new Map();
  RW().onTouch = null; RW().SKIP.add("prev");
  note("back to one with the whole world, after " + meetings + " meetings");
}
function check() {
  const h = gathered(() => BF.stateHash.full());
  const all = xchange("verify", JSON.stringify([h.hash, h.parts]));
  const [h0, p0] = JSON.parse(all[0]);
  RW().checks = (RW().checks || 0) + 1;
  for (let w = 1; w < all.length; w++) {
    const [hw, pw] = JSON.parse(all[w]);
    if (hw === h0) continue;
    const parts = Object.keys(p0).filter(k => p0[k] !== pw[k]);
    if (!RW().mismatch) RW().mismatch = { tick: BF.rand.tick, worker: w, parts };
    err("worker " + w + "'s world differs from the first worker's at the meeting at tick " + BF.rand.tick + " (" + parts.join(", ") + ")");
  }
}
// Partial copies: the mobs whose current copy is on another worker than the one that runs them next, sent whole by their holder (every
// worker works out the same list, so they all exchange, or none)
function handover() {
  const R = RW(), moves = [];
  for (const m of BF.mobs.list) {
    if (m.removed) continue;
    const h = holder.get(m.id);
    if (h !== undefined && h !== (CW.owners.get(groupOf(m)) || 0)) moves.push(m);
  }
  const mineOut = moves.filter(m => holder.get(m.id) === CW.me);
  holder = new Map();
  if (!moves.length) return;
  const t0 = now();
  R.refs();
  // (each to its new owner only: the others keep their stale copies, as for any mob they don't run)
  const byDest = Array.from({ length: CW.n }, () => []);
  for (const m of mineOut) byDest[CW.owners.get(groupOf(m)) || 0].push(m);
  const out = byDest.map(ms => (ms.length ? JSON.stringify([ms.map(m => m.id), R.encMany(ms.map(whole))]) : ""));
  T.moved += moves.length;
  const all = xchange("handover", JSON.stringify(out));
  T.exchange += now() - t0;
  const got = [];
  R.atLater(() => { for (let w = 0; w < all.length; w++) if (w !== CW.me) { const part = JSON.parse(all[w])[CW.me]; if (part) { const [ids, e] = JSON.parse(part); got.push([w, ids, R.decAll(e)]); } } });
  const pairs = [], fresh = new Set();
  for (const [w, ids, [os, made]] of got) { for (const x of made) fresh.add(x); ids.forEach((id, i) => { const m = BF.ids.live(id); if (m) pairs.push([m, os[i]]); else err("worker " + w + " handed over mob " + id + ", which this worker doesn't have"); }); }
  refillAll(pairs, fresh);
  if (BF.regions) BF.regions.tick();
  const per = (now() - t0) / moves.length;   // (ms a mob handed over, for the plan: the first worker's goes to all at the next swap)
  handOwn = handOwn === null ? per : handOwn + SMOOTH * (per - handOwn);
}
// a mob's own fields as a plain object (the codec writes the mob itself as a reference); refill: a stale copy made the sent one
const vecs = m => { const a = []; for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isVector3) a.push([v, v.x, v.y, v.z]); } return a; };
function whole(m) { const o = {}; for (const k of Object.keys(m)) o[k] = m[k]; return o; }
// Stale copies made the sent ones, in place where they can be: an object the sender sent fresh goes into the object the same place
// held here (its fields set, the missing ones deleted, an array or Map refilled), so whatever else holds that object (the region index
// holds a mob's position; js/horses.js's records are the horses' m.horse; a pasture's list holds its cows' m.cow, js/cowherd.js) sees the
// new state, as a patch keeps it; an object that was already here (a village record's, sent as where it is) is taken as it is. Two
// passes over every mob taken in one exchange: first each fresh object is matched with the old object found in its place nearest a mob
// (breadth first over all of them: a horse's own m.horse, the record js/horses.js keeps, before the copy a stable hand's task holds
// further down), then everything points at the match.
// list: [[mob, the sent copy]], fresh: the objects the decode made.
const NONE = new Set();
const plain = v => v && typeof v === "object" && !ArrayBuffer.isView(v) && !(v.id !== undefined && BF.ids.live(v.id) === v);
function refillAll(list, fresh) {
  const chosen = new Map(), used = new Set(), bare = new Set();
  const queue = [];
  const match = (old, nu, d) => queue.push([old, nu, d]);
  const visit = (old, nu, d) => {
    if (!plain(nu) || old === nu || chosen.has(nu)) return;
    if (old && old.isVector3 && nu.isVector3) { if (!used.has(old)) { chosen.set(nu, old); used.add(old); } return; }
    if (!fresh.has(nu) || nu.isVector3) return;
    const ok = plain(old) && !used.has(old) && d <= 12 && Object.getPrototypeOf(old) === Object.getPrototypeOf(nu) && Array.isArray(old) === Array.isArray(nu) && !old.isVector3;
    if (!ok) { if (!bare.has(nu)) { bare.add(nu); kids(nu, (k, v) => match(undefined, v, d + 1)); } return; }   // (no old one here: maybe further on)
    chosen.set(nu, old); used.add(old);
    if (old instanceof Map) { for (const [k, v] of nu) match(typeof k === "object" ? undefined : old.get(k), v, d + 1); return; }
    if (old instanceof Set) { for (const v of nu) match(undefined, v, d + 1); return; }
    kids(nu, (k, v) => match(old[k], v, d + 1));
  };
  const done = new Set();
  const resolve = nu => {
    if (!plain(nu)) return nu;
    const to = chosen.get(nu);
    if (nu.isVector3) { if (to && to !== nu) to.set(nu.x, nu.y, nu.z); return to || nu; }
    if (!fresh.has(nu)) return nu;
    const t = to || nu;
    if (done.has(nu)) return t;
    done.add(nu);
    if (nu instanceof Map) { const e = [...nu]; t.clear(); for (const [k, v] of e) t.set(k, resolve(v)); return t; }
    if (nu instanceof Set) { const e = [...nu]; t.clear(); for (const v of e) t.add(resolve(v)); return t; }
    if (Array.isArray(nu)) { t.length = nu.length; for (let i = 0; i < nu.length; i++) t[i] = resolve(nu[i]); return t; }
    if (t !== nu) for (const k of Object.keys(t)) if (!(k in nu)) delete t[k];
    for (const k of Object.keys(nu)) t[k] = resolve(nu[k]);
    return t;
  };
  for (const [m, o] of list) for (const k in o) match(m[k], o[k], 0);
  for (let i = 0; i < queue.length; i++) visit(...queue[i]);
  for (const [m, o] of list) {
    for (const k of Object.keys(m)) if (!(k in o) && k !== "def" && k !== "type" && !RW().SKIP.has(k) && !k.startsWith("_")) delete m[k];
    for (const k in o) o[k] = resolve(o[k]);
    BF.mobs.filled(m, o, true);
  }
}
const kids = (v, fn) => { if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) fn(i, v[i]); } else if (v instanceof Map) { for (const [k, x] of v) fn(k, x); } else if (v instanceof Set) { for (const x of v) fn(null, x); } else for (const k of Object.keys(v)) fn(k, v[k]); };

// Owners for the new groups, worked out alike on every worker from the run times swapped at the last sync. A group's time swings a
// lot from one interval to the next (a village's think: 2-5x), so the plan uses each group's time smoothed over the last few
// intervals (SMOOTH); a group not met before is guessed from its bases' share of their old groups' smoothed time. With partial
// copies, a group that changes worker costs its mobs' handover (every mob whose current copy is on another worker, sent whole at the
// meeting, which every worker waits for: about half a ms a villager), so the plan starts from where each group's mobs are and moves
// a group only when the time it saves over the next HORIZON intervals pays for that; it also works out the plain plan (the player's
// group on the first worker, the rest longest first, each to the least loaded, the first worker counting LEAD of its load as room)
// and keeps whichever costs less. With full copies a move costs nothing, so the plain plan wins unless the other is as good. Each
// worker's load starts from its measured time outside the groups (base), so the first worker's extra work is counted as it is.
const SMOOTH = 0.3, HORIZON = 4;
let est = new Map(), smooth = new Map(), handMs = 0.5, handOwn = null, base = [];   // (base: each worker's smoothed time outside groups)
function plan(groups) {
  const prev = CW.owners;
  const fresh = new Map();
  for (const [k, ms] of groupMs) { const s0 = smooth.get(k); fresh.set(k, s0 === undefined ? ms : s0 + SMOOTH * (ms - s0)); }
  smooth = fresh;
  est = new Map();
  const perBase = new Map();
  for (const [k, ms] of smooth) { const g = lastGroups.get(k); if (g) for (const b of g) perBase.set(b, ms / g.length); }
  for (const g of groups) {
    let ms = smooth.get(g.key);
    if (ms === undefined) { ms = 0; for (const b of g.bases || []) ms += perBase.get(b) || 0; }
    est.set(g.key, ms);
  }
  lastGroups = new Map(groups.map(g => [g.key, g.bases || []]));
  if (CW.pull) return;
  const next = new Map();
  if (CW.shuffle && CW.fixed) {   // (tests: spread in key order, so every worker runs some, and never moved while the groups stay the same)
    groups.map(g => g.key).sort().forEach((k, i) => next.set(k, (i + CW.shuffle) % CW.n));
    CW.owners = next;
    return;
  }
  if (CW.shuffle) {
    for (const g of groups) { let h = (CW.shuffle * 2654435761 + meetings * 40503) >>> 0; for (const c of g.key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; next.set(g.key, ((h ^ (h >>> 13)) >>> 0) % CW.n); }
    CW.owners = next;
    return;
  }
  let total = 0;
  for (const v of est.values()) total += v;
  CW.solo = total / C().MEET < SOLO_MS;
  if (CW.solo) { CW.owners = new Map(); return; }
  // each worker's own time outside the groups (its share of every tick's global part, and the first worker's player and client), as
  // measured and swapped: what its groups add to; until every worker has measured it, the first worker counts LEAD of its load as room
  const n = CW.n, measured = base.length === n && base.every(v => v !== undefined), room = w => (w === 0 && !measured ? LEAD : 1);
  const start = () => (measured ? base.slice() : new Array(n).fill(0));
  const order = groups.slice().sort((a, b) => est.get(b.key) - est.get(a.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // held.get(key)[w]: the group's mobs whose current copy is on worker w only (partial copies; the holders from the last swap, the
  // same on every worker); a group on w costs the handover of the rest
  const held = new Map();
  if (CW.partial) for (const m of BF.mobs.list) {
    if (m.removed) continue;
    const h = holder.get(m.id);
    if (h === undefined) continue;
    const k = groupOf(m);
    let a = held.get(k);
    if (!a) held.set(k, (a = new Array(n + 1).fill(0)));
    a[h]++; a[n]++;
  }
  const cost = (k, w) => { const a = held.get(k); return a ? (a[n] - a[w]) * handMs : 0; };
  const least = load => { let w = 0; for (let i = 1; i < n; i++) if (load[i] / room(i) < load[w] / room(w)) w = i; return w; };
  const score = (own, load) => { let mx = 0, c = 0; for (let w = 0; w < n; w++) mx = Math.max(mx, load[w] / room(w)); for (const g of groups) c += cost(g.key, own.get(g.key)); return mx + c / HORIZON; };
  // the plain plan
  const A = new Map(), loadA = start();
  for (const g of order) { const w = g.player ? 0 : least(loadA); A.set(g.key, w); loadA[w] += est.get(g.key); }
  // from where the mobs are: each group where it costs least (its last worker on a tie, else none yet), the free ones longest first to
  // the least loaded, then single moves off the most loaded worker while one saves more than it costs
  const B = new Map(), loadB = start();
  for (const g of order) {
    if (g.player) { B.set(g.key, 0); loadB[0] += est.get(g.key); continue; }
    const a = held.get(g.key);
    if (!a) continue;
    const was = prev.has(g.key) ? prev.get(g.key) : 0;
    let w = was < n ? was : 0;
    for (let i = 0; i < n; i++) if (cost(g.key, i) < cost(g.key, w)) w = i;
    B.set(g.key, w); loadB[w] += est.get(g.key);
  }
  for (const g of order) if (!B.has(g.key)) { const w = least(loadB); B.set(g.key, w); loadB[w] += est.get(g.key); }
  for (let it = 0; it < 2 * groups.length; it++) {
    let top = 0;
    for (let w = 1; w < n; w++) if (loadB[w] / room(w) > loadB[top] / room(top)) top = w;
    let best = null, bestNet = 0.01;
    for (const g of order) {
      if (g.player || B.get(g.key) !== top) continue;
      const ms = est.get(g.key);
      for (let to = 0; to < n; to++) {
        if (to === top) continue;
        loadB[top] -= ms; loadB[to] += ms;
        let mx = 0;
        for (let w = 0; w < n; w++) mx = Math.max(mx, loadB[w] / room(w));
        loadB[top] += ms; loadB[to] -= ms;
        const net = loadB[top] / room(top) - mx - (cost(g.key, to) - cost(g.key, top)) / HORIZON;
        if (net > bestNet) { bestNet = net; best = [g, to]; }
      }
    }
    if (!best) break;
    const [g, to] = best, ms = est.get(g.key);
    B.set(g.key, to); loadB[top] -= ms; loadB[to] += ms;
  }
  CW.owners = score(B, loadB) <= score(A, loadA) ? B : A;
}
let lastGroups = new Map();

// ---------------------------------------------------------------- setup and reporting
// o: {n, me, link (js/rworkers.js attach(...))}. Every worker calls it at the same point of the same world, with the cluster tick on.
function setup(o) {
  const K = C();
  const off = Object.keys(K.SYSTEMS).filter(k => !K.SYSTEMS[k] && (!K.only || K.only.has(k)));
  if (o.n > 1 && off.length) throw new Error("cluster workers need every running system converted (js/ctick.js SYSTEMS); not yet: " + off.join(", "));
  if (o.n > 1 && !K.on) throw new Error("cluster workers need the cluster tick on (BF.ctick.on)");
  CW.n = o.n; CW.me = o.me; CW.link = o.link; CW.active = o.n > 1;
  if (CW.active && K.warmed) K.warmed();   // (started after the cluster tick's first meeting: every system set up here now, js/ctick.js warm)
  for (const name of K.tables()) { const t = K.table(name); if (t.reset) t.reset(); }   // (the tables that send only changes start from nothing sent)
  // o.claims (a SharedArrayBuffer of two Int32, the same for every worker: makeShared): the workers pull groups (the cluster order)
  // (only on request, o.pull: with partial copies a group that changes worker is sent whole, so groups stay on their planned owners)
  CW.pull = !!(CW.active && o.pull && o.claims && K.order === "cluster" && !CW.shuffle);
  claims = o.claims ? new Int32Array(o.claims) : null;
  // o.partial: partial copies (only the mobs a worker runs are current on it; the meeting reads the others' summaries)
  CW.partial = !!(CW.active && o.partial && !CW.pull);
  mine = new Set(); holder = new Map();
  if (CW.partial) for (const m of BF.mobs.list) if (!m.removed && ownsKey(groupOf(m))) mine.add(m);
  ran = new Set(); queue = []; byGroup = new Map();
  CW.owners = new Map(); CW.solo = false;
  shadows = new Map(); recShadows = new Map(); known = new Set(BF.mobs.list); journal = new Map(); regNew = []; groupMs = new Map(); lastGroups = new Map(); meetings = 0; warned = 0;
  for (const k in T) T[k] = 0;
  for (const k in X) delete X[k];
  smooth = new Map(); handMs = 0.5; handOwn = null; base = []; lapT = now(); atMet = []; leaving = false;
  if (BF.ids && BF.ids.hooks) BF.ids.hooks.onNew = onNewPlace;
  RW().onTouch = CW.active ? onTouch : null;
  touched = new Map();
  // a mob's start-of-tick place (prev: js/mobs.js keepPrev) is set only where the mob runs, so it is sent too (js/rworkers.js leaves it
  // out: there every copy sets it); the first worker draws every mob from it
  if (CW.active) RW().SKIP.delete("prev"); else RW().SKIP.add("prev");
  if (!hooked && BF.world && BF.world.onBlockSet) { BF.world.onBlockSet(onSet); hooked = true; }
  tRun = now();
  if (CW.active) note(CW.n + " workers share the clusters (worker " + CW.me + " of " + CW.n + ")");
}
let hooked = false;
function stop(why) {
  if (!CW.active) return;
  CW.active = false;
  if (CW.link) try { CW.link.stop(); } catch (e) { /* already */ }
  if (BF.glog) BF.glog.log(why ? "ERROR" : "INFO", "workers", "Cluster workers stopped" + (why ? ": " + why : ""));
  shadows = new Map(); recShadows = new Map();
  RW().SKIP.add("prev");
  const fns = atMet;
  atMet = []; leaving = false;
  for (const fn of fns) fn(false);
}

// The worker that runs group key: its owner, or in pull mode the one that ran it last interval; 0 when not split (the debug screen's
// Regions map colours each region by it: region -> BF.clusters.ofRegion -> group -> worker)
const workerOf = k => !CW.active ? 0 : CW.pull ? ranBy.get(k) || 0 : CW.owners.has(k) ? CW.owners.get(k) : 0;
const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
function stats() {
  const n = Math.max(1, T.meetings), per = new Array(CW.n).fill(0), groups = new Array(CW.n).fill(0);
  for (const g of C().groups()) { const w = workerOf(g.key); groups[w]++; per[w] += groupMs.get(g.key) || 0; }
  return { active: CW.active, n: CW.n, me: CW.me, solo: !!CW.solo, pull: CW.pull, meetings: T.meetings, groups, ms: per.map(v => v / C().MEET),
    moved: T.moved / n, fetched: T.fetched / n, perMeeting: { run: T.run / n, collect: T.collect / n, exchange: T.exchange / n, adopt: T.adopt / n, snap: T.snap / n }, kbPerMeeting: T.bytes / n / 1024,
    x: Object.fromEntries(Object.entries(X).map(([k, x]) => [k, { n: x.n / n, ms: x.ms / n, wait: x.wait / n }])) };
}
// The F3 line: "Cluster workers 4: groups 2/3/2/2, ms a tick 1.20/1.10/0.90/1.30, swap 3.10 ms a meeting"
function text(s) {
  s = s || stats();
  if (!s.active) return "Cluster workers 1";
  const pm = s.perMeeting;
  return "Cluster workers " + s.n + (s.pull ? " (pulling)" : s.solo ? " (one runs all)" : "") + ": groups " + s.groups.join("/") + ", ms a tick " + s.ms.map(f2).join("/") +
    ", swap " + f2(pm.collect + pm.exchange + pm.adopt + pm.snap) + " ms a meeting";
}
function hourly() {
  if (!CW.active || CW.me !== 0) return;
  const t = BF.simNow ? BF.simNow() : 0;
  if (hourAt == null || t < hourAt) { hourAt = t; hourT = Object.assign({}, T); return; }
  if (t - hourAt < 1200 / 24) return;
  hourAt = t;
  const live = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (live && hourT) {
    const n = Math.max(1, T.meetings - hourT.meetings), ms = k => f2((T[k] - hourT[k]) / n);
    note("in the last game hour: " + text() + "; ms a meeting collect " + ms("collect") + ", exchange " + ms("exchange") + ", adopt " + ms("adopt") + ", shadows " + ms("snap") +
      "; " + f2((T.bytes - hourT.bytes) / n / 1024) + " KB a meeting");
  }
  hourT = Object.assign({}, T);
}

// The shared memory every worker attaches to: js/rworkers.js's mailboxes and barrier, and the claim counters
function makeShared(n, bytes) { return Object.assign(RW().makeShared(n, bytes || 128 << 20), { claims: new SharedArrayBuffer(8) }); }
// gathered(fn) (every worker at once, between intervals): fn() with every mob's current copy here (each worker sends the ones it runs),
// then the stale copies put back as they were; for the state hash and the tests (test/cluster-workers.js)
function gathered(fn) {
  if (!CW.partial) return fn();
  const R = RW();
  R.refs();
  const list = [...mine].filter(m => !m.removed);
  const all = xchange("gathered", JSON.stringify([list.map(m => m.id), R.encMany(list.map(whole))]));
  const keep = [];
  const got = [];
  R.atLater(() => { for (let w = 0; w < all.length; w++) if (w !== CW.me) { const [ids, e] = JSON.parse(all[w]); got.push([ids, R.dec(e)]); } });
  const pairs = [];
  for (const [ids, os] of got) ids.forEach((id, i) => { const m = BF.ids.live(id); if (m) { keep.push([m, whole(m), vecs(m)]); pairs.push([m, os[i]]); } });
  refillAll(pairs, NONE);   // (nothing but vectors merged in place: put back after)
  try { return fn(); }
  finally { for (const [m, o, vs] of keep) { for (const k of Object.keys(m)) if (!(k in o)) delete m[k]; Object.assign(m, o); for (const [v, x, y, z] of vs) v.set(x, y, z); } }
}
// fetch(ms) (partial copies; every worker alike, with the same list, between ticks: js/ctick.js at a meeting before the requests that
// waited apply, js/villagesim.js before it reads or changes a village's mobs, js/mobs.js before a chunk unloads its mobs): those mobs' current copies here, sent whole by the workers that ran
// them; from then on current everywhere (the meeting changes every copy alike), so none is handed over for them. Elsewhere: nothing.
// fetch(ms, pred): those of them for which pred is true of the current copy (only its holder can tell: a stale copy may not have the
// field yet), so every worker exchanges, whatever it finds.
function fetch(ms, pred) {
  if (!CW.partial) return;
  // who has each current copy: at a meeting, the last swap says; between the ticks of an interval (a chunk unloading), its group's owner
  const holderOf = m => (atMeeting ? holder.get(m.id) : CW.owners.has(groupOf(m)) ? CW.owners.get(groupOf(m)) : 0);
  const out = [], seen = new Set();
  let need = 0;
  for (const m of ms) {
    if (!m || m.removed || seen.has(m)) continue;
    seen.add(m);
    const h = holderOf(m);
    if (h === undefined) continue;
    need++;
    if (h === CW.me && (!pred || pred(m))) out.push(m);
  }
  if (!pred && !need) return;
  const R = RW();
  R.refs();
  const all = xchange(atMeeting ? "fetch" : "fetch.tick", JSON.stringify([out.map(m => m.id), R.encMany(out.map(whole))]));
  const got = [];
  R.atLater(() => { for (let w = 0; w < all.length; w++) if (w !== CW.me) { const [ids, e] = JSON.parse(all[w]); got.push([ids, R.decAll(e)]); } });
  const pairs = [], fresh = new Set();
  for (const [ids, [os, made]] of got) { for (const x of made) fresh.add(x); ids.forEach((id, i) => { const m = BF.ids.live(id); if (m) pairs.push([m, os[i]]); }); }
  refillAll(pairs, fresh);
  for (const m of out) holder.delete(m.id);
  for (const [ids] of got) for (const id of ids) holder.delete(id);
  T.fetched += out.length + got.reduce((n, [ids]) => n + ids.length, 0);
  if (BF.regions) BF.regions.tick();
}
// current(m): this worker's copy of m is current (partial copies: it runs m, or every copy is current)
const current = m => !CW.partial || mine.has(m) || (atMeeting && !holder.has(m.id));
Object.assign(CW, { setup, stop, owns, claim, sync, met, stats, text, workerOf, makeShared, current, gathered, fetch, whenMet, leave, pull: false, partial: false, verify: 0 });
BF.cworkers = CW;
})();
