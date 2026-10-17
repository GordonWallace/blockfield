// A worn wooden tool in a furnace's fuel slot keeps its wear when the furnace is removed (bug-042):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/ffw test/furnace-fuel-wear.js
// @ci integration suite=items
// /setblock and an explosion drop it on the ground, the player mining the furnace gets it in their inventory, and with a full
// inventory it drops where the furnace stood. An unworn tool still comes back unworn.
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(async () => {
    const I = BF.I, B = BF.B, W = BF.world, P = BF.player, inv = BF.inventory, tick = () => new Promise(r => setTimeout(r, 0));
    BF.mobs.spawning = false;
    const x = Math.floor(P.position.x) + 2, y = Math.floor(P.position.y) + 1, z = Math.floor(P.position.z);
    const pk = I.wooden_pickaxe, res = {};
    const place = (wear) => { W.setBlock(x, y, z, B.furnace); const f = inv.furnaceRecord(x, y, z); f.slots = [null, wear ? { id: pk, count: 1, wear } : { id: pk, count: 1 }, null]; };
    const dropWear = () => { const d = BF.drops.list.find(d => d.id === pk); return d ? d.wear || 0 : "none"; };
    const invWear = () => { const s = inv.slots.find(s => s && s.id === pk); return s ? s.wear || 0 : "none"; };

    place(40); BF.drops.clear(); inv.clear();
    BF.commands.execute(`/setblock ${x} ${y} ${z} air`); await tick();
    res.setblock = dropWear();

    place(40); BF.drops.clear(); inv.clear();
    W.setBlock(x, y, z, 0); await tick();   // what a creeper explosion does to the cell
    res.explosion = dropWear();

    place(40); BF.drops.clear(); inv.clear();
    W.setBlock(x, y, z, 0); BF.emit("blockBroken", x, y, z, B.furnace); await tick();   // the player mining it (js/player.js)
    res.mined = invWear();

    place(40); BF.drops.clear(); inv.clear();
    for (let i = 0; i < inv.slots.length; i++) inv.setSlot(i, { id: I.cobblestone, count: 64 });
    W.setBlock(x, y, z, 0); BF.emit("blockBroken", x, y, z, B.furnace); await tick();
    res.minedFull = dropWear();

    place(0); BF.drops.clear(); inv.clear();
    W.setBlock(x, y, z, 0); await tick();
    res.unworn = dropWear();
    inv.clear(); BF.drops.clear();
    return res;
  });
  console.log(JSON.stringify(r));
  const want = { setblock: 40, explosion: 40, mined: 40, minedFull: 40, unworn: 0 };
  for (const [k, v] of Object.entries(want)) console.log((r[k] === v ? "ok   " : "FAIL ") + k + ": " + JSON.stringify(r[k]) + (r[k] === v ? "" : " (want " + JSON.stringify(v) + ")"));
};
