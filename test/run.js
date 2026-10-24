// Headless smoke test. Usage: node test/run.js [outPrefix] [script.js] [--host page|worker|server]
// Loads index.html with Chromium (three.js served locally since the CDN is blocked here),
// prints console errors, runs optional actions from a script module, and screenshots.
// BF_HOST=worker|server (spec r15-43; test/ci.js --host sets it for tests whose // @ci header lists that host in hosts=): the game is
// served over http by debug/server.js (with the world server for server, without it for worker) and the simulation runs there; the
// action script reads simulation state through BFT.sim / require('./lib').sim. Unset or page: index.html as a file, as before.
const path = require('path');
// --host page|worker|server (anywhere on the command line) is the same as BF_HOST
{ const i = process.argv.indexOf('--host'); if (i >= 0) { process.env.BF_HOST = process.argv[i + 1]; process.argv.splice(i, 2); } }
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const out = process.argv[2] || '/tmp/shot';
  const actions = process.argv[3] ? require(path.resolve(process.argv[3])) : null;
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 1280, height: 760 } });
  pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type() + ':', m.text()); });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.addInitScript({ path: path.join(__dirname, 'bft.js') });   // window.BFT, the in-page test helpers
  // No pointer lock: headless Chromium grants it on BF.player.start(), and while the canvas holds it a long evaluate makes the browser
  // and renderer processes grow by 20-40 MB/s each. Without requestPointerLock the game takes its drag-mode path (js/player.js
  // requestLock). Set on every load, pg.reload() too; a test that simulates the lock assigns its own, and one that needs the real
  // lock deletes this (test/planet-drag.js).
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  // The boot world (spec r14-22): planet seed 123 (generator 4, village generator 10), whose nearest village to spawn is a plains village
  // of 59 villagers 89 blocks away (with pen, coop, pasture, sty and stable), as the tests written on generator 3 assumed. BF_HASH
  // overrides it.
  const lib = require('./lib'), host = lib.host(), hash = process.env.BF_HASH != null ? process.env.BF_HASH : '#seed123gen4v10';
  const srv = host === 'page' ? null : await lib.serve({ world: host === 'server' });
  await pg.goto(srv ? srv.url + '?nolod&' + lib.q() + hash : 'file://' + path.join(root, 'index.html') + hash);
  if (srv) {   // the host has started (or the page fell back: then the test fails here rather than later)
    await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
    const w = await lib.where(pg);
    console.log('host ' + host + ': ' + w.label);
    if (w.mode !== host) console.log('FAIL the simulation should run on host ' + host + ' but runs: ' + w.label);
    await lib.simReady(pg);
  }
  await pg.waitForTimeout(5000);
  // a planet boot first works out its rivers (spec r14-10): wait for that step, then the same 5 s for the world to settle
  if (await pg.evaluate(() => !!(window.BF && BF.preparing))) {
    await pg.waitForFunction(() => !BF.preparing, null, { timeout: 180000 }).catch(() => {});
    await pg.waitForTimeout(5000);
  }
  if (actions) await actions(pg, out);
  await pg.keyboard.press('F3');
  await pg.waitForTimeout(300);
  console.log(await pg.evaluate(() => document.getElementById('debug').textContent));
  await pg.screenshot({ path: out + '.png' });
  await b.close();
  if (srv) await srv.stop();
})();
