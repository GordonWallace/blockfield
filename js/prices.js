// Prices follow demand (release 1.3): every villager's emerald offers drift with shortage and surplus, for the player and villagers alike.
// A price is a step from -30 to +30 on top of the offer's base (its trade table entry); a step multiplies the price by 2^(1/30), about 2.3%,
// so 30 steps double it and -30 halve it, and a game month (30 days) of shortage or glut gets there.
//   buy offers (the villager pays emeralds for goods): unfilled for a day while it could pay and has room -> one step up (it offers more).
//   sell offers (the villager sells a ware for emeralds): the ware sat at its stock cap with no sale for a day -> one step down.
//   each trade that fills an offer moves it 3 steps back toward base.
// Prices only change at the daily tick (and when the trade screen opens), never in the middle of a trade, so every trade site and the Economy
// view (js/economy.js) see the price that was actually paid. Floors: a villager never buys an item for more than it sells it for itself, never
// sells it for less than it buys it, and never buys above the cheapest base price any villager charges for it (the builder's rule, for all).
// Offers without a single emerald side (barter, two-item payments), the explorer's maps and the hungry unemployed's food offers keep fixed prices.
// API: BF.prices = { STEPS, STEP, FILL, kind(o), step(o), mult(o), tick(v, day), filled(v, o, times), reprice(v, o), pack(v), unpack(v, pr, pd), off }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const STEPS = 30;                  // steps to double (or halve): a game month of days
const STEP = Math.pow(2, 1 / STEPS);
const FILL = 3;                    // steps back toward base per filled trade
const CATCH_UP = 2 * STEPS;        // days replayed at most for a villager that was away (more cannot change anything)

const T = () => BF.trades;
const em = () => BF.I.emerald;
const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const day = () => (BF.sky ? BF.sky.day || 0 : 0);

// "buy": the villager pays emeralds for goods; "sell": it sells a ware for emeralds; null: fixed price.
function kind(o) {
  if (!o || o.dyn || o.feed || !o.sell || !Array.isArray(o.buy) || o.buy.length !== 1) return null;
  const e = em(), b = o.buy[0];
  if (o.sell.id === e && b.id !== e) return "buy";
  if (b.id === e && o.sell.id !== e) return "sell";
  return null;
}
// The offer's base amounts [paid, received], remembered the first time its price moves.
const baseOf = o => o.base || [o.buy[0].n, o.sell.n];
// Emeralds per item at base: [emeralds, items].
function baseUnit(o) {
  const [p, r] = baseOf(o);
  return kind(o) === "buy" ? r / p : p / r;
}
const unit = o => kind(o) === "buy" ? o.sell.n / o.buy[0].n : o.buy[0].n / o.sell.n;
const wareOf = o => kind(o) === "buy" ? o.buy[0].id : o.sell.id;

// Cheapest base price per item any villager's table charges (emeralds per item), by item id.
let cheapCache = null;
function cheapest(id) {
  if (!cheapCache) {
    cheapCache = new Map();
    for (const prof in T().TRADES) for (const pool of T().table(prof)) for (const o of pool) {
      if (kind(o) !== "sell") continue;
      const u = o.buy[0].n / o.sell.n, c = cheapCache.get(o.sell.id);
      if (c == null || u < c) cheapCache.set(o.sell.id, u);
    }
  }
  return cheapCache.get(id);
}
// The villager's own current price for an item on its other side (emeralds per item), or null.
function own(v, id, k) {
  let best = null;
  for (const o of v.trades || []) {
    if (kind(o) !== k || wareOf(o) !== id) continue;
    const u = unit(o);
    if (best == null || (k === "sell" ? u < best : u > best)) best = u;   // its cheapest sell price, its highest buy price
  }
  return best;
}

// Sets the offer's amounts for its step: the side that is a count of items (the bigger side) moves, the other stays at base,
// rounded to whole items and emeralds; then the floors are applied.
function reprice(v, o) {
  const k = kind(o);
  if (!k) return o;
  const s = o.step || 0;
  if (!s && !o.base) return o;
  if (!o.base) o.base = baseOf(o);
  const [p0, r0] = o.base;
  const E = k === "buy" ? r0 : p0, W = k === "buy" ? p0 : r0, ware = wareOf(o);
  const u0 = E / W;
  let lo = u0 / 2, hi = u0 * 2;
  if (k === "buy") {            // never pays more than it sells for itself, or than the cheapest seller asks (unless its base already does)
    const mine = v && own(v, ware, "sell"), ch = cheapest(ware);
    if (mine != null) hi = Math.min(hi, Math.max(u0, mine));
    if (ch != null) hi = Math.min(hi, Math.max(u0, ch * 0.999));
  } else {                      // never sells for less than it buys for itself
    const mine = v && own(v, ware, "buy");
    if (mine != null) lo = Math.max(lo, Math.min(u0, mine));
  }
  const u = Math.min(hi, Math.max(lo, u0 * Math.pow(STEP, s)));
  let e = E, w = W;
  if (W >= E) w = Math.max(1, Math.min(stackOf(ware), Math.round(E / u)));
  else e = Math.max(1, Math.min(stackOf(em()), Math.round(W * u)));
  // rounding must not cross a floor
  for (let g = 0; g < 64 && e / w > hi + 1e-9; g++) { if (W >= E) { if (w >= stackOf(ware)) break; w++; } else { if (e <= 1) break; e--; } }
  for (let g = 0; g < 64 && e / w < lo - 1e-9; g++) { if (W >= E) { if (w <= 1) break; w--; } else e++; }
  if (k === "buy") { o.buy[0].n = w; o.sell.n = e; } else { o.buy[0].n = e; o.sell.n = w; }
  return o;
}
const step = o => o.step || 0;
const mult = o => Math.pow(STEP, step(o));

// Records trades that filled an offer; the price moves back toward base at the next tick.
function filled(v, o, times = 1) {
  if (!v || !o || !kind(o) || !(v.trades || []).includes(o)) return;
  o.fills = (o.fills || 0) + Math.max(1, times | 0);
}

// Did the offer have demand it couldn't meet (buy) or a glut it couldn't sell (sell) today?
function pressure(v, o, k) {
  const I = T().inv;
  if (k === "buy") return I.count(v.inv, em()) >= o.sell.n && I.canFit(v.inv, o.buy, [o.sell]);
  const cap = T().profile(v.profession).caps.get(o.sell.id);
  return cap != null && I.count(v.inv, o.sell.id) >= cap;
}

// The daily tick: replays the days since the villager's last tick (fills count on the first of them).
function tick(v, d) {
  if (!v || !Array.isArray(v.trades) || !Array.isArray(v.inv) || BF.prices.off) return false;
  if (d == null) d = day();
  if (v.priceDay == null || d < v.priceDay) { v.priceDay = d; return false; }
  const n = Math.min(d - v.priceDay, CATCH_UP);
  if (n <= 0) return false;
  v.priceDay = d;
  let moved = false;
  for (const o of v.trades) {
    const k = kind(o);
    if (!k) continue;
    const before = step(o);
    let s = before;
    for (let i = 0; i < n; i++) {
      if (i === 0 && o.fills > 0) { const back = Math.min(Math.abs(s), FILL * o.fills); s -= Math.sign(s) * back; continue; }
      if (!pressure(v, o, k)) continue;
      s = k === "buy" ? Math.min(STEPS, s + 1) : Math.max(-STEPS, s - 1);
    }
    o.fills = 0;
    if (s !== before) { if (!o.base) o.base = baseOf(o); o.step = s; moved = true; }
  }
  if (moved) for (const o of v.trades) if (o.base) reprice(v, o);   // floors depend on the villager's other prices
  return moved;
}

// Save: {offer key: step} for offers off base, and the day of the last tick. Keys use names, so item renumbering can't mix them up.
const keyOf = o => { const [p, r] = baseOf(o); return BF.items[o.buy[0].id].name + ":" + p + ">" + BF.items[o.sell.id].name + ":" + r; };
function pack(v) {
  const pr = {};
  for (const o of v.trades || []) if (kind(o) && o.step) pr[keyOf(o)] = o.step;
  return Object.keys(pr).length ? pr : undefined;
}
function unpack(v, pr, pd) {
  if (Number.isFinite(+pd)) v.priceDay = +pd;
  if (!pr || typeof pr !== "object" || !Array.isArray(v.trades)) return v;
  for (const o of v.trades) {
    if (!kind(o)) continue;
    const s = Math.round(+pr[keyOf(o)]);
    if (s) { o.base = baseOf(o); o.step = Math.max(-STEPS, Math.min(STEPS, s)); }
  }
  for (const o of v.trades) if (o.base) reprice(v, o);
  return v;
}

BF.prices = { STEPS, STEP, FILL, kind, step, mult, unit, baseUnit, cheapest, tick, filled, reprice, pack, unpack, off: false };
})();
