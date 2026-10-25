// @ci integration suite=world hosts=worker,server
// A creeper blast right after another mob's hit still does its damage; weaker hits in the same half second don't (bug-026):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/cah test/creeper-after-hit.js [--host page|worker|server]
// The mobs hit where the simulation is; the player's body, its health and the half-second window are the page's (spec r15-43: with the
// simulation off the page its hits reach the page as hurts), so each trial's hits are dealt in one go there and the health read here.
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await lib.sim(pg, () => { BF.mobs.spawning = false; });
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const trial = async (preHit) => {
    await pg.evaluate(() => { for (let i = 0; i < 60; i++) BF.player.update(0.05); BF.player.health = 20; });   // let any old hurt cooldown run out
    await lib.sim(pg, () => { for (const m of BF.mobs.list.slice()) if (m.hostile) m.dead = true; BF.sky.setTime(0.75); BF.mobs.update(0.05); });
    await pg.waitForTimeout(500);
    await pg.evaluate(() => { BF.player.health = 20; });
    await pg.waitForTimeout(300);   // (the page's health reaches the simulation)
    const r = await lib.sim(pg, (preHit) => {
      const P = BF.player, p = P.position, M = BF.mobs, r = { preHit, hits: [] };
      const damage = P.damage;   // (the hits as dealt: with the simulation off the page they go to the page as hurts)
      P.damage = function (a) { r.hits.push(a); return damage.apply(this, arguments); };
      try {
        if (preHit) {     // a zombie punch, as mobs.js deals it, then a second, weaker hit in the same half second
          const z = M.spawn("zombie", p.x - 0.9, p.y, p.z);
          z.ai.target = true; z.ai.los = true; z.ai.losT = 5; z.ai.attackCd = 0;
          M.update(0.05);
          r.punch = r.hits.length ? r.hits[0] : 0; z.dead = true;
          P.damage(1, p.clone ? p.clone() : { x: p.x - 1, y: p.y, z: p.z });
        }
        const c = M.spawn("creeper", p.x + 1.5, p.y, p.z);
        c.ai.target = true; c.ai.los = true; c.ai.losT = 5; c.ai.fuse = 1.49;
        M.update(0.05);
        r.exploded = !!c.exploded;
      } finally { P.damage = damage; }
      if (BF.proto && BF.proto.flush) BF.proto.flush();
      return r;
    }, preHit);
    await pg.waitForTimeout(1000);
    r.afterBlast = await pg.evaluate(() => BF.player.health);
    return r;
  };
  const alone = await trial(false), after = await trial(true);
  console.log(JSON.stringify({ alone, after }));
  const blast = 20 - alone.afterBlast;
  check(alone.exploded && blast >= 10, "a blast alone does heavy damage (" + blast + ")");
  check(after.punch > 0 && after.punch < blast, "setup: the zombie punch landed, weaker than the blast (" + after.punch + ")");
  check(after.exploded && 20 - after.afterBlast === blast, "a weaker hit within half a second of the punch does nothing, and a blast right after brings the total to the blast's damage (" + (20 - after.afterBlast) + ")");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
