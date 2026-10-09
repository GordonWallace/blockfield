// Builder villagers: choose a structure, find a site in open space around the village, and place it block by block out of the
// villager's own inventory (arm swing, particles, one item per block). Short of materials the builder buys from other villagers
// (real trade tables and inventories) or waits for the player to sell it some (builder trade table in trading.js).
// State: m.bs on the mob; the village record (rec.built) lists the structures and their progress and is saved with the villagers.
// See CONTRACT.md "Builder villagers". Loaded after mobs.js and blueprints.js; only calls other modules at runtime.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// ---- tunables ----
const BLOCK_T = [0.5, 0.8];       // seconds between two placed blocks (random per block)
let reachNow = 4.0;
const REACH = 4.0;                // blocks from the eye to the nearest point of the target cell
const EYE = 1.62;
const BUILD_END = 0.47;           // sky time after which builders stop and go home (bedtime at sunset 0.5)
const SITE_RANGE = 40;            // sites up to this far outside the village's bounding box
const SITE_TRIES = 150, SITE_EVALS = 40, MAX_FILL = 2, MAX_SLOPE = 2;
const MAX_BUILT = 14;             // structures per village
const RECHECK = [30, 60];         // seconds between material re-checks while waiting for the player
const TRADE_PAUSE = 2.0;          // seconds the builder stands with a seller before the goods change hands
const FILL_SPARE = 8;             // foundation blocks reserved on top of a blueprint's own requirement
const SITE_MARGIN = 3;            // blocks kept free around existing buildings and built structures
const STYLES = ["plains", "desert", "snowy", "savanna", "taiga"];

const BP = () => BF.blueprints;
const TR = () => BF.trades;
const W = () => BF.world;
const rnd = (a, b) => a + Math.random() * (b - a);
const pending = new Map();         // village key -> built list (same array as rec.built)
const log = [];
const pool = [];                   // placement particles
let partGeo = null;
const partMats = {};

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
// the planks from that wood's logs (analyze). Furnaces from cobblestone.
function craftTable(wood) {
  const I = BF.I, t = {}, P = BP().woodItem(wood, "planks"), F = BP().woodItem(wood, "fence");
  t[I.oak_door] = { n: 3, from: [[P, 6]] };
  if (F != null) t[F] = { n: 3, from: [[P, 5]] };
  t[I.crafting_table] = { n: 1, from: [[P, 4]] };
  t[I.chest] = { n: 1, from: [[P, 8]] };
  t[I.furnace] = { n: 1, from: [[I.cobblestone, 8]] };
  const G = BP().woodItem(wood, "fence_gate");
  if (G != null) t[G] = { n: 1, from: [[P, 4]] };                                        // 4 sticks (2 planks) + 2 planks: the stable's paddock gate
  if (I.merchant_counter != null) t[I.merchant_counter] = { n: 1, from: [[P, 12]] };   // the market stall's jobsite: 3 slabs, 2 planks and a chest (recipes-jobs.js)
  if (I.tack_rack != null) t[I.tack_rack] = { n: 1, from: [[P, 4], [I.leather, 1], [I.iron_ingot, 1]] };   // the stable's jobsite (recipes-jobs.js)
  if (I.nesting_box != null && I.hay_bale != null) t[I.nesting_box] = { n: 1, from: [[P, 4], [I.hay_bale, 1]] };   // the coop's jobsite (js/poultry.js)
  if (I.milk_churn != null) t[I.milk_churn] = { n: 1, from: [[P, 4], [I.iron_ingot, 1]] };   // the pasture's jobsite (js/cowherd.js)
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
  for (const k in T) {
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
  const T = TR().inv;
  for (const c of crafts) for (let k = 0; k < c.times; k++) {
    if (!c.from.every(([ing, q]) => have0(m.inv, ing) >= q)) break;
    const trial = T.clone(m.inv);
    for (const [ing, q] of c.from) removeItems(trial, ing, q);
    if (T.add(trial, c.id, c.n) > 0) break;                         // no room
    for (let i = 0; i < m.inv.length; i++) m.inv[i] = trial[i];
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
  T.add(a, BF.I.emerald, Math.floor(rnd(40, 81)));
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
    const f = e.fill[i], id = BF.worldgen.palette(e.style).found;
    return { x: f[0], y: f[1], z: f[2], id, item: id, cost: 1, pair: false, ph: 0 };
  }
  const c = bpOf(e).cells[i - nf];
  return { x: e.ox + c.x, y: e.oy + c.y, z: e.oz + c.z, id: c.id, item: c.item, cost: c.cost, pair: c.pair, ph: c.ph };
}
// material still needed for the cells from index `from`
function remainingReq(e, from) {
  const req = {};
  for (let i = from; i < e.n; i++) {
    const c = cellOf(e, i);
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
  for (const c of bp.cells) {
    const x = px + c.x, z = pz + c.z, y = oy + c.y, cur = w.getBlock(x, y, z);
    if (cur === c.id) continue;
    if (BF.RENDER[cur] === 3) return null;
    if (CSolid[cur] && !REPL[cur]) return null;
    if (c.y === 0) fillCols.add(c.x + "," + c.z);
  }
  const fill = [];
  for (const k of fillCols) {
    const [cx, cz] = k.split(",").map(Number), x = px + cx, z = pz + cz;
    const g = gs.has(x + "," + z) ? gs.get(x + "," + z) : w.heightAt(x, z);
    for (let y = g + 1; y < oy; y++) fill.push([x, y, z]);
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
  if (type === "pasture" && !(BF.cowherd && BF.cowherd.grassVillage(R))) return null;   // never off grass (js/cowherd.js)
  const style = styleIdx(R.style), found = BF.worldgen.palette(style).found;
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
    if (dist(px + bp.w / 2, pz + bp.d / 2) > SITE_RANGE) continue;
    if (type === "stable" && BF.horses && !BF.horses.isHorseBiome(px + bp.w / 2, pz + bp.d / 2)) continue;   // a stable stands on horse land itself
    if (type === "pasture" && BF.cowherd && !BF.cowherd.grassAt(px + bp.w / 2, pz + bp.d / 2)) continue;   // a pasture stands on grass itself
    evals++;
    if (occupiedBox(m, rect)) continue;
    const t = evalTerrain(bp, px, pz, found);
    if (!t) continue;
    if (t.fill.length > haveFound) continue;
    const score = Math.abs(dist(px + bp.w / 2, pz + bp.d / 2) - 5) + rng() * 6 + t.fill.length * 0.5 + t.slope * 1.5;
    if (!best || score < best.score) best = { score, bp, rot, h, ox: px, oz: pz, oy: t.oy, fill: t.fill, opts };
  }
  return best;
}

// ---------------------------------------------------------------- plans
const lamps = inv => (TR().inv.count(inv, BF.I.lantern) >= 3 ? { lantern: true } : null);
function optsFor(type, inv) {
  if (type === "lamp_posts") return lamps(inv);
  if ((type === "garden" || type === "stable" || type === "pasture") && TR().inv.count(inv, BF.I.hay_bale) >= 2) return { hay: true };
  return null;
}
// What a villager sells: its offers, job and spare goods (js/market.js). Leather for a stable's tack rack comes from a leatherworker's spare goods.
const offersOf = v2 => v2.trades;
// Stables: only in villages on horse land, wanted most by a village of 10 or more without one (js/stables.js decides what horse land is).
function stableWeight(R, has) {
  if (!BF.stables || !BF.stables.villageOK(R)) return 0;
  const pop = R.members.filter(x => x.type === "villager" && !x.dead && !x.removed).length;
  return has ? 0.02 : pop >= 10 ? 2.5 : 0.15;
}
function soldItems(R) {
  const s = new Set();
  for (const o of R.members) if (o.type === "villager" && !o.dead && !o.removed && o.profession !== "builder" && o.trades && o.inv) for (const t of offersOf(o)) s.add(t.sell.id);
  return s;
}
function pickType(m, bs) {
  const R = m.village, built = builtOf(R), BPr = BP(), style = styleIdx(R.style);
  const cnt = t => built.filter(e => e.type === t && e.state !== "abandoned").length;
  const homeless = R.members.filter(x => x.type === "villager" && !x.dead && !x.removed && !(x.bed && !x.bed.tent ? x.bed : x.homeBed)).length;   // a camping explorer with no bed at home is homeless too
  const found = BF.worldgen.palette(style).found;
  if (built.length === 0 && !(bs.fail && bs.fail.small_house > dayNow())) return "small_house";
  const wt = {
    small_house: cnt("small_house") + cnt("medium_house") + cnt("cottage") >= 8 ? 0.3 : 1 + 1.6 * Math.min(homeless, 3),
    medium_house: 0.4 + (homeless >= 2 ? 1.2 : 0),
    cottage: 0.3 + (homeless >= 1 ? 0.6 : 0),
    well: cnt("well") === 0 ? 1.2 : 0.15,
    lamp_posts: cnt("lamp_posts") < 2 ? 1.0 : 0.2,
    garden: cnt("garden") < 2 ? 0.8 : 0.2,
    market_stall: cnt("market_stall") < 2 ? 0.7 : 0.15,
    workshop: cnt("workshop") < 1 ? 0.5 : 0.1,
    stable: stableWeight(R, cnt("stable") > 0),
    // a coop (js/poultry.js): wanted when the village has none (generated or built) and 8 or more villagers, hardly ever after that
    coop: (R.wg && (R.wg.buildings || []).some(b => b.type === "coop")) || cnt("coop") > 0 ? 0.02
      : R.members.filter(x => x.type === "villager" && !x.dead && !x.removed).length >= 8 ? 2.4 : 0.05,
    // a pasture (js/cowherd.js): only in a village on grass; wanted when it has none and 10 or more villagers, hardly ever after that
    pasture: !(BF.cowherd && BF.cowherd.grassVillage(R)) ? 0 : (R.wg && (R.wg.buildings || []).some(b => b.type === "pasture")) || cnt("pasture") > 0 ? 0.02
      : R.members.filter(x => x.type === "villager" && !x.dead && !x.removed).length >= 10 ? 2 : 0.05,
  };
  const sold = soldItems(R), stock = sellerStock(R);
  let sum = 0;
  const ws = [];
  for (const t of BPr.TYPES) {
    if (bs.fail && bs.fail[t] > dayNow()) continue;
    if (t === "stable" && !wt.stable) continue;                  // never outside horse land
    if (t === "pasture" && !wt.pasture) continue;                // never off grass
    const opts = optsFor(t, m.inv), wood = chooseWood(m, t, style, opts, stock);
    const bp = BPr.get(t, 0, style, 0.5, opts, wood);
    const req = Object.assign({}, bp.req); req[found] = (req[found] || 0) + FILL_SPARE;
    const a = analyze(m.inv, req, wood);
    const buyable = Object.keys(a.shortfall).every(k => sold.has(+k));
    const mult = a.ok ? 3 : buyable ? 1.2 : 0.25;
    const x = (wt[t] || 0.3) * mult;
    ws.push([t, x]); sum += x;
  }
  if (!ws.length) return null;
  let r = Math.random() * sum;
  for (const [t, x] of ws) if ((r -= x) <= 0) return t;
  return ws[ws.length - 1][0];
}

function newState() { return { mode: "idle", t: rnd(1, 3), cool: 0, stage: null, fail: {}, avoid: {}, placeT: 0.6, entry: null, want: null, losT: 0, losFor: -1 }; }
const nextId = built => built.reduce((a, e) => Math.max(a, e.id || 0), 0) + 1;
function logEvent(kind, m, data) {
  const e = Object.assign({ kind, day: +dayNow().toFixed(3), builder: m && m.slot ? m.slot.idx : null }, data);
  log.push(e); if (log.length > 200) log.shift();
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
  BF.vlog.log(m.village, "build", who + " " + verb + " " + what(e, verb === "took over building") + " at " + e.ox + ", " + e.oy + ", " + e.oz +
    (verb === "built" ? " (" + e.n + " blocks)" : ""), [e.ox, e.oy, e.oz]);
}

// Try to start the structure `type`: site, crafts, entry. Returns the entry or null (and remembers the failure).
// `wood`: the species chosen for it (chooseWood when omitted); the whole structure is built from it.
function beginPlan(m, bs, type, wood) {
  const R = m.village, built = builtOf(R), style = styleIdx(R.style);
  const found = BF.worldgen.palette(style).found;
  const opts = optsFor(type, m.inv);
  wood = wood || chooseWood(m, type, style, opts);
  const bp0 = BP().get(type, 0, style, 0.5, opts, wood);
  const req = Object.assign({}, bp0.req);
  const a = analyze(m.inv, req, wood);
  if (!a.ok) return null;
  const spare = Math.max(0, have0(m.inv, found) - (req[found] || 0));
  const site = findSite(m, type, opts, spare, wood);
  if (!site) { bs.fail[type] = dayNow() + 0.12; logEvent("nosite", m, { type }); return null; }
  applyCrafts(m, a.crafts);
  const e = { id: nextId(built), type, label: site.bp.label, rot: site.rot, style, wood, h: site.h, opts: opts || undefined, ox: site.ox, oy: site.oy, oz: site.oz,
    w: site.bp.w, d: site.bp.d, prog: 0, skipped: 0, state: "building", owner: m.slot ? m.slot.idx : 0, fill: site.fill, start: +dayNow().toFixed(3) };
  e.n = nfill(e) + site.bp.n;
  built.push(e);
  logEvent("plan", m, { type, wood, at: [e.ox, e.oy, e.oz], rot: e.rot, blocks: e.n, fill: nfill(e) });
  vlogBuild(m, e, "started building");
  return e;
}

function startBuild(m, bs, e) {
  bs.mode = "build"; bs.entry = e; bs.goal = null; bs.cands = null; bs.ci = 0; bs.noSpot = 0; bs.occT = 0; bs.want = null; bs.stage = null;
  bs.placeT = Math.max(bs.placeT, 0.4); bs.losT = 0; bs.losFor = -1;
  m.ai.route = null;
  if (!bs.next) bs.next = pickNext(m, bs);   // it knows what comes next, so it keeps those materials too (js/market.js)
}
// The structure it will build after this one: {type, wood, req} with the requirement as think() counts it.
function pickNext(m, bs) {
  const R = m.village;
  if (!R || !R.wg || builtOf(R).filter(e => e.state !== "abandoned").length + 1 >= MAX_BUILT) return null;
  const type = pickType(m, bs);
  if (!type) return null;
  const style = styleIdx(R.style), found = BF.worldgen.palette(style).found;
  const opts = optsFor(type, m.inv), wood = chooseWood(m, type, style, opts);
  const req = Object.assign({}, BP().get(type, 0, style, 0.5, opts, wood).req); req[found] = (req[found] || 0) + FILL_SPARE;
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
      if (!mine) vlogBuild(m, active, "took over building");
      active.owner = m.slot ? m.slot.idx : 0; startBuild(m, bs, active);
    }
    return;
  }
  if (bs.cool > 0 || built.filter(e => e.state !== "abandoned").length >= MAX_BUILT) return;
  if (!R.wg) return;
  const nx = bs.next; bs.next = null;   // chosen when it started the last one
  const type = nx && !(bs.fail[nx.type] > dayNow()) ? nx.type : pickType(m, bs);
  if (!type) return;
  const style = styleIdx(R.style), found = BF.worldgen.palette(style).found;
  const opts = optsFor(type, m.inv), wood = nx && nx.type === type ? nx.wood : chooseWood(m, type, style, opts);
  const bp = BP().get(type, 0, style, 0.5, opts, wood);
  const req = Object.assign({}, bp.req); req[found] = (req[found] || 0) + FILL_SPARE;
  const a = analyze(m.inv, req, wood);
  if (a.ok) {
    const e = beginPlan(m, bs, type, wood);
    if (e) startBuild(m, bs, e);
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
  for (let dy = -4; dy <= 1; dy++) for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
    const sx = c.x + dx, sy = c.y + dy, sz = c.z + dz;
    if (sx === c.x && sz === c.z && (sy === c.y || sy + 1 === c.y)) continue;
    const ex = sx + 0.5, ey = sy + EYE, ez = sz + 0.5;
    const nx = Math.min(Math.max(ex, c.x), c.x + 1), ny = Math.min(Math.max(ey, c.y), c.y + 1), nz = Math.min(Math.max(ez, c.z), c.z + 1);
    const d = Math.hypot(nx - ex, ny - ey, nz - ez);
    if (d > reachNow - 0.2) continue;
    if (!N.walkCell(sx, sy, sz)) continue;
    const inside = sx >= e.ox && sx < e.ox + bp.w && sz >= e.oz && sz < e.oz + bp.d && sy > e.oy;
    let cover = 0;
    for (const a of ahead) if (nearestDistFrom({ x: sx, y: sy, z: sz }, a) <= reachNow - 0.2) cover++;
    out.push({ x: sx, y: sy, z: sz, s: d * 0.4 + Math.hypot(sx - fx, sz - fz) * 0.35 + Math.abs(sy - fy) * 0.8 + (inside ? 2.5 : 0) - cover * 0.9 });
  }
  out.sort((a, b) => a.s - b.s);
  const good = [];                                          // only spots with a free line to the block (a few ray casts, once per block)
  for (let i = 0; i < out.length && i < 60 && good.length < 8; i++) if (losFrom(out[i].x + 0.5, out[i].y, out[i].z + 0.5, c)) good.push(out[i]);
  return good;
}

// ---------------------------------------------------------------- placement
function emitParticles(x, y, z, id) {
  if (!BF.scene || typeof THREE === "undefined") return;
  if (!partGeo) partGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);
  const b = BF.blocks[id], key = (b && b.color) || "#999999";
  const mat = partMats[key] || (partMats[key] = new THREE.MeshBasicMaterial({ color: new THREE.Color(key) }));
  for (let i = 0; i < 5; i++) {
    if (pool.length > 90) { const o = pool.shift(); BF.scene.remove(o.mesh); }
    const mesh = new THREE.Mesh(partGeo, mat);
    mesh.position.set(x + 0.2 + Math.random() * 0.6, y + 0.3 + Math.random() * 0.5, z + 0.2 + Math.random() * 0.6);
    BF.scene.add(mesh);
    pool.push({ mesh, vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 2, vz: (Math.random() - 0.5) * 2, life: 0.45 + Math.random() * 0.3 });
  }
}
function advance(e, by) { e.prog += by || 1; }
// Places the current cell. Returns "placed" | "skipped" | "wait" | "missing" (needs material) | "nowater" (needs a full bucket) | "paused".
function placeCell(m, bs, e) {
  const w = W(), c = cellOf(e, e.prog), T = TR().inv;
  if (!w.isLoaded(c.x, c.z)) return "paused";
  const cur = w.getBlock(c.x, c.y, c.z);
  if (cur === c.id) { advance(e); return "skipped"; }
  if (BF.SOLID[cur] && !BF.REPLACEABLE[cur]) { e.skipped++; advance(e, c.pair ? 2 : 1); logEvent("blocked", m, { at: [c.x, c.y, c.z], by: BF.blocks[cur].name }); return "skipped"; }
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
      if (have0(m.inv, c.item) < 1) return "missing";
    }
  }
  if (!w.setBlock(c.x, c.y, c.z, use)) return "paused";
  if (c.cost) T.remove(m.inv, c.item, 1);                   // exactly one item per block
  if (isWater) { T.remove(m.inv, BF.I.water_bucket, 1); T.add(m.inv, BF.I.bucket, 1); }   // the bucket is empty after the one block
  let step = 1;
  if (BF.vlog && BF.blocks[use] && BF.blocks[use].bed && !BF.blocks[use].bed.head) BF.vlog.bed(m, c.x, c.y, c.z);
  if (BF.blocks[use] && BF.blocks[use].jobsite && BF.emit) BF.emit("blockPlaced", c.x, c.y, c.z, use);   // a jobsite (the stable's tack rack): js/jobs.js lists it for the jobless at once
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

function finish(m, bs, e) {
  e.state = "done"; e.end = +dayNow().toFixed(3);
  bs.mode = "idle"; bs.entry = null; bs.cool = rnd(40, 80); bs.t = 3; m.ai.route = null;
  const bp = bpOf(e);
  if (bp.house && bp.beds.length && m.slot && (!m.bed || m.bed.claimed)) claimHome(m, e);   // moves out of a bed it borrowed (js/mobs.js claimBed) into its own house
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
function claimHome(m, e) {
  const H = homeFor(e);
  m.home = H; m.bed = H.beds[0]; e.claim = m.slot.idx;
  const same = b => b && b.x === m.bed.x && b.y === m.bed.y && b.z === m.bed.z;
  for (const o of m.village ? m.village.members : []) if (o !== m && o.bed && o.bed.claimed && same(o.bed)) o.bed = null;   // a villager who borrowed the bed finds another (js/mobs.js claimBed)
  logEvent("claim", m, { bed: [m.bed.x, m.bed.y, m.bed.z] });
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
  if (bs.stallP !== e.prog) { bs.stallP = e.prog; bs.stallT = 0; } else if ((bs.stallT += dt) > 15) {
    const c0 = cellOf(e, e.prog);
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
  const c = cellOf(e, e.prog);
  if (!W().isLoaded(c.x, c.z)) return false;
  const near = nearestDist(m, c) <= reachNow && !overlapsBody(m, c) && !(c.pair && overlapsBody(m, { x: c.x, y: c.y + 1, z: c.z }));
  if (near && (bs.losFor !== e.prog || bs.losT <= 0)) { bs.losFor = e.prog; bs.los = losOK(m, c); bs.losT = 0.5; }
  bs.losT -= dt;
  if (near && bs.los) {
    ai.route = null; bs.goal = null;
    out.faceX = c.x + 0.5; out.faceZ = c.z + 0.5;
    m.lookAt = { position: { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }, height: 0 };
    ai.mode = "idle"; ai.t = 2;
    if (bs.placeT > 0) return true;
    const r = placeCell(m, bs, e);
    if (r === "placed") { bs.placeT = rnd(BLOCK_T[0], BLOCK_T[1]); bs.cands = null; }
    else if (r === "missing") { toShop(m, bs, e); }
    else if (r === "nowater") { bs.mode = "fill"; bs.fill = { t: 0, cd: 0, src: null, act: 0, bad: 0 }; ai.route = null; bs.goal = null; }
    else if (r === "skipped") bs.placeT = 0.05;
    return true;
  }
  // walk to a spot that reaches the block
  if (!bs.goal || nearestDistFrom(bs.goal, c) > reachNow - 0.1 || !nav().walkCell(bs.goal.x, bs.goal.y, bs.goal.z)) {
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
    if (nearestDist(m, c) <= reachNow && losOK(m, c)) steer(m, bs.goal.x + 0.5, bs.goal.z + 0.5, 0.7, out);   // settle on the spot (the body must clear the target cell)
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
  logEvent("short", m, { for: e.type, missing: Object.keys(a.shortfall).map(k => BF.itemName(+k) + " x" + a.shortfall[k]) });
}
function canSell(v2) { return v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && v2.inv && v2.trades; }   // other builders too: their reserve keeps what they need (js/market.js)
// The nearest other villager that sells something on the shortfall list and could do the deal now.
function findSeller(m, bs, short) {
  const R = m.village, T = TR(), best = { d: 1e9 };
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
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(v2) || T.blockReason(v2, o)) break;
    if (!o.buy.every(b => T.inv.count(m.inv, b.id) >= b.n)) break;
    if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
    const sold = T.exchange(v2, o);
    if (!sold) break;                       // same rules as a player trade: the villager's stock and room
    for (const b of o.buy) T.inv.remove(m.inv, b.id, b.n);
    T.inv.addStacks(m.inv, sold);
    T.addXp(v2, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(m, v2, o, done);
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
    if (a.ok) {
      if (e) { applyCrafts(m, a.crafts); startBuild(m, bs, e); return false; }
      const ne = beginPlan(m, bs, wnt.type, wnt.wood);
      bs.want = null;
      if (ne) startBuild(m, bs, ne); else bs.mode = "idle";
      return false;
    }
    const deal = findSeller(m, bs, a.shortfall);
    if (deal) { bs.deal = deal; bs.stage = "walk"; bs.walkT = 0; bs.navFail = 0; }
    else {
      if (BF.econ) for (const id in a.shortfall) BF.econ.want(m, +id);   // nobody sells it now: the Economy view's dead ends (js/economy.js)
      bs.stage = "wait"; bs.t = rnd(RECHECK[0], RECHECK[1]);
      if (!e && Math.random() < 0.5) { bs.mode = "idle"; bs.want = null; bs.cool = 0; bs.t = 1; }   // look at other plans too
    }
    return false;
  }
  if (bs.stage === "wait") return false;                       // wander the village (normal villager AI)
  const deal = bs.deal;
  if (!deal || !canSell(deal.seller)) { bs.stage = "think"; bs.deal = null; return false; }
  const v2 = deal.seller, d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (bs.stage === "walk") {
    bs.walkT += dt;
    if (bs.walkT > 60) { bs.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + deal.item] = dayNow() + 0.05; bs.stage = "think"; return false; }
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { bs.stage = "trade"; bs.tt = TRADE_PAUSE; ai.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (bs.goalSeller !== v2 || Math.hypot(bs.goalX - g.x, bs.goalZ - g.z) > 3) { ai.route = null; bs.goalSeller = v2; bs.goalX = g.x; bs.goalZ = g.z; }
    const st = travel(m, bs, dt, out, g, 1.8, m.def.speed * 1.3);
    ai.mode = "idle"; ai.t = 2;
    if (st === "failed") { bs.avoid[(v2.slot ? v2.slot.idx : 0) + ":" + deal.item] = dayNow() + 0.05; bs.stage = "think"; ai.route = null; return false; }
    return true;
  }
  if (bs.stage === "trade") {
    bs.tt -= dt;
    if (d > 3.6) { bs.stage = "walk"; return true; }
    out.faceX = v2.position.x; out.faceZ = v2.position.z;
    m.lookAt = v2; ai.mode = "idle"; ai.t = 2;
    if (bs.tt > TRADE_PAUSE - 0.5 && Math.random() < dt * 4) ai.swingT = 0.2;
    if (bs.tt <= 0) {
      doDeal(m, bs, deal);
      bs.deal = null; bs.stage = "think"; bs.t = 0;
      emitParticles(m.position.x - 0.5, m.position.y + 1.4, m.position.z - 0.5, BF.B.emerald_block != null ? BF.B.emerald_block : 0);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- main entry (called from villagerAI after the sleep/morning logic)
function ai(m, dt, out) {
  const R = m.village;
  if (!R || !R.wg || !BF.blueprints || !m.inv) return false;
  const bs = m.bs || (m.bs = newState());
  if (BF.villageLife) BF.villageLife.ensureKit(m);
  if (!allowed()) {
    if (bs.mode !== "idle") { bs.mode = "idle"; bs.stage = null; bs.goal = null; bs.deal = null; m.ai.route = null; bs.want = null; bs.entry = null; }
    return false;
  }
  if (bs.cool > 0) bs.cool -= dt;
  switch (bs.mode) {
    case "idle":
      bs.t -= dt;
      if (bs.t <= 0) { bs.t = 2 + Math.random() * 2; think(m, bs); }
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
    if (bs.stage === "walk" || bs.stage === "trade") return "Fetching: " + (bs.deal ? bs.deal.times * bs.deal.offer.sell.n + " " + BF.itemName(bs.deal.item) : t);
    return "Looking for: " + t;
  }
  if (bs.cool > 0) return "Admiring the work";
  return "Planning";
}

function tick(dt) {
  for (let i = pool.length - 1; i >= 0; i--) {
    const p = pool[i];
    p.life -= dt; p.vy -= 14 * dt;
    p.mesh.position.x += p.vx * dt; p.mesh.position.y += p.vy * dt; p.mesh.position.z += p.vz * dt;
    if (p.life <= 0) { BF.scene.remove(p.mesh); pool.splice(i, 1); }
  }
}

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
  const e = built.find(x => x.state === "done" && x.claim === idx);
  if (e && bpOf(e).door) { const H = homeFor(e); m.home = H; m.bed = H.beds[0]; }
}

BF.builder = {
  BLOCK_T, REACH, BUILD_END, SITE_RANGE, MAX_BUILT, log, pending,
  ai, tick, statusText, startStock, exportAll, importAll, onSpawn, builtOf,
  analyze, findSite, evalTerrain, beginPlan, startBuild, think, pickType, cellOf, bpOf, remainingReq, applyCrafts, findSeller, claimHome, reserve, shortfall, pickNext,
  reset() { pending.clear(); log.length = 0; for (const p of pool) BF.scene.remove(p.mesh); pool.length = 0; },
};
})();
