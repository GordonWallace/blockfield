// Debug screen Compare table test: NODE_PATH=$(npm root -g) node test/compare-view.js [outPrefix] [days=0]
// Starts debug/server.js on spare ports, opens the game and the debug screen, fast-forwards the world `days` game days (the CI
// integration tier runs 14), then checks the Compare table: the outlier rules and sorting on fixed sample data, every loaded
// village's row against its own village panel, clicking a row, full width, and screenshots it.
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/compare-view', DAYS = +(process.argv[3] || 0);
const GAME = 8730, DBG = 8731;
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-compare-view-alerts.json')]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
(async () => {
  const fails = [], ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails.push(n); };
  const srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('PAGEERROR game', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/`);
  await game.waitForTimeout(5000);
  await require('./lib').toVillage(game);
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  dbg.on('pageerror', e => console.log('PAGEERROR debug', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForTimeout(2000);
  // ---- outlier rules and sorting on fixed sample data (the page's own functions)
  const unit = await dbg.evaluate(() => {
    const C = window.BFCompare, out = [], ok = (n, c) => out.push([n, !!c]);
    const mk = (key, o) => Object.assign({ key, name: key, dist: 10, loaded: true, pop: 10, pop7: 0, pop7from: 10, happy: 80, beds: 12, free: 2, food: 30, trades: 20, noTools: 0, toolJobs: 3, jobs: 0, births: 1, deaths: 0, golems: 1 }, o);
    const rows = [mk('A', { food: 0 }), mk('B', { pop: 6, pop7: -4, pop7from: 10 }), mk('C', { happy: 30 }), mk('D', { trades: 2 }), mk('E', { deaths: 3 }),
      mk('F'), mk('G'), mk('H'), mk('I'), mk('J', { trades: 21 }), mk('K', { pop7: -2, pop7from: 10 })];
    const f = C.flags(rows);
    ok('no food', f.A && f.A.food === 'no food');
    ok('shrinking past a quarter', f.B && f.B.pop7 === 'shrinking' && !(f.K && f.K.pop7 === 'shrinking'));
    ok('unhappy', f.C && f.C.happy === 'unhappy');
    ok('worst 10% of trades', f.D && /trades/.test(f.D.trades) && !(f.J && f.J.trades));
    ok('worst 10% of deaths', f.E && /deaths/.test(f.E.deaths));
    ok('ordinary villages unflagged', !f.F && !f.G && !f.H);
    ok('ties at the middle are not outliers', !C.flags([mk('a'), mk('b'), mk('c'), mk('d'), mk('e')]).a);
    ok('fewer than 5 villages: only danger lines', Object.keys(C.flags([mk('a', { trades: 0 }), mk('b'), mk('c')])).length === 0);
    for (const k of C.COLS) {
      const s = C.sortRows(rows, { k, dir: 1 }), r = C.sortRows(rows, { k, dir: -1 });
      const val = x => k === 'name' ? x.name : x[k];
      ok('sort ' + k, s.every((x, i) => i === 0 || val(s[i - 1]) <= val(x)) && r.every((x, i) => i === 0 || val(r[i - 1]) >= val(x)));
    }
    const blank = C.sortRows([mk('a', { beds: null }), mk('b', { beds: 3 })], { k: 'beds', dir: 1 });
    ok('blanks sort last', blank[1].key === 'a');
    const d0 = C.row({ key: 'z', name: 'Z', dist: 5, loaded: true }, { villagers: 3, beds: 0, unclaimed: 0, golems: [], villagerList: [], week: { trade: 0, birth: 0, death: 0 }, noTools: [0, 0] }, 1);
    ok('no beds or tool jobs: dashes', d0.free === null && d0.noTools === null);
    return out;
  });
  for (const [n, c] of unit) ok(n, c);
  // ---- fast-forward the world, the feed running all the while
  if (DAYS > 0) {
    const t0 = Date.now();
    for (let d = 0; d < DAYS * 6; d++) {   // a sixth of a game day per call: the game loop and the feed run in between
      await game.evaluate(n => { const h = 0.05; for (let i = 0; i < n; i++) { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(BF.player.position.x, BF.player.position.z, 4); } }, Math.round(200 / 0.05));
      await game.waitForTimeout(50);
    }
    console.log(`fast-forwarded ${DAYS} game days in ${Math.round((Date.now() - t0) / 1000)} s`);
    await game.waitForTimeout(1500);
  }
  // ---- the table
  ok('list first', await dbg.evaluate(() => !document.getElementById('vlist').hidden && document.getElementById('vcmp').hidden));
  await dbg.click('#vl-cmp'); await dbg.waitForTimeout(700);
  const tab = () => dbg.evaluate(() => ({
    need: (document.querySelector('#vcmp .cneed') || {}).textContent || '',
    head: [...document.querySelectorAll('#vcmp th')].map(t => t.textContent),
    rows: [...document.querySelectorAll('#vcmp tbody tr')].map(tr => ({ key: tr.dataset.k, off: tr.classList.contains('off'), cells: [...tr.children].map(td => td.textContent) })),
  }));
  let t = await tab();
  ok('table shown with ' + t.rows.length + ' rows', t.rows.length >= 1 && t.head.length === 14);
  ok('summary line: ' + t.need, /village|stands out/.test(t.need));
  const loaded = t.rows.filter(r => !r.off);
  ok('loaded villages first', t.rows.findIndex(r => r.off) === -1 || t.rows.findIndex(r => r.off) >= loaded.length);
  // every loaded village's row matches its own village panel
  for (const r of loaded) {
    await dbg.click(`#vcmp tr[data-k="${r.key}"]`); await dbg.waitForTimeout(700);
    const p = await dbg.evaluate(() => ({ name: document.getElementById('v-name').textContent, villagers: document.getElementById('v-villagers').textContent, beds: document.getElementById('v-beds').textContent,
      jobs: document.getElementById('v-unclaimed').textContent, golems: document.getElementById('v-golems').textContent, happy: (document.querySelector('#v-happy .big') || {}).textContent || '' }));
    const row = (await tab()).rows.find(x => x.key === r.key).cells;
    const want = [p.villagers, p.beds, p.jobs, p.golems, p.happy];
    const got = [row[2], row[5], row[10], row[13], row[4]];
    ok(`${p.name}: table ${JSON.stringify(got)} = panel ${JSON.stringify(want)}`, row[0].startsWith(p.name) && JSON.stringify(got) === JSON.stringify(want));
  }
  // the numbers behind the row, from the game itself
  const g = await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), d = BF.debugFeed.snapshot().detail[rec.key];
    return { key: rec.key, trades: BF.happiness.week(rec.key, 'trade'), births: BF.happiness.week(rec.key, 'birth'), deaths: BF.happiness.week(rec.key, 'death'), noTools: d.noTools[0], pop7: d.pop7 }; });
  await dbg.waitForTimeout(600);
  const here = (await tab()).rows.find(x => x.key === g.key);
  ok('trades, births, deaths, tools match the game ' + JSON.stringify([here && here.cells.slice(8, 13), g]), here && Math.abs(+here.cells[8] - g.trades) <= 3 && +here.cells[11] === g.births && +here.cells[12] === g.deaths && parseInt(here.cells[9]) === g.noTools);
  if (DAYS >= 1) ok('population change after ' + DAYS + ' days: ' + (here && here.cells[3]), here && here.cells[3] !== '-' && g.pop7);
  // sorting by clicking a header, and again to reverse
  await dbg.click('#vcmp th[data-k="pop"]'); await dbg.waitForTimeout(300);
  ok('sorted by villagers', (await dbg.evaluate(() => document.querySelector('#vcmp th.on').dataset.k)) === 'pop');
  await dbg.click('#vcmp th[data-k="pop"]'); await dbg.waitForTimeout(300);
  ok('reverse sort', await dbg.evaluate(() => /▴/.test(document.querySelector('#vcmp th.on').textContent)));
  await dbg.screenshot({ path: out + '.png', fullPage: true });
  await dbg.click('#vl-wide'); await dbg.waitForTimeout(400);
  ok('full width', await dbg.evaluate(() => document.getElementById('vlpanel').getBoundingClientRect().width > 1400));
  await dbg.screenshot({ path: out + '-wide.png' });
  await dbg.keyboard.press('Escape'); await dbg.waitForTimeout(300);
  ok('Esc closes full width', await dbg.evaluate(() => !document.getElementById('vlpanel').classList.contains('wide')));
  await dbg.reload(); await dbg.waitForTimeout(2000);
  ok('the table and its sort are remembered for the session', await dbg.evaluate(() => !document.getElementById('vcmp').hidden && document.querySelector('#vcmp th.on') && document.querySelector('#vcmp th.on').dataset.k === 'pop'));
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
