// @ci integration suite=world timeout=600 hosts=worker,server
// Batched chunk remeshing during fast-forward (spec r15-02): with the player above the boot world's village (59 villagers) at 1000x for
// 20 real seconds, chunks outside the player's 3x3 are remeshed at most every 5 s (2 s at 100x, 400 ms at 10x). Checks:
//  - no far chunk is remeshed twice within the 5 s wait, and far remeshes average under 2 a frame (per-chunk timing, not frame
//    bursts: chunks meshed together at load come due together, so a slow runner's few frames can each catch several: frames are
//    counted at 5 a second at least);
//  - a block the player breaks at 1000x is meshed the same frame;
//  - after dropping to 1x, no chunk stays dirty after one frame.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/ffr test/ff-remesh.js [--host page|worker|server]
// (the meshing is the page's in every host: with the simulation elsewhere, the village's edits reach the page's replica world, spec r15-43)
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
    // and, at 1000x, when each chunk outside the player's 3x3 started a remesh (its meshT moved)
    F.farT = new Map();
    W.update = function () {
      const t0 = performance.now(), was = F.on && BF.warp.speed >= 1000 ? [...W._dirty].map(k => [k, (W.chunks.get(k) || {}).meshT]) : null;
      const r = up.apply(this, arguments);
      if (!F.on) return r;
      F.frames.push({ ...W.lastRemesh, dirty: W._dirty.size, warp: BF.warp.speed, t0 });
      if (was) {
        const pp = BF.player.position, pcx = Math.floor(pp.x / 16), pcz = Math.floor(pp.z / 16), near = new Set();
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const c = W.chunkC(pcx + dx, pcz + dz); if (c) near.add(c.key); }
        for (const [k, mt] of was) { const c = W.chunks.get(k); if (c && !near.has(k) && c.meshT !== mt && c.meshT >= t0) (F.farT.get(k) || F.farT.set(k, []).get(k)).push(c.meshT); }
      }
      return r;
    };
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
    let minGap = Infinity, chunks = 0, twice = 0;
    for (const ts of __ffr.farT.values()) { chunks++; if (ts.length > 1) twice++; for (let i = 1; i < ts.length; i++) minGap = Math.min(minGap, ts[i] - ts[i - 1]); }
    return { frames: f.length, over2: f.filter(x => x.far > 2).length, far: f.reduce((s, x) => s + x.far, 0), held: f.reduce((s, x) => s + x.held, 0), maxFar: Math.max(0, ...f.map(x => x.far)),
      farChunks: chunks, remeshedTwice: twice, minGapMs: minGap === Infinity ? null : Math.round(minGap) };
  });
  console.log("FF " + JSON.stringify(ff));
  ok("ran frames at 1000x", ff.frames >= 20, ff);
  ok("the village dirtied far chunks (something to batch)", ff.far + ff.held > 0 && ff.farChunks > 0, ff);
  ok("no far chunk is remeshed twice within the 5 s wait", ff.minGapMs === null || ff.minGapMs >= 4990, ff);
  // (frames counted at 5 a second at least over the 20 s: a slow headless page's frame catches the remeshes due over several. Far
  // remeshes go to the mesher workers (r15-03); with the simulation off the page it isn't held to the page's frame rate at 1000x and its
  // village dirties two to three times as many far chunks in the 20 s)
  const perFrame = Math.max(ff.frames, 100);
  ok("far remeshes average under 2 a frame (" + (ff.far / perFrame).toFixed(2) + ")", ff.far < 2 * perFrame, ff);

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

  // drop to 1x: every chunk waiting dirty is remeshed by the first world.update after it (chunks the same update's loading dirties
  // again, light from a new neighbour, may wait for the next frame as at 1x)
  const drop = await pg.evaluate(async () => {
    const W = BF.world, waiting = [...W._dirty];
    BF.warp.set(0);
    const n0 = __ffr.frames.length;
    while (__ffr.frames.length === n0) await new Promise(r => requestAnimationFrame(r));
    const f = __ffr.frames[n0];
    const stale = waiting.filter(k => { const c = W.chunks.get(k); return c && c.mesh !== undefined && !(c.meshT >= f.t0); });
    return { waiting: waiting.length, stale, after: { warp: f.warp, near: f.near, far: f.far, held: f.held, dirty: f.dirty } };
  });
  ok("after dropping to 1x no waiting chunk stays dirty after one frame", drop.after.warp === 1 && drop.waiting > 0 && drop.stale.length === 0 && drop.after.held === 0, drop);
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
