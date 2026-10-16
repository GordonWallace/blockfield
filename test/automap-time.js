// Fill time of auto maps (synchronous finish()), best of 3 runs each, on the planet: node test/run.js /tmp/at test/automap-time.js
// (Before r14-24 this timed flat generators 2 and 1.) Maps are centred near the boot world's spawn, in a different zone each run.
// Each run is its own evaluate: the game fills maps a few ms per frame, and one long synchronous task over many wide maps lets the
// browser hold gigabytes of garbage until it returns.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  const z = await pg.evaluate(() => ({ zx: Math.floor(BF.player.position.x / 128), zz: Math.floor(BF.player.position.z / 128), kMax: BF.mapview.zonesFor(1e9), gen: BF.state.gen }));
  const res = { gen: z.gen };
  for (const k of [16, z.kMax]) {           // 2048 blocks (2 b/px, rivers) and one face wide (160 b/px, the widest allowed)
    let best = 1e9;
    for (let n = 0; n < 3; n++) {
      const r = await pg.evaluate(([k, zx, zz]) => {
        BF.mapview.reset();
        const d = BF.mapview.getAuto(k, zx, zz), t0 = performance.now();   // a different zone each run: no cache help between runs
        BF.mapview.finish(d);
        const ms = performance.now() - t0, p0 = performance.now();
        BF.mapview.paint(d);
        return { ms, paint: Math.round(performance.now() - p0) };
      }, [k, z.zx + n + 1, z.zz]);
      best = Math.min(best, r.ms);
      res["paint" + k] = r.paint;
    }
    res["w" + k * 128] = Math.round(best);
  }
  console.log(JSON.stringify(res));
};
