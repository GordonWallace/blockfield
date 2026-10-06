// Auto map generator checks (no screenshots): synchronous fill time, every pixel known, uses the world's own generator version.
// node test/run.js /tmp/ag test/automap-gen.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  for (const gen of [2, 1]) {
    const r = await pg.evaluate(g => {
      BF.newWorld(1337, { gen: g, biomeScale: 1 });
      const res = { gen: g };
      for (const k of [16, 128]) {
        const d = BF.mapview.getAuto(k, 3, -2), t0 = performance.now();
        BF.mapview.finish(d);
        res["ms" + k] = Math.round(performance.now() - t0);
        let unknown = 0; for (let i = 0; i < d.bio.length; i++) if (d.bio[i] === 255) unknown++;
        res["unknown" + k] = unknown; res["scale" + k] = d.scale; res["x0_" + k] = d.x0;
        // spot check against the generator
        const i = 300, j = 200, b = BF.worldgen.biomeAt(Math.floor(d.x0 + (i + .5) * d.scale), Math.floor(d.z0 + (j + .5) * d.scale));
        res["match" + k] = b.id === d.bio[j * d.N + i] && Math.round(b.height) === d.hgt[j * d.N + i];
        BF.mapview.paint(d);
      }
      res.sample = JSON.stringify(Array.from(BF.mapview.getAuto(16, 3, -2).bio.slice(0, 8)));
      return res;
    }, gen);
    console.log(JSON.stringify(gen === 2 ? { ...r } : r));
  }
};
