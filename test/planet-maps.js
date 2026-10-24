// @ci integration suite=items timeout=420 hosts=worker,server
// Maps, the compass and directions on the planet (generator 4, spec r14-17). True north is toward the pole: BF.planet.north / bearing agree
// with latitude and longitude, and a margin point's north is its canonical north turned into the margin's frame. At an edge of face 4 (no
// turn) and one that turns (face 0 to face 2), in a floored box straddling the edge with a gold line across it and a lapis line along it
// on the far face: a map of the zone beside the edge, explored from both sides (the far side from its canonical position), shows the gold
// line straight across the edge with no seam and the lapis line straight; the player's arrow stays on the line, heading the same way, when
// the player stands across the edge. A map off a face's middle lines shows a north arrow pointing to the pole; the compass points home
// from another face. An explorer kept in face A's frame across the edge maps the zone it stands in on face B.
// node test/run.js /tmp/pw test/planet-maps.js
module.exports = async (pg) => {
  const lib = require('./lib');
  // a new world of seed 1337 wherever the simulation runs; the planet, the maps and the explorer are read there (spec r15-43), the player
  // is moved on the page (whose body it is)
  const wid = await pg.evaluate(async () => {
    window.__errs = []; addEventListener("error", e => window.__errs.push(e.message));
    BF.player.start();
    return (await BF.save.create({ name: "planet-maps", seed: 1337, gameMode: "creative", gen: 4 })).id;
  });
  await lib.simReady(pg);
  await pg.waitForTimeout(2500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };

  // ---- directions: north toward the pole, east toward increasing longitude
  const dirs = await lib.sim(pg, () => {
    const P = BF.planet, N = P.N, out = [];
    for (const [f, u, v] of [[4, N / 4, N / 3], [0, N * 0.7, N * 0.2], [2, N * 0.3, N * 0.6], [3, N * 0.8, N * 0.4], [1, N / 2, N / 2]]) {
      const a = P.atlas(f, u, v), ll = P.latLonAt(a.x, a.z), n = P.north(a.x, a.z);
      const b = P.latLonAt(a.x + n[0] * 200, a.z + n[1] * 200);
      // the grid direction whose bearing is 90 moves east
      const t = (90 - P.bearing(a.x, a.z, 0, -1)) * Math.PI / 180;   // bearing of -z plus t = 90
      let e = null;
      for (let k = 0; k < 720 && !e; k++) { const w = k * Math.PI / 360, dx = Math.sin(w), dz = -Math.cos(w); if (Math.abs(P.bearing(a.x, a.z, dx, dz) - 90) < 0.3) e = [dx, dz]; }
      const c = P.latLonAt(a.x + e[0] * 200, a.z + e[1] * 200);
      let dlon = c.lon - ll.lon; if (dlon > 180) dlon -= 360; if (dlon < -180) dlon += 360;
      out.push({ f, northUp: b.lat - ll.lat > 0.05, eastOn: dlon > 0.02 && Math.abs(c.lat - ll.lat) < 0.02, bN: Math.round(P.bearing(a.x, a.z, n[0], n[1])), t: isFinite(t) });
    }
    // margin points: north is the canonical north turned into the margin's frame (checked by stepping along it through the margin)
    const m = [];
    for (const [f, s] of [[4, 1], [0, 2], [0, 3]]) {
      const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s], o = (h[0] || h[1]) < 0 ? -3.5 : N + 3.5, a = h[0] ? P.atlas(f, o, N * 0.3) : P.atlas(f, N * 0.3, o);
      const n = P.north(a.x, a.z), ll = P.latLonAt(a.x, a.z), b = P.latLonAt(a.x + n[0] * 20, a.z + n[1] * 20);
      m.push(b.lat - ll.lat > 0.004);
    }
    return { out, margin: m, names: [P.compassPoint(0), P.compassPoint(44), P.compassPoint(181, true), P.compassPoint(359)] };
  });
  check(dirs.out.every(o => o.northUp && o.eastOn && (o.bN === 0 || o.bN === 360)), `north leads toward the pole and east toward increasing longitude on every face ${JSON.stringify(dirs.out)}`);
  check(dirs.margin.every(Boolean), `a margin point's north leads toward the pole through the margin ${JSON.stringify(dirs.margin)}`);
  check(dirs.names.join() === "north,north-east,S,north", `compass point names ${JSON.stringify(dirs.names)}`);

  for (const [f, s] of [[4, 1], [0, 2]]) {
    // the cell k across the edge, j along it (atlas address, through face A's margin for k >= 0), and its canonical cell's middle
    const atSrc = `(f, s) => { const P = BF.planet, N = P.N, h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const at = (k, j) => { const o = (h[0] || h[1]) < 0 ? -1 - k : N + k, a = N / 2 + j; return h[0] ? P.atlas(f, o, a) : P.atlas(f, a, o); };
      const cc = (k, j) => { const a = at(k, j), c = P.canonCell(a.x, a.z); return { x: c.x + 0.5, z: c.z + 0.5 }; };
      return { at, cc, h }; }`;
    await pg.evaluate(([f, s, src]) => {
      const { at } = (0, eval)(src)(f, s), sp = at(-8, 0);
      BF.player.setGameMode && BF.player.setGameMode("creative");
      BF.player.teleport(sp.x + 0.5, Math.max(BF.worldgen.heightAt(sp.x, sp.z), BF.SEA) + 30, sp.z + 0.5); BF.player.setFlying(true);
    }, [f, s, atSrc]);
    const setup = await lib.sim(pg, async ([f, s, src]) => {
      const P = BF.planet, W = BF.world, o = (0, eval)(src)(f, s), at = o.at;
      globalThis.__at = o.at; globalThis.__cc = o.cc; globalThis.__h = o.h;
      for (let i = 0; i < 160; i++) {
        await new Promise(r => setTimeout(r, 250));
        let ok = true;
        for (const [k, j] of [[-24, -24], [-24, 24], [24, -24], [24, 24], [0, 0]]) { const a = at(k, j), c = W.chunkAt(a.x, a.z); if (!c) ok = false; }
        if (ok) break;
      }
      let top = BF.SEA;
      for (let k = -24; k <= 24; k++) for (let j = -24; j <= 24; j++) { const a = at(k, j); top = Math.max(top, W.heightAt(a.x, a.z)); }
      const y = top + 3, B = BF.B;
      for (let k = -24; k <= 24; k++) for (let j = -24; j <= 24; j++) {
        const a = at(k, j), want = (j === 0 || j === 1) && Math.abs(k) <= 20 ? B.gold_block : (k === 16 || k === 17) && Math.abs(j) <= 20 ? B.lapis_block : B.stone;
        for (let yy = y - 1; yy < y + 8; yy++) { const id = yy === y - 1 ? want : 0; if (W.getBlock(a.x, yy, a.z) !== id) W.setBlock(a.x, yy, a.z, id); }
      }
      return { y, g: P.EDGE[f][s].g, turn: P.EDGE[f][s].turn, gold: !!B.gold_block, lapis: !!B.lapis_block };
    }, [f, s, atSrc]);
    const tag = `face ${f} edge ${s} (to face ${setup.g}, turn ${setup.turn})`;
    if (!setup.gold || !setup.lapis) { check(false, `${tag}: gold and lapis blocks exist`); continue; }

    const r = await lib.sim(pg, ([y]) => {
      const P = BF.planet, M = BF.maps, at = globalThis.__at, cc = globalThis.__cc, h = globalThis.__h, out = {};
      // a size 2 map (2 blocks a pixel) of the zone on face A beside the edge: it reaches 64 blocks over the edge
      const a0 = at(-1, 0), zx = M.zoneOf(a0.x), zz = M.zoneOf(a0.z), size = 2;
      M.reset();
      const d = M.getData(size, zx, zz), sc = M.scale(size), ox = M.originX(size, zx), oz = M.originX(size, zz);
      out.face = M.faceOf(d);
      const px = a => { const i = Math.floor((a.x + 0.5 - ox) / sc), j = Math.floor((a.z + 0.5 - oz) / sc); return d.px[j * M.PX + i]; };
      const big = 200000;
      // explored from the far side first, from its canonical position: only pixels across the edge fill in
      const pB = cc(22, 0);
      M.explore(d, pB.x, pB.z, big);
      out.farFirst = { b: !!px(at(14, 0)), a: !!px(at(-14, 0)) };
      out.farB = !!px(at(2, 0));
      const pA = cc(-22, 0);
      M.explore(d, cc(0, 0).x, cc(0, 0).z, big);
      M.explore(d, pA.x, pA.z, big);
      const gold = px(at(-5, 0)), lapis = px(at(16, 5));
      const line = []; for (let k = -14; k <= 14; k++) line.push(px(at(k, 0)) === gold ? 1 : 0);
      const lap = []; for (let j = -18; j <= 18; j++) if (j < -1 || j > 2) lap.push(px(at(16, j)) === lapis ? 1 : 0);
      out.line = line.join(""); out.lap = lap.join(""); out.distinct = gold && lapis && gold !== lapis; out.cols = [gold, lapis];
      // the player standing across the edge, facing +k: the arrow sits on the gold line just past the edge, heading +k
      const pp = cc(6, 0), yawOut = Math.atan2(-h[0], -h[1]);   // forward (-sin, -cos) = h in A's frame
      BF.player.teleport(pp.x, y, pp.z);
      const turnB = P.canon(at(6, 0).x + 0.5, at(6, 0).z + 0.5).turn;
      BF.player.setLook(P.turnYaw((4 - turnB) % 4, yawOut), 0);
      const mp = M.mapPos(d), want = at(6, 0);
      out.arrow = { dx: +(mp.x - want.x - 0.5).toFixed(2), dz: +(mp.z - want.z - 0.5).toFixed(2), fwd: +(-Math.sin(mp.yaw) * h[0] - Math.cos(mp.yaw) * h[1]).toFixed(3) };
      out.northOn = M.northOn(d);
      // an explorer kept in face A's frame (as a village's villagers are) standing across the edge: the blank map it uses becomes the
      // map of the zone it really stands in on face B, and the patch it walks to next is given in its own frame, near it
      const ex = BF.mobs.spawn("villager", cc(-3, 0).x, y, cc(-3, 0).z), ep = at(6, 0);
      ex.position.set(ep.x + 0.5, y, ep.z + 0.5);   // a margin address of face A (where a village on A keeps its villagers)
      ex.inv = BF.trades.stockFor("explorer", ex); BF.trades.inv.add(ex.inv, BF.I.blank_map_1, 1);
      const X = BF.explorer, used = X.useBlank(ex), c = X.carried(ex)[0];
      const zc = P.canonCell(ep.x, ep.z);
      out.explorer = { used, zone: c ? [c.it.map.zx, c.it.map.zz] : null, want: [M.zoneOf(zc.x), M.zoneOf(zc.z)] };
      if (c) {
        const t = X.pickTarget(ex, c).best;
        out.explorer.target = t ? +Math.hypot(t.wx - ex.position.x, t.wz - ex.position.z).toFixed(1) : null;
      }
      BF.mobs.kill(ex);
      return out;
    }, [setup.y]);
    check(r.face === f, `${tag}: the map belongs to face ${r.face}`);
    check(r.farFirst.b && !r.farFirst.a, `${tag}: explored from the far face's own coordinates, the map fills in across the edge ${JSON.stringify(r.farFirst)}`);
    check(r.distinct && r.line === "1".repeat(29), `${tag}: the gold line runs straight across the edge with no seam ${r.line} ${JSON.stringify(r.cols)}`);
    check(r.lap === "1".repeat(33), `${tag}: the lapis line on the far face is straight ${r.lap}`);
    check(Math.abs(r.arrow.dx) < 0.01 && Math.abs(r.arrow.dz) < 0.01 && r.arrow.fwd > 0.999, `${tag}: standing across the edge, the player's arrow is in place and heads the same way ${JSON.stringify(r.arrow)}`);
    check(r.explorer.used && JSON.stringify(r.explorer.zone) === JSON.stringify(r.explorer.want) && r.explorer.target !== null && r.explorer.target < 200,
      `${tag}: an explorer across the edge maps the zone it stands in and walks to a patch near it ${JSON.stringify(r.explorer)}`);
    check(r.northOn === null, `${tag}: on a face's middle line the map's up is north (no north arrow) ${r.northOn}`);
  }

  // ---- a map away from a face's middle lines shows a north arrow pointing at the pole; the compass points home from another face
  const far = await lib.sim(pg, async () => {
    const P = BF.planet, M = BF.maps, N = P.N, out = {};
    const a = P.atlas(2, N * 0.25, N * 0.3), zx = M.zoneOf(a.x), zz = M.zoneOf(a.z), d = M.getData(3, zx, zz);
    const ang = M.northOn(d), c = M.side(3) / 2, cx = M.originX(3, zx) + c, cz = M.originX(3, zz) + c;
    const n = [Math.sin(ang), -Math.cos(ang)];   // the arrow's direction on the map (0 = up, clockwise)
    const l0 = P.latLonAt(cx, cz), l1 = P.latLonAt(cx + n[0] * 100, cz + n[1] * 100);
    out.arrow = ang !== null && Math.abs(ang) > 0.1;
    out.toPole = l1.lat - l0.lat;
    // compass: spawn in the middle of face 4, the player in the middle of face 0 looking toward the face 0 / face 4 edge
    const e = [0, 1, 2, 3].find(s => P.EDGE[0][s].g === 4), h = [[-1, 0], [1, 0], [0, -1], [0, 1]][e];
    const s4 = P.atlas(4, N / 2 + 0.5, N / 2 + 0.5), p0 = P.atlas(0, N / 2 + 0.5, N / 2 + 0.5);
    const keep = BF.spawnPoint;
    BF.spawnPoint = { x: s4.x, y: 100, z: s4.z };
    BF.player.teleport(p0.x, 3000, p0.z); BF.player.setFlying(true);
    BF.player.setLook(Math.atan2(-h[0], -h[1]), 0);
    out.ahead = +M.compassAngle().toFixed(3);
    BF.player.setLook(Math.atan2(-h[0], -h[1]) + Math.PI / 2, 0);   // turned left a quarter: home is on the right
    out.right = +M.compassAngle().toFixed(3);
    BF.spawnPoint = keep;
    return out;
  });
  check(far.arrow && far.toPole > 0.02, `off the middle lines the map shows a north arrow pointing at the pole ${JSON.stringify(far)}`);
  check(Math.abs(far.ahead) < 0.05 && Math.abs(far.right - Math.PI / 2) < 0.05, `the compass points home from another face (ahead ${far.ahead}, turned left ${far.right})`);

  await pg.evaluate(id => BF.save.remove(id), wid);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-maps" : "PASS planet-maps");
};
