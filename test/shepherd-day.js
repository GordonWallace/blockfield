// Shepherd behaviour over simulated days: feeding, shearing, wheat buying, culling. Same usage as test/shepherd-check.js.
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const day = () => BF.sky.day + BF.sky.time;
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;
    const V = { x: 26, z: 39 };   // seed 1: a village whose shepherd has its loom from the start (with village generator 2 the spawn village's shepherds start unemployed)
    BF.player.teleport(V.x + 4.5, BF.worldgen.heightAt(V.x + 4, V.z + 4) + 2, V.z + 4.5);
    for (let i = 0; i < 400 && !BF.world.isLoaded(V.x, V.z); i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    run(8);
    // a sized village (village generator 2) spans more chunks: keep loading until its shepherds have spawned
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(V.x + "," + V.z) || { members: [] }).members.some(m => m.profession === "shepherd")); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(V.x + "," + V.z);
    const shep = rec.members.find(m => m.type === "villager" && m.profession === "shepherd");
    const pen = BF.shepherd.penOf(shep);
    const I = BF.I, c = n => BF.trades.inv.count(shep.inv, I[n]);
    const tasks = {}; let sheepSeen = 0;
    const inPen = () => shep.position.x > pen.fx0 && shep.position.x < pen.fx1 && shep.position.z > pen.fz0 && shep.position.z < pen.fz1;
    const gateOpen = () => { const g = BF.blocks[BF.world.getBlock(pen.gate[0], pen.y + 1, pen.gate[1])].gate; return !!(g && g.open); };
    const G = { inside: 0, open: 0, closedAfterInside: false };
    const sample = () => {
      if (shep.shp && shep.shp.task) tasks[shep.shp.task.kind] = (tasks[shep.shp.task.kind] || 0) + 1;
      if (inPen()) G.inside++;
      if (gateOpen()) G.open++;
    };
    const startWheat = c("wheat_item");
    const me = shep.profession + (shep.slot ? "#" + shep.slot.idx : ""), t0 = BF.sky.day + BF.sky.time - 0.001;
    const bought = () => BF.villageLife.log.filter(l => l.kind === "buyWheat" && l.who === me && l.day >= t0).reduce((n, l) => n + (parseInt(l.got) || 0), 0);
    // ---- morning: the shepherd feeds the hungry sheep and shears the woolly ones (it may buy more wheat meanwhile)
    for (let i = 0; i < 6000; i++) { step(); if (i % 10 === 0) sample(); }
    ok("shepherd fed the sheep (wheat used)", c("wheat_item") < startWheat + bought(), [startWheat, bought(), c("wheat_item")]);
    ok("every adult pen sheep was fed today", pen.sheep.filter(s => s.mob && !s.mob.lamb).every(s => !BF.shepherd.hungry(s.mob, day())));
    ok("shepherd sheared the flock (wool in inventory)", c("white_wool") >= 1, c("white_wool"));
    ok("shepherd went into the pen", G.inside > 0, G);
    ok("the gate was opened for it", G.open > 0, G);
    for (let i = 0; i < 1200 && (inPen() || gateOpen()); i++) step();
    ok("shepherd walked back out and the gate is shut", !inPen() && !gateOpen(), { inPen: inPen(), open: gateOpen(), task: shep.shp && shep.shp.task && shep.shp.task.kind });
    R.tasks = tasks;
    ok("pen still had room, nothing was culled", pen.sheep.length < pen.threshold && !tasks.cull, [pen.sheep.length, pen.threshold, tasks.cull]);
    // ---- overcrowding: shepherd culls adults down to below the threshold, never below two
    for (const s of pen.sheep) s.cd = day() + 5;   // no more lambs while the cull is measured
    for (let i = 0; i < 6; i++) {
      const s = { fed: null, shorn: false, woolAt: null, growAt: null, cd: day() + 5, x: pen.x0 + 1 + (i % 4), z: pen.z0 + 1 + (i >> 2), mob: null };
      pen.sheep.push(s);
    }
    BF.sky.setTime(0.08);
    run(5);
    const crowded = pen.sheep.length;
    ok("pen is over the threshold", crowded >= pen.threshold, [crowded, pen.threshold]);
    const mut0 = c("raw_mutton") + c("cooked_mutton");
    for (let i = 0; i < 6000 && pen.sheep.length >= pen.threshold; i++) { step(); if (i % 10 === 0) sample(); }
    ok("shepherd culled until the pen is below the threshold", pen.sheep.length < pen.threshold, [pen.sheep.length, pen.threshold]);
    R.dbg = { flock: pen.sheep.map(s => s.mob ? (s.mob.lamb ? "L" : "A") + (s.shorn ? "s" : "w") + (BF.shepherd.hungry(s.mob, day()) ? "h" : "") : "-").join(" "), task: shep.shp.task && shep.shp.task.kind, wheat: c("wheat_item"), t: BF.sky.time, wanted: BF.shepherd.wheatWanted(shep), fshop: shep.fshop && shep.fshop.stage };
    ok("it stopped culling at threshold-1 (no overkill)", pen.sheep.length === pen.threshold - 1, pen.sheep.length);
    ok("shepherd kept the mutton", c("raw_mutton") + c("cooked_mutton") > mut0, [mut0, c("raw_mutton") + c("cooked_mutton")]);
    run(60);
    ok("no more culling once below", pen.sheep.length === pen.threshold - 1 || pen.sheep.length >= pen.threshold - 1, pen.sheep.length);
    // ---- wheat: out of wheat -> buys from a farmer
    let farmer = rec.members.find(m => m.type === "villager" && m.profession === "farmer");
    if (!farmer) {   // a small sized village may have none: make one of a plain trade
      farmer = rec.members.find(m => m.type === "villager" && !m.child && /^(mason|fletcher|toolsmith|weaponsmith|armorer|leatherworker|cleric|librarian|nitwit|unemployed)$/.test(m.profession));
      if (farmer) BF.mobs.setProfession(farmer, "farmer");
    }
    ok("village has a farmer", !!farmer);
    if (farmer) {
      BF.trades.inv.remove(shep.inv, I.wheat_item, 999);
      BF.trades.inv.remove(farmer.inv, I.wheat_item, 999); BF.trades.inv.add(farmer.inv, I.wheat_item, 40);
      farmer.position.set(shep.position.x + 2, shep.position.y, shep.position.z); farmer.vel.set(0, 0, 0);   // standing next to it: no chase
      const em0 = c("emerald"), fw0 = BF.trades.inv.count(farmer.inv, I.wheat_item);
      BF.sky.setTime(0.1);
      let bought = false;
      for (let i = 0; i < 9000 && !bought; i++) { if (i % 20 === 0) { farmer.position.set(shep.position.x + 2, shep.position.y, shep.position.z); farmer.vel.set(0, 0, 0); } step(); if (c("wheat_item") > 0) bought = true; }
      ok("shepherd bought wheat from the farmer", bought, { wheat: c("wheat_item"), emeraldsBefore: em0, emeraldsAfter: c("emerald"), inv: shep.inv.filter(Boolean).map(s => BF.items[s.id].name + ":" + s.count).join(","), want: BF.shepherd.wheatWanted(shep), fshop: shep.fshop && shep.fshop.stage, canSell: BF.villageLife && BF.villageLife.canSell && BF.villageLife.canSell(farmer), farmerWheat: [fw0, BF.trades.inv.count(farmer.inv, I.wheat_item)] });
      ok("it paid emeralds", c("emerald") < em0);
      R.log = BF.villageLife.log.filter(l => l.kind === "buyWheat").slice(-2);
    }
    R.sheep = pen.sheep.length;
    return R;
  });
  for (const l of res.lines) console.log(l);
  console.log(JSON.stringify(res.dbg));
  console.log(JSON.stringify({ tasks: res.tasks, sheep: res.sheep, log: res.log }));
};
