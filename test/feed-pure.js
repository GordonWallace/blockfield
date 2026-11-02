// @ci integration suite=world timeout=1200
// Reading the debug feed changes nothing (2026-10-30): the same seed booted twice, one page reading the debug screen's simulation part
// (js/debugfeed.js simPart) every 20 ticks and the other not, must hash the same (js/statehash.js) at every check. The feed's reads used
// to make a poultry keeper's, cowherd's, pig farmer's, shepherd's or explorer's state (each draws from its stream) and keep the coop,
// pasture, sty or pen it looked up, so a world with a screen watching played differently; and the region workers' followers had to
// read the feed too (js/rplay.js "feed", about 35 ms each time) to stay the same as the leader. Seed 7 has an explorer near the spawn.
// Steps and chunk loading as test/determinism.js.
// Usage: NODE_PATH=$(npm root -g) node test/feed-pure.js [seeds=3,7] [days=0.5]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seeds = (process.argv[2] || '3,7').split(',').map(Number), days = +(process.argv[3] || 0.5);
const CHECKS = Math.max(1, Math.round(8 * days));   // a comparison every eighth of a game day
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

async function boot(b, seed, n) {
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log(`PAGEERROR [page ${n}]`, (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  // a feed address nothing listens on: the feed module loads (debugfeed=off leaves it out) and its sends fail quietly
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=http://127.0.0.1:9#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);
  await pg.evaluate(() => {
    window.__step = () => BF.simStep(BF.warp.TICK);
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
    window.__settle = () => { const p = BF.player.position; let same = 0, n = BF.world.chunks.size;
      for (let i = 0; i < 200 && same < 3; i++) { BF.world.update(p.x, p.z, 50); const m = BF.world.chunks.size; same = m === n ? same + 1 : 0; n = m; } };
  });
  let last = -1;
  for (let i = 0; i < 240; i++) {
    const c = await pg.evaluate(() => { window.__load(20); return { n: BF.world.chunks.size, q: BF.world.queueLength }; });
    if (c.n === last && c.q === 0 && i > 5) break;
    last = c.n; await pg.waitForTimeout(250);
  }
  return pg;
}
// k steps; reading the feed every 20 ticks when asked (as the world server's debug screen asks about every 250 ms)
const advance = (pg, steps, feed) => pg.evaluate(([k, feed]) => {
  for (let i = 0; i < k; i++) {
    window.__step();
    if (i % 50 === 0) window.__settle();
    if (feed && i % 20 === 7) { BF.debugFeed.simPart(null, true); window.__feeds = (window.__feeds || 0) + 1; }
  }
  return Object.assign(BF.stateHash.full(), { feeds: window.__feeds || 0 });
}, [steps, feed]);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const seed of seeds) {
    const t0 = Date.now();
    const pages = await Promise.all([boot(b, seed, 1), boot(b, seed, 2)]);
    const steps = Math.round(1200 / 0.05 / 8);   // an eighth of a day (js/sky.js dayLength 1200 s)
    let firstDiff = null, res = null;
    for (let c = 1; c <= CHECKS && !firstDiff; c++) {
      res = await Promise.all(pages.map((pg, i) => advance(pg, steps, i === 1)));
      if (res[0].hash !== res[1].hash) {
        const parts = Object.keys(res[0].parts).filter(k => res[0].parts[k] !== res[1].parts[k]);
        firstDiff = `day ${(c / 8).toFixed(3)}: parts ${parts.join(', ')}`;
        const k = parts.includes('mobs') ? 'mobs' : parts[0];
        const [x, y] = await Promise.all(pages.map(pg => pg.evaluate(k => BF.stateHash.text(k), k)));
        let i = 0; while (i < x.length && x[i] === y[i]) i++;
        const cut = t => JSON.stringify(t.slice(Math.max(0, i - 160), i + 120));
        console.log(`  ${k} first differs at character ${i}:\n    without the feed ${cut(x)}\n    reading the feed ${cut(y)}`);
      }
    }
    check(!firstDiff, `seed ${seed}: reading the feed ${res[1].feeds} times in ${days} game days changes nothing${firstDiff ? ' (differs at ' + firstDiff + ')' : ''} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    await Promise.all(pages.map(pg => pg.context().close()));
  }
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('PASS feed-pure');
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
