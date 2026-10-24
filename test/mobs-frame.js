// @ci integration suite=world soak timeout=900 hosts=worker,server
// Frame cost of mobs living in the world (idea-037): at night with 4 villages running (two pinned trips, as caravans do) and the player in a
// fifth area, once the monsters have built up to their caps, the mob update may cost at most BUDGET ms a frame more than the same scene with
// no wild mobs (the villages, their villagers, golems and stock only). Reports both, and the mob counts.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/mf test/mobs-frame.js [--host page|worker|server]
// The mobs and villages are the simulation's: measured where it is (spec r15-43), with the page's body held out of it (the player moves there).
const BUDGET = 2;
const lib = require('./lib');
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await lib.alone(pg, true);
  const setup = await lib.sim(pg, () => {
    // a spot near the spawn with 4 villages within about 600 blocks, none of them around it (generator 3 used 2512, -2512 of seed 1337)
    const D = (a, b) => BF.planet.distance(a, b), s0 = BF.spawnPoint || BF.player.position, sp = { x: Math.floor(s0.x), z: Math.floor(s0.z) };
    let best = null, vs = [];
    for (let r = 0; !best && r <= 4000; r += 250) for (let k = 0, n = Math.max(1, Math.round(r / 125)); !best && k < n; k++) {
      const p = { x: Math.round(sp.x + r * Math.cos(2 * Math.PI * k / n)), z: Math.round(sp.z + r * Math.sin(2 * Math.PI * k / n)) };
      const near = (BF.worldgen.villagesNear(p.x, p.z, 700) || []).filter(v => v.minX != null).sort((a, b) => D(a, p) - D(b, p));
      if (near.length >= 4 && D(near[0], p) > 200 && BF.worldgen.heightAt(p.x, p.z) > BF.worldgen.waterLevelAt(p.x, p.z)) { best = p; vs = near.slice(0, 4); }
    }
    if (!best) return null;
    const VS = BF.villageSim;
    BF.sky.day = 3; BF.sky.setTime(0.3);   // set the day first: a pin with no trip is dropped a game day after it was first seen
    VS.pin("frame-a", vs[0], vs[1], VS.corridor(vs[0], vs[1]));
    VS.pin("frame-b", vs[2], vs[3], VS.corridor(vs[2], vs[3]));
    BF.player.spawn(best.x + 0.5, BF.worldgen.heightAt(best.x, best.z) + 2, best.z + 0.5);
    if (BF.player.setGameMode) BF.player.setGameMode("creative");
    return { at: [best.x, best.z], dist: vs.map(v => Math.round(D(v, best))) };
  });
  ok("found a spot with 4 villages to run", !!setup, setup);
  if (!setup) { console.log("FAILED: 1"); await lib.alone(pg, false); return; }
  for (let i = 0; i < 60; i++) {
    await pg.waitForTimeout(3000);
    const left = await lib.sim(pg, () => [...BF.villageSim.keepKeys].filter(k => !BF.world.chunks.has(k)).length + BF.world.queueLength);
    if (left === 0) break;
  }
  const r = await lib.sim(pg, async () => {
    const M = BF.mobs, S = BF.sky;
    const run = async n => { let ms = 0; for (let i = 0; i < n; i++) { S.advance(0.05); const t0 = performance.now(); M.update(0.05); ms += performance.now() - t0; if (i % 100 === 0) await new Promise(r => setTimeout(r, 0)); } return ms / n; };
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
  await lib.alone(pg, false);
  console.log("FRAME " + JSON.stringify(r));
  ok("4 villages ran", /^4 sim/.test(r.sim) || /^[5-9] sim/.test(r.sim), r.sim);
  ok("the mob update costs at most " + BUDGET + " ms a frame more with wild mobs (+" + (r.full - r.base).toFixed(2) + " ms)", r.full - r.base <= BUDGET, r);
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
