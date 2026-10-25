// @ci baseline suite=village
// Villager trade logic (bug-051, bug-053, bug-066): node test/run.js /tmp/trade-sides test/trade-sides.js
// One side per item: a villager whose offers buy and sell the same item shows only one side, selling while it can spare a lot and looking for
// it otherwise (the other side hidden, blocked for villagers and the player, its price kept and still); a farmer off to buy a tool says so, not
// "Buying food"; a merchant never carries goods home that home already sells as cheaply.
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c, x) => out.push((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : ""));
    const M = BF.market, T = BF.trades, I = BF.I, em = I.emerald, inv = T.inv, P = BF.prices;
    const mk = (prof, level = 1) => { const v = { type: "villager", profession: prof, level, xp: 0, inv: inv.create(), position: BF.player.position.clone() }; v.trades = []; for (let l = 1; l <= level; l++) v.trades.push(...T.offers(prof, l)); return v; };
    const on = v => v.trades.filter(o => !o.off);
    const buys = (v, id) => on(v).some(o => o.sell.id === em && o.buy.length === 1 && o.buy[0].id === id);
    const sells = (v, id) => on(v).some(o => o.buy.length === 1 && o.buy[0].id === em && o.sell.id === id);
    // ---- the armorer of image-1: lanterns and iron ingots, bought and sold
    const ar = mk("armorer", 2); inv.add(ar.inv, em, 20); inv.add(ar.inv, I.bread, 10);
    M.sync(ar);
    ok("no lanterns: looks for them, does not sell them", buys(ar, I.lantern) && !sells(ar, I.lantern));
    ok("no iron: looks for it", buys(ar, I.iron_ingot) && !sells(ar, I.iron_ingot));
    const lanternSell = ar.trades.find(o => o.sell.id === I.lantern);
    ok("the hidden sell offer is blocked: " + T.blockReason(ar, lanternSell), lanternSell.off === "sell" && T.blockReason(ar, lanternSell) === M.OFF_NOTE.sell);
    inv.add(ar.inv, I.lantern, 3); inv.add(ar.inv, I.iron_ingot, 6);
    M.sync(ar);
    ok("3 lanterns: sells them, does not buy", sells(ar, I.lantern) && !buys(ar, I.lantern));
    ok("6 iron ingots: sells, does not buy", sells(ar, I.iron_ingot) && !buys(ar, I.iron_ingot));
    const lanternBuy = ar.trades.find(o => o.buy[0].id === I.lantern);
    ok("the buy offer is set aside, not dropped", lanternBuy && lanternBuy.off === "buy" && T.blockReason(ar, lanternBuy) === M.OFF_NOTE.buy);
    ok("coal it never sells: still bought", buys(ar, I.coal));
    // never a buy and a sell offer for the same item at once, across every profession and level, empty or stocked
    let both = [];
    for (const prof in T.TRADES) for (const fill of [0, 1]) {
      const v = mk(prof, 5); inv.add(v.inv, em, 30); inv.add(v.inv, I.bread, 10);
      if (fill) for (const o of v.trades) if (o.sell.id !== em && inv.canFit(v.inv, [{ id: o.sell.id, n: o.sell.n * 2 }], [])) inv.add(v.inv, o.sell.id, o.sell.n * 2);
      M.sync(v);
      for (const o of on(v)) if (o.sell.id === em && o.buy.length === 1 && sells(v, o.buy[0].id)) both.push(prof + ":" + BF.items[o.buy[0].id].name);
    }
    ok("no villager buys and sells the same item", both.length === 0, both);
    // a spare lot of what its job buys: sells it, stops buying
    const cl = mk("cleric"); inv.add(cl.inv, em, 12); inv.add(cl.inv, I.bread, 10); inv.add(cl.inv, I.bone, 30);
    M.sync(cl);
    ok("cleric with 30 spare bones: sells them, does not buy", sells(cl, I.bone) && !buys(cl, I.bone));
    inv.remove(cl.inv, I.bone, 30); M.sync(cl);
    ok("bones gone: buys them again", buys(cl, I.bone) && !sells(cl, I.bone));
    // the farmer of image-3: full of crops, it doesn't buy crops
    const fa = mk("farmer"); inv.add(fa.inv, em, 35); for (const n of ["carrot", "potato", "wheat_item"]) inv.add(fa.inv, I[n], 64); inv.add(fa.inv, I.bread, 47);
    M.sync(fa);
    ok("farmer with 64 carrots, potatoes and wheat buys none of them", !buys(fa, I.carrot) && !buys(fa, I.potato) && !buys(fa, I.wheat_item));
    // prices: a set-aside offer neither drifts nor bounds, and keeps its price through a save
    const sh = mk("shepherd"); inv.add(sh.inv, em, 12); inv.add(sh.inv, I.bread, 10);
    const wb = sh.trades.find(o => o.buy[0].id === I.white_wool), ws = sh.trades.find(o => o.sell.id === I.white_wool);
    wb.step = 5; P.reprice(sh, wb);
    inv.add(sh.inv, I.white_wool, 40); M.sync(sh);
    ok("shepherd with wool: buy offer set aside", wb.off === "buy" && !ws.off);
    ok("a set-aside offer has no price kind (no drift, no floor)", P.kind(wb) === null && P.kind(ws) === "sell");
    const pr = P.pack(sh);
    ok("its price is saved", pr && Object.values(pr).includes(5), pr);
    // the trade screen hides it (rendered rows match the offers that are on)
    // ---- bug-053: a farmer off to buy a bucket says so
    const VL = BF.villageLife, farmer = mk("farmer");
    farmer.fshop = { stage: "walk", deal: { kind: "tool", item: I.bucket, seller: farmer }, avoid: {} };
    ok("tool trip status: " + VL.statusText(farmer), VL.statusText(farmer) === "Buying bucket");
    farmer.fshop.deal = { kind: "wheat", item: I.wheat_item }; ok("wheat trip status", VL.statusText(farmer) === "Buying wheat");
    farmer.fshop.deal = { item: I.bread, offer: {} }; ok("food trip status", VL.statusText(farmer) === "Buying food");
    // ---- bug-066: no sticks carried home where a forester sells them as cheaply
    const MC = BF.merchant;
    const mv = (prof, offers) => { const v = { type: "villager", profession: prof, level: 1, xp: 0, inv: inv.create(), position: BF.player.position.clone(), trades: offers }; inv.add(v.inv, em, 30); inv.add(v.inv, I.bread, 10); return v; };
    const sellAt = n => ({ buy: [{ id: em, n: 1 }], sell: { id: I.stick, n }, level: 1, xp: 1 });
    const there = mv("forester", [sellAt(48)]); inv.add(there.inv, I.stick, 64); const s48 = there.trades[0]; s48.step = -1;   // a little marked down there
    const buyer = mv("toolsmith", [{ buy: [{ id: I.stick, n: 32 }], sell: { id: em, n: 1 }, level: 1, xp: 1 }]); buyer.trades[0].step = 5; P.reprice(buyer, buyer.trades[0]);
    const homeForester = mv("forester", [sellAt(49)]);
    const A = { key: "a", members: [there] }, H1 = { key: "h1", members: [buyer] }, H2 = { key: "h2", members: [buyer, homeForester] };
    const merch = mv("merchant", []);
    ok("no seller at home: sticks worth carrying", MC.goods(A, H1, merch, 10).list.some(g => g.id === I.stick));
    ok("home forester out of sticks: still worth carrying", MC.goods(A, H2, merch, 10).list.some(g => g.id === I.stick));
    inv.add(homeForester.inv, I.stick, 64);
    ok("home forester sells 49 an emerald: not carried", !MC.goods(A, H2, merch, 10).list.some(g => g.id === I.stick));
    // last-known prices (an unloaded home) say the same
    const sum = MC.summarize(H2);
    ok("from last-known prices too", !MC.goods(A, { key: "h2", sum }, merch, 10).list.some(g => g.id === I.stick), sum.sells[I.stick]);
    return out;
  });
  // the trade screen: open the armorer with lanterns and count the rows
  const ui = await pg.evaluate(async () => {
    const T = BF.trades, I = BF.I, p = BF.player.position;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.child && Array.isArray(m.trades) && m.position.distanceTo(p) < 64);
    if (!v || !BF.inventory || !BF.inventory.openTrade) return "SKIP no villager or trade screen";
    v.profession = "armorer"; v.level = 2; v.trades = []; for (let l = 1; l <= 2; l++) v.trades.push(...T.offers("armorer", l));
    T.inv.add(v.inv, I.lantern, 3);
    BF.inventory.openTrade(v);
    await new Promise(r => setTimeout(r, 300));
    const rows = document.querySelectorAll(".bf-offer").length, shown = v.trades.filter(o => !o.off).length;
    BF.inventory.close && BF.inventory.close();
    return (rows === shown && v.trades.some(o => o.off) ? "PASS " : "FAIL ") + `trade screen shows only offers that are on (${rows} rows, ${shown} on, ${v.trades.length} in all)`;
  });
  for (const l of res) console.log(l);
  console.log(ui);
  if (res.some(l => l.startsWith("FAIL")) || ui.startsWith("FAIL")) console.log("FAILED trade-sides");
};
