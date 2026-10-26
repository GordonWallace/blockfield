// @ci baseline suite=world
// On the world server, a world can be exported right after Save and Quit to Title (bug-074): the server no longer takes the thread
// playing the title background for that world. Usage: NODE_PATH=$(npm root -g) node test/save-quit-export.js
// Creates a world on the server, plays a little, saves and quits to the title screen, then exports it over http (200, the world's
// file); renames it and exports again (the new name); closes the tab and exports once more (the server didn't hold the title
// background as if it were the world).
const path = require('path'), http = require('http');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib.js');
const SaveFile = require('../js/savefile.js');
const root = path.resolve(__dirname, '..');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const get = url => new Promise((res, rej) => http.get(url, r => { const a = []; r.on('data', d => a.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(a) })); }).on('error', rej));
const name = r => { try { return SaveFile.unpackSync(r.body).meta.name; } catch (e) { return 'unreadable: ' + e.message; } };
(async () => {
  const srv = await lib.serve({ world: true });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 900, height: 700 } });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
    const pg = await ctx.newPage();
    await pg.goto(srv.url + '?nolod&sim=server#seed3');
    await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
    await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
    check(/World server/.test(await pg.evaluate(() => BF.simHost.label())), 'the simulation runs on the world server');
    const id = await pg.evaluate(async () => { BF.player.start(); const m = await BF.save.create({ name: 'Quit test', seed: '3', gameMode: 'creative' }); BF.state.paused = false; return m.id; });
    await pg.waitForTimeout(5000);
    await pg.evaluate(async () => { await BF.save.saveNow(); BF.save.quit(); });
    await pg.waitForTimeout(1500);
    const url = 'http://localhost:' + srv.game + '/saves/' + encodeURIComponent(id) + '/export';
    let r = await get(url);
    check(r.status === 200 && name(r) === 'Quit test', 'export works after Save and Quit to Title: ' + r.status + ' ' + (r.status === 200 ? name(r) : r.body.toString().slice(0, 120)));
    await pg.evaluate(id => BF.save.rename(id, 'Quit test renamed'), id);
    r = await get(url);
    check(r.status === 200 && name(r) === 'Quit test renamed', 'and after renaming it: ' + r.status + ' ' + (r.status === 200 ? name(r) : ''));
    await pg.close();
    await new Promise(r => setTimeout(r, 3000));
    r = await get(url);
    check(r.status === 200 && name(r) === 'Quit test renamed', 'and after closing the tab: ' + r.status);
  } catch (e) { check(false, 'threw ' + (e && e.stack || e)); }
  finally { await b.close(); await srv.stop(); }
  console.log(fails ? fails + ' failed' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
