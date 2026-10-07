// Second-screen debug test: NODE_PATH=$(npm root -g) node test/debug-screen.js [outPrefix]
// Starts debug/server.js on spare ports, opens the game and the debug screen, checks the screen matches the game,
// restarts the server mid-village (the game must resend the layout and log), and screenshots the screen.
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-screen';
const GAME = 8710, DBG = 8711;
const start = () => new Promise(res => { const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG]); p.stdout.once('data', () => res(p)); });
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
  srv.kill(); await new Promise(r => setTimeout(r, 500));
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
  await dbg.waitForTimeout(1200);
  const count = () => dbg.evaluate(() => document.querySelectorAll('#log .ent').length);
  const all = await count();
  ok('dropdown per type', await dbg.evaluate(t => !!document.querySelector(`#l-filters details.dd[data-t="${t}"]`), tr.seller));
  await dbg.click(`#l-filters details.dd[data-t="${tr.seller}"] summary`);
  await dbg.uncheck(`#l-filters details.dd[data-t="${tr.seller}"] input[data-a="sell"]`);
  await dbg.waitForTimeout(200);
  const vis = await dbg.evaluate(() => [...document.querySelectorAll('#log .ent .tx')].map(e => e.textContent));
  ok('unchecking Selling hides the player trade', !vis.some(t => /^Player traded/.test(t)) && vis.length < all);
  ok('so does a villager buying from that type', !vis.some(t => /got 1 Test/.test(t)));
  ok('dropdown stays open after a change', await dbg.evaluate(t => document.querySelector(`#l-filters details.dd[data-t="${t}"]`).open, tr.seller));
  await dbg.screenshot({ path: out + '-filters.png' });
  await dbg.reload(); await dbg.waitForTimeout(1500);
  const texts = () => dbg.evaluate(() => [...document.querySelectorAll('#log .ent .tx')].map(e => e.textContent));
  ok('choice remembered after reload', !(await texts()).some(t => /^Player traded/.test(t)) && await dbg.evaluate(t => !document.querySelector(`#l-filters details.dd[data-t="${t}"] input[data-a="sell"]`).checked, tr.seller));
  await dbg.click('#l-reset'); await dbg.waitForTimeout(200);
  ok('show all restores', (await texts()).some(t => /^Player traded/.test(t)) && (await count()) >= all);   // villagers may have logged more meanwhile
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
  await b.close(); srv.kill();
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
