// Shared test helpers. toVillage: moves the player into the village nearest to where they are (spawn, on a fresh planet; mile-high
// worlds usually don't start next to one) and waits for it to load. On a generator 3 world it keeps measuring from 0,0, as before.
exports.toVillage = async pg => {
  await pg.evaluate(() => {
    const p = BF.planet.isPlanet() ? BF.player.position : { x: 0, z: 0 }, v = BF.worldgen.nearestVillage(p.x, p.z);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  });
  await pg.waitForTimeout(9000);
};
