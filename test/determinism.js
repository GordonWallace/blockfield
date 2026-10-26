// @ci integration suite=world soak timeout=1800
// Determinism (spec r15-24): the same seed gives the same world. Boots seed 3 twice, each in a fresh page, fast-forwards one game day in
// each with the main loop's simulation tick (BF.simStep) and compares the world state hash (js/statehash.js) and its parts at the
// start and every eighth of a day. The second case, a recorded player session replayed in a fresh page, is test/player-requests.js
// (r15-20), which requires the same hash at the end.
// The frame loop is held from the first frame, so both pages start from the boot's state and only the test's steps move the world:
// the player is moved to the village nearest the spawn, chunks load to completion every 50 steps, and the player stands still
// (it is not simulated here).
// ENFORCED since Stage 1 (r15-10, r15-14 to r15-23) merged: any difference fails, with the parts that differ and where each first differs.
// (ENFORCE = false makes it report-only again, printing DIFF lines and passing.) The unit checks (a single block, item or mob position
// changes the hash, and so do the random streams' and id counters; hashing twice gives the same hash) always count.
// Usage: NODE_PATH=$(npm root -g) node test/determinism.js [seed=3] [days=1]
const ENFORCE = true;
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3), days = +(process.argv[3] || 1);
const CHECKS = 8 * days;   // a comparison every eighth of a game day
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

async function boot(b, n) {
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log(`PAGEERROR [page ${n}]`, (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);
  await pg.evaluate(() => {
    // the main loop's simulation tick (js/boot.js simStep, in fixed W.TICK steps: r15-10), without the player
    window.__step = () => BF.simStep(BF.warp.TICK);
    // to the village nearest the spawn (as test/lib.js toVillage), so villagers are in the comparison
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
    // Chunk loading in the steps: BF.world.update creates chunk data within a real-time budget (js/world.js), so what one call creates
    // depends on the machine. Between ticks the test calls it until no more chunks appear, so both pages have the same chunks at the same
    // tick. (In play chunk data still arrives on real time; tying it to ticks is later work.)
    window.__settle = () => { const p = BF.player.position; let same = 0, n = BF.world.chunks.size;
      for (let i = 0; i < 200 && same < 3; i++) { BF.world.update(p.x, p.z, 50); const m = BF.world.chunks.size; same = m === n ? same + 1 : 0; n = m; } };
  });
  // the chunks round the spawn: load until nothing is left to generate or mesh and the count stops growing (a planet's chunk generation is
  // partly asynchronous)
  let last = -1;
  for (let i = 0; i < 240; i++) {
    const c = await pg.evaluate(() => { window.__load(20); return { n: BF.world.chunks.size, q: BF.world.queueLength }; });
    if (c.n === last && c.q === 0 && i > 5) break;
    last = c.n; await pg.waitForTimeout(250);
  }
  console.log(`page ${n}: ${last} chunks loaded`);
  return pg;
}
const advance = (pg, steps) => pg.evaluate(k => {
  for (let i = 0; i < k; i++) { window.__step(); if (i % 50 === 0) window.__settle(); }
  return Object.assign(BF.stateHash.full(), { chunks: BF.world.chunks.size, queued: BF.world.queueLength });
}, steps);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t0 = Date.now();
  const pages = await Promise.all([boot(b, 1), boot(b, 2)]);
  console.log(`booted seed ${seed} twice in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // unit checks on the first page (then put back): the hash is stable and sees one block, one item and one mob's position
  const u = await pages[0].evaluate(() => {
    for (let i = 0; i < 400; i++) { window.__step(); if (i % 50 === 0) window.__settle(); }   // 20 s, for some mobs
    const H = BF.stateHash, a = H.full(), same = H.full().hash === a.hash, p = BF.player.position, r = {};
    const diff = (base, b) => Object.keys(b.parts).filter(k => b.parts[k] !== base.parts[k]);
    const change = f => { const base = H.full(); f(); return diff(base, H.full()); };
    const x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y) + 4, old = BF.world.getBlock(x, y, z);
    r.block = change(() => BF.world.setBlock(x, y, z, old === BF.B.stone ? BF.B.dirt : BF.B.stone));
    BF.world.setBlock(x, y, z, old);
    r.item = change(() => BF.inventory.add(BF.I.stick, 1));
    const m = BF.mobs.list.find(m => !m.removed);
    if (m) { r.mob = change(() => { m.position.x += 0.01; }); m.position.x -= 0.01; }
    // the counters that decide what comes next (bug-083): a world one random draw or 100 ids ahead plays differently later
    const rs = BF.rand.save(); r.rand = change(() => BF.rand.load({ tick: rs.tick, made: rs.made + 1 })); BF.rand.load(rs);
    const is = BF.ids.serialize(); r.ids = change(() => BF.ids.deserialize({ next: is.next + 100 })); BF.ids.deserialize(is);
    return { same, r, mobs: BF.mobs.list.length, ms: a.ms };
  });
  check(u.same, 'hashing twice gives the same hash');
  check(u.r.block.join() === 'edits', `one block changed changes only the edits part (${u.r.block})`);
  check(u.r.item.join() === 'player', `one item added changes only the player part (${u.r.item})`);
  check(u.mobs > 0 && u.r.mob && u.r.mob.length === 1 && u.r.mob[0] === 'mobs', `one mob moved 0.01 changes only the mobs part (${u.r.mob})`);
  check(u.r.rand.join() === 'rand', `the random streams one draw ahead change only the rand part (${u.r.rand})`);
  check(u.r.ids.join() === 'ids', `the id counter 100 ahead changes only the ids part (${u.r.ids})`);
  console.log(`${u.mobs} mobs, a hash takes ${u.ms} ms`);
  // the unit checks moved page 1 on and changed it (the block was put back, the item and the edit record stay): boot it again
  await pages[0].context().close();
  pages[0] = await boot(b, 1);

  const differ = {}, first = {};
  let res = await Promise.all(pages.map(pg => pg.evaluate(() => BF.stateHash.full())));
  const compare = async (label, r) => {
    const parts = Object.keys(r[0].parts).filter(k => r[0].parts[k] !== r[1].parts[k]);
    const same = r[0].hash === r[1].hash;
    console.log(`${same ? 'same ' : 'DIFF '}${label}: ${r[0].hash} ${same ? '' : r[1].hash + ' parts ' + parts.join(', ')} (${r[0].ms} ms${r[0].chunks != null ? `; chunks ${r[0].chunks} / ${r[1].chunks}, queued ${r[0].queued} / ${r[1].queued}` : ''})`);
    for (const k of parts) {
      differ[k] = (differ[k] || 0) + 1;
      if (first[k]) continue;
      first[k] = label;
      // where the part first differs: its canonical text in each page (js/statehash.js text) around the first character that differs
      const [x, y] = await Promise.all(pages.map(pg => pg.evaluate(k => BF.stateHash.text(k), k)));
      let i = 0; while (i < x.length && x[i] === y[i]) i++;
      const cut = t => JSON.stringify(t.slice(Math.max(0, i - 160), i + 120));
      console.log(`  ${k} first differs at character ${i} of ${x.length} / ${y.length}:\n    page 1 ${cut(x)}\n    page 2 ${cut(y)}`);
    }
    return same;
  };
  let allSame = await compare('start', res);
  const steps = Math.round(1200 / 0.05 / 8);   // an eighth of a day (js/sky.js dayLength 1200 s)
  for (let c = 1; c <= CHECKS; c++) {
    res = await Promise.all(pages.map(pg => advance(pg, steps)));
    allSame = (await compare(`day ${(c / 8).toFixed(3)} (game day ${res[0].day})`, res)) && allSame;
  }
  const mobs = await Promise.all(pages.map(pg => pg.evaluate(() => BF.mobs.list.length)));
  console.log(`mobs at the end: ${mobs.join(' / ')}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (allSame) console.log('ok   the two runs hashed the same at every check');
  else {
    console.log('parts that differed (checks, first at): ' + Object.keys(differ).map(k => `${k} (${differ[k]}, ${first[k]})`).join('; '));
    if (ENFORCE) check(false, 'the same seed gives the same world state hash');
    else console.log('report-only (ENFORCE off): differences do not fail the test');
  }
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
