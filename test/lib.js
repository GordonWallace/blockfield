// Shared test helpers. toVillage: moves the player into the village nearest to where they are (spawn, on a fresh planet; mile-high
// worlds usually don't start next to one) and waits for it to load. On a generator 3 world it keeps measuring from 0,0, as before.
exports.toVillage = async pg => {
  const planet = await pg.evaluate(() => {
    const P = BF.planet, p = BF.player.position, on = !!(P && P.isPlanet());
    // the planet: (0, 0) is off the atlas, so the village nearest the player (spawn), within 6 km round the planet
    const v = on ? BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0] : BF.worldgen.nearestVillage(0, 0);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    return on;
  });
  await pg.waitForTimeout(9000);
  // the planet's chunks take longer to generate: wait (up to 40 s more) for the village's villagers to be out
  for (let i = 0; planet && i < 40; i++) {
    if (await pg.evaluate(() => { const r = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); return !!(r && r.members && r.members.some(m => m.type === "villager")); })) break;
    await pg.waitForTimeout(1000);
  }
};
