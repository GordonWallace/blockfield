// @ci integration hosts=worker,server
// Bred children walk out of their house in the morning after a night in a house bed (bug-035).
// Usage: NODE_PATH=$(npm root -g) node test/child-leaves-house.js [seed=1337]   (BF_HOST=page|worker|server: where the simulation runs, spec r15-43)
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 1337);
const lib = require('./lib');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await lib.install(pg);
  const srv = lib.host() === 'page' ? null : await lib.serve({ world: lib.host() === 'server' });
  await pg.goto(srv ? srv.url + '?nolod&' + lib.q() + '#seed' + seed : 'file://' + path.join(root, 'index.html') + '#seed' + seed);
  await lib.ready(pg);   // the planet (spec r14-22): its river step first
  if (srv) await lib.simReady(pg);
  await pg.waitForTimeout(4000);
  // the page's player goes to the village nearest the spawn (0,0 is off the planet's atlas); the simulation's follows it (spec r15-43)
  await lib.simBFT(pg);
  const vv = await lib.sim(pg, () => { const v = BFT.villages(3000)[0]; return { x: v.x, y: v.y, z: v.z }; });   // (the world's spawn as the simulation has it)
  const at = await pg.evaluate(v => {
    BF.player.setGameMode('creative');
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    return { x: v.x, z: v.z };
  }, vv);
  for (let i = 0; i < 60 && !(await lib.sim(pg, a => Math.hypot(BF.player.position.x - a.x, BF.player.position.z - a.z) < 20, at)); i++) await pg.waitForTimeout(500);
  await pg.evaluate(() => { window.__halt = true; });   // (the page's frames stop: in the page, the simulation's too)
  const v = await lib.sim(pg, a => {
    BF.state.paused = true;   // (the simulation's own ticks stop, where it is not the page's frames: the steps below run it)
    const v = a;
    globalThis.__step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) globalThis.__step(0.05); }
    BF.mobs.spawning = false;
    const rec = BF.mobs.villages.get(Math.round(v.x) + "," + Math.round(v.z));
    const ad = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child);
    const kids = [];
    // Each parent pays 5 bread-eq for a birth (js/breeding.js birth); how much an adult holds this early is down to what it ate and sold
    // since the village loaded (often 4-6), so the parents get bread first, as in villagelog.js.
    for (let i = 0; i + 1 < ad.length && kids.length < 3; i += 2) {
      for (const m of [ad[i], ad[i + 1]]) BF.trades.inv.add(m.inv, BF.I.bread, 20);
      const c = BF.breeding.forceBirth(ad[i], ad[i + 1]); if (c) kids.push(c);
    }
    globalThis.__kids = kids; globalThis.__seen = kids.map(() => ({ slept: false, outAfter: false }));
    return { x: v.x, z: v.z, kids: kids.length, adults: ad.length };
  }, at);
  console.log(JSON.stringify(v));
  let last;
  for (let k = 0; k < 13; k++) {   // to mid-morning of day 1, a sample every 0.1 day
    last = await lib.sim(pg, ([v]) => {
      for (let i = 0; i < 2400; i++) {
        globalThis.__step(0.05); if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
        if (i % 20) continue;
        globalThis.__kids.forEach((m, j) => {
          const s = globalThis.__seen[j], b = m.bed, rec = m.village;
          if (m.sleeping) s.slept = true;
          const H = b && rec && (rec.houses || []).find(h => h && h.w && b.x >= h.x && b.x < h.x + h.w && b.z >= h.z && b.z < h.z + h.d);
          if (!H) return;
          if (m.sleeping) s.house = true;
          const inside = m.position.x >= H.x && m.position.x <= H.x + H.w && m.position.z >= H.z && m.position.z <= H.z + H.d;
          if (s.slept && !m.sleeping && !inside && m.child) s.outAfter = true;
        });
      }
      return { day: +(BF.sky.day + BF.sky.time).toFixed(2), seen: globalThis.__seen };
    }, [v]);
  }
  console.log(JSON.stringify(last));
  const tested = last.seen.filter(s => s.house);
  console.log((tested.length ? 'PASS ' : 'FAIL ') + `${tested.length} children slept in a house bed`);
  console.log((tested.length && tested.every(s => s.outAfter) ? 'PASS ' : 'FAIL ') + `children walked out of their house after sleeping: ${tested.filter(s => s.outAfter).length}/${tested.length}`);
  await b.close();
  if (srv) await srv.stop();
})();
