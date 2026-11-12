// @ci baseline suite=world
// The realistic look (1.6, docs/REALISTIC_CONTRACT.md): with ?look=real the page draws natural ground as the smooth terrain pass and
// trees through the flora placer, without errors; with ?look=blocks (and by default) nothing of it runs.
// Usage: NODE_PATH=$(npm root -g) node test/real-look.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

// The ground's shape, in the page: the seams between chunks, a dug shaft, and a built block on the ground.
const SHAPE = () => {
  const W = BF.world, t = BF.real.meshTables(), B = BF.B;
  const builtAt = (x, y, z) => { const b = W.getBlock(x, y, z); return !!b && !t.NATB[b] && !t.NAT[b] && (BF.OPAQUE[b] || b === B.farmland) && t.TREE[b] !== 2; };
  // 2. a shaft dug 3 deep, one block wide, and 3. a built block set on the ground beside it: on open natural ground away from the
  // chunk's border
  let spot = null;
  for (const c of BF.scene.children.filter(m => m.geometry && m.geometry.attributes.mat && m.userData.chunk).map(m => m.userData.chunk)) {
    for (let lz = 3; lz < 13 && !spot; lz++) for (let lx = 3; lx < 9 && !spot; lx++) {
      const x = c.cx * 16 + lx, z = c.cz * 16 + lz, y = W.heightAt(x, z);
      let ok = true;
      for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 5 && ok; dx++) {
        if (W.heightAt(x + dx, z + dz) !== y || BF.OPAQUE[W.getBlock(x + dx, y + 1, z + dz)]) ok = false;
        for (let d = 0; d < 4 && ok; d++) if (!t.NATB[W.getBlock(x + dx, y - d, z + dz)]) ok = false;
      }
      if (ok) spot = { c, x, y, z, lx, lz };
    }
    if (spot) break;
  }
  if (spot) {
    const { x, y, z } = spot;
    for (let d = -1; d < 3; d++) W.setBlock(x, y - d, z, 0);
    W.setBlock(x + 4, y + 1, z, B.crafting_table); W.setBlock(x + 5, y + 1, z, B.dirt);   // (the block stands against a step of ground)
  }
  // 1. seams: an edge on the rim of one chunk's ground is an edge of a neighbour's ground too (or lies along a built block, where
  // the quad against the block is left out)
  // (first a hard case, made here: ground that crosses the top of one chunk's loaded band right at its border with a taller neighbour)
  let made = null;
  for (const m0 of BF.scene.children) {
    const c = m0.userData && m0.userData.chunk, n = c && m0.geometry && m0.geometry.attributes.mat ? W.chunkC(c.cx + 1, c.cz) : null;
    if (!n || n.cx !== c.cx + 1 || n.y1 !== c.y1 || (spot && (c === spot.c || n === spot.c))) continue;
    let full = true;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 2; dx++) { const q = W.chunkC(c.cx + dx, c.cz + dz); if (!q || q.mesh !== true) full = false; }
    if (!full) continue;
    const bx = n.cx * 16, bz = c.cz * 16 + 8, top = c.y1;
    W.setBlock(bx - 1, top - 1, bz, B.dirt); W.setBlock(bx, top, bz, B.dirt); W.setBlock(bx, top + 1, bz, B.dirt);
    made = [bx, top, bz, n.y1 - c.y1];
    break;
  }
  W.flushDirty();
  const ms = BF.scene.children.filter(c => c.geometry && c.geometry.attributes.mat && c.userData.chunk);
  const key = (x, y, z) => Math.round(x * 64) + ',' + Math.round(y * 64) + ',' + Math.round(z * 64);
  const all = new Map(), per = [];
  for (const m of ms) {
    const p = m.geometry.attributes.position.array, ix = m.geometry.index.array, ox = m.position.x, oz = m.position.z, e = new Map();
    for (let q = 0; q < ix.length; q += 3) for (let a = 0; a < 3; a++) {
      const u = ix[q + a] * 3, v = ix[q + (a + 1) % 3] * 3;
      const P = [p[u] + ox, p[u + 1], p[u + 2] + oz], Q = [p[v] + ox, p[v + 1], p[v + 2] + oz];
      const ku = key(P[0], P[1], P[2]), kv = key(Q[0], Q[1], Q[2]), k = ku < kv ? ku + '|' + kv : kv + '|' + ku;
      const r = e.get(k);
      if (r) r.n++; else e.set(k, { n: 1, P, Q });
    }
    per.push([m.userData.chunk, e]);
    for (const [k, r] of e) all.set(k, (all.get(k) || 0) + r.n);
  }
  let rim = 0, open = 0; const ex = [];
  for (const [c, e] of per) {
    let full = true;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const n = W.chunkC(c.cx + dx, c.cz + dz); if (!n || n.mesh !== true) full = false; }
    if (!full) continue;
    for (const [k, r] of e) {
      if (r.n !== 1) continue;
      rim++;
      if (all.get(k) !== 1) continue;
      // along a built block? (both ends on the block grid, one of the 4 cells around the edge built)
      const P = r.P, Q = r.Q, grid = [...P, ...Q].every(v => Math.abs(v - Math.round(v)) < 1e-3);
      let built = false;
      if (grid) {
        const a = [0, 1, 2].find(i => Math.abs(P[i] - Q[i]) > 0.5), mid = [0, 1, 2].map(i => (P[i] + Q[i]) / 2), o = [0, 1, 2].filter(i => i !== a);
        for (let s = 0; s < 4; s++) { const cc = mid.slice(); cc[o[0]] -= s & 1 ? 0.5 : -0.5; cc[o[1]] -= s & 2 ? 0.5 : -0.5; if (builtAt(Math.floor(cc[0]), Math.floor(cc[1]), Math.floor(cc[2]))) built = true; }
      }
      if (!built) { open++; if (ex.length < 4) ex.push(k); }
    }
  }
  if (!spot) return { rim, open, ex, made, spot: null };
  const { c, x, y, z, lx, lz } = spot;
  const T = W.meshArrays(c).T, p = T.pos;
  // the shaft's walls: no vertex leans into the open column beside the eye (from a block above its floor up to its mouth)
  let lean = 0, walls = 0, pad = 0;
  for (let i = 0; i < p.length; i += 3) {
    const vx = p[i] - lx, vy = p[i + 1], vz = p[i + 2] - lz;
    if (vy > y - 1.1 && vy < y + 1.1 && vx > -0.3 && vx < 1.3 && vz > -0.3 && vz < 1.3) { walls++; lean = Math.max(lean, Math.min(vx, 1 - vx, vz, 1 - vz)); }
    // the block's 4 lower corners: the ground meets them exactly
    if (Math.abs(vy - (y + 1)) < 1e-4 && (Math.abs(vx - 4) < 1e-4 || Math.abs(vx - 5) < 1e-4) && (Math.abs(vz) < 1e-4 || Math.abs(vz - 1) < 1e-4)) pad++;
  }
  return { rim, open, ex, made, spot: [x, y, z], walls, lean, pad };
};

async function boot(b, look) {
  const pg = await (await b.newContext({ viewport: { width: 480, height: 300 } })).newPage();
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).slice(0, 400)); });
  pg.on('console', m => { if (m.type() === 'error' && /shader|program|BF\.real/i.test(m.text())) { errors.push(m.text()); console.log('console error: ' + m.text().slice(0, 400)); } });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.addInitScript(() => { try { localStorage.removeItem('bf.look'); } catch (_) { /* none */ } });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off' + (look ? '&look=' + look : '') + '#seed3gen4v6');
  await pg.waitForFunction(() => globalThis.BF && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30, null, { timeout: 240000 });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(() => {
    const kids = BF.scene.children, ground = kids.filter(c => c.geometry && c.geometry.attributes.mat);
    let bad = 0, verts = 0;
    for (const m of ground) {
      const g = m.geometry, p = g.attributes.position, n = g.attributes.normal;
      verts += p.count;
      for (const a of [p, n, g.attributes.color, g.attributes.skyl, g.attributes.bl]) if (!a || a.count !== p.count) bad++;
      for (let i = 0; i < p.array.length; i++) if (!isFinite(p.array[i])) { bad++; break; }
    }
    return {
      on: !!(BF.real && BF.real.on), ground: ground.length, bad, verts,
      batches: BF.real && BF.real.flora && BF.real.flora.batches ? BF.real.flora.batches.size : 0,
      instanced: kids.filter(c => c.isInstancedMesh && c.material && c.material.type === 'MeshStandardMaterial').length,
      lights: kids.filter(c => c.isLight).length, tone: BF.renderer.toneMapping, meshed: BF.world.meshedCount(),
      species: BF.real && BF.real.assets ? BF.real.assets.species.length : 0,
      built: BF.real && BF.real.meshTables ? (() => { const t = BF.real.meshTables(), B = BF.B; return [t.NAT[B.orange_terracotta], t.NATB[B.orange_terracotta], t.NATB[B.sandstone], t.NATB[B.grass], t.NATB[B.stone]]; })() : null,
    };
  });
  if (look === 'real') r.shape = await pg.evaluate(SHAPE);
  await pg.context().close();
  return { r, errors };
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const real = await boot(b, 'real');
  console.log('look=real: ' + JSON.stringify(real.r));
  check(real.r.on, 'look=real turns the realistic look on');
  check(real.errors.length === 0, 'no page or shader errors with the look on');
  check(real.r.ground >= 20 && real.r.verts > 1000, `chunks have a smooth terrain mesh (${real.r.ground} of ${real.r.meshed} chunks, ${real.r.verts} vertices)`);
  check(real.r.bad === 0, 'the terrain meshes are well formed (matching attribute counts, finite positions)');
  check(real.r.lights >= 2 && real.r.tone !== 0, 'the sun and sky lights exist and the renderer tone maps');
  check(real.r.built && real.r.built[0] > 0 && real.r.built[1] === 0 && real.r.built[2] === 0 && real.r.built[3] > 0 && real.r.built[4] > 0, `outside the badlands terracotta and sandstone stay cubes (village roofs and walls), grass and stone stay ground (${real.r.built})`);
  const sh = real.r.shape;
  check(sh.rim > 100 && !!sh.made && sh.open === 0, `neighbouring chunks' ground meets edge to edge, also where it crosses the top of a chunk's band (${sh.made ? 'made at ' + sh.made.slice(0, 3) : 'not made'}; ${sh.rim} rim edges, ${sh.open} without a twin${sh.ex.length ? ': ' + sh.ex.join(' ; ') : ''})`);
  check(!!sh.spot && sh.walls >= 12 && sh.lean <= 0.1, `a shaft dug one block wide keeps its walls on the blocks (${sh.walls} wall vertices, leaning in ${sh.lean == null ? '?' : sh.lean.toFixed(3)} at most)`);
  check(!!sh.spot && sh.pad === 4, `the ground is flat and square under a block set on it (${sh.pad} of 4 corners on the grid)`);
  check(real.r.species >= 3, `tree species are registered (${real.r.species})`);
  check(real.r.instanced > 0, `trees are drawn as instanced models (${real.r.instanced} batches' parts)`);
  for (const look of ['blocks', '']) {
    const off = await boot(b, look);
    console.log('look=' + (look || '(default)') + ': ' + JSON.stringify(off.r));
    check(!off.r.on && off.r.ground === 0 && off.r.instanced === 0 && off.r.lights === 0 && off.r.tone === 0, `look=${look || '(default)'} draws the block world untouched`);
    check(off.errors.length === 0, `no page errors with look=${look || '(default)'}`);
  }
  await b.close();
  console.log(fails ? `FAIL ${fails} check(s)` : 'PASS real-look');
  process.exit(fails ? 1 : 0);
})();
