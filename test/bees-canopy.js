// @ci integration suite=farming
// Wild bees under their tree (bug-065): node test/run.js /tmp/bc test/bees-canopy.js
// A bee nest hangs on the side of its trunk just under the leaves. Bees fly at a cruising height over the tallest thing near them, and that is
// the top of their own tree: a bee coming out climbed straight into the leaves above the nest, could not get up through them, and hovered
// there, trying again with each new errand. Here, on a test floor high above the ground, an oak with a nest under its leaves and a flower bed
// 10 blocks off: the bees fly out from under the leaves, visit the flowers (the nest's honey rises) and do not hang about under the canopy.
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const A = await pg.evaluate(() => {
    const m = BF.mobs.list.find(v => v.type === "villager" && v.village && !v.dead), V = m.village, X0 = Math.floor(V.x) + 60, Z0 = Math.floor(V.z) - 12;
    BF.player.position.set(X0 + 15, BF.player.position.y, Z0 + 15);
    return { X0, Z0 };
  });
  for (let i = 0; i < 90; i++) {
    if (await pg.evaluate(A => [[-2, -2], [-2, 32], [32, -2], [32, 32], [15, 15]].every(([x, z]) => BF.world.isLoaded(A.X0 + x, A.Z0 + z)), A)) break;
    await pg.waitForTimeout(1000);
  }
  const r = await pg.evaluate(A => {
    const W = BF.world, B = BF.B, BE = BF.bees, P = BF.player.position, { X0, Z0 } = A;
    if (!W.isLoaded(X0 - 2, Z0 - 2) || !W.isLoaded(X0 + 32, Z0 + 32)) return { error: "test floor not loaded" };
    if (B.bee_nest == null) return { error: "no bee nests" };
    if (BF.weather && BF.weather.set) BF.weather.set("clear", 1e6);
    const Y0 = W.heightAt(X0 + 15, Z0 + 15) + 20, N = 30;
    for (let x = -2; x < N + 2; x++) for (let z = -2; z < N + 2; z++) for (let y = Y0 - 1; y < Y0 + 12; y++) W.setBlock(X0 + x, y, Z0 + z, y === Y0 - 1 ? B.grass : 0);
    // an oak 6 high at (8, 8), leaves as worldgen's oakTree (full discs), the nest on its +x side under the leaves; flowers at x 18..20
    const tx = X0 + 8, tz = Z0 + 8, top = Y0 + 6;
    for (let y = Y0; y < top; y++) W.setBlock(tx, y, tz, B.oak_log);
    const disc = (y, r) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if ((dx || dz) && dx * dx + dz * dz <= r * r + 1) W.setBlock(tx + dx, y, tz + dz, B.oak_leaves); };
    disc(top - 3, 2); disc(top - 2, 2); disc(top - 1, 1); disc(top, 1); W.setBlock(tx, top, tz, B.oak_leaves);
    const ny = top - 4;
    W.setBlock(tx + 1, ny, tz, B.bee_nest);
    for (let x = 18; x <= 20; x++) for (let z = 6; z <= 10; z++) W.setBlock(X0 + x, Y0, Z0 + z, B.poppy);
    const h = BE.homeAt(tx + 1, ny, tz);
    if (!h) return { error: "the nest has no record" };
    h.bees = 12; h.honey = 0; h.out = 0; h.rest = [];
    const t0 = performance.now() / 1000;
    let T = 0, under = 0, samples = 0, maxOut = 0;
    const canopy = b => Math.hypot(b.x - tx - 0.5, b.z - tz - 0.5) < 3.2 && b.y > Y0 + 0.5 && b.y < top - 2.5 && b.mode !== "land";
    const step = h => { BF.state.time += h; BF.sky.setTime(0.2); BF.mobs.update(h); W.tickSim && W.tickSim(); P.set(X0 + 15, Y0 + 14, Z0 + 15); T += h; };
    const sn = BF.simNow;
    BF.simNow = () => T;   // the bees' clock: this loop's time
    try { while (T < 240) {
      step(0.05);
      const out = BE.out(h);
      maxOut = Math.max(maxOut, out.length);
      if (T > 60 && Math.round(T * 20) % 10 === 0) { samples += out.length; under += out.filter(canopy).length; }
    } } finally { BF.simNow = sn; }
    return { honey: h.honey, maxOut, under, samples, frac: samples ? +(under / samples).toFixed(3) : null };
  }, A);
  console.log(JSON.stringify(r));
  let fails = 0;
  const fail = s => { console.log("FAIL " + s); fails++; };
  if (r.error) fail(r.error);
  else {
    if (!r.maxOut) fail("no bees came out");
    if (r.honey < 2) fail("the nest's honey only reached " + r.honey + ": the bees are not getting to the flowers");
    if (r.frac > 0.4) fail("bees were hovering under the canopy " + Math.round(r.frac * 100) + "% of the time");
  }
  console.log(fails ? "bees-canopy: " + fails + " failures" : "bees-canopy: ok");
};
