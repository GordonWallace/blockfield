// @ci integration suite=jobs
// bug-055: a builder fetches a well's water before it lays the first block. With no bucket, or no water to be had, it gives the well up with
// nothing placed (the village log says so) and picks no well for a game day; with water in hand it builds the well with its water.
// Usage: NODE_PATH=$(npm root -g) node test/builder-wells.js [seed=1337]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 1337);
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed);
  await require('./lib').ready(pg);   // the planet: its river step first
  await pg.waitForTimeout(3000);

  const vs = await pg.evaluate(() => {
    window.__halt = true;
    BF.player.setGameMode && BF.player.setGameMode('creative');
    const vs = BFT.villages(3000).filter(v => v && v.pop && (v.buildings || []).length >= 6);
    return vs.slice(0, 8).map(v => ({ x: v.x, z: v.z, y: v.y }));
  });
  let vk = null;
  for (const c of vs) {
    const ok = await pg.evaluate(v => {
      const key = Math.round(v.x) + "," + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      return BF.mobs.list.some(m => m.type === "villager" && m.village && m.village.key === key && !m.dead && m.profession === "builder");
    }, c);
    if (ok) { vk = { ...c, key: Math.round(c.x) + "," + Math.round(c.z) }; break; }
  }
  check(!!vk, 'village with a builder ' + (vk ? vk.key : '-'));
  if (!vk) { await b.close(); process.exit(1); }

  const r = await pg.evaluate(v => {
    const T = BF.trades.inv, L = BF.vlog, I = BF.I, W = BF.world, out = {};
    const bl = BF.mobs.list.find(m => m.type === "villager" && m.village && m.village.key === v.key && !m.dead && m.profession === "builder");
    const R = bl.village, built = BF.builder.builtOf(R);
    BF.sky.setTime(0.2);
    if (BF.villageSim) BF.villageSim.begin = () => true;   // no unload countdown here
    const kit = bucket => {
      for (const e of built) if (e.state === "building") e.state = "abandoned";
      for (let i = 0; i < bl.inv.length; i++) bl.inv[i] = null;
      for (let st = 0; st < 6; st++) {   // the well's materials in every village style (and its foundation)
        const bp = BF.blueprints.get("well", 0, st, 0.5, null, BF.blueprints.styleWood(st));
        if (!bp) continue;
        for (const k in bp.req) if (T.count(bl.inv, +k) < bp.req[k] + 8) T.add(bl.inv, +k, bp.req[k] + 8);
        const f = BF.worldgen.palette(st).found;
        if (f != null && T.count(bl.inv, f) < 24) T.add(bl.inv, f, 24);
      }
      if (bucket) T.add(bl.inv, I[bucket], 1);
      bl.kitFor = bl.profession;
      const bs = bl.bs = { mode: "idle", t: 0, cool: 0, fail: {}, avoid: {}, placeT: 0.6 };
      const wood = BF.blueprints.styleWood(0);
      const e = BF.builder.beginPlan(bl, bs, "well", wood);
      if (e) BF.builder.startBuild(bl, bs, e, true);
      return { bs, e };
    };
    const blocksAt = e => { let n = 0; for (let x = e.ox; x < e.ox + e.w; x++) for (let z = e.oz; z < e.oz + e.d; z++) for (let y = e.oy - 1; y < e.oy + 6; y++) { const id = W.getBlock(x, y, z); if (id && !BF.REPLACEABLE[id] && !(BF.FLUID[id])) n++; } return n; };
    const run = (bs, e, secs, until) => { for (let t = 0; t < secs && !(until && until()); t += 0.25) BF.builder.ai(bl, 0.25, { x: 0, z: 0 }); };
    const VL = BF.villageLife, findWater0 = VL.findWater;
    const lines0 = L.entries(R.key).length;
    // 1. no bucket at all
    {
      const { bs, e } = kit(null);
      out.planned1 = !!e;
      if (e) {
        const b0 = blocksAt(e);
        run(bs, e, 3);
        out.noBucket = { state: e.state, prog: e.prog, mode: bs.mode, fail: bs.fail.well, placed: blocksAt(e) - b0 };
        out.noBucketPick = BF.builder.weighTypes(bl, bs).some(([t]) => t === "well");
      }
    }
    // 2. an empty bucket, and no water anywhere
    {
      VL.findWater = () => null;
      const { bs, e } = kit('bucket');
      out.planned2 = !!e;
      if (e) {
        const b0 = blocksAt(e);
        run(bs, e, 2);
        out.fetching = bs.mode;
        out.status = BF.builder.statusText(bl);
        run(bs, e, 300, () => e.state !== "building");
        out.noWater = { state: e.state, prog: e.prog, mode: bs.mode, placed: blocksAt(e) - b0, bucket: T.count(bl.inv, I.bucket) };
      }
      VL.findWater = findWater0;
    }
    // 3. an empty bucket and a water source by the builder: it fills it first, then builds the well with its water
    {
      const { bs, e } = kit('bucket');
      out.planned3 = !!e;
      if (e) {
        const x = Math.floor(bl.position.x) + 1, y = Math.floor(bl.position.y), z = Math.floor(bl.position.z);
        W.setBlock(x, y - 1, z, BF.B.stone); W.setBlock(x, y, z, BF.B.water);
        VL.findWater = () => ({ x, y, z, sx: Math.floor(bl.position.x), sy: y, sz: z });
        run(bs, e, 20, () => bs.mode === "build" && e.watered);
        VL.findWater = findWater0;
        out.filled = { watered: !!e.watered, mode: bs.mode, wb: T.count(bl.inv, I.water_bucket), source: W.getBlock(x, y, z) === BF.B.water };
        // reserve: the full bucket is kept off the market while the well needs it
        out.reserved = (BF.builder.reserve(bl)[I.water_bucket] || 0) >= 1;
        // place the whole well (teleporting to each cell keeps the test quick)
        for (let k = 0; k < 4000 && e.state === "building"; k++) {
          if (e.prog < e.n) { const c = BF.builder.cellOf(e, e.prog); bl.position.x = c.x + 0.5 + (c.x === e.ox + 1 && c.z === e.oz + 1 ? 2 : 0); bl.position.z = c.z + 0.5 + 2.2; bl.position.y = e.oy + 1; }
          BF.builder.ai(bl, 0.5, { x: 0, z: 0 });
        }
        let water = false;
        for (let x2 = e.ox; x2 < e.ox + e.w; x2++) for (let z2 = e.oz; z2 < e.oz + e.d; z2++) if (W.getBlock(x2, e.oy + 1, z2) === BF.B.water) water = true;
        out.built = { state: e.state, water, skipped: e.skipped };
      }
    }
    out.lines = L.entries(R.key).slice(lines0).filter(x => x[1] === "build").map(x => x[2]);
    return out;
  }, vk);
  console.log('   ', JSON.stringify(r));
  check(r.planned1 && r.noBucket && r.noBucket.state === 'abandoned' && r.noBucket.prog === 0 && r.noBucket.placed === 0, 'no bucket: the well is given up with nothing placed');
  check(r.noBucket && r.noBucket.fail > 0 && !r.noBucketPick, 'no well is picked again for a while');
  check(r.planned2 && r.fetching === 'fill' && r.status === 'Fetching water', 'an empty bucket: it fetches water before the first block');
  check(r.noWater && r.noWater.state === 'abandoned' && r.noWater.prog === 0 && r.noWater.placed === 0 && r.noWater.bucket === 1, 'no water to be had: the well is given up with nothing placed, the bucket kept');
  check(r.lines.some(s => / gave up building the (\w+ )?well at .*: no bucket to carry its water$/.test(s)) && r.lines.some(s => / gave up building the (\w+ )?well at .*: no water to fill it$/.test(s)), 'the village log says why');
  check(r.planned3 && r.filled && r.filled.watered && r.filled.mode === 'build' && r.filled.wb === 1 && !r.filled.source, 'with water near: it fills its bucket from the source (taken) and starts building');
  check(r.reserved, 'its full bucket is in its market reserve');
  check(r.built && r.built.state === 'done' && r.built.water, 'the finished well holds water');
  console.log(fails ? `FAILED ${fails}` : 'ALL OK');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
