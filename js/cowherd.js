// Cows and the cowherd (BF.cowherd). Loaded after js/poultry.js; hooks live in mobs.js, villagelife.js, jobs.js, trading.js, worldgen.js,
// blueprints.js / builder.js, inventory.js and player.js. See CONTRACT.md "Cowherds (js/cowherd.js)".
//
// Cows (every cow, wild or in a pasture; state in `m.cow`):
//  - Fed: wheat from the player or a cowherd makes a cow willing to breed for FEED_DAYS (`fed` = absolute game day it was fed).
//  - Breeding: two willing adults within MATE_R walk to each other and a calf appears; both then rest BREED_CD days. A calf is smaller, drops
//    nothing, gives no milk and grows up after CALF_DAYS (wheat ages it by 10%).
//  - Milking: an empty bucket on an adult cow gives a milk bucket, once a game day per cow (`milkDay`), for the player and the cowherd alike.
//  - Following: a cow within FOLLOW_R of a player holding wheat walks after them (vanilla's tempting). A cowherd leads a wild cow home the same
//    way (it walks the cowherd's trail, gates included).
// Pastures: a fenced field (js/worldgen.js "pasture" with village generator 5, or the builder's "pasture" blueprint). Each pasture holds a list of
//  cow states that outlives the cow mobs: a generated pasture starts with 2-4 cows, a builder's starts empty; respawned whenever the pasture is
//  loaded, saved as "pastures:<village key>". Pasture cows graze only inside the field. The pasture holds one cow per DENSITY cells (`limit`).
// Cowherds (profession "cowherd", jobsite: milk churn): during work hours they bottle their milk at the churn (1 milk bucket + 3 glass bottles ->
//  3 milk bottles and the bucket back), milk every adult once a day, feed wheat to hungry adults while the herd is at or under the limit (they
//  buy wheat from the farmers, js/villagelife.js shopAI), cull adults while it is over the limit and never below MIN_ADULTS (1-3 raw beef and
//  0-2 leather each, kept to sell), and stock a pasture that holds fewer than STOCK_TO cows from wild cows within FIND_R (once a day when none).
//  They cook raw beef into steak in a real furnace with fuel (js/furnaceuse.js, as js/eggcook.js), and buy empty bottles back from the village.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const FEED_DAYS = 1;          // a cow is willing to breed for this long after eating wheat
const BREED_CD = 1;           // days before a cow that bred can breed again
const CALF_DAYS = 3;          // days from birth to adult
const MATE_R = 10, MEET = 2;  // a willing cow looks for a mate this far; they breed when this close
const LOCAL_MAX = 24;         // no breeding when this many cows are already within 16 blocks
const DENSITY = 8;            // one cow per this many pasture cells
const MIN_ADULTS = 2;         // the cowherd never culls below this many adults
const STOCK_TO = 2;           // the cowherd fetches wild cows until its pasture holds this many
const FIND_R = 96;            // how far it looks for a wild cow
const FOLLOW_R = 10;          // cows follow a player holding wheat from this far
const ADOPT_MAX = 24;         // a pasture takes in wandering cows up to this many
const FREE_RADIUS = 10;       // a cowherd without a pasture milks the free cows within 10 blocks of its churn
const TEND_R = 12;            // stray cows this near the pasture are fed and milked too
const WHEAT_KEEP = 2;         // wheat it keeps back for luring a cow home
const MILK_CAP = 32;
const MILK_KEEP = 3;          // milk bottles it never sells (the baker's next cake)          // it stops milking while it holds this many milk bottles
const BOTTLES_LOW = 9;        // it buys empty bottles back while it holds fewer than this ...
const BOTTLES_TO = 30;        // ... up to this many
const KIT_BOTTLES = 30;       // the hire kit: 1 bucket and 30 glass bottles
const BEEF_KEEP = 6;          // raw beef it keeps to sell; the rest is cooked into steak ...
const STEAK_CAP = 24;         // ... while it holds fewer than this many steaks
const WORK_END = 0.5, COOK_END = 0.45;
const TASK_MAX = 45, LEAD_MAX = 240;

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const today = () => Math.floor(now() + 1e-9);
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const I = n => BF.I[n];
const cnt = (m, id) => (id == null || !m.inv ? 0 : TR().inv.count(m.inv, id));
const LOG = [];
const log = (kind, data) => { LOG.push(Object.assign({ kind, day: +now().toFixed(3) }, data)); if (LOG.length > 300) LOG.shift(); };
const vlog = (m, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, "cattle", (BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Cowherd") + " (Cowherd) " + text, m); };
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

let ids = 0;
const idOf = new WeakMap();
const mid = m => { let i = idOf.get(m); if (!i) idOf.set(m, i = ++ids); return i; };

// ---------------------------------------------------------------- cow state
function stOf(m) {
  if (!m.cow) m.cow = { fed: null, cd: 0, growAt: null, milkDay: null, x: null, z: null, mob: m };
  return m.cow;
}
const isCalf = m => !!(m.cow && m.cow.growAt != null);
const hungry = (m, t) => { const s = m.cow; return !s || s.fed == null || t - s.fed >= FEED_DAYS; };
const willing = (m, t) => { const s = m.cow; return !!(s && live(m) && s.growAt == null && s.fed != null && t - s.fed < FEED_DAYS && t >= s.cd); };
const milkedToday = s => !!(s && s.milkDay != null && s.milkDay >= today());
const milkable = m => live(m) && m.type === "cow" && !isCalf(m) && !milkedToday(m.cow);

function syncLook(m) {
  const s = stOf(m), t = now();
  const k = s.growAt != null ? clamp(1 - (s.growAt - t) / CALF_DAYS, 0, 1) : 1;
  m.calf = k < 1;
  if (m._k == null || Math.abs(k - m._k) > 0.02 || (k >= 1 && m._k < 1)) { m._k = k; if (BF.mobs.setCowSize) BF.mobs.setCowSize(m, k); }
}
function fx(m, color, n) { const V = BF.villageLife; if (V && V.particles && m.position) V.particles(m.position.x, m.position.y + m.height + 0.2, m.position.z, color, n, 0.4); }
function snd(name, m, vol) { const V = BF.villageLife; if (V && V.sound && m.position) V.sound(name, m.position.x, m.position.y + 0.5, m.position.z, vol); }

// Wheat eaten by `m` (from the player or a cowherd). Returns false for cows that are not hungry; calves grow 10% faster.
function feed(m, by) {
  if (!live(m) || m.type !== "cow") return false;
  const s = stOf(m), t = now();
  if (s.growAt != null) { s.growAt -= CALF_DAYS * 0.1; syncLook(m); fx(m, "#ffd84a", 4); snd("cow", m, 0.4); return true; }
  if (!hungry(m, t)) return false;
  s.fed = t;
  fx(m, "#ff5a7a", 5); snd("cow", m, 0.5);
  if (BF.emit) BF.emit("cowFed", m, by);
  return true;
}
// Milks `m` (the caller swaps the bucket). Returns false for calves and cows already milked today.
function milk(m, by) {
  if (!milkable(m)) return false;
  stOf(m).milkDay = today();
  fx(m, "#f4f2ea", 4); snd("cow", m, 0.4);
  if (BF.emit) BF.emit("cowMilked", m, by);
  return true;
}
// The player right-clicked a cow holding `sel`: wheat feeds it, an empty bucket milks it. Returns true / a message (handled) or false (not ours).
function playerUse(m, sel) {
  const it = sel && BF.items[sel.id];
  if (!it || !live(m)) return false;
  const creative = BF.player && BF.player.gameMode === "creative", inv = BF.inventory;
  if (it.name === "wheat_item") {
    if (!m.calf && !hungry(m, now())) return "The cow isn't hungry";
    if (!feed(m, "player")) return false;
    if (!creative && inv && inv.consumeSelected) inv.consumeSelected(1);
    return true;
  }
  if (it.name === "bucket" && I("milk_bucket") != null) {
    if (isCalf(m)) return "Calves give no milk";
    if (milkedToday(m.cow)) return "This cow was milked today";
    if (!milk(m, "player")) return false;
    if (!inv) return true;
    if (creative) { inv.add(I("milk_bucket"), 1); return true; }
    inv.consumeSelected(1);
    if (!inv.selected() && inv.setSlot) inv.setSlot(inv.selectedIndex, { id: I("milk_bucket"), count: 1 });
    else { const left = inv.add(I("milk_bucket"), 1); if (left > 0 && BF.drops && BF.player) BF.drops.spawn(I("milk_bucket"), left, BF.player.position.x, BF.player.position.y + 1, BF.player.position.z); }
    return true;
  }
  return false;
}
const playerWheat = () => {
  try { const s = BF.inventory && BF.inventory.selected && BF.inventory.selected(); return !!(s && s.count > 0 && s.id === I("wheat_item")); } catch (e) { return false; }
};

// ---------------------------------------------------------------- breeding
function findMate(m, t) {
  let best = null, bd = MATE_R * MATE_R, near = 0;
  for (const o of BF.mobs.list) {
    if (o.type !== "cow" || !live(o)) continue;
    const dx = o.position.x - m.position.x, dz = o.position.z - m.position.z, d2 = dx * dx + dz * dz;
    if (d2 < 256) near++;
    if (o === m || o.pasture !== m.pasture || !willing(o, t) || Math.abs(o.position.y - m.position.y) > 2) continue;
    if (d2 < bd) { bd = d2; best = o; }
  }
  return near >= LOCAL_MAX ? null : best;
}
function breed(a, b, t) {
  const x = (a.position.x + b.position.x) / 2, z = (a.position.z + b.position.z) / 2, y = Math.max(a.position.y, b.position.y);
  const calf = BF.mobs.spawn("cow", x, y, z);
  if (!calf) return null;
  const s = stOf(calf);
  s.growAt = t + CALF_DAYS; s.cd = t + CALF_DAYS + BREED_CD;
  stOf(a).cd = stOf(b).cd = t + BREED_CD;
  stOf(a).fed = stOf(b).fed = null;   // the meal is spent: they need wheat again to breed again
  const p = a.pasture || b.pasture;
  if (p && p.cows) { s.mob = calf; calf.cow = s; p.cows.push(s); calf.pasture = p; calf.penVillage = p.rec; }
  syncLook(calf);
  fx(a, "#ff5a7a", 5); fx(b, "#ff5a7a", 5); snd("cow", calf, 0.5);
  a.mate = b.mate = null;
  log("bred", { pasture: p ? p.key : null, herd: p ? p.cows.length : null });
  if (p && BF.vlog) BF.vlog.log(p.rec, "cattle", "A calf was born in the pasture (" + plural(p.cows.length, "cow") + ")", calf);
  if (BF.emit) BF.emit("cowBorn", calf, a, b);
  return calf;
}

// ---------------------------------------------------------------- cow movement (mobs.js, before its wander AI): led home, tempted, or to a mate
function follow(m, dt, out, tx, tz, stop, speed) {
  const dx = tx - m.position.x, dz = tz - m.position.z, d = Math.hypot(dx, dz);
  m.ai.mode = "idle"; m.ai.t = 1;
  if (d < stop) { out.faceX = tx; out.faceZ = tz; return true; }
  out.x = dx / d * speed; out.z = dz / d * speed;
  return true;
}
function cowAI(m, dt, out) {
  const t = now(), sp = m.def.speed;
  const L = m.ledBy;
  if (L) {
    const S = L.cwk, tk = S && S.task;
    if (!live(L) || !tk || tk.mob !== m || tk.kind !== "fetch" || S.stage === "walk") { m.ledBy = null; }
    else {
      // walk the cowherd's trail (through the gate) instead of straight at it: crumbs are dropped every 0.6 blocks
      const tr = S.trail, k0 = S.trailBase;
      let ci = Math.max(m.crumb || 0, k0);
      while (ci < k0 + tr.length - 1 && Math.hypot(tr[ci - k0][0] - m.position.x, tr[ci - k0][2] - m.position.z) < 0.8) ci++;
      m.crumb = ci;
      const dk = Math.hypot(L.position.x - m.position.x, L.position.z - m.position.z);
      if (S.stage === "pen") {   // the cowherd waits outside with the gate open: in through the gate, then to the middle of the field
        const P = tk.pasture, [gx, gz] = P.gate, inG = Math.abs(m.position.x - gx - 0.5) < 0.6 && Math.abs(m.position.z - gz - 0.5) < 0.6;
        m.penIn = m.penIn || inG || inRoom(P, m.position);
        return m.penIn ? follow(m, dt, out, (P.x0 + P.x1) / 2, (P.z0 + P.z1) / 2, 0.8, sp) : follow(m, dt, out, gx + 0.5, gz + 0.5, 0.2, sp);
      }
      m.penIn = false;
      m.lookAt = L;
      if (ci >= k0 + tr.length - 1 || dk < 2.6) return follow(m, dt, out, L.position.x, L.position.z, 1.8, sp * 1.2);
      const c = tr[ci - k0];
      return follow(m, dt, out, c[0], c[2], 0.25, sp * 1.25);
    }
  }
  if (!m.pasture && BF.player && BF.player.position && !BF.player.dead && playerWheat()) {
    const p = BF.player.position, d = Math.hypot(p.x - m.position.x, p.z - m.position.z);
    if (d < FOLLOW_R && Math.abs(p.y - m.position.y) < 4) { m.lookAt = "player"; return follow(m, dt, out, p.x, p.z, 2, sp); }
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
  if (d > MATE_R + 4 || m.mateSeek > 30) { m.mate = null; m.mateT = rnd(6, 10); return false; }
  m.ai.mode = "idle"; m.ai.t = 1; m.lookAt = o;
  if (d < MEET) { if (mid(m) < mid(o)) breed(m, o, t); return true; }
  out.x = dx / d * sp; out.z = dz / d * sp;
  return true;
}

// ---------------------------------------------------------------- pastures
// A pasture: {key, rec, idx ("g<n>" generated / "b<id>" built), gen, x0..x1 / z0..z1 (the field the cows graze, block edges), fx0..fx1 / fz0..fz1
// (the fence footprint), y (ground level: cows stand on y + 1), gate [x, z], out [x, z] (the path cell in front of the gate), cells, limit
// (cells / DENSITY), cows (cow states, null until first seen), culls (cows culled there, all time)}.
const limitOf = cells => Math.max(MIN_ADULTS, Math.floor(cells / DENSITY));
function makeGenPasture(rec, b, idx) {
  const at = (u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
  const box = (u0, q0, u1, q1) => {
    const p = at(u0, q0), r = at(u1, q1);
    return [Math.min(p[0], r[0]), Math.min(p[1], r[1]), Math.max(p[0], r[0]) + 1, Math.max(p[1], r[1]) + 1];
  };
  const room = box(1, 1, b.w - 2, b.d - 3), foot = box(0, 0, b.w - 1, b.d - 1);   // the back row holds the hay bales and the trough
  const cells = (b.w - 2) * (b.d - 3);
  return { key: rec.key + "|" + idx, idx: "g" + idx, gen: true, rec, x0: room[0], z0: room[1], x1: room[2], z1: room[3], fx0: foot[0], fz0: foot[1], fx1: foot[2], fz1: foot[3],
    y: b.y, cells, limit: limitOf(cells), cows: null, culls: 0, gate: at(b.du, 0), out: at(b.du, -1) };
}
// A builder's pasture (js/blueprints.js "pasture"): read from the blueprint's marks (turned with the building).
function makeBuiltPasture(rec, e) {
  const bp = BF.builder && BF.builder.bpOf ? BF.builder.bpOf(e) : BF.blueprints && BF.blueprints.get(e.type, e.rot, e.style, e.h, e.opts, e.wood);
  const M = bp && bp.marks;
  if (!M || !M.room || !M.gate || !M.out || !M.fence) return null;
  const at = ([x, z]) => [e.ox + x, e.oz + z], R = M.room.map(at), F = M.fence.map(at);
  const x0 = Math.min(R[0][0], R[1][0]), z0 = Math.min(R[0][1], R[1][1]), x1 = Math.max(R[0][0], R[1][0]) + 1, z1 = Math.max(R[0][1], R[1][1]) + 1;
  const cells = (x1 - x0) * (z1 - z0);
  return { key: rec.key + "|b" + e.id, idx: "b" + e.id, gen: false, rec, x0, z0, x1, z1,
    fx0: Math.min(F[0][0], F[1][0]), fz0: Math.min(F[0][1], F[1][1]), fx1: Math.max(F[0][0], F[1][0]) + 1, fz1: Math.max(F[0][1], F[1][1]) + 1,
    y: e.oy - 1, cells, limit: limitOf(cells), cows: null, culls: 0, gate: at(M.gate[0]), out: at(M.out[0]) };
}
function pasturesOf(rec) {
  if (!rec) return [];
  if (!rec._pastures) {
    Object.defineProperty(rec, "_pastures", { value: [], writable: true, enumerable: false, configurable: true });
    const bl = (rec.wg && rec.wg.buildings) || [];
    bl.forEach((b, i) => { if (b.type === "pasture") rec._pastures.push(makeGenPasture(rec, b, i)); });
  }
  for (const e of rec.built || []) {   // builders' pastures join once they are finished
    if (e.type !== "pasture" || e.state !== "done" || rec._pastures.some(k => k.idx === "b" + e.id)) continue;
    const k = makeBuiltPasture(rec, e);
    if (k) rec._pastures.push(k);
  }
  return rec._pastures;
}
const fenceDist = (p, x, z) => Math.hypot(Math.max(p.fx0 - x, 0, x - p.fx1), Math.max(p.fz0 - z, 0, z - p.fz1));   // 0 inside the fence
const inRoom = (p, pos) => pos.x > p.x0 && pos.x < p.x1 && pos.z > p.z0 && pos.z < p.z1 && Math.abs(pos.y - (p.y + 1)) < 3;

// Is the village's land grass (cows spawn only on grass)? Generated villages know (worldgen v.ground 0 = grass, 1 = sand, 2 = snow); a village
// without a layout looks at the ground at its centre.
function grassVillage(R) {
  if (!R) return false;
  const wg = R.wg;
  if (wg && wg.ground != null) return wg.ground === 0;
  if (wg && wg.biome) return !/desert|snow|ice|tundra/i.test(wg.biome);
  return grassAt(R.x, R.z);
}
// Is the top block at (x, z) grass (or dirt or a path, which grass villages are full of)? Unloaded ground counts as grass.
function grassAt(x, z) {
  const W = BF.world;
  if (!W || !W.isLoaded || !W.isLoaded(Math.floor(x), Math.floor(z))) return true;
  const y = W.heightAt(Math.floor(x), Math.floor(z));
  if (y == null) return false;
  const b = BF.blocks[W.getBlock(Math.floor(x), y, Math.floor(z))], n = b ? b.name : "";
  return n === "grass_block" || n === "dirt" || n === "dirt_path" || n === "coarse_dirt" || n === "farmland" || /_fence|_gate|planks|hay|water|churn/.test(n);
}

let pending = new Map();      // village key -> [{i, c: [packed], k: culls}] from a save, taken as each pasture is first seen
const activePastures = [];    // pastures that are loaded and near the player (rebuilt by tickPastures)
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
const packSt = s => [fix3(s.fed), fix3(s.cd || 0), fix3(s.growAt), s.milkDay == null ? null : s.milkDay | 0,
  s.mob && live(s.mob) ? +s.mob.position.x.toFixed(2) : s.x, s.mob && live(s.mob) ? +s.mob.position.z.toFixed(2) : s.z];
function unpackSt(a) {
  const num = (x, d) => (x != null && Number.isFinite(+x) ? +x : d);
  if (!Array.isArray(a)) return null;
  return { fed: num(a[0], null), cd: num(a[1], 0), growAt: num(a[2], null), milkDay: num(a[3], null), x: num(a[4], null), z: num(a[5], null), mob: null };
}
function initPasture(p) {
  const rec = pending.get(p.rec.key), at = rec && rec.findIndex(e => e && String(e.i) === p.idx);
  if (rec && at >= 0) {
    p.cows = (rec[at].c || []).map(unpackSt).filter(Boolean);
    p.culls = Math.max(0, rec[at].k | 0);
    rec.splice(at, 1);
    if (!rec.length) pending.delete(p.rec.key);
    return;
  }
  p.cows = [];
  if (!p.gen) return;   // a builder's pasture starts empty: the cowherd stocks it from wild cows
  const r = seeded("pasture:" + p.key), n = 2 + (r() < 0.5 ? 1 : 0) + (r() < 0.2 ? 1 : 0);   // a generated pasture starts with 2-4 cows
  for (let i = 0; i < n; i++) p.cows.push({ fed: null, cd: 0, growAt: null, milkDay: null, x: p.x0 + 0.8 + r() * (p.x1 - p.x0 - 1.6), z: p.z0 + 0.8 + r() * (p.z1 - p.z0 - 1.6), mob: null });
}
function spawnCow(p, s) {
  const x = s.x != null && s.x > p.x0 && s.x < p.x1 ? s.x : (p.x0 + p.x1) / 2, z = s.z != null && s.z > p.z0 && s.z < p.z1 ? s.z : (p.z0 + p.z1) / 2;
  const gy = BF.world.heightAt(Math.floor(x), Math.floor(z));
  if (gy == null || gy < BF.MIN_Y + 1) return;
  const m = BF.mobs.spawn("cow", x, gy + 1, z);
  if (!m) return;
  m.cow = s; s.mob = m; m.pasture = p; m.penVillage = p.rec;
  syncLook(m);
}
function tickPastures() {
  const pp = BF.player && BF.player.position;
  activePastures.length = 0;
  if (!pp || !BF.mobs || !BF.mobs.spawn) return;
  const W = BF.world;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec.wg && !(rec.built || []).some(e => e.type === "pasture")) continue;
    if (Math.hypot(rec.x - pp.x, rec.z - pp.z) > 80 && !(BF.villageSim && BF.villageSim.isActive(rec.key))) continue;
    for (const p of pasturesOf(rec)) {
      if (!W.isLoaded(p.fx0, p.fz0) || !W.isLoaded(p.fx1, p.fz1) || !W.isLoaded(p.fx0, p.fz1) || !W.isLoaded(p.fx1, p.fz0)) continue;
      if (!p.cows) initPasture(p);
      activePastures.push(p);
      for (const s of p.cows) if (!s.mob || s.mob.removed || s.mob.dead) { s.mob = null; spawnCow(p, s); }
    }
  }
}
function leavePasture(m) {
  const p = m.pasture;
  if (p && p.cows) { const i = p.cows.indexOf(m.cow); if (i >= 0) { p.cows.splice(i, 1); if (!m.dead) log("left", { pasture: p.key, herd: p.cows.length }); } }
  m.pasture = null; m.penVillage = null;
}
// A cow that walked (or was led) into a pasture joins its herd; one that got out for good leaves it.
function adoptOrRelease(m) {
  if (m.pasture) { if (fenceDist(m.pasture, m.position.x, m.position.z) > 2.5) leavePasture(m); return; }
  for (const p of activePastures) {
    if (inRoom(p, m.position) && p.cows.length < ADOPT_MAX) {
      const s = stOf(m);
      if (p.cows.indexOf(s) < 0) p.cows.push(s);
      const led = !!m.ledBy;
      s.mob = m; m.pasture = p; m.penVillage = p.rec; m.ledBy = null;
      if (!led) log("joined", { pasture: p.key, herd: p.cows.length });   // walked in by itself (a led cow is logged as stocked)
      if (BF.emit) BF.emit("cowPenned", m, p);
      return;
    }
  }
}
function pickPastureTarget(m) {
  const p = m.pasture;
  if (!p) return false;
  m.ai.tx = p.x0 + 0.8 + Math.random() * (p.x1 - p.x0 - 1.6);
  m.ai.tz = p.z0 + 0.8 + Math.random() * (p.z1 - p.z0 - 1.6);
  return true;
}
// A pasture cow never walks into the fence or out of the gate.
function contain(m, d) {
  const p = m.pasture, pos = m.position;
  if (!p) return;
  if (fenceDist(p, pos.x, pos.z) > 1.5) { leavePasture(m); return; }
  const M = 0.5, lx0 = p.x0 + M, lx1 = p.x1 - M, lz0 = p.z0 + M, lz1 = p.z1 - M;
  const nx = pos.x + d.x * 0.35, nz = pos.z + d.z * 0.35;
  if ((nx < lx0 && d.x < 0) || (nx > lx1 && d.x > 0)) d.x = 0;
  if ((nz < lz0 && d.z < 0) || (nz > lz1 && d.z > 0)) d.z = 0;
  if (pos.x < lx0 - 0.1) d.x = Math.max(d.x, 0.8); else if (pos.x > lx1 + 0.1) d.x = Math.min(d.x, -0.8);
  if (pos.z < lz0 - 0.1) d.z = Math.max(d.z, 0.8); else if (pos.z > lz1 + 0.1) d.z = Math.min(d.z, -0.8);
}

// ---------------------------------------------------------------- the global tick: calves growing up, pasture stock
let acc = 0, pastureT = 0;
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("mobKilled", m => { if (m && m.type === "cow" && m.pasture) leavePasture(m); });
}
function tick(dt) {
  hook();
  acc += dt; pastureT -= dt;
  if (pastureT <= 0 && BF.world) { pastureT = 1; try { tickPastures(); } catch (e) { console.error(e); } }
  if (acc < 0.5 || !BF.mobs) return;
  acc = 0;
  if (toShut.length) shutGates();
  const t = now();
  for (const m of BF.mobs.list) {
    if (m.type !== "cow" || !live(m)) continue;
    const s = stOf(m);
    if (s.growAt != null && t >= s.growAt) { s.growAt = null; s.cd = Math.max(s.cd, t); }
    if (s.growAt != null && s.growAt - t > CALF_DAYS * 2) s.growAt = t + CALF_DAYS;   // time was set back
    syncLook(m);
    adoptOrRelease(m);
  }
  for (const p of activePastures) for (const s of p.cows) if (!s.mob && s.growAt != null && t >= s.growAt) s.growAt = null;   // unloaded calves grow up too
}

// ---------------------------------------------------------------- persistence
function exportAll(out) {
  if (!BF.mobs) return;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec._pastures) continue;
    const arr = [];
    for (const p of rec._pastures) if (p.cows) arr.push({ i: p.idx, c: p.cows.map(packSt), k: p.culls | 0 });
    for (const e of pending.get(rec.key) || []) arr.push(e);
    if (arr.length) out["pastures:" + rec.key] = arr;
  }
  for (const [k, v] of pending) if (!(("pastures:" + k) in out) && v.length) out["pastures:" + k] = v;
}
function importAll(o) {
  pending = new Map();
  if (!o || typeof o !== "object") return;
  for (const k in o) if (k.slice(0, 9) === "pastures:" && Array.isArray(o[k])) pending.set(k.slice(9), o[k].filter(e => e && e.i != null && Array.isArray(e.c)));
}
function reset() { pending = new Map(); activePastures.length = 0; toShut.length = 0; acc = 0; pastureT = 0; LOG.length = 0; }

// ---------------------------------------------------------------- the hire kit
// 1 bucket and 30 glass bottles, once per villager (`cowKit`, saved by trading.js pack), when it first becomes a cowherd: at village generation
// (trading.js stockFor puts it in the starting pack) or later (jobs.js hire). Glass bottles enter a village only this way.
function kitInto(a, v) {
  if (!Array.isArray(a) || (v && v.cowKit)) return false;
  if (I("bucket") != null) TR().inv.add(a, I("bucket"), 1);
  if (I("glass_bottle") != null) TR().inv.add(a, I("glass_bottle"), KIT_BOTTLES);
  if (v && typeof v === "object") v.cowKit = true;
  log("kit", { who: v && v.slot ? v.slot.idx : null });
  return true;
}
function hireKit(m) { return !!(m && Array.isArray(m.inv) && kitInto(m.inv, m)); }

// ---------------------------------------------------------------- the cowherd
const cwk = m => m.cwk || (m.cwk = { task: null, stage: null, t: 0, actT: 0, cd: rnd(0, 2), avoid: new Map(), navFail: 0, stockAt: 0, trail: [], trailBase: 0 });
// The pasture this cowherd works: the one its milk churn stands beside (fence within 4.5 blocks).
function pastureOf(m) {
  const S = cwk(m);
  if (!m.jobsite || !m.village) return null;
  if (S.pFor === m.jobsite && S.pasture && pasturesOf(m.village).includes(S.pasture)) return S.pasture;
  let best = null, bd = 4.5;
  for (const p of pasturesOf(m.village)) { const d = fenceDist(p, m.jobsite.x + 0.5, m.jobsite.z + 0.5); if (d < bd) { bd = d; best = p; } }
  S.pFor = m.jobsite; S.pasture = best;
  return best;
}
// What the cowherd looks after: {pasture, herd (live pasture cows, counted for culling), cows (live cows to feed and milk: the herd and strays
// near it, or without a pasture the free cows near the churn), size (the herd, unloaded ones too), limit}.
function tended(m) {
  const p = pastureOf(m), list = BF.mobs.list;
  const home = m.jobsite ? { x: m.jobsite.x + 0.5, z: m.jobsite.z + 0.5 } : m.position;
  const near = o => o.type === "cow" && live(o) && !o.ledBy && !o.pasture && Math.hypot(o.position.x - home.x, o.position.z - home.z) <= (p ? TEND_R : FREE_RADIUS) && Math.abs(o.position.y - m.position.y) < 6;
  const herd = p && p.cows ? p.cows.map(s => s.mob).filter(live) : [];
  const cows = herd.concat(list.filter(near));
  return { pasture: p, herd, cows, size: p && p.cows ? p.cows.length : 0, limit: p ? p.limit : 0 };
}
const adults = a => a.filter(o => !isCalf(o));
const adultStates = p => (p && p.cows ? p.cows.filter(s => s.growAt == null).length : 0);
// Wheat the cowherd wants to buy now (0 = enough): under max(WHEAT_KEEP, adults) it tops up to ~2 days of feed plus the lure. None without a pasture.
function wheatWanted(m) {
  if (m.profession !== "cowherd" || !m.inv || !BF.mobs) return 0;
  const p = pastureOf(m);
  if (!p) return 0;
  const n = Math.max(STOCK_TO, adultStates(p)), have = cnt(m, I("wheat_item"));
  if (have >= Math.max(WHEAT_KEEP, n)) return 0;
  return n * 2 + WHEAT_KEEP + 2 - have;
}
// Empty bottles it wants to buy back (0 = enough).
function bottleWanted(m) {
  if (m.profession !== "cowherd" || !m.inv || I("glass_bottle") == null) return 0;
  const have = cnt(m, I("glass_bottle"));
  return have < BOTTLES_LOW ? BOTTLES_TO - have : 0;
}
// Its market reserve (js/market.js reserve: nothing in it is sold, to villagers or the player): one pail (a bucket or a milk bucket: never its
// last), every milk bucket (it bottles them), every empty glass bottle (it fills them), MILK_KEEP milk bottles and its cows' wheat.
function reserve(m) {
  const out = [], c = id => (id == null ? 0 : cnt(m, id)), set = (...ids) => new Set(ids.filter(id => id != null));
  if (m.profession !== "cowherd" || !Array.isArray(m.inv)) return out;
  const b = I("bucket"), mb = I("milk_bucket"), gb = I("glass_bottle"), milk = I("milk_bottle"), w = I("wheat_item");
  if (c(b) + c(mb) > 0) out.push({ ids: set(b, mb), n: 1 });
  if (c(mb) > 0) out.push({ ids: set(mb), n: c(mb) });
  if (c(gb) > 0) out.push({ ids: set(gb), n: c(gb) });
  if (milk != null) out.push({ ids: set(milk), n: MILK_KEEP });
  if (w != null) out.push({ ids: set(w), n: c(w) + wheatWanted(m) });
  return out;
}
// Glass bottles it needs to bottle the milk buckets it holds (3 each), plus 3 for the next one.
const canBottle = m => cnt(m, I("milk_bucket")) > 0 && cnt(m, I("glass_bottle")) >= 3;
const canMilk = m => cnt(m, I("bucket")) > 0 && cnt(m, I("glass_bottle")) >= 3 * (cnt(m, I("milk_bucket")) + 1) && cnt(m, I("milk_bottle")) < MILK_CAP;
// Whether feeding cow o now keeps the herd within one over its limit once the willing cows have paired up (each pair gives one calf); the
// cull then takes it back to the limit. Fed strays near the pasture count as if they had walked in through the gate (they can, and then breed
// in the herd), and so does o when it is a stray.
function feedOk(T, o, t) {
  if (!T.pasture) return true;
  const strays = adults(T.cows).filter(x => x.pasture !== T.pasture);
  const willingHerd = adults(T.herd).filter(x => !hungry(x, t)).length, willingStray = strays.filter(x => !hungry(x, t)).length;
  const join = o.pasture !== T.pasture ? 1 : 0;
  return T.size + willingStray + join + Math.floor((willingHerd + willingStray + 1) / 2) <= T.limit + 1;
}
function wildCow(m, p, S) {
  const c = { x: (p.x0 + p.x1) / 2, z: (p.z0 + p.z1) / 2 }, sim = BF.simNow();
  let best = null, bd = FIND_R;
  for (const o of BF.mobs.list) {
    if (o.type !== "cow" || !live(o) || o.pasture || o.ledBy || isCalf(o) || (S.avoid.get(o) || 0) > sim) continue;
    const d = Math.hypot(o.position.x - c.x, o.position.z - c.z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
function pickTask(m, S) {
  const T = tended(m), t = now(), sim = BF.simNow(), px = m.position.x, pz = m.position.z;
  const ok = o => !((S.avoid.get(o) || 0) > sim);
  const nearest = a => { let best = null, bd = Infinity; for (const o of a) { const d = Math.hypot(o.position.x - px, o.position.z - pz); if (d < bd) { bd = d; best = o; } } return best; };
  const p = T.pasture;
  if (canBottle(m) && m.jobsite) return { kind: "bottle" };
  if (canMilk(m)) { const o = nearest(T.cows.filter(x => ok(x) && milkable(x))); if (o) return { kind: "milk", mob: o }; }
  if (!p) return null;   // without a pasture it only milks the cows that come by its churn
  const wheat = cnt(m, I("wheat_item")), spare = p.cows && p.cows.length < STOCK_TO ? wheat - 1 : wheat;   // one wheat is always kept to lure a cow home
  const ad = adults(T.cows).filter(ok);
  if (spare > 0 && T.size <= T.limit) { const o = nearest(ad.filter(x => hungry(x, t) && feedOk(T, x, t))); if (o) return { kind: "feed", mob: o }; }
  if (T.size > T.limit && adults(T.herd).length > MIN_ADULTS && adultStates(p) > MIN_ADULTS) { const o = nearest(adults(T.herd).filter(ok)); if (o) return { kind: "cull", mob: o }; }
  if (p.cows && p.cows.length < STOCK_TO && wheat > 0 && t >= S.stockAt) {
    const o = wildCow(m, p, S);
    if (o) return { kind: "fetch", mob: o, pasture: p };
    if (wildCow(m, p, { avoid: new Map() })) { S.stockAt = t + 0.1; return null; }   // only ones it just failed to bring in: tries them again in a while
    S.stockAt = Math.floor(t) + 1 + 0.03;   // none in range: look again tomorrow morning
    log("noWild", { pasture: p.key });
    vlog(m, "found no wild cows within " + FIND_R + " blocks of the pasture; will look again tomorrow");
  }
  return null;
}
function stillWanted(m, tk) {
  if (tk.kind === "bottle") return canBottle(m) && !!m.jobsite;
  const o = tk.mob;
  if (!live(o)) return false;
  if (tk.kind === "fetch") return !o.pasture && cnt(m, I("wheat_item")) > 0 && !(o.ledBy && o.ledBy !== m);
  if (isCalf(o)) return false;
  if (tk.kind === "milk") return milkable(o) && canMilk(m);
  const T = tended(m);
  if (tk.kind === "feed") return hungry(o, now()) && cnt(m, I("wheat_item")) > 0 && T.size <= T.limit && feedOk(T, o, now());
  return T.size > T.limit && adults(T.herd).length > MIN_ADULTS && adultStates(T.pasture) > MIN_ADULTS && T.herd.indexOf(o) >= 0;
}
function endTask(m, ok) {
  const S = cwk(m), tk = S.task;
  if (tk && !ok && tk.mob) S.avoid.set(tk.mob, BF.simNow() + (tk.kind === "fetch" ? 120 : 40));
  if (tk && tk.mob && tk.mob.ledBy === m) tk.mob.ledBy = null;
  if (S.gateHeld) { toShut.push({ at: S.gateHeld, m, t: BF.simNow() }); S.gateHeld = null; shutGates(); }
  S.task = null; S.stage = null; m.ai.route = null; S.trail = []; S.trailBase = 0;
}
// Gates a cowherd held open for a cow are shut as soon as nothing stands in them (and the cowherd is out of the way); checked from tick().
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
// 1 milk bucket + 3 glass bottles -> 3 milk bottles, the bucket back (the player's recipe too). Returns the bottles made.
function bottle(m) {
  const T = TR().inv, mb = I("milk_bucket"), gb = I("glass_bottle"), ml = I("milk_bottle"), bk = I("bucket");
  let made = 0;
  while (cnt(m, mb) > 0 && cnt(m, gb) >= 3 && T.canFit(m.inv, [{ id: ml, n: 3 }, { id: bk, n: 1 }], [{ id: mb, n: 1 }, { id: gb, n: 3 }])) {
    T.remove(m.inv, mb, 1); T.remove(m.inv, gb, 3);
    T.add(m.inv, ml, 3); T.add(m.inv, bk, 1);
    made += 3;
  }
  return made;
}
function perform(m, tk) {
  const T = TR().inv;
  if (tk.kind === "bottle") {
    const n = bottle(m);
    if (n) { log("bottled", { bottles: n, held: cnt(m, I("milk_bottle")) }); vlog(m, "bottled " + plural(n, "milk bottle") + " at the churn"); }
    return n > 0;
  }
  const o = tk.mob, p = pastureOf(m);
  if (tk.kind === "milk") {
    if (T.count(m.inv, I("bucket")) < 1 || !T.canFit(m.inv, [{ id: I("milk_bucket"), n: 1 }], [{ id: I("bucket"), n: 1 }])) return false;
    if (!milk(o, m)) return false;
    T.remove(m.inv, I("bucket"), 1); T.add(m.inv, I("milk_bucket"), 1);
    const herd = p && p.cows ? p.cows.filter(milkedToday).length : 0;
    log("milked", { pasture: !!o.pasture, milkedToday: herd });
    vlog(m, "milked a cow" + (o.pasture ? " (" + herd + " of " + plural(p.cows.length, "cow") + " milked today)" : ""));
    return true;
  }
  if (tk.kind === "feed") {
    if (T.remove(m.inv, I("wheat_item"), 1) < 1) return false;
    if (!feed(o, m)) { T.add(m.inv, I("wheat_item"), 1); return false; }
    return true;
  }
  // cull: the cowherd keeps the cow's drops (1-3 raw beef, 0-2 leather) to sell
  const herdP = o.pasture;
  BF.mobs.hurt(o, 999, "a cowherd");
  const beef = loot(m, I("raw_beef"), rndInt(1, 3), o), lea = loot(m, I("leather"), rndInt(0, 2), o);
  if (herdP) herdP.culls = (herdP.culls | 0) + 1;
  const T2 = tended(m);
  log("culled", { beef, leather: lea, herd: T2.size, limit: T2.limit });
  vlog(m, "culled a cow (" + T2.size + " left, the pasture holds " + T2.limit + "): " + beef + " raw beef, " + lea + " leather");
  return true;
}
const ACT = { feed: 0.7, cull: 0.8, milk: 1.4, bottle: 1.6 };
// A cowherd with nothing to do inside a pasture walks out through the gate, so it never wanders around stuck among the cows.
function leave(m, S, dt, out) {
  const p = m.position;
  let P = S.exit;
  if (!P) {
    const R = m.village;
    if (!R) return false;
    P = pasturesOf(R).find(q => p.x > q.fx0 && p.x < q.fx1 && p.z > q.fz0 && p.z < q.fz1 && Math.abs(p.y - (q.y + 1)) < 2 && q.out);
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
// Leading a wild cow home: to the path in front of the gate, then into the middle of the field. The cow walks the cowherd's trail (cowAI); the
// cowherd waits when it falls behind and holds the gate open until it is in.
function lead(m, S, tk, dt, out) {
  const o = tk.mob, P = tk.pasture, p = m.position;
  const dk = Math.hypot(o.position.x - p.x, o.position.z - p.z);
  S.lostT = dk > 16 ? (S.lostT || 0) + dt : 0;
  if (S.lostT > 10 || S.t > LEAD_MAX) { log("leadFailed", { why: S.lostT > 10 ? "lost" : "slow", d: +dk.toFixed(1) }); endTask(m, false); return false; }
  if (o.pasture === P) {
    log("stocked", { pasture: P.key, herd: P.cows.length });
    vlog(m, "brought a wild cow into the pasture (" + plural(P.cows.length, "cow") + ")");
    endTask(m, true); S.cd = rnd(0.5, 1);
    return false;
  }
  const last = S.trail[S.trail.length - 1];
  if (!last || Math.hypot(last[0] - p.x, last[2] - p.z) > 0.6) { S.trail.push([p.x, p.y, p.z]); if (S.trail.length > 60) { S.trail.shift(); S.trailBase++; } }
  if (P.gate) {   // hold the gate open while the cow is on its way in
    const [gx, gz] = P.gate, gy = P.y + 1, bk = BF.blocks[BF.world.getBlock(gx, gy, gz)];
    if (bk && bk.gate && Math.hypot(gx + 0.5 - p.x, gz + 0.5 - p.z) < 3) { if (!bk.gate.open) BF.world.setGate(gx, gy, gz, true); S.gateHeld = [gx, gy, gz]; }
    if (bk && bk.gate && bk.gate.open) {   // not shut behind it: by its own walking (mobs.js villagerDoors) or an earlier fetch's pending close
      S.gateHeld = [gx, gy, gz];
      if (m.ai.doors) m.ai.doors = m.ai.doors.filter(([x, y, z]) => !(x === gx && y === gy && z === gz));
      for (let i = toShut.length - 1; i >= 0; i--) { const a = toShut[i].at; if (a[0] === gx && a[1] === gy && a[2] === gz) toShut.splice(i, 1); }
    }
  }
  if (S.stage === "pen") {   // at the gate: the cow walks in by itself (cowAI) while the cowherd holds the gate open
    m.ai.route = null; out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o;
    if ((S.inT = (S.inT || 0) + dt) > 20) { S.stage = "lead"; S.inT = 0; S.trail = [[p.x, p.y, p.z]]; S.trailBase = 0; o.crumb = 0; }   // it wandered off: lead it back to the gate
    return true;
  }
  if (dk > 5.5) {   // wait for it; if it doesn't come (caught behind something), go back for it and start the trail again from there
    m.ai.route = null; out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o;
    if ((S.waitT = (S.waitT || 0) + dt) > 8) { S.waitT = 0; S.stage = "walk"; S.gx = null; o.ledBy = null; }
    return true;
  }
  S.waitT = 0;
  const st = BF.villageLife.travel(m, S, dt, out, P.out[0], P.y + 1, P.out[1], m.def.speed * 0.8);
  if (st === "arrived") { m.ai.route = null; if (dk < 3.2) { S.stage = "pen"; S.inT = 0; } else { out.faceX = o.position.x; out.faceZ = o.position.z; m.lookAt = o; } }
  else if (st === "failed") { log("leadFailed", { why: "nopath" }); endTask(m, false); return false; }
  return true;
}
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.tradingWith || !BF.mobs.nav || !BF.villageLife || m.sleeping) return false;
  const S = cwk(m), ai = m.ai, t = skyT();
  if (t >= WORK_END || t < 0.02) { if (S.task) endTask(m, true); return t >= WORK_END && leave(m, S, dt, out); }
  if (!S.task && leave(m, S, dt, out)) return true;
  if (!S.task) {
    if ((S.cd -= dt) > 0) return cookAI(m, dt, out, false);
    S.cd = rnd(1.5, 3);
    const tk = pickTask(m, S);
    if (!tk) return cookAI(m, dt, out, false);
    S.task = tk; S.stage = "walk"; S.t = 0; S.navFail = 0; S.gx = null; S.lostT = 0;
    if (tk.kind === "fetch") { log("fetch", { d: +Math.hypot(tk.mob.position.x - m.position.x, tk.mob.position.z - m.position.z).toFixed(1) }); vlog(m, "went to fetch a wild cow for the pasture"); }
  }
  const tk = S.task;
  S.t += dt;
  if (tk.kind === "fetch" && tk.mob.pasture === tk.pasture && tk.pasture) return lead(m, S, tk, dt, out);   // it walked in: lead() logs it and ends the task
  const limit = tk.kind === "fetch" ? LEAD_MAX : TASK_MAX;
  if (S.t > limit || !stillWanted(m, tk)) {
    if (tk.kind === "fetch") log("leadFailed", { why: S.t > limit ? "slow" : "unwanted", stage: S.stage });
    endTask(m, S.t <= limit && tk.kind !== "fetch"); return false;
  }
  ai.mode = "idle"; ai.t = 2;
  if (tk.kind === "fetch" && S.stage !== "walk") return lead(m, S, tk, dt, out);
  // where to go: the churn (bottling) or the cow
  const at = tk.kind === "bottle" ? { x: m.jobsite.x + 0.5, y: m.jobsite.y, z: m.jobsite.z + 0.5 } : tk.mob.position;
  const d = Math.hypot(at.x - m.position.x, at.z - m.position.z);
  const close = d <= (tk.kind === "bottle" ? 2.2 : 2.3) && Math.abs(at.y - m.position.y) < 1.6;
  if (S.stage === "walk") {
    if (close) {
      if (tk.kind === "fetch") { S.stage = "lead"; tk.mob.ledBy = m; tk.mob.crumb = 0; S.trail = [[m.position.x, m.position.y, m.position.z]]; S.trailBase = 0; ai.route = null; return true; }
      S.stage = "act"; S.actT = ACT[tk.kind]; ai.route = null; ai.swingT = 0.35; return true;
    }
    const g = { x: Math.floor(at.x), y: Math.floor(at.y + 0.01), z: Math.floor(at.z) };
    if (S.gx != null && Math.hypot(S.gx - g.x, S.gz - g.z) > 2) ai.route = null;   // the cow moved: plan again
    S.gx = g.x; S.gz = g.z;
    const st = BF.villageLife.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.2);
    if (st === "failed") { if (tk.kind === "fetch") log("leadFailed", { why: "nopath", stage: "walk", d: +d.toFixed(1) }); endTask(m, false); return false; }
    if (st === "arrived" && tk.kind !== "fetch") { S.stage = "act"; S.actT = ACT[tk.kind]; ai.swingT = 0.35; }
    return true;
  }
  if (d > 3.2) { S.stage = "walk"; return true; }
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

// ---------------------------------------------------------------- cooking beef in a furnace (js/furnaceuse.js; the errand of js/eggcook.js)
// It cooks the raw beef it holds beyond BEEF_KEEP (kept to sell) into steak, while it holds fewer than STEAK_CAP steaks, in a real furnace of
// its village with fuel it holds or buys (coal first; wood it does not sell). Never instantly, never without a furnace and fuel.
const FU = () => BF.furnaceUse;
const RAW = () => I("raw_beef"), STEAK = () => I("steak");
const CHECK = 4, TRADE_PAUSE = 1.6;
const cst = m => m.cwc || (m.cwc = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0 });
const avoided = (S, k) => (S.avoid[k] || 0) > now();
function toCook(m) {
  if (RAW() == null || STEAK() == null) return 0;
  const n = Math.min(cnt(m, RAW()) - BEEF_KEEP, STEAK_CAP - cnt(m, STEAK()), 16);
  return n >= 3 ? n : 0;
}
const fuelOk = m => id => FU().isCoal(id) || !(m.trades || []).some(o => o && !o.spare && !o.need && o.sell && o.sell.id === id);   // never burns its job's wares (a spare-goods offer doesn't count, js/market.js)
const skipFurnace = S => f => avoided(S, "f:" + FU().pk(f.x, f.y, f.z));
const skipOffer = S => (v2, o) => avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id);
function cookPlan(m, n) {
  const F = FU(), S = cst(m), fs = F.near(m, RAW(), STEAK(), skipFurnace(S));
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
  return { kind: "cook", furnace: p.furnace, rawId: RAW(), outId: STEAK(), n, fuelOk: fuelOk(m) };
}
function finishCook(m, deal, all) {
  const F = FU(), f = deal.furnace, got = F.empty(m, deal, all) || [];
  const cooked = got.filter(e => e.id === STEAK()).reduce((a, e) => a + e.n, 0);
  log("cooked", { steak: cooked, loaded: deal.loaded || 0, at: F.pk(f.x, f.y, f.z) });
  if (cooked > 0) vlog(m, "cooked " + cooked + " steak in the furnace at " + F.pk(f.x, f.y, f.z));
}
// Villager AI step (mobs.js villagerAI early with cont = true to carry on an errand under way; ai() above when it has no herd work).
function cookAI(m, dt, out, cont) {
  if (cont && !(m.cwc && m.cwc.stage)) return false;
  if (!m.inv || m.dead || m.child || m.type !== "villager" || !BF.mobs || !BF.mobs.nav || !m.village || !FU() || RAW() == null || STEAK() == null) return false;
  const F = FU(), S = cst(m), a = m.ai;
  if (skyT() >= COOK_END || m.tradingWith) {
    if (S.stage) { if (S.deal && S.deal.kind === "cook" && S.deal.loaded) finishCook(m, S.deal, true); S.stage = null; S.deal = null; a.route = null; }
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
    S.deal = deal; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
  }
  const deal = S.deal;
  const giveUp = (why, key) => {
    log("cookGiveup", { kind: deal.kind, why });
    if (key) S.avoid[key] = now() + 0.05;
    if (deal.kind === "cook" && deal.loaded) finishCook(m, deal, true);
    S.stage = null; S.deal = null; a.route = null; S.checkT = 0.5; return false;
  };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  if (deal.kind === "cook") {
    const s = deal.furnace, fkey = "f:" + F.pk(s.x, s.y, s.z), near = F.beside(s);
    const go = () => F.travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, near, "beef");
    if (S.stage === "walk") {
      if (S.walkT > 90) return giveUp("timeout", fkey);
      if (!F.usable(m, s, deal.rawId, deal.outId)) return giveUp("furnace busy", fkey);
      const st = go();
      if (st === "failed") return giveUp("no path", fkey);
      if (st === "arrived") { S.stage = "work"; S.tt = TRADE_PAUSE; S.waitT = 0; }
      return true;
    }
    if (S.stage === "cook" && Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) > 3) {   // pulled away (a zombie): back to the furnace
      if (go() === "failed") { F.inUse.delete(F.pk(s.x, s.y, s.z)); log("cookGiveup", { kind: "cook", why: "cannot get back" }); S.stage = null; S.deal = null; a.route = null; return false; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.4 };
    if (S.stage === "work") {
      if ((S.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
      const n = F.load(m, deal, deal.n);
      if (!n) return giveUp("furnace busy", fkey);
      S.stage = "cook";
      log("load", { beef: n, at: F.pk(s.x, s.y, s.z), ownFuel: deal.ownFuel || 0 });
      return true;
    }
    const st = BF.inventory.furnaceState(s.x, s.y, s.z);
    if (!st || !BF.isFurnace(BF.world.getBlock(s.x, s.y, s.z))) { F.inUse.delete(F.pk(s.x, s.y, s.z)); return giveUp("furnace gone", fkey); }
    S.waitT += dt;
    if (!st.slots[0] || st.slots[0].id !== deal.rawId) { finishCook(m, deal, false); S.stage = null; S.deal = null; S.checkT = 0.5; return true; }   // all cooked
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
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "beef") a.route = null; S.gx = g.x; S.gz = g.z; }
    if (F.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3, null, "beef") === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const done = F.doBuy(m, deal);
    S.stage = null; S.deal = null; S.gx = null; S.checkT = 0.5;
    if (done) log("buyFuel", { from: v2.profession, got: done * deal.offer.sell.n + " " + BF.itemName(deal.item) });
    else { S.avoid[key] = now() + 0.05; log("cookGiveup", { kind: "buy", why: "trade refused" }); }
  }
  return true;
}
if (BF.furnaceUse) BF.furnaceUse.busyWhen(u => !!(u.cwc && u.cwc.stage === "cook"));   // it holds the furnace while its beef cooks

function statusText(m) {
  const C = m.cwc;
  if (C && C.stage && C.deal) return C.deal.kind === "buy" ? "Buying fuel to cook beef" : C.stage === "cook" ? "Cooking beef" : "Taking beef to a furnace";
  const S = m.cwk;
  if (!S || !S.task) return "";
  if (S.task.kind === "fetch") return S.stage === "walk" ? "Going to fetch a wild cow" : "Leading a cow home";
  return { feed: "Feeding the cows", cull: "Culling the herd", milk: "Milking a cow", bottle: "Bottling milk" }[S.task.kind] || "";
}
// For the debug screen (js/debugfeed.js flockOf): the herd of a cowherd.
function holdings(m) {
  const T = tended(m), p = T.pasture;
  const states = p && p.cows ? p.cows : [];
  return { kind: "cows", n: p ? T.size : T.cows.length, young: p ? states.filter(s => s.growAt != null).length : T.cows.filter(o => o.calf).length,
    milked: p ? states.filter(milkedToday).length : T.cows.filter(o => milkedToday(o.cow)).length, culls: p ? p.culls | 0 : 0, limit: T.limit, coop: !!p };
}
// Counts for the debug screen: cows loaded near the player, in a pasture and wild.
function counts() {
  let penned = 0, wild = 0, calves = 0;
  if (BF.mobs) for (const m of BF.mobs.list) if (m.type === "cow" && live(m)) { if (m.pasture) penned++; else wild++; if (m.calf) calves++; }
  return { penned, wild, calves };
}

// ---------------------------------------------------------------- sprites and recipes
if (BF.texKit) {
  const { SPRITES, put, hex } = BF.texKit;
  const flask = (G, fill) => {   // a round-bellied bottle with a cork; `fill` = the milk colour, or null for an empty one
    const glass = hex("#c8dce4"), rim = hex("#8fb4c4"), hi = hex("#f4fbff"), cork = hex("#9a6a3a"), corkD = hex("#6e4826");
    for (let y = 1; y <= 3; y++) for (let x = 6; x <= 9; x++) put(G, x, y, x === 6 ? cork : y === 1 ? cork : corkD);
    for (let y = 4; y <= 6; y++) for (let x = 6; x <= 9; x++) put(G, x, y, x === 6 || x === 9 ? rim : fill && y >= 6 ? fill : glass);
    for (let y = 7; y <= 14; y++) for (let x = 2; x <= 13; x++) {
      const d = Math.hypot((x + 0.5 - 8) / 6, (y + 0.5 - 10.8) / 4.4);
      if (d > 1) continue;
      put(G, x, y, d > 0.82 ? rim : fill && y >= 8 ? fill : glass);
    }
    put(G, 4, 9, hi); put(G, 4, 10, hi); put(G, 5, 8, hi); put(G, 7, 5, hi);
  };
  SPRITES.glass_bottle = G => flask(G, null);
  SPRITES.milk_bottle = G => flask(G, hex("#f8f6ee"));
}
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, addShapeless }) => {
  const R = BF.I;
  if (R.glass_bottle != null && R.glass != null) addShaped(R.glass_bottle, 3, ["G G", " G "], { G: R.glass }, "3 Glass in a V → 3 Glass Bottles");
  if (R.milk_bottle != null && R.milk_bucket != null && R.glass_bottle != null && addShapeless)
    addShapeless(R.milk_bottle, 3, [R.milk_bucket, R.glass_bottle, R.glass_bottle, R.glass_bottle], "Milk Bucket + 3 Glass Bottles → 3 Milk Bottles (the bucket stays)");
});

BF.cowherd = {
  FEED_DAYS, BREED_CD, CALF_DAYS, DENSITY, MIN_ADULTS, STOCK_TO, FIND_R, KIT_BOTTLES, MILK_CAP, MILK_KEEP, BEEF_KEEP, reserve, STEAK_CAP, WORK_END,
  feed, milk, milkable, milkedToday, playerUse, cowAI, syncLook, hungry, willing, isCalf, breed, bottle,
  pasturesOf, pastureOf, tended, wheatWanted, bottleWanted, kitInto, hireKit, grassVillage, grassAt,
  ai, cookAI, toCook, tick, statusText, holdings, pickPastureTarget, contain, counts,
  exportAll, importAll, reset,
  pastures: () => activePastures, log: LOG,
};
})();
