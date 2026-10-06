// Villager food consumption (BF.food) and farmer AI (BF.villageLife). Loaded after mobs.js / builder.js.
// See CONTRACT.md "Villager food and farming (js/villagelife.js)".
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const BREAD_PTS = 5;               // bread restores 5 hunger points = 1 bread-equivalent
const KEEP = 7;                    // a seller always keeps at least this many bread-eq
const MEALS = [0.04, 0.22, 0.42];  // sky.time of the three daily meals (breakfast, lunch, supper; all before bedtime 0.52)
const MAX_CATCHUP_MEALS = 3 * 30;  // at most 30 days of meals are caught up at once
const LIFE_V = 1;                  // save-format version of the per-villager food state

const T = () => BF.trades;
const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();

// ---------------------------------------------------------------- bread equivalents
const eqOf = id => { const it = BF.items && BF.items[id]; return it && it.food ? it.food / BREAD_PTS : 0; };
const isFood = id => eqOf(id) > 0;
// breadEq(itemId) -> bread-eq of one item; breadEq(inventoryArray | mob) -> total of all food in it
function breadEq(x) {
  if (x == null) return 0;
  if (typeof x === "number") return eqOf(x);
  const a = Array.isArray(x) ? x : x.inv;
  if (!Array.isArray(a)) return 0;
  let s = 0;
  for (const st of a) if (st) s += eqOf(st.id) * st.count;
  return s;
}
// Items a farmer keeps back for replanting (not eaten, not sold as surplus).
const SEED_KEEP = 8;
function reserveOf(m, id) {
  if (!m || m.profession !== "farmer") return 0;
  const it = BF.items[id];
  return it && it.plants != null ? SEED_KEEP : 0;
}
// Food the mob may eat or sell: [{id, n, eq}] (farmer seed reserve excluded), cheapest per bread-eq first.
function costPerEq(id) {
  const V = T() && T().VALUE, it = BF.items[id];
  const v = V && it && V[it.name] != null ? V[it.name] : 0.2;
  return v / Math.max(0.01, eqOf(id));
}
function edible(m) {
  const out = new Map();
  if (!m || !Array.isArray(m.inv)) return [];
  for (const st of m.inv) if (st && isFood(st.id)) out.set(st.id, (out.get(st.id) || 0) + st.count);
  const list = [];
  for (const [id, n] of out) { const k = n - reserveOf(m, id); if (k > 0) list.push({ id, n: k, eq: eqOf(id) }); }
  list.sort((a, b) => costPerEq(a.id) - costPerEq(b.id) || a.eq - b.eq);
  return list;
}
// Food in hand (bread-eq) the mob can eat, including the fractional carry of an item already started.
const available = m => edible(m).reduce((s, e) => s + e.n * e.eq, 0) + ((m && m.life && m.life.sat) || 0);
const rate = m => (m && m.child ? 2 : 1);                      // bread-eq per day
const surplus = m => Math.max(0, available(m) - KEEP);         // what it can spare while keeping 7 bread-eq

const eatL = [];
function onEat(cb) { if (typeof cb === "function") eatL.push(cb); }
function life(m) {
  if (!m.life) { const t = dayNow(); m.life = { v: LIFE_V, mealT: t, lastAte: t, sat: 0, eaten: 0, starving: false }; }
  return m.life;
}
// Eats `amount` bread-eq: whole items are taken out of the inventory (cheapest first) and any excess is carried as
// satiation (`life.sat`) for later meals. Returns the bread-eq actually eaten (less when food ran out).
function eat(m, amount) {
  if (!m || !(amount > 0)) return 0;
  const L = life(m);
  let need = amount, ate = [];
  while (need > 1e-9) {
    if (L.sat > 1e-9) { const u = Math.min(L.sat, need); L.sat -= u; need -= u; continue; }
    const e = edible(m)[0];
    if (!e) break;
    T().inv.remove(m.inv, e.id, 1);
    L.sat += e.eq;
    ate.push(e.id);
  }
  if (L.sat < 1e-9) L.sat = 0;
  const got = amount - need;
  if (got > 0) {
    L.eaten += got;
    m.eatenTotal = L.eaten;
    for (const cb of eatL) { try { cb(m, got, ate); } catch (err) { console.error(err); } }
  }
  return got;
}
// Removes whole items worth at least `eq` bread-eq (cheapest first, reserve kept) and returns them as [{id, count}].
function take(m, eq) {
  const out = [];
  let left = eq;
  for (const e of edible(m)) {
    if (left <= 1e-9) break;
    const k = Math.min(e.n, Math.ceil(left / e.eq - 1e-9));
    const got = T().inv.remove(m.inv, e.id, k);
    if (got > 0) { out.push({ id: e.id, count: got }); left -= got * e.eq; }
  }
  return out;
}

// ---------------------------------------------------------------- meals (by game-day count, so time skips catch up)
const mealIndex = A => Math.floor(A) * MEALS.length + MEALS.filter(t => t <= A - Math.floor(A)).length;
const mealTime = k => Math.floor(k / MEALS.length) + MEALS[k % MEALS.length];
let fx = null;   // visual hook set by the farming part (particles, sound)
function digest(m, now) {
  const L = life(m);
  if (!(L.mealT <= now)) L.mealT = now;            // time went backwards (/time set): nothing due
  if (!(L.lastAte <= now)) L.lastAte = now;
  const k0 = mealIndex(L.mealT), k1 = mealIndex(now);
  let ateAny = 0;
  if (k1 > k0) {
    const per = rate(m) / MEALS.length;
    for (let k = Math.max(k0, k1 - MAX_CATCHUP_MEALS); k < k1; k++) {
      const got = eat(m, per);
      if (got > 0) { L.lastAte = mealTime(k); ateAny += got; }
    }
    L.mealT = now;
  }
  // starving: more than a full day since the last bite. Food in hand is eaten at once to recover.
  if (now - L.lastAte > 1 && available(m) > 0) {
    const got = eat(m, rate(m) / MEALS.length);
    if (got > 0) { L.lastAte = now; ateAny += got; }
  }
  L.starving = now - L.lastAte > 1;
  m.starving = L.starving;
  if (ateAny > 0 && fx) fx(m);
  return ateAny;
}

// ---------------------------------------------------------------- starting food, persistence
function addAll(inv, list) { for (const [name, n] of list) if (BF.I[name] != null && n > 0) T().inv.add(inv, BF.I[name], n); }
// Gives a new villager (or one from a save that predates villager food) a starting food stock.
function startFood(v) {
  if (!v || !Array.isArray(v.inv)) return;
  const prof = v.profession;
  if (prof === "farmer") {
    addAll(v.inv, [["wheat_seeds", rndInt(10, 20)], ["carrot", rndInt(8, 14)], ["potato", rndInt(8, 14)], ["beetroot_seeds", rndInt(4, 10)]]);
    if (breadEq(v.inv) < 12) addAll(v.inv, [["bread", Math.ceil(12 - breadEq(v.inv))]]);
    const r = Math.random();
    if (BF.I.water_bucket != null) { if (r < 0.35) addAll(v.inv, [["water_bucket", 1]]); else if (r < 0.6) addAll(v.inv, [["bucket", 1]]); }
    if (Math.random() < 0.45) addAll(v.inv, [["oak_log", rndInt(3, 8)]]);
  } else {
    const target = rnd(3, 6);
    const opts = [["bread", 1], ["apple", 0.8], ["carrot", 0.6], ["baked_potato", 1]];
    for (let guard = 0; breadEq(v.inv) < target && guard < 20; guard++) {
      const [name] = opts[Math.random() < 0.6 ? 0 : rndInt(1, opts.length - 1)];
      if (BF.I[name] == null || T().inv.add(v.inv, BF.I[name], 1) > 0) break;
    }
  }
  v.life = life(v);
}
function pack(v) {
  const L = v.life;
  if (!L) return { v: LIFE_V };
  return { v: LIFE_V, mealT: L.mealT, lastAte: L.lastAte, sat: +L.sat.toFixed(4), eaten: +L.eaten.toFixed(3), starving: !!L.starving };
}
function unpack(v, o) {
  if (!v) return;
  if (!o || typeof o !== "object") { v.life = null; startFood(v); return; }   // save from before villager food
  const t = dayNow(), num = (x, d) => (Number.isFinite(+x) ? +x : d);
  v.life = { v: LIFE_V, mealT: num(o.mealT, t), lastAte: num(o.lastAte, t), sat: Math.max(0, num(o.sat, 0)), eaten: Math.max(0, num(o.eaten, 0)), starving: !!o.starving };
  v.eatenTotal = v.life.eaten;
  v.starving = v.life.starving;
}
// Trade hook: a starving villager only trades food.
function blockReason(v, o) {
  if (v && v.starving && o && o.sell && !isFood(o.sell.id)) return "Too hungry to trade";
  return null;
}

BF.food = {
  BREAD_PTS, KEEP, MEALS, LIFE_V, SEED_KEEP,
  breadEq, isFood, available, surplus, rate, eat, take, onEat, edible, life, digest, startFood, pack, unpack, blockReason, dayNow,
  setFx(f) { fx = f; },
};
})();

// ================================================================ farming, food shopping, eating visuals (BF.villageLife)
(() => {
"use strict";
const BF = window.BF;
const FD = () => BF.food;
const TR = () => BF.trades;
const W = () => BF.world;
const nav = () => BF.mobs.nav;
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();

const WORK_END = 0.5;             // farmers and shoppers stop at sunset; bedtime (mobs.js) starts at 0.52
const REACH_H = 1.75;             // horizontal feet -> cell centre distance to work a cell
const ACT = { harvest: 0.55, plant: 0.45, till: 0.9, border: 0.75, water: 0.9, fill: 0.9, craft: 1.6, tend: 3.0 };
const TASK_MAX = 45;              // seconds before an unfinished task is given up
const BREAK_P = 0.05;             // chance of a short break after a task (the rest of the day is farming)
const SCAN_COLS = 500;            // columns of the village area scanned per tick
const RESCAN = 10;                // seconds between village farm scans
const IRRIGATE = 4;               // farmland needs a water source within 4 blocks (same level), like vanilla
const TILL_PER_FARMER = 40;       // farmland a village may gain per farmer beyond its worldgen farms
const TRADE_PAUSE = 1.6;
const SHOP_DAYS = 3;              // a hungry villager buys up to 3 days of food
const LOG = [];

const B = n => BF.B[n];
const I = n => BF.I[n];
let C = null;   // lazily resolved block / item ids
function ids() {
  if (C) return C;
  C = {
    farmland: B("farmland"), water: B("water"), path: B("dirt_path"),
    mature: new Map([[B("wheat"), I("wheat_seeds")], [B("carrots"), I("carrot")], [B("potatoes"), I("potato")], [B("beetroots"), I("beetroot_seeds")]]),
    seeds: ["wheat_seeds", "carrot", "potato", "beetroot_seeds"].map(I).filter(x => x != null),
    till: new Set(["grass", "dirt", "coarse_dirt", "podzol", "snow_grass", "mycelium"].map(B).filter(x => x != null)),
    wheat: I("wheat_item"), bread: I("bread"), hay: I("hay_bale"), bucket: I("bucket"), wbucket: I("water_bucket"), em: I("emerald"),
    cook: [["raw_chicken", "cooked_chicken"], ["raw_porkchop", "cooked_porkchop"], ["raw_beef", "steak"], ["raw_mutton", "cooked_mutton"], ["raw_cod", "cooked_cod"]]
      .map(([a, b]) => [I(a), I(b)]).filter(([a, b]) => a != null && b != null),
  };
  C.matureSet = new Set(C.mature.keys());
  return C;
}
const cnt = (m, id) => (id == null ? 0 : TR().inv.count(m.inv, id));
const woodId = m => { for (const s of m.inv) if (s && BF.items[s.id] && BF.items[s.id].isBlock && /(_log|planks)$/.test(BF.items[s.id].name)) return s.id; return null; };
const key3 = (x, y, z) => x + "," + y + "," + z;
const getB = (x, y, z) => W().getBlock(x, y, z);

// ---------------------------------------------------------------- particles (eating crumbs, harvest bits)
const pool = [];
let partGeo = null;
const partMats = {};
function particles(x, y, z, color, n, spread) {
  if (!BF.scene || typeof THREE === "undefined") return;
  if (!partGeo) partGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
  const key = color || "#999999";
  const mat = partMats[key] || (partMats[key] = new THREE.MeshBasicMaterial({ color: new THREE.Color(key) }));
  for (let i = 0; i < n; i++) {
    if (pool.length > 120) { const o = pool.shift(); BF.scene.remove(o.mesh); }
    const mesh = new THREE.Mesh(partGeo, mat);
    mesh.position.set(x + (Math.random() - 0.5) * spread, y + Math.random() * 0.2, z + (Math.random() - 0.5) * spread);
    BF.scene.add(mesh);
    pool.push({ mesh, vx: (Math.random() - 0.5) * 1.6, vy: 0.8 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 1.6, life: 0.4 + Math.random() * 0.3 });
  }
}
function updateParticles(dt) {
  for (let i = pool.length - 1; i >= 0; i--) {
    const p = pool[i];
    p.life -= dt; p.vy -= 12 * dt;
    p.mesh.position.x += p.vx * dt; p.mesh.position.y += p.vy * dt; p.mesh.position.z += p.vz * dt;
    if (p.life <= 0) { BF.scene.remove(p.mesh); pool.splice(i, 1); }
  }
}
const nearPlayer = (m, r) => { const p = BF.player && BF.player.position; return !!(p && m.position && m.position.distanceTo(p) < r); };
function sound(name, x, y, z, vol) { try { if (BF.audio && BF.audio.play) BF.audio.play(name, { x, y, z, volume: vol == null ? 0.6 : vol, group: "mobs", dist: 16 }); } catch (e) { /* audio is optional */ } }
function blockSound(kind, id, x, y, z) { try { if (BF.audio && BF.audio.blockSound) BF.audio.blockSound(kind, id, x, y, z, 0.6); } catch (e) { /* optional */ } }
// eating: a few crumbs at the mouth, an arm movement and a crunch when the player is close
FD().setFx(m => {
  if (!m.position || m.sleeping || m.removed || !nearPlayer(m, 24)) return;
  const yaw = m.yaw || 0, hy = m.position.y + (m.height || 1.95) * 0.78;
  const col = (BF.items[BF.I.bread] && BF.items[BF.I.bread].color) || "#b98a3a";
  particles(m.position.x + Math.cos(yaw) * 0.3, hy, m.position.z + Math.sin(yaw) * 0.3, col, 6, 0.25);
  if (m.ai) m.ai.swingT = 0.35;
  m.lastMealFx = dayNow();
  sound("eat", m.position.x, hy, m.position.z, 0.5);
});

// ---------------------------------------------------------------- village farm data (scanned incrementally)
function areaOf(R) {
  const wg = R.wg;
  if (wg && Number.isFinite(wg.minX)) {
    let yLo = Infinity, yHi = -Infinity;
    for (const p of wg.pads || []) { yLo = Math.min(yLo, p.y); yHi = Math.max(yHi, p.y); }
    if (!Number.isFinite(yLo)) { yLo = R.y; yHi = R.y; }
    return { x0: wg.minX - 6, x1: wg.maxX + 6, z0: wg.minZ - 6, z1: wg.maxZ + 6, yLo: yLo - 5, yHi: yHi + 6 };
  }
  const y = Number.isFinite(R.y) ? R.y : 64;
  return { x0: Math.floor(R.x) - 24, x1: Math.floor(R.x) + 24, z0: Math.floor(R.z) - 24, z1: Math.floor(R.z) + 24, yLo: y - 6, yHi: y + 6 };
}
function vdata(R) {
  if (R._life) return R._life;
  const A = areaOf(R), wg = R.wg || {};
  const boxes = [];      // [x0, z0, x1, z1] that farmers never till / flood / border
  let farmBase = 0;
  for (const b of wg.buildings || []) {
    const farm = b.type === "farm" || b.type === "bigfarm";
    boxes.push(farm ? [b.x0, b.z0, b.x1, b.z1] : [b.x0 - 1, b.z0 - 1, b.x1 + 1, b.z1 + 1]);
    if (farm) farmBase += (b.w - 2) * (b.d - 2);
  }
  if (Number.isFinite(wg.x)) boxes.push([wg.x - 9, wg.z - 9, wg.x + 9, wg.z + 9]);       // meeting square, bell, well
  for (const l of wg.lamps || []) boxes.push([l[0] - 1, l[1] - 1, l[0] + 1, l[1] + 1]);
  for (const d of wg.decor || []) boxes.push([d[0] - 1, d[1] - 1, d[0] + 1, d[1] + 1]);
  R._life = { area: A, boxes, farmBase, cells: [], water: [], waterSet: new Set(), ready: false, scan: null, scanT: 0 };
  return R._life;
}
function inArea(D, x, z) { const A = D.area; return x >= A.x0 && x <= A.x1 && z >= A.z0 && z <= A.z1; }
function freeCell(R, D, x, z) {
  if (!inArea(D, x, z)) return false;
  for (const b of D.boxes) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return false;
  if (BF.builder && BF.builder.builtOf) for (const e of BF.builder.builtOf(R) || []) if (x >= e.ox - 1 && x <= e.ox + e.w && z >= e.oz - 1 && z <= e.oz + e.d) return false;
  return true;
}
function scanStep(R, D, budget) {
  const w = W(), c = ids(), A = D.area;
  if (!D.scan) {
    if (performance.now() / 1000 < D.scanT) return;
    D.scan = { x: A.x0, z: A.z0, cells: [], water: [] };
  }
  const S = D.scan;
  while (budget-- > 0) {
    if (w.isLoaded(S.x, S.z)) {
      for (let y = A.yHi; y >= A.yLo; y--) {
        const id = w.getBlock(S.x, y, S.z);
        if (id === 0 || BF.RENDER[id] === 4) continue;
        if (BF.FLUID[id] === 8) S.water.push([S.x, y, S.z]);
        else if (id === c.farmland) S.cells.push([S.x, y, S.z]);
        break;
      }
    }
    if (++S.x > A.x1) {
      S.x = A.x0;
      if (++S.z > A.z1) {
        D.cells = S.cells; D.water = S.water; D.waterSet = new Set(S.water.map(p => key3(...p)));
        D.ready = true; D.scan = null; D.scanT = performance.now() / 1000 + RESCAN;
        return;
      }
    }
  }
}
const farmersOf = R => (R.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed && m.profession === "farmer").length;
const tillCap = (R, D) => D.farmBase + TILL_PER_FARMER * Math.max(1, farmersOf(R));
function irrigated(D, x, y, z) {
  for (let dz = -IRRIGATE; dz <= IRRIGATE; dz++) for (let dx = -IRRIGATE; dx <= IRRIGATE; dx++) if (D.waterSet.has(key3(x + dx, y, z + dz))) return true;
  return false;
}
// open space above a ground cell: air or a replaceable plant (grass, flowers), and no solid block at head height
function openAbove(x, y, z) {
  const a = getB(x, y + 1, z);
  if (a !== 0 && !(BF.REPLACEABLE[a] && !BF.FLUID[a] && !BF.SOLID[a]) && !(BF.RENDER[a] === 4 && !BF.blocks[a].growsInto && !ids().matureSet.has(a))) return false;
  return getB(x, y + 2, z) === 0;
}
const tillable = (R, D, x, y, z) => W().isLoaded(x, z) && freeCell(R, D, x, z) && ids().till.has(getB(x, y, z)) && openAbove(x, y, z);

// ---------------------------------------------------------------- task search
const claims = new Map();   // cell key -> mob
function claimed(k, m) { const o = claims.get(k); return o && o !== m && !o.dead && !o.removed && o.farm && o.farm.task && o.farm.task.k === k; }
function plantFor(m, x, y, z) {
  const c = ids(), votes = new Map();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const b = BF.blocks[getB(x + dx, y + 1, z + dz)];
    if (!b) continue;
    let seed = c.mature.get(b.id);
    if (seed == null && b.growsInto != null) seed = c.mature.get(b.growsInto);
    if (seed != null && cnt(m, seed) > 0) votes.set(seed, (votes.get(seed) || 0) + (Math.abs(dx) + Math.abs(dz) === 1 ? 2 : 1));
  }
  let best = null, bv = 0;
  for (const [id, v] of votes) if (v > bv) { bv = v; best = id; }
  if (best != null) return best;
  for (const id of c.seeds) if (cnt(m, id) > (best == null ? 0 : cnt(m, best))) best = id;
  return best;
}
function dropsFit(m, cropId) {
  const c = ids(), seed = c.mature.get(cropId), main = BF.blocks[cropId].drop;
  const adds = [{ id: main, n: 4 }];
  if (seed !== main) adds.push({ id: seed, n: 3 });
  return TR().inv.canFit(m.inv, adds, []);
}
function think(m, fs, R, D) {
  const c = ids(), px = m.position.x, pz = m.position.z, now = performance.now() / 1000;
  const dist = (x, z) => Math.hypot(x + 0.5 - px, z + 0.5 - pz);
  const ok = k => !claimed(k, m) && !(fs.avoid[k] > now);
  // bake: 3 wheat -> 1 bread (hay bales once bread is plentiful)
  const wheat = cnt(m, c.wheat);
  if (wheat >= 3 && c.bread != null) {
    const toHay = cnt(m, c.bread) >= 96 && wheat >= 9 && c.hay != null;
    if (TR().inv.canFit(m.inv, [{ id: toHay ? c.hay : c.bread, n: 1 }], [{ id: c.wheat, n: toHay ? 9 : 3 }])) return { kind: "craft", hay: toHay };
  }
  // harvest mature crops / plant empty farmland: nearest first
  let best = null, bd = Infinity, fits = new Map(), hasSeed = c.seeds.some(id => cnt(m, id) > 0);
  const young = [];
  for (const [x, y, z] of D.cells) {
    if (!W().isLoaded(x, z) || getB(x, y, z) !== c.farmland) continue;
    const a = getB(x, y + 1, z), k = key3(x, y + 1, z);
    let kind = null;
    if (c.matureSet.has(a)) {
      if (!fits.has(a)) fits.set(a, dropsFit(m, a));
      if (fits.get(a)) kind = "harvest";
    } else if (a === 0 && hasSeed && !BF.SOLID[getB(x, y + 2, z)]) kind = "plant";
    else if (BF.blocks[a] && BF.blocks[a].growsInto != null) young.push([x, y, z]);
    if (!kind || !ok(k)) continue;
    const d = dist(x, z) + (kind === "plant" ? 1.5 : 0);
    if (d < bd) { bd = d; best = { kind, x, y: y + 1, z, k }; }
  }
  if (best) return best;
  // nothing to harvest or plant: make more farmland (till near water, border with wood, carry water)
  const room = D.cells.length < tillCap(R, D);
  let exp = room ? findTill(m, R, D, ok) : null;
  if (woodId(m) != null) {                              // with wood: edge the beds as they grow (nearest of the two jobs)
    const b = findBorder(m, R, D, ok);
    if (b && (!exp || dist(b.x, b.z) < dist(exp.x, exp.z) + 2)) exp = b;
  }
  if (exp) return exp;
  if (room && (cnt(m, c.wbucket) > 0 || cnt(m, c.bucket) > 0)) {
    const spot = findWaterSpot(m, R, D, ok);
    if (spot) {
      if (cnt(m, c.wbucket) > 0) return spot;
      const f = findFill(m, R, D, ok);
      if (f) return f;
    }
  }
  if (young.length && Math.random() < 0.8) {           // look after the growing crops
    const [x, y, z] = young[Math.floor(Math.random() * young.length)];
    return { kind: "tend", x, y: y + 1, z, k: "tend:" + key3(x, y, z) };
  }
  return null;
}
function findTill(m, R, D, ok) {
  const px = m.position.x, pz = m.position.z, fset = new Set(D.cells.map(p => key3(...p)));
  const waters = D.water.slice().sort((a, b) => Math.hypot(a[0] - px, a[2] - pz) - Math.hypot(b[0] - px, b[2] - pz)).slice(0, 48);
  let best = null, bs = Infinity;
  const seen = new Set();
  for (const [wx, wy, wz] of waters) for (let dz = -IRRIGATE; dz <= IRRIGATE; dz++) for (let dx = -IRRIGATE; dx <= IRRIGATE; dx++) {
    const x = wx + dx, z = wz + dz, y = wy, k = key3(x, y, z);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!ok(k) || !tillable(R, D, x, y, z)) continue;
    let adj = 0;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (fset.has(key3(x + ax, y, z + az))) adj++;
    const s = Math.hypot(x + 0.5 - px, z + 0.5 - pz) - adj * 6;
    if (s < bs) { bs = s; best = { kind: "till", x, y, z, k, ty: y + 1 }; }
  }
  return best;
}
function findBorder(m, R, D, ok) {
  const px = m.position.x, pz = m.position.z;
  let best = null, bd = Infinity;
  for (const [x, y, z] of D.cells) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, nz = z + dz, k = key3(nx, y, nz);
    if (!ok(k) || !tillable(R, D, nx, y, nz) || irrigated(D, nx, y, nz)) continue;
    const d = Math.hypot(nx + 0.5 - px, nz + 0.5 - pz);
    if (d < bd) { bd = d; best = { kind: "border", x: nx, y, z: nz, k, ty: y + 1 }; }
  }
  return best;
}
// A new irrigation hole: a ground cell walled in on all four sides (so the water stays put), next to the existing beds,
// with no water yet within reach and plenty of tillable ground around it.
function findWaterSpot(m, R, D, ok) {
  const base = D.cells.length ? D.cells : null;
  let best = null, bs = -Infinity;
  for (let t = 0; t < 70; t++) {
    let x, y, z;
    if (base) { const c = base[Math.floor(Math.random() * base.length)]; x = c[0] + Math.round(rnd(-7, 7)); y = c[1]; z = c[2] + Math.round(rnd(-7, 7)); }
    else { x = Math.floor(m.position.x + rnd(-10, 10)); z = Math.floor(m.position.z + rnd(-10, 10)); y = Math.floor(m.position.y) - 1; }
    const k = key3(x, y, z);
    if (!ok(k) || !tillable(R, D, x, y, z) || irrigated(D, x, y, z)) continue;
    if (!BF.SOLID[getB(x, y - 1, z)]) continue;
    let walled = true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!BF.SOLID[getB(x + dx, y, z + dz)] || !W().isLoaded(x + dx, z + dz)) { walled = false; break; }
    if (!walled) continue;
    let n = 0;
    for (let dz = -IRRIGATE; dz <= IRRIGATE; dz++) for (let dx = -IRRIGATE; dx <= IRRIGATE; dx++) if ((dx || dz) && tillable(R, D, x + dx, y, z + dz)) n++;
    if (n < 14) continue;
    const s = n - Math.hypot(x - m.position.x, z - m.position.z) * 0.3;
    if (s > bs) { bs = s; best = { kind: "water", x, y, z, k, ty: y + 1 }; }
  }
  return best;
}
// Fill an empty bucket at an infinite water source (two neighbouring sources, solid ground under: it refills at once).
function findFill(m, R, D, ok) {
  const px = m.position.x, pz = m.position.z;
  let best = null, bd = Infinity;
  for (const [x, y, z] of D.water) {
    const k = key3(x, y, z);
    if (!ok(k)) continue;
    let s = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (BF.FLUID[getB(x + dx, y, z + dz)] === 8) s++;
    const below = getB(x, y - 1, z);
    if (s < 2 || !(BF.SOLID[below] || BF.FLUID[below] === 8)) continue;
    const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
    if (d < bd) { bd = d; best = { kind: "fill", x, y, z, k, ty: y + 1 }; }
  }
  return best;
}

// ---------------------------------------------------------------- doing a task
function travel(m, fs, dt, out, tx, ty, tz, speed) {
  const ai = m.ai, N = nav(), px = m.position.x, pz = m.position.z;
  const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
  if (d <= REACH_H && Math.abs(ty - m.position.y) < 1.6) { ai.route = null; fs.navFail = 0; return "arrived"; }
  if (!ai.route || ai.routeKind !== "farm") {
    ai.route = null;
    if (fs.navWait > 0) { fs.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const [fx, fy, fz] = N.feetCell(m);
    const goal = hop
      ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: (x, y, z) => Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1 };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "farm"; fs.navFail = 0; }
    else {
      fs.navFail = (fs.navFail || 0) + 1; fs.navWait = 0.6;
      if (fs.navFail >= (hop ? 5 : 2)) { fs.navFail = 0; return "failed"; }
    }
    return "going";
  }
  const st = N.followRoute(m, dt, out, speed);
  if (st === "stuck") { ai.route = null; fs.navFail = (fs.navFail || 0) + 1; if (fs.navFail >= 3) { fs.navFail = 0; return "failed"; } }
  else if (st === "done") ai.route = null;
  return "going";
}
function newFarm() { return { task: null, stage: null, t: 0, actT: 0, breakT: 0, avoid: {}, stats: { day: -1, farm: 0, total: 0 }, last: null, counts: {} }; }
function endTask(m, fs, success) {
  const t = fs.task;
  if (t) {
    if (claims.get(t.k) === m) claims.delete(t.k);
    if (!success) fs.avoid[t.k] = performance.now() / 1000 + 30;
    fs.last = t.kind;
    if (success) fs.counts[t.kind] = (fs.counts[t.kind] || 0) + 1;
  }
  fs.task = null; fs.stage = null; m.ai.route = null;
  if (success && Math.random() < BREAK_P) fs.breakT = rnd(4, 9);
}
function log(kind, m, data) {
  LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: m.profession + (m.slot ? "#" + m.slot.idx : "") }, data));
  if (LOG.length > 300) LOG.shift();
}
// The work itself. Returns false when the cell changed meanwhile (task dropped).
function perform(m, fs, R, D) {
  const t = fs.task, c = ids(), w = W(), Tinv = TR().inv;
  if (t.kind === "craft") {
    const n = t.hay ? Math.min(Math.floor(cnt(m, c.wheat) / 9), 4) : Math.min(Math.floor(cnt(m, c.wheat) / 3), 16);
    let made = 0;
    for (let i = 0; i < n; i++) {
      const out = t.hay ? c.hay : c.bread, need = t.hay ? 9 : 3;
      if (!Tinv.canFit(m.inv, [{ id: out, n: 1 }], [{ id: c.wheat, n: need }])) break;
      Tinv.remove(m.inv, c.wheat, need); Tinv.add(m.inv, out, 1); made++;
    }
    if (made) log("craft", m, { made: made + " " + (t.hay ? "hay bale" : "bread") });
    return made > 0;
  }
  if (t.kind === "tend") return true;
  if (!w.isLoaded(t.x, t.z) || !freeCellOrFarm(R, D, t)) return false;
  if (t.kind === "harvest") {
    const id = getB(t.x, t.y, t.z);
    if (!c.matureSet.has(id) || getB(t.x, t.y - 1, t.z) !== c.farmland || !dropsFit(m, id)) return false;
    if (!w.setBlock(t.x, t.y, t.z, 0)) return false;
    const drops = BF.rollDrops(id);
    for (const d of drops) Tinv.add(m.inv, d.id, d.count);
    particles(t.x + 0.5, t.y + 0.3, t.z + 0.5, BF.blocks[id].color, 5, 0.6);
    blockSound("break", id, t.x, t.y, t.z);
    m.farm.harvested = (m.farm.harvested || 0) + 1;
    log("harvest", m, { at: [t.x, t.y, t.z], crop: BF.blocks[id].name, got: drops.map(d => d.count + " " + BF.items[d.id].name).join(", ") });
    // replant right away with the matching seed
    const seed = c.mature.get(id);
    if (seed != null && cnt(m, seed) > 0) { fs.next = { kind: "plant", x: t.x, y: t.y, z: t.z, k: t.k, seed }; }
    return true;
  }
  if (t.kind === "plant") {
    if (getB(t.x, t.y - 1, t.z) !== c.farmland || getB(t.x, t.y, t.z) !== 0) return false;
    const seed = t.seed != null && cnt(m, t.seed) > 0 ? t.seed : plantFor(m, t.x, t.y - 1, t.z);
    if (seed == null || cnt(m, seed) < 1) return false;
    const young = BF.items[seed].plants;
    if (young == null || !w.setBlock(t.x, t.y, t.z, young)) return false;
    Tinv.remove(m.inv, seed, 1);
    blockSound("place", young, t.x, t.y, t.z);
    log("plant", m, { at: [t.x, t.y, t.z], seed: BF.items[seed].name });
    return true;
  }
  if (t.kind === "till" || t.kind === "border" || t.kind === "water") {
    if (!tillable(R, D, t.x, t.y, t.z)) return false;
    let place = c.farmland;
    if (t.kind === "border") { place = woodId(m); if (place == null) return false; }
    if (t.kind === "water") { if (cnt(m, c.wbucket) < 1 || irrigated(D, t.x, t.y, t.z)) return false; place = c.water; }
    const above = getB(t.x, t.y + 1, t.z);
    if (above !== 0) {                         // clear the grass / flower on top (its drops go into the inventory)
      for (const d of BF.rollDrops(above)) Tinv.add(m.inv, d.id, d.count);
      w.setBlock(t.x, t.y + 1, t.z, 0);
    }
    const old = getB(t.x, t.y, t.z);
    if (!w.setBlock(t.x, t.y, t.z, place)) return false;
    particles(t.x + 0.5, t.y + 1.02, t.z + 0.5, BF.blocks[old].color, 5, 0.7);
    blockSound("place", place === c.water ? old : place, t.x, t.y, t.z);
    if (t.kind === "till") { D.cells.push([t.x, t.y, t.z]); m.farm.tilled = (m.farm.tilled || 0) + 1; }
    if (t.kind === "border") { Tinv.remove(m.inv, place, 1); m.farm.bordered = (m.farm.bordered || 0) + 1; }
    if (t.kind === "water") {
      Tinv.remove(m.inv, c.wbucket, 1); Tinv.add(m.inv, c.bucket, 1);
      D.water.push([t.x, t.y, t.z]); D.waterSet.add(key3(t.x, t.y, t.z));
      m.farm.watered = (m.farm.watered || 0) + 1;
    }
    log(t.kind, m, { at: [t.x, t.y, t.z], block: BF.blocks[place].name });
    return true;
  }
  if (t.kind === "fill") {
    if (BF.FLUID[getB(t.x, t.y, t.z)] !== 8 || cnt(m, c.bucket) < 1) return false;
    if (!TR().inv.canFit(m.inv, [{ id: c.wbucket, n: 1 }], [{ id: c.bucket, n: 1 }])) return false;
    // an infinite source (2+ source neighbours over solid ground) refills itself on the next fluid tick, as in vanilla
    if (!w.setBlock(t.x, t.y, t.z, 0)) return false;
    Tinv.remove(m.inv, c.bucket, 1); Tinv.add(m.inv, c.wbucket, 1);
    log("fill", m, { at: [t.x, t.y, t.z] });
    return true;
  }
  return false;
}
// farm tasks inside worldgen farm plots are fine for harvest/plant (those are the village fields); new blocks need free ground
function freeCellOrFarm(R, D, t) { return t.kind === "harvest" || t.kind === "plant" || t.kind === "fill" ? inArea(D, t.x, t.z) : freeCell(R, D, t.x, t.z); }

function farmAI(m, dt, out) {
  const R = m.village;
  const D = vdata(R), fs = m.farm || (m.farm = newFarm()), ai = m.ai;
  if (fs.breakT > 0) { fs.breakT -= dt; return false; }
  if (!fs.task) {
    if (fs.next) { fs.task = fs.next; fs.next = null; fs.stage = "act"; fs.actT = ACT[fs.task.kind]; fs.t = 0; claims.set(fs.task.k, m); }
    else {
      fs.thinkT = (fs.thinkT || 0) - dt;
      if (fs.thinkT > 0) return fs.idleWork;      // brief pause between tasks still counts as work
      fs.thinkT = 0.4;
      if (!D.ready) { fs.idleWork = false; return false; }
      const t = think(m, fs, R, D);
      if (!t) { fs.breakT = rnd(5, 10); fs.idleWork = false; return false; }
      fs.task = t; fs.stage = t.kind === "craft" ? "act" : "walk"; fs.t = 0; fs.actT = ACT[t.kind]; fs.navFail = 0; fs.idleWork = true;
      if (t.k) claims.set(t.k, m);
    }
  }
  const t = fs.task;
  fs.t += dt;
  if (fs.t > TASK_MAX) { endTask(m, fs, false); return true; }
  ai.mode = "idle"; ai.t = 2;
  if (fs.stage === "walk") {
    const ty = t.ty != null ? t.ty : t.y;
    const st = travel(m, fs, dt, out, t.x, ty, t.z, m.def.speed * 1.1);
    if (st === "failed") { endTask(m, fs, false); return true; }
    if (st === "arrived") { fs.stage = "act"; fs.actT = t.kind === "tend" ? rnd(2, 4) : ACT[t.kind]; ai.swingT = t.kind === "tend" ? 0 : 0.35; }
    return true;
  }
  // act: face the cell, swing, then do it
  if (t.kind !== "craft") { out.faceX = t.x + 0.5; out.faceZ = t.z + 0.5; m.lookAt = null; }
  fs.actT -= dt;
  if (t.kind === "craft" && ai.swingT <= 0) ai.swingT = 0.35;
  if (fs.actT <= 0) {
    let okDone = false;
    try { okDone = perform(m, fs, R, D); } catch (e) { console.error(e); }
    if (okDone && t.kind !== "tend" && t.kind !== "craft") ai.swingT = 0.35;
    endTask(m, fs, okDone);
  }
  return true;
}

// ---------------------------------------------------------------- buying food from other villagers
const canSell = v2 => v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && Array.isArray(v2.inv);
// Best food purchase from one seller for `want` bread-eq: a real food offer of its trade table, else a fair price from VALUE.
function dealWith(m, v2, want) {
  const F = FD(), T = TR(), em = ids().em, myEm = cnt(m, em);
  const sp = F.surplus(v2);
  if (sp < Math.min(want, 1) || myEm < 1) return null;
  const ed = new Map(F.edible(v2).map(e => [e.id, e.n]));
  let best = null;
  for (const o of v2.trades || []) {
    if (o.buy.length !== 1 || o.buy[0].id !== em || !F.isFood(o.sell.id) || T.blockReason(v2, o)) continue;
    const per = F.breadEq(o.sell.id) * o.sell.n;
    if ((ed.get(o.sell.id) || 0) < o.sell.n || per > sp) continue;
    let k = Math.min(Math.ceil(want / per), Math.floor(myEm / o.buy[0].n), Math.floor(sp / per), Math.floor((ed.get(o.sell.id) || 0) / o.sell.n), 4);
    while (k > 0 && !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n * k }], [{ id: em, n: o.buy[0].n * k }])) k--;
    if (k < 1) continue;
    const price = o.buy[0].n / per;
    if (!best || price < best.price) best = { seller: v2, offer: o, times: k, price, item: o.sell.id };
  }
  if (best) return best;
  // no matching offer: 1 emerald buys ~90% of an emerald's worth of its most plentiful food (VALUE table)
  const V = T.VALUE;
  const items = F.edible(v2).sort((a, b) => b.n * b.eq - a.n * a.eq);
  for (const e of items) {
    const val = V[BF.items[e.id].name] || 0.2;
    const n = Math.min(Math.max(1, Math.floor(0.9 / val)), e.n, Math.floor(sp / e.eq));
    if (n < 1 || n * e.eq < Math.min(want, 0.6)) continue;
    let k = Math.min(Math.ceil(want / (n * e.eq)), myEm, Math.floor(sp / (n * e.eq)), Math.floor(e.n / n), 4);
    while (k > 0 && !T.inv.canFit(m.inv, [{ id: e.id, n: n * k }], [{ id: em, n: k }])) k--;
    if (k < 1) continue;
    return { seller: v2, fair: { id: e.id, n }, times: k, price: 1 / (n * e.eq), item: e.id };
  }
  return null;
}
function findFoodSeller(m) {
  const R = m.village, F = FD(), want = SHOP_DAYS * F.rate(m) - F.available(m), now = dayNow();
  if (!R || want <= 0) return null;
  const sh = m.fshop;
  let best = null, bs = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2) || (sh.avoid[v2.slot ? v2.slot.idx : -1] || 0) > now) continue;
    const d = dealWith(m, v2, want);
    if (!d) continue;
    const s = v2.position.distanceTo(m.position) * (v2.profession === "farmer" ? 0.5 : 1);
    if (s < bs) { bs = s; best = d; }
  }
  return best;
}
function doFoodDeal(m, deal) {
  const T = TR(), F = FD(), v2 = deal.seller, em = ids().em;
  let done = 0, item = deal.item, n = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(v2)) break;
    if (deal.offer) {
      const o = deal.offer, per = F.breadEq(o.sell.id) * o.sell.n;
      if (F.surplus(v2) < per || T.blockReason(v2, o) || cnt(m, em) < o.buy[0].n) break;
      if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
      if (!T.exchange(v2, o)) break;                 // the seller's stock and room, as for a player trade
      T.inv.remove(m.inv, em, o.buy[0].n);
      T.inv.add(m.inv, o.sell.id, o.sell.n);
      T.addXp(v2, o);
      n += o.sell.n;
    } else {
      const f = deal.fair, per = F.breadEq(f.id) * f.n;
      if (F.surplus(v2) < per || cnt(m, em) < 1 || T.inv.count(v2.inv, f.id) < f.n) break;
      if (!T.inv.canFit(m.inv, [{ id: f.id, n: f.n }], [{ id: em, n: 1 }]) || !T.inv.canFit(v2.inv, [{ id: em, n: 1 }], [{ id: f.id, n: f.n }])) break;
      T.inv.remove(v2.inv, f.id, f.n); T.inv.add(v2.inv, em, 1);
      T.inv.remove(m.inv, em, 1); T.inv.add(m.inv, f.id, f.n);
      n += f.n;
    }
    done++;
  }
  if (done) {
    const paid = deal.offer ? deal.offer.buy[0].n * done : done;
    log("buyFood", m, { from: v2.profession + (v2.slot ? "#" + v2.slot.idx : ""), got: n + " " + BF.items[item].name, paid: paid + " emerald" });
    if (BF.emit) BF.emit("villagerFoodTrade", m, v2, item, n);
  }
  return done;
}
function shopAI(m, dt, out) {
  const F = FD(), sh = m.fshop || (m.fshop = { stage: null, deal: null, checkT: rnd(0, 3), avoid: {}, cd: 0 }), ai = m.ai;
  if (!sh.stage) {
    sh.checkT -= dt;
    if (sh.checkT > 0) return false;
    sh.checkT = 3;
    const now = dayNow();
    if (sh.cd > now || m.child || F.available(m) >= F.rate(m) || cnt(m, ids().em) < 1) return false;
    const deal = findFoodSeller(m);
    if (!deal) { sh.cd = now + 0.08; return false; }
    sh.deal = deal; sh.stage = "walk"; sh.walkT = 0; sh.navFail = 0; ai.route = null;
  }
  const deal = sh.deal, v2 = deal && deal.seller;
  const giveUp = () => { sh.avoid[v2 && v2.slot ? v2.slot.idx : -1] = dayNow() + 0.05; sh.stage = null; sh.deal = null; ai.route = null; sh.checkT = 0.5; return false; };
  if (!v2 || !canSell(v2)) return giveUp();
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  ai.mode = "idle"; ai.t = 2;
  if (sh.stage === "walk") {
    sh.walkT += dt;
    if (sh.walkT > 60) return giveUp();
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { sh.stage = "trade"; sh.tt = TRADE_PAUSE; ai.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (sh.gx == null || Math.hypot(sh.gx - g.x, sh.gz - g.z) > 3) { if (ai.routeKind === "farm") ai.route = null; sh.gx = g.x; sh.gz = g.z; }
    const st = travel(m, sh, dt, out, g.x, g.y, g.z, m.def.speed * 1.3);
    if (st === "failed") return giveUp();
    return true;
  }
  // trade: both stand facing each other for a moment, then the goods change hands
  sh.tt -= dt;
  if (d > 3.6) { sh.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (sh.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) ai.swingT = 0.2;
  if (sh.tt <= 0) {
    const done = doFoodDeal(m, deal);
    sh.stage = null; sh.deal = null; sh.gx = null; sh.checkT = 1;
    if (!done) sh.avoid[v2.slot ? v2.slot.idx : -1] = dayNow() + 0.05;
    else { particles(m.position.x, m.position.y + 1.5, m.position.z, "#2fd06a", 5, 0.4); sound("villager_trade", m.position.x, m.position.y + 1.5, m.position.z, 0.5); F.digest(m, dayNow()); }
  }
  return true;
}

// ---------------------------------------------------------------- entry points
// Called from villagerAI (mobs.js) after the trading freeze, flee, bedtime and morning logic, before the builder AI.
function ai(m, dt, out) {
  if (!m.inv || m.dead || !BF.mobs || !BF.mobs.nav) return false;
  if (skyT() >= WORK_END) {
    if (m.farm && m.farm.task) endTask(m, m.farm, true);
    if (m.fshop && m.fshop.stage) { m.fshop.stage = null; m.fshop.deal = null; m.ai.route = null; }
    return false;
  }
  if (shopAI(m, dt, out)) { if (m.farm && m.farm.task) endTask(m, m.farm, true); return true; }
  if (m.profession === "farmer" && m.village && !m.child) return farmAI(m, dt, out);
  return false;
}
let acc = 0;
const isWorking = m => !!((m.farm && (m.farm.task || (m.farm.idleWork && m.farm.thinkT > 0))) || m.tradingWith);
function tick(dt) {
  updateParticles(dt);
  acc += dt;
  if (acc < 0.5 || !BF.mobs || !BF.food) return;
  const step = acc; acc = 0;
  const now = dayNow(), t = skyT(), day = BF.sky ? BF.sky.day || 0 : 0;
  const scanned = new Set();
  for (const m of BF.mobs.list) {
    if (m.type !== "villager" || m.dead || m.removed || !Array.isArray(m.inv)) continue;
    try { FD().digest(m, now); } catch (e) { console.error(e); }
    cookDaily(m, day);
    if (m.profession === "farmer" && m.village) {
      const fs = m.farm || (m.farm = newFarm());
      if (fs.stats.day !== day) { if (fs.stats.day >= 0) fs.prev = fs.stats; fs.stats = { day, farm: 0, total: 0 }; }
      if (t < 0.5 && !m.sleeping && !(m.ai && m.ai.leaving)) { fs.stats.total += step; if (isWorking(m)) fs.stats.farm += step; }
      if (!scanned.has(m.village)) { scanned.add(m.village); scanStep(m.village, vdata(m.village), SCAN_COLS); }
    }
  }
}
// Butchers and fishermen cook the raw meat / fish they hold (conversion, nothing is created): up to 8 a day.
function cookDaily(m, day) {
  if (m.profession !== "butcher" && m.profession !== "fisherman") return;
  const L = FD().life(m);
  if (L.cookDay === day) return;
  L.cookDay = day;
  let left = 8;
  for (const [raw, cooked] of ids().cook) {
    if (left <= 0) break;
    const n = Math.min(left, cnt(m, raw));
    for (let i = 0; i < n; i++) {
      if (!TR().inv.canFit(m.inv, [{ id: cooked, n: 1 }], [{ id: raw, n: 1 }])) break;
      TR().inv.remove(m.inv, raw, 1); TR().inv.add(m.inv, cooked, 1); left--;
    }
  }
}
const NAMES = { harvest: "Harvesting", plant: "Planting", till: "Tilling farmland", border: "Edging a bed", water: "Watering a new bed", fill: "Filling a bucket", craft: "Baking bread", tend: "Tending crops" };
function statusText(m) {
  if (!m) return "";
  if (m.starving) return "Too hungry to trade";
  if (m.fshop && m.fshop.stage) return "Buying food";
  if (m.profession === "farmer" && m.farm && m.farm.task && !m.sleeping) {
    const t = m.farm.task;
    if (t.kind === "craft" && t.hay) return "Making hay bales";
    const b = t.kind === "harvest" || t.kind === "plant" ? BF.blocks[getB(t.x, t.y, t.z)] : null;
    return NAMES[t.kind] + (t.kind === "harvest" && b && b.name ? " " + b.name : "");
  }
  if (FD().available(m) < FD().rate(m)) return "Hungry";
  return "";
}
function stats(m) {
  const fs = m && m.farm;
  if (!fs) return null;
  const s = fs.stats, p = fs.prev;
  return { today: s && s.total ? s.farm / s.total : 0, yesterday: p && p.total ? p.farm / p.total : null, farm: s.farm, total: s.total, counts: fs.counts,
    harvested: fs.harvested || 0, tilled: fs.tilled || 0, bordered: fs.bordered || 0, watered: fs.watered || 0, task: fs.task && fs.task.kind };
}
function reset() { claims.clear(); LOG.length = 0; for (const p of pool) BF.scene && BF.scene.remove(p.mesh); pool.length = 0; acc = 0; }

// ---------------------------------------------------------------- the player's buckets (hooked from player.js right-click)
// Empty bucket: scoops the water source the player looks at (an infinite source refills). Water bucket: pours a source against
// the targeted face. Creative mode keeps the bucket as it is. Returns true when it did something.
function useBucket(it, target) {
  const c = ids(), P = BF.player, inv = BF.inventory, w = W();
  if (!it || (it.id !== c.bucket && it.id !== c.wbucket) || !P || !inv) return false;
  const creative = P.gameMode === "creative";
  const swap = to => {
    if (creative) return;
    inv.consumeSelected(1);
    const left = inv.add(to, 1);
    if (left > 0 && BF.drops) BF.drops.spawn(to, left, P.position.x, P.position.y + 1, P.position.z);
  };
  if (it.id === c.bucket) {
    const hit = w.raycast(P.eyePos(), P.lookDir(), 5, id => id !== 0 && (BF.FLUID[id] === 8 || BF.RENDER[id] !== 3));
    if (!hit || BF.FLUID[hit.id] !== 8 || !w.setBlock(hit.x, hit.y, hit.z, 0)) return false;
    swap(c.wbucket);
    sound("splash", hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.5);
    return true;
  }
  if (!target) return false;
  let x = target.x, y = target.y, z = target.z, cur = target.id;
  if (!(BF.REPLACEABLE[cur] && !BF.FLUID[cur])) { x += target.normal[0]; y += target.normal[1]; z += target.normal[2]; cur = w.getBlock(x, y, z); }
  if (BF.FLUID[cur] === 8 || !(cur === 0 || (BF.REPLACEABLE[cur] && !BF.SOLID[cur]))) return false;
  if (!w.setBlock(x, y, z, c.water)) return false;
  swap(c.bucket);
  if (BF.emit) BF.emit("blockPlaced", x, y, z, c.water);   // audio: splash
  return true;
}

// ---------------------------------------------------------------- bucket items: sprites + recipe
if (BF.texKit) {
  const K = BF.texKit, { SPRITES, put, hex, mul, mix, WHITE } = K;
  const pail = (G, m, inner) => {
    const hi = mix(m, WHITE, 0.35), lo = mul(m, 0.7);
    for (let y = 5; y <= 13; y++) {
      const half = 6 - Math.round((y - 5) * 2 / 8);
      for (let x = 8 - half; x <= 7 + half; x++) put(G, x, y, x === 8 - half ? hi : x === 7 + half ? lo : y === 13 ? lo : m);
    }
    for (let x = 2; x <= 13; x++) put(G, x, 5, hi);
    for (let x = 3; x <= 12; x++) put(G, x, 6, inner);
    for (const [x, y] of [[2, 4], [3, 2], [4, 1], [5, 1], [10, 1], [11, 1], [12, 2], [13, 4], [2, 3], [13, 3]]) put(G, x, y, lo);
    for (let x = 6; x <= 9; x++) put(G, x, 0, lo);
  };
  SPRITES.bucket = (G, m) => pail(G, m, mul(m, 0.45));
  SPRITES.water_bucket = (G) => pail(G, hex("#c8c8c8"), hex("#3f76e4"));
}
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped }) => {
  if (BF.I.bucket == null) return;
  addShaped(BF.I.bucket, 1, ["I I", " I "], { I: BF.I.iron_ingot }, "3 Iron Ingots in a V → Bucket");
});

BF.villageLife = { ai, tick, statusText, stats, reset, useBucket, log: LOG, vdata, think, claims, WORK_END, TILL_PER_FARMER,
  _test: { findTill, findBorder, findWaterSpot, findFill, perform, dealWith, findFoodSeller, scanStep } };
})();
