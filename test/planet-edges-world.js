// @ci integration suite=world timeout=360 hosts=worker,server
// Light, water and growth across face edges on the planet (generator 4, spec r14-14). At an edge of face 4 (no turn) and at two that
// turn (face 0 to faces 2 and 3), in a cleared, floored box that straddles the edge and is addressed through face A's margin: a roof over
// face A that reaches across the edge is lit from the open sky on face B and shades the cells under it on both faces; a torch beside
// the edge lights the next face (and its chunk is remeshed), and the light goes when the torch does; farmland across the edge from
// water is hydrated; grass spreads across; a sapling placed across the edge is tracked by its canonical cell and grows a whole tree over both faces; water poured
// beside the edge flows across and stops seven blocks out.
// node test/run.js /tmp/pw test/planet-edges-world.js [--host page|worker|server]
// The light, water and growth rules are the simulation's: each step runs where the simulation is (spec r15-43), with the page's body
// held out of it (the steps move the player there).
const lib = require('./lib');
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  await lib.newWorld(pg, 1337, { gen: 4 });
  await pg.evaluate(() => BF.player.start());
  await lib.alone(pg, true);
  await pg.waitForTimeout(2500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };

  for (const [f, s] of [[4, 1], [0, 2], [0, 3]]) {
    // set up: a box k = -8..8 (k < 0 on face A, k >= 0 across the edge on face B), j = -8..8 along the edge, stone floor at y - 1, air above
    const setup = await lib.sim(pg, async ([f, s]) => {
      const P = BF.planet, N = P.N, W = BF.world, h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const at = (k, j) => {   // the atlas address (through A's margin for k >= 0) of the cell k across the edge, j along it
        const o = (h[0] || h[1]) < 0 ? -1 - k : N + k, a = N / 2 + j;
        return h[0] ? P.atlas(f, o, a) : P.atlas(f, a, o);
      };
      globalThis.__at = at;
      const sp = at(-7, 0);
      BF.player.spawn(sp.x + 0.5, Math.max(BF.worldgen.heightAt(sp.x, sp.z), BF.SEA) + 30, sp.z + 0.5);
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 250));
        let ok = true;
        for (const [k, j] of [[-10, -10], [-10, 10], [10, -10], [10, 10], [0, 0]]) { const a = at(k, j), c = W.chunkAt(a.x, a.z); if (!c || (BF.page && c.mesh === undefined)) ok = false; }
        if (ok) break;
      }
      let top = BF.SEA;
      for (let k = -8; k <= 8; k++) for (let j = -8; j <= 8; j++) { const a = at(k, j); top = Math.max(top, W.heightAt(a.x, a.z)); }
      const y = top + 2;
      const ps = at(-7, 8);
      for (let k = -9; k <= 9; k++) for (let j = -9; j <= 9; j++) {
        const a = at(k, j), edge = Math.abs(k) > 8 || Math.abs(j) > 8;
        for (let yy = y - 1; yy < y + 40; yy++) {
          const want = yy === y - 1 && !edge ? BF.B.stone : 0;
          if (edge && yy === y - 1) continue;
          if (W.getBlock(a.x, yy, a.z) !== want) W.setBlock(a.x, yy, a.z, want);
        }
      }
      BF.player.spawn(ps.x + 0.5, y, ps.z + 0.5);   // on the floor, in a corner of the box
      const e = P.EDGE[f][s], a0 = at(-1, 0), b0 = at(0, 0);
      return { y, g: e.g, turn: e.turn, faces: [P.canon(a0.x + 0.5, a0.z + 0.5).f, P.canon(b0.x + 0.5, b0.z + 0.5).f] };
    }, [f, s]);
    const tag = `face ${f} edge ${s} (to face ${setup.g}, turn ${setup.turn})`;
    check(setup.faces[0] === f && setup.faces[1] === setup.g, `${tag}: the test box straddles the edge ${JSON.stringify(setup.faces)}`);
    const y = setup.y;

    // sky light: a roof at y + 1 over k = -5..1, j = -5..5; the open column at k = 2 lights the cells under it, one less per step
    const sky = await lib.sim(pg, ([y]) => {
      const W = BF.world, at = globalThis.__at, S = BF.skyLight;
      for (let k = -5; k <= 1; k++) for (let j = -5; j <= 5; j++) { const a = at(k, j); W.setBlock(a.x, y + 1, a.z, BF.B.stone); }
      const v = k => { const a = at(k, 0); return S.get(a.x, y, a.z); };
      const out = { open: v(2), b1: v(1), b0: v(0), a1: v(-1), a2: v(-2) };
      // the same cells read at their canonical addresses
      const c = BF.planet.canonCell(at(0, 0).x, at(0, 0).z, {});
      out.b0canon = S.get(c.x, y, c.z);
      for (let k = -5; k <= 1; k++) for (let j = -5; j <= 5; j++) { const a = at(k, j); W.setBlock(a.x, y + 1, a.z, 0); }
      out.after = v(-2);
      return out;
    }, [y]);
    check(sky.open === 15 && sky.b1 === 14 && sky.b0 === 13 && sky.a1 === 12 && sky.a2 === 11 && sky.b0canon === 13,
      `${tag}: a roof across the edge is lit from the open side across it and shades both faces ${JSON.stringify(sky)}`);
    check(sky.after === 15, `${tag}: the roof gone, the sky light is back (${sky.after})`);

    // block light: a torch two cells before the edge lights the next face; the chunk across is remeshed; the light goes with the torch
    const bl = await lib.sim(pg, ([y]) => {
      const W = BF.world, at = globalThis.__at, L = BF.light, P = BF.planet;
      const t = at(-2, 0), E = BF.EMIT[BF.B.torch];
      const far = at(2, 0), cf = P.canonCell(far.x, far.z, {}), keyB = Math.floor(cf.x / 16) + "," + Math.floor(cf.z / 16);
      W._dirty.clear();
      W.setBlock(t.x, y, t.z, BF.B.torch);
      const out = { E, dirtyB: W._dirty.has(keyB), k2: L.get(far.x, y, far.z), k2canon: L.get(cf.x, y, cf.z), k2j2: L.get(at(2, 2).x, y, at(2, 2).z), k5: L.get(at(5, 0).x, y, at(5, 0).z) };
      W.setBlock(t.x, y, t.z, 0);
      out.gone = L.get(far.x, y, far.z) + L.get(at(5, 0).x, y, at(5, 0).z);
      return out;
    }, [y]);
    check(bl.k2 === bl.E - 4 && bl.k2canon === bl.E - 4 && bl.k2j2 === bl.E - 6 && bl.k5 === bl.E - 7, `${tag}: a torch beside the edge lights the next face ${JSON.stringify(bl)}`);
    check(bl.dirtyB, `${tag}: the chunk across the edge is remeshed when the light changes`);
    check(bl.gone === 0, `${tag}: breaking the torch takes its light off the next face`);

    // farmland, grass and a sapling (growth rules read their neighbours through the margin; tracked cells are canonical)
    const grow = await lib.sim(pg, ([y]) => {
      const W = BF.world, at = globalThis.__at, P = BF.planet, B = BF.B, cc = a => P.canonCell(a.x, a.z, {});
      const out = {};
      // water sunk into the floor at k = -1, farmland across the edge at k = +1 (two blocks away)
      const w = at(-1, 6), fl = at(1, 6), cf = cc(fl);
      W.setBlock(w.x, y - 1, w.z, B.water);
      W.setBlock(fl.x, y - 1, fl.z, B.farmland_dry);
      out.hydrated = BF.farmland.hydrated(cf.x, y - 1, cf.z);
      BF.farmland.check(cf.x, y - 1, cf.z);
      out.farmWet = W.getBlock(fl.x, y - 1, fl.z) === B.farmland;
      W.setBlock(w.x, y - 1, w.z, B.stone); W.setBlock(fl.x, y - 1, fl.z, B.stone);
      // grass at k = -1 next to dirt at k = 0
      const g = at(-1, 3), d = at(0, 3), cd = cc(d);
      W.setBlock(g.x, y - 1, g.z, B.grass); W.setBlock(d.x, y - 1, d.z, B.dirt);
      out.grass = BF.grass.check(cd.x, y - 1, cd.z) && W.getBlock(d.x, y - 1, d.z) === B.grass;
      W.setBlock(g.x, y - 1, g.z, B.stone); W.setBlock(d.x, y - 1, d.z, B.stone);
      // an oak sapling at k = 0 (placed through the margin, on dirt, so it may grow), grown into a tree: its canopy spreads over both faces
      const sp = at(0, -4), csp = cc(sp);
      W.setBlock(sp.x, y - 1, sp.z, B.dirt); W.setBlock(sp.x, y, sp.z, B.oak_sapling);
      BF.emit("blockPlaced", sp.x, y, sp.z, B.oak_sapling);   // as the player placing it through the margin
      out.tracked = BF.forester.saplings.has(csp.x + "," + y + "," + csp.z);
      out.tree = BF.forester.growTree(csp.x, y, csp.z);
      let leavesA = 0, leavesB = 0, logs = 0;
      for (let k = -4; k <= 4; k++) for (let j = -8; j <= 0; j++) for (let yy = y; yy < y + 12; yy++) {
        const a = at(k, j), id = W.getBlock(a.x, yy, a.z);
        if (id === B.oak_leaves) { if (k < 0) leavesA++; else leavesB++; }
        if (id === B.oak_log) logs++;
      }
      Object.assign(out, { leavesA, leavesB, logs, trunk: W.getBlock(sp.x, y, sp.z) === B.oak_log && W.getBlock(sp.x, y + 1, sp.z) === B.oak_log });
      for (let k = -4; k <= 4; k++) for (let j = -8; j <= 0; j++) for (let yy = y; yy < y + 12; yy++) { const a = at(k, j); if (W.getBlock(a.x, yy, a.z)) W.setBlock(a.x, yy, a.z, 0); }
      W.setBlock(sp.x, y - 1, sp.z, B.stone);
      return out;
    }, [y]);
    check(grow.hydrated === true && grow.farmWet, `${tag}: farmland across the edge from water is hydrated ${JSON.stringify(grow)}`);
    check(grow.grass, `${tag}: grass spreads across the edge`);
    check(grow.tracked && grow.tree && grow.trunk && grow.leavesA > 4 && grow.leavesB > 4, `${tag}: a sapling placed across the edge is tracked canonically and grows a whole tree over both faces`);

    // water: a source at k = -1 flows across the edge and stops 7 blocks out (k = 6 is the thinnest level, k = 7 stays dry)
    const water = await lib.sim(pg, async ([y]) => {
      const W = BF.world, at = globalThis.__at, FL = BF.FLUID, lv = k => FL[W.getBlock(at(k, 0).x, y, at(k, 0).z)] || 0;
      const src = at(-1, 0);
      W.setBlock(src.x, y, src.z, BF.B.water);
      // spread steps driven here on the simulation clock (a frame steps it by at most 0.05 s, and frames are slow while chunks generate)
      const steps = n => { for (let i = 0; i < n; i++) { BF.warp.advance(0.26); W.tickSim(); } };
      steps(40);   // well past the 7 it needs: it must not go further
      const out = { levels: [-1, 0, 1, 2, 5, 6, 7].map(lv), side: FL[W.getBlock(at(2, 3).x, y, at(2, 3).z)] || 0 };
      // tidy up: the source goes and the flow drains away
      W.setBlock(src.x, y, src.z, 0);
      steps(30);
      out.drained = lv(3);
      return out;
    }, [y]);
    check(water.levels.join() === "8,1,2,3,6,7,0", `${tag}: water poured beside the edge flows across and stops ${JSON.stringify(water)}`);
    check(water.side === 6 && water.drained === 0, `${tag}: it spreads sideways on the far face too, and drains when the source goes`);
  }

  await lib.alone(pg, false);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-edges-world" : "PASS planet-edges-world");
};
