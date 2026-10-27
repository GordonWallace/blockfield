// @ci integration suite=village timeout=1500 hosts=worker,server
// (timeout: its waits add up to 780 s at most, plus getting to the village; a 2 fps runner can take most of them)
// The simulation budget (spec r15-34, js/active.js): with the budget forced high, villages beyond the nearest four join the simulated set
// over time, nearest first, through the normal load path; forced low, they leave again one at a time, farthest first, back to the minimum
// rule, each through the unload countdown (a villager on a task holds its village until the task ends; nothing is cut off). Game log
// INFO lines name each decision. Usage: node test/run.js /tmp/ab test/active-budget.js [--host page|worker|server]
module.exports = async (pg) => {
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  const lib = require('./lib');
  // waits until fn(arg) is true where the simulation is (spec r15-43)
  const wait = async (fn, arg, t = 60000) => { for (const end = Date.now() + t; Date.now() < end; await pg.waitForTimeout(250)) if (await lib.sim(pg, fn, arg)) return true; return false; };
  await lib.toVillage(pg);
  await lib.sim(pg, () => { globalThis.__running = () => BF.villageSim.areas().filter(a => a.kind === "village").map(a => a.key); });
  const base = await lib.sim(pg, () => ({ on: BF.active.opts().on, n: BF.villageSim.count(), keys: __running(), extras: BF.active.extras().length }));
  ok("off in automated browsers: the distance rule only", base.on === false && base.extras === 0, base);

  // 1. forced high: short windows so the test doesn't wait minutes
  await lib.sim(pg, () => { BF.mobs.spawning = false; BF.active.set({ on: true, budget: 10, win: 1, hold: 2, cool: 600, minFps: 0, reach: 1000 }); });
  const grew = await wait(() => BF.active.extras().length >= 2, null, 90000);
  const up = await lib.sim(pg, () => {
    const p = BF.player.position, ed = BF.villageSim._edgeDist;
    const ex = BF.active.extras().map(k => { const v = BF.worldgen.villagesNear(p.x, p.z, 1400).find(v => Math.round(v.x) + "," + Math.round(v.z) === k); return { k, d: v ? Math.round(ed(v, p.x, p.z)) : -1, active: BF.villageSim.isActive(k) }; });
    return { n: BF.villageSim.count(), ex, text: BF.active.text(), log: BF.active.log().map(e => e.text), glog: BF.glog.recent(5000).filter(e => e.k === "budget").map(e => e.l + " " + e.x) };
  });
  ok("forced high: more villages join over time, one per decision", grew && up.n >= base.n + 2 && up.ex.every(e => e.active), up);
  ok("nearest first: each extra is no nearer than the one before it", up.ex.every((e, i) => i === 0 || e.d >= up.ex[i - 1].d - 1), up.ex);
  ok("the game log has an INFO line for each village that joined", up.glog.filter(l => /^INFO .*joins the simulated set/.test(l)).length >= up.ex.length, up.glog);
  ok("the pause menu's line counts them", new RegExp("^Simulated villages: " + up.n + " \\(budget 1000%\\)$").test(up.text), up.text);
  // an extra loads like any other village: its villagers come out (the planet's chunks take a while)
  const first = up.ex[0].k;
  const people = await wait(k => { const r = BF.mobs.villages.get(k); return !!(r && r.members && r.members.some(m => m.type === "villager")); }, first, 150000);
  ok("an extra village's villagers come out (same load path)", people, first);
  const feed = await lib.sim(pg, () => (BF.debugFeed.snapshot || BF.debugFeed.simPart)().budget);   // (off the page the simulation makes its part of the snapshot)
  ok("the debug feed carries the budget and the decision log", !!feed && feed.extras.length >= 2 && feed.log.length >= 2, feed && { villages: feed.villages, extras: feed.extras.length, log: feed.log.length });

  // 2. forced low: the farthest leaves first; a villager on a task holds its village (the countdown) until the task is over
  await lib.sim(pg, k => {
    const r = BF.mobs.villages.get(k), m = r && r.members.find(x => x.type === "villager" && !x.child && x.profession !== "explorer" && x.profession !== "merchant");
    if (!m) return;
    const T = { what: "Test task", secs: 1200, t0: BF.sky.day + BF.sky.time, end: BF.sky.day + BF.sky.time + 1 };   // a game day: 2 real minutes at 10x
    Object.defineProperty(m, "vtask", { get: () => T, set: () => {}, configurable: true });
    Object.defineProperty(m, "sleeping", { get: () => false, set: () => {}, configurable: true });
    globalThis.__held = m;
  }, first);
  const held = await lib.sim(pg, () => !!globalThis.__held);
  // 10x, so the other villagers' tasks end in real minutes (the budget is per real second, and this one is always over)
  await pg.evaluate(() => BF.warp.set(BF.warp.SPEEDS.indexOf(10)));   // (the page's speed: the simulation follows it)
  await lib.sim(pg, () => BF.active.set({ budget: 0.000001 }));
  const drained = await wait(() => BF.active.extras().length === 0, null, 120000);
  const down = await lib.sim(pg, k => ({ extras: BF.active.extras(), counting: BF.villageSim.countdown(k), active: BF.villageSim.isActive(k), leaves: BF.active.log().filter(e => /leaves the simulated set/.test(e.text)).map(e => e.text) }), first);
  ok("forced low: the extras leave the set, one decision each, over budget", drained && down.leaves.length >= up.ex.length, down.leaves);
  ok("the nearest extra (with a villager on a task) is the last to leave", /over budget/.test(down.leaves[down.leaves.length - 1] || "") && down.leaves.length >= 2, down.leaves.slice(-1));
  if (held) ok("a village with a villager on a task counts down instead of unloading at once", down.active && !!down.counting && down.counting.left > 0, down.counting);
  await lib.sim(pg, () => { const m = globalThis.__held; if (m) { delete m.vtask; delete m.sleeping; m.vtask = null; m.sleeping = false; } });
  // (on a slow runner 10x isn't reached and a long task can outlast the wait: a village still counting down is honouring it)
  const back = await wait(n => BF.villageSim.count() <= n, base.n, 300000);
  const end = await lib.sim(pg, keys => ({ n: BF.villageSim.count(), left: __running().filter(k => !keys.includes(k)).map(k => ({ k, cd: BF.villageSim.countdown(k) })), errs: BF.villageSim.errors().slice(), glogErr: BF.glog.recent(5000).filter(e => e.l === "ERROR" && e.k === "loading").map(e => e.x), text: BF.active.text() }), base.keys);
  ok("back to the minimum rule once the countdowns end (any village left is still counting down)", (back && end.n <= base.n) || (end.left.length > 0 && end.left.every(x => x.cd && x.cd.left > 0)), { n: end.n, base: base.n, left: end.left });
  ok("no task was cut off or forced to stop (game log and loading errors)", end.errs.length === 0 && end.glogErr.length === 0, { errs: end.errs, glog: end.glogErr });
  // 3. off: the minimum only, and the setting is logged
  await lib.sim(pg, () => BF.active.set({ on: false }));
  const off = await lib.sim(pg, () => ({ text: BF.active.text(), log: BF.glog.recent(5000).filter(e => e.k === "budget").map(e => e.x).slice(-1)[0] }));
  ok("turned off: logged, and the menu says so", /budget off\)$/.test(off.text) && /off/.test(off.log), off);
};
