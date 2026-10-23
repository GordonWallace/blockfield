// @ci integration suite=village timeout=1500
// Region queries for villagers, the player and the UI (spec r15-32): with BF.regions.verifyQueries on, every converted scan (region
// queries, the village's own lists, the per-type lists) also runs the old scan of BF.mobs.list and compares. On seed 3 (planet,
// village generator 10), at the village nearest the spawn, one game day of simulation steps, plus a lightning strike on a mob, the
// villager name labels, /kill of one type and a jobsite block placed and broken: no differences, and every kind of query was used.
// Usage: NODE_PATH=$(npm root -g) node test/region-queries-villagers.js [seed=3] [days=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3), days = +(process.argv[3] || 1);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)));
  // the frame loop is held: only the test's steps move the world
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);

  await pg.evaluate(() => {
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
  });
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const c = await pg.evaluate(() => { window.__load(20); BF.simStep(0.05); return BF.world.chunks.size; });
    if (c === last && i > 5) break;
    last = c; await pg.waitForTimeout(250);
  }
  await pg.evaluate(() => { BF.regions.verifyQueries = true; BF.regions.resetQueryStats(); });

  // ---------------------------------------------------------------- a game day (in slices, so the page stays responsive)
  const steps = Math.round(days * 1200 / 0.05), SLICE = 2000;
  const t0 = Date.now();
  for (let done = 0; done < steps; done += SLICE) {
    await pg.evaluate(n => { for (let i = 0; i < n; i++) { BF.simStep(0.05); if (i % 50 === 0) window.__load(1); } }, Math.min(SLICE, steps - done));
  }
  const day = await pg.evaluate(() => ({ st: BF.regions.queryStats(), mobs: BF.mobs.list.length, villagers: BF.regions.ofType('villager').length }));
  console.log(`  ${steps} steps in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${day.mobs} mobs, ${day.villagers} villagers; ${day.st.checked} queries checked`);
  console.log('  by kind: ' + Object.entries(day.st.labels).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', '));

  // ---------------------------------------------------------------- the player, commands, UI, a jobsite
  const ex = await pg.evaluate(() => {
    const out = {}, W = BF.world, R = BF.regions;
    const vs = R.ofType('villager').filter(m => !m.dead && m.onGround);
    const v = vs[0];
    // a zombie next to the player, and lightning on it (weather.js)
    const p = BF.player.position, zb = BF.mobs.spawn ? BF.mobs.spawn('zombie', p.x + 3, p.y, p.z) : null;
    out.zombie = !!zb;
    if (zb && BF.weather && BF.weather.strikeAt) { const hp = zb.hp; BF.weather.strikeAt(zb.position.x, Math.floor(zb.position.y), zb.position.z); out.struck = zb.hp < hp || !!zb.dead; }
    // the villager name labels (villagelog.js)
    if (BF.vlog && BF.vlog.update) BF.vlog.update(0.05, true);
    // /kill of one type (commands.js)
    if (BF.commands) { const r = BF.commands.execute('/kill zombie'); out.kill = r && r.msg; }
    // a jobsite block placed by an unemployed villager remembering it (jobs.js reclaimAt / reservedForMemory)
    out.jobs = !!(BF.jobs && v);
    if (v && BF.emit && BF.B.composter) {
      const x = Math.floor(v.position.x) + 2, z = Math.floor(v.position.z), y = W.heightAt(x, z) + 1;
      if (W.getBlock(x, y, z) === 0) { W.setBlock(x, y, z, BF.B.composter); BF.emit('blockPlaced', x, y, z, BF.B.composter); W.setBlock(x, y, z, 0); BF.emit('blockBroken', x, y, z, BF.B.composter); }
    }
    for (let i = 0; i < 200; i++) BF.simStep(0.05);
    out.st = R.queryStats();
    R.verifyQueries = false;
    return out;
  });
  console.log('  by kind (all): ' + Object.entries(ex.st.labels).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', '));
  if (ex.kill) console.log('  /kill zombie: ' + ex.kill);
  check(ex.st.diffs === 0, `every converted query agrees with the old scan of BF.mobs.list (${ex.st.checked} checked, ${ex.st.diffs} differences)` + (ex.st.last ? ' ' + JSON.stringify(ex.st.last) : ''));
  const L = ex.st.labels, has = k => (L[k] || 0) > 0;
  const want = ['ofType villager', 'villageMobs', 'jobs reaching'];
  check(want.every(has), `the per-villager loops, village lists and jobsite reach were used (${want.map(k => k + ' ' + (L[k] || 0)).join(', ')})`);
  check(has('villagelog labels'), `the name labels used a region query (${L['villagelog labels'] || 0})`);
  check(ex.zombie && ex.struck, `lightning hit the zombie next to the player (${ex.struck})`);
  check(has('lightning'), 'the strike used a region query');
  await b.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
