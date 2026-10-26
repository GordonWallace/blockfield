// @ci integration suite=village timeout=1200
// Far villages the budget simulates (spec r15-34, js/active.js) get their villagers, however far they are. Before, a village record was
// only made for villages within about 366 blocks of the player (js/mobs.js updateVillages) or pinned by a trip, so an extra further out
// had its chunks loaded and simulated with nobody in it; on seed 3 every other village is over 1000 blocks from the spawn village.
// Headless (tools/headless.js load, BF.boot.headless with settings.extra: the n nearest villages simulated, a fixed set so it doesn't
// depend on real time) at the village nearest the spawn, 3 extras, 60 game seconds; checks:
//   - the 3 extras are simulated, each over 366 blocks away;
//   - each has a village record with living villagers;
//   - the game log has an INFO "budget" line for each joining.
// Usage: node test/far-extras.js [seed=3]
const { load } = require('../tools/headless.js');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

const { BF } = load();
const lines = [];
BF.glog.setSink(e => lines.push(e));
const h = BF.boot.headless({ seed, settings: { at: 'village', extra: 3 } });
h.tick(1200);
const p = BF.player.position, ed = BF.villageSim._edgeDist;
const extras = BF.active.extras();
check(extras.length === 3, `3 extra villages simulated (${extras.length})`);
for (const key of extras) {
  const rec = BF.mobs.villages.get(key), d = rec ? ed(rec.wg, p.x, p.z) : NaN, live = rec ? rec.members.filter(m => !m.removed && !m.dead).length : 0;
  check(d > 366, `extra ${key} is ${Math.round(d)} blocks away (beyond the near-village range)`);
  check(live > 0, `extra ${key} has villagers (${live})`);
}
const joins = lines.filter(e => e.l === 'INFO' && e.k === 'budget' && /joins the simulated set/.test(e.x));
check(joins.length >= 3, `an INFO budget line for each joining village (${joins.length})`);
console.log(fails ? `FAIL far-extras (${fails})` : 'PASS far-extras');
process.exit(fails ? 1 : 0);
