// @ci baseline suite=village hosts=worker,server
// A merchant camping on the road keeps its tent through dawn: node test/run.js /tmp/mtent test/merchant-tent.js [--host page|worker|server]
// Camps of explorers that unloaded are taken down when the night ends (js/explorer.js tick); a merchant camps with the same tent and was
// left out of that rule's "still here" list, so its tent was taken down under it at dawn, it packed up nothing, and without a tent it never
// set out on a long trip again (caravan-soak far pair, one trip in 12 days).
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); });
  const lib = require('./lib');
  await lib.toVillage(pg);
  const pick = () => BF.mobs.list.find(m => m.type === "villager" && m.village && m.inv && !m.child && !m.dead && m.slot && m.village.wg && m.village.wg.maxX != null);
  for (let t = 0; t < 180; t++) {
    if (await lib.sim(pg, src => {
      const A = new Function("return " + src)()();
      if (!A) return false;
      const ox = Math.floor(A.village.wg.maxX) + 16, oz = Math.floor(A.village.z);
      return [[-8, -8], [8, 8], [-8, 8], [8, -8]].every(([dx, dz]) => BF.world.isLoaded(ox + dx, oz + dz));
    }, String(pick))) break;
    await pg.waitForTimeout(500);
  }
  const r = await lib.sim(pg, src => {
    const T = BF.trades, I = BF.I, W = BF.world, out = [], ok = (n, c, x) => out.push((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : ""));
    const run = () => { BF.req.apply(); BF.req.deliver(); };   // block requests (spec r15-19) done now
    const A = new Function("return " + src)()();
    if (!A) return ["FAIL no villager"];
    BF.mobs.setProfession(A, "merchant");
    const tents = () => T.inv.count(A.inv, I.tent);
    if (tents() < 1) T.inv.add(A.inv, I.tent, 1);
    // out of the village on open grass at dusk
    const V = A.village, ox = Math.floor(V.wg.maxX) + 16, oz = Math.floor(V.z), oy = W.heightAt(ox, oz) + 1;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) { W.setBlock(ox + dx, oy - 1, oz + dz, BF.B.grass); for (let k = 0; k < 20; k++) W.setBlock(ox + dx, oy + k, oz + dz, 0); }
    BF.sky.setTime(0.47); A.position.set(ox + 0.5, oy, oz + 0.5);
    const n0 = tents();
    BF.explorer.pitch(A); run();
    ok("pitches its tent", !!A.ex.camp && tents() === n0 - 1, { tents: tents(), had: n0 });
    const c = A.ex.camp ? Object.assign({}, A.ex.camp) : null;
    if (!c) return out;
    // dawn: the leftover-camp rule runs before the merchant wakes
    BF.sky.setTime(0.99);
    for (let i = 0; i < 3; i++) { BF.explorer.tick(3); run(); }
    ok("its tent still stands at dawn", W.getBlock(c.x, c.y, c.z) === BF.tentId(c.f, 0, 1));
    BF.explorer.strike(A); run();
    ok("packs it up and has it back", tents() === n0 && !A.ex.camp, { tents: tents(), had: n0 });
    ok("no camp left on the books", !BF.explorer.camps.has(V.key + "#" + A.slot.idx));
    return out;
  }, String(pick));
  for (const l of r) console.log(l);
  if (r.some(l => l.startsWith("FAIL"))) console.log("FAILED merchant-tent");
};
