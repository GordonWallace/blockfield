// Chests and house ladders: node test/run.js /tmp/chest test/chest-ladder-actions.js
// 1. Two-storey village houses (house2) have a ladder column up through the hatch, and the player can climb it to the upper floor.
// 2. Chests open on right-click, hold 27 slots, shift-click moves stacks in and out, survive save/load and spill when broken.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; });
  // find a two-storey house in a village near the origin
  const house = await pg.evaluate(() => {
    for (const v of BF.worldgen.villagesNear(0, 0, 3000).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))) {
      const b = v.buildings.find(b => b.type === "house2");
      if (!b) continue;
      const at = (u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
      const lu = b.w >> 1, [lx, lz] = at(lu, b.d - 2), [cx, cz] = at(1, b.d - 2), [dx, dz] = at(b.du, 1);
      return { v: [v.x, v.z], y: b.y, lx, lz, cx, cz, dx, dz, back: [b.sx, b.sz] };
    }
    return null;
  });
  console.log("house2:", JSON.stringify(house));
  if (!house) throw new Error("no house2 found");
  await pg.evaluate(h => BF.player.spawn(h.dx + 0.5, h.y + 1.01, h.dz + 0.5), house);
  await pg.waitForTimeout(9000);
  const blocks = await pg.evaluate(h => {
    const W = BF.world, name = id => BF.blocks[id] ? BF.blocks[id].name : id;
    const col = [];
    for (let k = 0; k <= 7; k++) col.push(name(W.getBlock(h.lx, h.y + k, h.lz)));
    const wall = []; for (let k = 1; k <= 5; k++) wall.push(BF.ladderSupport(W.getBlock(h.lx + h.back[0], h.y + k, h.lz + h.back[1])));
    return { col, wallSupports: wall, upperChest: name(W.getBlock(h.cx, h.y + 5, h.cz)) };
  }, house);
  console.log("ladder column y+0..7:", blocks.col.join(" "));
  console.log("back wall supports ladder y+1..5:", blocks.wallSupports.join(" "), "| upper floor chest:", blocks.upperChest);

  // a look at the ladder from the doorway
  await pg.evaluate(h => {
    const e = BF.player.eyePos(), tx = h.lx + 0.5 - e.x, ty = h.y + 3.5 - e.y, tz = h.lz + 0.5 - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
  }, house);
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + '-ladder.png' });
  // climb: stand in the ladder cell facing the wall and hold W
  await pg.evaluate(h => {
    BF.player.teleport(h.lx + 0.5, h.y + 1.01, h.lz + 0.5);
    BF.player.setLook(Math.atan2(-h.back[0], -h.back[1]), 0);
  }, house);
  await pg.waitForTimeout(400);
  // headless frames are slow, so step the player physics by hand at 20 fps while the keys are held
  const steps = n => pg.evaluate(n => { let top = -1e9; for (let i = 0; i < n; i++) { BF.player.update(0.05); top = Math.max(top, BF.player.position.y); } return top; }, n);
  await pg.keyboard.down('KeyW');
  const top = await steps(60);
  // still holding W (pushing at the wall above the hatch), step sideways onto the upper floor
  await pg.keyboard.down('KeyD'); await steps(10); await pg.keyboard.up('KeyD'); await pg.keyboard.up('KeyW');
  await steps(20);
  const after = await pg.evaluate(() => BF.player.position.y), where = await pg.evaluate(h => { const p = BF.player.position; return [Math.floor(p.x) - h.lx, Math.floor(p.z) - h.lz, BF.blocks[BF.world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z))].name]; }, house);
  console.log('stepped off to offset', JSON.stringify(where));
  console.log(`climb: start y ${house.y + 1}, highest feet y ${top.toFixed(2)}, after stepping off ${after.toFixed(2)} (upper floor stands at ${house.y + 5})`);
  await pg.screenshot({ path: out + '-upstairs.png' });

  // chest: look at the upper floor chest and right-click it
  await pg.evaluate(h => {
    BF.player.teleport(h.cx + 0.5 + h.back[0] * -1.5, h.y + 5.01, h.cz + 0.5 + h.back[1] * -1.5);
    const e = BF.player.eyePos(), tx = h.cx + 0.5 - e.x, ty = h.y + 5.5 - e.y, tz = h.cz + 0.5 - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
  }, house);
  await pg.waitForTimeout(300);
  const r = await pg.evaluate(async h => {
    const I = BF.inventory, r = {};
    I.clear(); I.add(BF.I.cobblestone, 40); I.add(BF.I.oak_log, 5); I.add(BF.I.bread, 3);
    BF.player.setMouse(false, true); BF.player.setMouse(false, false);
    r.openedByRightClick = I.mode;
    return r;
  }, house);
  console.log("right-click opens:", r.openedByRightClick);
  // shift-click the cobblestone (hotbar slot 0) into the chest, then a plain click-move of the bread
  const slot = (c, i) => `.bf-slot[data-c="${c}"][data-i="${i}"]`;
  await pg.keyboard.down('Shift'); await pg.click(slot('inv', 0)); await pg.keyboard.up('Shift');
  await pg.click(slot('inv', 2)); await pg.click(slot('chest', 13));
  await pg.screenshot({ path: out + '-chest.png' });
  const r2 = await pg.evaluate(h => {
    const I = BF.inventory, c = I.chestState(h.cx, h.y + 5, h.cz), sum = id => c.slots.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);
    return { cobbleInChest: sum(BF.I.cobblestone), breadInChest: sum(BF.I.bread), breadSlot13: c.slots[13] && c.slots[13].count, cobbleInInv: I.count(BF.I.cobblestone) };
  }, house);
  console.log("after moving in:", JSON.stringify(r2));
  // shift-click cobble back out, keep the bread, close, save/load round trip, then break the chest
  await pg.keyboard.down('Shift'); await pg.click(slot('chest', 0)); await pg.keyboard.up('Shift');
  const r3 = await pg.evaluate(h => {
    const I = BF.inventory, r = {};
    r.cobbleBackInInv = I.count(BF.I.cobblestone);
    I.close();
    I.chestAdd(h.cx, h.y + 5, h.cz, BF.I.diamond, 70);
    const saved = JSON.parse(JSON.stringify(I.serialize()));
    r.savedChests = saved.chests.length;
    I.chests.clear(); I.deserialize(saved);
    const c = I.chestState(h.cx, h.y + 5, h.cz);
    r.afterLoad = c ? c.slots.filter(Boolean).map(s => BF.itemName(s.id) + " x" + s.count).join(", ") : null;
    const before = BF.drops.list.length;
    BF.world.setBlock(h.cx, h.y + 5, h.cz, 0);
    r.dropsSpilled = BF.drops.list.length - before;
    r.chestGone = !I.chestState(h.cx, h.y + 5, h.cz);
    return r;
  }, house);
  console.log("round trip:", JSON.stringify(r3));
};
