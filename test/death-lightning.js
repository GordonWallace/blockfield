// Dying to a lightning strike says "You were struck by lightning", not just "You died".
// node test/run.js /tmp/dl test/death-lightning.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(async () => {
    for (let i = 0; i < 60; i++) BF.player.update(0.05);   // past the hurt cooldown after spawn
    BF.player.health = 4;
    const p = BF.player.position;
    BF.weather.strikeAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    await new Promise(r => setTimeout(r, 200));
    return { dead: BF.player.dead, text: [...document.querySelectorAll(".bfp-sub")].map(e => e.textContent).filter(Boolean) };
  });
  console.log(JSON.stringify(r));
  const ok = r.dead && r.text.includes("You were struck by lightning");
  console.log(ok ? "PASS death-lightning" : "FAIL death-lightning");
};
