// Chest ownership and villager storage: node test/run.js /tmp/co test/chest-owners.js
// 1. Player: an unowned chest becomes yours when you put something in; someone else's chest is look-only in survival, editable in creative.
// 2. An owned chest left empty for a game day is unclaimed again; a dead villager's chests are unclaimed at once.
// 3. A villager with a full inventory claims an unowned chest in its bed's house and stores its surplus there (least needed first),
//    then comes back for food when it runs low.
// 4. A full villager with no chest it may use orders one; a furniture maker makes it from planks and delivers it into the house.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; });
  await require('./lib').toVillage(pg);
  const step = (t0, t1, secs) => pg.evaluate(async ([t0, t1, secs]) => {
    const dt = 0.05, n = Math.round(secs / dt);
    for (let i = 0; i < n; i++) { BF.sky.setTime(t0 + (t1 - t0) * i / n); BF.mobs.update(dt); if (i % 400 === 0) await new Promise(r => setTimeout(r, 0)); }
  }, [t0, t1, secs]);
  const ok = (cond, what) => console.log((cond ? "PASS " : "FAIL ") + what);

  // ---- 1. player ownership
  const p1 = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    BF.sky.day = 1; BF.sky.setTime(0.2);
    const I = BF.inventory, W = BF.world, pp = BF.player.position;
    const x = Math.floor(pp.x) + 2, z = Math.floor(pp.z) + 2, y = BF.world.heightAt(x, z) + 1;
    W.setBlock(x, y, z, BF.B.chest);
    I.clear(); I.add(BF.I.cobblestone, 10);
    I.open("chest", { x, y, z });
    const title0 = [...document.querySelectorAll(".bf-inv h2")].map(h => h.textContent).find(t => /^Chest/.test(t)) || "";
    return { pos: { x, y, z }, title0 };
  });
  const slot = (c, i) => `.bf-slot[data-c="${c}"][data-i="${i}"]`;
  await pg.keyboard.down('Shift'); await pg.click(slot('inv', 0), { force: true }); await pg.keyboard.up('Shift');
  const r1 = await pg.evaluate(p => {
    const I = BF.inventory, c = I.chestState(p.x, p.y, p.z);
    return { owner: c.owner, title: [...document.querySelectorAll(".bf-inv h2")].map(h => h.textContent).find(t => /^Chest/.test(t)) || "", n: c.slots.reduce((s, x) => s + (x ? x.count : 0), 0) };
  }, p1.pos);
  console.log(JSON.stringify(r1), "unowned title:", p1.title0, "| after putting cobblestone:", r1.title);
  ok(/Unclaimed/.test(p1.title0) && r1.owner === "player" && /Yours/.test(r1.title) && r1.n === 10, "player claims an unowned chest by putting an item in");
  // someone else's chest
  const r2 = await pg.evaluate(p => {
    const I = BF.inventory; I.close();
    const c = I.chestState(p.x, p.y, p.z); c.owner = "test#99"; c.ownerName = "Aroha Parata";
    I.open("chest", p);
    return [...document.querySelectorAll(".bf-inv h2")].map(h => h.textContent).find(t => /^Chest/.test(t)) || "";
  }, p1.pos);
  await pg.keyboard.down('Shift'); await pg.click(slot('chest', 0), { force: true }); await pg.keyboard.up('Shift');
  await pg.click(slot('chest', 0), { force: true });
  const r3 = await pg.evaluate(p => { const I = BF.inventory, c = I.chestState(p.x, p.y, p.z); return { n: c.slots.reduce((s, x) => s + (x ? x.count : 0), 0), cursor: !!I.cursor, inv: I.count(BF.I.cobblestone) }; }, p1.pos);
  await pg.screenshot({ path: out + '-lookonly.png' });
  console.log("someone else's chest:", r2);
  ok(/Owned by Aroha Parata/.test(r2) && /look only/.test(r2) && r3.n === 10 && !r3.cursor && r3.inv === 0, "survival: another owner's chest can be viewed but not changed");
  const r4 = await pg.evaluate(p => { const I = BF.inventory; I.close(); BF.player.gameMode = "creative"; I.open("chest", p); return [...document.querySelectorAll(".bf-inv h2")].map(h => h.textContent).find(t => /^Chest/.test(t)) || ""; }, p1.pos);
  await pg.keyboard.down('Shift'); await pg.click(slot('chest', 0), { force: true }); await pg.keyboard.up('Shift');
  const r5 = await pg.evaluate(p => { const I = BF.inventory, c = I.chestState(p.x, p.y, p.z); I.close(); BF.player.gameMode = "survival"; return { n: c.slots.reduce((s, x) => s + (x ? x.count : 0), 0), owner: c.owner }; }, p1.pos);
  ok(!/look only/.test(r4) && r5.n === 0 && r5.owner === "test#99", "creative: any chest can be changed, the owner stays");

  // ---- 2. release after a day empty
  const t0 = await pg.evaluate(() => BF.sky.day + BF.sky.time);
  await step(0.2, 0.25, 3);
  await pg.evaluate(() => { BF.sky.day += 1; });
  await step(0.26, 0.27, 3);
  const r6 = await pg.evaluate(p => { const c = BF.inventory.chestState(p.x, p.y, p.z); const rec = BF.vlog.villageAt(p.x, p.z); return { owner: c.owner, log: rec ? BF.vlog.entries(rec.key).filter(e => e[1] === "chest").map(e => e[2]) : [] }; }, p1.pos);
  console.log("chest log:", r6.log);
  ok(r6.owner === null, "an owned chest empty for a day is unclaimed again (from day " + t0.toFixed(2) + ")");

  // ---- 3. a villager with a full inventory stores its surplus
  const v = await pg.evaluate(() => {
    const S = BF.storage, I = BF.inventory, T = BF.trades;
    const vs = BF.mobs.list.filter(m => m.type === "villager" && !m.dead && !m.child && m.inv && S.bedHouse(m));
    let pick = null, chest = null;
    for (const m of vs) {
      const H = S.bedHouse(m), b = m.bed, cs = S.chestsIn(H, b).filter(p => S.usable(p, S.keyOf(m)));
      // reachable from the bed floor
      const c = cs.find(p => Math.abs(p.y - b.y) <= 1);
      if (c) { pick = m; chest = c; break; }
    }
    const noChest = vs.filter(m => !S.chestsIn(S.bedHouse(m), m.bed).length && S.chestSpot(m));
    return { have: vs.length, key: pick && S.keyOf(pick), chest, noChestKeys: noChest.map(m => S.keyOf(m)) };
  });
  console.log("villagers with a bed house:", v.have, "| with a chest:", v.key, JSON.stringify(v.chest), "| without:", v.noChestKeys.length);
  if (v.key) {
    await pg.evaluate(k => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), T = BF.trades, I = BF.I;
      m.store = null;
      const old = m.inv.filter(Boolean).map(s => BF.itemName(s.id) + " x" + s.count);
      console.log("[test] before:", m.profession, old.join(", "));
      for (let i = 0; i < m.inv.length; i++) if (!m.inv[i]) m.inv[i] = { id: i % 3 ? I.rotten_flesh : I.cobblestone, count: 64 };
    }, v.key);
    pg.on('console', msg => { if (/^\[test\]/.test(msg.text())) console.log(msg.text()); });
    for (let k = 0; k < 4 && !(await pg.evaluate(p => { const c = BF.inventory.chestState(p.x, p.y, p.z); return !!(c && c.owner); }, v.chest)); k++) await step(0.1 + k * 0.05, 0.15 + k * 0.05, 30);
    const r7 = await pg.evaluate(([k, p]) => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), c = BF.inventory.chestState(p.x, p.y, p.z);
      return { free: m.inv.filter(s => !s).length, owner: c && c.owner, chest: c ? c.slots.filter(Boolean).map(s => BF.itemName(s.id) + " x" + s.count) : [],
        why: c && c.owner ? undefined : { leaving: m.ai.leaving, leaveEnd: m.ai.leaveEnd, store: m.store && { checkT: m.store.checkT, stage: m.store.stage, avoid: m.store.avoid, t: m.store.t }, d: Math.hypot(m.position.x - p.x, m.position.z - p.z), dy: m.position.y - p.y, status: BF.villagerStatus.text(m), route: m.ai.routeKind },
        inv: m.inv.filter(Boolean).map(s => BF.itemName(s.id) + " x" + s.count), log: BF.vlog.entries(m.village.key).filter(e => e[1] === "chest").slice(-4).map(e => e[2]) };
    }, [v.key, v.chest]);
    console.log(JSON.stringify(r7, null, 1));
    ok(r7.owner === v.key && r7.free >= BF_STORE_FREE(r7) && r7.chest.some(s => /Rotten Flesh|Cobblestone/.test(s)), "full villager claimed a house chest and stored its surplus");
    ok(!r7.inv.some(s => /Rotten Flesh/.test(s)), "junk went first");
    // withdraw: eat its food, leave bread in the chest
    await pg.evaluate(([k, p]) => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), I = BF.I;
      for (let i = 0; i < m.inv.length; i++) if (m.inv[i] && BF.food.isFood(m.inv[i].id)) m.inv[i] = null;
      if (m.life) m.life.sat = 0;
      BF.inventory.chestAdd(p.x, p.y, p.z, I.bread, 20);
      m.store.checkT = 0.1; m.store.stored = {};
    }, [v.key, v.chest]);
    await step(0.3, 0.4, 40);
    const r8 = await pg.evaluate(([k, p]) => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k);
      return { bread: BF.trades.inv.count(m.inv, BF.I.bread), log: BF.vlog.entries(m.village.key).filter(e => e[1] === "chest").slice(-2).map(e => e[2]) };
    }, [v.key, v.chest]);
    console.log(JSON.stringify(r8));
    ok(r8.bread > 0, "hungry villager fetched bread from its chest");
    // death frees its chests
    const r9 = await pg.evaluate(([k, p]) => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k);
      BF.mobs.kill(m);
      const c = BF.inventory.chestState(p.x, p.y, p.z);
      return { owner: c.owner, items: c.slots.filter(Boolean).length, log: BF.vlog.entries(m.village.key).filter(e => e[1] === "chest").slice(-1).map(e => e[2]) };
    }, [v.key, v.chest]);
    console.log(JSON.stringify(r9));
    ok(r9.owner === null && r9.items > 0, "a dead villager's chest is unclaimed, contents kept");
  } else console.log("SKIP no villager with a chest in its bed's house here");

  // ---- 4. ordering a chest from the furniture maker
  if (v.noChestKeys.length) {
    const r10 = await pg.evaluate(k => {
      BF.sky.day += 1;   // a new day: the steps above ran the clock to evening, and villagers keep their cool-downs in game time
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), I = BF.I, T = BF.trades;
      m.store = null;
      let f = m.village.members.find(o => o.profession === "furniture_maker" && !o.dead);
      if (!f) {   // this village has none: hire one for the test
        f = BF.mobs.spawn("villager", m.village.x + 0.5, m.village.y != null ? m.village.y : BF.world.heightAt(m.village.x, m.village.z) + 1, m.village.z + 0.5, "furniture_maker");
        f.village = m.village; f.slot = { house: null, idx: 1399, bed: null, prof: "furniture_maker" }; m.village.members.push(f);
        T.init(f);
      }
      if (T.inv.count(m.inv, I.emerald) < 1) T.inv.add(m.inv, I.emerald, 1);
      for (let i = 0; i < m.inv.length; i++) if (!m.inv[i]) m.inv[i] = { id: I.cobblestone, count: 64 };
      T.inv.add(f.inv, I.planks, 16);
      return { buyer: m.profession, em: T.inv.count(m.inv, I.emerald), fm: BF.storage.keyOf(f) };
    }, v.noChestKeys[0]);
    console.log("order test:", JSON.stringify(r10));
    for (let k = 0; k < 6 && !(await pg.evaluate(k => { const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k); return !!(m.store && m.store.order); }, v.noChestKeys[0])); k++)
      await step(0.1 + k * 0.004, 0.104 + k * 0.004, 10);   // the buyer notices it is full and orders a chest
    const r11 = await pg.evaluate(k => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), f = m.village.members.find(o => o.profession === "furniture_maker" && !o.dead);
      const had = BF.trades.inv.count(f.inv, BF.I.chest), p = BF.furniture.plan(f);
      if (p && p.kind === "chest") BF.furniture.craft(f, p);   // what it does at its bench
      return { order: m.store && m.store.order, plan: p, had, chests: BF.trades.inv.count(f.inv, BF.I.chest),
        why: m.store && m.store.order ? undefined : { leaving: m.ai.leaving, store: m.store && { checkT: m.store.checkT, stage: m.store.stage }, spot: BF.storage.chestSpot(m), status: BF.villagerStatus.text(m), free: m.inv.filter(x => !x).length } };
    }, v.noChestKeys[0]);
    console.log(JSON.stringify(r11));
    ok(!!r11.order && (r11.had > 0 || (r11.plan && r11.plan.kind === "chest")) && r11.chests >= 1, "full villager without a chest orders one; the furniture maker makes it from planks");
    if (!r11.order) return;
    const placed = () => pg.evaluate(([k, s]) => { const c = BF.inventory.chestState(s.x, s.y, s.z); return !!(c && c.owner === k); }, [v.noChestKeys[0], r11.order.spot]);
    for (let k = 0; k < 10 && !(await placed()); k++) {
      await step(0.13 + k * 0.03, 0.16 + k * 0.03, 30);
      if (process.env.DEBUG) console.log("fm@", JSON.stringify(await pg.evaluate(k => { const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), f = m.village.members.find(o => o.profession === "furniture_maker" && !o.dead); return { st: f.furn && f.furn.stage, kind: f.furn && f.furn.deal && f.furn.deal.kind, pos: [Math.round(f.position.x), Math.round(f.position.z)], status: BF.villagerStatus.text(f), chests: BF.trades.inv.count(f.inv, BF.I.chest), orders: BF.storage.orders(m.village).length, log: BF.furniture.LOG.slice(-2) }; }, v.noChestKeys[0])));
    }   // it walks over, puts the chest down; the villager stores its surplus there
    const r12 = await pg.evaluate(([k, o]) => {
      const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), s = o.spot, c = BF.inventory.chestState(s.x, s.y, s.z);
      return { block: BF.blocks[BF.world.getBlock(s.x, s.y, s.z)].name, owner: c && c.owner, free: m.inv.filter(x => !x).length, em: BF.trades.inv.count(m.inv, BF.I.emerald),
        status: BF.villagerStatus.text(m), log: BF.vlog.entries(m.village.key).filter(e => e[1] === "chest" || /Chest/.test(e[2])).slice(-5).map(e => e[2]) };
    }, [v.noChestKeys[0], r11.order]);
    console.log(JSON.stringify(r12, null, 1));
    ok(/^chest(_[new])?$/.test(r12.block) && r12.owner === v.noChestKeys[0], "the furniture maker delivered the chest and the villager claimed it", r12.block);
    await pg.evaluate(s => { const e = BF.player.eyePos(); BF.player.teleport(s.x + 2.5, s.y + 0.01, s.z + 0.5); }, r11.order.spot);
  } else console.log("SKIP no villager without a chest here");
};
// at least STORE_FREE (4) free slots after storing
function BF_STORE_FREE() { return 4; }
