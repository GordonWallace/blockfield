// Bed supply chain soak test: foresters fell and saw wood, shepherds shear wool, the furniture maker buys both and makes beds, builders buy the beds.
// Usage: NODE_PATH=$(npm root -g) node test/bedchain.js <seeds e.g. 1,2,3> [days=3] [villagesPerSeed=6] [out.json]
// Drives the simulation directly (no rendering): for each village near spawn that has a forester, a shepherd, a furniture maker and a builder,
// it puts the player in the middle, lets the villagers spawn, then steps the world `days` game days and records every villager trade,
// shearing, felling, sawing and bed craft. Prints one line per village and a JSON summary.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seeds = (process.argv[2] || '1337').split(',').map(Number);
const DAYS = +(process.argv[3] || 3);
const PER_SEED = +(process.argv[4] || 6);
const OUT = process.argv[5] || null;

let b;
async function openWorld(seed) {
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  pg.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 300)); });
  // stop the render loop once the game is up: the test steps the simulation itself
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed);
  await pg.waitForTimeout(3000);
  await pg.evaluate(t => { window.__TRACE = t; }, !!process.env.TRACE);
  return pg;
}

(async () => {
  b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  for (const seed of seeds) {
    let pg = await openWorld(seed);
    const villages = await pg.evaluate(n => {
      window.__halt = true;
      if (BF.player.setGameMode) BF.player.setGameMode('creative');
      const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
      return vs.slice(0, n * 3).map(v => ({ x: v.x, z: v.z, y: v.y, pop: v.pop, biome: v.biome, nb: (v.buildings || []).length }));
    }, PER_SEED);
    let done = 0;
    for (const v of villages) {
      if (done >= PER_SEED) break;
      if (process.env.ONLY && process.env.ONLY !== Math.round(v.x) + ',' + Math.round(v.z)) continue;
      const t0 = Date.now();
      // a fresh page per village: neighbouring villages within the far-village simulation range would otherwise have run already
      if (done || pg.__used) { await pg.close(); pg = await openWorld(seed); await pg.evaluate(() => { window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative'); }); }
      pg.__used = true;
      // ---- recorder (before the villagers spawn: a furniture maker short of stock shops right away)
      await pg.evaluate(key => {
        const R = window.__rec = { key, trades: [], shorn: 0, shornBy: 0, crafts: 0, fells: 0, saws: 0, sweeps: 0, sold: 0, firstCraftFromBought: null, events: [], built: [], giveups: {}, fo: {}, trace: [] };
        const inVillage = m => m && m.village && window.__rec && m.village.key === window.__rec.key;
        const day = () => +(BF.sky.day + BF.sky.time).toFixed(3);
        if (!window.__hooked) {
          window.__hooked = true;
          const orig = BF.vlog.trade;
          BF.vlog.trade = function (buyer, seller, o, times) {
            const r = window.__rec;
            if (r && typeof o === "object" && o && o.sell && (inVillage(buyer) || inVillage(seller)))
              r.trades.push({ d: day(), buyer: buyer.profession || String(buyer), seller: seller.profession || String(seller), item: BF.itemName(o.sell.id), n: o.sell.n * (times || 1) });
            return orig.apply(this, arguments);
          };
          BF.on("builderDone", (m, e) => { const r = window.__rec; if (r && inVillage(m)) r.built.push(e.type); });
          BF.on("sheepShorn", (m, by) => { const r = window.__rec; if (r) { r.shorn++; if (by && by.profession === "shepherd") r.shornBy++; } });
        }
        window.__trace = !!window.__TRACE; window.__fLog = BF.forester.LOG.length = 0; BF.furniture.LOG.length = 0;
      }, Math.round(v.x) + "," + Math.round(v.z));
      // ---- load the village and let its villagers spawn
      const setup = await pg.evaluate(v => {
        const key = Math.round(v.x) + "," + Math.round(v.z);
        BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
        const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
        for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
        BF.sky.setTime(0.02);
        for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
        const mem = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === key && !m.dead);
        const profs = {};
        for (const m of mem) profs[m.profession] = (profs[m.profession] || 0) + 1;
        const rec = mem[0] && mem[0].village;
        const roster = rec && rec.roster ? rec.roster.length : 0;
        // trees: natural logs within 40 blocks of the village box (the forester's search radius), surface band only
        const wg = rec && rec.wg, x0 = (wg ? wg.minX : v.x - 40) - 40, x1 = (wg ? wg.maxX : v.x + 40) + 40, z0 = (wg ? wg.minZ : v.z - 40) - 40, z1 = (wg ? wg.maxZ : v.z + 40) + 40;
        // trees (what a forester can fell: BF.forester.treeAt) standing within 40 blocks of the village box
        let logs = 0;
        const LOG = new Set(Object.keys(BF.B).filter(n => /^(oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_log$/.test(n)).map(n => BF.B[n]));
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          if (!BF.world.isLoaded(x, z)) continue;
          const hy = BF.world.heightAt(x, z);
          for (let y = hy - 12; y <= hy; y++) if (LOG.has(BF.world.getBlock(x, y, z)) && !LOG.has(BF.world.getBlock(x, y - 1, z)) && BF.forester.treeAt(x, y, z)) { logs++; break; }
        }
        const pens = BF.shepherd && rec ? BF.shepherd.pensOf(rec) : [];
        const invOf = prof => mem.filter(m => m.profession === prof).map(m => m.inv.filter(Boolean).map(s => BF.itemName(s.id) + 'x' + s.count).join(' '));
        return { fmInv: invOf('furniture_maker'), bInv: invOf('builder'), key, profs, roster, nMem: mem.length, logs, pens: pens.length, penSheep: pens.reduce((n, p) => n + p.sheep.length, 0) };
      }, v);
      const p = setup.profs;
      const eligible = p.forester && p.shepherd && p.furniture_maker && p.builder;
      if (!eligible) { console.log(`seed ${seed} village ${setup.key} pop ${v.pop}: skipped (${JSON.stringify(p)})`); continue; }
      done++;
      if (process.env.DEBUG) console.log('   after spawn: FM', JSON.stringify(setup.fmInv), 'builders', JSON.stringify(setup.bInv));
      const STEPS_PER_CALL = 4000, h = 0.05, total = Math.round(DAYS * 1200 / h);
      for (let s = 0; s < total; s += STEPS_PER_CALL) {
        await pg.evaluate(([n, h, v]) => {
          const R = window.__rec;
          for (let i = 0; i < n; i++) {
            BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim();
            if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
          }
          // drain the module logs (they keep 200 entries)
          for (const e of BF.forester.LOG.splice(0)) { if (e.kind === "fell") R.fells++; else if (e.kind === "saw") R.saws++; else if (e.kind !== "pickup") { const k = e.kind + (e.why ? ":" + e.why : e.reason ? ":" + e.reason : ""); R.fo[k] = (R.fo[k] || 0) + 1; } }
          const inVillage = m => m && m.village && m.village.key === R.key;
          if (window.__trace) { const fm = BF.mobs.list.find(m => m.profession === "furniture_maker" && inVillage(m)); const fo = BF.mobs.list.filter(m => m.profession === "forester" && inVillage(m)); R.trace.push([+(BF.sky.day + BF.sky.time).toFixed(2), fm ? [BF.furniture.statusText(fm), fm.job && fm.job.mode, fm.jobsite ? Math.round(Math.hypot(fm.position.x - fm.jobsite.x, fm.position.z - fm.jobsite.z)) : -1, fm.inv.filter(Boolean).map(s => BF.itemName(s.id) + s.count).join(',')] : null, fo.map(f => [BF.forester.statusText(f), f.fo && f.fo.task && f.fo.task.kind])]); }
          for (const e of BF.furniture.LOG.splice(0)) { if (e.kind === "craft" && e.made !== "planks") R.crafts++; if (e.kind === "giveup") { const k = e.to + ":" + e.item + ":" + e.why; R.giveups[k] = (R.giveups[k] || 0) + 1; } }
        }, [Math.min(STEPS_PER_CALL, total - s), h, v]);
      }
      const res = await pg.evaluate(key => {
        const R = window.__rec;
        const mem = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === key && !m.dead);
        const inv = (prof, re) => mem.filter(m => m.profession === prof).map(m => m.inv.filter(Boolean).filter(s => re.test(BF.itemName(s.id))).map(s => BF.itemName(s.id) + "x" + s.count).join(" "));
        const st = prof => mem.filter(m => m.profession === prof).map(m => {
          const t = (BF.furniture && BF.furniture.statusText(m)) || (BF.forester && BF.forester.statusText(m)) || (BF.villageLife && BF.villageLife.statusText(m)) || "";
          return t + " em" + BF.trades.inv.count(m.inv, BF.I.emerald) + " L" + (m.level || 1) + (m.jobsite ? " site" : " nosite");
        });
        return { R, end: { forester: inv("forester", /log|planks|sapling/i), shepherd: inv("shepherd", /wool|shears|wheat/i), furniture: inv("furniture_maker", /wool|planks|log|bed|emerald/i), builder: inv("builder", /bed|emerald/i) },
          status: { forester: st("forester"), shepherd: st("shepherd"), furniture_maker: st("furniture_maker"), builder: st("builder") } };
      }, setup.key);
      const T = res.R.trades;
      const has = f => T.filter(f);
      const woolBuys = has(t => t.buyer === "furniture_maker" && t.seller === "shepherd");
      const woodBuys = has(t => t.buyer === "furniture_maker" && t.seller === "forester");
      const bedSales = has(t => t.buyer === "builder" && t.seller === "furniture_maker");
      const firstIn = Math.max(woolBuys.length ? woolBuys[0].d : Infinity, woodBuys.length ? woodBuys[0].d : Infinity);
      const chainSales = bedSales.filter(t => t.d > firstIn);   // a bed sale after the furniture maker had bought from both
      const row = {
        seed, key: setup.key, pop: v.pop, biome: v.biome, profs: p, logsNear: setup.logs, pens: setup.pens, penSheep: setup.penSheep,
        built: res.R.built.join(','), fells: res.R.fells, saws: res.R.saws, shorn: res.R.shorn, shornByShepherd: res.R.shornBy,
        woolBuys: woolBuys.reduce((n, t) => n + t.n, 0), woodBuys: woodBuys.reduce((n, t) => n + t.n, 0), crafts: res.R.crafts,
        bedsSold: bedSales.reduce((n, t) => n + t.n, 0), chainBedsSold: chainSales.reduce((n, t) => n + t.n, 0),
        full: !!(woolBuys.length && woodBuys.length && res.R.crafts && chainSales.length),
        otherTrades: Object.entries(T.reduce((a, t) => { const k = t.buyer + "<-" + t.seller + ":" + t.item; a[k] = (a[k] || 0) + t.n; return a; }, {})).filter(([k]) => /furniture|forester|shepherd|builder/.test(k)).slice(0, 30),
        giveups: res.R.giveups, end: res.end, status: res.status, secs: Math.round((Date.now() - t0) / 1000),
      };
      results.push(row);
      console.log(`seed ${seed} village ${row.key} pop ${row.pop} trees ${row.logsNear} pens ${row.pens} sheep ${row.penSheep}: fell ${row.fells} saw ${row.saws} shorn ${row.shornByShepherd}/${row.shorn} | FM bought wool ${row.woolBuys} wood ${row.woodBuys} | crafted ${row.crafts} | sold ${row.bedsSold} (chain ${row.chainBedsSold}) | built ${row.built || '-'} | ${row.full ? "FULL CHAIN" : "broken"} (${row.secs}s)`);
      console.log('   giveups', JSON.stringify(row.giveups), 'forester', JSON.stringify(res.R.fo)); if (process.env.TRACE) for (const t of res.R.trace) console.log('   ', JSON.stringify(t)); console.log('   end', JSON.stringify(row.end), JSON.stringify(row.status));
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    }
    await pg.close();
  }
  const full = results.filter(r => r.full).length;
  console.log(`SUMMARY: ${full}/${results.length} villages completed the full chain in ${DAYS} days`);
  await b.close();
})();
