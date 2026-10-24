// @ci integration suite=items hosts=worker,server
// Closing or reloading the tab with a screen open keeps the items that were out of the inventory: the crafting grid
// and the cursor are saved and come back into the inventory on load (bug-002). On the world server the page's closing only pauses its
// world, held as it is (spec r15-41): picked again, it comes back with the screen still open on the page, grid and cursor as they were,
// and closing the screen then gives them back.
// Usage: node test/run.js /tmp/oss test/open-screen-save.js
module.exports = async (pg, out) => {
  const lib = require("./lib");
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const id = await pg.evaluate(async () => (await BF.save.create({ name: "open-screen-save", seed: 5, gameMode: "survival", villages: 9, gen: 4 })).id);
  await lib.simReady(pg);
  await lib.sim(pg, () => {   // (where the simulation is: spec r15-43)
    const I = BF.I, inv = BF.inventory;
    BF.mobs.spawning = false;
    inv.clear();
    inv.setSlot(0, { id: I.oak_log, count: 20 });
    inv.setSlot(1, { id: I.cobblestone, count: 30 });
    inv.setSlot(2, { id: I.iron_pickaxe, count: 1, wear: 77 });
    BF.proto.flush();
  });
  await settle();
  await pg.evaluate(() => BF.inventory.open("crafting"));
  await settle();
  await pg.evaluate(() => {
    const q = (c, i) => document.querySelector(`.bf-inv .bf-slot[data-c="${c}"][data-i="${i}"]`);
    const click = (el, button = 0, shift = false) => {
      const o = { bubbles: true, cancelable: true, button, shiftKey: shift, pointerType: "mouse", clientX: 10, clientY: 10 };
      el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o));
    };
    click(q("inv", 0)); click(q("grid", 4));   // logs into the crafting grid
    click(q("inv", 2)); click(q("grid", 0));   // a worn pickaxe too
    click(q("inv", 1));                        // cobblestone on the cursor
  });
  await settle();
  console.log("BEFORE " + JSON.stringify(await lib.sim(pg, () => { const I = BF.I, inv = BF.inventory; return { logs: inv.count(I.oak_log), cobble: inv.count(I.cobblestone), mode: inv.mode }; })));
  await pg.evaluate(() => BF.save.saveNow());   // what the pagehide / visibilitychange flush does
  await pg.reload();                           // the tab closes with the screen still open
  await lib.reloaded(pg);   // the host, then the planet's rivers, before the boot world starts (a load before then is wiped by it)
  await pg.waitForTimeout(1000);
  await pg.evaluate(id => BF.save.load(id), id);
  await settle(); await pg.waitForTimeout(1000); await settle();

  const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  if (lib.host() === "server") {
    const sc = await pg.evaluate(() => {
      const s = BF.client.self || {}, g = (s.screen && s.screen.grid || []).filter(Boolean).map(t => BF.items[t.id].name + "x" + t.count + (t.wear ? "w" + t.wear : "")).sort();
      return { mode: BF.inventory.mode, grid: g, cursor: s.cursor ? BF.items[s.cursor.id].name + "x" + s.cursor.count : null };
    });
    ok("the held world comes back with its crafting screen open, grid and cursor as they were", sc.mode === "crafting" && sc.grid.join() === "iron_pickaxex1w77,oak_logx20" && sc.cursor === "cobblestonex30", sc);
    await pg.evaluate(() => BF.inventory.close()); await settle();
  }
  const counts = () => lib.sim(pg, () => {
    const I = BF.I, inv = BF.inventory, pick = inv.slots.find(s => s && s.id === I.iron_pickaxe);
    return { logs: inv.count(I.oak_log), cobble: inv.count(I.cobblestone), pickWear: pick && pick.wear, mode: inv.mode, held: inv.serialize().held };
  });
  const got = await counts();
  ok("grid and cursor items are back in the inventory after reload" + (lib.host() === "server" ? " and the screen closed" : ""), got.logs === 20 && got.cobble === 30 && got.pickWear === 77 && !got.mode, got);
  // a later save with no screen open carries nothing extra, so nothing is duplicated
  await pg.evaluate(async id => { await BF.save.saveNow(); await BF.save.load(id); }, id);
  const again = await counts();
  ok("saving again does not duplicate them", again.logs === 20 && again.cobble === 30, again);
  // a save made with no screen open has no held items
  ok("no held list without an open screen", again.held === undefined);
  await pg.evaluate(id => BF.save.remove(id), id);
  for (const l of R) console.log(l);
};
