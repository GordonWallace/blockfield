// @ci integration suite=ui timeout=900
// The debug screen's Threads card and the Regions overlay by worker (js/threadload.js, js/debugfeed.js, debug/server.js hostLoad;
// Gordon 2026-10-26: "which cores the program is utilizing, at what level", regions "color coded by core"). Seed 3, at the village
// nearest the spawn, region workers splitting (?workers=3&split=always), a while at 100x:
//   - the snapshot carries the page's thread, the simulation's and each follower's (busy shares 0..1 with a minute's history), and the
//     debug server's computer: one entry per OS core (os.cpus) and its own thread;
//   - the Threads card lists page, simulation, worker 1, worker 2 and the debug server, and draws one bar per core;
//   - with Regions on, each region carries the worker its mobs think on, more than one worker has regions, and the legend names them;
//   - the game log has the "threads" line naming the simulation's threads;
//   - the world server (--workers 3 --split always): its threads are named as server threads, the same checks.
// Screenshots: <out>-worker.png, <out>-server.png (the Threads card and the map).
// Usage: NODE_PATH=$(npm root -g) node test/debug-threads.js [outPrefix]
const path = require('path'), fs = require('fs'), os = require('os');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-threads';
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

async function open(b, url) {
  const ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
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

async function run(b, label, srv, query) {
  const pg = await open(b, srv.url + query);
  await pg.evaluate(async () => {
    BF.player.start();
    await BF.save.create({ name: "threads", seed: "3", gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, c) => P.distance(p, a) - P.distance(p, c))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
  });
  const split = await until(pg, () => { const s = BF.rplay.status(); return s.followers > 0 && s.ready === s.followers && s.split; }, 300000);
  check(split, `${label}: the regions are split over the workers`);
  await pg.evaluate(() => BF.warp.set(4));   // 100x: the threads have work to show
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1500 } });
  dbg.on('pageerror', e => console.log('PAGEERROR debug', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(srv.debug);
  await dbg.evaluate(() => localStorage.setItem('bf-debug-mobmap-regions', '1'));
  await dbg.reload();
  // the regions split by worker once the workers have planned owners (every 100 ticks) and a map has come since
  const ok = await dbg.waitForFunction(() => {
    const d = window.BFMobMap && BFMobMap.data();
    return d && d.workers > 1 && new Set((d.regions || []).map(r => r[5])).size > 1 && document.querySelectorAll('#c-th-list > span').length >= 5;
  }, null, { timeout: 240000, polling: 1000 }).then(() => true, () => false);
  check(ok, `${label}: the map's regions come from more than one worker and the Threads card has every thread`);
  const got = await dbg.evaluate(() => {
    const d = BFMobMap.data();
    return { workers: d.workers, by: [...new Set(d.regions.map(r => r[5]))].sort(), rows: [...document.querySelectorAll('#c-th-list > span')].map(e => e.textContent),
      legend: document.getElementById('m-rlegend').textContent, cores: document.getElementById('c-cores-sub').textContent };
  });
  console.log(`${label}:`, JSON.stringify(got));
  check(got.workers === 3, `${label}: the map knows 3 workers (${got.workers})`);
  check(/Page/.test(got.rows[0]) && got.rows.some(r => /^Simulation/.test(r)) && got.rows.some(r => /^Worker 1/.test(r)) && got.rows.some(r => /^Worker 2/.test(r)) && got.rows.some(r => /server/i.test(r)),
    `${label}: the card lists the page, the simulation, both workers and the server (${got.rows.join(' | ')})`);
  if (label === 'server') check(got.rows.some(r => /world server thread/.test(r)) && got.rows.some(r => /Worker 1 \(server thread\)/.test(r)), `server: the simulation's threads are named as the server's`);
  check(/Worker 1/.test(got.legend) && /Worker 2/.test(got.legend), `${label}: the Regions legend names the workers (${got.legend})`);
  check(new RegExp(': ' + os.cpus().length + ' cores').test(got.cores), `${label}: one bar per core of this computer (${got.cores}; os.cpus ${os.cpus().length})`);
  // the snapshot itself: busy shares in range, a history building up
  const snap = await dbg.evaluate(() => BFThreads.snap());
  if (snap) {
    const all = [snap.page].concat(snap.threads || []).filter(Boolean);
    check(all.every(t => t.busy == null || (t.busy >= 0 && t.busy <= 1)) && all.some(t => t.hist && t.hist.length > 3), `${label}: busy shares are 0..1 with a history (${all.map(t => t.busy == null ? '?' : t.busy.toFixed(2)).join(' ')})`);
    check(snap.host.cores.length === os.cpus().length && snap.host.cores.some(c => c.busy > 0), `${label}: the host's cores have loads (${snap.host.cores.map(c => Math.round((c.busy || 0) * 100)).join(' ')})`);
  } else check(false, `${label}: the debug screen keeps the last snapshot (BFThreads.snap)`);
  const lines = await pg.evaluate(() => BF.glog.entries().filter(e => e.k === 'threads').map(e => e.l + ' ' + e.x));
  check(lines.some(l => /^INFO Simulation threads: .*Worker 2/.test(l)), `${label}: the game log names the simulation's threads (${lines.slice(-2).join(' | ').slice(0, 300)})`);
  await dbg.locator('#c-thcard').scrollIntoViewIfNeeded();
  await dbg.locator('#c-thcard').screenshot({ path: out + '-' + label + '-card.png' });
  await dbg.locator('#mpanel').scrollIntoViewIfNeeded();
  await dbg.locator('#mpanel').screenshot({ path: out + '-' + label + '-map.png' });
  await dbg.close();
  await pg.context().close();
}

(async () => {
  const b = await chromium.launch();
  let srv = await lib.serve({ world: false });
  await run(b, 'worker', { url: srv.url, debug: srv.debugUrl }, '?sim=worker&workers=3&split=always');
  srv.stop();
  srv = await lib.serve({ world: true, args: ['--workers', '3', '--split', 'always'] });
  await run(b, 'server', { url: srv.url, debug: srv.debugUrl }, '?sim=server&workers=3');
  srv.stop();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
