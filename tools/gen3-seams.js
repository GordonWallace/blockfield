// Generator 3 consistency checks (run through tools/gen3-check.js, or directly: node tools/gen3-seams.js [seed] [scale]).
//  - generateBand: sane lo/hi, vox length, nothing above hi (checked via generateRange), surface at heightAt is solid, water levels match waterLevelAt
//  - generateRange over lo-2..hi+3 agrees byte for byte with the band on the overlap, sections above the band are air
//  - generateRange split into windows (cut at or below the lowest ground: a window whose floor is exactly a ground plant's cell cannot see the soil below it) concatenates to the same blocks (deep generation is a pure function of absolute coordinates)
// Areas: around the origin, a mountain range and a coast (found from the height field for the seed).
function run(env, cur, ok, md5) {
  const seeds = process.env.SEEDS ? process.env.SEEDS.split(",").map(Number) : [1337, 5];
  const scales = process.env.SCALES ? process.env.SCALES.split(",").map(Number) : [1, 2];
  let chunksDone = 0, rangeCmp = 0, samples = 0, airTops = 0;
  for (const seed of seeds) for (const scale of scales) {
    const BF = env(cur);
    BF.noise = BF.makeNoise(seed); BF.worldgen.init(BF.noise, { gen: 3, biomeScale: scale });
    const W = BF.worldgen, B = BF.B, CS = 16;
    ok(BF.MIN_Y === -64 && BF.H === 3072 && BF.SEA === 0 && BF.SY0 === -4 && BF.SY1 === 192, "limits after init gen 3");
    // pick areas: a mountain top, a coast, plateau, origin
    const spots = [["origin", 0, 0]];
    let best = null, coast = null, plat = null;
    for (let z = -12000; z <= 12000; z += 400) for (let x = -12000; x <= 12000; x += 400) {
      const h = W.heightAt(x, z);
      if (!best || h > best[3]) best = ["range", x, z, h];
      if (!coast && h > 0 && h < 6 && W.heightAt(x + 64, z) < -2) coast = ["coast", x, z, h];
      if (!plat && h >= 1000 && h < 1300 && Math.abs(W.heightAt(x + 300, z) - h) < 10) plat = ["plateau", x, z, h];
    }
    for (const sp of [best, coast, plat]) if (sp) spots.push(sp);
    const solid = id => id !== 0 && id !== B.water && BF.SOLID[id];
    for (const [name, sx, sz] of spots) {
      const cx0 = Math.floor(sx / CS) - 3, cz0 = Math.floor(sz / CS) - 3, N = 7;
      for (let cz = cz0; cz < cz0 + N; cz++) for (let cx = cx0; cx < cx0 + N; cx++) {
        const tag = `seed ${seed} sc ${scale} ${name} chunk ${cx},${cz}`;
        const band = W.generateBand(cx, cz), { lo, hi, vox } = band;
        chunksDone++;
        if (!ok(lo >= -4 && hi <= 192 && lo < hi && vox.length === (hi - lo) * 4096, `${tag}: band shape lo ${lo} hi ${hi} len ${vox.length}`)) continue;
        const y0 = lo * 16;
        const blk = (lx, y, lz) => y < y0 ? B.stone : y >= hi * 16 ? 0 : vox[((y - y0) * 16 + lz) * 16 + lx];
        // above the band: everything must be air (the range generator runs the same trees / villages / plants without the band clip)
        const rb = Math.max(-4, lo - 2), up = W.generateRange(cx, cz, rb, hi + 3);
        const overlap = vox.length, off = (lo - rb) * 4096;
        let diff = -1;
        for (let i = 0; i < overlap; i++) if (up[off + i] !== vox[i]) { diff = i; break; }
        rangeCmp++;
        ok(diff < 0, `${tag}: generateRange differs from band at ${diff} (y ${Math.floor(diff / 256) + y0}, lo ${lo} hi ${hi})`);
        let nonAir = -1;
        for (let i = off + overlap; i < up.length; i++) if (up[i] !== 0) { nonAir = i; break; }
        ok(nonAir < 0, `${tag}: blocks above the band (y ${nonAir < 0 ? 0 : Math.floor((nonAir - off) / 256) + y0}) id ${nonAir < 0 ? 0 : up[nonAir]}`);
        // below the band: bedrock-only floor must exist when the band is at the world bottom; otherwise the range must be solid-ish
        // surface and water
        for (let lz = 0; lz < 16; lz += 3) for (let lx = 0; lx < 16; lx += 3) {
          const x = cx * 16 + lx, z = cz * 16 + lz, h = W.heightAt(x, z), wl = W.waterLevelAt(x, z);
          if (!ok(h >= y0 && h < hi * 16, `${tag}: surface ${h} outside band ${y0}..${hi * 16} at ${x},${z}`)) continue;
          const sb = blk(lx, h, lz);
          samples++;
          if (sb === 0 && ok(solid(blk(lx, h - 1, lz)) || blk(lx, h - 1, lz) === 0, `${tag}: odd block under open top at ${x},${z}`)) airTops++;   // cave entrances may open the surface
          else ok(sb === 0 || solid(sb) || sb === B.ice || (sb === B.water && W.villagesNear(x, z, 70).length > 0),   // a village well holds water at pad level
             `${tag}: no solid block at heightAt ${h} (${x},${z}) id ${sb}`);
          if (wl > h) {
            const wet = id => id === B.water || id === B.ice || id === B.mangrove_log || id === B.mangrove_leaves;   // mangrove trunks replace water
            ok(wl < hi * 16 && wet(blk(lx, wl, lz)), `${tag}: water level ${wl} not water at ${x},${z} (id ${blk(lx, wl, lz)})`);
            ok(wet(blk(lx, h + 1, lz)) || h + 1 === wl, `${tag}: no water just above floor ${h} wl ${wl}`);
          }
        }
        // bottom of the world is bedrock
        if (lo === -4) for (let lz = 0; lz < 16; lz += 5) for (let lx = 0; lx < 16; lx += 5) ok(blk(lx, -64, lz) === B.bedrock, `${tag}: no bedrock at -64`);
      }
    }
    // tall structures: every biome that builds big trees / spikes / villages must fit in its band (nothing above hi in the larger range)
    const want = { 16: "jungle", 18: "old taiga", 20: "ice spikes", 9: "dark forest", 15: "sparse jungle", 11: "mangrove", 14: "savanna", 6: "forest", 17: "taiga", 5: "plains", 22: "meadow", 12: "desert" };
    const got = {};
    for (let z = -30000; z <= 30000 && Object.keys(got).length < Object.keys(want).length * 1; z += 700) for (let x = -30000; x <= 30000; x += 700) {
      const id = W.biomeAt(x, z).id; if (want[id] && (got[id] || (got[id] = [])).length < 4) got[id].push([x >> 4, z >> 4]);
    }
    if (process.env.VERBOSE) console.log("biome sweep:", Object.keys(got).map(k => want[k] + "x" + got[k].length).join(" "));
    for (const id in got) for (const [bx, bz] of got[id]) for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
      const cx = bx + dx, cz = bz + dz, band = W.generateBand(cx, cz);
      const rb = Math.max(-4, band.lo - 1), up = W.generateRange(cx, cz, rb, band.hi + 4), off = (band.hi - rb) * 4096;
      let bad = -1; for (let i = off; i < up.length; i++) if (up[i] !== 0) { bad = i; break; }
      chunksDone++;
      ok(bad < 0, `seed ${seed} sc ${scale} ${want[id]} chunk ${cx},${cz}: blocks above band (y ${bad < 0 ? 0 : Math.floor((bad - off) / 256) + band.hi * 16}) id ${bad < 0 ? 0 : up[bad]}`);
      let diff = -1; for (let i = 0; i < band.vox.length; i++) if (up[(band.lo - rb) * 4096 + i] !== band.vox[i]) { diff = i; break; }
      ok(diff < 0, `seed ${seed} sc ${scale} ${want[id]} chunk ${cx},${cz}: range/band mismatch`);
    }
    // windows split anywhere concatenate to the same blocks (and match the band where they overlap)
    for (const [cx, cz] of [[0, 0], [37, -21], [-100, 55], [spots[1][1] >> 4, spots[1][2] >> 4]]) {
      const b = W.generateBand(cx, cz), lo = b.lo, hi = b.hi;
      const whole = W.generateRange(cx, cz, Math.max(-4, lo - 12), hi + 1);
      const base = Math.max(-4, lo - 12);
      for (const cuts of [[lo - 5, lo + 1], [lo - 1, lo, lo + 1, lo + 3], [lo - 11, lo - 3]]) {
        const edges = [Math.max(-4, lo - 12), ...cuts.filter(c => c > base && c < hi + 1), hi + 1];
        for (let k = 0; k + 1 < edges.length; k++) {
          const part = W.generateRange(cx, cz, edges[k], edges[k + 1]);
          const slice = whole.subarray((edges[k] - base) * 4096, (edges[k + 1] - base) * 4096);
          ok(md5(part) === md5(slice), `seed ${seed} sc ${scale} chunk ${cx},${cz}: split window ${edges[k]}..${edges[k + 1]} differs from whole`);
          rangeCmp++;
        }
      }
    }
  }
  ok(airTops <= samples * 0.04, `too many open surface cells: ${airTops} of ${samples}`);
  console.log("seams: checked", chunksDone, "bands and", rangeCmp, "range comparisons");
}
module.exports = { run };
if (require.main === module) {
  const m = require("./gen3-check.js");
  if (process.argv[2]) process.env.SEEDS = process.argv[2];
  if (process.argv[3]) process.env.SCALES = process.argv[3];
  let fails = 0;
  run(m.env, m.cur, (c, msg) => { if (!c) { fails++; console.log("FAIL:", msg); } return c; }, m.md5);
  process.exit(fails ? 1 : 0);
}
