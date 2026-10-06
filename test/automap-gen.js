// Auto map generator checks (no screenshots): synchronous fill time, every pixel known, uses the world's own generator version,
// rivers only on maps up to 16 blocks per pixel, and the widest allowed map. node test/run.js /tmp/ag test/automap-gen.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  for (const gen of [2, 1]) {
    const r = await pg.evaluate(g => {
      BF.newWorld(1337, { gen: g, biomeScale: 1 });
      const res = { gen: g };
      for (const k of [16, 128, 1024, 32768]) {   // 2048, 16384 (16 b/px, rivers), 131072 (128 b/px) and 4194304 blocks wide
        const d = BF.mapview.getAuto(k, 3, -2), t0 = performance.now();
        BF.mapview.finish(d);
        const key = "w" + k * 128;
        let unknown = 0, rivers = 0; for (let i = 0; i < d.bio.length; i++) { if (d.bio[i] === 255) unknown++; if (d.bio[i] === 4) rivers++; }
        const i = 300, j = 200, x = Math.floor(d.x0 + (i + .5) * d.scale), z = Math.floor(d.z0 + (j + .5) * d.scale);
        const b = BF.worldgen.biomeAt(x, z);
        res[key] = { ms: Math.round(performance.now() - t0), N: d.N, scale: d.scale, unknown, riverPx: rivers, match: b.id === d.bio[j * d.N + i] || (b.id === 4 && d.scale > 16) };
        BF.mapview.paint(d);
      }
      res.riversBack = BF.rivers && BF.rivers.setEnabled ? (BF.rivers.setEnabled(true), true) : null;
      return res;
    }, gen);
    console.log(JSON.stringify(r));
  }
};
