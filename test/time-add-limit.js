// /time add and /time set refuse more than 2147483647 ticks (vanilla's limit), so a huge value can't break the day counter.
// node test/run.js /tmp/ta test/time-add-limit.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(() => {
    const S = BF.sky, x = c => BF.commands.execute(c);
    const day0 = S.day;
    const huge = [x("/time add 100000000000000000000d"), x("/time add " + "9".repeat(240) + "d"), x("/time add 2147483648"), x("/time set 89479d")];
    const dayAfterHuge = S.day;
    const max = x("/time add 2147483647");
    const dayAfterMax = S.day;
    x("/time set 0");
    const one = x("/time add 1");
    return { day0, huge: huge.map(h => [h.ok, h.msg]), dayAfterHuge, max: [max.ok, max.msg], dayAfterMax, one: one.msg, query: x("/time query daytime").msg };
  });
  console.log(JSON.stringify(r));
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  check(r.huge.every(h => !h[0] && /must not be more than 2147483647/.test(h[1])), "huge /time values are refused");
  check(r.dayAfterHuge === r.day0, "refused values leave the day unchanged");
  check(r.max[0] && [0, 1].includes(r.dayAfterMax - r.day0 - Math.floor(2147483647 / 24000)), "2147483647 ticks is still accepted");
  check(r.one === "Set the time to 1", "/time set 0 then /time add 1 gives 1 (got " + r.one + ")");
  console.log(bad ? "FAIL time-add-limit" : "PASS time-add-limit");
};
