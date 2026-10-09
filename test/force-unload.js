// @ci integration suite=village
// Force unload (village loading plan): over a limit, a village far from the player is stopped even with a task running, in priority order,
// never within 100 blocks; each forced stop is logged. Usage: node test/run.js /tmp/fu test/force-unload.js
module.exports = async (pg) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  await require('./lib').toVillage(pg);
  await pg.waitForFunction(() => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.slot).length >= 4, null, { timeout: 60000 });
  const info = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), v = rec.wg;
    return { key: rec.key, maxX: v.maxX, x: rec.x, z: rec.z };
  });
  const tp = (x, z) => pg.evaluate(([x, z]) => { BF.player.spawn(x, BF.worldgen.heightAt(x, z) + 3, z); }, [x, z]);
  const wait = (fn, arg, t = 40000) => pg.waitForFunction(fn, arg, { timeout: t }).then(() => true, () => false);
  // 1. a village within 100 blocks of the player is never force-unloaded, whatever the limit
  await pg.evaluate(() => { BF.villageSim.LIMITS.villages = 0; });
  await sleep(4000);
  const near = await pg.evaluate(k => ({ active: BF.villageSim.isActive(k), errs: BF.villageSim.errors().filter(e => e.kind === "forced-stop").length }), info.key);
  ok("a village the player stands in is never forced off", near.active && near.errs === 0, near);
  // 2. out on a task, 300 blocks away, over the village-count limit: stopped at once, the villager sent home first, and logged
  await pg.evaluate(k => {
    const m = BF.mobs.list.find(x => x.village && x.village.key === k && x.type === "villager" && !x.child && x.profession !== "explorer" && x.profession !== "merchant");
    const put = () => { m.position.set(m.village.wg.maxX + 50, BF.worldgen.heightAt(m.village.wg.maxX + 50, m.village.z) + 2, m.village.z); };
    Object.defineProperty(m, "sleeping", { get: () => false, set: () => {}, configurable: true });   // held out and awake, however slow the frames
    put(); window.__pin = setInterval(put, 150);
    window.__who = BF.vlog.nameOf(m);
  }, info.key);
  await wait(k => BF.villageSim.estimates(k).max > 0, info.key, 15000);   // the village knows it is out on an errand
  await tp(info.x + 300, info.z);
  const gone = await wait(k => !BF.villageSim.isActive(k), info.key, 30000);
  await pg.evaluate(() => clearInterval(window.__pin));
  const after = await pg.evaluate(k => ({ left: BF.mobs.list.filter(m => m.village && m.village.key === k).length, errs: BF.villageSim.errors().filter(e => e.kind === "forced-stop").map(e => e.who + ": " + e.action + " (" + e.why + ")"), who: window.__who }), info.key);
  ok("a village over the village-count limit is unloaded with a villager still out", gone && after.left === 0, after);
  ok("the forced stop of an errand is logged with its action and reason", after.errs.some(e => e.indexOf(after.who + ": went home") === 0 && e.indexOf("village count") > 0), after.errs);
  // 3. held chunks over the limit force a village off too
  await pg.evaluate(() => { BF.villageSim.LIMITS.villages = 10; BF.villageSim.LIMITS.chunks = 5; });
  await tp(info.x, info.z);
  await wait(k => BF.villageSim.isActive(k), info.key, 30000);
  await tp(info.x + 300, info.z);
  const gone2 = await wait(k => !BF.villageSim.isActive(k), info.key, 30000);
  ok("a village over the held-chunk limit is forced off", gone2);
};
