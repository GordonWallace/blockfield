// @ci integration suite=world
// The realistic look's plant levels of detail (js/real/lod.js, docs/REALISTIC_CONTRACT.md section 4): with the look off the module
// is not there; with it on it takes over BF.real.flora.place / remove, batches a chunk's flora records by region, builds each level's
// geometry (the registry's full model, and two thinner levels made from that same mesh so a tree keeps its shape), bakes the impostor
// atlas (a row per variant), picks levels by distance, and lets everything go again on remove. The species here are the test's own
// (cones), so it holds whatever the registry ships. The distant rings must still build with the look on.
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
    const P = (R.fell && R.fell.placer) || R.flora;   // (js/real/fell.js stands in front of the placer and hands every list on)
    const takeover = P.place === L.place && P.remove === L.remove;
    // from here on only the test's own chunks ("t...") reach the module: the world's flora would change every count below
    R.flora.place = (key, ox, oz, F) => { if (String(key)[0] === "t") L.place(key, ox, oz, F); };
    L.clear();
    L.config.fixedScale = true; L.config.scale = 1; L.config.budgetMs = 50;
    const first = BF.B.oak_log, cover = BF.B.fern;
    const mat = c => R.lit(new T.MeshLambertMaterial({ color: c }), { light: "cell" });
    let bm, fm, cm;
    const join = gs => {
      let n = 0, ni = 0;
      for (const g of gs) { n += g.attributes.position.count; ni += g.index.count; }
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), ix = new Uint32Array(ni);
      let o = 0, oi = 0;
      for (const g of gs) {
        pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3);
        for (let k = 0; k < g.index.count; k++) ix[oi++] = g.index.array[k] + o;
        o += g.attributes.position.count;
      }
      const G = new T.BufferGeometry();
      G.setAttribute("position", new T.BufferAttribute(pos, 3)); G.setAttribute("normal", new T.BufferAttribute(nrm, 3)); G.setIndex(new T.BufferAttribute(ix, 1));
      return G;
    };
    window.__builds = [];
    R.assets.species.push({ id: "test_cone", kind: "tree", log: "oak_log", variants: 2, height: [8, 8],
      build(rand, detail) {
        __builds.push(detail);
        // a trunk, 30 twigs and 40 leaf cones, each its own piece (as the registry's trees are tubes and leaf cards)
        const seg = [12, 7, 4][detail], trunk = new T.CylinderGeometry(0.2, 0.4, 3, seg), wood = [trunk], leaves = [], w = 2.5 + rand();
        trunk.translate(0, 1.5, 0);
        for (let i = 0; i < 30; i++) { const g = new T.CylinderGeometry(0.03, 0.05, 1, 4); g.translate(Math.cos(i) * w * 0.4, 3 + i * 0.15, Math.sin(i) * w * 0.4); wood.push(g); }
        for (let i = 0; i < 40; i++) { const g = new T.ConeGeometry(0.5, 0.8, 5); g.translate(Math.cos(i * 2.4) * w * (1 - i / 50), 3 + i * 0.12, Math.sin(i * 2.4) * w * (1 - i / 50)); leaves.push(g); }
        return { bark: join(wood), foliage: join(leaves) };
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
    return { n, takeover };
  });
  check(placed.takeover, "the module is the flora placer");
  await pg.waitForFunction(() => { const s = BF.real.lod.stats(); return s.plants > 0 && s.pending === 0 && s.batches > 0; }, null, { timeout: 120000, polling: 250 }).catch(() => {});
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(() => {
    const L = BF.real.lod, s = L.stats(), tree = [...L.models.values()].find(m => m.def.id === "test_cone" && m.variant === 0), bands = tree && L.bandsOf(tree);
    const mine = BF.scene.children.filter(c => c.userData.rlod);
    const U = L.cards.uniforms, other = [...L.models.values()].find(m => m.def.id === "test_cone" && m.variant === 1);
    const top = l => Math.max(...l.parts.map(p => p.geometry.boundingBox.max.y));
    return { s, bands, levels: tree && tree.lods.map(l => !!l), tris: tree && tree.lods.map(l => l && Math.round(l.tris)), tops: tree && tree.lods.map(l => l && +top(l).toFixed(2)),
      imp: tree && tree.row >= 0 && U.uRow.value[tree.row].toArray(), rowsApart: !!(other && other.row >= 0 && other.row !== tree.row), atlas: L.impostor.atlas ? [L.impostor.atlas.image.width, L.impostor.atlas.image.height] : null,
      direct: mine.length, cards: mine.filter(c => !c.isInstancedMesh).length, builds: __builds.slice().sort().join("") };
  });
  console.log("stats:", JSON.stringify(r.s));
  check(r.s.plants === placed.n, "every record with a registry entry is kept", [r.s.plants, placed.n]);
  check(r.s.pending === 0 && r.s.batches > 0 && r.direct === r.s.batches, "batches built, all direct scene children", [r.s.pending, r.s.batches, r.direct]);
  check(r.levels && r.levels.every(Boolean), "all three mesh levels of a tree built", r.levels);
  check(r.bands && r.bands[3] && r.bands[0][1] === r.bands[1][0] && r.bands[1][1] === r.bands[2][0] && r.bands[2][1] === r.bands[3][0], "a tree's bands join, impostors last", r.bands);
  check(r.tris && r.tris[0] > r.tris[1] && r.tris[1] > r.tris[2] && r.tris[2] > 0, "each level is thinner than the one before", r.tris);
  check(r.tops && Math.abs(r.tops[1] - r.tops[0]) < 1.5 && Math.abs(r.tops[2] - r.tops[0]) < 1.5, "a thinned level is the same tree (same height)", r.tops);
  check(r.atlas && r.imp && r.imp[1] > 0 && r.cards > 0, "impostor atlas baked and cards drawn", [r.atlas, r.imp, r.cards]);
  check(r.rowsApart, "each variant of a tree has its own impostor row");
  check(r.s.regions > 4 && r.s.regions < r.s.chunks, "batched by region, several chunks to a region", [r.s.regions, r.s.chunks]);
  check(/^0+$/.test(r.builds) && r.builds.length <= 4, "only the full model is asked of the registry, once per model", r.builds);
  await pg.screenshot({ path: out + "-plants.png" });

  // the quality level pulls every band in
  const q = await pg.evaluate(() => { const L = BF.real.lod; L.config.fixedScale = false; BF.real.quality.level = 0; L.update(); const t = [...L.models.values()].find(m => m.def.id === "test_cone"); return L.bandsOf(t)[0][1]; });
  check(q < r.bands[0][1], "lower quality switches levels sooner", [q, r.bands[0][1]]);

  // remove: nothing left in the scene
  await pg.evaluate(() => { for (const k of __keys) BF.real.flora.remove(k); });
  await pg.waitForFunction(() => BF.real.lod.stats().regions === 0, null, { timeout: 60000, polling: 250 }).catch(() => {});
  const gone = await pg.evaluate(() => ({ s: BF.real.lod.stats(), left: BF.scene.children.filter(c => c.userData.rlod).length }));
  check(gone.s.regions === 0 && gone.s.plants === 0 && gone.left === 0, "remove clears regions and scene objects", [gone.s.regions, gone.s.plants, gone.left]);

  // the distant rings' materials take the look's shared light (js/lod.js)
  const ring = await pg.evaluate(() => { const m = BF.lod.material(false), U = BF.real.U; return { sun: m.uniforms.uSunCol === U.uSunCol, sky: m.uniforms.uSkyCol === U.uSkyCol, tone: /tonemapping_fragment/.test(m.fragmentShader) }; });
  check(ring.sun && ring.sky && ring.tone, "distant rings use the look's shared light", ring);
  // the trees past the loaded chunks are cards of the same models (js/lod.js with BF.real.lod.cards): a stand-in with a tree's flora
  // record gets that tree's atlas row and goes to the ring's cards, a house stays a box; both materials compile
  const far = await pg.evaluate(() => {
    const L = BF.real.lod, C = L.cards, T = THREE, seed = 0.3;
    const tree = [...L.models.values()].find(m => m.def.id === "test_cone" && m.variant === Math.floor(seed * 9973) % 2);
    const row = C.rowOf(0, BF.B.oak_log, "", 6, seed, false);
    const S = { base: new Float32Array(6), sph: new Float32Array(6), top: new Uint8Array(6), low: new Uint8Array(6), a: new Uint8Array(8), b: new Uint8Array(8), c: new Uint8Array(2),
      bin: new Uint16Array(4), k: new Float32Array([BF.B.oak_log, 0, 6, seed, 0, 0, 0, -1]) };
    const errs = [], ce = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(" ").slice(0, 300)); };
    let boxes = -1, cards = -1, card = null, shared = false, pts = false;
    try {
      const g = BF.lod.standGeometry(S, true), mb = BF.lod.standMaterial(true), mp = BF.lod.standMaterial(false), gp = BF.lod.standGeometry(S, false);
      boxes = g.instanceCount; cards = g.userData.cards ? g.userData.cards.instanceCount : 0;
      card = g.userData.cards ? Array.from(g.userData.cards.attributes.card.array) : null;
      shared = mb.uniforms.uRow === C.uniforms.uRow && mp.uniforms.map === C.uniforms.map && /rlCard\(/.test(mb.vertexShader);
      pts = !!gp.attributes.card && gp.attributes.card.array[0] >= 0 && gp.attributes.card.array[4] === -1;
      const sc = new T.Scene(), a = new T.Mesh(g, mb), b = new T.Mesh(g.userData.cards, mb), c = new T.Points(gp, mp);
      for (const o of [a, b, c]) { o.frustumCulled = false; sc.add(o); }
      const rt = new T.WebGLRenderTarget(8, 8), R = BF.renderer, prev = R.getRenderTarget();
      R.setRenderTarget(rt); R.render(sc, BF.camera); R.setRenderTarget(prev); rt.dispose();
    } catch (e) { errs.push(String(e)); }
    console.error = ce;
    return { row, treeRow: tree ? tree.row : -2, boxes, cards, card, shared, pts, errs };
  });
  check(far.row && far.row[0] === far.treeRow && far.row[1] > 0, "a far tree's record gives the row and scale of the loaded tree's model", [far.row, far.treeRow]);
  check(far.boxes === 1 && far.cards === 1 && far.card && far.card[0] === far.treeRow, "a ring's trees are cards of their models, its houses boxes", [far.boxes, far.cards, far.card]);
  check(far.shared && far.pts && !far.errs.length, "the rings' stand-in materials draw the cards and compile", [far.shared, far.pts, far.errs]);
  // the far ground and water are the loaded chunks' (js/lod.js FRAG_USED): a ring's samples say where water is and how deep, its mesh
  // carries that and the ground's slope, and its material (the terrain's half-light, the water's own shading) compiles
  const land = await pg.evaluate(() => {
    const T = THREE, G = BF.gridJob, n = 5, NV = n * n;
    const raw = G.alloc({ nx: n, ny: n, real: true }), plain = G.alloc({ nx: n, ny: n });
    for (let o = 0; o < NV; o++) { raw.ok[o] = 1; raw.y[o] = 70 + (o % n) * 4; raw.dir[3 * o + 1] = 1; raw.col[3 * o] = 200; raw.wat[o] = o < n ? 255 : 0; }
    const p = { n, c: 4, gu0: 0, gv0: 0, cu: 8, cv: 8, anchor: [0, 0, 0], ext: 2, disc: 2, real: true };
    const m = G.mesh(p, raw), m15 = G.mesh(Object.assign({}, p, { real: false }), raw);
    const errs = [], ce = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(" ").slice(0, 300)); };
    try {
      const g = new T.BufferGeometry(), at = (a, k, nm) => new T.BufferAttribute(a, k, !!nm);
      g.setAttribute("position", at(m.pos, 3)); g.setAttribute("sphere", at(m.sph, 3)); g.setAttribute("col", at(m.col, 3, true));
      g.setAttribute("mflat", at(m.mpos, 3)); g.setAttribute("msph", at(m.msph, 3)); g.setAttribute("mcol", at(m.mcol, 3, true));
      g.setAttribute("canopy", at(m.can, 4, true)); g.setAttribute("wat", at(m.wat, 1, true)); g.setAttribute("nrm", at(m.nrm, 3, true));
      g.setIndex([0, 1, 5, 1, 6, 5]);
      const sc = new T.Scene(), o = new T.Mesh(g, BF.lod.material(true)); o.frustumCulled = false; sc.add(o);
      const rt = new T.WebGLRenderTarget(8, 8), R = BF.renderer, prev = R.getRenderTarget();
      R.setRenderTarget(rt); R.render(sc, BF.camera); R.setRenderTarget(prev); rt.dispose();
    } catch (e) { errs.push(String(e)); }
    console.error = ce;
    const mid = 3 * (2 * n + 2);
    return { wat: !!raw.wat && !plain.wat, mesh: m.wat && Array.from(m.wat.subarray(0, 2)).concat(m.wat[NV - 1]), nrm: m.nrm && Array.from(m.nrm.subarray(mid, mid + 3)),
      shade: [m.col[mid], m15.col[mid]], old: !m15.wat && !m15.nrm, errs };
  });
  check(land.wat && land.old, "only the look's ring samples and meshes carry water and slope", [land.wat, land.old]);
  check(land.mesh && land.mesh[0] === 255 && land.mesh[2] === 0 && land.nrm && land.nrm[0] < -60 && land.nrm[1] > 60 && land.nrm[2] === 0 && land.shade[0] === 200, "a ring's mesh says where water is, its ground's slope, and keeps its colours unshaded", [land.mesh, land.nrm, land.shade]);
  check(!land.errs.length, "the rings' ground and water material compiles", land.errs);
  // the atlas' smaller copies are made by hand (js/real/lod.js mipRow): a tree drawn small keeps the share of its picture that passes
  // the cards' alpha test, and its colour isn't darkened by the empty texels round it
  const mips = await pg.evaluate(() => {
    const L = BF.real.lod, tex = L.cards.uniforms.map.value, m = tex.mipmaps, M = [...L.models.values()].find(x => x.row >= 0 && L.cards.uniforms.uRow.value[x.row].y > 0);
    if (!m || !M) return null;
    const cw = L.config.cellW, ch = L.config.cellH, W = (L.config.frames + 1) * cw, x0 = (M.row % 2) * W, y0 = Math.floor(M.row / 2) * ch;
    const at = l => { const d = m[l].data, w = m[l].width; let n = 0, lum = 0, k = 0;
      for (let y = 0; y < ch >> l; y++) for (let x = 0; x < cw >> l; x++) { const o = (((y0 >> l) + y) * w + (x0 >> l) + x) * 4; if (d[o + 3] >= 102) { n++; lum += d[o] + d[o + 1] + d[o + 2]; } k++; }
      return [n / k, n ? lum / n : 0]; };
    // lines of the full picture that have something in them (a trunk, a twig), and how many of them still do three levels down
    const lines = l => { const d = m[l].data, w = m[l].width, out = []; for (let y = 0; y < ch >> l; y++) { let n = 0; for (let x = 0; x < cw >> l; x++) if (d[(((y0 >> l) + y) * w + (x0 >> l) + x) * 4 + 3] >= 102) n++; out.push(n); } return out; };
    const l0 = lines(0), l3 = lines(3);
    let had = 0, kept = 0;
    for (let y = 0; y < l3.length; y++) { let any = false; for (let k = 0; k < 8; k++) if (l0[y * 8 + k]) any = true; if (any) { had++; if (l3[y]) kept++; } }
    return { n: m.length, last: [m[m.length - 1].width, m[m.length - 1].height], gen: tex.generateMipmaps, a0: at(0), a2: at(2), a3: at(3), had, kept };
  });
  check(mips && !mips.gen && mips.last[0] === 1 && mips.last[1] === 1, "the atlas carries its own smaller copies, down to one texel", mips && [mips.n, mips.last, mips.gen]);
  check(mips && mips.a0[0] > 0.02 && mips.a2[0] >= mips.a0[0] * 0.9 && mips.a3[0] >= mips.a0[0] * 0.9 && mips.a3[1] > mips.a0[1] * 0.8,
    "a tree drawn small keeps its cover and its colour", mips && [mips.a0, mips.a2, mips.a3].map(a => a.map(v => +v.toFixed(2))));
  check(mips && mips.had > 4 && mips.kept === mips.had, "and every line of it that had something still does (a thin trunk stays)", mips && [mips.kept, mips.had]);
  await pg.waitForTimeout(1500);
  await pg.evaluate(() => localStorage.setItem("bf.look", "blocks"));
  console.log(fails ? "real-lod FAIL " + fails : "real-lod PASS");
};
