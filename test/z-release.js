// Z frees the mouse without pausing (the game keeps running) and a click on the game takes it back; Escape still pauses.
// Pointer lock is simulated (headless Chromium has none). node test/run.js /tmp/zr test/z-release.js
const WAIT = 30000;
module.exports = async (pg) => {
  await pg.evaluate(() => {
    const cv = document.querySelector("canvas");
    let el = null;
    Object.defineProperty(document, "pointerLockElement", { get: () => el, configurable: true });
    const fire = () => document.dispatchEvent(new Event("pointerlockchange"));
    cv.requestPointerLock = () => new Promise(res => setTimeout(() => { el = cv; fire(); res(); }, 20));
    document.exitPointerLock = () => { if (el) { el = null; setTimeout(fire, 5); } };
    window.__escDown = () => { if (el) { el = null; setTimeout(fire, 5); return true; } return false; };   // a locked Escape: the browser leaves pointer lock
    BF.player.start();
  });
  const until = (fn, arg) => pg.waitForFunction(fn, arg, { timeout: WAIT, polling: 50 }).then(() => true, () => false);
  const st = () => pg.evaluate(() => ({ locked: BF.player.isLocked(), menu: BF.player.menu(), paused: !!BF.state.paused, frame: BF.player.frame() }));
  let fails = 0;
  const check = (label, ok, s) => { if (!ok) fails++; console.log((ok ? "ok  " : "FAIL") + " " + label + ": " + JSON.stringify(s)); };

  await until(() => BF.player.isLocked());
  await pg.keyboard.press('z');
  await until(() => !BF.player.isLocked());
  let s = await st();
  check("Z frees the mouse without pausing", !s.locked && s.menu === null && !s.paused, s);
  const f0 = s.frame;
  await until(f => BF.player.frame() >= f + 10, f0);
  s = await st();
  check("the game keeps running while the mouse is free", s.frame >= f0 + 10 && s.menu === null && !s.paused, s);
  await pg.mouse.click(640, 380);
  await until(() => BF.player.isLocked());
  s = await st();
  check("a click on the game takes the mouse back", s.locked && s.menu === null, s);
  await pg.keyboard.press('z');
  await until(() => !BF.player.isLocked());
  await pg.mouse.click(640, 380);
  await until(() => BF.player.isLocked());
  check("Z and click again", (await st()).locked, await st());
  // flying: W + R is the 10x boost, R alone still sprints on foot, and E opens the inventory even while flying forward
  await pg.evaluate(() => { BF.player.gameMode = "creative"; });
  // double-tap Space, dispatched in the page: a slow headless page can see two real presses more than 300 ms apart
  await pg.evaluate(() => { for (let i = 0; i < 2; i++) { dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " })); dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " })); } });
  await until(() => BF.player.flying);
  await pg.keyboard.down('w'); await pg.keyboard.down('r');
  await until(() => BF.player.turbo, null);
  s = await pg.evaluate(() => ({ flying: BF.player.flying, turbo: BF.player.turbo }));
  check("flying with W + R boosts", s.flying && s.turbo, s);
  await pg.keyboard.up('r');
  await until(() => !BF.player.turbo);
  s = await pg.evaluate(() => ({ turbo: BF.player.turbo }));
  check("letting go of R ends the boost", !s.turbo, s);
  await pg.keyboard.press('e');
  await until(() => BF.inventory.isOpen());
  s = await pg.evaluate(() => ({ inv: BF.inventory.isOpen(), turbo: BF.player.turbo }));
  check("E opens the inventory while flying with W held", s.inv && !s.turbo, s);
  await pg.keyboard.up('w');
  await pg.keyboard.press('e');
  await until(() => !BF.inventory.isOpen() && BF.player.isLocked());
  if (!(await pg.evaluate(() => window.__escDown()))) await pg.keyboard.press('Escape');
  await until(() => BF.player.menu() === "pause");
  s = await st();
  check("Escape still pauses", s.menu === "pause", s);
  console.log(fails ? "FAILED " + fails : "ALL OK");
};
