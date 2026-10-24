// @ci integration hosts=worker,server
// Creative trashcan: click, right-click (one), drag-and-release, Del key and shift-click destroy items; survival has no trash. node test/run.js /tmp/trash test/creative-trash.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await require("./lib").sim(pg, () => { BF.mobs.spawning = false; });
  await pg.waitForTimeout(1000);
  let fails = 0;
  const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
  const lib = require("./lib");
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  // the items live where the simulation is (spec r15-43)
  const fill = () => lib.sim(pg, () => {
    BF.inventory.clear();
    for (let i = 0; i < 9; i++) BF.inventory.setSlot(i, { id: BF.B.stone, count: 64 });
    BF.inventory.setSlot(20, { id: BF.B.dirt, count: 10 });
    BF.proto.flush();
  }).then(settle);
  const st = () => settle().then(() => lib.sim(pg, () => ({ slots: BF.inventory.slots.map(s => s ? s.count : 0), cursor: BF.inventory.cursor ? BF.inventory.cursor.count : 0 })));
  const centre = sel => pg.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  const slot = i => `.bf-slot[data-c="inv"][data-i="${i}"]`, trash = '.bf-slot[data-c="trash"]';
  const click = async (sel, opts) => { const [x, y] = await centre(sel); await pg.mouse.move(x, y); await pg.mouse.down(opts); await pg.mouse.up(opts); await pg.waitForTimeout(80); await settle(); };
  const open = async () => { await pg.evaluate(() => BF.inventory.open("creative")); await pg.waitForTimeout(400); await settle(); };

  await fill(); await open();
  check(await pg.evaluate(() => { const t = document.querySelector('.bf-slot[data-c="trash"]'); return !!t && t.offsetWidth > 0 && getComputedStyle(t).backgroundImage.startsWith("url("); }), "trashcan shows in the creative screen with its icon");
  await click(slot(0)); await pg.screenshot({ path: out + "-armed.png" });
  check(await pg.evaluate(() => document.querySelector('.bf-slot[data-c="trash"]').classList.contains("armed")), "lid opens while an item is held");
  await click(trash);
  let s = await st(); check(s.slots[0] === 0 && s.cursor === 0, `click: held stack destroyed (slot0 ${s.slots[0]}, held ${s.cursor})`);
  await click(slot(1)); await click(trash, { button: "right" });
  s = await st(); check(s.cursor === 63, `right-click destroys one (held ${s.cursor})`);
  await click(slot(1));
  s = await st(); check(s.slots[1] === 63 && s.cursor === 0, `rest put back (slot1 ${s.slots[1]})`);
  { const [ax, ay] = await centre(slot(2)), [bx, by] = await centre(trash);
    await pg.mouse.move(ax, ay); await pg.mouse.down(); await pg.mouse.move((ax + bx) / 2, ay, { steps: 4 }); await pg.mouse.move(bx, by, { steps: 4 }); await pg.mouse.up(); await pg.waitForTimeout(80); }
  s = await st(); check(s.slots[2] === 0 && s.cursor === 0, `drag to trash destroys (slot2 ${s.slots[2]}, held ${s.cursor})`);
  { const [x, y] = await centre(slot(3)); await pg.mouse.move(x, y); await pg.keyboard.press("Delete"); await pg.waitForTimeout(80); }
  s = await st(); check(s.slots[3] === 0 && s.slots[4] === 64, `Del destroys the hovered stack only (slot3 ${s.slots[3]}, slot4 ${s.slots[4]})`);
  check(await pg.evaluate(() => BF.inventory.isOpen()), "Del leaves the screen open");
  await pg.keyboard.down("Shift"); await click(trash); await pg.keyboard.up("Shift");
  s = await st(); check(s.slots.slice(0, 9).every(n => n === 0) && s.slots[20] === 10, `shift-click on a palette tab empties the hotbar, keeps the rest (slot20 ${s.slots[20]})`);
  await pg.evaluate(() => BF.inventory.close());
  await fill(); await open();
  await click('.bf-tab[data-tab="inventory"]');
  await pg.keyboard.down("Shift"); await click(trash); await pg.keyboard.up("Shift");
  s = await st(); check(s.slots.every(n => n === 0), "shift-click on the inventory tab empties the whole inventory");
  await pg.screenshot({ path: out + "-inv.png" });
  await pg.evaluate(() => BF.inventory.close());
  await fill();
  await pg.evaluate(() => { BF.player.gameMode = "survival"; BF.inventory.open("inventory"); }); await pg.waitForTimeout(400); await settle();
  check(await pg.evaluate(() => document.querySelector('.bf-slot[data-c="trash"]').offsetWidth === 0), "no trash in survival");
  { const [x, y] = await centre(slot(0)); await pg.mouse.move(x, y); await pg.keyboard.press("Delete"); await pg.waitForTimeout(80); }
  s = await st(); check(s.slots[0] === 64, "Del does nothing in survival");
  await pg.evaluate(() => BF.inventory.close());
  console.log(fails ? `FAIL ${fails} cases` : "all cases ok");
};
