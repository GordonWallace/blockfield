// Bakers, cakes and pies (js/baker.js): the recipes (sugar, pumpkin seeds, pumpkin pie, cake with milk bottles or buckets that come back empty),
// the baker's oven (bakes only with fuel, on game time, the cake's empty bottles come out with it, contents saved), eating a placed cake,
// pumpkin stems and sugar cane growing, the baker in a generator-6 village (no free goods, one per 15 villagers), the baker buying and baking,
// treats bought and eaten, the happiness term. Usage:
//   NODE_PATH=$(npm root -g) node test/run.js /tmp/out test/baker-actions.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const K = BF.baker, I = BF.I, T = BF.trades, W = BF.world;
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    ok("new worlds use village generator 6", BF.state.villages === 6, BF.state.villages);
    BF.mobs.spawning = false;

    // ---- recipes
    const craft = (stacks, w) => { const r = BF.inventory.gridSet(stacks, w); const got = r ? BF.inventory.craftTake() : null; const g = BF.inventory.gridGet(); BF.inventory.gridSet([], 3); return { r, got, g }; };
    const s = id => ({ id, count: 1 });
    BF.inventory.clear();
    let c = craft([s(I.sugar_cane)], 2);
    ok("1 sugar cane makes 1 sugar", c.r && c.r.id === I.sugar && c.r.count === 1, c.r);
    c = craft([s(I.pumpkin)], 2);
    ok("1 pumpkin makes 4 pumpkin seeds", c.r && c.r.id === I.pumpkin_seeds && c.r.count === 4, c.r);
    c = craft([s(I.egg), null, s(I.pumpkin), s(I.sugar)], 2);
    ok("pumpkin + sugar + egg (shapeless) make a pumpkin pie", c.r && c.r.id === I.pumpkin_pie && c.r.count === 1, c.r);
    ok("pumpkin pie is food (8)", BF.items[I.pumpkin_pie].food === 8);
    BF.inventory.clear();
    const cakeGrid = milk => [s(milk), s(milk), s(milk), s(I.sugar), s(I.egg), s(I.sugar), s(I.wheat_item), s(I.wheat_item), s(I.wheat_item)];
    c = craft(cakeGrid(I.milk_bottle), 3);
    ok("3 milk bottles, 2 sugar, an egg and 3 wheat make a cake", c.r && c.r.id === I.cake && c.r.count === 1 && BF.inventory.count(I.cake) === 1, c.r);
    ok("the 3 milk bottles come back empty", c.g.filter(x => x && x.id === I.glass_bottle).length === 3 && !c.g.some(x => x && x.id !== I.glass_bottle), c.g);
    BF.inventory.clear();
    c = craft(cakeGrid(I.milk_bucket), 3);
    ok("3 milk buckets make a cake too, and come back as empty buckets", c.r && c.r.id === I.cake && c.g.filter(x => x && x.id === I.bucket).length === 3, c.g);
    c = craft([s(I.milk_bottle), s(I.milk_bottle), null, s(I.sugar), s(I.egg), s(I.sugar), s(I.wheat_item), s(I.wheat_item), s(I.wheat_item)], 3);
    ok("2 milk bottles make no cake", !c.r, c.r);
    c = craft([s(I.cobblestone), s(I.cobblestone), s(I.cobblestone), s(I.cobblestone), s(I.iron_ingot), s(I.cobblestone), s(I.cobblestone), s(I.cobblestone), s(I.cobblestone)], 3);
    ok("8 cobblestone around an iron ingot make a baker's oven", c.r && c.r.id === BF.B.bakers_oven, c.r);
    ok("the oven is the baker's jobsite", BF.jobs.JOBSITE.baker === "bakers_oven" && BF.blocks[BF.B.bakers_oven].jobsite === "baker");
    ok("block ids appended after the cowherd pack", BF.B.bakers_oven > BF.B.milk_churn && BF.B.cake > BF.B.bakers_oven && I.sugar > I.milk_bottle && I.cake_slice > I.sugar);

    // ---- the village
    const V = { x: -1, z: -72 };   // seed 1: a village of 22 on the plains
    const wv = BF.worldgen.villagesNear(V.x, V.z, 40).find(v => Math.round(v.x) === V.x && Math.round(v.z) === V.z);
    const plan = BF.jobs.planVillage(wv);
    ok("a village of 15+ plans one baker's oven per 15 villagers", plan.filter(j => j.prof === "baker").length === Math.floor(wv.pop / 15), [wv.pop, plan.filter(j => j.prof === "baker").length]);
    const small = BF.worldgen.villagesNear(26, 39, 40).find(v => Math.round(v.x) === 26 && Math.round(v.z) === 39);
    ok("a village of fewer than 15 plans none", small && small.pop < 15 && BF.jobs.planVillage(small).every(j => j.prof !== "baker"), small && small.pop);
    BF.player.teleport(V.x + 0.5, BF.worldgen.heightAt(V.x, V.z) + 3, V.z + 0.5);
    const load = async (x, z) => { for (let i = 0; i < 400; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0 && BF.world.isLoaded(x, z)) break; } };
    await load(V.x, V.z);
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    run(4);
    const key = V.x + "," + V.z;
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(key) || { members: [] }).members.some(m => m.profession === "baker" && m.jobsite)); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(key);
    const vill = () => rec.members.filter(m => m.type === "villager" && !m.dead && !m.removed);
    const baker = rec && rec.members.find(m => m.type === "villager" && m.profession === "baker");
    ok("the village has a baker at its oven", !!baker && !!baker.jobsite && W.getBlock(baker.jobsite.x, baker.jobsite.y, baker.jobsite.z) === BF.B.bakers_oven, baker && baker.jobsite);
    if (!baker) return R;
    ok("its roster slot is #1800", baker.slot && baker.slot.idx === 1800, baker.slot && baker.slot.idx);
    const n = (nm, m = baker) => T.inv.count(m.inv, I[nm]);
    ok("it starts with no cakes, slices, pies or ingredients given", !n("cake") && !n("cake_slice") && !n("pumpkin_pie") && !n("sugar") && !n("milk_bottle"), baker.inv.filter(Boolean).map(x => BF.items[x.id].name + " " + x.count));
    ok("its trades sell cake slices and pies", baker.trades.some(o => o.sell.id === I.cake_slice) && baker.trades.some(o => o.sell.id === I.pumpkin_pie));
    ok("PRODUCE.baker is empty (nothing from nothing)", Array.isArray(T.PRODUCE.baker) && T.PRODUCE.baker.length === 0);
    const other = vill().find(m => m !== baker && !m.child && m.profession !== "nitwit");
    ok("a second baker is refused in a village of fewer than 30", !K.mayHire(other, { prof: "baker" }), vill().length);

    // ---- the oven (unit): no fuel, no bake
    const o = baker.jobsite, ov = K.ovenAt(o.x, o.y, o.z);
    for (const sl of baker.inv.slice()) if (sl && sl.id !== I.emerald) T.inv.remove(baker.inv, sl.id, sl.count);
    const give = (list, m = baker) => { for (const [nm, k] of list) T.inv.add(m.inv, I[nm], k); };
    give([["milk_bottle", 3], ["sugar", 2], ["egg", 1], ["wheat_item", 3]]);
    ok("the baker can make one cake from what it holds", K.canMake(baker, "cake") === 1 && K.canMake(baker, "pie") === 0);
    const loaded = K.load(baker, ov, "cake", 1, K.fuelOk(baker));
    ok("ingredients go into the oven's tray", loaded === 1 && ov.tray.length === 4 && !n("milk_bottle") && !n("egg"), ov.tray.map(x => BF.items[x.id].name + " " + x.count));
    ok("with no fuel nothing burns", !ov.fuel && ov.burn === 0);
    for (let k = 0; k < 600; k++) K.simTick(0.1);
    ok("the oven bakes nothing without fuel (60 s)", !ov.out.length && ov.n === 1 && ov.tray.length === 4, { out: ov.out, n: ov.n });
    ok("the oven says it waits for fuel", /waiting for fuel/.test(K.ovenText(o.x, o.y, o.z)), K.ovenText(o.x, o.y, o.z));
    give([["coal", 1]]);
    K.topUp(baker, ov, K.fuelOk(baker));
    ok("a coal goes into the fuel slot", ov.fuel && ov.fuel.id === I.coal && ov.fuel.count === 1 && !n("coal"), ov.fuel);
    for (let k = 0; k < 400 && !ov.out.length; k++) K.simTick(0.1);
    const outCake = ov.out.find(x => x.id === I.cake), outB = ov.out.find(x => x.id === I.glass_bottle);
    ok("with fuel the cake is baked in " + K.BAKE_T.cake + " s", !!outCake && outCake.count === 1 && ov.n === 0 && !ov.tray.length, ov.out);
    ok("the cake's 3 milk bottles come out empty", outB && outB.count === 3, outB);
    const got = K.unload(baker, ov, false);
    ok("the baker takes out the cake and the empties", n("cake") === 1 && n("glass_bottle") === 3 && !ov.out.length, got);
    ok("a cake is cut into 7 slices", K.slice(baker) === 1 && n("cake_slice") === 7 && !n("cake"));
    // fuel left over comes back
    for (let k = 0; k < 1000 && ov.burn > 0; k++) K.simTick(0.1);   // the coal burns out (a furnace's fire is not saved for later)
    give([["pumpkin", 2], ["sugar", 2], ["egg", 2], ["planks", 6]]);
    K.load(baker, ov, "pie", 2, K.fuelOk(baker));
    const fuel0 = ov.fuel ? ov.fuel.count : 0;
    for (let k = 0; k < 400 && ov.n > 0; k++) K.simTick(0.1);
    K.unload(baker, ov, false);
    ok("two pies baked with planks; the planks it did not burn come back", n("pumpkin_pie") === 2 && fuel0 >= 2 && n("planks") === 6 - Math.ceil(2 * K.BAKE_T.pie / 15), { pies: n("pumpkin_pie"), fuel0, planks: n("planks") });
    // game time: the oven ticks through BF.inventory.simTick (fast-forward too)
    give([["pumpkin", 1], ["sugar", 1], ["egg", 1], ["coal", 1]]);
    K.load(baker, ov, "pie", 1, K.fuelOk(baker));
    for (let k = 0; k < 120; k++) BF.inventory.simTick(0.1);
    ok("the oven bakes on the sim clock (BF.inventory.simTick)", ov.out.some(x => x.id === I.pumpkin_pie), ov.out);
    // saved and loaded
    const saved = {}; K.exportAll(saved);
    K.importAll({}); ok("import clears the ovens", !K.ovenState(o.x, o.y, o.z));
    K.importAll(JSON.parse(JSON.stringify(saved)));
    const ov2 = K.ovenState(o.x, o.y, o.z);
    ok("the oven's contents are saved and loaded (the pie, the coal still burning)", ov2 && ov2.out.some(x => x.id === I.pumpkin_pie) && ov2.burn > 0 && Math.abs(ov2.burn - ov.burn) < 0.01, saved.ovens);
    K.unload(baker, ov2, true);
    for (const sl of baker.inv.slice()) if (sl && sl.id !== I.emerald) T.inv.remove(baker.inv, sl.id, sl.count);

    // ---- the player eats a placed cake a slice at a time
    const px = Math.floor(BF.player.position.x) + 2, pz = Math.floor(BF.player.position.z), py = W.heightAt(px, pz) + 1;
    W.setBlock(px, py, pz, BF.B.cake);
    BF.player.hunger = 2;
    let bites = 0;
    for (let k = 0; k < 10 && W.getBlock(px, py, pz) !== 0; k++) if (K.eatCake(px, py, pz, BF.player, false) === true) bites++;
    ok("a placed cake gives 7 slices of 2 hunger, then it is gone", bites === 7 && W.getBlock(px, py, pz) === 0 && BF.player.hunger === 16, [bites, BF.player.hunger]);
    W.setBlock(px, py, pz, BF.B.cake);
    BF.player.hunger = 20;
    ok("a full player cannot eat cake", typeof K.eatCake(px, py, pz, BF.player, false) === "string" && W.getBlock(px, py, pz) === BF.B.cake);
    ok("a bitten cake is still a cake", K.isCake(BF.B.cake_bitten_3) && K.cakeBites(BF.B.cake_bitten_3) === 3 && BF.blocks[BF.B.cake_bitten_3].drop == null);
    W.setBlock(px, py, pz, 0);

    // ---- growing: a pumpkin stem on farmland becomes a pumpkin; cane grows beside water to 3
    W.setBlock(px, py - 1, pz, BF.B.farmland); W.setBlock(px, py, pz, BF.B.pumpkin_stem);
    for (let k = 0; k < 4000 && W.getBlock(px, py, pz) === BF.B.pumpkin_stem; k++) { BF.warp.advance(0.5); W.tickSim(); }
    ok("a pumpkin stem on farmland grows into a pumpkin", W.getBlock(px, py, pz) === BF.B.pumpkin, BF.blocks[W.getBlock(px, py, pz)].name);
    W.setBlock(px, py, pz, 0);
    W.setBlock(px, py - 1, pz, BF.B.dirt); W.setBlock(px + 1, py - 1, pz, BF.B.water); W.setBlock(px, py, pz, BF.B.sugar_cane);
    for (let k = 0; k < 8000 && K.caneHeight(px, py - 1, pz) < 3; k++) { BF.warp.advance(0.5); W.tickSim(); }
    ok("sugar cane beside water grows to 3 blocks", K.caneHeight(px, py - 1, pz) === 3, K.caneHeight(px, py - 1, pz));
    for (let k = 0; k < 2000; k++) { BF.warp.advance(0.5); W.tickSim(); }
    ok("and no taller", K.caneHeight(px, py - 1, pz) === 3);
    W.setBlock(px, py + 2, pz, 0); W.setBlock(px, py + 1, pz, 0);
    for (let k = 0; k < 8000 && K.caneHeight(px, py - 1, pz) < 2; k++) { BF.warp.advance(0.5); W.tickSim(); }
    ok("cut back to its bottom block, it grows again", K.caneHeight(px, py - 1, pz) >= 2, K.caneHeight(px, py - 1, pz));
    W.setBlock(px + 1, py - 1, pz, BF.B.dirt);
    for (let y = py + 2; y >= py; y--) W.setBlock(px, y, pz, 0);
    W.setBlock(px, py, pz, BF.B.sugar_cane);
    for (let k = 0; k < 4000; k++) { BF.warp.advance(0.5); W.tickSim(); }
    ok("without water it does not grow", K.caneHeight(px, py - 1, pz) === 1);
    W.setBlock(px, py, pz, 0);

    // ---- treats: eaten once a day at most, first when due; the happiness term
    const eater = other;
    const stash = [];
    for (let i = 0; i < eater.inv.length; i++) { const x = eater.inv[i]; if (x && BF.food.isFood(x.id)) { stash.push(x); eater.inv[i] = null; } }
    give([["bread", 2], ["cake_slice", 2]], eater);
    const L = BF.food.life(eater); L.sat = 0; L.tt = null;
    BF.food.eat(eater, 0.4);
    ok("a villager due a treat eats a cake slice first", n("cake_slice", eater) === 1 && n("bread", eater) === 2, [n("cake_slice", eater), n("bread", eater)]);
    ok("and it counts toward happiness for 3 days", K.treatCounts(eater));
    L.sat = 0;
    BF.food.eat(eater, 1);
    ok("the same day it eats bread, not its other slice", n("cake_slice", eater) === 1 && n("bread", eater) === 1, [n("cake_slice", eater), n("bread", eater)]);
    const H = () => BF.happiness.score(rec).terms.find(t => t.id === "treats");
    ok("the happiness breakdown has the treats term (+1 each)", H() && H().weight === 1 && H().count >= 1, H());
    const d0 = BF.sky.day;
    BF.sky.day = d0 + 4;
    ok("a treat eaten 4 days ago no longer counts", !K.treatCounts(eater));
    BF.sky.day = d0;
    T.inv.remove(eater.inv, I.bread, 9); T.inv.remove(eater.inv, I.cake_slice, 9);
    for (const x of stash) T.inv.add(eater.inv, x.id, x.count);
    // buying: a treat now and then, from the baker's offer
    give([["cake_slice", 14], ["pumpkin_pie", 3]]);
    T.syncFeed(baker);
    BF.sky.setTime(0.1);
    T.inv.add(eater.inv, I.emerald, 3);
    BF.food.life(eater).tb = BF.sky.day + BF.sky.time - 4;
    ok("a villager with emeralds and no treat for 3 days wants one", K.treatWanted(eater));
    eater.fshop = eater.fshop || { stage: null, deal: null, checkT: 9, avoid: {}, cd: 0 }; eater.fshop.avoid = {};
    const td = K.findTreatSeller(eater);
    ok("it finds the baker's treat offer", !!td && td.seller === baker && K.isTreat(td.item), td && { item: BF.items[td.item].name, from: td.seller.profession });
    const em0 = n("emerald", eater);
    const bought = td ? BF.villageLife._test.doFoodDeal(eater, td) : 0;
    ok("it buys one treat offer for an emerald", bought === 1 && n("emerald", eater) === em0 - 1 && (n("cake_slice", eater) + n("pumpkin_pie", eater)) > 0, [n("emerald", eater), n("cake_slice", eater), n("pumpkin_pie", eater)]);
    ok("then it wants none for 3 days", !K.treatWanted(eater));
    ok("everyday hunger does not buy treats while other food is for sale", BF.villageLife._test.dealWith(eater, baker, 3) === null);
    ok("the baker never eats its wares or its milk", BF.food.edible(baker).every(e => !K.isTreat(e.id) && e.id !== I.milk_bottle));
    ok("the sale is logged (sold a treat)", K.log.some(e => e.kind === "sold"), K.log.slice(-3));
    T.inv.remove(eater.inv, I.cake_slice, 64); T.inv.remove(eater.inv, I.pumpkin_pie, 64);
    for (const sl of baker.inv.slice()) if (sl && sl.id !== I.emerald) T.inv.remove(baker.inv, sl.id, sl.count);

    // ---- the baker at work: ingredients and coal in hand, it walks to its oven, bakes and slices
    give([["milk_bottle", 6], ["sugar", 4], ["egg", 2], ["wheat_item", 6], ["coal", 2]]);
    T.inv.add(baker.inv, I.emerald, 10);
    BF.sky.setTime(0.06);
    baker.bkr = null;
    let saw = new Set();
    for (let k = 0; k < 900 && n("cake_slice") + n("cake") * 7 < 14; k++) { run(0.25); if (baker.bkr && baker.bkr.stage) saw.add(baker.bkr.stage); }
    ok("the baker bakes 2 cakes in its oven and cuts them", n("cake_slice") + 7 * n("cake") === 14, { slices: n("cake_slice"), cakes: n("cake"), stages: [...saw], log: K.log.slice(-5) });
    ok("it waited at the oven (load, bake)", saw.has("bake"), [...saw]);
    ok("the empties are its spare goods", n("glass_bottle") === 6 && BF.market.spareOf(baker, I.glass_bottle) === 6, n("glass_bottle"));
    const hold = K.holdings(baker);
    ok("the debug holdings show ingredients and goods", hold.goods.slices + hold.goods.cakes * 7 === 14 && hold.ingredients.wheat === 0 && hold.made.cakes >= 2, hold);
    ok("the bake is logged", K.log.some(e => e.kind === "collect" && e.cakes >= 1));
    ok("the baker's ingredients are its reserve (not for sale)", (() => { give([["egg", 4]]); baker._res = null; const r = BF.market.spareOf(baker, I.egg); T.inv.remove(baker.inv, I.egg, 4); return r === 0; })());

    // ---- the cowherd keeps its last 3 bottles for the baker only
    const herder = vill().find(m => m.profession === "cowherd");
    if (herder) {
      T.inv.add(herder.inv, I.milk_bottle, 3 - n("milk_bottle", herder) > 0 ? 3 - n("milk_bottle", herder) : 0);
      ok("the cowherd keeps 3 milk bottles from everyone else", BF.market.spareOf(herder, I.milk_bottle) <= Math.max(0, n("milk_bottle", herder) - 3));
      const d = K.shopping(baker);
      ok("the baker shops for milk when short of it", d.some(e => e.nm === "milk_bottle"), d);
    }
    return R;
  });
  for (const l of res.lines) console.log(l);
};
