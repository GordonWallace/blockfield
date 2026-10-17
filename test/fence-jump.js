// Fences and closed fence gates collide 1.5 blocks tall, so a running jump can't clear them; an open gate still lets you through,
// and you can still stand on a fence top (bug-011).
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const run = async (block) => {
    const r = await pg.evaluate((block) => {
      BF.mobs.spawning = false;
      const W = BF.world, p = BF.player.position;
      const X = Math.floor(p.x), Z = Math.floor(p.z), gy = W.heightAt(X, Z);
      for (let dx = -4; dx <= 4; dx++) for (let dz = -6; dz <= 6; dz++) { W.setBlock(X + dx, gy, Z + dz, BF.B.stone); for (let k = 1; k <= 4; k++) W.setBlock(X + dx, gy + k, Z + dz, 0); }
      for (let dx = -4; dx <= 4; dx++) W.setBlock(X + dx, gy + 1, Z - 2, BF.B[block]);   // a line across the path, north of the player
      BF.player.teleport(X + 0.5, gy + 1, Z + 0.5);
      for (let i = 0; i < 10; i++) BF.player.update(0.05);
      BF.player.setLook(0, 0);   // yaw 0 faces -z (north)
      return { X, Z, gy, set: W.getBlock(X, gy + 1, Z - 2) === BF.B[block] };
    }, block);
    await pg.keyboard.down('KeyW'); await pg.keyboard.down('Space');
    const end = await pg.evaluate(() => { let maxY = 0; for (let i = 0; i < 60; i++) { BF.player.update(0.05); maxY = Math.max(maxY, BF.player.position.y); } return { z: BF.player.position.z, maxY }; });
    await pg.keyboard.up('KeyW'); await pg.keyboard.up('Space');
    await pg.evaluate(() => { for (let i = 0; i < 20; i++) BF.player.update(0.05); });
    return { ...r, ...end };
  };
  const check = (ok, msg) => console.log((ok ? "PASS " : "FAIL ") + msg);
  for (const block of ["oak_fence", "spruce_fence", "oak_fence_gate_x"]) {
    const r = await run(block);
    check(r.set, `${block}: set up`);
    check(r.z > r.Z - 1.4, `${block}: jumping at it doesn't get over (z ${r.z.toFixed(2)}, fence at ${r.Z - 2})`);
    check(r.maxY - (r.gy + 1) < 1.45, `${block}: never stands on top while jumping (max height ${(r.maxY - r.gy - 1).toFixed(2)})`);
  }
  const open = await run("oak_fence_gate_x_open");
  check(open.z < open.Z - 3, `open gate: walks through (z ${open.z.toFixed(2)})`);
  // standing on a fence top: feet at 1.5 and you stay there
  const top = await pg.evaluate(({ X, Z, gy }) => {
    const W = BF.world;
    W.setBlock(X + 2, gy + 1, Z, BF.B.oak_fence);
    BF.player.teleport(X + 2.5, gy + 3.2, Z + 0.5);
    for (let i = 0; i < 40; i++) BF.player.update(0.05);
    return BF.player.position.y - (gy + 1);
  }, open);
  check(Math.abs(top - 1.5) < 0.05, `stands on a fence top at 1.5 (${top.toFixed(3)})`);
};
