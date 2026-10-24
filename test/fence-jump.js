// Fences and closed fence gates collide 1.5 blocks tall, so a running jump can't clear them; an open gate still lets you through,
// and you can still stand on a fence top (bug-011).
// node test/run.js /tmp/fj test/fence-jump.js [--host page|worker|server]: the blocks are set where the simulation is (spec r15-43) and
// reach the page's world, where the player's body moves.
// @ci integration hosts=worker,server
const lib = require('./lib');
// the world's blocks: set where the simulation is, then waited for in the page's copy
const setBlocks = async (pg, list) => {
  await lib.sim(pg, list => { for (const [x, y, z, id] of list) BF.world.setBlock(x, y, z, id); BF.proto.flush(); }, list);
  await pg.waitForFunction(list => list.every(([x, y, z, id]) => BF.world.getBlock(x, y, z) === id), list, { timeout: 20000, polling: 100 });
};
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  await lib.sim(pg, () => { BF.mobs.spawning = false; });
  const run = async (block) => {
    const at = await pg.evaluate(() => { const p = BF.player.position, X = Math.floor(p.x), Z = Math.floor(p.z); return { X, Z, gy: BF.world.heightAt(X, Z) }; });
    const { X, Z, gy } = at, list = [], [stone, fence] = await pg.evaluate(b => [BF.B.stone, BF.B[b]], block);
    for (let dx = -4; dx <= 4; dx++) for (let dz = -6; dz <= 6; dz++) { list.push([X + dx, gy, Z + dz, stone]); for (let k = 1; k <= 4; k++) list.push([X + dx, gy + k, Z + dz, 0]); }
    for (let dx = -4; dx <= 4; dx++) { const i = list.findIndex(c => c[0] === X + dx && c[1] === gy + 1 && c[2] === Z - 2); list[i] = [X + dx, gy + 1, Z - 2, fence]; }   // a line across the path, north of the player
    await setBlocks(pg, list);
    const r = await pg.evaluate(({ block, X, Z, gy }) => {
      const W = BF.world;
      BF.player.teleport(X + 0.5, gy + 1, Z + 0.5);
      for (let i = 0; i < 10; i++) BF.player.update(0.05);
      BF.player.setLook(0, 0);   // yaw 0 faces -z (north)
      return { X, Z, gy, set: W.getBlock(X, gy + 1, Z - 2) === BF.B[block] };
    }, { block, X, Z, gy });
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
  await setBlocks(pg, [[open.X + 2, open.gy + 1, open.Z, await pg.evaluate(() => BF.B.oak_fence)]]);
  const top = await pg.evaluate(({ X, Z, gy }) => {
    BF.player.teleport(X + 2.5, gy + 3.2, Z + 0.5);
    for (let i = 0; i < 40; i++) BF.player.update(0.05);
    return BF.player.position.y - (gy + 1);
  }, open);
  check(Math.abs(top - 1.5) < 0.05, `stands on a fence top at 1.5 (${top.toFixed(3)})`);
};
