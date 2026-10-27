// Shared herding helpers (BF.herd): the parts of a farm animal's life that are the same for every kind a villager keeps in a fenced pen.
// Loaded before js/cowherd.js; used by js/cowherd.js (cows) and js/pigfarmer.js (pigs). See CONTRACT.md "Cowherds" and "Pig farmers".
//  - follow: walk towards a point (a mate, the player holding food, the herder) and stop short of it.
//  - findMate / mateStep: a willing adult looks for a willing adult of its kind and pen within reach and walks to it; they breed when close.
//    No breeding while LOCAL_MAX (24) or more of that kind stand within LOCAL_R (16) blocks (crowding).
//  - birthSpot(a, b): where a pair's young is born, halfway between them through a face edge.
//  - growK: how grown a young animal is (0 newborn .. 1 adult) from its `growAt` (absolute game day it grows up) and the days it takes;
//    BF.mobs.setYoungSize(m, k, headScale) scales its model (js/mobs.js).
//  - Leading an animal home: the herder (lead) walks a trail of crumbs to the path in front of the pen's gate and holds the gate open; the
//    animal (ledStep) walks the trail behind it, then in through the gate to the middle of the pen. Gates held open are shut once nothing
//    stands in them (releaseGate / shutGates).
// Nothing here creates, removes or saves an animal: each module keeps its own state, pens and saves.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const LOCAL_MAX = 24, LOCAL_R = 16;   // no breeding when this many of a kind are already within this many blocks
const rnd = (m, a, b) => BF.rand.of(m).range(a, b);   // the mob's seeded stream (js/rand.js)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const live = o => !!(o && !o.dead && !o.removed);
const mid = m => +String(m.id).slice(1);   // the mob's stable id number (js/ids.js): which of a pair breeds (r15-23)

// On the planet animals and their herders may be kept in different frames near a face edge (js/mobs.js keepFrame): positions are compared
// as seen from the animal (BF.planet.local), so offsets are true local ones across an edge.
const LQ = {};
const seenXZ = (a, b) => BF.planet.local(a, b, LQ);
// Where a pair's young is born: halfway between them, b seen from a across a face edge (bug-089: the raw atlas midpoint of a pair astride
// an edge is far round the planet), on the canonical square of the face it falls on. -> {x, y, z}
const BS = {};
function birthSpot(a, b) {
  const P = BF.planet, q = P.local(a.position, b.position, LQ);
  const x = (a.position.x + q.x) / 2, z = (a.position.z + q.z) / 2, c = P.canon(x, z, BS);
  return c.off ? { x, y: Math.max(a.position.y, b.position.y), z } : { x: c.x, y: Math.max(a.position.y, b.position.y), z: c.z };
}

// ---------------------------------------------------------------- walking
// Sets out to walk m towards (tx, tz) at `speed`, facing it once within `stop`. Always true (the caller's AI handled this step).
function follow(m, dt, out, tx, tz, stop, speed) {
  const dx = tx - m.position.x, dz = tz - m.position.z, d = Math.hypot(dx, dz);
  m.ai.mode = "idle"; m.ai.t = 1;
  if (d < stop) { out.faceX = tx; out.faceZ = tz; return true; }
  out.x = dx / d * speed; out.z = dz / d * speed;
  return true;
}

// ---------------------------------------------------------------- breeding
// The nearest willing mate for m: same type, same pen (pen(o) === pen(m); wild ones have none), within r blocks and 2 of height. null when the
// place is crowded (LOCAL_MAX of its kind within LOCAL_R blocks).
function findMate(m, t, willing, pen, r) {
  const M = BF.mobs, scan = L => mateIn(L, m, t, willing, pen, r);
  return M.checkScan("herd.findMate", scan(M.near(m.position, Math.max(r, LOCAL_R), true)), scan);
}
function mateIn(L, m, t, willing, pen, r) {
  let best = null, bd = r * r, near = 0;
  const mp = pen(m);
  for (const o of L) {
    if (o.type !== m.type || !live(o)) continue;
    const q = seenXZ(m.position, o.position), dx = q.x - m.position.x, dz = q.z - m.position.z, d2 = dx * dx + dz * dz;
    if (d2 < LOCAL_R * LOCAL_R) near++;
    if (o === m || pen(o) !== mp || !willing(o, t) || Math.abs(o.position.y - m.position.y) > 2) continue;
    if (d2 < bd) { bd = d2; best = o; }
  }
  return near >= LOCAL_MAX ? null : best;
}
// How many of m's kind stand within LOCAL_R blocks of it (m too).
function crowd(m) {
  const M = BF.mobs, scan = L => L.filter(o => o.type === m.type && live(o) && (q => Math.hypot(q.x - m.position.x, q.z - m.position.z))(seenXZ(m.position, o.position)) < LOCAL_R);
  return M.checkScan("herd.crowd", scan(M.near(m.position, LOCAL_R, true)), scan).length;
}
// One AI step of a willing adult: looks for a mate now and then (c.find(m, t)), walks to it and breeds (c.breed(a, b, t)) once within c.meet.
// Gives up after 30 s or when the mate gets more than c.mateR + 4 away. c = {willing(m, t), find(m, t), breed(a, b, t), mateR, meet}.
// Returns true when it moved m.
function mateStep(m, dt, out, t, c) {
  if (!c.willing(m, t)) { m.mate = null; return false; }
  m.mateT = (m.mateT || 0) - dt;
  if (m.mate && (!live(m.mate) || !c.willing(m.mate, t))) m.mate = null;
  if (!m.mate) {
    if (m.mateT > 0) return false;
    m.mateT = rnd(m, 1, 2);
    m.mate = c.find(m, t);
    if (!m.mate) return false;
    m.mateSeek = 0;
  }
  const o = m.mate, q = seenXZ(m.position, o.position), dx = q.x - m.position.x, dz = q.z - m.position.z, d = Math.hypot(dx, dz), sp = m.def.speed;
  m.mateSeek += dt;
  if (d > c.mateR + 4 || m.mateSeek > 30) { m.mate = null; m.mateT = rnd(m, 6, 10); return false; }
  m.ai.mode = "idle"; m.ai.t = 1; m.lookAt = o;
  if (d < c.meet) { if (mid(m) < mid(o)) c.breed(m, o, t); return true; }
  out.x = dx / d * sp; out.z = dz / d * sp;
  return true;
}
// How grown a young animal is: 0 at birth .. 1 grown up (growAt: absolute game day it grows up, null for an adult; days: how long it takes).
const growK = (growAt, t, days) => (growAt != null ? clamp(1 - (growAt - t) / days, 0, 1) : 1);

// ---------------------------------------------------------------- leading an animal home
// Gates a herder held open for an animal are shut as soon as nothing stands in them (and the herder is out of the way).
const toShut = [];
function shutGates() {
  for (let i = toShut.length - 1; i >= 0; i--) {
    if (!ownsMob(toShut[i].m)) continue;   // (clusters: another group's herder's gate)
    const g = toShut[i], [x, y, z] = g.at, bk = BF.world.isLoaded(x, z) ? BF.blocks[BF.world.getBlock(x, y, z)] : null;
    if (!bk || !bk.gate || !bk.gate.open || BF.simNow() - g.t > 120) { toShut.splice(i, 1); continue; }
    if ((BF.mobs.isOccupied && BF.mobs.isOccupied(x, y, z)) || (live(g.m) && Math.hypot(x + 0.5 - g.m.position.x, z + 0.5 - g.m.position.z) < 1.5)) continue;
    BF.blockReq.door(g.m, x, y, z, false);   // a request (spec r15-19, js/blockreqs.js); kept until the gate is seen shut, as a close is refused if an animal steps in
  }
}
// The herder's task ended: the gate it held (S.gateHeld) is shut once clear.
function releaseGate(m, S) {
  if (!S.gateHeld) return;
  toShut.push({ at: S.gateHeld, m, t: BF.simNow() }); S.gateHeld = null; shutGates();
}
// The led animal's step (m.ledBy = the herder; S = the herder's state {task: {kind: "fetch", mob}, stage, trail, trailBase}; P = the pen with
// its gate [x, z] and field x0..z1; inRoom(P, pos)). It walks the herder's trail (crumbs every 0.6 blocks, through gates); at the gate it goes
// in by itself and on to the middle of the pen. Returns false (and lets go: m.ledBy = null) when it is no longer being led.
function ledStep(m, dt, out, S, P, inRoom) {
  const L = m.ledBy, tk = S && S.task, sp = m.def.speed;
  if (!live(L) || !tk || tk.mob !== m || tk.kind !== "fetch" || S.stage === "walk" || !P) { m.ledBy = null; return false; }
  const tr = S.trail, k0 = S.trailBase;
  let ci = Math.max(m.crumb || 0, k0);
  const crumb = c => seenXZ(m.position, { x: c[0], z: c[2] });   // trail crumbs are in the herder's frame
  while (ci < k0 + tr.length - 1 && (q => Math.hypot(q.x - m.position.x, q.z - m.position.z))(crumb(tr[ci - k0])) < 0.8) ci++;
  m.crumb = ci;
  const lp = { ...seenXZ(m.position, L.position) }, dk = Math.hypot(lp.x - m.position.x, lp.z - m.position.z);
  if (S.stage === "pen") {   // the herder waits outside with the gate open: in through the gate, then to the middle of the pen
    const [gx, gz] = P.gate, inG = Math.abs(m.position.x - gx - 0.5) < 0.6 && Math.abs(m.position.z - gz - 0.5) < 0.6;
    m.penIn = m.penIn || inG || inRoom(P, m.position);
    if (!m.penIn && P.viaOut && !m.atOut) {   // first onto the cell in front of the gate (a pen whose gate is in a fence corner's lee, js/pigfarmer.js)
      const [ox, oz] = P.out;
      if (Math.hypot(m.position.x - ox - 0.5, m.position.z - oz - 0.5) < 0.6) m.atOut = true;
      else return follow(m, dt, out, ox + 0.5, oz + 0.5, 0.2, sp);
    }
    return m.penIn ? follow(m, dt, out, (P.x0 + P.x1) / 2, (P.z0 + P.z1) / 2, 0.8, sp) : follow(m, dt, out, gx + 0.5, gz + 0.5, 0.2, sp);
  }
  m.penIn = false; m.atOut = false;
  m.lookAt = L;
  if (ci >= k0 + tr.length - 1 || dk < 2.6) return follow(m, dt, out, lp.x, lp.z, 1.8, sp * 1.2);
  const c = crumb(tr[ci - k0]);
  return follow(m, dt, out, c.x, c.z, 0.25, sp * 1.25);
}
// The herder's step while leading tk.mob home to pen c.pen ({gate, out [x, z] the path cell in front of the gate, y ground}): to the path in
// front of the gate, then it holds the gate open while the animal goes in. It waits when the animal falls behind and goes back for it when it
// does not come. c = {pen, max (seconds), penned(o) (it is in), arrived(), failed(why, d), stand ([x, z], optional)}: arrived / failed end the task. Returns true while
// it is leading (it set out), false once the task ended.
function lead(m, S, tk, dt, out, c) {
  const o = tk.mob, P = c.pen, p = m.position, op = { ...seenXZ(p, o.position) };
  const dk = Math.hypot(op.x - p.x, op.z - p.z);
  S.lostT = dk > 16 ? (S.lostT || 0) + dt : 0;
  if (S.lostT > 10 || S.t > c.max) { c.failed(S.lostT > 10 ? "lost" : "slow", dk); return false; }
  if (c.penned(o)) { c.arrived(); return false; }
  const last = S.trail[S.trail.length - 1];
  if (!last || Math.hypot(last[0] - p.x, last[2] - p.z) > 0.6) { S.trail.push([p.x, p.y, p.z]); if (S.trail.length > 60) { S.trail.shift(); S.trailBase++; } }
  if (P.gate) {   // hold the gate open while the animal is on its way in
    const [gx, gz] = P.gate, gy = P.y + 1, bk = BF.blocks[BF.world.getBlock(gx, gy, gz)];
    if (bk && bk.gate && Math.hypot(gx + 0.5 - p.x, gz + 0.5 - p.z) < 3) { if (!bk.gate.open) BF.blockReq.door(m, gx, gy, gz, true); S.gateHeld = [gx, gy, gz]; }
    if (bk && bk.gate && bk.gate.open) {   // not shut behind it: by its own walking (mobs.js villagerDoors) or an earlier fetch's pending close
      S.gateHeld = [gx, gy, gz];
      if (m.ai.doors) m.ai.doors = m.ai.doors.filter(([x, y, z]) => !(x === gx && y === gy && z === gz));
      for (let i = toShut.length - 1; i >= 0; i--) { const a = toShut[i].at; if (a[0] === gx && a[1] === gy && a[2] === gz) toShut.splice(i, 1); }
    }
  }
  if (S.stage === "pen") {   // at the gate: the animal walks in by itself (ledStep) while the herder holds the gate open
    m.ai.route = null; out.faceX = op.x; out.faceZ = op.z; m.lookAt = o;
    if ((S.inT = (S.inT || 0) + dt) > 20) { S.stage = "lead"; S.inT = 0; S.trail = [[p.x, p.y, p.z]]; S.trailBase = 0; o.crumb = 0; }   // it wandered off: lead it back to the gate
    return true;
  }
  if (dk > 5.5) {   // wait for it; if it doesn't come (caught behind something), go back for it and start the trail again from there
    m.ai.route = null; out.faceX = op.x; out.faceZ = op.z; m.lookAt = o;
    if ((S.waitT = (S.waitT || 0) + dt) > 8) { S.waitT = 0; S.stage = "walk"; S.gx = null; o.ledBy = null; }
    return true;
  }
  S.waitT = 0;
  const at = c.stand || P.out;   // where it waits: in front of the gate, or (c.stand) beside that cell so the animal has the way in to itself
  const st = BF.villageLife.travel(m, S, dt, out, at[0], P.y + 1, at[1], m.def.speed * 0.8);
  if (st === "arrived" && c.stand && (Math.floor(p.x) !== at[0] || Math.floor(p.z) !== at[1]) && (S.standT = (S.standT || 0) + dt) < 3) {
    // travel stops within a cell of the goal, which can be beside the gate's front cell, in the animal's way: step onto the stand itself
    m.ai.route = null;
    const dx = at[0] + 0.5 - p.x, dz = at[1] + 0.5 - p.z, d = Math.hypot(dx, dz) || 1, sp = m.def.speed * 0.6;
    out.x = dx / d * sp; out.z = dz / d * sp;
    return true;
  }
  if (st === "arrived") { m.ai.route = null; S.standT = 0; if (dk < 3.2) { S.stage = "pen"; S.inT = 0; } else { out.faceX = op.x; out.faceZ = op.z; m.lookAt = o; } }
  else if (st === "failed") { c.failed("nopath", dk); return false; }
  return true;
}
// Starts leading: the herder reached the animal (tk.mob).
function startLead(m, S, tk) {
  S.stage = "lead"; S.standT = 0; tk.mob.ledBy = m; tk.mob.crumb = 0; S.trail = [[m.position.x, m.position.y, m.position.z]]; S.trailBase = 0; m.ai.route = null;
}
function reset() { toShut.length = 0; }

// ---------------------------------------------------------------- clusters (spec r15-39b item C4, js/ctick.js)
// With the cluster tick on, the animal systems (js/shepherd.js, js/poultry.js, js/cowherd.js, js/pigfarmer.js, js/horses.js, js/stables.js,
// js/bees.js) run once per cluster group, each touching only its group's mobs, village records and places. What they share:
//   cluster()        the cluster tick while a group runs (js/ctick.js), else null: the systems then run as before, on the whole world;
//   ownsVillage(k)   village k's record is the running group's;  ownsAt(x, z): the place at (x, z) is (its region's cluster);
//   ownsMob(m)       mob m is (by its cluster, m.cl);
//   every(n)         true once every n ticks by the tick counter, the same in every group and order (timers kept in the module would run
//                    once per group, and a group's own are new at each meeting);
//   gateTable(name, list)  registers a list of gates to shut ({at, m, t}) with BF.ctick.owned, by the cluster of the mob that held the gate;
//   villageTable(name, get)  registers a Map keyed by village key (save data waiting for its pens...) with BF.ctick.owned;
//   penTable(name, o)  registers the stock of pens kept in a hidden field of the village record (see below).
// Every group always true without the cluster tick.
const cluster = () => { const C = BF.ctick; return C && C.on && C.filter ? C : null; };   // (null too in a system not converted yet: it sees everything)
const ownsVillage = k => { const C = cluster(); return !C || BF.clusters.groupOf("v:" + k) === C.cur.key; };
const ownsAt = (x, z) => { const C = cluster(); return !C || BF.clusters.groupOf(BF.clusters.ofRegion(BF.regions.keyOf(x, 0, z))) === C.cur.key; };
const ownsMob = m => { const C = cluster(); return !C || !m || C.mine(m); };
const every = n => BF.rand.tick % n === 1 % n;
// (the multi-worker runtime, js/cworkers.js, sends each group's part of these at meetings; one worker never uses them)
const ofGroup = (m, gk) => !!m && m.cl !== undefined && BF.clusters.groupOf(m.cl) === gk;
function gateTable(name, list) {
  if (!BF.ctick || !BF.ctick.owned) return;
  BF.ctick.owned(name, {
    snap: gk => list.filter(g => ofGroup(g.m, gk)).map(g => ({ at: g.at.slice(), m: g.m.id, t: g.t })),
    apply(gk, a) {
      for (let i = list.length - 1; i >= 0; i--) if (ofGroup(list[i].m, gk)) list.splice(i, 1);
      for (const g of a || []) { const m = BF.ids.live(g.m); if (m) list.push({ at: g.at, m, t: g.t }); }
    },
  });
}
function villageTable(name, get) {
  if (!BF.ctick || !BF.ctick.owned) return;
  const mine = (k, gk) => BF.clusters.groupOf("v:" + k) === gk;
  BF.ctick.owned(name, {
    snap(gk) { const o = {}; for (const [k, v] of get()) if (mine(k, gk)) o[k] = v; return JSON.parse(JSON.stringify(o)); },
    apply(gk, o) { const M = get(); for (const k of [...M.keys()]) if (mine(k, gk)) M.delete(k); for (const k in o || {}) M.set(k, o[k]); },
  });
}
// The stock of a village's pens: the animal states in each pen, each also the state of its mob (m.cow and the pasture's cows hold one
// object). Sent as a table at meetings, and the receiver links each state to its mob again: the record and mob diffs would leave two
// copies. Pens kept in a hidden field of the record (not enumerable: js/cowherd.js _pastures, js/pigfarmer.js _sties) don't travel with
// the record at all. o = {field ("_pastures"), list ("cows": the animal states), mob ("cow": the mob's state field), pen ("pasture": the
// mob's pen link), of(rec) -> the record's pens}.
function penTable(name, o) {
  if (!BF.ctick || !BF.ctick.owned) return;
  BF.ctick.owned(name, {
    snap(gk) {
      const out = {};
      for (const rec of BF.mobs.villages.values()) {
        if (!rec[o.field] || BF.clusters.groupOf("v:" + rec.key) !== gk) continue;
        out[rec.key] = rec[o.field].filter(p => p[o.list]).map(p => ({ idx: p.idx, list: p[o.list].map(s => Object.assign({}, s)), culls: p.culls }));
      }
      return JSON.parse(JSON.stringify(out));
    },
    apply(gk, a) {
      for (const k in a || {}) {
        const rec = BF.mobs.villages.get(k);
        if (!rec) { lost(name, "village " + k); continue; }
        const ps = o.of(rec);
        for (const e of a[k]) {
          const p = ps.find(q => q.idx === e.idx);
          if (!p) { lost(name, "pen " + e.idx + " of village " + k); continue; }
          p[o.list] = e.list.map(s => BF.ids.refs(s));
          if (e.culls !== undefined) p.culls = e.culls;
          for (const s of p[o.list]) { const m = s.mobId != null ? BF.ids.live(s.mobId) : null; if (m) { m[o.mob] = s; m[o.pen] = p; } }   // (one state object, as on the owner)
        }
      }
    },
  });
}
// A table's part for something this worker doesn't have: an ERROR (kind clusters), once per table
const lostSeen = new Set();
function lost(name, what) {
  if (lostSeen.has(name) || !BF.glog) return;
  lostSeen.add(name);
  BF.glog.log("ERROR", "clusters", "Another worker sent " + name + " for " + what + ", which this worker doesn't have: its animals there may not match");
}
// The gates the herders (cowherds, pig farmers) held open: shut by each group for its own herders (js/cowherd.js, js/pigfarmer.js tick)
let tabled = false;
function tables() { if (!tabled && BF.ctick) { tabled = true; gateTable("herd.toShut", toShut); } }

BF.herd = { LOCAL_MAX, LOCAL_R, mid, birthSpot, follow, findMate, crowd, mateStep, growK, ledStep, lead, startLead, releaseGate, shutGates, toShut, reset,
  cluster, ownsVillage, ownsAt, ownsMob, every, gateTable, villageTable, penTable, tables, lost };
})();
