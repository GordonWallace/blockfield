// Bees (BF.bees): bee nests and beehives (blocks.js "bees pack") and the bees that fly out of them. See CONTRACT.md "Bees and beekeepers".
// - Bees are counted, not tracked: each nest and hive (a "home") stores only how many bees belong to it (up to MAX), its honey level (0..FULL)
//   and the last game day it was seen loaded (for colony growth). Records are saved with the world, loaded or not.
// - Bees are real (flying) only while they are out: by day (DAWN..DUSK, half a game hour before sunset) and in dry weather at their home. At night
//   and in rain they do not exist; the home just holds its count. At dusk or when rain starts every bee that is out flies home and goes in.
// - A home's bees come out over about a minute (EMERGE). A bee flies to a flower within R blocks, lands on it for a few seconds and flies home;
//   on the way it often lands for a moment on another surface nearby: the ground, leaves, fences or a wall (facing out; never a ceiling). A
//   completed flower visit followed by the return home raises the honey level by one (FULL = 5: harvestable). No flowers, no honey.
// - Chunk loading: a home's bees are dropped as soon as its chunk unloads (only the count stays). When the chunk loads again by day in dry
//   weather, its bees are scattered within R blocks of it, preferring flowers.
// - At most CAP bees are out in the world at once: the homes nearest the player get theirs out first, the farthest keep the rest inside.
// - No health: bees cannot be hurt (they are not in BF.mobs.list, so swords and arrows pass through them). They sting a player who breaks their
//   home or harvests it by day while they are out (1 damage a sting, angry for ANGRY seconds); never villagers.
// - Colony growth: a home with at least GROW_FLOWERS flowers within R blocks gains one bee per game day it is loaded, up to MAX. New nests start
//   with 4..10, generated village hives with 8..12, placed hives with none.
// - Broken homes: the bees that are out move into a home with room within R blocks; otherwise they vanish at dusk and their count is lost.
// - A bee follows anyone holding a flower within FOLLOW_R blocks (the player, or a beekeeper: lure()). Led within reach of another home with
//   room, it moves in: one from the old count to the new.
// - Crops within CROP_R blocks of a home with bees grow CROP_BOOST times faster by day (world.js growTick reads cropFactor).
// Bees are drawn with one instanced mesh (wings flicker in the vertex shader) and fly straight with a hop over obstacles: no pathfinding.
// On the planet (spec r14-13 frames) homes are kept at canonical addresses and a bee flies in its home's face frame, past an edge too (a
// margin address there; the world reads those through to the canonical cell). Flowers, crops, the player and lures are seen from the home
// or the bee (BF.planet.local) before any distance is taken; a bee that moves to a home on another face is put into that home's frame.
// API: BF.bees = { isHome(id), isFlower(id), homeAt(x, y, z), homes(), loadedHomes(), list, flowersNear(h), cropFactor(x, y, z), harvest(x, y, z,
//   how, who), playerUse(target, stack), lure(m, on), out(), stats(), serialize(), deserialize(a), reset(), MAX, CAP, R, FULL, ... }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const MAX = 30;                 // bees a home can hold
const FULL = 5;                 // honey level of a full home
const R = 22;                   // flowers, landing spots and rehoming within this many blocks of a home
const CAP = 600;                // bees out in the world at once
const EMERGE = 60;              // seconds for a home's bees to come out
const REST_IN = [15, 35];       // seconds a bee stays in after a trip before it goes out again
const DAWN = 0.01, DUSK = 0.5 - 1 / 48;   // out between these times of day (sunset is 0.5; a game hour is 1/24 day)
const SPEED = 2.4, HOME_SPEED = 3.4, STING_SPEED = 5.2, FOLLOW_SPEED = 3.6;
const ANGRY = 20;               // seconds bees stay angry
const FOLLOW_R = 8, FOLLOW_MAX = 10, MOVE_IN_R = 2.5, LURE_NEAR_HOME = 5;
const GROW_FLOWERS = 6;         // flowers within R a home needs to grow
const CROP_R = 8, CROP_BOOST = 1.25;
const NEST_START = [4, 10], HIVE_START = [8, 12];
const BODY = 0.2;               // body length in blocks

const W = () => BF.world;
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const today = () => (BF.sky ? BF.sky.day || 0 : 0);
const simNow = () => (BF.simNow ? BF.simNow() : 0);
const pk = (x, y, z) => x + "," + y + "," + z;
const ck = (cx, cz) => cx + "," + cz;
const rs = e => BF.rand.of(e);   // seeded random streams (js/rand.js): a bee's own, or BF.rand.at for a home's
const rnd = (r, a, b) => r.range(a, b);
const CS = () => BF.CS || 16;
// q seen from p (its x / z in p's frame, with the quarter turns taking q's directions into it)
const seen = (p, q, out) => BF.planet.local(p, q, out || {});
// the canonical key of block (x, y, z), however it was addressed
const CC = {};
const ckey = (x, y, z) => { const c = BF.planet.canonCell(x, z, CC); return c.off ? pk(x, y, z) : pk(c.x, y, c.z); };
// the canonical chunk key of chunk (cx, cz) in some face frame
const cck = (cx, cz) => { const c = BF.planet.canonCell(cx * CS() + 8, cz * CS() + 8, CC); return c.off ? null : ck(Math.floor(c.x / CS()), Math.floor(c.z / CS())); };
function hash(x, y, z, salt) {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791) ^ Math.imul(salt | 0, 40503)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

let NEST = null, HIVE = null;
const ids = () => { if (NEST == null) { NEST = BF.B.bee_nest; HIVE = BF.B.beehive; } };
const isHome = id => (ids(), id != null && (id === NEST || id === HIVE) && NEST != null);
let FLOWERS = null;
const flowerIds = () => FLOWERS || (FLOWERS = new Set(["poppy", "dandelion", "cornflower"].map(n => BF.B[n]).filter(x => x != null)));
const isFlower = id => flowerIds().has(id);
const dayOut = () => { const t = skyT(); return t >= DAWN && t < DUSK; };
const wetAt = h => !!(BF.weather && BF.weather.raining && BF.weather.precipAt && BF.weather.precipAt(h.x, h.z, h.y) !== 0);
const canFly = h => dayOut() && !wetAt(h);

// ---------------------------------------------------------------- homes
const recs = new Map();        // "x,y,z" -> home record, every home ever seen (saved)
const loaded = new Map();      // "x,y,z" -> record, homes in loaded chunks
const flowers = new Map();     // chunk key -> Set of "x,y,z" flower cells in loaded chunks
const bees = [];               // bees out in the world
const lures = new Set();       // villagers holding a flower for bees to follow (js/beekeeper.js)
let hooked = false, hk = 0, lastBroken = null, cropGrid = new Map(), cropT = -1;

function edited(x, y, z) {
  const cs = CS(), cx = Math.floor(x / cs), cz = Math.floor(z / cs), e = W().edits.get(cx + "," + cz);
  if (!e) return false;
  return e.has(((y - BF.MIN_Y) * cs + (z - cz * cs)) * cs + (x - cx * cs));
}
// A record for the home block at (x, y, z) seen for the first time: generated nests and village hives start with a colony, placed ones empty.
function newRec(x, y, z, id, placed) {
  const kind = id === NEST ? "nest" : "hive", [a, b] = kind === "nest" ? NEST_START : HIVE_START;
  const n = placed ? 0 : a + Math.floor(hash(x, y, z, 77) * (b - a + 1));
  return { x, y, z, kind, bees: n, honey: 0, day: today(), out: 0, rest: [], emT: rnd(BF.rand.at("hive", x, z, null, y), 0, 4), angry: 0, fl: null, flT: -1e9, scatter: false };
}
function track(x, y, z, id) {
  const k = pk(x, y, z);
  let h = recs.get(k);
  if (!h || (h.kind === "nest") !== (id === NEST)) { h = newRec(x, y, z, id, edited(x, y, z)); recs.set(k, h); }
  h.out = 0; h.rest = []; h.scatter = true; h.flT = -1e9;
  loaded.set(k, h);
  return h;
}
function homeAt(x, y, z) { return recs.get(ckey(x, y, z)) || null; }

// Flowers (poppies, dandelions, cornflowers) in loaded chunks, kept per chunk.
function addFlower(x, y, z) {
  const cs = CS(), k = ck(Math.floor(x / cs), Math.floor(z / cs));
  let s = flowers.get(k);
  if (!s) flowers.set(k, (s = new Set()));
  s.add(pk(x, y, z));
}
function delFlower(x, y, z) {
  const cs = CS(), s = flowers.get(ck(Math.floor(x / cs), Math.floor(z / cs)));
  if (s) s.delete(pk(x, y, z));
}
// Flowers within R blocks of home h (horizontally, and within 12 up or down): [[x, y, z], ...], in h's frame (past a face edge: margin
// addresses). Cached for a few seconds.
const FQ = {};
function flowersNear(h, fresh) {
  const now = simNow();
  if (!fresh && h.fl && now - h.flT < 8) return h.fl;
  const cs = CS(), out = [];
  for (let cz = Math.floor((h.z - R) / cs); cz <= Math.floor((h.z + R) / cs); cz++) for (let cx = Math.floor((h.x - R) / cs); cx <= Math.floor((h.x + R) / cs); cx++) {
    const key = cck(cx, cz), s = key && flowers.get(key);
    if (!s) continue;
    const turned = key !== ck(cx, cz);   // a chunk past an edge: its cells seen from h
    for (const k of s) {
      const p = k.split(",").map(Number);
      if (turned) { const q = BF.planet.local(h, { x: p[0] + 0.5, z: p[2] + 0.5 }, FQ); p[0] = Math.floor(q.x); p[2] = Math.floor(q.z); }
      if (Math.hypot(p[0] - h.x, p[2] - h.z) <= R && Math.abs(p[1] - h.y) <= 12) out.push(p);
    }
  }
  h.fl = out; h.flT = now;
  return out;
}

// ---------------------------------------------------------------- bees
let seq = 0;
// The point just outside the home's entrance: its front (+z, where the tiles put the slot) when that is open, else any open side, else the top.
function doorOf(h) {
  if (h.door && h.doorAt > simNow() - 10) return h.door;
  const w = W();
  let d = null;
  for (const [dx, dy, dz] of [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
    if (BF.SOLID[w.getBlock(h.x + dx, h.y + dy, h.z + dz)]) continue;
    d = { x: h.x + 0.5 + dx * 0.62, y: h.y + 0.5 + dy * 0.62, z: h.z + 0.5 + dz * 0.62 };
    break;
  }
  h.door = d || { x: h.x + 0.5, y: h.y + 1.1, z: h.z + 0.5 }; h.doorAt = simNow();
  return h.door;
}
function spawnBee(h, at, mode) {
  const b = { id: ++seq, home: h, x: at.x, y: at.y, z: at.z, vx: 0, vy: 0, vz: 0, mode: mode || "start", t: 0, nectar: false, land: null, tgt: null,
    phase: 0, yaw: 0, follow: null, angry: 0, stung: false, stuck: 0, lastD: Infinity, trips: 0 };
  b.phase = rs(b).next() * 6.28; b.yaw = rs(b).next() * 6.28;
  bees.push(b); h.out++;
  return b;
}
function removeBee(b) {
  const i = bees.indexOf(b);
  if (i >= 0) bees.splice(i, 1);
  if (b.home && b.home.out > 0) b.home.out--;
  b.gone = true;
}
// A bee goes into its home: a flower visit before it counts as honey; it rests inside a while before going out again.
function enter(b) {
  const h = b.home;
  if (h && recs.get(pk(h.x, h.y, h.z)) === h) {
    if (b.nectar) h.honey = Math.min(FULL, h.honey + 1);
    h.rest.push(simNow() + rnd(rs(b), REST_IN[0], REST_IN[1]));
  }
  removeBee(b);
}

// A random landing spot near (x, y, z) within r blocks: the top of a block (ground, leaves, a fence post, a slab) or the side of a full block
// (a wall, a trunk, leaves) facing out, in loaded chunks. {x, y, z, nx, ny, nz} (the point on the surface and its outward normal) or null.
function landingSpot(x, y, z, r, q = rs({})) {   // q: the stream to draw from (tests: a fresh one each call)
  const w = W();
  for (let i = 0; i < 14; i++) {
    const cx = Math.floor(x + rnd(q, -r, r)), cz = Math.floor(z + rnd(q, -r, r));
    if (!w.isLoaded(cx, cz)) continue;
    if (q.next() < 0.6) {   // a top face: the highest solid block of the column, within reach up or down
      const top = w.heightAt(cx, cz);
      if (top < BF.MIN_Y || Math.abs(top - y) > 10) continue;
      const id = w.getBlock(cx, top, cz), def = BF.blocks[id];
      if (!def || BF.FLUID[w.getBlock(cx, top + 1, cz)] || BF.SOLID[w.getBlock(cx, top + 1, cz)]) continue;
      if (def.model === "fence") return { x: cx + 0.5, y: top + 1, z: cz + 0.5, nx: 0, ny: 1, nz: 0 };
      const cb = BF.CBOX[id], hy = cb && !BF.TALLBOX[id] ? cb[4] : 1;
      return { x: cx + rnd(q, 0.2, 0.8), y: top + hy, z: cz + rnd(q, 0.2, 0.8), nx: 0, ny: 1, nz: 0 };
    }
    // a side face: a full block in the column with open air beside it (a wall, a tree trunk, a step in the ground)
    const f0 = q.int(4);
    for (let cy = Math.floor(y + 3); cy >= Math.floor(y - 4); cy--) {
      const id = w.getBlock(cx, cy, cz);
      if (!BF.SOLID[id] || BF.CBOX[id] || BF.CBOXES[id] || (BF.RENDER[id] !== 1 && BF.RENDER[id] !== 2)) continue;
      let dx = 0, dz = 0;
      for (let k = 0; k < 4 && !(dx || dz); k++) {
        const [ex, ez] = BF.DIRS[(f0 + k) % 4], fr = w.getBlock(cx + ex, cy, cz + ez);
        if (!BF.SOLID[fr] && !BF.FLUID[fr]) { dx = ex; dz = ez; }
      }
      if (!dx && !dz) continue;
      const u = rnd(q, 0.2, 0.8);
      return { x: cx + 0.5 + dx * 0.5 + (dz ? u - 0.5 : 0), y: cy + rnd(q, 0.25, 0.8), z: cz + 0.5 + dz * 0.5 + (dx ? u - 0.5 : 0), nx: dx, ny: 0, nz: dz };
    }
  }
  return null;
}
const flowerSpot = (p, q) => ({ x: p[0] + 0.5 + rnd(q, -0.06, 0.06), y: p[1] + 0.56, z: p[2] + 0.5 + rnd(q, -0.06, 0.06), nx: 0, ny: 1, nz: 0, flower: p });
// The bee's next errand after landing (or coming out): a flower, a rest stop on the way, or home.
function nextErrand(b) {
  const h = b.home;
  b.land = null; b.stuck = 0; b.lastD = Infinity; b.front = false;
  const q = rs(b);
  if (!h) { const s = landingSpot(b.x, b.y, b.z, 6, q); b.mode = "fly"; b.tgt = s; b.t = 0; if (!s) { b.mode = "wander"; b.t = rnd(q, 2, 4); } return; }
  if (b.nectar) {   // flying home with nectar: now and then a short rest on the way
    if (!b.restedBack && q.next() < 0.4) { const s = landingSpot(b.x, b.y, b.z, 5, q); if (s) { b.restedBack = true; b.mode = "fly"; b.tgt = s; return; } }
    b.mode = "home"; b.tgt = null; return;
  }
  const fl = flowersNear(h);
  if (!b.restedOut && q.next() < 0.45) { const s = landingSpot(b.x, b.y, b.z, 6, q); if (s) { b.restedOut = true; b.mode = "fly"; b.tgt = s; return; } }
  if (fl.length) { b.mode = "fly"; b.tgt = flowerSpot(q.pick(fl), q); return; }
  // no flowers within reach: a few rests near home, then home with nothing
  if ((b.trips = (b.trips || 0) + 1) > 3) { b.mode = "home"; b.tgt = null; return; }
  const s = landingSpot(h.x, h.y, h.z, 10, q);
  b.mode = "fly"; b.tgt = s;
  if (!s) { b.mode = "home"; b.tgt = null; }
}

// Straight flight towards (tx, ty, tz) at speed v, cruising a little above the ground and hopping up over anything solid in the way.
// Returns the distance left.
function flyTo(b, tx, ty, tz, v, dt, low) {
  const w = W(), dx = tx - b.x, dz = tz - b.z, hd = Math.hypot(dx, dz);
  let gy = ty;
  if (!low && hd > 2.5) {
    const ax = b.x + (dx / hd) * Math.min(hd, 2), az = b.z + (dz / hd) * Math.min(hd, 2);
    const gh = Math.max(w.heightAt(b.x, b.z), w.heightAt(ax, az));
    gy = Math.max(ty, gh + 1.6);
  }
  const dy = gy - b.y, d = Math.hypot(dx, dy, dz), dist = Math.hypot(dx, ty - b.y, dz);
  if (d < 1e-4) return dist;
  const s = Math.min(d, v * dt);
  let nx = b.x + (dx / d) * s, ny = b.y + (dy / d) * s, nz = b.z + (dz / d) * s;
  ny += Math.sin(simNow() * 7 + b.phase) * 0.12 * dt;   // a little bob
  if (BF.SOLID[w.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz))]) {   // the way is blocked: hop straight up instead
    nx = b.x; nz = b.z; ny = b.y + v * dt;
    if (BF.SOLID[w.getBlock(Math.floor(nx), Math.floor(ny + 0.1), Math.floor(nz))]) ny = b.y;
  }
  b.vx = (nx - b.x) / Math.max(dt, 1e-4); b.vy = (ny - b.y) / Math.max(dt, 1e-4); b.vz = (nz - b.z) / Math.max(dt, 1e-4);
  if (Math.abs(b.vx) + Math.abs(b.vz) > 0.05) b.yaw = Math.atan2(b.vx, b.vz);
  b.x = nx; b.y = ny; b.z = nz;
  return Math.hypot(tx - b.x, ty - b.y, tz - b.z);
}

const playerPos = () => { const p = BF.player && BF.player.position; return p ? { x: p.x, y: p.y, z: p.z } : null; };
const holdsFlower = () => { try { const s = BF.inventory && BF.inventory.selected && BF.inventory.selected(); return !!(s && isFlower(s.id)); } catch (e) { return false; } };
// Everyone holding a flower now: [{who, x, y, z}] (the head height a bee hovers at).
function lurePoints() {
  const out = [];
  const pp = playerPos();
  if (pp && holdsFlower() && !(BF.player && BF.player.dead)) out.push({ who: "player", x: pp.x, y: pp.y + 1.3, z: pp.z });
  for (const m of lures) {
    if (!m || m.dead || m.removed || !m.position) { lures.delete(m); continue; }
    out.push({ who: m, x: m.position.x, y: m.position.y + 1.4, z: m.position.z });
  }
  return out;
}

function stepBee(b, dt, lp, now) {
  const h = b.home;
  // angry bees go for the player
  if (b.angry > now && !b.stung) {
    const pp = playerPos();
    if (pp) { const q = seen(b, pp); pp.x = q.x; pp.z = q.z; }   // (the player seen from the bee's frame)
    if (pp && !(BF.player && BF.player.dead) && Math.hypot(pp.x - b.x, pp.z - b.z) < R + 6) {
      b.mode = "sting"; b.land = null;
      const d = flyTo(b, pp.x, pp.y + 1.1, pp.z, STING_SPEED, dt, true);
      if (d < 0.7) {
        b.stung = true;
        if (BF.player && BF.player.damage) BF.player.damage(1, { x: b.x, y: b.y, z: b.z });
        if (BF.emit) BF.emit("beeSting", b);
        nextErrand(b);
      }
      return;
    }
  }
  if (b.mode === "sting") nextErrand(b);
  // following a flower
  if (b.mode !== "home" || b.follow) {
    if (b.follow && (b.followT -= dt) <= 0) {
      b.followT = 0.5;
      const f = lp.find(p => p.who === b.follow.who), q = f && seen(b, f);
      if (!f || Math.hypot(q.x - b.x, q.z - b.z) > FOLLOW_R + 3) b.follow = null; else b.follow = f;
    }
    if (b.follow) {
      const f0 = b.follow, q = seen(b, f0), f = { who: f0.who, x: q.x, y: f0.y, z: q.z }, a = now * 1.3 + b.phase;   // (followed in the bee's frame)
      b.land = null;
      flyTo(b, f.x + Math.cos(a) * 0.9, f.y + Math.sin(a * 1.7) * 0.25, f.z + Math.sin(a) * 0.9, FOLLOW_SPEED, dt, true);
      // led into another home with room (a villager leads only wild bees, from a nest, so its own hives never trade bees)
      for (const o0 of loaded.values()) {
        if (o0 === h || o0.bees >= MAX || (f.who !== "player" && h && h.kind !== "nest") || Math.abs(o0.y + 0.5 - b.y) > 3) continue;
        const o = seen(b, o0);
        if (Math.hypot(o.x + 0.5 - b.x, o.z + 0.5 - b.z) > MOVE_IN_R || Math.hypot(f.x - (o.x + 0.5), f.z - (o.z + 0.5)) > LURE_NEAR_HOME) continue;
        moveIn(b, o0, f.who);
        return;
      }
      return;
    }
  }
  if (b.mode === "home") {
    if (!h) { b.mode = "wander"; b.t = rnd(rs(b), 2, 5); return; }
    const d0 = doorOf(h), d = flyTo(b, d0.x, d0.y, d0.z, b.hurry ? HOME_SPEED : SPEED, dt, Math.hypot(d0.x - b.x, d0.z - b.z) < 3);
    if (d < 0.3) { enter(b); return; }
    if (d > b.lastD - 0.01 * dt) { if ((b.stuck += dt) > 8) { enter(b); return; } } else { b.stuck = 0; b.lastD = d; }   // stuck behind something: it gets in anyway
    return;
  }
  if (b.mode === "land") {
    if ((b.t -= dt) > 0) return;
    if (b.land && b.land.flower) {
      const w = W(), p = b.land.flower;
      if (isFlower(w.getBlock(p[0], p[1], p[2]))) b.nectar = true;
    }
    nextErrand(b);
    return;
  }
  if (b.mode === "wander") {
    b.t -= dt;
    flyTo(b, b.x + Math.sin(b.phase + now) * 2, b.y + Math.sin(now * 0.7 + b.phase) * 0.5, b.z + Math.cos(b.phase + now * 0.9) * 2, SPEED * 0.5, dt, true);
    if (b.t <= 0) nextErrand(b);
    return;
  }
  if (b.mode === "start") { nextErrand(b); return; }
  // flying to a landing spot
  const s = b.tgt;
  if (!s) { nextErrand(b); return; }
  const near = Math.hypot(s.x - b.x, s.z - b.z) < 2.5;
  const ox = s.x + s.nx * 0.03, oy = s.y + s.ny * 0.03, oz = s.z + s.nz * 0.03;
  if (near && s.ny === 0 && !b.front) {   // a wall: first to a point just in front of it, then straight in
    if (flyTo(b, s.x + s.nx * 0.4, oy, s.z + s.nz * 0.4, SPEED, dt, true) < 0.1) { b.front = true; b.stuck = 0; b.lastD = Infinity; }
    else if ((b.stuck += dt) > 6) nextErrand(b);
    return;
  }
  const d = flyTo(b, near ? ox : s.x, near ? oy : s.y + 0.4, near ? oz : s.z, SPEED, dt, near);
  if (d < 0.08) {
    b.x = ox; b.y = oy; b.z = oz; b.vx = b.vy = b.vz = 0;
    b.mode = "land"; b.land = s; b.t = s.flower ? rnd(rs(b), 3, 6) : rnd(rs(b), 1.5, 4);
    b.landYaw = rs(b).next() * 6.28;
    return;
  }
  if (d > b.lastD - 0.01 * dt) { if ((b.stuck += dt) > 6) nextErrand(b); } else { b.stuck = 0; b.lastD = d; }
}
// A led bee moves into home o: one bee from its old home's count to o's.
function moveIn(b, o, who) {
  const h = b.home;
  if (h) { h.bees = Math.max(0, h.bees - 1); if (h.out > 0) h.out--; }
  o.bees++; o.out++;
  b.home = o; b.follow = null; b.nectar = false;
  if (BF.emit) BF.emit("beeMovedIn", o, h, who);
  if (moveL.length) for (const fn of moveL) try { fn(o, h, who); } catch (e) { console.error(e); }
  enter(b);
}
const moveL = [];

// ---------------------------------------------------------------- the world clock
// Once a second: colony growth, how many bees each loaded home may have out (CAP, nearest the player first), bees sent home, the crop grid.
function housekeeping() {
  const now = simNow(), pp = playerPos() || { x: 0, y: 0, z: 0 }, day = today();
  const list = [...loaded.values()];
  for (const h of list) {
    if (h.day < day) { if (h.bees > 0 && h.bees < MAX && flowersNear(h, true).length >= GROW_FLOWERS) h.bees++; h.day = day; }   // one bee a game day it is loaded
    h.rest = h.rest.filter(t => t > now);
    h.dist = BF.planet.distance(h, pp);
  }
  list.sort((a, b) => a.dist - b.dist);
  let left = CAP;
  for (const h of list) { h.allow = canFly(h) ? Math.min(h.bees, left) : 0; left -= h.allow; h.hurry = !canFly(h); }
  // bees over a home's allowance (dusk, rain, the cap) or homeless at dusk head home
  const over = new Map();
  for (const h of list) over.set(h, Math.max(0, h.out - h.allow));
  const dusk = !dayOut();
  for (let i = bees.length - 1; i >= 0; i--) {
    const b = bees[i], h = b.home;
    if (!h) { if (dusk && b.angry <= now) removeBee(b); continue; }   // a bee whose home was broken vanishes at dusk
    if (!loaded.has(pk(h.x, h.y, h.z))) continue;
    const n = over.get(h) || 0;
    if (n > 0 && b.mode !== "home" && !(b.angry > now)) { b.mode = "home"; b.follow = null; b.hurry = h.hurry; b.stuck = 0; b.lastD = Infinity; over.set(h, n - 1); }
    else if (b.mode === "home") b.hurry = h.hurry;
  }
  cropGrid = new Map();
  for (const h of list) {
    if (h.bees <= 0) continue;
    for (let gz = Math.floor((h.z - CROP_R) / 16); gz <= Math.floor((h.z + CROP_R) / 16); gz++) for (let gx = Math.floor((h.x - CROP_R) / 16); gx <= Math.floor((h.x + CROP_R) / 16); gx++) {
      const k = cck(gx, gz);   // (canonical: crops grow at canonical cells)
      if (!k) continue;
      if (!cropGrid.has(k)) cropGrid.set(k, []);
      cropGrid.get(k).push(h);
    }
  }
}
// Bees scattered around a home whose chunk just loaded by day in dry weather (preferring flowers), and bees coming out of their homes.
function release(dt) {
  const now = simNow();
  for (const h of loaded.values()) {
    if (h.allow == null) continue;
    if (h.scatter) {
      h.scatter = false;
      if (h.allow > 0 && h.out === 0) {
        const fl = flowersNear(h, true), n = h.allow, q = BF.rand.at("bees out", h.x, h.z, null, h.y);
        for (let i = 0; i < n; i++) {
          let s = fl.length && q.next() < 0.7 ? flowerSpot(q.pick(fl), q) : null;
          for (let k = 0; k < 4 && !s; k++) { s = landingSpot(h.x + 0.5, h.y, h.z + 0.5, R, q); if (s && Math.hypot(s.x - h.x - 0.5, s.z - h.z - 0.5) > R) s = null; }
          if (!s) continue;
          const b = spawnBee(h, { x: s.x + s.nx * 0.03, y: s.y + s.ny * 0.03, z: s.z + s.nz * 0.03 }, "land");
          b.land = s; b.t = rnd(q, 0.5, 6); b.landYaw = q.next() * 6.28;
        }
        continue;
      }
    }
    const inside = h.bees - h.out - h.rest.length;
    if (h.out >= h.allow || inside <= 0) continue;
    if ((h.emT -= dt) > 0) continue;
    h.emT = EMERGE / Math.max(1, h.bees) * rnd(BF.rand.at("bee emerge", h.x, h.z, null, h.y), 0.6, 1.4);
    const b = spawnBee(h, doorOf(h), "start");
    if (h.angry > now) b.angry = h.angry;
  }
}

let acc = 0, lureT = 0, lp = [];
function update(dt) {
  if (!(dt > 0) || !W() || NEST == null && (ids(), NEST == null)) return;
  hook();
  for (const b of bees) { b.px = b.x; b.py = b.y; b.pz = b.z; b.pyaw = b.yaw; }   // where each was before this tick: drawn between (draw)
  dirty = true;
  acc += dt;
  if (acc >= 1) { acc = 0; housekeeping(); }
  release(dt);
  const now = simNow();
  if ((lureT -= dt) <= 0) {   // who holds a flower: free bees within reach start following (up to FOLLOW_MAX each)
    lureT = 0.3;
    lp = lurePoints();
    if (lp.length) {
      const cnt = new Map();
      for (const b of bees) if (b.follow) cnt.set(b.follow.who, (cnt.get(b.follow.who) || 0) + 1);
      for (const b of bees) {
        if (b.follow || b.angry > now || b.mode === "home" && b.hurry) continue;
        for (const f of lp) {
          if ((cnt.get(f.who) || 0) >= FOLLOW_MAX) continue;
          const q = seen(b, f);
          if (Math.hypot(q.x - b.x, f.y - b.y, q.z - b.z) > FOLLOW_R) continue;
          b.follow = f; b.followT = 0.5; b.mode = "fly"; cnt.set(f.who, (cnt.get(f.who) || 0) + 1);
          break;
        }
      }
    } else for (const b of bees) if (b.follow) { b.follow = null; nextErrand(b); }
  }
  for (let i = bees.length - 1; i >= 0; i--) { const b = bees[i]; if (b && !b.gone) stepBee(b, dt, lp, now); }
  dirty = true;
}

// ---------------------------------------------------------------- the world: chunks, blocks, crops
let SCANF = null;
function scanChunk(cx, cz, c) {
  ids();
  if (NEST == null) return;
  if (!SCANF) { SCANF = new Uint8Array(BF.MAX_BLOCK + 1); SCANF[NEST] = 1; SCANF[HIVE] = 1; for (const f of flowerIds()) SCANF[f] = 2; }
  const cs = CS();
  flowers.delete(ck(cx, cz));
  W().scanFlagged(c, SCANF, (lx, y, lz) => {
    const x = cx * cs + lx, z = cz * cs + lz, id = W().getBlock(x, y, z);
    if (isHome(id)) track(x, y, z, id); else addFlower(x, y, z);
  });
}
function unloadChunk(cx, cz) {
  const cs = CS();
  flowers.delete(ck(cx, cz));
  for (const [k, h] of loaded) {
    if (Math.floor(h.x / cs) !== cx || Math.floor(h.z / cs) !== cz) continue;
    for (let i = bees.length - 1; i >= 0; i--) if (bees[i].home === h) removeBee(bees[i]);   // dropped: only the count stays
    h.out = 0; h.rest = []; h.allow = null;
    loaded.delete(k);
  }
}
// world.setBlock: homes placed and broken, flowers planted and picked.
function onSet(x, y, z, old, id) {
  if (isFlower(old)) delFlower(x, y, z);
  if (isFlower(id)) addFlower(x, y, z);
  if (isHome(old) && !isHome(id)) {
    const k = pk(x, y, z), h = recs.get(k);
    recs.delete(k); loaded.delete(k);
    if (!h) return;
    // its bees that are out look for a home with room within R; the rest are lost
    const outB = bees.filter(b => b.home === h), ang = [];
    for (const b of outB) {
      b.home = null; b.nectar = false; ang.push(b);
      let best = null, bd = R;
      for (const o of loaded.values()) { const q = seen(h, o), d = Math.hypot(q.x - x, o.y - y, q.z - z); if (o.bees < MAX && d <= bd) { bd = d; best = o; } }
      if (best) { best.bees++; best.out++; b.home = best; toFrameOf(b, best); }
    }
    lastBroken = { x, y, z, bees: ang, t: simNow() };
    if (BF.emit) BF.emit("beeHomeGone", h);
    return;
  }
  if (isHome(id) && !isHome(old)) {
    const k = pk(x, y, z), h = newRec(x, y, z, id, true);
    recs.set(k, h); h.scatter = false; loaded.set(k, h);
  }
}
// The planet: bee b, now belonging to home o, flies on in o's frame (a home on another face: its position and heading turned with it,
// its errand dropped, since its landing spot was in the old frame).
function toFrameOf(b, o) {
  const v = { x: b.vx, z: b.vz }, hd = { yaw: 0 };
  const q = BF.planet.reframe(b, BF.planet.face(o.x, o.z), hd, v);
  if (q == null) return;
  b.vx = v.x; b.vz = v.z;
  if (Math.abs(b.vx) + Math.abs(b.vz) > 0.05) b.yaw = Math.atan2(b.vx, b.vz);
  b.follow = null; b.mode = "home"; b.tgt = null; b.land = null; b.stuck = 0; b.lastD = Infinity;
}
// Bees out of home h (or the bees of a home just broken) go for the player for ANGRY seconds.
function anger(list, h) {
  const until = simNow() + ANGRY;
  if (h) h.angry = until;
  for (const b of list) { b.angry = until; b.stung = false; }
}
function playerNear(x, y, z, r) { const p = playerPos(), q = p && seen({ x, z }, p); return !!(p && Math.hypot(q.x - x - 0.5, p.y - y, q.z - z - 0.5) <= r); }

// Crops within CROP_R blocks of a loaded home with bees grow CROP_BOOST times faster by day (js/world.js growTick).
function cropFactor(x, y, z) {
  if (skyT() >= 0.5 || !cropGrid.size) return 1;
  const hs = cropGrid.get(ck(Math.floor(x / 16), Math.floor(z / 16)));
  if (!hs) return 1;
  for (const h of hs) {
    if (h.bees <= 0 || Math.abs(h.y - y) > CROP_R) continue;
    const q = seen(h, { x, z });   // (the crop seen from the home, across a face edge)
    if (Math.hypot(h.x - q.x, h.z - q.z) <= CROP_R) return CROP_BOOST;
  }
  return 1;
}

// Harvests the full home at (x, y, z): how = "shears" (3 honeycomb) or "bottle" (1 honey bottle, using up a glass bottle). Returns
// {id, n} of what it gives, or null when the home is not full. `who` = "player" angers its bees that are out (by day).
function harvest(x, y, z, how, who) {
  const h = recs.get(ckey(x, y, z));
  if (!h || h.honey < FULL) return null;
  h.honey = 0;
  if (who === "player") { const out = bees.filter(b => b.home === h); if (out.length) anger(out, h); }
  if (BF.emit) BF.emit("beeHarvest", h, how, who);
  return how === "shears" ? { id: BF.I.honeycomb, n: 3 } : { id: BF.I.honey_bottle, n: 1 };
}
// The player right-clicks a nest or hive with stack in hand: {give: {id, n}, consume, wear, msg} or {msg}.
function playerUse(target, stack) {
  const h = recs.get(ckey(target.x, target.y, target.z));
  if (!h) return null;
  const nm = stack && BF.items[stack.id] ? BF.items[stack.id].name : "";
  const what = () => (h.kind === "nest" ? "Bee nest" : "Beehive") + ": " + h.bees + " bee" + (h.bees === 1 ? "" : "s") + ", honey " + h.honey + "/" + FULL;
  if (nm === "shears" || nm === "glass_bottle") {
    if (h.honey < FULL) return { msg: what() + " (not full yet)" };
    const g = harvest(target.x, target.y, target.z, nm === "shears" ? "shears" : "bottle", "player");
    return g ? { give: g, consume: nm === "glass_bottle" ? 1 : 0, wear: nm === "shears" ? 1 : 0 } : null;
  }
  return { msg: what() };
}
function lure(m, on) { if (on) lures.add(m); else lures.delete(m); }

function hook() {
  if (hooked || !W() || !W().onChunkLoad) return;
  hooked = true;
  W().onChunkLoad(scanChunk);
  W().onChunkUnload(unloadChunk);
  for (const c of W().chunks.values()) scanChunk(c.cx, c.cz, c);
  if (BF.on) BF.on("blockBroken", (x, y, z, id) => {   // the player broke a home: its bees that were out sting
    if (!isHome(id) || !lastBroken || ckey(x, y, z) !== pk(lastBroken.x, lastBroken.y, lastBroken.z)) return;
    if (playerNear(x, y, z, 8) && (dayOut() || lastBroken.bees.length)) anger(lastBroken.bees, null);
    lastBroken = null;
  });
}
function reset() {
  for (const b of bees) b.gone = true;
  bees.length = 0; recs.clear(); loaded.clear(); flowers.clear(); lures.clear(); cropGrid = new Map(); lastBroken = null; acc = 0;
}

// ---------------------------------------------------------------- drawing: one instanced mesh, wings flickering in the vertex shader
let mesh = null, dirty = true;
function geometry() {
  const pos = [], col = [], wing = [];
  const box = (x0, y0, z0, x1, y1, z1, c, wg) => {
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const F = [[0, 3, 2, 1, 0.7], [4, 5, 6, 7, 0.8], [0, 4, 7, 3, 0.75], [1, 2, 6, 5, 0.75], [3, 7, 6, 2, 1], [0, 1, 5, 4, 0.5]];
    for (const [a, b, cc, d, sh] of F) for (const i of [a, b, cc, a, cc, d]) { pos.push(...P[i]); col.push(c[0] * sh, c[1] * sh, c[2] * sh); wing.push(wg); }
  };
  const Y = [0.98, 0.78, 0.1], K = [0.1, 0.08, 0.06], Wg = [0.86, 0.92, 0.98];
  const L = BODY, w = 0.045, hgt = 0.045;
  const segs = [[-0.5, -0.38, K], [-0.38, -0.24, Y], [-0.24, -0.12, K], [-0.12, 0.04, Y], [0.04, 0.22, [0.25, 0.18, 0.08]], [0.22, 0.5, K]];
  for (const [a, b, c] of segs) { const s = a > 0.2 ? 0.8 : 1; box(-w * s, -hgt * s, a * L, w * s, hgt * s, b * L, c, 0); }
  box(0.01, hgt, -0.04, 0.11, hgt + 0.006, 0.04, Wg, 1);      // right wing (hinged at x = 0, y = hgt)
  box(-0.11, hgt, -0.04, -0.01, hgt + 0.006, 0.04, Wg, -1);   // left wing
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("wing", new THREE.Float32BufferAttribute(wing, 1));
  return g;
}
const uTime = { value: 0 };
function initMesh() {
  if (mesh || !BF.scene || typeof THREE === "undefined" || !THREE.InstancedMesh) return;
  const g = geometry(), mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  g.setAttribute("bee", new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2));   // per bee: wing phase, flapping (1) or folded (0)
  mat.onBeforeCompile = sh => {
    sh.uniforms.uBeeTime = uTime;
    sh.vertexShader = "attribute float wing;\nattribute vec2 bee;\nuniform float uBeeTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      if (wing != 0.0) {
        float a = wing * mix(-0.15, 0.25 + 0.75 * abs(sin(uBeeTime * 70.0 + bee.x)), bee.y);
        vec2 r = vec2(transformed.x, transformed.y - ${(0.045).toFixed(3)});
        transformed.x = r.x * cos(a) - r.y * sin(a);
        transformed.y = r.x * sin(a) + r.y * cos(a) + ${(0.045).toFixed(3)};
      }`);
  };
  mesh = new THREE.InstancedMesh(g, mat, CAP);
  mesh.count = 0; mesh.frustumCulled = false; mesh.name = "bees";
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.onBeforeRender = draw;
  BF.scene.add(mesh);
  // floating origin (js/view.js): instance positions are stored relative to the mesh, which sits on a coarse grid near the player
  if (BF.view) BF.view.onBegin(() => {
    const p = BF.player && BF.player.position;
    if (!p) return;
    const rx = Math.floor(p.x / 256) * 256, rz = Math.floor(p.z / 256) * 256;
    if (rx !== mesh.position.x || rz !== mesh.position.z) { mesh.position.set(rx, 0, rz); dirty = true; }
  });
}
const _m = typeof THREE !== "undefined" ? new THREE.Matrix4() : null;
const _r = typeof THREE !== "undefined" ? new THREE.Vector3() : null, _u = typeof THREE !== "undefined" ? new THREE.Vector3() : null, _f = typeof THREE !== "undefined" ? new THREE.Vector3() : null;
const DQ = {}, DV = [0, 0], BP = { x: 0, y: 0, z: 0 };
let drawnK = -1;
// Bees are drawn between where the last two ticks left them (spec r15-10): k = BF.warp.alpha, 0 the previous tick, 1 the latest.
function draw() {
  const Wp = BF.warp, k = Wp && Wp.alpha != null ? Wp.alpha : 1, j = 1 - k;
  uTime.value = Wp && Wp.renderNow ? Wp.renderNow() : simNow();
  const light = BF.sky && typeof BF.sky.light === "number" ? Math.max(0.3, Math.min(1, BF.sky.light)) : 1;
  mesh.material.color.setRGB(light, light, light);
  if (!dirty && k === drawnK) return;
  dirty = false; drawnK = k;
  const n = Math.min(bees.length, CAP), A = mesh.geometry.getAttribute("bee");
  for (let i = 0; i < n; i++) {
    const b = bees[i], s = b.mode === "land" && b.land ? b.land : null;
    const lerp = b.px != null && (b.x - b.px) ** 2 + (b.y - b.py) ** 2 + (b.z - b.pz) ** 2 < 16;   // (a jump: a face edge, a new frame)
    BP.x = lerp ? b.px * j + b.x * k : b.x; BP.y = lerp ? b.py * j + b.y * k : b.y; BP.z = lerp ? b.pz * j + b.z * k : b.z;
    // the planet: the bee seen from the mesh (in the player's frame), its directions turned with it
    const r = BF.planet.local(mesh.position, BP, DQ), bx = r.x, bz = r.z, q = r.turn;
    if (s) {   // landed: belly on the surface, back along its normal
      let nx = s.nx, nz = s.nz;
      if (q) { BF.planet.turnVec(q, nx, nz, DV); nx = DV[0]; nz = DV[1]; }
      _u.set(nx, s.ny, nz);
      if (s.ny > 0.5) _f.set(Math.sin(b.landYaw), 0, Math.cos(b.landYaw));
      else { const a = (b.landYaw % 1.2) - 0.6; _f.set(Math.sin(a) * nz, Math.cos(a), -Math.sin(a) * nx); }   // on a wall: head up, a little askew
      _r.crossVectors(_u, _f).normalize(); _f.crossVectors(_r, _u).normalize();
      _m.makeBasis(_r, _u, _f).setPosition(bx + nx * 0.045 - mesh.position.x, BP.y + s.ny * 0.045, bz + nz * 0.045 - mesh.position.z);
    } else {
      let yaw = lerp && b.pyaw != null ? b.pyaw + Math.atan2(Math.sin(b.yaw - b.pyaw), Math.cos(b.yaw - b.pyaw)) * k : b.yaw;
      if (q) { BF.planet.turnVec(q, Math.sin(yaw), Math.cos(yaw), DV); yaw = Math.atan2(DV[0], DV[1]); }
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      _f.set(sn, 0, c); _u.set(0, 1, 0); _r.set(c, 0, -sn);
      _m.makeBasis(_r, _u, _f).setPosition(bx - mesh.position.x, BP.y, bz - mesh.position.z);
    }
    mesh.setMatrixAt(i, _m);
    A.setXY(i, b.phase, s ? 0 : 1);
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  A.needsUpdate = true;
}

// ---------------------------------------------------------------- saving
// [x, y, z, kind (0 nest, 1 hive), bees, honey, day, ...]; bees that are out count as home.
function serialize() {
  const a = [];
  for (const h of recs.values()) a.push(h.x, h.y, h.z, h.kind === "nest" ? 0 : 1, h.bees, h.honey, h.day);
  return a;
}
function deserialize(a) {
  for (const b of bees) b.gone = true;
  bees.length = 0; recs.clear();
  if (Array.isArray(a)) for (let i = 0; i + 6 < a.length; i += 7) {
    const h = { x: a[i], y: a[i + 1], z: a[i + 2], kind: a[i + 3] ? "hive" : "nest", bees: Math.max(0, Math.min(MAX, a[i + 4] | 0)), honey: Math.max(0, Math.min(FULL, a[i + 5] | 0)), day: a[i + 6] | 0,
      out: 0, rest: [], emT: rnd(BF.rand.at("hive", a[i], a[i + 2], null, a[i + 1]), 0, 4), angry: 0, fl: null, flT: -1e9, scatter: true };
    recs.set(pk(h.x, h.y, h.z), h);
  }
  for (const [k, h] of loaded) { const r = recs.get(k); if (r) loaded.set(k, r); else loaded.delete(k); }
}

function stats() {
  let homesN = 0, beesN = 0, full = 0;
  for (const h of loaded.values()) { homesN++; beesN += h.bees; if (h.honey >= FULL) full++; }
  return { records: recs.size, loaded: homesN, bees: beesN, out: bees.length, full, lures: lures.size };
}

BF.bees = {
  MAX, FULL, R, CAP, EMERGE, DAWN, DUSK, ANGRY, FOLLOW_R, GROW_FLOWERS, CROP_R, CROP_BOOST, BODY,
  isHome, isFlower, homeAt, flowersNear, cropFactor, harvest, playerUse, lure, onSet, update, reset, serialize, deserialize, stats, landingSpot,
  homes: () => [...recs.values()], loadedHomes: () => [...loaded.values()], list: bees, canFly, dayOut,
  onMoveIn: fn => moveL.push(fn),
  out: h => bees.filter(b => b.home === h),
  housekeeping, initMesh,
};
// The bee simulation runs with the mobs, once per simulation step (fast-forward included); the mesh is drawn when the scene renders.
if (BF.mobs && BF.mobs.update) {
  const prev = BF.mobs.update;
  BF.mobs.update = function (dt) { const r = prev.apply(this, arguments); try { initMesh(); update(dt); } catch (e) { console.error(e); } return r; };
}
if (W() && W().reset) { const prev = W().reset; W().reset = function () { const r = prev.apply(this, arguments); reset(); return r; }; }
})();
