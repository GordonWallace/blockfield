// @ci baseline suite=world
// Trees, bushes and the rest across the planet's face edges (spec r14-11), plain node, no browser: node test/planet-trees.js
// Runs tools/planet-trees.js on two seeds: edge chunks along all 24 sides and their twins seen through the neighbouring face agree on
// every tree block (a tree that straddles an edge is decided by the face that owns its cell and drawn whole on both sides), and
// BF.planetgen.treesIn lists the trees chunk generation grows.
const { run } = require("../tools/planet-trees.js");
let fails = 0;
run([1337, 42], (c, m) => { console.log((c ? "ok " : "FAIL ") + m); if (!c) fails++; return c; }, console.log);
console.log(fails ? "FAIL planet-trees (" + fails + ")" : "PASS planet-trees");
process.exit(fails ? 1 : 0);
