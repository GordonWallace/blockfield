// @ci integration suite=village
// Signposts on the planet (generator 4, spec r14-17): a village beside a face edge lists a village on the next face, with the planet
// distance rounded to 10 and an arrow that points the way to it in the village's own grid (stepping that way gets closer by as much).
// Villages keep well clear of face edges (r14-12), so two on different faces are rarely within the signposts' 800 blocks: the listing is
// checked with a 1,200-block range, and the real signposts of the same villages list only neighbours within 800.
// node test/run.js /tmp/pw test/planet-signposts.js
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); });
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };

  const r = await pg.evaluate(() => {
    const P = BF.planet, G = BF.worldgen, S = BF.signs, N = P.N, out = { pairs: [] }, RANGE = 1200;
    // villages within 800 blocks of each other on two faces: walk a few edges, looking at villages near points just inside them
    const edges = [[4, 1], [0, 2], [0, 3], [4, 0], [1, 2], [5, 3]];
    for (const [f, s] of edges) {
      const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      for (let t = 0.05; t < 0.95 && out.pairs.length < 3; t += 0.004) {
        const o = (h[0] || h[1]) < 0 ? 0 : N - 1, a = h[0] ? P.atlas(f, o, N * t) : P.atlas(f, N * t, o);
        for (const v of G.villagesNear(a.x, a.z, 700)) {
          if (P.canon(v.x, v.z).f !== f) continue;
          const near = G.villagesNear(v.x, v.z, RANGE).filter(b => !(b.x === v.x && b.z === v.z)).sort((p, q) => P.distance(v, p) - P.distance(v, q)).slice(0, 4);
          const other = near.find(b => P.canon(b.x, b.z).f !== f);   // among the 4 nearest, as a signpost lists
          if (other && !out.pairs.some(p => p.v === v)) { out.pairs.push({ v, b: other }); break; }
        }
      }
      if (out.pairs.length >= 3) break;
    }
    out.found = out.pairs.length;
    out.cases = out.pairs.map(({ v, b }) => {
      const list = S.postNeighbours(v, RANGE), e = list.find(o => o.name === (b.name || S.villageName(b)));
      const res = { faces: [P.canon(v.x, v.z).f, P.canon(b.x, b.z).f], listed: !!e, n: list.length };
      if (!e) return res;
      const d = P.distance(v, b), l = Math.hypot(e.dx, e.dz);
      // a step of 100 blocks the way the arrow points (in the village's frame, through the edge) gets about 100 blocks closer
      const step = { x: v.x + e.dx / l * 100, z: v.z + e.dz / l * 100 };
      Object.assign(res, { dist: e.dist, want: Math.round(d / 10) * 10, closer: +(d - P.distance(step, b)).toFixed(1),
        allNear: S.postNeighbours(v).every(o => o.d <= 800 + 1e-6), arrow: S.arrowFor(e.dx, e.dz, [0, 1]) });
      S.assignPosts(v);
      res.posts = (v.posts || []).filter(p => p.used).length;
      return res;
    });
    return out;
  });
  check(r.found >= 2, `found villages within 1,200 blocks of each other across face edges (${r.found})`);
  for (const c of r.cases) {
    const tag = `village on face ${c.faces[0]} with a neighbour on face ${c.faces[1]}`;
    check(c.listed, `${tag}: its signposts list the neighbour ${JSON.stringify(c)}`);
    if (!c.listed) continue;
    check(c.dist === c.want && c.allNear, `${tag}: distance round the planet (${c.dist}, want ${c.want}), the real signposts list only neighbours within 800`);
    check(c.closer > 97, `${tag}: the arrow (${c.arrow} on the plaza post) points the way there (a 100-block step gets ${c.closer} closer)`);
    check(c.posts >= 1, `${tag}: at least one signpost stands (${c.posts})`);
  }
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-signposts" : "PASS planet-signposts");
};
