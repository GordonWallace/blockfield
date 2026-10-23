// @ci integration suite=village timeout=900
// Mob grids (spec r15-06): the grids separate() and nearestMob() read are built by a cheaper builder (cell arrays kept between updates,
// canon() only near a face edge). Runs 2,000 steps of seed 3 at its nearest village, and 400 at a face edge that turns (face 0 to 2) with
// mobs on both sides; every step builds the grids with the pre-r15-06 builder and the new one and compares the cells (as sets of mobs)
// and, for every mob, separate()'s push and nearestMob() at 8, 16 and 32 blocks. Reports the time of both builders, and of the lookups on each.
// node test/run.js /tmp/mg test/mobgrid-compare.js
module.exports = async (pg) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await pg.evaluate(async () => {
    await BF.prepareWorld(3); BF.newWorld(3); BF.player.start();
    if (BF.player.setGameMode) BF.player.setGameMode("creative");
    const v = BFT.villages(6000)[0];
    window.__vil = { x: v.x, z: v.z };
    BF.player.spawn(v.x + 0.5, BF.worldgen.heightAt(v.x, v.z) + 40, v.z + 0.5);
    if (BF.player.setFlying) BF.player.setFlying(true);
    // the in-page step and the comparison
    window.__step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const G = BF.mobs.grid, R = [[8, o => true], [16, o => o.hostile], [32, o => o.type === "villager" || !o.hostile]];
    const live = () => BF.mobs.list.filter(m => !m.dead && !m.removed);
    const snap = (ref, T) => {
      G.ref(ref);
      const t0 = performance.now();
      G.build();
      const t1 = performance.now(), ms = live(), sep = [], near = [];
      for (const m of ms) { sep.push(G.separate(m, 0.05)); for (const [r, p] of R) near.push(G.nearest(m, r, p)); }
      const w = ref ? "ref" : "fast";
      T[w] += t1 - t0; T[w + "Look"] += performance.now() - t1;
      const c = G.cells(), sets = g => new Map(g.map(([k, a]) => [k, new Set(a)]));
      return { sep, near, cells: { sep: sets(c.sep), chunk: sets(c.chunk) } };
    };
    const same = (a, b) => { if (a.size !== b.size) return false; for (const [k, s] of a) { const t = b.get(k); if (!t || t.size !== s.size) return false; for (const o of s) if (!t.has(o)) return false; } return true; };
    window.__compare = (steps, T) => {
      const out = { steps: 0, bad: 0, first: null, mobs: 0, edgeMobs: 0 };
      for (let i = 0; i < steps; i++) {
        const a = snap(true, T), b = snap(false, T);
        let ok = same(a.cells.sep, b.cells.sep) && same(a.cells.chunk, b.cells.chunk) && a.near.length === b.near.length;
        for (let j = 0; ok && j < a.sep.length; j++) if (a.sep[j][0] !== b.sep[j][0] || a.sep[j][1] !== b.sep[j][1]) ok = false;
        for (let j = 0; ok && j < a.near.length; j++) if (a.near[j] !== b.near[j]) ok = false;
        if (!ok) { out.bad++; if (!out.first) out.first = { step: i, cells: [a.cells.sep.size, b.cells.sep.size, a.cells.chunk.size, b.cells.chunk.size] }; }
        out.steps++; out.mobs = Math.max(out.mobs, a.sep.length);
        let e = 0; for (const m of live()) { const c = BF.planet.canon(m.position.x, m.position.z); if (c.x !== m.position.x || Math.abs(c.u - BF.planet.N / 2) > BF.planet.N / 2 - 48 || Math.abs(c.v - BF.planet.N / 2) > BF.planet.N / 2 - 48) e++; }
        out.edgeMobs = Math.max(out.edgeMobs, e);
        __step(0.05);   // (the game's own update builds with the new builder)
      }
      return out;
    };
  });
  // load the village and let it come out, as test/bakechain.js does
  for (let i = 0; i < 40; i++) {
    const left = await pg.evaluate(() => { const { x, z } = __vil; for (let k = 0; k < 20; k++) BF.world.update(x, z, 30); for (let k = 0; k < 20; k++) __step(0.05); return BF.world.queueLength; });
    if (!left && i > 10) break;
  }
  await pg.evaluate(() => { const { x, z } = __vil; for (let i = 0; i < 1200; i++) { if (i % 10 === 0) BF.world.update(x, z, 30); __step(0.05); } });
  const T = { ref: 0, fast: 0, refLook: 0, fastLook: 0 };
  let r = { steps: 0, bad: 0, mobs: 0 };
  for (let k = 0; k < 10; k++) {   // 10 x 200 steps (one evaluate each, so the page stays responsive)
    const q = await pg.evaluate(T => { const o = __compare(200, T); if (BF.world.update) BF.world.update(__vil.x, __vil.z, 3); return { o, T }; }, T);
    Object.assign(T, q.T);
    r.steps += q.o.steps; r.bad += q.o.bad; r.mobs = Math.max(r.mobs, q.o.mobs); if (q.o.first && !r.first) r.first = q.o.first;
  }
  console.log(`seed 3 village: ${r.steps} steps, up to ${r.mobs} mobs; building the grids ${(T.ref / r.steps).toFixed(3)} ms/step before r15-06, ${(T.fast / r.steps).toFixed(3)} now; every mob's separate + 3 nearestMob ${(T.refLook / r.steps).toFixed(3)} ms/step before, ${(T.fastLook / r.steps).toFixed(3)} now`);
  check(r.steps === 2000 && r.bad === 0, `seed 3: grids and separate/nearestMob identical on all ${r.steps} steps` + (r.first ? " (first difference " + JSON.stringify(r.first) + ")" : ""));

  // a face edge that turns (face 0, edge 2 to face 2), with cows and zombies on both sides of it, some kept in face 0's frame
  const e = await pg.evaluate(async () => {
    const P = BF.planet, N = P.N, W = BF.world;
    const at = (k, j) => P.atlas(0, N / 2 + j, -1 - k);   // k < 0 on face 0, k >= 0 across the edge (through face 0's margin)
    const c = at(-6, 0);
    BF.player.teleport(c.x + 0.5, Math.max(BF.worldgen.heightAt(c.x, c.z), BF.SEA) + 30, c.z + 0.5); BF.player.setFlying(true);
    for (let i = 0; i < 160; i++) {
      await new Promise(r => setTimeout(r, 250));
      let ok = true;
      for (const [k, j] of [[-24, -16], [-24, 16], [24, -16], [24, 16], [0, 0]]) { const a = at(k, j), ch = W.chunkAt(a.x, a.z); if (!ch || ch.mesh === undefined) ok = false; }
      if (ok) break;
    }
    let top = BF.SEA;
    for (let k = -14; k <= 14; k++) for (let j = -9; j <= 9; j++) { const a = at(k, j); top = Math.max(top, W.heightAt(a.x, a.z)); }
    const y = top + 3;
    for (let k = -15; k <= 15; k++) for (let j = -10; j <= 10; j++) {
      const a = at(k, j), rim = Math.abs(k) > 14 || Math.abs(j) > 9;
      for (let yy = y - 1; yy < y + 6; yy++) { const want = yy === y - 1 || rim ? BF.B.stone : 0; if (W.getBlock(a.x, yy, a.z) !== want) W.setBlock(a.x, yy, a.z, want); }
    }
    BF.mobs.spawning = false;
    let n = 0;
    for (let k = -12; k <= 12; k += 2) for (let j = -8; j <= 8; j += 4) { const a = at(k, j); if (BF.mobs.spawn((k + j) % 4 ? "cow" : "zombie", a.x + 0.5, y, a.z + 0.5)) n++; }
    for (let i = 0; i < 4; i++) { const a = at(1, i * 2 - 3); if (BF.mobs.spawn("sheep", a.x + 0.3, y, a.z + 0.6)) n++; if (BF.mobs.spawn("sheep", a.x + 0.6, y, a.z + 0.4)) n++; }   // crowded: they push apart
    window.__vil = { x: c.x, z: c.z };
    return { n, y };
  });
  const T2 = { ref: 0, fast: 0, refLook: 0, fastLook: 0 };
  const q = await pg.evaluate(T => ({ o: __compare(400, T), T }), T2);
  console.log(`face edge: ${q.o.steps} steps, ${e.n} mobs placed, up to ${q.o.mobs} mobs, up to ${q.o.edgeMobs} within 48 blocks of an edge or in another face's frame`);
  check(q.o.edgeMobs >= 10, "mobs near the edge take the canonical path");
  check(q.o.bad === 0, `face edge: grids and separate/nearestMob identical on all ${q.o.steps} steps` + (q.o.first ? " (first difference " + JSON.stringify(q.o.first) + ")" : ""));
  if (bad) console.log("FAILED: " + bad);
};
