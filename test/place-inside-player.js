// @ci integration suite=items
// No block can be placed inside the player, and an entity slightly inside a block can't walk through it (bug-015):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/pip test/place-inside-player.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const r = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const W = BF.world, p = BF.player.position;
    const X = Math.floor(p.x), Z = Math.floor(p.z), gy = W.heightAt(X, Z);
    for (let dx = -6; dx <= 6; dx++) for (let dz = -3; dz <= 3; dz++) { W.setBlock(X + dx, gy, Z + dz, BF.B.stone); for (let k = 1; k <= 4; k++) W.setBlock(X + dx, gy + k, Z + dz, 0); }
    BF.inventory.setSlot(0, { id: BF.B.cobblestone, count: 10 }); BF.inventory.select(0);
    const r = { X, gy };
    // 1. stand reaching 0.005 into the cell at x X-1 and try to place cobblestone there at feet height
    BF.player.teleport(X + 0.295, gy + 1, Z + 0.5);
    for (let i = 0; i < 5; i++) BF.player.update(0.05);
    const e = BF.player.eyePos(), tx = X - 1 + 0.5 - e.x, ty = gy + 1 - e.y, tz = Z + 0.5 - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
    BF.player.update(0.016);
    BF.player.setMouse(false, true); BF.player.setMouse(false, false);
    r.placed = W.getBlock(X - 1, gy + 1, Z);
    // 2. a block that ends up overlapping the player anyway (set directly) still stops a walk into it
    W.setBlock(X - 1, gy + 1, Z, BF.B.cobblestone);
    BF.player.teleport(X + 0.295, gy + 1, Z + 0.5);
    BF.player.setLook(Math.PI / 2, 0);            // facing -x
    return r;
  });
  console.log(JSON.stringify(r));
  const BF_COBBLE = await pg.evaluate(() => BF.B.cobblestone);
  check(r.placed === 0, "placing a block in a cell the player reaches into is refused");
  await pg.keyboard.down('KeyW');
  const into = await pg.evaluate(() => { const xs = []; for (let i = 0; i < 20; i++) { BF.player.update(0.05); xs.push(+BF.player.position.x.toFixed(3)); } return xs; });
  await pg.keyboard.up('KeyW');
  console.log("walking into it:", JSON.stringify(into));
  check(Math.min(...into) >= r.X + 0.29, "walking into a block the player is slightly inside is blocked");
  // 3. walking away from it still works
  await pg.evaluate(() => BF.player.setLook(-Math.PI / 2, 0));
  await pg.keyboard.down('KeyW');
  const away = await pg.evaluate(() => { const xs = []; for (let i = 0; i < 10; i++) { BF.player.update(0.05); xs.push(+BF.player.position.x.toFixed(3)); } return xs; });
  await pg.keyboard.up('KeyW');
  console.log("walking away:", JSON.stringify(away));
  check(away[away.length - 1] > r.X + 1, "walking out of the block works");
  // 4. normal play: standing flush against the next cell (as collision leaves you), placing there still works
  const flush = await pg.evaluate(() => {
    const W = BF.world, X = Math.floor(BF.player.position.x) - 1, gy = Math.floor(BF.player.position.y), Z = Math.floor(BF.player.position.z);
    BF.player.teleport(X + 0.3001, gy, Z + 0.5);
    BF.player.update(0.016);
    const e = BF.player.eyePos(), tx = X - 1 + 0.5 - e.x, ty = gy - e.y, tz = Z + 0.5 - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
    BF.player.update(0.016);
    BF.player.setMouse(false, true); BF.player.setMouse(false, false);
    return W.getBlock(X - 1, gy, Z);
  });
  check(flush === BF_COBBLE, "a block can still be placed right next to the player");
  // 5. grazing: a player slightly inside a block's side (0.005 in z) but well along it in x keeps walking along it
  const graze = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position;
    const X = Math.floor(p.x), Z = Math.floor(p.z), gy = Math.floor(p.y);
    for (let dx = -8; dx <= 8; dx++) for (let dz = -2; dz <= 2; dz++) { W.setBlock(X + dx, gy - 1, Z + dz, BF.B.stone); for (let k = 0; k <= 3; k++) W.setBlock(X + dx, gy + k, Z + dz, 0); }
    BF.player.teleport(X - 0.2, gy, Z + 1 - 0.295);           // body spans x X-0.5..X+0.1, z just 0.005 into row Z+1
    W.setBlock(X - 1, gy, Z + 1, BF.B.cobblestone);          // the block it is grazing (x X-1..X, row Z+1)
    BF.player.setLook(Math.PI / 2, 0);                        // facing -x, along the block's side
    return { X };
  });
  await pg.keyboard.down('KeyW');
  const along = await pg.evaluate(() => { const xs = []; for (let i = 0; i < 20; i++) { BF.player.update(0.05); xs.push(+BF.player.position.x.toFixed(3)); } return xs; });
  await pg.keyboard.up('KeyW');
  console.log("walking along a grazed block:", JSON.stringify(along));
  check(along[along.length - 1] < graze.X - 2, "walking along a block you graze still works");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
