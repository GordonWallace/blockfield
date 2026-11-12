// @ci integration suite=world soak timeout=900
// The planet from off-planet in the realistic look (Gordon, 1.6): the realistic look lights the far ground by its slope and draws its
// water itself (js/lod.js), from two attributes the globe's tiles (js/globe.js) didn't have, so the whole planet was black except the
// rings straight below. Served over http with ?look=real (the workers can't start from a file:// page). Checks, by day:
//  - every globe tile carries the slope and water attributes;
//  - 60,000 up and 300,000 up the planet's pixels are lit: almost none is black, and the land and sea away from the middle are about as
//    bright as the middle;
//  - no page errors.
// node test/run.js /tmp/rg test/real-globe.js
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
    await pg.goto(`http://127.0.0.1:${server.address().port}/index.html?look=real&${require("./lib").q()}#seed1337gen4`);
    await pg.setViewportSize({ width: 640, height: 400 });
    await pg.waitForFunction(() => window.BF && BF.state && BF.state.seed === 1337 && !BF.preparing, null, { timeout: 300000, polling: 250 });
    await require("./lib").simReady(pg);
    await require("./lib").ready(pg);
    await pg.waitForTimeout(2000);
    const real = await pg.evaluate(() => {
      window.__errs = []; addEventListener("error", (e) => window.__errs.push(e.message));
      BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true);
      window.goUp = (up) => {
        const s = BF.spawnPoint;
        BF.player.teleport(s.x, up, s.z); BF.player.setFlying(true); BF.player.velocity.y = 0;
        BF.player.setLook(BF.player.yaw, -1.5);
      };
      window.wait = async (fn, maxS) => {
        const t0 = performance.now();
        while (!fn()) { if (performance.now() - t0 > maxS * 1000) return -1; await new Promise((r) => setTimeout(r, 500)); }
        return (performance.now() - t0) / 1000;
      };
      // The planet's pixels (drawn with the sky hidden on magenta): the share that is black, and the mean brightness of the middle
      // (within a tenth of the screen's height of the centre) and of the rest.
      window.__rt = null;
      window.lit = () => {
        const R = BF.renderer, s = R.getDrawingBufferSize(new THREE.Vector2()), sc = BF.scene;
        if (!window.__rt || window.__rt.width !== s.x) window.__rt = new THREE.WebGLRenderTarget(s.x, s.y);
        const hidden = [], bg = sc.background, fog = sc.fog;
        for (const c of sc.children) if (c.visible && c.userData && c.userData.renderSpace && !c.isLight) { c.visible = false; hidden.push(c); }
        sc.background = new THREE.Color(1, 0, 1); sc.fog = null;
        BF.lod.update();
        BF.view.begin(sc, BF.camera);
        R.setRenderTarget(window.__rt); R.render(sc, BF.camera); R.setRenderTarget(null);
        BF.view.end();
        sc.background = bg; sc.fog = fog;
        for (const c of hidden) c.visible = true;
        const w = s.x, h = s.y, px = new Uint8Array(w * h * 4);
        R.readRenderTargetPixels(window.__rt, 0, 0, w, h, px);
        let n = 0, black = 0, mid = 0, midN = 0, rest = 0, restN = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
          if (r > 200 && g < 60 && b > 200) continue;   // the background
          const v = (r + g + b) / 3;
          n++; if (v < 6) black++;
          if (Math.hypot(x - w / 2, y - h / 2) < h / 10) { mid += v; midN++; } else { rest += v; restN++; }
        }
        return { planet: n / (w * h), black: n ? black / n : 1, mid: midN ? mid / midN : 0, rest: restN ? rest / restN : 0 };
      };
      BF.state.time = 6000;   // noon
      return !!(BF.real && BF.real.on);
    });
    check(real, "the realistic look is on");

    await pg.evaluate(() => goUp(400000));
    const t = await pg.evaluate(() => wait(() => BF.globe.built === BF.globe.tiles.length, 700));
    const attrs = await pg.evaluate(() => BF.globe.tiles.filter((t) => t.mesh && t.mesh.geometry.getAttribute("nrm") && t.mesh.geometry.getAttribute("wat")).length);
    check(t >= 0 && attrs === 600, `all 600 globe tiles carry the slope and water attributes (${attrs})`);

    for (const up of [60000, 300000]) {
      await pg.evaluate((up) => goUp(up), up);
      await pg.evaluate(() => wait(() => BF.lod.stats().rings.every((r) => !r.show || (r.built && !r.building)) && !BF.sampler.pending() && !BF.globe.stats().missing, 400));
      await pg.waitForTimeout(1500);
      const r = await pg.evaluate(() => { BF.state.time = 6000; return lit(); });
      console.log(up + " up", JSON.stringify(r));
      await pg.screenshot({ path: `${out}-${up}.png` });
      check(r.planet > 0.05 && r.black < 0.02, `${up} up: the planet is lit (${(r.black * 100).toFixed(1)}% of its pixels black)`);
      check(r.rest > 0.5 * r.mid && r.rest > 25, `${up} up: away from the middle it is about as bright as the middle (${r.rest.toFixed(0)} and ${r.mid.toFixed(0)} of 255)`);
    }

    const errs = await pg.evaluate(() => window.__errs);
    check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "PASS real-globe");
};
