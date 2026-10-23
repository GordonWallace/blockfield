// @ci integration suite=world,village timeout=900
// The region model and index (spec r15-30, js/regions.js). On seed 3 (planet, village generator 10):
//   keys: a margin address keys like its canonical cell, a region is exactly 4 x 4 chunks, floor decides on a border, the key changes face
//     across a face edge; neighbours: 8 inside a face and along an edge, 7 at each of the 24 cube corners, always mutual; around() finds
//     the regions a circle touches, across an edge too;
//   index: 1,000 simulation steps at the village nearest the spawn (villagers, golems, animals wandering), then a chest, a furnace and
//     a sign placed and broken, a drop made and removed, and a village's mobs unloaded; the self-check (BF.regions.check) finds no
//     differences after each;
//   queries: mobsAround (r15-31 / r15-32) agrees with a full scan of BF.mobs.list, in its order, with mobs moved since the last sync;
//   cost: 2,000 objects walking about cost under 0.1 ms a step in the index (measured, printed), and the real index step is printed.
// Usage: NODE_PATH=$(npm root -g) node test/regions.js [seed=3] [steps=1000]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3), steps = +(process.argv[3] || 1000);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)));
  // the frame loop is held: only the test's steps move the world
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);

  // ---------------------------------------------------------------- keys, neighbours, around
  const u = await pg.evaluate(() => {
    const R = BF.regions, P = BF.planet, N = P.N, S = R.REGION, out = { bad: [] };
    const bad = s => { if (out.bad.length < 20) out.bad.push(s); };
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    // margin addresses key like their canonical cell, and a region is 4 x 4 chunks
    let margin = 0, chunks = 0;
    for (let i = 0; i < 4000; i++) {
      const f = Math.floor(rnd() * 6), s = Math.floor(rnd() * 4), j = rnd() * N, k = rnd() * 300 - 150;   // k < 0 inside the face, k >= 0 past edge s
      const o = (s === 0 || s === 2) ? -1 - k : N + k, a = (s < 2) ? P.atlas(f, o, j) : P.atlas(f, j, o);
      const c = P.canonCell(Math.floor(a.x), Math.floor(a.z));
      if (c.wedge || c.off) continue;
      const k1 = R.keyOf(a.x, 64, a.z), k2 = R.keyOf(c.x + 0.5, 64, c.z + 0.5), p = R.parts(k1);
      if (k1 !== k2) bad(`margin ${a.x},${a.z} -> ${R.name(k1)}, its cell ${c.x},${c.z} -> ${R.name(k2)}`);
      if (k >= 0) margin++;
      const cx = Math.floor(c.x / BF.CS), cz = Math.floor(c.z / BF.CS), fx0 = (P.W * c.f + N) / BF.CS, fz0 = N / BF.CS;
      if (p.f !== c.f || p.ru !== Math.floor((cx - fx0) / (S / BF.CS)) || p.rv !== Math.floor((cz - fz0) / (S / BF.CS))) bad(`cell ${c.x},${c.z}: region ${R.name(k1)} is not its chunk's`);
      else chunks++;
    }
    out.margin = margin; out.chunks = chunks;
    // floor on a border: the cell at u = 64 is in region 1, u = 63.999 in region 0
    { const a = P.atlas(4, S, 1000), b2 = P.atlas(4, S - 0.001, 1000);
      out.border = R.parts(R.keyOf(a.x, 0, a.z)).ru === 1 && R.parts(R.keyOf(b2.x, 0, b2.z)).ru === 0; }
    // across a face edge the face changes (face 4, past u = N)
    { const a = P.atlas(4, N - 0.5, N / 2), b2 = P.atlas(4, N + 0.5, N / 2), k1 = R.keyOf(a.x, 0, a.z), k2 = R.keyOf(b2.x, 0, b2.z);
      out.edge = [R.name(k1), R.name(k2)]; out.edgeOk = R.parts(k1).f === 4 && R.parts(k2).f !== 4 && R.neighbors(k1).includes(k2); }
    // neighbours: 7 at every cube corner, 8 elsewhere, always mutual
    const K = R.K, counts = { corner: [], edge: [], inside: [] };
    const mutual = k => R.neighbors(k).every(n => R.neighbors(n).includes(k));
    for (let f = 0; f < 6; f++) for (const [ru, rv] of [[0, 0], [K - 1, 0], [0, K - 1], [K - 1, K - 1]]) {
      const k = (f * K + ru) * K + rv, n = R.neighbors(k);
      counts.corner.push(n.length);
      if (!mutual(k)) bad(`corner ${R.name(k)} neighbours not mutual`);
      for (const m of n) if (!mutual(m)) bad(`${R.name(m)} (next to corner ${R.name(k)}) neighbours not mutual`);
      const e = (f * K + Math.floor(K / 2)) * K + rv, i = (f * K + 7) * K + 9;
      counts.edge.push(R.neighbors(e).length); counts.inside.push(R.neighbors(i).length);
      if (!mutual(e)) bad(`edge ${R.name(e)} neighbours not mutual`);
    }
    out.counts = counts;
    // around: a small circle in a region's middle is that region; one of radius S reaches its 8 neighbours; at an edge the other face
    { const k = (4 * K + 100) * K + 100, bb = R.bounds(k), cx = (bb.x0 + bb.x1) / 2, cz = (bb.z0 + bb.z1) / 2;
      const a1 = R.around(cx, cz, 5), a2 = R.around(cx, cz, S);
      out.around1 = a1.length === 1 && a1[0] === k;
      out.around2 = a2.length === 9 && R.neighbors(k).every(n => a2.includes(n));
      const e = P.atlas(4, N - 3, N / 2), a3 = R.around(e.x, e.z, 20);
      out.around3 = a3.some(n => R.parts(n).f !== 4) && a3.some(n => R.parts(n).f === 4);
      const c = P.atlas(4, 2, 2), a4 = R.around(c.x, c.z, 20);   // at a cube corner: its own region and one across each edge
      out.around4 = a4.length === 3 && new Set(a4.map(n => R.parts(n).f)).size === 3; }
    return out;
  });
  for (const s of u.bad) console.log('  ' + s);
  check(!u.bad.length, `keys: margin addresses key like their canonical cell (${u.margin} past an edge), regions are 4 x 4 chunks (${u.chunks} cells)`);
  check(u.border, 'keys: floor decides on a region border');
  check(u.edgeOk, `keys: across a face edge the face changes (${u.edge.join(' -> ')}), and the two are neighbours`);
  check(u.counts.corner.every(n => n === 7), `neighbours: 7 at all 24 cube corners (${[...new Set(u.counts.corner)]})`);
  check(u.counts.edge.every(n => n === 8) && u.counts.inside.every(n => n === 8), 'neighbours: 8 along a face edge and inside a face');
  check(u.around1 && u.around2, 'around: a 5-block circle is its region, a 64-block one adds the 8 neighbours');
  check(u.around3 && u.around4, 'around: reaches across a face edge, and at a cube corner holds the three faces');

  // ---------------------------------------------------------------- the index over a run
  await pg.evaluate(() => {
    const W = BF.warp;
    window.__step = h => BF.simStep(h);   // the main loop's simulation step (js/main.js), without the player; it ends with BF.regions.tick()
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
  });
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const c = await pg.evaluate(() => { window.__load(20); window.__step(0.05); return BF.world.chunks.size; });
    if (c === last && i > 5) break;
    last = c; await pg.waitForTimeout(250);
  }
  const run = await pg.evaluate(n => {
    const R = BF.regions, res = { checks: [], moves0: R.counts().moves };
    let t = 0;
    for (let i = 1; i <= n; i++) {
      window.__step(0.05);
      if (i % 50 === 0) window.__load(1);
      if (i % 250 === 0) { const c = R.check(); res.checks.push(c.ok ? 'ok' : c.diffs.slice(0, 5).join(' | ')); }
    }
    // the cost of the real index step with what is loaded (the step only: everything already sits in its region)
    for (let i = 0; i < 200; i++) { const t0 = performance.now(); R.tick(); t += performance.now() - t0; }
    res.tickMs = t / 200;
    // the cost of filling the index from scratch (every loaded chunk scanned for block entities): what a chunk load adds
    { const t0 = performance.now(); for (let i = 0; i < 5; i++) R.reset(); res.resetMs = (performance.now() - t0) / 5; res.chunks = BF.world.chunks.size; }
    res.counts = R.counts(); res.moves = res.counts.moves - res.moves0;
    // ids (r15-13): every mob of the busiest region by id, each id resolving to that mob
    { const k = R.stats().sort((a, b) => b.mobs - a.mobs)[0].key, ids = R.mobIdsIn(k);
      res.ids = ids.length === R.mobsIn(k).size && ids.every(id => /^e\d+$/.test(id) && R.mobsIn(k).has(BF.ids.get(id))) && R.villageIdsIn(R.keyOf(BF.player.position.x, 0, BF.player.position.z)).length >= 0; }
    res.busiest = R.stats().sort((a, b) => b.mobs - a.mobs).slice(0, 3).map(s => s.name + ' ' + s.mobs);
    return res;
  }, steps);
  console.log(`  ${run.counts.mobs} mobs, ${run.counts.drops} drops, ${run.counts.villages} running villages, ${run.counts.blockEntities} block entities in ${run.counts.regions} regions; busiest ${run.busiest.join(', ')}`);
  console.log(`  ${run.moves} region changes in ${steps} steps; the index step takes ${(run.tickMs * 1000).toFixed(1)} us with ${run.counts.mobs} mobs and ${run.counts.drops} drops`);
  console.log(`  filling the index from scratch: ${run.resetMs.toFixed(1)} ms for ${run.chunks} chunks (${(run.resetMs / run.chunks * 1000).toFixed(0)} us a chunk)`);
  check(run.checks.length && run.checks.every(c => c === 'ok'), `self-check after every 250 of ${steps} steps finds no differences (${run.checks.join(', ')})`);
  check(run.counts.mobs > 20 && run.moves > 0, `mobs were indexed and moved between regions (${run.counts.mobs} mobs, ${run.moves} moves)`);
  check(run.ids, 'a region lists its mobs by their ids (r15-13), each resolving to the mob');
  check(run.counts.villages >= 1, `the running village is indexed (${run.counts.villages})`);

  // ---------------------------------------------------------------- queries (mobsAround, the r15-31 / r15-32 helper)
  const q = await pg.evaluate(() => {
    const R = BF.regions, out = {};
    R.verifyQueries = true; R.resetQueryStats();
    const p0 = BF.player.position.clone();
    let n = 0, found = 0;
    for (let i = 0; i < 200; i++) {   // queries mid-step too (after the mobs moved, before the index's sync): here between steps and inside
      window.__step(0.05);
      const L = BF.mobs.list.filter(m => !m.removed);
      for (let j = 0; j < L.length; j += 7) { const m = L[j]; found += R.mobsAround(m.position.x, m.position.z, 4 + (j % 5) * 12).length; n++; }
      for (const m of L) m.position.x += 0.3;   // as if they had walked part of a step since the last sync
      for (let j = 3; j < L.length; j += 11) { const m = L[j]; R.mobsAround(m.position.x, m.position.z, 24, o => o.type === 'villager'); n++; }
      for (let j = 5; j < L.length; j += 13) { const m = L[j]; R.mobsAround(m.position.x, m.position.z, 30, null, { local: true }); n++; }
      for (const m of L) m.position.x -= 0.3;
    }
    { const b = R.mobsInBox(p0.x - 20, p0.z - 10, p0.x + 15, p0.z + 25), w = BF.mobs.list.filter(m => !m.removed && m.position.x >= p0.x - 20 && m.position.x <= p0.x + 15 && m.position.z >= p0.z - 10 && m.position.z <= p0.z + 25);
      out.box = b.length === w.length && b.every((m, i) => m === w[i]) && b.length > 0; }
    for (const t of ['villager', 'iron_golem', 'zombie', 'cow']) { R.ofType(t); n++; }
    for (const rec of BF.mobs.villages.values()) { R.villageMobs(rec); R.villageMobs(rec, m => m.type === 'villager'); n += 2; }
    n++;
    const st = R.queryStats();
    out.n = n; out.found = found; out.diffs = st.diffs; out.last = st.last; out.checked = st.checked;
    // list order: what a full scan would find, in the same order
    const p = BF.player.position, a = R.mobsAround(p.x, p.z, 200), L = BF.mobs.list;
    out.order = a.length > 1 && a.every((m, i) => !i || L.indexOf(a[i - 1]) < L.indexOf(m));
    // through a face edge: mobs put just past an edge of the village's face, a local query from this side finds them, a raw one doesn't
    { const P = BF.planet, f = P.face(p.x, p.z), N = P.N, a = P.atlas(f, N - 2, N / 2), b = P.atlas(f, N + 2, N / 2), c = P.canon(b.x, b.z, {});
      const ms = BF.mobs.list.filter(m => !m.removed && m.type !== 'villager').slice(0, 2), old = ms.map(m => m.position.clone());
      for (const m of ms) { m.position.x = c.x; m.position.z = c.z; }
      R.tick();
      const lo = R.mobsAround(a.x, a.z, 6, null, { local: true }), raw = R.mobsAround(a.x, a.z, 6);
      out.edge = ms.length === 2 && ms.every(m => lo.includes(m)) && !ms.some(m => raw.includes(m));
      ms.forEach((m, i) => m.position.copy(old[i])); R.tick(); }
    out.wrong = R.checkQuery('test', [], [L[0]]) === false && R.queryStats().diffs === st.diffs + 1;
    R.verifyQueries = false; R.resetQueryStats();
    return out;
  });
  check(q.diffs === 0 && q.checked === q.n, `mobsAround, ofType and villageMobs agree with a full scan in ${q.n} queries over 200 steps (${q.found} mobs found)` + (q.last ? ' ' + JSON.stringify(q.last) : ''));
  check(q.box, 'mobsInBox finds the mobs standing in a box');
  check(q.order, 'mobsAround lists mobs in BF.mobs.list order');
  check(q.edge, 'mobsAround with local: true finds mobs just across a face edge (raw distance does not)');
  check(q.wrong, 'checkQuery reports a difference');

  const ev = await pg.evaluate(() => {
    const R = BF.regions, W = BF.world, p = BF.player.position, out = {};
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z) + 2, y = Math.floor(p.y) + 6, k = R.keyOf(x, y, z), key = x + ',' + y + ',' + z;
    const cc = W.canonXZ(x, z), ck = cc[0] + ',' + y + ',' + cc[1];
    const has = () => !!(R.blockEntitiesIn(k) && R.blockEntitiesIn(k).has(ck));
    const r = [];
    for (const id of [BF.B.chest, BF.B.furnace, BF.B.oak_sign_n || BF.blocks.find(b => b && b.sign).id]) {
      W.setBlock(x, y, z, id); const a = has() && R.check().ok;
      W.setBlock(x, y, z, 0); const b = !has() && R.check().ok;
      r.push(BF.blocks[id].name + (a && b ? ' ok' : ' FAILED'));
    }
    out.be = r; out.beOk = r.every(s => s.endsWith(' ok')); out.key = key;
    const d = BF.drops.spawn(BF.I.stick, 1, p.x + 1, p.y + 1, p.z + 1);
    out.drop1 = !!(d && R.dropsIn(R.keyOf(d.pos.x, 0, d.pos.z)).has(d)) && R.check().ok;
    BF.drops.remove(d);
    out.drop2 = R.check().ok;
    const rec = [...BF.mobs.villages.values()].find(v => BF.villageSim.isActive(v.key));
    const before = R.counts().mobs;
    out.unloaded = rec ? BF.mobs.unloadVillage(rec.key) : 0;
    R.tick();
    const c = R.check();
    out.unload = c.ok; out.unloadDiffs = c.diffs.slice(0, 5); out.mobsAfter = R.counts().mobs; out.before = before;
    // another region size empties the index and fills it again from what is there
    R.setSize(32); const c32 = R.check(), n32 = R.counts().mobs; R.setSize(64); const c64 = R.check();
    out.resize = c32.ok && c64.ok && n32 === R.counts().mobs && R.counts().mobs === out.mobsAfter;
    return out;
  });
  check(ev.beOk, `block entities placed and broken stay in step (${ev.be.join(', ')})`);
  check(ev.drop1 && ev.drop2, 'a drop is indexed when made and leaves when removed');
  check(ev.resize, 'a new region size (32, then 64 again) refills the index, and the self-check agrees');
  check(ev.unload && ev.unloaded > 0 && ev.mobsAfter === ev.before - ev.unloaded, `a village's ${ev.unloaded} mobs leave the index when it unloads (${ev.before} -> ${ev.mobsAfter}) ${ev.unloadDiffs.join(' | ')}`);

  // ---------------------------------------------------------------- cost: 2,000 mobs moving
  const cost = await pg.evaluate(() => {
    const R = BF.regions, P = BF.planet, N = P.N, ix = new R.Index(o => o.position), objs = [];
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 2000; i++) {   // spread over a 1,000-block square on face 4 that touches its edge, so some cross it
      const a = P.atlas(4, N - 1000 + rnd() * 1000, N / 2 + rnd() * 1000), yaw = rnd() * 6.283;
      objs.push({ position: new THREE.Vector3(a.x, 64, a.z), vx: Math.cos(yaw) * 0.2, vz: Math.sin(yaw) * 0.2 });   // 4 blocks a second at 0.05 s steps; past the
      // edge they are put back on the canonical square, as mobs are (BF.planet.recanon)
    }
    for (const o of objs) ix.add(o);
    // Each round times 200 steps of moving alone, then 200 of moving and indexing: the difference over 200 is the index's cost per step
    // (whole rounds are timed, as performance.now() is coarse in a page that is not cross-origin isolated). Two rounds warm up first.
    const per = [];
    const move = s => { for (const o of objs) { o.position.x += o.vx; o.position.z += o.vz; P.recanon(o.position); if (s % 40 === 0) { const yaw = rnd() * 6.283; o.vx = Math.cos(yaw) * 0.2; o.vz = Math.sin(yaw) * 0.2; } } };
    for (let round = 0; round < 7; round++) {
      let t0 = performance.now();
      for (let s = 0; s < 200; s++) move(s);
      const bare = performance.now() - t0;
      ix.sync();
      t0 = performance.now();
      for (let s = 0; s < 200; s++) { move(s); ix.sync(); }
      if (round >= 2) per.push(Math.max(0, performance.now() - t0 - bare) / 200);
    }
    per.sort((a, b) => a - b);
    let stat = performance.now();
    for (let i = 0; i < 1000; i++) ix.sync();
    stat = performance.now() - stat;   // (ms for 1,000 steps: us a step)
    let wrong = 0;
    for (const o of objs) if (ix.keyOf(o) !== R.keyOf(o.position.x, 0, o.position.z) || !ix.in(ix.keyOf(o)).has(o)) wrong++;
    return { stat, ms: per[2], all: per, moves: ix.moves, wrong, regions: ix.by.size };
  });
  console.log(`  2,000 mobs moving: ${(cost.ms * 1000).toFixed(1)} us a step (median of 5 rounds of 200 steps, moves taken out: ${cost.all.map(x => (x * 1000).toFixed(1)).join(', ')} us), ${cost.moves} region changes, ${cost.regions} regions; standing still ${cost.stat.toFixed(1)} us a step`);
  check(cost.wrong === 0, `every moving object ends in its own region (${cost.wrong} wrong)`);
  check(cost.ms < 0.1, `2,000 mobs moving cost under 0.1 ms a step in the index (${(cost.ms * 1000).toFixed(1)} us)`);

  await b.close();
  console.log(fails ? `FAILED ${fails}` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL', e.stack || e); process.exit(1); });
