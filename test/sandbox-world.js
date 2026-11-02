// @ci integration suite=world hosts=worker,server timeout=420
// Sandbox worlds and scenes (spec idea-050): a sandbox world is the planet with a grass plain for ground at spawn and 2 km away, saves
// and loads as one, spawns nothing in 10 game minutes; each shipped scene places every entry with no ERROR; a scene with bad entries
// logs one ERROR each and places the rest; /scene clear puts the plain back; normal worlds generate exactly as before.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/sandbox test/sandbox-world.js [--host page|worker|server]
const fs = require('fs'), path = require('path');
const lib = require('./lib');
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
  // lib.simReady waits for entities too, and a sandbox world has none: the clock ticking and the simulation on the page's seed
  const simReady = async () => {
    if (!(await pg.evaluate(() => BF.simHost.worker))) return;
    await pg.waitForFunction(() => BF.client && BF.client.world.clock && BF.client.world.clock.tick > 40, null, { timeout: 300000, polling: 250 });
    const seed = await pg.evaluate(() => BF.state.seed >>> 0);
    for (let i = 0; i < 600 && !(await lib.sim(pg, s => BF.state.seed >>> 0 === s && BF.rand.tick > 20, seed)); i++) await pg.waitForTimeout(500);
  };
  const scene = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sandbox', 'scenes', n + '.json'), 'utf8'));

  // a normal world's chunks before any sandbox world (the boot world, seed 123): compared again at the end
  const normal = () => pg.evaluate(() => {
    const G = BF.worldgen, s = BF.worldSpawn, out = [];
    for (const [dx, dz] of [[0, 0], [5, -3], [-40, 22]]) {
      const r = G.generateBand(Math.floor(s.x / 16) + dx, Math.floor(s.z / 16) + dz);
      let h = 0; for (let i = 0; i < r.vox.length; i++) h = (Math.imul(h, 31) + r.vox[i]) | 0;
      out.push(r.lo + ":" + r.hi + ":" + h);
    }
    return out.join(" ");
  });
  const before = await normal();

  // ---- a new sandbox world
  const meta = await pg.evaluate(async () => { BF.player.start(); return BF.save.create({ name: "sandbox-test", seed: "77", gameMode: "creative", world: "flat" }); });
  await simReady();
  check(meta.world === 'flat', `the world list entry says sandbox (world ${meta.world})`);
  await pg.waitForFunction(() => BF.world.isLoaded(BF.worldSpawn.x, BF.worldSpawn.z), null, { timeout: 60000 });
  const plain = await lib.sim(pg, () => {
    const W = BF.world, s = BF.worldSpawn, G = BF.worldgen, F = BF.flatgen, B = BF.B, P = BF.planet;
    const col = (x, z) => { const c = W.loadAt(x, z); const ids = []; for (let y = F.TOP - 5; y <= F.TOP + 3; y++) ids.push(W.getBlock(x, y, z)); return { ids, h: W.heightAt(x, z) }; };
    const want = []; for (let y = F.TOP - 5; y <= F.TOP + 3; y++) want.push(F.plainAt(y));
    const a = col(Math.floor(s.x), Math.floor(s.z)), b = col(Math.floor(s.x) + 2000, Math.floor(s.z) - 300);
    const cu = P.canonCell(s.x, s.z, {});
    let odd = 0;
    for (let dz = -24; dz <= 24; dz += 3) for (let dx = -24; dx <= 24; dx += 3) { const c = col(Math.floor(s.x) + dx, Math.floor(s.z) + dz); if (c.ids.join() !== want.join()) odd++; }
    return { a, b, want, odd, face: cu.f, u: cu.u, v: cu.v, N: P.N, world: BF.state.world, gen: G.world, biome: G.biomeAt(s.x, s.z).name, vill: G.villagesNear(s.x, s.z, 5000).length,
      bedrock: G.generateRange(Math.floor(s.x / 16), Math.floor(s.z / 16), BF.SY0, BF.SY0 + 1)[0] === B.bedrock, rivers: G.riversReady() };
  });
  console.log(JSON.stringify(plain));
  check(plain.world === 'flat' && plain.gen === 'flat', 'the simulation runs the flat generator');
  check(plain.a.ids.join() === plain.want.join() && plain.a.h === 4, `the plain at spawn: stone, 3 dirt, grass at y 4, air above (h ${plain.a.h})`);
  check(plain.b.ids.join() === plain.want.join() && plain.b.h === 4, 'the same plain 2 km away');
  check(plain.odd === 0, `no tree, plant or water in 48 x 48 round spawn (${plain.odd} odd columns)`);
  check(plain.face === 4 && Math.abs(plain.u - plain.N / 2) < 2 && Math.abs(plain.v - plain.N / 2) < 2, `spawn at the centre of face 4 (face ${plain.face}, u ${plain.u}, v ${plain.v})`);
  check(plain.bedrock, 'bedrock floor');
  check(plain.biome === 'Plains' && plain.vill === 0 && plain.rivers, 'one biome (Plains), no villages, no river solve');
  const loc = await pg.evaluate(() => BF.commands.execute('/locate village'));
  const locMsg = loc.pending ? (await pg.evaluate(() => new Promise(r => BF.commands.execute('/locate village').done.then(r)))).msg : loc.msg;
  check(/no villages/.test(locMsg), `/locate village says there are none: "${locMsg}"`);
  // the page's copy (distant terrain, meshing) is the plain too
  const pageSide = await pg.evaluate(() => ({ gen: BF.worldgen.world, h: BF.worldgen.heightAt(BF.worldSpawn.x + 5000, BF.worldSpawn.z), state: BF.state.world }));
  check(pageSide.gen === 'flat' && pageSide.h === 4 && pageSide.state === 'flat', 'the page generates the plain too');

  // ---- nothing spawns in 10 game minutes (night included)
  const sp = await lib.sim(pg, () => BF.mobs.list.length);
  await pg.evaluate(() => BF.commands.execute('/time set midnight'));
  await lib.sim(pg, () => { const W = BF.warp, n = Math.round(600 / W.TICK); for (let i = 0; i < n; i++) BF.simStep(W.TICK); });
  const after = await lib.sim(pg, () => BF.mobs.list.filter(m => !m.dead).map(m => m.type));
  check(sp === 0 && after.length === 0, `nothing spawned in 10 game minutes at night (${after.join(', ') || 'none'})`);

  // ---- the shipped scenes
  const errsNow = () => lib.sim(pg, () => BF.glog.recent(5000).filter(e => e.l === 'ERROR').length);
  for (const n of ['empty', 'trees', 'animals']) {
    const sc = scene(n), e0 = await errsNow();
    await lib.sim(pg, () => { for (const m of BF.mobs.list.slice()) BF.mobs.discard(m); });
    const r = await pg.evaluate(([sc, n]) => BF.sandbox.place(sc, { name: n }), [sc, n]);
    await pg.waitForTimeout(400);
    const e1 = await errsNow();
    const mobsWanted = sc.entries.filter(e => e.mob).reduce((t, e) => t + (e.count || 1), 0);
    console.log(n + ': ' + JSON.stringify({ ok: r.ok, placed: r.placed, same: r.same, skipped: r.skipped, mobs: r.mobs, errors: r.errors }));
    check(r.ok && !r.errors.length && !r.skipped && e1 === e0, `scene ${n} places cleanly (${r.placed} blocks, ${r.mobs} mobs, ${e1 - e0} new ERROR lines)`);
    check(r.mobs === mobsWanted, `scene ${n}: every mob made (${r.mobs} of ${mobsWanted})`);
    if (n === 'trees') {
      // every tree entry put its blocks down: a log or stem above the grass at each tree's spot
      const s = await pg.evaluate(() => ({ x: Math.floor(BF.worldSpawn.x), z: Math.floor(BF.worldSpawn.z) }));
      const spots = sc.entries.filter(e => e.tree).map(e => [s.x + e.at[0], 5, s.z + e.at[2], e.tree]);
      const miss = await lib.sim(pg, spots => spots.filter(([x, y, z]) => { for (let k = 0; k < 4; k++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, -1]]) if (BF.world.getBlock(x + dx, y + k, z + dz)) return false; return true; }).map(s => s[3]), spots);
      check(!miss.length, `every tree kind stands in the trees scene${miss.length ? ' (missing ' + miss.join(', ') + ')' : ''}`);
      await pg.screenshot({ path: out + '-trees.png' });
    }
  }
  // ---- a scene with bad entries: one ERROR each, the rest placed
  {
    const bad = { entries: [{ block: 'stone', at: [30, 0, 30] }, { tree: 'banana', at: [32, 0, 30] }, { block: 'no_such_block', at: [34, 0, 30] }, { mob: 'dragon', at: [36, 0, 30] }, { block: 'planks', at: [38, 0, 30] }] };
    const e0 = await errsNow();
    const r = await pg.evaluate(sc => BF.sandbox.place(sc, { name: 'bad' }), bad);
    await pg.waitForTimeout(400);
    const e1 = await errsNow();
    const got = await lib.sim(pg, () => { const s = BF.worldSpawn, x = Math.floor(s.x), z = Math.floor(s.z); return [BF.world.getBlock(x + 30, 5, z + 30) === BF.B.stone, BF.world.getBlock(x + 38, 5, z + 30) === BF.B.planks]; });
    console.log('bad: ' + JSON.stringify(r.errors));
    check(r.errors.length === 3 && e1 - e0 >= 3, `three bad entries skipped with an ERROR each (${r.errors.length} skipped, ${e1 - e0} new ERROR lines)`);
    check(got[0] && got[1], 'the good entries of that scene placed');
  }
  // ---- /scene clear puts the plain back
  {
    const r = await pg.evaluate(() => BF.sandbox.clear(96, BF.worldSpawn));
    const left = await lib.sim(pg, () => {
      const s = BF.worldSpawn, F = BF.flatgen; let n = 0;
      for (let dz = -60; dz <= 60; dz += 2) for (let dx = -60; dx <= 60; dx += 2) { if (dx * dx + dz * dz > 90 * 90) continue; for (let y = F.TOP - 2; y < F.TOP + 30; y++) if (BF.world.getBlock(Math.floor(s.x) + dx, y, Math.floor(s.z) + dz) !== F.plainAt(y)) n++; }
      return { n, mobs: BF.mobs.list.filter(m => !m.removed).length };
    });
    check(r.ok && left.n === 0 && left.mobs === 0, `/scene clear 96 put the plain back (${r.cleared} blocks cleared, ${left.n} odd cells, ${left.mobs} mobs left)`);
  }
  // ---- /scene refuses outside a sandbox world, and the world saves and loads as a sandbox
  await pg.evaluate(async id => { await BF.save.saveNow(); await BF.save.load(id); }, meta.id);
  await simReady();
  const re = await lib.sim(pg, () => ({ world: BF.state.world, gen: BF.worldgen.world, h: BF.worldgen.heightAt(BF.player.position.x, BF.player.position.z) }));
  check(re.world === 'flat' && re.gen === 'flat' && re.h === 4, 'the saved sandbox world loads as a sandbox world');
  const list = await pg.evaluate(() => BF.save.list());
  check(list.some(w => w.id === meta.id && w.world === 'flat'), 'the world list keeps it as Sandbox');

  // ---- back in a normal world: the planet's generator, unchanged
  await pg.evaluate(async () => { await BF.save.create({ name: "planet-after", seed: "123", gameMode: "creative", villages: 10 }); });
  await lib.simReady(pg);
  const st = await lib.sim(pg, () => ({ world: BF.state.world, gen: BF.worldgen.world }));
  check(st.world === 'planet' && st.gen === 'planet', 'a new planet world after it runs the planet generator');
  const refused = await pg.evaluate(() => BF.sandbox.place({ entries: [{ block: 'stone', at: [0, 0, 0] }] }, { name: 'nope' }));
  check(!refused.ok, 'scenes refuse to place in a normal world');
  const after2 = await normal();
  check(after2 === before, 'a normal world generates exactly as before a sandbox world was opened');
  if (fails) console.log(`FAIL ${fails} sandbox check(s) failed`);
};
