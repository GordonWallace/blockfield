// Shared test helpers. toVillage: moves the player into the nearest village (mile-high worlds usually don't start next to one) and waits for it to load.
exports.toVillage = async pg => {
  await pg.evaluate(() => {
    const v = BF.worldgen.nearestVillage(0, 0);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  });
  await pg.waitForTimeout(9000);
};
