// Regions spread over several workers (spec r15-39). The region tick (r15-33, js/regiontick.js) runs its think phase on N workers at
// once. Every worker holds a whole copy of the simulation (a replica) and runs every tick in lockstep with the others; only the mob
// loop is split:
//   think     each worker updates the mobs of the regions it owns (the plan of js/regiontick.js, region by region in key order, each
//             region's mobs by id) and skips the rest;
//   exchange  each worker sends what its mobs changed (their state, as a diff against what the others already have) and the requests
//             they sent; every worker applies the others' changes and files their requests in the same region inboxes, then numbers
//             the tick's requests in plan order, so they sort exactly as on one worker;
//   rest      everything after the loop (villages, block ticks, apply, deliver) runs on every replica alike;
//   exchange  after deliver, the mobs whose request results ran code only their own worker has (req.then callbacks) send their
//             changes again, with any requests those callbacks sent; the region owners are rebalanced here every REBALANCE ticks.
// So the world is the same whichever worker thinks which region, and the same as one worker: the state hash for 1, 2 and 4 workers
// is identical (test/multi-worker.js). Region-to-worker affinity keeps a region on its worker tick to tick; the owners are planned
// again from each region's measured think time every REBALANCE ticks (the same plan on every worker, from the exchanged times). Below
// SOLO_MS of thinking a tick everything goes to one worker (the exchange isn't free).
// The transport is synchronous, so a tick needs no event loop: SharedArrayBuffer mailboxes (one per worker, two halves used in turn)
// and a barrier on Atomics (makeShared / attach below). The workers are Node worker_threads (server/regionthread.js: the world server
// and tools/headless.js --workers) or Web Workers (js/regionworker.js, from the simulation worker, js/simworker.js).
// The first worker (me 0, the leader) is the simulation the client talks to; the others are followers: they replay the leader's
// journal (journal / replay below: protocol packets, chunk loads and unloads, how many ticks a loop ran) so their copies stay the same.
// The followers' game log lines and effects go to the leader in the exchange.
// F3 and the debug screen: workers, regions and mobs per worker, ms per phase (think, exchange, rest). Game log: INFO "workers" when
// the workers start and stop, with their count, and once a game hour while the debug overlay or debug screen is on; ERROR when a
// worker crashes or the replicas no longer match (BF.rworkers.verify, tests).
// API: BF.rworkers = { active, n, me, setup({n, me, link, journal}), stop(why), beginThink(order, spans), thinking(m), afterThink(),
//   afterDeliver(), owners, stats(), text(), verify (ticks between hash checks; 0 off), enc(v, self), dec(e), Shadow, snap(m), diff(m, s),
//   patch(m, ops), atLater(fn) (patches whose objects sent as where they are are looked up after fn), makeShared(n, bytes), attach(sh, me, n), writes(m) (thinking is about to change another unit's mob),
//   refsOn() (the codec's entity sets taken afresh: tools/perf/onevillage.js diffs mobs outside a split) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const now = () => performance.now();

// ---------------------------------------------------------------- the codec: plain JSON, entities by reference
// Fields never sent: drawing and animation (as js/statehash.js), the region index's own slots (_ri, _rs: each replica's index), caches
// (_res: a villager's reserve, js/market.js), the tick's previous position (keepPrev: every replica sets it), a request's callbacks.
const SKIP = new Set(["def", "root", "model", "meshes", "material", "mesh", "geo", "geometry", "walkPhase", "walkAmt", "headYaw", "headPitch",
  "prevPos", "prevYaw", "lerp", "badgeMesh", "label", "sprite", "particles", "puffs", "fx", "wg", "_ri", "_rs", "_res", "prev", "cbs", "_r", "_tm",
  "_lvK", "_lvV", "_lvG", "_lsK", "_lsV", "_lsG", "_lhK", "_lhV", "_lhG", "_laK", "_laV", "_laG", "_idK", "_idN"]);   // (and each replica's own caches on mobs: js/ids.js links, js/regiontick.js ids, r15-61)
const skipKey = k => SKIP.has(k) || (k.charCodeAt(0) === 95 && k.startsWith("_snd"));
let mobSet = null, recSet = null, dropSet = null, hiveSet = null, self = null;
function refsOn() {
  mobSet = new Set(BF.mobs ? BF.mobs.list : []);
  recSet = new Set(BF.mobs && BF.mobs.villages ? BF.mobs.villages.values() : []);
  dropSet = new Set(BF.drops && BF.drops.list ? BF.drops.list : []);
  hiveSet = new Set(BF.bees && BF.bees.homes ? BF.bees.homes() : []);   // (bee homes: a beekeeper's job points at one, js/bees.js keeps it)
  shared = null;
}
const isEntity = v => v !== self && (mobSet.has(v) || recSet.has(v) || dropSet.has(v) || hiveSet.has(v) || (BF.player && v === BF.player));
function entRef(v) {
  if (BF.player && v === BF.player) return { "@p": 1 };
  if (recSet.has(v)) return { V: v.key };
  if (dropSet.has(v)) return { D: v.key };
  if (hiveSet.has(v)) return { H: [v.x, v.y, v.z] };
  return { "@": v.id };
}
const PROTO = () => [BF.ids && BF.ids.Refs, BF.ids && BF.ids.MobRef];
function num(v) {
  if (v !== 0 && v - v === 0) return v;   // (finite, not zero: the usual case)
  if (v === 0) return 1 / v < 0 ? { n: "-0" } : 0;
  return { n: v !== v ? "NaN" : v > 0 ? "Inf" : "-Inf" };
}
// v as plain JSON. Inside one call an object met again is {"~": n} (the n-th object written); the mob being sent (self) is {"@s": 1}.
function enc(v, me) { const prev = self; if (me !== undefined) self = me; try { return encV(v, new Map()); } finally { self = prev; } }
function encV(v, seen) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "number") return num(v);
  if (t === "string" || t === "boolean") return v;
  if (t !== "object") return { u: 1 };   // undefined (functions are left out by the callers)
  if (v === self) return { "@s": 1 };
  if (isEntity(v)) return entRef(v);
  if (v.isVector3) return { v3: [num(v.x), num(v.y), num(v.z)] };
  if (v.isObject3D || v.isMaterial || v.isBufferGeometry || v.isTexture) return null;
  const was = seen.get(v);
  if (was !== undefined) return { "~": was };
  if (pathCtx && !pathCtx.off) {
    const at = pathCtx.find(v);
    if (at) { pathCtx.off++; try { return { "@at": at[0], k: at[1], f: encV(v, seen) }; } finally { pathCtx.off--; } }   // (its copy written plainly)
  }
  seen.set(v, seen.size);
  if (ArrayBuffer.isView(v)) return { ta: v.constructor.name, d: Array.from(v, num) };
  if (Array.isArray(v)) { const a = new Array(v.length); for (let i = 0; i < v.length; i++) { const x = v[i]; a[i] = typeof x === "function" ? null : encV(x, seen); } return a; }
  if (v instanceof Map) { const a = []; for (const [k, x] of v) if (typeof x !== "function") a.push([encV(k, seen), encV(x, seen)]); return { m: a }; }
  if (v instanceof Set) { const a = []; for (const x of v) a.push(encV(x, seen)); return { s: a }; }
  const o = {};
  for (const k of Object.keys(v)) { if (skipKey(k)) continue; const x = v[k]; if (typeof x === "function") continue; o[k] = encV(x, seen); }
  const p = Object.getPrototypeOf(v), P = PROTO();
  return p === P[0] ? { o, p: 1 } : p === P[1] ? { o, p: 2 } : { o };
}
const NUMS = { "-0": -0, NaN: NaN, Inf: Infinity, "-Inf": -Infinity };
let decSelf = null;
function dec(e, me) { const prev = decSelf; if (me !== undefined) decSelf = me; try { return decV(e, []); } finally { decSelf = prev; } }
// decAll(e) -> [value, the objects it made] (clusters, js/cworkers.js: a handed-over mob's fresh objects are merged into the old ones)
function decAll(e) { const objs = [], prev = decSelf; decSelf = null; try { return [decV(e, objs), objs]; } finally { decSelf = prev; } }
function decV(e, objs) {
  if (e === null || typeof e !== "object") return e;
  if (Array.isArray(e)) { const a = new Array(e.length); objs.push(a); for (let i = 0; i < e.length; i++) { const x = a[i] = decV(e[i], objs); if (pend && pend.has(x)) placed(a, i, x); } return a; }
  if (e.o !== undefined) {
    const P = PROTO(), o = e.p === 1 ? Object.create(P[0]) : e.p === 2 ? Object.create(P[1]) : {};
    objs.push(o);
    for (const k in e.o) { const x = o[k] = decV(e.o[k], objs); if (pend && pend.has(x)) placed(o, k, x); }   // own fields (the links' ids: villageId, mobId...), not through the accessors
    return o;
  }
  if (e.n !== undefined) return NUMS[e.n];
  if (e.u !== undefined) return undefined;
  if (e["@"] !== undefined) return BF.ids.get(e["@"]);
  if (e["@s"] !== undefined) return decSelf;
  if (e["@p"] !== undefined) return BF.player;
  if (e.V !== undefined) return BF.mobs.villages.get(e.V);
  if (e.D !== undefined) return BF.drops.get(e.D);
  if (e.H !== undefined) return BF.bees.homeAt(e.H[0], e.H[1], e.H[2]);
  if (e.v3 !== undefined) return new THREE.Vector3(decV(e.v3[0], objs), decV(e.v3[1], objs), decV(e.v3[2], objs));
  if (e["~"] !== undefined) return objs[e["~"]];
  if (e["@at"] !== undefined) {   // (the copy is read either way: it numbers objects for "~")
    const copy = decV(e.f, objs), root = decV(e["@at"], objs);
    if (pend && copy !== null && typeof copy === "object") { pend.set(copy, [root, e.k]); return copy; }   // (atLater: looked up once every change is in)
    const o = walkTo(root, e.k); return o !== undefined ? o : copy;
  }
  if (e.ta !== undefined) { const C = globalThis[e.ta] || Float64Array, a = new C(e.d.length); objs.push(a); for (let i = 0; i < e.d.length; i++) a[i] = decV(e.d[i], objs); return a; }
  if (e.m !== undefined) { const m = new Map(); objs.push(m); for (const [k, x] of e.m) { const kk = decV(k, objs), v = decV(x, objs); m.set(kk, v); if (pend && pend.has(v)) placed(m, kk, v); } return m; }
  if (e.s !== undefined) { const s = new Set(); objs.push(s); for (const x of e.s) s.add(decV(x, objs)); return s; }
  return undefined;
}
// atLater(fn): fn applies several workers' changes (js/cworkers.js, a meeting); an object sent as where it is ({"@at"}) is looked up there
// only after all of them are in. The paths are the sender's after its changes: looked up halfway (a buyer's deal patched before the
// seller's rebuilt offers), [i] would be another offer than the one meant. Meanwhile its copy stands in, and where it was put is kept.
let pend = null, fixes = null;
function placed(c, k, x) { fixes.push([c, k, x]); }
function atLater(fn) {
  const pp = pend, pf = fixes;
  pend = new Map(); fixes = [];
  try { fn(); }
  finally {
    const P = pend, F = fixes;
    pend = pp; fixes = pf;
    for (const [c, k, copy] of F) {
      const [root, keys] = P.get(copy), o = walkTo(root, keys);
      if (o === undefined || o === copy) continue;
      if (c instanceof Map) { if (c.get(k) === copy) c.set(k, o); } else if (c[k] === copy) c[k] = o;
    }
  }
}

// Objects that live inside an entity (a request's data pointing into its sender, such as a trade's escrow entry and the asker's slot
// in its asks, js/trading.js buy; a villager's offer another villager's deal points at) are sent as where they are, {"@at": the
// entity, k: [keys]}, with a copy (f) in case it isn't there: the other worker uses its own object there, so the request changes the
// same object it would on one worker. pathCtx.find(obj) -> [entity ref, keys] or null, for the roots given and every villager's offers.
let pathCtx = null, shared = null;
// The objects of every village record and every villager's offers, by where they are: built once an exchange, when first needed
// (refsOn starts it over). A mob's diff and a request's data point at these instead of copying them.
// An index entry is [entity ref, parent entry or null, key]; pathOf turns it into [entity ref, keys] when one is found.
// RW.indexScope ({mobs, recs}: clusters on several workers, js/cworkers.js): only those, the ones this worker ran (no others are reachable
// from them between meetings).
function sharedIndex() {
  if (shared) return shared;
  shared = new Map();
  const sc = RW.indexScope, itMobs = sc ? sc.mobs : mobSet, itRecs = sc ? sc.recs : recSet;
  // the villagers' offers first: an offer is the villager's own object, and a village record that keeps one too (a cache of the market)
  // has it by reference on this worker only; on the others that place holds a copy, so a request pointing there would miss the offer
  for (const m of itMobs) if (m.trades && Array.isArray(m.trades)) {
    let top = null;
    for (let i = 0; i < m.trades.length; i++) { const o = m.trades[i]; if (o && typeof o === "object" && !shared.has(o)) shared.set(o, [{ "@": m.id }, top || (top = [{ "@": m.id }, [{ "@": m.id }, null, null], "trades"]), i]); }   // (m, then .trades, then [i])
  }
  for (const rec of itRecs) indexTree(rec, [{ V: rec.key }, null, null], shared, 0);
  // then every mob's own plain objects, one level down: a task that holds another mob's record (a stable keeper's catch holds the horse's
  // m.horse, js/stables.js) must point at it there, or the other workers keep a copy that the horse's own changes never reach
  for (const m of itMobs) {
    let top = null;
    for (const k in m) {
      const o = m[k];
      if (!o || typeof o !== "object" || Array.isArray(o) || shared.has(o) || mobSet.has(o)) continue;
      const pr = Object.getPrototypeOf(o);
      if (pr !== Object.prototype && !(BF.ids && BF.ids.isRefs(o))) continue;
      shared.set(o, [{ "@": m.id }, top || (top = [{ "@": m.id }, null, null]), k]);
    }
  }
  return shared;
}
function topOf(e) { let x = e; while (x[1] && x[1][1] !== null) x = x[1]; return x[1] ? x[2] : null; }   // the first key of an entry's path
function pathOf(e) {
  const keys = [];
  for (let x = e; x && x[1] !== null; x = x[1]) keys.push(x[2]);
  if (e[1] === null) return null;   // (the entity itself)
  return [e[0], keys.reverse()];
}
// fn() with references on: inside the roots given (a request's sender, the mobs it names), then the shared index; never into `not` (the
// mob being diffed: its own objects are written where they are), except a plain object it holds under two of its fields, sent from one
// as where the other workers have it already (its place in the shadow, notS, if it is still there) or else as where another field holds
// it (looked up once the whole change is in: atLater); so the two stay one object on the other workers. A baker's slot in its asks and
// its bkr.job.offer hold the same offer, which the seller's list may no longer have (js/trading.js buy; r15-39b C7).
function withPaths(roots, fn, not, notS) {
  const prev = pathCtx;
  let index = null, own = null, was = null;
  const find = obj => {
    const sh = sharedIndex().get(obj);
    if (sh && !(not && sh[0]["@"] === not.id && (topKey == null || topOf(sh) === topKey))) return pathOf(sh);
    if (not && topKey != null && !Array.isArray(obj)) {
      if (!was && notS) { was = new Map(); shadowPaths(notS, [], was, 0); }
      const p = was && was.get(obj);
      if (p && p[0] !== topKey && walkTo(not, p) === obj) return [{ "@s": 1 }, p];
      if (!own) own = ownPaths(not);
      const l = own.get(obj), e = l && l.find(e => topOf(e) !== topKey);
      if (e) return pathOf(e);
    }
    if (!roots.length) return null;
    if (!index) { index = new Map(); for (const r of roots) if (r && typeof r === "object") indexTree(r, [rootRef(r), null, null], index, 0); }
    const e = index.get(obj);
    return e ? pathOf(e) : null;
  };
  pathCtx = { find, off: 0 };
  try { return fn(); } finally { pathCtx = prev; }
}
// a mob's objects by where they are: object -> index entries, the first place under each of its fields
function ownPaths(m) {
  const out = new Map(), root = [{ "@s": 1 }, null, null];
  for (const k of Object.keys(m)) {
    const x = m[k];
    if (skipKey(k) || x === null || typeof x !== "object") continue;
    const idx = new Map();
    indexOne(k, x, root, idx, 0);
    for (const [o, e] of idx) { const l = out.get(o); if (l) l.push(e); else out.set(o, [e]); }
  }
  return out;
}
// the objects of a shadow by their keys from its root (the first place each is met), as the other workers hold them
function shadowPaths(s, at, out, d) {
  if (d > 12) return;
  const one = (k, c) => { if (c instanceof Shadow && c.K !== 3 && c.K !== 4 && !out.has(c.o)) { const p = at.concat([k]); out.set(c.o, p); shadowPaths(c, p, out, d + 1); } };
  if (s.K === 2) { for (const [k, c] of s.m) if (typeof k !== "object") one(k, c); return; }
  if (s.K === 1) { for (let i = 0; i < s.vs.length; i++) one(i, s.vs[i]); return; }
  if (s.ks) for (let i = 0; i < s.ks.length; i++) one(s.ks[i], s.vs[i]);
}
const rootRef = r => (BF.player && r === BF.player) ? { "@p": 1 } : recSet.has(r) ? { V: r.key } : { "@": r.id };
function indexTree(v, at, index, d) {
  if (d > 12) return;
  const K = kind(v);
  if (K === 2) { for (const [k, x] of v) if (typeof k !== "object") indexOne(k, x, at, index, d); return; }
  if (K === 3 || K === 4) return;
  if (K === 1) { for (let i = 0; i < v.length; i++) indexOne(i, v[i], at, index, d); return; }
  for (const k of Object.keys(v)) if (!skipKey(k)) { const x = v[k]; if (typeof x === "object" && x !== null) indexOne(k, x, at, index, d); }
}
function indexOne(k, x, at, index, d) {
  if (x === null || typeof x !== "object" || x.isVector3 || index.has(x) || mobSet.has(x) || recSet.has(x) || dropSet.has(x) || hiveSet.has(x)) return;
  if (ArrayBuffer.isView(x) || isGfx(x)) return;
  const e = [at[0], at, k];
  index.set(x, e);
  indexTree(x, e, index, d + 1);
}
function walkTo(o, keys) {
  for (const k of keys) {
    if (o === null || typeof o !== "object") return undefined;
    o = o instanceof Map ? o.get(k) : o[k];
  }
  return o === null || typeof o !== "object" ? undefined : o;
}
// a request's data, with objects inside its sender (and inside the mobs and villages it names) sent as where they are
function encData(req) {
  const roots = [req._tm || (BF.ids && BF.ids.get(req.from))];
  const d = req.data;
  if (d && typeof d === "object") for (const k of Object.keys(d)) { const x = d[k]; if (x && typeof x === "object" && (mobSet.has(x) || recSet.has(x))) roots.push(x); }
  const prev = self; self = null;
  try { return withPaths(roots, () => encV(d, new Map())); } finally { self = prev; }
}

// encMany(list): several entities' own fields (plain copies) in one call, for another worker to take whole (clusters with partial
// copies, js/cworkers.js handovers): an object two of them share stays one object, and one that lives inside a village record (every
// worker's records are current) is sent as where it is there, so it stays the record's object too. Decode with dec inside atLater.
function encMany(list) {
  const prev = self, ps = RW.indexScope;
  self = null; RW.indexScope = { mobs: new Set(), recs: recSet }; shared = null;
  try { return withPaths([], () => encV(list, new Map())); } finally { self = prev; RW.indexScope = ps; shared = null; }
}

// ---------------------------------------------------------------- shadows: what the other workers have of a mob, to send only changes
// A Shadow mirrors an object: o (the live object it stands for), K its kind, and its children (each a primitive, a Shadow, or an EntRef):
// an object's keys in ks with their children in vs (in the object's key order, skipped keys kept with SKIPPED so the order lines up), an
// array's children in vs, a Map's in m (key -> child), a typed array's or Set's contents copied in c. The owner of a mob keeps one for it
// (snap), and after the mob thinks, diff(m, shadow) gives the changes and brings the shadow up to date:
//   ops = [[key, 0, value]  set (the value encoded, a new object in full)
//          [key, 1, ops]    the same object, changed inside
//          [key, 2]]        deleted
// (For a Map the key is encoded; for an array "length" is a key too.) patch(obj, ops) applies them on another worker.
// Diffing is most of the exchange's cost (every owned mob, twice a tick), so the usual case is kept cheap: an object whose keys are the
// same as last time, in the same order, compares child by child, and a child that is the same object as last time recurses without
// asking whether it has become an entity.
class Shadow { constructor(o, K) { this.o = o; this.K = K; this.ks = null; this.vs = null; this.m = null; this.c = null; this.fn = null; } }
class EntRef { constructor(e) { this.e = e; } }
const SKIPPED = Symbol("skipped");
const kind = v => {
  if (Array.isArray(v)) return 1;
  const c = v.constructor;
  if (c === Object || c === undefined) return 0;   // (a plain object: the usual case, without the instanceof walks)
  return v instanceof Map ? 2 : v instanceof Set ? 3 : ArrayBuffer.isView(v) ? 4 : 0;
};
const isGfx = v => v.isObject3D || v.isMaterial || v.isBufferGeometry || v.isTexture;
// a child's shadow: a primitive as it is, an entity by reference, drawing objects as null
function child(x) {
  if (x === null || typeof x !== "object") return typeof x === "function" ? null : x;
  if (x === self || isEntity(x)) return new EntRef(x);
  if (isGfx(x)) return null;
  return snapV(x, false);
}
function snapV(v, top) {
  if (v === null || typeof v !== "object") return v;
  if (!top && (v === self || isEntity(v))) return new EntRef(v);
  if (isGfx(v)) return null;
  const K = kind(v), s = new Shadow(v, K);
  if (K === 4) { s.c = v.slice(); return s; }
  if (K === 3) { s.c = [...v]; return s; }
  if (K === 2) { s.m = new Map(); for (const [k, x] of v) if (typeof x !== "function") s.m.set(k, child(x)); return s; }
  if (K === 1) { s.vs = new Array(v.length); for (let i = 0; i < v.length; i++) s.vs[i] = child(v[i]); return s; }
  const ks = Object.keys(v), vs = new Array(ks.length);
  for (let i = 0; i < ks.length; i++) { const k = ks[i], x = v[k]; vs[i] = skipKey(k) || typeof x === "function" ? SKIPPED : child(x); }
  s.ks = ks; s.vs = vs;
  return s;
}
function snap(m) { const prev = self; self = m; try { return snapV(m, true); } finally { self = prev; } }
// one child against its old shadow: pushes an op when it changed, returns its shadow now
function diffChild(old, x, ops, keyOut) {
  if (x === null || typeof x !== "object") {
    if (typeof x === "function") x = null;
    if (old === x && (x !== 0 || 1 / old === 1 / x)) return old;
    if (x !== x && old !== old && typeof old === "number") return old;   // (NaN)
    ops.push([keyOut, 0, x === undefined ? { u: 1 } : typeof x === "number" ? num(x) : x]);
    return x;
  }
  if (old instanceof Shadow && old.o === x) { const sub = diffV(x, old); if (sub) ops.push([keyOut, 1, sub]); return old; }
  if (old instanceof EntRef && old.e === x) return old;
  if (old instanceof Shadow && old.K === 1 && Array.isArray(x) && x !== self && !isEntity(x)) {   // a list made anew (v.trades = v.trades.filter(...)):
    old.o = x;                                                                                   // its changes from the old one, so objects
    const sub = diffV(x, old);                                                                   // kept in it stay the other workers' own
    ops.push([keyOut, 4, sub || []]);
    return old;
  }
  if (x === self || isEntity(x)) { ops.push([keyOut, 0, x === self ? { "@s": 1 } : entRef(x)]); return new EntRef(x); }
  if (isGfx(x)) return old === null ? old : null;
  ops.push([keyOut, 0, encV(x, new Map())]);
  return snapV(x, false);
}
function sameArr(c, v) {
  if (!c || c.length !== v.length) return false;
  for (let i = 0; i < v.length; i++) if (c[i] !== v[i] && !(c[i] !== c[i] && v[i] !== v[i])) return false;
  return true;
}
function diffV(v, s) {
  const K = s.K;
  if (K === 4) {   // a typed array: whole when it changed
    if (sameArr(s.c, v)) return null;
    s.c = v.slice(); return [["*", 0, encV(v, new Map())]];
  }
  if (K === 3) {   // a Set: whole when it changed
    const c = s.c;
    let same = c.length === v.size;
    if (same) { let i = 0; for (const x of v) if (c[i++] !== x) { same = false; break; } }
    if (same) return null;
    s.c = [...v]; return [["*", 0, encV(v, new Map())]];
  }
  const ops = [];
  if (K === 1) {
    const vs = s.vs, n = vs.length;
    const moved = movedFrom(v, vs);
    for (let i = 0; i < v.length; i++) {
      const x = v[i], old = i < n ? vs[i] : SKIPPED, was = moved && !(old instanceof Shadow && old.o === x) ? moved.get(x) : undefined;
      if (was) { moved.delete(x); const sub = diffV(x, was[1]); ops.push(sub ? [i, 3, was[0], sub] : [i, 3, was[0]]); vs[i] = was[1]; continue; }
      vs[i] = diffChild(old, x, ops, i);
    }
    if (n > v.length) { vs.length = v.length; ops.push(["length", 0, v.length]); }
    return ops.length ? ops : null;
  }
  if (K === 2) {
    const m = s.m;
    let seen = 0;
    for (const [k, x] of v) {
      if (typeof x === "function") continue;
      const had = m.has(k);
      if (had) seen++;
      const old = had ? m.get(k) : SKIPPED, now = diffChild(old, x, ops, k !== null && typeof k === "object" ? encV(k, new Map()) : typeof k === "number" ? num(k) : k);
      if (now !== old) m.set(k, now);
    }
    if (seen < m.size) for (const k of [...m.keys()]) if (!v.has(k)) { m.delete(k); ops.push([encV(k, new Map()), 2]); }
    return ops.length ? ops : null;
  }
  const ks = Object.keys(v), oks = s.ks, vs = s.vs;
  let same = ks.length === oks.length;
  for (let i = 0; same && i < ks.length; i++) if (ks[i] !== oks[i]) same = false;
  const fn = same && (s.fn || (s.fn = cmpFor(ks)));
  if (fn) {   // the usual case: the same keys in the same order
    fn(v, vs, ops, v === self);
    return ops.length ? ops : null;
  }
  // keys added, deleted or reordered: by name
  const at = new Map();
  for (let i = 0; i < oks.length; i++) at.set(oks[i], vs[i]);
  const nvs = new Array(ks.length);
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i], x = v[k];
    if (skipKey(k)) { nvs[i] = SKIPPED; continue; }
    const old = at.has(k) ? at.get(k) : SKIPPED;
    at.delete(k);
    if (v === self) topKey = k;
    nvs[i] = typeof x === "function" ? SKIPPED : diffChild(old, x, ops, k);
  }
  for (const [k, old] of at) if (old !== SKIPPED) ops.push([k, 2]);
  s.ks = ks; s.vs = nvs; s.fn = null;
  return ops.length ? ops : null;
}
// An array's objects that moved to another index since its shadow (a seller's offers, rebuilt in a new order by js/market.js sync,
// with a buyer's deal pointing at one): object -> [old index, its shadow], or null when none did. Sent as [i, 3, old index, ops]: the
// other workers move their own object there, so links into it stay links (a copy at the new index would leave the deal on an object no
// longer in the list).
function movedFrom(v, vs) {
  let any = false;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === null || typeof x !== "object") continue;
    const old = i < vs.length ? vs[i] : SKIPPED;
    if (!(old instanceof Shadow && old.o === x) && !(old instanceof EntRef && old.e === x)) { any = true; break; }
  }
  if (!any) return null;
  let m = null;
  for (let j = 0; j < vs.length; j++) { const o = vs[j]; if (o instanceof Shadow && o.K !== 4 && o.K !== 3 && !(m && m.has(o.o))) (m || (m = new Map())).set(o.o, [j, o]); }
  return m;
}
// The usual case's compare, made once for each list of keys (shared by every object with those keys: a mob's 150 fields, its ai table's
// 50): each field read by name, which is many times faster than v[k] with k changing (a lookup through V8's megamorphic cache each time),
// and only a child that differs from its shadow, an object or a zero (+0 / -0) goes on to keyChild. Skipped keys are left out. Same ops,
// same order as reading the keys one by one.
const cmps = new Map();
const seenKs = new Map();   // key list -> uses before it is compiled (an object with keys of its own, a cell table, is compared by name)
function cmpFor(ks) {
  const id = ks.join("\u0001");
  let fn = cmps.get(id);
  if (fn) return fn;
  const u = (seenKs.get(id) || 0) + 1;
  if (u < 3) { if (seenKs.size > 20000) seenKs.clear(); seenKs.set(id, u); return null; }
  seenKs.delete(id);
  const body = ["let x, o;"];
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    if (skipKey(k)) continue;
    const ref = JSON.stringify(k);
    body.push(`x = v[${ref}]; o = vs[${i}]; if (x !== o || x === 0 || (typeof x === "object" && x !== null)) keyChild(vs, ${i}, ${ref}, x, ops, top);`);
  }
  fn = new Function("keyChild", "return function cmp(v, vs, ops, top) {\n" + body.join("\n") + "\n};")(keyChild);
  if (cmps.size < 4000) cmps.set(id, fn);
  return fn;
}
function keyChild(vs, i, k, x, ops, top) {
  if (typeof x === "function") { vs[i] = SKIPPED; return; }   // (methods are each worker's own)
  if (top) topKey = k;
  vs[i] = diffChild(vs[i], x, ops, k);
}
// topKey: the mob's own field being diffed. An object of its own is written where it is, except one met under another field (a seller's
// slot in its asks pointing at one of its own offers): that is sent as where it lives, so the other workers keep the two the same object
let topKey = null;
function diff(m, s) { const prev = self, pk = topKey; self = m; topKey = null; try { return recSet.has(m) ? diffV(m, s) : withPaths([], () => diffV(m, s), m, s); } finally { self = prev; topKey = pk; } }

// patch(obj, ops) on a replica: the same changes, in place, so links into the object stay as they are
function patchV(o, ops) {
  const K = kind(o);
  const before = K === 1 && ops.some(op => op[1] === 3) ? o.slice() : null;   // (moves read where things were before this patch)
  for (const op of ops) {
    if (op[0] === "*") return decV(op[2], []);   // (a typed array or Set sent whole: the caller puts it in place)
    const key = K === 2 ? decV(op[0], []) : op[0];
    if (op[1] === 2) { if (K === 2) o.delete(key); else if (o === decSelf) o[key] = undefined; else delete o[key]; continue; }   // (never delete a mob's own field: V8's dictionary mode)
    if (op[1] === 4) {   // a new array: a copy of the one there, changed by op[2]
      const cur = K === 2 ? o.get(key) : o[key];
      if (!Array.isArray(cur)) throw new Error("region workers: no list at " + key + " to copy");
      const copy = cur.slice();
      patchV(copy, op[2]);
      if (K === 2) o.set(key, copy); else o[key] = copy;
      continue;
    }
    if (op[1] === 3) {   // an array's object moved from index op[2], changed inside by op[3]
      const cur = before[op[2]];
      if (cur === null || typeof cur !== "object") throw new Error("region workers: no object at " + op[2] + " to move to " + key);
      o[key] = cur;
      if (op[3]) { const whole = patchV(cur, op[3]); if (whole !== undefined) o[key] = whole; }
      continue;
    }
    if (op[1] === 1) {
      const cur = K === 2 ? o.get(key) : o[key];
      if (cur === null || typeof cur !== "object") throw new Error("region workers: no object at " + key + " to change");
      const whole = patchV(cur, op[2]);
      if (whole !== undefined) { if (K === 2) o.set(key, whole); else o[key] = whole; }
      continue;
    }
    const val = decV(op[2], []);
    if (K === 2) o.set(key, val); else o[key] = val;
    if (pend && pend.has(val)) placed(o, key, val);
  }
  return undefined;
}
function patch(m, ops) { const prev = decSelf; decSelf = m; try { patchV(m, ops); } finally { decSelf = prev; } }

// ---------------------------------------------------------------- the transport: mailboxes and a barrier in shared memory
// makeShared(n, bytes) -> {ctl, boxes}: what every worker attaches to (posted to each as it starts). ctl (Int32): [0] the barrier's
// generation, [1] how many have arrived, [2] stop (a worker crashed or stopped), [3] the worker that stopped + 1, then each worker's
// message length for the two halves of its mailbox. A worker writes its message into one half while the others may still read the
// last one from the other half; the barrier keeps every worker within one exchange of the others.
const CTL = 8;
function makeShared(n, bytes) {
  bytes = bytes || 64 << 20;
  const boxes = [];
  for (let i = 0; i < n; i++) boxes.push(new SharedArrayBuffer(bytes));
  return { n, bytes, ctl: new SharedArrayBuffer((CTL + 2 * n) * 4), boxes };
}
const TE = new TextEncoder(), TD = new TextDecoder();
const SPIN = 20000, TIMEOUT = 120000;
function attach(sh, me, n) {
  const C = new Int32Array(sh.ctl), half = sh.bytes >> 1;
  const views = sh.boxes.map(b => new Uint8Array(b));
  let round = 0, scratch = new Uint8Array(1 << 16);
  const link = {
    me, n, waitMs: 0, bytesOut: 0, bytesIn: 0,
    stopped: () => Atomics.load(C, 2) !== 0,
    stop(who) { if (Atomics.compareExchange(C, 2, 0, 1) === 0) Atomics.store(C, 3, (who == null ? me : who) + 1); Atomics.add(C, 0, 1); Atomics.notify(C, 0); },
    who: () => Atomics.load(C, 3) - 1,
    barrier() {
      const g = Atomics.load(C, 0);
      if (Atomics.load(C, 2)) throw stopErr();
      if (Atomics.add(C, 1, 1) === n - 1) { Atomics.store(C, 1, 0); Atomics.add(C, 0, 1); Atomics.notify(C, 0); return; }
      for (let i = 0; i < SPIN; i++) if (Atomics.load(C, 0) !== g) { if (Atomics.load(C, 2)) throw stopErr(); return; }
      const t0 = now();
      while (Atomics.load(C, 0) === g) {
        Atomics.wait(C, 0, g, 1000);
        if (now() - t0 > TIMEOUT) { link.stop(); throw new Error("region workers: no answer from the other workers in " + TIMEOUT / 1000 + " s"); }
      }
      if (Atomics.load(C, 2)) throw stopErr();
    },
    // mine (a string) to every other worker; returns every worker's, by index (mine included)
    exchange(mine) {
      const h = round++ & 1, v = views[me], at = h * half;
      if (scratch.length < Math.min(half, mine.length * 3)) scratch = new Uint8Array(Math.min(half, Math.max(mine.length * 3, scratch.length * 2)));
      const r = TE.encodeInto(mine, scratch);   // (browsers' encodeInto takes no shared memory either: encoded here, then copied in)
      if (r.read < mine.length) { link.stop(); throw new Error("region workers: a message of " + mine.length + " characters is too big for the mailbox"); }
      v.set(scratch.subarray(0, r.written), at);
      Atomics.store(C, CTL + me * 2 + h, r.written);
      link.bytesOut += r.written;
      const t0 = now();
      link.barrier();
      link.waitMs += now() - t0;
      const out = new Array(n);
      for (let w = 0; w < n; w++) {
        if (w === me) { out[w] = mine; continue; }
        const len = Atomics.load(C, CTL + w * 2 + h), src = views[w].subarray(h * half, h * half + len), copy = new Uint8Array(len);
        copy.set(src);   // (TextDecoder takes no shared memory)
        out[w] = TD.decode(copy);
        link.bytesIn += len;
      }
      return out;
    },
  };
  const stopErr = () => { const e = new Error("region workers stopped: worker " + link.who() + " crashed or stopped"); e.rwStop = true; return e; };
  return link;
}

// ---------------------------------------------------------------- the tick
const REBALANCE = 100;   // ticks between owner plans
const SOLO_MS = 0.6;     // below this much thinking a tick (all workers' regions together) every region goes to the leader
const RW = {
  active: false, n: 1, me: 0, link: null, verify: 0, shuffle: 0,
  owners: new Map(),   // region key -> worker (the same on every worker)
  solo: false,
};
let shadows = new Map();   // mob -> Shadow, for the mobs this worker thinks
let recShadows = new Map(), recDirty = new Set();   // village record -> Shadow, for the villages this worker owns
let mine = [], idxOf = new Map(), cur = null, curK = 0, base = 0, own = [], cbMobs = new Set(), dSends = [], base2 = 0;
let curRegion = null, regionT0 = 0;
const load = new Map();   // unit (region key or "v:" village key) -> ms thought here since the last plan
const T = { ticks: 0, think: 0, x1: 0, rest: 0, x2: 0, mobs: 0, regions: 0, bytes: 0 };
let tA = 0, tB = 0, peers = [], hourAt = null, hourT = null;
let logCap = null, fxCap = null;

// Units of work: a village's members and its pen animals go together, with the village's record ("v:" + its key), wherever they stand,
// because thinking changes the village record (its farm plans, coops, caches built on first use); every other mob goes with its region
// (a number). Like Folia's merged regions: whatever acts on shared state ticks on one worker.
const PEN_KEYS = ["penKey", "coopKey", "styKey", "pastureKey"];   // ("coop:<village key>|<building>": a pen animal's place, js/ids.js)
// Animals a villager is working on (a keeper fetching, feeding or leading a wild chicken, sheep, cow, pig or horse): with that villager's
// village, so the keeper and the animal think on one worker in their order, as on one (its thinking changes the animal and reads it back).
// Built from the start of the tick's state at beginThink, the same on every worker. mob id -> village key.
const TASKS = ["pkp", "shp", "cwk", "pgk", "stb"];
let claimed = new Map();
function claims() {
  claimed = new Map();
  for (const m of BF.regions ? BF.regions.ofType("villager") : BF.mobs.list) {
    if (m.type !== "villager" || m.villageId == null || m.dead || m.removed) continue;
    for (const f of TASKS) { const t = m[f] && m[f].task; if (t && t.mobId != null && !claimed.has(t.mobId)) claimed.set(t.mobId, m.villageId); }
  }
}
function unitOf(m, k) {
  let v = m.villageId != null ? m.villageId : m.penVillageId;
  if (v == null && claimed.size) { const c = claimed.get(m.id); if (c != null) v = c; }
  if (v == null) for (const f of PEN_KEYS) {
    const p = m[f];
    if (typeof p !== "string") continue;
    const i = p.indexOf(":"), j = p.indexOf("|", i);
    if (i >= 0) { v = j > i ? p.slice(i + 1, j) : p.slice(i + 1); break; }
  }
  const r = v == null && m.horse;   // a horse: its stable's village (owner "stable:<village key>"), or the villager leading it (js/stables.js writes its record)
  if (r) {
    if (typeof r.owner === "string" && r.owner.startsWith("stable:")) v = r.owner.slice(7);
    else if (r.lead && r.lead.kind === "mob" && r.lead.mob && r.lead.mob.villageId != null) v = r.lead.mob.villageId;
  }
  return v != null ? "v:" + v : k;
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
// The owner of a unit: its planned worker, else spread by key (the same on every worker).
const ownerOf = u => {
  if (u === -1 || u == null) return 0;
  const w = RW.owners.get(u);
  if (w !== undefined) return w;
  return RW.solo ? 0 : (typeof u === "number" ? u : strHash(u)) % RW.n;
};

function capture(on) {
  if (RW.me === 0) return;   // the leader keeps its own
  if (on) {
    logCap = []; fxCap = [];
    if (BF.glog) BF.glog.remote(list => { for (const e of list) logCap.push(e); });
    if (BF.fx && !BF.fx._rw) { const emit = BF.fx.emit; BF.fx.emit = e => (fxCap ? fxCap.push(e) : emit(e)); BF.fx._rw = emit; }
  } else {
    if (BF.glog) BF.glog.remote(null);
  }
}
function takeCaps() { const l = logCap || [], f = fxCap || []; logCap = fxCap = null; return [l, f]; }

// the plan of this tick (js/regiontick.js plan, its spans) -> the mobs this worker thinks, in plan order
function beginThink(order) {
  const t = now();
  if (tB) T.rest += t - tB;
  tA = t;
  T.ticks++;
  refsOn();
  const sp = BF.rtick ? BF.rtick.spans : [-1, 0];
  claims();
  mine = []; idxOf = new Map(); own = []; kOf.clear();
  const units = new Set();
  for (let i = 0; i < sp.length; i += 2) {
    const k = sp[i], a = sp[i + 1], b = i + 3 < sp.length ? sp[i + 3] : order.length;
    for (let j = a; j < b; j++) {
      const m = order[j], u = unitOf(m, k);
      if (ownerOf(u) !== RW.me) continue;
      units.add(u); idxOf.set(m, j); mine.push(m);
    }
  }
  T.mobs = mine.length; T.regions = units.size;
  // the villages this worker owns: new shadows for records new to it, the others' dropped. Every shadow is brought up to date with what
  // the rest of the last tick changed on every worker alike (a diff whose ops go nowhere), so the diff after thinking holds what thinking
  // changed and nothing else: a value the rest of the tick changed and thinking changed back (a deal undone by the next trade) would
  // otherwise look unchanged, and the other workers would keep the middle value
  for (const rec of BF.mobs.villages.values()) {
    if (ownerOf("v:" + rec.key) !== RW.me) { recShadows.delete(rec); continue; }
    const s = recShadows.get(rec);
    if (!s) recShadows.set(rec, snap(rec)); else diff(rec, s);
  }
  for (const rec of recShadows.keys()) if (BF.mobs.villages.get(rec.key) !== rec) recShadows.delete(rec);
  // a shadow for each mob new to this worker (the others have it as it is now), the others' brought up to date (above); shadows of mobs
  // another worker thinks now are dropped
  for (const m of mine) { const s = shadows.get(m); if (!s) shadows.set(m, snap(m)); else diff(m, s); }
  if (shadows.size > mine.length) for (const m of shadows.keys()) if (!idxOf.has(m)) shadows.delete(m);
  base = BF.req.seq;
  BF.req.tap = req => { if (cur) { req._tm = cur; own.push([idxOf.get(cur), curK++, req]); } };
  cur = null; curRegion = null;
  if (RW.audit) auditStart();
  capture(true);
  owning = true;
  return mine;
}
// RW.audit (tests): after each mob thinks, every mob and village record this worker doesn't own is checked for changes. Thinking
// may change only its own mob and its own village; anything else makes the workers' copies differ. Found: RW.audits [{by, what, paths}].
let auditSh = null;
function auditStart() {
  auditSh = new Map();
  for (const m of BF.mobs.list) if (!idxOf.has(m)) auditSh.set(m, snap(m));
  for (const rec of BF.mobs.villages.values()) if (!recShadows.has(rec)) auditSh.set(rec, snap(rec));
}
function auditCheck(by) {
  if (!auditSh || !by) return;
  const list = RW.audits || (RW.audits = []);
  for (const [o, sh] of auditSh) {
    const ops = diff(o, sh);
    if (!ops) continue;
    const who = x => x.type ? x.type + (x.profession ? ":" + x.profession : "") + " " + x.id : "village " + x.key;
    if (list.length < 200) list.push({ by: who(by), what: who(o), ops: JSON.stringify(ops).slice(0, 400), tick: BF.rand.tick });
  }
}
// A mob may think again after the loop (js/mobs.js later: a keeper's change to an animal, spec r15-71): its requests carry on numbering
// from where its own think left off, so they sort as on one worker.
const kOf = new Map();
function thinking(m) {
  if (RW.audit) auditCheck(cur);
  if (cur) kOf.set(cur, curK);
  cur = m; curK = kOf.get(m) || 0;
  const k = unitOf(m, BF.regions ? BF.regions.regionOf(m) : -1), t = now();
  if (k !== curRegion) { if (curRegion != null) load.set(curRegion, (load.get(curRegion) || 0) + t - regionT0); curRegion = k; regionT0 = t; }
}
const reqOut = (e, req) => [e[0], e[1], req.kind, enc(req.target, null), encData(req), req.from, req.tick, req.region == null ? -1 : req.region];
function adoptAll(list, into) {
  for (const r of list) {
    const req = BF.req.adopt({ kind: r[2], target: dec(r[3], null), data: dec(r[4], null), from: r[5], seq: 0, tick: r[6], region: r[7] });
    into.push([r[0], r[1], req]);
  }
}
function patchRecs(list, from) {
  for (const [key, ops] of list) {
    const rec = BF.mobs.villages.get(key);
    if (!rec) { out_of_step("worker " + from + " changed village " + key + ", which this worker doesn't have"); continue; }
    recShadows.delete(rec);
    patch(rec, ops);
  }
}
function recOps(only) {
  const out = [];
  for (const [rec, s] of recShadows) { if (only && !only.has(rec)) continue; const ops = diff(rec, s); if (ops) out.push([rec.key, ops]); }
  return out;
}
function patchMobs(list, from) {
  for (const [id, ops, removed] of list) {
    const m = BF.ids.get(id);
    if (!m || (m.removed && !removed)) { out_of_step("worker " + from + " changed mob " + id + ", which this worker doesn't have"); continue; }
    shadows.delete(m);   // (its owner moved on: a shadow here would be out of date)
    if (ops) patch(m, ops);
    if (removed && !m.removed) BF.mobs.discard(m);
  }
}
function afterThink() {
  if (RW.audit) { auditCheck(cur); auditSh = null; }
  const t = now();
  if (curRegion != null) load.set(curRegion, (load.get(curRegion) || 0) + t - regionT0);
  BF.req.tap = null; cur = null; owning = false;
  T.think += t - tA;
  const [logs, fx] = takeCaps();
  capture(false);
  refsOn();
  const mobs = [];
  for (const m of mine) {
    const s = shadows.get(m);
    if (m.removed) { shadows.delete(m); mobs.push([m.id, null, 1]); continue; }
    const ops = s ? diff(m, s) : null;
    if (ops) mobs.push([m.id, ops]);
  }
  foreignOps(mobs);
  const msg = JSON.stringify({ mobs, recs: recOps(null), touched: takeTouched(), dyn: takeDyn(), reg: takeReg(), reqs: own.map(e => reqOut(e, e[2])), logs, fx, think: +(t - tA).toFixed(3), regions: T.regions, mine: mine.length });
  const all = RW.link.exchange(msg);
  T.bytes += msg.length;
  peers = [];
  const reqs = own.slice();
  for (let w = 0; w < all.length; w++) {
    const p = w === RW.me ? null : JSON.parse(all[w]);
    peers[w] = p ? { think: p.think, regions: p.regions, mobs: p.mine } : { think: +(t - tA).toFixed(3), regions: T.regions, mobs: mine.length };
    if (!p) continue;
    adoptDyn(p.dyn, w);   // (first of all: the changes may hold the new items)
    adoptReg(p.reg);   // (and the places they point at)
    atLater(() => {   // (objects sent as where they are: looked up once the worker's changes are all in)
      patchRecs(p.recs, w);   // (first: a mob's changes may point into its village's record)
      patchMobs(p.mobs, w);
      applyTouched(p.touched);
      adoptAll(p.reqs, reqs);
    });
    if (RW.me === 0) { for (const e of p.logs) BF.glog.put(e); for (const e of p.fx) BF.fx.emit(e); }
  }
  // the tick's think requests numbered in plan order (the mob's place in the plan, then the order it sent them): as on one worker
  reqs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 0; i < reqs.length; i++) { reqs[i][2].seq = base + i; reqs[i][2]._r = undefined; }
  BF.req.seq = base + reqs.length;
  T.x1 += now() - t;
  tB = now();
}
function beforeDeliver() {
  cbMobs = new Set(); dSends = []; recDirty = new Set();
  base2 = BF.req.seq;
  let k = 0, lastI = -2, lastP = -1;
  BF.req.tap = req => {
    const R = BF.req;
    if (R.dIdx !== lastI || R.dPart !== lastP) { lastI = R.dIdx; lastP = R.dPart; k = 0; }
    dSends.push([R.dIdx, R.dPart, k++, req]);
  };
  // a callback is about to run: its mob (and village record) are sent again after deliver
  BF.req.onCbs = req => {
    const m = req._tm;
    if (!m || cbMobs.has(m)) return;
    cbMobs.add(m);
    const s = shadows.get(m);
    if (!s) shadows.set(m, snap(m)); else diff(m, s);   // (up to date with the apply phase, as at beginThink)
    const u = unitOf(m, -1), rec = typeof u === "string" ? BF.mobs.villages.get(u.slice(2)) : null;   // (and its village's record, which it may change)
    if (rec && recShadows.has(rec) && !recDirty.has(rec)) { recDirty.add(rec); diff(rec, recShadows.get(rec)); }
  };
  capture(true);
  owning = true;
}
function afterDeliver() {
  const t = now();
  if (tB) T.rest += t - tB;
  BF.req.tap = null; BF.req.onCbs = null; owning = false;
  const [logs, fx] = takeCaps();
  capture(false);
  refsOn();
  const mobs = [];
  for (const m of cbMobs) {
    if (m.removed) { if (shadows.has(m)) { shadows.delete(m); mobs.push([m.id, null, 1]); } continue; }
    const s = shadows.get(m);
    const ops = s ? diff(m, s) : null;
    if (ops) mobs.push([m.id, ops]);
  }
  foreignOps(mobs);
  const mineSends = dSends.filter(e => e[1] === 1);   // (those from callbacks: only this worker made them; onResult's are made everywhere)
  const plan = T.ticks % REBALANCE === 0;
  const out = { mobs, recs: recDirty.size ? recOps(recDirty) : [], touched: takeTouched(), dyn: takeDyn(), reg: takeReg(), reqs: mineSends.map(e => [e[0] * 2 + e[1], e[2], e[3].kind, enc(e[3].target, null), encData(e[3]), e[3].from, e[3].tick, e[3].region == null ? -1 : e[3].region]),
    logs, fx, load: plan ? [...load] : null };
  const msg = JSON.stringify(out);
  const all = RW.link.exchange(msg);
  T.bytes += msg.length;
  const sends = dSends.map(e => [e[0] * 2 + e[1], e[2], e[3]]);
  const loads = [];
  for (let w = 0; w < all.length; w++) {
    const p = w === RW.me ? out : JSON.parse(all[w]);
    if (p.load) loads.push(...p.load);
    if (w === RW.me) continue;
    adoptDyn(p.dyn, w);
    adoptReg(p.reg);
    atLater(() => { patchRecs(p.recs, w); patchMobs(p.mobs, w); applyTouched(p.touched); adoptAll(p.reqs, sends); });
    if (RW.me === 0) { for (const e of p.logs) BF.glog.put(e); for (const e of p.fx) BF.fx.emit(e); }
  }
  if (sends.length) {
    sends.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 0; i < sends.length; i++) { sends[i][2].seq = base2 + i; sends[i][2]._r = undefined; }
    BF.req.seq = base2 + sends.length;
  }
  // RW.verify (tests): every worker hashes its world once all the tick's changes are in, and they compare (a third exchange)
  if (RW.verify && T.ticks % RW.verify === 0) checkHashes(RW.link.exchange(JSON.stringify(BF.stateHash.full().parts)).map(x => JSON.parse(x)));
  if (plan) { replan(loads); load.clear(); }
  for (const m of shadows.keys()) if (m.removed) shadows.delete(m);
  T.x2 += now() - t;
  tB = now();
}

// Owners from each region's think time over the last REBALANCE ticks (the same list on every worker, so the same plan): regions stay
// where they are unless their worker has more than its share; the heaviest move first, to the lightest worker. Below SOLO_MS a tick
// in all, everything to the leader.
function replan(loads) {
  if (RW.shuffle) { shuffled(loads); return; }
  const by = new Map();
  for (const [k, ms] of loads) by.set(k, (by.get(k) || 0) + ms);
  let total = 0;
  for (const ms of by.values()) total += ms;
  const was = RW.solo;
  RW.solo = total / REBALANCE < SOLO_MS;
  if (RW.solo) { RW.owners = new Map(); if (!was) note("one worker thinks every region (" + (total / REBALANCE).toFixed(2) + " ms a tick of thinking is too little to share)"); return; }
  if (was) note("regions shared among " + RW.n + " workers again (" + (total / REBALANCE).toFixed(2) + " ms a tick of thinking)");
  const keys = [...by.keys()].sort((a, b) => by.get(b) - by.get(a) || (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  const loadOf = new Array(RW.n).fill(0), share = total / RW.n * 1.1;
  const next = new Map();
  for (const k of keys) {   // keep where it was while that worker has room
    const w = RW.owners.has(k) ? RW.owners.get(k) : ownerOf(k);
    if (loadOf[w] + by.get(k) <= share || by.get(k) > share) { next.set(k, w); loadOf[w] += by.get(k); }
  }
  for (const k of keys) {
    if (next.has(k)) continue;
    let best = 0;
    for (let w = 1; w < RW.n; w++) if (loadOf[w] < loadOf[best]) best = w;
    next.set(k, best); loadOf[best] += by.get(k);
  }
  RW.owners = next;
}
// (tests, RW.shuffle k) every region with load to a worker picked by a hash of k, the key and the tick, the same on every worker
function shuffled(loads) {
  if (Math.floor(T.ticks / REBALANCE) % 3 === 0) { RW.solo = true; RW.owners = new Map(); return; }   // (and every third plan all to the leader, as below SOLO_MS)
  const next = new Map();
  for (const [k] of loads) {
    if (next.has(k)) continue;
    let h = (RW.shuffle * 2654435761 + T.ticks * 40503) >>> 0;
    for (const c of String(k)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    next.set(k, h % RW.n);
  }
  RW.solo = false; RW.owners = next;
}
function checkHashes(hs) {
  RW.checks = (RW.checks || 0) + 1;
  const a = hs[0];
  // every worker has every hash, so all of them see the same difference: they swap the texts of the parts that differ, and the leader
  // logs where each first differs (once)
  const diff = new Set();
  for (let w = 1; w < hs.length; w++) if (a && hs[w]) for (const k of Object.keys(a)) if (a[k] !== hs[w][k]) diff.add(k);
  if (diff.size && !RW.mismatch) {
    const mine = {};
    for (const k of diff) mine[k] = BF.stateHash.text(k);
    const all = RW.link.exchange(JSON.stringify(mine)).map(x => JSON.parse(x));
    if (RW.me === 0) for (let w = 1; w < all.length; w++) for (const k of diff) {
      if (hs[w] && a[k] === hs[w][k]) continue;   // (another worker's part that differs)
      const p = all[0][k] || "", q = all[w][k] || "";
      if (p === q) { out_of_step("worker " + w + ", " + k + ": the hashes differ but the texts match (a field the hash reads that the text leaves out)"); continue; }
      let i = 0; while (i < p.length && p[i] === q[i]) i++;
      out_of_step("worker " + w + ", " + k + " from character " + i + ": leader ..." + p.slice(Math.max(0, i - 300), i + 200) + " / worker " + w + " ..." + q.slice(Math.max(0, i - 300), i + 200));
    }
    // block edits: every worker says who last wrote each cell that differs (js/world.js trail, on with ?verify=), the leader logs them
    if (diff.has("edits")) {
      const cells = [...new Set([].concat(...all.slice(1).map(x => BF.stateHash.editsDiff(all[0].edits, x.edits))))].slice(0, 8);
      const trails = RW.link.exchange(JSON.stringify(BF.world.trailOf(cells))).map(x => JSON.parse(x));
      if (RW.me === 0) for (const c of cells) out_of_step("the last writes of cell " + c + " [tick, phase, by, id]: " + trails.map((t, w) => (w ? "worker " + w : "leader") + " " + JSON.stringify(t[c])).join(" / "));
    }
  }
  for (let w = 1; w < hs.length; w++) {
    const b = hs[w];
    if (!a || !b) continue;
    const parts = Object.keys(a).filter(k => a[k] !== b[k]);
    if (!parts.length) continue;
    out_of_step("worker " + w + "'s world differs from the leader's in " + parts.join(", ") + " at tick " + BF.rand.tick);
    if (!RW.mismatch) {   // the first: each worker keeps its text of the parts that differ, to compare (tests)
      RW.mismatch = { tick: BF.rand.tick, worker: w, parts };
      RW.mismatchText = {};
      for (const k of parts) RW.mismatchText[k] = BF.stateHash.text(k);
    }
  }
}
let warned = 0;
function out_of_step(what) {
  if (warned++ < 20 && BF.glog) BF.glog.log("ERROR", "workers", "Region workers out of step: " + what);
}
function note(text) { if (BF.glog && RW.me === 0) BF.glog.log("INFO", "workers", "Region workers: " + text); }

// ---------------------------------------------------------------- channels: module state that thinking changes outside any mob
// A module whose own tables a mob changes while it thinks (or in a request's callback) registers a channel and calls touch(name, obj)
// when it changes one: the worker that did it sends that object's state at the next exchange, and the others set theirs to it.
// ch = { key(obj) -> plain key, get(key) -> obj, state(obj) -> plain data, set(obj, data, key) }. Bee homes (a beekeeper's harvest)
// and lures (a beekeeper leading bees) use it (js/bees.js).
const channels = new Map();
let touched = new Map();   // "name\u0000key" -> [name, key]
function channel(name, ch) { channels.set(name, ch); }
function touch(name, obj) {
  if (RW.onTouch) { const ch = channels.get(name); if (ch) RW.onTouch(name, ch.key(obj)); }   // (clusters on several workers, js/cworkers.js)
  if (!RW.active || !owning) return;
  const ch = channels.get(name);
  if (!ch) return;
  const key = ch.key(obj);
  touched.set(name + "\u0000" + JSON.stringify(key), [name, key]);
}
// Dynamic items (map items, js/blocks.js BF.resolveItem) made while this worker thinks: the others make them under the same ids. Two
// workers making different new items in one tick would give them one id: the copies would differ, and that is reported (rare: a map
// made for a zone no map was made for before).
let dynNew = [];
function dynItem(name, id) { if (RW.active && owning) dynNew.push([name, id]); }
function takeDyn() { const d = dynNew; dynNew = []; return d; }
// Places registered while this worker thinks (a house a builder finished, made its home: js/ids.js place keys hold a ":"): the other
// workers register a copy under the same key, else the key the mob's changes carry would read nothing there.
let regNew = [];
const onNewPlace = (o, k) => { if (RW.active && owning && typeof k === "string" && k.includes(":")) regNew.push([k, o]); };   // (hooked at setup: js/ids.js loads after this file)
function takeReg() { const d = regNew; regNew = []; return d.map(([k, o]) => [k, enc(o, null)]); }
function adoptReg(list) { for (const [k, e] of list || []) if (BF.ids.live(k) === undefined) BF.ids.put(dec(e, null), k); }
function adoptDyn(list, from) { for (const [name, id] of list || []) if (!BF.dynItemAs(name, id)) out_of_step("worker " + from + " made item " + name + " as " + id + ", which is another item here"); }
// A mob of another unit that this worker's thinking is about to change (a poultry keeper feeding a wild chicken it lures, js/poultry.js):
// called before the change, it is sent with this worker's mobs (a diff from now), and its owner takes the change as the others do.
let foreign = new Map();   // mob -> Shadow from before the change
function writes(m) {
  if (!RW.active || !owning || !m || typeof m !== "object" || idxOf.has(m) || cbMobs.has(m) || foreign.has(m)) return;
  foreign.set(m, snap(m));
}
function foreignOps(mobs) {
  for (const [m, s] of foreign) { if (m.removed) continue; const ops = diff(m, s); if (ops) mobs.push([m.id, ops]); }
  foreign = new Map();
}
function takeTouched() {
  const out = [];
  for (const [name, key] of touched.values()) { const ch = channels.get(name), o = ch.get(key); out.push([name, key, o == null ? null : ch.state(o)]); }
  touched = new Map();
  return out;
}
function applyTouched(list) {
  for (const [name, key, data] of list || []) { const ch = channels.get(name); if (ch) ch.set(ch.get(key), data, key); }
}
let owning = false;   // in this worker's own part of the tick (its mobs thinking, its callbacks): touches are sent

// ---------------------------------------------------------------- setup and reporting
// o: {n, me, link (attach(...))}. Every worker calls it at the same tick boundary (all fresh, or all at the same tick of the same world).
function setup(o) {
  RW.n = o.n; RW.me = o.me; RW.link = o.link; RW.active = o.n > 1;
  RW.owners = new Map(); RW.solo = false; RW.mismatch = null;
  shadows = new Map(); recShadows = new Map(); load.clear(); touched = new Map(); foreign = new Map(); dynNew = []; regNew = []; owning = false;
  if (BF.ids && BF.ids.hooks) BF.ids.hooks.onNew = onNewPlace;
  for (const k in T) T[k] = 0;
  tA = tB = 0; peers = [];
  if (RW.active) note(RW.n + " workers share the regions (worker " + RW.me + " of " + RW.n + ")");
}
// The followers think nothing again (play mode, js/rplay.js: the split doesn't pay just now): every worker runs whole ticks on its own
// copy from the next tick on, as one worker does, and the link stays for the next start.
function pause() {
  if (!RW.active) return;
  RW.active = false; RW.solo = false;
  shadows = new Map(); recShadows = new Map(); owning = false;
}
function stop(why) {
  if (!RW.active) return;
  RW.active = false;
  if (RW.link) try { RW.link.stop(); } catch (e) { /* already */ }
  if (BF.glog) BF.glog.log(why ? "ERROR" : "INFO", "workers", "Region workers stopped" + (why ? ": " + why : ""));
  shadows = new Map();
}
// ---------------------------------------------------------------- the journal (play mode, js/rplay.js)
// While the leader records (RW.journal an array), what it does to the world outside a tick is added as an op: a protocol packet from the
// client, a chunk streaming loaded or dropped, a save's snapshot, the frame's measure for the budget; and each tick as ["t", h, clock].
// The followers do the same, in the same order (js/rplay.js replay). RW.clock: the real ms the leader read for the step in hand, which
// js/active.js and js/villagesim.js read (realNow) instead of the wall clock, so their real-time decisions come out the same on every copy.
function rec(op) { if (RW.journal) RW.journal.push(op); }
function stamp() { return (RW.clock = Math.round(now() * 1000) / 1000); }
function realNow() { return RW.clock != null ? RW.clock : now(); }
function tick(h) {
  if (!RW.journal) return;
  RW.journal.push(["t", h, stamp()]);
  if (RW.onTick) RW.onTick();   // (js/rplay.js: the ops go out before the tick, so the followers can start it with the leader)
}

const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
function stats() {
  const n = Math.max(1, T.ticks);
  return { active: RW.active, n: RW.n, me: RW.me, solo: RW.solo, ticks: T.ticks,
    ms: { think: T.think / n, exchange: (T.x1 + T.x2) / n, rest: T.rest / n, wait: RW.link ? RW.link.waitMs / n : 0 },
    kbPerTick: T.bytes / n / 1024, workers: peers.map((p, w) => ({ worker: w, regions: p.regions, mobs: p.mobs, thinkMs: p.think })) };
}
// The F3 line: "Workers 4: regions 3/3/2/3, mobs 60/55/41/70  think 1.20  exchange 0.40  rest 2.10 ms"
function text(s) {
  s = s || stats();
  if (!s.active) return "Workers 1";
  return "Workers " + s.n + (s.solo ? " (one thinks)" : "") + ": regions " + s.workers.map(w => w.regions).join("/") + ", mobs " + s.workers.map(w => w.mobs).join("/") +
    "  think " + f2(s.ms.think) + "  exchange " + f2(s.ms.exchange) + "  rest " + f2(s.ms.rest) + " ms";
}
// once a game hour while the debug overlay or debug screen is on (js/requests.js endTick calls it through BF.rtick.hourly's turn)
function hourly() {
  if (!RW.active || RW.me !== 0) return;
  const t = BF.simNow ? BF.simNow() : 0;
  if (hourAt == null || t < hourAt) { hourAt = t; hourT = Object.assign({}, T); return; }
  if (t - hourAt < 1200 / 24) return;
  hourAt = t;
  const live = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (live && hourT) {
    const n = Math.max(1, T.ticks - hourT.ticks), ms = k => f2((T[k] - hourT[k]) / n);
    note("in the last game hour, " + RW.n + " workers: ms a tick think " + ms("think") + ", exchange " + f2((T.x1 - hourT.x1 + T.x2 - hourT.x2) / n) +
      ", rest " + ms("rest") + "; regions " + peers.map(p => p.regions).join("/") + ", mobs " + peers.map(p => p.mobs).join("/") + "; " + f2((T.bytes - hourT.bytes) / n / 1024) + " KB a tick exchanged");
  }
  hourT = Object.assign({}, T);
}

Object.assign(RW, { journal: null, clock: null, onTick: null, onTouch: null, chan: name => channels.get(name), rec, stamp, realNow, tick, pause, channel, touch, writes, dynItem, setup, stop, beginThink, thinking, afterThink, beforeDeliver, afterDeliver, stats, text, hourly, replan,
  enc, dec, Shadow, snap, diff, patch, makeShared, attach, SKIP, REBALANCE, SOLO_MS, refsOn,
  ownerOf, unitOf,   // (read only: the debug screen's Regions map colours each region by the worker its mobs think on, js/debugfeed.js)
  refs: refsOn, encData, encMany, decAll, atLater });
BF.rworkers = RW;
})();
