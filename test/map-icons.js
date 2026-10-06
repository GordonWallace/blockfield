// Map item icons: node test/run.js /tmp/mi test/map-icons.js  (blank auto map, filled auto map thumbnail, normal map thumbnail, dropped map)
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  await pg.evaluate(() => {
    BF.player.gameMode = "creative"; const inv = BF.inventory; inv.clear();
    inv.add(BF.I.auto_map, 1); inv.add(BF.I.blank_map_1, 1); inv.add(BF.I.blank_map_2, 1); inv.add(BF.I.compass, 1);
    inv.select(1); BF.maps.use(inv.selected(), BF.items[inv.selected().id]);        // normal filled map in slot 1 (explored a little around the player)
    inv.select(0);
    BF.mapview.use(inv.selected(), BF.items[inv.selected().id]);
    document.querySelector('.bfm-in').value = '2048';
    document.querySelector('.bfm-wrap.open [data-a="ok"]').click();
  });
  await pg.waitForTimeout(1500);
  const clip = { x: 380, y: 690, width: 520, height: 70 };
  await pg.screenshot({ path: out + '-hotbar-early.png', clip });
  console.log("icons early:", await pg.evaluate(() => [...document.querySelectorAll('.bf-hotbar .bf-slot img')].slice(0, 4).map(i => (i.getAttribute('src') || '').length)));
  await pg.evaluate(() => BF.mapview.finish(BF.mapview.dataOfItem(BF.items[BF.inventory.selected().id])));
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: out + '-hotbar-done.png', clip });
  console.log("icons done:", await pg.evaluate(() => [...document.querySelectorAll('.bf-hotbar .bf-slot img')].slice(0, 4).map(i => (i.getAttribute('src') || '').length)));
  // creative menu with the blank auto map in the search results and the inventory row below
  await pg.mouse.click(640, 380);
  await pg.keyboard.press('e');
  await pg.waitForTimeout(500);
  await pg.click('.bf-tab[data-tab="search"]');
  await pg.fill('.bf-search', 'auto');
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: out + '-menu.png', clip: { x: 400, y: 180, width: 480, height: 400 } });
  await pg.keyboard.press('Escape');
  // a dropped filled map
  await pg.evaluate(() => { const p = BF.player.position, s = BF.inventory.selected(); BF.drops.spawn(s.id, 1, p.x + 1.2, p.y + 0.5, p.z - 2.2); BF.player.setLook(0, 0.15); });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + '-drop.png' });
};
