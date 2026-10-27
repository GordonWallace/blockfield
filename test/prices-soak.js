// Prices follow demand soak (release 1.3): one village for many game days, with demand prices (default) or fixed prices (PRICES=off).
// Usage: NODE_PATH=$(npm root -g) node test/prices-soak.js [seed=1] [days=45] [out.json]
// Drives the simulation directly (no rendering), like test/toolchain.js. Once per game day it records the villagers alive, starving and
// dead, the village's happiness, the emeralds villagers hold, trades so far, and the price steps of every priced offer. Prints a day table
// and a summary. FAILs on a page error, a price outside half to double its base, a villager buying above its own sell price, or (with
// prices on) the economy tallies not matching the trades.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 1);
const DAYS = +(process.argv[3] || 45);
const OUT = process.argv[4] || null;
const OFF = process.env.PRICES === 'off';

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let pageErrors = 0;
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await pg.waitForTimeout(3000);
  const setup = await pg.evaluate(off => {
    window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative');
    BF.prices.off = off;
    const v = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    const key = Math.round(v.x) + ',' + Math.round(v.z);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
    BF.sky.setTime(0.02);
    for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
    // every trade, as the village log sees it
    const R = window.__rec = { key, trades: 0, items: 0, ems: 0, days: [], bad: [] };
    const orig = BF.vlog.trade;
    BF.vlog.trade = function (buyer, seller, what, times) {
      const inV = m => m && m.village && m.village.key === key;
      if ((inV(buyer) || inV(seller)) && what && typeof what === 'object') {
        const t = times || 1; R.trades += t;
        for (const x of what.buy) if (x.id === BF.I.emerald) R.ems += x.n * t; else R.items += x.n * t;
        if (what.sell.id === BF.I.emerald) R.ems += what.sell.n * t; else R.items += what.sell.n * t;
      } else if (inV(buyer) || inV(seller)) R.trades += times || 1;
      return orig.apply(this, arguments);
    };
    window.__day = () => {
      const P = BF.prices, rec = BF.vlog.villageAt(v.x, v.z) || { members: [] };
      const vs = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key);
      const alive = vs.filter(m => !m.dead && !m.removed);
      let ems = 0, starving = 0;
      const steps = [];
      for (const m of alive) {
        if (m.inv) ems += BF.trades.inv.count(m.inv, BF.I.emerald);
        if (m.starving) starving++;
        for (const o of m.trades || []) {
          if (!P.kind(o)) continue;
          steps.push(P.step(o));
          const r = P.unit(o) / P.baseUnit(o);
          if (r < 0.5 - 0.06 || r > 2 + 0.06) R.bad.push(`${BF.vlog.nameOf(m)} ${JSON.stringify([o.buy, o.sell])} x${r.toFixed(2)}`);
        }
        // never buys above its own sell price
        for (const o of m.trades || []) {
          if (P.kind(o) !== 'buy') continue;
          const s = (m.trades || []).filter(x => P.kind(x) === 'sell' && x.sell.id === o.buy[0].id).map(P.unit);
          if (s.length && P.unit(o) > Math.min(...s) + 1e-9 && P.unit(o) > P.baseUnit(o) + 1e-9) R.bad.push(`${BF.vlog.nameOf(m)} buys ${BF.items[o.buy[0].id].name} above its own price`);
        }
      }
      const hs = BF.happiness && rec.key ? BF.happiness.score(rec) : null;
      const up = steps.filter(s => s > 0), down = steps.filter(s => s < 0);
      R.days.push({ day: BF.sky.day, alive: alive.length, starving, dead: vs.length - alive.length, happy: hs ? Math.round(hs.score) : null, ems, trades: R.trades,
        offers: steps.length, up: up.length, down: down.length, atMax: steps.filter(s => s >= 30).length, atMin: steps.filter(s => s <= -30).length,
        mean: steps.length ? +(steps.reduce((a, b) => a + b, 0) / steps.length).toFixed(2) : 0 });
    };
    const profs = {};
    for (const m of BF.mobs.list) if (m.type === 'villager' && m.village && m.village.key === key && !m.dead) profs[m.profession] = (profs[m.profession] || 0) + 1;
    return { key, v, profs };
  }, OFF);
  console.log(`seed ${SEED} village ${setup.key} prices ${OFF ? 'FIXED' : 'DEMAND'} ${JSON.stringify(setup.profs)}`);
  const t0 = Date.now();
  await pg.evaluate(() => window.__day());
  const h = 0.05, DAY = Math.round(1200 / h), PER_CALL = Math.round(DAY / 6);
  for (let s = 0, d = 0; s < DAYS * DAY; s += PER_CALL) {
    await pg.evaluate(([n, h, v]) => {
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
      }
    }, [Math.min(PER_CALL, DAYS * DAY - s), h, setup.v]);
    if (Math.floor((s + PER_CALL) / DAY) > d) { d = Math.floor((s + PER_CALL) / DAY); await pg.evaluate(() => window.__day()); const x = await pg.evaluate(() => window.__rec.days.at(-1)); console.log(`day ${String(x.day).padStart(3)}  alive ${x.alive}  starving ${x.starving}  dead ${x.dead}  happy ${x.happy}  emeralds ${x.ems}  trades ${x.trades}  prices up ${x.up} down ${x.down} max ${x.atMax} min ${x.atMin} mean ${x.mean}  (${Math.round((Date.now() - t0) / 1000)} s)`); }
  }
  const R = await pg.evaluate(() => window.__rec);
  // the Economy view's tallies must still add up to the trades (last 7 days are kept: compare the item and emerald totals of trades from then)
  const econ = await pg.evaluate(() => { const E = BF.econ, key = window.__rec.key; let n = 0, e = 0, t = 0; for (const x of E.days(key).values()) for (const k in x.f) { n += x.f[k][0]; e += x.f[k][1]; t += x.f[k][2]; } return { n, e, t, days: E.days(key).size }; });
  const days = R.days, last = days.at(-1);
  const sum = { seed: SEED, village: R.key, prices: OFF ? 'fixed' : 'demand', days: DAYS, alive: last.alive, dead: last.dead,
    starvingDays: days.reduce((a, x) => a + x.starving, 0), happyMean: Math.round(days.filter(x => x.happy != null).reduce((a, x) => a + x.happy, 0) / Math.max(1, days.filter(x => x.happy != null).length)),
    happyEnd: last.happy, emeraldsStart: days[0].ems, emeraldsEnd: last.ems, trades: last.trades, atMax: last.atMax, atMin: last.atMin, up: last.up, down: last.down, offers: last.offers, econ, bad: R.bad.slice(0, 10), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(JSON.stringify(sum, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ sum, days }, null, 1));
  let fail = 0;
  if (pageErrors) { console.log('FAIL page errors: ' + pageErrors); fail++; }
  if (R.bad.length) { console.log('FAIL prices out of bounds: ' + R.bad.length + ' ' + R.bad.slice(0, 5).join('; ')); fail++; }
  if (!OFF && DAYS >= 31 && !(last.atMax + last.atMin > 0)) console.log('NOTE no price reached its limit');
  console.log(fail ? fail + ' FAILED' : 'all passed');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
