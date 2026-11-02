// @ci integration suite=world,ui timeout=1800
// The Node world server (spec r15-41, server/world.js, debug/server.js): ./run.sh's server on free ports (its saves in a temp folder),
// a page opened with ?sim=server, seed 3:
//   - the page finds the server (its hello) and is its client: BF.simHost.mode "server", F3 and the game log say so; the server solves
//     each planet's river network once and keeps it (<saves>/rivers/);
//   - a new world plays a game day at 100x on the server in lockstep ticks; its state hash is compared part by part with a headless
//     run (tools/headless.js load, BF.boot.headless) of as many ticks from the same start (REPORT-ONLY on the parts, as test/headless.js:
//     the mobs differ between two headless runs too, until Stage 1's determinism is enforced; the clock must match);
//   - the debug screen's feed comes from the server itself (/state on the debug port), with and without a page;
//   - a second page is refused (one plays at a time) and runs its own simulation in a Web Worker;
//   - the page closes mid-way: the world pauses at once and saves; a fresh page picks it again from the server's list and goes on with
//     the same world (the same hash) at the speed it had;
//   - the server stops: the page shows "World server stopped" with the game log's last lines.
// Usage: NODE_PATH=$(npm root -g) node test/server.js [seed=3]
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), net = require('net');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
const ENFORCE = process.env.BF_DETERMINISM === 'enforce';
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-server-'));

async function server() {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug), '--saves', saves, '--alerts', path.join(saves, 'alerts.json')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
const state = d => fetch(d + '/state').then(r => r.json());

let ctx = null;
async function open(b, url) {
  if (!ctx) {
    ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
  }
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
  pg.on('console', m => { if (m.type() === 'error' && !/GL Driver|World server stopped|ERR_CONNECTION_REFUSED/.test(m.text())) console.log('console.error:', m.text().slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  return pg;
}
const query = (pg, what, args) => pg.evaluate(([w, a]) => new Promise(r => BF.client.query(w, a || {}, r)), [what, args]);
const diffParts = (a, b) => Object.keys(Object.assign({}, a, b)).filter(k => a[k] !== b[k]);

// a headless run of n ticks from the same start (in this process: tools/headless.js)
function headless(n) {
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village', villages: 10, gameMode: 'creative' } });
  const start = h.stateHash();
  h.tick(n);
  return { start, end: h.stateHash(), ticks: h.ticks, clock: BF.stateHash.text('clock') };
}

(async () => {
  const { srv, url, debug } = await server();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const surl = url + '?sim=server#seed' + seed;
  try {
    // ---- the page finds the server
    const pg = await open(b, surl);
    const m = await pg.evaluate(() => ({ host: BF.simHost.mode, server: BF.simHost.server, client: BF.client.mode, replica: BF.world.replica, f3: BF.debugText(BF.debugInfo()).split('\n').find(l => /^Simulation/.test(l)) }));
    check(m.host === 'server' && m.server && m.client === 'worker' && m.replica, `the page is the world server's client (${m.host}, client ${m.client})`);
    check(m.f3 === 'Simulation: World server (1 thread)', `F3 says so (${m.f3})`);
    await pg.waitForFunction(() => BF.glog.recent(500).some(e => e.k === 'worker' && /started in the simulation worker/.test(e.x)), null, { timeout: 240000 }).catch(() => {});   // (the server solves the planet's rivers: about 75 s)
    const logs = await pg.evaluate(() => BF.glog.recent(500).filter(e => e.k === 'worker' || e.k === 'protocol').map(e => e.x));
    console.log('log: ' + logs.join(' | ').slice(0, 600));
    check(logs.some(x => /The simulation runs on the world server/.test(x)) && logs.some(x => /Simulation worker loaded/.test(x)), 'the game log says the simulation runs on the world server (and its thread loaded)');
    check(logs.some(x => /Title screen world seed \d+ started in the simulation worker/.test(x)), "the title screen's world runs on the server");

    // ---- a new world, lockstep, at the village nearest the spawn (where the headless boot puts its player), paused until loaded
    await pg.evaluate(() => { BF.state.paused = true; });
    await pg.waitForTimeout(500);
    await pg.evaluate(() => BF.proto.worker.w.postMessage({ test: 'lockstep' }));
    const r = await pg.evaluate(async seed => {
      BF.player.start();
      BF.state.paused = true;
      const meta = await BF.save.create({ name: 'server-test', seed: String(seed), gameMode: 'creative', villages: 10 });
      const P = BF.planet, p = BF.player.position;
      const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
      if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5); }
      BF.state.paused = true;
      return { id: meta.id, village: !!v };
    }, seed);
    check(r.village, 'the player is at the village nearest the spawn');
    await pg.waitForTimeout(10000);   // (paused: the server loads the chunks round the player)
    const rv = fs.existsSync(path.join(saves, 'rivers')) ? fs.readdirSync(path.join(saves, 'rivers')) : [];
    check(rv.includes(encodeURIComponent(seed + ':1') + '.v8'), `the server keeps the river networks it solved (${rv.join(', ')})`);
    const h0 = await query(pg, 'hash');
    check(h0.ok && h0.tick === 0, `the new world has not ticked yet (tick ${h0.tick})`);
    const d0 = await pg.evaluate(() => BF.client.world.clock ? BF.client.world.clock.day + BF.client.world.clock.time : -1);
    const t0 = Date.now();
    await pg.evaluate(() => { BF.warp.set(4); BF.state.paused = false; });   // 100x
    await pg.waitForFunction(d0 => { const c = BF.client.world.clock; return c && c.day + c.time >= d0 + 1; }, d0, { timeout: 1200000, polling: 1000 });
    await pg.evaluate(() => { BF.state.paused = true; });
    await pg.waitForTimeout(1500);
    const real = (Date.now() - t0) / 1000;
    const h1 = await query(pg, 'hash'), h1b = await query(pg, 'hash');
    check(h1.ok && h1.hash === h1b.hash && h1.tick > 20000, `paused after a game day (${h1.tick} ticks in ${real.toFixed(0)} s real, ${(h1.tick * 0.05 / real).toFixed(0)}x), the world stands still`);
    const seen = await pg.evaluate(() => { const E = [...BF.client.world.entities.values()]; return { villagers: E.filter(e => e.kind === 'mob' && e.type === 'villager').length, villages: BF.client.world.villages.size }; });
    check(seen.villagers > 0 && seen.villages > 0, `villagers in the client's mirror (${seen.villagers} villagers, ${seen.villages} villages)`);
    const st0 = await state(debug);
    check(st0.latest && st0.latest.server && st0.latest.server.page && Object.keys(st0.layouts || {}).length > 0 && /Simulation: World server/.test(st0.latest.text || ''), `the debug screen's feed comes from the server, with the page's F3 part (${Object.keys(st0.layouts || {}).length} village layouts)`);
    const keys = await pg.evaluate(() => [...BF.world.chunks.keys()]);
    const wh = await query(pg, 'chunkHash', { keys });
    const ph = await pg.evaluate(k => BF.proto.simHash(k), wh.keys);
    check(wh.keys.length > 50 && wh.hash === ph, `the page's copy of the world has the server's blocks (${wh.keys.length} chunks)`);

    // ---- the same ticks headless
    const hl = headless(h1.tick);
    const startDiff = diffParts(h0.parts, hl.start.parts), endDiff = diffParts(h1.parts, hl.end.parts);
    console.log(`headless start ${hl.start.hash} / server ${h0.hash}${startDiff.length ? ' (parts ' + startDiff.join(', ') + ')' : ''}`);
    console.log(`${endDiff.length ? 'DIFF' : 'same'} after ${hl.ticks} ticks: headless ${hl.end.hash} / server ${h1.hash}${endDiff.length ? ' (parts ' + endDiff.join(', ') + ')' : ''}`);
    const clk = await query(pg, 'partText', { part: 'clock' });
    check(h1.parts.clock === hl.end.parts.clock, `the clock matches the headless run after as many ticks (server ${clk.text}, headless ${hl.clock})`);
    if (!endDiff.length || ENFORCE) check(!endDiff.length, 'the server and the headless run hash the same world');
    else console.log('report-only (ENFORCE off until Stage 1, as test/headless.js): the difference does not fail the test');

    // ---- a second page is refused and runs its own simulation
    const p2 = await open(b, surl.replace('#seed', '&debugfeed=off#seed'));
    const m2 = await p2.evaluate(() => ({ host: BF.simHost.mode, log: BF.glog.recent(200).filter(e => e.l === 'WARN').map(e => e.x) }));
    check(m2.host === 'worker' && m2.log.some(x => /another page is playing/.test(x)), `a second page is refused and runs a Web Worker (${m2.host}; ${m2.log.slice(-2).join(' / ')})`);
    await p2.close();

    // ---- the page closes: the world pauses and saves; a fresh page picks it again
    await pg.evaluate(() => { BF.warp.set(4); BF.state.paused = false; });   // (playing at 100x when it closes)
    await pg.waitForTimeout(3000);
    await pg.close();
    await new Promise(res => { const t = setInterval(() => { if (/paused and saved/.test(srv.out)) { clearInterval(t); res(); } }, 200); setTimeout(() => { clearInterval(t); res(); }, 30000); });
    check(/world "server-test" paused and saved/.test(srv.out), 'the page closed: the server paused the world and saved it');
    // (with no debug screen open the server feeds every 2 s, server/world.js FEED_IDLE_MS: waits for a fresh one, up to 8 s)
    let st1 = null;
    for (const until = Date.now() + 8000; Date.now() < until; await new Promise(res => setTimeout(res, 250))) {
      st1 = await state(debug);
      if (st1.latest && st1.latest.server && st1.latest.server.held && Date.now() - st1.latest.t < 3000) break;
    }
    check(st1.latest && st1.latest.server && st1.latest.server.held && Date.now() - st1.latest.t < 3000, 'with no page the debug screen still gets the feed from the server');
    const pg2 = await open(b, surl);
    const l = await pg2.evaluate(async id => {
      const list = await BF.save.list();
      BF.player.start();
      BF.state.paused = true;
      const meta = await BF.save.load(id);
      const t = Date.now();
      while (Date.now() - t < 10000 && !BF.glog.recent(300).some(e => /held world "server-test" goes on at 100x/.test(e.x))) await new Promise(res => setTimeout(res, 250));
      return { listed: list.map(w => w.name), name: meta && meta.name, speed: BF.warp.speed, held: BF.glog.recent(300).some(e => /held world "server-test" goes on at 100x/.test(e.x)),
        picked: BF.glog.recent(300).some(e => e.k === 'server' && /picked world "server-test" up again/.test(e.x)) };
    }, r.id);
    check(l.listed.includes('server-test'), `the title screen lists the server's worlds (${l.listed.join(', ')})`);
    check(l.name === 'server-test' && l.speed === 100 && l.held && l.picked, `a fresh page picked the held world up again at the speed it had (${l.speed}x; game log: page ${l.held}, server ${l.picked})`);
    const h2 = await query(pg2, 'hash');
    check(h2.ok && h2.tick > h1.tick, `it is the same world, played on until the page closed (tick ${h2.tick}, ${h1.tick} at the day's end)`);
    const h2b = await query(pg2, 'hash');
    check(h2.hash === h2b.hash, 'paused (the page\'s menu), it stands still');
    await pg2.evaluate(() => { BF.state.paused = false; });
    await pg2.waitForTimeout(3000);
    const h3 = await query(pg2, 'hash');
    check(h3.tick > h2.tick + 100, `unpaused it goes on (tick ${h3.tick})`);

    // ---- the server stops
    srv.kill('SIGKILL');
    await pg2.waitForFunction(() => !!document.getElementById('bf-crash'), null, { timeout: 20000 }).catch(() => {});
    const cr = await pg2.evaluate(() => ({ shown: !!document.getElementById('bf-crash'), title: document.querySelector('#bf-crash div div') && document.querySelector('#bf-crash div div').textContent, text: document.querySelector('#bf-crash pre') ? document.querySelector('#bf-crash pre').textContent : '' }));
    check(cr.shown && cr.title === 'World server stopped' && /game log's last lines/.test(cr.text) && cr.text.split('\n').length > 5, 'the server stopped: the page says "World server stopped" with the log\'s last lines');
    await pg2.close();
  } catch (e) {
    check(false, 'the test ran: ' + (e && e.stack || e));
  } finally {
    await b.close();
    srv.kill();
    fs.rmSync(saves, { recursive: true, force: true });
  }
  console.log(fails ? `FAILED ${fails} check(s)` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
