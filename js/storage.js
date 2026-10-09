// Chest ownership upkeep and villager storage (BF.storage). The chest contents and the owner of each chest live in js/inventory.js.
// - Ownership: an unowned chest becomes the property of whoever first puts an item in it (or takes one out of an unowned chest that still
//   holds items): the player ("player") or a villager (its persistence key "<village key>#<slot>"). A chest that has been empty for
//   RELEASE_DAYS game days, or whose villager owner dies, is unclaimed again (its contents stay). Villagers only ever use chests that are
//   unowned or their own, and only chests in the house their bed is in.
// - Storing: a villager whose inventory is full walks to a chest in its bed's house and puts its surplus in, the least needed first
//   (see keepOf / storePlan). Owning one, it comes back for things when it runs low (withdrawPlan).
// - No usable chest in the house: it orders one (orders()); a furniture maker of the village makes it from 8 planks and delivers it into
//   the house for 1 emerald (js/furniture.js).
// - Everything is logged in the village log as kind "chest" (js/villagelog.js).
// See CONTRACT.md "Chest ownership and villager storage".
(() => {
"use strict";
const BF = window.BF;
const TR = () => BF.trades;
const INV = () => BF.inventory;
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();

const RELEASE_DAYS = 1;      // an owned chest left empty this long is unclaimed again
const STORE_FREE = 4;        // after storing, at least this many free inventory slots (surplus first, then the least needed)
const TAKE_FREE = 2;         // taking things back leaves at least this many free slots
const LOW = 0.5;             // an item is fetched from the chest when the villager holds less than half of what it keeps
const FETCH_CD = 0.5;        // days before something it stored is fetched back (food for a hungry villager excepted)
const CHECK = 6;             // seconds between a villager's storage checks
const TRIP_MAX = 60;         // seconds before a walk to a chest is given up
const AVOID = 0.3;           // days a chest that could not be reached is left alone
const ORDER_DAYS = 1;        // an order for a chest stands this long (renewed while the villager still needs one)
const WORK_END = 0.5;        // villagers stop at sunset (bedtime in mobs.js starts then too)
const PUT_T = 1.2;           // seconds at the open chest

const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const keyOf = m => (m && m.village && m.slot ? m.village.key + "#" + m.slot.idx : null);
const nameOf = m => (BF.vlog ? BF.vlog.nameOf(m) : "Villager");
const who = m => nameOf(m) + " (" + pretty(m.child ? "child" : m.profession) + ")";
const at = p => p.x + ", " + p.y + ", " + p.z;
const pk = (x, y, z) => x + "," + y + "," + z;
const listOf = items => items.map(e => e.n + " " + BF.itemName(e.id)).join(" + ");
function log(rec, text, where) { if (rec && BF.vlog) BF.vlog.log(rec, "chest", text, where); }
const recAt = (m, p) => (m && m.village) || (BF.vlog ? BF.vlog.villageAt(p.x, p.z) : null);

// ---------------------------------------------------------------- the house of a villager's bed, its chests
function bedHouse(m) {
  const rec = m && m.village, b = m && (m.homeBed !== undefined ? m.homeBed : m.bed);
  if (!rec || !b || b.tent) return null;
  for (const h of rec.houses || []) if (h && h.w && b.x >= h.x && b.x < h.x + h.w && b.z >= h.z && b.z < h.z + h.d) return h;
  return null;
}
const houseCache = new Map();   // house -> {t, list: [{x,y,z}]}
function chestsIn(H, b) {
  const now = BF.simNow ? BF.simNow() : performance.now() / 1000;
  const hit = houseCache.get(H);
  if (hit && now - hit.t < 10) return hit.list;
  const W = BF.world, y0 = (H.y != null ? H.y : b.y - 1), list = [];
  for (let x = H.x; x < H.x + H.w; x++) for (let z = H.z; z < H.z + H.d; z++) {
    if (!W.isLoaded(x, z)) continue;
    for (let y = y0; y <= y0 + 9; y++) if (BF.isChest(W.getBlock(x, y, z))) list.push({ x, y, z });
  }
  houseCache.set(H, { t: now, list });
  return list;
}
// May villager key k use the chest at p? Unowned (and not delivered to somebody else just now) or its own.
function usable(p, k) {
  const c = INV().chestState(p.x, p.y, p.z);
  if (!c) return true;
  if (c.owner) return c.owner === k;
  return !(c.reserved && c.reserved.key !== k && c.reserved.until > dayNow());
}
const ownedBy = k => [...INV().chests.values()].filter(c => c.owner === k);
const roomIn = c => c.slots.filter(s => !s).length;

// ---------------------------------------------------------------- what a villager needs
// Work inputs per profession (kept with score 70): [item name or predicate, how many].
const nm = id => (BF.items[id] ? BF.items[id].name : "");
const INPUTS = {
  farmer: m => [[id => BF.items[id] && BF.items[id].plants != null, (BF.food ? BF.food.SEED_KEEP : 8) * 2], ["wheat_item", BF.villageLife ? BF.villageLife.WHEAT_SPARE : 24], ["bone_meal", 16]],
  shepherd: m => [["wheat_item", 16]],
  cowherd: m => [["wheat_item", 16], ["bucket", 2], ["milk_bucket", 4], ["glass_bottle", 64], ["raw_beef", 32]],   // feed, its bucket, milk to bottle, bottles, beef to cook (js/cowherd.js)
  forester: m => [[id => /_sapling$/.test(nm(id)), 16]],
  furniture_maker: m => [[id => /_wool$|^wool$/.test(nm(id)), 6], [id => /planks$/.test(nm(id)), 16], [id => /_log$/.test(nm(id)) && !/^stripped/.test(nm(id)), 8], ["cobblestone", 16]],
  cartographer: m => [["iron_ingot", 4], ["gold_ingot", 1], ["paper", 32], ["compass", 1]],
  miner: m => [["torch", 16]],   // shaft torches (js/miner.js)
  toolsmith: m => [[id => /planks$/.test(nm(id)), 12], ["stick", 8], ["cobblestone", 9], ["iron_ingot", 9], ["gold_ingot", 6], ["diamond", 6], ["raw_iron", 9], ["raw_gold", 6], ["coal", 8], ["furnace", 1]],   // tool materials (js/toolsmith.js)
  fletcher: m => [["stick", 16], [id => /planks$/.test(nm(id)), 8], ["flint", 8], ["feather", 8], ["string", 6]],   // arrow and bow materials (js/fletcher.js)
  builder: m => (TR().profile("builder").wants ? [...TR().profile("builder").wants.keys()].map(id => [nm(id), 128]) : []).concat([["red_bed", 4], ["oak_door", 8], ["torch", 32], ["chest", 2], ["glass", 64]]),
};
const SCRAPS = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish)$/;
const goodFood = id => !!(BF.food && BF.food.isFood(id) && !SCRAPS.test(nm(id)));
// keepOf(m) -> Map id -> {n: how many it keeps on hand, s: how much it needs them (higher = more)}
function keepOf(m) {
  const keep = new Map(), I = BF.I;
  const add = (id, n, s) => { if (id == null || !(n > 0)) return; const k = keep.get(id); if (!k) keep.set(id, { n, s }); else { k.n = Math.max(k.n, n); k.s = Math.max(k.s, s); } };
  add(I.emerald, Infinity, 100);                                                     // money: never stored
  for (const st of m.inv) if (st && stackOf(st.id) === 1) add(st.id, 1, 90);          // tools, buckets, maps, the tent: one of each
  const ins = INPUTS[m.profession];
  if (ins) for (const [what, n] of ins(m)) {
    if (typeof what === "string") add(I[what], n, 70);
    else for (const st of m.inv) if (st && what(st.id)) add(st.id, n, 70);
  }
  // food: three days' worth plus the 7 bread-equivalents a seller always keeps, the most filling food first (fewest slots); scraps such as
  // rotten flesh are never kept
  if (BF.food) {
    const F = BF.food;
    let need = 3 * F.rate(m) + F.KEEP, seen = new Set();
    const foods = m.inv.filter(st => st && goodFood(st.id) && !seen.has(st.id) && seen.add(st.id)).map(st => st.id)
      .sort((a, b) => F.breadEq(b) - F.breadEq(a));
    for (const id of foods) {
      if (need <= 0) break;
      const eq = F.breadEq(id), n = Math.ceil(need / eq);
      add(id, n, 60); need -= n * eq;
    }
  }
  // wares it sells: up to its stock cap
  for (const [id, cap] of TR().profile(m.profession).caps) add(id, cap, 50);
  return keep;
}
// How little an item beyond what is kept is needed: junk first, then goods it bought, then overflow of its own wares, food, work inputs.
function surplusScore(m, id, keep) {
  const k = keep.get(id), wants = TR().profile(m.profession).wants;
  if (!k) return wants.has(id) ? 20 : 10;
  return k.s >= 70 ? 40 : k.s >= 60 ? 35 : 30;
}
const count = (a, id) => TR().inv.count(a, id);
const free = a => a.filter(s => !s).length;
// What to store now in a chest holding chestSlots: [{id, n}], the least needed first. Everything beyond what it keeps; if that frees too little, then the least needed of
// what it keeps (never emeralds or its one-of-a-kind tools) until STORE_FREE slots are free.
function storePlan(m, chestSlots) {
  const keep = keepOf(m), a = TR().inv.clone(m.inv), out = [], ids = [...new Set(m.inv.filter(Boolean).map(s => s.id))];
  const extra = ids.map(id => ({ id, n: count(a, id) - Math.min(count(a, id), (keep.get(id) || { n: 0 }).n), s: surplusScore(m, id, keep) }))
    .filter(e => e.n > 0).sort((x, y) => x.s - y.s || y.n / stackOf(y.id) - x.n / stackOf(x.id));
  const kept = ids.map(id => ({ id, n: count(a, id), s: (keep.get(id) || { s: 0 }).s })).filter(e => e.s < 90)
    .sort((x, y) => x.s - y.s || y.n / stackOf(y.id) - x.n / stackOf(x.id));
  const box = TR().inv.clone(chestSlots);   // what still fits in the chest
  const push = (id, n) => {
    n -= TR().inv.add(box, id, n);
    if (n <= 0) return;
    const prev = out.find(e => e.id === id);
    if (prev) prev.n += n; else out.push({ id, n });
    TR().inv.remove(a, id, n);
  };
  for (const e of extra) push(e.id, e.n);
  for (const e of kept) { if (free(a) >= STORE_FREE) break; push(e.id, Math.min(count(a, e.id), stackOf(e.id))); }
  return out;
}
// What to take back from chest c: [{id, n}] for things it keeps but holds less than half of (food at once when hungry).
function withdrawPlan(m, c) {
  const keep = keepOf(m), a = TR().inv.clone(m.inv), out = [], now = dayNow(), st = m.store || {};
  const F = BF.food, hungry = F && F.available(m) < F.rate(m);
  const inChest = new Map();
  for (const s of c.slots) if (s) inChest.set(s.id, (inChest.get(s.id) || 0) + s.count);
  const want = [];
  for (const [id, n] of inChest) {
    const k = keep.get(id), food = goodFood(id);
    const target = k && Number.isFinite(k.n) ? k.n : (food && hungry ? 3 * F.rate(m) : 0);
    const have = count(a, id);
    if (!(target > 0) || have >= target) continue;
    const urgent = food && hungry;
    if (!urgent && (have >= target * LOW || (st.stored && st.stored[id] > now - FETCH_CD))) continue;
    want.push({ id, n: Math.min(n, target - have), s: urgent ? 200 : k ? k.s : 0 });
  }
  want.sort((x, y) => y.s - x.s);
  for (const w of want) {
    let n = w.n;
    while (n > 0) {
      const sim = TR().inv.clone(a);
      if (TR().inv.add(sim, w.id, n) === 0 && free(sim) >= TAKE_FREE) break;
      n = n > stackOf(w.id) ? n - stackOf(w.id) : n - Math.max(1, Math.ceil(n / 2));
    }
    if (n > 0) { TR().inv.add(a, w.id, n); out.push({ id: w.id, n }); }
  }
  return out;
}

// ---------------------------------------------------------------- the chest a villager may use now
const adjacent = (p, x, y, z) => Math.abs(x - p.x) + Math.abs(z - p.z) === 1 && Math.abs(y - p.y) <= 1;
// The chest to store in: one of its own with room, else an unowned one in its bed's house (nearest first). null if none.
function pickChest(m, needRoom) {
  const H = bedHouse(m), k = keyOf(m), st = m.store, now = dayNow();
  if (!H || !k) return null;
  const b = m.homeBed !== undefined ? m.homeBed : m.bed;
  const list = chestsIn(H, b).filter(p => !(st.avoid[pk(p.x, p.y, p.z)] > now) && usable(p, k));
  const rec = p => INV().chestState(p.x, p.y, p.z);
  const room = p => { const c = rec(p); return c ? roomIn(c) : INV().CHEST_SIZE; };
  const d = p => Math.hypot(p.x + 0.5 - m.position.x, p.z + 0.5 - m.position.z) + Math.abs(p.y - m.position.y) * 2;
  const mine = list.filter(p => { const c = rec(p); return c && c.owner === k; }).filter(p => !needRoom || room(p) > 0).sort((p, q) => d(p) - d(q));
  if (mine.length) return mine[0];
  return list.filter(p => { const c = rec(p); return !c || !c.owner; }).filter(p => !needRoom || room(p) > 0).sort((p, q) => d(p) - d(q))[0] || null;
}

// ---------------------------------------------------------------- ordering a chest (js/furniture.js delivers it)
// A free floor cell in the house, on the floor of the bed, against a wall, not beside the door or the bed, and one that does not cut the
// room in two (the walkable floor stays connected). Corners first. Returns {x, y, z} or null.
function chestSpot(m) {
  const H = bedHouse(m), b = m && (m.homeBed !== undefined ? m.homeBed : m.bed);
  if (!H || !b) return null;
  const W = BF.world, y = b.y, B = BF.blocks, S = BF.SOLID;
  const get = (x, yy, z) => W.getBlock(x, yy, z);
  const inside = (x, z) => x > H.x && x < H.x + H.w - 1 && z > H.z && z < H.z + H.d - 1;
  const walk = (x, z) => inside(x, z) && get(x, y, z) === 0 && !S[get(x, y + 1, z)] && S[get(x, y - 1, z)];
  const near = (x, z, f) => BF.DIRS.some(([dx, dz]) => f(get(x + dx, y, z + dz)) || f(get(x + dx, y + 1, z + dz)));
  const cells = [];
  for (let x = H.x + 1; x < H.x + H.w - 1; x++) for (let z = H.z + 1; z < H.z + H.d - 1; z++) if (walk(x, z)) cells.push([x, z]);
  if (cells.length < 4) return null;
  const connected = (bx, bz) => {   // flood fill of the floor without (bx, bz)
    const start = cells.find(([x, z]) => x !== bx || z !== bz), seen = new Set([start[0] + "," + start[1]]), q = [start];
    while (q.length) { const [x, z] = q.pop(); for (const [dx, dz] of BF.DIRS) { const nx = x + dx, nz = z + dz, k = nx + "," + nz; if ((nx === bx && nz === bz) || seen.has(k) || !walk(nx, nz)) continue; seen.add(k); q.push([nx, nz]); } }
    return seen.size === cells.length - 1;
  };
  const scored = [];
  for (const [x, z] of cells) {
    if (near(x, z, id => B[id] && (B[id].door || B[id].bed || B[id].gate))) continue;
    if (Math.abs(x - H.doorX) + Math.abs(z - H.doorZ) <= 2) continue;
    if (BF.mobs.list.some(o => !o.removed && Math.floor(o.position.x) === x && Math.floor(o.position.z) === z && Math.abs(o.position.y - y) < 2)) continue;
    const walls = BF.DIRS.filter(([dx, dz]) => S[get(x + dx, y, z + dz)]).length;
    if (!walls || !connected(x, z)) continue;
    scored.push({ x, y, z, walls });
  }
  scored.sort((p, q) => q.walls - p.walls);
  return scored[0] ? { x: scored[0].x, y: scored[0].y, z: scored[0].z } : null;
}
// Villagers of village rec waiting for a chest: [{m, spot}] (loaded, awake, with an emerald to pay and still no usable chest).
function orders(rec) {
  const out = [], now = dayNow();
  for (const m of (rec && rec.members) || []) {
    const o = m.store && m.store.order;
    if (!o || o.until < now || m.dead || m.removed || !Array.isArray(m.inv)) continue;
    if (count(m.inv, BF.I.emerald) < 1 || pickChest(m, true)) { m.store.order = null; continue; }
    out.push({ m, spot: o.spot });
  }
  return out;
}
// js/furniture.js: furniture maker f puts a chest it holds at spot for villager m and takes 1 emerald from m. Returns true when done.
function deliver(f, m, spot) {
  const W = BF.world, T = TR(), I = BF.I;
  const o = (f.trades || []).find(x => x.sell.id === I.chest && x.sell.n === 1 && x.buy.length === 1 && x.buy[0].id === I.emerald);   // its chest offer: the player can buy one too
  if (!o || !m.store || !m.store.order || W.getBlock(spot.x, spot.y, spot.z) !== 0 || T.blockReason(f, o) || count(m.inv, I.emerald) < o.buy[0].n) return false;
  const inCell = o => o && o.position && Math.abs(o.position.x - spot.x - 0.5) < 0.5 + (o.halfWidth || 0.3) && Math.abs(o.position.z - spot.z - 0.5) < 0.5 + (o.halfWidth || 0.3) && o.position.y < spot.y + 1 && o.position.y + (o.height || 1.8) > spot.y;
  if (BF.mobs.list.some(o => !o.removed && !o.dead && inCell(o)) || inCell(BF.player)) return false;   // somebody is standing there
  if (!W.setBlock(spot.x, spot.y, spot.z, BF.chestId(BF.openFacing(spot, f.position)))) return false;
  T.exchange(f, o); T.inv.remove(m.inv, I.emerald, o.buy[0].n);
  const c = INV().chestRecord(spot.x, spot.y, spot.z);
  c.reserved = { key: keyOf(m), until: dayNow() + ORDER_DAYS };
  m.store.order = null; m.store.checkT = 0.5;
  houseCache.clear();
  if (BF.vlog) BF.vlog.trade(m, f, o, 1);
  log(m.village, who(f) + " placed a chest at " + at(spot) + " in the house of " + who(m));
  return true;
}

// ---------------------------------------------------------------- villager AI (mobs.js villagerAI, daytime)
function doStore(m, p) {
  const c = INV().chestRecord(p.x, p.y, p.z), k = keyOf(m), st = m.store;
  if (!usable(p, k)) return false;
  const plan = storePlan(m, c.slots), done = [], now = dayNow();
  for (const e of plan) {
    const got = TR().inv.remove(m.inv, e.id, e.n);
    const left = INV().chestAdd(p.x, p.y, p.z, e.id, got);
    if (left) TR().inv.add(m.inv, e.id, left);
    if (got - left > 0) { done.push({ id: e.id, n: got - left }); (st.stored || (st.stored = {}))[e.id] = now; }
  }
  if (!done.length) return false;
  INV().chestUsed(p.x, p.y, p.z, k, nameOf(m), m);   // claims an unowned chest (logged from the chestClaimed event)
  log(m.village, who(m) + " put " + listOf(done) + " in their chest at " + at(p));
  return true;
}
function doTake(m, p) {
  const c = INV().chestState(p.x, p.y, p.z), k = keyOf(m);
  if (!c || !usable(p, k)) return false;
  const done = [];
  for (const e of withdrawPlan(m, c)) {
    const got = INV().chestTake(p.x, p.y, p.z, e.id, e.n);
    if (!got) continue;
    const left = TR().inv.add(m.inv, e.id, got);
    if (left) INV().chestAdd(p.x, p.y, p.z, e.id, left);
    if (got - left > 0) done.push({ id: e.id, n: got - left });
  }
  if (!done.length) return false;
  INV().chestUsed(p.x, p.y, p.z, k, nameOf(m), m);   // the first to use an unclaimed chest that still holds things becomes its owner
  log(m.village, who(m) + " took " + listOf(done) + " from their chest at " + at(p));
  return true;
}
// What it should do now: {act: "store" | "take", p} or null; orders a chest when it is full and has none it may use.
function decide(m) {
  const st = m.store, k = keyOf(m);
  if (BF.miner && BF.miner.underground(m)) return null;   // a miner down its shaft deals with chests once it is back up
  const full = free(m.inv) === 0 || !!(BF.miner && BF.miner.wantsStore && BF.miner.wantsStore(m));   // a miner stores unsold finds early
  if (full) {
    const p = pickChest(m, true);
    if (p) { st.order = null; return { act: "store", p }; }
    if (!st.order || st.order.until < dayNow()) {
      const spot = bedHouse(m) && count(m.inv, BF.I.emerald) > 0 ? chestSpot(m) : null;
      if (spot) {
        const fresh = !st.order;
        st.order = { spot, until: dayNow() + ORDER_DAYS };
        if (fresh) log(m.village, who(m) + " wants a chest for their house (inventory full)", m);
      }
    }
    return null;
  }
  const H = bedHouse(m), now = dayNow();
  if (!H) return null;
  for (const c of ownedBy(k)) {
    const p = c.pos;
    if (st.avoid[pk(p.x, p.y, p.z)] > now || chestEmpty(c)) continue;
    if (withdrawPlan(m, c).length) return { act: "take", p };
  }
  return null;
}
const chestEmpty = c => !c.slots.some(Boolean);
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.sleeping || m.tradingWith || !m.village || !BF.mobs || !BF.mobs.nav || !BF.inventory || !BF.inventory.chestState || !keyOf(m)) return false;
  const st = m.store || (m.store = { stage: null, checkT: rnd(1, CHECK), avoid: {}, stored: {}, order: null }), a = m.ai, N = BF.mobs.nav;
  const stop = () => { st.stage = null; st.p = null; if (a.routeKind === "chest") a.route = null; return false; };
  if (skyT() >= WORK_END) return st.stage ? stop() : false;
  if (!st.stage) {
    if ((st.checkT -= dt) > 0) return false;
    st.checkT = CHECK * rnd(0.8, 1.2);
    const d = decide(m);
    if (!d) return false;
    st.stage = "go"; st.act = d.act; st.p = d.p; st.t = 0; a.route = null;
  }
  const p = st.p, giveUp = () => { st.avoid[pk(p.x, p.y, p.z)] = dayNow() + AVOID; return stop(); };
  if (!BF.isChest(BF.world.getBlock(p.x, p.y, p.z)) || !usable(p, keyOf(m))) return stop();
  st.t += dt;
  a.mode = "idle"; a.t = 2;
  if (st.stage === "go") {
    if (st.t > TRIP_MAX) return giveUp();
    const [x, y, z] = N.feetCell(m);
    if (adjacent(p, x, y, z)) { a.route = null; st.stage = "use"; st.useT = PUT_T; return true; }
    if (!a.route || a.routeKind !== "chest") {
      if (!N.takePlan()) return true;
      const route = N.findPath(x, y, z, { x: p.x, z: p.z, at: (cx, cy, cz) => adjacent(p, cx, cy, cz) }, 2500);
      if (!route) return giveUp();
      a.route = route; a.ri = 0; a.stuckT = 0; a.routeKind = "chest";
    }
    const r = N.followRoute(m, dt, out, m.def.speed * 1.2);
    if (r === "stuck") return giveUp();
    if (r === "done") a.route = null;
    return true;
  }
  // at the chest: face it, lid open for a moment, then move the goods
  out.faceX = p.x + 0.5; out.faceZ = p.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.5 };
  if (st.useT === PUT_T && BF.emit) BF.emit("chestOpened", p.x, p.y, p.z);
  st.useT -= dt;
  if (st.useT > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
  if (BF.emit) BF.emit("chestClosed", p.x, p.y, p.z);
  if (st.act === "store") doStore(m, p); else doTake(m, p);
  st.checkT = 1;
  return stop();
}
function statusText(m) {
  const st = m && m.store;
  if (st && st.stage) return st.act === "store" ? "Putting things away in their chest" : "Fetching things from their chest";
  if (st && st.order && st.order.until > dayNow()) return "Inventory full: waiting for a chest from the furniture maker";
  return "";
}

// ---------------------------------------------------------------- upkeep: empty chests, dead owners, logs
let tickT = 0, hooked = false;
function tick(dt) {
  hook();
  if ((tickT -= dt) > 0 || !INV() || !INV().chests) return;
  tickT = 2;
  const now = dayNow();
  for (const c of INV().chests.values()) {
    if (!c.owner) continue;
    if (!chestEmpty(c)) { c.emptySince = null; continue; }
    if (c.emptySince == null || c.emptySince > now) c.emptySince = now;
    else if (now - c.emptySince >= RELEASE_DAYS) INV().chestRelease(c, "empty for a day");
  }
}
function hook() {
  if (hooked || typeof BF.on !== "function") return;
  hooked = true;
  BF.on("chestClaimed", (c, m) => {
    const rec = recAt(m, c.pos);
    log(rec, (c.owner === "player" ? "Player" : m ? who(m) : c.ownerName || "Someone") + " claimed the chest at " + at(c.pos));
  });
  BF.on("chestReleased", (c, why, was) => {
    const whose = was.owner === "player" ? "the player's" : (was.name || "a villager") + "'s";
    log(recAt(null, c.pos), "The chest at " + at(c.pos) + " (" + whose + ") is unclaimed again: " + why);
  });
  BF.on("chestBroken", c => log(recAt(null, c.pos), "The chest at " + at(c.pos) + " (" + (c.owner === "player" ? "the player's" : (c.ownerName || "a villager") + "'s") + ") was broken"));
  BF.on("mobKilled", m => {   // a villager owner dies: its chests are free for the next one to use them
    const k = m && m.type === "villager" ? keyOf(m) : null;
    if (k && INV()) for (const c of ownedBy(k)) INV().chestRelease(c, who(m) + " died");
  });
}

BF.storage = { RELEASE_DAYS, STORE_FREE, ORDER_DAYS, keepOf, storePlan, withdrawPlan, bedHouse, chestsIn, usable, pickChest, chestSpot, orders, deliver, ai, tick, statusText, keyOf };
})();
