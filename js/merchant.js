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
// - Clusters (spec r15-39b, js/ctick.js; only with the cluster tick on): a merchant walking or dealing away (stages go, sell, shop, back)
//   belongs to the cluster of the ground it stands on (roaming, js/clusters.js baseOf), so it is handed over to the other village's cluster
//   at the meeting after it gets there and trades there locally; it waits at the edge of a village until it belongs to that village's
//   cluster, and goes back to its home's at the meeting after it comes home. Its plans read the other village from the shared table
//   (js/sharedtable.js: prices as of the last meeting), never the other village's live villagers. What it changes outside its cluster waits for
//   the meeting and goes on the merchant itself until then (meet, a "start" hook via js/villagesim.js): the pin of a new trip is asked for
//   (stage "pin": granted in merchant id order, at most MAX_PINS on the road), pins whose trip is over are dropped, the routes' trips, roads
//   given up and path wear are written down, and the path blocks are requested; its home village's log lines written while away wait on
//   it until it is home. Game log: INFO "merchant" when a pin is asked, granted or refused at a meeting.
// API: BF.merchant = { away(m), remember, forceHome, PROF, RANGE, MAX_PLAN_DAYS, TRIP_MAX_DAYS, tripDays, candidates, summarize, bookOf, market, noRoad, roadKey, mayHire, ai, plan, statusText, reserve, pack, unpack, routes, tick, exportAll, importAll, reset, wear, LOG }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const RS = e => BF.rand.of(e);   // seeded random streams (js/rand.js)

const PROF = "merchant";
const RANGE = 600;              // blocks from home village centre to the other village's centre (a trip must also fit in MAX_PLAN_DAYS)
const CARGO_STACKS = 2;         // stacks it carries each way
const TRIP_EVERY = 2;           // game days between setting out (a few trips a week)
const MIN_GAIN = 0.05;          // the buy price there must beat the price here by this much
const WALK_COST = 1 / 400;      // emeralds a block of road is worth to it (for choosing between villages)
const MIN_PROFIT = 0.5;         // emeralds a trip must be expected to make (half an emerald: bulk goods carry thin margins)
const WEAR_N = 20;              // crossings that turn grass or dirt into a dirt path
const WEAR_MAX = 6000;          // wear counts kept (oldest dropped)
const WORK_START = 0.03, DUSK = 0.45, BEDTIME = 0.5, DAY_S = 1200;
const HOME_R = 48;              // this close to its bed (or village centre) it is home and never camps
const ARRIVE_R = 6, DEAL_R = 2.6, DEAL_TIMEOUT = 60, TRIP_MAX_DAYS = 3;
const BOOST = 1.5, ROAD = 1.3, WIND = 1.3;   // merchants and explorers walk 1.5x a villager (js/mobs.js); on the road at 1.3x; roads wind: 1.3x the straight line
const MAX_PLAN_DAYS = 2;        // a trip is only planned when it should be over in this many game days (walk time plus the dealing)
const DEAL_DAYS = 0.1;          // a day's tenth for buying and selling at both ends
const LOG = [];
const market = new Map();       // village key -> last-known prices {t, sells: {id: [[unit, step, spare]]}, buys: {id: [[unit, step, items it pays for]]}}
const noRoad = new Map();       // "a|b" (sorted) -> game day until which a trip between them is not planned (a trip lost on the way)
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
const log = (kind, m, data) => { LOG.push(BF.glog.job("merchant", Object.assign({ kind, who: keyOf(m), t: +dayNow().toFixed(3) }, data))); if (LOG.length > 300) LOG.shift(); };
// The planet (spec r14-16): a merchant is kept in its home village's frame even past a face edge (js/mobs.js frames), village records and the
// trip's destination are canonical. Every point it steers for is first seen from where it stands (BF.planet.local), the road line lies in
// its lower-keyed village's frame, distances between places are BF.planet.distance, and path wear is keyed by canonical cells. RANGE (600)
// is within BF.planet.LOCAL, so a destination on another face is always reached through one edge's unfold.
const PL = () => BF.planet;
const pdist = (a, b) => PL().distance(a, b);
const LQ = {};
const seenFrom = (a, x, z) => { LQ.x = x; LQ.z = z; return PL().local(a, LQ, LQ); };
const state = m => m.mc || (m.mc = { stage: null, trip: null, last: -1e9, cd: 3 + RS(m).next() * 5, nav: {} });
// Clusters (spec r15-39b): the cluster tick is on; a cluster's pass is running (what the merchant changes outside its cluster then waits
// for the meeting, on the merchant: note); the merchant belongs to village key's cluster now (as of the last meeting); it is roaming
// (walking or dealing away: its cluster is the ground's, js/clusters.js baseOf).
const clustered = () => !!(BF.ctick && BF.ctick.on);
const inPass = () => clustered() && !!BF.ctick.cur;
const note = (m, e) => { const st = state(m); (st.notes || (st.notes = [])).push(e); };
const ROAM = new Set(["go", "sell", "shop", "back"]);
const roaming = m => !!(m && m.mc && m.mc.trip && ROAM.has(m.mc.stage));
function inCluster(m, key) {
  if (!clustered()) return true;
  const C = BF.clusters;
  return m.cl !== undefined && C.groupOf(m.cl) === C.groupOf("v:" + key);
}
// Home's prices as the other village's cluster may read them: the shared table's row (the last meeting's), else the last-known prices.
function homeSummary(home) {
  const row = BF.sharedTable && BF.sharedTable.row(home.key), sum = row && row.sum ? row.sum : market.get(home.key);
  return { key: home.key, x: home.x, z: home.z, sum: sum || { sells: {}, buys: {} } };
}

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
  const A = book(from, m), B = to.sum ? bookOf(to.sum) : book(to, m), out = [];
  for (const [id, ss] of A.sells) {
    const bs = B.buys.get(id);
    if (!bs || !bs.length) continue;
    const lo = ss[0], hi = bs[0];
    if (!(hi.u > lo.u * (1 + MIN_GAIN))) continue;
    if (!(ss.some(x => x.s < 0) || bs.some(x => x.s > 0))) continue;   // surplus here or lack there: otherwise base prices already balance
    // bug-066: never carry what the buyers there can already get as cheaply from a seller of their own with stock to spare (a forester's
    // sticks at home at 49 an emerald beat sticks bought at 48 elsewhere, whatever the toolsmith's buy offer says)
    const there = (B.sells.get(id) || []).find(x => (x.spare != null ? x.spare : x.v && BF.market ? BF.market.spareOf(x.v, id) : 0) >= (x.o ? x.o.sell.n : 1));
    if (there && there.u <= lo.u * (1 + MIN_GAIN)) continue;
    // supply: what the sellers can spare; demand: what the buyers can pay for
    let supply = 0, demand = 0;
    for (const x of ss) if (x.u < hi.u) supply += x.spare != null ? x.spare : BF.market ? BF.market.spareOf(x.v, id) : cnt(x.v, id);
    for (const x of bs) if (x.u > lo.u) demand += x.items != null ? x.items : Math.floor(cnt(x.v, em()) / x.o.sell.n) * x.o.buy[0].n;
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
// The last-known prices of a village (what a merchant plans a trip from while it is not loaded). Taken from the live offers.
function summarize(rec) {
  const B = book(rec, null), sells = {}, buys = {}, e = em();
  for (const [id, a] of B.sells) sells[id] = a.slice(0, 3).map(x => [+x.u.toFixed(4), x.s, BF.market ? BF.market.spareOf(x.v, id) : cnt(x.v, id)]);
  for (const [id, a] of B.buys) buys[id] = a.slice(0, 3).map(x => [+x.u.toFixed(4), x.s, Math.floor(cnt(x.v, e) / x.o.sell.n) * x.o.buy[0].n]);
  return { t: +dayNow().toFixed(3), sells, buys };
}
// A summary read as a book (the same shape as book()).
function bookOf(sum) {
  const sells = new Map(), buys = new Map();
  for (const id in sum.sells) sells.set(+id, sum.sells[id].map(a => ({ u: a[0], s: a[1], spare: a[2] })));
  for (const id in sum.buys) buys.set(+id, sum.buys[id].map(a => ({ u: a[0], s: a[1], items: a[2] })));
  return { sells, buys };
}
const roadKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
// A road given up (lost, or a trip over TRIP_MAX_DAYS): no trip on it until `until` (clusters: written down at the meeting)
function giveUpRoad(m, a, b, until) { if (inPass()) note(m, ["noroad", roadKey(a, b), until]); else noRoad.set(roadKey(a, b), until); }
const blocked = (a, b) => (noRoad.get(roadKey(a, b)) || 0) > dayNow();
// Game days a trip over straight-line distance d should take: walking days (the tent between) plus the dealing.
function tripDays(m, d) {
  const speed = ((m.def && m.def.speed) || 0.9) * ROAD * BOOST, walkSecs = (DUSK - WORK_START) * DAY_S;
  return (2 * d * WIND) / (speed * walkSecs) + DEAL_DAYS;
}
// Villages the merchant could go to: within RANGE of home, a trip that fits in MAX_PLAN_DAYS, and either loaded now (live prices) or
// seen before (last-known prices).
function candidates(m) {
  const home = m.village, out = [], seenK = new Set();
  if (!home || !BF.mobs.villages) return out;
  if (clustered()) return candidatesShared(m, home);
  for (const rec of BF.mobs.villages.values()) {
    if (rec === home || !rec.wg || !(BF.villageSim && BF.villageSim.isActive(rec.key))) continue;
    if (!BF.world.isLoaded(rec.x, rec.z) || !traders(rec, m).length) continue;
    seenK.add(rec.key);
    const d = pdist(home, rec);
    if (d <= RANGE && tripDays(m, d) <= MAX_PLAN_DAYS && !blocked(home.key, rec.key)) out.push({ rec, d });
  }
  let near = [];
  try { near = BF.worldgen.villagesNear(home.x, home.z, RANGE) || []; } catch (e) { near = []; }
  for (const v of near) {
    if (!v || v.x == null) continue;
    const key = vKey(v), sum = market.get(key);
    if (key === home.key || seenK.has(key) || !sum || blocked(home.key, key)) continue;
    const d = pdist(home, v);
    if (d <= RANGE && tripDays(m, d) <= MAX_PLAN_DAYS) out.push({ rec: { key, x: v.x, z: v.z, wg: v, sum }, d });
  }
  return out.sort((a, b) => a.d - b.d);
}
// With the cluster tick on: every village within RANGE read from the shared table (as of the last meeting, js/sharedtable.js), or its
// last-known prices when it isn't simulated; never another village's live records.
function candidatesShared(m, home) {
  const out = [];
  let near = [];
  try { near = BF.worldgen.villagesNear(home.x, home.z, RANGE) || []; } catch (e) { near = []; }
  for (const v of near) {
    if (!v || v.x == null) continue;
    const key = vKey(v), row = BF.sharedTable && BF.sharedTable.row(key), sum = row && row.trade ? row.sum : market.get(key);
    if (key === home.key || !sum || blocked(home.key, key)) continue;
    const d = pdist(home, v);
    if (d <= RANGE && tripDays(m, d) <= MAX_PLAN_DAYS) out.push({ rec: { key, x: v.x, z: v.z, wg: v, sum, tick: row ? row.tick : null }, d });
  }
  return out.sort((a, b) => a.d - b.d || (a.rec.key < b.rec.key ? -1 : 1));
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
  const lots = Math.floor(want / o.sell.n) || (want > 0 && o.sell.n <= stackOf(o.sell.id) ? 1 : 0);   // whole lots up to what it wants (at least one)
  const done = Tr.asked(m, v2, o) || lots > 0 ? Tr.buy(m, v2, o, lots) : 0;   // its stock above its reserve, its room: one transaction (js/trading.js buy)
  return done == null ? null : done * o.sell.n;
}
// Sells into buyer v2's buy offer o (it pays emeralds for the items), as long as the merchant has the items. Returns items sold.
function sellTo(m, v2, o, max) {
  const Tr = T(), id = o.buy[0].id;
  const lots = Math.floor(max / o.buy[0].n);
  const done = Tr.asked(m, v2, o) || lots > 0 ? Tr.buy(m, v2, o, lots) : 0;   // its emeralds, its room: one transaction (js/trading.js buy)
  return done == null ? null : done * o.buy[0].n;
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
// The next waypoint on a road between two village centres: fixed every HOP blocks from the lower-keyed village, so every trip on the road (either way)
// steps through the same points and wears the same ground. null when the goal is near or off the line.
const HOP = 20;
function waypoint(px, pz, tx, tz, line) {
  const dx = line.bx - line.ax, dz = line.bz - line.az, L = Math.hypot(dx, dz);
  if (L < 3 * HOP) return null;
  const s = ((px - line.ax) * dx + (pz - line.az) * dz) / L;                      // how far along the line the merchant is
  if (Math.abs((px - line.ax) * dz - (pz - line.az) * dx) / L > 3 * HOP) return null;   // well off the line (a detour): plain hops
  const fwd = (tx - px) * dx + (tz - pz) * dz > 0;
  let t = fwd ? (Math.floor(s / HOP + 1e-6) + 1) * HOP : (Math.ceil(s / HOP - 1e-6) - 1) * HOP;
  if (Math.hypot(line.ax + dx / L * t - px, line.az + dz / L * t - pz) < 5) t += fwd ? HOP : -HOP;   // already at that point (a path of no steps would count as a failure): the next one
  t = Math.max(0, Math.min(L, t));
  return [Math.floor(line.ax + dx / L * t), Math.floor(line.az + dz / L * t)];
}
// waypoint() worked in the road line's frame (its lower-keyed village's face) and handed back in the merchant's frame.
function waypointFrom(m, px, pz, tx, tz, line) {
  const A = { x: line.ax, z: line.az };
  let q = seenFrom(A, px, pz); const qx = q.x, qz = q.z;
  q = seenFrom(A, tx, tz);
  const wp = waypoint(qx, qz, q.x, q.z, line);
  if (!wp) return null;
  q = seenFrom(m.position, wp[0] + 0.5, wp[1] + 0.5);
  return [Math.floor(q.x), Math.floor(q.z)];
}
function travel(m, st, dt, out, tx, tz, radius, line) {
  const tl = seenFrom(m.position, tx, tz); tx = tl.x; tz = tl.z;   // (the planet: the goal seen from where the merchant stands)
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z, d = Math.hypot(tx - px, tz - pz), nv = st.nav;
  if (d <= radius) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "mc") {
    ai.route = null;
    if (nv.wait > 0) { nv.wait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const wp = d > 22 && line && !nv.fail ? waypointFrom(m, px, pz, tx, tz, line) : null;   // a failed attempt falls back to plain hops
    const hop = wp || (d > 22 ? [Math.floor(px + (tx - px) * 20 / d), Math.floor(pz + (tz - pz) * 20 / d)] : [Math.floor(tx), Math.floor(tz)]);
    const goal = { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "mc"; nv.fail = 0; }
    else { nv.fail = (nv.fail || 0) + 1; nv.wait = 0.6; if (nv.fail >= 6) { nv.fail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, ROAD);
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
    else if (pdist(rec, { x, z }) < 40) return true;
  }
  return false;
}
const WC = {};
function step(m, st) {
  let x = Math.floor(m.position.x), z = Math.floor(m.position.z);
  const y = Math.floor(m.position.y + 0.01) - 1;
  { const c = PL().canonCell(x, z, WC); if (!c.off) { x = c.x; z = c.z; } }   // (wear is keyed by the canonical cell)
  const k = x + "," + y + "," + z;
  if (st.cell === k) return;
  st.cell = k;
  if (!m.onGround) return;
  if (inPass()) { (st.walk || (st.walk = [])).push(x, y, z); return; }   // (clusters: counted at the meeting, wearCell)
  wearCell(m, st, x, y, z, k);
}
// One step on the canonical ground cell x, y, z: counted, and a dirt path requested at WEAR_N.
function wearCell(m, st, x, y, z, k) {
  if (!BF.world.isLoaded(x, z) || inVillage(x, z)) return;
  const W = BF.world, id = W.getBlock(x, y, z);
  if (!wearable(id) || W.getBlock(x, y + 1, z) !== 0) return;
  const n = (wear.get(k) || 0) + 1;
  wear.delete(k);
  if (n < WEAR_N) { wear.set(k, n); if (wear.size > WEAR_MAX) wear.delete(wear.keys().next().value); return; }
  if (BF.B.dirt_path == null) return;
  const req = BF.blockReq.cells(m, [{ x, y, z, id: BF.B.dirt_path, expect: id }]);   // a request (spec r15-19)
  if (clustered()) st.worn = (st.worn || 0) + 1;   // (clusters: sent at the meeting, to the cell's cluster: counted as asked, no callback)
  else req.then(r => { if (r.ok) st.worn = (st.worn || 0) + 1; });
}

// ---------------------------------------------------------------- routes
const routes = new Map();        // "a|b" (sorted keys) -> {a, b, trips: [[day, items, emeralds]], total}
const routeKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
function noteTrip(home, dest, items, ems, m) {
  if (m && inPass()) { note(m, ["trip", home, dest, items, ems, +dayNow().toFixed(3)]); return; }
  addTrip(home, dest, items, ems, dayNow());
}
function addTrip(home, dest, items, ems, day) {
  const k = routeKey(home, dest);
  let r = routes.get(k);
  if (!r) routes.set(k, r = { a: k.split("|")[0], b: k.split("|")[1], trips: [], total: 0 });
  r.trips.push([+(+day).toFixed(3), items, ems]);
  r.total++;
  const cut = day - 7;
  r.trips = r.trips.filter(t => t[0] >= cut);
}
function routesView() {
  const cut = dayNow() - 7, onRoad = new Map();
  for (const m of BF.regions.ofType("villager")) if (m.profession === PROF && !m.dead && m.mc && m.mc.trip) {
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

// Seconds of game time the merchant's trip still needs (for its village's unload countdown, js/villagesim.js).
function leftSecs(m) {
  const st = m.mc, tr = st && st.trip;
  if (!tr) return 0;
  const speed = ((m.def && m.def.speed) || 0.9) * ROAD * BOOST, walkSecs = (DUSK - WORK_START) * DAY_S;
  const D = { x: tr.dx, z: tr.dz }, toDest = pdist(m.position, D), a = recOf(tr.home) || m.village;
  const homeD = a ? pdist(m.position, a) : 0, legD = a ? pdist(a, D) : toDest;
  const dist = st.stage === "buy" ? 2 * legD : st.stage === "go" ? toDest + legD : st.stage === "sell" || st.stage === "shop" ? legD : homeD;
  return (dist * WIND / (speed * walkSecs) + (st.stage === "unload" ? 0.02 : DEAL_DAYS)) * DAY_S;
}
// ---------------------------------------------------------------- the trip
const recOf = key => (BF.mobs.villages && BF.mobs.villages.get(key)) || null;
function cargoOf(m, ids) { const out = []; for (const id of ids) { const n = cnt(m, id); if (n > 0) out.push({ id, n }); } return out; }
const listText = l => l.map(g => g.n + " " + pretty(g.id)).join(", ") || "nothing";
function pinTrip(m, st) {
  const tr = st.trip, VS = BF.villageSim, a = recOf(tr.home), b = recOf(tr.dest);
  const bw = (b && b.wg) || st.destWg;   // an unloaded destination is loaded by the pin itself
  if (!VS || !a || !bw || !a.wg) return false;
  return VS.pin(tr.id, a.wg, bw);
}
function endTrip(m, st, why) {
  const tr = st.trip;
  if (tr && BF.villageSim && !inPass()) BF.villageSim.unpin(tr.id);   // (clusters: at the meeting, meet)
  if (tr) log("home", m, { dest: tr.dest, why, sold: tr.soldN, bought: tr.boughtN });
  st.trip = null; st.stage = null; st.errands = null; st.cargo = null; m.ai.route = null;
  st.last = dayNow();
}
// A forced stop (js/villagesim.js): the merchant goes home with what it carries and the trip ends. True when it was on a trip.
function forceHome(m, why) {
  const st = state(m);
  if (!st.trip) return false;
  endTrip(m, st, "forced stop: " + why);
  if (BF.mobs.sendHome) BF.mobs.sendHome(m);
  return true;
}
function start(m, st) {
  const p = plan(m);
  if (!p) return false;
  const tr = { id: keyOf(m), home: m.village.key, dest: p.rec.key, dx: p.rec.x, dz: p.rec.z, day0: dayNow(), out: p.list.map(g => ({ id: g.id, n: g.n, buy: g.buy, sell: g.sell })), back: [], soldN: 0, soldE: 0, boughtN: 0 };
  if (!tr.id) return false;
  st.trip = tr;
  st.destWg = p.rec.wg;
  if (clustered()) {   // the pin is asked for at the next meeting (meet): the trip waits for it in stage "pin"
    tr.pin = "ask"; st.stage = "pin";
    log("plan", m, { dest: tr.dest, goods: listText(tr.out), profit: +p.profit.toFixed(2), table: p.rec.tick != null ? p.rec.tick : undefined });
    return true;
  }
  if (!pinTrip(m, st)) { st.trip = null; st.cd = 30; return false; }   // two trips already on the road: wait
  log("plan", m, { dest: tr.dest, goods: listText(tr.out), profit: +p.profit.toFixed(2) });
  setOut(m, st);
  return true;
}
// The trip has its pin: the buying round at home.
function setOut(m, st) {
  const tr = st.trip;
  st.stage = "buy"; st.errands = buyErrands(m.village, m, tr.out, g => g.sell / (1 + MIN_GAIN)); st.ei = 0; st.et = 0;
  st.want = new Map(tr.out.map(g => [g.id, g.n]));
}
// Works through st.errands: walks to each villager and deals. Returns true when the round is over.
function errands(m, st, dt, out) {
  while (st.ei < st.errands.length) {
    const e = st.errands[st.ei];
    const v2 = e.v;
    const asked = T().asked(m, v2, e.o);   // its answer is in (js/trading.js buy): collect it whatever changed since
    const skip = !asked && (!live(v2) || v2.sleeping || v2.tradingWith || (e.kind === "buy" && !(st.want.get(e.id) > 0)) || (e.kind === "sell" && cnt(m, e.id) < e.o.buy[0].n));
    if (skip) { st.ei++; st.et = 0; continue; }
    if (!asked) {
      st.et += dt;
      if (st.et > DEAL_TIMEOUT) { st.ei++; st.et = 0; m.ai.route = null; continue; }
      const r = travel(m, st, dt, out, v2.position.x, v2.position.z, DEAL_R);
      if (r === "failed") { st.ei++; st.et = 0; continue; }
      if (r !== "arrived") return false;
    }
    out.faceTarget = true;
    if (e.kind === "buy") {
      const n = buyFrom(m, v2, e.o, st.want.get(e.id));
      if (n == null) return false;   // the trade is in flight (js/trading.js buy)
      if (n) { st.want.set(e.id, st.want.get(e.id) - n); log("buy", m, { from: BF.vlog ? BF.vlog.nameOf(v2) : "", got: n + " " + nameOf(e.id), at: st.stage }); }
    } else {
      const n = sellTo(m, v2, e.o, cnt(m, e.id));
      if (n == null) return false;   // the trade is in flight (js/trading.js buy)
      if (n) { st.trip.soldN += n; log("sell", m, { to: BF.vlog ? BF.vlog.nameOf(v2) : "", gave: n + " " + nameOf(e.id), at: st.stage }); }
    }
    st.ei++; st.et = 0;
    return false;
  }
  return true;
}
function vlogLine(m, text) {
  if (!BF.vlog || !m.village) return;
  if (inPass() && !inCluster(m, m.village.key)) { note(m, ["vlog", who(m) + " " + text]); return; }   // (clusters: home's log is written when it is home)
  BF.vlog.log(m.village, "caravan", who(m) + " " + text, m);
}
// Home's log lines written while it was away (clusters), now that it is in home's cluster again.
function flushLog(m, st) {
  if (!st.notes || !st.notes.some(e => e[0] === "vlog") || !inCluster(m, m.village.key)) return;
  for (const e of st.notes) if (e[0] === "vlog" && BF.vlog) BF.vlog.log(m.village, "caravan", e[1], m);
  st.notes = st.notes.filter(e => e[0] !== "vlog");
  if (!st.notes.length) st.notes = null;
}
function destName(key) { const r = recOf(key); return r ? "the village at " + Math.round(r.x) + ", " + Math.round(r.z) : "the village at " + key; }

// The road of a trip as a line from the lower-keyed village to the other, so both ways use the same waypoints.
// (The planet: the far end is seen from the lower-keyed village, so the line lies in that village's frame.)
function roadLine(tr, home) {
  const a = { x: home.x, z: home.z }, b = { x: tr.dx, z: tr.dz }, lo = tr.home < tr.dest ? a : b, hi = lo === a ? b : a, h = seenFrom(lo, hi.x, hi.z);
  return { ax: lo.x, az: lo.z, bx: h.x, bz: h.z };
}
function tripAI(m, st, dt, out) {
  const tr = st.trip, home = recOf(tr.home) || m.village, dest = recOf(tr.dest);
  if (dayNow() - tr.day0 > TRIP_MAX_DAYS) { giveUpRoad(m, tr.home, tr.dest, dayNow() + 7); log("error", m, { why: "trip over " + TRIP_MAX_DAYS + " days", dest: tr.dest }); endTrip(m, st, "gave up"); return false; }
  if (!dest && (st.stage === "sell" || st.stage === "shop")) st.stage = "back";   // the other village is gone (not simulated any more): home
  if (st.stage === "go" || st.stage === "back") step(m, st);
  switch (st.stage) {
    case "pin": {   // (clusters) waiting for the meeting to grant the trip's pin
      if (tr.pin === "ok") { tr.pin = undefined; setOut(m, st); return tripAI(m, st, dt, out); }
      if (tr.pin === "no") { st.trip = null; st.stage = null; st.cd = 30; return false; }   // two trips already on the road: wait
      return false;
    }
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
      const r = travel(m, st, dt, out, tr.dx, tr.dz, ARRIVE_R, roadLine(tr, home));
      if (r === "failed") { log("lost", m, { dest: tr.dest }); giveUpRoad(m, tr.home, tr.dest, dayNow() + 7); st.stage = "back"; return true; }
      if (r !== "arrived") return true;
      if (dest && !inCluster(m, tr.dest)) return true;   // (clusters: handed over to the village's cluster at the next meeting)
      if (!dest || !traders(dest, m).length) { st.aw = (st.aw || 0) + dt; if (st.aw < 30) return true; st.aw = 0; if (!dest) { st.stage = "back"; return true; } }   // its villagers are still appearing
      st.aw = 0;
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
      noteTrip(tr.home, tr.dest, sold.reduce((s, c) => s + c.n, 0), got, m);
      // what home lacks, bought with the takings
      const g = goods(dest, clustered() ? homeSummary(home) : home, m, Math.max(0, got));
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
      const r = travel(m, st, dt, out, home.x, home.z, ARRIVE_R, roadLine(tr, home));
      if (r === "failed") { st.nav.giveUp = (st.nav.giveUp || 0) + 1; if (st.nav.giveUp > 20) { endTrip(m, st, "lost"); return false; } return true; }
      if (r !== "arrived") return true;
      if (!inCluster(m, tr.home)) return true;   // (clusters: back in home's cluster at the next meeting)
      st.stage = "unload"; st.errands = sellErrands(home, m, st.cargo.filter(c => tr.back.some(g => g.id === c.id))); st.ei = 0; st.et = 0; st.e0 = cnt(m, em());
      return true;
    }
    case "unload": {
      if (!errands(m, st, dt, out)) return true;
      const got = cnt(m, em()) - st.e0;
      tr.soldE += got;
      const sold = tr.back.map(g => ({ id: g.id, n: Math.max(0, (st.cargo.find(c => c.id === g.id) || { n: 0 }).n - cnt(m, g.id)) })).filter(c => c.n > 0);
      if (sold.length || tr.back.length) noteTrip(tr.dest, tr.home, sold.reduce((s, c) => s + c.n, 0), got, m);
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
  return h ? pdist(m.position, { x: h.x + 0.5, z: h.z + 0.5 }) : 0;
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
  return left > 0 && (2 * d * WIND) / (speed * ROAD * BOOST) + 60 < left;
}

// ---------------------------------------------------------------- villager AI step (mobs.js villagerAI)
function ai(m, dt, out) {
  if (m.profession !== PROF || !m.inv || m.dead || m.child || !m.village || !BF.mobs || !BF.mobs.nav) return false;
  const st = state(m), t = skyT();
  if (campAI(m, st, t)) return true;
  if (t < WORK_START || t >= DUSK || m.tradingWith) { if (st.trip && st.stage !== "go" && st.stage !== "back") m.ai.route = null; return false; }
  if (st.notes) flushLog(m, st);
  if (st.trip) return tripAI(m, st, dt, out);
  st.cd -= dt;
  if (st.cd > 0) return false;
  st.cd = 20 + RS(m).next() * 10;
  if (dayNow() - st.last < TRIP_EVERY || (m.ex && m.ex.camp)) return false;
  const p = plan(m);
  if (!p || !fitsInDay(m, p.d)) return false;
  if (BF.villageSim && BF.villageSim.mayStart && !BF.villageSim.mayStart(m.village.key, tripDays(m, p.d) * DAY_S)) return false;   // its village is counting down to unload and the trip would outlast it
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

const STATUS = { pin: "Getting ready for a trip", buy: "Buying goods for a trip", go: "Carrying goods to another village", sell: "Selling goods in another village", shop: "Buying goods to take home", back: "Walking home with goods", unload: "Selling goods brought home" };
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
    if (BF.villageSim && !inPass()) BF.villageSim.unpin(st.trip.id);   // (clusters: at the meeting, meet)
    st.trip = null; st.stage = null;
  }
}
// Pins whose merchant is gone (no living merchant with that key for a game day) are dropped.
// Writes down what a loaded village buys and sells (its last-known prices, for merchants choosing a far destination); also done as it unloads.
function remember(rec, going) {
  if (typeof rec === "string") rec = BF.mobs.villages.get(rec);
  if (rec && rec.wg && (going || BF.villageSim.isActive(rec.key)) && BF.world.isLoaded(rec.x, rec.z) && traders(rec, null).length) market.set(rec.key, summarize(rec));
}
let tickT = 0, summT = 0;
const lastSeen = new Map();
function tick(dt) {
  if (clustered()) return;   // (clusters: the prices are the shared table's, pins are kept at meetings: meet)
  tickT -= dt;
  if (tickT > 0 || !BF.villageSim) return;
  tickT = 5;
  if ((summT -= 5) <= 0) { summT = 60; for (const rec of BF.mobs.villages.values()) remember(rec); }
  else for (const rec of BF.mobs.villages.values()) if (!market.has(rec.key)) remember(rec);   // a village seen for the first time is written down at once
  const now = dayNow(), ids = new Set();
  for (const m of BF.regions.ofType("villager")) if (m.profession === PROF && !m.dead && !m.removed && m.mc && m.mc.trip) ids.add(m.mc.trip.id);
  for (const id of [...BF.villageSim.pins().keys()]) {
    if (ids.has(id)) { lastSeen.set(id, now); continue; }
    if (!lastSeen.has(id)) lastSeen.set(id, now);
    if (now - lastSeen.get(id) > 1) { BF.villageSim.unpin(id); lastSeen.delete(id); }
  }
}

// ---------------------------------------------------------------- clusters: the meeting (spec r15-39b, js/villagesim.js meet)
// Between ticks, every cluster seen, alike on every worker. In merchant id order: what each noted while away is written down (routes'
// trips, roads given up, path wear and its path blocks); then the pins: one whose merchant is here without that trip is dropped,
// one nobody has carried for a game day too (the merchant unloaded or died), and the asks are granted while fewer than
// MAX_PINS are on the road.
// With partial copies (js/cworkers.js) the merchants other workers run are read by what their holders send of them (views: notes, walk,
// trip, alive, key, place), not fetched whole; what the meeting changes goes on every copy alike (on a stale one, thrown away at its next refill).
const idNum = id => +String(id).slice(1) || 0;
function view(m) {
  if (m.profession !== PROF || !m.mc) return null;
  const st = m.mc, tr = st.trip;
  return { notes: st.notes || null, walk: st.walk || null, trip: tr ? { id: tr.id, pin: tr.pin, home: tr.home, dest: tr.dest } : null, wg: st.destWg || null, dead: m.dead ? 1 : 0, key: keyOf(m), at: [m.position.x, m.position.y, m.position.z] };
}
function meet() {
  const VS = BF.villageSim;
  if (!VS) return;
  const CW = BF.cworkers, vs = CW && CW.active ? CW.views(BF.regions.ofType("villager"), view) : null;
  const ms = vs ? [...vs].map(([id, v]) => [BF.ids.live(id), v]).filter(([m]) => m).sort((a, b) => idNum(a[0].id) - idNum(b[0].id))
    : BF.regions.ofType("villager").filter(m => !m.removed).map(m => [m, view(m)]).filter(([, v]) => v).sort((a, b) => idNum(a[0].id) - idNum(b[0].id));
  const stOf = m => m.mc || {};   // (a stale copy that isn't a merchant yet here: its change is thrown away)
  for (const [m, v] of ms) {
    if (v.notes) {
      for (const e of v.notes) {
        if (e[0] === "trip") addTrip(e[1], e[2], e[3], e[4], e[5]);
        else if (e[0] === "noroad") noRoad.set(e[1], e[2]);
      }
      const keep = v.notes.filter(e => e[0] === "vlog");
      stOf(m).notes = keep.length ? keep : null;
    }
    if (v.walk) {
      const w = v.walk, st = stOf(m);
      st.walk = null;
      for (let i = 0; i < w.length; i += 3) wearCell(m, st, w[i], w[i + 1], w[i + 2], w[i] + "," + w[i + 1] + "," + w[i + 2]);
    }
  }
  const now = dayNow(), carried = new Set(), here = new Set();
  for (const [, v] of ms) {
    const tr = v.trip;
    if (v.key) here.add(v.key);   // (a dead one too: its trip ended with it, js/merchant.js onKilled)
    if (!v.dead && tr && tr.pin !== "ask" && tr.pin !== "no") carried.add(tr.id);
  }
  for (const id of [...VS.pins().keys()]) {
    if (carried.has(id)) { lastSeen.set(id, now); continue; }
    if (here.has(id)) { VS.unpin(id); lastSeen.delete(id); continue; }   // its merchant is here, not on this trip
    if (!lastSeen.has(id)) lastSeen.set(id, now);
    if (now - lastSeen.get(id) > 1) { VS.unpin(id); lastSeen.delete(id); }
  }
  for (const [m, v] of ms) {
    const tr = v.trip;
    if (!tr || tr.pin !== "ask") continue;
    const st = stOf(m), mine = st.trip && st.trip.id === tr.id ? st.trip : null;
    if (v.dead) { if (mine) { st.trip = null; st.stage = null; } continue; }
    const ok = pinTrip(m, { trip: tr, destWg: v.wg });
    if (mine) mine.pin = ok ? "ok" : "no";
    if (ok) lastSeen.set(tr.id, now);
    if (BF.glog) BF.glog.log("INFO", "merchant", who(m) + (ok ? " may set out for the village at " + tr.dest + " (pinned at the meeting)" : " waits: " + VS.MAX_PINS + " trips are already on the road"), { village: m.village || undefined, at: v.at });
  }
}

// ---------------------------------------------------------------- persistence
function pack(m) {
  const st = m.mc;
  if (!st) return undefined;
  const o = { last: +st.last.toFixed(3), camp: m.ex && m.ex.camp ? m.ex.camp : undefined };   // its tent on the road (struck next morning)
  if (st.notes) o.notes = st.notes;   // (clusters: what it noted since the last meeting, js/merchant.js meet)
  if (st.walk) o.walk = st.walk;
  if (st.trip) o.trip = { id: st.trip.id, home: st.trip.home, dest: st.trip.dest, dx: Math.round(st.trip.dx), dz: Math.round(st.trip.dz), day0: +st.trip.day0.toFixed(3), stage: st.stage, out: st.trip.out, back: st.trip.back, soldN: st.trip.soldN, soldE: st.trip.soldE, cargo: st.cargo || null, want: st.want ? [...st.want] : null };
  return o;
}
function unpack(m, o) {
  if (!o || typeof o !== "object") return;
  const st = state(m);
  if (Number.isFinite(+o.last)) st.last = +o.last;
  if (Array.isArray(o.notes) && o.notes.length) st.notes = o.notes.filter(e => Array.isArray(e) && typeof e[0] === "string");
  if (Array.isArray(o.walk) && o.walk.length % 3 === 0 && o.walk.every(Number.isFinite)) st.walk = o.walk.slice();
  if (o.camp && BF.explorer && Number.isFinite(+o.camp.x) && Number.isFinite(+o.camp.f)) BF.explorer.unpack(m, { camp: o.camp });
  const tr = o.trip;
  if (tr && typeof tr.home === "string" && typeof tr.dest === "string" && Array.isArray(tr.out) && Array.isArray(tr.back)) {
    const ok = g => g && BF.items[g.id] && Number.isFinite(+g.n);
    const [kx, kz] = tr.dest.split(",").map(Number);
    st.trip = { id: tr.id, home: tr.home, dest: tr.dest, dx: Number.isFinite(+tr.dx) ? +tr.dx : kx, dz: Number.isFinite(+tr.dz) ? +tr.dz : kz, day0: +tr.day0 || dayNow(), out: tr.out.filter(ok), back: tr.back.filter(ok), soldN: +tr.soldN || 0, soldE: +tr.soldE || 0, boughtN: 0 };
    st.stage = ["buy", "go", "sell", "shop", "back", "unload"].includes(tr.stage) ? tr.stage : "back";
    if (tr.stage === "pin") { st.trip = null; st.stage = null; return; }   // (clusters: saved before its pin was granted: it plans again)
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
  const nr = {};
  for (const [k, d] of noRoad) if (d > dayNow()) nr[k] = +d.toFixed(3);
  out["caravans"] = { routes: r, wear: w, market: Object.fromEntries(market), noroad: nr };
  if (clustered() && BF.sharedTable) out["caravans"].shared = BF.sharedTable.serialize();   // the shared table (spec r15-39b): only with the cluster tick on
}
function importAll(o) {
  routes.clear(); wear.clear(); market.clear(); noRoad.clear();
  const c = o && o.caravans;
  if (BF.sharedTable) BF.sharedTable.restore(c && c.shared);
  if (!c || typeof c !== "object") return;
  for (const k in c.routes || {}) {
    const v = c.routes[k], [a, b] = k.split("|");
    if (a && b && v && Array.isArray(v.t)) routes.set(k, { a, b, trips: v.t.filter(t => Array.isArray(t) && t.length === 3), total: +v.n || v.t.length });
  }
  for (const k in c.market || {}) { const v = c.market[k]; if (v && typeof v === "object" && v.sells && v.buys) market.set(k, v); }
  for (const k in c.noroad || {}) if (Number.isFinite(+c.noroad[k])) noRoad.set(k, +c.noroad[k]);
  for (const s of Array.isArray(c.wear) ? c.wear : []) { const p = String(s).split(",").map(Number); if (p.length === 4 && p.every(Number.isFinite)) wear.set(p.slice(0, 3).join(","), p[3]); }
}
function reset() { routes.clear(); wear.clear(); market.clear(); noRoad.clear(); lastSeen.clear(); LOG.length = 0; tickT = summT = 0; if (BF.sharedTable) BF.sharedTable.reset(); }

let hooked = false;
function hook() { if (!hooked && BF.on) { hooked = true; BF.on("mobKilled", onKilled); } }
setTimeout(hook, 0);

// On a trip (until dusk, when it camps or is home) or camped: mobs.js villagerAI does not walk it back to its village between errands or before the day starts.
const away = m => !!(m.ex && m.ex.camp) || (!!(m.mc && m.mc.trip) && skyT() < DUSK);
BF.merchant = { away, roaming, meet, traders, remember, forceHome, PROF, RANGE, leftSecs, MAX_PLAN_DAYS, TRIP_MAX_DAYS, tripDays, candidates, summarize, bookOf, market, noRoad, roadKey, CARGO_STACKS, TRIP_EVERY, WEAR_N, MIN_GAIN, mayHire, ai, plan, goods, book, statusText, reserve, pack, unpack, routes: routesView, tick, exportAll, importAll, reset, wear, step, LOG, _state: state, hook };
})();
