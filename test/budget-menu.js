// @ci integration suite=village timeout=600 hosts=page,worker,server
// The pause menu's "Simulated villages" setting reaches the simulation wherever it runs (bug-081, js/active.js): in a Web Worker or on
// the world server the page's copy holds the setting and sends it on (js/simhost.js budget), the button shows the simulation's own line
// (the protocol's budget query, so its village count is the simulation's, not 0), and a remembered setting reaches the simulation when
// the game starts again. Usage: node test/run.js /tmp/bm test/budget-menu.js [--host page|worker|server]
module.exports = async (pg) => {
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  const lib = require('./lib');
  const btn = () => pg.evaluate(() => document.querySelector('[data-act="budget"]').textContent);
  const click = () => pg.evaluate(() => document.querySelector('[data-act="budget"]').click());
  // the button's text once it has the simulation's answer (a query in a worker or on the world server)
  const btnFor = async re => { let t = ""; for (let i = 0; i < 40; i++) { t = await btn(); if (re.test(t)) return t; await pg.waitForTimeout(100); } return t; };
  await lib.toVillage(pg);
  const where = await lib.where(pg);
  // an automated browser starts off, in the page and where the simulation is
  const start = { page: await pg.evaluate(() => BF.active.opts().on), sim: await lib.sim(pg, () => BF.active.opts().on) };
  ok("automated browser: the budget starts off where the simulation is", start.page === false && start.sim === false, Object.assign({ where }, start));
  // the player picks 20%, 40%, 60%: each reaches the simulation
  await pg.evaluate(() => { try { localStorage.removeItem("blockfield.simBudget"); } catch (_) {} });
  const steps = [];
  for (let i = 0; i < 3; i++) {
    await click();
    const page = await pg.evaluate(() => BF.active.opts().budget);
    const text = await btnFor(new RegExp("budget " + Math.round(page * 100) + "%\\)$"));
    const sim = await lib.sim(pg, () => ({ on: BF.active.opts().on, budget: BF.active.opts().budget, n: BF.villageSim.count() }));
    steps.push({ page, sim, text });
  }
  ok("each click reaches the simulation", steps.every(s => s.sim.on && Math.abs(s.sim.budget - s.page) < 1e-9), steps);
  ok("the button shows the simulation's village count and budget", steps.every(s => s.sim.n > 0 && s.text === "Simulated villages: " + s.sim.n + " (budget " + Math.round(s.page * 100) + "%)"), steps.map(s => s.text));
  const log = await lib.sim(pg, () => BF.glog.recent(5000).filter(e => e.k === "budget").map(e => e.l + " " + e.x));
  ok("the simulation's game log has an INFO line for each change, once", log.filter(l => /^INFO Simulation budget set to (20|40|60)%/.test(l)).length === 3, log);
  // 80%, then off: no extra village joins though the windows are short
  await click(); await click();
  const off = { text: await btnFor(/budget off\)$/), sim: await lib.sim(pg, () => BF.active.opts()) };
  ok("off reaches the simulation", off.sim.on === true && off.sim.budget === 0 && /budget off\)$/.test(off.text), { text: off.text, budget: off.sim.budget });
  await lib.sim(pg, () => BF.active.set({ win: 1, hold: 2, minFps: 0 }));
  await pg.waitForTimeout(8000);
  const ex = await lib.sim(pg, () => BF.active.extras());
  ok("no extra village joins after off", ex.length === 0, ex);
  // a remembered setting reaches the simulation the next time the game starts (the worker's and the server's copies have no localStorage)
  await pg.evaluate(() => { localStorage.setItem("blockfield.simBudget", "0.6"); });
  await pg.reload(); await lib.reloaded(pg);
  await lib.toVillage(pg);
  const again = await lib.sim(pg, () => BF.active.opts());
  const page2 = await pg.evaluate(() => BF.active.opts());
  ok("after a reload the simulation has the page's setting (remembered 60%, off: automated browser)", again.budget === page2.budget && again.on === page2.on && page2.budget === 0.6, { page: { on: page2.on, budget: page2.budget }, sim: { on: again.on, budget: again.budget } });
  await pg.evaluate(() => { try { localStorage.removeItem("blockfield.simBudget"); } catch (_) {} });
};
