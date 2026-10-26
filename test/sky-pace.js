// @ci integration suite=world timeout=600
// The page's drawing clock follows the simulation worker's pace (js/simhost.js ticks): served over http (debug/server.js on free
// ports, as ./run.sh serves it), seed 3, ?sim=worker. The worker is held back (its frame budget cut to 1 ms, so it runs one tick a loop)
// and the page asks for 1000x, which the worker can't reach; then:
//   - the page's drawing clock (BF.simNow) moves on about as far as the worker's clock did (it once ran at 1000x, the sky and clouds
//     racing between the worker's clock messages and snapping back at each one);
//   - the sky drawn each frame (BF.sky day + time) barely steps back: the backward snaps at clock messages are under 10% of its travel;
//   - the game log says the drawing follows the pace it measured;
//   - at 1x, which the held-back worker still reaches, the drawing clock keeps real time.
// Usage: NODE_PATH=$(npm root -g) node test/sky-pace.js [seed=3]
const path = require('path'), cp = require('child_process'), net = require('net');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function server() {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + out)), 20000);
    srv.stdout.on('data', d => { out += d; if (/Ctrl\+C/.test(out)) { clearTimeout(t); res(); } });
    srv.on('exit', c => rej(new Error('debug/server.js exited ' + c + ': ' + out)));
  });
  return { srv, url: 'http://localhost:' + game + '/index.html' };
}

// Measures `secs` real seconds at the page's current speed: the drawing clock's travel, the worker's (from its clock messages' ticks),
// and the sky drawn each frame (its forward travel and backward steps, in game seconds).
const measure = (pg, secs) => pg.evaluate(secs => new Promise(done => {
  const S = BF.sky, W = BF.warp, at = () => (S.day + S.time) * S.dayLength, tk = () => BF.client.world.clock ? BF.client.world.clock.tick : 0;
  const c0 = BF.simNow(), k0 = tk(), t0 = performance.now();
  let prev = at(), fwd = 0, back = 0, maxBack = 0;
  const step = () => {
    const a = at(), d = a - prev;
    prev = a;
    if (d >= 0) fwd += d; else { back -= d; maxBack = Math.max(maxBack, -d); }
    if (performance.now() - t0 < secs * 1000) return requestAnimationFrame(step);
    done({ real: (performance.now() - t0) / 1000, page: BF.simNow() - c0, worker: (tk() - k0) * W.TICK, fwd, back, maxBack });
  };
  requestAnimationFrame(step);
}), secs);

(async () => {
  const { srv, url } = await server();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 480, height: 300 } });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
    const pg = await ctx.newPage();
    pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
    await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
    await pg.addInitScript(() => { window.BF_TEST = true; });   // (the eval query in the worker: BF.simHost.eval)
    await pg.goto(url + '?sim=worker&debugfeed=off#seed' + seed);
    await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
    await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
    check(await pg.evaluate(() => BF.simHost.worker), 'the simulation runs in the worker');
    await pg.evaluate(async seed => {
      BF.player.start();
      await BF.save.create({ name: 'sky-pace', seed: String(seed), gameMode: 'creative', villages: 10 });
      BF.player.setFlying(true);
      BF.renderer.render = () => {};   // (drawing off: the software renderer would take the machine; the sky is still worked out every frame)
    }, seed);
    await pg.waitForTimeout(5000);
    await pg.evaluate(() => BF.simHost.eval(String(() => { BF.warp.BUDGET_MS = 1; return true; }), null));   // the worker runs one tick a loop

    // 1x: the held-back worker keeps up, and so does the drawing clock
    const one = await measure(pg, 5);
    console.log('1x:', JSON.stringify(one));
    check(Math.abs(one.page - one.real) < one.real * 0.1, `at 1x the drawing clock keeps real time (${one.page.toFixed(2)} game s in ${one.real.toFixed(2)} s)`);

    // 1000x: the worker falls far behind; the drawing follows it
    await pg.evaluate(() => BF.warp.set(5));
    await pg.waitForTimeout(3000);
    const ff = await measure(pg, 6);
    console.log('1000x:', JSON.stringify(ff));
    check(ff.worker > 0 && ff.worker < ff.real * 500, `the held-back worker can't reach 1000x (${(ff.worker / ff.real).toFixed(1)}x)`);
    check(ff.page > ff.worker * 0.5 && ff.page < ff.worker * 1.5, `the drawing clock follows the worker (${ff.page.toFixed(1)} game s drawn, ${ff.worker.toFixed(1)} simulated)`);
    check(ff.back < ff.fwd * 0.1, `the sky barely steps back (${ff.back.toFixed(1)} game s back against ${ff.fwd.toFixed(1)} forward, largest ${ff.maxBack.toFixed(2)})`);
    const told = await pg.evaluate(() => BF.glog.recent(500).filter(e => e.k === 'worker' && /^Fast-forward 1000x: the simulation keeps up about/.test(e.x)).map(e => e.l + ' ' + e.x));
    check(told.length === 1 && /^INFO/.test(told[0]), `the game log says so (${told[0] || 'nothing'})`);
    await pg.evaluate(() => BF.warp.set(0));
  } catch (e) { console.log('FAIL', e.stack || e); fails++; }
  await b.close(); srv.kill();
  console.log(fails ? fails + ' failed' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
