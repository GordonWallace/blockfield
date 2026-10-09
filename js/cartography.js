// Cartographer villagers and maps (BF.cartography). Companion of js/maps.js (the items) and js/trading.js (trade tables).
// - Starting stock: no compasses or maps. A cartographer always gets the ingredients of one compass (4 iron ingots + 1 gold ingot) and, about half the
//   time, 8 paper as well (enough for a map); the other half it holds fewer than 8 paper. See seed(), called from trading.stockFor.
// - Crafting: standing at its cartography table (BF.jobs "work" state), the villager crafts from its inventory: a compass, then a map (8 paper around a
//   compass), and with plenty of paper it surrounds a blank map with paper to make the next size. Only while it holds fewer than MAP_STOCK maps.
// - Buying: short of ingredients (and holding emeralds) it walks to another villager of its village that sells them (the armorer's iron and gold, the
//   librarian's paper, ...) and trades like the player would (stock and room rules of trading.js); the player can sell it the ingredients too (trade table).
(() => {
"use strict";
const BF = window.BF;
const TR = () => BF.trades;
const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();

const IRON = 4, GOLD = 1, PAPER = 8;      // one compass = 4 iron + 1 gold; one map = 8 paper + a compass
const MAP_STOCK = 2;                      // stops making maps once it holds this many blank maps
const UPGRADE_PAPER = 24;                 // paper it keeps before it will spend 8 on a bigger map
const CRAFT_PAUSE = 1.6, WORK_END = 0.45, TRADE_PAUSE = 1.6;
const LOG = [];
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: m.profession + (m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };

const cnt = (m, id) => (id == null ? 0 : TR().inv.count(m.inv, id));
const blankIds = () => [1, 2, 3, 4, 5].map(n => BF.I["blank_map_" + n]);
const maps = m => blankIds().reduce((n, id) => n + cnt(m, id), 0);

// Starting inventory top-up for a new cartographer (a = inventory array, already filled by trading.stockFor).
function seed(a) {
  const inv = TR().inv, I = BF.I;
  if (I.iron_ingot == null || I.gold_ingot == null || I.paper == null) return;
  const have = id => inv.count(a, id);
  if (have(I.iron_ingot) < IRON) inv.add(a, I.iron_ingot, IRON - have(I.iron_ingot));
  if (have(I.gold_ingot) < GOLD) inv.add(a, I.gold_ingot, GOLD - have(I.gold_ingot));
  if (Math.random() < 0.5) { if (have(I.paper) < PAPER) inv.add(a, I.paper, PAPER - have(I.paper)); }
  else if (have(I.paper) >= PAPER) inv.remove(a, I.paper, have(I.paper) - rndInt(0, PAPER - 1));
}

// What it could craft right now: {kind: "compass" | "map" | "upgrade", from?: item id} or null.
function plan(m) {
  if (!m || !m.inv || !BF.I.compass) return null;
  const T = TR(), I = BF.I, inv = T.inv;
  const iron = cnt(m, I.iron_ingot), gold = cnt(m, I.gold_ingot), paper = cnt(m, I.paper), compass = cnt(m, I.compass), have = maps(m);
  if (have < MAP_STOCK) {
    if (paper >= PAPER && compass >= 1 && inv.canFit(m.inv, [{ id: I.blank_map_1, n: 1 }], [{ id: I.paper, n: PAPER }, { id: I.compass, n: 1 }])) return { kind: "map" };
    if (compass < 1 && iron >= IRON && gold >= GOLD && inv.canFit(m.inv, [{ id: I.compass, n: 1 }], [{ id: I.iron_ingot, n: IRON }, { id: I.gold_ingot, n: GOLD }])) return { kind: "compass" };
  } else if (paper >= UPGRADE_PAPER) {
    for (let s = 1; s < BF.maps.MAX_SIZE; s++) if (cnt(m, I["blank_map_" + s]) > 0) return { kind: "upgrade", from: I["blank_map_" + s], to: I["blank_map_" + (s + 1)] };
  }
  return null;
}
function craft(m, p) {
  const inv = TR().inv, I = BF.I;
  if (p.kind === "compass") { inv.remove(m.inv, I.iron_ingot, IRON); inv.remove(m.inv, I.gold_ingot, GOLD); inv.add(m.inv, I.compass, 1); }
  else if (p.kind === "map") { inv.remove(m.inv, I.paper, PAPER); inv.remove(m.inv, I.compass, 1); inv.add(m.inv, I.blank_map_1, 1); }
  else { inv.remove(m.inv, I.paper, PAPER); inv.remove(m.inv, p.from, 1); inv.add(m.inv, p.to, 1); }
  log("craft", m, { made: p.kind === "compass" ? "compass" : p.kind === "map" ? "blank map" : BF.items[p.to].name });
}
// Called by jobs.js while the villager stands at its jobsite. Crafts one thing per CRAFT_PAUSE and keeps it there while there is more to do.
function work(m, J, dt) {
  const C = m.cart || (m.cart = { t: CRAFT_PAUSE });
  C.t -= dt;
  if (C.t > 0) return;
  const p = plan(m);
  if (!p) return;
  C.t = CRAFT_PAUSE;
  craft(m, p);
  if (m.ai) m.ai.swingT = 0.35;
  if (J && J.t < 3 && plan(m)) J.t = 3;
}
// jobs.js asks this to bring forward the next visit to the cartography table when there is something to craft.
const wantsJob = m => !!plan(m);

// ---------------------------------------------------------------- buying ingredients
// Shortfall {itemId: n} for the next thing it wants to make.
function shortfall(m) {
  const I = BF.I, out = {};
  if (maps(m) >= MAP_STOCK) return out;
  const compass = cnt(m, I.compass), need = (id, n) => { const k = n - cnt(m, id); if (k > 0) out[id] = k; };
  if (compass < 1) { need(I.iron_ingot, IRON); need(I.gold_ingot, GOLD); }
  need(I.paper, PAPER);
  return out;
}
const canSell = v2 => v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && v2.profession !== "cartographer" && Array.isArray(v2.inv) && Array.isArray(v2.trades);
function findSeller(m, short, avoid) {
  const R = m.village, T = TR();
  if (!R) return null;
  let best = null, bd = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2)) continue;
    for (const o of v2.trades) {
      const need = short[o.sell.id];
      if (!need || T.blockReason(v2, o) || (avoid[(v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id] || 0) > dayNow()) continue;
      let k = Math.min(Math.ceil(need / o.sell.n), Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n), 4);
      for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
      while (k > 0 && !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n * k }], o.buy.map(b => ({ id: b.id, n: b.n * k })))) k--;
      if (k < 1) continue;
      const d = v2.position.distanceTo(m.position);
      if (d < bd) { bd = d; best = { seller: v2, offer: o, times: k, item: o.sell.id }; }
    }
  }
  return best;
}
function doDeal(m, deal) {
  const T = TR(), v2 = deal.seller, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(v2) || T.blockReason(v2, o)) break;
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
  if (done) log("buy", m, { from: v2.profession, got: done * o.sell.n + " " + BF.itemName(o.sell.id), paid: o.buy.map(b => b.n * done + " " + BF.itemName(b.id)).join(" + ") });
  return done;
}
function travel(m, st, dt, out, tx, ty, tz, speed) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z;
  if (Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) <= 1.75 && Math.abs(ty - m.position.y) < 1.6) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "cart") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const goal = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: (x, y, z) => Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1 };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "cart"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}
// Villager AI step (mobs.js villagerAI, daytime): shopping trips. Returns true while it steers the villager.
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || !BF.mobs || !BF.mobs.nav || !m.village) return false;
  const sh = m.cshop || (m.cshop = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0 }), a = m.ai;
  if (skyT() >= WORK_END || m.tradingWith) { if (sh.stage) { sh.stage = null; sh.deal = null; a.route = null; } return false; }
  if (!sh.stage) {
    sh.checkT -= dt;
    if (sh.checkT > 0) return false;
    sh.checkT = 4;
    const now = dayNow();
    if (sh.cd > now || cnt(m, BF.I.emerald) < 1) return false;
    const short = shortfall(m);
    if (!Object.keys(short).length) return false;
    const deal = findSeller(m, short, sh.avoid);
    if (!deal) { sh.cd = now + 0.08; return false; }
    sh.deal = deal; sh.stage = "walk"; sh.walkT = 0; sh.navFail = 0; a.route = null;
  }
  const deal = sh.deal, v2 = deal && deal.seller;
  const giveUp = () => { if (v2) sh.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + deal.item] = dayNow() + 0.05; sh.stage = null; sh.deal = null; a.route = null; sh.checkT = 0.5; return false; };
  if (!v2 || !canSell(v2)) return giveUp();
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  a.mode = "idle"; a.t = 2;
  if (sh.stage === "walk") {
    sh.walkT += dt;
    if (sh.walkT > 60) return giveUp();
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { sh.stage = "trade"; sh.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (sh.gx == null || Math.hypot(sh.gx - g.x, sh.gz - g.z) > 3) { if (a.routeKind === "cart") a.route = null; sh.gx = g.x; sh.gz = g.z; }
    const st = travel(m, sh, dt, out, g.x, g.y, g.z, m.def.speed * 1.3);
    if (st === "failed") return giveUp();
    return true;
  }
  sh.tt -= dt;
  if (d > 3.6) { sh.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (sh.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (sh.tt <= 0) {
    const done = doDeal(m, deal);
    sh.stage = null; sh.deal = null; sh.gx = null; sh.checkT = 1;
    if (!done) sh.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + deal.item] = dayNow() + 0.05;
  }
  return true;
}

BF.cartography = { IRON, GOLD, PAPER, MAP_STOCK, UPGRADE_PAPER, seed, plan, craft, work, wantsJob, shortfall, findSeller, doDeal, ai, LOG };
})();
