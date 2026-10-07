// Miners (BF.miner): a villager profession (not vanilla) that digs cobblestone out of the ground for the village and sells it to builders.
// - Roster: ~95% of newly generated villages get one (every one with village generator 3) (mobs.js villageRoster, own seeded stream and key <village key>#1400). Jobsite: the mining
//   bench (jobs.js), placed in or beside a house like the forester's band saw.
// - Tools: a founding miner starts with a wooden pickaxe and 30-40 torches (one hired later: torches and emeralds only, trading.js hireKit). The pickaxe wears out like the player's (BF.wearStack: 1 use per block, 250 uses for iron). Digging speed
//   follows the pickaxe's material (blocks.js tool.speed, the player's formula times VILLAGER_SLOW). When the pickaxe breaks it buys a new one
//   from a toolsmith of its village (emeralds permitting), else crafts a stone pickaxe from 3 cobblestone + 2 sticks (sticks bought from the forester, or made from planks).
// - Surface stone first: it looks for above-ground stone within SEARCH (40) blocks of the village's box: the top block of a column that is
//   stone (or coal / iron ore) and stands 1 or 2 blocks above one of its four neighbours, so the quarry levels outcrops and hillsides into
//   walkable steps and never sinks a pit or trench. Never within BUILD_AVOID blocks of anything built, never more than FLOOR_BELOW under the plaza. It walks there and digs one block at a time.
// - Mineshaft: while there is no surface stone in range (checked each time it is above ground), or once it may dig deeper than a novice (see
//   below), it digs a mineshaft just outside the village's box: a staircase (1 wide, 3 high) going down DIG_DEPTH[level] blocks below the
//   entrance, then a 2-high corridor straight on with side branches every
//   4 blocks (branch mining, 8 long each side), torches every 6 cells while it has them. Ore it can harvest in the walls and ceiling of a cell it
//   opens is dug too (never ore next to water, never the floor it walks on).
// - Depth by level: ores generate by depth below the surface (js/worldgen.js ORE3): coal, iron and copper from 6 down, lapis from 24, gold from
//   32, diamonds and redstone from 48. A novice's staircase goes 20 down (coal, iron, copper), an apprentice's 40 (gold), a journeyman's and
//   above 60 (diamonds, redstone). Below novice depth it only goes with an iron or better pickaxe (gold, diamonds and redstone need one), and
//   a shaft dug for a lower level is abandoned for a deeper one when it levels up. It walks the shaft along its own cells, so nothing
//   needs ladders. A cell that would open into water, something built or a void is skipped (a branch) or ends the shaft (the corridor); a
//   finished shaft is followed by a new one in another direction. It leaves the shaft before the end of the working day.
// - What it keeps: cobblestone (stone drops it), coal, raw iron, raw gold, raw copper, diamonds, redstone, lapis and emeralds; dirt, gravel and the rest it digs through are left behind.
// - Selling: holding SELL_MIN cobblestone, it walks to a builder of its village that needs some (its current structure's shortfall, or a reserve
//   of BUILDER_RESERVE for the next foundation in cobblestone villages) and sells at its own offer "1 emerald > 32 cobblestone". Builders short
//   of cobblestone also come to it (builder.js findSeller), and the player can buy at its trade table. A novice stops digging at KEEP_COBBLE; a
//   deeper digger keeps going for ore and leaves further cobblestone behind.
// - Persistence: the current mineshaft (m.mi.shaft) is saved with the villager (trading.js pack, `mi`). See CONTRACT.md "Miners".
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const TR = () => BF.trades;
const W = () => BF.world;
const get = (x, y, z) => W().getBlock(x, y, z);
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const nowS = () => BF.simNow();

const WORK_START = 0.04, WORK_END = 0.45;   // sky.time window (same as js/jobs.js)
const DAY_S = 1200;                         // seconds in a game day (sky.js)
const SEARCH = 40;                          // surface stone within this many blocks of the village box
const BUILD_AVOID = 4;                      // never digs within this many blocks of something built
const FLOOR_BELOW = 12;                     // the surface quarry never goes deeper than this below the plaza
const REACH = 4.2;                          // eye to block centre
const VILLAGER_SLOW = 2.5;                  // a villager digs this many times slower than the player's breakTime formula
const KEEP_COBBLE = 256, SELL_MIN = 32, BUILDER_RESERVE = 32;
const DIG_DEPTH = [20, 40, 60, 60, 60];     // staircase depth below the entrance, by villager level 1..5
const DEEP_TIER = 3;                        // pickaxe tier (iron) needed to dig below DIG_DEPTH[0]: gold, diamonds and redstone need it
const MAX_STAIRS = 64, CORRIDOR = 64, BRANCH_EVERY = 4, BRANCH_LEN = 8, TORCH_EVERY = 6;
const PERIOD = BRANCH_EVERY + 2 * BRANCH_LEN;   // tunnel cells per corridor stretch: 4 corridor cells, then a branch left and one right
const TRADE_PAUSE = 1.6;
const STYLES = ["plains", "desert", "snowy", "savanna", "taiga"];
const LOG = [];
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: "miner" + (m && m.slot ? "#" + m.slot.idx : ""), village: m && m.village ? m.village.key : null }, data)); if (LOG.length > 300) LOG.shift(); };

// ---------------------------------------------------------------- items
const I = n => BF.I[n];
const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const KEEP = new Set(["cobblestone", "coal", "raw_iron", "raw_gold", "raw_copper", "diamond", "cobbled_deepslate", "emerald", "lapis_lazuli", "redstone"]);
const keeps = id => KEEP.has(nameOf(id));
const isPick = id => { const it = BF.items[id]; return !!(it && it.tool && it.tool.type === "pickaxe"); };
const count = (m, id) => (id == null ? 0 : TR().inv.count(m.inv, id));
const freeSlots = m => m.inv.reduce((n, s) => n + (s ? 0 : 1), 0);
// The pickaxe it digs with: the best material, then the most worn (used up first). The slot object itself (its wear lives on it).
function pickOf(m) {
  let best = null;
  for (const s of m.inv) if (s && isPick(s.id)) {
    const t = BF.items[s.id].tool.tier;
    if (!best || t > BF.items[best.id].tool.tier || (t === BF.items[best.id].tool.tier && (s.wear || 0) > (best.wear || 0))) best = s;
  }
  return best;
}
// How deep (blocks below the entrance) a new staircase goes: by the miner's level, but only novice depth without an iron or better pickaxe.
function digDepth(m) {
  const lv = Math.max(1, Math.min(5, m.level || 1)), p = pickOf(m), tier = p ? BF.items[p.id].tool.tier || 0 : 0;
  return tier >= DEEP_TIER ? DIG_DEPTH[lv - 1] : DIG_DEPTH[0];
}
// Seconds to dig block `id` with pickaxe stack `p` (null = bare hands), or Infinity when it cannot be dug.
function digTime(id, p) {
  const b = BF.blocks[id];
  if (!b || !isFinite(b.hardness)) return Infinity;
  const tool = p && BF.items[p.id].tool;
  let t = b.hardness;
  if (tool && b.tool === "pickaxe" && (tool.tier || 0) >= (b.minTier || 0)) t /= tool.speed || 1;
  else if (b.needsTool) t *= 5;
  return Math.max(0.15, t * VILLAGER_SLOW);
}
const canHarvest = (id, p) => { const b = BF.blocks[id]; if (!b || !b.needsTool) return true; const tool = p && BF.items[p.id].tool; return !!(tool && tool.type === b.tool && (tool.tier || 0) >= (b.minTier || 0)); };

// Starting pack (trading.js stockFor, which adds the wooden pickaxe): 30-40 torches for the shaft.
function seed(a) {
  if (I("torch") != null) TR().inv.add(a, I("torch"), 30 + Math.floor(Math.random() * 11));
}

// ---------------------------------------------------------------- block classes
let NATF = null, STONEF = null, ROCKF = null;
function flags() {
  if (NATF) return;
  const n = BF.MAX_BLOCK + 1;
  NATF = new Uint8Array(n); STONEF = new Uint8Array(n); ROCKF = new Uint8Array(n);
  const RAW = /^(stone|deepslate|tuff|andesite|diorite|granite|calcite|sand|red_sand|gravel|dirt|grass|snow_grass|clay|snow|snow_block|ice|packed_ice|blue_ice|bedrock|obsidian|moss_block|moss_carpet|vine|dripstone_block|pointed_dripstone|cactus|dead_bush|cobweb|mangrove_roots|muddy_mangrove_roots|rooted_dirt|podzol|mycelium|coarse_dirt|mud|sandstone|red_sandstone|terracotta|[a-z_]*_terracotta|sugar_cane|pumpkin|melon|[a-z_]*_ore|[a-z_]*mushroom[a-z_]*|[a-z_]*_(log|leaves)|[a-z_]*_sapling)$/;
  for (const b of BF.blocks) {
    if (!b) continue;
    if (b.id === 0 || b.render === "liquid" || b.render === "cross" || RAW.test(b.name)) NATF[b.id] = 1;
    if (/^(stone|deepslate|tuff|andesite|diorite|granite|calcite)$/.test(b.name) || /_ore$/.test(b.name)) ROCKF[b.id] = 1;
  }
  for (const nm of ["stone", "coal_ore", "iron_ore"]) if (BF.B[nm] != null) STONEF[BF.B[nm]] = 1;
}
const natural = id => (flags(), NATF[id] === 1);
const built = id => id !== 0 && !natural(id) && BF.RENDER[id] !== 3;
const surfaceStone = id => (flags(), STONEF[id] === 1);
const rock = id => (flags(), ROCKF[id] === 1);
const liquid = id => BF.RENDER[id] === 3;
const solid = id => !!BF.SOLID[id];
function nearBuilt(x, y, z, r) {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 4; dy++) if (built(get(x + dx, y + dy, z + dz))) return true;
  return false;
}

// ---------------------------------------------------------------- the village box
const boxOf = m => { const w = m.village && m.village.wg; return w && w.minX != null ? w : null; };
const boxDist = (b, x, z) => Math.hypot(Math.max(0, b.minX - x, x - b.maxX), Math.max(0, b.minZ - z, z - b.maxZ));
const villageY = m => (m.village && m.village.wg && m.village.wg.y != null ? m.village.wg.y : m.village ? m.village.y : m.position.y);
function area(m) {
  const b = boxOf(m);
  if (b) return { x0: b.minX - SEARCH, x1: b.maxX + SEARCH, z0: b.minZ - SEARCH, z1: b.maxZ + SEARCH, inside: (x, z) => boxDist(b, x, z) <= SEARCH, box: b };
  const c = m.village || m.position, R = 32 + SEARCH;
  return { x0: Math.floor(c.x - R), x1: Math.floor(c.x + R), z0: Math.floor(c.z - R), z1: Math.floor(c.z + R), inside: (x, z) => Math.hypot(x - c.x, z - c.z) <= R,
    box: { minX: Math.floor(c.x - 32), maxX: Math.floor(c.x + 32), minZ: Math.floor(c.z - 32), maxZ: Math.floor(c.z + 32) } };
}

// ---------------------------------------------------------------- surface stone
const claims = new Map();   // "x,y,z" -> miner, so two miners do not dig the same block
const pk = (x, y, z) => x + "," + y + "," + z;
// Can (x, y, z) be quarried: the column's top block, stone (or coal / iron ore), sticking up above one of its four neighbours?
function quarryable(x, y, z, floor) {
  if (y < floor || !surfaceStone(get(x, y, z))) return false;
  if (W().heightAt(x, z) !== y) return false;
  // a neighbour 1 or 2 lower: the column it leaves (y - 1) is at most a step above that neighbour, so the quarry stays a walkable slope,
  // never a pit, trench or ledge the miner can't climb out of (a sheer drop on every side leaves the block alone)
  let step = false;
  for (const [dx, dz] of BF.DIRS) { const h = W().heightAt(x + dx, z + dz); if (h < y && h >= y - 2) step = true; }
  return step;
}
// All quarryable blocks in the miner's area: [{x, y, z}] (scanned at most every 30 s per miner).
function scanSurface(m, Q) {
  const A = area(m), floor = Math.floor(villageY(m)) - FLOOR_BELOW, out = [];
  for (let x = A.x0; x <= A.x1; x++) for (let z = A.z0; z <= A.z1; z++) {
    if (!A.inside(x + 0.5, z + 0.5) || !W().isLoaded(x, z)) continue;
    const y = W().heightAt(x, z);
    if (quarryable(x, y, z, floor)) out.push({ x, y, z });
  }
  Q.surf = out; Q.surfAt = nowS();
  return out;
}
// The next surface block to dig: near the miner (and near the last one, so it works an outcrop down before moving on), checked again now.
function findSurface(m, Q) {
  if (!Q.surf || nowS() - Q.surfAt > 30) scanSurface(m, Q);
  const floor = Math.floor(villageY(m)) - FLOOR_BELOW, px = m.position.x, pz = m.position.z;
  const bad = Q.badSurf || (Q.badSurf = new Map());
  // nearest first, but the highest blocks of an outcrop before the ones under them: it levels a hill from the top down, so the way up
  // never gets cut off below blocks it still wants
  const cands = Q.surf.map(c => [c, Math.hypot(c.x + 0.5 - px, c.z + 0.5 - pz) * (0.8 + 0.4 * Math.random()) - 4 * (c.y - floor)]).sort((a, b) => a[1] - b[1]);
  let tested = 0;
  for (const [c] of cands) {
    const k = pk(c.x, c.y, c.z), o = claims.get(k);
    if (o && o !== m && !o.dead && !o.removed) continue;
    if ((bad.get(k) || 0) > nowS()) continue;
    if (!quarryable(c.x, c.y, c.z, floor)) continue;
    if (++tested > 30) break;
    if (nearBuilt(c.x, c.y, c.z, BUILD_AVOID)) { bad.set(k, nowS() + 600); continue; }
    return c;
  }
  return null;
}

// ---------------------------------------------------------------- the mineshaft plan
// shaft = {x, y, z (entrance feet cell), dx, dz (outward), S (stair count once decided, else null), run (stone steps in a row), n (cells done),
//          k (shafts dug so far), done}. Cell t: stairs while t < S (step i = t + 1: feet y - i, 3 high), then tunnel cell u = t - S.
// The corridor's direction: straight on from the stairs (turn 0), or to their left (1) or right (2) when a later shaft reuses the staircase.
const cdir = sh => (sh.turn === 1 ? [-sh.dz, sh.dx] : sh.turn === 2 ? [sh.dz, -sh.dx] : [sh.dx, sh.dz]);
function tunnelCell(sh, u) {
  const xs = sh.x + sh.dx * sh.S, zs = sh.z + sh.dz * sh.S, ys = sh.y - sh.S, [ux, uz] = cdir(sh);
  const p = Math.floor(u / PERIOD), r = u % PERIOD;
  if (r < BRANCH_EVERY) { const j = p * BRANCH_EVERY + r + 1; return { x: xs + ux * j, y: ys, z: zs + uz * j, h: 2, kind: "corridor", j }; }
  const J = (p + 1) * BRANCH_EVERY, side = r < BRANCH_EVERY + BRANCH_LEN ? 1 : -1, k = side > 0 ? r - BRANCH_EVERY + 1 : r - BRANCH_EVERY - BRANCH_LEN + 1;
  const px = -uz * side, pz = ux * side;
  return { x: xs + ux * J + px * k, y: ys, z: zs + uz * J + pz * k, h: 2, kind: "branch", J, side, k };
}
function cellOf(sh, t) {
  if (sh.S == null || t < sh.S) { const i = t + 1; return { x: sh.x + sh.dx * i, y: sh.y - i, z: sh.z + sh.dz * i, h: 3, kind: "stairs", i }; }
  return tunnelCell(sh, t - sh.S);
}
// Feet cells from the entrance to cell c (inclusive): the walk through the shaft.
function walkTo(sh, c) {
  const out = [[sh.x, sh.y, sh.z]];
  const stairs = c.kind === "stairs" ? c.i : sh.S;
  for (let i = 1; i <= stairs; i++) out.push([sh.x + sh.dx * i, sh.y - i, sh.z + sh.dz * i]);
  if (c.kind === "stairs") return out;
  const xs = sh.x + sh.dx * sh.S, zs = sh.z + sh.dz * sh.S, ys = sh.y - sh.S, [ux, uz] = cdir(sh);
  const jEnd = c.kind === "corridor" ? c.j : c.J;
  for (let j = 1; j <= jEnd; j++) out.push([xs + ux * j, ys, zs + uz * j]);
  if (c.kind === "branch") { const px = -uz * c.side, pz = ux * c.side, bx = xs + ux * c.J, bz = zs + uz * c.J; for (let k = 1; k <= c.k; k++) out.push([bx + px * k, ys, bz + pz * k]); }
  return out;
}
// Where the miner stands to dig cell t: the walk to it minus its last cell (cell t itself).
const standWalk = (sh, t) => walkTo(sh, cellOf(sh, t)).slice(0, -1);
// The dug cells of the shaft as "x,y,z" -> true (rebuilt when the shaft grows), to tell whether a villager is inside it.
function dugSet(sh) {
  if (sh._set && sh._setN === sh.n) return sh._set;
  const s = new Map();
  s.set(pk(sh.x, sh.y, sh.z), 0);
  for (let t = 0; t < sh.n; t++) { const c = cellOf(sh, t); s.set(pk(c.x, c.y, c.z), t); }
  Object.defineProperty(sh, "_set", { value: s, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(sh, "_setN", { value: sh.n, writable: true, enumerable: false, configurable: true });
  return s;
}
const feet = m => [Math.floor(m.position.x), Math.floor(m.position.y + 0.01), Math.floor(m.position.z)];
// The shaft cell the miner stands in (its index, -1 = the entrance), or null when it is not in its shaft.
function shaftCellOf(m, sh) {
  if (!sh) return null;
  const [x, y, z] = feet(m), set = dugSet(sh);
  for (const yy of [y, y - 1, y + 1]) {   // mid-step on the stairs its feet can be a block off
    const t = set.get(pk(x, yy, z));
    if (t != null) return (x === sh.x && yy === sh.y && z === sh.z) ? -1 : t;
  }
  return null;
}
const inShaft = (m, sh) => { const t = shaftCellOf(m, sh); return t != null && t >= 0; };
// The route (feet cells) inside the shaft from where the miner stands (cell index `from`, -1 = entrance) to `walk` (a list from walkTo).
function routeIn(sh, from, walk) {
  const here = from < 0 ? [[sh.x, sh.y, sh.z]] : walkTo(sh, cellOf(sh, from));
  let L = 0;
  while (L < here.length && L < walk.length && here[L][0] === walk[L][0] && here[L][1] === walk[L][1] && here[L][2] === walk[L][2]) L++;
  const back = here.slice(Math.max(0, L - 1), here.length - 1).reverse();
  return back.concat(walk.slice(L));
}

// A new shaft just outside the village box: the first of up to 24 directions (seeded by the village and the shafts dug so far) where the
// ground is loaded, dry and away from buildings for the first steps.
function planShaft(m, k) {
  const A = area(m), b = A.box, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  let h = 2166136261;
  const key = (m.village ? m.village.key : "") + "#shaft" + k;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const a0 = ((h >>> 0) % 6283) / 1000;
  for (let tr = 0; tr < 24; tr++) {
    const a = a0 + tr * 2.4, ux = Math.cos(a), uz = Math.sin(a);
    const half = Math.min(Math.abs(ux) > 1e-6 ? (b.maxX - b.minX) / 2 / Math.abs(ux) : Infinity, Math.abs(uz) > 1e-6 ? (b.maxZ - b.minZ) / 2 / Math.abs(uz) : Infinity);
    const x = Math.floor(cx + ux * (half + 5)), z = Math.floor(cz + uz * (half + 5));
    const dx = Math.abs(ux) >= Math.abs(uz) ? Math.sign(ux) : 0, dz = dx ? 0 : Math.sign(uz);
    let ok = true;
    for (let i = -1; i <= 14 && ok; i++) if (!W().isLoaded(x + dx * i, z + dz * i)) ok = false;
    if (!ok) continue;
    const y = W().heightAt(x, z) + 1;
    if (!BF.mobs.nav.walkCell(x, y, z) || liquid(get(x, y - 1, z)) || nearBuilt(x, y, z, 3)) continue;
    let dry = true;
    for (let i = 1; i <= 10 && dry; i++) for (let dy = -i - 1; dy <= 2 - i; dy++) { const id = get(x + dx * i, y + dy, z + dz * i); if (liquid(id) || built(id)) dry = false; }
    if (!dry) continue;
    return { x, y, z, dx, dz, S: null, run: 0, n: 0, k, done: false, D: digDepth(m) };
  }
  return null;
}
// The blocks cell c would open, checked: {ok, why}. Liquids next to an opened block, something built, bedrock or a void underfoot stop it.
function checkCell(c) {
  W().ensureRange(c.x, c.z, c.y - 2, c.y + c.h + 1);
  for (let k = 0; k < c.h; k++) {
    const y = c.y + k, id = get(c.x, y, c.z);
    if (built(id)) return { ok: false, why: "built" };
    if (id && !isFinite((BF.blocks[id] || {}).hardness)) return { ok: false, why: "unbreakable" };
    if (liquid(id)) return { ok: false, why: "water" };
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const n = get(c.x + dx, y + dy, c.z + dz);
      if (liquid(n)) return { ok: false, why: "water" };
    }
  }
  const below = get(c.x, c.y - 1, c.z);
  if (liquid(below) || built(below) && !solid(below)) return { ok: false, why: "water" };
  return { ok: true, floor: solid(below) };
}
// Moves the shaft past a cell that cannot be dug: the rest of a branch is skipped; anything else ends the shaft.
function skipCell(m, sh, c, why) {
  log("skip", m, { cell: c.kind, why, at: [c.x, c.y, c.z] });
  if (c.kind === "branch") { sh.n += BRANCH_LEN - c.k + 1; return; }
  if (c.kind === "stairs" && c.i > 3) { sh.S = c.i - 1; sh.n = sh.S; return; }   // stairs reached water: the corridor starts here
  sh.done = true;
}
// After cell c is open: stairs count solid rock, end in rock or at the depth limit, torches go up.
function afterCell(m, sh, c, rocky) {
  sh.n++;
  if (c.kind === "stairs") {
    sh.run = rocky ? (sh.run || 0) + 1 : 0;
    if (c.i >= Math.min(MAX_STAIRS, sh.D || DIG_DEPTH[0]) || c.y - 1 <= BF.MIN_Y + 4) { sh.S = c.i; log("stairs", m, { steps: c.i, y: c.y }); }
  } else if (c.kind === "corridor" && c.j >= CORRIDOR && (sh.n - sh.S) % PERIOD === 0) { sh.done = true; log("shaftDone", m, { n: sh.n }); }
  const step = c.kind === "stairs" ? c.i : c.kind === "corridor" ? c.j : c.k;
  if (step % TORCH_EVERY === 0) torch(m, c);
}
function torch(m, c) {
  const T = TR().inv, t = I("torch");
  if (t == null || get(c.x, c.y, c.z) !== 0) return;
  if (count(m, t) < 1 && count(m, I("coal")) > 0 && count(m, I("stick")) > 0 && T.canFit(m.inv, [{ id: t, n: 4 }], [{ id: I("coal"), n: 1 }, { id: I("stick"), n: 1 }])) {
    T.remove(m.inv, I("coal"), 1); T.remove(m.inv, I("stick"), 1); T.add(m.inv, t, 4);   // 1 coal + 1 stick = 4 torches
  }
  if (count(m, t) < 1) return;
  W().setBlock(c.x, c.y, c.z, BF.B.torch);
  T.remove(m.inv, t, 1);
  if (BF.emit) BF.emit("blockPlaced", c.x, c.y, c.z, BF.B.torch);
}

// ---------------------------------------------------------------- digging
// Breaks block (x, y, z) as the miner: drops it wants go into its pack, the pickaxe wears by one use. Returns false when it cannot.
function dig(m, x, y, z) {
  const id = get(x, y, z);
  if (!id || liquid(id)) return true;
  const p = pickOf(m), b = BF.blocks[id];
  if (!isFinite(b.hardness)) return false;
  W().setBlock(x, y, z, 0);
  if (canHarvest(id, p)) for (const d of BF.rollDrops(id)) if (keeps(d.id) && !(d.id === I("cobblestone") && count(m, d.id) >= KEEP_COBBLE)) { const left = TR().inv.add(m.inv, d.id, d.count); if (left) log("full", m, { lost: left + " " + nameOf(d.id) }); }
  wearPick(m, p, BF.toolWear.forBlock(id, p));
  if (BF.emit) BF.emit("blockBroken", x, y, z, id);
  return true;
}
// Wear at the player's rate (js/toolwear.js): a used-up pickaxe leaves its pack with a clink and a village log line.
function wearPick(m, p, n) {
  if (!p || BF.toolWear.use(m, p, n) !== "broken") return;
  log("pickBroke", m, { pick: nameOf(p.id) });
}
// A hostile mob within reach (one that wandered into the tunnel from a cave, or spawned in its dark): the miner hits it with its pickaxe
// (2 + tier damage, 2 uses of wear, like the player's), so it can't block the way for good.
function fend(m, Q, dt) {
  if ((Q.hitT = (Q.hitT || 0) - dt) > 0) return;
  const p = pickOf(m);
  if (!p) return;
  const o = BF.mobs.list.find(o => o !== m && !o.dead && !o.removed && o.def && o.def.hostile && Math.hypot(o.position.x - m.position.x, o.position.z - m.position.z) < 1.8 && Math.abs(o.position.y - m.position.y) < 1.5);
  if (!o) return;
  Q.hitT = 0.8; m.ai.swingT = 0.3;
  BF.mobs.hurt(o, 2 + BF.items[p.id].tool.tier, "villager");
  wearPick(m, p, BF.toolWear.forHit(p));
  log("fend", m, { mob: o.type });
}

// ---------------------------------------------------------------- pickaxes
// Crafts what it can right now: sticks from planks when short, a stone pickaxe from 3 cobblestone + 2 sticks when it has no pickaxe.
function craftPick(m) {
  const T = TR().inv;
  if (count(m, I("stick")) < 2) {
    const pl = m.inv.find(s => s && (nameOf(s.id) === "planks" || /_planks$/.test(nameOf(s.id))) && s.count >= 2);
    if (pl && T.canFit(m.inv, [{ id: I("stick"), n: 4 }], [{ id: pl.id, n: 2 }])) { T.remove(m.inv, pl.id, 2); T.add(m.inv, I("stick"), 4); }
  }
  if (count(m, I("cobblestone")) >= 3 && count(m, I("stick")) >= 2 && T.canFit(m.inv, [{ id: I("stone_pickaxe"), n: 1 }], [{ id: I("cobblestone"), n: 3 }, { id: I("stick"), n: 2 }])) {
    T.remove(m.inv, I("cobblestone"), 3); T.remove(m.inv, I("stick"), 2); T.add(m.inv, I("stone_pickaxe"), 1);
    log("craft", m, { made: "stone_pickaxe" });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- trips (buying pickaxes / planks, selling cobblestone to builders)
const canSell = v2 => v2 && v2.type === "villager" && !v2.dead && !v2.removed && !v2.sleeping && !v2.tradingWith && v2.profession !== "miner" && Array.isArray(v2.inv) && Array.isArray(v2.trades);
// The nearest villager of its village that sells an item `want(id)` accepts, at an offer the miner can pay and store: {kind: "buy", other, offer, times}.
function findSeller(m, want, avoid) {
  const R = m.village, T = TR();
  if (!R) return null;
  let best = null, bd = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !canSell(v2)) continue;
    for (const o of v2.trades) {
      if (!want(o.sell.id) || T.blockReason(v2, o) || (avoid[(v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id] || 0) > dayNow()) continue;
      if (!o.buy.every(b => T.inv.count(m.inv, b.id) >= b.n) || !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) continue;
      const d = v2.position.distanceTo(m.position) + (BF.items[o.sell.id].tool ? -10 * BF.items[o.sell.id].tool.tier : 0);   // the better pickaxe first
      if (d < bd) { bd = d; best = { kind: "buy", other: v2, offer: o, times: 1, item: o.sell.id }; }
    }
  }
  return best;
}
function doBuy(m, deal) {
  const T = TR(), v2 = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(v2) || T.blockReason(v2, o)) break;
    if (!o.buy.every(b => T.inv.count(m.inv, b.id) >= b.n) || !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
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
// How much cobblestone builder b would take now: what its structure or plan still lacks, and a reserve for the next foundation when its
// village builds on cobblestone.
function builderWants(b) {
  const id = I("cobblestone"), have = TR().inv.count(b.inv, id), bs = b.bs;
  let need = 0;
  const st = b.village && b.village.style, pal = BF.worldgen.palette ? BF.worldgen.palette(typeof st === "number" ? st : Math.max(0, STYLES.indexOf(st))) : null;
  if (pal && pal.found === BF.B.cobblestone) need = BUILDER_RESERVE - have;
  if (bs && bs.want && bs.want.short && bs.want.short[id]) need = Math.max(need, bs.want.short[id]);
  if (bs && bs.entry && bs.entry.state === "building" && BF.builder && BF.builder.remainingReq) need = Math.max(need, (BF.builder.remainingReq(bs.entry, bs.entry.prog)[id] || 0) - have);
  return Math.max(0, need);
}
const canBuy = b => b && b.type === "villager" && b.profession === "builder" && !b.dead && !b.removed && !b.sleeping && !b.tradingWith && Array.isArray(b.inv);
const cobbleOffer = m => (m.trades || []).filter(o => o.sell.id === I("cobblestone") && o.buy.length === 1 && o.buy[0].id === I("emerald")).sort((a, b) => (a.buy[0].n / a.sell.n) - (b.buy[0].n / b.sell.n) || a.sell.n - b.sell.n).pop() || null;
function saleTimes(m, b, o) {
  const T = TR();
  if (!o || T.blockReason(m, o)) return 0;
  let k = Math.min(Math.ceil(builderWants(b) / o.sell.n), Math.floor(count(m, o.sell.id) / o.sell.n), 4);
  for (const p of o.buy) k = Math.min(k, Math.floor(T.inv.count(b.inv, p.id) / p.n));
  while (k > 0 && !T.inv.canFit(b.inv, [{ id: o.sell.id, n: o.sell.n * k }], o.buy.map(p => ({ id: p.id, n: p.n * k })))) k--;
  return Math.max(0, k);
}
function findBuyer(m, avoid) {
  const R = m.village, o = cobbleOffer(m);
  if (!R || !o || count(m, o.sell.id) < Math.max(o.sell.n, SELL_MIN)) return null;
  let best = null, bd = Infinity;
  for (const b of R.members || []) {
    if (b === m || !canBuy(b) || (avoid[(b.slot ? b.slot.idx : 0) + ":cobble"] || 0) > dayNow()) continue;
    const k = saleTimes(m, b, o);
    if (k < 1) continue;
    const d = b.position.distanceTo(m.position);
    if (d < bd) { bd = d; best = { kind: "sell", other: b, offer: o, times: k, item: "cobble" }; }
  }
  return best;
}
// The builder buys from the miner's own offer: same stock / room rules as a player trade, xp to the miner.
function doSell(m, deal) {
  const T = TR(), b = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canBuy(b) || saleTimes(m, b, o) < 1) break;
    if (!T.exchange(m, o)) break;
    for (const p of o.buy) T.inv.remove(b.inv, p.id, p.n);
    T.inv.add(b.inv, o.sell.id, o.sell.n);
    T.addXp(m, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(b, m, o, done);
  if (done) log("sell", m, { to: "builder", cobble: done * o.sell.n, got: o.buy.map(p => p.n * done + " " + BF.itemName(p.id)).join(" + ") });
  return done;
}

// ---------------------------------------------------------------- walking
// On the surface: A* hops of at most 20 blocks (like js/forester.js) to a cell satisfying goal.at.
function travel(m, st, dt, out, goal, speed) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z, [fx, fy, fz] = feet(m);
  if (goal.at(fx, fy, fz)) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "mi") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const d = Math.hypot(goal.x + 0.5 - px, goal.z + 0.5 - pz);
    const hop = d > 22 ? [Math.floor(px + (goal.x + 0.5 - px) * 20 / d), Math.floor(pz + (goal.z + 0.5 - pz) * 20 / d)] : null;
    const g = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 } : goal;
    const path = N.findPath(fx, fy, fz, g, 2500);
    if (path && !path.length) { st.navFail = 0; return hop ? "going" : "arrived"; }
    if (path) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "mi"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}
// Inside the shaft: along its own cells (a fixed route, no A*). Returns "arrived", "going" or "failed".
function walkShaft(m, Q, dt, out, walk, speed) {
  const ai = m.ai, sh = Q.shaft, last = walk[walk.length - 1];
  if (Math.hypot(last[0] + 0.5 - m.position.x, last[2] + 0.5 - m.position.z) < 0.45 && Math.abs(m.position.y - last[1]) < 1.1) { ai.route = null; return "arrived"; }   // as followRoute counts a cell reached
  if (!ai.route || ai.routeKind !== "mishaft") {
    const from = shaftCellOf(m, sh);
    if (from == null) return "failed";
    const r = routeIn(sh, from, walk), c = from < 0 ? { x: sh.x, y: sh.y, z: sh.z } : cellOf(sh, from);
    ai.route = r.length ? r : [last];
    // off its cell's centre (pushed, or mid-step): back to it first, so it never cuts a corner into the next cell
    if (Math.hypot(c.x + 0.5 - m.position.x, c.z + 0.5 - m.position.z) > 0.3) ai.route = [[c.x, c.y, c.z]].concat(ai.route);
    ai.ri = 0; ai.stuckT = 0; ai.routeKind = "mishaft";
  }
  const r = BF.mobs.nav.followRoute(m, dt, out, speed);
  if (r === "stuck") { const c = ai.route && ai.route[ai.ri]; Q.stuckAt = c ? [c[0], c[1], c[2]] : null; ai.route = null; Q.stuck = (Q.stuck || 0) + 1; if (Q.stuck >= 3) { Q.stuck = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}

// ---------------------------------------------------------------- getting unstuck
// Paths keep failing from where it stands (down in a hole, a ravine, a cave it fell into): it digs itself a staircase out, one step up at a
// time towards the village, as a player would.
function lost(m, Q) { Q.lost = (Q.lost || 0) + 1; }
// Whether it can still walk to the middle of its village (a block it could not reach was cut off, not the miner).
function canGoHome(m) {
  const c = m.village, [fx, fy, fz] = feet(m);
  if (!c) return true;
  const gx = Math.floor(c.x), gz = Math.floor(c.z);
  return !!BF.mobs.nav.findPath(fx, fy, fz, { x: gx, z: gz, at: (x, y, z) => Math.abs(x - gx) + Math.abs(z - gz) <= 8 }, 6000);
}
function climbStep(m, Q, k, dt, out) {
  const [fx, fy, fz] = feet(m), c = m.village || m.position;
  const order = Math.abs(c.x - m.position.x) >= Math.abs(c.z - m.position.z) ? [[Math.sign(c.x - m.position.x) || 1, 0], [0, Math.sign(c.z - m.position.z) || 1]] : [[0, Math.sign(c.z - m.position.z) || 1], [Math.sign(c.x - m.position.x) || 1, 0]];
  order.push([-order[1][0], -order[1][1]], [-order[0][0], -order[0][1]]);
  if (!k.dir) {
    // the first direction whose next step holds nothing built or liquid
    k.dir = order.find(([dx, dz]) => [[fx, fy + 2, fz], [fx + dx, fy + 1, fz + dz], [fx + dx, fy + 2, fz + dz], [fx + dx, fy + 3, fz + dz]].every(([x, y, z]) => !built(get(x, y, z)) && !liquid(get(x, y, z)) && isFinite((BF.blocks[get(x, y, z)] || {}).hardness)));
    if (!k.dir) return "failed";
    k.from = [fx, fy, fz];
  }
  const [dx, dz] = k.dir, [x0, y0, z0] = k.from, nx = x0 + dx, nz = z0 + dz;
  const step = solid(get(nx, y0, nz)) ? 1 : 0;   // up onto the next block, or level when there is none
  const blocks = [[x0, y0 + 2, z0], [nx, y0 + step, nz], [nx, y0 + step + 1, nz]].filter(([x, y, z]) => get(x, y, z) !== 0 && !(y === y0 + step - 1));
  if (!k.dug) return digBlocks(m, Q, blocks, dt, () => { k.dug = true; m.ai.route = [[nx, y0 + step, nz]]; m.ai.ri = 0; m.ai.stuckT = 0; m.ai.routeKind = "mi"; });
  const r = BF.mobs.nav.followRoute(m, dt, out, m.def.speed);
  if (r === "done" || r === "stuck") { m.ai.route = null; return r === "done" ? "stepped" : "failed"; }
  return "going";
}

// ---------------------------------------------------------------- the miner's day
const state = m => m.mi || (m.mi = { task: null, thinkT: rnd(0.5, 2), avoid: {}, nav: { navWait: 0, navFail: 0 }, shaft: null, shafts: 0, sellCheck: 0 });
function endTask(m, Q) {
  const k = Q.task;
  if (k && k.claim) claims.delete(k.claim);
  Q.task = null; m.ai.route = null; Q.digT = 0;
}
// Seconds the walk out of the shaft takes from where it stands, with a margin.
const exitSecs = (m, Q) => { const t = shaftCellOf(m, Q.shaft); return t == null || t < 0 ? 0 : walkTo(Q.shaft, cellOf(Q.shaft, t)).length / Math.max(0.5, m.def.speed) + 20; };

function think(m, Q) {
  const T = TR().inv, cobble = count(m, I("cobblestone"));
  const sh = Q.shaft, underground = inShaft(m, sh);
  if ((Q.lost || 0) >= 3 && pickOf(m)) return { kind: "climb", max: 40 };
  // 1. a pickaxe: craft a stone one, or buy one from the toolsmith
  if (!pickOf(m)) {
    if (!underground) {
      const deal = count(m, I("emerald")) > 0 ? findSeller(m, isPick, Q.avoid) : null;
      if (deal) return { kind: "trip", deal };
    }
    if (craftPick(m)) return null;
    if (!underground && count(m, I("stick")) < 2) { const deal = findSeller(m, id => nameOf(id) === "stick" || /(^|_)planks$/.test(nameOf(id)), Q.avoid); if (deal) return { kind: "trip", deal }; }
    if (underground) return { kind: "exit" };
    Q.status = "needs a pickaxe";
    return null;
  }
  // 1b. a level that may dig deeper than a novice but no iron pickaxe to harvest gold and diamonds with: buy one when a villager sells one
  if (!underground && (m.level || 1) > 1 && (BF.items[pickOf(m).id].tool.tier || 0) < DEEP_TIER && count(m, I("emerald")) > 0 && nowS() >= (Q.upCheck || 0)) {
    Q.upCheck = nowS() + 60;
    const deal = findSeller(m, id => isPick(id) && (BF.items[id].tool.tier || 0) >= DEEP_TIER, Q.avoid);
    if (deal) return { kind: "trip", deal };
  }
  // 2. cobblestone for the builders
  if (cobble >= SELL_MIN && nowS() >= Q.sellCheck) {
    Q.sellCheck = nowS() + 20;
    const deal = findBuyer(m, Q.avoid);
    if (deal) return underground ? { kind: "exit" } : { kind: "trip", deal };
  }
  // 3. digging
  if (cobble >= KEEP_COBBLE && digDepth(m) <= DIG_DEPTH[0] || freeSlots(m) < 1 && !T.canFit(m.inv, [{ id: I("cobblestone"), n: 1 }], [])) { Q.status = "has a full pack of stone"; return underground ? { kind: "exit" } : null; }
  const deep = digDepth(m) > DIG_DEPTH[0];
  if (sh && !sh.done && sh.S != null && deep && digDepth(m) >= sh.S + 12 && !underground) { sh.done = true; log("deeper", m, { was: sh.S, now: digDepth(m) }); }   // levelled up: a deeper shaft
  if (!underground && !deep) {   // a novice quarries surface stone first, whenever there is any; the mineshaft only when there is none
    const c = findSurface(m, Q);
    if (c) return { kind: "quarry", x: c.x, y: c.y, z: c.z, claim: pk(c.x, c.y, c.z), max: 60 + 2.5 * Math.hypot(c.x - m.position.x, c.z - m.position.z) };
  }
  if (sh && sh.done && sh.S != null && sh.n > sh.S && !sh.stuck && (sh.turn || 0) < 2 && Math.abs(digDepth(m) - sh.S) < 12) {
    // a finished shaft at the right depth: its staircase serves a new corridor to the left, then one to the right (no new staircase to dig)
    Q.shaft = { x: sh.x, y: sh.y, z: sh.z, dx: sh.dx, dz: sh.dz, S: sh.S, run: 0, n: sh.S, k: Q.shafts || 0, done: false, D: sh.D, turn: (sh.turn || 0) + 1 };
    Q.shafts = (Q.shafts || 0) + 1;
    log("shaft", m, { at: [sh.x, sh.y, sh.z], dir: cdir(Q.shaft), k: Q.shaft.k, reuse: true });
  } else if (!sh || sh.done) {
    const ns = planShaft(m, Q.shafts || 0);
    Q.shafts = (Q.shafts || 0) + 1;
    if (!ns) { Q.status = "found no place for a mineshaft"; return null; }
    Q.shaft = ns;
    log("shaft", m, { at: [ns.x, ns.y, ns.z], dir: [ns.dx, ns.dz], k: ns.k });
  }
  const d = Q.shaft ? Math.hypot(Q.shaft.x - m.position.x, Q.shaft.z - m.position.z) : 0;
  return { kind: "dig", max: 90 + 2.5 * (inShaft(m, Q.shaft) ? 0 : d) };
}

function ai(m, dt, out) {
  if (m.profession !== "miner" || !m.inv || m.dead || m.child || !m.village || !BF.mobs || !BF.mobs.nav || !W()) return false;
  const Q = state(m), a = m.ai, t = skyT();
  if (m.tradingWith || m.sleeping) { if (Q.task) endTask(m, Q); return false; }
  const working = t >= WORK_START && t < WORK_END && t < WORK_END - exitSecs(m, Q) / DAY_S;
  if (!working) {
    if (inShaft(m, Q.shaft) || Q.task && Q.task.kind === "climb") {
      const want = (Q.lost || 0) >= 3 || Q.task && Q.task.kind === "climb" ? "climb" : "exit";
      if (!Q.task || Q.task.kind !== want) { endTask(m, Q); Q.task = { kind: want, max: want === "exit" ? 120 : 40 }; Q.t = 0; }
    }
    else { if (Q.task) endTask(m, Q); return false; }
  }
  if (!Q.task) {
    Q.thinkT -= dt;
    if (Q.thinkT > 0) return false;
    Q.thinkT = 1;
    Q.status = "";
    const task = think(m, Q);
    if (!task) return false;
    Q.task = task; Q.t = 0; Q.digT = 0; Q.nav.navFail = 0; Q.nav.navWait = 0; Q.stuck = 0; a.route = null;
    if (task.claim) claims.set(task.claim, m);
  }
  const k = Q.task;
  Q.t += dt;
  if (k.kind !== "trip") fend(m, Q, dt);
  if (k.kind !== "trip" && Q.t > (k.max || 90)) { log("giveup", m, { task: k.kind, why: "too slow" }); if (k.kind === "quarry") (Q.badSurf || (Q.badSurf = new Map())).set(k.claim, nowS() + 300); endTask(m, Q); return true; }
  a.mode = "idle"; a.t = 2;
  const speed = m.def.speed * 1.1;
  if (k.kind === "exit") {
    const sh = Q.shaft;
    if (!inShaft(m, sh)) { endTask(m, Q); Q.thinkT = 0.5; return working; }
    const r = walkShaft(m, Q, dt, out, [[sh.x, sh.y, sh.z]], speed);
    if (r === "arrived") endTask(m, Q);
    else if (r === "failed") { log("giveup", m, { task: "exit", why: "stuck", at: feet(m), next: Q.stuckAt }); endTask(m, Q); Q.lost = 3; }   // dig its own way up instead
    return true;
  }
  if (k.kind === "trip") return trip(m, Q, k, dt, out);
  if (k.kind === "climb") {
    const r = climbStep(m, Q, k, dt, out);
    if (r === "failed" || r === "stepped") {
      k.steps = (k.steps || 0) + 1; k.dir = null; k.dug = false;
      if (r === "failed" || k.steps >= 3) { log("climb", m, { steps: k.steps, to: feet(m), ok: r !== "failed" }); endTask(m, Q); Q.lost = r === "failed" ? 0 : 2; Q.thinkT = 0.2; }   // try paths again (another 3 steps if they still fail)
    }
    return true;
  }
  if (k.kind === "quarry") {
    if (!quarryable(k.x, k.y, k.z, -Infinity) && get(k.x, k.y, k.z) === 0) { endTask(m, Q); return true; }
    const eye = (x, y, z) => Math.hypot(x + 0.5 - (k.x + 0.5), y + 1.62 - (k.y + 0.5), z + 0.5 - (k.z + 0.5));
    const goal = { x: k.x, z: k.z, at: (x, y, z) => eye(x, y, z) <= REACH && y >= k.y && !(x === k.x && z === k.z && y === k.y + 1) };   // never from below: it stays out of its own pits
    if (!goal.at(...feet(m))) {
      const r = travel(m, Q.nav, dt, out, goal, speed);
      if (r === "failed") { log("giveup", m, { task: "quarry", why: "no path", at: [k.x, k.y, k.z] }); (Q.badSurf || (Q.badSurf = new Map())).set(k.claim, nowS() + 600); if ((Q.qFail = (Q.qFail || 0) + 1) >= 5) { Q.qFail = 0; if (!canGoHome(m)) Q.lost = 3; } endTask(m, Q); return true; }   // one unreachable block is just skipped; five in a row: it is probably shut in
      if (r === "arrived") { Q.lost = 0; Q.qFail = 0; }
      if (r !== "arrived") return true;
    }
    a.route = null;
    out.faceX = k.x + 0.5; out.faceZ = k.z + 0.5; m.lookAt = null;
    return digBlocks(m, Q, [[k.x, k.y, k.z]], dt, () => { log("quarry", m, { at: [k.x, k.y, k.z] }); Q.thinkT = 0.2; endTask(m, Q); });
  }
  // dig: the next cell of the shaft
  const sh = Q.shaft;
  if (!sh || sh.done) { endTask(m, Q); return true; }
  const c = cellOf(sh, sh.n);
  if (!k.checked) {
    const ck = checkCell(c);
    if (!ck.ok) { skipCell(m, sh, c, ck.why); endTask(m, Q); Q.thinkT = 0.2; return true; }
    if (!ck.floor) {   // a void underfoot (a cave): it lays a cobblestone floor, or gives up on this cell
      if (count(m, I("cobblestone")) < 1) { skipCell(m, sh, c, "void"); endTask(m, Q); return true; }
      k.floor = true;
    }
    k.checked = true;
  }
  const walk = standWalk(sh, sh.n);
  const here = m.ai.route && m.ai.routeKind === "mishaft" ? 0 : shaftCellOf(m, sh);   // on its way through the shaft: keep going
  if (here == null) {   // on the surface: to the entrance first
    const goal = { x: sh.x, z: sh.z, at: (x, y, z) => x === sh.x && z === sh.z && Math.abs(y - sh.y) <= 1 };
    const r = travel(m, Q.nav, dt, out, goal, speed);
    if (r === "arrived") {   // beside the entrance or on its edge: step onto its centre
      if (Math.hypot(sh.x + 0.5 - m.position.x, sh.z + 0.5 - m.position.z) < 0.2) { m.position.x = sh.x + 0.5; m.position.z = sh.z + 0.5; }
      else { m.ai.route = [[sh.x, sh.y, sh.z]]; m.ai.ri = 0; m.ai.stuckT = 0; m.ai.routeKind = "mi"; }
      return true;
    }
    if (r === "failed") {
      log("giveup", m, { task: "dig", why: "no path to the shaft" }); lost(m, Q); endTask(m, Q);
      if (sh.n === 0 && (Q.shaftFails = (Q.shaftFails || 0) + 1) >= 3) { sh.done = true; Q.shaftFails = 0; }   // a shaft it never started: pick another place
      return true;
    }
    return true;
  }
  const r = walkShaft(m, Q, dt, out, walk, speed);
  if (r === "failed") {
    log("giveup", m, { task: "dig", why: "stuck in the shaft", at: feet(m), next: Q.stuckAt }); lost(m, Q); endTask(m, Q);
    if ((Q.shaftStuck = (Q.shaftStuck || 0) + 1) >= 3) { sh.done = true; sh.stuck = true; Q.shaftStuck = 0; }   // something blocks it for good (water, a fall): start another
    return true;
  }
  if (r !== "arrived") return true;
  Q.lost = 0;
  out.faceX = c.x + 0.5; out.faceZ = c.z + 0.5; m.lookAt = null;
  const blocks = [];
  for (let y = c.y + c.h - 1; y >= c.y; y--) if (get(c.x, y, c.z) !== 0) blocks.push([c.x, y, c.z]);
  k.rocky = k.rocky == null ? blocks.length === c.h && blocks.every(([x, y, z]) => rock(get(x, y, z))) : k.rocky;
  if (!k.ores) k.ores = wallOres(m, sh, c);
  for (const o of k.ores) if (get(o[0], o[1], o[2]) !== 0) blocks.push(o);
  return digBlocks(m, Q, blocks, dt, () => {
    if (k.floor && !solid(get(c.x, c.y - 1, c.z)) && count(m, I("cobblestone")) > 0) { W().setBlock(c.x, c.y - 1, c.z, BF.B.cobblestone); TR().inv.remove(m.inv, I("cobblestone"), 1); if (BF.emit) BF.emit("blockPlaced", c.x, c.y - 1, c.z, BF.B.cobblestone); }
    afterCell(m, sh, c, k.rocky); Q.shaftStuck = 0;
    endTask(m, Q); Q.thinkT = 0.1;
  });
}
// Ore in the walls and ceiling of cell c that its pickaxe can harvest and that has no liquid next to it: [[x, y, z]] (dug with the cell).
function wallOres(m, sh, c) {
  const out = [], p = pickOf(m), [ux, uz] = c.kind === "stairs" ? [sh.dx, sh.dz] : cdir(sh);
  const [rx, rz] = c.kind === "branch" ? [-uz, ux] : [ux, uz];   // the direction the cell's run goes; its walls are either side of it
  const cand = [[c.x, c.y + c.h, c.z]];
  for (let k = 0; k < c.h; k++) cand.push([c.x - rz, c.y + k, c.z + rx], [c.x + rz, c.y + k, c.z - rx]);
  for (const [x, y, z] of cand) {
    const id = get(x, y, z), b = BF.blocks[id];
    if (!b || !/_ore$/.test(b.name) || !canHarvest(id, p)) continue;
    let wet = false;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (liquid(get(x + dx, y + dy, z + dz))) wet = true;
    if (!wet) out.push([x, y, z]);
  }
  return out;
}
// Digs the listed blocks one after another (each takes digTime with its pickaxe), swinging; calls done() after the last.
function digBlocks(m, Q, blocks, dt, done) {
  const a = m.ai;
  const left = blocks.filter(([x, y, z]) => get(x, y, z) !== 0 && !liquid(get(x, y, z)));
  if (!left.length) { done(); return true; }
  const [x, y, z] = left[0], id = get(x, y, z), p = pickOf(m);
  if (!p && BF.blocks[id].needsTool) { endTask(m, Q); return true; }     // the pickaxe broke: think again
  if (Q.digAt !== pk(x, y, z)) { Q.digAt = pk(x, y, z); Q.digT = 0; }
  Q.digT += dt;
  if (a.swingT <= 0) { a.swingT = 0.3; if (BF.audio && BF.audio.blockSound) { try { BF.audio.blockSound("hit", id, x, y, z, 0.5); } catch (e) { /* optional */ } } }
  if (Q.digT >= digTime(id, p)) {
    if (!dig(m, x, y, z)) { endTask(m, Q); return true; }
    Q.digAt = null; Q.digT = 0;
    if (left.length === 1) done();
  }
  return true;
}
function trip(m, Q, k, dt, out) {
  const deal = k.deal, v2 = deal.other, a = m.ai;
  const avoidKey = () => (v2 && v2.slot ? v2.slot.idx : 0) + ":" + deal.item;
  const giveUp = why => { log("giveup", m, { to: v2 ? v2.profession : "?", item: deal.item === "cobble" ? "cobblestone" : BF.itemName(deal.item), why }); if (v2) Q.avoid[avoidKey()] = dayNow() + 0.05; endTask(m, Q); Q.thinkT = 0.5; return true; };
  if (!v2 || (deal.kind === "buy" ? !canSell(v2) : !canBuy(v2))) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone");
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (!k.stage) k.stage = "walk";
  if (k.stage === "walk") {
    if (Q.t > (k.walkMax || (k.walkMax = 60 + 2.5 * d))) return giveUp("timeout");
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { k.stage = "trade"; k.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (k.gx == null || Math.hypot(k.gx - g.x, k.gz - g.z) > 3) { if (a.routeKind === "mi") a.route = null; k.gx = g.x; k.gz = g.z; }
    const r = travel(m, Q.nav, dt, out, { x: g.x, z: g.z, at: (x, y, z) => Math.abs(x - g.x) <= 1 && Math.abs(z - g.z) <= 1 && Math.abs(y - g.y) <= 1 }, m.def.speed * 1.3);
    if (r === "failed") { lost(m, Q); return giveUp("no path"); }
    return true;
  }
  k.tt -= dt;
  if (d > 3.6) { k.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (k.tt <= 0) {
    const done = deal.kind === "buy" ? doBuy(m, deal) : doSell(m, deal);
    if (!done) { Q.avoid[avoidKey()] = dayNow() + 0.05; log("giveup", m, { to: v2.profession, item: deal.item === "cobble" ? "cobblestone" : BF.itemName(deal.item), why: "trade refused" }); }
    endTask(m, Q); Q.thinkT = 1;
  }
  return true;
}

// Trade-screen status line (inventory.js).
function statusText(m) {
  if (!m || m.profession !== "miner") return "";
  const Q = m.mi, k = Q && Q.task;
  if (k) {
    if (k.kind === "quarry") return "Quarrying stone";
    if (k.kind === "dig") return Q.shaft && Q.shaft.S == null ? "Digging a mineshaft" : "Mining underground";
    if (k.kind === "exit") return "Climbing out of the mine";
    if (k.kind === "climb") return "Digging its way out";
    if (k.kind === "trip") return k.deal.kind === "sell" ? "Taking cobblestone to a builder" : "Buying " + (isPick(k.deal.item) ? "a pickaxe" : nameOf(k.deal.item) === "stick" ? "sticks" : "planks");
  }
  return Q && Q.status ? Q.status.charAt(0).toUpperCase() + Q.status.slice(1) : "";
}

// Persistence (trading.js pack/unpack): the current shaft.
function pack(m) {
  const Q = m.mi;
  if (!Q || (!Q.shaft && !Q.shafts)) return undefined;
  const s = Q.shaft;
  return { k: Q.shafts || 0, s: s ? [s.x, s.y, s.z, s.dx, s.dz, s.S == null ? -1 : s.S, s.run || 0, s.n, s.k, s.done ? 1 : 0, s.D || DIG_DEPTH[0], s.turn || 0, s.stuck ? 1 : 0] : null };
}
function unpack(m, o) {
  if (!o || typeof o !== "object") return;
  const Q = state(m);
  Q.shafts = Math.max(0, Math.floor(+o.k || 0));
  const a = Array.isArray(o.s) && o.s.length >= 10 && o.s.every(Number.isFinite) ? o.s : null;
  Q.shaft = a ? { x: a[0], y: a[1], z: a[2], dx: a[3], dz: a[4], S: a[5] < 0 ? null : a[5], run: a[6], n: a[7], k: a[8], done: !!a[9], D: a[10] > 0 ? a[10] : DIG_DEPTH[0], turn: a[11] > 0 ? a[11] : 0, stuck: a[12] === 1 } : null;
}

// In its mineshaft (or digging its way out): village errands such as food shopping wait until it is back up (js/villagelife.js).
const underground = m => !!(m && m.mi && (inShaft(m, m.mi.shaft) || m.mi.task && m.mi.task.kind === "climb"));
BF.miner = { ai, underground, statusText, seed, pack, unpack, pickOf, digTime, findSurface, scanSurface, quarryable, planShaft, cellOf, walkTo, findBuyer, builderWants, doSell, LOG,
  KEEP_COBBLE, SELL_MIN, DIG_DEPTH, digDepth, _test: { state, area, checkCell, dig, craftPick, wallOres, think, inShaft, shaftCellOf, routeIn, standWalk } };
})();
