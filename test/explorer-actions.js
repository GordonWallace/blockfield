// Explorer checks: node test/run.js /tmp/exp test/explorer-actions.js
module.exports = async (pg, out) => {
  const r = await pg.evaluate(() => {
    const res = {};
    // roster: explorers only where there are cartographers, ~70% per cartographer
    let carto = 0, expl = 0, badNoCarto = 0, villages = 0, withC = 0, withE = 0;
    for (let k = 0; k < 600; k++) {
      const houses = []; for (let i = 0; i < 6 + (k % 12); i++) houses.push({ type: "house", x: i * 9, z: 0, w: 5, d: 5, beds: [{}] });
      const ro = BF.mobs.roster({ key: k * 17 + "," + k * 5, houses, nb: 3 });
      const c = ro.filter(s => s.prof === "cartographer").length, e = ro.filter(s => s.prof === "explorer").length;
      villages++; carto += c; expl += e; if (c) withC++; if (e) withE++;
      if (!c && e) badNoCarto++;
      if (ro.filter(s => s.prof !== "furniture_maker").length > 24) badNoCarto += 1000;   // the furniture maker may go one past the cap (js/furniture.js)
      if (e > c) badNoCarto += 1000;
    }
    res.roster = { villages, carto, expl, ratio: +(expl / Math.max(1, carto)).toFixed(3), withC, withE, bad: badNoCarto };
    // starting stock: no maps
    const a = BF.trades.stockFor("explorer", {});
    res.stock = a.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count);
    res.block = BF.B.survey_table, res.jobsite = BF.jobs.JOBSITE.explorer;
    return res;
  });
  console.log(JSON.stringify(r));
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const setup = await pg.evaluate(() => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child);
    if (vs.length < 2) return "villagers: " + vs.length;
    const T = BF.trades, I = BF.I;
    const A = vs[0], C = vs[1];
    // a survey table beside it: the jobsite that makes it an explorer (jobs.js drops the profession of villagers without a jobsite)
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    BF.world.setBlock(tx, ty, tz, BF.B.survey_table); BF.emit('blockPlaced', tx, ty, tz, BF.B.survey_table);
    BF.mobs.setProfession(A, "explorer"); A.xp = 0; A.level = 1; A.trades = []; A.inv = T.stockFor("explorer", A);
    A.res = BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: BF.B.survey_table, prof: "explorer" } });   // this table (another free jobsite nearby could win a plain claim)
    T.inv.add(A.inv, I.emerald, 10);
    // the cartographer stands beside the explorer and gets its own table there (without one, jobs.js makes it unemployed again;
    // a seller that keeps walking away makes the explorer give up on it for a while, which would depend on the village layout)
    C.position.set(A.position.x, A.position.y, A.position.z + 3);
    const cx = Math.floor(C.position.x) + 2, cy = Math.floor(C.position.y), cz = Math.floor(C.position.z);
    BF.world.setBlock(cx, cy, cz, BF.B.cartography_table); BF.emit('blockPlaced', cx, cy, cz, BF.B.cartography_table);
    BF.mobs.setProfession(C, "cartographer"); BF.jobs.claim(C, { site: { x: cx, y: cy, z: cz, id: BF.B.cartography_table, prof: "cartographer" } });
    C.inv = T.inv.create(); T.inv.add(C.inv, I.blank_map_2, 1); T.inv.add(C.inv, I.emerald, 5);
    C.trades = [1, 2, 3, 4, 5].flatMap(l => T.offers("cartographer", l)); C.level = 5;
    BF.player.position.set(A.position.x + 5, A.position.y + 1, A.position.z);
    window.__A = A; window.__C = C;
    return { claim: A.res, prof: A.profession, A: [A.position.x | 0, A.position.z | 0], C: [C.position.x | 0, C.position.z | 0], same: A.village === C.village };
  });
  console.log(JSON.stringify(setup));
  for (let k = 0; k < 40; k++) {
    const line = JSON.stringify(await pg.evaluate(() => {
      const A = window.__A;
      for (let i = 0; i < 300; i++) { BF.sky.setTime(0.1); BF.mobs.update(0.1); BF.player.position.set(A.position.x + 3, A.position.y + 1, A.position.z); }
      const maps = BF.explorer.carried(A);
      return { pos: [A.position.x | 0, A.position.z | 0], stage: A.ex && A.ex.stage, inv: A.inv.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count), cov: maps.map(c => +BF.explorer.coverage(c.d).toFixed(2)), status: BF.explorer.statusText(A), offers: A.trades.filter(o => o.dyn).length, log: BF.explorer.LOG.slice(-2) };
    }));
    if (k % 5 === 0 || /filled/.test(line)) console.log(k, line);
    if (/filled_map/.test(line)) break;
  }
  console.log(JSON.stringify(await pg.evaluate(() => {
    const A = window.__A, T = BF.trades;
    const act = BF.explorer.carried(A).find(c => !c.done);
    if (act) act.d.px.fill(1), act.d.ver++;      // finish the map by hand when the walk did not get there in time
    for (let i = 0; i < 50; i++) { BF.sky.setTime(0.1); BF.mobs.update(0.1); }
    T.init(A);
    const o = A.trades.find(o => o.dyn);
    return { offers: A.trades.map(o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name), reason: o && T.blockReason(A, o), status: BF.explorer.statusText(A), log: BF.explorer.LOG.slice(-1) };
  })));
};
