// Auto map through the real input path (keyboard + mouse events, no helpers): creative search, then right click with the item in hand.
// node test/run.js /tmp/ai test/automap-input.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  await pg.evaluate(() => { BF.player.gameMode = "creative"; BF.inventory.clear(); });
  await pg.mouse.click(640, 380);                       // captures the mouse (or falls back to drag mode when pointer lock is unavailable)
  await pg.waitForTimeout(300);
  await pg.keyboard.press('e');                         // creative menu
  await pg.waitForTimeout(500);
  console.log("menu open:", await pg.evaluate(() => BF.inventory.isOpen()));
  await pg.click('.bf-tab[data-tab="search"]');
  for (const q of ["auto", "auto map", "autofill", "auto-fill", "auto fill", "autofill map", "map", "creative", "Auto-Fill Map"]) {
    await pg.fill('.bf-search', q);
    const names = await pg.evaluate(() => [...document.querySelectorAll('.bf-pal .bf-slot')].filter(s => { const i = s.querySelector('img'); return i && i.getAttribute('src'); }).map(s => s.getAttribute('title') || s.getAttribute('aria-label') || s.dataset.name || 'item'));
    console.log("search", JSON.stringify(q), "->", names.length, JSON.stringify(names.slice(0, 12)));
  }
  await pg.fill('.bf-search', 'auto map');
  await pg.screenshot({ path: out + '-search.png' });
  // click the result into the hotbar
  const slot = pg.locator('.bf-pal .bf-slot').first();
  console.log("slots in palette:", await pg.locator('.bf-pal .bf-slot').count());
  await slot.click();
  console.log("hand after click:", await pg.evaluate(() => JSON.stringify(BF.inventory.slots.filter(Boolean).map(s => [BF.items[s.id].name, s.count]))));
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  console.log("menu open after esc:", await pg.evaluate(() => BF.inventory.isOpen()));
  await pg.evaluate(() => { const i = BF.inventory.slots.findIndex(s => s && BF.items[s.id].name === 'auto_map'); if (i >= 0) BF.inventory.select(i); });
  console.log("selected:", await pg.evaluate(() => { const s = BF.inventory.selected(); return s ? BF.items[s.id].name : null; }));
  await pg.mouse.click(640, 380);
  await pg.mouse.click(640, 380, { button: 'right' });
  await pg.waitForTimeout(400);
  console.log("pointer locked:", await pg.evaluate(() => BF.player.isLocked()));
  console.log("prompt open after real right click:", await pg.evaluate(() => [BF.mapview.isOpen(), !!document.querySelector('.bfm-wrap.open')]));
  await pg.screenshot({ path: out + '-rightclick.png' });
  await pg.keyboard.type('2000');
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(500);
  console.log("after Enter:", await pg.evaluate(() => { const s = BF.inventory.selected(); return [s && BF.items[s.id].name, BF.mapview.isOpen()]; }));
  // give through the real chat command line, then right click again
  await pg.keyboard.press('t');
  await pg.keyboard.type('/give auto_map');
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(300);
  console.log("inventory:", await pg.evaluate(() => JSON.stringify(BF.inventory.slots.map(s => s && [BF.items[s.id].name, s.count]).filter(Boolean))));
  await pg.evaluate(() => { const i = BF.inventory.slots.findIndex(s => s && BF.items[s.id].name === 'auto_map'); BF.inventory.select(i); });
  await pg.mouse.click(640, 380, { button: 'right' });
  await pg.waitForTimeout(300);
  console.log("prompt after /give + right click:", await pg.evaluate(() => BF.mapview.isOpen()));
};
