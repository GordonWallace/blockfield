// @ci integration suite=world,ui timeout=1800
// Saves on the world server (spec r15-42, server/savedir.js, server/world.js, js/save.js, js/savefile.js): ./run.sh's server on free
// ports with its saves in a temp folder, pages opened with ?sim=server:
//   - a world created on the server plays a little, is saved, and is a folder saves/<world name>/ with world.json (seed, version, time)
//     and save.v8 and log/; the server is stopped with Ctrl+C (SIGINT), which saves it; a new server lists it on the title screen, and
//     loaded again it hashes the same as before the stop (the state hash, part by part);
//   - a second page sees "World in use" on its title screen;
//   - a save that fails (a full disk, made to fail by the test) keeps the previous save and says why; the next one works;
//   - Export on the title screen downloads <name>.bfworld; Import reads it back as a second world (a new id, folder "<name> (2)") whose
//     save data is the same; rename moves its folder, Delete removes it;
//   - "Copy browser saves to the server" copies this browser's IndexedDB worlds to the server, skips them the second time, and leaves
//     a 1.4 world (version 2) behind as too old; a 1.4 world file is refused by Import;
//   - in browser-only mode (?sim=page) the same file imports into IndexedDB and exports back with the same save data.
// Usage: NODE_PATH=$(npm root -g) node test/server-saves.js [seed=3]
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), net = require('net'), v8 = require('v8');
const { chromium } = require(process.env.PW || 'playwright');
const SaveFile = require('../js/savefile.js');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3);
const NAME = 'Saves test';
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-saves-'));
const until = async (fn, ms, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, step)); } return null; };

async function server() {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug), '--saves', saves, '--alerts', path.join(saves, '.alerts.json')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.out = '';
  srv.stdout.on('data', d => { srv.out += d; });
  srv.stderr.on('data', d => { srv.out += d; });
  srv.exited = new Promise(res => srv.on('exit', c => res(c)));
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + srv.out)), 20000);
    const on = () => { if (/Ctrl\+C/.test(srv.out)) { clearTimeout(t); res(); } };
    srv.stdout.on('data', on);
    srv.exited.then(c => rej(new Error('debug/server.js exited ' + c + ': ' + srv.out)));
  });
  return { srv, base: 'http://localhost:' + game };
}

let ctx = null;
async function open(b, url) {
  if (!ctx) {
    ctx = await b.newContext({ viewport: { width: 900, height: 700 }, acceptDownloads: true });
    await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await ctx.route('https://fonts.**', r => r.abort());
  }
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)));
  pg.on('console', m => { if (m.type() === 'error' && !/GL Driver|World server stopped|ERR_CONNECTION_REFUSED|Save failed|ENOSPC|Made with Blockfield|status of 400/.test(m.text())) console.log('console.error:', m.text().slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  return pg;
}
const query = (pg, what, args) => pg.evaluate(([w, a]) => new Promise(r => BF.client.query(w, a || {}, r)), [what, args]);
const diffParts = (a, b) => Object.keys(Object.assign({}, a, b)).filter(k => a[k] !== b[k]);
const folderOf = id => fs.readdirSync(saves).find(f => { try { return JSON.parse(fs.readFileSync(path.join(saves, f, 'world.json'), 'utf8')).id === id; } catch (e) { return false; } });
const dataOf = f => v8.deserialize(fs.readFileSync(path.join(saves, f, 'save.v8')));
const same = (a, b) => SaveFile.encode({ meta: {}, data: a }) === SaveFile.encode({ meta: {}, data: b });
const rows = pg => pg.evaluate(() => [...document.querySelectorAll('.bfp-world')].map(r => ({ id: r.dataset.id, old: r.classList.contains('old'), text: r.textContent, btns: [...r.querySelectorAll('button')].map(x => x.dataset.act) })));
const note = pg => pg.evaluate(() => document.querySelector('.bfp-view-list .bfp-savenote').textContent);
// waits for the title screen's note to match re; -> its text (or what it last said, when it never did)
// (90 s: with a world streaming to a software-rendered test page, the page reads the socket's messages seconds behind, and the title
// screen's list comes back on that socket)
async function waitNote(pg, re, ms = 90000) { let t = ''; const ok = await until(async () => re.test(t = await note(pg)), ms); return ok ? t : 'not seen; last: ' + t; }
// a world loaded from the title list's data, paused before it ticks (as test/server.js)
const loadPaused = (pg, id) => pg.evaluate(async id => { BF.player.start(); BF.state.paused = true; const m = await BF.save.load(id); BF.state.paused = true; return m && m.name; }, id);

(async () => {
  let { srv, base } = await server();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const surl = base + '/index.html?sim=server#seed' + seed;
  let id = null;
  try {
    // ---- a world on the server, played, saved: its folder
    const pg = await open(b, surl);
    check(await pg.evaluate(() => BF.simHost.mode) === 'server', 'the page plays on the world server');
    const head = await pg.evaluate(() => document.querySelector('.bfp-where').textContent);
    check(/on the world server/.test(head), `the title screen says its worlds are the server's (${head})`);
    id = await pg.evaluate(async ([seed, name]) => {
      BF.player.start();
      const m = await BF.save.create({ name, seed: String(seed), gameMode: 'creative', villages: 10 });
      BF.warp.set(2); BF.state.paused = false;   // (10x)
      return m.id;
    }, [seed, NAME]);
    await pg.waitForTimeout(15000);
    await pg.evaluate(() => { BF.state.paused = true; });
    await pg.waitForTimeout(1500);
    const saved = await pg.evaluate(() => BF.save.saveNow());
    const f1 = folderOf(id);
    check(saved && f1 === NAME, `saved, the world is folder saves/${f1}/`);
    const wj = f1 ? JSON.parse(fs.readFileSync(path.join(saves, f1, 'world.json'), 'utf8')) : {};
    check(wj.seed === seed && wj.version === 3 && wj.game === '1.5' && wj.time && wj.time.day >= 0 && wj.name === NAME, `world.json holds its seed, version and time (${JSON.stringify({ seed: wj.seed, version: wj.version, time: wj.time })})`);
    check(f1 && fs.existsSync(path.join(saves, f1, 'save.v8')) && fs.existsSync(path.join(saves, f1, 'log', 'head.v8')), 'and save.v8 and its game log in log/');
    const log1 = await pg.evaluate(() => BF.glog.recent(500).filter(e => e.k === 'save').map(e => e.l + ' ' + e.x));
    check(log1.some(x => /^DEBUG Saved world "Saves test" in \d+ ms/.test(x)), `the game log has the save (${log1.slice(-1)})`);
    const h1 = await query(pg, 'hash');
    check(h1.ok && h1.tick > 100, `it played (tick ${h1.tick})`);

    // ---- a second page: "World in use"
    const p2 = await open(b, surl.replace('#seed', '&debugfeed=off#seed'));
    const n2 = await p2.evaluate(() => ({ host: BF.simHost.mode, refused: BF.simHost.refused, note: document.querySelector('.bfp-view-list .bfp-savenote').textContent }));
    check(n2.host === 'worker' && /^World in use/.test(n2.note), `a second page sees "World in use" (${n2.note.slice(0, 80)})`);
    await p2.close();

    // ---- a full disk: the save fails, the previous one stays, the page says why
    const before = fs.readFileSync(path.join(saves, f1, 'save.v8'));
    await pg.evaluate(() => BF.simHost.post({ server: 'writeFail', n: 1, code: 'ENOSPC' }));
    await pg.waitForTimeout(300);
    const bad = await pg.evaluate(async () => { const ok = await BF.save.saveNow(); return { ok, why: BF.save.lastError, log: BF.glog.recent(300).filter(e => e.k === 'save' && e.l === 'ERROR').map(e => e.x) }; });
    check(bad.ok === false && /ENOSPC/.test(bad.why || ''), `a failed save says why (${bad.why})`);
    await until(() => pg.evaluate(() => BF.glog.recent(300).some(e => e.k === 'save' && e.l === 'ERROR')), 5000);
    const badLog = await pg.evaluate(() => BF.glog.recent(300).filter(e => e.k === 'save' && e.l === 'ERROR').map(e => e.x));
    check(badLog.some(x => /failed \(ENOSPC.*the previous save is kept/.test(x)), `the game log has an ERROR for it (${(badLog[0] || '').slice(0, 120)})`);
    check(before.equals(fs.readFileSync(path.join(saves, f1, 'save.v8'))) && !fs.readdirSync(path.join(saves, f1)).some(f => /\.tmp/.test(f)), 'the previous save is kept, no temp file left');
    check(await pg.evaluate(() => BF.save.saveNow()) === true, 'the next save works');

    // ---- Ctrl+C saves; a new server lists the world and loads it as it was
    srv.kill('SIGINT');
    const code = await Promise.race([srv.exited, new Promise(r => setTimeout(() => r('timeout'), 30000))]);
    check(code === 0 && /saving and stopping/.test(srv.out), `Ctrl+C (SIGINT) saves and stops the server (exit ${code})`);
    await pg.close();
    ({ srv, base } = await server());
    const surl2 = base + '/index.html?sim=server#seed' + seed;
    const pg2 = await open(b, surl2);
    await pg2.waitForTimeout(1500);
    const r2 = await rows(pg2);
    const row = r2.find(r => r.id === id);
    check(row && !row.old && /Saves test/.test(row.text) && ['play', 'options', 'rename', 'export', 'delete'].every(a => row.btns.includes(a)), `the new server's title screen lists it with Play, Options, Rename, Export and Delete (${row && row.btns.join('/')})`);
    check(await loadPaused(pg2, id) === NAME, 'it loads');
    await pg2.waitForTimeout(3000);
    const h2 = await query(pg2, 'hash');
    const dp = diffParts(h1.parts, h2.parts);
    console.log(`hash before the stop ${h1.hash} (tick ${h1.tick}), after ${h2.hash} (tick ${h2.tick})${dp.length ? ', parts differing: ' + dp.join(', ') : ''}`);
    // (report-only: the clock's running seconds (BF.state.time), the mobs' AI state and the wild mobs kept with unloaded chunks don't
    // come back exactly from a save in any host yet, the same parts as test/server.js reports; the rest must)
    const loose = ['clock', 'mobs', 'wildlife'], strict = dp.filter(k => !loose.includes(k));
    check(h2.tick === h1.tick && !strict.length, `after the restart the world hashes the same as before the stop, part by part (${Object.keys(h1.parts).length - loose.length} parts${strict.length ? '; differs: ' + strict.join(', ') : ''})`);
    if (dp.length) console.log('report-only: ' + dp.filter(k => loose.includes(k)).join(', ') + ' differ');
    const sky = await pg2.evaluate(() => BF.client.world.clock && [BF.client.world.clock.day, BF.client.world.clock.time]);
    const tSaved = JSON.parse(fs.readFileSync(path.join(saves, f1, 'world.json'), 'utf8')).time;   // (as Ctrl+C saved it)
    check(sky && sky[0] === tSaved.day && Math.abs(sky[1] - tSaved.t) < 1e-9, `the day and time of day come back as saved (${sky && sky.join(', ')}; saved ${tSaved.day}, ${tSaved.t})`);

    // ---- Export (the title screen's button), Import it back
    await pg2.evaluate(() => { BF.save.current = null; });   // (the title screen: no world being played, as after Save and Quit)
    const [dl] = await Promise.all([pg2.waitForEvent('download', { timeout: 30000 }), pg2.evaluate(id => document.querySelector(`.bfp-world[data-id="${id}"] [data-act="export"]`).click(), id)]);
    const file = path.join(saves, '.export.bfworld');
    await dl.saveAs(file);
    const fb = fs.readFileSync(file), rec = SaveFile.unpackSync(fb);
    check(dl.suggestedFilename() === NAME + '.bfworld' && fb[0] === 0x1f && rec.meta.id === id && rec.log && rec.log.lists.length > 0, `Export downloads "${dl.suggestedFilename()}" (${Math.round(fb.length / 1024)} KB, gzipped, with its game log)`);
    check(same(rec.data, dataOf(f1)), 'it holds the world\'s save data');
    await pg2.setInputFiles('.bfp-importfile', file);
    const imp = await until(async () => { const r = await rows(pg2); return r.length >= 2 && /Imported/.test(await note(pg2)) ? r : null; }, 90000);
    const copy = imp && imp.find(r => r.id !== id && /Saves test/.test(r.text));
    const f2 = copy && folderOf(copy.id);
    check(copy && f2 === NAME + ' (2)', `Import adds it as a second world with a new id, folder "${f2}"`);
    check(f2 && same(dataOf(f2), dataOf(f1)), 'with the same save data');
    // rename moves its folder; delete removes it
    await pg2.evaluate(cid => document.querySelector(`.bfp-world[data-id="${cid}"] [data-act="rename"]`).click(), copy.id);
    await pg2.evaluate(() => { document.querySelector('.bfp-world input').value = 'Renamed copy'; document.querySelector('.bfp-world [data-act="rename-ok"]').click(); });
    const rf = await until(() => folderOf(copy.id) === 'Renamed copy', 90000);
    check(rf, `Rename moves its folder (${folderOf(copy.id)})`);
    await until(async () => (await rows(pg2)).some(r => r.id === copy.id && /Renamed copy/.test(r.text)), 90000);   // (the list redrawn after the rename)
    await pg2.evaluate(cid => document.querySelector(`.bfp-world[data-id="${cid}"] [data-act="delete"]`).click(), copy.id);
    await pg2.evaluate(() => document.querySelector('.bfp-world.confirm [data-act="delete-ok"]').click());
    check(await until(() => !folderOf(copy.id), 90000) && !fs.existsSync(path.join(saves, 'Renamed copy')), 'Delete removes its folder');
    // a 1.4 world file is refused
    const old14 = SaveFile.packSync({ game: '1.4', meta: Object.assign({}, rec.meta, { version: 2, name: 'Old 1.4' }), data: Object.assign({}, rec.data, { version: 2 }) });
    fs.writeFileSync(path.join(saves, '.old.bfworld'), old14);
    await pg2.setInputFiles('.bfp-importfile', path.join(saves, '.old.bfworld'));
    const n14 = await waitNote(pg2, /Couldn.t import/);
    check(/Made with Blockfield 1\.4, can't be opened in 1\.5/.test(n14 || ''), `Import refuses a 1.4 world file (${n14})`);

    // ---- Copy browser saves to the server
    await pg2.evaluate(async ([buf]) => {
      const rec = await BF.saveFile.unpack(new Uint8Array(buf));
      rec.meta.id = 'wbrowser1'; rec.meta.name = 'Browser world';
      await BF.save.importRecord(rec, false);   // (into this browser's IndexedDB)
      const old = { meta: Object.assign({}, rec.meta, { id: 'wbrowser14', name: 'Browser 1.4 world', version: 2 }), data: Object.assign({}, rec.data, { version: 2 }) };
      await new Promise((res, rej) => { const q = indexedDB.open('blockfield'); q.onsuccess = () => { const t = q.result.transaction(['worlds', 'data'], 'readwrite'); t.objectStore('worlds').put(old.meta); t.objectStore('data').put(old.data, old.meta.id); t.oncomplete = res; t.onerror = () => rej(t.error); }; q.onerror = () => rej(q.error); });
    }, [[...fb]]);
    await pg2.evaluate(() => BF.player.refreshWorlds());   // (the list again, as the title screen shows it)
    const cb = await until(() => pg2.evaluate(() => { const x = document.querySelector('[data-act="copy-browser"]'); return x && !x.hidden ? x.textContent : null; }), 90000);
    check(cb === 'Copy browser saves to the server (1)', `the title screen offers to copy this browser's worlds (${cb})`);
    await pg2.evaluate(() => document.querySelector('[data-act="copy-browser"]').click());
    const c1 = await waitNote(pg2, /^Browser saves:/);
    check(/1 copied, 1 too old to open/.test(c1 || ''), `it copies them (${c1})`);
    check(folderOf('wbrowser1') === 'Browser world' && !folderOf('wbrowser14'), 'the browser world is now a server folder; the 1.4 world was left behind');
    check((await rows(pg2)).some(r => r.id === 'wbrowser1'), 'and the server\'s list has it');
    await pg2.evaluate(() => document.querySelector('[data-act="copy-browser"]').click());
    const c2 = await waitNote(pg2, /^Browser saves: 0 copied/);
    check(/0 copied, 1 already there/.test(c2 || ''), `a second copy skips it (${c2})`);
    check((await pg2.evaluate(() => BF.save.browserList())).some(w => w.id === 'wbrowser1'), 'the browser keeps its own copy');
    const logC = await pg2.evaluate(() => BF.glog.recent(500).filter(e => e.k === 'save' && e.l === 'INFO').map(e => e.x));
    check(logC.some(x => /^Imported world "Saves test"/.test(x)) && logC.some(x => /^Copied browser saves to the world server: 1 copied/.test(x)) && logC.some(x => /^Exported world/.test(x)), 'the game log has the export, the import and the copy');
    await pg2.close();

    // ---- browser-only mode: the same file into IndexedDB and back
    const pg3 = await open(b, base + '/index.html?sim=page&debugfeed=off#seed' + seed);
    const m3 = await pg3.evaluate(() => ({ mode: BF.simHost.mode, where: document.querySelector('.bfp-where').textContent }));
    check(m3.mode === 'in page' && m3.where === 'Singleplayer', `a page with no world server keeps its worlds in the browser (${m3.mode})`);
    await pg3.setInputFiles('.bfp-importfile', file);
    const r3 = await until(async () => { const r = await rows(pg3); const t = await note(pg3); return /Imported/.test(t) ? r : null; }, 90000);
    const bw = r3 && r3.find(r => r.id !== 'wbrowser1' && /Saves test/.test(r.text));
    check(!!bw, 'in browser-only mode Import adds the world to IndexedDB');
    const [dl3] = await Promise.all([pg3.waitForEvent('download', { timeout: 30000 }), pg3.evaluate(i => document.querySelector(`.bfp-world[data-id="${i}"] [data-act="export"]`).click(), bw.id)]);
    const file3 = path.join(saves, '.export3.bfworld');
    await dl3.saveAs(file3);
    const rec3 = SaveFile.unpackSync(fs.readFileSync(file3));
    check(dl3.suggestedFilename() === NAME + '.bfworld' && same(rec3.data, rec.data) && rec3.log && rec3.log.lists.length === rec.log.lists.length, `and Export gives the same file format back (${dl3.suggestedFilename()}, same save data and log)`);
    await pg3.close();
  } catch (e) {
    check(false, 'the test ran: ' + (e && e.stack || e));
  } finally {
    await b.close();
    srv.kill();
    await Promise.race([srv.exited, new Promise(r => setTimeout(r, 10000))]);
    try { fs.rmSync(saves, { recursive: true, force: true }); } catch (e) { console.log('could not remove ' + saves + ': ' + e.message); }
  }
  console.log(fails ? `FAILED ${fails} check(s)` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
