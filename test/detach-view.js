// @ci integration suite=ui timeout=600 args={out} hosts=page,worker,server
// The detached view (r15-98, Gordon 2026-11-04): /detach (and the debug screen's Mobs map button) lets the camera fly apart from the
// body while the game keeps the player where they were. Checked: the body and the simulation's player stay put while the view flies
// (keys move the view, not the body); the simulation loads no chunk under the view (with the simulation in a worker or on the world
// server the page's own copy draws terrain there, in the page nothing new loads); the debug screen's map shows the view; /detach again,
// and the button, bring it back; INFO game log lines each way, an ERROR when refused (the title screen).
// BF_HOST=page|worker|server: where the simulation runs. BF_CLUSTERS=1 (server only): 3 cluster workers split always.
// Usage: NODE_PATH=$(npm root -g) node test/detach-view.js [outPrefix]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
(async () => {
  const t0 = Date.now(), fails = [], ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + '[' + ((Date.now() - t0) / 1000).toFixed(1) + ' s] ' + n + (!c && x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails.push(n); };
  const host = lib.host(), clusters = process.env.BF_CLUSTERS === '1' && host === 'server';
  const srv = await lib.serve({ world: host === 'server', args: clusters ? ['--workers', '3', '--split', 'always', '--clusters'] : [] });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const done = async code => { await b.close(); await srv.stop(); process.exit(code); };
  try {
    const game = await b.newPage({ viewport: { width: 800, height: 500 } });
    game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
    await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await game.route('https://fonts.**', r => r.abort());
    await lib.install(game);
    await game.goto(`http://localhost:${srv.game}/?nolod&${lib.q()}${clusters ? '&workers=3' : ''}#seed123`);
    await game.waitForTimeout(3000);
    await lib.simReady(game);
    const run = cmd => game.evaluate(c => { const x = BF.commands.execute(c); return x.done ? x.done : x; }, cmd);
    // refused on the title screen, with an ERROR line
    const early = await run('/detach');
    ok('refused on the title screen', !early.ok && !(await game.evaluate(() => BF.player.detached)), early);
    const errLine = () => BF.glog.recent(300).some(e => e.k === 'view' && e.l === 'ERROR');   // (on the world server the page's lines go to its log)
    ok('an ERROR game log line for the refusal', await game.evaluate(errLine) || await lib.sim(game, errLine));
    await game.evaluate(() => BF.player.start && BF.player.start());
    if (clusters) { await game.evaluate(() => BF.save.create({ name: 'detach-view', seed: '123', gameMode: 'creative' })); await lib.simReady(game); }
    await game.evaluate(() => { BF.player.gameMode = 'creative'; if (BF.player.setFlying) BF.player.setFlying(true); });
    await game.waitForFunction(() => BF.world.isLoaded(BF.player.position.x, BF.player.position.z), null, { timeout: 120000 });
    await game.waitForTimeout(2000);
    const body0 = await game.evaluate(() => { const p = BF.player.position; return { x: p.x, y: p.y, z: p.z, yaw: BF.player.yaw }; });

    // 1. /detach: the view flies with the keys, the body doesn't move
    const r1 = await run('/detach');
    ok('/detach answers ok', r1.ok && /detached/i.test(r1.msg), r1);
    ok('detached', await game.evaluate(() => BF.player.detached));
    ok('an INFO game log line', await game.evaluate(() => BF.glog.recent(200).some(e => e.k === 'view' && e.l === 'INFO' && /View detached/.test(e.x))));
    await game.keyboard.down('KeyW'); await game.keyboard.down('Space');
    await game.waitForTimeout(2500);
    await game.keyboard.up('KeyW'); await game.keyboard.up('Space');
    const fly = await game.evaluate(() => { const p = BF.player.position, v = BF.player.viewPos(), c = BF.camera.position; return { body: { x: p.x, y: p.y, z: p.z }, view: { x: v.x, y: v.y, z: v.z }, cam: { x: c.x, y: c.y, z: c.z }, yaw: BF.player.yaw }; });
    const moved = Math.hypot(fly.view.x - body0.x, fly.view.z - body0.z) + Math.abs(fly.view.y - body0.y);
    ok('the keys move the view', moved > 1, { body0, fly });
    ok('the body stays where it was', Math.hypot(fly.body.x - body0.x, fly.body.y - body0.y, fly.body.z - body0.z) < 0.01 && fly.yaw === body0.yaw, { body0, fly });
    ok('the camera is at the view', Math.hypot(fly.cam.x - fly.view.x, fly.cam.y - fly.view.y, fly.cam.z - fly.view.z) < 0.01, fly);

    // 2. far off, over chunks the simulation hasn't loaded: they stay unloaded there
    const spot = await lib.sim(game, b0 => {
      for (let d = 700; d < 3000; d += 50) for (const a of [0, 1.6, 3.1, 4.7]) {
        const x = b0.x + Math.cos(a) * d, z = b0.z + Math.sin(a) * d, c = BF.planet.canon(x, z, {});
        if (c.off) continue;
        if (!BF.world.chunks.has(Math.floor(c.x / 16) + ',' + Math.floor(c.z / 16))) return { x: c.x, z: c.z };
      }
      return null;
    }, body0);
    ok('a spot the simulation has not loaded', !!spot, spot);
    if (spot) {
      await game.evaluate(s => BF.player.setView(s.x, BF.worldgen.heightAt(Math.floor(s.x), Math.floor(s.z)) + 30, s.z, 0, -0.5), spot);
      await game.waitForTimeout(12000);
      const key = Math.floor(spot.x / 16) + ',' + Math.floor(spot.z / 16);
      const simSide = await lib.sim(game, k => ({ has: BF.world.chunks.has(k), p: { x: BF.player.position.x, y: BF.player.position.y, z: BF.player.position.z }, det: BF.player.detView }), key);
      ok('the simulation loaded no chunk under the view', !simSide.has, simSide);
      ok('the simulation still has the player where they were', Math.hypot(simSide.p.x - body0.x, simSide.p.z - body0.z) < 0.5, { simSide, body0 });
      ok('the simulation side knows the view (for the map)', Array.isArray(simSide.det) && Math.abs(simSide.det[0] - spot.x) < 1, simSide);
      const pageHas = await game.evaluate(k => BF.world.chunks.has(k), key);
      if (host === 'page') ok('in the page nothing loads under the view (the world is the simulation\'s)', !pageHas);
      else ok('the page\'s own copy draws the terrain under the view', pageHas);
    }

    // 3. the debug screen: the map shows the view; its button brings the view back and detaches it again
    const dbg = await b.newPage({ viewport: { width: 1600, height: 900 } });
    dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
    await dbg.route('https://fonts.**', r => r.abort());
    await dbg.goto(`http://localhost:${srv.debug}/`);
    ok('the map says the view is detached', await dbg.waitForFunction(() => /view detached \(/.test(document.getElementById('m-count').textContent), null, { timeout: 60000 }).then(() => true, () => false),
      await dbg.evaluate(() => document.getElementById('m-count').textContent));
    ok('the button reads Attach view', await dbg.evaluate(() => document.getElementById('m-detach').textContent === 'Attach view'));
    await dbg.click('#m-detach');
    ok('the button attaches the view again', await game.waitForFunction(() => !BF.player.detached, null, { timeout: 30000 }).then(() => true, () => false));
    const back = await game.evaluate(() => { const p = BF.player.position, c = BF.camera.position; return { d: Math.hypot(c.x - p.x, c.z - p.z), y: c.y - p.y }; });
    ok('the camera is back at the body', back.d < 0.5 && back.y > 1 && back.y < 2, back);
    ok('an INFO line for attaching', await game.evaluate(() => BF.glog.recent(300).some(e => e.k === 'view' && e.l === 'INFO' && /View attached again/.test(e.x))));
    ok('the map shows it attached', await dbg.waitForFunction(() => !/view detached/.test(document.getElementById('m-count').textContent) && document.getElementById('m-detach').textContent === 'Detach view', null, { timeout: 30000 }).then(() => true, () => false));
    await dbg.click('#m-detach');
    ok('the button detaches it', await game.waitForFunction(() => BF.player.detached, null, { timeout: 30000 }).then(() => true, () => false));
    const r2 = await run('/detach');
    ok('/detach again brings it back', r2.ok && !(await game.evaluate(() => BF.player.detached)), r2);
    const end = await lib.sim(game, () => ({ x: BF.player.position.x, z: BF.player.position.z }));
    ok('the player never moved in the simulation', Math.hypot(end.x - body0.x, end.z - body0.z) < 0.5, { end, body0 });
    if (process.argv[2]) await game.screenshot({ path: process.argv[2] + '-game.png' }).catch(() => {});
  } catch (e) { console.log('FAIL exception', e && e.stack || e); fails.push('exception'); }
  console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL PASS');
  await done(fails.length ? 1 : 0);
})();
