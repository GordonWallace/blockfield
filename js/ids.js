// Stable entity ids (spec r15-13). Mobs, village records and village places (houses, beds, roster slots, pens) are known by an id
// or key, and simulation objects refer to each other through those ids instead of holding each other directly, so that a mob can
// later be copied to a worker or a server without breaking its links.
// - Mobs get "e<n>" ids from a counter that only goes up and is saved with the world. A villager keeps its id through unloads and
//   saves (it is packed with its trading state under its villager key, village key + roster slot); a slot that respawns after a
//   death gets a new id. Other mobs get a new id each time they are created.
// - Village records are registered under their key ("x,z"); places under "<kind>:<key>" (house and bed keys from their canonical
//   block cell, pens from their pen key, slots from village key + slot index).
// - A mob's links (village, home, bed, slot, pen, mate, boat, ...) are accessors on its prototype: the mob's own enumerable fields
//   hold only the ids (villageId, homeKey, bedKey, slotKey, ...), and reading m.village resolves the id. Records that point at a mob
//   (pen animals, newborns, boat passengers, trade deals, job tasks) hold mobId, sellerId, ... the same way. BF.mobs.villageOf(m),
//   bedOf(m), ... read the same links.
// - A removed mob leaves the registry. Links to it still read it (m.removed set, as before) for GHOST game seconds, then undefined,
//   which callers take as they took null. A dead mob stays registered until it is removed.
// API: BF.ids = { alloc(), get(id), put(obj, id?), remove(idOrObj), idOf(v), placeKey(kind, x, y, z), link(proto, name, field),
//                 place(proto, name, field, keyOf), Refs, refs(o), MobRef, mobRef(o), isRefs(o), REF, reuse(obj, id), seen(id), next, size, list(prefix),
//                 serialize(), deserialize(o), reset(), stats }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const reg = new Map();   // id -> live object
// Removed mobs, kept readable for a while (id -> {o, t}): code that held a mob saw it go (m.removed) and acted on that a little later;
// it still does. After GHOST game seconds a link to it reads undefined.
const ghosts = new Map(), GHOST = 600;
const now = () => (BF.simNow ? BF.simNow() : 0);
let next = 1;            // the next "e<n>" id
const stats = { collisions: 0, last: null };   // a different object put under a key that was in use (tests read this)

function alloc() { return "e" + next++; }
function get(id) { if (id == null) return undefined; const o = reg.get(id); if (o !== undefined || !ghosts.size) return o; const g = ghosts.get(id); return g && g.o; }
function put(obj, id) {
  if (!obj) return obj;
  if (id == null) id = obj.id;
  if (id == null) { id = alloc(); obj.id = id; }
  const had = reg.get(id);
  if (had && had !== obj) {   // two objects claim one place key (or id): the newer is what links read now
    stats.collisions++; stats.last = id;
    if (stats.collisions <= 20 && BF.glog) BF.glog.log("WARN", "ids", "Entity id " + id + " was taken over by another object" + (obj.type ? " (" + obj.type + ")" : ""));
  }
  reg.set(id, obj);
  return obj;
}
function remove(x) {
  const id = x && typeof x === "object" ? x.id : x;
  if (id == null || (typeof x === "object" && reg.get(id) !== x)) return;
  const o = reg.get(id);
  reg.delete(id);
  const t = now();
  for (const [k, g] of ghosts) { if (t - g.t < GHOST && g.t <= t) break; ghosts.delete(k); }   // oldest first
  if (o && o.removed) ghosts.set(id, { o, t });
}
// The id of an entity: its own id, the player's fixed "player", or a fresh one for an object that has none yet (registered).
function idOf(v) {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  if (BF.player && v === BF.player) { if (reg.get("player") !== v) reg.set("player", v); return "player"; }
  if (v.id == null) put(v);
  else if (!v.removed && !reg.has(v.id)) reg.set(v.id, v);
  return v.id;
}
// A place's key from its block cell: the planet's canonical cell, so a place seen across a face edge has one key.
function placeKey(kind, x, y, z) {
  const fx = Math.floor(x), fz = Math.floor(z);
  const c = BF.world && BF.world.canonXZ ? BF.world.canonXZ(fx, fz) : null;
  return kind + ":" + (c ? c[0] : fx) + "," + Math.floor(y || 0) + "," + (c ? c[1] : fz);
}

// Fields that hold ids or keys of other objects (filled in by link and place): js/mobsave.js leaves them out of an exact restore, as it
// left out the objects they replace.
const REF = new Set(["id"]);
// An accessor pair on proto: o[name] reads the entity whose id is o[field]; assigning an entity stores its id.
function link(proto, name, field) {
  REF.add(field);
  Object.defineProperty(proto, name, {
    get() { const id = this[field]; return id == null ? id : get(id); },
    set(v) { this[field] = v == null ? v : idOf(v); },   // (null and undefined kept apart: some fields use both)
    enumerable: false, configurable: true,
  });
}
// The same for a place: keyOf(v, o) is the place's registry key (o is the object being linked from); assigning registers the place.
function place(proto, name, field, keyOf) {
  REF.add(field);
  Object.defineProperty(proto, name, {
    get() { const k = this[field]; return k == null ? k : reg.get(k); },
    set(v) {
      if (v == null) { this[field] = v; return; }
      const k = keyOf(v, this) ?? idOf(v);   // (a record without a key, as tests make: known by an id of its own)
      if (reg.get(k) !== v) put(v, k);
      this[field] = k;
    },
    enumerable: false, configurable: true,
  });
}

// The shared prototype of mobs and of the plain records that point at mobs or places (pen animals' state, newborn entries, boats,
// trade deals, job tasks, a mob's ai table). Each link reads the object whose id or key is in its field:
//   mobs and the player: mob, other, seller, goalSeller, vTarget, mate, love, attacker, ledBy, tradingWith (-> mobId, otherId, ...), riding (a boat);
//   village records: village, penVillage (-> villageId, penVillageId: the village key);
//   places: home (a house), bed, homeBed, slot (a roster slot), bredEntry (a newborn's entry), pen, sty, coop, pasture, exit (any of the
//   four, by its kind) (-> homeKey, ...);
//   lookAt: a mob (lookAtId) or plain data ("player", {yaw, pitch}, {position}) kept as it is (lookV).
// refs(o) gives a plain object this prototype, turning any of those fields it already has into ids.
const Refs = {};
const ENT = ["mob", "other", "seller", "goalSeller", "vTarget", "mate", "love", "attacker", "ledBy", "tradingWith", "riding"];
for (const n of ENT) link(Refs, n, n + "Id");
const villageKey = r => r.key;
place(Refs, "village", "villageId", villageKey);
place(Refs, "penVillage", "penVillageId", villageKey);
const cellKey = kind => v => placeKey(kind, v.x, v.y, v.z);
place(Refs, "home", "homeKey", cellKey("h"));
place(Refs, "bed", "bedKey", cellKey("b"));
place(Refs, "homeBed", "homeBedKey", cellKey("b"));
place(Refs, "slot", "slotKey", (sl, o) => "s:" + o.villageId + "#" + sl.idx);
place(Refs, "bredEntry", "bredKey", (e, o) => "bred:" + o.villageId + "#" + e.k);
for (const n of ["pen", "sty", "coop", "pasture"]) place(Refs, n, n + "Key", p => n + ":" + p.key);
place(Refs, "exit", "exitKey", p => p.kind + ":" + p.key);   // a keeper walking out of its pen, coop, sty or pasture
REF.add("lookAtId");
Object.defineProperty(Refs, "lookAt", {
  get() { const id = this.lookAtId; return id != null ? get(id) : this.lookV; },
  set(v) {
    if (v && typeof v === "object" && v.def && v.position) { this.lookAtId = idOf(v); this.lookV = null; }
    else { this.lookAtId = null; this.lookV = v; }
  },
  enumerable: false, configurable: true,
});
const NAMES = ENT.concat(["village", "penVillage", "home", "bed", "homeBed", "slot", "bredEntry", "pen", "sty", "coop", "pasture", "exit", "lookAt"]);
function refs(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  const p = Object.getPrototypeOf(o);
  if (p === Refs) return o;
  if (p !== Object.prototype && p !== null) return o;
  const had = [];
  for (const n of NAMES) if (Object.prototype.hasOwnProperty.call(o, n)) { had.push(n, o[n]); delete o[n]; }
  Object.setPrototypeOf(o, Refs);
  for (let i = 0; i < had.length; i += 2) o[had[i]] = had[i + 1];
  return o;
}
// Records that point at a mob only through o.mob and keep other fields of these names as plain data (a horse's record: its pen is a box).
const MobRef = {};
link(MobRef, "mob", "mobId");
function mobRef(o) {
  if (!o || typeof o !== "object" || Object.getPrototypeOf(o) === MobRef) return o;
  const own = Object.prototype.hasOwnProperty.call(o, "mob"), m = own ? o.mob : undefined;
  if (own) delete o.mob;
  Object.setPrototypeOf(o, MobRef);
  o.mob = m === undefined ? null : m;
  return o;
}
const isRefs = o => { const p = o && typeof o === "object" ? Object.getPrototypeOf(o) : null; return p === Refs || p === MobRef; };

BF.ids = {
  alloc, get, put, remove, idOf, placeKey, link, place, Refs, refs, MobRef, mobRef, isRefs, REF, stats,
  get next() { return next; },
  get size() { return reg.size; },
  live: id => reg.get(id),   // the registered object only (no removed mob)
  // registered objects of one kind (tests, debug): ids starting with prefix
  list(prefix) { const out = []; for (const [k, v] of reg) if (!prefix || k.startsWith(prefix)) out.push([k, v]); return out; },
  // A villager's saved id back (js/trading.js unpack): kept if free, so a reload brings each villager back under its old id.
  reuse(obj, id) {
    if (typeof id !== "string" || !/^e\d+$/.test(id) || (reg.has(id) && reg.get(id) !== obj)) return false;
    if (obj.id != null && obj.id !== id && reg.get(obj.id) === obj) reg.delete(obj.id);
    obj.id = id; reg.set(id, obj); ghosts.delete(id);
    const n = +id.slice(1);
    if (n >= next) next = n + 1;
    return true;
  },
  // raises the counter past a saved id (js/mobs.js importVillagers), so new ids never take one a saved villager will come back with
  seen(id) { const n = typeof id === "string" && /^e\d+$/.test(id) ? +id.slice(1) : 0; if (n >= next) next = n + 1; },
  serialize() { return { next }; },
  deserialize(o) { const n = o && Math.floor(+o.next); if (n > next) next = n; },   // old saves: none (the saved villagers' ids raise it)
  reset() { reg.clear(); ghosts.clear(); next = 1; stats.collisions = 0; stats.last = null; },
};
})();
