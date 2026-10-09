// Escape still closes the pause menu after a volume slider was clicked (the slider keeps focus), and once play resumes
// the movement keys work instead of going to the hidden slider. Pointer lock is simulated as in test/esc-close.js.
// node test/run.js /tmp/es test/esc-slider.js
const WAIT = 20000;
module.exports = async (pg) => {
  await pg.evaluate(() => {
    const cv = document.querySelector("canvas"); let el = null;
    Object.defineProperty(document, "pointerLockElement", { get: () => el, configurable: true });
    const fire = () => document.dispatchEvent(new Event("pointerlockchange"));
    cv.requestPointerLock = () => new Promise(res => setTimeout(() => { el = cv; fire(); res(); }, 20));
    document.exitPointerLock = () => { if (el) { el = null; setTimeout(fire, 5); } };
    window.__browserEsc = () => { if (el) { el = null; fire(); } };   // Escape while locked: the browser leaves pointer lock
    BF.player.start();
  });
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const st = () => pg.evaluate(() => ({ locked: BF.player.isLocked(), menu: BF.player.menu(), active: document.activeElement && document.activeElement.tagName + "." + (document.activeElement.dataset.k || "") }));
  const until = async (f, ms = WAIT) => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await st(); if (f(s)) return s; await pg.waitForTimeout(100); } return s; };
  let s = await until(s => s.locked);
  check(s.locked, "playing with the mouse captured");
  await pg.evaluate(() => window.__browserEsc());
  s = await until(s => s.menu === "pause");
  check(s.menu === "pause", "Escape pauses");
  await pg.click(".bfa-open"); await pg.waitForTimeout(200);
  await pg.click('.bfa-panel input[data-k="music"]'); await pg.waitForTimeout(200);
  s = await st();
  check(s.active === "INPUT.music", "a volume slider has focus " + JSON.stringify(s));
  await pg.keyboard.press("Escape");
  s = await until(s => s.menu !== "pause" && s.locked);
  check(s.menu !== "pause" && s.locked, "Escape with the slider focused resumes play " + JSON.stringify(s));
  check(s.active !== "INPUT.music", "the hidden slider no longer has focus " + JSON.stringify(s));
  const z0 = await pg.evaluate(() => [BF.player.position.x, BF.player.position.z]);
  await pg.keyboard.down("KeyW"); await pg.waitForTimeout(1500); await pg.keyboard.up("KeyW");
  const z1 = await pg.evaluate(() => [BF.player.position.x, BF.player.position.z]);
  const moved = Math.hypot(z1[0] - z0[0], z1[1] - z0[1]);
  check(moved > 0.5, "W moves the player after resuming (" + moved.toFixed(2) + " blocks)");
  console.log(bad ? "FAIL esc-slider" : "PASS esc-slider");
};
