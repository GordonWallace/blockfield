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
  await pg.goto('file://' + path.join(root, 'index.html'));
  await pg.waitForTimeout(5000);
  if (actions) await actions(pg, out);
  await pg.keyboard.press('F3');
  await pg.waitForTimeout(300);
  console.log(await pg.evaluate(() => document.getElementById('debug').textContent));
  await pg.screenshot({ path: out + '.png' });
  await b.close();
})();
