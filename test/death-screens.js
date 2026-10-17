// Dying closes the map view and the sign editor (as it already closed the inventory), so after respawning E opens
// the inventory instead of typing into a sign.
// node test/run.js /tmp/ds test/death-screens.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const st = () => pg.evaluate(() => ({ map: BF.mapview.isOpen(), sign: BF.signs.isOpen(), inv: BF.inventory.isOpen(), dead: BF.player.dead, canOpenUI: BF.player.canOpenUI() }));
  const respawn = async () => { await pg.evaluate(() => document.querySelector('[data-act="respawn"]').click()); await pg.waitForTimeout(800); };
  // map view
  const opened = await pg.evaluate(() => {
    const I = BF.I, inv = BF.inventory;
    inv.clear(); inv.add(I.blank_map_1, 1); inv.select(0);
    BF.maps.use(inv.selected(), BF.items[inv.selected().id]);
    return BF.mapview.open(BF.items[inv.selected().id]) !== false && BF.mapview.isOpen();
  });
  check(opened, "map view opened");
  await pg.evaluate(() => BF.player.kill()); await pg.waitForTimeout(300);
  let s = await st();
  check(s.dead && !s.map, "dying closes the map view " + JSON.stringify(s));
  await respawn();
  s = await st();
  check(!s.map && s.canOpenUI, "after respawn no screen is open " + JSON.stringify(s));
  // sign editor
  const signed = await pg.evaluate(() => {
    const p = BF.player.position, x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z);
    BF.world.setBlock(x, y, z, BF.signs.signId("oak", 0, 0));
    BF.signs.setText(x, y, z, "Hello");
    window._sg = [x, y, z];
    return BF.signs.openEditor(x, y, z) && BF.signs.isOpen();
  });
  check(signed, "sign editor opened");
  await pg.evaluate(() => BF.player.kill()); await pg.waitForTimeout(300);
  s = await st();
  check(s.dead && !s.sign, "dying closes the sign editor " + JSON.stringify(s));
  await respawn();
  await pg.keyboard.press("e"); await pg.waitForTimeout(300);
  s = await st();
  const text = await pg.evaluate(() => BF.signs.get(...window._sg).text);
  check(s.inv && !s.sign && text === "Hello", `after respawn E opens the inventory and the sign keeps its text (${JSON.stringify(text)}) ` + JSON.stringify(s));
  console.log(bad ? "FAIL death-screens" : "PASS death-screens");
};
