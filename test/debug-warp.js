// @ci integration suite=ui timeout=600 args={out} hosts=worker,server
// Fast-forward from the debug screen (debug/warp.js): the Left / Right arrow keys there step the game's speed as they do in the game
// (quick presses all count, Right from 0x gives 1x, Left from 1x gives 0x), the speed buttons set it, the keys do nothing while a text
// field or a dropdown has the focus, the bar shows the speed asked for and the speed reached as the game's indicator does, the simulation
// runs at the new speed wherever it is, and each change writes a game log line.
// BF_HOST=page|worker|server (spec r15-43): where the simulation runs; its speed is checked there (lib.sim).
// Usage: NODE_PATH=$(npm root -g) node test/debug-warp.js [outPrefix]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-warp';
(async () => {
  const t0 = Date.now(), fails = [], ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + '[' + ((Date.now() - t0) / 1000).toFixed(1) + ' s] ' + n + (!c && x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails.push(n); };
  const srv = await lib.serve({ world: lib.host() === 'server' });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1024, height: 640 } });
  game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await lib.install(game);   // (BFT.sim)
  await game.goto(`http://localhost:${srv.game}/?nolod&${lib.q()}#seed123`);
  await game.waitForTimeout(4000);
  await lib.simReady(game);
  await game.evaluate(() => BF.player.start && BF.player.start());   // past the title screen (debug steps are ignored there, as the keys are)
  const until = (pg, fn, arg, t = 20000) => pg.waitForFunction(fn, arg, { timeout: t, polling: 100 }).then(() => true, () => false);
  const simSpeed = () => lib.sim(game, () => BF.warp.speed);
  const simAt = async (v, t = 20000) => { for (const end = Date.now() + t; Date.now() < end; await game.waitForTimeout(250)) if (await simSpeed() === v) return true; return false; };

  const dbg = await b.newPage({ viewport: { width: 1600, height: 900 } });
  dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${srv.debug}/`);
  ok('the bar shows the game at 1x', await until(dbg, () => document.querySelector('#ff [data-speed="1"].on') && /1x/.test(document.getElementById('ff-now').textContent)));

  // two quick presses: both arrive, in order
  await dbg.keyboard.press('ArrowRight'); await dbg.keyboard.press('ArrowRight');
  ok('two Rights on the debug screen give 5x in the game', await until(game, () => BF.warp.speed === 5), await game.evaluate(() => BF.warp.speed));
  ok('the simulation runs at 5x', await simAt(5), await simSpeed());
  ok('the bar shows 5x', await until(dbg, () => document.querySelector('#ff [data-speed="5"].on') && /▶▶ 5x/.test(document.getElementById('ff-now').textContent)));

  // a text field or a dropdown keeps its arrow keys
  await dbg.focus('#a-text'); await dbg.keyboard.press('ArrowRight');
  await dbg.focus('#a-who'); await dbg.keyboard.press('ArrowLeft');
  await dbg.evaluate(() => document.activeElement.blur());
  await game.waitForTimeout(1500);
  ok('arrow keys in a text field or dropdown leave the speed alone', await game.evaluate(() => BF.warp.speed) === 5);

  // buttons
  await dbg.click('#ff [data-speed="0"]');
  ok('the 0x button freezes the game', await until(game, () => BF.warp.frozen));   // (not checked with lib.sim: a frozen world answers it late)
  ok('the bar shows 0x (frozen)', await until(dbg, () => /0x \(frozen\)/.test(document.getElementById('ff-now').textContent)));
  await dbg.keyboard.press('ArrowRight');
  ok('Right from 0x gives 1x', await until(game, () => BF.warp.speed === 1 && !BF.warp.frozen));
  await dbg.keyboard.press('ArrowLeft');
  ok('Left from 1x gives 0x', await until(game, () => BF.warp.frozen));
  await dbg.click('#ff [data-op="faster"]');
  ok('the ▶ button steps up', await until(game, () => BF.warp.speed === 1));

  // the speed reached: at 1000x under software rendering the simulation can't keep up, and the bar shows what it reaches in brackets
  await dbg.click('#ff [data-speed="1000"]');
  ok('the 1000x button reaches the game', await until(game, () => BF.warp.speed === 1000));
  ok('the bar shows the speed reached, as the game does', await until(dbg, () => /^▶▶ 1000x \([\d.]+x\)$/.test(document.getElementById('ff-now').textContent), null, 30000),
    await dbg.evaluate(() => document.getElementById('ff-now').textContent));
  const both = await game.evaluate(() => ({ badge: document.getElementById('warp').textContent }));
  const bar = await dbg.evaluate(() => document.getElementById('ff-now').textContent);
  console.log('game badge: ' + both.badge + '   debug bar: ' + bar);
  await dbg.screenshot({ path: out + '-bar.png', clip: { x: 0, y: 0, width: 1600, height: 60 } });
  await dbg.click('#ff [data-speed="1"]');
  ok('back to 1x', await until(game, () => BF.warp.speed === 1));

  // the game log
  const lines = await lib.sim(game, () => BF.glog.recent(1e5).map(e => BF.glog.text([e])).filter(t => /from the debug screen/.test(t)));
  // (the first steps can come before the world the page starts, whose log begins afresh: not counted)
  ok('each change is in the game log (' + lines.length + ' lines)', lines.length >= 6 && lines.some(t => /INFO/.test(t) && /1x -> 1000x/.test(t)) && lines.some(t => /1000x -> 1x/.test(t)), lines.slice(-3));

  await b.close(); await srv.stop();
  console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
