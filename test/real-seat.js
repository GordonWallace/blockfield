// @ci integration suite=world timeout=300
// The realistic look (1.6) draws natural ground as a smooth surface, so on a slope the ground under a plant is not at the top of its
// block. The mesher (js/real/mesh.js) writes into each flora record how far the surface is from the record's y and how it slopes
// (BF.real.seat reads it), and the placer (js/real/lod.js) stands the plant on the surface: a ground plant leans with the slope, a
// tree stays upright and goes down until its downhill side is in the ground. On flat ground nothing changes.
// NODE_PATH=$(npm root -g) node test/real-seat.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
(async () => {
  let bad = 0;
  const check = (ok, what, got) => { console.log((ok ? 'ok ' : 'FAIL ') + what + (got !== undefined ? ': ' + JSON.stringify(got) : '')); if (!ok) bad++; };
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 480, height: 300 } });
  pg.on('pageerror', e => { console.log('PAGEERROR', e.stack || e.message); bad++; });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&look=real#seed123gen4v10');
  await lib.ready(pg);
  await pg.waitForTimeout(3000);
  // a slope of grass rising one block per block to the north (-z) with a flat foot, ferns on both, and every list the placer is handed
  const at = await pg.evaluate(() => {
    BF.player.start(); BF.player.setGameMode('creative'); BF.mobs.spawning = false;
    const R = BF.real, place = R.flora.place;
    window.__recs = new Map();
    R.flora.place = (key, ox, oz, F) => { __recs.set(key, { ox, oz, F: F ? Array.from(F) : [] }); return place(key, ox, oz, F); };
    const W = BF.world, p = BF.player.position, X = Math.floor(p.x), Z = Math.floor(p.z), gy = W.heightAt(X, Z) + 8;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -10; dz <= 6; dz++) {
      const h = Math.max(0, Math.min(5, -dz - 1));
      for (let k = -1; k <= 12; k++) W.setBlock(X + dx, gy + k, Z + dz, k <= h ? BF.B.grass : 0);
    }
    for (const dz of [-4, -3, 3]) W.setBlock(X, gy + Math.max(0, -dz - 1) + 1, Z + dz, BF.B.fern);
    BF.player.teleport(X + 0.5, gy + 2, Z + 4.5);
    return { X, Z, gy };
  });
  await pg.waitForTimeout(4000);
  const got = await pg.evaluate(({ X, Z, gy }) => {
    const R = BF.real, s = [0, 0, 0], ferns = {}, trees = [];
    for (const { ox, oz, F } of __recs.values()) for (let o = 0; o < F.length; o += 8) {
      const x = ox + F[o], z = oz + F[o + 2], kind = F[o + 3];
      R.seat(F[o + 7], s);
      if (kind === 2 && Math.floor(x) === X && F[o + 4] === BF.B.fern && Math.abs(z - Z) < 8) ferns[Math.floor(z) - Z] = { y: F[o + 1] - gy, dy: s[0], gx: s[1], gz: s[2], light: F[o + 7] % 256 };
      if (kind === 0 || kind === 4) trees.push([s[0], Math.hypot(s[1], s[2]), F[o + 1] % 1]);
    }
    // the placer's instances of ground plants near the slope: how far each one's up axis is from straight up
    let leaning = 0, upright = 0;
    for (const m of R.scene.children) {
      if (!m.userData.rlod || !m.isInstancedMesh) continue;
      const a = m.instanceMatrix.array;
      for (let i = 0; i < a.length; i += 16) {
        const x = a[i + 12] + m.position.x, z = a[i + 14] + m.position.z;
        if (Math.floor(x) !== X) continue;
        const l = Math.hypot(a[i + 4], a[i + 5], a[i + 6]), tilt = Math.acos(a[i + 5] / l);
        // (a turned matrix must still be a turn: its axes square to each other and as long as each other)
        const dot = a[i] * a[i + 4] + a[i + 1] * a[i + 5] + a[i + 2] * a[i + 6], lx = Math.hypot(a[i], a[i + 1], a[i + 2]);
        if (Math.abs(dot) > 1e-3 || Math.abs(lx - l) > 1e-3) return { broken: [dot, lx, l] };
        if (Math.floor(z) - Z === -4 || Math.floor(z) - Z === -3) { if (tilt > 0.2 && tilt < 0.75 && a[i + 6] > 0) leaning++; }
        else if (Math.floor(z) - Z === 3 && tilt < 1e-6) upright++;
      }
    }
    return { ferns, trees, leaning, upright };
  }, at);
  const f = got.ferns || {};
  check(!got.broken, 'a leaning plant is turned, not sheared', got.broken);
  check(f[3] && f[3].dy === 0 && f[3].gx === 0 && f[3].gz === 0, 'a plant on flat ground stays where it was', f[3]);
  for (const dz of [-4, -3]) {
    const r = f[dz];
    check(r && r.y % 1 === 0, 'the record keeps its block height (slope cell ' + dz + ')', r);
    check(r && r.gz < -0.6 && r.gz > -1.01 && Math.abs(r.gx) < 0.15, 'the ground under a plant on the slope rises to the north', r);
    check(r && r.dy > -0.8 && r.dy < 0.3, 'and is within a block of the block top', r);
    check(r && r.light < 256 && (r.light & 15) > 0, 'its light is still in the low byte', r);
  }
  check(got.leaning >= 2, 'the plants on the slope are drawn leaning downhill (to the south)', got.leaning);
  check(got.upright >= 1, 'the plant on the flat is drawn upright', got.upright);
  const tr = got.trees || [];
  check(tr.length > 0 && tr.every(t => t[2] === 0), 'every tree record keeps its block height', tr.length);
  check(tr.every(t => t[1] > 0.05 || Math.abs(t[0]) < 0.04), 'a tree on flat ground stays where it was', tr.filter(t => !(t[1] > 0.05 || Math.abs(t[0]) < 0.04)).slice(0, 4));
  check(tr.every(t => t[0] < 0.35), 'no tree is lifted far above its block', tr.filter(t => t[0] >= 0.35).slice(0, 4));
  console.log('trees ' + tr.length + ', on a slope ' + tr.filter(t => t[1] > 0.05).length + ', lowered ' + tr.filter(t => t[0] < -0.04).length);
  await b.close();
  console.log(bad ? 'FAILED ' + bad : 'PASS');
  process.exit(bad ? 1 : 0);
})();
