// Pigs (BF.pigs): feeding and breeding (idea-037, release 1.3). Loaded after js/cowherd.js; hooks live in mobs.js (AI chain, piglet size, no
// drops from piglets), player.js (right click) and mobsave.js (a wild pig's state is saved with it).
//  - Fed: a carrot, potato or beetroot from the player makes a pig willing to breed for FEED_DAYS (`fed` = absolute game day it was fed).
//  - Breeding: two willing adults within MATE_R walk to each other and a piglet appears; both then rest BREED_CD days. A piglet is smaller,
//    drops nothing and grows up after PIGLET_DAYS (food ages it by 10%).
//  - Following: a pig within FOLLOW_R of a player holding its food walks after them (vanilla's tempting).
//  - Wild pigs also breed on their own (js/wildlife.js makes a pair willing, then the same walk and piglet follow).
// API: BF.pigs = { FEED_DAYS, BREED_CD, PIGLET_DAYS, feed, playerUse, pigAI, breed, willing, hungry, isPiglet, syncLook, tick, stOf }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const FEED_DAYS = 1;          // a pig is willing to breed for this long after eating
const BREED_CD = 1;           // days before a pig that bred can breed again
const PIGLET_DAYS = 3;        // days from birth to adult
const MATE_R = 10, MEET = 2;  // a willing pig looks for a mate this far; they breed when this close
const LOCAL_MAX = 24;         // no breeding when this many pigs are already within 16 blocks
const FOLLOW_R = 10;          // pigs follow a player holding their food from this far
const FOODS = new Set(["carrot", "potato", "beetroot"]);

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => (BF.sky ? (BF.sky.day || 0) + (typeof BF.sky.time === "number" ? BF.sky.time : 0.25) : 0);
const live = o => !!(o && !o.dead && !o.removed);

let ids = 0;
const idOf = new WeakMap();
const mid = m => { let i = idOf.get(m); if (!i) idOf.set(m, i = ++ids); return i; };

function stOf(m) {
  if (!m.pig) m.pig = { fed: null, cd: 0, growAt: null, mob: m };
  return m.pig;
}
const isPiglet = m => !!(m.pig && m.pig.growAt != null);
const hungry = (m, t) => { const s = m.pig; return !s || s.fed == null || t - s.fed >= FEED_DAYS; };
const willing = (m, t) => { const s = m.pig; return !!(s && live(m) && s.growAt == null && s.fed != null && t - s.fed < FEED_DAYS && t >= s.cd); };

function syncLook(m) {
  const s = stOf(m), t = now();
  const k = s.growAt != null ? clamp(1 - (s.growAt - t) / PIGLET_DAYS, 0, 1) : 1;
  m.piglet = k < 1;
  if (m._k == null || Math.abs(k - m._k) > 0.02 || (k >= 1 && m._k < 1)) { m._k = k; if (BF.mobs.setPigSize) BF.mobs.setPigSize(m, k); }
}
function fx(m, color, n) { const V = BF.villageLife; if (V && V.particles && m.position) V.particles(m.position.x, m.position.y + m.height + 0.2, m.position.z, color, n, 0.4); }
function snd(m, vol) { const V = BF.villageLife; if (V && V.sound && m.position) V.sound("pig", m.position.x, m.position.y + 0.5, m.position.z, vol); }

// Food eaten by `m`. Returns false for pigs that are not hungry; piglets grow 10% faster.
function feed(m, by) {
  if (!live(m) || m.type !== "pig") return false;
  const s = stOf(m), t = now();
  if (s.growAt != null) { s.growAt -= PIGLET_DAYS * 0.1; syncLook(m); fx(m, "#ffd84a", 4); snd(m, 0.4); return true; }
  if (!hungry(m, t)) return false;
  s.fed = t;
  fx(m, "#ff5a7a", 5); snd(m, 0.5);
  if (BF.emit) BF.emit("pigFed", m, by);
  return true;
}
const isFood = sel => { const it = sel && BF.items[sel.id]; return !!(it && FOODS.has(it.name)); };
// The player right-clicked a pig holding `sel`: a carrot, potato or beetroot feeds it. Returns true / a message (handled) or false (not ours).
function playerUse(m, sel) {
  if (!isFood(sel) || !live(m)) return false;
  if (!m.piglet && !hungry(m, now())) return "The pig isn't hungry";
  if (!feed(m, "player")) return false;
  const creative = BF.player && BF.player.gameMode === "creative", inv = BF.inventory;
  if (!creative && inv && inv.consumeSelected) inv.consumeSelected(1);
  return true;
}
const playerFood = () => { try { return isFood(BF.inventory && BF.inventory.selected && BF.inventory.selected()); } catch (e) { return false; } };

function findMate(m, t) {
  let best = null, bd = MATE_R * MATE_R, near = 0;
  for (const o of BF.mobs.list) {
    if (o.type !== "pig" || !live(o)) continue;
    const dx = o.position.x - m.position.x, dz = o.position.z - m.position.z, d2 = dx * dx + dz * dz;
    if (d2 < 256) near++;
    if (o === m || !willing(o, t) || Math.abs(o.position.y - m.position.y) > 2) continue;
    if (d2 < bd) { bd = d2; best = o; }
  }
  return near >= LOCAL_MAX ? null : best;
}
function breed(a, b, t) {
  const x = (a.position.x + b.position.x) / 2, z = (a.position.z + b.position.z) / 2, y = Math.max(a.position.y, b.position.y);
  const p = BF.mobs.spawn("pig", x, y, z);
  if (!p) return null;
  const s = stOf(p);
  s.growAt = t + PIGLET_DAYS; s.cd = t + PIGLET_DAYS + BREED_CD;
  stOf(a).cd = stOf(b).cd = t + BREED_CD;
  stOf(a).fed = stOf(b).fed = null;   // the meal is spent: they need food again to breed again
  syncLook(p);
  fx(a, "#ff5a7a", 5); fx(b, "#ff5a7a", 5); snd(p, 0.5);
  a.mate = b.mate = null;
  if (BF.emit) BF.emit("pigBorn", p, a, b);
  return p;
}

function follow(m, out, tx, tz, stop, speed) {
  const dx = tx - m.position.x, dz = tz - m.position.z, d = Math.hypot(dx, dz);
  m.ai.mode = "idle"; m.ai.t = 1;
  if (d < stop) { out.faceX = tx; out.faceZ = tz; return true; }
  out.x = dx / d * speed; out.z = dz / d * speed;
  return true;
}
// mobs.js, before its wander AI: tempted by the player's food, or walking to a mate. Returns true when it set this frame's movement.
function pigAI(m, dt, out) {
  const t = now(), sp = m.def.speed;
  if (BF.player && BF.player.position && !BF.player.dead && playerFood()) {
    const p = BF.player.position, d = Math.hypot(p.x - m.position.x, p.z - m.position.z);
    if (d < FOLLOW_R && Math.abs(p.y - m.position.y) < 4) { m.lookAt = "player"; return follow(m, out, p.x, p.z, 2, sp); }
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

// From mobs.update: piglets growing up.
let acc = 0;
function tick(dt) {
  acc += dt;
  if (acc < 0.5 || !BF.mobs) return;
  acc = 0;
  const t = now();
  for (const m of BF.mobs.list) {
    if (m.type !== "pig" || !live(m)) continue;
    const s = stOf(m);
    if (s.growAt != null && t >= s.growAt) { s.growAt = null; s.cd = Math.max(s.cd, t); }
    if (s.growAt != null && s.growAt - t > PIGLET_DAYS * 2) s.growAt = t + PIGLET_DAYS;   // time was set back
    syncLook(m);
  }
}

BF.pigs = { FEED_DAYS, BREED_CD, PIGLET_DAYS, FOODS, feed, playerUse, pigAI, breed, willing, hungry, isPiglet, syncLook, tick, stOf };
})();
