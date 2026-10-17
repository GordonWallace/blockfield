// A killed villager's bed is free for newborns and bedless villagers (bug-030).
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/dvb test/dead-villager-bed.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  await pg.waitForTimeout(4000);
  const r = await pg.evaluate(() => {
    const B = BF.breeding, pp = BF.player.position;
    const rec = [...BF.mobs.villages.values()].sort((a, b) => Math.hypot(a.x - pp.x, a.z - pp.z) - Math.hypot(b.x - pp.x, b.z - pp.z))[0];
    const victim = rec.members.find(m => m.type === "villager" && !m.dead && !m.removed && m.slot && m.slot.bed && !m.bred);
    if (!victim) return { err: "no villager with a house bed" };
    const bk = b => b.x + "," + b.y + "," + b.z, vb = bk(victim.slot.bed);
    B.scanBeds(rec);
    // take every bed that is free now, so only what the death frees can come back
    const fakes = [];
    const fill = () => { let fb; while ((fb = B.freeBed(rec, null)) && fakes.length < 200) { const f = { type: "villager", bed: fb, dead: false, removed: false }; rec.members.push(f); fakes.push(f); } };
    fill();
    const beforeKill = B.freeBed(rec, null);
    BF.mobs.hurt(victim, 999, "test");
    B.scanBeds(rec);
    const after = B.freeBed(rec, null);
    const stillBed = !!(BF.blocks[BF.world.getBlock(victim.slot.bed.x, victim.slot.bed.y, victim.slot.bed.z)] || {}).bed;
    for (const f of fakes) rec.members.splice(rec.members.indexOf(f), 1);
    return { victimDead: victim.dead, vb, stillBed, beforeKill: beforeKill && bk(beforeKill), after: after && bk(after), fakes: fakes.length };
  });
  console.log(JSON.stringify(r));
  const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
  if (r.err) return ok("setup: " + r.err, false);
  ok("no free bed while every bed is taken", r.beforeKill === null);
  ok("victim died, its bed still stands", r.victimDead && r.stillBed);
  ok("the dead villager's bed is free (" + r.after + " vs " + r.vb + ")", r.after === r.vb);
};
