// Cows, pastures and the cowherd (js/cowherd.js): a generated pasture and its cowherd with its hire kit, milking once a day, bottling, drinking
// and cooking with milk leaving the empty bottle, feeding and breeding, culling only above the pasture's limit and never below 2 adults,
// milk as the last-resort food, the last bucket, empty bottles flowing back, the leatherworker buying leather, builders and grass, leading
// wild cows into an empty pasture, save and load. Usage:
//   NODE_PATH=$(npm root -g) node test/run.js /tmp/out test/cowherd-actions.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const day = () => BF.sky.day + BF.sky.time;
    const C = BF.cowherd, I = BF.I, T = BF.trades;
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    ok("new worlds use village generator 5", BF.state.villages === 5, BF.state.villages);
    BF.mobs.spawning = false;
    const V = { x: -1, z: -72 };   // seed 1: a village of 22 on the plains with a pasture
    const wv = BF.worldgen.villagesNear(V.x, V.z, 40).find(v => Math.round(v.x) === V.x && Math.round(v.z) === V.z);
    const pb = wv && wv.buildings.find(b => b.type === "pasture");
    ok("the village layout has a pasture (grass, 10+ villagers)", !!pb && wv.ground === 0 && wv.pop >= 10, wv && [wv.pop, wv.ground]);
    if (!pb) return R;
    BF.player.teleport(pb.doorX + 0.5, BF.worldgen.heightAt(pb.doorX, pb.doorZ) + 3, pb.doorZ - 3.5);
    const load = async (x, z) => { for (let i = 0; i < 400; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0 && BF.world.isLoaded(x, z)) break; } };
    await load(pb.doorX, pb.doorZ);
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    run(4);
    const key = V.x + "," + V.z;
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(key) || { members: [] }).members.some(m => m.profession === "cowherd")); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(key);
    const vill = () => rec.members.filter(m => m.type === "villager" && !m.dead && !m.removed);
    const herder = rec && rec.members.find(m => m.type === "villager" && m.profession === "cowherd");
    ok("the village has a cowherd", !!herder, rec && vill().map(m => m.profession).join(","));
    if (!herder) return R;
    const P = C.pastureOf(herder);
    ok("its milk churn stands beside the pasture", !!P && BF.world.getBlock(herder.jobsite.x, herder.jobsite.y, herder.jobsite.z) === BF.B.milk_churn, herder.jobsite);
    if (!P) return R;
    run(2);
    ok("a generated pasture starts with 2-4 cows", P.cows.length >= 2 && P.cows.length <= 4, P.cows.length);
    ok("the pasture holds one cow per 8 cells", P.limit === Math.floor(P.cells / 8) && P.limit >= 4, [P.cells, P.limit]);
    ok("its cows are spawned inside the field", P.cows.every(s => s.mob && s.mob.position.x > P.x0 && s.mob.position.x < P.x1 && s.mob.position.z > P.z0 && s.mob.position.z < P.z1), P.cows.map(s => s.mob && [s.mob.position.x.toFixed(1), s.mob.position.z.toFixed(1)]));
    const gateB = BF.blocks[BF.world.getBlock(P.gate[0], P.y + 1, P.gate[1])];
    ok("the pasture has a gate", !!(gateB && gateB.gate), gateB && gateB.name);
    let water = 0;
    for (let x = P.fx0; x < P.fx1; x++) for (let z = P.fz0; z < P.fz1; z++) for (let y = P.y - 1; y <= P.y + 1; y++) if (BF.world.getBlock(x, y, z) === BF.B.water) water++;
    ok("it has a water trough", water >= 2, water);
    const c = (n, m = herder) => T.inv.count(m.inv, I[n]);
    ok("the hire kit: the cowherd starts with 1 bucket and 30 glass bottles", c("bucket") === 1 && c("glass_bottle") === 30 && herder.cowKit === true, { bucket: c("bucket"), bottles: c("glass_bottle") });
    ok("and with no milk, beef, leather or steak", !c("milk_bottle") && !c("milk_bucket") && !c("raw_beef") && !c("leather") && !c("steak"));

    // ---- milking: once a day per cow, for the player too
    const cow0 = P.cows[0].mob;
    ok("an adult cow can be milked", C.milkable(cow0));
    ok("milking it marks it for the day", C.milk(cow0, "test") === true && !C.milkable(cow0) && C.milk(cow0, "test") === false);
    BF.inventory.clear();
    BF.inventory.setSlot(0, { id: I.bucket, count: 2 });
    BF.inventory.select(0);
    const r0 = C.playerUse(cow0, BF.inventory.selected());
    ok("the player cannot milk a cow milked today", typeof r0 === "string" && BF.inventory.count(I.bucket) === 2, r0);
    const cow1 = P.cows[1].mob;
    const r1 = C.playerUse(cow1, BF.inventory.selected());
    ok("an empty bucket on a cow gives a milk bucket", r1 === true && BF.inventory.count(I.milk_bucket) === 1 && BF.inventory.count(I.bucket) === 1, [r1, BF.inventory.count(I.milk_bucket), BF.inventory.count(I.bucket)]);
    const d0 = BF.sky.day;
    BF.sky.day = d0 + 1;
    ok("the next day it can be milked again", C.milkable(cow0) && C.milkable(cow1));
    BF.sky.day = d0;
    ok("but not again today", !C.milkable(cow1));

    // ---- bottling (the player's recipe) and the glass bottle recipe
    BF.inventory.clear();
    const mb = { id: I.milk_bucket, count: 1 }, gbS = { id: I.glass_bottle, count: 1 };
    const res1 = BF.inventory.gridSet([mb, gbS, gbS, gbS], 2);
    ok("milk bucket + 3 glass bottles make 3 milk bottles", !!res1 && res1.id === I.milk_bottle && res1.count === 3, res1);
    BF.inventory.craftTake();
    const g1 = BF.inventory.gridGet();
    ok("bottling gives the empty bucket back", BF.inventory.count(I.milk_bottle) === 3 && g1.filter(Boolean).length === 1 && g1.some(s => s && s.id === I.bucket), g1);
    const gl = { id: I.glass, count: 1 };
    const res2 = BF.inventory.gridSet([gl, null, gl, null, gl, null, null, null, null], 3);
    ok("3 glass in a V make 3 glass bottles", !!res2 && res2.id === I.glass_bottle && res2.count === 3, res2);
    BF.inventory.gridSet([], 3);

    // ---- drinking and cooking with milk leave the empty bottle
    BF.inventory.clear();
    BF.inventory.setSlot(0, { id: I.milk_bottle, count: 1 }); BF.inventory.select(0);
    BF.player.hunger = 10;
    BF.player.finishEating(BF.items[I.milk_bottle]);
    ok("the player drinks a milk bottle: +2 hunger and the empty bottle in hand", BF.player.hunger === 12 && BF.inventory.selected() && BF.inventory.selected().id === I.glass_bottle, [BF.player.hunger, BF.inventory.selected()]);
    BF.inventory.setSlot(0, { id: I.milk_bucket, count: 1 });
    BF.player.finishEating(BF.items[I.milk_bucket]);
    ok("the player drinks a milk bucket: +6 hunger and the empty bucket in hand", BF.player.hunger === 18 && BF.inventory.selected() && BF.inventory.selected().id === I.bucket, [BF.player.hunger, BF.inventory.selected()]);
    BF.inventory.clear();
    const hook = (grid) => grid.some(s => s && s.id === I.milk_bottle) && grid.some(s => s && s.id === I.wheat_item) ? { id: I.bread, count: 2 } : null;   // a stand-in for the baker's cake
    (BF.craftHooks = BF.craftHooks || []).push(hook);
    const cake = BF.inventory.gridSet([{ id: I.milk_bottle, count: 1 }, { id: I.wheat_item, count: 1 }, null, null], 2);
    BF.inventory.craftTake();
    const g2 = BF.inventory.gridGet();
    BF.craftHooks.splice(BF.craftHooks.indexOf(hook), 1);
    ok("milk used in a recipe leaves the empty bottle", !!cake && g2.some(s => s && s.id === I.glass_bottle) && !g2.some(s => s && s.id === I.milk_bottle), g2);
    BF.inventory.gridSet([], 3);
    const eater = vill().find(m => m !== herder && m.profession !== "cowherd");
    const stash = new Map();
    const hide = m => { const a = []; for (let i = 0; i < m.inv.length; i++) { const s = m.inv[i]; if (s && BF.food.isFood(s.id)) { a.push(s); m.inv[i] = null; } } stash.set(m, (stash.get(m) || []).concat(a)); };
    const unhide = () => { for (const [m, a] of stash) for (const s of a) T.inv.add(m.inv, s.id, s.count); stash.clear(); };
    hide(eater);
    T.inv.add(eater.inv, I.milk_bottle, 2);
    const gb0 = c("glass_bottle", eater);
    BF.food.life(eater).sat = 0;
    BF.food.eat(eater, 0.8);
    ok("a villager drinking milk bottles keeps the empty bottles", c("milk_bottle", eater) === 0 && c("glass_bottle", eater) === gb0 + 2, [c("milk_bottle", eater), c("glass_bottle", eater)]);
    T.inv.remove(eater.inv, I.glass_bottle, 2);
    unhide();

    // ---- milk as a last resort: a hungry villager buys bread, baked goods or cooked meat first; milk only when none is for sale
    T.inv.add(herder.inv, I.milk_bottle, 12);
    const buyer = vill().find(m => m !== herder && m.profession !== "cowherd" && m.profession !== "farmer") || eater;
    hide(buyer);
    T.inv.add(buyer.inv, I.emerald, 5);
    buyer.fshop = buyer.fshop || { stage: null, deal: null, checkT: 9, avoid: {}, cd: 0 };
    buyer.fshop.avoid = {};
    BF.sky.setTime(0.1);
    const VL = BF.villageLife._test;
    const d1 = VL.findFoodSeller(buyer);
    ok("with food for sale in the village, a hungry villager does not buy milk", !!d1 && d1.item !== I.milk_bottle && d1.item !== I.milk_bucket, d1 && { item: BF.items[d1.item].name, from: d1.seller.profession });
    for (const m of vill()) if (m !== buyer) hide(m);
    T.inv.add(herder.inv, I.milk_bottle, 30);   // hide() took its bottles too (milk is food); like anyone it keeps 7 bread-eq of food to eat (js/market.js)
    T.syncFeed(herder);   // its offers follow its pack (js/market.js)
    const d2 = VL.findFoodSeller(buyer);
    ok("with no other food for sale, it buys milk bottles from the cowherd", !!d2 && d2.item === I.milk_bottle && d2.seller === herder, d2 ? { item: BF.items[d2.item].name, from: d2.seller.profession } : { milk: c("milk_bottle"), surplus: BF.food.surplus(herder), spare: BF.market.spareOf(herder, I.milk_bottle), offers: herder.trades.filter(o => o.sell.id === I.milk_bottle).map(o => [o.buy[0].n, o.sell.n, !!o.spare, T.blockReason(herder, o)]) });
    ok("the cowherd never sells milk as ordinary food", VL.dealWith(buyer, herder, 3) === null);
    T.inv.remove(herder.inv, I.milk_bottle, c("milk_bottle") - 3);
    T.inv.add(herder.inv, I.bread, 30);   // plenty of other food: only the milk reserve holds the bottles back
    T.syncFeed(herder);
    ok("it keeps 3 bottles back (the baker's next cake)", VL.milkDeal(buyer, herder, 3) === null && BF.market.spareOf(herder, I.milk_bottle) === 0, c("milk_bottle"));
    T.inv.remove(herder.inv, I.bread, c("bread"));
    T.inv.remove(herder.inv, I.milk_bottle, c("milk_bottle"));
    unhide();
    T.inv.remove(herder.inv, I.milk_bottle, c("milk_bottle"));

    // ---- the last bucket
    const bucketOffer = { buy: [{ id: I.emerald, n: 1 }], sell: { id: I.bucket, n: 1 }, level: 1, xp: 0 };
    ok("the cowherd never sells its last bucket", c("bucket") === 1 && !!T.blockReason(herder, bucketOffer), T.blockReason(herder, bucketOffer));
    T.inv.add(herder.inv, I.bucket, 1);
    ok("it sells a bucket when it holds more than 1", T.blockReason(herder, bucketOffer) === null, T.blockReason(herder, bucketOffer));
    T.inv.remove(herder.inv, I.bucket, 1);

    // ---- empty bottles flow back: any villager sells them cheaply, the cowherd buys them
    const other = vill().find(m => m !== herder && m.profession !== "cowherd");
    T.inv.add(other.inv, I.glass_bottle, 9);
    T.syncFeed(other, true);
    const gbOffer = v => v.trades.find(o => o.spare && o.sell.id === I.glass_bottle);
    const bo = gbOffer(other);
    ok("a villager holding empty bottles offers them cheaply (spare goods, js/market.js)", !!bo && bo.sell.n === 9 && bo.buy.length === 1 && bo.buy[0].id === I.emerald && bo.buy[0].n === 1, bo);
    T.inv.remove(other.inv, I.glass_bottle, 6); T.syncFeed(other);
    const bo3 = gbOffer(other);
    T.inv.remove(other.inv, I.glass_bottle, 1); T.syncFeed(other);
    const bo2 = gbOffer(other);
    ok("from as few as 3 (1 emerald), not 2", !!bo3 && bo3.sell.n === 3 && bo3.buy[0].n === 1 && !bo2, { bo3: bo3 && bo3.sell.n, bo2: !!bo2 });
    T.inv.add(other.inv, I.glass_bottle, 7); T.syncFeed(other);
    T.syncFeed(herder);
    ok("the cowherd never offers its own bottles", !gbOffer(herder) && c("glass_bottle") > 0, c("glass_bottle"));
    const keepGB = c("glass_bottle");
    T.inv.remove(herder.inv, I.glass_bottle, keepGB - 4);
    const em0 = c("emerald");
    if (em0 < 2) T.inv.add(herder.inv, I.emerald, 2);
    herder.fshop = herder.fshop || { stage: null, deal: null, checkT: 9, avoid: {}, cd: 0 };
    herder.fshop.avoid = {};
    const bd = VL.findBottleSeller(herder);
    ok("a cowherd short of bottles finds a villager's offer for them", !!bd && bd.item === I.glass_bottle && bd.seller.profession !== "cowherd" && !!bd.offer, bd && { from: bd.seller.profession, n: bd.offer.sell.n, times: bd.times });
    if (bd) {
      const sg0 = c("glass_bottle", bd.seller), hg0 = c("glass_bottle");
      const done = VL.doWheatDeal(herder, bd) * bd.offer.sell.n;   // the shared "buy through an offer" trade (js/villagelife.js)
      ok("the bottles change hands for an emerald", done > 0 && c("glass_bottle") === hg0 + done && c("glass_bottle", bd.seller) === sg0 - done, [hg0, c("glass_bottle")]);
    }
    T.inv.remove(other.inv, I.glass_bottle, c("glass_bottle", other));
    T.inv.add(herder.inv, I.glass_bottle, Math.max(0, 30 - c("glass_bottle")));

    // ---- a morning's work: the cowherd milks every adult once, bottles the milk at the churn, feeds the cows (wheat) and they breed
    T.inv.add(herder.inv, I.wheat_item, 12);
    for (const s of P.cows) { s.milkDay = null; s.fed = null; s.cd = 0; }
    let fedN = 0, born = 0;
    const milked = new Map();
    BF.on("cowFed", (m, by) => { if (by === herder) fedN++; });
    BF.on("cowBorn", () => born++);
    BF.on("cowMilked", (m, by) => { if (by === herder) { const k = m.cow; const dd = Math.floor(day()); milked.set(k, (milked.get(k) || []).concat(dd)); } });
    BF.sky.setTime(0.05);
    const tasks = {};
    const adults0 = P.cows.filter(s => s.growAt == null).length;
    const log0 = C.log.length ? C.log[C.log.length - 1] : null;
    for (let i = 0; i < 8000; i++) { step(); if (i % 10 === 0 && herder.cwk && herder.cwk.task) tasks[herder.cwk.task.kind] = (tasks[herder.cwk.task.kind] || 0) + 1; }
    R.tasks = tasks;
    const twice = [...milked.values()].filter(a => a.length !== new Set(a).size).length;
    ok("the cowherd milked every adult cow", milked.size >= adults0, { milked: milked.size, adults0, tasks });
    ok("each cow once a day", twice === 0, [...milked.values()]);
    const bottledN = C.log.slice(C.log.indexOf(log0) + 1).filter(e => e.kind === "bottled").reduce((n, e) => n + e.bottles, 0);   // it may drink one of them meanwhile: the bottle stays
    ok("it bottled the milk: 3 bottles a bucket, the bucket back", bottledN === 3 * milked.size && c("bucket") === 1 && c("milk_bucket") === 0 && c("glass_bottle") + c("milk_bottle") === 30, { bottled: bottledN, milk: c("milk_bottle"), bucket: c("bucket"), mb: c("milk_bucket"), gb: c("glass_bottle") });
    ok("it fed the cows wheat", fedN > 0, fedN);
    ok("fed cows bred: a calf was born in the pasture", born > 0 && P.cows.some(s => s.growAt != null), { born, herd: P.cows.length });
    const calfS = P.cows.find(s => s.growAt != null);
    const calf = calfS && calfS.mob;
    ok("a calf is smaller and gives no milk", !!(calf && calf.calf && calf.model.scale.x < 0.9 && !C.milkable(calf)), calf && calf.model.scale.x);
    R.herderInv = herder.inv.filter(Boolean).map(s => BF.items[s.id].name + ":" + s.count).join(",");
    for (let i = 0; i < 1200 && (herder.position.x > P.fx0 && herder.position.x < P.fx1 && herder.position.z > P.fz0 && herder.position.z < P.fz1); i++) step();

    // ---- breeding needs wheat and two willing adults
    const spot = (dx, dz) => { const x = Math.floor(P.out[0] + dx), z = Math.floor(P.out[1] + dz), y = BF.world.heightAt(x, z) + 1; return [x + 0.5, y, z + 0.5]; };
    const wildAt = (dx, dz) => { const [x, y, z] = spot(dx, dz); return BF.mobs.spawn("cow", x, y, z); };
    // a flat 5x5 patch of ground outside the pasture (cows only mate within 2 blocks of height: a pit or a roof between them would stop them)
    const flat = (() => {
      for (let r = 9; r < 30; r++) for (let dx = -r; dx <= r; dx++) for (const dz of [-r, r]) {
        const x0 = Math.floor(P.out[0] + dx), z0 = Math.floor(P.out[1] + dz), h = BF.world.heightAt(x0, z0);
        if (x0 > P.fx0 - 3 && x0 < P.fx1 + 3 && z0 > P.fz0 - 3 && z0 < P.fz1 + 3) continue;
        let ok2 = true;
        for (let a = -2; a <= 2 && ok2; a++) for (let b = -2; b <= 2 && ok2; b++) if (BF.world.heightAt(x0 + a, z0 + b) !== h) ok2 = false;
        if (ok2) return [dx, dz];
      }
      return [-12, -9];
    })();
    const wa = wildAt(flat[0], flat[1]), wb = wildAt(flat[0] + 1, flat[1]);
    let wildBorn = 0;
    const onBorn = (cf, a, b) => { if (a === wa || a === wb || b === wa || b === wb) wildBorn++; };
    BF.on("cowBorn", onBorn);
    run(6);
    ok("two unfed cows side by side do not breed", wildBorn === 0 && !C.willing(wa, day()));
    C.feed(wa, "test");
    run(6);
    ok("one fed cow alone does not breed", wildBorn === 0 && C.willing(wa, day()) && !C.willing(wb, day()));
    C.feed(wb, "test");
    for (let i = 0; i < 600 && !wildBorn; i++) step();
    ok("two fed adults breed: a calf", wildBorn === 1, { wildBorn, d: +Math.hypot(wa.position.x - wb.position.x, wa.position.z - wb.position.z).toFixed(2), dy: +(wa.position.y - wb.position.y).toFixed(2),
      willing: [C.willing(wa, day()), C.willing(wb, day())], mate: [wa.mate === wb, wb.mate === wa], dead: [!!wa.dead, !!wb.dead], pasture: [!!wa.pasture, !!wb.pasture], led: [!!wa.ledBy, !!wb.ledBy], cows: BF.mobs.list.filter(m => m.type === "cow" && !m.dead).length });
    ok("a calf cannot breed or be fed to breed, and grows up after a few days", (() => {
      const cf = BF.mobs.list.find(m => m.type === "cow" && m.calf && !m.pasture && !m.dead);
      if (!cf) return false;
      const was = cf.cow.growAt;
      C.feed(cf, "test");
      const faster = cf.cow.growAt < was && !C.willing(cf, day());
      const dd = BF.sky.day; BF.sky.day = dd + C.CALF_DAYS + 1; run(1); const grown = cf.cow.growAt == null && !cf.calf; BF.sky.day = dd;
      cf.cow.cd = 0;
      return faster && grown;
    })());
    for (const m of [wa, wb]) if (m && !m.dead) BF.mobs.hurt(m, 999, "test");
    for (const m of BF.mobs.list.slice()) if (m.type === "cow" && !m.pasture && !m.dead) BF.mobs.hurt(m, 999, "test");
    run(1);

    // ---- culling: only above the limit, never below 2 adults; the cow's drops kept
    BF.sky.setTime(0.08);
    for (const s of P.cows) { s.cd = day() + 5; s.fed = day(); s.milkDay = Math.floor(day()); }
    while (P.cows.length < P.limit) P.cows.push({ fed: day(), cd: day() + 5, growAt: null, milkDay: Math.floor(day()), x: P.x0 + 1 + P.cows.length % 5, z: P.z0 + 1.5, mob: null });
    run(3);
    const beef0 = c("raw_beef"), lea0 = c("leather"), atLimit = P.cows.length;
    for (let i = 0; i < 1500; i++) step();
    ok("at the limit, no cow is culled", P.cows.length === atLimit && c("raw_beef") === beef0, [atLimit, P.cows.length]);
    for (let i = 0; i < 3; i++) P.cows.push({ fed: day(), cd: day() + 5, growAt: null, milkDay: Math.floor(day()), x: P.x0 + 1.5 + i, z: P.z0 + 2.5, mob: null });
    run(3);
    const crowded = P.cows.length, culls0 = P.culls;
    ok("the pasture is over its limit", crowded > P.limit, [crowded, P.limit]);
    for (let i = 0; i < 9000 && P.cows.length > P.limit; i++) step();
    const n = crowded - P.limit;
    ok("the cowherd culled the herd back to the limit", P.cows.length === P.limit && P.culls - culls0 === n, [P.cows.length, P.limit, P.culls]);
    ok("it kept the beef: 1-3 a cow", c("raw_beef") - beef0 >= n && c("raw_beef") - beef0 <= 3 * n, [beef0, c("raw_beef")]);
    ok("and the leather: 0-2 a cow", c("leather") - lea0 <= 2 * n, [lea0, c("leather")]);
    run(20);
    ok("no more culling at the limit", P.cows.length === P.limit, P.cows.length);
    // a crowded herd of calves: never below 2 adults
    for (const s of P.cows.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); P.cows.length = 0;
    for (let i = 0; i < 2; i++) P.cows.push({ fed: day(), cd: day() + 5, growAt: null, milkDay: Math.floor(day()), x: P.x0 + 1.5 + i, z: P.z0 + 1.5, mob: null });
    for (let i = 0; i < P.limit + 2; i++) P.cows.push({ fed: null, cd: day() + 5, growAt: day() + 2, milkDay: null, x: P.x0 + 1.5 + (i % 6), z: P.z0 + 3, mob: null });
    run(3);
    const k1 = P.culls;
    for (let i = 0; i < 2400; i++) step();
    ok("over the limit with only 2 adults: no cull", P.cows.length === P.limit + 4 && P.cows.filter(s => s.growAt == null).length === 2 && P.culls === k1, [P.cows.length, P.culls - k1]);
    const vl = (BF.vlog.entries ? BF.vlog.entries(rec.key) : []).map(e => e[2]);
    ok("the village log has milking and culling lines", vl.some(t => /\(Cowherd\) milked a cow/.test(t)) && vl.some(t => /\(Cowherd\) culled a cow/.test(t)) && vl.some(t => /calf was born/.test(t)), vl.filter(t => /Cowherd|calf/.test(t)).slice(-4));

    // ---- an empty pasture: the cowherd leads wild cows in until it holds 2
    for (const s of P.cows.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1);
    P.cows.length = 0;
    const S = herder.cwk; S.stockAt = 0;
    if (c("wheat_item") < 4) T.inv.add(herder.inv, I.wheat_item, 4);
    const wild = [];
    for (const [dx, dz] of [[-16, -12], [-19, -10]]) { const m = wildAt(dx, dz); if (m) wild.push(m); }
    ok("two wild cows spawned outside the village pasture", wild.length === 2 && wild.every(m => !m.pasture), wild.map(m => [m.position.x.toFixed(0), m.position.z.toFixed(0)]));
    BF.sky.setTime(0.06);
    let leads = 0;
    for (let i = 0; i < 30000 && P.cows.length < 2; i++) { step(); if (S.task && S.task.kind === "fetch" && S.stage !== "walk" && i % 20 === 0) leads++; if (BF.sky.time > 0.45) BF.sky.setTime(0.06); }
    ok("the cowherd led wild cows into the empty pasture until it held 2", P.cows.length >= 2, { cows: P.cows.length, wild: wild.map(m => !!m.pasture), log: C.log.filter(e => /lead|stock|fetch|noWild/.test(e.kind)).slice(-6) });
    ok("it led them (it walked with a cow behind it)", leads > 0, leads);
    ok("they are inside the field", wild.filter(m => m.pasture === P).every(m => m.position.x > P.fx0 && m.position.x < P.fx1 && m.position.z > P.fz0 && m.position.z < P.fz1));
    const gateOpen = () => { const g = BF.blocks[BF.world.getBlock(P.gate[0], P.y + 1, P.gate[1])]; return !!(g && g.gate && g.gate.open); };
    for (let i = 0; i < 2400 && gateOpen(); i++) step();
    ok("the gate is shut again", !gateOpen());
    ok("the village log has the fetch", (BF.vlog.entries(rec.key) || []).some(e => /brought a wild cow into the pasture/.test(e[2])));
    // none in range: it looks again the next day
    for (const s of P.cows.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); P.cows.length = 0;
    for (const m of BF.mobs.list.slice()) if (m.type === "cow" && !m.dead) BF.mobs.hurt(m, 999, "test");
    run(1);
    S.stockAt = 0;
    for (let i = 0; i < 600; i++) step();
    ok("no wild cow in range: it tries again tomorrow", S.stockAt > day() && S.stockAt - day() < 1.05 && C.log.some(e => e.kind === "noWild"), { stockAt: S.stockAt, day: day() });

    // ---- the player: wheat feeds a cow, cows follow a player holding wheat
    const hx = spot(-6, -6), cw = BF.mobs.spawn("cow", hx[0], hx[1], hx[2]);
    BF.inventory.clear();
    BF.inventory.setSlot(0, { id: I.wheat_item, count: 10 });
    BF.inventory.select(0);
    const r2 = C.playerUse(cw, BF.inventory.selected());
    ok("right-clicking a cow with wheat feeds it", r2 === true && C.willing(cw, day()) && BF.inventory.count(I.wheat_item) === 9, r2);
    BF.player.teleport(cw.position.x + 6, cw.position.y + 0.2, cw.position.z);
    const f0 = Math.hypot(cw.position.x - BF.player.position.x, cw.position.z - BF.player.position.z);
    run(4);
    const f1 = Math.hypot(cw.position.x - BF.player.position.x, cw.position.z - BF.player.position.z);
    ok("a cow follows a player holding wheat", f1 < f0 - 2, [f0.toFixed(1), f1.toFixed(1)]);

    // ---- the hire kit for a villager that becomes a cowherd later, once
    const late = vill().find(m => m !== herder && m.profession !== "cowherd" && !m.cowKit);
    const lb = c("bucket", late), lg = c("glass_bottle", late);
    BF.jobs.hire(late, { x: herder.jobsite.x, y: herder.jobsite.y, z: herder.jobsite.z, prof: "cowherd" });
    ok("a villager hired as a cowherd later gets 1 bucket and 30 glass bottles", late.profession === "cowherd" && c("bucket", late) === lb + 1 && c("glass_bottle", late) === lg + 30, [late.profession, c("bucket", late), c("glass_bottle", late)]);
    BF.jobs.hire(late, { x: herder.jobsite.x, y: herder.jobsite.y, z: herder.jobsite.z, prof: "cowherd" });
    ok("only once", c("bucket", late) === lb + 1 && c("glass_bottle", late) === lg + 30, [c("bucket", late), c("glass_bottle", late)]);
    ok("the kit is remembered in the save", T.pack(late).ck === 1 && (() => { const v = { inv: [] }; T.unpack(v, JSON.parse(JSON.stringify(T.pack(late)))); return v.cowKit === true; })());
    BF.jobs.hire(herder, { x: herder.jobsite.x, y: herder.jobsite.y, z: herder.jobsite.z, prof: "cowherd" });
    const stock = T.stockFor("cowherd", {});
    ok("a generated cowherd's starting pack holds the kit", stock.some(s => s && s.id === I.bucket) && stock.filter(s => s && s.id === I.glass_bottle).reduce((a, s) => a + s.count, 0) === 30);

    // ---- the leatherworker no longer makes leather; it buys it from the cowherd and the butcher
    ok("leather is off the leatherworker's restock", !(T.PRODUCE.leatherworker || []).includes("leather"));
    const wantLw = BF.villageLife._test.feedWanted({ profession: "leatherworker", inv: [] });
    ok("a leatherworker short of leather wants to buy some", wantLw > 0, wantLw);
    const realLw = { profession: "leatherworker", inv: T.stockFor("leatherworker", {}), trades: [], level: 1, xp: 0, lastRestock: 0 };
    T.inv.remove(realLw.inv, I.leather, T.inv.count(realLw.inv, I.leather));
    realLw.trades = T.offers ? T.offers("leatherworker", 5) || [] : [];
    try { T.restock(realLw, BF.sky.day || 0); T.restock(realLw, (BF.sky.day || 0) + 3); } catch (e) { R.restockErr = String(e); }
    ok("the daily restock gives it no leather", T.inv.count(realLw.inv, I.leather) === 0, T.inv.count(realLw.inv, I.leather));
    const lw = vill().find(m => m.profession === "leatherworker");
    if (lw) {
      const lwKeep = c("leather", lw); T.inv.remove(lw.inv, I.leather, lwKeep); T.inv.add(lw.inv, I.emerald, 3);
      T.inv.add(herder.inv, I.leather, 14); T.syncFeed(herder);
      lw.fshop = lw.fshop || { stage: null, deal: null, checkT: 9, avoid: {}, cd: 0 }; lw.fshop.avoid = {};
      const ld = BF.villageLife._test.findWheatSeller(lw);
      ok("a leatherworker short of leather buys it through an offer", !!ld && ld.item === I.leather && !!ld.offer && ld.offer.sell.id === I.leather, ld && { from: ld.seller.profession, n: ld.offer.sell.n, spare: !!ld.offer.spare });
      T.inv.remove(herder.inv, I.leather, c("leather")); T.inv.add(lw.inv, I.leather, lwKeep); T.syncFeed(herder);
    } else ok("a leatherworker short of leather buys it through an offer (no leatherworker in this village)", true);

    // ---- builders: a pasture only in a village on grass
    const bp = BF.blueprints.get("pasture", 1, 0, 0.5, { hay: true }, "spruce");
    ok("the pasture blueprint: fences, a gate, water, hay and a milk churn", !!bp && bp.req[I.spruce_fence] > 20 && bp.req[I.milk_churn] === 1 && bp.cells.some(x => BF.blocks[x.id].gate) && bp.cells.filter(x => x.id === BF.B.water).length === 2 && bp.req[I.hay_bale] === 2, bp && BF.blueprints.describe(bp.req));
    const e = { id: 78, type: "pasture", rot: 1, style: 0, h: 0.5, wood: "spruce", ox: 100, oy: 1010, oz: 200, state: "done", w: bp.w, d: bp.d, opts: { hay: true } };
    const fake = { key: "test", wg: { buildings: [], ground: 0 }, built: [e] };
    const bpast = C.pasturesOf(fake)[0];
    ok("a finished builder's pasture: a 9x5 field (limit 5), a gate and the cell in front of it, empty", !!bpast && !bpast.gen && bpast.cells === 45 && bpast.limit === 5 && !!bpast.gate && !!bpast.out, bpast && [bpast.x0, bpast.z0, bpast.x1, bpast.z1, bpast.gate, bpast.out]);
    ok("grass villages take pastures, desert and snow villages do not", C.grassVillage({ wg: { ground: 0 } }) && !C.grassVillage({ wg: { ground: 1 } }) && !C.grassVillage({ wg: { ground: 2 } }));
    const builder = vill().find(m => m.profession === "builder");
    const wg0 = rec.wg.ground;
    let picked = 0, site = "n/a";
    if (builder) {
      builder.bs = builder.bs || {};
      rec.wg.ground = 1;
      for (let i = 0; i < 300; i++) if (BF.builder.pickType(builder, builder.bs) === "pasture") picked++;
      site = BF.builder.findSite(builder, "pasture", null, 99);
      rec.wg.ground = wg0;
    }
    ok("builders never pick or site a pasture in a village off grass", !!builder && picked === 0 && site === null, { builder: !!builder, picked, site: site && site.ox });

    // ---- beef is cooked into steak only in a real furnace, with fuel, in game time
    BF.sky.setTime(0.1);
    const js = herder.jobsite;
    let fpos = null;
    for (let r = 2; r <= 5 && !fpos; r++) for (let dx = -r; dx <= r && !fpos; dx++) for (let dz = -r; dz <= r && !fpos; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = js.x + dx, z = js.z + dz, y = js.y;
      if (x > P.fx0 - 2 && x < P.fx1 + 1 && z > P.fz0 - 2 && z < P.fz1 + 1) continue;   // not on the fence or in the field
      if (BF.world.getBlock(x, y, z) === 0 && BF.SOLID[BF.world.getBlock(x, y - 1, z)] && BF.world.getBlock(x, y + 1, z) === 0
        && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => BF.world.getBlock(x + a, y, z + b) === 0 && BF.SOLID[BF.world.getBlock(x + a, y - 1, z + b)])) fpos = { x, y, z };
    }
    ok("a spot for a furnace by the churn", !!fpos, fpos);
    if (fpos) {
      for (const m of vill()) if (m !== herder && m.cwc) m.cwc = null;
      const cook0 = { raw: c("raw_beef"), steak: c("steak") };
      T.inv.remove(herder.inv, I.raw_beef, cook0.raw); T.inv.remove(herder.inv, I.steak, cook0.steak);
      T.inv.add(herder.inv, I.raw_beef, 14);
      for (const n of ["coal", "charcoal"]) T.inv.remove(herder.inv, I[n], c(n));
      run(20);
      ok("no furnace in the village: the beef stays raw", c("raw_beef") === 14 && c("steak") === 0, [c("raw_beef"), c("steak")]);
      BF.world.setBlock(fpos.x, fpos.y, fpos.z, BF.B.furnace); BF.emit("blockPlaced", fpos.x, fpos.y, fpos.z, BF.B.furnace);
      T.inv.add(herder.inv, I.coal, 2);
      herder.cwc = null;
      let loadedAt = -1, sawRawIn = false;
      for (let i = 0; i < 8000 && c("steak") < 8; i++) {
        step();
        if (BF.sky.time > 0.4) BF.sky.setTime(0.1);
        const st = BF.inventory.furnaceState(fpos.x, fpos.y, fpos.z);
        if (st && st.slots[0] && st.slots[0].id === I.raw_beef) { sawRawIn = true; if (loadedAt < 0) loadedAt = i; }
      }
      ok("with a furnace and coal it cooks the beef past the 6 it keeps into steak", c("steak") === 8 && c("raw_beef") === 6, [c("raw_beef"), c("steak")]);
      ok("in the furnace, in game time (not at once)", sawRawIn && loadedAt >= 0, loadedAt);
      ok("burning its coal", c("coal") < 2, c("coal"));
      ok("the village log has the cooking", (BF.vlog.entries(rec.key) || []).some(e => /\(Cowherd\) cooked 8 steak in the furnace/.test(e[2])));
      BF.world.setBlock(fpos.x, fpos.y, fpos.z, 0); BF.emit("blockBroken", fpos.x, fpos.y, fpos.z, BF.B.furnace);
    }

    // ---- save and load keep the pasture's cows and culls
    for (const st of P.cows.slice()) if (st.mob) BF.mobs.hurt(st.mob, 999, "test");
    run(1); P.cows.length = 0;
    P.cows.push({ fed: 3.5, cd: 4, growAt: null, milkDay: 3, x: P.x0 + 1.5, z: P.z0 + 1.5, mob: null }, { fed: null, cd: 0, growAt: day() + 1, milkDay: null, x: P.x0 + 2.5, z: P.z0 + 1.5, mob: null });
    P.culls = 7;
    const o = {}; C.exportAll(o);
    const k = "pastures:" + key;
    ok("the pasture is saved", !!o[k] && o[k].some(x => x.i === P.idx && x.k === 7 && x.c.length === 2 && x.c[0][3] === 3), o[k]);
    C.reset(); rec._pastures = null; delete rec._pastures;
    C.importAll(JSON.parse(JSON.stringify(o)));
    run(2);
    const P2 = C.pasturesOf(rec).find(p => p.idx === P.idx);
    ok("and loaded again: the same cows (a calf too) and culls", !!P2 && P2.cows && P2.cows.length === 2 && P2.culls === 7 && P2.cows.some(s => s.growAt != null) && P2.cows.some(s => s.milkDay === 3), P2 && { n: P2.cows && P2.cows.length, culls: P2.culls });
    ok("the loaded cows are spawned in the pasture", !!P2 && P2.cows.every(s => s.mob && s.mob.pasture === P2), P2 && P2.cows.map(s => !!s.mob));
    return R;
  });
  for (const l of res.lines) console.log(l);
  if (res.tasks) console.log("tasks", JSON.stringify(res.tasks));
  if (res.herderInv) console.log("cowherd", res.herderInv);
};
