// @ci skip suite=village
// Bridge soak (idea-030): does a generated village by a river ever get a bridge, and do its villagers walk over it?
// Usage: NODE_PATH=$(npm root -g) node test/bridge-soak.js [seed=1] [days=6] [out.json]   Env: SCAN=1 only lists villages near rivers.
// Picks the nearest generated village (of the 10 nearest the origin) with a builder and a river crossing js/bridges.js accepts within 48 blocks
// of its box, then drives the simulation directly (no rendering) like test/market-soak.js. Once per game day: crossings counted (busiest cell and
// total, from swims and from routes that met water), the bridges planned, under way and finished, villager swims, and villager visits to a
// finished deck (a villager whose feet are on a deck cell, sampled every 2.5 s of game time).
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 1);
const DAYS = +(process.argv[3] || 6);
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
  const setup = await pg.evaluate(scanOnly => {
    window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const cands = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 10);
    const seen = [];
    let v = null, key = null;
    for (const c of cands) {
      const k = Math.round(c.x) + ',' + Math.round(c.z);
      BF.player.spawn(c.x + 0.5, (c.y || BF.worldgen.heightAt(c.x, c.z)) + 3, c.z + 0.5);
      for (let i = 0; i < 400; i++) { BF.world.update(c.x, c.z, 60); if (i % 4 === 0) step(0.05); }
      const rec = BF.mobs.villages && BF.mobs.villages.get(k), wg = rec && rec.wg;
      const x0 = wg ? wg.minX : c.x - 20, x1 = wg ? wg.maxX : c.x + 20, z0 = wg ? wg.minZ : c.z - 20, z1 = wg ? wg.maxZ : c.z + 20;
      let span = null;
      for (let z = z0 - 48; z <= z1 + 48 && !span; z += 8) for (let x = x0 - 48; x <= x1 + 48 && !span; x += 8) span = BF.bridges._find(x, z);
      const builder = BF.mobs.list.some(m => m.type === 'villager' && m.profession === 'builder' && m.village && m.village.key === k && !m.dead);
      seen.push({ k, pop: c.pop, builder, span: span && { axis: span.axis, f: span.f, a: span.a, b: span.b, L: span.L } });
      if (span && builder && !v) { v = c; key = k; if (!scanOnly) break; }
    }
    if (scanOnly || !v) return { seen, key };
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
    BF.sky.setTime(0.02);
    const R = window.__rec = { key, swims: 0, routed: 0, visits: 0, visitors: {}, days: [] };
    const Br = BF.bridges, swim0 = Br.noteSwim, rec0 = Br.record;
    Br.noteSwim = function (m) { if (m.village && m.village.key === key) R.swims++; return swim0.apply(this, arguments); };
    window.__sample = () => {
      const rec = BF.mobs.villages.get(key);
      for (const e of BF.builder.builtOf(rec)) if (e.type === 'bridge' && e.state === 'done') {
        const cells = new Set(Br.deck(e).map(c => c.join(',')));
        for (const m of BF.mobs.list) if (m.type === 'villager' && !m.dead && !m.removed) {
          const f = [Math.floor(m.position.x), Math.floor(m.position.y + 0.01), Math.floor(m.position.z)].join(',');
          if (cells.has(f)) { R.visits++; R.visitors[m.profession] = (R.visitors[m.profession] || 0) + 1; }
        }
      }
    };
    window.__day = () => {
      const rec = BF.mobs.villages.get(key), heat = Br.heat(rec);
      const br = BF.builder.builtOf(rec).filter(e => e.type === 'bridge');
      R.days.push({ day: BF.sky.day, crossings: heat.reduce((a, h) => a + h[2], 0), busiest: heat.reduce((a, h) => Math.max(a, h[2]), 0), cells: heat.length,
        weight: +Br.weight(rec).toFixed(2), bridges: br.map(e => e.state + ' ' + (e.prog || 0) + '/' + e.n), swims: R.swims, visits: R.visits,
        building: BF.builder.builtOf(rec).filter(e => e.state === 'building').map(e => e.type) });
    };
    const profs = {};
    for (const m of BF.mobs.list) if (m.type === 'villager' && m.village && m.village.key === key && !m.dead) profs[m.profession] = (profs[m.profession] || 0) + 1;
    return { key, v, profs, seen };
  }, !!process.env.SCAN);
  console.log(`seed ${SEED}`); for (const s of setup.seen) console.log('  ' + JSON.stringify(s));
  if (process.env.SCAN || !setup.v) { console.log(setup.v ? '' : 'no village with a builder near a river'); await b.close(); process.exit(0); }
  console.log(`village ${setup.key} ${JSON.stringify(setup.profs)}`);
  const t0 = Date.now();
  await pg.evaluate(() => window.__day());
  const h = 0.05, DAY = Math.round(1200 / h), PER_CALL = Math.round(DAY / 6);
  for (let s = 0, d = 0; s < DAYS * DAY; s += PER_CALL) {
    await pg.evaluate(([n, h, v]) => {
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) { BF.world.update(v.x, v.z, 4); window.__sample(); }
      }
    }, [Math.min(PER_CALL, DAYS * DAY - s), h, setup.v]);
    if (Math.floor((s + PER_CALL) / DAY) > d) {
      d = Math.floor((s + PER_CALL) / DAY); await pg.evaluate(() => window.__day());
      const x = await pg.evaluate(() => window.__rec.days.at(-1));
      console.log(`day ${String(x.day).padStart(3)}  crossings ${x.crossings} (busiest cell ${x.busiest}, ${x.cells} cells)  weight ${x.weight}  bridges [${x.bridges.join(', ')}]  building [${x.building.join(', ')}]  swims ${x.swims}  deck visits ${x.visits}  (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  const R = await pg.evaluate(() => window.__rec);
  const sum = { seed: SEED, village: R.key, days: DAYS, swims: R.swims, visits: R.visits, visitors: R.visitors, last: R.days.at(-1), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(JSON.stringify(sum, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ sum, days: R.days }, null, 1));
  if (pageErrors) console.log('FAIL page errors: ' + pageErrors);
  await b.close();
  process.exit(pageErrors ? 1 : 0);
})();
