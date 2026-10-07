// Escape closes in-game screens straight back to play; Escape with nothing open still pauses.
// Pointer lock is simulated the way Chrome behaves: a lock granted while Escape is held is dropped at once as a user exit.
// A second pass is a stricter browser that also drops a lock granted just after Escape's release: the game must stay
// unpaused with the mouse free, and the next click captures it.
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
      const strictDrop = window.__strict && window.__dropNext;   // strict browser: the lock asked for after an Escape is dropped
      if (strictDrop) { window.__dropNext = false; window.__dropped = true; }
      if (window.__esc || strictDrop) setTimeout(() => { el = null; fire(); }, 5);   // Chrome: Escape is "leave pointer lock"
      res();
    }, 20));
    document.exitPointerLock = () => { if (el) { el = null; setTimeout(fire, 5); } };
    BF.player.start();
  });
  // under software GL a frame can take longer than the simulated lock delay: wait for the lock before each case, or the
  // lock lands after a screen opened and the test's simulated Escape drops it instead of reaching the page
  const waitLocked = () => pg.waitForFunction(() => BF.player.isLocked(), null, { timeout: 10000 }).catch(() => {});
  await waitLocked();
  const st = () => pg.evaluate(() => ({ locked: BF.player.isLocked(), menu: BF.player.menu(), inv: BF.inventory.isOpen(), map: BF.mapview.isOpen() }));
  const esc = async () => {
    // a locked Escape never reaches the page: the browser keeps it and leaves pointer lock
    if (!(await pg.evaluate(() => window.__escDown()))) await pg.keyboard.down('Escape');
    else await pg.waitForTimeout(50); await pg.waitForTimeout(1000);   // long hold: frames are slow under software GL
    await pg.evaluate(() => { window.__esc = false; window.__dropNext = true; });
    await pg.keyboard.up('Escape'); await pg.waitForTimeout(800);
  };
  console.log("start:", JSON.stringify(await st()));
  let fails = 0;
  const check = (label, s, want) => { const ok = Object.keys(want).every(k => s[k] === want[k]); if (!ok) fails++; console.log((ok ? "ok  " : "FAIL") + " " + label + ": " + JSON.stringify(s)); };
  const openScreen = async how => {
    if (how === "E") await pg.keyboard.press('e');
    else if (how === "chat") await pg.keyboard.press('t');
    else if (how === "villager") await pg.evaluate(() => {
      const p = BF.player.position;
      const v = BF.mobs.list.find(m => m.type === "villager" && m.profession) || BF.mobs.spawn("villager", p.x + 2, p.y, p.z);
      if (v && !v.profession) v.profession = "farmer";
      BF.inventory.openTrade(v);
    });
    else await pg.evaluate(m => { const p = BF.player.position; BF.inventory.open(m, { x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) }); }, how);
    // the unlock from opening the screen must land before Escape, as it does in a real browser long before a person reacts
    await pg.waitForFunction(() => !BF.player.isLocked(), null, { timeout: 10000 }).catch(() => {});
    await pg.waitForTimeout(200);
    console.log(how, "open:", await pg.evaluate(() => BF.inventory.isOpen() || BF.commands.isOpen()));
  };
  const SCREENS = ["E", "crafting", "furnace", "chest", "villager", "chat"];
  for (const how of SCREENS) {
    await waitLocked();
    await openScreen(how);
    await esc();
    check("after Esc from " + how, await st(), { locked: true, menu: null, inv: false });
  }
  await pg.evaluate(() => { window.__strict = true; });
  await pg.waitForTimeout(1200);   // past the grace after the last Escape-close
  for (const how of ["crafting", "chest"]) {
    await waitLocked();
    await openScreen(how);
    await pg.evaluate(() => { window.__dropped = false; });
    await esc();
    // the browser's answer to the re-lock can come late on a slow machine: check once it has dropped it
    await pg.waitForFunction(() => window.__dropped, null, { timeout: 10000 }).catch(() => {});
    await pg.waitForTimeout(300);
    check("strict browser: Esc from " + how + " stays in the game", await st(), { menu: null, inv: false });
    await pg.evaluate(() => { window.__dropNext = false; });
    await pg.mouse.click(640, 380);
    await waitLocked();
    check("strict browser: a click captures the mouse", await st(), { locked: true, menu: null });
  }
  await pg.evaluate(() => { window.__strict = false; });
  await pg.waitForTimeout(1200);   // past the grace after the last Escape-close
  await esc();
  check("Esc with nothing open pauses", await st(), { menu: "pause" });
  await esc();
  check("Esc in pause menu resumes", await st(), { locked: true, menu: null });
  console.log(fails ? "FAILED " + fails : "ALL OK");
};
