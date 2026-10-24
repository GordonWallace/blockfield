// @ci integration suite=items hosts=worker,server
// Items that don't fit back in a full inventory drop on the ground instead of vanishing: the crafting grid, the cursor
// and trade payment slots when a screen closes, a broken furnace's contents, and a map made from a stack of blank maps.
// Usage: node test/run.js /tmp/fid test/full-inventory-drops.js
module.exports = async (pg, out) => {
  const lib = require("./lib");
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(500);
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  // the page's screens, with clicks dispatched on their slots ([[c, i], ...]); each click is a player request
  const screen = async (m, clicks) => {
    await pg.evaluate(m => BF.inventory.open(m), m); await settle();
    await pg.evaluate(list => {
      const click = el => {
        const o = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", clientX: 10, clientY: 10 };
        el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o));
      };
      for (const [c, i] of list) click(document.querySelector(`.bf-inv .bf-slot[data-c="${c}"][data-i="${i}"]`));
    }, clicks);
    await settle();
  };
  const close = async () => { await pg.evaluate(() => BF.inventory.close()); await settle(); };
  // in the simulation (spec r15-43): fill(id) fills all 36 slots
  const sim = (fn, arg) => lib.sim(pg, fn, arg).then(async r => { await settle(); return r; });
  const prep = (id, extra) => sim(([id, extra]) => {
    BF.mobs.spawning = false; BF.drops.clear(); BF.inventory.clear();
    for (let i = 0; i < 36; i++) BF.inventory.setSlot(i, { id: BF.I[id], count: 64 });
    for (const [i, n, c, w] of extra) BF.inventory.setSlot(i, w ? { id: BF.I[n], count: c, wear: w } : { id: BF.I[n], count: c });
    BF.proto.flush();
  }, [id, extra]);
  const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));

  // the bug report's steps: logs in the 2x2 grid, planks into the freed slot, close
  await prep("cobblestone", [[5, "oak_log", 64]]);
  await screen("inventory", [["inv", 5], ["grid", 0], ["result", 0], ["inv", 5]]);
  await close();
  const a = await lib.sim(pg, () => {
    const I = BF.I, d = BF.drops.list.find(d => d.id === I.oak_log), P = BF.player;
    return { inv: BF.inventory.count(I.oak_log), dropped: BF.drops.list.filter(d => d.id === I.oak_log).reduce((s, d) => s + d.count, 0), dist: d && d.pos.distanceTo(P.position), delay: d && d.pickupDelay };
  });
  ok("logs left in the crafting grid drop at the player's feet", a.inv + a.dropped === 63, { inv: a.inv, dropped: a.dropped });
  ok("the dropped stack is next to the player and can't be picked up at once", a.dist < 3 && a.delay >= 1.5, { dist: a.dist, delay: a.delay });

  // a worn tool held on the cursor when the screen closes
  await prep("dirt", [[0, "iron_pickaxe", 1, 120]]);
  await screen("inventory", [["inv", 0]]);
  await sim(() => { BF.inventory.setSlot(0, { id: BF.I.dirt, count: 64 }); });
  await close();
  const pick = await lib.sim(pg, () => { const d = BF.drops.list.find(d => d.id === BF.I.iron_pickaxe); return d ? { wear: d.wear } : null; });
  ok("a tool on the cursor drops, keeping its wear", pick && pick.wear === 120, pick);

  // a furnace broken with a full inventory; one blank map from a stack, full inventory
  await prep("dirt", []);
  const r = await lib.sim(pg, () => {
    const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, B = BF.B, P = BF.player, inv = BF.inventory;
    const dropped = id => BF.drops.list.filter(d => d.id === id).reduce((s, d) => s + d.count, 0);
    const fill = id => { for (let i = 0; i < 36; i++) inv.setSlot(i, { id, count: 64 }); };
    const px = Math.floor(P.position.x) + 2, py = Math.floor(P.position.y), pz = Math.floor(P.position.z);
    const f = inv.furnaceRecord(px, py, pz);
    f.slots = [{ id: I.iron_ore, count: 5 }, { id: I.coal, count: 7 }, { id: I.iron_ingot, count: 3 }];
    BF.emit("blockBroken", px, py, pz, B.furnace);
    ok("a broken furnace's contents drop where it stood", dropped(I.iron_ore) === 5 && dropped(I.coal) === 7 && dropped(I.iron_ingot) === 3,
      { ore: dropped(I.iron_ore), coal: dropped(I.coal), ingot: dropped(I.iron_ingot) });
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
  for (const l of [...R, ...r]) console.log(l);
};
