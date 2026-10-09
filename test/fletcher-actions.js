// Fletcher, string and flint checks: NODE_PATH=$(npm root -g) node test/run.js /tmp/fl test/fletcher-actions.js
// Unit part: trade tables and daily restock (no arrows or iron swords from nothing), starting packs, the fletcher crafts arrows and bows only
// from what it holds (exact recipe amounts, game-time crafting), buys string / flint / sticks / feathers from villagers who hold them at
// their own offers, the shepherd spins 1 wool into 2 string and sells it, the miner keeps flint from gravel.
// Live part, in a real village (seed 1, paused stepping): a fletcher with emeralds and no materials buys from the shepherd (string it spun
// itself), a miner, a forester and a stand-in poultry keeper (feathers), makes arrows and a bow at its table, and both log to BF.vlog.
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [], info: {} }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, T = BF.trades, inv = T.inv, FL = BF.fletcher, SH = BF.shepherd;
    const c = (m, n) => inv.count(m.inv, I[n]);
    const names = a => a.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count);
    const fmt = o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name;
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;

    // ---- trade tables and the daily restock
    R.info.fletcherOffers = [1, 2, 3, 4, 5].map(l => T.offers("fletcher", l).map(fmt));
    const sells = (prof, n) => [1, 2, 3, 4, 5].some(l => T.offers(prof, l).some(o => o.sell.id === I[n]));
    ok("fletcher sells arrows and bows from level 1", T.offers("fletcher", 1).some(o => o.sell.id === I.arrow) && T.offers("fletcher", 1).some(o => o.sell.id === I.bow));
    ok("fletcher no longer sells flint, feathers or string", !sells("fletcher", "flint") && !sells("fletcher", "feather") && !sells("fletcher", "string"));
    ok("shepherd sells string, miner sells flint", sells("shepherd", "string") && sells("miner", "flint"), { shepherd: T.offers("shepherd", 1).map(fmt), miner: T.offers("miner", 1).map(fmt) });
    const unit = (prof, n) => { const o = T.offers(prof, 1).find(o => o.sell.id === I[n]); return o && +(o.buy[0].n / o.sell.n / T.VALUE[n]).toFixed(3); };
    ok("string and flint priced at 104-114% of VALUE", unit("shepherd", "string") >= 1.04 && unit("shepherd", "string") <= 1.14 && unit("miner", "flint") >= 1.04 && unit("miner", "flint") <= 1.14, { string: unit("shepherd", "string"), flint: unit("miner", "flint") });
    ok("PRODUCE: no arrows for the fletcher, no iron swords for the weaponsmith", !T.PRODUCE.fletcher.includes("arrow") && !T.PRODUCE.weaponsmith.includes("iron_sword"), { fletcher: T.PRODUCE.fletcher, weaponsmith: T.PRODUCE.weaponsmith });
    const restocked = prof => { const v = { profession: prof, inv: inv.create(), restockDay: 0 }; T.restock(v, 6); return v; };
    const rf = restocked("fletcher"), rw = restocked("weaponsmith"), rs = restocked("shepherd"), rm = restocked("miner");
    ok("restock of an empty pack makes no arrows or bows", c(rf, "arrow") === 0 && c(rf, "bow") === 0, names(rf.inv));
    ok("restock of an empty pack makes no iron swords", c(rw, "iron_sword") === 0, names(rw.inv));
    ok("restock makes no string (shepherd) and no flint (miner)", c(rs, "string") === 0 && c(rm, "flint") === 0, { shepherd: names(rs.inv), miner: names(rm.inv) });
    // ---- starting packs
    let fBad = 0, fSeed = true, sBad = 0, mBad = 0;
    for (let k = 0; k < 30; k++) {
      const f = { inv: T.stockFor("fletcher", {}) }, s = { inv: T.stockFor("shepherd", {}) }, m = { inv: T.stockFor("miner", {}) };
      if (c(f, "arrow") || c(f, "bow")) fBad++;
      if (c(f, "stick") < 1 || c(f, "flint") < 1) fSeed = false;
      if (c(s, "string")) sBad++;
      if (c(m, "flint")) mBad++;
    }
    R.info.fletcherStart = names(T.stockFor("fletcher", {}));
    ok("a generated fletcher starts with no arrows or bows", fBad === 0, fBad);
    ok("... but with a few sticks and flint", fSeed, R.info.fletcherStart);
    ok("a generated shepherd starts with no string, a miner with no flint", sBad === 0 && mBad === 0, { sBad, mBad });

    // ---- crafting only from stock (no village: nothing to buy)
    const mk = (prof, items) => { const m = { type: "villager", profession: prof, inv: inv.create(), trades: T.offers(prof, 1), position: new THREE.Vector3(0, 0, 0), level: 1, xp: 0, ai: {} }; for (const [n, k] of items) inv.add(m.inv, I[n], k); return m; };
    const workFor = (m, sec, h = 0.5) => { for (let t = 0; t < sec; t += h) FL.work(m, { t: 10 }, h); };
    const empty = mk("fletcher", [["emerald", 20]]);
    workFor(empty, 3000);
    ok("a fletcher with no materials and no sellers makes nothing", c(empty, "arrow") === 0 && c(empty, "bow") === 0 && FL.plan(empty) === null, names(empty.inv));
    const f1 = mk("fletcher", [["flint", 1], ["feather", 1], ["stick", 4], ["string", 3]]);
    const p1 = FL.plan(f1); R.info.firstPlan = p1;
    workFor(f1, 3000);
    ok("1 flint + 1 stick + 1 feather -> 4 arrows; 3 sticks + 3 string -> 1 bow, nothing left", c(f1, "arrow") === 4 && c(f1, "bow") === 1 && c(f1, "flint") === 0 && c(f1, "feather") === 0 && c(f1, "stick") === 0 && c(f1, "string") === 0, names(f1.inv));
    const f2 = mk("fletcher", [["flint", 3], ["feather", 1], ["planks", 2]]);
    workFor(f2, 3000);
    ok("planks are cut into sticks (2 -> 4); a missing feather stops the arrows", c(f2, "arrow") === 4 && c(f2, "stick") === 3 && c(f2, "planks") === 0 && c(f2, "flint") === 2 && c(f2, "feather") === 0, names(f2.inv));
    const f3 = mk("fletcher", [["string", 6], ["stick", 2]]);
    workFor(f3, 3000);
    ok("too few sticks for a bow: no bow, nothing used", c(f3, "bow") === 0 && c(f3, "string") === 6 && c(f3, "stick") === 2, names(f3.inv));
    const f4 = mk("fletcher", [["string", 9], ["stick", 9]]);
    workFor(f4, 3000);
    ok("bows stop at BOW_MAX", c(f4, "bow") === FL.BOW_MAX && c(f4, "string") === 9 - 3 * FL.BOW_MAX, names(f4.inv));
    // game time: 4 arrows take half a game hour (25 s at 1200 s a day), a bow a whole hour
    const f5 = mk("fletcher", [["flint", 1], ["feather", 1], ["stick", 1]]);
    FL.work(f5, { t: 10 }, 0.01); const secs = f5.flt.craft && Math.round(f5.flt.craft.t);
    workFor(f5, 20, 1); const at20 = c(f5, "arrow"); workFor(f5, 6, 1);
    ok("4 arrows take half a game hour of simulated time", secs === Math.round(BF.sky.dayLength / 48) && at20 === 0 && c(f5, "arrow") === 4, { secs, at20, after: c(f5, "arrow") });
    // a craft in progress survives save / load
    const f6 = mk("fletcher", [["string", 3], ["stick", 3]]); FL.work(f6, { t: 10 }, 1);
    const packed = T.pack(f6), f7 = mk("fletcher", []); f7.profession = "fletcher"; T.unpack(f7, JSON.parse(JSON.stringify(packed)));
    ok("the bow on the table is saved and loaded", !!(f7.flt && f7.flt.craft && f7.flt.craft.id === I.bow && f7.flt.craft.mats.length === 2), packed.fl);

    // ---- the shepherd spins wool into string at its loom, and sells it
    const shep = mk("shepherd", [["white_wool", 20]]); shep.jobsite = { x: 0, y: 0, z: 1 };
    const spinFor = (m, sec, h = 0.5) => { for (let t = 0; t < sec; t += h) SH.work(m, { t: 10 }, h); };
    spinFor(shep, 600);
    ok("shepherd spun 1 wool -> 2 string, keeping WOOL_KEEP wool", c(shep, "string") === 2 * (20 - SH.WOOL_KEEP) && c(shep, "white_wool") === SH.WOOL_KEEP, names(shep.inv));
    const shep2 = mk("shepherd", [["white_wool", 60]]); shep2.jobsite = { x: 0, y: 0, z: 1 };
    spinFor(shep2, 3000);
    ok("shepherd stops spinning at STRING_CAP string", c(shep2, "string") === SH.STRING_CAP && c(shep2, "white_wool") === 60 - SH.STRING_CAP / 2, names(shep2.inv));
    const shep3 = mk("shepherd", [["white_wool", 30]]); shep3.jobsite = { x: 9, y: 0, z: 9 };
    spinFor(shep3, 600);
    ok("no spinning away from the loom", c(shep3, "string") === 0, names(shep3.inv));
    const so = shep2.trades.find(o => o.sell.id === I.string), s0 = c(shep2, "string");
    ok("shepherd sells the string it holds (player trade)", !!so && T.exchange(shep2, so) && c(shep2, "string") === s0 - so.sell.n, so && fmt(so));
    const shep4 = mk("shepherd", [["white_wool", 10]]);
    ok("a shepherd with no string is out of stock", T.blockReason(shep4, shep4.trades.find(o => o.sell.id === I.string)) === "Out of stock");

    // ---- buying from the villagers who hold the materials (stand-in village, no walking)
    const fb = mk("fletcher", [["emerald", 12]]);
    const sp = mk("shepherd", [["string", 16]]), mi = mk("miner", [["flint", 20]]), fo = mk("forester", [["stick", 60]]), pk = mk("poultry_keeper", [["feather", 20]]);
    const vil = { members: [fb, sp, mi, fo, pk] }; for (const v of vil.members) { v.village = vil; v.slot = { idx: vil.members.indexOf(v) + 1 }; }
    const bought = {};
    for (let k = 0; k < 12; k++) { const nd = FL.buyNeed(fb); if (!nd) break; const d = FL.findDeal(fb, nd); if (!d) break; bought[nd.what] = (bought[nd.what] || 0) + FL.doBuy(fb, d) * d.offer.sell.n; }
    R.info.bought = bought; R.info.buyerInv = names(fb.inv);
    ok("fletcher bought string from the shepherd", c(fb, "string") >= 6 && c(sp, "string") === 16 - c(fb, "string"), { fl: c(fb, "string"), shep: c(sp, "string") });
    ok("fletcher bought flint from the miner", c(fb, "flint") >= 4 && c(mi, "flint") === 20 - c(fb, "flint"), { fl: c(fb, "flint"), miner: c(mi, "flint") });
    ok("fletcher bought feathers from the poultry keeper", c(fb, "feather") >= 4 && c(pk, "feather") === 20 - c(fb, "feather"), { fl: c(fb, "feather"), pk: c(pk, "feather") });
    ok("fletcher bought sticks from the forester", c(fb, "stick") >= 10 && c(fo, "stick") === 60 - c(fb, "stick"), { fl: c(fb, "stick"), fo: c(fo, "stick") });
    ok("it paid emeralds at the sellers' offers", c(fb, "emerald") < 12 && c(sp, "emerald") + c(mi, "emerald") + c(fo, "emerald") + c(pk, "emerald") === 12 - c(fb, "emerald"), { left: c(fb, "emerald") });
    ok("with everything in hand it has nothing more to buy, and goes crafting", FL.buyNeed(fb) === null && (FL.plan(fb) || {}).ready === true, FL.plan(fb));
    const fn = mk("fletcher", [["emerald", 12]]), lw = mk("leatherworker", [["string", 20]]); lw.trades = [Object.assign(T.parseTrade("1 emerald > 9 string"), { level: 1, xp: 2 })];
    const v2 = { members: [fn, lw] }; fn.village = lw.village = v2; const svProd = T.PRODUCE.leatherworker; T.PRODUCE.leatherworker = ["leather", "string"];
    ok("no buying wares the seller gets from the daily restock", FL.buyNeed(fn) === null);
    T.PRODUCE.leatherworker = svProd;
    ok("... but from the same seller when it is not restocked", !!FL.buyNeed(fn));

    // ---- a live village (seed 1, the shepherd-day village)
    const V = { x: 26, z: 39 };
    BF.player.teleport(V.x + 4.5, BF.worldgen.heightAt(V.x + 4, V.z + 4) + 2, V.z + 4.5);
    for (let i = 0; i < 400 && !BF.world.isLoaded(V.x, V.z); i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    run(8);
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(V.x + "," + V.z) || { members: [] }).members.some(m => m.profession === "shepherd")); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(V.x + "," + V.z);
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child && Array.isArray(m.inv));
    R.info.village = vs.map(v => v.profession);
    // ---- the miner keeps flint from gravel (dug with its own dig(), in loaded ground)
    const Mi = vs.find(v => v.profession === "miner") || mk("miner", [["stone_pickaxe", 1]]);
    if (!Mi.inv.some(s => s && BF.items[s.id].tool && BF.items[s.id].tool.type === "pickaxe")) inv.add(Mi.inv, I.stone_pickaxe, 1);
    const sf = c(Mi, "flint"), sg = c(Mi, "gravel"), gx = Math.floor(rec.x) + 3, gz = Math.floor(rec.z) + 3, gy = BF.world.heightAt(gx, gz) + 6;
    const saveInv = T.inv.clone(Mi.inv); let dug = 0;
    for (let k = 0; k < 400; k++) { BF.world.setBlock(gx, gy, gz, BF.B.gravel); if (BF.miner._test.dig(Mi, gx, gy, gz)) dug++; if (Mi.inv.filter(Boolean).length > 16) inv.remove(Mi.inv, I.cobblestone, 999); }
    const flint = c(Mi, "flint") - sf; R.info.flintRate = flint + " flint from " + dug + " gravel";
    ok("miner keeps flint from gravel (~10%), not the gravel", dug === 400 && flint >= 15 && flint <= 75 && c(Mi, "gravel") === sg, R.info.flintRate);
    Mi.inv = saveInv;
    // while the village's fletcher is short of flint, gravel in the shaft walls is dug with the cell
    const mi2 = mk("miner", [["stone_pickaxe", 1]]), flA = mk("fletcher", [["emerald", 5]]);
    mi2.village = flA.village = { members: [mi2, flA] };
    const cell = { x: gx, y: gy, z: gz, h: 3, kind: "stairs", i: 1 }, sh = { x: gx - 1, y: gy + 1, z: gz, dx: 1, dz: 0, S: null };
    BF.world.setBlock(gx, gy, gz + 1, BF.B.gravel);
    const short = BF.miner.wantsFlint(mi2), wall = BF.miner._test.wallOres(mi2, sh, cell).length;
    inv.add(flA.inv, I.flint, 16);
    const fed = BF.miner.wantsFlint(mi2), wall2 = BF.miner._test.wallOres(mi2, sh, cell).length;
    BF.world.setBlock(gx, gy, gz + 1, 0);
    ok("miner digs wall gravel only while the fletcher is short of flint", short && wall === 1 && !fed && wall2 === 0, { short, wall, fed, wall2 });
    // how much gravel its shafts meet: gravel among the blocks 6-20 below the surface around the village
    let gravel = 0, all = 0;
    for (let x = Math.floor(rec.x) - 40; x <= Math.floor(rec.x) + 40; x += 2) for (let z = Math.floor(rec.z) - 40; z <= Math.floor(rec.z) + 40; z += 2) {
      if (!BF.world.isLoaded(x, z)) continue;
      const h = BF.world.heightAt(x, z);
      for (let y = h - 20; y <= h - 6; y++) { const id = BF.world.getBlock(x, y, z); if (!id) continue; all++; if (id === BF.B.gravel) gravel++; }
    }
    R.info.gravelUnderground = (100 * gravel / Math.max(1, all)).toFixed(2) + "% of " + all + " blocks 6-20 down";

    // set up: a fletcher at a new fletching table with emeralds only; the real shepherd with wool and no string; stand-in sellers
    const shp = vs.find(v => v.profession === "shepherd");
    const others = vs.filter(v => v !== shp && v.profession !== "builder" && v.profession !== "miner" && v.profession !== "fletcher" && v.profession !== "poultry_keeper");   // not the keeper: it may stand inside its fenced coop, where a new table would be out of reach
    if (!shp || others.length < 4) { ok("village has a shepherd and 4 other villagers", false, R.info.village); return R; }
    const Fl = vs.find(v => v.profession === "fletcher") || others.pop(), [Mn, Fo, Pk] = others;   // the village's own fletcher when it has one (the only one)
    if (Fl.profession !== "fletcher" || !Fl.jobsite) {   // no fletcher here: one takes up a new fletching table
      // the nearest spot it can walk up to (not on a fence, a roof or inside a pen)
      const W = BF.world, N = BF.mobs.nav, [fx, fy, fz] = N.feetCell(Fl);
      let tx = Math.floor(Fl.position.x) + 2, tz = Math.floor(Fl.position.z), ty = W.heightAt(tx, tz) + 1;
      const spots = [];
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) if (Math.abs(dx) + Math.abs(dz) >= 2) spots.push([fx + dx, fz + dz]);
      spots.sort((a, b) => Math.hypot(a[0] - fx, a[1] - fz) - Math.hypot(b[0] - fx, b[1] - fz));
      for (const [x, z] of spots) {
        const y = W.heightAt(x, z) + 1, below = BF.blocks[W.getBlock(x, y - 1, z)];
        if (!below || !BF.SOLID[W.getBlock(x, y - 1, z)] || /fence|wall|slab|stairs|leaves/.test(below.name) || W.getBlock(x, y, z) || W.getBlock(x, y + 1, z)) continue;
        const path = N.findPath(fx, fy, fz, { x, z, at: (a, b, c) => Math.abs(a - x) + Math.abs(c - z) === 1 && Math.abs(b - y) <= 1 }, 2500);
        if (path && path.length) { tx = x; ty = y; tz = z; break; }
      }
      W.setBlock(tx, ty, tz, BF.B.fletching_table); BF.emit("blockPlaced", tx, ty, tz, BF.B.fletching_table);
      BF.mobs.setProfession(Fl, "fletcher");
      R.info.claim = BF.jobs.claim(Fl, { site: { x: tx, y: ty, z: tz, id: BF.B.fletching_table, prof: "fletcher" } });
    }
    Fl.xp = 0; Fl.level = 1; Fl.inv = inv.create(); Fl.trades = T.offers("fletcher", 1); Fl.flt = null;
    inv.add(Fl.inv, I.emerald, 12); inv.add(Fl.inv, I.bread, 12);
    const off = s => Object.assign(T.parseTrade(s), { level: 1, xp: 2 });
    Mn.inv = inv.create(); inv.add(Mn.inv, I.flint, 24); inv.add(Mn.inv, I.bread, 12); Mn.trades = ["1 emerald > 8 flint"].map(off);                  // the miner's flint offer
    Fo.inv = inv.create(); inv.add(Fo.inv, I.stick, 48); inv.add(Fo.inv, I.bread, 12); Fo.trades = ["1 emerald > 48 stick"].map(off);                // the forester's sticks
    Pk.inv = inv.create(); inv.add(Pk.inv, I.feather, 26); inv.add(Pk.inv, I.bread, 12); Pk.trades = ["1 emerald > 13 feather"].map(off);             // stand-in poultry keeper
    inv.remove(shp.inv, I.string, 999); inv.remove(shp.inv, I.white_wool, 999); inv.add(shp.inv, I.white_wool, 28);
    const logs0 = BF.vlog.entries(rec.key).length;
    FL.LOG.length = 0;
    BF.sky.setTime(0.06);
    const got = { string: false, flint: false, feather: false, stick: false }, seenStatus = new Set();
    let spunAt = null, arrowsAt = null, bowAt = null;
    for (let i = 0; i < 40000 && !(arrowsAt && bowAt); i++) {
      step();
      if (i % 20 === 0) {
        if (BF.sky.time > 0.43) BF.sky.setTime(0.06);   // one long working day
        for (const n of Object.keys(got)) if (c(Fl, n) > 0) got[n] = true;
        // the village's furniture maker buys wool too: when it got there first the shepherd was left at WOOL_KEEP with too little
        // string for its "1 emerald > 9 string" offer, and the fletcher never got any. Keep the shepherd's spare wool topped up.
        if (c(shp, "white_wool") < 28) inv.add(shp.inv, I.white_wool, 28 - c(shp, "white_wool"));
        const st = BF.villagerStatus.text(Fl); if (st) seenStatus.add(st);
        if (spunAt == null && c(shp, "string") > 0) spunAt = +BF.sky.time.toFixed(3);
        if (arrowsAt == null && c(Fl, "arrow") > 0) arrowsAt = +BF.sky.time.toFixed(3);
        if (bowAt == null && c(Fl, "bow") > 0) bowAt = +BF.sky.time.toFixed(3);
      }
    }
    const logs = BF.vlog.entries(rec.key).slice(logs0).map(e => e[2]);
    R.info.live = { spunAt, arrowsAt, bowAt, fl: names(Fl.inv), shep: names(shp.inv), status: [...seenStatus], dbg: { need: FL.buyNeed(Fl), short: FL.shortfall(Fl), offers: FL.offersFor(Fl, id => id === I.string).length, shep: [shp.sleeping, !!shp.tradingWith, +(shp.position.y - Fl.position.y).toFixed(1)], job: Fl.job, t: BF.sky.time }, flog: FL.LOG.map(e => e.kind + ":" + (e.got || e.made || e.item || e.why || "") + (e.from ? " from " + e.from : "")).slice(-14) };
    ok("live: the shepherd spun string at its loom", spunAt != null, { wool: c(shp, "white_wool"), string: c(shp, "string") });
    ok("live: 'spun N string' is on the village log", logs.some(t => /\(Shepherd\) spun \d+ string$/.test(t)), logs.filter(t => /Shepherd/.test(t)).slice(-3));
    ok("live: the fletcher bought string, flint, feathers and sticks", Object.values(got).every(Boolean), got);
    ok("live: the fletcher bought string from the shepherd", logs.some(t => /\(Fletcher\) traded with .*\(Shepherd\)/.test(t)), logs.filter(t => /Fletcher/.test(t)).slice(-6));
    ok("live: the fletcher made arrows and a bow", arrowsAt != null && bowAt != null, { arrowsAt, bowAt });
    ok("live: 'made 4 arrows' and 'made a bow' are on the village log", logs.some(t => /\(Fletcher\) made 4 arrows$/.test(t)) && logs.some(t => /\(Fletcher\) made a bow$/.test(t)), logs.filter(t => /made/.test(t)));
    ok("live: its status says what it does", [...seenStatus].some(s => /^Buying /.test(s)) && [...seenStatus].some(s => /^Making /.test(s)), [...seenStatus]);
    return R;
  });
  for (const l of res.lines) console.log(l);
  console.log(JSON.stringify(res.info, null, 1));
};
