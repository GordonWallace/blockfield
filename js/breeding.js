// Villager breeding and child villagers (BF.breeding). Loaded after mobs.js, jobs.js and villagelife.js.
// Rules (see CONTRACT.md "Breeding"): a village may grow while it has at least one more bed than villagers.
// Two eligible adults (>= 7 bread-eq, awake, fed, off cooldown) of the same village that wander within 5 blocks
// of each other roll 50% once per encounter; on success they stop, face each other, hearts rise, and a child
// villager appears holding exactly 10 bread (5 bread-eq paid by each parent). The child eats 2 bread a day and
// grows up when the bread is gone, then walks to a free jobsite (BF.jobs seekAI, preferring its parents' professions).
// Newborns are not part of the deterministic roster: they live in rec.bred and are saved under "<village key>#2000+k".
(function () {
"use strict";
const BF = window.BF;

const RADIUS = 5;            // encounter distance (blocks, 3D)
const CHANCE = 0.5;          // per encounter
const NEED = 7;              // bread-eq each parent must hold
const PAY = 5;               // bread-eq each parent gives
const CHILD_BREAD = 10;      // the child's whole inventory
const CHILD_RATE = 2;        // bread per day (fallback when BF.food.rate is missing)
const COOLDOWN = 1;          // days between breedings for a parent
const LOVE_T = 2.6;          // seconds the pair stands facing each other before the child appears
const MAX_TOTAL = 40;        // hard cap on villagers (roster + newborns) per village; the bed rule is the real limiter
const KEY_BASE = 2000;       // persistence keys <village key>#2000+k
const CHILD_SCALE = 0.55, CHILD_HEAD = 1.35, GROW_T = 1.6;
const ADULT_H = 1.95, ADULT_HW = 0.3, CHILD_H = 1.3, CHILD_HW = 0.2;

const S = {
  pending: new Map(),        // village key -> [meta] from a loaded save (attached when the village record appears)
  cd: new Map(),             // villagerKey -> absolute day of last breeding (roster villagers; newborns keep it in meta)
  near: new Set(),
  deadKeys: new Set(),       // keys of newborns that died this session (removed from the save)           // pair keys currently within RADIUS with the condition true (rolled already)
  loves: [],                 // active love pairs {a, b, t, rec, heartT}
  hearts: [],                // heart sprites
  grow: [],                  // {m, t, from}
  stats: { encounters: 0, rolls: 0, successes: 0, births: 0, grownUp: 0 },
  log: [],
  timer: 0,
};
let ids = 0;
const idOf = new WeakMap();
const mid = m => { let i = idOf.get(m); if (!i) idOf.set(m, i = ++ids); return i; };

// ---------- time / food helpers ----------
const now = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const bedtime = () => { const t = BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.3; return t > 0.52 && t < 0.985; };
const breadFood = () => (BF.I && BF.items[BF.I.bread] && BF.items[BF.I.bread].food) || 5;
function breadEq(inv) {
  if (BF.food && typeof BF.food.breadEq === "function") return BF.food.breadEq(inv) || 0;
  let n = 0;                                   // fallback: food points / bread's food points
  for (const s of inv || []) if (s && BF.items[s.id] && BF.items[s.id].food) n += s.count * BF.items[s.id].food / breadFood();
  return n;
}
function take(m, eq) {                         // removes eq bread-eq from the mob, returns the stacks taken
  if (BF.food && typeof BF.food.take === "function") return BF.food.take(m, eq) || [];
  const out = [], I = BF.trades.inv;
  let left = eq;
  const bread = BF.I.bread;
  const got = I.remove(m.inv, bread, Math.ceil(left));
  if (got) { out.push({ id: bread, count: got }); left -= got; }
  for (const s of m.inv.slice()) {             // then other food, smallest first is not needed for a fallback
    if (left <= 1e-6) break;
    if (!s || !BF.items[s.id] || !BF.items[s.id].food) continue;
    const per = BF.items[s.id].food / breadFood(), n = Math.min(s.count, Math.ceil(left / per));
    const r = I.remove(m.inv, s.id, n);
    if (r) { out.push({ id: s.id, count: r }); left -= r * per; }
  }
  return out;
}
const foodSystem = () => !!(BF.food && typeof BF.food.rate === "function");

// ---------- village helpers ----------
function villageKeyOf(m) { return m.village && m.slot ? m.village.key + "#" + m.slot.idx : null; }
function bredList(rec) {
  if (!rec.bred) {
    rec.bred = S.pending.get(rec.key) || [];
    S.pending.delete(rec.key);
    rec.bredNext = rec.bred.reduce((k, e) => Math.max(k, e.k + 1), 0);
  }
  return rec.bred;
}
function villagerCount(rec) {
  const live = (rec.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed && !m.bred).length;
  const roster = rec.roster ? Math.max(0, rec.roster.length - ((rec.killed && rec.killed.villager) || 0)) : live;
  return Math.max(roster, live) + bredList(rec).filter(e => !e.dead).length;
}

// Beds of the village: every bed foot block inside the village box (+8) or a builder's structure, found by
// scanning the chunk voxels (worldgen houses, builder houses and beds the player placed all count; broken ones don't).
// Chunks that are not loaded use their last scan, else the worldgen house beds inside them.
let FOOT = null;
function footTable() {
  if (FOOT) return FOOT;
  FOOT = new Int8Array((BF.MAX_BLOCK || 4095) + 1).fill(-1);
  for (let id = 0; id < FOOT.length; id++) { const b = BF.blocks[id]; if (b && b.bed && !b.bed.head) FOOT[id] = b.bed.f; }
  return FOOT;
}
function areaRects(rec) {
  const v = rec.wg, out = [];
  if (v && v.minX != null) out.push([v.minX - 8, v.minZ - 8, v.maxX + 8, v.maxZ + 8]);
  else out.push([rec.x - 40, rec.z - 40, rec.x + 40, rec.z + 40]);
  for (const e of rec.built || []) if (e && e.ox != null) out.push([e.ox - 1, e.oz - 1, e.ox + (e.w || 1) + 1, e.oz + (e.d || 1) + 1]);
  return out;
}
const inRects = (rects, x, z) => rects.some(r => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]);
function scanBeds(rec) {
  const CS = BF.CS, W = BF.world, rects = areaRects(rec), F = footTable();
  const cache = rec.bedCache || (rec.bedCache = new Map());
  const chunks = new Set();
  for (const r of rects) for (let cx = Math.floor(r[0] / CS); cx <= Math.floor(r[2] / CS); cx++)
    for (let cz = Math.floor(r[1] / CS); cz <= Math.floor(r[3] / CS); cz++) chunks.add(cx + "," + cz);
  const beds = [];
  for (const ck of chunks) {
    const c = W.chunks && W.chunks.get(ck);
    if (c && c.vox) {
      const found = [], vox = c.vox, maxY = Math.min(BF.H - 1, (c.maxY || BF.H - 1) + 1);
      for (let y = 1; y <= maxY; y++) for (let lz = 0; lz < CS; lz++) {
        const row = (y * CS + lz) * CS;
        for (let lx = 0; lx < CS; lx++) {
          const f = F[vox[row + lx]];
          if (f < 0) continue;
          const x = c.cx * CS + lx, z = c.cz * CS + lz;
          if (inRects(rects, x, z)) found.push({ x, y, z, f });
        }
      }
      cache.set(ck, found);
      beds.push(...found);
    } else if (cache.has(ck)) beds.push(...cache.get(ck));
    else {
      const [cx, cz] = ck.split(",").map(Number);
      for (const h of rec.houses || []) for (const b of (h && h.beds) || [])
        if (Math.floor(b.x / CS) === cx && Math.floor(b.z / CS) === cz) beds.push({ x: b.x, y: b.y, z: b.z, f: b.f });
    }
  }
  rec.beds = beds; rec.bedScanAt = performance.now();
  return beds;
}
function bedCount(rec) { if (!rec.beds || rec.bedDirty) { rec.bedDirty = false; scanBeds(rec); } return rec.beds.length; }
// beds >= villagers + 1, counting the children of pairs already in love (born in a moment) as villagers
const lovesIn = rec => S.loves.filter(L => L.rec === rec).length;
function bedsOK(rec) { const v = villagerCount(rec) + lovesIn(rec); return v < MAX_TOTAL && bedCount(rec) >= v + 1; }

// A free bed for a newborn: not a roster slot's bed, not any live member's bed, not another newborn's.
const bedKey = b => b.x + "," + b.y + "," + b.z;
function freeBed(rec, self) {
  const used = new Set();
  for (const sl of rec.roster || []) if (sl.bed) used.add(bedKey(sl.bed));
  for (const m of rec.members || []) if (m !== self && m.bed && !m.dead && !m.removed) used.add(bedKey(m.bed));
  for (const e of bredList(rec)) if (!e.dead && e.bed && (!self || e.mob !== self)) used.add(bedKey(e.bed));
  const W = BF.world, foot = (b) => { const d = BF.blocks[W.getBlock(b.x, b.y, b.z)]; return d && d.bed && !d.bed.head && d.bed.f === b.f; };
  let best = null, bd = Infinity;
  for (const b of rec.beds || []) {
    if (used.has(bedKey(b)) || !foot(b)) continue;
    const d = self ? Math.hypot(b.x - self.position.x, b.z - self.position.z) : 0;
    if (d < bd) { bd = d; best = b; }
  }
  return best ? { x: best.x, y: best.y, z: best.z, f: best.f } : null;
}

// ---------- child look ----------
function setChildLook(m, k) {        // k = 0 child .. 1 adult
  const s = CHILD_SCALE + (1 - CHILD_SCALE) * k, hs = CHILD_HEAD + (1 - CHILD_HEAD) * k;
  m.model.scale.setScalar(s);
  if (m.meshes && m.meshes.head) m.meshes.head.scale.setScalar(hs);
  m.height = CHILD_H + (ADULT_H - CHILD_H) * k;
  m.halfWidth = CHILD_HW + (ADULT_HW - CHILD_HW) * k;
}
function lookVariant() {
  const P = (BF.mobs && BF.mobs.professions) || [];
  return P.includes("unemployed") ? "unemployed" : "nitwit";   // plain robe when the jobs module defines it
}

// ---------- hearts ----------
let heartTex = null;
function heartTexture() {
  if (heartTex) return heartTex;
  const rows = [".XX.XX.", "XWXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];
  const c = document.createElement("canvas"); c.width = 9; c.height = 8;
  const g = c.getContext("2d");
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < 7; x++) {
    const ch = rows[y][x];
    if (ch === ".") continue;
    g.fillStyle = "#3a0a10"; g.fillRect(x + 1, y + 1, 1, 1);   // drop shadow outline
  }
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < 7; x++) {
    const ch = rows[y][x];
    if (ch === ".") continue;
    g.fillStyle = ch === "W" ? "#ffb8c0" : y >= 3 ? "#c41e32" : "#ec3046";
    g.fillRect(x + 1, y, 1, 1);
  }
  heartTex = new THREE.CanvasTexture(c);
  heartTex.magFilter = THREE.NearestFilter; heartTex.minFilter = THREE.NearestFilter;
  return heartTex;
}
function heart(x, y, z) {
  if (!BF.scene || typeof THREE === "undefined") return;
  const mat = new THREE.SpriteMaterial({ map: heartTexture(), transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(0.34, 0.3, 1);
  sp.position.set(x + (Math.random() - 0.5) * 0.5, y + Math.random() * 0.2, z + (Math.random() - 0.5) * 0.5);
  BF.scene.add(sp);
  S.hearts.push({ sp, life: 1.4, vy: 0.55 + Math.random() * 0.3, dx: (Math.random() - 0.5) * 0.2 });
}
const headTop = m => m.position.y + m.height + 0.35;
function updateHearts(dt) {
  for (let i = S.hearts.length - 1; i >= 0; i--) {
    const h = S.hearts[i];
    h.life -= dt;
    h.sp.position.y += h.vy * dt; h.sp.position.x += h.dx * dt;
    h.sp.material.opacity = Math.max(0, Math.min(1, h.life / 0.5));
    if (h.life <= 0) { BF.scene.remove(h.sp); h.sp.material.dispose(); S.hearts.splice(i, 1); }
  }
}

// ---------- eligibility / encounters ----------
function adultOK(m) {
  return m && m.type === "villager" && !m.dead && !m.removed && !m.child && !m.sleeping && !m.starving && !m.tradingWith &&
    !(m.ai && m.ai.fleeT > 0) && !m.love && m.inv;
}
function cdDay(m) { if (m.bred) { const e = m.bredEntry; return e ? e.cd : null; } const k = villageKeyOf(m); return k ? S.cd.get(k) : m.breedDay; }
function setCd(m, d) { m.breedDay = d; if (m.bred && m.bredEntry) m.bredEntry.cd = d; else { const k = villageKeyOf(m); if (k) S.cd.set(k, d); } }
function eligible(m) {
  if (!adultOK(m) || bedtime()) return false;
  const cd = cdDay(m);
  if (cd != null && now() - cd < COOLDOWN) return false;
  return breadEq(m.inv) >= NEED;
}
function pairKey(a, b) { const i = mid(a), j = mid(b); return i < j ? i + ":" + j : j + ":" + i; }
function encounters(rec) {
  const vs = (rec.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed && !m.child);
  if (vs.length < 2) return;
  const el = vs.map(eligible);
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
    const a = vs[i], b = vs[j], k = pairKey(a, b);
    const close = a.position.distanceTo(b.position) <= RADIUS;
    const cond = close && el[i] && el[j] && bedsOK(rec);
    if (!cond) { if (!close || !el[i] || !el[j]) S.near.delete(k); continue; }
    if (S.near.has(k)) continue;                 // already rolled this encounter
    S.near.add(k);
    S.stats.encounters++; S.stats.rolls++;
    if (Math.random() < CHANCE) { S.stats.successes++; startLove(a, b, rec); el[i] = el[j] = false; }
  }
}
function startLove(a, b, rec) {
  a.love = b; b.love = a;
  for (const m of [a, b]) { m.vel.x = m.vel.z = 0; m.ai.mode = "idle"; m.ai.t = LOVE_T + 1; m.ai.route = null; }
  S.loves.push({ a, b, rec, t: 0, heartT: 0 });
}
function endLove(L) { if (L.a.love === L.b) L.a.love = null; if (L.b.love === L.a) L.b.love = null; }
function bad(m) { return !m || m.dead || m.removed || m.sleeping || m.tradingWith || (m.ai && m.ai.fleeT > 0); }
function updateLoves(dt) {
  for (let i = S.loves.length - 1; i >= 0; i--) {
    const L = S.loves[i];
    if (bad(L.a) || bad(L.b) || bedtime()) { endLove(L); S.loves.splice(i, 1); continue; }
    L.t += dt; L.heartT -= dt;
    if (L.heartT <= 0) {
      L.heartT = 0.3;
      for (const m of [L.a, L.b]) heart(m.position.x, headTop(m), m.position.z);
    }
    if (L.t >= LOVE_T) {
      S.loves.splice(i, 1); endLove(L);
      birth(L.a, L.b, L.rec, L.force);
    }
  }
}
// Villager AI hook (mobs.js villagerAI): a villager in love stands still facing its partner.
function ai(m, dt, out) {
  const p = m.love;
  if (!p || p.removed || p.dead) { m.love = null; return false; }
  out.x = 0; out.z = 0;
  out.faceX = p.position.x; out.faceZ = p.position.z;
  m.lookAt = p;
  return true;
}
// Child movement (after wanderAI): quicker steps with a wobble, shorter idles.
function childMove(m, dt, out) {
  const ai = m.ai;
  if (ai.mode === "idle" && ai.t > 2.5) ai.t = 1 + Math.random() * 1.5;
  if (!out.x && !out.z) return;
  m.wob = (m.wob || Math.random() * 6) + dt * 4.5;
  const a = Math.sin(m.wob) * 0.55 + Math.sin(m.wob * 2.3) * 0.25, c = Math.cos(a), s = Math.sin(a);
  const x = out.x, z = out.z;
  out.x = (x * c - z * s) * 1.6; out.z = (x * s + z * c) * 1.6;
}

// ---------- children ----------
function standAt(x, y, z) {
  const W = BF.world;
  for (const dy of [0, 1, -1, 2, -2]) {
    const yy = Math.floor(y) + dy;
    if (!W.boxCollides(x, yy + 0.01, z, CHILD_HW, CHILD_H) && W.isSolid(Math.floor(x), yy - 1, Math.floor(z))) return [x, yy + 0.01, z];
  }
  return null;
}
function spawnEntry(rec, e, x, y, z) {
  const look = e.child ? lookVariant() : ((BF.mobs.professions || []).includes(e.prof) ? e.prof : lookVariant());
  const m = BF.mobs.spawn("villager", x, y, z, look, rec.style);
  if (!m) return null;
  m.profession = e.child ? "child" : e.prof;
  m.village = rec; m.home = null; m.bed = e.bed || null;
  m.slot = { house: null, idx: KEY_BASE + e.k, bed: null, prof: m.profession, bred: true };
  m.bred = true; m.bredEntry = e; m.child = !!e.child;
  m.parents = e.parents;
  if (e.save) BF.trades.unpack(m, e.save);
  if (m.child || !(BF.trades.TRADES && BF.trades.TRADES[m.profession])) m.trades = [];
  if (m.child) { setChildLook(m, 0); m.level = 1; m.xp = 0; }
  e.mob = m;
  rec.members.push(m);
  // grown newborns: profession / jobsite claim from the saved state (js/jobs.js; trading.js pack carries prof + job)
  if (!m.child && BF.jobs && typeof BF.jobs.onSpawn === "function") {
    try { BF.jobs.onSpawn(m, rec, Object.assign({ prof: e.prof }, e.save || {})); } catch (err) { console.error(err); }
  }
  return m;
}
function newEntry(rec, parents) {
  bredList(rec);
  const e = { k: rec.bredNext++, child: true, born: now(), eaten: 0, parents, prof: "child", bed: null, cd: null, pos: null, save: null, lastDay: BF.sky ? BF.sky.day : 0 };
  rec.bred.push(e);
  return e;
}
function giveChildBread(m) {
  const inv = BF.trades.inv;
  m.inv = inv.create();
  inv.add(m.inv, BF.I.bread, CHILD_BREAD);
  m.trades = []; m.level = 1; m.xp = 0;
}
function birth(a, b, rec, force) {
  if (breadEq(a.inv) < PAY || breadEq(b.inv) < PAY) return null;   // traded away meanwhile
  if (!bedsOK(rec) && !force) return null;                           // a bed was broken meanwhile
  const pa = take(a, PAY), pb = take(b, PAY);
  const x = (a.position.x + b.position.x) / 2, z = (a.position.z + b.position.z) / 2, y = Math.max(a.position.y, b.position.y);
  const at = standAt(x, y, z) || standAt(a.position.x, a.position.y, a.position.z) || [a.position.x, a.position.y, a.position.z];
  const e = newEntry(rec, [a.profession, b.profession]);
  const m = spawnEntry(rec, e, at[0], at[1], at[2]);
  if (!m) return null;
  giveChildBread(m);
  const d = now(); setCd(a, d); setCd(b, d);
  for (let k = 0; k < 6; k++) heart(m.position.x, headTop(m), m.position.z);
  S.stats.births++;
  const note = { day: +d.toFixed(2), village: rec.key, child: villageKeyOf(m), parents: e.parents, beds: bedCount(rec), villagers: villagerCount(rec), paid: [pa, pb].map(st => st.map(s => s.count + " " + BF.itemName(s.id)).join(" + ")) };
  S.log.push(note); if (S.log.length > 50) S.log.shift();
  console.info("[breeding] birth", JSON.stringify(note));
  if (BF.emit) BF.emit("villagerBorn", m, a, b);
  return m;
}
// Makes any villager mob a child of the nearest village (for /summon villager ~ ~ ~ child and tests).
function makeChild(m, parents) {
  if (!m || m.type !== "villager") return null;
  let rec = null, bd = Infinity;
  for (const r of (BF.mobs.villages || new Map()).values()) { const d = Math.hypot(r.x - m.position.x, r.z - m.position.z); if (d < bd) { bd = d; rec = r; } }
  if (BF.jobs && m.jobsite) BF.jobs.release(m, { keepProfession: true });
  if (BF.mobs.setProfession) BF.mobs.setProfession(m, lookVariant());   // plain robe (rebuilds the body)
  m.child = true; m.profession = "child"; m.trades = [];
  giveChildBread(m);
  setChildLook(m, 0);
  if (rec && bd < 96) {
    const e = newEntry(rec, parents || []);
    m.village = rec; m.bred = true; m.bredEntry = e; m.parents = e.parents;
    m.slot = { house: null, idx: KEY_BASE + e.k, bed: null, prof: "child", bred: true };
    e.mob = m;
    if (!rec.members.includes(m)) rec.members.push(m);
  }
  return m;
}
function growUp(m) {
  if (!m || !m.child || m.growing) return false;
  m.growing = true;
  S.grow.push({ m, t: 0 });
  return true;
}
function finishGrow(m) {
  m.growing = false; m.child = false;
  setChildLook(m, 1);
  m.profession = "unemployed"; m.variant = "unemployed"; m.trades = []; m.jobStocked = false;   // already wears the plain robe
  m.jobPrefer = (m.parents || []).filter(p => p && p !== "child" && p !== "unemployed");   // the grown child walks to a free jobsite itself (js/jobs.js seekAI), nearer ones of its parents' trades first
  const e = m.bredEntry;
  if (e) { e.child = false; e.prof = m.profession; e.grown = now(); }
  S.stats.grownUp++;
  for (let k = 0; k < 4; k++) heart(m.position.x, headTop(m), m.position.z);
  console.info("[breeding] grew up", villageKeyOf(m), "->", m.profession, "prefer", m.jobPrefer.join("/"));
  if (BF.emit) BF.emit("villagerGrewUp", m);
}
function updateGrow(dt) {
  for (let i = S.grow.length - 1; i >= 0; i--) {
    const g = S.grow[i];
    if (g.m.removed || g.m.dead) { g.m.growing = false; S.grow.splice(i, 1); if (!g.m.dead && g.m.bredEntry) g.m.bredEntry.growNow = true; continue; }
    g.t += dt;
    const k = Math.min(1, g.t / GROW_T);
    setChildLook(g.m, k * k * (3 - 2 * k));
    if (k >= 1) { S.grow.splice(i, 1); finishGrow(g.m); }
  }
}
// Per second: eating (fallback only), growth, bed for the night, keep the save entry current.
function childTick(rec, e) {
  const m = e.mob;
  if (!m || m.removed || m.dead) return;
  if (m.child) {
    const day = BF.sky ? BF.sky.day : 0;
    if (!foodSystem()) {                 // BF.food not loaded: the child eats 2 bread at each new day
      if (e.lastDay == null) e.lastDay = day;
      while (e.lastDay < day) {
        e.lastDay++;
        const r = take(m, CHILD_RATE);
        e.eaten += r.reduce((n, s) => n + s.count * (BF.items[s.id].food || breadFood()) / breadFood(), 0);
      }
    } else e.lastDay = day;
    const have = breadEq(m.inv);
    e.eaten = Math.max(e.eaten || 0, CHILD_BREAD - have);
    if ((have <= 1e-6 || e.growNow) && !m.growing) { e.growNow = false; growUp(m); }
  }
  // a bed for the night (children and grown newborns are not in the roster)
  const bedOK = b => { const d = BF.blocks[BF.world.getBlock(b.x, b.y, b.z)]; return d && d.bed && !d.bed.head && d.bed.f === b.f; };
  if (BF.sky && BF.sky.time > 0.45 && !m.sleeping && (!m.bed || !bedOK(m.bed))) {
    if (!rec.beds || performance.now() - (rec.bedScanAt || 0) > 3000) scanBeds(rec);
    m.bed = freeBed(rec, m); e.bed = m.bed;
  }
}
function spawnMissing(rec) {
  const P = BF.player && BF.player.position;
  if (!P) return;
  for (const e of bredList(rec)) {
    if (e.dead || (e.mob && !e.mob.removed)) continue;
    if (e.mob && e.mob.removed) {         // unloaded: keep its state
      const m = e.mob;
      e.pos = [m.position.x, m.position.y, m.position.z];
      if (m.inv) e.save = BF.trades.pack(m);
      if (!m.child) e.prof = m.profession;
      e.mob = null;
    }
    const pos = e.pos || [rec.x + (Math.random() - 0.5) * 8, rec.y != null ? rec.y : BF.world.heightAt(rec.x, rec.z) + 1, rec.z + (Math.random() - 0.5) * 8];
    if ((Math.hypot(pos[0] - P.x, pos[2] - P.z) > 72 && !(BF.villageSim && BF.villageSim.isActive(rec.key))) || !BF.world.isLoaded(pos[0], pos[2])) continue;
    const at = standAt(pos[0], pos[1], pos[2]) || standAt(rec.x + 0.5, (rec.y != null ? rec.y : BF.world.heightAt(rec.x, rec.z) + 1), rec.z + 0.5);
    if (!at) continue;
    spawnEntry(rec, e, at[0], at[1], at[2]);
  }
}

// ---------- main tick (mobs.update) ----------
function tick(dt) {
  if (!BF.mobs || !BF.trades) return;
  hookEvents();
  updateHearts(dt);
  updateLoves(dt);
  updateGrow(dt);
  S.timer -= dt;
  if (S.timer > 0) return;
  S.timer = 1;
  for (const rec of BF.mobs.villages.values()) {
    if (!rec.members) continue;
    try {
      bredList(rec);
      spawnMissing(rec);
      for (const e of rec.bred) {
        if (e.mob && !e.mob.removed && !e.mob.dead) { const m = e.mob; e.pos = [m.position.x, m.position.y, m.position.z]; }
        childTick(rec, e);
      }
      if (!rec.members.some(m => m.type === "villager" && !m.removed)) continue;
      if (rec.beds == null || performance.now() - (rec.bedScanAt || 0) > 5000 || rec.bedDirty) { rec.bedDirty = false; scanBeds(rec); }
      encounters(rec);
    } catch (err) { console.error(err); }
  }
}

// ---------- persistence (mobs.exportVillagers / importVillagers hooks) ----------
function metaOf(e) {
  const m = e.mob && !e.mob.removed ? e.mob : null;
  if (m) { e.pos = [m.position.x, m.position.y, m.position.z]; if (!m.child) e.prof = m.profession; }
  const r = v => Math.round(v * 100) / 100;
  return { k: e.k, child: !!e.child, born: e.born, eaten: e.eaten || 0, parents: e.parents || [], prof: e.prof, cd: e.cd,
    pos: e.pos ? e.pos.map(r) : null, bed: e.bed || null, lastDay: e.lastDay, dead: !!e.dead };
}
function exportAll(out) {
  const recs = new Map();
  for (const rec of BF.mobs.villages.values()) if (rec.bred) recs.set(rec.key, rec.bred);
  for (const [key, list] of S.pending) if (!recs.has(key)) recs.set(key, list);
  for (const [vk, list] of recs) for (const e of list) {
    if (e.dead) { delete out[vk + "#" + (KEY_BASE + e.k)]; continue; }
    const key = vk + "#" + (KEY_BASE + e.k);
    const m = e.mob && !e.mob.removed ? e.mob : null;
    const base = m && m.inv ? BF.trades.pack(m) : (out[key] && out[key].inv ? out[key] : e.save || { inv: [], level: 1, xp: 0 });
    out[key] = Object.assign({}, base, { bred: metaOf(e) });
  }
  for (const k of S.deadKeys) delete out[k];
  const cd = {};
  for (const [k, d] of S.cd) cd[k] = d;
  out["breeding:cd"] = cd;
}
function importAll(o) {
  reset();
  if (!o || typeof o !== "object") return;
  for (const key in o) {
    const v = o[key];
    if (key === "breeding:cd") { if (v && typeof v === "object") for (const k in v) if (Number.isFinite(+v[k])) S.cd.set(k, +v[k]); continue; }
    const i = key.lastIndexOf("#");
    if (i < 0 || !v || !v.bred) continue;
    const idx = +key.slice(i + 1);
    if (!(idx >= KEY_BASE)) continue;
    const b = v.bred, vk = key.slice(0, i);
    const e = { k: idx - KEY_BASE, child: !!b.child, born: +b.born || 0, eaten: +b.eaten || 0, parents: Array.isArray(b.parents) ? b.parents.slice(0, 2) : [],
      prof: typeof b.prof === "string" ? b.prof : (b.child ? "child" : "unemployed"), cd: b.cd != null ? +b.cd : null,
      pos: Array.isArray(b.pos) && b.pos.length === 3 && b.pos.every(Number.isFinite) ? b.pos : null,
      bed: b.bed && Number.isFinite(b.bed.x) ? b.bed : null, lastDay: b.lastDay, dead: !!b.dead,
      save: Object.assign({}, v, { bred: undefined }) };
    if (!S.pending.has(vk)) S.pending.set(vk, []);
    S.pending.get(vk).push(e);
  }
}
function reset() {
  for (const h of S.hearts) { if (BF.scene) BF.scene.remove(h.sp); h.sp.material.dispose(); }
  S.hearts.length = 0; S.loves.length = 0; S.grow.length = 0;
  S.pending.clear(); S.cd.clear(); S.near.clear(); S.deadKeys.clear(); S.timer = 0;
}

// ---------- events (BF.on comes from main.js, loaded later: registered on first use) ----------
let hooked = false;
function hookEvents() {
  if (hooked || typeof BF.on !== "function") return;
  hooked = true;
  BF.on("newWorld", () => reset());
  BF.on("mobKilled", onKilled);
  BF.on("blockPlaced", bedChange);
  BF.on("blockBroken", bedChange);
}
const onKilled = m => {
  if (!m || !m.bred || !m.village) return;
  // newborns are not roster slots: undo mobs.js's "killed" count so a roster villager is not lost with them
  const k = m.village.killed;
  if (k && k.villager > 0) k.villager--;
  const e = m.bredEntry;
  if (e) {                       // forget it: the entry leaves rec.bred, its key is dropped from the next save
    e.dead = true; e.mob = null;
    S.deadKeys.add(m.village.key + "#" + (KEY_BASE + e.k));
    const i = m.village.bred ? m.village.bred.indexOf(e) : -1;
    if (i >= 0) m.village.bred.splice(i, 1);
  }
};
const bedChange = (x, y, z, id) => {
  const b = BF.blocks[id];
  if (!b || !b.bed || !BF.mobs) return;
  for (const rec of BF.mobs.villages.values()) if (inRects(areaRects(rec), x, z)) rec.bedDirty = true;
};

// ---------- debug ----------
function villageOf(m) { return m && m.village; }
function forceBreed(a, b) {
  if (!a || !b || a.type !== "villager" || b.type !== "villager") return "need two villagers";
  const rec = villageOf(a) || villageOf(b);
  if (!rec) return "villagers have no village";
  if (a.love || b.love) return "already in love";
  startLove(a, b, rec);
  S.loves[S.loves.length - 1].force = true;   // debug: ignores the bed rule
  return true;
}
function info(rec) {
  rec = rec || [...BF.mobs.villages.values()][0];
  if (!rec) return null;
  return { key: rec.key, beds: bedCount(rec), villagers: villagerCount(rec), ok: bedsOK(rec),
    newborns: bredList(rec).map(e => ({ k: e.k, child: e.child, eaten: e.eaten, prof: e.prof, dead: !!e.dead, live: !!(e.mob && !e.mob.removed) })) };
}

// main.js defines BF.on after this file loads: hook up as soon as the page has loaded (or on the first tick)
addEventListener("load", hookEvents);

BF.breeding = {
  RADIUS, CHANCE, NEED, PAY, CHILD_BREAD, CHILD_RATE, COOLDOWN, LOVE_T, MAX_TOTAL, KEY_BASE,
  tick, ai, childMove, exportAll, importAll, reset,
  eligible, bedsOK, bedCount, villagerCount, scanBeds, breadEq,
  forceBreed, birth, growUp, makeChild, info, stats: S.stats, log: S.log, state: S,
  // instant variants for tests
  forceBirth(a, b) { const rec = villageOf(a) || villageOf(b); return rec ? birth(a, b, rec, true) : null; },
  growNow(m) { if (!m || !m.child) return false; finishGrow(m); return true; },
};
})();
