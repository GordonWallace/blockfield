// River artefact check for generator 3 (node tools/river-check.js [seed] [scale] [spots=60]).
// Samples river channels near the spawn region and scans a window around each for:
//  walls: a dry column with water on both sides (2 blocks away, along x or z) standing 2+ blocks above that water;
//  steps: neighbouring water columns whose surfaces differ by 3 or more (a channel sitting beside a lower one).
// Prints counts per 1000 water columns; exits non-zero when either exceeds its limit (WALLS, STEPS env, per 1000).
const fs = require("fs"), vm = require("vm"), path = require("path");
const R = path.join(__dirname, "..", "js") + path.sep;
global.window = global; global.THREE = {}; global.document = {};
const load = f => vm.runInThisContext(fs.readFileSync(R + f, "utf8"), { filename: f });
load("blocks.js"); load("noise.js"); BF.CS = 16; load("rivers.js"); load("worldgen.js");
const seed = +(process.argv[2] || 270465807), scale = +(process.argv[3] || 2), N = +(process.argv[4] || 60);
BF.setLimits(3); BF.noise = BF.makeNoise(seed); BF.worldgen.init(BF.noise, { gen: 3, biomeScale: scale });
const W = BF.worldgen, SEA = BF.SEA, o = {};
// river spots: a jittered grid around the origin, kept where a channel is under the point
const spots = [];
for (let k = 0; spots.length < N && k < 40000; k++) {
  const x = Math.floor((BF.noise.hash(k, 1, 991) - 0.5) * 24000), z = Math.floor((BF.noise.hash(k, 2, 991) - 0.5) * 24000);
  if (BF.rivers.at(x, z, o) && o.sd < -2 && o.rs > SEA + 4) spots.push([x, z]);
}
const r = 24;
let water = 0, walls = 0, steps = 0;
const ex = [];
for (const [cx, cz] of spots) {
  const S = 2 * r + 1, h = new Int32Array(S * S), wl = new Int32Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const x = cx - r + i, z = cz - r + j; h[j * S + i] = W.heightAt(x, z); wl[j * S + i] = W.waterLevelAt(x, z); }
  const wet = q => wl[q] > h[q];
  for (let j = 2; j < S - 2; j++) for (let i = 2; i < S - 2; i++) {
    const q = j * S + i;
    if (wet(q)) {
      water++;
      for (const n of [q + 1, q + S]) if (wet(n) && Math.abs(wl[n] - wl[q]) >= 3) { steps++; if (ex.length < 6) ex.push(`step ${cx - r + i},${cz - r + j} ${wl[q]}/${wl[n]}`); }
    } else {
      for (const [a, b] of [[q - 2, q + 2], [q - 2 * S, q + 2 * S]]) if (wet(a) && wet(b) && h[q] >= Math.min(wl[a], wl[b]) + 2) { walls++; if (ex.length < 6) ex.push(`wall ${cx - r + i},${cz - r + j} h ${h[q]} water ${wl[a]}/${wl[b]}`); break; }
    }
  }
}
const pw = walls * 1000 / water, ps = steps * 1000 / water;
console.log(`seed ${seed}: ${spots.length} river spots, ${water} water columns; walls ${walls} (${pw.toFixed(2)} per 1000), steps ${steps} (${ps.toFixed(2)} per 1000)`);
if (ex.length) console.log("  e.g. " + ex.join("; "));
const lw = +(process.env.WALLS || 0.2), ls = +(process.env.STEPS || 0.2);
process.exit(pw > lw || ps > ls ? 1 : 0);
