// @ci integration suite=farming timeout=900
// Animals on clusters (spec r15-39b, item C4: js/shepherd.js, js/poultry.js, js/cowherd.js, js/pigfarmer.js, js/horses.js, js/stables.js,
// js/bees.js, js/herd.js). test/cluster-isolation.js checks the animal systems in the world as generated; this adds what it doesn't
// meet there: wild horse herds (rolled by the wildlife, which isn't run per cluster yet), one near each village and one between two
// villages. Two child processes boot the same world (tools/headless.js: seed 3 at the village nearest the spawn, 3 more villages
// simulated), place the same herds, and run with the cluster tick on, one in the tick order and one in the cluster order (js/ctick.js);
// after each interval the state hash's parts must match. The herds must move, and every horse record and herd must belong to exactly
// one cluster group at every meeting. A third child runs the same world with the cluster tick off: its herds must end where the cluster
// tick's do (a herd moved by more than one group, or by none, drifts at another speed).
// Usage: node test/cluster-animals.js [--seed 3] [--seconds 40]
const { fork } = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SYSTEMS = ['mobloop', 'shepherd', 'horses', 'stables', 'poultry', 'cowherd', 'pigFarmer', 'bees'];

if (process.argv[2] === '--child') child();
else parent();

function child() {
  const order = process.argv[3], seed = +arg('seed', 3);
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 50) errors.push(e.k + ': ' + e.x); });
  BF.boot.headless({ seed, settings: { at: 'village', extra: 3 } });
  const W = BF.world, H = BF.horses;
  // a herd on grass near (x, z): the first grass column on a ring round it
  const herdNear = (x, z, r0) => {
    for (let r = r0; r < r0 + 60; r += 4) for (let a = 0; a < 16; a++) {
      const gx = Math.floor(x + Math.cos(a / 16 * Math.PI * 2) * r), gz = Math.floor(z + Math.sin(a / 16 * Math.PI * 2) * r);
      if (!W.isLoaded(gx, gz) || W.getBlock(gx, W.heightAt(gx, gz), gz) !== BF.B.grass) continue;
      const h = H.spawnHerdAt(gx, gz);
      if (h) return h;
    }
    return null;
  };
  const vs = [...BF.mobs.villages.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const v of vs) herdNear(v.x, v.z, 40);
  if (vs.length > 1) herdNear((vs[0].x + vs[1].x) / 2, (vs[0].z + vs[1].z) / 2, 0);
  const C = BF.ctick;
  const off = order === 'off';
  if (!off) { C.only = SYSTEMS; C.order = order; C.on = true; }
  const herdText = () => [...H.herds.values()].map(h => h.id + '@' + h.cx.toFixed(2) + ',' + h.cz.toFixed(2)).sort().join(' ');
  const centres = () => [...H.herds.values()].sort((a, b) => a.id - b.id).map(h => [h.cx, h.cz]);
  const herds0 = herdText();
  // each record and herd in exactly one group (js/horses.js recGroup and herd ownership, as the multi-worker runtime asks: by table)
  const owners = () => {
    if (off) return {};
    const keys = C.groups().map(g => g.key), n = {};
    for (const name of ['horses.records', 'horses.herds']) {
      const t = C.table(name);
      n[name] = t ? keys.reduce((s, k) => { const p = t.snap(k, true); return s + (Array.isArray(p) ? p.length : p.keys.length); }, 0) : -1;   // (records: {keys, put})
    }
    return n;
  };
  process.on('message', msg => {
    if (msg.do === 'interval') {
      BF.boot.stream();
      if (off) for (let t = 0; t < C.MEET; t++) BF.simStep(BF.warp.TICK); else C.interval(BF.warp.TICK);
      process.send({ parts: BF.stateHash.parts(), herds: H.herds.size, recs: H.records.size, owners: owners(), errors: errors.splice(0) });
    } else if (msg.do === 'end') process.send({ herds0, herds1: herdText(), centres: centres() }, () => process.exit(0));
  });
  process.send({ ready: true, herds: H.herds.size, recs: H.records.size });
}

async function parent() {
  const seconds = +arg('seconds', 40);
  let fails = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
  const t0 = Date.now();
  const kids = ['tick', 'cluster', 'off'].map(o => fork(__filename, ['--child', o, '--seed', arg('seed', 3)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  const waits = kids.map(k => { const q = []; let res = null; k.on('message', m => { if (res) { const r = res; res = null; r(m); } else q.push(m); }); return () => q.length ? Promise.resolve(q.shift()) : new Promise(r => { res = r; }); });
  const ask = (i, msg) => { kids[i].send(msg); return waits[i](); };
  const ready = await Promise.all(kids.map((k, i) => waits[i]()));
  console.log(`booted 2 worlds in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${ready[0].herds} herds, ${ready[0].recs} horse records`);
  check(ready[0].herds >= 3, `herds placed (${ready[0].herds})`);
  let first = 0, owned = true;
  for (let n = 1; n <= seconds; n++) {
    const r = await Promise.all(kids.map((k, i) => ask(i, { do: 'interval' })));
    for (const x of r) for (const e of x.errors) console.log(`  game log ERROR: ${e}`);
    for (const x of r.slice(0, 2)) if (x.owners['horses.records'] !== x.recs || x.owners['horses.herds'] !== x.herds) {
      if (owned) console.log(`  second ${n}: ${x.owners['horses.records']} of ${x.recs} records and ${x.owners['horses.herds']} of ${x.herds} herds in a group`);
      owned = false;
    }
    const parts = Object.keys(r[0].parts).filter(k => r[0].parts[k] !== r[1].parts[k]);
    if (parts.length && !first) { first = n; console.log(`second ${n}: the cluster order differs in ${parts.join(', ')}`); }
  }
  const end = await Promise.all(kids.map((k, i) => ask(i, { do: 'end' })));
  check(end[0].herds0 !== end[0].herds1, 'the herds moved');
  const a = end[0].centres, b = end[2].centres, far = a.length === b.length ? Math.max(0, ...a.map((c, i) => Math.hypot(c[0] - b[i][0], c[1] - b[i][1]))) : Infinity;
  check(far < 0.5, `the herds ended where they do with the cluster tick off (at most ${far.toFixed(2)} blocks apart)`);
  check(owned, 'every horse record and herd belonged to exactly one cluster group');
  check(!first, `the tick and cluster orders give the same world for ${seconds} s` + (first ? ` (differ from second ${first})` : ''));
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(fails ? `FAIL cluster-animals (${fails})` : 'PASS cluster-animals');
  process.exit(fails ? 1 : 0);
}
