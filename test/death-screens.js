// @ci integration suite=ui hosts=worker,server
// Dying closes the map view and the sign editor (as it already closed the inventory), so after respawning E opens
// the inventory instead of typing into a sign.
// The map and the sign are made where the simulation is (lib.sim, spec r15-43); the screens, the death and the respawn are the page's.
// node test/run.js /tmp/ds test/death-screens.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const st = () => pg.evaluate(() => ({ map: BF.mapview.isOpen(), sign: BF.signs.isOpen(), inv: BF.inventory.isOpen(), dead: BF.player.dead, canOpenUI: BF.player.canOpenUI() }));
  const respawn = async () => { await pg.evaluate(() => document.querySelector('[data-act="respawn"]').click()); await pg.waitForTimeout(800); };
  // map view: a filled map in slot 1 (made in the simulation), opened on the page
  await pg.evaluate(() => BF.inventory.select(0));   // (the hotbar slot is the page's)
  await lib.sim(pg, () => {
    const I = BF.I, inv = BF.inventory;
    inv.clear(); inv.add(I.blank_map_1, 1);
    BF.maps.use(inv.slots[0], BF.items[inv.slots[0].id]);
    if (BF.proto) BF.proto.flush();
  });
  await pg.waitForFunction(() => { const s = BF.inventory.selected(); return s && BF.items[s.id].map; }, null, { timeout: 10000 }).catch(() => {});
  const opened = await pg.evaluate(() => {
    const inv = BF.inventory;
    return BF.mapview.open(BF.items[inv.selected().id]) !== false && BF.mapview.isOpen();
  });
  check(opened, "map view opened");
  await pg.evaluate(() => BF.player.kill()); await pg.waitForTimeout(300);
  let s = await st();
  check(s.dead && !s.map, "dying closes the map view " + JSON.stringify(s));
  await respawn();
  s = await st();
  check(!s.map && s.canOpenUI, "after respawn no screen is open " + JSON.stringify(s));
  // sign editor: the sign is placed and written in the simulation; its text reaches the page's copy, where the editor opens
  const sg = await pg.evaluate(() => { const p = BF.player.position; return [Math.floor(p.x) + 2, Math.floor(p.y), Math.floor(p.z)]; });
  await lib.sim(pg, ([x, y, z]) => {
    BF.world.setBlock(x, y, z, BF.signs.signId("oak", 0, 0));
    BF.signs.setText(x, y, z, "Hello");
    if (BF.proto) BF.proto.flush();
  }, sg);
  await pg.waitForFunction(c => { const g = BF.signs.get(...c); return g && g.text === "Hello"; }, sg, { timeout: 10000 }).catch(() => {});
  const signed = await pg.evaluate(c => BF.signs.openEditor(...c) && BF.signs.isOpen(), sg);
  check(signed, "sign editor opened");
  await pg.evaluate(() => BF.player.kill()); await pg.waitForTimeout(300);
  s = await st();
  check(s.dead && !s.sign, "dying closes the sign editor " + JSON.stringify(s));
  await respawn();
  await pg.keyboard.press("e"); await pg.waitForTimeout(300);
  s = await st();
  const text = await lib.sim(pg, c => { const g = BF.signs.get(...c); return g && g.text; }, sg);
  check(s.inv && !s.sign && text === "Hello", `after respawn E opens the inventory and the sign keeps its text (${JSON.stringify(text)}) ` + JSON.stringify(s));
  console.log(bad ? "FAIL death-screens" : "PASS death-screens");
};
