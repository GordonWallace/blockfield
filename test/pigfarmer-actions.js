// Pigs, sties and the pig farmer (js/pigfarmer.js, board idea-042): village generator 9 (the default) gives about 60% of the grass villages of
// 10+ a pig farmer and a sty (old saves none); the sty (gate, coarse dirt, water trough, roofed shelter, 2-4 pigs, one pig per 8 cells); its
// starting pack (feed and emeralds only) and trades; breeding on carrots, potatoes and beetroot, piglets (no drops, grown in 3 days, feeding
// ages them 10%), pigs following a player holding feed; feeding and culling to the sty's limit (never below 2 adults, 1-3 raw porkchops each)
// with feed it bought; fetching a wild pig into an empty sty; cooking pork in a real furnace with fuel it bought; the butcher buying raw pork;
// the builder's sty and an unemployed villager taking the job; save and load, and the village unloading and loading again. Usage:
//   NODE_PATH=$(npm root -g) node test/run.js /tmp/out test/pigfarmer-actions.js
// @ci integration suite=farming,village timeout=900
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const day = () => BF.sky.day + BF.sky.time;
    const PF = BF.pigFarmer, I = BF.I, T = BF.trades;
    const rosterOf = v => BF.mobs.roster({ key: Math.round(v.x) + "," + Math.round(v.z), houses: v.houses || [], nb: v.nb0 != null ? v.nb0 : v.buildings.length, pop: v.pop || 0, ground: v.ground });
    BF.state.paused = true;

    // ---- generated villages: about 60% of the grass villages of 10+ (deterministic per village), none in a world saved with generator 8
    let elig = 0, withPF = 0, wrong = [], again = 0;
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      BF.newWorld(seed, { gen: 3, villages: 9 });
      for (const v of BF.worldgen.villagesNear(0, 0, 2400)) {
        const pf = rosterOf(v).some(sl => sl.prof === "pig_farmer"), st = v.buildings.some(b => b.type === "sty");
        if (v.ground === 0 && v.pop >= 10) { elig++; if (pf) withPF++; }
        else if (pf || st) wrong.push([seed, v.x, v.z, v.pop, v.ground]);
        if (pf !== st) wrong.push([seed, v.x, v.z, "sty", st, "pig farmer", pf]);
        if (pf && rosterOf(v).filter(sl => sl.prof === "pig_farmer").length !== 1) wrong.push([seed, v.x, v.z, "count"]);
        if (pf && rosterOf(v).some(sl => sl.prof === "pig_farmer") !== pf) again++;
      }
    }
    ok("generator 9: a pig farmer and a sty only in grass villages of 10+, one each", wrong.length === 0, wrong.slice(0, 4));
    ok("in about 60% of them", elig >= 40 && Math.abs(withPF / elig - 0.6) < 0.12, { withPF, elig, share: +(withPF / elig).toFixed(2) });
    ok("the same village always gets the same answer", again === 0);
    BF.newWorld(1, { gen: 3, villages: 8 });
    let old = 0;
    for (const v of BF.worldgen.villagesNear(0, 0, 2400)) old += rosterOf(v).filter(sl => sl.prof === "pig_farmer").length + v.buildings.filter(b => b.type === "sty").length;
    ok("worlds saved with generator 8 get no pig farmers or sties", old === 0, old);

    BF.newWorld(1, { gen: 3, villages: 9, gameMode: "survival" });
    ok("new worlds use village generator 9", BF.state.villages === 9, BF.state.villages);
    BF.mobs.spawning = false;
    const V = { x: -1, z: -72 };   // seed 1: a village of 22 on the plains with a pasture and a sty
    const wv = BF.worldgen.villagesNear(V.x, V.z, 40).find(v => Math.round(v.x) === V.x && Math.round(v.z) === V.z);
    const sb = wv && wv.buildings.find(b => b.type === "sty");
    ok("the village layout has a sty (grass, 10+ villagers)", !!sb && wv.ground === 0 && wv.pop >= 10, wv && [wv.pop, wv.ground]);
    if (!sb) return R;
    BF.player.teleport(sb.doorX + 0.5, BF.worldgen.heightAt(sb.doorX, sb.doorZ) + 3, sb.doorZ - 3.5);
    const load = async (x, z) => { for (let i = 0; i < 400; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0 && BF.world.isLoaded(x, z)) break; } };
    await load(sb.doorX, sb.doorZ);
    BF.player.invulnerable = true;
    BF.sky.setTime(0.03);
    run(2);
    const key = V.x + "," + V.z;
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(key) || { members: [] }).members.some(m => m.profession === "pig_farmer")); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(key);
    const vill = () => rec.members.filter(m => m.type === "villager" && !m.dead && !m.removed);
    const pf = rec && rec.members.find(m => m.type === "villager" && m.profession === "pig_farmer");
    ok("the village has a pig farmer", !!pf, rec && vill().map(m => m.profession).join(","));
    if (!pf) return R;
    const c = (n, m = pf) => T.inv.count(m.inv, I[n]);
    ok("its starting pack: feed and emeralds, no pork", PF.feedHeld(pf) >= 6 && c("emerald") > 0 && !c("raw_porkchop") && !c("cooked_porkchop"), pf.inv.filter(Boolean).map(s => BF.items[s.id].name + ":" + s.count));
    const P = PF.styOf(pf);
    ok("its feed trough stands beside the sty gate", !!P && BF.world.getBlock(pf.jobsite.x, pf.jobsite.y, pf.jobsite.z) === BF.B.feed_trough && Math.hypot(pf.jobsite.x - P.out[0], pf.jobsite.z - P.out[1]) <= 2, [pf.jobsite, P && P.out]);
    if (!P) return R;
    run(2);
    ok("a generated sty starts with 2-4 pigs", P.pigs.length >= 2 && P.pigs.length <= 4, P.pigs.length);
    ok("it holds one pig per 8 cells (7x8 fence, 5x5 inside: 3)", P.limit === Math.max(2, Math.floor(P.cells / 8)) && P.cells === 25 && P.limit === 3, [P.cells, P.limit]);
    ok("its pigs are spawned inside", P.pigs.every(s => s.mob && s.mob.position.x > P.x0 && s.mob.position.x < P.x1 && s.mob.position.z > P.z0 && s.mob.position.z < P.z1));
    const gateB = BF.blocks[BF.world.getBlock(P.gate[0], P.y + 1, P.gate[1])];
    ok("the sty has a gate", !!(gateB && gateB.gate), gateB && gateB.name);
    let water = 0, mud = 0, roof = 0;
    for (let x = P.fx0; x < P.fx1; x++) for (let z = P.fz0; z < P.fz1; z++) {
      for (let y = P.y - 1; y <= P.y + 1; y++) { const b = BF.world.getBlock(x, y, z); if (b === BF.B.water) water++; if (b === BF.B.coarse_dirt) mud++; }
      for (let y = P.y + 2; y <= P.y + 4; y++) if (/planks/.test(BF.blocks[BF.world.getBlock(x, y, z)].name)) roof++;
    }
    ok("a water trough, a coarse-dirt corner and a small roofed shelter", water >= 2 && mud >= 4 && roof >= 6, { water, mud, roof });
    ok("its level 1 trades: raw and cooked porkchops, carrots and potatoes bought", ["raw_porkchop", "cooked_porkchop"].every(n => T.TRADES.pig_farmer[0].some(o => /> \d+ /.test(o) && o.endsWith(" " + n))) && ["carrot", "potato"].every(n => T.TRADES.pig_farmer[0].some(o => o.includes(" " + n + " >"))), T.TRADES.pig_farmer[0]);
    ok("level 2: cooked porkchops in bulk, beetroot bought", T.TRADES.pig_farmer[1].some(o => /^2 emerald > \d+ cooked_porkchop$/.test(o)) && T.TRADES.pig_farmer[1].some(o => /beetroot >/.test(o)), T.TRADES.pig_farmer[1]);
    ok("nothing from nothing: no restocked wares", (T.PRODUCE.pig_farmer || []).length === 0);
    {
      const v = { profession: "pig_farmer", inv: T.stockFor("pig_farmer", {}), trades: [], level: 2, xp: 0 };
      const before = ["raw_porkchop", "cooked_porkchop", "carrot", "potato", "beetroot"].map(n => T.inv.count(v.inv, I[n]));
      T.restock(v, 1); T.restock(v, 5);
      const after = ["raw_porkchop", "cooked_porkchop", "carrot", "potato", "beetroot"].map(n => T.inv.count(v.inv, I[n]));
      ok("the daily restock gives it no pork and no feed", after.every((n, i) => n <= before[i]) && after[0] === 0 && after[1] === 0, { before, after });
    }

    // ---- breeding: fed with a carrot, potato or beetroot; two willing adults; piglets
    const spot = (dx, dz) => { const x = Math.floor(P.out[0] + dx), z = Math.floor(P.out[1] + dz), y = BF.world.heightAt(x, z) + 1; return [x + 0.5, y, z + 0.5]; };
    const dry = (x, z) => { const h = BF.world.heightAt(x, z); return BF.world.getBlock(x, h, z) !== BF.B.water && BF.world.getBlock(x, h + 1, z) === 0 && BF.world.getBlock(x, h + 2, z) === 0; };
    const flatAt = (r0, r1, walk) => {   // a flat, dry 5x5 patch r0-r1 blocks from the sty's gate, clear of the village's buildings (walk: a short walk from the gate)
      const bl = wv.buildings;
      for (let r = r0; r < r1; r++) for (let dx = -r; dx <= r; dx++) for (const dz of [-r, r]) {
        const x0 = Math.floor(P.out[0] + dx), z0 = Math.floor(P.out[1] + dz), h = BF.world.heightAt(x0, z0);
        if (bl.some(b => b.x0 != null && x0 > b.x0 - 4 && x0 < b.x1 + 4 && z0 > b.z0 - 4 && z0 < b.z1 + 4)) continue;
        let good = true;
        for (let a = -2; a <= 2 && good; a++) for (let b = -2; b <= 2 && good; b++) if (BF.world.heightAt(x0 + a, z0 + b) !== h || !dry(x0 + a, z0 + b)) good = false;
        if (good && walk) {
          const rt = BF.mobs.nav.findPath(P.out[0], P.y + 1, P.out[1], { x: x0, z: z0, at: (cx, cy, cz) => Math.abs(cx - x0) <= 1 && Math.abs(cz - z0) <= 1 }, 12000);
          if (!rt || rt.length > 1.4 * Math.hypot(dx, dz) + 4) good = false;
        }
        if (good) return [dx, dz];
      }
      return null;
    };
    const flat = flatAt(10, 30);
    ok("a flat spot outside the sty", !!flat, flat);
    if (!flat) return R;
    const wildAt = (dx, dz) => { const [x, y, z] = spot(dx, dz); return BF.mobs.spawn("pig", x, y, z); };
    const wa = wildAt(flat[0], flat[1]), wb = wildAt(flat[0] + 1, flat[1]);
    let wildBorn = 0, piglet = null;
    BF.on("pigBorn", (pl, a, b) => { if (a === wa || a === wb || b === wa || b === wb) { wildBorn++; piglet = pl; } });
    run(6);
    ok("two unfed pigs side by side do not breed", wildBorn === 0 && !PF.willing(wa, day()));
    ok("wheat is no pig feed", !PF.isFeed(I.wheat_item) && PF.isFeed(I.carrot) && PF.isFeed(I.potato) && PF.isFeed(I.beetroot));
    PF.feed(wa, "test");
    run(6);
    ok("one fed pig alone does not breed", wildBorn === 0 && PF.willing(wa, day()) && !PF.willing(wb, day()));
    if (Math.hypot(wa.position.x - wb.position.x, wa.position.z - wb.position.z) > 4) { const [x, y, z] = spot(flat[0], flat[1]); wa.position.set(x, y, z); const s2 = spot(flat[0] + 1, flat[1]); wb.position.set(s2[0], s2[1], s2[2]); }   // they wandered apart while one was fed: back side by side (mates look within 10 blocks)
    PF.feed(wb, "test");
    for (let i = 0; i < 1200 && !wildBorn; i++) step();
    ok("two fed adults breed: a piglet", wildBorn === 1 && !!piglet, { wildBorn, willing: [PF.willing(wa, day()), PF.willing(wb, day())], d: +Math.hypot(wa.position.x - wb.position.x, wa.position.z - wb.position.z).toFixed(2),
      dy: +(wa.position.y - wb.position.y).toFixed(2), mate: [wa.mate === wb, wb.mate === wa], sty: [!!wa.sty, !!wb.sty], led: [!!wa.ledBy, !!wb.ledBy], crowd: BF.herd.crowd(wa) });
    ok("both then rest a day", !PF.willing(wa, day()) && wa.pig.cd >= day() + PF.BREED_CD - 0.05, [wa.pig.cd, day()]);
    if (piglet) {
      ok("a piglet is smaller and cannot breed", piglet.piglet && piglet.model.scale.x < 0.9 && !PF.willing(piglet, day()), piglet.model.scale.x);
      const was = piglet.pig.growAt;
      ok("it grows up in 3 days", Math.abs(was - (day() + PF.PIGLET_DAYS)) < 0.05, [was, day()]);
      PF.feed(piglet, "test");
      ok("feeding a piglet ages it by 10%", Math.abs(was - piglet.pig.growAt - PF.PIGLET_DAYS * 0.1) < 1e-6 && !PF.willing(piglet, day()), [was, piglet.pig.growAt]);
      const pork0 = BF.inventory.count(I.raw_porkchop);
      const lit = wildAt(flat[0], flat[1] + 1); lit.pig = { fed: null, cd: day() + 3, growAt: day() + 2, x: null, z: null, mob: lit }; PF.syncLook(lit);
      BF.mobs.kill(lit);
      ok("a piglet drops nothing", BF.inventory.count(I.raw_porkchop) === pork0 && lit.piglet, BF.inventory.count(I.raw_porkchop) - pork0);
      const dd = BF.sky.day; BF.sky.day = dd + PF.PIGLET_DAYS + 1; run(1); const grown = piglet.pig.growAt == null && !piglet.piglet && piglet.model.scale.x > 0.95; BF.sky.day = dd;
      ok("and is an adult after 3 days", grown, piglet.model.scale.x);
    }
    // the crowding rule: no breeding with 24 pigs within 16 blocks (30 placed: a few wander off during the run)
    {
      const crowd = [];
      for (let i = 0; i < 30; i++) crowd.push(wildAt(flat[0] + (i % 5) - 2, flat[1] + Math.floor(i / 5) - 2));
      for (const m of [wa, wb]) { m.pig.cd = 0; PF.feed(m, "test"); }
      let crowdBorn = 0;
      const cb = () => crowdBorn++;
      BF.on("pigBorn", cb);
      run(12);
      ok("no breeding with 24 pigs within 16 blocks", crowdBorn === 0 && BF.herd.crowd(wa) >= BF.herd.LOCAL_MAX, [crowdBorn, BF.herd.crowd(wa)]);
      for (const m of crowd) if (m && !m.dead) BF.mobs.hurt(m, 999, "test");
    }

    // ---- the player: feed by right-click, pigs follow a player holding feed
    BF.inventory.clear();
    BF.inventory.setSlot(0, { id: I.beetroot, count: 10 });
    BF.inventory.select(0);
    const pp = wildAt(flat[0] - 1, flat[1] - 1);
    const r2 = PF.playerUse(pp, BF.inventory.selected());
    ok("right-clicking a pig with beetroot feeds it", r2 === true && PF.willing(pp, day()) && BF.inventory.count(I.beetroot) === 9, r2);
    const r3 = PF.playerUse(pp, BF.inventory.selected());
    ok("a fed pig is not hungry", typeof r3 === "string" && BF.inventory.count(I.beetroot) === 9, r3);
    BF.player.teleport(pp.position.x + 7, pp.position.y + 0.2, pp.position.z);
    const f0 = Math.hypot(pp.position.x - BF.player.position.x, pp.position.z - BF.player.position.z);
    run(4);
    const f1 = Math.hypot(pp.position.x - BF.player.position.x, pp.position.z - BF.player.position.z);
    ok("a pig follows a player holding feed", f1 < f0 - 2, [f0.toFixed(1), f1.toFixed(1)]);
    BF.inventory.clear();
    for (const m of BF.mobs.list.slice()) if (m.type === "pig" && !m.sty && !m.dead) BF.mobs.hurt(m, 999, "test");
    BF.player.teleport(P.out[0] + 0.5, BF.world.heightAt(P.out[0], P.out[1] - 4) + 2, P.out[1] - 4.5);
    run(1);

    // ---- feed comes from the farmers: a pig farmer short of feed buys it through a farmer's offer
    const stash = [];
    for (let i = 0; i < pf.inv.length; i++) { const s = pf.inv[i]; if (s && PF.isFeed(s.id)) { stash.push(s); pf.inv[i] = null; } }
    if (c("emerald") < 4) T.inv.add(pf.inv, I.emerald, 4 - c("emerald"));
    const farmer = vill().find(m => m.profession === "farmer");
    ok("with no feed it wants to buy some", PF.feedWanted(pf) > 0, PF.feedWanted(pf));
    let fd = null;
    if (farmer) {
      T.inv.add(farmer.inv, I.carrot, 40); T.syncFeed(farmer, true);
      pf.fshop = pf.fshop || { stage: null, deal: null, checkT: 9, avoid: {}, cd: 0 }; pf.fshop.avoid = {};
      fd = BF.villageLife._test.findWheatSeller(pf);
      ok("it finds a feed seller's offer", !!fd && PF.isFeed(fd.item) && !!fd.offer && fd.offer.sell.id === fd.item, fd && { item: BF.items[fd.item].name, from: fd.seller.profession, n: fd.offer.sell.n, spare: !!fd.offer.spare });
      if (fd) {
        const h0 = PF.feedHeld(pf), e0 = c("emerald");
        const done = BF.villageLife._test.doWheatDeal(pf, fd);
        ok("the feed changes hands for emeralds", done > 0 && PF.feedHeld(pf) === h0 + done * fd.offer.sell.n && c("emerald") === e0 - done * fd.offer.buy[0].n, [h0, PF.feedHeld(pf)]);
      }
    } else ok("it finds a feed seller's offer (no farmer in this village)", false);
    T.syncFeed(pf, true);
    ok("it never offers its feed (its reserve: the lure and the sty's next days)", BF.market.spareOf(pf, I.carrot) === 0 && !pf.trades.some(o => o.spare && PF.isFeed(o.sell.id)), BF.market.spareOf(pf, I.carrot));
    // nor feed it gets in the same tick its reserve was worked out (js/market.js keeps a villager's reserve for the tick: worked out before a deal,
    // as the market's sync can in the step before, it once read a farmer's lot of 16 against the 15 held then as 1 spare carrot)
    // (with 16 bread more to eat for the while, so its food reserve doesn't hold the carrots back on its own)
    const gotB = 16 - T.inv.add(pf.inv, I.bread, 16);
    BF.market.spareOf(pf, I.carrot);
    const gotC = 32 - T.inv.add(pf.inv, I.carrot, 32), spC = BF.market.spareOf(pf, I.carrot), sur = BF.food.surplus(pf);
    T.inv.remove(pf.inv, I.carrot, gotC); T.inv.remove(pf.inv, I.bread, gotB);
    ok("nor feed it got in the same tick", gotC > 0 && spC === 0, { got: gotC, spare: spC, bread: gotB, surplus: +sur.toFixed(1) });
    for (const s of stash) T.inv.add(pf.inv, s.id, s.count);
    ok("nor eats it, nor its raw pork", !BF.food.edible(pf).some(e => PF.isFeed(e.id) || e.id === I.raw_porkchop) && PF.feedHeld(pf) > 0, BF.food.edible(pf).map(e => BF.items[e.id].name));

    // ---- a working day: feeding at or under the limit (keeping 2 to lure), culling above it, never below 2 adults
    for (const s of P.pigs) { s.fed = null; s.cd = 0; }
    let fedN = 0, born = 0;
    BF.on("pigFed", (m, by) => { if (by === pf) fedN++; });
    BF.on("pigBorn", (pl, a) => { if (a && a.sty === P) born++; });
    BF.sky.setTime(0.05);
    for (let i = 0; i < 6000 && !(born && fedN); i++) step();
    ok("it fed its pigs and they bred in the sty", fedN > 0 && born > 0, { fedN, born, herd: P.pigs.length });
    const pork00 = c("raw_porkchop");
    BF.sky.setTime(0.08);
    for (const s of P.pigs) { s.cd = day() + 5; s.fed = day(); }
    while (P.pigs.length < P.limit) P.pigs.push({ fed: day(), cd: day() + 5, growAt: null, x: P.x0 + 1 + P.pigs.length % 4, z: P.z0 + 1.5, mob: null });
    run(3);
    const atLimit = P.pigs.length;
    for (let i = 0; i < 1500; i++) step();
    ok("at the limit, no pig is culled", P.pigs.length === atLimit && c("raw_porkchop") === pork00, [atLimit, P.pigs.length]);
    for (let i = 0; i < 3; i++) P.pigs.push({ fed: day(), cd: day() + 5, growAt: null, x: P.x0 + 1.5 + i, z: P.z0 + 2.5, mob: null });
    run(3);
    const crowded = P.pigs.length, culls0 = P.culls | 0, pork0 = c("raw_porkchop");
    ok("the sty is over its limit", crowded > P.limit, [crowded, P.limit]);
    for (let i = 0; i < 9000 && P.pigs.length > P.limit; i++) { step(); if (BF.sky.time > 0.45) BF.sky.setTime(0.08); }
    const n = crowded - P.limit;
    ok("the pig farmer culled the herd back to the limit", P.pigs.length === P.limit && P.culls - culls0 === n, [P.pigs.length, P.limit, P.culls]);
    ok("it kept the pork: 1-3 raw porkchops a pig", c("raw_porkchop") - pork0 >= n && c("raw_porkchop") - pork0 <= 3 * n, [pork0, c("raw_porkchop")]);
    run(20);
    ok("no more culling at the limit", P.pigs.length === P.limit, P.pigs.length);
    for (const s of P.pigs.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); P.pigs.length = 0;
    for (let i = 0; i < 2; i++) P.pigs.push({ fed: day(), cd: day() + 5, growAt: null, x: P.x0 + 1.5 + i, z: P.z0 + 1.5, mob: null });
    for (let i = 0; i < P.limit + 2; i++) P.pigs.push({ fed: null, cd: day() + 5, growAt: day() + 2, x: P.x0 + 1.5 + (i % 4), z: P.z0 + 3, mob: null });
    run(3);
    const k1 = P.culls;
    for (let i = 0; i < 2400; i++) step();
    ok("over the limit with only 2 adults: no cull", P.pigs.length === P.limit + 4 && P.culls === k1, [P.pigs.length, P.culls - k1]);
    // the lure: never feeds its last 2
    for (const s of P.pigs.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); P.pigs.length = 0;
    for (let i = 0; i < 2; i++) P.pigs.push({ fed: null, cd: 0, growAt: null, x: P.x0 + 1.5 + i, z: P.z0 + 1.5, mob: null });
    for (const id of PF.feedIds()) T.inv.remove(pf.inv, id, c(BF.items[id].name));
    T.inv.add(pf.inv, I.carrot, 2);
    const fed2 = fedN;
    pf.fshop.cd = day() + 1;   // no shopping meanwhile
    BF.sky.setTime(0.1);
    for (let i = 0; i < 1500; i++) step();
    ok("it keeps 2 feed back to lure a wild pig home", fedN === fed2 && c("carrot") === 2, [fedN - fed2, c("carrot")]);
    pf.fshop.cd = 0;
    const vl = (BF.vlog.entries ? BF.vlog.entries(rec.key) : []).map(e => e[2]);
    ok("the village log has culling and piglet lines", vl.some(t => /\(Pig Farmer\) culled a pig .*raw porkchop/.test(t)) && vl.some(t => /piglet was born in the sty/.test(t)), vl.filter(t => /Pig|piglet/.test(t)).slice(-4));

    // ---- an empty sty: the pig farmer leads a wild pig home from within 96 blocks
    for (const s of P.pigs.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); P.pigs.length = 0;
    const S = pf.pgk; S.stockAt = 0;
    const far = flatAt(30, 50, true);
    const wild = far ? wildAt(far[0], far[1]) : null;
    ok("a wild pig 30-50 blocks from the sty", !!wild && !wild.sty, far);
    BF.sky.setTime(0.06);
    let leads = 0;
    const trace = [];
    for (let i = 0; i < 30000 && P.pigs.length < 1; i++) { step(); if (S.task && S.task.kind === "fetch" && S.stage !== "walk" && i % 20 === 0) leads++; if (BF.sky.time > 0.45) BF.sky.setTime(0.06);
      if (i % 200 === 0 && wild) trace.push([S.stage, +pf.position.x.toFixed(1), +pf.position.z.toFixed(1), +wild.position.x.toFixed(1), +wild.position.z.toFixed(1), wild.ledBy === pf ? 1 : 0]); }
    R.trace = trace;
    ok("the pig farmer led the wild pig into the sty", !!wild && wild.sty === P && leads > 0, { pigs: P.pigs.length, leads, log: PF.log.filter(e => /lead|stock|fetch|noWild/.test(e.kind)).slice(-6) });
    ok("it is inside the fence", !!wild && wild.position.x > P.fx0 && wild.position.x < P.fx1 && wild.position.z > P.fz0 && wild.position.z < P.fz1);
    const gateOpen = () => { const g = BF.blocks[BF.world.getBlock(P.gate[0], P.y + 1, P.gate[1])]; return !!(g && g.gate && g.gate.open); };
    for (let i = 0; i < 2400 && gateOpen(); i++) step();
    ok("the gate is shut again", !gateOpen());
    ok("the village log has the fetch", (BF.vlog.entries(rec.key) || []).some(e => /\(Pig Farmer\) brought a wild pig into the sty/.test(e[2])));
    for (const s of P.pigs.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); P.pigs.length = 0;
    for (const m of BF.mobs.list.slice()) if (m.type === "pig" && !m.dead) BF.mobs.hurt(m, 999, "test");
    run(1);
    S.stockAt = 0;
    if (PF.feedHeld(pf) < 2) T.inv.add(pf.inv, I.carrot, 2);   // the lure it would set out with
    BF.sky.setTime(0.1);
    for (let i = 0; i < 4000 && !(S.stockAt > day()); i++) step();
    ok("no wild pig in range: it looks again tomorrow", S.stockAt > day() && S.stockAt - day() < 1.05 && PF.log.some(e => e.kind === "noWild"), { stockAt: S.stockAt, day: day() });

    // ---- the butcher buys raw pork from the pig farmer
    const butcher = vill().find(m => m.profession === "butcher");
    if (butcher) {
      for (const n of ["raw_porkchop", "cooked_porkchop", "raw_chicken", "cooked_chicken"]) T.inv.remove(butcher.inv, I[n], c(n, butcher));
      T.inv.add(butcher.inv, I.emerald, 3);
      T.inv.add(pf.inv, I.raw_porkchop, Math.max(0, 14 - c("raw_porkchop"))); T.syncFeed(pf);
      butcher.fshop = butcher.fshop || { stage: null, deal: null, checkT: 9, avoid: {}, cd: 0 }; butcher.fshop.avoid = {};
      const bd = BF.villageLife._test.findWheatSeller(butcher);
      ok("a butcher short of meat buys raw porkchops from the pig farmer", !!bd && bd.item === I.raw_porkchop && bd.seller === pf && !bd.offer.spare, bd ? { item: BF.items[bd.item].name, from: bd.seller.profession } : { want: BF.villageLife._test.feedWanted(butcher), em: c("emerald", butcher), pork: c("raw_porkchop"), sleeping: !!pf.sleeping, trading: !!pf.tradingWith,
        offers: pf.trades.filter(o => o.sell.id === I.raw_porkchop).map(o => [o.buy.map(b => b.n + BF.items[b.id].name).join("+"), o.sell.n, T.blockReason(pf, o)]) });
    } else ok("a butcher short of meat buys raw porkchops from the pig farmer (no butcher here)", true);

    // ---- cooking pork in a real furnace, with fuel it bought
    BF.sky.setTime(0.1);
    const js = pf.jobsite;
    // two furnace spots by the trough: another villager (the cowherd's beef, an egg cook, the toolsmith) may be using one when it gets there
    const fspots = [];
    for (let r = 2; r <= 6 && fspots.length < 2; r++) for (let dx = -r; dx <= r && fspots.length < 2; dx++) for (let dz = -r; dz <= r && fspots.length < 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = js.x + dx, z = js.z + dz, y = js.y;
      if (x > P.fx0 - 2 && x < P.fx1 + 1 && z > P.fz0 - 2 && z < P.fz1 + 1) continue;
      if (fspots.some(s => Math.abs(s.x - x) + Math.abs(s.z - z) < 3)) continue;
      if (BF.world.getBlock(x, y, z) === 0 && BF.SOLID[BF.world.getBlock(x, y - 1, z)] && BF.world.getBlock(x, y + 1, z) === 0
        && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => BF.world.getBlock(x + a, y, z + b) === 0 && BF.SOLID[BF.world.getBlock(x + a, y - 1, z + b)])) fspots.push({ x, y, z });
    }
    const fpos = fspots[0] || null;
    ok("a spot for a furnace by the trough", !!fpos, fpos);
    if (fpos) {
      for (const n of ["raw_porkchop", "cooked_porkchop", "coal", "charcoal"]) T.inv.remove(pf.inv, I[n], c(n));
      { const FU0 = BF.furnaceUse; for (let i = 0; i < pf.inv.length; i++) { const st = pf.inv[i]; if (st && (FU0.isCoal(st.id) || FU0.isLog(st.id) || FU0.isPlanks(st.id))) pf.inv[i] = null; } }   // no fuel of its own at all
      T.inv.add(pf.inv, I.oak_log, 8);
      delete pf._res;   // the market reserve is cached per game tick (js/market.js reserve): one taken this tick, before the logs, would miss them
      ok("fuel it holds is kept to cook with, not sold on as spare goods", BF.market.spareOf(pf, I.oak_log) === 0, BF.market.spareOf(pf, I.oak_log));
      T.inv.remove(pf.inv, I.oak_log, 8);
      T.inv.add(pf.inv, I.raw_porkchop, 14);
      for (const b of vill().filter(m => m.profession === "butcher")) T.inv.add(b.inv, I.cooked_porkchop, 12);   // the butcher is stocked: it buys no raw pork meanwhile
      if (c("emerald") < 4) T.inv.add(pf.inv, I.emerald, 4 - c("emerald"));
      pf.pgc = null;
      const FU = BF.furnaceUse, near = [...FU.furnaces.values()].filter(f => Math.hypot(f.x - js.x, f.z - js.z) < FU.reachOf(rec) + 8);
      const saved = near.map(f => [f.x, f.y, f.z, BF.world.getBlock(f.x, f.y, f.z)]);
      for (const f of saved) { BF.world.setBlock(f[0], f[1], f[2], 0); BF.emit("blockBroken", f[0], f[1], f[2], f[3]); }
      run(20);
      ok("no furnace in the village: the pork stays raw", c("raw_porkchop") === 14 && c("cooked_porkchop") === 0, [c("raw_porkchop"), c("cooked_porkchop")]);
      for (const s of fspots) { BF.world.setBlock(s.x, s.y, s.z, BF.B.furnace); BF.emit("blockPlaced", s.x, s.y, s.z, BF.B.furnace); }
      const miner = vill().find(m => m.profession === "miner");
      if (miner) { T.inv.add(miner.inv, I.coal, 16); T.syncFeed(miner); }
      pf.pgc = null;
      let loadedAt = -1, bought = 0, rawSold = 0;
      const ctrace = [];   // where it walked, for a failure report
      const oTrade = BF.vlog.trade;
      BF.vlog.trade = function (buyer, seller, o, times) { if (seller === pf && o && o.sell && o.sell.id === I.raw_porkchop) rawSold += o.sell.n * (times || 1); if (buyer === pf && o && o.sell && (o.sell.id === I.coal || o.sell.id === I.charcoal || /log|planks/.test(BF.items[o.sell.id].name))) bought += o.sell.n * (times || 1); return oTrade.apply(this, arguments); };
      for (let i = 0; i < 9000 && c("cooked_porkchop") < 8; i++) {
        step();
        if (BF.sky.time > 0.4) BF.sky.setTime(0.1);
        for (const s of fspots) { const st = BF.inventory.furnaceState(s.x, s.y, s.z); if (st && st.slots[0] && st.slots[0].id === I.raw_porkchop && loadedAt < 0) loadedAt = i; }
        if (i % 150 === 0) ctrace.push([pf.pgc && pf.pgc.stage, +pf.position.x.toFixed(1), +pf.position.y.toFixed(1), +pf.position.z.toFixed(1), pf.ai.route ? pf.ai.route.length : 0]);
      }
      BF.vlog.trade = oTrade;
      ok("with no fuel of its own it bought some", bought > 0 && PF.log.some(e => e.kind === "buyFuel"), { bought, log: PF.log.filter(e => /buyFuel|cookGiveup/.test(e.kind)).slice(-4) });
      ok("and cooked the pork past the 6 it keeps in the furnace", c("cooked_porkchop") === 8 && c("raw_porkchop") + rawSold === 6 && loadedAt >= 0, [c("raw_porkchop"), rawSold, c("cooked_porkchop"), loadedAt, PF.log.filter(e => /cook|load|buyFuel/i.test(e.kind)).slice(-5), pf.pgc && pf.pgc.stage, PF.toCook(pf), BF.villagerStatus.text(pf), pf.pgk && pf.pgk.task && pf.pgk.task.kind, fpos, ctrace]);
      ok("the village log has the cooking", (BF.vlog.entries(rec.key) || []).some(e => /\(Pig Farmer\) cooked 8 porkchops in the furnace/.test(e[2])));
      for (const s of fspots) { BF.world.setBlock(s.x, s.y, s.z, 0); BF.emit("blockBroken", s.x, s.y, s.z, BF.B.furnace); }
      for (const f of saved) { BF.world.setBlock(f[0], f[1], f[2], f[3]); BF.emit("blockPlaced", f[0], f[1], f[2], f[3]); }
    }

    // ---- save and load keep the sty's pigs and culls; the village unloading and loading again too
    for (const st of P.pigs.slice()) if (st.mob) BF.mobs.hurt(st.mob, 999, "test");
    run(1); P.pigs.length = 0;
    P.pigs.push({ fed: 3.5, cd: 4, growAt: null, x: P.x0 + 1.5, z: P.z0 + 1.5, mob: null }, { fed: null, cd: 0, growAt: day() + 1, x: P.x0 + 2.5, z: P.z0 + 1.5, mob: null });
    P.culls = 7;
    run(2);
    BF.mobs.unloadVillage(key);
    const gone = BF.mobs.list.filter(m => m.type === "pig" && m.sty === P && !m.removed && !m.dead).length;
    BF.world.update(V.x, V.z, 8); run(3);
    ok("the village unloads with its sty pigs and they come back with it", gone === 0 && P.pigs.length === 2 && P.pigs.every(s => s.mob && !s.mob.removed && s.mob.sty === P), { gone, back: P.pigs.map(s => !!(s.mob && !s.mob.removed)) });
    const o = {}; PF.exportAll(o);
    const k = "sties:" + key;
    ok("the sty is saved", !!o[k] && o[k].some(x => x.i === P.idx && x.k === 7 && x.p.length === 2 && x.p[0][0] === 3.5), o[k]);
    PF.reset(); delete rec._sties;
    PF.importAll(JSON.parse(JSON.stringify(o)));
    run(2);
    const P2 = PF.stiesOf(rec).find(p => p.idx === P.idx);
    ok("and loaded again: the same pigs (a piglet too) and culls", !!P2 && P2.pigs && P2.pigs.length === 2 && P2.culls === 7 && P2.pigs.some(s => s.growAt != null) && P2.pigs.some(s => s.fed === 3.5), P2 && { n: P2.pigs && P2.pigs.length, culls: P2.culls });
    ok("the loaded pigs are spawned in the sty", !!P2 && P2.pigs.every(s => s.mob && s.mob.sty === P2), P2 && P2.pigs.map(s => !!s.mob));
    R.pfInv = pf.inv.filter(Boolean).map(s => BF.items[s.id].name + ":" + s.count).join(",");

    // ---- builders: the sty blueprint, its weight, a finished one read back
    const bp = BF.blueprints.get("sty", 1, 0, 0.5, { mud: true }, "spruce");
    ok("the sty blueprint: fences, a gate, a water trough, a roof, a coarse-dirt wallow and the feed trough", !!bp && bp.req[I.spruce_fence] > 18 && bp.req[I.feed_trough] === 1 && bp.req[I.coarse_dirt] === 4 && bp.cells.some(x => BF.blocks[x.id].gate) && bp.cells.filter(x => x.id === BF.B.water).length === 2 && bp.cells.filter(x => x.y === 2).length === 9, bp && BF.blueprints.describe(bp.req));
    const bp0 = BF.blueprints.get("sty", 1, 0, 0.5, null, "spruce");
    ok("without coarse dirt in hand, no wallow", !!bp0 && !bp0.req[I.coarse_dirt]);
    const e = { id: 91, type: "sty", rot: 2, style: 0, h: 0.5, wood: "spruce", ox: 100, oy: 1010, oz: 200, state: "done", w: bp.w, d: bp.d, opts: { mud: true } };
    const fake = { key: "test", wg: { buildings: [], ground: 0 }, built: [e] };
    const bst = PF.stiesOf(fake)[0];
    ok("a finished builder's sty: 5x5 inside (limit 3), a gate and the cell in front of it, empty", !!bst && !bst.gen && bst.cells === 25 && bst.limit === 3 && !!bst.gate && !!bst.out && Math.hypot(bst.gate[0] - bst.out[0], bst.gate[1] - bst.out[1]) === 1, bst && [bst.x0, bst.z0, bst.x1, bst.z1, bst.gate, bst.out]);
    const builder = vill().find(m => m.profession === "builder");
    if (builder) {
      builder.bs = builder.bs || {};
      const ws = BF.builder.weighTypes(builder, builder.bs);
      ok("a sty is never a structure of its own (idea-044: the food jobsite roll)", !ws.some(w => w[0] === "sty"), ws.filter(w => w[0] === "sty"));
      const wg0 = rec.wg.ground; rec.wg.ground = 1;
      let picked = 0;
      for (let i = 0; i < 200; i++) if (BF.builder.pickType(builder, builder.bs) === "sty") picked++;
      const site = BF.builder.findSite(builder, "sty", null, 99);
      rec.wg.ground = wg0;
      ok("off grass a builder may still site a sty (idea-044), and never picks one outside the food jobsite roll", picked === 0 && site !== null, { picked, site: site && site.ox });
    }

    // ---- a builder's sty in a village of 12+ with no pig farmer, and an unemployed villager takes the job
    {
      const V2 = { x: -317, z: -35 }, key2 = V2.x + "," + V2.z;   // seed 1: a grass village of 24 with builders, no pig farmer, no sty
      BF.player.teleport(V2.x + 0.5, BF.worldgen.heightAt(V2.x, V2.z) + 3, V2.z + 0.5);
      await load(V2.x, V2.z);
      BF.sky.setTime(0.05);
      for (let k = 0; k < 120 && !((BF.mobs.villages.get(key2) || { members: [] }).members.some(m => m.profession === "builder")); k++) { BF.world.update(V2.x, V2.z, 8); run(0.5); }
      run(3);
      const R2 = BF.mobs.villages.get(key2);
      const v2 = () => R2.members.filter(m => m.type === "villager" && !m.dead && !m.removed);
      ok("a village of 12+ with no pig farmer or sty", !!R2 && v2().length >= 12 && !v2().some(m => m.profession === "pig_farmer") && !R2.wg.buildings.some(b => b.type === "sty"), R2 && v2().map(m => m.profession).join(","));
      const bm = v2().find(m => m.profession === "builder");
      ok("it has a builder", !!bm);
      if (!bm) return R;
      // a villager out of work (its jobsite gone, its old trade forgotten), to take the trough
      const jl = v2().find(m => ["fisherman", "mason", "fletcher", "leatherworker", "librarian"].includes(m.profession) && m.jobsite);
      if (jl) { const j = jl.jobsite, id = BF.world.getBlock(j.x, j.y, j.z); BF.world.setBlock(j.x, j.y, j.z, 0); BF.emit("blockBroken", j.x, j.y, j.z, id); BF.jobs.release(jl); jl.jobMem = null; jl.xp = 0; }
      ok("and an unemployed villager", !!jl && jl.profession === "unemployed", jl && jl.profession);
      // a jobsite another villager lets go of later (a farmer's composter) is cleared too while it waits, so the trough stays the one it can take
      const sweep = () => { if (jl && jl.profession === "unemployed") for (const s of BF.jobs.unclaimed(jl, null, jl)) { const id = BF.world.getBlock(s.x, s.y, s.z); if (id !== BF.B.feed_trough) { BF.world.setBlock(s.x, s.y, s.z, 0); BF.emit("blockBroken", s.x, s.y, s.z, id); } } };
      for (const m of v2()) if (m.profession === "builder" && m !== bm && m.bs) m.bs.cool = 1e9;   // the other builder stays out of the way
      T.inv.add(bm.inv, I.bread, 12);
      for (let i = 0; i < 200 && !bm.bs; i++) step();   // its builder state
      // wild pigs near the village (the earlier tests killed them all)
      for (let i = 0; i < 2; i++) { const x = Math.floor(V2.x + 20 + i), z = Math.floor(V2.z + 20); BF.mobs.spawn("pig", x + 0.5, BF.world.heightAt(x, z) + 1, z + 0.5); }
      ok("2 wild pigs within 80 blocks count for the food jobsite roll", BF.builder.wildCount(R2, "pig") >= 2, BF.builder.wildCount(R2, "pig"));
      // the builder holds what a sty takes (bought, in a real game: test/builder-woods.js), two water buckets and 4 coarse dirt for the wallow
      T.inv.add(bm.inv, I.coarse_dirt, 4);
      const wood = "oak";   // a plains village
      const need = BF.blueprints.get("sty", 0, 0, 0.5, { mud: true }, wood).req;
      for (const id in need) T.inv.add(bm.inv, +id, need[id] + 2);
      T.inv.add(bm.inv, BF.worldgen.palette(0).found, 24);
      if (I.water_bucket != null) T.inv.add(bm.inv, I.water_bucket, 2);
      Object.assign(bm.bs, { mode: "idle", stage: null, want: null, deal: null, entry: null, goal: null, t: 0, cool: 0, next: { type: "sty", wood } });
      if (bm.ai) bm.ai.route = null;
      let e = null;
      for (let i = 0; i < 16000 && !(e && e.state === "done"); i++) {
        step();
        if (BF.sky.time > 0.4) BF.sky.setTime(0.05);
        e = (R2.built || []).find(x => x.type === "sty") || null;
        if (i % 20 === 0) sweep();
        if (!e && i % 100 === 99 && bm.bs.mode !== "build" && bm.bs.mode !== "fill") {   // no site yet (it must be in the jobless's reach): it tries again, as a builder does once its fail mark runs out
          delete bm.bs.fail.sty; Object.assign(bm.bs, { mode: "idle", stage: null, want: null, deal: null, t: 0, cool: 0, next: { type: "sty", wood } });
        }
      }
      ok("the builder built a sty", !!e && e.state === "done", e ? { state: e.state, prog: e.prog, n: e.n, status: BF.villagerStatus.text(bm) } : { status: BF.villagerStatus.text(bm), log: BF.builder.log.slice(-4) });
      const bs2 = PF.stiesOf(R2).find(p => p.idx === "b" + (e && e.id));
      ok("it is a sty for pigs: empty, holding 3", !!bs2 && bs2.limit === 3 && bs2.pigs !== undefined, bs2 && { limit: bs2.limit, pigs: bs2.pigs && bs2.pigs.length });
      let pf2 = null;
      for (let i = 0; i < 8000 && !pf2; i++) {
        step();
        if (BF.sky.time > 0.4) BF.sky.setTime(0.05);
        if (i % 20 === 0) { sweep(); pf2 = v2().find(m => m.profession === "pig_farmer") || null; }
      }
      ok("an unemployed villager took the job at the feed trough", !!pf2 && BF.world.getBlock(pf2.jobsite.x, pf2.jobsite.y, pf2.jobsite.z) === BF.B.feed_trough && PF.styOf(pf2) === bs2, pf2 ? pf2.jobsite : v2().map(m => m.profession).join(","));
      if (pf2) ok("with no feed from nothing (emeralds to buy it)", !c("raw_porkchop", pf2) && c("emerald", pf2) >= 1, pf2.inv.filter(Boolean).map(s => BF.items[s.id].name + ":" + s.count));
    }
    return R;
  });
  for (const l of res.lines) console.log(l);
  if (res.pfInv) console.log("pig farmer", res.pfInv);
  if (res.trace) console.log("trace", JSON.stringify(res.trace));
};
