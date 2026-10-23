// @ci integration suite=village soak timeout=1200
// Decision comparison soak (spec r15-07): the villager decision speed-ups (explorers' map columns, foresters' log bases, the village bed scan,
// breeding encounters, miners fending off mobs; caches keyed by chunk.ver, js/world.js) must decide exactly what the old scans did.
// With BF.debug.decisionCompare on, every cached answer is also worked out the old way (js/decisioncompare.js). One game day in the
// village nearest the spawn (seed 3: a big village with explorers, foresters and miners), stepped with no rendering like test/bakechain.js,
// then: no difference at all, each comparison ran, the comparison mode was logged, no page errors.
// Usage: NODE_PATH=$(npm root -g) node test/decision-compare.js [days=1] [seed=3]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 1), SEED = +(process.argv[3] || 3);
const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  let pageErrors = 0;
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  await pg.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb));
    window.BF = window.BF || {}; window.BF.lodOff = true; window.BF.debug = { decisionCompare: true };
  });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await require('./lib').ready(pg);
  await pg.waitForTimeout(3000);
  const where = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    const y = (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3;
    BF.player.spawn(v.x + 0.5, y, v.z + 0.5);
    BF.player.position.y = y + 40;   // hover above, so the player never lands inside terrain
    if (BF.player.setFlying) BF.player.setFlying(true);
    return { x: v.x, z: v.z };
  });
  // load the area and let the village come out, then step the simulation (0.05 s steps, as fast-forward does)
  await pg.evaluate(({ x, z }) => {
    window.__step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); if (BF.dayTimeline) BF.dayTimeline.update(); BF.drops.update(h); BF.boats.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(x, z, 60); if (i % 4 === 0) __step(0.05); }
    for (let i = 0; i < 2600; i++) { if (i % 10 === 0) BF.world.update(x, z, 30); __step(0.05); }
  }, where);
  const start = await pg.evaluate(() => ({ day: BF.sky.day + BF.sky.time, villagers: BF.mobs.list.filter(m => m.type === 'villager' && !m.dead).length,
    profs: [...new Set(BF.mobs.list.filter(m => m.type === 'villager').map(m => m.profession))].sort() }));
  console.log('village', JSON.stringify(where), 'day', start.day.toFixed(2), start.villagers, 'villagers', start.profs.join(' '));
  const HOURS = Math.round(DAYS * 24);
  for (let h = 0; h < HOURS; h++) {
    const r = await pg.evaluate(({ x, z }) => {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) { if (i % 20 === 0) BF.world.update(x, z, 3); __step(0.05); }   // one game hour
      return { ms: performance.now() - t0, day: BF.sky.day + BF.sky.time, checks: BF.dcmp.stats.checks, diffs: BF.dcmp.stats.diffs };
    }, where);
    if (h % 4 === 3 || r.diffs) console.log(`h${h} day ${r.day.toFixed(2)} ${(r.ms / 1000).toFixed(2)} ms/step checks ${r.checks} diffs ${r.diffs}`);
  }
  const st = await pg.evaluate(() => { const L = BF.glog.recent(1e9);   // (the world's entries, or those kept before a saved world opens)
    return { stats: JSON.parse(JSON.stringify(BF.dcmp.stats)), logged: L.filter(e => e.k === 'decision-compare').length, errs: L.filter(e => e.k === 'decision-diff').map(e => e.x).slice(0, 20) }; });
  console.log('comparisons', JSON.stringify(st.stats.byKind));
  ok('no decision differs from the old scans over ' + DAYS + ' game day(s)', st.stats.diffs === 0, st.stats.diffs ? st.stats.first.slice(0, 5) : undefined);
  for (const k of ['map column', 'village beds', 'breeding encounters', 'miner fend', 'forester trees'])
    ok('compared: ' + k, (st.stats.byKind[k] || {}).checks > 0, st.stats.byKind[k]);
  ok('the comparison mode is in the game log, differences as ERROR decision-diff', st.logged >= 1 && st.errs.length === st.stats.first.length, { logged: st.logged, errs: st.errs });
  ok('no page errors', pageErrors === 0, pageErrors);
  await b.close();
})().catch(e => { console.log('FAIL', e.stack || e.message); process.exit(1); });
