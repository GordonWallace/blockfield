// @ci integration suite=world,village timeout=1800
// Clusters on workers while the game is played (spec r15-39b C8, js/rplay.js kind "clusters", js/cworkers.js): the world server
// (debug/server.js --workers 3 --split always --clusters --verify 100) runs the simulation thread and two follower threads, which keep
// copies of the world from its journal; split, each runs its own clusters with partial copies and they meet every BF.ctick.MEET
// ticks. Seed 3, a new world at the village nearest the spawn with 4 more villages simulated (BF.active fixed 4, within 4000 blocks),
// 10 game minutes at 100x (CP_MINUTES):
//   - the clusters are split over the 3 (F3's "Cluster workers 3"), every worker runs some, the copies' gathered hashes agree at every
//     fifth meeting and never differ;
//   - a save while split waits for a meeting and is written;
//   - back to one (BF.rplay.testSolo): every worker takes the whole world at the next meeting, the leader runs every cluster, then (split
//     always) they split again; still no difference; no ERROR in the workers' game log lines.
// Usage: NODE_PATH=$(npm root -g) node test/cluster-play.js [seed=3]
const { chromium } = require('playwright');
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const servers = [];   // (killed on any exit: a failed or timed-out run otherwise leaves its world server simulating, and the next runs crawl)
process.on('exit', () => { for (const s of servers) try { s.kill('SIGKILL'); } catch (e) {} });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(1));
async function server(args) {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)].concat(args || []), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.out = '';
  servers.push(srv);
  const stopped = () => { if (/the simulation stopped/.test(srv.out) && !srv.told) { srv.told = true; console.log('FAIL the simulation stopped; server output (last 8000):\n' + srv.out.replace(/^\[builder\].*\n/gm, '').slice(-8000)); process.exit(1); } };
  srv.stdout.on('data', d => { srv.out += d; stopped(); });
  srv.stderr.on('data', d => { srv.out += d; stopped(); });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + srv.out)), 20000);
    const poll = setInterval(() => { if (/listening|serving|http:\/\//i.test(srv.out)) { clearInterval(poll); clearTimeout(t); res(); } }, 200);
    srv.on('exit', c => rej(new Error('debug/server.js exited ' + c + ': ' + srv.out)));
  });
  return { srv, url: 'http://localhost:' + game + '/', debug: 'http://localhost:' + debug + '/' };
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
// (a simulation that stopped answering fails the call after 200 s (past the workers' 120 s barrier timeout, js/rworkers.js) instead of hanging the test)
const sim = (pg, fn, arg) => Promise.race([pg.evaluate(([f, a]) => BF.simHost.eval(f, a), [String(fn), arg === undefined ? null : arg]),
  new Promise((_, rej) => setTimeout(() => rej(new Error('the simulation did not answer in 200 s')), 200000))]);
async function until(pg, fn, ms, trace) {
  // One question at a time, each waited for however late it answers (within sim's 200 s): a busy simulation answers in order, so asking
  // again every 30 s only queued more questions and threw away answers that came back after 30 s (CI: "slow to answer" for minutes
  // while the clusters were in fact split).
  const t0 = Date.now();
  let told = t0, pend = null, asked = 0, slowest = 0;
  const late = () => new Promise(r => setTimeout(() => r('late'), 30000));
  while (Date.now() - t0 < ms) {
    if (!pend) { asked = Date.now(); pend = sim(pg, fn).catch(() => false); }
    const r = await Promise.race([pend, late()]);
    if (r !== 'late') { pend = null; slowest = Math.max(slowest, Date.now() - asked); if (r === true) return true; }
    if (trace && Date.now() - told >= 30000) {   // (where it is while waiting: a slow host's log says which step takes the time)
      told = Date.now();
      const s = r === 'late' ? '(the simulation has not answered for ' + ((Date.now() - asked) / 1000).toFixed(0) + ' s)' : await sim(pg, () => BF.rplay.text()).catch(e => 'no answer: ' + e.message);
      console.log(`  ${trace} ${((told - t0) / 1000).toFixed(0)} s: ${s}${slowest > 5000 ? ' (slowest answer ' + (slowest / 1000).toFixed(0) + ' s)' : ''}`);
      if (r === 'late' && S) {   // (what the server printed meanwhile: a simulation busy for minutes says what with)
        const out = S.srv.out.slice(S.srv.seen || 0).replace(/^\[(builder|breeding)\].*\n/gm, '');
        S.srv.seen = S.srv.out.length;
        if (out.trim()) console.log('    server: ' + out.slice(-1200).trim().replace(/\n/g, '\n    server: '));
      }
    }
    if (r !== 'late') await new Promise(r => setTimeout(r, 2000));
  }
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

let S = null, PG = null;
(async () => {
  const b = await chromium.launch();
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cp-'));
  S = await server(['--test', '--saves', saves, '--workers', '3', '--split', 'always', '--clusters', '--verify', process.env.CP_VERIFY || '100']);
  const pg = await open(b, S.url + '?sim=server&workers=3');
  PG = pg;
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
  await sim(pg, () => { BF.active.set({ on: true, fixed: 4, reach: 4000 }); return true; });
  const tr = Date.now();
  const ready = await until(pg, () => { const s = BF.rplay.status(); return s.followers > 0 && s.ready === s.followers && s.split && BF.cworkers.active; }, 300000, 'first split');
  const s0 = await status(pg);
  check(ready, `2 followers booted the leader's world and the clusters are split (${((Date.now() - tr) / 1000).toFixed(0)} s; ${s0.text})`);
  await run(pg, +(process.env.CP_MINUTES || 10));
  const crashed = await pg.evaluate(() => BF.simHost.crashed);
  check(!crashed, `no crash${crashed ? ' (' + String(crashed).slice(0, 300) + ')' : ''}`);
  const s1 = await status(pg);
  const groups = s1.stats && s1.stats.groups ? s1.stats.groups : [];
  if (!s1.split || !s1.clustered) {   // (why the split ended: the workers' game log lines)
    const wl = await sim(pg, () => BF.glog.entries().filter(e => e.k === 'workers' || e.k === 'clusters').map(e => e.l + ' ' + e.x));
    for (const l of wl.slice(-20)) console.log('  log: ' + l.slice(0, 600));
    console.log('  status: ' + JSON.stringify(s1).slice(0, 800));
  }
  check(s1.split && s1.clustered && s1.followers === 2, `still split over 3 workers (${s1.text})`);
  // (not every worker: the player's group, on the first worker, reaches the view and the player's run since the last meeting, so
  // with 4 simulated villages one follower may be left idle when the first worker is the slowest anyway, js/cworkers.js plan)
  check(groups.length === 3 && groups[0] > 0 && groups.slice(1).some(n => n > 0), `the followers run some clusters (${groups.join('/')})`);
  check(s1.checks > 0 && !s1.mismatch, `the copies were compared ${s1.checks} times at meetings and never differed${s1.mismatch ? ' (' + JSON.stringify(s1.mismatch).slice(0, 300) + ')' : ''}`);
  const f3 = await pg.evaluate(() => new Promise(r => BF.client.query('f3', {}, r)));
  const wt = f3 && (f3.workersText || (f3.f3 && f3.f3.workersText));
  check(/^Cluster workers 3/.test(wt || ''), `F3 says ${JSON.stringify(wt)}`);
  // the debug screen while split: its Workers card took cluster workers' stats for region workers' and threw at every snapshot, which
  // left the mobs map on its last picture from before the split (Gordon's "only Simulation", 2026-10-29)
  {
    const dp = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage(), errs = [];
    dp.on('pageerror', e => errs.push(String(e.message || e).slice(0, 200)));
    dp.on('console', m => { if (m.type() === 'error' && /debug screen/.test(m.text())) errs.push(m.text().slice(0, 200)); });
    await dp.route('https://fonts.**', r => r.abort());
    await dp.goto(S.debug);
    // (the screen's state is inside its script: its test hooks, BFMobMap.data() the map it drew last and BFWorld.snap() the snapshot)
    const drawn = await dp.waitForFunction(() => { const m = BFMobMap.data(); return m && m.workers === 3 && (m.regions || []).some(r => r[5] > 0) && document.querySelectorAll('#c-wk-per span').length === 3; }, null, { timeout: 120000, polling: 1000 }).then(() => true, () => false);
    const seen = await dp.evaluate(() => { const m = BFMobMap.data(), sn = BFWorld.snap(); return { snaps: sn ? sn.n : null, workers: m ? m.workers : null, other: m ? (m.regions || []).filter(r => r[5] > 0).length : 0, per: [...document.querySelectorAll('#c-wk-per span')].map(e => e.textContent) }; });
    check(drawn && !errs.length, `the debug screen draws the split: snapshot ${seen.snaps}, map of ${seen.workers} workers, ${seen.other} regions on the followers, Workers card ${JSON.stringify(seen.per)}${errs.length ? '; errors: ' + errs.slice(0, 3).join(' | ') : ''}`);
    await dp.context().close();
  }
  // a save while split (at the next meeting)
  await pg.evaluate(() => BF.warp.set(2));
  const saved = await pg.evaluate(() => BF.save.saveNow());
  check(saved === true, `a save while split is written (${saved})`);
  // back to one, then split again
  // (split=always splits again as soon as it is back to one, so the game log says when each happened)
  // (the simulation's own log, by index, base() the oldest kept: the page's copy of it comes in batches)
  const mark = () => sim(pg, () => BF.glog.base() + BF.glog.entries().length);
  const loggedSince = (re, from) => sim(pg, ([src, from]) => { const b = BF.glog.base(); return BF.glog.entries().slice(Math.max(0, from - b)).some(e => (e.k === 'workers' || e.k === 'clusters') && new RegExp(src).test(e.x)); }, [re.source, from]);
  const logUntil = async (re, from, ms = 300000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await loggedSince(re, from).catch(() => false)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; };
  await pg.evaluate(() => BF.warp.set(0));   // (1x: while back to one each follower runs the whole world again, and on a small machine it can't keep up
  // with a faster leader, so the split waits until it does)
  const m0 = await mark();
  await sim(pg, () => { BF.rplay.testSolo(); return true; });
  let t1 = Date.now();
  const one = await logUntil(/back to one with the whole world/, m0);
  const kept = one && await sim(pg, () => BF.ctick.on);   // (the cluster tick goes off only with the followers: js/rplay.js toSolo)
  check(one && kept, `back to one: the workers took the whole world at a meeting and the leader runs every cluster (${Math.round((Date.now() - t1) / 1000)} s)`);
  t1 = Date.now();
  const again = (await logUntil(/clusters are split over/, m0, 600000)) && (await until(pg, () => BF.rplay.status().split && BF.cworkers.active, 300000, 'split again'));   // (splitting again boots the followers' copies again: minutes on a busy machine)
  if (!again) console.log('  server output (last 3000):\n' + S.srv.out.replace(/^\[(builder|breeding)\].*\n/gm, '').slice(-3000));
  if (!again) console.log('  status: ' + JSON.stringify(Object.assign(await status(pg), { loads: undefined })).slice(0, 900) + '\n  marks: ' + m0 + ' ' + JSON.stringify(await sim(pg, () => [BF.glog.base(), BF.glog.entries().length, !!(BF.cworkers && BF.cworkers.active)])) + '\n  log: ' + (await sim(pg, () => BF.glog.entries().filter(e => e.k === 'workers' || e.k === 'clusters').slice(-8).map(e => e.l + ' ' + e.x).join(' | '))).slice(0, 1500));
  check(again, `split=always: split again (${Math.round((Date.now() - t1) / 1000)} s)`);
  await run(pg, 5);
  const s2 = await status(pg);
  check(s2.split && !s2.mismatch && s2.checks > s1.checks, `split again, the copies still agree (${s2.checks} checks; ${s2.text})`);
  const lines = await sim(pg, () => BF.glog.entries().filter(e => e.k === 'workers').map(e => e.l + ' ' + e.x));   // (the simulation's log: the page's copy is partial in a long run)
  check(lines.some(l => /clusters are split/i.test(l)) && !lines.some(l => /^ERROR/.test(l)), `the game log has the workers' lines, no errors (${lines.slice(-3).join(' | ').slice(0, 300)})`);
  for (const l of lines) if (/^ERROR/.test(l)) console.log('  ' + l.slice(0, 1200));
  await pg.context().close();
  S.srv.kill();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(async e => {
  console.error(e);
  if (S) console.error('server output (last 4000, without the builders\' and breeding lines):\n' + S.srv.out.replace(/^\[(builder|breeding)\].*\n/gm, '').slice(-4000));
  if (PG) {   // (where the page is: its connection, and whether the world still moves)
    const at = () => PG.evaluate(() => ({ clock: BF.client && BF.client.world.clock ? BF.client.world.clock.day + BF.client.world.clock.time : null, host: BF.simHost.mode, crashed: String(BF.simHost.crashed || '') })).catch(x => String(x));
    const a = await at(); await new Promise(r => setTimeout(r, 5000)); console.error('page: ' + JSON.stringify(a) + ' then ' + JSON.stringify(await at()));
  }
  process.exit(1);
});
