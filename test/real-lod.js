// @ci integration suite=world
// The realistic look's plant levels of detail (js/real/lod.js, docs/REALISTIC_CONTRACT.md section 4): with the look off the module
// is not there; with it on it takes over BF.real.flora.place / remove, batches a chunk's flora records by region, builds each level's
// geometry from the registry, bakes the impostor atlas, picks levels by distance, and lets everything go again on remove. The species
// here are the test's own (cones), so it holds whatever the registry ships. The distant rings must still build with the look on.
// node test/run.js /tmp/rl test/real-lod.js
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what, got) => { if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); };
  const off = await pg.evaluate(() => ({ on: !!(BF.real && BF.real.on), lod: !!(BF.real && BF.real.lod) }));
  check(!off.on && !off.lod, "look off by default: no realistic module", off);

  await pg.evaluate(() => localStorage.setItem("bf.look", "real"));
  await pg.reload();
  await pg.waitForFunction(() => window.BF && BF.real && BF.real.on && BF.real.lod && BF.world && BF.world.chunks.size > 0 && !BF.preparing, null, { timeout: 180000 });
  await pg.waitForTimeout(3000);

  const placed = await pg.evaluate(() => {
    const T = THREE, R = BF.real, L = R.lod;
    L.config.fixedScale = true; L.config.scale = 1; L.config.budgetMs = 50;
    const first = BF.B.oak_log, cover = BF.B.fern;
    const mat = c => R.lit(new T.MeshLambertMaterial({ color: c }), { light: "cell" });
    let bm, fm, cm;
    window.__builds = [];
    R.assets.species.push({ id: "test_cone", kind: "tree", log: "oak_log", variants: 2, height: [8, 8],
      build(rand, detail) {
        __builds.push(detail);
        const seg = [12, 7, 4][detail], bark = new T.CylinderGeometry(0.2, 0.4, 3, seg), fol = new T.ConeGeometry(2.5 + rand(), 6, seg * 2);
        bark.translate(0, 1.5, 0); fol.translate(0, 5, 0);
        return { bark, foliage: fol };
      },
      barkMaterial: () => bm || (bm = mat(0x5a4028)), foliageMaterial: () => fm || (fm = mat(0x3f7a35)) });
    R.assets.cover.push({ id: "test_tuft", block: "fern", build(rand, detail) { const g = new T.ConeGeometry(0.4, 0.7, [8, 5, 3][detail]); g.translate(0, 0.35, 0); return g; },
      material: () => cm || (cm = mat(0x4f9a3a)) });
    // the test's two entries draw oak logs and ferns here, whatever the registry and the foundation's resolver hold
    const tree = R.assets.species[R.assets.species.length - 1], tuft = R.assets.cover[R.assets.cover.length - 1];
    R.flora.resolve = block => (block === first ? tree : block === cover ? tuft : null);
    // plants in front of the camera, handed over chunk by chunk as js/world.js does (x and z from the chunk's corner): trees from 8
    // to 400 blocks away (every level and the impostors), tufts near
    const cam = BF.camera, d = new T.Vector3(); cam.getWorldDirection(d); d.y = 0; d.normalize();
    const p = cam.position, byChunk = new Map(), keys = [];
    const add = (x, z, kind, sp, h, seed) => {
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16), k = "t" + cx + "," + cz;
      if (!byChunk.has(k)) byChunk.set(k, { cx, cz, F: [] });
      byChunk.get(k).F.push(x - cx * 16, p.y - 8, z - cz * 16, kind, sp, h, seed, 15);
    };
    let n = 0;
    for (let i = 0; i < 160; i++) { const t = 8 + i * 2.45, s = ((i * 7) % 11 - 5) * 1.5; add(p.x + d.x * t - d.z * s, p.z + d.z * t + d.x * s, 0, first, 6 + i % 5, (i * 0.137) % 1); n++; }
    for (let i = 0; i < 60; i++) { add(p.x + d.x * (3 + i * 0.5) - d.z * (i % 7 - 3), p.z + d.z * (3 + i * 0.5) + d.x * (i % 7 - 3), 2, cover, 1, (i * 0.071) % 1); n++; }
    for (const [k, c] of byChunk) {
      c.F.push(0, p.y, 0, 0, BF.B.bedrock, 5, 0.5, 15);   // (a block nothing in the registry draws: skipped, not thrown on)
      R.flora.place(k, c.cx * 16, c.cz * 16, new Float32Array(c.F));
      keys.push(k);
    }
    window.__keys = keys;
    return { n, takeover: R.flora.place === L.place && R.flora.remove === L.remove };
  });
  check(placed.takeover, "the module is the flora placer");
  await pg.waitForFunction(() => { const s = BF.real.lod.stats(); return s.plants > 0 && s.pending === 0 && s.batches > 0; }, null, { timeout: 120000, polling: 250 }).catch(() => {});
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(() => {
    const L = BF.real.lod, s = L.stats(), tree = [...L.models.values()].find(m => m.kind === 0), bands = tree && L.bandsOf(tree);
    const mine = BF.scene.children.filter(c => c.userData.rlod);
    return { s, bands, levels: tree && tree.lods.map(l => !!l), imp: tree && tree.imp, atlas: L.impostor.atlas ? [L.impostor.atlas.image.width, L.impostor.atlas.image.height] : null,
      direct: mine.length, cards: mine.filter(c => !c.isInstancedMesh).length, builds: __builds.slice().sort().join("") };
  });
  console.log("stats:", JSON.stringify(r.s));
  check(r.s.plants === placed.n, "every record with a registry entry is kept", [r.s.plants, placed.n]);
  check(r.s.pending === 0 && r.s.batches > 0 && r.direct === r.s.batches, "batches built, all direct scene children", [r.s.pending, r.s.batches, r.direct]);
  check(r.levels && r.levels.every(Boolean), "all three mesh levels of a tree built", r.levels);
  check(r.bands && r.bands[3] && r.bands[0][1] === r.bands[1][0] && r.bands[1][1] === r.bands[2][0] && r.bands[2][1] === r.bands[3][0], "a tree's bands join, impostors last", r.bands);
  check(r.atlas && r.imp && r.imp.h > 0 && r.cards > 0, "impostor atlas baked and cards drawn", [r.atlas, r.imp, r.cards]);
  check(r.s.regions > 4 && r.s.regions < r.s.chunks, "batched by region, several chunks to a region", [r.s.regions, r.s.chunks]);
  check(/^0+1+2+$/.test(r.builds) && r.builds.length <= 12, "each level's geometry built once per model", r.builds);
  await pg.screenshot({ path: out + "-plants.png" });

  // the quality level pulls every band in
  const q = await pg.evaluate(() => { const L = BF.real.lod; L.config.fixedScale = false; BF.real.quality.level = 0; L.update(); const t = [...L.models.values()].find(m => m.kind === 0); return L.bandsOf(t)[0][1]; });
  check(q < r.bands[0][1], "lower quality switches levels sooner", [q, r.bands[0][1]]);

  // remove: nothing left in the scene
  await pg.evaluate(() => { for (const k of __keys) BF.real.flora.remove(k); });
  await pg.waitForFunction(() => BF.real.lod.stats().regions === 0, null, { timeout: 60000, polling: 250 }).catch(() => {});
  const gone = await pg.evaluate(() => ({ s: BF.real.lod.stats(), left: BF.scene.children.filter(c => c.userData.rlod).length }));
  check(gone.s.regions === 0 && gone.s.plants === 0 && gone.left === 0, "remove clears regions and scene objects", [gone.s.regions, gone.s.plants, gone.left]);

  // the distant rings' materials take the look's shared light (js/lod.js)
  const ring = await pg.evaluate(() => { const m = BF.lod.material(false), U = BF.real.U; return { sun: m.uniforms.uSunCol === U.uSunCol, sky: m.uniforms.uSkyCol === U.uSkyCol, tone: /tonemapping_fragment/.test(m.fragmentShader) }; });
  check(ring.sun && ring.sky && ring.tone, "distant rings use the look's shared light", ring);
  await pg.waitForTimeout(1500);
  await pg.evaluate(() => localStorage.setItem("bf.look", "blocks"));
  console.log(fails ? "real-lod FAIL " + fails : "real-lod PASS");
};
