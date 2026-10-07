// Forester villagers and sapling growth (BF.forester). A recreation of the villager-planter mod (GordonWallace/villager-planter): a villager
// profession whose jobsite is the band saw, who plants the saplings it carries, fells whole trees and picks up what falls, and who buys
// saplings from the player for emeralds (the trade itself is in js/trading.js, TRADES.forester).
// - Planting: a forester holding a sapling picks a random free spot within 16 blocks (+-4 high) of itself: air over soil with room for a tree above,
//   no other sapling within 4 blocks, no door within 10 blocks and no building or other structure within 8 (dirt paths are fine). It walks there and plants (cooldown 10 s).
// - Felling: it picks a random natural tree within 40 blocks (+12 / -6 high), nearer ones favoured: the connected logs (at most 64) with leaves among them. When it is
//   within 3 blocks it fells the whole tree at once, leaves included, and the blocks drop their items (cooldown 20 s). Needs 2 free inventory slots.
//   Buildings are never touched: a log pile next to planks, stone, glass ... is not a tree.
// - Picking up: saplings, emeralds, logs, sticks and apples lying within 16 blocks are collected (js/drops.js entities). After felling a tree it
//   stays and collects until nothing it wants lies within 12 blocks of the stump (waiting for items still falling; 2 minutes at most).
// - Sawing: it turns up to 8 logs a day into 4 planks each (keeping 2 logs of each kind); planks and logs are what it sells (TRADES.forester).
// - Planting and felling pick one at random, weighted 10 : 8 as in the mod. Everything runs in working hours only, from its band saw.
// Players: chopping any log of a natural tree brings down everything above it, leaves included (fallAbove, like the mod).
// Saplings (blocks.js forester pack) also grow for players: on soil, with room above, a sapling becomes a tree after ~8 minutes on average
// (simulation clock, so fast-forward speeds it up). Leaves drop saplings, sticks and apples (blocks.js extraDrops).
// Persistence: nothing of its own. Saplings and trees are blocks; the forester's pack is the usual villager inventory.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const T = () => BF.trades;

const SPECIES = ["oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "cherry"];
const WORK_START = 0.04, WORK_END = 0.45;   // sky.time window (same as js/jobs.js)
// numbers of the mod (ticks / 20 = seconds)
const SEARCH = 16, PLANT_DY = 4, MAX_LOGS = 64, MAX_LEAVES = 256, MIN_FREE = 2;
const SAP_SPACING = 4, DOOR_AVOID = 10, PLANT_REACH = 2, CUT_REACH = 3;
const PLANT_CD = 10, CUT_CD = 20, PLANT_MAX = 30, CUT_MAX = 40, W_PLANT = 10, W_CUT = 8;
// additions
const CUT_SEARCH = 40, CUT_HOME = 64, CUT_Y_UP = 12, CUT_Y_DOWN = 6;   // felling reaches further than the mod's 16: few trees stand inside a village. Nearer trees are favoured, see findTree
const HOME_R = 36;          // it never plants or fells further than this from the village centre (the mod has no such leash: villagers there wander)
const CLEAR_ABOVE = 5;      // air above a planting spot, so the sapling has room to grow
const CHOP_T = 1.2;         // seconds of chopping before the tree comes down (the mod fells it the moment the villager arrives)
const GROW_PER_S = 1 / 480; // sapling -> tree: ~8 minutes of simulation time on average
const GATHER_R = 16;
const LEAF_D = 6;      // leaves further than this (through leaves) from the felled logs stay, as vanilla leaf decay
const SWEEP_R = 12, SWEEP_MAX = 120;   // after felling it stays until no wanted item lies within 12 blocks of the stump (at most 2 minutes)
const BUILD_AVOID = 8;  // never plants within 8 blocks of a building or other structure (anything not landscape; dirt paths do not count)

const LOG = [];
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, who: "forester" + (m && m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };
const nowS = () => BF.simNow();
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const W = () => BF.world;
const get = (x, y, z) => W().getBlock(x, y, z);

// ---------------------------------------------------------------- block classes
let LOGF = null, LEAFF = null, SAPF = null, SOILF = null;
function flags() {
  if (LOGF) return;
  const n = BF.MAX_BLOCK + 1;
  LOGF = new Uint8Array(n); LEAFF = new Uint8Array(n); SAPF = new Uint8Array(n); SOILF = new Uint8Array(n);
  for (const b of BF.blocks) {
    if (!b) continue;
    const id = BF.B[b.name];
    if (/_(log|wood)$/.test(b.name)) LOGF[id] = 1;
    else if (/_leaves$/.test(b.name)) LEAFF[id] = 1;
    else if (b.sapling) SAPF[id] = 1;
  }
  for (const nm of ["grass", "dirt", "coarse_dirt", "podzol", "mud", "moss_block", "farmland", "mycelium"]) if (BF.B[nm] != null) SOILF[BF.B[nm]] = 1;
}
const isLog = id => (flags(), LOGF[id] === 1);
const isLeaf = id => (flags(), LEAFF[id] === 1);
const isSap = id => (flags(), SAPF[id] === 1);
const isSoil = id => (flags(), SOILF[id] === 1);
const sapOf = id => (BF.blocks[id] && BF.blocks[id].sapling) || null;
const isPlant = id => BF.RENDER[id] === 4;
const isLiquid = id => BF.RENDER[id] === 3;
const isDoor = id => !!(BF.blocks[id] && BF.blocks[id].door);

// May a sapling stand at (x, y, z)? Soil below and the cell itself free.
function canSurvive(x, y, z) {
  const cur = get(x, y, z);
  return (cur === 0 || !!(BF.REPLACEABLE && BF.REPLACEABLE[cur])) && isSoil(get(x, y - 1, z));
}

// ---------------------------------------------------------------- sapling registry and growth
const saps = new Map();      // "x,y,z" -> {x, y, z}
const pk = (x, y, z) => x + "," + y + "," + z;
let hooked = false, growLast = 0, sawT = 0, SCANF = null;
function addSap(x, y, z, id) { if (isSap(id)) saps.set(pk(x, y, z), { x, y, z }); }
function hook() {
  if (hooked || !BF.world || !BF.on) return;
  hooked = true;
  flags();
  SCANF = new Uint8Array(BF.MAX_BLOCK + 1);
  for (let i = 0; i < SAPF.length; i++) if (SAPF[i]) SCANF[i] = 1;
  const scan = (cx, cz, c) => { const CS = BF.CS; BF.world.scanFlagged(c, SCANF, (lx, y, lz, id) => addSap(cx * CS + lx, y, cz * CS + lz, id)); };
  BF.world.onChunkLoad(scan);
  BF.world.onChunkUnload((cx, cz) => { const CS = BF.CS; for (const [k, s] of saps) if (Math.floor(s.x / CS) === cx && Math.floor(s.z / CS) === cz) saps.delete(k); });
  for (const c of BF.world.chunks.values()) scan(c.cx, c.cz, c);
  BF.on("blockPlaced", (x, y, z, id) => addSap(x, y, z, id));
  BF.on("blockBroken", (x, y, z, id) => {   // the player chops a log: the tree above falls (js/player.js emits this)
    if (!isLog(id)) return;
    const creative = !!(BF.inventory && BF.inventory.isCreative && BF.inventory.isCreative());
    fallAbove(x, y, z, !creative);
  });
  BF.on("newWorld", () => saps.clear());
}

// Tree shapes: [logs, leaves] as [dx, dy, dz] lists around the sapling cell (dy 0 = the sapling's own cell).
function shape(sp) {
  const logs = [], leaves = [];
  const trunk = h => { for (let y = 0; y < h; y++) logs.push([0, y, 0]); };
  const disc = (y, r, trim) => {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r + r * 0.8) continue;
      if (trim && Math.abs(dx) === r && Math.abs(dz) === r && Math.random() < trim) continue;
      leaves.push([dx, y, dz]);
    }
  };
  if (sp === "spruce") {
    const h = ri(6, 9); trunk(h);
    for (let k = 0; k <= h - 2; k++) disc(h - k, Math.min(3, Math.ceil(k / 2)), 0);
    leaves.push([0, h + 1, 0]);
  } else if (sp === "acacia") {
    const h = ri(4, 5); trunk(h); disc(h, 3, 0.6); disc(h + 1, 2, 0);
  } else if (sp === "jungle") {
    const h = ri(6, 9); trunk(h); disc(h - 3, 3, 0.5); disc(h - 2, 3, 0.5); disc(h - 1, 2, 0); disc(h, 1, 0.99);
  } else if (sp === "dark_oak" || sp === "cherry") {
    const h = ri(5, 7); trunk(h); disc(h - 2, 3, 0.6); disc(h - 1, 3, 0.6); disc(h, 2, 0); disc(h + 1, 1, 0.99);
  } else {   // oak, birch
    const h = sp === "birch" ? ri(5, 7) : ri(4, 6); trunk(h); disc(h - 3, 2, 0.6); disc(h - 2, 2, 0.6); disc(h - 1, 1, 0); disc(h, 1, 0.99);
  }
  return { logs, leaves };
}
// Grows the sapling at (x, y, z) into a tree. false (nothing changed) when something is in the way.
function growTree(x, y, z) {
  const sp = sapOf(get(x, y, z));
  if (!sp || !isSoil(get(x, y - 1, z))) return false;
  const s = shape(sp), B = BF.B, world = W();
  for (const [dx, dy, dz] of s.logs) {
    const cur = get(x + dx, y + dy, z + dz);
    if (!(cur === 0 || isLeaf(cur) || isPlant(cur))) return false;   // a plant includes the sapling itself
  }
  for (const [dx, dy, dz] of s.logs) world.setBlock(x + dx, y + dy, z + dz, B[sp + "_log"]);
  const leaf = B[sp + "_leaves"];
  for (const [dx, dy, dz] of s.leaves) { const cur = get(x + dx, y + dy, z + dz); if (cur === 0 || (isPlant(cur) && !isSap(cur))) world.setBlock(x + dx, y + dy, z + dz, leaf); }
  return true;
}

function growTick() {
  hook();
  const now = nowS();
  if (now - growLast < 1) return;
  const dt = Math.min(5, now - growLast);
  growLast = now;
  sawT -= dt;
  if (sawT <= 0 && BF.mobs) { sawT = 5; for (const m of BF.mobs.list) if (m.type === "villager" && m.profession === "forester" && !m.dead && !m.removed && Array.isArray(m.inv)) saw(m, state(m)); }   // whatever the villager is doing
  for (const [k, s] of saps) {
    if (!W().isLoaded(s.x, s.z)) continue;
    if (!isSap(get(s.x, s.y, s.z))) { saps.delete(k); continue; }
    if (Math.random() < GROW_PER_S * dt * (BF.weather && BF.weather.raining ? 1.3 : 1)) { if (growTree(s.x, s.y, s.z)) saps.delete(k); }
  }
}
{
  const world = BF.world;
  if (world && world.tickSim) { const prev = world.tickSim; world.tickSim = () => { prev(); growTick(); }; }
}

// ---------------------------------------------------------------- trees (felling)
const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NB18 = NB6.concat([[1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0], [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1], [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]]);
// Something that is part of the landscape rather than a building: air, plants, leaves, logs, soil, stone, snow, liquids, vines.
function natural(id) {
  if (id === 0 || isLeaf(id) || isLog(id) || isPlant(id) || isLiquid(id) || isSoil(id)) return true;
  const b = BF.blocks[id], n = b && b.name;
  return !!n && /^(stone|dirt|grass|sand|red_sand|gravel|snow|snow_block|vine|ice|packed_ice|clay|moss|dead_bush|cobweb|deepslate|netherrack|dripstone|rooted|mangrove_roots|muddy|bee_nest|beehive|cocoa|red_mushroom_block|brown_mushroom_block|andesite|diorite|granite|calcite|tuff|sandstone|red_sandstone|terracotta|podzol|mycelium|coarse|farmland|cactus)/.test(n);
}
// Something a person put there, for the planting distance: stricter than !natural(), since village walls use sandstone, terracotta and stone bricks.
const RAW = /^(stone|deepslate|tuff|andesite|diorite|granite|calcite|sand|red_sand|gravel|dirt|clay|snow|snow_block|ice|packed_ice|blue_ice|bedrock|obsidian|moss_block|moss_carpet|vine|dripstone_block|pointed_dripstone|cactus|dead_bush|cobweb|bee_nest|cocoa|mangrove_roots|muddy_mangrove_roots|rooted_dirt|podzol|mycelium|coarse_dirt|mud|sugar_cane|pumpkin|melon|[a-z_]*_ore|[a-z_]*mushroom[a-z_]*)$/;
function builtBlock(id) {
  if (id === 0 || isLeaf(id) || isLog(id) || isPlant(id) || isLiquid(id) || isSoil(id) || isSap(id)) return false;
  const b = BF.blocks[id];
  return !(b && RAW.test(b.name));
}
// The connected logs reached from `seeds` (18-neighbourhood, only at y >= minY) and the leaves joined to them: {logs, leaves}, or null when it is
// more than 64 logs, touches a block that is not landscape (a building), or has no leaves.
function collectTree(seeds, minY) {
  const seen = new Set(), logs = [];
  for (const [x, y, z] of seeds) if (isLog(get(x, y, z)) && !seen.has(pk(x, y, z))) { seen.add(pk(x, y, z)); logs.push([x, y, z]); }
  for (let i = 0; i < logs.length; i++) {
    const [cx, cy, cz] = logs[i];
    for (const [dx, dy, dz] of NB18) {
      const nx = cx + dx, ny = cy + dy, nz = cz + dz, k = pk(nx, ny, nz);
      if (ny < minY || seen.has(k)) continue;
      if (!isLog(get(nx, ny, nz))) continue;
      seen.add(k); logs.push([nx, ny, nz]);
      if (logs.length > MAX_LOGS) return null;
    }
  }
  if (!logs.length) return null;
  for (const [cx, cy, cz] of logs) for (const [dx, dy, dz] of NB6) { if (!natural(get(cx + dx, cy + dy, cz + dz))) return null; }
  // leaves: flood from the logs through leaf blocks (up to LEAF_D steps, as vanilla's leaf distance). A leaf goes with this tree only when
  // its own logs are nearer (through leaves) than any other tree's, so a neighbour's crown that touches this one keeps its leaves.
  const dA = new Map(), leaves = [], q = logs.map(c => [c[0], c[1], c[2], 0]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < q.length && leaves.length <= MAX_LEAVES; i++) {
    const [cx, cy, cz, d] = q[i];
    if (d >= LEAF_D) continue;
    for (const [dx, dy, dz] of NB6) {
      const nx = cx + dx, ny = cy + dy, nz = cz + dz, k = pk(nx, ny, nz);
      if (dA.has(k) || seen.has(k) || !isLeaf(get(nx, ny, nz))) continue;
      dA.set(k, d + 1); leaves.push([nx, ny, nz]); q.push([nx, ny, nz, d + 1]);
      if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny; if (nz < z0) z0 = nz; if (nz > z1) z1 = nz;
    }
  }
  if (leaves.length) {
    // other trees' logs near the crown, and their leaf distance to each of these leaves
    const qb = [], dB = new Map();
    for (let x = x0 - LEAF_D; x <= x1 + LEAF_D; x++) for (let z = z0 - LEAF_D; z <= z1 + LEAF_D; z++) for (let y = y0 - LEAF_D; y <= y1 + LEAF_D; y++) {
      if (isLog(get(x, y, z)) && !seen.has(pk(x, y, z))) qb.push([x, y, z, 0]);
    }
    for (let i = 0; i < qb.length; i++) {
      const [cx, cy, cz, d] = qb[i];
      if (d >= LEAF_D) continue;
      for (const [dx, dy, dz] of NB6) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz, k = pk(nx, ny, nz);
        if (dB.has(k) || seen.has(k) || !isLeaf(get(nx, ny, nz))) continue;
        dB.set(k, d + 1); qb.push([nx, ny, nz, d + 1]);
      }
    }
    if (dB.size) for (let i = leaves.length - 1; i >= 0; i--) { const k = pk(leaves[i][0], leaves[i][1], leaves[i][2]); if (dB.has(k) && dB.get(k) <= dA.get(k)) leaves.splice(i, 1); }
  }
  if (!leaves.length) return null;
  return { logs, leaves };
}
// The tree whose lowest log is (x, y, z): {logs, leaves, base} or null.
function treeAt(x, y, z) {
  if (!isLog(get(x, y, z)) || isLog(get(x, y - 1, z)) || !isSoil(get(x, y - 1, z))) return null;
  const t = collectTree([[x, y, z]], y);
  if (t) t.base = [x, y, z];
  return t;
}
// A log at (x, y, z) was broken: the part of a natural tree above it comes down too, leaves included (as the mod's felling does), unless
// it still stands on soil somewhere else (a second trunk). Returns the felled tree or null.
function fallAbove(x, y, z, drops) {
  const seeds = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) seeds.push([x + dx, y + 1, z + dz]);
  const t = collectTree(seeds, y + 1);
  if (!t) return null;
  for (const [lx, ly, lz] of t.logs) { const below = get(lx, ly - 1, lz); if (!isLog(below) && !isLeaf(below) && below !== 0 && !isPlant(below)) return null; }   // resting on something: still standing
  t.base = [x, y, z];
  fell(null, t, drops);
  return t;
}
function fell(m, tree, drops = true) {
  const world = W(), D = drops ? BF.drops : null;
  const take = (x, y, z) => {
    const id = get(x, y, z);
    if (!id) return;
    world.setBlock(x, y, z, 0);
    if (D && BF.rollDrops) D.spawnAt(BF.rollDrops(id), x, y, z);
  };
  tree.logs.slice().sort((a, b) => b[1] - a[1]).forEach(([x, y, z]) => take(x, y, z));   // top to bottom, as the mod
  tree.leaves.forEach(([x, y, z]) => take(x, y, z));
  if (BF.audio && BF.audio.blockSound) { try { BF.audio.blockSound("break", get(tree.base[0], tree.base[1], tree.base[2]) || BF.B.oak_log, tree.base[0], tree.base[1], tree.base[2], 0.8); } catch (e) { /* optional */ } }
}

// ---------------------------------------------------------------- the forester's day
const state = m => m.fo || (m.fo = { task: null, plantCd: rnd(2, 8), cutCd: rnd(4, 12), gatherCd: 0, t: 0, nav: { navWait: 0, navFail: 0 }, chop: 0, claim: null });
const freeSlots = m => m.inv.reduce((n, s) => n + (s ? 0 : 1), 0);
const holdsSapling = m => { for (const s of m.inv) if (s && /_sapling$/.test(BF.items[s.id].name)) return s; return null; };
const claims = new Map();   // "x,y,z" of a tree base or a drop -> villager, so two foresters do not go for the same tree
const centre = m => (m.village ? { x: m.village.x, z: m.village.z } : { x: m.position.x, z: m.position.z });
const inHome = (m, x, z) => { const c = centre(m); return Math.hypot(x - c.x, z - c.z) <= HOME_R; };

function findSpot(m) {
  const pos = m.position, px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z);
  // doors, and columns holding anything built (not landscape; dirt paths and farmland's crops aside, farmland itself counts), scanned once
  const doors = [], R = SEARCH + DOOR_AVOID, DP = BF.B.dirt_path, FL = BF.B.farmland, S = 2 * R + 1, built = new Uint8Array(S * S);
  for (let x = px - R; x <= px + R; x++) for (let z = pz - R; z <= pz + R; z++) {
    if (!W().isLoaded(x, z)) continue;
    for (let y = py - PLANT_DY - 4; y <= py + PLANT_DY + 6; y++) {
      const id = get(x, y, z);
      if (id === 0 || id === DP || isSap(id)) continue;
      if (isDoor(id)) doors.push([x, y, z]);
      if (id === FL || builtBlock(id)) built[(z - pz + R) * S + (x - px + R)] = 1;
    }
  }
  const nearBuilt = (x, z) => {
    for (let dz = -BUILD_AVOID; dz <= BUILD_AVOID; dz++) for (let dx = -BUILD_AVOID; dx <= BUILD_AVOID; dx++) {
      if (dx * dx + dz * dz > BUILD_AVOID * BUILD_AVOID) continue;
      const u = x + dx - px + R, v = z + dz - pz + R;
      if (u >= 0 && v >= 0 && u < S && v < S && built[v * S + u]) return true;
    }
    return false;
  };
  const near = (x, y, z, list, d2) => { for (const o of list) { const dx = o[0] - x, dy = o[1] - y, dz = o[2] - z; if (dx * dx + dy * dy + dz * dz <= d2) return true; } return false; };
  const cands = [];
  for (let x = px - SEARCH; x <= px + SEARCH; x++) for (let z = pz - SEARCH; z <= pz + SEARCH; z++) {
    if (!W().isLoaded(x, z) || !inHome(m, x + 0.5, z + 0.5)) continue;
    for (let y = py - PLANT_DY; y <= py + PLANT_DY; y++) {
      if (get(x, y, z) !== 0 || get(x, y - 1, z) === BF.B.farmland || !isSoil(get(x, y - 1, z))) continue;
      let clear = true;
      for (let k = 1; k <= CLEAR_ABOVE && clear; k++) if (get(x, y + k, z) !== 0) clear = false;
      if (clear) cands.push([x, y, z]);
    }
  }
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  for (const [x, y, z] of cands) {
    if (claims.has(pk(x, y, z)) && claims.get(pk(x, y, z)) !== m) continue;
    if (near(x, y, z, doors, DOOR_AVOID * DOOR_AVOID) || nearBuilt(x, z)) continue;
    let tooClose = false;
    for (const s of saps.values()) if (Math.abs(s.x - x) <= SAP_SPACING && Math.abs(s.z - z) <= SAP_SPACING && Math.abs(s.y - y) <= 2) { tooClose = true; break; }
    if (!tooClose) return { x, y, z };
  }
  return null;
}
// Trees within 40 blocks (and 64 of the village centre). Candidates are ranked by distance times a random factor of 0.5 to 2, so a near tree
// usually wins but a farther one sometimes does (two foresters do not all go for the same trunk).
const notTree = new Map();   // "x,y,z" of log bases that are not trees -> sim time until which they are skipped
function findTree(m) {
  const pos = m.position, px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z), cands = [], c = centre(m);
  for (let x = px - CUT_SEARCH; x <= px + CUT_SEARCH; x++) for (let z = pz - CUT_SEARCH; z <= pz + CUT_SEARCH; z++) {
    const d = Math.hypot(x + 0.5 - pos.x, z + 0.5 - pos.z);
    if (d > CUT_SEARCH || Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) > CUT_HOME || !W().isLoaded(x, z)) continue;
    for (let y = py - CUT_Y_DOWN; y <= py + CUT_Y_UP; y++) if (isLog(get(x, y, z)) && !isLog(get(x, y - 1, z))) cands.push([x, y, z, d * (0.5 + 1.5 * Math.random())]);
  }
  cands.sort((a, b) => a[3] - b[3]);
  const now = nowS();
  let tested = 0;
  for (const [x, y, z] of cands) {
    const k = pk(x, y, z), o = claims.get(k);
    if (o && o !== m && !o.dead && !o.removed) continue;
    if ((notTree.get(k) || 0) > now) continue;          // a building's log pillar, checked a minute ago
    if (++tested > 40) break;
    const t = treeAt(x, y, z);
    if (t) return t;
    notTree.set(k, now + 60);
  }
  if (notTree.size > 4000) for (const [k, t] of notTree) if (t <= now) notTree.delete(k);
  return null;
}
const WANT = id => {   // what a forester picks up (the mod's wantsToPickUp)
  const it = BF.items[id]; if (!it) return false;
  const n = it.name;
  return n === "emerald" || n === "stick" || n === "apple" || /_sapling$/.test(n) || /_(log|wood)$/.test(n);
};
// The nearest wanted drop: within SWEEP_R of the felled tree while sweeping (F.sweep), else within GATHER_R of the forester.
// `young` counts wanted drops there that are still falling (they are waited for, not skipped).
function findDrop(m, F) {
  const D = BF.drops && BF.drops.list;
  F.young = 0;
  if (!D || !D.length) return null;
  const sw = F.sweep, R = sw ? SWEEP_R : GATHER_R;
  let best = null, bd = Infinity;
  for (const d of D) {
    if (!WANT(d.id) || (F.skip && F.skip.has(d))) continue;
    const ox = sw ? sw.x + 0.5 : m.position.x, oz = sw ? sw.z + 0.5 : m.position.z;
    if (Math.hypot(d.pos.x - ox, d.pos.z - oz) > R) continue;
    if (d.age < 0.8) { F.young++; continue; }
    if (!T().inv.canFit(m.inv, [{ id: d.id, n: 1 }], [])) continue;
    const dx = d.pos.x - m.position.x, dz = d.pos.z - m.position.z, dy = d.pos.y - m.position.y, q = dx * dx + dz * dz + dy * dy * 0.25;
    if (q < bd) { bd = q; best = d; }
  }
  return best;
}

// walking: legs of at most 20 blocks, like js/explorer.js
function travel(m, st, dt, out, tx, ty, tz, speed, radius, dyTol = 2.6) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z, d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
  if (d <= radius && Math.abs(ty - m.position.y) <= dyTol) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "fo") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const r = Math.max(1, Math.floor(radius / 1.42));   // any cell this close to the target is within `radius` of its centre
    const goal = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: (x, y, z) => Math.abs(x - tx) <= r && Math.abs(z - tz) <= r && Math.abs(y - ty) <= Math.floor(dyTol) };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && !path.length) { st.navFail = 0; return "arrived"; }   // already standing on a goal cell
    if (path) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "fo"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}

function endTask(m, F, ok) {
  const t = F.task;
  if (t) {
    if (t.claim) claims.delete(t.claim);
    if (t.kind === "plant") F.plantCd = PLANT_CD;
    else if (t.kind === "cut") F.cutCd = CUT_CD;
    else if (t.kind === "gather") { if (!ok && F.sweep) { const n = F.tries || (F.tries = new WeakMap()), c = (n.get(t.drop) || 0) + 1; n.set(t.drop, c); if (c >= 2) (F.skip || (F.skip = new WeakSet())).add(t.drop); } else F.gatherCd = ok ? 0 : 6; }   // an item it cannot reach twice is left
  }
  F.task = null; F.t = 0; F.chop = 0; m.ai.route = null;
}
function plantAt(m, t) {
  const slot = holdsSapling(m);
  if (!slot || !canSurvive(t.x, t.y, t.z) || get(t.x, t.y, t.z) !== 0) return false;
  const name = BF.items[slot.id].name, id = BF.B[name];
  W().setBlock(t.x, t.y, t.z, id);
  T().inv.remove(m.inv, slot.id, 1);
  addSap(t.x, t.y, t.z, id);
  if (BF.audio && BF.audio.blockSound) { try { BF.audio.blockSound("place", id, t.x, t.y, t.z, 0.6); } catch (e) { /* optional */ } }
  if (BF.emit) BF.emit("blockPlaced", t.x, t.y, t.z, id);
  log("plant", m, { at: [t.x, t.y, t.z], sapling: name });
  return true;
}

// Sawing: up to SAW_DAY logs a day become 4 planks each (js/trading.js sells both). It keeps 2 logs of every species unsawn for sale, stops at 128 planks.
const SAW_DAY = 8, SAW_KEEP = 2, PLANK_CAP = 128;
const plankName = sp => (sp === "oak" ? "planks" : sp + "_planks");
function saw(m, F) {
  const day = BF.sky ? BF.sky.day || 0 : 0;
  if (F.sawDay !== day) { F.sawDay = day; F.sawn = 0; }
  if (F.sawn >= SAW_DAY) return;
  const inv = T().inv, I = BF.I;
  for (const sp of SPECIES) {
    const lg = I[sp + "_log"], pl = I[plankName(sp)];
    if (lg == null || pl == null) continue;
    while (F.sawn < SAW_DAY && inv.count(m.inv, lg) > SAW_KEEP && inv.count(m.inv, pl) <= PLANK_CAP - 4 && inv.canFit(m.inv, [{ id: pl, n: 4 }], [{ id: lg, n: 1 }])) {
      inv.remove(m.inv, lg, 1); inv.add(m.inv, pl, 4); F.sawn++;
      log("saw", m, { log: sp + "_log" });
    }
  }
}

function ai(m, dt, out) {
  if (m.profession !== "forester" || !m.inv || m.dead || m.child || !m.village || !m.jobsite || !BF.mobs || !BF.mobs.nav || !W()) return false;
  const F = state(m), a = m.ai, t = skyT();
  if (t < WORK_START || t >= WORK_END || m.tradingWith || m.sleeping) { if (F.task) endTask(m, F, false); return false; }
  F.plantCd -= dt; F.cutCd -= dt; F.gatherCd -= dt;
  if (!F.task) {
    F.thinkT = (F.thinkT || 0) - dt;
    if (F.thinkT > 0) return false;
    F.thinkT = 1;
    let task = null;
    if (F.sweep && (nowS() > F.sweep.until || freeSlots(m) === 0)) { log("swept", m, { why: freeSlots(m) ? "time" : "full" }); F.sweep = null; F.skip = null; F.tries = null; }
    const drop = F.gatherCd <= 0 || F.sweep ? findDrop(m, F) : null;
    if (drop) task = { kind: "gather", drop, x: Math.floor(drop.pos.x), y: Math.floor(drop.pos.y), z: Math.floor(drop.pos.z), max: GATHER_R * 3 };
    else if (F.sweep && F.young) { F.thinkT = 0.3; a.mode = "idle"; a.t = 1; return true; }       // items still falling: wait for them
    else if (F.sweep) { log("swept", m, { why: "clear" }); F.sweep = null; F.skip = null; F.tries = null; }
    if (!task && !F.sweep) {
      const opts = [];
      if (F.plantCd <= 0 && holdsSapling(m)) { const s = findSpot(m); if (s) opts.push([W_PLANT, { kind: "plant", x: s.x, y: s.y, z: s.z, max: PLANT_MAX, claim: pk(s.x, s.y, s.z) }]); else F.plantCd = 5; }
      if (F.cutCd <= 0 && freeSlots(m) >= MIN_FREE) { const tr = findTree(m); if (tr) opts.push([W_CUT, { kind: "cut", tree: tr, x: tr.base[0], y: tr.base[1], z: tr.base[2], max: CUT_MAX + 2.5 * Math.hypot(tr.base[0] + 0.5 - m.position.x, tr.base[2] + 0.5 - m.position.z), claim: pk(tr.base[0], tr.base[1], tr.base[2]) }]); else F.cutCd = 8; }
      if (opts.length) { let r = Math.random() * opts.reduce((s, o) => s + o[0], 0); for (const [w, o] of opts) { if ((r -= w) < 0) { task = o; break; } } task = task || opts[0][1]; }
    }
    if (!task) return false;
    if (F.sweep) F.thinkT = 0.2;
    F.task = task; F.t = 0; F.chop = 0; F.nav.navFail = 0; F.nav.navWait = 0;
    if (task.claim) claims.set(task.claim, m);
    log("start", m, { task: task.kind, at: [task.x, task.y, task.z] });
  }
  const k = F.task;
  F.t += dt;
  if (F.t > k.max) { log("giveup", m, { task: k.kind, why: "too slow" }); endTask(m, F, false); return true; }
  a.mode = "idle"; a.t = 2;
  const reach = k.kind === "plant" ? PLANT_REACH : k.kind === "cut" ? CUT_REACH : 1.6;
  if (k.kind === "gather" && (!BF.drops.list.includes(k.drop))) { endTask(m, F, true); return true; }
  if (k.kind === "gather") { k.x = Math.floor(k.drop.pos.x); k.y = Math.floor(k.drop.pos.y); k.z = Math.floor(k.drop.pos.z); }
  const dist = Math.hypot(k.x + 0.5 - m.position.x, k.z + 0.5 - m.position.z);
  if (dist > reach || (k.kind !== "gather" && Math.abs(k.y - m.position.y) > 3.2)) {
    const r = travel(m, F.nav, dt, out, k.x, k.y, k.z, m.def.speed * 1.1, reach, k.kind === "gather" ? 4.5 : 2.6);   // it reaches up for items caught in leaves
    if (r === "failed") { log("giveup", m, { task: k.kind, why: "no path", at: [k.x, k.y, k.z] }); endTask(m, F, false); return true; }
    if (r !== "arrived") return true;
  }
  a.route = null;
  out.faceX = k.x + 0.5; out.faceZ = k.z + 0.5; m.lookAt = null;
  if (k.kind === "plant") { const ok = plantAt(m, k); if (ok) a.swingT = 0.35; else log("giveup", m, { task: "plant", why: "spot changed" }); endTask(m, F, ok); }
  else if (k.kind === "gather") {
    const d = k.drop, left = T().inv.add(m.inv, d.id, d.count);
    if (left < d.count) log("pickup", m, { got: (d.count - left) + " " + BF.items[d.id].name });
    const ok = left < d.count;
    if (left > 0) d.count = left; else BF.drops.remove(d);
    for (const o of BF.drops.list.slice()) {                                  // and whatever else lies at its feet
      if (o === d || !WANT(o.id) || o.age < 0.8 || Math.hypot(o.pos.x - m.position.x, o.pos.z - m.position.z) > 1.6) continue;
      const l2 = T().inv.add(m.inv, o.id, o.count);
      if (l2 > 0) o.count = l2; else BF.drops.remove(o);
    }
    endTask(m, F, ok);
  } else {   // cut
    F.chop += dt;
    if (a.swingT <= 0) a.swingT = 0.35;
    if (F.chop >= CHOP_T) {
      const tr = k.tree, bx = tr.base;
      if (!isLog(get(bx[0], bx[1], bx[2]))) { endTask(m, F, false); return true; }
      tr.logs = tr.logs.filter(([x, y, z]) => isLog(get(x, y, z)));
      tr.leaves = tr.leaves.filter(([x, y, z]) => isLeaf(get(x, y, z)));
      fell(m, tr);
      log("fell", m, { at: bx, logs: tr.logs.length, leaves: tr.leaves.length });
      F.sweep = { x: bx[0], z: bx[2], until: nowS() + SWEEP_MAX }; F.skip = null; F.tries = null; F.thinkT = 0.8;   // now pick up everything that fell
      endTask(m, F, true);
    }
  }
  return true;
}

// Trade-screen status line.
function statusText(m) {
  if (!m || m.profession !== "forester") return "";
  const s = m.fo && m.fo.task;
  if (s) return s.kind === "plant" ? "planting a sapling" : s.kind === "cut" ? "felling a tree" : "picking things up";
  return holdsSapling(m) ? "has saplings to plant" : "looking for saplings";
}

BF.forester = { ai, statusText, canSurvive, growTree, treeAt, fallAbove, findTree, findSpot, shape, saplings: saps, SPECIES, LOG, _test: { fell, plantAt, growTick, findDrop, state, builtBlock } };
})();
