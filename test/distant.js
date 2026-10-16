// @ci integration suite=world soak timeout=900
// Distant terrain on the planet (spec r14-05): rings of height-field meshes out to the horizon, sampled by Web Workers. The page is
// served over http here (workers can't start from a file:// page). Checks:
//  - the workers sample (not the in-page fallback), all eight rings build, and their samples match the generator's own columns;
//  - views from the ground, 600, 2,500 and 10,000 blocks up show land to the horizon (screenshots), and no ground pixel is left
//    uncovered looking straight down (a magenta background pass with the sky hidden);
//  - a ring moved by the player (reusing what it already had) matches a fresh build of the same place;
//  - a step across a cube corner at 3,000 and 95,000 blocks up leaves no uncovered pixel (the per-pixel cuts and wedge strips);
//  - ring rebuilds take only a few ms of main-thread time per frame.
// Over 75 s in CI (the rings take a while to sample on 2 cores), so it is a soak test.
// node test/run.js /tmp/distant test/distant.js
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
  let nPng = 0;
  const savePng = async (name) => {
    const d = await pg.evaluate(() => coverPng());
    if (d) fs.writeFileSync(`${out}-${name}-${nPng++}.png`, Buffer.from(d.split(",")[1], "base64"));
  };
  try {
    await pg.goto(url);
    await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow (never judge frame rate here)
    await pg.waitForFunction(() => window.BF && BF.lod && !BF.preparing, null, { timeout: 180000 });   // (the planet's rivers first)
    await pg.evaluate(() => {
      BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true);
      // cover(): this frame drawn off screen with the sky hidden and a magenta background; the share of magenta pixels within r
      // (a fraction of the screen's half diagonal) of the middle, or with r = 0, of magenta pixels with ground on all four sides
      // (holes inside the land, not the space round it)
      window.__rt = null;
      window.cover = (r) => {
        const R = BF.renderer, s = R.getSize(new THREE.Vector2()), sc = BF.scene;
        if (!window.__rt || window.__rt.width !== s.x) window.__rt = new THREE.WebGLRenderTarget(s.x, s.y);
        const hidden = [];
        for (const c of sc.children) if (c.visible && !(c.userData && (c.userData.lod !== undefined || c.userData.chunk))) { c.visible = false; hidden.push(c); }
        const bg = sc.background, fog = sc.fog;
        sc.background = new THREE.Color(1, 0, 1); sc.fog = null;
        if (BF.globe) BF.globe.hidden = true;   // the rings alone (the globe, js/globe.js, has its own test)
        BF.view.begin(sc, BF.camera);
        R.setRenderTarget(window.__rt); R.render(sc, BF.camera); R.setRenderTarget(null);
        BF.view.end();
        if (BF.globe) BF.globe.hidden = false;
        sc.background = bg; sc.fog = fog;
        for (const c of hidden) c.visible = true;
        const px = new Uint8Array(s.x * s.y * 4);
        R.readRenderTargetPixels(window.__rt, 0, 0, s.x, s.y, px);
        let n = 0, m = 0;
        const lim = (r || 2) * Math.hypot(s.x, s.y) / 2;
        const mag = (x, y) => { const o = (y * s.x + x) * 4; return px[o] > 240 && px[o + 1] < 15 && px[o + 2] > 240; };
        const lo = new Int32Array(s.y).fill(s.x), hi = new Int32Array(s.y).fill(-1), top = new Int32Array(s.x).fill(s.y), bot = new Int32Array(s.x).fill(-1);
        for (let y = 0; y < s.y; y++) for (let x = 0; x < s.x; x++) if (!mag(x, y)) {
          lo[y] = Math.min(lo[y], x); hi[y] = Math.max(hi[y], x); top[x] = Math.min(top[x], y); bot[x] = Math.max(bot[x], y);
        }
        for (let y = 0; y < s.y; y++) for (let x = 0; x < s.x; x++) {
          if (Math.hypot(x - s.x / 2, y - s.y / 2) > lim) continue;
          n++;
          if (mag(x, y) && (r || (x > lo[y] && x < hi[y] && y > top[x] && y < bot[x]))) m++;
        }
        window.__lastCover = m ? { px, w: s.x, h: s.y } : null;
        return m / n;
      };
      // the last cover() pass as a PNG (data URL), when it had uncovered pixels: saved next to the screenshots
      window.coverPng = () => {
        const c = window.__lastCover;
        if (!c) return null;
        const cv = document.createElement("canvas"); cv.width = c.w; cv.height = c.h;
        const ctx = cv.getContext("2d"), im = ctx.createImageData(c.w, c.h);
        for (let y = 0; y < c.h; y++) im.data.set(c.px.subarray((c.h - 1 - y) * c.w * 4, (c.h - y) * c.w * 4), y * c.w * 4);
        ctx.putImageData(im, 0, 0);
        return cv.toDataURL("image/png");
      };
      // until every shown ring is built and nothing is queued
      window.ringsDone = async (maxS) => {
        const t0 = performance.now(), f0 = BF.lod.frames || 0;
        // a few frames first, so the rings see where the player is now (a fast machine can otherwise find the old rings all built)
        while ((BF.lod.frames || 0) < f0 + 3 && performance.now() - t0 < maxS * 1000) await new Promise((r) => setTimeout(r, 100));
        for (;;) {
          const s = BF.lod.stats();
          if (s.rings.every((r) => !r.show || (r.built && !r.building)) && s.pending === 0) return (performance.now() - t0) / 1000;
          if (performance.now() - t0 > maxS * 1000) return -1;
          await new Promise((r) => setTimeout(r, 500));
        }
      };
      window.goTo = (f, u, v, up, pitch) => {
        const P = BF.planet, a = P.atlas(f, u, v), g = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(a.x), Math.floor(a.z)));
        BF.player.teleport(a.x, g + up, a.z); BF.player.setFlying(true);
        if (pitch !== undefined) BF.player.setLook(BF.player.yaw, pitch);
      };
    });

    // ---- the first build, from the ground
    const t = await pg.evaluate(() => ringsDone(600));
    const s0 = await pg.evaluate(() => BF.lod.stats());
    console.log("first build", t, "s;", s0.workers, "workers,", s0.samples, "samples,", s0.msPerSample.toFixed(3), "ms each;", JSON.stringify(s0.rings.map((r) => r.cell + ":" + r.buildMs + "/" + r.meshMs)));
    check(!s0.inline, "the rings are sampled by workers");
    check(t > 0 && s0.rings.every((r) => r.built), `all rings built (${t.toFixed(0)} s)`);
    // samples match the generator's own columns (sampled again in the page)
    const same = await pg.evaluate(() => {
      let n = 0, ok = 0;
      for (const L of BF.lod.levels) {
        const n1 = 2 * BF.lod.EXT + 1;
        for (let k = 0; k < 40; k++) {
          const i = (k * 131) % n1, j = (k * 197 + 17) % n1, o = j * n1 + i;
          if (!L.raw.ok[o]) continue;
          const job = { f: L.f, u0: L.gu0 + i * L.cell, v0: L.gv0 + j * L.cell, cell: L.cell, nx: 1, ny: 1 }, r = BF.gridJob.alloc(job);
          BF.gridJob.rows(job, r, 0, 1);
          n++;
          if (r.y[0] === L.raw.y[o] && r.col[0] === L.raw.col[3 * o] && r.col[1] === L.raw.col[3 * o + 1] && r.can[3] === L.raw.can[4 * o + 3]) ok++;
        }
      }
      return [ok, n];
    });
    check(same[0] === same[1] && same[1] > 200, `worker samples match the page's (${same[0]}/${same[1]})`);

    // ---- views from four heights (screenshots), and nothing uncovered straight down
    for (const h of [0, 600, 2500, 10000]) {
      await pg.evaluate((h) => { const p = BF.player.position; const P = BF.planet, g = P.grid(p.x, p.z); goTo(g.f, g.u, g.v, h + 1.7, h ? -0.45 : -0.15); }, h);
      await pg.evaluate(() => ringsDone(300));
      await pg.waitForTimeout(1500);
      await pg.screenshot({ path: `${out}-h${h}.png` });
      if (h >= 600) {
        await pg.evaluate(() => BF.player.setLook(BF.player.yaw, -1.55));
        await pg.waitForTimeout(500);   // the camera follows the look on the next frames
        const m = await pg.evaluate(() => cover(2));
        if (m) await savePng("down" + h);
        check(m === 0, `straight down from ${h} up: no uncovered ground (${(m * 100).toFixed(2)}%)`);
      }
    }

    // ---- a moved ring matches a fresh build
    const moved = await pg.evaluate(async () => {
      const L = BF.lod.levels[0], b0 = L.builds;
      const p = BF.player.position, P = BF.planet, g = P.grid(p.x, p.z);
      goTo(g.f, g.u + 300, g.v + 120, 300);
      await ringsDone(300);
      if (L.builds === b0) return "not rebuilt";
      const n1 = 2 * BF.lod.EXT + 1;
      let bad = 0, n = 0;
      for (let k = 0; k < 400; k++) {
        const i = (k * 37) % n1, j = (k * 53 + 5) % n1, o = j * n1 + i;
        const job = { f: L.f, u0: L.gu0 + i * L.cell, v0: L.gv0 + j * L.cell, cell: L.cell, nx: 1, ny: 1 }, r = BF.gridJob.alloc(job);
        BF.gridJob.rows(job, r, 0, 1);
        n++;
        if (r.ok[0] !== L.raw.ok[o] || (r.ok[0] && (r.y[0] !== L.raw.y[o] || r.col[2] !== L.raw.col[3 * o + 2]))) bad++;
      }
      return { bad, n };
    });
    check(moved.n === 400 && moved.bad === 0, `ring 0 moved with the player matches a fresh build (${JSON.stringify(moved)})`);

    // ---- a step across a cube corner, at 3,000 and 95,000 up: nothing uncovered
    for (const h of [3000, 95000]) {
      const r = h > 50000 ? 0 : 2;   // high up, holes inside the land only: the globe (r14-06) fills the view beyond the coarsest ring
      await pg.evaluate((h) => { goTo(4, 163840 - 900, 163840 - 700, h, -1.55); }, h);
      await pg.evaluate(() => ringsDone(400));
      const m0 = await pg.evaluate((r) => cover(r), r);
      if (m0) await savePng("corner-before" + h);
      // across the corner onto the neighbouring face (+u from face 4), then a moment later, then once the rings have rebuilt
      await pg.evaluate((h) => { const P = BF.planet, e = P.EDGE[4][1], A = e.A, x = 163840 + 300 - e.t[0], y = 163840 - 700 - e.t[1];
        goTo(e.g, A[0] * x + A[2] * y, A[1] * x + A[3] * y, h, -1.55); }, h);
      await pg.waitForTimeout(500);
      const m1 = await pg.evaluate((r) => cover(r), r);
      if (m1) await savePng("corner-step" + h);
      await pg.evaluate(() => ringsDone(400));
      const m2 = await pg.evaluate((r) => cover(r), r);
      if (m2) await savePng("corner" + h);
      await pg.screenshot({ path: `${out}-corner${h}.png` });
      if (m0 || m1 || m2) console.log("rings:", await pg.evaluate(() => { const s = BF.lod.stats(), V = BF.lod.view; return JSON.stringify({ view: [V.f, Math.round(V.u), Math.round(V.v)], above: Math.round(s.above), eye: s.eyeHole, rings: s.rings.map((r) => [r.f, r.cu, r.cv, r.show, r.built, r.building, r.tris]) }); }));
      check(m0 === 0 && m1 === 0 && m2 === 0, `a step across a cube corner at ${h} up leaves nothing uncovered (${[m0, m1, m2].map((m) => (m * 100).toFixed(2) + "%").join(", ")})`);
    }

    // ---- main-thread time
    const st = await pg.evaluate(() => BF.lod.stats());
    // (the worst single frame is no measure here: with swiftshader and three workers on a few cores the page's thread is often
    // descheduled or collecting garbage mid-frame, so a few frames and swaps come out slow whatever they do)
    const slowSwaps = st.swaps.filter((ms) => ms > 25).length;
    console.log("main thread: lod.update over 25 ms in", st.slowFrames, "of", st.frames, "frames (worst", st.maxFrameMs.toFixed(1), "ms); mesh swaps", JSON.stringify(st.swaps));
    check(st.frames > 100 && st.slowFrames <= st.frames * 0.02 && slowSwaps <= st.swaps.length * 0.25,
      "ring rebuilds take only a few ms of main-thread time a frame (under swiftshader)");
    const errs = await pg.evaluate(() => (window.__errs || []).length);
    check(!errs, "no page errors");
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "distant: all checks passed");
};
