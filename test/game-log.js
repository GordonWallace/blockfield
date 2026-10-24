// @ci integration hosts=worker,server
// Game log (js/gamelog.js) and its viewer on the debug screen: NODE_PATH=$(npm root -g) node test/game-log.js [outPrefix]
// Starts debug/server.js, creates a saved world and checks the log's header (seed, version, commit), the load line, village entries
// (INFO, with the village's name and a chunk time), console errors and warnings (ERROR / WARN), job events (DEBUG), that it is
// stored with the world and comes back with the unload line and a version change after a reload, that chunk time is saved, and
// on the debug screen: hidden until its button is clicked, DEBUG off at first, the level filter, live entries, Copy and Download.
// BF_HOST=page|worker|server (spec r15-43): the world's log is kept where the simulation is (the page's own errors go there), so it is
// read there (lib.sim); Save and Quit tells it the world is closed (js/save.js quit).
const path = require('path'), fs = require('fs'), os = require('os'), { spawn, execSync } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/game-log';
const lib = require('./lib');
const FILE = path.join(os.tmpdir(), 'bf-test-alerts-' + process.pid + '.json');
let GAME = 0, DBG = 0;
(async () => {
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : '')); if (!c) fails.push(n); };
  let commit = null; try { commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch (e) { /* not a checkout */ }
  const srv = await lib.serve({ world: lib.host() === 'server', args: ['--alerts', FILE] });
  GAME = srv.game; DBG = srv.debug;
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const game = await ctx.newPage();
  game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await lib.install(game);   // (BFT.sim)
  await game.goto(`http://localhost:${GAME}/?nolod&${require('./lib').q()}#seed123`);   // no distant terrain: under swiftshader its rings drop the planet to about 1 fps
  await game.waitForTimeout(4000);
  await require('./lib').ready(game);
  const VER = await game.evaluate(() => BF.VERSION), VRE = VER.replace('.', '\\.');
  await lib.simReady(game);
  const until = (pg, fn, arg, t = 20000) => pg.waitForFunction(fn, arg, { timeout: t, polling: 100 }).then(() => true, () => false);
  const simUntil = (fn, arg, t = 20000) => lib.simWait(game, fn, arg, t).then(v => !!v);

  // ---- a saved world gets a log
  const id = await game.evaluate(() => BF.save.create({ name: 'Log test', seed: 1337 }).then(m => m.id));
  await require('./lib').ready(game);
  ok('the log opens with the world', await simUntil(() => BF.glog.ready() && BF.glog.world() !== null));
  const h = await lib.sim(game, () => BF.glog.headLine());
  ok('header: world, seed, version, commit', new RegExp('^# Blockfield game log \\| world "Log test" \\| seed 1337 \\| version ' + VRE + ' \\| commit ').test(h) && (!commit || h.includes(commit)), h);
  ok('the load is logged as INFO', await lib.sim(game, () => BF.glog.entries().some(e => e.l === 'INFO' && e.k === 'game' && /^Game loaded: "Log test", seed 1337/.test(e.x))));
  await require('./lib').toVillage(game);
  // the page's own console errors and warnings (they go to the simulation's log), a village entry and a job event there
  await game.evaluate(() => { console.error(new Error('test boom')); console.warn('test warning'); });
  await lib.sim(game, () => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    BF.vlog.log(rec, 'job', 'Test Person became a Tester', BF.player.position);
    BF.glog.job('miner', { kind: 'test', day: 1, who: 'miner#1', n: 2, ore: 'iron ore' });
  });
  await simUntil(() => BF.glog.entries().some(e => e.l === 'WARN' && e.x === 'test warning'));
  const v = await lib.sim(game, () => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const E = BF.glog.entries(), name = BF.signs.villageName(rec.key);
    return { name, vil: E.find(e => e.x === 'Test Person became a Tester'), err: E.find(e => e.l === 'ERROR' && /test boom/.test(e.x)), warn: E.find(e => e.l === 'WARN' && e.x === 'test warning'),
      job: E.find(e => e.l === 'DEBUG' && e.k === 'miner' && e.x.startsWith('test')), others: E.filter(e => e.v && e.l === 'INFO').length, line: BF.glog.text().split('\n')[1] };
  });
  ok('village entries are INFO with the village name and a chunk time', v.vil && v.vil.l === 'INFO' && v.vil.k === 'job' && v.vil.v === v.name && v.vil.c > 0, v.vil);
  ok('console.error is an ERROR with its stack', v.err && /test boom/.test(v.err.x) && /\n/.test(v.err.x), v.err);
  ok('console.warn is a WARN', !!v.warn);
  ok('job events are DEBUG, key=value', v.job && v.job.x === 'test who=miner#1 n=2 ore="iron ore"', v.job);
  ok('lines carry system time, game time, chunk time and level', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} {2}Day \d+ \d\d:\d\d +chunk (-|\d+d \d\d:\d\d) +INFO {3}game {2}Game loaded/.test(v.line), v.line);

  // ---- the debug screen: closed until asked, DEBUG off at first, filters, live entries, copy and download
  const dbg = await ctx.newPage();
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  ok('the game log starts closed', await until(dbg, () => document.getElementById('gpanel').hidden && document.getElementById('g-open') !== null, null, 5000));
  await until(dbg, () => /error/.test(document.getElementById('g-errs').textContent), null, 15000);
  await dbg.click('#g-open');
  ok('opens above the rest with its entries', await until(dbg, () => !document.getElementById('gpanel').hidden && [...document.querySelectorAll('#glog .gent.ERROR')].some(r => /test boom/.test(r.textContent)), null, 15000));
  ok('the header line is shown', await dbg.evaluate(() => /seed 1337/.test(document.querySelector('#glog .ghead').textContent)));
  ok('DEBUG is hidden at first', await dbg.evaluate(() => !document.querySelector('#glog .gent.DEBUG')));
  await dbg.click('#g-levels summary');
  await dbg.click('#g-levels .frow[data-v="DEBUG"] input');
  ok('turning DEBUG on shows job events', await until(dbg, () => [...document.querySelectorAll('#glog .gent.DEBUG')].some(r => /who=miner#1/.test(r.textContent)), null, 5000));
  await dbg.click('#g-levels .frow[data-v="INFO"] input');
  ok('turning INFO off hides village entries', await until(dbg, () => !document.querySelector('#glog .gent.INFO'), null, 5000));
  await dbg.click('#g-levels .frow[data-v="INFO"] input');
  await game.evaluate(() => console.error('live error ' + 42));
  ok('new entries arrive live', await until(dbg, () => [...document.querySelectorAll('#glog .gent.ERROR')].some(r => /live error 42/.test(r.textContent)), null, 10000));
  await dbg.fill('#g-q', 'test');
  await dbg.waitForTimeout(600);
  const [dl] = await Promise.all([dbg.waitForEvent('download'), dbg.click('#g-dl')]);
  const file = fs.readFileSync(await dl.path(), 'utf8');
  ok('download: a .log of the shown entries under the header', dl.suggestedFilename() === 'Log test.log' && file.startsWith('# Blockfield game log | world "Log test"') && /test boom/.test(file) && !/live error/.test(file), { name: dl.suggestedFilename(), file: file.slice(0, 400) });
  await dbg.click('#g-copy');
  await dbg.waitForTimeout(300);
  const clip = await dbg.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  ok('copy: the same text', clip === file, clip && clip.slice(0, 200));
  await dbg.fill('#g-q', '');
  await dbg.screenshot({ path: out + '-screen.png' });
  ok('the server holds the whole log', await (async () => { const g = await (await fetch(`http://localhost:${DBG}/glog`)).json(); const n = await lib.sim(game, () => BF.glog.base() + BF.glog.entries().length); return g && g.w === id && g.base + g.lines.length >= n - 5; })());

  // ---- stored with the world: quit, reload the page, load it under another version
  const before = await lib.sim(game, () => { const p = BF.player.position; return { n: BF.glog.entries().length, cd: BF.glog.chunkDays(p.x, p.z), x: p.x, z: p.z }; });
  ok('chunk time grows while loaded', before.cd > 0, before);
  await game.evaluate(() => BF.save.saveNow().then(() => BF.save.quit()));   // (js/player.js Save and Quit to Title)
  ok('quitting closes the log', await simUntil(() => !BF.glog.world()));
  await game.waitForTimeout(1500);
  await game.reload(); await game.waitForTimeout(4000);
  await require('./lib').ready(game);
  await lib.simReady(game);
  await lib.sim(game, () => { BF.VERSION += '-test'; });   // (the log's version is where the log is kept)
  await game.evaluate(id => BF.save.load(id), id);
  ok('the log comes back with the world', await simUntil(id => BF.glog.ready() && BF.glog.world() === id, id));
  const back = await lib.sim(game, p => {
    const E = BF.glog.entries();
    return { n: E.length, boom: E.some(e => /test boom/.test(e.x)), unload: E.filter(e => /^Game unloaded: "Log test"/.test(e.x)).length, loads: E.filter(e => /^Game loaded/.test(e.x)).length,
      ver: (E.find(e => e.k === 'version') || {}).x, crash: E.some(e => /without unloading/.test(e.x)), cd: BF.glog.chunkDays(p.x, p.z), head: BF.glog.headLine() };
  }, before);
  ok('earlier entries are kept', back.boom && back.n > before.n, back);
  ok('the unload and the second load are logged', back.unload === 1 && back.loads === 2, back);
  ok('no crash warning after a clean quit', !back.crash);
  if (lib.host() === 'server') console.log('(the version change is not checked on the world server: each world starts in a fresh thread there, which the test can\'t give another version)');
  else ok('the version change is logged; the header keeps the first', new RegExp('^Version changed: ' + VRE + ' \\(commit .*\\) -> ' + VRE + '-test \\(commit ').test(back.ver || '') && back.head.includes('version ' + VER + ' |'), back);
  ok('chunk time is saved with the world', back.cd >= before.cd, { before: before.cd, after: back.cd });
  const disk = await lib.sim(game, () => { BF.glog.diskBuild({ commit: 'abcdef1234567', version: '9.9', branch: 'x' }); BF.glog.diskBuild({ commit: 'abcdef1234567' }); return BF.glog.entries().filter(e => e.l === 'WARN' && /files on disk changed to 9\.9 \(commit abcdef1234/.test(e.x)).length; });
  ok('a commit change on disk is a WARN, once', disk === 1, disk);
  // ---- deleting the world deletes its log
  await game.evaluate(id => { BF.save.quit(); return BF.save.remove(id); }, id);
  const gone = await lib.sim(game, id => BF.save.logStore.read(id), id);
  ok('deleting the world deletes its log', gone.head === null && gone.entries.length === 0, gone);

  await b.close(); await srv.stop();
  try { fs.unlinkSync(FILE); } catch (e) {}
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
