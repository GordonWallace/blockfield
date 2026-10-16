// @ci baseline suite=village timeout=300
// Village loading on the planet (spec r14-15): on a generator-4 world (seed 1337), the player starts on face 4 next to an edge, with a
// village of the neighbouring face beyond it, and walks across the edge toward the village: it is simulated once its box is within 200 blocks
// (measured on the planet) and its villagers come out; walking back, it keeps running at 210 (DROP 216) and stops past it (countdown or
// unload). The village's edge distance reads the same from a point and from that point's margin address (a villager kept in its village's
// frame past an edge), and a trip corridor between villages on two faces is made of canonical chunk keys joining both villages.
// node test/run.js /tmp/pvl test/planet-village-loading.js
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); });
  await pg.waitForTimeout(2000);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const wait = (fn, arg, t = 40000) => pg.waitForFunction(fn, arg, { timeout: t }).then(() => true, () => false);
  // a village on another face, nearest to one of face 4's edges, and the walk line toward it from face 4 (face 4's frame, perpendicular to
  // the edge), sampled every 4 blocks with the planet edge distance of each canonical point
  const plan = await pg.evaluate(() => {
    const P = BF.planet, N = P.N, W = BF.worldgen, S = BF.villageSim;
    for (let s = 0; s < 4; s++) for (let k = 2; k < 60; k++) {
      const along = Math.round(N * k / 62), h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? 300 : N - 300) : along, v = h[1] ? (h[1] < 0 ? 300 : N - 300) : along;
      const a = P.atlas(4, u, v), vs = W.villagesNear(a.x, a.z, 1200);
      const other = vs.filter(q => P.face(q.x, q.z) !== 4), mine = vs.filter(q => P.face(q.x, q.z) === 4);
      if (!other.length || !mine.length) continue;
      const V = other.sort((x, y) => P.distance(a, x) - P.distance(a, y))[0], vl = P.local(a, V, {});
      // start 40 blocks inside face 4 on the line through the village centre perpendicular to the edge, walk out along h
      const sx = h[0] ? (h[0] < 0 ? P.atlas(4, 40, 0).x : P.atlas(4, N - 41, 0).x) : vl.x, sz = h[1] ? (h[1] < 0 ? P.atlas(4, 0, 40).z : P.atlas(4, 0, N - 41).z) : vl.z;
      const pts = [];
      for (let t = 0; t < 1200; t += 4) {
        const c = P.canon(sx + h[0] * t, sz + h[1] * t, {});
        const d = S._edgeDist(V, c.x, c.z);
        pts.push({ x: c.x, z: c.z, f: c.f, d, t });
        if (d < 120) break;
      }
      const W4 = mine.sort((x, y) => P.distance(V, x) - P.distance(V, y))[0];
      return { key: Math.round(V.x) + "," + Math.round(V.z), V: { x: V.x, z: V.z, f: P.face(V.x, V.z) }, side: s, pts, other: { x: W4.x, z: W4.z } };
    }
    return null;
  });
  check(!!plan, "a village on a neighbouring face lies beyond one of face 4's edges");
  if (!plan) { console.log("FAIL planet-village-loading"); return; }
  const first = plan.pts[0], cross = plan.pts.find(p => p.f !== 4), at = d => plan.pts.find(p => p.d <= d);
  console.log(`village ${plan.key} on face ${plan.V.f}; start on face ${first.f} ${Math.round(first.d)} blocks from its box; the edge is crossed ${cross && cross.t} blocks in`);
  check(first.f === 4 && !!cross && first.d > 300, "the walk starts on face 4, far from the village, and crosses the edge on the way");
  const tp = p => pg.evaluate(p => { BF.player.spawn(p.x + 0.5, BF.worldgen.heightAt(p.x, p.z) + 3, p.z + 0.5); }, p);
  // walking across the edge: not simulated at 230, simulated at 195
  for (const p of plan.pts) { if (p.d < 230) break; if (p.t % 40 === 0) { await tp(p); await pg.waitForTimeout(150); } }
  await tp(at(230)); await pg.waitForTimeout(3000);
  check(!(await pg.evaluate(k => BF.villageSim.isActive(k), plan.key)), "past the edge, 230 blocks from the village's box, it is not simulated");
  await tp(at(195));
  check(await wait(k => BF.villageSim.isActive(k), plan.key), "195 blocks from its box (measured on the planet) the village is simulated");
  check(await wait(k => BF.mobs.list.some(m => m.type === "villager" && m.village && m.village.key === k && !m.dead), plan.key, 60000), "its villagers come out");
  // walking back toward the edge: still running at 210, stops past 216
  const back = plan.pts.slice().reverse().find(p => p.d >= 210);
  await tp(back); await pg.waitForTimeout(3000);
  check(await pg.evaluate(k => BF.villageSim.isActive(k), plan.key), `walking back, ${Math.round(back.d)} blocks from its box it keeps running (DROP 216)`);
  const far = plan.pts.slice().reverse().find(p => p.d >= 260);
  await tp(far);
  check(await wait(k => !BF.villageSim.isActive(k) || BF.villageSim.countdown(k) !== null, plan.key), `${Math.round(far.d)} blocks from its box (on face ${far.f}) it counts down or unloads`);
  // a point and its margin address measure the same, and a trip corridor across the edge is canonical and joins both villages
  const r = await pg.evaluate(plan => {
    const P = BF.planet, S = BF.villageSim, V = BF.worldgen.villageAt(plan.V.x, plan.V.z), O = BF.worldgen.villageAt(plan.other.x, plan.other.z);
    const p = plan.pts[0], m = P.local(V, p, {});   // the start point (face 4) as a margin address of the village's face
    const keys = S.corridor(V, O), ok = keys.every(k => { const [cx, cz] = k.split(",").map(Number), c = P.canonCell(cx * 16 + 8, cz * 16 + 8, {}); return !c.off && c.x === cx * 16 + 8 && c.z === cz * 16 + 8; });
    const ck = (x, z) => Math.floor(x / 16) + "," + Math.floor(z / 16), d = P.distance(V, O);
    return { a: S._edgeDist(V, p.x, p.z), b: S._edgeDist(V, m.x, m.z), marginF: P.face(m.x, m.z), n: keys.length, ok, ends: keys.includes(ck(V.x, V.z)) && keys.includes(ck(O.x, O.z)), d,
      walk: S.walkSecs({ position: { x: V.x, z: V.z } }, [{ x: O.x, z: O.z }]) };
  }, plan);
  check(r.marginF === plan.V.f && Math.abs(r.a - r.b) < 1e-6, `the village's edge distance from a point on face 4 (${r.a.toFixed(1)}) and from its margin address in face ${r.marginF}'s frame (${r.b.toFixed(1)}) agree`);
  check(r.ok && r.ends && r.n >= 3 * r.d / 16 && r.n <= 9 * (r.d / 4 + 2), `a corridor between villages on faces ${plan.V.f} and 4 (${Math.round(r.d)} blocks) is ${r.n} canonical chunk keys joining both`);
  check(Math.abs(r.walk - r.d * 1.3 / 0.9) < 1, `walkSecs across the edge uses the planet distance (${r.walk.toFixed(0)} s)`);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? `FAIL planet-village-loading (${bad})` : "PASS planet-village-loading");
};
