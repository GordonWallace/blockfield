// @ci integration suite=village hosts=worker,server
// Explorers and their tents when their village unloads, and cooking away from home (bug-067): node test/run.js /tmp/xcamp test/explorer-camp-unload.js [--host page|worker|server]
// - Camping out of its village at night when the village unloads: the tent stays. The village loads again before morning: the explorer is
//   back in its tent, asleep. It unloads again and the night ends first: the tent is taken down, and when the village next loads the explorer
//   has it back in its pack, with no camp.
// - Never camps inside its own village, however far it is from its bed (bug-052), and never on farmland.
// - Out mapping with raw eggs and fuel: it cooks at a furnace of the village it is in, not at home; never at one with another village's fuel in it.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); });
  const lib = require('./lib');
  await lib.toVillage(pg);
  // the test ground east of the village (16 past its box, and 12 round that) loaded before anything starts: under load it can lag the village
  for (let t = 0; t < 180; t++) {
    if (await lib.sim(pg, () => {
      const A = BF.mobs.list.find(m => m.type === "villager" && m.village && m.inv && !m.child && !m.dead && m.slot && m.profession !== "explorer" && m.village.wg && m.village.wg.maxX != null);
      if (!A) return false;
      const W = BF.world, ox = Math.floor(A.village.wg.maxX) + 16, oz = Math.floor(A.village.z);
      return [[-10, -10], [12, 12], [-10, 12], [12, -10]].every(([dx, dz]) => W.isLoaded(ox + dx, oz + dz));
    })) break;
    await pg.waitForTimeout(500);
  }
  let bad = 0;
  const fail = s => { console.log("FAIL " + s); bad++; };
  const r1 = await lib.sim(pg, () => {
    const T = BF.trades, I = BF.I, W = BF.world, res = {};
    const A = BF.mobs.list.find(m => m.type === "villager" && m.village && m.inv && !m.child && !m.dead && m.slot && m.profession !== "explorer" && m.village.wg && m.village.wg.maxX != null);
    if (!A) return { error: "no villager" };
    const V = A.village;
    // make it an explorer (its own survey table)
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    W.setBlock(tx, ty, tz, BF.B.survey_table); BF.emit("blockPlaced", tx, ty, tz, BF.B.survey_table);
    BF.mobs.setProfession(A, "explorer"); A.xp = 0; A.inv = T.stockFor("explorer", A); A.trades = [];
    BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: BF.B.survey_table, prof: "explorer" } });
    if (T.inv.count(A.inv, I.tent) < 1) T.inv.add(A.inv, I.tent, 1);
    // inside its own village, 150 blocks from its (pretend) bed at dusk: no camp
    const home = A.bed;
    { const cx = Math.floor(V.x) + 3, cz = Math.floor(V.z) + 3, cy = W.heightAt(cx, cz) + 1;
      BF.sky.setTime(0.2); BF.explorer.ai(A, 0.1, {}); BF.req.apply(); BF.req.deliver();
      A.bed = { x: cx - 150, y: cy, z: cz, f: 0 };
      for (let i = 0; i < 60; i++) { BF.sky.setTime(0.46); A.position.set(cx + 0.5, cy, cz + 0.5); BF.explorer.ai(A, 0.1, {}); BF.req.apply(); BF.req.deliver(); if (A.ex.camp) break; }
      res.inVillageCamp = !!A.ex.camp;
      if (A.ex.camp) { BF.explorer.strike(A); BF.req.apply(); BF.req.deliver(); }
      A.ex.eve = null; }
    // out of the village on farmland: no tent on the farm (a grass patch 8 blocks off is fine)
    const ox = Math.floor(V.wg.maxX) + 16, oz = Math.floor(V.z), oy = W.heightAt(ox, oz) + 1;
    res.outside = !BF.vlog.villageAt(ox, oz) && W.isLoaded(ox, oz) && W.isLoaded(ox + 12, oz + 12);
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
      W.setBlock(ox + dx, oy - 1, oz + dz, Math.max(Math.abs(dx), Math.abs(dz)) <= 6 ? BF.B.farmland : BF.B.grass);
      for (let k = 0; k < 30; k++) W.setBlock(ox + dx, oy + k, oz + dz, 0);
    }
    A.bed = { x: ox - 150, y: oy, z: oz, f: 0 };
    BF.sky.setTime(0.2); BF.explorer.ai(A, 0.1, {}); BF.req.apply(); BF.req.deliver();
    for (let i = 0; i < 400; i++) { BF.sky.setTime(0.47); A.position.set(ox + 0.5, oy, oz + 0.5); A.vel.set(0, 0, 0); A.ai.route = null; BF.explorer.ai(A, 0.1, {}); BF.req.apply(); BF.req.deliver(); A.ex.pitchAt = 0; if (A.ex.camp) break; }
    res.farmCamp = !!(A.ex.camp && A.ex.camp && Math.max(Math.abs(A.ex.camp.x - ox), Math.abs(A.ex.camp.z - oz)) <= 6);
    if (A.ex.camp) { BF.explorer.strike(A); BF.req.apply(); BF.req.deliver(); }
    A.ex.eve = null;
    // on grass, out of the village: camps
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) W.setBlock(ox + dx, oy - 1, oz + dz, BF.B.grass);
    BF.sky.setTime(0.2); BF.explorer.ai(A, 0.1, {}); BF.req.apply(); BF.req.deliver();
    for (let i = 0; i < 300; i++) { BF.sky.setTime(0.47); A.position.set(ox + 0.5, oy, oz + 0.5); A.vel.set(0, 0, 0); BF.explorer.ai(A, 0.1, {}); BF.req.apply(); BF.req.deliver(); A.ex.pitchAt = 0; if (A.ex.camp) break; }
    res.camp = A.ex.camp ? Object.assign({}, A.ex.camp) : null;
    globalThis.__X = { key: V.key + "#" + A.slot.idx, vkey: V.key, camp: res.camp, home };
    res.key = globalThis.__X.key;
    return res;
  });
  console.log(JSON.stringify(r1));
  if (r1.error) { fail(r1.error); return; }
  if (r1.inVillageCamp) fail("explorer camped inside its own village");
  if (!r1.outside) fail("test spot not outside the village");
  if (r1.farmCamp) fail("explorer pitched its tent on farmland");
  if (!r1.camp) { fail("explorer out of its village at dusk did not camp"); return; }
  // asleep in its tent, then the village unloads and comes back before morning
  const r2 = await lib.sim(pg, () => {
    const X = globalThis.__X, res = {}, W = BF.world, c = X.camp;
    const find = () => BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.removed && m.village && m.village.key + "#" + (m.slot && m.slot.idx) === X.key);
    let A = find();
    for (let i = 0; i < 600 && !(A && A.sleeping); i++) { BF.sky.setTime(0.6); BF.mobs.update(0.1); BF.req.apply(); BF.req.deliver(); A = find(); }
    res.sleptBefore = !!(A && A.sleeping && A.bed && A.bed.tent);
    BF.mobs.unloadVillage(X.vkey);
    res.gone = !find(); res.tentAfterUnload = W.getBlock(c.x, c.y, c.z) === BF.tentId(c.f, 0, 1); res.entry = !!BF.explorer.camps.get(X.key);
    BF.sky.setTime(0.7);
    for (let i = 0; i < 200 && !find(); i++) { BF.sky.setTime(0.7); BF.mobs.update(0.1); BF.req.apply(); BF.req.deliver(); }
    A = find();
    for (let i = 0; i < 50; i++) { BF.sky.setTime(0.7); BF.mobs.update(0.1); BF.req.apply(); BF.req.deliver(); }
    A = find();
    res.back = !!A;
    res.inTent = !!(A && A.bed && A.bed.tent && A.bed.x === c.x && A.bed.z === c.z);
    res.asleep = !!(A && A.sleeping);
    res.near = A ? +Math.hypot(A.position.x - c.x - 0.5, A.position.z - c.z - 0.5).toFixed(2) : null;
    return res;
  });
  console.log(JSON.stringify(r2));
  if (!r2.sleptBefore) fail("explorer did not sleep in its tent");
  if (!r2.tentAfterUnload) fail("tent gone as soon as the village unloaded");
  if (!r2.back || !r2.inTent || !r2.asleep) fail("explorer not back asleep in its tent when its village loaded again before morning");
  // unloads again and stays away until the night is over
  const r3 = await lib.sim(pg, () => {
    const X = globalThis.__X, res = {}, W = BF.world, c = X.camp;
    const find = () => BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.removed && m.village && m.village.key + "#" + (m.slot && m.slot.idx) === X.key);
    BF.mobs.unloadVillage(X.vkey);
    BF.sky.setTime(0.99);
    BF.explorer.tick(5); BF.req.apply(); BF.req.deliver();
    res.tentGone = W.getBlock(c.x, c.y, c.z) !== BF.tentId(c.f, 0, 1);
    res.glog = (BF.glog ? BF.glog.recent(200) : []).some(e => /tent at .* is taken down/.test(e.x || e.text || JSON.stringify(e)));
    BF.sky.setTime(0.1);
    let A = null;
    for (let i = 0; i < 300 && !(A = find()); i++) { BF.sky.setTime(0.1); BF.mobs.update(0.1); BF.req.apply(); BF.req.deliver(); }
    res.back = !!A;
    res.tents = A ? BF.trades.inv.count(A.inv, BF.I.tent) : null;
    res.camp = A ? A.ex && A.ex.camp : null;
    res.bed = A && A.bed ? !!A.bed.tent : null;
    res.entryLeft = !!BF.explorer.camps.get(X.key);
    return res;
  });
  console.log(JSON.stringify(r3));
  if (!r3.tentGone) fail("tent still standing after the night ended with its explorer away");
  if (!r3.glog) fail("no game log line for the tent taken down");
  if (!r3.back || r3.tents !== 1 || r3.camp || r3.bed) fail("explorer did not come back with its tent in its pack and no camp");
  if (r3.entryLeft) fail("camp record not cleared");
  // cooking out mapping: a village furnace where it is, not one at home
  const r4 = await lib.sim(pg, () => {
    const X = globalThis.__X, res = {}, W = BF.world, T = BF.trades, I = BF.I;
    const A = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.removed && m.village && m.village.key + "#" + (m.slot && m.slot.idx) === X.key);
    if (!A) return { error: "explorer gone" };
    const c = X.camp, fx = c.x + 4, fz = c.z, fy = W.heightAt(fx, fz) + 1;
    // a stand-in for another village around the spot (its box), with a furnace in it
    const other = { key: "test-other", x: fx, y: fy, z: fz, members: [], houses: [], killed: {}, angryT: 0, wg: { minX: fx - 10, maxX: fx + 10, minZ: fz - 10, maxZ: fz + 10, x: fx, z: fz } };
    BF.mobs.villages.set(other.key, other);
    try {
      W.setBlock(fx, fy, fz, BF.B.furnace); BF.emit("blockPlaced", fx, fy, fz, BF.B.furnace);
      A.position.set(fx - 2.5, fy, fz + 0.5);
      T.inv.add(A.inv, I.egg, 4); T.inv.add(A.inv, I.coal, 2);
      const aw = BF.explorer.away;
      const plan = () => { const d = BF.eggCook.nextTrip(A); return d ? { kind: d.kind, at: d.furnace ? [d.furnace.x, d.furnace.y, d.furnace.z] : null } : null; };
      BF.sky.setTime(0.2);
      try {
        BF.explorer.away = m => m === A || aw(m);
        res.away = plan();
        BF.inventory.furnaceRecord(fx, fy, fz).slots[1] = { id: I.coal, count: 3 };   // that village's own fuel in it
        res.awayFuelled = plan();
        BF.inventory.furnaceRecord(fx, fy, fz).slots[1] = null;
      } finally { BF.explorer.away = aw; }
      res.fx = [fx, fy, fz];
    } finally { BF.mobs.villages.delete(other.key); }
    return res;
  });
  console.log(JSON.stringify(r4));
  const at = (p, f) => p && p.at && p.at.join() === f.join();
  if (r4.error) fail(r4.error);
  else {
    if (!(r4.away && r4.away.kind === "cook" && at(r4.away, r4.fx))) fail("explorer out mapping does not cook at the furnace of the village it is in");
    if (at(r4.awayFuelled, r4.fx)) fail("explorer would take another village's fuel");
  }
  console.log(bad ? "explorer-camp-unload: " + bad + " failures" : "explorer-camp-unload: ok");
};
