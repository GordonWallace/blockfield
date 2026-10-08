// Egg cooking checks (js/eggcook.js, js/furnaceuse.js): NODE_PATH=$(npm root -g) node test/run.js /tmp/egg test/eggcook-actions.js
// Villagers cook eggs only in a real furnace of their village, with fuel they hold (or what burns there already), in game time, one villager
// per furnace; with no furnace, or no fuel and no emeralds, the eggs stay raw for a whole day. Eggs in == cooked eggs out. A hungry villager
// buys eggs when it can cook them (ready food when it cannot), cooks and eats them. The player's furnace cooks eggs too.
module.exports = async (pg) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [], info: {} }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.inventory.simTick(h); BF.world.tickSim(); };
    const I = BF.I, T = BF.trades, inv = T.inv, W = BF.world, EC = BF.eggCook, FU = BF.furnaceUse;
    const c = (m, n) => inv.count(m.inv, I[n]);
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;
    const V = { x: 26, z: 39 };   // seed 1: a village near spawn (test/shepherd-day.js)
    BF.player.teleport(V.x + 4.5, BF.worldgen.heightAt(V.x + 4, V.z + 4) + 2, V.z + 4.5);
    for (let i = 0; i < 400 && !W.isLoaded(V.x, V.z); i++) { W.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { W.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (W.queueLength === 0) break; }
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    for (let k = 0; k < 160; k++) step();
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(V.x + "," + V.z) || { members: [] }).members.filter(m => m.type === "villager" && !m.child).length >= 5); k++) { W.update(V.x, V.z, 8); for (let j = 0; j < 10; j++) step(); }
    const rec = BF.mobs.villages.get(V.x + "," + V.z);
    const vs = rec.members.filter(m => m.type === "villager" && !m.child && !m.dead && m.inv && m.profession !== "builder");
    R.info.villagers = vs.map(m => m.profession);
    if (vs.length < 5) { ok("village has 5 adult villagers", false, vs.length); return R; }

    // ---- the player's furnace cooks eggs; raw eggs are not food, cooked eggs are
    ok("egg smelts to cooked egg", BF.inventory.smelting.get(I.egg) === I.cooked_egg);
    ok("raw eggs are not food, cooked eggs are", !BF.food.isFood(I.egg) && BF.food.isFood(I.cooked_egg), [BF.items[I.egg].food, BF.items[I.cooked_egg].food]);
    // every furnace of the village goes: the test puts its own down
    const clearFurnaces = () => { let n = 0; FU.hook(); for (const f of [...FU.furnaces.values()]) if (Math.hypot(f.x - rec.x, f.z - rec.z) < 200) { W.setBlock(f.x, f.y, f.z, 0); BF.emit("blockBroken", f.x, f.y, f.z, BF.B.furnace); n++; } return n; };
    R.info.removedFurnaces = clearFurnaces();
    const ground = (x, z, y0) => { let y = y0 + 4; while (y > y0 - 12 && !(BF.SOLID[W.getBlock(x, y - 1, z)] && W.getBlock(x, y, z) === 0 && W.getBlock(x, y + 1, z) === 0)) y--; return y; };
    const putFurnace = (m, dx, dz) => {
      for (let r = 0; r < 6; r++) for (const [ax, az] of [[dx, dz], [dx + r, dz], [dx, dz + r], [dx - r, dz], [dx, dz - r]]) {
        const x = Math.floor(m.position.x) + ax, z = Math.floor(m.position.z) + az, y = ground(x, z, Math.floor(m.position.y));
        if (W.getBlock(x, y, z) !== 0 || !BF.SOLID[W.getBlock(x, y - 1, z)]) continue;
        if (!BF.DIRS.some(([ex, ez]) => W.getBlock(x + ex, y, z + ez) === 0 && BF.SOLID[W.getBlock(x + ex, y - 1, z + ez)])) continue;   // a free side to stand at
        W.setBlock(x, y, z, BF.B.furnace); BF.emit("blockPlaced", x, y, z, BF.B.furnace);
        return { x, y, z };
      }
      return null;
    };
    {
      const P = putFurnace(vs[0], 3, 3);
      const st = BF.inventory.furnaceRecord(P.x, P.y, P.z);
      st.slots[0] = { id: I.egg, count: 3 }; st.slots[1] = { id: I.coal, count: 1 };
      for (let k = 0; k < 400; k++) BF.inventory.simTick(0.1);
      ok("player furnace: 3 eggs + coal -> 3 cooked eggs in 40 s", !st.slots[0] && st.slots[2] && st.slots[2].id === I.cooked_egg && st.slots[2].count === 3, st.slots);
      W.setBlock(P.x, P.y, P.z, 0); BF.emit("blockBroken", P.x, P.y, P.z, BF.B.furnace);
    }

    // the cast: A cooks, B and C share one furnace, D has no furnace, E no fuel, H buys eggs from S
    const [A, B, C, S, H] = vs;
    const others = vs.slice(5);
    const kit = (m, items) => { m.inv = inv.create(); for (const [n, k] of items) if (k) inv.add(m.inv, I[n], k); if (m.eggc) m.eggc = null; if (m.fshop) { m.fshop.stage = null; m.fshop.deal = null; m.fshop.cd = 0; } };
    for (const m of vs) kit(m, [["bread", 12]]);   // fed: nobody shops for food unless the test wants it
    const cast = { A, B, C, S, H };
    for (const k in cast) cast[k].__egg = k;
    const sampleCooks = f => vs.filter(m => m.eggc && m.eggc.stage === "cook" && m.eggc.deal && m.eggc.deal.furnace.x === f.x && m.eggc.deal.furnace.y === f.y && m.eggc.deal.furnace.z === f.z).length;
    const statuses = new Set();

    // ---- 1. A: 10 eggs, its own coal, some coal already in the furnace: cooks them there, takes the leftover coal back
    const F1 = putFurnace(A, 2, 0);
    ok("test furnace placed", !!F1, F1);
    if (!F1) return R;
    BF.inventory.furnaceRecord(F1.x, F1.y, F1.z).slots[1] = { id: I.coal, count: 3 };   // somebody's coal: burnt first, the rest taken out
    kit(A, [["egg", 10], ["coal", 4], ["bread", 12]]);
    BF.sky.setTime(0.06);
    let usedSlots = false, tLoad = null, tDone = null, maxEggsIn = 0;
    for (let i = 0; i < 12000 && !(tDone != null); i++) {
      step();
      const st = BF.inventory.furnaceState(F1.x, F1.y, F1.z), S1 = A.eggc;
      if (st && st.slots[0] && st.slots[0].id === I.egg) { usedSlots = true; maxEggsIn = Math.max(maxEggsIn, st.slots[0].count); }
      if (S1 && S1.stage === "cook" && tLoad == null) tLoad = BF.state.time;
      if (tLoad != null && !(S1 && S1.stage) && tDone == null) tDone = BF.state.time;
      if (i % 20 === 0) statuses.add(BF.villagerStatus.text(A));
    }
    R.info.A = { inv: A.inv.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count), log: EC.LOG.filter(e => e.who.startsWith(A.profession)).slice(-6), statuses: [...statuses] };
    ok("A put its eggs in the furnace (input slot held eggs)", usedSlots && maxEggsIn === 10, maxEggsIn);
    ok("A took 10 cooked eggs out, no raw eggs left", c(A, "cooked_egg") === 10 && c(A, "egg") === 0, [c(A, "cooked_egg"), c(A, "egg")]);
    ok("A burnt the furnace's coal first and took the leftover back (4 own + 1 left)", c(A, "coal") === 5, c(A, "coal"));
    const st1 = BF.inventory.furnaceState(F1.x, F1.y, F1.z);
    ok("furnace left empty", !st1 || st1.slots.every(s => !s), st1 && st1.slots);
    ok("cooking took game time (10 eggs >= 100 s), not instant", tLoad != null && tDone != null && tDone - tLoad >= 99, tLoad != null && tDone != null ? +(tDone - tLoad).toFixed(1) : null);
    ok("status said Cooking eggs", statuses.has("Cooking eggs"), [...statuses]);
    const vl = (BF.vlog.entries(rec.key) || []).map(e => e[2]).filter(t => / cooked \d+ eggs? in the furnace at /.test(t));
    ok("village log: cooked 10 eggs in the furnace at x,y,z", vl.some(t => t.includes("cooked 10 eggs in the furnace at " + F1.x + "," + F1.y + "," + F1.z)), vl);

    // ---- 2. B and C, 6 eggs each, one furnace: never both at it, both end up with 6 cooked eggs
    kit(B, [["egg", 6], ["coal", 2], ["bread", 12]]); kit(C, [["egg", 6], ["coal", 2], ["bread", 12]]);
    for (const m of [B, C]) { m.position.set(F1.x + 0.5 + (m === B ? 2 : -2), F1.y, F1.z + 2.5); m.vel.set(0, 0, 0); }
    BF.sky.setTime(0.06);
    let maxAt = 0, bothSeen = 0;
    for (let i = 0; i < 16000 && !(c(B, "cooked_egg") + c(C, "cooked_egg") === 12 && !(B.eggc && B.eggc.stage) && !(C.eggc && C.eggc.stage)); i++) {
      step();
      const n = sampleCooks(F1); maxAt = Math.max(maxAt, n);
      if (B.eggc && B.eggc.stage && C.eggc && C.eggc.stage) bothSeen++;
    }
    R.info.BC = { B: [c(B, "egg"), c(B, "cooked_egg"), B.eggc && B.eggc.stage], C: [c(C, "egg"), c(C, "cooked_egg"), C.eggc && C.eggc.stage], bothBusy: bothSeen, t: +BF.sky.time.toFixed(3),
      log: EC.LOG.filter(e => e.kind === "giveup").slice(-5) };
    ok("never two villagers cooking at one furnace", maxAt <= 1, maxAt);
    ok("B and C both cooked their 6 eggs (one after the other)", c(B, "cooked_egg") === 6 && c(C, "cooked_egg") === 6 && c(B, "egg") + c(C, "egg") === 0, R.info.BC);

    // ---- 3. a day with no furnace at all (D has eggs, coal and emeralds), then a day with a furnace but E has no fuel and no emeralds
    const D = B, E = C;
    kit(D, [["egg", 8], ["coal", 4], ["emerald", 5], ["bread", 12]]);
    W.setBlock(F1.x, F1.y, F1.z, 0); BF.emit("blockBroken", F1.x, F1.y, F1.z, BF.B.furnace);
    clearFurnaces();
    kit(E, [["bread", 12]]);
    BF.sky.setTime(0.02);
    const day0 = BF.sky.day;
    let dCooked = 0;
    for (let i = 0; i < 13000 && BF.sky.day === day0; i++) { step(0.1); dCooked = Math.max(dCooked, c(D, "cooked_egg")); }
    for (let i = 0; i < 400; i++) step(0.1);
    ok("no furnace: a full day later D's 8 eggs are still raw", dCooked === 0 && c(D, "cooked_egg") === 0 && c(D, "egg") === 8, [c(D, "egg"), c(D, "cooked_egg"), BF.sky.day - day0]);
    const F2 = putFurnace(E, 2, 0);
    for (const m of vs) if (m !== E) { const keep = [c(m, "bread")]; kit(m, [["bread", Math.max(12, keep[0])]]); }   // nobody holds fuel or eggs to share
    kit(E, [["egg", 8], ["bread", 12]]);
    BF.sky.setTime(0.02);
    const day1 = BF.sky.day;
    let eCooked = 0, eTrips = 0;
    for (let i = 0; i < 13000 && BF.sky.day === day1; i++) { step(0.1); eCooked = Math.max(eCooked, c(E, "cooked_egg")); if (E.eggc && E.eggc.stage) eTrips++; }
    ok("no fuel, no emeralds: a full day later E's 8 eggs are still raw (furnace there)", !!F2 && eCooked === 0 && c(E, "egg") === 8 && eTrips === 0, [c(E, "egg"), eCooked, eTrips, F2]);
    // conservation over every cook so far: cooked out == raw in
    const loads = EC.LOG.filter(e => e.kind === "load").reduce((a, e) => a + e.eggs, 0), outs = EC.LOG.filter(e => e.kind === "collect");
    const cookedOut = outs.reduce((a, e) => a + ((/(\d+) Cooked Egg/.exec(e.got) || [0, 0])[1] | 0), 0);
    ok("eggs conserved: cooked out == raw in (22)", loads === 22 && cookedOut === 22, { loads, cookedOut });

    // ---- 4. food shopping: without a furnace a hungry villager buys bread, not eggs; with one it buys eggs, cooks and eats them
    BF.sky.setTime(0.06);
    const Bk = A;   // a baker: plenty of bread
    kit(S, [["egg", 32], ["bread", 12]]); S.trades = [Object.assign(T.parseTrade("1 emerald > 16 egg"), { level: 1, xp: 2 })];
    kit(Bk, [["bread", 40]]);
    kit(H, [["emerald", 4], ["coal", 3]]); BF.food.life(H).sat = 0;
    for (const m of [S, Bk]) { m.position.set(H.position.x + (m === S ? 2 : -2), H.position.y, H.position.z); m.vel.set(0, 0, 0); }
    H.fshop = { stage: null, deal: null, checkT: 0, avoid: {}, cd: 0 };
    W.setBlock(F2.x, F2.y, F2.z, 0); BF.emit("blockBroken", F2.x, F2.y, F2.z, BF.B.furnace);
    clearFurnaces();
    const noF = BF.villageLife._test.findFoodSeller(H);
    ok("no furnace: the hungry villager would buy ready food, not eggs", !!noF && noF.item !== I.egg, noF && BF.items[noF.item].name);
    const F3 = putFurnace(H, 2, 1);
    const withF = BF.villageLife._test.findFoodSeller(H);
    ok("furnace and coal: it would buy eggs", !!withF && withF.item === I.egg && withF.seller === S, withF && BF.items[withF.item].name);
    kit(Bk, [["bread", 12]]);   // only the eggs are for sale now (the baker keeps its 7 bread-eq)
    const H2 = others.find(m => !m.child) || null;
    if (H2) {   // no fuel and no emeralds to buy any: no eggs either
      kit(H2, [["emerald", 1]]); H2.fshop = { stage: null, deal: null, checkT: 0, avoid: {}, cd: 0 };
      const d2 = BF.villageLife._test.findFoodSeller(H2);
      ok("no fuel and only the egg money: it buys no eggs", !d2 || d2.item !== I.egg, d2 && BF.items[d2.item].name);
      kit(H2, [["bread", 12]]);
    }
    const ate = [];
    BF.food.onEat((m, got, ids) => { if (m === H) ate.push(...ids.map(id => BF.items[id].name)); });
    let bought = 0, hStat = new Set();
    for (let i = 0; i < 16000 && !ate.includes("cooked_egg"); i++) {
      if (i % 20 === 0) { S.position.set(H.position.x + 2, H.position.y, H.position.z); S.vel.set(0, 0, 0); hStat.add(BF.villagerStatus.text(H)); }
      step(); bought = Math.max(bought, c(H, "egg") + c(H, "cooked_egg"));
      if (BF.sky.time > 0.44) BF.sky.setTime(0.2);
    }
    R.info.H = { inv: H.inv.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count), ate, statuses: [...hStat], seller: [c(S, "egg"), c(S, "emerald")] };
    ok("hungry H bought 16 eggs from the egg seller", bought >= 16 && c(S, "egg") === 16 && c(S, "emerald") >= 1, R.info.H);   // S may sell other things meanwhile
    ok("H cooked them in the furnace and ate cooked eggs", ate.includes("cooked_egg") && !ate.includes("egg"), R.info.H);
    ok("H never ate a raw egg; eggs conserved (16 bought = raw + cooked + eaten)", c(H, "egg") + c(H, "cooked_egg") + ate.filter(n => n === "cooked_egg").length === 16, R.info.H);
    R.info.F3 = F3;
    return R;
  });
  for (const l of res.lines) console.log(l);
  console.log("info", JSON.stringify(res.info));
};
