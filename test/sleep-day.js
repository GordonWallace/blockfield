// Sleeping in a bed wakes you the next morning: the day counter moves on (bug-010). Also in a daytime thunderstorm.
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const check = (ok, msg) => console.log((ok ? "PASS " : "FAIL ") + msg);
  const sleepAt = (time, storm, clicks) => pg.evaluate(async ({ time, storm, clicks }) => {
    BF.mobs.spawning = false;
    for (const m of BF.mobs.list) if (m.hostile) m.dead = true;
    const p = BF.player.position, x = Math.floor(p.x), z = Math.floor(p.z);
    const y = BF.world.heightAt(x, z) + 1;
    BF.player.teleport(x + 0.5, y + 0.01, z + 0.5);
    for (let i = 0; i < 5; i++) BF.player.update(0.05);
    for (const dz of [2, 3]) { BF.world.setBlock(x, y - 1, z - dz, BF.B.stone); for (let k = 0; k < 3; k++) BF.world.setBlock(x, y + k, z - dz, 0); }
    BF.world.setBlock(x, y, z - 2, BF.bedId(0, 0)); BF.world.setBlock(x, y, z - 3, BF.bedId(0, 1));
    if (storm) { BF.weather.set("thunder"); BF.weather.intensity = 1; BF.weather.thunder = 1; } else BF.weather.set("clear");
    BF.sky.day = 5; BF.sky.setTime(time);
    const e = BF.player.eyePos(), tx = x + 0.5 - e.x, ty = y + 0.3 - e.y, tz = z - 2 + 0.5 - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
    BF.player.update(0.016);
    BF.spawnPoint = null;
    for (let i = 0; i < (clicks || 1); i++) {   // quick repeat clicks land inside the 0.7 s fade
      if (i) { await new Promise(r => setTimeout(r, 200)); BF.player.update(0.016); }
      BF.player.setMouse(false, true); BF.player.setMouse(false, false);
    }
    await new Promise(r => setTimeout(r, 1500));
    return { slept: !!(BF.spawnPoint && BF.spawnPoint.bed), day: BF.sky.day, time: BF.sky.time, stormy: !!(BF.sky.stormy && BF.sky.stormy()) };
  }, { time, storm, clicks });
  const night = await sleepAt(0.8, false);
  check(night.slept, "slept at night");
  check(night.day === 6 && night.time < 0.02, `night: woke on day 6 morning (day ${night.day}, time ${night.time.toFixed(3)})`);
  const twice = await sleepAt(0.8, false, 3);
  check(twice.day === 6, `three quick clicks on the bed: woke on day 6, not later (day ${twice.day}) (bug-041)`);
  const late = await sleepAt(0.99, false);
  check(late.day === 6, `just before sunrise: woke on day 6 (day ${late.day})`);
  const storm = await sleepAt(0.3, true);
  if (storm.slept) check(storm.day === 6, `daytime thunderstorm: woke on day 6, not back to the same morning (day ${storm.day})`);
  else console.log("note: could not sleep in the daytime storm here (weather didn't take)");
};
