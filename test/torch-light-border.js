// Torch light crosses a chunk border above the neighbour's loaded height (bug-014):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/tlb test/torch-light-border.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); });
  await pg.waitForTimeout(4000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const r = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position;
    const ax = Math.floor(p.x / 16) * 16 + 15, z = Math.floor(p.z) + 2;
    const A = W.chunkAt(ax, z), B = W.chunkAt(ax + 1, z);
    const y = Math.max(A.y1, B.y1) + 2;          // above both chunks' loaded bands, like the 2nd floor of a tall build
    W.setBlock(ax, y - 1, z, BF.B.stone);
    W.setBlock(ax, y, z, BF.B.torch);
    const r = { y, torch: W.getBlockLight(ax, y, z), across2: W.getBlockLight(ax + 2, y, z), inside2: W.getBlockLight(ax - 2, y, z) };
    W.setBlock(ax + 3, y, z, BF.B.stone);         // a wall built later across the border
    r.frontOfWall = W.getBlockLight(ax + 2, y, z);
    r.beside = W.getBlockLight(ax + 1, y, z);
    W.setBlock(ax, y, z, BF.B.air);               // removing the torch clears it again on both sides
    r.afterRemove = [W.getBlockLight(ax + 1, y, z), W.getBlockLight(ax - 1, y, z)];
    return r;
  });
  console.log(JSON.stringify(r));
  check(r.torch === 14 && r.inside2 === 12, "torch lights its own chunk");
  check(r.across2 === 12, "light reaches 2 blocks into the next chunk (12)");
  check(r.frontOfWall === 12 && r.beside === 13, "a wall built later across the border is lit");
  check(r.afterRemove[0] === 0 && r.afterRemove[1] === 0, "breaking the torch darkens both sides");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
