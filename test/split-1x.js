// @ci integration suite=world timeout=1500
// The clusters split at 1x when the simulation's thread stays busy (js/rplay.js LOAD_MS, js/active.js pressed; Gordon 2026-10-30: at 1x
// the workers never split, only when fast-forwarding dropped ticks). The world server with 3 workers and clusters, split auto, seed 3 at
// the village nearest the spawn, never fast-forwarded. The Distant villages limit is set very low (2% of each second), so the measure is
// over its join line, which counts as busy as 65% does:
//   - the clusters split at 1x, after the plain tick's first PLAIN_TICKS and 30 s busy, every copy holding the budget's joins for the trial;
//   - the trial ends either way: kept ("the split pays") or back to one and the followers stop ("a split doesn't pay");
//   - the copies agree at every check (--verify 100) and the workers' game log lines have no ERROR.
// Usage: NODE_PATH=$(npm root -g) node test/split-1x.js [seed=3]
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
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-s1-'));
  S = await server(['--test', '--saves', saves, '--workers', '3', '--clusters', '--verify', '100']);
  const pg = await open(b, S.url + '?sim=server&workers=3');
  check(await pg.evaluate(() => BF.simHost.mode === 'server'), 'the page is the world server\'s client');
  const r = await pg.evaluate(async seed => {
    BF.player.start();
    await BF.save.create({ name: "split-1x", seed: String(seed), gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    BF.warp.set(0);   // 1x
    return { village: !!v };
  }, seed);
  check(r.village, 'the player is at the village nearest the spawn');
  await sim(pg, () => { BF.active.set({ on: true, budget: 0.02, win: 1 }); return true; });
  const s0 = await status(pg);
  check(/splits when ticks drop or the load stays high/.test(s0.text) || s0.followers === 0, `before: one thinks (${s0.text})`);
  const tr = Date.now();
  const split = await until(pg, () => BF.rplay.status().split && BF.cworkers.active, 900000, 'split at 1x');
  const s1 = await status(pg);
  const at = await sim(pg, () => ({ hold: BF.active.state().joinHold, tick: BF.rand.tick, pressed: BF.active.pressed(), used: BF.active.used() }));
  check(split && s1.speed === 1, `the clusters split at 1x without fast-forwarding (${((Date.now() - tr) / 1000).toFixed(0)} s; ${s1.text})`);
  check(at.hold > 0 && at.hold <= at.tick + 400, `no village joins for the budget during the trial (held to tick ${at.hold}, now ${at.tick})`);
  const ended = await until(pg, () => BF.glog.entries().some(e => e.k === 'workers' && /the split pays|not worth it/.test(e.x)), 600000, 'trial');
  const wl = await logLines(pg);
  const s2 = await status(pg);
  const verdict = wl.find(l => /the split pays|not worth it/.test(l)) || '';
  check(ended && (/the split pays/.test(verdict) ? s2.split : true), `the trial ended: ${verdict.slice(0, 200) || '(no verdict)'}`);
  if (/the split pays/.test(verdict)) {
    const more = await until(pg, () => (BF.rworkers.checks || 0) >= 2, 600000, 'checks');
    const s3 = await status(pg);
    check(more && !s3.mismatch, `split kept: the copies were compared ${s3.checks} times and agree`);
  } else {
    const gone = await until(pg, () => BF.rplay.status().followers === 0, 300000, 'followers stop');
    check(gone && !s2.mismatch, 'not worth it: back to one, the followers stop, no difference');
  }
  const errs = (await logLines(pg)).filter(l => /^ERROR/.test(l));
  check(!errs.length, `no ERROR in the workers' and clusters' game log lines${errs.length ? ': ' + errs.slice(0, 3).join(' | ').slice(0, 600) : ''}`);
  for (const l of (await logLines(pg)).slice(-8)) console.log('  log: ' + l.slice(0, 300));
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('PASS split-1x');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
