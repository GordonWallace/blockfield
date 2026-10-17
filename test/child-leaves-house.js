// Bred children walk out of their house in the morning after a night in a house bed (bug-035).
// Usage: NODE_PATH=$(npm root -g) node test/child-leaves-house.js [seed=1337]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 1337);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed);
  await pg.waitForTimeout(4000);
  const v = await pg.evaluate(() => {
    window.__halt = true; BF.player.setGameMode('creative');
    const v = BF.worldgen.nearestVillage(0, 0);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) window.__step(0.05); }
    BF.mobs.spawning = false;
    const rec = BF.mobs.villages.get(Math.round(v.x) + "," + Math.round(v.z));
    const ad = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child);
    const kids = [];
    for (let i = 0; i + 1 < ad.length && kids.length < 3; i += 2) { const c = BF.breeding.forceBirth(ad[i], ad[i + 1]); if (c) kids.push(c); }
    window.__kids = kids; window.__seen = kids.map(() => ({ slept: false, outAfter: false }));
    return { x: v.x, z: v.z, kids: kids.length };
  });
  console.log(JSON.stringify(v));
  let last;
  for (let k = 0; k < 13; k++) {   // to mid-morning of day 1, a sample every 0.1 day
    last = await pg.evaluate(([v]) => {
      for (let i = 0; i < 2400; i++) {
        window.__step(0.05); if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
        if (i % 20) continue;
        window.__kids.forEach((m, j) => {
          const s = window.__seen[j], b = m.bed, rec = m.village;
          if (m.sleeping) s.slept = true;
          const H = b && rec && (rec.houses || []).find(h => h && h.w && b.x >= h.x && b.x < h.x + h.w && b.z >= h.z && b.z < h.z + h.d);
          if (!H) return;
          if (m.sleeping) s.house = true;
          const inside = m.position.x >= H.x && m.position.x <= H.x + H.w && m.position.z >= H.z && m.position.z <= H.z + H.d;
          if (s.slept && !m.sleeping && !inside && m.child) s.outAfter = true;
        });
      }
      return { day: +(BF.sky.day + BF.sky.time).toFixed(2), seen: window.__seen };
    }, [v]);
  }
  console.log(JSON.stringify(last));
  const tested = last.seen.filter(s => s.house);
  console.log((tested.length ? 'PASS ' : 'FAIL ') + `${tested.length} children slept in a house bed`);
  console.log((tested.length && tested.every(s => s.outAfter) ? 'PASS ' : 'FAIL ') + `children walked out of their house after sleeping: ${tested.filter(s => s.outAfter).length}/${tested.length}`);
  await b.close();
})();
