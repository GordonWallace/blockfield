// @ci integration suite=jobs
// Glassmakers (js/glassmaker.js): NODE_PATH=$(npm root -g) node test/run.js /tmp/glass test/glassmaker-actions.js
// The glass kiln recipe and jobsite; librarians and cartographers neither restock glass nor list it; village generator 7: pane windows, a sand
// village with a glassmaker, its kiln and a furnace; the glassmaker digs only the top layer of open natural sand (not placed sand, not beside
// water, not on village ground, a stack a day at most), smelts it into glass in a furnace with real fuel, crafts bottles and panes; a cowherd
// short of bottles buys new ones from it; builders leave windows open while no panes are to be had and glaze them later.
module.exports = async (pg) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [], info: {} }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
    const I = BF.I, B = BF.B, T = BF.trades, inv = T.inv, W = BF.world, GM = BF.glassmaker;
    const c = (m, n) => inv.count(m.inv, I[n]);
    BF.state.paused = true;
    BF.newWorld(123, { gen: 4, villages: 9, gameMode: "survival" });   // the harness planet seed: its rivers are worked out in this page already
    ok("new worlds use village generator 7", BF.state.villages >= 7, BF.state.villages);
    BF.mobs.spawning = false;

    // ---- recipe, jobsite, trade tables
    const craftG = (stacks, w) => { const r = BF.inventory.gridSet(stacks, w); BF.inventory.gridSet([], 3); return r; };
    const s = id => ({ id, count: 1 });
    BF.inventory.clear();
    let r = craftG([null, s(I.cobblestone), null, s(I.cobblestone), s(I.iron_ingot), s(I.cobblestone), null, s(I.cobblestone), null], 3);
    ok("4 cobblestone around an iron ingot make a glass kiln", r && r.id === B.glass_kiln, r);
    ok("the glass kiln is the glassmaker's jobsite", BF.jobs.JOBSITE.glassmaker === "glass_kiln" && BF.blocks[B.glass_kiln].jobsite === "glassmaker");
    const sellsGlass = p => T.table(p).some(pool => pool.some(o => o.sell.id === I.glass || o.buy.some(b => b.id === I.glass)));
    ok("librarians and cartographers have no glass offers", !sellsGlass("librarian") && !sellsGlass("cartographer"));
    ok("glass is off their restock list", !T.PRODUCE.librarian.includes("glass") && !T.PRODUCE.cartographer.includes("glass"));
    ok("the glassmaker sells glass, panes and bottles and restocks nothing", ["glass", "glass_pane", "glass_bottle"].every(n => T.table("glassmaker")[0].some(o => o.sell.id === I[n])) && T.PRODUCE.glassmaker.length === 0);
    const lib = { profession: "librarian" }; T.init(lib); lib.inv = inv.create(); inv.add(lib.inv, I.glass, 3); lib.restockDay = 0;
    T.restock(lib, 3);
    ok("a librarian's glass does not restock", c(lib, "glass") === 3, c(lib, "glass"));
    const gStart = T.stockFor("glassmaker", {});
    ok("a generated glassmaker starts with a stone shovel and no glass wares", gStart.some(x => x && x.id === I.stone_shovel) && !gStart.some(x => x && [I.glass, I.glass_pane, I.glass_bottle].includes(x.id)));
    const house = BF.worldgen.recordBuilding("house", 5, 5, 0, 0.9);
    ok("builders' houses have pane windows, no glass blocks", house.some(x => x[3] === B.glass_pane) && !house.some(x => x[3] === B.glass));

    // ---- the sand village near spawn: a glassmaker, its kiln and a furnace beside it
    const vg = BFT.village(v => v.ground === 1);
    if (!vg) { ok("a sand village within 3 km", false); return R; }
    const V = { x: Math.round(vg.x), z: Math.round(vg.z) };
    ok("worldgen: sand within 64 blocks of the village", BF.worldgen.sandNear(V.x, V.z, 64));
    BF.player.teleport(V.x + 0.5, BF.worldgen.heightAt(V.x, V.z) + 2, V.z + 0.5);
    for (let i = 0; i < 400 && !W.isLoaded(V.x, V.z); i++) { W.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { W.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (W.queueLength === 0) break; }
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    for (let k = 0; k < 160; k++) step();
    let rec = null;
    for (let k = 0; k < 160 && !((rec = BF.mobs.villages.get(V.x + "," + V.z)) && rec.members.some(m => m.profession === "glassmaker")); k++) { W.update(V.x, V.z, 8); for (let j = 0; j < 10; j++) step(); }
    const G = rec && rec.members.find(m => m.profession === "glassmaker" && !m.dead);
    ok("the village has a glassmaker", !!G, rec && rec.members.map(m => m.profession));
    if (!G) return R;
    const plan = rec.wg.jobsites.filter(j => j.prof === "glassmaker" || j.prof === "furnace");
    const kiln = plan.find(j => j.prof === "glassmaker"), fur = plan.find(j => j.prof === "furnace");
    ok("its kiln is in the world with a furnace beside it", kiln && fur && W.getBlock(kiln.x, kiln.y, kiln.z) === B.glass_kiln && BF.isFurnace(W.getBlock(fur.x, fur.y, fur.z)) && Math.abs(kiln.x - fur.x) + Math.abs(kiln.z - fur.z) === 1, plan);
    ok("the glassmaker works at that kiln", G.jobsite && G.jobsite.x === kiln.x && G.jobsite.z === kiln.z, G.jobsite);
    let panes = 0, glassB = 0;
    for (const b of rec.wg.buildings) for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) for (let y = b.y + 1; y <= b.y + 8; y++) { const id = W.isLoaded(x, z) ? W.getBlock(x, y, z) : 0; if (id === B.glass_pane) panes++; else if (id === B.glass) glassB++; }
    ok("generated buildings have pane windows, no glass blocks", panes > 0 && glassB === 0, { panes, glassB });

    // ---- digging rules
    const vs = rec.members.filter(m => m.type === "villager" && !m.child && !m.dead && m.inv);
    for (const m of vs) if (m !== G) { m.inv = inv.create(); inv.add(m.inv, I.bread, 12); }   // nobody else holds sand, fuel or glass
    const kit = (m, items) => { m.inv = inv.create(); for (const [n, k] of items) if (k) inv.add(m.inv, I[n], k); m.gls = null; };
    kit(G, [["bread", 12], ["stone_shovel", 1]]);
    G.position.set(kiln.x + 0.5, kiln.y, kiln.z + 1.5);
    const spots = GM.findDig(G);
    ok("it finds natural sand to dig near the village", !!spots && spots.length > 0, spots && spots.length);
    if (!spots) return R;
    const sp = spots[0];
    W.setBlock(sp.x, sp.y + 1, sp.z, B.sand);   // placed sand on top: neither it nor the sand under it may be dug
    ok("placed sand is never dug (nor the sand under it)", GM.digY(rec, sp.x, sp.z) == null, GM.digY(rec, sp.x, sp.z));
    W.setBlock(sp.x, sp.y + 1, sp.z, 0);
    ok("a spot whose air was edited counts as dug already", GM.digY(rec, sp.x, sp.z) == null);
    const wet = spots.find(p => p !== sp);
    let wetOk = true;
    if (wet) { const nb = [wet.x + 1, wet.y, wet.z], was = W.getBlock(...nb); W.setBlock(...nb, B.water); wetOk = GM.digY(rec, wet.x, wet.z) == null; W.setBlock(...nb, was); }
    ok("sand beside water is never dug", wetOk);
    let villageGround = 0;
    for (const b of rec.wg.buildings.slice(0, 6)) if (GM.digY(rec, b.x0, b.z0) != null) villageGround++;
    ok("no digging on the village's buildings", villageGround === 0, villageGround);

    // ---- a working day: dig, smelt (fuel bought from a seller), craft
    const sellerC = vs.find(m => m !== G);
    kit(sellerC, [["bread", 12], ["coal", 40]]);
    sellerC.trades = [Object.assign(T.parseTrade("1 emerald > 8 coal"), { level: 1, xp: 2 })];
    kit(G, [["bread", 12], ["stone_shovel", 1], ["emerald", 10]]);
    G.position.set(kiln.x + 0.5, kiln.y, kiln.z + 1.5);
    BF.sky.setTime(0.03);
    const day0 = BF.sky.day, statuses = new Set();
    const before = new Map();
    let maxDug = 0;
    for (let i = 0; i < 20000 && BF.sky.day === day0 && BF.sky.time < 0.46; i++) {
      step(0.1);
      if (i % 10 === 0) { statuses.add(BF.villagerStatus.text(G)); sellerC.position.set(G.position.x + 2, G.position.y, G.position.z); sellerC.vel.set(0, 0, 0); }
      if (G.gls) maxDug = Math.max(maxDug, G.gls.dug || 0);
    }
    const H1 = GM.holdings(G);
    R.info.day1 = { H1, statuses: [...statuses], log: GM.LOG.slice(-12), coal: c(G, "coal") };
    const digs = GM.LOG.filter(e => e.kind === "dig").reduce((a, e) => a + e.n, 0);
    ok("it dug sand", digs > 0, digs);
    ok("no more than a stack (64) dug in a day", maxDug <= 64, maxDug);
    ok("it bought coal for the furnace", GM.LOG.some(e => e.kind === "buy" && e.what === "coal"), GM.LOG.filter(e => e.kind === "buy"));
    const loaded = GM.LOG.filter(e => e.kind === "load").reduce((a, e) => a + e.sand, 0), smelted = GM.LOG.filter(e => e.kind === "collect").reduce((a, e) => a + e.glass, 0);
    ok("it smelted glass, never more than the sand it loaded", smelted > 0 && smelted <= loaded, { loaded, smelted });
    const made = H1.made;
    ok("glass conserved: glass + panes*6/16 + bottles == smelted", Math.abs(H1.glass + H1.panes * 6 / 16 + H1.bottles - smelted) < 0.01 && made.glass === smelted, { H1, smelted });
    const back = GM.LOG.filter(e => e.kind === "collect").reduce((a, e) => a + (e.back || 0), 0);
    ok("sand conserved: dug today (finished trips and one under way) == held + loaded - taken back out", H1.dugToday === H1.sand + loaded - back && digs <= H1.dugToday, { digs, dugToday: H1.dugToday, sand: H1.sand, loaded, back });
    ok("it crafted bottles and panes", made.bottles > 0 && made.panes > 0, made);
    ok("statuses: digging sand, smelting glass, making bottles or panes", statuses.has("Digging sand") && statuses.has("Smelting glass") && (statuses.has("Making bottles") || statuses.has("Making panes")), [...statuses]);
    const stF = BF.inventory.furnaceState(fur.x, fur.y, fur.z);
    ok("its furnace is left empty", !stF || !stF.slots[0], stF && stF.slots);
    const dugAt = GM.LOG.filter(e => e.kind === "dig").map(e => e.at);
    ok("dug spots are air now and the ground under them is solid", dugAt.every(a => W.getBlock(a[0], a[1], a[2]) === 0 && BF.SOLID[W.getBlock(a[0], a[1] - 1, a[2])]), dugAt.slice(0, 4));

    // ---- no sand to dig, nobody sells any, no fuel: waiting
    {
      kit(G, [["bread", 12]]);
      G.gls = { stage: null, job: null, checkT: 0, avoid: {}, cd: 0, day: Math.floor(BF.sky.day + BF.sky.time), dug: 64, wait: "" };
      BF.sky.setTime(0.1);
      for (let i = 0; i < 100; i++) step(0.1);
      ok("dug its stack today and nobody sells sand: Waiting for sand", BF.villagerStatus.text(G) === "Waiting for sand", BF.villagerStatus.text(G));
      kit(G, [["bread", 12], ["sand", 16]]);
      G.gls = { stage: null, job: null, checkT: 0, avoid: {}, cd: 0, day: Math.floor(BF.sky.day + BF.sky.time), dug: 64, wait: "" };
      kit(sellerC, [["bread", 12]]);
      // and no fuel left in any of the village's furnaces (the planet's bigger villages have other furnace users, who may have left some)
      const fuelLeft = () => BF.furnaceUse.near(G, I.sand, I.glass).filter(f => BF.furnaceUse.fuelIn(f) > 0).map(f => [f.x, f.y, f.z]);
      for (let i = 0; i < 100; i++) {
        if (i % 10 === 0) for (const f of BF.furnaceUse.near(G, I.sand, I.glass)) { const fs = BF.inventory.furnaceState(f.x, f.y, f.z); if (fs) { fs.slots[1] = null; fs.burn = 0; } }
        step(0.1);
      }
      ok("sand but no fuel to be had: Waiting for fuel", BF.villagerStatus.text(G) === "Waiting for fuel", { status: BF.villagerStatus.text(G), fuelLeft: fuelLeft() });
    }

    // ---- a cowherd short of bottles buys new ones from the glassmaker
    {
      const C = sellerC;
      C.profession = "cowherd"; C.trades = T.offers("cowherd", 1); C.jobsite = null;
      kit(C, [["bread", 12], ["emerald", 6], ["glass_bottle", 2]]);
      kit(G, [["bread", 12], ["glass_bottle", 27]]);
      ok("the cowherd's empties gap raises the glassmaker's bottle stock", GM.bottleTarget(G) > 9, GM.bottleTarget(G));
      BF.sky.setTime(0.1);
      let got = 0;
      for (let i = 0; i < 3000 && got <= 2; i++) { step(0.1); got = c(C, "glass_bottle"); if (i % 10 === 0) { C.position.set(G.position.x + 2, G.position.y, G.position.z); C.vel.set(0, 0, 0); } }
      ok("the cowherd bought new bottles from the glassmaker", got > 2 && c(G, "glass_bottle") < 27, [got, c(G, "glass_bottle")]);
    }

    // ---- builders: no glassmaker and no panes for sale -> windows left open, glazed once panes turn up
    {
      const BL = BF.builder, BP = BF.blueprints;
      const others = rec.members.filter(m => m.profession === "glassmaker");
      for (const m of others) m.profession = "nitwit";
      W.setBlock(kiln.x, kiln.y, kiln.z, 0); BF.emit("blockBroken", kiln.x, kiln.y, kiln.z, B.glass_kiln);   // nobody takes the job up again
      const stock = BL.analyze;   // keep a reference: analyze is what decides
      const bld = vs.find(m => m.profession === "builder") || null;
      ok("the village has a builder", !!bld);
      if (bld) {
        const sty = rec.style | 0;   // the village's own building style (a desert village builds in sandstone on the planet)
        const bp = BP.get("small_house", 0, sty, 0.5, null, "oak");
        const req = Object.assign({}, bp.req); delete req[I.glass_pane];
        bld.inv = inv.create(); for (const k in req) inv.add(bld.inv, +k, req[k] + 4); inv.add(bld.inv, BF.worldgen.palette(sty).found, 24); inv.add(bld.inv, I.bread, 20);
        const a = stock(bld.inv, bp.req, "oak");
        ok("a house lacking only panes", !a.ok && Object.keys(a.shortfall).every(k => +k === I.glass_pane), a.shortfall);
        const built = BL.builtOf(rec);
        for (const e of built) if (e.state === "building") e.state = "abandoned";
        bld.bs = null; bld.position.set(V.x + 0.5, BF.worldgen.heightAt(V.x, V.z) + 1, V.z + 0.5);
        const n0 = built.length;
        let e = null;
        bld.bs = { mode: "idle", t: 0, cool: 0, stage: null, fail: {}, avoid: {}, placeT: 0.6, entry: null, want: null, losT: 0, losFor: -1 };
        const bs = bld.bs;
        BF.sky.setTime(0.05);
        const e0 = BL.beginPlan(bld, bs, "small_house", "oak");
        ok("it starts the house without panes (none to be had)", !!e0, BL.log.slice(-3));
        if (e0) {
          { const x = e0.ox - 2, z = e0.oz - 2; bld.position.set(x + 0.5, W.heightAt(x, z) + 1, z + 0.5); bld.vel.set(0, 0, 0); bld.ai.route = null; }
          BL.startBuild(bld, bs, e0, true);
          for (let i = 0; i < 12000 && e0.state === "building"; i++) { step(0.1); if (BF.sky.time > 0.44) BF.sky.setTime(0.06); }
          e = e0;
          ok("the house is finished with its windows left open", e.state === "done" && e.gaps && e.gaps.length > 0, { state: e.state, gaps: e.gaps && e.gaps.length, prog: e.prog, n: e.n, mode: bs.mode, status: BF.villagerStatus.text(bld), cell: e.prog < e.n ? BL.cellOf(e, e.prog) : null, pos: [bld.position.x, bld.position.y, bld.position.z].map(v => +v.toFixed(1)), log: BL.log.slice(-6), t: BF.sky.time, panesAt: rec.members.filter(m => m.inv && c(m, "glass_pane")).map(m => [m.profession, c(m, "glass_pane"), (m.trades || []).filter(o => o.sell.id === I.glass_pane).length]), gm: rec.members.filter(m => m.profession === "glassmaker").length });
          inv.add(bld.inv, I.glass_pane, 16);
          bs.cool = 0; bs.mode = "idle"; bs.t = 0;
          for (let i = 0; i < 6000 && !(e.state === "done" && !e.glaze && (!e.gaps || !e.gaps.length) && BL.log.some(l => l.kind === "glazed")); i++) { step(0.1); if (BF.sky.time > 0.44) BF.sky.setTime(0.06); }
          const cells = BP.get(e.type, e.rot, e.style, e.h, e.opts, e.wood).cells.filter(x => x.id === B.glass_pane);
          const filled = cells.filter(x => W.getBlock(e.ox + x.x, e.oy + x.y, e.oz + x.z) === B.glass_pane).length;
          ok("with panes in hand it glazed the windows", BL.log.some(l => l.kind === "glazed") && filled === cells.length, { filled, of: cells.length, log: BL.log.slice(-4).map(l => l.kind) });
        }
        void n0;
      }
    }
    return R;
  });
  for (const l of res.lines) console.log(l);
  console.log("info", JSON.stringify(res.info).slice(0, 4000));
};
