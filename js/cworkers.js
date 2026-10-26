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
// API: BF.cworkers = { active, n, me, setup({n, me, link}), stop(why), owns(group), owners (group key -> worker), sync(), met(groups),
//   shuffle (tests: owners by a hash of it at every meeting), fixed (tests, with shuffle: the same owners at every meeting), stats(), text() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const now = () => performance.now();
const LEAD = 0.7;      // the share of a worker's load the first worker takes on (it also serves the player and the client)
const SOLO_MS = 0.6;   // below this many ms a tick in all, every group goes to the first worker (an exchange costs more than it saves)

const CW = { active: false, n: 1, me: 0, link: null, owners: new Map(), shuffle: 0, fixed: false };
const RW = () => BF.rworkers;
let shadows = new Map(), recShadows = new Map(), known = new Set();
let journal = new Map();          // chunk key -> Map(cell -> block id): what the owned passes set
let regNew = [];
let groupMs = new Map(), lastMs = new Map(), meetings = 0;
const T = { meetings: 0, collect: 0, exchange: 0, adopt: 0, snap: 0, bytes: 0, run: 0 };
let peers = [], hourAt = null, hourT = null, tRun = 0, warned = 0;

const C = () => BF.ctick;
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
  return [r.kind, R.enc(r.target, null), R.encData(r), r.from, r.tick, r.region == null ? -1 : r.region, r._from, r._n, r._at, r._due, r.seq];
}
function reqIn(a) {
  const R = RW();
  const r = BF.req.revive({ kind: a[0], target: R.dec(a[1], null), data: R.dec(a[2], null), from: a[3], tick: a[4], region: a[5], seq: a[10] });
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
  R.refs();
  // the shared index (objects that live inside an entity, sent as where they are) of the mobs and records this worker ran: nothing it
  // changed can reach into another group's between meetings
  R.indexScope = { mobs: new Set(shadows.keys()), recs: new Set(recShadows.keys()) };
  for (const m of BF.mobs.list) if (!known.has(m)) R.indexScope.mobs.add(m);
  lap("refs");
  // mobs not here at the last meeting that this worker made, or that every worker made between ticks (a chunk loading) and this one
  // runs: in full, every field (links by id), filled in under the same id
  const born = [];
  for (const m of BF.mobs.list) {
    if (m.removed || known.has(m) || !(bornHere.has(m) || ownsKey(groupOf(m)))) continue;
    const o = {};
    for (const k of Object.keys(m)) o[k] = m[k];   // (a plain copy, its own fields: the codec writes m itself as a reference)
    born.push([m.id, m.type, R.enc(o, m)]);
  }
  lap("born");
  const mobs = [];
  for (const [m, s] of shadows) {
    if (m.removed) { mobs.push([m.id, null, 1]); continue; }
    const ops = R.diff(m, s);
    if (ops) mobs.push([m.id, ops]);
  }
  lap("mobs");
  const recs = [];
  for (const [rec, s] of recShadows) { const ops = R.diff(rec, s); if (ops) recs.push([rec.key, ops]); }
  lap("recs");
  const edits = [];
  for (const [k, e] of journal) edits.push([k, [...e]]);
  journal = new Map();
  const tables = [];
  const gs = K.groups().filter(owns);
  for (const name of K.tables()) { const t = K.table(name); for (const g of gs) tables.push([name, g.key, t.snap(g.key)]); }
  const chans = [];
  for (const [name, key] of touched.values()) { const ch = R.chan(name), o = ch.get(key); chans.push([name, key, o == null ? null : ch.state(o)]); }
  touched = new Map();
  const reg = regNew.map(([k, o]) => [k, R.enc(o, null)]);
  regNew = [];
  const waited = [];
  for (const r of I.deferred) if (!r._cw) { r._cw = 1; waited.push(reqOut(r)); }
  const queued = gs.map(g => [g.key, I.pendingOf(g).map(reqOut)]).filter(q => q[1].length);
  const ms = gs.map(g => [g.key, +g.ms.toFixed(3)]);
  const counters = [I.R2.ids.j, I.R2.made.j, BF.ids.range.top, BF.rand.made];
  lap("rest");
  const out = { born, mobs, recs, edits, tables, chans, reg, waited, queued, ms, counters };
  const msg = JSON.stringify(out);
  lap("json");
  if (CW.sizes) {   // (tests: what the bytes are, by part and by the mobs' and records' fields)
    const add = (k, v) => { CW.sizes[k] = (CW.sizes[k] || 0) + JSON.stringify(v).length; };
    for (const k in out) add(k, out[k]);
    for (const [, ops] of mobs) if (ops) for (const op of ops) add("mob." + op[0], op);
    for (const [, ops] of recs) for (const op of ops) add("rec." + op[0], op);
  }
  R.indexScope = null;
  const t1 = now();
  T.collect += t1 - t0;
  const all = CW.link.exchange(msg);
  const t2 = now();
  T.exchange += t2 - t1;
  T.bytes += msg.length;
  const ps = all.map((x, w) => (w === CW.me ? null : JSON.parse(x)));
  peers = all.map((x, w) => ({ bytes: x.length }));
  // everything every worker measured (its own groups'), for the plan
  groupMs = new Map(); ranBy = new Map();
  const lift = [I.R2.ids.j, I.R2.made.j, BF.ids.range.top, BF.rand.made];
  for (let w = 0; w < all.length; w++) {
    const p = w === CW.me ? { ms, counters } : ps[w];
    for (const [k, v] of p.ms) { groupMs.set(k, v); ranBy.set(k, w); }
    for (let i = 0; i < 4; i++) if (p.counters[i] > lift[i]) lift[i] = p.counters[i];
  }
  I.R2.ids.j = lift[0]; I.R2.made.j = lift[1]; BF.ids.range.lift(lift[2]); BF.rand.range.lift(lift[3]);
  const fresh = new Set();
  bornHere = new Set();
  // the others' changes: places and new mobs first (the changes may point at them), then records, mobs, blocks, tables, requests
  for (let w = 0; w < ps.length; w++) {
    const p = ps[w];
    if (!p) continue;
    for (const [k, e] of p.reg) if (BF.ids.live(k) === undefined) BF.ids.put(R.dec(e, null), k);
    for (const [id, type] of p.born) if (BF.ids.live(id) === undefined) { BF.mobs.blank(type, id); fresh.add(id); }
  }
  for (let w = 0; w < ps.length; w++) {
    const p = ps[w];
    if (!p) continue;
    for (const [id, , e] of p.born) { const m = BF.ids.live(id); if (m) BF.mobs.filled(m, R.dec(e, m), !fresh.has(id)); }
  }
  const cells = new Map();
  for (const [k, list] of edits) for (const [i] of list) cells.set(k + "|" + i, CW.me);
  for (let w = 0; w < ps.length; w++) {
    const p = ps[w];
    if (!p) continue;
    for (const [key, ops] of p.recs) { const rec = BF.mobs.villages.get(key); if (rec) R.patch(rec, ops); else err("worker " + w + " changed village " + key + ", which this worker doesn't have"); }
    for (const [id, ops, removed] of p.mobs) {
      const m = BF.ids.live(id);
      if (!m) { err("worker " + w + " changed mob " + id + ", which this worker doesn't have"); continue; }
      if (ops) R.patch(m, ops);
      if (removed && !m.removed) BF.mobs.discard(m);
    }
    for (const [k, list] of p.edits) for (const [i] of list) { const at = k + "|" + i; if (cells.has(at) && cells.get(at) !== w) err("workers " + cells.get(at) + " and " + w + " both set cell " + i + " of chunk " + k); cells.set(at, w); }
    replaying = true;
    try { if (p.edits.length) BF.world.applyEdits(p.edits); } finally { replaying = false; }
    for (const [name, gk, data] of p.tables) { const t = K.table(name); if (t) t.apply(gk, data); }
    for (const [name, key, data] of p.chans) { const ch = R.chan(name); if (ch) ch.set(ch.get(key), data, key); }
  }
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
  if (BF.regions) BF.regions.tick();   // (the region index, for the mobs that moved on other workers)
  T.adopt += now() - t2;
  T.meetings++;
}

// ---------------------------------------------------------------- after the meeting: the next interval's owners, and the shadows
function met(groups) {
  if (!CW.active) return;
  const t0 = now();
  plan(groups);
  const R = RW();
  R.refs();
  shadows = new Map(); recShadows = new Map(); known = new Set(BF.mobs.list);
  meetings++;
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
  tRun = now();
  hourly();
}
// Owners for the new groups, worked out alike on every worker from the run times swapped at the last sync: the player's group on the
// first worker; then the rest longest first, each staying on its last worker while that has room, else to the least loaded (the
// first worker counts LEAD of its load as room). A group not met before is guessed from its bases' share of their old groups' time.
let est = new Map();
function plan(groups) {
  const prev = CW.owners;
  est = new Map();
  const perBase = new Map();
  for (const [k, ms] of groupMs) { const g = lastGroups.get(k); if (g) for (const b of g) perBase.set(b, ms / g.length); }
  for (const g of groups) {
    let ms = groupMs.get(g.key);
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
  const room = w => (w === 0 ? LEAD : 1);
  const load = new Array(CW.n).fill(0), share = total / (CW.n - 1 + LEAD);
  const order = groups.slice().sort((a, b) => est.get(b.key) - est.get(a.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const g of order) {
    const ms = est.get(g.key);
    let w;
    if (g.player) w = 0;
    else {
      const was = prev.get(g.key);
      if (was !== undefined && was < CW.n && load[was] + ms <= share * room(was) * 1.1) w = was;
      else { w = 0; for (let i = 1; i < CW.n; i++) if (load[i] / room(i) < load[w] / room(w)) w = i; }
    }
    next.set(g.key, w);
    load[w] += ms;
  }
  CW.owners = next;
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
  // o.claims (a SharedArrayBuffer of two Int32, the same for every worker: makeShared): the workers pull groups (the cluster order)
  CW.pull = !!(CW.active && o.claims && K.order === "cluster" && !CW.shuffle);
  claims = o.claims ? new Int32Array(o.claims) : null;
  ran = new Set(); queue = []; byGroup = new Map();
  CW.owners = new Map(); CW.solo = false;
  shadows = new Map(); recShadows = new Map(); known = new Set(BF.mobs.list); journal = new Map(); regNew = []; groupMs = new Map(); lastGroups = new Map(); meetings = 0; warned = 0;
  for (const k in T) T[k] = 0;
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
}

const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
function stats() {
  const n = Math.max(1, T.meetings), per = new Array(CW.n).fill(0), groups = new Array(CW.n).fill(0);
  for (const g of C().groups()) { const w = CW.pull ? ranBy.get(g.key) || 0 : CW.owners.has(g.key) ? CW.owners.get(g.key) : 0; groups[w]++; per[w] += groupMs.get(g.key) || 0; }
  return { active: CW.active, n: CW.n, me: CW.me, solo: !!CW.solo, pull: CW.pull, meetings: T.meetings, groups, ms: per.map(v => v / C().MEET),
    perMeeting: { run: T.run / n, collect: T.collect / n, exchange: T.exchange / n, adopt: T.adopt / n, snap: T.snap / n }, kbPerMeeting: T.bytes / n / 1024 };
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
Object.assign(CW, { setup, stop, owns, claim, sync, met, stats, text, makeShared, pull: false });
BF.cworkers = CW;
})();
