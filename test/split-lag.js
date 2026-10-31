// @ci integration suite=world timeout=1500
// Followers slower than the leader while one thinks (js/rplay.js lagging; Gordon's laptop, 2026-10-30: with the world server putting the
// leader on the fast cores and the followers on the slower ones, server/cores.js place, they fell 3370 ticks behind replaying its journal
// and the split, which waits for them, never started). The world server with 3 workers and clusters, split auto, seed 3 at the village
// nearest the spawn; once the followers are ready, each takes 25 ms longer a tick while one thinks (BF.rplay.testSlow: as if on a slower
// core), and the game fast-forwards at 10x:
//   - the leader waits for them (the INFO line), so they are never far behind (300 ticks: a loop at 10x runs many ticks before the
//     leader looks again; without the wait they were 79384 behind);
//   - the game still moves on, at their pace;
//   - the clusters split (the dropped ticks make it busy), and the trial ends either way, judged after the first 2 meetings (the
//     handover); no ERROR in the workers' and clusters' lines.
// Usage: NODE_PATH=$(npm root -g) node test/split-lag.js [seed=3]
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
  clustered: !!(BF.cworkers && BF.cworkers.active), speed: BF.warp.speed }));
const logLines = pg => sim(pg, () => BF.glog.entries().filter(e => e.k === 'workers' || e.k === 'clusters').map(e => e.l + ' ' + e.x));

let S = null;
(async () => {
  const b = await chromium.launch();
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-sl-'));
  S = await server(['--test', '--saves', saves, '--workers', '3', '--clusters', '--verify', '100']);
  const pg = await open(b, S.url + '?sim=server&workers=3');
  check(await pg.evaluate(() => BF.simHost.mode === 'server'), 'the page is the world server\'s client');
  const r = await pg.evaluate(async seed => {
    BF.player.start();
    await BF.save.create({ name: "split-lag", seed: String(seed), gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    BF.warp.set(0);   // 1x until the followers are ready
    return { village: !!v };
  }, seed);
  check(r.village, 'the player is at the village nearest the spawn');
  const ready = await until(pg, () => { const s = BF.rplay.status(); return s.followers === 2 && s.ready === 2; }, 300000, 'followers ready');
  check(ready, 'both followers ready');
  const ticks0 = await sim(pg, () => { BF.rplay.testSlow(25); BF.warp.set(3); return BF.rplay.status().ticks; });   // (25 ms more a tick on each follower; 10x)
  const t0 = Date.now();
  // (by the log: a busy simulation answers slowly, and the split and its trial can be over before a status poll comes back)
  const split = await until(pg, () => BF.glog.entries().some(e => e.k === 'workers' && /the clusters are split over|Region workers stopped/.test(e.x)), 900000, 'split');
  const s1 = await status(pg), wl = await logLines(pg);
  const waitLine = wl.find(l => /one thinking waits for them/.test(l)) || '';
  check(!!waitLine, `the leader waited for its followers (${waitLine.slice(0, 160) || 'no line'})`);
  const w = s1.worst || { ticks: 0, ms: 0 };
  check(w.ticks <= 300, `the followers were never far behind (at most ${w.ticks} ticks, about ${(w.ms / 1000).toFixed(1)} s of the leader's ticks)`);
  check(s1.splitAt != null && s1.splitAt > ticks0, `the game went on meanwhile (tick ${ticks0} to the split at ${s1.splitAt})`);
  const splitLine = wl.find(l => /the clusters are split over 3 workers/.test(l)) || '';
  check(split && !!splitLine, `the clusters split (${((Date.now() - t0) / 1000).toFixed(0)} s; ${splitLine.slice(0, 160) || s1.text})`);
  const ended = await until(pg, () => BF.glog.entries().some(e => e.k === 'workers' && /the split pays|not worth it/.test(e.x)), 600000, 'trial');
  check(ended && !s1.mismatch, 'the trial ended, no difference');
  // (the trial leaves out its first 2 meetings, the handover, and sums the busy ms of the 400 ticks after them: js/rplay.js WARM_MEETS)
  const tr = (await status(pg)).lastTrial;
  check(tr && tr.from - tr.at === 160 && tr.n >= 300 && tr.after === tr.ms / tr.n, `the trial was judged after the first 2 meetings, on the ticks after them (${JSON.stringify(tr)})`);
  const errs = (await logLines(pg)).filter(l => /^ERROR/.test(l));
  check(!errs.length, `no ERROR in the workers' and clusters' game log lines${errs.length ? ': ' + errs.slice(0, 3).join(' | ').slice(0, 600) : ''}`);
  for (const l of (await logLines(pg)).slice(-8)) console.log('  log: ' + l.slice(0, 300));
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('PASS split-lag');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
