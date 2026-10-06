// Explorer villagers (BF.explorer). Companion of js/maps.js (map items, explored pixels) and js/cartography.js (who makes the blank maps).
// - Spawning (mobs.js villageRoster): only in villages with cartographers, one explorer per cartographer with 70% probability. Jobsite: the survey table.
// - An explorer never starts with a map. With emeralds in its pocket it walks to a cartographer of its village that holds a blank map and buys it
//   (PRICE_BLANK emeralds by size, the cartographer's own prices in js/trading.js; stock and room rules of trading.js apply). It takes any size it can pay for, favouring small ones.
// - It uses the blank map where it stands: the map becomes the filled map of an 8x8-chunk zone near it (its own zone first, then the closest zone
//   that is not mapped yet), and it starts walking from one unexplored patch of the zone to the next. js/maps.js samples the world around it
//   (BF.maps.explore) so the shared zone data fills in exactly as if a player carried the map.
// - The map counts as filled at FILLED coverage, or when every patch left over is out of reach (water, cliffs: a patch is given up after two failed
//   walks). Only chunks that are loaded can be mapped, so patches far from the player wait until the player comes near.
// - Filled maps are the explorer's wares: syncOffers() keeps one offer per filled map it carries (price in emeralds by map size).
// - Persistence: the maps are inventory items (saved by name, js/trading.js); `ex` in the villager pack holds the patches given up on.
(() => {
"use strict";
const BF = window.BF;
const rnd = (a, b) => a + Math.random() * (b - a);
const T = () => BF.trades;

const PRICE_BLANK = [4, 8, 16, 32, 64];   // what the cartographer asks for a blank map by size (js/trading.js: "4 emerald > 1 blank_map_1" ...)
const SELL_PRICE = [7, 16, 36, 80, 176];  // emeralds the player pays for a filled map, by size: well over the blank price, and it grows faster (TRADE_AUDIT.md)
const IDLE_GIVE_UP = 180;                 // seconds of waiting for patches nobody has loaded before it settles for what it mapped
const FILLED = 0.97;                      // share of mapped pixels that counts as filled
// patch size in map pixels: 16 on the two small maps, then about 32 blocks (the fill radius of js/maps.js shrinks to 16 blocks on the big ones)
const cellPx = size => (size <= 2 ? 16 : Math.max(2, Math.round(32 / BF.maps.scale(size))));
const MAP_WORK_CAP = 1500;                // seconds of exploring after which it settles for what it mapped (a size 5 map is ~130 km of walking)
const SIZE_WEIGHT = [16, 8, 4, 2, 1];     // which affordable size it buys: mostly small ones, they are the ones it can finish
const CELL_DONE = 0.9;                    // a patch is explored when this share of its pixels is
const MAX_FOR_SALE = 2;                   // stops fetching maps once it carries this many filled ones (waiting for a buyer)
const SAMPLE = 700;                       // pixel samples per call to BF.maps.explore, ~5 calls per second
const PLAYER_RANGE = 85;                  // without BF.villageSim (js/villagesim.js): patches further than this from the player are left alone (villagers despawn at 100)
const EDGE = 24;                          // a patch must have loaded terrain this far around it, so the explorer never stands at the edge of the loaded area (a villager on an unloaded chunk is removed)
const WORK_START = 0.03, WORK_END = 0.45; // sky.time window of the working day (same as js/cartography.js)
const TRADE_PAUSE = 1.6;
const LOG = [];
const nowS = () => performance.now() / 1000;
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, who: "explorer" + (m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };

const state = m => m.ex || (m.ex = { fin: {}, avoid: {}, stage: null, target: null, cd: rnd(1, 4), sync: 0, sampT: 0 });
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
function cellFill(d, ci, cj) {
  const PX = BF.maps.PX, CELL = cellPx(d.size);
  let n = 0;
  for (let j = cj * CELL; j < (cj + 1) * CELL; j++) for (let i = ci * CELL; i < (ci + 1) * CELL; i++) if (d.px[j * PX + i]) n++;
  return n / (CELL * CELL);
}
const isFilled = (m, it, d) => !!(state(m).fin[nameOf(it)] || coverage(d) >= FILLED);
// Filled-map items in the inventory: [{slot, it, d, done}]
function carried(m) {
  const out = [];
  m.inv.forEach((s, slot) => {
    const it = s && BF.items[s.id];
    if (!it || !it.map) return;
    const d = BF.maps.getData(it.map.size, it.map.zx, it.map.zz);
    out.push({ slot, it, d, done: isFilled(m, it, d) });
  });
  return out;
}

// ---------------------------------------------------------------- offers
// A map it gave up on before 97% is priced by how much of it is explored (at least 15%).
const priceOf = (it, d) => Math.max(1, Math.round(SELL_PRICE[Math.max(0, Math.min(SELL_PRICE.length - 1, it.map.size - 1))] * Math.max(0.15, Math.min(1, coverage(d) / FILLED))));
// One offer per filled map it carries: emeralds for the map. Replaces the previous list only when it changed.
function syncOffers(m) {
  if (!m || m.profession !== "explorer" || !m.inv || !Array.isArray(m.trades) || !BF.maps) return;
  const em = BF.I.emerald, seen = new Set(), dyn = [];
  for (const c of carried(m)) {
    if (!c.done || seen.has(c.it.id)) continue;
    seen.add(c.it.id);
    dyn.push({ buy: [{ id: em, n: priceOf(c.it, c.d) }], sell: { id: c.it.id, n: 1 }, level: 1, xp: T().TRADE_XP[0], dyn: 1 });
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
  const zones = [];
  const zx0 = M.zoneOf(m.position.x), zz0 = M.zoneOf(m.position.z);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const zx = zx0 + dx, zz = zz0 + dz, nm = M.nameOf(size, zx, zz);
    if (held.has(nm) || X.fin[nm]) continue;
    const d = M.getData(size, zx, zz, false);
    if (d && coverage(d) >= FILLED) continue;
    zones.push({ zx, zz, nm, dist: Math.hypot(M.centre(zx) - m.position.x, M.centre(zz) - m.position.z) });
  }
  if (!zones.length) { X.cd = 60; return false; }
  zones.sort((a, b) => a.dist - b.dist);
  const z = zones[0], id = BF.resolveItem(z.nm);
  if (id === undefined || !inv.canFit(m.inv, [{ id, n: 1 }], [{ id: slot.id, n: 1 }])) { X.cd = 30; return false; }
  inv.remove(m.inv, slot.id, 1);
  inv.add(m.inv, id, 1);
  M.getData(size, z.zx, z.zz);
  X.stage = null; X.target = null; X.avoid = {};
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
const inLoaded = (x, z) => { const W = BF.world; return W.isLoaded(x, z) && W.isLoaded(x + EDGE, z) && W.isLoaded(x - EDGE, z) && W.isLoaded(x, z + EDGE) && W.isLoaded(x, z - EDGE); };
// Next patch of map `c` to visit: the nearest unexplored, loaded one near the player that has not been given up. null + reason otherwise.
function pickTarget(m, c, anywhere) {
  const M = BF.maps, d = c.d, X = state(m), s = M.scale(d.size), ox = M.originX(d.size, d.zx), oz = M.originX(d.size, d.zz);
  const CELL = cellPx(d.size), n = M.PX / CELL, pp = BF.player.position;
  let best = null, bd = Infinity, open = 0, avoided = 0;
  for (let cj = 0; cj < n; cj++) for (let ci = 0; ci < n; ci++) {
    if (cellFill(d, ci, cj) >= CELL_DONE) continue;
    const k = c.it.name + ":" + ci + "," + cj;
    if ((X.avoid[k] || 0) >= 2) { avoided++; continue; }
    const wx = Math.floor(ox + (ci * CELL + CELL / 2) * s), wz = Math.floor(oz + (cj * CELL + CELL / 2) * s);
    open++;
    if (!anywhere && (!inLoaded(wx, wz) || (!BF.villageSim && Math.hypot(wx - pp.x, wz - pp.z) > PLAYER_RANGE))) continue;
    const dist = Math.hypot(wx + 0.5 - m.position.x, wz + 0.5 - m.position.z);
    if (dist < bd) { bd = dist; best = { ci, cj, wx, wz, k }; }
  }
  return { best, open, avoided };
}
function exploreAI(m, c, dt, out) {
  const X = state(m), a = m.ai, M = BF.maps;
  X.sampT -= dt;
  if (X.sampT <= 0) { X.sampT = 0.2; M.explore(c.d, m.position.x, m.position.z, SAMPLE); }
  if (isFilled(m, c.it, c.d)) { finish(m, c, "covered"); return false; }
  X.work = X.work || {};
  if ((X.work[c.it.name] = (X.work[c.it.name] || 0) + dt) > MAP_WORK_CAP) { X.fin[c.it.name] = 1; finish(m, c, "time"); return false; }
  if (!X.target) {
    X.pickT = (X.pickT || 0) - dt;
    if (X.pickT > 0) return false;
    X.pickT = 1;
    const p = pickTarget(m, c);
    if (!p.best) {
      if (!p.open && p.avoided) { X.fin[c.it.name] = 1; finish(m, c, "unreachable"); }   // only patches out of reach are left
      else if (!p.open) finish(m, c, "covered");
      else {                                                                           // patches exist but nobody has loaded them: wait for the player
        X.pickT = 4; X.idleS = (X.idleS || 0) + 4;
        if (X.idleS >= IDLE_GIVE_UP) { X.fin[c.it.name] = 1; X.idleS = 0; finish(m, c, "out of range"); }
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
      if (cellFill(c.d, t.ci, t.cj) < CELL_DONE) X.avoid[t.k] = (X.avoid[t.k] || 0) + 1;
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
function finish(m, c, why) {
  const X = state(m);
  X.target = null; X.stage = null; X.avoid = {};
  log("filled", m, { map: c.it.name, why, coverage: +coverage(c.d).toFixed(3) });
  syncOffers(m);
}

// ---------------------------------------------------------------- catching up on trips (js/villagesim.js)
// A village that was out of range for a while: its explorer is credited with the patches it would have mapped, a few per frame (the terrain is
// generated on the side, BF.maps.exploreFar, so nothing has to be loaded). Same rules as the live walk: out of reach patches (ocean) are given up.
const PATCH_SECS = 25, CATCHUP_MAX = 60, CATCH_CALLS = 14;
function catchUp(m, rec, away) {
  if (m.profession !== "explorer" || !m.inv || m.child || !BF.maps || !BF.maps.exploreFar || !carried(m).some(c => !c.done)) return;
  const X = state(m);
  X.catchLeft = Math.min(CATCHUP_MAX, Math.floor(away * (WORK_END - WORK_START) * 600 / PATCH_SECS));
  X.catchPos = { x: m.position.x, z: m.position.z };
}
function stepCatch(m, X) {
  const act = carried(m).find(c => !c.done);
  if (!act || X.catchLeft <= 0) { X.catchLeft = 0; return; }
  X.catchLeft--;
  X.work = X.work || {};
  if (isFilled(m, act.it, act.d)) { finish(m, act, "covered"); X.catchLeft = 0; return; }
  if ((X.work[act.it.name] = (X.work[act.it.name] || 0) + PATCH_SECS) > MAP_WORK_CAP) { X.fin[act.it.name] = 1; finish(m, act, "time"); X.catchLeft = 0; return; }
  const vm = Object.create(m);
  vm.position = X.catchPos;                       // tour from patch to patch, nearest first
  const p = pickTarget(vm, act, true);
  if (!p.best) {
    if (!p.open && p.avoided) { X.fin[act.it.name] = 1; finish(m, act, "unreachable"); }
    else if (!p.open) finish(m, act, "covered");
    X.catchLeft = 0;
    return;
  }
  const t = p.best, d = act.d;
  X.catchPos = { x: t.wx, z: t.wz };
  if (BF.worldgen.heightAt(t.wx, t.wz) <= BF.SEA) { X.avoid[t.k] = 2; return; }   // water: out of reach
  for (let i = 0; i < CATCH_CALLS && cellFill(d, t.ci, t.cj) < CELL_DONE; i++) BF.maps.exploreFar(d, t.wx, t.wz, SAMPLE);
  if (cellFill(d, t.ci, t.cj) < CELL_DONE) X.avoid[t.k] = (X.avoid[t.k] || 0) + 1;
  if (isFilled(m, act.it, d)) { finish(m, act, "covered"); X.catchLeft = 0; }
}
if (BF.villageSim) BF.villageSim.onCatchUp(catchUp);

// ---------------------------------------------------------------- fetching a blank map from a cartographer
const canSell = v2 => v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && v2.profession === "cartographer" && Array.isArray(v2.inv) && Array.isArray(v2.trades);
// The blank map it would buy from v2: a size it holds and can pay for, drawn with weights favouring small ones (SIZE_WEIGHT).
function offerFor(v2, emeralds) {
  if (Array.isArray(v2)) v2 = { inv: v2 };
  const I = BF.I, opts = [];
  for (let k = 1; k <= PRICE_BLANK.length; k++) {
    const id = I["blank_map_" + k];
    if (id != null && cnt(v2, id) >= 1 && emeralds >= PRICE_BLANK[k - 1]) opts.push({ k, id, w: SIZE_WEIGHT[k - 1] });
  }
  if (!opts.length) return null;
  let r = Math.random() * opts.reduce((a, o) => a + o.w, 0), o = opts[0];
  for (const q of opts) { o = q; if ((r -= q.w) <= 0) break; }
  return { buy: [{ id: I.emerald, n: PRICE_BLANK[o.k - 1] }], sell: { id: o.id, n: 1 }, level: 4, xp: T().TRADE_XP[3] };
}
function findCartographer(m, X) {
  const R = m.village;
  if (!R) return null;
  let best = null, bd = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2) || (X.avoidSeller && X.avoidSeller.get(v2) > nowS())) continue;
    const o = offerFor(v2, cnt(m, BF.I.emerald));
    if (!o || T().blockReason(v2, o) || !T().inv.canFit(m.inv, [o.sell], o.buy)) continue;
    const d = v2.position.distanceTo(m.position);
    if (d < bd) { bd = d; best = { seller: v2, offer: o }; }
  }
  return best;
}
function deal(m, dl) {
  const t = T(), v2 = dl.seller, o = dl.offer;
  if (!canSell(v2) || cnt(m, BF.I.emerald) < o.buy[0].n || !t.inv.canFit(m.inv, [o.sell], o.buy) || !t.exchange(v2, o)) return false;
  t.inv.remove(m.inv, o.buy[0].id, o.buy[0].n);
  t.inv.add(m.inv, o.sell.id, o.sell.n);
  t.addXp(v2, o);
  if (BF.vlog) BF.vlog.trade(m, v2, o);
  log("buy", m, { from: "cartographer", got: BF.items[o.sell.id].name, paid: o.buy[0].n + " emerald" });
  return true;
}
function shopAI(m, dt, out) {
  const X = state(m), a = m.ai;
  if (!X.stage || X.stage === "explore") {
    X.stage = null;
    X.cd -= dt;
    if (X.cd > 0) return false;
    X.cd = 4;
    if (blankSlots(m).length || carried(m).filter(c => c.done).length >= MAX_FOR_SALE || cnt(m, BF.I.emerald) < PRICE_BLANK[0]) return false;
    const dl = findCartographer(m, X);
    if (!dl) { X.cd = rnd(15, 30); return false; }
    X.deal = dl; X.stage = "walk"; X.walkT = 0; a.route = null;
  }
  const dl = X.deal, v2 = dl && dl.seller;
  const giveUp = () => { if (v2) (X.avoidSeller || (X.avoidSeller = new Map())).set(v2, nowS() + 60); X.stage = null; X.deal = null; a.route = null; X.cd = 5; return false; };
  if (!v2 || !canSell(v2) || !offerFor(v2, cnt(m, BF.I.emerald))) return giveUp();
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
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
  if (X.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (X.tt <= 0) {
    const ok = deal(m, dl);
    X.stage = null; X.deal = null; X.cd = ok ? 0.5 : 5;
    if (!ok) (X.avoidSeller || (X.avoidSeller = new Map())).set(v2, nowS() + 60);
  }
  return true;
}

// ---------------------------------------------------------------- camping
// Out mapping when night is about to fall and the walk home is too long: pitch the tent it carries and sleep there (mobs.js nightAI treats the
// tent's foot centre as its bed; monsters cannot see anyone asleep in a tent). In the morning it packs the tent up again.
const BEDTIME = 0.52, DUSK = 0.45, WALK_SLACK = 0.8, DAY_S = 600;
const isNight = t => t > BEDTIME && t < 0.985;
const tentItem = () => BF.I.tent;
function homeDistance(m) {
  const b = m.homeBed || m.bed, h = b ? { x: b.x, z: b.z } : m.village ? { x: m.village.x, z: m.village.z } : null;
  return h ? Math.hypot(h.x + 0.5 - m.position.x, h.z + 0.5 - m.position.z) : 0;
}
function pitch(m) {
  const X = state(m), T0 = T();
  if (!BF.tents || tentItem() == null || cnt(m, tentItem()) < 1) return false;
  const px = Math.floor(m.position.x), pz = Math.floor(m.position.z);
  const site = BF.tents.findSite(m.position.x, m.position.z, 7, (x, y, z) => x === px && z === pz);
  if (BF.vlog) BF.vlog.actor = m;                       // the blockPlaced events inside place() are logged as this villager's
  const placed = site && BF.tents.place(site.x, site.y, site.z, site.f);
  if (BF.vlog) BF.vlog.actor = null;
  if (!placed) return false;
  T0.inv.remove(m.inv, tentItem(), 1);
  X.camp = site; X.stage = null; X.target = null; X.deal = null; m.ai.route = null;
  m.homeBed = m.homeBed || m.bed;
  m.bed = { x: site.x, y: site.y, z: site.z, f: site.f, tent: true };
  log("pitch", m, { at: site.x + "," + site.z, away: Math.round(homeDistance(m)) });
  return true;
}
// Takes the tent down (when it still stands the item comes back) and gives the villager its own bed again.
function strike(m) {
  const X = state(m), c = X.camp;
  if (c) {
    const id = BF.tentId(c.f, 0, 1);
    if (BF.world.isLoaded(c.x, c.z) && BF.world.getBlock(c.x, c.y, c.z) === id && BF.tents.remove(c.x, c.y, c.z, id)) T().inv.add(m.inv, tentItem(), 1);
    log("strike", m, { at: c.x + "," + c.z });
  }
  X.camp = null;
  if (m.homeBed !== undefined) { m.bed = m.homeBed; m.homeBed = undefined; }
}
// Dusk and morning bookkeeping. Returns true while the villager should just stay put at its camp.
function campAI(m, t, a) {
  const X = state(m);
  if (X.camp) {
    if (!isNight(t) && !m.sleeping && t < DUSK) { strike(m); return false; }
    if (!isNight(t) && t >= DUSK) { a.mode = "idle"; a.t = 2; return true; }   // evening: waits at the tent
    return false;
  }
  if (t >= DUSK && t < BEDTIME && !m.sleeping && !m.child && tentItem() != null && cnt(m, tentItem()) >= 1) {
    const left = (BEDTIME - t) * DAY_S, reach = left * m.def.speed * 1.3 * WALK_SLACK;
    if (homeDistance(m) > reach && pitch(m)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- villager AI step (mobs.js villagerAI)
function ai(m, dt, out) {
  if (m.profession !== "explorer" || !m.inv || m.dead || m.child || !BF.maps || !BF.mobs || !BF.mobs.nav || !m.village) return false;
  const X = state(m);
  for (let k = 0; k < 4 && X.catchLeft > 0; k++) stepCatch(m, X);   // ~3 ms a patch
  X.sync -= dt;
  if (X.sync <= 0) { X.sync = 2; syncOffers(m); }
  const t = skyT();
  if (campAI(m, t, m.ai)) return true;
  if (t < WORK_START || t >= WORK_END || m.tradingWith) { if (X.stage) { X.stage = null; X.target = null; X.deal = null; m.ai.route = null; } return false; }
  let act = carried(m).find(c => !c.done);
  if (!act && blankSlots(m).length) {
    X.cd -= dt;
    if (X.cd <= 0 && useBlank(m)) act = carried(m).find(c => !c.done);
    else if (X.cd <= 0) X.cd = 30;
  }
  if (act) return exploreAI(m, act, dt, out);
  return shopAI(m, dt, out);
}

// Trade-screen status line.
function statusText(m) {
  if (!m || m.profession !== "explorer" || !BF.maps) return "";
  const cs = carried(m), act = cs.find(c => !c.done);
  if (act) return "exploring, map " + Math.round(coverage(act.d) * 100) + "% filled";
  if (cs.some(c => c.done)) return "has a filled map";
  return blankSlots(m).length ? "has a blank map" : "looking for a map";
}
const pack = m => { const X = state(m); return { fin: Object.keys(X.fin), camp: X.camp || undefined }; };
function unpack(m, o) {
  const X = state(m);
  if (o && Array.isArray(o.fin)) for (const n of o.fin) if (typeof n === "string") X.fin[n] = 1;
  if (o && o.camp && Number.isFinite(+o.camp.x) && Number.isFinite(+o.camp.f)) X.camp = { x: +o.camp.x, y: +o.camp.y, z: +o.camp.z, f: +o.camp.f & 3 };   // despawned while camping: struck on the next morning
}

BF.explorer = { offerFor, pitch, strike, PRICE_BLANK, SELL_PRICE, FILLED, cellPx, MAX_FOR_SALE, ai, syncOffers, statusText, pack, unpack, coverage, carried, useBlank, pickTarget, catchUp, LOG };
})();
