// @ci baseline suite=village timeout=300
// Villages on the planet (spec r14-12), in the game: on a generator-4 world (seed 1337), the nearest village to spawn and a village near a
// face edge (found by walking face 4's edges, as tools/planet-villages.js does) are each visited. Both have their well (water at the
// plaza), the beds of their houses, their jobsite blocks where jobs.planVillage puts them, and a roster of their population with
// villagers spawned. From the point by the edge, villagesNear finds villages on both faces.
// node test/run.js /tmp/pv test/planet-village-visit.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); });
  await pg.waitForTimeout(2000);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const picks = await pg.evaluate(() => {
    const P = BF.planet, N = P.N, W = BF.worldgen, p = BF.player.position;
    const near = W.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b));
    const home = near[0];
    let edge = null;
    search: for (let s = 0; s < 4; s++) for (let k = 2; k < 60; k++) {
      const along = Math.round(N * k / 62), h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? 300 : N - 300) : along, v = h[1] ? (h[1] < 0 ? 300 : N - 300) : along;
      const a = P.atlas(4, u, v), vs = W.villagesNear(a.x, a.z, 1200), faces = [...new Set(vs.map(q => P.face(q.x, q.z)))];
      if (faces.length >= 2) {
        const dEdge = q => { const g = P.grid(q.x, q.z); return Math.min(g.u, g.v, N - g.u, N - g.v); };
        const q = vs.sort((x, y) => dEdge(x) - dEdge(y))[0];   // the village nearest the edge
        edge = { a, faces, n: vs.length, x: q.x, z: q.z, f: P.face(q.x, q.z), dEdge: Math.round(dEdge(q)) };
        break search;
      }
    }
    const pick = v => v && { x: v.x, y: v.y, z: v.z, pop: v.pop, name: v.name, biome: v.biome, nb: v.buildings.length };
    return { home: pick(home), homeD: home && Math.round(P.distance(p, home)), edge };
  });
  check(!!picks.home, `a village within 6 km of spawn: ${JSON.stringify(picks.home)} at ${picks.homeD} blocks`);
  check(!!picks.edge && picks.edge.faces.length >= 2, `villagesNear from a point by an edge of face 4 finds villages on faces ${picks.edge && picks.edge.faces.join(", ")}`);
  const targets = [["nearest to spawn", picks.home]];
  if (picks.edge) targets.push([`near the edge (face ${picks.edge.f}, ${picks.edge.dEdge} blocks from it)`, picks.edge]);
  for (const [what, t] of targets) {
    if (!t) continue;
    await pg.evaluate(t => { const W = BF.worldgen, v = W.villageAt(t.x, t.z); BF.player.spawn(t.x + 0.5, v.y + 3, t.z + 0.5); }, t);
    let r = null;
    for (let i = 0; i < 40; i++) {   // until the village's chunks are generated and its villagers are out
      await pg.waitForTimeout(1000);
      r = await pg.evaluate(t => {
        const W = BF.worldgen, Wd = BF.world, B = BF.B, v = W.villageAt(t.x, t.z);
        if (!v) return { none: true };
        const loaded = Wd.chunkAt(v.minX, v.minZ) && Wd.chunkAt(v.maxX, v.maxZ) && Wd.chunkAt(v.minX, v.maxZ) && Wd.chunkAt(v.maxX, v.minZ);
        let water = 0;
        for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let dy = -4; dy <= 1; dy++) if (Wd.getBlock(v.x + dx, v.y + dy, v.z + dz) === B.water) water++;
        let beds = 0, bedsOk = 0;
        for (const h of v.houses) for (const b of h.beds || []) { beds++; const id = Wd.getBlock(b.x, b.y, b.z), d = BF.blocks[id]; if (d && /bed/.test(d.name || "")) bedsOk++; }
        let jobs = 0, jobsOk = 0;
        for (const j of BF.jobs.planVillage(v)) { jobs++; if (Wd.getBlock(j.x, j.y, j.z) === j.id) jobsOk++; }
        const key = Math.round(v.x) + "," + Math.round(v.z), rec = BF.mobs.villages.get(key);
        const live = rec ? BF.mobs.list.filter(m => m.type === "villager" && m.village === rec && !m.dead).length : 0;
        return { loaded: !!loaded, water, beds, bedsOk, jobs, jobsOk, roster: rec ? rec.roster.length : 0, pop: v.pop, live, key, face: BF.planet.face(v.x, v.z) };
      }, t);
      if (r.none || (r.loaded && r.live > 0 && r.bedsOk === r.beds && r.jobsOk === r.jobs)) break;
    }
    console.log(what, JSON.stringify(r));
    check(r && !r.none, `${what}: villageAt finds the village`);
    if (!r || r.none) continue;
    check(r.loaded, `${what}: its chunks loaded`);
    check(r.water > 0, `${what}: the well holds water at the plaza`);
    check(r.beds > 0 && r.bedsOk === r.beds, `${what}: all ${r.beds} house beds are in place (${r.bedsOk})`);
    check(r.jobs > 0 && r.jobsOk === r.jobs, `${what}: all ${r.jobs} jobsite blocks are in place (${r.jobsOk})`);
    check(r.roster === r.pop, `${what}: the roster holds the village's ${r.pop} villagers (${r.roster})`);
    check(r.live > 0, `${what}: villagers are out (${r.live})`);
    if (out) await pg.screenshot({ path: out + "-" + (what.startsWith("near the edge") ? "edge" : "home") + ".png" });
  }
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? `FAIL planet-village-visit (${bad})` : "PASS planet-village-visit");
};
