// @ci integration suite=village timeout=600 hosts=page,worker,server
// The pause menu's Distant villages panel (Gordon, 2026-10-28; js/active.js, js/player.js) reaches the simulation wherever it runs
// (bug-081): in a Web Worker or on the world server the page's copy holds the settings and sends them on (js/simhost.js budget), the
// button shows the simulation's own line (the protocol's budget query, so its village count is the simulation's, not 0), Automatic's time
// limit is the simulation's own (80% on a thread of its own, 40% in the page), and remembered settings (and 1.5's first setting, a share
// alone) reach the simulation when the game starts again. The Cluster workers line cycles the setting (js/simhost.js) and logs it.
// Usage: node test/run.js /tmp/bm test/budget-menu.js [--host page|worker|server]
module.exports = async (pg) => {
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  const lib = require('./lib');
  const btn = () => pg.evaluate(() => document.querySelector('[data-act="budget"]').textContent);
  const line = f => pg.evaluate(f => { const b = document.querySelector(f === "workers" ? '.bfp-distant [data-act="workers"]' : '.bfp-distant [data-f="' + f + '"]'); return b ? { text: b.textContent, disabled: b.disabled } : null; }, f);
  const click = f => pg.evaluate(f => document.querySelector(f === "workers" ? '.bfp-distant [data-act="workers"]' : '.bfp-distant [data-f="' + f + '"]').click(), f);
  // the button's text once it has the simulation's answer (a query in a worker or on the world server)
  const waitFor = async (get, re) => { let t = ""; for (let i = 0; i < 40; i++) { t = await get(); if (re.test(typeof t === "string" ? t : t && t.text)) return t; await pg.waitForTimeout(100); } return t; };
  const simOpts = () => lib.sim(pg, () => Object.assign(BF.active.opts(), { settings: BF.active.settings(), n: BF.villageSim.count() }));
  await pg.evaluate(() => { try { localStorage.removeItem("blockfield.simBudget"); localStorage.removeItem("blockfield.distant"); localStorage.removeItem("blockfield.workers"); } catch (_) {} });
  await lib.toVillage(pg);
  const where = await lib.where(pg), inPage = where.mode === "in page";
  // an automated browser starts off, in the page and where the simulation is
  const start = { page: await pg.evaluate(() => BF.active.opts().on), sim: await lib.sim(pg, () => BF.active.opts().on) };
  ok("automated browser: distant villages start off where the simulation is", start.page === false && start.sim === false, Object.assign({ where }, start));
  // the panel opens with its lines: the defaults
  await pg.evaluate(() => document.querySelector('[data-act="budget"]').click());
  const lines = { villages: await waitFor(() => line("villages"), /Automatic/), share: await line("share"), reach: await line("reach"), mem: await line("mem"), workers: await line("workers") };
  const autoShare = inPage ? 40 : 80;
  ok("the panel shows the defaults: Automatic villages, the simulation's automatic time limit, no distance limit, automatic memory, 1 worker",
    /Villages: Automatic/.test(lines.villages.text) && new RegExp("Time limit: Automatic \\(" + autoShare + "% of each second\\)").test(lines.share.text) &&
    lines.reach.text === "Distance limit: None" && /Memory limit: Automatic \(\d+ MB\)/.test(lines.mem.text) && lines.workers.text === "Cluster workers: 1 (clusters off)", { where, lines });
  // the time limit: 20%, 40%, 60%; each reaches the simulation
  const steps = [];
  for (let i = 0; i < 3; i++) {
    await click("share");
    const want = [0.2, 0.4, 0.6][i];
    const text = await waitFor(btn, new RegExp("up to " + Math.round(want * 100) + "% of each second\\)$"));
    const sim = await simOpts();
    steps.push({ want, sim: { on: sim.on, budget: sim.budget, share: sim.settings.share, n: sim.n }, text });
  }
  ok("each time limit reaches the simulation", steps.every(s => s.sim.on && Math.abs(s.sim.budget - s.want) < 1e-9 && s.sim.share === s.want), steps);
  ok("the button shows the simulation's village count and limit", steps.every(s => s.sim.n > 0 && s.text === "Distant villages: " + s.sim.n + " simulated (up to " + Math.round(s.want * 100) + "% of each second)"), steps.map(s => s.text));
  // the distance and memory limits
  await click("reach"); await click("mem");
  const lim = await waitFor(async () => (await simOpts()).reach + "", /^500$/);
  const lo = await simOpts();
  ok("the distance and memory limits reach the simulation", lo.reach === 500 && lo.settings.reach === 500 && lo.memMB === 250 && lo.settings.mem === 250, { lim, reach: lo.reach, memMB: lo.memMB, settings: lo.settings });
  const log = await lib.sim(pg, () => BF.glog.recent(5000).filter(e => e.k === "budget").map(e => e.l + " " + e.x));
  ok("the simulation's game log has an INFO line for each change, once", log.filter(l => /^INFO Distant villages: Automatic/.test(l)).length === 5 && log.some(l => /within 500 blocks, memory 250 MB$/.test(l)), log);
  // nearest only: the other lines disable, no extra village joins though the windows are short
  await click("villages");
  const off = { text: await waitFor(btn, /\(nearest only\)$/), sim: await simOpts(), share: await waitFor(() => line("share"), /./) };
  ok("nearest only reaches the simulation", off.sim.on === true && off.sim.budget === 0 && /\(nearest only\)$/.test(off.text) && off.share.disabled, { text: off.text, budget: off.sim.budget, share: off.share });
  await lib.sim(pg, () => BF.active.set({ win: 1, hold: 2, minFps: 0 }));
  await pg.waitForTimeout(8000);
  const ex = await lib.sim(pg, () => BF.active.extras());
  ok("no extra village joins with nearest only", ex.length === 0, ex);
  // Cluster workers: Automatic shows its count; logged; remembered
  await click("workers");
  const wl = await waitFor(() => line("workers"), /Automatic/);
  const wst = await pg.evaluate(() => ({ pref: BF.simHost.workersPref(), auto: BF.simHost.autoWorkers(), stored: localStorage.getItem("blockfield.workers"), log: BF.glog.recent(5000).filter(e => /Cluster workers setting/.test(e.x)).map(e => e.l + " " + e.x) }));
  ok("Cluster workers: Automatic shows its count and is remembered and logged", wl.text === "Cluster workers: Automatic (" + wst.auto + ")" && wst.pref === "auto" && wst.stored === "auto" && wst.auto >= 1 && wst.log.some(l => /^INFO Cluster workers setting: Automatic/.test(l)), { wl, wst });
  await pg.evaluate(() => localStorage.removeItem("blockfield.workers"));
  // remembered settings reach the simulation the next time the game starts (the worker's and the server's copies have no localStorage)
  await pg.evaluate(() => { localStorage.setItem("blockfield.distant", JSON.stringify({ villages: "auto", share: 0.6, reach: 2000, mem: "auto" })); });
  await pg.reload(); await lib.reloaded(pg);
  await lib.toVillage(pg);
  const again = await simOpts();
  const page2 = await pg.evaluate(() => BF.active.opts());
  ok("after a reload the simulation has the page's settings (remembered 60% within 2000 blocks, off: automated browser)", again.budget === page2.budget && again.on === page2.on && page2.budget === 0.6 && again.reach === 2000, { page: { on: page2.on, budget: page2.budget }, sim: { on: again.on, budget: again.budget, reach: again.reach } });
  // 1.5's first setting (a share alone) is read as the time limit
  await pg.evaluate(() => { localStorage.removeItem("blockfield.distant"); localStorage.setItem("blockfield.simBudget", "0.2"); });
  await pg.reload(); await lib.reloaded(pg);
  const old = await pg.evaluate(() => Object.assign(BF.active.opts(), { settings: BF.active.settings() }));
  ok("the old Simulated villages setting is read as the time limit", old.budget === 0.2 && old.settings.share === 0.2 && old.settings.villages === "auto", { budget: old.budget, settings: old.settings });
  await pg.evaluate(() => { try { localStorage.removeItem("blockfield.simBudget"); localStorage.removeItem("blockfield.distant"); } catch (_) {} });
};
