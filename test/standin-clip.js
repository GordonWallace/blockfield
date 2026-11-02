// @ci integration suite=world timeout=600
// Stand-ins never show over chunks that have meshes (js/lod.js chunk mask). While chunks stream in, the loaded chunks' disc only reaches
// the nearest chunk still without a mesh, so chunks past it are drawn already; their village buildings and trees used to show twice,
// real and as stand-in boxes. Over a village on seed 1337, looking straight down with the chunks loaded and the disc forced to nothing
// (as while chunks stream in), the chunks' and rings' own meshes hidden so only stand-ins draw:
//  - the chunk mask marks exactly the chunks that have meshes;
//  - with the mask, no stand-in pixel shows over them (the frame matches one without stand-ins, but for the mobs moving);
//  - without it (the old behaviour), the village's stand-ins show there.
// Served over http like test/standins.js (workers can't start from a file:// page).
// node test/run.js /tmp/clip test/standin-clip.js
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
  const url = `http://127.0.0.1:${server.address().port}/index.html?${require('./lib').q()}#seed1337gen4`;
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  try {
    await pg.goto(url);
    await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow
    await pg.waitForFunction(() => window.BF && BF.lod && BF.state && BF.state.seed === 1337 && !BF.preparing, null, { timeout: 300000, polling: 250 });
    await require('./lib').simReady(pg);
    // over the village nearest spawn, 45 blocks up, looking straight down (the view is about 30 blocks across there: all loaded chunks)
    const v = await pg.evaluate(() => {
      const P = BF.planet, p = BF.player.position;
      const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
      BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true);
      const g = Math.max(BF.SEA, BF.worldgen.heightAt(v.x, v.z));
      BF.player.teleport(v.x + 0.5, g + 45, v.z + 0.5); BF.player.setFlying(true);
      BF.player.setLook(BF.player.yaw, -Math.PI / 2 + 0.01);
      return { x: v.x, z: v.z, g };
    });
    console.log("village", JSON.stringify(v));
    // the rings built round the player, and every wanted chunk meshed
    await pg.waitForFunction(() => {
      const s = BF.lod.stats(), L = BF.lod.levels[0];
      return s.active && L.mesh && !L.building && L.si && s.pending === 0 && BF.world.queueLength === 0;
    }, null, { timeout: 400000, polling: 500 });
    const frames = (n) => pg.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i < n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }), n);
    await frames(5);

    // ---- the mask marks exactly the chunks with meshes
    const marks = await pg.evaluate(() => {
      const W = BF.world, pp = BF.player.position, pcx = Math.floor(pp.x / 16), pcz = Math.floor(pp.z / 16);
      let meshed = 0, wrong = [];
      for (let cx = pcx - 20; cx <= pcx + 20; cx++) for (let cz = pcz - 20; cz <= pcz + 20; cz++) {
        const c = W.chunks.get(cx + "," + cz), has = c ? c.mesh === true && c.meshes.length > 0 : W.farMeshes.has(cx + "," + cz);
        if (has) meshed++;
        if (has !== BF.lod.masked(cx, cz) && wrong.length < 5) wrong.push([cx, cz, has]);
      }
      return { meshed, wrong };
    });
    check(marks.meshed >= 40 && !marks.wrong.length, `the chunk mask marks the chunks with meshes (${JSON.stringify(marks)})`);

    // ---- frames with only the stand-ins drawn, the loaded chunks' disc forced to nothing
    await pg.evaluate(() => {
      const W = BF.world;
      window.__covered = Object.getOwnPropertyDescriptor(W, "covered");
      Object.defineProperty(W, "covered", { configurable: true, get: () => 0, set: () => {} });
      for (const c of W.chunks.values()) for (const m of c.meshes || []) m.visible = false;
      for (const L of BF.lod.levels) { if (L.mat) L.mat.visible = false; }
      if (BF.lod.ribbon) BF.lod.ribbon.visible = false;
    });
    const standIns = (on) => pg.evaluate((on) => { for (const L of BF.lod.levels) if (L.si) L.si.material.visible = on; }, on);
    const shot = async (name) => { await frames(4); const b = await pg.screenshot({ path: `${out}-${name}.png`, timeout: 180000 }); return b.toString("base64"); };
    await standIns(false);
    const none = await shot("none");
    await standIns(true);
    const masked = await shot("masked");
    await pg.evaluate(() => { BF.lod.maskOff = true; });
    const unmasked = await shot("unmasked");
    await pg.evaluate(() => { BF.lod.maskOff = false; });
    const d = await pg.evaluate(async ([a, b, c]) => {
      const px = async (s) => {
        const img = new Image(); img.src = "data:image/png;base64," + s; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
        const x = cv.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data;
      };
      const A = await px(a), B = await px(b), C = await px(c);
      const diff = (P, Q) => { let n = 0; for (let i = 0; i < P.length; i += 4) if (Math.abs(P[i] - Q[i]) + Math.abs(P[i + 1] - Q[i + 1]) + Math.abs(P[i + 2] - Q[i + 2]) > 24) n++; return n; };
      const si = BF.lod.levels[0].si;
      return { masked: diff(A, B), unmasked: diff(A, C), pixels: A.length / 4, ring0: si ? si.geometry.instanceCount : 0, eyeHole: BF.lod.eyeHole };
    }, [none, masked, unmasked]);
    console.log("pixels differing from the frame without stand-ins", JSON.stringify(d));
    check(d.eyeHole === 0, "the loaded chunks' disc is forced to nothing (as while chunks stream in)");
    check(d.unmasked > 500, `without the mask the village's stand-ins show over its loaded chunks (${d.unmasked} pixels)`);
    // (what still differs is the village's mobs, which move between the frames)
    check(d.masked < d.unmasked / 15, `with the mask no stand-in shows over a chunk with a mesh (${d.masked} pixels, the mobs moving)`);

    await pg.evaluate(() => {
      const W = BF.world;
      delete W.covered; W.covered = 0;
      for (const c of W.chunks.values()) for (const m of c.meshes || []) m.visible = true;
      for (const L of BF.lod.levels) { if (L.mat) L.mat.visible = true; }
    });
    const errs = await pg.evaluate(() => (window.__errs || []).length);
    check(!errs, "no page errors");
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "standin-clip: all checks passed");
};
