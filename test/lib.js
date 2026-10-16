// Shared test helpers. toVillage: moves the player into the village nearest to where they are (spawn, on a fresh planet; mile-high
// worlds usually don't start next to one) and waits for it to load. On a generator 3 world it keeps measuring from 0,0, as before.
exports.toVillage = async pg => {
  await exports.ready(pg);
  const key = await pg.evaluate(() => {
    const p = BF.planet.isPlanet() ? BF.player.position : { x: 0, z: 0 }, v = BF.worldgen.nearestVillage(p.x, p.z);
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    return Math.round(v.x) + "," + Math.round(v.z);
  });
  await pg.waitForTimeout(9000);
  // a loaded machine (or a slow planet frame) can take longer to bring the villagers out: wait for them, up to a minute more
  await pg.waitForFunction(k => { const r = BF.mobs.villages && BF.mobs.villages.get(k); return !!(r && r.members.some(m => m.type === "villager" && !m.dead)); }, key, { timeout: 60000, polling: 500 }).catch(() => {});
};
// ready: waits until a planet's river step (spec r14-10) is done, after a boot or a newWorld on a new seed.
exports.ready = pg => pg.waitForFunction(() => window.BF && !BF.preparing, null, { timeout: 180000, polling: 200 });
// install: puts window.BFT (test/bft.js, the in-page test helpers) into a page a node test made; call it before the page's goto.
exports.install = pg => pg.addInitScript({ path: require('path').join(__dirname, 'bft.js') });
