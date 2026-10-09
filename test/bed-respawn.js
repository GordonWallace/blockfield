// Respawning at a bed in a room with a 2-high ceiling, or in an underground bedroom, puts you beside the bed inside the room,
// not on the roof or the surface (bug-025). Also when you die far away and the bed's chunk has to load first.
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); BF.mobs.spawning = false; });
  await pg.waitForTimeout(3000);
  const check = (ok, msg) => console.log((ok ? "PASS " : "FAIL ") + msg);
  const room = async (depth, far) => {
    const info = await pg.evaluate((depth) => {
      const P = BF.player, p = P.position, W = BF.world;
      const x = Math.floor(p.x) + 6, z = Math.floor(p.z) + 6, g = W.heightAt(x, z), y = g - depth;   // bed cell y
      // 7x7 stone box: floor y-1, air y..y+1, ceiling y+2
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let k = -1; k <= 2; k++) {
        const edge = Math.abs(dx) === 3 || Math.abs(dz) === 3;
        W.setBlock(x + dx, y + k, z + dz, k === -1 || k === 2 || edge ? BF.B.stone : 0);
      }
      W.setBlock(x, y, z, BF.bedId(0, 0)); W.setBlock(x, y, z - 1, BF.bedId(0, 1));
      P.teleport(x + 1.5, y + 0.01, z + 0.5);
      window._b = [x, y, z];
      return { bed: [x, y, z], built: W.getBlock(x, y + 2, z) === BF.B.stone && !!BF.blocks[W.getBlock(x, y, z)].bed };
    }, depth);
    await pg.waitForTimeout(1000);
    await pg.evaluate(() => {
      BF.sky.setTime(0.7);
      for (const m of BF.mobs.list.slice()) if (m.hostile) m.dead = true;
      BF.spawnPoint = null;
      const [bx, by, bz] = _b, e = BF.player.eyePos(), tx = bx + 0.5 - e.x, ty = by + 0.3 - e.y, tz = bz + 0.5 - e.z;
      BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
    });
    await pg.waitForTimeout(200);
    await pg.evaluate(() => { BF.player.setMouse(false, true); BF.player.setMouse(false, false); });
    await pg.waitForTimeout(1200);
    const slept = await pg.evaluate(() => !!(BF.spawnPoint && BF.spawnPoint.bed));
    if (far) {   // die somewhere the bed's chunk unloads
      await pg.evaluate(() => { const p = BF.player.position; BF.player.teleport(p.x + 3000, 2000, p.z + 3000); });
      await pg.waitForTimeout(4000);
      info.unloaded = await pg.evaluate(() => !BF.world.isLoaded(_b[0], _b[2]));
    }
    await pg.evaluate(() => { BF.player.kill(); });
    await pg.waitForTimeout(300);
    await pg.evaluate(() => BF.player.respawn());
    await pg.waitForTimeout(far ? 8000 : 2000);
    const at = await pg.evaluate(() => { const p = BF.player.position; return [p.x, p.y, p.z]; });
    const [bx, by, bz] = info.bed, name = (far ? "far, " : "") + (depth ? `underground bedroom ${depth} down` : "room on the surface");
    check(info.built && slept, `${name}: room built and slept in the bed`);
    if (far) check(info.unloaded, `${name}: the bed's chunk was unloaded before respawning`);
    const inside = Math.abs(at[0] - bx - 0.5) < 3 && Math.abs(at[2] - bz) < 3.5 && at[1] >= by - 0.05 && at[1] < by + 0.6;
    check(inside, `${name}: respawned inside the room by the bed (bed ${bx},${by},${bz}; at ${at.map(v => v.toFixed(2)).join(",")})`);
  };
  await room(0);    // 2-high room on the surface (roof just above)
  await room(12);   // underground bedroom
  await room(12, true);
  // a bed in the open: you still wake on the bed
  const open = await pg.evaluate(async () => {
    const P = BF.player, W = BF.world, p = P.position, x = Math.floor(p.x) + 3, z = Math.floor(p.z), y = W.heightAt(x, z) + 1;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -3; dz <= 2; dz++) { W.setBlock(x + dx, y - 1, z + dz, BF.B.stone); for (let k = 0; k < 4; k++) W.setBlock(x + dx, y + k, z + dz, 0); }
    W.setBlock(x, y, z, BF.bedId(0, 0)); W.setBlock(x, y, z - 1, BF.bedId(0, 1));
    BF.spawnPoint = { x: x + 0.5, y: y + 0.5625, z: z + 0.5, bed: [x, y, z], world: {} };
    P.kill(); await new Promise(r => setTimeout(r, 300)); P.respawn(); await new Promise(r => setTimeout(r, 1500));
    return { y, at: [P.position.x - x, P.position.y - y, P.position.z - z] };
  });
  check(Math.abs(open.at[0] - 0.5) < 0.05 && Math.abs(open.at[2] - 0.5) < 0.05 && Math.abs(open.at[1] - 0.5625) < 0.1, `bed in the open: respawned on the bed (${open.at.map(v => v.toFixed(2)).join(",")})`);
};
