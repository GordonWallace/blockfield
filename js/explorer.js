// Explorer villagers (BF.explorer). Companion of js/maps.js (map items, explored pixels) and js/cartography.js (who makes the blank maps).
// - Spawning (mobs.js villageRoster): only in villages with cartographers, one explorer per cartographer with 70% probability. Jobsite: the survey table.
// - An explorer never starts with a map. With emeralds in its pocket it walks to a cartographer of its village that holds a blank map and buys it
//   (PRICE_BLANK emeralds by size, the cartographer's own prices in js/trading.js; stock and room rules of trading.js apply). It takes any size it can pay for, favouring small ones.
// - It uses the blank map where it stands: the map becomes the filled map of an 8x8-chunk zone near it (its own zone first, then the closest zone
//   that is not mapped yet), and it starts walking from one unexplored patch of the zone to the next. js/maps.js samples the world around it
//   (BF.maps.explore) so the shared zone data fills in exactly as if a player carried the map.
// - The map counts as filled only when every pixel is drawn (FILLED). It walks to the nearest blank pixel until none is left. When the blank
//   pixels left are out of reach (water, cliffs: a patch is given up after two failed walks), out of the loaded area for too long, or it has
//   walked one map for MAP_WORK_CAP, it shelves the map until the next day and tries again then. A shelved map is never sold.
//   Only chunks that are loaded can be mapped, so patches far from the player wait until the player comes near.
// - Filled maps are the explorer's wares: syncOffers() keeps one offer per filled map it carries (price in emeralds by map size).
// - Persistence: the maps are inventory items (saved by name, js/trading.js); `ex` in the villager pack holds the shelved maps.
(() => {
"use strict";
const BF = globalThis.BF;
const RS = e => BF.rand.of(e);   // seeded random streams (js/rand.js)
const rnd = (r, a, b) => r.range(a, b);
const T = () => BF.trades;

const PRICE_BLANK = [4, 8, 16, 32, 64];   // what the cartographer asks for a blank map by size (js/trading.js: "4 emerald > 1 blank_map_1" ...)
const SELL_PRICE = [7, 16, 36, 80, 176];  // emeralds the player pays for a filled map, by size: well over the blank price, and it grows faster (TRADE_AUDIT.md)
const IDLE_GIVE_UP = 180;                 // seconds of waiting for patches nobody has loaded before it settles for what it mapped
const FILLED = 1;                         // share of mapped pixels that counts as filled: all of them, it never sells a map with a blank in it
// patch size in map pixels: 16 on the two small maps, then about 32 blocks (the fill radius of js/maps.js shrinks to 16 blocks on the big ones)
const cellPx = size => (size <= 2 ? 16 : Math.max(2, Math.round(32 / BF.maps.scale(size))));
const MAP_WORK_CAP = 1500;                // seconds of exploring after which it settles for what it mapped (a size 5 map is ~130 km of walking)
const SIZE_WEIGHT = [16, 8, 4, 2, 1];     // which affordable size it buys: mostly small ones, they are the ones it can finish
const MAX_FOR_SALE = 2;                   // stops fetching maps once it carries this many (filled ones waiting for a buyer, or shelved ones)
const SAMPLE = 700;                       // pixel samples per call to BF.maps.explore, ~5 calls per second
const PLAYER_RANGE = 85;                  // without BF.villageSim (js/villagesim.js): patches further than this from the player are left alone (villagers despawn at 100)
const EDGE = 24;                          // a patch must have loaded terrain this far around it, so the explorer never stands at the edge of the loaded area (a villager on an unloaded chunk is removed)
const WORK_START = 0.03, WORK_END = 0.45; // sky.time window of the working day (same as js/cartography.js)
const TRADE_PAUSE = 1.6;
const LOG = [];
const nowS = () => BF.simNow();
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
// Village log (js/villagelog.js, kind "map"; INFO in the game log): maps finished, shelved and taken up again.
const mapText = c => "the size " + c.it.map.size + " map of zone " + c.it.map.zx + ", " + c.it.map.zz;
const vlog = (m, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, "map", BF.vlog.nameOf(m) + " (Explorer) " + text, m); };
const log = (kind, m, data) => { LOG.push(BF.glog.job("explorer", Object.assign({ kind, who: "explorer" + (m.slot ? "#" + m.slot.idx : "") }, data))); if (LOG.length > 200) LOG.shift(); };

// fin: shelved maps, name -> the game day it was shelved on (it tries again on a later day)
const state = m => m.ex || (m.ex = { fin: {}, avoid: {}, stage: null, target: null, cd: rnd(RS(m), 1, 4), sync: 0, sampT: 0 });
const today = () => (BF.sky ? BF.sky.day || 0 : 0);
const cnt = (m, id) => (id == null ? 0 : T().inv.count(m.inv, id));
const blankSlots = m => m.inv.filter(s => s && BF.items[s.id] && BF.items[s.id].mapSize);
const nameOf = it => it.name;

// ---------------------------------------------------------------- map data
const covCache = new WeakMap();
function coverage(d) {
  let c = covCache.get(d);
  if (c && c.ver === d.ver) return c.v;
  let n = 0;
  const px = d.px;
  for (let i = 0; i < px.length; i++) if (px[i]) n++;
  covCache.set(d, c = { ver: d.ver, v: n / px.length });
  return c.v;
}
const isFilled = d => coverage(d) >= FILLED;
// A map put aside today (blanks out of reach or not loaded, or worked too long): left alone until the next day, never sold.
const isShelved = (m, it, peek) => { const X = peek ? m.ex : state(m), f = X && X.fin[nameOf(it)]; return f !== undefined && f >= today(); };
// Filled-map items in the inventory: [{slot, it, d, done, shelved}]
// peek (the status line, which F3 and the debug screen read): changes nothing (making the explorer's state drew from its stream: a world
// with a screen watching played differently, 2026-10-30); a map whose data was never made is left out.
function carried(m, peek) {
  const out = [];
  m.inv.forEach((s, slot) => {
    const it = s && BF.items[s.id];
    if (!it || !it.map) return;
    const d = BF.maps.getData(it.map.size, it.map.zx, it.map.zz, !peek);
    if (!d) return;
    const done = isFilled(d);
    out.push({ slot, it, d, done, shelved: !done && isShelved(m, it, peek) });
  });
  return out;
}

// ---------------------------------------------------------------- offers
const priceOf = it => SELL_PRICE[Math.max(0, Math.min(SELL_PRICE.length - 1, it.map.size - 1))];
// One offer per filled map it carries: emeralds for the map. Replaces the previous list only when it changed.
function syncOffers(m) {
  if (!m || m.profession !== "explorer" || !m.inv || !Array.isArray(m.trades) || !BF.maps) return;
  const em = BF.I.emerald, seen = new Set(), dyn = [];
  for (const c of carried(m)) {
    if (!c.done || seen.has(c.it.id)) continue;
    seen.add(c.it.id);
    dyn.push({ buy: [{ id: em, n: priceOf(c.it) }], sell: { id: c.it.id, n: 1 }, level: 1, xp: T().TRADE_XP[0], dyn: 1 });
  }
  const sig = list => list.map(o => o.sell.id + ":" + o.buy[0].n).join("|");
  const old = m.trades.filter(o => o.dyn);
  if (sig(old) === sig(dyn)) return;
  m.trades = dyn.concat(m.trades.filter(o => !o.dyn));
}

// ---------------------------------------------------------------- using a blank map
function carriedNames(m) { return new Set(carried(m).map(c => c.it.name)); }
function useBlank(m) {
  const M = BF.maps, inv = T().inv, X = state(m), slot = blankSlots(m)[0];
  if (!slot) return false;
  const size = BF.items[slot.id].mapSize, held = carriedNames(m);
  const zones = [], PL = BF.planet, seenZ = new Set();
  const zx0 = M.zoneOf(m.position.x), zz0 = M.zoneOf(m.position.z);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    let zx = zx0 + dx, zz = zz0 + dz;
    // zones around it in its own frame, named by the face they really lie on (across an edge: the next face's zone)
    const c = PL.canon(M.centre(zx), M.centre(zz), ZC);
    if (c.off || c.wedge) continue;
    zx = M.zoneOf(c.x); zz = M.zoneOf(c.z);
    const nm = M.nameOf(size, zx, zz);
    if (seenZ.has(nm) || held.has(nm)) continue;
    seenZ.add(nm);
    const d = M.getData(size, zx, zz, false);
    if (d && coverage(d) >= FILLED) continue;
    const cz = { x: M.centre(zx), z: M.centre(zz) };
    zones.push({ zx, zz, nm, dist: PL.distance(m.position, cz) });
  }
  if (!zones.length) { X.cd = 60; return false; }
  zones.sort((a, b) => a.dist - b.dist);
  const z = zones[0], id = BF.resolveItem(z.nm);
  if (id === undefined || !inv.canFit(m.inv, [{ id, n: 1 }], [{ id: slot.id, n: 1 }])) { X.cd = 30; return false; }
  inv.remove(m.inv, slot.id, 1);
  inv.add(m.inv, id, 1);
  M.getData(size, z.zx, z.zz);
  X.stage = null; X.target = null; X.avoid = {}; delete X.fin[z.nm];
  log("use", m, { zone: z.zx + "," + z.zz, size });
  return true;
}

// ---------------------------------------------------------------- walking
// Same A* hops as js/cartography.js: long trips go in 20-block legs, the goal of a leg is a cell near the way point.
function travel(m, st, dt, out, tx, tz, speed, radius) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z, d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
  if (d <= radius) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "exp") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : [tx, tz];
    const goal = { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "exp"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= 4) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}

// ---------------------------------------------------------------- exploring
const ZC = {}, TF = {};
const inLoaded = (x, z) => { const W = BF.world; return W.isLoaded(x, z) && W.isLoaded(x + EDGE, z) && W.isLoaded(x - EDGE, z) && W.isLoaded(x, z + EDGE) && W.isLoaded(x, z - EDGE); };
// Next blank pixel of map `c` to visit: in each patch that still has blank pixels and has not been given up, the blank pixel nearest the explorer;
// of those, the nearest one that is loaded (and near the player). null + reason otherwise.
// How far from a blank pixel it stands to draw it: with the 6-block arrival radius, well inside the fill radius of js/maps.js (40 blocks on
// the smallest map, 16 on big ones), so a blank at the edge of the loaded area can be drawn from inside it.
const standOff = size => 0.5 * Math.max(16, 40 / Math.sqrt(BF.maps.scale(size)));
function pickTarget(m, c) {
  const M = BF.maps, d = c.d, X = state(m), s = M.scale(d.size), ox = M.originX(d.size, d.zx), oz = M.originX(d.size, d.zz);
  const PX = M.PX, CELL = cellPx(d.size), n = PX / CELL, pp = BF.player.position, PL = BF.planet;
  // distances to blank pixels are measured in the map's face frame (the explorer may stand across an edge)
  const myFace = PL.face(m.position.x, m.position.z), me = PL.inFrame(PL.face(M.centre(d.zx), M.centre(d.zz)), m.position.x, m.position.z, {});
  const mx = me ? me.x : m.position.x, mz = me ? me.z : m.position.z;
  let best = null, bd = Infinity, open = 0, avoided = 0;
  for (let cj = 0; cj < n; cj++) for (let ci = 0; ci < n; ci++) {
    let pi = -1, pd = Infinity;
    for (let j = cj * CELL; j < (cj + 1) * CELL; j++) for (let i = ci * CELL; i < (ci + 1) * CELL; i++) {
      if (d.px[j * PX + i]) continue;
      const dd = Math.hypot(ox + (i + 0.5) * s - mx, oz + (j + 0.5) * s - mz);
      if (dd < pd) { pd = dd; pi = j * PX + i; }
    }
    if (pi < 0) continue;                                     // patch fully drawn
    const k = c.it.name + ":" + ci + "," + cj;
    if ((X.avoid[k] || 0) >= 2) { avoided++; continue; }
    const px = ox + (pi % PX + 0.5) * s, pz = oz + (((pi / PX) | 0) + 0.5) * s, f = pd > 0 ? Math.min(pd, standOff(d.size)) / pd : 0;
    let wx = Math.floor(px + (mx - px) * f), wz = Math.floor(pz + (mz - pz) * f);   // where it stands: on its side of the pixel, close enough to draw it
    open++;
    // that spot (in the map's face frame) in the explorer's own frame, which may be the next face's
    const q = PL.inFrame(myFace, wx + 0.5, wz + 0.5, TF);
    if (!q) continue;
    wx = Math.floor(q.x); wz = Math.floor(q.z);
    if (!BF.world.isLoaded(Math.floor(px), Math.floor(pz)) || !inLoaded(wx, wz) || (!BF.villageSim && PL.distance(pp, { x: wx, z: wz }) > PLAYER_RANGE)) continue;
    if (pd < bd) { bd = pd; best = { ci, cj, wx, wz, k, pi }; }
  }
  return { best, open, avoided };
}
function exploreAI(m, c, dt, out) {
  const X = state(m), a = m.ai, M = BF.maps;
  X.sampT -= dt;
  if (X.sampT <= 0) { X.sampT = 0.2; M.explore(c.d, m.position.x, m.position.z, SAMPLE, X); }   // (its own sampling place, X.cur: js/maps.js explore)
  if (isFilled(c.d)) { finish(m, c); return false; }
  X.work = X.work || {};
  if ((X.work[c.it.name] = (X.work[c.it.name] || 0) + dt) > MAP_WORK_CAP) { shelve(m, c, "time"); return false; }
  if (!X.target) {
    X.pickT = (X.pickT || 0) - dt;
    if (X.pickT > 0) return false;
    X.pickT = 1;
    const p = pickTarget(m, c);
    if (!p.best) {
      if (!p.open && p.avoided) shelve(m, c, "unreachable");                          // only blanks out of reach are left
      else if (!p.open) finish(m, c);
      else {                                                                           // blanks exist but nobody has loaded them: wait for the player
        X.pickT = 4; X.idleS = (X.idleS || 0) + 4;
        if (X.idleS >= IDLE_GIVE_UP) { X.idleS = 0; shelve(m, c, "out of range"); }
      }
      return false;
    }
    X.target = p.best; X.walkT = 0; X.dwell = 0; X.idleS = 0; a.route = null;
  }
  const t = X.target;
  a.mode = "idle"; a.t = 2; X.stage = "explore";
  if (X.dwell > 0) {                                  // standing on the patch: look around while the map fills in
    X.dwell -= dt;
    if (X.dwell <= 0) {
      if (!c.d.px[t.pi]) X.avoid[t.k] = (X.avoid[t.k] || 0) + 1;
      X.target = null; X.pickT = 0;
    }
    return true;
  }
  X.walkT += dt;
  const giveUp = () => { X.avoid[t.k] = (X.avoid[t.k] || 0) + 1; X.target = null; a.route = null; X.pickT = 0.5; return false; };
  if (X.walkT > 90 || !BF.world.isLoaded(t.wx, t.wz)) return giveUp();
  const r = travel(m, X, dt, out, t.wx, t.wz, m.def.speed * 1.2, 6);
  if (r === "failed") return giveUp();
  if (r === "arrived") X.dwell = 1.5;
  return true;
}
// Every pixel drawn: the map goes on sale.
function finish(m, c) {
  const X = state(m);
  X.target = null; X.stage = null; X.avoid = {}; delete X.fin[c.it.name];
  if (X.work) delete X.work[c.it.name];
  log("filled", m, { map: c.it.name, coverage: +coverage(c.d).toFixed(3) });
  vlog(m, "finished " + mapText(c) + ", every pixel drawn, and put it on sale for " + priceOf(c.it) + " emeralds");
  syncOffers(m);
}
// Blanks left that it cannot draw today: puts the map aside until the next day (a fresh start then: patches given up and walking time reset).
function shelve(m, c, why) {
  const X = state(m);
  X.target = null; X.stage = null; X.avoid = {}; X.fin[c.it.name] = today();
  if (X.work) delete X.work[c.it.name];
  const blank = c.d.px.length - Math.round(coverage(c.d) * c.d.px.length);
  log("shelved", m, { map: c.it.name, why, coverage: +coverage(c.d).toFixed(3), blank });
  vlog(m, "put aside " + mapText(c) + " with " + blank + " blank pixel" + (blank === 1 ? "" : "s") + " (" + why + "), not for sale until it is complete; tries again tomorrow");
}

// ---------------------------------------------------------------- fetching a blank map from a cartographer
const canSell = v2 => v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && Array.isArray(v2.inv) && Array.isArray(v2.trades);
// The blank map it would buy from v2: one of v2's own offers (its job's, or its spare goods, js/market.js) selling a blank map it can pay
// for, drawn with weights favouring small ones (SIZE_WEIGHT), from the buyer m's stream (spec r15-33: a mob draws only from its own). A
// villager with blank maps but no offer for them is passed by: every trade is an offer the player could take too.
function offerFor(v2, emeralds, m) {
  const I = BF.I, opts = [];
  for (const o of (v2 && v2.trades) || []) {
    if (o.buy.length !== 1 || o.buy[0].id !== I.emerald || o.buy[0].n > emeralds || o.sell.n !== 1) continue;
    const k = [1, 2, 3, 4, 5].find(n => I["blank_map_" + n] === o.sell.id);
    if (k && cnt(v2, o.sell.id) >= 1) opts.push({ o, w: SIZE_WEIGHT[k - 1] });
  }
  if (!opts.length) return null;
  let r = RS(m || v2).next() * opts.reduce((a, q) => a + q.w, 0), pick = opts[0];
  for (const q of opts) { pick = q; if ((r -= q.w) <= 0) break; }
  return pick.o;
}
function findCartographer(m, X) {
  const R = m.village;
  if (!R) return null;
  let best = null, bd = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2) || (X.avoidSeller && X.avoidSeller.get(v2.id) > nowS())) continue;
    const o = offerFor(v2, cnt(m, BF.I.emerald), m);
    if (!o || T().blockReason(v2, o) || !T().inv.canFit(m.inv, [o.sell], o.buy)) continue;
    const d = v2.position.distanceTo(m.position);
    if (d < bd) { bd = d; best = BF.ids.refs({ seller: v2, offer: o }); }
  }
  return best;
}
function deal(m, dl) {
  const t = T(), v2 = dl.seller, o = dl.offer;
  if (!t.asked(m, v2, o) && (!canSell(v2) || cnt(m, BF.I.emerald) < o.buy[0].n || !t.inv.canFit(m.inv, [o.sell], o.buy))) return false;
  const done = t.buy(m, v2, o, 1, { guard: () => (canSell(v2) ? null : "busy") });   // one transaction (js/trading.js buy)
  if (done == null) return null;
  if (!done) return false;
  log("buy", m, { from: v2.profession, got: BF.items[o.sell.id].name, paid: o.buy[0].n + " emerald" });
  return true;
}
function shopAI(m, dt, out) {
  const X = state(m), a = m.ai;
  if (!X.stage || X.stage === "explore") {
    X.stage = null;
    X.cd -= dt;
    if (X.cd > 0) return false;
    X.cd = 4;
    if (blankSlots(m).length || carried(m).filter(c => c.done || c.shelved).length >= MAX_FOR_SALE || cnt(m, BF.I.emerald) < PRICE_BLANK[0]) return false;
    const dl = findCartographer(m, X);
    if (!dl) { X.cd = rnd(RS(m), 15, 30); return false; }
    X.deal = dl; X.stage = "walk"; X.walkT = 0; a.route = null;
  }
  const dl = X.deal, v2 = dl && dl.seller;
  const giveUp = () => { if (v2) (X.avoidSeller || (X.avoidSeller = new Map())).set(v2.id, nowS() + 60); X.stage = null; X.deal = null; a.route = null; X.cd = 5; return false; };
  if (!v2 || !canSell(v2) || !offerFor(v2, cnt(m, BF.I.emerald), m)) return giveUp();
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (BF.mobs.waitFor) BF.mobs.waitFor(v2, m, d);   // the seller stops for its buyer (bug-054)
  a.mode = "idle"; a.t = 2;
  if (X.stage === "walk") {
    X.walkT += dt;
    if (X.walkT > 60) return giveUp();
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { X.stage = "trade"; X.tt = TRADE_PAUSE; a.route = null; return true; }
    const r = travel(m, X, dt, out, Math.floor(v2.position.x), Math.floor(v2.position.z), m.def.speed * 1.3, 1.75);
    if (r === "failed") return giveUp();
    if (r === "arrived") { X.stage = "trade"; X.tt = TRADE_PAUSE; }
    return true;
  }
  X.tt -= dt;
  if (d > 3.6) { X.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (X.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;   // visual
  if (X.tt <= 0) {
    const ok = deal(m, dl);
    if (ok == null) return true;   // the trade is in flight (js/trading.js buy)
    X.stage = null; X.deal = null; X.cd = ok ? 0.5 : 5;
    if (!ok) (X.avoidSeller || (X.avoidSeller = new Map())).set(v2.id, nowS() + 60);
  }
  return true;
}

// ---------------------------------------------------------------- camping
// Out mapping when night is about to fall and the walk home is too long: pitch the tent it carries and sleep there (mobs.js nightAI treats the
// tent's foot centre as its bed; monsters cannot see anyone asleep in a tent). In the morning it packs the tent up again.
const BEDTIME = 0.5, DUSK = 0.45, WALK_SLACK = 0.8, DAY_S = 1200;
const isNight = t => t > BEDTIME && t < 0.985;
const tentItem = () => BF.I.tent;
function homeDistance(m) {
  const b = m.homeBed || m.bed, h = b && !b.tent ? { x: b.x, z: b.z } : m.village ? { x: m.village.x, z: m.village.z } : null;
  return h ? Math.hypot(h.x + 0.5 - m.position.x, h.z + 0.5 - m.position.z) : 0;
}
// Within this many blocks of its bed (the village centre when it has none) it is home: it never camps there, it just goes to bed when night falls
// like everyone else (after dusk villagers keep within 40 blocks of their own neighbourhood, mobs.js villagerAI).
const HOME_R = 48;
// Anywhere inside its own village counts as home too, however big the village grows (bug-052: explorers pitched on farms at the far end
// of their own village): from there it walks to bed.
const inOwnVillage = (m, x, z) => !!(m.village && BF.vlog && BF.vlog.villageAt && BF.vlog.villageAt(x, z) === m.village);
const atHome = m => homeDistance(m) <= HOME_R || inOwnVillage(m, m.position.x, m.position.z);
// Ground a tent may stand on: natural ground, never farmland, a path or anything built (bug-052: tents on farms).
let campGround = null;
function groundOk(id) {
  if (!campGround) campGround = new Set(["grass", "dirt", "coarse_dirt", "podzol", "mycelium", "sand", "red_sand", "gravel", "snow", "snow_grass", "snow_block", "stone", "sandstone", "red_sandstone", "moss_block", "mud", "clay"].map(n => BF.B[n]).filter(x => x != null));
  return campGround.has(id);
}
const PITCH_RETRY = 3;   // seconds between tries at a site when there was none (each try searches 15 x 15 origins)
function pitch(m) {
  const X = state(m), W = BF.world;
  if (X.pitching === BF.blockReq.tick()) return true;   // asked this tick already
  if (!BF.tents || tentItem() == null || cnt(m, tentItem()) < 1) return false;
  const px = Math.floor(m.position.x), pz = Math.floor(m.position.z);
  const blocked = (x, y, z) => (x === px && z === pz) || inOwnVillage(m, x, z) || (BF.SOLID[W.getBlock(x, y - 1, z)] && !groundOk(W.getBlock(x, y - 1, z)));
  const site = BF.tents.findSite(m.position.x, m.position.z, 7, blocked);
  if (!site) return false;
  // a request (spec r15-19): all twelve cells and the tent item at once in the apply phase; the camp is made when it is up (refused: the
  // next evening check finds another site). The blockPlaced events are logged as this villager's (actor).
  X.pitching = BF.blockReq.tick();
  BF.blockReq.cells(m, BF.tents.pitchCells(site.x, site.y, site.z, site.f), { take: [{ id: tentItem(), n: 1 }], emit: true, actor: true }).then(r => {
    X.pitching = null;
    if (!r.ok) { log("pitch_refused", m, { at: site.x + "," + site.z, why: r.why }); return; }
    X.camp = site; X.stage = null; X.target = null; X.deal = null; m.ai.route = null;
    m.homeBed = m.homeBed || m.bed;
    m.bed = { x: site.x, y: site.y, z: site.z, f: site.f, tent: true };
    const k = keyOf(m);
    if (k) campSet(k, { x: site.x, y: site.y, z: site.z, f: site.f, until: nightEnd() });
    log("pitch", m, { at: site.x + "," + site.z, away: Math.round(homeDistance(m)) });
  });
  return true;
}
// Takes the tent down (when it still stands the item comes back, by request: spec r15-19) and gives the villager its own bed again. A tent on
// land that is not loaded (the explorer came back somewhere else) comes back into its pack straight away and is taken down when its land
// loads (camps, tick).
function strike(m) {
  const X = state(m), c = X.camp;
  if (c) {
    const id = BF.tentId(c.f, 0, 1), k = keyOf(m);
    if (BF.world.isLoaded(c.x, c.z)) {
      if (BF.world.getBlock(c.x, c.y, c.z) === id) BF.blockReq.cells(m, BF.tents.strikeCells(c.x, c.y, c.z, id), { give: [{ id: tentItem(), n: 1 }], fit: false });
      else if (BF.glog) BF.glog.log("INFO", "explorer", m.profession + " " + k + " found its tent at " + c.x + ", " + c.z + " gone when it packed up", { village: m.village, at: m });
      if (k) campDrop(k);
    } else {
      T().inv.add(m.inv, tentItem(), 1);
      if (k) campSet(k, { x: c.x, y: c.y, z: c.z, f: c.f, until: 0, returned: true, given: true });
    }
    log("strike", m, { at: c.x + "," + c.z });
  }
  X.camp = null;
  if (m.homeBed !== undefined) { m.bed = m.homeBed; m.homeBed = undefined; }
}
// ---------------------------------------------------------------- tents left behind (bug-067)
// An explorer unloads with its village wherever it is (js/villagesim.js), so a camping explorer can vanish from its tent. Every camp is
// written down here (saved with the villagers, "explorer:camps"): villager key -> {x, y, z, f, until (game day + time the night ends),
// returned (the night ended with the explorer away: the tent is back in its pack), given (it has it), removed (taken down)}.
// - Its village loads again before the night is over: it comes back in its tent, asleep (onSpawn).
// - The night ends first: the tent is taken down (now, or when its land next loads) and goes back into the explorer's pack when it next loads.
const camps = new Map();
// Merchants camp on the road with the same tent (js/merchant.js campAI): their camps are kept here too. A merchant left out of `here` in tick
// had its tent taken down at dawn while it slept in it, struck nothing and lost the tent, and without one it never set out on a long trip again.
const CAMPERS = new Set(["explorer", "merchant"]);
// Changed while the explorer thinks or in its requests' callbacks, which run only on the region worker that thinks it (spec r15-39): each
// change goes to the other workers (js/rworkers.js channel "camp"), or a worker that missed the explorer striking its tent would take the
// tent down a second time when the night ends (tick), and the copies' blocks would differ.
// In key order: campers in two regions pitch in whichever order their regions think, so the map's own order isn't the world's (test/region-tick.js)
const byKey = () => [...camps].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const campSet = (k, e) => { camps.set(k, e); if (BF.rworkers) BF.rworkers.touch("camp", k); const C = BF.ctick; if (C && C.filter) campOwner.set(k, C.cur.key); };
// Clusters (spec r15-39b, js/ctick.js): the cluster that looks after each camp in tick (below) this interval, worked out at each meeting on
// every worker alike: its camper's cluster when it is loaded (a merchant on the road is in the cluster it walks through), else its
// village's; a camp made since, the cluster that made it.
const campOwner = new Map();
function campOwners() {
  const C = BF.ctick;
  campOwner.clear();
  if (!camps.size) return;
  const here = new Map();
  for (const m of BF.mobs.list) if (CAMPERS.has(m.profession) && !m.dead && !m.removed) { const k = keyOf(m); if (k) here.set(k, m); }
  for (const k of camps.keys()) { const m = here.get(k); campOwner.set(k, (m && C.ofMob(m)) || C.ofVillage(k.slice(0, k.lastIndexOf("#")))); }
}
BF.onLoad(() => { if (BF.ctick && BF.ctick.onMeet) BF.ctick.onMeet(campOwners, "explorer camps", "end"); });
const campDrop = k => { camps.delete(k); if (BF.rworkers) BF.rworkers.touch("camp", k); };
// (a camp changed in place, in tick or onSpawn: with clusters on workers only the camp's cluster runs them, so the others need it too)
const campTouch = k => { if (BF.rworkers) BF.rworkers.touch("camp", k); };
if (BF.rworkers) BF.rworkers.channel("camp", {
  key: k => k, get: k => k, state: k => { const e = camps.get(k); return e ? Object.assign({}, e) : null; },
  set: (k, e) => { if (e) camps.set(k, Object.assign({}, e)); else camps.delete(k); },
});
const keyOf = m => (m.village && m.slot ? m.village.key + "#" + m.slot.idx : null);
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + skyT() : 0);
// When the coming (or current) night ends, as a game day + time.
function nightEnd() { const d = BF.sky ? BF.sky.day || 0 : 0, t = skyT(); return d + (t < 0.985 ? 0.985 : 1.985); }
const tentAt = c => BF.world.isLoaded(c.x, c.z) && BF.world.getBlock(c.x, c.y, c.z) === BF.tentId(c.f, 0, 1);
// Every 2 game seconds on the tick counter, so every copy of the world looks on the same ticks: a timer of its own here started again at
// 0 on a region worker booting a loaded world, and the worker took a tent down ticks before the leader did (test/workers-load.js, 2026-10-29).
function tick() { if (camps.size && BF.rand.tick % 40 === 8) sweep(); }
// The camps' look (tests call it directly).
function sweep() {
  const C = BF.ctick && BF.ctick.filter ? BF.ctick : null;   // (clusters: each cluster its camps)
  const here = new Set();
  for (const m of BF.mobs.list) if (CAMPERS.has(m.profession) && !m.dead && !m.removed && (!C || C.filter(m))) { const k = keyOf(m); if (k) here.add(k); }
  const now = dayNow();
  for (const [k, e] of byKey()) {
    if (C && (campOwner.get(k) || C.ofVillage(k.slice(0, k.lastIndexOf("#")))) !== C.cur.key) continue;
    if (here.has(k) && !e.returned) continue;   // its own AI strikes it in the morning
    if (!e.returned && now >= e.until) {
      e.returned = true; campTouch(k);
      if (BF.glog) BF.glog.log("INFO", "explorer", "camper " + k + " away when the night ended: its tent at " + e.x + ", " + e.z + " is taken down and goes back into its pack", { at: [e.x, e.y, e.z] });
    }
    if (e.returned && !e.removed && BF.world.isLoaded(e.x, e.z)) {
      if (tentAt(e)) BF.blockReq.cells(null, BF.tents.strikeCells(e.x, e.y, e.z, BF.tentId(e.f, 0, 1)));   // nobody's request: no items move
      e.removed = true; campTouch(k);
    }
    if (e.returned && e.removed && e.given) campDrop(k);
  }
}
// A villager of its village loading (mobs.js updateVillages, after its saved state and snapshot are back on it).
function onSpawn(m) {
  if (!m || !CAMPERS.has(m.profession)) return;
  const k = keyOf(m), e = k ? camps.get(k) : null;
  if (!e && !(m.ex && m.ex.camp)) return;
  const X = state(m);
  if (e && e.returned) {
    if (!e.given) { T().inv.add(m.inv, tentItem(), 1); e.given = true; log("tent_back", m, { at: e.x + "," + e.z }); campTouch(k); }
    X.camp = null;
    if (e.removed) campDrop(k);
    return;
  }
  if (!X.camp) return;
  const c = X.camp;
  if (e && dayNow() < e.until && tentAt(c)) {   // back before morning: into its tent, asleep
    m.homeBed = m.bed;
    m.bed = { x: c.x, y: c.y, z: c.z, f: c.f, tent: true };
    if (Math.hypot(c.x + 0.5 - m.position.x, c.z + 0.5 - m.position.z) > 3) m.position.set(c.x + 0.5, c.y, c.z + 0.5);
    if (BF.glog) BF.glog.log("INFO", "explorer", m.profession + " " + k + " came back to its tent at " + c.x + ", " + c.z + " for the rest of the night", { village: m.village, at: m });
    return;
  }
  strike(m);   // the night is over (or the tent is gone): pack up, own bed again
}
if (typeof BF.on === "function") BF.on("newWorld", () => camps.clear());
function exportAll(out) { if (camps.size) out["explorer:camps"] = byKey().map(([k, e]) => Object.assign({ k }, e)); }
function importAll(o) {
  camps.clear();
  const a = o && o["explorer:camps"];
  if (Array.isArray(a)) for (const e of a) if (e && typeof e.k === "string" && [e.x, e.y, e.z, e.f].every(Number.isFinite))
    camps.set(e.k, { x: e.x, y: e.y, z: e.z, f: e.f & 3, until: +e.until || 0, returned: !!e.returned, given: !!e.given, removed: !!e.removed });
}
// An explorer starts with one tent, but it can lose it (a world saved before tents existed, the player breaking its camp, a full pack when striking it).
// Back in the village by day it collects a spare from home, so no explorer is ever caught out at dusk without one.
function spareTent(m) {
  if (tentItem() == null || state(m).camp || cnt(m, tentItem()) >= 1 || isNight(skyT()) || skyT() >= DUSK || homeDistance(m) > 30) return;
  if (T().inv.add(m.inv, tentItem(), 1) === 0) log("spare_tent", m, {});
}
// Dusk and morning bookkeeping. Returns true while the villager should just stay put at its camp.
function campAI(m, t, a) {
  const X = state(m);
  if (X.camp) {
    if (!isNight(t) && !m.sleeping && t < DUSK) { strike(m); return false; }
    if (!isNight(t) && t >= DUSK) { a.mode = "idle"; a.t = 2; return true; }   // evening: waits at the tent
    return false;
  }
  // Decided once per evening, when the working day ends: measured against the whole dusk, not the minutes left (that allowance shrinks to nothing
  // just before dark, and an explorer still strolling round its own village would pitch beside its house). Going home means it sleeps in its bed.
  if (t < DUSK || t >= BEDTIME) { X.eve = null; return false; }
  const day = BF.sky ? BF.sky.day : 0;
  if (X.eve && X.eve.day === day) {
    if (X.eve.camp && !atHome(m) && !m.sleeping && cnt(m, tentItem()) >= 1 && nowS() >= (X.pitchAt || 0)) {   // a failed site: tries again
      if (pitch(m)) { X.eve = null; return true; }
      X.pitchAt = nowS() + PITCH_RETRY;
    }
    return false;
  }
  if (m.sleeping || m.child || tentItem() == null || cnt(m, tentItem()) < 1) return false;
  const left = (BEDTIME - t) * DAY_S, reach = left * m.def.speed * 1.3 * 1.5 * WALK_SLACK;
  X.eve = { day, camp: !atHome(m) && homeDistance(m) > reach };
  if (X.eve.camp && pitch(m)) { X.eve = null; return true; }
  if (X.eve.camp) X.pitchAt = nowS() + PITCH_RETRY;
  return false;
}

// ---------------------------------------------------------------- villager AI step (mobs.js villagerAI)
function ai(m, dt, out) {
  if (m.profession !== "explorer" || !m.inv || m.dead || m.child || !BF.maps || !BF.mobs || !BF.mobs.nav || !m.village) return false;
  const X = state(m);
  X.sync -= dt;
  if (X.sync <= 0) { X.sync = 2; syncOffers(m); spareTent(m); }
  const t = skyT();
  if (campAI(m, t, m.ai)) return true;
  if (t < WORK_START || t >= WORK_END || m.tradingWith) { if (X.stage) { X.stage = null; X.target = null; X.deal = null; m.ai.route = null; } return false; }
  let act = carried(m).find(c => !c.done && !c.shelved);
  if (act && X.fin[act.it.name] !== undefined) { delete X.fin[act.it.name]; log("resume", m, { map: act.it.name, coverage: +coverage(act.d).toFixed(3) }); vlog(m, "went back to " + mapText(act) + " (" + Math.floor(coverage(act.d) * 100) + "% filled)"); }
  if (!act && blankSlots(m).length) {
    X.cd -= dt;
    // (X.cd is shopAI's countdown too, which takes it down again in the same update and restarts it at 0: in full detail this one
    // reaches 0 by rounding; in coarse mode, spec r15-64, a whole update short of 0 counts as due)
    const due = X.cd <= 0 || (BF.mobs.coarseNow() && X.cd <= dt);
    if (due && useBlank(m)) act = carried(m).find(c => !c.done && !c.shelved);
    else if (due) X.cd = 30;
  }
  if (act) return exploreAI(m, act, dt, out);
  return shopAI(m, dt, out);
}

// Out mapping by day (a map still to fill) or camped for the night: away from home on purpose, so between patches and before the working day
// it stays out there instead of mobs.js villagerAI walking it back to the village (the 40-block leash). Once the day's work is over it heads home or camps.
function away(m) {
  const X = m.ex, t = skyT();
  return !!X && (!!X.camp || (!isNight(t) && t < WORK_END && carried(m).some(c => !c.done && !c.shelved)));
}

// Trade-screen status line.
function statusText(m) {
  if (!m || m.profession !== "explorer" || !BF.maps) return "";
  if (m.ex && m.ex.camp) return "camping for the night";   // waiting at its tent from dusk, then asleep in it
  const cs = carried(m, true), act = cs.find(c => !c.done && !c.shelved);
  if (act) return "exploring, map " + Math.floor(coverage(act.d) * 100) + "% filled";
  if (cs.some(c => c.done)) return "has a filled map";
  const sh = cs.find(c => c.shelved);
  if (sh) return "map " + Math.floor(coverage(sh.d) * 100) + "% filled, finishing it tomorrow";
  return blankSlots(m).length ? "has a blank map" : "looking for a map";
}
// fin: names of shelved maps (older saves: maps it gave up on, which it then sold). After a load it tries them again straight away.
const pack = m => { const X = state(m); return { fin: Object.keys(X.fin), camp: X.camp || undefined }; };
function unpack(m, o) {
  const X = state(m);
  if (o && Array.isArray(o.fin)) for (const n of o.fin) if (typeof n === "string") X.fin[n] = -1;
  if (o && o.camp && Number.isFinite(+o.camp.x) && Number.isFinite(+o.camp.f)) X.camp = { x: +o.camp.x, y: +o.camp.y, z: +o.camp.z, f: +o.camp.f & 3 };   // despawned while camping: struck on the next morning
}

BF.explorer = { offerFor, pitch, strike, away, tick, sweep, onSpawn, exportAll, importAll, camps, atHome, PRICE_BLANK, SELL_PRICE, FILLED, cellPx, MAX_FOR_SALE, ai, syncOffers, statusText, pack, unpack, coverage, carried, useBlank, pickTarget, shelve, LOG };
})();
