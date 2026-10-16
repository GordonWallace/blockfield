// Performance benchmark (spec r14-23): the same measurements on any Blockfield checkout, to compare releases on one machine.
// Usage: node tools/perf.js [root=.] [only=start,ground,fly300,fly2000,planet,sim,mem] [--min 10] [--json out.json] [--query nolod]
//   e.g. git worktree add /tmp/bf13 origin/release-1-3 && node tools/perf.js /tmp/bf13 && node tools/perf.js .
// Serves root over http (as run.sh does, so the river and distant-land workers run) and drives headless Chromium:
//  - start: Create New World from the menu (a seed no earlier step used) to playing: the loading step done and the chunks around the
//    player drawn (9 or more meshed, and the chunk under the player loaded);
//  - ground: frame cost standing in the boot world's nearest village, at ground level, for 15 s;
//  - fly300 / fly2000: frame cost flying forward (creative, W held) 300 and 2,000 blocks above the ground, for 20 s;
//  - planet: frame cost 60,000 blocks up (the whole planet in view; generator 4 only);
//  - sim: simulation speed at the top time warp in that village (window 320 x 200): game seconds per real second, villages loaded counted;
//  - mem: JS heap after `--min` minutes of flight 300 blocks up (default 10).
// Frame cost is the time spent inside each requestAnimationFrame callback (the game's whole frame: simulation, chunk work, drawing
// calls), so it doesn't depend on vsync; mean, 95th percentile, frames counted and frames per second (window 640 x 360). Headless Chromium draws with SwiftShader (the CPU),
// so absolute numbers are far slower than a real GPU: compare releases on the same machine, not with these numbers alone.
// Needs playwright (NODE_PATH=$(npm root -g) or PW=<path>); three.js comes from .three-test.min.js like the tests (the CDN may be blocked).
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PW || "playwright");
const here = path.resolve(__dirname, "..");
const args = process.argv.slice(2), flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const MIN = +flag("--min", 10), JSON_OUT = flag("--json", null), QUERY = flag("--query", "");   // --query nolod: without distant terrain
const root = path.resolve(args[0] || "."), only = (args[1] || "start,ground,fly300,fly2000,planet,sim,mem").split(",");
const planet = fs.existsSync(path.join(root, "js/planetrivers.js"));   // 1.4 and later: the round world
const HASH = planet ? "#seed123gen4v10" : "#seed1337gen3v9";             // the test boot worlds (a village near the spawn in both)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

function serve() {
  const s = http.createServer((q, r) => {
    const f = path.join(root, decodeURIComponent(q.url.split(/[?#]/)[0]));
    if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); r.end(b); });
  });
  return new Promise(res => s.listen(0, "127.0.0.1", () => res(s)));
}
const stats = a => {
  if (!a.length) return { mean: null, p95: null, n: 0 };
  const s = a.slice().sort((x, y) => x - y);
  return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), n: a.length };
};

(async () => {
  const srv = await serve(), url = `http://127.0.0.1:${srv.address().port}/index.html${QUERY ? "?" + QUERY : ""}`;
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-precise-memory-info"] });
  // a small window: SwiftShader's cost grows with the pixels drawn, which a real GPU barely notices; the simulation runs at 320 x 200
  const VW = { width: 640, height: 360 }, SIMW = { width: 320, height: 200 };
  const pg = await b.newPage({ viewport: VW });
  pg.on("pageerror", e => console.log("PAGEERROR", e.message));
  await pg.route("**/three.min.js", r => r.fulfill({ path: path.join(here, ".three-test.min.js"), contentType: "text/javascript" }));
  await pg.route("https://fonts.**", r => r.abort());
  // headless Chromium answers the pointer lock that Create asks for with a flood of synthetic mouse moves (hundreds of thousands, which
  // starve the page): a real browser sends none while the mouse is still, so the benchmark leaves the pointer unlocked
  await pg.addInitScript(() => { Element.prototype.requestPointerLock = function () {}; });
  await pg.addInitScript(() => {   // frame cost: time inside each animation-frame callback
    const raf = window.requestAnimationFrame.bind(window);
    window.__ft = []; window.__ftOn = false;
    window.requestAnimationFrame = cb => raf(t => { const s = performance.now(); try { cb(t); } finally { if (window.__ftOn) window.__ft.push(performance.now() - s); } });
  });
  const res = { root, version: null, hash: HASH, when: new Date().toISOString() };
  const boot = async () => {
    await pg.goto(url + HASH); await pg.reload();   // (a hash change alone doesn't load the page again)
    await pg.waitForFunction(() => window.BF && BF.state && BF.world && !BF.preparing, null, { timeout: 300000 });
    await pg.waitForTimeout(1000);
  };
  const settle = (ms = 4000) => pg.evaluate(async ms => {
    await new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 160 && BF.world.queueLength > 0; i++) await new Promise(r => setTimeout(r, 250));
  }, ms);
  const frames = async (ms) => {
    await pg.evaluate(() => { window.__ft = []; window.__ftOn = true; });
    await pg.waitForTimeout(ms);
    const ft = await pg.evaluate(() => { window.__ftOn = false; return window.__ft; });
    // what the last frame drew: triangles and draw calls (independent of the GPU), and distant-terrain triangles where there are any
    const info = await pg.evaluate(() => {
      const r = BF.renderer.info.render;
      let lodTris = 0;
      if (BF.lod && BF.lod.levels) for (const L of BF.lod.levels) if (L.mesh && L.mesh.visible !== false) { const g = L.mesh.geometry; lodTris += g && g.index ? g.index.count / 3 : 0; }
      return { tris: r.triangles, calls: r.calls, lodTris: Math.round(lodTris) };
    });
    return Object.assign(stats(ft), { fps: +(ft.length / (ms / 1000)).toFixed(1) }, info);
  };
  const ground = () => pg.evaluate(() => {
    const p = BF.player.position;
    return BF.view && BF.view.groundAt ? BF.view.groundAt(p.x, p.z) : BF.worldgen.heightAt(Math.floor(p.x), Math.floor(p.z));
  });
  // flying at height y (1.3 has no setFlying: its player is restored flying)
  const FLY = () => { window.__fly = (y) => {
    const P = BF.player;
    if (P.setFlying) { P.setFlying(true); P.position.y = y; P.velocity.y = 0; return; }
    const o = P.serialize(); o.flying = true; o.y = y; o.x = P.position.x; o.z = P.position.z; P.deserialize(o);
  }; };
  await pg.addInitScript(FLY);
  await boot();
  res.version = await pg.evaluate(() => (BF.VERSION || (BF.version && BF.version.game) || null));

  if (only.includes("start")) {
    const t = await pg.evaluate(async () => {
      document.querySelector('[data-act="show-create"]').click();
      await new Promise(r => setTimeout(r, 300));
      const f = document.querySelector(".bfp-view-create");
      f.elements.name.value = "Benchmark"; f.elements.seed.value = "24680";
      const t0 = performance.now();
      f.querySelector('button[type="submit"]').click();
      const at = { prepared: null, playing: null };
      for (;;) {
        await new Promise(r => setTimeout(r, 50));
        const now = performance.now();
        if (at.prepared === null && !BF.preparing && BF.save.current && BF.save.current.name === "Benchmark") at.prepared = now - t0;
        if (at.prepared !== null) {
          const p = BF.player.position, loaded = BF.world.isLoaded ? BF.world.isLoaded(Math.floor(p.x), Math.floor(p.z)) : true;
          if (loaded && BF.world.meshedCount() >= 9) { at.playing = now - t0; break; }
        }
        if (now - t0 > 300000) break;
      }
      return at;
    });
    res.start = { worldReadyS: t.prepared && +(t.prepared / 1000).toFixed(2), playingS: t.playing && +(t.playing / 1000).toFixed(2) };
    console.log("start", JSON.stringify(res.start));
    await boot();
  }

  // the nearest village to the boot spawn: stand at its centre
  const village = await pg.evaluate(() => {
    const p = BF.player.position, vs = (BF.worldgen.villagesNear && BF.worldgen.villagesNear(p.x, p.z, 400)) || [];
    let best = null;
    for (const v of vs) { const d = Math.hypot(v.x - p.x, v.z - p.z); if (!best || d < best.d) best = { x: v.x, z: v.z, d }; }
    return best;
  });
  res.village = village && { x: village.x, z: village.z, d: Math.round(village.d) };
  console.log("village", JSON.stringify(res.village));
  if (only.includes("ground") || only.includes("sim")) {
    await pg.evaluate(v => {
      BF.player.start && BF.player.start();
      if (v) { const P = BF.player.position; P.x = v.x + 0.5; P.z = v.z + 0.5; }
      BF.player.setGameMode && BF.player.setGameMode("creative");
      BF.player.setFlying && BF.player.setFlying(false);   // (1.3 starts on foot)
    }, village);
    await settle(6000);
    await pg.evaluate(async () => { const P = BF.player.position; P.y = (BF.view && BF.view.groundAt ? BF.view.groundAt(P.x, P.z) : BF.worldgen.heightAt(Math.floor(P.x), Math.floor(P.z))) + 2; });
    await settle(3000);
  }
  if (only.includes("ground")) {
    res.ground = await frames(15000);
    res.ground.chunks = await pg.evaluate(() => BF.world.meshedCount());
    console.log("ground", JSON.stringify(res.ground));
  }
  if (only.includes("sim")) {
    await pg.setViewportSize(SIMW);
    const r = await pg.evaluate(async () => {
      const W = BF.warp;
      W.set(W.SPEEDS.length - 1);
      await new Promise(r => setTimeout(r, 5000));   // warm up
      const s0 = BF.simNow(), t0 = performance.now();
      await new Promise(r => setTimeout(r, 30000));
      const sim = BF.simNow() - s0, wall = (performance.now() - t0) / 1000;
      W.set(0);
      const st = BF.villageSim && BF.villageSim.status ? BF.villageSim.status() : "";
      return { speed: +(sim / wall).toFixed(1), top: W.SPEEDS[W.SPEEDS.length - 1], villages: +(/^(\d+)/.exec(st) || [0, 0])[1], status: st, mobs: BF.mobs.list.length };
    });
    await pg.setViewportSize(VW);
    res.sim = r;
    console.log("sim", JSON.stringify(r));
  }
  const fly = async (h, ms, label) => {
    await pg.evaluate(h => {
      BF.player.start && BF.player.start();
      BF.player.setGameMode && BF.player.setGameMode("creative");
      const P = BF.player.position, g = BF.view && BF.view.groundAt ? BF.view.groundAt(P.x, P.z) : BF.worldgen.heightAt(Math.floor(P.x), Math.floor(P.z));
      window.__fly(h > 10000 ? h : g + h);
      BF.player.setLook(BF.player.yaw, h > 10000 ? -1.5 : -0.25);
    }, h);
    await settle(h > 10000 ? 6000 : 4000);
    if (h <= 10000) await pg.keyboard.down("w");
    const r = await frames(ms);
    if (h <= 10000) await pg.keyboard.up("w");
    r.y = Math.round(await pg.evaluate(() => BF.player.position.y));
    console.log(label, JSON.stringify(r));
    return r;
  };
  if (only.includes("fly300")) res.fly300 = await fly(300, 20000, "fly300");
  if (only.includes("fly2000")) res.fly2000 = await fly(2000, 20000, "fly2000");
  if (only.includes("planet")) res.planet = planet ? await fly(60000, 15000, "planet") : "n/a (flat world)";
  if (only.includes("mem")) {
    await boot();
    await pg.evaluate(() => {
      BF.player.start && BF.player.start(); BF.player.setGameMode("creative");
      const P = BF.player.position; window.__fly((BF.view && BF.view.groundAt ? BF.view.groundAt(P.x, P.z) : BF.worldgen.heightAt(Math.floor(P.x), Math.floor(P.z))) + 300);
      BF.player.setLook(BF.player.yaw, -0.25);
    });
    await pg.keyboard.down("w");
    const samples = [];
    for (let m = 0; m <= MIN; m++) {
      if (m) await pg.waitForTimeout(60000);
      const s = await pg.evaluate(() => ({ heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0), chunks: BF.world.chunks.size, x: Math.round(BF.player.position.x), z: Math.round(BF.player.position.z) }));
      samples.push(s);
    }
    await pg.keyboard.up("w");
    const c = await pg.context().newCDPSession(pg);
    await c.send("HeapProfiler.collectGarbage");
    const after = await pg.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(0));
    res.mem = { minutes: MIN, heapMB: samples[samples.length - 1].heapMB, heapAfterGcMB: after, samples };
    console.log("mem", JSON.stringify({ minutes: MIN, heapMB: res.mem.heapMB, heapAfterGcMB: after, chunks: samples[samples.length - 1].chunks }));
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(res, null, 1));
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
