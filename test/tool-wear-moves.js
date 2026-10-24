// A worn tool keeps its wear wherever it is moved (bug-005): NODE_PATH=$(npm root -g) node test/run.js /tmp/tw test/tool-wear-moves.js
// @ci integration suite=items hosts=worker,server
// Shift-click into a chest and back, a broken chest's drops, the chest API villagers use, the trade screen's payment slots and what a
// villager pays and sells, and villager-to-villager exchanges, including a villager buying a tool. A villager sells its least worn copy first.
module.exports = async (pg, out) => {
  const lib = require("./lib");
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(500);
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  // a click on one of the page's screen slots (a player request)
  const click = async (c, i, shift = false) => {
    await pg.evaluate(([c, i, shift]) => {
      const el = document.querySelector(`.bf-inv .bf-slot[data-c="${c}"][data-i="${i}"]`);
      const o = { bubbles: true, cancelable: true, button: 0, shiftKey: shift, pointerType: "mouse", clientX: 10, clientY: 10 };
      el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o));
    }, [c, i, shift]);
    await settle();
  };
  const sim = (fn, arg) => lib.sim(pg, fn, arg).then(async r => { await settle(); return r; });   // (where the simulation is: spec r15-43)
  const page = async (fn, arg) => { const r = await pg.evaluate(fn, arg); await settle(); return r; };
  const res = {};

  // shift-click a worn pickaxe into a chest and back out
  const cp = await sim(() => {
    const P = BF.player, inv = BF.inventory, cp = { x: Math.floor(P.position.x) + 3, y: Math.floor(P.position.y), z: Math.floor(P.position.z) };
    inv.clear(); BF.drops.clear();
    inv.setSlot(9, { id: BF.I.iron_pickaxe, count: 1, wear: 200 });
    BF.world.setBlock(cp.x, cp.y, cp.z, BF.B.chest);
    BF.proto.flush();
    return cp;
  });
  await page(cp => BF.inventory.open("chest", cp), cp);
  await click("inv", 9, true);
  const c1 = await lib.sim(pg, cp => { const s = BF.inventory.chestState(cp.x, cp.y, cp.z).slots, k = s.findIndex(Boolean); return { k, wear: k >= 0 && s[k].id === BF.I.iron_pickaxe ? s[k].wear || 0 : "none" }; }, cp);
  res.intoChest = c1.wear;
  await click("chest", c1.k, true);
  res.backOut = await lib.sim(pg, () => { const s = BF.inventory.slots.find(s => s && s.id === BF.I.iron_pickaxe); return s ? s.wear || 0 : "none"; });
  await page(() => BF.inventory.close());

  // a broken chest drops the tool still worn; the chest API (villagers storing and taking their tools, js/storage.js); a weaponsmith to
  // trade a worn sword to (made by hand: the trade screen asks for its villager by id, spec r15-44)
  const tid = await sim(cp => {
    const res = {}, I = BF.I, B = BF.B, W = BF.world, inv = BF.inventory, T = BF.trades;
    const cs = inv.chestState(cp.x, cp.y, cp.z);
    cs.slots[0] = { id: I.iron_pickaxe, count: 1, wear: 200 };
    BF.drops.clear();
    W.setBlock(cp.x, cp.y, cp.z, 0);
    const d = BF.drops.list.find(d => d.id === I.iron_pickaxe);
    res.chestDrop = d ? d.wear : "none";
    const ap = { x: cp.x + 1, y: cp.y, z: cp.z };
    W.setBlock(ap.x, ap.y, ap.z, B.chest);
    inv.chestAdd(ap.x, ap.y, ap.z, I.stone_axe, 1, 90);
    inv.chestAdd(ap.x, ap.y, ap.z, I.stone_axe, 1);
    res.apiStored = inv.chestState(ap.x, ap.y, ap.z).slots.filter(Boolean).map(s => s.wear || 0).sort((a, b) => a - b).join(",");
    res.apiTaken = inv.chestTakeStacks(ap.x, ap.y, ap.z, I.stone_axe, 2).map(s => s.wear || 0).sort((a, b) => a - b).join(",");
    W.setBlock(ap.x, ap.y, ap.z, 0);
    const v = T.init({ profession: "weaponsmith" });
    v.level = 5; v.inv = T.inv.create(); v.inv[0] = { id: I.emerald, count: 40 };
    v.trades = [T.parseTrade("1 diamond_sword > 6 emerald"), T.parseTrade("6 emerald > 1 diamond_sword")].map(o => Object.assign(o, { xp: 1 }));
    globalThis.__twmV = v;
    res.id = BF.ids.idOf(v);
    inv.clear(); BF.drops.clear();
    inv.setSlot(9, { id: I.diamond_sword, count: 1, wear: 1500 });
    BF.proto.flush();
    return res;
  }, cp);
  Object.assign(res, tid); delete res.id;
  const offer = async k => {
    await page(id => BF.inventory.openTrade(id), tid.id);
    await pg.waitForFunction(k => document.querySelectorAll(".bf-offer").length > k, k, { timeout: 15000, polling: 100 });
    await page(k => document.querySelectorAll(".bf-offer")[k].click(), k);
  };
  // trading a worn sword to the weaponsmith, then buying it back
  await offer(0);
  res.paySlot = await lib.sim(pg, () => BF.inventory.slots.some(s => s && s.id === BF.I.diamond_sword) ? "still in inventory" : "moved");
  await click("tres", 0);
  await page(() => BF.inventory.close());
  Object.assign(res, await lib.sim(pg, () => { const s = globalThis.__twmV.inv.find(s => s && s.id === BF.I.diamond_sword); return { villagerGot: s ? s.wear || 0 : "none", playerEmeralds: BF.inventory.count(BF.I.emerald) }; }));
  // buy it back: the result slot shows the wear and the bought sword keeps it
  await offer(1);
  res.resultBar = await pg.evaluate(() => { const el = document.querySelector('.bf-inv .bf-slot[data-c="tres"][data-i="0"]'), tip = el && el.querySelector(".bf-wear"); return tip && !tip.hidden ? "shown" : "hidden"; });
  await click("tres", 0);
  res.boughtBack = await pg.evaluate(() => { const held = BF.inventory.cursor; return held && held.id === BF.I.diamond_sword ? held.wear || 0 : "none"; });
  await page(() => BF.inventory.close());

  Object.assign(res, await lib.sim(pg, () => {
    const res = {}, I = BF.I, T = BF.trades, v = globalThis.__twmV;
    const wearOf = (arr, id) => { const s = arr.find(s => s && s.id === id); return s ? s.wear || 0 : "none"; };
    // a villager with a fresh and a worn copy sells the fresh one first
    v.inv[1] = { id: I.diamond_sword, count: 1, wear: 900 }; v.inv[2] = { id: I.diamond_sword, count: 1 };
    const sold = T.exchange(v, v.trades[1]);
    res.soldFirst = sold.map(s => s.wear || 0).join(",");
    const sold2 = T.exchange(v, v.trades[1]);
    res.soldNext = sold2.map(s => s.wear || 0).join(",");
    // a villager buyer keeps the wear (inv.addStacks)
    const buyer = T.inv.create();
    T.inv.addStacks(buyer, sold2);
    res.buyerHas = wearOf(buyer, I.diamond_sword);
    // a farmer buying a hoe from the toolsmith gets it as worn as it was (js/villagelife.js doToolDeal)
    const smith = { type: "villager", profession: "toolsmith", inv: T.inv.create(), trades: [Object.assign(T.parseTrade("1 emerald > 1 iron_hoe"), { xp: 1 })], position: { x: 0, y: 0, z: 0 } };
    smith.level = 5; smith.inv[0] = { id: I.iron_hoe, count: 1, wear: 70 };
    const farmer = { type: "villager", profession: "farmer", inv: T.inv.create(), position: { x: 0, y: 0, z: 0 } };
    farmer.inv[0] = { id: I.emerald, count: 3 };
    const got = BF.villageLife._test.doToolDeal(farmer, { kind: "tool", seller: smith, offer: smith.trades[0], item: I.iron_hoe });
    res.farmerHoe = got ? wearOf(farmer.inv, I.iron_hoe) : "no deal";
    delete globalThis.__twmV;
    return res;
  }));
  const r = res;
  console.log(JSON.stringify(r, null, 1));
  const want = { intoChest: 200, backOut: 200, chestDrop: 200, apiStored: "0,90", apiTaken: "0,90", paySlot: "moved", villagerGot: 1500, playerEmeralds: 6,
    resultBar: "shown", boughtBack: 1500, soldFirst: "0", soldNext: "900", buyerHas: 900,
    farmerHoe: 70 };
  for (const [k, v] of Object.entries(want)) console.log((r[k] === v ? "ok   " : "FAIL ") + k + ": " + JSON.stringify(r[k]) + (r[k] === v ? "" : " (want " + JSON.stringify(v) + ")"));
};
