// One market soak (release 1.3): one village for many game days. Run it on this build and on the one before (copy the script there) to compare.
// Usage: NODE_PATH=$(npm root -g) node test/market-soak.js [seed=1] [days=14] [out.json]
// Drives the simulation directly (no rendering), like test/toolchain.js. Once per game day it records the villagers alive, starving and
// dead, the village's happiness, the emeralds and items villagers hold, trades so far (and how many went through spare-goods offers), and
// the builders' progress (structures finished, blocks placed). Prints a day table and a summary. FAILs on a page error, or a villager trade
// made without an offer.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 1);
const DAYS = +(process.argv[3] || 14);
const OUT = process.argv[4] || null;

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
  const setup = await pg.evaluate(() => {
    window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const v = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    const key = Math.round(v.x) + ',' + Math.round(v.z);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
    BF.sky.setTime(0.02);
    for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
    // every trade, as the village log sees it
    const R = window.__rec = { key, trades: 0, spare: 0, items: 0, ems: 0, days: [], bad: [] };
    const orig = BF.vlog.trade;
    BF.vlog.trade = function (buyer, seller, what, times) {
      const inV = m => m && m.village && m.village.key === key;
      if ((inV(buyer) || inV(seller)) && what && typeof what === 'object') {
        const t = times || 1; R.trades += t; if (what.spare || what.need) R.spare += t;
        for (const x of what.buy) if (x.id === BF.I.emerald) R.ems += x.n * t; else R.items += x.n * t;
        if (what.sell.id === BF.I.emerald) R.ems += what.sell.n * t; else R.items += what.sell.n * t;
      } else if (inV(buyer) || inV(seller)) { R.trades += times || 1; if (buyer !== 'player' && seller !== 'player') R.bad.push('no offer: ' + what); }
      return orig.apply(this, arguments);
    };
    window.__day = () => {
      const rec = BF.vlog.villageAt(v.x, v.z) || { members: [] };
      const vs = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key);
      const alive = vs.filter(m => !m.dead && !m.removed);
      let ems = 0, items = 0, starving = 0;
      for (const m of alive) {
        if (m.starving) starving++;
        for (const s of m.inv || []) if (s) { if (s.id === BF.I.emerald) ems += s.count; else items += s.count; }
      }
      const built = BF.builder && rec.key ? BF.builder.builtOf(rec) : [];
      const hs = BF.happiness && rec.key ? BF.happiness.score(rec) : null;
      R.days.push({ day: BF.sky.day, alive: alive.length, starving, dead: vs.length - alive.length, happy: hs ? Math.round(hs.score) : null, ems, items, trades: R.trades, spare: R.spare,
        done: built.filter(e => e.state === 'done').length, placed: built.reduce((a, e) => a + (e.prog || 0), 0) });
    };
    const profs = {};
    for (const m of BF.mobs.list) if (m.type === 'villager' && m.village && m.village.key === key && !m.dead) profs[m.profession] = (profs[m.profession] || 0) + 1;
    return { key, v, profs };
  });
  console.log(`seed ${SEED} village ${setup.key} ${process.env.LABEL || ''} ${JSON.stringify(setup.profs)}`);
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
    if (Math.floor((s + PER_CALL) / DAY) > d) { d = Math.floor((s + PER_CALL) / DAY); await pg.evaluate(() => window.__day()); const x = await pg.evaluate(() => window.__rec.days.at(-1)); console.log(`day ${String(x.day).padStart(3)}  alive ${x.alive}  starving ${x.starving}  dead ${x.dead}  happy ${x.happy}  emeralds ${x.ems}  items ${x.items}  trades ${x.trades} (spare ${x.spare})  built ${x.done} placed ${x.placed}  (${Math.round((Date.now() - t0) / 1000)} s)`); }
  }
  const R = await pg.evaluate(() => window.__rec);
  const days = R.days, last = days.at(-1);
  const sum = { seed: SEED, village: R.key, days: DAYS, alive: last.alive, dead: last.dead,
    starvingDays: days.reduce((a, x) => a + x.starving, 0), happyMean: Math.round(days.filter(x => x.happy != null).reduce((a, x) => a + x.happy, 0) / Math.max(1, days.filter(x => x.happy != null).length)),
    happyEnd: last.happy, emeraldsStart: days[0].ems, emeraldsEnd: last.ems, itemsStart: days[0].items, itemsEnd: last.items, trades: last.trades, spareTrades: last.spare,
    built: last.done, placed: last.placed, bad: R.bad.slice(0, 10), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(JSON.stringify(sum, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ sum, days }, null, 1));
  let fail = 0;
  if (pageErrors) { console.log('FAIL page errors: ' + pageErrors); fail++; }
  if (R.bad.length) { console.log('FAIL villager trades without an offer: ' + R.bad.length + ' ' + R.bad.slice(0, 5).join('; ')); fail++; }
  console.log(fail ? fail + ' FAILED' : 'all passed');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
