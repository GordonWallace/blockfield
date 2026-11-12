// @ci integration suite=world timeout=240
// The realistic look's species registry (docs/REALISTIC_CONTRACT.md section 5, js/real/assets-*.js) builds without throwing.
// Loads debug/real-assets.html with the look on and, for every tree species, ground cover plant and rock in BF.real.assets, builds the
// model at every detail level from two seeds and checks it: geometry with finite positions and valid indices, a lighter build at detail 2,
// the same model again from the same seed, and materials that compile (each is drawn once). Also checks that every tree entry names
// a block that exists, every biome of the table has trees or rocks registered, and every ground entry names real blocks.
// Standalone: NODE_PATH=$(npm root -g) node test/real-assets.js [out.png]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 1280, height: 760 } });
  let failed = false;
  const fail = m => { failed = true; console.log('FAIL ' + m); };
  pg.on('console', m => { if (m.type() === 'error') fail('console.error: ' + m.text()); });
  pg.on('pageerror', e => fail('page error: ' + (e.stack || e.message)));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.goto('file://' + path.join(root, 'debug', 'real-assets.html') + '?look=real&biome=Savanna&ui=0');
  await pg.waitForFunction(() => window.__frames >= 2, null, { timeout: 120000 });
  await pg.addScriptTag({ path: path.join(root, 'js', 'blocks.js') });   // BF.B, for the block names (pure; the viewer doesn't need it)
  const res = await pg.evaluate(() => {
    const A = BF.real.assets, K = BF.real.akit, out = [], T = THREE;
    const bad = m => out.push(m);
    const renderer = new T.WebGLRenderer({ canvas: document.createElement('canvas') }), scene = new T.Scene(), cam = new T.PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(0, 2, 12); scene.add(new T.DirectionalLight(0xffffff, 1));
    const tris = g => (g.index ? g.index.count : 0) / 3;
    const check = (id, g, allowEmpty) => {
      if (!g || !g.isBufferGeometry) return bad(id + ': not a BufferGeometry');
      const p = g.attributes.position, n = p ? p.count : 0;
      if (!n) { if (!allowEmpty) bad(id + ': empty geometry'); return; }
      for (let i = 0; i < p.array.length; i++) if (!isFinite(p.array[i])) return bad(id + ': a position is not finite');
      for (const a of ['normal', 'uv', 'color']) if (!g.attributes[a] || g.attributes[a].count !== n) return bad(id + ': attribute ' + a + ' missing or of the wrong length');
      if (!g.index) return bad(id + ': no index');
      for (let i = 0; i < g.index.count; i++) if (g.index.array[i] >= n) return bad(id + ': an index is out of range');
    };
    const same = (a, b) => a.attributes.position.count === b.attributes.position.count && a.attributes.position.array.every((v, i) => v === b.attributes.position.array[i]);
    const draw = (id, g, m) => {
      if (!m || !m.isMaterial) return bad(id + ': no material');
      if (!g.attributes.position.count) return;
      const mesh = new T.Mesh(g, m); scene.add(mesh);
      try { renderer.render(scene, cam); } catch (e) { bad(id + ': drawing threw ' + e.message); }
      scene.remove(mesh);
      const log = renderer.info.programs.filter(pr => pr.diagnostics && !pr.diagnostics.runnable);
      if (log.length) bad(id + ': a shader did not compile');
    };
    const ray = new T.Raycaster(), slitMat = new T.MeshBasicMaterial({ side: T.DoubleSide });
    function slit(geo, upTo) {
      const mesh = new T.Mesh(geo, slitMat), p = geo.attributes.position, O = new T.Vector3(), D = new T.Vector3();
      geo.computeBoundingSphere(); mesh.updateMatrixWorld();
      for (let d = 0; d < 6; d++) {
        const a = d * 1.05 + 0.3, near = [], thick = [];   // per height: how far the ray travels to the bark, and how thick the wood is there
        let tx = null, tz = 0;
        for (let y = 0.1; y < upTo; y += 0.01) {
          if (tx == null) {   // start from the middle of the wood near the ground; from there follow the trunk itself (it leans, and limbs and arms pull an average aside)
            let cx = 0, cz = 0, n = 0;
            for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - y) < 0.3 && Math.hypot(p.getX(i), p.getZ(i)) < 1) { cx += p.getX(i); cz += p.getZ(i); n++; }
            if (!n) { near.push(null); thick.push(0); continue; }
            tx = cx / n; tz = cz / n;
          }
          O.set(tx - Math.cos(a) * 30, y, tz - Math.sin(a) * 30); D.set(Math.cos(a), 0, Math.sin(a)); ray.set(O, D);
          const h = ray.intersectObject(mesh);
          if (h.length > 1) { tx = (h[0].point.x + h[1].point.x) / 2; tz = (h[0].point.z + h[1].point.z) / 2; }
          else if (!near.some(v => v != null)) tx = null;
          near.push(h.length ? h[0].distance : Infinity); thick.push(h.length > 1 ? h[1].distance - h[0].distance : 0);
        }
        // a seam: at one height the ray goes past the bark it meets just below and just above (through to the far wall, or out the other side)
        for (let k = 3; k < near.length - 3; k++) {
          const lo = Math.min(near[k - 2] == null ? Infinity : near[k - 2], near[k - 3] == null ? Infinity : near[k - 3]), hi2 = Math.min(near[k + 2], near[k + 3]), t = Math.max(thick[k - 2], thick[k - 3]);
          // (the same surface below and above, and wood thick enough to be a trunk and not a twig crossing the ray)
          if (near[k] != null && isFinite(lo) && isFinite(hi2) && Math.abs(lo - hi2) < 0.04 && t > 0.12 && near[k] > lo + t * 0.5) return 0.1 + k * 0.01;
        }
      }
      return null;
    }
    let count = 0, t3 = 0, t3mid = 0, t3low = 0;
    for (const sp of A.species) {
      const id = 'tree ' + sp.id;
      if (BF.B[sp.log] == null) bad(id + ': no block named ' + sp.log);
      if (!(sp.height && sp.height[0] > 0 && sp.height[1] >= sp.height[0])) bad(id + ': bad height range');
      try {
        const hi = sp.build(K.mulberry(11), 0), lo = sp.build(K.mulberry(11), 2), again = sp.build(K.mulberry(11), 0), other = sp.build(K.mulberry(12), 0);
        check(id + ' bark', hi.bark); check(id + ' foliage', hi.foliage, sp.leafless); check(id + ' bark (low)', lo.bark); check(id + ' foliage (low)', lo.foliage, sp.leafless);
        check(id + ' (seed 12)', other.bark);
        if (!same(hi.bark, again.bark)) bad(id + ': the same seed built a different model');
        const h = tris(hi.bark) + tris(hi.foliage), l = tris(lo.bark) + tris(lo.foliage);
        const mid = sp.build(K.mulberry(11), 1), m = tris(mid.bark) + tris(mid.foliage);
        if (l > m || m > h) bad(id + ': the detail levels do not get lighter (' + h + ', ' + m + ', ' + l + ' triangles)');
        if (h > 9000) bad(id + ': ' + h + ' triangles at detail 0 (budget 9000)');
        if (m > 2600) bad(id + ': ' + m + ' triangles at detail 1 (budget 2600)');
        if (l > 1000) bad(id + ': ' + l + ' triangles at detail 2 (budget 1000)');
        t3mid += m;
        hi.bark.computeBoundingBox();
        const top = hi.bark.boundingBox.max.y;
        if (top < sp.height[0] * 0.6 || top > sp.height[1] * 1.3) bad(id + ': stands ' + top.toFixed(1) + ' blocks tall, outside its height range ' + sp.height);
        draw(id + ' bark', hi.bark, sp.barkMaterial()); draw(id + ' foliage', hi.foliage, sp.foliageMaterial());
        // no seam across the lower trunk (below the first limbs): a level ray must not pass the bark it meets just below and just above
        for (const [lv, g] of [[0, hi], [1, mid], [2, lo]]) { const y = slit(g.bark, Math.min(3, top * 0.25)); if (y != null) bad(id + ': detail ' + lv + ' has a gap across the trunk at height ' + y.toFixed(2)); }
        t3 += h; t3low += l; count++;
      } catch (e) { bad(id + ': build threw ' + (e.stack || e.message)); }
    }
    for (const c of A.cover) {
      const id = 'cover ' + c.id;
      if (c.block && BF.B[c.block] == null) bad(id + ': no block named ' + c.block);
      try {
        const hi = c.build(K.mulberry(5), 0), lo = c.build(K.mulberry(5), 2);
        check(id, hi); check(id + ' (low)', lo);
        if (tris(lo) > tris(hi)) bad(id + ': detail 2 is heavier than detail 0');
        if (tris(hi) > 4500) bad(id + ': ' + tris(hi) + ' triangles (budget 4500)');
        draw(id, hi, c.material()); count++;
      } catch (e) { bad(id + ': build threw ' + (e.stack || e.message)); }
    }
    for (const r of A.rocks) {
      const id = 'rock ' + r.id;
      try { const g = r.build(K.mulberry(3), 0); check(id, g); check(id + ' (low)', r.build(K.mulberry(3), 2)); draw(id, g, r.material()); count++; }
      catch (e) { bad(id + ': build threw ' + (e.stack || e.message)); }
    }
    for (const g of A.ground) for (const n of g.blocks) if (BF.B[n] == null) bad('ground ' + g.id + ': no block named ' + n);
    for (const g of A.ground) if (!(Array.isArray(g.color) && g.color.length === 3 && g.color.every(v => v >= 0 && v <= 1))) bad('ground ' + g.id + ': the colour is not [r, g, b] in 0 .. 1');
    for (const name in A.biomes) {
      const has = l => l.some(e => e.biomes && e.biomes.includes(name));
      if (!has(A.species) && !has(A.rocks)) bad('biome ' + name + ': nothing registered');
    }
    return { out, count, species: A.species.length, cover: A.cover.length, rocks: A.rocks.length, ground: A.ground.length, t3: Math.round(t3 / A.species.length), t3mid: Math.round(t3mid / A.species.length), t3low: Math.round(t3low / A.species.length) };
  });
  for (const m of res.out) fail(m);
  console.log(res.species + ' tree entries, ' + res.cover + ' cover plants, ' + res.rocks + ' rocks, ' + res.ground + ' ground entries; ' + res.count + ' built and drawn');
  console.log('mean tree: ' + res.t3 + ' triangles at detail 0, ' + res.t3mid + ' at detail 1, ' + res.t3low + ' at detail 2');
  if (res.species < 15 || res.cover < 50 || res.rocks < 10) fail('the registry is missing entries');
  if (process.argv[2]) await pg.screenshot({ path: process.argv[2] });
  await b.close();
  console.log(failed ? 'FAIL real-assets' : 'ok real-assets');
  process.exit(failed ? 1 : 0);
})();
