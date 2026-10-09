// Baking economy soak (js/baker.js): one village with a baker, a farmer, a poultry keeper and a cowherd runs for N game days (no rendering,
// like test/cowchain.js) and checks:
//  - the baker bakes cakes (and pies when the farmers have pumpkins) in its oven, only from ingredients it bought or held at the start: what
//    its bakes used (3 milk, 2 sugar, 1 egg, 3 wheat a cake; 1 pumpkin, 1 sugar, 1 egg a pie) never exceeds that;
//  - nothing from nothing: the daily restock never gives anyone cakes, slices, pies, sugar, milk, bottles, buckets, eggs, wheat, pumpkins or cane;
//    the village's treats never exceed the start plus what the ovens baked (a cake is 7 slices); its glass bottles (empty and full) never exceed
//    the start plus 30 per cowherd hire kit; the baker never holds a bucket;
//  - the farmer grows sugar cane beside its beds' water, the baker buys milk from the cowherd, villagers buy treats (the happiness term counts).
// Usage: NODE_PATH=$(npm root -g) node test/bakechain.js [days=14] [seed=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 14), SEED = +(process.argv[3] || 1);

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
  // the nearest villages (within 3000 blocks of 0,0) whose plan has a baker and a cowherd
  const cands = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    return BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop >= 15 && (v.buildings || []).some(x => x.type === 'pasture'))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 6).map(v => ({ x: v.x, y: v.y, z: v.z, pop: v.pop }));
  });
  await pg.evaluate(() => {
    const WATCH = window.__WATCH = ['cake', 'cake_slice', 'pumpkin_pie', 'sugar', 'sugar_cane', 'pumpkin', 'egg', 'wheat_item', 'milk_bottle', 'milk_bucket', 'glass_bottle', 'bucket'];
    const R = window.__rec = { key: null, lines: [], restock: [], trades: [], baked: { cake: 0, pie: 0 }, kits: 0, happy: [], soldTreats: 0 };
    const mine = m => m && m.village && m.village.key === R.key;
    const oLog = BF.vlog.log;
    BF.vlog.log = function (rec, kind, text) { if (rec && rec.key === R.key) R.lines.push([+(BF.sky.day + BF.sky.time).toFixed(3), kind, String(text)]); return oLog.apply(this, arguments); };
    const oTrade = BF.vlog.trade;
    BF.vlog.trade = function (buyer, seller, o, times) {
      if (buyer && buyer !== 'player' && mine(buyer)) {
        let item = null, n = 0;
        if (o && o.sell) { item = BF.items[o.sell.id].name; n = o.sell.n * (times || 1); }
        else if (typeof o === 'string') { const m = /got (\d+) (.+)$/.exec(o); if (m) { n = +m[1]; item = m[2]; } }
        if (item) R.trades.push([buyer.profession, seller && seller.profession, item.toLowerCase().replace(/ /g, '_'), n, !!mine(seller)]);
      }
      return oTrade.apply(this, arguments);
    };
    BF.on('ovenBaked', (x, y, z, kind) => { const [cx, cz] = R.key ? R.key.split(',').map(Number) : [0, 0]; if (Math.hypot(x - cx, z - cz) < 120) R.baked[kind]++; });
    BF.on('villagerFoodTrade', (buyer, seller, item) => { if (mine(buyer) && seller && seller.profession === 'baker' && BF.baker.isTreat(item)) R.soldTreats++; });
    const oKit = BF.cowherd.hireKit;
    BF.cowherd.hireKit = function (m) { const r = oKit.apply(this, arguments); if (r && mine(m)) R.kits++; return r; };
    const oRestock = BF.trades.restock;
    BF.trades.restock = function (m) {
      const cnt = () => WATCH.map(n => m && Array.isArray(m.inv) ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
      const before = cnt(), r = oRestock.apply(this, arguments), after = cnt();
      WATCH.forEach((n, i) => { if (after[i] > before[i]) R.restock.push([m.profession, n, after[i] - before[i]]); });
      return r;
    };
    window.__villagers = () => BF.mobs.list.filter(m => m.type === 'villager' && mine(m) && !m.dead && Array.isArray(m.inv));
    window.__total = () => {   // packs and chests within 80 blocks, and the ovens' contents
      const out = {}, I = BF.I, [cx, cz] = R.key.split(',').map(Number), ms = window.__villagers();
      for (const n of WATCH) {
        let t = 0;
        for (const m of ms) t += BF.trades.inv.count(m.inv, I[n]);
        for (const c of BF.inventory.chests.values()) if (Math.hypot(c.pos.x - cx, c.pos.z - cz) < 80) for (const s of c.slots) if (s && s.id === I[n]) t += s.count;
        for (const o of BF.baker.ovens.values()) if (Math.hypot(o.pos.x - cx, o.pos.z - cz) < 80) for (const s of o.tray.concat(o.out)) if (s.id === I[n]) t += s.count;
        out[n] = t;
      }
      return out;
    };
    window.__baker = () => window.__villagers().find(m => m.profession === 'baker');
    window.__count = (m, n) => (m ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
  });
  let setup = null;
  for (const v of cands) {
    const r = await pg.evaluate(v => {
      const key = window.__rec.key = Math.round(v.x) + ',' + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      BF.sky.setTime(0.02);
      for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
      const ms = window.__villagers(), has = p => ms.some(m => m.profession === p && m.jobsite);
      return { key, pop: v.pop, baker: has('baker'), farmer: has('farmer'), poultry: has('poultry_keeper'), cowherd: has('cowherd') };
    }, v);
    if (r.baker && r.farmer && r.poultry && r.cowherd) { setup = r; break; }
    console.log(`seed ${SEED} village ${r.key} pop ${r.pop}: skipped ${JSON.stringify(r)}`);
  }
  if (!setup) { console.log('FAIL no village with a baker, a farmer, a poultry keeper and a cowherd among the nearest ' + cands.length); await b.close(); process.exitCode = 1; return; }
  await pg.evaluate(() => {
    const R = window.__rec, bk = window.__baker();
    R.lines.length = 0; R.restock.length = 0; R.trades.length = 0; R.baked = { cake: 0, pie: 0 }; R.kits = 0; R.soldTreats = 0;
    R.start = window.__total();
    R.bakerStart = {};
    for (const n of ['milk_bottle', 'sugar', 'sugar_cane', 'egg', 'wheat_item', 'pumpkin']) R.bakerStart[n] = window.__count(bk, n);
    R.bk = bk;
  });
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}`);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), PER = Math.round(200 / h);
  const t0 = Date.now();
  for (let s = 0; s < total; s += PER) {
    await pg.evaluate(([n, h, key]) => {
      const [x, z] = key.split(',').map(Number);
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
      }
      const R = window.__rec, bk = R.bk;
      if (bk && (bk.inv || []).some(s => s && (s.id === BF.I.bucket || s.id === BF.I.milk_bucket))) R.bucketSeen = true;
      const t = BF.happiness.score(BF.mobs.villages.get(R.key)).terms.find(t => t.id === 'treats');
      R.happy.push(t ? t.count : null);
    }, [Math.min(PER, total - s), h, setup.key]);
    if ((s / PER) % 24 === 23) console.log(`  day ${((s + PER) * h / 1200).toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const R = await pg.evaluate(() => {
    const R = window.__rec, bk = R.bk;
    R.end = window.__total();
    R.bakerEnd = { alive: !bk.dead, inv: bk.inv.filter(Boolean).map(s => BF.items[s.id].name + ':' + s.count).join(' '), holdings: BF.baker.holdings(bk) };
    R.log = Object.entries(BF.baker.log.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {})).map(([k, n]) => k + ':' + n).join(' ');
    R.holders = {};
    for (const n of ['cake_slice', 'pumpkin_pie', 'cake', 'sugar_cane', 'pumpkin', 'glass_bottle']) R.holders[n] = window.__villagers().filter(m => window.__count(m, n) > 0).map(m => m.profession + ':' + window.__count(m, n)).join(' ');
    delete R.bk;
    return R;
  });
  const traded = pred => R.trades.filter(pred).reduce((t, x) => t + x[3], 0);
  const bought = item => traded(x => x[0] === 'baker' && x[2] === item);
  const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  const sum = re => R.lines.filter(l => re.test(l[2])).length;
  const cakes = R.baked.cake, pies = R.baked.pie, B0 = R.bakerStart;
  const got = { milk: bought('milk_bottle'), egg: bought('egg'), wheat: bought('wheat_item'), cane: bought('sugar_cane') + bought('sugar'), pumpkin: bought('pumpkin') };
  const caneCut = sum(/\(Farmer\) cut sugar cane/), pumpkinsPicked = sum(/\(Farmer\) harvested a pumpkin/);
  console.log('start', JSON.stringify(R.start), 'end', JSON.stringify(R.end));
  console.log('baked', JSON.stringify(R.baked), 'baker bought', JSON.stringify(got), 'baker start', JSON.stringify(B0));
  console.log('treats sold to villagers', R.soldTreats, 'treats term (max, last)', Math.max(0, ...R.happy.filter(x => x != null)), R.happy[R.happy.length - 1]);
  console.log('farm lines: cane cut', caneCut, 'pumpkins', pumpkinsPicked, '| baker log', R.log);
  console.log('baker', JSON.stringify(R.bakerEnd));
  console.log('holders', JSON.stringify(R.holders));
  console.log('pumpkin trades', JSON.stringify(R.trades.filter(x => x[2] === 'pumpkin')), 'cane trades', JSON.stringify(R.trades.filter(x => x[2] === 'sugar_cane')));
  console.log('bake lines', JSON.stringify(R.lines.filter(l => l[1] === 'bake').slice(0, 12)));
  console.log('bottles back to the cowherd from the baker', traded(x => x[0] === 'cowherd' && x[1] === 'baker' && x[2] === 'glass_bottle'));
  ok('the baker stayed alive', R.bakerEnd.alive);
  ok('the baker baked cakes', cakes > 0, R.baked);
  ok('cakes used only milk the baker bought or held (3 a cake)', 3 * cakes <= B0.milk_bottle + got.milk, [B0.milk_bottle, got.milk, 3 * cakes]);
  ok('... wheat it bought or held (3 a cake)', 3 * cakes <= B0.wheat_item + got.wheat, [B0.wheat_item, got.wheat, 3 * cakes]);
  ok('... eggs it bought or held (1 a cake or pie)', cakes + pies <= B0.egg + got.egg, [B0.egg, got.egg, cakes + pies]);
  ok('... sugar from cane it bought or held (2 a cake, 1 a pie)', 2 * cakes + pies <= B0.sugar + B0.sugar_cane + got.cane, [B0.sugar + B0.sugar_cane, got.cane, 2 * cakes + pies]);
  ok('pies used only pumpkins it bought or held', pies <= B0.pumpkin + got.pumpkin, [B0.pumpkin, got.pumpkin, pies]);
  ok('the baker bought its milk from the cowherd', traded(x => x[0] === 'baker' && x[1] === 'cowherd' && x[2] === 'milk_bottle') > 0, got.milk);
  ok('the farmer cut sugar cane it grew beside water', caneCut > 0, caneCut);
  ok('the restock created none of the watched items', R.restock.length === 0, R.restock.slice(0, 5));
  ok('no slices or cakes from nothing (a baked cake is 7 slices)', R.end.cake_slice + 7 * R.end.cake <= R.start.cake_slice + 7 * R.start.cake + 7 * cakes, [R.start.cake_slice + 7 * R.start.cake, cakes, R.end.cake_slice + 7 * R.end.cake]);
  ok('no pies from nothing', R.end.pumpkin_pie <= R.start.pumpkin_pie + pies, [R.start.pumpkin_pie, pies, R.end.pumpkin_pie]);
  ok('no glass bottles from nothing (only hire kits)', R.end.glass_bottle + R.end.milk_bottle <= R.start.glass_bottle + R.start.milk_bottle + 30 * R.kits, [R.start.glass_bottle + R.start.milk_bottle, R.kits, R.end.glass_bottle + R.end.milk_bottle]);
  const bucketsMade = sum(/\(Toolsmith\) made Bucket/), bucketsIn = traded(x => x[2] === 'bucket' && !x[4]);   // the toolsmith makes them from iron; a merchant may bring some
  ok('no buckets from nothing (start + kits + made by the toolsmith + brought from other villages)', R.end.bucket + R.end.milk_bucket <= R.start.bucket + R.start.milk_bucket + R.kits + bucketsMade + bucketsIn,
    [R.start.bucket + R.start.milk_bucket, R.kits, bucketsMade, bucketsIn, R.end.bucket + R.end.milk_bucket]);
  ok('the baker never held a bucket or milked', !R.bucketSeen);
  ok('villagers bought treats from the baker', R.soldTreats > 0, R.soldTreats);
  ok('the treats happiness term counted villagers', R.happy.some(x => x > 0), Math.max(0, ...R.happy.filter(x => x != null)));
  if (pageErrors) ok('no page errors', false, pageErrors);
  console.log(`ran ${DAYS} days in ${Math.round((Date.now() - t0) / 1000)} s`);
  await b.close();
})();
