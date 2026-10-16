// @ci integration suite=world soak timeout=900
// Trees and village buildings from afar on the planet (spec r14-07). Served over http like test/distant.js (workers can't start from a
// file:// page). Checks:
//  - a forest seen from 60 blocks up to planet scale, either side of the chunk ceiling (screenshots): ring 0 draws its trees as boxes,
//    and each ring's stand-ins show only while a 10-block patch is a pixel or more;
//  - ring 0's stand-ins are exactly the trees worldgen's treesIn lists there;
//  - stand-ins kept by a moved ring match a fresh build of the same samples;
//  - a stand-in matches the real tree once its chunks load (a log at its trunk, the right kind);
//  - chunks stop loading above the chunk ceiling, and far chunks keep only their meshes.
// node test/run.js /tmp/standins test/standins.js
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".txt": "text/plain" };
module.exports = async (pg, out) => {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split(/[?#]/)[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/index.html#seed1337gen4`;
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  try {
    await pg.goto(url);
    await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow (never judge frame rate here)
    await pg.waitForFunction(() => window.BF && BF.lod && !BF.preparing, null, { timeout: 180000 });   // (the planet's rivers first)
    const forest = await pg.evaluate(() => {
      BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true);
      // Software rendering draws a forest's stand-ins (hundreds of thousands) in seconds a frame, so they are hidden while rings build
      // and the test works (as the frame loop moves the rings on), and shown for the screenshots.
      window.standIns = (on) => { window.__stand = on; for (const L of BF.lod.levels) if (L.si) L.si.material.visible = on; };
      window.ringsDone = async (maxS) => {
        const t0 = performance.now(), f0 = BF.lod.frames || 0;
        while ((BF.lod.frames || 0) < f0 + 3 && performance.now() - t0 < maxS * 1000) await new Promise((r) => setTimeout(r, 100));   // (the rings see the new place)
        for (;;) {
          standIns(false);
          const s = BF.lod.stats();
          if (s.active && s.rings.some((r) => r.show) && s.rings.every((r) => !r.show || (r.built && !r.building)) && s.pending === 0) return (performance.now() - t0) / 1000;
          if (performance.now() - t0 > maxS * 1000) return -1;
          await new Promise((r) => setTimeout(r, 500));
        }
      };
      window.goTo = (f, u, v, up, pitch) => {
        const P = BF.planet, a = P.atlas(f, u, v), g = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(a.x), Math.floor(a.z)));
        BF.player.teleport(a.x, g + up, a.z); BF.player.setFlying(true);
        if (pitch !== undefined) BF.player.setLook(BF.player.yaw, pitch);
      };
      // a big forest on seed 1337 (forest and dark forest for 600 blocks each way)
      return { f: 3, u: 148925, v: 59675 };
    });
    console.log("forest", JSON.stringify(forest));
    for (const h of [60, 300, 1000, 3000, 10000, 40000]) {
      await pg.evaluate(({ f, u, v, h }) => goTo(f, u, v, h, h > 5000 ? -1.2 : -0.5), { ...forest, h });
      const t = await pg.evaluate(() => ringsDone(600));
      // (the camera follows the look over a few frames; then two whole frames drawn with the stand-ins: a frame takes seconds here)
      await pg.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }));
      await pg.evaluate(() => { standIns(true); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); });
      await pg.screenshot({ path: `${out}-h${h}.png`, timeout: 180000 });
      await pg.evaluate(() => standIns(false));
      const s = await pg.evaluate(() => BF.lod.stats());
      console.log("h", h, "built in", t, "s; stand-ins", JSON.stringify(s.rings.map((r) => r.stands + (r.standsShown ? "*" : ""))), "pxScale", s.pxScale.toFixed(0));
    }
    // ---- shown only while a 10-block patch is a pixel or more
    const vis = await pg.evaluate(() => { const s = BF.lod.stats(); return { above: s.above, px: s.pxScale, shown: s.rings.map((r) => r.standsShown) }; });
    check(vis.above > 10 * vis.px && vis.shown.every((x) => !x), `no stand-ins drawn from ${Math.round(vis.above)} up (10 blocks under a pixel)`);

    // ---- back to 60 up over the forest: ring 0 is exactly treesIn's trees
    await pg.evaluate(({ f, u, v }) => goTo(f, u, v, 60, -0.5), forest);
    await pg.evaluate(() => ringsDone(600));
    const exact = await pg.evaluate(() => {
      const L = BF.lod.levels[0], S = L.stand, P = BF.planet, n = 2 * BF.lod.EXT + 1;
      // the trees of a block of 60 x 60 cells in the middle of the ring, against the stand-ins on those samples
      const k = 60, i0 = BF.lod.EXT - k / 2, j0 = i0;
      const tr = BF.worldgen.treesIn(L.f, (L.gu0 >> 2) + i0, (L.gv0 >> 2) + j0, (L.gu0 >> 2) + i0 + k, (L.gv0 >> 2) + j0 + k);
      const want = new Set(tr.map((t) => (t.x - P.W * L.f - P.N) + "," + (t.z - P.N) + "," + t.kind));
      let got = 0, stray = 0;
      for (let q = 0; q < S.c.length; q++) {
        const i = S.bin[2 * q], j = S.bin[2 * q + 1];
        if (i < i0 || i >= i0 + k || j < j0 || j >= j0 + k) continue;
        got++;
        const x = Math.floor(S.base[3 * q] + L.cu), z = Math.floor(S.base[3 * q + 2] + L.cv);
        if (![...want].some((w) => { const [wx, wz] = w.split(",").map(Number); return Math.abs(wx - x) <= 1 && Math.abs(wz - z) <= 1; })) stray++;
      }
      return { trees: tr.length, got, stray, total: S.c.length };
    });
    check(exact.trees > 50 && exact.got === exact.trees && exact.stray === 0, `ring 0's stand-ins are worldgen's trees (${JSON.stringify(exact)})`);

    // ---- a moved ring keeps its stand-ins, and they match a fresh build (rings 0 and 1)
    const moved = await pg.evaluate(async ({ f, u, v }) => {
      const b0 = BF.lod.levels.map((L) => L.builds);
      goTo(f, u + 520, v + 200, 60, -0.5);   // (past a fifth of ring 1's radius: both rings move)
      await ringsDone(600);
      const res = [];
      for (const lv of [0, 1]) {
        const L = BF.lod.levels[lv];
        if (L.builds === b0[lv]) { res.push("ring " + lv + " not rebuilt"); continue; }
        // a fresh job over 40 x 40 of the ring's samples kept from the old ring, compared on the inner 38 x 38
        const c = L.cell, i0 = 60, j0 = 60, k = 40;   // (the ring moved by +u +v: these samples were kept)
        const st = { cu: L.cu, cv: L.cv, anchor: L.anchor, gu0: L.gu0, gv0: L.gv0, m: BF.lod.THIN[lv], max: 0, exact: lv === 0, houses: true, villages: true };
        const job = { f: L.f, u0: L.gu0 + i0 * c, v0: L.gv0 + j0 * c, cell: c, nx: k, ny: k, stand: st }, r = BF.gridJob.alloc(job);
        BF.gridJob.rows(job, r, 0, k); BF.gridJob.stand(job, r);
        const key = (S, q) => [S.base[3 * q].toFixed(2), S.base[3 * q + 1].toFixed(1), S.base[3 * q + 2].toFixed(2), S.top[3 * q], S.low[3 * q], S.a[4 * q + 2], S.b[4 * q], S.b[4 * q + 3]].join();
        const inner = (S, q) => { const i = S.bin[2 * q], j = S.bin[2 * q + 1]; return i > i0 && i < i0 + k - 1 && j > j0 && j < j0 + k - 1; };
        const fresh = new Set(), have = new Set();
        for (let q = 0; q < r.stand.c.length; q++) if (inner(r.stand, q)) fresh.add(key(r.stand, q));
        for (let q = 0; q < L.stand.c.length; q++) if (inner(L.stand, q)) have.add(key(L.stand, q));
        let same = 0;
        for (const x of fresh) if (have.has(x)) same++;
        res.push({ lv, fresh: fresh.size, have: have.size, same });
      }
      return res;
    }, forest);
    check(moved.every((m) => m.fresh > 20 && m.same === m.fresh && m.have === m.fresh), `stand-ins kept by moved rings match a fresh build (${JSON.stringify(moved)})`);

    // ---- a stand-in matches the real tree once its chunks load
    await pg.evaluate(() => { const p = BF.player.position; BF.player.teleport(p.x, p.y - 40, p.z); });
    await pg.waitForFunction(() => BF.world.queueLength === 0, null, { timeout: 120000 });
    const real = await pg.evaluate(() => {
      const L = BF.lod.levels[0], S = L.stand, P = BF.planet, W = BF.world, pal = BF.lod.pal;
      let n = 0, ok = 0, bad = [];
      for (let q = 0; q < S.c.length; q++) {
        if (S.a[4 * q] === 0) continue;   // (no trunk: ice spikes, boulders)
        const u = S.base[3 * q] + L.cu, v = S.base[3 * q + 2] + L.cv;
        if (u < 0 || v < 0 || u >= P.N || v >= P.N) continue;
        const x = Math.floor(P.W * L.f + P.N + u), z = Math.floor(P.N + v), y = Math.round(S.base[3 * q + 1]);
        if (!W.chunks.has(Math.floor(x / 16) + "," + Math.floor(z / 16))) continue;
        n++;
        const id = W.getBlock(x, y, z), name = BF.blocks[id] && BF.blocks[id].name, sd = pal.side[id];
        const col = sd && Math.abs(Math.round(sd[0] * 0.9 * 255) - S.low[3 * q]) <= 1 && Math.abs(Math.round(sd[2] * 0.9 * 255) - S.low[3 * q + 2]) <= 1;
        if (/_log$|_stem$|^cactus$/.test(name || "") && col) ok++; else if (bad.length < 4) bad.push([x, y, z, name]);
      }
      return { n, ok, bad };
    });
    check(real.n > 10 && real.ok === real.n, `stand-ins stand on the real trees' trunks, of the right wood (${JSON.stringify(real)})`);

    // ---- the chunk ceiling, and far chunks keep only their meshes
    const ceil = await pg.evaluate(async () => {
      const W = BF.world, pp = BF.player.position, p = { x: pp.x, y: pp.y, z: pp.z }, n0 = W.chunks.size, px = BF.lod.stats().pxScale;
      BF.player.teleport(p.x, p.y + Math.min(px, W.chunkCeiling) * 1.2, p.z);
      await new Promise((r) => setTimeout(r, 1500));
      const high = { high: W.high, chunks: W.chunks.size, covered: W.covered };
      BF.player.teleport(p.x + 400, p.y + Math.min(px, W.chunkCeiling) * 1.2, p.z);
      await new Promise((r) => setTimeout(r, 1500));
      high.after = W.chunks.size;
      BF.player.teleport(p.x, p.y, p.z);
      return { n0, px, ...high };
    });
    check(ceil.high && ceil.covered === 0 && ceil.after <= ceil.chunks && ceil.chunks < ceil.n0, `above the chunk ceiling no chunks load (${JSON.stringify(ceil)})`);
    const purge = await pg.evaluate(async () => {
      const W = BF.world;
      // (chunks are purged past 15 chunks: a view of 20 has plenty; the rings are hidden meanwhile, as software rendering draws them slowly)
      for (const L of BF.lod.levels) if (L.mat) L.mat.visible = false;
      W.setViewDist(20);
      const t0 = performance.now();
      while (W.high && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 500));
      await new Promise((r) => setTimeout(r, 3000));
      while (W.queueLength > 0 && W.farMeshes.size <= 100 && performance.now() - t0 < 400000) await new Promise((r) => setTimeout(r, 500));
      for (const L of BF.lod.levels) if (L.mat) L.mat.visible = true;
      let data = 0;
      for (const c of W.chunks.values()) for (const s of c.secs) if (typeof s !== "number") data += s.byteLength;
      // a far chunk's mesh is taken back when its data comes back, and isn't meshed again
      return { chunks: W.chunks.size, far: W.farMeshes.size, dataMB: +(data / 1048576).toFixed(1), meshed: W.meshedCount(), queue: W.queueLength };
    });
    check(purge.far > 100 && purge.chunks < (2 * 15 + 2) ** 2, `far chunks keep only their meshes (${JSON.stringify(purge)})`);
    const errs = await pg.evaluate(() => (window.__errs || []).length);
    check(!errs, "no page errors");
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "standins: all checks passed");
};
