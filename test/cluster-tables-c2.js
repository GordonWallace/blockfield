// @ci integration suite=world timeout=900
// The tables C2 (spec r15-39b: mobs core and wild) registers with BF.ctick.owned, which the multi-worker runtime (js/cworkers.js) sends at
// meetings, a group's part from the worker that ran it to the others: monster spawn tries owed per base, villager-update counts, arrows
// (js/mobs.js), drops (js/drops.js), boats (js/boats.js), the wildlife tables (js/wildlife.js) and the mob snapshots (js/mobsave.js).
// Headless, seed 3 at the village nearest the spawn with 3 more villages, the cluster tick on, a drop, an arrow and a boat put in a far
// cluster. After 30 game seconds each table's part of each group goes through JSON and back (snap, apply), as a worker that takes the group
// over would get it: the world's state hash must not change, every part must snap the same again, and the world must run on with the
// same hash as a twin that never did it (the arrow, drop and boat keep going).
// Usage: node test/cluster-tables-c2.js
const crypto = require('crypto');
for (const k of ['log', 'info', 'debug']) console[k] = () => {};
const out = (...a) => require('process').stdout.write(a.join(' ') + '\n');
let fails = 0;
const check = (ok, what) => { out((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const { load } = require('../tools/headless.js');

function world(roundTrip) {
  const { BF } = load({ isolated: true });
  BF.boot.headless({ seed: 3, settings: { at: 'village', extra: 3 } });
  const C = BF.ctick;
  C.on = true;
  const step = () => { BF.boot.stream(); C.interval(BF.warp.TICK); };
  step();
  // something of each kind in the last (far) group: a drop, a skeleton's arrow, a boat
  const gs = C.groups(), far = gs[gs.length - 1];
  const m = BF.mobs.list.find(o => !o.removed && !o.dead && o.type === 'villager' && BF.clusters.groupOf(o.cl) === far.key);
  const p = m.position;
  BF.drops.spawn(BF.I.cobblestone, 3, p.x + 2, p.y + 1, p.z);
  const b = BF.boats.spawn('oak', p.x - 3, p.y, p.z, 0);
  const sk = BF.mobs.spawn('skeleton', p.x + 6, p.y, p.z + 6);
  for (let i = 0; i < 29; i++) step();
  const res = { BF, far: far.key, made: { drop: BF.drops.list.length, boat: !!b, skeleton: !!sk } };
  if (roundTrip) {
    const before = BF.stateHash.full().hash;
    const names = C.tables(), parts = [];
    for (const name of names) for (const g of C.groups()) {
      const t = C.table(name), a = JSON.stringify(t.snap(g.key, true));   // (true: every entry, also of the tables that send only changes)
      t.apply(g.key, JSON.parse(a));
      parts.push([name, g.key, a, JSON.stringify(t.snap(g.key, true))]);
    }
    res.names = names; res.parts = parts;
    res.same = before === BF.stateHash.full().hash;
  }
  for (let i = 0; i < 30; i++) step();
  res.hash = BF.stateHash.full().hash;
  res.counts = { drops: BF.drops.list.length, boats: BF.boats.list.length, mobs: BF.mobs.list.length };
  return res;
}

const a = world(true);
for (const n of ['mobs.spawnAcc', 'mobs.aiBy', 'mobs.arrows', 'drops', 'boats', 'wildlife.rolled', 'wildlife.stored', 'wildlife.nights', 'mobSave.villagers', 'mobSave.golems', 'mobSave.wild', 'mobs.darkStamps'])
  check(a.names.includes(n), `table ${n} is registered`);
check(a.made.drop > 0 && a.made.boat && a.made.skeleton, `a drop, a boat and a skeleton put in the far cluster ${a.far}`);
const nonEmpty = a.parts.filter(p => p[2] !== '[]' && p[2] !== 'null').map(p => p[0]);
check(['drops', 'boats', 'wildlife.rolled', 'mobs.spawnAcc'].every(n => nonEmpty.includes(n)), `the drops, boats, rolled chunks and spawn tries have parts to send (${[...new Set(nonEmpty)].join(', ')})`);
check(a.same, 'sending every part through JSON and back leaves the state hash as it was');
const differ = a.parts.filter(p => p[2] !== p[3]);
check(!differ.length, 'every part snaps the same again' + (differ.length ? ` (not: ${differ.slice(0, 5).map(p => p[0] + ' ' + p[1]).join(', ')})` : ''));
const md5 = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 12);
const b = world(false);
check(a.hash === b.hash, `30 s later it matches a twin that didn't (${md5(a.hash)} / ${md5(b.hash)}; drops ${a.counts.drops}/${b.counts.drops}, boats ${a.counts.boats}/${b.counts.boats}, mobs ${a.counts.mobs}/${b.counts.mobs})`);
out(fails ? `FAIL cluster-tables-c2 (${fails})` : 'PASS cluster-tables-c2');
require('process').exit(fails ? 1 : 0);
