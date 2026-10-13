#!/usr/bin/env node
// Takes Blockfieldpedia's pictures with the game itself: a portrait of every mob and villager profession, and a view of every biome,
// rivers, mountains, the coast and villages, in a fresh world (seed 1337, the default generators). Writes JPEGs to
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
  await pg.goto(`http://127.0.0.1:${server.address().port}/index.html#seed1337`);
  await pg.waitForFunction(() => window.BF && BF.player && BF.player.start, null, { timeout: 60000 });
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
    await pg.evaluate(() => {   // the paused sky never moves its fog out to the view distance: do it here, further for a camera high above the ground
      const d = BF.world.viewDist * BF.CS, c = BF.camera.position, above = Math.max(0, c.y - Math.max(BF.worldgen.heightAt(Math.floor(c.x), Math.floor(c.z)), BF.SEA));
      BF.scene.fog.near = d * 0.35 + above; BF.scene.fog.far = d * 0.65 + above;   // inside the loaded area, so its edge never shows
      if (BF.camera.far < BF.scene.fog.far + 64) { BF.camera.far = BF.scene.fog.far + 64; BF.camera.updateProjectionMatrix(); }
    });
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 82 });
    console.log("took", name);
  };
  const want = name => name.startsWith(only);

  // ---- places, found from the world generator (deterministic for the seed)
  const P = await pg.evaluate(() => {
    const W = BF.worldgen, found = {};
    const same = (x, z, name) => [[48, 0], [-48, 0], [0, 48], [0, -48], [34, 34], [-34, -34]].every(([dx, dz]) => W.biomeAt(x + dx, z + dz).name === name);
    for (let r = 0; r < 14000; r += 96) {
      const n = Math.max(1, Math.round(r / 96 * 6));
      for (let a = 0; a < n; a++) {
        const x = Math.round(Math.cos(a / n * 2 * Math.PI) * r), z = Math.round(Math.sin(a / n * 2 * Math.PI) * r), b = W.biomeAt(x, z);
        if (!found[b.name] && same(x, z, b.name)) found[b.name] = [x, z];
      }
    }
    // the steepest step of the escarpment near the first mountains found: the biggest height change over 64 blocks
    let esc = null, best = 0;
    for (let x = -4000; x <= 4000; x += 64) for (let z = -4000; z <= 4000; z += 64) {
      const d = W.heightAt(x + 64, z) - W.heightAt(x, z);
      if (Math.abs(d) > best && W.heightAt(x, z) > 0) { best = Math.abs(d); esc = [x, z, d > 0 ? 1 : -1]; }
    }
    const vs = [];
    for (const v of W.villagesNear(0, 0, 6000)) vs.push({ x: v.x, z: v.z, biome: W.biomeAt(v.x, v.z).name, r: Math.max(v.maxX - v.minX, v.maxZ - v.minZ) || 120 });
    return { found, esc, vs };
  });
  // ---- biome facts for the biome pages (versions/<id>/biomes.json): over a 16000-block square around spawn, sampled every 64 blocks:
  // share of the area, ground height, climate, precipitation at ground level, which biomes it borders (checked 16 blocks over) and villages
  if (want("biomes")) {
    const facts = await pg.evaluate(() => {
      const W = BF.worldgen, out = {}, R = 8000, S = 64;
      let n = 0;
      const rec = id => out[id] || (out[id] = { n: 0, hs: [], t: 0, hu: 0, precip: [0, 0, 0], next: {}, villages: 0, at: null });
      for (let x = -R; x < R; x += S) for (let z = -R; z < R; z += S) {
        const b = W.biomeAt(x, z), r = rec(b.id), h = Math.round(b.height);
        r.n++; n++; r.t += b.temperature; r.hu += b.humidity;
        r.hs.push(h);
        r.precip[BF.weather.precipAt(x, z, Math.max(h, BF.SEA) + 1)]++;
        for (const [dx, dz] of [[16, 0], [0, 16]]) { const o = W.biomeAt(x + dx, z + dz).id; if (o !== b.id) { r.next[o] = (r.next[o] || 0) + 1; rec(o).next[b.id] = (rec(o).next[b.id] || 0) + 1; } }
        if (!r.at || Math.hypot(x, z) < Math.hypot(r.at[0], r.at[1])) r.at = [x, z];
      }
      for (const v of W.villagesNear(0, 0, R)) rec(W.biomeAt(v.x, v.z).id).villages++;
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
    await look(x, (await H(x, z)) + 30, z, 0.7, -0.3, 10);
    await shot(n, 9000);
    await look(x, (await H(x, z)) + 2.2, z, 2.4, -0.06, 10);   // and standing in it
    await shot(n + "-ground", 2500);
  }
  // rivers: high above one, looking along it; the coast; mountains from afar; the escarpment from below
  const river = P.found.River;
  if (river && want("terrain-river")) { await look(river[0], (await H(river[0], river[1])) + 60, river[1], 0.4, -0.55, 10); await shot("terrain-river", 30000); }
  const beach = P.found.Beach;
  if (beach && want("terrain-coast")) { await look(beach[0], (await H(beach[0], beach[1])) + 40, beach[1], 2.2, -0.35, 10); await shot("terrain-coast", 30000); }
  if (P.esc && want("terrain-escarpment")) {
    const [x, z, dir] = P.esc, lowX = dir > 0 ? x - 80 : x + 144;
    await look(lowX, (await H(lowX, z)) + 25, z, dir > 0 ? -Math.PI / 2 : Math.PI / 2, 0.15, 12);
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
    await look(v.x - d * 0.8, (await H(v.x, v.z)) + d, v.z - d * 0.8, -2.36, -0.8, 16);
    await shot(n, 40000);
  }

  // ---- portraits on a grass platform in the sky over the spawn area, one mob or villager each, the sky behind
  const port = await pg.evaluate(() => {
    const y = Math.round(BF.worldgen.heightAt(64, 64)) + 60, ox = 64, oz = 64;
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
      BF.commands.execute(`/fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y} ${z + 3} grass`);
      const m = BF.mobs.spawn(type, x + 0.5, y + 1, z + 0.5, prof || undefined);
      if (m) { m.yaw = YAW; if (m.model) m.model.rotation.set(0, m.yaw, 0); }
      const back = big ? 5 : 3.1;
      BF.player.teleport(x + 0.5 + back * 0.5, y + (big ? 2.4 : 1.6), z + 0.5 - back * 0.87);
      BF.player.setLook(Math.PI - Math.PI / 6, big ? -0.22 : -0.28);   // looking back at the subject: direction (-sin yaw, -cos yaw)
    }, [x, z, port.y, type, prof, big, +(process.env.YAW || 2.1)]);
    await pg.waitForTimeout(400);
    await pg.evaluate(() => { BF.state.paused = true; for (const c of [...BF.camera.children]) { c.visible = false; c.scale.setScalar(1e-6); } /* the view model is re-shown every frame: shrink it away */ for (const c of BF.scene.children) if (c.isLineSegments || (c.userData && c.userData.setCoverage)) c.visible = false; });
    await pg.waitForTimeout(600);
    await pg.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 85, clip: { x: 260, y: 50, width: 420, height: 400 } });
    console.log("took", name);
  }
  await b.close();
  server.close();
});
