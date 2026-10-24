// @ci integration hosts=worker,server
// One market soak (release 1.3): one village for many game days. Run it on this build and on the one before (copy the script there) to compare.
// Usage: NODE_PATH=$(npm root -g) node test/market-soak.js [seed=1] [days=14] [out.json]   Env: NEED=builder,farmer (jobs the village must have).
// Drives the simulation directly (no rendering), like test/toolchain.js, each tick in the request queue's phases (js/requests.js: trades
// asked during the mobs' update settle in the apply phase, spec r15-21). Once per game day it records the villagers alive, starving and
// dead, the village's happiness, the emeralds and items villagers hold, trades so far (and how many went through spare-goods offers), and
// the builders' progress (structures finished, blocks placed). Prints a day table and a summary. FAILs on a page error, or a villager trade
// made without an offer.
const path = require('path');
const fs = require('fs');
const lib = require('./lib');
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
  await pg.addInitScript(n => { window.__NEED = n; }, process.env.NEED || 'builder');
  await lib.install(pg);
  const srv = lib.host() === 'page' ? null : await lib.serve({ world: lib.host() === 'server' });
  await pg.goto(srv ? srv.url + '?nolod&' + lib.q() + '#seed' + SEED : 'file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await lib.ready(pg);   // the planet (spec r14-22): its river step first
  if (srv) await lib.simReady(pg);
  // the page's player in creative (the simulation's follows with the next player message), then only the soak's steps move the world:
  // the page's frames held and, off the page, the simulation's own ticks stopped; test/bft.js's helpers there too
  await pg.evaluate(() => { if (BF.player.setGameMode) BF.player.setGameMode('creative'); });
  await pg.waitForTimeout(600);
  await pg.evaluate(() => { window.__halt = true; });
  if (srv) await lib.sim(pg, () => { BF.state.paused = true; });
  await lib.simBFT(pg);
  await lib.sim(pg, o => { Object.assign(globalThis, o); }, await pg.evaluate(() => ({ __NEED: window.__NEED })));   // (the init script's setting is the page's)
  await pg.waitForTimeout(3000);
  const setup = await lib.sim(pg, () => {
    // the nearest village with every job in NEED (default: a builder, so building progress shows)
    const need = (globalThis.__NEED || 'builder').split(',').filter(Boolean);
    const cands = BFT.villages(3000).filter(v => v && v.pop).slice(0, 10);
    const step = h => { BF.warp.advance(h); if (BF.req) BF.req.beginTick(); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    let v = null, key = null;
    for (const c of cands) {
      const k = Math.round(c.x) + ',' + Math.round(c.z);
      BF.player.spawn(c.x + 0.5, (c.y || BF.worldgen.heightAt(c.x, c.z)) + 3, c.z + 0.5);
      for (let i = 0; i < 400; i++) { BF.world.update(c.x, c.z, 60); if (i % 4 === 0) step(0.05); }
      const profs = new Set(BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === k && !m.dead).map(m => m.profession));
      if (need.every(p => profs.has(p))) { v = c; key = k; break; }
    }
    if (!v) { v = cands[0]; key = Math.round(v.x) + ',' + Math.round(v.z); BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5); for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); } }
    BF.sky.setTime(0.02);
    for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
    // every trade, as the village log sees it
    const R = globalThis.__rec = { key, trades: 0, spare: 0, items: 0, ems: 0, days: [], bad: [] };
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
    // nothing from nothing (spec r15-21): the apply phase settles trades, so the emeralds held by villagers (in escrow too) and lying
    // in the world are the same before and after it
    if (BF.req && BF.req.apply) {
      const T = BF.trades, em = BF.I.emerald, apply = BF.req.apply;
      const ems = () => { let n = 0; for (const m of BF.mobs.list) if (m.type === 'villager' && Array.isArray(m.inv)) { n += T.inv.count(m.inv, em); for (const s of T.escrowed ? T.escrowed(m) : []) if (s.id === em) n += s.count; } for (const d of BF.drops.list) if (d.id === em) n += d.count; return n; };
      BF.req.apply = function () { const a = ems(), r = apply.apply(this, arguments), b = ems(); if (a !== b && R.bad.length < 20) R.bad.push('emeralds ' + a + ' -> ' + b + ' in the apply phase, day ' + BF.sky.day); return r; };
    }
    globalThis.__day = () => {
      const rec = BF.vlog.villageAt(v.x, v.z) || { members: [] };
      const vs = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key);
      const alive = vs.filter(m => !m.dead && !m.removed);
      let ems = 0, items = 0, starving = 0;
      for (const m of alive) {
        if (m.starving) starving++;
        for (const s of m.inv || []) if (s) { if (s.id === BF.I.emerald) ems += s.count; else items += s.count; }
      }
      // what the builders and the food shoppers did today (their logs, drained): kinds counted, what builders were short of
      const tally = R.tally || (R.tally = { builder: {}, life: {}, short: {} });
      if (BF.builder && BF.builder.log) for (const e of BF.builder.log.splice(0)) { tally.builder[e.kind] = (tally.builder[e.kind] || 0) + 1; if (e.kind === 'short') for (const x of e.missing || []) { const n = x.replace(/ x\d+$/, ''); tally.short[n] = (tally.short[n] || 0) + 1; } }
      if (BF.villageLife && BF.villageLife.log) for (const e of BF.villageLife.log.splice(0)) tally.life[e.kind] = (tally.life[e.kind] || 0) + 1;
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
  await lib.sim(pg, () => globalThis.__day());
  const h = 0.05, DAY = Math.round(1200 / h), PER_CALL = Math.round(DAY / 6);
  for (let s = 0, d = 0; s < DAYS * DAY; s += PER_CALL) {
    await lib.sim(pg, ([n, h, v]) => {
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); if (BF.req) BF.req.beginTick(); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
      }
    }, [Math.min(PER_CALL, DAYS * DAY - s), h, setup.v]);
    if (Math.floor((s + PER_CALL) / DAY) > d) { d = Math.floor((s + PER_CALL) / DAY); await lib.sim(pg, () => globalThis.__day()); const x = await lib.sim(pg, () => globalThis.__rec.days.at(-1)); console.log(`day ${String(x.day).padStart(3)}  alive ${x.alive}  starving ${x.starving}  dead ${x.dead}  happy ${x.happy}  emeralds ${x.ems}  items ${x.items}  trades ${x.trades} (spare ${x.spare})  built ${x.done} placed ${x.placed}  (${Math.round((Date.now() - t0) / 1000)} s)`); }
  }
  const R = await lib.sim(pg, () => globalThis.__rec);
  // who is starving and what the builders are doing, at the end
  R.end = await lib.sim(pg, () => {
    const key = globalThis.__rec.key, F = BF.food, em = BF.I.emerald;
    const vs = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key && !m.dead && !m.removed);
    return {
      starving: vs.filter(m => m.starving).map(m => ({ prof: m.profession, em: BF.trades.inv.count(m.inv, em), food: +F.available(m).toFixed(2), shop: m.fshop && m.fshop.stage })),
      builders: vs.filter(m => m.profession === 'builder').map(m => ({ status: BF.builder.statusText(m), mode: m.bs && m.bs.mode, short: m.bs && m.bs.want && m.bs.want.short, em: BF.trades.inv.count(m.inv, em) })),
      food: vs.map(m => [m.profession, +F.available(m).toFixed(1), BF.trades.inv.count(m.inv, em)]),
    };
  });
  const days = R.days, last = days.at(-1);
  const sum = { seed: SEED, village: R.key, days: DAYS, alive: last.alive, dead: last.dead,
    starvingDays: days.reduce((a, x) => a + x.starving, 0), happyMean: Math.round(days.filter(x => x.happy != null).reduce((a, x) => a + x.happy, 0) / Math.max(1, days.filter(x => x.happy != null).length)),
    happyEnd: last.happy, emeraldsStart: days[0].ems, emeraldsEnd: last.ems, itemsStart: days[0].items, itemsEnd: last.items, trades: last.trades, spareTrades: last.spare,
    built: last.done, placed: last.placed, tally: R.tally, end: R.end, bad: R.bad.slice(0, 10), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(JSON.stringify(sum, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ sum, days }, null, 1));
  let fail = 0;
  if (pageErrors) { console.log('FAIL page errors: ' + pageErrors); fail++; }
  if (R.bad.length) { console.log('FAIL villager trades without an offer, or emeralds made or lost: ' + R.bad.length + ' ' + R.bad.slice(0, 5).join('; ')); fail++; }
  console.log(fail ? fail + ' FAILED' : 'all passed');
  await b.close(); if (srv) await srv.stop();
  process.exit(fail ? 1 : 0);
})();
