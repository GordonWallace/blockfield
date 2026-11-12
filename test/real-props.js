// @ci baseline suite=world
// The realistic look's props (js/real/props.js, docs/REALISTIC_CONTRACT.md section 4): blocks that are one full block to the game
// but not cube shaped in the world. With the look off the module is not there. With it on a pumpkin and a beehive set on the ground
// leave the cube pass (the mesher lists each as a flora record of kind 6), are drawn as instanced models standing on the ground,
// hide no face of a cube beside them, leave the ground under them drawn, and go when the block goes. The game is unchanged: the
// block is still there, solid and a full block.
// node test/run.js /tmp/rp test/real-props.js
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what, got) => { if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); };
  const errors = [];
  pg.on("pageerror", e => errors.push(e.message));
  pg.on("console", m => { if (m.type() === "error" && /BF\.real|shader|program/i.test(m.text())) errors.push(m.text()); });
  check(await pg.evaluate(() => !(BF.real && BF.real.on) && !(BF.real && BF.real.props)), "look off by default: no props module");

  await pg.evaluate(() => localStorage.setItem("bf.look", "real"));
  await pg.reload();
  await pg.waitForFunction(() => window.BF && BF.real && BF.real.on && BF.real.props && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30 && !BF.preparing, null, { timeout: 240000 });
  await pg.waitForTimeout(3000);
  await pg.evaluate(() => BF.player.start());

  // every model builds, at both levels, with finite points inside its block (a little over at the sides: a roof's eaves)
  const models = await pg.evaluate(() => {
    const P = BF.real.props, bad = [], n = [];
    for (const e of BF.real.assets.props) for (let v = 0; v < e.variants; v++) for (const d of [0, 1]) {
      const g = P.geometry(BF.B[e.block], v, d), p = g.attributes.position.array;
      let ok = g.index.count > 0 && g.attributes.normal.count === p.length / 3 && g.attributes.color.count === p.length / 3 && g.attributes.uv.count === p.length / 3;
      for (let i = 0; i < p.length; i += 3) if (!(Math.abs(p[i]) <= 0.56 && p[i + 1] >= -0.001 && p[i + 1] <= 1.02 && Math.abs(p[i + 2]) <= 0.56)) ok = false;
      if (!ok) bad.push(e.block + ":" + v + ":" + d);
      n.push(g.index.count / 3);
    }
    return { names: P.models(), bad, most: Math.max(...n), coarse: Math.max(...n.filter((_, i) => i % 2)) };
  });
  check(models.names.includes("pumpkin") && models.names.includes("beehive"), "pumpkins and beehives are props", models.names);
  check(models.bad.length === 0, "every model builds inside its block at both levels", models);
  check(models.coarse < 700 && models.most < 4000, "the models are light", { most: models.most, coarse: models.coarse });

  // open, level natural ground away from the chunk's border
  const spot = await pg.evaluate(() => {
    const W = BF.world, t = BF.real.meshTables(), B = BF.B;
    for (const c of W.chunks.values()) {
      if (!c.mesh) continue;
      for (let lz = 4; lz < 11; lz++) for (let lx = 4; lx < 9; lx++) {
        const x = c.cx * 16 + lx, z = c.cz * 16 + lz, y = W.heightAt(x, z);
        let ok = true;
        for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 4 && ok; dx++) {
          if (W.heightAt(x + dx, z + dz) !== y || !t.NATB[W.getBlock(x + dx, y, z + dz)]) ok = false;
          for (let k = 1; k < 4 && ok; k++) if (BF.OPAQUE[W.getBlock(x + dx, y + k, z + dz)]) ok = false;
        }
        if (ok) {
          for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 4; dx++) for (let k = 1; k < 3; k++) if (W.getBlock(x + dx, y + k, z + dz)) W.setBlock(x + dx, y + k, z + dz, 0);
          return { x, y: y + 1, z, cx: c.cx, cz: c.cz };
        }
      }
    }
    return null;
  });
  check(!!spot, "open level ground to work on", spot);
  if (!spot) return;
  await pg.evaluate(s => { BF.player.teleport(s.x + 1.5, s.y + 0.1, s.z + 5.5); BF.player.setLook(0, -0.25); }, spot);
  await pg.waitForTimeout(1500);

  // what the mesher makes of the chunk: its cube vertices, its ground triangles, its prop records
  const MESH = s => {
    const W = BF.world, c = W.chunkC(s.cx, s.cz), r = W.meshArrays(c), F = r.F || [], props = [];
    for (let o = 0; o < F.length; o += 8) if (F[o + 3] === 6) props.push([F[o], F[o + 1], F[o + 2], F[o + 4], F[o + 7] & 15]);
    // (this chunk's only: other chunks keep streaming in while the test runs, with pumpkins of their own)
    let drawn = 0, placed = 0;
    for (const m of BF.scene.children) if (m.isInstancedMesh && m.userData.prop && m.visible && m.position.x === s.cx * 16 && m.position.z === s.cz * 16) drawn += m.count;
    for (const k of BF.real.props._test.chunks.values()) if (k.ox === s.cx * 16 && k.oz === s.cz * 16) placed += k.recs.length / 8;
    return { cubes: r.S.pos.length / 3, ground: r.T ? r.T.ind.length / 3 : 0, props, drawn, placed, st: BF.real.props.stats() };
  };
  const plank = await pg.evaluate(s => { BF.world.setBlock(s.x + 2, s.y, s.z, BF.B.planks); return 1; }, spot);
  await pg.waitForTimeout(1200);
  const a = await pg.evaluate(MESH, spot);
  check(a.props.length === 0 && plank === 1, "before: no prop records in the chunk", { cubes: a.cubes, ground: a.ground });

  await pg.evaluate(s => { const W = BF.world, B = BF.B; W.setBlock(s.x, s.y, s.z, B.pumpkin); W.setBlock(s.x + 1, s.y, s.z, B.pumpkin); W.setBlock(s.x - 1, s.y, s.z + 1, B.beehive); }, spot);
  const placedIn = s => { let n = 0; for (const k of BF.real.props._test.chunks.values()) if (k.ox === s.cx * 16 && k.oz === s.cz * 16) n += k.recs.length / 8; return n; };
  await pg.waitForFunction("(" + placedIn + ")(" + JSON.stringify(spot) + ") === 3", null, { timeout: 30000, polling: 100 }).catch(() => {});
  await pg.waitForTimeout(800);
  const b = await pg.evaluate(MESH, spot);
  const lx = spot.x - spot.cx * 16, lz = spot.z - spot.cz * 16;
  check(b.props.length === 3 && b.props.every(p => p[1] === spot.y), "the mesher lists the three as prop records at their blocks", b.props);
  check(b.props.some(p => p[0] === lx + 0.5 && p[2] === lz + 0.5) && b.props.every(p => p[4] >= 12), "at the middle of their cells, lit by the open sky", b.props);
  check(b.cubes === a.cubes, "they add no cube faces and hide none of the planks beside them", { before: a.cubes, after: b.cubes });
  check(b.ground === a.ground, "the ground under them is still drawn", { before: a.ground, after: b.ground });
  check(b.placed === 3 && b.drawn === 3, "they are drawn as models", { placed: b.placed, drawn: b.drawn, st: b.st });
  const game = await pg.evaluate(s => {
    const W = BF.world, B = BF.B, id = W.getBlock(s.x, s.y, s.z);
    return { pumpkin: id === B.pumpkin, hive: W.getBlock(s.x - 1, s.y, s.z + 1) === B.beehive, solid: BF.SOLID[id] === 1, opaque: BF.OPAQUE[id] === 1 };
  }, spot);
  check(game.pumpkin && game.hive && game.solid && game.opaque, "the game still has the blocks, solid and full", game);
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: out + "-props.png" });

  await pg.evaluate(s => { BF.world.setBlock(s.x, s.y, s.z, 0); BF.world.setBlock(s.x - 1, s.y, s.z + 1, 0); }, spot);
  await pg.waitForFunction("(" + placedIn + ")(" + JSON.stringify(spot) + ") === 1", null, { timeout: 30000, polling: 100 }).catch(() => {});
  const c = await pg.evaluate(MESH, spot);
  check(c.props.length === 1 && c.placed === 1 && c.drawn === 1, "a prop goes when its block goes", { props: c.props.length, placed: c.placed, drawn: c.drawn });
  check(errors.length === 0, "no page or shader errors", errors.slice(0, 3));
  if (fails) console.log("FAIL real-props: " + fails + " check(s) failed");
};
