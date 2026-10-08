// Village comparison counters test (js/villagestats.js, BF.happiness.week, the feed's compare facts): node test/run.js /tmp/cmp test/compare.js
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
    const S = BF.vstats, H = BF.happiness, L = BF.vlog, p = BF.player.position, rec = L.villageAt(p.x, p.z);
    ok("vstats loaded", !!S && !!rec);
    const pop = BF.breeding.villagerCount(rec), d0 = BF.sky.day;
    S.sample(rec);
    ok("no change with one day on record", S.popChange(rec.key) === null);
    // a population history: 3 days ago it was 4 more
    const ser0 = S.serialize(); ser0[rec.key][Math.floor(BF.sky.day + BF.sky.time) - 3] = pop + 4; S.deserialize(ser0);
    let c = S.popChange(rec.key);
    ok("change over 3 days " + JSON.stringify(c), c && c.change === -4 && c.from === pop + 4 && c.days === 3);
    BF.sky.day += 8; S.sample(rec);
    ok("8 days later the old counts are gone", S.popChange(rec.key) === null && Object.keys(S.serialize()[rec.key]).length === 1);
    BF.sky.day = d0;
    const ser = JSON.parse(JSON.stringify(S.serialize()));
    S.reset(); ok("reset", !S.serialize()[rec.key]);
    S.deserialize(ser); ok("save and load keep the counts", JSON.stringify(S.serialize()) === JSON.stringify(ser));
    S.deserialize(undefined); ok("old saves start empty", Object.keys(S.serialize()).length === 0);
    // last week's events
    const w0 = H.week(rec.key, "birth"), t0 = H.week(rec.key, "trade");
    L.log(rec, "birth", "Test was born to A and B"); L.log(rec, "trade", "Player traded with Test (Farmer): gave 1 Emerald, got 1 Bread");
    ok("births and trades this week", H.week(rec.key, "birth") === w0 + 1 && H.week(rec.key, "trade") === t0 + 1);
    BF.sky.day += 8;
    ok("a week later they've dropped off", H.week(rec.key, "birth") === 0);
    BF.sky.day = d0;
    // the feed carries the table's facts for a loaded village
    S.sample(rec);
    const det = BF.debugFeed.snapshot().detail[rec.key];
    ok("feed detail has week, pop7, noTools, day " + JSON.stringify({ w: det.week, p: det.pop7, n: det.noTools, d: det.day }),
      det.week && det.week.trade >= 1 && det.week.birth >= 1 && "pop7" in det && Array.isArray(det.noTools) && det.noTools[0] <= det.noTools[1] && typeof det.day === "number");
    const m = rec.members.find(x => x.type === "villager" && !x.dead && !x.child && x.position && x.profession === "miner") ||
      rec.members.find(x => x.type === "villager" && !x.dead && !x.child && x.position && x.profession !== "nitwit");
    m.profession = "miner"; m.inv = m.inv.map(s => s && /_pickaxe$/.test(BF.items[s.id].name) ? null : s);
    const n1 = BF.debugFeed.snapshot().detail[rec.key].noTools;
    m.inv[0] = { id: BF.I.iron_pickaxe, count: 1 };
    const n2 = BF.debugFeed.snapshot().detail[rec.key].noTools;
    ok("a miner without a pickaxe counts " + JSON.stringify([n1, n2]), n1[0] === n2[0] + 1 && n1[1] === n2[1]);
    return out;
  });
  console.log(res.join("\n"));
};
