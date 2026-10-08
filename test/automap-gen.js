// Auto map generator checks (no screenshots): synchronous fill time, every pixel known, uses the world's own generator version,
// rivers only on maps up to 16 blocks per pixel, and the widest allowed map (wider requests are clamped). node test/run.js /tmp/ag test/automap-gen.js
// Each map is its own evaluate: the game fills maps a few ms per frame, and one long synchronous task over several wide maps lets the
// browser hold gigabytes of garbage until it returns.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  for (const gen of [3, 2, 1]) {
    await pg.evaluate(g => BF.newWorld(1337, { gen: g, biomeScale: 1 }), gen);
    const res = { gen };
    for (const k of [16, 128, 4096]) {   // 2048, 16384 (16 b/px, rivers) and 524288 blocks wide (512 b/px): the widest allowed map
      res["w" + k * 128] = await pg.evaluate(k => {
        const d = BF.mapview.getAuto(k, 3, -2), t0 = performance.now();
        BF.mapview.finish(d);
        let unknown = 0, rivers = 0; for (let i = 0; i < d.bio.length; i++) { if (d.bio[i] === 255) unknown++; if (d.bio[i] === 4) rivers++; }
        const i = 300, j = 200, x = Math.floor(d.x0 + (i + .5) * d.scale), z = Math.floor(d.z0 + (j + .5) * d.scale);
        const b = BF.worldgen.biomeAt(x, z), r = { ms: Math.round(performance.now() - t0), N: d.N, scale: d.scale, unknown, riverPx: rivers, match: b.id === d.bio[j * d.N + i] || (b.id === 4 && d.scale > 16) };
        BF.mapview.paint(d);
        return r;
      }, k);
    }
    Object.assign(res, await pg.evaluate(() => {
      const r = { clamped: BF.mapview.getAuto(32768, 3, -2).k === BF.mapview.MAX_K && BF.mapview.zonesFor(4194304) === BF.mapview.MAX_K };
      const old = BF.items[BF.resolveItem("auto_map_32768_3_-2")];   // an old save's wider map loads as the widest allowed, same centre
      r.oldSave = !!old && old.name === "auto_map_" + BF.mapview.MAX_K + "_3_-2";
      r.riversBack = BF.rivers && BF.rivers.setEnabled ? (BF.rivers.setEnabled(true), true) : null;
      return r;
    }));
    console.log(JSON.stringify(res));
    if (!res.clamped || !res.oldSave) console.log('FAIL gen ' + gen + ': wider maps should be clamped to the widest allowed (clamped ' + res.clamped + ', old save ' + res.oldSave + ')');
  }
};
