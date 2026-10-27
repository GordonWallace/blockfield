// @ci baseline suite=village,jobs,farming timeout=900
// Order-independent think (spec r15-71): a mob's thinking reads the other mobs as they stood at the start of the tick, and a keeper's
// change to an animal (feeding, milking, shearing) waits for the end of the mob loop (js/mobs.js later), so the world comes out the same
// whatever order the mobs think in. Headless, seed 9 (its village of about 77 villagers, keepers and pens: the largest of seeds 1-10):
// three runs of the same seed, one with the usual order (regions in key order, each region's mobs by id) and two with every tick's
// whole mob order shuffled by a seeded random permutation (BF.rtick.plan wrapped). The state hash and its parts are compared every
// 60 game s; any difference is an order dependency, and the test prints the first part and where its text differs.
// Each run is its own Node process (the simulation loads once a process).
// Usage: node test/think-order.js [seed=9] [seconds=300]
const path = require('path'), cp = require('child_process'), fs = require('fs'), os = require('os');
const seed = +(process.argv[2] || 9), seconds = +(process.argv[3] || 300);
const EVERY = 60 * 20;

if (process.argv[4] === '--child') {
  const k = +process.argv[5], dump = process.argv[6];
  const { load } = require(path.join(__dirname, '..', 'tools', 'headless.js'));
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village' } });
  let s = (k * 2654435761) >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  if (k) {
    const plan = BF.rtick.plan;
    BF.rtick.plan = list => {
      const out = plan(list);
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = out[i]; out[i] = out[j]; out[j] = t; }
      return out;
    };
  }
  const checks = [];
  let deferred = 0;
  const later = BF.mobs.later;
  BF.mobs.later = (m, check, body) => { const r = later(m, check, body); if (BF.rand.thinker && BF.rand.thinker !== m) deferred++; return r; };
  const ticks = seconds * 20;
  for (let i = 1; i <= ticks; i++) {
    h.tick(1);
    if (i % EVERY === 0 || i === ticks) { const H = h.stateHash(); checks.push({ t: i / 20, hash: H.hash, parts: H.parts }); }
  }
  const texts = {};
  for (const p of BF.stateHash.PARTS) texts[p] = BF.stateHash.text(p);
  fs.writeFileSync(dump, JSON.stringify(texts));
  const villagers = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed).length;
  console.log(JSON.stringify({ k, checks, villagers, deferred }));
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'think-order-'));
const run = k => new Promise((res, rej) => {
  const dump = path.join(tmp, 'k' + k + '.json');
  cp.execFile(process.execPath, [__filename, seed, seconds, '--child', k, dump], { maxBuffer: 1 << 26 }, (e, out) => {
    if (e) return rej(e);
    const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
    res(Object.assign(JSON.parse(line), { dump }));
  });
});
(async () => {
  const t0 = Date.now();
  const [a, b, c] = await Promise.all([0, 1, 2].map(run));
  let fail = false;
  console.log(`seed ${seed}, ${seconds} game s, ${a.villagers} villagers; keeper changes made after the loop: ${a.deferred} (id order), ${b.deferred}, ${c.deferred} (shuffled)`);
  for (const r of [b, c]) {
    for (let i = 0; i < a.checks.length; i++) {
      const x = a.checks[i], y = r.checks[i];
      if (x.hash === y.hash) continue;
      const parts = Object.keys(x.parts).filter(p => x.parts[p] !== y.parts[p]);
      console.log(`FAIL shuffle ${r.k}: the world differs from id order at ${x.t} game s, in ${parts.join(', ')}`);
      {
        const ta = JSON.parse(fs.readFileSync(a.dump, 'utf8')), tb = JSON.parse(fs.readFileSync(r.dump, 'utf8'));
        const p = parts.find(q => ta[q] !== tb[q]);
        if (p) { const u = ta[p], v = tb[p]; let j = 0; while (j < u.length && u[j] === v[j]) j++; console.log(`  at the end, ${p} from character ${j}: ...${u.slice(Math.max(0, j - 300), j + 150)}\n  shuffled: ...${v.slice(Math.max(0, j - 300), j + 150)}`); }
      }
      fail = true;
      break;
    }
  }
  if (!fail) console.log(`OK: ${a.checks.length} checks, the same world in id order and two shuffled orders (${a.checks[a.checks.length - 1].hash})`);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
