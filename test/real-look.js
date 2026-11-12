// @ci baseline suite=world
// The realistic look (1.6, docs/REALISTIC_CONTRACT.md): with ?look=real the page draws natural ground as the smooth terrain pass and
// trees through the flora placer, without errors; with ?look=blocks (and by default) nothing of it runs.
// Usage: NODE_PATH=$(npm root -g) node test/real-look.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

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
