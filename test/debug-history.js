// @ci integration hosts=worker,server
// Debug screen History panel test: NODE_PATH=$(npm root -g) node test/debug-history.js [outPrefix]
// The chart's own functions on fixed history (carried-on values while unloaded, totals and averages, pooled unemployment, the dotted
// pieces, multi-metric axes, hiding unloaded time), then the live feed: the game records the village every game hour while the world is
// fast-forwarded (js/villagestats.js), the feed and debug/server.js pass it on, the panel draws it in each scope, and it survives a
// save and load (serialize / deserialize).
// BF_HOST=page|worker|server (spec r15-43): where the simulation runs (lib.sim).
const path = require('path'), fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-history';
(async () => {
  const fails = [], ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails.push(n); };
  const srv = await lib.serve({ world: lib.host() === 'server' }), GAME = srv.game, DBG = srv.debug;
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1400 } });
  dbg.on('pageerror', e => { console.log('PAGEERROR debug', e.message); fails.push('page error ' + e.message); });
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForTimeout(1500);
  // ---- fixed history: village A loaded days 0-1 and 2-3, B loaded days 0.5-3 (and still)
  const unit = await dbg.evaluate(() => {
    const H = window.BFHist, out = [], ok = (n, c) => out.push([n, !!c]);
    const s = (t, pop, food, d, tr, un, ad, h) => [t, pop, food, d, tr, un, ad, h];
    H.load({ wid: 'w', name: 'Fixed', now: 3, v: {
      A: { name: 'Alpha', spans: [[0, 1], [2, 3]], s: [s(0, 10, 50, 0, 4, 1, 8, 80), s(0.5, 12, 40, 1, 6, 2, 8, 70), s(2, 6, 20, 3, 2, 4, 5, 30)] },
      B: { name: 'Beta', spans: [[0.5, 3]], s: [s(0.5, 4, 10, 0, 1, 0, 2, 90), s(1.5, 5, 12, 0, 2, 1, 3, 60)] } } });
    const A = H.data().v.A;
    ok('carries the last value on while unloaded', H.at(A, 1.5)[1] === 12 && H.at(A, 2.5)[1] === 6 && H.at(A, -1) === null);
    ok('population total', H.aggregate(['A', 'B'], 'pop', 1.5) === 17 && H.aggregate(['A', 'B'], 'pop', 0.2) === 10);
    ok('happiness average', H.aggregate(['A', 'B'], 'happy', 1.5) === 65);
    ok('unemployment pools the adults', Math.abs(H.aggregate(['A', 'B'], 'unemp', 1.5) - 3 / 11 * 100) < 1e-9);
    ok('nothing before the first sample', H.aggregate(['A', 'B'], 'pop', -1) === null);
    const sr = H.series('A', 'pop', null);
    ok('solid while loaded, dotted between ' + JSON.stringify(sr), sr.solid.length === 2 && sr.dotted.length === 1 && JSON.stringify(sr.dotted[0]) === '[[1,12],[2,12],[2,6]]' && sr.solid[0][sr.solid[0].length - 1][0] === 1);
    const sr2 = H.series('A', 'pop', 4);
    ok('dotted on to now when unloaded now', sr2.dotted.length === 2 && JSON.stringify(sr2.dotted[1]) === '[[3,6],[4,6]]');
    ok('unemployment %', H.series('A', 'unemp', null).solid[1][0][1] === 80);
    return out;
  });
  for (const [n, c] of unit) ok(n, c);
  // the drawing on that history: pin the panel to village A by giving it a snapshot
  const draw = async o => dbg.evaluate(o => { BFHist.snap({ villages: [{ key: 'B', loaded: true }] }, 'A'); BFHist.set(o);
    const svg = document.getElementById('h-svg');
    return { axes: svg.querySelectorAll('line.axis').length, ml: svg.querySelectorAll('path.ml:not(.d)').length, mld: svg.querySelectorAll('path.ml.d').length, brk: svg.querySelectorAll('line.brk').length,
      vl: svg.querySelectorAll('path.vl:not(.d)').length, vld: svg.querySelectorAll('path.vl.d').length, agg: svg.querySelectorAll('path.agg').length, note: document.getElementById('h-note').textContent,
      on: [...document.querySelectorAll('#h-metric button.on')].map(b => b.dataset.v), hideShown: !document.getElementById('h-hidel').hidden }; }, o);
  let d = await draw({ scope: 'one', metrics: ['pop', 'food', 'happy'], range: 0, hide: false });
  ok('one village, three metrics: an axis each (+ time axis) ' + JSON.stringify(d), d.axes === 4 && d.ml === 6 && d.mld === 3 && d.on.length === 3 && d.hideShown);
  d = await draw({ hide: true });
  ok('hide unloaded time: no dotted lines, a join mark ' + JSON.stringify(d), d.mld === 0 && d.brk === 1 && /left out/.test(d.note));
  d = await draw({ scope: 'all', metric: 'pop', hide: false });
  ok('all villages: a line each, dotted gaps, the total ' + JSON.stringify(d), d.vl === 3 && d.vld === 1 && d.agg === 1 && /total of 2 villages/.test(d.note) && !d.hideShown && d.on.length === 1);
  d = await draw({ scope: 'loaded', metric: 'happy' });
  ok('loaded villages: only B, the average ' + JSON.stringify(d), d.vl === 1 && /average of 1 village/.test(d.note));
  d = await draw({ scope: 'loaded', metric: 'unemp' });
  ok('unemployment says pooled', /adults pooled/.test(d.note));
  // (the "waiting for the game" cover is over the page until the game connects: click with the elements' own click())
  await dbg.evaluate(() => { document.querySelector('#h-scope button[data-v="one"]').click(); document.querySelector('#h-metric button[data-v="deaths"]').click(); }); await dbg.waitForTimeout(200);
  ok('metric buttons toggle in one-village scope', (await dbg.evaluate(() => BFHist.opt().metrics)).includes('deaths'));
  await dbg.evaluate(() => { const r = document.getElementById('h-svg').getBoundingClientRect(); document.getElementById('h-svg').dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width / 2, clientY: r.top + 120, bubbles: true })); }); await dbg.waitForTimeout(200);
  ok('hover tooltip', await dbg.evaluate(() => !document.getElementById('h-tip').hidden && /Day/.test(document.getElementById('h-tip').textContent)));
  await dbg.evaluate(() => BFHist.set({ scope: 'all', metric: 'pop', range: 0, hide: false }));
  await dbg.evaluate(() => { document.getElementById('waiting').hidden = true; });
  await dbg.locator('#hpanel').screenshot({ path: out + '-fixed.png' });

  // ---- the live feed
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('PAGEERROR game', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await lib.install(game);
  await game.goto(`http://localhost:${GAME}/?nolod&${lib.q()}#seed123`);
  await game.waitForTimeout(5000);
  await lib.simReady(game);
  await lib.toVillage(game);
  await dbg.reload(); await dbg.waitForTimeout(2000);
  const day0 = await lib.sim(game, () => BF.sky.day + BF.sky.time);
  for (let i = 0; i < 24; i++) {   // a game day, a game hour at a time, the feed running in between
    await lib.sim(game, n => { for (let i = 0; i < n; i++) { BF.simStep(0.05); if (i % 50 === 0) BF.world.update(BF.player.position.x, BF.player.position.z, 4); } }, 1000);
    await game.waitForTimeout(300);
  }
  const dayEnd = await lib.sim(game, () => BF.sky.day + BF.sky.time);
  await dbg.waitForFunction(t => BFHist.data() && BFHist.data().now >= t - 0.01, dayEnd, { timeout: 30000 }).catch(() => {});
  const g = await lib.sim(game, () => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), h = BF.vstats.history(rec.key);
    return { key: rec.key, wid: BF.glog.world() || 'seed-' + BF.state.seed, day: BF.sky.day + BF.sky.time, n: h.s.length, last: h.s[h.s.length - 1], latest: BF.vstats.latest(rec.key),
      pop: (rec.members || []).filter(m => m.type === 'villager' && !m.dead && !m.removed && m.position).length, happy: BF.happiness.score(rec).score }; });
  await dbg.waitForFunction(([k, n]) => { const d = BFHist.data(), r = d && d.v[k]; return r && r.s.length >= n - 1; }, [g.key, g.n], { timeout: 30000 }).catch(() => {});   // (the feed can be a snapshot or two behind)
  const h = await dbg.evaluate(k => { const d = BFHist.data(), r = d && d.v[k]; return r ? { wid: d.wid, n: r.s.length, first: r.s[0][0], last: r.s[r.s.length - 1], spans: r.spans, now: d.now } : null; }, g.key);
  ok('the game records the village hourly: ' + g.n + ' samples over ' + (g.day - day0).toFixed(2) + ' days', g.n >= 20 && g.n <= (g.day - day0) * 24 + 3);
  ok(`last sample matches the game (pop ${g.pop}, happiness ${g.happy}): ${JSON.stringify(g.last)}`, Math.abs(g.last[1] - g.pop) <= 1 && Math.abs(g.last[7] - g.happy) <= 5 && g.day - g.last[0] < 0.05 && g.latest.pop === g.last[1]);
  ok('the debug screen has the game\'s history ' + JSON.stringify(h && { n: h.n, spans: h.spans }), h && h.wid === g.wid && Math.abs(h.n - g.n) <= 1 && h.first <= day0 + 0.1);
  const rt = await lib.sim(game, k => { const before = JSON.stringify(BF.vstats.history(k).s), o = JSON.parse(JSON.stringify(BF.vstats.serialize()));
    BF.vstats.deserialize(o); const h = BF.vstats.history(k);
    return { same: JSON.stringify(h.s) === before, spans: h.spans.length, series: BF.vstats.series(k, 'unemployment').length === h.s.length }; }, g.key);
  ok('saved and loaded with the world ' + JSON.stringify(rt), rt.same && rt.spans >= 1 && rt.series);
  await dbg.waitForFunction(k => { const d = BFHist.data(), r = d && d.v[k]; return r && r.s.length >= 1; }, g.key, { timeout: 15000 }).catch(() => {});
  ok('after a load the screen gets it all again', await dbg.evaluate(k => { const d = BFHist.data(); return !!(d && d.v[k] && d.v[k].s.length >= 2); }, g.key));
  for (const sc of ['one', 'loaded', 'all']) {
    await dbg.click(`#h-scope button[data-v="${sc}"]`); await dbg.waitForTimeout(400);
    const r = await dbg.evaluate(() => ({ lines: document.querySelectorAll('#h-svg path.ml, #h-svg path.vl, #h-svg path.agg').length, empty: !!document.querySelector('#h-note .empty') }));
    ok(sc + ' scope draws ' + JSON.stringify(r), r.lines >= 1 && !r.empty);
  }
  await dbg.click('#h-scope button[data-v="one"]');
  await dbg.evaluate(() => BFHist.set({ metrics: ['pop', 'trades', 'happy'], range: 0 }));
  await dbg.waitForTimeout(300);
  await dbg.locator('#hpanel').screenshot({ path: out + '-live.png' });
  await b.close();
  await srv.stop();
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
