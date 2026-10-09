// Cattle economy soak (js/cowherd.js): one village with a cowherd and a stocked generated pasture runs for N game days (no rendering, like
// test/bowchain.js) and checks:
//  - the herd grows (fed cows breed) and is held at the pasture's limit (one cow per 8 cells): the cowherd culls past it;
//  - beef, leather and milk come only from the cows: the daily restock never gives anyone raw beef, steak, leather, milk, glass bottles, buckets or
//    wheat, and the village's totals (packs and chests within 80 blocks) never exceed what it held at the start plus what the cows gave (culls:
//    raw beef and leather from the village log; milkings: 3 bottles' worth each);
//  - no glass bottles from nothing: the village's bottles (empty and full) never exceed the start plus 30 per hire kit given during the run;
//  - the cowherd's buckets and wheat come only from its kit and what it bought: it never holds more than that, minus the wheat it fed;
//  - empty bottles flow back: bottles villagers emptied (milk they drank) are bought back by the cowherd, and none pile up while it is short.
// A lean day: from day LEAN to LEAN + 1 every villager but the cowherd has its food (all but milk) put away, as after a bad harvest, so hungry
// villagers turn to the cowherd's milk (their last resort); what was put away comes back the next day (no more than was taken).
// Usage: NODE_PATH=$(npm root -g) node test/cowchain.js [days=14] [seed=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 14), SEED = +(process.argv[3] || 1);
const LEAN = 3;

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
  // the nearest villages (within 3000 blocks of 0,0) that have a pasture
  const cands = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    return BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop && (v.buildings || []).some(x => x.type === 'pasture'))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 6).map(v => ({ x: v.x, y: v.y, z: v.z, pop: v.pop }));
  });
  await pg.evaluate(() => {
    const WATCH = window.__WATCH = ['raw_beef', 'steak', 'leather', 'milk_bottle', 'milk_bucket', 'glass_bottle', 'bucket', 'wheat_item'];
    const R = window.__rec = { key: null, lines: [], restock: [], trades: [], fed: 0, milked: 0, kits: 0, herd: [] };
    const mine = m => m && m.village && m.village.key === R.key;
    const oLog = BF.vlog.log;
    BF.vlog.log = function (rec, kind, text) { if (rec && rec.key === R.key) R.lines.push([+(BF.sky.day + BF.sky.time).toFixed(3), kind, String(text)]); return oLog.apply(this, arguments); };
    const oTrade = BF.vlog.trade;   // villager <-> villager trades: what changed hands (offers, or "gave N Emerald, got M <item>" fair-price deals)
    BF.vlog.trade = function (buyer, seller, o, times) {
      if (buyer && buyer !== 'player' && mine(buyer)) {
        let item = null, n = 0;
        if (o && o.sell) { item = BF.items[o.sell.id].name; n = o.sell.n * (times || 1); }
        else if (typeof o === 'string') { const m = /got (\d+) (.+)$/.exec(o); if (m) { n = +m[1]; item = m[2]; } }
        if (item) R.trades.push([buyer.profession, seller && seller.profession, item, n]);
      }
      return oTrade.apply(this, arguments);
    };
    BF.on('cowFed', (m, by) => { if (by && by.profession === 'cowherd' && mine(by)) R.fed++; });
    BF.on('cowMilked', (m, by) => { if (by && by.profession === 'cowherd' && mine(by)) R.milked++; });
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
    // the village's holdings of the watched items: its villagers' packs and the chests within 80 blocks of its centre
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
    window.__herder = () => window.__villagers().find(m => m.profession === 'cowherd');
    window.__count = (m, n) => (m ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
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
      const h = window.__herder(), P = h && BF.cowherd.pastureOf(h);
      return { key, pop: v.pop, herder: !!h, pasture: P ? { cows: P.cows ? P.cows.length : null, limit: P.limit, cells: P.cells } : null };
    }, v);
    if (r.herder && r.pasture && r.pasture.cows >= 2) { setup = r; break; }
    console.log(`seed ${SEED} village ${r.key} pop ${r.pop}: skipped ${JSON.stringify(r)}`);
  }
  if (!setup) { console.log('FAIL no village with a cowherd and a stocked pasture among the nearest ' + cands.length); await b.close(); process.exitCode = 1; return; }
  await pg.evaluate(() => {
    const R = window.__rec, h = window.__herder();
    R.lines.length = 0; R.restock.length = 0; R.trades.length = 0; R.fed = 0; R.milked = 0; R.kits = 0;
    R.start = window.__total();
    R.herderStart = { bucket: window.__count(h, 'bucket') + window.__count(h, 'milk_bucket'), wheat: window.__count(h, 'wheat_item') };
    R.herder = h;
  });
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}: pasture ${JSON.stringify(setup.pasture)}`);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), PER = Math.round(200 / h);
  const t0 = Date.now();
  for (let s = 0; s < total; s += PER) {
    await pg.evaluate(([n, h, key, LEAN]) => {
      const [x, z] = key.split(',').map(Number);
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
      }
      const R = window.__rec, hd = R.herder, P = hd && !hd.dead ? BF.cowherd.pastureOf(hd) : null, d = BF.sky.day + BF.sky.time;
      if (!R.lean && d >= LEAN) {   // the lean day starts: food (all but milk) put away
        R.lean = [];
        const milk = id => id === BF.I.milk_bottle || id === BF.I.milk_bucket;
        for (const m of window.__villagers()) if (m.profession !== 'cowherd') for (let i = 0; i < m.inv.length; i++) { const st = m.inv[i]; if (st && BF.food.isFood(st.id) && !milk(st.id)) { R.lean.push([m, st.id, st.count]); m.inv[i] = null; } }
        R.leanN = R.lean.reduce((a, x) => a + x[2], 0);
      } else if (R.lean && !R.leanBack && d >= LEAN + 1) {   // ... and comes back
        R.leanBack = true;
        for (const [m, id, n] of R.lean) if (!m.dead) BF.trades.inv.add(m.inv, id, n);
      }
      // the herd, and empty bottles other villagers hold while the cowherd is short of them
      const stranded = window.__villagers().filter(m => m.profession !== 'cowherd').reduce((a, m) => Math.max(a, window.__count(m, 'glass_bottle')), 0);
      R.herd.push([+(BF.sky.day + BF.sky.time).toFixed(2), P && P.cows ? P.cows.length : null, P && P.cows ? P.cows.filter(c => c.growAt != null).length : null, P ? P.culls : null,
        window.__count(hd, 'glass_bottle'), stranded]);
    }, [Math.min(PER, total - s), h, setup.key, LEAN]);
    if ((s / PER) % 24 === 23) console.log(`  day ${((s + PER) * h / 1200).toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const R = await pg.evaluate(() => {
    const R = window.__rec, hd = R.herder, P = BF.cowherd.pastureOf(hd);
    R.end = window.__total();
    R.herderEnd = { bucket: window.__count(hd, 'bucket') + window.__count(hd, 'milk_bucket'), wheat: window.__count(hd, 'wheat_item'), alive: !hd.dead,
      inv: hd.inv.filter(Boolean).map(s => BF.items[s.id].name + ':' + s.count).join(' ') };
    const FU = BF.furnaceUse, VR = BF.mobs.villages.get(R.key);
    R.furnaces = [...FU.furnaces.values()].filter(f => Math.hypot(f.x + 0.5 - VR.x, f.z + 0.5 - VR.z) <= FU.reachOf(VR) + 8).length;   // furnaces the village's villagers may use
    R.pasture = P ? { cows: P.cows.length, calves: P.cows.filter(c => c.growAt != null).length, limit: P.limit, culls: P.culls } : null;
    R.events = BF.cowherd.log.filter(e => e.kind === 'bred' || e.kind === 'culled' || e.kind === 'stocked' || e.kind === 'joined' || e.kind === 'left').map(e => e.kind[0] + (e.herd != null ? e.herd : '') + '@' + e.day.toFixed(2)).join(' ');
    R.log = Object.entries(BF.cowherd.log.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {})).map(([k, n]) => k + ':' + n).join(' ');
    R.holders = {};
    for (const n of ['milk_bottle', 'glass_bottle', 'leather', 'raw_beef', 'steak']) R.holders[n] = window.__villagers().filter(m => window.__count(m, n) > 0).map(m => m.profession + ':' + window.__count(m, n)).join(' ');
    delete R.herder; delete R.lean;
    return R;
  });
  // ---- the ledger from the village log
  const sum = (re, f = m => +m[1]) => R.lines.reduce((n, l) => { const m = re.exec(l[2]); return n + (m ? f(m) : 0); }, 0);
  const culls = sum(/\(Cowherd\) culled a cow/, () => 1), beef = sum(/\(Cowherd\) culled a cow .*: (\d+) raw beef/), leather = sum(/\(Cowherd\) culled a cow .* (\d+) leather/);
  const bottled = sum(/\(Cowherd\) bottled (\d+) milk bottles?/), steak = sum(/\(Cowherd\) cooked (\d+) steak/), calves = sum(/A calf was born in the pasture/, () => 1);
  const fetched = sum(/brought a wild cow into the pasture/, () => 1);
  const traded = (pred) => R.trades.filter(pred).reduce((t, x) => t + x[3], 0);
  const isGB = x => /^glass[ _]bottle$/i.test(x[2]), isMilk = x => /^milk[ _]bottle$/i.test(x[2]);
  const bottlesBack = traded(x => x[0] === 'cowherd' && isGB(x)), milkSold = traded(x => x[1] === 'cowherd' && x[0] !== 'cowherd' && isMilk(x));
  const wheatBought = traded(x => x[0] === 'cowherd' && /^wheat/i.test(x[2])), bucketsBought = traded(x => x[0] === 'cowherd' && /^bucket$/i.test(x[2]));
  const leatherToLw = traded(x => x[0] === 'leatherworker' && /^leather$/i.test(x[2]));
  const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  const sizes = R.herd.map(x => x[1]).filter(x => x != null), start = setup.pasture ? setup.pasture.cows : sizes[0],   // before the first day: the first sample may already hold calves
        lim = R.pasture ? R.pasture.limit : 0;
  const firstFull = sizes.findIndex(x => x >= lim), after = firstFull >= 0 ? sizes.slice(firstFull) : [];
  const stuck = R.herd.filter(x => x[4] < 9 && x[5] >= 9).length;   // samples where some villager held a full lot of empties while the cowherd was short
  console.log('start', JSON.stringify(R.start), 'end', JSON.stringify(R.end));
  console.log('made', JSON.stringify({ culls, beef, leather, milked: R.milked, bottled, steak, calves, fetched, fed: R.fed, kits: R.kits }));
  console.log('trades', JSON.stringify({ bottlesBack, milkSold, wheatBought, bucketsBought, leatherToLw }));
  console.log('pasture', JSON.stringify(R.pasture), 'herd sizes', JSON.stringify(sizes.filter((x, i) => i % 6 === 0)), 'log', R.log);
  console.log('cowherd', JSON.stringify(R.herderStart), '->', JSON.stringify(R.herderEnd));
  console.log('holders', JSON.stringify(R.holders));
  console.log('herd events (b = bred, c = culled, s = stocked, j = walked in, l = got out; herd size after)', R.events);
  ok('the cowherd stayed alive', R.herderEnd.alive);
  ok('the herd grew: calves were born', calves > 0 && Math.max(...sizes) > start, { start, max: Math.max(...sizes), calves });
  ok('the herd reached the pasture limit', firstFull >= 0, { limit: lim, max: Math.max(...sizes) });
  const bredOver = R.lines.map(l => /A calf was born in the pasture \((\d+) cows?\)/.exec(l[2])).filter(Boolean).map(m => +m[1]).filter(n => n > lim + 1);   // herd size after each birth
  ok('and was held there: culled back to it, never more than one over it by breeding', culls > 0 && bredOver.length === 0 && after.every(x => x <= lim + 2) && R.pasture.cows <= lim + 1,
    { culls, limit: lim, bredOver, maxAfter: Math.max(...after), end: R.pasture && R.pasture.cows });   // + 2: a wild cow may slip in while the gate is open
  ok('the cowherd milked its cows and bottled the milk', R.milked > 0 && bottled > 0, { milked: R.milked, bottled });
  if (R.furnaces) ok('the cowherd cooked beef into steak in a furnace', steak > 0, { steak, furnaces: R.furnaces });
  else ok('no furnace in the village: no steak cooked, the beef kept raw (test/cowherd-actions.js cooks it in one)', steak === 0, { steak, furnaces: R.furnaces });
  ok('the restock created none of the watched items', R.restock.length === 0, R.restock.slice(0, 5));
  ok('no beef from nothing (raw beef and steak only from culls)', R.end.raw_beef + R.end.steak <= R.start.raw_beef + R.start.steak + beef, [R.start.raw_beef + R.start.steak, beef, R.end.raw_beef + R.end.steak]);
  ok('no leather from nothing (only from culls)', R.end.leather <= R.start.leather + leather, [R.start.leather, leather, R.end.leather]);
  ok('no milk from nothing (3 bottles a milking at most)', R.end.milk_bottle + 3 * R.end.milk_bucket <= R.start.milk_bottle + 3 * R.start.milk_bucket + 3 * R.milked, [R.start.milk_bottle, R.milked, R.end.milk_bottle, R.end.milk_bucket]);
  ok('no glass bottles from nothing (only hire kits)', R.end.glass_bottle + R.end.milk_bottle <= R.start.glass_bottle + R.start.milk_bottle + 30 * R.kits, [R.start.glass_bottle + R.start.milk_bottle, R.kits, R.end.glass_bottle + R.end.milk_bottle]);
  ok("no buckets from nothing for the cowherd (kit and purchases only)", R.herderEnd.bucket <= R.herderStart.bucket + bucketsBought + R.kits, [R.herderStart.bucket, bucketsBought, R.herderEnd.bucket]);
  ok('no wheat from nothing for the cowherd (bought, then fed)', R.herderEnd.wheat <= R.herderStart.wheat + wheatBought - R.fed, [R.herderStart.wheat, wheatBought, R.fed, R.herderEnd.wheat]);
  ok('the cowherd fed its cows wheat it bought', R.fed > 0 && wheatBought > 0, { fed: R.fed, wheatBought });
  ok('empty bottles flow back: none pile up with a villager while the cowherd is short', stuck <= 1, { stuck, bottlesBack, milkSold });
  ok('on the lean day hungry villagers bought milk from the cowherd', milkSold > 0, { milkSold, putAway: R.leanN });
  ok('the empty bottles came back: the cowherd bought them from the village', bottlesBack > 0, { milkSold, bottlesBack });
  if (pageErrors) ok('no page errors', false, pageErrors);
  console.log(`ran ${DAYS} days in ${Math.round((Date.now() - t0) / 1000)} s`);
  await b.close();
})();
