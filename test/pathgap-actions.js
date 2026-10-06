// Path/farmland edge check: node test/run.js /tmp/pathgap test/pathgap-actions.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const base = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, B = BF.B;
    const x = Math.floor(p.x) + 6, z = Math.floor(p.z), y = W.heightAt(x, z) + 2;
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let k = -4; k < 8; k++) W.setBlock(x + dx, y + k, z + dz, k < -1 ? B.dirt : 0);
    // lower ground (grass) at y-2 for z<0, raised terrace (grass at y-2, path on top at y-1) for z>=0
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
      W.setBlock(x + dx, y - 2, z + dz, B.grass_block || B.grass);
      if (dz >= 0) { W.setBlock(x + dx, y - 1, z + dz, dx < 0 ? B.dirt_path : B.farmland); }
    }
    return { x, y, z };
  });
  const { x, y, z } = base;
  await pg.waitForTimeout(800);
  for (const [name, dx, dz, yaw] of [["a", -3, -2, Math.PI], ["b", 3, -2, Math.PI]]) {
    await pg.evaluate(([px, py, pz, yaw, pitch]) => { BF.player.position.set(px, py, pz); BF.player.yaw = yaw; BF.player.pitch = pitch; }, [x + dx, y - 1 + 0.1, z + dz, yaw, 0.0]);
    await pg.waitForTimeout(900);
    await pg.screenshot({ path: out + "-" + name + ".png" });
  }
  console.log(JSON.stringify(base));
};
