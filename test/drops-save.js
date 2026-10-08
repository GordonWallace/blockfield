// @ci integration
// Dropped items survive a save and load, keep their age (so they still despawn on time), and wait in an unloaded chunk
// instead of ageing or falling out of the world. Usage: node test/run.js /tmp/ds test/drops-save.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) BF.drops.update(h); };
    const load = async (x, z) => {
      BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
      for (let i = 0; i < 400 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 300; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    };
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    const px = 8, pz = 8;
    await load(px, pz);
    const cobble = BF.I.cobblestone, dirt = BF.I.dirt;
    const gx = px + 4, gz = pz + 4, gy = BF.worldgen.heightAt(gx, gz);
    // put the player out of pickup range of the drops
    BF.player.teleport(px - 20.5, BF.worldgen.heightAt(px - 21, pz) + 2, pz + 0.5);
    const a = BF.drops.spawn(cobble, 5, gx + 0.5, gy + 2, gz + 0.5), b = BF.drops.spawn(dirt, 3, gx + 3.5, gy + 2, gz + 0.5);
    run(100);
    ok("two drops lying on the ground", BF.drops.list.length === 2 && a.vel.y === 0, BF.drops.list.map(d => [d.id, d.count, d.pos.y]));
    const before = BF.drops.list.map(d => ({ id: d.id, count: d.count, x: d.pos.x, y: d.pos.y, z: d.pos.z, age: d.age }));
    const saved = JSON.parse(JSON.stringify(BF.drops.serialize()));
    ok("the save lists them with their age", saved.length === 2 && saved.every(e => e[5] >= 99), saved);
    // reload: a fresh world, then the saved drops, before the chunk has loaded again
    BF.newWorld(1, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    ok("new world has no drops", BF.drops.list.length === 0);
    BF.drops.deserialize(saved);
    BF.player.teleport(px - 20.5, BF.worldgen.heightAt(px - 21, pz) + 2, pz + 0.5);
    run(30);   // chunk not loaded yet: they wait
    const after = BF.drops.list.map(d => ({ id: d.id, count: d.count, x: d.pos.x, y: d.pos.y, z: d.pos.z, age: d.age }));
    ok("restored before the chunk loads, not fallen, not aged", after.length === 2 && after.every((d, i) => d.id === before[i].id && d.count === before[i].count && Math.abs(d.y - before[i].y) < 0.02 && Math.abs(d.age - before[i].age) < 0.02), { before, after });
    await load(px - 21, pz);
    run(5);
    const still = BF.drops.list.map(d => ({ y: d.pos.y, age: d.age }));
    ok("after the chunk loads they stay put and age again", still.length === 2 && still.every((d, i) => Math.abs(d.y - before[i].y) < 0.05 && d.age > before[i].age + 4), { before, still });
    // walk away so the chunk unloads: the drops wait instead of falling out of the world
    await load(1500, 1500);
    for (let k = 0; k < 20; k++) { BF.world.update(1500, 1500, 8); await new Promise(r => setTimeout(r, 0)); }
    const unloaded = !BF.world.isLoaded(gx, gz);
    run(400);
    ok("in an unloaded chunk they neither despawn nor fall", unloaded && BF.drops.list.length === 2, { unloaded, n: BF.drops.list.length });
    await load(px - 21, pz);
    run(300 - Math.max(...BF.drops.list.map(d => d.age)) + 1);
    ok("they despawn once their 300s are up in a loaded chunk", BF.drops.list.length === 0, BF.drops.list.map(d => d.age));
    // old saves have no drops
    BF.drops.deserialize(undefined);
    ok("old saves: no drops, no error", BF.drops.list.length === 0);
    // the real save: through IndexedDB and BF.save.load
    const meta = await BF.save.create({ name: "drops", seed: 1, gameMode: "creative" });
    BF.mobs.spawning = false;
    await load(px - 21, pz);
    BF.drops.spawn(cobble, 7, gx + 0.5, gy + 2, gz + 0.5);
    run(20);
    await BF.save.saveNow();
    BF.drops.clear();
    await BF.save.load(meta.id);
    const got = BF.drops.list.map(d => [d.id, d.count, Math.round(d.age)]);
    ok("saved and loaded through IndexedDB", got.length === 1 && got[0][0] === cobble && got[0][1] === 7 && got[0][2] === 20, got);
    await BF.save.remove(meta.id);
    return R;
  });
  for (const l of res.lines) console.log(l);
};
