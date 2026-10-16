// @ci baseline suite=world
// Generator 4's terrain on the sphere (spec r14-08), plain node, no browser: node test/planet-terrain.js
// Runs tools/planet-seams.js on two seeds (heights and slow fields across all 24 edge sides, read the same through either face;
// generateBand / generateRange / heightAt / waterLevelAt agree at spawn, mountains, coasts and edge chunks; corners in open sea, gulfs
// when the continents are left unturned) and checks the planet's statistics against generator 3's character: about a third land,
// plateaus around 900 to 1,400 and peaks past 2,000.
const { run } = require("../tools/planet-seams.js");
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL " + msg); } return c; };
const stats = run([1337, 42], ok, m => console.log(m));
for (const s of stats) {
  ok(s.land > 0.27 && s.land < 0.38, `seed ${s.seed}: land is about a third of the planet (${(100 * s.land).toFixed(1)}%)`);
  ok(s.bands[3] > 0.15 && s.bands[2] > 0.12, `seed ${s.seed}: high plains (500 to 1,400) are common, as in generator 3`);
  ok(s.bands[5] > 0.003 && s.maxH > 2000 && s.maxH < 2750, `seed ${s.seed}: massifs reach past 2,000 under the soft ceiling (highest ${s.maxH})`);
  ok(s.plateau > 0.15, `seed ${s.seed}: flat high plains (${(100 * s.plateau).toFixed(1)}% of land)`);
}
console.log(fails ? "FAIL planet-terrain (" + fails + ")" : "PASS planet-terrain");
process.exit(fails ? 1 : 0);
