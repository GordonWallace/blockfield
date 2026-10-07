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
const ACT = { harvest: 0.55, plant: 0.45, till: 0.9, border: 0.75, unborder: 0.8, water: 0.9, fill: 0.9, craft: 1.6, tend: 3.0, dig: 0.7, raise: 0.5, gather: 0.9 };
const TASK_MAX = 45;              // seconds before an unfinished task is given up
const BREAK_P = 0.05;             // chance of a short break after a task (the rest of the day is farming)
const SCAN_COLS = 500;            // columns of the village area scanned per tick
const RESCAN = 10;                // seconds between village farm scans
const FARM_R = 12;                // a farmer tends farmland within 12 blocks, in every direction, of its composter, and the whole of any bed that reaches that box
const BED_REACH = 16;             // ... so a bed it looks after (and builds) may stretch up to 16 blocks from the composter
const FARM_MAX = 64;              // farmland cells within that range a farmer is content with: it only grows / adds beds below this
const WATER_REACH = 30;           // buckets are filled at water this far (~30 blocks) around the village area, wells included
const GATHER_R = 24;              // dirt and logs are taken from up to this far outside the village area, never from inside it
const TRADE_PAUSE = 1.6;
const WHEAT_SPARE = 24;           // a farmer bakes only the wheat above this: the rest is for sale to shepherds (12 wheat per emerald)
const WHEAT_SELF = 4;             // ...and sells wheat down to this many
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
// A new farmer gets an empty bucket (and a hoe), a new builder an empty bucket: water is only ever placed from a bucket that was filled first.
function ensureKit(m) {
  if (!m || !Array.isArray(m.inv) || (m.profession !== "farmer" && m.profession !== "builder") || m.kitFor === m.profession) return;
  m.kitFor = m.profession;
  const c = ids(), Tinv = TR().inv;
  if (c.bucket != null && cnt(m, c.bucket) + cnt(m, c.wbucket) === 0) Tinv.add(m.inv, c.bucket, 1);
  if (m.profession === "farmer" && c.hoes.length && !hasHoe(m)) Tinv.add(m.inv, c.hoes[Math.min(1, c.hoes.length - 1)], 1);
}
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
  const boxes = [], farms = [];      // [x0, z0, x1, z1]: buildings with a 1-block margin (no bed comes there), generated farm plots
  let farmBase = 0;
  for (const b of wg.buildings || []) {
    const farm = b.type === "farm" || b.type === "bigfarm";
    if (farm) { farms.push([b.x0, b.z0, b.x1, b.z1]); farmBase += (b.w - 2) * (b.d - 2); }
    else boxes.push([b.x0 - 1, b.z0 - 1, b.x1 + 1, b.z1 + 1]);
  }
  if (Number.isFinite(wg.x)) boxes.push([wg.x - 9, wg.z - 9, wg.x + 9, wg.z + 9]);       // meeting square, bell, well
  for (const l of wg.lamps || []) boxes.push([l[0] - 1, l[1] - 1, l[0] + 1, l[1] + 1]);
  for (const d of wg.decor || []) boxes.push([d[0] - 1, d[1] - 1, d[0] + 1, d[1] + 1]);
  R._life = { area: A, base: Object.assign({}, A), boxes, farms, beds: [], projects: projectsFor(R), farmBase, cells: [], water: [], waterSet: new Set(), wells: new Set(), ready: false, scan: null, scanT: 0, want: 0 };
  return R._life;
}
// The farmer's reach box (composter +-12) must lie inside the scanned area (a composter placed outside the village grounds); a wider area is rescanned.
function ensureCover(D, m) {
  const s = m.jobsite, A = D.area;
  if (!s) return;
  const x0 = s.x - BED_REACH - 1, x1 = s.x + BED_REACH + 1, z0 = s.z - BED_REACH - 1, z1 = s.z + BED_REACH + 1, yLo = s.y - FARM_R, yHi = s.y + FARM_R;
  if (x0 >= A.x0 && x1 <= A.x1 && z0 >= A.z0 && z1 <= A.z1 && yLo >= A.yLo && yHi <= A.yHi) return;
  D.area = { x0: Math.min(A.x0, x0), x1: Math.max(A.x1, x1), z0: Math.min(A.z0, z0), z1: Math.max(A.z1, z1), yLo: Math.min(A.yLo, yLo), yHi: Math.max(A.yHi, yHi) };
  D.ready = false; D.scan = null; D.scanT = 0;
}
// the farmland / water cell (x, y, z) is within 12 blocks of the farmer's composter in every direction
const inRange = (m, x, y, z) => { const s = m.jobsite; return !!s && Math.abs(x - s.x) <= FARM_R && Math.abs(z - s.z) <= FARM_R && Math.abs(y - s.y) <= FARM_R; };
const inBedReach = (m, x, y, z) => { const s = m.jobsite; return !!s && Math.abs(x - s.x) <= BED_REACH && Math.abs(z - s.z) <= BED_REACH && Math.abs(y - s.y) <= FARM_R; };
// the farmer's beds: those reaching into its 12-block box (it tends all of each)
const reachBox = m => { const s = m.jobsite; return [s.x - FARM_R, s.z - FARM_R, s.x + FARM_R, s.z + FARM_R]; };
const myBeds = (m, D) => (D.beds || []).filter(b => Math.abs(b.y - m.jobsite.y) <= FARM_R && overlap(outerOf(b), reachBox(m)));
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
// One pass over the village area (farmland + water, top-down) and the ring of WATER_REACH blocks around it (water only), `budget` columns per call.
function scanStep(R, D, budget) {
  const w = W(), c = ids();
  if (!D.scan) {
    if (BF.simNow() < D.scanT) return;
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
        detectBeds(D);
        D.ready = true; D.scan = null; D.scanT = BF.simNow() + RESCAN;
        return;
      }
    }
  }
}
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
function think(m, fs, R, D) {
  const c = ids(), px = m.position.x, pz = m.position.z, now = BF.simNow();
  const dist = (x, z) => Math.hypot(x + 0.5 - px, z + 0.5 - pz);
  const ok = k => !claimed(k, m) && !(fs.avoid[k] > now);
  // bake: 3 wheat -> 1 bread (hay bales once bread is plentiful)
  const wheat = cnt(m, c.wheat) - WHEAT_SPARE;   // the spare wheat is kept for the shepherds (see "wheat for the shepherds" below)
  if (wheat >= 3 && c.bread != null) {
    const toHay = cnt(m, c.bread) >= 96 && wheat >= 9 && c.hay != null;
    if (TR().inv.canFit(m.inv, [{ id: toHay ? c.hay : c.bread, n: 1 }], [{ id: c.wheat, n: toHay ? 9 : 3 }])) return { kind: "craft", hay: toHay };
  }
  // a trip for materials (dirt / logs from outside the village) goes on until the farmer carries enough
  if (fs.haul) {
    const h = fs.haul, have = h.what === "dirt" ? cnt(m, c.dirt) : logCount(m);
    if (have < h.n) { const g = findGather(m, D, h.what, ok); if (g) return g; }
    fs.haul = null;
  }
  // harvest mature crops / plant empty farmland, only within 12 blocks of the composter: nearest first
  const mine = myBeds(m, D);
  const cells = D.cells.filter(p => inRange(m, p[0], p[1], p[2]) || mine.some(b => p[1] === b.y && p[0] >= b.x0 && p[0] <= b.x1 && p[2] >= b.z0 && p[2] <= b.z1));
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
  // nothing to harvest or plant: work on a bed (grow one, or lay out a new one) while the farmer wants more farmland
  let P = projectOf(m, R, D);
  if (!P && cells.length < FARM_MAX && !(fs.projCd > now)) { fs.projCd = now + PROJECT_CD; P = chooseProject(m, R, D, cells.length); }
  if (P) {
    const t = projectTask(m, fs, R, D, P, ok);
    if (t) return t;
  }
  if (young.length && Math.random() < 0.8) {           // look after the growing crops
    const [x, y, z] = young[Math.floor(Math.random() * young.length)];
    return { kind: "tend", x, y: y + 1, z, k: "tend:" + key3(x, y, z) };
  }
  return null;
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
  D.want = BF.simNow(); wantVillages.add(R);
  return D.ready ? findFill(m, D, null) : null;
}

// ---------------------------------------------------------------- materials from outside the village
// What to take: "dirt" = the top block of open ground (grass, dirt ...), "log" = the base log of a tree. Never inside the village (buildings + 6 blocks around).
// a living tree (leaves on it), not a log somebody laid: a bed's edge, a post
const naturalTree = (x, y, z) => (BF.forester && BF.forester.treeAt ? !!BF.forester.treeAt(x, y, z) : isLogBlock(getB(x, y + 1, z)));
// within a block of a bed, a farm plot or a bed being made (beds made by farmers can lie outside the village box)
const nearBeds = (D, x, z) => (D.beds || []).some(b => inRect(grow(outerOf(b), 1), x, z)) || D.farms.some(f => inRect(grow(f, 1), x, z)) || D.projects.some(p => inRect(grow(outerOf(p.L), 1), x, z));
function findGather(m, D, what, ok) {
  const c = ids(), w = W(), b0 = D.base, px = m.position.x, pz = m.position.z;
  let best = null, bd = Infinity;
  for (let t = 0; t < 120; t++) {
    // half the samples near the farmer (the nearest edge of the village), half anywhere around it
    const near = t & 1, x = Math.floor(near ? rnd(px - 28, px + 28) : rnd(b0.x0 - GATHER_R, b0.x1 + GATHER_R + 1)), z = Math.floor(near ? rnd(pz - 28, pz + 28) : rnd(b0.z0 - GATHER_R, b0.z1 + GATHER_R + 1));
    if (x < b0.x0 - GATHER_R || x > b0.x1 + GATHER_R || z < b0.z0 - GATHER_R || z > b0.z1 + GATHER_R) continue;
    if (inVillage(D, x, z) || !w.isLoaded(x, z) || nearBeds(D, x, z)) continue;
    const h = w.heightAt(x, z);
    if (h < BF.MIN_Y + 1) continue;
    let y = -1;
    if (what === "dirt") {
      const a = getB(x, h + 1, z);
      if (c.diggable.has(getB(x, h, z)) && (a === 0 || (BF.REPLACEABLE[a] && !BF.SOLID[a] && !BF.FLUID[a]))) y = h;
    } else {
      for (let yy = h; yy > h - 16 && yy > 1; yy--) if (isLogBlock(getB(x, yy, z))) { y = yy; while (y > 1 && isLogBlock(getB(x, y - 1, z))) y--; break; }
      if (y >= 0 && (!BF.SOLID[getB(x, y - 1, z)] || !naturalTree(x, y, z))) y = -1;
    }
    if (y < 0 || (ok && !ok(key3(x, y, z)))) continue;
    const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
    if (d < bd) { bd = d; best = { kind: "gather", what, x, y, z, k: key3(x, y, z), ty: what === "dirt" ? y + 1 : y }; }
  }
  return best;
}

const tillOK = (c, id) => c.till.has(id) || id === c.farmland;
const looseAbove = id => id === 0 || (BF.REPLACEABLE[id] && !BF.SOLID[id] && !BF.FLUID[id]);
// ---------------------------------------------------------------- garden beds
// Farmland is only ever made inside a bed like the village farms: a rectangle ringed with logs (set into the ground), with water
// channels every 4 lines across it (3 rows of crops between them). A farmer either grows a bed it can reach (pushes one side of the
// ring out: few new logs, since the old side's logs are reused, but the edge has to be moved) or, when there is a lot of open
// ground near its composter, lays out a new bed. Each of these is a project, worked one task at a time and saved with the game.
// A layout L is { x0, z0, x1, z1, y, ax, ch }: interior x0..x1 / z0..z1 at height y, ring one block outside it, and channels on the
// lines ax = "x" (x = const, water running along z) or "z" at the positions in ch.
const BED_GAP = 1;                // free cells kept between a bed's ring and buildings (their boxes already include 1) and other beds
const ROOM = 2;                   // a new bed needs this much clear ground all round its ring: "a lot of room"
const CH_STEP = 4;                // channel spacing: 3 lines of crops between channels, as in the generated farms
const GROW_ALONG = 2;             // a bed grows along its channels two rows at a time
const MAX_ALONG = 11;             // interior length along the channels a bed grows to (generated farms: 5 and 7)
const MAX_ACROSS = 15;            // interior width across the channels (3 channels; generated farms: 7 and 11)
const LOG_COST = 3;               // a log fetched from outside the village weighs like 3 tasks
const PROJECT_CD = 25;            // seconds between looks for a new project
const PROJECT_FAILS = 14;         // failed fetches before a project that hasn't changed anything yet is given up (a started one pauses instead)
const GROW_DAMP = 0.8;            // how much a bed's size counts against growing it further
const NEW_BONUS = 1.5;            // a new bed (only offered with room all round) against growing: more logs, but a second field
// new bed shapes: interior lines across the channels (u) x along them (v), channel offsets in u (the village farm and big farm, and a square one)
const SHAPES = [{ u: 7, v: 5, ch: [3] }, { u: 7, v: 7, ch: [3] }, { u: 11, v: 7, ch: [3, 7] }];

const outerOf = L => [L.x0 - 1, L.z0 - 1, L.x1 + 1, L.z1 + 1];
const grow = (r, n) => [r[0] - n, r[1] - n, r[2] + n, r[3] + n];
const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const inRect = (r, x, z) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
function layoutAt(L, x, z) {
  if (x < L.x0 - 1 || x > L.x1 + 1 || z < L.z0 - 1 || z > L.z1 + 1) return null;
  if (x < L.x0 || x > L.x1 || z < L.z0 || z > L.z1) return "log";
  return L.ch.includes(L.ax === "x" ? x : z) ? "water" : "farm";
}
const isLogItem = id => { const it = BF.items[id]; return !!it && it.isBlock && isLogBlock(id); };
function logCount(m) { let n = 0; for (const s of m.inv) if (s && isLogItem(s.id)) n += s.count; return n; }
function logId(m, prefer) {
  if (prefer != null && cnt(m, prefer) > 0) return prefer;
  for (const s of m.inv) if (s && isLogItem(s.id)) return s.id;
  return null;
}
// clear of the village's buildings (their boxes include a 1-block margin), the square, lamps, decorations and builders' structures
function clearOfBuildings(R, D, x, z) {
  for (const b of D.boxes) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return false;
  if (BF.builder && BF.builder.builtOf) for (const e of BF.builder.builtOf(R) || []) if (x >= e.ox - 1 && x <= e.ox + e.w && z >= e.oz - 1 && z <= e.oz + e.d) return false;
  return true;
}

// The beds of the village: every farmland region enclosed by a complete ring of logs (corners included), found after each scan.
// The region may hold farmland, water and plain soil (the pumpkin patch of a generated farm).
function detectBeds(D) {
  const c = ids(), w = W(), beds = [], seen = new Set();
  const member = id => id === c.farmland || BF.FLUID[id] === 8 || c.till.has(id);
  for (const [sx, sy, sz] of D.cells) {
    if (seen.has(key3(sx, sy, sz))) continue;
    seen.add(key3(sx, sy, sz));
    const q = [[sx, sz]];
    let n = 0, x0 = sx, x1 = sx, z0 = sz, z1 = sz, open = false;
    while (q.length && !open) {
      const [x, z] = q.pop();
      n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      if (n > 400 || x1 - x0 > 24 || z1 - z0 > 24) { open = true; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, k = key3(nx, sy, nz);
        if (seen.has(k)) continue;
        if (!w.isLoaded(nx, nz)) { open = true; break; }
        const id = getB(nx, sy, nz);
        if (isLogBlock(id)) continue;
        if (!member(id)) { open = true; break; }
        seen.add(k); q.push([nx, nz]);
      }
    }
    if (open || n !== (x1 - x0 + 1) * (z1 - z0 + 1)) continue;
    let ring = true;
    for (let x = x0 - 1; x <= x1 + 1 && ring; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) continue;
      if (!isLogBlock(getB(x, sy, z))) { ring = false; break; }
    }
    if (!ring) continue;
    const full = (ax, p) => { for (let t = ax === "x" ? z0 : x0; t <= (ax === "x" ? z1 : x1); t++) if (BF.FLUID[ax === "x" ? getB(p, sy, t) : getB(t, sy, p)] !== 8) return false; return true; };
    const cx = [], cz = [];
    for (let x = x0; x <= x1; x++) if (full("x", x)) cx.push(x);
    for (let z = z0; z <= z1; z++) if (full("z", z)) cz.push(z);
    const ax = cx.length >= cz.length ? "x" : "z";
    beds.push({ x0, z0, x1, z1, y: sy, ax, ch: ax === "x" ? cx : cz, log: getB(x0 - 1, sy, z0 - 1) });
  }
  D.beds = beds;
}

// What has to happen at one cell of a project to match its layout: null when it already does, "blocked" when it cannot,
// else a task (stage 0 level, 1 lay a ring log, 2 lift an old ring log, 3 water / till).
function cellJob(P, x, z) {
  const c = ids(), L = P.L, y = L.y, want = layoutAt(L, x, z), cur = getB(x, y, z);
  if (want === "log" ? isLogBlock(cur) : want === "water" ? BF.FLUID[cur] === 8 : cur === c.farmland) return null;
  const k = key3(x, y, z), at = (kind, stage, yy) => ({ kind, x, y: yy == null ? y : yy, z, k, ty: (yy == null ? y : yy) + 1, stage, proj: P.id });
  if (isLogBlock(cur)) return at("unborder", 2);                                  // an old edge log where the bed now goes on
  if (BF.FLUID[cur]) return "blocked";
  const top = W().heightAt(x, z), b = getB(x, top, z);
  if (top > y + 2 || top < y - 3 || !c.ground.has(b) || BF.FLUID[getB(x, top + 1, z)]) return "blocked";
  if (top > y) return at("dig", 0, top);
  if (top < y) return at("raise", 0, top);
  if (want !== "log" && !tillOK(c, cur)) return at("dig", 0, top);               // sand, gravel, clay, a path: dug out, then dirt goes in
  const a = getB(x, y + 1, z);
  if ((!looseAbove(a) && BF.RENDER[a] !== 4) || BF.SOLID[getB(x, y + 2, z)]) return "blocked";                // a block on it, or overhead
  return want === "log" ? at("border", 1) : at(want === "water" ? "water" : "till", 3);
}
// cells of a project that it changes: its ring and interior, less the interior of the bed it grows (that stays as it is)
function projectCells(P, f) {
  const o = outerOf(P.L);
  for (let x = o[0]; x <= o[2]; x++) for (let z = o[1]; z <= o[3]; z++) if (!(P.old && inRect(P.old, x, z))) f(x, z);
}
// Price of a layout: tasks (levelling, logs to lay and lift, water trips, tilling), logs to fetch, and the new farmland.
// null when a cell can't be used (blocked, out of reach, a building or its margin, a road).
function priceLayout(m, R, D, P, held) {
  const c = ids();
  let ops = 0, lvl = 0, lay = 0, lift = 0, gain = 0, bad = false;
  projectCells(P, (x, z) => {
    if (bad) return;
    if (!W().isLoaded(x, z) || !clearOfBuildings(R, D, x, z) || !inBedReach(m, x, P.L.y, z)) { bad = true; return; }
    const top = W().heightAt(x, z);
    if (getB(x, top, z) === c.path) { bad = true; return; }                     // never over a road
    const want = layoutAt(P.L, x, z);
    if (want === "farm") gain++;
    const j = cellJob(P, x, z);
    if (j === "blocked") { bad = true; return; }
    if (!j) return;
    if (j.stage === 0) { const n = Math.max(1, Math.abs(top - P.L.y)); lvl += n; ops += n; }
    if (j.kind === "unborder") { lift++; ops++; }
    else if (want === "log") { lay++; ops++; }                                   // (after levelling) a log goes in
    else ops += want === "water" ? 2 : 1;                                        // a bucket trip and pour / the hoe
  });
  if (bad) return null;
  const logs = Math.max(0, lay - lift - held);
  return { ops, lvl, logs, gain, cost: ops + LOG_COST * logs };
}
// another bed, farm plot or project within `gap` of rectangle r (cells of `own`, the bed being grown, don't count)
function crowded(D, r, gap, own) {
  const g = grow(r, gap);
  for (const b of D.beds || []) { const o = outerOf(b); if (own && inRect(own, o[0], o[1]) && inRect(own, o[2], o[3])) continue; if (overlap(g, o)) return true; }
  for (const f of D.farms) { if (own && inRect(own, f[0], f[1]) && inRect(own, f[2], f[3])) continue; if (overlap(g, f)) return true; }
  for (const p of D.projects) if (overlap(g, outerOf(p.L))) return true;
  return false;
}
// The ways a bed could grow by one step on each side: along its channels (2 more rows, the channels run on) or across them
// (the edge line becomes a new channel with 3 new rows beyond it). Layouts only; the price decides.
function growOptions(b) {
  const out = [], along = b.ax === "x" ? "z" : "x";
  if (!b.ch.length) return out;
  const len = b.ax === "x" ? b.z1 - b.z0 + 1 : b.x1 - b.x0 + 1, wid = b.ax === "x" ? b.x1 - b.x0 + 1 : b.z1 - b.z0 + 1;
  const L0 = { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, y: b.y, ax: b.ax, ch: b.ch.slice() };
  if (len + GROW_ALONG <= MAX_ALONG) for (const s of [-1, 1]) {
    const L = Object.assign({}, L0, { ch: b.ch.slice() });
    if (s < 0) L[along + "0"] -= GROW_ALONG; else L[along + "1"] += GROW_ALONG;
    out.push({ L, dir: "along" });
  }
  const lo = Math.min(...b.ch), hi = Math.max(...b.ch), a0 = L0[b.ax + "0"], a1 = L0[b.ax + "1"];
  for (const s of [-1, 1]) {
    const c0 = s > 0 ? hi : lo, nc = c0 + s * CH_STEP, edge = c0 + s * (2 * CH_STEP - 1);
    if (s > 0 ? nc <= a1 || edge <= a1 : nc >= a0 || edge >= a0) continue;
    if (wid + Math.abs(edge - (s > 0 ? a1 : a0)) > MAX_ACROSS) continue;
    const L = Object.assign({}, L0, { ch: b.ch.concat([nc]) });
    if (s > 0) L[b.ax + "1"] = edge; else L[b.ax + "0"] = edge;
    out.push({ L, dir: "across" });
  }
  return out;
}
// A new bed of one of SHAPES somewhere within reach of the composter, with ROOM clear cells all round: the cheapest of some samples.
function newBedOptions(m, R, D, room, held) {
  const s = m.jobsite, w = W(), c = ids(), out = [];
  for (let t = 0; t < 80; t++) {
    const S = SHAPES[Math.floor(Math.random() * SHAPES.length)], ax = Math.random() < 0.5 ? "x" : "z";
    const wx = ax === "x" ? S.u : S.v, wz = ax === "x" ? S.v : S.u;
    const x0 = s.x + Math.round(rnd(-BED_REACH + 1, BED_REACH - wx)), z0 = s.z + Math.round(rnd(-BED_REACH + 1, BED_REACH - wz));
    const cx = x0 + (wx >> 1), cz = z0 + (wz >> 1);
    if (!w.isLoaded(cx, cz)) continue;
    const y = w.heightAt(cx, cz);
    if (y < BF.MIN_Y + 1 || !c.ground.has(getB(cx, y, cz))) continue;
    const L = { x0, z0, x1: x0 + wx - 1, z1: z0 + wz - 1, y, ax, ch: S.ch.map(o => (ax === "x" ? x0 : z0) + o) };
    const o = outerOf(L);
    if (!overlap(o, reachBox(m))) continue;                // it must reach into the farmer's box
    const W_ = (BF._nb = BF._nb || {}); W_.tries = (W_.tries || 0) + 1;
    if (crowded(D, o, BED_GAP, null)) { W_.crowded = (W_.crowded || 0) + 1; continue; }
    let ok = true;                                     // the margin: no building (or its margin), no cliff; other beds may be a path's width away
    for (let x = o[0] - room; x <= o[2] + room && ok; x++) for (let z = o[1] - room; z <= o[3] + room; z++) {
      if (inRect(o, x, z)) continue;
      if (!w.isLoaded(x, z) || !clearOfBuildings(R, D, x, z) || Math.abs(w.heightAt(x, z) - y) > 3) { ok = false; break; }
    }
    if (!ok) { W_.margin = (W_.margin || 0) + 1; continue; }
    const P = { L, old: null };
    const pr = priceLayout(m, R, D, P, held);
    if (!pr) W_.price = (W_.price || 0) + 1; else if (pr.lvl > pr.gain * 0.6) W_.lvl = (W_.lvl || 0) + 1;
    if (pr && pr.lvl <= pr.gain * 0.6) out.push({ L, dir: null, kind: "new", pr });
  }
  return out;
}
// Picks the farmer's next project: grow a bed or make a new one. Value = new farmland per unit of work (logs to fetch weigh
// LOG_COST). Growing a bed costs few logs, so it usually wins; a bed already large is less attractive to grow (it would
// sprawl), and a new bed only qualifies with ROOM clear cells round it (1 when the farmer has no farmland at all).
function chooseProject(m, R, D, have) {
  const held = logCount(m), cands = [];
  for (const b of myBeds(m, D)) {
    const o = outerOf(b);
    if (D.projects.some(p => overlap(outerOf(p.L), o))) continue;
    for (const g of growOptions(b)) {
      const P = { L: g.L, old: [b.x0, b.z0, b.x1, b.z1] };
      if (crowded(D, outerOf(g.L), BED_GAP, o)) continue;
      const pr = priceLayout(m, R, D, P, held);
      if (!pr || !pr.gain) continue;
      const wx = g.L.x1 - g.L.x0 + 1, wz = g.L.z1 - g.L.z0 + 1;
      // a big bed is less worth growing (it would sprawl), and a bed keeps a compact shape: the step that keeps it squarer wins
      cands.push({ L: g.L, old: P.old, dir: g.dir, kind: "grow", pr, log: b.log, bias: (1 - GROW_DAMP * wx * wz / (MAX_ALONG * MAX_ACROSS)) * (0.55 + 0.45 * Math.min(wx, wz) / Math.max(wx, wz)) });
    }
  }
  for (const n of newBedOptions(m, R, D, have ? ROOM : 1, held)) cands.push(Object.assign(n, { bias: NEW_BONUS }));
  let best = null, bv = 0;
  for (const k of cands) {
    if (have + k.pr.gain > FARM_MAX + 24) continue;      // not far past what the farmer wants
    const v = k.pr.gain / Math.max(1, k.pr.cost) * k.bias * rnd(0.7, 1.4);
    if (v > bv) { bv = v; best = k; }
  }
  if (!best) return null;
  const P = { id: "p" + Math.floor(Math.random() * 1e9).toString(36), kind: best.kind, dir: best.dir, L: best.L, old: best.old, owner: m.slot ? m.slot.idx : -1, log: best.log, fails: 0 };
  D.projects.push(P);
  log("project", m, { plan: P.kind + (P.dir ? ":" + P.dir : ""), options: cands.filter(k => k.kind === "new").length + " new / " + cands.filter(k => k.kind === "grow").length + " grow", at: [P.L.x0, P.L.y, P.L.z0], size: (P.L.x1 - P.L.x0 + 1) + "x" + (P.L.z1 - P.L.z0 + 1), gain: best.pr.gain, logs: best.pr.logs });
  return P;
}
// The farmer's project: its own, or one whose farmer is gone (another farmer takes it over when it lies within its reach).
function projectOf(m, R, D) {
  const idx = m.slot ? m.slot.idx : -1;
  let P = D.projects.find(p => p.owner === idx);
  if (P) return P;
  const alive = new Set((R.members || []).filter(v => v && !v.dead && !v.removed && v.profession === "farmer" && v.slot).map(v => v.slot.idx));
  for (const p of D.projects) {
    if (alive.has(p.owner)) continue;
    const o = outerOf(p.L);
    if (inBedReach(m, o[0], p.L.y, o[1]) && inBedReach(m, o[2], p.L.y, o[3]) && overlap(o, reachBox(m))) { p.owner = idx; return p; }
  }
  return null;
}
function dropProject(D, P, m, why) {
  const i = D.projects.indexOf(P);
  if (i >= 0) D.projects.splice(i, 1);
  if (m) log(why === "done" ? "bedDone" : "bedDropped", m, { plan: P.kind + (P.dir ? ":" + P.dir : ""), why });
  if (m && m.farm && why === "failing") m.farm.projCd = BF.simNow() + 300;      // no dirt or logs to be had: not again for a while
  if (why === "done") { (D.made || (D.made = [])).push({ kind: P.kind, dir: P.dir, size: (P.L.x1 - P.L.x0 + 1) + "x" + (P.L.z1 - P.L.z0 + 1), L: P.L }); D.scanT = 0; }
}
// The next task of the project: level the ground, lay the new ring, lift the old edge, then water the channels and till.
function projectTask(m, fs, R, D, P, ok) {
  const c = ids();
  let best = null, bs = Infinity, blocked = false, lay = 0, left = 0;
  projectCells(P, (x, z) => {
    if (!W().isLoaded(x, z)) { left++; return; }
    const j = cellJob(P, x, z);
    if (!j) return;
    if (j === "blocked") { if (!blocked) blocked = [x, z, getB(x, P.L.y, z), getB(x, P.L.y + 1, z), getB(x, P.L.y + 2, z), W().heightAt(x, z) - P.L.y]; return; }
    left++;
    if (j.kind === "border") lay++;
    if (!ok(j.k)) return;
    const s = j.stage * 1000 + Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z);
    if (s < bs) { bs = s; best = j; }
  });
  if (P.fails > PROJECT_FAILS) {
    if (!P.started) { dropProject(D, P, m, "failing"); return null; }
    P.fails = 0; P.wait = BF.simNow() + 120;                       // halfway: no dirt or logs to be had now, try again later
  }
  if (P.wait > BF.simNow()) return null;
  if (blocked) {                                                  // a cell was built on, flooded, dug out: a started bed waits a while before giving up
    log("blockedAt", m, { cell: blocked, names: blocked.slice(2, 5).map(id => BF.blocks[id] && BF.blocks[id].name), started: !!P.started });
    if (P.started && (P.blockN = (P.blockN || 0) + 1) <= 3) { P.wait = BF.simNow() + 120; return null; }
    dropProject(D, P, m, "blocked"); return null;
  }
  if (!left) { dropProject(D, P, m, "done"); return null; }
  if (!best) return null;
  if (best.stage === 3 && best.kind === "water") {                 // the ring is closed: water the channels from a filled bucket
    if (cnt(m, c.wbucket) > 0) return best;
    if (cnt(m, c.bucket) > 0) { const f = findFill(m, D, ok); if (f) return f; }
    return null;
  }
  if (best.kind === "till" && !hasHoe(m)) return null;
  if ((best.kind === "raise" && cnt(m, c.dirt) < 1) || (best.kind === "border" && logId(m) == null) || best.kind === "unborder" || best.kind === "dig") makeRoom(m);
  if (best.kind === "raise" && cnt(m, c.dirt) < 1) {
    fs.haul = { what: "dirt", n: 8 };
    const g = findGather(m, D, "dirt", ok);
    if (g) return g;
    fs.haul = null; P.fails++;
    return null;
  }
  if (best.kind === "border" && logId(m) == null) {
    fs.haul = { what: "log", n: Math.min(16, lay) };
    const g = findGather(m, D, "log", ok);
    if (g) return g;
    fs.haul = null; P.fails++;
    return null;
  }
  return best;
}
// A full pocket (18 slots) leaves no room for the dirt and logs of a bed: the smaller of two stacks of one crop, or else the
// biggest stack of spare crops, goes on the compost heap.
function makeRoom(m) {
  if (m.inv.some(s => !s)) return;
  const c = ids(), crops = new Set(c.seeds.concat([c.wheat, I("beetroot")]).filter(x => x != null)), seen = new Map();
  let pick = -1;
  m.inv.forEach((s, i) => { if (!s || !crops.has(s.id)) return; if (seen.has(s.id) && pick < 0) pick = m.inv[seen.get(s.id)].count < s.count ? seen.get(s.id) : i; seen.set(s.id, i); });
  if (pick < 0) m.inv.forEach((s, i) => { if (s && crops.has(s.id) && (pick < 0 || s.count > m.inv[pick].count)) pick = i; });
  if (pick < 0) return;
  log("compost", m, { item: BF.items[m.inv[pick].id].name, n: m.inv[pick].count });
  m.inv[pick] = null;
}
// Doing a project task (levelling goes through levelCell). False when the cell no longer fits the plan.
function performBed(m, fs, R, D, t) {
  const c = ids(), w = W(), Tinv = TR().inv;
  const P = D.projects.find(p => p.id === t.proj);
  if (!P) return false;
  const j = cellJob(P, t.x, t.z);
  if (!j || j === "blocked" || j.kind !== t.kind) return false;
  P.started = true;
  if (t.kind === "dig" || t.kind === "raise") return levelCell(m, R, D, t);
  const above = getB(t.x, t.y + 1, t.z);
  const clearTop = () => { if (above !== 0) { for (const d of BF.rollDrops(above)) Tinv.add(m.inv, d.id, d.count); w.setBlock(t.x, t.y + 1, t.z, 0); } };
  const old = getB(t.x, t.y, t.z);
  let place;
  if (t.kind === "unborder") {
    const drops = BF.rollDrops(old);
    if (!Tinv.canFit(m.inv, drops.map(d => ({ id: d.id, n: d.count })), [])) return false;
    if (!w.setBlock(t.x, t.y, t.z, c.dirt)) return false;
    for (const d of drops) Tinv.add(m.inv, d.id, d.count);
    blockSound("break", old, t.x, t.y, t.z);
    particles(t.x + 0.5, t.y + 1.02, t.z + 0.5, BF.blocks[old].color, 5, 0.7);
    log("unborder", m, { at: [t.x, t.y, t.z] });
    return true;
  }
  if (t.kind === "border") { place = logId(m, P.log); if (place == null) return false; }
  else if (t.kind === "water") {
    if (cnt(m, c.wbucket) < 1) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = getB(t.x + dx, t.y, t.z + dz); if (!BF.SOLID[n] && BF.FLUID[n] !== 8) return false; }   // walled in: it stays put
    place = c.water;
  } else {
    if (!hasHoe(m) || !c.till.has(old)) return false;
    place = c.farmland;
  }
  clearTop();
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
// ---------------------------------------------------------------- saving projects (inside the villagers map of save.js: keys "farmbeds:<village key>")
const savedProjects = new Map();   // village key -> projects not yet attached to a loaded village
const liveProjects = new Map();    // village key -> the village's project list
function projectsFor(R) {
  const k = R.key, list = savedProjects.get(k) || liveProjects.get(k) || [];
  savedProjects.delete(k); liveProjects.set(k, list);
  return list;
}
function exportAll(out) {
  for (const [k, list] of savedProjects) if (list.length) out["farmbeds:" + k] = JSON.parse(JSON.stringify(list));
  for (const [k, list] of liveProjects) if (list.length) out["farmbeds:" + k] = JSON.parse(JSON.stringify(list));
  return out;
}
function importAll(o) {
  savedProjects.clear(); liveProjects.clear(); savedProjects.clear();
  for (const k in o || {}) {
    if (k.slice(0, 9) !== "farmbeds:" || !Array.isArray(o[k])) continue;
    const list = o[k].filter(p => p && p.L && ["x0", "z0", "x1", "z1", "y"].every(f => Number.isFinite(p.L[f])) && Array.isArray(p.L.ch) && (p.L.ax === "x" || p.L.ax === "z"));
    for (const p of list) { p.fails = 0; p.wait = 0; }
    savedProjects.set(k.slice(9), list);
  }
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
    if (!success) fs.avoid[t.k] = BF.simNow() + 30;
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
    const spare = Math.max(0, cnt(m, c.wheat) - WHEAT_SPARE);
    const n = t.hay ? Math.min(Math.floor(spare / 9), 4) : Math.min(Math.floor(spare / 3), 16);
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
  if (t.proj) return performBed(m, fs, R, D, t);
  if (t.kind === "harvest") {
    const id = getB(t.x, t.y, t.z);
    if (!c.matureSet.has(id) || getB(t.x, t.y - 1, t.z) !== c.farmland || !dropsFit(m, id)) return false;
    if (!w.setBlock(t.x, t.y, t.z, 0)) return false;
    const drops = BF.rollDrops(id);
    for (const d of drops) Tinv.add(m.inv, d.id, d.count);
    for (const d of drops) {                     // spare seeds beyond a stack go on the compost heap
      const it = BF.items[d.id], extra = it && it.plants != null && !it.food ? cnt(m, d.id) - CROP_CAP : 0;
      if (extra > 0) Tinv.remove(m.inv, d.id, extra);
    }
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
  if (!w.isLoaded(t.x, t.z) || inVillage(D, t.x, t.z) || nearBeds(D, t.x, t.z)) return false;
  const id = getB(t.x, t.y, t.z);
  if (t.what === "dirt" ? !c.diggable.has(id) : !isLogBlock(id) || !naturalTree(t.x, t.y, t.z)) return false;
  const drops = BF.rollDrops(id);
  if (!Tinv.canFit(m.inv, drops.map(d => ({ id: d.id, n: d.count })), [])) return false;
  // a natural tree comes down whole (js/forester.js felling, no floating trunk left): its logs go into the pocket, what doesn't fit drops
  const tree = t.what === "log" && BF.forester && BF.forester.treeAt ? BF.forester.treeAt(t.x, t.y, t.z) : null;
  if (tree && BF.forester.fell) {
    const logs = tree.logs.map(([x, y, z]) => getB(x, y, z));
    BF.forester.fell(null, tree, false);
    let got = 0;
    for (const lid of logs) for (const d of BF.rollDrops(lid)) {
      if (Tinv.canFit(m.inv, [{ id: d.id, n: d.count }], [])) { Tinv.add(m.inv, d.id, d.count); got += d.count; }
      else if (BF.drops && BF.drops.spawnAt) BF.drops.spawnAt([d], t.x, t.y, t.z);
    }
    particles(t.x + 0.5, t.y + 0.5, t.z + 0.5, BF.blocks[id].color, 8, 0.8);
    log("gather", m, { at: [t.x, t.y, t.z], block: BF.blocks[id].name, n: got });
    return true;
  }
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
// harvest / plant / fill anywhere in the village area; bed work never on a building or its margin
function freeCellOrFarm(R, D, t) { return t.proj ? clearOfBuildings(R, D, t.x, t.z) : inArea(D, t.x, t.z); }

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
// ---------------------------------------------------------------- wheat for the shepherds (js/shepherd.js)
// A shepherd short of wheat buys it from the village (farmers first) at the fair price: 1 emerald buys ~90% of an emerald's worth.
function wheatDealWith(m, v2, want) {
  const T = TR(), c = ids(), val = (T.VALUE && T.VALUE.wheat_item) || 0.07;
  const per = Math.max(1, Math.floor(0.9 / val)), have = cnt(v2, c.wheat) - (v2.profession === "farmer" ? WHEAT_SELF : 0);
  if (have < per || cnt(m, c.em) < 1) return null;
  let k = Math.min(Math.ceil(want / per), cnt(m, c.em), Math.floor(have / per), 4);
  while (k > 0 && !(T.inv.canFit(m.inv, [{ id: c.wheat, n: per * k }], [{ id: c.em, n: k }]) && T.inv.canFit(v2.inv, [{ id: c.em, n: k }], [{ id: c.wheat, n: per * k }]))) k--;
  return k > 0 ? { kind: "wheat", seller: v2, times: k, per, item: c.wheat, price: 1 / per } : null;
}
function findWheatSeller(m) {
  const R = m.village, want = BF.shepherd ? BF.shepherd.wheatWanted(m) : 0, now = dayNow(), sh = m.fshop;
  if (!R || want <= 0) return null;
  let best = null, bs = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2) || (sh.avoid[v2.slot ? v2.slot.idx : -1] || 0) > now) continue;
    const d = wheatDealWith(m, v2, want);
    if (!d) continue;
    const sc = v2.position.distanceTo(m.position) * (v2.profession === "farmer" ? 0.5 : 1);
    if (sc < bs) { bs = sc; best = d; }
  }
  return best;
}
function doWheatDeal(m, deal) {
  const T = TR(), v2 = deal.seller, c = ids();
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(v2) || cnt(v2, c.wheat) < deal.per || cnt(m, c.em) < 1) break;
    if (!T.inv.canFit(m.inv, [{ id: c.wheat, n: deal.per }], [{ id: c.em, n: 1 }]) || !T.inv.canFit(v2.inv, [{ id: c.em, n: 1 }], [{ id: c.wheat, n: deal.per }])) break;
    T.inv.remove(v2.inv, c.wheat, deal.per); T.inv.add(v2.inv, c.em, 1);
    T.inv.remove(m.inv, c.em, 1); T.inv.add(m.inv, c.wheat, deal.per);
    done++;
  }
  if (done) {
    if (BF.vlog) BF.vlog.trade(m, v2, "gave " + done + " Emerald, got " + done * deal.per + " Wheat", done);
    log("buyWheat", m, { from: v2.profession + (v2.slot ? "#" + v2.slot.idx : ""), got: done * deal.per + " wheat", paid: done + " emerald" });
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
    const hasEm = cnt(m, ids().em) >= 1;
    const hungry = hasEm && F.available(m) < F.rate(m);
    const wheat = hasEm && m.profession === "shepherd" && !!BF.shepherd && BF.shepherd.wheatWanted(m) > 0;
    if (sh.cd > now || m.child || !(hungry || wheat)) return false;
    const deal = (hungry && findFoodSeller(m)) || (wheat && findWheatSeller(m)) || null;
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
    const done = deal.kind === "wheat" ? doWheatDeal(m, deal) : doFoodDeal(m, deal);
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
  const nowS = BF.simNow();
  for (const R of wantVillages) {                       // builders asking for water: keep their village's water ring scanned a while
    const D = R._life;
    if (!D || nowS - D.want > 120) { wantVillages.delete(R); continue; }
    if (!scanned.has(R)) scanStep(R, D, SCAN_COLS);
  }
}
// Butchers and fishermen cook the raw meat / fish they hold (conversion, nothing is created): up to 8 a day.
function cookDaily(m, day) {
  if (m.profession !== "butcher" && m.profession !== "fisherman" && m.profession !== "shepherd") return;   // shepherds cook their mutton
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
const NAMES = { dig: "Levelling a field", raise: "Filling in a field", gather: "Gathering", harvest: "Harvesting", plant: "Planting", till: "Tilling farmland", border: "Edging a bed", water: "Watering a bed", unborder: "Moving a bed's edge", fill: "Filling a bucket", craft: "Baking bread", tend: "Tending crops" };
function statusText(m) {
  if (!m) return "";
  if (m.starving) return "Too hungry to trade";
  if (m.fshop && m.fshop.stage) return m.fshop.deal && m.fshop.deal.kind === "wheat" ? "Buying wheat" : "Buying food";
  if (m.profession === "shepherd" && BF.shepherd && BF.shepherd.statusText) { const t = BF.shepherd.statusText(m); if (t) return t; }
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
function reset() { wantVillages.clear(); claims.clear(); liveProjects.clear(); LOG.length = 0; for (const p of pool) BF.scene && BF.scene.remove(p.mesh); pool.length = 0; acc = 0; }

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

BF.villageLife = { ai, tick, travel, particles, sound, canSell, WHEAT_SPARE, statusText, stats, reset, useBucket, log: LOG, vdata, think, claims, WORK_END, FARM_R, FARM_MAX, WATER_REACH, ensureKit, findWater, fillBucket,
  exportAll, importAll,
  _test: { detectBeds, growOptions, chooseProject, priceLayout, crowded, newBedOptions, outerOf, projectTask, cellJob, layoutAt, findFill, findGather, perform, dealWith, findFoodSeller, scanStep, inRange } };
})();
