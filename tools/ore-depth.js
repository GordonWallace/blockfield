// Gen 3 ore census by depth below the surface: node tools/ore-depth.js [seed] [chunks]
// Samples land chunks on a coarse grid around the origin, generates each column from 150 below its surface to the surface and counts ore
// blocks per 10-block depth bin, split into low land (surface below y 40) and the rest. With REF=<rev> it reads js/ from that revision.
const path = require("path"), cp = require("child_process");
const { env, cur } = require("./gen3-check.js");
const ROOT = path.join(__dirname, "..");
const srcOf = process.env.REF ? f => cp.execFileSync("git", ["show", process.env.REF + ":js/" + f], { cwd: ROOT, maxBuffer: 1 << 26 }).toString() : cur;
const seed = +(process.argv[2] || 1337), want = +(process.argv[3] || 120);
const BF = env(srcOf);
BF.noise = BF.makeNoise(seed); BF.worldgen.init(BF.noise, { gen: 3, biomeScale: 1 });
const ORES = ["coal", "iron", "copper", "lapis", "gold", "redstone", "diamond", "emerald"];
const idOre = new Map();
for (const o of ORES) for (const n of [o + "_ore", "deepslate_" + o + "_ore"]) if (BF.B[n] !== undefined) idOre.set(BF.B[n], o);
const DEPTH = 150, BIN = 10;
const tab = { low: { n: 0, bins: {} }, high: { n: 0, bins: {} } };
let found = 0;
for (let r = 0; found < want && r < 40000; r++) {
  const cx = ((r * 7919) % 6000) - 3000, cz = (((r * 104729) >> 3) % 6000) - 3000;
  const hc = BF.worldgen.heightAt(cx * 16 + 8, cz * 16 + 8);
  const wl = BF.worldgen.waterLevelAt ? BF.worldgen.waterLevelAt(cx * 16 + 8, cz * 16 + 8) : null;
  if (hc < 2 || (wl != null && wl > hc)) continue;      // land only
  const lowLand = hc < 40;
  if (lowLand ? tab.low.n >= want / 2 : tab.high.n >= want / 2) continue;
  found++;
  const T = lowLand ? tab.low : tab.high; T.n++;
  const sy0 = (hc - DEPTH) >> 4, sy1 = (hc >> 4) + 1;
  const vox = BF.worldgen.generateRange(cx, cz, sy0, sy1), Y0 = Math.max(sy0, BF.SY0) * 16;
  for (let i = 0; i < vox.length; i++) {
    const o = idOre.get(vox[i]);
    if (!o) continue;
    const y = Y0 + (i >> 8), x = i & 15, z = (i >> 4) & 15;
    const d = BF.worldgen.heightAt(cx * 16 + x, cz * 16 + z) - y;
    if (d < 0 || d >= DEPTH) continue;
    const b = Math.floor(d / BIN) * BIN;
    (T.bins[b] || (T.bins[b] = {}))[o] = ((T.bins[b] || {})[o] || 0) + 1;
  }
}
for (const k of ["low", "high"]) {
  const T = tab[k];
  console.log(`\n${k === "low" ? "low land (surface < y40)" : "higher land"}: ${T.n} chunks, ore blocks per chunk by depth below the surface`);
  console.log("depth   " + ORES.map(o => o.padStart(9)).join(""));
  const tot = {};
  for (let b = 0; b < DEPTH; b += BIN) {
    const row = T.bins[b] || {};
    console.log(String(b).padStart(3) + "-" + String(b + BIN - 1).padEnd(4) + ORES.map(o => { tot[o] = (tot[o] || 0) + (row[o] || 0); return ((row[o] || 0) / Math.max(1, T.n)).toFixed(2).padStart(9); }).join(""));
  }
  console.log("total   " + ORES.map(o => ((tot[o] || 0) / Math.max(1, T.n)).toFixed(1).padStart(9)).join(""));
}
