// @ci integration hosts=worker,server
// Village starting kits and desert gardens (release 1.1): NODE_PATH=$(npm root -g) node test/run.js /tmp/vk test/village-kits.js
// - village generator 3 rosters: at least 3 villagers, every village has a miner, a farmer and a forester, each with its jobsite planned
// - founding villagers' tools (wooden hoe / axe / pickaxe, shears; 30-40 torches for miners); villagers hired later get emeralds only
// - desert villages have a garden of grass with oak trees that the forester can fell and replant
// - a farmer without a hoe buys one from the village's toolsmith
// @ci integration
module.exports = async (pg) => {
  const lib = require('./lib');
  await lib.simBFT(pg);
  const res = await lib.sim(pg, async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, T = BF.trades, names = a => a.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count);
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    BF.state.paused = true;

    // ---- rosters (village generator 9 is the default for new worlds; 3 to 9 have the same rosters but 4 adds a coop and its poultry keeper,
    // 5 a pasture and its cowherd in grass villages of 10+, 6 a baker per 15 villagers with its oven, 8 a beekeeper, 9 a pig farmer and sty in 60% of grass villages of 10+)
    let pigFarmers = 0, pigOK = 0, styBad = [];
    let cowherds = 0, pastureBad = [], bakers = 0, bakerBad = [], bakerShort = 0;
    let villages = 0, minPop = Infinity, core = 0, planned = 0, deserts = 0, gardens = 0, bad = [], desertV = null;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      BF.newWorld(seed, { gen: 4, villages: 9 });
      const o = BFT.spawn();   // sampled around the spawn, on its face
      if (seed === 1) ok("new worlds use village generator 9", BF.state.villages >= 9, BF.state.villages);
      const seen = new Set(), P = BF.planet, N = P.N, sample = [];
      for (let rz = -8; rz < 8; rz++) for (let rx = -8; rx < 8; rx++) sample.push(...BF.worldgen.villagesNear(o.x + rx * 384, o.z + rz * 384, 200));
      // the spawn is temperate: desert villages (and their gardens) are looked for over all six faces
      for (let f = 0; f < 6; f++) for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { const a = P.atlas(f, N * (i + 0.5) / 6, N * (j + 0.5) / 6); sample.push(...BF.worldgen.villagesNear(a.x, a.z, 600).filter(v => v.style === 1)); }
      for (const v of sample) {
        const key = Math.round(v.x) + "," + Math.round(v.z);
        if (seen.has(key)) continue;
        seen.add(key); villages++;
        const ro = BF.mobs.roster({ key, houses: v.houses || [], nb: v.nb0 != null ? v.nb0 : v.buildings.length, pop: v.pop || 0, ground: v.ground });
        minPop = Math.min(minPop, v.pop);
        const has = p => ro.some(sl => sl.prof === p);
        if (has("miner") && has("farmer") && has("forester") && has("toolsmith")) core++; else bad.push([seed, key, v.pop, ro.map(sl => sl.prof).join(" ")]);
        if (ro.length !== v.pop) bad.push([seed, key, "roster", ro.length, "pop", v.pop]);
        const plan = BF.jobs.planVillage(v), slotOf = p => ro.filter(sl => sl.prof === p).map(sl => sl.idx);
        if (["miner", "farmer", "forester", "toolsmith"].every(p => plan.some(j => slotOf(p).includes(j.slot) && j.prof === p))) planned++;
        if (v.style === 1) {
          deserts++;
          const g = v.buildings.find(b => b.type === "garden");
          if (g) { gardens++; if (!desertV && seed === 1) desertV = { x: v.x, z: v.z, g: { x0: g.x0, z0: g.z0, x1: g.x1, z1: g.z1, y: g.y } }; }
        }
        if (v.style !== 1 && v.buildings.some(b => b.type === "garden")) bad.push([seed, key, "garden outside the desert"]);
        const ch = has("cowherd"), pa = v.buildings.some(b => b.type === "pasture");
        if (ch) cowherds++;
        if (ch !== pa || (ch && (v.ground !== 0 || v.pop < 10 || !plan.some(j => j.prof === "cowherd" && slotOf("cowherd").includes(j.slot))))) pastureBad.push([seed, key, v.pop, v.ground, ch, pa]);
        const pf = has("pig_farmer"), st = v.buildings.some(b => b.type === "sty");
        if (v.ground === 0 && v.pop >= 10) pigOK++;
        if (pf) pigFarmers++;
        if (pf !== st || (pf && (v.ground !== 0 || v.pop < 10 || !plan.some(j => j.prof === "pig_farmer" && j.id === BF.B.feed_trough && slotOf("pig_farmer").includes(j.slot))))) styBad.push([seed, key, v.pop, v.ground, pf, st]);
        const nb = ro.filter(sl => sl.prof === "baker").length;
        bakers += nb;
        if (nb < Math.floor(v.pop / 15)) bakerShort++;   // every resident was someone it may not replace (core jobs, specials, the first shepherds)
        if (nb > Math.floor(v.pop / 15) || slotOf("baker").some(i => !plan.some(j => j.prof === "baker" && j.slot === i && j.id === BF.B.bakers_oven)) || slotOf("baker").some(i => i < 1800)) bakerBad.push([seed, key, v.pop, nb, slotOf("baker")]);
      }
    }
    ok("sampled villages", villages > 30, villages);
    ok("every village has 4+ villagers", minPop >= 4, minPop);
    ok("every village has a miner, a farmer, a forester and a toolsmith", core === villages, { core, villages, bad: bad.slice(0, 4) });
    ok("each of the four has its jobsite planned", planned === villages, { planned, villages });
    ok("generator 5: grass villages of 10+ with a cowherd have a pasture and a churn, none without", cowherds > 5 && pastureBad.length === 0, { cowherds, bad: pastureBad.slice(0, 4) });
    ok("generator 6: a baker per 15 villagers at most (none below 15), each with its oven planned", bakers > 5 && bakerBad.length === 0, { bakers, bad: bakerBad.slice(0, 4) });
    ok("... and almost every village of 15+ gets its full count (a resident it may replace)", bakerShort <= villages * 0.02, { bakerShort, villages });
    ok("generator 9: grass villages of 10+ with a pig farmer have a sty and a feed trough, none without", pigFarmers > 5 && styBad.length === 0, { pigFarmers, bad: styBad.slice(0, 4) });
    ok("... in about 60% of the grass villages of 10+", pigOK > 10 && Math.abs(pigFarmers / pigOK - 0.6) < 0.15, { pigFarmers, of: pigOK });
    {
      BF.newWorld(1, { gen: 4, villages: 8 });
      let n7 = 0, s7 = 0;
      for (const v of BFT.villages(1500)) {
        n7 += BF.mobs.roster({ key: Math.round(v.x) + "," + Math.round(v.z), houses: v.houses || [], nb: v.nb0 != null ? v.nb0 : v.buildings.length, pop: v.pop || 0, ground: v.ground }).filter(sl => sl.prof === "pig_farmer").length;
        s7 += v.buildings.filter(b => b.type === "sty").length;
      }
      ok("worlds saved with generator 8 keep 8: no pig farmers or sties", n7 === 0 && s7 === 0, { n7, s7 });
    }
    {
      BF.newWorld(1, { gen: 4, villages: 5 });
      let n5 = 0;
      for (const v of BFT.villages(1500)) n5 += BF.mobs.roster({ key: Math.round(v.x) + "," + Math.round(v.z), houses: v.houses || [], nb: v.nb0 != null ? v.nb0 : v.buildings.length, pop: v.pop || 0, ground: v.ground }).filter(sl => sl.prof === "baker").length;
      ok("worlds saved with generator 5 keep 5: no bakers planned", n5 === 0, n5);
    }
    ok("every desert village has a garden", deserts > 0 && gardens === deserts, { deserts, gardens });
    const tiny = BF.mobs.roster({ key: "9999,9999", houses: [1, 2, 3, 4].map(() => ({ type: "house", beds: [{}] })), nb: 7, pop: 4 }).map(s => s.prof).sort();
    ok("a 4-villager village is exactly miner, farmer, forester, toolsmith", tiny.join() === "farmer,forester,miner,toolsmith", tiny);

    // ---- founding kits
    const kit = p => T.stockFor(p, {});
    const tools = a => a.filter(s => s && ((BF.items[s.id].tool && typeof BF.items[s.id].tool === "object") || BF.items[s.id].name === "shears")).map(s => BF.items[s.id].name);
    const cnt = (a, n) => T.inv.count(a, I[n]);
    const mi = kit("miner"), fa = kit("farmer"), fo = kit("forester"), sh = kit("shepherd");
    ok("founding miner: stone pickaxe only", tools(mi).join() === "stone_pickaxe", names(mi));
    ok("founding miner: 30-40 torches", cnt(mi, "torch") >= 30 && cnt(mi, "torch") <= 40, cnt(mi, "torch"));
    ok("founding farmer: wooden hoe only, and a bucket", tools(fa).join() === "wooden_hoe" && cnt(fa, "bucket") === 1, names(fa));
    ok("founding forester: wooden axe only", tools(fo).join() === "wooden_axe", names(fo));
    ok("founding shepherd: one pair of shears and wheat", tools(sh).join() === "shears" && cnt(sh, "wheat_item") >= 8, names(sh));

    // ---- the toolsmith makes buckets: with only iron for one and a full stock of everything else, it makes a bucket
    if (BF.toolsmith && BF.toolsmith.CATS.includes("bucket")) {
      const m = { inv: T.inv.create(), profession: "toolsmith", position: { x: 0, y: 0, z: 0, distanceTo: () => 0 }, village: null };
      for (const n of ["iron_pickaxe", "iron_axe", "iron_hoe", "shears"]) T.inv.add(m.inv, I[n], 2);
      T.inv.add(m.inv, I.iron_ingot, 3);
      const p = BF.toolsmith.plan(m);
      ok("toolsmith plans a bucket from 3 iron ingots", !!p && p.cat === "bucket" && p.ready, p);
    } else ok("toolsmith knows buckets", false);

    // ---- later hires: emeralds (and a miner's torches), nothing else
    for (const p of ["miner", "farmer", "forester", "shepherd"]) {
      const m = { inv: T.inv.create() };
      T.inv.add(m.inv, I.bread, 3);
      T.hireKit(m, p);
      const got = names(m.inv).filter(s => !/^bread/.test(s));
      const em = cnt(m.inv, "emerald"), extra = got.filter(s => !/^emerald/.test(s) && !(p === "miner" && /^torch/.test(s)));
      ok("hired " + p + ": emeralds for its tools, nothing else", em >= 1 && extra.length === 0 && (p !== "miner" || (cnt(m.inv, "torch") >= 30 && cnt(m.inv, "torch") <= 40)), got);
    }
    const rich = { inv: T.inv.create() }; T.inv.add(rich.inv, I.emerald, 20); T.hireKit(rich, "farmer");
    ok("a hire who can already pay gets no more emeralds", cnt(rich.inv, "emerald") === 20, cnt(rich.inv, "emerald"));

    // ---- the desert garden, live
    if (desertV) {
      BF.newWorld(1, { gen: 4, villages: 9, gameMode: "survival" });
      BF.mobs.spawning = false;
      const g = desertV.g, gx = (g.x0 + g.x1) >> 1, gz = (g.z0 + g.z1) >> 1;
      BF.player.teleport(gx + 0.5, g.y + 12, gz + 0.5);
      for (let i = 0; i < 600; i++) { BF.world.update(gx, gz, 8); await new Promise(r => setTimeout(r, 10)); if (i > 50 && BF.world.queueLength === 0) break; }
      let grass = 0, cells = 0;
      const bases = [];
      for (let x = g.x0; x <= g.x1; x++) for (let z = g.z0; z <= g.z1; z++) {
        cells++;
        if (BF.world.getBlock(x, g.y, z) === BF.B.grass) grass++;
        if (BF.world.getBlock(x, g.y + 1, z) === BF.B.oak_log) bases.push([x, g.y + 1, z]);
      }
      ok("garden is grass", grass === cells, { grass, cells });
      ok("garden has 1-2 trees the forester can fell", bases.length >= 1 && bases.length <= 2 && bases.every(b => !!BF.forester.treeAt(b[0], b[1], b[2])), bases);
      BF.sky.setTime(0.1);
      const key = Math.round(desertV.x) + "," + Math.round(desertV.z);
      for (let k = 0; k < 160 && !((BF.mobs.villages.get(key) || { members: [] }).members.some(m => m.profession === "forester")); k++) { BF.world.update(gx, gz, 8); run(0.5); }
      const rec = BF.mobs.villages.get(key), F = rec && rec.members.find(m => m.profession === "forester");
      ok("desert village forester spawned", !!F);
      if (F) {
        bases.forEach(b => BF.forester.fell(F, BF.forester.treeAt(b[0], b[1], b[2])));
        // the garden is the soil the check is about: a planet desert can have other grass or dirt round the village (gen 3 deserts were all sand), so it is sanded
        { const W = BF.world, soil = new Set([BF.B.grass, BF.B.dirt, BF.B.coarse_dirt, BF.B.podzol].filter(v => v != null));
          for (let x = g.x0 - 16; x <= g.x1 + 16; x++) for (let z = g.z0 - 16; z <= g.z1 + 16; z++) if (!(x >= g.x0 && x <= g.x1 && z >= g.z0 && z <= g.z1) && W.isLoaded(x, z)) for (let y = g.y - 4; y <= g.y + 6; y++) if (soil.has(W.getBlock(x, y, z))) W.setBlock(x, y, z, BF.B.sand); }
        let spot = null;
        for (let k = 0; k < 20 && !spot; k++) spot = BF.forester.findSpot(F, { x: gx + 0.5, y: g.y + 1, z: gz + 0.5 });
        ok("forester finds a planting spot in the garden after felling", !!spot && spot.x >= g.x0 && spot.x <= g.x1 && spot.z >= g.z0 && spot.z <= g.z1, { spot, garden: [g.x0, g.x1, g.z0, g.z1, g.y], forester: [Math.round(F.position.x), Math.round(F.position.y), Math.round(F.position.z)] });
      }
    } else ok("seed 1 has a desert village to visit", false);

    // ---- a farmer with no hoe and no bucket buys both from the toolsmith
    BF.newWorld(1, { gen: 4, villages: 9, gameMode: "survival" });
    BF.mobs.spawning = false;
    const V = BFT.village(), vkey = Math.round(V.x) + "," + Math.round(V.z);
    BF.player.teleport(V.x + 4.5, V.y + 3, V.z + 4.5);
    for (let i = 0; i < 600; i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (i > 50 && BF.world.queueLength === 0) break; }
    BF.sky.setTime(0.08);
    for (let k = 0; k < 160 && !((BF.mobs.villages.get(vkey) || { members: [] }).members.some(m => m.profession === "farmer" && m.jobsite)); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(vkey), vs = rec ? rec.members.filter(m => m.type === "villager" && !m.dead && !m.child && m.inv) : [];
    const fm = vs.find(m => m.profession === "farmer" && m.jobsite);
    ok("village farmer found", !!fm);
    if (fm) {
      // the village's toolsmith, or (in case it has none) another working villager given the toolsmith's hoe and bucket offers
      let ts = vs.find(m => m.profession === "toolsmith" && m.jobsite);
      if (!ts) {
        ts = vs.find(m => m !== fm && m.jobsite && m.profession !== "farmer");
        BF.inventory.ensureTrades(ts);
        for (const id of [I.iron_hoe, I.bucket]) ts.trades.push(BF.trades.offers("toolsmith", 1).find(o => o.sell.id === id));
      }
      BF.inventory.ensureTrades(ts);
      if (T.inv.count(ts.inv, I.iron_hoe) < 1) T.inv.add(ts.inv, I.iron_hoe, 1);
      if (T.inv.count(ts.inv, I.bucket) < 1) T.inv.add(ts.inv, I.bucket, 1);
      fm.inv = fm.inv.map(s => s && /(_hoe|bucket)$/.test(BF.items[s.id].name) ? null : s);
      if (T.inv.count(fm.inv, I.emerald) < 5) T.inv.add(fm.inv, I.emerald, 5);
      ok("farmer without a hoe or bucket wants one", !!BF.villageLife.toolNeed(fm));
      ok("toolsmith is a seller", !!BF.villageLife.findToolSeller(fm, BF.villageLife.toolNeed(fm)));
      const t0 = BF.sky.time;
      for (let k = 0; k < 240 && BF.villageLife.toolNeed(fm); k++) run(0.5);
      const hoe = fm.inv.find(s => s && /_hoe$/.test(BF.items[s.id].name));
      ok("farmer bought a bucket too", T.inv.count(fm.inv, I.bucket) + T.inv.count(fm.inv, I.water_bucket) > 0, names(fm.inv));
      ok("farmer bought a hoe", !!hoe, hoe ? BF.items[hoe.id].name : { prof: fm.profession, need: !!BF.villageLife.toolNeed(fm), inv: names(fm.inv), shop: fm.fshop && { stage: fm.fshop.stage, cd: fm.fshop.cd, checkT: fm.fshop.checkT, avoid: fm.fshop.avoid }, now: BF.sky.day + BF.sky.time, mode: fm.ai && fm.ai.mode, st: fm.st || null, ts: { prof: ts.profession, d: ts.position.distanceTo(fm.position), sleeping: ts.sleeping, hoes: T.inv.count(ts.inv, I.iron_hoe), offers: (ts.trades || []).map(o => BF.items[o.sell.id].name) }, log: BF.villageLife.log.slice(-5) });
      R.lines.push("INFO bought after " + ((BF.sky.time - t0) * 20).toFixed(1) + " game minutes");
    }
    return R;
  });
  for (const l of res.lines) console.log(l);
};
