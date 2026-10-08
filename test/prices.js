// Prices follow demand (js/prices.js): node test/run.js /tmp/prices test/prices.js
// An unfilled buy offer doubles in 30 game days and no further; a sell offer stuck at its stock cap halves in 30 days and no lower; trades ease
// prices back 3 steps each; a villager never buys above its own sell price or the cheapest seller's base price; days missed while away (or
// fast-forwarded) catch up; save and load keep the prices and old saves start at base; the Economy view records the price actually paid.
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
    const P = BF.prices, T = BF.trades, I = BF.I, em = I.emerald;
    ok("prices loaded", !!P);
    const mk = (prof, level = 1) => { const v = { type: "villager", profession: prof, level, xp: 0, inv: T.inv.create() }; v.trades = []; for (let l = 1; l <= level; l++) v.trades.push(...T.offers(prof, l)); return v; };
    const find = (v, buyName, sellName) => v.trades.find(o => o.buy.length === 1 && o.buy[0].id === I[buyName] && o.sell.id === I[sellName]);
    const unit = o => P.unit(o), base = o => P.baseUnit(o);
    const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;
    // ---- an unfilled buy offer: the cleric's rotten flesh (nobody sells it)
    const c = mk("cleric"); T.inv.add(c.inv, em, 12);
    const flesh = find(c, "rotten_flesh", "emerald");
    P.tick(c, 100);
    const units = [];
    for (let d = 101; d <= 140; d++) { P.tick(c, d); units.push(unit(flesh)); }
    ok(`buy offer after 15 days ~x1.41: (${units[14].toFixed(4)} vs base ${base(flesh).toFixed(4)})`, near(units[14], base(flesh) * Math.SQRT2, 0.05));
    ok(`buy offer doubles in 30 days: ${JSON.stringify([flesh.buy[0].n, flesh.sell.n])}`, P.step(flesh) === 30 && near(units[29], base(flesh) * 2, 0.03));
    ok("and not beyond", units.slice(29).every(u => u === units[29]) && flesh.buy[0].n === 11 && flesh.sell.n === 1);
    ok("prices only rise one step a day", units.every((u, i) => i === 0 || u >= units[i - 1]));
    // a villager without the emeralds to pay has no demand
    const c2 = mk("cleric"); const f2 = find(c2, "rotten_flesh", "emerald");
    P.tick(c2, 100); P.tick(c2, 110);
    ok("no emeralds: no rise", P.step(f2) === 0 && f2.buy[0].n === 22);
    // ---- a sell offer stuck at its stock cap: the fletcher's arrows
    const f = mk("fletcher"); T.inv.add(f.inv, em, 12);
    const arrows = find(f, "emerald", "arrow"), cap = T.profile("fletcher").caps.get(I.arrow);
    T.inv.add(f.inv, I.arrow, cap);
    P.tick(f, 0);
    for (let d = 1; d <= 29; d++) P.tick(f, d);
    ok(`29 days: not yet half (${arrows.sell.n} arrows an emerald)`, P.step(arrows) === -29 && arrows.sell.n < 44);
    P.tick(f, 30);
    ok(`sell offer halves in 30 days: 1 emerald > ${arrows.sell.n} arrows`, P.step(arrows) === -30 && arrows.sell.n === 44 && arrows.buy[0].n === 1);
    for (let d = 31; d <= 45; d++) P.tick(f, d);
    ok("and not below", P.step(arrows) === -30 && arrows.sell.n === 44);
    // below the cap there's no glut
    const f3 = mk("fletcher"); const a3 = find(f3, "emerald", "arrow"); T.inv.add(f3.inv, I.arrow, cap - 1);
    P.tick(f3, 0); P.tick(f3, 5);
    ok("under the stock cap: no drop", P.step(a3) === 0);
    // ---- trades ease the price back 3 steps each, at the next tick
    P.filled(f, arrows, 2);
    ok("no change in the middle of trading", arrows.sell.n === 44);
    T.inv.remove(f.inv, I.arrow, 999);   // sold out: no glut now
    P.tick(f, 46);
    ok(`2 trades: 6 steps back (${P.step(arrows)}, ${arrows.sell.n} arrows)`, P.step(arrows) === -24 && arrows.sell.n < 44);
    P.filled(f, arrows, 20); P.tick(f, 47);
    ok("never past base", P.step(arrows) === 0 && arrows.sell.n === 22 && arrows.buy[0].n === 1);
    P.filled(c, flesh, 1); P.tick(c, 141);
    ok("a filled buy offer comes down 3 steps", P.step(flesh) === 27 && unit(flesh) < base(flesh) * 2);
    // ---- floors
    // the shepherd buys and sells wool: with a glut and emeralds it would buy dearer and sell cheaper, but never buys above its own sell price
    const s = mk("shepherd"); T.inv.add(s.inv, em, 12); T.inv.add(s.inv, I.white_wool, T.profile("shepherd").caps.get(I.white_wool));
    const wb = find(s, "white_wool", "emerald"), ws = find(s, "emerald", "white_wool");
    let crossed = false;
    P.tick(s, 0);
    for (let d = 1; d <= 45; d++) { P.tick(s, d); if (unit(wb) > unit(ws) + 1e-9) crossed = true; }
    ok(`own buy price never above own sell price (buys ${wb.buy[0].n} for ${wb.sell.n}, sells ${ws.sell.n} for ${ws.buy[0].n})`, !crossed);
    // the builder never pays more for glass than the cheapest seller asks (the librarian, 11 an emerald)
    const b = mk("builder", 2); T.inv.add(b.inv, em, 60);
    const glass = find(b, "glass", "emerald");
    P.tick(b, 0); for (let d = 1; d <= 40; d++) P.tick(b, d);
    ok(`builder pays below the cheapest seller: ${glass.buy[0].n} glass an emerald (cheapest ${(1 / P.cheapest(I.glass)).toFixed(1)})`, unit(glass) < P.cheapest(I.glass) && P.step(glass) > 0);
    // fixed prices: barter and two-item offers, the explorer's maps, food offers of the hungry
    const w = mk("weaponsmith", 5); const sword = w.trades.find(o => o.buy.length === 2);
    ok("two-item payments keep their price", sword && P.kind(sword) === null);
    ok("food offers keep their price", T.feedOffers().every(o => P.kind(o) === null));
    // ---- fast-forward and days away: the missed days catch up
    const c3 = mk("cleric"); T.inv.add(c3.inv, em, 12); const f4 = find(c3, "rotten_flesh", "emerald");
    P.tick(c3, 200); P.tick(c3, 212);
    ok("12 days at once: 12 steps", P.step(f4) === 12);
    // ---- save and load
    const pr = P.pack(c), pd = c.priceDay;
    const c4 = mk("cleric"); P.unpack(c4, JSON.parse(JSON.stringify(pr)), pd);
    const f5 = find(c4, "rotten_flesh", "emerald");
    ok(`save and load keep the price (${JSON.stringify(pr)})`, P.step(f5) === P.step(flesh) && f5.buy[0].n === flesh.buy[0].n && f5.sell.n === flesh.sell.n && c4.priceDay === pd);
    const c5 = mk("cleric"); P.unpack(c5, undefined, undefined);
    ok("old saves: base prices", c5.trades.every(o => !P.step(o)) && find(c5, "rotten_flesh", "emerald").buy[0].n === 22);
    // through a real villager's save record
    const L = BF.vlog, p = BF.player.position, rec = L.villageAt(p.x, p.z);
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child && m.slot && Array.isArray(m.inv) && Array.isArray(m.trades) && m.trades.some(o => P.kind(o)));
    ok("village villagers with priced offers", vs.length >= 2);
    const v = vs[0], o = v.trades.find(x => P.kind(x));
    o.base = [o.buy[0].n, o.sell.n]; o.step = P.kind(o) === "buy" ? 20 : -20; P.reprice(v, o);
    const amounts = [o.buy[0].n, o.sell.n];
    const packed = JSON.parse(JSON.stringify(T.pack(v)));
    const v2 = { type: "villager", profession: v.profession, level: 1, xp: 0 }; T.unpack(v2, packed);
    const o2 = v2.trades.find(x => P.kind(x) && x.base && x.buy[0].id === o.buy[0].id && x.sell.id === o.sell.id);
    ok(`villager save keeps it: ${JSON.stringify(amounts)}`, o2 && o2.step === o.step && o2.buy[0].n === amounts[0] && o2.sell.n === amounts[1]);
    // ---- the Economy view records the price paid, and the trade eases it at the next tick
    const E = BF.econ, buyer = vs[1];
    const sum = () => { let n = 0, e = 0; for (const x of E.days(rec.key).values()) for (const k in x.f) { n += x.f[k][0]; e += x.f[k][1]; } return { n, e }; };
    const s0 = sum();
    L.trade(P.kind(o) === "sell" ? buyer : v, P.kind(o) === "sell" ? v : buyer, o, 2);
    const s1 = sum();
    const goods = P.kind(o) === "sell" ? amounts[1] : amounts[0], ems = P.kind(o) === "sell" ? amounts[0] : amounts[1];
    ok(`economy tallies the moved price: ${s1.n - s0.n} items, ${s1.e - s0.e} emeralds`, s1.n - s0.n === goods * 2 && Math.abs(s1.e - s0.e - ems * 2) < 1e-6);
    v.priceDay = 300; P.tick(v, 301);
    ok("the trade eased it 6 steps", Math.abs(P.step(o)) === 14);
    return out;
  });
  for (const l of res) console.log(l);
};
