// @ci integration suite=items
// Items that don't fit back in a full inventory drop on the ground instead of vanishing: the crafting grid, the cursor
// and trade payment slots when a screen closes, a broken furnace's contents, and a map made from a stack of blank maps.
// Usage: node test/run.js /tmp/fid test/full-inventory-drops.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, B = BF.B, P = BF.player, inv = BF.inventory;
    P.setGameMode("survival");
    BF.mobs.spawning = false;
    const q = (c, i) => document.querySelector(`.bf-inv .bf-slot[data-c="${c}"][data-i="${i}"]`);
    const click = (el, button = 0, shift = false) => {
      const o = { bubbles: true, cancelable: true, button, shiftKey: shift, pointerType: "mouse", clientX: 10, clientY: 10 };
      el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o));
    };
    const dropped = id => BF.drops.list.filter(d => d.id === id).reduce((s, d) => s + d.count, 0);
    const fill = id => { for (let i = 0; i < 36; i++) inv.setSlot(i, { id, count: 64 }); };

    // the bug report's steps: logs in the 2x2 grid, planks into the freed slot, close
    BF.drops.clear(); inv.clear(); fill(I.cobblestone);
    inv.setSlot(5, { id: I.oak_log, count: 64 });
    inv.open("inventory");
    click(q("inv", 5)); click(q("grid", 0));
    click(q("result", 0)); click(q("inv", 5));
    inv.close();
    ok("logs left in the crafting grid drop at the player's feet", inv.count(I.oak_log) + dropped(I.oak_log) === 63, { inv: inv.count(I.oak_log), dropped: dropped(I.oak_log) });
    const d = BF.drops.list.find(d => d.id === I.oak_log);
    ok("the dropped stack is next to the player and can't be picked up at once", d && d.pos.distanceTo(P.position) < 3 && d.pickupDelay >= 1.5, d && { dist: d.pos.distanceTo(P.position), delay: d.pickupDelay });

    // a worn tool held on the cursor when the screen closes
    BF.drops.clear(); inv.clear(); fill(I.dirt);
    inv.setSlot(0, { id: I.iron_pickaxe, count: 1, wear: 120 });
    inv.open("inventory"); click(q("inv", 0));
    inv.setSlot(0, { id: I.dirt, count: 64 });
    inv.close();
    const pick = BF.drops.list.find(d => d.id === I.iron_pickaxe);
    ok("a tool on the cursor drops, keeping its wear", pick && pick.wear === 120, pick && { wear: pick.wear });

    // a furnace broken with a full inventory
    BF.drops.clear(); inv.clear(); fill(I.dirt);
    const px = Math.floor(P.position.x) + 2, py = Math.floor(P.position.y), pz = Math.floor(P.position.z);
    const f = inv.furnaceRecord(px, py, pz);
    f.slots = [{ id: I.iron_ore, count: 5 }, { id: I.coal, count: 7 }, { id: I.iron_ingot, count: 3 }];
    BF.emit("blockBroken", px, py, pz, B.furnace);
    ok("a broken furnace's contents drop where it stood", dropped(I.iron_ore) === 5 && dropped(I.coal) === 7 && dropped(I.iron_ingot) === 3,
      { ore: dropped(I.iron_ore), coal: dropped(I.coal), ingot: dropped(I.iron_ingot) });

    // one blank map from a stack, full inventory
    if (I.blank_map_1 != null && BF.maps) {
      BF.drops.clear(); inv.clear(); fill(I.cobblestone);
      inv.setSlot(0, { id: I.blank_map_1, count: 3 }); inv.select(0);
      BF.maps.use(inv.slots[0], BF.items[I.blank_map_1]);
      const maps = BF.drops.list.filter(d => BF.items[d.id].map).length + inv.slots.filter(s => s && BF.items[s.id].map).length;
      ok("a map made from a stack drops when there is no room", inv.count(I.blank_map_1) === 2 && maps === 1, { blanks: inv.count(I.blank_map_1), maps });
    }
    inv.clear(); BF.drops.clear();
    return R;
  });
  for (const l of res.lines) console.log(l);
};
