// @ci integration suite=world timeout=300
// The realistic look (1.6) draws a one-block rise of natural ground as a slope, so with ?look=real the player walks up it without a
// jump and follows it back down without a fall, and the view glides instead of popping a block. A ledge of built blocks (drawn as
// cubes) still needs a jump, and with the look off a full block stops the player as in 1.5.
// NODE_PATH=$(npm root -g) node test/real-slopes.js
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
  // a flat floor of stone with a terrace of `ledge` one block higher to the north (z <= Z - 2); the player on the floor facing it
  const terrace = (pg, ledge) => pg.evaluate(ledge => {
    const W = BF.world, p = BF.player.position, X = Math.floor(p.x), Z = Math.floor(p.z), gy = W.heightAt(X, Z) + 6;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -8; dz <= 6; dz++) {
      W.setBlock(X + dx, gy, Z + dz, BF.B.stone);
      W.setBlock(X + dx, gy + 1, Z + dz, dz <= -2 ? BF.B[ledge] : 0);
      for (let k = 2; k <= 5; k++) W.setBlock(X + dx, gy + k, Z + dz, 0);
    }
    BF.player.teleport(X + 0.5, gy + 1, Z + 0.5);
    for (let i = 0; i < 10; i++) BF.player.update(0.05);
    BF.player.setLook(0, 0);   // yaw 0 faces -z (north)
    return { X, Z, gy };
  }, ledge);
  // walks for n ticks with the keys held now: the body's heights, the largest change of the camera's height in a tick, where it ended
  const walk = (pg, n) => pg.evaluate(n => {
    const P = BF.player, ys = new Set();
    let pop = 0, cy = BF.camera.position.y, hurt = P.health;
    for (let i = 0; i < n; i++) { P.update(0.05); ys.add(Math.round(P.position.y * 100) / 100); pop = Math.max(pop, Math.abs(BF.camera.position.y - cy)); cy = BF.camera.position.y; }
    return { ys: [...ys], pop, y: P.position.y, z: P.position.z, cam: cy, lost: hurt - P.health };
  }, n);

  let pg = await open('real');
  check(await pg.evaluate(() => BF.real.on), 'the look is on with ?look=real');
  let at = await terrace(pg, 'stone');
  await pg.keyboard.down('KeyW');
  let r = await walk(pg, 24);
  check(r.y === at.gy + 2 && r.z < at.Z - 2, `walking at a one-block rise of ground climbs it without a jump (y ${r.y} of ${at.gy + 2}, z ${r.z.toFixed(2)})`);
  check(r.ys.length === 2, 'the body only ever stood on the two levels (no jump): ' + r.ys);
  check(r.pop > 0.05 && r.pop < 0.7, `the view glides up the slope instead of popping a block (largest change in a tick ${r.pop.toFixed(2)})`);
  check(Math.abs(r.cam - (r.y + 1.78)) < 0.08, 'and settles at eye height');
  await pg.keyboard.up('KeyW');
  await pg.evaluate(() => BF.player.setLook(Math.PI, 0));
  await pg.keyboard.down('KeyW');
  r = await walk(pg, 40);
  check(r.y === at.gy + 1 && r.z > at.Z - 1, `walking back off it comes down (y ${r.y} of ${at.gy + 1})`);
  check(r.ys.length === 2, 'down the slope in one move, not a fall through the air: ' + r.ys);
  check(r.pop > 0.05 && r.pop < 0.7 && r.lost === 0, `the view glides down (largest change in a tick ${r.pop.toFixed(2)})`);
  await pg.keyboard.up('KeyW');

  at = await terrace(pg, 'planks');
  await pg.keyboard.down('KeyW');
  r = await walk(pg, 40);
  check(r.y === at.gy + 1 && r.z > at.Z - 1, `a ledge of built blocks (drawn as cubes) still stops a walk (y ${r.y}, z ${r.z.toFixed(2)})`);
  await pg.keyboard.down('Space');
  r = await walk(pg, 24);
  check(Math.max(...r.ys) >= at.gy + 2 && r.z < at.Z - 2, 'and a jump still gets onto it');
  await pg.keyboard.up('Space');
  await pg.evaluate(() => BF.player.setLook(Math.PI, 0));
  r = await walk(pg, 40);
  check(r.y === at.gy + 1 && r.ys.length > 2, 'stepping off built blocks is a fall as before');
  await pg.keyboard.up('KeyW');
  await pg.close();

  pg = await open('blocks');
  at = await terrace(pg, 'stone');
  await pg.keyboard.down('KeyW');
  r = await walk(pg, 40);
  check(r.y === at.gy + 1 && r.z > at.Z - 1, `with the look off a full block stops a walk as in 1.5 (y ${r.y}, z ${r.z.toFixed(2)})`);
  await pg.keyboard.up('KeyW');
  await pg.close();
  await b.close();
  console.log(bad ? `${bad} FAILED` : 'ok');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
