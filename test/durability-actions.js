// @ci integration hosts=worker,server
// Tool durability checks: NODE_PATH=$(npm root -g) node test/run.js /tmp/du test/durability-actions.js
// Lifespans by material; mining stone wears the pickaxe one use and drops cobblestone; dig time follows the material; the wear survives
// moving the tool around the inventory, throwing it and picking it up, and saving; a used-up tool breaks; villager inventories keep wear.
module.exports = async (pg, out) => {
  const lib = require("./lib");
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(500);
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const sim = (fn, arg) => lib.sim(pg, fn, arg).then(async r => { await settle(); return r; });   // (where the simulation is: spec r15-43)
  const res = {};
  res.lifespans = await lib.sim(pg, () => ["wooden", "stone", "iron", "diamond"].map(m => m + " " + BF.durability(BF.I[m + "_pickaxe"])));
  // a stone block straight below the player's eye, on flat ground: the page digs it (its mouse), the simulation applies the break
  const at = await pg.evaluate(() => { const P = BF.player, x = Math.floor(P.position.x), z = Math.floor(P.position.z); return { x, z, gy: BF.world.heightAt(x, z) }; });
  const mine = async pick => {
    await sim(([pick, at]) => {
      const inv = BF.inventory;
      inv.clear(); inv.setSlot(0, { id: BF.I[pick], count: 1 });
      BF.world.setBlock(at.x, at.gy, at.z, BF.B.stone);
      BF.proto.flush();
    }, [pick, at]);
    await pg.evaluate(at => { const P = BF.player; BF.inventory.select(0); P.teleport(at.x + 0.5, at.gy + 1, at.z + 0.5); P.setLook(0, -1.55); }, at);
    await pg.waitForFunction(at => BF.world.getBlock(at.x, at.gy, at.z) === BF.B.stone, at, { timeout: 10000, polling: 50 }).catch(() => {});   // (the page digs what it sees)
    await pg.waitForTimeout(200);
    const t0 = Date.now();
    await pg.evaluate(() => BF.player.setMouse(true, false));
    let ms = 0;
    while (ms < 15000 && await lib.sim(pg, at => BF.world.getBlock(at.x, at.gy, at.z) === BF.B.stone, at)) { await pg.waitForTimeout(25); ms = Date.now() - t0; }
    await pg.evaluate(() => BF.player.setMouse(false, false));
    await pg.waitForTimeout(3000);   // the drop flies to the player (the headless page runs at a few frames a second)
    const got = await lib.sim(pg, () => { const s = BF.inventory.slots[0]; return { wear: s ? s.wear || 0 : "gone", cobble: BF.inventory.count(BF.I.cobblestone) }; });
    return { pick, secs: +(ms / 1000).toFixed(2), ...got };
  };
  res.mined = [await mine("wooden_pickaxe"), await mine("stone_pickaxe"), await mine("iron_pickaxe"), await mine("diamond_pickaxe")];
  // the wear moves with the tool: inventory API, save / load; the hotbar's wear bar
  res.afterLoad = await sim(() => {
    const inv = BF.inventory;
    inv.clear(); inv.setSlot(0, { id: BF.I.iron_pickaxe, count: 1, wear: 100 });
    const saved = JSON.parse(JSON.stringify(inv.serialize()));
    inv.clear(); inv.deserialize(saved);
    BF.proto.flush();
    return inv.slots[0] && inv.slots[0].wear;
  });
  res.bar = await pg.evaluate(() => { const el = document.querySelector(".bf-hotbar .bf-slot .bf-wear"); return el && !el.hidden ? el.style.getPropertyValue("--f") : "hidden"; });
  // wear it out: 150 more uses, the last one breaks it
  Object.assign(res, await sim(() => {
    let broke = null;
    for (let k = 0; k < 150; k++) { const w = BF.inventory.wearSelected(1); if (w === "broken") { broke = k + 1; break; } }
    const after = BF.inventory.slots[0];
    BF.inventory.setSlot(0, { id: BF.I.iron_pickaxe, count: 1, wear: 10 });
    return { brokeAfter: broke, slotAfter: after };
  }));
  // creative: no wear (the game mode is the page's: it reaches the simulation in the player's messages)
  await pg.evaluate(() => BF.player.setGameMode("creative")); await pg.waitForTimeout(500); await settle();
  res.creativeWear = await lib.sim(pg, () => (BF.inventory.wearSelected(1), BF.inventory.slots[0].wear));
  await pg.evaluate(() => BF.player.setGameMode("survival")); await pg.waitForTimeout(500); await settle();
  // drops keep wear
  await sim(() => {
    const P = BF.player, d = BF.drops.spawn(BF.I.iron_pickaxe, 1, P.position.x, P.position.y + 1, P.position.z, { wear: 42 });
    BF.inventory.clear(); d.pickupDelay = 0; d.age = 1;
  });
  await pg.waitForTimeout(1200);
  res.pickedWear = await lib.sim(pg, () => { const s = BF.inventory.slots.find(s => s && s.id === BF.I.iron_pickaxe); return s ? s.wear : "not picked up"; });
  // villager packs keep wear
  res.villagerWear = await lib.sim(pg, () => {
    const v = { inv: BF.trades.inv.create(), profession: "miner", level: 1, xp: 0, trades: [] };
    v.inv[0] = { id: BF.I.iron_pickaxe, count: 1, wear: 77 };
    const v2 = { profession: "miner" }; BF.trades.unpack(v2, JSON.parse(JSON.stringify(BF.trades.pack(v))));
    return v2.inv[0] && v2.inv[0].wear;
  });
  console.log(JSON.stringify(res, null, 1));
};
