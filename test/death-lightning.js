// @ci integration suite=ui hosts=worker,server
// Dying to a lightning strike says "You were struck by lightning", not just "You died".
// node test/run.js /tmp/dl test/death-lightning.js [--host page|worker|server]
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  await pg.evaluate(() => {   // (the player's body and health are the page's)
    for (let i = 0; i < 60; i++) BF.player.update(0.05);   // past the hurt cooldown after spawn
    BF.player.health = 4;
  });
  await require('./lib').sim(pg, () => {   // the strike, where the simulation is (spec r15-43): its hurt reaches the page's player
    const p = BF.player.position;
    BF.weather.strikeAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (BF.proto) BF.proto.flush();
  });
  await pg.waitForFunction(() => BF.player.dead, null, { timeout: 10000 }).catch(() => {});
  await pg.waitForTimeout(200);
  const r = await pg.evaluate(() => ({ dead: BF.player.dead, text: [...document.querySelectorAll(".bfp-sub")].map(e => e.textContent).filter(Boolean) }));
  console.log(JSON.stringify(r));
  const ok = r.dead && r.text.some(t => t.split("\n")[0] === "You were struck by lightning");   // the line under it is where you died (face, u, v, y, latitude and longitude on the planet)
  console.log(ok ? "PASS death-lightning" : "FAIL death-lightning");
};
