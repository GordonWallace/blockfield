// Tent checks: node test/run.js /tmp/tent test/tent-actions.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const r1 = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, res = {};
    const x = Math.floor(p.x) + 4, z = Math.floor(p.z), y = W.heightAt(x, z) + 1;
    // flatten a pad
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) { W.setBlock(x + dx, y - 1, z + dz, BF.B.grass || BF.B.dirt); for (let k = 0; k < 4; k++) W.setBlock(x + dx, y + k, z + dz, 0); }
    res.items = [BF.I.tent, BF.items[BF.I.tent].places];
    res.recipe = !!BF.recipes && JSON.stringify(BF.recipes).includes("Tent");
    res.placed = BF.tents.place(x, y, z, 2);
    res.cells = BF.tents.cells(x, y, z, 2).map(c => BF.blocks[W.getBlock(c.x, c.y, c.z)].name);
    res.peak = Math.max(...BF.tents.cells(x, y, z, 2).map(c => (c.up ? 1 : 0) + Math.max(0, ...BF.blocks[W.getBlock(c.x, c.y, c.z)].boxes.map(b => b[4])) / 16));   // blocks high (2 = ridge)
    res.roof = BF.tents.place(x, y, z, 1) ? "placed under a roof?" : "refused";                              // occupied anyway; below: a block on the upper layer refuses a tent
    BF.world.setBlock(x + 40, y + 1, z, 0);
    res.blocked = BF.tents.place(x, y, z, 2);                       // occupied: refused
    BF.world.setBlock(x + 1, y, z, 0); BF.emit("blockBroken", x + 1, y, z, BF.tentId(2, 0, 2));
    res.afterBreak = BF.tents.cells(x, y, z, 2).map(c => W.getBlock(c.x, c.y, c.z)).filter(Boolean).length;
    BF.tents.place(x, y, z, 2); BF.world.setBlock(x, y + 1, z, BF.B.stone); res.upBlocked = !BF.tents.canPlace(x, y, z, 2); BF.world.setBlock(x, y + 1, z, 0);
    BF.tents.place(x, y, z, 2); const upc = BF.tents.cells(x, y, z, 2).find(c => c.up && c.l === 2 && c.r === 1); BF.world.setBlock(upc.x, upc.y, upc.z, 0); BF.emit('blockBroken', upc.x, upc.y, upc.z, upc.id); res.afterBreakUp = BF.tents.cells(x, y, z, 2).map(c => W.getBlock(c.x, c.y, c.z)).filter(Boolean).length;
    res.placed4 = [0, 1, 3].map(f => { const ok = BF.tents.place(x, y, z, f); const n = BF.tents.cells(x, y, z, f).filter(c => W.getBlock(c.x, c.y, c.z) === c.id).length; BF.tents.remove(x, y, z, BF.tentId(f, 0, 1)); return [ok, n]; });
    BF.tents.place(x, y, z, 2);
    BF.player.position.set(x - 5, y + 1, z - 6);
    window.__tent = { x, y, z };
    return res;
  });
  console.log(JSON.stringify(r1));
  await pg.evaluate(() => { BF.player.yaw = Math.atan2(-4 + 5, 6) ; });
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: out + "-view.png" });
  const r2 = await pg.evaluate(async () => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child);
    const T = BF.trades, I = BF.I, A = vs[0], res = {};
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    BF.world.setBlock(tx, ty, tz, BF.B.survey_table); BF.emit("blockPlaced", tx, ty, tz, BF.B.survey_table);
    BF.mobs.setProfession(A, "explorer"); A.xp = 0; A.inv = T.stockFor("explorer", A); A.trades = [];
    res.hasTent = T.inv.count(A.inv, I.tent);
    BF.jobs.claim(A);
    T.inv.remove(A.inv, I.tent, 1); BF.sky.setTime(0.2); for (let i = 0; i < 600; i++) BF.mobs.update(0.1); res.spare = T.inv.count(A.inv, I.tent);   // lost its tent: collects a spare at home by day
    // far from its bed, evening: pitches
    const home = A.bed; A.homeBed0 = home;
    const far = { x: A.village.x + 140, z: A.village.z };
    BF.world.isLoaded(far.x, far.z);
    A.position.set(A.position.x, A.position.y, A.position.z);
    res.homeDist = BF.explorer.pitch ? 0 : -1;
    BF.sky.setTime(0.1);
    // pretend it is 120 blocks from home by moving the home bed marker
    A.bed = { x: A.position.x - 150, y: A.position.y, z: A.position.z, f: 0 };
    BF.sky.setTime(0.47);
    for (let i = 0; i < 300; i++) { BF.sky.setTime(0.47); BF.mobs.update(0.1); if (A.ex && A.ex.camp) break; }
    res.camp = A.ex && A.ex.camp; res.bed = A.bed && A.bed.tent; res.tentLeft = T.inv.count(A.inv, I.tent);
    window.__A = A; window.__home = A.homeBed;
    // a zombie nearby
    const z = BF.mobs.spawn ? null : null;
    return res;
  });
  console.log(JSON.stringify(r2));
  const r3 = await pg.evaluate(async () => {
    const A = window.__A, res = {};
    BF.sky.setTime(0.56);
    for (let i = 0; i < 400; i++) { BF.sky.setTime(0.56); BF.mobs.update(0.1); if (A.sleeping) break; }
    res.sleeping = A.sleeping; res.hidden = BF.tents.hidden(A); res.pos = [A.position.x.toFixed(1), A.position.y.toFixed(1), A.position.z.toFixed(1)];
    BF.sky.setTime(0.005);
    for (let i = 0; i < 100; i++) { BF.sky.setTime(0.005); BF.mobs.update(0.1); if (!A.sleeping) break; }
    for (let i = 0; i < 30; i++) { BF.sky.setTime(0.01); BF.mobs.update(0.1); }
    res.awake = !A.sleeping; res.camp = A.ex.camp; res.tentBack = BF.trades.inv.count(A.inv, BF.I.tent); res.bedRestored = A.bed === window.__home || (A.bed && !A.bed.tent);
    return res;
  });
  console.log(JSON.stringify(r3));
};
