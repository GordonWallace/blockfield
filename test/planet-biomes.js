// @ci baseline suite=world
// The planet's climate bands and biomes (spec r14-09), plain node, no browser: node test/planet-biomes.js
// On two seeds (tools/planet-map.js survey: shares sampled evenly over the sphere with the full generator, plus a search for each biome):
//  - every biome Blockfield 1.3 has (ids 0 to 28) occurs, River (4) included since the planet has rivers (r14-10), and so does Frozen
//    Ocean (29)
//  - each village biome (Plains, Savanna, Desert, Snowy Plains, Taiga, Meadow) covers at least 1% of land
//  - the bands guide the biomes: the arctic's land is snowy country, the tropics have no snowy lowlands, the temperate band is mostly
//    plains and forests
const { survey } = require("../tools/planet-map.js");
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL " + msg); } else console.log("ok " + msg); return c; };
const LATER = [];   // biomes the planet doesn't have yet (none since r14-10 brought River)
const VILLAGE = [5, 14, 12, 19, 17, 22];
for (const seed of [1337, 42]) {
  const t0 = Date.now(), s = survey(seed), NM = s.names;
  console.log(`seed ${seed}: land ${(100 * s.land).toFixed(1)}%, survey ${Date.now() - t0} ms`);
  const missing = NM.map((n, i) => (s.found[i] || LATER.includes(i) ? null : `${i} ${n}`)).filter(Boolean);
  ok(NM.length === 30 && !missing.length, `seed ${seed}: every biome occurs (missing: ${missing.join(", ") || "none"})`);
  for (const id of VILLAGE) ok((s.share[id] || 0) >= 0.01, `seed ${seed}: village biome ${NM[id]} covers ${(100 * (s.share[id] || 0)).toFixed(1)}% of land`);
  const inBand = (b, ids) => { const e = s.byBand[b], tot = Object.values(e).reduce((p, q) => p + q, 0); return ids.reduce((p, id) => p + (e[id] || 0), 0) / tot; };
  ok(inBand(0, [2, 19, 20, 21, 25, 26]) > 0.85, `seed ${seed}: arctic land is snowy (${(100 * inBand(0, [2, 19, 20, 21, 25, 26])).toFixed(0)}%)`);
  ok(inBand(4, [2, 19, 20, 21]) < 0.01, `seed ${seed}: no snowy lowlands in the tropics`);
  ok(inBand(2, [5, 6, 7, 8, 9, 10, 22, 17]) > 0.7, `seed ${seed}: the temperate band is mostly plains, meadows and forests`);
}
console.log(fails ? "FAIL planet-biomes (" + fails + ")" : "PASS planet-biomes");
process.exit(fails ? 1 : 0);
