// @ci baseline
// Creative right and middle clicks on doors and chests use them; nothing picks the block (there is no pick block). node test/run.js /tmp/rc test/creative-rclick.js
// Gordon's Ubuntu trackpad sends some right clicks as middle clicks, which used to pick the block into his hotbar.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.mobs.spawning = false; });
  await pg.waitForTimeout(1500);
  const setup = () => pg.evaluate(() => {
    if (!window._t) { const p = BF.player.position; window._t = { x: Math.floor(p.x), z: Math.floor(p.z), y: Math.floor(p.y) + 3 }; }
    const { x, y, z } = window._t;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) { BF.world.setBlock(x + dx, y - 1, z + dz, BF.B.stone); for (let k = 0; k < 4; k++) BF.world.setBlock(x + dx, y + k, z + dz, 0); }
    BF.world.setBlock(x, y, z - 2, BF.doorId(0, 0, 0, "oak")); BF.world.setBlock(x, y + 1, z - 2, BF.doorId(0, 1, 0, "oak"));
    BF.world.setBlock(x + 2, y, z - 2, BF.B.chest);
    BF.player.teleport(x + 0.5, y + 0.01, z + 0.5);
    BF.inventory.clear(); BF.inventory.select(3);
  });
  const look = (bx, by, bz) => pg.evaluate(([bx, by, bz]) => {
    const e = BF.player.eyePos(), tx = bx - e.x, ty = by - e.y, tz = bz - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
  }, [bx, by, bz]);
  const state = () => pg.evaluate(() => {
    const d = BF.world.getBlock(_t.x, _t.y, _t.z - 2), s = { slots: BF.inventory.slots };
    return { door: !!(BF.blocks[d].door && BF.blocks[d].door.open), chest: BF.inventory.isOpen ? !!BF.inventory.isOpen() : BF.player.screenOpen(),
      hotbar: s.slots.slice(0, 9).filter(Boolean).map(x => (BF.items[x.id] || BF.blocks[x.id]).name).join(",") };
  });
  // [label, mousedown fields, also send a context menu event, expect]
  const variants = [
    ["right (button 2)", { button: 2, buttons: 2 }, true, "use"],
    ["right with ctrl held", { button: 2, buttons: 2, ctrlKey: true }, true, "use"],
    ["button 1 holding only the right button", { button: 1, buttons: 2 }, false, "use"],
    ["middle (button 1, buttons 4)", { button: 1, buttons: 4 }, false, "use"],
  ];
  let fails = 0;
  for (const [label, init, ctx, want] of variants) {
    for (const what of ["door", "chest"]) {
      await setup(); await pg.waitForTimeout(1500);
      await pg.evaluate(w => window._aim = w, what);
      await pg.evaluate(() => { const { x, y, z } = _t; window._aimAt = _aim === "door" ? [x + 0.5, y + 0.8, z - 1.8] : [x + 2.5, y + 0.5, z - 1.5]; });
      const at = await pg.evaluate(() => _aimAt); await look(...at); await pg.waitForTimeout(300);
      await pg.evaluate(([init, ctx]) => {
        const cv = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        const o = Object.assign({ bubbles: true, cancelable: true, clientX: innerWidth / 2, clientY: innerHeight / 2 }, init);
        cv.dispatchEvent(new MouseEvent("mousedown", o));
        if (ctx) cv.dispatchEvent(new MouseEvent("contextmenu", o));
        window.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0 })));
      }, [init, ctx]);
      await pg.waitForTimeout(500);
      const s = await state();
      const used = what === "door" ? s.door : s.chest, picked = /door|chest/.test(s.hotbar);
      const ok = used && !picked;
      if (!ok) fails++;
      console.log(`${ok ? "ok  " : "FAIL"} ${label} on the ${what}: ${used ? "used" : "not used"}, hotbar [${s.hotbar}] (want ${want})`);
      await pg.evaluate(() => { try { BF.inventory.close(); } catch (_) {} });
    }
  }
  await pg.keyboard.press('F3'); await pg.waitForTimeout(300);
  const f3 = await pg.evaluate(() => document.getElementById('debug').textContent);
  await pg.keyboard.press('F3');
  const m = f3.slice(f3.indexOf("Mouse"));
  console.log(m.startsWith("Mouse") ? "ok   F3 shows the click log" : "FAIL F3 has no click log", "\n" + m);
  console.log(fails ? `FAIL ${fails} cases` : "all cases ok");
};
