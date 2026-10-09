// A killed villager's workstation stays free for others after a save and reload (bug-036).
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/dvj test/dead-villager-jobsite.js
const toVillage = async pg => {
  await require('./lib').toVillage(pg);
  for (let i = 0; i < 30 && (await pg.evaluate(() => BF.mobs.list.filter(m => m.type === 'villager').length)) < 3; i++) await pg.waitForTimeout(2000);
};
module.exports = async (pg) => {
  const id = await pg.evaluate(async () => { BF.player.start(); const m = await BF.save.create({ name: "dvj", seed: "1337", gameMode: "creative" }); return m.id; });
  await toVillage(pg);
  const r = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const pp = BF.player.position;
    const rec = [...BF.mobs.villages.values()].sort((a, b) => Math.hypot(a.x - pp.x, a.z - pp.z) - Math.hypot(b.x - pp.x, b.z - pp.z))[0];
    const plan = BF.jobs.planFor(rec);
    const victim = rec.members.find(m => m.type === "villager" && !m.dead && m.slot && m.jobsite && plan.some(j => j.slot === m.slot.idx && j.x === m.jobsite.x && j.y === m.jobsite.y && j.z === m.jobsite.z));
    if (!victim) return { err: "no villager at a planned workstation" };
    const site = { ...victim.jobsite };
    BF.mobs.hurt(victim, 999, "test");
    const free = BF.jobs.unclaimed(rec).some(s => s.x === site.x && s.y === site.y && s.z === site.z);
    return { key: rec.key, prof: victim.profession, site, free };
  });
  console.log("before reload:", JSON.stringify(r));
  const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
  if (r.err) return ok("setup: " + r.err, false);
  ok("the dead " + r.prof + "'s workstation is free in the same session", r.free);
  await pg.evaluate(async id => { await BF.save.saveNow(); await BF.save.load(id); }, id);
  await toVillage(pg);
  const r2 = await pg.evaluate(o => {
    const rec = BF.mobs.villages.get(o.key), s = o.site;
    if (!rec) return { err: "village not loaded" };
    const free = BF.jobs.unclaimed(rec).some(x => x.x === s.x && x.y === s.y && x.z === s.z);
    const holder = BF.mobs.list.find(m => !m.dead && m.jobsite && m.jobsite.x === s.x && m.jobsite.y === s.y && m.jobsite.z === s.z);
    return { free, heldBy: holder ? holder.profession : null, dead: [...(rec.dead || [])] };
  }, r);
  console.log("after reload:", JSON.stringify(r2));
  if (r2.err) return ok("reload: " + r2.err, false);
  ok("after a reload it is free or already taken by a living villager", r2.free || !!r2.heldBy);
};
