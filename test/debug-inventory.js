// Debug screen: picking a villager (list row or map) shows its inventory, slot for slot with icons, counts and wear bars,
// as the game's trade screen does. NODE_PATH=$(npm root -g) node test/debug-inventory.js [outPrefix]
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-inventory';
const GAME = 8720, DBG = 8721;
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
  await require('./lib').toVillage(game);
  // a known inventory: 7 diamonds in slot 0, a half-worn iron pickaxe in slot 2, 64 bread in slot 5, the rest empty
  const v = await game.evaluate(() => {
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const m = rec.members.find(x => x.type === 'villager' && !x.dead && !x.child && x.inv);
    m.inv.fill(null);
    m.inv[0] = { id: BF.I.diamond, count: 7 };
    m.inv[2] = { id: BF.I.iron_pickaxe, count: 1, wear: Math.round(BF.durability(BF.I.iron_pickaxe) / 2) };
    m.inv[5] = { id: BF.I.bread, count: 64 };
    return { name: BF.vlog.nameOf(m), slots: m.inv.length, pick: BF.itemName(BF.I.iron_pickaxe) };
  });
  const dbg = await b.newPage({ viewport: { width: 1600, height: 1100 } });
  dbg.on('pageerror', e => console.log('DBG PAGEERROR', e.message));
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.waitForFunction(n => [...document.querySelectorAll('#r-body tr')].some(t => t.dataset.n === n), v.name, { timeout: 20000 }).catch(() => {});
  ok('no inventory shown before a pick', await dbg.evaluate(() => document.getElementById('r-inv').hidden));
  const pick = n => dbg.evaluate(n => [...document.querySelectorAll('#r-body tr')].find(t => t.dataset.n === n).click(), n);
  const read = () => dbg.evaluate(() => {
    const el = document.getElementById('r-inv');
    return { hidden: el.hidden, title: (el.querySelector('h4') || {}).textContent || '',
      slots: [...el.querySelectorAll('.vslot')].map(s => ({ img: !!(s.querySelector('img') && s.querySelector('img').naturalWidth), n: (s.querySelector('b') || {}).textContent || '', tip: s.title, wear: !!s.querySelector('.wear') })) };
  });
  await pick(v.name); await dbg.waitForTimeout(800);
  let r = await read();
  ok('clicking the name shows the inventory: ' + r.title, !r.hidden && r.title.startsWith(v.name + "'s Inventory"));
  ok('18 slots like the game (' + r.slots.length + ')', r.slots.length === v.slots);
  ok('diamonds x7 with icon ' + JSON.stringify(r.slots[0]), r.slots[0].img && r.slots[0].n === '7' && /Diamond/.test(r.slots[0].tip));
  ok('worn pickaxe has a wear bar ' + JSON.stringify(r.slots[2]), r.slots[2].img && r.slots[2].wear && r.slots[2].tip.startsWith(v.pick) && /50% durability/.test(r.slots[2].tip));
  ok('bread x64 ' + JSON.stringify(r.slots[5]), r.slots[5].img && r.slots[5].n === '64');
  ok('the rest are empty', r.slots.filter((s, i) => ![0, 2, 5].includes(i)).every(s => !s.img && !s.tip));
  await dbg.screenshot({ path: out + '.png', fullPage: true });
  // live: the game changes the inventory, the view follows
  await game.evaluate(n => { const m = BF.mobs.list.find(x => x.type === 'villager' && BF.vlog.nameOf(x) === n); m.inv[0].count = 3; m.inv[8] = { id: BF.I.emerald, count: 12 }; }, v.name);
  // a slow machine (CI runs the game at a few fps) can take several seconds to send the next snapshot
  await dbg.waitForFunction(() => { const s = document.querySelectorAll('#r-inv .vslot'); return s[0] && s[8] && (s[0].querySelector('b') || {}).textContent === '3' && (s[8].querySelector('b') || {}).textContent === '12'; }, null, { timeout: 20000 }).catch(() => {});
  r = await read();
  ok('updates live ' + r.slots[0].n + ' / ' + r.slots[8].n, r.slots[0].n === '3' && r.slots[8].n === '12' && r.slots[8].img);
  // a restarted server and a reloaded screen still get every icon
  srv.kill(); await new Promise(x => srv.once('exit', x));
  srv = await start();
  await game.waitForTimeout(6000);
  await dbg.reload();
  await dbg.waitForFunction(n => [...document.querySelectorAll('#r-body tr')].some(t => t.dataset.n === n), v.name, { timeout: 20000 }).catch(() => {});
  await pick(v.name); await dbg.waitForTimeout(800);
  r = await read();
  ok('icons survive a server restart and reload', r.slots[0].img && r.slots[2].img && r.slots[5].img && r.slots[8].img);
  // clicking again (or the close button) hides it
  await dbg.click('#r-invx'); await dbg.waitForTimeout(200);
  ok('close button hides it', (await read()).hidden);
  await b.close(); srv.kill();
  console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
