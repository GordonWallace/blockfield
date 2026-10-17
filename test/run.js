// Headless smoke test. Usage: node test/run.js [outPrefix] [script.js]
// Loads index.html with Chromium (three.js served locally since the CDN is blocked here),
// prints console errors, runs optional actions from a script module, and screenshots.
const path = require('path');
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
  await pg.goto('file://' + path.join(root, 'index.html') + (process.env.BF_HASH != null ? process.env.BF_HASH : '#seed123gen4v10'));
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
})();
