// A worn tool keeps its wear wherever it is moved (bug-005): NODE_PATH=$(npm root -g) node test/run.js /tmp/tw test/tool-wear-moves.js
// Shift-click into a chest and back, a broken chest's drops, the chest API villagers use, the trade screen's payment slots and what a
// villager pays and sells, and villager-to-villager exchanges. A villager sells its least worn copy first.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(async () => {
    const res = {}, I = BF.I, B = BF.B, W = BF.world, P = BF.player, inv = BF.inventory, T = BF.trades;
    P.setGameMode("survival");
    const q = (c, i) => document.querySelector(`.bf-inv .bf-slot[data-c="${c}"][data-i="${i}"]`);
    const click = (el, button = 0, shift = false) => {
      const o = { bubbles: true, cancelable: true, button, shiftKey: shift, pointerType: "mouse", clientX: 10, clientY: 10 };
      el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o));
    };
    const wearOf = (arr, id) => { const s = arr.find(s => s && s.id === id); return s ? s.wear || 0 : "none"; };
    const px = Math.floor(P.position.x), py = Math.floor(P.position.y), pz = Math.floor(P.position.z);

    // shift-click a worn pickaxe into a chest and back out
    inv.clear(); BF.drops.clear();
    inv.setSlot(9, { id: I.iron_pickaxe, count: 1, wear: 200 });
    const cp = { x: px + 3, y: py, z: pz };
    W.setBlock(cp.x, cp.y, cp.z, B.chest);
    inv.open("chest", cp);
    click(q("inv", 9), 0, true);
    const cs = inv.chestState(cp.x, cp.y, cp.z);
    res.intoChest = wearOf(cs.slots, I.iron_pickaxe);
    click(q("chest", cs.slots.findIndex(Boolean)), 0, true);
    res.backOut = wearOf(inv.slots, I.iron_pickaxe);
    inv.close();

    // a broken chest drops the tool still worn
    cs.slots[0] = { id: I.iron_pickaxe, count: 1, wear: 200 };
    BF.drops.clear();
    W.setBlock(cp.x, cp.y, cp.z, 0);
    const d = BF.drops.list.find(d => d.id === I.iron_pickaxe);
    res.chestDrop = d ? d.wear : "none";

    // the chest API (villagers storing and taking their tools, js/storage.js)
    const ap = { x: px + 4, y: py, z: pz };
    W.setBlock(ap.x, ap.y, ap.z, B.chest);
    inv.chestAdd(ap.x, ap.y, ap.z, I.stone_axe, 1, 90);
    inv.chestAdd(ap.x, ap.y, ap.z, I.stone_axe, 1);
    res.apiStored = inv.chestState(ap.x, ap.y, ap.z).slots.filter(Boolean).map(s => s.wear || 0).sort((a, b) => a - b).join(",");
    res.apiTaken = inv.chestTakeStacks(ap.x, ap.y, ap.z, I.stone_axe, 2).map(s => s.wear || 0).sort((a, b) => a - b).join(",");
    W.setBlock(ap.x, ap.y, ap.z, 0);

    // trading a worn sword to a weaponsmith, then buying it back
    const v = T.init({ profession: "weaponsmith" });
    v.level = 5; v.inv = T.inv.create(); v.inv[0] = { id: I.emerald, count: 40 };
    v.trades = [T.parseTrade("1 diamond_sword > 6 emerald"), T.parseTrade("6 emerald > 1 diamond_sword")].map(o => Object.assign(o, { xp: 1 }));
    inv.clear(); BF.drops.clear();
    inv.setSlot(9, { id: I.diamond_sword, count: 1, wear: 1500 });
    inv.openTrade(v);
    document.querySelectorAll(".bf-offer")[0].click();
    res.paySlot = inv.slots.some(s => s && s.id === I.diamond_sword) ? "still in inventory" : "moved";
    click(q("tres", 0));
    inv.close();
    res.villagerGot = wearOf(v.inv, I.diamond_sword);
    res.playerEmeralds = inv.count(I.emerald);
    // buy it back: the result slot shows the wear and the bought sword keeps it
    inv.openTrade(v);
    document.querySelectorAll(".bf-offer")[1].click();
    const tip = q("tres", 0) && q("tres", 0).querySelector(".bf-wear");
    res.resultBar = tip && !tip.hidden ? "shown" : "hidden";
    click(q("tres", 0));
    const held = inv.cursor;
    res.boughtBack = held && held.id === I.diamond_sword ? held.wear || 0 : "none";
    inv.close();
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
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
  const want = { intoChest: 200, backOut: 200, chestDrop: 200, apiStored: "0,90", apiTaken: "0,90", paySlot: "moved", villagerGot: 1500, playerEmeralds: 6,
    resultBar: "shown", boughtBack: 1500, soldFirst: "0", soldNext: "900", buyerHas: 900 };
  for (const [k, v] of Object.entries(want)) console.log((r[k] === v ? "ok   " : "FAIL ") + k + ": " + JSON.stringify(r[k]) + (r[k] === v ? "" : " (want " + JSON.stringify(v) + ")"));
};
