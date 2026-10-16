// @ci baseline suite=world
// The planet's rivers and lakes (spec r14-10), plain node, no browser: node test/planet-rivers.js
// Runs tools/planet-rivers.js (blockfield-round's river-check, ported) on two seeds. The whole-planet network: no loops, no uphill steps,
// no crossing rivers. The terrain, read through worldgen's climate (what chunks are built from), along the 40 rivers with the longest way
// to the sea: the water never rises going downstream, the centre line always holds water, no water stands against air across a river,
// and along the edges of every lake above sea level the water never stands against air either (a few such columns are allowed: a gap
// in a lake's banks that runs on lower than its rim is raised, see worldgen climate3).
const { check } = require("../tools/planet-rivers.js");
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL " + msg); } else console.log("ok " + msg); return c; };
for (const seed of [1337, 42]) {
  const r = check(seed, 40, false, 8);
  console.log(`seed ${seed}: ${r.links} river links, ${r.lakes} lakes, solved in ${r.solveMs} ms; walked ${r.walked} rivers (${r.cols} columns, ${r.sections} cross-sections) in ${r.walkMs} ms; ${r.lakesChecked} lakes' edges (${r.lakeEdges} columns) in ${r.lakeMs} ms`);
  ok(r.links > 3000 && r.lakes > 100, `seed ${seed}: the network has rivers and lakes (${r.links} links, ${r.lakes} lakes)`);
  ok(!r.loops && !r.uphill && !r.crossings, `seed ${seed}: network: ${r.loops} loops, ${r.uphill} uphill steps, ${r.crossings} crossings`);
  ok(!r.rises && !r.dry && !r.spills, `seed ${seed}: rivers: ${r.rises} rises (worst ${r.worst}), ${r.dry} dry centre-line columns, ${r.spills} spills`);
  ok(r.lakeSpills <= r.lakeEdges * 0.0005, `seed ${seed}: lakes: ${r.lakeSpills} spills along ${r.lakeEdges} edge columns`);
}
console.log(fails ? "FAIL planet-rivers (" + fails + ")" : "PASS planet-rivers");
process.exit(fails ? 1 : 0);
