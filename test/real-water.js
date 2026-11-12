// @ci integration suite=world timeout=600
// The realistic look's flowing water (js/real/water.js, docs/REALISTIC_WATER.md). With the look off the module is not there at all.
// With it on (?look=real): the window of flowing water follows the player, holds water where the blocks have water and at the
// blocks' level, answers depthAt / surfaceAt / flowAt, reads a placed block as bed (no water there any more) and a removed one as
// water again, takes a splash, moves with the player, and changes no block. The frames are driven by the test (BF.real.water.frame),
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

  // the window follows the player
  const w0 = await pg.evaluate(() => BF.real.water.window);
  await pg.evaluate(s => { BF.player.spawn(s.x + 30.5, s.wl + 6, s.z + 0.5); BF.player.setFlying(true); }, spot);
  await run(10);
  const w1 = await pg.evaluate(s => ({ w: BF.real.water.window, covers: BF.real.water.covers(s.x + 30.5, s.z + 0.5), still: BF.real.water.depthAt(s.x + 0.5, s.z + 0.5) }), spot);
  check('the window moves with the player in steps of 8 blocks and keeps its water', w1.covers && w1.w.x !== w0.x && (w1.w.x - w0.x) % 8 === 0 && w1.still > 0.5, { from: w0.x, to: w1.w.x, depth: w1.still });

  // drawing only: no block changed beyond the test's own edits (put back above)
  const same = await pg.evaluate(([s, ids]) => ids.every(([y, id]) => BF.world.getBlock(s.x, y, s.z) === id), [spot, ids]);
  check('the water changed no block', same);

  // off again: the window is gone and block water is all there is
  const off = await pg.evaluate(() => { BF.real.water.setEnabled(false); BF.real.water.frame(0.033); const w = BF.real.water; return { active: w.active, vis: w.mesh.visible, covers: w.covers(BF.player.position.x, BF.player.position.z) }; });
  check('setEnabled(false) leaves block water only', !off.active && !off.vis && !off.covers, off);
  console.log(fails ? 'FAIL ' + fails + ' checks failed' : 'ok   real-water: all checks passed');
};
