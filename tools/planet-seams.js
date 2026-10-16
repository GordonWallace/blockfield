// Generator 4 (the planet) terrain checks, node, no browser (spec r14-08). Usage: node tools/planet-seams.js [seeds=1337,42]
//  - edges: along all 12 cube edges (from both faces, so every turned edge too), the columns either side of the edge differ no more
//    than neighbouring columns on one face do, in height and in the slow fields (continentalness, temperature, humidity, erosion);
//    the fields are continuous there (no step from a warp or lattice laid out in the wrong frame)
//  - consistency (as tools/gen3-seams.js for generator 3): generateBand and generateRange agree, windows split anywhere concatenate to
//    the same blocks, the surface at heightAt is solid, water levels match waterLevelAt; chunks at face edges, on land, mountains, coasts
//  - corners: every cube corner is open sea; the seed's continent turn put every corner within reach of open sea or gave it a gulf
//  - statistics (as tools/terrain-stats.js): land fraction, land by height band, plateaus, peaks, sampled evenly over the sphere
// Exits non-zero on a failed check. Also used by test/planet-terrain.js.
const fs = require("fs"), vm = require("vm"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
function env(seed) {
  delete global.BF;
  global.window = global; global.THREE = {}; global.document = {};
  for (const f of ["blocks.js", "noise.js", "planet.js", "planetgen.js", "rivers.js", "planetrivers.js", "worldgen.js"])
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), { filename: f });
  BF.CS = 16; BF.state = { gen: 4 }; BF.noise = BF.makeNoise(seed);
  BF.worldgen.init(BF.noise, { gen: 4, villages: 10 });
  return BF;
}
const md5 = a => crypto.createHash("md5").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

function run(seeds, ok, log) {
  const stats = [];
  for (const seed of seeds) {
    const BF = env(seed), W = BF.worldgen, P = BF.planet, B = BF.B, N = P.N;
    const PG = BF.planetgen;
    log(`seed ${seed}: continent turn search ${PG.searchMs} ms, worst corner ${PG.cornerSea} blocks from open sea, gulfs ${PG.corners().filter(c => c.gulf).length}`);

    // ---- corners ----
    for (let f = 0; f < 6; f++) for (const [u, v] of [[2, 2], [N - 3, 2], [2, N - 3], [N - 3, N - 3]]) {
      const a = P.atlas(f, u, v), h = W.heightAt(a.x, a.z), b = W.biomeAt(a.x, a.z);
      ok(h < BF.SEA - 10 && W.waterLevelAt(a.x, a.z) === BF.SEA && (b.id === 0 || b.id === 29), `seed ${seed}: corner of face ${f} at ${u},${v} is open sea (height ${h}, ${b.name})`);
    }
    ok(PG.corners().every(c => c.reach === 0 || c.gulf), `seed ${seed}: every corner is in open sea or has a gulf to it`);
    // gulfs: with the continents left unturned (one try), corners short of open sea get a gulf; walk out along each one, the sea
    // goes on (within a few km of the gulf's straight line: its centre wanders) all the way to open sea
    {
      PG.placeCorners(1);
      const K = PG.corners(); let gulfs = 0, walkBad = 0;
      for (const k of K) if (k.gulf) {
        gulfs++;
        for (let r = 0; r <= k.reach + 2000; r += 500) {
          let sea = false;
          const dir = PG.ray(k.c, k.heading, r);
          for (const side of [0, 1000, -1000, 2000, -2000, 3000, -3000]) {   // across the gulf, along its plane's normal
            const d = [dir[0] + k.n[0] * side / P.R, dir[1] + k.n[1] * side / P.R, dir[2] + k.n[2] * side / P.R], l = Math.hypot(...d);
            if (PG.contDir(d[0] / l, d[1] / l, d[2] / l) < PG.SEA_C) { sea = true; break; }
          }
          if (!sea) { walkBad++; break; }
        }
      }
      log(`seed ${seed}: with the continents unturned, ${gulfs} corners need a gulf`);
      ok(walkBad === 0, `seed ${seed}: unturned continents leave ${gulfs} corners short of open sea, and each gets a gulf of sea out to it (${walkBad} blocked)`);
      PG.placeCorners();
    }

    // ---- edges ----
    // At points along each edge: the cross-edge step (last column of face f to the first of its neighbour, read through f's margin)
    // against the steps between neighbouring columns just inside, on both sides. Fields are compared the same way.
    const F = ["c", "t", "hu", "e"];
    let pts = 0, landPts = 0, hBad = 0, worstH = 0, fBad = 0;
    const fld = (x, z) => W._fields(x, z);
    for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) {
      const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      for (let k = 1; k < 24; k++) {
        const along = Math.round(N * k / 24) + 3;   // (the ends of each edge are corner sea)
        // inside column (one block from the edge) and the outward direction
        const u = h[0] ? (h[0] < 0 ? 0 : N - 1) : along, v = h[1] ? (h[1] < 0 ? 0 : N - 1) : along;
        const a = P.atlas(f, u, v), col = i => [a.x + h[0] * i, a.z + h[1] * i];   // i = 0 inside, 1 across the edge, -1, -2 further in
        const H = i => W.heightAt(...col(i));
        const across = Math.abs(H(1) - H(0));
        const inner = Math.max(Math.abs(H(0) - H(-1)), Math.abs(H(-1) - H(-2)), Math.abs(H(1) - H(2)), Math.abs(H(2) - H(3)));
        pts++; if (H(0) > 0) landPts++;
        if (across > Math.max(2, inner * 2 + 1)) { hBad++; if (hBad < 6) log(`  seed ${seed} face ${f} side ${s} at ${along}: height step ${across} across the edge, ${inner} inside (${H(-1)} ${H(0)} | ${H(1)} ${H(2)})`); }
        worstH = Math.max(worstH, across - inner);
        // fields: a point past the edge reads the same through this face's margin as on its own face, and the step across the edge
        // (columns -1 to 1) is no bigger than two-column steps on either side within 8 columns (the fields wander quickly in places)
        for (const i of [1, 2, 5]) {
          const m = fld(...col(i)), c = P.canon(...col(i), {}), q = fld(c.x, c.z);
          for (const key of F) if (!(Math.abs(m[key] - q[key]) < 1e-9)) { fBad++; if (fBad < 6) log(`  seed ${seed} face ${f} side ${s} at ${along}: field ${key} through the margin ${m[key]} vs ${q[key]} on face ${c.f}`); }
        }
        const row = []; for (let i = -9; i <= 9; i++) row.push(fld(...col(i)));
        for (const key of F) {
          const at = i => row[i + 9][key], st = Math.abs(at(1) - at(-1));
          let inn = 0; for (let i = -9; i <= 7; i++) if (i !== -1) inn = Math.max(inn, Math.abs(at(i + 2) - at(i)));
          if (st > inn * 2.5 + 1e-4) { fBad++; if (fBad < 6) log(`  seed ${seed} face ${f} side ${s} at ${along}: field ${key} steps ${st.toFixed(5)} across, at most ${inn.toFixed(5)} either side`); }
        }
      }
    }
    ok(hBad === 0, `seed ${seed}: heights across all 24 edge sides (${pts} points, ${landPts} on land) step no more than inside (${hBad} bad, worst excess ${worstH})`);
    ok(fBad === 0, `seed ${seed}: continentalness, temperature, humidity and erosion read the same through either face and run on across every edge (${fBad} bad)`);

    // ---- consistency ----
    const spots = [];
    const sp = PG.spawnSearch(); spots.push(["spawn", sp[0], sp[1]]);
    // a mountain, a coast and a plateau near spawn (on face 4)
    let best = null, coast = null, plat = null;
    for (let z = -24000; z <= 24000; z += 800) for (let x = -24000; x <= 24000; x += 800) {
      const X = sp[0] + x, Z = sp[1] + z, hh = W.heightAt(X, Z);
      if (!best || hh > best[3]) best = ["range", X, Z, hh];
      if (!coast && hh > 0 && hh < 6 && W.heightAt(X + 64, Z) < -2) coast = ["coast", X, Z, hh];
      if (!plat && hh >= 900 && hh < 1300 && Math.abs(W.heightAt(X + 300, Z) - hh) < 10) plat = ["plateau", X, Z, hh];
    }
    for (const q of [best, coast, plat]) if (q) spots.push(q);
    // land at face edges: walk each of face 4's edges and face 2's (a polar face, whose edges turn) for a land column
    for (const [f, s] of [[4, 0], [4, 1], [4, 2], [4, 3], [2, 0], [2, 1], [2, 2], [2, 3]]) {
      const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      let got = null;
      for (let k = 1; k < 64 && !got; k++) {
        const along = Math.round(N * k / 64);
        const a = P.atlas(f, h[0] ? (h[0] < 0 ? 0 : N - 1) : along, h[1] ? (h[1] < 0 ? 0 : N - 1) : along);
        if (W.heightAt(a.x, a.z) > 2) got = [`edge ${f}/${s}`, a.x, a.z];
      }
      if (!got) { const along = N >> 1; const a = P.atlas(f, h[0] ? (h[0] < 0 ? 0 : N - 1) : along, h[1] ? (h[1] < 0 ? 0 : N - 1) : along); got = [`edge ${f}/${s} (sea)`, a.x, a.z]; }
      spots.push(got);
    }
    const LOGS = new Set(Object.keys(B).filter(k => k.endsWith("_log")).map(k => B[k]));
    const solid = id => id !== 0 && id !== B.water && BF.SOLID[id];
    let chunks = 0, airTops = 0, samples = 0;
    for (const [name, sx, sz] of spots) {
      const c = P.canonCell(sx, sz, {});
      const cx0 = Math.floor(c.x / 16) - 1, cz0 = Math.floor(c.z / 16) - 1;
      for (let cz = cz0; cz < cz0 + 3; cz++) for (let cx = cx0; cx < cx0 + 3; cx++) {
        const q = P.canonCell(cx * 16 + 8, cz * 16 + 8, {});
        if (q.off || q.wedge || q.x !== cx * 16 + 8 || q.z !== cz * 16 + 8) continue;   // a chunk in a margin isn't generated (its canonical one is)
        const tag = `seed ${seed} ${name} chunk ${cx},${cz}`;
        const { lo, hi, vox } = W.generateBand(cx, cz);
        chunks++;
        if (!ok(lo >= -4 && hi <= 192 && lo < hi && vox.length === (hi - lo) * 4096, `${tag}: band shape lo ${lo} hi ${hi}`)) continue;
        const y0 = lo * 16, blk = (lx, y, lz) => y < y0 ? B.stone : y >= hi * 16 ? 0 : vox[((y - y0) * 16 + lz) * 16 + lx];
        const rb = Math.max(-4, lo - 2), up = W.generateRange(cx, cz, rb, hi + 3), off = (lo - rb) * 4096;
        let diff = -1; for (let i = 0; i < vox.length; i++) if (up[off + i] !== vox[i]) { diff = i; break; }
        ok(diff < 0, `${tag}: generateRange differs from the band at ${diff}`);
        let above = -1; for (let i = off + vox.length; i < up.length; i++) if (up[i] !== 0) { above = i; break; }
        ok(above < 0, `${tag}: blocks above the band`);
        // windows split anywhere concatenate to the same blocks
        const base = Math.max(-4, lo - 6), whole = W.generateRange(cx, cz, base, hi + 1);
        const edges = [base, lo - 2, lo + 1, hi + 1].filter((e, i, a) => i === 0 || (e > a[i - 1] && e <= hi + 1));
        for (let k = 0; k + 1 < edges.length; k++) {
          const part = W.generateRange(cx, cz, edges[k], edges[k + 1]);
          ok(md5(part) === md5(whole.subarray((edges[k] - base) * 4096, (edges[k + 1] - base) * 4096)), `${tag}: split window ${edges[k]}..${edges[k + 1]} differs`);
        }
        for (let lz = 0; lz < 16; lz += 3) for (let lx = 0; lx < 16; lx += 3) {
          const x = cx * 16 + lx, z = cz * 16 + lz, hh = W.heightAt(x, z), wl = W.waterLevelAt(x, z);
          if (!ok(hh >= y0 && hh < hi * 16, `${tag}: surface ${hh} outside the band`)) continue;
          const sb = blk(lx, hh, lz);
          samples++;
          if (sb === 0) airTops++;   // cave mouths may open the surface
          else ok(solid(sb) || sb === B.ice || (sb === B.water && W.villagesNear(x, z, 70).length > 0), `${tag}: no solid block at heightAt ${hh} (${x},${z}) id ${sb}`);   // (a village well holds water at pad level)
          if (wl > hh) {
            const wet = id => id === B.water || id === B.ice || LOGS.has(id) || id === B.mangrove_leaves || id === B.packed_ice;
            ok(wl < hi * 16 && wet(blk(lx, wl, lz)), `${tag}: water level ${wl} not water at ${x},${z}`);
          }
        }
        if (lo === -4) ok(blk(3, -64, 3) === B.bedrock, `${tag}: no bedrock at -64`);
      }
    }
    ok(airTops <= samples * 0.04, `seed ${seed}: ${airTops} of ${samples} surface cells open (cave mouths)`);
    log(`seed ${seed}: ${pts} edge points, ${chunks} chunks checked at ${spots.length} spots`);

    // ---- statistics, evenly over the sphere ----
    let rs = seed * 7 + 1; const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;
    const bands = [[0, 100], [100, 500], [500, 900], [900, 1400], [1400, 2000], [2000, 1e9]], cnt = bands.map(() => 0);
    let land = 0, total = 0, maxH = -1e9, flat = 0, high = 0, ice = 0;
    for (let i = 0; i < 3000; i++) {
      const zz = rnd() * 2 - 1, an = rnd() * 2 * Math.PI, r = Math.sqrt(1 - zz * zz), g = P.fromDir(r * Math.cos(an), zz, r * Math.sin(an), {});
      const a = P.atlas(g.f, Math.floor(g.u), Math.floor(g.v)), hh = W.heightAt(a.x, a.z), wl = W.waterLevelAt(a.x, a.z);
      total++;
      if (hh <= 0 || hh < wl) continue;
      land++; maxH = Math.max(maxH, hh);
      for (let b = 0; b < bands.length; b++) if (hh >= bands[b][0] && hh < bands[b][1]) { cnt[b]++; break; }
      if (hh >= 800) { high++; if (Math.abs(W.heightAt(a.x + 16, a.z) - hh) <= 4 && Math.abs(W.heightAt(a.x, a.z + 16) - hh) <= 4) flat++; }
    }
    const pct = v => (100 * v / Math.max(1, land)).toFixed(1) + "%";
    const st = { seed, land: land / total, bands: cnt.map(c => c / Math.max(1, land)), maxH, plateau: flat / Math.max(1, land) };
    stats.push(st);
    log(`seed ${seed}: land ${(100 * st.land).toFixed(1)}% of the planet; land by height ${bands.map((b, i) => `${b[0]}-${b[1] > 1e8 ? "+" : b[1]} ${pct(cnt[i])}`).join(", ")}; highest ${maxH}; flat high plains (y >= 800) ${pct(flat)}`);
  }
  return stats;
}
module.exports = { run, env };
if (require.main === module) {
  const seeds = (process.argv[2] || "1337,42").split(",").map(Number);
  let fails = 0;
  run(seeds, (c, msg) => { if (!c) { fails++; console.log("FAIL:", msg); } return c; }, m => console.log(m));
  console.log(fails ? "FAILED " + fails : "all checks passed");
  process.exit(fails ? 1 : 0);
}
