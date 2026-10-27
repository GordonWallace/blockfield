// @ci integration suite=world timeout=900
// Block ticks at a cluster border (spec r15-39b, item C6: js/world.js clusterCells). Water, crops, cane, saplings, farmland and furnaces
// are set up on both sides of the border between two villages' clusters, and the world runs with the cluster tick on in the tick order
// and in the cluster order (test/cluster-isolation.js has the two orders): the cells, the farmland stamps and the furnaces must come out
// the same, the water must cross the border (at a meeting: a "blockTick" request), and each side's block ticks must have run.
// Two child processes boot the same world headless (seed 3, the 3 nearest other villages simulated too) and run in lockstep.
// Usage: node test/cluster-world.js [--seed 3] [--seconds 40]
const crypto = require('crypto'), { fork } = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const WORLD = ['fluids', 'growth', 'farmland', 'grass', 'saplings', 'catchUp', 'furnaces', 'furnaceClock'];

if (process.argv[2] === '--child') child();
else parent();

function child() {
  const order = process.argv[3], seed = +arg('seed', 3);
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 20) errors.push(e.k + ': ' + e.x); });
  BF.boot.headless({ seed, settings: { at: 'village', extra: 3 } });
  const C = BF.ctick, W = BF.world, B = BF.B, CC = W.clusterCells;
  C.only = WORLD;
  C.order = order;
  C.on = true;
  C.interval(BF.warp.TICK);   // (the first meeting: groups)
  // the border: walking from the first village's centre toward the second's, the first cell whose group changes
  const vs = [...BF.mobs.villages.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  let border = null;
  for (let i = 0; i < vs.length && !border; i++) for (let j = 0; j < vs.length && !border; j++) {
    if (i === j) continue;
    const a = vs[i], b = vs[j], ga = CC.cellGroup(a.x, a.z);
    if (ga === CC.cellGroup(b.x, b.z)) continue;
    const d = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / d, uz = (b.z - a.z) / d;
    for (let s = 0; s < d; s += 1) {
      const x = Math.round(a.x + ux * s), z = Math.round(a.z + uz * s);
      if (CC.cellGroup(x, z) !== ga) { border = { x, z, ga, gb: CC.cellGroup(x, z) }; break; }
    }
  }
  const out = { border: border && { ga: border.ga, gb: border.gb } };
  if (!border) { process.send(out); return; }
  // the cell on the far side next to one on the near side, along x or z
  let near = null, far = null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const g = CC.cellGroup(border.x + dx, border.z + dz);
    if (g === border.ga) { near = [border.x + dx, border.z + dz]; far = [border.x, border.z]; break; }
  }
  if (!near) { out.noPair = true; process.send(out); return; }
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) W.loadAt(border.x + dx * 16, border.z + dz * 16);
  const dir = [far[0] - near[0], far[1] - near[1]];
  // a flat floor across the border, water on the near side and air beyond
  const y = Math.max(W.heightAt(near[0], near[1]), W.heightAt(far[0], far[1])) + 3;
  const at = (k, side) => [near[0] + dir[0] * k * (side || 1), near[1] + dir[1] * k * (side || 1)];
  for (let k = -6; k <= 6; k++) for (let w = -3; w <= 3; w++) {
    const x = near[0] + dir[0] * k + dir[1] * w, z = near[1] + dir[1] * k + dir[0] * w;
    W.setBlock(x, y - 1, z, B.stone);
    for (let h = 0; h < 8; h++) W.setBlock(x, y + h, z, 0);
  }
  W.setBlock(near[0], y, near[1], B.water);   // a source next to the border
  // crops and farmland on either side (6 blocks in: beyond the water's reach of the border cell)
  const fields = [];
  for (const side of [-1, 1]) {
    const [x, z] = side < 0 ? at(5, -1) : [far[0] + dir[0] * 5, far[1] + dir[1] * 5];
    W.setBlock(x, y - 1, z, B.farmland); W.setBlock(x, y, z, B.wheat || B.wheat_0 || 0);
    fields.push([x, y - 1, z]);
    BF.inventory.furnaceRecord(x + dir[1] * 2, y, z + dir[0] * 2);
    const f = BF.inventory.furnaceState(x + dir[1] * 2, y, z + dir[0] * 2);
    const id = n => BF.items.findIndex(it => it && it.name === n);
    f.slots[0] = { id: id('raw_beef'), count: 8 }; f.slots[1] = { id: id('coal'), count: 4 };
  }
  out.fields = fields;
  const md5 = t => crypto.createHash('md5').update(t).digest('hex').slice(0, 16);
  const cells = () => { let t = ''; for (let k = -6; k <= 6; k++) for (let w = -3; w <= 3; w++) for (let h = -1; h < 3; h++) { const x = near[0] + dir[0] * k + dir[1] * w, z = near[1] + dir[1] * k + dir[0] * w; t += W.getBlock(x, y + h, z) + ','; } return t; };
  process.on('message', msg => {
    if (msg.do === 'interval') {
      C.interval(BF.warp.TICK);
      const p = BF.stateHash.parts();
      process.send({ cells: md5(cells()), edits: p.edits, farmland: p.farmland, furnaces: p.furnaces, waited: C.stats().lastDeferred, errors: errors.splice(0),
        farWater: !!BF.FLUID[W.getBlock(far[0], y, far[1])], beyond: !!BF.FLUID[W.getBlock(far[0] + dir[0], y, far[1] + dir[1])],
        stamps: fields.map(f => BF.farmland.stampOf(f[0], f[1], f[2])), cooked: fields.map(f => { const s = BF.inventory.furnaceState(f[0] + dir[1] * 2, f[1] + 1, f[2] + dir[0] * 2); return s && s.slots[2] ? s.slots[2].count : 0; }) });
    } else if (msg.do === 'end') process.send({}, () => process.exit(0));
  });
  process.send(out);
}

async function parent() {
  const seconds = +arg('seconds', 40);
  let fails = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
  const kids = ['tick', 'cluster'].map(o => fork(__filename, ['--child', o, '--seed', arg('seed', 3)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  const waits = kids.map(k => { const q = []; let res = null; k.on('message', m => { if (res) { const r = res; res = null; r(m); } else q.push(m); }); return () => q.length ? Promise.resolve(q.shift()) : new Promise(r => { res = r; }); });
  const ask = (i, msg) => { kids[i].send(msg); return waits[i](); };
  const ready = await Promise.all(kids.map((k, i) => waits[i]()));
  check(ready[0].border && !ready[0].noPair, `a border between two clusters' cells: ${ready[0].border ? ready[0].border.ga + ' | ' + ready[0].border.gb : 'none'}`);
  if (!ready[0].border || ready[0].noPair) { kids.forEach(k => k.kill()); process.exit(1); }
  let same = true, crossedAt = 0, waited = 0, first = null, last = null;
  for (let n = 1; n <= seconds; n++) {
    const r = await Promise.all(kids.map((k, i) => ask(i, { do: 'interval' })));
    for (const x of r) for (const e of x.errors) console.log(`  game log ERROR: ${e}`);
    for (const k of ['cells', 'edits', 'farmland', 'furnaces']) if (r[0][k] !== r[1][k]) { if (same) console.log(`second ${n}: the orders differ in ${k}`); same = false; }
    if (!crossedAt && r[0].farWater && r[1].farWater) crossedAt = n;
    waited += r[0].waited;
    if (!first) first = r[0];
    last = r[0];
  }
  check(same, `the tick and cluster orders give the same border cells, farmland and furnaces for ${seconds} s`);
  check(crossedAt > 0, `the water crossed the border into the other cluster (second ${crossedAt || 'never'})`);
  check(last.beyond, 'and spread on there (the other cluster\'s own fluid tick)');
  check(waited > 0, `block ticks waited for a meeting (${waited} requests)`);
  check(last.stamps.every(s => s != null), `farmland on both sides has stamps (${last.stamps.map(s => s && s.toFixed(3)).join(', ')})`);
  check(last.cooked.every(c => c > 0), `furnaces on both sides cooked (${last.cooked.join(', ')})`);
  await Promise.all(kids.map((k, i) => ask(i, { do: 'end' })));
  console.log(fails ? `FAIL cluster-world (${fails})` : 'PASS cluster-world');
  process.exit(fails ? 1 : 0);
}
