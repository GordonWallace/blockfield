// @ci integration hosts=worker,server
// Held map tilt: node test/run.js /tmp/mh test/map-held-actions.js [--host page|worker|server] (screenshots looking ahead and looking down)
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  // (the map is made where the simulation is, spec r15-43)
  await lib.give(pg, ['blank_map_1']);
  await lib.sim(pg, () => { const inv = BF.inventory; BF.maps.use(inv.selected(), BF.items[inv.selected().id]); BF.proto.flush(); });
  await pg.waitForFunction(() => { const s = BF.inventory.selected(); return s && BF.items[s.id].map; }, null, { timeout: 20000 });
  await pg.evaluate(() => BF.player.setLook(-0.8, 0));
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: out + '-ahead.png' });
  await pg.evaluate(() => BF.player.setLook(-0.8, -0.83));
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + '-down.png' });
  console.log(JSON.stringify(await pg.evaluate(() => [1, 2, 3, 4, 5].map(n => [n, +BF.maps.revealBlocks(n).toFixed(1), +BF.maps.revealPx(n).toFixed(2)]))));
  // off the map: the arrow stays on the frame edge and still points the way the player faces
  await pg.evaluate(() => { BF.player.position.set(BF.player.position.x + 260, BF.player.position.y + 2, BF.player.position.z); BF.player.setLook(-0.8, -0.83); });
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: out + '-off.png' });
};
