// Second-screen debug test: NODE_PATH=$(npm root -g) node test/debug-screen.js [outPrefix]
// Starts debug/server.js on spare ports, opens the game and the debug screen, checks the screen matches the game,
// restarts the server mid-village (the game must resend the layout and log), and screenshots the screen.
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-screen';
const GAME = 8710, DBG = 8711;
// the server prints its banner before its ports are open: wait until the debug port answers
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
(async () => {
  const fails = [], ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails.push(n); };
  let srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  game.on('pageerror', e => console.log('GAME PAGEERROR', e.message));
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/`);
  await game.waitForTimeout(5000);
  ok('feed is on when served by the debug server', await game.evaluate(() => !!BF.debugFeed));
  await require('./lib').toVillage(game);
  await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); BF.vlog.log(rec, 'birth', 'Test baby was born'); });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForTimeout(2000);
  const want = await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), d = BF.vlog.panelData(rec);
    return { name: d.name, villagers: d.villagers, seed: BF.state.seed, log: BF.vlog.entries(rec.key).length, loaded: d.loaded }; });
  const got = () => dbg.evaluate(() => ({ conn: document.getElementById('conn').textContent, name: document.getElementById('v-name').textContent,
    villagers: +document.getElementById('v-villagers').textContent, seed: +document.getElementById('h-seed').textContent,
    rows: document.getElementById('r-body').children.length, log: document.querySelectorAll('#log .ent').length, f3: document.getElementById('f3').textContent }));
  let g = await got();
  ok('live', g.conn === 'Live');
  ok('village name ' + g.name, g.name === want.name);
  ok('villager count', g.villagers === want.villagers);
  ok('seed', g.seed === want.seed);
  ok('roster rows = loaded villagers', g.rows === want.loaded);
  // emeralds and food (inventory plus owned chests) and starving, per villager
  const gv = await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const m = rec.members.find(x => x.type === 'villager' && !x.dead && !x.child && BF.trades.inv.count(x.inv, BF.I.emerald) > 0) || rec.members.find(x => x.type === 'villager' && !x.dead);
    const k = BF.storage.keyOf(m), cs = [...BF.inventory.chests.values()].filter(c => c.owner === k);
    const em = BF.trades.inv.count(m.inv, BF.I.emerald) + cs.reduce((n, c) => n + c.slots.reduce((a, st) => a + (st && st.id === BF.I.emerald ? st.count : 0), 0), 0);
    return { name: BF.vlog.nameOf(m), em, starving: !!m.starving }; });
  await dbg.waitForTimeout(600);
  const rr = await dbg.evaluate(n => { const tr = [...document.querySelectorAll('#r-body tr')].find(t => t.dataset.n === n); return tr && [...tr.children].map(td => td.textContent); }, gv.name);
  ok('roster shows emeralds, food and starving ' + JSON.stringify(rr), rr && rr.length === 10 && /^[\d.,]+ days?$/.test(rr[8]) && parseInt(rr[5].replace(/,/g, '')) === gv.em && !isNaN(parseFloat(rr[6])) && (rr[7] === 'starving') === gv.starving);
  ok('log entries ' + g.log + '/' + want.log, g.log === want.log && want.log > 0);
  await dbg.click('#raw summary'); await dbg.waitForTimeout(400);
  ok('F3 text matches the overlay format', /^Blockfield {2}\d+ fps\nXYZ /.test((await got()).f3));
  await dbg.screenshot({ path: out + '.png', fullPage: true });
  // server restart: a fresh server has no layout/log; the game must resend both
  srv.kill(); await new Promise(r => srv.once('exit', r));
  srv = await start();
  await game.evaluate(() => { const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); BF.vlog.log(rec, 'job', 'Someone became a Tester'); });
  await dbg.waitForTimeout(7000);
  g = await got();
  ok('after restart: live again', g.conn === 'Live');
  const now = await game.evaluate(() => BF.vlog.entries(BF.vlog.villageAt(BF.player.position.x, BF.player.position.z).key));
  await dbg.waitForTimeout(1500); g = await got();   // villagers may log more meanwhile: the screen must hold at least what the game had
  ok('after restart: log resent ' + g.log + '/' + now.length, g.log >= now.length && now.some(e => /Tester/.test(e[2])));
  const st = await (await fetch(`http://localhost:${DBG}/state`)).json();
  ok('after restart: layout resent', Object.values(st.layouts || {}).some(l => l.buildings.length));
  // log filters: a dropdown per villager type, checkboxes per action, remembered across reloads
  const tr = await game.evaluate(() => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const vs = rec.members.filter(m => m.type === 'villager' && !m.child && m.trades && m.trades.length && m.profession !== 'nitwit');
    const s = vs[0], b2 = vs.find(m => m.profession !== s.profession);
    BF.vlog.trade(b2, s, 'gave 1 Emerald, got 1 Test');
    BF.emit('villagerTrade', s, s.trades[0]);
    return { seller: BF.vlog.pretty(s.profession), buyer: BF.vlog.pretty(b2.profession) };
  });
  // on a slow machine the trades can take a few seconds to reach the screen
  await dbg.waitForFunction(() => { const t = [...document.querySelectorAll('#log .ent .tx')].map(e => e.textContent); return t.some(x => /got 1 Test/.test(x)) && t.some(x => /^Player traded/.test(x)); }, null, { timeout: 20000 }).catch(() => {});
  await dbg.waitForTimeout(500);
  const count = () => dbg.evaluate(() => document.querySelectorAll('#log .ent').length);
  const all = await count();
  // one dropdown, a row per villager type (every type, logged here or not), Select all / none at the top
  const row = t => `#l-types .frow[data-t="${t}"]`;
  await dbg.click('#l-types summary');
  ok('one dropdown lists every type', await dbg.evaluate(() => { const r = [...document.querySelectorAll('#l-types .frow')].map(e => e.dataset.t); return r.length >= 22 && r.includes('Miner') && r.includes('Child') && r.includes('Player'); }));
  ok('single column', await dbg.evaluate(() => new Set([...document.querySelectorAll('#l-types .frow')].map(e => Math.round(e.getBoundingClientRect().left))).size === 1));
  const texts = () => dbg.evaluate(() => [...document.querySelectorAll('#log .ent .tx')].map(e => e.textContent));
  await dbg.click(`${row(tr.seller)} .fx`);
  await dbg.uncheck(`#l-types .facts[data-t="${tr.seller}"] input[data-a="sell"]`);
  await dbg.waitForTimeout(200);
  let vis = await texts();
  // an entry shows while any villager in it is selected: the buyer (a villager, or the player) still is
  ok('a trade still shows while its buyer is selected', vis.some(t => /got 1 Test/.test(t)) && vis.some(t => /^Player traded/.test(t)));
  ok('menu stays open after a change', await dbg.evaluate(() => document.getElementById('l-types').open && !!document.querySelector('#l-types .facts')));
  ok('partly on: type checkbox shows mixed', await dbg.evaluate(s => document.querySelector(s + ' input.tcb').indeterminate, row(tr.seller)));
  await dbg.click(`${row('Player')} input.tcb`);
  await dbg.waitForFunction(() => ![...document.querySelectorAll('#log .ent .tx')].some(e => /^Player traded/.test(e.textContent)), null, { timeout: 3000 }).catch(() => {});
  vis = await texts();
  ok('player checkbox hides the player trade', !vis.some(t => /^Player traded/.test(t)) && vis.length < all);
  await dbg.screenshot({ path: out + '-filters.png', fullPage: true });
  await dbg.click('#l-count'); await dbg.waitForTimeout(100);
  ok('a click elsewhere closes the menu', !(await dbg.evaluate(() => document.getElementById('l-types').open)));
  await dbg.reload(); await dbg.waitForTimeout(1500);
  ok('choice remembered after reload', !(await texts()).some(t => /^Player traded/.test(t)) && await dbg.evaluate(s => !document.querySelector(s + ' input.tcb').checked, row('Player')));
  // Select none, then one type: only entries involving that type (whoever the other party is)
  await dbg.click('#l-types summary'); await dbg.click('#l-types [data-all="0"]'); await dbg.waitForTimeout(200);
  const none = await dbg.evaluate(() => [...document.querySelectorAll('#log .ent')].filter(e => /trade|bed|job|birth|death/.test(e.className)).length);
  ok('select none hides villager entries', none === 0);
  await dbg.check(`${row(tr.buyer)} input.tcb`); await dbg.waitForTimeout(200);
  vis = await texts();
  ok('one type selected shows its trades with unselected types', vis.some(t => /got 1 Test/.test(t)) && !vis.some(t => /^Player traded/.test(t)));
  ok('and nothing without it', vis.every(t => !/traded with/.test(t) || t.includes('(' + tr.buyer + ')')));
  await dbg.click('#l-types [data-all="1"]'); await dbg.waitForTimeout(200);
  ok('select all restores', (await texts()).some(t => /^Player traded/.test(t)) && (await count()) >= all);   // villagers may have logged more meanwhile
  await dbg.click('#l-count');
  // event types: a second dropdown that combines with the villager types ("Show <Cleric> <Trades>")
  await dbg.click('#l-kinds summary');
  ok('event dropdown lists births, deaths and trades', await dbg.evaluate(() => ['birth', 'death', 'trade'].every(k => document.querySelector(`#l-kinds .frow[data-k="${k}"]`))));
  await dbg.click('#l-kinds [data-all="0"]'); await dbg.click('#l-kinds .frow[data-k="birth"] input.kcb'); await dbg.waitForTimeout(200);
  vis = await dbg.evaluate(() => [...document.querySelectorAll('#log .ent')].map(e => e.className.split(' ')[1]));
  ok('births only', vis.length > 0 && vis.every(k => k === 'birth'));
  await dbg.click('#l-kinds [data-all="1"]'); await dbg.click('#l-kinds [data-all="0"]'); await dbg.click('#l-kinds .frow[data-k="trade"] input.kcb');
  await dbg.click('#l-count'); await dbg.click('#l-types summary'); await dbg.click('#l-types [data-all="0"]'); await dbg.check(`${row(tr.seller)} input.tcb`); await dbg.waitForTimeout(200);
  vis = await texts();
  ok('one type and one event type combine', vis.length > 0 && vis.every(t => / traded with /.test(t) && t.includes('(' + tr.seller + ')')));
  ok('summaries name the single choices', await dbg.evaluate(s => document.querySelector('#l-types summary').textContent === s && document.querySelector('#l-kinds summary').textContent === 'Trades', tr.seller));
  await dbg.click('#l-kinds summary'); await dbg.waitForTimeout(100);
  await dbg.screenshot({ path: out + '-events.png', fullPage: true });
  await dbg.click('#l-clear'); await dbg.waitForTimeout(200);
  ok('clear filters shows everything', (await count()) >= all && !(await dbg.$('#l-clear')));
  // a second village: the view follows the nearest loaded one, the list shows both with distances, and the first can be picked
  const first = want.name;
  const second = await game.evaluate(() => {
    const p = BF.player.position, here = BF.vlog.villageAt(p.x, p.z);
    const vs = BF.worldgen.villagesNear(p.x, p.z, 1500).filter(v => Math.round(v.x) + "," + Math.round(v.z) !== here.key)
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const v = vs[0];
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    return BF.signs.villageName(Math.round(v.x) + "," + Math.round(v.z));
  });
  await game.waitForTimeout(12000);
  const list = () => dbg.evaluate(() => [...document.querySelectorAll('#vlist .vrow')].map(r => ({ name: r.querySelector('.vn').firstChild.textContent, on: r.classList.contains('on'), sel: r.classList.contains('sel'), dist: +r.querySelector('.vd b').textContent.replace(/,/g, '') })));
  let L = await list();
  console.log('villages:', JSON.stringify(L));
  ok('list has both villages', L.some(v => v.name === first) && L.some(v => v.name === second));
  ok('nearest loaded village first and shown by default', L[0].name === second && L[0].on && L[0].sel && (await got()).name === second);
  ok('every village shows a distance', L.every(v => v.dist >= 0 && !isNaN(v.dist)));
  const onIdx = L.map(v => v.on), firstOff = onIdx.indexOf(false);
  ok('unloaded below loaded', firstOff < 0 || onIdx.slice(firstOff).every(x => !x));
  await dbg.click(`#vlist .vrow:has(.vn:text-is("${first}"))`).catch(async () => dbg.evaluate(n => [...document.querySelectorAll('#vlist .vrow')].find(r => r.querySelector('.vn').firstChild.textContent === n).click(), first));
  await dbg.waitForTimeout(600);
  g = await got();
  const firstRow = (await list()).find(v => v.name === first);
  ok('picked village is shown', g.name === first && firstRow.sel);
  ok('unloaded village is greyed with its last numbers', firstRow.on || await dbg.evaluate(() => document.getElementById('vpanel').classList.contains('stale') && /Not loaded/.test(document.getElementById('v-sub').textContent) && +document.getElementById('v-villagers').textContent > 0));
  ok('its full log is still there', g.log > 0);
  await dbg.screenshot({ path: out + '-picked.png' });
  await dbg.click('#vl-auto'); await dbg.waitForTimeout(600);
  ok('follow nearest goes back', (await got()).name === second);
  // ages: game days loaded and active, for villagers and villages; a villager that wasn't ticking (unloaded) doesn't age through a gap
  const shownKey = await dbg.evaluate(() => document.querySelector('.vrow.sel').dataset.k);   // the village on the screen (another may be known but unloaded)
  const ages = await game.evaluate(async key => {
    const vs = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && m.life && m.village && m.village.key === key);
    const a = vs[0], b = vs[1], la = a.life.lived, lb = b.life.lived;
    b._agePass = -99;                                            // as if b had just come back from being unloaded
    BF.sky.day += 3;                                             // three days pass
    for (let p0 = a._agePass, i = 0; a._agePass < p0 + 2 && i < 100; i++) await new Promise(r => setTimeout(r, 100));   // two village ticks (slow frames stretch them)
    BF.sky.day -= 3;
    return { a: a.life.lived - la, b: b.life.lived - lb, village: BF.villageLife.villageAge(a.village.key) };
  }, shownKey);
  ok('loaded villager ages through a skip, a returning one does not ' + JSON.stringify(ages), ages.a >= 2.9 && ages.b < 0.5 && ages.village >= 3);
  await dbg.screenshot({ path: out + '-ages.png', fullPage: true });
  ok('village age shown', /age [\d.,]+ days?/.test(await dbg.evaluate(() => document.getElementById('v-sub').textContent + document.getElementById('vlist').textContent)));
  const rowH = await dbg.evaluate(() => [...document.querySelectorAll('#r-body tr')].map(r => Math.round(r.getBoundingClientRect().height)));
  ok('villager rows all the same height ' + JSON.stringify([...new Set(rowH)]), rowH.length > 3 && new Set(rowH).size === 1);
  // map legend: structure kinds, and builder-made structures (planned ones count) reach the screen
  const bkey = await dbg.evaluate(() => document.querySelector('.vrow.sel').dataset.k);
  const nBuilt = await game.evaluate(key => { const r = BF.mobs.villages.get(key); return (r.built || []).filter(e => e.state !== 'abandoned').length; }, bkey);
  await dbg.waitForTimeout(800);
  const leg = await dbg.evaluate(() => document.getElementById('legend').textContent);
  ok('map legend shows houses, farms, paddocks and builder stars (' + nBuilt + ' built)', /House/.test(leg) && /Farm/.test(leg) && /Paddock/.test(leg) && /Built by a builder/.test(leg));
  // happiness: the formula's terms, events falling out of the week, and the panel showing the game's score
  const hap = await game.evaluate(key => {
    const H = BF.happiness, rec = BF.mobs.villages.get(key);
    const vs = rec.members.filter(m => m.type === 'villager' && !m.dead && !m.removed), ad = vs.filter(m => !m.child);
    const h0 = H.score(rec), c = id => h0.terms.find(t => t.id === id).count;
    const sum = h0.terms.reduce((n, t) => n + t.count * t.weight, H.BASE);
    H.note(rec.key, 'birth'); H.note(rec.key, 'death');
    const h1 = H.score(rec);
    return { score: h0.score, raw: h0.raw, sum, starving: c('starving') === vs.filter(m => m.starving).length,
      unemployed: c('unemployed') === ad.filter(m => m.profession === 'unemployed').length, d1: h1.raw - h0.raw, key: rec.key };
  }, shownKey);
  ok('happiness = 100 + terms, clamped ' + JSON.stringify(hap), hap.raw === Math.round(hap.sum) && hap.score === Math.max(0, Math.min(100, hap.raw)) && hap.starving && hap.unemployed);
  await dbg.waitForFunction(() => /\u221210 1 villagers? killed/.test(document.getElementById('v-happy').textContent), null, { timeout: 8000 }).catch(() => {});
  const hShown = await dbg.evaluate(() => document.getElementById('v-happy').textContent);
  ok('happiness shown on the debug screen: ' + hShown.slice(0, 60), /Happiness\s*\d+\s*\/ 100/.test(hShown) && /\u221210 1 villagers? killed this week/.test(hShown) && /\+\d+ \d+ born this week/.test(hShown));
  await dbg.screenshot({ path: out + '-happy.png', fullPage: true });
  const born2 = await game.evaluate(key => { BF.sky.day += 8; const n = BF.happiness.score(BF.mobs.villages.get(key)).terms.find(t => t.id === 'born').count; BF.sky.day -= 8; return n; }, hap.key);
  ok('a birth and a death this week move happiness by +5 - 10, gone after a week', hap.d1 === -5 && born2 === 0);
  const hsave = await game.evaluate(key => {
    const H = BF.happiness, saved = JSON.stringify(H.serialize());
    H.deserialize(JSON.parse(saved));
    const round = JSON.stringify(H.serialize()) === saved && H.last(key) != null;
    const d = BF.sky.day + BF.sky.time;   // a save from before happiness: last week's events come from the village log
    H.deserialize({ fromLog: { [key]: [[d - 10, 'trade', 'old'], [d - 1, 'trade', 'a'], [d - 0.5, 'death', 'b']] } });
    const t = H.score(BF.mobs.villages.get(key)).terms, n = id => t.find(x => x.id === id).count;
    const fromLog = n('trades') === 1 && n('killed') === 1;
    H.deserialize(JSON.parse(saved));
    return { round, fromLog };
  }, hap.key);
  ok('happiness saves and loads, old saves read last week from the log ' + JSON.stringify(hsave), hsave.round && hsave.fromLog);
  // past villagers: a villager killed in the shown village is listed with its job, cause and age, and counted
  const victim = await game.evaluate(key => {
    const r = BF.mobs.villages.get(key), m = r.members.find(x => x.type === 'villager' && !x.dead && !x.child && x.profession !== 'unemployed');
    const name = BF.vlog.nameOf(m); BF.mobs.hurt(m, 999, 'a zombie'); return name;
  }, bkey);
  await dbg.waitForFunction(n => document.getElementById('r-pastb').textContent.includes(n), victim, { timeout: 8000 }).catch(() => {});
  const past = await dbg.evaluate(() => ({ n: document.getElementById('r-pastn').textContent, row: document.getElementById('r-pastb').querySelector('tr').textContent, count: document.getElementById('r-count').textContent }));
  await dbg.screenshot({ path: out + '-past.png', fullPage: true });
  ok('past villagers list the dead one ' + JSON.stringify(past), +past.n >= 1 && past.row.includes(victim) && /killed by a zombie/.test(past.row) && /days?$/.test(past.row) && /\d+ died/.test(past.count));
  // the game page's scripts carry their file times, so a browser can't keep running an old saved copy of one
  ok('game scripts are versioned', await game.evaluate(() => [...document.scripts].filter(s => /\/js\//.test(s.src)).every(s => /\?v=\d+$/.test(s.src))));
  // a feed error (an old villagelog.js without panelData, say) shows on the screen instead of "waiting for the game"
  await game.evaluate(() => { window._pd = BF.vlog.panelData; delete BF.vlog.panelData; });
  await dbg.waitForTimeout(6000);
  const errShown = await dbg.evaluate(() => ({ conn: document.getElementById('conn').textContent, wait: !document.getElementById('waiting').hidden, text: document.getElementById('waiting').textContent }));
  ok('feed error shown ' + errShown.conn, errShown.conn === 'Game error' && errShown.wait && /panelData/.test(errShown.text));
  await game.evaluate(() => { BF.vlog.panelData = window._pd; });
  await dbg.waitForTimeout(5000);   // after an error the feed waits 4 s before its next try
  ok('live again once fixed', (await got()).conn === 'Live');
  // a debug screen opened after the game has gone doesn't show its last snapshot as live
  await game.close(); await dbg.waitForTimeout(3000);
  await dbg.reload(); await dbg.waitForTimeout(1500);
  ok('closed game not shown as live: ' + (await got()).conn, (await got()).conn === 'Game not responding');
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));   // free the ports for the next run
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
