// @ci baseline suite=village timeout=900
// Villager pathfinding (spec r15-05): findPath's integer keys and binary heap (js/mobs.js findPathFast) against the old string-key A*
// with its linear open-list scan (findPathOld). In the nearest village of planet seeds 1 and 3, and on a stretch of ground across one
// of face 4's edges (seed 1337, walked in face 4's frame as a caravan would), random start/goal pairs are searched both ways in the
// same frame of the page (so no block changes in between): plain villagers and golems (tall), goals that are one cell, beds (a
// cell beside them, through house doors), ladders, and areas (within a few blocks, as the job modules ask). Each pair must give routes
// of the same cost, or both none (identical cells are not required: the heap breaks ties between equal f by insertion order, the old
// scan by array position, so a tie can also be a route of another length, a ladder for stairs). As the order differs, one search can
// run out of maxNodes just before the goal where the other reaches it: allowed for at most 2% of pairs, and only when that search
// finds a route given 4x the nodes. Then villagers live their day for a while with BF.debug.pathCompare on, which compares every real
// search the same way. Prints both times and their ratio.
// node test/run.js /tmp/fp test/findpath-compare.js   (PAIRS=n per area, default 700)
module.exports = async (pg) => {
  const PAIRS = +(process.env.PAIRS || 700);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const wait = (fn, arg, t = 90000) => pg.waitForFunction(fn, arg, { timeout: t, polling: 500 }).then(() => true, () => false);
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  const loadedAround = (x, z, r) => wait(([x, z, r]) => { const w = BF.world; for (let d = -r; d <= r; d += 16) for (let e = -r; e <= r; e += 16) if (!w.isLoaded(x + d, z + e)) return false; return true; }, [x, z, r]);
  const total = { pairs: 0, same: 0, equal: 0, lenDiff: 0, cutoff: 0, nullBoth: 0, diff: 0, ms: 0, msOld: 0 };
  const areas = [];
  for (const seed of [1, 3]) {
    await pg.evaluate(s => { BF.newWorld(s, { gen: 4, villages: 10, gameMode: "creative" }); BF.player.start(); }, seed);
    await require("./lib").ready(pg);
    const v = await pg.evaluate(() => {
      const P = BF.planet, p = BF.player.position, v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
      if (!v) return null;
      BF.player.spawn(v.x + 0.5, v.y + 3, v.z + 0.5);
      return { x: v.x, y: v.y, z: v.z, minX: v.minX, maxX: v.maxX, minZ: v.minZ, maxZ: v.maxZ, pop: v.pop };
    });
    check(!!v, `seed ${seed}: a village near spawn ${JSON.stringify(v)}`);
    if (!v) continue;
    check(await loadedAround(v.x, v.z, Math.min(96, Math.max(v.maxX - v.x, v.x - v.minX, v.maxZ - v.z, v.z - v.minZ, 32))), `seed ${seed}: the village's chunks loaded`);
    check(await wait(() => BF.mobs.list.some(m => m.type === "villager"), null), `seed ${seed}: villagers are out`);
    areas.push({ name: `seed ${seed} village`, box: { x0: v.minX, x1: v.maxX, z0: v.minZ, z1: v.maxZ, y: v.y } });
    areas[areas.length - 1].r = await comparePairs(pg, areas[areas.length - 1].box, seed * 7919, PAIRS);
    // live: villagers search for real (beds, doors, jobsites, shops) with the comparison on, for 30 s of play around noon and dusk
    const live = await pg.evaluate(async () => {
      BF.mobs.pathStatsReset(); BF.debug.pathCompare = true;
      for (const t of [0.3, 0.55]) { BF.sky.setTime(t); await new Promise(r => setTimeout(r, 15000)); }
      BF.debug.pathCompare = false;
      const S = BF.debug.pathStats; return { calls: S.calls, same: S.same, equal: S.equal, cutoff: S.cutoff, nullBoth: S.nullBoth, diff: S.diff, ms: S.ms, msOld: S.msOld, diffs: S.diffs.slice(0, 5) };
    });
    console.log(`seed ${seed} live: ${live.calls} searches, ${live.same} identical, ${live.equal} same cost, ${live.nullBoth} none both, ${live.cutoff} out of maxNodes in one only, ${live.diff} different; ${live.ms.toFixed(1)} ms vs old ${live.msOld.toFixed(1)} ms` + (live.diff ? " " + JSON.stringify(live.diffs) : ""));
    check(live.calls > 0, `seed ${seed} live: villagers searched routes (${live.calls})`);
    check(live.diff === 0, `seed ${seed} live: every real search gave a route of the old cost, or none both, or one only ran out of maxNodes first (${live.diff} differ)`);
    check(live.cutoff <= Math.max(2, live.calls * 0.02), `seed ${seed} live: few searches ran out of maxNodes in one only (${live.cutoff})`);
    areas[areas.length - 1].live = live;
  }
  // across a face edge: face 4's +u edge, the ground on both sides walked in face 4's frame (its margin past the edge)
  {
    await pg.evaluate(() => { BF.newWorld(1337, { gen: 4, villages: 10, gameMode: "creative" }); BF.player.start(); });
    await require("./lib").ready(pg);
    const e = await pg.evaluate(() => {
      const P = BF.planet, N = P.N, a = P.atlas(4, N - 24, Math.round(N / 2));
      const y = BF.worldgen.heightAt(a.x, a.z);
      BF.player.spawn(a.x + 24.5, y + 3, a.z + 0.5);   // on the edge
      return { x: Math.floor(a.x) + 24, z: Math.floor(a.z), y, N };
    });
    check(await loadedAround(e.x, e.z, 48), "face edge: the ground on both sides of face 4's edge loaded");
    const r = await comparePairs(pg, { x0: e.x - 40, x1: e.x + 40, z0: e.z - 24, z1: e.z + 24, y: e.y, edge: e.x }, 1337, PAIRS);
    check(r.cross > 0, `face edge: ${r.cross} of the routes cross the edge`);
    areas.push({ name: "face 4 edge", r });
  }
  for (const a of areas) {
    const r = a.r;
    console.log(`${a.name}: ${r.pairs} pairs (${r.tall} golem, ${r.kinds}), ${r.same} identical, ${r.equal} same cost (${r.lenDiff} of them another length), ${r.nullBoth} none both, ${r.cutoff} found by one only within maxNodes, ${r.diff} different; ` +
      `${r.ms.toFixed(1)} ms vs old ${r.msOld.toFixed(1)} ms (${(r.msOld / Math.max(r.ms, 1e-6)).toFixed(1)}x)` + (r.diff ? " " + JSON.stringify(r.diffs) : ""));
    check(r.pairs >= PAIRS * 0.9, `${a.name}: ${r.pairs} start/goal pairs searched`);
    check(r.found > r.pairs * 0.3, `${a.name}: most pairs have a route (${r.found})`);
    check(r.diff === 0, `${a.name}: every pair gives a route of the old cost, or none both, or one only runs out of maxNodes first (${r.diff} differ)`);
    check(r.cutoff <= Math.max(2, r.pairs * 0.02), `${a.name}: few pairs run out of maxNodes in one search only (${r.cutoff})`);
    for (const k of ["pairs", "same", "equal", "lenDiff", "cutoff", "nullBoth", "diff", "ms", "msOld"]) total[k] += r[k];
  }
  console.log(`all: ${total.pairs} pairs, ${total.cutoff} out of maxNodes in one only, ${total.diff} different; findPath ${total.ms.toFixed(1)} ms, findPathOld ${total.msOld.toFixed(1)} ms: ${(total.msOld / Math.max(total.ms, 1e-6)).toFixed(1)}x faster`);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? `FAIL findpath-compare (${bad})` : "PASS findpath-compare");
};

// Random pairs in box (x0..x1, z0..z1 around ground level y), both searches per pair in one evaluate. Returns the tallies.
async function comparePairs(pg, box, seed, n) {
  return pg.evaluate(([box, seed, n]) => {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const M = BF.mobs, N = M.nav, W = BF.world;
    // standing cells: walkable columns near ground level, ladders, and cells beside beds (houses: doors on the way)
    const stand = [], ladders = [], beds = [];
    for (let i = 0; i < 4000 && stand.length < 600; i++) {
      const x = ri(box.x0, box.x1), z = ri(box.z0, box.z1);
      for (let y = box.y + 24; y >= box.y - 24; y--) if (N.walkCell(x, y, z)) { stand.push([x, y, z]); break; }
    }
    for (let x = box.x0; x <= box.x1; x++) for (let z = box.z0; z <= box.z1; z++) for (let y = box.y - 16; y <= box.y + 24; y++) {
      const b = N.blockAt(x, y, z);
      if (b.ladder && !N.blockAt(x, y - 1, z).ladder && ladders.length < 200) ladders.push([x, y, z]);
      if (b.bed && !b.bed.head && beds.length < 200) beds.push({ x, y, z });
    }
    const pick = a => a[Math.floor(rnd() * a.length)];
    const R = { pairs: 0, same: 0, equal: 0, lenDiff: 0, cutoff: 0, nullBoth: 0, diff: 0, found: 0, tall: 0, cross: 0, ms: 0, msOld: 0, diffs: [], kinds: "" };
    const kinds = {};
    if (!stand.length) return R;
    for (let i = 0; i < n; i++) {
      const from = rnd() < 0.15 && ladders.length ? pick(ladders) : pick(stand);
      const kind = (r => r < 0.5 ? "cell" : r < 0.65 && beds.length ? "bed" : r < 0.8 && ladders.length ? "ladder" : "area")(rnd());
      let goal;
      if (kind === "bed") { const b = pick(beds); goal = { x: b.x, z: b.z, at: (x, y, z) => y === b.y && Math.abs(x - b.x) + Math.abs(z - b.z) === 1 }; }
      else if (kind === "area") { const t = pick(stand), r = ri(1, 8); goal = { x: t[0], z: t[2], at: (x, y, z) => Math.abs(x - t[0]) + Math.abs(z - t[2]) <= r }; }
      else { const t = kind === "ladder" ? pick(ladders) : pick(stand); goal = { x: t[0], z: t[2], at: (x, y, z) => x === t[0] && y === t[1] && z === t[2] }; }
      const tall = rnd() < 0.15, max = pick([1200, 1500, 2500, 3000, 6000]);
      kinds[kind] = (kinds[kind] || 0) + 1;
      const t0 = performance.now(), a = M.findPathFast(from[0], from[1], from[2], goal, max, tall), t1 = performance.now(), b = M.findPathOld(from[0], from[1], from[2], goal, max, tall), t2 = performance.now();
      R.pairs++; R.ms += t1 - t0; R.msOld += t2 - t1; if (tall) R.tall++;
      if (a) R.found++;
      if (a && box.edge != null && (from[0] < box.edge) !== (a.length ? a[a.length - 1][0] < box.edge : from[0] < box.edge)) R.cross++;
      if (!a && !b) R.nullBoth++;
      else if (a && b && a.length === b.length && a.every((c, j) => c[0] === b[j][0] && c[1] === b[j][1] && c[2] === b[j][2])) R.same++;
      else if (a && b && M.routeCost(from[0], from[1], from[2], a) === M.routeCost(from[0], from[1], from[2], b)) { R.equal++; if (a.length !== b.length) R.lenDiff++; }
      else if (!a !== !b && (a ? M.findPathOld : M.findPathFast)(from[0], from[1], from[2], goal, max * 4, tall)) R.cutoff++;   // one ran out of maxNodes first: with more it finds one too
      else { R.diff++; if (R.diffs.length < 5) R.diffs.push({ from, kind, goal: [goal.x, goal.z], max, tall, len: a && a.length, lenOld: b && b.length, cost: a && M.routeCost(...from, a), costOld: b && M.routeCost(...from, b) }); }
    }
    R.kinds = Object.entries(kinds).map(([k, v]) => v + " " + k).join(", ");
    return R;
  }, [box, seed, n]);
}
