// A creeper blast right after another mob's hit still does its damage; weaker hits in the same half second don't (bug-026):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/cah test/creeper-after-hit.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); BF.mobs.spawning = false; });
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const trial = async (preHit) => {
    await pg.evaluate(() => { for (let i = 0; i < 60; i++) BF.player.update(0.05); });   // let any old hurt cooldown run out
    return pg.evaluate((preHit) => {
      const P = BF.player, p = P.position, M = BF.mobs;
      for (const m of M.list.slice()) if (m.hostile) m.dead = true;
      BF.sky.setTime(0.75);
      P.health = 20;
      const r = { preHit };
      if (preHit) {     // a zombie punch, as mobs.js deals it, then a second, weaker hit in the same half second
        const z = M.spawn("zombie", p.x - 0.9, p.y, p.z);
        z.ai.target = true; z.ai.los = true; z.ai.losT = 5; z.ai.attackCd = 0;
        M.update(0.05);
        r.afterPunch = P.health; z.dead = true;
        P.damage(1, p.clone ? p.clone() : { x: p.x - 1, y: p.y, z: p.z });
        r.afterWeakHit = P.health;
      }
      const c = M.spawn("creeper", p.x + 1.5, p.y, p.z);
      c.ai.target = true; c.ai.los = true; c.ai.losT = 5; c.ai.fuse = 1.49;
      M.update(0.05);
      r.afterBlast = P.health; r.exploded = !!c.exploded;
      return r;
    }, preHit);
  };
  const alone = await trial(false), after = await trial(true);
  console.log(JSON.stringify({ alone, after }));
  const blast = 20 - alone.afterBlast;
  check(alone.exploded && blast >= 10, "a blast alone does heavy damage (" + blast + ")");
  check(after.afterPunch < 20, "setup: the zombie punch landed");
  check(after.afterWeakHit === after.afterPunch, "a weaker hit within half a second of the punch does nothing");
  check(after.exploded && 20 - after.afterBlast === blast, "a blast right after the punch still brings the total to the blast's damage");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
