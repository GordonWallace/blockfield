// @ci integration suite=world timeout=400
// The chunks just past the view distance (bug-092): they are generated only as data for meshing the edge chunks inside it, and once
// those are drawn they go again, so no thin ring of loaded chunks (with mobs on it) is left around the 12-chunk block-data disc. The
// chunks left behind after a move keep only their meshes too.
// node test/run.js /tmp/cbr test/chunk-border-ring.js
module.exports = async (pg) => {
  await pg.setViewportSize({ width: 320, height: 200 });
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await require('./lib').ready(pg);
  await pg.evaluate(() => { BF.world.setViewDist(15); BF.player.start(); BF.player.setGameMode("creative"); });
  // once loading is done: loaded chunks (block data) further than 15.2 chunks from the player (past the purge's KEEP + 3), other than
  // the ones running villages keep, and the chunks drawn
  const count = () => pg.evaluate(async () => {
    await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < 400 && BF.world.queueLength > 0; i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 1500));
    const W = BF.world, CS = BF.CS, p = BF.player.position, keep = BF.villageSim ? BF.villageSim.keepKeys : new Set();
    const pc = { x: Math.floor(p.x / CS) * CS + 8, z: Math.floor(p.z / CS) * CS + 8 };
    let drawn = W.farMeshes.size;
    const far = [];
    for (const [k, c] of W.chunks) {
      if (c.mesh) drawn++;
      if (keep.has(k)) continue;
      const t = BF.planet.toward(pc, { x: c.cx * CS + 8, z: c.cz * CS + 8 }), d = Math.hypot(t.x, t.z) / CS;
      if (d > 15.2) far.push(k + " at " + d.toFixed(2) + " mesh " + c.mesh);
    }
    return { far, drawn, queue: W.queueLength };
  });
  let r = await count();
  check(r.queue === 0, "loading finished");
  check(r.drawn > 600, "the view distance is drawn (" + r.drawn + " chunks)");
  check(r.far.length === 0, "no loaded chunks left past the block-data range: " + r.far.slice(0, 6).join(", "));
  // after moving 3 chunks east, the new edge's border chunks go too, and the chunks left behind keep only their meshes
  await pg.evaluate(() => { const p = BF.player.position; BF.player.setFlying(true); BF.player.teleport(p.x + 48, p.y + 2, p.z); });
  r = await count();
  check(r.far.length === 0, "none after moving either: " + r.far.slice(0, 6).join(", "));
  if (bad) throw new Error(bad + " check(s) failed");
};
