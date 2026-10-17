// Escape closes in-game screens straight back to play; Escape with nothing open still pauses.
// Pointer lock is simulated the way Chrome behaves: a lock granted while Escape is held is dropped at once as a user exit.
// A second pass is a stricter browser that also drops the lock asked for after Escape's release: the game must stay
// unpaused with the mouse free, and the next click captures it. A third pass is a browser that refuses every lock request
// for 1.25 s after an Escape (as Chrome on macOS can): the game must take the mouse back by itself once that time is up, and
// a key press must take it back at once.
// Every step waits for the state it expects (up to WAIT ms) rather than for a fixed time, so the test holds on a CI machine
// drawing one frame a second as well as on a fast one.
// node test/run.js /tmp/esc test/esc-close.js
const WAIT = 30000;
module.exports = async (pg) => {
  await pg.evaluate(() => {
    const cv = document.querySelector("canvas");
    let el = null;
    // the test marks Escape as held (window.__esc) around the key press; other modules' capture listeners stop the event
    // before a listener added here could see it
    window.__escDown = () => { window.__esc = true; window.__escAt = performance.now(); if (el) { el = null; setTimeout(fire, 5); return true; } return false; };
    Object.defineProperty(document, "pointerLockElement", { get: () => el, configurable: true });
    const fire = () => document.dispatchEvent(new Event("pointerlockchange"));
    cv.requestPointerLock = () => new Promise((res, rej) => setTimeout(() => {
      if (window.__refuse === "always" || window.__refuse && performance.now() - (window.__escAt || -1e9) < 1250) {   // refusing browser: no lock yet
        window.__refused = true;
        document.dispatchEvent(new Event("pointerlockerror"));
        return rej(new Error("refused"));
      }
      el = cv; fire();
      const strictDrop = window.__strict && window.__dropNext;   // strict browser: the lock asked for after an Escape is dropped
      if (strictDrop) { window.__dropNext = false; window.__dropped = true; }
      if (window.__esc || strictDrop) setTimeout(() => { el = null; fire(); }, 5);   // Chrome: Escape is "leave pointer lock"
      res();
    }, 20));
    document.exitPointerLock = () => { if (el) { el = null; setTimeout(fire, 5); } };
    BF.player.start();
  });
  const until = (fn, arg) => pg.waitForFunction(fn, arg, { timeout: WAIT, polling: 50 }).then(() => true, () => false);
  const st = () => pg.evaluate(() => ({ locked: BF.player.isLocked(), menu: BF.player.menu(), inv: BF.inventory.isOpen(), map: BF.mapview.isOpen() }));
  const frames = n => pg.evaluate(() => BF.player.frame()).then(f => until(f => BF.player.frame() >= f, f + n));
  let fails = 0;
  const report = (label, s, want) => {
    const ok = Object.keys(want).every(k => s[k] === want[k]);
    if (!ok) fails++;
    console.log((ok ? "ok  " : "FAIL") + " " + label + ": " + JSON.stringify(s));
  };
  // waits for the state to match `want`, then reports it
  const check = async (label, want) => {
    await until(w => { const s = { locked: BF.player.isLocked(), menu: BF.player.menu(), inv: BF.inventory.isOpen() }; return Object.keys(w).every(k => s[k] === w[k]); }, want);
    report(label, await st(), want);
  };
  const esc = async () => {
    // a locked Escape never reaches the page: the browser keeps it and leaves pointer lock
    const browserKept = await pg.evaluate(() => window.__escDown());
    if (!browserKept) await pg.keyboard.down('Escape');
    await pg.waitForTimeout(150);
    await pg.evaluate(() => { window.__esc = false; window.__dropNext = true; });
    if (!browserKept) await pg.keyboard.up('Escape');
  };
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
    // the screen is up and its unlock has landed, as both have in a real browser long before a person presses Escape
    const open = await until(() => (BF.inventory.isOpen() || BF.commands.isOpen()) && !BF.player.isLocked());
    console.log(how, "open:", open);
  };

  await until(() => BF.player.isLocked());
  console.log("start:", JSON.stringify(await st()));
  for (const how of ["E", "crafting", "furnace", "chest", "villager", "chat"]) {
    await until(() => BF.player.isLocked());
    await openScreen(how);
    await esc();
    await check("after Esc from " + how, { locked: true, menu: null, inv: false });
  }

  await pg.evaluate(() => { window.__strict = true; });
  for (const how of ["crafting", "chest"]) {
    await until(() => BF.player.isLocked() && !BF.player.escGrace());
    await openScreen(how);
    await pg.evaluate(() => { window.__dropped = false; });
    await esc();
    // the browser drops the re-capture; give the game a few frames to (wrongly) pause before looking
    await until(() => window.__dropped && !BF.player.isLocked());
    await frames(5);
    report("strict browser: Esc from " + how + " stays in the game", await st(), { menu: null, inv: false });
    await pg.evaluate(() => { window.__dropNext = false; });
    await pg.mouse.click(640, 380);
    await check("strict browser: a click captures the mouse", { locked: true, menu: null });
  }
  await pg.evaluate(() => { window.__strict = false; window.__refuse = true; });
  for (const how of ["crafting", "chest"]) {
    await until(() => BF.player.isLocked() && !BF.player.escGrace());
    await openScreen(how);
    await pg.evaluate(() => { window.__refused = false; });
    await esc();
    await until(() => window.__refused);
    await frames(5);
    report("refusing browser: Esc from " + how + " stays in the game", await st(), { menu: null, inv: false });
    await check("refusing browser: the mouse comes back by itself", { locked: true, menu: null });
  }
  // a key press takes the mouse back without waiting
  await until(() => BF.player.isLocked() && !BF.player.escGrace());
  await openScreen("crafting");
  await pg.evaluate(() => { window.__refused = false; window.__refuse = "always"; });
  await esc();
  await until(() => window.__refused);
  await pg.waitForTimeout(1800);   // the game's own retry has come and gone, refused too
  await frames(3);
  report("refusing browser: still in the game with the mouse free", await st(), { locked: false, menu: null, inv: false });
  await pg.evaluate(() => { window.__refuse = false; });
  await pg.keyboard.press('KeyW');
  await check("refusing browser: a key press captures the mouse", { locked: true, menu: null });
  await pg.evaluate(() => { window.__refuse = false; });

  await until(() => BF.player.isLocked() && !BF.player.escGrace());   // past the grace after the last Escape-close
  await esc();
  await check("Esc with nothing open pauses", { menu: "pause" });
  await esc();
  await check("Esc in pause menu resumes", { locked: true, menu: null });
  console.log(fails ? "FAILED " + fails : "ALL OK");
};
