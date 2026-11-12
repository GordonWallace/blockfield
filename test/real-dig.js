// @ci baseline suite=world timeout=420
// Digging smooth ground in the realistic look (1.6, js/real/dig.js): natural ground is drawn as one smooth surface, so mining it shows
// the wear on that surface (a hollow worked into the terrain's own triangles, chips of the ground's colour) and not the cube-shaped
// crack overlay of js/cracks.js. Blocks that are still cubes keep the cube overlay, and with the look off nothing changes.
// Usage: node test/real-dig.js [outDir for screenshots]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.argv[2] || null;
let fails = 0;
const check = (ok, what, d) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && d !== undefined ? ' ' + JSON.stringify(d) : '')); if (!ok) fails++; };

async function boot(b, look) {
  const pg = await (await b.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).slice(0, 400)); });
  pg.on('console', m => { if (m.type() === 'error' && /shader|program|BF\.real/i.test(m.text())) { errors.push(m.text()); console.log('console error: ' + m.text().slice(0, 600)); } });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { try { localStorage.removeItem('bf.look'); } catch (_) { /* none */ } });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&debugfeed=off&look=' + look + '#seed123gen4v10');
  await pg.waitForFunction(() => globalThis.BF && !BF.preparing && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30, null, { timeout: 240000 });
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('survival'); BF.player.setFlying(false); BF.player.setLook(0, -1.5); });
  await pg.waitForFunction(() => !!BF.player.target, null, { timeout: 60000 });
  await pg.waitForTimeout(1500);
  return { pg, errors };
}
// The ground under the crosshair and the eight cells around it become `name`; resolves once the chunk is drawn again.
const lay = async (pg, name, only) => {
  await pg.evaluate(([name, only]) => {
    BF.player.setMouse(false, false);
    const t = BF.player.target, id = BF.B[name];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!only || (!dx && !dz)) BF.world.setBlock(t.x + dx, t.y, t.z + dz, id);
  }, [name, !!only]);
  await pg.waitForTimeout(1500);
  await pg.waitForFunction(id => BF.player.target && BF.player.target.id === id, await pg.evaluate(n => BF.B[n], name), { timeout: 30000 });
};
const state = pg => pg.evaluate(() => ({
  target: BF.player.target ? BF.blocks[BF.player.target.id].name : null,
  cube: BF.cracks.visible, dig: !!(BF.real.dig && BF.real.dig.visible), tris: BF.real.dig ? BF.real.dig.triangles : 0,
  chips: BF.real.dig ? BF.real.dig.chips : 0, prog: BF.real.dig ? BF.real.dig.progress : -1, debris: BF.cracks.particles,
}));
const shot = async (pg, name) => { if (out) await pg.screenshot({ path: path.join(out, name + '.png') }); };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  {
    const { pg, errors } = await boot(b, 'real');
    check(await pg.evaluate(() => !!(BF.real.on && BF.real.dig)), 'the look is on and the digging module is loaded');
    check(await pg.evaluate(() => BF.real.dig.covers(BF.B.sand) && BF.real.dig.covers(BF.B.stone) && BF.real.dig.covers(BF.B.grass) && !BF.real.dig.covers(BF.B.planks) && !BF.real.dig.covers(BF.B.glass)),
      'sand, stone and grass count as smooth ground; planks and glass do not');

    // sand (bare hands: 0.75 s)
    await lay(pg, 'sand');
    const cell = await pg.evaluate(() => { const t = BF.player.target; return [t.x, t.y, t.z]; });
    await pg.evaluate(() => BF.player.setMouse(true, false));
    await pg.waitForFunction(() => BF.real.dig.progress > 0.3, null, { timeout: 20000, polling: 30 }).catch(() => {});
    const s1 = await state(pg);
    await shot(pg, 'dig-sand');
    check(s1.target === 'sand' && s1.dig && s1.tris > 0, `mining sand draws the wear on the smooth ground (${s1.tris} triangles of the terrain)`, s1);
    check(!s1.cube, 'and the cube-shaped crack overlay stays hidden', s1);
    check(s1.prog > 0.3 && s1.prog < 1, 'the hollow grows with the mining progress', s1);
    check(s1.chips > 0 && s1.debris === 0, `hits throw chips of the ground (${s1.chips}), not cube debris`, s1);
    await pg.waitForFunction(c => BF.world.getBlock(c[0], c[1], c[2]) !== BF.B.sand, cell, { timeout: 10000 }).catch(() => {});
    const s2 = await state(pg);
    await pg.evaluate(() => BF.player.setMouse(false, false));
    check(await pg.evaluate(c => BF.world.getBlock(c[0], c[1], c[2]) === 0, cell), 'the sand block breaks as before');
    check(s2.chips >= 10, `breaking it throws a burst of chips (${s2.chips})`, s2);
    await pg.waitForTimeout(400);
    const s3 = await state(pg);
    check(!s3.dig && !s3.cube, 'the effect is gone once the mouse is released', s3);

    // stone (bare hands: 7.5 s, so the block stays)
    await pg.waitForFunction(() => !!BF.player.target, null, { timeout: 30000 });
    await lay(pg, 'stone');
    await pg.evaluate(() => BF.player.setMouse(true, false));
    await pg.waitForTimeout(3000);
    const s4 = await state(pg);
    await shot(pg, 'dig-stone');
    check(s4.target === 'stone' && s4.dig && !s4.cube && s4.tris > 0, 'stone under the smooth surface gets the same treatment', s4);
    await pg.evaluate(() => BF.player.setMouse(false, false));

    // a built block stays a cube, with the cube overlay
    await lay(pg, 'planks', true);
    await pg.evaluate(() => BF.player.setMouse(true, false));
    await pg.waitForTimeout(600);
    const s5 = await state(pg);
    await shot(pg, 'dig-planks');
    check(s5.target === 'planks' && s5.cube && !s5.dig, 'planks keep the cube crack overlay', s5);
    check(s5.debris > 0, 'and their cube debris', s5);
    await pg.evaluate(() => BF.player.setMouse(false, false));
    check(errors.length === 0, 'no page or shader errors', errors);
    await pg.context().close();
  }
  {
    const { pg, errors } = await boot(b, 'blocks');
    await lay(pg, 'sand');
    await pg.evaluate(() => BF.player.setMouse(true, false));
    await pg.waitForTimeout(420);
    const s = await pg.evaluate(() => ({ dig: !!(BF.real && BF.real.dig), cube: BF.cracks.visible, debris: BF.cracks.particles }));
    check(!s.dig && s.cube && s.debris > 0, 'with the look off sand is mined with the cube overlay, as in 1.5', s);
    check(errors.length === 0, 'no page errors with the look off', errors);
    await pg.context().close();
  }
  await b.close();
  console.log(fails ? `FAIL ${fails} check(s)` : 'PASS real-dig');
  process.exit(fails ? 1 : 0);
})();
