// @ci integration suite=world soak timeout=900
// Frame cost of mobs living in the world (idea-037): at night with 4 villages running (two pinned trips, as caravans do) and the player in a
// fifth area, once the monsters have built up to their caps, the mob update may cost at most BUDGET ms a frame more than the same scene with
// no wild mobs (the villages, their villagers, golems and stock only). Reports both, and the mob counts.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/mf test/mobs-frame.js
const BUDGET = 2;
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  const setup = await pg.evaluate(() => {
    // a spot in the default world with 4 villages within about 600 blocks, none of them around it
    const best = { x: 2512, z: -2512 };
    const vs = (BF.worldgen.villagesNear(best.x, best.z, 700) || []).filter(v => v.minX != null).sort((a, b) => Math.hypot(a.x - best.x, a.z - best.z) - Math.hypot(b.x - best.x, b.z - best.z)).slice(0, 4);
    if (vs.length < 4) return null;
    const VS = BF.villageSim;
    BF.sky.day = 3; BF.sky.setTime(0.3);   // set the day first: a pin with no trip is dropped a game day after it was first seen
    VS.pin("frame-a", vs[0], vs[1], VS.corridor(vs[0], vs[1]));
    VS.pin("frame-b", vs[2], vs[3], VS.corridor(vs[2], vs[3]));
    BF.player.spawn(best.x + 0.5, BF.worldgen.heightAt(best.x, best.z) + 2, best.z + 0.5);
    if (BF.player.setGameMode) BF.player.setGameMode("creative");
    return { at: [best.x, best.z], dist: vs.map(v => Math.round(Math.hypot(v.x - best.x, v.z - best.z))) };
  });
  ok("found a spot with 4 villages to run", !!setup, setup);
  if (!setup) { console.log("FAILED: 1"); return; }
  for (let i = 0; i < 60; i++) {
    await pg.waitForTimeout(3000);
    const left = await pg.evaluate(() => [...BF.villageSim.keepKeys].filter(k => !BF.world.chunks.has(k)).length + BF.world.queueLength);
    if (left === 0) break;
  }
  const r = await pg.evaluate(async () => {
    const M = BF.mobs, S = BF.sky;
    const run = async n => { let ms = 0; for (let i = 0; i < n; i++) { S.update(0.05); const t0 = performance.now(); M.update(0.05); ms += performance.now() - t0; if (i % 100 === 0) await new Promise(r => setTimeout(r, 0)); } return ms / n; };
    const count = () => { const c = { hostile: 0, wildAnimals: 0, all: 0 }; for (const m of M.list) if (!m.dead && !m.removed) { c.all++; if (m.hostile) c.hostile++; else if (M.isWild(m)) c.wildAnimals++; } return c; };
    S.setTime(0.6);
    // the scene with no wild mobs
    M.spawning = false;
    for (const m of M.list.slice()) if (M.isWild(m)) m.dead = true;
    await run(60);
    const base = Math.min(await run(300), await run(300));
    const baseCount = count();
    // the same scene with wild animals and monsters built up over two game hours of night
    M.spawning = true;
    await run(2400);
    const full = Math.min(await run(300), await run(300), await run(300));
    return { base: +base.toFixed(2), full: +full.toFixed(2), baseCount, fullCount: count(), chunks: BF.world.chunks.size, sim: BF.villageSim.status(), areas: BF.wildlife.areas().map(a => a.kind + " " + a.h + "/" + a.cap) };
  });
  console.log("FRAME " + JSON.stringify(r));
  ok("4 villages ran", /^4 sim/.test(r.sim) || /^[5-9] sim/.test(r.sim), r.sim);
  ok("the mob update costs at most " + BUDGET + " ms a frame more with wild mobs (+" + (r.full - r.base).toFixed(2) + " ms)", r.full - r.base <= BUDGET, r);
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
