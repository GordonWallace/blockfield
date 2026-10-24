// Builder villagers: choose a structure, find a site in open space around the village, and place it block by block out of the
// villager's own inventory (arm swing, particles, one item per block). Short of materials the builder buys from other villagers
// (real trade tables and inventories) or waits for the player to sell it some (builder trade table in trading.js).
// State: m.bs on the mob; the village record (rec.built) lists the structures and their progress and is saved with the villagers.
// See CONTRACT.md "Builder villagers". Loaded after mobs.js and blueprints.js; only calls other modules at runtime.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

// ---- tunables ----
const BLOCK_T = [0.5, 0.8];       // seconds between two placed blocks (random per block)
let reachNow = 4.0;
const REACH = 4.0;                // blocks from the eye to the nearest point of the target cell
const EYE = 1.62;
const POST_REACH = 15;             // a bridge post is placed from the deck down to the river bed (js/blueprints.js bridge): long reach, no line of sight
const isPost = (e, c) => e.type === "bridge" && c.y < e.oy && !!BF.blueprints.woodOf(c.id) && BF.blueprints.woodOf(c.id)[1] === "log";
const BUILD_END = 0.47;           // sky time after which builders stop and go home (bedtime at sunset 0.5)
const SITE_RANGE = 40;            // sites up to this far outside the village's bounding box
const SITE_TRIES = 150, SITE_EVALS = 40, MAX_FILL = 2, MAX_SLOPE = 2;
const RECHECK = [30, 60];         // seconds between material re-checks while waiting for the player
const TRADE_PAUSE = 2.0;          // seconds the builder stands with a seller before the goods change hands
const FILL_SPARE = 8;             // foundation blocks reserved on top of a blueprint's own requirement
const SITE_MARGIN = 3;            // blocks kept free around existing buildings and built structures
const STYLES = ["plains", "desert", "snowy", "savanna", "taiga"];

const BP = () => BF.blueprints;
const TR = () => BF.trades;
const W = () => BF.world;
const RS = e => BF.rand.of(e);   // seeded random streams (js/rand.js)
const rnd = (r, a, b) => r.range(a, b);
const pending = new Map();         // village key -> built list (same array as rec.built)
const log = [];

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const allowed = () => skyT() < BUILD_END && !(skyT() > 0.5);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const styleIdx = s => (typeof s === "number" ? s : Math.max(0, STYLES.indexOf(s)));
// The block a structure is levelled with: the village style's foundation, dirt under a vegetable farm (its soil, idea-044).
const foundOf = (type, style) => (type === "veg_farm" && BF.B.dirt != null ? BF.B.dirt : BF.worldgen.palette(style).found);

// ---------------------------------------------------------------- food jobsites (idea-044)
// One entry of the builder's list, "food_jobsite", stands for the structures that feed the village: the vegetable farm and the sheep, cow,
// chicken and pig paddocks. When it is picked a second roll picks the kind (chooseFood). The stable is not one of them (horses are not food).
const FOOD = ["veg_farm", "pen", "pasture", "coop", "sty"];
const FOOD_WEIGHT = 2.5, STABLE_WEIGHT = 0.3;
const FOOD_PROF = { veg_farm: "farmer", pen: "shepherd", pasture: "cowherd", coop: "poultry_keeper", sty: "pig_farmer" };   // whose jobsite block it holds
const FOOD_ANIMAL = { pen: "sheep", pasture: "cow", coop: "chicken", sty: "pig" };
const ANIMAL_R = 80, ANIMAL_MIN = 2;   // a paddock is built only with this many wild animals of its kind within this many blocks of the village
const isFood = t => FOOD.includes(t);

function builtOf(rec) {
  if (!rec.built) rec.built = pending.get(rec.key) || [];
  pending.set(rec.key, rec.built);
  return rec.built;
}

// ---------------------------------------------------------------- materials
// Every structure is built from one wood species (entry.wood, see blueprints.js): its requirement names that species' planks, logs and fences
// exactly, and nothing stands in for them, so a spruce house never ends up with oak boards in it.
const have0 = (inv, id) => TR().inv.count(inv, id);
// Crafts for a structure in species `wood`: fences of that wood, and the oak door, crafting table and chest, all from that wood's planks;
// the planks from that wood's logs (analyze). Furnaces from cobblestone. Torches from coal and sticks, the sticks from that wood's planks.
function craftTable(wood) {
  const I = BF.I, t = {}, P = BP().woodItem(wood, "planks"), F = BP().woodItem(wood, "fence");
  t[I.oak_door] = { n: 3, from: [[P, 6]] };
  if (F != null) t[F] = { n: 3, from: [[P, 5]] };
  t[I.crafting_table] = { n: 1, from: [[P, 4]] };
  t[I.chest] = { n: 1, from: [[P, 8]] };
  t[I.furnace] = { n: 1, from: [[I.cobblestone, 8]] };
  if (I.torch != null && I.coal != null && I.stick != null) {
    t[I.torch] = { n: 4, from: [[I.coal, 1], [I.stick, 1]] };   // the coal is bought from whoever sells it
    t[I.stick] = { n: 4, from: [[P, 2]] };
  }
  const G = BP().woodItem(wood, "fence_gate");
  if (G != null) t[G] = { n: 1, from: [[P, 4]] };                                        // 4 sticks (2 planks) + 2 planks: the stable's paddock gate
  if (I.merchant_counter != null) t[I.merchant_counter] = { n: 1, from: [[P, 12]] };   // the market stall's jobsite: 3 slabs, 2 planks and a chest (recipes-jobs.js)
  if (I.tack_rack != null) t[I.tack_rack] = { n: 1, from: [[P, 4], [I.leather, 1], [I.iron_ingot, 1]] };   // the stable's jobsite (recipes-jobs.js)
  if (I.nesting_box != null && I.hay_bale != null) t[I.nesting_box] = { n: 1, from: [[P, 4], [I.hay_bale, 1]] };   // the coop's jobsite (js/poultry.js)
  if (I.milk_churn != null) t[I.milk_churn] = { n: 1, from: [[P, 4], [I.iron_ingot, 1]] };   // the pasture's jobsite (js/cowherd.js)
  if (I.bakers_oven != null) t[I.bakers_oven] = { n: 1, from: [[I.cobblestone, 8], [I.iron_ingot, 1]] };   // the bakehouse's jobsite (js/baker.js)
  if (I.feed_trough != null) t[I.feed_trough] = { n: 1, from: [[P, 7]] };   // the sty's jobsite (js/pigfarmer.js, recipes-jobs.js)
  if (I.composter != null) t[I.composter] = { n: 1, from: [[P, 4]] };       // the vegetable farm's jobsite: 7 slabs (recipes-jobs.js), idea-044
  if (I.loom != null && I.string != null) t[I.loom] = { n: 1, from: [[P, 2], [I.string, 2]] };   // the sheep pen's jobsite (recipes-jobs.js), idea-044
  if (I.glass_kiln != null) t[I.glass_kiln] = { n: 1, from: [[I.cobblestone, 4], [I.iron_ingot, 1]] };   // the glassworks' jobsite (js/glassmaker.js)
  if (I.honey_extractor != null) t[I.honey_extractor] = { n: 1, from: [[P, 4], [I.iron_ingot, 1]] };   // the apiary's jobsite (js/beekeeper.js)
  return t;
}
const CRAFTS = {};
// What is missing for `req` ({item: n}) when building in `wood`? Returns {ok, shortfall: {item: n}, crafts: [{id, times, n, from}]}: doors, fences,
// tables, chests and furnaces are crafted from planks / cobblestone, planks from logs of the same wood, when that closes the gap.
function analyze(inv, req, wood) {
  wood = wood || "oak";
  const BPr = BP(), T = CRAFTS[wood] || (CRAFTS[wood] = craftTable(wood));
  const need = {}, gain = {}, crafts = [];
  for (const k in req) need[k] = req[k];
  const have = id => have0(inv, id) + (gain[id] || 0);
  for (const k of Object.keys(T).sort((a, b) => (+a === BF.I.stick) - (+b === BF.I.stick))) {   // sticks last: torches add to their need
    const id = +k, def = T[k];
    if (!need[id]) continue;
    const deficit = need[id] - have(id);
    if (deficit <= 0) continue;
    const times = Math.ceil(deficit / def.n);
    crafts.push({ id, times, n: def.n, from: def.from });
    gain[id] = (gain[id] || 0) + times * def.n;
    for (const [ing, q] of def.from) need[ing] = (need[ing] || 0) + q * times;
  }
  const P = BPr.woodItem(wood, "planks"), L = BPr.woodItem(wood, "log"), defP = (need[P] || 0) - have(P);
  if (defP > 0 && L != null) {
    const spareLogs = have(L) - (need[L] || 0);
    if (spareLogs > 0) {
      const times = Math.min(Math.ceil(defP / 4), spareLogs);
      crafts.push({ id: P, times, n: 4, from: [[L, 1]] });
      gain[P] = (gain[P] || 0) + times * 4; need[L] = (need[L] || 0) + times;
    }
  }
  const shortfall = {};
  let ok = true;
  for (const k in need) { const s = need[k] - have(+k); if (s > 0) { shortfall[k] = s; ok = false; } }
  return { ok, shortfall, crafts };
}
// Units of each item the other villagers could sell right now (their offers x their stock).
function sellerStock(R) {
  const T = TR(), out = {};
  for (const v2 of R.members) {
    if (!v2 || v2.type !== "villager" || v2.dead || v2.removed || v2.profession === "builder" || !v2.trades || !v2.inv) continue;
    const seen = new Set();
    for (const o of v2.trades) {
      if (seen.has(o.sell.id) || T.blockReason(v2, o)) continue;
      seen.add(o.sell.id);
      out[o.sell.id] = (out[o.sell.id] || 0) + T.inv.count(v2.inv, o.sell.id);
    }
  }
  return out;
}
// The wood a new structure of `type` is built from: the species the builder can get most easily. Cost = what it would still lack, where items a
// villager has in stock cost a fifth; ties go to the wood it holds most of, then the village style's own wood. Returns the species name.
function chooseWood(m, type, style, opts, stock) {
  const BPr = BP(), sw = BPr.styleWood(style), R = m.village;
  stock = stock || (R ? sellerStock(R) : {});
  let best = null;
  for (const sp of BPr.woodsAvailable()) {
    const bp = BPr.get(type, 0, style, 0.5, opts, sp);
    if (!bp) return sw;
    const a = analyze(m.inv, bp.req, sp);
    let cost = 0;
    for (const k in a.shortfall) { const n = a.shortfall[k], s = Math.min(n, stock[k] || 0); cost += (n - s) + s * 0.2; }
    const held = have0(m.inv, BPr.woodItem(sp, "planks")) + 4 * have0(m.inv, BPr.woodItem(sp, "log"));
    const score = cost - Math.min(held, 200) * 0.001 - (sp === sw ? 0.0005 : 0);
    if (!best || score < best.score) best = { sp, score };
  }
  return best ? best.sp : sw;
}
function removeItems(inv, id, n) { return TR().inv.remove(inv, id, n) || 0; }
function applyCrafts(m, crafts) {
  const T = TR().inv, done = crafts.map(() => 0);
  for (let pass = 0; pass < 3; pass++) {                             // again: a craft can wait on another's output (planks -> sticks -> torches)
    let any = false;
    crafts.forEach((c, j) => {
      for (; done[j] < c.times; done[j]++) {
        if (!c.from.every(([ing, q]) => have0(m.inv, ing) >= q)) break;
        const trial = T.clone(m.inv);
        for (const [ing, q] of c.from) removeItems(trial, ing, q);
        if (T.add(trial, c.id, c.n) > 0) break;                     // no room
        for (let i = 0; i < m.inv.length; i++) m.inv[i] = trial[i];
        any = true;
      }
    });
    if (!any) break;
  }
}
const reqText = short => Object.keys(short).slice(0, 2).map(k => short[k] + " " + BF.itemName(+k)).join(", ");

// ---------------------------------------------------------------- starting stock
// Materials for the first house (small house of the village style) + 10 %, some spare foundation blocks, and a healthy purse.
// A village with a furniture maker gets its beds from it (js/furniture.js): its builders start without the beds of their kit and buy them.
const bedsFromFurniture = rec => !!(rec && rec.roster && rec.roster.some(sl => sl.prof === "furniture_maker"));
function startStock(v) {
  const T = TR().inv, a = T.create(), BPr = BP();
  const style = styleIdx(v && v.style);
  const bp = BPr.get("small_house", 0, style, 0.9);
  const found = BF.worldgen.palette(style).found;
  const ex = Object.assign({}, bp.exact);
  for (const k in ex) ex[k] = Math.ceil(ex[k] * 1.1);
  ex[found] = (ex[found] || 0) + FILL_SPARE;
  if (BF.I.red_bed != null && bedsFromFurniture(v && v.village)) delete ex[BF.I.red_bed];
  for (const k in ex) T.add(a, +k, ex[k]);
  T.add(a, BF.I.emerald, Math.floor(rnd(RS(v), 40, 81)));
  if (BF.I.bucket != null) T.add(a, BF.I.bucket, 1);        // an empty bucket: the well's water is carried in it
  return a;
}

// ---------------------------------------------------------------- entries (persisted) and their cells
function bpOf(e) {
  if (!e.wood || !BP().woodsAvailable().includes(e.wood)) e.wood = BP().styleWood(e.style);   // planned before woods were chosen: the style's own wood
  const key = e.rot + "|" + e.style + "|" + e.wood;
  if (!e._bp || e._bpKey !== key) { e._bp = BP().get(e.type, e.rot, e.style, e.h, e.opts, e.wood); e._bpKey = key; }
  return e._bp;
}
const nfill = e => (e.fill ? e.fill.length : 0);
const total = e => nfill(e) + bpOf(e).n;
// cell i of an entry in world coordinates: {x, y, z, id, item, cost, pair}
function cellOf(e, i) {
  const nf = nfill(e);
  if (i < nf) {
    // f[3]: 1 sand or gravel in a farm's soil, swapped for dirt; 2 a pasture's turf (a grass block from a dirt block); 3 dirt under turf
    const f = e.fill[i], k = f[3] | 0, D = BF.B.dirt, id = k === 2 ? BF.B.grass : k ? D : foundOf(e.type, e.style);
    return { x: f[0], y: f[1], z: f[2], id, item: k ? D : id, cost: 1, pair: false, ph: 0, dig: k === 1 || k === 2 };
  }
  const c = bpOf(e).cells[i - nf];
  return { x: e.ox + c.x, y: e.oy + c.y, z: e.oz + c.z, id: c.id, item: c.item, cost: c.cost, pair: c.pair, ph: c.ph, dig: !!c.dig };
}
// material still needed for the cells from index `from` (glazing a finished structure: only the cells still empty)
function remainingReq(e, from) {
  const req = {}, w = W();
  for (let i = from; i < e.n; i++) {
    const c = cellOf(e, i);
    if (e.glaze && w.isLoaded(c.x, c.z) && w.getBlock(c.x, c.y, c.z) === c.id) continue;
    if (c.cost) req[c.item] = (req[c.item] || 0) + 1;
  }
  return req;
}

// ---------------------------------------------------------------- sites
function rectsOverlap(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function obstacles(R, built) {
  const wg = R.wg, out = [], ex = (r, m) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
  if (wg) {
    for (const b of wg.buildings || []) out.push(ex([b.x0, b.z0, b.x1, b.z1], SITE_MARGIN));
    for (const p of wg.pads || []) out.push(ex([p.x0, p.z0, p.x1, p.z1], 2));
    for (const r of wg.roads || []) out.push(ex([r.x0, r.z0, r.x1, r.z1], 1));
    for (const l of wg.lamps || []) out.push(ex([l[0], l[1], l[0], l[1]], 2));
    for (const dd of wg.decor || []) out.push(ex([dd[0], dd[1], dd[0] + 1, dd[1]], 2));
    if (wg.arch && wg.arch.box) out.push(ex(wg.arch.box, 2)); // village entry arch + its sign (js/signs.js)
    for (const p of wg.posts || []) out.push(ex(p.box, 2));   // signposts to nearby villages (js/signs.js)
  } else out.push(ex([R.x - 8, R.z - 8, R.x + 8, R.z + 8], 2));
  for (const e of built) if (e.state !== "abandoned") out.push(ex([e.ox, e.oz, e.ox + e.w - 1, e.oz + e.d - 1], SITE_MARGIN));
  if (BF.villageLife && BF.villageLife.bedRects) for (const r of BF.villageLife.bedRects(R)) out.push(ex(r, 1));   // farm beds, and beds the farmers are making
  return out;
}
const GROUND_OK = /^(grass|dirt|sand|red_sand|snow_grass|snow|podzol|coarse_dirt|mycelium|gravel|mud|moss_block|stone|granite|diorite|andesite|tuff|calcite|clay|sandstone|red_sandstone|terracotta|[a-z_]*_terracotta)$/;
// Terrain check for a blueprint whose min corner is (px, pz): flat enough (<= MAX_SLOPE), solid natural ground, no water, nothing solid inside the volume.
// Returns {oy, fill: [[x,y,z]], slope} or null. Plants and short grass in the way are cleared for free; gaps under the floor are filled from the inventory.
function evalTerrain(bp, px, pz, found) {
  const w = W(), CSolid = BF.SOLID, REPL = BF.REPLACEABLE;
  const natural = id => !!(BF.blocks[id] && GROUND_OK.test(BF.blocks[id].name));
  let gmin = 1e9, gmax = -1e9;
  const gs = new Map();
  for (let z = pz - 1; z <= pz + bp.d; z++) for (let x = px - 1; x <= px + bp.w; x++) {
    if (!w.isLoaded(x, z)) return null;
    const g = w.heightAt(x, z);
    if (g < BF.MIN_Y + 1) return null;
    const above = w.getBlock(x, g + 1, z);
    if (BF.RENDER[above] === 3 || BF.RENDER[w.getBlock(x, g, z)] === 3) return null;
    const inner = x >= px && x < px + bp.w && z >= pz && z < pz + bp.d;
    if (inner) {
      if (!GROUND_OK.test(BF.blocks[w.getBlock(x, g, z)].name)) return null;
      gs.set(x + "," + z, g);
      if (g < gmin) gmin = g;
      if (g > gmax) gmax = g;
    } else if (BF.RENDER[above] === 3) return null;
  }
  if (gmax - gmin > MAX_SLOPE) return null;
  const oy = gmax + 1, fillCols = new Set();
  const fill = [], low = new Set();
  for (const c of bp.cells) {
    const x = px + c.x, z = pz + c.z, y = oy + c.y, cur = w.getBlock(x, y, z);
    if (c.dig) low.add(c.x + "," + c.z);   // a ground-layer cell (a farm's ring and channel): it is dug in where the ground is
    if (cur === c.id) continue;
    if (BF.RENDER[cur] === 3) return null;
    if (CSolid[cur] && !REPL[cur] && !(c.dig && natural(cur))) return null;
    if (c.y === 0 || c.dig) fillCols.add(c.x + "," + c.z);
  }
  // a farm's soil (marks.soil): filled with dirt up to the ring's level, and sand, gravel or the like at that level swapped for dirt
  const TILL = /^(grass|dirt|podzol|coarse_dirt|snow_grass|mycelium)$/;
  // a pasture's field (marks.turf): grass at the fence's ground level; other ground there is dug out and turfed (a dirt block that is grass
  // already: f[3] 2), lower columns filled with dirt first (f[3] 3)
  for (const [u, q] of bp.marks.turf || []) {
    const x = px + u, z = pz + q, g = gs.get(x + "," + z);
    if (g == null) continue;
    for (let y = g + 1; y < oy - 1; y++) fill.push([x, y, z, 3]);
    if (g < oy - 1 || w.getBlock(x, g, z) !== BF.B.grass) fill.push([x, oy - 1, z, 2]);
  }
  for (const [u, q] of (bp.ground && bp.marks.soil) || []) {
    const x = px + u, z = pz + q, g = gs.get(x + "," + z);
    if (g == null) continue;
    for (let y = g + 1; y < oy - 1; y++) fill.push([x, y, z]);
    if (g === oy - 1) { const b = BF.blocks[w.getBlock(x, g, z)]; if (!b || !TILL.test(b.name)) fill.push([x, g, z, 1]); }
    else fill.push([x, oy - 1, z]);
  }
  for (const k of fillCols) {
    const [cx, cz] = k.split(",").map(Number), x = px + cx, z = pz + cz;
    const g = gs.has(x + "," + z) ? gs.get(x + "," + z) : w.heightAt(x, z);
    for (let y = g + 1; y < (low.has(k) ? oy - 1 : oy); y++) fill.push([x, y, z]);
  }
  if (fill.length && fill.some(f => f[1] < oy - MAX_FILL - 1)) return null;
  return { oy, fill, slope: gmax - gmin };
}
function occupiedBox(m, r) {   // player or another mob inside the rect (x0, z0, x1, z1) + 2
  const hit = p => p.x >= r[0] - 2 && p.x <= r[2] + 3 && p.z >= r[1] - 2 && p.z <= r[3] + 3;
  const P = BF.player;
  if (P && P.position && !P.dead && hit(P.position)) return true;
  for (const o of BF.mobs.list) if (o !== m && !o.dead && !o.removed && hit(o.position)) return true;
  return false;
}
function findSite(m, type, opts, haveFound, wood) {
  const R = m.village, wg = R.wg, w = W(), built = builtOf(R);
  if (type === "bridge") {   // the span js/bridges.js chose at the busiest crossing: nothing to search for
    const p = BF.bridges ? BF.bridges.plan(R, true) : null;
    if (!p) return null;
    const bp = BP().get("bridge", p.rot, styleIdx(R.style), 0.5, p.opts, wood);
    if (!bp || occupiedBox(m, [p.ox, p.oz, p.ox + bp.w - 1, p.oz + bp.d - 1])) return null;
    return { score: 0, bp, rot: p.rot, h: 0.5, ox: p.ox, oz: p.oz, oy: p.oy, fill: [], opts: p.opts, span: p.span };
  }
  const style = styleIdx(R.style), found = foundOf(type, style);
  const attempt = (m.bs ? (m.bs.siteTry = (m.bs.siteTry || 0) + 1) : 0);
  const rng = mulberry(hash32(R.key + ":" + built.length + ":" + attempt + ":" + type) ^ ((BF.state && BF.state.seed) | 0));
  const obs = obstacles(R, built);
  const bx0 = wg ? wg.minX : R.x - 20, bx1 = wg ? wg.maxX : R.x + 20, bz0 = wg ? wg.minZ : R.z - 20, bz1 = wg ? wg.maxZ : R.z + 20;
  const bld = wg ? (wg.buildings || []) : [];
  const dist = (x, z) => {   // distance to the nearest building rect (0 inside)
    let best = 1e9;
    for (const b of bld) { const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1); best = Math.min(best, Math.hypot(dx, dz)); }
    return bld.length ? best : Math.hypot(x - R.x, z - R.z);
  };
  let best = null, evals = 0;
  for (let i = 0; i < SITE_TRIES && evals < SITE_EVALS; i++) {
    const wide = rng() < 0.4 ? SITE_RANGE : 6;
    const px = Math.floor(bx0 - wide + rng() * (bx1 - bx0 + 2 * wide)), pz = Math.floor(bz0 - wide + rng() * (bz1 - bz0 + 2 * wide));
    const h = (hash32(px + "," + pz + ":" + type) % 1000) / 1000;
    // probe with a rotation facing the village centre
    const rot = BF.dirIndex(R.x - px, R.z - pz);
    const bp = BP().get(type, rot, style, h, opts, wood);
    if (!bp) return null;
    const rect = [px, pz, px + bp.w - 1, pz + bp.d - 1];
    if (obs.some(o => rectsOverlap(o, rect))) continue;
    if (BF.worldgen.insideFace && !BF.worldgen.insideFace(rect[0], rect[1], rect[2], rect[3], BF.worldgen.EDGE_KEEP)) continue;   // the planet: never past a face edge
    if (dist(px + bp.w / 2, pz + bp.d / 2) > SITE_RANGE) continue;
    if (type === "sty" && BF.jobs && bp.marks.trough && Math.hypot(px + bp.marks.trough[0][0] + 0.5 - R.x, pz + bp.marks.trough[0][1] + 0.5 - R.z) > Math.max(BF.jobs.RADIUS, (wg && wg.reach) || 0) - 1) continue;   // its trough within the jobless's reach (jobs.js unclaimed)
    evals++;
    if (occupiedBox(m, rect)) continue;
    const t = evalTerrain(bp, px, pz, found);
    if (!t) continue;
    if (t.fill.filter(f => !f[3]).length > haveFound) continue;   // turf and soil dirt is bought or dug as it goes
    const score = Math.abs(dist(px + bp.w / 2, pz + bp.d / 2) - 5) + rng() * 6 + t.fill.length * 0.5 + t.slope * 1.5;
    if (!best || score < best.score) best = { score, bp, rot, h, ox: px, oz: pz, oy: t.oy, fill: t.fill, opts };
  }
  return best;
}

// ---------------------------------------------------------------- plans
const lamps = inv => (TR().inv.count(inv, BF.I.lantern) >= 3 ? { lantern: true } : null);
function optsFor(type, inv, R) {
  if (type === "bridge") { const p = BF.bridges && R ? BF.bridges.plan(R) : null; return p ? p.opts : null; }   // the span it would cross (js/bridges.js)
  if (type === "lamp_posts") return lamps(inv);
  if ((type === "garden" || type === "stable" || type === "pasture" || type === "pen") && TR().inv.count(inv, BF.I.hay_bale) >= 2) return { hay: true };
  if (type === "sty" && BF.I.coarse_dirt != null && TR().inv.count(inv, BF.I.coarse_dirt) >= 4) return { mud: true };   // the wallow (js/blueprints.js)
  return null;
}
// What a villager sells: its offers, job and spare goods (js/market.js). Leather for a stable's tack rack comes from a leatherworker's spare goods.
const offersOf = v2 => v2.trades;
// Stables (idea-044): a low weight of their own, and only with ANIMAL_MIN wild horses within ANIMAL_R blocks of the village. One per village
// (js/stables.js has one stable hand per village).
function stableWeight(R, has) {
  if (!BF.stables || has || (BF.stables.stableOf && BF.stables.stableOf(R))) return 0;
  return wildCount(R, "horse") >= ANIMAL_MIN ? STABLE_WEIGHT : 0;
}
// Wild animals of a kind within ANIMAL_R blocks of the village centre: loaded, alive, and in nobody's pen (tamed horses are not wild).
function wildCount(R, kind) {
  if (kind === "horse") return BF.horses && BF.horses.wildCount ? BF.horses.wildCount(R.x, R.z, ANIMAL_R) : 0;
  let n = 0;
  for (const o of BF.mobs.list) {
    if (o.type !== kind || o.dead || o.removed || o.pen || o.pasture || o.coop || o.sty || o.ledBy) continue;
    if (Math.hypot(o.position.x - R.x, o.position.z - R.z) <= ANIMAL_R && ++n >= ANIMAL_MIN) break;
  }
  return n;
}
// How many of each food jobsite the village has, counted by their jobsite blocks (composter, loom, milk churn, nesting box, feed trough) in
// the village and the ground its builders build on, so a farm or paddock the player built counts too; plus the ones being built.
function foodCounts(R) {
  const out = {}, wg = R.wg, J = BF.jobs, m = SITE_RANGE + 4;
  for (const t of FOOD) out[t] = 0;
  const box = wg ? [wg.minX - m, wg.minZ - m, wg.maxX + m, wg.maxZ + m] : [R.x - 60, R.z - 60, R.x + 60, R.z + 60];
  if (J && J.sites) for (const s of J.sites.values()) {
    if (s.x < box[0] || s.x > box[2] || s.z < box[1] || s.z > box[3]) continue;
    for (const t of FOOD) if (FOOD_PROF[t] === s.prof) out[t]++;
  }
  for (const e of builtOf(R)) if (e.state === "building" && isFood(e.type)) out[e.type]++;
  return out;
}
// The requirement a builder plans a structure by: its blueprint's, foundation (or dirt) to level it, and a bucket when it pours water.
function planReq(m, bp, type, style) {
  const req = Object.assign({}, bp.req), found = foundOf(type, style);
  req[found] = (req[found] || 0) + FILL_SPARE;
  if (bp.free && bp.free[BF.B.water] && BF.I.bucket != null && have0(m.inv, BF.I.bucket) + (BF.I.water_bucket != null ? have0(m.inv, BF.I.water_bucket) : 0) < 1) req[BF.I.bucket] = 1;
  return req;
}
// Can the builder get what structure `type` needs? Everything missing is for sale in the village now (dirt it can always dig).
function materialsOK(m, type, stock) {
  const R = m.village, style = styleIdx(R.style), opts = optsFor(type, m.inv, R), wood = chooseWood(m, type, style, opts, stock);
  const bp = BP().get(type, 0, style, 0.5, opts, wood);
  if (!bp) return false;
  const a = analyze(m.inv, planReq(m, bp, type, style), wood);
  return a.ok || onlyPanes(R, a, stock) || Object.keys(a.shortfall).every(k => stock[k] > 0 || +k === BF.I.dirt || +k === PANE());
}
// The second roll when "food_jobsite" is picked (idea-044). First only the kinds the village has none of, at even odds: a paddock needs its
// materials and ANIMAL_MIN wild animals of its kind within ANIMAL_R blocks, the farm only its materials; a kind that fails is out and the roll
// is made again. When every missing kind is out, the rest that were not ruled out are rolled, favouring the kinds the village has fewest of
// (weight 1 / (1 + count)), with the same checks. Returns the kind, or null when nothing passes.
function chooseFood(m, bs) {
  const R = m.village, counts = foodCounts(R), stock = sellerStock(R), out = new Set(), now = dayNow();
  for (const t of FOOD) if (bs.fail && bs.fail[t] > now) out.add(t);
  const check = t => {
    if (!materialsOK(m, t, stock)) { logEvent("foodOut", m, { type: t, why: "materials" }); return false; }
    if (FOOD_ANIMAL[t] && wildCount(R, FOOD_ANIMAL[t]) < ANIMAL_MIN) { logEvent("foodOut", m, { type: t, why: "no " + FOOD_ANIMAL[t] + " within " + ANIMAL_R }); return false; }
    return true;
  };
  const roll = wt => {
    for (;;) {
      const pool = FOOD.filter(t => !out.has(t) && wt(t) > 0);
      if (!pool.length) return null;
      let sum = 0;
      for (const t of pool) sum += wt(t);
      let r = RS(m).next() * sum, pick = pool[pool.length - 1];
      for (const t of pool) if ((r -= wt(t)) <= 0) { pick = t; break; }
      if (check(pick)) return pick;
      out.add(pick);
    }
  };
  const t = roll(t => (counts[t] === 0 ? 1 : 0)) || roll(t => 1 / (1 + counts[t]));
  logEvent("food", m, { pick: t, counts });
  return t;
}
// Glassworks (js/glassmaker.js): only where there is natural sand within 64 blocks; wanted when the village has no glassmaker or glass kiln
// (generated or built) and 12 or more villagers, hardly ever after that (as the bakehouse).
function glassWeight(R, has) {
  if (BF.B.glass_kiln == null || !BF.worldgen.sandNear || !BF.worldgen.sandNear(R.x, R.z, 64)) return 0;
  if (has || R.members.some(x => x.profession === "glassmaker" && !x.dead)) return 0.02;
  return R.members.filter(x => x.type === "villager" && !x.dead && !x.removed).length >= 12 ? 1.5 : 0.05;
}
// Windows without glass (js/glassmaker.js): a village with no glassmaker where nobody has glass panes for sale builds its windows as open gaps
// (entry.gaps), and fills them in once panes turn up (think: glaze). True when panes are all a structure lacks and none are to be had.
const PANE = () => BF.I.glass_pane;
const noPanes = (R, stock) => PANE() != null && !((stock || sellerStock(R))[PANE()] > 0) && !R.members.some(x => x.profession === "glassmaker" && !x.dead && !x.removed);
const onlyPanes = (R, a, stock) => !a.ok && Object.keys(a.shortfall).every(k => +k === PANE()) && noPanes(R, stock);
// The weight of each type the builder may pick now: [[type, weight]].
function weighTypes(m, bs) {
  const R = m.village, built = builtOf(R), BPr = BP(), style = styleIdx(R.style);
  const cnt = t => built.filter(e => e.type === t && e.state !== "abandoned").length;
  const homeless = R.members.filter(x => x.type === "villager" && !x.dead && !x.removed && !(x.bed && !x.bed.tent ? x.bed : x.homeBed)).length;   // a camping explorer with no bed at home is homeless too
  // a village with no spare bed cannot grow (js/breeding.js needs one free bed per birth): its bed structures are as likely as the likeliest other one
  const Br = BF.breeding, full = !!(Br && R.roster && Br.bedCount(R) - Br.villagerCount(R) < 1);
  const found = BF.worldgen.palette(style).found;
  const wt = {
    small_house: cnt("small_house") + cnt("medium_house") + cnt("cottage") >= 8 ? 0.3 : 1,
    medium_house: 0.4,
    cottage: 0.3,
    well: cnt("well") === 0 ? 1.2 : 0.15,
    lamp_posts: cnt("lamp_posts") < 2 ? 1.0 : 0.2,
    market_stall: cnt("market_stall") < 2 ? 0.7 : 0.15,
    workshop: cnt("workshop") < 1 ? 0.5 : 0.1,
    stable: stableWeight(R, cnt("stable") > 0),
    // the farm and the sheep, cow, chicken and pig paddocks (idea-044): one entry, its kind rolled when it is picked (chooseFood)
    food_jobsite: FOOD_WEIGHT,
    // a bakehouse (js/baker.js): wanted when the village has no baker's oven (planned or built) and 15 or more villagers, hardly ever after that
    bakehouse: (R.wg && (R.wg.jobsites || []).some(j => j.prof === "baker")) || cnt("bakehouse") > 0 || R.members.some(x => x.profession === "baker" && !x.dead) ? 0.02
      : R.members.filter(x => x.type === "villager" && !x.dead && !x.removed).length >= 15 ? 1.5 : 0.05,
    glassworks: glassWeight(R, (R.wg && (R.wg.jobsites || []).some(j => j.prof === "glassmaker")) || cnt("glassworks") > 0),
    // an apiary (js/beekeeper.js): only in a village on grass; wanted when it has no beekeeper or extractor and 6 or more villagers, hardly ever after
    apiary: !(BF.cowherd && BF.cowherd.grassVillage(R)) || BF.B.honey_extractor == null ? 0
      : (R.wg && (R.wg.jobsites || []).some(j => j.prof === "beekeeper")) || cnt("apiary") > 0 || R.members.some(x => x.profession === "beekeeper" && !x.dead) ? 0.02
      : R.members.filter(x => x.type === "villager" && !x.dead && !x.removed).length >= 6 ? 1.2 : 0.05,
  };
  const BEDS = ["small_house", "medium_house", "cottage"];
  if (full) {   // with every bed claimed they rise to the weight of the likeliest other type
    let top = 0;
    for (const t in wt) if (!BEDS.includes(t) && t !== "food_jobsite" && !(bs.fail && bs.fail[t] > dayNow())) top = Math.max(top, wt[t]);
    for (const t of BEDS) wt[t] = Math.max(wt[t], top);
  }
  wt.bridge = BF.bridges ? BF.bridges.weight(R) : 0;   // 1.2, 2 when busy; 0 with no crossing to bridge
  wt.small_house += 1.6 * Math.min(homeless, 3);      // and each villager with no bed makes them likelier still
  wt.medium_house += homeless >= 2 ? 1.2 : 0;
  wt.cottage += homeless >= 1 ? 0.6 : 0;
  const stock = sellerStock(R);
  const ws = [];
  if (!(bs.fail && bs.fail.food_jobsite > dayNow())) ws.push(["food_jobsite", FOOD_WEIGHT]);   // its materials are weighed with its kind (chooseFood)
  for (const t of BPr.TYPES) {
    if (bs.fail && bs.fail[t] > dayNow()) continue;
    if (isFood(t) || t === "garden") continue;                   // food jobsites come through "food_jobsite"; the garden pen gave way to the farm
    if (t === "stable" && !wt.stable) continue;                  // only with wild horses near
    if (t === "glassworks" && !wt.glassworks) continue;          // never without sand nearby
    if (t === "apiary" && !wt.apiary) continue;                  // never off grass
    if (t === "bridge" && !wt.bridge) continue;                  // only where villagers keep crossing water (js/bridges.js)
    const opts = optsFor(t, m.inv, R), wood = chooseWood(m, t, style, opts, stock);
    const bp = BPr.get(t, 0, style, 0.5, opts, wood);
    const a = analyze(m.inv, planReq(m, bp, t, style), wood);
    const buyable = Object.keys(a.shortfall).every(k => stock[k] > 0);   // some villager has it to sell right now
    const mult = a.ok || onlyPanes(R, a, stock) ? 3 : buyable ? 1.2 : 0.25;
    const x = (wt[t] || 0.3) * mult;
    ws.push([t, x]);
  }
  return ws;
}
function pickType(m, bs) {
  const R = m.village;
  if (builtOf(R).length === 0 && !(bs.fail && bs.fail.small_house > dayNow())) return "small_house";
  const ws = weighTypes(m, bs);
  while (ws.length) {
    let sum = 0;
    for (const w of ws) sum += w[1];
    let r = RS(m).next() * sum, t = ws[ws.length - 1][0];
    for (const [k, x] of ws) if ((r -= x) <= 0) { t = k; break; }
    if (t !== "food_jobsite") return t;
    const sub = chooseFood(m, bs);
    if (sub) return sub;
    bs.fail.food_jobsite = dayNow() + 0.12;   // no farm or paddock can be had now: pick among the other types
    ws.splice(ws.findIndex(w => w[0] === "food_jobsite"), 1);
  }
  return null;
}

function newState(m) { return BF.ids.refs({ mode: "idle", t: rnd(RS(m), 1, 3), cool: 0, stage: null, fail: {}, avoid: {}, placeT: 0.6, entry: null, want: null, losT: 0, losFor: -1 }); }
const nextId = built => built.reduce((a, e) => Math.max(a, e.id || 0), 0) + 1;
function logEvent(kind, m, data) {
  const e = Object.assign({ kind, day: +dayNow().toFixed(3), builder: m && m.slot ? m.slot.idx : null }, data);
  log.push(BF.glog.job("builder", e)); if (log.length > 200) log.shift();
  try { console.info("[builder] " + kind + " " + JSON.stringify(data)); } catch (_) {}
}

// Village log lines (kind "build", js/villagelog.js): "Aroha Parata (Builder) started building a spruce small house at x, y, z", "... built a ...".
// The location is the structure's corner (ox, oy, oz). js/logmatch.js reads these lines for the debug screen's filters and alerts.
function what(e, the) {   // "a spruce small house", "an oak cottage", "the spruce small house", "lamp posts"
  const label = String(e.label || BP().label(e.type)), s = (e.wood && bpOf(e).woody ? String(e.wood).replace(/_/g, " ") + " " : "") + label;
  return /s$/.test(label) ? s : (the ? "the " : /^[aeiou]/i.test(s) ? "an " : "a ") + s;
}
function vlogBuild(m, e, verb) {
  if (!BF.vlog || !m || !m.village) return;
  const who = BF.vlog.nameOf(m) + " (" + BF.vlog.pretty(m.profession || "builder") + ")";
  BF.vlog.log(m.village, "build", who + " " + (e.type === "bridge" && verb === "built" ? "finished a bridge over the river" : verb + " " + what(e, verb === "took over building")) + " at " + e.ox + ", " + e.oy + ", " + e.oz +
    (verb === "built" ? " (" + e.n + " blocks)" : ""), [e.ox, e.oy, e.oz]);
}

// Try to start the structure `type`: site, crafts, entry. Returns the entry or null (and remembers the failure).
// `wood`: the species chosen for it (chooseWood when omitted); the whole structure is built from it.
// Saplings on the site (and the block round it) are cleared when it is planned: one left there could grow into a tree in a cell before its
// block goes in (a farm's composter), or inside the farm. Foresters do not plant on a site being built (js/forester.js findSpot).
function clearSaplings(e) {
  const w = W();
  for (let x = e.ox - 1; x <= e.ox + e.w; x++) for (let z = e.oz - 1; z <= e.oz + e.d; z++) for (let y = e.oy - MAX_SLOPE - 1; y <= e.oy + 1; y++) {
    const b = BF.blocks[w.getBlock(x, y, z)];
    if (b && /_sapling$/.test(b.name)) w.setBlock(x, y, z, 0);
  }
}
function beginPlan(m, bs, type, wood) {
  const R = m.village, built = builtOf(R), style = styleIdx(R.style);
  const found = foundOf(type, style);
  const opts = optsFor(type, m.inv, R);
  wood = wood || chooseWood(m, type, style, opts);
  const bp0 = BP().get(type, 0, style, 0.5, opts, wood);
  const req = Object.assign({}, bp0.req);
  const a = analyze(m.inv, req, wood);
  if (!a.ok && !onlyPanes(R, a)) return null;
  const spare = Math.max(0, have0(m.inv, found) - (req[found] || 0));
  const site = findSite(m, type, opts, type === "veg_farm" ? Math.max(spare, 24) : spare, wood);   // a farm's levelling dirt it buys or digs as it goes
  if (!site) { bs.fail[type] = dayNow() + 0.12; logEvent("nosite", m, { type }); return null; }
  applyCrafts(m, a.crafts);
  const e = { id: nextId(built), type, label: site.bp.label, rot: site.rot, style, wood, h: site.h, opts: opts || undefined, ox: site.ox, oy: site.oy, oz: site.oz,
    w: site.bp.w, d: site.bp.d, prog: 0, skipped: 0, state: "building", owner: m.slot ? m.slot.idx : 0, fill: site.fill, start: +dayNow().toFixed(3) };
  if (site.span) e.span = site.span;   // a bridge: the water it crosses (js/bridges.js walks villagers over it)
  e.n = nfill(e) + site.bp.n;
  clearSaplings(e);
  built.push(e);
  logEvent("plan", m, { type, wood, at: [e.ox, e.oy, e.oz], rot: e.rot, blocks: e.n, fill: nfill(e) });
  vlogBuild(m, e, "started building");
  return e;
}

// The builder's own pace: game seconds per block while it works at the site (the walk there not counted), over windows of PACE_N blocks,
// averaged. Sites differ (standing spots, line of sight, crowds), so the estimate follows what this builder actually manages.
const PACE_N = 20;
function pace(m, bs, e, dt, near) {
  if (bs.paceE !== e.id) { bs.paceE = e.id; bs.paceP = e.prog; bs.paceT = 0; }
  if (near) bs.paceT += dt;
  const n = e.prog - bs.paceP;
  if (n < 0) { bs.paceP = e.prog; bs.paceT = 0; return; }   // a second pass starts back at the skipped cells
  if (n < PACE_N) return;
  const spb = bs.paceT / n;
  bs.spb = bs.spb ? (bs.spb + spb) / 2 : spb;
  bs.paceP = e.prog; bs.paceT = 0;
  // the structure's estimate follows the pace, so a countdown that starts mid-build waits for what is really left (js/villagesim.js)
  const VS = BF.villageSim, t = m.vtask;
  if (VS && t && t.what && t.what.indexOf("Building ") === 0) {
    const per = Math.max((BLOCK_T[0] + BLOCK_T[1]) / 2 + 0.25, bs.spb);
    t.end = dayNow() + (e.n - e.prog) * per * (VS.EST_MARGIN || 1) / 1200;
  }
  logEvent("pace", m, { spb: +bs.spb.toFixed(2), left: e.n - e.prog });
}
// Whole-structure estimate: blocks left x the time per block (the builder's measured pace, never below the mean placing time plus the
// steps between standing spots, ~0.25 s a block) and the walk to the site.
// Tells the village sim (begin) before the builder commits; false = it would not finish in time, so it must not start the structure.
function beginBuild(m, blocks, x, z, name) {
  const VS = BF.villageSim;
  const per = Math.max((BLOCK_T[0] + BLOCK_T[1]) / 2 + 0.25, (m.bs && m.bs.spb) || 0);
  return !(VS && VS.begin) || VS.begin(m, blocks * per + (x == null ? 0 : VS.walkSecs(m, [[x, z]])), "Building " + name);
}
// `pre`: the caller already began the task. Returns false when the structure is not started (countdown: it would not finish).
function startBuild(m, bs, e, pre) {
  if (!pre && !beginBuild(m, e.n - e.prog, e.ox + e.w / 2, e.oz + e.d / 2, what(e))) { if (bs.mode === "shop") { bs.stage = "wait"; bs.t = 3; } return false; }
  bs.mode = "build"; bs.entry = e; bs.goal = null; bs.cands = null; bs.ci = 0; bs.noSpot = 0; bs.occT = 0; bs.want = null; bs.stage = null;
  bs.placeT = Math.max(bs.placeT, 0.4); bs.losT = 0; bs.losFor = -1;
  m.ai.route = null;
  if (!bs.next) bs.next = pickNext(m, bs);   // it knows what comes next, so it keeps those materials too (js/market.js)
  return true;
}
// The structure it will build after this one: {type, wood, req} with the requirement as think() counts it.
function pickNext(m, bs) {
  const R = m.village;
  if (!R || !R.wg) return null;
  const type = pickType(m, bs);
  if (!type) return null;
  const style = styleIdx(R.style);
  const opts = optsFor(type, m.inv, R), wood = chooseWood(m, type, style, opts);
  const req = planReq(m, BP().get(type, 0, style, 0.5, opts, wood), type, style);
  return { type, wood, req };
}
// What the builder keeps for itself (js/market.js): the materials left on the structure it is building (or is buying for) and those of
// the next one it has chosen, with whatever it would craft them from (logs for planks, planks for doors). {item id: n}
function reserve(m) {
  const bs = m.bs, R = m.village, out = {};
  if (!bs || !R) return out;
  const add = (req, wood) => {
    for (const k in req) out[k] = (out[k] || 0) + req[k];
    for (const c of analyze(m.inv, req, wood).crafts) for (const [ing, q] of c.from) out[ing] = (out[ing] || 0) + q * c.times;
  };
  const mine = builtOf(R).find(e => e.state === "building" && e.owner === (m.slot ? m.slot.idx : 0));
  if (mine) add(remainingReq(mine, mine.prog), bpOf(mine).wood);
  else if (bs.want && bs.want.req) add(bs.want.req, bs.want.wood);
  if (bs.next) add(bs.next.req, bs.next.wood);
  return out;
}
// What it is short of while shopping (js/market.js turns what its table doesn't buy into need offers). {item id: n}
const shortfall = m => (m.bs && m.bs.mode === "shop" && m.bs.want && m.bs.want.short) || {};

function think(m, bs) {
  const R = m.village, built = builtOf(R);
  const active = built.find(e => e.state === "building");
  if (active) {
    // the owner keeps it only while it is alive and still a builder; otherwise this builder takes it over (with its own materials)
    const ownerBuilds = R.members.some(x => !x.removed && !x.dead && x.profession === "builder" && x.slot && x.slot.idx === active.owner);
    const mine = active.owner === (m.slot && m.slot.idx);
    if (mine || !ownerBuilds) {
      if (!beginBuild(m, active.n - active.prog, active.ox + active.w / 2, active.oz + active.d / 2, what(active))) return;
      if (!mine) vlogBuild(m, active, "took over building");
      active.owner = m.slot ? m.slot.idx : 0; startBuild(m, bs, active, true);
    }
    return;
  }
  if (bs.cool > 0) return;
  if (!R.wg) return;
  if (glaze(m, bs, built)) return;
  const nx = bs.next; bs.next = null;   // chosen when it started the last one
  const type = nx && !(bs.fail[nx.type] > dayNow()) ? nx.type : pickType(m, bs);
  if (!type) return;
  const style = styleIdx(R.style);
  const opts = optsFor(type, m.inv, R), wood = nx && nx.type === type ? nx.wood : chooseWood(m, type, style, opts);
  const bp = BP().get(type, 0, style, 0.5, opts, wood);
  const req = planReq(m, bp, type, style);
  const a = analyze(m.inv, req, wood);
  if (a.ok || onlyPanes(R, a)) {
    if (!beginBuild(m, bp.n, null, null, String(bp.label || BP().label(type)))) return;   // not started: no site chosen, nothing used
    const e = beginPlan(m, bs, type, wood);
    if (e) startBuild(m, bs, e); else if (BF.villageSim) BF.villageSim.done(m);
    return;
  }
  bs.mode = "shop"; bs.want = { type, wood, req, short: a.shortfall }; bs.stage = "think"; bs.t = 0;
}

// ---------------------------------------------------------------- movement helpers (A* and route following live in mobs.js)
const nav = () => BF.mobs.nav;
// Walks towards cell (gx, gy, gz); exact: end on that cell, else within tol blocks. Returns "arrived" | "going" | "failed".
function travel(m, bs, dt, out, g, tol, speed) {
  const ai = m.ai, N = nav(), px = m.position.x, pz = m.position.z;
  const d = Math.hypot(g.x + 0.5 - px, g.z + 0.5 - pz), dy = Math.abs(g.y - m.position.y);
  if (d <= tol && dy < 1.6) { ai.route = null; bs.navFail = 0; return "arrived"; }
  if (!ai.route || ai.routeKind !== "build") {
    ai.route = null;
    if (bs.navWait > 0) { bs.navWait -= dt; steer(m, g.x + 0.5, g.z + 0.5, speed, out); return "going"; }
    if (!N.takePlan()) { steer(m, g.x + 0.5, g.z + 0.5, speed * 0.6, out); return "going"; }
    const hop = d > 22 ? [Math.round(px + (g.x + 0.5 - px) * 20 / d), Math.round(pz + (g.z + 0.5 - pz) * 20 / d)] : null;
    const hx = hop ? Math.floor(hop[0]) : g.x, hz = hop ? Math.floor(hop[1]) : g.z;
    const [fx, fy, fz] = N.feetCell(m);
    const goal = hop
      ? { x: hx, z: hz, at: (x, y, z) => Math.abs(x - hx) + Math.abs(z - hz) <= 2 }
      : tol > 1 ? { x: g.x, z: g.z, at: (x, y, z) => Math.hypot(x - g.x, z - g.z) <= tol && Math.abs(y - g.y) < 2 }
        : { x: g.x, z: g.z, at: (x, y, z) => x === g.x && y === g.y && z === g.z };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "build"; bs.navFail = 0; }
    else {
      bs.navFail = (bs.navFail || 0) + 1; bs.navWait = 0.8;
      if (bs.navFail >= (hop ? 6 : 3)) { bs.navFail = 0; return "failed"; }
    }
    return "going";
  }
  const st = N.followRoute(m, dt, out, speed);
  if (st === "stuck") { ai.route = null; bs.navFail = (bs.navFail || 0) + 1; if (bs.navFail >= 3) { bs.navFail = 0; return "failed"; } }
  else if (st === "done") ai.route = null;
  return "going";
}
function steer(m, x, z, speed, out) {
  const dx = x - m.position.x, dz = z - m.position.z, d = Math.hypot(dx, dz);
  if (d > 0.04) { const sp = Math.min(speed, d * 4 + 0.15); out.x = dx / d * sp; out.z = dz / d * sp; }
}
function nearestDist(m, c) {   // eye -> nearest point of the cell
  const ex = m.position.x, ey = m.position.y + EYE, ez = m.position.z;
  const nx = Math.min(Math.max(ex, c.x), c.x + 1), ny = Math.min(Math.max(ey, c.y), c.y + 1), nz = Math.min(Math.max(ez, c.z), c.z + 1);
  return Math.hypot(nx - ex, ny - ey, nz - ez);
}
function losOK(m, c) { return losFrom(m.position.x, m.position.y, m.position.z, c); }
function losFrom(px, py, pz, c) {
  // the block can be placed when some point of the cell (centre, face centres, inset corners) is in the open from the eye
  const from = new THREE.Vector3(px, py + EYE, pz), dir = new THREE.Vector3(), W_ = W();
  const pts = [[0.5, 0.5, 0.5], [0.5, 0.5, 0.02], [0.5, 0.5, 0.98], [0.02, 0.5, 0.5], [0.98, 0.5, 0.5], [0.5, 0.02, 0.5], [0.5, 0.98, 0.5],
    [0.1, 0.1, 0.1], [0.9, 0.1, 0.1], [0.1, 0.9, 0.1], [0.9, 0.9, 0.1], [0.1, 0.1, 0.9], [0.9, 0.1, 0.9], [0.1, 0.9, 0.9], [0.9, 0.9, 0.9]];
  for (const [a, b, d] of pts) {
    dir.set(c.x + a - from.x, c.y + b - from.y, c.z + d - from.z);
    const dist = dir.length();
    if (dist < 0.6) return true;
    dir.divideScalar(dist);
    const hit = W_.raycast(from, dir, dist);
    if (!hit || hit.dist >= dist - 0.05) return true;
  }
  return false;
}
const overlapsBody = (m, c) => m.position.x + 0.3 > c.x && m.position.x - 0.3 < c.x + 1 && m.position.z + 0.3 > c.z && m.position.z - 0.3 < c.z + 1 &&
  m.position.y < c.y + 1 && m.position.y + 1.95 > c.y;
function otherInside(m, c) {   // the player or another mob stands where the block would go
  const hit = (p, hw, h) => p.x + hw > c.x && p.x - hw < c.x + 1 && p.z + hw > c.z && p.z - hw < c.z + 1 && p.y < c.y + 1 && p.y + h > c.y;
  const P = BF.player;
  if (P && P.position && !P.dead && hit(P.position, 0.3, 1.8)) return true;
  for (const o of BF.mobs.list) if (o !== m && !o.dead && !o.removed && hit(o.position, o.halfWidth, o.height)) return true;
  return false;
}
function spotsFor(m, bs, c, e) {
  const N = nav(), [fx, fy, fz] = N.feetCell(m), bp = bpOf(e), out = [];
  const ahead = [];                                            // the next few cells: prefer spots that reach them too (fewer walks)
  for (let k = 1; k <= 10 && e.prog + k < e.n; k++) ahead.push(cellOf(e, e.prog + k));
  const post = isPost(e, c);
  for (let dy = -4; dy <= (post ? POST_REACH : 1); dy++) for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
    const sx = c.x + dx, sy = c.y + dy, sz = c.z + dz;
    if (sx === c.x && sz === c.z && (sy === c.y || sy + 1 === c.y)) continue;
    const ex = sx + 0.5, ey = sy + EYE, ez = sz + 0.5;
    const nx = Math.min(Math.max(ex, c.x), c.x + 1), ny = Math.min(Math.max(ey, c.y), c.y + 1), nz = Math.min(Math.max(ez, c.z), c.z + 1);
    const d = Math.hypot(nx - ex, ny - ey, nz - ez);
    if (d > reachNow - 0.2) continue;
    if (!N.walkCell(sx, sy, sz)) continue;
    // a bridge is built at the feet layer of its banks and its deck: never stand where one of the next blocks goes
    if (e.type === "bridge" && ahead.some(a => a.x === sx && a.z === sz && (a.y === sy || a.y === sy + 1))) continue;
    const inside = sx >= e.ox && sx < e.ox + bp.w && sz >= e.oz && sz < e.oz + bp.d && sy > e.oy;
    let cover = 0;
    for (const a of ahead) if (nearestDistFrom({ x: sx, y: sy, z: sz }, a) <= reachNow - 0.2) cover++;
    out.push({ x: sx, y: sy, z: sz, s: d * 0.4 + Math.hypot(sx - fx, sz - fz) * 0.35 + Math.abs(sy - fy) * 0.8 + (inside ? 2.5 : 0) - cover * 0.9 });
  }
  out.sort((a, b) => a.s - b.s);
  const good = [];                                          // only spots with a free line to the block (a few ray casts, once per block)
  for (let i = 0; i < out.length && i < 60 && good.length < 8; i++) if (post || losFrom(out[i].x + 0.5, out[i].y, out[i].z + 0.5, c)) good.push(out[i]);
  return good;
}

// ---------------------------------------------------------------- placement
// the block's dust: an effect event (js/fx.js) that js/entityview.js plays
function emitParticles(x, y, z, id) { BF.fx.emit({ kind: "dust", x, y, z, block: id }); }
function advance(e, by) { e.prog += by || 1; }
// Places the current cell. Returns "placed" | "skipped" | "wait" | "missing" (needs material) | "nowater" (needs a full bucket) | "paused".
function placeCell(m, bs, e) {
  const w = W(), c = cellOf(e, e.prog), T = TR().inv;
  if (!w.isLoaded(c.x, c.z)) return "paused";
  const cur = w.getBlock(c.x, c.y, c.z);
  if (cur === c.id) { advance(e); return "skipped"; }
  const dig = c.dig && BF.SOLID[cur] && !BF.REPLACEABLE[cur] && BF.blocks[cur] && GROUND_OK.test(BF.blocks[cur].name);   // a farm's ring, channel or soil goes in where the ground is
  if (BF.SOLID[cur] && !BF.REPLACEABLE[cur] && !dig) { e.skipped++; advance(e, c.pair ? 2 : 1); logEvent("blocked", m, { at: [c.x, c.y, c.z], by: BF.blocks[cur].name }); return "skipped"; }
  const isWater = c.id === BF.B.water && BF.I.water_bucket != null;
  if (isWater && T.count(m.inv, BF.I.water_bucket) < 1) {      // water only comes out of a full bucket
    if (T.count(m.inv, BF.I.bucket) > 0) return "nowater";
    e.skipped++; advance(e); logEvent("nobucket", m, { at: [c.x, c.y, c.z] });
    return "skipped";
  }
  const solidTarget = BF.SOLID[c.id] || (BF.blocks[c.id] && BF.blocks[c.id].door);
  if (solidTarget && (otherInside(m, c) || (c.pair && otherInside(m, { x: c.x, y: c.y + 1, z: c.z })))) {
    bs.occT += 0.1;
    if (bs.occT > 8) { bs.occT = 0; e.skipped++; advance(e, c.pair ? 2 : 1); return "skipped"; }
    return "wait";
  }
  bs.occT = 0;
  const use = c.id;
  if (c.cost) {
    if (have0(m.inv, c.item) < 1) {                         // only the exact item: no other wood stands in
      const a = analyze(m.inv, remainingReq(e, e.prog), bpOf(e).wood);
      if (a.crafts.length) applyCrafts(m, a.crafts);
      if (have0(m.inv, c.item) < 1 && c.item === PANE() && noPanes(m.village)) { e.gaps = e.gaps || []; if (!e.gaps.includes(e.prog)) e.gaps.push(e.prog); advance(e); logEvent("gap", m, { at: [c.x, c.y, c.z] }); return "skipped"; }   // a window left open
      if (have0(m.inv, c.item) < 1) return "missing";
    }
  }
  if (dig) {   // the ground block comes out first; the builder keeps its drops (grass gives dirt)
    const drops = BF.rollDrops ? BF.rollDrops(cur) : [];
    if (!w.setBlock(c.x, c.y, c.z, 0)) return "paused";
    for (const d of drops) T.add(m.inv, d.id, d.count);
  }
  if (!w.setBlock(c.x, c.y, c.z, use)) return "paused";
  if (c.cost) T.remove(m.inv, c.item, 1);                   // exactly one item per block
  if (isWater) { T.remove(m.inv, BF.I.water_bucket, 1); T.add(m.inv, BF.I.bucket, 1); }   // the bucket is empty after the one block
  let step = 1;
  if (BF.vlog && BF.blocks[use] && BF.blocks[use].bed && !BF.blocks[use].bed.head) BF.vlog.bed(m, c.x, c.y, c.z);
  if (BF.blocks[use] && BF.blocks[use].jobsite && BF.emit) BF.emit("blockPlaced", c.x, c.y, c.z, use);   // a jobsite (the stable's tack rack): js/jobs.js lists it for the jobless at once
  if (BF.blocks[use] && BF.blocks[use].bed && !BF.blocks[use].bed.head) firstDibs(m, e, c);
  if (c.pair) {                                             // door upper half / bed head go in with the lower half / foot
    const c2 = cellOf(e, e.prog + 1);
    w.setBlock(c2.x, c2.y, c2.z, c2.id);
    step = 2;
  }
  emitParticles(c.x, c.y, c.z, use);
  m.ai.swingT = 0.35;
  advance(e, step);
  e.placed = (e.placed || 0) + 1;
  bs.placed = (bs.placed || 0) + 1;
  return "placed";
}

// Glass panes for windows left open (entry.gaps): the finished structure with gaps nearest the builder is taken up again, from its first gap,
// once the builder holds panes or someone sells them. Returns true when it started.
function glaze(m, bs, built) {
  const P = PANE();
  if (P == null || !(have0(m.inv, P) > 0 || sellerStock(m.village)[P] > 0)) return false;
  const e = built.filter(x => x.state === "done" && x.gaps && x.gaps.length).sort((a, b) => Math.hypot(a.ox - m.position.x, a.oz - m.position.z) - Math.hypot(b.ox - m.position.x, b.oz - m.position.z))[0];
  if (!e) return false;
  const from = Math.min(...e.gaps), left = e.gaps.length;
  if (!beginBuild(m, left, e.ox + e.w / 2, e.oz + e.d / 2, what(e))) return true;
  e.state = "building"; e.glaze = true; e.prog = from; e.gaps = []; e.retry = []; e.retried = false; e.skipped = 0; e.owner = m.slot ? m.slot.idx : 0;
  logEvent("glaze", m, { type: e.type, at: [e.ox, e.oy, e.oz], windows: left });
  startBuild(m, bs, e, true);
  return true;
}
function finish(m, bs, e) {
  if (e.glaze) {   // windows filled in: the structure was already built
    e.glaze = false; e.state = "done";
    if (BF.villageSim) BF.villageSim.done(m);
    bs.mode = "idle"; bs.entry = null; bs.cool = rnd(RS(m), 10, 20); bs.t = 3; m.ai.route = null;
    logEvent("glazed", m, { type: e.type, at: [e.ox, e.oy, e.oz], left: (e.gaps || []).length });
    if (BF.vlog && m.village) BF.vlog.log(m.village, "build", BF.vlog.nameOf(m) + " (Builder) put glass panes in the windows of " + what(e, true) + " at " + e.ox + ", " + e.oy + ", " + e.oz, [e.ox, e.oy, e.oz]);
    return;
  }
  e.state = "done"; e.end = +dayNow().toFixed(3);
  if (BF.villageSim) BF.villageSim.done(m);
  bs.mode = "idle"; bs.entry = null; bs.cool = rnd(RS(m), 40, 80); bs.t = 3; m.ai.route = null;
  const bp = bpOf(e);
  if (bp.house && m.slot && e.claim === m.slot.idx && m.bed && homeFor(e).beds.some(b => sameBed(b, m.bed))) m.home = homeFor(e);   // it took a bed here as it placed it (firstDibs): this is its home now
  logEvent("done", m, { type: e.type, at: [e.ox, e.oy, e.oz], blocks: e.n, skipped: e.skipped || 0 });
  vlogBuild(m, e, "built");
  BF.emit && BF.emit("builderDone", m, e);
}
function homeFor(e) {
  const bp = bpOf(e), d = bp.door;
  return {
    x: e.ox, y: e.oy, z: e.oz, w: bp.w, d: bp.d, doorX: e.ox + d.x, doorZ: e.oz + d.z, outX: e.ox + d.outX, outZ: e.oz + d.outZ, type: e.type,
    beds: bp.beds.map(b => ({ x: e.ox + b.x, y: e.oy + b.y, z: e.oz + b.z, f: b.f })),
  };
}
const sameBed = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;
const heldByOther = (m, b) => (m.village ? m.village.members : []).some(o => o !== m && !o.dead && !o.removed && sameBed(o.bed, b));
// A builder keeps a bed it has of its own. One with none (or only a borrowed one, js/mobs.js claimBed) takes the first bed it places in a
// house, the moment it places it, so nobody has borrowed it yet. No villager ever takes a bed another villager holds (bug-027).
function firstDibs(m, e, c) {
  if (!bpOf(e).house || !m.slot || (m.bed && !m.bed.claimed)) return;
  const b = homeFor(e).beds.find(x => x.x === c.x && x.y === c.y && x.z === c.z);
  if (b) claimHome(m, e, b);
}
function claimHome(m, e, bed) {
  const H = homeFor(e), b = bed || H.beds[0];
  if (!b || heldByOther(m, b)) return false;
  m.bed = b; e.claim = m.slot.idx; e.claimBed = H.beds.indexOf(b);
  if (e.state === "done") m.home = H;
  logEvent("claim", m, { bed: [b.x, b.y, b.z] });
  return true;
}

// ---------------------------------------------------------------- fetching water for a well
// The builder walks to a water source within ~30 blocks of the village (a lake, a pond, the village well) and fills its empty bucket there.
function fillMode(m, bs, dt, out) {
  const F = bs.fill, VL = BF.villageLife, ai = m.ai, e = bs.entry;
  const back = skip => {
    if (skip && e) { e.skipped++; advance(e); logEvent("nowater", m, {}); }
    bs.mode = "build"; bs.fill = null; ai.route = null; bs.goal = null; bs.stallT = 0;
    return false;
  };
  if (!F || !VL || !e || e.state !== "building") return back(false);
  if ((F.t += dt) > 240 || F.bad >= 4) return back(true);        // no water to be had: build the rest, the well stays dry
  if (!F.src) {
    if ((F.cd -= dt) > 0) return false;
    F.cd = 2;
    F.src = VL.findWater(m, m.village);
    if (!F.src) return false;                                    // the water around the village is still being scanned
    F.act = 0;
  }
  const s = F.src;
  ai.mode = "idle"; ai.t = 2;
  const st = travel(m, bs, dt, out, { x: s.sx, y: s.sy, z: s.sz }, 1.2, m.def.speed * 1.35);
  if (st === "failed") { F.src = null; F.bad++; return true; }
  if (st !== "arrived") return true;
  out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5;
  m.lookAt = { position: { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5 }, height: 0 };
  if ((F.act += dt) < 0.9) { if (ai.swingT <= 0 && F.act < 0.2) ai.swingT = 0.35; return true; }
  if (VL.fillBucket(m, s.x, s.y, s.z)) return back(false);
  F.src = null; F.bad++; F.act = 0;
  return true;
}

// ---------------------------------------------------------------- build mode
function buildMode(m, bs, dt, out) {
  const e = bs.entry, ai = m.ai;
  if (!e || e.state !== "building" || e.owner !== (m.slot ? m.slot.idx : 0)) { bs.mode = "idle"; bs.entry = null; return false; }   // done, or another builder took it over
  bs.placeT -= dt;
  reachNow = e.retried ? REACH + 1.6 : REACH;     // second pass: stretch a little for the last awkward cells (gable tops)
  // watchdog: a cell that cannot be placed for 15 s (unreachable, stuck, no free line) is skipped so the structure still gets finished
  const cStall = e.prog < e.n ? cellOf(e, e.prog) : null;
  pace(m, bs, e, dt, !!cStall && Math.hypot(cStall.x + 0.5 - m.position.x, cStall.z + 0.5 - m.position.z) <= 16);
  if (bs.stallP !== e.prog || !cStall || Math.hypot(cStall.x + 0.5 - m.position.x, cStall.z + 0.5 - m.position.z) > 16) { bs.stallP = e.prog; bs.stallT = 0; }   // the clock runs only near the block: a long walk to a far site is not a stall
  else if ((bs.stallT += dt) > 15) {
    const c0 = cStall;
    bs.stallT = 0; e.skipped++; (e.retry = e.retry || []).push(e.prog); advance(e, c0.pair ? 2 : 1); logEvent("stall", m, { at: [c0.x, c0.y, c0.z] }); ai.route = null; bs.goal = null;
    return false;
  }
  // cells that already hold their block go by instantly (resume after a reload)
  for (let k = 0; k < 600 && e.prog < e.n; k++) {
    const c = cellOf(e, e.prog);
    if (!W().isLoaded(c.x, c.z) || W().getBlock(c.x, c.y, c.z) !== c.id) break;
    advance(e);
  }
  if (e.prog >= e.n && e.retry && e.retry.length && !e.retried) {   // second pass over cells that could not be reached the first time
    e.retried = true; e.prog = Math.min(...e.retry); e.retry = []; e.skipped = 0; bs.cands = null; bs.goal = null;
    return false;
  }
  if (e.prog >= e.n) { finish(m, bs, e); return false; }
  const c = cellOf(e, e.prog), post = isPost(e, c);
  if (!W().isLoaded(c.x, c.z)) return false;
  if (post) reachNow = POST_REACH;
  const near = nearestDist(m, c) <= reachNow && !overlapsBody(m, c) && !(c.pair && overlapsBody(m, { x: c.x, y: c.y + 1, z: c.z }));
  if (near && (bs.losFor !== e.prog || bs.losT <= 0)) { bs.losFor = e.prog; bs.los = post || losOK(m, c); bs.losT = 0.5; }
  bs.losT -= dt;
  if (near && bs.los) {
    ai.route = null; bs.goal = null;
    out.faceX = c.x + 0.5; out.faceZ = c.z + 0.5;
    m.lookAt = { position: { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }, height: 0 };
    ai.mode = "idle"; ai.t = 2;
    if (bs.placeT > 0) return true;
    const r = placeCell(m, bs, e);
    if (r === "placed") { bs.placeT = rnd(RS(m), BLOCK_T[0], BLOCK_T[1]); bs.cands = null; }
    else if (r === "missing") { toShop(m, bs, e); }
    else if (r === "nowater") { bs.mode = "fill"; bs.fill = { t: 0, cd: 0, src: null, act: 0, bad: 0 }; ai.route = null; bs.goal = null; }
    else if (r === "skipped") bs.placeT = 0.05;
    return true;
  }
  // walk to a spot that reaches the block
  if (!bs.goal || nearestDistFrom(bs.goal, c) > reachNow - 0.1 || !nav().walkCell(bs.goal.x, bs.goal.y, bs.goal.z) ||
    (e.type === "bridge" && bs.goal.x === c.x && bs.goal.z === c.z && (bs.goal.y === c.y || bs.goal.y + 1 === c.y))) {
    bs.goal = null;
    if (!bs.cands || bs.candFor !== e.prog) { bs.cands = spotsFor(m, bs, c, e); bs.ci = 0; bs.candFor = e.prog; }
    if (bs.ci >= bs.cands.length) {
      bs.noSpot++; bs.cands = null;
      if (bs.noSpot >= 3) { bs.noSpot = 0; e.skipped++; (e.retry = e.retry || []).push(e.prog); advance(e, c.pair ? 2 : 1); logEvent("unreachable", m, { at: [c.x, c.y, c.z] }); }
      return false;
    }
    bs.goal = bs.cands[bs.ci];
  }
  const st = travel(m, bs, dt, out, bs.goal, 0.28, m.def.speed * 1.35);
  ai.mode = "idle"; ai.t = 2;
  if (st === "failed") { bs.goal = null; bs.ci++; }
  else if (st === "arrived") {
    if (nearestDist(m, c) <= reachNow && (post || losOK(m, c))) steer(m, bs.goal.x + 0.5, bs.goal.z + 0.5, 0.7, out);   // settle on the spot (the body must clear the target cell)
    else { bs.goal = null; bs.ci++; }
  }
  return true;
}
function nearestDistFrom(g, c) {
  const ex = g.x + 0.5, ey = g.y + EYE, ez = g.z + 0.5;
  const nx = Math.min(Math.max(ex, c.x), c.x + 1), ny = Math.min(Math.max(ey, c.y), c.y + 1), nz = Math.min(Math.max(ez, c.z), c.z + 1);
  return Math.hypot(nx - ex, ny - ey, nz - ez);
}

// ---------------------------------------------------------------- material seeking
function toShop(m, bs, e) {
  const req = remainingReq(e, e.prog), a = analyze(m.inv, req, bpOf(e).wood);
  bs.mode = "shop"; bs.want = { entry: e, req, short: a.shortfall }; bs.stage = "think"; bs.t = 0; m.ai.route = null; bs.goal = null;
  if (BF.villageSim) BF.villageSim.done(m);   // the build stops here; shopping and then building again are tasks of their own
  logEvent("short", m, { for: e.type, missing: Object.keys(a.shortfall).map(k => BF.itemName(+k) + " x" + a.shortfall[k]) });
}
function canSell(v2) { return v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && v2.inv && v2.trades; }   // other builders too: their reserve keeps what they need (js/market.js)
// The nearest other villager that sells something on the shortfall list and could do the deal now.
function findSeller(m, bs, short) {
  const R = m.village, T = TR(), best = BF.ids.refs({ d: 1e9 });
  for (const v2 of R.members) {
    if (v2 === m || !canSell(v2)) continue;
    for (const o of offersOf(v2)) {
      const need = short[o.sell.id];
      if (!need || T.blockReason(v2, o)) continue;
      if (bs.avoid[v2.slot ? v2.slot.idx + ":" + o.sell.id : ""] > dayNow()) continue;
      let k = Math.min(Math.ceil(need / o.sell.n), Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n));
      for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
      while (k > 0 && !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n * k }], o.buy.map(b => ({ id: b.id, n: b.n * k })))) k--;
      if (k < 1) continue;
      const d = v2.position.distanceTo(m.position);
      if (d < best.d) { best.d = d; best.seller = v2; best.offer = o; best.times = k; best.item = o.sell.id; }
    }
  }
  return best.seller ? best : null;
}
function doDeal(m, bs, deal) {
  const T = TR(), v2 = deal.seller, o = deal.offer;
  const done = T.asked(m, v2, o) || canSell(v2) ? T.buy(m, v2, o, deal.times, { guard: () => (canSell(v2) ? null : "busy") }) : 0;   // one transaction (js/trading.js buy)
  if (done == null) return null;   // in flight: the answer comes next tick
  if (done) logEvent("buy", m, { from: v2.profession, got: done * o.sell.n + " " + BF.itemName(o.sell.id), paid: o.buy.map(b => b.n * done + " " + BF.itemName(b.id)).join(" + ") });
  else bs.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id] = dayNow() + 0.05;
  return done;
}
function shopMode(m, bs, dt, out) {
  const ai = m.ai, wnt = bs.want;
  if (!wnt) { bs.mode = "idle"; return false; }
  const e = wnt.entry;
  if (e && e.state !== "building") { bs.mode = "idle"; bs.want = null; return false; }
  bs.t -= dt;
  if (bs.stage === "think" || (bs.stage === "wait" && bs.t <= 0)) {
    const req = e ? remainingReq(e, e.prog) : wnt.req, a = analyze(m.inv, req, e ? bpOf(e).wood : wnt.wood);
    wnt.short = a.shortfall;
    if (a.ok || onlyPanes(m.village, a)) {
      if (e) { applyCrafts(m, a.crafts); startBuild(m, bs, e); return false; }
      const ne = beginPlan(m, bs, wnt.type, wnt.wood);
      bs.want = null;
      if (ne) startBuild(m, bs, ne); else bs.mode = "idle";
      return false;
    }
    const deal = findSeller(m, bs, a.shortfall);
    if (deal) {
      const VS = BF.villageSim;   // a shopping trip: walk at 1.3x speed + one trade pause
      if (VS && VS.begin && !VS.begin(m, VS.walkSecs(m, [deal.seller.position]) / 1.3 + TRADE_PAUSE, "Fetching: " + deal.times * deal.offer.sell.n + " " + BF.itemName(deal.item))) { bs.stage = "wait"; bs.t = 3; return false; }
      bs.deal = deal; bs.stage = "walk"; bs.walkT = 0; bs.navFail = 0;
    }
    else if (BF.I.dirt != null && a.shortfall[BF.I.dirt] && BF.villageLife && BF.villageLife.gatherFor && !(bs.noDirt > dayNow())) {   // nobody sells dirt: it digs its own (idea-044)
      bs.stage = "dig"; bs.dig = { t: 0, n: have0(m.inv, BF.I.dirt) + a.shortfall[BF.I.dirt], task: null, cd: 0, bad: 0 }; ai.route = null; bs.goal = null;
    }
    else {
      if (BF.econ) for (const id in a.shortfall) BF.econ.want(m, +id);   // nobody sells it now: the Economy view's dead ends (js/economy.js)
      bs.stage = "wait"; bs.t = rnd(RS(m), RECHECK[0], RECHECK[1]);
      if (!e && RS(m).next() < 0.5) { bs.mode = "idle"; bs.want = null; bs.cool = 0; bs.t = 1; }   // look at other plans too
    }
    return false;
  }
  if (bs.stage === "wait") return false;                       // wander the village (normal villager AI)
  if (bs.stage === "dig") return digDirt(m, bs, dt, out);
  const deal = bs.deal;
  if (!deal || !canSell(deal.seller)) { bs.stage = "think"; bs.deal = null; if (BF.villageSim) BF.villageSim.done(m); return false; }
  const v2 = deal.seller, d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (bs.stage === "walk") {
    bs.walkT += dt;
    if (bs.walkT > 60) { bs.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + deal.item] = dayNow() + 0.05; bs.stage = "think"; if (BF.villageSim) BF.villageSim.done(m); return false; }
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { bs.stage = "trade"; bs.tt = TRADE_PAUSE; ai.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (bs.goalSeller !== v2 || Math.hypot(bs.goalX - g.x, bs.goalZ - g.z) > 3) { ai.route = null; bs.goalSeller = v2; bs.goalX = g.x; bs.goalZ = g.z; }
    const st = travel(m, bs, dt, out, g, 1.8, m.def.speed * 1.3);
    ai.mode = "idle"; ai.t = 2;
    if (st === "failed") { bs.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + deal.item] = dayNow() + 0.05; bs.stage = "think"; ai.route = null; if (BF.villageSim) BF.villageSim.done(m); return false; }
    return true;
  }
  if (bs.stage === "trade") {
    bs.tt -= dt;
    if (d > 3.6) { bs.stage = "walk"; return true; }
    out.faceX = v2.position.x; out.faceZ = v2.position.z;
    m.lookAt = v2; ai.mode = "idle"; ai.t = 2;
    if (bs.tt > TRADE_PAUSE - 0.5 && Math.random() < dt * 4) ai.swingT = 0.2;   // visual
    if (bs.tt <= 0) {
      if (doDeal(m, bs, deal) == null) return true;   // the trade is in flight (js/trading.js buy)
      bs.deal = null; bs.stage = "think"; bs.t = 0;
      if (BF.villageSim) BF.villageSim.done(m);
      emitParticles(m.position.x - 0.5, m.position.y + 1.4, m.position.z - 0.5, BF.B.emerald_block != null ? BF.B.emerald_block : 0);
    }
    return true;
  }
  return false;
}

// Digging its own dirt (idea-044), by the farmers' rules (js/villagelife.js gatherFor): column by column until it holds bs.dig.n, for at most
// 4 minutes; then it thinks again (and buys what else it lacks).
function digDirt(m, bs, dt, out) {
  const G = bs.dig, VL = BF.villageLife, ai = m.ai;
  // nothing dug (none to dig near): for a while it waits for dirt like for any other material
  const back = () => { if (G && !G.got) bs.noDirt = dayNow() + 0.1; bs.stage = "think"; bs.dig = null; ai.route = null; bs.goal = null; if (BF.villageSim) BF.villageSim.done(m); return false; };
  if (!G || (G.t += dt) > 240 || G.bad >= 6 || have0(m.inv, BF.I.dirt) >= G.n) return back();
  if (!G.task) {
    if ((G.cd -= dt) > 0) return false;
    G.cd = 2;
    G.task = VL.gatherFor(m, m.village);
    if (!G.task) return false;
    G.act = 0;
    const VS = BF.villageSim;
    if (VS && VS.begin && !VS.begin(m, VS.walkSecs(m, [[G.task.x + 0.5, G.task.z + 0.5]]) + 1, "Gathering dirt")) { G.task = null; return back(); }
  }
  const t = G.task;
  ai.mode = "idle"; ai.t = 2;
  const st = travel(m, bs, dt, out, { x: t.x, y: t.ty, z: t.z }, 2.4, m.def.speed * 1.2);
  if (st === "failed") { G.task = null; G.bad++; if (BF.villageSim) BF.villageSim.done(m); return true; }
  if (st !== "arrived") return true;
  out.faceX = t.x + 0.5; out.faceZ = t.z + 0.5;
  m.lookAt = { position: { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 }, height: 0 };
  if ((G.act += dt) < 0.9) { if (ai.swingT <= 0) ai.swingT = 0.35; return true; }
  if (VL.gatherAt(m, m.village, t)) { G.got = (G.got || 0) + 1; logEvent("dig", m, { at: [t.x, t.y, t.z], dirt: have0(m.inv, BF.I.dirt) }); } else G.bad++;
  G.task = null;
  if (BF.villageSim) BF.villageSim.done(m);
  return true;
}

// ---------------------------------------------------------------- main entry (called from villagerAI after the sleep/morning logic)
function ai(m, dt, out) {
  const R = m.village;
  if (!R || !R.wg || !BF.blueprints || !m.inv) return false;
  const bs = m.bs || (m.bs = newState(m));
  if (BF.villageLife) BF.villageLife.ensureKit(m);
  if (!allowed()) {
    if (bs.mode !== "idle") { bs.mode = "idle"; bs.stage = null; bs.goal = null; bs.deal = null; m.ai.route = null; bs.want = null; bs.entry = null; if (BF.villageSim) BF.villageSim.done(m); }
    return false;
  }
  if (bs.cool > 0) bs.cool -= dt;
  switch (bs.mode) {
    case "idle":
      bs.t -= dt;
      if (bs.t <= 0) { bs.t = 2 + RS(m).next() * 2; think(m, bs); }
      return false;
    case "build": return buildMode(m, bs, dt, out);
    case "fill": return fillMode(m, bs, dt, out);
    case "shop": return shopMode(m, bs, dt, out);
  }
  bs.mode = "idle";
  return false;
}

function statusText(m) {
  if (!m || m.profession !== "builder") return "";
  const bs = m.bs;
  if (m.sleeping || !allowed()) return "Resting";
  if (!bs) return "Planning";
  if (bs.mode === "build" && bs.entry) return "Building: " + (bpOf(bs.entry).woody ? bpOf(bs.entry).wood.replace("_", " ") + " " : "") + bs.entry.label + " (" + Math.floor(100 * bs.entry.prog / Math.max(1, bs.entry.n)) + "%)";
  if (bs.mode === "fill") return "Fetching water";
  if (bs.mode === "shop" && bs.want) {
    const t = reqText(bs.want.short || {});
    if (bs.stage === "dig") return "Gathering dirt";
    if (bs.stage === "walk" || bs.stage === "trade") return "Fetching: " + (bs.deal ? bs.deal.times * bs.deal.offer.sell.n + " " + BF.itemName(bs.deal.item) : t);
    return "Looking for: " + t;
  }
  if (bs.cool > 0) return "Admiring the work";
  return "Planning";
}

function tick() {}   // nothing per step (its dust is an effect event since r15-12, played by js/entityview.js)

// ---------------------------------------------------------------- persistence (saved inside the villagers map of save.js: keys "built:<village key>")
const clean = list => JSON.parse(JSON.stringify(list, (k, v) => (k[0] === "_" ? undefined : v)));
function exportAll(out) {
  for (const [k, list] of pending) if (list.length) out["built:" + k] = clean(list);
  return out;
}
function importAll(o) {
  pending.clear();
  for (const k in o || {}) {
    if (k.slice(0, 6) !== "built:" || !Array.isArray(o[k])) continue;
    const list = [];
    for (const e of o[k]) {
      if (!e || !BP().SPECS[e.type] || !(e.n >= 0) || !Number.isFinite(e.ox) || !Number.isFinite(e.oy) || !Number.isFinite(e.oz)) continue;
      list.push(Object.assign({}, e, { prog: Math.max(0, Math.min(e.n, e.prog | 0)), fill: Array.isArray(e.fill) ? e.fill : [], state: e.state === "done" || e.state === "abandoned" ? e.state : "building" }));
    }
    pending.set(k.slice(6), list);
  }
}
// a builder (re)spawns: give it back the house it claimed
function onSpawn(m, rec, saved) {
  const built = builtOf(rec), idx = m.slot ? m.slot.idx : -1;
  // the kit was packed before the builder knew its village (mobs.js createMob): a new builder of a furniture-maker village hands back its beds
  if (!saved && BF.I.red_bed != null && Array.isArray(m.inv) && bedsFromFurniture(rec)) {
    const n = TR().inv.count(m.inv, BF.I.red_bed);
    if (n) TR().inv.remove(m.inv, BF.I.red_bed, n);
  }
  const e = built.find(x => x.state !== "abandoned" && x.claim === idx);
  if (e && bpOf(e).door) {
    const H = homeFor(e), b = H.beds[e.claimBed > 0 ? e.claimBed : 0];
    if (e.state === "done") m.home = H;
    if (b && !heldByOther(m, b)) m.bed = b;
  }
}

BF.builder = {
  BLOCK_T, REACH, BUILD_END, SITE_RANGE, log, pending,
  ai, tick, statusText, startStock, exportAll, importAll, onSpawn, builtOf, FOOD, FOOD_WEIGHT, STABLE_WEIGHT, ANIMAL_R, ANIMAL_MIN, chooseFood, foodCounts, wildCount, planReq,
  analyze, findSite, evalTerrain, beginPlan, startBuild, think, pickType, weighTypes, cellOf, bpOf, remainingReq, applyCrafts, findSeller, claimHome, reserve, shortfall, pickNext,
  reset() { pending.clear(); log.length = 0; },
};
})();
