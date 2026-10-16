// @ci integration suite=world timeout=600
// Round from high up on the planet (generator 4, spec r14-04): the blend k from the ground to fully round, fog and clip planes by
// height, the sky fading to space, no jumps in the picture through the blend, flight high up following a great circle (also across
// a face edge), creative fast flight speeding up with height, mouse look working at 15,000 and off-planet mode above 20,000 (the
// view turns no more, dragging turns the planet at the same height, the axis line shows), and looking around again below 19,400.
// node test/run.js /tmp/ph test/planet-high.js
module.exports = async (pg, out) => {
  await pg.setViewportSize({ width: 320, height: 200 });
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await pg.evaluate(() => {
    window.__errs = []; addEventListener("error", e => window.__errs.push(e.message));
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
      await new Promise(r => setTimeout(r, 500));
    };
    BF.newWorld(1337, { gen: 4 }); BF.world.viewDist = 4; BF.player.start(); BF.player.setGameMode("creative");
  });
  await pg.evaluate(() => settle(3000));

  // ---- the climb: blend, clip planes, fog and sky at set heights (screenshots kept beside the test output)
  const rows = [];
  for (const h of [100, 600, 1400, 2600, 12000, 60000, 300000]) {
    const r = await pg.evaluate(async (h) => {
      BF.player.setFlying(true); BF.player.position.y = h; BF.player.velocity.y = 0; BF.player.setLook(BF.player.yaw, -1.5);
      BF.state.time = BF.state.time;   // keep the clock running: the sky updates with the simulation
      await new Promise(r => setTimeout(r, 1500));
      const s = BF.view.state, bg = BF.scene.background;
      return { h, k: s.k, above: s.above, near: BF.camera.near, far: BF.camera.far, bg: (bg.r + bg.g + bg.b) / 3, off: BF.player.offPlanet };
    }, h);
    rows.push(r);
    if (out) await pg.screenshot({ path: `${out}-climb-${h}.png` });
  }
  console.log("climb " + JSON.stringify(rows.map(r => [r.h, +r.k.toFixed(2), +r.near.toFixed(2), Math.round(r.far), +r.bg.toFixed(2), r.off])));
  const at = (h) => rows.find(r => r.h === h);
  check(at(100).k === 0 && at(600).k > 0 && at(600).k < 0.2 && at(1400).k > 0.3 && at(1400).k < 0.7 && at(2600).k === 1, "the view is flat near the ground and blends to fully round between 250 and 2,500 blocks up");
  check(rows.every((r, i) => !i || r.near >= rows[i - 1].near) && at(100).near === 0.05 && at(300000).near === 500, "the near plane grows with height, from 0.05 to 500");
  check(rows.every(r => r.far / r.near < 2e5 || r.far < 2e4) && at(300000).far > 390000, "the far plane reaches the horizon high up without wrecking depth precision");
  check(at(100).bg > 0.5 && at(60000).bg < 0.1 && at(300000).bg < 0.1, "the sky fades to space high up");
  check(!at(12000).off && at(60000).off && at(300000).off, "off-planet mode is on above layer 20,000 and off below");

  // ---- no jumps through the blend: small climbs change the picture a little at a time (looking straight down)
  const steps = await pg.evaluate(async () => {
    BF.player.position.y = 200; BF.player.setLook(0, -1.5);
    await settle(1000);
    BF.state.paused = true;
    const clouds = BF.scene.children.filter(c => c.userData && c.userData.sync);   // climbing through the cloud layer is a real change
    for (const c of clouds) c.visible = false;
    const d = []; let prev = null;
    for (let y = 200; y <= 3000; y += 100) {
      BF.player.position.y = y; BF.player.setLook(0, -1.5);
      await new Promise(r => setTimeout(r, 120));
      const px = grab();
      if (prev) d.push(+diff(prev, px).toFixed(2));
      prev = px;
    }
    for (const c of clouds) c.visible = true;
    BF.state.paused = false;
    return d;
  });
  console.log("blend steps " + JSON.stringify(steps));
  check(Math.max(...steps) < 12, `climbing 100 blocks at a time through the blend changes the picture smoothly (largest mean change ${Math.max(...steps)} of 255)`);

  // ---- a great circle, across a face edge: fly diagonally over face 4's +u edge, 5,000 blocks up
  await pg.evaluate(async () => {
    const P = BF.planet, N = P.N, a = P.atlas(4, N - 1200.5, N / 2 + 0.5);
    BF.player.teleport(a.x, 5000, a.z); BF.player.setFlying(true);
    await settle(1500);
    BF.player.setFlying(true); BF.player.position.y = 5000; BF.player.setLook(-Math.PI / 2 - 0.6, -0.2);   // towards +u, turned 34 degrees
    window.__gc = [];
  });
  await pg.keyboard.down("KeyW");
  for (let i = 0; i < 40; i++) {
    await pg.waitForTimeout(150);
    await pg.evaluate(() => { const P = BF.planet, p = BF.player.position, c = P.canon(p.x, p.z, {}); window.__gc.push([c.f, ...P.dir(c.f, c.u, c.v, [0, 0, 0])]); BF.player.position.y = 5000; BF.player.velocity.y = 0; });
  }
  await pg.keyboard.up("KeyW");
  const gc = await pg.evaluate(() => {
    const pts = window.__gc, a = pts[0].slice(1), b = pts[pts.length - 1].slice(1);
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], l = Math.hypot(...n);
    let dev = 0;
    for (const p of pts) dev = Math.max(dev, Math.abs((p[1] * n[0] + p[2] * n[1] + p[3] * n[2]) / l));
    const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    return { faces: [...new Set(pts.map(p => p[0]))], km: ang * BF.planet.R / 1000, dev: dev * BF.planet.R };
  });
  check(gc.faces.length >= 2 && gc.km > 1, `fast flight at 5,000 blocks up covered ${gc.km.toFixed(1)} km and crossed onto face ${gc.faces.join(" then ")}`);
  check(gc.dev < 3, `and followed a great circle (largest distance off it ${gc.dev.toFixed(2)} blocks)`);

  // ---- holding Space in creative flight reaches orbit quickly
  const rise = await pg.evaluate(async () => {
    BF.player.setFlying(true); BF.player.position.y = BF.view.groundAt(BF.player.position.x, BF.player.position.z) + 200; BF.player.velocity.y = 0;
    return BF.player.position.y;
  });
  await pg.keyboard.down("KeyR"); await pg.keyboard.down("Space");
  await pg.waitForTimeout(8000);
  await pg.keyboard.up("Space"); await pg.keyboard.up("KeyR");
  const top = await pg.evaluate(() => BF.player.position.y);
  check(top > 20000, `8 s of Space with R in creative flight climbs from ${Math.round(rise)} to ${Math.round(top)}`);

  // ---- mouse look at 15,000 and off-planet mode above 20,000 (drag-to-look: there is no pointer lock headless)
  const drag = async (dx, dy) => {
    await pg.mouse.move(160, 100); await pg.mouse.down();
    for (let i = 1; i <= 5; i++) await pg.mouse.move(160 + dx * i / 5, 100 + dy * i / 5);
    await pg.mouse.up();
  };
  const st = () => pg.evaluate(() => { const p = BF.player.position, l = BF.planet.latLonAt(p.x, p.z); return { yaw: BF.player.yaw, pitch: BF.player.pitch, x: p.x, y: p.y, z: p.z, lat: l.lat, lon: l.lon, off: BF.player.offPlanet, axis: !!(BF.view.axis() && BF.view.axis().visible) }; });
  await pg.evaluate(() => { BF.player.position.y = 15000; BF.player.setLook(0.3, -0.5); });
  await pg.waitForTimeout(400);
  let a = await st(); await drag(60, 20); let b = await st();
  check(!b.off && Math.abs(b.yaw - a.yaw) > 0.05, `at 15,000 the mouse turns the view (yaw ${a.yaw.toFixed(2)} -> ${b.yaw.toFixed(2)})`);
  await pg.evaluate(() => { BF.player.position.y = 25000; });
  await pg.waitForTimeout(400);
  a = await st(); await drag(60, 20); b = await st();
  check(a.off && b.off && a.pitch === -1.5 && b.pitch === -1.5 && a.axis, "at 25,000 the view is off-planet (facing down, the axis showing) and the mouse no longer looks around");
  await pg.evaluate(() => { BF.player.position.y = 50000; });
  await pg.waitForTimeout(300);
  a = await st(); await drag(80, -40); b = await st();
  check(Math.abs(b.lon - a.lon) > 0.01 && Math.abs(b.lat - a.lat) > 0.01 && Math.abs(b.y - a.y) < 1, `at 50,000 dragging turns the planet at the same height (y ${a.y.toFixed(1)} -> ${b.y.toFixed(1)}, lat ${a.lat.toFixed(2)} -> ${b.lat.toFixed(2)}, lon ${a.lon.toFixed(2)} -> ${b.lon.toFixed(2)})`);
  await pg.evaluate(() => { BF.player.position.y = 19000; });
  await pg.waitForTimeout(400);
  a = await st(); await drag(60, 20); b = await st();
  check(!a.off && !a.axis && a.pitch < -1.2 && Math.abs(b.yaw - a.yaw) > 0.05, "back below 19,400 the mouse looks around again, starting from straight down");

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-high" : "PASS planet-high");
};
