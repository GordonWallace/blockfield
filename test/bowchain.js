// Bow and arrow economy soak (release 1.3): the poultry keeper's culls give feathers, the shepherd spins string, the miner keeps flint from gravel,
// the forester sells sticks, and the fletcher buys them and makes arrows and bows. Runs one village that has a fletcher, a shepherd, a poultry
// keeper, a miner and a forester for N game days (no rendering, like test/toolchain.js) and checks:
//  - feathers, string and flint reached the fletcher (it bought them from villagers), and it has arrows and bows to sell at the end or made them;
//  - the daily restock never gives anyone arrows, bows, feathers, string, flint, eggs or raw chicken;
//  - no arrows, feathers or string appear from nothing: the village's totals (packs and chests within 80 blocks) never exceed what it held at the start
//    plus what was made (arrows crafted, feathers from culls, string spun) minus what was used up (feathers in arrows, string in bows).
// Usage: NODE_PATH=$(npm root -g) node test/bowchain.js [days=14] [seed=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 14), SEED = +(process.argv[3] || 1);
const NEED = ['fletcher', 'shepherd', 'poultry_keeper', 'miner', 'forester'];

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  let pageErrors = 0;
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) console.log('console.error:', m.text().slice(0, 300)); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await pg.waitForTimeout(3000);
  // the nearest village (within 3000 blocks of 0,0) whose villagers include every trade of the chain and that has a coop
  const cands = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    return BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop && (v.buildings || []).some(x => x.type === 'coop'))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 8).map(v => ({ x: v.x, y: v.y, z: v.z, pop: v.pop }));
  });
  await pg.evaluate(() => {
    const WATCH = window.__WATCH = ['arrow', 'bow', 'feather', 'string', 'flint', 'egg', 'raw_chicken'];
    const R = window.__rec = { key: null, lines: [], restock: [], buys: {} };
    const oLog = BF.vlog.log;
    BF.vlog.log = function (rec, kind, text) { if (rec && rec.key === R.key) R.lines.push([+(BF.sky.day + BF.sky.time).toFixed(3), kind, String(text)]); return oLog.apply(this, arguments); };
    const oTrade = BF.vlog.trade;   // trades are logged inside villagelog.js, past the BF.vlog.log hook
    BF.vlog.trade = function (buyer, seller, o, times) {
      if (buyer && buyer.profession === 'fletcher' && buyer.village && buyer.village.key === R.key && o && o.sell) {
        const k = BF.items[o.sell.id].name + ' from ' + (seller && seller.profession);
        R.buys[k] = (R.buys[k] || 0) + o.sell.n * (times || 1);
      }
      return oTrade.apply(this, arguments);
    };
    const oEmit = BF.emit;   // gravel broken in the village area (the miner's flint source)
    BF.emit = function (ev, x, y, z, id) {
      if (ev === 'blockBroken' && id === BF.B.gravel && R.key) { const [cx, cz] = R.key.split(',').map(Number); if (Math.hypot(x - cx, z - cz) < 120) R.gravel = (R.gravel || 0) + 1; }
      return oEmit.apply(this, arguments);
    };
    const oRestock = BF.trades.restock;
    BF.trades.restock = function (m) {
      const cnt = () => WATCH.map(n => m && Array.isArray(m.inv) ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
      const before = cnt(), r = oRestock.apply(this, arguments), after = cnt();
      WATCH.forEach((n, i) => { if (after[i] > before[i]) R.restock.push([m.profession, n, after[i] - before[i]]); });
      return r;
    };
    // the village's holdings of the watched items: its villagers' packs and the chests within 80 blocks of its centre
    window.__total = () => {
      const out = {}, I = BF.I, [cx, cz] = R.key.split(',').map(Number);
      const ms = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === R.key && !m.dead && Array.isArray(m.inv));
      for (const n of WATCH) {
        let t = 0;
        for (const m of ms) t += BF.trades.inv.count(m.inv, I[n]);
        for (const c of BF.inventory.chests.values()) if (Math.hypot(c.pos.x - cx, c.pos.z - cz) < 80) for (const s of c.slots) if (s && s.id === I[n]) t += s.count;
        out[n] = t;
      }
      return out;
    };
  });
  let setup = null;
  for (const v of cands) {
    const r = await pg.evaluate(v => {
      const key = window.__rec.key = Math.round(v.x) + ',' + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      BF.sky.setTime(0.02);
      for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
      const profs = {};
      for (const m of BF.mobs.list) if (m.type === 'villager' && m.village && m.village.key === key && !m.dead) profs[m.profession] = (profs[m.profession] || 0) + 1;
      return { key, pop: v.pop, profs };
    }, v);
    if (NEED.every(p => r.profs[p])) { setup = r; break; }
    console.log(`seed ${SEED} village ${r.key} pop ${r.pop}: skipped ${JSON.stringify(r.profs)}`);
  }
  if (!setup) setup = { err: 'no village with ' + NEED.join(', ') + ' and a coop among the nearest ' + cands.length };
  else await pg.evaluate(() => { const R = window.__rec; R.lines.length = 0; R.restock.length = 0; R.buys = {}; R.gravel = 0; R.start = window.__total(); });
  if (setup.err) { console.log('FAIL ' + setup.err); await b.close(); process.exitCode = 1; return; }
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}: ${JSON.stringify(setup.profs)}`);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), PER = Math.round(200 / h);
  const t0 = Date.now();
  for (let s = 0; s < total; s += PER) {
    await pg.evaluate(([n, h, key]) => {
      const [x, z] = key.split(',').map(Number);
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
      }
    }, [Math.min(PER, total - s), h, setup.key]);
    if ((s / PER) % 24 === 23) console.log(`  day ${((s + PER) * h / 1200).toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const R = await pg.evaluate(() => {
    const R = window.__rec, I = BF.I;
    R.end = window.__total();
    const f = BF.mobs.list.find(m => m.type === 'villager' && m.profession === 'fletcher' && m.village && m.village.key === R.key && !m.dead);
    R.fletcher = f ? { inv: f.inv.filter(Boolean).map(s => BF.items[s.id].name + ':' + s.count), offers: (f.trades || []).filter(o => o.sell.id === I.arrow || o.sell.id === I.bow).map(o => BF.items[o.sell.id].name + (BF.trades.blockReason(f, o) ? ' (' + BF.trades.blockReason(f, o) + ')' : ' in stock')) } : null;
    R.miners = BF.mobs.list.filter(m => m.type === 'villager' && m.profession === 'miner' && m.village && m.village.key === R.key && !m.dead).map(m => {
      const Q = BF.miner._test.state(m);
      return { inv: m.inv.filter(Boolean).map(x => BF.items[x.id].name + ':' + x.count).join(' '), flint: BF.trades.inv.count(m.inv, I.flint), wantsFlint: BF.miner.wantsFlint(m), grav: Q.grav ? Q.grav.length : null, surf: Q.surf ? Q.surf.length : null, depth: BF.miner.digDepth(m), status: BF.villagerStatus.text(m) };
    });
    R.holders = {};
    for (const n of ['feather', 'flint', 'string', 'arrow']) R.holders[n] = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === R.key && !m.dead && Array.isArray(m.inv) && BF.trades.inv.count(m.inv, I[n]) > 0).map(m => m.profession + ':' + BF.trades.inv.count(m.inv, I[n])).join(' ');
    R.flShort = f ? BF.fletcher.shortfall(f) : null;
    R.keepers = BF.mobs.list.filter(m => m.type === 'villager' && m.profession === 'poultry_keeper' && m.village && m.village.key === R.key && !m.dead)
      .map(m => ({ inv: m.inv.filter(Boolean).map(x => BF.items[x.id].name + ':' + x.count).join(' '), offers: (m.trades || []).map(o => BF.trades.table ? (o.buy.map(b => b.n + ' ' + BF.items[b.id].name).join('+') + ' > ' + o.sell.n + ' ' + BF.items[o.sell.id].name + (BF.trades.blockReason(m, o) ? ' (' + BF.trades.blockReason(m, o) + ')' : '')) : '') }));
    R.poultry = BF.poultry.coopsOf(BF.mobs.villages.get(R.key)).map(c => ({ hens: c.hens ? c.hens.length : null, eggs: c.eggs }));
    return R;
  });
  // ---- the ledger from the village log
  const sum = (re, f = m => +m[1]) => R.lines.reduce((n, l) => { const m = re.exec(l[2]); return n + (m ? f(m) : 0); }, 0);
  const arrows = sum(/\(Fletcher\) made (\d+) arrows/), bows = sum(/\(Fletcher\) made a bow/, () => 1);
  const spun = sum(/\(Shepherd\) spun (\d+) string/), culledFeathers = sum(/culled a chicken .* (\d+) feathers?/);
  const bought = n => Object.entries(R.buys).filter(([k]) => k.startsWith(n + ' ')).reduce((t, [, v]) => t + v, 0);
  const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  console.log('start', JSON.stringify(R.start), 'end', JSON.stringify(R.end));
  console.log('made', JSON.stringify({ arrows, bows, spun, culledFeathers }), 'coops', JSON.stringify(R.poultry));
  console.log('fletcher', JSON.stringify(R.fletcher));
  console.log('fletcher bought', JSON.stringify(R.buys), 'short', JSON.stringify(R.flShort));
  console.log('miners', JSON.stringify(R.miners), 'gravel broken', R.gravel);
  console.log('keepers', JSON.stringify(R.keepers));
  console.log('holders', JSON.stringify(R.holders));
  ok('the fletcher bought feathers', bought('feather') > 0, bought('feather'));
  ok('the fletcher bought string', bought('string') > 0, bought('string'));
  ok('the fletcher bought flint', bought('flint') > 0, bought('flint'));
  ok('the fletcher made arrows', arrows > 0, arrows);
  ok('the fletcher made a bow', bows > 0, bows);
  ok('the shepherd spun string', spun > 0, spun);
  ok('the poultry keeper culled chickens for feathers', culledFeathers > 0, culledFeathers);
  ok('the restock created none of the watched items', R.restock.length === 0, R.restock.slice(0, 5));
  ok('no arrows from nothing', R.end.arrow <= R.start.arrow + arrows, [R.start.arrow, arrows, R.end.arrow]);
  ok('no feathers from nothing', R.end.feather <= R.start.feather + culledFeathers - arrows / 4, [R.start.feather, culledFeathers, arrows / 4, R.end.feather]);
  ok('no string from nothing', R.end.string <= R.start.string + spun - 3 * bows, [R.start.string, spun, 3 * bows, R.end.string]);
  ok('no bows from nothing', R.end.bow <= R.start.bow + bows, [R.start.bow, bows, R.end.bow]);
  if (pageErrors) ok('no page errors', false, pageErrors);
  console.log(`ran ${DAYS} days in ${Math.round((Date.now() - t0) / 1000)} s`);
  await b.close();
})();
