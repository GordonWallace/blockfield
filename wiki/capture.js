#!/usr/bin/env node
// Takes Blockfieldpedia's pictures with the game itself: a portrait of every mob and villager profession, and a view of every biome,
// rivers, mountains, the coast, villages and the planet from high up, in a fresh world (seed 1337, the planet; places are found around its spawn on face 4). Writes JPEGs to
// wiki/versions/<version>/images/ (the version under development by default). Rerun it when a release changes how things look.
// Needs Playwright with Chromium: NODE_PATH=$(npm root -g) node wiki/capture.js [version] [only-prefix]
// (e.g. `node wiki/capture.js 1.3 mob-` retakes only the mob portraits). Takes several minutes: each view waits for its terrain to load.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PW || "playwright");
const ROOT = path.resolve(__dirname, "..");
const versions = JSON.parse(fs.readFileSync(path.join(__dirname, "versions.json"), "utf8")).versions;
const ver = process.argv[2] || (versions.find(v => v.status === "development") || versions[0]).id;
const only = process.argv[3] || "";
const OUT = path.join(__dirname, "versions", ver, "images");
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT + path.sep)) { res.writeHead(404).end(); return; }
  fs.readFile(f, (err, data) => err ? res.writeHead(404).end() : res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }).end(data));
});

server.listen(0, "127.0.0.1", async () => {
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const pg = await b.newPage({ viewport: { width: 960, height: 540 } });
  pg.on("pageerror", e => console.log("PAGEERROR", e.message));
  const three = path.join(ROOT, ".three-test.min.js");   // the CDN may be out of reach (CI, sandboxes): use the local copy when there is one
  if (fs.existsSync(three)) await pg.route("**/three.min.js", r => r.fulfill({ path: three, contentType: "text/javascript" }));
  await pg.route("https://fonts.**", r => r.abort());
  await pg.goto(`http://127.0.0.1:${server.address().port}/index.html#seed1337`);   // the planet (spec r14-22)
  await pg.waitForFunction(() => window.BF && BF.player && BF.player.start && !BF.preparing, null, { timeout: 180000 });   // after its river step
  await pg.waitForTimeout(2000);
  await pg.evaluate(() => {
    BF.player.start();
    for (const c of ["/gamemode creative", "/time set noon", "/weather clear 100000"]) BF.commands.execute(c);
  });
  await pg.addStyleTag({ content: "#ui, #debug, #vlog { display: none !important; }" });
  // camera only: freeze the simulation (paused: the world still loads and renders), hide the hand and the block outline
  const look = (x, y, z, yaw, pitch, dist) => pg.evaluate(([x, y, z, yaw, pitch, dist]) => {
    BF.state.paused = false;
    BF.commands.execute("/time set noon");
    BF.player.teleport(x, y, z);
    BF.player.setLook(yaw, pitch);
    if (dist) BF.world.setViewDist(dist);
    BF.state.paused = true;
    for (const c of [...BF.camera.children]) { c.visible = false; c.scale.setScalar(1e-6); } /* the view model is re-shown every frame: shrink it away */
    for (const c of BF.scene.children) if (c.isLineSegments || (c.userData && c.userData.setCoverage)) c.visible = false;   // outline and clouds
  }, [x, y, z, yaw, pitch, dist || 0]);
  const shot = async (name, wait) => {
    await pg.waitForTimeout(wait);
    // a planet frame is slow in SwiftShader: wait until the chunks in view are made and meshed (and the distant rings sampled), not a fixed time
    await pg.waitForFunction(() => BF.world.queueLength === 0 &&
      !(BF.lod && BF.lod.stats && BF.lod.stats().pending > 0), null, { timeout: 300000, polling: 1000 }).catch(async () => console.log("  (still loading after 300 s)", JSON.stringify(await pg.evaluate(() => ({ q: BF.world.queueLength, meshed: BF.world.meshedCount(), size: BF.world.chunks.size, lod: BF.lod && BF.lod.stats && BF.lod.stats().pending })))));
    // a moment of live frames: the sky's fog takes in the distant rings now built, and the camera takes its frame for the face it is on
    await pg.evaluate(() => { BF.state.paused = false; });
    await pg.waitForTimeout(400);
    await pg.evaluate(() => { BF.state.paused = true; for (const c of [...BF.camera.children]) { c.visible = false; c.scale.setScalar(1e-6); } });
    await pg.waitForTimeout(1500);
    await pg.evaluate(() => {   // the paused sky never moves its fog out to the view distance: do it here, further for a camera high above the ground
      if (BF.lod && BF.lod.radius && BF.lod.radius() > 0) return;   // on the planet the distant terrain carries on past the chunks: keep the game's own fog
      const d = BF.world.viewDist * BF.CS, c = BF.camera.position, above = Math.max(0, c.y - Math.max(BF.worldgen.heightAt(Math.floor(c.x), Math.floor(c.z)), BF.SEA));
      BF.scene.fog.near = d * 0.35 + above; BF.scene.fog.far = d * 0.65 + above;   // inside the loaded area, so its edge never shows
      if (BF.camera.far < BF.scene.fog.far + 64) { BF.camera.far = BF.scene.fog.far + 64; BF.camera.updateProjectionMatrix(); }
    });
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 82, timeout: 180000 });   // a planet frame in SwiftShader can take seconds
    console.log("took", name);
  };
  const want = name => name.startsWith(only);

  // ---- places, found from the world generator (deterministic for the seed)
  const P = await pg.evaluate(() => {
    // around the spawn: (0, 0) is off the planet's atlas. Atlas points within N of a face run on into its neighbours (the unfold)
    const W = BF.worldgen, found = {}, s = BF.spawnPoint || BF.player.position, sx = Math.floor(s.x), sz = Math.floor(s.z);
    const same = (x, z, name) => [[48, 0], [-48, 0], [0, 48], [0, -48], [34, 34], [-34, -34]].every(([dx, dz]) => W.biomeAt(x + dx, z + dz).name === name);
    for (let r = 0; r < 14000; r += 96) {
      const n = Math.max(1, Math.round(r / 96 * 6));
      for (let a = 0; a < n; a++) {
        const x = sx + Math.round(Math.cos(a / n * 2 * Math.PI) * r), z = sz + Math.round(Math.sin(a / n * 2 * Math.PI) * r), b = W.biomeAt(x, z);
        if (!found[b.name] && same(x, z, b.name)) found[b.name] = [x, z];
      }
    }
    // the steepest step of the escarpment near the first mountains found: the biggest height change over 64 blocks
    let esc = null, best = 0;
    for (let x = sx - 4000; x <= sx + 4000; x += 64) for (let z = sz - 4000; z <= sz + 4000; z += 64) {
      const d = W.heightAt(x + 64, z) - W.heightAt(x, z);
      if (Math.abs(d) > best && W.heightAt(x, z) > BF.SEA) { best = Math.abs(d); esc = [x, z, d > 0 ? 1 : -1]; }
    }
    const vs = [];
    for (const v of W.villagesNear(sx, sz, 6000).sort((a, b) => BF.planet.distance(s, a) - BF.planet.distance(s, b))) vs.push({ x: v.x, z: v.z, biome: W.biomeAt(v.x, v.z).name, r: Math.max(v.maxX - v.minX, v.maxZ - v.minZ) || 120 });
    return { found, esc, vs };
  });
  // ---- biome facts for the biome pages (versions/<id>/biomes.json): over a 16000-block square around spawn, sampled every 64 blocks:
  // share of the area, ground height, climate, precipitation at ground level, which biomes it borders (checked 16 blocks over) and villages
  if (want("biomes")) {
    const facts = await pg.evaluate(() => {
      const W = BF.worldgen, out = {}, R = 8000, S = 64, s = BF.spawnPoint || BF.player.position, sx = Math.floor(s.x / S) * S, sz = Math.floor(s.z / S) * S;
      let n = 0;
      const rec = id => out[id] || (out[id] = { n: 0, hs: [], t: 0, hu: 0, precip: [0, 0, 0], next: {}, villages: 0, at: null });
      for (let x = sx - R; x < sx + R; x += S) for (let z = sz - R; z < sz + R; z += S) {
        const b = W.biomeAt(x, z), r = rec(b.id), h = Math.round(b.height);
        r.n++; n++; r.t += b.temperature; r.hu += b.humidity;
        r.hs.push(h);
        r.precip[BF.weather.precipAt(x, z, Math.max(h, BF.SEA) + 1)]++;
        for (const [dx, dz] of [[16, 0], [0, 16]]) { const o = W.biomeAt(x + dx, z + dz).id; if (o !== b.id) { r.next[o] = (r.next[o] || 0) + 1; rec(o).next[b.id] = (rec(o).next[b.id] || 0) + 1; } }
        if (!r.at || Math.hypot(x - sx, z - sz) < Math.hypot(r.at[0] - sx, r.at[1] - sz)) r.at = [x, z];
      }
      for (const v of W.villagesNear(sx, sz, R)) rec(W.biomeAt(v.x, v.z).id).villages++;
      const res = {};
      for (const [id, r] of Object.entries(out)) {
        if (!r.n) continue;
        r.hs.sort((a, b) => a - b);
        const q = f => r.hs[Math.min(r.hs.length - 1, Math.floor(f * r.hs.length))];
        res[id] = { share: +(r.n / n).toFixed(4), height: [q(0.05), q(0.5), q(0.95)], temperature: +(r.t / r.n).toFixed(2), humidity: +(r.hu / r.n).toFixed(2),
          precip: { none: +(r.precip[0] / r.n).toFixed(2), rain: +(r.precip[1] / r.n).toFixed(2), snow: +(r.precip[2] / r.n).toFixed(2) },
          borders: r.next, villages: r.villages, near: r.at };
      }
      return { seed: BF.state.seed, square: 2 * R, step: S, biomes: res };
    });
    fs.writeFileSync(path.join(__dirname, "versions", ver, "biomes.json"), JSON.stringify(facts) + "\n");
    console.log("wrote biomes.json");
  }
  const H = (x, z) => pg.evaluate(([x, z]) => Math.max(BF.worldgen.heightAt(x, z), BF.worldgen.waterLevelAt(x, z)), [x, z]);

  // biomes: from 30 blocks above the ground, looking out and a little down
  for (const [name, [x, z]] of Object.entries(P.found)) {
    if (/^Deep |^Frozen River|^(Cold|Lukewarm|Warm|Frozen) Ocean/.test(name)) continue;   // one ocean and one river picture is enough
    const n = "biome-" + slug(name);
    if (!want(n)) continue;
    await look(x, (await H(x, z)) + 30, z, 0.7, -0.3, 6);   // 6 chunks of blocks, the distant terrain beyond (a planet view of 10 takes minutes to load here)
    await shot(n, 9000);
    await look(x, (await H(x, z)) + 2.2, z, 2.4, -0.06, 6);   // and standing in it
    await shot(n + "-ground", 2500);
  }
  // rivers: high above one, looking along it; the coast; mountains from afar; the escarpment from below
  const river = P.found.River;
  if (river && want("terrain-river")) { await look(river[0], (await H(river[0], river[1])) + 60, river[1], 0.4, -0.55, 8); await shot("terrain-river", 30000); }
  const beach = P.found.Beach;
  if (beach && want("terrain-coast")) { await look(beach[0], (await H(beach[0], beach[1])) + 40, beach[1], 2.2, -0.35, 8); await shot("terrain-coast", 30000); }
  if (P.esc && want("terrain-escarpment")) {
    const [x, z, dir] = P.esc, lowX = dir > 0 ? x - 80 : x + 144;
    await look(lowX, (await H(lowX, z)) + 25, z, dir > 0 ? -Math.PI / 2 : Math.PI / 2, 0.15, 8);
    await shot("terrain-escarpment", 30000);
  }
  // villages: the nearest one from the air, and one of each biome style
  const styles = new Set();
  for (const v of P.vs) {
    if (styles.has(v.biome)) continue;
    styles.add(v.biome);
    const n = "village-" + slug(v.biome);
    if (!want(n)) continue;
    const d = Math.max(50, v.r * 0.55);
    await look(v.x - d * 0.8, (await H(v.x, v.z)) + d, v.z - d * 0.8, -2.36, -0.8, 8);
    await shot(n, 40000);
  }

  // the planet itself (spec r14-25): the curve of the ground 6,000 up, and the whole globe from orbit (off the planet, north at the top)
  if (want("planet-")) {
    const s = await pg.evaluate(() => { const p = BF.spawnPoint || BF.player.position; return [p.x, p.z]; });
    await look(s[0], (await H(s[0], s[1])) + 6000, s[1], 0.7, -0.35, 6);
    await shot("planet-curve", 20000);
    await pg.waitForFunction(() => !BF.globe || !BF.globe.active || BF.globe.built === BF.globe.tiles.length, null, { timeout: 600000, polling: 2000 }).catch(() => console.log("  (globe not finished)"));
    await look(s[0], 200000, s[1], 0, -Math.PI / 2, 6);
    await shot("planet-orbit", 15000);
  }
  // ---- portraits on a grass platform in the sky over the spawn area, one mob or villager each, the sky behind
  const port = await pg.evaluate(() => {
    const s = BF.spawnPoint || BF.player.position, ox = Math.floor(s.x) + 64, oz = Math.floor(s.z) + 64, y = Math.round(BF.worldgen.heightAt(ox, oz)) + 60;
    BF.state.paused = false;
    BF.player.teleport(ox, y + 3, oz - 6);
    return { ox, oz, y };
  });
  await pg.waitForTimeout(6000);
  const subjects = await pg.evaluate(() => BF.mobs.types.filter(t => t !== "villager").map(t => ["mob-" + t, t, null])
    .concat(BF.mobs.professions.map(p => ["villager-" + p, "villager", p])));
  let i = 0;
  for (const [name, type, prof] of subjects) {
    if (!want(name)) continue;
    const big = type === "iron_golem" || type === "horse", x = port.ox + (i++ % 20) * 24, z = port.oz;
    await pg.evaluate(([x, z, y, type, prof, big, YAW]) => {
      BF.state.paused = false;
      const p = BF.player.position, c = (n, at) => "~" + (n - Math.floor(at));   // relative: commands read u y v on the planet's faces (spec r14-18)
      BF.commands.execute(`/fill ${c(x - 3, p.x)} ${c(y, p.y)} ${c(z - 3, p.z)} ${c(x + 3, p.x)} ${c(y, p.y)} ${c(z + 3, p.z)} grass`);
      const m = BF.mobs.spawn(type, x + 0.5, y + 1, z + 0.5, prof || undefined);
      if (m) { m.yaw = YAW; if (m.model) m.model.rotation.set(0, m.yaw, 0); }
      const back = big ? 5 : 3.1;
      BF.player.teleport(x + 0.5 + back * 0.5, y + (big ? 2.4 : 1.6), z + 0.5 - back * 0.87);
      BF.player.setLook(Math.PI - Math.PI / 6, big ? -0.22 : -0.28);   // looking back at the subject: direction (-sin yaw, -cos yaw)
    }, [x, z, port.y, type, prof, big, +(process.env.YAW || 2.1)]);
    await pg.waitForTimeout(400);
    await pg.evaluate(() => { BF.state.paused = true; for (const c of [...BF.camera.children]) { c.visible = false; c.scale.setScalar(1e-6); } /* the view model is re-shown every frame: shrink it away */ for (const c of BF.scene.children) if (c.isLineSegments || (c.userData && c.userData.setCoverage)) c.visible = false; });
    await pg.waitForTimeout(600);
    await pg.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 85, clip: { x: 260, y: 50, width: 420, height: 400 }, timeout: 180000 });
    console.log("took", name);
  }
  await b.close();
  server.close();
});
