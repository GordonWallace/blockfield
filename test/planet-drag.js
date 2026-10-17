// @ci integration suite=world timeout=300
// Off-planet mode with the real pointer lock (spec r14-04): above 20,000 the lock is let go and dragging turns the planet, also after
// something re-takes the mouse up there (closing a screen or the teleport panel, a lock landing late), and back down a click takes
// the mouse again for looking around. (Gordon, 2026-10-16: dragging high up didn't work in Firefox.)
// node test/run.js /tmp/pd test/planet-drag.js
module.exports = async (pg) => {
  await pg.setViewportSize({ width: 320, height: 200 });
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await pg.evaluate(async () => {
    window.__errs = []; addEventListener("error", e => window.__errs.push(e.message));
    delete document.getElementById("view").requestPointerLock;   // the real pointer lock: test/run.js turns it off for every other test
    BF.newWorld(1337, { gen: 4 }); BF.world.viewDist = 4; BF.player.start(); BF.player.setGameMode("creative");
    await new Promise(r => setTimeout(r, 2000));
  });
  const st = () => pg.evaluate(() => { const p = BF.player.position, l = BF.planet.latLonAt(p.x, p.z); return { locked: !!document.pointerLockElement, off: BF.player.offPlanet, lat: l.lat, lon: l.lon }; });
  const drag = async () => {
    const a = await st();
    await pg.mouse.move(160, 100); await pg.mouse.down();
    for (let i = 1; i <= 5; i++) await pg.mouse.move(160 + 12 * i, 100 + 6 * i);
    await pg.mouse.up(); await pg.waitForTimeout(200);
    const b = await st();
    return Math.abs(b.lon - a.lon) > 0.5 && Math.abs(b.lat - a.lat) > 0.5;
  };
  await pg.mouse.click(160, 100); await pg.waitForTimeout(500);
  check((await st()).locked, "a click on the game takes the mouse (pointer lock)");
  await pg.evaluate(() => { BF.player.setFlying(true); BF.player.position.y = 30000; }); await pg.waitForTimeout(800);
  let s = await st();
  check(s.off && !s.locked, "at 30,000 the view is off-planet and the mouse is let go");
  check(await drag(), "dragging turns the planet");
  await pg.evaluate(() => { BF.player.relock(); BF.player.uiClose(); }); await pg.waitForTimeout(500);
  check(!(await st()).locked, "closing a screen or the teleport panel up there doesn't take the mouse");
  check(await drag(), "and dragging still turns the planet");
  await pg.evaluate(() => BF.renderer.domElement.requestPointerLock()); await pg.waitForTimeout(600);
  check(!(await st()).locked, "a lock that lands anyway is let go");
  check(await drag(), "and dragging still turns the planet");
  await pg.evaluate(() => { BF.player.position.y = 15000; const v = BF.player.velocity; v.x = v.y = v.z = 0; });
  await pg.waitForFunction(() => !BF.player.offPlanet, null, { timeout: 30000 });
  await pg.mouse.click(160, 100); await pg.waitForTimeout(500);
  check((await st()).locked, "back below 19,400 a click takes the mouse again");
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-drag" : "PASS planet-drag");
};
