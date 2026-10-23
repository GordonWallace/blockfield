// The game's own frame loop at the top fast-forward speed, with drawing (software GL here). Usage:
//   NODE_PATH=$(npm root -g) node tools/perf/live.js [repoDir=.] [variant=all] [seed=1] [secs=60] [WxH=800x450]
// variant: all | nohostile | noanimals | nowild. After 20 s at 1x and a 30 s warm-up at top speed, it reads the villager-seconds meter
// (js/perf.js) every 5 s for secs seconds: V·s/s, game speed (game s per real s), ms per step and the split, plus frames per second.
const path = require('path');
const H = require('./lib');
const [repo = '.', variant = 'all', SEED = '1', SECS = '60', SIZE = '800x450'] = process.argv.slice(2);
if (/noanim/.test(variant)) { console.error('live.js takes all, nohostile, noanimals or nowild'); process.exit(2); }

(async () => {
  const { b, pg } = await H.boot(repo, { seed: +SEED, variant, size: SIZE.split('x').map(Number) });
  await pg.evaluate(() => {
    for (const c of document.querySelectorAll('canvas')) c.requestPointerLock = null;   // drag mode: no pointer lock in headless
    try { BF.player.start(); } catch (e) { console.log('start failed', e.message); }
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    if (window.__noHostile) BF.mobs.spawning = false;
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 33, v.z + 0.5);
    if (BF.player.setFlying) BF.player.setFlying(true);
    const wild = m => BF.mobs.isWild(m) || (m.type === 'horse' && m.horse && !m.horse.owner && !m.horse.tamed);
    setInterval(() => { for (const m of BF.mobs.list.slice()) { if (m.dead || m.removed) continue; const h = m.hostile || (m.def && m.def.hostile);
      if ((window.__noHostile && h) || (window.__noAnimals && !h && m.type !== 'villager' && wild(m))) BF.mobs.__remove(m); } }, 500);
  });
  await pg.waitForTimeout(20000);   // load at 1x
  await pg.evaluate(() => { BF.state.paused = false; BF.warp.set(BF.warp.SPEEDS.length - 1); BF.perf.ask(true); });
  await pg.waitForTimeout(30000);   // warm up at top speed
  const reads = [];
  for (let t = 0; t < +SECS; t += 5) {
    await pg.waitForTimeout(5000);
    const r = await pg.evaluate(() => ({ s: BF.perf.stats(), fps: BF.debugInfo().fps, warp: BF.warp.speed, mobs: BF.mobs.list.length }));
    reads.push(r);
    console.log(`${t + 5}s ${Math.round(r.s.vss)} V·s/s  ${r.s.speed.toFixed(1)}x of ${r.warp}x  ${r.s.msPerStep.toFixed(2)} ms/step  ${r.fps} fps  ${r.s.villagers} villagers, ${r.mobs} mobs | ${H.fmtSplit(r.s.split)}`);
  }
  const avg = k => reads.reduce((a, r) => a + r.s[k], 0) / reads.length;
  console.log(`${path.basename(path.resolve(repo))} ${variant} seed ${SEED} ${SIZE}: ${Math.round(avg('vss'))} V·s/s, ${avg('speed').toFixed(1)}x, ${avg('msPerStep').toFixed(2)} ms/step (average of ${reads.length} readings)`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
