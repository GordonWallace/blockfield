// Wild mobs live in the world, not around the player (BF.wildlife; idea-037, release 1.3). Loaded after js/mobs.js, js/mobsave.js and the
// animal modules; hooks live in mobs.js (chunk unload, mobs that walk off loaded land, monster spawn checks, update), mobsave.js (wild mobs of
// a loaded save), villagesim.js (areas) and save.js ("wildlife").
//  - Storing: a wild mob (BF.mobs.isWild) in a chunk that unloads is stored with that chunk and the game time. When the chunk loads again
//    within a game hour it comes back on the same spot doing what it was doing; after that, at a random standable spot of its kind within
//    RELOCATE_R blocks (grass for animals, dark for monsters). A zombie or skeleton stored under open sky whose chunk stayed unloaded through
//    daylight is gone: it would have burned. Nothing else is ever removed: wild mobs leave only by dying or being taken into a village.
//  - Animals: a chunk rolls for animals once, the first time it loads (HABITAT, by the biome at its centre): one group of GROUP on its grass
//    with a quarter of the habitat's summed odds. Herds clump by kind: each ZONE x ZONE-chunk region favours one kind per habitat (picked
//    from the seed and the region, weighted by the habitat's odds), and every group rolled there is of that kind, so finding each kind takes
//    some travel. Chunks of saves from before this change roll the first time they load too. Nothing else spawns animals; they breed.
//  - Wild breeding: two wild adults of a kind on grass within BREED_R blocks may breed on their own: each adult gets one roll a game day
//    (PAIR_P, so about BREED_CHANCE a pair), never while CROWD_MAX of its kind are within CROWD_R blocks. A roll makes the pair willing,
//    and the animal's own module walks them together (js/shepherd.js, poultry.js, cowherd.js, pigfarmer.js).
//  - Monsters (spawned by js/mobs.js spawnMonsters in any loaded chunk): mayHostile refuses a spot whose area already holds its cap (CAP
//    per CAP_CHUNKS chunks, counted per area: each running village with its margin, each trip corridor, each group of villager windows,
//    and the player's surroundings), or within BUFFER blocks of the player, a villager or an iron golem.
//  - Village nights: per village, whether a zombie got into the village, zombie attacks on its villagers and villager deaths, for the last
//    NIGHTS nights (debug screen village panel; the balance soak).
// API: BF.wildlife = { init, update(dt), stow(m), adopt(entries, t), mayHostile(x, y, z), spawned(m), villageStats(rec), areas(), stored(),
//                      rolledCount(), counts(), serialize(), deserialize(o), reset(), HABITAT, ... }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const HOUR = 1 / 24;           // game days: a chunk back within this brings its mobs back exactly
const RELOCATE_R = 8;          // blocks: how far a mob may have wandered by the time a chunk that was away longer comes back
const GROUP = [4, 8];          // animals per first-generation group
const ZONE = 4;                // chunks per side of a region whose groups are all of one kind
const ROLLS_PER_STEP = 6;      // chunks rolled per update at most
const BREED_R = 8, BREED_CHANCE = 0.1, CROWD_R = 24, CROWD_MAX = 8;
const WQ = {};
const PAIR_P = 1 - Math.sqrt(1 - BREED_CHANCE);   // each adult rolls once a day: about BREED_CHANCE for a pair
const tune = { pairP: PAIR_P };                    // tests may raise it
const CAP = 10, CAP_CHUNKS = 28, BUFFER = 12;
const NIGHTS = 7;
// Starting odds per chunk of a group of each kind, by worldgen biome id (js/worldgen.js NAMES). Desert, ocean, beach, river, swamp, jungle,
// badlands, mountain peaks, mushroom fields and frozen ocean have none; wild horse herds are js/horses.js's own.
// The spec's starting odds (plains 25% cows, 25% sheep, 20% chickens, 15% pigs; woods 20% pigs, 15% chickens, 10% sheep; snow 10% sheep) gave
// about 2.5 animals a chunk, several hundred in a loaded area; tuned to a third of those (closer to vanilla's density). These are now relative
// weights: a chunk gets one group of the region's kind with a quarter of the summed odds, groups twice as big, so half as many animals
// (Gordon, 2026-10-12: simulation speed, and herds you have to look for).
const OPEN = [["cow", 0.08], ["sheep", 0.08], ["chicken", 0.07], ["pig", 0.05], ["horse", 0.04]];
const WOODS = [["pig", 0.07], ["chicken", 0.05], ["sheep", 0.03]];
const SNOW = [["sheep", 0.03]];
const HABITAT = { 5: OPEN, 14: OPEN, 22: OPEN, 6: WOODS, 7: WOODS, 8: WOODS, 9: WOODS, 17: WOODS, 18: WOODS, 23: WOODS, 19: SNOW, 20: SNOW, 21: SNOW, 25: SNOW };
const ST = { sheep: "sheep", chicken: "hen", cow: "cow", pig: "pig", horse: "horse" };   // where each animal module keeps its state on the mob (a horse: its record)
// A wild animal: BF.mobs.isWild, or a horse no one owns, on no lead and in no paddock (horses keep their own records: js/horses.js)
const wildAnimal = m => BF.mobs.isWild(m) || (m.type === "horse" && !!m.horse && !m.horse.tamed && !m.horse.owner && !m.horse.lead && !m.horse.pen && !m.rider);

const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const live = o => !!(o && !o.dead && !o.removed);
const ck = (x, z) => Math.floor(x / BF.CS) + "," + Math.floor(z / BF.CS);
const R = e => BF.rand.of(e);   // seeded random streams (js/rand.js)
const rnd = (r, a, b) => r.range(a, b);
const irnd = (r, a, b) => a + r.int(b - a + 1);
// Clusters (spec r15-39b, C2: js/ctick.js): with the cluster tick on, update runs once per cluster and handles its own chunks only (a
// chunk is the cluster's of its region: BF.mobs.cl), its monster areas are its own chunks' (worked out once an interval), its timers go by
// the tick counter, and the chunk and village tables that last (rolled, stored, nights) are registered with BF.ctick.owned.
const CL = () => BF.mobs.cl;
const clustered = () => !!(BF.mobs.cl && BF.mobs.cl.owned());
const chunkBase = k => { const i = k.indexOf(","), CS = BF.CS; return CL().baseAt({ x: (+k.slice(0, i) + 0.5) * CS, z: (+k.slice(i + 1) + 0.5) * CS }); };
const ownChunk = k => CL().ownsBase(chunkBase(k));

let rolled = new Set();        // chunk keys that had their first-generation roll
const toRoll = new Set();      // loaded chunks still to roll
let stored = new Map();        // chunk key -> [packed wild mob + {t, open}]
const toRestore = new Set();   // loaded chunks with stored mobs waiting
let nights = new Map();        // village key -> Map(night -> [reached 0|1, zombie attacks, deaths])
let hooked = false;
const LOG = [];
const log = (kind, data) => { LOG.push(BF.glog.job("wildlife", Object.assign({ kind, day: +dayNow().toFixed(3) }, data))); if (LOG.length > 300) LOG.shift(); };

// ---------------------------------------------------------------- storing and bringing back
// Daylight that would burn an undead mob under open sky somewhere in game time (t0, t1]?
function daylightBetween(t0, t1) {
  if (!(t1 > t0)) return false;
  if (t1 - t0 >= 1) return true;
  const L = BF.sky && BF.sky.lightAt;
  for (let t = t0; t <= t1; t += 0.004) { const f = ((t % 1) + 1) % 1; if (f < 0.5 && (!L || L(f) > 0.55)) return true; }
  return false;
}
function stow(m) {
  if (!BF.mobSave || !m || !m.position) return;
  const e = BF.mobSave.packWild(m);
  e.t = dayNow();
  if (m.def && m.def.burns && BF.mobs.skyOpen(m.position.x, m.position.y + m.height - 0.1, m.position.z)) e.open = 1;
  const k = ck(m.position.x, m.position.z);
  const a = stored.get(k);
  if (a) a.push(e); else stored.set(k, [e]);
  log("stored", { type: m.type, chunk: k });
}
// Wild mobs of a loaded save (js/mobsave.js): each waits with its chunk, saved at game time t.
function adopt(entries, t) {
  for (const e of entries || []) {
    if (!e || !e.type || !e.snap || !Array.isArray(e.snap.p)) continue;
    e.t = t;
    const k = ck(e.snap.p[0], e.snap.p[2]);
    const a = stored.get(k);
    if (a) a.push(e); else stored.set(k, [e]);
    if (BF.world && BF.world.chunks.has(k)) toRestore.add(k);
  }
}
const isAnimal = type => !!ST[type];
// A random standable spot of the mob's kind within RELOCATE_R blocks of (x, y, z), on loaded land: grass for animals, block light 7 or less
// for monsters (and no open sky while it is light). null when none was found.
function relocate(type, x, y, z) {
  const W = BF.world, T = BF.mobs.typeDef(type);
  if (!T) return null;
  const grass = BF.B.grass, dark = BF.sky && BF.sky.lightAt ? BF.sky.lightAt(BF.sky.time || 0) <= 0.3 : false;
  const pens = isAnimal(type) && BF.mobs.penBoxes ? BF.mobs.penBoxes(x, z) : [];   // never into a village's pen, coop, pasture, sty or stable
  const r = BF.rand.at("relocate " + type, x, z, null, y);
  for (let i = 0; i < 40; i++) {
    const a = r.next() * Math.PI * 2, d = Math.sqrt(r.next()) * (RELOCATE_R - 1);   // within RELOCATE_R blocks (the block centre too)
    const sx = Math.floor(x + Math.cos(a) * d), sz = Math.floor(z + Math.sin(a) * d);
    if (!W.isLoaded(sx, sz)) continue;
    if (isAnimal(type)) {
      const gy = W.heightAt(sx, sz);
      if (W.getBlock(sx, gy, sz) !== grass || BF.mobs.inPenBox(pens, sx, sz) || !BF.mobs.standable(sx, gy + 1, sz, T.hw, T.h)) continue;
      return [sx + 0.5, gy + 1, sz + 0.5];
    }
    for (const dy of [0, 1, -1, 2, -2, 3, -3]) {   // near its old height first: a cave monster stays in its cave
      const sy = Math.floor(y) + dy;
      if (!BF.mobs.standable(sx, sy, sz, T.hw, T.h) || W.getBlockLight(sx, sy, sz) > 7) continue;
      if (!dark && !BF.mobs.skyDark(sx, sy, sz)) continue;   // by day only where a monster could spawn
      return [sx + 0.5, sy, sz + 0.5];
    }
  }
  return null;
}
function bring(e) {
  const s = e.snap, now = dayNow(), age = now - (e.t != null ? e.t : now);
  const T = BF.mobs.typeDef(e.type);
  if (!T) return null;
  if (e.open && T.burns && daylightBetween(e.t, now)) { log("burned", { type: e.type }); return null; }   // it would have burned while away
  const exact = age >= -1e-6 && age < HOUR;
  const free = BF.mobs.standable(Math.floor(s.p[0]), Math.floor(s.p[1] + 0.01), Math.floor(s.p[2]), T.hw, T.h);   // nothing built over its spot
  const at = (exact ? (free ? s.p : null) : relocate(e.type, s.p[0], s.p[1], s.p[2])) || BF.mobs.findStand(s.p[0], s.p[1], s.p[2], e.type) || s.p;
  const m = BF.mobs.spawn(e.type, at[0], at[1], at[2], e.variant, e.style);
  if (!m) return null;
  BF.mobSave.apply(m, s);
  BF.mobSave.applyState(m, e);
  m.position.set(at[0], at[1], at[2]); m.fallStart = at[1];
  if (!exact) { m.ai.mode = "idle"; m.ai.t = rnd(R(m), 1, 3); m.ai.tx = at[0]; m.ai.tz = at[2]; m.ai.route = null; m.ai.target = false; }
  log(exact ? "back" : "moved", { type: e.type, age: +(age * 24).toFixed(2) });
  return m;
}
function restore(k) {
  const a = stored.get(k);
  stored.delete(k);
  if (a) for (const e of a) {
    const T = BF.mobs.typeDef(e.type);
    if (T && T.spawns === false) continue;   // a monster switched off in the world (js/gameopts.js)
    try { bring(e); } catch (err) { console.error(err); }
  }
}

// ---------------------------------------------------------------- first-generation animals
function roll(k) {
  rolled.add(k);
  const [cx, cz] = k.split(",").map(Number), CS = BF.CS;
  let b = null;
  try { b = BF.worldgen.biomeAt(cx * CS + 8, cz * CS + 8); } catch (e) { return; }
  const tbl = b && HABITAT[b.id];
  if (!tbl) return;
  const sum = tbl.reduce((t, e) => t + e[1], 0);
  const r = BF.rand.at("wild", cx, cz, BF.glog ? Math.floor(BF.glog.chunkDays(cx * CS + 8, cz * CS + 8)) : 0);   // keyed by the chunk and its loaded days, not the load time
  if (r.next() >= sum / 4) return;
  const type = zoneKind(tbl, sum, Math.floor(cx / ZONE), Math.floor(cz / ZONE));
  const n = BF.mobs.spawnGroup(type, cx, cz, irnd(r, GROUP[0], GROUP[1]), r);
  if (n) log("rolled", { type, n, chunk: k, biome: b.name });
}
// The kind a region's groups of this habitat are: a fixed pick from the seed and the region, weighted by the habitat's odds.
function zoneKind(tbl, sum, rx, rz) {
  let h = (Math.imul(rx, 0x27d4eb2d) ^ Math.imul(rz, 0x165667b1) ^ Math.imul(((BF.state && BF.state.seed) | 0) + tbl.length, 0x61c88647)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = (h ^ (h >>> 13)) >>> 0;
  let r = (h / 4294967296) * sum;
  for (const [type, p] of tbl) if ((r -= p) < 0) return type;
  return tbl[tbl.length - 1][0];
}

// ---------------------------------------------------------------- wild breeding
const onGrass = m => BF.world.getBlock(Math.floor(m.position.x), Math.floor(m.position.y + 0.01) - 1, Math.floor(m.position.z)) === BF.B.grass;
const stOf = m => m[ST[m.type]];
const adult = m => { const s = stOf(m); return !!(s && s.growAt == null); };
function breedable(m, t) {
  const s = stOf(m);
  return !!(s && s.growAt == null && t >= (s.cd || 0) && (s.fed == null || t - s.fed >= 1) && wildAnimal(m) && !m.ledBy && onGrass(m));
}
function wildBreeding() {
  const t = dayNow(), byType = {};
  // (spec r15-31) each kind's mobs from BF.mobs.ofType, the kinds in the order a scan of the whole list meets them
  const kinds = [];
  for (const k in ST) { const a = BF.mobs.ofType(k).filter(m => live(m) && wildAnimal(m)); if (a.length) kinds.push([k, a, BF.mobs.list.indexOf(a[0])]); }
  kinds.sort((a, b) => a[2] - b[2]);
  for (const [k, a] of kinds) byType[k] = a;
  for (const type in byType) {
    const a = byType[type];
    for (const m of a) {
      if (!stOf(m)) continue;   // its module hasn't set it up yet
      const w = m.wildB || (m.wildB = { next: Math.floor(t) + R(m).next() });
      if (w.next > t + 2) w.next = Math.floor(t) + R(m).next();   // time was set back
      if (t < w.next) continue;
      w.next = Math.floor(t) + 1 + R(m).next();                  // one roll a game day, at a different time each day
      if (!breedable(m, t)) continue;
      let mate = null, md = BREED_R * BREED_R, crowd = 0;
      // (spec r15-31) a's animals within CROWD_R of m, from the region index; in tests checked against a itself
      // (through a face edge, bug-091: o seen from m's frame)
      const d2Of = o => { const q = BF.planet.local(m.position, o.position, WQ); return (q.x - m.position.x) ** 2 + (q.z - m.position.z) ** 2; };
      const close = L => L.filter(o => o.type === type && live(o) && wildAnimal(o) && d2Of(o) <= CROWD_R * CROWD_R);
      for (const o of BF.mobs.checkScan("wildlife.breed", close(BF.mobs.near(m.position, CROWD_R, true)), () => close(a))) {
        const d2 = d2Of(o);
        if (d2 <= CROWD_R * CROWD_R) crowd++;
        if (o !== m && d2 < md && Math.abs(o.position.y - m.position.y) < 3 && breedable(o, t)) { md = d2; mate = o; }
      }
      if (!mate || crowd >= CROWD_MAX || R(m).next() >= tune.pairP) continue;
      stOf(m).fed = t; stOf(mate).fed = t;   // willing, as if fed: the animal's own module walks them together and the young one appears
      log("wildPair", { type, crowd });
    }
  }
}

// ---------------------------------------------------------------- monster areas, caps and the buffer
let areaList = [], areaOf = new Map(), areasT = 0;
let targets = new Map(), targetsDirty = true;   // villagers and golems by chunk, rebuilt at most once a frame when a spawn is checked
// the areas in force: the world's, or with clusters the running cluster's (its own chunks; worked out at its first use in an interval)
function areasNow() {
  if (!clustered()) { if (!areaList.length) rebuildAreas(); return { list: areaList, of: areaOf }; }
  return BF.ctick.local("wildlife.areas", () => { const own = BF.world.clusterCells.groupChunks(BF.ctick.cur.key); return buildAreas(new Set(own.map(c => c.key)), own); });
}
function rebuildAreas() { const o = buildAreas(null); areaList = o.list; areaOf = o.of; }
// (mine: with clusters the running cluster's chunk keys, and own those chunks in world.chunks order)
function buildAreas(mine, own) {
  const areaList = [], areaOf = new Map();
  const W = BF.world, VS = BF.villageSim;
  if (VS && VS.areas) for (const a of VS.areas()) {
    const idx = areaList.length, A = { kind: a.kind, key: a.key, n: 0, h: 0, cap: 0 };
    for (const k of a.keys) if (!areaOf.has(k) && W.chunks.has(k) && (!mine || mine.has(k))) { areaOf.set(k, idx); A.n++; }
    if (A.n) areaList.push(A); else continue;
  }
  const P = { kind: "player", key: "player", n: 0, h: 0, cap: 0 }, pi = areaList.length;
  for (const k of own ? own.map(c => c.key) : W.chunks.keys()) if (!areaOf.has(k)) { areaOf.set(k, pi); P.n++; }
  areaList.push(P);
  // monsters switched off in the world (js/gameopts.js): the cap shrinks by their share of the spawn weights and only monsters that are on
  // count, so turning creepers off leaves zombies' numbers as they were
  const share = BF.mobs.spawnShare(), on = t => BF.mobs.typeDef(t).spawns !== false;
  for (const A of areaList) A.cap = Math.max(1, Math.round(CAP * A.n / CAP_CHUNKS)) * share;
  for (const t of BF.mobs.types) if (BF.mobs.typeDef(t).hostile && on(t)) for (const m of BF.mobs.ofType(t)) if (m.hostile && live(m)) { const i = areaOf.get(ck(m.position.x, m.position.z)); if (i != null) areaList[i].h++; }
  return { list: areaList, of: areaOf };
}
function rebuildTargets() {
  targets = new Map();
  const f = BF.ctick && BF.ctick.on ? BF.ctick.filter : null;
  for (const m of (f && BF.ctick.mobs()) || BF.mobs.list) {   // (clusters: the running group's own, js/ctick.js mobs)
    if (!live(m) || !(m.type === "villager" || (m.def && m.def.golem)) || (f && !f(m))) continue;
    const k = ck(m.position.x, m.position.z), a = targets.get(k);
    if (a) a.push(m); else targets.set(k, [m]);
  }
}
// May a monster spawn at (x, y, z)? Its area under the cap, and nothing monsters target within BUFFER blocks.
function mayHostile(x, y, z) {
  const AR = areasNow(), i = AR.of.get(ck(x, z)), A = AR.list[i != null ? i : AR.list.length - 1];
  if (A && A.h >= A.cap) return false;
  const c = clustered(), p = c ? CL().playerPos() : BF.player && BF.player.position;   // (clusters: as the running cluster sees the player)
  const q = p && BF.planet.local({ x, z }, p);   // (across a face edge: seen from the spot)
  if (p && (c ? CL().playerLives() : !BF.player.dead) && Math.hypot(q.x - x, p.y - y, q.z - z) < BUFFER) return false;
  // villagers and golems within BUFFER: from the region index (spec r15-31); in tests checked against the chunk table it replaced
  const guard = o => live(o) && (o.type === "villager" || (o.def && o.def.golem)) && Math.abs(o.position.x - x) < BUFFER && Math.abs(o.position.z - z) < BUFFER && Math.hypot(o.position.x - x, o.position.y - y, o.position.z - z) < BUFFER;
  const M = BF.mobs, got = M.near({ x, z }, BUFFER).some(guard);
  return !M.checkScan("wildlife.buffer", got, () => {
    if (targetsDirty) { targetsDirty = false; rebuildTargets(); }
    const cx = Math.floor(x / BF.CS), cz = Math.floor(z / BF.CS);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = targets.get((cx + dx) + "," + (cz + dz));
      if (a) for (const o of a) if (guard(o)) return true;
    }
    return false;
  });
}
function spawned(m) {
  const AR = areasNow(), i = AR.of.get(ck(m.position.x, m.position.z));
  const A = AR.list[i != null ? i : AR.list.length - 1];
  if (A) A.h++;
}

// ---------------------------------------------------------------- village nights
const nightNow = () => { const t = dayNow(), f = t - Math.floor(t); return f >= 0.5 ? Math.floor(t) : null; };   // the night that began at sunset of that day
function nightRec(key, n) {
  let v = nights.get(key);
  if (!v) nights.set(key, v = new Map());
  let r = v.get(n);
  if (!r) { v.set(n, r = [0, 0, 0]); for (const old of [...v.keys()]) if (old <= n - NIGHTS) v.delete(old); }
  return r;
}
function watchVillages() {
  const n = nightNow();
  if (n == null || !BF.vlog || !BF.vlog.villageAt) return;
  const c = clustered();
  for (const m of BF.mobs.ofType("zombie")) {   // (spec r15-31: the zombies only)
    if (!live(m)) continue;
    const rec = BF.vlog.villageAt(m.position.x, m.position.z);
    // (clusters: the running cluster's villages only; another cluster's counts it once a zombie of its own gets in)
    if (rec && (!c || CL().ownsBase("v:" + rec.key))) { const r = nightRec(rec.key, n); if (!r[0]) { r[0] = 1; log("reached", { village: rec.key, night: n }); } }
  }
}
BF.onLoad(() => { if (BF.ctick) BF.ctick.warm(hook); });   // (cluster workers: set up on every worker, js/ctick.js warm)
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("newWorld", reset);
  BF.on("villagerHit", (v, by) => { const n = nightNow(); if (n != null && by && by.type === "zombie" && v.village) nightRec(v.village.key, n)[1]++; });
  BF.on("mobKilled", m => { const n = nightNow(); if (n != null && m && m.type === "villager" && m.village) nightRec(m.village.key, n)[2]++; });
}
// The debug screen's village panel: hostiles in the village's area, wild animals within 128 blocks of its centre, the last NIGHTS nights
// (fewer in a world younger than that, none before its first sunset).
function villageStats(rec) {
  let hostiles = 0;
  const animals = {};
  const VS = BF.villageSim, keys = new Set();
  if (VS && VS.areas) for (const a of VS.areas()) if (a.kind === "village" && a.key === rec.key) for (const k of a.keys) keys.add(k);
  for (const m of BF.mobs.list) {
    if (!live(m)) continue;
    if (m.hostile) { if (keys.has(ck(m.position.x, m.position.z))) hostiles++; continue; }
    if (ST[m.type] && wildAnimal(m) && BF.planet.distance(m.position, rec) <= 128) animals[m.type] = (animals[m.type] || 0) + 1;
  }
  const v = nights.get(rec.key), cur = Math.floor(dayNow() - 0.5), out = [];
  for (let n = cur; n > cur - NIGHTS && n >= 0; n--) { const r = v && v.get(n); out.push([n, r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0]); }
  return { hostiles, animals, nights: out };
}

// ---------------------------------------------------------------- tick, save
let breedT = 0, watchT = 0;
function onLoad(cx, cz) {
  const k = cx + "," + cz;
  if (!rolled.has(k)) toRoll.add(k);
  if (stored.has(k)) toRestore.add(k);
}
function init() { if (BF.world && !init.done) { init.done = true; BF.world.onChunkLoad(onLoad); } hook(); ownTables(); }
function update(dt) {
  hook();
  if (clustered()) return updateCluster();
  const W = BF.world;
  if (toRestore.size) for (const k of [...toRestore]) { toRestore.delete(k); if (W.chunks.has(k)) restore(k); }
  if (toRoll.size && BF.mobs.spawning !== false) {
    let n = 0;
    for (const k of toRoll) {
      toRoll.delete(k);
      if (!W.chunks.has(k) || rolled.has(k)) continue;
      roll(k);
      if (++n >= ROLLS_PER_STEP) break;
    }
  }
  areasT -= dt; if (areasT <= 0) { areasT = 1; rebuildAreas(); }
  targetsDirty = true;
  breedT -= dt; if (breedT <= 0) { breedT = 2; try { wildBreeding(); } catch (e) { console.error(e); } }
  watchT -= dt; if (watchT <= 0) { watchT = 1; watchVillages(); }
}
// With clusters: the running cluster's chunks to bring back and roll; breeding every 2 game seconds and the village watch every second,
// by the tick counter (each cluster's pass the same tick)
function updateCluster() {
  const W = BF.world;
  if (toRestore.size) for (const k of [...toRestore]) if (ownChunk(k)) { toRestore.delete(k); if (W.chunks.has(k)) restore(k); }
  if (toRoll.size && BF.mobs.spawning !== false) {
    let n = 0;
    for (const k of [...toRoll]) {
      if (!ownChunk(k)) continue;
      toRoll.delete(k);
      if (!W.chunks.has(k) || rolled.has(k)) continue;
      roll(k);
      if (++n >= ROLLS_PER_STEP) break;
    }
  }
  targetsDirty = true;
  const T = BF.rand.tick;
  if (T % 40 === 0) try { wildBreeding(); } catch (e) { console.error(e); }
  if (T % 20 === 0) watchVillages();
}
// The tables that last, by group (BF.ctick.owned; js/cworkers.js sends each group's part at meetings): a chunk's entries go with its
// region's cluster, a village's nights with the village's.
function ownTables() {
  const C = BF.ctick;
  if (!C || ownTables.done) return;
  ownTables.done = true;
  const G = k => CL().groupFor(chunkBase(k)), GV = k => CL().groupFor("v:" + k);   // (each key's group: C.keysOf lists a group's keys in order)
  C.owned("wildlife.rolled", {
    snap: g => C.keysOf(rolled, g, G).slice(),
    apply: (g, a) => { for (const k of C.keysOf(rolled, g, G)) rolled.delete(k); for (const k of a || []) rolled.add(k); C.applied(rolled, g); },
  });
  C.owned("wildlife.stored", {
    snap: g => C.keysOf(stored, g, G).map(k => [k, stored.get(k)]),
    apply: (g, a) => { for (const k of C.keysOf(stored, g, G)) stored.delete(k); for (const [k, v] of a || []) stored.set(k, v); C.applied(stored, g); },
  });
  C.owned("wildlife.nights", {
    snap: g => C.keysOf(nights, g, GV).map(k => [k, [...nights.get(k)]]),
    apply: (g, a) => { for (const k of C.keysOf(nights, g, GV)) nights.delete(k); for (const [k, v] of a || []) nights.set(k, new Map(v)); C.applied(nights, g); },
  });
}
function serialize() {
  // (with the cluster tick on, chunks and villages in key order: the clusters add theirs in turn, so the order they were met in hangs on the
  // order clusters ran in; off, in that order as before)
  const ord = BF.ctick && BF.ctick.on ? it => [...it].sort((a, b) => { const x = Array.isArray(a) ? a[0] : a, y = Array.isArray(b) ? b[0] : b; return x < y ? -1 : x > y ? 1 : 0; }) : it => it;
  const r = [];
  for (const k of ord(rolled)) { const i = k.indexOf(","); r.push(+k.slice(0, i), +k.slice(i + 1)); }
  const s = {};
  for (const [k, a] of ord(stored)) s[k] = a;
  const nv = {};
  for (const [k, v] of ord(nights)) nv[k] = [...v].map(([n, x]) => [n, x[0], x[1], x[2]]);
  return { rolled: r, stored: s, nights: nv };
}
function deserialize(o) {
  reset();
  if (!o || typeof o !== "object") return;   // old saves: every chunk rolls once, the first time it loads
  if (Array.isArray(o.rolled)) for (let i = 0; i + 1 < o.rolled.length; i += 2) rolled.add(o.rolled[i] + "," + o.rolled[i + 1]);
  for (const k in o.stored || {}) if (Array.isArray(o.stored[k])) stored.set(k, o.stored[k].filter(e => e && e.type && e.snap && Array.isArray(e.snap.p)));
  for (const k in o.nights || {}) if (Array.isArray(o.nights[k])) nights.set(k, new Map(o.nights[k].filter(Array.isArray).map(a => [+a[0], [+a[1] || 0, +a[2] || 0, +a[3] || 0]])));
}
function reset() {
  rolled = new Set(); toRoll.clear(); stored = new Map(); toRestore.clear(); nights = new Map();
  areaList = []; areaOf = new Map(); targets = new Map(); targetsDirty = true; LOG.length = 0; areasT = breedT = watchT = 0;
}
function counts() {
  let n = 0;
  for (const a of stored.values()) n += a.length;
  return { stored: n, storedChunks: stored.size, rolled: rolled.size, toRoll: toRoll.size };
}

BF.wildlife = {
  HABITAT, GROUP, ZONE, zoneKind, HOUR, RELOCATE_R, tune, BREED_R, BREED_CHANCE, CROWD_R, CROWD_MAX, CAP, CAP_CHUNKS, BUFFER, NIGHTS,
  init, update, stow, adopt, bring, relocate, mayHostile, spawned, villageStats, daylightBetween,
  areas: () => areasNow().list, areaOf: (x, z) => { const A = areasNow(), i = A.of.get(ck(x, z)); return i != null ? A.list[i] : null; },
  stored: () => stored, isRolled: k => rolled.has(k), counts, log: LOG,
  serialize, deserialize, reset,
};
})();
