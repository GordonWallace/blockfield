// Creative auto map + full-screen map view: node test/run.js /tmp/am test/automap-actions.js
// Creates a 2000-block auto map through the width prompt, lets it generate, and screenshots the held view and full-screen views (auto + normal map).
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  console.log("gen", await pg.evaluate(() => BF.state.gen));
  await pg.evaluate(() => { BF.player.gameMode = "creative"; const inv = BF.inventory; inv.clear(); inv.add(BF.I.auto_map, 1); inv.select(0); });
  console.log("in creative list:", await pg.evaluate(() => BF.inventory.creativeItems ? 'n/a' : 'n/a'));
  // right click path: the player calls mapview.use
  console.log("prompt opened:", await pg.evaluate(() => { const s = BF.inventory.selected(); return BF.mapview.use(s, BF.items[s.id]); }), await pg.evaluate(() => BF.mapview.isOpen()));
  await pg.fill('.bfm-in', '2000');
  console.log("hint:", await pg.evaluate(() => document.querySelector('.bfm-wrap.open .bfm-info').textContent));
  await pg.screenshot({ path: out + '-prompt.png' });
  await pg.keyboard.press('Enter');
  console.log("held:", await pg.evaluate(() => { const s = BF.inventory.selected(), it = BF.items[s.id]; return [it.name, it.label, JSON.stringify(it.auto), BF.mapview.isOpen()]; }));
  // generation timing: frame times while it runs
  const t = await pg.evaluate(async () => {
    const d = BF.mapview.dataOfItem(BF.items[BF.inventory.selected().id]);
    let worst = 0, last = performance.now(), frames = 0; const t0 = last;
    while (!d.done && performance.now() - t0 < 120000) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); worst = Math.max(worst, n - last); last = n; frames++; }
    return { done: d.done, ms: Math.round(performance.now() - t0), frames, worstFrame: Math.round(worst), N: d.N, scale: d.scale, side: d.side, x0: d.x0, z0: d.z0 };
  });
  console.log("generation", JSON.stringify(t));
  await pg.evaluate(() => BF.player.setLook(-0.8, -0.83));
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: out + '-held.png' });
  // full screen
  await pg.evaluate(() => { const s = BF.inventory.selected(); BF.mapview.use(s, BF.items[s.id]); });
  await pg.mouse.move(640, 380);
  await pg.waitForTimeout(500);
  await pg.screenshot({ path: out + '-full.png' });
  await pg.keyboard.press('Escape');
  console.log("closed:", await pg.evaluate(() => !BF.mapview.isOpen()));
  // normal map full screen
  await pg.evaluate(() => { const inv = BF.inventory; inv.clear(); inv.add(BF.I.blank_map_2, 1); inv.select(0); BF.maps.use(inv.selected(), BF.items[inv.selected().id]); BF.player.position.set(BF.player.position.x + 30, BF.player.position.y, BF.player.position.z + 20); });
  await pg.waitForTimeout(1500);
  await pg.evaluate(() => { const s = BF.inventory.selected(); BF.mapview.use(s, BF.items[s.id]); });
  await pg.mouse.move(600, 360);
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: out + '-normal.png' });
  await pg.keyboard.press('Escape');
  // survival: auto map can't be crafted; width rounding
  console.log("zonesFor:", await pg.evaluate(() => [100, 2000, 2047, 64, 1e9].map(w => BF.mapview.zonesFor(w))));
};
