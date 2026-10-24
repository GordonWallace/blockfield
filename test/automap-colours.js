// @ci integration hosts=worker,server
// Ground vs biome colours on the auto map and the toggle button: node test/run.js /tmp/ac test/automap-colours.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg, out) => {
  // a big map on the planet takes a while to make and draw: wait until the view is up and its buttons take clicks
  const settled = () => pg.waitForFunction(() => { const v = BF.mapview._view, b = document.querySelector('[data-a="col"]'); if (!v || !v.d || !b) return false;
    const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; }, null, { timeout: 120000, polling: 250 });
  // no pointer lock (the game's drag mode, as test/explorer-far.js): on the planet a big map takes long enough to make that the lock
  // is still held when the map opens, and the mouse clicks below never reach it
  await pg.evaluate(() => { document.getElementById("view").requestPointerLock = null; BF.player.start(); });
  await pg.waitForTimeout(500);
  await pg.evaluate(() => { BF.player.gameMode = "creative"; });
  await lib.give(pg, ['auto_map']);   // (the items are where the simulation is, spec r15-43)
  await pg.evaluate(() => {
    const inv = BF.inventory;
    BF.mapview.use(inv.selected(), BF.items[inv.selected().id]);
    document.querySelector('.bfm-in').value = "4096";
    document.querySelector('.bfm-wrap.open [data-a="ok"]').click();
  });
  await pg.waitForFunction(() => { const s = BF.inventory.selected(); return s && BF.items[s.id].auto; }, null, { timeout: 20000 });   // (made by a player request)
  await pg.evaluate(() => {
    BF.mapview.finish(BF.mapview.dataOfItem(BF.items[BF.inventory.selected().id]));
    const s = BF.inventory.selected(); BF.mapview.use(s, BF.items[s.id]);
  });
  await settled();
  console.log("mode:", await pg.evaluate(() => BF.mapview.colourMode()), "button:", await pg.textContent('[data-a="col"]'));
  await pg.screenshot({ path: out + '-ground.png' });
  const m0 = await pg.evaluate(() => BF.mapview.colourMode());
  await pg.click('[data-a="col"]');
  await pg.waitForFunction(m => BF.mapview.colourMode() !== m, m0, { timeout: 60000 }).catch(() => {});
  console.log("mode:", await pg.evaluate(() => BF.mapview.colourMode()), "button:", await pg.textContent('[data-a="col"]'));
  await pg.screenshot({ path: out + '-biome.png' });
  await pg.click('[data-a="col"]');   // back to the default
  await pg.keyboard.press('Escape');
};
