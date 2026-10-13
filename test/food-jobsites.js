// @ci integration suite=village,farming soak timeout=900
// Builders' food jobsites, farmers' dirt and grass spreading (idea-044): node test/run.js /tmp/fj test/food-jobsites.js
// 1. The food jobsite roll (builder.js chooseFood): with no animals near it builds a vegetable farm, with 2 wild cows within 80 blocks a
//    pasture can be picked too, with no materials anywhere nothing passes. The stable needs 2 wild horses within 80 blocks.
// 2. A builder builds a vegetable farm: log ring, water in the channel, a composter beside it, soil left untilled; a jobless villager takes it.
// 3. A farmer with dirt beyond its keep offers it at 16 per emerald; with none for sale a builder short of dirt digs its own.
// 4. Exposed dirt beside grass turns green within a few days; dirt under a block does not.
module.exports = async (pg) => {
  const res = await pg.evaluate(() => {
    const out = { fails: [], notes: [] }, ok = (c, msg, d) => { if (!c) out.fails.push(msg + (d !== undefined ? " " + JSON.stringify(d) : "")); else out.notes.push("ok " + msg); };
    const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, villages: 10, gameMode: "creative" });
    BF.mobs.spawning = false;
    // the nearest village with a builder
    const vs = BF.worldgen.villagesNear(0, 0, 1500).filter(v => v.pop >= 10).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    let R = null, bl = null;
    for (const v of vs.slice(0, 6)) {
      BF.player.spawn(v.x + 0.5, v.y + 3, v.z + 0.5);
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      BF.sky.setTime(0.03);
      for (let i = 0; i < 100; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
      const key = Math.round(v.x) + "," + Math.round(v.z);
      R = BF.mobs.villages.get(key);
      bl = R && R.members.find(m => m.profession === "builder" && !m.dead);
      if (bl) break;
    }
    ok(!!bl, "a village with a builder");
    if (!bl) return out;
    const B = BF.builder, T = BF.trades.inv, I = BF.I;
    for (const o of R.members) if (o.profession === "builder" && o !== bl) o.bs = { mode: "idle", t: 1e9, cool: 1e9, fail: {}, avoid: {} };
    const bs = bl.bs || (bl.bs = { fail: {}, avoid: {} });
    bs.fail = {};
    const wild = k => BF.mobs.list.filter(o => o.type === k && !o.dead && !o.pen && !o.pasture && !o.coop && !o.sty);
    const clearWild = () => { for (const o of BF.mobs.list.slice()) if (["cow", "sheep", "pig", "chicken", "horse"].includes(o.type) && !o.pen && !o.pasture && !o.coop && !o.sty && !(o.horse && o.horse.owner)) BF.mobs.hurt(o, 999, "test"); };
    // everything each food jobsite needs, in oak
    const fillInv = () => {
      for (let i = 0; i < bl.inv.length; i++) bl.inv[i] = null;
      const need = {};
      for (const t of B.FOOD) { const bp = BF.blueprints.get(t, 0, 0, 0.5, null, "oak"); const rq = B.planReq(bl, bp, t, 0); for (const k in rq) need[k] = Math.max(need[k] || 0, rq[k]); }
      for (const k in need) T.add(bl.inv, +k, need[k]);
      T.add(bl.inv, I.oak_planks != null ? I.oak_planks : I.planks, 64);
    };
    // ---- 1. the roll
    clearWild();
    fillInv();
    const picks = n => { const c = {}; for (let i = 0; i < n; i++) { bs.fail = {}; const t = B.chooseFood(bl, bs); c[t] = (c[t] || 0) + 1; } return c; };
    const p0 = picks(20);
    ok(p0.veg_farm === 20, "no animals near: every pick is a vegetable farm", p0);
    const cows = [];
    for (let i = 0; i < 2; i++) {
      const x = R.x + 30 + i * 2, z = R.z + 30, y = BF.world.heightAt(x, z) + 1;
      const c = BF.mobs.spawn("cow", x + 0.5, y, z + 0.5);
      if (c) cows.push(c);
    }
    ok(B.wildCount(R, "cow") >= 2, "2 wild cows within 80 blocks", B.wildCount(R, "cow"));
    const p1 = picks(60);
    ok(p1.pasture > 0 && Object.keys(p1).every(t => t === "veg_farm" || t === "pasture"), "2 cows near: a pasture is picked too, nothing else needing animals", p1);
    // no materials anywhere: nothing passes, and the builder picks among the other structures
    const saved = R.members.map(o => [o, o.trades]);
    for (const o of R.members) if (o !== bl) o.trades = [];
    for (let i = 0; i < bl.inv.length; i++) bl.inv[i] = null;
    const p2 = picks(10);
    ok(p2.null === 10, "no materials: the food jobsite fails", p2);
    for (const [o, t] of saved) o.trades = t;
    ok(B.weighTypes(bl, bs).every(([t, w]) => !["garden", "coop", "pasture", "sty", "pen", "veg_farm"].includes(t)), "garden, coop, pasture, sty, pen and farm are not separate structures", B.weighTypes(bl, bs).map(x => x[0]));
    const hasFood = B.weighTypes(bl, bs).find(x => x[0] === "food_jobsite");
    ok(hasFood && Math.abs(hasFood[1] - B.FOOD_WEIGHT) < 1e-9, "food_jobsite weighs 2.5", hasFood);
    const st = B.weighTypes(bl, bs).find(x => x[0] === "stable");
    ok(!st || st[1] === 0 || B.wildCount(R, "horse") >= 2, "no stable without 2 wild horses near", st);
    // ---- 2. a vegetable farm, built
    for (const c of cows) if (!c.dead) BF.mobs.hurt(c, 999, "test");
    clearWild();
    fillInv();
    for (const e of B.builtOf(R)) if (e.state === "building") e.state = "abandoned";
    bs.fail = {}; bs.mode = null;
    const e = B.beginPlan(bl, bs, "veg_farm", "oak");
    ok(!!e, "the builder plans a vegetable farm");
    if (!e) return out;
    const entry = B.builtOf(R).find(x => x.type === "veg_farm" && x.state === "building") || e;
    BF.sky.setTime(0.03);
    for (let s = 0; s < 6 * 60 * 20 && entry.state !== "done"; s++) {
      if (BF.sky.time > 0.45) BF.sky.setTime(0.03);   // keep it working hours
      BF.world.update(entry.ox, entry.oz, 30);
      step(0.05);
    }
    ok(entry.state === "done", "the farm got finished", { state: entry.state, prog: entry.prog, n: entry.n, mode: bl.bs && bl.bs.mode, stage: bl.bs && bl.bs.stage });
    const bp = B.bpOf(entry), W = BF.world;
    let logs = 0, water = 0, comp = 0, farmland = 0;
    for (let z = entry.oz - 1; z <= entry.oz + bp.d; z++) for (let x = entry.ox - 1; x <= entry.ox + bp.w; x++) for (let y = entry.oy - 2; y <= entry.oy + 1; y++) {
      const id = W.getBlock(x, y, z);
      if (BF.blueprints.woodOf(id) && /log/.test(BF.blocks[id].name)) logs++;
      if (id === BF.B.water) water++;
      if (id === BF.B.composter) comp++;
      if (id === BF.B.farmland) farmland++;
    }
    ok(logs >= 20 && water >= 3 && comp === 1, "the farm has its log ring, water in its channel and a composter", { logs, water, comp });
    ok(farmland === 0, "the builder left the soil untilled", farmland);
    // a jobless villager takes the composter
    const PLAIN = ["cleric", "librarian", "cartographer", "armorer", "weaponsmith", "butcher", "fisherman", "fletcher", "leatherworker", "mason"];
    const other = R.members.find(o => o.type === "villager" && !o.dead && !o.child && PLAIN.includes(o.profession) && o.jobsite);
    if (other) {
      const js0 = other.jobsite;
      BF.jobs.release(other);
      other.jobMem = null;   // a plain jobless villager (no remembered trade)
      if (js0) W.setBlock(js0.x, js0.y, js0.z, 0);   // and its old block gone, so the new composter is the free jobsite
      for (let s = 0; s < 20 * 60 && other.profession === "unemployed"; s++) { BF.world.update(entry.ox, entry.oz, 30); step(0.05); if (BF.sky.time > 0.45) BF.sky.setTime(0.03); }
      ok(R.members.some(o => o.profession === "farmer" && o.jobsite && W.getBlock(o.jobsite.x, o.jobsite.y, o.jobsite.z) === BF.B.composter && Math.abs(o.jobsite.x - entry.ox) < bp.w + 3 && Math.abs(o.jobsite.z - entry.oz) < bp.d + 3), "a jobless villager took the new composter", { prof: other.profession, js: other.jobsite });
    }
    // ---- 3. farmers' dirt
    const fa = R.members.find(o => o.profession === "farmer" && !o.dead && o.inv);
    if (fa) {
      T.add(fa.inv, I.dirt, 40);
      if (BF.market.sync) BF.market.sync(fa);
      const o = (fa.trades || []).find(o => o.sell && o.sell.id === I.dirt);
      ok(!!o && o.sell.n === 16 && o.buy[0].n === 1, "a farmer with spare dirt offers 16 for an emerald", o && [o.buy, o.sell]);
      T.take ? T.take(fa.inv, I.dirt, T.count(fa.inv, I.dirt)) : null;
      if (BF.market.sync) BF.market.sync(fa);
    }
    // a second farm with no dirt in hand and none for sale: the builder digs its own
    for (const o of R.members) if (o !== bl && o.inv) { const n = T.count(o.inv, I.dirt); if (n) T.take(o.inv, I.dirt, n); if (BF.market.sync && o.trades) BF.market.sync(o); }
    fillInv();
    T.take(bl.inv, I.dirt, T.count(bl.inv, I.dirt));
    for (const x of B.builtOf(R)) if (x.state === "building") x.state = "abandoned";
    bl.bs.fail = {}; bl.bs.mode = null; bl.bs.stage = null;
    const e2 = B.beginPlan(bl, bl.bs, "veg_farm", "oak"), d0 = B.log.filter(x => x.kind === "dig").length;
    if (e2) {   // sand under part of its soil (as in a desert village): those cells take dirt the builder has to get
      const soil = (B.bpOf(e2).marks.soil || []).slice(0, 8);
      for (const [u, q] of soil) { W.setBlock(e2.ox + u, e2.oy - 1, e2.oz + q, BF.B.sand); e2.fill.push([e2.ox + u, e2.oy - 1, e2.oz + q, 1]); }
    }
    for (let s = 0; e2 && s < 3 * 60 * 20 && B.log.filter(x => x.kind === "dig").length === d0; s++) {
      if (BF.sky.time > 0.45) BF.sky.setTime(0.03);
      BF.world.update(e2.ox, e2.oz, 30);
      step(0.05);
    }
    ok(!!e2 && B.log.filter(x => x.kind === "dig").length > d0, "with no dirt for sale the builder digs its own", { planned: !!e2, mode: bl.bs.mode, stage: bl.bs.stage, dirt: T.count(bl.inv, I.dirt), e2: e2 && [e2.state, e2.prog, e2.n, e2.fill && e2.fill.length], log: B.log.slice(-6).map(x => x.kind + ":" + JSON.stringify(x).slice(0, 120)) });
    return out;
  });
  for (const n of res.notes || []) console.log(n);
  const fails = (res.fails || []).slice();
  // ---- 4. grass
  const g = await pg.evaluate(() => {
    const W = BF.world, B = BF.B, p = BF.player.position, x0 = Math.floor(p.x) + 6, z0 = Math.floor(p.z) + 6;
    let y = W.heightAt(x0, z0);
    // a 5x5 grass pad at the surface, its middle row dug to dirt; one cell covered by a plank
    for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 5; dx++) { W.setBlock(x0 + dx, y, z0 + dz, B.grass); for (let k = 1; k < 4; k++) W.setBlock(x0 + dx, y + k, z0 + dz, 0); }
    for (let dx = 0; dx < 5; dx++) W.setBlock(x0 + dx, y, z0 + 2, B.dirt);
    W.setBlock(x0, y + 1, z0 + 2, B.planks);
    const before = BF.grass.stats().turned;
    BF.sky.setTime(0.1);
    // check the cells as the random ticks would, many times over (a few days' worth for these cells)
    for (let i = 0; i < 400; i++) for (let dx = 0; dx < 5; dx++) BF.grass.check(x0 + dx, y, z0 + 2);
    const row = []; for (let dx = 0; dx < 5; dx++) row.push(W.getBlock(x0 + dx, y, z0 + 2) === B.grass ? "g" : "d");
    // the random tick itself turns some dirt somewhere over a sim day
    return { row: row.join(""), turned: BF.grass.stats().turned - before, looked: BF.grass.stats().looked, light: BF.skyLight && BF.skyLight.get ? BF.skyLight.get(x0 + 2, y + 1, z0 + 2) : null };
  });
  console.log("grass:", JSON.stringify(g));
  if (g.row !== "dgggg") fails.push("grass: exposed dirt beside grass turns green, covered dirt does not: " + g.row);
  if (!(g.looked > 0)) fails.push("grass: the random tick looked at no columns");
  for (const f of fails) console.log("FAIL", f);
  console.log(fails.length ? "FAILED" : "OK food jobsites");
};
