// @ci baseline suite=ui hosts=worker,server
// Village nights on the debug screen (js/wildlife.js villageStats): a new world lists no nights before its first sunset, then only
// nights from night 0 on (never Day 0 or negative days), up to the last 7. For test/run.js.
module.exports = async (pg) => {
  const r = await require('./lib').sim(pg, () => {   // (where the simulation is: spec r15-43)
    const rec = [...BF.mobs.villages.values()][0];
    if (!rec) return { err: "no village" };
    const at = (day, time) => { BF.sky.day = day; BF.sky.time = time; return BF.wildlife.villageStats(rec).nights.map(n => n[0]); };
    const o = { morning0: at(0, 0.2), night0: at(0, 0.7), day3: at(3, 0.3), day20: at(20, 0.8) };
    return o;
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(r)));
  ok("no nights before the first sunset", same(r.morning0, []));
  ok("first night only after the first sunset", same(r.night0, [0]));
  ok("day 3 morning lists nights 2..0", same(r.day3, [2, 1, 0]));
  ok("day 20 lists the last 7 nights", same(r.day20, [20, 19, 18, 17, 16, 15, 14]));
};
