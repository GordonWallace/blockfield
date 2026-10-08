// Held view model: node test/run.js /tmp/hi test/held-items.js
// A held grass block's top is biome-tinted (not grey), and flowers, saplings and torches are flat sprites, not cubes.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const hold = async name => {
    await pg.evaluate(n => { const inv = BF.inventory; inv.clear(); inv.add(BF.I[n], 1); inv.select(0); BF.player.setLook(-0.3, 0); }, name);
    await pg.waitForTimeout(400);
    return pg.evaluate(() => BF.player.viewModel());
  };
  const fails = [], res = {};
  const names = await pg.evaluate(ns => ns.filter(n => BF.I[n] != null), ["grass", "oak_leaves", "stone", "dandelion", "poppy", "oak_sapling", "torch", "ladder", "short_grass"]);
  for (const n of names) {
    res[n] = await hold(n);
    if (n === "grass") {
      await pg.evaluate(() => BF.player.setLook(-0.3, -0.9));
      await pg.waitForTimeout(400);
      await pg.screenshot({ path: out + '-grass.png' });
    }
    if (n === "dandelion") await pg.screenshot({ path: out + '-dandelion.png' });
  }
  const g = res.grass, l = res.oak_leaves;
  if (!g || g.kind !== "cube" || !g.top || !(g.top[1] > g.top[2] + 0.1)) fails.push("grass top not tinted: " + JSON.stringify(g));
  if (g && g.faces !== 10) fails.push("grass sides not dirt + tinted overlay: " + JSON.stringify(g));
  if (l && (!l.top || !(l.top[1] > l.top[2] + 0.1))) fails.push("leaves top not tinted: " + JSON.stringify(l));
  if (!res.stone || res.stone.kind !== "cube" || res.stone.top.some(v => Math.abs(v - 1) > 1e-6)) fails.push("stone not an untinted cube: " + JSON.stringify(res.stone));
  for (const n of ["dandelion", "poppy", "oak_sapling", "torch", "ladder", "short_grass"]) if (res[n] && res[n].kind !== "sprite") fails.push(n + " not flat: " + JSON.stringify(res[n]));
  console.log(JSON.stringify(res));
  console.log(fails.length ? "FAIL held-items: " + fails.join("; ") : "HELD-ITEMS OK");
};
