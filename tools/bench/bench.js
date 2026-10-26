// Blockfield 1.4 vs 1.5 benchmark: the same measurements on any 1.4 or 1.5 checkout, so the two can be compared on one machine.
// Usage: node bench.js <mode> <root> [--seed 3] [--out file.json] [mode options]
//   sim     <root> [--villages 1,4,8,12,16] [--warm 2400] [--steps 2000] [--calm]
//           The simulation alone, nothing drawn, in the page (file://: 1.5 runs in-page there, the same thread as 1.4). A creative player
//           hovers over the village nearest the spawn; for each N in --villages (ascending, in one world) the N villages nearest that one
//           are forced to be simulated with the same mechanism in both versions (villageSim trip pins, limits raised), their chunks are
//           loaded, --warm ticks run, then --steps ticks of 0.05 s are timed. Reports ms per tick, the top fast-forward that fits
//           (game s per real s), villages actually simulated, villagers, mobs by kind and chunks loaded. --calm: no monsters spawned.
//   frames  <root> [--speeds 0,4,5] [--secs 30] [--villages 4]
//           The real game over http (1.5 takes a Web Worker there, as players get it), drawing, standing in the village at each speed
//           index (0 = 1x, 4 = 100x, 5 = 1000x): frame time inside the game's animation frames (mean, p95, p99, max), frames per second,
//           and the game seconds per real second achieved.
//   budget  <root> [--mins 5] [--budget 40]
//           1x play over http standing in the village, the simulated-villages budget on (1.5: ?budget=N; 1.4 has no budget, its rule
//           runs): every 30 s the villages simulated, the extras, villagers and the sim's share of real time (1.5).
// Needs playwright: NODE_PATH=$(npm root -g) (or PW=<path>). three.js comes from the checkout's .three-test.min.js like the tests.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW || 'playwright');

const argv = process.argv.slice(2);
const mode = argv[0], root = path.resolve(argv[1] || '.');
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const SEED = +opt('seed', 3), OUT = opt('out', null);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
function serve() {
  const s = http.createServer((q, r) => {
    const f = path.join(root, decodeURIComponent(q.url.split(/[?#]/)[0]));
    if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(b); });
  });
  return new Promise(res => s.listen(0, '127.0.0.1', () => res(s)));
}

async function boot({ url, halt, size = [320, 200] }) {
  const opts = { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
  const b = await chromium.launch(opts).catch(() => chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium' }));
  const pg = await b.newPage({ viewport: { width: size[0], height: size[1] } });
  pg.on('pageerror', e => log('PAGEERROR', (e.stack || e.message).slice(0, 300)));
  await pg.addInitScript(halt => {
    window.BF = window.BF || {}; window.BF.lodOff = true; window.BF_LOD_OFF = true;   // no distant terrain rings in either
    Element.prototype.requestPointerLock = function () {};
    const raf = window.requestAnimationFrame.bind(window);
    window.__ft = []; window.__ftOn = false; window.__halt = false;
    const isGame = new WeakMap(), game = cb => { let g = isGame.get(cb); if (g === undefined) isGame.set(cb, g = /BF\.world\.update\(|simFrame|BF\.view\.begin/.test(String(cb))); return g; };
    window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(t => {
      if (!game(cb)) return cb(t);
      const s = performance.now();
      try { cb(t); } finally { if (window.__ftOn) window.__ft.push([s, performance.now() - s]); }
    }));
  }, halt);
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.world && BF.mobs && BF.player && !BF.preparing, null, { timeout: 300000, polling: 200 });
  await pg.waitForTimeout(3000);
  const version = await pg.evaluate(() => BF.VERSION || (BF.version && BF.version.game) || null);
  log('booted', version, url);
  return { b, pg, version };
}

// In the page: helpers both versions share. __step(h) is one simulation tick (1.5: BF.simStep; 1.4: the body of main.js's fast-forward
// loop). __plan(n) lists the n villages nearest the hover village; __force(list) pins them all (trip pins, the one way both versions
// simulate a village whatever its distance), lifts the loading limits and keeps the merchants from unpinning them.
const PAGE_HELPERS = () => {
  const P = BF.planet;
  window.__step = BF.simStep ? h => BF.simStep(h) : h => {
    const W = BF.warp;
    W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h);
    if (BF.dayTimeline) BF.dayTimeline.update();
    BF.drops.update(h); BF.boats.update(h);
    if (BF.inventory.simTick) BF.inventory.simTick(h);
    BF.world.tickSim();
  };
  const vKey = v => Math.round(v.x) + ',' + Math.round(v.z);
  window.__vKey = vKey;
  window.__hover = () => {
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    const y = (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3;
    BF.player.spawn(v.x + 0.5, y, v.z + 0.5);
    BF.player.position.y = y + 40;   // above the village so the player never lands inside terrain
    if (BF.player.setFlying) BF.player.setFlying(true);
    window.__home = { x: v.x, z: v.z, key: vKey(v) };
    return window.__home;
  };
  window.__plan = n => {
    const h = window.__home;
    return BF.worldgen.villagesNear(h.x, h.z, 4000).sort((a, b) => P.distance(h, a) - P.distance(h, b)).slice(0, n);
  };
  window.__force = list => {
    const VS = BF.villageSim, L = VS.LIMITS;
    for (const k in L) L[k] = 1e9;
    if (!VS.__benchUnpin) { const u = VS.unpin; VS.__benchUnpin = u; VS.unpin = id => (String(id).startsWith('bench') ? undefined : u(id)); }
    const pins = VS.pins();
    for (const id of [...pins.keys()]) if (String(id).startsWith('bench')) pins.delete(id);
    for (let i = 0; i < list.length; i += 2) pins.set('bench' + i, { a: list[i], b: list[i + 1] || list[i], keys: [] });
    VS.unpin('bench-none');   // (sets nothing; the next update picks the pins up within 1.5 s)
    return list.map(vKey);
  };
  window.__census = keys => {
    const per = {}; for (const k of keys) per[k] = 0;
    const kinds = { villager: 0, hostile: 0, other: 0, total: 0 };
    for (const m of BF.mobs.list) {
      if (m.dead || m.removed) continue;
      kinds.total++;
      if (m.type === 'villager') { kinds.villager++; const k = m.village && m.village.key; if (k in per) per[k]++; }
      else if (m.hostile || (m.def && m.def.hostile)) kinds.hostile++;
      else kinds.other++;
    }
    const VS = BF.villageSim;
    const active = keys.filter(k => VS.isActive(k)).length;
    return { per, kinds, active, simulated: +(/^(\d+)/.exec(VS.status()) || [0, 0])[1], status: VS.status(), chunks: BF.world.chunks.size, kept: VS.keepKeys.size, queue: BF.world.queueLength };
  };
};

const pct = (s, q) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null;
const r2 = x => x == null ? null : +x.toFixed(2);

async function simMode() {
  const list = String(opt('villages', '1,4,8,12,16')).split(',').map(Number).sort((a, b) => a - b);
  const WARM = +opt('warm', 2400), STEPS = +opt('steps', 2000), calm = !!opt('calm', false);
  const { b, pg, version } = await boot({ url: 'file://' + path.join(root, 'index.html') + '?debugfeed=off&sim=page#seed' + SEED });
  await pg.evaluate(PAGE_HELPERS);
  const home = await pg.evaluate(calm => { window.__halt = true; if (calm) BF.mobs.spawning = false; return window.__hover(); }, calm);
  log('home village', JSON.stringify(home));
  const res = { mode: 'sim', version, root, seed: SEED, calm, when: new Date().toISOString(), home, runs: [] };
  for (const n of list) {
    const plan = await pg.evaluate(n => window.__plan(n).map(v => ({ key: window.__vKey(v), d: Math.round(BF.planet.distance(window.__home, v)) })), n);
    const keys = await pg.evaluate(n => window.__force(window.__plan(n)), n);
    // load: stream until every forced village is simulated and its chunks are in, ticking now and then so villagers come out
    const t0 = Date.now();
    let c;
    for (let round = 0; round < 400; round++) {
      c = await pg.evaluate(keys => {
        const h = window.__home;
        for (let i = 0; i < 60; i++) { BF.world.update(h.x, h.z, 60); if (i % 4 === 0) window.__step(0.05); }
        return window.__census(keys);
      }, keys);
      const missing = keys.filter(k => !c.per[k]).length;
      if (c.active === keys.length && c.queue === 0 && !missing) break;
      if (round % 10 === 9) log(`  loading n=${n}: ${c.active}/${keys.length} simulated, ${missing} without villagers, queue ${c.queue}, ${c.chunks} chunks`);
      if (Date.now() - t0 > 20 * 60000) { log('  load timed out'); break; }
    }
    // warm up, then measure
    await pg.evaluate(({ W, h }) => { for (let i = 0; i < W; i++) { if (i % 20 === 0) BF.world.update(h.x, h.z, 3); window.__step(0.05); } }, { W: WARM, h: home });
    const m = await pg.evaluate(({ S, h }) => {
      const ms = [];
      let stream = 0;
      for (let i = 0; i < S; i++) {
        if (i % 20 === 0) { const s = performance.now(); BF.world.update(h.x, h.z, 3); stream += performance.now() - s; }
        const s = performance.now(); window.__step(0.05); ms.push(performance.now() - s);
      }
      const tot = ms.reduce((a, b) => a + b, 0);
      ms.sort((a, b) => a - b);
      return { msPerTick: tot / S, p50: ms[Math.floor(S * 0.5)], p95: ms[Math.floor(S * 0.95)], max: ms[S - 1], streamMsPerTick: stream / S, day: BF.sky.day + BF.sky.time };
    }, { S: STEPS, h: home });
    c = await pg.evaluate(keys => window.__census(keys), keys);
    const ms = m.msPerTick + m.streamMsPerTick;
    const run = {
      n, villagesSimulated: c.simulated, forcedActive: c.active, villagers: c.kinds.villager, mobs: c.kinds.total, hostile: c.kinds.hostile, otherMobs: c.kinds.other,
      chunks: c.chunks, keptChunks: c.kept, msPerTick: r2(m.msPerTick), p50: r2(m.p50), p95: r2(m.p95), max: r2(m.max), streamMsPerTick: r2(m.streamMsPerTick),
      topSpeed: r2(50 / ms),                                  // game s per real s with the whole core on the sim (0.05 game s a tick)
      speedAt40pct: r2(0.4 * 50 / ms),                        // ...with the 40% budget share
      perVillagerUs: r2(m.msPerTick * 1000 / Math.max(1, c.kinds.villager)),
      status: c.status, villages: plan.map(p => ({ ...p, villagers: c.per[p.key] })), day: r2(m.day),
    };
    res.runs.push(run);
    log(`n=${n}: ${c.active}/${keys.length} forced active (${c.status}); ${run.villagers} villagers, ${run.mobs} mobs, ${run.chunks} chunks; ` +
      `${run.msPerTick} ms/tick (p95 ${run.p95}) + ${run.streamMsPerTick} streaming; top ${run.topSpeed}x, at 40% ${run.speedAt40pct}x`);
  }
  await b.close();
  return res;
}

async function framesMode() {
  const speeds = String(opt('speeds', '0,4,5')).split(',').map(Number), SECS = +opt('secs', 30), nv = +opt('villages', 0);
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/index.html?debugfeed=off#seed${SEED}`;
  const { b, pg, version } = await boot({ url, size: [640, 360] });
  await pg.evaluate(PAGE_HELPERS);
  const home = await pg.evaluate(() => window.__hover());
  const host = await pg.evaluate(() => (BF.simHost ? (BF.simHost.label ? BF.simHost.label() : BF.simHost.mode) : 'page (1.4)'));
  log('home', JSON.stringify(home), 'host', host);
  if (nv) log('  (--villages only applies to an in-page sim; the worker keeps its own villageSim)');
  if (nv && !(await pg.evaluate(() => BF.simHost && BF.simHost.worker))) await pg.evaluate(n => window.__force(window.__plan(n)), nv);
  await pg.waitForTimeout(20000);   // the village loads and its villagers come out
  const res = { mode: 'frames', version, root, seed: SEED, host, home, when: new Date().toISOString(), runs: [] };
  for (const si of speeds) {
    await pg.evaluate(i => BF.warp.set(i), si);
    await pg.waitForTimeout(5000);
    const r = await pg.evaluate(async S => {
      const g = () => (BF.sky.day || 0) * 1200 + (BF.sky.time || 0) * 1200;
      window.__ft = []; window.__ftOn = true;
      const g0 = g(), t0 = performance.now();
      await new Promise(r => setTimeout(r, S * 1000));
      window.__ftOn = false;
      const wall = (performance.now() - t0) / 1000, f = window.__ft.slice();
      const d = f.map(x => x[1]).sort((a, b) => a - b), gaps = [];
      for (let i = 1; i < f.length; i++) gaps.push(f[i][0] - f[i - 1][0]);
      gaps.sort((a, b) => a - b);
      const q = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
      return { achieved: (g() - g0) / wall, fps: f.length / wall,
        frameMs: { mean: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length), p50: q(d, 0.5), p95: q(d, 0.95), p99: q(d, 0.99), max: d[d.length - 1] },
        gapMs: { p50: q(gaps, 0.5), p95: q(gaps, 0.95), p99: q(gaps, 0.99), max: gaps[gaps.length - 1] },
        mobs: BF.mobs.list.length, status: BF.villageSim && BF.villageSim.status ? BF.villageSim.status() : '' };
    }, SECS);
    const run = { speedIndex: si, speed: [1, 3, 5, 10, 100, 1000][si], achieved: r2(r.achieved), fps: r2(r.fps),
      frameMs: Object.fromEntries(Object.entries(r.frameMs).map(([k, v]) => [k, r2(v)])), gapMs: Object.fromEntries(Object.entries(r.gapMs).map(([k, v]) => [k, r2(v)])), mobs: r.mobs, status: r.status };
    res.runs.push(run);
    log(`${run.speed}x: achieved ${run.achieved} game s/s, ${run.fps} fps; frame ms mean ${run.frameMs.mean} p95 ${run.frameMs.p95} p99 ${run.frameMs.p99} max ${run.frameMs.max}; gap p99 ${run.gapMs.p99}; ${run.status}`);
  }
  await b.close(); srv.close();
  return res;
}

async function budgetMode() {
  const MINS = +opt('mins', 5), BUD = +opt('budget', 40);
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/index.html?debugfeed=off&budget=${BUD}#seed${SEED}`;
  const { b, pg, version } = await boot({ url, size: [640, 360] });
  await pg.evaluate(PAGE_HELPERS);
  const home = await pg.evaluate(() => window.__hover());
  const host = await pg.evaluate(() => (BF.simHost ? (BF.simHost.label ? BF.simHost.label() : BF.simHost.mode) : 'page (1.4)'));
  log('home', JSON.stringify(home), 'host', host);
  const res = { mode: 'budget', version, root, seed: SEED, budget: BUD, host, home, when: new Date().toISOString(), samples: [] };
  const t0 = Date.now();
  while (Date.now() - t0 < MINS * 60000) {
    await pg.waitForTimeout(30000);
    const s = await pg.evaluate(() => {
      let villagers = 0; for (const m of BF.mobs.list) if (m.type === 'villager' && !m.dead && !m.removed) villagers++;
      const A = BF.active;
      return { status: BF.villageSim.status(), villagers, mobs: BF.mobs.list.length, text: A && A.text ? A.text() : null };
    });
    s.min = r2((Date.now() - t0) / 60000);
    res.samples.push(s);
    log(`${s.min} min: ${s.status}; ${s.villagers} villagers seen by the page; ${s.text || ''}`);
  }
  await b.close(); srv.close();
  return res;
}

(async () => {
  const fn = { sim: simMode, frames: framesMode, budget: budgetMode }[mode];
  if (!fn) { console.log('usage: node bench.js sim|frames|budget <root> [--seed 3] [--out f.json] ...'); process.exit(2); }
  const res = await fn();
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
