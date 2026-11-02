// @ci integration suite=ui,world timeout=1500
// Choosing the simulation's host (spec r15-43, js/simhost.js): where the game runs its simulation, and that each host works.
//   - served by debug/server.js with the world server, the page picks the server by itself: BF.simHost.mode "server", F3's last line and
//     the pause menu's Simulation button say "World server (1 thread)", the game log says so; BFT.sim reads the server thread's world;
//   - a debug screen alert (js/alertsim.js) fires on the server: the world freezes there and on the page, the notice shows, Right resumes;
//   - ?sim=page forces the page ("Browser (this page)", why: asked for); the Simulation setting (localStorage blockfield.sim, cycled by the
//     pause menu's button) forces a worker on the next start;
//   - served without the world server (--no-world), the page picks a Web Worker by itself ("Browser (worker)"), and the alert works there;
//   - opened as a file, the page runs it ("Browser (this page)", why: a file), and the alert works there;
//   - on each host a sign's text and the player's food set in the simulation show on the page, and the page draws the sign's text.
// Usage: NODE_PATH=$(npm root -g) node test/hosts.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const HASH = '#seed123gen4v10';

let ctx = null;
async function open(b, url, setup) {
  if (!ctx) {
    ctx = await b.newContext({ viewport: { width: 960, height: 600 } });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
  }
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
  await lib.install(pg);
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  if (setup) await pg.addInitScript(setup);
  const t0 = Date.now();
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  pg.chose = (Date.now() - t0) / 1000;
  await lib.ready(pg);
  await lib.simReady(pg);
  await pg.evaluate(() => BF.player.start());   // past the title screen (the speed keys and Escape need a game)
  return pg;
}
const where = pg => pg.evaluate(() => {
  return { mode: BF.simHost.mode, why: BF.simHost.why, label: BF.simHost.label(), f3: BF.debugText(BF.debugInfo()).split('\n').find(l => /^Simulation/.test(l)),
    log: BF.glog.recent(1e6).filter(e => e.k === 'worker').map(e => e.l + ' ' + e.x) };
});
// the pause menu's Simulation button, as the pause menu shows it (Escape opens the menu: no pointer lock in the tests)
const pauseHost = async pg => {
  await pg.keyboard.press('Escape');
  await pg.waitForFunction(() => document.querySelector('.bfp-pause.on'), null, { timeout: 10000 }).catch(() => {});
  return pg.evaluate(() => { const el = document.querySelector('.bfp-pause.on [data-act="host"]'); return el ? el.textContent : null; });
};

// an alert set up on the debug screen (its POST /alerts; a page opened as a file has no debug server: set on the page, as the feed does)
// reaches the simulation, and a matching village log entry there freezes it
async function alertWorks(pg, label, srv) {
  const A = [{ id: 'hosts-test', kind: 'birth', text: 'hosts test baby', on: true }];
  if (srv) await fetch(srv.debugUrl + 'alerts', { method: 'POST', body: JSON.stringify({ alerts: A }) });
  else await pg.evaluate(a => BF.alerts.set(a, 'hosts-1'), A);
  await pg.waitForFunction(() => BF.alerts.list.some(a => a.id === 'hosts-test'), null, { timeout: 20000 }).catch(() => {});
  const got = await new Promise(r => setTimeout(r, 1000)).then(() => lib.sim(pg, () => BF.alertSim.list.map(a => a.id)));
  check(got.join() === 'hosts-test', `${label}: the alert list reaches the simulation (${got})`);
  await lib.toVillage(pg);
  await pg.evaluate(() => BF.warp.set(4));   // 100x
  await new Promise(r => setTimeout(r, 500));
  const fired = await lib.sim(pg, () => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const m = rec && rec.members.find(x => x.type === 'villager' && !x.dead && x.position);
    if (!m) return { none: true };
    BF.vlog.log(rec, 'birth', 'Hosts test baby was born to A and B', m);
    return { frozen: BF.warp.frozen, speed: BF.warp.speed, t: BF.simNow() };
  });
  check(fired.frozen && fired.speed === 0, `${label}: the simulation froze at once ${JSON.stringify(fired)}`);
  const shown = await pg.waitForFunction(() => { const e = document.getElementById('bf-alert'); return e && !e.hidden && /Hosts test baby/.test(e.textContent) && BF.warp.frozen; }, null, { timeout: 20000 }).then(() => true, () => false);
  check(shown, `${label}: the page shows the notice and its clock is at 0x`);
  const still = await new Promise(r => setTimeout(r, 1500)).then(() => lib.sim(pg, () => ({ t: BF.simNow(), frozen: BF.warp.frozen })));
  check(still.frozen && still.t === fired.t, `${label}: nothing runs in the simulation while frozen ${JSON.stringify(still)}`);
  const hits = await pg.evaluate(() => BF.alerts.hits['hosts-test'] && BF.alerts.hits['hosts-test'].n);
  check(hits === 1, `${label}: the page counts the hit for the debug screen (${hits})`);
  await pg.keyboard.press('ArrowRight');
  const resumed = await pg.waitForFunction(() => BF.warp.speed === 1 && document.getElementById('bf-alert').hidden, null, { timeout: 10000 }).then(() => true, () => false);
  const simSpeed = await new Promise(r => setTimeout(r, 800)).then(() => lib.sim(pg, () => ({ speed: BF.warp.speed, frozen: BF.warp.frozen })));
  check(resumed && simSpeed.speed === 1 && !simSpeed.frozen, `${label}: Right dismisses it and the simulation runs at 1x again ${JSON.stringify(simSpeed)}`);
  const logged = await lib.sim(pg, () => BF.glog.recent(1e6).filter(e => e.k === 'alerts').map(e => e.x));
  check(logged.some(x => /Debug screen alerts: 1 on/.test(x)) && logged.some(x => /fired in .*Hosts test baby/.test(x)), `${label}: the game log has the alerts lines (${logged.length})`);
  if (srv) await fetch(srv.debugUrl + 'alerts', { method: 'POST', body: JSON.stringify({ alerts: [] }) });
  else await pg.evaluate(() => BF.alerts.set([], 'hosts-2'));
}

// what the page draws from the simulation besides blocks and mobs (gaps r15-38 left): a sign's text written in the simulation shows on
// the page's sign, and eating there fills the page's saturation
async function replicaWorks(pg, label) {
  const cell = await lib.sim(pg, () => {
    const p = BF.player.position, x = Math.floor(p.x) + 2, z = Math.floor(p.z), y = Math.floor(p.y) + 1;
    BF.world.setBlock(x, y - 1, z, BF.B.stone); BF.world.setBlock(x, y, z, BF.B.oak_sign_n);
    BF.signs.setText(x, y, z, 'Hosts test sign');
    return { x, y, z, text: BF.signs.get(x, y, z) && BF.signs.get(x, y, z).text };
  });
  const seen = await pg.waitForFunction(c => { const g = BF.signs.get(c.x, c.y, c.z); return g && g.text === 'Hosts test sign'; }, cell, { timeout: 15000 }).then(() => true, () => false);
  check(cell.text === 'Hosts test sign' && seen, `${label}: a sign's text written in the simulation is on the page's sign`);
  // and the page draws it (its copy of the world finds its signs as their chunks come in, bug-097): one text overlay on that sign
  const drawn = await pg.waitForFunction(c => { const g = BF.signs.groupAt(c.x, c.y, c.z); return g && BF.signs._state.overlays.has(g.key); }, cell, { timeout: 15000 }).then(() => true, () => false);
  check(drawn, `${label}: the page draws that sign's text`);
  // (as eating does: a request, whose self message goes at once, before the page's next player message could report the old values)
  const sat = await lib.sim(pg, () => { BF.player.saturation = 0.5; BF.player.hunger = 10; BF.proto.flush(); return BF.player.saturation; });
  const got = await pg.waitForFunction(() => BF.player.saturation === 0.5 && BF.player.hunger === 10, null, { timeout: 15000 }).then(() => true, () => false);
  check(sat === 0.5 && got, `${label}: food set in the simulation reaches the page (hunger and saturation)`);
  await pg.evaluate(() => { BF.player.hunger = BF.player.maxHunger; BF.player.saturation = 5; });
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let srv = null;
  try {
    // ---- served with the world server: the server by itself
    srv = await lib.serve();
    let pg = await open(b, srv.url + '?nolod' + HASH);
    let w = await where(pg);
    check(w.mode === 'server' && w.label === 'World server (1 thread)' && w.f3 === 'Simulation: World server (1 thread)', `served by ./run.sh: the world server (${w.f3}, chosen in ${pg.chose.toFixed(1)} s)`);
    check(w.log.some(l => /^INFO The simulation runs on the world server/.test(l)), 'the game log says so');
    const s = await lib.sim(pg, () => ({ server: typeof process !== 'undefined' && !!(process.versions && process.versions.node), tick: BF.rand.tick, mobs: BF.mobs.list.length }));
    check(s.server && s.tick > 0 && s.mobs > 0, `BFT.sim runs on the server's thread ${JSON.stringify(s)}`);
    await alertWorks(pg, 'world server', srv);
    await replicaWorks(pg, 'world server');
    const btn = await pauseHost(pg);
    check(btn === 'Simulation: World server (1 thread)', `the pause menu shows it (${btn})`);
    // the setting: the pause menu's button cycles Automatic -> World server -> Browser (worker); next start takes a worker
    const cyc = await pg.evaluate(() => { const el = document.querySelector('.bfp-pause [data-act="host"]'); const seen = []; for (let i = 0; i < 2; i++) { el.click(); seen.push(localStorage.getItem('blockfield.sim')); } return { seen, text: el.textContent, note: document.querySelector('.bfp-pause .bfp-note').textContent }; });
    check(cyc.seen.join() === 'server,worker' && /setting: Browser \(worker\)/.test(cyc.text) && /next start: Browser \(worker\)/.test(cyc.note), `the button cycles the setting ${JSON.stringify(cyc)}`);
    await pg.close();
    pg = await open(b, srv.url + '?nolod' + HASH);
    w = await where(pg);
    check(w.mode === 'worker' && w.f3 === 'Simulation: Browser (worker)', `with the setting at Browser (worker), the next start takes a worker on the server's page (${w.f3})`);
    await pg.evaluate(() => BF.simHost.setPref('auto'));
    check(await pg.evaluate(() => localStorage.getItem('blockfield.sim') === null && BF.simHost.pref() === 'auto'), 'Automatic clears the setting');
    await pg.close();
    // ?sim=page forces the page
    pg = await open(b, srv.url + '?nolod&sim=page' + HASH);
    w = await where(pg);
    check(w.mode === 'in page' && w.f3 === 'Simulation: Browser (this page) (asked for)', `?sim=page: the page (${w.f3})`);
    check(w.log.some(l => /^INFO The simulation runs in the page \(asked for/.test(l)), 'the game log says it was asked for');
    await pg.close();
    await srv.stop(); srv = null;

    // ---- served without the world server: a Web Worker by itself
    srv = await lib.serve({ world: false });
    pg = await open(b, srv.url + '?nolod' + HASH);
    w = await where(pg);
    check(w.mode === 'worker' && w.label === 'Browser (worker)' && w.f3 === 'Simulation: Browser (worker)', `no world server: a worker (${w.f3}, chosen in ${pg.chose.toFixed(1)} s)`);
    check(!w.log.some(l => /^WARN/.test(l)), 'no warning: the server was not asked for');
    const ws = await lib.sim(pg, () => ({ worker: typeof WorkerGlobalScope !== 'undefined', mobs: BF.mobs.list.length }));
    check(ws.worker && ws.mobs > 0, `BFT.sim runs in the worker ${JSON.stringify(ws)}`);
    await alertWorks(pg, 'worker', srv);
    await replicaWorks(pg, 'worker');
    await pg.close();
    await srv.stop(); srv = null;

    // ---- opened as a file: the page
    pg = await open(b, 'file://' + path.join(root, 'index.html') + HASH);
    w = await where(pg);
    check(w.mode === 'in page' && /^Simulation: Browser \(this page\) \(the page was opened as a file/.test(w.f3), `opened as a file: the page (${w.f3})`);
    check(w.log.some(l => /^INFO The simulation runs in the page: the page was opened as a file/.test(l)), 'the game log says why, as INFO');
    await alertWorks(pg, 'page');
    await replicaWorks(pg, 'page');
    await pg.close();
  } catch (e) {
    check(false, 'the test ran: ' + (e && e.stack || e));
  } finally {
    await b.close();
    if (srv) await srv.stop();
  }
  console.log(fails ? `FAILED ${fails} check(s)` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
