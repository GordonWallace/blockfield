// @ci integration hosts=worker,server
// Wide auto maps: node test/run.js /tmp/ab test/automap-big.js [--host page|worker|server]  (65536-block and 2048-block maps, held + full screen)
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  for (const [w, tag] of [[65536, "w65536"], [2048, "w2048"]]) {
    await pg.evaluate(() => { BF.player.gameMode = "creative"; });
    await lib.give(pg, ['auto_map']);   // (the items are where the simulation is, spec r15-43)
    await pg.evaluate(() => { const inv = BF.inventory; BF.mapview.use(inv.selected(), BF.items[inv.selected().id]); });
    await pg.fill('.bfm-in', String(w));
    console.log(tag, "hint:", await pg.evaluate(() => document.querySelector('.bfm-wrap.open .bfm-info').textContent));
    await pg.keyboard.press('Enter');
    await pg.waitForFunction(() => { const s = BF.inventory.selected(); return s && BF.items[s.id].auto; }, null, { timeout: 20000 });   // (made by a player request)
    await pg.evaluate(() => BF.mapview.finish(BF.mapview.dataOfItem(BF.items[BF.inventory.selected().id])));
    await pg.evaluate(() => BF.player.setLook(-0.8, -0.83));
    await pg.waitForTimeout(600);
    await pg.screenshot({ path: out + '-' + tag + '-held.png' });
    await pg.evaluate(() => { const s = BF.inventory.selected(); BF.mapview.use(s, BF.items[s.id]); });
    await pg.mouse.move(640, 380);
    await pg.waitForTimeout(700);
    await pg.screenshot({ path: out + '-' + tag + '-full.png' });
    await pg.keyboard.press('Escape');
  }
};
