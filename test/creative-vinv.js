// @ci integration hosts=worker,server
// Creative mode: the villager inventory on the trade screen is editable. node test/run.js /tmp/cv test/creative-vinv.js
module.exports = async (pg, out) => {
  const lib = require('./lib');
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await lib.sim(pg, () => BF.sky.setTime(0.2));   // (where the simulation is: spec r15-43)
  await lib.toVillage(pg);
  const box = sel => pg.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  const click = async (x, y) => { await pg.mouse.click(x, y); await settle(); };
  // talking to a villager (in the simulation) opens its trade screen on the page
  const talk = async () => {
    await lib.sim(pg, () => { BF.mobs.interact(globalThis.__cvV); BF.proto.flush(); });
    await settle();
    await pg.waitForFunction(() => BF.inventory.mode === "trade" && document.querySelector('.bf-vgrid .bf-slot[data-i="1"]'), null, { timeout: 15000, polling: 100 });
    await settle();
  };
  const r = {};
  await lib.sim(pg, () => {
    BF.mobs.spawning = false;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.child && m.profession !== "builder");
    v.sleeping = false; globalThis.__cvV = v;
    BF.inventory.clear(); BF.inventory.add(BF.I.diamond, 5);
  });
  await talk();
  const vname = () => settle().then(() => lib.sim(pg, () => globalThis.__cvV.inv.map(s => s ? BF.items[s.id].name + "x" + s.count : "-").slice(0, 6).join(" ")));
  r.before = await vname();
  r.grey = await pg.evaluate(() => getComputedStyle(document.querySelector('.bf-vgrid .bf-slot')).opacity);
  let [x, y] = await box('.bf-vgrid .bf-slot[data-i="0"]'); await click(x, y);          // pick up the villager's first stack
  [x, y] = await box('.bf-slot[data-c="inv"][data-i="20"]'); await click(x, y);       // drop it in the player's inventory
  r.afterTake = await vname();
  r.playerHas = await lib.sim(pg, () => BF.inventory.serialize().slots[20]);
  [x, y] = await box('.bf-slot[data-c="inv"][data-i="0"]');
  await pg.keyboard.down('Shift'); await click(x, y); await pg.keyboard.up('Shift');  // shift-click diamonds to the villager
  r.afterGive = await vname();
  await pg.screenshot({ path: out + '-creative.png' });
  await pg.evaluate(() => { BF.inventory.close(); BF.player.gameMode = "survival"; });
  await pg.waitForTimeout(500); await settle();   // (the game mode reaches the simulation in the player's messages)
  await talk();
  r.survivalGrey = await pg.evaluate(() => getComputedStyle(document.querySelector('.bf-vgrid .bf-slot')).opacity);
  [x, y] = await box('.bf-vgrid .bf-slot[data-i="1"]'); const b = await vname(); await click(x, y);
  r.survivalLocked = (await vname()) === b;
  await lib.sim(pg, () => { delete globalThis.__cvV; });
  console.log(JSON.stringify(r, null, 1));
};
