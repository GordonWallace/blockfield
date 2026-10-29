// Dropped item entities: items that pop out of broken blocks and killed mobs, bob on the ground,
// and fly into the player's inventory when they walk close. They despawn after 5 minutes of lying in a loaded chunk
// (in an unloaded chunk they wait, as in vanilla), and are saved with the world, keeping their age. A drop is plain data
// {id, count, pos, vel, age, phase, pulled, pickupDelay, wear}; js/entityview.js draws it (spec r15-12).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

// On the planet items keep to the canonical square of the face they lie on (BF.planet.reframe after each move), and the player is
// seen from the item's frame (BF.planet.local), so an item slides across a face edge and is picked up from either side of it.
const LQ = {};
const seenXZ = (a, b) => BF.planet.local(a, b, LQ);
const HW = 0.125, H = 0.25, GRAV = 18, PICKUP_R = 1.6, PICKUP_DELAY = 0.5, LIFE = 300, MAX = 300;
// Picking an item up is a "pickup" request (spec r15-22): the player (in drops.update) and foresters (js/forester.js) ask during the think,
// and the queue gives the item to the first in order: the player first, then villagers by id. Each takes what it has room for, and the
// rest stays on the ground for the next. target: the drop's key "d<n>" (from a counter, per session; not saved), data {}.
// Result {ok, got, left}; refused when the drop is gone (picked up, merged, despawned) or the requester is.
let nextKey = 1;
const byKey = new Map();   // "d<n>" -> drop
let ready = false;
// Clusters (spec r15-39b, C2: js/ctick.js): with the cluster tick on, a drop belongs to the cluster of its region (BF.mobs.cl: the one that
// made it, until the next meeting) and update runs once per cluster over its own drops; keys come from the cluster's id ranges ("d<n>" with
// n from BF.ids.alloc, so they don't hang on the order clusters run in), the toss is seeded by the key instead of the list's length, the
// MAX cap counts the cluster's own drops, and the list is registered with BF.ctick.owned (js/cworkers.js sends each group's drops).
const CL = () => BF.mobs && BF.mobs.cl;
const clOn = () => !!(BF.ctick && BF.ctick.on);
const inPass = () => !!(CL() && CL().owned());
const mineD = d => !inPass() || CL().ownsThing(d, d.pos);
// The running cluster's drops, in list order (update's pass): sorted out by group once an interval and again when the list changes,
// rather than every drop tested in every group's pass (Gordon's test4, 2026-10-29: 299 drops, two thirds in unloaded chunks, 18 passes a
// tick). A drop's base is fixed from the first look of an interval (BF.mobs.cl thingBase), so its group is too: ownsThing's answer.
let ver = 0, byG = null;
function ownDrops() {
  const C = BF.ctick, gs = C.groups();
  if (!C.filter) return drops.list.slice();
  if (!byG || byG.gs !== gs || byG.ver !== ver) {
    byG = { gs, ver, by: new Map() };
    for (const d of drops.list) { const k = CL().groupFor(CL().thingBase(d, d.pos)), a = byG.by.get(k); if (a) a.push(d); else byG.by.set(k, [d]); }
  }
  return byG.by.get(C.cur.key) || [];
}

// An identical stack within a block of d, the first in the list (spec r15-31: from the region index's drops around d; in tests with
// BF.regions.verifyQueries also by the scan of the whole list it replaced).
const mergeable = d => o => o !== d && o.id === d.id && mineD(o) && o.age > 1 && (q => (q.x - d.pos.x) ** 2 + (o.pos.y - d.pos.y) ** 2 + (q.z - d.pos.z) ** 2)(seenXZ(d.pos, o.pos)) < 1;
function mergeWith(d) {
  const R = BF.regions, ok = mergeable(d);
  if (!R || !R.around) return drops.list.find(ok) || null;
  let best = null, bi = Infinity;
  for (const k of R.around(d.pos.x, d.pos.z, 5)) {
    const s = R.dropsIn(k);
    if (s) for (const o of s) if (ok(o)) { const i = drops.list.indexOf(o); if (i >= 0 && i < bi) { bi = i; best = o; } }
  }
  if (R.verifyQueries && R.checkQuery) R.checkQuery("drops.merge", best ? [best] : [], () => { const o = drops.list.find(ok); return o ? [o] : []; });
  return best;
}
const drops = {
  list: [],

  init() { ready = true; ownTables(); },

  // Spawns `count` of item `id` at (x, y, z) with a small random toss. opts.vel (a THREE.Vector3) replaces the toss,
  // and opts.pickupDelay (seconds) holds off the player's pickup, e.g. for items the player threw. opts.wear: uses spent on a dropped tool.
  spawn(id, count, x, y, z, opts) {
    if (!ready || id == null || !BF.items[id] || !(count > 0)) return null;
    const cl = clOn(), n = cl ? +BF.ids.alloc().slice(1) : nextKey++;
    if (cl && inPass()) { let k = 0, first = null; for (const o of drops.list) if (mineD(o)) { if (!first) first = o; k++; } if (k >= MAX) drops.remove(first); }   // (the cluster's own)
    else if (drops.list.length >= MAX) drops.remove(drops.list[0]);
    const r = BF.rand.at("drop", x * 16, z * 16, null, y * 16 + (cl ? n : drops.list.length) * 4099);   // the toss: seeded by the spot, tick and count (with clusters the key) (js/rand.js)
    const a = r.next() * Math.PI * 2, s = 1 + r.next() * 1.5;
    const vel = opts && opts.vel ? opts.vel.clone() : new THREE.Vector3(Math.cos(a) * s, 4 + r.next() * 2, Math.sin(a) * s);
    const d = { key: "d" + n, id, count, pos: new THREE.Vector3(x, y, z), prev: new THREE.Vector3(x, y, z), prevAge: 0, vel, age: 0, phase: Math.random() * 6.28, pulled: false,   // visual (the bob)
      pickupDelay: opts && opts.pickupDelay != null ? opts.pickupDelay : PICKUP_DELAY, wear: (opts && opts.wear) || 0 };
    if (cl) CL().placeThing(d, d.pos);
    drops.list.push(d); ver++;
    byKey.set(d.key, d);
    if (BF.regions) BF.regions.dropAdded(d);   // the region index (js/regions.js)
    return d;
  },

  // Drops items the player couldn't hold (a full inventory when a screen closes, a map made from a stack, a broken
  // furnace's contents) in front of the player, as Minecraft does. Held off from pickup for 2 seconds like a thrown item.
  atPlayer(id, count, wear) {
    const P = BF.player, p = P && P.position;
    if (!p) return null;
    const yaw = P.yaw || 0, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const vel = new THREE.Vector3(fx * 2.5, 2.5, fz * 2.5);
    return drops.spawn(id, count, p.x + fx * 0.3, p.y + 1.3, p.z + fz * 0.3, { vel, pickupDelay: 2, wear });
  },

  // Spawns every stack from BF.rollDrops-style [{id, count}] at the centre of block (x, y, z).
  spawnAt(list, x, y, z) { for (const s of list || []) if (s && s.count > 0) drops.spawn(s.id, s.count, x + 0.5, y + 0.3, z + 0.5); },

  remove(d) {
    const i = drops.list.indexOf(d);
    if (i >= 0) { drops.list.splice(i, 1); ver++; }
    byKey.delete(d.key);
    if (BF.regions) BF.regions.dropRemoved(d);
  },

  clear() { for (const d of drops.list.slice()) drops.remove(d); },

  // -> [[name, count, x, y, z, age, wear, pickupDelay]] for the save (js/save.js). Items are saved by name, like the
  // inventory: filled and auto map ids are handed out fresh each session, so an id would come back as another map.
  serialize() {
    const r = v => Math.round(v * 100) / 100;
    return drops.list.map(d => [BF.items[d.id].name, d.count, r(d.pos.x), r(d.pos.y), r(d.pos.z), r(d.age), d.wear || 0, r(Math.max(0, d.pickupDelay - d.age))]);
  },

  // Puts saved drops back where they lay, at rest and with the age they had. Old saves have none.
  deserialize(a) {
    if (!Array.isArray(a)) return;
    for (const e of a) {
      if (!Array.isArray(e)) continue;
      const [key, count, x, y, z, age, wear, delay] = e;
      if (![x, y, z].every(Number.isFinite)) continue;
      // old saves stored the numeric id: fine for fixed items, but a map's id meant whichever map got it that session
      const id = typeof key === "string" ? BF.resolveItem(key) : key < BF.ITEM_BASE + 0x10000 ? key : undefined;
      const d = drops.spawn(id, count, x, y, z, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 0, wear: wear || 0 });
      if (!d) continue;
      d.age = Math.max(0, +age || 0);
      d.pickupDelay = d.age + Math.max(0, +delay || 0);
      d.prev.copy(d.pos); d.prevAge = d.age;
    }
  },

  update(dt) {
    const P = BF.player, c = inPass(), pp = c ? CL().playerPos() : P && P.position, alive = c ? CL().playerLives() : P && !P.dead;   // (clusters: the player as the running cluster sees it)
    for (const d of c ? ownDrops() : drops.list.slice()) {   // (clusters: the running cluster's drops)
      d.prev.copy(d.pos); d.prevAge = d.age; d.pulled = false;   // drawn between this and where the tick leaves it (js/entityview.js)
      // in an unloaded chunk an item neither ages nor falls (it would drop out of the world); it waits for the chunk
      if (!BF.world.isLoaded(d.pos.x, d.pos.z)) continue;
      d.age += dt;
      if (d.age > LIFE) { drops.remove(d); continue; }
      // pulled toward the player once close enough, then collected
      if (alive && d.age > d.pickupDelay && pp) {
        const q = seenXZ(d.pos, pp), dx = q.x - d.pos.x, dy = pp.y + 0.6 - d.pos.y, dz = q.z - d.pos.z, dist = Math.hypot(dx, dy, dz);
        if (dist < 0.6) {   // collected: asks for it (applied after the think, before anyone else's ask for it)
          if (!d.wantP || BF.rand.tick - d.wantP.tick > 2) drops.ask(d, "player");
          continue;
        } else if (dist < PICKUP_R) {
          const k = 10 / dist;
          d.vel.set(dx * k * 0.6, dy * k * 0.6, dz * k * 0.6);
          d.pos.addScaledVector(d.vel, dt);
          d.pulled = true;
          BF.planet.reframe(d.pos, -1, null, d.vel);
          continue;
        }
      }
      // merge with an identical stack lying nearby
      if (d.age > 1 && (Math.floor(d.age * 4) % 4 === 0)) {
        const o = mergeWith(d);
        if (o && o.count + d.count <= (BF.items[d.id].stack || 64)) { o.count += d.count; drops.remove(d); continue; }
      }
      d.vel.y -= GRAV * dt;
      const res = BF.world.moveBox(d.pos, d.vel, HW, H, dt);
      BF.planet.reframe(d.pos, -1, null, d.vel);   // past a face edge: onto the next face's square
      if (res.onGround) { d.vel.x *= Math.pow(0.02, dt); d.vel.z *= Math.pow(0.02, dt); }
      if (d.pos.y < BF.MIN_Y - 10) { drops.remove(d); continue; }
    }
  },

  get: key => byKey.get(key),
  // Asks for drop d for `from` (a mob, its id, or "player"): a "pickup" request; returns it. The player's ask is remembered on the drop
  // (wantP) so that it applies before any villager's that tick.
  ask(d, from) {
    const req = BF.req.send("pickup", d.key, {}, from);
    if (req.from === "player") d.wantP = req;
    return req;
  },
};

BF.drops = drops;

// the drops by group (BF.ctick.owned, registered at init): plain [key, id, count, pos, vel, age, pickupDelay, wear, base cluster]
const V = v => [v.x, v.y, v.z];
function ownTables() {
  const C = BF.ctick;
  if (!C || ownTables.done) return;
  ownTables.done = true;
  const G = (d, g) => CL().groupFor(CL().thingBase(d, d.pos)) === g;   // (thingBase: a drop no pass here has seen yet, restored from a save, too)
  C.owned("drops", {
    snap: g => drops.list.filter(d => G(d, g)).map(d => [d.key, d.id, d.count, V(d.pos), V(d.vel), d.age, d.pickupDelay, d.wear || 0, CL().clOf(d)]),
    apply(g, a) {
      for (const d of drops.list.slice()) if (G(d, g)) drops.remove(d);
      for (const [key, id, count, p, v, age, delay, wear, cl] of a || []) {
        const d = { key, id, count, pos: new THREE.Vector3(p[0], p[1], p[2]), prev: new THREE.Vector3(p[0], p[1], p[2]), prevAge: age, vel: new THREE.Vector3(v[0], v[1], v[2]), age,
          phase: Math.random() * 6.28, pulled: false, pickupDelay: delay, wear };   // visual (phase: the bob)
        CL().keepThing(d, cl);
        drops.list.push(d);
        byKey.set(key, d);
        if (BF.regions) BF.regions.dropAdded(d);
      }
    },
  });
}

function take(req, d) {
  if (!d || !byKey.has(d.key)) return { ok: false, why: "gone" };
  let left;
  if (req.from === "player") {
    const P = BF.player;
    if (!P || P.dead) return { ok: false, why: "requester gone" };
    left = BF.inventory.add(d.id, d.count, d.wear);
  } else {
    const m = BF.ids && BF.ids.get(req.from);
    if (!m || m.removed || m.dead || !Array.isArray(m.inv)) return { ok: false, why: "requester gone" };
    left = BF.trades.inv.add(m.inv, d.id, d.count, d.wear);
  }
  const got = d.count - left;
  if (left <= 0) drops.remove(d); else d.count = left;
  return got > 0 ? { ok: true, id: d.id, got, left } : { ok: false, why: "no room", left };
}
if (BF.req) BF.req.on("pickup", req => {
  if (req.pre) return req.pre;   // the player's, applied ahead of a villager's ask for the same item (below)
  const d = byKey.get(String(req.target)), p = d && d.wantP;
  if (p) d.wantP = null;
  if (p && p !== req && p.result === undefined) p.pre = take(p, d);   // the player's ask this tick goes first
  const r = take(req, d);
  if (r.why === "gone" && req.from !== "player" && BF.glog) {   // game log: a villager lost an item to someone who picked it up first
    const m = BF.ids && BF.ids.get(req.from);
    BF.glog.log("INFO", "requests", (m && BF.vlog ? BF.vlog.nameOf(m) : "A villager") + " reached an item that was already gone (picked up first, or merged into another)", { at: m, village: m && m.village });
  }
  return r;
});
})();
