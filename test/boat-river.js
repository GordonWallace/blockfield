// Boats on a real river: finds a generated river (generator 3) near the spawn, puts the player in a boat on it and rows 500 blocks
// downstream with a simple autopilot (steer towards the heading with the longest run of water that doesn't rise). Checks the boat never
// ends up inside a solid block or below the world, and that it gets the whole way. Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/br test/boat-river.js [seed]
module.exports = async (pg, out) => {
  const seed = +(process.env.SEED || 270465807);
  const res = await pg.evaluate(async seed => {
    const R = { lines: [] }, ok = (name, cond, extra) => { const l = (cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""); R.lines.push(l); console.warn(l); };
    const tick = () => new Promise(r => setTimeout(r, 0));
    BF.state.paused = true;
    BF.newWorld(seed, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    const G = BF.worldgen, W = BF.world, P = BF.player, o = {};
    const wet = (x, z) => G.waterLevelAt(Math.floor(x), Math.floor(z)) > G.heightAt(Math.floor(x), Math.floor(z));
    const level = (x, z) => G.waterLevelAt(Math.floor(x), Math.floor(z));
    // a river spot: well inside a channel, above the sea, with water in a 5x5 square around it
    let spot = null;
    for (let k = 0; !spot && k < 60000; k++) {
      const r = 200 + k * 0.08, a = k * 2.399;
      const x = Math.floor(Math.cos(a) * r), z = Math.floor(Math.sin(a) * r);
      if (!BF.rivers.at(x, z, o) || o.sd > -3 || o.rs < BF.SEA + 20) continue;
      let all = true;
      for (let dz = -2; dz <= 2 && all; dz++) for (let dx = -2; dx <= 2 && all; dx++) if (!wet(x + dx, z + dz)) all = false;
      if (all) spot = { x, z };
    }
    ok("found a river", !!spot, spot);
    if (!spot) return R;
    const loadAround = async (x, z, frames) => { for (let i = 0; i < frames; i++) { W.update(x, z, 20); await tick(); if (i > 20 && W.queueLength === 0 && W.isLoaded(x, z)) break; } };
    P.teleport(spot.x + 0.5, level(spot.x, spot.z) + 3, spot.z + 0.5);
    await loadAround(spot.x, spot.z, 3000);
    // pick the downstream heading: the direction where the water level 24 blocks away is lowest
    let yaw = 0, best = Infinity;
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2, fx = -Math.sin(a), fz = -Math.cos(a);
      let run = 0;
      for (let d = 1; d <= 24 && wet(spot.x + fx * d, spot.z + fz * d); d++) run = d;
      if (run < 12) continue;
      const l = level(spot.x + fx * run, spot.z + fz * run) - run * 0.01;
      if (l < best) { best = l; yaw = a; }
    }
    // the boat goes on the water surface (the real blocks), the player gets in
    let sy = Math.floor(level(spot.x, spot.z)) + 3, wy = null;
    for (let y = sy; y > sy - 8; y--) if (BF.FLUID[W.getBlock(spot.x, y, spot.z)]) { wy = y; break; }
    ok("the river has water blocks", wy != null, { wy, level: level(spot.x, spot.z) });
    if (wy == null) return R;
    const b = BF.boats.spawn("oak", spot.x + 0.5, wy + 0.739, spot.z + 0.5, yaw);
    P.mount(b);
    // autopilot: every 0.2 s look across headings within 100 degrees of the bow for the longest run of wet columns whose water doesn't rise
    const h = 0.05, start = { x: b.pos.x, z: b.pos.z };
    let path = 0, t = 0, want = yaw, inSolid = null, below = false, lastProgT = 0, lastPath = 0, minY = b.pos.y, maxV = 0;
    const steer = () => {
      const lv0 = level(b.pos.x, b.pos.z);
      let bs = -Infinity;
      for (let i = -10; i <= 10; i++) {
        const a = b.yaw + i * 0.17, fx = -Math.sin(a), fz = -Math.cos(a);
        let run = 0;
        for (let d = 1; d <= 20; d++) {
          let okc = true;
          for (const s of [-1.2, 0, 1.2]) { const x = b.pos.x + fx * d - fz * s, z = b.pos.z + fz * d + fx * s; if (!wet(x, z) || level(x, z) > lv0 + 0.5) { okc = false; break; } }
          if (!okc) break;
          run = d;
        }
        const sc = run - Math.abs(i) * 0.15;
        if (sc > bs) { bs = sc; want = a; }
      }
    };
    while (path < 500 && t < 400) {
      if (Math.round(t / h) % 4 === 0) steer();
      let d = want - b.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      const ox = b.pos.x, oz = b.pos.z;
      P.ride(Math.abs(d) > 1 ? 0.3 : 1, Math.abs(d) < 0.05 ? 0 : d > 0 ? 1 : -1, h);
      path += Math.hypot(b.pos.x - ox, b.pos.z - oz);
      maxV = Math.max(maxV, Math.hypot(b.vel.x, b.vel.z));
      t += h;
      if (!inSolid && W.boxCollides(b.pos.x, b.pos.y + 0.01, b.pos.z, BF.boats.HW, 0.5)) inSolid = { x: b.pos.x, y: b.pos.y, z: b.pos.z, t };
      if (b.pos.y < BF.MIN_Y) below = true;
      minY = Math.min(minY, b.pos.y);
      if (path > lastPath + 5) { lastPath = path; lastProgT = t; }
      if (t - lastProgT > 30) break;   // stuck
      if (Math.round(t / h) % 10 === 0) { W.update(b.pos.x, b.pos.z, 12); await tick(); }
    }
    const straight = Math.hypot(b.pos.x - start.x, b.pos.z - start.z);
    ok("rowed 500 blocks down the river", path >= 500, { path: Math.round(path), straight: Math.round(straight), seconds: Math.round(t), maxV: +maxV.toFixed(2), end: [Math.round(b.pos.x), Math.round(b.pos.y), Math.round(b.pos.z)] });
    ok("never inside a solid block", !inSolid, inSolid);
    ok("never below the world", !below && b.pos.y > BF.MIN_Y, { minY });
    ok("still in the boat, on water", P.boat === b && b.inWater, { medium: b.medium });
    R.start = start; R.drop = level(start.x, start.z) - level(b.pos.x, b.pos.z);
    return R;
  }, seed);
  for (const l of res.lines) console.log(l);
  console.log("water level drop along the run:", res.drop);
  const fails = res.lines.filter(l => l.startsWith("FAIL")).length;
  console.log(fails ? "boat-river FAIL " + fails : "boat-river PASS");
};
