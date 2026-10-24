// @ci integration suite=village timeout=420 hosts=worker,server
// Mob-on-mob effects and claims as requests (spec r15-23): NODE_PATH=$(npm root -g) node test/run.js /tmp/cr test/claim-requests.js [--host page|worker|server]
// Each case sends from a scripted think (inside BF.mobs.update during BF.simStep), in an order opposite to id order, and runs twice:
// - two villagers claim one free bed in one tick: the lower id gets it, the other is refused, nobody else's bed changes;
// - a zombie and an iron golem hit one villager in one tick: the hits apply in attacker-id order. Zombie first: both land (a golem's
//   hit ignores the invulnerability the zombie's leaves) and the golem's push is the one left. Golem first: the zombie's hit is refused
//   by the invulnerability the golem's left. With low hp the kill goes to whichever attacker is lower;
// - a villager killed in a tick has its own request of that tick (a block edit) refused, and the block stays;
// - two sheep pairs breed in one tick: the lambs' ids follow the parents' ids, and a sheep can't have two lambs in one tick;
// - a creeper's blast is one request: refused when a lower-id attacker kills the creeper first in the same tick.
// The outcomes are the same on both runs.
module.exports = async (pg) => {
  const lib = require('./lib');
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await lib.sim(pg, () => BF.sky.setTime(0.25));
  await lib.toVillage(pg);
  const fails = [];
  const check = (ok, what, info) => { console.log((ok ? "ok   " : "FAIL ") + what + (ok || info === undefined ? "" : " " + JSON.stringify(info))); if (!ok) fails.push(what); };

  const run = () => lib.sim(pg, () => {   // (where the simulation is: spec r15-43)
    BF.state.paused = true;   // ticks by hand
    const M = BF.mobs, W = BF.world, step = () => BF.simStep(BF.warp.TICK), n = s => +String(s).slice(1), res = {};
    M.spawning = false;
    // one scripted think: fn() runs inside the mobs' update of the next tick
    const think = fn => {
      const up = M.update;
      M.update = function () { M.update = up; const r = up.apply(this, arguments); fn(); return r; };
      try { step(); } finally { M.update = up; }
    };
    const P = BF.player.position, rec = BF.vlog.villageAt(P.x, P.z);
    if (!rec) return { err: "no village" };

    // ---- beds: a new bed beside the village centre, claimed by two villagers in the same tick
    const foot = BF.blocks.findIndex(b => b && b.bed && !b.bed.head && b.bed.f === 0), head = BF.blocks.findIndex((b, i) => b && b.bed && b.bed.head && b.bed.f === 0 && BF.blocks[foot].name.split("_")[0] === b.name.split("_")[0]);
    const [fx, fz] = BF.DIRS[0];
    let bed = null;
    for (let i = 0; i < 40 && !bed; i++) {
      const x = Math.floor(rec.x) + 3 + (i % 8), z = Math.floor(rec.z) + 3 + Math.floor(i / 8), y = W.heightAt(x, z) + 1;
      if (W.getBlock(x, y, z) || W.getBlock(x + fx, y, z + fz) || W.getBlock(x, y + 1, z) || W.getBlock(x + fx, y + 1, z + fz) || W.heightAt(x + fx, z + fz) + 1 !== y) continue;
      W.setBlock(x, y, z, foot); W.setBlock(x + fx, y, z + fz, head);
      bed = { x, y, z, f: 0 };
    }
    if (!bed) return { err: "no spot for a bed" };
    BF.breeding.scanBeds(rec);
    res.bedFreeBefore = BF.breeding.bedFree(rec, bed, null);
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && !m.removed && !m.child && !m.sleeping).sort((a, b) => n(a.id) - n(b.id));
    if (vs.length < 3) return { err: "too few villagers" };
    const lo = vs[0], hi = vs[vs.length - 1], key = "b:" + bed.x + "," + bed.y + "," + bed.z;
    const others = vs.slice(1, -1).map(m => [m.id, m.bed ? m.bed.x + "," + m.bed.y + "," + m.bed.z : null]);
    const got = {};
    think(() => { for (const m of [hi, lo]) got[m.id] = BF.claims.ask("bed", m, key, { bed }); });
    const has = m => !!(m.bed && m.bed.x === bed.x && m.bed.y === bed.y && m.bed.z === bed.z);
    res.beds = { pending: got[lo.id] === "pending" && got[hi.id] === "pending", lo: has(lo), hi: has(hi),
      othersSame: others.every(([id, b]) => { const m = BF.ids.get(id); return (m.bed ? m.bed.x + "," + m.bed.y + "," + m.bed.z : null) === b; }) };
    const st = BF.req.stats().byKind.claim;
    res.claimRefused = st ? st.refused : 0;
    // give it back for the next run
    lo.bed = null; W.setBlock(bed.x, bed.y, bed.z, 0); W.setBlock(bed.x + fx, bed.y, bed.z + fz, 0); BF.breeding.scanBeds(rec);

    // ---- a zombie and a golem hit one villager in one tick
    const at = [P.x + 6, W.heightAt(Math.floor(P.x + 6), Math.floor(P.z + 6)) + 1, P.z + 6];
    const hits = order => {
      const made = order.map(t => M.spawn(t, at[0] + (t === "zombie" ? -1.2 : 1.2), at[1], at[2]));   // spawned in this order: ids follow it
      const v = M.spawn("villager", at[0], at[1], at[2]);
      const z = made.find(m => m.type === "zombie"), g = made.find(m => m.type === "iron_golem");
      const out = {};
      // 1) plenty of hp: both hits land (the golem's ignores invulnerability) in id order, knockback summed in that order
      v.hp = 20; v.invuln = 0; v.vel.set(0, 0, 0);
      think(() => { M.strike(g, v, 3, new THREE.Vector3(-1, 0, 0)); M.strike(z, v, 3, new THREE.Vector3(1, 0, 0)); });
      out.hp = v.hp; out.velX = +v.vel.x.toFixed(3); out.velY = +v.vel.y.toFixed(3); out.attacker = v.attacker ? v.attacker.type : null;
      // 2) low hp: the first in id order kills it, the other is refused; its own block edit of that tick is refused too
      v.hp = 2; v.invuln = 0;
      const bx = Math.floor(at[0]) + 2, bz = Math.floor(at[2]) + 2, by = W.heightAt(bx, bz), was = W.getBlock(bx, by, bz);
      let edit = null;
      think(() => {
        BF.req.send("setBlock", bx + "," + by + "," + bz, { id: 0, expect: was }, v).then(r => { edit = r; });
        M.strike(g, v, 5, null); M.strike(z, v, 5, null);
      });
      step();
      out.dead = v.dead; out.cause = v.lastHurt; out.firstId = n(z.id) < n(g.id) ? "zombie" : "golem";
      out.edit = edit; out.blockKept = W.getBlock(bx, by, bz) === was;
      for (const m of [z, g, v]) M.discard(m);
      return out;
    };
    res.hitsZ = hits(["zombie", "iron_golem"]);   // zombie lower
    res.hitsG = hits(["iron_golem", "zombie"]);   // golem lower

    // ---- two sheep pairs breed in one tick; a third sheep tries the first pair's ewe too
    const t = BF.sky.day + BF.sky.time, sp = (dx, dz) => M.spawn("sheep", at[0] + dx, at[1], at[2] + dz);
    const a1 = sp(-3, 0), b1 = sp(-3, 1), a2 = sp(3, 0), b2 = sp(3, 1), c = sp(-2, 0);
    for (const s of [a1, b1, a2, b2, c]) BF.shepherd.feed(s);
    const before = new Set(M.list.map(m => m.id));
    think(() => { BF.shepherd.breed(a2, b2, t); BF.shepherd.breed(c, b1, t); BF.shepherd.breed(a1, b1, t); });
    const lambs = M.list.filter(m => m.type === "sheep" && !before.has(m.id)).sort((x, y) => n(x.id) - n(y.id));
    res.lambs = lambs.map(l => ({ id: l.id, x: +l.position.x.toFixed(1) }));
    res.sheepIds = [a1, b1, a2, b2, c].map(s => s.id);
    res.lambOrder = lambs.length === 2 && lambs[0].position.x < at[0] && lambs[1].position.x > at[0];   // a1's (lower ids) lamb first
    for (const m of [a1, b1, a2, b2, c, ...lambs]) M.discard(m);

    // ---- a creeper killed in the tick its fuse runs out: its blast request is refused, nothing breaks
    const k = M.spawn("zombie", at[0] - 2, at[1], at[2]), cr = M.spawn("creeper", at[0] + 2, at[1], at[2]);
    const cx = Math.floor(cr.position.x), cy = Math.floor(cr.position.y) - 1, cz = Math.floor(cr.position.z), ground = W.getBlock(cx, cy, cz);
    cr.hp = 1; cr.invuln = 0;
    think(() => { M.strike(k, cr, 5, null); BF.req.send("explode", cr.id, {}, cr); });
    res.creeper = { dead: cr.dead, exploded: !!cr.exploded, ground: W.getBlock(cx, cy, cz) === ground };
    for (const m of [k, cr]) M.discard(m);
    BF.state.paused = false; M.spawning = true;
    return res;
  });

  const r1 = await run();
  console.log(JSON.stringify(r1));
  if (r1.err) { check(false, "setup: " + r1.err); throw new Error("FAIL setup"); }
  check(r1.bedFreeBefore, "setup: the new bed is free");
  check(r1.beds.pending, "bed claims sent in the think phase wait for apply");
  check(r1.beds.lo && !r1.beds.hi, "the lower-id villager gets the bed, the other doesn't", r1.beds);
  check(r1.beds.othersSame, "no other villager's bed changed (nobody is evicted)");
  check(r1.claimRefused >= 1, "the second claim is refused");
  for (const [name, h, first] of [["zombie lower", r1.hitsZ, "zombie"], ["golem lower", r1.hitsG, "golem"]]) {
    if (first === "zombie") check(h.hp === 14 && h.attacker === "zombie", name + ": both hits land (the golem's ignores the invulnerability the zombie's left)", h);
    else check(h.hp === 17 && h.attacker === null, name + ": the golem's hit lands, the zombie's is refused (invulnerable)", h);
    check(h.firstId === first, name + ": setup ids");
    check(h.dead && (first === "zombie" ? /zombie/i.test(h.cause) : /golem/i.test(h.cause)), name + ": the kill goes to the lower-id attacker", h);
    check(h.edit && h.edit.ok === false && h.edit.why === "dead" && h.blockKept, name + ": the dead villager's own request is refused", h);
  }
  check(r1.hitsZ.velX === -4 && r1.hitsG.velX === -4 && r1.hitsZ.velY === 8 && r1.hitsG.velY === 8, "knockback follows the hits that landed, in id order", [r1.hitsZ, r1.hitsG]);
  check(r1.lambs.length === 2, "two births in one tick, one lamb per pair (the ewe of the first pair has one lamb)", r1.lambs);
  check(r1.lambOrder, "the lambs' ids follow the parents' ids", r1);
  check(r1.creeper.dead && !r1.creeper.exploded && r1.creeper.ground, "a creeper killed first doesn't explode", r1.creeper);

  const r2 = await run();
  const strip = r => JSON.stringify({ beds: r.beds, hz: r.hitsZ, hg: r.hitsG, lambs: r.lambs.length, order: r.lambOrder, creeper: r.creeper });
  check(strip(r1) === strip(r2), "a second run gives the same outcomes", { r1: strip(r1), r2: strip(r2) });
  if (fails.length) throw new Error("FAIL " + fails.length + " checks: " + fails.join("; "));
};
