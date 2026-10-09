// Fletchers (BF.fletcher): the fletcher makes the arrows and bows it sells from materials it buys from the other villagers of its village.
// Nothing appears from the daily restock any more (trading.js PRODUCE.fletcher is empty).
// - Recipes: the vanilla ones (inventory.js): flint over stick over feather -> 4 arrows; 3 sticks + 3 string -> 1 bow. Sticks are cut from
//   2 planks (-> 4 sticks) when it is short of sticks.
// - What to make: arrows while it holds fewer than ARROW_MAX (4 at a time), bows while it holds fewer than BOW_MAX; the one whose stock is
//   emptier (against its cap) first. A fletcher missing an ingredient just does not make that item.
// - Crafting: at its fletching table (BF.jobs "work" state), ARROW_HOURS (half a game hour) per 4 arrows, BOW_HOURS (1 game hour) per bow;
//   dt is simulation time, so crafting follows game time at any fast-forward speed. Materials are taken when it starts; the item is finished
//   on later visits if the day ends first (the craft in progress is saved with the villager, trading.js pack key "fl").
// - Buying: for the next ARROW_BATCH arrows and the bows it lacks it buys what it is short of: flint (the miner digs it out of gravel),
//   sticks or planks (the forester), feathers (the poultry keeper), string (the shepherd spins it from wool). It walks to the seller and trades
//   at the seller's own offer (stock and room rules of trading.js), like the toolsmith, from any villager of its village except wares that
//   seller gets from the daily restock (trading.js PRODUCE). It buys whatever it can get, even when another ingredient is not sold here.
// See CONTRACT.md "Fletchers".
(() => {
"use strict";
const BF = window.BF;
const TR = () => BF.trades;
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const dayLen = () => (BF.sky && BF.sky.dayLength) || 1200;

const ARROW_HOURS = 0.5, BOW_HOURS = 1;        // game hours per craft (4 arrows / 1 bow)
const secsOf = what => dayLen() * (what === "bow" ? BOW_HOURS : ARROW_HOURS) / 24;
const ARROW_MAX = 48, BOW_MAX = 2;             // it makes arrows / bows while it holds fewer than this
const ARROWS_PER = 4, BOW_STICKS = 3, BOW_STRING = 3;
const ARROW_BATCH = 16;                        // it buys materials for this many arrows at a time
const WORK_END = 0.45, TRADE_PAUSE = 1.6;
const LOG = [];

const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const I = n => BF.I[n];
const isPlanks = id => { const n = nameOf(id); return n === "planks" || /_planks$/.test(n); };
const is = n => id => id != null && id === I(n);
const MAT = { flint: is("flint"), feather: is("feather"), string: is("string"), stick: is("stick"), planks: isPlanks };
const sum = (m, f) => { let n = 0; for (const s of m.inv) if (s && f(s.id)) n += s.count; return n; };
const count = (m, id) => TR().inv.count(m.inv, id);
const ems = m => count(m, I("emerald"));
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: "fletcher" + (m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };
const state = m => m.flt || (m.flt = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0, craft: null });
const vlog = (m, kind, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, kind, (BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Fletcher") + " (Fletcher) " + text, m); };
const avoided = (S, k) => (S.avoid[k] || 0) > dayNow();
// Takes n items matching f, the biggest stacks first. Returns [{id, n}] taken.
function take(m, f, n) {
  const got = [];
  while (n > 0) {
    let best = null;
    for (const s of m.inv) if (s && f(s.id) && (!best || s.count > best.count)) best = s;
    if (!best) break;
    const id = best.id, k = TR().inv.remove(m.inv, id, Math.min(n, best.count));
    n -= k; const g = got.find(e => e.id === id); if (g) g.n += k; else got.push({ id, n: k });
  }
  return got;
}

// ---------------------------------------------------------------- what to make
const arrows = m => count(m, I("arrow")), bows = m => count(m, I("bow"));
// Sticks in hand, counting what its planks would make (2 planks -> 4 sticks).
const sticksPossible = m => sum(m, MAT.stick) + 4 * Math.floor(sum(m, MAT.planks) / 2);
const wants = (m, what) => (what === "bow" ? I("bow") != null && bows(m) < BOW_MAX : I("arrow") != null && arrows(m) + ARROWS_PER <= ARROW_MAX);
// Can it make `what` from what it holds right now (and store the result)?
function canMake(m, what) {
  if (what === "bow") return sum(m, MAT.string) >= BOW_STRING && sticksPossible(m) >= BOW_STICKS && TR().inv.canFit(m.inv, [{ id: I("bow"), n: 1 }], [{ id: I("string"), n: BOW_STRING }]);
  return sum(m, MAT.flint) >= 1 && sum(m, MAT.feather) >= 1 && sticksPossible(m) >= 1 && TR().inv.canFit(m.inv, [{ id: I("arrow"), n: ARROWS_PER }], []);
}
// The emptier stock (against its cap) first.
const order = m => ["bow", "arrow"].sort((a, b) => (a === "bow" ? bows(m) / BOW_MAX : arrows(m) / ARROW_MAX) - (b === "bow" ? bows(m) / BOW_MAX : arrows(m) / ARROW_MAX));
// What it is short of for the next ARROW_BATCH arrows and the bows it lacks: {flint, feather, string, stick} (0 = enough).
function shortfall(m) {
  const crafts = wants(m, "arrow") ? Math.floor(Math.min(ARROW_BATCH, ARROW_MAX - arrows(m)) / ARROWS_PER) : 0;
  const nb = wants(m, "bow") ? BOW_MAX - bows(m) : 0;
  return {
    flint: Math.max(0, crafts - sum(m, MAT.flint)), feather: Math.max(0, crafts - sum(m, MAT.feather)),
    string: Math.max(0, BOW_STRING * nb - sum(m, MAT.string)), stick: Math.max(0, crafts + BOW_STICKS * nb - sticksPossible(m)),
  };
}

// ---------------------------------------------------------------- sellers (as js/toolsmith.js)
const canSell = (m, v2) => v2 && v2 !== m && v2.type === "villager" && !v2.dead && !v2.removed && !v2.child && Array.isArray(v2.inv) && Array.isArray(v2.trades)
  && !v2.sleeping && !v2.tradingWith && v2.position && v2.position.y > m.position.y - 6;   // not deep in a mineshaft
const restocked = (v2, id) => ((TR().PRODUCE[v2.profession] || []).includes(nameOf(id)));
// Offers of m's village that sell an item matching f, in stock, which m can pay for: [{v2, o, max}] (max = how many times), the nearest first.
function offersFor(m, f) {
  const R = m.village, T = TR(), S = state(m), out = [];
  if (!R) return out;
  for (const v2 of R.members || []) {
    if (!canSell(m, v2)) continue;
    for (const o of v2.trades) {
      if (o.feed || !f(o.sell.id) || restocked(v2, o.sell.id) || T.blockReason(v2, o)) continue;
      if (avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id)) continue;
      let k = Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n);
      for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
      if (k < 1) continue;
      out.push({ v2, o, max: k, d: v2.position ? v2.position.distanceTo(m.position) : Infinity });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
// A buying deal for need {what, f, n}: {kind: "buy", other, offer, times, item, what}, the nearest seller, or null.
function findDeal(m, need) {
  const T = TR();
  for (const e of offersFor(m, need.f)) {
    let k = Math.min(e.max, Math.ceil(need.n / e.o.sell.n), 4);
    while (k > 0 && !T.inv.canFit(m.inv, [{ id: e.o.sell.id, n: e.o.sell.n * k }], e.o.buy.map(b => ({ id: b.id, n: b.n * k })))) k--;
    if (k > 0) return { kind: "buy", other: e.v2, offer: e.o, times: k, item: e.o.sell.id, what: need.what };
  }
  return null;
}
function doBuy(m, deal) {
  const T = TR(), v2 = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(m, v2) || T.blockReason(v2, o)) break;
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

// ---------------------------------------------------------------- the plan
// {what, ready} (materials in hand: go craft), {crafting} (a craft in progress), or null.
function plan(m) {
  if (!m || !m.inv) return null;
  const S = state(m);
  if (S.craft) return { crafting: true };
  for (const what of order(m)) if (wants(m, what) && canMake(m, what)) return { what, ready: true };
  return null;
}
// A material to buy now, {what, f, n}, that a villager of its village sells and it can pay for, or null. Also while it can make the
// other item: string for bows is bought even while it is busy with arrows.
function buyNeed(m) {
  if (!m || !m.inv || ems(m) < 1) return null;
  const short = shortfall(m);
  // string and flint first (the scarcer wares), then feathers, then sticks (or planks to cut)
  for (const k of ["string", "flint", "feather", "stick"]) {
    if (!short[k]) continue;
    const need = { what: k, f: MAT[k], n: short[k] };
    if (findDeal(m, need)) return need;
    if (k === "stick") { const np = { what: "stick", f: MAT.planks, n: 2 * Math.ceil(short.stick / 4) }; if (findDeal(m, np)) return np; }
  }
  return null;
}

// ---------------------------------------------------------------- crafting at the fletching table
// Starts `what`: takes the materials (cuts sticks from planks first when short). Returns the craft record or null.
function startCraft(m, what) {
  const T = TR().inv, S = state(m);
  if (!wants(m, what) || !canMake(m, what)) return null;
  const sticks = what === "bow" ? BOW_STICKS : 1;
  if (sticks > count(m, I("stick"))) {
    const cuts = Math.ceil((sticks - count(m, I("stick"))) / 4);
    if (!T.canFit(m.inv, [{ id: I("stick"), n: 4 * cuts }], [])) return null;
    take(m, MAT.planks, 2 * cuts); T.add(m.inv, I("stick"), 4 * cuts);
  }
  const mats = what === "bow" ? take(m, MAT.string, BOW_STRING).concat(take(m, MAT.stick, BOW_STICKS))
    : take(m, MAT.flint, 1).concat(take(m, MAT.stick, 1), take(m, MAT.feather, 1));
  S.craft = { id: I(what), n: what === "bow" ? 1 : ARROWS_PER, t: secsOf(what), mats };
  log("start", m, { item: what });
  return S.craft;
}
// Finishes the craft in progress when its time is up and the result fits. Returns true when it was made.
function finishCraft(m) {
  const S = state(m), c = S.craft;
  if (!c || c.t > 0) return false;
  if (!TR().inv.canFit(m.inv, [{ id: c.id, n: c.n }], [])) return false;
  TR().inv.add(m.inv, c.id, c.n);
  S.craft = null;
  log("craft", m, { made: c.n + " " + nameOf(c.id) });
  vlog(m, "craft", c.n > 1 ? "made " + c.n + " " + BF.itemName(c.id).toLowerCase() + "s" : "made a " + BF.itemName(c.id).toLowerCase());
  return true;
}
// Called by jobs.js while the fletcher stands at its fletching table: works on the item in hand, starts the next one.
function work(m, J, dt) {
  const S = state(m);
  if (!S.craft) {
    const p = plan(m);
    if (p && p.ready && (!J || J.t >= 3 || !buyNeed(m))) startCraft(m, p.what);   // at the end of a sitting a seller with what it lacks comes first
  }
  if (S.craft) {
    S.craft.t -= dt;
    if (m.ai && Math.random() < dt * 1.2) m.ai.swingT = 0.3;   // whittling, fletching
    if (S.craft.t <= 0) finishCraft(m);
    if (J && J.t < 3 && (S.craft || ((plan(m) || {}).ready && !buyNeed(m)))) J.t = 3;   // stays while there is work at the table, unless a seller has what it lacks: it goes shopping after this one
  }
}
// jobs.js asks this to bring the next visit to the table forward (not while a seller has what it lacks: it shops first).
const wantsJob = m => { if (!m || m.profession !== "fletcher") return false; const S = state(m); return !!S.craft || (!!(plan(m) || {}).ready && !buyNeed(m)); };

// ---------------------------------------------------------------- trips
function travel(m, st, dt, out, tx, ty, tz, speed, near) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z;
  if (near ? near(...N.feetCell(m)) : Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) <= 1.75 && Math.abs(ty - m.position.y) < 1.6) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "flt") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const goal = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: near || ((x, y, z) => Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1) };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "flt"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}
// The next trip: {kind: "buy" | "table", ...} or null. Never while it is at (or on its way to) the table: shopping waits for the next break.
function nextTrip(m) {
  if (m.job && (m.job.mode === "work" || m.job.mode === "go")) return null;
  const need = buyNeed(m);
  if (need) { const deal = findDeal(m, need); if (deal) return deal; }
  const p = plan(m), J = m.jobsite;
  // something to make but far from its table (jobs.js only sends villagers within 40 blocks to their jobsite): walk back first
  if (p && J && Math.hypot(J.x + 0.5 - m.position.x, J.z + 0.5 - m.position.z) > 24) return { kind: "table", spot: { x: J.x, y: J.y, z: J.z } };
  return null;
}
// Villager AI step (mobs.js villagerAI, daytime): trips to buy materials. Returns true while it steers.
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.profession !== "fletcher" || !BF.mobs || !BF.mobs.nav || !m.village) return false;
  const S = state(m), a = m.ai;
  if (skyT() >= WORK_END || m.tradingWith) { if (S.stage) { S.stage = null; S.deal = null; a.route = null; } return false; }
  if (!S.stage) {
    S.checkT -= dt;
    if (S.checkT > 0) return false;
    S.checkT = 4;
    if (S.cd > dayNow()) return false;
    const deal = nextTrip(m);
    if (!deal) { S.cd = dayNow() + 0.03; return false; }
    S.deal = deal; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
  }
  const deal = S.deal;
  const giveUp = (why, key) => {
    log("giveup", m, { kind: deal.kind, item: deal.item != null ? BF.itemName(deal.item) : deal.kind, why });
    if (key) S.avoid[key] = dayNow() + 0.05;
    S.stage = null; S.deal = null; a.route = null; S.checkT = 0.5; return false;
  };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  if (deal.kind === "table") {   // back to the fletching table; jobs.js takes over from there
    const s = deal.spot;
    if (S.walkT > 90) return giveUp("timeout");
    const st = travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, (x, y, z) => Math.abs(x - s.x) + Math.abs(z - s.z) <= 3 && Math.abs(y - s.y) <= 2);
    if (st === "failed") return giveUp("no path");
    if (st === "arrived") { S.stage = null; S.deal = null; S.checkT = 2; if (m.job && m.job.mode === "off") m.job.t = Math.min(m.job.t, 0.5); }
    return true;
  }
  // buying
  const v2 = deal.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + deal.item;
  if (!canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage === "walk") {
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "flt") a.route = null; S.gx = g.x; S.gz = g.z; }
    const st = travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3);
    if (st === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const done = doBuy(m, deal);
    S.stage = null; S.deal = null; S.gx = null; S.checkT = 0.5;
    if (!done) { S.avoid[key] = dayNow() + 0.05; log("giveup", m, { kind: "buy", item: BF.itemName(deal.item), why: "trade refused" }); }
  }
  return true;
}

// Trade screen / debug status: what it is doing right now, or "".
function statusText(m) {
  if (!m || m.profession !== "fletcher") return "";
  const S = m.flt;
  if (S && S.stage && S.deal) return S.deal.kind === "table" ? "Going back to the fletching table" : "Buying " + (S.deal.what === "stick" && isPlanks(S.deal.item) ? "planks" : BF.itemName(S.deal.item).toLowerCase());
  if (S && S.craft) return (m.job && m.job.mode === "work" ? "Making " : "Will finish ") + (S.craft.n > 1 ? "arrows" : "a bow");
  return "";
}

// ---------------------------------------------------------------- persistence (trading.js pack / unpack, key "fl")
function pack(m) {
  const S = m.flt;
  if (!S || !S.craft || !BF.items[S.craft.id]) return undefined;
  return { c: [nameOf(S.craft.id), S.craft.n, Math.max(0, Math.round(S.craft.t)), S.craft.mats.map(e => [nameOf(e.id), e.n])] };
}
function unpack(m, o) {
  if (!o || typeof o !== "object" || !Array.isArray(o.c)) return;
  const S = state(m), id = I(o.c[0]), n = Math.max(1, Math.floor(+o.c[1] || 1));
  const mats = (Array.isArray(o.c[3]) ? o.c[3] : []).map(e => ({ id: I(e[0]), n: Math.floor(e[1]) })).filter(e => e.id != null && e.n > 0);
  if (id != null) S.craft = { id, n, t: Math.max(0, +o.c[2] || 0), mats };
  else for (const e of mats) TR().inv.add(m.inv, e.id, e.n);   // the item no longer exists: the materials come back
}

// Starting pack (trading.js stockFor): no arrows or bows (it makes them), a few sticks, flint and feathers for its first arrows.
function seed(a) {
  const T = TR().inv;
  for (const n of ["arrow", "bow"]) if (I(n) != null) T.remove(a, I(n), 999);
  for (const [n, k] of [["stick", 8], ["flint", 4], ["feather", 4]]) if (I(n) != null && T.count(a, I(n)) < k) T.add(a, I(n), k - T.count(a, I(n)));
}

BF.fletcher = {
  ARROW_HOURS, BOW_HOURS, ARROW_MAX, BOW_MAX, ARROW_BATCH, ARROWS_PER, BOW_STICKS, BOW_STRING,
  plan, buyNeed, canMake, shortfall, startCraft, finishCraft, work, wantsJob, offersFor, findDeal, doBuy, nextTrip, ai, statusText, pack, unpack, seed, LOG,
};
})();
