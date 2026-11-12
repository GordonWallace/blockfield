// @ci baseline suite=ui timeout=300
// The block outline (Gordon, 2026-11-12; js/player.js): the black box around the block under the crosshair is off by default, the pause
// menu's Game options has a "Block outline" switch that turns it on at once, and the choice is remembered in this browser
// (localStorage blockfield.outline) across reloads, with the classic look and the realistic one alike.
// Usage: node test/run.js /tmp/bo test/block-outline.js
const lib = require('./lib');
module.exports = async (pg) => {
  const ok = (what, c, d) => console.log((c ? "ok   " : "FAIL ") + what + (d !== undefined && !c ? " " + JSON.stringify(d) : ""));
  const state = () => pg.evaluate(() => ({ on: BF.player.blockOutline.on(), visible: BF.player.blockOutline.visible(), target: !!BF.player.target, stored: localStorage.getItem("blockfield.outline") }));
  const button = () => pg.evaluate(() => { const b = document.querySelector('.bfp-pauseopts [data-act="outline"]'); return b ? { text: b.textContent, pressed: b.getAttribute("aria-pressed") } : null; });
  // play started, looking straight down at the ground under the player
  const lookDown = async () => {
    await pg.evaluate(() => { BF.player.start(); BF.player.setFlying(false); BF.player.setLook(0, -1.5); });
    await pg.waitForFunction(() => !!BF.player.target, null, { timeout: 30000 }).catch(() => {});
    await pg.waitForTimeout(300);
  };
  const openOpts = async () => {
    await pg.evaluate(() => BF.player.showMenu("pause"));
    if (await pg.evaluate(() => document.querySelector('.bfp-pauseopts').hidden)) await pg.evaluate(() => document.querySelector('.bfp-pause [data-act="opts"]').click());
  };
  const close = async () => { await pg.evaluate(() => BF.player.showMenu(null)); await pg.waitForTimeout(300); };

  await pg.evaluate(() => { try { localStorage.removeItem("blockfield.outline"); } catch (_) {} });
  await lookDown();
  const s0 = await state();
  ok("a block is under the crosshair", s0.target, s0);
  ok("the outline is off by default and not drawn", s0.on === false && s0.visible === false, s0);

  await openOpts();
  const b0 = await button();
  ok("Game options in the pause menu has the switch, off", !!b0 && b0.text === "Block outline: Off" && b0.pressed === "false", b0);
  await pg.evaluate(() => document.querySelector('.bfp-pauseopts [data-act="outline"]').click());
  const b1 = await button(), s1 = await state();
  ok("clicking it turns the outline on at once", b1.text === "Block outline: On" && b1.pressed === "true" && s1.on && s1.visible, { b1, s1 });
  ok("the choice is stored in the browser", s1.stored === "on", s1);
  await close();
  await pg.waitForTimeout(500);
  const s2 = await state();
  ok("the box stays on the targeted block in play", s2.target && s2.visible, s2);

  await openOpts();
  await pg.evaluate(() => document.querySelector('.bfp-pauseopts [data-act="outline"]').click());
  const s3 = await state();
  await close();
  await pg.waitForTimeout(500);
  const s4 = await state();
  ok("turning it off hides the box again, and that is stored", s3.target && !s3.on && !s3.visible && s3.stored === "off" && s4.target && !s4.visible, { s3, s4 });

  await pg.evaluate(() => BF.player.blockOutline.set(true));
  await pg.reload();
  await lib.reloaded(pg);
  const s5 = await state();
  ok("the choice survives a reload", s5.on === true && s5.stored === "on", s5);
  await openOpts();
  const b5 = await button();
  ok("and the menu shows it on", !!b5 && b5.text === "Block outline: On" && b5.pressed === "true", b5);
  await pg.evaluate(() => { try { localStorage.removeItem("blockfield.outline"); } catch (_) {} });
};
