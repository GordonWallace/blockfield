// @ci integration suite=world timeout=1800
// A village in view but out of the player's reach runs on a follower, and the client sees its mobs as each meeting leaves them
// (js/clusters.js TOUCH; Gordon's laptop 2026-11-03: at view 32 every village in view ran on the leader). The world server with 3
// workers, split always, seed 3, view 32, the player 420 blocks from the village nearest the spawn, a fixed set of 6 extra villages:
//   - split, that village runs on a follower (not in the player's group);
//   - its villagers move on the client from one meeting to the next (the leader's copies of them come current at each meeting);
//   - one of its villagers put next to the player brings its village into the player's group at the next meeting (a mob keeps its
//     village's base wherever it walks: an explorer passing the player would otherwise move only at meetings);
//   - the copies agree at every check (--verify 100) and the workers' game log lines have no ERROR.
// Usage: NODE_PATH=$(npm root -g) node test/cluster-view.js [seed=3]
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
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)].concat(args || []), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { CW_DUMP: dumps }) });
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
    await BF.save.create({ name: "cluster-view", seed: String(seed), gameMode: "creative", villages: 10 });
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
  // its villagers move on the client from meeting to meeting: samples two meetings apart (16 game s at 1x)
  let moved = null;
  if (ready) {
    const meets = () => sim(pg, () => BF.clusters.stats().meetings);
    const ids = await sim(pg, `() => BF.mobs.list.filter(m => m.villageId === '${where.key}' && !m.removed && !m.dead).map(m => m.id)`);
    const take = () => pg.evaluate(ids => { const o = {}; for (const e of BF.client.world.entities.values()) if (ids.includes(e.sid)) o[e.sid] = [e.x, e.z]; return o; }, ids);
    const m0 = await meets(), a = await take();
    const t0 = Date.now();
    while ((await meets()) < m0 + 2 && Date.now() - t0 < 120000) await pg.waitForTimeout(1000);
    await pg.waitForTimeout(1000);
    const c = await take();
    const keys = Object.keys(a).filter(k => c[k]);
    moved = { seen: keys.length, of: ids.length, moved: keys.filter(k => Math.hypot(a[k][0] - c[k][0], a[k][1] - c[k][1]) > 0.05).length, meetings: (await meets()) - m0 };
  }
  check(!!moved && moved.seen > 0, `the client has the far village's villagers (${JSON.stringify(moved)})`);
  check(!!moved && moved.moved > 0, `some of them moved on the client from one meeting to the next (${JSON.stringify(moved)})`);
  // one of its villagers next to the player: its village joins the player's group (on the first worker) at a meeting after
  let pulled = null;
  if (ready) {
    const mid = await sim(pg, `() => { const p = BF.player.position, m = BF.mobs.list.find(m => m.villageId === '${where.key}' && !m.removed && !m.dead && !m.child);
      if (!m) return null; m.position.set(p.x + 6, BF.worldgen.heightAt(Math.floor(p.x + 6), Math.floor(p.z)) + 1, p.z); if (m.ai) m.ai.route = null; return m.id; }`);
    const ok = mid != null && await until(pg, `() => { const CL = BF.clusters, g = CL.groups().find(g => g.player); return !!g && CL.groupOf('v:${where.key}') === g.key && BF.cworkers.workerOf(g.key) === 0; }`, 300000, 'village pulled in');
    pulled = { mob: mid, ok };
  }
  check(!!pulled && pulled.ok, `a villager of that village next to the player brings the village into the player's group (${JSON.stringify(pulled)})`);
  const more = await until(pg, () => (BF.rworkers.checks || 0) >= 2, 600000, 'checks');
  const s = await status(pg);
  check(more && !s.mismatch, `the copies were compared ${s.checks} times and agree`);
  const errs = (await logLines(pg)).filter(l => /^ERROR/.test(l));
  check(!errs.length, `no ERROR in the workers' and clusters' game log lines${errs.length ? ': ' + errs.slice(0, 3).join(' | ').slice(0, 600) : ''}`);
  if (fails) dumped();
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('PASS cluster-view');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
