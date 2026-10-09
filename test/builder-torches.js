// Builders craft torches from coal they buy and sticks from their planks, so a house no longer stalls for want of torches nobody sells.
// Shepherds get no wool or hay bales from the restock (wool only from shearing, hay bales from farmers).
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
