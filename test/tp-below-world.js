// /tp refuses a y below the world (it's solid bedrock down there, so you'd be stuck for good), and a player who
// is below the world anyway (an older save) is lifted to the surface when the chunk loads.
// node test/run.js /tmp/tb test/tp-below-world.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(2500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const r = await pg.evaluate(() => ["/tp ~ -100 ~", "/tp ~ " + (BF.MIN_Y - 1) + " ~"].map(c => [c, BF.commands.execute(c), BF.player.position.y > BF.MIN_Y]));
  for (const [c, res, above] of r) check(!res.ok && /y must be between/.test(res.msg) && above, `${c} refused (${res.msg})`);
  // /tp into the bedrock floor: allowed, but you're lifted out rather than stuck; an open spot down there is kept
  // a column by the spawn (generator 3 used 8, 8; on the planet that is a face corner's margin), typed relative to the player
  const col = await pg.evaluate(() => ({ x: Math.floor(BF.player.position.x), z: Math.floor(BF.player.position.z) }));
  const floor = await pg.evaluate(async ({ x, z }) => {
    const W = BF.world, r = BF.commands.execute("/tp " + BFT.at(x + 0.5, BF.MIN_Y, z + 0.5));
    await new Promise(r => setTimeout(r, 2000));
    const y1 = BF.player.position.y;
    for (let dy = 1; dy < 4; dy++) W.setBlock(x, BF.MIN_Y + dy, z, 0);
    BF.commands.execute("/tp " + BFT.at(x + 0.5, BF.MIN_Y + 1, z + 0.5));
    await new Promise(r => setTimeout(r, 2000));
    return { ok: r.ok, y1, y2: BF.player.position.y, surface: W.heightAt(x, z), minY: BF.MIN_Y };
  }, col);
  check(floor.ok && floor.y1 > floor.surface, `/tp into the bedrock floor lifts you to the surface (y ${floor.y1.toFixed(2)})`);
  check(Math.abs(floor.y2 - (floor.minY + 1)) < 0.5, `/tp into an open spot at the bottom stays there (y ${floor.y2.toFixed(2)})`);
  // an older save with the player below the world
  const y = await pg.evaluate(async ({ x, z }) => {
    BF.player.deserialize({ x: x + 0.5, y: -100, z: z + 0.5, health: 20 });
    await new Promise(r => setTimeout(r, 2500));
    return { y: BF.player.position.y, surface: BF.world.heightAt(x, z) };
  }, col);
  check(y.y > y.surface, `a saved position below the world loads on the surface (y ${y.y.toFixed(2)}, surface ${y.surface})`);
  console.log(bad ? "FAIL tp-below-world" : "PASS tp-below-world");
};
