// @ci integration
// Closing or reloading the tab with a screen open keeps the items that were out of the inventory: the crafting grid
// and the cursor are saved and come back into the inventory on load (bug-002).
// Usage: node test/run.js /tmp/oss test/open-screen-save.js
module.exports = async (pg, out) => {
  const id = await pg.evaluate(async () => {
    const I = BF.I, inv = BF.inventory;
    const q = (c, i) => document.querySelector(`.bf-inv .bf-slot[data-c="${c}"][data-i="${i}"]`);
    const click = (el, button = 0, shift = false) => {
      const o = { bubbles: true, cancelable: true, button, shiftKey: shift, pointerType: "mouse", clientX: 10, clientY: 10 };
      el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o));
    };
    const meta = await BF.save.create({ name: "open-screen-save", seed: 5, gameMode: "survival" });
    BF.mobs.spawning = false;
    inv.clear();
    inv.setSlot(0, { id: I.oak_log, count: 20 });
    inv.setSlot(1, { id: I.cobblestone, count: 30 });
    inv.setSlot(2, { id: I.iron_pickaxe, count: 1, wear: 77 });
    inv.open("crafting");
    click(q("inv", 0)); click(q("grid", 4));   // logs into the crafting grid
    click(q("inv", 2)); click(q("grid", 0));   // a worn pickaxe too
    click(q("inv", 1));                        // cobblestone on the cursor
    console.log("BEFORE " + JSON.stringify({ logs: inv.count(I.oak_log), cobble: inv.count(I.cobblestone), mode: inv.mode }));
    await BF.save.saveNow();                   // what the pagehide / visibilitychange flush does
    return meta.id;
  });
  await pg.reload();                           // the tab closes with the screen still open
  await pg.waitForTimeout(6000);
  const res = await pg.evaluate(async id => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, inv = BF.inventory;
    await BF.save.load(id);
    const pick = inv.slots.find(s => s && s.id === I.iron_pickaxe);
    const got = { logs: inv.count(I.oak_log), cobble: inv.count(I.cobblestone), pickWear: pick && pick.wear, mode: inv.mode };
    ok("grid and cursor items are back in the inventory after reload", got.logs === 20 && got.cobble === 30 && got.pickWear === 77 && !got.mode, got);
    // a later save with no screen open carries nothing extra, so nothing is duplicated
    await BF.save.saveNow();
    await BF.save.load(id);
    const again = { logs: inv.count(I.oak_log), cobble: inv.count(I.cobblestone) };
    ok("saving again does not duplicate them", again.logs === 20 && again.cobble === 30, again);
    // a save made with no screen open has no held items
    ok("no held list without an open screen", inv.serialize().held === undefined);
    await BF.save.remove(id);
    return R;
  }, id);
  for (const l of res.lines) console.log(l);
};
