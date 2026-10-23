// Request queue and the two-phase tick (spec r15-17). Each simulation tick (js/main.js simStep, then world.tickSim) runs in phases:
//   think   everything that ran in the step before (sky, mobs, day timelines, drops, boats, furnaces, the think hooks of
//           world.tickSim): reads the world as it stood at the start of the tick and changes only its own state, asking for world
//           changes with BF.req.send;
//   apply   the tick's requests, sorted by (requester id, sequence number) and applied by their kind's handler;
//   blocks  block ticks (fluids, crops, farmland, grass), in a fixed order;
//   deliver results, so the requester has them before its next think: req.then(fn) callbacks, and the kind's onResult(m, req, result)
//           for a requester that is a live mob. A requester removed by then gets nothing (what the request did stays done).
// Requests sent during apply or deliver (chain effects), or between ticks (the player, real time), go into the next tick's apply.
// Transition mode (BF.req.direct, on until r15-18 to r15-23 convert the systems): code may still write the world directly. Every
// direct world.setBlock outside apply and the block ticks is counted by the module that made it (BF.req.stats().direct), shown on
// the F3 overlay and the debug screen. BF.req.strict (r15-24, tests) makes a direct write during think throw.
// Game log: INFO "requests" summary once a game hour while the debug overlay or debug screen is on; ERROR for a kind with no handler.
// Queued requests are not saved: those sent in a tick apply in that tick, so only chain effects and between-tick sends can be pending.
// API: BF.req = { send(kind, target, data, from) -> req (req.then(fn)), on(kind, applyFn(req, world) -> {ok, ...}, {onResult}?),
//   beginTick(), apply(), blocks(fn), deliver(), endTick(), phase, direct, strict, stats(), resetStats(), text(), queued(), reset(), order(a, b) }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const kinds = new Map();   // kind -> {apply, onResult}
let queue = [], seq = 0, done = [];   // done: [req, result] waiting for delivery
let phase = "idle";
const S = { sent: 0, applied: 0, refused: 0, byKind: {}, direct: {}, directTotal: 0 };
const H = { sent: 0, refused: 0, byKind: {}, direct: {}, directTotal: 0 };   // since the last hourly log line
let hourAt = null;
const unhandled = new Set();
const HOUR = 1200 / 24;   // game seconds (js/sky.js: a 1200 s day)

// Requester order: mob ids "e<n>" by n, then other requesters ("player", village keys, "test") by name, then none; ties by sequence.
function rank(from) {
  if (from == null) return [2, 0, ""];
  const s = String(from), m = /^e(\d+)$/.exec(s);
  return m ? [0, +m[1], ""] : [1, 0, s];
}
function order(a, b) {
  const ra = a._r || (a._r = rank(a.from)), rb = b._r || (b._r = rank(b.from));
  return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0) || a.seq - b.seq;
}

function bump(o, kind, key) { const k = o.byKind[kind] || (o.byKind[kind] = { sent: 0, applied: 0, refused: 0 }); k[key]++; }

function send(kind, target, data, from) {
  const req = { kind, target, data: data || {}, from: from == null ? null : BF.ids && typeof from === "object" ? BF.ids.idOf(from) : from,
    seq: seq++, tick: BF.rand ? BF.rand.tick : 0, cbs: null, result: undefined };
  req.then = fn => { (req.cbs || (req.cbs = [])).push(fn); return req; };
  queue.push(req);
  S.sent++; H.sent++; bump(S, kind, "sent"); bump(H, kind, "sent");
  return req;
}
function on(kind, applyFn, opts) { kinds.set(kind, { apply: applyFn, onResult: opts && opts.onResult }); }

function apply() {
  const list = queue;
  queue = [];   // anything sent from here on is the next tick's
  if (!list.length) return 0;
  list.sort(order);
  const prev = phase;
  phase = "apply";
  try {
    for (const req of list) {
      const k = kinds.get(req.kind);
      let r;
      if (!k) {
        r = { ok: false, why: "no handler" };
        if (!unhandled.has(req.kind)) { unhandled.add(req.kind); if (BF.glog) BF.glog.log("ERROR", "requests", "Request kind \"" + req.kind + "\" has no handler (from " + (req.from || "nobody") + ")"); }
      } else {
        try { r = k.apply(req, BF.world) || { ok: true }; }
        catch (e) { r = { ok: false, why: "error", error: String(e && e.message || e) }; console.error(e); }
      }
      req.result = r;
      S.applied++; bump(S, req.kind, "applied");
      if (!r.ok) { S.refused++; H.refused++; bump(S, req.kind, "refused"); bump(H, req.kind, "refused"); }
      done.push(req);
    }
  } finally { phase = prev; }
  return list.length;
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
    for (const req of list) {
      if (gone(req.from)) continue;   // the requester went: the result is dropped (the apply function kept any items in the world)
      const k = kinds.get(req.kind);
      if (k && k.onResult && req.from) { const m = BF.ids && BF.ids.get(req.from); if (m) { try { k.onResult(m, req, req.result); } catch (e) { console.error(e); } } }
      if (req.cbs) for (const fn of req.cbs) { try { fn(req.result, req); } catch (e) { console.error(e); } }
    }
  } finally { phase = prev; }
}

function beginTick() { phase = "think"; }
function blocks(fn) { const prev = phase; phase = "blocks"; try { fn(); } finally { phase = prev; } }
function endTick() { phase = "idle"; hourly(); }

// ---------- transition mode: direct writes ----------
// The module is the first file on the stack that isn't the world or this file, skipping pass-through wrappers that other modules hang
// on shared functions (W.setDoor in js/audio.js for door sounds, BF.mobs.update in js/bees.js): those are named W.x, BF.x.y or world.x.
const MOD = /\/js\/([\w-]+)\.js/, WRAP = /^\s*at (?:W|BF|world)\.[\w.]+ \(/;
function moduleOf(stack) {
  const lines = String(stack || "").split("\n");
  for (const l of lines) { const m = MOD.exec(l); if (m && m[1] !== "requests" && m[1] !== "world" && !WRAP.test(l)) return m[1]; }
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
  return { sent: S.sent, applied: S.applied, refused: S.refused, queued: queue.length, byKind, direct: Object.assign({}, S.direct), directTotal: S.directTotal };
}
function resetStats() { S.sent = S.applied = S.refused = 0; S.byKind = {}; S.direct = {}; S.directTotal = 0; }
// The F3 line: "Requests 12 (1 refused)  Direct writes 40: miner 20, builder 12, player 8"
function text(s) {
  s = s || stats();
  return "Requests " + s.applied + (s.refused ? " (" + s.refused + " refused)" : "") + "  Direct writes " + s.directTotal +
    (s.directTotal ? ": " + top(s.direct, 4).map(([m, n]) => m + " " + n).join(", ") : "");
}

const R = {
  send, on, apply, deliver, beginTick, blocks, endTick, stats, resetStats, text, order,
  get phase() { return phase; },
  direct: true, strict: false,
  queued: () => queue.length,
  reset() { queue = []; done = []; seq = 0; phase = "idle"; hourAt = null; resetStats(); H.sent = H.refused = H.directTotal = 0; H.byKind = {}; H.direct = {}; unhandled.clear(); },
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
