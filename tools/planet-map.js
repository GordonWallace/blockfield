// The planet (generator 4) as a world map and climate survey, plain node (spec r14-09).
// Usage: node tools/planet-map.js [seed=1337] [out.png] [width=720] [lat lon span]
// Draws an equirectangular map: biome colours (as tools/terrain-map.js), land shaded by height, the climate band edges as dark lines
// (the band after altitude, so mountains show their colder band), and prints land per band and per biome. With lat lon span (degrees)
// it draws only that window: span degrees of longitude, half that of latitude. Env COARSE=1 uses worldgen's coarse mode (approximate
// plateau weights, as the in-game map at its widest: massifs come out too big, but a 720-wide map takes seconds instead of minutes).
// survey(seed) is used by test/planet-biomes.js: every biome's share of land (full generator, sampled evenly over the sphere), and for
// each biome id one column where it occurs (found from coarse samples, confirmed with the full generator).
const fs = require("fs"), vm = require("vm"), zlib = require("zlib"), path = require("path");
const ROOT = path.join(__dirname, "..");
function env(seed) {
  delete global.BF;
  global.window = global; global.THREE = {}; global.document = {};
  for (const f of ["blocks.js", "noise.js", "planet.js", "planetgen.js", "planetrivers.js", "worldgen.js"])
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), { filename: f });
  BF.CS = 16; BF.state = { gen: 4 }; BF.noise = BF.makeNoise(seed);
  BF.worldgen.init(BF.noise, { gen: 4, villages: 10 });
  return BF;
}
const COL = { 0: [40, 70, 160], 1: [230, 215, 150], 2: [235, 235, 220], 3: [130, 130, 130], 4: [60, 120, 220], 5: [130, 190, 80], 6: [50, 130, 40], 7: [200, 120, 200], 8: [110, 170, 70], 9: [30, 80, 30], 10: [80, 110, 60], 11: [90, 90, 50], 12: [235, 210, 130], 13: [200, 110, 60], 14: [180, 170, 70], 15: [100, 170, 50], 16: [20, 150, 40], 17: [40, 110, 80], 18: [30, 90, 70], 19: [235, 240, 250], 20: [170, 220, 255], 21: [160, 200, 200], 22: [150, 210, 120], 23: [250, 170, 200], 24: [150, 150, 150], 25: [220, 230, 240], 26: [255, 255, 255], 27: [170, 170, 170], 28: [170, 100, 170], 29: [205, 222, 238] };
const BANDS = ["arctic", "subarctic", "temperate", "subtropical", "tropical"];
const isSea = id => id === 0 || id === 29;
// atlas column at latitude / longitude (degrees)
function colAt(P, lat, lon, o) { const a = P.atlasOfLatLon(lat, lon, o); return [Math.floor(a.x), Math.floor(a.z)]; }

function survey(seed, n = 3000) {
  const BF = env(seed), W = BF.worldgen, P = BF.planet, NM = W.NAMES;
  let rs = 12345 + seed;
  const rnd = () => { rs = (Math.imul(rs, 1103515245) + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const sphere = () => { const y = rnd() * 2 - 1, a = rnd() * 2 * Math.PI; return colAt(P, Math.asin(y) * 180 / Math.PI, a * 180 / Math.PI - 180, {}); };
  // shares of land, full generator
  const share = {}, byBand = [{}, {}, {}, {}, {}]; let land = 0, all = 0;
  for (let k = 0; k < n; k++) {
    const [x, z] = sphere(), id = W.biomeAt(x, z).id; all++;
    if (isSea(id)) { share[id] = (share[id] || 0) + 1; continue; }
    const tb = W.bandAt(x, z);
    land++; share[id] = (share[id] || 0) + 1; byBand[tb][id] = (byBand[tb][id] || 0) + 1;
  }
  // one column per biome: coarse samples suggest where to look, the full generator confirms (a few tries around each suggestion)
  const found = {};
  W.setCoarse(true);
  const cand = {};
  for (let k = 0; k < 40000; k++) { const [x, z] = sphere(), id = W.biomeAt(x, z).id; (cand[id] = cand[id] || []).length < 40 && cand[id].push([x, z]); }
  W.setCoarse(false);
  for (const id of Object.keys(cand).map(Number)) for (const [x, z] of cand[id]) {
    if (found[id]) break;
    for (let t = 0; t < 9 && !found[id]; t++) { const xx = x + ((t % 3) - 1) * 48, zz = z + (((t / 3) | 0) - 1) * 48; if (W.biomeAt(xx, zz).id === id) found[id] = [xx, zz]; }
  }
  for (let id = 0; id < NM.length; id++) if (share[id] && !found[id]) found[id] = true;   // (seen in the share sample)
  return { seed, land: land / all, share: Object.fromEntries(Object.entries(share).map(([id, c]) => [id, c / (isSea(+id) ? all : land)])), byBand, found, names: NM };
}

function map(seed, out, Wd, zoom) {
  const BF = env(seed), W = BF.worldgen, P = BF.planet, H = Wd / 2;
  W.setCoarse(!!process.env.COARSE);
  const latOf = j => zoom ? zoom.lat + zoom.span / 2 * (1 - 2 * (j + 0.5) / H) : 90 - (j + 0.5) / H * 180;
  const lonOf = i => zoom ? zoom.lon + zoom.span * ((i + 0.5) / Wd - 0.5) : (i + 0.5) / Wd * 360 - 180;
  const img = Buffer.alloc((Wd * 3 + 1) * H), band = new Int8Array(Wd * H), o = {};
  for (let j = 0; j < H; j++) for (let i = 0; i < Wd; i++) {
    const [x, z] = colAt(P, latOf(j), lonOf(i), o), b = W.biomeAt(x, z), h = b.height;
    band[j * Wd + i] = b.height >= BF.SEA ? W.bandAt(x, z) : -1;
    let c = COL[b.id] || [255, 0, 255];
    if (b.id === 0) { const d = Math.max(0, Math.min(1, -h / 60)); c = [40 - d * 25, 80 - d * 40, 170 - d * 70]; }
    else if (b.id !== 29) { const k = 0.75 + 0.4 * Math.max(0, Math.min(1, h / 2400)); c = c.map(v => Math.min(255, v * k)); }
    const q = j * (Wd * 3 + 1) + 1 + i * 3; img[q] = c[0]; img[q + 1] = c[1]; img[q + 2] = c[2];
  }
  // band edges on land: darken a land pixel whose band differs from the one to its right or below
  for (let j = 0; j < H; j++) for (let i = 0; i < Wd; i++) {
    const b = band[j * Wd + i];
    if (b < 0) continue;
    if ((i + 1 < Wd && band[j * Wd + i + 1] >= 0 && band[j * Wd + i + 1] !== b) || (j + 1 < H && band[(j + 1) * Wd + i] >= 0 && band[(j + 1) * Wd + i] !== b)) {
      const q = j * (Wd * 3 + 1) + 1 + i * 3; img[q] *= 0.45; img[q + 1] *= 0.45; img[q + 2] *= 0.45;
    }
  }
  function crc(b) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; }
  function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(Wd, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(img, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

if (require.main === module) {
  const a = process.argv, seed = +(a[2] || 1337), out = a[3] || "planet-" + seed + ".png", Wd = +(a[4] || 720);
  const zoom = a[7] !== undefined ? { lat: +a[5], lon: +a[6], span: +a[7] } : null;
  const t0 = Date.now();
  map(seed, out, Wd, zoom);
  console.log(`map ${out} (${Date.now() - t0} ms)`);
  const s = survey(seed);
  console.log(`seed ${seed}: land ${(100 * s.land).toFixed(1)}% of the planet`);
  for (const id of Object.keys(s.share).map(Number).sort((p, q) => p - q))
    console.log(`  ${String(id).padStart(2)} ${s.names[id].padEnd(18)} ${(100 * s.share[id]).toFixed(1)}% of ${isSea(id) ? "the planet" : "land"}`);
  for (let b = 4; b >= 0; b--) {
    const e = Object.entries(s.byBand[b]), tot = e.reduce((p, q) => p + q[1], 0);
    console.log(`  ${BANDS[b]} (${tot} land samples): ` + e.sort((p, q) => q[1] - p[1]).slice(0, 8).map(([id, c]) => `${s.names[id]} ${(100 * c / tot).toFixed(0)}%`).join(", "));
  }
  console.log("  not found: " + (s.names.map((n, i) => s.found[i] ? null : n).filter(Boolean).join(", ") || "none"));
}
module.exports = { survey, map, env };
