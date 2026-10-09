// @ci integration suite=village
// Signposts to nearby villages (js/signs.js planPosts/assignPosts): every village lists the 4 nearest villages within 800 blocks on a
// plaza signpost, and each main road end lists the ones within 45 degrees of that road, arrows as the reader sees them.
// node test/run.js /tmp/sp test/signposts.js
const { toVillage } = require('./lib');
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  // arrows: the reader faces north (0,-1); a village straight ahead is up, then clockwise
  const arrows = await pg.evaluate(() => [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]].map(([dx, dz]) => BF.signs.arrowFor(dx, dz, [0, -1])).join(""));
  check(arrows === "↑↗→↘↓↙←↖", "8 arrows as seen by a reader facing north: " + arrows);
  const east = await pg.evaluate(() => BF.signs.arrowFor(0, -5, [1, 0]));
  check(east === "←", "a reader facing east sees a village to the north on the left: " + east);
  const fit = await pg.evaluate(() => BF.VILLAGE_NAMES.every(n => BF.signs.postLine({ name: n, dx: 1, dz: 0, dist: 800 }, [1, 0]).length <= 30));
  check(fit, "every village name fits a 30-character line with its distance");
  // 36 villages from the fixed test seed
  const r = await pg.evaluate(() => {
    const G = BF.worldgen, S = BF.signs, vs = G.villagesNear(0, 0, 3600).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 36);
    const errs = [];
    let posts = 0, used = 0, lines = 0;
    const inB = (x, z, b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
    for (const v of vs) {
      S.assignPosts(v);
      const near = G.villagesNear(v.x, v.z, 800).filter(o => !(o.x === v.x && o.z === v.z)).sort((a, b) => Math.hypot(a.x - v.x, a.z - v.z) - Math.hypot(b.x - v.x, b.z - v.z)).slice(0, 4);
      const want = near.map(o => o.name + " " + Math.round(Math.hypot(o.x - v.x, o.z - v.z) / 10) * 10);
      for (const p of v.posts || []) {
        posts++;
        for (const [x, , z] of p.cells) {
          if (v.roads.some(rd => inB(x, z, rd))) errs.push(v.name + ": signpost on a road");
          if (!p.plaza && v.pads.some(pd => inB(x, z, pd))) errs.push(v.name + ": signpost on a plot");
          if (v.lamps.some(l => Math.abs(l[0] - x) <= 1 && Math.abs(l[1] - z) <= 1)) errs.push(v.name + ": signpost by a lamp");
          if (v.buildings.some(b => inB(x, z, b))) errs.push(v.name + ": signpost in a building");
          if (x < v.minX || x > v.maxX || z < v.minZ || z > v.maxZ) errs.push(v.name + ": signpost outside the village box");
        }
        if (!p.plaza && p.f !== BF.dirIndex(-p.d[0], -p.d[1])) errs.push(v.name + ": road signpost doesn't face the village");
        const t = S.autos.signpost({ ak: p.ak });
        if (!p.used) { if (!p.plaza && near.some(o => (o.x - v.x) * p.d[0] + (o.z - v.z) * p.d[1] >= Math.hypot(o.x - v.x, o.z - v.z) * Math.SQRT1_2 + 1e-6)) errs.push(v.name + ": a road with a village that way has no signpost"); continue; }
        used++;
        const got = t.split("\n").map(l => l.slice(2).replace(/ +/g, " ").trim());
        lines += got.length;
        if (got.some(l => !want.includes(l))) errs.push(v.name + ": " + JSON.stringify(got) + " not in " + JSON.stringify(want));
        if (p.plaza && got.length !== want.length) errs.push(v.name + ": plaza lists " + got.length + " of " + want.length);
        if (t.split("\n").some(l => l.length > 30)) errs.push(v.name + ": a line is longer than 30");
      }
      if (want.length && !(v.posts || []).some(p => p.plaza && p.used)) errs.push(v.name + ": no plaza signpost");
    }
    return { n: vs.length, posts, used, lines, errs: errs.slice(0, 12), nerr: errs.length };
  });
  check(r.n === 36 && r.nerr === 0, `${r.n} villages: ${r.used} of ${r.posts} signpost sites used, ${r.lines} lines, names and distances match villagesNear` + (r.nerr ? " " + JSON.stringify(r.errs) : ""));
  // in game: the nearest village's signposts stand, carry their text, and breaking one is final
  await toVillage(pg);
  await pg.waitForTimeout(3000);
  const g = await pg.evaluate(() => {
    const v = BF.worldgen.nearestVillage(BF.player.position.x, BF.player.position.z), out = [];
    for (const p of (v.posts || []).filter(p => p.used)) {
      const c = p.cells[0], loaded = p.cells.every(q => BF.world.isLoaded(q[0], q[2]));
      if (!loaded) continue;
      const ok = p.cells.every(q => BF.world.getBlock(q[0], q[1], q[2]) === p.id), s = BF.signs.get(c[0], c[1], c[2]);
      out.push({ ok, text: s && s.text, want: BF.signs.autos.signpost({ ak: p.ak }), ak: p.ak, c });
    }
    return out;
  });
  check(g.length > 0 && g.every(p => p.ok && p.text === p.want), `${g.length} loaded signposts stand with their text: ` + JSON.stringify(g.map(p => p.text)));
  if (g.length) {
    const b = await pg.evaluate(p => {
      const [x, y, z] = p.c;
      BF.world.setBlock(x, y, z, 0);
      BF.signs.runAuto();
      const saved = BF.signs.serialize();
      BF.signs.deserialize(saved);
      return { seen: saved.seen.includes(p.ak), block: BF.world.getBlock(x, y, z), plan: [...BF.signs._state.autoPlan.values()].some(q => q.ak === p.ak) };
    }, g[0]);
    check(b.seen && b.block === 0 && !b.plan, "a broken signpost stays broken after a reload: " + JSON.stringify(b));
  }
  console.log(bad ? "FAIL signposts" : "PASS signposts");
};
