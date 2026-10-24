// @ci integration suite=farming hosts=worker,server
// Bees and beekeepers (js/bees.js, js/beekeeper.js): NODE_PATH=$(npm root -g) node test/run.js /tmp/bees test/bees-actions.js
// On the planet (spec r14-22): planet seed 123 (generator 4, village generator 10), whose plains village nearest spawn has beekeepers; the test
// makes that world itself, whatever the page booted.
// Recipes (beehive, candle, honey extractor) and the trade table; village generator 8+: a grass village with a beekeeper, its extractor, 2 hives of
// 8-12 bees and a flower bed; bees come out by day and only in dry weather, go home at dusk and in rain, are dropped when their chunk unloads and
// scattered near flowers when it loads again; honey rises only after flower visits (none without flowers); harvesting with shears and bottles;
// the 25% crop boost within 8 blocks by day; stings only on players; colony growth to 30; the 600-bee cap (the allowances share out exactly 600,
// nearest homes first, and homes past it keep their bees in; on open planet ground bees rest at home between trips, so the bees out at once stay
// well under 600 even with 700+ to share); save and load of hive state; bees led
// into a hive by a held flower; the beekeeper harvests, plants picked flowers, builds a hive from real honeycomb and planks, and makes candles.
module.exports = async (pg) => {
  const lib = require('./lib');
  await lib.newWorld(pg, 123, { gen: 4, villages: 10, gameMode: "survival" });
  if (await pg.evaluate(() => BF.simHost.worker)) await pg.evaluate(() => BF.player.start());   // (the page's player: the stings below)
  const res = await lib.sim(pg, async () => {   // (where the simulation is: spec r15-43)
    const R = { lines: [], info: {} }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
    const I = BF.I, B = BF.B, T = BF.trades, inv = T.inv, W = BF.world, BE = BF.bees, BK = BF.beekeeper;
    const c = (m, n) => inv.count(m.inv, I[n]);
    const settle = async (x, z) => {
      for (let i = 0; i < 400 && !W.isLoaded(x, z); i++) { W.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 300; i++) { W.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (W.queueLength === 0) break; }
    };
    BF.state.paused = true;
    for (let i = 0; i < 1800 && BF.preparing; i++) await new Promise(r => setTimeout(r, 100));   // a planet first works out its rivers
    BF.state.paused = true;
    ok("new worlds use village generator 8 or later", BF.state.villages >= 8, BF.state.villages);
    const P = BF.planet;
    BF.mobs.spawning = false;
    if (BF.weather && BF.weather.set) BF.weather.set("clear", 1e6);

    // ---- recipes and trades
    const craftG = (stacks, w) => { const r = BF.inventory.gridSet(stacks, w); BF.inventory.gridSet([], 3); return r; };
    const s = id => ({ id, count: 1 });
    BF.inventory.clear();
    let r = craftG([s(I.planks), s(I.planks), s(I.planks), s(I.honeycomb), s(I.honeycomb), s(I.honeycomb), s(I.birch_planks), s(I.planks), s(I.planks)], 3);
    ok("6 planks around 3 honeycomb make a beehive", r && r.id === B.beehive, r);
    r = craftG([s(I.string), s(I.honeycomb)], 2);
    ok("string and honeycomb make a candle", r && r.id === B.candle, r);
    r = craftG([s(I.planks), s(I.iron_ingot), s(I.planks), s(I.planks), null, s(I.planks)], 3);
    ok("4 planks around an iron ingot make a honey extractor", r && r.id === B.honey_extractor, r);
    ok("the honey extractor is the beekeeper's jobsite", BF.jobs.JOBSITE.beekeeper === "honey_extractor" && BF.blocks[B.honey_extractor].jobsite === "beekeeper");
    ok("candles give light 3", BF.EMIT[B.candle] === 3);
    ok("a honey bottle restores 6 hunger and leaves a glass bottle", BF.items[I.honey_bottle].food === 6 && BF.items[I.honey_bottle].container === "glass_bottle");
    ok("the beekeeper sells honey, honeycomb and candles, buys bottles, restocks nothing", ["honey_bottle", "honeycomb", "candle"].every(n => T.table("beekeeper")[0].some(o => o.sell.id === I[n]))
      && T.table("beekeeper")[0].some(o => o.buy.some(b => b.id === I.glass_bottle)) && T.PRODUCE.beekeeper.length === 0);
    const kStart = T.stockFor("beekeeper", {});
    ok("a generated beekeeper starts with no honey goods", !kStart.some(x => x && [I.honey_bottle, I.honeycomb, I.candle].includes(x.id)), kStart.map(x => x && BF.items[x.id].name));
    ok("nest drops nothing, a hive drops itself", BF.blocks[B.bee_nest].drop == null && BF.blocks[B.beehive].drop === B.beehive);

    // ---- the grass village nearest spawn with a beekeeper: a beekeeper, its extractor, 2 hives and a flower bed
    const sp0 = BF.player.position, vnear = BF.worldgen.villagesNear(sp0.x, sp0.z, 3000).sort((a, b) => P.distance(sp0, a) - P.distance(sp0, b));
    const vb = vnear.find(v => BF.jobs.planVillage(v).some(j => j.prof === "beekeeper"));
    ok("a village near spawn plans a beekeeper", !!vb, vnear.slice(0, 4).map(v => [v.x, v.z, v.pop]));
    if (!vb) return R;
    const V = { x: Math.round(vb.x), z: Math.round(vb.z) };
    BF.player.teleport(V.x + 0.5, BF.worldgen.heightAt(V.x, V.z) + 2, V.z + 0.5);
    await settle(V.x, V.z);
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    // the most bees each home has had out at once from here on: its chunk has just loaded by day in dry weather, so its bees are scattered
    // within R of it and fly home over the next seconds, before the hives are known below
    const peakOf = new Map(), notePeaks = () => { for (const h of BE.loadedHomes()) peakOf.set(h, Math.max(peakOf.get(h) || 0, BE.out(h).length)); };
    for (let k = 0; k < 160; k++) { step(); notePeaks(); }
    let rec = null;
    for (let k = 0; k < 160 && !((rec = BF.mobs.villages.get(V.x + "," + V.z)) && rec.members.some(m => m.profession === "beekeeper")); k++) { W.update(V.x, V.z, 8); for (let j = 0; j < 10; j++) { step(); notePeaks(); } }
    const K = rec && rec.members.find(m => m.profession === "beekeeper" && !m.dead);
    ok("the village has a beekeeper", !!K, rec && rec.members.map(m => m.profession));
    if (!K) return R;
    ok("its roster key is not one breeding keeps for newborns (#2000+k)", K.slot && !K.slot.bred && K.slot.idx < BF.breeding.KEY_BASE, K.slot && K.slot.idx);
    // (a big village can plan two apiaries, each an extractor with 2 hives; this beekeeper's is the one at its own extractor, and an apiary
    // planned within HIVE_R (24 blocks) of it shares its hives, as the beekeeper's hives are all the hives within that reach)
    const ext = K.jobsite && rec.wg.jobsites.find(j => j.prof === "beekeeper" && j.x === K.jobsite.x && j.z === K.jobsite.z);
    const near = j => ext && Math.hypot(j.x - ext.x, j.z - ext.z) <= 24;
    const plan = rec.wg.jobsites.filter(j => ["beekeeper", "beehive", "flower"].includes(j.prof) && near(j));
    const hp = plan.filter(j => j.prof === "beehive"), fp = plan.filter(j => j.prof === "flower"), nApi = plan.filter(j => j.prof === "beekeeper").length;
    ok("its extractor, 2 hives (per apiary in reach) and a flower bed are in the world", ext && W.getBlock(ext.x, ext.y, ext.z) === B.honey_extractor && hp.length === 2 * nApi && hp.every(h => W.getBlock(h.x, h.y, h.z) === B.beehive)
      && fp.length >= 4 && fp.every(f => BE.isFlower(W.getBlock(f.x, f.y, f.z))), plan.map(j => [j.prof, j.x, j.y, j.z, BF.blocks[W.getBlock(j.x, j.y, j.z)].name]));
    ok("the beekeeper works at that extractor", K.jobsite && K.jobsite.x === ext.x && K.jobsite.z === ext.z, K.jobsite);
    ok("its hire kit: shears and glass bottles", c(K, "shears") >= 1 && c(K, "glass_bottle") >= 16, { shears: c(K, "shears"), bottles: c(K, "glass_bottle") });
    const H = hp.map(h => BE.homeAt(h.x, h.y, h.z));
    ok("generated village hives hold 8-12 bees", H.every(h => h && h.kind === "hive" && h.bees >= 8 && h.bees <= 12), H.map(h => h && h.bees));
    ok("they are the beekeeper's hives", BK.hivesOf(K).length === hp.length, { hives: BK.hivesOf(K).length, apiaries: nApi });
    R.info.village = { ext, hives: H.map(h => [h.x, h.y, h.z, h.bees]) };

    // ---- bees out by day, home at dusk and in rain
    const h0 = H[0];
    // (counted from the hive's chunk loading: at about 8 bees, those coming out of the hive one by one over a minute, a trip of 10-25 s each
    // and 15-35 s inside between trips, are 3 or 4 out at once at most, so half of them out together is the scatter at chunk load)
    const peak0 = peakOf.get(h0) || 0;
    let out1 = peak0;
    for (let i = 0; i < 1400; i++) { step(); out1 = Math.max(out1, BE.out(h0).length); }   // 70 s: they come out over about a minute, resting inside between trips
    ok("by day a hive's bees come out", out1 >= h0.bees / 2 && BE.list.length > 0, { peakOut: out1, atLoad: peak0, bees: h0.bees, all: BE.list.length });
    let sides = 0; for (let i = 0; i < 400; i++) { const sp = BE.landingSpot(h0.x, h0.y + 2, h0.z, 6); if (sp && sp.ny === 0) sides++; }
    R.info.sideSpots = sides;
    let landed = 0, wall = 0, flowerL = 0, ceil = 0;
    for (let i = 0; i < 1200; i++) { step(); for (const b of BE.list) if (b.mode === "land" && b.land) { landed++; if (b.land.ny === 0) wall++; if (b.land.flower) flowerL++; if (b.land.ny < 0) ceil++; } }
    ok("bees land on flowers and other surfaces, never on ceilings", flowerL > 0 && landed > flowerL && ceil === 0, { landed, wall, flowerL, ceil });
    // walls: rest stops on a wall are rare by chance, so send one bee to a wall spot and see it land there, flat against the face
    // Each try takes the nearest bee not tried yet that is free to fly up: one under an overhang (the leaves of a tree) can only hop straight up into
    // them on its way to a spot above and beside it, so it gives up after 6 s (js/bees.js stuck), and as the nearest bee it was picked for every try.
    // The beekeeper is kept from leading wild bees meanwhile: a bee near a villager holding a flower follows it and never gets to the wall.
    if (K.bkp && K.bkp.stage) BK.forceStop(K);
    if (K.bkp) K.bkp.cd = 1e12;
    const tried = new Set(), free = b => !BF.SOLID[W.getBlock(Math.floor(b.x), Math.floor(b.y) + 1, Math.floor(b.z))];
    let ws = null, wb = null, onWall = false;
    for (let tries = 0; tries < 6 && !onWall; tries++) {   // a few wall spots, each with the bee nearest it (a spot can be awkward to reach)
      ws = null;
      for (let i = 0; i < 4000 && !ws; i++) { const sp = BE.landingSpot(h0.x, h0.y + 2, h0.z, 8); if (sp && sp.ny === 0) ws = sp; }
      if (!ws) break;
      wb = BE.list.filter(b => !b.follow && b.home && !tried.has(b) && free(b) && !(b.angry > BF.simNow())).sort((p, q) => Math.hypot(p.x - ws.x, p.y - ws.y, p.z - ws.z) - Math.hypot(q.x - ws.x, q.y - ws.y, q.z - ws.z))[0];
      if (!wb) break;
      tried.add(wb);
      wb.mode = "fly"; wb.tgt = ws; wb.land = null; wb.stuck = 0; wb.lastD = Infinity; wb.front = false; wb.restedOut = wb.restedBack = true;
      for (let i = 0; i < 400 && !onWall && wb.tgt === ws; i++) { step(); onWall = wb.mode === "land" && wb.land === ws; }
    }
    ok("bees land on walls", sides > 0 && onWall, { sides, spot: ws && [ws.x, ws.y, ws.z, ws.nx, ws.nz], bee: wb && [wb.mode, +wb.x.toFixed(2), +wb.y.toFixed(2), +wb.z.toFixed(2)], tries: tried.size });
    if (K.bkp) K.bkp.cd = 0;
    ok("honey rises after flower visits", h0.honey > 0, h0.honey);
    BF.sky.setTime(BE.DUSK - 0.002);
    for (let i = 0; i < 200; i++) step();
    ok("at dusk the bees head home", BE.list.filter(b => b.home === h0).every(b => b.mode === "home" || b.follow), BE.list.filter(b => b.home === h0).map(b => b.mode));
    for (let i = 0; i < 1600 && BE.out(h0).length; i++) step();
    ok("and are gone into their hive (counted, not tracked)", BE.out(h0).length === 0 && h0.bees >= 8, { out: BE.out(h0).length, bees: h0.bees });
    BF.sky.setTime(0.1);
    for (let i = 0; i < 1400; i++) step();
    ok("next morning they come out again (new bees from the count)", BE.out(h0).length > 0);
    if (BF.weather && BF.weather.set) { BF.weather.set("rain", 600); BF.weather.intensity = 1; }
    for (let i = 0; i < 40; i++) step();
    const rainNow = BF.weather.raining && BF.weather.precipAt(h0.x, h0.z, h0.y) !== 0;
    for (let i = 0; i < 1600 && BE.out(h0).length; i++) step();
    ok("rain sends them home", !rainNow || BE.out(h0).length === 0, { rainNow, out: BE.out(h0).length });
    if (BF.weather && BF.weather.set) BF.weather.set("clear", 1e6);
    BF.weather.intensity = 0;
    for (let i = 0; i < 1400; i++) step();

    // ---- no flowers, no honey; harvesting
    const W0 = { x: V.x + 400, z: V.z };   // a hive far from flowers? test by clearing the flowers around h1 instead
    void W0;
    const h1 = H[1];
    const fl = BE.flowersNear(h1, true);
    const saved = fl.map(p => [p, W.getBlock(p[0], p[1], p[2])]);
    for (const p of fl) W.setBlock(p[0], p[1], p[2], 0);
    for (const b of BE.list) if (b.home === h1) b.nectar = false;
    h1.honey = 0;
    if (K.bkp && K.bkp.stage) BK.forceStop(K);
    if (K.bkp) K.bkp.cd = 1e12;   // the beekeeper would replant them
    for (let i = 0; i < 2400; i++) step();
    if (K.bkp) K.bkp.cd = 0;
    ok("no flowers within reach, no honey", h1.honey === 0 && BE.flowersNear(h1, true).length === 0, { honey: h1.honey, fl: BE.flowersNear(h1, true).length });
    for (const [p, id] of saved) W.setBlock(p[0], p[1], p[2], id);
    h1.honey = BE.FULL;
    const g1 = BE.harvest(h1.x, h1.y, h1.z, "shears", "test");
    ok("shears on a full hive give 3 honeycomb and empty it", g1 && g1.id === I.honeycomb && g1.n === 3 && h1.honey === 0, g1);
    ok("an unfull hive gives nothing", BE.harvest(h1.x, h1.y, h1.z, "bottle", "test") === null);
    h1.honey = BE.FULL;
    const g2 = BE.harvest(h1.x, h1.y, h1.z, "bottle", "test");
    ok("a glass bottle on a full hive gives a honey bottle", g2 && g2.id === I.honey_bottle && g2.n === 1);

    // ---- stings: players only
    if (BF.page) BF.player.start();   // (off the page the page's player has started: the test does that before)
    BF.player.setGameMode("survival"); BF.state.paused = true;
    if (BF.page) for (let i = 0; i < 50; i++) BF.player.update(0.05);   // the spawn wait (off the page: the page body's) and spawn protection end
    BF.player.health = 20;
    const hp0 = BF.player.health;
    const pp = BF.player.position;
    BF.player.teleport(h1.x + 2.5, h1.y + 0.1, h1.z + 0.5);
    h1.honey = BE.FULL;
    BE.harvest(h1.x, h1.y, h1.z, "bottle", "player");
    const angry = BE.list.filter(b => b.home === h1 && b.angry > BF.simNow()).length;
    let stings = 0, hurt = 0; if (BF.on) { BF.on("beeSting", () => stings++); BF.on("playerDamaged", n => { hurt += n; }); }
    // (off the page the player's body is the page's: a hurt goes to it from BF.player.damage, js/protocol.js, with no playerDamaged here)
    const damage0 = BF.player.damage;
    if (!BF.page) BF.player.damage = function (n) { if (n > 0) hurt += n; return damage0.apply(this, arguments); };
    for (let i = 0; i < 400; i++) { step(); if (BF.page) BF.player.update(0.05); BF.player.position.set(h1.x + 2.5, h1.y + 0.1, h1.z + 0.5); }
    ok("harvesting by day while bees are out angers them and they sting the player", angry > 0 && hurt > 0, { angry, hurt, stings, mode: BF.player.gameMode, modes: BE.list.filter(b => b.home === h1).map(b => b.mode + (b.stung ? "!" : "")).join(",") });
    BF.player.damage = damage0;
    BF.player.health = 20; BF.player.setGameMode("creative");
    const villHp = rec.members.filter(m => !m.dead).map(m => m.health);
    h1.honey = BE.FULL; BE.harvest(h1.x, h1.y, h1.z, "bottle", K);
    ok("a villager harvesting angers nobody", !BE.list.some(b => b.home === h1 && b.angry > BF.simNow() + BE.ANGRY - 1));
    void villHp; void pp;

    // ---- crops grow 25% faster within 8 blocks by day
    ok("crop factor 1.25 by day within 8 blocks of a hive with bees", BE.cropFactor(h0.x + 5, h0.y, h0.z + 3) === 1.25, BE.cropFactor(h0.x + 5, h0.y, h0.z + 3));
    ok("no boost 12 blocks away", BE.cropFactor(h0.x - 12, h0.y, h0.z) === 1, BE.cropFactor(h0.x - 12, h0.y, h0.z));
    BF.sky.setTime(0.7); BE.housekeeping();
    ok("no boost at night", BE.cropFactor(h0.x + 5, h0.y, h0.z + 3) === 1);
    BF.sky.setTime(0.12);
    for (let i = 0; i < 40; i++) step();

    // ---- colony growth: one a day with 6+ flowers, up to 30
    const planted = [];   // the beekeeper may have picked some by now: top them up to 6 on open grass near the hive, removed after
    for (let r = 3; r <= 12 && BE.flowersNear(h0, true).length < 6; r++) for (let a = 0; a < 16 && BE.flowersNear(h0, true).length < 6; a++) {
      const x = Math.round(h0.x + Math.cos(a / 16 * 6.283) * r), z = Math.round(h0.z + Math.sin(a / 16 * 6.283) * r), y = W.heightAt(x, z);
      if (W.getBlock(x, y, z) === B.grass && W.getBlock(x, y + 1, z) === 0 && W.setBlock(x, y + 1, z, B.poppy)) planted.push([x, y + 1, z]);
    }
    const gN = BE.flowersNear(h0, true).length;
    h0.bees = 29; h0.day = BF.sky.day - 1; BE.housekeeping();
    ok("a home with 6+ flowers gains a bee a day", gN >= 6 && h0.bees === 30, { gN, bees: h0.bees });
    h0.day = BF.sky.day - 1; BE.housekeeping();
    ok("never more than 30", h0.bees === 30, h0.bees);
    for (const [x, y, z] of planted) if (W.getBlock(x, y, z) === B.poppy) W.setBlock(x, y, z, 0);
    h1.bees = 9;

    // ---- chunk unload and reload: dropped, then scattered near flowers
    const nOut = BE.out(h0).length;
    const gV = P.grid(V.x, V.z), far = { x: V.x + (gV.u < P.N / 2 ? 900 : -900), z: V.z };   // (900 blocks toward the middle of the village's face)
    BF.player.teleport(far.x + 0.5, BF.worldgen.heightAt(far.x, far.z) + 2, far.z + 0.5);
    const vl = BF.villageSim.LIMITS.villages; BF.villageSim.LIMITS.villages = 0; BF.villageSim.reset();   // the village sim would keep its chunks
    for (let i = 0; i < 300 && W.isLoaded(h0.x, h0.z); i++) { W.update(far.x, far.z, 8); step(); await new Promise(r => setTimeout(r, 20)); }
    BF.villageSim.LIMITS.villages = vl;
    ok("bees are dropped when their hive's chunk unloads", !W.isLoaded(h0.x, h0.z) && BE.out(h0).length === 0 && h0.bees === 30, { loaded: W.isLoaded(h0.x, h0.z), out: BE.out(h0).length, was: nOut, bees: h0.bees });
    BF.player.teleport(V.x + 0.5, BF.worldgen.heightAt(V.x, V.z) + 2, V.z + 0.5);
    await settle(V.x, V.z);
    step(); step(); for (let i = 0; i < 30; i++) step();
    const hb = BE.homeAt(h0.x, h0.y, h0.z), back = BE.out(hb);
    ok("reloaded by day: its bees are scattered around it, most on flowers", back.length >= 20 && back.every(b => Math.hypot(b.x - hb.x, b.z - hb.z) <= BE.R + 2) && back.filter(b => b.land && b.land.flower).length > back.length / 3,
      { n: back.length, onFl: back.filter(b => b.land && b.land.flower).length });

    // ---- save and load keeps every home's count and honey
    hb.honey = 3;
    const snap = BE.serialize();
    BE.deserialize(snap);
    const hb2 = BE.homeAt(hb.x, hb.y, hb.z);
    ok("save and load keep bees and honey", hb2 && hb2.bees === 30 && hb2.honey === 3, hb2 && [hb2.bees, hb2.honey]);
    for (let i = 0; i < 1400; i++) step();

    // ---- leading bees with a flower into another hive
    let spot = null;   // 10-16 blocks from the hive, more than 8 from every other home
    for (let r = 10; r <= 16 && !spot; r++) for (let a = 0; a < 32 && !spot; a++) {
      const x = Math.round(hb2.x + Math.cos(a / 32 * 6.283) * r), z = Math.round(hb2.z + Math.sin(a / 32 * 6.283) * r), y = W.heightAt(x, z) + 1;
      if (Math.abs(y - hb2.y) > 3 || BE.loadedHomes().some(o => Math.hypot(o.x - x, o.z - z) < 9)) continue;
      if (W.getBlock(x, y, z) === 0 && W.getBlock(x, y + 1, z) === 0 && BF.SOLID[W.getBlock(x, y - 1, z)]) spot = { x, y, z };
    }
    W.setBlock(spot.x, spot.y, spot.z, B.beehive);
    const nh = BE.homeAt(spot.x, spot.y, spot.z);
    ok("a placed hive starts empty", nh && nh.bees === 0 && nh.honey === 0, nh && nh.bees);
    if (K.bkp && K.bkp.stage) BK.forceStop(K);
    if (K.bkp) K.bkp.cd = 1e12;   // its own leading would fill the new hive too
    BF.inventory.clear(); BF.inventory.setSlot(0, { id: B.poppy, count: 1 }); BF.inventory.select(0);
    BF.player.teleport(hb2.x + 1.5, hb2.y + 0.1, hb2.z + 1.5);
    let fol = 0;   // stand near a bee of that hive that is out (they may all be off at flowers): within 8 blocks it comes over
    for (let i = 0; i < 1200 && !(fol = BE.list.filter(b => b.follow && b.follow.who === "player").length); i++) {
      if (i % 100 === 0) { const b = BE.out(hb2)[0]; if (b) BF.player.position.set(b.x + 2, Math.max(b.y - 1.3, W.heightAt(b.x + 2, b.z) + 1), b.z); }
      step();
    }
    for (let i = 0; i < 40; i++) step();
    fol = BE.list.filter(b => b.follow && b.follow.who === "player").length;
    ok("bees follow a player holding a flower", fol > 0, { fol, sel: BF.inventory.selected(), out: BE.out(hb2).length, near: BE.list.filter(b => Math.hypot(b.x - BF.player.position.x, b.z - BF.player.position.z) < 8).length });
    const total = () => BE.loadedHomes().reduce((n, o) => n + o.bees, 0);
    const before = [hb2.bees, nh.bees, total()];
    const p0 = { x: BF.player.position.x, z: BF.player.position.z };
    for (let i = 0; i < 600; i++) { const t = Math.min(1, i / 300), x = p0.x + (spot.x + 1.5 - p0.x) * t, z = p0.z + (spot.z + 0.5 - p0.z) * t; BF.player.position.set(x, Math.max(W.heightAt(Math.floor(x), Math.floor(z)) + 1, spot.y) + 0.1, z); step(); }
    ok("led to another hive they move in, one from one count to the other", nh.bees > 0 && before[1] === 0 && total() === before[2] && hb2.bees < before[0], { before, after: [hb2.bees, nh.bees, total()] });
    BF.inventory.clear(); if (K.bkp) K.bkp.cd = 0;
    W.setBlock(spot.x, spot.y, spot.z, 0);
    ok("breaking a hive drops its record", !BE.homeAt(spot.x, spot.y, spot.z));

    // ---- the 600-bee cap: 700+ bees in loaded homes (extra hives on open ground near the village), in dry daylight
    if (BF.weather && BF.weather.set) BF.weather.set("clear", 1e6);
    BF.sky.setTime(0.12);
    const all = BE.loadedHomes();
    for (const h of all) h.bees = 30;
    const needed = Math.ceil(700 / 30) - all.length;
    const extra = [];
    for (let i = 0; i < 400 && extra.length < needed; i++) {   // a 4-block grid outward from the village's corner, on dry open ground
      const x = V.x - 30 + (i % 20) * 4, z = V.z + 30 + Math.floor(i / 20) * 4, y = W.heightAt(x, z) + 1;
      if (!W.isLoaded(x, z) || W.getBlock(x, y, z) !== 0 || !BF.SOLID[W.getBlock(x, y - 1, z)] || BF.FLUID[W.getBlock(x, y - 1, z)]) continue;
      if (BE.loadedHomes().some(o => Math.hypot(o.x - x, o.z - z) < 3)) continue;
      W.setBlock(x, y, z, B.beehive); const h = BE.homeAt(x, y, z); if (h) { h.bees = 30; extra.push([x, y, z]); }
    }
    BE.housekeeping();
    const homes = BE.loadedHomes(), have = homes.reduce((n, h) => n + h.bees, 0), allowed = homes.reduce((n, h) => n + h.allow, 0);
    const byDist = homes.slice().sort((a, b) => a.dist - b.dist), firstShut = byDist.findIndex(h => h.allow < h.bees);
    const nearestFirst = firstShut >= 0 && byDist.slice(firstShut + 1).every(h => h.allow === 0);
    ok("with more than 600 bees to share, the allowances add up to exactly 600, nearest homes first", have > BE.CAP && allowed === BE.CAP && nearestFirst,
      { have, allowed, homes: homes.length, extra: extra.length, shut: byDist.filter(h => h.allow === 0).length });
    const shut = byDist.filter(h => h.allow === 0);
    let peak = 0, shutOut = 0, overAllow = 0;
    for (let i = 0; i < 1800; i++) {
      step(); peak = Math.max(peak, BE.list.length);
      for (const h of shut) shutOut = Math.max(shutOut, BE.out(h).length);
      if (i % 20 === 19) for (const h of BE.loadedHomes()) overAllow = Math.max(overAllow, BE.out(h).length - h.allow);
    }
    ok("never more than 600 bees out at once, the homes past the cap keep theirs in, and none has more out than its allowance", peak <= BE.CAP && peak > 150 && shut.length > 0 && shutOut === 0 && overAllow <= 0,
      { peak, shut: shut.length, shutOut, overAllow, homes: BE.loadedHomes().length });
    for (const [x, y, z] of extra) W.setBlock(x, y, z, 0);
    R.info.stats = BE.stats();
    return R;
  });
  for (const l of res.lines) console.log(l);
  console.log("info", JSON.stringify(res.info).slice(0, 4000));
};
