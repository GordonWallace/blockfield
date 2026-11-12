// @ci baseline suite=world timeout=420
// Dropped items (1.6, js/drops.js, js/real/drops.js). Two things Gordon saw in the realistic look on 2026-11-12:
// - a dropped dirt block lay wobbling on the ground under him and could not be picked up. The item was inside the block he stood
//   on (the look draws such an item on the smooth ground above it), a block below the old reach, which was measured from one
//   point at the waist. Now an item inside a solid block rises out of it, the reach is measured from the lower body, and an item
//   that has started toward the player keeps coming until it is collected.
// - the dropped dirt block was pale tan on dark earth: the icon sprite's colours were lifted by the look's sRGB output and it was
//   not lit. Now ground blocks drop as a lump of that ground, lit like the terrain, and other items keep their icon, read as sRGB
//   and lit by the scene. With the look off the drawing is 1.5's.
// Usage: node test/real-drops.js [outDir for screenshots]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.argv[2] || null;
let fails = 0;
const check = (ok, what, d) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && d !== undefined ? ' ' + JSON.stringify(d) : '')); if (!ok) fails++; };

async function boot(b, look) {
  const pg = await (await b.newContext({ viewport: { width: 800, height: 500 } })).newPage();
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).slice(0, 400)); });
  pg.on('console', m => { if (m.type() === 'error' && /shader|program|BF\.real/i.test(m.text())) { errors.push(m.text()); console.log('console error: ' + m.text().slice(0, 600)); } });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { try { localStorage.removeItem('bf.look'); } catch (_) { /* none */ } });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&debugfeed=off&sim=page&look=' + look + '#seed123gen4v10');
  await pg.waitForFunction(() => globalThis.BF && !BF.preparing && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30, null, { timeout: 240000 });
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('survival'); BF.player.setFlying(false); BF.player.setLook(0, -1.1); BF.mobs.spawning = false; });
  await pg.waitForFunction(() => !!BF.player.target, null, { timeout: 60000 });
  await pg.waitForTimeout(1000);
  return { pg, errors };
}
const have = (pg, name) => pg.evaluate(n => BF.inventory.count(BF.I[n]), name);
// the view of the only drop of item `name`: what kind of object it is
const view = (pg, name) => pg.evaluate(n => {
  const id = BF.I[n];
  for (const e of BF.client.world.entities.values()) if (e.kind === 'drop' && e.item === id) {
    const o = BF.entityView.viewOf(e.n);
    if (!o) return null;
    const c = o.material.color;
    return { sprite: !!o.isSprite, mesh: !!o.isMesh, lump: !!o.userData.lump, y: o.position.y, srgb: !!(o.material.map && o.material.map.encoding === THREE.sRGBEncoding), col: [c.r, c.g, c.b], lit: !!o.material.userData.cell };
  }
  return null;
}, name);

async function buried(pg, look) {
  // a dirt item inside the dirt block the player stands on
  const n0 = await have(pg, 'dirt');
  await pg.evaluate(() => {
    const p = BF.player.position;
    BF.world.setBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), BF.B.dirt);
    globalThis.__d = BF.drops.spawn(BF.B.dirt, 1, p.x + 0.2, p.y - 1, p.z + 0.2, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 0 });
  });
  await pg.waitForFunction(() => !BF.drops.list.includes(__d), null, { timeout: 15000 }).catch(() => {});
  check(await pg.evaluate(() => !BF.drops.list.includes(__d)) && await have(pg, 'dirt') === n0 + 1, `${look}: an item inside the block under the player's feet is picked up`, await pg.evaluate(() => ({ y: __d.pos.y, py: BF.player.position.y })));
  // one buried out of reach rises to lie on the block
  const r = await pg.evaluate(async () => {
    const p = BF.player.position, x = Math.floor(p.x) + 5, z = Math.floor(p.z), y = BF.world.topSolidY ? null : null;
    let gy = Math.floor(p.y) + 3; while (gy > 0 && !BF.world.isSolid(x, gy, z)) gy--;
    const d = BF.drops.spawn(BF.B.cobblestone, 1, x + 0.5, gy - 1 + 0.4, z + 0.5, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 999 });
    await new Promise(r => setTimeout(r, 2500));
    const res = { y: d.pos.y, top: gy + 1, live: BF.drops.list.includes(d) };
    BF.drops.remove(d);
    return res;
  });
  check(r.live && Math.abs(r.y - r.top) < 0.01, `${look}: an item two blocks down inside solid ground rises to lie on top of it`, r);
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  {
    const { pg, errors } = await boot(b, 'real');
    check(await pg.evaluate(() => !!(BF.real.on && BF.real.drops)), 'the look is on and its item drawing is loaded');
    await buried(pg, 'real');

    // once on its way an item keeps coming: the player steps away as the pull starts
    const n0 = await have(pg, 'sand');
    const far = await pg.evaluate(async () => {
      BF.state.paused = true;
      const p = BF.player.position;
      const d = BF.drops.spawn(BF.B.sand, 1, p.x + 1.2, p.y + 0.2, p.z, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 0 });
      BF.drops.update(0.05);
      const pulled = d.pulled;
      BF.player.teleport(p.x - 2.5, p.y, p.z);
      const dist = Math.hypot(BF.player.position.x - d.pos.x, BF.player.position.z - d.pos.z);
      BF.state.paused = false;
      globalThis.__d = d;
      return { pulled, dist };
    });
    await pg.waitForFunction(() => !BF.drops.list.includes(__d), null, { timeout: 15000 }).catch(() => {});
    check(far.pulled && far.dist > 2.5 && await have(pg, 'sand') === n0 + 1, 'an item on its way still reaches a player who has moved off (3 blocks)', far);

    // the look of the items
    await pg.evaluate(() => {
      const p = BF.player.position, x0 = Math.floor(p.x), z0 = Math.floor(p.z), y = Math.floor(p.y) - 1;
      for (let dz = -5; dz <= -1; dz++) for (let dx = -3; dx <= 3; dx++) BF.world.setBlock(x0 + dx, y, z0 + dz, 0);
      ['dirt', 'sand', 'gravel', 'cobblestone', 'planks', 'stone', 'clay'].forEach((n, i) => BF.drops.spawn(BF.B[n], 1, x0 + 0.5 + (i - 3) * 0.45, y + 0.3, z0 - 1.9, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 999 }));
    });
    await pg.waitForTimeout(3000);
    const dirt = await view(pg, 'dirt'), cob = await view(pg, 'cobblestone'), sand = await view(pg, 'sand');
    if (out) await pg.screenshot({ path: path.join(out, 'drops-real.png') });
    check(dirt && dirt.mesh && dirt.lump && dirt.lit, 'dropped dirt is a lump of the ground, lit like the terrain', dirt);
    check(sand && sand.lump, 'so is dropped sand', sand);
    const soil = await pg.evaluate(() => { const g = [...BF.client.world.entities.values()].find(e => e.kind === 'drop' && e.item === BF.I.dirt), o = BF.entityView.viewOf(g.n), c = o.geometry.attributes.color.array, t = BF.real.meshTables(), k = t.NAT[BF.B.dirt] - 1;
      let r = 0, n = 0; for (let i = 0; i < c.length; i += 3) { r += c[i]; n++; } return { lump: r / n, ground: Math.pow(t.GCOL[k * 3], 2.2) * 0.5 }; });
    check(soil.lump > soil.ground * 0.6 && soil.lump < soil.ground * 1.4, `the lump has the ground's own colour (red ${soil.lump.toFixed(3)} against the terrain's ${soil.ground.toFixed(3)})`, soil);
    check(cob && cob.sprite && cob.srgb, 'a dropped block that stays a cube keeps its icon, its colours read as sRGB (not lifted pale)', cob);
    check(cob && Math.max(...cob.col) < 1.6 && Math.max(...cob.col) > 0.2 && cob.col[0] !== cob.col[2], 'and the icon is lit by the scene (the sun and sky colour, not a flat white)', cob);
    await pg.evaluate(() => { BF.sky.time = 0.75; });   // night
    await pg.waitForTimeout(1500);
    const night = await view(pg, 'cobblestone');
    check(night && Math.max(...night.col) < Math.max(...cob.col) * 0.5, 'the icon darkens with the scene at night', { day: cob && cob.col, night: night && night.col });
    check(errors.length === 0, 'no page or shader errors', errors);
    await pg.context().close();
  }
  {
    const { pg, errors } = await boot(b, 'blocks');
    await buried(pg, 'blocks');
    await pg.evaluate(() => { const p = BF.player.position; BF.drops.spawn(BF.B.dirt, 1, p.x + 3, p.y + 1, p.z, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 999 }); });
    await pg.waitForTimeout(1500);
    const dirt = await view(pg, 'dirt');
    check(dirt && dirt.sprite && !dirt.lump && !dirt.srgb, 'with the look off a dropped block is the icon sprite of 1.5', dirt);
    check(errors.length === 0, 'no page errors', errors);
    await pg.context().close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
