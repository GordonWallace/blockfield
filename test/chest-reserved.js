// @ci integration suite=village
// A chest a villager just paid the furniture maker for stays theirs (bug-037): node test/run.js /tmp/cr test/chest-reserved.js
// 1. Survival: the player can look into the delivered chest ("Reserved for <villager>") but can't put anything in, so can't claim it.
// 2. Creative: the player can change it, but it stays reserved for the villager, not the player's.
// 3. The reservation survives a save and load.
// 4. The villager who paid can still claim it; once the reservation runs out, the player can claim an empty unowned chest as before.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; });
  await require('./lib').toVillage(pg);
  const ok = (cond, what) => console.log((cond ? "PASS " : "FAIL ") + what);
  const slot = (c, i) => `.bf-slot[data-c="${c}"][data-i="${i}"]`;
  const title = () => pg.evaluate(() => [...document.querySelectorAll(".bf-inv h2")].map(h => h.textContent).find(t => /^Chest/.test(t)) || "");
  const putIn = async () => { await pg.keyboard.down('Shift'); await pg.click(slot('inv', 0) + ':visible', { force: true }); await pg.keyboard.up('Shift'); };

  // ---- a furniture maker delivers a chest a villager paid for
  const d = await pg.evaluate(() => {
    BF.mobs.spawning = false; BF.sky.day = 1; BF.sky.setTime(0.2);
    const S = BF.storage, T = BF.trades, I = BF.I;
    const vs = BF.mobs.list.filter(m => m.type === "villager" && !m.dead && !m.child && m.inv && S.keyOf(m) && S.bedHouse(m));
    const m = vs.find(m => !S.chestsIn(S.bedHouse(m), m.bed).length && S.chestSpot(m));
    if (!m) return { err: "no villager without a chest", n: vs.length };
    const f = BF.mobs.list.find(o => o.profession === "furniture_maker" && o !== m && o.inv && !o.dead) || BF.mobs.list.find(o => o.type === "villager" && o !== m && o.inv && !o.dead);   // 1.3 delivers only from a chest offer
    const spot = S.chestSpot(m);
    T.inv.add(m.inv, I.emerald, 3);
    m.store = m.store || { stage: null, checkT: 99, avoid: {}, stored: {}, order: null };
    m.store.order = { spot, until: BF.sky.day + BF.sky.time + 1 };
    T.inv.add(f.inv, I.chest, 1);
    const delivered = S.deliver(f, m, spot);
    window.__t = { key: S.keyOf(m), spot };
    BF.player.spawn(spot.x + 0.5, spot.y + 0.01, spot.z + 1.5);
    BF.inventory.clear(); BF.inventory.add(I.cobblestone, 1);
    BF.inventory.open("chest", spot);
    return { delivered, key: S.keyOf(m), spot };
  });
  console.log("delivered:", JSON.stringify(d));
  if (!d.delivered) { ok(false, "a furniture maker delivered a paid-for chest"); return; }

  // ---- 1. survival
  const t1 = await title();
  await putIn();
  const r1 = await pg.evaluate(() => {
    const { key, spot } = window.__t, c = BF.inventory.chestState(spot.x, spot.y, spot.z);
    return { owner: c.owner, reserved: c.reserved && c.reserved.key, items: c.slots.filter(Boolean).length, kept: BF.inventory.count(BF.I.cobblestone), usable: BF.storage.usable(spot, key) };
  });
  console.log("survival:", t1, JSON.stringify(r1));
  ok(/Reserved for/.test(t1) && /look only/.test(t1), "survival: the delivered chest shows who it's reserved for and is look-only");
  ok(r1.owner == null && r1.reserved === d.key && r1.items === 0 && r1.kept === 1 && r1.usable, "survival: putting an item in does nothing, so the player can't claim it");

  // ---- 2. creative (no look-only lock): changing the chest's contents doesn't make it the player's
  const t2 = await pg.evaluate(() => { BF.inventory.close(); BF.player.gameMode = "creative"; BF.inventory.open("chest", window.__t.spot);
    return [...document.querySelectorAll(".bf-inv h2")].map(h => h.textContent).find(t => /^Chest/.test(t)) || ""; });
  const r2 = await pg.evaluate(() => {
    const { key, spot } = window.__t, I = BF.inventory, c = I.chestState(spot.x, spot.y, spot.z);
    I.close(); BF.player.gameMode = "survival";
    c.slots[0] = { id: BF.I.cobblestone, count: 1 };
    const claimed = I.chestUsed(spot.x, spot.y, spot.z, "player", "you");
    const r = { claimed, owner: c.owner, reserved: c.reserved && c.reserved.key, usable: BF.storage.usable(spot, key) };
    c.slots[0] = null; I.chestUsed(spot.x, spot.y, spot.z, null);
    return r;
  });
  console.log("creative:", t2, JSON.stringify(r2));
  ok(!/look only/.test(t2) && !r2.claimed && r2.owner == null && r2.reserved === d.key && r2.usable, "creative: the player can change it, but it stays reserved for the villager");

  // ---- 3. save and load
  const r3 = await pg.evaluate(() => {
    const { key, spot } = window.__t, I = BF.inventory;
    I.deserialize(JSON.parse(JSON.stringify(I.serialize())));
    const c = I.chestState(spot.x, spot.y, spot.z);
    return { reserved: c && c.reserved && c.reserved.key, name: c && c.reserved && c.reserved.name, usableOther: BF.storage.usable(spot, "nobody#1"), usable: BF.storage.usable(spot, key) };
  });
  console.log("after save and load:", JSON.stringify(r3));
  ok(r3.reserved === d.key && r3.name && !r3.usableOther && r3.usable, "the reservation survives a save and load");

  // ---- 4. the villager claims it; an expired reservation no longer stops the player
  const r4 = await pg.evaluate(() => {
    const { key, spot } = window.__t, I = BF.inventory, c = I.chestState(spot.x, spot.y, spot.z);
    I.chestUsed(spot.x, spot.y, spot.z, key, "the villager");
    const villager = c.owner;
    // a second chest delivered to the same villager, left past its reservation
    c.owner = null; c.slots.fill(null); c.reserved = { key, until: BF.sky.day + BF.sky.time - 0.01, name: "the villager" };
    return { villager };
  });
  await pg.evaluate(() => { BF.inventory.clear(); BF.inventory.add(BF.I.cobblestone, 1); BF.inventory.open("chest", window.__t.spot); });
  const t4 = await title();
  await putIn();
  const r5 = await pg.evaluate(() => { const { spot } = window.__t, c = BF.inventory.chestState(spot.x, spot.y, spot.z); BF.inventory.close(); return { owner: c.owner }; });
  console.log("villager claim:", JSON.stringify(r4), "expired:", t4, JSON.stringify(r5));
  ok(r4.villager === d.key, "the villager who paid can claim its chest");
  ok(/Unclaimed/.test(t4) && r5.owner === "player", "once the reservation runs out, the player claims an empty unowned chest as before");
};
