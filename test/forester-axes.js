// Forester felling time, axes and sticks: NODE_PATH=$(npm root -g) node test/run.js /tmp/fa test/forester-axes.js
// 1. break times and axe ranking; 2. a live forester fells a tree by hand in (logs x 3 s) and with an iron axe in (logs x 0.5 s), wearing the
// axe one use per log; 3. an interrupted felling keeps its progress; 4. it buys the best axe it can afford from a toolsmith and holds it
// (drawn in its hands); 5. it makes sticks from planks, keeps them in stock and sells them.
module.exports = async (pg, out) => {
  const ok = (name, cond, info) => console.log((cond ? "PASS " : "FAIL ") + name + (info !== undefined ? " " + JSON.stringify(info) : ""));
  const unit = await pg.evaluate(() => {
    const F = BF.forester, I = BF.I, B = BF.B;
    const axes = ["wooden_axe", "stone_axe", "iron_axe", "golden_axe", "diamond_axe"].filter(n => I[n] != null);
    const secs = { hand: F.logSeconds(B.oak_log, null) };
    for (const n of axes) secs[n] = F.logSeconds(B.oak_log, { id: I[n] });
    const rank = axes.slice().sort((a, b) => F.axeScore(I[a]) - F.axeScore(I[b]));
    return { secs, rank, player: BF.player.mineSeconds(B.oak_log, I.iron_axe) };
  });
  ok("break times match the player's", unit.secs.hand === 3 && unit.secs.wooden_axe === 1.5 && unit.secs.iron_axe === 0.5 && unit.secs.iron_axe === unit.player, unit.secs);
  ok("axe ranking", unit.rank[0] === "wooden_axe" && unit.rank[unit.rank.length - 1] === "diamond_axe", unit.rank);

  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const setup = await pg.evaluate(() => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child);
    if (vs.length < 2) return "no villagers";
    const T = BF.trades, I = BF.I, B = BF.B, W = BF.world;
    const A = vs[0];
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    W.setBlock(tx, ty, tz, B.band_saw); BF.emit('blockPlaced', tx, ty, tz, B.band_saw);
    BF.mobs.setProfession(A, "forester"); A.xp = 0; A.level = 1; A.trades = T.offers("forester", 1); A.inv = T.inv.create();
    BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: B.band_saw, prof: "forester" } });
    window.__A = A;
    // no other trees near: only the one we grow
    for (const m of BF.mobs.list) if (m !== A && m.type === "villager" && m.profession === "forester") BF.mobs.setProfession(m, "nitwit");
    return { prof: A.profession, jobsite: !!A.jobsite };
  });
  console.log("setup", JSON.stringify(setup));
  if (typeof setup === "string") return;

  // grows an oak about 6-12 blocks from the forester; clears every other natural tree within 70 blocks so it has to fell this one
  const grow = () => pg.evaluate(() => {
    const A = window.__A, B = BF.B, W = BF.world, F = BF.forester;
    for (let i = 0; i < 400; i++) { const t = F.findTree(A); if (!t) break; F._test.fell(null, t, false); }
    for (let r = 6; r < 30; r++) for (let a = 0; a < 6.28; a += 0.2) {
      const x = Math.floor(A.position.x + Math.cos(a) * r), z = Math.floor(A.position.z + Math.sin(a) * r), y = W.heightAt(x, z);
      if (W.getBlock(x, y, z) !== B.grass || ![1, 2, 3, 4, 5, 6, 7, 8, 9].every(k => W.getBlock(x, y + k, z) === 0)) continue;
      W.setBlock(x, y + 1, z, B.oak_sapling);
      if (F.growTree(x, y + 1, z)) { const t = F.treeAt(x, y + 1, z); return t ? { at: t.base, logs: t.logs.length } : null; }
      W.setBlock(x, y + 1, z, 0);
    }
    return null;
  });
  // runs the forester until it fells a tree (or `limit` seconds): seconds spent chopping (task cut, within reach) and the fell log entry
  const watch = (limit, opts) => pg.evaluate(([limit, opts]) => {
    const A = window.__A, F = BF.forester, n0 = F.LOG.length, dt = 0.05;
    A.fo = A.fo || null; const st = A.fo || (BF.forester._test.state(A));
    st.cutCd = 0; st.plantCd = 999; st.shopT = 999; st.gatherCd = 999; st.thinkT = 0; st.sweep = null; if (!opts || !opts.keep) st.task = null;
    for (const d of BF.drops.list.slice()) BF.drops.remove(d);
    let chop = 0, t = 0, fell = null, swings = 0, lastSw = 0, held = null, stop = null;
    for (; t < limit && !fell; t += dt) {
      BF.sky.setTime(opts && opts.offAt != null && t >= opts.offAt && t < opts.offAt + 2 ? 0.6 : 0.1);
      BF.mobs.update(dt);
      BF.player.position.set(A.position.x + 4, A.position.y + 2, A.position.z + 4);
      const k = A.fo && A.fo.task;
      if (k && k.kind === "cut" && Math.hypot(k.x + 0.5 - A.position.x, k.z + 0.5 - A.position.z) <= 3.6 && (k.done > 0 || A.fo.chop > 0)) {
        chop += dt;
        if (A.ai.swingT > lastSw) swings++;
        if (A.heldMesh) held = { visible: A.heldMesh.visible, item: BF.items[A.heldId].name, parent: A.heldMesh.parent === A.meshes.arms };
        if (opts && opts.stopAfter && chop >= opts.stopAfter && !stop) stop = { done: k.done, t };
      }
      lastSw = A.ai.swingT;
      for (let i = n0; i < F.LOG.length; i++) if (F.LOG[i].kind === "fell") fell = F.LOG[i];
    }
    return { chop: +chop.toFixed(2), t: +t.toFixed(1), fell, swings, held, stop, saved: A.fo && A.fo.saved };
  }, [limit, opts || null]);

  // 2a. by hand
  const t1 = await grow();
  console.log("tree", JSON.stringify(t1));
  const r1 = await watch(240);
  console.log("hand", JSON.stringify(r1));
  ok("by hand: logs x 3 s", r1.fell && Math.abs(r1.chop - r1.fell.logs * 3) <= 0.6, { logs: r1.fell && r1.fell.logs, chop: r1.chop });
  ok("swings while chopping", r1.swings >= 5, r1.swings);

  // 2b. iron axe, wears one use per log
  await pg.evaluate(() => { const A = window.__A; A.inv = BF.trades.inv.create(); BF.trades.inv.add(A.inv, BF.I.iron_axe, 1); });
  const t2 = await grow();
  const r2 = await watch(240);
  const wear2 = await pg.evaluate(() => { const s = BF.forester.axeOf(window.__A); return s ? s.wear || 0 : -1; });
  console.log("iron", JSON.stringify(r2), "wear", wear2);
  ok("iron axe: logs x 0.5 s", r2.fell && Math.abs(r2.chop - r2.fell.logs * 0.5) <= 0.4, { logs: r2.fell && r2.fell.logs, chop: r2.chop });
  ok("iron axe wears 1 per log", r2.fell && wear2 === r2.fell.logs, { wear: wear2, logs: r2.fell && r2.fell.logs });
  ok("axe drawn in its hands while chopping", r2.held && r2.held.visible && r2.held.item === "iron_axe" && r2.held.parent, r2.held);

  // 2c. an axe about to break: the rest goes by hand
  await pg.evaluate(() => { const A = window.__A; A.inv = BF.trades.inv.create(); BF.trades.inv.add(A.inv, BF.I.wooden_axe, 1); BF.forester.axeOf(A).wear = BF.durability(BF.I.wooden_axe) - 2; });
  const t3 = await grow();
  const r3 = await watch(240);
  const left3 = await pg.evaluate(() => !!BF.forester.axeOf(window.__A));
  ok("worn-out axe breaks mid-tree, rest by hand", r3.fell && !left3 && Math.abs(r3.chop - (2 * 1.5 + (r3.fell.logs - 2) * 3)) <= 0.6, { logs: r3.fell && r3.fell.logs, chop: r3.chop, axeLeft: left3 });

  // 3. interrupted (a trade): progress kept
  await pg.evaluate(() => { const A = window.__A; A.inv = BF.trades.inv.create(); });
  const t4 = await grow();
  const r4 = await watch(400, { stopAfter: 7, offAt: null });
  ok("hand felling again (control)", r4.fell, r4.chop);
  const t5 = await grow();
  const part = await pg.evaluate(() => {   // chop 7 s, then interrupt it
    const A = window.__A, st = A.fo; st.cutCd = 0; st.thinkT = 0; st.plantCd = 999; st.shopT = 999; st.gatherCd = 999; st.sweep = null; st.task = null;
    for (const d of BF.drops.list.slice()) BF.drops.remove(d);
    let chop = 0;
    for (let t = 0; t < 120 && chop < 7; t += 0.05) { BF.sky.setTime(0.1); BF.mobs.update(0.05); const k = A.fo.task; if (k && k.kind === "cut" && Math.hypot(k.x + 0.5 - A.position.x, k.z + 0.5 - A.position.z) <= 3) chop += 0.05; }
    A.tradingWith = BF.player; BF.forester.ai(A, 0.05, {}); A.tradingWith = null;   // the player opens its trade screen: the task ends, progress kept
    return { saved: A.fo.saved, chop, task: A.fo.task && { kind: A.fo.task.kind, done: A.fo.task.done } };
  });
  console.log("part", JSON.stringify(part));
  const r5 = await watch(240);
  console.log("resume", JSON.stringify(r5));
  ok("interrupted felling resumes", part.saved && part.saved.done >= 2 && r5.fell && r5.fell.at.join() === part.saved.key && r5.chop < r5.fell.logs * 3 - 4, { saved: part.saved, logs: r5.fell && r5.fell.logs, chopAfter: r5.chop });

  // 4. axe shopping: a toolsmith sells iron and diamond axes at its own offers (prices from TRADES.toolsmith)
  const shop = await pg.evaluate(() => {
    const A = window.__A, T = BF.trades, I = BF.I, F = BF.forester;
    const S = BF.mobs.list.find(m => m !== A && m.type === "villager" && m.village === A.village && m.inv && !m.child);
    if (!S) return "no second villager";
    BF.mobs.setProfession(S, "toolsmith"); S.level = 5; S.trades = T.offers("toolsmith", 1).concat(T.offers("toolsmith", 2), T.offers("toolsmith", 3), T.offers("toolsmith", 4), T.offers("toolsmith", 5));
    S.inv = T.inv.create(); T.inv.add(S.inv, I.iron_axe, 1); T.inv.add(S.inv, I.diamond_axe, 1); T.inv.add(S.inv, I.emerald, 3);
    S.position.set(A.position.x + 6, A.position.y, A.position.z + 3);
    A.inv = T.inv.create(); T.inv.add(A.inv, I.wooden_axe, 1); T.inv.add(A.inv, I.emerald, 3);
    // its pack has no food now, so it would spend an emerald on food first and could no longer afford the axe: keep both fed
    for (const m of [A, S]) { const L = BF.food.life(m); L.sat = 5; L.lastAte = BF.food.dayNow(); L.starving = m.starving = false; m.fshop = null; }
    const st = A.fo; st.task = null; st.saved = null; st.sweep = null; st.thinkT = 0; st.shopT = 0; st.cutCd = 999; st.plantCd = 999; st.gatherCd = 999; st.avoid = new Map();
    const res = { first: null, second: null };
    const run = () => { let seen = false, t = 0; for (; t < 120; t += 0.05) { BF.sky.setTime(0.1); BF.mobs.update(0.05); if (A.fo.task) seen = true; else if (seen) break; } return { seen, t: +t.toFixed(1) }; };
    const seller = F._test.findAxeSeller(A, st);
    res.offer = seller && BF.items[seller.offer.sell.id].name;
    res.run1 = run();
    res.first = A.inv.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count);
    res.statusBuy = "buying an axe";
    // richer now: enough for the diamond axe at the toolsmith's price
    res.smith = [S.profession, S.trades.length];
    BF.mobs.setProfession(S, "toolsmith"); S.trades = [1, 2, 3, 4, 5].flatMap(l => T.offers("toolsmith", l)); if (!T.inv.count(S.inv, I.diamond_axe)) T.inv.add(S.inv, I.diamond_axe, 1);
    S.position.set(A.position.x + 5, A.position.y, A.position.z + 2);
    const dPrice = S.trades.filter(o => o.sell.id === I.diamond_axe && o.buy.length === 1 && o.buy[0].id === I.emerald).reduce((p, o) => Math.min(p, o.buy[0].n), Infinity);
    res.diamondPrice = dPrice;
    T.inv.add(A.inv, I.emerald, Math.max(0, dPrice - T.inv.count(A.inv, I.emerald))); st.shopT = 0; st.thinkT = 0;
    res.run2 = run();
    res.second = A.inv.filter(Boolean).map(s => BF.items[s.id].name + "x" + s.count);
    res.holds = F.axeOf(A) && BF.items[F.axeOf(A).id].name;
    res.drawn = A.heldMesh && A.heldMesh.visible && BF.items[A.heldId].name;
    // nothing better on sale: no trip
    st.shopT = 0; st.thinkT = 0; BF.mobs.update(0.05);
    res.thirdTask = A.fo.task && A.fo.task.kind;
    res.log = F.LOG.filter(e => e.kind === "buy").map(e => e.got + " for " + e.paid);
    return res;
  });
  console.log("shop", JSON.stringify(shop));
  ok("buys the best axe it can afford (iron, not gold or diamond, with 3 emeralds)", shop.first && shop.first.includes("iron_axex1"), shop.first);
  ok("upgrades to diamond once it can afford it", shop.holds === "diamond_axe" && shop.drawn === "diamond_axe", { holds: shop.holds, drawn: shop.drawn });
  ok("no trip when nothing better is on sale", shop.thirdTask !== "buy", shop.thirdTask);

  // 5. sticks
  const st = await pg.evaluate(() => {
    const A = window.__A, T = BF.trades, I = BF.I, F = BF.forester, res = {};
    A.inv = T.inv.create(); T.inv.add(A.inv, I.planks, 40); T.inv.add(A.inv, I.birch_planks, 6);
    const S = A.fo; S.sawDay = BF.sky.day; S.stickDay = null;
    F._test.sticks(A, S);
    res.day1 = { sticks: T.inv.count(A.inv, I.stick), planks: T.inv.count(A.inv, I.planks), birch: T.inv.count(A.inv, I.birch_planks) };
    S.sawDay = BF.sky.day + 1; F._test.sticks(A, S);
    res.day2 = T.inv.count(A.inv, I.stick);
    S.sawDay = BF.sky.day + 2; F._test.sticks(A, S);
    res.day3 = T.inv.count(A.inv, I.stick);
    const o = T.offers("forester", 1).find(o => o.sell.id === I.stick);
    res.offer = o && o.buy[0].n + " emerald > " + o.sell.n + " stick";
    res.reason = o && T.blockReason(A, o);
    res.sold = o && T.exchange(A, o);
    res.after = T.inv.count(A.inv, I.stick);
    res.startPackSticks = Array.from({ length: 30 }, () => T.stockFor("forester", {})).filter(a => a.some(s => s && s.id === I.stick)).length;
    return res;
  });
  console.log("sticks", JSON.stringify(st));
  ok("makes 32 sticks a day from planks", st.day1.sticks === 32 && st.day1.planks === 24, st.day1);
  ok("keeps up to 64 sticks", st.day2 === 64 && st.day3 === 64, [st.day2, st.day3]);
  ok("sells 48 sticks for 1 emerald", st.offer === "1 emerald > 48 stick" && st.reason === null && st.sold && st.after === 16, st);
  ok("no sticks in the starting pack", st.startPackSticks === 0, st.startPackSticks);

  // screenshot: the forester chopping with its diamond axe, seen from the side
  await grow();
  await pg.evaluate(() => {
    const A = window.__A, st = A.fo; st.cutCd = 0; st.thinkT = 0; st.plantCd = 999; st.shopT = 999; st.gatherCd = 999; st.task = null; st.sweep = null;
    A.inv = BF.trades.inv.create(); BF.trades.inv.add(A.inv, BF.I.diamond_axe, 1);
    for (let t = 0; t < 120; t += 0.05) { BF.sky.setTime(0.1); BF.mobs.update(0.05); const k = A.fo.task; if (k && k.kind === "cut" && A.fo.chop > 0) break; }
    const k = A.fo.task, fx = A.position.x, fz = A.position.z, tx = k ? k.x + 0.5 : fx + 1, tz = k ? k.z + 0.5 : fz;
    const dx = tx - fx, dz = tz - fz, L = Math.hypot(dx, dz) || 1, px = -dz / L, pz = dx / L;   // stand to the side of the chopping line
    const ex = fx + px * 3.2 + dx / L * 0.6, ez = fz + pz * 3.2 + dz / L * 0.6;
    BF.player.position.set(ex, A.position.y + 0.2, ez);
    BF.player.setLook(Math.atan2(-(fx - ex), -(fz - ez)), -0.12);
    BF.sky.setTime(0.12);
  });
  for (let i = 0; i < 5; i++) { await pg.evaluate(() => { BF.sky.setTime(0.12); window.__A.ai.swingT = 0.2; BF.mobs.update(0.01); }); await pg.waitForTimeout(80); }
  await pg.screenshot({ path: out + '-chop.png' });
};
