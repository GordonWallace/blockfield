// @ci integration suite=world soak timeout=900
// The whole planet at planet scale (spec r14-06): the globe's tiles, sampled by the distant-terrain workers, so the page is served over
// http (workers can't start from a file:// page). Checks:
//  - every tile of all six faces builds, sampled by the workers (time logged);
//  - from 300,000 blocks up, over the middle of each face, the planet has no holes (a magenta background pass with the sky hidden);
//  - over a cube corner from 100,000 up, and over land from 30,000 up, with the rings drawn too: no holes;
//  - tiles past the horizon, or wholly inside the coarsest ring, are hidden (none drawn 1,000 up);
//  - dragging the planet round from orbit, across face edges, and flying across a face edge 30,000 up change the picture smoothly;
//  - no page errors.
// Over 75 s in CI (the globe samples 2.7 million columns on 2 cores), so it is a soak test.
// node test/run.js /tmp/globe test/globe.js
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
    await pg.goto(`http://127.0.0.1:${server.address().port}/index.html#seed1337gen4`);
    await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow
    await require("./lib").ready(pg);   // the planet's rivers worked out and the world started
    await pg.waitForTimeout(2000);
    await pg.evaluate(() => {
      window.__errs = []; addEventListener("error", (e) => window.__errs.push(e.message));
      BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true);
      window.__rt = null;
      // this frame drawn off screen: with the sky hidden and a magenta background (bare), or as it is
      window.grab = (bare) => {
        const R = BF.renderer, s = R.getSize(new THREE.Vector2()), sc = BF.scene;
        if (!window.__rt || window.__rt.width !== s.x) window.__rt = new THREE.WebGLRenderTarget(s.x, s.y);
        const hidden = [], bg = sc.background, fog = sc.fog;
        if (bare) {
          for (const c of sc.children) if (c.visible && !(c.userData && (c.userData.lod !== undefined || c.userData.chunk || c.userData.globe))) { c.visible = false; hidden.push(c); }
          sc.background = new THREE.Color(1, 0, 1); sc.fog = null;
        }
        BF.lod.update();   // as the game loop does before drawing (a ring may have been swapped in since the last frame)
        BF.view.begin(sc, BF.camera);
        R.setRenderTarget(window.__rt); R.render(sc, BF.camera); R.setRenderTarget(null);
        BF.view.end();
        sc.background = bg; sc.fog = fog;
        for (const c of hidden) c.visible = true;
        const px = new Uint8Array(s.x * s.y * 4);
        R.readRenderTargetPixels(window.__rt, 0, 0, s.x, s.y, px);
        return { px, w: s.x, h: s.y };
      };
      // the share of magenta pixels with the planet on all four sides (holes in it, not the space round it)
      window.holes = () => {
        const { px, w, h } = grab(true);
        const mag = (x, y) => { const o = (y * w + x) * 4; return px[o] > 240 && px[o + 1] < 15 && px[o + 2] > 240; };
        const lo = new Int32Array(h).fill(w), hi = new Int32Array(h).fill(-1), top = new Int32Array(w).fill(h), bot = new Int32Array(w).fill(-1);
        let land = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!mag(x, y)) {
          land++; lo[y] = Math.min(lo[y], x); hi[y] = Math.max(hi[y], x); top[x] = Math.min(top[x], y); bot[x] = Math.max(bot[x], y);
        }
        let m = 0, at = null;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mag(x, y) && x > lo[y] && x < hi[y] && y > top[x] && y < bot[x]) { m++; at = at || [x, y]; }
        return { holes: m / (w * h), land: land / (w * h), at };
      };
      window.diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };
      window.goTo = (f, u, v, up) => {
        const P = BF.planet, a = P.atlas(f, u, v), g = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(a.x), Math.floor(a.z)));
        BF.player.teleport(a.x, g + up, a.z); BF.player.setFlying(true); BF.player.velocity.y = 0;
        BF.player.setLook(BF.player.yaw, -1.5);
      };
      window.wait = async (fn, maxS) => {
        const t0 = performance.now();
        while (!fn()) { if (performance.now() - t0 > maxS * 1000) return -1; await new Promise((r) => setTimeout(r, 500)); }
        return (performance.now() - t0) / 1000;
      };
      // every shown ring built and nothing queued
      window.ringsDone = () => wait(() => BF.lod.stats().rings.every((r) => !r.show || (r.built && !r.building)) && BF.sampler.pending(BF.globe) === 0, 400);
    });

    // ---- the whole globe builds, straight up into orbit (the rings are hidden there, so the workers sample only the globe)
    await pg.evaluate(() => { const p = BF.player.position; BF.player.teleport(p.x, 400000, p.z); BF.player.setFlying(true); });
    const t = await pg.evaluate(() => wait(() => BF.globe.built === BF.globe.tiles.length, 700));
    const s0 = await pg.evaluate(() => Object.assign(BF.globe.stats(), { workers: BF.sampler.workers.length, inline: BF.sampler.inline }));
    console.log("globe", JSON.stringify(s0), "waited", t, "s");
    check(!s0.inline && s0.workers > 0 && s0.tiles === 600, `the globe is 600 tiles sampled by ${s0.workers} workers`);
    check(t >= 0 && s0.built === 600, `every tile built (${(s0.doneMs / 1000).toFixed(0)} s after the world started)`);

    // ---- each face from 300,000 up: no holes
    const N = 163840;
    const faces = [];
    for (let f = 0; f < 6; f++) {
      await pg.evaluate((f) => { goTo(f, 163840 / 2, 163840 / 2, 300000); }, f);
      await pg.evaluate(() => ringsDone());
      await pg.waitForTimeout(1500);
      const r = await pg.evaluate(() => Object.assign(holes(), { shown: BF.globe.stats().shown, off: BF.player.offPlanet }));
      faces.push(r);
      await pg.screenshot({ path: `${out}-face${f}.png` });
    }
    console.log("faces", JSON.stringify(faces.map((r) => [+(r.holes * 100).toFixed(3), +(r.land * 100).toFixed(1), r.shown])));
    check(faces.every((r) => r.holes === 0 && r.land > 0.03), "from 300,000 up, every face is drawn whole");
    check(faces.every((r) => r.shown > 100 && r.shown < 600), `tiles past the horizon are hidden (${faces.map((r) => r.shown).join(", ")} of 600 drawn)`);

    // ---- a cube corner from 100,000 up and land from 30,000 up, with the rings
    for (const [what, f, u, v, up] of [["a cube corner, 100,000 up", 4, N - 900, N - 700, 100000], ["land 30,000 up", -1, 0, 0, 30000]]) {
      await pg.evaluate(([f, u, v, up]) => {
        if (f < 0) { const s = BF.spawnPoint, g = BF.planet.grid(s.x, s.z); goTo(g.f, g.u, g.v, up); } else goTo(f, u, v, up);
      }, [f, u, v, up]);
      const rt = await pg.evaluate(() => ringsDone());
      await pg.waitForTimeout(800);
      const r = await pg.evaluate(() => holes());
      await pg.screenshot({ path: `${out}-${up}.png` });
      check(rt >= 0 && r.holes === 0 && r.land > (up > 50000 ? 0.03 : 0.3), `${what}: no holes (${(r.holes * 100).toFixed(3)}% of the screen, the planet ${(r.land * 100).toFixed(0)}%)`);
    }

    // ---- lower down the rings reach the horizon, and the globe draws nothing there
    const low = await pg.evaluate(async () => {
      const s = BF.spawnPoint, g = BF.planet.grid(s.x, s.z);
      goTo(g.f, g.u, g.v, 1000);
      await ringsDone();
      await new Promise((r) => setTimeout(r, 800));
      const a = BF.globe.stats().shown;
      goTo(g.f, g.u, g.v, 30000);
      await ringsDone();
      await new Promise((r) => setTimeout(r, 800));
      return [a, BF.globe.stats().shown];
    });
    check(low[0] === 0 && low[1] < 200, `the globe draws ${low[0]} tiles 1,000 up, where the rings reach the horizon, and ${low[1]} of 600 at 30,000 up`);

    // ---- no jumps: flying across a face edge 30,000 up, and dragging the planet round from orbit across edges
    const fly = await pg.evaluate(async () => {
      const P = BF.planet, N = P.N;
      goTo(4, N - 1500, N / 2, 30000);
      BF.player.setLook(-Math.PI / 2, -0.9);   // towards +u
      await new Promise((r) => setTimeout(r, 600));
      await ringsDone();   // (the rings rebuilt after the hop here, so none swaps in during the steps: a slow worker on CI made a 17-point jump)
      BF.state.paused = true;
      const d = [], faces = new Set();
      let prev = null;
      for (let i = 0; i < 16; i++) {
        const a = P.atlas(4, N - 1500 + i * 200, N / 2);
        const c = P.canon(a.x, a.z, {});
        BF.player.position.x = c.x; BF.player.position.z = c.z;
        if (c.turn) BF.player.setLook(P.turnYaw((4 - c.turn) % 4, -Math.PI / 2), -0.9); else BF.player.setLook(-Math.PI / 2, -0.9);
        faces.add(P.face(c.x, c.z));
        await new Promise((r) => setTimeout(r, 100));
        const { px } = grab(false);
        if (prev) d.push(+diff(prev, px).toFixed(2));
        prev = px;
      }
      BF.state.paused = false;
      return { d, faces: [...faces] };
    });
    console.log("flight steps", JSON.stringify(fly));
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    check(fly.faces.length === 2 && Math.max(...fly.d) < 3 * med(fly.d) + 2, `200-block steps across a face edge 30,000 up change the picture evenly (largest ${Math.max(...fly.d)}, median ${med(fly.d)})`);

    // dragging from orbit (off-planet mode turns the planet under the player; the drag itself is tested in test/planet-high.js)
    const spin = await pg.evaluate(async () => {
      goTo(4, 163840 / 2 + 30000, 163840 / 2, 300000);
      await wait(() => BF.player.offPlanet, 30);
      await new Promise((r) => setTimeout(r, 1500));
      const d = [], faces = new Set();
      let prev = null, holed = 0;
      for (let i = 0; i < 14; i++) {
        BF.player.turnPlanet(-4, 1);   // about 5 degrees a step
        for (let k = 0; k < 2; k++) await new Promise((r) => requestAnimationFrame(r));   // the camera follows the player in the frame
        const p = BF.player.position;
        faces.add(BF.planet.face(p.x, p.z));
        const hh = holes();
        if (hh.holes > 0) { holed++; console.warn("hole at step " + i, hh.holes * 64000, JSON.stringify(hh.at), JSON.stringify(BF.lod.stats().rings.map((r) => [r.cell, r.show, r.built, r.building, r.f])), JSON.stringify(BF.globe.stats())); }
        const { px } = grab(false);
        if (prev) d.push(+diff(prev, px).toFixed(2));
        prev = px;
      }
      return { d, faces: [...faces], holed };
    });
    console.log("spin steps", JSON.stringify(spin));
    check(spin.faces.length >= 2 && !spin.holed && Math.max(...spin.d) < 3 * med(spin.d) + 2, `turning the planet from orbit across ${spin.faces.length} faces is smooth, with no holes (largest ${Math.max(...spin.d)}, median ${med(spin.d)})`);

    const errs = await pg.evaluate(() => window.__errs);
    check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "PASS globe");
};
