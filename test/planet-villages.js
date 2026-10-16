// @ci integration suite=village,world
// Villages on the planet (spec r14-12), plain node, no browser: node test/planet-villages.js
// Runs tools/planet-villages.js on two seeds: the edge rule leaves under 2% of village regions empty; sampled villages stay inside their
// region on their own face, clear of every edge; villages per land region are close to generator 3's; from a point by a face edge,
// villagesNear finds villages on both faces (canonical records, within the radius by planet distance, the same set when asked from
// the point's margin address on the other face) and nearestVillage agrees.
const { run } = require("../tools/planet-villages.js");
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL " + msg); } return c; };
run([1337, 42], 400, ok, m => console.log(m));
console.log(fails ? "FAIL planet-villages (" + fails + ")" : "PASS planet-villages");
process.exit(fails ? 1 : 0);
