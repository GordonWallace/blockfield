// Debug screen Economy tab test: NODE_PATH=$(npm root -g) node test/economy-view.js [outPrefix]
// Starts debug/server.js on spare ports, opens the game and the debug screen, scripts some trades, waits and unsold stock in the
// village, then checks the Economy tab: the flow diagram's bands and hover details, the dead ends, the table, the day range,
// "All villages", the empty state, and that a newly opened screen gets the tallies from the server's cache. Screenshots it.
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/economy-view';
const GAME = 8720, DBG = 8721;
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-economy-view-alerts.json')]);
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
  // the scripted economy: planks and logs, a pickaxe, bread for the player, a wait for gold, and stock nobody buys
  const want = await game.evaluate(() => {
    const L = BF.vlog, E = BF.econ, I = BF.I, rec = L.villageAt(BF.player.position.x, BF.player.position.z);
    const vs = rec.members.filter(m => m.type === 'villager' && !m.dead && !m.child && m.slot && Array.isArray(m.inv));
    const [a, b2, c] = vs;
    L.trade(a, b2, { buy: [{ id: I.emerald, n: 2 }], sell: { id: I.planks, n: 8 } }, 3);
    L.trade(c, b2, { buy: [{ id: I.emerald, n: 1 }], sell: { id: I.oak_log, n: 8 } }, 1);
    L.trade(a, c, 'gave 4 Emerald, got 1 Iron Pickaxe', 1);
    BF.emit('villagerTrade', c, { buy: [{ id: I.emerald, n: 1 }], sell: { id: I.bread, n: 4 } });
    E.want(c, 'Gold');
    // something nobody in the village buys (a builder would buy cobblestone while the screen is open, and that sale would reset it)
    c.trades = [{ buy: [{ id: I.emerald, n: 1 }], sell: { id: I.dead_bush, n: 16 }, maxUses: 99, uses: 0 }];
    c.inv[c.inv.length - 1] = { id: I.dead_bush, count: 64 };   // a slot of its own: its pack may be full
    E.scan(rec); BF.sky.day += 2; E.scan(rec);
    const p = m => L.pretty(m.profession);
    return { key: rec.key, seller: p(b2), buyer: p(a), cname: L.nameOf(c), cprof: p(c), name: BF.signs.villageName(rec.key) };
  });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  dbg.on('pageerror', e => console.log('PAGEERROR debug', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForTimeout(2500);
  ok('log tab first', await dbg.evaluate(() => !document.getElementById('l-pane').hidden && document.getElementById('e-pane').hidden));
  await dbg.click('#l-tabs [data-tab="econ"]');
  await dbg.click('#e-range [data-v="7"]');
  await dbg.waitForTimeout(800);
  const view = () => dbg.evaluate(() => ({
    bands: document.querySelectorAll('#econ svg.flow path').length,
    labels: [...document.querySelectorAll('#econ svg.flow text')].map(t => t.textContent),
    tot: (document.querySelector('#econ .etot') || {}).textContent || '',
    wanted: [...document.querySelectorAll('#econ .dead > div:first-child .drow')].map(r => r.textContent),
    held: [...document.querySelectorAll('#econ .dead > div:last-child .drow')].map(r => r.textContent),
    rows: document.querySelectorAll('#econ .etable tbody tr').length, empty: (document.querySelector('#econ .empty') || {}).textContent || '',
  }));
  let v = await view();
  ok('economy tab shows ' + v.tot, !(await dbg.evaluate(() => document.getElementById('e-pane').hidden)) && /trades/.test(v.tot));
  ok('flow bands ' + v.bands, v.bands >= 3);   // wood (planks and logs share a band), tools, food
  ok('seller and buyer nodes ' + JSON.stringify(v.labels.slice(0, 8)), v.labels.some(t => t.startsWith(want.seller)) && v.labels.some(t => t.startsWith(want.buyer)) && v.labels.some(t => t.startsWith('Player')));
  ok('wanted: gold ' + JSON.stringify(v.wanted), v.wanted.some(t => t.includes(want.cprof) && t.includes('Gold') && /h waited/.test(t)));
  ok('held: dead bushes ' + JSON.stringify(v.held.filter(t => t.includes(want.cname))), v.held.some(t => t.includes(want.cname) && /64 Dead Bush/.test(t) && /2 days unsold/.test(t)));
  ok('held line coloured as an alert', await dbg.evaluate(() => [...document.querySelectorAll('#econ .dead .drow')].some(r => /warn|danger/.test(r.className))));
  await dbg.screenshot({ path: out + '.png', fullPage: true });
  // hover a band: its items with counts and emeralds
  // a snapshot with new trades redraws the diagram (and its hidden tooltip) under the mouse, more often on a slow CI machine: hover again, up to 5 times
  let tip = { shown: false, text: '' };
  for (let i = 0; i < 5 && !(tip.shown && /trade/.test(tip.text)); i++) {
    const box = await dbg.evaluate(() => { const ps = [...document.querySelectorAll('#econ svg.flow path')]; const p = ps.sort((x, y) => y.getBBox().height - x.getBBox().height)[0];
      const r = p.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await dbg.mouse.move(box.x - 40, box.y); await dbg.mouse.move(box.x, box.y); await dbg.waitForTimeout(300);
    tip = await dbg.evaluate(() => { const t = document.getElementById('e-tip'); return { shown: t && t.style.display === 'block', text: t ? t.textContent : '' }; });
  }
  ok('hover lists items ' + tip.text, tip.shown && /emeralds|no emeralds/.test(tip.text) && /trade/.test(tip.text));
  await dbg.screenshot({ path: out + '-hover.png' });
  // table view
  await dbg.click('#e-mode [data-v="table"]'); await dbg.waitForTimeout(300);
  v = await view();
  ok('table rows ' + v.rows, v.rows >= 4);
  const planks = await dbg.evaluate(() => [...document.querySelectorAll('#econ .etable tbody tr')].map(r => [...r.children].map(td => td.textContent)).find(r => /Planks/.test(r[2])));
  ok('table row: seller, buyer, item, count, emeralds, trades ' + JSON.stringify(planks), planks && planks[0] === want.seller && planks[1] === want.buyer && planks[3] === '24' && planks[4] === '6' && planks[5] === '3');
  await dbg.screenshot({ path: out + '-table.png', fullPage: true });
  // today only: the trades were two game days ago
  await dbg.click('#e-range [data-v="1"]'); await dbg.waitForTimeout(300);
  v = await view();
  // villagers may trade among themselves in the moments since: only the scripted trades must be gone
  const todayRows = await dbg.evaluate(() => [...document.querySelectorAll('#econ .etable tbody tr')].map(r => [...r.children].map(td => td.textContent)));
  ok('today leaves out the trades from 2 days ago: ' + (v.empty || todayRows.length + ' rows'), (v.empty === 'No trades in this range.' || !todayRows.some(r => /Planks/.test(r[2]) && r[3] === '24')) && v.held.some(t => t.includes(want.cname)));
  // all villages
  await dbg.click('#e-range [data-v="3"]'); await dbg.click('#e-scope [data-v="all"]'); await dbg.waitForTimeout(300);
  v = await view();
  ok('all villages ' + v.tot, /^All villages \(\d+\)/.test(v.tot) && v.rows >= 4 && v.held.some(t => t.includes(want.name)));
  // a reloaded screen gets the tallies from the server's cache (the game only re-sends them when they change)
  await dbg.reload(); await dbg.waitForTimeout(2000);
  const cached = await dbg.evaluate(() => ({ tab: !document.getElementById('e-pane').hidden, rows: document.querySelectorAll('#econ .etable tbody tr').length }));
  ok('new screen: remembered tab and cached tallies ' + JSON.stringify(cached), cached.tab && cached.rows >= 4);
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
