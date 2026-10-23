// @ci integration suite=world timeout=600 args={out}
// Chunk meshing in workers (spec r15-03). The page is served over http (workers can't start from a file:// page). For seed 1 and
// seed 3, round spawn:
//  - chunks are meshed by the mesher workers (not the in-page fallback);
//  - for up to 50 random loaded chunks, the arrays shown (built in a worker) equal the page's own mesher's, exactly: positions, uvs,
//    colours, sky and block light, the sphere attribute and the index;
//  - breaking and placing a block near the player is meshed the same frame (in the page) and matches;
//  - a far chunk edited twice while its job is in a worker ends up showing its final blocks, and an answer older than the shown mesh
//    is dropped.
// NODE_PATH=$(npm root -g) node test/mesh-worker.js [outPrefix]
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PW || "playwright");
const root = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".txt": "text/plain" };
const out = process.argv[2] || "/tmp/mesh-worker";
(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split(/[?#]/)[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let bad = 0;
  const check = (ok, what, info) => { console.log((ok ? "ok   " : "FAIL ") + what + (info !== undefined ? "  " + JSON.stringify(info) : "")); if (!ok) bad++; };
  try {
    for (const seed of [1, 3]) {
      const pg = await b.newPage({ viewport: { width: 320, height: 200 } });   // small: swiftshader is slow
      pg.on("pageerror", (e) => { console.log("PAGEERROR", e.message); bad++; });
      await pg.route("**/three.min.js", (r) => r.fulfill({ path: path.join(root, ".three-test.min.js"), contentType: "text/javascript" }));
      await pg.route("https://fonts.**", (r) => r.abort());
      await pg.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const v = document.getElementById("view"); if (v) v.requestPointerLock = null; }));
      await pg.goto(`http://127.0.0.1:${server.address().port}/index.html?nolod#seed${seed}gen4v10`);
      await pg.waitForFunction(() => window.BF && BF.world && !BF.preparing, null, { timeout: 180000, polling: 200 });
      await pg.evaluate(() => { BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true); BF.state.paused = true; });
      await pg.waitForFunction(() => BF.world.queueLength === 0 && BF.world.meshedCount() > 40, null, { timeout: 180000, polling: 250 }).catch(() => {});
      const st = await pg.evaluate(() => BF.world.meshStats());
      check(st.workers > 0 && !st.inline && st.done > 0, `seed ${seed}: chunks meshed in ${st.workers} workers`, st);
      // ---- the shown (worker) arrays against the page's mesher
      const cmp = await pg.evaluate(() => {
        const W = BF.world, keys = ["pos", "uv", "col", "sky", "bl", "sphere", "ind"];
        const same = (a, b) => {
          if (!a || !b) return a === b ? "" : "one pass missing";
          for (const k of keys) {
            const x = a[k], y = b[k];
            if (!x || !y) { if (x !== y) return k + " missing"; continue; }
            if (x.length !== y.length || x.constructor !== y.constructor) return k + " length/type " + x.length + "/" + y.length;
            for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && !(x[i] !== x[i] && y[i] !== y[i])) return k + "[" + i + "] " + x[i] + " vs " + y[i];
          }
          return "";
        };
        const cs = [...W.chunks.values()].filter(c => c.mesh === true && c.meshBy === "worker");
        for (let i = cs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cs[i], cs[j]] = [cs[j], cs[i]]; }
        const pick = cs.slice(0, 50), diffs = [];
        let verts = 0;
        for (const c of pick) {
          const s = W.shownArrays(c), p = W.meshArrays(c);
          const d = same(s.S, p.S) || same(s.L, p.L);
          if (d) diffs.push(c.key + ": " + d);
          verts += (p.S ? p.S.pos.length / 3 : 0) + (p.L ? p.L.pos.length / 3 : 0);
        }
        return { n: pick.length, diffs: diffs.slice(0, 5), nd: diffs.length, verts, sphere: pick.some(c => c.meshes.some(m => m.geometry.attributes.sphere)) };
      });
      check(cmp.n >= 30 && cmp.nd === 0, `seed ${seed}: ${cmp.n} worker-meshed chunks equal the page's mesher exactly (${cmp.verts} vertices)`, cmp.nd ? cmp.diffs : undefined);
      check(cmp.sphere, `seed ${seed}: meshes carry the sphere attribute`);
      // ---- the player's own edits: meshed the same frame, in the page
      const ed = await pg.evaluate(() => {
        const W = BF.world, p = BF.player.position, x = Math.floor(p.x), z = Math.floor(p.z), g = W.heightAt(x, z), c = W.chunkAt(x, z);
        const r = { before: c.meshShown };
        W.setBlock(x, g, z, 0);   // break
        W.update(p.x, p.z, 0);
        r.breakShown = c.meshShown === c.meshV && c.meshBy === "page";
        const a = W.shownArrays(c), b = W.meshArrays(c);
        r.breakSame = a.S.pos.length === b.S.pos.length && a.S.pos.every((v, i) => v === b.S.pos[i]);
        W.setBlock(x, g + 3, z, BF.B.glass);   // place
        W.update(p.x, p.z, 0);
        r.placeShown = c.meshShown === c.meshV && c.meshBy === "page";
        const a2 = W.shownArrays(c), b2 = W.meshArrays(c);
        r.placeSame = a2.S.pos.length === b2.S.pos.length && a2.S.pos.every((v, i) => v === b2.S.pos[i]) && a2.S.pos.length !== a.S.pos.length;
        return r;
      });
      check(ed.breakShown && ed.breakSame && ed.placeShown && ed.placeSame, `seed ${seed}: breaking and placing a block near the player is meshed the same frame`, ed);
      // ---- a far chunk edited again while its job is in a worker
      const far = await pg.evaluate(() => {
        const W = BF.world, p = BF.player.position, pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16);
        const c = W.chunkC(pcx + 3, pcz);
        if (!c || c.mesh !== true) return { none: true };
        const x = c.cx * 16 + 8, z = c.cz * 16 + 8, g = W.heightAt(x, z);
        window.__far = { c, x, z, g };
        W.setBlock(x, g + 1, z, BF.B.stone);
        W.update(p.x, p.z, 0);
        const r = { job1: c.meshJob };
        W.setBlock(x, g + 2, z, BF.B.stone);
        W.update(p.x, p.z, 0);
        r.again = c.meshAgain; r.shown0 = c.meshShown;
        return r;
      });
      if (!far.none) {
        await pg.waitForFunction(() => { const c = window.__far.c; return !c.meshJob && !c.meshAgain; }, null, { timeout: 30000 }).catch(() => {});
        const fr = await pg.evaluate(() => {
          const W = BF.world, c = window.__far.c, a = W.shownArrays(c), b = W.meshArrays(c);
          return { by: c.meshBy, shown: c.meshShown, v: c.meshV, same: a.S.pos.length === b.S.pos.length && a.S.pos.every((v, i) => v === b.S.pos[i]) };
        });
        check(far.job1 === 2 && far.again && fr.by === "worker" && fr.shown === fr.v && fr.same, `seed ${seed}: a far chunk edited twice while in a worker shows its final blocks`, Object.assign(far, fr));
        // an answer older than the shown mesh is dropped: send a job, then mesh the chunk in the page before the answer comes
        const drop = await pg.evaluate(async () => {
          const W = BF.world, c = window.__far.c, p = BF.player.position, d0 = W.meshStats().dropped;
          W.setBlock(window.__far.x, window.__far.g + 3, window.__far.z, BF.B.stone);
          W.update(p.x, p.z, 0);
          const inWorker = c.meshJob === 2;
          W.buildMeshNow(c);
          const v = c.meshShown;
          for (let i = 0; i < 100 && c.meshJob; i++) await new Promise(r => setTimeout(r, 50));
          return { inWorker, kept: c.meshShown === v && c.meshBy === "page", dropped: W.meshStats().dropped - d0 };
        });
        check(drop.inWorker && drop.kept && drop.dropped === 1, `seed ${seed}: a worker's answer older than the shown mesh is dropped`, drop);
      } else check(false, `seed ${seed}: a far chunk to edit`);
      await pg.screenshot({ path: `${out}-seed${seed}.png` });
      await pg.close();
    }
  } finally {
    await b.close();
    server.close();
  }
  console.log(bad ? `${bad} FAILED` : "all ok");
  process.exit(bad ? 1 : 0);
})();
