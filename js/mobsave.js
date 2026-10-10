// Exact save and restore of mobs (BF.mobSave). Release 1.3, village loading plan (/mnt/project-files/plans/village-loading-1.3.md, scenario 1).
// Quitting and reloading takes no game time, so every mob that was loaded comes back exactly as it was: position, facing, health and what it
// was doing. Villagers (and village iron golems) come back through their village's normal spawn (js/mobs.js updateVillages); wild and
// hostile mobs come back here, once the player is near the spot. A snapshot is only used when the game clock is still within EXACT of the
// saved time; older ones are dropped and the old rules apply (villagers appear at home).
// - A snapshot is the mob's own plain data: its ai table and any other plain fields (a job's stage, target, timers; routes too). Anything
//   that is not plain (meshes, other mobs, villages, registries) is left out, and the fields job modules restore from their own saves
//   (inventory, profession, bed, jobsite, village) are never touched. Everything else is read back as saved.
// - Mobs owned by another module's save (pen sheep, coop hens, pasture cows, horses, boat riders) are left to that module.
// API: BF.mobSave = { SHORT, stash, fresh, EXACT, serialize(), deserialize(o), peek(key) -> snap | "wait" | null, golem(villageKey) -> snap | null,
//                     apply(m, snap), done(key), update(dt), reset(), pending() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SHORT = 1 / 24;       // game days (a game hour): a village unloaded for less than this, with no bedtime in between, brings its mobs back exactly too
const EXACT = 0.02;          // game days (about 24 s at 1x): a snapshot older than this is not an exact restore
const MAX_WILD = 120;        // wild mobs saved (the ones nearest the player)
const MAX_DEPTH = 7, MAX_ARR = 2500;
// Fields a snapshot never holds: render objects, identity (set again by the spawn), what the modules restore from their own saves.
const SKIP = new Set(["def", "position", "vel", "root", "model", "meshes", "material", "village", "home", "slot", "bed", "homeBed", "jobsite",
  "jobStocked", "jobMem", "inv", "trades", "pen", "penVillage", "penIn", "coop", "hen", "cow", "pasture", "sheep", "horse", "riding", "ledBy",
  "level", "xp", "restockDay", "priceDay", "life", "profession", "variant", "style", "type", "hostile", "halfWidth", "height", "maxHp", "bs",
  "tradingWith", "badge", "badgeLevel", "removed", "dead", "deathT", "kitFor", "cowKit", "parents", "bredEntry", "bred", "child"]);

const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const r2 = v => Math.round(v * 100) / 100;

// A JSON-safe copy of plain data; undefined for anything else.
function ser(v, d, seen) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000) : undefined;
  if (t === "string" || t === "boolean") return v;
  if (t !== "object" || d > MAX_DEPTH) return undefined;
  if (v.isVector3) return { $v: [r2(v.x), r2(v.y), r2(v.z)] };
  if (v.isObject3D || v.isMaterial || v.isBufferGeometry || v.nodeType || v.members || (v.root && v.position)) return undefined;
  if (seen.has(v)) return undefined;
  if (v instanceof Map || v instanceof Set) {   // kept with plain keys only (a Map keyed by mobs comes back empty): job modules call .get / .has on theirs
    seen.add(v);
    const e = [];
    if (v instanceof Map) { for (const [k, x] of v) { if (k !== null && typeof k === "object") continue; const s = ser(x, d + 1, seen); if (s !== undefined) e.push([k, s]); } }
    else for (const k of v) { if (k === null || typeof k !== "object") e.push(k); }
    seen.delete(v);
    return v instanceof Map ? { $m: e } : { $s: e };
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARR) return undefined;
    seen.add(v);
    const a = v.map(x => { const s = ser(x, d + 1, seen); return s === undefined ? null : s; });
    seen.delete(v);
    return a;
  }
  const p = Object.getPrototypeOf(v);
  if (p !== Object.prototype && p !== null) return undefined;
  seen.add(v);
  const o = {};
  for (const k in v) { const s = ser(v[k], d + 1, seen); if (s !== undefined) o[k] = s; }
  seen.delete(v);
  return o;
}
function deser(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deser);
  if (v.$v && window.THREE) return new THREE.Vector3(v.$v[0], v.$v[1], v.$v[2]);
  if (v.$m) return new Map(v.$m.map(([k, x]) => [k, deser(x)]));
  if (v.$s) return new Set(v.$s);
  const o = {};
  for (const k in v) o[k] = deser(v[k]);
  return o;
}

const nightNow = () => !!(BF.mobs && BF.mobs.nav && BF.mobs.nav.bedtime && BF.mobs.nav.bedtime());
// Is a stored snapshot still an exact restore? Quit and reload: within EXACT of the save. A village that unloaded (stash): under SHORT and no bedtime
// at either end. Explorers always are (they come back at their saved spot).
function fresh(s) {
  if (!s) return false;
  const age = dayNow() - (s.t != null ? s.t : savedAt);
  if (age < -1e-6) return false;
  if (s.prof === "explorer") return true;
  if (!s.away) return age < EXACT;
  return age < SHORT && !s.night && !nightNow();
}
function snapOf(m) {
  const s = {};
  for (const k of Object.keys(m)) {
    if (SKIP.has(k)) continue;
    const x = ser(m[k], 0, new Set());
    if (x !== undefined) s[k] = x;
  }
  return { p: [r2(m.position.x), r2(m.position.y), r2(m.position.z)], yaw: r2(m.yaw || 0), hp: m.hp, prof: m.profession, s };
}
// Puts a snapshot's state back on mob m, at its saved spot.
function apply(m, snap) {
  if (!m || !snap || !snap.s) return m;
  for (const k in snap.s) if (!SKIP.has(k)) m[k] = deser(snap.s[k]);
  m.position.set(snap.p[0], snap.p[1], snap.p[2]);
  m.vel.set(0, 0, 0);
  m.yaw = snap.yaw || 0;
  if (m.model) m.model.rotation.y = m.yaw;
  if (snap.hp > 0) m.hp = Math.min(snap.hp, m.maxHp || snap.hp);
  m.fallStart = m.position.y; m.onGround = false;
  m.tradingWith = null; m.lookAt = null;
  m.restored = true;
  return m;
}

let villagers = new Map();   // villager key -> snap
let golems = new Map();      // village key -> [snap]
let wild = [];               // [{type, variant, style, snap}]
let savedAt = -1, wildT = 0;

const owned = m => m.pen || m.penVillage || m.coop || m.pasture || m.horse || m.riding || m.ledBy || m.removed || m.dead;
// A village unloading: its villagers and golems are written down where they stand, to come back exactly after a short absence.
function stash(m) {
  if (!m || !m.position || owned(m) || !m.village) return;
  const snap = Object.assign(snapOf(m), { t: dayNow(), away: true, night: nightNow() });
  if (m.type === "villager" && m.slot) villagers.set(m.village.key + "#" + m.slot.idx, snap);
  else if (m.type === "iron_golem") { const a = golems.get(m.village.key) || []; a.push(snap); golems.set(m.village.key, a); }
}
function serialize() {
  const L = BF.mobs && BF.mobs.list;
  if (!L || !BF.player || !BF.player.position) return undefined;
  const o = { t: dayNow(), v: {}, g: {}, w: [] }, pp = BF.player.position, cand = [];
  for (const m of L) {
    if (!m.position || owned(m)) continue;
    if (m.type === "villager" && m.village && m.slot) { o.v[m.village.key + "#" + m.slot.idx] = snapOf(m); continue; }
    if (m.type === "iron_golem" && m.village) { (o.g[m.village.key] || (o.g[m.village.key] = [])).push(snapOf(m)); continue; }
    if (m.village || m.type === "villager") continue;
    cand.push(m);
  }
  for (const [k, s] of villagers) if (!o.v[k] && fresh(s)) o.v[k] = s;   // unloaded villages' villagers still waiting to come back
  for (const [k, a] of golems) for (const s of a) if (fresh(s)) (o.g[k] || (o.g[k] = [])).push(s);
  cand.sort((a, b) => a.position.distanceToSquared(pp) - b.position.distanceToSquared(pp));
  for (const m of cand.slice(0, MAX_WILD)) o.w.push({ type: m.type, variant: m.variant, style: m.style, snap: snapOf(m) });
  return o;
}
function deserialize(o) {
  reset();
  if (!o || typeof o !== "object" || !Number.isFinite(o.t)) return;
  savedAt = o.t;
  for (const k in o.v || {}) villagers.set(k, o.v[k]);
  for (const k in o.g || {}) golems.set(k, o.g[k]);
  wild = Array.isArray(o.w) ? o.w.filter(e => e && e.type && e.snap && e.snap.p) : [];
}
function reset() { villagers = new Map(); golems = new Map(); wild = []; savedAt = -1; }
const exact = () => savedAt >= 0 && dayNow() - savedAt >= -1e-6 && dayNow() - savedAt < EXACT;   // wild mobs (saved with the game)
const there = s => BF.world.isLoaded(s.p[0], s.p[2]);

// The snapshot a villager slot should come back from: the snap when it is still exact and its spot is loaded; "wait" while the spot is not
// loaded yet; null when there is none or it has gone stale (and then it is dropped).
function peek(key) {
  const s = villagers.get(key);
  if (!s) return null;
  if (!fresh(s)) { villagers.delete(key); return null; }
  return there(s) ? s : "wait";
}
function golem(vkey) {
  const a = golems.get(vkey);
  if (!a || !a.length) return null;
  const ok = a.filter(fresh);
  if (ok.length !== a.length) { if (ok.length) golems.set(vkey, ok); else golems.delete(vkey); }
  const s = ok.find(there);
  if (!s) return null;
  ok.splice(ok.indexOf(s), 1);
  return s;
}
function done(key) { villagers.delete(key); }

// Brings back wild and hostile mobs once the player is near their spot (called from the mobs update).
function update(dt) {
  if (!wild.length) return;
  if (!exact()) { wild = []; return; }
  wildT -= dt;
  if (wildT > 0) return;
  wildT = 0.5;
  const keep = [];
  for (const e of wild) {
    const s = e.snap;
    if (!there(s)) { keep.push(e); continue; }
    const m = BF.mobs.spawn ? BF.mobs.spawn(e.type, s.p[0], s.p[1], s.p[2], e.variant, e.style) : null;
    if (m) apply(m, s);
  }
  wild = keep;
}

if (typeof BF.on === "function") BF.on("newWorld", reset);
BF.mobSave = { SHORT, stash, fresh, EXACT, serialize, deserialize, peek, golem, apply, done, update, reset, snapOf, pending: () => ({ villagers: villagers.size, golems: golems.size, wild: wild.length }) };
})();
