// Iron golem checks: node test/run.js /tmp/golem test/golem-actions.js
// Rescue sprint to a villager under attack, hostiles fighting back (melee and arrows), crack stages, death and drops.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const M = BF.mobs, W = BF.world, r = {};
    BF.sky.setTime(0.75);
    M.spawning = false;   // no natural spawns muddling the fights
    const step = (n, dt = 0.05) => { for (let i = 0; i < n; i++) { BF.sky.setTime(0.75); M.update(dt); } };
    // clear other hostiles and park every golem but one far away
    for (const m of M.list.slice()) if (m.hostile) M.kill(m);
    const golems = M.list.filter(m => m.type === "iron_golem");
    r.golems = golems.length;
    const g = golems[0];
    const v = M.list.find(m => m.type === "villager" && m.village === g.village && !m.sleeping && !m.child) || M.list.find(m => m.type === "villager");
    // a flat test pad 40 blocks long with the villager at one end and the golem at the other
    // (built along x from the player, inside loaded chunks)
    const pp = BF.player.position, x0 = Math.floor(pp.x) - 20, z0 = Math.floor(pp.z), y0 = Math.floor(pp.y) + 2;
    for (let dx = -4; dx <= 44; dx++) for (let dz = -4; dz <= 4; dz++) { W.setBlock(x0 + dx, y0 - 1, z0 + dz, BF.B.stone); for (let k = 0; k < 5; k++) W.setBlock(x0 + dx, y0 + k, z0 + dz, Math.abs(dz) === 4 || dx === -4 || dx === 44 ? BF.B.stone : 0); }   // walled so nobody falls off
    for (const o of golems.slice(1)) o.position.set(x0 + 400, o.position.y, z0);
    v.position.set(x0 + 0.5, y0, z0 + 0.5); v.ai.fleeT = 0;
    g.position.set(x0 + 40.5, y0, z0 + 0.5); g.vel.set(0, 0, 0);
    r.loaded = [W.isLoaded(x0 - 4, z0), W.isLoaded(x0 + 44, z0)];
    step(10);
    r.afterSettle = [g.removed, Math.round(g.position.x - x0), Math.round(g.position.y - y0)];
    // a zombie attacks the villager
    const z = M.spawn("zombie", x0 + 1.5, y0, z0 + 0.5);
    let reachAt = null, maxSp = 0, last = g.position.clone();
    for (let i = 0; i < 400; i++) {
      v.position.set(x0 + 0.5, y0, z0 + 0.5); v.vel.set(0, 0, 0); v.ai.fleeT = 0;   // keep the villager put
      step(1);
      const sp = Math.hypot(g.position.x - last.x, g.position.z - last.z) / 0.05; last.copy(g.position);
      if (i > 5) maxSp = Math.max(maxSp, sp);
      if (!reachAt && Math.hypot(g.position.x - z.position.x, g.position.z - z.position.z) < 2.2) reachAt = (i * 0.05).toFixed(2);
      if (z.dead) break;
    }
    r.rescue = { rescueTarget: !!g.ai.rescue || z.dead, golemTopSpeed: +maxSp.toFixed(2), reachedZombieAfterS: reachAt, zombieDead: z.dead, villagerHp: v.hp };
    // golem left alone with zombies: they fight back and crack it
    g.hp = g.maxHp; g.invuln = 0;
    const gx = g.position.x, gz = g.position.z;
    const zs = [];
    for (let k = 0; k < 6; k++) { const o = M.spawn("zombie", gx + 3 * Math.cos(k), y0, gz + 3 * Math.sin(k)); o.hp = o.maxHp = 400; zs.push(o); }
    const sk = M.spawn("skeleton", gx - 10, y0, gz); sk.hp = sk.maxHp = 400;
    const levels = new Set(); let hpLog = [];
    let dropsBefore = BF.drops && BF.drops.list ? BF.drops.list.length : null;
    for (let i = 0; i < 3000 && !g.dead; i++) { step(1); levels.add(g.crackLevel || 0); if (i % 100 === 0) hpLog.push(Math.round(g.hp)); }
    r.fight = { golemDead: g.dead, hpLog, crackLevelsSeen: [...levels], lastHurt: g.lastHurt, skeletonTarget: sk.ai.golemFoe === g || g.dead };
    step(30);
    r.fight.removed = g.removed;
    // a skeleton alone: its arrows hurt a golem
    for (const m of M.list.slice()) if (m.hostile) M.kill(m);
    step(30);
    const g2 = M.spawn("iron_golem", x0 + 30.5, y0, z0 + 0.5); g2.village = null;
    const s2 = M.spawn("skeleton", x0 + 22.5, y0, z0 + 0.5); s2.hp = s2.maxHp = 400;
    let arrowHits = 0;
    for (let i = 0; i < 600; i++) { const h = g2.hp; step(1); if (g2.hp < h && g2.lastHurt === "a skeleton") arrowHits++; }
    r.arrows = { arrowHits, golemHp: g2.hp, skeletonHp: s2.hp };
    // crack stage line-up next to the player for a screenshot
    const p = BF.player.position;
    const px = Math.floor(p.x), pz = Math.floor(p.z), py = Math.floor(p.y);
    for (const m of M.list.slice()) if (m.hostile) M.kill(m);
    const row = [];
    for (let k = 0; k < 4; k++) {
      const x = px - 4.5 + k * 3, zz = pz - 6;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { W.setBlock(Math.floor(x) + dx, py - 1, zz + dz, BF.B.stone); for (let h = 0; h < 4; h++) W.setBlock(Math.floor(x) + dx, py + h, zz + dz, 0); }
      const o = M.spawn("iron_golem", x, py, zz + 0.5);
      M.hurt(o, [0, 30, 55, 80][k], "a test");
      o.ai.provoked = 0; o.hurtT = 0;
      row.push([o.hp, o.crackLevel || 0]);
      o.frozen = true;
    }
    r.row = row;
    BF.sky.setTime(0.3);
    BF.player.yaw = 0; BF.player.pitch = -0.15;
    window.__row = M.list.filter(o => o.frozen);
    return r;
  });
  console.log(JSON.stringify(res, null, 1));
  // keep the line-up still and face it
  for (let i = 0; i < 3; i++) {
    await pg.evaluate(() => { for (const o of window.__row) { o.model.rotation.y = 0; o.yaw = 0; o.vel.set(0, 0, 0); o.hurtT = 0; } });
    await pg.waitForTimeout(150);
  }
  await pg.screenshot({ path: out + '-cracks.png' });
};
