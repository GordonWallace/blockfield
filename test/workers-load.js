// @ci integration suite=world,village timeout=1200
// Region workers on a loaded world (js/rplay.js, js/villagesim.js state/load): the world server (debug/server.js --workers 3 --split never
// --clusters --verify 100) plays a saved world loaded from inside another, its two followers replaying the leader's journal while one thinks;
// every 100 ticks their copies are compared with the leader's (js/rplay.js soloCheck) and must never differ.
// Before the fix the village sim's focus (the last world's player position) outlived the world: on a loaded world the leader's first tick
// checked the simulated set with it while the followers, booted fresh, waited for the first frame's position, and from then on their
// checks ran on other ticks: villages joined a few ticks apart, the copies differed in villagers by tick 100-400, and the first split
// after that stopped the simulation ("worker 1 ran mob ..., which this worker doesn't have", "no object at 1 to change": Gordon's test4,
// 2026-10-29). Seed 3, a new world at the village nearest the spawn with 4 more villages simulated, saved after a game minute at 10x, then
// loaded and played 2 game minutes at 10x.
// Usage: NODE_PATH=$(npm root -g) node test/workers-load.js [seed=3]
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
const status = pg => sim(pg, () => Object.assign(BF.rplay.status(), { text: BF.rplay.text(), checks: BF.rworkers.checks || 0, mismatch: BF.rworkers.mismatch }));
const gameMinutes = async (pg, minutes) => {   // (minutes of game time at 10x, by the client's clock)
  const day0 = await pg.evaluate(() => { const c = BF.client.world.clock; return c ? c.day + c.time : -1; });
  await pg.evaluate(() => BF.warp.set(3));   // 10x
  const t0 = Date.now();
  await pg.waitForFunction(([d0, m]) => { const c = BF.client.world.clock; return (c && c.day + c.time >= d0 + m / 1200 * 60) || BF.simHost.crashed; }, [day0, minutes], { timeout: 900000, polling: 1000 }).catch(() => {});
  await pg.evaluate(() => BF.warp.set(0));
  return Math.round((Date.now() - t0) / 1000);
};

let S = null, PG = null;
(async () => {
  const b = await chromium.launch();
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-wl-'));
  S = await server(['--test', '--saves', saves, '--workers', '3', '--split', 'never', '--clusters', '--verify', '100']);
  const pg = await open(b, S.url + '?sim=server&workers=3');
  PG = pg;
  const made = await pg.evaluate(async seed => {
    BF.player.start();
    const meta = await BF.save.create({ name: "workers-load", seed: String(seed), gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    return { id: meta && meta.id, village: !!v };
  }, seed);
  check(made.id && made.village, `a new world at the village nearest the spawn (${made.id})`);
  await sim(pg, () => { BF.active.set({ on: true, fixed: 4, reach: 4000 }); return true; });
  const ready = await until(pg, () => { const s = BF.rplay.status(); return s.followers > 0 && s.ready === s.followers; }, 300000, 'followers');
  check(ready, 'the followers booted the new world');
  console.log(`  a game minute at 10x in ${await gameMinutes(pg, 1)} s`);
  const s0 = await status(pg);
  check(!s0.mismatch, `the new world's copies agree (${s0.checks} checks)`);
  // saved and loaded from inside it: the world goes, its focus stays
  const seenN = await sim(pg, () => { const o = {}; BF.villageSim.exportSeen(o); return Object.keys(o).filter(k => k.startsWith('seen:')).length; });
  await sim(pg, () => { globalThis.__wlTicks = BF.rplay.status().ticks; return true; });   // (the leader's ticks start again from 0 for the loaded world)
  await pg.evaluate(async id => { await BF.save.saveNow(); await BF.save.load(id); }, made.id);
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  check(seenN > 0, `the save holds villages last simulated (${seenN})`);
  await sim(pg, () => { BF.active.set({ on: true, fixed: 4, reach: 4000 }); return true; });
  const again = await until(pg, () => { const s = BF.rplay.status(); return s.followers > 0 && s.ready === s.followers && s.ticks > 40 && s.ticks < globalThis.__wlTicks; }, 300000, 'followers of the loaded world');
  check(again, 'the followers booted the loaded world');
  console.log(`  2 game minutes at 10x in ${await gameMinutes(pg, 2)} s`);
  const s1 = await status(pg);
  check(s1.followers === 2 && s1.checks - s0.checks >= 5 && !s1.mismatch, `the loaded world's copies were compared ${s1.checks - s0.checks} times and never differed (followers ${s1.followers}; a difference stops them)${s1.mismatch ? ' (' + JSON.stringify(s1.mismatch).slice(0, 300) + ')' : ''}`);
  const lines = await sim(pg, () => BF.glog.entries().filter(e => e.k === 'workers').map(e => e.l + ' ' + e.x));
  check(!lines.some(l => /^ERROR/.test(l)), `no ERROR in the workers' game log lines (${lines.slice(-2).join(' | ').slice(0, 300)})`);
  for (const l of lines) if (/^ERROR/.test(l)) console.log('  ' + l.slice(0, 1200));
  if (process.env.WL_DUMP) fs.writeFileSync(process.env.WL_DUMP, S.srv.out);
  await pg.context().close();
  S.srv.kill();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error(e);
  if (S) console.error('server output (last 4000, without the builders\' and breeding lines):\n' + S.srv.out.replace(/^\[(builder|breeding)\].*\n/gm, '').slice(-4000));
  process.exit(1);
});
