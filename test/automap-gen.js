// Auto map generator checks (no screenshots): synchronous fill time, every pixel known, pixels from the world's own generator (the
// planet), rivers only on maps up to 16 blocks per pixel, and the widest allowed map (one face of the planet; wider requests are clamped).
// node test/run.js /tmp/ag test/automap-gen.js
// The maps are centred on the zone of the boot world's spawn. (Before r14-24 this ran on flat generators 3, 2 and 1 in turn, with the widest
// map 524,288 blocks; on the planet an auto map is at most one face wide.)
// Each map is its own evaluate: the game fills maps a few ms per frame, and one long synchronous task over several wide maps lets the
// browser hold gigabytes of garbage until it returns.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  const z = await pg.evaluate(() => ({ zx: Math.floor(BF.player.position.x / 128), zz: Math.floor(BF.player.position.z / 128), kMax: BF.mapview.zonesFor(1e9), gen: BF.state.gen }));
  const res = { gen: z.gen, kMax: z.kMax };
  for (const k of [16, 128, z.kMax]) {   // 2048, 16384 (16 b/px, rivers) and one face wide (163840 blocks, 160 b/px): the widest allowed map
    res["w" + k * 128] = await pg.evaluate(([k, zx, zz]) => {
      const d = BF.mapview.getAuto(k, zx, zz), t0 = performance.now();
      BF.mapview.finish(d);
      // unknown pixels: only past a cube corner (the wedge between two faces, or off the atlas), where there is nothing to draw
      let unknown = 0, rivers = 0, unknownOn = 0;
      for (let i = 0; i < d.bio.length; i++) {
        if (d.bio[i] === 4) rivers++;
        if (d.bio[i] !== 255) continue;
        unknown++;
        const px = i % d.N, pz = (i / d.N) | 0;
        if (BF.world.canonXZ(Math.floor(d.x0 + (px + .5) * d.scale), Math.floor(d.z0 + (pz + .5) * d.scale))) unknownOn++;
      }
      const i = 300, j = 200, x = Math.floor(d.x0 + (i + .5) * d.scale), z = Math.floor(d.z0 + (j + .5) * d.scale);
      const b = BF.worldgen.biomeAt(x, z), r = { ms: Math.round(performance.now() - t0), N: d.N, scale: d.scale, unknown, unknownOn, riverPx: rivers, match: b.id === d.bio[j * d.N + i] || (b.id === 4 && d.scale > 16) };
      BF.mapview.paint(d);
      return r;
    }, [k, z.zx, z.zz]);
  }
  Object.assign(res, await pg.evaluate(([zx, zz, kMax]) => {
    const r = { clamped: BF.mapview.getAuto(32768, zx, zz).k === kMax && BF.mapview.zonesFor(4194304) === kMax && kMax === BF.planet.N / 128 };
    const old = BF.items[BF.resolveItem("auto_map_32768_3_-2")];   // an old save's wider map loads as the widest allowed, same centre
    r.oldSave = !!old && old.name === "auto_map_" + BF.mapview.MAX_K + "_3_-2";
    r.riversBack = BF.rivers && BF.rivers.setEnabled ? (BF.rivers.setEnabled(true), true) : null;
    return r;
  }, [z.zx, z.zz, z.kMax]));
  console.log(JSON.stringify(res));
  const bad = [];
  if (res.gen !== 4) bad.push("not a planet");
  // (above 64 blocks per pixel the map samples approximate plateau weights, mapview COARSE_SCALE, so its biome may differ from biomeAt's there)
  for (const k of [16, 128, z.kMax]) { const m = res["w" + k * 128]; if (m.unknownOn || (m.scale <= 64 && !m.match)) bad.push("map " + k * 128 + ": " + m.unknownOn + " unknown pixels on the planet, sample match " + m.match); }
  if (!res.clamped || !res.oldSave) bad.push("wider maps should be clamped to the widest allowed (clamped " + res.clamped + ", old save " + res.oldSave + ")");
  for (const b of bad) console.log("FAIL " + b);
};
