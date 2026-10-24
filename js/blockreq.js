// Villager block edits as requests (spec r15-18). Foresters, miners, builders and farmers no longer write the world in their think: they
// send one "block" request (js/requests.js) per action, and it is applied in the tick's apply phase, in requester-id order. The apply
// checks that every cell still holds what the villager saw, changes them all or none, moves the items (what the villager hands over and
// what it gets from the broken blocks) and fires blockPlaced / blockBroken. So two villagers can never take the same block: the second
// is refused ("changed") and re-plans as it does when its target disappears, and a block's items go to exactly one villager.
// The result arrives at the end of the tick (BF.req.deliver), before the villager's next think: what used to follow the write in the
// same step (sounds, counters, the next blueprint cell) goes in req.then(...). Work durations are unchanged; the result is one tick later.
// Until r15-21 / r15-22 make inventories transactions, the apply writes the requester's inventory directly (the apply phase is ordered).
//
// Kind "block": target "x,y,z" (the first cell), from = the villager, data:
//   cells  [{x, y, z, expect, id, drops?, opt?, emit?}]: expect is the block the villager saw there (null: not checked), id the new block.
//          drops: what happens to the old block's items: "inv" all into the pack (refused "full" when they don't fit), "add" into the pack
//          with no room check (what doesn't fit is lost, as the farmers' plant clearing did), "fit" each stack that fits, "world" dropped
//          as item entities. opt: a cell that changed is left alone instead of refusing the whole request (a tree's leaves).
//          emit: "placed" | "broken" fires that event for the cell.
//   take   [{id, n}] items it uses up (refused "missing" when it doesn't hold them); give [{id, n}] items it gets (a filled bucket).
//   giver  the name of a module's own drop rule (BF.blockReq.giver(name, fn(m, cell, was) -> [{id, count}] got)), e.g. the miner's keep list.
//   why    what it is doing (the request log line).
// Result: {ok, was: [old id per cell, -1 skipped], got: [{id, count}]} or {ok: false, why: "changed" | "unloaded" | "full" | "missing" | "gone" | "refused"}.
// Game log: INFO "requests" line for each refused villager block request (who, what, where, why), at most 30 a game hour.
// API: BF.blockReq = { send(m, cells, {take, give, giver, why, wait}) -> req, busy(m), result(m), giver(name, fn), cell(x, y, z, expect, id, more), flush() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const givers = new Map();
const pend = new WeakMap();   // villager -> its last block request (not saved: a restored villager that was waiting finds none and re-plans)
const STALE = 4;              // ticks: a request lost to a world reset counts as refused
let logHour = -1, logged = 0;
const HOUR = 1200 / 24;

const inv = () => BF.trades.inv;
function cell(x, y, z, expect, id, more) { const c = { x, y, z, expect, id }; return more ? Object.assign(c, more) : c; }

function send(m, cells, opts) {
  const o = opts || {}, c0 = cells[0];
  const req = BF.req.send("block", c0.x + "," + c0.y + "," + c0.z, { cells, take: o.take, give: o.give, giver: o.giver, why: o.why || "" }, m);
  if (m && typeof m === "object" && o.wait !== false) pend.set(m, req);   // wait: false for one it doesn't wait on (a miner's torch)
  return req;
}
// Still waiting for the result of its last request (sent this tick, or between ticks).
// Outside a tick (a test or tool running a villager's AI by hand, BF.mobs.update without BF.simStep) nothing would apply it: the queue
// is applied and delivered here, at the villager's next think, which is when a tick would have done it.
function busy(m) {
  const r = pend.get(m);
  if (!r || r.result !== undefined) return false;
  if (BF.req.phase === "idle" && BF.req.queued()) { flush(); if (r.result !== undefined) return false; }
  if ((BF.rand ? BF.rand.tick : 0) - r.tick > STALE) { pend.delete(m); return false; }
  return true;
}
// The result of its last request: undefined while waiting, {ok: false, why: "lost"} when it never came.
function result(m) {
  const r = pend.get(m);
  if (!r) return { ok: false, why: "lost" };
  if (r.result !== undefined) return r.result;
  return busy(m) ? undefined : { ok: false, why: "lost" };
}

function note(req, m, why) {
  if (!BF.glog) return;
  const h = Math.floor((BF.simNow ? BF.simNow() : 0) / HOUR);
  if (h !== logHour) { logHour = h; logged = 0; }
  if (++logged > 30) return;
  const who = m ? (BF.vlog && BF.vlog.nameOf ? BF.vlog.nameOf(m) : m.id) + " (" + (m.profession || m.type) + ")" : String(req.from || "nobody");
  BF.glog.log("INFO", "requests", "Block request refused: " + who + " " + (req.data.why || "block edit") + " at " + req.target + ": " + why);
}

BF.req.on("block", (req, W) => {
  const d = req.data, cells = d.cells || [], m = req.from != null && BF.ids ? BF.ids.get(req.from) : null;
  const T = inv(), needInv = !!(d.take || d.give || d.giver || cells.some(c => c.drops && c.drops !== "world"));
  const no = why => { note(req, m, why); return { ok: false, why }; };
  if (needInv && (!m || m.removed || m.dead || !Array.isArray(m.inv))) return no("gone");
  // every cell as the villager saw it
  const was = [];
  for (const c of cells) {
    if (!W.isLoaded(c.x, c.z)) { if (c.opt) { was.push(-1); continue; } return no("unloaded"); }
    const cur = W.getBlock(c.x, c.y, c.z);
    if (c.expect != null && cur !== c.expect) { if (c.opt) { was.push(-1); continue; } return no("changed"); }
    was.push(cur);
  }
  // the items: what it hands over, and what it gets (all of it must fit)
  for (const t of d.take || []) if (T.count(m.inv, t.id) < t.n) return no("missing");
  const rolled = cells.map((c, i) => (c.drops && was[i] > 0 && BF.rollDrops ? BF.rollDrops(was[i]) : null));
  const must = (d.give || []).slice();
  cells.forEach((c, i) => { if (c.drops === "inv" && rolled[i]) for (const x of rolled[i]) must.push({ id: x.id, n: x.count }); });
  if (must.length && !T.canFit(m.inv, must, d.take || [])) return no("full");
  // the blocks, all or none
  const set = [];
  for (let i = 0; i < cells.length; i++) {
    if (was[i] < 0) continue;
    const c = cells[i];
    if (!W.setBlock(c.x, c.y, c.z, c.id)) {
      for (let j = set.length - 1; j >= 0; j--) W.setBlock(cells[set[j]].x, cells[set[j]].y, cells[set[j]].z, was[set[j]]);
      return no("refused");
    }
    set.push(i);
  }
  const got = [];
  const gain = (id, n) => { if (n > 0) { const g = got.find(x => x.id === id); if (g) g.count += n; else got.push({ id, count: n }); } };
  for (const t of d.take || []) T.remove(m.inv, t.id, t.n);
  for (const g of d.give || []) gain(g.id, g.n - T.add(m.inv, g.id, g.n));
  const giver = d.giver ? givers.get(d.giver) : null;
  for (const i of set) {
    const c = cells[i], ds = rolled[i];
    if (giver && was[i] > 0) for (const x of giver(m, c, was[i]) || []) gain(x.id, x.count);
    if (!ds) continue;
    if (c.drops === "world") { if (BF.drops) BF.drops.spawnAt(ds, c.x, c.y, c.z); continue; }
    for (const x of ds) {
      if (!BF.items[x.id]) continue;
      if (c.drops === "fit" && !T.canFit(m.inv, [{ id: x.id, n: x.count }], [])) continue;   // what does not fit is left in the ground
      gain(x.id, x.count - T.add(m.inv, x.id, x.count));
    }
  }
  if (BF.emit) for (const i of set) { const c = cells[i]; if (c.emit === "placed") BF.emit("blockPlaced", c.x, c.y, c.z, c.id); else if (c.emit === "broken") BF.emit("blockBroken", c.x, c.y, c.z, was[i]); }
  return { ok: true, was, got };
});

// For tests and tools that call a villager's action directly between ticks: applies the queued requests and delivers their results now.
function flush() { BF.req.apply(); BF.req.deliver(); }

// BF.blockReq is shared with js/blockreqs.js (spec r15-19: cells, door, free, tick), loaded before this file.
Object.assign(BF.blockReq || (BF.blockReq = {}), { send, busy, result, cell, flush, giver: (name, fn) => givers.set(name, fn) });
})();
