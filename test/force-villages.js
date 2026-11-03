// @ci integration suite=village timeout=900 args={out} hosts=page,worker,server
// Force-loading villages (r15-90, js/active.js force): /loadvillages N adds the N nearest villages not yet simulated at the next village
// check, nearest first, whatever the budget's measure (no waiting for them to join naturally); the debug screen's Simulation budget card
// does the same through debug/server.js (POST /warp {op: "villages", n}, run by the page as the command wherever the simulation is); each
// join has an INFO game log line; asking for more than there are logs an ERROR; afterwards the usual rules decide (a budget forced low lets
// them go again, through the unload countdown). BF_HOST=page|worker|server: where the simulation runs (checked there with lib.sim).
// BF_CLUSTERS=1 (server only): the world server with 3 cluster workers split always (debug/server.js --workers 3 --split always --clusters).
// r15-93: /autovillages off (and the card's Pause / Resume) stops the automatic joins and leaves, so a budget forced low lets nothing go;
// /unloadvillages N (and the card's Unload) lets the N farthest extras go; asking for more than run logs an ERROR.
// Usage: NODE_PATH=$(npm root -g) node test/force-villages.js [outPrefix]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
(async () => {
  const t0 = Date.now(), fails = [], ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + '[' + ((Date.now() - t0) / 1000).toFixed(1) + ' s] ' + n + (!c && x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails.push(n); };
  const clusters = process.env.BF_CLUSTERS === '1' && lib.host() === 'server';
  const srv = await lib.serve({ world: lib.host() === 'server', args: clusters ? ['--workers', '3', '--split', 'always', '--clusters', '--verify', '100'] : [] });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const done = async code => { await b.close(); await srv.stop(); process.exit(code); };
  try {
    const game = await b.newPage({ viewport: { width: 1024, height: 640 } });
    game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
    await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await game.route('https://fonts.**', r => r.abort());
    await lib.install(game);   // (BFT.sim)
    await game.goto(`http://localhost:${srv.game}/?nolod&${lib.q()}${clusters ? '&workers=3' : ''}#seed123`);
    await game.waitForTimeout(4000);
    await lib.simReady(game);
    await game.evaluate(() => BF.player.start && BF.player.start());   // past the title screen (debug steps are ignored there)
    if (clusters) { await game.evaluate(() => BF.save.create({ name: 'force-villages', seed: '123', gameMode: 'creative' })); await lib.simReady(game); }   // (region workers follow a saved world)
    await lib.toVillage(game);
    const wait = async (fn, arg, t = 60000) => { for (const end = Date.now() + t; Date.now() < end; await game.waitForTimeout(250)) if (await lib.sim(game, fn, arg)) return true; return false; };
    // the budget on, but never joining by itself (a window no run reaches): every extra here is a forced one
    await lib.sim(game, () => { BF.mobs.spawning = false; BF.active.set({ on: true, budget: 0.8, win: 1e6, hold: 2, minFps: 0, reach: 3000, morning: 0 }); });
    if (clusters) ok('the clusters are split over 3 workers', await wait(() => { const s = BF.rplay.status(); return s.split && s.followers === 2; }, null, 180000), await lib.sim(game, () => BF.rplay.status()));
    const base = await lib.sim(game, () => ({ n: BF.villageSim.count(), extras: BF.active.extras().length }));
    ok('no extras before forcing', base.extras === 0, base);

    // 1. the command: 3 at once, nearest first
    const r = await game.evaluate(() => { const x = BF.commands.execute('/loadvillages 3'); return x.done ? x.done : x; });
    ok('/loadvillages 3 answers ok', r.ok && /Loading the 3 nearest villages/.test(r.msg), r);
    const three = await wait(() => BF.active.extras().length >= 3, null, 30000);
    const up = await lib.sim(game, () => {
      const p = BF.player.position, ed = BF.villageSim._edgeDist, near = BF.worldgen.villagesNear(p.x, p.z, 4000);
      const key = v => Math.round(v.x) + ',' + Math.round(v.z);
      const ex = BF.active.extras().map(k => { const v = near.find(v => key(v) === k); return { k, d: v ? Math.round(ed(v, p.x, p.z)) : -1, active: BF.villageSim.isActive(k) }; });
      const others = near.filter(v => v.minX != null && !BF.villageSim.isActive(key(v))).map(v => Math.round(ed(v, p.x, p.z)));
      return { n: BF.villageSim.count(), ex, nearestLeft: others.length ? Math.min(...others) : null, glog: BF.glog.recent(5000).filter(e => e.k === 'budget').map(e => e.l + ' ' + e.x) };
    });
    ok('3 villages join at once, all simulated', three && up.ex.length === 3 && up.ex.every(e => e.active) && up.n === base.n + 3, up);
    ok('nearest first: no village left out is nearer than the farthest forced one', up.nearestLeft == null || up.ex.every(e => e.d <= up.nearestLeft + 1), up);
    ok('an INFO game log line for each forced join', up.glog.filter(l => /^INFO .*force-loaded/.test(l)).length === 3, up.glog);
    const bad = await game.evaluate(() => { const x = BF.commands.execute('/loadvillages 0'); return x.done ? x.done : x; });
    ok('/loadvillages 0 is refused', !bad.ok, bad);

    // 2. the debug screen's card
    const dbg = await b.newPage({ viewport: { width: 1600, height: 900 } });
    dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
    await dbg.route('https://fonts.**', r => r.abort());
    await dbg.goto(`http://localhost:${srv.debug}/`);
    await dbg.waitForFunction(() => !document.getElementById('c-budgetcard').hidden, null, { timeout: 60000 }).catch(() => {});
    await dbg.fill('#c-vload-n', '2');
    await dbg.click('#c-vload-go');
    const five = await wait(() => BF.active.extras().length >= 5, null, 40000);
    ok('the debug screen\'s Load button adds 2 more', five, await lib.sim(game, () => BF.active.extras()));
    ok('the card shows them', await dbg.waitForFunction(() => /Extra: .*,.*,.*,.*,/.test(document.getElementById('c-budget-ex').textContent), null, { timeout: 20000 }).then(() => true, () => false));

    // 3. more than there are within reach: as many as there are, and an ERROR line
    await lib.sim(game, () => { BF.active.set({ reach: 600 }); });
    await game.evaluate(() => BF.commands.execute('/loadvillages 50'));
    const err = await wait(() => BF.glog.recent(5000).some(e => e.k === 'budget' && e.l === 'ERROR' && /^Force-loading 50 villages added/.test(e.x)), null, 30000);
    ok('asking for more than there are logs an ERROR', err);

    // 3b. (r15-93) automatic loading paused: a budget forced low lets nothing go
    await lib.sim(game, () => { BF.active.set({ reach: 3000 }); });
    const pa = await game.evaluate(() => { const x = BF.commands.execute('/autovillages off'); return x.done ? x.done : x; });
    ok('/autovillages off answers ok', pa.ok && /paused/.test(pa.msg), pa);
    ok('the card shows it paused', await dbg.waitForFunction(() => document.getElementById('c-vauto').textContent === 'paused' && document.getElementById('c-vauto-go').textContent === 'Resume', null, { timeout: 20000 }).then(() => true, () => false));
    await lib.sim(game, () => { BF.active.set({ budget: 0.0001, win: 1, hold: 2 }); });
    const held = await lib.sim(game, () => BF.active.extras());
    await game.waitForTimeout(12000);
    const still = await lib.sim(game, () => ({ ex: BF.active.extras(), text: BF.active.text() }));
    ok('paused: over budget, no village leaves by itself', held.length >= 4 && still.ex.length === held.length, { held, still });
    ok('the pause menu line says automatic is paused', /automatic paused\)$/.test(still.text), still.text);
    // 3c. force-unload: the farthest extras go, by command and by the debug screen's button
    const far2 = await lib.sim(game, () => { const p = BF.player.position, ed = BF.villageSim._edgeDist, near = BF.worldgen.villagesNear(p.x, p.z, 4000), key = v => Math.round(v.x) + ',' + Math.round(v.z);
      return BF.active.extras().map(k => ({ k, d: ed(near.find(v => key(v) === k), p.x, p.z) })).sort((a, b) => b.d - a.d).slice(0, 2).map(e => e.k); });
    const un = await game.evaluate(() => { const x = BF.commands.execute('/unloadvillages 2'); return x.done ? x.done : x; });
    ok('/unloadvillages 2 answers ok', un.ok && /Unloading the 2 farthest/.test(un.msg), un);
    ok('the 2 farthest extras leave', await wait(f => { const ex = BF.active.extras(); return f.every(k => !ex.includes(k)); }, far2, 30000), { far2, now: await lib.sim(game, () => BF.active.extras()) });
    const n0 = held.length - 2;
    ok('only those 2', (await lib.sim(game, () => BF.active.extras().length)) === n0);
    ok('an INFO line for each', await lib.sim(game, () => BF.glog.recent(5000).filter(e => e.l === 'INFO' && /force-unloaded/.test(e.x)).length) === 2);
    await dbg.fill('#c-vunload-n', '1');
    await dbg.click('#c-vunload-go');
    ok('the debug screen\'s Unload button lets 1 more go', await wait(n => BF.active.extras().length === n - 1, n0, 30000));
    ok('they unload (each through the countdown, at most a game minute)', await wait(ks => ks.every(k => !BF.villageSim.isActive(k)), far2, 120000));
    await game.evaluate(() => BF.commands.execute('/unloadvillages 50'));
    ok('asking to unload more extras than run logs an ERROR', await wait(() => BF.glog.recent(5000).some(e => e.k === 'budget' && e.l === 'ERROR' && /^Force-unloading 50 villages let/.test(e.x)), null, 30000));
    // nothing left to unload? the next steps need some extras: force 3 more (paused, they stay)
    await game.evaluate(() => BF.commands.execute('/loadvillages 3'));
    ok('paused, forced loads still work', await wait(() => BF.active.extras().length >= 3, null, 30000));

    // 4. afterwards the usual rules: the debug screen's Resume, and a budget forced low lets the extras go (farthest first, through the countdown)
    await dbg.click('#c-vauto-go');
    ok('the debug screen\'s Resume turns automatic loading on again', await wait(() => BF.active.isAuto(), null, 20000));
    ok('the card shows it on', await dbg.waitForFunction(() => document.getElementById('c-vauto').textContent === 'on', null, { timeout: 20000 }).then(() => true, () => false));
    const gone = await wait(() => BF.active.extras().length === 0, null, 120000);
    ok('the usual rules resume: over budget, forced villages leave again', gone, await lib.sim(game, () => BF.active.log().slice(-6).map(e => e.text)));
    if (clusters) {
      const h = await lib.sim(game, () => BF.rplay.status());
      ok('still split, the copies never differed', h.split && h.followers === 2 && !h.why, h);
    }
    const errs = await lib.sim(game, () => BF.glog.recent(5000).filter(e => e.l === 'ERROR' && e.k === 'budget' && !/^(worker \d+: )?Force-(un)?loading 50/.test(e.x)).map(e => e.k + ' ' + e.x));
    ok('no other budget ERROR lines', !errs.length, errs);
  } catch (e) { console.log('FAIL ' + (e && e.stack || e)); fails.push('threw'); }
  console.log(fails.length ? 'FAILED: ' + fails.length : 'ALL PASS');
  await done(fails.length ? 1 : 0);
})();
