// @ci baseline
// Ore depth and miner levels: NODE_PATH=$(npm root -g) node test/run.js /tmp/md test/miner-depth.js
// - gen 3 places gold, diamonds, redstone, lapis by depth below the surface (worldgen ORE3): none of them shallower than their band
// - the miner keeps raw iron / raw gold (vanilla drops since #44) and sells them; its staircase depth follows its level and pickaxe;
//   a levelled-up miner leaves a shallow shaft for a deeper one; ore in the walls of a cell it opens is dug with the cell
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const res = { fails: [] }, B = BF.B, I = BF.I, W = BF.world, T = BF.trades;
    const ok = (c, msg) => { if (!c) res.fails.push(msg); };
    // 1. ore bands in the generator, over 24 chunks around the origin
    const band = { gold_ore: 32, deepslate_gold_ore: 32, diamond_ore: 48, deepslate_diamond_ore: 48, redstone_ore: 48, deepslate_redstone_ore: 48, lapis_ore: 24, deepslate_lapis_ore: 24 };
    const ids = new Map(Object.keys(band).map(n => [B[n], n])), seen = {};
    let shallow = 0;
    for (let k = 0; k < 24; k++) {
      const cx = (k % 6) - 3, cz = Math.floor(k / 6) - 2, hc = BF.worldgen.heightAt(cx * 16 + 8, cz * 16 + 8);
      const sy0 = (hc - 150) >> 4, sy1 = (hc >> 4) + 1, vox = BF.worldgen.generateRange(cx, cz, sy0, sy1), Y0 = Math.max(sy0, BF.SY0) * 16;
      for (let i = 0; i < vox.length; i++) {
        const n = ids.get(vox[i]);
        if (!n) continue;
        const d = hc - (Y0 + (i >> 8));
        seen[n] = Math.min(seen[n] == null ? 1e9 : seen[n], d);
        if (d < band[n] - 10) shallow++;   // veins wander up to ~7 blocks from their start, and the chunk's own surface varies
      }
    }
    res.shallowestByOre = seen;
    ok(shallow === 0, "ores above their depth band: " + shallow);
    ok(seen.gold_ore != null && seen.diamond_ore != null, "no gold or diamonds generated within 150 of the surface");
    // 2. trades and keeps
    const offers = [1, 2, 3, 4, 5].map(l => BF.trades.offers("miner", l).map(o => o.sell.n + " " + BF.items[o.sell.id].name).join(", "));
    res.offers = offers;
    ok(/raw_iron/.test(offers[1]) && /raw_gold/.test(offers[1]), "apprentice offers lack raw iron / raw gold");
    ok(!offers.join().match(/(^|[^_])(iron|gold)_ore/), "miner still sells ore blocks");
    // 3. a live miner beside the player
    const v = BF.mobs.list.find(m => m.type === "villager" && m.village && m.inv && !m.child);
    if (!v) { res.fails.push("no villager"); return res; }
    const M = v; M.profession = "miner"; M.level = 1; M.xp = 0;
    M.inv = new Array(T.SLOTS).fill(null);
    T.inv.add(M.inv, I.iron_pickaxe, 1);
    const D = BF.miner.digDepth;
    res.depth = { L1: D(M) };
    M.level = 2; res.depth.L2 = D(M); M.level = 3; res.depth.L3 = D(M); M.level = 5; res.depth.L5 = D(M);
    M.inv = new Array(T.SLOTS).fill(null); T.inv.add(M.inv, I.stone_pickaxe, 1); res.depth.L5stone = D(M);
    ok(res.depth.L1 === 20 && res.depth.L2 === 40 && res.depth.L3 === 60 && res.depth.L5stone === 20, "dig depths " + JSON.stringify(res.depth));
    // raw iron / raw gold are kept when dug
    M.inv = new Array(T.SLOTS).fill(null); T.inv.add(M.inv, I.iron_pickaxe, 1);
    const px = Math.floor(BF.player.position ? BF.player.position.x : M.position.x), pz = Math.floor(M.position.z) + 3, py = W.heightAt(px, pz) + 6;
    W.setBlock(px, py, pz, B.iron_ore); BF.miner._test.dig(M, px, py, pz);
    W.setBlock(px, py, pz, B.gold_ore); BF.miner._test.dig(M, px, py, pz);
    W.setBlock(px, py, pz, B.deepslate_gold_ore); BF.miner._test.dig(M, px, py, pz);
    res.kept = M.inv.filter(Boolean).map(s => BF.itemName(s.id) + "x" + s.count);
    ok(T.inv.count(M.inv, I.raw_iron) === 1 && T.inv.count(M.inv, I.raw_gold) === 2, "raw iron / raw gold not kept: " + res.kept.join(" "));
    // wall ores: a corridor cell running +x with ore on its +z side, its -z side and its ceiling (a water-side one is left alone)
    const sh = { x: px, y: py, z: pz, dx: 1, dz: 0, S: 0, n: 0, k: 0, done: false, D: 20 };
    const c = BF.miner.cellOf(sh, 0);
    for (let y = c.y - 1; y <= c.y + 3; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -1; dx <= 1; dx++) W.setBlock(c.x + dx, y, c.z + dz, B.stone);
    W.setBlock(c.x, c.y, c.z + 1, B.coal_ore); W.setBlock(c.x, c.y + 1, c.z - 1, B.diamond_ore); W.setBlock(c.x, c.y + 2, c.z, B.iron_ore);
    W.setBlock(c.x, c.y, c.z - 1, B.gold_ore); W.setBlock(c.x, c.y, c.z - 2, B.water);
    const wo = BF.miner._test.wallOres(M, sh, c).map(p => BF.itemName(W.getBlock(p[0], p[1], p[2])));
    res.wallOres = wo;
    ok(wo.length === 3 && !wo.some(n => /Gold/.test(n)), "wall ores " + wo.join(", "));
    // 4. a novice's finished shallow shaft is dropped once it levels up (and has an iron pickaxe)
    M.level = 3;
    const Q = BF.miner._test.state(M);
    Q.shaft = { x: px, y: py, z: pz, dx: 1, dz: 0, S: 20, n: 25, k: 0, done: false, D: 20 };
    M.position.set(px + 200.5, M.position.y, pz + 0.5);   // above ground, away from the shaft
    BF.miner.LOG.length = 0;
    BF.miner._test.think(M, Q);
    res.afterLevelUp = { oldDone: Q.shaft.D === 20 ? Q.shaft.done : "new shaft", D: Q.shaft.D, log: BF.miner.LOG.map(e => e.kind) };
    ok(BF.miner.LOG.some(e => e.kind === "deeper"), "levelled-up miner kept its shallow shaft");
    // a finished shaft at the right depth: its staircase is reused for a corridor to the left, then to the right, then a new staircase
    const turns = [];
    for (let i = 0; i < 3; i++) {
      Q.shaft = Object.assign({}, i ? Q.shaft : { x: px, y: py, z: pz, dx: 1, dz: 0, S: 60, n: 150, k: 0, D: 60 }, { done: true, n: 150 });
      BF.miner._test.think(M, Q);
      turns.push(Q.shaft.turn || 0);
    }
    res.reuseTurns = turns;
    ok(turns.join() === "1,2,0", "staircase reuse turns " + turns.join());
    const t1 = Object.assign({}, Q.shaft, { x: 0, y: 100, z: 0, dx: 1, dz: 0, S: 10, turn: 1 }), c1 = BF.miner.cellOf(t1, 10);
    ok(c1.x === 10 && c1.z === 1 && c1.y === 90, "turned corridor's first cell " + JSON.stringify(c1));
    // 5. starting kit and surplus: a founding miner gets a stone pickaxe; with no pickaxe it never makes one; unsold finds go to a chest
    res.kit = T.stockFor("miner", M).filter(Boolean).map(s => BF.items[s.id].name);
    ok(res.kit.includes("stone_pickaxe") && !res.kit.includes("wooden_pickaxe"), "miner kit " + res.kit.join());
    const keepInv = M.inv;
    M.inv = new Array(T.SLOTS).fill(null); T.inv.add(M.inv, I.cobblestone, 64); T.inv.add(M.inv, I.stick, 8); T.inv.add(M.inv, I.planks, 8);
    const Q2 = BF.miner._test.state(M), svShaft = Q2.shaft; Q2.shaft = null;
    BF.miner._test.think(M, Q2);
    ok(!M.inv.some(s => s && typeof BF.items[s.id].tool === "object"), "miner made itself a tool");
    Q2.shaft = svShaft;
    M.inv = new Array(T.SLOTS).fill(null); T.inv.add(M.inv, I.stone_pickaxe, 1);
    for (let i = 0; i < 13; i++) T.inv.add(M.inv, I.cobblestone, 64);
    const before = BF.miner.wantsStore(M);
    T.inv.add(M.inv, I.raw_copper, 20);
    res.wantsStore = [before, BF.miner.wantsStore(M)];
    ok(!before && res.wantsStore[1], "wantsStore " + res.wantsStore);
    M.inv = keepInv;
    // 6. save / load keeps the shaft's depth
    const p = BF.miner.pack(M), M2 = { position: M.position };
    BF.miner.unpack(M2, JSON.parse(JSON.stringify(p)));
    ok(M2.mi.shaft && M2.mi.shaft.D === Q.shaft.D, "shaft depth not saved");
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
  for (const f of r.fails) console.log("FAIL: " + f);
  console.log(r.fails.length ? "FAILED" : "miner-depth: all checks passed");
};
