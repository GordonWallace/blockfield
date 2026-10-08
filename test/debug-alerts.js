// Debug screen alerts and 0x: NODE_PATH=$(npm root -g) node test/debug-alerts.js [outPrefix]
// Starts debug/server.js (alerts in a temp file), creates an alert on the debug screen, checks the game gets it, that a matching
// log entry freezes the world at 0x (even part-way through a 100x frame), frees the mouse and shows the notice with distance and
// Teleport, that Teleport moves the player next to the event, that Right resumes at 1x and takes the mouse back, that disable and
// delete reach the game, that alerts survive a server restart, and that Left at 1x gives 0x.
const path = require('path'), fs = require('fs'), os = require('os'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-alerts';
const GAME = 8720, DBG = 8721, FILE = path.join(os.tmpdir(), 'bf-test-alerts-' + process.pid + '.json');
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', FILE]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
(async () => {
  const fails = [], ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails.push(n); };
  try { fs.unlinkSync(FILE); } catch (e) {}
  let srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/`);
  await game.waitForTimeout(4000);
  // simulated pointer lock (headless Chromium has none), as in test/z-release.js
  await game.evaluate(() => {
    const cv = document.querySelector('canvas');
    let el = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => el, configurable: true });
    const fire = () => document.dispatchEvent(new Event('pointerlockchange'));
    cv.requestPointerLock = () => new Promise(res => setTimeout(() => { el = cv; fire(); res(); }, 20));
    document.exitPointerLock = () => { if (el) { el = null; setTimeout(fire, 5); } };
    BF.player.start();
  });
  await require('./lib').toVillage(game);
  const until = (pg, fn, arg, t = 15000) => pg.waitForFunction(fn, arg, { timeout: t, polling: 50 }).then(() => true, () => false);

  // ---- shared reader
  const lm = await game.evaluate(() => {
    const M = BF.logmatch, e = (k, t) => [1, k, t, [1, 2, 3]];
    return {
      wheat: M.matches({ who: 'Farmer', act: 'harvest', text: 'wheat' }, e('farm', 'Ana Reid (Farmer) started harvesting Wheat at 1, 2, 3')),
      carrots: M.matches({ who: 'Farmer', act: 'harvest', text: 'wheat' }, e('farm', 'Ana Reid (Farmer) started harvesting Carrots at 1, 2, 3')),
      forester: M.matches({ who: 'Forester', kind: 'trade' }, e('trade', 'Ana Reid (Builder) traded with Tui Gray (Forester): gave 1 Emerald, got 4 Oak Planks')),
      notForester: M.matches({ who: 'Forester', kind: 'trade' }, e('trade', 'Ana Reid (Builder) traded with Tui Gray (Farmer): gave 1 Emerald, got 4 Bread')),
      anyTrade: M.matches({ kind: 'trade' }, e('trade', 'Player traded with Tui Gray (Farmer): gave 1 Emerald, got 4 Bread')),
      births: M.matches({ kind: 'birth' }, e('birth', 'Ana was born to X and Y')),
    };
  });
  ok('reader: farmer harvesting wheat', lm.wheat && !lm.carrots);
  ok('reader: forester trading', lm.forester && !lm.notForester);
  ok('reader: anyone trading, births', lm.anyTrade && lm.births);
  // ---- locations
  const loc = await game.evaluate(() => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const vs = rec.members.filter(m => m.type === 'villager' && !m.dead && m.position);
    BF.vlog.trade(vs[0], vs[1], 'gave 1 Emerald, got 1 Loc test');
    const a = BF.vlog.entries(rec.key), e = a[a.length - 1];
    return { at: e[3], want: [Math.floor(vs[1].position.x), Math.floor(vs[1].position.y), Math.floor(vs[1].position.z)], parsed: BF.vlog.posOf(null, 'X placed a bed at 4, -5, 6') };
  });
  ok('trade entry carries the seller\'s location ' + JSON.stringify(loc), JSON.stringify(loc.at) === JSON.stringify(loc.want) && JSON.stringify(loc.parsed) === '[4,-5,6]');

  // ---- create an alert on the debug screen
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1100 } });
  dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForTimeout(2000);
  ok('add is disabled with nothing chosen', await dbg.evaluate(() => document.getElementById('a-add').disabled));
  await dbg.selectOption('#a-who', 'Farmer');
  ok('farmer actions include harvesting', await dbg.evaluate(() => [...document.querySelectorAll('#a-act option')].some(o => o.value === 'harvest')));
  await dbg.selectOption('#a-act', 'harvest'); await dbg.fill('#a-text', 'wheat'); await dbg.click('#a-add');
  await dbg.selectOption('#a-who', ''); await dbg.selectOption('#a-act', ''); await dbg.selectOption('#a-kind', 'birth'); await dbg.fill('#a-text', 'test baby'); await dbg.click('#a-add');   // only the test's births: real ones would freeze the game mid-test
  await dbg.waitForTimeout(500);
  ok('table lists both alerts', await dbg.evaluate(() => document.querySelectorAll('#a-body tr[data-id]').length === 2));
  ok('saved to the alerts file', JSON.parse(fs.readFileSync(FILE, 'utf8')).alerts.length === 2);
  ok('game receives the alerts', await until(game, () => BF.alerts.list.length === 2));

  // ---- an alert at 100x, fired from inside the simulation step: frozen at once
  const fired = await game.evaluate(() => new Promise(res => {
    BF.warp.set(4);   // 100x
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const m = rec.members.find(x => x.type === 'villager' && !x.dead && x.position);
    const sky = BF.sky.update;
    let armed = 3;
    BF.sky.update = function (h) {
      sky.call(this, h);
      if (armed > 0 && --armed === 0) { BF.vlog.log(rec, 'birth', 'Test baby was born to A and B', m); window.__at = BF.simNow(); }
    };
    setTimeout(() => { BF.sky.update = sky; res({ at: window.__at, now: BF.simNow(), frozen: BF.warp.frozen, speed: BF.warp.speed, mob: m.position.x }); }, 1500);
  }));
  ok('alert freezes the world mid-frame ' + JSON.stringify(fired), fired.frozen && fired.speed === 0 && fired.at != null && fired.now === fired.at);
  const s1 = await game.evaluate(() => ({ t: BF.simNow(), sky: BF.sky.time, mobs: BF.mobs.list.slice(0, 20).map(m => m.position.x + ',' + m.position.z).join(';') }));
  await game.waitForTimeout(1500);
  const s2 = await game.evaluate(() => ({ t: BF.simNow(), sky: BF.sky.time, mobs: BF.mobs.list.slice(0, 20).map(m => m.position.x + ',' + m.position.z).join(';') }));
  ok('nothing moves at 0x', s1.t === s2.t && s1.sky === s2.sky && s1.mobs === s2.mobs);
  const note = await game.evaluate(() => { const e = document.getElementById('bf-alert'); return { shown: !e.hidden, text: e.textContent, tp: !!e.querySelector('[data-act=tp]'), locked: BF.player.isLocked(), ind: document.getElementById('warp').textContent }; });
  ok('notice shows the log line, distance and Teleport ' + JSON.stringify(note), note.shown && /Test baby was born/.test(note.text) && /\d+ blocks away/.test(note.text) && note.tp);
  ok('mouse freed', !note.locked);
  ok('indicator shows 0x', /0×/.test(note.ind));
  await dbg.waitForTimeout(800);
  ok('debug screen shows it fired', await dbg.evaluate(() => [...document.querySelectorAll('#a-body tr')].some(tr => /1×/.test(tr.textContent) && tr.classList.contains('firing'))));
  await dbg.screenshot({ path: out + '-screen.png', fullPage: true });
  // the player still moves at 0x
  const p0 = await game.evaluate(() => { BF.player.teleport(BF.player.position.x + 30, BF.player.position.y + 12, BF.player.position.z); return BF.player.position.y; });
  await game.waitForTimeout(1200);
  ok('player physics still run at 0x (falls)', await game.evaluate(y => BF.player.position.y < y - 1 || BF.player.flying, p0));
  // Teleport
  await game.click('#bf-alert [data-act=tp]');
  await game.waitForTimeout(400);
  const tp = await game.evaluate(() => { const at = BF.alerts.active.entry[3], p = BF.player.position; return { d: Math.hypot(at[0] + 0.5 - p.x, at[2] + 0.5 - p.z), text: document.getElementById('bf-alert').textContent, locked: BF.player.isLocked(), frozen: BF.warp.frozen }; });
  ok('teleport lands next to the event, still frozen ' + JSON.stringify(tp), tp.d <= 7.5 && tp.frozen && /(^|\D)[0-7] blocks away/.test(tp.text) && tp.locked);
  await game.screenshot({ path: out + '-game.png' });
  // Right: 1x (not the 100x it ran at before), notice gone
  await game.keyboard.press('ArrowRight');
  ok('Right resumes at 1x and dismisses', await until(game, () => BF.warp.speed === 1 && document.getElementById('bf-alert').hidden));
  // an alert while playing with the mouse captured frees it; Right takes it back
  ok('mouse captured before the next alert', await until(game, () => BF.player.isLocked()));
  await game.evaluate(() => { BF.alerts.fire(BF.alerts.list[1], BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), [0, 'birth', 'Test baby again', [0, 0, 0]]); });
  ok('alert frees the mouse without pausing', await until(game, () => !BF.player.isLocked() && !BF.state.paused && BF.warp.frozen));
  await game.keyboard.press('ArrowRight');
  ok('Right dismisses that one too', await until(game, () => BF.warp.speed === 1 && !BF.alerts.active));
  ok('Right takes the mouse back', await until(game, () => BF.player.isLocked()));
  const t0 = await game.evaluate(() => BF.simNow());   // the CI runner can manage only a few frames a second: allow it time
  ok('time runs again', await until(game, t => BF.simNow() > t, t0, 20000));
  // ---- Left at 1x: 0x; Right: 1x
  await game.keyboard.press('ArrowLeft');
  ok('Left at 1x gives 0x', await game.evaluate(() => BF.warp.speed === 0 && BF.warp.frozen));
  await game.keyboard.press('ArrowLeft');
  ok('Left at 0x stays 0x', await game.evaluate(() => BF.warp.speed === 0));
  await game.keyboard.press('ArrowRight');
  ok('Right from 0x gives 1x', await game.evaluate(() => BF.warp.speed === 1));

  // ---- disable, then delete
  await dbg.click('#a-body tr[data-id]:nth-child(2) [data-act=toggle]');
  ok('disable reaches the game', await until(game, () => BF.alerts.list.some(a => a.kind === 'birth' && a.on === false)));
  await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); BF.vlog.log(rec, 'birth', 'Test baby (quiet) was born to A and B'); });
  ok('a disabled alert does not fire', await game.evaluate(() => !BF.warp.frozen && !BF.alerts.active));
  // ---- persistence across a server restart
  srv.kill(); await new Promise(r => srv.once('exit', r));
  srv = await start();
  const st = await (await fetch(`http://localhost:${DBG}/alerts`)).json();
  ok('alerts survive a server restart', st.alerts.length === 2 && st.alerts.some(a => a.on === false));
  await dbg.waitForTimeout(2500);
  await dbg.click('#a-body tr[data-id]:nth-child(1) [data-act=del]');
  ok('delete reaches the game', await until(game, () => BF.alerts.list.length === 1));
  ok('table shows one alert', await dbg.evaluate(() => document.querySelectorAll('#a-body tr[data-id]').length === 1));
  ok('log shows locations', await dbg.evaluate(() => [...document.querySelectorAll('#log .ent .at')].length > 0));

  await b.close(); srv.kill();
  try { fs.unlinkSync(FILE); } catch (e) {}
  console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
