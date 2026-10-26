// @ci integration suite=items,ui timeout=600
// bug-079: a drag-split sent right after a shift-click, before the shift-click's self message reaches the page (worker/server: the
// page's view of the slots is a round trip behind). js/playerinv.js applyDrag checks each dragged-over slot against the sim's own
// slots and splits the cursor over the ones that still take it, so nothing is duplicated and no share is lost. Seed 3, served over
// http, once per host (default worker,page):
//   - the race: diamond shift-clicked into slot 9, then dirt dragged over 9-12 at once: still 1 diamond and 64 dirt, slot 9 the diamond;
//   - a drag naming the same slot twice and a slot that can't take items (the crafting result): the cursor splits over the real slots
//     only and every item is still there.
// Usage: NODE_PATH=$(npm root -g) node test/drag-stale.js [hosts=worker,page]
const path = require('path');
const root = path.resolve(__dirname, '..');
const lib = require(path.join(root, 'test', 'lib.js'));
const { chromium } = require(process.env.PW || 'playwright');
const HOSTS = (process.argv[2] || 'worker,page').split(',');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); if (!ok) fails++; };

async function run(b, host) {
  const srv = host === 'page' ? null : await lib.serve({ world: host === 'server' });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await lib.install(pg);
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto((srv ? srv.url : 'file://' + path.join(root, 'index.html')) + '?nolod&sim=' + host + '#seed=3');
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await lib.ready(pg); await lib.simReady(pg);
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query('stats', {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const totals = () => lib.sim(pg, () => {
    const inv = BF.inventory, n = {}, add = s => { if (s) n[BF.items[s.id].name] = (n[BF.items[s.id].name] || 0) + s.count; };
    inv.own().forEach(s => s && (n[s.n] = (n[s.n] || 0) + s.c)); add(inv.cursor);
    return { n, slot9: inv.own()[9] && inv.own()[9].n };
  });
  const reset = async () => {
    await lib.sim(pg, () => { const inv = BF.inventory; inv.clear(); inv.add(BF.I.diamond, 1); inv.add(BF.I.dirt, 64); BF.proto && BF.proto.flush && BF.proto.flush(); return 1; });
    await settle(); await settle();
    await pg.evaluate(() => BF.req.player('player.click', null, { c: 'inv', i: 1, button: 0, shift: false }));   // dirt onto the cursor
    await settle();
  };
  await lib.sim(pg, () => { BF.player.setGameMode && BF.player.setGameMode('survival'); return 1; });
  await pg.evaluate(() => BF.inventory.open('inventory'));
  await settle();

  await reset();
  await pg.evaluate(() => {
    BF.req.player('player.click', null, { c: 'inv', i: 0, button: 0, shift: true });
    BF.req.player('player.drag', null, { els: [['inv', 9], ['inv', 10], ['inv', 11], ['inv', 12]], button: 0 });
  });
  await settle(); await settle();
  let t = await totals();
  check(t.n.diamond === 1 && t.n.dirt === 64 && t.slot9 === 'diamond', host + ': drag right after a shift-click duplicates nothing', t);

  await reset();
  await pg.evaluate(() => BF.req.player('player.drag', null, { els: [['inv', 20], ['inv', 20], ['result', 0], ['inv', 21]], button: 0 }));
  await settle(); await settle();
  const r = await lib.sim(pg, () => { const s = BF.inventory.own(); return [s[20] && s[20].c, s[21] && s[21].c, BF.inventory.cursor ? BF.inventory.cursor.count : 0]; });
  t = await totals();
  check(r[0] === 32 && r[1] === 32 && r[2] === 0 && t.n.dirt === 64, host + ': a repeated or closed slot in a drag splits over the real slots only', { slots20_21_cursor: r, totals: t.n });
  await ctx.close(); if (srv) await srv.stop();
}

(async () => {
  const b = await chromium.launch();
  for (const h of HOSTS) await run(b, h);
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
