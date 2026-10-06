// Finds /tp coordinates worth visiting in generator 3 (node tools/terrain-spots.js seed biomeScale [span=40000] [step=200]):
//   a flat high plains area (y >= 1000), the top of a mountain range, an escarpment with a river descending it, and an ocean far from land.
const m = require("./gen3-check.js");
const seed = +(process.argv[2] || 1337), scale = +(process.argv[3] || 2), span = +(process.argv[4] || 40000), step = +(process.argv[5] || 200);
const BF = m.env(m.cur); BF.noise = BF.makeNoise(seed); BF.worldgen.init(BF.noise, { gen: 3, biomeScale: scale });
const W = BF.worldgen, n = Math.floor(span / step), x0 = -span / 2, z0 = -span / 2;
const H = new Int16Array(n * n), WL = new Int16Array(n * n), RV = new Uint8Array(n * n), MI = new Uint8Array(n * n);
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const x = x0 + i * step, z = z0 + j * step;
  H[j * n + i] = W.heightAt(x, z); WL[j * n + i] = W.waterLevelAt(x, z); const id = W.biomeAt(x, z).id; RV[j * n + i] = id === 4 ? 1 : 0; MI[j * n + i] = W._fields(x, z).c < -0.5 ? 1 : 0;
}
const at = (i, j) => H[j * n + i];
// 1. flat high plains: a 5x5 block of samples (800 x 800 blocks) with y >= 1000, no water, the least relief (<= 30), ties to the origin
let flat = null;
for (let j = 2; j < n - 2; j++) for (let i = 2; i < n - 2; i++) {
  let lo = 1e9, hi = -1e9, wet = 0;
  for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { const k = (j + b) * n + i + a; lo = Math.min(lo, H[k]); hi = Math.max(hi, H[k]); if (WL[k] > H[k] || RV[k]) wet++; }
  if (lo >= 1000 && hi - lo <= 30 && !wet) { const d = Math.hypot(x0 + i * step, z0 + j * step) + (hi - lo) * 400; if (!flat || d < flat.d) flat = { x: x0 + i * step, z: z0 + j * step, y: at(i, j), d, relief: hi - lo }; }
}
// 2. highest point
let top = null;
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!top || at(i, j) > top.y) top = { x: x0 + i * step, z: z0 + j * step, y: at(i, j) };
// refine the peak at 20-block resolution around it
for (let dz = -step; dz <= step; dz += 20) for (let dx = -step; dx <= step; dx += 20) { const h = W.heightAt(top.x + dx, top.z + dz); if (h > top.y) { top.y = h; top.px = top.x + dx; top.pz = top.z + dz; } }
if (top.px !== undefined) { top.x = top.px; top.z = top.pz; }
// 3. escarpment with a river: two neighbouring river samples (<= 300 blocks apart) whose water levels differ by >= 30 (a cascading river), above y 300; steepest first
let esc = null;
for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
  const k = j * n + i; if (!RV[k] || WL[k] < 300 || WL[k] > 1100) continue;
  for (const [a, b] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const k2 = (j + b) * n + i + a; if (!RV[k2]) continue;
    const drop = Math.abs(WL[k] - WL[k2]);
    if (drop >= 30 && drop <= 150 && (!esc || drop > esc.drop)) esc = { x: x0 + i * step, z: z0 + j * step, y: Math.max(WL[k], WL[k2]), drop, to: [x0 + (i + a) * step, z0 + (j + b) * step] };
  }
}
// 4. ocean far from land: farthest sample from any land sample (two-pass chamfer distance in samples)
const D = new Float32Array(n * n);
for (let k = 0; k < n * n; k++) D[k] = H[k] > 0 && !(WL[k] > H[k]) && !MI[k] ? 0 : 1e9;   // the specks of land in deep ocean (continentalness < -0.5, mushroom islands) do not count
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let d = D[j * n + i]; if (i) d = Math.min(d, D[j * n + i - 1] + 1); if (j) d = Math.min(d, D[(j - 1) * n + i] + 1); if (i && j) d = Math.min(d, D[(j - 1) * n + i - 1] + 1.4); D[j * n + i] = d; }
for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { let d = D[j * n + i]; if (i < n - 1) d = Math.min(d, D[j * n + i + 1] + 1); if (j < n - 1) d = Math.min(d, D[(j + 1) * n + i] + 1); if (i < n - 1 && j < n - 1) d = Math.min(d, D[(j + 1) * n + i + 1] + 1.4); D[j * n + i] = d; }
let sea = null;
for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) { const d = D[j * n + i] * step; if (d < 1e8 && (!sea || d > sea.d)) sea = { x: x0 + i * step, z: z0 + j * step, y: at(i, j), d }; }
const f = o => o ? `/tp ${Math.round(o.x)} ${Math.round(o.z)}` : "(none found)";
console.log(`seed ${seed} biomeScale ${scale} (searched ${span} x ${span} around the origin, step ${step})`);
console.log(`  flat high plains:  ${f(flat)}   surface y ${flat ? flat.y : "-"}, relief <= ${flat ? flat.relief : "-"} over 800 x 800`);
console.log(`  mountain peak:     ${f(top)}   y ${top.y}`);
console.log(`  escarpment river:  ${f(esc)}   water y ${esc ? esc.y : "-"}, the river falls ${esc ? esc.drop : "-"} blocks towards ${esc ? esc.to.join(" ") : "-"}`);
console.log(`  far ocean:         ${f(sea)}   floor y ${sea ? sea.y : "-"}, about ${sea ? Math.round(sea.d) : "-"} blocks from land`);
