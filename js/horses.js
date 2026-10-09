// Horses (BF.horses): wild herds on plains, savanna and meadow, taming by riding, saddles, riding, leads, breeding, and saving every horse.
// Loaded after js/boats.js (it shares the player's riding code: a ridden horse is the player's `vehicle`, see js/player.js) and before
// js/player.js. Hooks: mobs.js (model, type, horses.ai in the AI chain, ridden horses skip AI and physics), player.js (right click, HUD),
// save.js ("horses"), main.js (nothing: tick runs from mobs.update via BF.horses.tick).
//
// Stats are vanilla, rolled per horse: health 15-30, speed 4.7-14.2 blocks/s, jump height 1.1-5.3 blocks. A foal's are its parents'
// average with a little variation. Every horse has a record (`m.horse`, id `hid`) that outlives the mob: a horse whose chunk unloads, or
// that is left far behind, waits where it was and comes back when the player is near again. Tamed horses never despawn; nor do wild ones,
// they just wait. Owners: null (wild), "player", or any string another module uses (js/stables.js: "stable:<village key>").
// See CONTRACT.md "Horses".
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const HORSE_BIOMES = new Set([5, 14, 22]);   // worldgen ids: plains, savanna, meadow
const COATS = ["white", "creamy", "chestnut", "brown", "black", "gray", "dark_brown"];
const MARKS = ["none", "white", "white_field", "white_dots", "black_dots"];
const FEED = { wheat_item: { heal: 2, temper: 3, grow: 0.1 }, apple: { heal: 3, temper: 3, grow: 0.15 }, hay_bale: { heal: 20, temper: 10, grow: 0.5 }, sugar: { heal: 1, temper: 3, grow: 0.05 } };
const BREEDS = new Set(["wheat_item", "hay_bale"]);   // what makes a tamed adult willing to breed
const FEED_DAYS = 1, BREED_CD = 1, FOAL_DAYS = 1, MATE_R = 10, MEET = 2.2;
const HERD_R = 9, HERD_SPEED = 100 / 1200;   // members keep within 9 blocks of the herd centre, which drifts ~100 blocks a game day (1200 s)
const SPAWN_GAP = 96, SPAWN_EVERY = 2, SPAWN_CHANCE = 0.25;   // at most one herd per 96 blocks; a try every 2 s near the player
const BACK_IN = 80;            // a waiting horse comes back once the player is this near (mobs.js removes mobs beyond 100)
const LEAD_SLACK = 3, LEAD_BREAK = 12, POST_R = 3.5;
const GRAV = 32;
const live = o => !!(o && !o.dead && !o.removed);
const now = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- recipes
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped }) => {
  const I = BF.I;
  addShaped(I.saddle, 1, ["LLL", " I "], { L: I.leather, I: I.iron_ingot }, "3 Leather over 1 Iron Ingot \u2192 Saddle");
  addShaped(I.lead, 2, ["SS ", "SL ", "  S"], { S: I.string, L: I.leather }, "4 String around 1 Leather \u2192 2 Leads");
});

if (BF.texKit) {   // item sprites
  const { SPRITES, put, mul, mix, WHITE, hex } = BF.texKit;
  SPRITES.saddle = (G, m) => {
    const hi = mix(m, WHITE, 0.2), lo = mul(m, 0.65), iron = hex("#b8b8c0");
    for (let x = 3; x <= 12; x++) for (let y = 5; y <= 8; y++) put(G, x, y, y === 5 ? hi : m);
    for (let x = 2; x <= 13; x++) put(G, x, 9, lo);
    for (let y = 2; y <= 4; y++) { put(G, 11, y, m); put(G, 12, y, lo); }
    for (const x of [4, 11]) { for (let y = 10; y <= 12; y++) put(G, x, y, lo); put(G, x - 1, 13, iron); put(G, x, 13, iron); put(G, x + 1, 13, iron); }
  };
  SPRITES.lead = (G, m) => {
    const lo = mul(m, 0.7);
    for (let a = 0; a < 28; a++) { const t = a / 28 * Math.PI * 2; put(G, Math.round(8 + Math.cos(t) * 4.5), Math.round(7 + Math.sin(t) * 3.5), a % 3 ? m : lo); }
    for (let y = 10; y <= 14; y++) put(G, 12 + (y > 12 ? 1 : 0), y, m);
  };
  SPRITES.horse_spawn_egg = (G, m) => {
    const sp = hex("#4a3020");
    for (let y = 2; y <= 14; y++) for (let x = 3; x <= 12; x++) {
      const dx = (x - 7.5) / 4.6, dy = (y - 8.6) / (y < 9 ? 6.4 : 5.4);
      if (dx * dx + dy * dy <= 1) put(G, x, y, (x * 7 + y * 13) % 11 < 2 ? sp : y < 6 ? mix(m, WHITE, 0.2) : m);
    }
  };
}

// ---------------------------------------------------------------- stats
// Vanilla: health 15 + rand(8) + rand(9); speed (0.45 + 3 x rand(0.3)) x 0.25 attribute units (x 42.16 = blocks/s);
// jump strength 0.4 + 3 x rand(0.2), height = -0.1817 j^3 + 3.689 j^2 + 2.128 j - 0.343.
const jumpHeight = j => -0.1817 * j * j * j + 3.689 * j * j + 2.128 * j - 0.343;
const SPEED_MIN = 0.1125 * 42.16, SPEED_MAX = 0.3375 * 42.16, JUMP_MIN = jumpHeight(0.4), JUMP_MAX = jumpHeight(1.0), HP_MIN = 15, HP_MAX = 30;
function rollStats() {
  const hp = 15 + irnd(0, 7) + irnd(0, 8);
  const speed = (0.45 + Math.random() * 0.3 + Math.random() * 0.3 + Math.random() * 0.3) * 0.25 * 42.16;
  const jump = jumpHeight(0.4 + Math.random() * 0.2 + Math.random() * 0.2 + Math.random() * 0.2);
  return { hp, speed, jump };
}
// A foal: the average of its parents, varied by up to +-5% (kept inside the vanilla ranges).
function foalStats(a, b) {
  const v = () => 1 + rnd(-0.05, 0.05);
  return { hp: Math.round(clamp((a.maxHp + b.maxHp) / 2 * v(), HP_MIN, HP_MAX)), speed: clamp((a.speed + b.speed) / 2 * v(), SPEED_MIN, SPEED_MAX),
    jump: clamp((a.jump + b.jump) / 2 * v(), JUMP_MIN, JUMP_MAX) };
}
// Price in emeralds for a tamed horse: 8 for the worst stats, 24 for the best.
function price(h) {
  const k = ((h.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) + (h.jump - JUMP_MIN) / (JUMP_MAX - JUMP_MIN) + (h.maxHp - HP_MIN) / (HP_MAX - HP_MIN)) / 3;
  return Math.round(8 + 16 * clamp(k, 0, 1));
}

// ---------------------------------------------------------------- records
let nextId = 1;
const recs = new Map();        // hid -> record (the horse's state; m.horse of a loaded horse is the same object)
const herds = new Map();       // herd id -> {id, cx, cz, dir}
let nextHerd = 1;
const isHorseBiome = (x, z) => { try { return HORSE_BIOMES.has(BF.worldgen.biomeAt(x, z).id); } catch (_) { return false; } };
function newRec(o) {
  const st = o.stats || rollStats();
  const r = { hid: nextId++, x: o.x, y: o.y, z: o.z, yaw: o.yaw || 0, coat: o.coat || COATS[irnd(0, 6)], mark: o.mark || MARKS[irnd(0, 4)],
    maxHp: st.hp, hp: st.hp, speed: st.speed, jump: st.jump, tamed: !!o.tamed, owner: o.owner || null, saddle: !!o.saddle, temper: 0,
    growAt: o.growAt != null ? o.growAt : null, cd: o.cd || 0, fed: null, herd: o.herd || null, lead: null, post: null, pen: o.pen || null, rider: false, mob: null };
  recs.set(r.hid, r);
  return r;
}
const variantOf = r => r.coat + "/" + r.mark;
// Puts the record's horse into the world as a mob.
function embody(r) {
  if (!BF.mobs || r.mob) return r.mob;
  const m = BF.mobs.spawn("horse", r.x, r.y, r.z);
  if (!m) return null;
  m.horse = r; r.mob = m;
  m.kind = "horse"; m.ctl = RIDE;
  m.maxHp = r.maxHp; m.hp = clamp(r.hp, 1, r.maxHp);
  m.yaw = r.yaw; m.model.rotation.y = r.yaw;
  BF.mobs.setLook(m, variantOf(r));
  syncLook(m);
  if (r.lead && r.lead.kind === "post") r.post = [r.lead.x, r.lead.y, r.lead.z];
  return m;
}
function syncLook(m) {
  const r = m.horse;
  BF.mobs.showPart(m, "saddle", r.saddle && r.growAt == null);
  const k = r.growAt != null ? clamp(1 - (r.growAt - now()) / FOAL_DAYS, 0, 1) : 1, s = 0.5 + 0.5 * k;
  if (m._k == null || Math.abs(m._k - s) > 0.02) { m._k = s; m.model.scale.setScalar(s); m.halfWidth = 0.7 * (0.6 + 0.4 * k); m.height = 1.6 * s; }
}
// Copies the live mob's state into its record (before saving, and when the mob goes away).
function store(r) {
  const m = r.mob;
  if (!m) return;
  r.x = m.position.x; r.y = m.position.y; r.z = m.position.z; r.yaw = m.yaw; r.hp = m.hp;
}
function fx(m, color, n) { const V = BF.villageLife; if (V && V.particles && m.position) V.particles(m.position.x, m.position.y + m.height + 0.3, m.position.z, color, n, 0.6); }
const isFoal = r => r.growAt != null;

// ---------------------------------------------------------------- public actions
function spawn(x, y, z, o) {
  const r = newRec(Object.assign({}, o || {}, { x, y, z }));
  if (o && o.tamed && !r.owner) r.owner = "player";
  return embody(r);
}
function tame(m, owner) {
  const r = m && m.horse;
  if (!r) return false;
  r.tamed = true; r.owner = owner || "player"; r.herd = null; r.temper = 100;
  fx(m, "#ff5a7a", 8);
  if (BF.emit) BF.emit("horseTamed", m, r.owner);
  return true;
}
// Food eaten by a horse (from the player or a villager): heals, calms an untamed one, speeds a foal up, makes a tamed adult willing to breed
// (wheat or hay). Returns false when it has no use for it.
function feed(m, itemName, by) {
  const r = m && m.horse, f = FEED[itemName];
  if (!r || !f || !live(m)) return false;
  const t = now();
  let used = false;
  if (m.hp < m.maxHp) { m.hp = Math.min(m.maxHp, m.hp + f.heal); used = true; }
  if (!r.tamed && r.temper < 100) { r.temper = Math.min(100, r.temper + f.temper); used = true; }
  if (isFoal(r)) { r.growAt -= FOAL_DAYS * f.grow; syncLook(m); used = true; }
  else if (r.tamed && BREEDS.has(itemName) && t >= r.cd && (r.fed == null || t - r.fed >= FEED_DAYS)) { r.fed = t; used = true; fx(m, "#ff5a7a", 6); }
  if (used) { fx(m, "#ffd84a", 4); if (BF.emit) BF.emit("horseFed", m, by); }
  return used;
}
const willing = (r, t) => r.tamed && !isFoal(r) && r.fed != null && t - r.fed < FEED_DAYS && t >= r.cd;
function breed(a, b) {
  const ra = a.horse, rb = b.horse, t = now();
  const st = foalStats(ra, rb);
  const pick = (x, y) => (Math.random() < 0.45 ? x : Math.random() < 0.82 ? y : null);
  const foal = spawn((a.position.x + b.position.x) / 2, Math.max(a.position.y, b.position.y), (a.position.z + b.position.z) / 2, {
    stats: st, coat: pick(ra.coat, rb.coat) || COATS[irnd(0, 6)], mark: pick(ra.mark, rb.mark) || MARKS[irnd(0, 4)],
    tamed: true, owner: ra.owner, growAt: t + FOAL_DAYS, cd: t + FOAL_DAYS + BREED_CD, pen: ra.pen || rb.pen,
  });
  ra.cd = rb.cd = t + BREED_CD; ra.fed = rb.fed = null; ra.mate = rb.mate = null;
  fx(a, "#ff5a7a", 6); fx(b, "#ff5a7a", 6);
  if (foal && BF.emit) BF.emit("horseBred", foal, a, b);
  return foal;
}
// Leads: holder "player", a mob (a villager leading it home), or {x, y, z} (a fence post). leash(m, null) lets it go.
function leash(m, holder) {
  const r = m && m.horse;
  if (!r) return false;
  r.post = null;
  if (!holder) r.lead = null;
  else if (holder === "player") r.lead = { kind: "player" };
  else if (holder.position) r.lead = { kind: "mob", mob: holder };
  else { r.lead = { kind: "post", x: holder.x, y: holder.y, z: holder.z }; r.post = [holder.x, holder.y, holder.z]; }
  return true;
}
function setPen(m, box) {
  if (!m || !m.horse) return;
  m.horse.pen = box ? { x0: box.x0, z0: box.z0, x1: box.x1, z1: box.z1 } : null;
  if (box && box.gx != null) { m.horse.pen.gx = box.gx; m.horse.pen.gz = box.gz; }
  if (box && box.fp) m.horse.pen.fp = box.fp;
}

// ---------------------------------------------------------------- walking round a paddock
// A horse that walks straight at something on the far side of a paddock's fence only presses itself into the fence (fences stand 1.5 tall,
// so it can't get over), so it plans round the fence ring by its corners. `box` is a pen's inside cells (js/stables.js).
const padRing = box => ({ x0: box.x0 - 1, z0: box.z0 - 1, x1: box.x1 + 2, z1: box.z1 + 2 });   // the paddock fence ring's outer edges
const ringOf = box => box.fp || padRing(box);   // what a horse walks round: the whole stable (shelter too) when the pen knows its footprint
// Does the segment a->b pass through the rectangle R (open)? Liang-Barsky.
function segHits(ax, az, bx, bz, R) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [pp, qq] of [[-dx, ax - R.x0], [dx, R.x1 - ax], [-dz, az - R.z0], [dz, R.z1 - az]]) {
    if (pp === 0) { if (qq <= 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-6;
}
// Where to head for to reach (gx, gz) from p without crossing the ring R: the goal itself when the way is clear, else the corner that starts
// the shortest way round (either direction).
function routeAround(p, gx, gz, R) {
  const M = 0.75, E = { x0: R.x0 - M, z0: R.z0 - M, x1: R.x1 + M, z1: R.z1 + M };   // keep a horse's width (0.7) clear of the building
  const out = (x, z) => {   // the nearest point just outside E when (x, z) is inside it
    if (!(x > E.x0 && x < E.x1 && z > E.z0 && z < E.z1)) return [x, z];
    const d = [x - E.x0, E.x1 - x, z - E.z0, E.z1 - z], m = Math.min(...d);
    return m === d[0] ? [E.x0 - 0.02, z] : m === d[1] ? [E.x1 + 0.02, z] : m === d[2] ? [x, E.z0 - 0.02] : [x, E.z1 + 0.02];
  };
  [gx, gz] = out(gx, gz);
  const [sx, sz] = out(p.x, p.z);
  if (!segHits(sx, sz, gx, gz, E)) return [gx, gz];
  const C = 1.6, cs = [[R.x0 - C, R.z0 - C], [R.x1 + C, R.z0 - C], [R.x1 + C, R.z1 + C], [R.x0 - C, R.z1 + C]];
  let best = null, bl = Infinity;
  for (let i = 0; i < 4; i++) {
    if (segHits(sx, sz, cs[i][0], cs[i][1], E)) continue;
    for (const dir of [1, 3]) {
      let len = Math.hypot(cs[i][0] - sx, cs[i][1] - sz), j = i;
      for (let k = 0; k < 3 && segHits(cs[j][0], cs[j][1], gx, gz, E); k++) { const n = (j + dir) % 4; len += Math.hypot(cs[n][0] - cs[j][0], cs[n][1] - cs[j][1]); j = n; }
      len += Math.hypot(gx - cs[j][0], gz - cs[j][1]);
      if (len < bl) { bl = len; best = cs[i]; }
    }
  }
  return best || [gx, gz];
}
// A horse being led home (js/stables.js) goes round the paddock too: r.avoid is the pen's box while it is.
function setAvoid(m, box) { if (m && m.horse) m.horse.avoid = box ? { x0: box.x0, z0: box.z0, x1: box.x1, z1: box.z1, fp: box.fp } : null; }

// ---------------------------------------------------------------- AI (called from mobs.js updateMob for unridden horses)
function walkTo(m, out, x, z, speed) {
  const dx = x - m.position.x, dz = z - m.position.z, d = Math.hypot(dx, dz) || 1;
  out.x = dx / d * speed; out.z = dz / d * speed;
  m.ai.mode = "walk";
}
function ai(m, dt, out) {
  const r = m.horse;
  if (!r) return false;
  const t = now(), p = m.position;
  // on a lead: follow the holder, keep near the post
  if (r.lead) {
    let hx, hz;
    if (r.lead.kind === "player") { const P = BF.player; if (!P || P.dead) { dropLead(m); return false; } hx = P.position.x; hz = P.position.z; }
    else if (r.lead.kind === "mob") { const h = r.lead.mob; if (!live(h)) { r.lead = null; return false; } hx = h.position.x; hz = h.position.z; }
    else { hx = r.lead.x + 0.5; hz = r.lead.z + 0.5; }
    const d = Math.hypot(hx - p.x, hz - p.z), slack = r.lead.kind === "post" ? POST_R : LEAD_SLACK;
    if (d > LEAD_BREAK && r.lead.kind !== "post") { dropLead(m); return false; }
    if (d > slack) {
      const [wx, wz] = r.avoid ? routeAround(p, hx, hz, ringOf(r.avoid)) : [hx, hz];
      walkTo(m, out, wx, wz, Math.min(6, 1.5 + (d - slack) * 1.5));
      return true;
    }
    if (r.lead.kind !== "post") { out.x = out.z = 0; return true; }
    return false;   // tied: wanders inside the post's reach (see the clamp below)
  }
  // breeding: a willing tamed adult walks to a willing mate
  if (willing(r, t)) {
    let best = null, bd = MATE_R;
    for (const o of BF.mobs.list) {
      if (o === m || o.type !== "horse" || !live(o) || !o.horse || !willing(o.horse, t) || o.horse.owner !== r.owner) continue;
      const d = Math.hypot(o.position.x - p.x, o.position.z - p.z);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      if (bd < MEET) { breed(m, best); return false; }
      walkTo(m, out, best.position.x, best.position.z, 1.4);
      return true;
    }
  }
  // a pen (js/stables.js) keeps a horse inside it
  if (r.pen) {
    const b = r.pen, inside = p.x > b.x0 + 0.8 && p.x < b.x1 + 0.2 && p.z > b.z0 + 0.8 && p.z < b.z1 + 0.2;
    const cx = (b.x0 + b.x1 + 1) / 2, cz = (b.z0 + b.z1 + 1) / 2;
    const R = ringOf(b), Pr = padRing(b), outsideRing = !(p.x > R.x0 && p.x < R.x1 && p.z > R.z0 && p.z < R.z1);
    if (!inside && b.gx != null) {
      // fences stand 1.5 tall (js/blocks.js), so a horse can't step over them: from outside it goes round to the front of the gate, lines up, then walks in
      const ix = Math.abs(cx - b.gx) > Math.abs(cz - b.gz) ? Math.sign(cx - b.gx) : 0, iz = ix ? 0 : Math.sign(cz - b.gz);
      const along = (p.x - b.gx) * ix + (p.z - b.gz) * iz, side = ix ? p.z - b.gz : p.x - b.gx;
      if (along < 0.5 && Math.abs(side) <= 0.2) { walkTo(m, out, b.gx + ix * 2, b.gz + iz * 2, 1.2); return true; }
      if (outsideRing) { const [wx, wz] = routeAround(p, b.gx - ix * 1.5, b.gz - iz * 1.5, R); walkTo(m, out, wx, wz, 1.2); return true; }
      if (!(p.x > Pr.x0 && p.x < Pr.x1 && p.z > Pr.z0 && p.z < Pr.z1)) {   // in the shelter beside the paddock: out through its open front first
        walkTo(m, out, ix ? b.gx - ix * 1.5 : p.x, iz ? b.gz - iz * 1.5 : p.z, 1.2); return true;
      }
    }
    if (!inside) { walkTo(m, out, cx, cz, 1.2); return true; }
    return false;
  }
  // a wild herd: stay near its drifting centre
  if (!r.tamed && r.herd && herds.has(r.herd)) {
    const h = herds.get(r.herd), d = Math.hypot(h.cx - p.x, h.cz - p.z);
    if (d > HERD_R) { walkTo(m, out, h.cx, h.cz, 1.3); return true; }
  }
  return false;
}
function dropLead(m) {
  const r = m.horse;
  if (!r || !r.lead) return;
  if (r.lead.kind === "player" && BF.drops && BF.I.lead != null) BF.drops.spawn(BF.I.lead, 1, m.position.x, m.position.y + 1, m.position.z);
  r.lead = null; r.post = null;
}

// ---------------------------------------------------------------- herds and spawning
function moveHerds(dt) {
  for (const h of herds.values()) {
    let n = 0, sx = 0, sz = 0;
    for (const r of recs.values()) if (r.herd === h.id && r.mob && live(r.mob)) { n++; sx += r.mob.position.x; sz += r.mob.position.z; }
    if (!n) continue;   // waiting with its horses
    h.dir += rnd(-1, 1) * 0.4 * dt / 60;   // a slowly changing heading
    const nx = h.cx - Math.sin(h.dir) * HERD_SPEED * dt, nz = h.cz - Math.cos(h.dir) * HERD_SPEED * dt;
    const ax = h.cx - Math.sin(h.dir) * 24, az = h.cz - Math.cos(h.dir) * 24;
    if (!isHorseBiome(ax, az) || !BF.world.isLoaded(ax, az)) h.dir += Math.PI * (0.5 + Math.random() * 0.5);   // turn back at the edge of horse land
    else { h.cx = nx; h.cz = nz; }
    // never leave the members far behind
    const mx = sx / n, mz = sz / n;
    if (Math.hypot(mx - h.cx, mz - h.cz) > HERD_R * 2) { h.cx = mx; h.cz = mz; }
  }
}
function trySpawnHerd() {
  const P = BF.player, W = BF.world;
  if (!P || P.dead || !BF.mobs || BF.mobs.spawning === false) return;
  const a = Math.random() * Math.PI * 2, d = rnd(32, 72);
  const x = Math.floor(P.position.x + Math.cos(a) * d), z = Math.floor(P.position.z + Math.sin(a) * d);
  if (!W.isLoaded(x, z) || !isHorseBiome(x, z)) return;
  for (const r of recs.values()) { const rx = r.mob ? r.mob.position.x : r.x, rz = r.mob ? r.mob.position.z : r.z; if (Math.hypot(rx - x, rz - z) < SPAWN_GAP) return; }
  spawnHerdAt(x, z);
}
// A wild herd of 2-6 (sometimes with foals) on the grass around (x, z). Returns the herd, or null when there was no room.
function spawnHerdAt(x, z) {
  const W = BF.world, gy = W.heightAt(x, z);
  if (W.getBlock(x, gy, z) !== BF.B.grass) return null;
  const h = { id: nextHerd++, cx: x + 0.5, cz: z + 0.5, dir: Math.random() * Math.PI * 2 };
  herds.set(h.id, h);
  const n = irnd(2, 6);
  let made = 0;
  for (let i = 0; i < n * 3 && made < n; i++) {
    const sx = x + (i ? irnd(-4, 4) : 0), sz = z + (i ? irnd(-4, 4) : 0);
    if (!W.isLoaded(sx, sz)) continue;
    const sy = W.heightAt(sx, sz);
    if (W.getBlock(sx, sy, sz) !== BF.B.grass || W.boxCollides(sx + 0.5, sy + 1, sz + 0.5, 0.7, 1.6)) continue;
    const foal = made >= 2 && Math.random() < 0.25;
    spawn(sx + 0.5, sy + 1, sz + 0.5, { herd: h.id, growAt: foal ? now() + rnd(0.2, 1) * FOAL_DAYS : null });
    made++;
  }
  if (!made) { herds.delete(h.id); return null; }
  return h;
}

// ---------------------------------------------------------------- lead lines
const leadLines = new Map();   // hid -> THREE.Line
let leadMat = null;
function drawLeads() {
  const scene = BF.scene || (BF.world && BF.world.scene);
  for (const [hid, line] of leadLines) { const r = recs.get(hid); if (!r || !r.lead || !r.mob || !live(r.mob)) { if (line.parent) line.parent.remove(line); leadLines.delete(hid); } }
  for (const r of recs.values()) {
    if (!r.lead || !r.mob || !live(r.mob)) continue;
    const m = r.mob, P = BF.player;
    let line = leadLines.get(r.hid);
    if (!line) {
      if (!leadMat) leadMat = new THREE.LineBasicMaterial({ color: 0x6b4a2a });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(9 * 3), 3));
      line = new THREE.Line(g, leadMat);
      line.frustumCulled = false;
      const root = m.root && m.root.parent;
      if (!root) continue;
      root.add(line);
      leadLines.set(r.hid, line);
    }
    const fw = [Math.sin(m.yaw), Math.cos(m.yaw)], s = m._k || 1;
    const a = [m.position.x + fw[0] * 1.0 * s, m.position.y + 1.45 * s, m.position.z + fw[1] * 1.0 * s];
    let b;
    if (r.lead.kind === "player") { const e = P.eyePos(), d = P.lookDir(); b = [e.x + d.x * 0.4 - d.z * 0.3, e.y - 0.5, e.z + d.z * 0.4 + d.x * 0.3]; }
    else if (r.lead.kind === "mob") { const h = r.lead.mob; b = [h.position.x, h.position.y + 1.0, h.position.z]; }
    else b = [r.lead.x + 0.5, r.lead.y + 0.75, r.lead.z + 0.5];
    const arr = line.geometry.attributes.position.array;
    const sag = Math.max(0, 1.2 - Math.hypot(a[0] - b[0], a[2] - b[2]) * 0.2);
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      arr[i * 3] = a[0] + (b[0] - a[0]) * t; arr[i * 3 + 1] = a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * sag; arr[i * 3 + 2] = a[2] + (b[2] - a[2]) * t;
    }
    line.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- tick (mobs.update, world simulation time)
let spawnT = 0, backT = 0;
function tick(dt) {
  if (!BF.mobs) return;
  const t = now(), P = BF.player, pp = P && P.position;
  for (const r of recs.values()) {
    const m = r.mob;
    if (m && m.dead) { recs.delete(r.hid); continue; }   // died: gone for good
    if (m && m.removed) { store(r); r.mob = null; if (r.rider) r.rider = false; continue; }   // chunk unloaded or left behind: it waits there
    if (m) {
      if (isFoal(r) && t >= r.growAt) { r.growAt = null; syncLook(m); }
      else if (isFoal(r)) syncLook(m);
      if (r.post) { const [x, y, z] = r.post; if (!BF.world.getBlock || !BF.blocks[BF.world.getBlock(x, y, z)] || !/fence/.test(BF.blocks[BF.world.getBlock(x, y, z)].name || "")) { r.post = null; if (r.lead && r.lead.kind === "post") { r.lead = null; if (BF.drops && BF.I.lead != null) BF.drops.spawn(BF.I.lead, 1, x + 0.5, y + 0.5, z + 0.5); } } }
    }
  }
  backT -= dt;
  if (backT <= 0 && pp) {   // horses waiting where they were come back when the player is near and their chunk is loaded
    backT = 1;
    for (const r of recs.values()) {
      if (r.mob || !BF.world.isLoaded(r.x, r.z) || Math.hypot(r.x - pp.x, r.z - pp.z) > BACK_IN) continue;
      const m = embody(r);
      if (m && r.rider && P && !P.vehicle && P.mount) P.mount(m, true);
    }
  }
  moveHerds(dt);
  spawnT -= dt;
  if (spawnT <= 0) { spawnT = SPAWN_EVERY; if (Math.random() < SPAWN_CHANCE) trySpawnHerd(); }
  // herds left with no horses at all are forgotten
  for (const h of herds.values()) { let any = false; for (const r of recs.values()) if (r.herd === h.id) { any = true; break; } if (!any) herds.delete(h.id); }
}

// ---------------------------------------------------------------- riding (the player's vehicle interface, js/player.js)
const SEAT_Y = 0.75, SIT_EYE = 1.45;   // seat above the horse's feet, eye above the seat: the camera rides higher than on foot
const ride = { buck: 0, charge: 0, jumpHeld: false };
function canBoard(m) {
  const r = m.horse;
  return !!(r && live(m) && !m.rider && !isFoal(r) && !BF.world.boxCollides(m.position.x, m.position.y, m.position.z, m.halfWidth, m.height + 1.2));
}
function seatOf(m) {
  const s = m._k || 1;
  return { x: m.position.x, y: m.position.y + SEAT_Y * s, z: m.position.z };
}
function exitSpot(m, hw, h) {
  const W = BF.world, p = m.position;
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const rx = Math.cos(m.yaw) * ox + Math.sin(m.yaw) * oz, rz = -Math.sin(m.yaw) * ox + Math.cos(m.yaw) * oz;
    const x = p.x + rx * (m.halfWidth + hw + 0.1), z = p.z + rz * (m.halfWidth + hw + 0.1);
    for (const dy of [0, 1, -1]) if (!W.boxCollides(x, p.y + dy, z, hw, h)) return { x, y: p.y + dy, z };
  }
  return { x: p.x, y: p.y + m.height, z: p.z };
}
// One real-time step of the ridden horse. input: {fwd, strafe, jump, yaw (the player's look)}. Returns the change to the player's yaw.
function drive(m, dt, input) {
  const r = m.horse, P = BF.player, W = BF.world;
  if (!r || !live(m)) { if (P.vehicle === m) P.dismount(); return 0; }
  if (!W.isLoaded(m.position.x, m.position.z)) return 0;
  const v = m.vel;
  let fwd = 0, strafe = 0, yawD = 0;
  if (!r.tamed) {
    // untamed: it goes where it likes and, every so often, tries to throw the rider; each failed attempt makes taming more likely
    ride.buck -= dt;
    m.yaw += Math.sin(now() * 400 + r.hid) * 1.5 * dt;
    fwd = 0.35;
    if (ride.buck <= 0) {
      ride.buck = rnd(1.5, 3.5);
      if (Math.random() * 100 < r.temper) { tame(m, "player"); }
      else { r.temper = Math.min(100, r.temper + 5); fx(m, "#9a9a9a", 6); v.y = 4; P.dismount(); return 0; }
    }
  } else if (r.saddle) {
    // saddled: the horse faces where the rider looks; W/S forward and back, A/D sidestep, Space jumps (hold to jump higher)
    const want = input.yaw != null ? input.yaw + Math.PI : m.yaw;   // mob models face +z at yaw 0, the player looks -z at yaw 0
    let d = want - m.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    m.yaw += d;
    fwd = input.fwd > 0 ? input.fwd : input.fwd * 0.25;
    strafe = (input.strafe || 0) * 0.5;
  }
  // movement in the horse's frame (+z forward)
  const fx_ = Math.sin(m.yaw), fz_ = Math.cos(m.yaw), rx = -fz_, rz = fx_;   // right-hand side vector (for strafe +1 = right)
  const inWater = BF.RENDER[W.getBlock(m.position.x, m.position.y + 0.6, m.position.z)] === 3;
  const sp = r.speed * (inWater ? 0.25 : 1);
  const tx = (fx_ * fwd + rx * strafe) * sp, tz = (fz_ * fwd + rz * strafe) * sp;
  const k = 1 - Math.exp(-(m.onGround ? 6 : inWater ? 3 : 1.2) * dt);
  v.x += (tx - v.x) * k; v.z += (tz - v.z) * k;
  // jumping: hold Space to charge (up to 1 s), let go to jump; a full charge reaches the horse's jump height
  if (r.tamed && r.saddle) {
    if (input.jump && m.onGround) { ride.charge = Math.min(1, ride.charge + dt); ride.jumpHeld = true; }
    else if (ride.jumpHeld) {
      ride.jumpHeld = false;
      if (m.onGround) { const hgt = r.jump * Math.max(0.35, ride.charge); v.y = Math.sqrt(2 * GRAV * (hgt + 0.1)); }
      ride.charge = 0;
    }
  }
  if (inWater) { v.y += 14 * dt; v.y -= GRAV * 0.4 * dt; v.y = clamp(v.y, -2, 2); }
  else v.y = Math.max(-40, v.y - GRAV * dt);
  // never into terrain that isn't loaded
  const hs = Math.hypot(v.x, v.z) || 1, ahead = 1.5 + Math.hypot(v.x, v.z) * dt;
  if (!W.isLoaded(m.position.x + v.x / hs * ahead, m.position.z + v.z / hs * ahead)) { v.x = 0; v.z = 0; }
  const y0 = m.position.y, wasGround = m.onGround;
  if (m.fallStart == null || m.onGround || inWater) m.fallStart = m.position.y;
  const res = W.moveBox(m.position, v, m.halfWidth, m.height + 1.0 * (m._k || 1), dt, { stepUp: 1.05 });   // the box covers the rider too
  m.onGround = res.onGround; m.inWater = res.inWater; m.headInWater = !!res.headInWater;
  if (m.position.y > m.fallStart) m.fallStart = m.position.y;
  // landing: the horse takes the fall damage, reduced (vanilla: half the distance, minus 3); the rider takes none
  if (res.onGround && !wasGround && !inWater && m.fallStart != null) {
    const dmg = Math.ceil((m.fallStart - m.position.y) * 0.5 - 3);
    if (dmg > 0) BF.mobs.hurt(m, dmg, "a fall");
    m.fallStart = m.position.y;
  }
  // walking animation and the model's facing (mobs.js skips its own physics for a ridden horse)
  m.model.rotation.y = m.yaw;
  if (BF.RENDER[W.getBlock(m.position.x, m.position.y + m.height * 0.9, m.position.z)] === 3) { P.dismount(); return 0; }   // no carrying a rider under water
  if (!live(m)) { if (P.vehicle === m) P.dismount(); return 0; }
  return yawD;
}
const RIDE = {
  drive,
  seatOf: m => seatOf(m),
  sitEye: () => SIT_EYE,
  canBoard,
  exitSpot,
  onLeave: m => { m.vel.x = m.vel.z = 0; m.ai.mode = "idle"; ride.charge = 0; ride.jumpHeld = false; },
  onMount: () => { ride.buck = rnd(1.5, 3.5); ride.charge = 0; },
  hud: m => ({ hp: m.hp, max: m.maxHp }),   // the horse's health in place of hunger (js/player.js drawHUD)
};

// ---------------------------------------------------------------- the player's right click on a horse
// sel: the held stack. Returns null (not handled) or {msg?, consume?: n, mount?: true, give?: itemName}.
function playerUse(m, sel, sneaking) {
  const r = m && m.horse;
  if (!r || !live(m)) return null;
  const it = sel && BF.items[sel.id], name = it && it.name;
  const P = BF.player;
  if (name && FEED[name]) {
    if (feed(m, name, "player")) return { consume: 1 };
    if (!r.tamed) return { mount: true };   // not hungry: ride it to tame it
    return { msg: "The horse doesn't want that now" };
  }
  if (name === "lead") {
    if (r.lead && r.lead.kind === "player") return { msg: "That horse is already on your lead" };
    if (r.owner && r.owner !== "player") return { msg: "That horse belongs to someone else" };
    const had = r.lead && r.lead.kind === "post";
    leash(m, "player");
    return { consume: had ? 0 : 1 };
  }
  if (r.lead && r.lead.kind === "player") { r.lead = null; return { give: "lead" }; }   // let go of the lead
  if (r.lead && r.lead.kind === "post") { leash(m, null); return { give: "lead" }; }   // untie from the post
  if (name === "saddle") {
    if (!r.tamed) return { msg: "Tame the horse first: ride it until it stops throwing you" };
    if (isFoal(r)) return { msg: "A foal is too young for a saddle" };
    if (r.saddle) return { mount: true };
    if (r.owner && r.owner !== "player") return { msg: "That horse belongs to someone else" };
    r.saddle = true; syncLook(m);
    return { consume: 1 };
  }
  if (sneaking && r.tamed && r.saddle && (!r.owner || r.owner === "player")) { r.saddle = false; syncLook(m); return { give: "saddle" }; }
  if (isFoal(r)) return { msg: "Foals are too young to ride" };
  if (r.owner && r.owner !== "player") return { msg: "That horse belongs to someone else" };
  if (r.tamed && !r.saddle) return { msg: "It needs a saddle before you can ride it" };
  return { mount: true };
}
// Right click on a fence while leading horses: ties them all to that post. Returns true when one was tied.
function tieToPost(x, y, z) {
  let n = 0;
  for (const r of recs.values()) if (r.mob && live(r.mob) && r.lead && r.lead.kind === "player") { leash(r.mob, { x, y, z }); n++; }
  return n > 0;
}

// ---------------------------------------------------------------- queries for other modules (js/stables.js)
const recOf = m => (m && m.horse) || null;
function horsesOf(owner) { const out = []; for (const r of recs.values()) if (r.owner === owner) out.push(r); return out; }
// Nearest loaded wild horse within r blocks of (x, z), or null.
function wildNear(x, z, rad) {
  let best = null, bd = rad;
  for (const r of recs.values()) {
    const m = r.mob;
    if (!m || !live(m) || r.tamed || m.rider || isFoal(r)) continue;
    const d = Math.hypot(m.position.x - x, m.position.z - z);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------- save
function serialize() {
  const out = [];
  for (const r of recs.values()) {
    store(r);
    const q = v => Math.round(v * 100) / 100;
    out.push({ hid: r.hid, x: q(r.x), y: q(r.y), z: q(r.z), yaw: q(r.yaw), coat: r.coat, mark: r.mark, maxHp: r.maxHp, hp: q(r.hp), speed: q(r.speed), jump: q(r.jump),
      tamed: r.tamed ? 1 : 0, owner: r.owner, saddle: r.saddle ? 1 : 0, temper: r.temper, growAt: r.growAt, cd: r.cd, fed: r.fed, herd: r.herd,
      post: r.lead && r.lead.kind === "post" ? [r.lead.x, r.lead.y, r.lead.z] : null, led: r.lead && r.lead.kind === "player" ? 1 : 0, pen: r.pen,
      rider: r.mob && r.mob.rider ? 1 : 0 });
  }
  return { recs: out, herds: [...herds.values()].map(h => [h.id, Math.round(h.cx), Math.round(h.cz), Math.round(h.dir * 100) / 100]), next: nextId, nextHerd };
}
function deserialize(o) {
  reset();
  if (!o || typeof o !== "object") return;
  nextId = Math.max(1, +o.next || 1); nextHerd = Math.max(1, +o.nextHerd || 1);
  for (const h of Array.isArray(o.herds) ? o.herds : []) if (Array.isArray(h)) herds.set(h[0], { id: h[0], cx: +h[1], cz: +h[2], dir: +h[3] || 0 });
  for (const e of Array.isArray(o.recs) ? o.recs : []) {
    if (!e || ![e.x, e.y, e.z].every(Number.isFinite)) continue;
    const r = { hid: e.hid || nextId++, x: e.x, y: e.y, z: e.z, yaw: +e.yaw || 0, coat: COATS.includes(e.coat) ? e.coat : "brown", mark: MARKS.includes(e.mark) ? e.mark : "none",
      maxHp: clamp(+e.maxHp || 20, 1, 60), hp: +e.hp || 20, speed: +e.speed || 9, jump: +e.jump || 2, tamed: !!e.tamed, owner: e.owner || null, saddle: !!e.saddle,
      temper: +e.temper || 0, growAt: e.growAt != null ? +e.growAt : null, cd: +e.cd || 0, fed: e.fed != null ? +e.fed : null, herd: e.herd || null,
      lead: Array.isArray(e.post) ? { kind: "post", x: e.post[0], y: e.post[1], z: e.post[2] } : e.led ? { kind: "player" } : null, post: Array.isArray(e.post) ? e.post : null,
      pen: e.pen && typeof e.pen === "object" ? e.pen : null, rider: !!e.rider, mob: null };
    recs.set(r.hid, r);
    nextId = Math.max(nextId, r.hid + 1);
  }
  backT = 0;
}
function reset() {
  for (const line of leadLines.values()) if (line.parent) line.parent.remove(line);
  leadLines.clear();
  recs.clear(); herds.clear(); nextId = 1; nextHerd = 1;
}

BF.horses = {
  HORSE_BIOMES, COATS, MARKS, FEED, SPEED_MIN, SPEED_MAX, JUMP_MIN, JUMP_MAX, HP_MIN, HP_MAX,
  isHorseBiome, rollStats, foalStats, jumpHeight, price: m => price(m.horse || m),
  spawn, tame, feed, breed, leash, setPen, willing: m => !!(m && m.horse && willing(m.horse, now())),
  ai, tick, spawnHerdAt, setAvoid, playerUse, tieToPost, recOf, horsesOf, wildNear, herds, records: recs,
  ride: RIDE, drawLeads,
  serialize, deserialize, reset,
};
})();
