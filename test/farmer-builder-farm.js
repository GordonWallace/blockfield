// @ci integration suite=farming timeout=600
// bug-057: a vegetable farm a builder made is left untilled (the farmer does that), so it holds no farmland for the farm scan to find it by;
// farmers used to walk past it and lay out beds of their own. Now the scan finds builders' farms by their entries, and a farmer whose reach
// takes one in tills all of its soil (grass too) before it makes a new bed, and the village log says so once.
// A farmer carrying pumpkin seeds used to plant that untilled soil as a pumpkin patch first, and the stems kept the hoe off it.
// Usage: NODE_PATH=$(npm root -g) node test/farmer-builder-farm.js [seed=1337] [days=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 1337), DAYS = +(process.argv[3] || 1);
let fails = 0;
const check = (ok, msg, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await pg.waitForTimeout(3000);

  const vs = await pg.evaluate(() => {
    window.__halt = true;
    BF.player.setGameMode && BF.player.setGameMode('creative');
    return BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop && (v.buildings || []).length >= 6).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 8).map(v => ({ x: v.x, z: v.z, y: v.y }));
  });
  let setup = null;
  for (const v of vs) {
    setup = await pg.evaluate(v => {
      const key = Math.round(v.x) + "," + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      const f = BF.mobs.list.find(m => m.type === "villager" && m.village && m.village.key === key && !m.dead && m.profession === "farmer" && m.jobsite);
      if (!f) return null;
      const R = f.village, s = f.jobsite, W = BF.world, BP = BF.blueprints, Bd = BF.builder;
      const bp = BP.get("veg_farm", 0, 0, 0.5, null, "oak");
      const D = BF.villageLife.vdata(R);
      // a flat spot for a builder's farm whose ring lies inside the farmer's reach, clear of buildings and beds
      let site = null;
      for (let r = 3; r <= 12 && !site; r++) for (let dx = -r; dx <= r && !site; dx++) for (const dz of [-r, r]) {
        for (const [px, pz] of [[s.x + dx, s.z + dz], [s.x + dz, s.z + dx]]) {
          if (site) break;
          const t = Bd.evalTerrain(bp, px, pz, BF.B.dirt);
          if (!t || t.fill.length > 4) continue;
          let clear = true;
          for (let x = px - 2; x < px + bp.w + 2 && clear; x++) for (let z = pz - 2; z < pz + bp.d + 2; z++) {
            const g = W.heightAt(x, z), id = W.getBlock(x, g, z), n = BF.blocks[id].name;
            if (!/^(grass|dirt|sand|snow_grass|podzol|coarse_dirt)$/.test(n) || Math.abs(g - (t.oy - 1)) > 1) { clear = false; break; }
          }
          if ((R.wg.buildings || []).some(b => b.x0 <= px + bp.w + 2 && b.x1 >= px - 2 && b.z0 <= pz + bp.d + 2 && b.z1 >= pz - 2)) clear = false;
          if (clear) site = { px, pz, t };
        }
      }
      if (!site) return null;
      // the farm as a builder leaves it: entry done, every block in (the soil untilled)
      const built = Bd.builtOf(R);
      const e = { id: 9000, type: "veg_farm", label: bp.label, rot: 0, style: 0, wood: "oak", h: 0.5, ox: site.px, oy: site.t.oy, oz: site.pz, w: bp.w, d: bp.d, prog: 0, skipped: 0, state: "building", owner: 0, fill: site.t.fill, start: 0 };
      e.n = e.fill.length + bp.n;
      built.push(e);
      for (let i = 0; i < e.n; i++) { const c = Bd.cellOf(e, i); W.setBlock(c.x, c.y, c.z, c.id === BF.B.composter ? 0 : c.id); }   // no second composter: the farmer works from its own
      for (let x = e.ox; x < e.ox + e.w; x++) for (let z = e.oz; z < e.oz + e.d; z++) { const y = e.oy; if (BF.RENDER[W.getBlock(x, y, z)] === 4) W.setBlock(x, y, z, 0); }   // no grass on the soil
      e.prog = e.n; e.state = "done";
      for (const n of ["wooden_hoe", "bucket"]) if (!f.inv.some(q => q && BF.items[q.id].name === n)) BF.trades.inv.add(f.inv, BF.I[n], 1);
      for (const p of D.projects.filter(p => p.owner === (f.slot ? f.slot.idx : -1))) D.projects.splice(D.projects.indexOf(p), 1);   // nothing under way
      D.scanT = 0; D.scan = null;
      BF.sky.setTime(0.02);
      BF.villageLife.log.length = 0;
      return { key, ox: e.ox, oy: e.oy, oz: e.oz, w: e.w, d: e.d, farmer: f.slot ? f.slot.idx : -1, v };
    }, v);
    if (setup) break;
  }
  check(!!setup, 'a farmer and a builder\'s farm within its reach', setup);
  if (!setup) { await b.close(); process.exit(1); }

  const soil = () => pg.evaluate(S => {
    const W = BF.world, B = BF.B, y = S.oy - 1, R = BF.mobs.list.find(m => m.village && m.village.key === S.key).village;
    const e = BF.builder.builtOf(R).find(x => x.id === 9000), mk = BF.builder.bpOf(e).marks.soil;
    const out = { farm: 0, untilled: 0, n: mk.length };
    out.pumpkins = 0;   // stems or pumpkins on its soil: a builder's farm has no pumpkin patch (js/baker.js), they would keep the hoe off it
    for (const [u, q] of mk) { const id = W.getBlock(S.ox + u, y, S.oz + q), a = W.getBlock(S.ox + u, y + 1, S.oz + q); if (id === B.farmland || id === B.farmland_dry) out.farm++; else out.untilled++; if (a === B.pumpkin || a === B.pumpkin_stem) out.pumpkins++; }
    const D = BF.villageLife.vdata(R);
    out.detected = (D.beds || []).some(bd => bd.built && bd.built.id === 9000);
    out.tilledMark = e.tilled != null;
    return out;
  }, setup);
  const h = 0.05, total = Math.round(DAYS * 1200 / h), kinds = {}, seq = [];
  for (let s = 0; s < total; s += 4000) {
    const k = await pg.evaluate(([n, h, v]) => {
      for (let i = 0; i < n; i++) { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); if (i % 50 === 0) BF.world.update(v.x, v.z, 4); }
      const out = { seq: [] };
      for (const e of BF.villageLife.log.splice(0)) {
        if (e.kind === 'project' || e.kind === 'bedDone' || e.kind === 'bedDropped') out.seq.push(e.who + '|' + e.kind + ':' + e.plan); const kk = e.kind + (e.plan ? ':' + e.plan : '') + (e.built ? ':built' : '') + (e.why ? ':' + e.task + ':' + e.why : ''); out[kk] = (out[kk] || 0) + 1; }
      return out;
    }, [Math.min(4000, total - s), h, setup.v]);
    for (const kk in k) if (kk === 'seq') seq.push(...k.seq); else kinds[kk] = (kinds[kk] || 0) + k[kk];
  }
  const after = await soil();
  const lines = await pg.evaluate(k => BF.vlog.entries(k).filter(x => x[1] === "farm").map(x => x[2]).filter(t => /builders' vegetable farm/.test(t)), setup.key);
  console.log('tasks', JSON.stringify(kinds), JSON.stringify(seq));
  check(after.detected, 'the farm scan finds the builder\'s farm as a bed', after);
  check((kinds['project:repair:built'] || 0) > 0, 'the farmer takes it on as a project', kinds);
  const rep = seq.find(x => /\|project:repair$/.test(x)), who = rep && rep.split('|')[0], mine = seq.filter(x => x.split('|')[0] === who).map(x => x.split('|')[1]);
  const iNew = mine.indexOf('project:new'), iDone = mine.indexOf('bedDone:repair');
  check(mine[0] === 'project:repair' && (iNew < 0 || (iDone >= 0 && iDone < iNew)), 'the farmer\'s first project is the builder\'s farm, and it makes no new bed before that is done', seq);
  check(after.farm >= after.n - 3, 'its soil is tilled (but for up to 3 cane spots by the water, js/baker.js)', after);
  check(lines.length === 1 && after.tilledMark, 'the village log says so, once', lines);
  check(after.pumpkins === 0, 'no pumpkins planted on the builder\'s farm (its soil is all for tilling)', after);
  console.log(fails ? `FAILED ${fails}` : 'ALL OK');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
