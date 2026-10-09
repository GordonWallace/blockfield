// Builders craft torches from coal they buy and sticks from their planks, so a house no longer stalls for want of torches nobody sells.
// Shepherds get no wool or hay bales from the restock (wool only from shearing, hay bales from farmers).
// Also checks the pick weights: no structure limit, bed structures levelled up in a full village, materials counted by stock.
// Usage: node test/run.js /tmp/bt test/builder-torches.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const B = BF.builder, I = BF.I, T = BF.trades.inv, name = id => BF.itemName(+id);
    const req = Object.assign({}, BF.blueprints.get("small_house", 0, 0, 0.5, null, "oak").req);
    ok("a small house needs torches", req[I.torch] >= 1, req[I.torch]);
    const kit = withCoal => {
      const inv = T.create();
      for (const k in req) if (+k !== I.torch) T.add(inv, +k, req[k]);
      T.add(inv, I.oak_planks != null ? I.oak_planks : I.planks, 4);   // boards for the sticks
      if (withCoal) T.add(inv, I.coal, 1);
      return inv;
    };
    const a = B.analyze(kit(true), req, "oak");
    ok("with 1 coal and spare planks the house is buildable", a.ok, Object.keys(a.shortfall).map(k => a.shortfall[k] + " " + name(k)));
    ok("the plan crafts torches and sticks", a.crafts.some(c => c.id === I.torch) && a.crafts.some(c => c.id === I.stick), a.crafts.map(c => c.times + "x " + name(c.id)));
    const m = { inv: kit(true) };
    B.applyCrafts(m, a.crafts);
    ok("crafting leaves the torches in hand", T.count(m.inv, I.torch) >= req[I.torch] && T.count(m.inv, I.coal) === 0, { torch: T.count(m.inv, I.torch), coal: T.count(m.inv, I.coal), stick: T.count(m.inv, I.stick) });
    const b = B.analyze(kit(false), req, "oak");
    ok("without coal the shortfall is coal, not torches", !b.ok && b.shortfall[I.coal] > 0 && !b.shortfall[I.torch], Object.keys(b.shortfall).map(k => b.shortfall[k] + " " + name(k)));
    // ---- type weights (no structure limit; full villages level the bed structures up; materials count only what is in stock)
    const BEDS = ["small_house", "medium_house", "cottage"];
    const fakeVillage = (n, homeless, extraBuilt) => {
      const members = [];
      for (let i = 0; i < n; i++) members.push({ type: "villager", profession: "farmer", inv: T.create(), trades: [], bed: i < n - homeless ? { x: i } : null });
      const built = [];
      for (let i = 0; i < extraBuilt; i++) built.push({ id: i + 1, type: "lamp_posts", state: "done" });
      return { key: "wtest" + n + "_" + homeless + "_" + extraBuilt, style: 0, wg: { buildings: [], jobsites: [], ground: 1 }, roster: [], members, built };
    };
    const weights = (Rv, spareBeds) => {
      const keep = BF.breeding;
      BF.breeding = { bedCount: () => Rv.members.length + spareBeds, villagerCount: () => Rv.members.length };
      Rv.roster = [{}];
      const builder = { village: Rv, inv: T.create(), bs: { fail: {}, avoid: {} } };
      try { const w = {}; for (const [t, x] of B.weighTypes(builder, builder.bs)) w[t] = x; return w; } finally { BF.breeding = keep; }
    };
    const w1 = weights(fakeVillage(6, 0, 0), 2);
    const w2 = weights(fakeVillage(6, 0, 0), 0);
    const top = Math.max(...Object.keys(w2).filter(t => !BEDS.includes(t)).map(t => w2[t]));
    ok("with a spare bed the houses keep their base weights", w1.small_house < w1.well && w1.cottage < w1.well, { small: w1.small_house, well: w1.well });
    ok("with every bed claimed each bed structure is as likely as the likeliest other type", BEDS.every(t => Math.abs(w2[t] - top) < 1e-9), { top, small: w2.small_house, medium: w2.medium_house, cottage: w2.cottage });
    const w3 = weights(fakeVillage(6, 2, 0), 0);
    ok("homeless villagers raise the bed structures further", BEDS.every(t => w3[t] > w2[t]), { w2: w2.small_house, w3: w3.small_house });
    const w4 = weights(fakeVillage(6, 0, 30), 2);
    ok("there is no limit on how many structures a village gets", Object.keys(w4).length > 0 && B.MAX_BUILT === undefined, Object.keys(w4).length);
    // materials: only what a villager has in stock counts
    const mats = (withStock) => {
      const Rv = fakeVillage(6, 0, 0);
      const sw = BF.blueprints.styleWood(0), wreq = Object.assign({}, BF.blueprints.get("well", 0, 0, 0.5, null, sw).req);
      wreq[BF.worldgen.palette(0).found] = 20;
      const seller = Rv.members[0], other = Rv.members[1];
      seller.profession = "toolsmith"; other.profession = "mason";
      seller.trades = [{ buy: [{ id: I.emerald, n: 1 }], sell: { id: I.coal, n: 2 } }];   // a coal offer, with or without coal behind it
      for (const k in wreq) if (+k !== I.torch) { T.add(seller.inv, +k, Math.min(64, wreq[k] * 3 + 30)); seller.trades.push({ buy: [{ id: I.emerald, n: 1 }], sell: { id: +k, n: 4 } }); }   // spare goods: everything but the torches
      T.add(seller.inv, I.stick, 8); seller.trades.push({ buy: [{ id: I.emerald, n: 1 }], sell: { id: I.stick, n: 4 } });
      if (withStock) T.add(other.inv, I.coal, 10), other.trades = [{ buy: [{ id: I.emerald, n: 1 }], sell: { id: I.coal, n: 2 } }];
      return weights(Rv, 2);
    };
    const mOff = mats(false), mOn = mats(true);
    ok("an offer nobody can fill (no coal in stock) leaves a torch structure at the low multiplier; coal in stock lifts it", mOn.well > mOff.well * 3, { off: mOff.well, on: mOn.well });
    // shepherd restock
    const gy = BF.worldgen.heightAt(0, 0) + 1;
    const s = BF.mobs.spawn("villager", 0.5, gy, 0.5, "shepherd");
    s.profession = "shepherd"; BF.trades.init(s);
    T.remove(s.inv, I.white_wool, 9999); T.remove(s.inv, I.hay_bale, 9999);
    s.restockDay = 10; BF.trades.restock(s, 11); BF.trades.restock(s, 14);
    ok("the shepherd's restock makes no wool or hay bales", T.count(s.inv, I.white_wool) === 0 && T.count(s.inv, I.hay_bale) === 0, { wool: T.count(s.inv, I.white_wool), hay: T.count(s.inv, I.hay_bale) });
    return R;
  });
  for (const l of res.lines) console.log(l);
};
