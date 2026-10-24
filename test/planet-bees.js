// @ci integration suite=farming timeout=360 hosts=worker,server
// Bees across a face edge on the planet (js/bees.js, js/beekeeper.js): on planet seed 123, a beehive is put 4 blocks from an edge of the
// spawn face with its flowers only across the edge, on the next face (planted through margin addresses). Then:
//  - flowersNear lists the flowers past the edge in the hive's frame (margin addresses that read as flowers);
//  - by day its bees land on those flowers and bring honey home;
//  - crops past the edge within CROP_R of the hive grow faster (cropFactor at their canonical cell);
//  - the hive is found from the next face's side too (homeAt and playerUse through its margin address);
//  - bees are drawn where they are: each bee's instance sits by the player, seen from the player's frame;
//  - with a second hive across the edge, breaking the first sends its bees that are out to the second, put into its face's frame, and
//    they get home.
// node test/run.js /tmp/pb test/planet-bees.js [--host page|worker|server]
module.exports = async (pg) => {
  const lib = require('./lib');   // (lib.sim: where the simulation is, spec r15-43)
  // (run.js boots planet seed 123; another boot world is replaced by it here)
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  if (await pg.evaluate(() => BF.state.seed !== 123)) { await lib.newWorld(pg, 123, { gen: 4 }); await pg.evaluate(() => BF.player.start()); }
  await pg.waitForTimeout(2000);
  await pg.waitForFunction(() => !BF.preparing, null, { timeout: 180000, polling: 500 }).catch(() => {});
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const wait = (fn, arg, t = 60000) => lib.simWait(pg, fn, arg, t).then(v => !!v);
  // a dry land spot 4 blocks in from the low-u edge of the spawn face, near the player
  const site = await lib.sim(pg, () => {
    const P = BF.planet, p = BF.player.position, g = P.grid(p.x, p.z);
    for (let k = 0; k < 400; k++) {
      const v = Math.floor(g.v + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 37);
      const a = P.atlas(g.f, 4, v), h = BF.worldgen.heightAt(a.x, a.z);
      let dry = h > BF.SEA + 1;
      for (let d = -12; d <= 12 && dry; d += 4) { const c = P.canonCell(a.x + d, a.z + d, {}); dry = !c.off && BF.worldgen.heightAt(c.x, c.z) > BF.SEA + 1; }
      if (dry) return { f: g.f, x: a.x, z: a.z };
    }
    return null;
  });
  check(!!site, "a dry spot by an edge of the spawn face");
  if (!site) { console.log("FAIL planet-bees"); return; }
  await pg.evaluate(s => BF.player.spawn(s.x + 6.5, BF.worldgen.heightAt(s.x + 6, s.z) + 3, s.z + 0.5), site);   // (the page's body: the simulation follows it)
  await lib.sim(pg, () => { BF.sky.setTime(0.08); if (BF.weather && BF.weather.clear) BF.weather.clear(); });
  check(await wait(s => { const w = BF.world; for (let d = -30; d <= 30; d += 10) if (!w.isLoaded(s.x + d, s.z) || !w.isLoaded(s.x, s.z + d)) return false; return true; }, site, 90000), "the chunks on both sides of the edge are loaded");
  const set = await lib.sim(pg, s => {
    const P = BF.planet, w = BF.world, B = BF.B, BE = BF.bees, R = BE.R;
    const top = (x, z) => w.heightAt(x, z);
    // no flowers within reach on the hive's own face; poppies past the edge (margin addresses x - 5 .. x - 11; the edge is between x - 4 and x - 5)
    const hy = top(s.x, s.z) + 1;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const x = s.x + dx, z = s.z + dz, t = top(x, z);
      for (let y = t - 1; y <= t + 2; y++) if (BE.isFlower(w.getBlock(x, y, z))) w.setBlock(x, y, z, 0);
    }
    const planted = [];
    for (let i = 0; i < 8; i++) {
      const x = s.x - 5 - (i % 4) * 2, z = s.z - 3 + Math.floor(i / 4) * 6, t = top(x, z);
      if (BF.FLUID[w.getBlock(x, t, z)]) continue;
      w.setBlock(x, t, z, B.grass); w.setBlock(x, t + 1, z, B.poppy);
      planted.push([x, t + 1, z]);
    }
    w.setBlock(s.x, hy, s.z, B.beehive); w.setBlock(s.x, hy, s.z + 1, 0); w.setBlock(s.x, hy + 1, s.z, 0);
    const h = BE.homeAt(s.x, hy, s.z);
    h.bees = 12; h.honey = 0;
    const fl = BE.flowersNear(h, true);
    const past = fl.filter(p => P.face(p[0], p[2]) === s.f && P.canon(p[0] + 0.5, p[2] + 0.5, {}).f !== s.f);
    const read = past.every(p => BE.isFlower(w.getBlock(p[0], p[1], p[2])));
    const other = P.canon(s.x - 5.5, s.z + 0.5, {}).f;
    return { hy, planted: planted.length, fl: fl.length, past: past.length, read, other };
  }, site);
  await pg.evaluate(() => BF.warp.set(BF.warp.SPEEDS.indexOf(10)));   // (the page's speed, sent on to the simulation)
  check(set.planted >= 6 && set.past === set.planted && set.past === set.fl && set.read, `flowersNear lists the ${set.planted} poppies past the edge (on face ${set.other}) in the hive's frame (${set.past} of ${set.fl}, all read as flowers)`);
  // by day: a bee lands on a flower past the edge, and honey comes home
  const landed = await wait(s => BF.bees.list.some(b => b.mode === "land" && b.land && b.land.flower && BF.planet.canon(b.x, b.z, {}).f !== s.f), site, 150000);
  check(landed, "a bee lands on a flower past the edge");
  const honey = await wait(s => { const h = BF.bees.homeAt(s.x, s.hy, s.z); return h && h.honey >= 1; }, { ...site, hy: set.hy }, 150000);
  check(honey, "the hive's honey rises from flowers past the edge");
  const r = await lib.sim(pg, s => {
    const P = BF.planet, BE = BF.bees, w = BF.world, h = BE.homeAt(s.x, s.hy, s.z);
    BE.housekeeping();
    // a crop cell 2 blocks past the edge (6 from the hive; its canonical cell), and one 9 blocks past (out of CROP_R)
    const c1 = P.canonCell(s.x - 6, s.z, {}), c2 = P.canonCell(s.x - 13, s.z, {});
    const crop = [BE.cropFactor(c1.x, s.hy, c1.z), BE.cropFactor(c2.x, s.hy, c2.z)];
    // the hive through its margin address in the next face's frame
    const g = P.canon(s.x - 5.5, s.z + 0.5, {}).f, m = P.inFrame(g, s.x + 0.5, s.z + 0.5, {}), mx = Math.floor(m.x), mz = Math.floor(m.z);
    const viaMargin = BE.homeAt(mx, s.hy, mz) === h && w.getBlock(mx, s.hy, mz) === BF.B.beehive;
    const use = BE.playerUse({ x: mx, y: s.hy, z: mz }, null);
    return { crop, boost: BE.CROP_BOOST, viaMargin, use: use && use.msg, honey: h.honey };
  }, { ...site, hy: set.hy });
  check(r.crop[0] === r.boost && r.crop[1] === 1, `crops past the edge grow faster within reach (${r.crop.join(", ")})`);
  check(r.viaMargin && /Beehive/.test(r.use || ""), `the hive is found through its margin address on the next face (${r.use})`);
  // drawing: every bee's instance sits near the player, whichever frame the bee flies in (the page's bee mesh; the bees in another
  // face's frame counted where the simulation is)
  const drawn = async () => Object.assign(await pg.evaluate(() => {
    const mesh = BF.scene.getObjectByName("bees"), p = BF.player.position, e = new THREE.Matrix4(), v = new THREE.Vector3();
    if (!mesh || !mesh.count) return { n: 0 };
    let worst = 0;
    for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, e); v.setFromMatrixPosition(e); worst = Math.max(worst, Math.hypot(v.x + mesh.position.x - p.x, v.z + mesh.position.z - p.z)); }
    return { n: mesh.count, worst };
  }), { other: await lib.sim(pg, () => { const p = BF.player.position, F = BF.planet.face(p.x, p.z); return BF.bees.list.filter(b => BF.planet.face(b.x, b.z) !== F).length; }) });
  await pg.waitForTimeout(1000);
  const d1 = await drawn();
  check(d1.n > 0 && d1.worst < 40, `the ${d1.n} bees drawn are all by the player (farthest ${Math.round(d1.worst || 0)} blocks)`);
  // a second hive past the edge; the first broken: its bees that are out move to the second, into its face's frame, and get home
  const rh = await lib.sim(pg, s => {
    const P = BF.planet, BE = BF.bees, w = BF.world;
    const x = s.x - 6, z = s.z + 8, t = w.heightAt(x, z);
    w.setBlock(x, t + 1, z, BF.B.beehive);
    const c = P.canonCell(x, z, {}), h2 = BE.homeAt(c.x, t + 1, c.z), h1 = BE.homeAt(s.x, s.hy, s.z);
    const out = BE.out(h1);
    w.setBlock(s.x, s.hy, s.z, 0);
    const moved = out.filter(b => b.home === h2), framed = moved.every(b => P.face(b.x, b.z) === P.face(h2.x, h2.z));
    globalThis.__h2 = h2;
    return { ok: !!h2 && c.x !== x, out: out.length, moved: moved.length, framed, n2: h2 && h2.bees };
  }, { ...site, hy: set.hy });
  check(rh.ok && rh.out > 0 && rh.moved === rh.out && rh.framed, `breaking the hive sends its ${rh.out} bees out to the hive past the edge (${rh.moved}), in that face's frame`);
  await pg.waitForTimeout(300);
  const d2 = await drawn();
  check(d2.other > 0 && d2.worst < 40, `those bees, kept in the other face's frame (${d2.other}), are drawn by the player too (farthest ${Math.round(d2.worst || 0)} blocks)`);
  const home = await wait(() => { const h2 = globalThis.__h2; return h2.rest.length > 0; }, null, 90000);
  check(home, "they fly in to the hive past the edge");
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? `FAIL planet-bees (${bad})` : "PASS planet-bees");
};
