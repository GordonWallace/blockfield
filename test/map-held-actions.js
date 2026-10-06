// Held map tilt: node test/run.js /tmp/mh test/map-held-actions.js (screenshots looking ahead and looking down)
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  await pg.evaluate(() => {
    const I = BF.I, inv = BF.inventory, p = BF.player.position;
    inv.clear(); inv.add(I.blank_map_1, 1); inv.select(0);
    BF.maps.use(inv.selected(), BF.items[inv.selected().id]);
    BF.player.setLook(-0.8, 0);
  });
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: out + '-ahead.png' });
  await pg.evaluate(() => BF.player.setLook(-0.8, -0.83));
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + '-down.png' });
};
