// @ci integration suite=village,world timeout=900
// bug-082: the village sign (its text counts the village's beds, which sets when they were last scanned) is made in the simulation's
// think phase on every host, never from the page's frames. Seed 3 at the village, the headless Node simulation (tools/headless.js, the
// world server's runtime) and a page with its frames halted, booted and ticked the same way (BF.boot.headless) for 60 game seconds:
// both have made the village sign, and the signs and villages parts of the state hash are the same.
// Usage: NODE_PATH=$(npm root -g) node test/sign-think.js [seed=3] [seconds=60]
const path = require('path');
const root = path.resolve(__dirname, '..'), seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 60);
const { chromium } = require(process.env.PW || 'playwright');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 300))); if (!ok) fails++; };
const PARTS = ['signs', 'villages'];
(async () => {
  const { load } = require(path.join(root, 'tools/headless.js'));
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village' } });
  for (let i = 0, n = Math.round(seconds / BF.warp.TICK); i < n; i++) h.tick(1);
  const node = {}; for (const k of PARTS) node[k] = BF.stateHash.text(k);
  const nodeSigns = BF.signs.serialize().data.filter(d => d[2] === 'village').length;
  const b = await chromium.launch();
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  await pg.addInitScript(() => { window.requestAnimationFrame = () => 0; });   // no frames: what the page makes, the think phase makes
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed + 'gen4v10');
  await pg.waitForFunction(() => !!(window.BF && BF.boot && BF.world), null, { timeout: 120000 });
  const page = await pg.evaluate(([seed, seconds, PARTS]) => {
    const h = BF.boot.headless({ seed, settings: { at: 'village' } });
    for (let i = 0, n = Math.round(seconds / BF.warp.TICK); i < n; i++) h.tick(1);
    const texts = {}; for (const k of PARTS) texts[k] = BF.stateHash.text(k);
    return { texts, signs: BF.signs.serialize().data.filter(d => d[2] === 'village').length };
  }, [seed, seconds, PARTS]);
  check(nodeSigns > 0, `the headless run made the village sign (${nodeSigns})`);
  check(page.signs === nodeSigns, `the page with no frames made it too (${page.signs})`);
  for (const k of PARTS) {
    const x = node[k], y = page.texts[k];
    let i = 0; while (i < x.length && x[i] === y[i]) i++;
    check(x === y, `the ${k} hash part is the same in Node and the page`, x === y ? undefined : { at: i, node: x.slice(Math.max(0, i - 60), i + 60), page: y.slice(Math.max(0, i - 60), i + 60) });
  }
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
