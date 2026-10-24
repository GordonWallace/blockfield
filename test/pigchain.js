// Pig economy soak (js/pigfarmer.js, board idea-042): one village with a pig farmer and a stocked generated sty runs for N game days (no
// rendering, like test/cowchain.js) and checks:
//  - the herd grows (fed pigs breed) and is held at the sty's limit (one pig per 8 cells): the pig farmer culls past it, never below 2 adults;
//  - pork comes only from the pigs: the daily restock never gives anyone raw or cooked porkchops (nor pig feed), and the village's porkchops
//    (packs and chests within 80 blocks) never exceed what it held at the start plus what the culls gave (from the village log);
//  - nothing from nothing for the pig farmer: the feed it fed is feed it held at the start or bought (it never holds more than that, minus what it
//    fed), and the fuel it burns is fuel it held or bought;
//  - it bought its feed from the village, and cooked pork in a furnace when the village has one.
// Usage: NODE_PATH=$(npm root -g) node test/pigchain.js [days=14] [seed=1]
// @ci integration suite=farming soak timeout=1800 args=14,1 hosts=worker,server
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
  await require('./lib').install(pg);
  // BF_HOST (spec r15-43): page, as before (index.html as a file); worker or server: served by debug/server.js, the simulation there
  const lib = require('./lib'), host = lib.host(), srv = host === 'page' ? null : await lib.serve({ world: host === 'server' });
  await pg.goto(srv ? srv.url + '?nolod&' + lib.q() + '#seed' + SEED : 'file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await require('./lib').ready(pg);   // the planet (spec r14-22): its river step first
  if (srv) {   // the host has started (a worker only after the page's river step), then its world
    await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
    console.log('host ' + host + ': ' + (await lib.where(pg)).label);
    await lib.simReady(pg);
  }
  await lib.simBFT(pg);   // (BFT where the simulation is)
  await pg.waitForTimeout(3000);
  // the nearest villages (within 3000 blocks of the spawn) that have a sty
  await pg.evaluate(() => { window.__halt = true; });   // the page's frames stop: the test steps the simulation itself
  const cands = await lib.sim(pg, () => {
    if (!BF.page) BF.state.paused = true;   // (off the page, its own loop stops too)
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    return BFT.villages(3000).filter(v => v && v.pop && (v.buildings || []).some(x => x.type === 'sty')).slice(0, 6).map(v => ({ x: v.x, y: v.y, z: v.z, pop: v.pop }));
  });
  await lib.sim(pg, () => {
    const WATCH = globalThis.__WATCH = ['raw_porkchop', 'cooked_porkchop', 'carrot', 'potato', 'beetroot'];
    const FUEL = globalThis.__FUEL = id => { const n = BF.items[id] && BF.items[id].name; return !!n && (n === 'coal' || n === 'charcoal' || /_log$|planks$/.test(n)) && !/^stripped/.test(n); };
    const R = globalThis.__rec = { key: null, lines: [], restock: [], trades: [], fed: 0, herd: [] };
    const mine = m => m && m.village && m.village.key === R.key;
    const oLog = BF.vlog.log;
    BF.vlog.log = function (rec, kind, text) { if (rec && rec.key === R.key) R.lines.push([+(BF.sky.day + BF.sky.time).toFixed(3), kind, String(text)]); return oLog.apply(this, arguments); };
    const oTrade = BF.vlog.trade;   // villager <-> villager trades: what changed hands
    BF.vlog.trade = function (buyer, seller, o, times) {
      if (buyer && buyer !== 'player' && mine(buyer)) {
        let item = null, n = 0, id = null;
        if (o && o.sell) { id = o.sell.id; item = BF.items[id].name; n = o.sell.n * (times || 1); }
        else if (typeof o === 'string') { const m = /got (\d+) (.+)$/.exec(o); if (m) { n = +m[1]; item = m[2]; } }
        if (item) R.trades.push([buyer.profession, seller && seller.profession, item, n, id != null && FUEL(id) ? 1 : 0]);
      }
      return oTrade.apply(this, arguments);
    };
    BF.on('pigFed', (m, by) => { if (by && by.profession === 'pig_farmer' && mine(by)) R.fed++; });
    const oRestock = BF.trades.restock;
    BF.trades.restock = function (m) {
      const cnt = () => WATCH.map(n => m && Array.isArray(m.inv) ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
      const before = cnt(), r = oRestock.apply(this, arguments), after = cnt();
      WATCH.forEach((n, i) => { if (after[i] > before[i]) R.restock.push([m.profession, n, after[i] - before[i]]); });
      return r;
    };
    globalThis.__villagers = () => BF.mobs.list.filter(m => m.type === 'villager' && mine(m) && !m.dead && Array.isArray(m.inv));
    globalThis.__total = () => {
      const out = {}, I = BF.I, [cx, cz] = R.key.split(',').map(Number), ms = globalThis.__villagers();
      for (const n of WATCH) {
        let t = 0;
        for (const m of ms) t += BF.trades.inv.count(m.inv, I[n]);
        for (const c of BF.inventory.chests.values()) if (Math.hypot(c.pos.x - cx, c.pos.z - cz) < 80) for (const s of c.slots) if (s && s.id === I[n]) t += s.count;
        out[n] = t;
      }
      return out;
    };
    globalThis.__pf = () => globalThis.__villagers().find(m => m.profession === 'pig_farmer');
    globalThis.__count = (m, n) => (m ? BF.trades.inv.count(m.inv, BF.I[n]) : 0);
    globalThis.__fuel = m => (m ? m.inv.filter(s => s && FUEL(s.id)).reduce((a, s) => a + s.count, 0) : 0);
  });
  let setup = null;
  for (const v of cands) {
    const r = await lib.sim(pg, v => {
      const key = globalThis.__rec.key = Math.round(v.x) + ',' + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      BF.sky.setTime(0.02);
      for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
      const h = globalThis.__pf(), P = h && BF.pigFarmer.styOf(h);
      return { key, pop: v.pop, pf: !!h, sty: P ? { pigs: P.pigs ? P.pigs.length : null, limit: P.limit, cells: P.cells } : null };
    }, v);
    if (r.pf && r.sty && r.sty.pigs >= 2) { setup = r; break; }
    console.log(`seed ${SEED} village ${r.key} pop ${r.pop}: skipped ${JSON.stringify(r)}`);
  }
  if (!setup) { console.log('FAIL no village with a pig farmer and a stocked sty among the nearest ' + cands.length); await b.close(); if (srv) await srv.stop(); process.exitCode = 1; return; }
  await lib.sim(pg, () => {
    const R = globalThis.__rec, h = globalThis.__pf();
    R.lines.length = 0; R.restock.length = 0; R.trades.length = 0; R.fed = 0;
    R.start = globalThis.__total();
    R.pfStart = { feed: BF.pigFarmer.feedHeld(h), fuel: globalThis.__fuel(h) };
    R.pf = h;
  });
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}: sty ${JSON.stringify(setup.sty)}`);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), PER = Math.round(200 / h);
  const t0 = Date.now();
  for (let s = 0; s < total; s += PER) {
    await lib.sim(pg, ([n, h, key]) => {
      const [x, z] = key.split(',').map(Number);
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
      }
      const R = globalThis.__rec, pf = R.pf, P = pf && !pf.dead ? BF.pigFarmer.styOf(pf) : null;
      R.herd.push([+(BF.sky.day + BF.sky.time).toFixed(2), P && P.pigs ? P.pigs.length : null, P && P.pigs ? P.pigs.filter(c => c.growAt == null).length : null, P ? P.culls : null, BF.pigFarmer.feedHeld(pf)]);
    }, [Math.min(PER, total - s), h, setup.key]);
    if ((s / PER) % 24 === 23) console.log(`  day ${((s + PER) * h / 1200).toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const R = await lib.sim(pg, () => {
    const R = globalThis.__rec, pf = R.pf, P = BF.pigFarmer.styOf(pf);
    R.end = globalThis.__total();
    R.pfEnd = { feed: BF.pigFarmer.feedHeld(pf), fuel: globalThis.__fuel(pf), alive: !pf.dead, inv: pf.inv.filter(Boolean).map(s => BF.items[s.id].name + ':' + s.count).join(' ') };
    const FU = BF.furnaceUse, VR = BF.mobs.villages.get(R.key);
    R.dead = (VR.deadInfo || []).map(d => [d.prof, d.cause, d.day]);   // who died in the village, and of what
    R.furnaces = [...FU.furnaces.values()].filter(f => Math.hypot(f.x + 0.5 - VR.x, f.z + 0.5 - VR.z) <= FU.reachOf(VR) + 8).length;
    R.sty = P ? { pigs: P.pigs.length, piglets: P.pigs.filter(c => c.growAt != null).length, limit: P.limit, culls: P.culls } : null;
    R.events = BF.pigFarmer.log.filter(e => e.kind === 'bred' || e.kind === 'culled' || e.kind === 'stocked' || e.kind === 'joined' || e.kind === 'left').map(e => e.kind[0] + (e.herd != null ? e.herd : '') + '@' + e.day.toFixed(2)).join(' ');
    R.log = Object.entries(BF.pigFarmer.log.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {})).map(([k, n]) => k + ':' + n).join(' ');
    R.holders = {};
    for (const n of ['raw_porkchop', 'cooked_porkchop']) R.holders[n] = globalThis.__villagers().filter(m => globalThis.__count(m, n) > 0).map(m => m.profession + ':' + globalThis.__count(m, n)).join(' ');
    delete R.pf;
    return R;
  });
  // ---- the ledger from the village log
  const sum = (re, f = m => +m[1]) => R.lines.reduce((n, l) => { const m = re.exec(l[2]); return n + (m ? f(m) : 0); }, 0);
  const culls = sum(/\(Pig Farmer\) culled a pig/, () => 1), pork = sum(/\(Pig Farmer\) culled a pig .*: (\d+) raw porkchops?/);
  const cooked = sum(/\(Pig Farmer\) cooked (\d+) porkchops? in the furnace/), piglets = sum(/A piglet was born in the sty/, () => 1);
  const fetched = sum(/brought a wild pig into the sty/, () => 1);
  const traded = pred => R.trades.filter(pred).reduce((t, x) => t + x[3], 0);
  const feedBought = traded(x => x[0] === 'pig_farmer' && /^(carrot|potato|beetroot)$/i.test(x[2]));
  const fuelBought = traded(x => x[0] === 'pig_farmer' && x[4] === 1);
  const porkToButcher = traded(x => x[0] === 'butcher' && x[1] === 'pig_farmer');
  const porkSold = traded(x => x[1] === 'pig_farmer' && /porkchop/i.test(x[2]));
  const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  const sizes = R.herd.map(x => x[1]).filter(x => x != null), start = setup.sty ? setup.sty.pigs : sizes[0], lim = R.sty ? R.sty.limit : 0;
  const firstFull = sizes.findIndex(x => x >= lim), after = firstFull >= 0 ? sizes.slice(firstFull) : [];
  const minAdults = Math.min(...R.herd.filter((x, i) => i >= 3).map(x => x[2]).filter(x => x != null));
  console.log('start', JSON.stringify(R.start), 'end', JSON.stringify(R.end));
  console.log('made', JSON.stringify({ culls, pork, cooked, piglets, fetched, fed: R.fed }));
  console.log('trades', JSON.stringify({ feedBought, fuelBought, porkSold, porkToButcher }));   // pork sold to the village and the butcher (the economy view's flow)
  console.log('sty', JSON.stringify(R.sty), 'herd sizes', JSON.stringify(sizes.filter((x, i) => i % 6 === 0)), 'log', R.log);
  console.log('pig farmer', JSON.stringify(R.pfStart), '->', JSON.stringify(R.pfEnd));
  console.log('holders', JSON.stringify(R.holders));
  console.log('herd events (b = bred, c = culled, s = stocked, j = walked in, l = got out; herd size after)', R.events);
  if (R.dead.length) console.log('died', JSON.stringify(R.dead));
  ok('the pig farmer stayed alive', R.pfEnd.alive, R.dead.filter(d => d[0] === 'pig_farmer'));
  ok('the herd grew: piglets were born', piglets > 0 && Math.max(...sizes) > start, { start, max: Math.max(...sizes), piglets });
  ok('the herd reached the sty limit', firstFull >= 0, { limit: lim, max: Math.max(...sizes) });
  const bredOver = R.lines.map(l => /A piglet was born in the sty \((\d+) pigs?\)/.exec(l[2])).filter(Boolean).map(m => +m[1]).filter(n => n > lim + 1);
  ok('and was held there: culled back to it, never more than one over it by breeding', culls > 0 && bredOver.length === 0 && after.every(x => x <= lim + 2) && R.sty.pigs <= lim + 1,
    { culls, limit: lim, bredOver, maxAfter: Math.max(...after), end: R.sty && R.sty.pigs });   // + 2: a wild pig may slip in while the gate is open
  ok('never culled below 2 adults', minAdults >= 2, minAdults);
  if (R.furnaces) ok('the pig farmer cooked pork in a furnace with fuel it bought', cooked > 0 && fuelBought + R.pfStart.fuel > 0, { cooked, fuelBought, fuel0: R.pfStart.fuel, furnaces: R.furnaces });
  else ok('no furnace in the village: no pork cooked', cooked === 0, { cooked, furnaces: R.furnaces });
  ok('the restock created no pork and no pig feed', R.restock.filter(x => /porkchop/.test(x[1]) || x[0] === 'pig_farmer').length === 0, R.restock.slice(0, 5));
  ok('no pork from nothing (raw and cooked porkchops only from culls)', R.end.raw_porkchop + R.end.cooked_porkchop <= R.start.raw_porkchop + R.start.cooked_porkchop + pork, [R.start.raw_porkchop + R.start.cooked_porkchop, pork, R.end.raw_porkchop + R.end.cooked_porkchop]);
  ok('no feed from nothing for the pig farmer (held or bought, then fed)', R.pfEnd.feed <= R.pfStart.feed + feedBought - R.fed, [R.pfStart.feed, feedBought, R.fed, R.pfEnd.feed]);
  ok('no fuel from nothing for the pig farmer', R.pfEnd.fuel <= R.pfStart.fuel + fuelBought, [R.pfStart.fuel, fuelBought, R.pfEnd.fuel]);
  ok('the pig farmer fed its pigs feed it bought', R.fed > 0 && feedBought > 0, { fed: R.fed, feedBought });
  if (pageErrors) ok('no page errors', false, pageErrors);
  console.log(`ran ${DAYS} days in ${Math.round((Date.now() - t0) / 1000)} s`);
  await b.close(); if (srv) await srv.stop();
})();
