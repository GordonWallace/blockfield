// @ci integration suite=world timeout=300
// The realistic look (1.6) draws trees as models whose crowns are not blocks, so with ?look=real the player walks through leaf blocks
// (and the leafy bushes drawn as plants) instead of bumping into something they can't see. A trunk still stops them, and so do the
// cubes the look still draws. Mobs keep colliding with leaves (the simulation does not depend on the look), and with the look off
// leaves stop the player as in 1.5.
// node test/real-foliage.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
(async () => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? 'ok ' : 'FAIL ') + what); if (!ok) bad++; };
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const open = async look => {
    const pg = await b.newPage({ viewport: { width: 480, height: 300 } });
    pg.on('pageerror', e => { console.log('PAGEERROR', e.stack || e.message); bad++; });
    await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await pg.route('https://fonts.**', r => r.abort());
    await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
    await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&look=' + look + '#seed123gen4v10');
    await lib.ready(pg);
    await pg.waitForTimeout(3000);
    await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('survival'); BF.mobs.spawning = false; });
    return pg;
  };
  // a flat stone floor with a wall of `block` across it, 3 blocks to the north of the player, from the floor to 3 blocks up
  const wall = (pg, block) => pg.evaluate(block => {
    const W = BF.world, p = BF.player.position, X = Math.floor(p.x), Z = Math.floor(p.z), gy = W.heightAt(X, Z) + 6;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -9; dz <= 4; dz++) {
      W.setBlock(X + dx, gy, Z + dz, BF.B.stone);
      for (let k = 1; k <= 5; k++) W.setBlock(X + dx, gy + k, Z + dz, dz === -3 && k <= 3 ? BF.B[block] : 0);
    }
    BF.player.teleport(X + 0.5, gy + 1, Z + 0.5);
    for (let i = 0; i < 10; i++) BF.player.update(0.05);
    BF.player.setLook(0, 0);   // yaw 0 faces -z (north)
    return { X, Z, gy };
  }, block);
  const walk = (pg, n) => pg.evaluate(n => {
    const P = BF.player;
    for (let i = 0; i < n; i++) P.update(0.05);
    return { y: P.position.y, z: P.position.z };
  }, n);
  const through = async (pg, block) => {
    const at = await wall(pg, block);
    await pg.keyboard.down('KeyW');
    const r = await walk(pg, 30);
    await pg.keyboard.up('KeyW');
    return { at, r, past: r.z < at.Z - 3 };
  };

  let pg = await open('real');
  check(await pg.evaluate(() => BF.real.on), 'the look is on with ?look=real');
  for (const leaves of ['oak_leaves', 'spruce_leaves', 'jungle_leaves', 'dark_oak_leaves']) {
    const { at, r, past } = await through(pg, leaves);
    check(past && r.y === at.gy + 1, `walks straight through a wall of ${leaves} (z ${r.z.toFixed(2)}, wall at ${at.Z - 3})`);
  }
  for (const solid of ['oak_log', 'spruce_planks']) {
    const { at, r, past } = await through(pg, solid);
    check(!past && r.z > at.Z - 2 - 0.31, `a wall of ${solid} still stops the player (z ${r.z.toFixed(2)})`);
  }
  // the player does not stand on leaves: dropped on a floor of them, they fall through to the ground
  const fell = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, X = Math.floor(p.x), Z = Math.floor(p.z), gy = W.heightAt(X, Z);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { W.setBlock(X + dx, gy + 3, Z + dz, BF.B.oak_leaves); for (let k = 4; k <= 7; k++) W.setBlock(X + dx, gy + k, Z + dz, 0); }
    BF.player.teleport(X + 0.5, gy + 4.2, Z + 0.5);
    for (let i = 0; i < 40; i++) BF.player.update(0.05);
    return { y: BF.player.position.y, gy };
  });
  check(fell.y < fell.gy + 3, `the player falls through a floor of leaves (y ${fell.y.toFixed(2)}, leaves at ${fell.gy + 3})`);
  // a mob still bumps into leaves
  const mob = await pg.evaluate(() => {
    const W = BF.world, pos = { x: BF.player.position.x, y: 0, z: BF.player.position.z }, X = Math.floor(pos.x), Z = Math.floor(pos.z), gy = W.heightAt(X, Z) + 12;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -6; dz <= 2; dz++) { W.setBlock(X + dx, gy, Z + dz, BF.B.stone); for (let k = 1; k <= 3; k++) W.setBlock(X + dx, gy + k, Z + dz, dz === -3 ? BF.B.oak_leaves : 0); }
    pos.x = X + 0.5; pos.y = gy + 1; pos.z = Z + 0.5;
    const vel = { x: 0, y: 0, z: -4 };
    for (let i = 0; i < 20; i++) { vel.z = -4; W.moveBox(pos, vel, 0.3, 1.4, 0.05, { stepUp: 1.05 }); }
    return { z: pos.z, wall: Z - 3 };
  });
  check(mob.z > mob.wall + 1, `a mob's box is still stopped by leaves (z ${mob.z.toFixed(2)}, wall at ${mob.wall})`);
  await pg.close();

  pg = await open('block');
  check(await pg.evaluate(() => !BF.real.on), 'the look is off by default');
  const { at, r, past } = await through(pg, 'oak_leaves');
  check(!past && r.z > at.Z - 2 - 0.31, `with the look off leaves stop the player as before (z ${r.z.toFixed(2)})`);
  await pg.close();
  await b.close();
  console.log(bad ? `FAIL ${bad}` : 'PASS');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
