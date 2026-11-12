// @ci integration suite=world timeout=600
// The realistic look's flowing water (js/real/water.js, docs/REALISTIC_WATER.md). With the look off the module is not there at all.
// With it on (?look=real): the window of flowing water follows the player, holds water where the blocks have water and at the
// blocks' level, answers depthAt / surfaceAt / flowAt, reads a placed block as bed (no water there any more) and a removed one as
// water again, takes a splash, moves with the player, changes no block, and pools behind a dam built across a river. The frames are driven by the test (BF.real.water.frame),
// so it does not depend on how fast the machine draws.
// node test/run.js /tmp/rw test/real-water.js
const lib = require('./lib');
module.exports = async (pg) => {
  let fails = 0;
  const check = (label, ok, info) => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + label + (info !== undefined ? ': ' + JSON.stringify(info) : '')); };
  check('look off: no water module', await pg.evaluate(() => !BF.real.on && !BF.real.water));

  const u = new URL(pg.url()); u.searchParams.set('look', 'real');
  await pg.goto(u.href);
  await lib.ready(pg);
  await pg.waitForFunction(() => BF.player && BF.player.position && BF.real && BF.real.water, null, { timeout: 60000 });
  check('look on: the module is there', await pg.evaluate(() => BF.real.on && typeof BF.real.water.material === 'function' && typeof BF.real.water.frame === 'function' && typeof BF.real.splash === 'function'));
  check('the liquid material is one clone of the base', await pg.evaluate(() => { const b = BF.world.liquidMat, m = BF.real.water.material(b); return m !== b && m === BF.real.water.material(b) && m.transparent && !!m.userData.realWater; }));

  // to the nearest water (a column whose water level is above its ground), 6 blocks over it
  const spot = await pg.evaluate(() => {
    const p = BF.player.position, G = BF.worldgen;
    for (let r = 16; r < 8000; r += 16) for (let a = 0; a < 6.28; a += 0.1) {
      const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r), wl = G.waterLevelAt(x, z);
      if (wl > G.heightAt(x, z) + 1) { BF.player.setGameMode('creative'); BF.player.spawn(x + 0.5, wl + 6, z + 0.5); BF.player.setFlying(true); return { x, z, wl }; }
    }
    return null;
  });
  check('found water near spawn', !!spot, spot);
  if (!spot) return;
  await pg.waitForFunction(s => BF.world.isLoaded(s.x, s.z) && BF.FLUID[BF.world.getBlock(s.x, s.wl, s.z)] === 8, spot, { timeout: 120000, polling: 250 });
  const run = n => pg.evaluate(n => { BF.player.setFlying(true); for (let i = 0; i < n; i++) BF.real.water.frame(0.033); }, n);
  await run(60);
  const at = await pg.evaluate(s => {
    const w = BF.real.water, f = w._fields;
    let bad = 0; for (let k = 0; k < f.d.length; k++) if (!isFinite(f.d[k]) || !isFinite(f.vx[k]) || !isFinite(f.vz[k]) || f.d[k] < 0) bad++;
    return { active: w.active, covers: w.covers(s.x + 0.5, s.z + 0.5), depth: w.depthAt(s.x + 0.5, s.z + 0.5), surf: w.surfaceAt(s.x + 0.5, s.z + 0.5), wet: w.stats.wet, bad, flow: w.flowAt(s.x + 0.5, s.z + 0.5), vis: w.mesh.visible };
  }, spot);
  check('the window is on, over the player, and holds water', at.active && at.covers && at.vis && at.wet > 0 && at.depth > 0.5, at);
  check('its surface is within the blocks\' top water block', at.surf != null && at.surf > spot.wl - 0.2 && at.surf <= spot.wl + 0.9, at.surf);
  check('every cell is a finite, non-negative depth', at.bad === 0, at.bad);

  // a column of stone in the water is bed, at once: no water there; taken out again, the water is back (rule 1: the blocks decide)
  const edits0 = await pg.evaluate(() => BF.world.edits.size);
  const ids = await pg.evaluate(s => { const o = []; for (let y = s.wl; y > s.wl - 12; y--) { const id = BF.world.getBlock(s.x, y, s.z); if (!BF.FLUID[id]) break; o.push([y, id]); BF.world.setBlock(s.x, y, s.z, BF.B.stone); } return o; }, spot);
  await run(40);
  const dry = await pg.evaluate(s => BF.real.water.depthAt(s.x + 0.5, s.z + 0.5), spot);
  check('a block placed in the water dries its column', ids.length > 0 && dry === 0, { placed: ids.length, depth: dry });
  await pg.evaluate(([s, ids]) => { for (const [y, id] of ids) BF.world.setBlock(s.x, y, s.z, id); }, [spot, ids]);
  await run(120);
  const back = await pg.evaluate(s => BF.real.water.depthAt(s.x + 0.5, s.z + 0.5), spot);
  check('with the block gone the water is back', back > 0.5, back);

  // a splash raises the water where it lands, and it settles back to the blocks' level
  const sp = await pg.evaluate(s => { const w = BF.real.water, a = w.surfaceAt(s.x + 0.5, s.z + 0.5), hit = BF.real.splash(s.x + 0.5, s.wl, s.z + 0.5, 2), b = w.surfaceAt(s.x + 0.5, s.z + 0.5); return { a, b, hit }; }, spot);
  await run(400);
  const settled = await pg.evaluate(s => BF.real.water.surfaceAt(s.x + 0.5, s.z + 0.5), spot);
  check('a splash lifts the surface and it settles back', sp.hit && sp.b > sp.a + 0.05 && Math.abs(settled - sp.a) < 0.08, { ...sp, settled });

  // from any height the water stays in columns that have block water (it once spread over the bottom of the heights read, as a sheet
  // in the air, when the view came down towards a river from above) and never heaps far above the blocks' level
  for (const up of [50, 30, 12, 6]) {
    await pg.evaluate(([s, up]) => { BF.player.spawn(s.x + 0.5, s.wl + up, s.z + 0.5); BF.player.setFlying(true); }, [spot, up]);
    await run(80);
    const r = await pg.evaluate(() => { const w = BF.real.water, f = w._fields; let stray = 0, high = 0; for (let k = 0; k < f.d.length; k++) if (f.d[k] > 0.004) { if (f.tgt[k] < -1e8) stray++; else if (f.bed[k] + f.d[k] > f.tgt[k] + 0.7) high++; } return { stray, high, wet: w.stats.wet }; });
    check('from ' + up + ' blocks up: no water outside the blocks\' water, none heaped above it', r.stray === 0 && r.high === 0, r);
  }
  await pg.evaluate(s => { BF.player.spawn(s.x + 0.5, s.wl + 6, s.z + 0.5); BF.player.setFlying(true); }, spot);
  await run(10);

  // the window follows the player
  const w0 = await pg.evaluate(() => BF.real.water.window);
  await pg.evaluate(s => { BF.player.spawn(s.x + 30.5, s.wl + 6, s.z + 0.5); BF.player.setFlying(true); }, spot);
  await run(10);
  const w1 = await pg.evaluate(s => ({ w: BF.real.water.window, covers: BF.real.water.covers(s.x + 30.5, s.z + 0.5), still: BF.real.water.depthAt(s.x + 0.5, s.z + 0.5) }), spot);
  check('the window moves with the player in steps of 8 blocks and keeps its water', w1.covers && w1.w.x !== w0.x && (w1.w.x - w0.x) % 8 === 0 && w1.still > 0.5, { from: w0.x, to: w1.w.x, depth: w1.still });

  // a dam across a river (rule 7): the water pools behind it, well above the blocks' level, and goes over or round it; none of that
  // happens at the same river before the dam is built; and with the dam taken out again the river runs back down to its level
  const site = await pg.evaluate(() => {
    const p = BF.player.position, R = {}, G = BF.worldgen;
    for (let r = 0; r < 4000; r += 6) for (let a = 0; a < 6.28; a += Math.max(0.01, 5 / (r + 1))) {
      const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
      if (!BF.rivers.at(x, z, R) || R.d > 0.6 || R.w < 2 || R.w > 5 || R.rs < BF.SEA + 4 || BF.view.kAt(x, R.rs + 6, z) > 0) continue;
      const rs = R.rs, w = R.w;
      let lo = rs, dx = 0, dz = 0;
      for (let b = 0; b < 6.28; b += 0.1) { const qx = x + Math.cos(b) * 10, qz = z + Math.sin(b) * 10; if (BF.rivers.at(qx, qz, R) && R.d < 1.5 && R.rs < lo) { lo = R.rs; dx = Math.cos(b); dz = Math.sin(b); } }
      if (rs - lo < 0.15 || rs - lo > 1) continue;                      // running, and not a fall
      const e = Math.ceil(w) + 4, y = Math.floor(rs);
      if (G.heightAt(Math.floor(x - dz * e), Math.floor(z + dx * e)) < y || G.heightAt(Math.floor(x + dz * e), Math.floor(z - dx * e)) < y) continue;   // banks on both sides
      return { x, z, y, dx, dz, w };
    }
    return null;
  });
  check('found a river to dam', !!site, site);
  if (site) {
    await pg.evaluate(s => { BF.player.spawn(s.x + 0.5, s.y + 7, s.z + 0.5); BF.player.setFlying(true); }, site);
    await pg.waitForFunction(s => BF.world.isLoaded(s.x - 40, s.z - 40) && BF.world.isLoaded(s.x + 40, s.z + 40) && BF.world.isLoaded(s.x, s.z), site, { timeout: 120000, polling: 250 });
    // (ground swapped for other ground on the bank, as grass spreading does, is not a change to the river)
    await pg.evaluate(s => {
      const dirt = BF.blocks.find(b => b && b.name === 'dirt').id, coarse = BF.blocks.find(b => b && b.name === 'coarse_dirt').id;
      for (const e of [-1, 1]) for (let c = 0; c <= 2; c++) {
        const x = Math.floor(s.x + 0.5 - s.dz * e * (s.w + c)), z = Math.floor(s.z + 0.5 + s.dx * e * (s.w + c)), y = BF.worldgen.heightAt(x, z);
        if (BF.SOLID[BF.world.getBlock(x, y, z)]) BF.world.setBlock(x, y, z, BF.world.getBlock(x, y, z) === dirt ? coarse : dirt);
      }
    }, site);
    await run(120);
    // the river's cells for 2 to 14 blocks above and below the site: how far over their rest level they stand; and water off the blocks' water
    const levels = () => pg.evaluate(s => {
      const w = BF.real.water, f = w._fields, W = w.window, n = W.cells, o = { up: 0, down: 0, stray: 0, zones: w.stats.zones };
      let nu = 0, nd = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = i + j * n;
        if (f.tgt[k] < -1e8) { if (f.d[k] > 0.02) o.stray++; continue; }
        const x = W.x + (i + 0.5) * W.size / n - s.x - 0.5, z = W.z + (j + 0.5) * W.size / n - s.z - 0.5, a = x * s.dx + z * s.dz;
        if (Math.abs(z * s.dx - x * s.dz) > s.w) continue;
        const e = f.bed[k] + f.d[k] - f.tgt[k];
        if (a <= -2 && a >= -14) { o.up += e; nu++; } else if (a >= 2 && a <= 14) { o.down += e; nd++; }
      }
      o.up = +(o.up / nu).toFixed(2); o.down = +(o.down / nd).toFixed(2);
      return o;
    }, site);
    const l0 = await levels();
    check('an unchanged river stays at its level and in its bed', l0.zones === 0 && l0.stray === 0 && Math.abs(l0.up) < 0.3 && Math.abs(l0.down) < 0.3, l0);
    const put = await pg.evaluate(s => {
      const dirt = BF.blocks.find(b => b && b.name === 'dirt').id, was = [], seen = new Set();
      for (let a = -0.7; a <= 0.7; a += 0.35) for (let c = -s.w - 4; c <= s.w + 4; c += 0.5) {
        const x = Math.floor(s.x + 0.5 + a * s.dx - c * s.dz), z = Math.floor(s.z + 0.5 + a * s.dz + c * s.dx);
        for (let y = s.y - 6; y <= s.y + 1; y++) {
          const id = BF.world.getBlock(x, y, z), key = x + ',' + y + ',' + z;
          if (BF.SOLID[id] || seen.has(key)) continue;
          seen.add(key); was.push([x, y, z, id]); BF.world.setBlock(x, y, z, dirt);
        }
      }
      return was;
    }, site);
    await run(700);
    const l1 = await levels();
    check('a dam across it: the water pools behind the dam and spills', put.length > 10 && l1.zones > 0 && l1.up > 0.5 && l1.up - l1.down > 0.4 && l1.up < 3.2 && l1.stray > 0, { blocks: put.length, ...l1 });
    await pg.evaluate(was => { for (const [x, y, z, id] of was) BF.world.setBlock(x, y, z, id); }, put);
    await run(900);
    const l2 = await levels();
    check('the dam taken out: the pool runs off', l2.up < 0.35 && l2.stray < l1.stray / 4, l2);
    await pg.evaluate(s => { BF.player.spawn(s.x + 0.5, s.wl + 6, s.z + 0.5); BF.player.setFlying(true); }, spot);
    await run(10);
  }

  // a village well (a 2 x 2 basin in a ring of blocks, posts on the ring's corners, a roof over it all): water in the basin at the
  // blocks' level, the ring's ground is the ring (not the roof over it), and no part of the surface climbs towards the roof at the
  // posts: every corner of the mesh round the basin is at the water's level or below
  const well = await pg.evaluate(() => {
    const p = BF.player.position;
    const vs = BF.worldgen.villagesNear(p.x, p.z, 4000).filter(v => BF.view.kAt(v.x, v.y + 3, v.z) === 0 && BF.planet.face(v.x - 60, v.z - 60) === BF.planet.face(v.x + 60, v.z + 60))
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    return vs.length ? { x: vs[0].x, y: vs[0].y, z: vs[0].z } : null;
  });
  check('found a village well', !!well, well);
  if (well) {
    await pg.evaluate(v => { BF.player.spawn(v.x - 1.5, v.y + 3.6, v.z - 1.5); BF.player.setFlying(true); }, well);
    await pg.waitForFunction(v => BF.world.isLoaded(v.x, v.z) && BF.FLUID[BF.world.getBlock(v.x, v.y, v.z)] === 8, well, { timeout: 120000, polling: 250 });
    await run(60);
    const wl = await pg.evaluate(v => {
      const w = BF.real.water, f = w._fields, W = w.window, pos = w.mesh.geometry.attributes.position.array, n = W.cells + 1;
      const level = w.surfaceAt(v.x + 1, v.z + 1);
      let high = 0;
      for (let z = v.z - 0.5; z <= v.z + 2.5; z += 0.5) for (let x = v.x - 0.5; x <= v.x + 2.5; x += 0.5) {   // (every corner of a quad that touches the water)
        const i = Math.round((x - W.x) * 2), j = Math.round((z - W.z) * 2);
        if (pos[(i + j * n) * 3 + 1] + W.y > level + 0.01) high++;
      }
      const q = (v.x - 1 - W.x) + (v.z - 1 - W.z) * W.size;
      return { depth: +w.depthAt(v.x + 1, v.z + 1).toFixed(2), level: +(level - v.y).toFixed(2), ring: f.cBed[q] - v.y, ringDry: f.cSurf[q] < -1e8, high };
    }, well);
    check('the well holds water in its basin, and none of the surface stands above it at the posts', wl.depth > 2 && Math.abs(wl.level - 0.889) < 0.05 && wl.ring === 2 && wl.ringDry && wl.high === 0, wl);
    await pg.evaluate(s => { BF.player.spawn(s.x + 0.5, s.wl + 6, s.z + 0.5); BF.player.setFlying(true); }, spot);
    await run(10);
  }

  // drawing only: no block changed beyond the test's own edits (put back above)
  const same = await pg.evaluate(([s, ids]) => ids.every(([y, id]) => BF.world.getBlock(s.x, y, s.z) === id), [spot, ids]);
  check('the water changed no block', same);

  // off again: the window is gone and block water is all there is
  const off = await pg.evaluate(() => { BF.real.water.setEnabled(false); BF.real.water.frame(0.033); const w = BF.real.water; return { active: w.active, vis: w.mesh.visible, covers: w.covers(BF.player.position.x, BF.player.position.z) }; });
  check('setEnabled(false) leaves block water only', !off.active && !off.vis && !off.covers, off);
  console.log(fails ? 'FAIL ' + fails + ' checks failed' : 'ok   real-water: all checks passed');
};
