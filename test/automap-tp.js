// Click-to-select and Teleport on the full-screen map: node test/run.js /tmp/at test/automap-tp.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const open = (w) => pg.evaluate(w => {
    BF.player.gameMode = "creative"; const inv = BF.inventory; inv.clear(); inv.add(BF.I.auto_map, 1); inv.select(0);
    BF.mapview.use(inv.selected(), BF.items[inv.selected().id]);
    document.querySelector('.bfm-in').value = String(w);
    document.querySelector('.bfm-wrap.open [data-a="ok"]').click();
    BF.mapview.finish(BF.mapview.dataOfItem(BF.items[BF.inventory.selected().id]));
    const s = BF.inventory.selected(); BF.mapview.use(s, BF.items[s.id]);
  }, w);
  await open(8192);
  await pg.waitForTimeout(500);
  const box = await pg.locator('.bfm-board canvas').boundingBox();
  console.log("tp button visible/disabled before click:", await pg.evaluate(() => { const b = document.querySelector('[data-a="tp"]'); return [!b.hidden, b.disabled]; }));
  await pg.mouse.click(box.x + box.width * 0.82, box.y + box.height * 0.72);
  await pg.waitForTimeout(300);
  console.log("selection:", await pg.evaluate(() => JSON.stringify(BF.mapview._view.sel)), "disabled after:", await pg.evaluate(() => document.querySelector('[data-a="tp"]').disabled));
  await pg.screenshot({ path: out + '-selected.png' });
  const want = await pg.evaluate(() => BF.mapview._view.sel);
  await pg.click('[data-a="tp"]');
  await pg.waitForTimeout(600);
  console.log("view closed:", await pg.evaluate(() => !BF.mapview.isOpen()));
  await pg.waitForTimeout(4000);
  const pos = await pg.evaluate(() => { const p = BF.player.position; return { x: p.x, y: p.y, z: p.z, loaded: BF.world.isLoaded(p.x, p.z), h: BF.world.heightAt(Math.floor(p.x), Math.floor(p.z)), biome: BF.worldgen.biomeAt(Math.floor(p.x), Math.floor(p.z)).name }; });
  console.log("wanted", JSON.stringify(want), "now", JSON.stringify(pos));
  await pg.screenshot({ path: out + '-arrived.png' });
  // survival: no button
  await pg.evaluate(() => { BF.player.gameMode = "survival"; const inv = BF.inventory; const s = inv.selected(); BF.mapview.use(s, BF.items[s.id]); });
  console.log("survival: button hidden:", await pg.evaluate(() => document.querySelector('[data-a="tp"]').hidden));
  await pg.keyboard.press('Escape');
};
