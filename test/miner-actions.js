// Miner checks: NODE_PATH=$(npm root -g) node test/run.js /tmp/mi test/miner-actions.js
// roster odds, starting pack and trades; in a live village: the builder would buy the miner's cobblestone (builder.js findSeller), the miner
// sells it to a builder short of cobblestone (miner.js findBuyer / doSell), and a miner digs a mineshaft cell by cell with its pickaxe wearing.
module.exports = async (pg, out) => {
  const r = await pg.evaluate(() => {
    const res = {};
    let withM = 0, n = 0, bad = 0;
    for (let k = 0; k < 1000; k++) {
      const houses = []; for (let i = 0; i < 6 + (k % 12); i++) houses.push({ type: "house", x: i * 9, z: 0, w: 5, d: 5, beds: [{}] });
      const pop = k % 2 ? 0 : 3 + (k % 60);
      const ro = BF.mobs.roster({ key: k * 17 + "," + k * 5, houses, nb: 8, pop });
      const c = ro.filter(s => s.prof === "miner").length; n++; if (c) withM++;
      if (c > 1 || (pop && ro.length > pop)) bad++;
      if (new Set(ro.map(s => s.idx)).size !== ro.length) bad += 1000;
    }
    res.roster = { villages: n, withMiner: withM, pct: Math.round(100 * withM / n), bad };
    res.stock = BF.trades.stockFor("miner", {}).filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count);
    res.offers = [1, 2, 3, 4, 5].map(l => BF.trades.offers("miner", l).map(o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name).join(", "));
    res.jobsite = BF.jobs.JOBSITE.miner + " id " + BF.B.mining_bench;
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const s = await pg.evaluate(() => {
    const res = {}, T = BF.trades, I = BF.I, B = BF.B, W = BF.world;
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child && !m.dead);
    let M = vs.find(m => m.profession === "miner"), Bd = vs.find(m => m.profession === "builder" && m.village === (M && M.village));
    if (!Bd) Bd = vs.find(m => m.profession === "builder");
    if (!M || M.village !== Bd.village) {   // make one: a villager of the builder's village takes up a mining bench
      M = vs.find(m => m.village === Bd.village && m !== Bd && m.profession !== "builder");
      const tx = Math.floor(M.position.x) + 2, ty = Math.floor(M.position.y), tz = Math.floor(M.position.z);
      W.setBlock(tx, ty, tz, B.mining_bench); BF.emit("blockPlaced", tx, ty, tz, B.mining_bench);
      BF.mobs.setProfession(M, "miner"); M.xp = 0; M.level = 1; M.trades = []; M.inv = T.stockFor("miner", M);
      BF.jobs.claim(M, { site: { x: tx, y: ty, z: tz, id: B.mining_bench, prof: "miner" } });
      res.made = true;
    }
    BF.inventory.ensureTrades(M); BF.inventory.ensureTrades(Bd);
    res.minerPack = M.inv.filter(Boolean).map(s => BF.itemName(s.id) + "x" + s.count);
    // the builder is out of cobblestone and needs 40; the miner has 96
    T.inv.remove(Bd.inv, I.cobblestone, 9999); T.inv.add(M.inv, I.cobblestone, 96);
    if (T.inv.count(Bd.inv, I.emerald) < 5) T.inv.add(Bd.inv, I.emerald, 5);
    const bs = Bd.bs || {}; bs.avoid = bs.avoid || {};
    const deal = BF.builder.findSeller(Bd, bs, { [I.cobblestone]: 40 });
    res.builderWouldBuyFrom = deal ? deal.seller.profession + " x" + deal.times + " (" + deal.offer.buy.map(b => b.n + " " + BF.itemName(b.id)).join("+") + " > " + deal.offer.sell.n + " " + BF.itemName(deal.offer.sell.id) + ")" : null;
    // the miner takes it to the builder
    res.builderWants = BF.miner.builderWants(Bd);
    const sell = BF.miner.findBuyer(M, {});
    if (sell && sell.other !== Bd) { res.buyer = "the village's other builder"; Bd = sell.other; }
    const before = { bc: T.inv.count(Bd.inv, I.cobblestone), be: T.inv.count(Bd.inv, I.emerald), mc: T.inv.count(M.inv, I.cobblestone), me: T.inv.count(M.inv, I.emerald) };
    res.sale = sell ? BF.miner.doSell(M, sell) + " x " + sell.offer.sell.n : "no buyer";
    const after = { bc: T.inv.count(Bd.inv, I.cobblestone), be: T.inv.count(Bd.inv, I.emerald), mc: T.inv.count(M.inv, I.cobblestone), me: T.inv.count(M.inv, I.emerald) };
    res.builderCobble = before.bc + " -> " + after.bc; res.builderEmeralds = before.be + " -> " + after.be;
    res.minerCobble = before.mc + " -> " + after.mc; res.minerEmeralds = before.me + " -> " + after.me;
    window.__M = M;
    return res;
  });
  console.log(JSON.stringify(s, null, 1));
  // the miner digs: let it work a while in its shaft or quarry
  const d = await pg.evaluate(async () => {
    const M = window.__M, T = BF.trades, I = BF.I;
    T.inv.remove(M.inv, I.cobblestone, 9999);
    BF.sky.setTime(0.06);
    const pick0 = BF.miner.pickOf(M), w0 = pick0 ? pick0.wear || 0 : null;
    BF.miner.LOG.length = 0;
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    for (let i = 0; i < 6000; i++) { step(0.05); if (i % 50 === 0) BF.world.update(BF.player.position.x, BF.player.position.z, 4); }
    const pick = BF.miner.pickOf(M), kinds = {};
    for (const e of BF.miner.LOG) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    const sh = M.mi && M.mi.shaft;
    return { log: kinds, cobble: T.inv.count(M.inv, I.cobblestone), pickWear: w0 + " -> " + (pick ? pick.wear || 0 : "broken"), shaft: sh ? { cells: sh.n, stairs: sh.S, entrance: [sh.x, sh.y, sh.z] } : null, status: BF.miner.statusText(M), pos: [M.position.x | 0, M.position.y | 0, M.position.z | 0] };
  });
  console.log(JSON.stringify(d, null, 1));
  if (d.shaft) await pg.evaluate(e => { BF.player.setGameMode("creative"); BF.player.teleport(e[0] + 3.5, e[1] + 4, e[2] + 3.5); BF.player.setLook(Math.PI * 0.75, -0.6); }, d.shaft.entrance);
  await pg.waitForTimeout(4000);
  await pg.screenshot({ path: out + '-shaft.png' });
};
