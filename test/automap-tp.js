// Click-to-select and Teleport on the full-screen map: node test/run.js /tmp/at test/automap-tp.js
module.exports = async (pg, out) => {
  // a big map on the planet takes a while to make and draw: wait until the view is up and its buttons take clicks
  const settled = () => pg.waitForFunction(() => { const v = BF.mapview._view, b = document.querySelector('[data-a="col"]'); if (!v || !v.d || !b) return false;
    const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; }, null, { timeout: 120000, polling: 250 });
  // no pointer lock (the game's drag mode, as test/explorer-far.js): on the planet a big map takes long enough to make that the lock
  // is still held when the map opens, and the mouse clicks below never reach it
  await pg.evaluate(() => { document.getElementById("view").requestPointerLock = null; BF.player.start(); });
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
  await settled();
  const box = await pg.locator('.bfm-board canvas').boundingBox();
  console.log("tp button visible/disabled before click:", await pg.evaluate(() => { const b = document.querySelector('[data-a="tp"]'); return [!b.hidden, b.disabled]; }));
  await pg.mouse.click(box.x + box.width * 0.82, box.y + box.height * 0.72);
  await pg.waitForFunction(() => BF.mapview._view.sel, null, { timeout: 60000 }).catch(() => {});
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
