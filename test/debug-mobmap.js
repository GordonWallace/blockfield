// @ci integration suite=ui timeout=400 args={out}
// The debug screen's Mobs map (js/debugfeed.js mobMap, debug/index.html; idea-037): every loaded mob drawn once, legend entries hide and bring
// back a type (remembered after a reload), zoom both ways, and loaded and unloaded land drawn differently.
// Usage: NODE_PATH=$(npm root -g) node test/debug-mobmap.js [outPrefix]
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-mobmap';
const GAME = 8720, DBG = 8721;
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-debug-mobmap-alerts.json')]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
(async () => {
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails.push(n); };
  const srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('PAGEERROR game', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/?nolod&${require('./lib').q()}#seed123`);   // no distant terrain: under swiftshader its rings drop the planet to about 1 fps
  await game.waitForTimeout(5000);
  await require('./lib').toVillage(game);
  // hold the mobs still so the game and the screen can be compared
  await game.evaluate(() => { BF.mobs.spawning = false; window.__upd = BF.mobs.update; BF.mobs.update = () => {}; });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1400 } });
  dbg.on('pageerror', e => console.log('PAGEERROR debug', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.evaluate(() => localStorage.removeItem('bf-debug-mobmap-hidden'));
  await dbg.reload();
  await dbg.waitForFunction(() => window.BFMobMap && BFMobMap.data(), null, { timeout: 20000 });
  await dbg.waitForTimeout(1500);
  await dbg.locator('#mpanel').scrollIntoViewIfNeeded();
  const want = await game.evaluate(() => { const c = {}; let n = 0; for (const m of BF.mobs.list) if (!m.dead && !m.removed) { n++; const k = m.type === 'villager' ? (m.profession === 'merchant' ? 'merchant' : 'villager') : m.type; c[k] = (c[k] || 0) + 1; } return { n, c, chunks: BF.world.chunks.size }; });
  const got = await dbg.evaluate(() => { const d = BFMobMap.data(), c = {}; for (const m of d.mobs) { const k = d.kinds[m[0]]; c[k] = (c[k] || 0) + 1; } return { n: d.mobs.length, c, chunks: d.chunks.length / 2, legend: [...document.querySelectorAll('#m-legend .item')].map(e => e.textContent) }; });
  ok('every loaded mob is on the map once', got.n === want.n && JSON.stringify(Object.entries(got.c).sort()) === JSON.stringify(Object.entries(want.c).sort()), { want, got });
  ok('the legend lists each type with its count', Object.entries(want.c).every(([k, n]) => got.legend.some(t => t.toLowerCase().replace(/_/g, ' ').startsWith(k.replace(/_/g, ' ')) && t.endsWith(' ' + n))), got.legend);
  // zoom out to the whole loaded area: the centre (around the player) is loaded land, a corner isn't
  for (let i = 0; i < 12; i++) await dbg.click('#m-zout');
  const px = await dbg.evaluate(() => {
    const cv = document.getElementById('mmap'), g = cv.getContext('2d'), r = devicePixelRatio || 1, w = cv.width, h = cv.height;
    const at = (x, y) => [...g.getImageData(Math.floor(x * r), Math.floor(y * r), 1, 1).data].slice(0, 3);
    // the loaded-land tone: a pixel of the first loaded chunk with no mob dot over it
    const d = BFMobMap.data(), cs = d.cs;
    return { corner: at(2, 2), corner2: at(cv.clientWidth - 3, cv.clientHeight - 3), mid: at(cv.clientWidth / 2 + 30, cv.clientHeight / 2 + 30), w, h };
  });
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  ok('loaded and unloaded land are drawn differently', dist(px.corner, px.mid) > 12 || dist(px.corner2, px.mid) > 12, px);
  const s0 = await dbg.evaluate(() => BFMobMap.scale());
  await dbg.click('#m-zin'); await dbg.click('#m-zin');
  const s1 = await dbg.evaluate(() => BFMobMap.scale());
  await dbg.mouse.move(800, 300);
  await dbg.locator('#mmap').scrollIntoViewIfNeeded();   // (the panels above it grow as the feed fills them: keep the wheel on the map)
  const box = await dbg.locator('#mmap').boundingBox();
  await dbg.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await dbg.mouse.wheel(0, 300);
  await dbg.waitForFunction(s => BFMobMap.scale() !== s, s1, { timeout: 3000 }).catch(() => {});   // (a busy runner can take longer than a frame)
  const s2 = await dbg.evaluate(() => BFMobMap.scale());
  ok('zooms in and out (buttons and wheel)', s1 > s0 && s2 < s1, [s0, s1, s2, box && Math.round(box.y + box.height / 2), dbg.viewportSize()]);
  // hide villagers from the legend, then bring them back; the choice survives a reload
  await dbg.click('#m-zout'); await dbg.click('#m-zout'); await dbg.click('#m-zout');
  const before = await dbg.evaluate(() => BFMobMap.dots());
  await dbg.click('#m-legend .item[data-k="villager"]');
  const hidden = await dbg.evaluate(() => ({ dots: BFMobMap.dots(), off: document.querySelector('#m-legend .item[data-k="villager"]').classList.contains('off') }));
  ok('clicking a type hides its dots and greys its entry', hidden.dots === before - (want.c.villager || 0) && hidden.off, { before, hidden, villagers: want.c.villager });
  await dbg.reload();
  await dbg.waitForFunction(() => window.BFMobMap && BFMobMap.data(), null, { timeout: 20000 });
  ok('what is hidden is remembered between visits', (await dbg.evaluate(() => BFMobMap.hidden())).includes('villager'));
  await dbg.locator('#mpanel').scrollIntoViewIfNeeded();
  await dbg.click('#m-all');
  const shown = await dbg.evaluate(() => ({ dots: BFMobMap.dots(), hidden: BFMobMap.hidden() }));
  await dbg.click('#m-none');
  const none = await dbg.evaluate(() => BFMobMap.dots());
  await dbg.click('#m-all');
  ok('All brings every type back, None hides them all', shown.hidden.length === 0 && none === 0, { shown, none });
  // hovering a dot names it, with its position and what it is doing
  const xy = await dbg.evaluate(() => BFMobMap.dotXY(0));
  const box2 = await dbg.locator('#mmap').boundingBox();
  if (xy) await dbg.mouse.move(box2.x + xy[0], box2.y + xy[1]);
  await dbg.waitForTimeout(200);
  const tip = await dbg.evaluate(() => { const t = document.getElementById('mtip'); return { shown: t.style.display === 'block', text: t.textContent }; });
  ok('hovering a dot shows its type, position and what it is doing', !!xy && tip.shown && /\d+, \d+, -?\d+|-?\d+, -?\d+, -?\d+|\d+ blocks? [NSEW]{1,2}, y -?\d+/.test(tip.text), tip);   // on the planet the position reads as distance and direction from the player, and y (r14-21)
  await dbg.locator('#mpanel').screenshot({ path: out + '.png' });
  // the Regions overlay (js/regions.js, spec r15-30): regions holding mobs come with the map, their counts add up to every indexed mob,
  // and the button shades them (remembered like the hidden types)
  await dbg.click('#m-regions');
  await dbg.waitForTimeout(1500);
  const rg = await dbg.evaluate(() => { const d = BFMobMap.data(); return { on: document.getElementById('m-regions').classList.contains('on'), n: (d.regions || []).length, sum: (d.regions || []).reduce((a, r) => a + r[4], 0), w: d.regions && d.regions[0] && d.regions[0][2] - d.regions[0][0], size: d.region }; });
  const idx = await game.evaluate(() => BF.regions.counts().mobs);
  ok('the Regions button shades regions by mob count, and their counts add up to the indexed mobs', rg.on && rg.n > 0 && rg.sum === idx && rg.w === rg.size, { rg, idx });
  await dbg.locator('#mpanel').screenshot({ path: out + '-regions.png' });
  await dbg.click('#m-regions');
  await game.evaluate(() => { BF.mobs.update = window.__upd; });
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
