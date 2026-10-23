// Shared herding helpers (BF.herd): the parts of a farm animal's life that are the same for every kind a villager keeps in a fenced pen.
// Loaded before js/cowherd.js; used by js/cowherd.js (cows) and js/pigfarmer.js (pigs). See CONTRACT.md "Cowherds" and "Pig farmers".
//  - follow: walk towards a point (a mate, the player holding food, the herder) and stop short of it.
//  - findMate / mateStep: a willing adult looks for a willing adult of its kind and pen within reach and walks to it; they breed when close.
//    No breeding while LOCAL_MAX (24) or more of that kind stand within LOCAL_R (16) blocks (crowding).
//  - growK: how grown a young animal is (0 newborn .. 1 adult) from its `growAt` (absolute game day it grows up) and the days it takes;
//    BF.mobs.setYoungSize(m, k, headScale) scales its model (js/mobs.js).
//  - Leading an animal home: the herder (lead) walks a trail of crumbs to the path in front of the pen's gate and holds the gate open; the
//    animal (ledStep) walks the trail behind it, then in through the gate to the middle of the pen. Gates held open are shut once nothing
//    stands in them (releaseGate / shutGates).
// Nothing here creates, removes or saves an animal: each module keeps its own state, pens and saves.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const LOCAL_MAX = 24, LOCAL_R = 16;   // no breeding when this many of a kind are already within this many blocks
const rnd = (m, a, b) => BF.rand.of(m).range(a, b);   // the mob's seeded stream (js/rand.js)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const live = o => !!(o && !o.dead && !o.removed);
const mid = m => +String(m.id).slice(1);   // the mob's stable id number (js/ids.js): which of a pair breeds (r15-23)

// On the planet animals and their herders may be kept in different frames near a face edge (js/mobs.js keepFrame): positions are compared
// as seen from the animal (BF.planet.local), so offsets are true local ones across an edge.
const LQ = {};
const seenXZ = (a, b) => BF.planet.local(a, b, LQ);

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
  let best = null, bd = r * r, near = 0;
  const mp = pen(m);
  for (const o of BF.mobs.list) {
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
  let n = 0;
  for (const o of BF.mobs.list) if (o.type === m.type && live(o) && (q => Math.hypot(q.x - m.position.x, q.z - m.position.z))(seenXZ(m.position, o.position)) < LOCAL_R) n++;
  return n;
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
    const g = toShut[i], [x, y, z] = g.at, bk = BF.world.isLoaded(x, z) ? BF.blocks[BF.world.getBlock(x, y, z)] : null;
    if (!bk || !bk.gate || !bk.gate.open || BF.simNow() - g.t > 120) { toShut.splice(i, 1); continue; }
    if ((BF.mobs.isOccupied && BF.mobs.isOccupied(x, y, z)) || (live(g.m) && Math.hypot(x + 0.5 - g.m.position.x, z + 0.5 - g.m.position.z) < 1.5)) continue;
    BF.world.setGate(x, y, z, false); toShut.splice(i, 1);
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
    if (bk && bk.gate && Math.hypot(gx + 0.5 - p.x, gz + 0.5 - p.z) < 3) { if (!bk.gate.open) BF.world.setGate(gx, gy, gz, true); S.gateHeld = [gx, gy, gz]; }
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

BF.herd = { LOCAL_MAX, LOCAL_R, mid, follow, findMate, crowd, mateStep, growK, ledStep, lead, startLead, releaseGate, shutGates, toShut, reset };
})();
