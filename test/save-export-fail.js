// @ci baseline suite=world
// Export from the world server says why when it fails (bug-073), and still downloads when it works:
// NODE_PATH=$(npm root -g) node test/save-export-fail.js
// On a page playing on the world server: BF.save.exportFile of a world the server doesn't have rejects with the server's reason
// ("World not found", which the title screen's Export shows as "Couldn't export that world: ...", js/player.js), downloads nothing,
// and logs an ERROR "save" line; a real world's export downloads <name>.bfworld holding that world.
const path = require('path'), fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib.js');
const SaveFile = require('../js/savefile.js');
const root = path.resolve(__dirname, '..');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
(async () => {
  const srv = await lib.serve({ world: true });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 900, height: 700 }, acceptDownloads: true });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
    const pg = await ctx.newPage();
    let downloads = [];
    pg.on('download', d => downloads.push(d));
    await lib.install(pg);
    await pg.goto(srv.url + '?nolod&sim=server#seed3');
    await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
    await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
    check(/World server/.test(await pg.evaluate(() => BF.simHost.label())), 'the simulation runs on the world server');
    const why = await pg.evaluate(() => BF.save.exportFile('wnosuchworld').then(() => 'resolved', e => e.message));
    await pg.waitForTimeout(500);
    check(/World not found/.test(why), 'exporting a world the server lacks rejects with its reason: ' + why);
    check(downloads.length === 0, 'and downloads nothing (' + downloads.length + ')');
    const id = await pg.evaluate(async () => { BF.player.start(); const m = await BF.save.create({ name: 'Export test', seed: '3', gameMode: 'creative' }); BF.state.paused = false; return m.id; });
    await pg.waitForTimeout(3000);
    // (logged after a world starts: the title screen's world has no saved log; the page's lines go to the server's log)
    await pg.evaluate(() => BF.save.exportFile('wnosuchworld2').catch(() => {}));
    let err = 0;
    for (let i = 0; i < 20 && !err; i++) { await pg.waitForTimeout(250); err = await lib.sim(pg, () => BF.glog.recent(1e9).filter(e => e.l === 'ERROR' && /Exporting world wnosuchworld2 failed: World not found/.test(e.x)).length); }
    check(err === 1, 'a failed export is an ERROR in the game log (' + err + ')');
    downloads = [];
    const ok = await pg.evaluate(id => BF.save.exportFile(id).then(() => 'resolved', e => e.message), id);
    for (let i = 0; i < 40 && !downloads.length; i++) await pg.waitForTimeout(250);
    check(ok === 'resolved' && downloads.length === 1, 'a real world exports: ' + ok + ', ' + downloads.length + ' download');
    if (downloads[0]) {
      const f = await downloads[0].path();
      check(downloads[0].suggestedFilename() === 'Export test.bfworld', 'named after the world: ' + downloads[0].suggestedFilename());
      let name = '';
      try { name = SaveFile.unpackSync(fs.readFileSync(f)).meta.name; } catch (e) { name = e.message; }
      check(name === 'Export test', 'and holds it: ' + name);
    }
  } catch (e) { check(false, 'threw ' + (e && e.stack || e)); }
  finally { await b.close(); await srv.stop(); }
  console.log(fails ? fails + ' failed' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
