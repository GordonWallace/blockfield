// Sheep care and the shepherd's work (BF.shepherd). Loaded after js/breeding.js; hooks live in mobs.js, villagelife.js, jobs.js and player.js.
// See CONTRACT.md "Sheep and shepherds (js/shepherd.js)".
//
// Sheep (every sheep, wild or penned; state in `m.sheep`):
//  - Fed: 1 wheat from the player or a shepherd makes a sheep willing to breed for 1 day (`fed` = absolute game day it was fed).
//  - Breeding: two willing adults within MATE_R walk to each other and a lamb appears; both then rest BREED_CD days.
//    A lamb is smaller, drops nothing and grows up after LAMB_DAYS.
//  - Shearing: shears (3 iron ingots) take 1-3 wool and swap the model for a shorn one. The wool grows back after ~7 days, +-30% per sheep.
// Pens: worldgen gives every shepherd a fenced pen (js/worldgen.js layoutVillage, js/jobs.js puts the loom beside it). Each pen holds a list of sheep
//  states that outlives the sheep mobs: 2-4 sheep when it is first seen, respawned whenever the pen is loaded, saved as "pens:<village key>".
//  Penned sheep wander only inside the pen (the fence has a gate gap and sheep can hop one-block fences, so the AI keeps them in).
// Shepherds (profession "shepherd"): feed hungry sheep, shear woolly ones, buy wheat when low (js/villagelife.js shopAI), and cull
//  adults once the pen is too full: THRESHOLD = ceil(room cells / 6), i.e. one sheep per 6 cells, and the pen counts as full from that many sheep
//  on. They never kill before that, and always leave at least 2 adults. Their mutton is cooked daily and sold through the village food market.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const FEED_DAYS = 1;          // a sheep is willing to breed for this long after eating wheat
const BREED_CD = 1;           // days before a sheep that bred can breed again
const LAMB_DAYS = 1;          // days from birth to adult
const REGROW_DAYS = 7, REGROW_VAR = 0.3;   // wool grows back after 7 days, +-30% (triangular)
const MATE_R = 10, MEET = 1.8;             // a willing sheep looks for a mate this far; they breed when this close
const LOCAL_MAX = 30;         // no breeding when this many sheep are already within 16 blocks
const PEN_DENSITY = 6;        // one sheep per this many pen cells: the pen is full at ceil(cells / 6)
const FREE_RADIUS = 10, FREE_THRESHOLD = 8;   // a shepherd without a pen tends the sheep within 10 blocks of its loom; full at 8
const TEND_R = 12;            // stray sheep this near the pen / loom are also fed and shorn
const MIN_ADULTS = 2;         // the shepherd never culls below this many adults
const WORK_END = 0.5;
const TASK_MAX = 45;

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const cnt = (m, id) => (id == null || !m.inv ? 0 : TR().inv.count(m.inv, id));
const idsOf = () => ({ wheat: BF.I.wheat_item, wool: BF.I.white_wool, shears: BF.I.shears, mutton: BF.I.raw_mutton });

let ids = 0;
const idOf = new WeakMap();
const mid = m => { let i = idOf.get(m); if (!i) idOf.set(m, i = ++ids); return i; };

// ---------------------------------------------------------------- sheep state
function stOf(m) {
  if (!m.sheep) m.sheep = { fed: null, shorn: false, woolAt: null, growAt: null, cd: 0, x: null, z: null, mob: m };
  return m.sheep;
}
const regrowDays = () => REGROW_DAYS * (1 + (Math.random() + Math.random() - 1) * REGROW_VAR);
const isLamb = m => !!(m.sheep && m.sheep.growAt != null);
const hungry = (m, t) => { const s = m.sheep; return !s || s.fed == null || t - s.fed >= FEED_DAYS; };
const willing = (m, t) => { const s = m.sheep; return !!(s && live(m) && s.growAt == null && s.fed != null && t - s.fed < FEED_DAYS && t >= s.cd); };

// Shorn / lamb appearance follows the state (cheap; called from the periodic tick and after every change).
function syncLook(m) {
  const s = stOf(m), t = now();
  const shorn = !!s.shorn;
  if (m._shorn !== shorn) { m._shorn = shorn; BF.mobs.setSheepLook(m, shorn); }
  const k = s.growAt != null ? clamp(1 - (s.growAt - t) / LAMB_DAYS, 0, 1) : 1;
  m.lamb = k < 1;
  if (m._k == null || Math.abs(k - m._k) > 0.02 || (k >= 1 && m._k < 1)) { m._k = k; BF.mobs.setSheepSize(m, k); }
}
function fx(m, color, n) { const V = BF.villageLife; if (V && V.particles && m.position) V.particles(m.position.x, m.position.y + m.height + 0.2, m.position.z, color, n, 0.5); }
function snd(name, m, vol) { const V = BF.villageLife; if (V && V.sound && m.position) V.sound(name, m.position.x, m.position.y + 0.8, m.position.z, vol); }

// Wheat eaten by `m` (from the player or a shepherd). Returns false for lambs or sheep that are not hungry.
function feed(m, by) {
  if (!live(m) || m.type !== "sheep") return false;
  const s = stOf(m), t = now();
  if (s.growAt != null) { s.growAt -= LAMB_DAYS * 0.1; syncLook(m); fx(m, "#ffd84a", 5); snd("sheep", m, 0.4); return true; }   // wheat speeds a lamb up by 10%
  if (!hungry(m, t)) return false;
  s.fed = t;
  fx(m, "#ff5a7a", 6); snd("sheep", m, 0.5);
  if (BF.emit) BF.emit("sheepFed", m, by);
  return true;
}
// Takes the wool: returns how many items, or 0 when there is nothing to shear. The caller puts them somewhere.
function shear(m, by) {
  if (!live(m) || m.type !== "sheep") return 0;
  const s = stOf(m);
  if (s.growAt != null || s.shorn) return 0;
  s.shorn = true; s.woolAt = now() + regrowDays();
  syncLook(m);
  fx(m, "#e9e9e6", 8); snd("sheep", m, 0.5);
  if (BF.emit) BF.emit("sheepShorn", m, by);
  return rndInt(1, 3);
}
function dropItem(id, n, m) {
  if (id == null || n <= 0) return;
  if (BF.drops && m.position) BF.drops.spawn(id, n, m.position.x, m.position.y + 0.6, m.position.z);
}
// The player right-clicked a sheep holding `sel`: wheat feeds it, shears shear it. Returns true / a message (handled) or false (not ours).
function playerUse(m, sel) {
  const it = sel && BF.items[sel.id];
  if (!it || !live(m)) return false;
  const creative = BF.player && BF.player.gameMode === "creative";
  const use = () => { if (!creative && BF.inventory && BF.inventory.consumeSelected) BF.inventory.consumeSelected(1); };
  if (it.name === "wheat_item") {
    if (m.lamb) { if (!feed(m, "player")) return false; use(); return true; }
    if (!hungry(m, now())) return "The sheep isn't hungry";
    if (!feed(m, "player")) return false;
    use();
    return true;
  }
  if (it.name === "shears") {
    if (m.lamb) return "Lambs are too small to shear";
    if (stOf(m).shorn) return "This sheep has no wool";
    const n = shear(m, "player");
    if (n) dropItem(idsOf().wool, n, m);
    return !!n;
  }
  return false;
}

// ---------------------------------------------------------------- breeding
function findMate(m, t) {
  let best = null, bd = MATE_R * MATE_R, near = 0;
  for (const o of BF.mobs.list) {
    if (o.type !== "sheep" || !live(o)) continue;
    const dx = o.position.x - m.position.x, dz = o.position.z - m.position.z, d2 = dx * dx + dz * dz;
    if (d2 < 256) near++;
    if (o === m || o.pen !== m.pen || !willing(o, t) || Math.abs(o.position.y - m.position.y) > 2) continue;
    if (d2 < bd) { bd = d2; best = o; }
  }
  return near >= LOCAL_MAX ? null : best;
}
function breed(a, b, t) {
  const x = (a.position.x + b.position.x) / 2, z = (a.position.z + b.position.z) / 2, y = Math.max(a.position.y, b.position.y);
  const lamb = BF.mobs.spawn("sheep", x, y, z);
  if (!lamb) return null;
  const s = stOf(lamb);
  s.growAt = t + LAMB_DAYS; s.cd = t + LAMB_DAYS + BREED_CD;
  stOf(a).cd = stOf(b).cd = t + BREED_CD;
  const pen = a.pen || b.pen;
  if (pen && pen.sheep) { s.mob = lamb; lamb.sheep = s; pen.sheep.push(s); lamb.pen = pen; lamb.penVillage = pen.rec; }
  syncLook(lamb);
  fx(a, "#ff5a7a", 6); fx(b, "#ff5a7a", 6); snd("sheep", lamb, 0.5);
  a.mate = b.mate = null;
  if (BF.emit) BF.emit("sheepBorn", lamb, a, b);
  return lamb;
}
// Movement for a willing sheep: walks to its mate. Returns true when it is steering the sheep.
function sheepAI(m, dt, out) {
  const t = now();
  if (!willing(m, t)) { m.mate = null; return false; }
  m.mateT = (m.mateT || 0) - dt;
  if (m.mate && (!live(m.mate) || !willing(m.mate, t))) m.mate = null;
  if (!m.mate) {
    if (m.mateT > 0) return false;
    m.mateT = rnd(1, 2);
    m.mate = findMate(m, t);
    if (!m.mate) return false;
    m.mateSeek = 0;
  }
  const o = m.mate, dx = o.position.x - m.position.x, dz = o.position.z - m.position.z, d = Math.hypot(dx, dz);
  m.mateSeek += dt;
  if (d > MATE_R + 4 || m.mateSeek > 25) { m.mate = null; m.mateT = rnd(6, 10); return false; }   // cannot reach it: try again later
  m.ai.mode = "idle"; m.ai.t = 1; m.lookAt = o;
  if (d < MEET) {
    if (mid(m) < mid(o)) breed(m, o, t);
    return true;
  }
  const sp = m.def.speed * 1.25;
  out.x = dx / d * sp; out.z = dz / d * sp;
  return true;
}

// ---------------------------------------------------------------- pens
// A pen of a village record: the fenced worldgen building (js/worldgen.js "pen"), its sheep room and its stock of sheep states.
// Sheep room = the interior minus the back row (hay bales and the water trough). x0..x1 / z0..z1 are block edges.
function makePen(rec, b, idx) {
  const at = (u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
  const box = (u0, q0, u1, q1) => {
    const p = at(u0, q0), r = at(u1, q1);
    return [Math.min(p[0], r[0]), Math.min(p[1], r[1]), Math.max(p[0], r[0]) + 1, Math.max(p[1], r[1]) + 1];
  };
  const room = box(1, 1, b.w - 2, b.d - 3), foot = box(0, 0, b.w - 1, b.d - 1);
  const cells = (b.w - 2) * (b.d - 3);
  return { key: rec.key + "|" + idx, idx, rec, b, x0: room[0], z0: room[1], x1: room[2], z1: room[3], fx0: foot[0], fz0: foot[1], fx1: foot[2], fz1: foot[3],
    y: b.y, cells, threshold: Math.ceil(cells / PEN_DENSITY), sheep: null, gate: at(b.du, 0), out: at(b.du, -1) };
}
function pensOf(rec) {
  if (!rec._pens) {
    rec._pens = [];
    const bl = (rec.wg && rec.wg.buildings) || [];
    bl.forEach((b, i) => { if (b.type === "pen") rec._pens.push(makePen(rec, b, i)); });
  }
  return rec._pens;
}
const penDist = (p, x, z) => Math.hypot(Math.max(p.fx0 - x, 0, x - p.fx1), Math.max(p.fz0 - z, 0, z - p.fz1));   // 0 inside the fence

let pending = new Map();      // village key -> [{i, s: [packed sheep]}] from a save, taken as each pen is first seen
const activePens = [];        // pens that are loaded and near the player (rebuilt by tickPens)
let hooked = false;

function seeded(str) {
  let h = 2166136261 ^ ((BF.state && BF.state.seed) | 0);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const packSt = s => [s.fed == null ? null : +s.fed.toFixed(3), s.shorn ? +(s.woolAt || 0).toFixed(3) : null, s.growAt == null ? null : +s.growAt.toFixed(3),
  +(s.cd || 0).toFixed(3), s.mob && live(s.mob) ? +s.mob.position.x.toFixed(2) : s.x, s.mob && live(s.mob) ? +s.mob.position.z.toFixed(2) : s.z];
function unpackSt(a) {
  const num = (x, d) => (x != null && Number.isFinite(+x) ? +x : d);
  if (!Array.isArray(a)) return null;
  return { fed: num(a[0], null), shorn: a[1] != null && Number.isFinite(+a[1]), woolAt: num(a[1], null), growAt: num(a[2], null), cd: num(a[3], 0), x: num(a[4], null), z: num(a[5], null), mob: null };
}
// Whether the village plan put a shepherd's loom on the ring right outside this pen (jobs.js planVillage `beside`).
function hasLoom(pen) {
  const b = pen.b, plan = (BF.jobs && BF.jobs.planFor && BF.jobs.planFor(pen.rec)) || [];
  for (const j of plan) {
    if (j.prof !== "shepherd") continue;
    for (let q = 1; q < b.d; q += 2) for (const u of [-1, b.w]) if (b.bx + b.ax * u + b.sx * q === j.x && b.bz + b.az * u + b.sz * q === j.z) return true;
  }
  return false;
}
function initPen(pen) {
  const rec = pending.get(pen.rec.key), at = rec && rec.findIndex(e => e && e.i === pen.idx);
  if (rec && at >= 0) {
    pen.sheep = (rec[at].s || []).map(unpackSt).filter(Boolean);
    rec.splice(at, 1);
    if (!rec.length) pending.delete(pen.rec.key);
    return;
  }
  pen.sheep = [];
  if (!hasLoom(pen)) return;   // only a pen with a shepherd's loom beside it starts with sheep (spare pens stay empty)
  const r = seeded("pen:" + pen.key), n = 2 + (r() < 0.5 ? 1 : 0) + (r() < 0.2 ? 1 : 0);   // a new pen starts with 2-4 sheep
  for (let i = 0; i < n; i++) pen.sheep.push({ fed: null, shorn: false, woolAt: null, growAt: null, cd: 0, x: pen.x0 + 0.6 + r() * (pen.x1 - pen.x0 - 1.2), z: pen.z0 + 0.6 + r() * (pen.z1 - pen.z0 - 1.2), mob: null });
}
function spawnSheep(pen, s) {
  const x = s.x != null && s.x > pen.x0 && s.x < pen.x1 ? s.x : (pen.x0 + pen.x1) / 2, z = s.z != null && s.z > pen.z0 && s.z < pen.z1 ? s.z : (pen.z0 + pen.z1) / 2;
  const gy = BF.world.heightAt(Math.floor(x), Math.floor(z));
  if (gy == null || gy < BF.MIN_Y + 1) return;
  const m = BF.mobs.spawn("sheep", x, gy + 1, z);
  if (!m) return;
  m.sheep = s; s.mob = m; m.pen = pen; m.penVillage = pen.rec;
  syncLook(m);
}
// Keeps every nearby loaded pen stocked: new pens get their sheep, sheep that were unloaded come back.
function tickPens() {
  const pp = BF.player && BF.player.position;
  activePens.length = 0;
  if (!pp || !BF.mobs || !BF.mobs.spawn) return;
  const W = BF.world;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec.wg || !rec.wg.buildings) continue;
    if (Math.hypot(rec.x - pp.x, rec.z - pp.z) > 80 && !(BF.villageSim && BF.villageSim.isActive(rec.key))) continue;
    for (const pen of pensOf(rec)) {
      if (!W.isLoaded(pen.fx0, pen.fz0) || !W.isLoaded(pen.fx1, pen.fz1) || !W.isLoaded(pen.fx0, pen.fz1) || !W.isLoaded(pen.fx1, pen.fz0)) continue;
      if (!pen.sheep) initPen(pen);
      activePens.push(pen);
      for (const s of pen.sheep) if (!s.mob || s.mob.removed || s.mob.dead) { s.mob = null; spawnSheep(pen, s); }
    }
  }
}
function leavePen(m) {
  const p = m.pen;
  if (p && p.sheep) { const i = p.sheep.indexOf(m.sheep); if (i >= 0) p.sheep.splice(i, 1); }
  m.pen = null; m.penVillage = null;
}
// A sheep wandered (or was led) into a pen: it joins its stock. One that got out for good leaves it.
function adoptOrRelease(m) {
  if (m.pen) { if (penDist(m.pen, m.position.x, m.position.z) > 2.5) leavePen(m); return; }
  for (const p of activePens) {
    if (m.position.x > p.x0 && m.position.x < p.x1 && m.position.z > p.z0 && m.position.z < p.z1 && Math.abs(m.position.y - (p.y + 1)) < 3 && p.sheep.length < p.threshold * 2) {
      const s = stOf(m);
      if (p.sheep.indexOf(s) < 0) p.sheep.push(s);
      s.mob = m; m.pen = p; m.penVillage = p.rec;
      return;
    }
  }
}
// Called from mobs.js pickWander for penned sheep: a random spot of the pen room.
function pickPenTarget(m) {
  const p = m.pen;
  if (!p) return false;
  m.ai.tx = p.x0 + 0.7 + Math.random() * (p.x1 - p.x0 - 1.4);
  m.ai.tz = p.z0 + 0.7 + Math.random() * (p.z1 - p.z0 - 1.4);
  return true;
}
// Called from mobs.js after the AI chose a velocity: a penned sheep never walks into the fence, the hay or out of the gate gap.
function contain(m, d) {
  const p = m.pen, pos = m.position;
  if (!p) return;
  if (penDist(p, pos.x, pos.z) > 1.5) { leavePen(m); return; }
  const M = 0.5, lx0 = p.x0 + M, lx1 = p.x1 - M, lz0 = p.z0 + M, lz1 = p.z1 - M;
  const nx = pos.x + d.x * 0.35, nz = pos.z + d.z * 0.35;
  if ((nx < lx0 && d.x < 0) || (nx > lx1 && d.x > 0)) d.x = 0;
  if ((nz < lz0 && d.z < 0) || (nz > lz1 && d.z > 0)) d.z = 0;
  if (pos.x < lx0 - 0.1) d.x = Math.max(d.x, 0.8); else if (pos.x > lx1 + 0.1) d.x = Math.min(d.x, -0.8);
  if (pos.z < lz0 - 0.1) d.z = Math.max(d.z, 0.8); else if (pos.z > lz1 + 0.1) d.z = Math.min(d.z, -0.8);
}

// ---------------------------------------------------------------- the global tick
let acc = 0, penT = 0;
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("mobKilled", m => { if (m && m.type === "sheep" && m.pen) leavePen(m); });
}
function tick(dt) {
  hook();
  acc += dt; penT -= dt;
  if (penT <= 0 && BF.world) { penT = 1; try { tickPens(); } catch (e) { console.error(e); } }
  if (acc < 0.5 || !BF.mobs) return;
  acc = 0;
  const t = now();
  for (const m of BF.mobs.list) {
    if (m.type !== "sheep" || !live(m)) continue;
    const s = stOf(m);
    if (s.growAt != null && t >= s.growAt) { s.growAt = null; s.cd = Math.max(s.cd, t); }
    if (s.shorn) {
      if (s.woolAt == null || s.woolAt - t > REGROW_DAYS * 2) s.woolAt = t + regrowDays();   // time was set back
      if (t >= s.woolAt) { s.shorn = false; s.woolAt = null; }
    }
    syncLook(m);
    adoptOrRelease(m);
  }
  // sheep that are not loaded keep growing wool and growing up: the states hold absolute days, so only the unloaded ones need a look
  for (const p of activePens) for (const s of p.sheep) {
    if (s.mob) continue;
    if (s.growAt != null && t >= s.growAt) s.growAt = null;
    if (s.shorn && s.woolAt != null && t >= s.woolAt) { s.shorn = false; s.woolAt = null; }
  }
}

// ---------------------------------------------------------------- persistence
function exportAll(out) {
  if (!BF.mobs) return;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec._pens) continue;
    const arr = [];
    for (const p of rec._pens) if (p.sheep) arr.push({ i: p.idx, s: p.sheep.map(packSt) });
    for (const e of pending.get(rec.key) || []) arr.push(e);
    if (arr.length) out["pens:" + rec.key] = arr;
  }
  for (const [k, v] of pending) if (!(("pens:" + k) in out) && v.length) out["pens:" + k] = v;
}
function importAll(o) {
  pending = new Map();
  if (!o || typeof o !== "object") return;
  for (const k in o) if (k.slice(0, 5) === "pens:" && Array.isArray(o[k])) pending.set(k.slice(5), o[k].filter(e => e && Number.isFinite(+e.i) && Array.isArray(e.s)));
}
function reset() { pending = new Map(); activePens.length = 0; acc = 0; penT = 0; }

// ---------------------------------------------------------------- the shepherd
const shp = m => m.shp || (m.shp = { task: null, stage: null, t: 0, actT: 0, cd: rnd(0, 2), avoid: new Map(), navFail: 0 });

// Starting kit: a shepherd alive when its village was generated starts with shears and 8 wheat (trading.js stockFor); one hired later gets
// emeralds and buys its shears (js/villagelife.js toolAI) and wheat. Kept as a no-op for callers of the old API.
function ensureKit() {}
// The pen this shepherd works: the one its loom stands beside (its footprint within 4 blocks of the loom).
function penOf(m) {
  const S = shp(m);
  if (S.penFor === m.jobsite && S.pen !== undefined) return S.pen;
  let best = null;
  if (m.jobsite && m.village) {
    let bd = 4.5;
    for (const p of pensOf(m.village)) { const d = penDist(p, m.jobsite.x + 0.5, m.jobsite.z + 0.5); if (d < bd) { bd = d; best = p; } }
  }
  S.penFor = m.jobsite; S.pen = best;
  return best;
}
// What the shepherd looks after: {pen, sheep (live mobs to feed / shear), flock (live mobs counted for crowding and culling), threshold}.
function tended(m) {
  const pen = penOf(m), list = BF.mobs.list;
  const home = m.jobsite ? { x: m.jobsite.x + 0.5, z: m.jobsite.z + 0.5 } : m.position;
  const near = o => o.type === "sheep" && live(o) && Math.hypot(o.position.x - home.x, o.position.z - home.z) <= (pen ? TEND_R : FREE_RADIUS) && Math.abs(o.position.y - m.position.y) < 6;
  let flock, threshold;
  if (pen && pen.sheep) { flock = pen.sheep.map(s => s.mob).filter(live); threshold = pen.threshold; }
  else { flock = list.filter(o => near(o) && !o.pen); threshold = FREE_THRESHOLD; }
  const sheep = flock.slice();
  if (pen) for (const o of list) if (near(o) && !o.pen) sheep.push(o);
  return { pen, flock, sheep, threshold };
}
const adults = a => a.filter(o => !isLamb(o));
// Wheat the shepherd wants to buy right now (0 = enough): under 2 days of feed it tops up to ~5 days.
function wheatWanted(m) {
  if (m.profession !== "shepherd" || !m.inv || !BF.mobs) return 0;
  const n = adults(tended(m).sheep).length;
  if (!n) return 0;
  const have = cnt(m, idsOf().wheat);
  if (have >= Math.max(4, n * 2)) return 0;
  return n * 5 + 4 - have;
}
function pickTask(m, S) {
  const T = tended(m), t = now(), c = idsOf(), sim = BF.simNow(), px = m.position.x, pz = m.position.z;
  const ok = o => !((S.avoid.get(o) || 0) > sim);
  const nearest = a => { let best = null, bd = Infinity; for (const o of a) { const d = Math.hypot(o.position.x - px, o.position.z - pz); if (d < bd) { bd = d; best = o; } } return best; };
  const ad = adults(T.sheep).filter(ok);
  if (cnt(m, c.wheat) > 0) { const o = nearest(ad.filter(x => hungry(x, t))); if (o) return { kind: "feed", mob: o }; }
  if (cnt(m, c.shears) > 0) { const o = nearest(ad.filter(x => !x.sheep.shorn)); if (o) return { kind: "shear", mob: o }; }
  if (T.flock.length >= T.threshold) {
    const pool = adults(T.flock).filter(ok);
    if (adults(T.flock).length > MIN_ADULTS) { const o = nearest(pool.filter(x => x.sheep.shorn)) || nearest(pool); if (o) return { kind: "cull", mob: o }; }   // shorn sheep first: their wool is already in the bag
  }
  return null;
}
function stillWanted(m, tk) {
  const o = tk.mob;
  if (!live(o) || isLamb(o)) return false;
  const t = now(), c = idsOf();
  if (tk.kind === "feed") return hungry(o, t) && cnt(m, c.wheat) > 0;
  if (tk.kind === "shear") return !o.sheep.shorn && cnt(m, c.shears) > 0;
  const T = tended(m);
  return T.flock.length >= T.threshold && adults(T.flock).length > MIN_ADULTS && T.flock.indexOf(o) >= 0;
}
function endTask(m, ok) {
  const S = shp(m);
  if (S.task && !ok) S.avoid.set(S.task.mob, BF.simNow() + 40);
  S.task = null; S.stage = null; m.ai.route = null;
}
function loot(m, id, n, where) {
  if (id == null || n <= 0) return;
  const left = TR().inv.add(m.inv, id, n);
  if (left > 0) dropItem(id, left, where);
}
function perform(m, tk) {
  const c = idsOf(), o = tk.mob, T = TR();
  if (tk.kind === "feed") {
    if (T.inv.remove(m.inv, c.wheat, 1) < 1) return false;
    if (!feed(o, m)) { T.inv.add(m.inv, c.wheat, 1); return false; }
    return true;
  }
  if (tk.kind === "shear") {
    const n = shear(o, m);
    if (n) loot(m, c.wool, n, o);
    return n > 0;
  }
  // cull: the shepherd keeps the mutton (and the wool the sheep still wears) instead of dropping it
  const wool = o.sheep && !o.sheep.shorn;
  BF.mobs.hurt(o, 999, "a shepherd");
  loot(m, c.mutton, rndInt(1, 2), o);
  if (wool) loot(m, c.wool, 1, o);
  return true;
}
const ACT = { feed: 0.7, shear: 1.1, cull: 0.8 };
// A shepherd with nothing to do inside a pen walks out through the gate (opening and closing it, mobs.js villagerDoors)
// and stands on the path outside, so it never wanders around stuck among the sheep. True while it is walking out.
function leave(m, S, dt, out) {
  const p = m.position;
  let pen = S.exit;
  if (!pen) {
    const R = m.village;
    if (!R) return false;
    pen = pensOf(R).find(q => p.x > q.fx0 && p.x < q.fx1 && p.z > q.fz0 && p.z < q.fz1 && Math.abs(p.y - (q.y + 1)) < 2);
    if (!pen) return false;
    S.exit = pen; S.exitT = 0; S.navFail = 0; m.ai.route = null;
  }
  S.exitT += dt;
  const N = BF.mobs.nav, [fx, fy, fz] = N.feetCell(m);
  if (!N.walkCell(fx, fy, fz) && S.exitT < 30) {   // perched on the fence (mobs step up one block): no path starts there, so walk off it towards the path outside
    const dx = pen.out[0] + 0.5 - p.x, dz = pen.out[1] + 0.5 - p.z, d = Math.hypot(dx, dz) || 1;
    m.ai.route = null; m.ai.mode = "idle"; m.ai.t = 2;
    out.x = dx / d * m.def.speed; out.z = dz / d * m.def.speed;
    return true;
  }
  const st = BF.villageLife.travel(m, S, dt, out, pen.out[0], pen.y + 1, pen.out[1], m.def.speed);
  if (st === "going" && S.exitT < 30) { m.ai.mode = "idle"; m.ai.t = 2; return true; }
  S.exit = null;
  return false;
}
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.tradingWith || !BF.mobs.nav || !BF.villageLife || m.sleeping) return false;
  const S = shp(m), ai = m.ai, t = skyT();
  if (t >= WORK_END || t < 0.02) { if (S.task) endTask(m, true); return t >= WORK_END && leave(m, S, dt, out); }
  if (!S.task && leave(m, S, dt, out)) return true;
  if (!S.task) {
    if ((S.cd -= dt) > 0) return false;
    S.cd = rnd(1.5, 3);
    const tk = pickTask(m, S);
    if (!tk) return false;
    S.task = tk; S.stage = "walk"; S.t = 0; S.navFail = 0; S.gx = null;
  }
  const tk = S.task, o = tk.mob;
  S.t += dt;
  if (S.t > TASK_MAX || !stillWanted(m, tk)) { endTask(m, S.t <= TASK_MAX); return false; }
  ai.mode = "idle"; ai.t = 2;
  const d = Math.hypot(o.position.x - m.position.x, o.position.z - m.position.z);
  const close = d <= 1.9 && Math.abs(o.position.y - m.position.y) < 1.6;
  if (S.stage === "walk") {
    if (close) { S.stage = "act"; S.actT = ACT[tk.kind]; ai.route = null; ai.swingT = 0.35; return true; }
    const g = { x: Math.floor(o.position.x), y: Math.floor(o.position.y + 0.01), z: Math.floor(o.position.z) };
    if (S.gx != null && Math.hypot(S.gx - g.x, S.gz - g.z) > 2) ai.route = null;   // the sheep moved: plan again
    S.gx = g.x; S.gz = g.z;
    const st = BF.villageLife.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.2);
    if (st === "failed") { endTask(m, false); return false; }
    if (st === "arrived") { S.stage = "act"; S.actT = ACT[tk.kind]; ai.swingT = 0.35; }
    return true;
  }
  if (d > 2.8) { S.stage = "walk"; return true; }
  out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o;
  if ((S.actT -= dt) <= 0) {
    let done = false;
    try { done = perform(m, tk); } catch (e) { console.error(e); }
    ai.swingT = 0.35;
    endTask(m, done);
    S.cd = rnd(0.4, 1);
  }
  return true;
}
function statusText(m) {
  const S = m.shp;
  if (!S || !S.task) return "";
  return { feed: "Feeding the sheep", shear: "Shearing a sheep", cull: "Culling the flock" }[S.task.kind] || "";
}

// ---------------------------------------------------------------- shears: recipe + sprite
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShapeless }) => {
  addShapeless(BF.I.shears, 1, [BF.I.iron_ingot, BF.I.iron_ingot, BF.I.iron_ingot], "3 Iron Ingots → Shears");
});
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, fuel }) => {
  if (BF.I.oak_fence_gate === undefined) return;
  addShaped(BF.I.oak_fence_gate, 1, ["SPS", "SPS"], { S: BF.I.stick, P: BF.I.planks }, "Stick, Planks, Stick \u00d7 2 rows (one wood) \u2192 Fence Gate of that wood");   // other woods: recipes-colour.js
  if (fuel) fuel([BF.I.oak_fence_gate], 15);
});
if (BF.texKit) {
  const { SPRITES, put, hex, mul, lighten, stroke, WHITE } = BF.texKit;
  SPRITES.shears = (G, m) => {
    const blade = lighten(m, 0.35), blade2 = mul(m, 0.82), grip = hex("#b0352e"), gripD = hex("#7a2020"), pin = hex("#4a4a54");
    for (let i = 0; i < 7; i++) { put(G, 8 + i, 8 - i, i === 6 ? WHITE : blade); put(G, 8 + i, 9 - i, blade2); put(G, 7 + i, 8 - i, i === 0 ? blade2 : lighten(m, 0.1)); }   // two blades side by side
    put(G, 15, 1, blade); put(G, 14, 1, blade2);
    const ring = (cx, cy, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - cx, y - cy); if (d > r - 0.7 && d < r + 0.55) put(G, x, y, x + y < cx + cy ? grip : gripD); } };
    stroke(G, 7, 9, 5, 11, gripD); stroke(G, 8, 10, 9, 12, gripD);   // the arms to the loops
    ring(3.5, 12, 2.1); ring(10.5, 13, 1.9);
    put(G, 7, 8, pin); put(G, 8, 9, pin);
  };
  SPRITES.oak_fence_gate = (G, m) => {   // two posts and a two-rail gate between them
    const d = mul(m, 0.7), l = lighten(m, 0.15);
    for (const x of [1, 2, 13, 14]) for (let y = 3; y <= 14; y++) put(G, x, y, x === 1 || x === 13 ? l : d);
    for (const y of [5, 6, 10, 11]) for (let x = 3; x <= 12; x++) put(G, x, y, y === 5 || y === 10 ? l : m);
    for (let y = 7; y <= 9; y++) for (const x of [7, 8]) put(G, x, y, x === 7 ? l : d);
  };
}

BF.shepherd = {
  FEED_DAYS, BREED_CD, LAMB_DAYS, REGROW_DAYS, PEN_DENSITY,
  feed, shear, playerUse, sheepAI, syncLook, hungry, willing, isLamb,
  pensOf, penOf, hasLoom, tended, wheatWanted, ensureKit, ai, tick, statusText, pickPenTarget, contain,
  exportAll, importAll, reset,
  pens: () => activePens,
};
})();
