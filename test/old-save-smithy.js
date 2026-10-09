// Worlds made in 1.0 keep their smithy chest where it was (bug-033): node test/run.js /tmp/os test/old-save-smithy.js
// 1.1 moved the generated smith chest in front of its crafting table for village generator 3. Generated blocks aren't saved, so a 1.0
// world (village generator 2) has to regenerate the 1.0 layout, or its saved chest contents end up under a crafting table.
// 1. A save written in the 1.0 format (seed 4242, gen 3, villages 2, 3 diamonds in the smithy chest at -8,1074,-47, the spot a real
//    1.0 build put it) loads with a chest at that spot holding the diamonds, and the crafting table one block toward the door.
// 2. A new world (village generator 3) still puts the smith chest in front of the table.
module.exports = async (pg, out) => {
  const ok = (cond, what) => console.log((cond ? "PASS " : "FAIL ") + what);
  const r = await pg.evaluate(async () => {
    BF.state.paused = true;
    const load = async (x, z) => {
      for (let i = 0; i < 600 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 400; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    };
    const name = (x, y, z) => BF.blocks[BF.world.getBlock(x, y, z)].name;
    // ---- 1. a 1.0 save, written straight into the browser's world store as 1.0 wrote it
    const id = "w10smithy", now = Date.now(), pos = [-8, 1074, -47];
    const meta = { id, name: "1.0 smithy", seed: 4242, gameMode: "creative", gen: 3, biomeScale: 1, villages: 2, created: now, lastPlayed: now };
    const slots = new Array(27).fill(null); slots[0] = { n: "diamond", c: 3 };
    const data = { version: 1, seed: 4242, gen: 3, biomeScale: 1, villages: 2, time: { t: 0.3, day: 2 }, spawn: null,
      player: { x: pos[0] + 0.5, y: pos[1] + 3, z: pos[2] + 3.5, yaw: 0, pitch: 0, health: 20, hunger: 20, gameMode: "creative" },
      inventory: { v: 1, slots: new Array(36).fill(null), selected: 0, furnaces: [], chests: [{ pos, slots }] }, edits: {} };
    const db = await new Promise((res, rej) => { const q = indexedDB.open("blockfield", 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res, rej) => { const t = db.transaction(["worlds", "data"], "readwrite"); t.objectStore("worlds").put(meta); t.objectStore("data").put(data, id); t.oncomplete = res; t.onerror = () => rej(t.error); });
    await BF.save.load(id);
    BF.state.paused = true;
    await load(pos[0], pos[2]);
    const c = BF.inventory.chestState(...pos), held = c ? c.slots.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count) : [];
    const b0 = BF.blocks[BF.world.getBlock(...pos)], [ox, oz] = b0.chestFacing != null ? BF.DIRS[b0.chestFacing] : [0, 0];   // the side the chest opens on
    const old = { villages: BF.state.villages, at: b0.name, front: name(pos[0] + ox, pos[1], pos[2] + oz), behind: name(pos[0] - ox, pos[1], pos[2] - oz), held };
    // ---- 2. a new world: the smith chest sits in front of its table
    await BF.save.create({ name: "new smithy", seed: 4242, gameMode: "creative" });
    BF.state.paused = true;
    const v = BF.worldgen.nearestVillage(0, 0), smiths = v.buildings.filter(b => b.type === "smith");
    const fresh = [];
    for (const b of smiths.slice(0, 2)) {
      await load((b.x0 + b.x1) >> 1, (b.z0 + b.z1) >> 1);
      for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) for (let y = b.y; y < b.y + 4; y++) {
        if (!BF.isChest(BF.world.getBlock(x, y, z))) continue;
        const f = BF.blocks[BF.world.getBlock(x, y, z)].chestFacing, [dx, dz] = BF.DIRS[f];
        fresh.push({ chest: [x, y, z], behindIsTable: BF.world.getBlock(x - dx, y, z - dz) === BF.B.crafting_table });
      }
    }
    return { old, fresh, villages3: BF.state.villages, smiths: smiths.length };
  });
  console.log(JSON.stringify(r));
  ok(r.old.villages === 2 && /chest/.test(r.old.at) && r.old.held.join() === "diamond x3", "1.0 save: the smithy chest is still a chest with its 3 diamonds");
  ok(r.old.front === "crafting_table" && !/chest/.test(r.old.behind), "1.0 save: the smithy keeps its 1.0 layout (its crafting table in front of the chest)");
  ok(r.villages3 === 3 && (r.smiths === 0 || (r.fresh.length > 0 && r.fresh.every(f => f.behindIsTable))), "new world: the smith chest sits in front of its crafting table");
};
