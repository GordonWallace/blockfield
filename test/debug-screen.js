// Second-screen debug test: NODE_PATH=$(npm root -g) node test/debug-screen.js [outPrefix]
// Starts debug/server.js on spare ports, opens the game and the debug screen, checks the screen matches the game,
// restarts the server mid-village (the game must resend the layout and log), and screenshots the screen.
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-screen';
const GAME = 8710, DBG = 8711;
// the server prints its banner before its ports are open: wait until the debug port answers
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
(async () => {
  const fails = [], ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails.push(n); };
  let srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/`);
  await game.waitForTimeout(5000);
  ok('feed is on when served by the debug server', await game.evaluate(() => !!BF.debugFeed));
  await require('./lib').toVillage(game);
  await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); BF.vlog.log(rec, 'birth', 'Test baby was born'); });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForTimeout(2000);
  const want = await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), d = BF.vlog.panelData(rec);
    return { name: d.name, villagers: d.villagers, seed: BF.state.seed, log: BF.vlog.entries(rec.key).length, loaded: d.loaded }; });
  const got = () => dbg.evaluate(() => ({ conn: document.getElementById('conn').textContent, name: document.getElementById('v-name').textContent,
    villagers: +document.getElementById('v-villagers').textContent, seed: +document.getElementById('h-seed').textContent,
    rows: document.getElementById('r-body').children.length, log: document.querySelectorAll('#log .ent').length, f3: document.getElementById('f3').textContent }));
  let g = await got();
  // villagers keep logging, so the screen can be one snapshot behind the game: wait (up to 5 s) until both show the same number of entries
  for (let i = 0; i < 20; i++) {
    want.log = await game.evaluate(() => BF.vlog.entries(BF.vlog.villageAt(BF.player.position.x, BF.player.position.z).key).length);
    if (g.log === want.log) break;
    await dbg.waitForTimeout(250); g = await got();
  }
  ok('live', g.conn === 'Live');
  ok('village name ' + g.name, g.name === want.name);
  ok('villager count', g.villagers === want.villagers);
  ok('seed', g.seed === want.seed);
  ok('roster rows = loaded villagers', g.rows === want.loaded);
  ok('log entries ' + g.log + '/' + want.log, g.log === want.log && want.log > 0);
  await dbg.click('#raw summary'); await dbg.waitForTimeout(400);
  ok('F3 text matches the overlay format', /^Blockfield {2}\d+ fps\nXYZ /.test((await got()).f3));
  await dbg.screenshot({ path: out + '.png', fullPage: true });
  // server restart: a fresh server has no layout/log; the game must resend both
  srv.kill(); await new Promise(r => srv.once('exit', r));
  srv = await start();
  await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); BF.vlog.log(rec, 'job', 'Someone became a Tester'); });
  await dbg.waitForTimeout(7000);
  g = await got();
  ok('after restart: live again', g.conn === 'Live');
  const now = await game.evaluate(() => BF.vlog.entries(BF.vlog.villageAt(BF.player.position.x, BF.player.position.z).key));
  await dbg.waitForTimeout(1500); g = await got();   // villagers may log more meanwhile: the screen must hold at least what the game had
  ok('after restart: log resent ' + g.log + '/' + now.length, g.log >= now.length && now.some(e => /Tester/.test(e[2])));
  const st = await (await fetch(`http://localhost:${DBG}/state`)).json();
  ok('after restart: layout resent', Object.values(st.layouts || {}).some(l => l.buildings.length));
  // log filters: a dropdown per villager type, checkboxes per action, remembered across reloads
  const tr = await game.evaluate(() => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const vs = rec.members.filter(m => m.type === 'villager' && !m.child && m.trades && m.trades.length && m.profession !== 'nitwit');
    const s = vs[0], b2 = vs.find(m => m.profession !== s.profession);
    BF.vlog.trade(b2, s, 'gave 1 Emerald, got 1 Test');
    BF.emit('villagerTrade', s, s.trades[0]);
    return { seller: BF.vlog.pretty(s.profession), buyer: BF.vlog.pretty(b2.profession) };
  });
  // on a slow machine the trades can take a few seconds to reach the screen
  await dbg.waitForFunction(() => { const t = [...document.querySelectorAll('#log .ent .tx')].map(e => e.textContent); return t.some(x => /got 1 Test/.test(x)) && t.some(x => /^Player traded/.test(x)); }, null, { timeout: 20000 }).catch(() => {});
  await dbg.waitForTimeout(500);
  const count = () => dbg.evaluate(() => document.querySelectorAll('#log .ent').length);
  const all = await count();
  // one dropdown, a row per villager type (every type, logged here or not), Select all / none at the top
  const row = t => `#l-types .frow[data-t="${t}"]`;
  await dbg.click('#l-types summary');
  ok('one dropdown lists every type', await dbg.evaluate(() => { const r = [...document.querySelectorAll('#l-types .frow')].map(e => e.dataset.t); return r.length >= 22 && r.includes('Miner') && r.includes('Child') && r.includes('Player'); }));
  ok('single column', await dbg.evaluate(() => new Set([...document.querySelectorAll('#l-types .frow')].map(e => Math.round(e.getBoundingClientRect().left))).size === 1));
  const texts = () => dbg.evaluate(() => [...document.querySelectorAll('#log .ent .tx')].map(e => e.textContent));
  await dbg.click(`${row(tr.seller)} .fx`);
  await dbg.uncheck(`#l-types .facts[data-t="${tr.seller}"] input[data-a="sell"]`);
  await dbg.waitForTimeout(200);
  let vis = await texts();
  // an entry shows while any villager in it is selected: the buyer (a villager, or the player) still is
  ok('a trade still shows while its buyer is selected', vis.some(t => /got 1 Test/.test(t)) && vis.some(t => /^Player traded/.test(t)));
  ok('menu stays open after a change', await dbg.evaluate(() => document.getElementById('l-types').open && !!document.querySelector('#l-types .facts')));
  ok('partly on: type checkbox shows mixed', await dbg.evaluate(s => document.querySelector(s + ' input.tcb').indeterminate, row(tr.seller)));
  await dbg.click(`${row('Player')} input.tcb`); await dbg.waitForTimeout(200);
  vis = await texts();
  ok('player checkbox hides the player trade', !vis.some(t => /^Player traded/.test(t)) && vis.length < all);
  await dbg.screenshot({ path: out + '-filters.png', fullPage: true });
  await dbg.click('#l-count'); await dbg.waitForTimeout(100);
  ok('a click elsewhere closes the menu', !(await dbg.evaluate(() => document.getElementById('l-types').open)));
  await dbg.reload(); await dbg.waitForTimeout(1500);
  ok('choice remembered after reload', !(await texts()).some(t => /^Player traded/.test(t)) && await dbg.evaluate(s => !document.querySelector(s + ' input.tcb').checked, row('Player')));
  // Select none, then one type: only entries involving that type (whoever the other party is)
  await dbg.click('#l-types summary'); await dbg.click('#l-none'); await dbg.waitForTimeout(200);
  const none = await dbg.evaluate(() => [...document.querySelectorAll('#log .ent')].filter(e => /trade|bed|job|birth|death/.test(e.className)).length);
  ok('select none hides villager entries', none === 0);
  await dbg.check(`${row(tr.buyer)} input.tcb`); await dbg.waitForTimeout(200);
  vis = await texts();
  ok('one type selected shows its trades with unselected types', vis.some(t => /got 1 Test/.test(t)) && !vis.some(t => /^Player traded/.test(t)));
  ok('and nothing without it', vis.every(t => !/traded with/.test(t) || t.includes('(' + tr.buyer + ')')));
  await dbg.click('#l-all'); await dbg.waitForTimeout(200);
  ok('select all restores', (await texts()).some(t => /^Player traded/.test(t)) && (await count()) >= all);   // villagers may have logged more meanwhile
  await dbg.click('#l-count');
  // a second village: the view follows the nearest loaded one, the list shows both with distances, and the first can be picked
  const first = want.name;
  const second = await game.evaluate(() => {
    const p = BF.player.position, here = BF.vlog.villageAt(p.x, p.z);
    const vs = BF.worldgen.villagesNear(p.x, p.z, 1500).filter(v => Math.round(v.x) + "," + Math.round(v.z) !== here.key)
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const v = vs[0];
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    return BF.signs.villageName(Math.round(v.x) + "," + Math.round(v.z));
  });
  await game.waitForTimeout(12000);
  const list = () => dbg.evaluate(() => [...document.querySelectorAll('#vlist .vrow')].map(r => ({ name: r.querySelector('.vn').firstChild.textContent, on: r.classList.contains('on'), sel: r.classList.contains('sel'), dist: +r.querySelector('.vd b').textContent.replace(/,/g, '') })));
  let L = await list();
  console.log('villages:', JSON.stringify(L));
  ok('list has both villages', L.some(v => v.name === first) && L.some(v => v.name === second));
  ok('nearest loaded village first and shown by default', L[0].name === second && L[0].on && L[0].sel && (await got()).name === second);
  ok('every village shows a distance', L.every(v => v.dist >= 0 && !isNaN(v.dist)));
  const onIdx = L.map(v => v.on), firstOff = onIdx.indexOf(false);
  ok('unloaded below loaded', firstOff < 0 || onIdx.slice(firstOff).every(x => !x));
  await dbg.click(`#vlist .vrow:has(.vn:text-is("${first}"))`).catch(async () => dbg.evaluate(n => [...document.querySelectorAll('#vlist .vrow')].find(r => r.querySelector('.vn').firstChild.textContent === n).click(), first));
  await dbg.waitForTimeout(600);
  g = await got();
  const firstRow = (await list()).find(v => v.name === first);
  ok('picked village is shown', g.name === first && firstRow.sel);
  ok('unloaded village is greyed with its last numbers', firstRow.on || await dbg.evaluate(() => document.getElementById('vpanel').classList.contains('stale') && /Not loaded/.test(document.getElementById('v-sub').textContent) && +document.getElementById('v-villagers').textContent > 0));
  ok('its full log is still there', g.log > 0);
  await dbg.screenshot({ path: out + '-picked.png' });
  await dbg.click('#vl-auto'); await dbg.waitForTimeout(600);
  ok('follow nearest goes back', (await got()).name === second);
  // the game page's scripts carry their file times, so a browser can't keep running an old saved copy of one
  ok('game scripts are versioned', await game.evaluate(() => [...document.scripts].filter(s => /\/js\//.test(s.src)).every(s => /\?v=\d+$/.test(s.src))));
  // a feed error (an old villagelog.js without panelData, say) shows on the screen instead of "waiting for the game"
  await game.evaluate(() => { window._pd = BF.vlog.panelData; delete BF.vlog.panelData; });
  await dbg.waitForTimeout(6000);
  const errShown = await dbg.evaluate(() => ({ conn: document.getElementById('conn').textContent, wait: !document.getElementById('waiting').hidden, text: document.getElementById('waiting').textContent }));
  ok('feed error shown ' + errShown.conn, errShown.conn === 'Game error' && errShown.wait && /panelData/.test(errShown.text));
  await game.evaluate(() => { BF.vlog.panelData = window._pd; });
  await dbg.waitForTimeout(5000);   // after an error the feed waits 4 s before its next try
  ok('live again once fixed', (await got()).conn === 'Live');
  // a debug screen opened after the game has gone doesn't show its last snapshot as live
  await game.close(); await dbg.waitForTimeout(3000);
  await dbg.reload(); await dbg.waitForTimeout(1500);
  ok('closed game not shown as live: ' + (await got()).conn, (await got()).conn === 'Game not responding');
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));   // free the ports for the next run
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
