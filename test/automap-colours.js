// Ground vs biome colours on the auto map and the toggle button: node test/run.js /tmp/ac test/automap-colours.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  await pg.evaluate(() => {
    BF.player.gameMode = "creative"; const inv = BF.inventory; inv.clear(); inv.add(BF.I.auto_map, 1); inv.select(0);
    BF.mapview.use(inv.selected(), BF.items[inv.selected().id]);
    document.querySelector('.bfm-in').value = "4096";
    document.querySelector('.bfm-wrap.open [data-a="ok"]').click();
    BF.mapview.finish(BF.mapview.dataOfItem(BF.items[BF.inventory.selected().id]));
    const s = BF.inventory.selected(); BF.mapview.use(s, BF.items[s.id]);
  });
  await pg.waitForTimeout(600);
  console.log("mode:", await pg.evaluate(() => BF.mapview.colourMode()), "button:", await pg.textContent('[data-a="col"]'));
  await pg.screenshot({ path: out + '-ground.png' });
  await pg.click('[data-a="col"]');
  await pg.waitForTimeout(400);
  console.log("mode:", await pg.evaluate(() => BF.mapview.colourMode()), "button:", await pg.textContent('[data-a="col"]'));
  await pg.screenshot({ path: out + '-biome.png' });
  await pg.click('[data-a="col"]');   // back to the default
  await pg.keyboard.press('Escape');
};
