// Forester checks: NODE_PATH=$(npm root -g) node test/run.js /tmp/fo test/forester-actions.js
// roster, stock and recipe; every sapling grows into a tree; players cannot plant on stone; a forester in a village fells trees,
// picks up what falls, plants the saplings and leaves doors alone; the sapling trade.
module.exports = async (pg, out) => {
  const r = await pg.evaluate(() => {
    const res = {}, I = BF.I, B = BF.B;
    let withF = 0, nF = 0, villages = 0, bad = 0, two = 0;
    for (let k = 0; k < 600; k++) {
      const houses = []; for (let i = 0; i < 6 + (k % 12); i++) houses.push({ type: "house", x: i * 9, z: 0, w: 5, d: 5, beds: [{}] });
      const nb = k % 3 ? 8 : 22;
      const ro = BF.mobs.roster({ key: k * 17 + "," + k * 5, houses, nb });
      const f = ro.filter(s => s.prof === "forester").length;
      villages++; nF += f; if (f) withF++; if (f > 1) two++;
      if (ro.length > 24 || f > (nb >= 19 ? 2 : 1)) bad++;
      if (new Set(ro.map(s => s.idx)).size !== ro.length) bad += 1000;
    }
    res.roster = { villages, nF, withF, two, bad };
    res.block = B.band_saw; res.jobsite = BF.jobs.JOBSITE.forester;
    res.stock = BF.trades.stockFor("forester", {}).filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count);
    res.offers = BF.trades.offers("forester", 1).map(o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name);
    res.recipe = !!(BF.recipes && JSON.stringify(BF.recipes).includes("Band Saw")) || "n/a";
    res.leafDrops = ["oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "cherry", "mangrove"].map(s => s + ":" + JSON.stringify(BF.blocks[B[s + "_leaves"]].extraDrops));
    return res;
  });
  console.log(JSON.stringify(r));
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);

  // 1. every sapling grows into a tree, in open ground away from the village
  const g = await pg.evaluate(() => {
    const B = BF.B, W = BF.world, F = BF.forester, res = {};
    const p = BF.player.position;
    const open = (x, z) => { const y = W.heightAt(x, z); return W.getBlock(x, y, z) === B.grass && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every(k => W.getBlock(x, y + k, z) === 0) ? y : -1; };
    // a flat grass patch: 7 spots 8 apart in a row
    let base = null;
    for (let r = 14; r < 60 && !base; r += 2) for (let a = 0; a < 6.28 && !base; a += 0.4) {
      const x0 = Math.floor(p.x + Math.cos(a) * r), z0 = Math.floor(p.z + Math.sin(a) * r);
      let ok = true, ys = [];
      for (let i = 0; i < 7 && ok; i++) { const y = open(x0 + i * 8, z0); if (y < 0) ok = false; ys.push(y); }
      if (ok) base = { x0, z0, ys };
    }
    if (!base) return "no flat grass row";
    F.SPECIES.forEach((sp, i) => {
      const x = base.x0 + i * 8, z = base.z0, y = base.ys[i] + 1;
      W.setBlock(x, y, z, B[sp + "_sapling"]);
      BF.emit("blockPlaced", x, y, z, B[sp + "_sapling"]);
      const before = F.saplings.size;
      const ok = F.growTree(x, y, z);
      let logs = 0, leaves = 0;
      for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = 0; dy <= 14; dy++) { const id = W.getBlock(x + dx, y + dy, z + dz); if (id === B[sp + "_log"]) logs++; else if (id === B[sp + "_leaves"]) leaves++; }
      res[sp] = { ok, logs, leaves, tree: !!F.treeAt(x, y, z) };
    });
    res.canSurviveStone = F.canSurvive(base.x0, base.ys[0] - 1, base.z0);
    res.canSurviveGrass = F.canSurvive(base.x0 + 4, base.ys[0] + 1, base.z0);
    BF.player.position.set(base.x0 + 3, base.ys[0] + 3, base.z0 + 14);
    window.__row = base;
    return res;
  });
  console.log(JSON.stringify(g));
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + '-trees.png' });

  // 2. a forester at work
  const setup = await pg.evaluate(() => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child);
    if (!vs.length) return "no villagers";
    const T = BF.trades, I = BF.I, B = BF.B, W = BF.world;
    const A = vs[0];
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    W.setBlock(tx, ty, tz, B.band_saw); BF.emit('blockPlaced', tx, ty, tz, B.band_saw);
    BF.mobs.setProfession(A, "forester"); A.xp = 0; A.level = 1; A.trades = []; A.inv = T.stockFor("forester", A);
    A.res = BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: B.band_saw, prof: "forester" } });
    T.inv.add(A.inv, I.oak_sapling, 4); T.inv.add(A.inv, I.birch_sapling, 2);
    // a tree 6 blocks from it
    window.__A = A;
    return { claim: A.res, prof: A.profession, village: !!A.village, jobsite: !!A.jobsite, pos: [A.position.x | 0, A.position.y | 0, A.position.z | 0] };
  });
  console.log(JSON.stringify(setup));
  if (typeof setup === "string") return;
  // grow a tree about 8 blocks from the forester (where the sapling can stand), then watch
  const tree = await pg.evaluate(() => {
    const A = window.__A, B = BF.B, W = BF.world, F = BF.forester;
    for (let r = 7; r < 16; r++) for (let a = 0; a < 6.28; a += 0.3) {
      const x = Math.floor(A.position.x + Math.cos(a) * r), z = Math.floor(A.position.z + Math.sin(a) * r), y = W.heightAt(x, z);
      if (W.getBlock(x, y, z) !== B.grass) continue;
      if (![1, 2, 3, 4, 5, 6, 7, 8].every(k => W.getBlock(x, y + k, z) === 0)) continue;
      W.setBlock(x, y + 1, z, B.oak_sapling); BF.emit("blockPlaced", x, y + 1, z, B.oak_sapling);
      if (F.growTree(x, y + 1, z)) return { at: [x, y + 1, z], tree: !!F.treeAt(x, y + 1, z) };
    }
    return null;
  });
  console.log("tree", JSON.stringify(tree));
  for (let k = 0; k < 70; k++) {
    const line = await pg.evaluate(() => {
      const A = window.__A;
      for (let i = 0; i < 100; i++) { BF.sky.setTime(0.1); BF.mobs.update(0.1); BF.player.position.set(A.position.x + 4, A.position.y + 2, A.position.z + 4); BF.world.tickSim && 0; }
      const F = BF.forester;
      return JSON.stringify({ pos: [A.position.x | 0, A.position.z | 0], task: A.fo && A.fo.task && A.fo.task.kind, saps: F.saplings.size, inv: A.inv.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count).join(","), drops: BF.drops.list.length });
    });
    if (k % 5 === 0) console.log(k, line);
  }
  console.log(JSON.stringify(await pg.evaluate(() => {
    const F = BF.forester, A = window.__A, W = BF.world, B = BF.B;
    const kinds = {};
    for (const e of F.LOG) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    // every planted sapling: distance to the nearest door and to the nearest other sapling
    const planted = F.LOG.filter(e => e.kind === "plant").map(e => e.at);
    const doors = [];
    for (let x = A.position.x - 40; x <= A.position.x + 40; x++) for (let z = A.position.z - 40; z <= A.position.z + 40; z++) for (let y = A.position.y - 6; y <= A.position.y + 6; y++) { const b = BF.blocks[W.getBlock(x | 0, y | 0, z | 0)]; if (b && b.door) doors.push([x | 0, y | 0, z | 0]); }
    const dd = planted.map(p => Math.round(Math.min(...doors.map(d => Math.hypot(d[0] - p[0], d[1] - p[1], d[2] - p[2])))));
    return { kinds, log: F.LOG.slice(-14), planted, doorDist: dd };
  })));
  await pg.screenshot({ path: out + '-work.png' });

  // 4. what the mod's GameTests guard: player-built logs are left alone, a full pack stops felling
  console.log(JSON.stringify(await pg.evaluate(() => {
    const A = window.__A, B = BF.B, W = BF.world, F = BF.forester, res = {};
    const p = BF.player.position;
    const fx = Math.floor(A.position.x), fz = Math.floor(A.position.z);
    let spot = null;
    for (let r = 3; r < 14 && !spot; r++) for (let a = 0; a < 6.28 && !spot; a += 0.4) {
      const x = fx + Math.round(Math.cos(a) * r), z = fz + Math.round(Math.sin(a) * r), y = W.heightAt(x, z);
      if (W.getBlock(x, y, z) === B.grass && [1, 2, 3, 4, 5].every(k => W.getBlock(x, y + k, z) === 0) && W.getBlock(x + 1, y + 1, z) === 0 && W.getBlock(x - 1, y + 1, z) === 0) spot = [x, y + 1, z];
    }
    if (!spot) return "no spot";
    const [x, y, z] = spot;
    for (let k = 0; k < 4; k++) W.setBlock(x, y + k, z, B.oak_log);                       // a log pillar, no leaves
    res.pillarNoLeaves = !!F.treeAt(x, y, z);
    W.setBlock(x, y + 4, z, B.oak_leaves);
    res.pillarWithLeaves = !!F.treeAt(x, y, z);
    W.setBlock(x + 1, y + 1, z, B.planks);                                            // a planked wall touching it: a building
    res.nextToPlanks = !!F.treeAt(x, y, z);
    // full pack: no felling
    W.setBlock(x + 1, y + 1, z, 0);
    const keep = A.inv.map(s => s && { id: s.id, count: s.count });
    A.inv = A.inv.map(() => ({ id: BF.I.cobblestone, count: 1 }));
    A.fo.cutCd = 0; A.fo.plantCd = 99; A.fo.task = null; A.fo.thinkT = 0;
    for (let i = 0; i < 30; i++) { BF.sky.setTime(0.1); BF.mobs.update(0.1); BF.player.position.set(A.position.x + 4, A.position.y + 2, A.position.z + 4); if (A.fo.task && A.fo.task.kind === "cut") res.cutWithFullPack = true; }
    A.inv = keep;
    for (let k = 0; k < 6; k++) W.setBlock(x, y + k, z, 0);
    return res;
  })));
  // 3. the trade
  console.log(JSON.stringify(await pg.evaluate(() => {
    const A = window.__A, T = BF.trades, I = BF.I;
    A.trades = T.offers("forester", 1);
    const o = A.trades.find(o => o.sell.id === I.emerald && o.buy[0].id === I.oak_sapling);
    if (!o) return "no offer";
    const em0 = T.inv.count(A.inv, I.emerald), sap0 = T.inv.count(A.inv, I.oak_sapling);
    const reason = T.blockReason(A, o), ok = T.exchange(A, o);
    return { reason, ok, emeralds: [em0, T.inv.count(A.inv, I.emerald)], saplings: [sap0, T.inv.count(A.inv, I.oak_sapling)] };
  })));
};
