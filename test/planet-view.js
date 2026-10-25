// @ci integration suite=world timeout=600 hosts=worker,server
// Drawing near the ground on the planet (generator 4, spec r14-03): a floating origin (chunk meshes are chunk-local and the camera
// sits at the render origin, so float32 drawing stays precise at the largest atlas x); the picture doesn't move when the view
// switches to the next face (a margin view and the canonical view of the same spot match, across an edge that turns and one that
// doesn't); a straight flight across a turned edge stays straight; near two cube corners the round drawing fills the wedge the
// flat drawing leaves empty. (The check that flat worlds draw their chunks in place went with the flat generators, r14-24.)
// node test/run.js /tmp/pv test/planet-view.js [--host page|worker|server] (drawing: the page's)
module.exports = async (pg) => {
  await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow (never judge frame rate here)
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await pg.evaluate(() => {
    window.__errs = []; addEventListener("error", e => window.__errs.push(e.message));
    // grab(): this frame drawn off screen, as RGBA bytes; settle(): wait until nothing is queued for loading or meshing
    window.__rt = null;
    window.grab = () => {
      const r = BF.renderer, s = r.getSize(new THREE.Vector2());
      if (!window.__rt || window.__rt.width !== s.x) window.__rt = new THREE.WebGLRenderTarget(s.x, s.y);
      BF.view.begin(BF.scene, BF.camera);
      r.setRenderTarget(window.__rt); r.render(BF.scene, BF.camera); r.setRenderTarget(null);
      BF.view.end();
      const px = new Uint8Array(s.x * s.y * 4);
      r.readRenderTargetPixels(window.__rt, 0, 0, s.x, s.y, px);
      return px;
    };
    window.diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };
    window.settle = async (min) => {
      await new Promise(r => setTimeout(r, min || 1500));
      for (let i = 0; i < 120 && BF.world.queueLength > 0; i++) await new Promise(r => setTimeout(r, 250));
      await new Promise(r => setTimeout(r, 600));
    };
  });
  await require('./lib').newWorld(pg, 1337, { gen: 4 });
  await pg.evaluate(() => { BF.world.viewDist = 4; BF.player.start(); BF.player.setGameMode("creative"); });
  await pg.evaluate(() => settle(3000));

  // ---- floating origin, at the largest atlas x (face 5, near its +u edge)
  const prec = await pg.evaluate(async () => {
    const P = BF.planet, a = P.atlas(5, P.N - 40.5, P.N / 2 + 0.5);
    BF.player.teleport(a.x, 60, a.z); BF.player.setFlying(true);
    await settle();
    const W = BF.world, P2 = P, out = { x: a.x, local: true, meshes: 0, camAt: null, err: 0, square: true };
    BF.view.begin(BF.scene, BF.camera);
    const e = BF.camera.matrixWorld.elements; out.camAt = Math.hypot(e[12], e[13] - 0, e[14]);
    const V = BF.camera.matrixWorldInverse, f32 = Math.fround, mv = new THREE.Matrix4();
    for (const c of W.chunks.values()) for (const m of c.meshes || []) {
      out.meshes++;
      const arr = m.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) if (arr[i] < -0.5 || arr[i] > 16.5 || arr[i + 2] < -0.5 || arr[i + 2] > 16.5) { out.local = false; break; }
      const w = m.matrixWorld.elements;
      for (const j of [0, 2, 8, 10]) if (Math.abs(Math.abs(w[j]) - Math.round(Math.abs(w[j]))) > 1e-9) out.square = false;
      if (P.face(m.position.x, m.position.z) !== BF.view.state.f) continue;
      // a vertex through the float32 path the GPU takes (model-view matrix and vertex in float32) against the exact position
      mv.multiplyMatrices(V, m.matrixWorld);
      const q = mv.elements, x = arr[0], y = arr[1], z = arr[2];
      const g = [0, 1, 2].map(r => f32(f32(f32(q[r] * x) + f32(q[4 + r] * y)) + f32(f32(q[8 + r] * z) + f32(q[12 + r]))));
      const ex = new THREE.Vector3(x + m.position.x, y, z + m.position.z);
      const cw = BF.camera.matrix.clone().invert();   // atlas-space view: the camera's own matrix, in doubles
      ex.applyMatrix4(cw);
      out.err = Math.max(out.err, Math.hypot(g[0] - ex.x, g[1] - ex.y, g[2] - ex.z));
    }
    BF.view.end();
    return out;
  });
  check(prec.meshes > 10 && prec.local, `chunk meshes hold chunk-local vertices (${prec.meshes} meshes at atlas x ${Math.round(prec.x)})`);
  check(prec.camAt < 1e-6, "the camera sits at the render origin while drawing");
  check(prec.err < 2e-3, `a vertex drawn in float32 lands within ${prec.err.toExponential(1)} blocks of its exact place (old absolute vertices: up to 0.25)`);
  check(prec.square, "flat-drawn chunk meshes are only turned by quarter turns (blocks stay square)");
  // the far corner keeps still: two frames from the same spot are the same picture
  const still = await pg.evaluate(() => { BF.state.paused = true; const a = grab(), b = grab(); BF.state.paused = false; return diff(a, b); });
  check(still === 0, "two frames from the same spot are identical");

  // ---- the view switching faces: the same spot seen from the margin (old face) and from the canonical face draw the same
  for (const [f, s] of [[4, 1], [0, 2]]) {
    const r = await pg.evaluate(async ([f, s]) => {
      const P = BF.planet, N = P.N, e = P.EDGE[f][s], h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? -2.5 : N + 2.5) : N / 2 + 0.5, v = h[1] ? (h[1] < 0 ? -2.5 : N + 2.5) : N / 2 + 0.5;
      const m = P.atlas(f, u, v), c = P.canon(m.x, m.z, {});
      const yawOut = Math.atan2(-h[0], -h[1]);   // forward (-sin yaw, -cos yaw) = h: looking out across the edge
      const Y = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(c.x), Math.floor(c.z))) + 30;   // above the ground, wherever it is
      BF.player.teleport(c.x, Y, c.z); BF.player.setFlying(true);
      await settle();
      BF.state.paused = true;
      // the margin view: the player held at the margin point, looking out (no edge crossing while paused)
      BF.player.position.set(m.x, Y, m.z); BF.player.setLook(yawOut + Math.PI * 0.15, -0.35);
      await new Promise(r => setTimeout(r, 400));
      const fa = BF.view.state.f, A = grab();
      // the canonical view: the same point on the next face, facing turned by the edge
      const q = (4 - c.turn) % 4;
      BF.player.position.set(c.x, Y, c.z); BF.player.setLook(P.turnYaw(q, yawOut + Math.PI * 0.15), -0.35);
      await new Promise(r => setTimeout(r, 400));
      const fb = BF.view.state.f, B = grab();
      BF.state.paused = false;
      return { g: e.g, turn: e.turn, fa, fb, d: diff(A, B) };
    }, [f, s]);
    check(r.fa === f && r.fb === r.g && r.d < 1.5, `face ${f} edge ${s} (turn ${r.turn}): the margin view on face ${r.fa} and the canonical view on face ${r.fb} match (mean difference ${r.d.toFixed(2)} of 255)`);
  }

  // ---- a straight flight across a turned edge (face 0, side 2: into face 2, one quarter turn)
  await pg.evaluate(async () => {
    const P = BF.planet, N = P.N, a = P.atlas(0, N / 2 + 0.5, 30.5);
    BF.player.teleport(a.x, 60, a.z); BF.player.setFlying(true);
    await settle();
    BF.player.setLook(0.3, -0.2);   // heading toward -v (the edge) and a little sideways
    window.__fl = { yaw0: 0.3, start: { x: BF.player.position.x, z: BF.player.position.z }, pts: [], faces: new Set() };
  });
  await pg.keyboard.down("KeyW");
  for (let i = 0; i < 80; i++) {
    await pg.waitForTimeout(100);
    const done = await pg.evaluate(() => {
      const P = BF.planet, F = window.__fl, p = BF.player.position;
      F.faces.add(P.face(p.x, p.z));
      const r = P.rel(F.start, { x: p.x, z: p.z }, {});   // in the start face's frame
      if (r) F.pts.push([r.x - F.start.x, r.z - F.start.z]);
      return P.face(p.x, p.z) === 2 && F.pts.length && Math.hypot(...F.pts[F.pts.length - 1]) > 70;
    });
    if (done) break;
  }
  await pg.keyboard.up("KeyW");
  const fl = await pg.evaluate(() => {
    const F = window.__fl, pts = F.pts, end = pts[pts.length - 1], l = Math.hypot(end[0], end[1]) || 1;
    let dev = 0;
    for (const p of pts) dev = Math.max(dev, Math.abs(p[0] * end[1] - p[1] * end[0]) / l);
    const dirOk = Math.abs(Math.atan2(-end[0], -end[1]) - F.yaw0) < 0.05;
    return { faces: [...F.faces], len: l, dev, dirOk, yaw: BF.player.yaw };
  });
  check(fl.faces.includes(0) && fl.faces.includes(2) && fl.len > 40, `a flight crossed from face 0 to face 2 (${Math.round(fl.len)} blocks)`);
  check(fl.dev < 0.3 && fl.dirOk, `and stayed straight in the first face's frame (largest sideways drift ${fl.dev.toFixed(3)} blocks)`);

  // ---- corners: the round drawing fills the wedge (compared with the corner gap the flat drawing leaves)
  for (const [f, cu, cv] of [[4, 0, 0], [2, 1, 1]]) {
    const r = await pg.evaluate(async ([f, cu, cv]) => {
      const P = BF.planet, N = P.N, du = cu ? -1 : 1, dv = cv ? -1 : 1;
      const a = P.atlas(f, cu * N + du * 20.5, cv * N + dv * 20.5);
      BF.world.viewDist = 7;
      BF.player.teleport(a.x, 45, a.z); BF.player.setFlying(true);
      BF.view.cornerRound = true;
      await settle(2500);
      BF.state.paused = true;
      BF.player.setLook(Math.atan2(du, dv), -0.25);   // facing the corner: forward = (-du, -dv)
      await new Promise(r => setTimeout(r, 300));
      await settle(500);
      // the largest angle around the corner (in render space, seen from above) with no drawn chunk: 90 degrees where the flat
      // drawing leaves the wedge empty, much less once the round drawing closes it
      const ca = P.atlas(f, cu * N, cv * N);
      const widest = () => {
        BF.view.begin(BF.scene, BF.camera); BF.view.end();
        const c0 = BF.view.toRender(ca.x, BF.SEA, ca.z), angs = [];
        for (const c of BF.world.chunks.values()) {
          if (!c.meshes || !c.meshes.some(m => m.visible)) continue;
          const r = BF.view.toRender(c.cx * 16 + 8, BF.SEA, c.cz * 16 + 8);
          if (!r) continue;
          const dx = r[0] - c0[0], dz = r[2] - c0[2], d = Math.hypot(dx, dz);
          if (d > 12 && d < 80) angs.push(Math.atan2(dz, dx) * 180 / Math.PI);
        }
        angs.sort((p, q) => p - q);
        let w = angs.length ? 360 - (angs[angs.length - 1] - angs[0]) : 360;
        for (let i = 1; i < angs.length; i++) w = Math.max(w, angs[i] - angs[i - 1]);
        return w;
      };
      const k = BF.view.state.k, round = widest();
      BF.view.cornerRound = false;
      const gap = widest();
      BF.view.cornerRound = true;
      BF.state.paused = false;
      return { k, round, gap, corner: BF.view.state.corner };
    }, [f, cu, cv]);
    check(r.k === 1, `near the corner of face ${f} (${Math.round(r.corner)} blocks) the view is fully round`);
    check(r.gap > 80 && r.round < 45, `corner of face ${f}: the round drawing closes the wedge (widest empty angle around the corner ${r.round.toFixed(0)} degrees round, ${r.gap.toFixed(0)} with the gap)`);
  }

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-view" : "PASS planet-view");
};
