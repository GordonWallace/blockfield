// Trading caravans soak (release 1.3): two villages between 60 and 200 blocks apart, both with merchants, for many game days.
// Usage: NODE_PATH=$(npm root -g) node test/caravan-soak.js [seed=1] [days=14] [out.json] [far]
// far (or FAR=1): a pair 450-590 blocks apart (caravan range is 600), the player visits both, then stays at the one with a merchant. The home village's prices are pushed down to make a real price gap (the natural one takes many days to grow); checked: 2 or more trips out and home, and a trade at the far village.
// Drives the simulation directly (no rendering), like test/prices-soak.js. The player stands between the two villages, then from day AWAY
// (default: two thirds of the way), as soon as a merchant is on the road, walks 1500 blocks off and stays there, so trips on the road must keep both villages and the route loaded (pins).
// Once per game day it records each village's villagers, emeralds and items, the merchants' trips (out and home), goods sold each way, pins,
// and path blocks made. FAILs on a page error, a villager trade made without an offer, no goods carried each way, a trip that left a pin
// behind, more than 2 trips on the road, or a merchant who never came home. Prices take about 10 game days to drift far enough apart for a
// trip to pay (js/prices.js: a month to double), so run 30 days; a dirt path needs 20 crossings, so it is only required after 10 trips.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 1);
const DAYS = +(process.argv[3] || 14);
const OUT = process.argv[4] || null;
const FAR = !!process.env.FAR || process.argv[5] === 'far', LO = +(process.env.LO || (FAR ? 450 : 60)), HI = +(process.env.HI || (FAR ? 590 : 190));
const AWAY = +(process.env.AWAY || Math.ceil(DAYS * 2 / 3));

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let pageErrors = 0;
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.addInitScript(d => { window.__DIAG = d; }, !!process.env.DIAG);
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await pg.waitForTimeout(3000);
  await pg.evaluate(c => { window.__C = c; }, { LO, HI, FAR });
  const setup = await pg.evaluate(() => {
    window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const vs = BF.worldgen.villagesNear(0, 0, 4000).filter(v => v && v.pop >= 8).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    let pair = null;
    for (let i = 0; i < vs.length && !pair; i++) for (let j = i + 1; j < vs.length && !pair; j++) {
      const d = Math.hypot(vs[i].x - vs[j].x, vs[i].z - vs[j].z);
      if (d >= __C.LO && d <= __C.HI) pair = [vs[i], vs[j], d];
    }
    if (!pair) return { err: 'no pair of villages ' + __C.LO + '-' + __C.HI + ' blocks apart' };
    let [A, B, d] = pair, mx = __C.FAR ? A.x : (A.x + B.x) / 2, mz = __C.FAR ? A.z : (A.z + B.z) / 2;
    if (__C.FAR) {   // far pair: the player visits both villages (so the merchants know the other one's prices), then goes back to the one with a merchant
      const warm = V => {
        BF.player.spawn(V.x + 0.5, BF.worldgen.heightAt(Math.floor(V.x), Math.floor(V.z)) + 3, V.z + 0.5);
        for (let i = 0; i < 400; i++) { BF.world.update(V.x, V.z, 60); if (i % 4 === 0) { BF.warp.advance(0.05); BF.sky.update(0.05); BF.mobs.update(0.05); BF.world.tickSim(); } }
      };
      const keyOf = V => Math.round(V.x) + ',' + Math.round(V.z), has = [];
      const books = {};
      for (const V of [A, B]) {
        warm(V);
        const rec = BF.mobs.villages.get(keyOf(V)), mer = BF.mobs.list.find(m => m.type === 'villager' && m.profession === 'merchant' && m.village === rec);
        has.push(!!mer);
        const bk = BF.merchant.book(rec, mer || null);
        books[keyOf(V)] = { sells: [...bk.sells.keys()], buys: [...bk.buys.keys()] };
      }
      if (!has[0]) [A, B] = [B, A];
      mx = A.x; mz = A.z;
      // a real price gap (the natural one takes many days to grow): the home village sells what the far village buys at half price, with plenty in stock
      const homeK = keyOf(A), farK = keyOf(B), ids = books[homeK].sells.filter(id => books[farK].buys.includes(id)).slice(0, 12);
      window.__gapIds = ids;
      warm(B);   // the far village pays the most it can for them
      const farRec = BF.mobs.villages.get(farK);
      for (const v of BF.mobs.list) if (v.type === 'villager' && v.village === farRec && v.trades) for (const o of v.trades) if (BF.prices.kind(o) === 'buy' && ids.includes(o.buy[0].id)) { o.step = 30; BF.prices.reprice(v, o); }
      BF.merchant.remember(farRec, true);
      warm(A);
      window.__stockHome = () => {   // home sellers sell what the far village buys at half price, with plenty in stock (done once a day)
        const rec = BF.mobs.villages.get(homeK);
        for (const v of BF.mobs.list) if (v.type === 'villager' && v.village === rec && v.trades) for (const o of v.trades) {
          if (BF.prices.kind(o) === 'sell' && ids.includes(o.sell.id)) { o.step = -30; BF.prices.reprice(v, o); if (v.inv && BF.trades.inv.count(v.inv, o.sell.id) < 60) BF.trades.inv.add(v.inv, o.sell.id, 60); }
        }
      };
      window.__stockHome();
    }
    window.__mid = [mx, mz];
    BF.player.spawn(mx + 0.5, BF.worldgen.heightAt(Math.floor(mx), Math.floor(mz)) + 3, mz + 0.5);
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 900; i++) { BF.world.update(mx, mz, 60); if (i % 4 === 0) step(0.05); }
    BF.sky.setTime(0.02);
    for (let i = 0; i < 200; i++) { BF.world.update(mx, mz, 30); step(0.05); }
    const keys = [A, B].map(v => Math.round(v.x) + ',' + Math.round(v.z));
    const R = window.__rec = { keys, d: Math.round(d), days: [], bad: [], merchantTrades: 0, maxPins: 0 };
    const orig = BF.vlog.trade;
    BF.vlog.trade = function (buyer, seller, what, times) {
      if (!(what && typeof what === 'object') && buyer !== 'player' && seller !== 'player') R.bad.push('no offer: ' + String(what).slice(0, 80));
      if ((buyer && buyer.profession === 'merchant') || (seller && seller.profession === 'merchant')) {
        R.merchantTrades += times || 1;
        const other = buyer && buyer.profession === 'merchant' ? seller : buyer;
        if (other && other.village && other.village.key === keys[1]) R.farTrades = (R.farTrades || 0) + (times || 1);
      }
      return orig.apply(this, arguments);
    };
    window.__day = () => {
      if (window.__stockHome) window.__stockHome();
      const out = { day: BF.sky.day, v: {}, pins: BF.villageSim.pins().size, sim: BF.villageSim.status() };
      for (const k of keys) {
        const ms = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === k && !m.dead && !m.removed);
        let ems = 0, items = 0;
        for (const m of ms) for (const s of m.inv || []) if (s) { if (s.id === BF.I.emerald) ems += s.count; else items += s.count; }
        out.v[k] = { alive: ms.length, ems, items, merchants: ms.filter(m => m.profession === 'merchant').map(m => (m.mc && m.mc.stage) || 'home') };
      }
      const L = BF.merchant.LOG;
      out.left = L.filter(e => e.kind === 'leave').length; out.home = L.filter(e => e.kind === 'home' && e.why === 'done').length;
      out.sells = L.filter(e => e.kind === 'sell').map(e => e.at + ':' + e.gave);
      out.paths = 0; for (const n of BF.merchant.wear.values()) out.paths = Math.max(out.paths, n);
      // the best price gap between the two villages either way (dearest buy there / cheapest sell here), whatever the steps
      const gap = (a, b) => { const A = BF.merchant.book(BF.mobs.villages.get(a)), B = BF.merchant.book(BF.mobs.villages.get(b)); let best = [0, '']; for (const [id, ss] of A.sells) { const bs = B.buys.get(id); if (bs && bs.length && bs[0].u / ss[0].u > best[0]) best = [+(bs[0].u / ss[0].u).toFixed(2), BF.items[id].name + ' ' + ss[0].s + '/' + bs[0].s]; } return best; };
      try { if (BF.mobs.villages.get(keys[0]) && BF.mobs.villages.get(keys[1])) out.gap = [gap(keys[0], keys[1]), gap(keys[1], keys[0])]; } catch (e) { out.gap = String(e); }
      if (window.__DIAG) out.diag = BF.mobs.list.filter(m => m.profession === 'merchant' && !m.dead && keys.includes(m.village.key)).map(m => {
        const o = { k: m.village.key, em: BF.trades.inv.count(m.inv, BF.I.emerald), plan: null };
        const p = BF.merchant.plan(m); if (p) o.plan = { to: p.rec.key, profit: +p.profit.toFixed(2), goods: p.list.map(g => g.n + ' ' + BF.items[g.id].name) };
        const other = BF.mobs.villages.get(keys.find(k => k !== m.village.key));
        if (other) { const g = BF.merchant.goods(m.village, other, m, 999); o.raw = g.list.slice(0, 3).map(x => x.n + ' ' + BF.items[x.id].name + ' ' + x.buy.toFixed(3) + '>' + x.sell.toFixed(3)); }
        return o;
      });
      if (window.__DIAG) {   // why a merchant does or does not set out (DIAG=1)
        const m = BF.mobs.list.find(x => x.type === 'villager' && x.profession === 'merchant' && !x.dead && keys.includes(x.village && x.village.key));
        if (m) { const cs = BF.merchant.candidates(m); out.diag = { market: [...BF.merchant.market.keys()], cands: cs.map(c => c.rec.key + ':' + Math.round(c.d)), days540: +BF.merchant.tripDays(m, 540).toFixed(2), goods: cs.map(c => { const g = BF.merchant.goods(m.village, c.rec, m, 999); return g.profit.toFixed(1) + '/' + g.list.length; }), sells: [...BF.merchant.book(m.village, m).sells].filter(([id, a]) => a.reduce((t, x) => t + (BF.market ? BF.market.spareOf(x.v, id) : 0), 0) >= 4).slice(0, 8).map(([id, a]) => id + ':' + a[0].u.toFixed(2) + ' s' + a[0].s + ' spare' + (BF.market ? BF.market.spareOf(a[0].v, id) : '?')), buyAt: Object.keys((BF.merchant.market.get(keys[1]) || { buys: {} }).buys).length, gapDbg: (window.__gapIds || []).map(id => ({ id, far: (BF.merchant.market.get(keys[1]) || { buys: {} }).buys[id], home: (BF.merchant.book(m.village, m).sells.get(id) || []).slice(0, 2).map(x => [x.u, x.s, BF.market ? BF.market.spareOf(x.v, id) : 0]) })), plan: !!BF.merchant.plan(m), mc: m.mc && { stage: m.mc.stage, cd: m.mc.cd, last: m.mc.last } }; }
      }
      out.routes = BF.merchant.routes().map(r => ({ a: r.a, b: r.b, trips: r.trips, items: r.items, ems: r.emeralds, road: r.road.length }));
      R.days.push(out);
    };
    // dirt paths made: count setBlock calls to dirt_path from merchant.js
    const sb = BF.world.setBlock.bind(BF.world);
    R.paths = 0;
    BF.world.setBlock = function (x, y, z, id) { if (id === BF.B.dirt_path && new Error().stack.includes('merchant.js')) R.paths++; return sb(x, y, z, id); };
    const profs = {};
    for (const m of BF.mobs.list) if (m.type === 'villager' && m.village && keys.includes(m.village.key) && !m.dead) profs[m.village.key + ' ' + m.profession] = 1;
    return { gap: window.__gapIds, keys, d: Math.round(d), merchants: Object.keys(profs).filter(k => /merchant$/.test(k)), sim: BF.villageSim.status() };
  });
  if (setup.err) { console.log('FAIL ' + setup.err); await b.close(); process.exit(1); }
  console.log(`seed ${SEED} villages ${setup.keys.join(' and ')} ${setup.d} blocks apart; merchants: ${setup.merchants.join(', ') || 'none'}; gap items ${JSON.stringify(setup.gap)}; ${setup.sim}`);
  const t0 = Date.now();
  await pg.evaluate(() => window.__day());
  const h = 0.05, DAY = Math.round(1200 / h), PER_CALL = Math.round(DAY / 6);
  let away = false;
  for (let s = 0, d = 0; s < DAYS * DAY; s += PER_CALL) {
    // from day AWAY on, the player leaves as soon as a merchant is on the road (or 3 days before the end, whatever happens)
    if (!away && s >= AWAY * DAY && (s >= (DAYS - 3) * DAY || await pg.evaluate(() => BF.merchant.routes().some(r => r.road.some(x => x.stage === 'go' || x.stage === 'buy' || x.stage === 'back'))))) {
      away = true;
      const r = await pg.evaluate(() => { const [mx, mz] = window.__mid, x = mx + 1500, z = mz; BF.player.spawn(x + 0.5, BF.worldgen.heightAt(x, z) + 3, z + 0.5); window.__mid2 = [x, z]; for (let i = 0; i < 300; i++) BF.world.update(x, z, 40); return BF.villageSim.status() + ' / on the road: ' + BF.merchant.routes().reduce((a, r) => a + r.road.length, 0); });
      console.log(`day ${Math.floor(s / DAY)}: the player walks 1500 blocks away (${r})`);
    }
    await pg.evaluate(([n, h, away]) => {
      const [x, z] = away ? window.__mid2 : window.__mid;
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
        const p = BF.villageSim.pins().size; if (p > window.__rec.maxPins) window.__rec.maxPins = p;
      }
    }, [Math.min(PER_CALL, DAYS * DAY - s), h, away]);
    if (Math.floor((s + PER_CALL) / DAY) > d) {
      d = Math.floor((s + PER_CALL) / DAY);
      await pg.evaluate(() => window.__day());
      const x = await pg.evaluate(() => window.__rec.days.at(-1));
      const vs = Object.entries(x.v).map(([k, v]) => `${k}: ${v.alive} alive, ${v.ems} em, ${v.items} items, merchants ${v.merchants.join('/')}`).join(' | ');
      if (await pg.evaluate(() => !!window.__stuck)) {
        console.log('  STUCK ' + JSON.stringify(await pg.evaluate(() => {
          const m = window.__stuck, N = BF.mobs.nav, [fx, fy, fz] = N.feetCell(m), CS = BF.CS, out = { feet: [fx, fy, fz], ground: BF.world.getBlock(fx, fy - 1, fz), at: BF.world.getBlock(fx, fy, fz), head: BF.world.getBlock(fx, fy + 1, fz), paths: {}, chunks: [] };
          for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [5, 5], [-5, -5], [15, 15], [-15, -15], [-15, -14]]) { const gx = fx + dx, gz = fz + dz; const p = N.findPath(fx, fy, fz, { x: gx, z: gz, at: (x, y, z) => Math.abs(x - gx) + Math.abs(z - gz) <= 2 }, 2500); out.paths[dx + ',' + dz] = p ? p.length : null; }
          for (let cz = -2; cz <= 2; cz++) { let row = ''; for (let cx = -2; cx <= 2; cx++) row += BF.world.isLoaded(fx + cx * CS, fz + cz * CS) ? 'X' : '.'; out.chunks.push(row); }
          out.kind = m.ai.routeKind;
          return out; })));
        break;
      }
      { const nf = await pg.evaluate(() => window.__nf); if (nf && nf.length) { console.log('  nf ' + JSON.stringify(nf)); } } if (x.diag) console.log('  diag ' + JSON.stringify(x.diag));
      console.log(`day ${String(x.day).padStart(3)}  gap ${JSON.stringify(x.gap)}  trips out ${x.left} home ${x.home}  pins ${x.pins}  wear max ${x.paths}  ${vs}  (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  const R = await pg.evaluate(() => Object.assign(window.__rec, { log: BF.merchant.LOG.slice(-60), pinsLeft: BF.villageSim.pins().size, routes: BF.merchant.routes() }));
  const last = R.days.at(-1);
  const soldThere = R.log.filter(e => e.kind === 'sell' && e.at === 'sell').length, soldHome = R.log.filter(e => e.kind === 'sell' && e.at === 'unload').length;
  const allSells = await pg.evaluate(() => ({ there: BF.merchant.LOG.filter(e => e.kind === 'sell' && e.at === 'sell').length, home: BF.merchant.LOG.filter(e => e.kind === 'sell' && e.at === 'unload').length, kinds: BF.merchant.LOG.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {}) }));
  const sum = { seed: SEED, villages: R.keys, apart: R.d, days: DAYS, tripsOut: last.left, tripsHome: last.home, soldThere: allSells.there, soldHome: allSells.home, log: allSells.kinds,
    merchantTrades: R.merchantTrades, maxPins: R.maxPins, pinsLeft: R.pinsLeft, paths: R.paths, wearMax: last.paths, routes: R.routes.map(r => ({ a: r.a, b: r.b, trips: r.trips, items: r.items, ems: r.emeralds, total: r.total })),
    start: R.days[0].v, end: last.v, bad: R.bad.slice(0, 5), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(JSON.stringify(sum, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ sum, days: R.days, log: R.log }, null, 1));
  let fail = 0;
  const F = m => { console.log('FAIL ' + m); fail++; };
  if (pageErrors) F('page errors: ' + pageErrors);
  if (R.bad.length) F('villager trades without an offer: ' + R.bad.length);
  if (FAR && !(R.farTrades > 0)) F('far pair: the merchant made no trade at the far village');
  if (FAR && !(last.left >= 2 && last.home >= 2)) F(`far pair: expected at least 2 trips out and home, got ${last.left} out, ${last.home} home`);
  if (!FAR && !(allSells.there > 0)) F('no goods sold in the other village');
  if (!FAR && DAYS >= 7 && !(allSells.home > 0)) F('no goods brought home and sold');
  if (R.maxPins > 2) F('more than 2 trips on the road: ' + R.maxPins);
  const onRoad = R.routes.reduce((a, r) => a + r.road.length, 0);
  if (R.pinsLeft > onRoad) F(`pins left behind: ${R.pinsLeft} pins, ${onRoad} merchants on the road`);
  if (last.left - last.home > 2 + onRoad) F(`merchants who never came home: ${last.left} out, ${last.home} home`);
  if (last.left >= 10 && !(R.paths > 0)) F('no dirt path formed after ' + last.left + ' trips (most crossings of one block: ' + last.paths + ')');
  if (last.left >= 2 && !(last.paths >= 2)) F('trips do not wear the same ground (most crossings of one block: ' + last.paths + ')');
  console.log(fail ? fail + ' FAILED' : 'all passed');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
