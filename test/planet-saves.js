// @ci integration suite=ui timeout=900
// New worlds are planets, and saves (spec r14-19): save.create makes a generator 4 world saved as version 2; a save made with the
// player, a boat and mobs on face 0 and edits on both sides of a face edge comes back exactly; the spawn is dry temperate or
// subtropical land at least 5 km from every face edge and 20 km from every corner, the same each time; a 1.3 (version 1) world is
// listed greyed with only Delete, won't open from the list and save.load refuses it; creating a world from the menu makes a planet;
// #seed<n> boots a planet, and since the flat generators were retired (r14-24) a #seed<n>gen3 hash is not read: the default planet boots.
// node test/run.js /tmp/ps test/planet-saves.js
module.exports = async (pg, out) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await pg.evaluate(() => {
    window.__errs = []; addEventListener("error", e => window.__errs.push(e.message));
    window.settle = async (min) => {
      await new Promise(r => setTimeout(r, min || 1000));
      for (let i = 0; i < 160 && BF.world.queueLength > 0; i++) await new Promise(r => setTimeout(r, 250));
      await new Promise(r => setTimeout(r, 300));
    };
  });

  // ---- spawn rules, on a few seeds (deterministic)
  const sp = await pg.evaluate(() => {
    const P = BF.planet, PG = BF.planetgen, out = [];
    for (const seed of [1337, 42, 7, 99999]) {
      BF.newWorld(seed, { gen: 4 });
      const s = BF.spawnPoint, x = Math.floor(s.x), z = Math.floor(s.z), c = P.canon(x, z, {});
      const edge = Math.min(c.u, c.v, P.N - 1 - c.u, P.N - 1 - c.v);
      const d = P.dir(c.f, c.u, c.v, [0, 0, 0]), corner = PG.cornerDist(d[0], d[1], d[2]);
      const h = BF.worldgen.heightAt(x, z), dry = h > BF.SEA + 1 && h >= BF.worldgen.waterLevelAt(x, z);
      const band = BF.worldgen.bandAt(x, z), again = PG.spawnSearch();
      const ll = P.latLonAt(x, z);
      out.push({ seed, f: c.f, lat: +ll.lat.toFixed(2), edge: Math.round(edge), corner: Math.round(corner), dry, band, same: again[0] === x && again[1] === z, ok: PG.spawnOK(x, z, true) });
    }
    return out;
  });
  console.log("spawns " + JSON.stringify(sp));
  check(sp.every(s => s.dry && (s.band === 2 || s.band === 3)), "every spawn is on dry temperate or subtropical land");
  check(sp.every(s => s.edge >= 5000 && s.corner >= 20000), "every spawn is at least 5 km from any face edge and 20 km from any corner");
  check(sp.every(s => s.same && s.ok), "the spawn is the same each time for a seed");
  check(sp.filter(s => s.f === 4).length >= 3, "spawns are on face 4 when possible");

  // ---- save.create makes a planet; save and restore across faces and an edge
  const sv = await pg.evaluate(async () => {
    const r = {}, P = BF.planet, N = P.N, W = BF.world, B = BF.B;
    BF.player.start();
    const meta = await BF.save.create({ name: "planet save", seed: "4242", gameMode: "creative" });
    r.gen = BF.state.gen; r.metaGen = meta.gen;
    BF.mobs.spawning = false;
    // somewhere on face 0, 12 blocks from its +u edge
    const at = P.atlas(0, N - 12, 70000, {}), g = Math.floor(BF.mapview.surfaceAt(Math.floor(at.x), Math.floor(at.z)));
    const y0 = g + 6;
    BF.commands.execute(`/tp face 0 ${N - 12} 70000 ${y0 + 3}`);
    BF.player.setFlying(true);
    W.setViewDist(4);
    await settle(2500);
    const x0 = Math.floor(at.x), z0 = Math.floor(at.z);
    // a platform with a pool for the boat, and edits on both sides of the edge (the far side through its margin address)
    for (let z = z0 - 3; z <= z0 + 3; z++) for (let x = x0 - 3; x <= x0 + 3; x++) { W.setBlock(x, y0, z, B.stone); W.setBlock(x, y0 + 1, z, 0); W.setBlock(x, y0 + 2, z, 0); }
    for (let z = z0 - 1; z <= z0 + 1; z++) for (let x = x0 - 1; x <= x0 + 1; x++) W.setBlock(x, y0 + 1, z, B.water);
    W.setBlock(x0 + 10, y0 + 4, z0, B.glass);          // u N-2 on face 0
    W.setBlock(x0 + 14, y0 + 4, z0, B.bricks);         // u N+2: the neighbouring face, through the margin
    const far = P.canonCell(x0 + 14, z0, {});
    r.farFace = far.f;
    // freeze the world (0x) so the mobs can't wander between the save and the checks; a pig walking off this
    // raised platform and falling 6 blocks made the check flaky under CI load
    BF.warp.freeze();
    const boat = BF.boats.spawn("birch", x0 + 0.5, y0 + 1.739, z0 + 0.5, 0.7);
    const pig = BF.mobs.spawn("pig", x0 + 2.5, y0 + 1, z0 - 2.5), cow = BF.mobs.spawn("cow", x0 - 2.5, y0 + 1, z0 + 2.5);
    pig.ai = pig.ai || {}; cow.ai = cow.ai || {};
    BF.player.teleport(x0 + 0.5, y0 + 3, z0 + 2.5); BF.player.setLook(1.1, -0.3);
    const ok = await BF.save.saveNow();
    r.saved = ok;
    const before = { p: { x: BF.player.position.x, y: BF.player.position.y, z: BF.player.position.z, yaw: BF.player.yaw }, pig: { x: pig.position.x, z: pig.position.z }, cow: { x: cow.position.x, z: cow.position.z } };
    // the stored snapshot
    const raw = await new Promise((res, rej) => { const q = indexedDB.open("blockfield"); q.onsuccess = () => { const t = q.result.transaction(["data", "worlds"], "readonly"); const a = t.objectStore("data").get(meta.id), m = t.objectStore("worlds").get(meta.id); t.oncomplete = () => res({ data: a.result, meta: m.result }); t.onerror = () => rej(t.error); }; q.onerror = () => rej(q.error); });
    r.version = raw.data.version; r.dataGen = raw.data.gen; r.metaVersion = raw.meta.version; r.metaGen2 = raw.meta.gen;
    r.playerCanonical = (() => { const c = P.canon(raw.data.player.x, raw.data.player.z, {}); return c.x === raw.data.player.x && c.z === raw.data.player.z && c.f === 0; })();
    // somewhere else (another planet), then back
    BF.newWorld(1);
    await settle(500);
    let refreeze = true;
    BF.on("worldLoaded", () => { if (refreeze) BF.warp.freeze(); });   // straight after restore (which resets the speed), before any frame runs
    await BF.save.load(meta.id);
    refreeze = false;
    r.frozen = BF.warp.frozen;
    BF.mobs.spawning = false;
    // wild mobs come back with their chunks, in the wildlife step; still frozen, wait for the chunks (up to 20 s on a slow
    // machine) and run that step once by hand, so they are checked where they were put, before any AI step
    for (let i = 0; i < 40 && !(W.isLoaded(Math.floor(before.pig.x), Math.floor(before.pig.z)) && W.isLoaded(Math.floor(before.cow.x), Math.floor(before.cow.z))); i++) await settle(500);
    BF.wildlife.update(0);
    await settle(500);
    const p = BF.player.position, pc = P.canon(p.x, p.z, {});
    r.player = { face: pc.f, d: Math.hypot(p.x - before.p.x, p.y - before.p.y, p.z - before.p.z), dyaw: Math.abs(BF.player.yaw - before.p.yaw) };
    r.gen2 = BF.state.gen;
    r.glass = W.getBlock(x0 + 10, y0 + 4, z0) === B.glass;
    r.bricks = W.getBlock(x0 + 14, y0 + 4, z0) === B.bricks && W.getBlock(far.x, y0 + 4, far.z) === B.bricks;
    const lb = BF.boats.list.find(b => b.wood === "birch");
    r.boat = lb ? { d: Math.hypot(lb.pos.x - (x0 + 0.5), lb.pos.z - (z0 + 0.5)), face: P.canon(lb.pos.x, lb.pos.z, {}).f } : null;
    const near = (t, q) => BF.mobs.list.filter(m => m.type === t && !m.dead).map(m => Math.hypot(m.position.x - q.x, m.position.z - q.z)).sort((a, b) => a - b)[0];
    r.pig = near("pig", before.pig); r.cow = near("cow", before.cow);
    r.meta = meta.id;
    BF.warp.reset();
    return r;
  });
  console.log("save " + JSON.stringify(sv));
  check(sv.gen === 4 && sv.metaGen === 4, "save.create makes a planet (generator 4)");
  check(sv.saved && sv.version === 2 && sv.dataGen === 4 && sv.metaVersion === 2 && sv.metaGen2 === 4, "it is saved as version 2 with gen 4");
  check(sv.playerCanonical, "positions are saved as canonical atlas coordinates");
  check(sv.gen2 === 4 && sv.player.face === 0 && sv.player.d < 0.5 && sv.player.dyaw < 0.01, "the player comes back on face 0 where they were, facing the same way");
  check(sv.farFace !== 0 && sv.glass && sv.bricks, "edits on both sides of the face edge come back");
  check(sv.boat && sv.boat.d < 0.6 && sv.boat.face === 0, "the boat comes back");
  check(sv.frozen && sv.pig < 0.1 && sv.cow < 0.1, "the mobs come back where they were");

  // ---- a 1.3 world in the list: greyed, Delete only, won't open
  const oldLoad = await pg.evaluate(async () => {
    const now = Date.now(), id = "wold" + now.toString(36);
    const meta = { id, name: "My 1.3 world", seed: 77, gameMode: "survival", gen: 3, biomeScale: 2, villages: 10, created: now - 1000, lastPlayed: now + 1000 };
    const data = { version: 1, seed: 77, gen: 3, biomeScale: 2, villages: 10, time: { t: 0.3, day: 2 }, player: { x: 8, y: 80, z: 8 }, edits: {} };
    await new Promise((res, rej) => { const q = indexedDB.open("blockfield"); q.onsuccess = () => { const t = q.result.transaction(["data", "worlds"], "readwrite"); t.objectStore("worlds").put(meta); t.objectStore("data").put(data, id); t.oncomplete = res; t.onerror = () => rej(t.error); }; q.onerror = () => rej(q.error); });
    window.__oldId = id;
    // save.load refuses it too (there is no flat generator to open it with), and leaves the world as it was
    const seed0 = BF.state.seed;
    const msg = await BF.save.load(id).then(() => "opened", e => e.message);
    return { msg, kept: BF.state.seed === seed0 && BF.state.gen === 4 };
  });
  check(/can't be opened in 1\.4/.test(oldLoad.msg) && oldLoad.kept, "save.load refuses a 1.3 world (" + oldLoad.msg + ") and the world stays as it was");
  await pg.reload();
  await pg.waitForTimeout(5000);
  const list = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll(".bfp-world")].map(r => ({ id: r.dataset.id, old: r.classList.contains("old"), text: r.textContent, btns: [...r.querySelectorAll("button")].map(b => b.dataset.act).filter(a => a !== "copy-seed") }));
    const m = /gen(\d)/.exec(location.hash);
    return { rows, gen: BF.state.gen, want: m ? +m[1] : 4, hash: location.hash };
  });
  console.log("list " + JSON.stringify(list.rows.map(r => [r.old, r.btns.join("/"), r.text.slice(0, 80)])));
  const old = list.rows.find(r => /My 1\.3 world/.test(r.text)), mine = list.rows.find(r => /planet save/.test(r.text));
  check(old && old.old && /Made with Blockfield 1\.3, can't be opened in 1\.4/.test(old.text) && old.btns.join() === "delete", "a 1.3 world is listed greyed, with only Delete");
  check(mine && !mine.old && mine.btns.includes("play"), "a planet world is listed normally");
  check(list.gen === list.want, "the test page boots the generator its hash names (" + list.hash + ")");
  if (out) await pg.screenshot({ path: `${out}-worlds.png` });
  // Delete still works on it
  await pg.evaluate(() => document.querySelector('.bfp-world.old [data-act="delete"]').click());
  await pg.waitForTimeout(200);
  await pg.evaluate(() => document.querySelector('[data-act="delete-ok"]').click());
  await pg.waitForTimeout(800);
  const gone = await pg.evaluate(async () => !(await BF.save.list()).some(w => /My 1\.3 world/.test(w.name)));
  check(gone, "Delete removes the 1.3 world");

  // ---- creating a world from the menu makes a planet
  await pg.evaluate(() => document.querySelector('[data-act="show-create"]').click());
  await pg.waitForTimeout(200);
  await pg.evaluate(() => { const f = document.querySelector(".bfp-view-create"); f.elements.name.value = "From the menu"; f.elements.seed.value = "31337"; f.querySelector('button[type="submit"]').click(); });
  // (a new seed works out its rivers first: wait for the loading step and the save)
  await pg.waitForFunction(() => !BF.preparing && BF.save.current && BF.save.current.name === "From the menu", null, { timeout: 120000 }).catch(() => {});
  const made = await pg.evaluate(() => ({ gen: BF.state.gen, metaGen: BF.save.current && BF.save.current.gen, name: BF.save.current && BF.save.current.name, scale: BF.state.biomeScale }));
  console.log("created " + JSON.stringify(made));
  check(made.gen === 4 && made.metaGen === 4 && made.name === "From the menu", "creating a world from the menu makes a planet");

  // ---- biome size stretches the climate: the climate latitude wanders more slowly along 35N at Vast than at Small
  const bs = await pg.evaluate(() => {
    const P = BF.planet, o = {}, tv = scale => {
      BF.newWorld(1337, { gen: 4, biomeScale: scale });
      let sum = 0, prev = null;
      for (let lon = -40; lon <= 40; lon += 0.1) {
        const a = P.atlasOfLatLon(35, lon, {});
        BF.planetgen.climate(Math.floor(a.x), Math.floor(a.z), 0, o);
        if (prev != null) sum += Math.abs(o.el - prev);
        prev = o.el;
      }
      return +sum.toFixed(1);
    };
    return { small: tv(1), vast: tv(6) };
  });
  console.log("climate-latitude wander along 35N (total degrees): " + JSON.stringify(bs));
  check(bs.vast < bs.small * 0.6, "a bigger biome size gives broader climate patterns on the planet");

  // ---- a spawn point or saved position off the planet (past the atlas, or in a corner wedge) falls back to the world spawn
  const fb = await pg.evaluate(async () => {
    const P = BF.planet, N = P.N, W = BF.world;
    await BF.prepareWorld(1337, 4); BF.newWorld(1337, { gen: 4 }); BF.player.start();
    const ws = BF.worldSpawn ? { x: BF.worldSpawn.x, z: BF.worldSpawn.z } : null;
    const near = (p, q) => Math.hypot(p.x - q.x, p.z - q.z) < 2;
    const r = { ws, wsOk: !!ws && BF.planetgen.spawnOK(Math.floor(ws.x), Math.floor(ws.z), true) };
    const at = async (sp, o) => {
      BF.spawnPoint = sp;
      BF.player.deserialize(Object.assign({ health: 20 }, o));
      await new Promise(res => setTimeout(res, 300));
      const p = BF.player.position;
      return { p: { x: p.x, z: p.z }, sp: BF.spawnPoint && { x: BF.spawnPoint.x, z: BF.spawnPoint.z } };
    };
    // past the atlas (the old world border is 3e7, the atlas ends near 2.9 million)
    const far = await at({ x: 2.95e6 + 0.5, y: 64, z: 0.5 }, { x: 2.95e6 + 0.5, y: 70, z: 0.5 });
    r.far = { pos: near(far.p, ws), sp: near(far.sp, ws), at: far };
    // in the wedge past a cube corner (face 0's -u,-v corner, through its margin)
    const wg = P.atlas(0, -20, -20, {});
    const wedge = await at({ x: wg.x + 0.5, y: 64, z: wg.z + 0.5 }, { x: wg.x + 0.5, y: 70, z: wg.z + 0.5 });
    r.wedgeIsOff = !W.canonXZ(wg.x, wg.z);
    r.wedge = { pos: near(wedge.p, ws), sp: near(wedge.sp, ws) };
    // the old fallback spot, atlas 8.5, 8.5: face 0's corner margin, not land
    const old = await at({ x: 8.5, z: 8.5 }, { x: 8.5, y: 70, z: 8.5 });
    r.old = { pos: near(old.p, ws), sp: near(old.sp, ws) };
    // no spawn point at all: dying sends you to the world spawn
    BF.spawnPoint = null;
    BF.player.deserialize({ x: ws.x + 300, y: 200, z: ws.z, health: 20 });
    BF.player.kill(); await new Promise(res => setTimeout(res, 300));
    const btn = document.querySelector('[data-act="respawn"]'); if (btn) btn.click();
    await new Promise(res => setTimeout(res, 800));
    r.respawn = near(BF.player.position, ws);
    // a position in a margin that shows a face is kept (still in the world)
    const mg = P.atlas(4, N + 30, N / 2, {});
    const keep = await at({ x: ws.x, y: 64, z: ws.z }, { x: mg.x + 0.5, y: 900, z: mg.z + 0.5 });
    const c = P.canon(mg.x + 0.5, mg.z + 0.5, {});
    r.margin = Math.hypot(keep.p.x - (mg.x + 0.5), keep.p.z - (mg.z + 0.5)) < 1 || Math.hypot(keep.p.x - c.x, keep.p.z - c.z) < 1;
    return r;
  });
  console.log("fallback " + JSON.stringify(fb));
  check(fb.wsOk, "the world spawn is kept as BF.worldSpawn, on dry temperate or subtropical land");
  check(fb.far.pos && fb.far.sp, "a saved position and spawn point past the atlas fall back to the world spawn");
  check(fb.wedgeIsOff && fb.wedge.pos && fb.wedge.sp, "a saved position and spawn point in a corner wedge fall back to the world spawn");
  check(fb.old.pos && fb.old.sp, "atlas 8.5, 8.5 (the old fallback, a corner margin) is off the world too");
  check(fb.respawn, "with no spawn point, respawning goes to the world spawn");
  check(fb.margin, "a saved position in a margin that shows a face is kept");

  // ---- switching worlds: the drawing's ground height (view.groundAt, cached per 32-block cell) is the new world's, not the old one's
  const gh = await pg.evaluate(async () => {
    await BF.prepareWorld(1337, 4); BF.newWorld(1337, { gen: 4 });
    const at = { x: BF.worldSpawn.x + 3000, z: BF.worldSpawn.z + 2000 };
    const before = BF.view.groundAt(at.x, at.z);
    await BF.prepareWorld(42, 4); BF.newWorld(42, { gen: 4 });
    const after = BF.view.groundAt(at.x, at.z);
    let s = 0, n = 0;
    for (const [dx, dz] of [[0, 0], [48, 0], [-48, 0], [0, 48], [0, -48], [34, 34], [-34, 34], [34, -34], [-34, -34]]) { s += Math.max(BF.worldgen.heightAt(Math.floor(at.x + dx), Math.floor(at.z + dz)), BF.SEA); n++; }
    return { before, after, want: s / n };
  });
  console.log("groundAt " + JSON.stringify(gh));
  check(Math.abs(gh.before - gh.want) > 1 && Math.abs(gh.after - gh.want) < 0.01, "after a new world the view's ground height is the new world's (not cached from the old one)");

  // ---- #seed<n> boots a planet; #seed<n>gen3 is no longer read (the flat generators are gone): the default planet, seed 1337
  const url = pg.url().replace(/#.*$/, "");
  const booted = () => pg.waitForFunction(() => window.BF && BF.state && !BF.preparing && !document.getElementById("bf-loading"), null, { timeout: 120000 }).catch(() => {}).then(() => pg.waitForTimeout(1000));   // (a planet boot works out its rivers first)
  await pg.goto(url + "#seed42"); await pg.reload(); await booted();
  const h1 = await pg.evaluate(() => ({ gen: BF.state.gen, seed: BF.state.seed }));
  await pg.goto(url); await pg.reload(); await booted();
  const h0 = await pg.evaluate(() => BF.state.gen);
  await pg.goto(url + "#seed42gen3"); await pg.reload(); await booted();
  const h3 = await pg.evaluate(() => ({ gen: BF.state.gen, seed: BF.state.seed }));
  console.log("hash " + JSON.stringify({ h1, h0, h3 }));
  check(h1.gen === 4 && h1.seed === 42 && h0 === 4, "#seed42 and no hash boot planets");
  check(h3.gen === 4 && h3.seed === 1337, "#seed42gen3 (a retired flat generator) is not read: the default planet, seed 1337, boots");

  await pg.evaluate(async () => { for (const w of await BF.save.list()) await BF.save.remove(w.id); });
  const errs = await pg.evaluate(() => window.__errs || []);
  check(!errs.length, "no page errors" + (errs.length ? ": " + errs.join("; ") : ""));
  console.log(bad ? `FAILED ${bad}` : "all ok");
};
