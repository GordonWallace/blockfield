// @ci integration suite=farming soak timeout=1800 args=10,1
// Bees soak (js/bees.js, js/beekeeper.js): one grass village with a beekeeper runs for N game days (no rendering, like test/cowchain.js) and checks:
//  - the beekeeper harvests honey and comb from its hives, and sells honey, honeycomb or candles to the village;
//  - nothing from nothing: the daily restock never gives anyone honey bottles, honeycomb, candles or beehives; the village never holds more honey,
//    comb or candles than the start plus what the beekeeper harvested (minus the comb that went into hives and candles);
//  - hives only from real comb: every hive it made took 3 honeycomb it harvested; at most HIVES_MAX hives each;
//  - flowers only from picked: it never planted more flowers than it picked (plus what it held at the start);
//  - bees are led home when a wild nest is in reach and one of its hives is low (reported, checked only when both held);
//  - no villager starved.
// Usage: NODE_PATH=$(npm root -g) node test/beechain.js [days=10] [seed=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 10), SEED = +(process.argv[3] || 1);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  let pageErrors = 0;
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) console.log('console.error:', m.text().slice(0, 300)); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED + 'gen3');
  await pg.waitForTimeout(3000);
  const cands = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    return BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop >= 6).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 8)
      .map(v => ({ x: v.x, y: v.y, z: v.z, pop: v.pop }));
  });
  await pg.evaluate(() => {
    const WATCH = window.__WATCH = ['honey_bottle', 'honeycomb', 'candle', 'beehive'];
    const R = window.__rec = { key: null, lines: [], restock: [], sold: {}, hunger: [] };
    const mine = m => m && m.village && m.village.key === R.key;
    const oLog = BF.vlog.log;
    BF.vlog.log = function (rec, kind, text) { if (rec && rec.key === R.key) R.lines.push([+(BF.sky.day + BF.sky.time).toFixed(3), kind, String(text)]); return oLog.apply(this, arguments); };
    const oTrade = BF.vlog.trade;
    BF.vlog.trade = function (buyer, seller, o, times) {
      if (seller && seller !== 'player' && seller.profession === 'beekeeper' && mine(seller) && !(buyer && buyer.profession === 'beekeeper')) {
        let item = null, n = 0;
        if (o && o.sell) { item = BF.items[o.sell.id].name; n = o.sell.n * (times || 1); }
        else if (typeof o === 'string') { const m = /got (\d+) (.+)$/.exec(o); if (m) { n = +m[1]; item = m[2]; } }
        if (item) R.sold[item] = (R.sold[item] || 0) + n;
      }
      return oTrade.apply(this, arguments);
    };
    const oRestock = BF.trades.restock;
    BF.trades.restock = function (m) {
      const cnt = () => WATCH.map(n => m && Array.isArray(m.inv) ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
      const before = cnt(), r = oRestock.apply(this, arguments), after = cnt();
      WATCH.forEach((n, i) => { if (after[i] > before[i]) R.restock.push([m.profession, n, after[i] - before[i]]); });
      return r;
    };
    window.__villagers = () => BF.mobs.list.filter(m => m.type === 'villager' && mine(m) && !m.dead && Array.isArray(m.inv));
    window.__total = () => {
      const out = {}, I = BF.I, [cx, cz] = R.key.split(',').map(Number), ms = window.__villagers();
      for (const n of WATCH) {
        let t = 0;
        for (const m of ms) t += BF.trades.inv.count(m.inv, I[n]);
        for (const c of BF.inventory.chests.values()) if (Math.hypot(c.pos.x - cx, c.pos.z - cz) < 80) for (const s of c.slots) if (s && s.id === I[n]) t += s.count;
        out[n] = t;
      }
      return out;
    };
    window.__keeper = () => window.__villagers().find(m => m.profession === 'beekeeper');
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
      const k = window.__keeper();
      return { key, pop: v.pop, keeper: !!k, hives: k ? BF.beekeeper.hivesOf(k).length : 0 };
    }, v);
    if (r.keeper && r.hives > 0) { setup = r; break; }
    console.log(`seed ${SEED} village ${r.key} pop ${r.pop}: skipped ${JSON.stringify(r)}`);
  }
  if (!setup) { console.log('FAIL no village with a beekeeper and hives among the nearest ' + cands.length); await b.close(); process.exitCode = 1; return; }
  await pg.evaluate(() => {
    const R = window.__rec, k = window.__keeper();
    R.lines.length = 0; R.restock.length = 0; R.sold = {};
    R.start = window.__total();
    R.keeper = k; R.base = new Map();   // every beekeeper of the village (a second one can take a builder's extractor): what it had made and held
    for (const m of window.__villagers()) if (m.profession === 'beekeeper') { const H = BF.beekeeper.holdings(m); R.base.set(m, { made: H.made, flowers: H.flowers }); }
    R.pop0 = window.__villagers().length;
  });
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}: ${setup.hives} hives`);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), PER = Math.round(200 / h);
  const t0 = Date.now();
  for (let s = 0; s < total; s += PER) {
    await pg.evaluate(([n, h, key]) => {
      const [x, z] = key.split(',').map(Number);
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
      }
      const R = window.__rec, ms = window.__villagers();
      R.hunger.push(ms.length);
      const k = R.keeper;
      for (const m of ms) if (m.profession === 'beekeeper') {   // hives never more than HIVES_MAX each
        if (!R.base.has(m)) R.base.set(m, { made: {}, flowers: BF.beekeeper.holdings(m).flowers });
        R.maxHives = Math.max(R.maxHives || 0, BF.beekeeper.hivesOf(m).length);
      }
    }, [Math.min(PER, total - s), h, setup.key]);
    if ((s / PER) % 24 === 23) console.log(`  day ${((s + PER) * h / 1200).toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const R = await pg.evaluate(() => {
    const R = window.__rec, k = R.keeper, H = BF.beekeeper.holdings(k);
    R.end = window.__total();
    R.alive = !k.dead; R.keepers = R.base.size;
    R.made = {}; R.made0 = {}; R.flowers0 = 0;
    for (const [m, b0] of R.base) { const M = BF.beekeeper.holdings(m).made; for (const x in M) { R.made[x] = (R.made[x] || 0) + M[x]; R.made0[x] = (R.made0[x] || 0) + (b0.made[x] || 0); } R.flowers0 += b0.flowers; }
    R.offers = (k.trades || []).filter(o => o && o.sell && ['honey_bottle', 'honeycomb', 'candle'].includes(BF.items[o.sell.id].name)).map(o => BF.items[o.sell.id].name);
    R.held = { honey: H.honey, comb: H.comb, candles: H.candles };
    delete R.base;
    R.hives = BF.beekeeper.hivesOf(k).map(o => [o.bees, o.honey]);
    const hv = BF.beekeeper.hivesOf(k);
    R.nest = BF.bees.loadedHomes().some(n => n.kind === 'nest' && n.bees >= 2 && hv.some(o => Math.hypot(o.x - n.x, o.z - n.z) < BF.beekeeper.NEST_R));
    R.starved = R.lines.filter(l => /starv/i.test(l[2])).map(l => l[2]);
    R.pop1 = window.__villagers().length;
    R.log = Object.entries(BF.beekeeper.LOG.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {})).map(([k, n]) => k + ':' + n).join(' ');
    delete R.keeper;
    return R;
  });
  const d = (a, b0) => (a || 0) - (b0 || 0);
  const m = R.made, m0 = R.made0;
  const comb = d(m.comb, m0.comb), honey = d(m.honey, m0.honey), candles = d(m.candles, m0.candles), hives = d(m.hives, m0.hives);
  const picked = d(m.picked, m0.picked), planted = d(m.flowers, m0.flowers), led = d(m.led, m0.led);
  console.log('beekeepers', R.keepers, 'made', JSON.stringify({ comb, honey, candles, hives, picked, planted, led }), 'sold', JSON.stringify(R.sold));
  console.log('start', JSON.stringify(R.start), 'end', JSON.stringify(R.end), 'hives', JSON.stringify(R.hives), 'max', R.maxHives, 'log', R.log);
  console.log('villagers by 200 s', R.hunger.join(' '));
  const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) process.exitCode = 1; };
  ok('the beekeeper is alive', R.alive);
  ok('it harvested honey and comb', honey > 0 && comb > 0, { honey, comb });
  ok('it offers honey goods it holds (sales to villagers reported: honey is their last-resort food)', R.offers.length > 0 && R.held.honey + R.held.comb + R.held.candles > 0, { offers: R.offers, held: R.held, sold: R.sold });
  ok('the restock gave no honey goods or hives', R.restock.length === 0, R.restock.slice(0, 8));
  ok('no honey bottles from nothing', R.end.honey_bottle <= R.start.honey_bottle + honey, { start: R.start.honey_bottle, end: R.end.honey_bottle, honey });
  ok('no honeycomb from nothing', R.end.honeycomb <= R.start.honeycomb + comb - 3 * hives - candles, { start: R.start.honeycomb, end: R.end.honeycomb, comb, hives, candles });
  ok('no candles from nothing', R.end.candle <= R.start.candle + candles, { start: R.start.candle, end: R.end.candle, candles });
  ok('hives only from harvested comb, at most ' + 4 + ' each', 3 * hives <= comb && R.maxHives <= 4, { hives, comb, max: R.maxHives });
  ok('flowers planted only from flowers picked', planted <= picked + R.flowers0, { planted, picked, held: R.flowers0 });
  ok('bees led home when a nest is in reach and a hive is low', !(R.nest && R.hives.some(x => x[0] < 10)) || led > 0, { nest: R.nest, led, hives: R.hives });
  ok('no villager starved', R.starved.length === 0, R.starved.slice(0, 4));
  ok('no page errors', pageErrors === 0, pageErrors);
  await b.close();
})();
