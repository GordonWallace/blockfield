// Fill time of auto maps (synchronous finish()), best of 3 runs each, gen 2 and gen 1: node test/run.js /tmp/at test/automap-time.js
// Each run is its own evaluate: the game fills maps a few ms per frame, and one long synchronous task over many wide maps lets the
// browser hold gigabytes of garbage until it returns.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  for (const gen of [2, 1]) {
    await pg.evaluate(g => BF.newWorld(1337, { gen: g, biomeScale: 1 }), gen);
    const res = { gen };
    for (const k of [16, 128]) {            // 2048 blocks (2 b/px) and 16384 blocks (16 b/px, the widest allowed), both with rivers
      let best = 1e9;
      for (let n = 0; n < 3; n++) {
        const r = await pg.evaluate(([k, n]) => {
          BF.mapview.reset();
          const d = BF.mapview.getAuto(k, n + 1, 0), t0 = performance.now();   // a different zone each run: no cache help between runs
          BF.mapview.finish(d);
          const ms = performance.now() - t0, p0 = performance.now();
          BF.mapview.paint(d);
          return { ms, paint: Math.round(performance.now() - p0) };
        }, [k, n]);
        best = Math.min(best, r.ms);
        res["paint" + k] = r.paint;
      }
      res["w" + k * 128] = Math.round(best);
    }
    console.log(JSON.stringify(res));
  }
};
