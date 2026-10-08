// Miner soak test: miners quarry surface stone or dig a mineshaft, and sell the cobblestone to the builders of their village.
// Usage: NODE_PATH=$(npm root -g) node test/minechain.js <seeds e.g. 1,2,3> [days=2] [villagesPerSeed=4] [out.json]
// OUTCROP=1 adds a stone hill (stepped sides and a cliff) beside each village and prints its heights afterwards (surface quarrying).
// PICK=<item> swaps the miner's pickaxe for that one. LEVEL=n starts each miner at level n (with that level's offers), to watch deeper shafts (js/miner.js DIG_DEPTH).
// Drives the simulation directly (no rendering), like test/bedchain.js: for each village near spawn with a miner and a builder it puts the
// player in the middle, lets the villagers spawn, then steps `days` game days and records the miner's log and every villager trade.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seeds = (process.argv[2] || '1337').split(',').map(Number);
const DAYS = +(process.argv[3] || 2);
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

(async () => {
  b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  for (const seed of seeds) {
    let pg = await openWorld(seed);
    const villages = await pg.evaluate(n => {
      const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
      return vs.slice(0, n * 3).map(v => ({ x: v.x, z: v.z, y: v.y, pop: v.pop, biome: v.biome }));
    }, PER_SEED);
    let done = 0;
    for (const v of villages) {
      if (done >= PER_SEED) break;
      if (process.env.ONLY && process.env.ONLY !== Math.round(v.x) + ',' + Math.round(v.z)) continue;
      const t0 = Date.now();
      if (pg.__used) { await pg.close(); pg = await openWorld(seed); }
      pg.__used = true;
      await pg.evaluate(key => {
        const R = window.__rec = { key, trades: [], log: [] };
        const inVillage = m => m && m.village && m.village.key === window.__rec.key;
        const day = () => +(BF.sky.day + BF.sky.time).toFixed(3);
        const orig = BF.vlog.trade;
        BF.vlog.trade = function (buyer, seller, o, times) {
          const r = window.__rec;
          if (r && o && o.sell && (inVillage(buyer) || inVillage(seller)))
            r.trades.push({ d: day(), buyer: buyer.profession || String(buyer), seller: seller.profession || String(seller), item: BF.itemName(o.sell.id), n: o.sell.n * (times || 1) });
          return orig.apply(this, arguments);
        };
        BF.miner.LOG.length = 0;
      }, Math.round(v.x) + "," + Math.round(v.z));
      await pg.evaluate(([t, v, b, o]) => { window.__TRACE = t; window.__TRACEV = v; window.__BOX = b; window.__OUTCROP = o[0]; window.__LEVEL = o[1]; window.__PICK = o[2]; }, [!!process.env.TRACE, process.env.TRACEV || null, !!process.env.BOX, [!!process.env.OUTCROP, +process.env.LEVEL || 0, process.env.PICK || null]]);
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
        const mi = mem.find(m => m.profession === "miner");
        let surf = 0;
        if (mi && window.__OUTCROP) {   // OUTCROP=1: a stone hill 10 blocks off the village's east edge (steps and a sheer side), to watch it quarried
          const b = BF.miner._test.area(mi).box, cx = b.maxX + 16, cz = Math.round((b.minZ + b.maxZ) / 2), W = BF.world;
          for (let x = cx - 7; x <= cx + 7; x++) for (let z = cz - 7; z <= cz + 7; z++) {
            const d = Math.max(Math.abs(x - cx), Math.abs(z - cz)), hgt = x > cx + 3 ? (d <= 7 ? 6 : 0) : Math.max(0, 7 - d);   // east third: a 6-high cliff
            const g = W.heightAt(x, z);
            for (let y = g + 1; y <= g + hgt; y++) W.setBlock(x, y, z, BF.B.stone);
          }
          window.__outcrop = [cx, cz];
        }
        if (mi && window.__LEVEL) { mi.level = window.__LEVEL; mi.xp = BF.trades.LEVEL_XP[mi.level - 1]; mi.trades = null; BF.inventory.ensureTrades(mi); }   // LEVEL=n: start the miner at level n
        if (mi && window.__PICK) { mi.inv = mi.inv.map(s => s && BF.items[s.id].tool && BF.items[s.id].tool.type === 'pickaxe' ? null : s); BF.trades.inv.add(mi.inv, BF.I[window.__PICK], 1); }   // PICK=diamond_pickaxe: swap its pickaxe
        if (mi) { surf = BF.miner.scanSurface(mi, BF.miner._test.state(mi)).length; }
        const bld = mem.filter(m => m.profession === "builder").map(m => BF.trades.inv.count(m.inv, BF.I.cobblestone));
        return { key, profs, surf, builderCobble: bld, style: mem[0] && mem[0].village.style };
      }, v);
      const p = setup.profs;
      if (!p.miner || !p.builder) { console.log(`seed ${seed} village ${setup.key} pop ${v.pop}: skipped (${JSON.stringify(p)})`); continue; }
      done++;
      const STEPS_PER_CALL = 4000, h = 0.05, total = Math.round(DAYS * 1200 / h);
      for (let s = 0; s < total; s += STEPS_PER_CALL) {
        await pg.evaluate(([n, h, v]) => {
          const R = window.__rec;
          for (let i = 0; i < n; i++) {
            BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim();
            if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
            if (window.__TRACE && i % 40 === 0) {
              const mi = BF.mobs.list.find(m => m.profession === "miner" && m.village && m.village.key === (window.__TRACEV || R.key));
              if (mi) { const Q = mi.mi || {}, k = Q.task; (R.trace = R.trace || []).push([+(BF.sky.day + BF.sky.time).toFixed(3), k && k.kind, [+mi.position.x.toFixed(1), +mi.position.y.toFixed(1), +mi.position.z.toFixed(1)], Q.shaft ? [Q.shaft.x, Q.shaft.y, Q.shaft.z, Q.shaft.n] : null, Q.shaft ? BF.miner._test.shaftCellOf(mi, Q.shaft) : null, mi.ai.route ? mi.ai.route.length + ":" + mi.ai.ri : null, mi.ai.routeKind, Q.t && +Q.t.toFixed(1), mi.position.y, Q.status, mi.fshop && mi.fshop.stage, +(mi.ai.fleeT || 0).toFixed(1), mi.sleeping ? "zz" : "", mi.ai.mode, Q.thinkT && +Q.thinkT.toFixed(1)]); }
            }
          }
          R.log.push(...BF.miner.LOG.splice(0));
        }, [Math.min(STEPS_PER_CALL, total - s), h, v]);
      }
      const res = await pg.evaluate(key => {
        const R = window.__rec;
        const mem = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === key && !m.dead);
        const mi = mem.filter(m => m.profession === "miner");
        const probe = mi.map(m => { const sh = m.mi && m.mi.shaft; if (!sh) return null; const o = []; for (let i = 0; i <= 3; i++) { const x = sh.x + sh.dx * i, z = sh.z + sh.dz * i; o.push(i + ":" + [-2, -1, 0, 1, 2, 3].map(dy => BF.itemName(BF.world.getBlock(x, sh.y - i + dy, z))).join(",")); } return o; });
        let box = null;
        if (window.__outcrop) { const [cx, cz] = window.__outcrop; box = ["outcrop heights (east is right; . = no stone on top)"]; for (let z = cz - 8; z <= cz + 8; z++) { let r = ""; for (let x = cx - 8; x <= cx + 8; x++) { const y = BF.world.heightAt(x, z), id = BF.world.getBlock(x, y, z); r += BF.itemName(id) === "Stone" ? String(y % 10) : "."; } box.push(r); } }
        if (window.__BOX && !box) { const m0 = mi[0], px = Math.floor(m0.position.x), py = Math.floor(m0.position.y), pz = Math.floor(m0.position.z); box = []; for (let y = py + 2; y >= py - 1; y--) { box.push("y" + y + " x" + (px - 8) + ".." + (px + 8)); for (let z = pz - 4; z <= pz + 4; z++) { let r = (z + "").padStart(5) + " "; for (let x = px - 8; x <= px + 8; x++) { const b = BF.world.getBlock(x, y, z), n = BF.itemName(b); r += x === px && z === pz ? "@" : b === 0 ? "." : n.includes("Torch") ? "t" : n.includes("Cobble") ? "c" : n.includes("Stone") || n.includes("Deepslate") ? "#" : n.charAt(0); } box.push(r); } } }
        return { box, probe, R, miners: mi.map(m => ({ inv: m.inv.filter(Boolean).map(s => BF.itemName(s.id) + "x" + s.count + (s.wear ? "(wear " + s.wear + ")" : "")).join(" "), status: BF.miner.statusText(m), shaft: m.mi && m.mi.shaft ? { n: m.mi.shaft.n, S: m.mi.shaft.S, done: m.mi.shaft.done } : null, shafts: m.mi && m.mi.shafts, pos: [m.position.x | 0, m.position.y | 0, m.position.z | 0], L: m.level, xp: m.xp, D: m.mi && m.mi.shaft ? m.mi.shaft.D : null })),
          builders: mem.filter(m => m.profession === "builder").map(m => "cobble " + BF.trades.inv.count(m.inv, BF.I.cobblestone) + " em " + BF.trades.inv.count(m.inv, BF.I.emerald)) };
      }, setup.key);
      const L = res.R.log.filter(e => e.village === setup.key), others = res.R.log.length - L.length, kinds = {};
      for (const e of L) { const k = e.kind + (e.why ? ":" + e.why : ""); kinds[k] = (kinds[k] || 0) + 1; }
      const T = res.R.trades;
      const sales = T.filter(t => t.seller === "miner" && t.item === "Cobblestone");
      const toBuilders = sales.filter(t => t.buyer === "builder").reduce((n, t) => n + t.n, 0);
      const minerBuys = T.filter(t => t.buyer === "miner").map(t => t.n + " " + t.item + " from " + t.seller);
      const row = { seed, key: setup.key, pop: v.pop, style: setup.style, profs: p, surfaceStone: setup.surf, builderCobbleStart: setup.builderCobble, kinds, toBuilders, minerBuys, miners: res.miners, builders: res.builders, secs: Math.round((Date.now() - t0) / 1000) };
      results.push(row);
      console.log(`seed ${seed} village ${row.key} pop ${row.pop} style ${row.style} surface stone ${row.surfaceStone}: quarried ${kinds.quarry || 0}, shaft cells ${(kinds.skip || 0)} skipped, sold ${toBuilders} cobblestone to builders (${row.secs}s)`);
      console.log('   log', JSON.stringify(kinds), others ? '(+' + others + ' entries from miners of other villages ' + [...new Set(res.R.log.filter(e => e.village !== setup.key).map(e => e.village))].join(' ') + ')' : '');
      console.log('   miners', JSON.stringify(res.miners));
      if (process.env.TRACE) console.log('   shaft blocks (dy -2..3 per step)', JSON.stringify(res.probe));
      console.log('   builders start', JSON.stringify(setup.builderCobble), 'end', JSON.stringify(res.builders), 'miner bought', JSON.stringify(minerBuys));
      if (res.box) for (const l of res.box) console.log('   |' + l);
      if (process.env.LOGN) for (const e of L.slice(0, +process.env.LOGN)) console.log('    log', JSON.stringify(e));
      if (process.env.TRACE) for (const t of (res.R.trace || []).slice(0, +process.env.TRACE || 200)) console.log('    ', JSON.stringify(t));
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    }
    await pg.close();
  }
  const sold = results.filter(r => r.toBuilders > 0).length;
  console.log(`SUMMARY: miners sold cobblestone to builders in ${sold}/${results.length} villages in ${DAYS} days`);
  await b.close();
})();
