// @ci integration suite=jobs timeout=1500 hosts=worker,server
// Cached shopping lookups (spec r15-04, js/furnaceuse.js offersFor): the seed's village nearest the spawn runs for N game days (no
// rendering, like test/bakechain.js) with BF.debug.checkOffers on, which answers every offer lookup (the toolsmith's and the furnace
// users' priceOf, findDeal) from the village's offer table and from a full scan of every member's offers, and counts any difference. Checks:
//  - zero differences, over enough lookups to mean something (the toolsmiths price every material each plan);
//  - and reports the time each way: the table's answers should take a fraction of the scan's.
// Usage: NODE_PATH=$(npm root -g) node test/offers-cache.js [days=1] [seed=3]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const sim = require('./lib').sim;   // (where the simulation is, on BF_HOST's host: spec r15-43)
const DAYS = +(process.argv[2] || 1), SEED = +(process.argv[3] || 3);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  let fails = 0;
  const fail = msg => { fails++; console.log('FAIL ' + msg); };
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) console.log('console.error:', m.text().slice(0, 300)); });
  await pg.addInitScript(() => { window.BF_LOD_OFF = true; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.addInitScript(() => { window.BF = window.BF || {}; window.BF.lodOff = true; });   // distant rings off: no 1 fps steps
  await require('./lib').goto(pg, '#seed' + SEED);   // (on BF_HOST's host: spec r15-43)
  await require('./lib').ready(pg);
  await pg.waitForTimeout(3000);
  // the village nearest the spawn; the player hovers above it (creative, flying) so it never lands inside terrain
  const where = await pg.evaluate(() => {
    window.__halt = true;
    const v = BFT.villages(6000)[0];
    return { x: v.x, z: v.z, y: v.y };
  });
  await require('./lib').hold(pg, true);   // (the simulation's own ticks off too: the test steps it)
  await sim(pg, v => {
    const y = (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3;
    BF.player.spawn(v.x + 0.5, y, v.z + 0.5);
    BF.player.position.y = y + 40;
    if (BF.player.setFlying) BF.player.setFlying(true);
  }, where);
  // load the area and let the village come out, then turn the check on
  const setup = await sim(pg, ({ x, z }) => {
    globalThis.__step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); if (BF.dayTimeline) BF.dayTimeline.update(); BF.drops.update(h); BF.boats.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(x, z, 60); if (i % 4 === 0) __step(0.05); }
    for (let i = 0; i < 200; i++) { BF.world.update(x, z, 30); __step(0.05); }
    for (let i = 0; i < 2400; i++) { if (i % 10 === 0) BF.world.update(x, z, 30); __step(0.05); }
    BF.debug.checkOffers = true;
    BF.debug.offerStats = { calls: 0, mismatches: 0, msTable: 0, msScan: 0 };
    const R = BF.vlog.villageAt(x, z), vs = R ? R.members.filter(m => m.type === 'villager' && !m.dead) : [];
    return { key: R && R.key, pop: vs.length, shoppers: vs.filter(m => /^(toolsmith|baker|cowherd|pig_farmer|glassmaker)$/.test(m.profession)).length };
  }, where);
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}, ${setup.shoppers} toolsmiths and furnace users`);
  if (!setup.key || !setup.shoppers) fail('no village with a toolsmith or furnace user came out');
  // N game days, an hour (1000 steps of 0.05 s) per evaluate
  for (let hr = 0; hr < DAYS * 24 && setup.key; hr++) {
    const s = await sim(pg, ({ x, z }) => { for (let i = 0; i < 1000; i++) { if (i % 20 === 0) BF.world.update(x, z, 3); __step(0.05); } return BF.debug.offerStats; }, where);
    if (hr % 6 === 5) console.log(`h${hr + 1}: ${s.calls} lookups, ${s.mismatches} differences, table ${s.msTable.toFixed(0)} ms, scan ${s.msScan.toFixed(0)} ms`);
  }
  const s = await sim(pg, () => BF.debug.offerStats);
  const per = (ms, n) => (n ? (1000 * ms / n).toFixed(1) : '-') + ' us';
  console.log(`${s.calls} lookups: table ${s.msTable.toFixed(0)} ms (${per(s.msTable, s.calls)} each), full scan ${s.msScan.toFixed(0)} ms (${per(s.msScan, s.calls)} each), ${(s.msScan / Math.max(1e-9, s.msTable)).toFixed(1)}x`);
  if (s.mismatches) fail(`${s.mismatches} lookups answered differently from the table and the full scan`);
  if (s.calls < 200) fail(`only ${s.calls} offer lookups in ${DAYS} game day(s): too few to check the table`);
  await pg.done(); await b.close();
  console.log(fails ? `FAILED (${fails})` : 'PASS offers-cache');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
