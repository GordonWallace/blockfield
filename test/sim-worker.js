// @ci integration suite=world,ui timeout=1800
// The simulation in a Web Worker (spec r15-38, js/simworker.js, js/simhost.js). Served over http (debug/server.js on free ports, as
// ./run.sh serves the game), seed 3:
//   - with ?sim=worker the simulation runs in the worker (BF.simHost.mode, BF.client.mode) and reuses the page's river network;
//   - a new world plays a game day at 100x there: villagers come into the client's mirror, and the page's copy of the world (its chunks,
//     generated here with the worker's edits) has the same blocks as the worker's;
//   - paused, the state hash is taken and the world saved through the worker; a fresh page loads it, and its hash matches;
//   - the page's frame time at 100x, worker against page (printed for the report);
//   - a crash in the worker shows the error screen and goes to the game log;
//   - the same day, save and load with the simulation forced into the page (?sim=page), and a page opened as a file falls back to it.
// The hash after loading is REPORT-ONLY on the parts the save doesn't restore exactly in either mode (the same parts differ with the
// simulation in the page, so they are the save's, not the worker's); the other checks always count.
// Usage: NODE_PATH=$(npm root -g) node test/sim-worker.js [seed=3]
const fs = require('fs'), path = require('path'), cp = require('child_process'), net = require('net');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function server() {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + out)), 20000);
    srv.stdout.on('data', d => { out += d; if (/Ctrl\+C/.test(out)) { clearTimeout(t); res(); } });
    srv.on('exit', c => rej(new Error('debug/server.js exited ' + c + ': ' + out)));
  });
  return { srv, url: 'http://localhost:' + game + '/index.html' };
}

// one browser context for every page, so a fresh page sees the saves (IndexedDB) the last one wrote
let ctx = null;
async function open(b, url) {
  if (!ctx) {
    ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
  }
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
  pg.on('console', m => { if (m.type() === 'error' && !/GL Driver/.test(m.text())) console.log('console.error:', m.text().slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  // frame times: how long each of the game's frames (js/main.js frame) takes on the page's thread, for the report. The day is played
  // with drawing switched off (renderer.render does nothing): the software renderer the tests draw with takes most of the machine,
  // so with it on, frames a second measure the renderer, not the game.
  await pg.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__ft = [];
    const isGame = cb => cb.name === 'frame' && /renderer\.render\(/.test(String(cb));   // (js/main.js; js/audio.js has a frame too)
    window.requestAnimationFrame = cb => !isGame(cb) ? raf(cb) : raf(t => { const t0 = performance.now(); cb(t); window.__ft.push(performance.now() - t0); if (window.__ft.length > 20000) window.__ft.splice(0, 10000); });
  });
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  return pg;
}
const query = (pg, what, args) => pg.evaluate(([w, a]) => new Promise(r => BF.client.query(w, a || {}, r)), [what, args]);
const hashParts = (a, b) => Object.keys(Object.assign({}, a.parts, b.parts)).filter(k => a.parts[k] !== b.parts[k]);

// A game day in a new world at the village nearest the spawn; paused, the hash; saved. Returns {id, hash, frame, ...}.
async function playDay(pg, mode) {
  const r = await pg.evaluate(async seed => {
    BF.player.start();
    const meta = await BF.save.create({ name: "sim-worker", seed: String(seed), gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    return { id: meta.id, village: !!v };
  }, seed);
  check(r.village, `${mode}: the player is at the village nearest the spawn`);
  await pg.waitForTimeout(8000);   // chunks and villagers round the village
  const day0 = await pg.evaluate(() => BF.client.world.clock ? BF.client.world.clock.day + BF.client.world.clock.time : -1);
  await pg.evaluate(() => {
    const R = BF.renderer;
    window.__draw = R.render; R.render = () => {};   // (drawing off for the measurement, above)
    window.__ft.length = 0; BF.warp.set(4);   // 100x
  });
  const t0 = Date.now();
  await pg.waitForFunction(d0 => { const c = BF.client.world.clock; return c && c.day + c.time >= d0 + 1; }, day0, { timeout: 900000, polling: 1000 });
  const real = (Date.now() - t0) / 1000;
  const fr = await pg.evaluate(() => { const a = window.__ft.slice().sort((x, y) => x - y); return { drawn: BF.world.meshedCount(), calls: BF.renderer.info.render.calls, n: a.length, avg: a.reduce((s, v) => s + v, 0) / Math.max(1, a.length), p95: a[Math.floor(a.length * 0.95)] || 0, max: a[a.length - 1] || 0 }; });
  console.log(`${mode}: a game day at 100x in ${real.toFixed(0)} s real (${(1200 / real).toFixed(0)}x); page frames ${fr.n} (${(fr.n / real).toFixed(1)} a second), ${fr.avg.toFixed(2)} ms avg, p95 ${fr.p95.toFixed(2)} ms, max ${fr.max.toFixed(1)} ms; ${fr.drawn} chunks drawn, ${fr.calls} draw calls`);
  await pg.evaluate(() => { BF.warp.set(0); BF.renderer.render = window.__draw; });
  const seen = await pg.evaluate(() => { const E = [...BF.client.world.entities.values()]; return { villagers: E.filter(e => e.kind === "mob" && e.type === "villager").length, mobs: E.length, villages: BF.client.world.villages.size }; });
  check(seen.villagers > 0 && seen.villages > 0, `${mode}: villagers in the client's mirror (${seen.villagers} villagers, ${seen.mobs} entities, ${seen.villages} villages)`);
  // paused (the page's menus), the hash, then the save
  await pg.evaluate(() => { BF.state.paused = true; });
  await pg.waitForTimeout(1000);
  const h1 = await query(pg, 'hash');
  const h1b = await query(pg, 'hash');
  check(h1.ok && h1.hash === h1b.hash, `${mode}: paused, the simulation stands still (hash ${h1.hash})`);
  const saved = await pg.evaluate(() => BF.save.saveNow());
  check(saved === true, `${mode}: saved through ${mode === 'worker' ? 'the worker' : 'the page'}`);
  return { id: r.id, hash: h1, frame: fr, real };
}
// A fresh page loads the save, paused before it opens, and takes the hash
async function loadBack(b, url, mode, day) {
  const pg = await open(b, url);
  const r = await pg.evaluate(async id => {
    BF.player.start();
    BF.state.paused = true;
    const meta = await BF.save.load(id);
    await new Promise(res => setTimeout(res, 1000));
    return { name: meta && meta.name, mode: BF.client.mode };
  }, day.id);
  check(r.name === 'sim-worker', `${mode}: a fresh page loaded the save (${r.mode})`);
  const h2 = await query(pg, 'hash');
  const diff = hashParts(day.hash, h2);
  console.log(`${mode}: hash after loading ${h2.hash} (saved ${day.hash.hash})${diff.length ? '; parts that differ: ' + diff.join(', ') : ''}`);
  return { pg, diff, same: h2.hash === day.hash.hash };
}

(async () => {
  const { srv, url } = await server();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let pageDiff = null;
  try {
    // ---- the simulation in the worker
    const wurl = url + '?sim=worker&debugfeed=off#seed' + seed;
    const pg = await open(b, wurl);
    const m = await pg.evaluate(() => ({ host: BF.simHost.mode, client: BF.client.mode, replica: BF.world.replica, f3: BF.debugText(BF.debugInfo()).split('\n').find(l => /^Simulation/.test(l)) }));
    check(m.host === 'worker' && m.client === 'worker' && m.replica, `the simulation runs in a Web Worker (${m.host}, client ${m.client})`);
    check(m.f3 === 'Simulation: worker', `F3 says so (${m.f3})`);
    await pg.waitForFunction(() => BF.glog.recent(500).some(e => e.k === 'worker' && /started in the simulation worker/.test(e.x)), null, { timeout: 60000 }).catch(() => {});   // (the title screen's world starts there a moment later)
    const logs = await pg.evaluate(() => BF.glog.recent(500).filter(e => e.k === 'worker').map(e => e.x));
    check(logs.some(x => /The simulation runs in a Web Worker/.test(x)) && logs.some(x => /Simulation worker loaded/.test(x)), 'the game log says where the simulation runs');
    check(logs.some(x => /started in the simulation worker .*the page's river network/.test(x)), "the worker reused the page's river network");
    const day = await playDay(pg, 'worker');
    // the page's copy of the world against the worker's
    const keys = await pg.evaluate(() => [...BF.world.chunks.keys()]);
    const wh = await query(pg, 'chunkHash', { keys });
    const ph = await pg.evaluate(k => BF.proto.simHash(k), wh.keys);
    const edits = await pg.evaluate(() => [...BF.world.edits.values()].reduce((n, m) => n + m.size, 0));
    check(wh.keys.length > 50 && wh.hash === ph, `the page's copy of the world has the worker's blocks (${wh.keys.length} chunks loaded in both, ${edits} edits)`);
    // the crash path, on this page (it's done with)
    const lw = await loadBack(b, wurl, 'worker', day);
    await pg.close();
    await lw.pg.evaluate(() => BF.proto.worker.w.postMessage({ test: 'crash' }));
    await lw.pg.waitForFunction(() => !!document.getElementById('bf-crash'), null, { timeout: 20000 }).catch(() => {});
    const cr = await lw.pg.evaluate(() => ({ shown: !!document.getElementById('bf-crash'), text: document.querySelector('#bf-crash pre') ? document.querySelector('#bf-crash pre').textContent : '', crashed: BF.simHost.crashed }));
    check(cr.shown && /a test crash/.test(cr.text), 'a crash in the worker shows the error and offers to reload');
    await lw.pg.close();

    // ---- the simulation in the page (forced), the same day
    const purl = url + '?sim=page&debugfeed=off#seed' + seed;
    const pp = await open(b, purl);
    const pm = await pp.evaluate(() => ({ host: BF.simHost.mode, client: BF.client.mode, replica: BF.world.replica }));
    check(pm.host === 'in page' && pm.client === 'in page' && !pm.replica, `?sim=page runs it in the page (${pm.host}, client ${pm.client})`);
    const pday = await playDay(pp, 'page');
    await pp.close();
    const lp = await loadBack(b, purl, 'page', pday);
    pageDiff = lp.diff;
    await lp.pg.close();
    // the hash after loading: the parts that differ in the page are the save's; any other part differing in the worker is the worker's
    const extra = lw.diff.filter(k => !pageDiff.includes(k));
    check(!extra.length, `the worker's save loads back like the page's (${lw.same ? 'the same hash' : 'differing parts ' + (lw.diff.join(', ') || 'none') + '; in the page ' + (pageDiff.join(', ') || 'none')})`);
    console.log(`frame time at 100x: worker ${day.frame.avg.toFixed(2)} ms avg / p95 ${day.frame.p95.toFixed(2)} ms, ${(day.frame.n / day.real).toFixed(1)} frames a second; page ${pday.frame.avg.toFixed(2)} ms avg / p95 ${pday.frame.p95.toFixed(2)} ms, ${(pday.frame.n / pday.real).toFixed(1)} frames a second`);

    // ---- a page opened as a file can't start the worker: the page
    const fpg = await open(b, 'file://' + path.join(root, 'index.html') + '?sim=worker&debugfeed=off#seed' + seed);
    const fm = await fpg.evaluate(() => ({ host: BF.simHost.mode, why: BF.simHost.why, client: BF.client.mode, f3: BF.debugText(BF.debugInfo()).split('\n').find(l => /^Simulation/.test(l)) }));
    check(fm.host === 'in page' && fm.client === 'in page' && /file/.test(fm.why), `opened as a file it falls back to the page (${fm.f3})`);
    await fpg.close();
  } catch (e) {
    check(false, 'the test ran: ' + (e && e.stack || e));
  } finally {
    await b.close();
    srv.kill();
  }
  console.log(fails ? `FAILED ${fails} check(s)` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
