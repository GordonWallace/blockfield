// @ci baseline suite=world timeout=300 hosts=worker,server
// Trees on the planet (generator 4, spec r14-11), in the game: for each kind of tree (and ice spikes and giant mushrooms) one place found
// with BF.planetgen.treesIn, the player sent there, and the loaded world has that tree's trunk where treesIn says. Then one tree right
// at a face edge: its crown reaches past the edge, where the next face's chunk draws it (tools/planet-trees.js checks it block for block).
// node test/run.js /tmp/pf test/planet-forests.js [--host page|worker|server] (the trees are the page's copy of the world: it generates its
// own chunks, spec r15-38)
module.exports = async (pg) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; return ok; };
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  await require('./lib').newWorld(pg, 1337, { gen: 4 });
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); });
  await pg.waitForTimeout(2500);
  // trunk block of each kind (at the tree's base y)
  const KINDS = { oak_nest: "oak_log", birch_nest: "birch_log", spruce: "spruce_log", mega_spruce: "spruce_log", jungle: "jungle_log", acacia: "acacia_log",
    dark_oak: "dark_oak_log", cherry: "cherry_log", mangrove: "mangrove_log", giant_mushroom: "mushroom_stem", ice_spike: "packed_ice" };
  const found = await pg.evaluate((kinds) => {
    const P = BF.planet, N = P.N, PG = BF.planetgen, out = {};
    let s = 7;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let k = 0; k < 4000 && Object.keys(out).length < Object.keys(kinds).length; k++) {
      const f = (rnd() * 6) | 0, cu = (rnd() * (N / 4 - 16)) | 0, cv = (rnd() * (N / 4 - 16)) | 0;
      const a = P.atlas(f, cu * 4 + 32, cv * 4 + 32);
      if (BF.worldgen.heightAt(a.x, a.z) <= BF.SEA + 1 && BF.worldgen.biomeAt(a.x, a.z).id !== 11) continue;
      for (const t of PG.treesIn(f, cu, cv, cu + 16, cv + 16)) if (kinds[t.kind] && !out[t.kind]) out[t.kind] = { f, x: t.x, y: t.y, z: t.z };
    }
    return out;
  }, KINDS);
  for (const kind of Object.keys(KINDS)) {
    const t = found[kind];
    if (!check(!!t, `found a ${kind} with treesIn`)) continue;
    const r = await pg.evaluate(async ([t, want]) => {
      const W = BF.world;
      BF.player.spawn(t.x + 3.5, t.y + 30, t.z + 3.5); BF.player.setFlying(true);
      for (let i = 0; i < 80 && !(W.chunkAt(t.x, t.z) && W.chunkAt(t.x, t.z).mesh !== undefined); i++) await new Promise(r => setTimeout(r, 250));
      const id = W.getBlock(t.x, t.y, t.z), name = (BF.blocks[id] || {}).name;
      return { name, ok: name === want };
    }, [t, KINDS[kind]]);
    check(r.ok, `${kind} at ${t.x},${t.y},${t.z} (face ${t.f}): the world has its trunk there (${r.name})`);
  }
  // a tree in a cell at one of face 4's edges: its crown reaches past the edge (drawn there by the next face's chunk)
  const edge = await pg.evaluate(async () => {
    const P = BF.planet, N = P.N, PG = BF.planetgen, W = BF.world;
    for (const s of [0, 1, 2, 3]) for (let cv = 4; cv < N / 4 - 4; cv += 97) {
      const cu0 = s === 0 ? 0 : s === 1 ? N / 4 - 1 : cv, cv0 = s === 2 ? 0 : s === 3 ? N / 4 - 1 : cv;
      const ts = PG.treesIn(4, cu0, cv0, cu0 + 1, cv0 + 1).filter(t => /oak|birch|spruce|jungle|acacia|cherry/.test(t.kind));
      if (!ts.length) continue;
      const t = ts[0], h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      BF.player.spawn(t.x + 0.5 - h[0] * 6, t.y + 25, t.z + 0.5 - h[1] * 6); BF.player.setFlying(true);
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (W.chunkAt(t.x, t.z) && W.chunkAt(t.x + h[0] * 8, t.z + h[1] * 8)) break;
      }
      // the crown's blocks just past the edge, read in face 4's frame (margin) and at their canonical cells
      let leaves = 0;
      for (let y = t.y; y < t.y + 14; y++) for (let k = 1; k <= 3; k++) for (let j = -3; j <= 3; j++) {
        const mx = t.x + (h[0] ? h[0] * k + (s === 0 ? -(t.x - P.atlas(4, 0, 0).x) : (P.atlas(4, N - 1, 0).x - t.x)) : j);
        const mz = t.z + (h[1] ? h[1] * k + (s === 2 ? -(t.z - P.atlas(4, 0, 0).z) : (P.atlas(4, 0, N - 1).z - t.z)) : j);
        const id = W.getBlock(mx, y, mz), nm = (BF.blocks[id] || {}).name || "";
        if (/_leaves$|_log$/.test(nm)) leaves++;
      }
      if (leaves) return { s, x: t.x, z: t.z, kind: t.kind, leaves };
    }
    return null;
  });
  check(!!edge && edge.leaves > 0, `a ${edge && edge.kind} at a face edge reaches across it: ${edge ? edge.leaves : 0} crown blocks past the edge ${JSON.stringify(edge)}`);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-forests" : "PASS planet-forests");
};
