// Merchants and trading caravans between villages (BF.merchant). Release 1.3; builds on js/market.js (one market) and js/prices.js
// (prices follow demand). See CONTRACT.md "Merchants".
// - The merchant is a profession with its own jobsite, the merchant's counter (blocks.js "merchant pack"). Newly generated villages of 8 or
//   more get one per 20 villagers (mobs.js villageRoster, keys <village key>#1600+n) with a counter on the plaza (jobs.js planVillage); builders
//   put a counter in every market stall (blueprints.js), so older villages gain merchants as their builders put up stalls. A village has at
//   most max(1, floor(villagers / 20)) merchants (mayHire, used by jobs.js).
// - Surplus and lack come from prices: an item is in surplus where a villager's sell offer for it is marked down (step < 0), and lacking where
//   a buy offer for it has risen (step > 0). A trip goes to the simulated village within RANGE blocks of home where carrying goods pays best:
//   the cheapest home sell price against the dearest buy price there, 5% apart or more, less a little for the walk.
// - A trip: it buys up to CARGO_STACKS stacks of those goods from its own villagers through their sell offers (their reserves hold, js/market.js),
//   walks there, sells them into the buy offers of the villagers who want them, buys what home lacks with the takings (the same rule the other
//   way), walks home and sells those into home buy offers. Every deal is an offer with a village log trade line, so nothing appears from
//   nothing: the merchant's purse and pack are its own. Goods it could not sell stay in its pack and become its spare-goods offers.
// - One trip at a time per merchant, at most one every TRIP_EVERY game days. It walks by day; when dusk catches it away from home it pitches
//   its tent (the explorer's rule, js/explorer.js) and goes on in the morning. A merchant with no tent only sets out early enough to get back.
// - Keeping a trip loaded: setting out pins both villages and a corridor of chunks along the route (js/villagesim.js pin), so both villages and
//   the walk keep running wherever the player goes. At most 2 trips are on the road; other merchants wait. Coming home (or dying) unpins.
//   The pin and the trip are saved; a merchant reloaded mid-trip carries on from its village.
// - Path wear: each grass or dirt block a merchant steps on between villages (never inside a village's box, never farmland) is counted;
//   at WEAR_N crossings it becomes a dirt path. The counts are saved.
// - Routes (debug screen): each pair of villages that traded, trips and goods moved in the last 7 days, and whether a merchant is on the road.
// - Death on the road: its goods drop where it fell (mobKilled).
// API: BF.merchant = { PROF, RANGE, mayHire, ai, plan, statusText, reserve, pack, unpack, routes, tick, exportAll, importAll, reset, wear, LOG }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PROF = "merchant";
const RANGE = 200;              // blocks from home village centre to the other village's centre
const CARGO_STACKS = 2;         // stacks it carries each way
const TRIP_EVERY = 2;           // game days between setting out (a few trips a week)
const MIN_GAIN = 0.05;          // the buy price there must beat the price here by this much
const WALK_COST = 1 / 400;      // emeralds a block of road is worth to it (for choosing between villages)
const MIN_PROFIT = 0.5;         // emeralds a trip must be expected to make (half an emerald: bulk goods carry thin margins)
const WEAR_N = 20;              // crossings that turn grass or dirt into a dirt path
const WEAR_MAX = 6000;          // wear counts kept (oldest dropped)
const WORK_START = 0.03, DUSK = 0.45, BEDTIME = 0.5, DAY_S = 1200;
const HOME_R = 48;              // this close to its bed (or village centre) it is home and never camps
const ARRIVE_R = 6, DEAL_R = 2.6, DEAL_TIMEOUT = 60, TRIP_MAX_DAYS = 5;
const LOG = [];
const T = () => BF.trades;
const P = () => BF.prices;
const em = () => BF.I.emerald;
const nameOf = id => (BF.items[id] && BF.items[id].name) || "?";
const pretty = id => (BF.itemName ? BF.itemName(id) : nameOf(id));
const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const cnt = (m, id) => T().inv.count(m.inv, id);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const vKey = v => Math.round(v.x) + "," + Math.round(v.z);
const keyOf = m => (m && m.village && m.slot && m.slot.idx != null ? m.village.key + "#" + m.slot.idx : null);
const live = o => o && o.type === "villager" && !o.dead && !o.removed;
const who = m => (BF.vlog ? BF.vlog.nameOf(m) : "Merchant") + " (Merchant)";
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, who: keyOf(m), t: +dayNow().toFixed(3) }, data)); if (LOG.length > 300) LOG.shift(); };
const state = m => m.mc || (m.mc = { stage: null, trip: null, last: -1e9, cd: 3 + Math.random() * 5, nav: {} });

// ---------------------------------------------------------------- who may work the counter (js/jobs.js)
const capOf = R => Math.max(1, Math.floor((R.members || []).filter(live).length / 20));
function mayHire(m, s) {
  const R = m && m.village;
  if (!R) return false;
  let n = 0;
  for (const o of R.members || []) if (o !== m && live(o) && o.profession === PROF) n++;
  const J = BF.jobs, mine = m.slot ? R.key + "#" + m.slot.idx : null;
  if (J) for (const [k, c] of J.claims) {
    if (!c || !c.key || c.key === mine || c.key.indexOf(R.key + "#") !== 0) continue;
    const site = J.sites.get(k);
    if (((site && site.prof === PROF) || (c.mob && c.mob.profession === PROF)) && !(c.mob && R.members.includes(c.mob))) n++;
  }
  return n < capOf(R);
}

// ---------------------------------------------------------------- reading prices
// Villagers of village rec it could trade with (not itself, not children).
const traders = (rec, m) => (rec && rec.members || []).filter(o => o !== m && live(o) && !o.child && Array.isArray(o.inv) && Array.isArray(o.trades) && o.profession !== PROF);
// Sell offers (emeralds -> item) and buy offers (item -> emeralds) of the village, by item: Map id -> [{v, o, u, s}] (u = emeralds per item, s = step).
function book(rec, m) {
  const sells = new Map(), buys = new Map(), e = em(), Pr = P();
  if (!Pr) return { sells, buys };
  for (const v of traders(rec, m)) for (const o of v.trades) {
    if (o.horse || o.feed || o.buy.length !== 1) continue;
    const k = Pr.kind(o);
    if (k === "sell" && o.buy[0].id === e && o.sell.id !== e) {
      if (!sells.has(o.sell.id)) sells.set(o.sell.id, []);
      sells.get(o.sell.id).push({ v, o, u: Pr.unit(o), s: Pr.step(o) });
    } else if (k === "buy" && o.sell.id === e && o.buy[0].id !== e) {
      if (!buys.has(o.buy[0].id)) buys.set(o.buy[0].id, []);
      buys.get(o.buy[0].id).push({ v, o, u: Pr.unit(o), s: Pr.step(o) });
    }
  }
  for (const a of sells.values()) a.sort((x, y) => x.u - y.u);
  for (const a of buys.values()) a.sort((x, y) => y.u - x.u);
  return { sells, buys };
}
// Goods worth carrying from village `from` to village `to`: [{id, buy (cheapest seller's unit), sell (dearest buyer's unit), n (items), gain}],
// best first, and the expected profit with `purse` emeralds and room for CARGO_STACKS stacks.
function goods(from, to, m, purse) {
  const A = book(from, m), B = book(to, m), out = [];
  for (const [id, ss] of A.sells) {
    const bs = B.buys.get(id);
    if (!bs || !bs.length) continue;
    const lo = ss[0], hi = bs[0];
    if (!(hi.u > lo.u * (1 + MIN_GAIN))) continue;
    if (!(ss.some(x => x.s < 0) || bs.some(x => x.s > 0))) continue;   // surplus here or lack there: otherwise base prices already balance
    // supply: what the sellers can spare; demand: what the buyers can pay for
    let supply = 0, demand = 0;
    for (const x of ss) if (x.u < hi.u) supply += BF.market ? BF.market.spareOf(x.v, id) : cnt(x.v, id);
    for (const x of bs) if (x.u > lo.u) demand += Math.floor(cnt(x.v, em()) / x.o.sell.n) * x.o.buy[0].n;
    const n = Math.min(supply, demand, stackOf(id));
    if (n <= 0) continue;
    out.push({ id, buy: lo.u, sell: hi.u, n, gain: (hi.u - lo.u) * n });
  }
  out.sort((a, b) => b.gain - a.gain);
  let left = purse, stacks = CARGO_STACKS, profit = 0;
  const take = [];
  for (const g of out) {
    if (stacks <= 0 || left <= 0) break;
    const n = Math.min(g.n, Math.floor(left / g.buy));
    if (n <= 0) continue;
    take.push(Object.assign({}, g, { n }));
    profit += (g.sell - g.buy) * n; left -= n * g.buy; stacks--;
  }
  return { list: take, profit };
}
// Villages the merchant could go to now: simulated, loaded, within RANGE of home.
function candidates(m) {
  const home = m.village, out = [];
  if (!home || !BF.mobs.villages) return out;
  for (const rec of BF.mobs.villages.values()) {
    if (rec === home || !rec.wg || !(BF.villageSim && BF.villageSim.isActive(rec.key))) continue;
    if (!BF.world.isLoaded(rec.x, rec.z) || !traders(rec, m).length) continue;
    const d = Math.hypot(rec.x - home.x, rec.z - home.z);
    if (d <= RANGE) out.push({ rec, d });
  }
  return out.sort((a, b) => a.d - b.d);
}
// The best trip from home now: {rec, d, list, profit} or null.
function plan(m) {
  if (!m || !m.village || !P() || P().off) return null;
  const purse = cnt(m, em());
  let best = null;
  for (const c of candidates(m)) {
    const g = goods(m.village, c.rec, m, purse);
    const score = g.profit - c.d * WALK_COST;
    if (g.profit >= MIN_PROFIT && g.list.length && (!best || score > best.score)) best = { rec: c.rec, d: c.d, list: g.list, profit: g.profit, score };
  }
  return best;
}

// ---------------------------------------------------------------- deals
// Buys from seller v2 through its sell offer o, up to `want` items. Returns items bought.
function buyFrom(m, v2, o, want) {
  const Tr = T(), e = em();
  let done = 0;
  while ((done + 1) * o.sell.n <= want || (!done && want > 0 && o.sell.n <= stackOf(o.sell.id))) {   // whole lots up to what it wants (at least one)
    if (cnt(m, e) < o.buy[0].n || !Tr.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
    const sold = Tr.exchange(v2, o);                 // its stock above its reserve, its room
    if (!sold) break;
    Tr.inv.remove(m.inv, e, o.buy[0].n);
    Tr.inv.addStacks(m.inv, sold);
    Tr.addXp(v2, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(m, v2, o, done);
  return done * o.sell.n;
}
// Sells into buyer v2's buy offer o (it pays emeralds for the items), as long as the merchant has the items. Returns items sold.
function sellTo(m, v2, o, max) {
  const Tr = T(), id = o.buy[0].id;
  let done = 0;
  while ((done + 1) * o.buy[0].n <= max && cnt(m, id) >= o.buy[0].n) {
    if (!Tr.inv.canFit(m.inv, [o.sell], o.buy)) break;
    const sold = Tr.exchange(v2, o);                 // its emeralds, its room
    if (!sold) break;
    Tr.inv.remove(m.inv, id, o.buy[0].n);
    Tr.inv.addStacks(m.inv, sold);
    Tr.addXp(v2, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(m, v2, o, done);
  return done * o.buy[0].n;
}
// The errands of a shopping round in village rec: buy `list` goods (at most the expected n each, from the cheapest sellers first).
function buyErrands(rec, m, list, maxUnit) {
  const A = book(rec, m), out = [];
  for (const g of list) for (const x of A.sells.get(g.id) || []) if (x.u <= (maxUnit ? maxUnit(g) : g.sell)) out.push({ kind: "buy", v: x.v, o: x.o, id: g.id, n: g.n });
  return out;
}
// The errands of a selling round in village rec: every cargo item into the dearest buy offers that pay at least what it cost.
function sellErrands(rec, m, cargo) {
  const B = book(rec, m), out = [];
  for (const c of cargo) for (const x of B.buys.get(c.id) || []) if (x.u >= (c.cost || 0)) out.push({ kind: "sell", v: x.v, o: x.o, id: c.id });
  return out;
}

// ---------------------------------------------------------------- walking
function travel(m, st, dt, out, tx, tz, radius) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z, d = Math.hypot(tx - px, tz - pz), nv = st.nav;
  if (d <= radius) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "mc") {
    ai.route = null;
    if (nv.wait > 0) { nv.wait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const hop = d > 22 ? [Math.floor(px + (tx - px) * 20 / d), Math.floor(pz + (tz - pz) * 20 / d)] : [Math.floor(tx), Math.floor(tz)];
    const goal = { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "mc"; nv.fail = 0; }
    else { nv.fail = (nv.fail || 0) + 1; nv.wait = 0.6; if (nv.fail >= 6) { nv.fail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, 1);
  if (r === "stuck") { ai.route = null; nv.fail = (nv.fail || 0) + 1; if (nv.fail >= 4) { nv.fail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}

// ---------------------------------------------------------------- path wear
const wear = new Map();          // "x,y,z" (the ground block) -> crossings
let WEARABLE = null;
function wearable(id) {
  if (!WEARABLE) { WEARABLE = new Set(["grass", "dirt", "coarse_dirt", "podzol"].map(n => BF.B[n]).filter(x => x != null)); }
  return WEARABLE.has(id);
}
// Inside some village's box (its floors, farms and gardens are never worn).
function inVillage(x, z) {
  for (const rec of BF.mobs.villages.values()) {
    const v = rec.wg;
    if (v && v.minX != null) { if (x >= v.minX - 4 && x <= v.maxX + 4 && z >= v.minZ - 4 && z <= v.maxZ + 4) return true; }
    else if (Math.hypot(x - rec.x, z - rec.z) < 40) return true;
  }
  return false;
}
function step(m, st) {
  const x = Math.floor(m.position.x), z = Math.floor(m.position.z), y = Math.floor(m.position.y + 0.01) - 1;
  const k = x + "," + y + "," + z;
  if (st.cell === k) return;
  st.cell = k;
  if (!m.onGround || !BF.world.isLoaded(x, z) || inVillage(x, z)) return;
  const W = BF.world, id = W.getBlock(x, y, z);
  if (!wearable(id) || W.getBlock(x, y + 1, z) !== 0) return;
  const n = (wear.get(k) || 0) + 1;
  wear.delete(k);
  if (n < WEAR_N) { wear.set(k, n); if (wear.size > WEAR_MAX) wear.delete(wear.keys().next().value); return; }
  if (BF.B.dirt_path != null) { W.setBlock(x, y, z, BF.B.dirt_path); st.worn = (st.worn || 0) + 1; }
}

// ---------------------------------------------------------------- routes
const routes = new Map();        // "a|b" (sorted keys) -> {a, b, trips: [[day, items, emeralds]], total}
const routeKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
function noteTrip(home, dest, items, ems) {
  const k = routeKey(home, dest);
  let r = routes.get(k);
  if (!r) routes.set(k, r = { a: k.split("|")[0], b: k.split("|")[1], trips: [], total: 0 });
  r.trips.push([+dayNow().toFixed(3), items, ems]);
  r.total++;
  const cut = dayNow() - 7;
  r.trips = r.trips.filter(t => t[0] >= cut);
}
function routesView() {
  const cut = dayNow() - 7, onRoad = new Map();
  for (const m of BF.mobs.list) if (m.type === "villager" && m.profession === PROF && !m.dead && m.mc && m.mc.trip) {
    const k = routeKey(m.mc.trip.home, m.mc.trip.dest);
    onRoad.set(k, (onRoad.get(k) || []).concat([{ who: BF.vlog ? BF.vlog.nameOf(m) : "", stage: m.mc.stage }]));
  }
  const out = [];
  for (const [k, r] of routes) {
    const wk = r.trips.filter(t => t[0] >= cut);
    out.push({ a: r.a, b: r.b, trips: wk.length, items: wk.reduce((s, t) => s + t[1], 0), emeralds: wk.reduce((s, t) => s + t[2], 0), total: r.total, road: onRoad.get(k) || [] });
  }
  for (const [k, road] of onRoad) if (!routes.has(k)) { const [a, b] = k.split("|"); out.push({ a, b, trips: 0, items: 0, emeralds: 0, total: 0, road }); }
  return out.sort((x, y) => y.road.length - x.road.length || y.trips - x.trips);
}

// ---------------------------------------------------------------- the trip
const recOf = key => (BF.mobs.villages && BF.mobs.villages.get(key)) || null;
function cargoOf(m, ids) { const out = []; for (const id of ids) { const n = cnt(m, id); if (n > 0) out.push({ id, n }); } return out; }
const listText = l => l.map(g => g.n + " " + pretty(g.id)).join(", ") || "nothing";
function pinTrip(m, st) {
  const tr = st.trip, VS = BF.villageSim, a = recOf(tr.home), b = recOf(tr.dest);
  if (!VS || !a || !b || !a.wg || !b.wg) return false;
  return VS.pin(tr.id, a.wg, b.wg);
}
function endTrip(m, st, why) {
  const tr = st.trip;
  if (tr && BF.villageSim) BF.villageSim.unpin(tr.id);
  if (tr) log("home", m, { dest: tr.dest, why, sold: tr.soldN, bought: tr.boughtN });
  st.trip = null; st.stage = null; st.errands = null; st.cargo = null; m.ai.route = null;
  st.last = dayNow();
}
function start(m, st) {
  const p = plan(m);
  if (!p) return false;
  const tr = { id: keyOf(m), home: m.village.key, dest: p.rec.key, dx: p.rec.x, dz: p.rec.z, day0: dayNow(), out: p.list.map(g => ({ id: g.id, n: g.n, buy: g.buy, sell: g.sell })), back: [], soldN: 0, soldE: 0, boughtN: 0 };
  if (!tr.id) return false;
  st.trip = tr;
  if (!pinTrip(m, st)) { st.trip = null; st.cd = 30; return false; }   // two trips already on the road: wait
  st.stage = "buy"; st.errands = buyErrands(m.village, m, tr.out, g => g.sell / (1 + MIN_GAIN)); st.ei = 0; st.et = 0;
  st.want = new Map(tr.out.map(g => [g.id, g.n]));
  log("plan", m, { dest: tr.dest, goods: listText(tr.out), profit: +p.profit.toFixed(2) });
  return true;
}
// Works through st.errands: walks to each villager and deals. Returns true when the round is over.
function errands(m, st, dt, out) {
  while (st.ei < st.errands.length) {
    const e = st.errands[st.ei];
    const v2 = e.v;
    const skip = !live(v2) || v2.sleeping || v2.tradingWith || (e.kind === "buy" && !(st.want.get(e.id) > 0)) || (e.kind === "sell" && cnt(m, e.id) < e.o.buy[0].n);
    if (skip) { st.ei++; st.et = 0; continue; }
    st.et += dt;
    if (st.et > DEAL_TIMEOUT) { st.ei++; st.et = 0; m.ai.route = null; continue; }
    const r = travel(m, st, dt, out, v2.position.x, v2.position.z, DEAL_R);
    if (r === "failed") { st.ei++; st.et = 0; continue; }
    if (r !== "arrived") return false;
    out.faceTarget = true;
    if (e.kind === "buy") {
      const n = buyFrom(m, v2, e.o, st.want.get(e.id));
      if (n) { st.want.set(e.id, st.want.get(e.id) - n); log("buy", m, { from: BF.vlog ? BF.vlog.nameOf(v2) : "", got: n + " " + nameOf(e.id), at: st.stage }); }
    } else {
      const n = sellTo(m, v2, e.o, cnt(m, e.id));
      if (n) { st.trip.soldN += n; log("sell", m, { to: BF.vlog ? BF.vlog.nameOf(v2) : "", gave: n + " " + nameOf(e.id), at: st.stage }); }
    }
    st.ei++; st.et = 0;
    return false;
  }
  return true;
}
function vlogLine(m, text) { if (BF.vlog && m.village) BF.vlog.log(m.village, "caravan", who(m) + " " + text, m); }
function destName(key) { const r = recOf(key); return r ? "the village at " + Math.round(r.x) + ", " + Math.round(r.z) : "the village at " + key; }

function tripAI(m, st, dt, out) {
  const tr = st.trip, home = recOf(tr.home) || m.village, dest = recOf(tr.dest);
  if (dayNow() - tr.day0 > TRIP_MAX_DAYS) { endTrip(m, st, "gave up"); return false; }
  if (!dest && (st.stage === "sell" || st.stage === "shop")) st.stage = "back";   // the other village is gone (not simulated any more): home
  if (st.stage === "go" || st.stage === "back") step(m, st);
  switch (st.stage) {
    case "buy": {
      if (!errands(m, st, dt, out)) return true;
      st.cargo = cargoOf(m, tr.out.map(g => g.id)).map(c => Object.assign(c, { cost: (tr.out.find(g => g.id === c.id) || {}).buy || 0 }));
      if (!st.cargo.length) { endTrip(m, st, "nothing to carry"); return false; }
      st.stage = "go";
      vlogLine(m, "set out for " + destName(tr.dest) + " carrying " + listText(st.cargo));
      log("leave", m, { dest: tr.dest, carry: listText(st.cargo) });
      return true;
    }
    case "go": {
      const r = travel(m, st, dt, out, tr.dx, tr.dz, ARRIVE_R);
      if (r === "failed") { log("lost", m, { dest: tr.dest }); st.stage = "back"; return true; }
      if (r !== "arrived") return true;
      if (!dest) { st.stage = "back"; return true; }
      vlogLine(m, "arrived at " + destName(tr.dest) + " with " + listText(st.cargo));
      log("arrive", m, { dest: tr.dest });
      st.stage = "sell"; st.errands = sellErrands(dest, m, st.cargo); st.ei = 0; st.et = 0; st.e0 = cnt(m, em());
      return true;
    }
    case "sell": {
      if (!errands(m, st, dt, out)) return true;
      const sold = st.cargo.map(c => ({ id: c.id, n: c.n - cnt(m, c.id) })).filter(c => c.n > 0), got = cnt(m, em()) - st.e0;
      tr.soldE += got;
      if (sold.length && BF.vlog) BF.vlog.log(dest, "caravan", who(m) + " from " + destName(tr.home) + " sold " + listText(sold) + " here for " + got + " emerald" + (got === 1 ? "" : "s"), m);
      noteTrip(tr.home, tr.dest, sold.reduce((s, c) => s + c.n, 0), got);
      // what home lacks, bought with the takings
      const g = goods(dest, home, m, Math.max(0, got));
      tr.back = g.list.map(x => ({ id: x.id, n: x.n, buy: x.buy, sell: x.sell }));
      st.want = new Map(tr.back.map(x => [x.id, x.n]));
      st.stage = "shop"; st.errands = buyErrands(dest, m, tr.back, x => x.sell / (1 + MIN_GAIN)); st.ei = 0; st.et = 0;
      return true;
    }
    case "shop": {
      if (!errands(m, st, dt, out)) return true;
      const ids = new Set([...tr.out.map(g => g.id), ...tr.back.map(g => g.id)]);
      st.cargo = cargoOf(m, ids).map(c => Object.assign(c, { cost: ((tr.back.find(g => g.id === c.id) || tr.out.find(g => g.id === c.id)) || {}).buy || 0 }));
      tr.boughtN = tr.back.reduce((s, g) => s + Math.max(0, cnt(m, g.id) - 0), 0);
      if (tr.back.length && BF.vlog) BF.vlog.log(dest, "caravan", who(m) + " from " + destName(tr.home) + " bought " + listText(cargoOf(m, tr.back.map(g => g.id))) + " here to take home", m);
      vlogLine(m, "left " + destName(tr.dest) + " for home" + (st.cargo.length ? " carrying " + listText(st.cargo) : ""));
      log("return", m, { dest: tr.dest, carry: listText(st.cargo) });
      st.stage = "back";
      return true;
    }
    case "back": {
      const r = travel(m, st, dt, out, home.x, home.z, ARRIVE_R);
      if (r === "failed") { st.nav.giveUp = (st.nav.giveUp || 0) + 1; if (st.nav.giveUp > 20) { endTrip(m, st, "lost"); return false; } return true; }
      if (r !== "arrived") return true;
      st.stage = "unload"; st.errands = sellErrands(home, m, st.cargo.filter(c => tr.back.some(g => g.id === c.id))); st.ei = 0; st.et = 0; st.e0 = cnt(m, em());
      return true;
    }
    case "unload": {
      if (!errands(m, st, dt, out)) return true;
      const got = cnt(m, em()) - st.e0;
      tr.soldE += got;
      const sold = tr.back.map(g => ({ id: g.id, n: Math.max(0, (st.cargo.find(c => c.id === g.id) || { n: 0 }).n - cnt(m, g.id)) })).filter(c => c.n > 0);
      if (sold.length || tr.back.length) noteTrip(tr.dest, tr.home, sold.reduce((s, c) => s + c.n, 0), got);
      vlogLine(m, "came home from " + destName(tr.dest) + (sold.length ? " and sold " + listText(sold) + " for " + got + " emerald" + (got === 1 ? "" : "s") : ""));
      endTrip(m, st, "done");
      return false;
    }
  }
  st.stage = null;
  return false;
}

// ---------------------------------------------------------------- camping (the explorer's tent rule)
const isNight = t => t > BEDTIME && t < 0.985;
function homeDistance(m) {
  const b = m.homeBed || m.bed, h = b && !b.tent ? { x: b.x, z: b.z } : m.village ? { x: m.village.x, z: m.village.z } : null;
  return h ? Math.hypot(h.x + 0.5 - m.position.x, h.z + 0.5 - m.position.z) : 0;
}
const hasTent = m => BF.I.tent != null && cnt(m, BF.I.tent) >= 1;
function campAI(m, st, t) {
  const camp = m.ex && m.ex.camp;
  if (camp) {
    if (!isNight(t) && !m.sleeping && t < DUSK) { BF.explorer.strike(m); return false; }
    if (!isNight(t) && t >= DUSK) { m.ai.mode = "idle"; m.ai.t = 2; return true; }   // evening: waits at its tent
    return false;
  }
  if (t < DUSK || t >= BEDTIME || !st.trip || homeDistance(m) <= HOME_R || m.sleeping || !hasTent(m) || !BF.explorer) return false;
  if (BF.explorer.pitch(m)) { log("camp", m, { at: Math.round(m.position.x) + "," + Math.round(m.position.z) }); return true; }
  return false;
}
// Without a tent it only sets out when the walk there and back fits in what is left of the day.
function fitsInDay(m, d) {
  if (hasTent(m)) return true;
  const left = (DUSK - skyT()) * DAY_S, speed = (m.def && m.def.speed) || 0.5;
  return left > 0 && (2 * d) / (speed * 1.3) + 60 < left;
}

// ---------------------------------------------------------------- villager AI step (mobs.js villagerAI)
function ai(m, dt, out) {
  if (m.profession !== PROF || !m.inv || m.dead || m.child || !m.village || !BF.mobs || !BF.mobs.nav) return false;
  const st = state(m), t = skyT();
  if (campAI(m, st, t)) return true;
  if (t < WORK_START || t >= DUSK || m.tradingWith) { if (st.trip && st.stage !== "go" && st.stage !== "back") m.ai.route = null; return false; }
  if (st.trip) return tripAI(m, st, dt, out);
  st.cd -= dt;
  if (st.cd > 0) return false;
  st.cd = 20 + Math.random() * 10;
  if (dayNow() - st.last < TRIP_EVERY || (m.ex && m.ex.camp)) return false;
  const p = plan(m);
  if (!p || !fitsInDay(m, p.d)) return false;
  if (!start(m, st)) return false;
  return tripAI(m, st, dt, out);
}

// Its reserve while a trip is on (js/market.js): the goods it carries for the trip, and its tent.
function reserve(m) {
  const out = {};
  if (BF.I.tent != null) out[BF.I.tent] = 1;
  const st = m && m.mc;
  if (st && st.trip) for (const g of st.trip.out.concat(st.trip.back)) out[g.id] = Math.max(out[g.id] || 0, cnt(m, g.id));
  return out;
}

const STATUS = { buy: "Buying goods for a trip", go: "Carrying goods to another village", sell: "Selling goods in another village", shop: "Buying goods to take home", back: "Walking home with goods", unload: "Selling goods brought home" };
function statusText(m) {
  if (!m || m.profession !== PROF) return "";
  const st = m.mc;
  if (m.ex && m.ex.camp) return "Camping on the road";
  if (st && st.trip && STATUS[st.stage]) return STATUS[st.stage];
  return "";
}

// ---------------------------------------------------------------- the world side
// Drops a dead merchant's goods where it fell and ends its trip.
function onKilled(m) {
  if (!m || m.type !== "villager" || m.profession !== PROF) return;
  const st = m.mc;
  if (st && st.trip) {
    if (BF.drops && Array.isArray(m.inv)) for (let i = 0; i < m.inv.length; i++) { const s = m.inv[i]; if (s) { BF.drops.spawn(s.id, s.count, m.position.x, m.position.y + 0.5, m.position.z); m.inv[i] = null; } }
    log("died", m, { dest: st.trip.dest });
    if (BF.villageSim) BF.villageSim.unpin(st.trip.id);
    st.trip = null; st.stage = null;
  }
}
// Pins whose merchant is gone (no living merchant with that key for a game day) are dropped.
let tickT = 0;
const lastSeen = new Map();
function tick(dt) {
  tickT -= dt;
  if (tickT > 0 || !BF.villageSim) return;
  tickT = 5;
  const now = dayNow(), ids = new Set();
  for (const m of BF.mobs.list) if (m.type === "villager" && m.profession === PROF && !m.dead && !m.removed && m.mc && m.mc.trip) ids.add(m.mc.trip.id);
  for (const id of [...BF.villageSim.pins().keys()]) {
    if (ids.has(id)) { lastSeen.set(id, now); continue; }
    if (!lastSeen.has(id)) lastSeen.set(id, now);
    if (now - lastSeen.get(id) > 1) { BF.villageSim.unpin(id); lastSeen.delete(id); }
  }
}

// ---------------------------------------------------------------- persistence
function pack(m) {
  const st = m.mc;
  if (!st) return undefined;
  const o = { last: +st.last.toFixed(3), camp: m.ex && m.ex.camp ? m.ex.camp : undefined };   // its tent on the road (struck next morning)
  if (st.trip) o.trip = { id: st.trip.id, home: st.trip.home, dest: st.trip.dest, dx: Math.round(st.trip.dx), dz: Math.round(st.trip.dz), day0: +st.trip.day0.toFixed(3), stage: st.stage, out: st.trip.out, back: st.trip.back, soldN: st.trip.soldN, soldE: st.trip.soldE, cargo: st.cargo || null, want: st.want ? [...st.want] : null };
  return o;
}
function unpack(m, o) {
  if (!o || typeof o !== "object") return;
  const st = state(m);
  if (Number.isFinite(+o.last)) st.last = +o.last;
  if (o.camp && BF.explorer && Number.isFinite(+o.camp.x) && Number.isFinite(+o.camp.f)) BF.explorer.unpack(m, { camp: o.camp });
  const tr = o.trip;
  if (tr && typeof tr.home === "string" && typeof tr.dest === "string" && Array.isArray(tr.out) && Array.isArray(tr.back)) {
    const ok = g => g && BF.items[g.id] && Number.isFinite(+g.n);
    const [kx, kz] = tr.dest.split(",").map(Number);
    st.trip = { id: tr.id, home: tr.home, dest: tr.dest, dx: Number.isFinite(+tr.dx) ? +tr.dx : kx, dz: Number.isFinite(+tr.dz) ? +tr.dz : kz, day0: +tr.day0 || dayNow(), out: tr.out.filter(ok), back: tr.back.filter(ok), soldN: +tr.soldN || 0, soldE: +tr.soldE || 0, boughtN: 0 };
    st.stage = ["buy", "go", "sell", "shop", "back", "unload"].includes(tr.stage) ? tr.stage : "back";
    st.cargo = Array.isArray(tr.cargo) ? tr.cargo.filter(ok) : [];
    st.want = new Map(Array.isArray(tr.want) ? tr.want : []);
    // an errand round restarts from what is on hand: buying rounds are cut short, selling rounds look again
    if (st.stage === "buy") st.stage = "go";
    if (st.stage === "shop") st.stage = "back";
    if (st.stage === "sell") { st.stage = "go"; }
    if (st.stage === "unload") st.stage = "back";
    st.errands = null;
  }
}
function exportAll(out) {
  const r = {};
  for (const [k, v] of routes) r[k] = { t: v.trips, n: v.total };
  const w = [];
  for (const [k, n] of wear) if (n >= 2) w.push(k + "," + n);
  out["caravans"] = { routes: r, wear: w };
}
function importAll(o) {
  routes.clear(); wear.clear();
  const c = o && o.caravans;
  if (!c || typeof c !== "object") return;
  for (const k in c.routes || {}) {
    const v = c.routes[k], [a, b] = k.split("|");
    if (a && b && v && Array.isArray(v.t)) routes.set(k, { a, b, trips: v.t.filter(t => Array.isArray(t) && t.length === 3), total: +v.n || v.t.length });
  }
  for (const s of Array.isArray(c.wear) ? c.wear : []) { const p = String(s).split(",").map(Number); if (p.length === 4 && p.every(Number.isFinite)) wear.set(p.slice(0, 3).join(","), p[3]); }
}
function reset() { routes.clear(); wear.clear(); lastSeen.clear(); LOG.length = 0; }

let hooked = false;
function hook() { if (!hooked && BF.on) { hooked = true; BF.on("mobKilled", onKilled); } }
setTimeout(hook, 0);

BF.merchant = { PROF, RANGE, CARGO_STACKS, TRIP_EVERY, WEAR_N, MIN_GAIN, mayHire, ai, plan, goods, book, statusText, reserve, pack, unpack, routes: routesView, tick, exportAll, importAll, reset, wear, step, LOG, _state: state, hook };
})();
