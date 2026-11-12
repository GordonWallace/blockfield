// @ci integration suite=world soak timeout=900
// Even detail from planet height (js/globe.js, Gordon's 1.6 request): seen from high up everything in view is about as far away as the
// ground straight below, so the globe splits its tiles until no cell in view is wider than about two pixels, and the rings whose cells
// are wider than that straight below are left to it. Served over http (the workers can't start from a file:// page). Checks, over land
// 30,000 blocks up on a 1280 x 760 screen:
//  - finer tiles are built and drawn, none is still missing, and the widest cell in view is under 3.6 pixels (it was 8 before: the
//    512-block ring);
//  - the rings with cells wider than two pixels straight below aren't drawn, the finer ones are, and the planet has no holes;
//  - the picture costs under 3 million triangles;
//  - with BF.globe.fine off the rings come back at once and no finer tile is drawn;
//  - back down at 5,000 the rings are as they were, nothing finer is drawn, and the finer tiles are dropped after a while;
//  - no page errors.
// node test/run.js /tmp/gf test/globe-fine.js
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
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  try {
    await pg.goto(`http://127.0.0.1:${server.address().port}/index.html?${require("./lib").q()}#seed1337gen4`);
    await pg.setViewportSize({ width: 320, height: 200 });   // small while the globe builds: swiftshader is slow
    await pg.waitForFunction(() => window.BF && BF.state && BF.state.seed === 1337 && !BF.preparing, null, { timeout: 300000, polling: 250 });
    await require("./lib").simReady(pg);
    await require("./lib").ready(pg);
    await pg.waitForTimeout(2000);
    await pg.evaluate(() => {
      window.__errs = []; addEventListener("error", (e) => window.__errs.push(e.message));
      BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true);
      window.__rt = null;
      // the share of magenta pixels with the planet on all four sides, drawn with the sky hidden and a magenta background
      window.holes = () => {
        const R = BF.renderer, s = R.getDrawingBufferSize(new THREE.Vector2()), sc = BF.scene;
        if (!window.__rt || window.__rt.width !== s.x) window.__rt = new THREE.WebGLRenderTarget(s.x, s.y);
        const hidden = [], bg = sc.background, fog = sc.fog;
        for (const c of sc.children) if (c.visible && !(c.userData && (c.userData.lod !== undefined || c.userData.chunk || c.userData.globe))) { c.visible = false; hidden.push(c); }
        sc.background = new THREE.Color(1, 0, 1); sc.fog = null;
        BF.lod.update();
        BF.view.begin(sc, BF.camera);
        R.setRenderTarget(window.__rt); R.render(sc, BF.camera); R.setRenderTarget(null);
        const tris = R.info.render.triangles;
        BF.view.end();
        sc.background = bg; sc.fog = fog;
        for (const c of hidden) c.visible = true;
        const w = s.x, h = s.y, px = new Uint8Array(w * h * 4);
        R.readRenderTargetPixels(window.__rt, 0, 0, w, h, px);
        const mag = (x, y) => { const o = (y * w + x) * 4; return px[o] > 240 && px[o + 1] < 15 && px[o + 2] > 240; };
        const lo = new Int32Array(h).fill(w), hi = new Int32Array(h).fill(-1), top = new Int32Array(w).fill(h), bot = new Int32Array(w).fill(-1);
        let land = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!mag(x, y)) {
          land++; lo[y] = Math.min(lo[y], x); hi[y] = Math.max(hi[y], x); top[x] = Math.min(top[x], y); bot[x] = Math.max(bot[x], y);
        }
        let m = 0, at = null;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mag(x, y) && x > lo[y] && x < hi[y] && y > top[x] && y < bot[x]) { m++; at = at || [x, y]; }
        return { holes: m, land: land / (w * h), at, tris };
      };
      window.goUp = (up) => {
        const s = BF.spawnPoint, g = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(s.x), Math.floor(s.z)));
        BF.player.teleport(s.x, g + up, s.z); BF.player.setFlying(true); BF.player.velocity.y = 0;
        BF.player.setLook(BF.player.yaw, -1.5);
      };
      window.wait = async (fn, maxS) => {
        const t0 = performance.now();
        while (!fn()) { if (performance.now() - t0 > maxS * 1000) return -1; await new Promise((r) => setTimeout(r, 500)); }
        return (performance.now() - t0) / 1000;
      };
      window.rings = () => BF.lod.stats().rings.filter((r) => r.tris > 0).map((r) => r.cell);
    });

    // ---- the planet-scale tiles build (from orbit, where the workers sample only the globe)
    await pg.evaluate(() => goUp(400000));
    const t = await pg.evaluate(() => wait(() => BF.globe.built === BF.globe.tiles.length, 700));
    check(t >= 0, "the planet-scale tiles are built");

    // ---- 30,000 up on a 1280 x 760 screen: 495 pixels a radian, so a cell is two pixels wide straight below at 121 blocks
    await pg.setViewportSize({ width: 1280, height: 760 });
    await pg.evaluate(() => goUp(30000));
    const ft = await pg.evaluate(() => wait(() => { const g = BF.globe.stats(); return g.cap > 0 && !g.missing && !BF.sampler.pending(); }, 500));
    await pg.waitForTimeout(1500);
    const a = await pg.evaluate(() => Object.assign(holes(), { g: BF.globe.stats(), rings: rings() }));
    console.log("30,000 up", JSON.stringify(a), "after", ft, "s");
    await pg.screenshot({ path: `${out}-30000.png` });
    check(ft >= 0 && a.g.fineShown > 20 && a.g.missing === 0, `the globe draws ${a.g.fineShown} finer tiles 30,000 up (${a.g.fine} built) and waits for none`);
    check(a.g.maxPx > 0.5 && a.g.maxPx < 3.6, `the widest cell in view is ${a.g.maxPx.toFixed(2)} pixels (two straight below, half as wide again at a slant)`);
    check(a.g.cap === 128 && a.rings.length > 0 && a.rings.every((c) => c < 128), `the rings from 128 blocks a cell are left to the globe (drawn: ${a.rings.join(", ")})`);
    check(a.holes === 0 && a.land > 0.5, `no holes (${a.holes} pixels, the planet ${(a.land * 100).toFixed(0)}% of the screen)`);
    check(a.tris < 3e6, `the picture is ${(a.tris / 1e6).toFixed(2)} million triangles`);

    // ---- switched off: the rings at once, and no finer tile
    const b = await pg.evaluate(async () => {
      BF.globe.fine = false;
      for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r));
      const r = Object.assign(holes(), { g: BF.globe.stats(), rings: rings() });
      BF.globe.fine = true;
      return r;
    });
    check(b.g.cap === 0 && b.g.fineShown === 0 && b.rings.includes(512) && b.holes === 0, `with BF.globe.fine off the rings are back (${b.rings.join(", ")}) and no finer tile is drawn`);

    // ---- back down at 5,000: as before, and the finer tiles go
    const c = await pg.evaluate(async () => {
      goUp(5000);
      await wait(() => BF.lod.stats().rings.every((r) => !r.show || (r.built && !r.building)), 400);
      await new Promise((r) => setTimeout(r, 1000));
      const r = Object.assign(holes(), { g: BF.globe.stats(), rings: rings() });
      r.gone = await wait(() => BF.globe.stats().fine === 0, 40);
      return r;
    });
    console.log("5,000 up", JSON.stringify(c));
    check(c.g.cap === 0 && c.g.fineShown === 0 && c.rings.includes(512) && c.rings.includes(256) && c.holes === 0, `5,000 up the rings draw the land as before (${c.rings.join(", ")}), with no holes`);
    check(c.gone >= 0, `the finer tiles are dropped once out of use (after ${c.gone.toFixed ? c.gone.toFixed(0) : c.gone} s)`);

    const errs = await pg.evaluate(() => window.__errs);
    check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "PASS globe-fine");
};
