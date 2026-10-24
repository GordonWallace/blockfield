// @ci integration suite=village,world hosts=worker,server
// Explorers only sell complete maps: node test/run.js /tmp/expc test/explorer-complete.js [--host page|worker|server]
// A map with a blank corner (97% drawn, the old "filled" threshold) is not offered, even one an old save marked as given up on; the explorer
// walks to a blank pixel; a map it cannot finish is put aside until the next day, never sold; once every pixel is drawn it is on sale.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  const lib = require('./lib');
  await lib.toVillage(pg);
  const r = await lib.sim(pg, () => {   // (where the simulation is: spec r15-43)
    const fails = [], X = BF.explorer, T = BF.trades, M = BF.maps, I = BF.I;
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child);
    if (!vs.length) return { fails: ["no villager"] };
    const A = vs[0];
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    BF.world.setBlock(tx, ty, tz, BF.B.survey_table); BF.emit('blockPlaced', tx, ty, tz, BF.B.survey_table);
    BF.mobs.setProfession(A, "explorer"); A.xp = 0; A.level = 1; A.trades = []; A.inv = T.stockFor("explorer", A);
    A.res = BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: BF.B.survey_table, prof: "explorer" } });
    BF.player.position.set(A.position.x + 3, A.position.y + 1, A.position.z);
    // a size 1 map of its own zone, drawn except for a triangle at the top (like the map in the bug report)
    const zx = M.zoneOf(A.position.x), zz = M.zoneOf(A.position.z), name = M.nameOf(1, zx, zz), id = BF.resolveItem(name);
    const d = M.getData(1, zx, zz);
    d.px.fill(1);
    for (let j = 0; j < 20; j++) for (let i = 50 + j; i < 90 - j; i++) d.px[j * M.PX + i] = 0;
    d.ver++;
    T.inv.add(A.inv, id, 1);
    const cov = X.coverage(d);
    const offers = () => A.trades.filter(o => o.dyn).length;
    // an old save that marked the map as given up on (it used to be sold as it was)
    X.unpack(A, { fin: [name] });
    X.syncOffers(A);
    if (!(cov > 0.97 && cov < 1)) fails.push("setup coverage " + cov);
    if (offers()) fails.push("a map " + (cov * 100).toFixed(1) + "% drawn is on sale");
    const c = X.carried(A)[0];
    if (c.done || c.shelved) fails.push("unfinished map counted as " + (c.done ? "done" : "shelved"));
    // the next target is a blank pixel of the map
    const p = X.pickTarget(A, c);
    const s = M.scale(1), ox = M.originX(1, zx), oz = M.originX(1, zz);
    if (p.best && d.px[p.best.pi]) fails.push("target pixel is already drawn");
    if (p.best && Math.hypot(ox + (p.best.pi % M.PX + 0.5) * s - p.best.wx, oz + ((p.best.pi / M.PX | 0) + 0.5) * s - p.best.wz) > 22) fails.push("stands too far from its pixel to draw it");
    // put aside: not for sale, nothing bought on top of it, back to it the next day
    X.shelve(A, c, "unreachable");
    X.syncOffers(A);
    const c2 = X.carried(A)[0];
    if (!c2.shelved) fails.push("not shelved");
    if (offers()) fails.push("a shelved map is on sale");
    const shelvedStatus = X.statusText(A);
    if (!/finishing it tomorrow/.test(shelvedStatus)) fails.push("status: " + shelvedStatus);
    const day0 = BF.sky.day;
    BF.sky.day = day0 + 1;
    const c3 = X.carried(A)[0];
    if (c3.shelved) fails.push("still shelved the next day");
    // every pixel drawn: one offer at the full price
    d.px.fill(1); d.ver++;
    X.syncOffers(A);
    const o = A.trades.find(o => o.dyn);
    if (!o) fails.push("complete map not on sale");
    else if (o.buy[0].n !== X.SELL_PRICE[0] || o.sell.id !== id) fails.push("offer " + o.buy[0].n + " for " + BF.items[o.sell.id].name);
    BF.sky.day = day0;
    const logs = BF.vlog.entries(A.village.key).filter(e => e[1] === "map").map(e => e[2]);
    if (!logs.some(t => /put aside .* blank pixel/.test(t))) fails.push("no village log line for the shelved map");
    if (!BF.logmatch || !(BF.logmatch.actorsOf(["0", "map", logs[0] || ""]) || []).some(([t, a]) => t === "Explorer" && a === "map")) fails.push("log line not read as an explorer mapping");
    return { cov: +cov.toFixed(4), target: p.best && [p.best.wx, p.best.wz], shelvedStatus, offer: o && o.buy[0].n, logs, fails };
  });
  console.log(JSON.stringify(r));
  for (const f of r.fails) console.log("FAIL " + f);
  if (!r.fails.length) console.log("explorer-complete ok");
};
