// The planet's rivers (spec r14-10), checked on the network and on the generated terrain. Ported from blockfield-round's
// tools/river-check.js. Usage: node tools/planet-rivers.js [seed=1337] [rivers to walk=100]   (SHOW=1 lists what fails)
//
// Network (every node): each land node reaches the sea without loops; the water surface never rises from a node to the one it drains
// into; no two river links cross.
// Terrain (the rivers with the longest way to the sea, walked from source to sea every 4 blocks along the meandering centre line, read
// through worldgen's climate: the column heights and water levels chunks are built from):
//  - "rises": the water at the centre line is higher than somewhere upstream of it;
//  - "dry": a centre-line column with no water;
//  - "spills": across the river (every 64 blocks), a water column next to a dry column whose ground is below the water (water standing
//    against air).
// check(seed, walk) returns the counts; tools/planet-map.js's env() loads the generator.
const { env } = require("./planet-map.js");

function check(seed, WALK = 100, show = !!process.env.SHOW, STEP = 4) {
  const BF = env(seed), W = BF.worldgen, P = BF.planet;
  const t0 = Date.now(), RV = W.planetRivers(), tSolve = Date.now() - t0;
  const { link, down, sea, rs, U, V } = RV, NN = RV.NN + RV.lakes.length;   // lattice nodes, then lakes
  // ---- network ----
  let loops = 0, uphill = 0, maxSteps = 0;
  for (let n = 0; n < NN; n++) {
    if (sea[n]) continue;
    let m = n, k = 0;
    while (m >= 0 && !sea[m] && down[m] >= 0 && k <= NN) { if (rs[down[m]] > rs[m] + 1e-4) uphill++; m = down[m]; k++; }
    if (k > NN) loops++;
    maxSteps = Math.max(maxSteps, k);
  }
  // crossings: chords of links on the same face (moved into one grid), sharing no node; a river into a lake ends at the shore, so its chord does too
  const A = [0, 0], B = [0, 0], C = [0, 0], D = [0, 0];
  const cross = (a, b, c, d) => {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  const end = (f, n, out) => { const en = RV.entry.get(n); if (en) { out[0] = en[0]; out[1] = en[1]; return out; } return RV.inFace(f, down[n], out); };
  let crossings = 0;
  const byCell = new Map(), cellOf = (f, u, v) => f * 1e6 + Math.floor(u / 4096) * 1000 + Math.floor(v / 4096);
  for (const n of link) { const k = cellOf(RV.faceOf(n), U[n], V[n]); (byCell.get(k) || byCell.set(k, []).get(k)).push(n); }
  for (const n of link) {
    const f = RV.faceOf(n);
    RV.inFace(f, n, A); end(f, n, B);
    for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
      const a = byCell.get(f * 1e6 + (Math.floor(U[n] / 4096) + du) * 1000 + Math.floor(V[n] / 4096) + dv);
      if (a) for (const m of a) {
        if (m <= n || m === down[n] || down[m] === n || (down[m] === down[n] && !RV.isLake(down[n]))) continue;   // into one lake: at different places
        RV.inFace(f, m, C); end(f, m, D);
        if (cross(A, B, C, D)) { crossings++; if (show) console.log("crossing: links from", n, "and", m, "on face", f, "near", A.map(Math.round)); }
      }
    }
  }
  // ---- terrain ----
  // sources = river nodes nothing flows into; walk the ones with the longest way to the sea
  const fed = new Uint8Array(NN), isRiver = new Uint8Array(NN), li = new Int32Array(NN).fill(-1);
  link.forEach((n, i) => { isRiver[n] = 1; li[n] = i; if (down[n] >= 0) fed[down[n]] = 1; });
  const sources = link.filter(n => !fed[n]).map(n => { let k = 0, m = n; while (m >= 0 && isRiver[m]) { m = down[m]; k++; } return [n, k]; });
  sources.sort((a, b) => b[1] - a[1]);
  const w = {}, a = {}, col = { h: 0, wl: 0, x: 0, z: 0 };
  function surf(F, x, y) {   // the column at grid point (x, y) of face F's (extended) grid
    P.wrap(F, x, y, w);
    P.atlas(w.f, Math.floor(w.u), Math.floor(w.v), a);
    col.x = a.x; col.z = a.z;
    col.wl = W.waterLevelAt(a.x, a.z); col.h = W.heightAt(a.x, a.z);
    return col;
  }
  let cols = 0, rises = 0, dry = 0, spills = 0, worst = 0, walked = 0, sections = 0;
  const seen = new Uint8Array(NN), t1 = Date.now();
  for (const [src] of sources.slice(0, WALK)) {
    let prev = Infinity, m = src;
    walked++;
    while (m >= 0 && isRiver[m]) {
      const c = RV.curve(li[m]);
      for (let k = 0; k < c.xs.length - 1; k++) for (let s = 0; s < 4; s++) {
        const t = s / 4, x = c.xs[k] + (c.xs[k + 1] - c.xs[k]) * t, y = c.ys[k] + (c.ys[k + 1] - c.ys[k]) * t;
        const S = surf(c.F, x, y), wl = S.wl;
        cols++;
        if (wl <= S.h) { dry++; if (show && dry <= 12) console.log("dry: link from", m, "at", S.x, S.z, "water", wl, "ground", S.h, "river rs", Math.round(rs[m]), "->", Math.round(rs[down[m]])); }
        if (wl > prev) {
          rises++; worst = Math.max(worst, wl - prev);
          if (show && rises <= 12) console.log("rise: link from", m, RV.isLake(m) ? "(a lake's outlet)" : "", "at", S.x, S.z, "water", wl, "after", prev, "river rs", Math.round(rs[m]), "->", Math.round(rs[down[m]]));
        }
        prev = Math.min(prev, wl);
      }
      // cross-sections every 64 blocks along the link (once per link)
      if (!seen[m]) {
        seen[m] = 1;
        for (let k = 2; k < c.xs.length - 1; k += 4) {
          const tx = c.xs[k + 1] - c.xs[k], ty = c.ys[k + 1] - c.ys[k], l = Math.hypot(tx, ty);
          const nx = -ty / l, ny = tx / l, reach = Math.ceil(c.w) + 8;
          let last = null;
          sections++;
          for (let o = -reach; o <= reach; o++) {
            const S = surf(c.F, c.xs[k] + nx * o, c.ys[k] + ny * o), cur = { h: S.h, wl: S.wl };
            if (last && ((last.wl > last.h && cur.wl <= cur.h && cur.h < last.wl) || (cur.wl > cur.h && last.wl <= last.h && last.h < cur.wl))) {
              spills++;
              if (show && spills <= 12) console.log("spill: link from", m, "at", S.x, S.z, "water", Math.max(last.wl, cur.wl), "ground", Math.min(last.h, cur.h), "river rs", rs[m], "->", rs[down[m]]);
            }
            last = cur;
          }
        }
      }
      m = down[m];
    }
  }
  // ---- lakes ----
  // lake water fills columns within one 128-block cell of the lake's cells; along the outer edge of that region (every STEP blocks), a water
  // column must not stand beside a dry column whose ground is below the water. Lakes above sea level, away from face edges (STEP: blocks
  // between the columns checked along an edge).
  const LC = 128, KL = P.N / LC, t2 = Date.now();
  let lakeEdges = 0, lakeSpills = 0, lakesChecked = 0;
  RV.lakes.forEach((L, k) => {
    if (L.draw <= BF.SEA) return;
    const own = new Set(), region = new Set(), g = (L.cells[0] / (KL * KL)) | 0;
    for (const key of L.cells) {
      const f = (key / (KL * KL)) | 0, cu = ((key / KL) | 0) % KL, cv = key % KL;
      if (f !== g || cu < 3 || cv < 3 || cu >= KL - 3 || cv >= KL - 3) return;
      own.add(cu * KL + cv);
    }
    lakesChecked++;
    for (const c of own) for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) region.add(c + du * KL + dv);
    const inside = { h: 0, wl: 0 };
    for (const c of region) {
      const cu = (c / KL) | 0, cv = c % KL;
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (region.has((cu + du) * KL + cv + dv)) continue;
        for (let s = 2; s < LC; s += STEP) {
          lakeEdges++;
          // the last column inside the region and the first outside, across this side of cell c
          const bu = du ? (du > 0 ? (cu + 1) * LC - 0.5 : cu * LC + 0.5) : cu * LC + s, bv = dv ? (dv > 0 ? (cv + 1) * LC - 0.5 : cv * LC + 0.5) : cv * LC + s;
          const S1 = surf(g, bu, bv); inside.h = S1.h; inside.wl = S1.wl;
          const S2 = surf(g, bu + du, bv + dv);
          if (inside.wl > inside.h && S2.wl <= S2.h && S2.h < inside.wl) {
            lakeSpills++;
            if (show && lakeSpills <= 12) console.log("lake spill: lake", k, "level", L.draw, "at", S2.x, S2.z, "ground", S2.h, "beside water at", inside.wl);
          }
        }
      }
    }
  });
  return { seed, links: link.length, lakes: RV.lakes.length, solveMs: tSolve, loops, uphill, crossings, maxSteps, walked, cols, rises, worst, dry, spills, sections, walkMs: Date.now() - t1,
    lakesChecked, lakeEdges, lakeSpills, lakeMs: Date.now() - t2 };
}

module.exports = { check };
if (require.main === module) {
  const r = check(+(process.argv[2] || 1337), +(process.argv[3] || 100));
  console.log(`seed ${r.seed}: ${r.links} river links, ${r.lakes} lakes (solved in ${r.solveMs} ms); network: ${r.loops} loops, ${r.uphill} uphill steps, ${r.crossings} crossings; longest path to sea ${r.maxSteps} nodes`);
  console.log(`lakes: ${r.lakesChecked} above sea level checked, ${r.lakeSpills} spills in ${r.lakeEdges} columns along their edges; ${r.lakeMs} ms`);
  console.log(`terrain: walked ${r.walked} rivers source to sea, ${r.cols} centre-line columns: ${r.rises} rises (worst ${r.worst}), ${r.dry} dry; ${r.spills} spills in ${r.sections} cross-sections; ${r.walkMs} ms`);
}
