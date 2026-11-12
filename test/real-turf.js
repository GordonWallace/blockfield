// @ci baseline suite=world timeout=420
// Grass as ground in the realistic look (1.6, js/real/mesh.js, terrain.js, turf.js): turf is green on top only. The floor of a dug
// hole and the walls of a shaft show the soil that was dug into (no turf share at any of their vertices), the rim around them stays
// turf with a rough edge, short blades of grass stand on turf near the player and not in the hole, and when the game's grass spreading (js/grass.js)
// turns the floor back into grass the turf and its blades come back. With the look off none of it runs.
// Usage: node test/real-turf.js [outDir for screenshots]
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
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true); if (BF.real.on) BF.real.quality.auto = false; });
  await pg.waitForTimeout(1500);
  return { pg, errors };
}

// The ground's vertices over the block column (x, z) above height floor, from the mesher: [height, turf share, r, g, b] each.
const COLUMN = ([x, z, floor]) => {
  const W = BF.world, c = W.chunkAt(x, z), T = W.meshArrays(c).T, lx = x - c.cx * 16, lz = z - c.cz * 16, o = [];
  for (let i = 0; i < T.pos.length / 3; i++) {
    const vx = T.pos[i * 3] - lx, vz = T.pos[i * 3 + 2] - lz;
    if (vx < -0.2 || vx > 1.2 || vz < -0.2 || vz > 1.2 || T.pos[i * 3 + 1] < floor) continue;   // (not the caves under it)
    o.push([T.pos[i * 3 + 1], T.mat[i * 4] + T.mat[i * 4 + 1] + T.mat[i * 4 + 2] + T.mat[i * 4 + 3] - 1, T.col[i * 3], T.col[i * 3 + 1], T.col[i * 3 + 2]]);
  }
  return o;
};
// Blade roots (rise = 0) of the turf meshes inside the block column (x, z), below height top.
const BLADES = ([x, z, top]) => {
  let n = 0, all = 0;
  for (const m of BF.scene.children) {
    if (!m.userData.turf) continue;
    const P = m.geometry.attributes.position.array, R = m.geometry.attributes.rise.array;
    for (let i = 0; i < P.length; i += 3) {
      if (R[i] || R[i + 1] || R[i + 2]) continue;
      all++;
      const wx = P[i] + m.position.x - x, wz = P[i + 2] + m.position.z - z;
      if (wx > 0.1 && wx < 0.9 && wz > 0.1 && wz < 0.9 && P[i + 1] < top) n++;
    }
  }
  return { n, all };
};

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  {
    const { pg, errors } = await boot(b, 'real');
    check(await pg.evaluate(() => !!(BF.real.on && BF.real.turf)), 'the look is on and the turf module is loaded');
    // bare earth has a texture of its own: lumps with height (not a flat tone), and a few stones
    const soil = await pg.evaluate(() => { const d = BF.real.soilTexture().image.data; let lo = 255, hi = 0, st = 0; for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i + 2]); hi = Math.max(hi, d[i + 2]); if (d[i + 1] > 128) st++; } return { lo, hi, st: st / (d.length / 4) }; });
    check(soil.hi - soil.lo > 120 && soil.st > 0.002 && soil.st < 0.1, 'the soil texture has relief and a few stones', soil);
    // a flat stretch of grass away from a chunk border, cleared of plants; the player stands over it
    const spot = await pg.evaluate(() => {
      const W = BF.world, B = BF.B, p = BF.player.position;
      for (let r = 0; r < 70; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz, lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
        if (lx < 4 || lx > 9 || lz < 4 || lz > 11) continue;
        const y = W.heightAt(x, z);
        let ok = true;
        for (let a = -2; a <= 5 && ok; a++) for (let c = -2; c <= 2 && ok; c++) {
          if (W.heightAt(x + a, z + c) !== y || W.getBlock(x + a, y, z + c) !== B.grass) ok = false;
          for (let d = 1; d < 4 && ok; d++) if (W.getBlock(x + a, y - d, z + c) !== B.dirt && W.getBlock(x + a, y - d, z + c) !== B.stone) ok = false;
        }
        if (!ok) continue;
        for (let a = -3; a <= 6; a++) for (let c = -3; c <= 3; c++) for (let d = 1; d < 4; d++) if (W.getBlock(x + a, y + d, z + c)) W.setBlock(x + a, y + d, z + c, 0);
        W.flushDirty();
        return [x, y, z];
      }
      return null;
    });
    check(!!spot, 'found a flat stretch of grass');
    if (spot) {
      const [x, y, z] = spot;
      await pg.evaluate(([x, y, z]) => { clearInterval(window.__hold); window.__hold = setInterval(() => { BF.player.position.set(x + 1.5, y + 3.2, z + 4.5); BF.player.setLook(0, -0.8); }, 20); }, spot);
      await pg.waitForFunction(() => BF.real.turf.stats().tufts > 500, null, { timeout: 60000 }).catch(() => {});
      const st0 = await pg.evaluate(() => BF.real.turf.stats());
      check(st0.tufts > 500, 'short blades of grass stand on the turf near the player', st0);
      const whole = await pg.evaluate(COLUMN, [x, z, y - 4]);
      check(whole.length >= 4 && whole.every(v => v[1] > 0.99), 'untouched grass is turf at every vertex', whole);
      const b0 = await pg.evaluate(BLADES, [x, z, y + 2]);
      check(b0.n > 0, 'and carries blades', b0);

      // one block dug, and a shaft three deep
      await pg.evaluate(([x, y, z]) => { const W = BF.world; W.setBlock(x, y, z, 0); for (let d = 0; d < 3; d++) W.setBlock(x + 3, y - d, z, 0); W.flushDirty(); }, spot);
      await pg.waitForTimeout(1500);
      if (out) await pg.screenshot({ path: path.join(out, 'turf-dug.png') });
      const hole = await pg.evaluate(COLUMN, [x, z, y - 4]), low = hole.filter(v => v[0] < y + 0.6), high = hole.filter(v => v[0] >= y + 0.6);
      check(low.length >= 4 && low.every(v => v[1] < 0.01), 'the floor of a dug hole is bare soil', low);
      check(low.every(v => v[2] > v[3] * 1.05), 'and brown, not green', low);
      // (the rim is a rough edge, not a line: the top's rim vertices carry a little soil, the wall's top vertices are the sward's lip)
      check(high.some(v => v[1] > 0.99) && high.some(v => v[1] > 0.8 && v[1] < 0.95) && high.every(v => v[1] > 0.8), 'its rim is turf with a little soil worked in, for a rough edge', high);
      const shaft = await pg.evaluate(COLUMN, [x + 3, z, y - 4]), walls = shaft.filter(v => v[0] < y + 0.6);
      check(walls.length >= 12 && walls.every(v => v[1] < 0.01 && v[2] > v[3]), 'the walls of a shaft are soil all the way up, with no turf', walls);
      check(shaft.some(v => v[0] >= y + 0.6 && v[1] > 0.99), 'and the ground around its mouth is still turf');
      const b1 = await pg.evaluate(BLADES, [x, z, y + 0.6]), b2 = await pg.evaluate(BLADES, [x + 3, z, y + 0.6]);
      check(b1.n === 0 && b2.n === 0 && b1.all > 0, 'no blades grow in the hole or the shaft', [b1, b2]);
      const far = await pg.evaluate(COLUMN, [x + 1, z + 2, y - 4]);
      check(far.every(v => v[1] > 0.99), 'grass a block away is untouched', far);

      // the game's grass spreading turns the hole's floor back into grass: the turf comes back
      const grew = await pg.evaluate(([x, y, z]) => { const r = BF.grass.check(x, y - 1, z); BF.world.flushDirty(); return r; }, spot);
      check(grew, 'grass spreads onto the sunlit soil of the hole (js/grass.js)');
      await pg.waitForTimeout(1500);
      const healed = await pg.evaluate(COLUMN, [x, z, y - 4]);
      check(healed.length >= 4 && healed.every(v => v[1] > 0.99), 'and the hole is turf again, floor and sides', healed);
      const b3 = await pg.evaluate(BLADES, [x, z, y + 0.6]);
      check(b3.n > 0, 'with blades on it', b3);
      if (out) await pg.screenshot({ path: path.join(out, 'turf-regrown.png') });
    }
    check(errors.length === 0, 'no page or shader errors with the look on', errors);
    await pg.close();
  }
  {
    const { pg, errors } = await boot(b, 'blocks');
    check(await pg.evaluate(() => !BF.real.on && !BF.real.turf && !BF.scene.children.some(c => c.userData && c.userData.turf)), 'with the look off the turf module does not run');
    check(errors.length === 0, 'no page errors with the look off', errors);
    await pg.close();
  }
  await b.close();
  console.log(fails ? `FAILED (${fails})` : 'PASSED');
  process.exit(fails ? 1 : 0);
})();
