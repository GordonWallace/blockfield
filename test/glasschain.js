// @ci integration suite=jobs soak timeout=1800 args=15,1
// Glassmaking soak (js/glassmaker.js): a sand village with a glassmaker runs for N game days (no rendering, like test/bakechain.js) and checks:
//  - the glassmaker digs sand, smelts it into glass and makes panes or bottles; never more than a stack of sand dug in one day;
//  - its glass came only from sand it held, dug or bought (1 glass a sand);
//  - nothing from nothing: the daily restock never gives anyone sand, glass, panes or bottles; the village's glass (a pane is 6/16, a bottle
//    or milk bottle is 1) never exceeds the start plus what was smelted, cowherd hire kits (30 bottles) and goods brought from other villages;
//  - the dug spots stay walkable: air where the sand was, a solid block under it, no water in it.
// Usage: NODE_PATH=$(npm root -g) node test/glasschain.js [days=15] [seed=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const DAYS = +(process.argv[2] || 15), SEED = +(process.argv[3] || 1);

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
  // the nearest sand villages
  const cands = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    return BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop >= 8 && BF.worldgen.sandNear(Math.round(v.x), Math.round(v.z), 64))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 8).map(v => ({ x: v.x, y: v.y, z: v.z, pop: v.pop }));
  });
  await pg.evaluate(() => {
    const WATCH = window.__WATCH = ['sand', 'glass', 'glass_pane', 'glass_bottle', 'milk_bottle'];
    const R = window.__rec = { key: null, lines: [], restock: [], trades: [], kits: 0, status: {} };
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
    window.__glassTotal = () => {   // packs and chests within 80 blocks, and the furnaces' output, in glass blocks
      const I = BF.I, [cx, cz] = R.key.split(',').map(Number), w = { glass: 1, glass_pane: 6 / 16, glass_bottle: 1, milk_bottle: 1 };
      let t = 0;
      const add = s => { if (s) for (const n in w) if (s.id === I[n]) t += s.count * w[n]; };
      for (const m of window.__villagers()) m.inv.forEach(add);
      for (const c of BF.inventory.chests.values()) if (Math.hypot(c.pos.x - cx, c.pos.z - cz) < 80) c.slots.forEach(add);
      if (BF.inventory.furnaces) for (const f of BF.inventory.furnaces.values()) if (f.pos && Math.hypot(f.pos.x - cx, f.pos.z - cz) < 80) f.slots.slice(2).forEach(add);
      return t;
    };
    window.__gm = () => window.__villagers().find(m => m.profession === 'glassmaker' && m.jobsite);
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
      return { key, pop: v.pop, glassmaker: !!window.__gm() };
    }, v);
    if (r.glassmaker) { setup = r; break; }
    console.log(`seed ${SEED} village ${r.key} pop ${r.pop}: no glassmaker`);
  }
  if (!setup) { console.log('FAIL no sand village with a glassmaker among the nearest ' + cands.length); await b.close(); process.exitCode = 1; return; }
  await pg.evaluate(() => {
    const R = window.__rec, gm = window.__gm();
    R.lines.length = 0; R.restock.length = 0; R.trades.length = 0; R.kits = 0;
    BF.glassmaker.LOG.length = 0;
    R.start = window.__glassTotal(); R.sandStart = BF.trades.inv.count(gm.inv, BF.I.sand); R.gm = gm;
  });
  console.log(`seed ${SEED} village ${setup.key} pop ${setup.pop}`);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), PER = Math.round(200 / h);
  const t0 = Date.now();
  for (let s = 0; s < total; s += PER) {
    await pg.evaluate(([n, h, key]) => {
      const [x, z] = key.split(',').map(Number), R = window.__rec;
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
        if (i % 200 === 0) { const st = BF.glassmaker.statusText(R.gm); if (st) R.status[st] = (R.status[st] || 0) + 1; }
      }
    }, [Math.min(PER, total - s), h, setup.key]);
    if ((s / PER) % 24 === 23) console.log(`  day ${((s + PER) * h / 1200).toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const R = await pg.evaluate(() => {
    const R = window.__rec, gm = R.gm, W = BF.world, B = BF.B;
    R.end = window.__glassTotal();
    R.gmEnd = { alive: !gm.dead, holdings: BF.glassmaker.holdings(gm) };
    R.digs = BF.glassmaker.LOG.filter(e => e.kind === 'dig');
    const solid = id => id && BF.blocks[id] && BF.blocks[id].solid !== false && !BF.blocks[id].fluid;
    R.badSpots = R.digs.filter(e => { const [x, y, z] = e.at; const at = W.getBlock(x, y, z), under = W.getBlock(x, y - 1, z); return !(at === B.air || at === 0) || !solid(under); }).map(e => e.at);
    delete R.gm;
    return R;
  });
  const traded = pred => R.trades.filter(pred).reduce((t, x) => t + x[3], 0);
  const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  const smelted = R.lines.reduce((t, l) => { const m = /\(Glassmaker\) smelted (\d+) glass/.exec(l[2]); return t + (m ? +m[1] : 0); }, 0);
  const made = R.lines.filter(l => /\(Glassmaker\) made \d+ glass (pane|bottle)/.test(l[2])).length;
  const dug = R.digs.reduce((t, e) => t + e.n, 0), perDay = {};
  for (const e of R.digs) perDay[Math.floor(e.day)] = (perDay[Math.floor(e.day)] || 0) + e.n;
  const bought = traded(x => x[0] === 'glassmaker' && x[2] === 'sand');
  const broughtIn = traded(x => !x[4] && x[0] !== 'glassmaker' && /^(glass|glass_pane|glass_bottle|milk_bottle)$/.test(x[2]));
  console.log('glassmaker', JSON.stringify(R.gmEnd), '| dug', dug, 'per day', JSON.stringify(perDay), '| bought sand', bought, '| smelted', smelted, '| craft lines', made);
  console.log('status samples', JSON.stringify(R.status));
  console.log('glass totals start', R.start.toFixed(1), 'end', R.end.toFixed(1), 'kits', R.kits, 'brought in', broughtIn);
  console.log('first lines', JSON.stringify(R.lines.filter(l => /Glassmaker/.test(l[2])).slice(0, 8)));
  ok('the glassmaker stayed alive', R.gmEnd.alive);
  ok('it dug sand', dug > 0, dug);
  ok('never more than a stack dug in a day', Object.values(perDay).every(n => n <= 64), perDay);
  ok('it smelted glass', smelted > 0, smelted);
  ok('it made panes or bottles', made > 0, made);
  ok('glass only from sand it held, dug or bought', smelted <= R.sandStart + dug + bought, [R.sandStart, dug, bought, smelted]);
  ok('the restock created no sand, glass, panes or bottles', R.restock.length === 0, R.restock.slice(0, 5));
  ok('no glass from nothing', R.end <= R.start + smelted + 30 * R.kits + broughtIn + 1e-6, [+R.start.toFixed(1), smelted, R.kits, broughtIn, +R.end.toFixed(1)]);
  ok('dug spots are open and walkable', R.badSpots.length === 0, R.badSpots.slice(0, 5));
  if (pageErrors) ok('no page errors', false, pageErrors);
  console.log(`ran ${DAYS} days in ${Math.round((Date.now() - t0) / 1000)} s`);
  await b.close();
})();
