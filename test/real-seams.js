// @ci baseline suite=world timeout=480
// No see-through gaps in the realistic look's ground (1.6, js/real/mesh.js, js/world.js meshJob):
//  - the smooth ground of neighbouring chunks meets along their border, also where a bent trunk stands by it and where the badlands
//    (whose terracotta is ground) meet a biome where terracotta is a building block: what is ground is decided by column;
//  - a chunk meshed again while a neighbour's blocks are not loaded keeps its ground along that border where it was, and is meshed
//    again when they arrive;
//  - farmland is tilled ground: the smooth pass draws it, in furrows, closed against the dirt beside it, and the cube pass leaves it out.
// Usage: node test/real-seams.js [outDir for screenshots]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.argv[2] || null;
let fails = 0;
const check = (ok, what, d) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && d !== undefined ? ' ' + JSON.stringify(d).slice(0, 600) : '')); if (!ok) fails++; };

// Open edges of the smooth ground over all loaded chunks, meshed afresh: edges only one triangle uses, away from the rim of the loaded
// area and not on the block grid (against a built block the ground ends on the grid, at the block's own face).
const OPEN = () => {
  const W = BF.world, E = new Map(), q = v => Math.round(v * 64), loaded = new Set();
  for (const c of W.chunks.values()) {
    if (c.mesh !== true) continue;
    loaded.add(c.cx + ',' + c.cz);
    const T = W.meshArrays(c).T;
    if (!T) continue;
    const ox = c.cx * 16, oz = c.cz * 16, P = T.pos, I = T.ind;
    const key = i => q(P[i * 3] + ox) + ',' + q(P[i * 3 + 1]) + ',' + q(P[i * 3 + 2] + oz);
    for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = key(I[t + e]), b = key(I[t + (e + 1) % 3]);
      if (a === b) continue;
      const k = a < b ? a + '|' + b : b + '|' + a;
      E.set(k, (E.get(k) || 0) + 1);
    }
  }
  const open = [], grid = v => Math.abs(v - Math.round(v)) < 0.02;
  for (const [k, n] of E) if (n === 1) {
    const [a, b] = k.split('|').map(s => s.split(',').map(v => v / 64));
    if (a.every(grid) && b.every(grid)) continue;
    const cx = Math.floor((a[0] + b[0]) / 32), cz = Math.floor((a[2] + b[2]) / 32);
    let rim = false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!loaded.has((cx + dx) + ',' + (cz + dz))) rim = true;
    if (!rim) open.push(a.concat(b).map(v => +v.toFixed(2)));
  }
  return { chunks: loaded.size, open: open.length, some: open.slice(0, 6) };
};

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).slice(0, 400)); });
  pg.on('console', m => { if (m.type() === 'error' && /shader|program|BF\.real/i.test(m.text())) { errors.push(m.text()); console.log('console error: ' + m.text().slice(0, 600)); } });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { try { localStorage.removeItem('bf.look'); } catch (_) { /* none */ } });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&debugfeed=off&look=real#seed123gen4v10');
  await pg.waitForFunction(() => globalThis.BF && !BF.preparing && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30, null, { timeout: 240000 });
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true); BF.real.quality.auto = false; BF.world.setViewDist(4); });
  await pg.waitForTimeout(1500);
  const settle = async () => {
    await pg.waitForTimeout(2500);
    await pg.waitForFunction(() => BF.world.queueLength === 0, null, { timeout: 180000 }).catch(() => {});
    await pg.waitForTimeout(1000);
  };
  const hold = (x, y, z, pitch) => pg.evaluate(([x, y, z, pitch]) => { clearInterval(window.__hold); window.__hold = setInterval(() => { BF.player.position.set(x, y, z); BF.player.setLook(0, pitch); }, 20); }, [x, y, z, pitch]);

  // ---- 1. farmland, by the spawn: a flat stretch of grass, three blocks of it tilled beside a block of bare dirt
  const spot = await pg.evaluate(() => {
    const W = BF.world, B = BF.B, p = BF.player.position;
    for (let r = 0; r < 70; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz, lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
      if (lx < 4 || lx > 8 || lz < 4 || lz > 11) continue;
      const y = W.heightAt(x, z);
      let ok = true;
      for (let a = -2; a <= 5 && ok; a++) for (let c = -2; c <= 2 && ok; c++) if (W.heightAt(x + a, z + c) !== y || W.getBlock(x + a, y, z + c) !== B.grass || !BF.real.meshTables().NATB[W.getBlock(x + a, y - 1, z + c)]) ok = false;
      if (!ok) continue;
      for (let a = -3; a <= 6; a++) for (let c = -3; c <= 3; c++) for (let d = 1; d < 4; d++) if (W.getBlock(x + a, y + d, z + c)) W.setBlock(x + a, y + d, z + c, 0);
      W.setBlock(x, y, z, B.dirt); W.setBlock(x + 1, y, z, B.farmland); W.setBlock(x + 2, y, z, B.farmland); W.setBlock(x + 3, y, z, B.farmland_dry);
      W.flushDirty();
      return [x, y, z];
    }
    return null;
  });
  check(!!spot, 'found a flat stretch of grass and tilled part of it');
  if (spot) {
    const [x, y, z] = spot;
    await hold(x + 1.5, y + 3.4, z + 3.5, -0.9);
    await pg.waitForTimeout(1500);
    if (out) await pg.screenshot({ path: path.join(out, 'seams-farmland.png') });
    const f = await pg.evaluate(([x, y, z]) => {
      const W = BF.world, c = W.chunkAt(x, z), A = W.meshArrays(c), T = A.T, S = A.S, lx = x - c.cx * 16, lz = z - c.cz * 16;
      const o = { till: [], tops: 0, cube: 0, shown: false };
      // the ground's vertices over the three tilled blocks and over the dirt block
      for (let i = 0; i < T.pos.length / 3; i++) {
        const vx = T.pos[i * 3] - lx, vy = T.pos[i * 3 + 1], vz = T.pos[i * 3 + 2] - lz;
        if (vz < -0.1 || vz > 1.1 || Math.abs(vy - (y + 1)) > 0.3) continue;
        if (vx > 1.9 && vx < 2.1) o.till.push(T.till[i]);
        if (vx > -0.1 && vx < 4.1) o.tops++;
      }
      // the cube pass draws nothing in the tilled cells
      if (S) for (let i = 0; i < S.pos.length / 3; i++) {
        const vx = S.pos[i * 3] - lx, vy = S.pos[i * 3 + 1], vz = S.pos[i * 3 + 2] - lz;
        if (vx > 1.01 && vx < 3.99 && vz > 0.01 && vz < 0.99 && vy > y - 0.01 && vy < y + 1.01) o.cube++;
      }
      for (const m of c.meshes) if (m.geometry.attributes.till) o.shown = true;
      return o;
    }, spot);
    check(f.tops >= 10 && f.cube === 0, 'the smooth pass draws farmland and the cube pass leaves it out', f);
    check(f.till.length >= 2 && f.till.every(v => v > 0.45 && v < 0.55), 'its top is marked as tilled soil, for the furrows (half and half along a row one block wide)', f);
    check(f.shown, 'and the chunk\'s ground carries the tilled share to the material');
    const seam = await pg.evaluate(OPEN);
    check(seam.open === 0, 'the ground is closed around the tilled blocks and across the chunks by the spawn (' + seam.chunks + ' chunks)', seam);

    // ---- 2. a chunk meshed again while a neighbour's blocks are not loaded (the ground's surface: caves below can't be guessed)
    const nb = await pg.evaluate(([x, y, z]) => {
      const W = BF.world, c = W.chunkAt(x, z), n = W.chunkC(c.cx + 1, c.cz);
      if (!n || n.mesh !== true) return null;
      const border = T => { const o = []; for (let i = 0; i < T.pos.length / 3; i++) if (T.pos[i * 3] > 15.4 && T.pos[i * 3 + 1] > y - 4) o.push([T.pos[i * 3], T.pos[i * 3 + 1], T.pos[i * 3 + 2]]); return o; };
      const before = border(W.meshArrays(c).T);
      W.chunks.delete(n.key);
      const during = border(W.meshArrays(c).T), flagged = W.nbMiss.has(c.key);
      W.chunks.set(n.key, n);
      const after = border(W.meshArrays(c).T);
      let moved = 0, far = 0;
      for (const v of before) { let d = 9; for (const u of during) d = Math.min(d, Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2])); if (d > 0.05) moved++; if (d > 0.6) far++; }
      return { n: before.length, moved, far, flagged, cleared: !W.nbMiss.has(c.key), same: after.length === before.length };
    }, spot);
    check(!!nb && nb.n >= 16, 'a chunk with a meshed neighbour to try it on', nb);
    if (nb) {
      check(nb.moved <= nb.n / 3 && nb.far === 0, 'meshed without a neighbour\'s blocks, the ground along that border stays where it was (' + nb.moved + ' of ' + nb.n + ' vertices moved)', nb);
      check(nb.flagged && nb.cleared && nb.same, 'and the chunk is marked to be meshed again when the blocks arrive', nb);
    }
  }

  // ---- 3. borders further out: savanna with bent acacia trunks, and the edge of the badlands
  const places = await pg.evaluate(() => {
    const p = BF.player.position, name = (x, z) => { try { return BF.worldgen.biomeAt(x, z).name; } catch (_) { return ''; } };
    let sav = null, bad = null;
    for (let r = 64; r < 3000 && !(sav && bad); r += 32) for (let a = 0; a < 24 && !(sav && bad); a++) {
      const x = Math.floor(p.x + r * Math.cos(a * Math.PI / 12)), z = Math.floor(p.z + r * Math.sin(a * Math.PI / 12)), n = name(x, z);
      if (!sav && n === 'Savanna') sav = [x, z];
      if (!bad && n === 'Badlands' && name(x - 24, z) !== 'Badlands') bad = [x - 12, z];   // (on the biome's edge)
    }
    return { sav, bad };
  });
  for (const [what, at] of [['savanna', places.sav], ['the edge of the badlands', places.bad]]) {
    check(!!at, 'found ' + what);
    if (!at) continue;
    await hold(at[0] + 0.5, 60, at[1] + 0.5, -1.2);
    await settle();
    const s = await pg.evaluate(OPEN);
    check(s.chunks >= 25 && s.open === 0, 'the ground of neighbouring chunks meets in ' + what + ' (' + s.chunks + ' chunks)', s);
    if (out) await pg.screenshot({ path: path.join(out, 'seams-' + what.split(' ').pop() + '.png') });
  }
  check(errors.length === 0, 'no page or shader errors', errors);
  await b.close();
  console.log(fails ? `FAILED (${fails})` : 'PASSED');
  process.exit(fails ? 1 : 0);
})();
