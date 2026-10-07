// Live cartographer: node test/run.js /tmp/cartlive test/cartography-live.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require("./lib").toVillage(pg);   // mile-high worlds rarely start inside a village
  const info = await pg.evaluate(async () => {
    const vs = BF.mobs.list.filter(m => m.type === "villager");
    return { n: vs.length, sample: vs.slice(0, 3).map(m => [m.profession, !!m.village, m.position.x | 0, m.position.z | 0, !!m.inv]) };
  });
  console.log(JSON.stringify(info));
  const res = await pg.evaluate(async () => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child);
    if (!vs.length) return "no villagers";
    const m = vs[0], I = BF.I, T = BF.trades;
    BF.player.position.set(m.position.x + 6, m.position.y + 1, m.position.z);
    // put a cartography table next to the villager and make it a cartographer holding a compass kit
    const tx = Math.floor(m.position.x) + 2, ty = Math.floor(m.position.y), tz = Math.floor(m.position.z);
    BF.world.setBlock(tx, ty, tz, BF.B.cartography_table); BF.emit('blockPlaced', tx, ty, tz, BF.B.cartography_table);
    m.profession = "cartographer"; m.xp = 1; m.jobsite = null; m.variant = "cartographer";
    m.trades = T.offers("cartographer", 1); m.level = 1;
    m.inv = T.inv.create();
    T.inv.add(m.inv, I.iron_ingot, 4); T.inv.add(m.inv, I.gold_ingot, 1); T.inv.add(m.inv, I.paper, 9); T.inv.add(m.inv, I.emerald, 5);
    const c = BF.jobs.claim(m);
    BF.sky.setTime(0.1);
    window.__cm = m;
    return { claimed: c, site: m.jobsite };
  });
  console.log(JSON.stringify(res));
  for (let k = 0; k < 8; k++) {
    console.log(JSON.stringify(await pg.evaluate(() => {
      const m = window.__cm;
      for (let i = 0; i < 400; i++) { BF.sky.setTime(0.1); BF.mobs.update(0.1); }
      return { pos: [m.position.x | 0, m.position.z | 0], prof: m.profession, site: m.jobsite && [m.jobsite.x, m.jobsite.z], mode: m.job && m.job.mode, inv: m.inv.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count), log: BF.cartography.LOG.slice(-3) };
    })));
  }
};
