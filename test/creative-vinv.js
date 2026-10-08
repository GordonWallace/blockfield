// Creative mode: the villager inventory on the trade screen is editable. node test/run.js /tmp/cv test/creative-vinv.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const box = sel => pg.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  const r = {};
  await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.child && m.profession !== "builder");
    v.sleeping = false; window._v = v; BF.mobs.interact(v);
    BF.inventory.clear(); BF.inventory.add(BF.I.diamond, 5);
  });
  const vname = () => pg.evaluate(() => _v.inv.map(s => s ? BF.items[s.id].name + "x" + s.count : "-").slice(0, 6).join(" "));
  r.before = await vname();
  r.grey = await pg.evaluate(() => getComputedStyle(document.querySelector('.bf-vgrid .bf-slot')).opacity);
  let [x, y] = await box('.bf-vgrid .bf-slot[data-i="0"]'); await pg.mouse.click(x, y);          // pick up the villager's first stack
  [x, y] = await box('.bf-slot[data-c="inv"][data-i="20"]'); await pg.mouse.click(x, y);       // drop it in the player's inventory
  r.afterTake = await vname();
  r.playerHas = await pg.evaluate(() => BF.inventory.serialize().slots[20]);
  [x, y] = await box('.bf-slot[data-c="inv"][data-i="0"]');
  await pg.keyboard.down('Shift'); await pg.mouse.click(x, y); await pg.keyboard.up('Shift');  // shift-click diamonds to the villager
  r.afterGive = await vname();
  await pg.screenshot({ path: out + '-creative.png' });
  await pg.evaluate(() => { BF.inventory.close(); BF.player.gameMode = "survival"; BF.mobs.interact(_v); });
  r.survivalGrey = await pg.evaluate(() => getComputedStyle(document.querySelector('.bf-vgrid .bf-slot')).opacity);
  [x, y] = await box('.bf-vgrid .bf-slot[data-i="1"]'); const b = await vname(); await pg.mouse.click(x, y);
  r.survivalLocked = (await vname()) === b;
  console.log(JSON.stringify(r, null, 1));
};
