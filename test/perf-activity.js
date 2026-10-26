// @ci integration suite=world soak timeout=1200 args={out}
// Activity and cost (spec r15-60): seed 3 with the 8 nearest other villages simulated too (--extra 8, the 9-village load), headless, 600
// game seconds with the meter on (tools/perf/activity.js, js/perf.js). Writes the three tables (cost by mob class and state, activity per
// villager-second, each village's ms per tick and top speed) to <dir of out>/activity.json (ci-out/activity.json in CI).
// Report-only on the numbers, like test/perf-soak.js (shared runners are too noisy to gate on). It fails only when the meter's counts
// don't add up: byState must count every mob update once, the requests by kind must match BF.req.stats(), every village simulated
// with villagers must have a line, and at 0x (no ticks) nothing may be counted.
// node test/perf-activity.js [outPrefix=ci-out/perf-activity]
const path = require('path'), fs = require('fs');
const { measure } = require('../tools/perf/activity.js');
const out = process.argv[2] || 'ci-out/perf-activity';
const SEED = 3, EXTRA = 8, SECONDS = 600;

try {
  const fails = [], check = (ok, what) => { if (!ok) fails.push(what); };
  const r = measure({ seed: SEED, seconds: SECONDS, extra: EXTRA });
  const BF = globalThis.BF, P = BF.perf;
  // the counts add up
  check(r.byState.total.n === r.check.updates, `byState counts ${r.byState.total.n} updates, the mob loop ran ${r.check.updates}`);
  let sum = 0;
  for (const c of P.CLASSES) for (const s of P.STATES) sum += r.byState[c][s].n;
  check(sum === r.byState.total.n, `byState's cells add up to ${sum}, not its total ${r.byState.total.n}`);
  const A = r.activity.counts.requests, Q = r.check.requests;
  for (const k of ['sent', 'applied', 'refused']) check(A[k] === Q[k], `activity counts ${A[k]} requests ${k}, BF.req.stats() ${Q[k]}`);
  check(JSON.stringify(A.byKind) === JSON.stringify(Object.fromEntries(Object.keys(Q.byKind).sort().map(k => [k, Q.byKind[k]]))),
    `requests by kind ${JSON.stringify(A.byKind)} vs BF.req.stats() ${JSON.stringify(Q.byKind)}`);
  check(r.villagers >= 100, `only ${r.villagers} villagers loaded with --extra ${EXTRA}`);
  check(r.villages.length >= 5, `only ${r.villages.length} villages measured`);
  check(r.villages.every(v => v.villagers > 0 && v.ms > 0 && v.max > 0), 'a village line with no villagers or no cost');
  check(r.byState.villager.idle.n > 0 && r.byState.villager.route.n > 0, 'no idle or no walking villagers counted');
  // at 0x nothing is counted: the meter on, no ticks
  P.ask(true); P.reset();
  for (let i = 0; i < 5; i++) P.frame();
  const z = P.byState(), za = P.activity();
  check(z.total.n === 0 && za.villagerSeconds === 0 && za.steps === 0 && P.villageSpeed().length === 0, 'something counted with no ticks (0x)');
  P.ask(false);

  const file = path.join(path.dirname(path.resolve(out)), 'activity.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.assign({ at: new Date().toISOString(), commit: process.env.GITHUB_SHA || null }, r), null, 1));
  const v = r.byState.villager, pv = r.activity.perVillagerSecond, b = r.villages[0];
  console.log(`${r.villagers} villagers, ${r.mobs} mobs, ${r.villages.length} villages: ${r.msPerTick} ms/tick, ${r.speed}x sim-only, ${r.vss} V·s/s`);
  console.log(`villager µs/update: ${P.STATES.map(s => s + ' ' + v[s].us).join(', ')}`);
  console.log(`per villager-second: ${pv.requests} requests, ${pv.paths} path searches, ${pv.trades} trades (${pv.events} events)`);
  console.log(`busiest village: ${b.name} ${b.ms} ms/tick, max ${b.max}x; quietest ${r.villages[r.villages.length - 1].ms} ms/tick`);
  console.log('wrote ' + file);
  if (fails.length) { fails.forEach(f => console.log('FAIL ' + f)); process.exit(1); }
  console.log(`PASS perf-activity: busiest village ${b.ms} ms/tick (max ${b.max}x), ${pv.events} events per villager-second`);
  process.exit(0);
} catch (e) { console.error(e); console.log('FAIL ' + e.message); process.exit(1); }
