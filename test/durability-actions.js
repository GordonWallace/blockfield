// Tool durability checks: NODE_PATH=$(npm root -g) node test/run.js /tmp/du test/durability-actions.js
// Lifespans by material; mining stone wears the pickaxe one use and drops cobblestone; dig time follows the material; the wear survives
// moving the tool around the inventory, throwing it and picking it up, and saving; a used-up tool breaks; villager inventories keep wear.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(async () => {
    const res = {}, I = BF.I, B = BF.B, W = BF.world, P = BF.player, inv = BF.inventory;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    P.setGameMode("survival");
    res.lifespans = ["wooden", "stone", "iron", "diamond"].map(m => m + " " + BF.durability(I[m + "_pickaxe"]));
    // a stone block straight below the player's eye, on flat ground
    const x = Math.floor(P.position.x), z = Math.floor(P.position.z), gy = W.heightAt(x, z);
    const mine = async (pick) => {
      inv.clear(); inv.setSlot(0, { id: I[pick], count: 1 }); inv.select(0);
      W.setBlock(x, gy, z, B.stone);
      P.teleport(x + 0.5, gy + 1, z + 0.5); P.setLook(0, -1.55);
      await sleep(200);
      const t0 = performance.now();
      P.setMouse(true, false);
      let ms = 0;
      while (W.getBlock(x, gy, z) === B.stone && ms < 15000) { await sleep(25); ms = performance.now() - t0; }
      P.setMouse(false, false);
      await sleep(3000);   // the drop flies to the player (the headless page runs at a few frames a second)
      const s = inv.slots[0];
      return { pick, secs: +(ms / 1000).toFixed(2), wear: s ? s.wear || 0 : "gone", cobble: inv.count(I.cobblestone) };
    };
    res.mined = [await mine("wooden_pickaxe"), await mine("stone_pickaxe"), await mine("iron_pickaxe"), await mine("diamond_pickaxe")];
    // the wear moves with the tool: inventory API, save / load, throw and pick up
    inv.clear(); inv.setSlot(0, { id: I.iron_pickaxe, count: 1, wear: 100 }); inv.select(0);
    const saved = JSON.parse(JSON.stringify(inv.serialize()));
    inv.clear(); inv.deserialize(saved);
    res.afterLoad = inv.slots[0] && inv.slots[0].wear;
    const el = document.querySelector(".bf-hotbar .bf-slot .bf-wear");
    res.bar = el && !el.hidden ? el.style.getPropertyValue("--f") : "hidden";
    // wear it out: 150 more uses, the last one breaks it
    let broke = null;
    for (let k = 0; k < 150; k++) { const w = inv.wearSelected(1); if (w === "broken") { broke = k + 1; break; } }
    res.brokeAfter = broke; res.slotAfter = inv.slots[0];
    // creative: no wear
    inv.setSlot(0, { id: I.iron_pickaxe, count: 1, wear: 10 }); P.setGameMode("creative");
    res.creativeWear = (inv.wearSelected(1), inv.slots[0].wear); P.setGameMode("survival");
    // drops keep wear
    const d = BF.drops.spawn(I.iron_pickaxe, 1, P.position.x, P.position.y + 1, P.position.z, { wear: 42 });
    inv.clear(); d.pickupDelay = 0; d.age = 1;
    await sleep(1200);
    res.pickedWear = inv.slots.find(s => s && s.id === I.iron_pickaxe) ? inv.slots.find(s => s && s.id === I.iron_pickaxe).wear : "not picked up";
    // villager packs keep wear
    const v = { inv: BF.trades.inv.create(), profession: "miner", level: 1, xp: 0, trades: [] };
    v.inv[0] = { id: I.iron_pickaxe, count: 1, wear: 77 };
    const v2 = { profession: "miner" }; BF.trades.unpack(v2, JSON.parse(JSON.stringify(BF.trades.pack(v))));
    res.villagerWear = v2.inv[0] && v2.inv[0].wear;
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
};
