// @ci integration suite=ui hosts=worker,server
// /time set only moves the clock forward, like sleeping: a time of day already past today is tomorrow's (the day counter moves on),
// a later one is today's, the current one changes nothing; each jump logs an INFO line of kind "command".
// node test/run.js /tmp/tsf test/time-set-forward.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await require('./lib').sim(pg, () => {   // (where the simulation is: spec r15-43)
    const S = BF.sky, x = c => BF.commands.execute(c), at = () => [S.day, Math.round(S.time * 24000)];
    const out = {};
    S.setTime(6000 / 24000); const d0 = S.day;
    x("/time set day"); out.dayFromNoon = at().concat(d0);           // past: tomorrow's morning
    x("/time set noon"); out.noonFromDay = at();                      // later today
    x("/time set noon"); out.noonAgain = at();                        // the same time: no change
    x("/time set 1000"); out.ticksPast = at();                        // ticks too
    x("/time set midnight"); x("/time set sunrise"); out.sunrise = at();
    x("/time set 30000"); out.wrap = at();                           // 30000 = 6000 of the next day, past 23000: tomorrow
    out.log = BF.glog.recent(20).filter(e => /\/time set/.test(JSON.stringify(e))).length;
    return out;
  });
  console.log(JSON.stringify(r));
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const d0 = r.dayFromNoon[2];
  check(r.dayFromNoon[0] === d0 + 1 && r.dayFromNoon[1] === 1000, "/time set day at noon goes to the next morning");
  check(r.noonFromDay[0] === d0 + 1 && r.noonFromDay[1] === 6000, "/time set noon in the morning stays on the same day");
  check(r.noonAgain[0] === d0 + 1 && r.noonAgain[1] === 6000, "/time set to the current time changes nothing");
  check(r.ticksPast[0] === d0 + 2 && r.ticksPast[1] === 1000, "/time set <ticks> already past goes to tomorrow");
  check(r.sunrise[0] === d0 + 2 && r.sunrise[1] === 23000, "midnight then sunrise stays on one day");
  check(r.wrap[0] === d0 + 3 && r.wrap[1] === 6000, "/time set 30000 at 23000 goes to 6000 tomorrow");
  check(r.log >= 6, "each /time set logs a command line (" + r.log + ")");
  console.log(bad ? "FAIL time-set-forward" : "PASS time-set-forward");
};
