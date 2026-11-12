// @ci baseline suite=world timeout=480
// The badlands' banded clay in the realistic look (1.6, js/real/mesh.js, js/real/terrain.js, js/world.js clayColumns): the terracotta
// the world was generated with is smooth ground, drawn as level beds of sediment by the material (a `strat` share per vertex, the
// bands looked up by height), and terracotta that was placed stays a cube:
//  - every terracotta block of an untouched badlands hillside is the band generated there, at or under the generated ground height
//    (the rule the mesher tells made from placed by), and none of it is left to the cube pass;
//  - a terracotta block placed on the ground, and one of another colour set into the hillside, are cubes;
//  - a band dug out leaves the block's own colour to drop, and the same band put back is ground again.
// Usage: node test/real-strata.js [outDir for screenshots]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.argv[2] || null;
let fails = 0;
const check = (ok, what, d) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && d !== undefined ? ' ' + JSON.stringify(d).slice(0, 600) : '')); if (!ok) fails++; };

// The cube pass's vertices inside the block cell (x, y, z), and the smooth pass's vertices with a share of banded clay around it.
const CELL = ([x, y, z]) => {
  const W = BF.world, c = W.chunkAt(x, z), A = W.meshArrays(c), lx = x - c.cx * 16, lz = z - c.cz * 16, o = { cube: 0, beds: 0 };
  if (A.S) for (let i = 0; i < A.S.pos.length / 3; i++) {
    const vx = A.S.pos[i * 3] - lx, vy = A.S.pos[i * 3 + 1] - y, vz = A.S.pos[i * 3 + 2] - lz;
    if (vx > -0.01 && vx < 1.01 && vy > -0.01 && vy < 1.01 && vz > -0.01 && vz < 1.01) o.cube++;
  }
  if (A.T) for (let i = 0; i < A.T.pos.length / 3; i++) {
    const vx = A.T.pos[i * 3] - lx, vy = A.T.pos[i * 3 + 1] - y, vz = A.T.pos[i * 3 + 2] - lz;
    if (vx > -0.3 && vx < 1.3 && vy > -0.3 && vy < 1.3 && vz > -0.3 && vz < 1.3 && A.T.strat[i * 2] > 0.5) o.beds++;
  }
  return o;
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
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true); BF.real.quality.auto = false; BF.world.setViewDist(4); BF.sky.setTime(0.25); });
  await pg.waitForTimeout(1500);
  const settle = async () => {
    await pg.waitForTimeout(2500);
    await pg.waitForFunction(() => BF.world.queueLength === 0, null, { timeout: 180000 }).catch(() => {});
    await pg.waitForTimeout(1000);
  };
  const hold = (x, y, z, yaw, pitch) => pg.evaluate(([x, y, z, yaw, pitch]) => { clearInterval(window.__hold); window.__hold = setInterval(() => { BF.player.position.set(x, y, z); BF.player.setLook(yaw, pitch); }, 20); }, [x, y, z, yaw, pitch]);

  // ---- a steep hillside in the badlands: the ground falls 6 blocks or more over 4 columns (dx, dz: the way down)
  const site = await pg.evaluate(() => {
    const p = BF.player.position, g = BF.worldgen, o = [0];
    let best = null;
    for (let r = 64; r < 6000 && !(best && best.drop >= 9); r += 24) for (let a = 0; a < 32; a++) {
      const x0 = Math.floor(p.x + r * Math.cos(a * Math.PI / 16)), z0 = Math.floor(p.z + r * Math.sin(a * Math.PI / 16));
      if (!g.strataAt(x0, z0, o)) continue;
      for (let d = -20; d <= 20; d += 2) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = x0 + d, z = z0 + d;
        if (!g.strataAt(x, z, o) || !g.strataAt(x + 8 * dx, z + 8 * dz, o)) continue;
        const h0 = g.heightAt(x, z), h1 = g.heightAt(x + 4 * dx, z + 4 * dz);
        if (h0 - h1 >= 6 && h1 > BF.SEA + 2 && (!best || h0 - h1 > best.drop)) best = { x, z, dx, dz, h0, h1, drop: h0 - h1 };
      }
    }
    return best;
  });
  check(!!site, 'found a steep hillside in the badlands', site);
  if (site) {
    await hold(site.x + 15 * site.dx + 0.5, site.h1 + 6, site.z + 15 * site.dz + 0.5, Math.atan2(site.dx, site.dz), -0.2);
    await settle();
    if (out) await pg.screenshot({ path: path.join(out, 'strata-hillside.png') });

    // the rule against the world as generated, over the loaded chunks, and what the mesher made of it
    const gen = await pg.evaluate(() => {
      const W = BF.world, TB = BF.real.meshTables(), g = BF.worldgen, ST = g.strata(), o = { clay: 0, placed: 0, some: [], cubes: 0, beds: 0, chunks: 0, attr: 0 }, q = [0];
      for (const c of W.chunks.values()) {
        if (c.mesh !== true) continue;
        const ox = c.cx * 16, oz = c.cz * 16;
        if (!g.strataAt(ox + 8, oz + 8, q)) continue;
        o.chunks++;
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
          const v = g.strataAt(ox + x, oz + z, q), h = q[0];
          for (let y = c.y0; y < c.y1; y++) {
            const b = W.getBlock(ox + x, y, oz + z);
            if (!TB.STRAT[b]) continue;
            o.clay++;
            if (!v || y > h || ST[(y + v + 63) & 63] !== b) { o.placed++; if (o.some.length < 5) o.some.push([ox + x, y, oz + z, BF.blocks[b].name, h, v]); }
          }
        }
        const A = W.meshArrays(c);
        // (a cube's vertices carry its tile; the cube pass must hold none of the clay's)
        if (A.T && A.T.strat) for (let i = 0; i < A.T.strat.length; i += 2) if (A.T.strat[i] > 0.9) o.beds++;
        for (const m of c.meshes) if (m.geometry.attributes.strat) o.attr++;
      }
      return o;
    });
    check(gen.chunks >= 4 && gen.clay > 2000, 'the hillside is banded clay (' + gen.clay + ' blocks in ' + gen.chunks + ' chunks)', gen);
    check(gen.placed === 0, 'every terracotta block there is the band generated at its height, at or under the generated ground', gen);
    check(gen.beds > 200 && gen.attr >= 4, 'the smooth ground carries the clay\'s share and shift to the material (' + gen.beds + ' vertices)', gen);

    // a band showing on the slope: the topmost terracotta of a column part way down
    const spot = await pg.evaluate(s => {
      const W = BF.world, TB = BF.real.meshTables();
      for (let d = 0; d <= 6; d++) for (let e = -3; e <= 3; e++) {
        const x = s.x + d * s.dx + e * s.dz, z = s.z + d * s.dz + e * s.dx, lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
        if (lx < 3 || lx > 12 || lz < 3 || lz > 12) continue;
        const y = W.heightAt(x, z), id = W.getBlock(x, y, z);
        if (TB.STRAT[id] && !W.getBlock(x, y + 1, z) && TB.STRAT[W.getBlock(x, y - 1, z)]) return { x, y, z, id, name: BF.blocks[id].name };
      }
      return null;
    }, site);
    check(!!spot, 'a band at the surface of the slope', spot);
    if (spot) {
      const { x, y, z, id } = spot;
      const c0 = await pg.evaluate(CELL, [x, y, z]);
      check(c0.cube === 0 && c0.beds >= 4, 'it is smooth ground, not a cube', c0);
      // placed on the ground: the same block as the band under it, and another colour
      const other = await pg.evaluate(id => { const B = BF.B; return id === B.white_terracotta ? B.yellow_terracotta : B.white_terracotta; }, id);
      await pg.evaluate(([x, y, z, id]) => { BF.world.setBlock(x, y + 1, z, id); BF.world.flushDirty(); }, [x, y, z, id]);
      const c1 = await pg.evaluate(CELL, [x, y + 1, z]);
      check(c1.cube >= 8, 'terracotta placed on the ground is a cube (above the ground the world was made with)', c1);
      // set into the hillside in place of the band: another colour is a cube, the band itself is ground again
      await pg.evaluate(([x, y, z, other]) => { BF.world.setBlock(x, y + 1, z, 0); BF.world.setBlock(x, y, z, 0); BF.world.flushDirty(); BF.world.setBlock(x, y, z, other); BF.world.flushDirty(); }, [x, y, z, other]);
      const c2 = await pg.evaluate(CELL, [x, y, z]);
      check(c2.cube >= 8, 'terracotta of another colour set into the hillside is a cube', c2);
      await hold(x + 4 * site.dx + 0.5, y + 3.2, z + 4 * site.dz + 0.5, Math.atan2(site.dx, site.dz), -0.45);
      await pg.waitForTimeout(1500);
      if (out) await pg.screenshot({ path: path.join(out, 'strata-placed-cube.png') });
      await pg.evaluate(([x, y, z, id]) => { BF.world.setBlock(x, y, z, id); BF.world.flushDirty(); }, [x, y, z, id]);
      const c3 = await pg.evaluate(CELL, [x, y, z]);
      check(c3.cube === 0 && c3.beds >= 4, 'the band put back where it was dug is ground again', c3);
      // what is dug out of a band is that band's block
      const drop = await pg.evaluate(([x, y, z]) => { const id = BF.world.getBlock(x, y, z), d = BF.rollDrops(id, BF.rand && BF.rand.of ? undefined : undefined); return { name: BF.blocks[id].name, drops: d.length === 1 && d[0].id === id ? BF.blocks[id].name : d }; }, [x, y, z]);
      check(/terracotta$/.test(drop.name) && drop.drops === drop.name, 'the band is still its terracotta block, and drops itself (' + drop.name + ')', drop);
    }
  }
  check(errors.length === 0, 'no page or shader errors', errors);
  await b.close();
  console.log(fails ? `FAILED (${fails})` : 'PASSED');
  process.exit(fails ? 1 : 0);
})();
