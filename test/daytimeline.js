// A villager's day timeline (js/daytimeline.js): node test/run.js /tmp/daytimeline test/daytimeline.js
// DAYS=2 (env) runs the live part for 2 game days instead of a few game hours (longer than CI's baseline should take).
// Unit: status texts sorted into categories (samples from every job module), stretches opened and closed on text changes, short flickers
// merged, gaps left while unloaded, the clock going backwards, the 2-day and size caps, events from trades, beds, job changes and meals,
// a dead villager's timeline dropped, save and reload, old saves. Live: one village run headless with a villager stuck "Waiting for gold"
// for 2 game hours in the afternoon; its timeline shows that wait at the right length, and real stretches, trades and meals turn up.
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const days = +(process.env.DAYS || 0) || 0.25;
  const res = await pg.evaluate(async (days) => {
    const out = [], ok = (n, c, x) => out.push((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 400) : ""));
    const D = BF.dayTimeline, MIN = 1 / 1440;
    ok("loaded", !!D);
    // ---- categories: one or more real status lines from each module
    const want = {
      work: ["Working at the smithing table", "Harvesting Wheat", "Quarrying stone", "Smelting Iron Ore", "Building: a house", "Making beds", "Baking bread", "Cooking eggs", "Feeding the sheep", "Shearing a sheep", "Milking a cow", "Digging a mineshaft", "Planting", "Tending crops", "Taking ore to a furnace", "Collecting eggs", "Taming a wild horse"],
      trade: ["Buying Bread", "Buying logs", "Selling goods in another village", "Fetching things from their chest", "Putting things away in their chest", "Fetching: 12 Planks", "Delivering a chest", "Taking cobblestone to a builder"],
      walk: ["Walking to the composter", "Heading to bed", "Going to take a job at a cartography table", "Strolling around the village", "Wandering about", "Carrying goods to another village", "Leading a cow home", "Heading out for the day"],
      sleep: ["Sleeping", "Camping for the night", "Camping on the road"],
      wait: ["Waiting for gold", "Looking for: Iron Ingot", "Has no bed to sleep in", "Running from a zombie", "Hungry", "Starving, only trades food", "Inventory full: waiting for a chest from the furniture maker", "Looking for work"],
      idle: ["Relaxing", "Loafing", "Winding down for the evening", "Resting", "In love", "Admiring the work", "Something nobody has written yet"],
    };
    const wrong = [];
    for (const c in want) for (const t of want[c]) if (D.catOf(t) !== c) wrong.push(t + " -> " + D.catOf(t) + " (want " + c + ")");
    ok("status lines sort into the right categories", !wrong.length, wrong);
    // every status line the village's villagers show right now sorts into something
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && m.slot);
    ok("live status lines sort without errors", vs.every(m => typeof D.catOf(BF.villagerStatus.text(m)) === "string"), vs.map(m => BF.villagerStatus.text(m) + ": " + D.catOf(BF.villagerStatus.text(m))));
    // ---- stretches on a fake villager, by hand
    const fake = (i) => ({ type: "villager", village: rec, slot: { idx: 9000 + i }, position: { x: 10, y: 70, z: 20 }, profession: "farmer" });
    const f = fake(1), key = D.keyOf(f), st = { text: "Relaxing" };
    const realText = BF.villagerStatus.text;
    BF.villagerStatus.text = m => m.slot && m.slot.idx >= 9000 ? m.st || st.text : realText(m);
    f.st = null;
    const t0 = 100.25;   // day 100, noon
    const at = (min, text) => { if (text) st.text = text; D.sample(f, t0 + min * MIN); };
    for (let i = 0; i <= 30; i++) at(i, i < 10 ? "Relaxing" : i < 20 ? "Waiting for gold" : "Walking to the composter");
    let L = D.get(key);
    ok("three stretches for three texts", L.s.length === 3 && L.s.map(s => s[3]).join() === "idle,wait,walk", L.s.map(s => s.slice(0, 4)));
    ok("the wait lasted 10 game minutes", Math.abs((L.s[1][1] - L.s[1][0]) / MIN - 10) < 0.01, (L.s[1][1] - L.s[1][0]) / MIN);
    ok("stretches touch end to start", Math.abs(L.s[0][1] - L.s[1][0]) < 1e-6 && Math.abs(L.s[1][1] - L.s[2][0]) < 1e-6);
    ok("a stretch keeps where it was", L.s[0][4] === 10 && L.s[0][5] === 20);
    // flicker: one sample of another text folds back
    at(31, "Walking to the composter"); at(32, "Relaxing"); at(33, "Walking to the composter"); at(34, "Walking to the composter");
    L = D.get(key);
    ok("a one-sample flicker merges into its neighbour", L.s.length === 3 && L.s[2][2] === "Walking to the composter", L.s.map(s => s[2]));
    // unloaded: no samples for an hour, then back
    at(100, "Walking to the composter");
    L = D.get(key);
    ok("a gap while unloaded is left empty (a new stretch after it)", L.s.length === 4 && Math.abs(L.s[3][0] - (t0 + 100 * MIN)) < 2e-5 && L.s[2][1] < t0 + 40 * MIN, L.s.map(s => [s[0], s[1], s[2]]));
    // the clock going backwards
    D.sample(f, t0 - 0.1);
    L = D.get(key);
    ok("the clock going backwards starts a fresh timeline", L.s.length === 1 && L.s[0][0] === Math.round((t0 - 0.1) * 1e5) / 1e5);
    // 2-day cap: three days of hourly changes keep only today and yesterday
    const g = fake(2), gk = D.keyOf(g);
    for (let h = 0; h < 72; h++) { g.st = h % 2 ? "Relaxing" : "Quarrying stone"; D.sample(g, 200 + h / 24); D.sample(g, 200 + h / 24 + 2 * MIN); }
    L = D.get(gk);
    ok("only today and yesterday are kept", L.s[0][1] >= 201 && L.s.length < 72 && L.s.length >= 40, [L.s[0][0], L.s.length]);
    // size cap
    const c = fake(3), ck = D.keyOf(c);
    for (let i = 0; i < 1000; i++) { c.st = "Text " + (i % 2); D.sample(c, 300 + i * 2 * MIN); }
    ok("at most 400 stretches", D.get(ck).s.length === 400, D.get(ck).s.length);
    for (let i = 0; i < 300; i++) D.event(c, "trade", "trade " + i);
    ok("at most 200 events, oldest dropped", D.get(ck).e.length === 200 && D.get(ck).e[0][2] === "trade 100");
    // ---- events from the game: trades, beds, job changes, meals
    const [a, b] = vs.filter(m => !m.child);
    const ev = m => (D.get(D.keyOf(m)) || { e: [] }).e;
    const n0 = ev(a).length, nb = ev(b).length;
    BF.vlog.trade(a, b, { buy: [{ id: BF.I.emerald, n: 1 }], sell: { id: BF.I.bread, n: 3 } }, 1);
    ok("a trade shows on both villagers' days", ev(a).length === n0 + 1 && ev(b).length === nb + 1 && ev(a).slice(-1)[0][1] === "trade" && /traded with/.test(ev(a).slice(-1)[0][2]), ev(a).slice(-1));
    BF.vlog.trade("player", b, { buy: [{ id: BF.I.emerald, n: 1 }], sell: { id: BF.I.bread, n: 3 } }, 1);
    ok("a trade with the player shows on the villager's day", ev(b).length === nb + 2);
    BF.vlog.bed(a, 1, 64, 2);
    ok("a bed placed", ev(a).slice(-1)[0][1] === "bed" && ev(a).slice(-1)[0][3] === 1);
    BF.vlog.profession(a, "unemployed", "farmer");
    ok("a job change", ev(a).slice(-1)[0][1] === "job" && /became a Farmer/.test(ev(a).slice(-1)[0][2]));
    BF.trades.inv.add(a.inv, BF.I.bread, 2);
    const life = BF.food.life(a); life.sat = 0;
    BF.food.eat(a, 1);
    ok("a meal", ev(a).slice(-1)[0][1] === "meal" && /^Ate \w/.test(ev(a).slice(-1)[0][2]), ev(a).slice(-1));
    // ---- save and reload, old saves
    const saved = JSON.parse(JSON.stringify(D.serialize()));
    ok("saved with the world", saved[D.keyOf(a)] && saved[gk] && saved[gk].s.length === D.get(gk).s.length);
    const before = JSON.stringify(D.get(gk).s);
    D.deserialize(saved);
    ok("reload keeps timelines", JSON.stringify(D.get(gk).s) === before && D.get(D.keyOf(a)).e.length === saved[D.keyOf(a)].e.length, [before.slice(0, 120), JSON.stringify(D.get(gk).s).slice(0, 120)]);
    D.deserialize(undefined);
    ok("old saves load empty", D.keys().length === 0);
    D.deserialize({ junk: 1, x: { s: "no", e: [] } });
    ok("bad data is skipped", D.keys().length === 0);
    const sd = BF.save && BF.save.serialize ? BF.save.serialize() : null;
    ok("the world save carries days", !sd || "days" in sd);
    // ---- a dead villager's timeline goes
    D.reset();
    D.sample(b);
    ok("timeline before death", !!D.get(D.keyOf(b)));
    D.drop(b);
    ok("dropped on death", !D.get(D.keyOf(b)));
    BF.villagerStatus.text = realText;
    // ---- live: run the village headless; one villager is stuck "Waiting for gold" from 13:00 to 15:00
    D.reset();
    const v = vs.find(m => !m.child && m !== a) || vs[0], vk = D.keyOf(v);
    BF.sky.day = Math.floor(BF.sky.day) + 1; BF.sky.time = 0.20;   // 10:48
    const day = BF.sky.day, from = day + 7 / 24, to = day + 9 / 24;  // 13:00 to 15:00 (a game day starts at 06:00)
    BF.villagerStatus.text = m => { const t = BF.sky.day + BF.sky.time; return m === v && t >= from && t < to ? "Waiting for gold" : realText(m); };
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); D.update(); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim(); };
    const end = BF.sky.day + BF.sky.time + days, wall = performance.now();
    let waits = null;   // the stuck villager's waits, read an hour after they ended (a 2-day run drops that day by the end)
    while (BF.sky.day + BF.sky.time < end) {
      for (let i = 0; i < 400; i++) step(0.05);
      if (!waits && BF.sky.day + BF.sky.time > to + 1 / 24) waits = JSON.parse(JSON.stringify(D.get(vk).s.filter(s => s[2] === "Waiting for gold")));
      await new Promise(r => setTimeout(r, 0)); if (performance.now() - wall > 1.5e6) break;
    }
    BF.villagerStatus.text = realText;
    const T = D.get(vk);
    waits = waits || [];
    // It starts on the minute; the end can run a few minutes over, since a status seen at only one sample right after
    // 15:00 merges into the stretch before it (SHORT in js/daytimeline.js), so the length is checked to the nearest hour.
    const wlen = waits.reduce((n, s) => n + s[1] - s[0], 0) / MIN;
    ok(`the stuck villager's timeline shows "Waiting for gold" for 2 game hours (${Math.round(wlen)} min)`, waits.length === 1 && Math.round(wlen / 60) === 2 && Math.abs(waits[0][0] - from) <= 2 * MIN && waits[0][3] === "wait", waits.map(s => [BF.vlog.stamp(s[0]), BF.vlog.stamp(s[1])]));
    const all = D.keys().map(k => D.get(k));
    const cats = {}, evk = {};
    for (const L2 of all) { for (const s of L2.s) cats[s[3]] = (cats[s[3]] || 0) + (s[1] - s[0]); for (const e of L2.e) evk[e[1]] = (evk[e[1]] || 0) + 1; }
    ok(`every loaded villager has a timeline (${all.length} of ${vs.length})`, all.length >= vs.filter(m => !m.dead && !m.removed).length - 1);
    ok("stretches cover the run with no overlaps", all.every(L2 => L2.s.every((s, i) => s[1] >= s[0] && (!i || s[0] >= L2.s[i - 1][1] - 1e-6))));
    ok("real work, walking and idle stretches turn up", (cats.work || 0) > 0 && (cats.walk || 0) > 0, Object.fromEntries(Object.entries(cats).map(([k, x]) => [k, Math.round(x * 1440)])));
    if (days >= 2) ok("after 2 days only today and yesterday are kept", all.every(L2 => !L2.s.length || L2.s[0][1] >= Math.floor(BF.sky.day + BF.sky.time) - 1), all.map(L2 => L2.s.length && L2.s[0][0]).slice(0, 5));
    if (days >= 1) ok("meals and trades turn up as events", (evk.meal || 0) > 0 && (evk.trade || 0) > 0, evk);
    out.push(`INFO ran ${days} game days in ${Math.round((performance.now() - wall) / 1000)} s; minutes by category ${JSON.stringify(Object.fromEntries(Object.entries(cats).map(([k, x]) => [k, Math.round(x * 1440)])))}; events ${JSON.stringify(evk)}; stretches per villager ${Math.round(all.reduce((n, L2) => n + L2.s.length, 0) / all.length)}`);
    out.push("INFO stuck villager's day: " + T.s.filter(s => s[1] - s[0] >= 20 * MIN).slice(-14).map(s => BF.vlog.stamp(s[0]).slice(-5) + " " + Math.round((s[1] - s[0]) / MIN) + "m " + s[2]).join(" | "));
    const sv = JSON.stringify(D.serialize()).length;
    out.push(`INFO saved size ${sv} bytes for ${all.length} villagers`);
    return out;
  }, days);
  for (const l of res) console.log(l);
};
