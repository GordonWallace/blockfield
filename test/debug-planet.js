// @ci integration suite=ui timeout=400 args={out}
// The debug screen on the planet (generator 4, spec r14-21). A village near a face edge is visited and logged, then the player stands just
// across that edge on the next face, with a cow on each side of it:
//  - the Position card shows face / u / v / y and latitude / longitude, never atlas x / z;
//  - the village list gives the village's distance round the planet and its geographic direction, and its map draws the player in the
//    village's own face frame;
//  - the Mobs map draws everything in the player's face frame: the cow on the other face comes unfolded beside the edge, the same
//    distance and direction away as in the world, and both are drawn; the face edge is marked and the map's north arrow follows true north;
//  - the Planet section's toggles (face tints, corner wedge, true sphere) reach the game, F3 + B / C / R flip them in the game and the
//    screen follows, and F3 on its own still shows and hides the overlay.
// Usage: NODE_PATH=$(npm root -g) node test/debug-planet.js [outPrefix]
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/debug-planet';
const GAME = 8730, DBG = 8731;
const start = async () => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-debug-planet-alerts.json')]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
(async () => {
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails.push(n); };
  const srv = await start();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const game = await b.newPage({ viewport: { width: 1280, height: 760 } });
  const errs = [];
  game.on('pageerror', e => { console.log('PAGEERROR game', e.message); errs.push(e.message); });
  await game.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await game.route('https://fonts.**', r => r.abort());
  await game.goto(`http://localhost:${GAME}/#seed1337gen4`);
  await game.waitForTimeout(5000);
  ok('a planet world, fed to the debug server', await game.evaluate(() => BF.planet.isPlanet() && !!BF.debugFeed));

  // a village near an edge of face 4 (as test/planet-village-visit.js finds one), and the cells straight across its nearest edge
  const pick = await game.evaluate(() => {
    const P = BF.planet, N = P.N, W = BF.worldgen;
    const dEdge = q => { const g = P.grid(q.x, q.z); return Math.min(g.u, g.v, N - g.u, N - g.v); };
    for (let s = 0; s < 4; s++) for (let k = 2; k < 60; k++) {
      const along = Math.round(N * k / 62), h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? 300 : N - 300) : along, v = h[1] ? (h[1] < 0 ? 300 : N - 300) : along;
      const a = P.atlas(4, u, v), vs = W.villagesNear(a.x, a.z, 1200).sort((x, y) => dEdge(x) - dEdge(y));
      const q = vs[0];
      if (!q || P.face(q.x, q.z) !== 4 || dEdge(q) > 800) continue;
      const g = P.grid(q.x, q.z), side = [g.u, N - g.u, g.v, N - g.v].indexOf(dEdge(q)), hh = [[-1, 0], [1, 0], [0, -1], [0, 1]][side];
      // the cell k across the edge (k < 0: still on face 4), level with the village along it: a face-4 margin address, then canonical
      const across = k => { const o = hh[0] + hh[1] < 0 ? -1 - k : N + k, a2 = hh[0] ? P.atlas(4, o, Math.floor(g.v)) : P.atlas(4, Math.floor(g.u), o), c = P.canonCell(a2.x, a2.z); return { x: c.x + 0.5, z: c.z + 0.5, f: c.f }; };
      window.__across = across;
      return { x: q.x, z: q.z, name: q.name, dEdge: Math.round(dEdge(q)), side, g: P.EDGE[4][side].g, turn: P.EDGE[4][side].turn };
    }
    return null;
  });
  ok('found a village near an edge of face 4', !!pick, pick);
  if (!pick) { await b.close(); srv.kill(); process.exit(1); }
  await game.evaluate(t => { const v = BF.worldgen.villageAt(t.x, t.z); BF.player.spawn(t.x + 0.5, v.y + 3, t.z + 0.5); }, pick);
  let key = null;
  for (let i = 0; i < 40 && !key; i++) { await game.waitForTimeout(1000); key = await game.evaluate(() => { const r = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); return r && r.members && r.members.length ? r.key : null; }); }
  ok('the village loads', !!key, key);
  await game.evaluate(() => { const r = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); BF.vlog.log(r, 'birth', 'Test baby was born'); });

  // across the edge: the player 10 blocks onto the next face, a cow 6 blocks back on face 4 and one 4 blocks onto the next face
  const setup = await game.evaluate(async () => {
    const P = BF.planet, A = window.__across, sp = A(10);
    BF.player.teleport(sp.x, Math.max(BF.worldgen.heightAt(sp.x, sp.z), BF.SEA) + 30, sp.z); BF.player.setFlying(true);
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 250)); if ([-6, 4, 10].every(k => { const c = A(k), ch = BF.world.chunkAt(c.x, c.z); return ch && ch.mesh !== undefined; })) break; }
    const yAt = c => Math.max(BF.world.heightAt(c.x, c.z), BF.SEA) + 1;
    BF.player.teleport(sp.x, yAt(sp) + 0.01, sp.z); BF.player.setFlying(true);
    BF.mobs.spawning = false;
    for (const m of BF.mobs.list.slice()) if (m.type === 'cow' && P.distance(sp, m.position) < 80) BF.mobs.kill(m);
    for (let i = 0; i < 10; i++) BF.mobs.update(0.05);
    const ca = A(-6), cb = A(4), cowA = BF.mobs.spawn('cow', ca.x, yAt(ca), ca.z), cowB = BF.mobs.spawn('cow', cb.x, yAt(cb), cb.z);
    window.__upd = BF.mobs.update; BF.mobs.update = () => {};   // hold everything still so the game and the screen can be compared
    const pp = BF.player.position, F = P.face(pp.x, pp.z), q = P.inFrame(F, cowA.position.x, cowA.position.z, {});
    return { F, fa: P.face(cowA.position.x, cowA.position.z), fb: P.face(cowB.position.x, cowB.position.z), sp,
      a: [cowA.position.x, cowA.position.z], b: [cowB.position.x, cowB.position.z], aIn: [q.x, q.z], dA: P.distance(pp, cowA.position), dB: P.distance(pp, cowB.position) };
  });
  ok(`the player stands on face ${setup.F}, a cow on face ${setup.fa} and one on face ${setup.fb}`, setup.F === pick.g && setup.fa === 4 && setup.fb === pick.g, setup);

  const dbg = await b.newPage({ viewport: { width: 1600, height: 1400 } });
  dbg.on('pageerror', e => { console.log('PAGEERROR debug', e.message); errs.push(e.message); });
  await dbg.route('https://fonts.**', r => r.abort());
  await dbg.goto(`http://localhost:${DBG}/`);
  await dbg.evaluate(() => localStorage.removeItem('bf-debug-mobmap-hidden'));
  await dbg.reload();
  await dbg.waitForFunction(() => window.BFMobMap && BFMobMap.data() && BFMobMap.data().face != null, null, { timeout: 20000 }).catch(() => {});
  await dbg.waitForTimeout(2500);

  // ---- position: face / u / v / y and lat / lon
  const pos = await dbg.evaluate(() => ({ xyz: document.getElementById('c-xyz').textContent, sub: document.getElementById('c-chunk').textContent, facing: document.getElementById('c-facing').textContent }));
  const gpos = await game.evaluate(() => { const d = BF.debugInfo(); return { f: d.planet.face, u: d.planet.u, v: d.planet.v, ll: d.planet.latLon, x: d.x }; });
  ok('Position shows face / u / v / y and latitude / longitude ' + JSON.stringify(pos), pos.xyz.startsWith(gpos.u.toFixed(1) + ' / ' + gpos.v.toFixed(1) + ' / ') &&
    pos.sub === `Face ${gpos.f} (u / v / y) \u00B7 ${gpos.ll}` && !pos.xyz.includes(String(Math.floor(gpos.x))) && /^facing (north|south|east|west|north-east|north-west|south-east|south-west)$/.test(pos.facing));

  // ---- village list: distance round the planet, geographic direction; its map puts the player in the village's frame
  const want = await game.evaluate(key => {
    const P = BF.planet, pp = BF.player.position, [x, z] = key.split(',').map(Number), t = P.toward(pp, { x, z }, {});
    const b = P.bearing(pp.x, pp.z, t.x, t.z), me = P.inFrame(P.face(x, z), pp.x, pp.z, {});
    return { d: Math.round(P.distance(pp, { x, z })), dir: P.compassPoint(b, true), me: [me.x, me.z], name: BF.signs.villageName(key), hyp: Math.round(Math.hypot(x - pp.x, z - pp.z)) };
  }, key);
  const row = await dbg.evaluate(key => { const r = document.querySelector(`#vlist .vrow[data-k="${key}"]`); return r && r.querySelector('.vd').textContent.trim(); }, key);
  ok(`the village list gives ${want.name} ${want.d} blocks ${want.dir} (not ${want.hyp} straight across the atlas): "${row}"`, row === `${want.d.toLocaleString('en-US')} ${want.dir}` && want.hyp !== want.d);
  const me = await dbg.evaluate(key => BFPlanet.me(key), key);
  ok('the village map draws the player in the village face frame', me && Math.abs(me.x - want.me[0]) < 0.2 && Math.abs(me.z - want.me[1]) < 0.2, { me, want: want.me });

  // ---- mobs map: the player's face frame, the far cow unfolded beside the edge
  await dbg.locator('#mpanel').scrollIntoViewIfNeeded();
  await dbg.click('#m-center');
  for (let i = 0; i < 8; i++) await dbg.click('#m-zin');
  await dbg.waitForTimeout(1500);
  const mm = await dbg.evaluate(([a, b2]) => {
    const d = BFMobMap.data(), cow = d.kinds.indexOf('cow'), near = p => d.mobs.filter(m => m[0] === cow).map(m => [m[1], m[2], Math.hypot(m[1] - p[0], m[2] - p[1])]).sort((x, y) => x[2] - y[2])[0];
    const [qx0, qz0, qx1, qz1] = d.sq, inside = (x, z) => x >= qx0 && x < qx1 && z >= qz0 && z < qz1;
    let wedge = 0, outside = 0;
    for (let i = 0; i < d.chunks.length; i += 2) { const x = (d.chunks[i] + 0.5) * d.cs, z = (d.chunks[i + 1] + 0.5) * d.cs, ox = x < qx0 || x >= qx1, oz = z < qz0 || z >= qz1; if (ox && oz) wedge++; else if (ox || oz) outside++; }
    return { face: d.face, player: d.player, a: near(a), b: near(b2), insideA: near(a) && inside(near(a)[0], near(a)[1]), insideB: near(b2) && inside(near(b2)[0], near(b2)[1]), wedge, outside, north: d.north, dots: BFMobMap.dotData() };
  }, [setup.aIn, setup.b]);
  const da = mm.a && Math.hypot(mm.a[0] - mm.player[0], mm.a[1] - mm.player[1]), db = mm.b && Math.hypot(mm.b[0] - mm.player[0], mm.b[1] - mm.player[1]);
  ok(`the map is in face ${setup.F}'s frame, with chunks of face 4 unfolded past its edge and none in a corner wedge`, mm.face === setup.F && mm.outside > 0 && mm.wedge === 0, { outside: mm.outside, wedge: mm.wedge });
  ok(`the cow on face 4 is drawn unfolded across the edge, ${setup.dA.toFixed(1)} blocks away as in the world`, mm.a && mm.a[2] < 0.2 && !mm.insideA && Math.abs(da - setup.dA) < 0.3 && Math.abs(da - 16) < 1.5, { a: mm.a, da });
  ok(`the cow on face ${setup.fb} is on the face's own square, ${setup.dB.toFixed(1)} blocks away`, mm.b && mm.b[2] < 0.2 && mm.insideB && Math.abs(db - setup.dB) < 0.3, { b: mm.b, db });
  // both cows are drawn, in a straight line through the player (the edge runs between them, square across it)
  const dotA = mm.dots.find(d => Math.abs(d[2] - mm.a[0]) < 0.11 && Math.abs(d[3] - mm.a[1]) < 0.11), dotB = mm.dots.find(d => Math.abs(d[2] - mm.b[0]) < 0.11 && Math.abs(d[3] - mm.b[1]) < 0.11);
  const col = await dbg.evaluate(([p, q]) => { const cv = document.getElementById('mmap'), g = cv.getContext('2d'), r = devicePixelRatio || 1; return [p, q].map(d => d && [...g.getImageData(Math.floor(d[0] * r), Math.floor(d[1] * r), 1, 1).data].slice(0, 3)); }, [dotA, dotB]);
  const cowCol = [0x4f, 0x9b, 0xe8], near = c => c && Math.abs(c[0] - cowCol[0]) + Math.abs(c[1] - cowCol[1]) + Math.abs(c[2] - cowCol[2]) < 40;
  const pl = await dbg.evaluate(() => { const cv = document.getElementById('mmap'); return [cv.clientWidth / 2, cv.clientHeight / 2]; });
  const cross = dotA && dotB ? Math.abs((dotA[0] - pl[0]) * (dotB[1] - pl[1]) - (dotA[1] - pl[1]) * (dotB[0] - pl[0])) / (Math.hypot(dotA[0] - pl[0], dotA[1] - pl[1]) * Math.hypot(dotB[0] - pl[0], dotB[1] - pl[1])) : 1;
  ok('both cows are drawn, either side of the player in one line', near(col[0]) && near(col[1]) && cross < 0.05, { dotA, dotB, col, cross: +cross.toFixed(3) });
  const nWant = await game.evaluate(() => { const p = BF.player.position, n = BF.planet.north(p.x, p.z); return n; });
  ok('the map\'s north arrow follows true north at the player', mm.north && Math.abs(mm.north[0] - nWant[0]) < 0.01 && Math.abs(mm.north[1] - nWant[1]) < 0.01, { got: mm.north, want: nWant });
  const tip = await dbg.evaluate(d => { const cv = document.getElementById('mmap'), r = cv.getBoundingClientRect(); cv.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + d[0], clientY: r.top + d[1], bubbles: true })); return document.getElementById('mtip').textContent; }, dotA);
  ok('hovering the far cow gives its distance and direction from the player', /^Cow.*1[56] blocks (N|NE|E|SE|S|SW|W|NW), y \d+/.test(tip), tip);
  await dbg.screenshot({ path: out + '-mobmap.png', fullPage: true });

  // the same across an edge that turns (face 0 to face 2, as in test/planet-edges-mobs.js): the far cow comes unfolded and turned with it
  const t = await game.evaluate(async () => {
    const P = BF.planet, N = P.N, f = 0, s = 2, h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s], e = P.EDGE[f][s];
    const at = k => { const o = h[0] + h[1] < 0 ? -1 - k : N + k, a = h[0] ? P.atlas(f, o, N / 2) : P.atlas(f, N / 2, o), c = P.canonCell(a.x, a.z); return { x: c.x + 0.5, z: c.z + 0.5, f: c.f }; };
    BF.mobs.update = window.__upd;
    const sp = at(10);
    BF.player.teleport(sp.x, Math.max(BF.worldgen.heightAt(sp.x, sp.z), BF.SEA) + 30, sp.z);
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 250)); if ([-6, 4, 10].every(k => { const c = at(k), ch = BF.world.chunkAt(c.x, c.z); return ch && ch.mesh !== undefined; })) break; }
    const yAt = c => Math.max(BF.world.heightAt(c.x, c.z), BF.SEA) + 1;
    BF.player.teleport(sp.x, yAt(sp) + 0.01, sp.z);
    for (const m of BF.mobs.list.slice()) if (m.type === 'cow' && P.distance(sp, m.position) < 80) BF.mobs.kill(m);
    for (let i = 0; i < 10; i++) BF.mobs.update(0.05);
    const ca = at(-6), cb = at(4), a = BF.mobs.spawn('cow', ca.x, yAt(ca), ca.z), b = BF.mobs.spawn('cow', cb.x, yAt(cb), cb.z);
    BF.mobs.update = () => {};
    const pp = BF.player.position;
    return { F: P.face(pp.x, pp.z), fa: P.face(a.position.x, a.position.z), turn: e.turn, g: e.g, a: [a.position.x, a.position.z], b: [b.position.x, b.position.z],
      aIn: (q => [q.x, q.z])(P.inFrame(P.face(pp.x, pp.z), a.position.x, a.position.z, {})), dA: P.distance(pp, a.position) };
  });
  await dbg.click('#m-center');
  await dbg.waitForFunction(F => BFMobMap.data().face === F, t.F, { timeout: 10000 }).catch(() => {});
  await dbg.waitForTimeout(2500);
  const m2 = await dbg.evaluate(([a, b2]) => {
    const d = BFMobMap.data(), cow = d.kinds.indexOf('cow'), near = p => d.mobs.filter(m => m[0] === cow).map(m => [m[1], m[2], Math.hypot(m[1] - p[0], m[2] - p[1])]).sort((x, y) => x[2] - y[2])[0];
    const [qx0, qz0, qx1, qz1] = d.sq, A = near(a), B = near(b2);
    return { face: d.face, player: d.player, a: A, b: B, insideA: A && A[0] >= qx0 && A[0] < qx1 && A[1] >= qz0 && A[1] < qz1, dots: BFMobMap.dotData() };
  }, [t.aIn, t.b]);
  const d2 = m2.a && Math.hypot(m2.a[0] - m2.player[0], m2.a[1] - m2.player[1]);
  const lined = m2.a && m2.b && Math.abs((m2.a[0] - m2.player[0]) * (m2.b[1] - m2.player[1]) - (m2.a[1] - m2.player[1]) * (m2.b[0] - m2.player[0])) < 0.5;
  const drawn = m2.a && m2.dots.some(d => Math.abs(d[2] - m2.a[0]) < 0.11 && Math.abs(d[3] - m2.a[1]) < 0.11);
  ok(`across a turning edge (face ${t.F}, the cow on face ${t.fa}, turn ${t.turn}): the far cow is drawn unfolded, 16 blocks away in line with the near one`,
    t.turn !== 0 && m2.face === t.F && t.fa === 0 && m2.a && m2.a[2] < 0.2 && !m2.insideA && Math.abs(d2 - 16) < 1.5 && lined && drawn, { m2: { ...m2, dots: m2.dots.length }, t });
  await dbg.screenshot({ path: out + '-mobmap-turn.png', fullPage: true });

  // ---- planet toggles: the debug screen's buttons reach the game
  ok('the Planet section shows, all off', await dbg.evaluate(() => !document.getElementById('c-planet').hidden && [...document.querySelectorAll('[data-pt]')].every(b => !b.classList.contains('on'))));
  await dbg.locator('#c-planet').scrollIntoViewIfNeeded();
  await dbg.click('[data-pt="tints"]');
  await game.waitForFunction(() => BF.view.debug.tints, null, { timeout: 10000 }).catch(() => {});
  const t1 = await game.evaluate(() => ({ tints: BF.view.debug.tints, u: BF.world.faceTintOn.value, f3: BF.debugText(BF.debugInfo()) }));
  ok('Face tints on the screen turns them on in the game', t1.tints && t1.u === 1 && /Planet debug: face tints/.test(t1.f3), t1);
  await game.waitForTimeout(1500);
  await game.screenshot({ path: out + '-tints.png' });
  // F3 + C and F3 + R in the game: the corner wedge and the true sphere; F3 alone still flips the overlay
  const ov0 = await game.evaluate(() => BF.debugOn);
  await game.keyboard.down('F3'); await game.keyboard.press('KeyC'); await game.keyboard.press('KeyR'); await game.keyboard.up('F3');
  await game.waitForTimeout(500);
  const t2 = await game.evaluate(() => ({ d: { ...BF.view.debug }, corner: BF.view.cornerRound, k: BF.view.state.k, on: BF.debugOn }));
  ok('F3 + C opens the corner wedge and F3 + R draws the true sphere, without flipping the overlay', t2.d.wedge && t2.d.sphere && !t2.corner && t2.k === 1 && t2.on === ov0, t2);
  await dbg.waitForFunction(() => ['tints', 'wedge', 'sphere'].every(k => document.querySelector(`[data-pt="${k}"]`).classList.contains('on')), null, { timeout: 8000 }).catch(() => {});
  ok('the screen follows the game\'s toggles', await dbg.evaluate(() => ['tints', 'wedge', 'sphere'].every(k => document.querySelector(`[data-pt="${k}"]`).classList.contains('on'))));
  await game.screenshot({ path: out + '-sphere.png' });
  await dbg.click('[data-pt="sphere"]');
  await game.waitForFunction(() => !BF.view.debug.sphere, null, { timeout: 10000 }).catch(() => {});
  await game.waitForTimeout(300);
  ok('True sphere off from the screen goes back to the flat view', await game.evaluate(() => !BF.view.debug.sphere && BF.view.state.k < 1));
  await game.keyboard.press('F3'); await game.waitForTimeout(200);
  ok('F3 on its own still shows and hides the overlay', (await game.evaluate(() => BF.debugOn)) === !ov0);
  await game.keyboard.down('F3'); await game.keyboard.press('KeyB'); await game.keyboard.press('KeyC'); await game.keyboard.up('F3');
  ok('and F3 + B / C turn them off again', await game.evaluate(() => !BF.view.debug.tints && !BF.view.debug.wedge && BF.view.cornerRound && BF.world.faceTintOn.value === 0));
  await dbg.screenshot({ path: out + '.png', fullPage: true });

  ok('no page errors', !errs.length, errs.slice(0, 3));
  await b.close();
  srv.kill(); await new Promise(r => srv.exitCode !== null ? r() : srv.once('exit', r));
  console.log(fails.length ? fails.length + ' FAILED' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
