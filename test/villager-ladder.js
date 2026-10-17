// Villagers climb ladders: node test/run.js /tmp/vl test/villager-ladder.js
// In a two-storey village house (house2) a villager plans an A* route from the ground floor to the upper floor (up the ladder through
// the hatch), walks and climbs it, then comes back down the same way. Also checks a free-standing ladder against a pillar.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.mobs.spawning = false; if (BF.sky && BF.sky.setTime) BF.sky.setTime(0.3); });
  const house = await pg.evaluate(() => {
    for (const v of BF.worldgen.villagesNear(0, 0, 3000).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))) {
      const b = v.buildings.find(b => b.type === "house2");
      if (!b) continue;
      const at = (u, q) => [b.bx + b.ax * u + b.sx * q, b.bz + b.az * u + b.sz * q];
      const lu = b.w >> 1, [lx, lz] = at(lu, b.d - 2), [ux, uz] = at(lu, b.d - 3), [dx, dz] = at(b.du, 1);
      return { y: b.y, lx, lz, ux, uz, dx, dz };
    }
    return null;
  });
  console.log("house2:", JSON.stringify(house));
  if (!house) throw new Error("no house2 found");
  await pg.evaluate(h => BF.player.spawn(h.dx + 0.5, h.y + 1.01, h.dz + 0.5), house);
  await pg.waitForTimeout(9000);
  await pg.evaluate(h => { const W = BF.world, x = h.dx + 30, z = h.dz + 30; BF.player.teleport(x + 0.5, W.heightAt(x, z) + 1.01, z + 0.5); }, house);   // out of the villager's way

  // A test villager that does nothing but follow window.__route (every other daytime behaviour is switched off for it).
  const r = await pg.evaluate(async h => {
    const N = BF.mobs.nav, res = {};
    const m = BF.mobs.spawn("villager", h.dx + 0.5, h.y + 1.01, h.dz + 0.5);
    m.profession = "nitwit"; m.__test = true;
    const wrap = (o, k) => { const f = o[k]; o[k] = (mm, dt, out) => mm.__test ? false : f(mm, dt, out); };
    if (BF.villageLife) wrap(BF.villageLife, "ai");
    const jobs = BF.jobs.ai;
    BF.jobs.ai = (mm, dt, out) => {
      if (!mm.__test) return jobs(mm, dt, out);
      const st = N.followRoute(mm, dt, out, 1.4); mm.__st = st; return true;
    };
    const go = (goal, n) => {
      const [x, y, z] = N.feetCell(m);
      const path = N.findPath(x, y, z, goal, 3000);
      m.ai.route = path; m.ai.ri = 0; m.ai.stuckT = 0;
      return path;
    };
    const run = secs => {
      let top = -1e9, low = 1e9, hpLost = 0, hp = m.hp;
      for (let t = 0; t < secs; t += 0.05) {
        BF.mobs.update(0.05);
        top = Math.max(top, m.position.y); low = Math.min(low, m.position.y);
        if (m.__st === "done" || m.__st === "stuck") break;
      }
      return { st: m.__st, top: +top.toFixed(2), low: +low.toFixed(2), pos: N.feetCell(m), hpLost: hp - m.hp };
    };
    // up: to the upper floor cell in front of the hatch
    const up = go({ x: h.ux, z: h.uz, at: (x, y, z) => x === h.ux && z === h.uz && y === h.y + 5 });
    res.upPath = up && up.map(c => [c[0] - h.lx, c[1] - h.y, c[2] - h.lz].join(","));
    res.up = run(40);
    // down: back to the door
    const down = go({ x: h.dx, z: h.dz, at: (x, y, z) => x === h.dx && z === h.dz && y === h.y + 1 });
    res.downLen = down && down.length;
    res.down = run(40);
    res.upperFloorY = h.y + 5; res.groundY = h.y + 1;
    return res;
  }, house);
  console.log("route up (relative to the ladder foot - 1):", r.upPath && r.upPath.join(" "));
  console.log("up:", JSON.stringify(r.up));
  console.log("down (" + r.downLen + " cells):", JSON.stringify(r.down));
  const okUp = r.up.st === "done" && r.up.pos[1] === r.upperFloorY && r.up.hpLost === 0;
  const okDown = r.down.st === "done" && r.down.pos[1] === r.groundY && r.down.hpLost === 0;

  // a free-standing ladder: a 6-high stone pillar in the open with a ladder up one face, villager climbs to the top and back down
  const p0 = await pg.evaluate(async h => {
    const W = BF.world, N = BF.mobs.nav, B = BF.B;
    let bx = h.dx + 12, bz = h.dz + 12, gy = W.heightAt(bx, bz) + 1;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let k = 0; k < 9; k++) W.setBlock(bx + dx, gy + k, bz + dz, 0);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) W.setBlock(bx + dx, gy - 1, bz + dz, B.stone);
    for (let k = 0; k < 6; k++) W.setBlock(bx, gy + k, bz, B.stone);
    for (let k = 0; k < 6; k++) W.setBlock(bx + 1, gy + k, bz, BF.ladderId(1));   // facing east, wall to the west (the pillar)
    const m = BF.mobs.list.find(o => o.__test);
    m.position.set(bx + 2.5, gy + 0.01, bz + 0.5); m.vel.set(0, 0, 0);
    const go = goal => { const [x, y, z] = N.feetCell(m); const path = N.findPath(x, y, z, goal, 3000); m.ai.route = path; m.ai.ri = 0; m.ai.stuckT = 0; return path; };
    const run = secs => { let hp = m.hp; for (let t = 0; t < secs; t += 0.05) { BF.mobs.update(0.05); if (m.__st === "done" || m.__st === "stuck") break; } return { st: m.__st, pos: N.feetCell(m), hpLost: hp - m.hp }; };
    const res = { top: gy + 6 };
    const up = go({ x: bx, z: bz, at: (x, y, z) => x === bx && z === bz && y === gy + 6 });
    res.upLen = up && up.length;
    window.__pillar = { bx, bz, gy, run };
    return res;
  }, house);
  // mid-climb: look at the villager on the ladder from a few blocks away
  await pg.evaluate(() => {
    const P = window.__pillar, m = BF.mobs.list.find(o => o.__test);
    for (let t = 0; t < 3.2 && m.position.y < P.gy + 2.5; t += 0.05) BF.mobs.update(0.05);
    BF.player.teleport(P.bx + 5.5, P.gy + 0.01, P.bz + 3.5);
    const e = BF.player.eyePos(), tx = m.position.x - e.x, ty = m.position.y + 1 - e.y, tz = m.position.z - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
  });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + '-climbing.png' });
  const p = await pg.evaluate(p0 => {
    const N = BF.mobs.nav, { bx, bz, gy, run } = window.__pillar, m = BF.mobs.list.find(o => o.__test), res = p0;
    BF.player.teleport(bx + 8.5, gy + 0.01, bz + 8.5);
    const go = goal => { const [x, y, z] = N.feetCell(m); const path = N.findPath(x, y, z, goal, 3000); m.ai.route = path; m.ai.ri = 0; m.ai.stuckT = 0; return path; };
    res.up = run(30);
    const down = go({ x: bx + 2, z: bz, at: (x, y, z) => x === bx + 2 && z === bz && y === gy });
    res.downLen = down && down.length; res.down = run(30);
    res.ground = gy;
    return res;
  }, p0);
  console.log("pillar:", JSON.stringify(p));
  const okPillar = p.up.st === "done" && p.up.pos[1] === p.top && p.down.st === "done" && p.down.pos[1] === p.ground && !p.up.hpLost && !p.down.hpLost;
  console.log(`RESULT house up ${okUp ? "PASS" : "FAIL"}, house down ${okDown ? "PASS" : "FAIL"}, pillar ${okPillar ? "PASS" : "FAIL"}`);
};
