// @ci integration suite=world,village timeout=900
// The simulation decides the same on a fast and a slow computer (spec r15-16). Usage: NODE_PATH=$(npm root -g) node test/sim-cpu-speed.js [ticks=2000] [seed=123]
// (SLOW_MS=0 runs the slow page at full speed too: a plain same-seed-twice check)
// Two fresh pages boot the same world with the frame loop halted, the same seeded Math.random and a fake performance.now that moves 1 us
// a read. Each then loads the nearest village and runs the same `ticks` 0.05 s steps (the main loop's systems, world.update every 20).
// The "slow" page also moves its clock 2 ms every step, as a busy computer would. Anything in the simulation that reads the wall clock
// (a cooldown in real seconds, a work budget in ms) then decides differently there, and the checksums differ. The checksum covers every
// mob (type, position to 1/1024, health, dead), the block edits, the clock, the village sim's kept set and the village stats, plus every part
// of r15-24's BF.stateHash; r15-10's fixed tick will let it run through the real frame loop.
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const TICKS = +(process.argv[2] || 2000), seed = +(process.argv[3] || 123);

async function run(b, slowMs) {
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => {
    window.requestAnimationFrame = () => 0;   // no frames: the test drives every step
    let s = 1;
    window.__seed = v => { s = v >>> 0; };
    Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let now = 0;
    performance.now = () => (now += 0.001);
    window.__clock = { set: v => { now = v; }, add: ms => { now += ms; } };
  });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);
  const v = await pg.evaluate(() => {
    __seed(42); __clock.set(1e6);
    BF.state.paused = false;
    BF.player.setGameMode('creative');
    const v = BFT.villages(3000)[0];
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    for (let i = 0; i < 300; i++) BF.world.update(v.x, v.z, 60);
    return { x: v.x, z: v.z };
  });
  // all in one evaluate: page timers between evaluates (js/audio.js warming its sounds) draw from Math.random and would shift the
  // simulation's numbers (spec r15-14 gives the simulation its own seeded randomness)
  const per = TICKS;
  for (let done = 0; done < TICKS; done += per) {
    await pg.evaluate(([v, n, slowMs]) => {
      const h = 0.05;
      for (let i = 0; i < n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h);
        if (BF.dayTimeline) BF.dayTimeline.update();
        BF.drops.update(h); BF.boats.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h);
        BF.world.tickSim();
        if (slowMs) __clock.add(slowMs);   // a slow computer: real time passes while the step runs
        if (i % 20 === 19) BF.world.update(v.x, v.z, 60);
      }
    }, [v, Math.min(per, TICKS - done), slowMs]);
  }
  const r = await pg.evaluate(() => {
    const parts = {}, R = x => Math.round(x * 1024);
    parts.mobs = BF.mobs.list.map(m => [m.type, m.profession || '', R(m.position.x), R(m.position.y), R(m.position.z), Math.round((m.hp != null ? m.hp : m.health || 0) * 100), !!m.dead].join(',')).join(';');
    parts.edits = [...BF.world.edits].map(([k, m]) => k + ':' + [...m].map(e => e.join('=')).join(',')).sort().join(';');
    parts.clock = BF.simNow().toFixed(3) + ' ' + BF.sky.day + ' ' + BF.sky.time.toFixed(6);
    parts.villages = BF.villageSim.status() + ' ' + [...BF.villageSim.keepKeys].sort().join(';');
    parts.stats = JSON.stringify(BF.vstats ? BF.vstats.serialize() : null) + JSON.stringify(BF.econ ? BF.econ.serialize() : null);
    const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
    const out = {};
    for (const k in parts) out[k] = fnv(parts[k]);
    if (BF.stateHash) for (const [k, h] of Object.entries(BF.stateHash.parts())) out['stateHash ' + k] = h;   // r15-24's whole-world hash, part by part
    return { parts: out, mobs: BF.mobs.list.length, villagers: BF.mobs.list.filter(m => m.type === 'villager').length, edits: BF.world.edits.size, t: BF.simNow() };
  });
  await pg.close();
  return r;
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let fails = 0;
  const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')); };
  const fast = await run(b, 0);
  console.log('fast', JSON.stringify(fast));
  const slow = await run(b, +(process.env.SLOW_MS || 2));
  console.log('slow', JSON.stringify(slow));
  ok('the run simulated villagers', fast.villagers > 0 && Math.abs(fast.t - TICKS * 0.05) < 1e-6, { villagers: fast.villagers, t: fast.t });
  for (const k in fast.parts) ok('same ' + k + ' on a fast and a slow computer after ' + TICKS + ' ticks', fast.parts[k] === slow.parts[k], [fast.parts[k], slow.parts[k]]);
  await b.close();
  console.log(fails ? 'FAILED: ' + fails : 'PASSED');
  process.exit(fails ? 1 : 0);
})();
