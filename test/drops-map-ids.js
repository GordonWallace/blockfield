// @ci integration suite=items
// A filled or auto map lying on the ground is the same map after a page reload (bug-003): drops are saved by item name,
// since map item ids are handed out fresh each session. Usage: node test/run.js /tmp/dmi test/drops-map-ids.js
module.exports = async (pg, out) => {
  const id = await pg.evaluate(async () => {
    const meta = await BF.save.create({ name: "drops-map-ids", seed: 7, gameMode: "survival" });
    BF.mobs.spawning = false;
    const A = BF.resolveItem("filled_map_1_0_0"), B = BF.resolveItem("filled_map_1_5_5"), C = BF.resolveItem("auto_map_2_3_-4");
    const p = BF.player.position;
    BF.inventory.clear();
    BF.inventory.setSlot(0, { id: B, count: 1 });
    BF.drops.clear();
    const still = { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 999 };
    BF.drops.spawn(A, 1, p.x + 20, p.y + 5, p.z + 20, still);
    BF.drops.spawn(C, 1, p.x + 22, p.y + 5, p.z + 20, still);
    BF.drops.spawn(BF.I.cobblestone, 9, p.x + 24, p.y + 5, p.z + 20, still);
    await BF.save.saveNow();
    return meta.id;
  });
  await pg.reload();
  await pg.waitForTimeout(6000);
  const res = await pg.evaluate(async id => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    // a map made this session takes the first dynamic id, as map B would have when the inventory loads first
    BF.resolveItem("filled_map_2_9_9");
    await BF.save.load(id);
    const names = BF.drops.list.map(d => BF.items[d.id] ? BF.items[d.id].name + "x" + d.count : "unknown " + d.id).sort();
    ok("the dropped maps and the cobblestone are the same items after reload", JSON.stringify(names) === JSON.stringify(["auto_map_2_3_-4x1", "cobblestonex9", "filled_map_1_0_0x1"]), names);
    ok("the inventory still holds map B", BF.inventory.slots[0] && BF.items[BF.inventory.slots[0].id].name === "filled_map_1_5_5");
    // old saves stored numeric ids: fixed items still load, map ids (meaningless in a new session) are skipped
    BF.drops.clear();
    BF.drops.deserialize([[BF.I.cobblestone, 3, 0, 80, 0, 1, 0, 0], [BF.ITEM_BASE + 0x10000 + 1, 1, 0, 80, 0, 1, 0, 0]]);
    ok("old numeric saves: fixed items load, map ids are dropped", BF.drops.list.length === 1 && BF.drops.list[0].id === BF.I.cobblestone, BF.drops.list.map(d => d.id));
    BF.drops.clear();
    await BF.save.remove(id);
    return R;
  }, id);
  for (const l of res.lines) console.log(l);
};
