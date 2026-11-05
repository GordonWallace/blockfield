// @ci integration suite=world timeout=1800
// Forced village loads with the cluster workers split, one follower's clock frozen (js/villagesim.js update; laptop 2026-11-05: a
// follower took a forced load on its own a meeting early, the others lacked those villages' records, "worker 6 changed village V, which
// this worker doesn't have", then "no object at bred to change" and the workers stopped). With the cluster tick on the simulated set
// changes only at meetings, on every worker alike, whatever a copy's clock says. The world server with 3 workers, split always, seed 3,
// view 32, the player 420 blocks from the village nearest the spawn (in view, past the 96-block reach: BF_NEAR=1, so a follower runs
// it), a fixed set of 6 extra villages; then at 1x worker FREEZE_W (1) freezes its clock and FORCE_N (10) villages are force-loaded:
//   - they all join, and for WATCH_S (60) s the copies agree (--verify 100) and no game log line is an ERROR.
// Usage: NODE_PATH=$(npm root -g) node test/cluster-force-frozen.js [seed=3]
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
// (copies that differ write the differing parts' texts here, js/cworkers.js CW_DUMP: a failed run prints where they first differ)
const dumps = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cv-dump-'));
function dumped() { try { dumpedNow(); } catch (e) { console.log("  (dumps: " + e.message + ")"); } }
function dumpedNow() {
  const files = fs.readdirSync(dumps), parts = [...new Set(files.map(f => f.replace(/-w\d+\.txt$/, '')))];
  for (const part of parts) {
    const t = files.filter(f => f.startsWith(part + '-w')).sort().map(f => [f, fs.readFileSync(path.join(dumps, f), 'utf8')]);
    for (const [f, x] of t.slice(1)) {
      const y = t[0][1];
      let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
      if (i === x.length && i === y.length) continue;
      console.log(`  dump ${part}: ${t[0][0]} and ${f} first differ at character ${i}:\n    ${t[0][0]}: ${y.slice(Math.max(0, i - 200), i + 400)}\n    ${f}: ${x.slice(Math.max(0, i - 200), i + 400)}`);
    }
  }
}
async function server(args) {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)].concat(args || []), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { CW_DUMP: dumps, BF_NEAR: process.env.BF_NEAR || '1', FREEZE_W: process.env.FREEZE_W || '1', FORCE_N: process.env.FORCE_N || '10' }) });
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
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cv-'));
  S = await server(['--test', '--saves', saves, '--workers', '3', '--split', 'always', '--verify', '100']);
  const pg = await open(b, S.url + '?sim=server&workers=3');
  check(await pg.evaluate(() => BF.simHost.mode === 'server'), 'the page is the world server\'s client');
  // a village 420 blocks off: in view at 32 chunks (512 blocks), out of the player's reach (TOUCH 96, its land REACH 256)
  const r = await pg.evaluate(async seed => {
    BF.player.start();
    await BF.save.create({ name: "cluster-force-frozen", seed: String(seed), gameMode: "creative", villages: 10 });
    BF.renderer.render = () => {};   // (drawing off: the software renderer would make every frame slow)
    BF.world.setViewDist(32);
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (!v) return null;
    const x = v.x + 420, z = v.z;
    BF.player.setFlying(true); BF.player.teleport(x + 0.5, BF.worldgen.heightAt(x, z) + 20, z + 0.5);
    BF.warp.set(0);   // 1x
    return { vx: v.x, vz: v.z };
  }, seed);
  check(!!r, 'a village to look at from 420 blocks');
  if (!r) { await b.close(); process.exit(1); }
  await sim(pg, () => { BF.active.set({ on: true, budget: 0.8, fixed: 6 }); return true; });
  // split, and that village simulated on a follower (not in the player's group)
  const ready = await until(pg, `() => { const CW = BF.cworkers, CL = BF.clusters; if (BF.rplay.status().ended) return true; if (!CW || !CW.active || !BF.rplay.status().split) return false;
    const v = [...BF.mobs.villages.values()].find(r => Math.hypot(r.x - ${r.vx}, r.z - ${r.vz}) < 64);
    return !!v && CW.workerOf(CL.groupOf('v:' + v.key)) > 0 && BF.mobs.list.some(m => m.villageId === v.key && !m.removed); }`, 900000, 'split with the village on a follower');
  const where = await sim(pg, `() => { const CW = BF.cworkers, CL = BF.clusters, v = [...BF.mobs.villages.values()].find(r => Math.hypot(r.x - ${r.vx}, r.z - ${r.vz}) < 64);
    return v ? { key: v.key, worker: CW.workerOf(CL.groupOf('v:' + v.key)), player: (CL.groups().find(g => g.player) || {}).bases, touch: CL.TOUCH } : null; }`);
  console.log('  at: ' + JSON.stringify(Object.assign({}, r, await sim(pg, () => { const p = BF.player.position; return { px: p.x, pz: p.z, view: BF.world.viewDist, region: BF.regions.keyOf(p.x, 0, p.z) }; }))));
  const ended = await sim(pg, () => BF.rplay.status().ended);
  if (ended) { for (const l of (await logLines(pg)).slice(-12)) console.log('  log: ' + l.slice(0, 800)); dumped(); }
  check(!ended, `the workers keep going (${ended || ''})`);
  check(ready && where && where.worker > 0, `split, the village runs on follower ${where && where.worker}, out of the player's group (${JSON.stringify(where && where.player)})`);
  // repro: force-load at 1x after the split, as the laptop rig did
  const before = await sim(pg, () => ({ n: BF.villageSim.count(), tick: BF.rand.tick }));
  console.log('  before force: ' + JSON.stringify(before));
  await sim(pg, () => { BF.active.set({ fixed: 0 }); if (process.env.FREEZE_W && BF.cworkers.me === Number(process.env.FREEZE_W)) BF.warp.freeze(); BF.active.force(Number(process.env.FORCE_N || 20)); return true; });
  const t1 = Date.now();
  let errs = [];
  while (Date.now() - t1 < Number(process.env.WATCH_S || 60) * 1000) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await sim(pg, () => ({ ended: BF.rplay.status().ended, n: BF.villageSim.count(), errs: BF.glog.entries().filter(e => e.l === 'ERROR' && e.k !== 'move').map(e => e.k + ' ' + e.x).slice(0, 30), joins: BF.glog.entries().filter(e => /joins the simulated set/.test(e.x)).map(e => e.x.slice(0, 80)).slice(-50) })).catch(e => ({ fail: e.message }));
    errs = st.errs || [];
    if (st.fail || st.ended || errs.length) { console.log('  state: ' + JSON.stringify(st).slice(0, 6000)); break; }
  }
  const fin = await sim(pg, () => ({ n: BF.villageSim.count(), joins: BF.glog.entries().filter(e => /joins the simulated set/.test(e.x)).map(e => e.x.slice(0, 90)) })).catch(e => ({ fail: e.message }));
  console.log('  after: ' + JSON.stringify(fin).slice(0, 5000));
  check(!errs.length, 'no ERROR after force-loading (' + errs.slice(0, 5).join(' | ') + ')');
  check(fin.n === before.n + Number(process.env.FORCE_N || 10), `the ${process.env.FORCE_N || 10} forced villages joined (${before.n} -> ${fin.n})`);
  if (errs.length) dumped();
  console.log(fails ? 'FAIL' : 'PASS');
  await b.close(); for (const s of servers) s.kill(); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); for (const s of servers) s.kill(); process.exit(1); });
