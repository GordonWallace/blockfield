// Summary of perfmobs.js runs: node tools/perf/analyze.js out/*.json -> per run, the averages over game hours FROM..TO (default 24..48,
// day 2): V·s/s, mob-s/s, ms per step, mob counts and the split by subsystem (js/perf.js categories) with each part's share.
// JSON=1 prints the rows as JSON instead.
const fs = require('fs');
const { average } = require('./lib');
const FROM = +(process.env.FROM || 24), TO = +(process.env.TO || 48);
const rows = [];
for (const f of process.argv.slice(2)) {
  let d; try { d = JSON.parse(fs.readFileSync(f)); } catch (e) { console.error(`${f}: ${e.message}`); continue; }
  const hs = (d.hours || []).slice(FROM, TO);
  if (!hs.length || !hs[0].split) { console.error(`${f}: no hours ${FROM}..${TO} with a split (an older perf-mobs file?)`); continue; }
  rows.push({ file: f.split('/').pop().replace('.json', ''), variant: d.variant, seed: d.seed, ...average(hs) });
}
if (process.env.JSON) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) {
  const c = r.counts;
  console.log(`\n${r.file}  ${Math.round(r.vss)} V·s/s  ${Math.round(r.mobss)} mob-s/s  ${r.msPerStep.toFixed(2)} ms/step  sim-only ${(r.game / r.real).toFixed(1)}x  ` +
    `mobs ${c.total.toFixed(0)} (villagers ${c.villager.toFixed(0)}, golems ${c.golem.toFixed(0)}, monsters ${c.hostile.toFixed(0)}, wild ${c.wildAnimal.toFixed(0)}, village animals ${c.villageAnimal.toFixed(0)})`);
  for (const [k, v] of Object.entries(r.split)) console.log(`   ${k.padEnd(18)} ${v.toFixed(3)} ms  ${(100 * v / r.msPerStep).toFixed(1)}%`);
}
