// @ci integration suite=world soak timeout=900 args={out}
// Villager-seconds soak (spec r15-01): seed 3 (the big village, about 56 villagers), simulation only, 2 game days of 0.05 s steps with
// the perf meter on (tools/perf/lib.js, js/perf.js). Prints V·s/s, mob-s/s, ms per step and the split by subsystem for each day, and
// writes them to <dir of out>/perf.json (ci-out/perf.json in CI). Report-only: it fails only on errors (page errors, no villagers,
// a meter that measured nothing), never on a number, because shared runners are too noisy to gate on.
// NODE_PATH=$(npm root -g) node test/perf-soak.js [outPrefix=ci-out/perf-soak]
const path = require('path'), fs = require('fs');
const H = require('../tools/perf/lib');
const out = process.argv[2] || 'ci-out/perf-soak';
const SEED = 3, HOURS = 48;

(async () => {
  const fails = [];
  const { b, pg } = await H.boot(path.join(__dirname, '..'), { seed: SEED });
  const where = await H.toVillage(pg);
  const hours = [];
  for (let hr = 0; hr < HOURS; hr++) {
    const r = await H.run(pg, 1000);   // a game hour
    hours.push(r);
    if (hr % 6 === 5) console.log(`h${hr + 1} day ${r.day.toFixed(2)}: ${Math.round(r.vss)} V·s/s, ${r.msPerStep.toFixed(2)} ms/step, ${r.counts.villager} villagers, ${r.counts.total} mobs`);
  }
  const days = [H.average(hours.slice(0, 24)), H.average(hours.slice(24))];
  days.forEach((d, i) => console.log(`day ${i + 1}: ${Math.round(d.vss)} V·s/s  ${Math.round(d.mobss)} mob-s/s  ${d.msPerStep.toFixed(2)} ms/step  ${(d.game / d.real).toFixed(1)}x sim-only  ` +
    `villagers ${d.counts.villager.toFixed(0)}, mobs ${d.counts.total.toFixed(0)}\n   split (ms/step): ${H.fmtSplit(d.split)}`));
  const res = { seed: SEED, where, at: new Date().toISOString(), commit: process.env.GITHUB_SHA || null,
    vss: days[1].vss, mobss: days[1].mobss, msPerStep: days[1].msPerStep, split: days[1].split, counts: days[1].counts, days, hours };
  const file = path.join(path.dirname(path.resolve(out)), 'perf.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(res, null, 1));
  console.log('wrote ' + file);
  if (!(days[1].counts.villager >= 10)) fails.push(`only ${days[1].counts.villager.toFixed(0)} villagers loaded on day 2`);
  if (!hours.every(h => h.steps === 1000 && h.vss > 0 && isFinite(h.msPerStep))) fails.push('the meter measured nothing in some hours');
  await b.close();
  if (fails.length) fails.forEach(f => console.log('FAIL ' + f));
  else console.log(`PASS perf-soak: ${Math.round(res.vss)} V·s/s, ${res.msPerStep.toFixed(2)} ms/step (day 2)`);
})().catch(e => { console.error(e); console.log('FAIL ' + e.message); process.exit(1); });
