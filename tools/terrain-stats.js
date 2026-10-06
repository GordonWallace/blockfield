// Height statistics of generator 3 over a square area (node, no browser).
// Usage: node tools/terrain-stats.js seed biomeScale span [step=200] [centreX=0] [centreZ=0]
//   prints: share of land (and of everything) by height band, highest point, plateau share (y>=800 and flat), and /tp candidates.
const fs = require("fs"), vm = require("vm"), path = require("path");
const R = path.join(__dirname, "..", "js") + path.sep;
global.window = global; global.THREE = {}; global.document = {};
const load = f => vm.runInThisContext(fs.readFileSync(R + f, "utf8"), { filename: f });
load("blocks.js"); load("noise.js"); BF.CS = 16; load("rivers.js"); load("worldgen.js");
const [, , seed, scale, span, stepA, cxA, czA] = process.argv;
BF.noise = BF.makeNoise(+seed); BF.worldgen.init(BF.noise, { gen: 3, biomeScale: +scale });
const w = BF.worldgen, step = +(stepA || 200), cx = +(cxA || 0), cz = +(czA || 0), n = Math.floor(+span / step);
const bands = [[0, 100], [100, 500], [500, 900], [900, 1400], [1400, 2000], [2000, 1e9]];
const cnt = bands.map(() => 0); let land = 0, total = 0, maxH = -1e9, maxAt = null, plateau = 0, plateauBand = 0, oceanMin = 1e9;
const SH = [0, 0, 0, 0, 0, 0]; const hs = [], flat = [], tops = [], cliffRiv = [], oceans = [];
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const x = Math.round(cx - +span / 2 + i * step), z = Math.round(cz - +span / 2 + j * step), h = w.heightAt(x, z), wl = w.waterLevelAt(x, z);
  total++;
  if (h > maxH) { maxH = h; maxAt = [x, z]; }
  if (h <= 0 || h < wl) { if (h < oceanMin) oceanMin = h; oceans.push([x, z, h]); continue; }
  land++;
  for (let b = 0; b < bands.length; b++) if (h >= bands[b][0] && h < bands[b][1]) { cnt[b]++; break; }
  if (h >= 800) {
    plateauBand++;
    const s = Math.max(Math.abs(w.heightAt(x + 16, z) - h), Math.abs(w.heightAt(x, z + 16) - h), Math.abs(w.heightAt(x - 16, z) - h), Math.abs(w.heightAt(x, z - 16) - h));
    SH[s <= 1 ? 0 : s <= 3 ? 1 : s <= 6 ? 2 : s <= 12 ? 3 : s <= 30 ? 4 : 5]++; if (s <= 4) { plateau++; if (h >= 1000) flat.push([x, z, h]); }
  }
  if (h >= 1800) tops.push([x, z, h]);
}
const pct = v => (100 * v / Math.max(1, land)).toFixed(1) + "%";
console.log(`seed ${seed} scale ${scale} span ${span} step ${step}: ${total} samples, land ${(100 * land / total).toFixed(1)}% of area`);
console.log("land by height:", bands.map((b, i) => `${b[0]}-${b[1] > 1e8 ? "+" : b[1]} ${pct(cnt[i])}`).join(", "));
console.log(`highest ${maxH} at x=${maxAt[0]} z=${maxAt[1]}; lowest ocean floor ${oceanMin}`);
console.log(`plateau (y>=800, <=4 blocks over 16): ${pct(plateau)} of land (${(100 * plateau / Math.max(1, plateauBand)).toFixed(0)}% of land >= 800)`);
console.log("slope histogram of land >= 800 (max diff over 16 blocks: <=1, <=3, <=6, <=12, <=30, more):", SH.join(" "));
tops.sort((a, b) => b[2] - a[2]);
console.log("range tops:", tops.slice(0, 3).map(t => t.join(" ")).join(" | "));
console.log("flat high plains y>=1000:", flat.filter((_, k) => k % Math.max(1, Math.floor(flat.length / 4)) === 0).slice(0, 4).map(t => t.join(" ")).join(" | "));
