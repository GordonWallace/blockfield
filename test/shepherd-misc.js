// @ci integration hosts=worker,server
// Shears recipe/icon, player feeding + shearing (wild sheep), and the save round trip of the pens. Same usage as test/shepherd-check.js.
module.exports = async (pg, out) => {
  // in parts where the simulation is (spec r15-43), a new world made between them with lib.newWorld (the page's copy of the world too);
  // the helpers, and what a part hands the next, live on globalThis.__sm there
  const lib = require('./lib'), lines = [];
  await lib.simBFT(pg);
  await lib.sim(pg, () => {
    const S = globalThis.__sm = { lines: [] };
    S.ok = (name, cond, extra) => S.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    S.step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    S.run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) S.step(h); };
    S.day = () => BF.sky.day + BF.sky.time;
    S.load = async (x, z) => {
      BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
      for (let i = 0; i < 400 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 300; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    };
  });
  lines.push(...await lib.sim(pg, () => {
    const S = globalThis.__sm, { ok, step, run, day, load } = S, I = BF.I; S.lines = []; BF.state.paused = true;
    // ---- item, recipe, icon
    const it = BF.items[I.shears];
    ok("shears item exists and is a shears tool", !!it && it.tool && it.tool.type === "shears");
    const rc = BF.inventory.recipes.find(r => r.out === I.shears);
    ok("shears recipe = 2 iron ingots on a diagonal (Minecraft)", !!rc && rc.type === "shaped" && rc.pattern.join("|") === " I|I " && rc.key.I.length === 1 && rc.key.I[0] === I.iron_ingot, rc && rc.desc);
    ok("shears have an icon", typeof BF.textures.icon(I.shears) === "string" && BF.textures.icon(I.shears).startsWith("data:"));
    ok("shears speed up leaves", BF.items[I.shears].tool.speed > 1 && BF.player.mineSeconds(BF.B.oak_leaves, I.shears) < BF.player.mineSeconds(BF.B.oak_leaves, null), BF.player.mineSeconds(BF.B.oak_leaves, I.shears) + "s vs " + BF.player.mineSeconds(BF.B.oak_leaves, null) + "s by hand");   // leaves are a hoe block (#44); shears are special-cased
    // ---- wild sheep, player use
    return S.lines;
  }));
  await lib.newWorld(pg, 5, { gen: 4, villages: 9, gameMode: "creative" });
  lines.push(...await lib.sim(pg, async () => {
    const S = globalThis.__sm, { ok, step, run, day, load } = S, I = BF.I; S.lines = []; BF.state.paused = true;
    BF.mobs.spawning = false;
    // the planet: dry land a few hundred blocks from spawn
    const S5 = BFT.spawn();
    let WX = S5.x + 300, WZ = S5.z + 300;
    for (let r = 300; r < 3000 && !(BF.worldgen.heightAt(WX, WZ) > 2 && BF.worldgen.heightAt(WX + 3, WZ) > 2); r += 50) { WX = S5.x + r; WZ = S5.z + r; }
    await load(WX, WZ);
    BF.sky.setTime(0.1);
    const gy = BF.worldgen.heightAt(WX, WZ) + 1;
    const a = BF.mobs.spawn("sheep", WX + 0.5, gy, WZ + 0.5), b = BF.mobs.spawn("sheep", WX + 3.5, BF.worldgen.heightAt(WX + 3, WZ) + 1, WZ + 0.5);
    run(1);
    const wheat = { id: I.wheat_item, count: 3 }, shears = { id: I.shears, count: 1 };
    ok("wheat feeds a hungry sheep", BF.shepherd.playerUse(a, wheat) === true && BF.shepherd.willing(a, day()));
    ok("a sheep that ate is not hungry", typeof BF.shepherd.playerUse(a, wheat) === "string");
    ok("other items are ignored", BF.shepherd.playerUse(a, { id: I.stick, count: 1 }) === false);
    BF.shepherd.playerUse(b, wheat);
    const drops0 = BF.drops.list ? BF.drops.list.length : -1;
    ok("shears shear a sheep and drop wool", BF.shepherd.playerUse(a, shears) === true && a.sheep.shorn);
    ok("a shorn sheep says so", BF.shepherd.playerUse(a, shears) === "This sheep has no wool");
    ok("wool dropped on the ground", !BF.drops.list || BF.drops.list.length > drops0, [drops0, BF.drops.list && BF.drops.list.length]);
    const n0 = BF.mobs.list.filter(m => m.type === "sheep").length;
    run(40);
    const n1 = BF.mobs.list.filter(m => m.type === "sheep").length;
    ok("two fed wild sheep breed", n1 === n0 + 1, [n0, n1]);
    const lamb = BF.mobs.list.find(m => m.type === "sheep" && m.lamb);
    ok("lamb gives nothing and cannot be sheared", !!lamb && BF.shepherd.playerUse(lamb, shears) === "Lambs are too small to shear");
    ok("wild sheep are not pen stock", !a.pen && !lamb.pen);
    return S.lines;
  }));
  // ---- pens survive a save and load
  await lib.newWorld(pg, 123, { gen: 4, villages: 9, gameMode: "survival" });
  lines.push(...await lib.sim(pg, async () => {
    const S = globalThis.__sm, { ok, step, run, day, load } = S, I = BF.I; S.lines = []; BF.state.paused = true;
    BF.mobs.spawning = false;
    const PV = BFT.village((v, k) => k.pen), PK = PV.x + "," + PV.z;   // the planet: the village nearest to spawn with a pen
    await load(PV.x + 4, PV.z + 4);
    BF.sky.setTime(0.1); run(10);
    for (let k = 0; k < 120 && !(BF.mobs.villages.get(PK) && BF.shepherd.pensOf(BF.mobs.villages.get(PK)).some(p => p.sheep.length >= 2 && p.sheep.every(s => s.mob))); k++) { BF.world.update(PV.x + 4, PV.z + 4, 8); run(0.5); }   // sized village: wait for its stocked pen
    const rec = BF.mobs.villages.get(PK), pen = BF.shepherd.pensOf(rec).find(p => p.sheep.length >= 2) || BF.shepherd.pensOf(rec)[0];
    const shorn = pen.sheep[0].mob; BF.shepherd.shear(shorn, "t"); BF.shepherd.feed(pen.sheep[1].mob, "t");
    const want = pen.sheep.map(s => [!!s.shorn, s.fed != null]);
    const wantN = pen.sheep.length, key = pen.key;
    const saved = JSON.parse(JSON.stringify(BF.mobs.exportVillagers()));
    ok("export has pens:<village>", !!saved["pens:" + PK], saved["pens:" + PK] && saved["pens:" + PK][0].s.length);
    const dayNow = BF.sky.day, tNow = BF.sky.time;
    Object.assign(S, { saved, PV, PK, key, want, wantN, dayNow, tNow });
    return S.lines;
  }));
  await lib.newWorld(pg, 123, { gen: 4, villages: 9, gameMode: "survival" });
  lines.push(...await lib.sim(pg, async () => {
    const S = globalThis.__sm, { ok, step, run, day, load } = S, I = BF.I; S.lines = []; BF.state.paused = true;
    const { saved, PV, PK, key, want, wantN, dayNow, tNow } = S;
    BF.mobs.spawning = false;
    BF.mobs.importVillagers(saved);
    BF.sky.day = dayNow; BF.sky.setTime(tNow);
    await load(PV.x + 4, PV.z + 4);
    // Read the pen in the step it comes back in. Game time run after that is not part of the round trip: the restored shepherd goes on
    // feeding, and a hungry sheep it feeds breeds with the one fed above (a lamb joins the pen), so the count would depend on how long this waits.
    const penBack = () => { const r = BF.mobs.villages.get(PK), p = r && BF.shepherd.pensOf(r).find(q => q.key === key); return !!(p && p.sheep && p.sheep.every(s => s.mob && !s.mob.removed)); };
    for (let k = 0; k < 1400 && !penBack(); k++) { if (k % 10 === 0) BF.world.update(PV.x + 4, PV.z + 4, 8); step(); }
    const rec2 = BF.mobs.villages.get(PK), pen2 = BF.shepherd.pensOf(rec2).find(p => p.key === key);
    ok("pen restored with the same sheep count", pen2 && pen2.sheep.length === wantN, [pen2 && pen2.sheep.length, wantN]);
    ok("shorn / fed state restored", pen2 && JSON.stringify(pen2.sheep.map(s => [!!s.shorn, s.fed != null])) === JSON.stringify(want), pen2 && pen2.sheep.map(s => [!!s.shorn, s.fed != null]));
    ok("restored sheep are live again", pen2 && pen2.sheep.every(s => s.mob && !s.mob.removed));
    return S.lines;
  }));
  for (const l of lines) console.log(l);
};
