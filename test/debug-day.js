// Debug screen: a picked villager's day (js/daytimeline.js, the Day section under its inventory). NODE_PATH=$(npm root -g) node test/debug-day.js [outPrefix]
// Starts debug/server.js on spare ports, opens the game and the debug screen, gives one villager a known day, then checks: nothing extra in
// the feed before a pick; picking it sends its key to the game and its timeline comes back; the strip (stretches, the wait in red, event
// ticks, hour marks), the summary of waits, the list, clicking a list row marks the spot on the map, Yesterday, the timeline isn't re-sent
// with every snapshot, and unpicking stops it. Screenshots it.
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-day';
const GAME = 8740, DBG = 8741;
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-debug-day-alerts.json')]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
const state = async () => (await (await fetch(`http://localhost:${DBG}/state`)).json()).latest || {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const fails = [], ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 300) : '')); if (!c) fails.push(n); };
  const srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('PAGEERROR game', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/`);
  await game.waitForTimeout(5000);
  await require('./lib').toVillage(game);
  // a known day for one villager: quarrying, then 2h 24m waiting for gold, then sleeping, a trade and a meal; the game keeps sampling it after
  const v = await game.evaluate(() => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), D = BF.dayTimeline;
    const m = rec.members.find(x => x.type === 'villager' && !x.dead && !x.child && x.slot);
    const key = D.keyOf(m), now = BF.sky.day + BF.sky.time, x = Math.round(m.position.x), z = Math.round(m.position.z), r5 = t => Math.round(t * 1e5) / 1e5;
    const o = {}; o[key] = { n: BF.vlog.nameOf(m), x: ['Quarrying stone', 'Waiting for gold', 'Sleeping'],
      s: [[r5(now - 0.9), 40000, 0, x + 3, z], [r5(now - 0.5), 10000, 1, x - 5, z + 4], [r5(now - 0.4), 20000, 2, x, z]],
      e: [[r5(now - 0.45), 'trade', 'Someone traded with ' + BF.vlog.nameOf(m) + ': gave 1 Emerald, got 3 Bread', x + 1, z + 1], [r5(now - 0.3), 'meal', 'Ate Bread', x, z]] };
    D.deserialize(o);
    return { key, name: BF.vlog.nameOf(m), now };
  });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1300 } });
  dbg.on('pageerror', e => console.log('PAGEERROR debug', e.message));
  dbg.on('request', q => { if (/\/pick$/.test(q.url())) console.log('DBG pick', q.postData()); });
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForFunction(n => [...document.querySelectorAll('#r-body tr')].some(t => t.dataset.n === n), v.name, { timeout: 30000 }).catch(() => {});
  let L = await state();
  ok('before a pick: no timeline in the feed', L.pick && L.pick.key === null && !('day' in L), { pick: L.pick, day: 'day' in L });
  ok('no Day section before a pick', await dbg.evaluate(() => document.getElementById('r-day').hidden));
  await dbg.evaluate(n => [...document.querySelectorAll('#r-body tr')].find(t => t.dataset.n === n).click(), v.name);
  await dbg.waitForFunction(() => document.querySelectorAll('#r-day .dstrip .b').length >= 3, null, { timeout: 30000 }).catch(() => {});
  L = await state();
  ok('the pick reached the game', L.pick && L.pick.key === v.key, L.pick);
  const read = () => dbg.evaluate(() => {
    const el = document.getElementById('r-day');
    return { hidden: el.hidden, title: (el.querySelector('h4') || {}).textContent || '',
      blocks: [...el.querySelectorAll('.dstrip .b')].map(x => ({ tip: x.title, bg: x.style.background, w: parseFloat(x.getBoundingClientRect().width) })),
      ticks: [...el.querySelectorAll('.dticks i')].map(x => x.title), hours: [...el.querySelectorAll('.dhours span')].map(x => x.textContent),
      key: (el.querySelector('.dkey') || {}).textContent || '', sum: (el.querySelector('.dsum') || {}).textContent || '',
      rows: [...el.querySelectorAll('.dlist > div')].map(x => x.textContent), now: !!el.querySelector('.dstrip .now') };
  });
  let r = await read();
  ok('Day section shows for ' + v.name, !r.hidden && r.title.startsWith(v.name + "'s Day"), r.title);
  ok('stretches on the strip: quarrying, waiting, sleeping and the live one', r.blocks.length >= 4 && r.blocks.some(x => /^Quarrying stone \(Work\)/.test(x.tip)) && r.blocks.some(x => /^Sleeping \(Sleep\)/.test(x.tip)), r.blocks.map(x => x.tip.split('\n')[0]));
  const w = r.blocks.find(x => /^Waiting for gold/.test(x.tip));
  ok('the wait is red, with its times and length', w && /danger/.test(w.bg) && /2h 24m$/.test(w.tip), w);
  ok('event ticks: a trade and a meal', r.ticks.length >= 2 && r.ticks.some(t => /^Trade, Day/.test(t)) && r.ticks.some(t => /^Meal, Day .*\nAte Bread/.test(t)), r.ticks);
  ok('hour marks every 3 hours', r.hours.length >= 7 && r.hours.every(h => /^\d\d:00$/.test(h)), r.hours);
  ok('a "now" edge', r.now);
  ok('summary of waits', /Waited 2h 24m: Waiting for gold \(2h 24m\)/.test(r.sum), r.sum);
  ok('key with hours per category', /Work (9h 36m|\d+h)/.test(r.key) && /Sleep 4h 48m/.test(r.key) && /Not loaded/.test(r.key), r.key);
  ok('list, newest first, with clock times', r.rows.length >= 6 && /^Day \d+ \d\d:\d\d/.test(r.rows[0]) && r.rows.findIndex(x => /Quarrying/.test(x)) > r.rows.findIndex(x => /Sleeping/.test(x)), r.rows.slice(0, 7));
  await dbg.evaluate(() => document.getElementById('r-day').scrollIntoView());
  await dbg.screenshot({ path: out + '.png', fullPage: true });
  // clicking a row with a place marks it on the map
  const map0 = await dbg.evaluate(() => document.getElementById('map').toDataURL());
  await dbg.evaluate(() => [...document.querySelectorAll('#r-day .dlist > div.at')].find(x => /Waiting for gold/.test(x.textContent)).click());
  const at = await dbg.evaluate(m0 => ({ sel: (document.querySelector('#r-day .dlist > div.sel') || {}).textContent || '', drawn: document.getElementById('map').toDataURL() !== m0 }), map0);
  ok('clicking the wait marks where it was on the map', /Waiting for gold/.test(at.sel) && at.drawn, at);
  await dbg.screenshot({ path: out + '-map.png' });
  // Yesterday: the whole previous game day
  await dbg.click('#r-day button[data-dv="yesterday"]'); await dbg.waitForTimeout(300);
  const y = await read();
  const yOn = await dbg.evaluate(() => document.querySelector('#r-day button[data-dv="yesterday"]').classList.contains('on'));
  ok('Yesterday shows the previous full day (no now edge)', yOn && !y.now && y.hours[0] === '06:00' || yOn && !y.now && y.hours[0] === '09:00', { hours: y.hours, rows: y.rows.length });
  await dbg.click('#r-day button[data-dv="today"]');
  // the timeline isn't re-sent with every snapshot
  let withDay = 0;
  for (let i = 0; i < 12; i++) { if ('day' in await state()) withDay++; await sleep(260); }
  ok(`the timeline is only re-sent when it changes (${withDay} of 12 snapshots)`, withDay < 12);
  // the live villager keeps adding to it
  await game.evaluate(k => { const D = BF.dayTimeline; D.event(BF.mobs.list.find(x => D.keyOf(x) === k), 'meal', 'Ate Carrot'); }, v.key);
  await dbg.waitForFunction(() => [...document.querySelectorAll('#r-day .dticks i')].some(t => /Ate Carrot/.test(t.title)), null, { timeout: 20000 }).catch(() => {});
  ok('a new event shows up', await dbg.evaluate(() => [...document.querySelectorAll('#r-day .dticks i')].some(t => /Ate Carrot/.test(t.title))));
  // unpick: nothing extra in the feed again
  await dbg.evaluate(n => [...document.querySelectorAll('#r-body tr')].find(t => t.dataset.n === n).click(), v.name);
  await sleep(2000);
  ok('unpicked: Day section hidden', await dbg.evaluate(() => document.getElementById('r-day').hidden));
  for (let i = 0; i < 80 && ((await state()).pick || {}).key; i++) await sleep(250);   // the game hears of it with its next snapshot (a few fps in CI)
  await sleep(600);
  let extra = 0;
  for (let i = 0; i < 8; i++) { const s = await state(); if (s.day || (s.pick && s.pick.key)) extra++; /* one snapshot says day: null (cleared), then nothing */ await sleep(260); }
  const s9 = await state(); ok('unpicked: no timeline in the feed', extra === 0, { extra, pick: s9.pick, day: s9.day === undefined ? 'absent' : s9.day && s9.day.key });
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
