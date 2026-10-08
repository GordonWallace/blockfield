// Egg cooking (BF.eggCook): any villager cooks the raw eggs it holds, but only in a real furnace of its village, with the toolsmith's furnace
// routine (js/furnaceuse.js): it walks to a furnace it may use, puts the eggs in with fuel it holds (or what is already burning there), waits
// beside it while the furnace cooks them in game time (fast-forward included), and takes out the cooked eggs and all the fuel left.
// - Raw eggs are not food (BF.food never eats them). Eggs are never cooked instantly, nor without a furnace and fuel: with no usable
//   furnace, or no fuel and no fuel it can buy, the eggs stay raw.
// - Fuel: coal or charcoal first, then logs and planks (planks past 3). Wood it works with or sells is not burnt: builders, farmers (bed
//   edges), foresters and furniture makers, and anyone with an offer for that wood, burn only coal. Short of fuel, it buys coal (or wood it
//   may burn) from a villager of its village at the seller's own offer, never wares that appear from the daily restock.
// - Which eggs: all it holds, except a villager that sells eggs (the poultry keeper, js/poultry.js) keeps its stock and cooks only what it
//   needs to eat while it is hungry.
// - One villager per furnace (BF.furnaceUse.inUse): one that finds its furnace taken gives that furnace up a while and tries another.
// - Food shopping (js/villagelife.js): a hungry villager that can cook buys eggs (cheap food) from a villager that sells them (eggDeal), one
//   that cannot buys ready food. Raw eggs it can cook count as food it already has, so it does not buy more while they wait for the furnace.
// - Called from mobs.js villagerAI twice: early to carry on an errand under way (ai(m, dt, out, true)), late (just before the jobsite visits)
//   to start one when the villager has nothing else to do. Work stops at WORK_END; eggs still in the furnace then come back raw.
// See CONTRACT.md "Egg cooking".
(() => {
"use strict";
const BF = window.BF;
const FU = BF.furnaceUse;
const TR = () => BF.trades;
const INV = () => BF.inventory;
const I = n => BF.I[n];
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();

const WORK_END = 0.45, TRADE_PAUSE = 1.6, CHECK = 4;
const BUY_BY = 0.38;                           // eggs are bought as food only while there is time left to cook them today
const SHOP_DAYS = 3;                           // as villagelife.js: a hungry villager stocks up to 3 days of food
const NO_WOOD = { builder: 1, farmer: 1, forester: 1, furniture_maker: 1 };   // they work with wood: coal only
const LOG = [];
const EGG = () => I("egg"), COOKED = () => I("cooked_egg");
const count = (m, id) => (id == null ? 0 : TR().inv.count(m.inv, id));
const ems = m => count(m, I("emerald"));
const state = m => m.eggc || (m.eggc = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0 });
const avoided = (S, k) => (S.avoid[k] || 0) > dayNow();
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: (m.profession || "villager") + (m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };
const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const vlog = (m, kind, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, kind, (BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Villager") + " (" + pretty(m.profession) + ") " + text); };   // place: the "at x,y,z" in the text

// ---------------------------------------------------------------- what it cooks, with what
const sellsEggs = m => (m.trades || []).some(o => o && o.sell && o.sell.id === EGG());
// Raw eggs it would cook now: all of them, or for an egg seller only what it needs to eat while hungry.
function toCook(m) {
  const n = count(m, EGG());
  if (!n || COOKED() == null) return 0;
  if (!sellsEggs(m)) return n;
  const F = BF.food, want = SHOP_DAYS * F.rate(m) - F.available(m);
  return want > 0 && F.available(m) < F.rate(m) ? Math.min(n, Math.ceil(want / F.breadEq(COOKED()))) : 0;
}
// Fuel it may burn: coal always, wood unless it works with wood or sells that kind.
const fuelOk = m => id => FU.isCoal(id) || (!NO_WOOD[m.profession] && !(m.trades || []).some(o => o && o.sell && o.sell.id === id));
const skipFurnace = S => f => avoided(S, "f:" + FU.pk(f.x, f.y, f.z));
const skipOffer = S => (v2, o) => avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id);
// How it would cook n eggs, spending at most `budget` emeralds on fuel: {furnace} (fuel in hand or burning there), {furnace, need: {f, n, what}}
// (fuel to buy first, `cost` emeralds), or null when it cannot (no usable furnace in its village, no fuel it holds or can afford).
function cookPlan(m, n, budget) {
  if (!m.village || !n || EGG() == null || COOKED() == null) return null;
  const S = state(m), fs = FU.near(m, EGG(), COOKED(), skipFurnace(S));
  if (!fs.length) return null;
  const f = fs[0], ok = fuelOk(m), k = Math.min(n, 16);
  if (FU.fuelIn(f) >= k || FU.fuelFor(m, Math.max(0, k - FU.fuelIn(f)), ok).length) return { furnace: f };
  const coal = Math.ceil(k / FU.PER_COAL), cc = FU.priceOf(m, FU.isCoal, coal, false, skipOffer(S));
  if (cc <= budget) return { furnace: f, need: { what: "fuel", f: FU.isCoal, n: coal }, cost: cc };
  const wood = id => (FU.isLog(id) || FU.isPlanks(id)) && ok(id), w = Math.ceil(k / FU.PER_WOOD), wc = FU.priceOf(m, wood, w, false, skipOffer(S));
  if (wc <= budget) return { furnace: f, need: { what: "fuel", f: wood, n: w }, cost: wc };
  return null;
}
const canCook = (m, n, budget) => !!cookPlan(m, n, budget == null ? ems(m) : budget);
// Bread-eq of the eggs it is going to eat cooked: the ones in the furnace for it now and the raw ones in hand it can cook.
function pending(m) {
  if (COOKED() == null) return 0;
  const S = m.eggc, per = BF.food.breadEq(COOKED());
  let n = S && S.stage === "cook" && S.deal ? S.deal.loaded || 0 : 0;
  const raw = toCook(m);
  if (raw && canCook(m, raw)) n += raw;
  return n * per;
}
// Food shopping (villagelife.js findFoodSeller): eggs from seller v2 for `want` bread-eq, when m can cook them (a furnace, and fuel in hand
// or emeralds left over for it). {seller, offer, times, price, item, egg: true} or null.
function eggDeal(m, v2, want) {
  const T = TR(), em = I("emerald"), egg = EGG();
  if (egg == null || COOKED() == null || skyT() > BUY_BY || !v2 || v2 === m || !Array.isArray(v2.trades) || !Array.isArray(v2.inv)) return null;
  const per1 = BF.food.breadEq(COOKED()), myEm = ems(m);
  let best = null;
  for (const o of v2.trades) {
    if (!o || o.feed || o.buy.length !== 1 || o.buy[0].id !== em || o.sell.id !== egg || T.blockReason(v2, o)) continue;
    const per = per1 * o.sell.n;
    let k = Math.min(Math.ceil(want / per), Math.floor(myEm / o.buy[0].n), Math.floor(T.inv.count(v2.inv, egg) / o.sell.n), 4);
    while (k > 0 && !T.inv.canFit(m.inv, [{ id: egg, n: o.sell.n * k }], [{ id: em, n: o.buy[0].n * k }])) k--;
    while (k > 0 && !canCook(m, o.sell.n * k + count(m, EGG()), myEm - o.buy[0].n * k)) k--;   // only eggs it can cook: fuel money kept back
    if (k < 1) continue;
    const price = o.buy[0].n / per;
    if (!best || price < best.price) best = { seller: v2, offer: o, times: k, price, item: egg, egg: true };
  }
  return best;
}

// ---------------------------------------------------------------- at the furnace
// Takes the cooked eggs (and all the fuel left) out; `all`: also the raw eggs it put in (it gives up). Logs what it cooked.
function finish(m, deal, all) {
  const f = deal.furnace, got = FU.empty(m, deal, all) || [];
  const cooked = got.filter(e => e.id === COOKED()).reduce((a, e) => a + e.n, 0);
  deal.cooked = cooked;
  log("collect", m, { got: got.map(e => e.n + " " + BF.itemName(e.id)).join(", ") || "nothing", at: FU.pk(f.x, f.y, f.z), loaded: deal.loaded || 0 });
  if (cooked > 0) vlog(m, "furnace", "cooked " + cooked + " egg" + (cooked === 1 ? "" : "s") + " in the furnace at " + FU.pk(f.x, f.y, f.z));
}
// The next errand: {kind: "cook", furnace, rawId, outId, n, fuelOk}, a fuel purchase {kind: "buy", ...}, or null.
function nextTrip(m) {
  const n = toCook(m);
  if (!n) return null;
  const p = cookPlan(m, n, ems(m));
  if (!p) return null;
  if (p.need) return FU.findDeal(m, p.need, skipOffer(state(m)));
  return { kind: "cook", furnace: p.furnace, rawId: EGG(), outId: COOKED(), n, fuelOk: fuelOk(m) };
}

// ---------------------------------------------------------------- AI
// Villager AI step (mobs.js villagerAI, daytime). cont: only carry on an errand under way. Returns true while it steers.
function ai(m, dt, out, cont) {
  if (cont && !(m.eggc && m.eggc.stage)) return false;
  if (!m.inv || m.dead || m.child || m.type !== "villager" || !BF.mobs || !BF.mobs.nav || !m.village || EGG() == null || COOKED() == null) return false;
  const S = state(m), a = m.ai;
  if (skyT() >= WORK_END || m.tradingWith) {
    if (S.stage) { if (S.deal && S.deal.kind === "cook" && S.deal.loaded) finish(m, S.deal, true); S.stage = null; S.deal = null; a.route = null; }
    return false;
  }
  if (!S.stage) {
    if (cont) return false;
    S.checkT -= dt;
    if (S.checkT > 0) return false;
    S.checkT = CHECK;
    if (S.cd > dayNow()) return false;
    const deal = nextTrip(m);
    if (!deal) { S.cd = dayNow() + 0.03; return false; }
    S.deal = deal; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
  }
  const deal = S.deal;
  const giveUp = (why, key) => {
    log("giveup", m, { kind: deal.kind, why });
    if (key) S.avoid[key] = dayNow() + 0.05;
    if (deal.kind === "cook" && deal.loaded) finish(m, deal, true);
    S.stage = null; S.deal = null; a.route = null; S.checkT = 0.5; return false;
  };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  if (deal.kind === "cook") {
    const s = deal.furnace, fkey = "f:" + FU.pk(s.x, s.y, s.z), near = FU.beside(s);
    const go = () => FU.travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, near, "egg");
    if (S.stage === "walk") {
      if (S.walkT > 90) return giveUp("timeout", fkey);
      if (!FU.usable(m, s, deal.rawId, deal.outId)) return giveUp("furnace busy", fkey);
      const st = go();
      if (st === "failed") return giveUp("no path", fkey);
      if (st === "arrived") { S.stage = "work"; S.tt = TRADE_PAUSE; S.waitT = 0; }
      return true;
    }
    if (S.stage === "cook" && Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) > 3) {   // pulled away (a zombie): back to the furnace
      if (go() === "failed") { FU.inUse.delete(FU.pk(s.x, s.y, s.z)); log("giveup", m, { kind: "cook", why: "cannot get back", left: deal.loaded }); S.stage = null; S.deal = null; a.route = null; return false; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.4 };
    if (S.stage === "work") {
      if ((S.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
      const n = FU.load(m, deal, deal.n);
      if (!n) return giveUp("furnace busy", fkey);
      S.stage = "cook";
      const st = INV().furnaceState(s.x, s.y, s.z);
      log("load", m, { eggs: n, at: FU.pk(s.x, s.y, s.z), ownFuel: deal.ownFuel || 0, fuelThere: !!(st.burn > 0 || st.slots[1]) });
      return true;
    }
    // cooking: wait beside it (adding fuel when the furnace runs dry), then empty it
    const st = INV().furnaceState(s.x, s.y, s.z);
    if (!st || !BF.isFurnace(BF.world.getBlock(s.x, s.y, s.z))) { FU.inUse.delete(FU.pk(s.x, s.y, s.z)); return giveUp("furnace gone", fkey); }
    S.waitT += dt;
    if (!st.slots[0] || st.slots[0].id !== deal.rawId) { finish(m, deal, false); S.stage = null; S.deal = null; S.checkT = 0.5; return true; }   // all cooked
    FU.topUp(m, deal, st);
    if (S.waitT > FU.COOK * 1.5 * deal.loaded + 40 || (st.burn <= 0 && !st.slots[1] && S.waitT > 3)) return giveUp(st.burn <= 0 && !st.slots[1] ? "out of fuel" : "too slow");
    if (Math.random() < dt * 0.5) a.swingT = 0.2;
    return true;
  }
  // buying fuel
  const v2 = deal.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + deal.item;
  if (!FU.canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage === "walk") {
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "egg") a.route = null; S.gx = g.x; S.gz = g.z; }
    if (FU.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3, null, "egg") === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const done = FU.doBuy(m, deal);
    S.stage = null; S.deal = null; S.gx = null; S.checkT = 0.5;
    if (done) log("buy", m, { from: v2.profession, got: done * deal.offer.sell.n + " " + BF.itemName(deal.item) });
    else { S.avoid[key] = dayNow() + 0.05; log("giveup", m, { kind: "buy", why: "trade refused" }); }
  }
  return true;
}
FU.busyWhen(u => !!(u.eggc && u.eggc.stage === "cook"));   // it holds the furnace while its eggs cook

// Status line (js/villagerstatus.js): what it is doing about its eggs, or "".
function statusText(m) {
  const S = m && m.eggc;
  if (!S || !S.stage || !S.deal) return "";
  if (S.deal.kind === "buy") return "Buying fuel to cook eggs";
  return S.stage === "cook" ? "Cooking eggs" : "Taking eggs to a furnace";
}

BF.eggCook = { WORK_END, BUY_BY, toCook, fuelOk, cookPlan, canCook, pending, eggDeal, nextTrip, finish, ai, statusText, LOG };
})();
