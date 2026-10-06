// Cartographer checks: node test/run.js /tmp/cart test/cartography-actions.js
module.exports = async (pg, out) => {
  const r = await pg.evaluate(async () => {
    const res = {}, I = BF.I, T = BF.trades, C = BF.cartography, inv = T.inv;
    // starting stock: no compasses/maps, ingredients for a compass always, for a map about half the time
    let mapOk = 0, compassOk = 0, bad = 0, N = 400;
    for (let k = 0; k < N; k++) {
      const a = T.stockFor("cartographer", {});
      const c = id => inv.count(a, id);
      if (c(I.compass) || [1, 2, 3, 4, 5].some(n => c(I["blank_map_" + n]))) bad++;
      if (c(I.iron_ingot) >= 4 && c(I.gold_ingot) >= 1) compassOk++;
      if (c(I.iron_ingot) >= 4 && c(I.gold_ingot) >= 1 && c(I.paper) >= 8) mapOk++;
    }
    res.start = { N, bad, compassOk, mapFraction: mapOk / N };
    // trade table
    res.offers = [1, 2, 3, 4, 5].flatMap(l => T.offers("cartographer", l)).map(o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name);
    // crafting at the table: compass, then map, then upgrades once paper is plentiful
    const m = { inv: inv.create(), profession: "cartographer", ai: {} };
    inv.add(m.inv, I.iron_ingot, 8); inv.add(m.inv, I.gold_ingot, 2); inv.add(m.inv, I.paper, 60);
    const seq = [];
    for (let k = 0; k < 12; k++) { const p = C.plan(m); if (!p) break; C.craft(m, p); seq.push(p.kind + (p.to ? ":" + BF.items[p.to].name : "")); }
    res.craftSeq = seq;
    res.after = m.inv.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count);
    // shopping: a village with an armorer and a librarian
    const mk = prof => ({ type: "villager", profession: prof, inv: T.stockFor(prof, {}), trades: [1, 2, 3, 4, 5].flatMap(l => T.offers(prof, l)), position: new THREE.Vector3(0, 0, 0), level: 5, xp: 0 });
    const arm = mk("armorer"), lib = mk("librarian");
    const buyer = { inv: inv.create(), profession: "cartographer", village: { members: [arm, lib] }, position: new THREE.Vector3(0, 0, 0) };
    inv.add(buyer.inv, I.emerald, 20);
    const bought = [];
    for (let k = 0; k < 8; k++) {
      const short = C.shortfall(buyer);
      if (!Object.keys(short).length) break;
      const d = C.findSeller(buyer, short, {});
      if (!d) { bought.push("no seller for " + Object.keys(short).map(i => BF.items[i].name)); break; }
      bought.push(d.seller.profession + ": " + d.offer.sell.n + " " + BF.items[d.item].name + " x" + C.doDeal(buyer, d));
    }
    res.bought = bought;
    res.buyerHas = buyer.inv.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count);
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
};
