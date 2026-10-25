// @ci integration suite=world,village soak timeout=3000
// Regions over several workers (spec r15-39): the world comes out the same however many workers think. Plain node, no browser.
// Runs seed 3 for one game day headless (tools/headless.js, the player at the village nearest the spawn) with 1, 2 and 4 workers, one
// after another, and with 3 workers that start splitting after 300 game seconds on their own ("3@300", as the split starts mid-run in
// play, js/rplay.js), and checks:
//   - the same world state hash at the end (js/statehash.js), part by part when not;
//   - the same items in the world, every kind counted (tools/headless.js census: mobs' inventories, chests, furnaces, the player, drops),
//     and the same emeralds (the coins): the exchange between workers made nothing twice and lost nothing;
//   - the workers ran split (both had regions to think) and none stopped with an error.
// It prints ms per tick for each, which reports/r15-39.md and the release checklist read (scaling numbers, not checked: a CI runner's
// cores vary).
// Usage: node test/multi-worker.js [seed=3] [seconds=1200] [workers=1,2,4,3@300]
const path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 1200);
const counts = (process.argv[4] || '1,2,4,3@300').split(',').map(x => { const [n, after] = x.split('@').map(Number); return { n, after: after || 0, label: x }; });
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

const run = ({ n, after }) => new Promise(done => {
  const t0 = Date.now();
  cp.execFile(process.execPath, [path.join(root, 'tools', 'headless.js'), '--seed', String(seed), '--seconds', String(seconds - after), '--workers', String(n), '--json'].concat(after ? ['--after', String(after)] : []),
    { cwd: root, maxBuffer: 1 << 28, timeout: 2400 * 1000 }, (e, out, err) => {
      const line = String(out).trim().split('\n').filter(l => l.startsWith('{')).pop();
      if (e || !line) { console.log(`FAIL ${n} worker(s): ${e ? e.message : 'no result'}\n${String(out).slice(-3000)}\n${String(err).slice(-3000)}`); fails++; return done(null); }
      const r = JSON.parse(line);
      r.wall = (Date.now() - t0) / 1000;
      done(r);
    });
});

(async () => {
  const res = [];
  for (const c of counts) {
    const r = await run(c), n = c.label;
    if (!r) continue;
    res.push([n, r]);
    const w = r.workers;
    console.log(`${n} worker(s): ${r.ticks} ticks, ${r.msPerTick} ms/tick (${r.speed}x real time), ${r.villagers} villagers, ${r.mobs} mobs, ` +
      `${r.census.coins} emeralds, hash ${r.hash}${w ? '; think ' + w.stats.ms.think.toFixed(2) + ', exchange ' + w.stats.ms.exchange.toFixed(2) + ', rest ' + w.stats.ms.rest.toFixed(2) + ' ms, ' + w.stats.kbPerTick.toFixed(0) + ' KB a tick' : ''} (${r.wall.toFixed(0)} s)`);
    if (w) {
      check(w.same, `${n} workers: every worker holds the same world at the end (${w.hashes.join(', ')})`);
      check(!w.mismatch, `${n} workers: no worker found itself out of step${w.mismatch ? ' (' + JSON.stringify(w.mismatch) + ')' : ''}`);
      const per = w.stats ? w.stats.workers.map(x => x.mobs) : [];
      check(per.length === c.n && per.every(k => k > 0), `${n} workers: the regions' thinking was split between them (mobs ${per.join('/')})`);
    }
  }
  if (res.length) {
    const [n0, a] = res[0];
    check(a.villagers > 0 && a.ticks > 0, `${n0} worker: villagers simulated (${a.villagers})`);
    for (const [n, b] of res.slice(1)) {
      const parts = Object.keys(a.parts).filter(k => a.parts[k] !== b.parts[k]);
      check(a.hash === b.hash, `${n} workers give the same world state hash as ${n0} (${b.hash}${parts.length ? ', parts that differ: ' + parts.join(', ') : ''})`);
      const kinds = new Set(Object.keys(a.census.items).concat(Object.keys(b.census.items)));
      const diff = [...kinds].filter(k => a.census.items[k] !== b.census.items[k]).map(k => `${k} ${a.census.items[k] || 0} / ${b.census.items[k] || 0}`);
      check(!diff.length, `${n} workers: the same items in the world as ${n0} (${kinds.size} kinds${diff.length ? '; differ: ' + diff.slice(0, 12).join(', ') : ''})`);
      check(a.census.coins === b.census.coins, `${n} workers: the same emeralds as ${n0} (${a.census.coins} / ${b.census.coins})`);
    }
    console.log('scaling: ' + res.map(([n, r]) => `${n} worker(s) ${r.msPerTick} ms/tick`).join(', '));
  }
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('PASS multi-worker');
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
