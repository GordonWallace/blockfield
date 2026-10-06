// Timing / band statistics for generator 3 against generator 2 (node tools/gen3-perf.js [seed] [scale] [N=40]).
// Generates an N x N chunk area at the plains spot and at the mountain spot (found by search) with gen 3 generateBand, and the same
// area size with gen 2 generate() at the origin; prints ms per chunk, band section-count histograms and memory per chunk.
const m = require("./gen3-check.js");
const seed = +(process.argv[2] || 1337), scale = +(process.argv[3] || 2), N = +(process.argv[4] || 40);
function setup(gen) {
  const BF = m.env(m.cur); BF.noise = BF.makeNoise(seed); BF.worldgen.init(BF.noise, { gen, biomeScale: scale }); return BF;
}
// find spots with gen 3: flat high plains area, mountain area
let BF = setup(3), W = BF.worldgen;
let plains = null, mtn = null, bestM = 0;
for (let z = -24000; z <= 24000; z += 500) for (let x = -24000; x <= 24000; x += 500) {
  const h = W.heightAt(x, z);
  if (!plains && h >= 1000 && h < 1300 && Math.abs(W.heightAt(x + 400, z) - h) < 12 && Math.abs(W.heightAt(x, z + 400) - h) < 12 && Math.abs(W.heightAt(x + 400, z + 400) - h) < 12) plains = [x, z];
  let lo = 1e9, hi = -1e9;
  for (let k = 0; k < 4; k++) { const hh = W.heightAt(x + (k & 1) * 600, z + (k >> 1) * 600); lo = Math.min(lo, hh); hi = Math.max(hi, hh); }
  if (hi - lo > bestM && hi > 1400) { bestM = hi - lo; mtn = [x, z]; }
}
console.log("plains area at", plains, "mountain area at", mtn, "relief", bestM);
function bench(name, gen, cx0, cz0) {
  const BF = setup(gen), W = BF.worldgen;
  // warm up (rivers network, lattice caches) on a neighbouring area
  let t0 = process.hrtime.bigint();
  if (gen >= 3) W.generateBand(cx0 - 60, cz0 - 60); else W.generate(cx0 - 60, cz0 - 60, new Uint16Array(16 * 16 * 192));
  const first = Number(process.hrtime.bigint() - t0) / 1e6;
  const hist = {}; let bytes = 0, tot = 0;
  t0 = process.hrtime.bigint();
  for (let cz = cz0; cz < cz0 + N; cz++) for (let cx = cx0; cx < cx0 + N; cx++) {
    if (gen >= 3) { const b = W.generateBand(cx, cz), n = b.hi - b.lo; hist[n] = (hist[n] || 0) + 1; bytes += b.vox.byteLength; }
    else { const v = new Uint16Array(16 * 16 * 192); W.generate(cx, cz, v); bytes += v.byteLength; }
    tot++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / tot;
  console.log(`${name}: ${ms.toFixed(2)} ms/chunk over ${tot} chunks (first chunk incl. river/lattice warm-up ${first.toFixed(0)} ms), vox ${(bytes / tot / 1024).toFixed(1)} KB/chunk` +
    (gen >= 3 ? `, band sections histogram ${JSON.stringify(hist)}` : ""));
  return ms;
}
const g2 = bench("gen 2 generate (origin area)", 2, 0, 0);
const p = bench("gen 3 generateBand plains", 3, plains[0] >> 4, plains[1] >> 4);
const q = bench("gen 3 generateBand mountains", 3, mtn[0] >> 4, mtn[1] >> 4);
const o = bench("gen 3 generateBand origin", 3, 0, 0);
console.log(`ratio gen3/gen2: plains ${(p / g2).toFixed(2)}, mountains ${(q / g2).toFixed(2)}, origin ${(o / g2).toFixed(2)}`);
// deep range cost: 1000 blocks of rock below a plains band
BF = setup(3); W = BF.worldgen;
const pcx = plains[0] >> 4, pcz = plains[1] >> 4, b = W.generateBand(pcx, pcz);
let t0 = process.hrtime.bigint(), n = 0;
for (let k = 0; k < 20; k++) { W.generateRange(pcx + k, pcz, -4, b.lo); n++; }
console.log(`generateRange from the world bottom up to the band (${b.lo + 4} sections): ${(Number(process.hrtime.bigint() - t0) / 1e6 / n).toFixed(1)} ms/chunk`);
t0 = process.hrtime.bigint(); n = 0;
for (let k = 0; k < 40; k++) { W.generateRange(pcx + k, pcz + 1, b.lo - 3, b.lo); n++; }
console.log(`generateRange of 3 sections just below the band: ${(Number(process.hrtime.bigint() - t0) / 1e6 / n).toFixed(2)} ms/chunk`);
