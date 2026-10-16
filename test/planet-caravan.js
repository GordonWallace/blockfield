// @ci baseline suite=village timeout=420
// Caravans across a face edge on the planet (spec r14-16): on a generator-4 world (seed 1337), two villages on either side of one of face
// 4's edges, the home one with a merchant. The merchant is sent on a trip to the other village (cargo of one cobblestone, both villages and
// the road pinned) and put on its road 12 blocks short of the edge: it walks over the edge toward the other village (kept in its home's
// frame there), the road's chunks are canonical, its path wear is keyed by canonical cells, and its trip's time left uses the planet
// distance. Put just outside the other village it arrives and deals; heading back it walks toward home. (Caravans only go 600 blocks
// and villages keep several hundred blocks from every edge, so a natural trip never crosses one: the trip here is set up by hand.)
// node test/run.js /tmp/pc test/planet-caravan.js
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); });
  await pg.waitForTimeout(2000);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const wait = (fn, arg, t = 60000) => pg.waitForFunction(fn, arg, { timeout: t, polling: 500 }).then(() => true, () => false);
  // The merchant is only put somewhere once the ground around it has loaded: the simulation is paused (chunks keep loading) from the
  // player's jump until then, or its path search fails on missing chunks and it gives the trip up as lost, as on a slow CI runner.
  const loadedAround = (x, z) => wait(([x, z]) => { const w = BF.world; for (let d = -32; d <= 32; d += 16) for (let e = -32; e <= 32; e += 16) if (!w.isLoaded(x + d, z + e)) return false; return true; }, [x, z], 90000);
  // the closest pair of villages across one of face 4's edges where one of them has merchants (8 villagers or more)
  const pair = await pg.evaluate(() => {
    const P = BF.planet, N = P.N, W = BF.worldgen;
    let best = null;
    for (let s = 0; s < 4; s++) for (let k = 2; k < 60; k++) {
      const along = Math.round(N * k / 62), h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? 300 : N - 300) : along, v = h[1] ? (h[1] < 0 ? 300 : N - 300) : along;
      const a = P.atlas(4, u, v), vs = W.villagesNear(a.x, a.z, 1200);
      for (const p of vs) for (const q of vs) {
        if (P.face(p.x, p.z) !== 4 || P.face(q.x, q.z) === 4 || (p.pop < 8 && q.pop < 8)) continue;
        const d = P.distance(p, q);
        if (!best || d < best.d) best = { d, home: p.pop >= 8 ? p : q, dest: p.pop >= 8 ? q : p };
      }
      if (best && best.d < 1100) break;
    }
    return best && { d: best.d, home: { x: best.home.x, z: best.home.z, y: best.home.y, f: P.face(best.home.x, best.home.z) }, dest: { x: best.dest.x, z: best.dest.z, f: P.face(best.dest.x, best.dest.z) } };
  });
  check(!!pair, "two villages face each other across one of face 4's edges, one with merchants");
  if (!pair) { console.log("FAIL planet-caravan"); return; }
  console.log(`home village on face ${pair.home.f} at ${pair.home.x},${pair.home.z}; the other on face ${pair.dest.f} at ${pair.dest.x},${pair.dest.z}; ${Math.round(pair.d)} blocks apart`);
  await pg.evaluate(h => { BF.player.spawn(h.x + 0.5, h.y + 3, h.z + 0.5); BF.sky.setTime(0.06); }, pair.home);
  check(await wait(h => BF.mobs.list.some(m => m.type === "villager" && m.profession === "merchant" && !m.dead && m.village && m.village.key === Math.round(h.x) + "," + Math.round(h.z)), pair.home, 90000), "the home village's merchant is out");
  // the trip, by hand: one cobblestone to carry, both villages and the road pinned, the merchant 12 blocks short of the edge on its road
  const set = await pg.evaluate(pair => {
    const P = BF.planet, M = BF.merchant, W = BF.worldgen, hk = Math.round(pair.home.x) + "," + Math.round(pair.home.z), dk = Math.round(pair.dest.x) + "," + Math.round(pair.dest.z);
    const m = BF.mobs.list.find(o => o.type === "villager" && o.profession === "merchant" && !o.dead && o.village && o.village.key === hk);
    const st = M._state(m), A = W.villageAt(pair.home.x, pair.home.z), B = W.villageAt(pair.dest.x, pair.dest.z);
    BF.trades.inv.add(m.inv, BF.I.cobblestone, 1);
    st.trip = { id: hk + "#t", home: hk, dest: dk, dx: B.x, dz: B.z, day0: BF.sky.day + BF.sky.time, out: [{ id: BF.I.cobblestone, n: 1, buy: 0, sell: 1 }], back: [], soldN: 0, soldE: 0, boughtN: 0 };
    st.destWg = B; st.cargo = [{ id: BF.I.cobblestone, n: 1, cost: 0 }]; st.stage = "go"; st.nav = {};
    const pinned = BF.villageSim.pin(st.trip.id, A, B);
    // the road in the home village's frame; the point on it 40 blocks short of the face edge
    const bl = P.local(A, B, {}), L = Math.hypot(bl.x - A.x, bl.z - A.z), ux = (bl.x - A.x) / L, uz = (bl.z - A.z) / L;
    let t = 0;
    while (t < L && P.face(A.x + ux * (t + 12), A.z + uz * (t + 12)) === P.face(A.x, A.z) && P.canon(A.x + ux * (t + 12), A.z + uz * (t + 12), {}).f === P.face(A.x, A.z)) t += 2;
    const sx = Math.floor(A.x + ux * t), sz = Math.floor(A.z + uz * t), y = BF.worldgen.heightAt(sx, sz) + 1;
    BF.state.paused = true;
    BF.player.spawn(sx + 0.5, y + 2, sz + 0.5);
    m.position.set(sx + 0.5, y + 0.1, sz + 0.5); m.vel.set(0, 0, 0); m.ai.route = null;
    window.__m = m; window.__start = { x: sx + 0.5, y: y + 0.1, z: sz + 0.5 };
    BF.warp.set(BF.warp.SPEEDS.indexOf(10));   // (10 simulation steps a frame: software rendering is slow)
    const keys = BF.villageSim.pins().get(st.trip.id).keys;
    const canonKeys = keys.every(k => { const [cx, cz] = k.split(",").map(Number), c = P.canonCell(cx * 16 + 8, cz * 16 + 8, {}); return !c.off && c.x === cx * 16 + 8 && c.z === cz * 16 + 8; });
    return { pinned, keys: keys.length, canonKeys, start: [sx, sz], d0: P.distance(m.position, B), left: M.leftSecs(m), legD: P.distance(A, B), speed: ((m.def && m.def.speed) || 0.9) };
  }, pair);
  const ok1 = await loadedAround(set.start[0], set.start[1]);
  await pg.evaluate(() => { const m = window.__m, s = window.__start; m.position.set(s.x, s.y, s.z); m.vel.set(0, 0, 0); m.ai.route = null; BF.merchant._state(m).nav = {}; BF.state.paused = false; });
  check(ok1, "the ground around the merchant's start loaded");
  check(set.pinned && set.canonKeys, `the trip pins both villages and a road of ${set.keys} canonical chunk keys`);
  const want = ((set.d0 + set.legD) * 1.3 / (set.speed * 1.3 * 1.5 * 504) + 0.1) * 1200;   // merchant.js leftSecs on the way out
  check(Math.abs(set.left - want) < 1, `the trip's time left (${Math.round(set.left)} s) comes from planet distances (${Math.round(set.d0)} to go, ${Math.round(set.legD)} back)`);
  // over the edge: still in its home's frame (a margin address there), closer to the other village by the planet's measure
  const crossed = await wait(f => { const m = window.__m, c = BF.planet.canon(m.position.x, m.position.z, {}); return !m.dead && c.f !== f; }, pair.home.f, 120000);
  const r1 = await pg.evaluate(pair => {
    const P = BF.planet, m = window.__m, B = { x: pair.dest.x, z: pair.dest.z }, c = P.canon(m.position.x, m.position.z, {});
    const wear = BF.merchant.wear ? [...(BF.merchant.wear.keys ? BF.merchant.wear.keys() : [])] : [];
    const wearCanon = wear.every(k => { const [x, , z] = k.split(",").map(Number), q = P.canonCell(x, z, {}); return q.x === x && q.z === z; });
    return { frame: P.face(m.position.x, m.position.z), on: c.f, d: P.distance(m.position, B), stage: BF.merchant._state(m).stage, wear: wear.length, wearCanon };
  }, pair);
  check(crossed && r1.on === pair.dest.f && r1.frame === pair.home.f, `the merchant walks over the edge onto face ${r1.on}, kept in its home's frame (face ${r1.frame})`);
  check(r1.d < set.d0 - 8 && r1.stage === "go", `it is closer to the other village by the planet's measure (${Math.round(set.d0)} -> ${Math.round(r1.d)})`);
  check(r1.wearCanon, `its path wear is keyed by canonical cells (${r1.wear} counted)`);
  // near the other village: arrives and deals, then heads home
  await pg.evaluate(pair => {
    const P = BF.planet, m = window.__m, B = BF.worldgen.villageAt(pair.dest.x, pair.dest.z), A = { x: pair.home.x, z: pair.home.z };
    const ab = P.local(B, A, {}), L = Math.hypot(ab.x - B.x, ab.z - B.z), x = Math.floor(B.x + (ab.x - B.x) / L * (B.maxX - B.minX) / 2 + (ab.x - B.x) / L * 8), z = Math.floor(B.z + (ab.z - B.z) / L * (B.maxZ - B.minZ) / 2 + (ab.z - B.z) / L * 8);
    const c = P.local(m.position, { x: x + 0.5, z: z + 0.5 }, {}), y = BF.worldgen.heightAt(x, z) + 1;   // (the merchant keeps its home's frame)
    BF.state.paused = true;
    BF.player.spawn(x + 0.5, y + 2, z + 0.5);
    window.__near = { x, z, at: { x: c.x, y: y + 0.1, z: c.z } };
  }, pair);
  const near = await pg.evaluate(() => window.__near);
  const ok2 = await loadedAround(near.x, near.z);
  await pg.evaluate(() => { const m = window.__m, s = window.__near.at; m.position.set(s.x, s.y, s.z); m.vel.set(0, 0, 0); m.ai.route = null; BF.merchant._state(m).nav = {}; BF.sky.setTime(0.08); BF.state.paused = false; });
  check(ok2, "the ground just outside the other village loaded");
  const arrived = await wait(() => { const st = BF.merchant._state(window.__m); return !window.__m.dead && st.stage !== "go"; }, null, 150000);
  const r2 = await pg.evaluate(() => ({ stage: BF.merchant._state(window.__m).stage, log: BF.merchant.LOG.filter(l => l.kind === "arrive" || l.kind === "lost").map(l => l.kind) }));
  check(arrived && r2.log.includes("arrive") && !r2.log.includes("lost"), `it arrives at the other village (stage ${r2.stage}, log ${r2.log.join(", ")})`);
  const back = await wait(() => BF.merchant._state(window.__m).stage === "back" || !BF.merchant._state(window.__m).trip, null, 150000);
  const h0 = await pg.evaluate(pair => { BF.sky.setTime(0.08); return BF.planet.distance(window.__m.position, pair.home); }, pair);
  await pg.waitForTimeout(15000);
  const h1 = await pg.evaluate(pair => ({ d: BF.planet.distance(window.__m.position, pair.home), stage: BF.merchant._state(window.__m).stage }), pair);
  check(back && (h1.d < h0 - 5 || h1.stage !== "back"), `it heads home after dealing (${Math.round(h0)} -> ${Math.round(h1.d)} blocks from home)`);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? `FAIL planet-caravan (${bad})` : "PASS planet-caravan");
};
