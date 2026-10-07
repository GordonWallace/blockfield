// Furniture makers (BF.furniture): a villager profession (not vanilla) that turns wool and boards into beds and sells the beds to builders.
// - Roster: a village generated with this version that has both a shepherd and a forester gets a furniture maker with FURNITURE_CHANCE (80%)
//   (mobs.js villageRoster, own seeded stream and key range <village key>#1300). Jobsite: the carpentry bench (jobs.js), placed on the plaza.
// - Crafting: standing at its carpentry bench (BF.jobs "work" state) it makes one bed from 3 wool (any colour) + 3 planks (any wood), the
//   vanilla recipe, while it holds fewer than BED_STOCK beds; logs are sawn into 4 planks first when it is short of planks. Beds never
//   appear from nothing (no daily restock, trading.js PRODUCE).
// - Buying: short of wool or boards (and holding emeralds) it walks to another villager of its village whose trade table sells them (the
//   shepherd's wool, the forester's boards, ...) and trades like the player would (stock and room rules of trading.js).
// - Selling: holding beds, it walks to a builder of its village that wants beds (the beds its current structure or plan still needs, and
//   at least BUILDER_BEDS in hand for the next house) and sells them at its own offer "1 emerald > 2 red_bed", paid from the builder's purse.
//   Builders short of beds also come to it on their own (builder.js findSeller), and the player can buy and sell at its trade table.
// - Chests: villagers whose inventory is full and whose house has no chest they may use order one (js/storage.js orders). The furniture
//   maker makes chests from 8 planks (the vanilla recipe) for the orders it has, carries one to the house and puts it down on the spot the
//   villager picked, taking 1 emerald from the villager's purse. Deliveries come before bed sales.
// See CONTRACT.md "Furniture makers".
(() => {
"use strict";
const BF = window.BF;
const TR = () => BF.trades;
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();

const WOOL = 3, PLANKS = 3, LOG_PLANKS = 4;   // one bed = 3 wool + 3 planks; one log saws into 4 planks
const BED_STOCK = 6;                          // stops making beds once it holds this many
const BUY_BEDS = 2;                           // buys ingredients for this many beds per shopping round
const BUILDER_BEDS = 2;                       // a builder is happy to keep this many beds in hand for its next house
const CHEST_PLANKS = 8;                       // one chest = 8 planks
const CHEST_STOCK = 3;                        // makes chests only for open orders, at most this many in hand
const CRAFT_PAUSE = 1.8, WORK_END = 0.45, TRADE_PAUSE = 1.6;
const LOG = [];
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: m.profession + (m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };

const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const isWool = id => { const n = nameOf(id); return n === "wool" || /_wool$/.test(n); };
const isPlanks = id => { const n = nameOf(id); return n === "planks" || /_planks$/.test(n); };
const isLog = id => { const n = nameOf(id); return /_log$/.test(n) && !/^stripped_/.test(n); };
const sum = (m, f) => { let n = 0; for (const s of m.inv) if (s && f(s.id)) n += s.count; return n; };
const beds = m => TR().inv.count(m.inv, BF.I.red_bed);
const chests = m => TR().inv.count(m.inv, BF.I.chest);
const orders = m => (BF.storage && m.village ? BF.storage.orders(m.village) : []);
const chestsWanted = m => Math.max(0, Math.min(CHEST_STOCK, orders(m).length) - chests(m));   // chests still to make for open orders
// Takes n items of a kind (wool, planks, logs) from the inventory, the biggest stacks first. Returns how many were taken.
function take(m, f, n) {
  let left = n;
  while (left > 0) {
    let best = null;
    for (const s of m.inv) if (s && f(s.id) && (!best || s.count > best.count)) best = s;
    if (!best) break;
    left -= TR().inv.remove(m.inv, best.id, Math.min(left, best.count));
  }
  return n - left;
}

// Starting inventory for a new furniture maker (a = inventory array, already filled by trading.stockFor): two beds and one bed's worth of
// wool and planks, so it has something to sell and something to make on its first day.
function seed(a) {
  const inv = TR().inv, I = BF.I;
  if (I.red_bed == null) return;
  const b = inv.count(a, I.red_bed);
  if (b > 2) inv.remove(a, I.red_bed, b - 2); else if (b < 2) inv.add(a, I.red_bed, 2 - b);
  const has = f => a.reduce((n, s) => n + (s && f(s.id) ? s.count : 0), 0);
  if (has(isWool) < WOOL) inv.add(a, I.white_wool, WOOL - has(isWool));
  if (has(isPlanks) < PLANKS) inv.add(a, I.planks, PLANKS - has(isPlanks));
}

// What it could make right now: {kind: "chest" | "bed" | "planks"} or null. Chests for open orders come first.
function plan(m) {
  if (!m || !m.inv || BF.I.red_bed == null) return null;
  const inv = TR().inv, I = BF.I;
  const planks = sum(m, isPlanks);
  if (I.chest != null && chestsWanted(m) > 0) {
    if (planks >= CHEST_PLANKS && inv.canFit(m.inv, [{ id: I.chest, n: 1 }], [])) return { kind: "chest" };
    if (planks < CHEST_PLANKS && sum(m, isLog) > 0 && inv.canFit(m.inv, [{ id: I.planks, n: LOG_PLANKS }], [])) return { kind: "planks" };
  }
  if (beds(m) >= BED_STOCK || sum(m, isWool) < WOOL) return null;
  if (planks >= PLANKS) return inv.canFit(m.inv, [{ id: I.red_bed, n: 1 }], []) ? { kind: "bed" } : null;
  if (sum(m, isLog) > 0 && inv.canFit(m.inv, [{ id: I.planks, n: LOG_PLANKS }], [])) return { kind: "planks" };
  return null;
}
function craft(m, p) {
  const inv = TR().inv, I = BF.I;
  if (p.kind === "planks") { take(m, isLog, 1); inv.add(m.inv, I.planks, LOG_PLANKS); log("craft", m, { made: LOG_PLANKS + " planks" }); return; }
  if (p.kind === "chest") { take(m, isPlanks, CHEST_PLANKS); inv.add(m.inv, I.chest, 1); log("craft", m, { made: "chest", chests: chests(m) }); return; }
  take(m, isWool, WOOL); take(m, isPlanks, PLANKS);
  inv.add(m.inv, I.red_bed, 1);
  log("craft", m, { made: "bed", beds: beds(m) });
}
// Called by jobs.js while the villager stands at its jobsite. Makes one thing per CRAFT_PAUSE and stays while there is more to do.
function work(m, J, dt) {
  const F = m.furnWork || (m.furnWork = { t: CRAFT_PAUSE });
  F.t -= dt;
  if (F.t > 0) return;
  const p = plan(m);
  if (!p) return;
  F.t = CRAFT_PAUSE;
  craft(m, p);
  if (m.ai) m.ai.swingT = 0.35;
  if (J && J.t < 3 && plan(m)) J.t = 3;
}
// jobs.js asks this to bring forward the next visit to the bench when there is something to make.
const wantsJob = m => !!plan(m);

// ---------------------------------------------------------------- buying wool and boards
// Shortfall {wool: n, planks: n} for the next BUY_BEDS beds (logs on hand count as 4 planks each); empty while it holds BED_STOCK beds.
function shortfall(m) {
  const out = {}, room = BED_STOCK - beds(m), forChests = CHEST_PLANKS * chestsWanted(m);
  if (room <= 0) { const p = forChests - sum(m, isPlanks) - LOG_PLANKS * sum(m, isLog); if (p > 0) out.planks = p; return out; }
  const n = Math.min(BUY_BEDS, room);
  const w = WOOL * n - sum(m, isWool), p = PLANKS * n + forChests - sum(m, isPlanks) - LOG_PLANKS * sum(m, isLog);
  if (w > 0) out.wool = w;
  if (p > 0) out.planks = p;
  return out;
}
// The kind of ingredient an item is, and how many planks one item is worth.
const kindOf = id => (isWool(id) ? ["wool", 1] : isPlanks(id) ? ["planks", 1] : isLog(id) ? ["planks", LOG_PLANKS] : null);
const canSell = v2 => v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && v2.profession !== "furniture_maker" && Array.isArray(v2.inv) && Array.isArray(v2.trades);
function findSeller(m, short, avoid) {
  const R = m.village, T = TR();
  if (!R) return null;
  let best = null, bd = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2)) continue;
    for (const o of v2.trades) {
      const kd = kindOf(o.sell.id), need = kd && short[kd[0]];
      if (!need || T.blockReason(v2, o) || (avoid[(v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id] || 0) > dayNow()) continue;
      let k = Math.min(Math.ceil(need / (o.sell.n * kd[1])), Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n), 4);
      for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
      while (k > 0 && !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n * k }], o.buy.map(b => ({ id: b.id, n: b.n * k })))) k--;
      if (k < 1) continue;
      const d = v2.position.distanceTo(m.position);
      if (d < bd) { bd = d; best = { kind: "buy", other: v2, offer: o, times: k, item: o.sell.id }; }
    }
  }
  return best;
}
function doBuy(m, deal) {
  const T = TR(), v2 = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(v2) || T.blockReason(v2, o)) break;
    if (!o.buy.every(b => T.inv.count(m.inv, b.id) >= b.n)) break;
    if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
    if (!T.exchange(v2, o)) break;
    for (const b of o.buy) T.inv.remove(m.inv, b.id, b.n);
    T.inv.add(m.inv, o.sell.id, o.sell.n);
    T.addXp(v2, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(m, v2, o, done);
  if (done) log("buy", m, { from: v2.profession, got: done * o.sell.n + " " + BF.itemName(o.sell.id), paid: o.buy.map(b => b.n * done + " " + BF.itemName(b.id)).join(" + ") });
  return done;
}

// ---------------------------------------------------------------- selling beds to builders
// How many beds builder b would take now: what its structure or plan still lacks, and at least BUILDER_BEDS in hand for the next house.
function builderWants(b) {
  const id = BF.I.red_bed, have = TR().inv.count(b.inv, id), bs = b.bs;
  let need = BUILDER_BEDS - have;
  if (bs && bs.want && bs.want.short && bs.want.short[id]) need = Math.max(need, bs.want.short[id]);
  if (bs && bs.entry && bs.entry.state === "building" && BF.builder && BF.builder.remainingReq) need = Math.max(need, (BF.builder.remainingReq(bs.entry, bs.entry.prog)[id] || 0) - have);
  return Math.max(0, need);
}
const canBuy = b => b && b.type === "villager" && b.profession === "builder" && !b.dead && !b.removed && !b.sleeping && !b.tradingWith && Array.isArray(b.inv);
const bedOffer = m => (m.trades || []).filter(o => o.sell.id === BF.I.red_bed && o.buy.length === 1 && o.buy[0].id === BF.I.emerald).sort((a, b) => a.sell.n - b.sell.n)[0] || null;
// How many times builder b can take offer o from m now (its want, its purse and room, m's stock).
function saleTimes(m, b, o) {
  const T = TR();
  if (!o || T.blockReason(m, o)) return 0;
  let k = Math.min(Math.ceil(builderWants(b) / o.sell.n), Math.floor(beds(m) / o.sell.n), 4);
  for (const p of o.buy) k = Math.min(k, Math.floor(T.inv.count(b.inv, p.id) / p.n));
  while (k > 0 && !T.inv.canFit(b.inv, [{ id: o.sell.id, n: o.sell.n * k }], o.buy.map(p => ({ id: p.id, n: p.n * k })))) k--;
  return Math.max(0, k);
}
function findBuyer(m, avoid) {
  const R = m.village, o = bedOffer(m);
  if (!R || !o || beds(m) < o.sell.n) return null;
  let best = null, bd = Infinity;
  for (const b of R.members || []) {
    if (b === m || !canBuy(b) || (avoid[(b.slot ? b.slot.idx : 0) + ":bed"] || 0) > dayNow()) continue;
    const k = saleTimes(m, b, o);
    if (k < 1) continue;
    const d = b.position.distanceTo(m.position);
    if (d < bd) { bd = d; best = { kind: "sell", other: b, offer: o, times: k, item: "bed" }; }
  }
  return best;
}
// The builder buys from the furniture maker's own offer: same stock / room rules as a player trade, xp to the furniture maker.
function doSell(m, deal) {
  const T = TR(), b = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canBuy(b) || saleTimes(m, b, o) < 1) break;
    if (!T.exchange(m, o)) break;
    for (const p of o.buy) T.inv.remove(b.inv, p.id, p.n);
    T.inv.add(b.inv, o.sell.id, o.sell.n);
    T.addXp(m, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(b, m, o, done);
  if (done) log("sell", m, { to: "builder", beds: done * o.sell.n, got: o.buy.map(p => p.n * done + " " + BF.itemName(p.id)).join(" + ") });
  return done;
}

// ---------------------------------------------------------------- delivering chests (orders from js/storage.js)
function findDelivery(m, avoid) {
  if (chests(m) < 1) return null;
  let best = null, bd = Infinity;
  for (const o of orders(m)) {
    if (o.m === m || (avoid[(o.m.slot ? o.m.slot.idx : 0) + ":chest"] || 0) > dayNow()) continue;
    const d = Math.hypot(o.spot.x - m.position.x, o.spot.z - m.position.z);
    if (d < bd) { bd = d; best = { kind: "deliver", other: o.m, spot: o.spot, item: "chest" }; }
  }
  return best;
}

// ---------------------------------------------------------------- walking (same A* hops as js/cartography.js)
// `near` (optional): (x, y, z) -> true for the cells to stop at (default: within ~1.75 blocks of the target).
function travel(m, st, dt, out, tx, ty, tz, speed, near) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z;
  if (near ? near(...N.feetCell(m)) : Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) <= 1.75 && Math.abs(ty - m.position.y) < 1.6) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "furn") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const goal = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: near || ((x, y, z) => Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1) };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "furn"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}

// Villager AI step (mobs.js villagerAI, daytime): trips to sell beds to builders (first) or to buy wool and boards. Returns true while it steers.
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || !BF.mobs || !BF.mobs.nav || !m.village) return false;
  const sh = m.furn || (m.furn = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0 }), a = m.ai;
  if (skyT() >= WORK_END || m.tradingWith) { if (sh.stage) { sh.stage = null; sh.deal = null; a.route = null; } return false; }
  if (!sh.stage) {
    sh.checkT -= dt;
    if (sh.checkT > 0) return false;
    sh.checkT = 4;
    const now = dayNow();
    if (sh.cd > now) return false;
    let deal = findDelivery(m, sh.avoid) || findBuyer(m, sh.avoid);
    if (!deal && TR().inv.count(m.inv, BF.I.emerald) > 0) {
      const short = shortfall(m);
      if (Object.keys(short).length) deal = findSeller(m, short, sh.avoid);
    }
    if (!deal) { sh.cd = now + 0.04; return false; }
    sh.deal = deal; sh.stage = "walk"; sh.walkT = 0; sh.navFail = 0; sh.gx = null; a.route = null;
  }
  const deal = sh.deal, v2 = deal && deal.other;
  const avoidKey = () => (v2 && v2.slot ? v2.slot.idx : 0) + ":" + deal.item;
  const giveUp = why => { log("giveup", m, { to: v2 ? v2.profession : "?", item: deal ? (deal.item === "bed" || deal.item === "chest" ? deal.item : BF.itemName(deal.item)) : "?", why }); if (v2) sh.avoid[avoidKey()] = dayNow() + 0.05; sh.stage = null; sh.deal = null; a.route = null; sh.checkT = 0.5; return false; };
  if (deal && deal.kind === "deliver") {   // carry the chest to the house and put it down on the spot the villager picked
    if (!v2 || v2.dead || v2.removed || !v2.store || !v2.store.order) return giveUp("order gone");
    const s = deal.spot;
    a.mode = "idle"; a.t = 2;
    sh.walkT += dt;
    if (sh.walkT > 90) return giveUp("timeout");
    if (sh.stage === "walk") {
      const st = travel(m, sh, dt, out, s.x, s.y, s.z, m.def.speed * 1.3, (x, y, z) => Math.abs(x - s.x) + Math.abs(z - s.z) === 1 && Math.abs(y - s.y) <= 1);   // beside the spot, never on it
      if (st === "failed") return giveUp("no path");
      if (st === "arrived") { sh.stage = "trade"; sh.tt = TRADE_PAUSE; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.5 };
    if ((sh.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
    const ok = BF.storage.deliver(m, v2, s);
    log(ok ? "deliver" : "giveup", m, { to: v2.profession, item: "chest", at: s.x + "," + s.y + "," + s.z, why: ok ? undefined : "spot taken or unpaid" });
    if (!ok) { sh.avoid[avoidKey()] = dayNow() + 0.05; if (v2.store) v2.store.order = null; }   // the villager picks a new spot next time
    sh.stage = null; sh.deal = null; sh.gx = null; sh.checkT = 1;
    return true;
  }
  if (!v2 || (deal.kind === "buy" ? !canSell(v2) : !canBuy(v2))) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone");
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  a.mode = "idle"; a.t = 2;
  if (sh.stage === "walk") {
    sh.walkT += dt;
    if (sh.walkT > 60) return giveUp("timeout");
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { sh.stage = "trade"; sh.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (sh.gx == null || Math.hypot(sh.gx - g.x, sh.gz - g.z) > 3) { if (a.routeKind === "furn") a.route = null; sh.gx = g.x; sh.gz = g.z; }
    const st = travel(m, sh, dt, out, g.x, g.y, g.z, m.def.speed * 1.3);
    if (st === "failed") return giveUp("no path");
    return true;
  }
  sh.tt -= dt;
  if (d > 3.6) { sh.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (sh.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (sh.tt <= 0) {
    const done = deal.kind === "buy" ? doBuy(m, deal) : doSell(m, deal);
    sh.stage = null; sh.deal = null; sh.gx = null; sh.checkT = 1;
    if (!done) { sh.avoid[avoidKey()] = dayNow() + 0.05; log("giveup", m, { to: v2.profession, item: deal.item === "bed" ? "bed" : BF.itemName(deal.item), why: "trade refused" }); }
  }
  return true;
}

// Trade screen title (inventory.js): what it is doing right now, or "".
function statusText(m) {
  if (!m || m.profession !== "furniture_maker") return "";
  const sh = m.furn;
  if (sh && sh.stage && sh.deal) return sh.deal.kind === "deliver" ? "Delivering a chest" : sh.deal.kind === "sell" ? "Taking beds to a builder" : "Buying " + (isWool(sh.deal.item) ? "wool" : "boards");
  if (m.job && m.job.mode === "work" && plan(m)) return plan(m).kind === "chest" || chestsWanted(m) > 0 ? "Making a chest" : "Making beds";
  return "";
}

BF.furniture = { WOOL, PLANKS, LOG_PLANKS, BED_STOCK, BUY_BEDS, BUILDER_BEDS, CHEST_PLANKS, CHEST_STOCK, chestsWanted, findDelivery, seed, plan, craft, work, wantsJob, shortfall, findSeller, doBuy, builderWants, findBuyer, doSell, ai, statusText, LOG };
})();
