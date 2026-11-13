// @ci baseline suite=world timeout=300
// Head room in the realistic look (1.6, js/real/mesh.js): the smooth ground never comes between the blocks and the player's eye.
// A tunnel two blocks high and one wide with a corner in it is dug under flat ground, and the player stands hard into its corners
// and against its walls, where the box stops at the blocks:
//  - the ground's surface stays clear of every place the eye can be, by more than the near plane's reach;
//  - seen from those places, looking every way, nothing shows through the ground (only the ground drawn, over a marked background).
// Usage: node test/real-headroom.js [outDir for screenshots]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.argv[2] || null;
let fails = 0;
const check = (ok, what, d) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && d !== undefined ? ' ' + JSON.stringify(d).slice(0, 600) : '')); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 480, height: 300 } })).newPage();
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { try { localStorage.removeItem('bf.look'); } catch (_) { /* none */ } });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&debugfeed=off&look=real#seed123gen4v10');
  await pg.waitForFunction(() => globalThis.BF && !BF.preparing && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30, null, { timeout: 240000 });
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true); BF.real.quality.auto = false; });
  await pg.waitForTimeout(1500);

  // the tunnel: 5 blocks along x, then 4 along z, floor 6 below the surface, inside one chunk, in solid natural ground
  const spot = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, t = BF.real.meshTables();
    for (const c of W.chunks.values()) {
      if (c.mesh !== true || Math.abs(c.cx * 16 - p.x) > 48 || Math.abs(c.cz * 16 - p.z) > 48) continue;
      const x = c.cx * 16 + 4, z = c.cz * 16 + 5, y = W.heightAt(x, z) - 7;
      let ok = true;
      for (let dx = -2; dx <= 7 && ok; dx++) for (let dz = -2; dz <= 6 && ok; dz++) for (let dy = -2; dy <= 4 && ok; dy++) if (!t.NATB[W.getBlock(x + dx, y + dy, z + dz)]) ok = false;
      if (!ok) continue;
      const cells = [];
      for (let a = 0; a < 5; a++) cells.push([x + a, z]);
      for (let a = 1; a < 5; a++) cells.push([x + 4, z + a]);
      for (const [cx, cz] of cells) { W.setBlock(cx, y + 1, cz, 0); W.setBlock(cx, y + 2, cz, 0); }
      W.flushDirty();
      return { y: y + 1, cells };
    }
    return null;
  });
  check(!!spot, 'dug a tunnel two high and one wide with a corner, in solid ground');
  if (spot) {
    // 1. the surface against the places the eye can be: the corners and middle of each cell at 0.3 from its sides, standing
    // (1.78 and the bob's 0.06), sneaking (1.63) and at the top of a jump (the box's top at the roof: 0.17 under it)
    const gap = await pg.evaluate(({ y, cells }) => {
      const W = BF.world, c = W.chunkAt(cells[0][0], cells[0][1]), T = W.meshArrays(c).T, P = T.pos, I = T.ind, ox = c.cx * 16, oz = c.cz * 16;
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      // distance from p to triangle a b c (Ericson)
      const dist = (p, a, b, c) => {
        const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
        let q;
        const at = (v, w) => [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
        if (d1 <= 0 && d2 <= 0) q = a;
        else {
          const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
          if (d3 >= 0 && d4 <= d3) q = b;
          else {
            const vc = d1 * d4 - d3 * d2;
            if (vc <= 0 && d1 >= 0 && d3 <= 0) q = at(d1 / (d1 - d3), 0);
            else {
              const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
              if (d6 >= 0 && d5 <= d6) q = c;
              else {
                const vb = d5 * d2 - d1 * d6;
                if (vb <= 0 && d2 >= 0 && d6 <= 0) q = at(0, d2 / (d2 - d6));
                else {
                  const va = d3 * d6 - d5 * d4;
                  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
                  else { const dn = 1 / (va + vb + vc); q = at(vb * dn, vc * dn); }
                }
              }
            }
          }
        }
        const d = sub(p, q);
        return Math.hypot(d[0], d[1], d[2]);
      };
      const tris = [];
      for (let t = 0; t < I.length; t += 3) {
        const v = n => [P[I[t + n] * 3] + ox, P[I[t + n] * 3 + 1], P[I[t + n] * 3 + 2] + oz];
        const a = v(0), b = v(1), d = v(2);
        if (Math.max(a[1], b[1], d[1]) < y - 1 || Math.min(a[1], b[1], d[1]) > y + 4) continue;
        tris.push([a, b, d]);
      }
      let min = 9, where = null, n = 0;
      for (const [cx, cz] of cells) for (const ex of [0.3, 0.5, 0.7]) for (const ez of [0.3, 0.5, 0.7]) for (const ey of [1.63, 1.78, 1.84]) {
        const p = [cx + ex, y + ey, cz + ez];
        n++;
        for (const t of tris) { const d = dist(p, t[0], t[1], t[2]); if (d < min) { min = d; where = p; } }
      }
      return { min: +min.toFixed(3), where, n, tris: tris.length };
    }, spot);
    // (the near plane is 0.05 away and its corners 0.1: js/main.js, js/view.js)
    check(gap.tris > 50 && gap.min > 0.105, 'the ground stays clear of the eye wherever the player can stand in the tunnel (nearest ' + gap.min + ' of a block, ' + gap.n + ' places)', gap);

    // 2. seen from the corners of the tunnel's cells, looking every way: nothing but ground
    await pg.evaluate(() => {
      window.holes = () => {
        const R = BF.renderer, s = R.getSize(new THREE.Vector2()), sc = BF.scene;
        if (!window.__rt || window.__rt.width !== s.x) window.__rt = new THREE.WebGLRenderTarget(s.x, s.y);
        const hidden = [], bg = sc.background, fog = sc.fog;
        for (const c of sc.children) if (c.visible && !(c.userData && c.userData.chunk)) { c.visible = false; hidden.push(c); }
        sc.background = new THREE.Color(1, 0, 1); sc.fog = null;
        R.setRenderTarget(window.__rt); R.render(sc, BF.camera); R.setRenderTarget(null);
        for (const c of hidden) c.visible = true;
        sc.background = bg; sc.fog = fog;
        const px = new Uint8Array(s.x * s.y * 4);
        R.readRenderTargetPixels(window.__rt, 0, 0, s.x, s.y, px);
        let n = 0;
        for (let i = 0; i < s.x * s.y; i++) if (px[i * 4] > 200 && px[i * 4 + 1] < 70 && px[i * 4 + 2] > 200) n++;
        return n;
      };
    });
    const corner = spot.cells[4], views = [];
    for (const [ex, ez] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) views.push([corner[0] + ex, spot.y, corner[1] + ez]);
    views.push([spot.cells[2][0] + 0.5, spot.y, spot.cells[2][1] + 0.3], [spot.cells[6][0] + 0.7, spot.y, spot.cells[6][1] + 0.5]);
    let worst = 0, at = null, shot = false;
    for (const v of views) for (let a = 0; a < 8; a++) for (const pitch of [0, 0.8]) {
      await pg.evaluate(([x, y, z, yaw, pitch]) => { clearInterval(window.__hold); const f = () => { BF.player.position.set(x, y, z); BF.player.setLook(yaw, pitch); }; f(); window.__hold = setInterval(f, 15); }, [v[0], v[1], v[2], a * Math.PI / 4, pitch]);
      await pg.waitForTimeout(80);
      const n = await pg.evaluate(() => window.holes());
      if (n > worst) { worst = n; at = [v, a, pitch]; }
      if (out && !shot && (n > 0 || (a === 7 && pitch === 0.8 && v === views[views.length - 1]))) { shot = true; await pg.screenshot({ path: path.join(out, 'headroom.png') }); }
    }
    check(worst === 0, 'nothing shows through the ground from the tunnel\'s corners, looking every way (' + views.length * 16 + ' views)', { worst, at });
  }
  check(errors.length === 0, 'no page errors', errors);
  await b.close();
  console.log(fails ? `FAILED (${fails})` : 'PASSED');
  process.exit(fails ? 1 : 0);
})();
