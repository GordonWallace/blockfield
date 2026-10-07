// Toolsmith and furnace checks: node test/run.js /tmp/ts test/toolsmith-actions.js
// Unit part: trade tables, starting stock, what the toolsmith makes next (even stock, best material, shears first), the furniture maker's
// furnaces. Live part, in a real village: fuel rules at a furnace (fuel already in it is burnt first, all fuel is taken out at the end), then
// a toolsmith with no furnace in reach buys one from a furniture maker, puts it down, buys ore and coal, smelts and makes tools.
module.exports = async (pg, out) => {
  const r = await pg.evaluate(() => {
    const res = {}, I = BF.I, T = BF.trades, TS = BF.toolsmith, F = BF.furniture, inv = T.inv;
    const names = a => a.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count);
    const fmt = o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name;
    res.offers = [1, 2, 3, 4, 5].map(l => T.offers("toolsmith", l).map(fmt));
    res.furnOffers = T.offers("furniture_maker", 1).map(fmt);
    res.produce = T.PRODUCE.toolsmith;
    res.stock = names(T.stockFor("toolsmith", {}));
    res.stockTools = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(() => T.stockFor("toolsmith", {}).filter(s => s && BF.items[s.id].tool && !BF.items[s.id].isBlock).map(s => BF.items[s.id].name));
    // ---- plans with materials in hand (no village: nothing to buy)
    const mk = items => { const m = { type: "villager", profession: "toolsmith", inv: inv.create(), trades: T.offers("toolsmith", 1), position: new THREE.Vector3(0, 0, 0), level: 1, xp: 0, ai: {} }; for (const [n, c] of items) inv.add(m.inv, I[n], c); return m; };
    const p = m => { const q = TS.plan(m); return q ? (q.ready ? q.mat + " " + q.cat : JSON.stringify(q)) : "nothing"; };
    res.planIron = p(mk([["iron_ingot", 3], ["stick", 4], ["cobblestone", 9], ["planks", 6]]));      // shears first (iron for them), not the pickaxe
    res.planIron5 = p(mk([["iron_ingot", 5], ["stick", 4], ["cobblestone", 9], ["planks", 6], ["shears", 1]]));   // has shears: iron pickaxe
    res.planEven = p(mk([["iron_ingot", 9], ["stick", 8], ["iron_pickaxe", 1], ["shears", 1]]));      // has a pickaxe: an axe next
    res.planStone = p(mk([["cobblestone", 9], ["planks", 2], ["shears", 1]]));                         // sticks from planks; stone beats wood
    res.planWood = p(mk([["planks", 5], ["shears", 1]]));                                               // 3 planks head + 2 planks -> sticks
    res.planDiamond = p(mk([["diamond", 3], ["iron_ingot", 3], ["stick", 2], ["shears", 1]]));
    // ---- crafting takes 2 game hours, the materials go when it starts
    const c = mk([["cobblestone", 3], ["stick", 2], ["shears", 1]]);
    const s0 = TS.startCraft(c, TS.plan(c));
    res.craftSecs = s0 && Math.round(s0.t);
    res.craftMatsLeft = names(c.inv);
    TS.work(c, { t: 10 }, 50); res.after50 = names(c.inv).join(",");
    TS.work(c, { t: 10 }, 51); res.after101 = names(c.inv).join(",");
    // pack / unpack keeps a craft in progress
    const c2 = mk([["iron_ingot", 3], ["stick", 2], ["shears", 1]]); TS.startCraft(c2, TS.plan(c2)); c2.tsm.craft.t = 30;
    const pk = TS.pack(c2), c3 = mk([]); TS.unpack(c3, pk); res.packed = { pk, back: c3.tsm.craft && BF.items[c3.tsm.craft.id].name + " " + c3.tsm.craft.t };
    // ---- furniture maker: keeps one furnace, buys cobblestone for it
    const fm = { type: "villager", profession: "furniture_maker", inv: inv.create(), trades: T.offers("furniture_maker", 1), position: new THREE.Vector3(0, 0, 0), level: 1, xp: 0, ai: {} };
    inv.add(fm.inv, I.emerald, 5);
    res.fmShort = F.shortfall(fm);
    const miner = { type: "villager", profession: "mason", inv: inv.create(), trades: [Object.assign(T.parseTrade("1 emerald > 32 cobblestone"), { level: 1, xp: 2 })], position: new THREE.Vector3(1, 0, 0), level: 1, xp: 0 };
    inv.add(miner.inv, I.cobblestone, 64);
    fm.village = { members: [fm, miner] };
    const d = F.findSeller(fm, F.shortfall(fm), {});
    res.fmBought = d ? F.doBuy(fm, d) + "x " + BF.items[d.item].name : "no seller";
    const pl = F.plan(fm); res.fmPlan = pl && pl.kind;
    if (pl) F.craft(fm, pl);
    res.fmAfter = names(fm.inv);
    res.fmShortAfter = F.shortfall(fm);
    const seeded = inv.create(); F.seed(seeded); res.fmSeed = names(seeded);
    return res;
  });
  console.log(JSON.stringify(r, null, 1));

  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  // ---- fuel rules at one furnace beside the player
  const fuel = await pg.evaluate(() => {
    const I = BF.I, T = BF.trades, TS = BF.toolsmith, inv = T.inv, W = BF.world;
    const p = BF.player.position, x = Math.floor(p.x) + 2, z = Math.floor(p.z) + 2;
    let y = Math.floor(p.y) + 4; while (y > p.y - 12 && !BF.SOLID[W.getBlock(x, y - 1, z)]) y--;
    W.setBlock(x, y, z, BF.B.furnace); BF.emit("blockPlaced", x, y, z, BF.B.furnace);
    const st = BF.inventory.furnaceRecord(x, y, z);
    st.slots[1] = { id: I.coal, count: 1 };            // somebody else's coal: burnt first, then taken out
    const m = { type: "villager", profession: "toolsmith", inv: inv.create(), position: new THREE.Vector3(x + 1, y, z), ai: {} };
    inv.add(m.inv, I.raw_iron != null ? I.raw_iron : I.iron_ore, 3); inv.add(m.inv, I.coal, 4);
    const job = { rawId: I.raw_iron != null ? I.raw_iron : I.iron_ore, furnace: { x, y, z } };
    const loaded = TS.loadFurnace(m, job);
    const ownCoalAtLoad = T.inv.count(m.inv, I.coal);
    for (let k = 0; k < 400 && st.slots[0]; k++) BF.inventory.simTick(0.1);
    const afterSmelt = { input: st.slots[0], fuel: st.slots[1], burn: +st.burn.toFixed(1), out: st.slots[2] };
    TS.emptyFurnace(m, job, false);
    return { loaded, ownCoalAtLoad, afterSmelt, inv: m.inv.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count), left: st.slots, xyz: [x, y, z] };
  });
  console.log("fuel", JSON.stringify(fuel));

  // ---- live: a toolsmith with no furnace buys one, places it, buys ore and coal, smelts, makes tools
  const setup = await pg.evaluate((fx) => {
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.inv && !m.child && m.profession !== "builder");
    if (vs.length < 4) return "villagers: " + vs.length;
    const T = BF.trades, I = BF.I, inv = T.inv, W = BF.world, R = vs[0].village;
    BF.world.setBlock(fx[0], fx[1], fx[2], 0); BF.emit("blockBroken", fx[0], fx[1], fx[2], BF.B.furnace);
    let removed = 0;   // no furnace in reach: it has to buy one
    for (const f of [...BF.toolsmith.furnaces.values()]) if (Math.hypot(f.x - R.x, f.z - R.z) < 200) { W.setBlock(f.x, f.y, f.z, 0); BF.emit("blockBroken", f.x, f.y, f.z, BF.B.furnace); removed++; }
    const A = vs[0], M = vs[1], Wd = vs[2], Fm = vs[3];
    for (const v of vs) if (v !== A && v.profession === "toolsmith") BF.mobs.setProfession(v, "mason");
    const tx = Math.floor(A.position.x) + 2, ty = Math.floor(A.position.y), tz = Math.floor(A.position.z);
    W.setBlock(tx, ty, tz, BF.B.smithing_table); BF.emit("blockPlaced", tx, ty, tz, BF.B.smithing_table);
    BF.mobs.setProfession(A, "toolsmith"); A.xp = 0; A.level = 1; A.inv = inv.create(); A.trades = T.offers("toolsmith", 1); A.tsm = null;
    A.res = BF.jobs.claim(A, { site: { x: tx, y: ty, z: tz, id: BF.B.smithing_table, prof: "toolsmith" } });
    inv.add(A.inv, I.emerald, 30);
    const off = s => Object.assign(T.parseTrade(s), { level: 1, xp: 2 });
    const raw = I.raw_iron != null ? "raw_iron" : "iron_ore";
    M.inv = inv.create(); for (const [n, c] of [["cobblestone", 64], [raw, 24], ["coal", 32], ["diamond", 2]]) inv.add(M.inv, I[n], c);
    M.trades = ["1 emerald > 32 cobblestone", "1 emerald > 2 " + raw, "1 emerald > 8 coal", "4 emerald > 1 diamond"].map(off);   // the miner's offers
    Wd.inv = inv.create(); inv.add(Wd.inv, I.planks, 60); inv.add(Wd.inv, I.stick, 32); Wd.trades = ["1 emerald > 30 planks", "1 emerald > 16 stick"].map(off);   // a forester
    Fm.inv = inv.create(); inv.add(Fm.inv, BF.B.furnace, 1); Fm.trades = ["1 emerald > 1 furnace"].map(off);   // a furniture maker
    for (const v of [A, M, Wd, Fm]) inv.add(v.inv, I.bread, 12);
    BF.sky.setTime ? BF.sky.setTime(0.06) : (BF.sky.time = 0.06);
    BF.player.position.set(A.position.x + 5, A.position.y + 1, A.position.z);
    window.__A = A; window.__calls = { n: 0, t: 0 };
    window.__hooks = {};
    for (const [k, mod] of [["storage", BF.storage], ["life", BF.villageLife], ["breed", BF.breeding], ["jobs", BF.jobs]]) { const o = mod.ai; mod.ai = (m, dt, x) => { const r = o(m, dt, x); if (m === A && r) window.__hooks[k] = (window.__hooks[k] || 0) + 1; return r; }; }
    const orig = BF.toolsmith.ai; BF.toolsmith.ai = (m, dt, o) => { const r = orig(m, dt, o); if (m === A) { window.__calls.n++; if (r) window.__calls.t++; } return r; };
    BF.toolsmith.LOG.length = 0;
    if (BF.warp) BF.warp.set(4);
    return { removed, claim: A.res, jobsite: A.jobsite, M: M.profession, Wd: Wd.profession, Fm: Fm.profession };
  }, fuel.xyz);
  console.log("live setup", JSON.stringify(setup));
  const t0 = Date.now(), seen = new Set();
  let last = null;
  while (Date.now() - t0 < 600000) {
    await pg.waitForTimeout(5000);
    const s = await pg.evaluate(() => {
      const A = window.__A;
      if (BF.sky.time > 0.42) BF.sky.setTime ? BF.sky.setTime(0.06) : (BF.sky.time = 0.06);
      const tools = A.inv.filter(x => x && BF.items[x.id].tool && !BF.items[x.id].isBlock).map(x => BF.items[x.id].name);
      const S = A.tsm || {}, d = S.deal && S.deal.other;
      const dbg = { stage: S.stage, walkT: S.walkT && +S.walkT.toFixed(1), calls: window.__calls, t: +BF.sky.time.toFixed(3), job: A.job && A.job.mode, pos: [A.position.x | 0, A.position.y | 0, A.position.z | 0], other: d && d.position ? [d.position.x | 0, d.position.y | 0, d.position.z | 0] : null, trading: !!A.tradingWith, sleeping: !!A.sleeping, fshop: !!(A.fshop && A.fshop.stage), store: !!(A.store && A.store.stage), love: !!A.love, flee: +(A.ai.fleeT || 0).toFixed(1), leaving: !!A.ai.leaving, hooks: window.__hooks, removed: !!A.removed };
      window.__hooks = {};
      window.__calls = { n: 0, t: 0 };
      return { dbg, st: BF.toolsmith.statusText(A), tools, em: BF.trades.inv.count(A.inv, BF.I.emerald), furnace: A.tsm && A.tsm.furnace,
        log: BF.toolsmith.LOG.splice(0).map(e => e.kind + ":" + (e.made || e.got || e.tool || e.ore || e.furnace || e.why || "") + (e.from ? " from " + e.from : "")) };
    });
    console.log(JSON.stringify(s));
    for (const e of s.log) seen.add(e.split(":")[0]);
    last = s;
    if (s.tools.length >= 6) break;
  }
  console.log("live kinds seen:", [...seen].join(","), "tools:", last && last.tools.join(","));
  await pg.evaluate(() => BF.warp && BF.warp.reset());
  await pg.evaluate(() => { const A = window.__A; BF.player.position.set(A.position.x + 3, A.position.y + 1.5, A.position.z + 3); });
  await pg.waitForTimeout(800);
};
