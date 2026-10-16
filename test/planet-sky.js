// @ci integration suite=world timeout=600
// Sky, weather and sound on the planet (generator 4, spec r14-20): the sun keeps 1.3's path at face 4's centre and its true heading
// across a turned edge; clouds are one field over the planet, so the sky seen from a face's margin and from the next face match
// (across an edge that turns and one that doesn't); the wind slides the clouds smoothly (a rebuild shows the cells the slide
// predicted); rain stops at the same column tops on both sides of an edge; snow follows the climate band; lightning across an edge
// reports its canonical column and hits what is there; sounds on the next face are heard beside the listener.
// node test/run.js /tmp/ps test/planet-sky.js
module.exports = async (pg) => {
  await pg.setViewportSize({ width: 320, height: 200 });   // small: swiftshader is slow
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
      await new Promise(r => setTimeout(r, 600));
    };
    // a fixed half-cloudy sky (cover otherwise drifts with game time)
    const ud = BF.sky.cloudMesh.userData, orig = ud.setCoverage;
    ud.setCoverage = () => orig(0.5);
    BF.newWorld(1337, { gen: 4 }); BF.world.viewDist = 4; BF.player.start(); BF.player.setGameMode("creative");
    BF.mobs.spawning = false;
  });
  await pg.evaluate(() => settle(3000));

  // ---- the sun at face 4's centre runs as in 1.3 (heading 0.35)
  const centre = await pg.evaluate(async () => {
    const P = BF.planet, a = P.atlas(4, P.N / 2 + 0.5, P.N / 2 + 0.5);
    BF.player.teleport(a.x, 80, a.z); BF.player.setFlying(true);
    await settle();
    BF.sky.update(0);
    return { yaw: BF.sky.sunYaw, cell: BF.sky.cloudCellSize };
  });
  check(Math.abs(centre.yaw - 0.35) < 1e-3, `the sun's path at face 4's centre has 1.3's heading (${centre.yaw.toFixed(4)})`);
  check(centre.cell === 10, `planet cloud cells are ${centre.cell} blocks (a divisor of the face size)`);

  // ---- the wind: 20 s of drift, then the cells after the rebuilds are the cells the slide predicted
  const wind = await pg.evaluate(() => {
    const S = BF.sky, D = S.planetDrift, cam = BF.camera.position;
    const sample = () => {
      const CS = S.cloudCellSize, m = new Map();
      for (let dz = -150; dz <= 150; dz += 7) for (let dx = -150; dx <= 150; dx += 7) {
        const x = cam.x + dx, z = cam.z + dz;
        m.set(dx + "," + dz, S.cloudCell(Math.floor((x - D[0]) / CS), Math.floor((z - D[1]) / CS)));
      }
      return m;
    };
    BF.state.paused = true;
    S.update(0);
    const before = sample();
    let mx = 0, mz = 0, px = D[0], pz = D[1];
    for (let i = 0; i < 400; i++) {
      S.update(0.05);
      let ddx = D[0] - px, ddz = D[1] - pz;
      const CS = S.cloudCellSize;
      if (ddx > CS / 2) ddx -= CS; if (ddx < -CS / 2) ddx += CS;
      if (ddz > CS / 2) ddz -= CS; if (ddz < -CS / 2) ddz += CS;
      mx += ddx; mz += ddz; px = D[0]; pz = D[1];
    }
    const CS = S.cloudCellSize;
    let n = 0, wrong = 0, cloudy = 0;
    for (const [k, was] of before) {   // the cloud that was over (cam + o) is now over (cam + o + slide)
      const [dx, dz] = k.split(",").map(Number);
      if (Math.abs(dx) > 120 || Math.abs(dz) > 120) continue;
      const x = cam.x + dx + mx, z = cam.z + dz + mz;
      const now = S.cloudCell(Math.floor((x - D[0]) / CS), Math.floor((z - D[1]) / CS));
      n++; cloudy += now; if (now !== was) wrong++;
    }
    BF.state.paused = false;
    return { mx, mz, n, wrong, cloudy };
  });
  check(Math.abs(Math.hypot(wind.mx, wind.mz) - 24) < 2.5 && wind.mx > 20, `the wind blew the clouds ${wind.mx.toFixed(1)}, ${wind.mz.toFixed(1)} blocks in 20 s (east, 1.2 a second at the equator)`);
  check(wind.cloudy > wind.n * 0.25 && wind.cloudy < wind.n * 0.75, `about half the sky is cloud (${wind.cloudy} of ${wind.n} samples)`);
  check(wind.wrong <= Math.ceil(wind.n * 0.01), `the rebuilt cells continue the slide (${wind.wrong} of ${wind.n} samples changed)`);

  // ---- across an edge: the sky (sun and clouds) seen from the margin and from the next face match
  for (const [f, s] of [[4, 1], [0, 2]]) {
    const r = await pg.evaluate(async ([f, s]) => {
      const P = BF.planet, N = P.N, e = P.EDGE[f][s], h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? -2.5 : N + 2.5) : N / 2 + 0.5, v = h[1] ? (h[1] < 0 ? -2.5 : N + 2.5) : N / 2 + 0.5;
      const m = P.atlas(f, u, v), c = P.canon(m.x, m.z, {});
      // above the ground (the planet's terrain stands well above y 60 in places; from inside the rock the clouds are hidden)
      const Y = Math.max(60, Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(c.x), Math.floor(c.z))) + 30);
      BF.player.teleport(c.x, Y, c.z); BF.player.setFlying(true);
      await settle();
      BF.state.paused = true;
      BF.sky.setTime(0.07);   // morning: the sun low in the east
      BF.weather.set("clear"); BF.weather.intensity = 0; BF.weather.thunder = 0;
      BF.player.position.set(m.x, Y, m.z); BF.player.setLook(0, 0);
      await new Promise(r => setTimeout(r, 300));
      BF.sky.update(0);
      const fy = BF.sky.sunYaw, look = Math.atan2(-Math.cos(fy), Math.sin(fy)) + 0.25;   // facing the sun, a little to its left
      BF.player.setLook(look, 0.45);
      await new Promise(r => setTimeout(r, 300));
      BF.sky.update(0);
      const fa = BF.view.state.f, A = grab(), ya = BF.sky.sunYaw, ha = BF.sky.cloudHeight;
      BF.sky.cloudMesh.visible = false; const A0 = grab(); BF.sky.cloudMesh.visible = true;
      const q = (4 - c.turn) % 4;
      BF.player.position.set(c.x, Y, c.z); BF.player.setLook(P.turnYaw(q, look), 0.45);
      await new Promise(r => setTimeout(r, 300));
      BF.sky.update(0);
      const fb = BF.view.state.f, B = grab(), yb = BF.sky.sunYaw, hb = BF.sky.cloudHeight;
      BF.sky.cloudMesh.visible = false; const B0 = grab(); BF.sky.cloudMesh.visible = true;
      BF.state.paused = false;
      // how much of the picture is cloud (so the comparison is not of empty sky)
      let white = 0;
      for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - A0[i]) + Math.abs(A[i + 1] - A0[i + 1]) + Math.abs(A[i + 2] - A0[i + 2]) > 6) white++;
      return { g: e.g, turn: e.turn, fa, fb, d: diff(A, B), d0: diff(A0, B0), ya, yb, ha, hb, white: white / (A.length / 4) };
    }, [f, s]);
    check(r.fa === f && r.fb === r.g, `face ${f} edge ${s} (turn ${r.turn}): margin view on face ${r.fa}, canonical view on face ${r.fb}`);
    check(r.white > 0.05, `clouds fill ${(r.white * 100).toFixed(0)}% of the picture`);
    check(r.d < 0.5, `the sky matches either side of the edge (mean difference ${r.d.toFixed(2)} of 255, ${r.d0.toFixed(2)} without the clouds; sun heading ${r.ya.toFixed(3)} then ${r.yb.toFixed(3)} in each face's frame; clouds at y${r.ha} and y${r.hb})`);
  }

  // ---- rain stops at the same column tops on both sides of an edge; lightning there reports its canonical column
  const edge = await pg.evaluate(async () => {
    const P = BF.planet, N = P.N, a = P.atlas(4, N - 3.5, N / 2 + 0.5);
    BF.player.teleport(a.x, 40, a.z); BF.player.setFlying(true);
    await settle();
    BF.weather.set("rain"); BF.weather.intensity = 1;
    let same = 0, n = 0, wet = 0;
    for (let dz = -8; dz <= 8; dz += 2) for (let du = 1; du <= 12; du += 1) {
      const m = P.atlas(4, N - 1 + du + 0.5, N / 2 + dz + 0.5), c = P.canon(m.x, m.z, {});
      const top = BF.world.heightAt(m.x, m.z);
      for (const y of [top + 1, top - 2]) {
        const r1 = BF.weather.rainingAt(m.x, y, m.z), r2 = BF.weather.rainingAt(c.x, y, c.z);
        n++; if (r1 === r2) same++; if (r1) wet++;
      }
    }
    // a strike just across the edge (its margin address) and a pig standing there
    const m = P.atlas(4, N + 1.5, N / 2 + 0.5), c = P.canonCell(Math.floor(m.x), Math.floor(m.z), {});
    const top = BF.world.heightAt(m.x, m.z);
    const pig = BF.mobs.spawn("pig", c.x + 0.5, top + 1, c.z + 0.5), hp = pig.hp;
    BF.weather.strikeAt(Math.floor(m.x), top + 1, Math.floor(m.z));
    const s = BF.weather.lastStrike;
    const pp = BF.player.position, dy = top + 1 - pp.y;
    const out = { n, same, wet, sx: s.x, sz: s.z, cx: c.x + 0.5, cz: c.z + 0.5, face: P.face(s.x, s.z), g: P.EDGE[4][1].g, dist: s.dist,
      want: Math.hypot(Math.floor(m.x) + 0.5 - pp.x, dy, Math.floor(m.z) + 0.5 - pp.z), hit: pig.hp < hp };
    BF.mobs.hit(pig, 99, null);
    // sounds: the canonical point across the edge is heard beside the listener (at its margin address)
    const L = BF.audio.listener, cam = BF.camera.position;
    L.x = cam.x; L.y = cam.y; L.z = cam.z;
    const r = BF.audio.relXZ(c.x + 0.5, c.z + 0.5);
    out.sound = r ? Math.hypot(r[0] - Math.floor(m.x) - 0.5, r[1] - Math.floor(m.z) - 0.5) : -1;
    BF.weather.set("clear"); BF.weather.intensity = 0;
    return out;
  });
  check(edge.same === edge.n && edge.wet > 0, `rain across the edge: margin and canonical columns agree (${edge.same} of ${edge.n}, ${edge.wet} wet)`);
  check(edge.face === edge.g && edge.sx === edge.cx && edge.sz === edge.cz, `lightning across the edge reports the canonical column on face ${edge.face}`);
  check(Math.abs(edge.dist - edge.want) < 1e-6, `its distance from the player is measured across the edge (${edge.dist.toFixed(2)})`);
  check(edge.hit, "it hits a pig standing in the canonical column");
  check(edge.sound >= 0 && edge.sound < 1e-6, `a sound on the next face is heard at its place beside the listener (${edge.sound})`);

  // ---- rain and snow follow the planet's biomes (their temperatures; r14-09's climate bands set those)
  const snow = await pg.evaluate(() => {
    const P = BF.planet, st = {};
    for (let i = 0; i < 3000; i++) {
      const a = P.atlasOfLatLon(Math.asin((i * 0.618034) % 2 - 1) * 180 / Math.PI, (i * 137.508) % 360 - 180, {});
      const h = BF.worldgen.heightAt(a.x, a.z);
      if (h < BF.SEA + 1) continue;
      const b = BF.worldgen.biomeAt(a.x, a.z).name, s = st[b] || (st[b] = [0, 0, 0]);
      s[BF.weather.precipAt(a.x, a.z, h + 1)]++;
    }
    return st;
  });
  const share = (names, k) => { let a = 0, n = 0; for (const b of names) { const s = snow[b]; if (s) { a += s[k]; n += s[0] + s[1] + s[2]; } } return [n ? a / n : 1, n]; };
  const temperate = share(["Plains", "Forest", "Birch Forest", "Dark Forest", "Flower Forest", "Meadow"], 2);
  const cold = share(["Snowy Plains", "Snowy Taiga", "Ice Spikes", "Jagged Peaks", "Snowy Slopes", "Snowy Beach"], 2);
  const dry = share(["Desert", "Savanna", "Badlands"], 0);
  check(temperate[0] < 0.05, `temperate land rarely snows (${(temperate[0] * 100).toFixed(1)}% of ${temperate[1]})`);
  check(cold[1] === 0 || cold[0] > 0.9, `snowy biomes snow (${(cold[0] * 100).toFixed(1)}% of ${cold[1]})`);
  check(dry[1] === 0 || dry[0] > 0.9, `dry biomes stay dry (${(dry[0] * 100).toFixed(1)}% of ${dry[1]})`);

  // ---- cost of a planet cloud rebuild (JavaScript only)
  const ms = await pg.evaluate(() => {
    const ud = BF.sky.cloudMesh.userData, t0 = performance.now();
    for (let i = 0; i < 20; i++) { ud.invalidate(); BF.sky.update(0); }
    return (performance.now() - t0) / 20;
  });
  check(ms < 40, `a planet cloud rebuild takes ${ms.toFixed(1)} ms`);

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-sky" : "PASS planet-sky");
};
