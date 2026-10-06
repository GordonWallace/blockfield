// Villager jobsites (BF.jobs): workstation blocks employ villagers, like vanilla job site POIs.
// - JOBSITE maps profession -> block name (the blocks are the "jobsite pack" in blocks.js); nitwits never work, `unemployed`
//   villagers (brown robe, no trades) look for an unclaimed jobsite nearby every few seconds and take its profession.
// - Naturally generated villages get their jobsite blocks from planVillage(v) (called by worldgen drawVillage): the count is a
//   rounded normal draw centred on the number of villagers who need a job (all non-nitwits, builders included), professions
//   follow the village roster (mobs.js villageRoster), blocks go inside the villager's own house (special buildings get their
//   matching block), composters beside the farms, drafting tables (builders) on the plaza. Deterministic from the seed.
// - A villager that loses its jobsite (block broken / replaced) always becomes unemployed, but remembers its old profession
//   (`m.jobMem = {prof, t}`, t = absolute game day) and keeps its level, xp and inventory. A block of that profession placed within
//   MEMORY_DAYS (30) game days is reclaimed at once by the nearest remembering villager, and a remembering villager has priority over other
//   unemployed ones for blocks of its profession. After MEMORY_DAYS the memory ends: level and xp reset, a regular unemployed villager.
// - Persistence: trading.js pack() stores `prof`, `job` [x,y,z], `st` (first-job stock given) and `mem` [prof, t] with the villager state;
//   importAll() rebuilds the claim table from a save. See CONTRACT.md "Jobsites".
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const JOBSITE = {
  farmer: "composter", librarian: "lectern", cleric: "brewing_stand", armorer: "blast_furnace", weaponsmith: "grindstone",
  toolsmith: "smithing_table", butcher: "smoker", fisherman: "barrel", shepherd: "loom", fletcher: "fletching_table",
  mason: "stonecutter", leatherworker: "cauldron", cartographer: "cartography_table", builder: "drafting_table", explorer: "survey_table", forester: "band_saw",
};
const PROFESSION_OF = {};
for (const p in JOBSITE) PROFESSION_OF[JOBSITE[p]] = p;
const NO_JOB = { nitwit: 1, unemployed: 1 };

const RADIUS = 48;            // claim search radius around the villager's village centre (or the villager)
const MEMORY_DAYS = 30;       // game days an unemployed villager remembers its profession (and level) after losing its jobsite
const WORK_START = 0.04, WORK_END = 0.45;   // sky.time window in which villagers visit their jobsite

let byId = null;              // block id -> profession
function idMap() {
  if (!byId && BF.B) { byId = new Map(); for (const p in JOBSITE) { const id = BF.B[JOBSITE[p]]; if (id != null) byId.set(id, p); } }
  return byId || new Map();
}
const profOfBlock = id => idMap().get(id) || null;
const blockFor = prof => (BF.B && JOBSITE[prof] ? BF.B[JOBSITE[prof]] : undefined);
const pk = (x, y, z) => x + "," + y + "," + z;
const rnd = (a, b) => a + Math.random() * (b - a);
const vkey = m => (m && m.village && m.slot && m.slot.idx != null ? m.village.key + "#" + m.slot.idx : null);
const gameDay = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const memValid = m => !!(m && m.jobMem && gameDay() - m.jobMem.t < MEMORY_DAYS);
// The profession an experienced villager insists on: its own, or the remembered one while unemployed.
const ownTrade = m => memValid(m) ? m.jobMem.prof : (!NO_JOB[m.profession] && (m.xp || 0) > 0 ? m.profession : null);
const isChild = m => !!(m.baby || m.child || m.isChild || m.isBaby || m.adult === false);

// ---------------------------------------------------------------- state
const sites = new Map();      // "x,y,z" -> {x, y, z, id, prof}: jobsite blocks in loaded chunks
const claims = new Map();     // "x,y,z" -> {key, mob}: who works there (key survives unloading and saves)
const planIndex = new Map();  // "x,y,z" -> {vkey, slot}: generated blocks reserved for a roster slot that has not spawned yet
const spawned = new Set();    // villager keys that spawned this session
const savedKeys = new Set();  // villager keys whose saved state carries a profession (they bring their own job)
let hooked = false, tickT = 0;

// ---------------------------------------------------------------- deterministic village plan (worldgen)
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
function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// Number of generated jobsites for `need` villagers who need one: rounded normal, sd = max(0.7, 18% of need), never < 0.
function drawCount(need, r) { return need <= 0 ? 0 : Math.max(0, Math.round(need + gauss(r) * Math.max(0.7, need * 0.18))); }

const LIVABLE = { house: 1, house2: 1, lhouse: 1, big: 1, library: 1, church: 1, smith: 1 };
// Free floor cells inside building b (local u, q), best first; taking one never cuts the door off from any other cell or a bed.
function freeCells(v, b, r) {
  const wg = BF.worldgen, rec = new Map();
  for (const [u, y, q, id] of wg.recordBuilding(b.type, b.w, b.d, v.style, b.h)) rec.set(u + "," + y + "," + q, id);
  const at = (u, y, q) => rec.get(u + "," + y + "," + q);
  const beds = new Set();
  for (const [u, q, a] of wg.bedPlan(b.type, b.w, b.d, b.h)) { beds.add(u + "," + q); beds.add(a === "u" ? (u + 1) + "," + q : u + "," + (q + 1)); }
  const walk = (u, q) => at(u, 1, q) === 0 && at(u, 2, q) === 0 && !!at(u, 0, q) && !beds.has(u + "," + q);
  const start = [b.du, 1];
  if (!walk(start[0], start[1])) return [];
  const taken = new Set();
  const reach = () => {
    const seen = new Set([start.join(",")]), st = [start];
    while (st.length) {
      const [u, q] = st.pop();
      for (const [du, dq] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (u + du) + "," + (q + dq);
        if (!seen.has(k) && !taken.has(k) && walk(u + du, q + dq)) { seen.add(k); st.push([u + du, q + dq]); }
      }
    }
    return seen;
  };
  const bedOK = seen => {
    for (const k of beds) { const [u, q] = k.split(",").map(Number); if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, c]) => seen.has((u + a) + "," + (q + c)))) return false; }
    return true;
  };
  const cands = [];
  for (let q = 1; q < b.d - 1; q++) for (let u = 1; u < b.w - 1; u++) {
    if (!walk(u, q) || (u === b.du && q <= 2)) continue;
    let wall = 0; for (const [du, dq] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (at(u + du, 1, q + dq)) wall++;
    cands.push({ u, q, s: wall + r() * 0.9 });
  }
  cands.sort((a, b2) => b2.s - a.s);
  const base = reach();
  return { next() { // take the best remaining candidate that keeps the room connected
    const before = reach().size;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i], k = c.u + "," + c.q;
      if (taken.has(k) || !base.has(k)) continue;
      taken.add(k);
      const s = reach();
      if (s.size === before - 1 && bedOK(s)) { cands.splice(i, 1); return c; }
      taken.delete(k);
    }
    return null;
  } };
}
// Planned jobsite blocks of a worldgen village v: [{x, y, z, id, prof, slot (roster idx, -1 = spare)}].
function planVillage(v) {
  const out = [];
  if (!v || !BF.worldgen || !BF.worldgen.recordBuilding || !BF.mobs || !BF.mobs.roster) return out;
  const key = Math.round(v.x) + "," + Math.round(v.z);
  let roster;
  try { roster = BF.mobs.roster({ key, houses: v.houses || [], nb: (v.buildings || []).length }); } catch (e) { console.error(e); return out; }
  const r = seeded("jobs:" + key);
  const needy = roster.filter(sl => sl.prof && !NO_JOB[sl.prof] && blockFor(sl.prof) != null);
  const n = drawCount(needy.length, r);
  // who gets a block: villagers of special buildings first, then a seeded shuffle of the rest
  const special = needy.filter(sl => sl.house && (sl.house.type === "library" || sl.house.type === "church" || sl.house.type === "smith"));
  const rest = needy.filter(sl => !special.includes(sl));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const jobs = special.concat(rest).slice(0, n).map(sl => ({ prof: sl.prof, slot: sl.idx, house: sl.house }));
  for (let k = needy.length; k < n; k++) jobs.push({ prof: needy[Math.floor(r() * needy.length)].prof, slot: -1, house: null }); // spares follow the roster mix
  jobs.sort((a, b) => (a.slot < 0) - (b.slot < 0) || (a.slot - b.slot));
  // placement
  const blds = v.buildings || [], used = new Set(), cellsOf = new Map();
  const W = (b, u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
  const put = (x, y, z, job) => {
    const k = pk(x, y, z);
    if (used.has(k)) return false;
    used.add(k); out.push({ x, y, z, id: blockFor(job.prof), prof: job.prof, slot: job.slot });
    return true;
  };
  const inside = (b, job) => {
    let fc = cellsOf.get(b);
    if (!fc) { try { fc = freeCells(v, b, r); } catch (e) { fc = []; } cellsOf.set(b, fc); }
    const c = fc.next ? fc.next() : null;
    if (!c) return false;
    const [x, z] = W(b, c.u, c.q);
    return put(x, b.y + 1, z, job);
  };
  const beside = (b, job) => { // the plot ring next to a building (inside its pad, off the road)
    for (let q = 1; q < b.d; q += 2) for (const u of [-1, b.w]) { const [x, z] = W(b, u, q); if (put(x, b.y + 1, z, job)) return true; }
    return false;
  };
  const PLAZA = [[4, -6], [-6, -2], [-6, 1], [6, -3], [-3, 6], [2, 6], [-2, -6], [6, 3]];
  const plaza = job => { for (const [dx, dz] of PLAZA) if (put(v.x + dx, v.y + 1, v.z + dz, job)) return true; return false; };
  const farms = blds.filter(b => b.type === "farm" || b.type === "bigfarm");
  const homes = blds.filter(b => LIVABLE[b.type]);
  const bOf = h => h && blds.find(b => b.doorX === h.doorX && b.doorZ === h.doorZ && LIVABLE[b.type]);
  let fi = 0;
  for (const job of jobs) {
    if (job.prof === "farmer" && farms.length && beside(farms[fi++ % farms.length], job)) continue;
    if (job.prof === "builder" && plaza(job)) continue;
    const b = bOf(job.house) || (job.slot < 0 && homes.length ? homes[Math.floor(r() * homes.length)] : null);
    if (b && (inside(b, job) || beside(b, job))) continue;
    plaza(job);
  }
  for (const j of out) if (j.slot >= 0 && !planIndex.has(pk(j.x, j.y, j.z))) planIndex.set(pk(j.x, j.y, j.z), { vkey: key, slot: j.slot });
  return out;
}
// The plan of a mobs.js village record (rec.wg is the worldgen village).
function planFor(rec) {
  const v = rec && rec.wg;
  if (!v) return [];
  if (!v.jobsites) v.jobsites = planVillage(v);
  for (const j of v.jobsites) if (j.slot >= 0 && !planIndex.has(pk(j.x, j.y, j.z))) planIndex.set(pk(j.x, j.y, j.z), { vkey: rec.key, slot: j.slot });
  return v.jobsites;
}

// ---------------------------------------------------------------- site registry (scans loaded chunks)
let FLAG = null;
function scanChunk(cx, cz, c) {
  if (!FLAG) { FLAG = new Uint8Array((BF.MAX_BLOCK || 4095) + 1); for (const id of idMap().keys()) FLAG[id] = 1; }
  const CS = BF.CS;
  BF.world.scanFlagged(c, FLAG, (lx, y, lz, id) => addSite(cx * CS + lx, y, cz * CS + lz, id));
}
function dropChunk(cx, cz) {
  const CS = BF.CS;
  for (const [k, s] of sites) if (Math.floor(s.x / CS) === cx && Math.floor(s.z / CS) === cz) sites.delete(k);
}
function addSite(x, y, z, id) { const p = profOfBlock(id); if (p) sites.set(pk(x, y, z), { x, y, z, id, prof: p }); }
function hook() {
  if (hooked || !BF.world || !BF.on) return;
  hooked = true;
  BF.world.onChunkLoad((cx, cz, c) => scanChunk(cx, cz, c));
  BF.world.onChunkUnload((cx, cz) => dropChunk(cx, cz));
  for (const c of BF.world.chunks.values()) scanChunk(c.cx, c.cz, c);
  BF.on("blockPlaced", (x, y, z, id) => { if (profOfBlock(id)) { addSite(x, y, z, id); reclaimAt(sites.get(pk(x, y, z))); } });
  BF.on("blockBroken", (x, y, z) => siteGone(x, y, z));
  BF.on("mobKilled", m => { if (m && m.type === "villager" && m.jobsite) { const s = m.jobsite; claims.delete(pk(s.x, s.y, s.z)); } });
}
function siteGone(x, y, z) {
  const k = pk(x, y, z);
  sites.delete(k);
  const o = claims.get(k);
  claims.delete(k);
  const m = o && (o.mob || liveByKey(o.key));
  if (m && m.jobsite && pk(m.jobsite.x, m.jobsite.y, m.jobsite.z) === k) lose(m);
}
// A jobsite block was placed: the nearest unemployed villager still remembering that profession takes it at once.
function reclaimAt(s) {
  if (!s || !BF.mobs) return;
  let best = null, bd = Infinity;
  for (const m of BF.mobs.list) {
    if (m.type !== "villager" || m.dead || m.removed || m.jobsite || isChild(m) || !memValid(m) || m.jobMem.prof !== s.prof) continue;
    const c = center(m);
    if (!c || Math.hypot(s.x + 0.5 - c.x, s.z + 0.5 - c.z) > RADIUS) continue;
    const d = Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z);
    if (d < bd) { bd = d; best = m; }
  }
  if (best && !claimedByOther(pk(s.x, s.y, s.z), best)) hire(best, s);
}
function liveByKey(key) {
  if (!key || !BF.mobs) return null;
  for (const m of BF.mobs.list) if (m.type === "villager" && !m.dead && !m.removed && vkey(m) === key) return m;
  return null;
}

// ---------------------------------------------------------------- claims
// A block of profession P is reserved for unemployed villagers remembering P (within claim range of it) against everybody else.
function reservedForMemory(k, m) {
  const s = sites.get(k);
  if (!s || !BF.mobs || (memValid(m) && m.jobMem.prof === s.prof)) return false;
  for (const o of BF.mobs.list) {
    if (o === m || o.type !== "villager" || o.dead || o.removed || o.jobsite || !memValid(o) || o.jobMem.prof !== s.prof) continue;
    const c = center(o);
    if (c && Math.hypot(s.x + 0.5 - c.x, s.z + 0.5 - c.z) <= RADIUS) return true;
  }
  return false;
}
function claimedByOther(k, m) {
  if (reservedForMemory(k, m)) return true;
  const o = claims.get(k);
  if (o) {
    if (o.mob === m || (o.key && o.key === vkey(m))) return false;
    if (o.mob && o.mob.dead) { claims.delete(k); return false; }
    if (!o.key && (!o.mob || o.mob.removed)) { claims.delete(k); return false; }
    return true;
  }
  const pl = planIndex.get(k);
  if (!pl) return false;
  const owner = pl.vkey + "#" + pl.slot;
  return owner !== vkey(m) && !spawned.has(owner) && !savedKeys.has(owner);
}
function center(o) {
  if (!o) return null;
  if (o.position) return o.village ? { x: o.village.x, z: o.village.z } : { x: o.position.x, z: o.position.z };
  if (Array.isArray(o)) return { x: o[0], z: o.length > 2 ? o[2] : o[1] };
  return o.x != null && o.z != null ? { x: o.x, z: o.z } : null;
}
// Unclaimed jobsite blocks (loaded, still standing) within `radius` of a village / position / mob. `forMob` treats its own claims as free.
function unclaimed(where, radius, forMob) {
  hook();
  const c = center(where), R = radius || RADIUS, out = [], W = BF.world;
  if (!c) return out;
  for (const [k, s] of sites) {
    if (Math.hypot(s.x + 0.5 - c.x, s.z + 0.5 - c.z) > R) continue;
    if (W && W.isLoaded(s.x, s.z) && W.getBlock(s.x, s.y, s.z) !== s.id) { sites.delete(k); continue; }
    if (claimedByOther(k, forMob || null)) continue;
    out.push(s);
  }
  return out;
}
function rebuildTrades(m) {
  if (!BF.trades) return;
  const out = [];
  for (let l = 1; l <= (m.level || 1); l++) out.push(...BF.trades.offers(m.profession, l));
  m.trades = out;
}
// Profession change in place: outfit (mobs.js rebuilds the body), offers; inventory, level and xp are kept.
function setProfession(m, prof) {
  if (!m || !prof || m.profession === prof) return;
  if (BF.mobs && BF.mobs.setProfession) BF.mobs.setProfession(m, prof);
  else { m.profession = prof; m.variant = prof; }
  m.profession = prof;
  if (m.bs && prof !== "builder") m.bs = null;
  rebuildTrades(m);
}
function take(m, s, prof) {
  if (m.jobsite) release(m, { keepProfession: true });
  m.jobsite = { x: s.x, y: s.y, z: s.z };
  claims.set(pk(s.x, s.y, s.z), { key: vkey(m), mob: m });
  if (prof && prof !== m.profession) { const was = m.profession; setProfession(m, prof); if (BF.vlog) BF.vlog.profession(m, was, m.profession); }
  if (m.job) { m.job.mode = "off"; m.job.t = rnd(3, 10); }
}
// Picks an unclaimed jobsite near the villager's village and takes its profession. opts: {radius = 48, prefer: [professions] (3x weight each)}.
// Experienced villagers (xp > 0) only take blocks of their own profession; nitwits never work. Returns the profession or null.
function claim(m, opts) {
  opts = opts || {};
  if (!m || m.dead || m.removed || m.type !== "villager" || m.profession === "nitwit") return null;
  if (opts.site) return !claimedByOther(pk(opts.site.x, opts.site.y, opts.site.z), m) ? hire(m, opts.site) : null;   // the block the villager walked to
  const own = ownTrade(m);
  const list = unclaimed(m, opts.radius || RADIUS, m).filter(s => (!own || s.prof === own) && !(m.jobsite && s.x === m.jobsite.x && s.y === m.jobsite.y && s.z === m.jobsite.z));
  if (!list.length) return null;
  const pref = (Array.isArray(opts.prefer) ? opts.prefer.filter(Boolean) : []).concat(memValid(m) ? [m.jobMem.prof, m.jobMem.prof] : []);
  const wts = list.map(s => { let w = 1; for (const p of pref) if (p === s.prof) w *= 3; return w; });
  let t = Math.random() * wts.reduce((a, b) => a + b, 0), i = 0;
  while (i < list.length - 1 && (t -= wts[i]) > 0) i++;
  return hire(m, list[i]);
}
// The villager takes jobsite s (a site record of `sites`) with its profession; the first job brings the profession's starting wares.
function hire(m, s) {
  const first = !m.jobStocked;
  take(m, s, s.prof);
  m.jobMem = null;
  if (first && (m.xp || 0) === 0 && BF.trades && m.inv) { // first job: the profession's starting wares (once per villager)
    try { for (const st of BF.trades.stockFor(s.prof, m)) if (st && st.id !== BF.I.emerald) BF.trades.inv.add(m.inv, st.id, st.count); } catch (e) { console.error(e); }
  }
  m.jobStocked = true;
  if (BF.villageLife && BF.villageLife.ensureKit) BF.villageLife.ensureKit(m);   // a new farmer / builder gets its empty bucket (and hoe)
  if (BF.emit) BF.emit("villagerHired", m, s.prof);
  return s.prof;
}
// Frees the villager's jobsite. Unless opts.keepProfession the villager becomes unemployed and remembers its profession (level and xp stay).
function release(m, opts) {
  if (!m) return;
  if (m.jobsite) { const k = pk(m.jobsite.x, m.jobsite.y, m.jobsite.z), o = claims.get(k); if (o && (o.mob === m || o.key === vkey(m))) claims.delete(k); }
  m.jobsite = null;
  if (m.job) m.job.mode = "off";
  if (!(opts && opts.keepProfession) && !NO_JOB[m.profession]) { m.jobMem = { prof: m.profession, t: gameDay() }; setProfession(m, "unemployed"); }
}
function lose(m) { release(m); if (BF.emit) BF.emit("villagerFired", m); }
const isEmployed = m => !!(m && m.jobsite && !NO_JOB[m.profession]);

// ---------------------------------------------------------------- mobs.js hooks
// A roster villager spawned (after its saved state was unpacked into it). sv = saved state or undefined.
function onSpawn(m, rec, sv) {
  hook();
  const key = vkey(m);
  if (key) spawned.add(key);
  if (sv && typeof sv.prof === "string") {          // saved with the jobs system: profession and jobsite come from the save
    if (sv.prof !== m.profession) setProfession(m, sv.prof);
    m.jobStocked = !!sv.st;
    if (Array.isArray(sv.mem) && typeof sv.mem[0] === "string" && Number.isFinite(+sv.mem[1])) m.jobMem = { prof: sv.mem[0], t: +sv.mem[1] };
    if (Array.isArray(sv.job) && sv.job.length === 3) {
      const [x, y, z] = sv.job.map(Number), k = pk(x, y, z);
      if (!claimedByOther(k, m)) { m.jobsite = { x, y, z }; claims.set(k, { key, mob: m }); }
      else release(m);
    }
    return;
  }
  if (NO_JOB[m.profession] || isChild(m)) return;
  m.jobStocked = true;
  const plan = rec ? planFor(rec) : [], e = m.slot && plan.find(j => j.slot === m.slot.idx);
  if (e && !claimedByOther(pk(e.x, e.y, e.z), m)) { take(m, e, e.prof); return; }
  if (sv && ((+sv.xp || 0) > 0 || (+sv.level || 1) > 1)) return;  // old save, experienced: keeps its trade and looks for a block of it
  setProfession(m, "unemployed");
  if (!sv && BF.trades) m.inv = BF.trades.stockFor("unemployed", m);
  m.jobStocked = false;
}
// The remembered profession expired: a regular unemployed villager again (level and xp reset, inventory kept).
function forget(m) {
  m.jobMem = null;
  if (m.profession !== "unemployed") return;
  m.level = 1; m.xp = 0;
  rebuildTrades(m);
}
// Global tick (mobs.update): validates the claimed jobsites. Villagers without a job look for one in ai() below (seekAI).
function tick(dt) {
  hook();
  tickT -= dt;
  if (tickT > 0 || !BF.mobs || !BF.world) return;
  tickT = 1;
  const W = BF.world;
  for (const m of BF.mobs.list) {
    if (m.type !== "villager" || m.dead || m.removed) continue;
    if (m.jobMem && !memValid(m)) forget(m);
    if (m.jobsite) {
      const s = m.jobsite;
      if (W.isLoaded(s.x, s.z) && profOfBlock(W.getBlock(s.x, s.y, s.z)) !== m.profession) { claims.delete(pk(s.x, s.y, s.z)); lose(m); }
      continue;
    }
  }
}
// ---------------------------------------------------------------- walking to a jobsite (unemployed villagers)
// A villager without a job picks the nearest free jobsite block (one it may take: experienced ones only their own profession), walks to it
// and takes it on arrival if nobody got there first: the claim happens at the block, not from afar. The loser of a race picks again.
const SEEK_MAX = 120;             // seconds before a walk is given up
const SEEK_AVOID = 60;            // seconds a site that could not be reached (or was lost) is left alone
const adjacentTo = (s, x, y, z) => Math.abs(x - s.x) + Math.abs(z - s.z) === 1 && Math.abs(y - s.y) <= 1;
function pickSite(m, sk) {
  const own = ownTrade(m), mem = memValid(m) ? m.jobMem.prof : null, pref = m.jobPrefer || [], now = BF.simNow();
  const list = unclaimed(m, RADIUS, m).filter(s => (!own || s.prof === own) && !((sk.avoid[pk(s.x, s.y, s.z)] || 0) > now));
  let best = null, bd = Infinity;
  for (const s of list) {
    const d = Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) * (s.prof === mem ? 0.3 : pref.includes(s.prof) ? 0.6 : 1) * rnd(0.9, 1.1);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function seekAI(m, dt, out, nav) {
  if (!nav || m.profession === "nitwit" || isChild(m) || m.tradingWith || m.sleeping || m.type !== "villager") return false;
  const sk = m.seek || (m.seek = { site: null, t: 0, cd: rnd(1, 5), avoid: {}, plan: 0 });
  const ai = m.ai, now = BF.simNow();
  if (!sk.site) {
    if ((sk.cd -= dt) > 0) return false;
    sk.cd = rnd(3, 8);
    const s = pickSite(m, sk);
    if (!s) return false;
    sk.site = s; sk.t = 0; sk.route = false; ai.route = null;
  }
  const s = sk.site, k = pk(s.x, s.y, s.z), W = BF.world;
  const giveUp = lost => { sk.avoid[k] = now + (lost ? 15 : SEEK_AVOID); sk.site = null; sk.cd = lost ? rnd(0.5, 2) : rnd(3, 8); ai.route = null; return false; };
  sk.t += dt;
  if (sk.t > SEEK_MAX || (W.isLoaded(s.x, s.z) && W.getBlock(s.x, s.y, s.z) !== s.id)) return giveUp(false);
  if (claimedByOther(k, m)) return giveUp(true);                   // somebody else got there first
  const [x, y, z] = nav.feetCell(m);
  if (adjacentTo(s, x, y, z) || (Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) < 1.9 && Math.abs(s.y - y) <= 1)) {
    ai.route = null;
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5;
    if (claim(m, { site: s })) { sk.site = null; m.seek = null; if (m.job) { m.job.mode = "work"; m.job.t = rnd(4, 8); } }   // takes the block and looks at it for a while
    else giveUp(true);
    return true;
  }
  if (!ai.route || ai.routeKind !== "job") {
    if (!nav.takePlan()) return true;
    const route = nav.findPath(x, y, z, { x: s.x, z: s.z, at: (cx, cy, cz) => adjacentTo(s, cx, cy, cz) }, 2500);
    if (!route) return giveUp(false);
    ai.route = route; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "job";
  }
  const r = nav.followRoute(m, dt, out, m.def.speed);
  if (r === "stuck") return giveUp(false);
  if (r === "done") ai.route = null;
  ai.mode = "idle"; ai.t = 2;
  return true;
}
// Daytime work: now and then walk to the jobsite (A*) and stand at it for a while. Returns true while it steers.
function ai(m, dt, out) {
  const s = m.jobsite, nav = BF.mobs && BF.mobs.nav;
  if (!s) return seekAI(m, dt, out, nav);
  if (m.seek) m.seek = null;
  if (!nav || NO_JOB[m.profession] || m.profession === "builder") return false;
  const J = m.job || (m.job = { mode: "off", t: rnd(5, 30) });
  const t = BF.sky ? BF.sky.time : 0.2;
  if (t < WORK_START || t > WORK_END) { if (J.mode !== "off") { J.mode = "off"; m.ai.route = null; } return false; }
  if (J.mode === "off") {
    J.t -= dt;
    if (J.t > 3 && m.profession === "cartographer" && BF.cartography && BF.cartography.wantsJob(m)) J.t = rnd(1, 3);   // something to craft: go to the table soon
    if (J.t > 0) return false;
    if (Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) > 40 || !BF.world.isLoaded(s.x, s.z)) { J.t = rnd(20, 40); return false; }
    if (!nav.takePlan()) { J.t = 0.3; return false; }
    const [x, y, z] = nav.feetCell(m);
    const at = (cx, cy, cz) => Math.abs(cx - s.x) + Math.abs(cz - s.z) === 1 && Math.abs(cy - s.y) <= 1;
    const route = at(x, y, z) ? [] : nav.findPath(x, y, z, { x: s.x, z: s.z, at }, 2500);
    if (!route) { J.t = rnd(40, 90); return false; }
    m.ai.route = route; m.ai.ri = 0; m.ai.stuckT = 0; J.mode = "go";
  }
  if (J.mode === "go") {
    const r = nav.followRoute(m, dt, out, m.def.speed);
    if (r === "going") return true;
    m.ai.route = null;
    if (r === "stuck") { J.mode = "off"; J.t = rnd(30, 60); return false; }
    J.mode = "work"; J.t = rnd(8, 20);
  }
  if (J.mode === "work") {
    J.t -= dt;
    if (m.profession === "cartographer" && BF.cartography) BF.cartography.work(m, J, dt);   // crafts compasses and maps at its table (js/cartography.js)
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.45 };   // head down at the block
    if (J.t <= 0) { J.mode = "off"; J.t = rnd(40, 120); m.ai.mode = "idle"; m.ai.t = 1; return false; }
    return true;
  }
  return false;
}
// Save import (mobs.importVillagers): rebuilds the claim table from the villager entries ({prof, job}).
function importAll(o) {
  claims.clear(); savedKeys.clear();
  for (const k in o || {}) {
    const e = o[k];
    if (k.indexOf("#") < 0 || !e || typeof e !== "object" || typeof e.prof !== "string") continue;
    savedKeys.add(k);
    if (Array.isArray(e.job) && e.job.length === 3) claims.set(pk(...e.job.map(Number)), { key: k, mob: null });
  }
}
function reset() { sites.clear(); claims.clear(); planIndex.clear(); spawned.clear(); savedKeys.clear(); tickT = 0; }

BF.jobs = {
  JOBSITE, PROFESSION_OF, RADIUS, sites, claims,
  profOfBlock, blockFor, claim, hire, release, unclaimed, isEmployed, setProfession,
  planVillage, planFor, drawCount, MEMORY_DAYS, memValid, onSpawn, tick, ai, importAll, reset,
};
})();
