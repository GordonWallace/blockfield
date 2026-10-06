// Far-village explorer (needs js/villagesim.js): node test/run.js /tmp/far test/explorer-far.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(2000);
  console.log(JSON.stringify(await pg.evaluate(async () => {
    const wg = BF.worldgen, vs = wg.villagesNear(0, 0, 300).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const v = vs[0];
    if (!v) return "no village";
    const P = BF.player.position, vd = BF.world.viewDist * BF.CS;
    P.set(v.x + 150, 90, v.z); BF.player.vel && BF.player.vel.set(0, 0, 0);
    const res = { v: [v.x | 0, v.z | 0], viewDist: vd, sim: !!BF.villageSim };
    for (let i = 0; i < 400; i++) { BF.sky.setTime(0.1); BF.world.update(P.x, P.z, 40); BF.mobs.update(0.1); P.y = 120; }
    const key = Math.round(v.x) + "," + Math.round(v.z);
    const vill = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === key);
    res.active = BF.villageSim && BF.villageSim.isActive(key); res.villagers = vill.length; res.dist = vill[0] ? Math.hypot(vill[0].position.x - P.x, vill[0].position.z - P.z) | 0 : null;
    const A = vill.find(m => !m.child);
    if (!A) return res;
    const T = BF.trades, I = BF.I;
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    BF.world.setBlock(tx, ty, tz, BF.B.survey_table); BF.emit("blockPlaced", tx, ty, tz, BF.B.survey_table);
    BF.mobs.setProfession(A, "explorer"); A.xp = 0; A.inv = T.inv.create(); T.inv.add(A.inv, I.emerald, 20); BF.jobs.claim(A);
    T.inv.add(A.inv, BF.maps.filledIdAt(1, A.position.x, A.position.z), 1);
    window.__A = A; window.__P = [P.x, P.z];
    res.start = [A.position.x | 0, A.position.z | 0];
    return res;
  })));
  for (let k = 0; k < 12; k++) {
    console.log(JSON.stringify(await pg.evaluate(() => {
      const A = window.__A; if (!A) return "none";
      const P = BF.player.position;
      for (let i = 0; i < 300; i++) { BF.sky.setTime(0.1); BF.world.update(P.x, P.z, 40); BF.mobs.update(0.1); P.set(window.__P[0], 120, window.__P[1]); }
      const c = BF.explorer.carried(A)[0];
      return { removed: !!A.removed, pos: [A.position.x | 0, A.position.z | 0], stage: A.ex && A.ex.stage, cov: c && +BF.explorer.coverage(c.d).toFixed(3), dist: Math.hypot(A.position.x - P.x, A.position.z - P.z) | 0, avoided: A.ex && Object.keys(A.ex.avoid).length, pickT: A.ex && A.ex.idleS };
    })));
  }
};
