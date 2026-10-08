// Fill time of auto maps (synchronous finish()), best of 3 runs each, gen 2 and gen 1: node test/run.js /tmp/at test/automap-time.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  for (const gen of [2, 1]) {
    const r = await pg.evaluate(g => {
      BF.newWorld(1337, { gen: g, biomeScale: 1 });
      const res = { gen: g };
      for (const k of [16, 128]) {            // 2048 blocks (2 b/px) and 16384 blocks (16 b/px, the widest allowed), both with rivers
        let best = 1e9;
        for (let n = 0; n < 3; n++) {
          BF.mapview.reset();
          const d = BF.mapview.getAuto(k, n + 1, 0), t0 = performance.now();   // a different zone each run: no cache help between runs
          BF.mapview.finish(d);
          best = Math.min(best, performance.now() - t0);
          if (BF.mapview.paint) { const p0 = performance.now(); BF.mapview.paint(d); res["paint" + k] = Math.round(performance.now() - p0); }
        }
        res["w" + k * 128] = Math.round(best);
      }
      return res;
    }, gen);
    console.log(JSON.stringify(r));
  }
};
