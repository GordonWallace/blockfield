// @ci integration suite=village
// Caravans reach 600 blocks and plan from last-known prices (village loading plan): the trip length rule, candidates that are not loaded, the no-road
// memory, the 3-day give-up, and the saved prices. Usage: node test/run.js /tmp/mr test/merchant-range.js
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c, x) => out.push((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : ""));
    const M = BF.merchant, rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    ok("range is 600 blocks and the give-up is 3 days", M.RANGE === 600 && M.TRIP_MAX_DAYS === 3, { r: M.RANGE, d: M.TRIP_MAX_DAYS });
    const m = rec.members.find(x => x.type === "villager" && x.profession === "merchant" && !x.dead) || rec.members.find(x => x.type === "villager" && !x.dead && !x.child);
    const d200 = M.tripDays(m, 200), d600 = M.tripDays(m, 600), d800 = M.tripDays(m, 800);
    ok("a 600-block trip fits in 2 days, 800 does not", d600 <= M.MAX_PLAN_DAYS && d800 > M.MAX_PLAN_DAYS && d200 < d600, { d200, d600, d800 });
    // last-known prices read back like the live book
    const sum = M.summarize(rec);
    ok("a village summary holds its offers", Object.keys(sum.sells).length > 0 && Object.keys(sum.buys).length > 0, { sells: Object.keys(sum.sells).length, buys: Object.keys(sum.buys).length });
    const b = M.bookOf(sum), live = M.book(rec, null);
    ok("the summary reads as a book with the same items", b.sells.size === live.sells.size && b.buys.size === live.buys.size, { s: [b.sells.size, live.sells.size], b: [b.buys.size, live.buys.size] });
    const g1 = M.goods(rec, { sum }, m, 50), g2 = M.goods(rec, rec, m, 50);
    ok("goods from last-known prices agree with live prices", g1.list.length === g2.list.length, { from: g1.list.length, live: g2.list.length });
    // candidates: a village known only by its summary, planned from a stand-in home 250 blocks away
    const others = BF.worldgen.villagesNear(rec.x, rec.z, 1500).filter(v => v && Math.round(v.x) + "," + Math.round(v.z) !== rec.key);
    ok("there are other villages in the world", others.length > 0, { n: others.length });
    const far = others.find(v => !BF.villageSim.isActive(Math.round(v.x) + "," + Math.round(v.z)));
    if (far) {
      const key = Math.round(far.x) + "," + Math.round(far.z);
      const stub = { village: { key: "stub", x: far.x + 250, z: far.z, members: [] } };
      ok("without saved prices an unloaded village is not a candidate", !M.candidates(stub).some(x => x.rec.key === key));
      M.market.set(key, sum);
      const c = M.candidates(stub).find(x => x.rec.key === key);
      ok("an unloaded village with saved prices is a candidate", !!c && !!c.rec.sum && c.rec.wg === far || (!!c && !!c.rec.sum), { key, d: c && Math.round(c.d) });
      M.noRoad.set(M.roadKey("stub", key), BF.sky.day + BF.sky.time + 7);
      ok("a pair marked no road is not a candidate", !M.candidates(stub).some(x => x.rec.key === key));
      M.noRoad.clear(); M.market.delete(key);
      const stub2 = { village: { key: "stub2", x: far.x + 700, z: far.z, members: [] } };
      M.market.set(key, sum);
      ok("one 700 blocks away is out of range", !M.candidates(stub2).some(x => x.rec.key === key));
      M.market.delete(key);
    }
    // saved with the world
    M.market.set("1,1", sum); M.noRoad.set("1,1|2,2", BF.sky.day + 3);
    const o = {}; M.exportAll(o);
    M.market.clear(); M.noRoad.clear();
    M.importAll(o);
    ok("last-known prices and no-road pairs are saved", M.market.has("1,1") && M.noRoad.has("1,1|2,2"), { m: [...M.market.keys()], n: [...M.noRoad.keys()] });
    M.market.clear(); M.noRoad.clear();
    return out;
  });
  for (const l of res) console.log(l);
};
