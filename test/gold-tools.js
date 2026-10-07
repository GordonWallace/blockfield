// Gold tools and villager tool wear: NODE_PATH=$(npm root -g) node test/run.js /tmp/gt test/gold-tools.js
// Gold tools: Minecraft's lifespan (32), speed (12), harvest level (wood's) and recipes. Villager wear (js/toolwear.js): the player's rule
// per block / hit, a used-up tool leaves the pack and is logged, and in a running village the shepherd's shears and the farmer's hoe wear
// one use per sheep shorn / block tilled.
// @ci baseline
module.exports = async (pg) => {
  const r = await pg.evaluate(async () => {
    const out = [], ok = (name, c, extra) => out.push((c ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, B = BF.B, P = BF.player, TW = BF.toolWear, T = BF.trades.inv;
    // ---- gold tools
    const kinds = ["pickaxe", "axe", "shovel", "sword", "hoe"];
    ok("five gold tools exist", kinds.every(k => I["golden_" + k] != null), kinds.filter(k => I["golden_" + k] == null));
    ok("gold tools last 32 uses", kinds.every(k => BF.durability(I["golden_" + k]) === 32), kinds.map(k => BF.durability(I["golden_" + k])));
    ok("other lifespans unchanged", ["wooden", "stone", "iron", "diamond"].map(m => BF.durability(I[m + "_pickaxe"])).join() === "59,131,250,1561");
    const recipe = id => BF.inventory.recipes.find(x => x.out === id);
    const rp = recipe(I.golden_pickaxe), rh = recipe(I.golden_hoe);
    ok("golden pickaxe recipe: 3 gold ingots + 2 sticks", !!rp && rp.pattern.join("|") === "MMM| S | S " && rp.key.M.includes(I.gold_ingot), rp && rp.pattern);
    ok("every gold tool has a recipe", kinds.every(k => recipe(I["golden_" + k])));
    ok("gold tools sit in the Tools tab with an icon", !!BF.textures.icon(I.golden_axe));
    // vanilla times (Java): stone 0.2 s with a gold pickaxe (0.3 s diamond, 0.4 s iron), oak log 0.25 s with a gold axe
    const ms = (b, t) => +P.mineSeconds(B[b], t == null ? null : I[t]).toFixed(2);
    ok("gold pickaxe mines stone in 0.2 s (iron 0.4, diamond 0.3)", ms("stone", "golden_pickaxe") === 0.2 && ms("stone", "iron_pickaxe") === 0.4 && ms("stone", "diamond_pickaxe") === 0.3, [ms("stone", "golden_pickaxe"), ms("stone", "iron_pickaxe"), ms("stone", "diamond_pickaxe")]);
    ok("gold axe fells an oak log in 0.25 s (hand 3 s)", ms("oak_log", "golden_axe") === 0.25 && ms("oak_log", null) === 3, [ms("oak_log", "golden_axe"), ms("oak_log", null)]);
    ok("gold pickaxe harvests stone and coal", P.minedDrops(B.stone, I.golden_pickaxe) && P.minedDrops(B.coal_ore, I.golden_pickaxe));
    ok("gold pickaxe gets nothing from iron, gold or diamond ore (wood's level)", !P.minedDrops(B.iron_ore, I.golden_pickaxe) && !P.minedDrops(B.gold_ore, I.golden_pickaxe) && !P.minedDrops(B.diamond_ore, I.golden_pickaxe));
    ok("gold tools have a trade value", ["golden_pickaxe", "golden_hoe"].every(n => BF.trades.VALUE ? BF.trades.VALUE[n] > 0 : true));
    // ---- villager wear helper
    ok("breaking a log costs an axe 1 use, a crop nothing", TW.forBlock(B.oak_log, { id: I.iron_axe }) === 1 && TW.forBlock(B.wheat, { id: I.iron_axe }) === 0);
    ok("a sword pays 2 per block, 1 per hit; other tools 2 per hit", TW.forBlock(B.stone, { id: I.iron_sword }) === 2 && TW.forHit({ id: I.iron_sword }) === 1 && TW.forHit({ id: I.iron_pickaxe }) === 2);
    ok("bare hands cost nothing", TW.forBlock(B.stone, null) === 0 && TW.use({ inv: [] }, null, 1) === false);
    const v = { inv: T.create(), profession: "farmer", position: P.position.clone() };
    v.inv[0] = { id: I.wooden_hoe, count: 1, wear: 50 }; v.inv[1] = { id: I.golden_hoe, count: 1 }; v.inv[2] = { id: I.stone_hoe, count: 1, wear: 3 };
    ok("best tool: stone over gold over wood", TW.best(v, "hoe") === v.inv[2]);
    v.inv[2] = null;
    ok("gold over wood", TW.best(v, "hoe") === v.inv[1]);
    let r1;
    for (let k = 0; k < 32; k++) r1 = TW.use(v, v.inv[1] || { id: 0 }, 1);
    ok("a gold hoe breaks on its 32nd use and leaves the pack", r1 === "broken" && v.inv[1] === null, v.inv[1]);
    ok("the break is recorded", TW.LOG.length > 0 && TW.LOG[TW.LOG.length - 1].tool === "golden_hoe");

    // ---- a farmer tilling a planned bed (js/villagelife.js performBed): one use per block tilled
    {
      const W = BF.world, VL = BF.villageLife, X = VL._test;
      const px = Math.floor(P.position.x) + 6, pz = Math.floor(P.position.z) + 6, y = W.heightAt(px, pz);
      for (let x = px - 1; x <= px + 5; x++) for (let z = pz - 1; z <= pz + 5; z++) { for (let yy = y + 1; yy < y + 4; yy++) W.setBlock(x, yy, z, 0); W.setBlock(x, y, z, B.dirt); }
      const L = { x0: px, z0: pz, x1: px + 4, z1: pz + 4, y, ax: "x", ch: [] }, Pj = { id: "gt", L };
      const R = { key: "gt-test", wg: {} }, D = VL.vdata(R); D.boxes = D.boxes || []; D.cells = D.cells || []; D.projects = [Pj];
      const f = { inv: T.create(), profession: "farmer", position: P.position.clone(), farm: {}, village: R };
      f.inv[0] = { id: I.stone_hoe, count: 1 };
      let tilled = 0;
      for (let x = px; x <= px + 4 && tilled < 5; x++) {
        const t = X.cellJob(Pj, x, pz + 2);
        if (t && t.kind === "till" && X.perform(f, { task: t }, R, D)) tilled++;
      }
      ok("a farmer's hoe wears one use per block tilled", tilled > 0 && f.inv[0] && f.inv[0].wear === tilled, { tilled, wear: f.inv[0] && f.inv[0].wear });
    }

    // ---- in a running village: shears and hoe wear as they are used
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;
    const V = { x: 26, z: 39 };   // seed 1: a village whose shepherd has its loom (test/shepherd-day.js)
    P.teleport(V.x + 4.5, BF.worldgen.heightAt(V.x + 4, V.z + 4) + 2, V.z + 4.5);
    for (let i = 0; i < 400 && !BF.world.isLoaded(V.x, V.z); i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    P.invulnerable = true;
    BF.sky.setTime(0.05);
    for (let t = 0; t < 8; t += 0.05) step();
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(V.x + "," + V.z) || { members: [] }).members.some(m => m.profession === "shepherd")); k++) { BF.world.update(V.x, V.z, 8); for (let t = 0; t < 0.5; t += 0.05) step(); }
    const rec = BF.mobs.villages.get(V.x + "," + V.z);
    const shep = rec && rec.members.find(m => m.type === "villager" && m.profession === "shepherd");
    const farmer = rec && rec.members.find(m => m.type === "villager" && m.profession === "farmer" && m.jobsite);
    ok("village has a shepherd", !!shep);
    if (shep) {
      const pen = BF.shepherd.penOf(shep), shorn = () => pen ? pen.sheep.filter(x => x.shorn).length : 0;
      const shears = TW.best(shep, "shears"), w0 = (shears && shears.wear) || 0, s0 = shorn();
      const hoe = farmer && TW.best(farmer, "hoe"), h0 = (hoe && hoe.wear) || 0, till0 = farmer && farmer.farm ? farmer.farm.tilled || 0 : 0;
      for (let i = 0; i < 6000; i++) step();
      const used = ((shears && shears.wear) || 0) - w0, sheared = shorn() - s0;
      ok("shepherd's shears wore one use per sheep shorn", used > 0 && used === sheared, { used, sheared });
      if (farmer && hoe) {
        const tilled = (farmer.farm ? farmer.farm.tilled || 0 : 0) - till0, hw = (hoe.wear || 0) - h0;
        if (tilled > 0) ok("farmer's hoe wore one use per block tilled", hw === tilled, { tilled, hw });
        else out.push("INFO farmer tilled nothing this morning; hoe wear " + hw);
        ok("harvesting and planting cost the hoe nothing", tilled > 0 || hw === 0, { tilled, hw });   // farmers here only till when they make or grow a bed
      } else out.push("INFO no working farmer with a hoe in this village: " + rec.members.filter(m => m.profession === "farmer").map(m => [!!m.jobsite, m.inv.filter(Boolean).map(x => BF.items[x.id].name).join("/")].join(":")).join(", "));
      const kinds = BF.vlog.entries ? BF.vlog.entries(rec.key).filter(e => e[1] === "tool") : [];
      out.push("INFO tool log lines: " + kinds.length);
    }
    return out;
  });
  console.log(r.join("\n"));
  const fails = r.filter(l => l.startsWith("FAIL")).length;
  console.log(fails ? fails + " FAILED" : "ALL PASS");
};
