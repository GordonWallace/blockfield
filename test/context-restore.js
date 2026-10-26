// @ci integration suite=world soak timeout=1200 hosts=worker
// The 3D view survives the browser taking its WebGL context away and giving it back (a driver reset, too little graphics memory: a real
// GPU under load). three.js uploads every mesh again on restore, and the distant terrain (js/lod.js rings, js/globe.js tiles) and far
// chunk meshes (js/world.js purge) free their arrays once uploaded, so before the fix every frame after a restore threw "Cannot read
// properties of null (reading 'BYTES_PER_ELEMENT')" and the screen stayed black. Checks: no page errors after a lose/restore cycle,
// the far chunk meshes are dropped to be built again, the rings and globe build again, frames draw, and the game log has the lost (ERROR)
// and restored (INFO) graphics events. CTX_SIM=page runs it with the simulation in the page.
// About 9 minutes under software rendering (view distance 20, for far chunk meshes), so a soak test.
// node test/run.js /tmp/ctx test/context-restore.js
const lib = require('./lib');
module.exports = async (pg) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? 'ok ' : 'FAIL ') + what); if (!ok) bad++; };
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  const srv = await lib.serve({ world: false });
  try {
    await pg.goto(srv.url + '?sim=' + (process.env.CTX_SIM || 'worker') + '#seed3');
    await pg.setViewportSize({ width: 320, height: 200 });
    await lib.ready(pg);
    await pg.evaluate(() => { BF.world.setViewDist(20); BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true); });
    const built = () => pg.evaluate(() => BF.lod.stats().rings.filter(r => r.built).length + ' rings, ' + (BF.globe ? BF.globe.built : 0) + ' globe tiles');
    await pg.waitForFunction(() => BF.lod.stats().rings.every(r => r.built) && BF.globe.built > 0 && BF.world.farMeshes.size > 0, null, { timeout: 600000, polling: 1000 });
    // (far chunk meshes: chunks past 15 (12 + 3) that keep only their meshes, js/world.js purge; their arrays are freed too)
    const far0 = await pg.evaluate(() => BF.world.farMeshes.size);
    console.log('before: ' + await built() + ', far meshes ' + far0 + ', chunks ' + await pg.evaluate(() => BF.world.chunks.size));
    check(far0 > 0, 'some far chunk meshes to restore');
    const n0 = errs.length;
    await pg.evaluate(() => {
      window.__lc = BF.renderer.getContext().getExtension('WEBGL_lose_context');
      // (runs after the game's own listener: how many far meshes it left)
      BF.renderer.domElement.addEventListener('webglcontextrestored', () => { window.__farLeft = BF.world.farMeshes.size; });
      __lc.loseContext();
    });
    await pg.waitForTimeout(1500);
    await pg.evaluate(() => __lc.restoreContext());
    await pg.waitForTimeout(4000);
    const farLeft = await pg.evaluate(() => window.__farLeft);
    check(farLeft === 0, 'the far chunk meshes were dropped on the restore, to be built again (' + farLeft + ' left)');
    const after = errs.slice(n0);
    check(!after.length, 'no page errors after the context came back' + (after.length ? ' (' + after.length + ': ' + after[0] + ')' : ''));
    await pg.waitForFunction(() => BF.lod.stats().rings.every(r => r.built) && BF.globe.built > 0, null, { timeout: 300000, polling: 1000 }).catch(() => {});
    console.log('after: ' + await built() + ', far meshes ' + await pg.evaluate(() => BF.world.farMeshes.size));
    const f0 = await pg.evaluate(() => BF.renderer.info.render.frame);
    await pg.waitForTimeout(3000);
    const f1 = await pg.evaluate(() => BF.renderer.info.render.frame);
    check(f1 > f0, 'frames draw after the restore (' + (f1 - f0) + ' in 3 s)');
    check(!errs.slice(n0).length, 'still no page errors (' + errs.slice(n0).length + ')');
    // (the page's entries go to the worker's log and come back to read)
    const graphics = () => pg.evaluate(() => BF.glog.recent(5000).filter(e => e.k === 'graphics').map(e => e.l + ' ' + e.x));
    await pg.waitForFunction(() => BF.glog.recent(5000).filter(e => e.k === 'graphics').length >= 2, null, { timeout: 20000, polling: 500 }).catch(() => {});
    const log = await graphics();
    console.log(log.join('\n'));
    check(log.some(l => /^ERROR .*context/i.test(l)), 'the game log has the lost context as an ERROR');
    check(log.some(l => /^INFO .*came back/i.test(l)), 'the game log has the restore as INFO');
  } finally { await srv.stop(); }
  console.log(bad ? 'FAIL context-restore: ' + bad : 'PASS context-restore');
};
