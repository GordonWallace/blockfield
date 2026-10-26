// (tools/bench/README.md has the run steps.)
// Blockfield 1.4 vs 1.5 on your own machine: the real game in your Chrome, drawing on your GPU, in a window kept off-screen, run on a
// 1.4 checkout and then a 1.5 checkout with the same seed and the same villages forced to be simulated, so the two carry the same load.
// Usage: node laptop.js --b14 <release-1-4 checkout> --b15 <release-1-5 checkout> [--seed 3] [--villages 8] [--speeds 0,3,4,5]
//                       [--secs 60] [--settle 60] [--monsters] [--out results] [--headless] [--allow-cpu] [--chrome <path>] [--only 1.4|1.5]
//   --villages n: the n villages nearest the spawn's village are simulated (1 = that village alone). Both versions load them the same
//     way (villageSim trip pins with its limits lifted), wherever they are; in 1.5 that happens inside its Web Worker.
//   --speeds: fast-forward indexes (0 = 1x, 1 = 3x, 2 = 5x, 3 = 10x, 4 = 100x, 5 = 1000x), each measured for --secs real seconds.
//   --settle: real seconds after the villages are in and before measuring (villagers come out and get going).
//   --monsters: monsters spawn as in play. Off by default: they spawn at random and would make the mob counts differ between the two
//     runs (wild animals still differ a little: they roll at random as chunks load).
//   --headless: Chrome's headless mode instead of an off-screen window (on Linux it often draws on the CPU; the check below stops it).
//   --allow-cpu: carry on when WebGL is on a software renderer (SwiftShader, llvmpipe); otherwise the run stops, as the numbers
//     wouldn't be your GPU's.
// Writes <out>.json (everything) and <out>.md (the comparison table). Needs Node and playwright (npm i playwright, or NODE_PATH=$(npm
// root -g)); it uses your installed Chrome (channel "chrome"), or --chrome <path>, or Playwright's Chromium if neither is there.
// Each checkout is served by this script on its own port (as run.sh's game server serves it), so nothing else needs to run.
// Leave the window alone: it can sit behind other windows or on another workspace (throttling for hidden windows is turned off), but
// don't minimise it: a minimised page is hidden, and 1.5 pauses its simulation when the page is hidden. The results note if it was.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require(process.env.PW || 'playwright');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const SEED = +opt('seed', 3), NV = +opt('villages', 8), SECS = +opt('secs', 60), SETTLE = +opt('settle', 60);
const SPEEDS = String(opt('speeds', '0,3,4,5')).split(',').map(Number), CALM = !opt('monsters', false), OUT = opt('out', 'bench-results');
const SPEED_X = [1, 3, 5, 10, 100, 1000];
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const r2 = x => (x == null || !isFinite(x) ? null : +x.toFixed(2));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
function serve(root) {
  const s = http.createServer((q, r) => {
    const f = path.join(root, decodeURIComponent(q.url.split(/[?#]/)[0]));
    if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(b); });
  });
  return new Promise(res => s.listen(0, '127.0.0.1', () => res(s)));
}

async function launch() {
  const headless = !!opt('headless', false);
  const args = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', '--autoplay-policy=no-user-gesture-required'];
  if (!headless) args.push('--window-position=-3000,-3000', '--window-size=1280,760');
  else args.push('--enable-gpu', '--use-angle=default');
  const tries = opt('chrome', null) ? [{ executablePath: opt('chrome') }] : [{ channel: 'chrome' }, {}];
  let err;
  for (const t of tries) {
    try { const b = await chromium.launch({ ...t, headless, args }); log('browser', t.channel || t.executablePath || 'playwright chromium', b.version()); return b; } catch (e) { err = e; }
  }
  throw err;
}

// Runs where the simulation is (1.4: the page; 1.5: the Web Worker, through the test eval hook BF_TEST turns on). Installs the
// helpers there: __bench.force(home, n) pins the n villages nearest home (and lifts villageSim's limits, keeps the merchants from
// unpinning them); __bench.census() counts what the simulation holds; __bench.now() its clock.
const SIM_HELPERS = function (calm) {
  const BF = globalThis.BF, P = BF.planet, vKey = v => Math.round(v.x) + ',' + Math.round(v.z);
  const B = globalThis.__bench = { keys: [] };
  if (calm) BF.mobs.spawning = false;
  B.force = ({ home, n }) => {
    const VS = BF.villageSim, L = VS.LIMITS;
    for (const k in L) L[k] = 1e9;
    if (!VS.__benchUnpin) { const u = VS.unpin; VS.__benchUnpin = u; VS.unpin = id => (String(id).startsWith('bench') ? undefined : u(id)); }
    const list = BF.worldgen.villagesNear(home.x, home.z, 4000).sort((a, b) => P.distance(home, a) - P.distance(home, b)).slice(0, n);
    const pins = VS.pins();
    for (const id of [...pins.keys()]) if (String(id).startsWith('bench')) pins.delete(id);
    for (let i = 0; i < list.length; i += 2) pins.set('bench' + i, { a: list[i], b: list[i + 1] || list[i], keys: [] });
    B.keys = list.map(vKey);
    return list.map(v => ({ key: vKey(v), d: Math.round(P.distance(home, v)) }));
  };
  B.census = () => {
    const per = {}; for (const k of B.keys) per[k] = 0;
    const kinds = { villagers: 0, hostile: 0, animals: 0, mobs: 0 };
    for (const m of BF.mobs.list) {
      if (m.dead || m.removed) continue;
      kinds.mobs++;
      if (m.type === 'villager') { kinds.villagers++; const k = m.village && m.village.key; if (k in per) per[k]++; }
      else if (m.hostile || (m.def && m.def.hostile)) kinds.hostile++;
      else kinds.animals++;
    }
    const VS = BF.villageSim;
    return { ...kinds, per, forcedActive: B.keys.filter(k => VS.isActive(k)).length, forced: B.keys.length, simulated: +(/^(\d+)/.exec(VS.status()) || [0, 0])[1],
      status: VS.status(), chunks: BF.world.chunks.size, queue: BF.world.queueLength || 0, now: BF.simNow ? BF.simNow() : 0 };
  };
  return true;
};

async function runVersion(label, root) {
  root = path.resolve(root);
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error(label + ': no index.html in ' + root);
  const srv = await serve(root);
  const url = `http://127.0.0.1:${srv.address().port}/index.html?debugfeed=off&sim=worker#seed${SEED}`;   // (1.4 ignores ?sim)
  const b = await launch();
  const pg = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); log('PAGEERROR', (e.stack || e.message).slice(0, 300)); });
  await pg.addInitScript(() => {
    window.BF_TEST = true;   // 1.5: lets this script run its helpers in the Web Worker (js/simhost.js eval); nothing else reads it
    Element.prototype.requestPointerLock = function () {};
    window.__ft = []; window.__ftOn = false; window.__hidden = 0;
    document.addEventListener('visibilitychange', () => { if (document.hidden) window.__hidden++; });
    const raf = window.requestAnimationFrame.bind(window), isGame = new WeakMap();
    const game = cb => { let g = isGame.get(cb); if (g === undefined) isGame.set(cb, g = /BF\.world\.update\(|renderer\.render\(|BF\.view\.begin/.test(String(cb))); return g; };
    window.requestAnimationFrame = cb => raf(t => {
      if (!game(cb)) return cb(t);
      const s = performance.now();
      try { cb(t); } finally { if (window.__ftOn) window.__ft.push([s, performance.now() - s]); }
    });
  });
  // three.js r128 from the checkout's test copy when there is one (the same file the CDN serves; works offline)
  if (fs.existsSync(path.join(root, '.three-test.min.js'))) await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.world && BF.mobs && BF.player && !BF.preparing, null, { timeout: 300000, polling: 250 });
  await pg.waitForTimeout(3000);
  const info = await pg.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl'), ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { version: BF.VERSION || null, renderer: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no WebGL',
      host: BF.simHost ? (BF.simHost.label ? BF.simHost.label() : BF.simHost.mode) : 'this page (1.4)', worker: !!(BF.simHost && BF.simHost.worker), ua: navigator.userAgent };
  });
  log(label, 'version', info.version, '| GPU:', info.renderer, '| simulation:', info.host);
  if (/swiftshader|llvmpipe|software|softpipe/i.test(info.renderer) && !opt('allow-cpu', false)) {
    await b.close(); srv.close();
    throw new Error(`WebGL is drawing on the CPU (${info.renderer}), so these wouldn't be your GPU's numbers. Run without --headless, or pass --allow-cpu.`);
  }
  const sim = (fn, arg) => pg.evaluate(async ([src, arg]) => {
    if (BF.simHost && BF.simHost.worker) return BF.simHost.eval(src, arg);
    return (0, eval)('(' + src + ')')(arg);
  }, [fn.toString(), arg]);
  // (1.5: the page learns the player's place from the worker a moment after it starts)
  await pg.waitForFunction(() => { const p = BF.player.position; return (BF.worldgen.villagesNear(p.x, p.z, 6000) || []).length > 0; }, null, { timeout: 120000, polling: 500 });
  // the player: out of the title screen (the boot world runs behind it), creative, flying 40 blocks over the village nearest the spawn
  const home = await pg.evaluate(() => {
    if (BF.player.start) BF.player.start();
    const P = BF.planet, p = BF.player.position;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    const y = (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3;
    BF.player.spawn(v.x + 0.5, y, v.z + 0.5);
    BF.player.position.y = y + 40;
    if (BF.player.setFlying) BF.player.setFlying(true);
    if (BF.player.pitch != null) BF.player.pitch = -0.7;
    return { x: v.x, z: v.z };
  });
  await pg.waitForTimeout(3000);
  await sim(SIM_HELPERS, CALM);
  const plan = await sim(a => globalThis.__bench.force(a), { home, n: NV });
  log(label, `forcing ${plan.length} villages:`, plan.map(p => p.key + ' (' + p.d + ' blocks)').join(', '));
  // wait for every forced village to be simulated with its villagers out
  const t0 = Date.now();
  let c;
  for (;;) {
    await pg.waitForTimeout(5000);
    c = await sim(() => globalThis.__bench.census());
    const empty = Object.values(c.per).filter(x => !x).length;
    log(label, `loading: ${c.forcedActive}/${c.forced} simulated, ${empty} without villagers yet, ${c.villagers} villagers, ${c.chunks} chunks, queue ${c.queue}`);
    if (c.forcedActive === c.forced && !empty && c.queue === 0) break;
    if (Date.now() - t0 > 15 * 60000) { log(label, 'still not all loaded after 15 minutes: measuring anyway'); break; }
  }
  log(label, `settling ${SETTLE} s`);
  await pg.waitForTimeout(SETTLE * 1000);
  const res = { label, root, ...info, url, home, villages: plan, runs: [], errors };
  const shot = OUT + '-' + label + '.png';
  await pg.screenshot({ path: shot }).catch(() => {});   // what was on screen while measuring: the village, not the title screen
  log(label, 'screenshot', shot);
  for (const si of SPEEDS) {
    await pg.evaluate(i => BF.warp.set(i), si);
    await pg.waitForTimeout(5000);
    const c0 = await sim(() => globalThis.__bench.census());
    const f = await pg.evaluate(async S => {
      window.__ft = []; window.__ftOn = true; const h0 = window.__hidden, t0 = performance.now();
      await new Promise(r => setTimeout(r, S * 1000));
      window.__ftOn = false;
      return { wall: (performance.now() - t0) / 1000, ft: window.__ft.slice(), hidden: window.__hidden - h0 || (document.hidden ? 1 : 0) };
    }, SECS);
    const c1 = await sim(() => globalThis.__bench.census());
    const d = f.ft.map(x => x[1]).sort((a, b) => a - b), gaps = [];
    for (let i = 1; i < f.ft.length; i++) gaps.push(f.ft[i][0] - f.ft[i - 1][0]);
    gaps.sort((a, b) => a - b);
    const q = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null);
    const run = {
      speed: SPEED_X[si] + 'x', achieved: r2((c1.now - c0.now) / f.wall), fps: r2(f.ft.length / f.wall),
      frameMs: { mean: r2(d.reduce((a, x) => a + x, 0) / Math.max(1, d.length)), p50: r2(q(d, 0.5)), p95: r2(q(d, 0.95)), p99: r2(q(d, 0.99)), max: r2(d[d.length - 1]) },
      gapMs: { p50: r2(q(gaps, 0.5)), p95: r2(q(gaps, 0.95)), p99: r2(q(gaps, 0.99)), max: r2(gaps[gaps.length - 1]) },
      longFrames: gaps.filter(g => g > 50).length,
      villagers: c1.villagers, mobs: c1.mobs, hostile: c1.hostile, animals: c1.animals, chunks: c1.chunks, simulated: c1.simulated, forcedActive: c1.forcedActive,
      hidden: f.hidden > 0,
    };
    res.runs.push(run);
    log(label, `${run.speed}: ${run.achieved} game s/s achieved, ${run.fps} fps, frame ms p50 ${run.frameMs.p50} p95 ${run.frameMs.p95} p99 ${run.frameMs.p99}, ` +
      `${run.longFrames} gaps over 50 ms; ${run.villagers} villagers, ${run.mobs} mobs, ${run.chunks} chunks${run.hidden ? ' (THE PAGE WAS HIDDEN)' : ''}`);
  }
  await pg.evaluate(() => BF.warp.set(0));
  await b.close(); srv.close();
  return res;
}

function table(out) {
  const L = [];
  L.push(`# Blockfield 1.4 vs 1.5, ${out.when.slice(0, 16).replace('T', ' ')} UTC`, '');
  L.push(`Machine: ${out.machine.cpus} x ${out.machine.cpu}, ${out.machine.memGB} GB, ${out.machine.platform}. Seed ${SEED}, ${NV} villages forced${CALM ? ', no monsters' : ''}, ${SECS} s a speed.`, '');
  for (const v of out.versions) L.push(`- ${v.label}: Blockfield ${v.version}, simulation in ${v.host}, GPU ${v.renderer}. ${v.villages.length} villages forced, ${v.runs[0] ? v.runs[0].villagers : '?'} villagers.${v.errors.length ? ' Page errors: ' + v.errors.length + ' (see the JSON).' : ''}`);
  L.push('', '| speed | version | game s/s achieved | fps | frame ms p50 / p95 / p99 | gaps > 50 ms | villagers | mobs | chunks |', '|---|---|---|---|---|---|---|---|---|');
  const by = {};
  for (const v of out.versions) for (const r of v.runs) (by[r.speed] = by[r.speed] || []).push([v.label, r]);
  for (const [sp, rows] of Object.entries(by)) for (const [lab, r] of rows)
    L.push(`| ${sp} | ${lab} | ${r.achieved} | ${r.fps} | ${r.frameMs.p50} / ${r.frameMs.p95} / ${r.frameMs.p99} | ${r.longFrames} | ${r.villagers} | ${r.mobs} | ${r.chunks} |${r.hidden ? ' (page hidden)' : ''}`);
  L.push('', 'Frame ms is the time inside the game\'s own animation frame (in 1.4 that includes the simulation; in 1.5 the simulation is in the worker). ' +
    'Game s/s achieved is the simulation clock against the wall clock: at 1x it should be 1; at the top speeds it is the most the machine kept up.');
  return L.join('\n') + '\n';
}

(async () => {
  const which = opt('only', null);
  const todo = [['1.4', opt('b14', null)], ['1.5', opt('b15', null)]].filter(([l, r]) => r && (!which || which === l));
  if (!todo.length) { console.log('usage: node laptop.js --b14 <release-1-4 checkout> --b15 <release-1-5 checkout> [--villages 8] [--speeds 0,3,4,5] [--secs 60]'); process.exit(2); }
  const out = { when: new Date().toISOString(), seed: SEED, villagesForced: NV, calm: CALM, secs: SECS, speeds: SPEEDS.map(i => SPEED_X[i]),
    machine: { cpus: os.cpus().length, cpu: os.cpus()[0].model, memGB: Math.round(os.totalmem() / 2 ** 30), platform: os.platform() + ' ' + os.release() }, versions: [] };
  for (const [label, root] of todo) {
    log(`==== ${label} from ${root}`);
    out.versions.push(await runVersion(label, root));
    fs.writeFileSync(OUT + '.json', JSON.stringify(out, null, 1));
  }
  fs.writeFileSync(OUT + '.md', table(out));
  log(`wrote ${OUT}.json and ${OUT}.md`);
  console.log('\n' + table(out));
  process.exit(0);
})().catch(e => { console.error(e.message || e); process.exit(1); });
