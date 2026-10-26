// @ci integration suite=village soak timeout=2400 args={out}
// Far villages coarse mode against full detail (spec r15-64): seed 3 with the 8 nearest other villages simulated (--extra 8), two game
// days, with --coarse off, with --coarse on, and with --coarse off again on other dice (--reroll 1: how far two runs differ by chance),
// side by side in three processes (tools/perf/activity.js). The bar, per
// villager-second: requests by kind (doors by passages: their requests depend on the tick rate), path searches, trades, items gained and spent by kind, births and deaths (villager deaths and
// golem kills) within 5% of full detail; and the cost of the villages past the view distance before and after.
// Report-only on the 5% for now (spec: enforce once the numbers are stable); it fails when a run fails, when nothing went coarse, or when
// coarse mode did no work at all. Writes both runs and the comparison to <dir of out>/coarse-parity.json (ci-out/ in CI).
// node test/coarse-parity.js [outPrefix=ci-out/coarse-parity] [seconds=2400]
const path = require('path'), fs = require('fs'), { spawn } = require('child_process');
const out = process.argv[2] || 'ci-out/coarse-parity', SECONDS = +(process.argv[3] || 2400), BAR = 0.05;
const dir = path.dirname(path.resolve(out));
fs.mkdirSync(dir, { recursive: true });

const run = (mode, reroll) => new Promise((resolve, reject) => {
  const file = path.join(dir, `coarse-${mode}${reroll ? '-reroll' : ''}.json`);
  const p = spawn(process.execPath, [path.join(__dirname, '../tools/perf/activity.js'), '--seed', '3', '--extra', '8', '--seconds', String(SECONDS), '--coarse', mode, '--reroll', reroll ? '1' : '0', '--out', file], { stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('exit', code => (code === 0 ? resolve(JSON.parse(fs.readFileSync(file, 'utf8'))) : reject(new Error(`--coarse ${mode} exited with ${code}`))));
});

// one row: a count in each run, as a rate per villager-second, how far coarse is from full detail, and how far full detail is from itself
// with other dice (noise: the same world and seed, every villager's stream rolled once after the warm-up)
const rows = [];
const rel = (a, va, b, vb) => { const ra = a / va, rb = b / vb; return ra ? (rb - ra) / ra : (rb ? 1 : 0); };
function row(group, name, get, min) {
  const a = get(R.off), b = get(R.on), n = get(R.noise), diff = rel(a, R.off.v, b, R.on.v), noise = rel(a, R.off.v, n, R.noise.v);
  rows.push({ group, name, full: a, coarse: b, again: n, diff: +diff.toFixed(4), noise: +noise.toFixed(4), judged: a >= min || b >= min, within: Math.abs(diff) <= BAR,
    inNoise: Math.abs(diff) <= Math.max(BAR, 2 * Math.abs(noise)) });
}
const R = {};
const sum = o => Object.values(o || {}).reduce((s, x) => s + x, 0);

(async () => {
  const [off, on, noise] = await Promise.all([run('off'), run('on'), run('off', true)]);
  for (const [k, r] of Object.entries({ off, on, noise })) R[k] = Object.assign(r, { v: r.activity.villagerSeconds, c: r.activity.counts });
  const kinds = new Set([off, on].flatMap(r => Object.keys(r.c.requests.byKind)));
  // door requests depend on the tick rate (a fine walker hovering at the opening distance opens and shuts a door several times), so doors
  // are judged by the passages through them instead
  for (const k of kinds) if (k !== 'door') row('requests', k, r => r.c.requests.byKind[k] || 0, 200);
  row('requests', 'all but doors', r => r.c.requests.sent - (r.c.requests.byKind.door || 0), 200);
  row('requests', 'door (report)', r => r.c.requests.byKind.door || 0, Infinity);
  row('life', 'door passages', r => r.life.doors, 200);
  row('activity', 'paths', r => r.c.paths, 200);
  row('activity', 'trades', r => r.c.trades, 100);
  for (const g of ['gained', 'spent']) for (const k of new Set([off, on].flatMap(r => Object.keys(r.c[g])))) row(g, k, r => r.c[g][k] || 0, 100);
  const deaths = (r, t) => sum(r.life.deaths[t]);
  const kills = (r, by) => Object.values(r.life.deaths).reduce((s, d) => s + Object.entries(d).filter(([c]) => by.test(c)).reduce((x, [, n]) => x + n, 0), 0);
  for (const t of new Set([off, on].flatMap(r => Object.keys(r.life.deaths)))) row('life', 'deaths: ' + t, r => deaths(r, t), 20);
  row('life', 'villager deaths', r => deaths(r, 'villager'), 20);
  row('life', 'golem kills', r => kills(r, /golem/), 20);
  row('life', 'births', r => sum(r.life.births), 20);
  for (const t of new Set([off, on].flatMap(r => Object.keys(r.life.births)))) row('life', 'births: ' + t, r => r.life.births[t] || 0, 20);

  const judged = rows.filter(r => r.judged), outside = judged.filter(r => !r.within), beyond = judged.filter(r => !r.inNoise);
  const cost = { full: { msPerTick: off.msPerTick, villages: off.villages }, coarse: { msPerTick: on.msPerTick, villages: on.villages } };
  console.log(`full detail ${off.msPerTick} ms/tick (${off.villagers} villagers), coarse ${on.msPerTick} ms/tick (${on.villagers} villagers): ${(off.msPerTick / on.msPerTick).toFixed(2)}x`);
  console.log('village ms/tick, full -> coarse: ' + off.villages.map(v => { const w = on.villages.find(x => x.key === v.key); return `${v.name} ${v.ms} -> ${w ? w.ms : '?'}`; }).join(', '));
  console.log(`villager-seconds: full ${off.v}, coarse ${on.v}, full again ${noise.v}`);
  console.log('      group     row                      full  coarse   again   coarse%  again%');
  for (const r of rows) if (r.judged || r.name.includes('(report)') || r.group === 'life')
    console.log(`${r.within ? 'ok  ' : r.inNoise ? '~   ' : 'OFF '} ${r.group.padEnd(9)} ${r.name.padEnd(22)} ${String(r.full).padStart(6)}  ${String(r.coarse).padStart(6)}  ${String(r.again).padStart(6)}  ${(r.diff * 100).toFixed(1).padStart(7)}% ${(r.noise * 100).toFixed(1).padStart(6)}%`);
  console.log(`${judged.length - outside.length} of ${judged.length} judged rows within ${BAR * 100}%, ${judged.length - beyond.length} within max(${BAR * 100}%, twice the noise) (report-only; ~ marks a row within the noise)`);
  fs.writeFileSync(path.join(dir, 'coarse-parity.json'), JSON.stringify({ seconds: SECONDS, bar: BAR, cost, rows, outside: outside.map(r => r.name), beyondNoise: beyond.map(r => r.name) }, null, 1));
  const fails = [];
  if (!(on.byState.total.n < off.byState.total.n)) fails.push('coarse mode ran as many mob updates as full detail: nothing went coarse');
  if (!(on.c.requests.sent > 0.5 * off.c.requests.sent && on.c.paths > 0.5 * off.c.paths)) fails.push('coarse mode did less than half the work');
  if (fails.length) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }
  console.log('PASS');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
