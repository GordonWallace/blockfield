// Villages on the planet (spec r14-12), node, no browser. Usage: node tools/planet-villages.js [seeds=1337,42] [regions=1200]
//  - regions: a sample of village regions spread evenly over all six faces; how many the edge rule leaves without a village, and how
//    many of the rest hold one per region with its centre on land, against generator 3's rate over regions spread across ~400 km
//  - footprints: every village found stays on its own face, inside its region, at least EDGE_KEEP from every edge
//  - lookups across an edge: from a point by a face edge with villages on both sides near it, villagesNear finds villages on both faces,
//    as canonical records, and nearestVillage agrees with villagesNear; villageFootprints lists a village's buildings
// Exits non-zero on a failed check. Also used by test/planet-villages.js.
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = path.join(__dirname, "..");
function env(seed, gen) {
  delete global.BF;
  global.window = global; global.THREE = {}; global.document = {};
  for (const f of ["blocks.js", "noise.js", "planet.js", "planetgen.js", "planetrivers.js", "worldgen.js"])
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), { filename: f });
  BF.CS = 16; BF.state = { gen, seed }; BF.noise = BF.makeNoise(seed);
  BF.worldgen.init(BF.noise, { gen, villages: 10 });
  return BF;
}
const REGION = 384;

function run(seeds, nRegions, ok, log) {
  const stats = [];
  for (const seed of seeds) {
    // ---- generator 3: the rate over a square of regions away from the home plateau ----
    let BF = env(seed, 3), W = BF.worldgen;
    const side = Math.round(Math.sqrt(nRegions));
    let g3 = 0, g3land = 0;
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {   // spread over about 400 km, so continents and oceans average out
      const rx = 20 + i * 37, rz = 20 + j * 37;
      if (W.heightAt(rx * REGION, rz * REGION) > BF.SEA) g3land++;
      if (W._villageRegion(rx, rz)) g3++;
    }
    const g3rate = g3 / g3land;

    // ---- the planet ----
    BF = env(seed, 4); W = BF.worldgen;
    const P = BF.planet, N = P.N, RPF = Math.ceil(N / REGION), KEEP = W.EDGE_KEEP;
    let excluded = 0, total = 0, vils = 0, footBad = 0, land = 0;
    const perFace = Math.ceil(side * side / 6), s = Math.round(Math.sqrt(perFace));
    for (let f = 0; f < 6; f++) for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
      // an even lattice over the face's regions, first and last row and column included
      const ru = Math.round(i * (RPF - 1) / (s - 1)), rv = Math.round(j * (RPF - 1) / (s - 1)), rx = f * 1024 + ru;
      total++;
      const c = W._planetRegionCentre(rx, rv);
      if (!c) { excluded++; continue; }
      if (W.heightAt(c[0], c[1]) > BF.SEA) land++;
      const v = W._villageRegion(rx, rv);
      if (!v) continue;
      vils++;
      const g0 = P.grid(v.minX, v.minZ), g1 = P.grid(v.maxX, v.maxZ);
      const inRegion = g0.u >= ru * REGION + 4 && g1.u < (ru + 1) * REGION - 4 && g0.v >= rv * REGION + 4 && g1.v < (rv + 1) * REGION - 4;
      if (g0.f !== f || g1.f !== f || !inRegion || !W.insideFace(v.minX, v.minZ, v.maxX, v.maxZ, KEEP)) {
        footBad++; if (footBad < 4) log(`  seed ${seed}: village at ${v.x},${v.z} (face ${f}, region ${ru},${rv}) leaves its region or comes near an edge`);
      }
    }
    // the exact share of regions the edge rule removes, over a whole face's grid of regions
    let keep = 0;
    for (let r = 0; r < RPF; r++) if (W._planetRegionCentre(r, 200)) keep++;
    const exFrac = 1 - (keep / RPF) ** 2;
    const rate = vils / land;
    log(`seed ${seed}: edge rule leaves ${(100 * exFrac).toFixed(2)}% of regions empty (${excluded} of ${total} sampled); ${vils} villages, ${(100 * rate).toFixed(1)} per 100 land regions (centre on land: ${(100 * land / (total - excluded)).toFixed(0)}%), generator 3 ${(100 * g3rate).toFixed(1)} (${(100 * g3land / (side * side)).toFixed(0)}% land)`);
    ok(exFrac < 0.02, `seed ${seed}: the edge rule excludes under 2% of regions (${(100 * exFrac).toFixed(2)}%)`);
    ok(footBad === 0, `seed ${seed}: all ${vils} sampled villages stay inside their region on their own face, clear of every edge`);
    ok(rate > g3rate * 0.5 && rate < g3rate * 2, `seed ${seed}: villages per land region (${(100 * rate).toFixed(1)}%) are close to generator 3's (${(100 * g3rate).toFixed(1)}%)`);

    // ---- lookups across an edge ----
    // walk along face 4's edges (and face 0's, whose edges turn) for a point within 900 blocks of the edge with villages on both faces
    // within 1,200 blocks of it
    let edgeCase = null;
    search: for (const f of [4, 0]) for (let s4 = 0; s4 < 4; s4++) for (let k = 2; k < 60; k++) {
      const along = Math.round(N * k / 62), h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s4];
      const u = h[0] ? (h[0] < 0 ? 300 : N - 300) : along, v = h[1] ? (h[1] < 0 ? 300 : N - 300) : along;
      const a = P.atlas(f, u, v), near = W.villagesNear(a.x, a.z, 1200);
      const faces = new Set(near.map(q => P.face(q.x, q.z)));
      if (faces.size >= 2) { edgeCase = { f, a, near, faces }; break search; }
    }
    if (ok(!!edgeCase, `seed ${seed}: a point by a face edge with villages on both sides within 1,200 blocks exists`)) {
      const { f, a, near, faces } = edgeCase;
      log(`seed ${seed}: by an edge of face ${f} at ${a.x},${a.z}: ${near.length} villages on faces ${[...faces].join(", ")}`);
      ok(near.every(q => { const c = P.canon(q.x, q.z, {}); return !c.off && c.x === q.x && c.z === q.z; }), `seed ${seed}: villagesNear returns canonical records`);
      ok(near.every(q => P.distance(a, q) <= 1200), `seed ${seed}: every village villagesNear returns is within the radius by planet distance`);
      const n = W.nearestVillage(a.x, a.z), best = near.reduce((m, q) => (!m || P.distance(a, q) < P.distance(a, m) ? q : m), null);
      ok(!best || P.distance(a, best) > REGION * 1.5 || n === best, `seed ${seed}: nearestVillage by the edge is the nearest of villagesNear`);
      // the same lookup from a margin address (the point seen past the edge from the other face) finds the same villages
      const other = near.find(q => P.face(q.x, q.z) !== f);
      const m = P.rel(other, a, {});
      const near2 = W.villagesNear(m.x, m.z, 1200);
      ok(near.every(q => near2.includes(q)) && near2.length === near.length, `seed ${seed}: villagesNear from the same point as a margin address of face ${P.face(other.x, other.z)} finds the same ${near.length} villages`);
      for (const q of near) ok(W.villageAt(q.x, q.z) === q, `seed ${seed}: villageAt finds the village at its own centre ${q.x},${q.z}`);
      // footprints for distant house stand-ins (r14-07): the same buildings as the cached layout, nothing from outside the area
      const q = near[0], g = P.grid(q.x, q.z), fp = W.villageFootprints(g.f, { u0: g.u - 200, v0: g.v - 200, u1: g.u + 200, v1: g.v + 200 });
      const mine = fp.filter(b => b.village === q);
      ok(mine.length === q.buildings.length && fp.every(b => b.h > 0 && b.x0 <= b.x1 && b.z0 <= b.z1), `seed ${seed}: villageFootprints lists the ${q.buildings.length} buildings of the village at ${q.x},${q.z} (${mine.length})`);
    }
    stats.push({ seed, exFrac, rate, g3rate, vils, edgeCase: edgeCase && { x: edgeCase.a.x, z: edgeCase.a.z, faces: [...edgeCase.faces] } });
  }
  return stats;
}

if (require.main === module) {
  const seeds = (process.argv[2] || "1337,42").split(",").map(Number), n = +(process.argv[3] || 1200);
  let fails = 0;
  run(seeds, n, (c, m) => { if (!c) { fails++; console.log("FAIL " + m); } return c; }, m => console.log(m));
  console.log(fails ? `FAIL (${fails})` : "PASS");
  process.exit(fails ? 1 : 0);
}
module.exports = { run, env };
