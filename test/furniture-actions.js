// Furniture maker checks: node test/run.js /tmp/furn test/furniture-actions.js
// Unit part: roster odds (needs the forester profession, PR #27), the newly-generated-village gate, starting stock, crafting, buying wool and
// boards, selling beds to a builder. Live part: in a real village a furniture maker at its bench buys, crafts and sells to a builder.
module.exports = async (pg, out) => {
  const r = await pg.evaluate(() => {
    const res = {}, I = BF.I, T = BF.trades, F = BF.furniture, inv = T.inv;
    const names = a => a.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count);
    // ---- roster: 80% of villages with both a shepherd and a forester; never otherwise
    let both = 0, withF = 0, bad = 0;
    for (let k = 0; k < 800; k++) {
      const houses = []; for (let i = 0; i < 6 + (k % 14); i++) houses.push({ type: "house", x: i * 9, z: 0, w: 5, d: 5, beds: [{}] });
      const ro = BF.mobs.roster({ key: k * 13 + "," + k * 7, houses, nb: 4 + (k % 20) });
      const sh = ro.some(s => s.prof === "shepherd"), fo = ro.some(s => s.prof === "forester"), fm = ro.filter(s => s.prof === "furniture_maker");
      if (sh && fo) both++;
      if (fm.length) withF++;
      if (fm.length && !(sh && fo)) bad++;
      if (fm.length > 1 || (fm[0] && fm[0].idx !== 1300)) bad += 1000;
    }
    res.roster = { both, withF, ratio: +(withF / Math.max(1, both)).toFixed(3), bad, foresterExists: BF.mobs.professions.includes("forester") };
    // ---- gate: a village the save already knows (villagers saved, no furniture maker) gets none; one whose furniture maker is saved keeps it
    {
      let key = null, houses = null, nb = 0;
      for (let k = 0; k < 800 && !key; k++) {
        const hs = []; for (let i = 0; i < 6 + (k % 14); i++) hs.push({ type: "house", x: i * 9, z: 0, w: 5, d: 5, beds: [{}] });
        const kk = k * 13 + "," + k * 7;
        if (BF.mobs.roster({ key: kk, houses: hs, nb: 4 + (k % 20) }).some(s => s.prof === "furniture_maker")) { key = kk; houses = hs; nb = 4 + (k % 20); }
      }
      const has = () => BF.mobs.roster({ key, houses, nb }).some(s => s.prof === "furniture_maker");
      if (key) {
        BF.mobs.importVillagers({ [key + "#0"]: { inv: [], level: 1, xp: 0 } });
        const old = has();
        BF.mobs.importVillagers({ [key + "#0"]: { inv: [], level: 1, xp: 0 }, [key + "#1300"]: { inv: [], level: 1, xp: 0, prof: "furniture_maker" } });
        const kept = has();
        BF.mobs.importVillagers({});
        res.gate = { key, fresh: true, oldVillage: old, savedFurnitureMaker: kept };
      } else res.gate = "no village with a furniture maker (forester missing?)";
    }
    // ---- trade table and starting stock
    res.offers = [1, 2, 3, 4, 5].flatMap(l => T.offers("furniture_maker", l)).map(o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name);
    res.stock = names(T.stockFor("furniture_maker", {}));
    // ---- crafting: logs are sawn into planks, 3 wool + 3 planks per bed, stops at BED_STOCK
    const m = { inv: inv.create(), profession: "furniture_maker", ai: {} };
    inv.add(m.inv, I.white_wool, 9); inv.add(m.inv, I.red_wool, 4); inv.add(m.inv, I.spruce_planks, 2); inv.add(m.inv, I.oak_log, 3);
    const seq = [];
    for (let k = 0; k < 12; k++) { const p = F.plan(m); if (!p) break; F.craft(m, p); seq.push(p.kind); }
    res.craftSeq = seq.join(",");
    res.afterCraft = names(m.inv);
    // ---- buying: a shepherd sells wool, a stand-in forester sells boards
    const mk = (prof, trades) => ({ type: "villager", profession: prof, inv: T.stockFor(prof, {}), trades: trades || [1, 2, 3, 4, 5].flatMap(l => T.offers(prof, l)), position: new THREE.Vector3(0, 0, 0), level: 5, xp: 0 });
    const shep = mk("shepherd");
    const wood = mk("mason", [T.parseTrade("1 emerald > 16 planks"), T.parseTrade("1 emerald > 4 birch_log")].map(o => Object.assign(o, { level: 1, xp: 2 })));
    inv.add(wood.inv, I.planks, 32); inv.add(wood.inv, I.birch_log, 8);
    const builder = { type: "villager", profession: "builder", inv: inv.create(), trades: [], position: new THREE.Vector3(1, 0, 0), level: 1, xp: 0 };
    inv.add(builder.inv, I.emerald, 10);
    const fm = { type: "villager", profession: "furniture_maker", inv: inv.create(), trades: T.offers("furniture_maker", 1), position: new THREE.Vector3(0, 0, 0), level: 1, xp: 0, ai: {} };
    fm.village = { members: [fm, shep, wood, builder] };
    inv.add(fm.inv, I.emerald, 6);
    const steps = [];
    for (let k = 0; k < 8; k++) {
      const short = F.shortfall(fm);
      if (!Object.keys(short).length) break;
      const d = F.findSeller(fm, short, {});
      if (!d) { steps.push("no seller for " + JSON.stringify(short)); break; }
      steps.push(d.other.profession + ": " + d.offer.sell.n + " " + BF.items[d.item].name + " x" + F.doBuy(fm, d));
    }
    for (let k = 0; k < 6; k++) { const p = F.plan(fm); if (!p) break; F.craft(fm, p); }
    res.bought = steps;
    res.fmAfterBuying = names(fm.inv);
    // ---- selling to the builder: it wants 2 beds in hand
    res.builderWants = F.builderWants(builder);
    const deal = F.findBuyer(fm, {});
    res.sold = deal ? F.doSell(fm, deal) : "no buyer";
    res.builderHas = names(builder.inv);
    res.builderWantsAfter = F.builderWants(builder);
    res.fmXp = fm.xp;
    return res;
  });
  console.log(JSON.stringify(r, null, 1));

  // ---- live: a furniture maker at its bench in a real village, a shepherd, a wood seller and a builder
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const setup = await pg.evaluate(() => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child && m.profession !== "builder");
    const bld = BF.mobs.list.find(m => m.type === "villager" && m.profession === "builder" && !m.dead);
    if (vs.length < 3) return "villagers: " + vs.length;
    const T = BF.trades, I = BF.I, inv = T.inv;
    const A = vs[0], S = vs[1], W = vs[2];
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    BF.world.setBlock(tx, ty, tz, BF.B.carpentry_bench); BF.emit('blockPlaced', tx, ty, tz, BF.B.carpentry_bench);
    BF.mobs.setProfession(A, "furniture_maker"); A.xp = 0; A.level = 1; A.inv = inv.create(); A.trades = T.offers("furniture_maker", 1);
    A.res = BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: BF.B.carpentry_bench, prof: "furniture_maker" } });
    inv.add(A.inv, I.emerald, 8);
    BF.mobs.setProfession(S, "shepherd"); S.inv = inv.create(); inv.add(S.inv, I.white_wool, 40); S.trades = [1, 2, 3, 4, 5].flatMap(l => T.offers("shepherd", l)); S.level = 5;
    W.inv = inv.create(); inv.add(W.inv, I.planks, 60); W.trades = [Object.assign(T.parseTrade("1 emerald > 30 planks"), { level: 1, xp: 2 })];   // the forester's offer (PR #27)
    if (bld) { bld.inv = inv.create(); inv.add(bld.inv, I.emerald, 20); }
    for (const v of [A, S, W]) inv.add(v.inv, I.bread, 12);   // fed, so food shopping (js/villagelife.js) does not take over
    BF.sky.setTime ? BF.sky.setTime(0.08) : (BF.sky.time = 0.08);
    BF.player.position.set(A.position.x + 5, A.position.y + 1, A.position.z);
    window.__A = A; window.__B = bld;
    BF.furniture.LOG.length = 0;
    if (BF.warp) BF.warp.set(4);   // 100x: the headless renderer is slow
    return { claim: A.res, builder: !!bld, A: A.profession, jobsite: A.jobsite };
  });
  console.log("live setup", JSON.stringify(setup));
  const t0 = Date.now(), seen = new Set();
  while (Date.now() - t0 < 150000) {
    await pg.waitForTimeout(5000);
    const s = await pg.evaluate(() => {
      const A = window.__A, B = window.__B, I = BF.I, c = (m, id) => (m ? BF.trades.inv.count(m.inv, id) : -1);
      if (BF.sky.time > 0.4) BF.sky.setTime ? BF.sky.setTime(0.08) : (BF.sky.time = 0.08);
      return { st: BF.furniture.statusText(A), beds: c(A, I.red_bed), wool: c(A, I.white_wool), planks: c(A, I.planks), em: c(A, I.emerald), bBeds: c(B, I.red_bed),
        log: BF.furniture.LOG.slice(-4).map(e => e.kind + ":" + (e.made || e.got || e.from || "") + (e.beds ? " beds " + e.beds : "")) };
    });
    console.log(JSON.stringify(s));
    for (const e of s.log) seen.add(e.split(":")[0]);
    if (seen.has("buy") && seen.has("craft") && seen.has("sell")) break;
  }
  console.log("live kinds seen:", [...seen].join(","));
  await pg.evaluate(() => BF.warp && BF.warp.reset());
  await pg.evaluate(() => { const A = window.__A; BF.player.position.set(A.position.x + 3, A.position.y + 1.5, A.position.z + 3); });
  await pg.waitForTimeout(800);
};
