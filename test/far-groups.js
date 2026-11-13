// @ci integration suite=world soak timeout=900 hosts=worker
// Far chunks drawn 4 x 4 to a mesh (js/world.js mergeFar; Gordon 2026-11-13: view distance 32 took 2,763 draw calls a frame against 896
// at 16, the far chunks two or three each, and the page thread pays for every call). Served over http like test/standins.js (meshing in
// workers). With the joining held (world.farMerge = "hold") the far chunks wait with their arrays; the test then joins them itself and checks:
//  - a joined mesh holds exactly its chunks' vertices: positions moved to the group's origin, sphere positions to its anchor, colours as they were;
//  - the picture is the same before and after, with far fewer meshes to draw;
//  - a far chunk that changes gets its own mesh again and its triangles leave the joined mesh;
//  - far from here everything goes: no joined mesh is left in the scene.
// node test/run.js /tmp/fg test/far-groups.js --host worker
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
  const url = `http://127.0.0.1:${server.address().port}/index.html?${require('./lib').q()}${process.env.FAR_LOOK ? '&look=' + process.env.FAR_LOOK : ''}#seed1337gen4`;   // (FAR_LOOK=real: the realistic look, slower to load)
  let bad = 0;
  const check = (ok, what, got) => { console.log((ok ? "ok " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); if (!ok) bad++; };
  // how far two screenshots differ (compared in the page)
  const differ = (a, b) => pg.evaluate(async ([a, b]) => {
    const load = s => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + s; });
    const px = async s => { const i = await load(s), c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
    const A = await px(a), B = await px(b);
    let n = 0;
    // (in cells of 16 x 16 pixels: the camera settles a little between the two, a missing chunk would change a cell's colour)
    const W = 320, H = 200, C = 16, cell = (D, cx, cy) => { const s = [0, 0, 0]; for (let y = cy * C; y < cy * C + C && y < H; y++) for (let x = cx * C; x < cx * C + C; x++) { const i = (y * W + x) * 4; s[0] += D[i]; s[1] += D[i + 1]; s[2] += D[i + 2]; } return s.map(v => v / (C * C)); };
    for (let cy = 0; cy < 9; cy++) for (let cx = 0; cx < W / C; cx++) { const a = cell(A, cx, cy), b = cell(B, cx, cy); n = Math.max(n, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])); }
    return n;
  }, [a.toString("base64"), b.toString("base64")]);
  try {
    await pg.goto(url);
    await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow (never judge frame rate here)
    await pg.waitForFunction(() => window.BF && BF.lod && BF.state && BF.state.seed === 1337 && !BF.preparing && BF.world.chunks.size > 0, null, { timeout: 300000, polling: 250 });
    const loaded = await pg.evaluate(async () => {
      const W = BF.world;
      W.farMerge = "hold";
      BF.player.start(); BF.player.gameMode = "creative"; BF.player.flying = true;
      const p = BF.player.position; window.__at = [p.x, p.y + 30, p.z];
      window.__hold = setInterval(() => { const p = BF.player.position; p.x = __at[0]; p.y = __at[1]; p.z = __at[2]; if (BF.player.vel) BF.player.vel.set(0, 0, 0); BF.player.setLook(0.6, -0.3); }, 30);
      // (chunks are purged past 15 chunks: a view of 22 has whole groups of them; the rings are hidden meanwhile, as software rendering draws them slowly)
      for (const L of BF.lod.levels) if (L.mat) L.mat.visible = false;
      W.setViewDist(22);
      const t0 = performance.now(), ready = () => { let n = 0; for (const G of W.farGroups.values()) if (G.wait.size === 16) n++; return n; };
      await new Promise((r) => setTimeout(r, 3000));
      while ((W.queueLength > 0 || ready() < 4) && performance.now() - t0 < 600000) await new Promise((r) => setTimeout(r, 500));
      await new Promise((r) => setTimeout(r, 3000));
      return { far: W.farMeshes.size, ready: ready(), queue: W.queueLength, s: Math.round((performance.now() - t0) / 1000) };
    });
    check(loaded.ready >= 4, "far chunks wait in whole groups", loaded);
    await pg.evaluate(() => BF.sky.setTime(0.1));   // (dusk would change the light between the two pictures)
    const calls = () => pg.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(BF.scene.children.filter(o => o.userData.flat).length)))));   // (chunk meshes in the scene, in view or not)
    const calls0 = await calls(), shot0 = await pg.screenshot();
    const joined = await pg.evaluate(() => {
      const W = BF.world, CS = BF.CS, snap = new Map();
      for (const G of W.farGroups.values()) for (const [k, ms] of G.wait) snap.set(k, ms.map(m => {
        const a = m.geometry.attributes;
        return { base: m.userData.base, x: m.position.x, z: m.position.z, anchor: m.userData.anchor, pos: a.position.array, col: a.color.array, sph: a.sphere ? a.sphere.array : null, ind: m.geometry.index.array };
      }));
      let n = 0;
      BF.sky.setTime(0.1);
      while (W.mergeFar(true)) n++;
      // (before the next frame: the joined meshes still have their arrays)
      const r = { groups: n, chunks: 0, verts: 0, badPos: 0, badCol: 0, badSph: 0, badInd: 0, left: 0, kept: 0 };
      for (const [k, list] of snap) {
        if (!W.farMerged(k)) { r.left++; continue; }
        r.chunks++;
        if (W.farMeshes.get(k).length) r.kept++;
        const rs = W.farBatch(k).ranges.get(k);
        for (const o of list) {
          const R = rs.find(x => x.mesh.userData.base === o.base), M = R.mesh, a = M.geometry.attributes, ix = M.geometry.index.array;
          const v0 = ix[R.start] - o.ind[0], dx = o.x - M.position.x, dz = o.z - M.position.z, A = M.userData.anchor;
          if (R.count !== o.ind.length) r.badInd++;
          for (let i = 0; i < o.ind.length; i++) if (ix[R.start + i] !== o.ind[i] + v0) { r.badInd++; break; }
          const n = o.pos.length / 3; r.verts += n;
          for (let j = 0; j < n; j++) {
            const q = (v0 + j) * 3, p = j * 3;
            if (a.position.array[q] !== Math.fround(o.pos[p] + dx) || a.position.array[q + 1] !== o.pos[p + 1] || a.position.array[q + 2] !== Math.fround(o.pos[p + 2] + dz)) r.badPos++;
            if (a.color.array[q] !== o.col[p] || a.color.array[q + 1] !== o.col[p + 1] || a.color.array[q + 2] !== o.col[p + 2]) r.badCol++;
            if (o.sph) for (let c = 0; c < 3; c++) if (Math.abs(a.sphere.array[q + c] + A[c] - (o.sph[p + c] + o.anchor[c])) > 0.01) { r.badSph++; break; }
          }
        }
      }
      return r;
    });
    check(joined.groups >= 4 && joined.chunks >= 64 && joined.left <= joined.chunks / 4 && !joined.kept, "the waiting groups are joined and their chunks' own meshes gone", joined);
    check(joined.verts > 1000 && !joined.badPos && !joined.badCol && !joined.badSph && !joined.badInd, "a joined mesh holds exactly its chunks' vertices");
    await pg.evaluate(() => BF.sky.setTime(0.1));
    const calls1 = await calls(), shot1 = await pg.screenshot();
    fs.writeFileSync(out + "-before.png", shot0); fs.writeFileSync(out + "-after.png", shot1);
    const d = await differ(shot0, shot1);
    check(d < 45, "the picture is the same joined (the most a 16-pixel cell's colour differs, of 765)", +d.toFixed(1));
    check(calls1 <= calls0 - joined.chunks * 0.9, "with fewer meshes to draw (" + calls0 + " to " + calls1 + ")");
    // a far chunk changes: it gets its data and its own mesh back, and leaves the joined mesh
    const left = await pg.evaluate(async () => {
      const W = BF.world, k = [...W.farMeshes.keys()].filter(k => W.farMerged(k))[40], G = W.farBatch(k), [cx, cz] = k.split(",").map(Number);
      const R = G.ranges.get(k)[0], ix = R.mesh.geometry.index, live0 = G.live;
      const x = cx * 16 + 8, z = cz * 16 + 8, y = BF.worldgen.heightAt(x, z) + 6;
      W.applyEdits([[k, [[((y - BF.MIN_Y) << 8) | (8 << 4) | 8, 1]]]], false);   // (as the simulation's edit of a far chunk arrives)
      const t0 = performance.now();
      while (W.farMerged(k) && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 250));
      const c = W.chunks.get(k);
      let zero = true;
      for (let i = 0; i < R.count; i++) if (ix.array[R.start + i] !== 0) { zero = false; break; }
      return { merged: W.farMerged(k), own: c ? c.meshes.length : (W.farMeshes.get(k) || []).length, zero, live0, live: G.live, block: W.getBlock(x, y, z) };
    });
    check(!left.merged && left.own > 0 && left.zero && left.live === left.live0 - 1, "a far chunk that changes has its own mesh again and leaves the joined one", left);
    // far away: every far mesh and group goes
    const gone = await pg.evaluate(async () => {
      const W = BF.world;
      W.setViewDist(4);
      __at[0] += 16 * 60;
      const t0 = performance.now();
      const n = () => BF.scene.children.filter(o => o.userData.farGroup).length;
      while ((n() > 0 || [...W.farGroups.values()].some(G => G.members)) && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 250));
      return { meshes: n(), built: [...W.farGroups.values()].filter(G => G.members).length, far: W.farMeshes.size };
    });
    check(gone.meshes === 0 && gone.built === 0, "far from there no joined mesh is left", gone);
    const errs = await pg.evaluate(() => (window.__errs || []).length);
    check(!errs, "no page errors");
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "far-groups: all checks passed");
};
