// @ci integration suite=world,village timeout=1800
// Clusters on workers while the game is played (spec r15-39b C8, js/rplay.js kind "clusters", js/cworkers.js): the world server
// (debug/server.js --workers 3 --split always --clusters --verify 100) runs the simulation thread and two follower threads, which keep
// copies of the world from its journal; split, each runs its own clusters with partial copies and they meet every 20 ticks. Seed 3, a
// new world at the village nearest the spawn with 4 more villages simulated (BF.active fixed 4), 20 game minutes at 100x:
//   - the clusters are split over the 3 (F3's "Cluster workers 3"), every worker runs some, the copies' gathered hashes agree at every
//     fifth meeting and never differ;
//   - a save while split waits for a meeting and is written;
//   - back to one (BF.rplay.testSolo): every worker takes the whole world at the next meeting, the cluster tick goes off, then (split
//     always) they split again; still no difference; no ERROR in the workers' game log lines.
// Usage: NODE_PATH=$(npm root -g) node test/cluster-play.js [seed=3]
const { chromium } = require('playwright');
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function server(args) {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)].concat(args || []), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.out = '';
  const stopped = () => { if (/the simulation stopped/.test(srv.out) && !srv.told) { srv.told = true; console.log('FAIL the simulation stopped; server output (last 8000):\n' + srv.out.replace(/^\[builder\].*\n/gm, '').slice(-8000)); process.exit(1); } };
  srv.stdout.on('data', d => { srv.out += d; stopped(); });
  srv.stderr.on('data', d => { srv.out += d; stopped(); });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + srv.out)), 20000);
    const poll = setInterval(() => { if (/listening|serving|http:\/\//i.test(srv.out)) { clearInterval(poll); clearTimeout(t); res(); } }, 200);
    srv.on('exit', c => rej(new Error('debug/server.js exited ' + c + ': ' + srv.out)));
  });
  return { srv, url: 'http://localhost:' + game + '/' };
}
async function open(b, url) {
  const ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
  pg.on('console', m => { if (m.type() === 'error' && !/GL Driver/.test(m.text())) console.log('console.error:', m.text().slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { window.BF_TEST = true; });
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.server || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  return pg;
}
const sim = (pg, fn, arg) => pg.evaluate(([f, a]) => BF.simHost.eval(f, a), [String(fn), arg === undefined ? null : arg]);
async function until(pg, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await sim(pg, fn).catch(() => false)) === true) return true; await new Promise(r => setTimeout(r, 2000)); }
  return false;
}
const status = pg => sim(pg, () => Object.assign(BF.rplay.status(), { text: BF.rplay.text(), checks: BF.rworkers.checks || 0, mismatch: BF.rworkers.mismatch,
  clustered: !!(BF.cworkers && BF.cworkers.active), ctick: !!BF.ctick.on }));
const run = async (pg, minutes) => {
  const day0 = await pg.evaluate(() => { const c = BF.client.world.clock; return c ? c.day + c.time : -1; });
  await pg.evaluate(() => BF.warp.set(4));   // 100x
  const t0 = Date.now();
  await pg.waitForFunction(([d0, m]) => { const c = BF.client.world.clock; return (c && c.day + c.time >= d0 + m / 1200 * 60) || BF.simHost.crashed; }, [day0, minutes], { timeout: 900000, polling: 1000 }).catch(() => {});
  console.log(`  ${minutes} game minutes in ${((Date.now() - t0) / 1000).toFixed(0)} s real`);
  await pg.evaluate(() => BF.warp.set(0));
};

let S = null;
(async () => {
  const b = await chromium.launch();
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cp-'));
  S = await server(['--test', '--saves', saves, '--workers', '3', '--split', 'always', '--clusters', '--verify', '100']);
  const pg = await open(b, S.url + '?sim=server&workers=3');
  check(await pg.evaluate(() => BF.simHost.mode === 'server'), 'the page is the world server\'s client');
  const r = await pg.evaluate(async seed => {
    BF.player.start();
    await BF.save.create({ name: "cluster-play", seed: String(seed), gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    return { village: !!v };
  }, seed);
  check(r.village, 'the player is at the village nearest the spawn');
  await sim(pg, () => { BF.active.set({ on: true, fixed: 4 }); return true; });
  const ready = await until(pg, () => { const s = BF.rplay.status(); return s.followers > 0 && s.ready === s.followers && s.split && BF.cworkers.active; }, 300000);
  const s0 = await status(pg);
  check(ready, `2 followers booted the leader's world and the clusters are split (${s0.text})`);
  await run(pg, 20);
  const crashed = await pg.evaluate(() => BF.simHost.crashed);
  check(!crashed, `no crash${crashed ? ' (' + String(crashed).slice(0, 300) + ')' : ''}`);
  const s1 = await status(pg);
  const groups = s1.stats && s1.stats.groups ? s1.stats.groups : [];
  check(s1.split && s1.clustered && s1.followers === 2, `still split over 3 workers (${s1.text})`);
  check(groups.length === 3 && groups.every(n => n > 0), `every worker runs some clusters (${groups.join('/')})`);
  check(s1.checks > 0 && !s1.mismatch, `the copies were compared ${s1.checks} times at meetings and never differed${s1.mismatch ? ' (' + JSON.stringify(s1.mismatch).slice(0, 300) + ')' : ''}`);
  const f3 = await pg.evaluate(() => new Promise(r => BF.client.query('f3', {}, r)));
  const wt = f3 && (f3.workersText || (f3.f3 && f3.f3.workersText));
  check(/^Cluster workers 3/.test(wt || ''), `F3 says ${JSON.stringify(wt)}`);
  // a save while split (at the next meeting)
  await pg.evaluate(() => BF.warp.set(2));
  const saved = await pg.evaluate(() => BF.save.saveNow());
  check(saved === true, `a save while split is written (${saved})`);
  // back to one, then split again
  await sim(pg, () => { BF.rplay.testSolo(); return true; });
  const one = await until(pg, () => !BF.cworkers.active && !BF.ctick.on, 120000);
  check(one, 'back to one: the workers took the whole world at a meeting and the cluster tick went off');
  const again = await until(pg, () => BF.rplay.status().split && BF.cworkers.active, 120000);
  check(again, 'split=always: split again');
  await run(pg, 5);
  const s2 = await status(pg);
  check(s2.split && !s2.mismatch && s2.checks > s1.checks, `split again, the copies still agree (${s2.checks} checks; ${s2.text})`);
  const lines = await pg.evaluate(() => BF.glog.entries().filter(e => e.k === 'workers').map(e => e.l + ' ' + e.x));
  check(lines.some(l => /clusters are split/i.test(l)) && !lines.some(l => /^ERROR/.test(l)), `the game log has the workers' lines, no errors (${lines.slice(-3).join(' | ').slice(0, 300)})`);
  for (const l of lines) if (/^ERROR/.test(l)) console.log('  ' + l.slice(0, 1200));
  await pg.context().close();
  S.srv.kill();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); if (S) console.error('server output (last 6000):\n' + S.srv.out.slice(-6000)); process.exit(1); });
