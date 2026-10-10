// @ci integration suite=village
// A village that would stop counts down until its villagers' tasks are done (village loading plan): distances from the village edge, the
// timer from the longest task, a new long task refused while it runs, coming back cancelling it, a task still running at the end logged as an
// error, and the village and all its villagers unloading together. Usage: node test/run.js /tmp/vc test/village-countdown.js
module.exports = async (pg) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  await require('./lib').toVillage(pg);
  await pg.waitForFunction(() => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.slot).length >= 4, null, { timeout: 60000 });
  const info = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), v = rec.wg;
    return { key: rec.key, minX: v.minX, maxX: v.maxX, minZ: v.minZ, maxZ: v.maxZ, x: rec.x, z: rec.z };
  });
  const tp = (x, z) => pg.evaluate(([x, z]) => { BF.player.spawn(x, BF.worldgen.heightAt(x, z) + 3, z); }, [x, z]);
  const wait = (fn, arg, t = 40000) => pg.waitForFunction(fn, arg, { timeout: t }).then(() => true, () => false);
  // 1. measured from the village edge: 190 blocks east of the edge is simulated even when the centre is further than 200
  const edgeX = info.maxX + 190, centreD = edgeX - info.x;
  await tp(edgeX, info.z);
  const near = await wait(k => BF.villageSim.isActive(k), info.key);
  ok("a village 190 blocks from the player's nearest edge is simulated (centre " + Math.round(centreD) + " away)", near, { centreD: Math.round(centreD) });
  // a merchant on a trip counts for the whole trip, and a village that is counting down will not start one
  const mc = await pg.evaluate(k => {
    const m = BF.mobs.list.find(x => x.village && x.village.key === k && x.type === "villager" && x.profession === "merchant");
    if (!m) return null;
    const st = BF.merchant._state(m), rec = m.village;
    st.trip = { id: "t", home: rec.key, dest: "9999,9999", dx: rec.x + 400, dz: rec.z, day0: BF.sky.day + BF.sky.time, out: [], back: [], soldN: 0, boughtN: 0 }; st.stage = "go";
    const out = BF.merchant.leftSecs(m); st.trip = null; st.stage = null;
    return { secs: Math.round(out), days: +(out / 1200).toFixed(2) };
  }, info.key);
  ok("a merchant 400 blocks from its goal needs about a day and a half of game time", !mc || (mc.days > 0.8 && mc.days < 2), mc);
  // 2. one villager out on an errand beyond the village edge, then the player leaves
  await tp(info.x, info.z);
  await wait(k => BF.mobs.list.filter(m => m.village && m.village.key === k && m.type === "villager").length >= 4, info.key);
  const pin = k => pg.evaluate(k => {   // a villager held out beyond the village edge until the test lets go
    const m = BF.mobs.list.find(x => x.village && x.village.key === k && x.type === "villager" && !x.child && x.profession !== "explorer" && x.profession !== "merchant");
    const put = () => { m.position.set(m.village.wg.maxX + 50, BF.worldgen.heightAt(m.village.wg.maxX + 50, m.village.z) + 2, m.village.z); };
    Object.defineProperty(m, "sleeping", { get: () => false, set: () => {}, configurable: true });   // held out and awake, however slow the frames
    put(); clearInterval(window.__pin); window.__pin = setInterval(put, 150);
    return BF.vlog.nameOf(m);
  }, k);
  const heldOut = (k, who) => wait(a => BF.villageSim.estimates(a.k).list.some(e => e.who === a.who && e.errand), { k, who }, 15000);   // the village sees it out on an errand
  const unpin = () => pg.evaluate(() => clearInterval(window.__pin));
  const who = await pin(info.key);
  await heldOut(info.key, who);
  await tp(info.x + 900, info.z);
  const counting = await wait(k => BF.villageSim.countdown(k) !== null, info.key, 30000);
  const cd = await pg.evaluate(k => ({ cd: BF.villageSim.countdown(k), active: BF.villageSim.isActive(k), may: [BF.villageSim.mayStart(k, 1e6), BF.villageSim.mayStart(k, 1)] }), info.key);
  ok("a village with a villager out on a task counts down instead of unloading", counting && cd.active && cd.cd.left > 0, cd.cd);
  ok("the timer comes from the longest task, and the debug feed shows it", cd.cd && cd.cd.est.length > 0 && cd.cd.est.some(e => e.who === who) && cd.cd.est.every(e => e.secs <= cd.cd.est[0].secs), cd.cd && cd.cd.est);
  ok("a task longer than the time left may not start; a short one may", cd.may[0] === false && cd.may[1] === true, cd.may);
  // no villager begins a new task of any kind that would not finish: with 15 s left, only the one already out may carry on
  await pg.evaluate(k => { const c = BF.villageSim.countdown(k); BF.sky.time += Math.max(0, c.left - 15) / 1200; }, info.key);
  const gate = await pg.evaluate(k => {
    const rec = BF.mobs.villages.get(k), c = BF.villageSim.countdown(k);
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child && m.profession !== "explorer" && m.profession !== "merchant");
    const out = vs.filter(m => BF.villageSim.estimates(k).list.some(e => e.errand && e.who === BF.vlog.nameOf(m)));
    const idle = vs.filter(m => !out.includes(m) && !BF.villageSim.estimates(k).list.some(e => e.who === BF.vlog.nameOf(m)));
    return { left: c && c.left, out: out.length, idle: idle.length, idleBegin: idle.filter(m => BF.villageSim.canBegin(m)).length, outBegin: out.filter(m => BF.villageSim.canBegin(m)).length };
  }, info.key);
  ok("with too little time left an idle villager may not begin a task, one already out carries on", gate.left !== null && gate.idle > 0 && gate.idleBegin === 0 && gate.out > 0 && gate.outBegin === gate.out, gate);
  await unpin();
  // 3. coming back within range cancels it
  await tp(info.x, info.z);
  const cancelled = await wait(k => BF.villageSim.countdown(k) === null && BF.villageSim.isActive(k), info.key, 30000);
  ok("the player coming back cancels the countdown", cancelled);
  // 4. leave again; the timer runs out with the villager still out: error logged, village and villagers gone together
  await heldOut(info.key, await pin(info.key));
  await tp(info.x + 900, info.z);
  await wait(k => BF.villageSim.countdown(k) !== null, info.key, 30000);
  await pg.evaluate(k => { BF.sky.day += 3; }, info.key);   // the clock jumps past the timer (the villager is still held out there)
  await sleep(2500);
  await unpin();
  const gone = await wait(k => !BF.villageSim.isActive(k), info.key, 30000);
  const after = await pg.evaluate(k => ({ left: BF.mobs.list.filter(m => m.village && m.village.key === k).length, errors: BF.villageSim.errors().map(e => e.kind + ":" + e.who) }), info.key);
  ok("when the timer ends the village unloads", gone, after);
  ok("all of its villagers unload with it", after.left === 0, after);
  ok("a task still running at the end is logged as an error", after.errors.some(e => e.indexOf("task-running") === 0), after.errors);
};
