// Pigs and the pig farmer (BF.pigFarmer). Loaded after js/glassmaker.js; uses js/herd.js (breeding, crowding, piglet growth, leading home,
// shared with js/cowherd.js). Hooks live in mobs.js, villagelife.js, jobs.js, trading.js, market.js, worldgen.js, blueprints.js / builder.js,
// player.js, storage.js, villagesim.js and debugfeed.js. See CONTRACT.md "Pig farmers (js/pigfarmer.js)". Modelled on js/cowherd.js.
//
// Pigs (every pig, wild or in a sty; state in `m.pig`):
//  - Fed: a carrot, potato or beetroot from the player or a pig farmer makes a pig willing to breed for FEED_DAYS (`fed` = absolute game day).
//  - Breeding: two willing adults within MATE_R walk to each other and a piglet appears; both then rest BREED_CD days. A piglet (`m.piglet`) is
//    smaller, drops nothing and grows up after PIGLET_DAYS (feed ages it by 10%). No breeding while 24 pigs stand within 16 blocks.
//  - Following: a pig within FOLLOW_R of a player holding pig feed walks after them. A pig farmer leads a wild pig home the same way.
//  - Wild pigs breed on their own too: js/wildlife.js (idea-037) makes a pair willing once a game day, then this file walks them together.
//  mobs.js only calls pigAI, the drop rule for piglets (`m.piglet`) and setYoungSize.
// Sties: a fenced pen (js/worldgen.js "sty" with village generator 9, or the builder's "sty" blueprint) with a gate, a coarse-dirt corner, a
//  water trough and a small roofed shelter. Each sty holds a list of pig states that outlives the pig mobs: a generated sty starts with 2-4
//  pigs, a builder's starts empty; respawned whenever the sty is loaded, saved as "sties:<village key>". Sty pigs root about only inside the
//  pen. The sty holds one pig per DENSITY cells (`limit`).
// Pig farmers (profession "pig_farmer", jobsite: the feed trough beside the sty gate): during work hours they feed hungry adults while the herd is
//  at or under the limit (carrots, potatoes or beetroot bought from the farmers, js/villagelife.js shopAI; FEED_KEEP kept back to lure a wild
//  pig home), cull adults while it is over the limit and never below MIN_ADULTS (1-3 raw porkchops each, kept to sell), and fetch a wild pig
//  within FIND_R when the sty holds fewer than STOCK_TO (once a day when there is none). They cook raw porkchops into cooked porkchops in a real
//  furnace with fuel they bought (js/furnaceuse.js, as the cowherd cooks steak). Nothing is created: no restock, no free feed or fuel.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const FEED_DAYS = 1;          // a pig is willing to breed for this long after eating
const BREED_CD = 1;           // days before a pig that bred can breed again
const PIGLET_DAYS = 3;        // days from birth to adult
const MATE_R = 10, MEET = 2;  // a willing pig looks for a mate this far; they breed when this close
const DENSITY = 8;            // one pig per this many sty cells
const MIN_ADULTS = 2;         // the pig farmer never culls below this many adults
const STOCK_TO = 2;           // it fetches wild pigs until its sty holds this many
const FIND_R = 100;           // how far it looks for a wild pig (100 for every keeper, idea-044)
const FOLLOW_R = 10;          // pigs follow a player holding feed from this far
const ADOPT_MAX = 24;         // a sty takes in wandering pigs up to this many
const FREE_RADIUS = 10;       // a pig farmer without a sty feeds the free pigs within 10 blocks of its trough
const TEND_R = 12;            // stray pigs this near the sty are fed too
const FEED_KEEP = 2;          // feed it keeps back for luring a pig home
const PORK_KEEP = 6;          // raw porkchops it keeps to sell (the butcher buys them); the rest is cooked ...
const COOKED_CAP = 24;        // ... while it holds fewer than this many cooked porkchops
const WORK_END = 0.5, COOK_END = 0.45;
const TASK_MAX = 45, LEAD_MAX = 240;
const FEED_NAMES = ["carrot", "potato", "beetroot"];

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const H = () => BF.herd;
const I = n => BF.I[n];
const cnt = (m, id) => (id == null || !m.inv ? 0 : TR().inv.count(m.inv, id));
const feedIds = () => FEED_NAMES.map(I).filter(id => id != null);
const isFeed = id => id != null && feedIds().includes(id);
const feedHeld = m => feedIds().reduce((a, id) => a + cnt(m, id), 0);
const LOG = [];
const log = (kind, data) => { LOG.push(Object.assign({ kind, day: +now().toFixed(3) }, data)); if (LOG.length > 300) LOG.shift(); };
const vlog = (m, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, "pigs", (BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Pig farmer") + " (Pig Farmer) " + text, m); };
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

// ---------------------------------------------------------------- pig state
function stOf(m) {
  if (!m.pig) m.pig = { fed: null, cd: 0, growAt: null, x: null, z: null, mob: m };
  return m.pig;
}
const isPiglet = m => !!(m.pig && m.pig.growAt != null);
const hungry = (m, t) => { const s = m.pig; return !s || s.fed == null || t - s.fed >= FEED_DAYS; };
const willing = (m, t) => { const s = m.pig; return !!(s && live(m) && s.growAt == null && s.fed != null && t - s.fed < FEED_DAYS && t >= s.cd); };

function syncLook(m) {
  const s = stOf(m), k = H().growK(s.growAt, now(), PIGLET_DAYS);
  m.piglet = k < 1;
  if (m._k == null || Math.abs(k - m._k) > 0.02 || (k >= 1 && m._k < 1)) { m._k = k; if (BF.mobs.setYoungSize) BF.mobs.setYoungSize(m, k, 1.4); }
}
function fx(m, color, n) { const V = BF.villageLife; if (V && V.particles && m.position) V.particles(m.position.x, m.position.y + m.height + 0.2, m.position.z, color, n, 0.4); }
function snd(name, m, vol) { const V = BF.villageLife; if (V && V.sound && m.position) V.sound(name, m.position.x, m.position.y + 0.5, m.position.z, vol); }

// Feed eaten by pig `m` (from the player or a pig farmer). Returns false for pigs that are not hungry; piglets grow 10% faster.
function feed(m, by) {
  if (!live(m) || m.type !== "pig") return false;
  const s = stOf(m), t = now();
  if (s.growAt != null) { s.growAt -= PIGLET_DAYS * 0.1; syncLook(m); fx(m, "#ffd84a", 4); snd("pig", m, 0.4); return true; }
  if (!hungry(m, t)) return false;
  s.fed = t;
  fx(m, "#ff5a7a", 5); snd("pig", m, 0.5);
  if (BF.emit) BF.emit("pigFed", m, by);
  return true;
}
// The player right-clicked a pig holding `sel`: a carrot, potato or beetroot feeds it. Returns true / a message (handled) or false (not ours).
function playerUse(m, sel) {
  if (!sel || !live(m) || !isFeed(sel.id)) return false;
  if (!m.piglet && !hungry(m, now())) return "The pig isn't hungry";
  if (!feed(m, "player")) return false;
  const inv = BF.inventory;
  if (!(BF.player && BF.player.gameMode === "creative") && inv && inv.consumeSelected) inv.consumeSelected(1);
  return true;
}
const playerFeed = () => {
  try { const s = BF.inventory && BF.inventory.selected && BF.inventory.selected(); return !!(s && s.count > 0 && isFeed(s.id)); } catch (e) { return false; }
};

// ---------------------------------------------------------------- breeding (js/herd.js does the walking and the crowding rule)
const findMate = (m, t) => H().findMate(m, t, willing, o => o.sty || null, MATE_R);
function breed(a, b, t) {
  const x = (a.position.x + b.position.x) / 2, z = (a.position.z + b.position.z) / 2, y = Math.max(a.position.y, b.position.y);
  const young = BF.mobs.spawn("pig", x, y, z);
  if (!young) return null;
  const s = stOf(young);
  s.growAt = t + PIGLET_DAYS; s.cd = t + PIGLET_DAYS + BREED_CD;
  stOf(a).cd = stOf(b).cd = t + BREED_CD;
  stOf(a).fed = stOf(b).fed = null;   // the meal is spent: they need feeding again to breed again
  const p = a.sty || b.sty;
  if (p && p.pigs) { s.mob = young; young.pig = s; p.pigs.push(s); young.sty = p; young.penVillage = p.rec; }
  syncLook(young);
  fx(a, "#ff5a7a", 5); fx(b, "#ff5a7a", 5); snd("pig", young, 0.5);
  a.mate = b.mate = null;
  log("bred", { sty: p ? p.key : null, herd: p ? p.pigs.length : null });
  if (p && BF.vlog) BF.vlog.log(p.rec, "pigs", "A piglet was born in the sty (" + plural(p.pigs.length, "pig") + ")", young);
  if (BF.emit) BF.emit("pigBorn", young, a, b);
  return young;
}

// ---------------------------------------------------------------- pig movement (mobs.js, before its wander AI): led home, tempted, or to a mate
const MATING = { willing, find: findMate, breed, mateR: MATE_R, meet: MEET };
function pigAI(m, dt, out) {
  const t = now(), sp = m.def.speed;
  if (m.ledBy) {   // walk the pig farmer's trail (through the gate) instead of straight at it
    const S = live(m.ledBy) ? m.ledBy.pgk : null;
    if (H().ledStep(m, dt, out, S, S && S.task && S.task.sty, inRoom)) return true;
  }
  if (!m.sty && BF.player && BF.player.position && !BF.player.dead && playerFeed()) {
    const p = BF.player.position, d = Math.hypot(p.x - m.position.x, p.z - m.position.z);
    if (d < FOLLOW_R && Math.abs(p.y - m.position.y) < 4) { m.lookAt = "player"; return H().follow(m, dt, out, p.x, p.z, 2, sp); }
  }
  return H().mateStep(m, dt, out, t, MATING);
}

// ---------------------------------------------------------------- sties
// A sty: {key, rec, idx ("g<n>" generated / "b<id>" built), gen, x0..x1 / z0..z1 (the pen the pigs keep to, block edges), fx0..fx1 / fz0..fz1
// (the fence footprint), y (ground level: pigs stand on y + 1), gate [x, z], out [x, z] (the path cell in front of the gate), cells, limit
// (cells / DENSITY), pigs (pig states, null until first seen), culls (pigs culled there, all time)}.
const limitOf = cells => Math.max(MIN_ADULTS, Math.floor(cells / DENSITY));
// The pen of a generated sty (worldgen "sty", 7 x 8): the 5 x 5 inside the fence in front of the trough row.
function makeGenSty(rec, b, idx) {
  const at = (u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
  const box = (u0, q0, u1, q1) => {
    const p = at(u0, q0), r = at(u1, q1);
    return [Math.min(p[0], r[0]), Math.min(p[1], r[1]), Math.max(p[0], r[0]) + 1, Math.max(p[1], r[1]) + 1];
  };
  const room = box(1, 1, b.w - 2, b.d - 3), foot = box(0, 0, b.w - 1, b.d - 1);   // the back row holds the water trough and the shelter's back
  const cells = (b.w - 2) * (b.d - 3);
  return { key: rec.key + "|" + idx, idx: "g" + idx, gen: true, viaOut: true, rec, x0: room[0], z0: room[1], x1: room[2], z1: room[3], fx0: foot[0], fz0: foot[1], fx1: foot[2], fz1: foot[3],
    y: b.y, cells, limit: limitOf(cells), pigs: null, culls: 0, gate: at(b.du, 0), out: at(b.du, -1) };
}
// A builder's sty (js/blueprints.js "sty"): read from the blueprint's marks (turned with the building).
function makeBuiltSty(rec, e) {
  const bp = BF.builder && BF.builder.bpOf ? BF.builder.bpOf(e) : BF.blueprints && BF.blueprints.get(e.type, e.rot, e.style, e.h, e.opts, e.wood);
  const M = bp && bp.marks;
  if (!M || !M.room || !M.gate || !M.out || !M.fence) return null;
  const at = ([x, z]) => [e.ox + x, e.oz + z], R = M.room.map(at), F = M.fence.map(at);
  const x0 = Math.min(R[0][0], R[1][0]), z0 = Math.min(R[0][1], R[1][1]), x1 = Math.max(R[0][0], R[1][0]) + 1, z1 = Math.max(R[0][1], R[1][1]) + 1;
  const cells = (x1 - x0) * (z1 - z0);
  return { key: rec.key + "|b" + e.id, idx: "b" + e.id, gen: false, viaOut: true, rec, x0, z0, x1, z1,
    fx0: Math.min(F[0][0], F[1][0]), fz0: Math.min(F[0][1], F[1][1]), fx1: Math.max(F[0][0], F[1][0]) + 1, fz1: Math.max(F[0][1], F[1][1]) + 1,
    y: e.oy - 1, cells, limit: limitOf(cells), pigs: null, culls: 0, gate: at(M.gate[0]), out: at(M.out[0]) };
}
function stiesOf(rec) {
  if (!rec) return [];
  if (!rec._sties) {
    Object.defineProperty(rec, "_sties", { value: [], writable: true, enumerable: false, configurable: true });
    const bl = (rec.wg && rec.wg.buildings) || [];
    bl.forEach((b, i) => { if (b.type === "sty") rec._sties.push(makeGenSty(rec, b, i)); });
  }
  for (const e of rec.built || []) {   // builders' sties join once they are finished
    if (e.type !== "sty" || e.state !== "done" || rec._sties.some(k => k.idx === "b" + e.id)) continue;
    const k = makeBuiltSty(rec, e);
    if (k) rec._sties.push(k);
  }
  return rec._sties;
}
const fenceDist = (p, x, z) => Math.hypot(Math.max(p.fx0 - x, 0, x - p.fx1), Math.max(p.fz0 - z, 0, z - p.fz1));   // 0 inside the fence
const inRoom = (p, pos) => pos.x > p.x0 && pos.x < p.x1 && pos.z > p.z0 && pos.z < p.z1 && Math.abs(pos.y - (p.y + 1)) < 3;
// Any village (idea-044: sties are no longer for grass villages only; builders weigh them through the food jobsite roll, js/builder.js chooseFood).
const villageOK = R => !!R;

let pending = new Map();      // village key -> [{i, p: [packed], k: culls}] from a save, taken as each sty is first seen
const activeSties = [];       // sties that are loaded and near the player (rebuilt by tickSties)
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
const fix3 = v => (v == null ? null : +(+v).toFixed(3));
const packSt = s => [fix3(s.fed), fix3(s.cd || 0), fix3(s.growAt),
  s.mob && live(s.mob) ? +s.mob.position.x.toFixed(2) : s.x, s.mob && live(s.mob) ? +s.mob.position.z.toFixed(2) : s.z];
function unpackSt(a) {
  const num = (x, d) => (x != null && Number.isFinite(+x) ? +x : d);
  if (!Array.isArray(a)) return null;
  return { fed: num(a[0], null), cd: num(a[1], 0), growAt: num(a[2], null), x: num(a[3], null), z: num(a[4], null), mob: null };
}
function initSty(p) {
  const rec = pending.get(p.rec.key), at = rec && rec.findIndex(e => e && String(e.i) === p.idx);
  if (rec && at >= 0) {
    p.pigs = (rec[at].p || []).map(unpackSt).filter(Boolean);
    p.culls = Math.max(0, rec[at].k | 0);
    rec.splice(at, 1);
    if (!rec.length) pending.delete(p.rec.key);
    return;
  }
  p.pigs = [];
  if (!p.gen) return;   // a builder's sty starts empty: the pig farmer stocks it from wild pigs
  const r = seeded("sty:" + p.key), n = 2 + (r() < 0.5 ? 1 : 0) + (r() < 0.2 ? 1 : 0);   // a generated sty starts with 2-4 pigs
  for (let i = 0; i < n; i++) p.pigs.push({ fed: null, cd: 0, growAt: null, x: p.x0 + 0.8 + r() * (p.x1 - p.x0 - 1.6), z: p.z0 + 0.8 + r() * (p.z1 - p.z0 - 1.6), mob: null });
}
function spawnPig(p, s) {
  const x = s.x != null && s.x > p.x0 && s.x < p.x1 ? s.x : (p.x0 + p.x1) / 2, z = s.z != null && s.z > p.z0 && s.z < p.z1 ? s.z : (p.z0 + p.z1) / 2;
  const gy = BF.world.heightAt(Math.floor(x), Math.floor(z));
  if (gy == null || gy < BF.MIN_Y + 1) return;
  const m = BF.mobs.spawn("pig", x, gy + 1, z);
  if (!m) return;
  m.pig = s; s.mob = m; m.sty = p; m.penVillage = p.rec;
  syncLook(m);
}
function tickSties() {
  const pp = BF.player && BF.player.position;
  activeSties.length = 0;
  if (!pp || !BF.mobs || !BF.mobs.spawn) return;
  const W = BF.world;
  for (const rec of BF.mobs.villages.values()) {
    if (!(rec.wg && (rec.wg.buildings || []).some(b => b.type === "sty")) && !(rec.built || []).some(e => e.type === "sty")) continue;
    if (Math.hypot(rec.x - pp.x, rec.z - pp.z) > 80 && !(BF.villageSim && BF.villageSim.isActive(rec.key))) continue;
    for (const p of stiesOf(rec)) {
      if (!W.isLoaded(p.fx0, p.fz0) || !W.isLoaded(p.fx1, p.fz1) || !W.isLoaded(p.fx0, p.fz1) || !W.isLoaded(p.fx1, p.fz0)) continue;
      if (!p.pigs) initSty(p);
      activeSties.push(p);
      for (const s of p.pigs) if (!s.mob || s.mob.removed || s.mob.dead) { s.mob = null; spawnPig(p, s); }
    }
  }
}
function leaveSty(m) {
  const p = m.sty;
  if (p && p.pigs) { const i = p.pigs.indexOf(m.pig); if (i >= 0) { p.pigs.splice(i, 1); if (!m.dead) log("left", { sty: p.key, herd: p.pigs.length }); } }
  m.sty = null; m.penVillage = null;
}
// A pig that walked (or was led) into a sty joins its herd; one that got out for good leaves it.
function adoptOrRelease(m) {
  if (m.sty) { if (fenceDist(m.sty, m.position.x, m.position.z) > 2.5) leaveSty(m); return; }
  for (const p of activeSties) {
    if (inRoom(p, m.position) && p.pigs.length < ADOPT_MAX) {
      const s = stOf(m);
      if (p.pigs.indexOf(s) < 0) p.pigs.push(s);
      const led = !!m.ledBy;
      s.mob = m; m.sty = p; m.penVillage = p.rec; m.ledBy = null;
      if (!led) log("joined", { sty: p.key, herd: p.pigs.length });   // walked in by itself (a led pig is logged as stocked)
      if (BF.emit) BF.emit("pigPenned", m, p);
      return;
    }
  }
}
function pickStyTarget(m) {
  const p = m.sty;
  if (!p) return false;
  m.ai.tx = p.x0 + 0.8 + Math.random() * (p.x1 - p.x0 - 1.6);
  m.ai.tz = p.z0 + 0.8 + Math.random() * (p.z1 - p.z0 - 1.6);
  return true;
}
// A sty pig never walks into the fence or out of the gate.
function contain(m, d) {
  const p = m.sty, pos = m.position;
  if (!p) return;
  if (fenceDist(p, pos.x, pos.z) > 1.5) { leaveSty(m); return; }
  const M = 0.5, lx0 = p.x0 + M, lx1 = p.x1 - M, lz0 = p.z0 + M, lz1 = p.z1 - M;
  const nx = pos.x + d.x * 0.35, nz = pos.z + d.z * 0.35;
  if ((nx < lx0 && d.x < 0) || (nx > lx1 && d.x > 0)) d.x = 0;
  if ((nz < lz0 && d.z < 0) || (nz > lz1 && d.z > 0)) d.z = 0;
  if (pos.x < lx0 - 0.1) d.x = Math.max(d.x, 0.8); else if (pos.x > lx1 + 0.1) d.x = Math.min(d.x, -0.8);
  if (pos.z < lz0 - 0.1) d.z = Math.max(d.z, 0.8); else if (pos.z > lz1 + 0.1) d.z = Math.min(d.z, -0.8);
}

// ---------------------------------------------------------------- the global tick: piglets growing up, sty stock
let acc = 0, styT = 0;
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("mobKilled", m => { if (m && m.type === "pig" && m.sty) leaveSty(m); });
}
function tick(dt) {
  hook();
  acc += dt; styT -= dt;
  if (styT <= 0 && BF.world) { styT = 1; try { tickSties(); } catch (e) { console.error(e); } }
  if (acc < 0.5 || !BF.mobs) return;
  acc = 0;
  if (H().toShut.length) H().shutGates();
  const t = now();
  for (const m of BF.mobs.list) {
    if (m.type !== "pig" || !live(m)) continue;
    const s = stOf(m);
    if (s.growAt != null && t >= s.growAt) { s.growAt = null; s.cd = Math.max(s.cd, t); }
    if (s.growAt != null && s.growAt - t > PIGLET_DAYS * 2) s.growAt = t + PIGLET_DAYS;   // time was set back
    syncLook(m);
    adoptOrRelease(m);
  }
  for (const p of activeSties) for (const s of p.pigs) if (!s.mob && s.growAt != null && t >= s.growAt) s.growAt = null;   // unloaded piglets grow up too
}

// ---------------------------------------------------------------- persistence
function exportAll(out) {
  if (!BF.mobs) return;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec._sties) continue;
    const arr = [];
    for (const p of rec._sties) if (p.pigs) arr.push({ i: p.idx, p: p.pigs.map(packSt), k: p.culls | 0 });
    for (const e of pending.get(rec.key) || []) arr.push(e);
    if (arr.length) out["sties:" + rec.key] = arr;
  }
  for (const [k, v] of pending) if (!(("sties:" + k) in out) && v.length) out["sties:" + k] = v;
}
function importAll(o) {
  pending = new Map();
  if (!o || typeof o !== "object") return;
  for (const k in o) if (k.slice(0, 6) === "sties:" && Array.isArray(o[k])) pending.set(k.slice(6), o[k].filter(e => e && e.i != null && Array.isArray(e.p)));
}
function reset() { pending = new Map(); activeSties.length = 0; acc = 0; styT = 0; LOG.length = 0; }

// ---------------------------------------------------------------- the starting pack
// A generated pig farmer starts with a few days' feed (and the usual emeralds, trading.js stockFor); one hired later starts with nothing extra
// (js/jobs.js hire) and buys its feed. Never porkchops.
function seed(a) {
  if (!Array.isArray(a)) return;
  if (I("carrot") != null) TR().inv.add(a, I("carrot"), rndInt(6, 10));
  if (I("potato") != null) TR().inv.add(a, I("potato"), rndInt(4, 8));
}

// ---------------------------------------------------------------- the pig farmer
const pgk = m => m.pgk || (m.pgk = { task: null, stage: null, t: 0, actT: 0, cd: rnd(0, 2), avoid: new Map(), navFail: 0, stockAt: 0, trail: [], trailBase: 0 });
// The sty this pig farmer works: the one its feed trough stands beside (fence within 4.5 blocks).
function styOf(m) {
  const S = pgk(m);
  if (!m.jobsite || !m.village) return null;
  if (S.pFor === m.jobsite && S.sty && stiesOf(m.village).includes(S.sty)) return S.sty;
  let best = null, bd = 4.5;
  for (const p of stiesOf(m.village)) { const d = fenceDist(p, m.jobsite.x + 0.5, m.jobsite.z + 0.5); if (d < bd) { bd = d; best = p; } }
  S.pFor = m.jobsite; S.sty = best;
  return best;
}
// What the pig farmer looks after: {sty, herd (live sty pigs, counted for culling), pigs (live pigs to feed: the herd and strays near it, or
// without a sty the free pigs near the trough), size (the herd, unloaded ones too), limit}.
function tended(m) {
  const p = styOf(m), list = BF.mobs.list;
  const home = m.jobsite ? { x: m.jobsite.x + 0.5, z: m.jobsite.z + 0.5 } : m.position;
  const near = o => o.type === "pig" && live(o) && !o.ledBy && !o.sty && Math.hypot(o.position.x - home.x, o.position.z - home.z) <= (p ? TEND_R : FREE_RADIUS) && Math.abs(o.position.y - m.position.y) < 6;
  const herd = p && p.pigs ? p.pigs.map(s => s.mob).filter(live) : [];
  return { sty: p, herd, pigs: herd.concat(list.filter(near)), size: p && p.pigs ? p.pigs.length : 0, limit: p ? p.limit : 0 };
}
const adults = a => a.filter(o => !isPiglet(o));
const adultStates = p => (p && p.pigs ? p.pigs.filter(s => s.growAt == null).length : 0);
// Feed it wants to buy now (0 = enough): under a feed per adult plus FEED_KEEP it tops up to ~2 days of feed plus the lure. None without a sty.
function feedWanted(m) {
  if (m.profession !== "pig_farmer" || !m.inv || !BF.mobs) return 0;
  const p = styOf(m);
  if (!p) return 0;
  const n = Math.max(STOCK_TO, adultStates(p)), have = feedHeld(m);
  if (have >= n + FEED_KEEP) return 0;
  return n * 2 + FEED_KEEP + 2 - have;
}
// Its market reserve (js/market.js reserve: nothing in it is sold, to villagers or the player): all its pig feed (and what it still wants), and up
// to 16 of the fuel it holds (it bought it to cook pork).
function reserve(m) {
  if (m.profession !== "pig_farmer" || !Array.isArray(m.inv)) return [];
  const ids = new Set(feedIds()), out = ids.size ? [{ ids, n: feedHeld(m) + feedWanted(m) }] : [];
  const F = BF.furnaceUse, fuel = new Set();   // the fuel it bought to cook its pork: never sold on as spare goods (js/market.js spareOf)
  if (F) for (const s of m.inv) if (s && F.isFuel(s.id)) fuel.add(s.id);
  if (fuel.size) out.push({ ids: fuel, n: 16 });
  return out;
}
// Food it never eats (js/villagelife.js reserveOf): its pigs' feed and its raw porkchops (to sell or cook).
// Its wares (js/market.js spareOf): raw and cooked porkchops sell whatever food it holds besides (they are not its meals).
const isWare = id => id != null && (id === I("raw_porkchop") || id === I("cooked_porkchop"));
const keepsFood = (m, id) => !!(m && m.profession === "pig_farmer" && (isFeed(id) || id === I("raw_porkchop")));
// Whether feeding pig o now keeps the herd within one over its limit once the willing pigs have paired up (each pair gives one piglet); the
// cull then takes it back to the limit. Fed strays near the sty count as if they had walked in (they can, and then breed in the herd).
function feedOk(T, o, t) {
  if (!T.sty) return true;
  const strays = adults(T.pigs).filter(x => x.sty !== T.sty);
  const willingHerd = adults(T.herd).filter(x => !hungry(x, t)).length, willingStray = strays.filter(x => !hungry(x, t)).length;
  const join = o.sty !== T.sty ? 1 : 0;
  return T.size + willingStray + join + Math.floor((willingHerd + willingStray + 1) / 2) <= T.limit + 1;
}
function wildPig(m, p, S) {
  const c = { x: (p.x0 + p.x1) / 2, z: (p.z0 + p.z1) / 2 }, sim = BF.simNow();
  let best = null, bd = FIND_R;
  for (const o of BF.mobs.list) {
    if (o.type !== "pig" || !live(o) || o.sty || o.ledBy || isPiglet(o) || o.riding || (S.avoid.get(o) || 0) > sim) continue;
    const d = Math.hypot(o.position.x - c.x, o.position.z - c.z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
function pickTask(m, S) {
  const T = tended(m), t = now(), sim = BF.simNow(), px = m.position.x, pz = m.position.z;
  const ok = o => !((S.avoid.get(o) || 0) > sim);
  const nearest = a => { let best = null, bd = Infinity; for (const o of a) { const d = Math.hypot(o.position.x - px, o.position.z - pz); if (d < bd) { bd = d; best = o; } } return best; };
  const p = T.sty;
  if (!p) return null;   // without a sty it has no herd to keep
  const have = feedHeld(m), spare = have - FEED_KEEP;   // FEED_KEEP are always kept to lure a wild pig home
  const ad = adults(T.pigs).filter(ok);
  if (spare > 0 && T.size <= T.limit) { const o = nearest(ad.filter(x => hungry(x, t) && feedOk(T, x, t))); if (o) return { kind: "feed", mob: o }; }
  if (T.size > T.limit && adults(T.herd).length > MIN_ADULTS && adultStates(p) > MIN_ADULTS) { const o = nearest(adults(T.herd).filter(ok)); if (o) return { kind: "cull", mob: o }; }
  if (p.pigs && p.pigs.length < STOCK_TO && have > 0 && t >= S.stockAt) {
    const o = wildPig(m, p, S);
    if (o) return { kind: "fetch", mob: o, sty: p };
    if (wildPig(m, p, { avoid: new Map() })) { S.stockAt = t + 0.1; return null; }   // only ones it just failed to bring in: tries them again in a while
    S.stockAt = Math.floor(t) + 1 + 0.03;   // none in range: look again tomorrow morning
    log("noWild", { sty: p.key });
    vlog(m, "found no wild pigs within " + FIND_R + " blocks of the sty; will look again tomorrow");
  }
  return null;
}
function stillWanted(m, tk) {
  const o = tk.mob;
  if (!live(o)) return false;
  if (tk.kind === "fetch") return !o.sty && feedHeld(m) > 0 && !(o.ledBy && o.ledBy !== m);
  if (isPiglet(o)) return false;
  const T = tended(m);
  if (tk.kind === "feed") return hungry(o, now()) && feedHeld(m) > FEED_KEEP && T.size <= T.limit && feedOk(T, o, now());
  return T.size > T.limit && adults(T.herd).length > MIN_ADULTS && adultStates(T.sty) > MIN_ADULTS && T.herd.indexOf(o) >= 0;
}
const vdone = m => { if (BF.villageSim && BF.villageSim.done) BF.villageSim.done(m); };
function endTask(m, ok) {
  const S = pgk(m), tk = S.task;
  if (tk && !ok && tk.mob) S.avoid.set(tk.mob, BF.simNow() + (tk.kind === "fetch" ? 120 : 40));
  if (tk && tk.mob && tk.mob.ledBy === m) tk.mob.ledBy = null;
  H().releaseGate(m, S);
  S.task = null; S.stage = null; m.ai.route = null; S.trail = []; S.trailBase = 0;
  vdone(m);
}
function loot(m, id, n, where) {
  if (id == null || n <= 0) return 0;
  const left = TR().inv.add(m.inv, id, n);
  if (left > 0 && BF.drops && where && where.position) BF.drops.spawn(id, left, where.position.x, where.position.y + 0.6, where.position.z);
  return n - left;
}
// The feed it gives: the kind it holds most of.
function feedPick(m) {
  let best = null, bn = 0;
  for (const id of feedIds()) { const n = cnt(m, id); if (n > bn) { bn = n; best = id; } }
  return best;
}
function perform(m, tk) {
  const T = TR().inv, o = tk.mob;
  if (tk.kind === "feed") {
    const id = feedPick(m);
    if (id == null || T.remove(m.inv, id, 1) < 1) return false;
    if (!feed(o, m)) { T.add(m.inv, id, 1); return false; }
    log("fed", { item: BF.items[id].name, sty: !!o.sty });
    return true;
  }
  // cull: the pig farmer keeps the pig's drops (1-3 raw porkchops) to sell or cook
  const herdP = o.sty;
  BF.mobs.hurt(o, 999, "a pig farmer");
  const pork = loot(m, I("raw_porkchop"), rndInt(1, 3), o);
  if (herdP) herdP.culls = (herdP.culls | 0) + 1;
  const T2 = tended(m);
  log("culled", { pork, herd: T2.size, limit: T2.limit });
  vlog(m, "culled a pig (" + T2.size + " left, the sty holds " + T2.limit + "): " + pork + " raw porkchop" + (pork === 1 ? "" : "s"));
  if (BF.emit) BF.emit("pigCulled", o, m, pork);
  return true;
}
const ACT = { feed: 0.7, cull: 0.8 };
// A pig farmer with nothing to do inside a sty walks out through the gate, so it never stands about among the pigs.
function leave(m, S, dt, out) {
  const p = m.position;
  let P = S.exit;
  if (!P) {
    const R = m.village;
    if (!R) return false;
    P = stiesOf(R).find(q => p.x > q.fx0 && p.x < q.fx1 && p.z > q.fz0 && p.z < q.fz1 && Math.abs(p.y - (q.y + 1)) < 2 && q.out);
    if (!P) return false;
    S.exit = P; S.exitT = 0; S.navFail = 0; m.ai.route = null;
  }
  S.exitT += dt;
  const N = BF.mobs.nav, [fx, fy, fz] = N.feetCell(m);
  if (!N.walkCell(fx, fy, fz) && S.exitT < 30) {   // perched on the fence: walk off it towards the path outside
    const dx = P.out[0] + 0.5 - p.x, dz = P.out[1] + 0.5 - p.z, d = Math.hypot(dx, dz) || 1;
    m.ai.route = null; m.ai.mode = "idle"; m.ai.t = 2;
    out.x = dx / d * m.def.speed; out.z = dz / d * m.def.speed;
    return true;
  }
  const st = BF.villageLife.travel(m, S, dt, out, P.out[0], P.y + 1, P.out[1], m.def.speed);
  if (st === "going" && S.exitT < 30) { m.ai.mode = "idle"; m.ai.t = 2; return true; }
  S.exit = null;
  return false;
}
// Where it waits while the pig goes in: a step further out than the cell in front of the gate, so that cell (the pig's way in, with the trough on
// one side of it) stays free and the gate stays within reach (js/herd.js lead holds it open from 3 blocks).
const standOf = P => [2 * P.out[0] - P.gate[0], 2 * P.out[1] - P.gate[1]];
// Leading a wild pig home: to the path in front of the gate, then into the middle of the sty (js/herd.js lead; the pig walks the trail, pigAI).
function lead(m, S, tk, dt, out) {
  const P = tk.sty;
  return H().lead(m, S, tk, dt, out, {
    pen: P, max: LEAD_MAX, penned: o => o.sty === P, stand: standOf(P),
    arrived: () => {
      log("stocked", { sty: P.key, herd: P.pigs.length });
      vlog(m, "brought a wild pig into the sty (" + plural(P.pigs.length, "pig") + ")");
      endTask(m, true); S.cd = rnd(0.5, 1);
    },
    failed: (why, d) => { log("leadFailed", why === "nopath" ? { why } : { why, d: +d.toFixed(1) }); endTask(m, false); },
  });
}
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.tradingWith || !BF.mobs.nav || !BF.villageLife || m.sleeping) return false;
  const S = pgk(m), ai = m.ai, t = skyT();
  if (t >= WORK_END || t < 0.02) { if (S.task) endTask(m, true); return t >= WORK_END && leave(m, S, dt, out); }
  if (!S.task && leave(m, S, dt, out)) return true;
  if (!S.task) {
    if ((S.cd -= dt) > 0) return cookAI(m, dt, out, false);
    S.cd = rnd(1.5, 3);
    const tk = pickTask(m, S);
    if (!tk) return cookAI(m, dt, out, false);
    const VS = BF.villageSim;
    if (VS && VS.begin) {   // estimate: walk there + the action; a fetch walks out to the pig, leads it (slower) to the gate and waits for it to go in
      let est;
      const what = { feed: "Feeding the pigs", cull: "Culling a pig", fetch: "Fetching a wild pig" }[tk.kind];
      if (tk.kind === "fetch") { const w1 = VS.walkSecs(m, [[tk.mob.position.x, tk.mob.position.z]]); est = w1 / 1.2 + (VS.walkSecs(m, [[tk.mob.position.x, tk.mob.position.z], tk.sty.out]) - w1) / 0.8 + 8; }
      else est = VS.walkSecs(m, [[tk.mob.position.x, tk.mob.position.z]]) + ACT[tk.kind];
      if (!VS.begin(m, est, what)) return cookAI(m, dt, out, false);
    }
    S.task = tk; S.stage = "walk"; S.t = 0; S.navFail = 0; S.gx = null; S.lostT = 0;
    if (tk.kind === "fetch") { log("fetch", { d: +Math.hypot(tk.mob.position.x - m.position.x, tk.mob.position.z - m.position.z).toFixed(1) }); vlog(m, "went to fetch a wild pig for the sty"); }
  }
  const tk = S.task;
  S.t += dt;
  if (tk.kind === "fetch" && tk.sty && tk.mob.sty === tk.sty) return lead(m, S, tk, dt, out);   // it walked in: lead() logs it and ends the task
  const limit = tk.kind === "fetch" ? LEAD_MAX : TASK_MAX;
  if (S.t > limit || !stillWanted(m, tk)) {
    if (tk.kind === "fetch") log("leadFailed", { why: S.t > limit ? "slow" : "unwanted", stage: S.stage });
    endTask(m, S.t <= limit && tk.kind !== "fetch"); return false;
  }
  ai.mode = "idle"; ai.t = 2;
  if (tk.kind === "fetch" && S.stage !== "walk") return lead(m, S, tk, dt, out);
  const at = tk.mob.position;
  const d = Math.hypot(at.x - m.position.x, at.z - m.position.z);
  const close = d <= 2.3 && Math.abs(at.y - m.position.y) < 1.6;
  if (S.stage === "walk") {
    if (close) {
      if (tk.kind === "fetch") { H().startLead(m, S, tk); return true; }
      S.stage = "act"; S.actT = ACT[tk.kind]; ai.route = null; ai.swingT = 0.35; return true;
    }
    const g = { x: Math.floor(at.x), y: Math.floor(at.y + 0.01), z: Math.floor(at.z) };
    if (S.gx != null && Math.hypot(S.gx - g.x, S.gz - g.z) > 2) ai.route = null;   // the pig moved: plan again
    S.gx = g.x; S.gz = g.z;
    const st = BF.villageLife.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.2);
    if (st === "failed") { if (tk.kind === "fetch") log("leadFailed", { why: "nopath", stage: "walk", d: +d.toFixed(1) }); endTask(m, false); return false; }
    if (st === "arrived" && tk.kind !== "fetch") { S.stage = "act"; S.actT = ACT[tk.kind]; ai.swingT = 0.35; }
    return true;
  }
  if (d > 3.2) { S.stage = "walk"; return true; }
  out.faceX = at.x; out.faceZ = at.z; m.lookAt = tk.mob;
  if ((S.actT -= dt) <= 0) {
    let done = false;
    try { done = perform(m, tk); } catch (e) { console.error(e); }
    ai.swingT = 0.35;
    endTask(m, done);
    S.cd = rnd(0.4, 1);
  }
  return true;
}

// ---------------------------------------------------------------- cooking pork in a furnace (js/furnaceuse.js; the errand of js/cowherd.js)
// It cooks the raw porkchops it holds beyond PORK_KEEP (kept to sell) into cooked porkchops, while it holds fewer than COOKED_CAP, in a real
// furnace of its village with fuel it holds or buys (coal first; wood it does not sell). Never instantly, never without a furnace and fuel.
const FU = () => BF.furnaceUse;
const RAW = () => I("raw_porkchop"), COOKED = () => I("cooked_porkchop");
const CHECK = 4, TRADE_PAUSE = 1.6;
const cst = m => m.pgc || (m.pgc = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0 });
const avoided = (S, k) => (S.avoid[k] || 0) > now();
function toCook(m) {
  if (RAW() == null || COOKED() == null) return 0;
  const n = Math.min(cnt(m, RAW()) - PORK_KEEP, COOKED_CAP - cnt(m, COOKED()), 16);
  return n >= 3 ? n : 0;
}
const fuelOk = m => id => FU().isCoal(id) || !(m.trades || []).some(o => o && !o.spare && !o.need && o.sell && o.sell.id === id);   // never burns its job's wares (a spare-goods offer doesn't count, js/market.js)
const skipFurnace = S => f => avoided(S, "f:" + FU().pk(f.x, f.y, f.z));
const skipOffer = S => (v2, o) => avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id);
function cookPlan(m, n) {
  const F = FU(), S = cst(m), fs = F.near(m, RAW(), COOKED(), skipFurnace(S));
  if (!fs.length) return null;
  const f = fs[0], ok = fuelOk(m), budget = cnt(m, I("emerald"));
  if (F.fuelIn(f) >= n || F.fuelFor(m, Math.max(0, n - F.fuelIn(f)), ok).length) return { furnace: f };
  const coal = Math.ceil(n / F.PER_COAL), cc = F.priceOf(m, F.isCoal, coal, false, skipOffer(S));
  if (cc <= budget) return { furnace: f, need: { what: "fuel", f: F.isCoal, n: coal } };
  const wood = id => (F.isLog(id) || F.isPlanks(id)) && ok(id), w = Math.ceil(n / F.PER_WOOD), wc = F.priceOf(m, wood, w, false, skipOffer(S));
  if (wc <= budget) return { furnace: f, need: { what: "fuel", f: wood, n: w } };
  return null;
}
function nextTrip(m) {
  const n = toCook(m);
  if (!n) return null;
  const p = cookPlan(m, n);
  if (!p) return null;
  if (p.need) return FU().findDeal(m, p.need, skipOffer(cst(m)));
  return { kind: "cook", furnace: p.furnace, rawId: RAW(), outId: COOKED(), n, fuelOk: fuelOk(m) };
}
function finishCook(m, deal, all) {
  const F = FU(), f = deal.furnace, got = F.empty(m, deal, all) || [];
  const cooked = got.filter(e => e.id === COOKED()).reduce((a, e) => a + e.n, 0);
  log("cooked", { pork: cooked, loaded: deal.loaded || 0, at: F.pk(f.x, f.y, f.z) });
  if (cooked > 0) vlog(m, "cooked " + cooked + " porkchop" + (cooked === 1 ? "" : "s") + " in the furnace at " + F.pk(f.x, f.y, f.z));
}
// Villager AI step (mobs.js villagerAI early with cont = true to carry on an errand under way; ai() above when it has no herd work).
function cookAI(m, dt, out, cont) {
  if (cont && !(m.pgc && m.pgc.stage)) return false;
  if (!m.inv || m.dead || m.child || m.type !== "villager" || !BF.mobs || !BF.mobs.nav || !m.village || !FU() || RAW() == null || COOKED() == null) return false;
  const F = FU(), S = cst(m), a = m.ai;
  if (skyT() >= COOK_END || m.tradingWith) {
    if (S.stage) { if (S.deal && S.deal.kind === "cook" && S.deal.loaded) finishCook(m, S.deal, true); S.stage = null; S.deal = null; vdone(m); a.route = null; }
    return false;
  }
  if (!S.stage) {
    if (cont) return false;
    S.checkT -= dt;
    if (S.checkT > 0) return false;
    S.checkT = CHECK;
    if (S.cd > now()) return false;
    const deal = nextTrip(m);
    if (!deal) { S.cd = now() + 0.03; return false; }
    const VS = BF.villageSim, o = deal.kind === "cook" ? deal.furnace : deal.other && deal.other.position;   // estimate: walk there, the pause, and (cooking) the furnace time
    const walk = VS && VS.walkSecs && o ? VS.walkSecs(m, [[o.x + (deal.kind === "cook" ? 0.5 : 0), o.z + (deal.kind === "cook" ? 0.5 : 0)]]) : 0;
    if (VS && VS.begin && o && !VS.begin(m, walk + TRADE_PAUSE + (deal.kind === "cook" ? FU().COOK * Math.min(deal.n || 1, 16) : 0), deal.kind === "cook" ? "Cooking pork" : "Buying fuel to cook pork")) return false;
    S.deal = deal; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
    S.walkMax = Math.max(deal.kind === "cook" ? 90 : 60, walk * 2 || 0);   // a big village: from its far side the walk takes longer than the usual limit
  }
  const deal = S.deal;
  const giveUp = (why, key) => {
    log("cookGiveup", { kind: deal.kind, why });
    if (key) S.avoid[key] = now() + 0.05;
    if (deal.kind === "cook" && deal.loaded) finishCook(m, deal, true);
    S.stage = null; S.deal = null; vdone(m); a.route = null; S.checkT = 0.5; return false;
  };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  if (deal.kind === "cook") {
    const s = deal.furnace, fkey = "f:" + F.pk(s.x, s.y, s.z), near = F.beside(s);
    const go = () => F.travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, near, "pork");
    if (S.stage === "walk") {
      if (S.walkT > (S.walkMax || 90)) return giveUp("timeout", fkey);
      if (!F.usable(m, s, deal.rawId, deal.outId)) return giveUp("furnace busy", fkey);
      const st = go();
      if (st === "failed") return giveUp("no path", fkey);
      if (st === "arrived") { S.stage = "work"; S.tt = TRADE_PAUSE; S.waitT = 0; }
      return true;
    }
    if (S.stage === "cook" && Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) > 3) {   // pulled away (a zombie): back to the furnace
      if (go() === "failed") { F.inUse.delete(F.pk(s.x, s.y, s.z)); log("cookGiveup", { kind: "cook", why: "cannot get back" }); S.stage = null; S.deal = null; vdone(m); a.route = null; return false; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.4 };
    if (S.stage === "work") {
      if ((S.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
      const n = F.load(m, deal, deal.n);
      if (!n) return giveUp("furnace busy", fkey);
      S.stage = "cook";
      log("load", { pork: n, at: F.pk(s.x, s.y, s.z), ownFuel: deal.ownFuel || 0 });
      return true;
    }
    const st = BF.inventory.furnaceState(s.x, s.y, s.z);
    if (!st || !BF.isFurnace(BF.world.getBlock(s.x, s.y, s.z))) { F.inUse.delete(F.pk(s.x, s.y, s.z)); return giveUp("furnace gone", fkey); }
    S.waitT += dt;
    if (!st.slots[0] || st.slots[0].id !== deal.rawId) { finishCook(m, deal, false); S.stage = null; S.deal = null; vdone(m); S.checkT = 0.5; return true; }   // all cooked
    F.topUp(m, deal, st);
    if (S.waitT > F.COOK * 1.5 * deal.loaded + 40 || (st.burn <= 0 && !st.slots[1] && S.waitT > 3)) return giveUp(st.burn <= 0 && !st.slots[1] ? "out of fuel" : "too slow");
    if (Math.random() < dt * 0.5) a.swingT = 0.2;
    return true;
  }
  // buying fuel
  const v2 = deal.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + deal.item;
  if (!F.canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage === "walk") {
    if (S.walkT > (S.walkMax || 60)) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "pork") a.route = null; S.gx = g.x; S.gz = g.z; }
    if (F.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3, null, "pork") === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const done = F.doBuy(m, deal);
    S.stage = null; S.deal = null; vdone(m); S.gx = null; S.checkT = 0.5;
    if (done) log("buyFuel", { from: v2.profession, got: done * deal.offer.sell.n, item: BF.itemName(deal.item) });
    else { S.avoid[key] = now() + 0.05; log("cookGiveup", { kind: "buy", why: "trade refused" }); }
  }
  return true;
}
// A forced unload (js/villagesim.js forceStop): the pork it loaded comes back out of the furnace, cooked or not. Returns what it did, or null.
function forceStop(m) {
  const S = m.pgc;
  if (!S || !S.stage) return null;
  const loaded = S.deal && S.deal.kind === "cook" && S.deal.loaded;
  if (loaded) finishCook(m, S.deal, true);
  S.stage = null; S.deal = null; if (m.ai) m.ai.route = null; vdone(m);
  return loaded ? "emptied the furnace" : null;
}
if (BF.furnaceUse) BF.furnaceUse.busyWhen(u => !!(u.pgc && u.pgc.stage === "cook"));   // it holds the furnace while its pork cooks

function statusText(m) {
  const C = m.pgc;
  if (C && C.stage && C.deal) return C.deal.kind === "buy" ? "Buying fuel to cook pork" : "Cooking pork";
  const S = m.pgk;
  if (!S || !S.task) return "";
  return { feed: "Feeding the pigs", cull: "Culling a pig", fetch: "Fetching a wild pig" }[S.task.kind] || "";
}
// For the debug screen (js/debugfeed.js flockOf): the herd of a pig farmer.
function holdings(m) {
  const T = tended(m), p = T.sty, states = p && p.pigs ? p.pigs : [];
  return { kind: "pigs", n: p ? T.size : T.pigs.length, young: p ? states.filter(s => s.growAt != null).length : T.pigs.filter(o => o.piglet).length,
    culls: p ? p.culls | 0 : 0, limit: T.limit, coop: !!p };
}
// Counts for the debug screen: pigs loaded near the player, in a sty and wild.
function counts() {
  let penned = 0, wild = 0, young = 0;
  if (BF.mobs) for (const m of BF.mobs.list) if (m.type === "pig" && live(m)) { if (m.sty) penned++; else wild++; if (m.piglet) young++; }
  return { penned, wild, young };
}

BF.pigFarmer = {
  FEED_DAYS, BREED_CD, PIGLET_DAYS, DENSITY, MIN_ADULTS, STOCK_TO, FIND_R, FEED_KEEP, PORK_KEEP, COOKED_CAP, WORK_END, FEED_NAMES,
  feed, playerUse, pigAI, syncLook, hungry, willing, isPiglet, breed, isFeed, feedIds, feedHeld,
  stiesOf, styOf, tended, feedWanted, reserve, keepsFood, isWare, villageOK, seed,
  ai, cookAI, toCook, forceStop, tick, statusText, holdings, pickStyTarget, contain, counts,
  exportAll, importAll, reset,
  sties: () => activeSties, log: LOG,
};
})();
