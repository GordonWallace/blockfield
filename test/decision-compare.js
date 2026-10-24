// @ci integration suite=village soak timeout=1200 hosts=worker,server
// Decision comparison soak (spec r15-07): the villager decision speed-ups (explorers' map columns, foresters' log bases, the village bed scan,
// breeding encounters, miners fending off mobs; caches keyed by chunk.ver, js/world.js) must decide exactly what the old scans did.
// With BF.debug.decisionCompare on, every cached answer is also worked out the old way (js/decisioncompare.js). One game day in the
// village nearest the spawn (seed 3: a big village with explorers, foresters and miners), stepped with no rendering like test/bakechain.js,
// then: no difference at all, each comparison ran, the comparison mode was logged, no page errors.
// Usage: NODE_PATH=$(npm root -g) node test/decision-compare.js [days=1] [seed=3]   (BF_HOST=page|worker|server: where the simulation runs,
// spec r15-43; the steps and the comparisons run there)
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 1), SEED = +(process.argv[3] || 3);
const lib = require('./lib');
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
  await lib.install(pg);
  const srv = lib.host() === 'page' ? null : await lib.serve({ world: lib.host() === 'server' });
  await pg.goto(srv ? srv.url + '?nolod&' + lib.q() + '#seed' + SEED : 'file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await lib.ready(pg);
  if (srv) { await lib.simReady(pg); await lib.sim(pg, () => { BF.debug.decisionCompare = true; }); }   // (the init script's switch is the page's)
  await pg.waitForTimeout(3000);
  // the page's player hovers above the village nearest the spawn; the simulation's follows it, then both stop (the steps below run it)
  const vv = await lib.sim(pg, () => {   // (the player's position as the simulation has it: the page's may not have its spawn yet)
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    return { x: v.x, y: v.y, z: v.z };
  });
  const where = await pg.evaluate(v => {
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const y = (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3;
    BF.player.spawn(v.x + 0.5, y, v.z + 0.5);
    BF.player.position.y = y + 40;   // hover above, so the player never lands inside terrain
    if (BF.player.setFlying) BF.player.setFlying(true);
    return { x: v.x, z: v.z };
  }, vv);
  for (let i = 0; i < 60 && !(await lib.sim(pg, a => Math.hypot(BF.player.position.x - a.x, BF.player.position.z - a.z) < 20, where)); i++) await pg.waitForTimeout(500);
  await pg.evaluate(() => { window.__halt = true; });
  await lib.sim(pg, () => { BF.state.paused = true; });   // (where the simulation is not the page's frames: its own ticks stop)
  // load the area and let the village come out, then step the simulation (0.05 s steps, as fast-forward does)
  await lib.sim(pg, ({ x, z }) => {
    globalThis.__step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); if (BF.dayTimeline) BF.dayTimeline.update(); BF.drops.update(h); BF.boats.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(x, z, 60); if (i % 4 === 0) __step(0.05); }
    for (let i = 0; i < 2600; i++) { if (i % 10 === 0) BF.world.update(x, z, 30); __step(0.05); }
  }, where);
  const start = await lib.sim(pg, () => ({ day: BF.sky.day + BF.sky.time, villagers: BF.mobs.list.filter(m => m.type === 'villager' && !m.dead).length,
    profs: [...new Set(BF.mobs.list.filter(m => m.type === 'villager').map(m => m.profession))].sort() }));
  console.log('village', JSON.stringify(where), 'day', start.day.toFixed(2), start.villagers, 'villagers', start.profs.join(' '));
  const HOURS = Math.round(DAYS * 24);
  for (let h = 0; h < HOURS; h++) {
    const r = await lib.sim(pg, ({ x, z }) => {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) { if (i % 20 === 0) BF.world.update(x, z, 3); __step(0.05); }   // one game hour
      return { ms: performance.now() - t0, day: BF.sky.day + BF.sky.time, checks: BF.dcmp.stats.checks, diffs: BF.dcmp.stats.diffs };
    }, where);
    if (h % 4 === 3 || r.diffs) console.log(`h${h} day ${r.day.toFixed(2)} ${(r.ms / 1000).toFixed(2)} ms/step checks ${r.checks} diffs ${r.diffs}`);
  }
  const st = await lib.sim(pg, () => { const L = BF.glog.recent(1e9);   // (the world's entries, or those kept before a saved world opens)
    return { stats: JSON.parse(JSON.stringify(BF.dcmp.stats)), logged: L.filter(e => e.k === 'decision-compare').length, errs: L.filter(e => e.k === 'decision-diff').map(e => e.x).slice(0, 20) }; });
  console.log('comparisons', JSON.stringify(st.stats.byKind));
  ok('no decision differs from the old scans over ' + DAYS + ' game day(s)', st.stats.diffs === 0, st.stats.diffs ? st.stats.first.slice(0, 5) : undefined);
  for (const k of ['map column', 'village beds', 'breeding encounters', 'miner fend', 'forester trees'])
    ok('compared: ' + k, (st.stats.byKind[k] || {}).checks > 0, st.stats.byKind[k]);
  ok('the comparison mode is in the game log, differences as ERROR decision-diff', st.logged >= 1 && st.errs.length === st.stats.first.length, { logged: st.logged, errs: st.errs });
  ok('no page errors', pageErrors === 0, pageErrors);
  await b.close();
  if (srv) await srv.stop();
})().catch(e => { console.log('FAIL', e.stack || e.message); process.exit(1); });
