// @ci integration suite=village soak timeout=5400 args={out}
// Mobs live in the world (idea-037) balance soak, on the planet (spec r14-22): 14 game days, 20 villages near the spawn. Villages run in
// groups of 4 for 3 days each (two pins of two villages, as caravan trips keep villages running) while the player stands in a fifth area
// with no village near, so no monster spawns because of the player. Drives the simulation directly (no rendering), like test/caravan-soak.js.
// Checks (the spec's numbers):
//  - at least 20 villages run;
//  - a zombie gets into the average running village on at least one night in three;
//  - fewer than 1 village in 20 loses more than 25% of its people within any 3-day window, and births keep up with deaths;
//  - the wild animals within 128 blocks of the villages neither die out nor keep growing (between half and double over each 3-day run);
//  - a cowherd, poultry keeper or stable hand finds a wild animal when it looks on at least 4 days in 5;
//  - reports the size of the saved mobs (wild mobs stored in unloaded chunks, and the loaded ones).
// Usage: NODE_PATH=$(npm root -g) node test/mobs-balance-soak.js [out.json] [seed=1337] [days=14]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const OUT = process.argv[2] || null;
const SEED = +(process.argv[3] || 1337);
const DAYS = +(process.argv[4] || 14);
const RUN = 3;   // days each group of villages runs

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let pageErrors = 0;
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + SEED);
  await pg.waitForTimeout(3000);
  await pg.waitForFunction(() => window.BF && !BF.preparing, null, { timeout: 300000, polling: 500 });
  const setup = await pg.evaluate(([DAYS, RUN]) => {
    window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative');
    const P = BF.planet, O = { x: BF.player.position.x, z: BF.player.position.z };
    const all = BF.worldgen.villagesNear(O.x, O.z, 3000).filter(v => v && v.minX != null);
    // the player's spot: no village within 300 blocks
    let spot = null;
    for (let r = 400; r < 3000 && !spot; r += 150) for (let a = 0; a < 16 && !spot; a++) {
      const c = P.canon(O.x + Math.cos(a * Math.PI / 8) * r, O.z + Math.sin(a * Math.PI / 8) * r, {}); if (c.off) continue;
      const x = Math.round(c.x), z = Math.round(c.z);
      if (!all.some(v => P.distance(v, { x, z }) < 300 + Math.max(v.maxX - v.minX, v.maxZ - v.minZ) / 2)) spot = [x, z];
    }
    if (!spot) return { err: 'no spot 300 blocks from every village' };
    const groups = Math.ceil(DAYS / RUN), need = groups * 4;
    const vs = all.filter(v => v.pop >= 4 && P.distance(v, { x: spot[0], z: spot[1] }) > 320).sort((a, b) => P.distance(a, { x: spot[0], z: spot[1] }) - P.distance(b, { x: spot[0], z: spot[1] })).slice(0, need);
    if (vs.length < need) return { err: 'only ' + vs.length + ' villages' };
    const key = v => Math.round(v.x) + ',' + Math.round(v.z);
    // The village sim's AI-work guard (js/villagesim.js overLimit "AI time", LIMITS.aiWork) force-stops a village beyond ALWAYS of the player
    // when villager AI averages over its limit (6 ms a frame before spec r15-16), a pin's destination (its second village) first. On a busy machine that dropped a pinned
    // village for a while and the soak read its people as 0. The guard is not what this soak measures (test/force-unload.js checks it).
    BF.villageSim.LIMITS.aiWork = Infinity;
    const R = window.__rec = { spot, groups: [], born: 0, died: 0, noWild: {}, days: [], pops: {}, animals: {}, nights: {}, keepers: {}, bad: [] };
    for (let g = 0; g < groups; g++) R.groups.push(vs.slice(g * 4, g * 4 + 4).map(key));
    window.__vs = new Map(vs.map(v => [key(v), v]));
    BF.on('villagerBorn', m => { if (m && m.village) R.born++; });
    BF.on('mobKilled', m => { if (m && m.type === 'villager' && m.village) R.died++; });
    // a keeper that looked for a wild animal and found none, per village per day
    const day = () => Math.floor(BF.sky.day + BF.sky.time);
    const miss = rec => { if (!rec) return; const k = rec.key + ' ' + day(); R.noWild[k] = (R.noWild[k] || 0) + 1; };
    const ol = BF.vlog.log;
    // only the cowherd's and the poultry keeper's lines: the shepherd and the pig farmer log the same "found no wild" words, but they are not
    // among the keepers counted below, so a pig farmer's miss read as a miss of the village's cowherd, poultry keeper or stable hand
    BF.vlog.log = function (rec, kind, text) { if (typeof text === 'string' && /\((Cowherd|Poultry Keeper)\) found no wild/.test(text)) miss(rec); return ol.apply(this, arguments); };
    const sl = BF.stables.LOG, push = sl.push.bind(sl);
    sl.push = e => { if (e && e.kind === 'nowild' && e.village) miss({ key: e.village }); return push(e); };
    window.__step = (n, h) => {
      const [x, z] = R.spot;
      for (let i = 1; i <= n; i++) {
        BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
        if (i % 50 === 0) BF.world.update(x, z, 4);
      }
    };
    window.__load = () => { const [x, z] = R.spot; for (let i = 0; i < 400; i++) { BF.world.update(x, z, 40); if (i % 4 === 0) window.__step(1, 0.05); if (![...BF.villageSim.keepKeys].some(k => !BF.world.chunks.has(k)) && i > 40) break; } };
    const live = m => !m.dead && !m.removed;
    window.__animals = keys => { const o = {}; for (const k of keys) { const v = window.__vs.get(k); let n = 0; for (const m of BF.mobs.list) if (live(m) && !m.hostile && m.type !== 'horse' && BF.mobs.isWild(m) && Math.hypot(m.position.x - v.x, m.position.z - v.z) <= 128) n++; o[k] = n; } return o; };
    window.__pops = keys => { const o = {}; for (const k of keys) { let n = 0, kp = 0; for (const m of BF.mobs.list) if (live(m) && m.type === 'villager' && m.village && m.village.key === k) { n++; if (/^(cowherd|poultry_keeper|stable_hand)$/.test(m.profession)) kp++; } o[k] = [n, kp]; } return o; };
    // a pin with no merchant trip on it is dropped a game day after it was first seen (js/merchant.js), so the group is pinned again often
    window.__pin = (g, d) => {
      const V = R.groups[g].map(k => window.__vs.get(k));
      for (const id of [...BF.villageSim.pins().keys()]) BF.villageSim.unpin(id);
      BF.villageSim.pin('soak' + g + '-' + d + 'a', V[0], V[1], []);
      BF.villageSim.pin('soak' + g + '-' + d + 'b', V[2], V[3], []);
    };
    window.__start = g => {
      window.__pin(g, 0);
      window.__load();
      return { sim: BF.villageSim.status(), chunks: BF.world.chunks.size };
    };
    BF.player.spawn(spot[0] + 0.5, BF.worldgen.heightAt(spot[0], spot[1]) + 3, spot[1] + 0.5);
    BF.sky.day = 1; BF.sky.setTime(0.0);
    return { spot, groups: R.groups };
  }, [DAYS, RUN]);
  if (setup.err) { console.log('FAIL ' + setup.err); await b.close(); process.exit(1); }
  console.log(`seed ${SEED}, player at ${setup.spot}, ${setup.groups.length} groups of 4 villages`);
  const t0 = Date.now(), h = 0.05, DAY = Math.round(1200 / h), PER_CALL = Math.round(DAY / 8);
  const runs = [];
  for (let g = 0; g < setup.groups.length; g++) {
    const days = Math.min(RUN, DAYS - g * RUN), ks = setup.groups[g];
    const st = await pg.evaluate(g => window.__start(g), g);
    // the first-generation animals are rolled as the chunks load: count them after a short settle
    await pg.evaluate(() => window.__step(200, 0.05));
    const run = { g, keys: ks, sim: st.sim, animals0: await pg.evaluate(k => window.__animals(k), ks), pops: [await pg.evaluate(k => window.__pops(k), ks)] };
    const d0 = await pg.evaluate(() => BF.sky.day);
    for (let d = 0; d < days; d++) {
      for (let s = 0; s < DAY; s += PER_CALL) {
        await pg.evaluate(([g, k]) => window.__pin(g, k), [g, d + '-' + s]);   // pinned again every eighth of a day, well inside the one-day limit
        await pg.evaluate(([n, h]) => window.__step(n, h), [PER_CALL, h]);
      }
      run.pops.push(await pg.evaluate(k => window.__pops(k), ks));
    }
    run.animals1 = await pg.evaluate(k => window.__animals(k), ks);
    run.nights = await pg.evaluate(([ks, d0, days]) => {
      const o = {};
      for (const k of ks) { const rec = BF.mobs.villages.get(k); if (!rec) { o[k] = null; continue; } const n = BF.wildlife.villageStats(rec).nights.filter(x => x[0] >= d0 && x[0] < d0 + days); o[k] = n; }
      return o;
    }, [ks, d0, days]);
    run.d0 = d0; run.days = days;
    run.noWild = await pg.evaluate(() => Object.assign({}, window.__rec.noWild));
    runs.push(run);
    const reached = Object.values(run.nights).reduce((a, n) => a + (n ? n.filter(x => x[1]).length : 0), 0);
    console.log(`group ${g} (days ${d0}-${d0 + days - 1}) ${st.sim}: pops ${ks.map(k => run.pops.map(p => p[k][0]).join('>')).join(' | ')}  animals ${ks.map(k => run.animals0[k] + '>' + run.animals1[k]).join(' ')}  nights reached ${reached}/${ks.length * days}  (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const end = await pg.evaluate(() => {
    const R = window.__rec, ws = JSON.stringify(BF.wildlife.serialize()), ms = JSON.stringify(BF.mobSave.serialize());
    return { born: R.born, died: R.died, noWild: R.noWild, wildlifeBytes: ws.length, mobsBytes: ms.length, stored: BF.wildlife.stored ? BF.wildlife.stored() : null };
  });
  // ---- the checks
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails.push(n); };
  const villages = new Set(runs.flatMap(r => r.keys.filter(k => r.pops[0][k][0] > 0)));
  ok('at least 20 villages ran', villages.size >= 20, villages.size);
  let nights = 0, reached = 0, attacks = 0, deaths = 0;
  for (const r of runs) for (const k of r.keys) for (const n of r.nights[k] || []) { nights++; reached += n[1]; attacks += n[2]; deaths += n[3]; }
  ok('a zombie gets into the average running village at least one night in three', nights > 0 && reached / nights >= 1 / 3, { reached, nights, ratio: +(reached / nights).toFixed(2), zombieAttacks: attacks, nightDeaths: deaths });
  let lost = [];
  for (const r of runs) for (const k of r.keys) {
    const p = r.pops.map(x => x[k][0]);
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length && j - i <= 3; j++) if (p[i] > 0 && (p[i] - p[j]) / p[i] > 0.25) { lost.push(k + ' ' + p.join('>')); i = p.length; break; }
  }
  ok('fewer than 1 village in 20 loses more than 25% of its people within 3 days', lost.length / villages.size < 1 / 20, { lost, of: villages.size });
  ok('births keep up with deaths', end.born >= end.died, { born: end.born, died: end.died });
  let a0 = 0, a1 = 0;
  for (const r of runs) for (const k of r.keys) { a0 += r.animals0[k]; a1 += r.animals1[k]; }
  ok('wild animals near villages neither die out nor keep growing (half to double over each run)', a0 > 0 && a1 / a0 >= 0.5 && a1 / a0 <= 2, { start: a0, end: a1, ratio: a0 ? +(a1 / a0).toFixed(2) : null });
  let keeperDays = 0, missed = 0;
  for (const r of runs) for (let d = 0; d < r.days; d++) for (const k of r.keys) {
    const kp = r.pops[d + 1][k][1];
    if (!kp) continue;
    keeperDays += kp;
    missed += Math.min(kp, end.noWild[k + ' ' + (r.d0 + d)] || 0);
  }
  if (keeperDays) ok('a cowherd, poultry keeper or stable hand finds a wild animal on at least 4 days in 5', (keeperDays - missed) / keeperDays >= 0.8, { keeperDays, missed, ratio: +((keeperDays - missed) / keeperDays).toFixed(2) });
  else ok('the villages had a cowherd, poultry keeper or stable hand to check', false, { keeperDays });
  ok('no page errors', pageErrors === 0, pageErrors);
  console.log(`SAVE wild mobs stored in unloaded chunks: ${end.wildlifeBytes} bytes of JSON (${JSON.stringify(end.stored)}); loaded mobs: ${end.mobsBytes} bytes`);
  const sum = { seed: SEED, days: DAYS, spot: setup.spot, villages: villages.size, nights, reached, attacks, deaths, lost, born: end.born, died: end.died, animals: [a0, a1], keeperDays, missed, wildlifeBytes: end.wildlifeBytes, mobsBytes: end.mobsBytes, runs, seconds: Math.round((Date.now() - t0) / 1000) };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(sum, null, 1));
  await b.close();
  console.log(fails.length ? 'FAILED: ' + fails.length : 'ALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
