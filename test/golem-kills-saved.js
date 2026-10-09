// @ci integration suite=village
// A killed village iron golem stays gone after saving and reloading (bug-040): the kill count is saved with the village's
// dead roster ("dead:<village key>"), so the respawn check still counts it. Usage: node test/run.js /tmp/gks test/golem-kills-saved.js
module.exports = async (pg, out) => {
  const id = await pg.evaluate(async () => (await BF.save.create({ name: "golem-kills-saved", seed: 1337, gameMode: "creative" })).id);
  await require('./lib').toVillage(pg);
  const golems = () => pg.evaluate(() => BF.mobs.list.filter(m => m.type === "iron_golem" && !m.dead && m.village).length);
  const before = await golems();
  await pg.evaluate(async () => {
    BF.mobs.spawning = false;
    for (let round = 0; round < 10; round++) {   // the village replaces golems one at a time until its quota is used up
      for (const g of BF.mobs.list.filter(m => m.type === "iron_golem" && m.village)) BF.mobs.kill(g);
      for (let i = 0; i < 200; i++) BF.mobs.update(0.05);
    }
    await BF.save.saveNow();
  });
  const afterKill = await golems();
  await pg.reload();
  await pg.waitForTimeout(6000);
  await pg.evaluate(async id => { await BF.save.load(id); BF.mobs.spawning = false; }, id);
  await pg.waitForTimeout(9000);
  await pg.evaluate(() => { for (let i = 0; i < 400; i++) BF.mobs.update(0.05); });
  const afterReload = await golems();
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra));
  ok("the village had golems to kill", before > 0, { before });
  ok("killed golems are not replaced while playing", afterKill === 0, { afterKill });
  ok("killed golems are not replaced after save and reload", afterReload === 0, { afterReload });
  await pg.evaluate(id => BF.save.remove(id), id);
};
