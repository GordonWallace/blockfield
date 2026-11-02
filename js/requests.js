// Request queue and the two-phase tick (spec r15-17). Each simulation tick (js/main.js simStep, then world.tickSim) runs in phases:
//   think   everything that ran in the step before (sky, mobs, day timelines, drops, boats, furnaces, the think hooks of
//           world.tickSim): reads the world as it stood at the start of the tick and changes only its own state, asking for world
//           changes with BF.req.send;
//   apply   the tick's requests, sorted by (requester id, sequence number) and applied by their kind's handler;
//   blocks  block ticks (fluids, crops, farmland, grass), in a fixed order;
//   deliver results, so the requester has them before its next think: req.then(fn) callbacks, and the kind's onResult(m, req, result)
//           for a requester that is a live mob. A requester removed by then gets nothing (what the request did stays done).
// A request whose requester mob is dead by the time it applies (killed earlier in the same apply) is refused with why "dead".
// Requests sent during apply or deliver (chain effects), or between ticks (the player, real time), go into the next tick's apply.
// Transition mode (BF.req.direct, on until r15-18 to r15-23 convert the systems): code may still write the world directly. Every
// direct world.setBlock outside apply and the block ticks is counted by the module that made it (BF.req.stats().direct), shown on
// the F3 overlay and the debug screen. BF.req.strict (r15-24, tests) makes a direct write during think throw.
// Game log: INFO "requests" summary once a game hour while the debug overlay or debug screen is on; ERROR for a kind with no handler.
// Queued requests are not saved: those sent in a tick apply in that tick, so only chain effects and between-tick sends can be pending.
// API: BF.req = { send(kind, target, data, from) -> req (req.then(fn)), on(kind, applyFn(req, world) -> {ok, ...}, {onResult}?),
//   beginTick(), apply(), blocks(fn), deliver(), endTick(), times() -> {ticks, think, apply, blocks, deliver} (ms), resetTimes(), phase, direct, strict, stats(), resetStats(), text(), queued(), reset(), order(a, b),
//   player(kind, target, data) -> req (applied now, req.result; through the protocol when R.via is set), applyPlayer(kind, target, data), via, record() -> list / record(false) -> list, replay(list), replayFlush(),
//   recording, replaying, inPlayer, route, regionOrder, single, applying (region inboxes, spec r15-33),
//   adopt(o), tap, onCbs, dIdx, dPart, seq (several workers, spec r15-39: js/rworkers.js),
//   ctx(), useCtx(c), newCtx(list?), fileIn(c, req), away, think() (clusters, spec r15-39b: js/ctick.js), revive(o) (js/cworkers.js) }
// Clusters (js/ctick.js): each cluster has its own queue, inboxes, results waiting and sequence counter (a context; useCtx switches),
// so a cluster's apply and deliver handle only its own requests. R.away(req, region) -> true takes a request out of the filing:
// one aimed at another cluster waits for the next meeting.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const kinds = new Map();   // kind -> {apply, onResult}
let queue = [], seq = 0, done = [];   // done: [req, result] waiting for delivery
// Region inboxes (spec r15-33): with R.route set (js/regiontick.js), a request sent in the think phase goes to the inbox of the region it
// targets (route(req) -> region key, or -1 for the global inbox: requests with no place, such as new mobs). apply() then runs the
// inboxes one region at a time, in R.regionOrder() (key order), each sorted by order(), and the global inbox last. R.route null (or
// R.single) keeps the single-list apply of r15-17: every request in one list sorted by order(). Either way, requests marked data.late
// (the far parts of a wide effect, js/mobs.js explode) apply after all the others: region by region, then the global ones.
let inbox = new Map();   // region key -> [req]
let phase = "idle";
const S = { sent: 0, applied: 0, refused: 0, byKind: {}, direct: {}, directTotal: 0, regionApplies: 0 };
const H = { sent: 0, refused: 0, byKind: {}, direct: {}, directTotal: 0 };   // since the last hourly log line
let hourAt = null;
const unhandled = new Set();
const HOUR = 1200 / 24;   // game seconds (js/sky.js: a 1200 s day)

// Requester order: the player, then mob ids "e<n>" by n, then other requesters ("player", village keys, "test") by name, then none; ties by
// the mob whose think sent it (req.by: its id number, -1 outside a think; two mobs may send for one requester, a buyer and the seller
// selling to it, and think order must not matter, spec r15-71), then by sequence.
function rank(from) {
  if (from == null) return [2, 0, ""];
  if (from === "player") return [-1, 0, ""];   // the player first, on every client alike (spec r15-20)
  const s = String(from), m = /^e(\d+)$/.exec(s);
  return m ? [0, +m[1], ""] : [1, 0, s];
}
function order(a, b) {
  const ra = a._r || (a._r = rank(a.from)), rb = b._r || (b._r = rank(b.from));
  return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0) || (a.by | 0) - (b.by | 0) || a.seq - b.seq;
}

function bump(o, kind, key) { const k = o.byKind[kind] || (o.byKind[kind] = { sent: 0, applied: 0, refused: 0 }); k[key]++; }

function byOf() { const t = BF.rand && BF.rand.thinker, id = t && BF.ids ? BF.ids.idOf(t) : null, m = id == null ? null : /^e(\d+)$/.exec(String(id)); return m ? +m[1] : -1; }
function make(kind, target, data, from) {
  const req = { kind, target, data: data || {}, from: from == null ? null : BF.ids && typeof from === "object" ? BF.ids.idOf(from) : from,
    seq: seq++, tick: BF.rand ? BF.rand.tick : 0, by: byOf(), cbs: null, result: undefined, delivered: false };
  req.then = fn => { if (req.delivered) { try { fn(req.result, req); } catch (e) { console.error(e); } } else (req.cbs || (req.cbs = [])).push(fn); return req; };
  S.sent++; H.sent++; bump(S, kind, "sent"); bump(H, kind, "sent");
  return req;
}
function send(kind, target, data, from) {
  const req = make(kind, target, data, from);
  const k = R.route && kinds.has(kind) && !kinds.get(kind).global ? R.route(req) : -1;
  if (R.away) { if (k >= 0) req.region = k; if (R.away(req, k)) return req; }   // (clusters, js/ctick.js: for another cluster, at the next meeting)
  file(req, k);
  if (R.tap) R.tap(req);   // (several workers, js/rworkers.js: the requests a worker's own mobs and callbacks send go to the others)
  return req;
}
function file(req, k) {
  if (k >= 0) { req.region = k; let a = inbox.get(k); if (!a) inbox.set(k, (a = [])); a.push(req); }
  else queue.push(req);
}
// Contexts (clusters, js/ctick.js): {queue, inbox, done, seq}. ctx() is the one in use (its arrays, and the counter as it stands).
const ctx = () => ({ queue, inbox, done, seq });
function useCtx(c) { queue = c.queue; inbox = c.inbox; done = c.done; seq = c.seq; }
const newCtx = list => ({ queue: list || [], inbox: new Map(), done: [], seq: 0 });
// a request filed in context c's inboxes as send() would have (its region from route, kept on req.region)
function fileIn(c, req) {
  const k = req.region != null && req.region >= 0 ? req.region : -1;
  if (k >= 0) { let a = c.inbox.get(k); if (!a) c.inbox.set(k, (a = [])); a.push(req); } else c.queue.push(req);
}
// A request another worker's mob sent this tick (spec r15-39): filed in the inbox it went to there. o: {kind, target, data, from, seq,
// tick, region}. It has no callbacks here (they ran there).
function adopt(o) {
  const req = revive(o);
  S.sent++; H.sent++; bump(S, req.kind, "sent"); bump(H, req.kind, "sent");
  file(req, req.region);
  return req;
}
// The same request made again from o, filed nowhere (clusters on several workers, js/cworkers.js: the caller files it)
function revive(o) {
  const req = { kind: o.kind, target: o.target, data: o.data || {}, from: o.from == null ? null : o.from, seq: o.seq, tick: o.tick, by: o.by == null ? -1 : o.by,
    region: o.region != null && o.region >= 0 ? o.region : -1, cbs: null, result: undefined, delivered: false };
  req.then = fn => { if (req.delivered) { try { fn(req.result, req); } catch (e) { console.error(e); } } else (req.cbs || (req.cbs = [])).push(fn); return req; };
  return req;
}
// opts: onResult(m, req, result) for a requester that is a live mob; global: true for a kind that is always applied from the global
// inbox, after the regions (one that hands out ids or otherwise depends on order across the whole world: "spawn").
function on(kind, applyFn, opts) { kinds.set(kind, { apply: applyFn, onResult: opts && opts.onResult, global: !!(opts && opts.global) }); }

function applyOne(req) {
  const k = kinds.get(req.kind);
  let r;
  if (dead(req.from)) r = { ok: false, why: "dead" };
  else if (R.inactive && (r = R.inactive(req))) {}   // its region isn't simulated (spec r15-33)   // killed earlier in this apply (r15-23): its own requests are refused, items stay put
  else if (!k) {
    r = { ok: false, why: "no handler" };
    if (!unhandled.has(req.kind)) { unhandled.add(req.kind); if (BF.glog) BF.glog.log("ERROR", "requests", "Request kind \"" + req.kind + "\" has no handler (from " + (req.from || "nobody") + ")"); }
  } else {
    try { r = k.apply(req, BF.world) || { ok: true }; }
    catch (e) { r = { ok: false, why: "error", error: String(e && e.message || e) }; console.error(e); }
  }
  req.result = r;
  S.applied++; bump(S, req.kind, "applied");
  if (!r.ok) { S.refused++; H.refused++; bump(S, req.kind, "refused"); bump(H, req.kind, "refused"); }
  return r;
}
function apply() {
  if (phase === "think" && t0) lapT("think");
  const list = queue, boxes = inbox;
  queue = []; inbox = new Map();   // anything sent from here on is the next tick's
  if (!list.length && !boxes.size) return 0;
  const prev = phase;
  phase = "apply";
  let n = 0;
  // R.applying: the region of the request being applied (-1: the global inbox), in both modes alike (per-region roll counters, js/blocks.js)
  const run = L => { L.sort(order); for (const req of L) { R.applying = req.region >= 0 ? req.region : -1; applyOne(req); done.push(req); } n += L.length; };
  // late requests (data.late: the far parts of a wide effect, decided by an earlier request of the same tick) go after all the others
  const split = L => { const a = [], b = []; for (const req of L) (req.data.late ? b : a).push(req); return [a, b]; };
  try {
    if (R.single || !R.route) {
      const all = list.slice();
      for (const L of boxes.values()) for (const req of L) all.push(req);
      const [a, b] = split(all);
      run(a); run(b);
    } else {
      const keys = [...boxes.keys()], late = new Map();
      if (R.regionOrder) R.regionOrder(keys); else keys.sort((a, b) => a - b);
      for (const k of keys) { const [a, b] = split(boxes.get(k)); if (b.length) late.set(k, b); run(a); }
      const [g, gl] = split(list);
      run(g);
      for (const k of keys) if (late.has(k)) run(late.get(k));
      run(gl);
      S.regionApplies += keys.length;
    }
  } finally { phase = prev; R.applying = -1; }
  return n;
}

// A requester that has died (a mob killed by an earlier request this tick, spec r15-23). A removed one (unloaded) still has its requests applied.
function dead(from) {
  if (from == null || !BF.ids || !/^e\d+$/.test(from)) return false;
  const o = BF.ids.get(from);
  return !!(o && o.dead);
}
// A requester that is gone: an entity id that no longer reads a live object.
function gone(from) {
  if (from == null || !BF.ids || !/^e\d+$/.test(from)) return false;
  const o = BF.ids.get(from);
  return !o || o.removed;
}
function deliver() {
  if (!done.length) return;
  const list = done;
  done = [];
  const prev = phase;
  phase = "deliver";
  try {
    for (let i = 0; i < list.length; i++) {
      const req = list[i];
      req.delivered = true;
      if (gone(req.from)) continue;   // the requester went: the result is dropped (the apply function kept any items in the world)
      const k = kinds.get(req.kind);
      R.dIdx = i; R.dPart = 0;   // (where in the delivery a request sent now comes: several workers number them alike, js/rworkers.js)
      if (k && k.onResult && req.from) { const m = BF.ids && BF.ids.get(req.from); if (m) { try { k.onResult(m, req, req.result); } catch (e) { console.error(e); } } }
      R.dPart = 1;
      if (req.cbs) { if (R.onCbs) R.onCbs(req); for (const fn of req.cbs) { try { fn(req.result, req); } catch (e) { console.error(e); } } }
    }
  } finally { phase = prev; R.dIdx = -1; }
}

// Time per phase (spec r15-33): ms summed over the ticks since resetTimes(), for the debug screen and the hourly region-tick log line.
// Think runs from beginTick to apply, so it includes the think hooks of world.tickSim.
const T = { ticks: 0, think: 0, apply: 0, blocks: 0, deliver: 0 };
const clock = () => (globalThis.performance ? performance.now() : Date.now());
let t0 = 0;
function lapT(part) { const t = clock(); if (t0) T[part] += t - t0; t0 = t; }
function beginTick() { if (rec || rep) boundary(); phase = "think"; t0 = clock(); T.ticks++; }
function blocks(fn) { if (t0) lapT("apply"); const prev = phase; phase = "blocks"; try { fn(); } finally { phase = prev; if (t0) lapT("blocks"); } }
function endTick() { phase = "idle"; if (t0) lapT("deliver"); t0 = 0; hourly(); if (BF.rtick) BF.rtick.hourly(); if (BF.rworkers) BF.rworkers.hourly(); }
const times = () => Object.assign({}, T);
function resetTimes() { T.ticks = T.think = T.apply = T.blocks = T.deliver = 0; }

// ---------- the player (spec r15-20) ----------
// The player runs in real time between ticks (js/main.js frame: the tick batch, then BF.player.update). What it does to the world
// (breaking, placing, doors, using items on blocks and mobs, eating, shooting, throwing, the inventory screens with trades, chests
// and furnaces, slash commands) is a request from "player", stamped with the tick it follows (BF.rand.tick, the last tick run), and
// applied at once, at that tick boundary. In the page the client and the simulation share one world, so the prediction is the
// apply: the player feels no delay, and its edit comes before every request of the next tick, as the player sorts first. The result
// is back when player() returns (req.result); the caller keeps its own side (the item in hand, the swing) for a refusal. A refusal
// because someone else got there first ("changed", "gone") is logged at INFO. A player
// request made while one is being applied (the trade screen that talking to a villager opens) is part of it. At 0x (frozen) and
// behind a paused screen no ticks run, and the requests apply all the same. When the simulation moves to its own thread (r15-36)
// the same requests go across and apply in its next apply phase; the client then keeps its prediction until the result comes back.
// Input log: record() keeps each player request with its tick and the player's pose when it was made ([x, y, z, yaw, pitch, hotbar
// slot, flying]), plus the pose at the start of each tick where it changed. replay(list) feeds them back, each at the start of the tick
// after the one it followed, so a recorded session plays out the same on a fresh load (test/player-requests.js). The player's own
// real-time state (hunger, air, falling) is not in the log: a replay moves the player, it does not simulate it.
let depth = 0, rec = null, recPose = "", rep = null, repAt = 0, replaying = false;
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
function pose() {
  const P = BF.player;
  if (!P || !P.position) return null;
  const p = P.position;
  return [p.x, p.y, p.z, P.yaw, P.pitch, BF.inventory ? BF.inventory.selectedIndex : 0, P.flying ? 1 : 0];
}
function setPose(a) {
  const P = BF.player;
  if (!a || !P || !P.position) return;
  P.position.set(a[0], a[1], a[2]);
  if (P.setLook) P.setLook(a[3], a[4]);
  if (BF.inventory && BF.inventory.selectedIndex !== a[5]) BF.inventory.select(a[5]);
  if (P.setFlying && !!a[6] !== !!P.flying) P.setFlying(!!a[6]);
}
// With the simulation/client protocol connected (js/protocol.js, r15-36), player() hands the request to the client end (R.via), which
// sends it to the simulation; the simulation applies it with applyPlayer() and sends the result back (in the page: before via returns).
// A request made while one is being applied, and replayed entries, are the simulation's own and apply directly.
function player(kind, target, data) {
  if (R.via && !depth && !replaying) { const r = R.via(kind, target, data); if (r) return r; }
  return applyPlayer(kind, target, data);
}
function applyPlayer(kind, target, data) {
  const req = make(kind, target, data, "player");
  if (rec && !depth && !replaying) rec.push({ tick: req.tick, kind, target, data: clone(req.data), pose: pose() });
  const prev = phase;
  phase = "apply"; depth++;
  try { applyOne(req); } finally { depth--; phase = prev; }
  req.delivered = true;
  if (req.cbs) for (const fn of req.cbs) { try { fn(req.result, req); } catch (e) { console.error(e); } }
  const r = req.result;
  if (!r.ok && (r.why === "changed" || r.why === "gone") && BF.glog) BF.glog.log("INFO", "requests", "Player request " + kind + (target != null ? " at " + target : "") + " refused (" + (r.why || "refused") + ")");
  return req;
}
// At the start of each tick: the pose for the input log, and the replayed entries that followed the last tick.
function boundary() {
  const t = BF.rand ? BF.rand.tick : 0;
  if (rep) {
    replaying = true;
    try {
      while (repAt < rep.length && rep[repAt].tick < t) playEntry(rep[repAt++]);
    } finally { replaying = false; }
    if (repAt >= rep.length) endReplay();
  }
  if (rec) { const p = pose(), k = JSON.stringify(p); if (p && k !== recPose) { recPose = k; rec.push({ tick: t - 1, pose: p }); } }
}
function playEntry(e) {
  setPose(e.pose);
  if (e.kind) applyPlayer(e.kind, e.target, clone(e.data));
}
function record(on) {
  if (on === false) {
    const list = rec || [];
    if (rec && BF.glog) BF.glog.log("INFO", "requests", "Player input recording stopped: " + list.filter(e => e.kind).length + " requests, " + list.length + " entries");
    rec = null;
    return list;
  }
  rec = [];
  const p = pose();
  recPose = JSON.stringify(p);
  if (p) rec.push({ tick: (BF.rand ? BF.rand.tick : 0) - 1, pose: p });   // where the player stands when it starts
  if (BF.glog) BF.glog.log("INFO", "requests", "Player input recording started at tick " + (BF.rand ? BF.rand.tick : 0));
  return rec;
}
function replay(list) {
  rep = clone(list || []); repAt = 0;
  if (BF.glog) BF.glog.log("INFO", "requests", "Replaying " + rep.filter(e => e.kind).length + " player requests" + (rep.length ? " from tick " + rep[0].tick + " to " + rep[rep.length - 1].tick : ""));
  replaying = true;
  try { while (repAt < rep.length && rep[repAt].tick < (BF.rand ? BF.rand.tick : 0)) playEntry(rep[repAt++]); }   // entries before now
  finally { replaying = false; }
  if (repAt >= rep.length) endReplay();
  return rep.length;
}
// The entries still waiting (those after the last tick run): applied now, and the replay ends.
function replayFlush() {
  if (!rep) return 0;
  const n = rep.length - repAt;
  replaying = true;
  try { while (repAt < rep.length) playEntry(rep[repAt++]); } finally { replaying = false; }
  endReplay();
  return n;
}
function endReplay() {
  if (rep && BF.glog) BF.glog.log("INFO", "requests", "Replay finished: " + rep.filter(e => e.kind).length + " player requests");
  rep = null; repAt = 0;
}

// ---------- transition mode: direct writes ----------
// The module is the first file on the stack that isn't the world or this file, skipping pass-through wrappers that other modules hang
// on shared functions (W.setDoor in js/audio.js for door sounds, BF.mobs.update in js/bees.js): those are named W.x, BF.x.y or world.x.
const MOD = /\/js\/([\w-]+)\.js/, WRAP = /^\s*at (?:W|BF|world)\.[\w.]+ \(/;
// (code a test sent to run where the simulation is, BFT.sim: an eval frame, js/protocol.js eval query or js/simhost.js in the page, is "test")
function moduleOf(stack) {
  const lines = String(stack || "").split("\n");
  for (const l of lines) { if (/\(eval at /.test(l)) return "test"; const m = MOD.exec(l); if (m && m[1] !== "requests" && m[1] !== "world" && !WRAP.test(l)) return m[1]; }
  for (const l of lines) { const m = MOD.exec(l); if (m && m[1] === "world") return "world"; }
  return /\/test\/|__puppeteer|playwright|<anonymous>/.test(stack) ? "test" : "other";
}
function noteDirect(what) {
  const mod = moduleOf(new Error().stack);
  if (R.strict && phase === "think") throw new Error("direct " + what + " during think from js/" + mod + ".js (BF.req.strict, spec r15-17)");
  S.direct[mod] = (S.direct[mod] || 0) + 1; S.directTotal++;
  H.direct[mod] = (H.direct[mod] || 0) + 1; H.directTotal++;
}
function hook() {
  const W = BF.world;
  if (!W || !W.setBlock || W.setBlock._req) return;
  const raw = W.setBlock;
  let depth = 0;   // the world's own knock-on edits (a plant popping off) are part of the write that caused them
  const wrapped = function (x, y, z, id) {
    if (depth === 0 && phase !== "apply" && phase !== "blocks") noteDirect("setBlock");
    depth++;
    try { return raw.apply(this, arguments); } finally { depth--; }
  };
  wrapped._req = true;
  W.setBlock = wrapped;
  const reset = W.reset;
  if (reset) W.reset = function () { R.reset(); return reset.apply(this, arguments); };
}

// ---------- reporting ----------
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
function hourly() {
  const now = BF.simNow ? BF.simNow() : 0;
  if (hourAt == null || now < hourAt) { hourAt = now; return; }
  if (now - hourAt < HOUR) return;
  hourAt = now;
  const live = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (live && (H.sent || H.directTotal) && BF.glog) {
    const ks = Object.keys(H.byKind).sort().map(k => k + " " + H.byKind[k].sent + (H.byKind[k].refused ? " (" + H.byKind[k].refused + " refused)" : ""));
    BF.glog.log("INFO", "requests", "Requests in the last game hour: " + (ks.length ? ks.join(", ") : "none") +
      "; direct writes " + H.directTotal + (H.directTotal ? " (" + top(H.direct, 6).map(([m, n]) => m + " " + n).join(", ") + ")" : ""));
  }
  H.sent = 0; H.refused = 0; H.byKind = {}; H.direct = {}; H.directTotal = 0;
}
function stats() {
  const byKind = {};
  for (const k in S.byKind) byKind[k] = Object.assign({}, S.byKind[k]);
  return { sent: S.sent, applied: S.applied, refused: S.refused, queued: queued(), regionApplies: S.regionApplies, byKind, direct: Object.assign({}, S.direct), directTotal: S.directTotal };
}
function queued() { let n = queue.length; for (const L of inbox.values()) n += L.length; return n; }
function resetStats() { S.sent = S.applied = S.refused = S.regionApplies = 0; S.byKind = {}; S.direct = {}; S.directTotal = 0; }
// The F3 line: "Requests 12 (1 refused)  Direct writes 40: miner 20, builder 12, player 8"
function text(s) {
  s = s || stats();
  return "Requests " + s.applied + (s.refused ? " (" + s.refused + " refused)" : "") + "  Direct writes " + s.directTotal +
    (s.directTotal ? ": " + top(s.direct, 4).map(([m, n]) => m + " " + n).join(", ") : "");
}

const R = {
  send, adopt, revive, on, apply, deliver,
  tap: null, onCbs: null, dIdx: -1, dPart: 0,   // (several workers, spec r15-39: js/rworkers.js)
  get seq() { return seq; }, set seq(n) { seq = n; },
  ctx, useCtx, newCtx, fileIn, away: null, think() { phase = "think"; },   // (clusters, spec r15-39b: js/ctick.js)
  pending() { const out = queue.slice(); for (const L of inbox.values()) for (const r of L) out.push(r); return out; },   // queued in this context
  beginTick, blocks, endTick, stats, resetStats, text, order, times, resetTimes,
  player, applyPlayer, record, replay, replayFlush, via: null,
  get recording() { return !!rec; },
  get replaying() { return rep ? rep.length - repAt : 0; },   // entries still to replay
  get inPlayer() { return depth > 0; },
  get phase() { return phase; },
  direct: true, strict: false,
  route: null, regionOrder: null, inactive: null, single: false, applying: -1,   // region inboxes (spec r15-33, js/regiontick.js)
  queued,
  reset() { queue = []; inbox = new Map(); done = []; seq = 0; phase = "idle"; hourAt = null; rec = null; rep = null; repAt = 0; replaying = false; depth = 0; resetStats(); H.sent = H.refused = H.directTotal = 0; H.byKind = {}; H.direct = {}; unhandled.clear(); },
  hook,
};
BF.req = R;

// ---------- the example kind (the conversion specs add theirs) ----------
// setBlock: target "x,y,z" (a block cell), data {id, expect?, drop?}. Refused when the cell isn't loaded, or holds something other than
// data.expect (someone changed it first this tick). With drop, the block that was there drops as an item entity in the world.
on("setBlock", req => {
  const W = BF.world, [x, y, z] = String(req.target).split(",").map(Number), d = req.data;
  if (!W.isLoaded(x, z)) return { ok: false, why: "unloaded" };
  const was = W.getBlock(x, y, z);
  if (d.expect != null && was !== d.expect) return { ok: false, why: "changed", was };
  if (!W.setBlock(x, y, z, d.id)) return { ok: false, why: "refused", was };
  if (d.drop && was && BF.drops && BF.rollDrops) BF.drops.spawnAt(BF.rollDrops(was), x, y, z);
  return { ok: true, was };
});

hook();
})();
