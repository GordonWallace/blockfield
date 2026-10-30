// Block edits as requests for the simulation's other writers (spec r15-19): bakers' farm work, beekeepers, explorers' tents, glassmakers,
// toolsmiths, merchants' path wear, chest deliveries (js/storage.js), village sign text, and villagers' and zombies' doors and gates. Kinds on
// BF.req (js/requests.js), applied in the tick's apply phase in requester order; results arrive before the requester's next think.
//   cells      target "x,y,z" (the first cell), data {cells: [{x, y, z, id, expect, keep}], take: [{id, n}], give: [{id, n}], emit, actor, on}.
//              All or nothing: every cell loaded and holding `expect` (an id; "free": air, a plant or a replaceable block; null: anything),
//              the requester (a mob with an inventory) holding `take` and with room for `give` plus the drops of every `keep` cell. Then the
//              cells are written in order, `take` comes out and `give` and the kept drops go in, by the requester's inventory (fit: false
//              gives what fits and loses the rest instead of refusing, as a full pack always did). emit: fire
//              "blockPlaced" for each cell set to a block (actor: the villager the village log names). Result {ok, was: [ids], got: [{id, n}]}.
//   door       target "x,y,z" (either half of a door, or a fence gate), data {open}. Already in that state: ok. Two requesters setting one
//              door in the same tick: the first in requester order (the lower id) wins, a later one that wants the other state is
//              refused ("contended"), one that wants the same state succeeds. Shutting a door or gate someone stands in is refused
//              ("occupied"; the villager or herder tries again).
//   doorBreak  target "x,y,z" (the lower half), data {expect: door id}: a zombie breaks a closed door; both halves go, one door drops. The
//              break progress stays on the zombie (ai.doorT, js/mobs.js); a door opened, closed by someone else or gone is refused.
// Game log: a WARN "requests" line when a villager loses a contended door to a lower id (at most one a game hour, as it can be frequent).
// API: BF.blockReq = { cells(m, cells, opts) -> req (opts.on: a result handler's name), onResult(name, fn(m, result, data)), door(m, x, y, z, open) -> req, free(id), tick(), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const R = BF.req;
const pk = (x, y, z) => x + "," + y + "," + z;
const W = () => BF.world, TR = () => BF.trades;
const free = id => id === 0 || BF.RENDER[id] === 3 || !!(BF.REPLACEABLE && BF.REPLACEABLE[id]);
const owner = req => (req.from && BF.ids ? BF.ids.get(req.from) : null);
const stacks = a => (a || []).filter(s => s && s.n > 0);

R.on("cells", (req, w) => {
  const d = req.data, cells = d.cells || [];
  for (const c of cells) {
    if (c.y < BF.MIN_Y || c.y >= BF.H || !w.isLoaded(c.x, c.z)) return { ok: false, why: "unloaded" };
    const was = w.getBlock(c.x, c.y, c.z);
    if (c.expect === "free" ? !free(was) || BF.FLUID[was] : c.expect != null && was !== c.expect) return { ok: false, why: "changed", at: pk(c.x, c.y, c.z), was };
  }
  const m = owner(req), take = stacks(d.take), give = stacks(d.give).slice();
  const kept = [];
  for (const c of cells) if (c.keep) { const id = w.getBlock(c.x, c.y, c.z); if (id) kept.push(...BF.rollDrops(id).map(s => ({ id: s.id, n: s.count }))); }
  give.push(...kept);
  if (take.length || give.length) {
    const T = TR().inv;
    if (!m || !Array.isArray(m.inv)) return { ok: false, why: "no inventory" };
    for (const s of take) if (T.count(m.inv, s.id) < s.n) return { ok: false, why: "lacks", item: s.id };
    if (give.length && d.fit !== false && !T.canFit(m.inv, give, take)) return { ok: false, why: "full" };
  }
  const was = [];
  if (d.actor && BF.vlog) BF.vlog.actor = m;
  try {
    for (const c of cells) {
      was.push(w.getBlock(c.x, c.y, c.z));
      if (!w.setBlock(c.x, c.y, c.z, c.id)) return { ok: false, why: "refused", at: pk(c.x, c.y, c.z), was };   // (only a cell outside the world: checked above)
      if (d.emit && c.id && BF.emit) BF.emit("blockPlaced", c.x, c.y, c.z, c.id);
    }
  } finally { if (d.actor && BF.vlog) BF.vlog.actor = null; }
  if (m && Array.isArray(m.inv)) { const T = TR().inv; for (const s of take) T.remove(m.inv, s.id, s.n); for (const s of give) T.add(m.inv, s.id, s.n); }
  return { ok: true, was, got: give };
}, { onResult(m, req, r) { const fn = req.data.on && results.get(req.data.on); if (fn) fn(m, r, req.data); } });
// What a cells request's result does, by name (data.on: BF.blockReq.onResult(name, fn(m, result, data))), run by the kind's onResult. A
// request whose cells are in another cluster waits for the meeting (js/ctick.js) and is delivered there on every worker alike, where a
// req.then callback runs only on the worker that sent it: an explorer's tent pitched at a cluster's edge was a camp on that worker alone,
// and the copy check stopped the workers (Gordon's laptop, 2026-10-30). Everything the result needs goes in the data.
const results = new Map();
const onResult = (name, fn) => { results.set(name, fn); };   // (not result: js/blockreq.js has that name)

// door: the first requester in a tick fixes the door's state for that tick. Keyed by the canonical cell, so two villagers seeing a door on a
// face edge from different faces' frames meet on one key (js/planet.js canonCell).
const CC = {};
function canonKey(x, y, z) {
  if (BF.planet && BF.planet.canonCell) { const c = BF.planet.canonCell(x, z, CC); if (!c.off) return pk(c.x, y, c.z); }
  return pk(x, y, z);
}
const doorSet = new Map();   // "x,y,z" (lower half) -> state set this tick
let warnAt = -1e9;
// Apply passes (one a tick, and one each time a test applies by hand): code that runs once per think compares tick() with the value
// when it sent a request to know that request still waits for an apply. Each pass starts the doors' same-tick map afresh.
let ticks = 0;
const apply0 = R.apply;
// With clusters (spec r15-39b, js/ctick.js) each cluster applies once a tick and a meeting applies between ticks: the count is the
// tick's (2 per tick, the meeting's odd), the same whatever order the clusters run in.
R.apply = function () { const C = BF.ctick; if (C && C.on) ticks = 2 * BF.rand.tick + (C.cur ? 0 : 1); else ticks++; doorSet.clear(); return apply0.apply(this, arguments); };
R.on("door", (req, w) => {
  const [x, y, z] = String(req.target).split(",").map(Number), open = !!req.data.open;
  if (!w.isLoaded(x, z)) return { ok: false, why: "unloaded" };
  const b = BF.blocks[w.getBlock(x, y, z)], d = b && (b.door || b.gate);
  if (!d) return { ok: false, why: "changed" };
  const k = canonKey(x, b.door && b.door.upper ? y - 1 : y, z);
  if (doorSet.has(k) && doorSet.get(k) !== open) {
    const now = BF.simNow ? BF.simNow() : 0;
    if (BF.glog && now - warnAt >= 50) { warnAt = now; BF.glog.log("WARN", "requests", "Door at " + k + ": " + req.from + " wanted it " + (open ? "open" : "shut") + " but a lower id set it first this tick"); }
    return { ok: false, why: "contended" };
  }
  if (!!d.open === open) { doorSet.set(k, open); return { ok: true, same: true }; }
  // shutting a door someone stands in (positions are where every mob ended its think, spec r15-33): refused, the requester tries again
  const ly = b.door && b.door.upper ? y - 1 : y;
  if (!open && BF.mobs && BF.mobs.isOccupied && BF.mobs.isOccupied(x, ly, z)) return { ok: false, why: "occupied" };
  doorSet.set(k, open);
  if (b.gate) w.setGate(x, y, z, open); else w.setDoor(x, y, z, open);
  return { ok: true };
});
R.on("doorBreak", (req, w) => {
  const [x, y, z] = String(req.target).split(",").map(Number), id = req.data.expect;
  if (!w.isLoaded(x, z)) return { ok: false, why: "unloaded" };
  if (w.getBlock(x, y, z) !== id) return { ok: false, why: "changed" };
  w.removePartner(x, y, z, id);
  w.setBlock(x, y, z, 0);
  if (BF.drops) BF.drops.spawnAt(BF.rollDrops(id), x, y, z);
  return { ok: true };
});

// Helpers for the modules: cells(m, [{x, y, z, id, expect, keep}], {take, give, emit, actor}), door(m, x, y, z, open).
function cells(m, list, o) {
  const c = list[0];
  return R.send("cells", pk(c.x, c.y, c.z), Object.assign({ cells: list }, o || {}), m);
}
const door = (m, x, y, z, open) => R.send("door", pk(x, y, z), { open: !!open }, m);

// (with clusters, a group's own count: in its think the last apply it saw was the last tick's or a meeting's, both before 2 * tick - 1)
function tick() { const C = BF.ctick; return C && C.on && C.cur ? (BF.req.phase === "think" ? 2 * BF.rand.tick - 1 : 2 * BF.rand.tick) : ticks; }
BF.blockReq = { cells, onResult, door, free, tick, reset() { ticks = 0; warnAt = -1e9; doorSet.clear(); } };   // reset: a new world (BF.mobs.clear)
})();
