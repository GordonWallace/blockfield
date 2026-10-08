// Run-down farms (village generator 3): every generated farm has a composter beside it; farms no farmer works at spawn start run
// down by a seeded amount (fewer crops; past 0.6 dry channels, dehydrated farmland, some or all of it back to dirt); a farmer put on
// a dry, run-down farm refills its channels and tills its dirt within a game day.
// Usage: NODE_PATH=$(npm root -g) node test/farm-repair.js [seed=2] [days=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 2), DAYS = +(process.argv[3] || 1);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__raf = raf; window.requestAnimationFrame = cb => (window.__halt ? (window.__pending = cb, 0) : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await pg.waitForTimeout(3000);
  const lines = [], ok = (name, c, extra) => lines.push((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));

  // a village with a dry, run-down farm: the nearest one
  const pick = await pg.evaluate(() => {
    window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(Boolean).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const stats = { villages: 0, farms: 0, withComposter: 0, untended: 0, dry: 0 };
    let found = null;
    for (const v of vs.slice(0, 15)) {
      if (!v.jobsites) v.jobsites = BF.jobs.planVillage(v);
      const farms = (v.buildings || []).filter(b => b.type === 'farm' || b.type === 'bigfarm');
      stats.villages++;
      for (const f of farms) {
        stats.farms++;
        if (v.jobsites.some(j => j.prof === 'farmer' && j.x >= f.x0 - 1 && j.x <= f.x1 + 1 && j.z >= f.z0 - 1 && j.z <= f.z1 + 1)) stats.withComposter++;
        if (!f.untended) continue;
        stats.untended++;
        const s = BF.noise.hash(f.bx, f.bz, 640);
        if (s >= 0.6) stats.dry++;
        if (!found && s >= 0.6 && s < 0.9) found = { v: { x: v.x, z: v.z, y: v.y }, f: { x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1, y: f.y }, s };
      }
    }
    return { stats, found };
  });
  ok('every generated farm has a composter beside it', pick.stats.farms > 0 && pick.stats.withComposter === pick.stats.farms, pick.stats);
  ok('some farms start untended, some of those dry', pick.stats.untended > 0 && pick.stats.dry > 0 && pick.stats.untended < pick.stats.farms, pick.stats);
  if (!pick.found) { ok('a dry run-down farm to repair', false); for (const l of lines) console.log(l); await b.close(); return; }

  const before = await pg.evaluate(({ v, f }) => {
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
    BF.sky.setTime(0.02);
    for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
    const W = BF.world, B = BF.B, y = f.y, count = { air: 0, water: 0, farm: 0, dry: 0, dirt: 0, crops: 0, grass: 0 };
    for (let x = f.x0 + 1; x < f.x1; x++) for (let z = f.z0 + 1; z < f.z1; z++) {
      const id = W.getBlock(x, y, z);
      if (id === 0) count.air++; else if (BF.FLUID[id]) count.water++; else if (id === B.farmland) count.farm++; else if (id === B.farmland_dry) count.dry++; else if (id === B.dirt) count.dirt++; else count.grass++;
      if (BF.RENDER[W.getBlock(x, y + 1, z)] === 4) count.crops++;
    }
    // the composter beside this farm, and a villager to work it
    let site = null;
    for (const [, s] of BF.jobs.sites) if (s.prof === 'farmer' && s.x >= f.x0 - 1 && s.x <= f.x1 + 1 && s.z >= f.z0 - 1 && s.z <= f.z1 + 1) site = s;
    const key = Math.round(v.x) + ',' + Math.round(v.z);
    const claimed = site && BF.jobs.claims.get(site.x + ',' + site.y + ',' + site.z);
    let m = claimed && claimed.mob && !claimed.mob.dead ? claimed.mob : null;
    if (!m) {
      m = BF.mobs.list.find(q => q.type === 'villager' && !q.dead && q.village && q.village.key === key && !q.child && q.profession !== 'nitwit' && q.profession !== 'farmer');
      if (m) { BF.jobs.release(m, { keepProfession: false }); m.xp = 0; BF.jobs.claim(m, { site }); }
    }
    // a newly hired farmer buys a hoe and a bucket with its hiring emeralds first; here it has them already
    if (m) for (const n of ['wooden_hoe', 'bucket']) if (!m.inv.some(s => s && BF.items[s.id].name === n)) BF.trades.inv.add(m.inv, BF.I[n], 1);
    if (m) { m.position.x = f.x0 - 1.5; m.position.z = f.z0 - 1.5; m.position.y = y + 1; }
    BF.villageLife.log.length = 0;
    return { count, site: !!site, farmer: m ? m.profession : null, hasHoe: m ? BF.toolWear.has(m, 'hoe') : false };
  }, pick.found);
  ok('the dry farm starts with empty channels, no hydrated farmland, few crops', before.count.air > 0 && before.count.water === 0 && before.count.farm === 0 && before.count.crops <= 4, Object.assign({ s: +pick.found.s.toFixed(2) }, before.count));
  ok('part of it has gone back to dirt', before.count.dirt > 0, before.count);
  ok('a farmer works the farm\'s composter', before.site && before.farmer === 'farmer', before);

  const STEPS = 4000, h = 0.05, total = Math.round(DAYS * 1200 / h), kinds = {};
  for (let s = 0; s < total; s += STEPS) {
    const k = await pg.evaluate(([n, h, v]) => {
      for (let i = 0; i < n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
      }
      const out = {};
      for (const e of BF.villageLife.log.splice(0)) { const kk = e.kind + (e.plan ? ':' + e.plan : ''); out[kk] = (out[kk] || 0) + 1; }
      return out;
    }, [Math.min(STEPS, total - s), h, pick.found.v]);
    for (const kk in k) kinds[kk] = (kinds[kk] || 0) + k[kk];
  }
  const after = await pg.evaluate(f => {
    const W = BF.world, B = BF.B, y = f.y, count = { air: 0, water: 0, farm: 0, dry: 0, dirt: 0, crops: 0, grass: 0 };
    for (let x = f.x0 + 1; x < f.x1; x++) for (let z = f.z0 + 1; z < f.z1; z++) {
      const id = W.getBlock(x, y, z);
      if (id === 0) count.air++; else if (BF.FLUID[id]) count.water++; else if (id === B.farmland) count.farm++; else if (id === B.farmland_dry) count.dry++; else if (id === B.dirt) count.dirt++; else count.grass++;
      if (BF.RENDER[W.getBlock(x, y + 1, z)] === 4) count.crops++;
    }
    return count;
  }, pick.found.f);
  console.log('tasks', JSON.stringify(kinds));
  ok('a repair project ran', (kinds['project:repair'] || 0) > 0, kinds);
  ok('the channels are full again', after.air === 0 && after.water === before.count.air + before.count.water, after);
  ok('the dirt is farmland again, and hydrated', after.dirt === 0 && after.farm > 0 && after.dry === 0, after);
  ok('crops are planted on it again', after.crops > before.count.crops, after);
  for (const l of lines) console.log(l);
  await b.close();
})();
