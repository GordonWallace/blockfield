// Shared test helpers. toVillage: moves the player into the village nearest to where they are (spawn, on a fresh planet) and waits
// for it to load.
exports.toVillage = async pg => {
  await exports.ready(pg);
  await pg.evaluate(() => {
    const P = BF.planet, p = BF.player.position;
    // (0, 0) is off the atlas, so the village nearest the player (spawn), within 6 km round the planet
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  });
  await pg.waitForTimeout(9000);
  // the planet's chunks take longer to generate: wait (up to 40 s more) for the village's villagers to be out
  for (let i = 0; i < 40; i++) {
    if (await pg.evaluate(() => { const r = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); return !!(r && r.members && r.members.some(m => m.type === "villager")); })) break;
    await pg.waitForTimeout(1000);
  }
};
// ready: waits until a planet's river step (spec r14-10) is done, after a boot or a newWorld on a new seed.
exports.ready = pg => pg.waitForFunction(() => window.BF && !BF.preparing, null, { timeout: 180000, polling: 200 });
// install: puts window.BFT (test/bft.js, the in-page test helpers) into a page a node test made; call it before the page's goto.
exports.install = pg => pg.addInitScript({ path: require('path').join(__dirname, 'bft.js') });
