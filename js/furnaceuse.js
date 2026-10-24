// Villagers at furnaces (BF.furnaceUse): the shared furnace routine of the toolsmith smelting ore (js/toolsmith.js) and of any villager
// cooking eggs (js/eggcook.js). Nothing here cooks anything: the furnace block's own state (BF.inventory furnaceState / furnaceRecord) does,
// in game time (simTick), exactly as for the player; villagers only put things in and take them out.
// - Registry: every loaded furnace block by position (scanned as chunks load, kept up to date on block events; checked again before use).
// - One villager at a time: a villager that loaded a furnace holds it (inUse) while it is still at it (each module tells busyWhen how to see
//   that: the toolsmith's stage "smelt", an egg cook's stage "cook"). A furnace is usable when its input and output slots are empty (or hold
//   the same input / its product) and nobody else is using it.
// - Loading, topping up and emptying are "furnace" requests (spec r15-22), applied in requester order with the furnace checked again.
// - Loading: the input goes in up to a stack; fuel already in the furnace is burnt first, the villager adds its own only once that runs out,
//   enough for what is left in the input slot. Emptying: the product and all the fuel left (its own or not), and, when it gives up, the
//   input it put in.
// - Buying (fuel, ore): at the seller's own offer (stock and room rules of trading.js), from anyone in the village except wares that seller
//   gets from the daily restock (trading.js PRODUCE: those appear from nothing).
// See CONTRACT.md "Toolsmiths" and "Egg cooking".
(() => {
"use strict";
const BF = globalThis.BF;
BF.debug = BF.debug || {};   // checkOffers: compare every offer lookup with a full scan (test/offers-cache.js)
const TR = () => BF.trades;
const INV = () => BF.inventory;

const COOK = 10;                               // seconds one item takes in a furnace (playerinv.js COOK_TIME)
const PER_COAL = 8, PER_WOOD = 1.5;            // items one coal / one log or plank smelts (playerinv.js fuel: 80 s, 15 s; 10 s an item)
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
// As "furnace" requests (spec r15-22): the villager asks during its think and the queue applies the requests in requester order
// (js/requests.js), so two villagers can't load one furnace or take the same output in one tick. target "x,y,z", data {op, raw, out, ...}:
//   load  {max, fuels}: up to max of raw in (a stack at most), takes the furnace (inUse), then fuel as for "fuel"; -> {n, fuel: {id, n}?}
//   fuel  {fuels}: its own fuel, only once the furnace has burnt what was in it (enough for the input still in the slot); -> {fuel}
//   empty {all}: lets go of the furnace and takes the product and all the fuel left (its own or not), the input it put in when all; -> {got}
// fuels: the fuel ids it may burn (job.fuelOk, worked out at the send). Each is checked again when applied: the furnace still stands and
// is usable by it, it still holds what it puts in, and has room for what it takes out. Results reach the job before the next think.
const pend = new WeakMap();   // job -> {op, req}: a request in flight
const fuelsOf = (m, job) => [...new Set(m.inv.filter(s => s && isFuel(s.id) && (!job.fuelOk || job.fuelOk(s.id))).map(s => s.id))];
const inFlight = (job, op) => { const p = pend.get(job); return p && p.op === op && p.req.result === undefined && (BF.rand ? BF.rand.tick - p.req.tick < 4 : true) ? p : null; };
// Sends the load; returns null while it is in flight, then the number put in (0 when the furnace could not be used).
function load(m, job, max) {
  const f = job.furnace, p = pend.get(job);
  if (p && p.op === "load") {
    if (inFlight(job, "load")) return null;
    pend.delete(job);
    return p.req.result ? p.req.result.n || 0 : 0;
  }
  if (!usable(m, f, job.rawId, job.outId)) return 0;
  const req = BF.req.send("furnace", pk(f.x, f.y, f.z), { op: "load", raw: job.rawId, out: job.outId, max: max == null ? null : max, fuels: fuelsOf(m, job) }, m);
  req.then(r => { if (r.ok) job.loaded = (job.loaded || 0) + r.n; if (r.fuel) job.ownFuel = (job.ownFuel || 0) + r.fuel.n; });
  pend.set(job, { op: "load", req });
  return null;
}
// Asks to add its own fuel when the furnace st has run dry (nothing burning, no fuel, input waiting). Returns true while such a
// request is in flight (the furnace will have fuel before the next think, if it had any to give).
function topUp(m, job, st) {
  if (inFlight(job, "fuel")) return true;
  if (!st || st.burn > 0 || st.slots[1] || !st.slots[0]) return false;
  const fuels = fuelsOf(m, job);
  if (!fuels.length) return false;
  const f = job.furnace, req = BF.req.send("furnace", pk(f.x, f.y, f.z), { op: "fuel", raw: job.rawId, fuels }, m);
  req.then(r => { if (r.fuel) job.ownFuel = (job.ownFuel || 0) + r.fuel.n; });
  pend.set(job, { op: "fuel", req });
  return true;
}
// Lets go of the furnace and takes the product out, and all the fuel left in it; also the input it put in when `all` (it gives up).
// done(got: [{id, n}]) when applied (not called when the furnace has no state or is gone). Inside direct() (a forced stop as its
// village unloads: the villager is packed straight after) it happens at once.
let now = 0;
function empty(m, job, all, done) {
  const f = job.furnace, data = { op: "empty", raw: job.rawId, all: !!all };
  pend.delete(job);
  if (now) { const r = applyFurnace(m, pk(f.x, f.y, f.z), data); if (r.ok && done) done(r.got); return; }
  const req = BF.req.send("furnace", pk(f.x, f.y, f.z), data, m);
  if (done) req.then(r => { if (r.ok) done(r.got); });
}
const direct = fn => { now++; try { return fn(); } finally { now--; } };
// Its own fuel into the furnace st: enough for the input still in the slot (or all it has, for part of it), from fuels. -> {id, n} or null
function addFuel(m, st, fuels) {
  if (st.burn > 0 || st.slots[1] || !st.slots[0]) return null;
  const ok = id => fuels.includes(id), need = st.slots[0].count - (st.cook > 0 ? st.cook / COOK : 0);
  let fuel = fuelFor(m, need, ok);
  if (!fuel.length) { const any = m.inv.find(s => s && isFuel(s.id) && ok(s.id)); if (any) fuel = [{ id: any.id, n: Math.min(any.count, 64) }]; }   // part of the input
  if (!fuel.length) return null;
  const e = fuel[0], n = TR().inv.remove(m.inv, e.id, e.n);   // one fuel kind fits the slot
  if (!n) return null;
  st.slots[1] = { id: e.id, count: n };
  return { id: e.id, n };
}
function applyFurnace(m, key, d) {
  const [x, y, z] = key.split(",").map(Number), T = TR().inv;
  if (!m || m.removed || m.dead || !Array.isArray(m.inv)) return { ok: false, why: "requester gone" };
  if (!BF.isFurnace(BF.world.getBlock(x, y, z))) { inUse.delete(key); return { ok: false, why: "gone" }; }
  if (d.op === "empty") {
    if (inUse.get(key) === m) inUse.delete(key);
    const st = INV().furnaceState(x, y, z);
    if (!st) return { ok: false, why: "empty" };
    const got = [];
    const grab = i => { const s = st.slots[i]; if (!s) return; const left = T.add(m.inv, s.id, s.count, s.wear); if (left < s.count) got.push({ id: s.id, n: s.count - left }); if (left > 0) s.count = left; else st.slots[i] = null; };
    grab(2); grab(1);
    if (d.all && st.slots[0] && st.slots[0].id === d.raw) grab(0);
    return { ok: true, got };
  }
  const f = { x, y, z };
  if (d.op === "fuel") {
    const st = INV().furnaceState(x, y, z);
    if (!st || !st.slots[0] || st.slots[0].id !== d.raw) return { ok: false, why: "changed" };
    const fuel = addFuel(m, st, d.fuels || []);
    return fuel ? { ok: true, fuel } : { ok: false, why: "no fuel needed" };
  }
  if (d.op !== "load") return { ok: false, why: "bad op" };
  if (!usable(m, f, d.raw, d.out)) return { ok: false, why: "busy" };
  const st = INV().furnaceRecord(x, y, z);
  const room = stackOf(d.raw) - (st.slots[0] ? st.slots[0].count : 0), outRoom = stackOf(d.out) - (st.slots[2] ? st.slots[2].count : 0);
  const n = T.remove(m.inv, d.raw, Math.max(0, Math.min(T.count(m.inv, d.raw), d.max == null ? Infinity : d.max, room, outRoom)));
  if (n <= 0) return { ok: false, why: "nothing to load", n: 0 };
  inUse.set(key, m);
  if (st.slots[0]) st.slots[0].count += n; else st.slots[0] = { id: d.raw, count: n };
  const fuel = addFuel(m, st, d.fuels || []);
  return fuel ? { ok: true, n, fuel } : { ok: true, n };
}
// Game log: INFO "requests" when a villager lost a furnace to another one this tick (loaded first), or the furnace went.
if (BF.req) BF.req.on("furnace", req => {
  const m = BF.ids && BF.ids.get(req.from), r = applyFurnace(m, String(req.target), req.data || {});
  if ((r.why === "busy" || r.why === "gone") && BF.glog) BF.glog.log("INFO", "requests", (m && BF.vlog ? BF.vlog.nameOf(m) : "A villager") + " could not " + req.data.op + " the furnace at " + req.target + ": " + (r.why === "busy" ? "another villager got to it first" : "it is gone"), { at: String(req.target).split(",").map(Number), village: m && m.village });
  return r;
});

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
// Reads the village's offer table (below); BF.debug.checkOffers also runs the full scan (offersScan) and counts any difference.
function offersFor(m, f, loose, skip) {
  const R = m.village;
  if (!R) return [];
  if (!BF.debug.checkOffers) return fromTable(m, R, f, loose, skip);
  const st = BF.debug.offerStats || (BF.debug.offerStats = { calls: 0, mismatches: 0, msTable: 0, msScan: 0 });
  let t0 = performance.now();
  const out = fromTable(m, R, f, loose, skip);
  st.msTable += performance.now() - t0; t0 = performance.now();
  const ref = offersScan(m, f, loose, skip);
  st.msScan += performance.now() - t0; st.calls++;
  if (out.length !== ref.length || out.some((e, i) => e.v2 !== ref[i].v2 || e.o !== ref[i].o || e.max !== ref[i].max || e.d !== ref[i].d)) {
    if (++st.mismatches <= 5 && BF.glog) BF.glog.log("ERROR", "offers", "cached offer lookup differs from a full scan: " + out.length + " offers, scan " + ref.length, { village: R, at: m.position });
  }
  return out;
}
// The full scan offersFor reads from the table (spec r15-04): every member, every offer.
function offersScan(m, f, loose, skip) {
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
// The village's offer table: its members' offers by sold item, [{id, rows: [{i, v2, o}]}] (i: the offer's place in a full scan), without feed
// offers and the wares a seller gets from the restock. Shoppers ask several times a plan (a toolsmith prices every material), and most of a
// scan was matching each of a big village's offers against f; now f sees each sold item once. The table holds only which offers exist:
// whether a seller can trade now (canSell, blockReason: asleep, out of stock, keeping it, hungry) and its stock are checked live, so the
// answers are the full scan's. It is rebuilt when the member list, a member's offer list or a profession changes (offers are only ever
// added by replacing or pushing onto the list, js/market.js sync, trading.js addXp; prices change amounts, which are read live).
const tables = new WeakMap();   // village record -> table
function offerTable(R) {
  const ms = R.members || [], t = tables.get(R);
  if (t && t.ms === ms && t.n === ms.length) {
    const k = t.keys;
    let ok = true;
    for (let i = 0, j = 0; i < ms.length; i++, j += 4) {
      const v = ms[i], tr = v && Array.isArray(v.trades) ? v.trades : null;
      if (k[j] !== v || k[j + 1] !== tr || k[j + 2] !== (tr ? tr.length : 0) || k[j + 3] !== (v && v.profession)) { ok = false; break; }
    }
    if (ok) return t;
  }
  const keys = [], byId = new Map();
  let i = 0;
  for (const v of ms) {
    const tr = v && Array.isArray(v.trades) ? v.trades : null;
    keys.push(v, tr, tr ? tr.length : 0, v && v.profession);
    for (const o of tr || []) {
      i++;
      if (o.feed || restocked(v, o.sell.id)) continue;
      let g = byId.get(o.sell.id);
      if (!g) byId.set(o.sell.id, (g = { id: o.sell.id, rows: [] }));
      g.rows.push({ i, v2: v, o });
    }
  }
  const nt = { ms, n: ms.length, keys, groups: [...byId.values()] };
  tables.set(R, nt);
  return nt;
}
function fromTable(m, R, f, loose, skip) {
  const T = TR(), hits = [], out = [];
  for (const g of offerTable(R).groups) if (f(g.id)) for (const r of g.rows) hits.push(r);
  if (hits.length > 1) hits.sort((a, b) => a.i - b.i);   // the scan's order, so equal distances keep it (one seller's offers)
  let last, ok = false;
  for (const { v2, o } of hits) {
    if (v2 !== last) { last = v2; ok = canSell(m, v2, loose); }
    if (!ok) continue;
    if (!loose && T.blockReason(v2, o)) continue;
    if (!loose && skip && skip(v2, o)) continue;
    let k = loose ? Infinity : Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n);
    for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
    if (k < 1) continue;
    out.push({ v2, o, max: k, d: v2.position ? v2.position.distanceTo(m.position) : Infinity });
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
    if (k > 0) return BF.ids.refs({ kind: "buy", other: e.v2, offer: e.o, times: k, item: e.o.sell.id, what: need.what });
  }
  return null;
}
// Trades deal.times times (fewer when the seller runs out or refuses), as one transaction (trading.js buy, spec r15-21). Returns how many
// went through, or null while the trade is in flight (call again next tick). opts: trading.js buy's (wrap).
function doBuy(m, deal, opts) {
  const T = TR(), v2 = deal.other, o = deal.offer;
  if (!T.asked(m, v2, o) && !canSell(m, v2)) return 0;
  return T.buy(m, v2, o, deal.times, Object.assign({ guard: () => (canSell(m, v2) ? null : "busy") }, opts));
}

BF.furnaceUse = {
  COOK, PER_COAL, PER_WOOD, furnaces, inUse, pk, hook, busyWhen, atFurnace, usable, near, reachOf,
  isCoal, isLog, isPlanks, isFuel, fuelWorth, fuelFor, fuelIn, load, topUp, empty, direct, travel, beside, canSell, restocked, offersFor, offersScan, offerTable, priceOf, findDeal, doBuy,
};
})();
