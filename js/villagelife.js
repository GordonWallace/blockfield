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
const ACT = { harvest: 0.55, plant: 0.45, till: 0.9, border: 0.75, water: 0.9, fill: 0.9, craft: 1.6, tend: 3.0, dig: 0.7, raise: 0.5, gather: 0.9 };
const TASK_MAX = 45;              // seconds before an unfinished task is given up
const BREAK_P = 0.05;             // chance of a short break after a task (the rest of the day is farming)
const SCAN_COLS = 500;            // columns of the village area scanned per tick
const RESCAN = 10;                // seconds between village farm scans
const IRRIGATE = 4;               // farmland needs a water source within 4 blocks (same level), like vanilla
const FARM_R = 12;                // a farmer only tends (and makes) farmland within 12 blocks, in every direction, of its composter
const FARM_MAX = 64;              // farmland cells within that range a farmer is content with: it only adds beds below this
const PLOT_R = 4;                 // a new farm is a 9x9 plot around one water block (water irrigates 4 blocks)
const WATER_REACH = 30;           // buckets are filled at water this far (~30 blocks) around the village area, wells included
const GATHER_R = 24;              // dirt and logs are taken from up to this far outside the village area, never from inside it
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
    dirt: B("dirt"), hoes: ["wooden_hoe", "stone_hoe", "iron_hoe", "diamond_hoe"].map(I).filter(x => x != null),
    // natural ground a farmer may dig away (or fill with dirt) to level a field; everything else is somebody's building or the landscape
    ground: new Set(["grass", "dirt", "coarse_dirt", "podzol", "snow_grass", "mycelium", "sand", "red_sand", "gravel", "clay", "dirt_path", "farmland"].map(B).filter(x => x != null)),
    diggable: new Set(["grass", "dirt", "coarse_dirt", "podzol", "snow_grass"].map(B).filter(x => x != null)),
    wheat: I("wheat_item"), bread: I("bread"), hay: I("hay_bale"), bucket: I("bucket"), wbucket: I("water_bucket"), em: I("emerald"),
    cook: [["raw_chicken", "cooked_chicken"], ["raw_porkchop", "cooked_porkchop"], ["raw_beef", "steak"], ["raw_mutton", "cooked_mutton"], ["raw_cod", "cooked_cod"]]
      .map(([a, b]) => [I(a), I(b)]).filter(([a, b]) => a != null && b != null),
  };
  C.matureSet = new Set(C.mature.keys());
  return C;
}
const cnt = (m, id) => (id == null ? 0 : TR().inv.count(m.inv, id));
const hasHoe = m => ids().hoes.some(id => cnt(m, id) > 0);
const isLogBlock = id => { const b = BF.blocks[id]; return !!b && /_log$/.test(b.name) && !/^stripped_/.test(b.name); };
function woodCount(m) { let n = 0; for (const s of m.inv) if (s && BF.items[s.id] && BF.items[s.id].isBlock && /(_log|planks)$/.test(BF.items[s.id].name)) n += s.count; return n; }
// A new farmer gets an empty bucket (and a hoe), a new builder an empty bucket: water is only ever placed from a bucket that was filled first.
function ensureKit(m) {
  if (!m || !Array.isArray(m.inv) || (m.profession !== "farmer" && m.profession !== "builder") || m.kitFor === m.profession) return;
  m.kitFor = m.profession;
  const c = ids(), Tinv = TR().inv;
  if (c.bucket != null && cnt(m, c.bucket) + cnt(m, c.wbucket) === 0) Tinv.add(m.inv, c.bucket, 1);
  if (m.profession === "farmer" && c.hoes.length && !hasHoe(m)) Tinv.add(m.inv, c.hoes[Math.min(1, c.hoes.length - 1)], 1);
}
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
  R._life = { area: A, base: Object.assign({}, A), boxes, farmBase, cells: [], water: [], waterSet: new Set(), wells: new Set(), ready: false, scan: null, scanT: 0, want: 0 };
  return R._life;
}
// The farmer's reach box (composter +-12) must lie inside the scanned area (a composter placed outside the village grounds); a wider area is rescanned.
function ensureCover(D, m) {
  const s = m.jobsite, A = D.area;
  if (!s) return;
  const x0 = s.x - FARM_R - 1, x1 = s.x + FARM_R + 1, z0 = s.z - FARM_R - 1, z1 = s.z + FARM_R + 1, yLo = s.y - FARM_R, yHi = s.y + FARM_R;
  if (x0 >= A.x0 && x1 <= A.x1 && z0 >= A.z0 && z1 <= A.z1 && yLo >= A.yLo && yHi <= A.yHi) return;
  D.area = { x0: Math.min(A.x0, x0), x1: Math.max(A.x1, x1), z0: Math.min(A.z0, z0), z1: Math.max(A.z1, z1), yLo: Math.min(A.yLo, yLo), yHi: Math.max(A.yHi, yHi) };
  D.ready = false; D.scan = null; D.scanT = 0;
}
// the farmland / water cell (x, y, z) is within 12 blocks of the farmer's composter in every direction
const inRange = (m, x, y, z) => { const s = m.jobsite; return !!s && Math.abs(x - s.x) <= FARM_R && Math.abs(z - s.z) <= FARM_R && Math.abs(y - s.y) <= FARM_R; };
// inside the village proper (its buildings and 6 blocks around): nothing is dug or felled there for materials
const inVillage = (D, x, z) => { const b = D.base; return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1; };
// top-most water source of an open column outside the village (lake, pond, river), or null
function surfaceWater(w, x, z) {
  const h = w.heightAt(x, z);
  if (h < 0) return null;
  let top = null;
  for (let y = h + 1; y < h + 40 && BF.FLUID[w.getBlock(x, y, z)]; y++) if (BF.FLUID[w.getBlock(x, y, z)] === 8) top = y;
  return top;
}
// water cells of the village well (generated) and of wells the builders made; they sit under a roof, so the top-down scan misses them
function wellCells(R) {
  const out = [], wg = R.wg || {};
  if (Number.isFinite(wg.x) && Number.isFinite(wg.y) && Number.isFinite(wg.z)) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) out.push([wg.x + dx, wg.y, wg.z + dz]);
  if (BF.builder && BF.builder.builtOf) for (const e of BF.builder.builtOf(R) || []) if (e.type === "well" && e.state === "done") out.push([e.ox + 1, e.oy + 1, e.oz + 1]);
  return out;
}
function inArea(D, x, z) { const A = D.area; return x >= A.x0 && x <= A.x1 && z >= A.z0 && z <= A.z1; }
function freeCell(R, D, x, z) {
  if (!inArea(D, x, z)) return false;
  for (const b of D.boxes) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return false;
  if (BF.builder && BF.builder.builtOf) for (const e of BF.builder.builtOf(R) || []) if (x >= e.ox - 1 && x <= e.ox + e.w && z >= e.oz - 1 && z <= e.oz + e.d) return false;
  return true;
}
// One pass over the village area (farmland + water, top-down) and the ring of WATER_REACH blocks around it (water only), `budget` columns per call.
function scanStep(R, D, budget) {
  const w = W(), c = ids();
  if (!D.scan) {
    if (performance.now() / 1000 < D.scanT) return;
    const A = D.area;
    D.scan = { x: A.x0 - WATER_REACH, z: A.z0 - WATER_REACH, A, e: { x0: A.x0 - WATER_REACH, x1: A.x1 + WATER_REACH, z1: A.z1 + WATER_REACH }, cells: [], water: [] };
  }
  const S = D.scan, A = S.A;
  while (budget-- > 0) {
    if (w.isLoaded(S.x, S.z)) {
      if (S.x >= A.x0 && S.x <= A.x1 && S.z >= A.z0 && S.z <= A.z1) {
        for (let y = A.yHi; y >= A.yLo; y--) {
          const id = w.getBlock(S.x, y, S.z);
          if (id === 0 || BF.RENDER[id] === 4) continue;
          if (BF.FLUID[id] === 8) S.water.push([S.x, y, S.z]);
          else if (id === c.farmland) S.cells.push([S.x, y, S.z]);
          break;
        }
      } else {
        const top = surfaceWater(w, S.x, S.z);
        if (top != null) S.water.push([S.x, top, S.z]);
      }
    }
    if (++S.x > S.e.x1) {
      S.x = S.e.x0;
      if (++S.z > S.e.z1) {
        D.wells = new Set();
        for (const [x, y, z] of wellCells(R)) if (w.isLoaded(x, z) && BF.FLUID[w.getBlock(x, y, z)] === 8) { D.wells.add(key3(x, y, z)); if (!S.water.some(p => p[0] === x && p[1] === y && p[2] === z)) S.water.push([x, y, z]); }
        D.cells = S.cells; D.water = S.water; D.waterSet = new Set(S.water.map(p => key3(...p)));
        D.ready = true; D.scan = null; D.scanT = performance.now() / 1000 + RESCAN;
        return;
      }
    }
  }
}
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
const tillable = (R, D, x, y, z, m) => W().isLoaded(x, z) && (!m || inRange(m, x, y, z)) && freeCell(R, D, x, z) && ids().till.has(getB(x, y, z)) && openAbove(x, y, z);

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
const CROP_CAP = 64;              // a farmer stops harvesting a crop while it holds a full stack of it (sold or eaten first)
function dropsFit(m, cropId) {
  const c = ids(), seed = c.mature.get(cropId), main = BF.blocks[cropId].drop;
  if (cnt(m, main) >= CROP_CAP) return false;
  const adds = [{ id: main, n: 4 }];
  if (seed !== main) adds.push({ id: seed, n: 3 });
  return TR().inv.canFit(m.inv, adds, []);
}
// The drops of a harvested crop go into the inventory; spare seeds beyond a stack go on the compost heap.
function collectDrops(m, id) {
  const Tinv = TR().inv, drops = BF.rollDrops(id);
  for (const d of drops) Tinv.add(m.inv, d.id, d.count);
  for (const d of drops) {
    const it = BF.items[d.id], extra = it && it.plants != null && !it.food ? cnt(m, d.id) - CROP_CAP : 0;
    if (extra > 0) Tinv.remove(m.inv, d.id, extra);
  }
  return drops;
}
// Far-village catch-up (js/villagesim.js): a farmer harvests and replants the mature crops around its jobsite (60 a game day, at most 160),
// as much as it would have got done while the village was out of range.
const FARM_CATCHUP_PER_DAY = 60, FARM_CATCHUP_MAX = 160;
function catchUp(m, rec, away) {
  if (m.profession !== "farmer" || !m.jobsite || !m.inv || !W()) return;
  const c = ids(), w = W(), s = m.jobsite;
  let budget = Math.min(FARM_CATCHUP_MAX, Math.floor(away * FARM_CATCHUP_PER_DAY)), got = 0;
  for (let x = s.x - FARM_R; x <= s.x + FARM_R && budget > 0; x++) for (let z = s.z - FARM_R; z <= s.z + FARM_R && budget > 0; z++) {
    if (!w.isLoaded(x, z)) continue;
    for (let y = s.y - FARM_R; y <= s.y + FARM_R && budget > 0; y++) {
      const id = getB(x, y, z);
      if (!c.matureSet.has(id) || getB(x, y - 1, z) !== c.farmland || !dropsFit(m, id)) continue;
      if (!w.setBlock(x, y, z, 0)) continue;
      collectDrops(m, id);
      m.farm = m.farm || newFarm();
      m.farm.harvested = (m.farm.harvested || 0) + 1;
      const seed = c.mature.get(id), young = seed != null && cnt(m, seed) > 0 ? BF.items[seed].plants : null;
      if (young != null && w.setBlock(x, y, z, young)) TR().inv.remove(m.inv, seed, 1);
      budget--; got++;
    }
  }
  if (got) log("catchup", m, { harvested: got });
}
if (BF.villageSim) BF.villageSim.onCatchUp(catchUp);

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
  // a trip for materials (dirt / logs from outside the village) goes on until the farmer carries enough
  if (fs.haul) {
    const h = fs.haul, have = h.what === "dirt" ? cnt(m, c.dirt) : woodCount(m);
    if (have < h.n) { const g = findGather(m, D, h.what, ok); if (g) return g; }
    fs.haul = null;
  }
  // harvest mature crops / plant empty farmland, only within 12 blocks of the composter: nearest first
  const cells = D.cells.filter(p => inRange(m, p[0], p[1], p[2]));
  let best = null, bd = Infinity, fits = new Map(), hasSeed = c.seeds.some(id => cnt(m, id) > 0);
  const young = [];
  for (const [x, y, z] of cells) {
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
  // nothing to harvest or plant: make more farmland (till near water with the hoe, border with wood, carry water)
  const room = cells.length < FARM_MAX;
  let exp = room && hasHoe(m) ? findTill(m, R, D, ok) : null;
  const b = findBorder(m, R, D, ok);
  if (b) {
    if (woodId(m) != null && (!exp || dist(b.x, b.z) < dist(exp.x, exp.z) + 2)) exp = b;   // with wood: edge the beds as they grow (nearest of the two jobs)
    else if (woodId(m) == null && !exp) { fs.haul = { what: "log", n: 8 }; const g = findGather(m, D, "log", ok); if (g) return g; fs.haul = null; }   // logs as needed, from the trees around the village
  }
  if (exp) return exp;
  if (!cells.length) {                                    // no farmland within reach of the composter at all: make a farm
    const t = planTask(m, fs, R, D, ok);
    if (t) return t;
  } else if (room && (cnt(m, c.wbucket) > 0 || cnt(m, c.bucket) > 0)) {
    const spot = findWaterSpot(m, R, D, ok, cells);
    if (spot) {
      if (cnt(m, c.wbucket) > 0) return spot;
      const f = findFill(m, D, ok);
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
  const px = m.position.x, pz = m.position.z, s = m.jobsite, fset = new Set(D.cells.map(p => key3(...p)));
  const waters = D.water.filter(p => Math.abs(p[0] - s.x) <= FARM_R + IRRIGATE && Math.abs(p[2] - s.z) <= FARM_R + IRRIGATE)
    .sort((a, b) => Math.hypot(a[0] - px, a[2] - pz) - Math.hypot(b[0] - px, b[2] - pz)).slice(0, 48);
  let best = null, bs = Infinity;
  const seen = new Set();
  for (const [wx, wy, wz] of waters) for (let dz = -IRRIGATE; dz <= IRRIGATE; dz++) for (let dx = -IRRIGATE; dx <= IRRIGATE; dx++) {
    const x = wx + dx, z = wz + dz, y = wy, k = key3(x, y, z);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!ok(k) || !tillable(R, D, x, y, z, m)) continue;
    let adj = 0;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (fset.has(key3(x + ax, y, z + az))) adj++;
    const sc = Math.hypot(x + 0.5 - px, z + 0.5 - pz) - adj * 6;
    if (sc < bs) { bs = sc; best = { kind: "till", x, y, z, k, ty: y + 1 }; }
  }
  return best;
}
function findBorder(m, R, D, ok) {
  const px = m.position.x, pz = m.position.z;
  let best = null, bd = Infinity;
  for (const [x, y, z] of D.cells) {
    if (!inRange(m, x, y, z)) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, k = key3(nx, y, nz);
      if (!ok(k) || !tillable(R, D, nx, y, nz, m) || irrigated(D, nx, y, nz)) continue;
      const d = Math.hypot(nx + 0.5 - px, nz + 0.5 - pz);
      if (d < bd) { bd = d; best = { kind: "border", x: nx, y, z: nz, k, ty: y + 1 }; }
    }
  }
  return best;
}
// A new irrigation hole: a ground cell walled in on all four sides (so the water stays put), next to the existing beds,
// with no water yet within reach and plenty of tillable ground around it.
function findWaterSpot(m, R, D, ok, base) {
  let best = null, bs = -Infinity;
  for (let t = 0; t < 70; t++) {
    const c = base[Math.floor(Math.random() * base.length)];
    const x = c[0] + Math.round(rnd(-7, 7)), y = c[1], z = c[2] + Math.round(rnd(-7, 7));
    const k = key3(x, y, z);
    if (!ok(k) || !tillable(R, D, x, y, z, m) || irrigated(D, x, y, z)) continue;
    if (!BF.SOLID[getB(x, y - 1, z)]) continue;
    let walled = true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!BF.SOLID[getB(x + dx, y, z + dz)] || !W().isLoaded(x + dx, z + dz)) { walled = false; break; }
    if (!walled) continue;
    let n = 0;
    for (let dz = -IRRIGATE; dz <= IRRIGATE; dz++) for (let dx = -IRRIGATE; dx <= IRRIGATE; dx++) if ((dx || dz) && tillable(R, D, x + dx, y, z + dz, m)) n++;
    if (n < 14) continue;
    const s = n - Math.hypot(x - m.position.x, z - m.position.z) * 0.3;
    if (s > bs) { bs = s; best = { kind: "water", x, y, z, k, ty: y + 1 }; }
  }
  return best;
}
// ---------------------------------------------------------------- water for the buckets
// A source refills when two neighbouring cells are sources over solid ground / source (like vanilla, and the village wells): taking it leaves no hole.
function infiniteSource(x, y, z) {
  let s = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (BF.FLUID[getB(x + dx, y, z + dz)] === 8) s++;
  const below = getB(x, y - 1, z);
  return s >= 2 && (BF.SOLID[below] || BF.FLUID[below] === 8);
}
// A cell to stand on within 2 blocks of the water cell (the village well is walled in: the bucket is dipped over the wall), nearest to the mob.
function standFor(m, x, y, z) {
  const N = nav(), w = W();
  let best = null, bs = Infinity;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    if (!dx && !dz) continue;
    for (let dy = -1; dy <= 2; dy++) {
      const sx = x + dx, sy = y + dy, sz = z + dz;
      if (!w.isLoaded(sx, sz) || !N.walkCell(sx, sy, sz)) continue;
      const sc = Math.hypot(dx, dz) * 4 + Math.hypot(sx + 0.5 - m.position.x, sz + 0.5 - m.position.z) * 0.1 + Math.abs(dy - 1);
      if (sc < bs) { bs = sc; best = { sx, sy, sz }; }
    }
  }
  return best;
}
// The nearest water source (any source of the scanned ring around the village: lake, pond, well) with a place to stand: {x, y, z, sx, sy, sz} or null.
function findFill(m, D, ok) {
  const px = m.position.x, pz = m.position.z, near = [];
  for (const [x, y, z] of D.water) {                       // the 12 nearest sources
    const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
    if (near.length >= 12 && d >= near[near.length - 1][0]) continue;
    let i = near.length;
    while (i > 0 && near[i - 1][0] > d) i--;
    near.splice(i, 0, [d, x, y, z]);
    if (near.length > 12) near.pop();
  }
  for (const [, x, y, z] of near) {
    const k = key3(x, y, z);
    if (ok && !ok(k)) continue;
    if (BF.FLUID[getB(x, y, z)] !== 8) continue;
    const st = standFor(m, x, y, z);
    if (st) return { kind: "fill", x, y, z, k, ty: y + 1, sx: st.sx, sy: st.sy, sz: st.sz };
  }
  return null;
}
// Dips the empty bucket in the source (x, y, z): full bucket, and the block is taken only when it refills (so no lake or well is ever drained).
function fillBucket(m, x, y, z) {
  const c = ids(), Tinv = TR().inv, w = W();
  if (BF.FLUID[getB(x, y, z)] !== 8 || cnt(m, c.bucket) < 1) return false;
  if (!Tinv.canFit(m.inv, [{ id: c.wbucket, n: 1 }], [{ id: c.bucket, n: 1 }])) return false;
  if (infiniteSource(x, y, z) && !w.setBlock(x, y, z, 0)) return false;
  Tinv.remove(m.inv, c.bucket, 1); Tinv.add(m.inv, c.wbucket, 1);
  sound("splash", x + 0.5, y + 0.5, z + 0.5, 0.4);
  return true;
}
const wantVillages = new Set();   // villages whose water ring is scanned for builders although no farmer works there
// For js/builder.js: the nearest water source (within ~30 blocks of the village, wells included) with a stand cell, or null (also while the village is still being scanned).
function findWater(m, R) {
  const D = vdata(R);
  D.want = performance.now() / 1000; wantVillages.add(R);
  return D.ready ? findFill(m, D, null) : null;
}

// ---------------------------------------------------------------- materials from outside the village
// What to take: "dirt" = the top block of open ground (grass, dirt ...), "log" = the base log of a tree. Never inside the village (buildings + 6 blocks around).
function findGather(m, D, what, ok) {
  const c = ids(), w = W(), b0 = D.base, px = m.position.x, pz = m.position.z;
  let best = null, bd = Infinity;
  for (let t = 0; t < 120; t++) {
    const x = Math.floor(rnd(b0.x0 - GATHER_R, b0.x1 + GATHER_R + 1)), z = Math.floor(rnd(b0.z0 - GATHER_R, b0.z1 + GATHER_R + 1));
    if (inVillage(D, x, z) || !w.isLoaded(x, z)) continue;
    const h = w.heightAt(x, z);
    if (h < 1) continue;
    let y = -1;
    if (what === "dirt") {
      const a = getB(x, h + 1, z);
      if (c.diggable.has(getB(x, h, z)) && (a === 0 || (BF.REPLACEABLE[a] && !BF.SOLID[a] && !BF.FLUID[a]))) y = h;
    } else {
      for (let yy = h; yy > h - 16 && yy > 1; yy--) if (isLogBlock(getB(x, yy, z))) { y = yy; while (y > 1 && isLogBlock(getB(x, y - 1, z))) y--; break; }
      if (y >= 0 && !BF.SOLID[getB(x, y - 1, z)]) y = -1;
    }
    if (y < 0 || (ok && !ok(key3(x, y, z)))) continue;
    const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
    if (d < bd) { bd = d; best = { kind: "gather", what, x, y, z, k: key3(x, y, z), ty: what === "dirt" ? y + 1 : y }; }
  }
  return best;
}

// ---------------------------------------------------------------- making a farm (no farmland within 12 blocks of the composter)
const tillOK = (c, id) => c.till.has(id) || id === c.farmland;
const looseAbove = id => id === 0 || (BF.REPLACEABLE[id] && !BF.SOLID[id] && !BF.FLUID[id]);
// Cost of a 9x9 plot around (cx, cz) levelled to height cy: the number of blocks to dig or fill, or null when it does not fit (a building / box, loaded-ness,
// out of reach of the composter, something other than natural ground in the column, water, a slope of more than 2).
function plotCost(m, R, D, cx, cy, cz) {
  const c = ids(), w = W();
  let ops = 0;
  for (let dz = -PLOT_R; dz <= PLOT_R; dz++) for (let dx = -PLOT_R; dx <= PLOT_R; dx++) {
    const x = cx + dx, z = cz + dz;
    if (!w.isLoaded(x, z) || !freeCell(R, D, x, z) || !inRange(m, x, cy, z)) return null;
    const top = w.heightAt(x, z), b = top < 0 ? 0 : getB(x, top, z);
    if (!c.ground.has(b) || !looseAbove(getB(x, top + 1, z)) || BF.FLUID[getB(x, top + 1, z)]) return null;
    if (Math.abs(top - cy) > 2) return null;
    if (top > cy) {                                           // dig down to cy: only soil on the way, tillable at the bottom
      for (let y = top; y > cy; y--) if (!c.ground.has(getB(x, y, z))) return null;
      if (!tillOK(c, getB(x, cy, z))) return null;
      ops += top - cy;
    } else if (top < cy) {
      if (!BF.SOLID[b]) return null;
      ops += cy - top;
    } else if (!tillOK(c, b)) ops += 2;                       // sand, gravel, clay: dig it out and put dirt there
  }
  return ops;
}
function pickPlot(m, R, D) {
  const s = m.jobsite, w = W(), c = ids();
  let best = null, bs = Infinity;
  const reach = FARM_R - PLOT_R;
  for (let t = 0; t < 60; t++) {
    const cx = s.x + (t === 0 ? 0 : Math.round(rnd(-reach, reach))), cz = s.z + (t === 0 ? 0 : Math.round(rnd(-reach, reach)));
    if (!w.isLoaded(cx, cz)) continue;
    const cy = w.heightAt(cx, cz);
    if (cy < 1 || !c.ground.has(getB(cx, cy, cz))) continue;
    const ops = plotCost(m, R, D, cx, cy, cz);
    if (ops == null) continue;
    const sc = ops + Math.hypot(cx - s.x, cz - s.z) * 0.5;
    if (sc < bs) { bs = sc; best = { cx, cy, cz }; }
  }
  return best;
}
// The next job of the farm being made: level the 9x9 plot (dig the high cells, fill the low ones with dirt), then pour water in its middle.
// Digging puts dirt in the pocket; missing dirt is fetched from outside the village. Tilling and edging then follow from think().
function planTask(m, fs, R, D, ok) {
  const c = ids(), w = W(), now = performance.now() / 1000;
  if (!fs.plan) {
    if (fs.planCd > now) return null;
    fs.plan = pickPlot(m, R, D);
    if (!fs.plan) { fs.planCd = now + 20; return null; }
  }
  const P = fs.plan;
  if (BF.FLUID[getB(P.cx, P.cy, P.cz)] === 8) { fs.plan = null; return null; }          // the water is in: tilling takes over
  let work = null, wd = Infinity, need = 0;
  for (let dz = -PLOT_R; dz <= PLOT_R; dz++) for (let dx = -PLOT_R; dx <= PLOT_R; dx++) {
    const x = P.cx + dx, z = P.cz + dz;
    if (!w.isLoaded(x, z)) continue;
    const top = w.heightAt(x, z), b = top < 0 ? 0 : getB(x, top, z);
    let op = null;
    if (!c.ground.has(b) || !freeCell(R, D, x, z)) { fs.plan = null; fs.planCd = now + 20; return null; }   // the plot changed under us
    if (top > P.cy || (top === P.cy && !tillOK(c, b))) op = { kind: "dig", x, y: top, z, k: key3(x, top, z), ty: top + 1 };
    else if (top < P.cy) { op = { kind: "raise", x, y: top, z, k: key3(x, top, z), ty: top + 1 }; need++; }
    if (!op || !ok(op.k)) continue;
    const d = Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z) + (op.kind === "raise" ? 0.5 : 0);
    if (d < wd) { wd = d; work = op; }
  }
  if (work) {
    if (work.kind === "raise" && cnt(m, c.dirt) < 1) {                                   // no dirt in the pocket: fetch some
      fs.haul = { what: "dirt", n: Math.min(24, Math.max(4, need)) };
      const g = findGather(m, D, "dirt", ok);
      if (g) return g;
      fs.haul = null; fs.plan = null; fs.planCd = now + 30;
      return null;
    }
    return work;
  }
  if (cnt(m, c.wbucket) > 0) return { kind: "water", x: P.cx, y: P.cy, z: P.cz, k: key3(P.cx, P.cy, P.cz), ty: P.cy + 1 };
  if (cnt(m, c.bucket) > 0) {
    const f = findFill(m, D, ok);
    if (f) return f;
  }
  fs.planCd = now + 30;                                                                   // no bucket / no water within reach: try again later
  return null;
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
  if (t.kind === "gather") return gatherBlock(m, D, t);
  if (!w.isLoaded(t.x, t.z) || !freeCellOrFarm(R, D, t)) return false;
  if (t.kind === "dig" || t.kind === "raise") return levelCell(m, R, D, t);
  if (t.kind === "harvest") {
    const id = getB(t.x, t.y, t.z);
    if (!c.matureSet.has(id) || getB(t.x, t.y - 1, t.z) !== c.farmland || !dropsFit(m, id)) return false;
    if (!w.setBlock(t.x, t.y, t.z, 0)) return false;
    const drops = collectDrops(m, id);
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
    if (!tillable(R, D, t.x, t.y, t.z, m)) return false;
    let place = c.farmland;
    if (t.kind === "till" && !hasHoe(m)) return false;                 // farmland is made with the hoe
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
    if (!fillBucket(m, t.x, t.y, t.z)) return false;
    log("fill", m, { at: [t.x, t.y, t.z] });
    return true;
  }
  return false;
}
// Takes the block of a gather task (dirt from open ground, the base log of a tree) outside the village; its drops go into the inventory.
function gatherBlock(m, D, t) {
  const c = ids(), w = W(), Tinv = TR().inv;
  if (!w.isLoaded(t.x, t.z) || inVillage(D, t.x, t.z)) return false;
  const id = getB(t.x, t.y, t.z);
  if (t.what === "dirt" ? !c.diggable.has(id) : !isLogBlock(id)) return false;
  const drops = BF.rollDrops(id);
  if (!Tinv.canFit(m.inv, drops.map(d => ({ id: d.id, n: d.count })), [])) return false;
  if (!w.setBlock(t.x, t.y, t.z, 0)) return false;
  for (const d of drops) Tinv.add(m.inv, d.id, d.count);
  particles(t.x + 0.5, t.y + 0.5, t.z + 0.5, BF.blocks[id].color, 5, 0.6);
  blockSound("break", id, t.x, t.y, t.z);
  log("gather", m, { at: [t.x, t.y, t.z], block: BF.blocks[id].name });
  return true;
}
// Levelling a field: "dig" removes the top soil block of the column (plants on it first), "raise" puts a dirt block on it. Nothing else is ever touched.
function levelCell(m, R, D, t) {
  const c = ids(), w = W(), Tinv = TR().inv;
  if (!D.ready || getB(t.x, t.y, t.z) === 0 || w.heightAt(t.x, t.z) !== t.y) return false;
  const id = getB(t.x, t.y, t.z);
  if (!c.ground.has(id) || !looseAbove(getB(t.x, t.y + 1, t.z))) return false;
  if (t.kind === "dig") {
    const drops = BF.rollDrops(id);
    const above = getB(t.x, t.y + 1, t.z);
    if (above !== 0) { for (const d of BF.rollDrops(above)) Tinv.add(m.inv, d.id, d.count); w.setBlock(t.x, t.y + 1, t.z, 0); }
    if (!w.setBlock(t.x, t.y, t.z, 0)) return false;
    for (const d of drops) if (BF.items[d.id] && Tinv.canFit(m.inv, [{ id: d.id, n: d.count }], [])) Tinv.add(m.inv, d.id, d.count);   // what does not fit is left in the ground
    particles(t.x + 0.5, t.y + 0.8, t.z + 0.5, BF.blocks[id].color, 5, 0.7);
    blockSound("break", id, t.x, t.y, t.z);
    log("dig", m, { at: [t.x, t.y, t.z], block: BF.blocks[id].name });
    return true;
  }
  if (cnt(m, c.dirt) < 1) return false;
  const above = getB(t.x, t.y + 1, t.z);
  if (above !== 0) { for (const d of BF.rollDrops(above)) Tinv.add(m.inv, d.id, d.count); w.setBlock(t.x, t.y + 1, t.z, 0); }
  if (!w.setBlock(t.x, t.y + 1, t.z, c.dirt)) return false;
  Tinv.remove(m.inv, c.dirt, 1);
  particles(t.x + 0.5, t.y + 1.02, t.z + 0.5, BF.blocks[c.dirt].color, 4, 0.7);
  blockSound("place", c.dirt, t.x, t.y + 1, t.z);
  log("raise", m, { at: [t.x, t.y + 1, t.z] });
  return true;
}
// farm tasks inside worldgen farm plots are fine for harvest/plant (those are the village fields); new blocks need free ground
function freeCellOrFarm(R, D, t) { return t.kind === "harvest" || t.kind === "plant" || t.kind === "fill" ? inArea(D, t.x, t.z) : freeCell(R, D, t.x, t.z); }

function farmAI(m, dt, out) {
  const R = m.village;
  const D = vdata(R), fs = m.farm || (m.farm = newFarm()), ai = m.ai;
  ensureKit(m); ensureCover(D, m);
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
      t.max = TASK_MAX + (t.x != null ? 2.5 * Math.hypot(t.x + 0.5 - m.position.x, t.z + 0.5 - m.position.z) : 0);   // long walks to a far field get more time
      if (t.k) claims.set(t.k, m);
    }
  }
  const t = fs.task;
  fs.t += dt;
  if (fs.t > (t.max || TASK_MAX)) { endTask(m, fs, false); return true; }
  ai.mode = "idle"; ai.t = 2;
  if (fs.stage === "walk") {
    const st = t.sx != null ? travel(m, fs, dt, out, t.sx, t.sy, t.sz, m.def.speed * 1.1)      // a bucket is filled from a cell beside (or over the wall of) the water
      : travel(m, fs, dt, out, t.x, t.ty != null ? t.ty : t.y, t.z, m.def.speed * 1.1);
    if (st === "failed") { log("giveup", m, { task: t.kind, why: "no path", at: [t.x, t.y, t.z] }); endTask(m, fs, false); return true; }
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
    if (!okDone) log("giveup", m, { task: t.kind, why: "cell changed", at: [t.x, t.y, t.z] });
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
    if (BF.vlog) BF.vlog.trade(m, v2, deal.offer || ("gave " + paid + " Emerald, got " + n + " " + BF.itemName(item)), done);
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
  if (m.profession === "farmer" && m.village && m.jobsite && !m.child) return farmAI(m, dt, out);   // a farmer works from its composter
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
  const nowS = performance.now() / 1000;
  for (const R of wantVillages) {                       // builders asking for water: keep their village's water ring scanned a while
    const D = R._life;
    if (!D || nowS - D.want > 120) { wantVillages.delete(R); continue; }
    if (!scanned.has(R)) scanStep(R, D, SCAN_COLS);
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
const NAMES = { dig: "Levelling a field", raise: "Filling in a field", gather: "Gathering", harvest: "Harvesting", plant: "Planting", till: "Tilling farmland", border: "Edging a bed", water: "Watering a new bed", fill: "Filling a bucket", craft: "Baking bread", tend: "Tending crops" };
function statusText(m) {
  if (!m) return "";
  if (m.starving) return "Too hungry to trade";
  if (m.fshop && m.fshop.stage) return "Buying food";
  if (m.profession === "farmer" && m.farm && m.farm.task && !m.sleeping) {
    const t = m.farm.task;
    if (t.kind === "craft" && t.hay) return "Making hay bales";
    const b = t.kind === "harvest" || t.kind === "plant" ? BF.blocks[getB(t.x, t.y, t.z)] : null;
    if (t.kind === "gather") return t.what === "dirt" ? "Gathering dirt" : "Gathering wood";
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
function reset() { wantVillages.clear(); claims.clear(); LOG.length = 0; for (const p of pool) BF.scene && BF.scene.remove(p.mesh); pool.length = 0; acc = 0; }

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

BF.villageLife = { ai, tick, statusText, stats, reset, useBucket, log: LOG, vdata, think, claims, WORK_END, FARM_R, FARM_MAX, WATER_REACH, ensureKit, findWater, fillBucket,
  _test: { findTill, findBorder, findWaterSpot, findFill, findGather, planTask, pickPlot, perform, dealWith, findFoodSeller, scanStep, inRange } };
})();
