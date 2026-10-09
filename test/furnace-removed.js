// A furnace removed by anything but the player's own mining (creeper explosion, /setblock, /fill) drops its contents on the ground,
// stops cooking, and a new furnace in the same cell starts empty (bug-004). Mining it yourself still hands the contents to you.
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(async () => {
    const I = BF.I, B = BF.B, W = BF.world, P = BF.player, inv = BF.inventory, tick = () => new Promise(r => setTimeout(r, 0));
    BF.mobs.spawning = false;
    const x = Math.floor(P.position.x) + 2, y = Math.floor(P.position.y) + 1, z = Math.floor(P.position.z);
    const fill = () => { const f = inv.furnaceRecord(x, y, z); f.slots = [{ id: I.raw_beef, count: 10 }, { id: I.coal, count: 7 }, { id: I.iron_ingot, count: 3 }]; return f; };
    const dropsHere = () => BF.drops.list.filter(d => Math.abs(d.position ? d.position.x - x - 0.5 : 0) < 3).map(d => BF.items[d.id].name + "x" + d.count).sort();
    const res = {};
    const way = async (name, remove) => {
      W.setBlock(x, y, z, B.furnace); fill();
      BF.drops.clear(); inv.clear();
      remove();
      await tick();
      const left = inv.furnaceState(x, y, z);
      for (let i = 0; i < 200; i++) inv.simTick(0.05);
      res[name] = { gone: !BF.isFurnace(W.getBlock(x, y, z)), drops: dropsHere(), record: !!left, invItems: inv.slots.filter(Boolean).length };
    };
    await way("setBlock", () => W.setBlock(x, y, z, 0));   // what a creeper explosion does to the cell (js/mobs.js explode)
    await way("setblockCmd", () => BF.commands.execute(`/setblock ${x} ${y} ${z} air`));
    await way("fillCmd", () => BF.commands.execute(`/fill ${x} ${y} ${z} ${x} ${y} ${z} stone`));
    // the player mining it: setBlock then blockBroken in the same task (js/player.js)
    await way("mined", () => { W.setBlock(x, y, z, 0); BF.emit("blockBroken", x, y, z, B.furnace); });
    // a fresh furnace in the same cell is empty
    W.setBlock(x, y, z, B.furnace); fill(); BF.drops.clear();
    W.setBlock(x, y, z, 0); W.setBlock(x, y, z, B.furnace);   // removed and put back in the same task
    await tick();
    res.respill = dropsHere().length;
    inv.open("furnace", { x, y, z });
    res.newFurnace = inv.furnaceState(x, y, z).slots.filter(Boolean).length;
    inv.close();
    W.setBlock(x, y, z, 0);
    return res;
  });
  const check = (ok, msg) => console.log((ok ? "PASS " : "FAIL ") + msg);
  const want = ["coalx7", "iron_ingotx3", "raw_beefx10"].join();
  for (const k of ["setBlock", "setblockCmd", "fillCmd"]) {
    const o = r[k];
    check(o.gone, `${k}: furnace gone`);
    check(!o.record, `${k}: no hidden furnace left cooking`);
    check(o.drops.join() === want, `${k}: contents dropped on the ground (${o.drops.join(" ")})`);
  }
  check(!r.mined.record && r.mined.drops.length === 0 && r.mined.invItems === 3, `mined: contents go to the player, nothing on the ground (${JSON.stringify(r.mined)})`);
  check(r.newFurnace === 0 && r.respill === 3, `a new furnace in the same place is empty and the old contents dropped (${r.newFurnace} stacks inside, ${r.respill} on the ground)`);
};
