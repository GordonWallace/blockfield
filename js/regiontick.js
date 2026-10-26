// Region-scoped tick (spec r15-33). The think and apply phases of the two-phase tick (r15-17, js/requests.js) run region by region
// (r15-30, js/regions.js), still on one thread. This is the shape that lets several workers tick regions later (r15-39) without
// changing any results:
//   think    the regions with loaded mobs (or the set BF.rtick.active picks, r15-34) go into a shared queue in key order; a worker (here
//            the one thread) takes the next region from the counter and updates its mobs in id order. A mob reads anything (other
//            regions' state included) and changes the world only through requests;
//   apply    each request went to the inbox of the region it targets (the target cell's, or the target mob's or drop's); the inboxes
//            apply one region at a time in key order, each sorted by (requester id, sequence), then the global inbox in the same order:
//            new mobs (ids), trades (two villagers' packs, maybe in two regions), block edits whose cells span two regions, and requests
//            with no place. A request for a cell whose chunk isn't loaded is refused ("inactive");
//   blocks   block ticks (fluids, crops, farmland, grass) after every region has applied, in canonical cell order (js/world.js tickSim):
//            fluid spread evaluates every cell before writing any, under one budget, so it stays one pass over the loaded world;
//   handoff  mobs and drops whose position changed region move in the index at the end of the tick (BF.regions.tick, js/boot.js).
// Wide effects (a creeper's blast) send one request per region they reach, applied in region order in the same tick (js/mobs.js).
// BF.rtick.order: "region" (the default), "list" (the single-list tick of r15-17: mobs in list order, one sorted apply list) or
// "reverse" (regions visited and applied in reverse key order). All three give the same world (test/region-tick.js); a difference
// is a hidden order dependency.
// Debug screen and F3: regions ticked, mobs and requests per region, ms per phase (BF.req.times). Game log: INFO "regions" once a game
// hour while the debug overlay or debug screen is on, and an INFO line when the order is changed.
// API: BF.rtick = { order (get / set), active: null | (key) -> bool, plan(list) -> mobs in tick order, take() -> next region key or
//                   undefined, spans (the last plan's regions: key, first index, ...), route(req) -> key or -1, stats() -> {regions, mobs, requests, inactive, ticks, ms: {think, apply, blocks,
//                   deliver}}, text(), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const HOUR = 1200 / 24;

let order = "region";
const S = { ticks: 0, regions: 0, mobs: 0, inactive: 0, last: { regions: 0, mobs: 0, rest: 0 } };
const H = { ticks: 0, regions: 0, requests: 0, inactive: 0 };
let hourAt = null, lastTimes = null, lastApplies = 0, lastApplied = 0;
// The debug screen's and F3's figures: averages over the last window of WIN ticks (the one before the current, once there is one).
const WIN = 200;
let winAt = null, recent = null;
function roll() {
  const T = BF.req && BF.req.times ? BF.req.times() : null;
  if (!T) return;
  if (!winAt || T.ticks < winAt.ticks) { winAt = T; return; }
  const n = T.ticks - winAt.ticks;
  if (n < WIN) return;
  recent = { think: (T.think - winAt.think) / n, apply: (T.apply - winAt.apply) / n, blocks: (T.blocks - winAt.blocks) / n, deliver: (T.deliver - winAt.deliver) / n };
  winAt = T;
}

// ---------------------------------------------------------------- think: the shared queue of regions
let queue = [], next = 0;
// The last plan's regions: [key, first index in the plan, key, first index, ..., -1, first unindexed mob] (several workers split the
// plan by region, js/rworkers.js)
let spans = [];
const idCache = new Map();   // "e<n>" -> n
function idNum(m) {
  const id = m.id;
  let n = idCache.get(id);
  if (n === undefined) { n = typeof id === "string" && id.charCodeAt(0) === 101 ? +id.slice(1) : NaN; if (n !== n) n = 1e15; if (idCache.size > 100000) idCache.clear(); idCache.set(id, n); }
  return n;
}
const byId = (a, b) => idNum(a) - idNum(b);
function take() { return next < queue.length ? queue[next++] : undefined; }
// The mobs of this tick in the order they think: list order for "list"; else region by region from the queue, each region's mobs by id.
// Mobs the index doesn't hold (none, normally) think last, in list order.
function plan(list) {
  S.ticks++; H.ticks++;
  roll();
  const G = BF.regions;
  if (order === "list" || !G || !G.regionOf) { S.last = { regions: 0, mobs: list.length, rest: 0 }; spans = [-1, 0]; return list.slice(); }
  const by = G.mobsByRegion();
  queue = [];
  for (const k of by.keys()) if (!rt.active || rt.active(k)) queue.push(k);
  queue.sort(order === "reverse" ? (a, b) => b - a : (a, b) => a - b);
  next = 0;
  const out = [];
  spans = [];
  let k;
  while ((k = take()) !== undefined) {
    const start = out.length;
    spans.push(k, start);
    let sorted = true, last = -Infinity;
    for (const m of by.get(k)) { const n = idNum(m); if (n < last) sorted = false; last = n; out.push(m); }
    if (!sorted) { const part = out.splice(start).sort(byId); for (const m of part) out.push(m); }
  }
  const n = out.length;
  spans.push(-1, n);   // (the mobs the index doesn't hold, if any)
  for (const m of list) { const k = G.regionOf(m); if ((k === undefined || k < 0) && !m.removed) out.push(m); }
  S.regions = queue.length; S.mobs = n;
  H.regions += queue.length;
  S.last = { regions: queue.length, mobs: n, rest: out.length - n };
  return out;
}

// ---------------------------------------------------------------- apply: routing a request to its region's inbox
const CELL = /^(?:[a-z]+:)?(-?\d+),(-?\d+),(-?\d+)$/;
function route(req) {
  const G = BF.regions;
  if (!G) return -1;
  const d = req.data;
  if (d && typeof d.region === "number") return d.region;   // one part of a wide effect (an explosion), already split by region
  if (d && Array.isArray(d.cells) && d.cells.length > 1) {   // several cells (js/blockreqs.js "cells"): their region, or global if they span two
    let k0;
    for (const c of d.cells) { const k = G.keyOf(c.x, c.y, c.z); if (k0 === undefined) k0 = k; else if (k !== k0) return -1; }
    return k0 >= 0 ? k0 : -1;
  }
  const t = req.target;
  if (t == null) return -1;
  const s = String(t);
  let c = CELL.exec(s);
  if (c) { const k = G.keyOf(+c[1], +c[2], +c[3]); return k >= 0 ? k : -1; }
  if (/^e\d+$/.test(s)) { const m = BF.ids && BF.ids.get(s), k = m && G.regionOf(m); return k != null && k >= 0 ? k : -1; }
  if (/^d\d+$/.test(s)) { const o = BF.drops && BF.drops.get && BF.drops.get(s), k = o && G.dropRegionOf(o); return k != null && k >= 0 ? k : -1; }
  return -1;
}
// A request for a cell whose chunk isn't loaded: its region isn't simulated, so it is refused (applyOne in js/requests.js).
function inactive(req) {
  if (req.region == null || req.region < 0 || (req.data && typeof req.data.region === "number")) return null;
  const c = CELL.exec(String(req.target));
  if (!c || !BF.world || BF.world.isLoaded(+c[1], +c[3])) return null;
  S.inactive++; H.inactive++;
  return { ok: false, why: "inactive" };
}
function regionOrder(keys) { keys.sort(order === "reverse" ? (a, b) => b - a : (a, b) => a - b); }

function setOrder(o) {
  if (o !== "region" && o !== "list" && o !== "reverse") throw new Error('BF.rtick.order is "region", "list" or "reverse"');
  if (o === order) return;
  order = o;
  if (BF.req) BF.req.single = o === "list";
  if (BF.glog) BF.glog.log("INFO", "regions", "Region tick order set to " + o + (o === "list" ? " (the single-list tick)" : ""));
}

// ---------------------------------------------------------------- reporting
function stats() {
  const T = BF.req && BF.req.times ? BF.req.times() : { ticks: 0, think: 0, apply: 0, blocks: 0, deliver: 0 };
  const n = Math.max(1, T.ticks), r = BF.req ? BF.req.stats() : { regionApplies: 0, applied: 0 };
  return { order, regions: S.last.regions, mobs: S.last.mobs, unindexed: S.last.rest, ticks: S.ticks, inactive: S.inactive,
    regionApplies: r.regionApplies, requests: r.applied,
    ms: recent || { think: T.think / n, apply: T.apply / n, blocks: T.blocks / n, deliver: T.deliver / n },
    byRegion: busiest(8) };
}
// the regions with the most mobs: [{name, mobs}]
function busiest(n) {
  const G = BF.regions;
  if (!G || !G.mobsByRegion) return [];
  const out = [];
  for (const [k, ms] of G.mobsByRegion()) out.push({ key: k, name: G.name(k), mobs: ms.size });
  return out.sort((a, b) => b.mobs - a.mobs || a.key - b.key).slice(0, n);
}
const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
// The F3 line: "Regions 12 (140 mobs)  think 2.10  apply 0.12  blocks 0.30 ms"
function text(s) {
  s = s || stats();
  return "Regions " + s.regions + " (" + s.mobs + " mobs)" + (s.order !== "region" ? " [" + s.order + "]" : "") +
    "  think " + f2(s.ms.think) + "  apply " + f2(s.ms.apply) + "  blocks " + f2(s.ms.blocks) + " ms";
}
// Once a game hour while the debug overlay or debug screen is on: the averages since the last line.
function hourly() {
  const now = BF.simNow ? BF.simNow() : 0;
  if (hourAt == null || now < hourAt) { hourAt = now; lastTimes = BF.req && BF.req.times ? BF.req.times() : null; return; }
  if (now - hourAt < HOUR) return;
  hourAt = now;
  const T = BF.req && BF.req.times ? BF.req.times() : null, r = BF.req ? BF.req.stats() : null;
  const live = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (live && T && lastTimes && H.ticks && BF.glog) {
    const n = Math.max(1, T.ticks - lastTimes.ticks), ms = p => f2((T[p] - lastTimes[p]) / n);
    const applies = r ? r.regionApplies - lastApplies : 0, reqs = r ? r.applied - lastApplied : 0;
    BF.glog.log("INFO", "regions", "Region tick in the last game hour: " + f2(H.regions / H.ticks) + " regions a tick" +
      ", " + f2(applies / H.ticks) + " region inboxes applied a tick (" + reqs + " requests" + (H.inactive ? ", " + H.inactive + " refused as inactive" : "") + ")" +
      "; ms a tick: think " + ms("think") + ", apply " + ms("apply") + ", blocks " + ms("blocks") + ", deliver " + ms("deliver") + (order !== "region" ? " (order " + order + ")" : ""));
  }
  lastTimes = T; if (r) { lastApplies = r.regionApplies; lastApplied = r.applied; }
  H.ticks = H.regions = H.requests = H.inactive = 0;
}

function reset() {
  queue = []; next = 0; hourAt = null; lastTimes = null; lastApplies = lastApplied = 0; winAt = null; recent = null;
  S.ticks = S.regions = S.mobs = S.inactive = 0; S.last = { regions: 0, mobs: 0, rest: 0 };
  H.ticks = H.regions = H.requests = H.inactive = 0;
}

const rt = {
  get order() { return order; }, set order(o) { setOrder(o); },
  active: null, plan, take, route, inactive, stats, text, hourly, reset,
  get spans() { return spans; },
};
BF.rtick = rt;
if (BF.req) { BF.req.route = route; BF.req.regionOrder = regionOrder; BF.req.inactive = inactive; }
if (BF.on) BF.on("newWorld", reset);
})();
