// Farm beds soak test: farmers only make farmland inside log-bordered beds (new beds or grown ones).
// Usage: NODE_PATH=$(npm root -g) node test/farmbeds.js <seeds e.g. 1,2,3> [days=3] [villagesPerSeed=4] [outDir]
// Drives the simulation directly (no rendering): for each village near spawn with a farmer, puts the player in the middle,
// lets the villagers spawn, then steps `days` game days. Reports farmland outside any log-enclosed bed (stray), the farm
// projects started and finished (new bed / grown bed), and writes an ASCII map of each village's fields to outDir.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seeds = (process.argv[2] || '1337').split(',').map(Number);
const DAYS = +(process.argv[3] || 3);
const PER_SEED = +(process.argv[4] || 4);
const OUT = process.argv[5] || null;

let b;
async function openWorld(seed) {
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  pg.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 300)); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed);
  await pg.waitForTimeout(3000);
  await pg.evaluate(() => { window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative'); });
  return pg;
}

// In the page: farmland cells of the village area that no log ring encloses, and a character map of the fields.
function survey(key) {
  const B = BF.B, W = BF.world;
  const R = BF.mobs.list.find(m => m.village && m.village.key === key).village;
  const D = BF.villageLife.vdata(R), A = D.area;
  const isLog = id => { const b = BF.blocks[id]; return !!b && /_log$/.test(b.name); };
  const top = (x, z) => { for (let y = A.yHi; y >= A.yLo; y--) { const id = W.getBlock(x, y, z); if (id === 0 || BF.RENDER[id] === 4) continue; return [y, id]; } return [null, 0]; };
  const member = id => id === B.farmland || BF.FLUID[id] === 8 || id === B.grass || id === B.dirt || id === B.sand || id === B.snow_grass;
  const enclosed = (x, y, z) => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let hit = false;
      for (let i = 1; i <= 20; i++) { const id = W.getBlock(x + dx * i, y, z + dz * i); if (isLog(id)) { hit = true; break; } if (!member(id)) break; }
      if (!hit) return false;
    }
    return true;
  };
  let farmland = 0, stray = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const strays = [];
  for (let x = A.x0; x <= A.x1; x++) for (let z = A.z0; z <= A.z1; z++) {
    if (!W.isLoaded(x, z)) continue;
    const [y, id] = top(x, z);
    if (id !== B.farmland) continue;
    farmland++;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    if (!enclosed(x, y, z)) { stray++; if (strays.length < 12) strays.push([x, y, z]); }
  }
  // the map: F farmland, ~ water, L log, # building / box, = path, C composter, . ground, space other
  const lines = [];
  const boxAt = (x, z) => D.boxes.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
  const farms = (R.wg.buildings || []).filter(b => b.type === 'farm' || b.type === 'bigfarm');
  const sites = BF.mobs.list.filter(m => m.village === R && m.profession === 'farmer' && m.jobsite).map(m => m.jobsite);
  if (farmland) {
    for (const s of sites) { x0 = Math.min(x0, s.x - 9); x1 = Math.max(x1, s.x + 9); z0 = Math.min(z0, s.z - 9); z1 = Math.max(z1, s.z + 9); }   // (+4 below: the farmer's reach)
    for (let z = z0 - 4; z <= z1 + 4; z++) {
      let s = '';
      for (let x = x0 - 4; x <= x1 + 4; x++) {
        const [, id] = top(x, z);
        const ch = sites.some(p => p.x === x && p.z === z) ? 'C' : id === B.farmland ? 'F' : BF.FLUID[id] ? '~' : isLog(id) ? 'L' : id === B.dirt_path ? '=' : boxAt(x, z) ? '#' : [B.grass, B.dirt, B.sand, B.snow_grass, B.coarse_dirt, B.podzol].includes(id) ? '.' : ' ';
        s += ch;
      }
      lines.push(s);
    }
  }
  return { farmland, stray, strays, map: lines.join('\n'), genFarms: farms.length };
}

(async () => {
  b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  for (const seed of seeds) {
    let pg = await openWorld(seed);
    const villages = await pg.evaluate(n => {
      const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(Boolean).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
      return vs.slice(0, n * 3).map(v => ({ x: v.x, z: v.z, y: v.y }));
    }, PER_SEED);
    let done = 0;
    for (const v of villages) {
      if (done >= PER_SEED) break;
      const t0 = Date.now();
      if (pg.__used) { await pg.close(); pg = await openWorld(seed); }
      pg.__used = true;
      const key = Math.round(v.x) + ',' + Math.round(v.z);
      const setup = await pg.evaluate(v => {
        const key = Math.round(v.x) + ',' + Math.round(v.z);
        BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
        const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
        for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
        BF.sky.setTime(0.02);
        for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
        BF.villageLife.log.length = 0;
        const farmers = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key && !m.dead && m.profession === 'farmer');
        return { key, farmers: farmers.length };
      }, v);
      if (!setup.farmers) { console.log(`seed ${seed} village ${key}: no farmer, skipped`); continue; }
      done++;
      const before = await pg.evaluate(survey, key);
      const kinds = {};
      const STEPS_PER_CALL = 4000, h = 0.05, total = Math.round(DAYS * 1200 / h);
      for (let s = 0; s < total; s += STEPS_PER_CALL) {
        const k = await pg.evaluate(([n, h, v]) => {
          for (let i = 0; i < n; i++) {
            BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim();
            if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
          }
          const out = {};
          for (const e of BF.villageLife.log.splice(0)) { if (e.kind === 'project') (out._p = out._p || []).push(e.plan + ' ' + e.size + ' (' + e.options + ', +' + e.gain + ' farmland, ' + e.logs + ' logs to fetch)'); const kk = e.kind + (e.task ? ':' + e.task : '') + (e.why ? ':' + e.why : '') + (e.plan ? ':' + e.plan : ''); out[kk] = (out[kk] || 0) + 1; }
          return out;
        }, [Math.min(STEPS_PER_CALL, total - s), h, v]);
        for (const p of k._p || []) console.log('   project ' + p);
        delete k._p;
        for (const kk in k) kinds[kk] = (kinds[kk] || 0) + k[kk];
      }
      const after = await pg.evaluate(survey, key);
      const projects = await pg.evaluate(key => {
        const R = BF.mobs.list.find(m => m.village && m.village.key === key).village, D = BF.villageLife.vdata(R);
        return { beds: (D.beds || []).length, open: (D.projects || []).map(p => p.kind + (p.dir ? ':' + p.dir : '')), made: D.made || [] };
      }, key);
      if (process.env.DEBUG) console.log(await pg.evaluate(key => {
        const R = BF.mobs.list.find(m => m.village && m.village.key === key).village, D = BF.villageLife.vdata(R);
        return JSON.stringify({ projects: D.projects, farmers: BF.mobs.list.filter(m => m.village === R && m.profession === 'farmer').map(m => ({ idx: m.slot && m.slot.idx, site: m.jobsite, pos: [m.position.x | 0, m.position.y | 0, m.position.z | 0], inv: m.inv.filter(Boolean).map(s => BF.itemName(s.id) + 'x' + s.count).join(' '), haul: m.farm.haul, task: m.farm.task, avoid: Object.keys(m.farm.avoid).length, think: BF.villageLife.think(m, m.farm, R, D) })) }, null, 1);
      }, key));
      const row = { seed, key, farmers: setup.farmers, genFarms: before.genFarms, farmland0: before.farmland, stray0: before.stray, farmland: after.farmland, stray: after.stray, strays: after.strays, kinds, projects, secs: Math.round((Date.now() - t0) / 1000) };
      results.push(row);
      console.log(`seed ${seed} village ${key} farmers ${row.farmers} gen farms ${row.genFarms}: farmland ${row.farmland0} -> ${row.farmland}, stray ${row.stray0} -> ${row.stray} | beds ${projects.beds} made ${JSON.stringify(projects.made)} open ${JSON.stringify(projects.open)} (${row.secs}s)`);
      console.log('   tasks', JSON.stringify(kinds));
      if (OUT) fs.writeFileSync(path.join(OUT, `map-${seed}-${key}.txt`), `before\n${before.map}\n\nafter ${DAYS} days\n${after.map}\n`);
    }
    await pg.close();
  }
  const stray = results.reduce((n, r) => n + r.stray - r.stray0, 0);
  const made = results.flatMap(r => r.projects.made.map(p => p.kind));
  console.log(`SUMMARY: ${results.length} villages, new stray farmland ${stray}, beds made ${made.filter(k => k === 'new').length} new / ${made.filter(k => k === 'grow').length} grown`);
  if (OUT) fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  await b.close();
})();
