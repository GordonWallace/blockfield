// Escape closes in-game screens straight back to play; Escape with nothing open still pauses.
// Pointer lock is simulated the way Chrome behaves: a lock granted while Escape is held is dropped at once as a user exit.
// node test/run.js /tmp/esc test/esc-close.js
module.exports = async (pg) => {
  await pg.evaluate(() => {
    const cv = document.querySelector("canvas");
    let el = null;
    // the test marks Escape as held (window.__esc) around the key press; other modules' capture listeners stop the event
    // before a listener added here could see it
    window.__escDown = () => { window.__esc = true; if (el) { el = null; setTimeout(fire, 5); return true; } return false; };
    Object.defineProperty(document, "pointerLockElement", { get: () => el, configurable: true });
    const fire = () => document.dispatchEvent(new Event("pointerlockchange"));
    cv.requestPointerLock = () => new Promise(res => setTimeout(() => {
      el = cv; fire();
      if (window.__esc) setTimeout(() => { el = null; fire(); }, 5);   // Chrome: Escape is "leave pointer lock"
      res();
    }, 20));
    document.exitPointerLock = () => { if (el) { el = null; setTimeout(fire, 5); } };
    BF.player.start();
  });
  await pg.waitForTimeout(300);
  const st = () => pg.evaluate(() => ({ locked: BF.player.isLocked(), menu: BF.player.menu(), inv: BF.inventory.isOpen(), map: BF.mapview.isOpen() }));
  const esc = async () => {
    // a locked Escape never reaches the page: the browser keeps it and leaves pointer lock
    if (!(await pg.evaluate(() => window.__escDown()))) await pg.keyboard.down('Escape');
    else await pg.waitForTimeout(50); await pg.waitForTimeout(1000);   // long hold: frames are slow under software GL
    await pg.evaluate(() => { window.__esc = false; });
    await pg.keyboard.up('Escape'); await pg.waitForTimeout(800);
  };
  console.log("start:", JSON.stringify(await st()));
  let fails = 0;
  const check = (label, s, want) => { const ok = Object.keys(want).every(k => s[k] === want[k]); if (!ok) fails++; console.log((ok ? "ok  " : "FAIL") + " " + label + ": " + JSON.stringify(s)); };
  for (const how of ["E", "crafting", "furnace", "chat"]) {
    if (how === "E") await pg.keyboard.press('e');
    else if (how === "chat") await pg.keyboard.press('t');
    else await pg.evaluate(m => BF.inventory.open(m), how);
    await pg.waitForTimeout(200);
    const open = await pg.evaluate(() => BF.inventory.isOpen() || BF.commands.isOpen());
    console.log(how, "open:", open);
    await esc();
    check("after Esc from " + how, await st(), { locked: true, menu: null, inv: false });
  }
  await esc();
  check("Esc with nothing open pauses", await st(), { menu: "pause" });
  await esc();
  check("Esc in pause menu resumes", await st(), { locked: true, menu: null });
  console.log(fails ? "FAILED " + fails : "ALL OK");
};
