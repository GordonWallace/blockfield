// @ci integration suite=world,village timeout=1800
// Region workers while the game is played (spec r15-39, js/rplay.js): the simulation worker leads, its followers (Web Workers from
// js/regionworker.js, Node worker threads from server/regionthread.js on the world server) hold copies of the world made from the
// leader's journal. Served over http (debug/server.js on free ports, as ./run.sh serves the game), seed 3:
//   - ?sim=worker&workers=3&split=always&verify=20: a new world at the village nearest the spawn, half a game hour at 100x. The two
//     followers boot the leader's world (the same hash), the regions are split over the three, the copies are compared every 20
//     ticks and never differ; F3 says "Workers 3", the game log has the workers' lines;
//   - paused, the leader's state hash matches a follower's (the journal brought it the player's packets, commands, chunk loads);
//   - a follower that crashes while split stops the simulation: the page shows the crash, naming the region worker;
//   - the world server (--workers 3 --split always --verify 20) splits the same way with Node threads, 20 game minutes.
// Every copy is also compared every 20 ticks while one worker thinks, before the split (js/rplay.js soloCheck).
// Usage: NODE_PATH=$(npm root -g) node test/multi-worker-play.js [seed=3]
const path = require('path'), cp = require('child_process'), net = require('net'), fs = require('fs'), os = require('os');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function server(args) {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)].concat(args || []), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.out = '';
  srv.stdout.on('data', d => { srv.out += d; });
  srv.stderr.on('data', d => { srv.out += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + srv.out)), 20000);
    const on = () => { if (/Ctrl\+C/.test(srv.out)) { clearTimeout(t); res(); } };
    srv.stdout.on('data', on);
    srv.on('exit', c => rej(new Error('debug/server.js exited ' + c + ': ' + srv.out)));
  });
  return { srv, url: 'http://localhost:' + game + '/index.html', debug: 'http://localhost:' + debug };
}

async function open(b, url) {
  const ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
  pg.on('console', m => { if (m.type() === 'error' && !/GL Driver/.test(m.text())) console.log('console.error:', m.text().slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { window.BF_TEST = true; });   // (the eval query where the simulation runs: BF.simHost.eval)
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.server || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  return pg;
}
const sim = (pg, fn, arg) => pg.evaluate(([f, a]) => BF.simHost.eval(f, a), [String(fn), arg === undefined ? null : arg]);
// polls fn where the simulation runs until it returns something truthy (false after ms)
async function until(pg, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await sim(pg, fn).catch(() => false)) === true) return true; await new Promise(r => setTimeout(r, 2000)); }
  return false;
}
const status = pg => sim(pg, () => Object.assign(BF.rplay.status(), { text: BF.rplay.text(), checks: BF.rworkers.checks || 0, mismatch: BF.rworkers.mismatch, crashed: null }));

// A new world at the village nearest the spawn, then `minutes` game minutes at 100x; returns the status after it.
async function play(pg, label, minutes) {
  const r = await pg.evaluate(async seed => {
    BF.player.start();
    await BF.save.create({ name: "multi-worker", seed: String(seed), gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    return { village: !!v };
  }, seed);
  check(r.village, `${label}: the player is at the village nearest the spawn`);
  const ready = await until(pg, () => { const s = BF.rplay.status(); return s.followers > 0 && s.ready === s.followers && s.split; }, 300000);
  const s0 = await status(pg);
  check(ready, `${label}: ${s0.followers} followers booted the leader's world and the regions are split (${s0.text})`);
  const day0 = await pg.evaluate(() => { const c = BF.client.world.clock; return c ? c.day + c.time : -1; });
  await pg.evaluate(() => BF.warp.set(4));   // 100x
  const t0 = Date.now();
  await pg.waitForFunction(([d0, m]) => { const c = BF.client.world.clock; return (c && c.day + c.time >= d0 + m / 1200 * 60) || BF.simHost.crashed; }, [day0, minutes], { timeout: 900000, polling: 1000 }).catch(() => {});
  console.log(`${label}: ${minutes} game minutes in ${((Date.now() - t0) / 1000).toFixed(0)} s real`);
  await pg.evaluate(() => { BF.warp.set(0); BF.state.paused = true; });
  await pg.waitForTimeout(1500);
  const crashed = await pg.evaluate(() => BF.simHost.crashed);
  check(!crashed, `${label}: no crash${crashed ? ' (' + String(crashed).slice(0, 300) + ')' : ''}`);
  return status(pg);
}

(async () => {
  const b = await chromium.launch();
  // ---- the browser: Web Workers
  const { srv, url } = await server();
  const pg = await open(b, url + '?sim=worker&workers=3&split=always&verify=20');
  const mode = await pg.evaluate(() => BF.simHost.mode);
  check(/worker/.test(mode), `the simulation runs in a worker (${mode})`);
  const s = await play(pg, 'browser', 30);
  check(s.split && s.followers === 2, `browser: still split over 3 workers after the half hour (${s.text})`);
  check(s.checks > 0 && !s.mismatch, `browser: the copies were compared ${s.checks} times and never differed${s.mismatch ? ' (' + JSON.stringify(s.mismatch).slice(0, 300) + ')' : ''}`);
  const mobs = s.stats && s.stats.workers ? s.stats.workers.map(w => w.mobs) : [];
  check(mobs.length === 3 && mobs.every(n => n > 0), `browser: every worker thinks for some of the mobs (${mobs.join('/')})`);
  const f3 = await pg.evaluate(() => new Promise(r => BF.client.query('f3', {}, r)));
  const wt = f3 && (f3.workersText || (f3.f3 && f3.f3.workersText));
  check(/^Workers 3/.test(wt || ''), `browser: F3 says ${JSON.stringify(wt)}`);
  const lines = await pg.evaluate(() => BF.glog.entries().filter(e => e.k === 'workers').map(e => e.l + ' ' + e.x));   // (the worker's entries come to the page's log)
  check(lines.some(l => /split/i.test(l)) && !lines.some(l => /^ERROR/.test(l)), `browser: the game log has the workers' lines, no errors (${lines.slice(-3).join(' | ').slice(0, 300)})`);
  // paused: a follower's copy is the leader's (the hash checks compare whole states; one more on demand)
  const same = await sim(pg, () => { const RW = BF.rworkers; return { checks: RW.checks, mismatch: RW.mismatch }; });
  check(!same.mismatch, `browser: paused, the leader and the followers agree`);
  // the crash path: a follower throws while split
  await pg.evaluate(() => { BF.state.paused = false; BF.warp.set(2); });
  await sim(pg, () => BF.rplay.testCrash(1));
  const crashed = await pg.waitForFunction(() => BF.simHost.crashed, null, { timeout: 120000, polling: 500 }).then(h => h.jsonValue(), () => null);
  check(/region worker|worker 1/i.test(String(crashed || '')), `browser: a follower's crash stops the simulation and says so (${String(crashed).split('\n')[0].slice(0, 200)})`);
  await pg.context().close();
  srv.kill();

  // ---- the world server: Node worker threads
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-mw-'));
  const S = await server(['--test', '--saves', saves, '--workers', '3', '--split', 'always', '--verify', '20']);
  const sp = await open(b, S.url + '?sim=server&workers=3');   // (an automated page asks for one region worker unless its URL says)
  check(await sp.evaluate(() => BF.simHost.mode === 'server'), 'server: the page is the world server\'s client');
  const ss = await play(sp, 'server', 20);
  check(ss.split && ss.followers === 2 && !ss.mismatch, `server: split over 3 threads, the copies agree (${ss.text})`);
  await sp.context().close();
  S.srv.kill();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
