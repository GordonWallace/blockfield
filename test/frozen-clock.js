// @ci integration suite=world,ui timeout=900
// bug-076: with the world frozen (0x), /time set and /weather show on the page at once with the simulation off the page too: the
// protocol's clock message goes whenever the time or the weather differs from the last one sent while nothing ticks. Seed 3, once per
// host (default page,worker): frozen, /time set midnight and /weather thunder; within 2 s the page's sky time and weather type are the
// simulation's.
// Usage: NODE_PATH=$(npm root -g) node test/frozen-clock.js [hosts=page,worker]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib.js');
const root = path.resolve(__dirname, '..');
const HOSTS = (process.argv[2] || 'page,worker').split(',');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); if (!ok) fails++; };
async function run(b, srv, host) {
  const ctx = await b.newContext({ viewport: { width: 900, height: 700 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { console.log('PAGEERROR', (e.stack || e.message).slice(0, 300)); fails++; });
  await lib.install(pg);
  await pg.goto(srv.url + '?nolod&sim=' + host + '#seed=3');
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await lib.ready(pg); await lib.simReady(pg);
  await pg.evaluate(() => { BF.state.paused = false; BF.warp.freeze(); });
  await pg.waitForTimeout(1000);
  await pg.evaluate(async () => { for (const c of ['/time set midnight', '/weather thunder']) { const r = BF.commands.execute(c); if (r.done) await r.done; } });
  await pg.waitForTimeout(2000);
  const page = await pg.evaluate(() => ({ time: BF.sky.time, weather: BF.weather.type, frozen: BF.warp.frozen }));
  const sim = await lib.sim(pg, () => ({ time: BF.sky.time, weather: BF.weather.type }));
  check(page.frozen && Math.abs(page.time - sim.time) < 0.01, host + ': the page shows /time set while frozen', { page, sim });
  check(page.weather === 'thunder' && sim.weather === 'thunder', host + ': the page shows /weather while frozen', { page, sim });
  await ctx.close();
}
(async () => {
  const srv = await lib.serve({ world: false });
  const b = await chromium.launch();
  for (const h of HOSTS) await run(b, srv, h);
  await b.close(); await srv.stop();
  console.log(fails ? fails + ' FAILED' : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
