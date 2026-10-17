// Game hotkeys do nothing on the title screen: the arrow keys don't fast-forward the background world and the number
// keys don't move the hotbar. They still work once a world is playing.
// node test/run.js /tmp/th test/title-hotkeys.js
module.exports = async (pg) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const st = () => pg.evaluate(() => ({ menu: BF.player.menu(), warp: BF.warp.speed, sel: BF.inventory.selectedIndex }));
  let s0 = await st();
  check(s0.menu === "start", "title screen showing " + JSON.stringify(s0));
  for (let i = 0; i < 4; i++) await pg.keyboard.press("ArrowRight");
  await pg.keyboard.press("Digit5");
  await pg.waitForTimeout(300);
  let s = await st();
  check(s.warp === s0.warp && s.sel === s0.sel, "arrow and number keys do nothing on the title screen " + JSON.stringify(s));
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(1500);
  await pg.keyboard.press("ArrowRight");
  await pg.keyboard.press("Digit5");
  await pg.waitForTimeout(300);
  s = await st();
  check(s.warp > 1 && s.sel === 4, "in a world, Right Arrow speeds up time and 5 picks slot 5 " + JSON.stringify(s));
  await pg.evaluate(() => BF.warp.reset());
  console.log(bad ? "FAIL title-hotkeys" : "PASS title-hotkeys");
};
