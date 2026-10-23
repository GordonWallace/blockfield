// Simulation-only soak with the split by subsystem (moved here from the 2026-10-19 mob performance study, reports/perf-mobs.md;
// spec r15-01). Usage:
//   NODE_PATH=$(npm root -g) node tools/perf/perfmobs.js [repoDir=.] [variant=all] [hours=36] [seed=1] [out.json]
// variant: all | nohostile | noanimals | nowild (both) | noanim (all mobs, no animation) | nowild_noanim
// Headless, nothing drawn: a creative player hovers over the village nearest spawn and the harness steps the simulation in 0.05 s steps
// (the step 100x and 1000x use) for the given game hours, streaming every 20 steps. Per game hour it records the villager-seconds
// meter's figures (js/perf.js): V·s/s, mob-s/s, ms per step and the split by subsystem, plus mob counts. PROFILE=<hour> also writes a
// CPU profile of that hour to <out>.cpuprofile (read it with profsum.js).
const path = require('path'), fs = require('fs');
const H = require('./lib');
const [repo = '.', variant = 'all', HOURS = '36', SEED = '1', OUT] = process.argv.slice(2);
if (!H.VARIANTS.includes(variant)) { console.error('variant must be one of ' + H.VARIANTS.join(', ')); process.exit(2); }

(async () => {
  const { b, pg } = await H.boot(repo, { seed: +SEED, variant });
  const where = await H.toVillage(pg);
  const start = await pg.evaluate(() => BF.sky.day + BF.sky.time);
  console.log(`${variant} seed ${SEED}: village at ${where.x}, ${where.z}, start day ${start.toFixed(3)}`);
  const hours = [];
  const cdp = process.env.PROFILE ? await pg.context().newCDPSession(pg) : null;
  for (let hr = 0; hr < +HOURS; hr++) {
    const prof = cdp && hr === +process.env.PROFILE;
    if (prof) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    const r = await H.run(pg, 1000);   // 1 game hour = 50 game s at 1200 s days = 1000 steps of 0.05
    if (prof) { const { profile } = await cdp.send('Profiler.stop'); fs.writeFileSync((OUT || 'prof') + '.cpuprofile', JSON.stringify(profile)); }
    hours.push(r);
    const c = r.counts;
    console.log(`h${hr} day ${r.day.toFixed(2)} ${Math.round(r.vss)} V·s/s ${r.msPerStep.toFixed(2)} ms/step (${r.speed.toFixed(1)}x sim-only) mobs ${c.total} v${c.villager} g${c.golem} H${c.hostile} wa${c.wildAnimal} va${c.villageAnimal} queue ${r.queue} chunks ${r.chunks} | ${H.fmtSplit(r.split)}`);
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ variant, seed: +SEED, repo: path.resolve(repo), where, start, hours }, null, 1));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
