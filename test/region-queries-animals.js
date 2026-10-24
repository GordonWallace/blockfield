// @ci integration suite=world timeout=1500 hosts=worker,server
// Region queries in the mob core and the animal modules (spec r15-31): scans of BF.mobs.list for mobs near a point now read the region
// index (BF.regions.mobsAround through BF.mobs.near), loops over one kind read BF.regions.ofType, a village's golems its own members.
// With BF.regions.verifyQueries on, each converted scan also runs over the whole list and any different answer is counted. On seed 3
// (planet, village generator 10), at the village nearest the spawn:
//   a game day (24,000 steps of 0.05 s: villagers, golems, keepers and their animals, wild animals breeding, monsters at night) finds no
//     difference, and the main scans (golems' rescue search, occupied cells, the animal keepers' tended, wild breeding, the monster
//     spawn buffer) were each checked;
//   the player's ray at 20 mobs: same answers through the index;
//   across a face edge: nearestMob (past the mob grid's 32 blocks) finds a mob just over the edge, as the scan of the whole list did;
//   the region index's self-check (BF.regions.check) still finds nothing after the day.
// Usage: NODE_PATH=$(npm root -g) [BF_HOST=page|worker|server] node test/region-queries-animals.js [seed=3] [steps=24000]
// The mobs and the index are the simulation's: the steps and checks run where it is (spec r15-43), held paused there between them.
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), lib = require('./lib');
const seed = +(process.argv[2] || 3), steps = +(process.argv[3] || 24000);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

(async () => {
  const srv = await lib.serve();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)); });
  // in the page, the frame loop is held: only the test's steps move the world (off the page, the page and the simulation are paused instead)
  if (lib.host() === 'page') await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await lib.install(pg);
  await pg.goto(srv.url + '?debugfeed=off&' + lib.q() + '#seed' + seed + 'gen4v10');
  await lib.ready(pg);
  await pg.waitForFunction(s => BF.state.seed === s && !BF.preparing, seed, { timeout: 300000, polling: 250 });
  await lib.simReady(pg);
  // the page's body held out of the simulation (the player moves there), and both ends paused (the page's pause goes to the simulation)
  await lib.alone(pg, true);
  await pg.evaluate(() => { BF.state.paused = true; });

  await lib.sim(pg, () => {
    BF.state.paused = true;
    globalThis.__step = h => BF.simStep(h);
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    if (BF.player.setCreative) BF.player.setCreative(true);
    globalThis.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
    // count the checks by label (each converted scan), and the differences
    const R = BF.regions, orig = R.checkQuery, Q = (globalThis.__q = { checked: {}, diffs: {}, last: [] });
    R.checkQuery = function (label, got, want, x, z) {
      const L = String(label).replace(/ .*/, ''), ok = orig.call(this, label, got, want, x, z);
      Q.checked[L] = (Q.checked[L] || 0) + 1;
      if (!ok) { Q.diffs[L] = (Q.diffs[L] || 0) + 1; if (Q.last.length < 10) Q.last.push(JSON.stringify(R.queryStats().last)); }
      return ok;
    };
  });
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const c = await lib.sim(pg, () => { globalThis.__load(20); globalThis.__step(0.05); return BF.world.chunks.size; });
    if (c === last && i > 5) break;
    last = c; await pg.waitForTimeout(250);
  }
  await lib.sim(pg, () => { BF.regions.verifyQueries = true; BF.regions.resetQueryStats(); });

  // ---------------------------------------------------------------- a game day
  const t0 = Date.now();
  let peak = 0;
  for (let done = 0; done < steps; done += 500) {
    const n = await lib.sim(pg, k => {
      BF.state.paused = true;
      for (let i = 1; i <= k; i++) { globalThis.__step(0.05); if (i % 50 === 0) globalThis.__load(1); }
      return BF.mobs.list.length;
    }, Math.min(500, steps - done));
    peak = Math.max(peak, n);
  }
  const day = await lib.sim(pg, () => ({ q: globalThis.__q, stats: BF.regions.queryStats(), check: BF.regions.check(), counts: BF.regions.counts(),
    kinds: BF.mobs.list.reduce((o, m) => ((o[m.type] = (o[m.type] || 0) + 1), o), {}) }));
  console.log(`  ${steps} steps in ${((Date.now() - t0) / 1000).toFixed(0)} s; mobs now ${JSON.stringify(day.kinds)} (peak ${peak})`);
  console.log(`  checks: ${JSON.stringify(day.q.checked)}`);
  if (day.q.last.length) console.log('  differences: ' + day.q.last.join('\n    '));
  const diffs = day.stats.diffs;   // (mobsAround, ofType and villageMobs check themselves inside js/regions.js: in the total only)
  check(diffs === 0, `a game day: every converted scan agrees with the scan of the whole list (${day.stats.checked} checks, ${diffs} differences)`);
  for (const L of ['mobs.villagerInDanger', 'mobs.isOccupied', 'wildlife.buffer', 'wildlife.breed'])
    check((day.q.checked[L] || 0) > 0, `${L} was checked (${day.q.checked[L] || 0})`);
  const keepers = ['shepherd', 'poultry', 'cowherd', 'pigfarmer'].filter(k => day.q.checked[k + '.tended']);
  check(keepers.length >= 1, `an animal keeper's tended() was checked (${keepers.join(', ') || 'none'})`);
  check(day.check.ok, `the index's self-check after the day${day.check.ok ? '' : ': ' + day.check.diffs.slice(0, 3).join(' | ')}`);

  // ---------------------------------------------------------------- the player's ray, a blast, a spawn spot, an occupied cell
  const one = await lib.sim(pg, () => {
    const M = BF.mobs, R = BF.regions, out = {};
    const before = R.queryStats().checked;
    const p = BF.player.position, a = M.list.filter(m => !m.dead).slice(0, 20);
    let hits = 0;
    for (const m of a) {   // a ray from 3 blocks off at each mob's middle
      const o = new THREE.Vector3(m.position.x + 3, m.position.y + m.height / 2, m.position.z), d = new THREE.Vector3(-1, 0, 0);
      const r = M.raycast(o, d, 5);
      if (r) hits++;
    }
    out.hits = hits; out.rays = a.length;
    out.checked = R.queryStats().checked - before; out.diffs = R.queryStats().diffs;
    return out;
  });
  check(one.hits >= one.rays * 0.8, `the ray hits the mobs it's aimed at (${one.hits} of ${one.rays})`);
  check(one.checked >= one.rays && one.diffs === 0, `the rays were checked against the scan of the whole list (${one.checked} checks, ${one.diffs} differences in all)`);

  // ---------------------------------------------------------------- across a face edge
  const edge = await lib.sim(pg, () => {
    const P = BF.planet, M = BF.mobs, N = P.N;
    const f = P.grid(BF.player.position.x, BF.player.position.z, {}).f;
    const a = P.atlas(f, N - 3, N / 2), bIn = P.atlas(f, N + 3, N / 2), bc = P.canonCell(Math.floor(bIn.x), Math.floor(bIn.z));
    const ya = BF.worldgen.heightAt(Math.floor(a.x), Math.floor(a.z)) + 1, yb = BF.worldgen.heightAt(bc.x, bc.z) + 1;
    const m1 = M.spawn('zombie', a.x, ya, a.z), m2 = M.spawn('sheep', bc.x + 0.5, yb, bc.z + 0.5);
    if (!m1 || !m2) return { skipped: true };
    BF.regions.tick();
    const before = BF.regions.queryStats().diffs;
    const near = M.grid.nearest(m1, 40, o => o === m2);   // (past 32 blocks: the scan r15-31 changed; nearer ones use the mob grid)
    const out = { found: near === m2, faces: [P.grid(m1.position.x, m1.position.z, {}).f, P.grid(m2.position.x, m2.position.z, {}).f], diffs: BF.regions.queryStats().diffs - before, ydiff: Math.abs(ya - yb) };
    return out;
  });
  if (edge.skipped) console.log('  (face edge: could not place the mobs, skipped)');
  else {
    check(edge.faces[0] !== edge.faces[1], `the two mobs stand on different faces (${edge.faces})`);
    check(edge.diffs === 0, 'across the edge, the query agrees with the scan of the whole list');
    if (edge.ydiff < 10) check(edge.found, 'nearestMob (40 blocks) finds the mob 6 blocks away across the face edge');
  }
  const errs = await lib.sim(pg, () => (BF.glog && BF.glog.entries ? BF.glog.entries().filter(e => e.kind === 'regions').length : 0)).catch(() => 0);
  check(!errs, `no regions ERROR in the game log (${errs})`);
  check(!errors.length, `no page errors (${errors.length})`);
  await b.close();
  await srv.stop();
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
