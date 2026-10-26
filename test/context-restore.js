// @ci integration suite=world soak timeout=900
// The 3D view survives the browser taking its WebGL context away and giving it back (a driver reset, too little graphics memory: a real
// GPU under load). three.js uploads every mesh again on restore, and the distant terrain (js/lod.js rings, js/globe.js tiles) and far
// chunk meshes (js/world.js purge) free their arrays once uploaded, so before the fix every frame after a restore threw "Cannot read
// properties of null (reading 'BYTES_PER_ELEMENT')" and the screen stayed black. Checks: no page errors after a lose/restore cycle,
// the far chunk meshes are dropped to be built again (none at this view distance), the rings and globe build again, frames draw, and the game log has the lost (ERROR)
// and restored (INFO) graphics events.
// A few minutes under software rendering (the rings take a while to sample), so a soak test.
// node test/run.js /tmp/ctx test/context-restore.js
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };
module.exports = async (pg) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? 'ok ' : 'FAIL ') + what); if (!ok) bad++; };
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  // served over http (workers, and so the distant terrain, can't start from a file:// page)
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split(/[?#]/)[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await pg.goto(`http://127.0.0.1:${server.address().port}/index.html#seed3`);
    await pg.setViewportSize({ width: 320, height: 200 });
    await pg.waitForFunction(() => window.BF && BF.lod && !BF.preparing, null, { timeout: 180000 });
    await pg.evaluate(() => { BF.world.setViewDist(4); BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true); });
    const built = () => pg.evaluate(() => BF.lod.stats().rings.filter(r => r.built).length + ' rings, ' + (BF.globe ? BF.globe.built : 0) + ' globe tiles');
    await pg.waitForFunction(() => BF.lod.stats().rings.every(r => r.built) && BF.globe.built > 0, null, { timeout: 600000, polling: 1000 });
    // (far chunk meshes, chunks past 15 that keep only their meshes, need view distance 20: with the simulation in the page they take
    // over 15 minutes to load under software rendering, so this test leaves them out; 1.5's test covers them)
    const far0 = await pg.evaluate(() => BF.world.farMeshes.size);
    console.log('before: ' + await built() + ', far meshes ' + far0 + ', chunks ' + await pg.evaluate(() => BF.world.chunks.size));
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
    const graphics = () => pg.evaluate(() => BF.glog.recent(5000).filter(e => e.k === 'graphics').map(e => e.l + ' ' + e.x));
    await pg.waitForFunction(() => BF.glog.recent(5000).filter(e => e.k === 'graphics').length >= 2, null, { timeout: 20000, polling: 500 }).catch(() => {});
    const log = await graphics();
    console.log(log.join('\n'));
    check(log.some(l => /^ERROR .*context/i.test(l)), 'the game log has the lost context as an ERROR');
    check(log.some(l => /^INFO .*came back/i.test(l)), 'the game log has the restore as INFO');
  } finally { server.close(); }
  console.log(bad ? 'FAIL context-restore: ' + bad : 'PASS context-restore');
};
