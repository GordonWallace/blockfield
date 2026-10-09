// Farmer log checks (1.1: only foresters fell trees): node test/run.js /tmp/fl test/farmer-logs.js
// A farmer short of logs for a bed's edge buys them through an offer: a forester's log offer (level 2) or, before that, its spare logs (8 an
// emerald, js/market.js). Foresters come first; another villager's spare logs do when no forester has any (1.3, one market). A farmer without
// emeralds buys nothing, and a gather task never takes a log from a tree.
module.exports = async (pg) => {
  const r = await pg.evaluate(() => {
    const out = [], ok = (name, c, info) => out.push((c ? "PASS " : "FAIL ") + name + (c || info === undefined ? "" : " " + JSON.stringify(info)));
    const I = BF.I, T = BF.trades, inv = T.inv, VL = BF.villageLife, X = VL._test;
    const at = (x) => new THREE.Vector3(x, 64, 0);
    const vill = (prof, level, x) => ({ type: "villager", profession: prof, inv: inv.create(), trades: [1, 2, 3, 4, 5].slice(0, level).flatMap(l => T.offers(prof, l)), position: at(x), level, xp: 0, slot: { idx: 100 + x }, ai: {} });
    const farmer = vill("farmer", 1, 0);
    inv.add(farmer.inv, I.emerald, 5);
    const mason = vill("mason", 5, 1);           // holds logs but is not a forester: they are its spare goods
    inv.add(mason.inv, I.oak_log, 40);
    const fo1 = vill("forester", 1, 6);          // level 1: no log offer yet, its logs are spare goods at 8 an emerald
    inv.add(fo1.inv, I.birch_log, 20);
    const sync = (...vs) => { for (const v of vs) BF.market.sync(v); };
    sync(mason, fo1);
    farmer.village = { members: [farmer, mason, fo1] };
    let t = X.findLogSeller(farmer, 16, null);
    ok("buys from the forester, not the mason", t && t.seller === fo1 && t.item === I.birch_log, t && { seller: t.seller.profession });
    ok("level-1 forester: its spare logs, 8 an emerald", t && t.offer && t.offer.spare && t.per === 8 && t.times === 2, t && { per: t.per, times: t.times });
    const em0 = inv.count(fo1.inv, I.emerald);
    const n = t ? X.doLogDeal(farmer, t) : 0;
    ok("16 birch logs for 2 emeralds", n === 2 && inv.count(farmer.inv, I.birch_log) === 16 && inv.count(farmer.inv, I.emerald) === 3 && inv.count(fo1.inv, I.emerald) === em0 + 2 && inv.count(fo1.inv, I.birch_log) === 4,
      { n, logs: inv.count(farmer.inv, I.birch_log), em: inv.count(farmer.inv, I.emerald) });
    // level 2: its own offer, the bed's species preferred
    const fo2 = vill("forester", 2, 12);
    inv.add(fo2.inv, I.oak_log, 16); inv.add(fo2.inv, I.spruce_log, 16); sync(fo2);
    const f2 = vill("farmer", 1, 0);
    inv.add(f2.inv, I.emerald, 3);
    f2.village = { members: [f2, fo2] };
    t = X.findLogSeller(f2, 8, I.spruce_log);
    ok("level-2 forester: its log offer, the bed's species", t && t.offer && t.item === I.spruce_log && t.times === 1, t && { item: BF.items[t.item].name, offer: !!t.offer });
    const xp0 = fo2.xp;
    ok("offer trade gives the forester xp", t && X.doLogDeal(f2, t) === 1 && inv.count(f2.inv, I.spruce_log) === 8 && fo2.xp > xp0);
    // no emeralds, no logs
    const f3 = vill("farmer", 1, 0);
    f3.village = { members: [f3, fo2] };
    ok("no emeralds: no deal", X.findLogSeller(f3, 8, null) === null);
    // no forester with logs: another villager's spare logs
    const f4 = vill("farmer", 1, 0);
    inv.add(f4.inv, I.emerald, 3);
    f4.village = { members: [f4, mason, vill("forester", 1, 3)] };
    t = X.findLogSeller(f4, 8, null);
    ok("no forester with logs: the mason's spare logs", t && t.seller === mason && t.offer && t.offer.spare, t && { seller: t.seller.profession });
    // nobody with logs to spare: no deal
    const f6 = vill("farmer", 1, 0);
    inv.add(f6.inv, I.emerald, 3);
    f6.village = { members: [f6, vill("forester", 1, 3), vill("mason", 1, 4)] };
    ok("nobody with spare logs: no deal", X.findLogSeller(f6, 8, null) === null);
    // a gather task never takes a log: put a log where the task points
    const W = BF.world, px = Math.floor(BF.player.position.x) + 40, pz = Math.floor(BF.player.position.z) + 40, y = W.heightAt(px, pz);
    W.setBlock(px, y + 1, pz, I.oak_log); W.setBlock(px, y + 2, pz, I.oak_log);
    const D = { base: { x0: px - 200, z0: pz - 200, x1: px - 190, z1: pz - 190 }, boxes: [], farms: [], projects: [], beds: [], ready: true };
    const f5 = vill("farmer", 1, 0);
    let took = null;
    try { took = X.gatherBlock(f5, D, { kind: "gather", what: "log", x: px, y: y + 1, z: pz }); } catch (e) { took = "error " + e.message; }
    ok("gather never takes a log", took === false && W.getBlock(px, y + 1, pz) === I.oak_log, { took });
    ok("BF.forester.fell not called by farmers", !/forester\.fell/.test(String(VL._test.perform)) && !/forester\.fell/.test(String(X.gatherBlock)));
    return out;
  });
  console.log(r.join("\n"));
};
