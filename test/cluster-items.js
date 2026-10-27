// @ci baseline suite=world
// Map items made while clusters run (js/blocks.js BF.dynRange, js/ctick.js dyn ranges; spec r15-39b C7), plain node, no browser:
// node test/cluster-items.js
//  - each slot takes ids from its own range, so a group's new map item has the same id whatever order the groups run in and whichever
//    worker runs them
//  - a name another slot made since the meeting isn't seen: each makes its own; the meeting keeps the lowest id under the name
//  - another worker's items are adopted under their ids; one whose id is another item here is refused
//  - with clusters off, items are made from the one counter, as before
const { load } = require('../tools/headless.js');
for (const k of ['log', 'info', 'debug']) console[k] = () => {};
const { BF } = load();
const out = s => process.stdout.write(s + '\n');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; out("FAIL " + msg); } else out("ok   " + msg); };
const D = BF.dynRange, h = D.top;
const range = (i, n) => { let j = 0; const at = jj => h + (jj * n + i) * 4; return { i, next: at(0), lim: at(0) + 4, more: () => { j++; return [at(j), at(j) + 4]; } }; };
// one order: slot 0, then slot 1
const run = order => {
  const got = {}, rs = [range(0, 2), range(1, 2)];
  for (const i of order) {
    D.set(rs[i]);
    got[i] = [BF.resolveItem("filled_map_1_901_" + i), BF.resolveItem("filled_map_1_900_0"), BF.resolveItem("filled_map_1_900_0")];
  }
  D.set(null);
  return got;
};
const a = run([0, 1]);
ok(a[0][1] === a[0][2] && a[1][1] === a[1][2], "a slot sees its own new item again");
ok(a[0][1] !== a[1][1], "two slots making one name each make their own");
ok(a[0][0] === h && a[1][0] === h + 4, `each slot's ids come from its range (${a[0][0] - h}, ${a[1][0] - h})`);
D.settle();
ok(BF.resolveItem("filled_map_1_900_0") === Math.min(a[0][1], a[1][1]), "the meeting keeps the lowest id under the name");
ok(D.fresh().length === 0, "nothing is fresh after the meeting");
ok(D.adopt("filled_map_1_901_0", a[0][0]) && !D.adopt("filled_map_1_901_7", a[0][0]), "adopting: the same item is fine, another item under its id is refused");
const before = D.top, id = BF.resolveItem("filled_map_2_3_4");
ok(id === before && D.top === before + 1, "clusters off: the one counter");
out(fails ? "FAIL cluster-items (" + fails + ")" : "PASS cluster-items");
process.exit(fails ? 1 : 0);
