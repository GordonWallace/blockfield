// Villagers at furnaces (BF.furnaceUse): the shared furnace routine of the toolsmith smelting ore (js/toolsmith.js) and of any villager
// cooking eggs (js/eggcook.js). Nothing here cooks anything: the furnace block's own state (BF.inventory furnaceState / furnaceRecord) does,
// in game time (simTick), exactly as for the player; villagers only put things in and take them out.
// - Registry: every loaded furnace block by position (scanned as chunks load, kept up to date on block events; checked again before use).
// - One villager at a time: a villager that loaded a furnace holds it (inUse) while it is still at it (each module tells busyWhen how to see
//   that: the toolsmith's stage "smelt", an egg cook's stage "cook"). A furnace is usable when its input and output slots are empty (or hold
//   the same input / its product) and nobody else is using it.
// - Loading: the input goes in up to a stack; fuel already in the furnace is burnt first, the villager adds its own only once that runs out,
//   enough for what is left in the input slot. Emptying: the product and all the fuel left (its own or not), and, when it gives up, the
//   input it put in.
// - Buying (fuel, ore): at the seller's own offer (stock and room rules of trading.js), from anyone in the village except wares that seller
//   gets from the daily restock (trading.js PRODUCE: those appear from nothing).
// See CONTRACT.md "Toolsmiths" and "Egg cooking".
(() => {
"use strict";
const BF = window.BF;
const TR = () => BF.trades;
const INV = () => BF.inventory;

const COOK = 10;                               // seconds one item takes in a furnace (inventory.js COOK_TIME)
const PER_COAL = 8, PER_WOOD = 1.5;            // items one coal / one log or plank smelts (inventory.js fuel: 80 s, 15 s; 10 s an item)
const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const I = n => BF.I[n];
const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const count = (m, id) => TR().inv.count(m.inv, id);
const isPlanks = id => { const n = nameOf(id); return n === "planks" || /_planks$/.test(n); };
const isLog = id => { const n = nameOf(id); return /_log$/.test(n) && !/^stripped_/.test(n); };
const isCoal = id => id === I("coal") || id === I("charcoal");
const isFuel = id => isCoal(id) || isLog(id) || isPlanks(id);
const fuelWorth = id => (isCoal(id) ? PER_COAL : isLog(id) || isPlanks(id) ? PER_WOOD : 0);
const sum = (m, f) => { let n = 0; for (const s of m.inv) if (s && f(s.id)) n += s.count; return n; };

// ---------------------------------------------------------------- furnaces in the world
const furnaces = new Map(), inUse = new Map();   // "x,y,z" -> {x,y,z}; "x,y,z" -> villager using it
const pk = (x, y, z) => x + "," + y + "," + z;
const busy = [];                                 // tests "is this villager still at the furnace it loaded?" (one per module)
const busyWhen = f => { if (typeof f === "function") busy.push(f); };
const atFurnace = u => busy.some(f => f(u));
let hooked = false, FLAG = null;
function hook() {
  if (hooked || !BF.world || !BF.on || BF.B.furnace == null) return;
  hooked = true;
  FLAG = new Uint8Array((BF.MAX_BLOCK || 4095) + 1); for (const b of BF.blocks) if (b && BF.isFurnace(b.id)) FLAG[b.id] = 1;
  const scan = (cx, cz, c) => { const CS = BF.CS; BF.world.scanFlagged(c, FLAG, (lx, y, lz) => furnaces.set(pk(cx * CS + lx, y, cz * CS + lz), { x: cx * CS + lx, y, z: cz * CS + lz })); };
  BF.world.onChunkLoad(scan);
  if (BF.world.onChunkUnload) BF.world.onChunkUnload((cx, cz) => { const CS = BF.CS; for (const [k, f] of furnaces) if (Math.floor(f.x / CS) === cx && Math.floor(f.z / CS) === cz) furnaces.delete(k); });
  for (const c of BF.world.chunks.values()) scan(c.cx, c.cz, c);
  BF.on("blockPlaced", (x, y, z, id) => { if (BF.isFurnace(id)) furnaces.set(pk(x, y, z), { x, y, z }); });
  BF.on("blockBroken", (x, y, z) => furnaces.delete(pk(x, y, z)));
  BF.on("newWorld", () => { furnaces.clear(); inUse.clear(); });
}
const reachOf = R => Math.max(48, (R && R.wg && R.wg.reach) || 0);
// Can m use the furnace at f for input inId (product outId) now? (still a furnace, input / output free or holding the same, nobody else at it)
function usable(m, f, inId, outId) {
  if (!f || !BF.isFurnace(BF.world.getBlock(f.x, f.y, f.z))) return false;
  const u = inUse.get(pk(f.x, f.y, f.z));
  if (u && u !== m && !u.dead && !u.removed && atFurnace(u)) return false;
  const st = INV().furnaceState(f.x, f.y, f.z);
  if (!st) return true;
  const a = st.slots[0], o = st.slots[2];
  if (a && (inId == null || a.id !== inId)) return false;
  if (o && (inId == null || o.id !== outId)) return false;
  return true;
}
// The furnaces of m's village it may use for inId (`own` first, then the nearest), or [] when there is none. skip(f): one it gave up on a while.
function near(m, inId, outId, skip, own) {
  hook();
  const R = m.village, out = [];
  if (!R) return out;
  const reach = reachOf(R) + 8;
  for (const f of furnaces.values()) {
    if (Math.hypot(f.x + 0.5 - R.x, f.z + 0.5 - R.z) > reach || (skip && skip(f))) continue;
    if (usable(m, f, inId, outId)) out.push(f);
  }
  const d = f => (own && f.x === own.x && f.y === own.y && f.z === own.z ? -1e6 : 0) + Math.hypot(f.x - m.position.x, f.z - m.position.z) + Math.abs(f.y - m.position.y) * 2;
  return out.sort((a, b) => d(a) - d(b));
}

// ---------------------------------------------------------------- fuel
// Fuel from its pack enough to smelt n items: [{id, n}] (coal first, then logs, then planks past 3), [] when it has too little.
// ok(id): fuel it may burn (default any).
function fuelFor(m, n, ok) {
  const out = [];
  let left = n;
  const plankSpare = Math.max(0, sum(m, isPlanks) - 3);
  for (const pass of [isCoal, isLog, isPlanks]) {
    for (const s of m.inv) {
      if (left <= 0) break;
      if (!s || !pass(s.id) || (ok && !ok(s.id))) continue;
      const already = out.filter(e => e.id === s.id).reduce((a, e) => a + e.n, 0);
      let avail = s.count - already;
      if (pass === isPlanks) avail = Math.min(avail, plankSpare - out.filter(e => isPlanks(e.id)).reduce((a, e) => a + e.n, 0));
      if (avail <= 0) continue;
      const k = Math.min(avail, Math.ceil(left / fuelWorth(s.id)));
      out.push({ id: s.id, n: k }); left -= k * fuelWorth(s.id);
    }
  }
  return left > 0 ? [] : out;
}
// Items the fuel now in the furnace at f still smelts (the flame burning counts as one).
function fuelIn(f) { const st = INV().furnaceState(f.x, f.y, f.z); return st ? (st.burn > 0 ? 1 : 0) + (st.slots[1] ? st.slots[1].count * fuelWorth(st.slots[1].id) : 0) : 0; }

// ---------------------------------------------------------------- loading, topping up, emptying
// job: {furnace: {x,y,z}, rawId, outId, loaded?, ownFuel?, fuelOk?}. Puts up to `max` of rawId in (a stack at most), takes the furnace (inUse)
// and adds fuel when the furnace has none left. Returns the number put in (0 when the furnace cannot be used).
function load(m, job, max) {
  const f = job.furnace, T = TR().inv;
  if (!usable(m, f, job.rawId, job.outId)) return 0;
  const st = INV().furnaceRecord(f.x, f.y, f.z);
  inUse.set(pk(f.x, f.y, f.z), m);
  const room = stackOf(job.rawId) - (st.slots[0] ? st.slots[0].count : 0), outRoom = stackOf(job.outId) - (st.slots[2] ? st.slots[2].count : 0);
  const n = Math.min(count(m, job.rawId), max == null ? Infinity : max, room, outRoom);
  if (n <= 0) return 0;
  T.remove(m.inv, job.rawId, n);
  if (st.slots[0]) st.slots[0].count += n; else st.slots[0] = { id: job.rawId, count: n };
  job.loaded = (job.loaded || 0) + n;
  topUp(m, job, st);
  return n;
}
// Adds its own fuel only once the furnace has burnt what was in it: enough for the input still in the slot (or all it has, for part of it).
function topUp(m, job, st) {
  if (st.burn > 0 || st.slots[1] || !st.slots[0]) return;
  const need = st.slots[0].count - (st.cook > 0 ? st.cook / COOK : 0);
  let fuel = fuelFor(m, need, job.fuelOk);
  if (!fuel.length) { const any = m.inv.find(s => s && isFuel(s.id) && (!job.fuelOk || job.fuelOk(s.id))); if (any) fuel = [{ id: any.id, n: Math.min(any.count, 64) }]; }   // part of the input
  if (!fuel.length) return;
  const f = fuel[0];   // one fuel kind fits the slot
  TR().inv.remove(m.inv, f.id, f.n);
  st.slots[1] = { id: f.id, count: f.n };
  job.ownFuel = (job.ownFuel || 0) + f.n;
}
// Lets go of the furnace and takes the product out, and all the fuel left in it (its own or not); also the input it put in when `all`
// (it gives up). Returns [{id, n}] taken, or null when the furnace has no state (nothing to take).
function empty(m, job, all) {
  const f = job.furnace, st = INV().furnaceState(f.x, f.y, f.z), T = TR().inv;
  inUse.delete(pk(f.x, f.y, f.z));
  if (!st) return null;
  const got = [];
  const grab = i => { const s = st.slots[i]; if (!s) return; const left = T.add(m.inv, s.id, s.count); if (left < s.count) got.push({ id: s.id, n: s.count - left }); if (left > 0) s.count = left; else st.slots[i] = null; };
  grab(2); grab(1);
  if (all && st.slots[0] && st.slots[0].id === job.rawId) grab(0);
  return got;
}

// ---------------------------------------------------------------- walking to a furnace / a seller
// One step towards (tx, ty, tz) on a path of route kind `kind`: "arrived", "going" or "failed". near(x, y, z): the feet cells that count as there.
function travel(m, st, dt, out, tx, ty, tz, speed, near, kind) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z, rk = kind || "tsm";
  if (near ? near(...N.feetCell(m)) : Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) <= 1.75 && Math.abs(ty - m.position.y) < 1.6) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== rk) {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const goal = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: near || ((x, y, z) => Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1) };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = rk; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}
// Standing beside the furnace at s (a side cell, not on top of it).
const beside = s => (x, y, z) => Math.abs(x - s.x) + Math.abs(z - s.z) === 1 && Math.abs(y - s.y) <= 1;

// ---------------------------------------------------------------- buying
// loose: also sellers who cannot trade right now (asleep, busy, down a mineshaft, out of stock) and ones it gave up on for a while: "sold here at all"
const canSell = (m, v2, loose) => v2 && v2 !== m && v2.type === "villager" && !v2.dead && !v2.removed && !v2.child && Array.isArray(v2.inv) && Array.isArray(v2.trades)
  && (loose || (!v2.sleeping && !v2.tradingWith && v2.position && v2.position.y > m.position.y - 6));   // not deep in a mineshaft
const restocked = (v2, id) => ((TR().PRODUCE[v2.profession] || []).includes(nameOf(id)));
// Offers of m's village that sell an item matching f, which m can pay for: [{v2, o, max}] (max = how many times), the nearest first.
// skip(v2, o): an offer it gave up on a while (not checked when loose).
function offersFor(m, f, loose, skip) {
  const R = m.village, T = TR(), out = [];
  if (!R) return out;
  for (const v2 of R.members || []) {
    if (!canSell(m, v2, loose)) continue;
    for (const o of v2.trades) {
      if (o.feed || !f(o.sell.id) || restocked(v2, o.sell.id) || (!loose && T.blockReason(v2, o))) continue;
      if (!loose && skip && skip(v2, o)) continue;
      let k = loose ? Infinity : Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n);   // loose: it sells this, even if it has none in hand right now
      for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
      if (k < 1) continue;
      out.push({ v2, o, max: k, d: v2.position ? v2.position.distanceTo(m.position) : Infinity });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
// Emeralds needed to buy n items matching f (cheapest offers first), or Infinity when the village does not sell that many.
function priceOf(m, f, n, loose, skip) {
  const list = offersFor(m, f, loose, skip).filter(e => e.o.buy.every(b => b.id === I("emerald")))
    .sort((a, b) => a.o.buy[0].n / a.o.sell.n - b.o.buy[0].n / b.o.sell.n);
  let cost = 0;
  for (const e of list) {
    if (n <= 0) break;
    const k = Math.min(e.max, Math.ceil(n / e.o.sell.n));
    cost += k * e.o.buy[0].n; n -= k * e.o.sell.n;
  }
  return n > 0 ? Infinity : cost;
}
// A buying deal for need {f, n, what}: {kind: "buy", other, offer, times, item, what}, the nearest seller.
function findDeal(m, need, skip) {
  const T = TR();
  for (const e of offersFor(m, need.f, false, skip)) {
    let k = Math.min(e.max, Math.ceil(need.n / e.o.sell.n), 4);
    while (k > 0 && !T.inv.canFit(m.inv, [{ id: e.o.sell.id, n: e.o.sell.n * k }], e.o.buy.map(b => ({ id: b.id, n: b.n * k })))) k--;
    if (k > 0) return { kind: "buy", other: e.v2, offer: e.o, times: k, item: e.o.sell.id, what: need.what };
  }
  return null;
}
// Trades deal.times times (fewer when the seller runs out or refuses); logs the trade to the village log. Returns how many went through.
function doBuy(m, deal) {
  const T = TR(), v2 = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(m, v2) || T.blockReason(v2, o)) break;
    if (!o.buy.every(b => T.inv.count(m.inv, b.id) >= b.n)) break;
    if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
    const sold = T.exchange(v2, o);
    if (!sold) break;
    for (const b of o.buy) T.inv.remove(m.inv, b.id, b.n);
    T.inv.addStacks(m.inv, sold);
    T.addXp(v2, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(m, v2, o, done);
  return done;
}

BF.furnaceUse = {
  COOK, PER_COAL, PER_WOOD, furnaces, inUse, pk, hook, busyWhen, atFurnace, usable, near, reachOf,
  isCoal, isLog, isPlanks, isFuel, fuelWorth, fuelFor, fuelIn, load, topUp, empty, travel, beside, canSell, restocked, offersFor, priceOf, findDeal, doBuy,
};
})();
