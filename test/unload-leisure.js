// @ci integration suite=village hosts=worker,server
// Leisure and the unload countdown (js/villagesim.js): a villager at leisure (strolling, relaxing and the like, js/villagerstatus.js) beyond
// the village edge doesn't hold the village up; when the village unloads it is put back home without a loading error, and the village log
// says so. Usage: node test/run.js /tmp/ul test/unload-leisure.js [--host page|worker|server]
module.exports = async (pg) => {
  const lib = require('./lib');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  // waits until fn(arg) is true where the simulation is (spec r15-43)
  const wait = async (fn, arg, t = 40000) => { for (const end = Date.now() + t; Date.now() < end; await sleep(500)) if (await lib.sim(pg, fn, arg)) return true; return false; };
  await lib.toVillage(pg);
  if (!await wait(() => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.slot).length >= 4, null, 60000)) return ok("the village's villagers are out", false);
  // the spot 30 blocks out loaded first (the planet's chunks load slowly: a villager put in a chunk that isn't loaded is taken off and respawns at home)
  await wait(() => { const r = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); return !!r && BF.world.isLoaded(r.wg.maxX + 30, r.z); }, null, 60000);
  const info = await lib.sim(pg, () => {
    BF.mobs.spawning = false;
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const m = rec.members.find(x => x.type === "villager" && !x.child && !x.dead && x.profession !== "explorer" && x.profession !== "merchant");
    const who = BF.vlog.nameOf(m), text = BF.villagerStatus.text;
    BF.villagerStatus.text = v => (v === m ? "Strolling around the village" : text(v));
    const put = () => { m.vtask = null; m.position.set(m.village.wg.maxX + 30, BF.worldgen.heightAt(m.village.wg.maxX + 30, m.village.z) + 2, m.village.z); };
    Object.defineProperty(m, "sleeping", { get: () => false, set: () => {}, configurable: true });
    put(); globalThis.__pin = setInterval(put, 150);
    return { key: rec.key, x: rec.x, z: rec.z, who };
  });
  await sleep(2000);
  const est = await lib.sim(pg, a => ({ leisure: BF.villagerStatus.leisure(BF.mobs.villages.get(a.key).members.find(m => BF.vlog.nameOf(m) === a.who)),
    listed: BF.villageSim.estimates(a.key).list.filter(e => e.who === a.who) }), info);
  ok("a villager strolling beyond the edge is at leisure", est.leisure, est);
  ok("leisure doesn't count towards the unload countdown", est.listed.length === 0, est);
  await pg.evaluate(([x, z]) => { BF.player.spawn(x, BF.worldgen.heightAt(x, z) + 3, z); }, [info.x + 900, info.z]);   // (the page's player: the simulation follows it)
  await wait(k => BF.villageSim.countdown(k) !== null || !BF.villageSim.isActive(k), info.key, 30000);
  await lib.sim(pg, () => { BF.sky.day += 3; });   // past any countdown the other villagers' tasks started
  const gone = await wait(k => !BF.villageSim.isActive(k), info.key, 30000);
  await lib.sim(pg, () => clearInterval(globalThis.__pin));
  const after = await lib.sim(pg, a => ({ errors: BF.villageSim.errors().filter(e => e.who === a.who), log: BF.vlog.entries(a.key).filter(e => e[1] === "loading").map(e => e[2]) }), info);
  ok("the village unloads", gone);
  ok("no loading error for the leisure villager", after.errors.length === 0, after.errors);
  ok("the village log says the leisure ended and the villager went home", after.log.some(t => t.indexOf("Unloaded:") === 0 && t.indexOf(info.who) > 0 && t.indexOf("strolling around the village") > 0), after.log);
};
