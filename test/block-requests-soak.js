// @ci integration suite=village,jobs soak timeout=1200
// Direct writes left after spec r15-19 (js/blockreqs.js): seed 3 (the big village), simulation only, one game day of 0.05 s steps
// (tools/perf/lib.js), then BF.req.stats(). Fails when any module r15-19 converted wrote the world directly (outside the apply phase and
// block ticks). js/mobs.js is printed but not checked: its creeper explosions are r15-23's.
// NODE_PATH=$(npm root -g) node test/block-requests-soak.js [hours=24] [seed=3]
const path = require('path');
const H = require('../tools/perf/lib');
const HOURS = +(process.argv[2] || 24), SEED = +(process.argv[3] || 3);
const MINE = ['baker', 'beekeeper', 'tents', 'explorer', 'signs', 'village-names', 'glassmaker', 'toolsmith', 'storage', 'furniture', 'merchant', 'villagesim', 'grass', 'herd', 'poultry', 'stables'];

(async () => {
  const fails = [];
  const { b, pg } = await H.boot(path.join(__dirname, '..'), { seed: SEED });
  await H.toVillage(pg);
  await pg.evaluate(() => BF.req.resetStats());
  for (let hr = 0; hr < HOURS; hr++) {
    const r = await H.run(pg, 1000);   // a game hour
    if (hr % 6 === 5) console.log(`h${hr + 1} day ${r.day.toFixed(2)}: direct ${JSON.stringify(await pg.evaluate(() => BF.req.stats().direct))}`);
  }
  const s = await pg.evaluate(() => BF.req.stats());
  console.log('requests by kind: ' + JSON.stringify(s.byKind));
  console.log('direct writes by module: ' + JSON.stringify(s.direct));
  const left = MINE.filter(m => s.direct[m]);
  if (left.length) fails.push('direct writes from ' + left.map(m => m + ' ' + s.direct[m]).join(', '));
  for (const k of ['door', 'cells']) if (!(s.byKind[k] && s.byKind[k].applied > 0)) fails.push('no "' + k + '" requests applied in a day');
  console.log('mobs.js direct writes (creeper explosions until r15-23): ' + (s.direct.mobs || 0));
  await b.close();
  if (fails.length) { console.log('FAIL ' + fails.join('; ')); process.exit(1); }
  console.log('PASS block-requests-soak');
})();
