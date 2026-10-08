// Economy tallies test (js/economy.js): node test/run.js /tmp/econ test/economy.js
// Scripted trades must add up to the same counts as the village log's trade lines; waits count once per villager, item and game hour;
// unsold stock shows after 2 days; the 8th day drops off; save and load keep it all; old saves start empty; the debug feed sends it.
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
    const E = BF.econ, L = BF.vlog, I = BF.I, p = BF.player.position, rec = L.villageAt(p.x, p.z);
    ok("econ loaded", !!E);
    ok("player is inside a village", !!rec);
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child && m.slot);
    ok("villagers", vs.length >= 4);
    const sum = () => { let n = 0, em = 0, t = 0; for (const e of E.days(rec.key).values()) for (const k in e.f) { n += e.f[k][0]; em += e.f[k][1]; t += e.f[k][2]; } return { n, em: Math.round(em * 100) / 100, t }; };
    // ---- trades, all within this one call so no villager trades in between
    const t0 = sum(), logFrom = L.entries(rec.key).length;
    const [a, b, c, d] = vs;
    const prof = m => L.pretty(m.profession);
    const offer = { buy: [{ id: I.emerald, n: 2 }], sell: { id: I.planks, n: 8 } };
    L.trade(a, b, offer, 3);                                                  // b sells 24 planks to a for 6 emeralds, 3 trades
    L.trade(c, d, "gave 2 Emerald, got 16 Wheat", 2);                          // d sells 16 wheat to c (text form, as villagelife.js logs it)
    BF.emit("villagerTrade", b, { buy: [{ id: I.emerald, n: 1 }], sell: { id: I.bread, n: 4 } });   // the player buys 4 bread from b
    L.trade("player", c, { buy: [{ id: I.wheat_item, n: 20 }], sell: { id: I.emerald, n: 1 } }, 2);  // c buys 40 wheat from the player for 2 emeralds
    L.trade(a, b, { buy: [{ id: I.oak_log, n: 1 }], sell: { id: I.cobblestone, n: 4 } }, 1);        // barter: logs for cobblestone, no emeralds
    const t1 = sum();
    // the log's trade lines added up the same way
    const lines = L.entries(rec.key).slice(logFrom).filter(e => e[1] === "trade");
    let ln = 0, lem = 0;
    for (const e of lines) {
      const r = /: gave (.+?), got (.+)$/.exec(e[2]);
      for (const st of (r ? r[1] + " + " + r[2] : "").split(" + ")) { const m = /^(\d+) (.+)$/.exec(st.trim()); if (!m) continue; if (m[2] === "Emerald") lem += +m[1]; else ln += +m[1]; }
    }
    ok("5 trade lines logged", lines.length === 5);
    ok(`tally items = log items (${t1.n - t0.n} / ${ln})`, t1.n - t0.n === ln);
    ok(`tally emeralds = log emeralds (${t1.em - t0.em} / ${lem})`, Math.abs(t1.em - t0.em - lem) < 1e-6);
    ok(`trade count (${t1.t - t0.t})`, t1.t - t0.t === 3 + 2 + 1 + 2 + 1 + 1);   // the barter moves goods both ways: one trade on each band
    const today = E.days(rec.key).get(Math.floor(BF.sky.day + BF.sky.time));
    const f = (s, by, id) => today.f[s + "|" + by + "|" + id];
    ok("planks seller -> buyer", f(prof(b), prof(a), I.planks) && f(prof(b), prof(a), I.planks)[0] >= 24);
    ok("player buying bread", f(prof(b), "Player", I.bread) && f(prof(b), "Player", I.bread)[1] >= 1);
    ok("villager buying wheat from the player flows player -> villager", f("Player", prof(c), I.wheat_item) && f("Player", prof(c), I.wheat_item)[0] >= 40 && f("Player", prof(c), I.wheat_item)[1] >= 2);
    ok("barter both ways", f(prof(b), prof(a), I.cobblestone) && f(prof(a), prof(b), I.oak_log));
    // profession at the time of the trade, and dead villagers keep their trades
    const was = prof(d);
    d.profession = d.profession === "librarian" ? "mason" : "librarian";
    ok("profession change keeps the old job's flow", !!f(was, prof(c), I.wheat_item));
    BF.mobs.hurt(a, 999, "a test");
    ok("a dead villager's trades stay", sum().n === t1.n);
    // ---- wanted: once per villager, item and game hour; a wait seen again a few hours later counts the hours between
    const w0 = today.w[prof(c) + "|Gold"] || 0;
    E.want(c, "Gold"); E.want(c, "Gold");
    ok("one count per hour", today.w[prof(c) + "|Gold"] - w0 === 1);
    BF.sky.time += 3 / 24;
    E.want(c, "Gold");
    ok("catch-up over 3 hours", Math.floor(BF.sky.day + BF.sky.time) !== Math.floor(BF.sky.day + BF.sky.time - 3 / 24) || today.w[prof(c) + "|Gold"] - w0 === 4);
    // ---- stuck: stock held for sale that hasn't sold for 2 days
    const s = vs.find(m => m !== a && m !== c && m.inv);
    s.trades = [{ buy: [{ id: I.emerald, n: 1 }], sell: { id: I.cobblestone, n: 16 }, maxUses: 99, uses: 0 }];
    s.inv[s.inv.length - 1] = { id: I.cobblestone, count: 40 };   // a slot of its own: its pack may be full
    E.scan(rec);
    ok("not stuck on day 0", !E.days(rec.key).get(Math.floor(BF.sky.day + BF.sky.time)).s.some(r => r[0] === L.nameOf(s)));
    BF.sky.day += 2;
    E.scan(rec);
    const st = E.days(rec.key).get(Math.floor(BF.sky.day + BF.sky.time)).s.find(r => r[0] === L.nameOf(s));
    ok("stuck after 2 days: " + JSON.stringify(st), st && st[2] === I.cobblestone && st[3] >= 40 && st[4] >= 2);
    L.trade(c, s, s.trades[0], 1);
    BF.sky.day += 1; E.scan(rec);
    ok("a sale restarts the clock", !E.days(rec.key).get(Math.floor(BF.sky.day + BF.sky.time)).s.some(r => r[0] === L.nameOf(s) && r[2] === I.cobblestone));
    // ---- the feed's view
    const v = E.view(rec.key), vd = v.days[v.today];
    ok("view has names and groups", vd && vd.s !== undefined && Object.values(v.days).some(x => x.f.some(r => r[2] === BF.itemName(I.planks) && r[3] === "wood")));
    ok("groups", E.group(I.oak_log) === "wood" && E.group(I.cobblestone) === "stone" && E.group(I.iron_ingot) === "ore" && E.group(I.bread) === "food" &&
      E.group(I.iron_pickaxe) === "tools" && E.group(I.white_wool) === "wool" && E.group("Pickaxe") === "tools" && E.group("Food") === "food");
    // ---- save and load
    const ser = JSON.parse(JSON.stringify(E.serialize())), before = JSON.stringify(E.view(rec.key));
    E.reset(); ok("reset empties", E.days(rec.key).size === 0);
    E.deserialize(ser); ok("save and load keep the tallies", JSON.stringify(E.view(rec.key)) === before);
    E.deserialize(undefined); ok("old saves start empty", E.days(rec.key).size === 0);
    E.deserialize(ser);
    // ---- 7 days kept: the 8th drops off
    const base = Math.floor(BF.sky.day + BF.sky.time), dayFrac = BF.sky.time;
    for (let i = 1; i <= 8; i++) { BF.sky.day += 1; E.want(c, "Iron"); }
    const ds = [...E.days(rec.key).keys()].sort((x, y) => x - y);
    ok("7 days kept " + JSON.stringify(ds), ds.length === 7 && ds[0] === base + 2 && ds[6] === base + 8);
    ok("view keeps 7", Object.keys(E.view(rec.key).days).length === 7);
    // ---- the debug feed sends the tallies only when they change
    if (BF.debugFeed) {
      const s1 = BF.debugFeed.snapshot(), s2 = BF.debugFeed.snapshot();
      E.want(b.dead ? c : b, "Wool");
      const s3 = BF.debugFeed.snapshot();
      ok("feed sends tallies once, then on change", s1.econ && s1.econ[rec.key] && !(s2.econ && s2.econ[rec.key]) && s3.econ && s3.econ[rec.key]);
    } else ok("feed sends tallies (no feed here: skipped)", true);
    BF.sky.time = dayFrac;
    return out;
  });
  console.log(res.join("\n"));
};
