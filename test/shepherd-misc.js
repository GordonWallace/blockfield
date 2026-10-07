// Shears recipe/icon, player feeding + shearing (wild sheep), and the save round trip of the pens. Same usage as test/shepherd-check.js.
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const day = () => BF.sky.day + BF.sky.time;
    const load = async (x, z) => {
      BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
      for (let i = 0; i < 400 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 300; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    };
    const I = BF.I;
    BF.state.paused = true;
    // ---- item, recipe, icon
    const it = BF.items[I.shears];
    ok("shears item exists and is a shears tool", !!it && it.tool && it.tool.type === "shears");
    const rc = BF.inventory.recipes.find(r => r.out === I.shears);
    ok("shears recipe = 3 iron ingots", !!rc && rc.type === "shapeless" && rc.ings.length === 3 && rc.ings.every(g => g.length === 1 && g[0] === I.iron_ingot), rc && rc.desc);
    ok("shears have an icon", typeof BF.textures.icon(I.shears) === "string" && BF.textures.icon(I.shears).startsWith("data:"));
    ok("shears speed up leaves", BF.items[I.shears].tool.speed > 1 && BF.player.mineSeconds(BF.B.oak_leaves, I.shears) < BF.player.mineSeconds(BF.B.oak_leaves, null), BF.player.mineSeconds(BF.B.oak_leaves, I.shears) + "s vs " + BF.player.mineSeconds(BF.B.oak_leaves, null) + "s by hand");   // leaves are a hoe block (#44); shears are special-cased
    // ---- wild sheep, player use
    BF.newWorld(5, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    await load(300, 300);
    BF.sky.setTime(0.1);
    const gy = BF.worldgen.heightAt(300, 300) + 1;
    const a = BF.mobs.spawn("sheep", 300.5, gy, 300.5), b = BF.mobs.spawn("sheep", 303.5, gy, 300.5);
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
    // ---- pens survive a save and load
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;
    await load(26 + 4, 39 + 4);
    BF.sky.setTime(0.1); run(10);
    for (let k = 0; k < 120 && !(BF.mobs.villages.get("26,39") && BF.shepherd.pensOf(BF.mobs.villages.get("26,39")).some(p => p.sheep.length >= 2 && p.sheep.every(s => s.mob))); k++) { BF.world.update(30, 43, 8); run(0.5); }   // sized village: wait for its stocked pen
    const rec = BF.mobs.villages.get("26,39"), pen = BF.shepherd.pensOf(rec).find(p => p.sheep.length >= 2) || BF.shepherd.pensOf(rec)[0];
    const shorn = pen.sheep[0].mob; BF.shepherd.shear(shorn, "t"); BF.shepherd.feed(pen.sheep[1].mob, "t");
    const want = pen.sheep.map(s => [!!s.shorn, s.fed != null]);
    const wantN = pen.sheep.length, key = pen.key;
    const saved = JSON.parse(JSON.stringify(BF.mobs.exportVillagers()));
    ok("export has pens:<village>", !!saved["pens:26,39"], saved["pens:26,39"] && saved["pens:26,39"][0].s.length);
    const dayNow = BF.sky.day, tNow = BF.sky.time;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;
    BF.mobs.importVillagers(saved);
    BF.sky.day = dayNow; BF.sky.setTime(tNow);
    await load(26 + 4, 39 + 4);
    run(10);
    for (let k = 0; k < 120 && !(BF.mobs.villages.get("26,39") && (BF.shepherd.pensOf(BF.mobs.villages.get("26,39")).find(p => p.key === key) || { sheep: [] }).sheep.every(s => s.mob && !s.mob.removed) && BF.shepherd.pensOf(BF.mobs.villages.get("26,39")).some(p => p.key === key)); k++) { BF.world.update(30, 43, 8); run(0.5); }
    const rec2 = BF.mobs.villages.get("26,39"), pen2 = BF.shepherd.pensOf(rec2).find(p => p.key === key);
    ok("pen restored with the same sheep count", pen2 && pen2.sheep.length === wantN, [pen2 && pen2.sheep.length, wantN]);
    ok("shorn / fed state restored", pen2 && JSON.stringify(pen2.sheep.map(s => [!!s.shorn, s.fed != null])) === JSON.stringify(want), pen2 && pen2.sheep.map(s => [!!s.shorn, s.fed != null]));
    ok("restored sheep are live again", pen2 && pen2.sheep.every(s => s.mob && !s.mob.removed));
    return R;
  });
  for (const l of res.lines) console.log(l);
};
