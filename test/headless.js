// @ci integration suite=world timeout=1800
// Headless simulation boot (spec r15-40): the simulation runs with no page. Checks that
//   - js/simfiles.js and index.html list the shared files in the same order, and that every sim file is in index.html;
//   - node tools/headless.js runs a seed without errors and reports villagers and villager-seconds;
//   - its world state hash matches a page that boots and ticks the same way (BF.boot.headless, js/boot.js), part by part;
//   - a headless save loads back into a page.
// REPORT-ONLY on the hash until Stage 1 (r15-10, r15-14 to r15-23) has merged and test/determinism.js enforces: a page and Node
// differ for the same reasons two pages do (js/statehash.js, reports/r15-24.md). The other checks always count.
// Usage: NODE_PATH=$(npm root -g) node test/headless.js [seed=3] [seconds=60]
const ENFORCE = false;
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 60);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

(async () => {
  // ---- the two lists agree
  const sim = require('../js/simfiles.js');
  const html = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/src="(js\/[^"]+)"/g)].map(m => m[1]);
  const missing = sim.filter(f => !html.includes(f));
  check(!missing.length, `every sim file is in index.html${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);
  const shared = html.filter(f => sim.includes(f));
  const order = shared.join() === sim.filter(f => html.includes(f)).join();
  check(order, 'index.html and js/simfiles.js load the shared files in the same order');
  for (const f of sim) if (!fs.existsSync(path.join(root, f))) check(false, `js/simfiles.js lists a file that does not exist: ${f}`);

  // ---- Node
  const logFile = path.join(require('os').tmpdir(), `bf-headless-${process.pid}.log`);
  const saveFile = path.join(require('os').tmpdir(), `bf-headless-${process.pid}.json`);
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, ['tools/headless.js', '--seed', String(seed), '--seconds', String(seconds),
    '--json', '--log', logFile, '--save', saveFile], { cwd: root, encoding: 'utf8', timeout: 900000 });
  if (r.stderr && r.stderr.trim()) console.log('stderr: ' + r.stderr.trim().slice(0, 1000));
  check(r.status === 0, `tools/headless.js --seed ${seed} --seconds ${seconds} ran (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const out = (r.stdout || '').trim().split('\n').pop();
  let node = null;
  try { node = JSON.parse(out); } catch (e) { console.log('output: ' + (r.stdout || '').slice(-800)); }
  check(!!node, 'it printed its result as JSON');
  if (!node) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log(`node: ${node.villagers} villagers, ${node.mobs} mobs, ${node.chunks} chunks, ${node.vss} V·s/s, ${node.msPerTick} ms/tick, ${node.real} s real`);
  check(node.villagers > 0, `villagers were simulated (${node.villagers})`);
  check(node.vss > 0, `the villager-seconds meter counted work (${node.vss} V·s/s)`);
  check(Math.abs(node.seconds - seconds) < 0.001 && node.ticks === Math.round(seconds / 0.05), `it ticked ${seconds} game seconds in 0.05 s ticks (${node.ticks})`);
  // the game log went to the file, with the boot and the run in it
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check(/headless\s+Headless simulation booted/.test(log), 'the game log file has the headless boot line');
  check(/headless\s+Headless run ended/.test(log), 'the game log file has the headless run line');
  check(log.split('\n').length > 20, `the game log file has the run's entries (${log.split('\n').length} lines)`);

  // ---- the same boot and ticks in a page
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 400)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r2 => r2.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r2 => r2.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed + 'gen4v10');
  await pg.waitForFunction(() => !!(window.BF && BF.boot && BF.world), null, { timeout: 120000 });
  const page = await pg.evaluate(async ([seed, seconds]) => {
    const h = BF.boot.headless({ seed, settings: { at: 'village' } });   // the same boot the Node run does (js/boot.js)
    const start = h.stateHash();
    for (let i = 0, n = Math.round(seconds / BF.warp.TICK); i < n; i++) h.tick(1);
    const H = h.stateHash();
    return { start: start.hash, hash: H.hash, parts: H.parts, mobs: BF.mobs.list.length, chunks: BF.world.chunks.size,
      villagers: BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed).length };
  }, [seed, seconds]);
  console.log(`page: ${page.villagers} villagers, ${page.mobs} mobs, ${page.chunks} chunks`);
  const parts = Object.keys(node.parts).filter(k => node.parts[k] !== page.parts[k]);
  const same = node.hash === page.hash;
  console.log(`${same ? 'same ' : 'DIFF '}hash after ${seconds} s: node ${node.hash}${same ? '' : ' / page ' + page.hash + ', parts ' + parts.join(', ')}`);
  if (same || ENFORCE) check(same, 'the headless run and the page hash the same world');
  else console.log('report-only (ENFORCE off until Stage 1 merges, as test/determinism.js): the difference does not fail the test');
  check(page.chunks === node.chunks, `the same chunks are loaded (page ${page.chunks}, node ${node.chunks})`);

  // ---- a headless save loads in a page
  const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  const back = await pg.evaluate(data => {
    BF.save.restore(data, null);
    return { seed: BF.state.seed, day: +(BF.sky.day + BF.sky.time).toFixed(4), mobs: BF.mobs.list.length, edits: BF.world.edits.size };
  }, saved);
  check(back.seed === node.seed, `the headless save loads in a page (seed ${back.seed})`);
  check(back.day > 0, `its clock came back (game day ${back.day})`);
  console.log(`restored: ${back.mobs} mobs, ${back.edits} chunks with edits`);

  await b.close();
  for (const f of [logFile, saveFile]) { try { fs.unlinkSync(f); } catch (e) {} }
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('ok   headless boot');
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
