// @ci integration suite=world timeout=600
// Batched chunk remeshing during fast-forward (spec r15-02): with the player above the boot world's village (59 villagers) at 1000x for
// 20 real seconds, chunks outside the player's 3x3 are remeshed at most every 5 s (2 s at 100x, 400 ms at 10x), so few frames remesh more than 2 far chunks. Checks:
//  - frames remeshing more than 2 far chunks are under 10%;
//  - a block the player breaks at 1000x is meshed the same frame;
//  - after dropping to 1x, no chunk stays dirty after one frame.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/ffr test/ff-remesh.js
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  const setup = await pg.evaluate(() => {
    try { BF.player.start(); } catch (e) { console.log("start failed", e.message); }
    if (BF.player.setGameMode) BF.player.setGameMode("creative");
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 2000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (!v) return null;
    BF.player.spawn(v.x + 0.5, BF.worldgen.heightAt(v.x, v.z) + 30, v.z + 0.5);
    if (BF.player.setFlying) BF.player.setFlying(true);
    // each world.update call: this frame's remesh counts and the dirty chunks it left
    const W = BF.world, up = W.update, F = window.__ffr = { frames: [], on: false };
    W.update = function () { const r = up.apply(this, arguments); if (F.on) F.frames.push({ ...W.lastRemesh, dirty: W._dirty.size, warp: BF.warp.speed }); return r; };
    return { village: [v.x, v.z] };
  });
  ok("found the boot village", !!setup, setup);
  if (!setup) { console.log("FAILED: 1"); return; }
  for (let i = 0; i < 40; i++) { await pg.waitForTimeout(1500); if (await pg.evaluate(() => BF.world.queueLength === 0)) break; }
  await pg.evaluate(() => { BF.state.paused = false; BF.warp.set(BF.warp.SPEEDS.length - 1); });
  await pg.waitForTimeout(3000);   // the village's first burst of work
  await pg.evaluate(() => { __ffr.frames = []; __ffr.on = true; });
  await pg.waitForTimeout(20000);
  const ff = await pg.evaluate(() => {
    const f = __ffr.frames.filter(x => x.warp >= 10);
    return { frames: f.length, over2: f.filter(x => x.far > 2).length, far: f.reduce((s, x) => s + x.far, 0), held: f.reduce((s, x) => s + x.held, 0), maxFar: Math.max(0, ...f.map(x => x.far)) };
  });
  console.log("FF " + JSON.stringify(ff));
  ok("ran frames at 1000x", ff.frames >= 20, ff);
  ok("the village dirtied far chunks (something to batch)", ff.far + ff.held > 0, ff);
  ok("frames remeshing more than 2 far chunks are under 10%", ff.over2 < 0.1 * ff.frames, ff);

  // the player breaks a block at 1000x: its chunk is meshed by the next world.update
  const brk = await pg.evaluate(async () => {
    const W = BF.world, p = BF.player.position, x = Math.floor(p.x), z = Math.floor(p.z);
    let y = Math.floor(p.y);
    while (y > BF.MIN_Y && !W.getBlock(x, y, z)) y--;
    const c = W.chunkAt ? W.chunkAt(x, z) : null;
    const n0 = __ffr.frames.length;
    W.setBlock(x, y, z, 0);
    const key = [...W._dirty].find(k => { const ch = W.chunks.get(k); return ch && x >= ch.cx * 16 && x < ch.cx * 16 + 16 && z >= ch.cz * 16 && z < ch.cz * 16 + 16; });
    while (__ffr.frames.length === n0) await new Promise(r => requestAnimationFrame(r));
    return { warp: BF.warp.speed, at: [x, y, z], key: key || (c && c.key), dirtyAfter: !!(key && W._dirty.has(key)), near: __ffr.frames[n0].near };
  });
  ok("a block broken at 1000x is meshed the same frame", brk.warp >= 10 && !!brk.key && !brk.dirtyAfter && brk.near >= 1, brk);

  // drop to 1x: the first world.update after it leaves nothing dirty
  const drop = await pg.evaluate(async () => {
    const before = BF.world._dirty.size;
    BF.warp.set(0);
    const n0 = __ffr.frames.length;
    while (__ffr.frames.length === n0) await new Promise(r => requestAnimationFrame(r));
    return { dirtyBefore: before, after: __ffr.frames[n0] };
  });
  ok("after dropping to 1x no chunk stays dirty after one frame", drop.after.warp === 1 && drop.after.dirty === 0, drop);
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
