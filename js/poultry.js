// Chickens and the poultry keeper (BF.poultry). Loaded after js/shepherd.js; hooks live in mobs.js, villagelife.js, jobs.js, worldgen.js,
// blueprints.js / builder.js and player.js. See CONTRACT.md "Poultry keepers (js/poultry.js)".
//
// Chickens (every chicken, wild or in a coop; state in `m.hen`):
//  - Fed: wheat seeds from the player or a poultry keeper make a chicken willing to breed for 1 day (`fed` = absolute game day it was fed).
//  - Breeding: two willing adults within MATE_R walk to each other and a chick hatches; both then rest BREED_CD days. A chick is small, drops
//    nothing and grows up after CHICK_DAYS.
//  - Eggs: each adult lays one every LAY_MIN-LAY_MAX days (5-10 minutes of a 20 minute day). A wild chicken drops it on the ground, as in vanilla;
//    a coop chicken lays it in the coop's nest (`coop.eggs`, at most NEST_CAP), where the poultry keeper collects it.
//  - Following: a chicken within FOLLOW_R of a player holding wheat seeds walks after them (vanilla's tempting), so a player can lure chickens
//    into a coop. A poultry keeper leads a wild chicken home the same way (it walks the keeper's trail, gates included).
// Coops: a fenced run (js/worldgen.js "coop" with village generator 4, or the builder's "coop" blueprint). Each coop holds a list of chicken states that
//  outlives the chicken mobs: a generated coop starts with 2-4 chickens, a builder's coop starts empty; respawned whenever the coop is loaded,
//  saved as "coops:<village key>". Coop chickens wander only inside the run.
// Poultry keepers (profession "poultry_keeper", jobsite: nesting box): during work hours they collect the eggs from the nest, feed hungry chickens
//  wheat seeds (they buy seeds from the farmers, js/villagelife.js shopAI), cull the flock back to CULL_AT when it passes it (raw chicken and 0-2
//  feathers each, kept to sell), and stock a coop that holds fewer than STOCK_TO chickens from wild chickens within FIND_R (once a day when none).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const FEED_DAYS = 1;          // a chicken is willing to breed for this long after eating seeds
const BREED_CD = 1;           // days before a chicken that bred can breed again
const CHICK_DAYS = 2;         // days from hatching to adult
const LAY_MIN = 0.25, LAY_MAX = 0.5;        // days between eggs
const MATE_R = 8, MEET = 1.2;              // a willing chicken looks for a mate this far; they breed when this close
const LOCAL_MAX = 30;         // no breeding when this many chickens are already within 16 blocks
const NEST_CAP = 64;          // eggs a coop's nest holds before new ones are lost
const CULL_AT = 8;            // the keeper culls while the flock holds more than this
const MIN_ADULTS = 2;         // ... never below this many adults
const STOCK_TO = 2;           // the keeper fetches wild chickens until its coop holds this many
const FIND_R = 128;           // how far it looks for a wild chicken
const FOLLOW_R = 10;          // chickens follow a player holding seeds from this far
const ADOPT_MAX = 24;         // a coop takes in wandering chickens up to this many
const FREE_RADIUS = 10;       // a keeper without a coop tends the free chickens within 10 blocks of its nesting box
const TEND_R = 12;            // stray chickens this near the coop are fed too
const COLLECT_AT = 3;         // it collects the nest when it holds this many eggs (and before the end of its day)
const SEEDS_KEEP = 4;         // seeds it keeps back for luring a chicken home
const WORK_END = 0.5;
const TASK_MAX = 45, LEAD_MAX = 240;

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const cnt = (m, id) => (id == null || !m.inv ? 0 : TR().inv.count(m.inv, id));
const idsOf = () => ({ seeds: BF.I.wheat_seeds, egg: BF.I.egg, feather: BF.I.feather, chicken: BF.I.raw_chicken });
const layDays = () => rnd(LAY_MIN, LAY_MAX);
const LOG = [];
const log = (kind, data) => { LOG.push(Object.assign({ kind, day: +now().toFixed(3) }, data)); if (LOG.length > 200) LOG.shift(); };
const vlog = (m, kind, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, kind, (BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Poultry keeper") + " (Poultry Keeper) " + text, m); };

let ids = 0;
const idOf = new WeakMap();
const mid = m => { let i = idOf.get(m); if (!i) idOf.set(m, i = ++ids); return i; };

// ---------------------------------------------------------------- chicken state
function stOf(m) {
  if (!m.hen) m.hen = { fed: null, cd: 0, growAt: null, layAt: now() + layDays(), x: null, z: null, mob: m };
  return m.hen;
}
const isChick = m => !!(m.hen && m.hen.growAt != null);
const hungry = (m, t) => { const s = m.hen; return !s || s.fed == null || t - s.fed >= FEED_DAYS; };
const willing = (m, t) => { const s = m.hen; return !!(s && live(m) && s.growAt == null && s.fed != null && t - s.fed < FEED_DAYS && t >= s.cd); };

function syncLook(m) {
  const s = stOf(m), t = now();
  const k = s.growAt != null ? clamp(1 - (s.growAt - t) / CHICK_DAYS, 0, 1) : 1;
  m.chick = k < 1;
  if (m._k == null || Math.abs(k - m._k) > 0.02 || (k >= 1 && m._k < 1)) { m._k = k; if (BF.mobs.setChickenSize) BF.mobs.setChickenSize(m, k); }
}
function fx(m, color, n) { const V = BF.villageLife; if (V && V.particles && m.position) V.particles(m.position.x, m.position.y + m.height + 0.2, m.position.z, color, n, 0.4); }
function snd(name, m, vol) { const V = BF.villageLife; if (V && V.sound && m.position) V.sound(name, m.position.x, m.position.y + 0.5, m.position.z, vol); }

// Seeds eaten by `m` (from the player or a keeper). Returns false for chickens that are not hungry; chicks grow 10% faster.
function feed(m, by) {
  if (!live(m) || m.type !== "chicken") return false;
  const s = stOf(m), t = now();
  if (s.growAt != null) { s.growAt -= CHICK_DAYS * 0.1; syncLook(m); fx(m, "#ffd84a", 4); snd("chicken", m, 0.4); return true; }
  if (!hungry(m, t)) return false;
  s.fed = t;
  fx(m, "#ff5a7a", 5); snd("chicken", m, 0.5);
  if (BF.emit) BF.emit("chickenFed", m, by);
  return true;
}
// The player right-clicked a chicken holding `sel`: seeds feed it. Returns true / a message (handled) or false (not ours).
function playerUse(m, sel) {
  const it = sel && BF.items[sel.id];
  if (!it || !live(m) || it.name !== "wheat_seeds") return false;
  const creative = BF.player && BF.player.gameMode === "creative";
  if (!m.chick && !hungry(m, now())) return "The chicken isn't hungry";
  if (!feed(m, "player")) return false;
  if (!creative && BF.inventory && BF.inventory.consumeSelected) BF.inventory.consumeSelected(1);
  return true;
}
const playerSeeds = () => {
  try { const s = BF.inventory && BF.inventory.selected && BF.inventory.selected(); return !!(s && s.count > 0 && s.id === BF.I.wheat_seeds); } catch (e) { return false; }
};

// ---------------------------------------------------------------- breeding
function findMate(m, t) {
  let best = null, bd = MATE_R * MATE_R, near = 0;
  for (const o of BF.mobs.list) {
    if (o.type !== "chicken" || !live(o)) continue;
    const dx = o.position.x - m.position.x, dz = o.position.z - m.position.z, d2 = dx * dx + dz * dz;
    if (d2 < 256) near++;
    if (o === m || o.coop !== m.coop || !willing(o, t) || Math.abs(o.position.y - m.position.y) > 2) continue;
    if (d2 < bd) { bd = d2; best = o; }
  }
  return near >= LOCAL_MAX ? null : best;
}
function breed(a, b, t) {
  const x = (a.position.x + b.position.x) / 2, z = (a.position.z + b.position.z) / 2, y = Math.max(a.position.y, b.position.y);
  const chick = BF.mobs.spawn("chicken", x, y, z);
  if (!chick) return null;
  const s = stOf(chick);
  s.growAt = t + CHICK_DAYS; s.cd = t + CHICK_DAYS + BREED_CD; s.layAt = t + CHICK_DAYS + layDays();
  stOf(a).cd = stOf(b).cd = t + BREED_CD;
  const coop = a.coop || b.coop;
  if (coop && coop.hens) { s.mob = chick; chick.hen = s; coop.hens.push(s); chick.coop = coop; }
  syncLook(chick);
  fx(a, "#ff5a7a", 5); fx(b, "#ff5a7a", 5); snd("chicken", chick, 0.5);
  a.mate = b.mate = null;
  log("bred", { coop: coop ? coop.key : null, flock: coop ? coop.hens.length : null });
  if (coop && BF.vlog) BF.vlog.log(coop.rec, "poultry", "A chick hatched in the coop (" + coop.hens.length + " chickens)", chick);
  if (BF.emit) BF.emit("chickenBorn", chick, a, b);
  return chick;
}
// ---------------------------------------------------------------- chicken movement (mobs.js, before its wander AI): led home, tempted, or to a mate
function follow(m, dt, out, tx, tz, stop, speed) {
  const dx = tx - m.position.x, dz = tz - m.position.z, d = Math.hypot(dx, dz);
  m.ai.mode = "idle"; m.ai.t = 1;
  if (d < stop) { out.faceX = tx; out.faceZ = tz; return true; }
  out.x = dx / d * speed; out.z = dz / d * speed;
  return true;
}
function chickenAI(m, dt, out) {
  const t = now(), sp = m.def.speed;
  const L = m.ledBy;
  if (L) {
    const S = L.pkp, tk = S && S.task;
    if (!live(L) || !tk || tk.mob !== m || tk.kind !== "fetch" || S.stage === "walk") { m.ledBy = null; }
    else {
      // walk the keeper's trail (through the gate) instead of straight at it: crumbs are dropped every 0.6 blocks
      const tr = S.trail, k0 = S.trailBase;
      let ci = Math.max(m.crumb || 0, k0);
      while (ci < k0 + tr.length - 1 && Math.hypot(tr[ci - k0][0] - m.position.x, tr[ci - k0][2] - m.position.z) < 0.7) ci++;
      m.crumb = ci;
      const dk = Math.hypot(L.position.x - m.position.x, L.position.z - m.position.z);
      if (S.stage === "pen") {   // the keeper waits outside with the gate open: in through the gate, then to the middle of the run (as js/stables.js)
        const C = tk.coop, [gx, gz] = C.gate, inG = Math.abs(m.position.x - gx - 0.5) < 0.6 && Math.abs(m.position.z - gz - 0.5) < 0.6;
        m.penIn = m.penIn || inG || inRoom(C, m.position);
        return m.penIn ? follow(m, dt, out, (C.x0 + C.x1) / 2, (C.z0 + C.z1) / 2, 0.8, sp) : follow(m, dt, out, gx + 0.5, gz + 0.5, 0.2, sp);
      }
      m.penIn = false;
      m.lookAt = L;
      if (ci >= k0 + tr.length - 1 || dk < 2.2) return follow(m, dt, out, L.position.x, L.position.z, 1.4, sp * 1.2);
      const c = tr[ci - k0];
      return follow(m, dt, out, c[0], c[2], 0.2, sp * 1.25);
    }
  }
  if (!m.coop && BF.player && BF.player.position && !BF.player.dead && playerSeeds()) {
    const p = BF.player.position, d = Math.hypot(p.x - m.position.x, p.z - m.position.z);
    if (d < FOLLOW_R && Math.abs(p.y - m.position.y) < 4) { m.lookAt = "player"; return follow(m, dt, out, p.x, p.z, 1.6, sp); }
  }
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
  if (d > MATE_R + 4 || m.mateSeek > 25) { m.mate = null; m.mateT = rnd(6, 10); return false; }
  m.ai.mode = "idle"; m.ai.t = 1; m.lookAt = o;
  if (d < MEET) { if (mid(m) < mid(o)) breed(m, o, t); return true; }
  out.x = dx / d * sp; out.z = dz / d * sp;
  return true;
}

// ---------------------------------------------------------------- coops
// A coop: {key, rec, gen (generated, else built by a builder), x0..x1 / z0..z1 (the run the chickens use, block edges), fx0..fx1 / fz0..fz1 (the
// fence footprint), y (ground level: chickens stand on y + 1), gate [x, z] (the gate or gap in the front fence), out [x, z] (the path cell in
// front of it), cells, hens (chicken states, null until first seen), eggs (in the nest)}.
function makeGenCoop(rec, b, idx) {
  const at = (u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
  const box = (u0, q0, u1, q1) => {
    const p = at(u0, q0), r = at(u1, q1);
    return [Math.min(p[0], r[0]), Math.min(p[1], r[1]), Math.max(p[0], r[0]) + 1, Math.max(p[1], r[1]) + 1];
  };
  const room = box(1, 1, b.w - 2, b.d - 3), foot = box(0, 0, b.w - 1, b.d - 1);   // the back row holds the hay bales
  return { key: rec.key + "|" + idx, idx: "g" + idx, gen: true, rec, x0: room[0], z0: room[1], x1: room[2], z1: room[3], fx0: foot[0], fz0: foot[1], fx1: foot[2], fz1: foot[3],
    y: b.y, cells: (b.w - 2) * (b.d - 3), hens: null, eggs: 0, gate: at(b.du, 0), out: at(b.du, -1) };
}
// A builder's coop (js/blueprints.js "coop"): its fence ring from the blueprint, the gap in it is the way in.
function makeBuiltCoop(rec, e) {
  const BPr = BF.blueprints, bp = BPr && BPr.get(e.type, e.rot, e.style, e.h, e.opts, e.wood);
  if (!bp) return null;
  const fence = bp.cells.filter(c => /_fence$/.test(BF.blocks[c.id].name));
  if (!fence.length) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const f of fence) { a = Math.min(a, f.x); b = Math.min(b, f.z); c = Math.max(c, f.x); d = Math.max(d, f.z); }
  const has = new Set(fence.map(f => f.x + "," + f.z));
  let gate = null, out = null;
  for (let x = a + 1; x < c && !gate; x++) for (const [z, oz] of [[b, b - 1], [d, d + 1]]) if (!has.has(x + "," + z)) { gate = [x, z]; out = [x, oz]; break; }
  for (let z = b + 1; z < d && !gate; z++) for (const [x, ox] of [[a, a - 1], [c, c + 1]]) if (!has.has(x + "," + z)) { gate = [x, z]; out = [ox, z]; break; }
  const X = v => e.ox + v, Z = v => e.oz + v;
  return { key: rec.key + "|b" + e.id, idx: "b" + e.id, gen: false, rec, x0: X(a + 1), z0: Z(b + 1), x1: X(c), z1: Z(d), fx0: X(a), fz0: Z(b), fx1: X(c + 1), fz1: Z(d + 1),
    y: e.oy - 1, cells: (c - a - 1) * (d - b - 1), hens: null, eggs: 0, gate: gate ? [X(gate[0]), Z(gate[1])] : null, out: out ? [X(out[0]), Z(out[1])] : null };
}
function coopsOf(rec) {
  if (!rec._coops) {
    rec._coops = [];
    const bl = (rec.wg && rec.wg.buildings) || [];
    bl.forEach((b, i) => { if (b.type === "coop") rec._coops.push(makeGenCoop(rec, b, i)); });
  }
  for (const e of rec.built || []) {   // builders' coops join once they are finished
    if (e.type !== "coop" || e.state !== "done" || rec._coops.some(k => k.idx === "b" + e.id)) continue;
    const k = makeBuiltCoop(rec, e);
    if (k) rec._coops.push(k);
  }
  return rec._coops;
}
const coopDist = (p, x, z) => Math.hypot(Math.max(p.fx0 - x, 0, x - p.fx1), Math.max(p.fz0 - z, 0, z - p.fz1));   // 0 inside the fence
const inRoom = (p, pos) => pos.x > p.x0 && pos.x < p.x1 && pos.z > p.z0 && pos.z < p.z1 && Math.abs(pos.y - (p.y + 1)) < 3;

let pending = new Map();      // village key -> [{i, h: [packed], e: eggs}] from a save, taken as each coop is first seen
const activeCoops = [];       // coops that are loaded and near the player (rebuilt by tickCoops)
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
const packSt = s => [fix3(s.fed), fix3(s.cd || 0), fix3(s.growAt), fix3(s.layAt), s.mob && live(s.mob) ? +s.mob.position.x.toFixed(2) : s.x, s.mob && live(s.mob) ? +s.mob.position.z.toFixed(2) : s.z];
function unpackSt(a) {
  const num = (x, d) => (x != null && Number.isFinite(+x) ? +x : d);
  if (!Array.isArray(a)) return null;
  return { fed: num(a[0], null), cd: num(a[1], 0), growAt: num(a[2], null), layAt: num(a[3], now() + layDays()), x: num(a[4], null), z: num(a[5], null), mob: null };
}
function initCoop(coop) {
  const rec = pending.get(coop.rec.key), at = rec && rec.findIndex(e => e && String(e.i) === coop.idx);
  if (rec && at >= 0) {
    coop.hens = (rec[at].h || []).map(unpackSt).filter(Boolean);
    coop.eggs = Math.max(0, Math.min(NEST_CAP, rec[at].e | 0));
    rec.splice(at, 1);
    if (!rec.length) pending.delete(coop.rec.key);
    return;
  }
  coop.hens = [];
  if (!coop.gen) return;   // a builder's coop starts empty: the keeper stocks it from wild chickens
  const r = seeded("coop:" + coop.key), n = 2 + (r() < 0.5 ? 1 : 0) + (r() < 0.2 ? 1 : 0);   // a generated coop starts with 2-4 chickens
  for (let i = 0; i < n; i++) coop.hens.push({ fed: null, cd: 0, growAt: null, layAt: now() + layDays(), x: coop.x0 + 0.6 + r() * (coop.x1 - coop.x0 - 1.2), z: coop.z0 + 0.6 + r() * (coop.z1 - coop.z0 - 1.2), mob: null });
}
function spawnHen(coop, s) {
  const x = s.x != null && s.x > coop.x0 && s.x < coop.x1 ? s.x : (coop.x0 + coop.x1) / 2, z = s.z != null && s.z > coop.z0 && s.z < coop.z1 ? s.z : (coop.z0 + coop.z1) / 2;
  const gy = BF.world.heightAt(Math.floor(x), Math.floor(z));
  if (gy == null || gy < BF.MIN_Y + 1) return;
  const m = BF.mobs.spawn("chicken", x, gy + 1, z);
  if (!m) return;
  m.hen = s; s.mob = m; m.coop = coop;
  syncLook(m);
}
function tickCoops() {
  const pp = BF.player && BF.player.position;
  activeCoops.length = 0;
  if (!pp || !BF.mobs || !BF.mobs.spawn) return;
  const W = BF.world;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec.wg) continue;
    if (Math.hypot(rec.x - pp.x, rec.z - pp.z) > 80 && !(BF.villageSim && BF.villageSim.isActive(rec.key))) continue;
    for (const coop of coopsOf(rec)) {
      if (!W.isLoaded(coop.fx0, coop.fz0) || !W.isLoaded(coop.fx1, coop.fz1) || !W.isLoaded(coop.fx0, coop.fz1) || !W.isLoaded(coop.fx1, coop.fz0)) continue;
      if (!coop.hens) initCoop(coop);
      activeCoops.push(coop);
      for (const s of coop.hens) if (!s.mob || s.mob.removed || s.mob.dead) { s.mob = null; spawnHen(coop, s); }
    }
  }
}
function leaveCoop(m) {
  const p = m.coop;
  if (p && p.hens) { const i = p.hens.indexOf(m.hen); if (i >= 0) p.hens.splice(i, 1); }
  m.coop = null;
}
// A chicken that walked (or was led) into a coop's run joins its flock; one that got out for good leaves it.
function adoptOrRelease(m) {
  if (m.coop) { if (coopDist(m.coop, m.position.x, m.position.z) > 2.5) leaveCoop(m); return; }
  for (const p of activeCoops) {
    if (inRoom(p, m.position) && p.hens.length < ADOPT_MAX) {
      const s = stOf(m);
      if (p.hens.indexOf(s) < 0) p.hens.push(s);
      s.mob = m; m.coop = p; m.ledBy = null;
      if (BF.emit) BF.emit("chickenPenned", m, p);
      return;
    }
  }
}
function pickCoopTarget(m) {
  const p = m.coop;
  if (!p) return false;
  m.ai.tx = p.x0 + 0.6 + Math.random() * (p.x1 - p.x0 - 1.2);
  m.ai.tz = p.z0 + 0.6 + Math.random() * (p.z1 - p.z0 - 1.2);
  return true;
}
// A coop chicken never walks into the fence or out of the gate.
function contain(m, d) {
  const p = m.coop, pos = m.position;
  if (!p) return;
  if (coopDist(p, pos.x, pos.z) > 1.5) { leaveCoop(m); return; }
  const M = 0.35, lx0 = p.x0 + M, lx1 = p.x1 - M, lz0 = p.z0 + M, lz1 = p.z1 - M;
  const nx = pos.x + d.x * 0.35, nz = pos.z + d.z * 0.35;
  if ((nx < lx0 && d.x < 0) || (nx > lx1 && d.x > 0)) d.x = 0;
  if ((nz < lz0 && d.z < 0) || (nz > lz1 && d.z > 0)) d.z = 0;
  if (pos.x < lx0 - 0.1) d.x = Math.max(d.x, 0.8); else if (pos.x > lx1 + 0.1) d.x = Math.min(d.x, -0.8);
  if (pos.z < lz0 - 0.1) d.z = Math.max(d.z, 0.8); else if (pos.z > lz1 + 0.1) d.z = Math.min(d.z, -0.8);
}

// ---------------------------------------------------------------- the global tick: growing up, laying, coop stock
function lay(s, coop, m) {
  s.layAt = now() + layDays();
  if (coop) { if (coop.eggs < NEST_CAP) coop.eggs++; return; }
  if (m && BF.drops && BF.I.egg != null) BF.drops.spawn(BF.I.egg, 1, m.position.x, m.position.y + 0.3, m.position.z);   // a wild chicken drops it, as in vanilla
}
let acc = 0, coopT = 0;
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("mobKilled", m => { if (m && m.type === "chicken" && m.coop) leaveCoop(m); });
}
function tick(dt) {
  hook();
  acc += dt; coopT -= dt;
  if (coopT <= 0 && BF.world) { coopT = 1; try { tickCoops(); } catch (e) { console.error(e); } }
  if (acc < 0.5 || !BF.mobs) return;
  acc = 0;
  if (toShut.length) shutGates();
  const t = now();
  for (const m of BF.mobs.list) {
    if (m.type !== "chicken" || !live(m)) continue;
    const s = stOf(m);
    if (s.growAt != null && t >= s.growAt) { s.growAt = null; s.cd = Math.max(s.cd, t); }
    if (s.layAt == null || s.layAt - t > LAY_MAX * 2) s.layAt = t + layDays();   // time was set back
    if (s.growAt == null && t >= s.layAt) lay(s, m.coop, m);
    syncLook(m);
    adoptOrRelease(m);
  }
  // coop chickens that are not loaded keep laying and growing up (the states hold absolute days)
  for (const p of activeCoops) for (const s of p.hens) {
    if (s.mob) continue;
    if (s.growAt != null && t >= s.growAt) s.growAt = null;
    for (let k = 0; k < 8 && s.growAt == null && s.layAt != null && t >= s.layAt; k++) { const was = s.layAt; lay(s, p, null); s.layAt = Math.min(s.layAt, was + layDays()); }
  }
}

// ---------------------------------------------------------------- persistence
function exportAll(out) {
  if (!BF.mobs) return;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec._coops) continue;
    const arr = [];
    for (const p of rec._coops) if (p.hens) arr.push({ i: p.idx, h: p.hens.map(packSt), e: p.eggs | 0 });
    for (const e of pending.get(rec.key) || []) arr.push(e);
    if (arr.length) out["coops:" + rec.key] = arr;
  }
  for (const [k, v] of pending) if (!(("coops:" + k) in out) && v.length) out["coops:" + k] = v;
}
function importAll(o) {
  pending = new Map();
  if (!o || typeof o !== "object") return;
  for (const k in o) if (k.slice(0, 6) === "coops:" && Array.isArray(o[k])) pending.set(k.slice(6), o[k].filter(e => e && e.i != null && Array.isArray(e.h)));
}
function reset() { pending = new Map(); activeCoops.length = 0; toShut.length = 0; acc = 0; coopT = 0; LOG.length = 0; }

// ---------------------------------------------------------------- the poultry keeper
const pkp = m => m.pkp || (m.pkp = { task: null, stage: null, t: 0, actT: 0, cd: rnd(0, 2), avoid: new Map(), navFail: 0, stockAt: 0, trail: [], trailBase: 0 });
// The coop this keeper works: the one its nesting box stands beside (footprint within 4.5 blocks).
function coopOf(m) {
  const S = pkp(m);
  if (!m.jobsite || !m.village) return null;
  if (S.coopFor === m.jobsite && S.coop) return S.coop;
  let best = null, bd = 4.5;
  for (const p of coopsOf(m.village)) { const d = coopDist(p, m.jobsite.x + 0.5, m.jobsite.z + 0.5); if (d < bd) { bd = d; best = p; } }
  S.coopFor = m.jobsite; S.coop = best;
  return best;
}
// What the keeper looks after: {coop, hens (live chickens to feed), flock (live chickens counted for culling), size (the flock, unloaded ones too)}.
function tended(m) {
  const coop = coopOf(m), list = BF.mobs.list;
  const home = m.jobsite ? { x: m.jobsite.x + 0.5, z: m.jobsite.z + 0.5 } : m.position;
  const near = o => o.type === "chicken" && live(o) && !o.ledBy && Math.hypot(o.position.x - home.x, o.position.z - home.z) <= (coop ? TEND_R : FREE_RADIUS) && Math.abs(o.position.y - m.position.y) < 6;
  let flock;
  if (coop && coop.hens) flock = coop.hens.map(s => s.mob).filter(live);
  else flock = list.filter(o => near(o) && !o.coop);
  const hens = flock.slice();
  if (coop) for (const o of list) if (near(o) && !o.coop) hens.push(o);
  return { coop, flock, hens, size: coop && coop.hens ? coop.hens.length : flock.length };
}
const adults = a => a.filter(o => !isChick(o));
// Seeds the keeper wants to buy now (0 = enough): under 4 it tops up to ~2 days of feed plus the lure.
function seedsWanted(m) {
  if (m.profession !== "poultry_keeper" || !m.inv || !BF.mobs) return 0;
  const n = Math.max(STOCK_TO, adults(tended(m).hens).length), have = cnt(m, idsOf().seeds);
  if (have >= Math.max(SEEDS_KEEP, n)) return 0;
  return n * 2 + SEEDS_KEEP + 4 - have;
}
function wildChicken(m, coop, S) {
  const c = { x: (coop.x0 + coop.x1) / 2, z: (coop.z0 + coop.z1) / 2 }, sim = BF.simNow();
  let best = null, bd = FIND_R;
  for (const o of BF.mobs.list) {
    if (o.type !== "chicken" || !live(o) || o.coop || o.ledBy || isChick(o) || (S.avoid.get(o) || 0) > sim) continue;
    const d = Math.hypot(o.position.x - c.x, o.position.z - c.z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
function pickTask(m, S) {
  const T = tended(m), t = now(), c = idsOf(), sim = BF.simNow(), px = m.position.x, pz = m.position.z;
  const ok = o => !((S.avoid.get(o) || 0) > sim);
  const nearest = a => { let best = null, bd = Infinity; for (const o of a) { const d = Math.hypot(o.position.x - px, o.position.z - pz); if (d < bd) { bd = d; best = o; } } return best; };
  const coop = T.coop;
  if (coop && coop.eggs >= (skyT() > WORK_END - 0.08 ? 1 : COLLECT_AT) && m.jobsite) return { kind: "collect" };
  const seeds = cnt(m, c.seeds), spare = coop && coop.hens && coop.hens.length < STOCK_TO ? seeds - 1 : seeds;   // one seed is always kept to lure a chicken home
  const ad = adults(T.hens).filter(ok);
  if (spare > 0 && T.size <= CULL_AT) { const o = nearest(ad.filter(x => hungry(x, t))); if (o) return { kind: "feed", mob: o }; }
  if (T.size > CULL_AT && adults(T.flock).length > MIN_ADULTS) { const o = nearest(adults(T.flock).filter(ok)); if (o) return { kind: "cull", mob: o }; }
  if (coop && coop.hens && coop.hens.length < STOCK_TO && seeds > 0 && t >= S.stockAt) {
    const o = wildChicken(m, coop, S);
    if (o) return { kind: "fetch", mob: o, coop };
    if (wildChicken(m, coop, { avoid: new Map() })) { S.stockAt = t + 0.1; return null; }   // only ones it just failed to bring in: tries them again in a while
    S.stockAt = Math.floor(t) + 1 + 0.03;   // none in range: look again tomorrow morning
    log("noWild", { coop: coop.key });
    vlog(m, "poultry", "found no wild chickens within " + FIND_R + " blocks of the coop; will look again tomorrow");
  }
  return null;
}
function stillWanted(m, tk) {
  const c = idsOf();
  if (tk.kind === "collect") { const coop = coopOf(m); return !!(coop && coop.eggs > 0 && m.jobsite); }
  const o = tk.mob;
  if (!live(o)) return false;
  if (tk.kind === "fetch") return !o.coop && cnt(m, c.seeds) > 0 && !(o.ledBy && o.ledBy !== m);
  if (isChick(o)) return false;
  if (tk.kind === "feed") return hungry(o, now()) && cnt(m, c.seeds) > 0;
  const T = tended(m);
  return T.size > CULL_AT && adults(T.flock).length > MIN_ADULTS && T.flock.indexOf(o) >= 0;
}
function endTask(m, ok) {
  const S = pkp(m), tk = S.task;
  if (tk && !ok && tk.mob) S.avoid.set(tk.mob, BF.simNow() + (tk.kind === "fetch" ? 120 : 40));
  if (tk && tk.mob && tk.mob.ledBy === m) tk.mob.ledBy = null;
  if (S.gateHeld) { toShut.push({ at: S.gateHeld, m, t: BF.simNow() }); S.gateHeld = null; shutGates(); }
  S.task = null; S.stage = null; m.ai.route = null; S.trail = []; S.trailBase = 0;
  if (BF.villageSim && BF.villageSim.done) BF.villageSim.done(m);
}
// Gates a keeper held open for a chicken are shut as soon as nothing stands in them (and the keeper is out of the way); checked from tick().
const toShut = [];
function shutGates() {
  for (let i = toShut.length - 1; i >= 0; i--) {
    const g = toShut[i], [x, y, z] = g.at, bk = BF.world.isLoaded(x, z) ? BF.blocks[BF.world.getBlock(x, y, z)] : null;
    if (!bk || !bk.gate || !bk.gate.open || BF.simNow() - g.t > 120) { toShut.splice(i, 1); continue; }
    if ((BF.mobs.isOccupied && BF.mobs.isOccupied(x, y, z)) || (live(g.m) && Math.hypot(x + 0.5 - g.m.position.x, z + 0.5 - g.m.position.z) < 1.5)) continue;
    BF.world.setGate(x, y, z, false); toShut.splice(i, 1);
  }
}
function loot(m, id, n, where) {
  if (id == null || n <= 0) return 0;
  const left = TR().inv.add(m.inv, id, n);
  if (left > 0 && BF.drops && where && where.position) BF.drops.spawn(id, left, where.position.x, where.position.y + 0.6, where.position.z);
  return n - left;
}
function perform(m, tk) {
  const c = idsOf(), T = TR();
  if (tk.kind === "collect") {
    const coop = coopOf(m), n = coop ? coop.eggs : 0;
    if (!n) return false;
    const got = n - T.inv.add(m.inv, c.egg, n);
    coop.eggs -= got;
    if (got > 0) { log("eggs", { got, left: coop.eggs }); vlog(m, "poultry", "collected " + got + " egg" + (got > 1 ? "s" : "") + " from the coop"); }
    return got > 0;
  }
  const o = tk.mob;
  if (tk.kind === "feed") {
    if (T.inv.remove(m.inv, c.seeds, 1) < 1) return false;
    if (!feed(o, m)) { T.inv.add(m.inv, c.seeds, 1); return false; }
    return true;
  }
  // cull: the keeper keeps the chicken and the feathers instead of dropping them
  BF.mobs.hurt(o, 999, "a poultry keeper");
  const meat = loot(m, c.chicken, 1, o), fe = loot(m, c.feather, rndInt(0, 2), o);
  const T2 = tended(m);
  log("culled", { meat, feathers: fe, flock: T2.size });
  vlog(m, "poultry", "culled a chicken (" + T2.size + " left): " + meat + " raw chicken, " + fe + " feather" + (fe === 1 ? "" : "s"));
  return true;
}
const ACT = { feed: 0.7, cull: 0.8, collect: 1.2 };
// A keeper with nothing to do inside a coop walks out through the gate, so it never wanders around stuck among the chickens.
function leave(m, S, dt, out) {
  const p = m.position;
  let coop = S.exit;
  if (!coop) {
    const R = m.village;
    if (!R) return false;
    coop = coopsOf(R).find(q => p.x > q.fx0 && p.x < q.fx1 && p.z > q.fz0 && p.z < q.fz1 && Math.abs(p.y - (q.y + 1)) < 2 && q.out);
    if (!coop) return false;
    S.exit = coop; S.exitT = 0; S.navFail = 0; m.ai.route = null;
  }
  S.exitT += dt;
  const N = BF.mobs.nav, [fx, fy, fz] = N.feetCell(m);
  if (!N.walkCell(fx, fy, fz) && S.exitT < 30) {   // perched on the fence: walk off it towards the path outside
    const dx = coop.out[0] + 0.5 - p.x, dz = coop.out[1] + 0.5 - p.z, d = Math.hypot(dx, dz) || 1;
    m.ai.route = null; m.ai.mode = "idle"; m.ai.t = 2;
    out.x = dx / d * m.def.speed; out.z = dz / d * m.def.speed;
    return true;
  }
  const st = BF.villageLife.travel(m, S, dt, out, coop.out[0], coop.y + 1, coop.out[1], m.def.speed);
  if (st === "going" && S.exitT < 30) { m.ai.mode = "idle"; m.ai.t = 2; return true; }
  S.exit = null;
  return false;
}
// Leading a wild chicken home: to the path in front of the gate, then into the middle of the run. The chicken walks the keeper's trail
// (chickenAI); the keeper waits when it falls behind and holds the gate open until it is in.
function lead(m, S, tk, dt, out) {
  const o = tk.mob, coop = tk.coop, p = m.position;
  const dk = Math.hypot(o.position.x - p.x, o.position.z - p.z);
  S.lostT = dk > 16 ? (S.lostT || 0) + dt : 0;
  if (S.lostT > 10 || S.t > LEAD_MAX) { log("leadFailed", { why: S.lostT > 10 ? "lost" : "slow", d: +dk.toFixed(1) }); endTask(m, false); return false; }
  if (o.coop === coop) {
    log("stocked", { coop: coop.key, flock: coop.hens.length });
    vlog(m, "poultry", "brought a wild chicken into the coop (" + coop.hens.length + " chickens)");
    endTask(m, true); S.cd = rnd(0.5, 1);
    return false;
  }
  const last = S.trail[S.trail.length - 1];
  if (!last || Math.hypot(last[0] - p.x, last[2] - p.z) > 0.6) { S.trail.push([p.x, p.y, p.z]); if (S.trail.length > 60) { S.trail.shift(); S.trailBase++; } }
  if (coop.gate) {   // hold the gate open while the chicken is on its way in
    const [gx, gz] = coop.gate, gy = coop.y + 1, bk = BF.blocks[BF.world.getBlock(gx, gy, gz)];
    if (bk && bk.gate && Math.hypot(gx + 0.5 - p.x, gz + 0.5 - p.z) < 3) { if (!bk.gate.open) BF.world.setGate(gx, gy, gz, true); S.gateHeld = [gx, gy, gz]; }
    if (bk && bk.gate && bk.gate.open) {   // not shut behind it: by its own walking (mobs.js villagerDoors) or an earlier fetch's pending close
      S.gateHeld = [gx, gy, gz];
      if (m.ai.doors) m.ai.doors = m.ai.doors.filter(([x, y, z]) => !(x === gx && y === gy && z === gz));
      for (let i = toShut.length - 1; i >= 0; i--) { const a = toShut[i].at; if (a[0] === gx && a[1] === gy && a[2] === gz) toShut.splice(i, 1); }
    }
  }
  if (S.stage === "pen") {   // at the gate: the chicken walks in by itself (chickenAI) while the keeper holds the gate open, as the stable hand does
    m.ai.route = null; out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o;
    if ((S.inT = (S.inT || 0) + dt) > 20) { S.stage = "lead"; S.inT = 0; S.trail = [[p.x, p.y, p.z]]; S.trailBase = 0; o.crumb = 0; }   // it wandered off: lead it back to the gate
    return true;
  }
  if (dk > 5) {   // wait for it; if it doesn't come (caught behind something), go back for it and start the trail again from there
    m.ai.route = null; out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o;
    if ((S.waitT = (S.waitT || 0) + dt) > 8) { S.waitT = 0; S.stage = "walk"; S.gx = null; o.ledBy = null; }
    return true;
  }
  S.waitT = 0;
  const st = BF.villageLife.travel(m, S, dt, out, coop.out[0], coop.y + 1, coop.out[1], m.def.speed * 0.8);
  if (st === "arrived") { m.ai.route = null; if (dk < 3) { S.stage = "pen"; S.inT = 0; } else { out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o; } }
  else if (st === "failed") { log("leadFailed", { why: "nopath" }); endTask(m, false); return false; }
  return true;
}
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.tradingWith || !BF.mobs.nav || !BF.villageLife || m.sleeping) return false;
  const S = pkp(m), ai = m.ai, t = skyT();
  if (t >= WORK_END || t < 0.02) { if (S.task) endTask(m, true); return t >= WORK_END && leave(m, S, dt, out); }
  if (!S.task && leave(m, S, dt, out)) return true;
  if (!S.task) {
    if ((S.cd -= dt) > 0) return false;
    S.cd = rnd(1.5, 3);
    const tk = pickTask(m, S);
    if (!tk) return false;
    const VS = BF.villageSim;
    if (VS && VS.begin) {   // estimate: walk there + the action; a fetch walks out to the chicken, leads it (slower) to the gate and waits for it to go in
      let est;
      if (tk.kind === "collect") est = VS.walkSecs(m, [[m.jobsite.x + 0.5, m.jobsite.z + 0.5]]) + ACT.collect;
      else if (tk.kind === "fetch") { const w1 = VS.walkSecs(m, [[tk.mob.position.x, tk.mob.position.z]]); est = w1 / 1.2 + (VS.walkSecs(m, [[tk.mob.position.x, tk.mob.position.z], tk.coop.out]) - w1) / 0.8 + 8; }
      else est = VS.walkSecs(m, [[tk.mob.position.x, tk.mob.position.z]]) + ACT[tk.kind];
      if (!VS.begin(m, est, { feed: "Feeding the chickens", cull: "Culling the flock", collect: "Collecting eggs", fetch: "Fetching a wild chicken" }[tk.kind])) return false;
    }
    S.task = tk; S.stage = "walk"; S.t = 0; S.navFail = 0; S.gx = null; S.lostT = 0;
    if (tk.kind === "fetch") { log("fetch", { d: +Math.hypot(tk.mob.position.x - m.position.x, tk.mob.position.z - m.position.z).toFixed(1) }); vlog(m, "poultry", "went to fetch a wild chicken for the coop"); }
  }
  const tk = S.task;
  S.t += dt;
  if (tk.kind === "fetch" && tk.mob.coop === tk.coop && tk.coop) return lead(m, S, tk, dt, out);   // it walked in: lead() logs it and ends the task
  const limit = tk.kind === "fetch" ? LEAD_MAX : TASK_MAX;
  if (S.t > limit || !stillWanted(m, tk)) {
    if (tk.kind === "fetch") log("leadFailed", { why: S.t > limit ? "slow" : "unwanted", stage: S.stage });
    endTask(m, S.t <= limit && tk.kind !== "fetch"); return false;
  }
  ai.mode = "idle"; ai.t = 2;
  if (tk.kind === "fetch" && S.stage !== "walk") return lead(m, S, tk, dt, out);
  // where to go: the nesting box (collect) or the chicken
  const at = tk.kind === "collect" ? { x: m.jobsite.x + 0.5, y: m.jobsite.y, z: m.jobsite.z + 0.5 } : tk.mob.position;
  const d = Math.hypot(at.x - m.position.x, at.z - m.position.z);
  const close = d <= (tk.kind === "collect" ? 2.2 : 1.9) && Math.abs(at.y - m.position.y) < 1.6;
  if (S.stage === "walk") {
    if (close) {
      if (tk.kind === "fetch") { S.stage = "lead"; tk.mob.ledBy = m; tk.mob.crumb = 0; S.trail = [[m.position.x, m.position.y, m.position.z]]; S.trailBase = 0; ai.route = null; return true; }
      S.stage = "act"; S.actT = ACT[tk.kind]; ai.route = null; ai.swingT = 0.35; return true;
    }
    const g = { x: Math.floor(at.x), y: Math.floor(at.y + 0.01), z: Math.floor(at.z) };
    if (S.gx != null && Math.hypot(S.gx - g.x, S.gz - g.z) > 2) ai.route = null;   // the chicken moved: plan again
    S.gx = g.x; S.gz = g.z;
    const st = BF.villageLife.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.2);
    if (st === "failed") { if (tk.kind === "fetch") log("leadFailed", { why: "nopath", stage: "walk", d: +d.toFixed(1) }); endTask(m, false); return false; }
    if (st === "arrived" && tk.kind !== "fetch") { S.stage = "act"; S.actT = ACT[tk.kind]; ai.swingT = 0.35; }
    return true;
  }
  if (d > 2.8) { S.stage = "walk"; return true; }
  out.faceX = at.x; out.faceZ = at.z; if (tk.mob) m.lookAt = tk.mob;
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
  const S = m.pkp;
  if (!S || !S.task) return "";
  if (S.task.kind === "fetch") return S.stage === "walk" ? "Going to fetch a wild chicken" : "Leading a chicken home";
  return { feed: "Feeding the chickens", cull: "Culling the flock", collect: "Collecting eggs" }[S.task.kind] || "";
}
// Counts for the debug screen: chickens loaded near the player, penned and wild.
function counts() {
  let penned = 0, wild = 0, chicks = 0;
  if (BF.mobs) for (const m of BF.mobs.list) if (m.type === "chicken" && live(m)) { if (m.coop) penned++; else wild++; if (m.chick) chicks++; }
  return { penned, wild, chicks };
}

// ---------------------------------------------------------------- egg sprites
if (BF.texKit) {
  const { SPRITES, put, hex, mul, lighten } = BF.texKit;
  const shell = (G, m, yolk) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = (x + 0.5 - 8) / 4.6, dy = (y + 0.5 - (y < 9 ? 9 : 9)) / (y < 9 ? 6 : 5);
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      put(G, x, y, d > 0.75 ? mul(m, 0.78) : x < 7 && y < 8 ? lighten(m, 0.35) : m);
    }
    if (yolk) for (let y = 7; y <= 11; y++) for (let x = 6; x <= 10; x++) if ((x - 8) * (x - 8) + (y - 9) * (y - 9) <= 4.5) put(G, x, y, (x < 8 && y < 9) ? hex("#ffd84a") : hex("#f0b020"));
  };
  SPRITES.egg = (G, m) => shell(G, m, false);
  SPRITES.cooked_egg = (G, m) => {   // a fried egg: a white blot with the yolk in it
    const white = hex("#f8f4ec"), edge = hex("#e0c89a");
    for (let y = 2; y < 15; y++) for (let x = 1; x < 15; x++) {
      const d = Math.hypot((x + 0.5 - 8) / 6.5, (y + 0.5 - 8.5) / 5.8) + Math.sin(x * 1.3 + y * 0.7) * 0.06;
      if (d <= 1) put(G, x, y, d > 0.85 ? edge : white);
    }
    for (let y = 6; y <= 10; y++) for (let x = 6; x <= 10; x++) if ((x - 8) * (x - 8) + (y - 8) * (y - 8) <= 5) put(G, x, y, (x < 8 && y < 8) ? hex("#ffe070") : hex("#f0a818"));
  };
}

BF.poultry = {
  FEED_DAYS, BREED_CD, CHICK_DAYS, LAY_MIN, LAY_MAX, CULL_AT, STOCK_TO, FIND_R, NEST_CAP,
  feed, playerUse, chickenAI, syncLook, hungry, willing, isChick, breed,
  coopsOf, coopOf, tended, seedsWanted, ai, tick, statusText, pickCoopTarget, contain, counts,
  exportAll, importAll, reset,
  coops: () => activeCoops, log: LOG,
};
})();
