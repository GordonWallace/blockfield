// @ci integration suite=world,farming
// bug-060: water passes through fences and fence gates (the fence's cell stays dry, the water runs on beyond it, one level thinner), and
// the builders' troughs (sty, pasture, sheep pen) are sunk into the ground with a bank all round, so the water stays in them.
// Usage: node test/run.js /tmp/fw test/fence-water.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const W = BF.world, B = BF.B;
    const step = (s) => { for (let t = 0; t < s; t += 0.05) { BF.warp.advance(0.05); BF.state.time += 0.05; BF.sky.update(0.05); BF.world.tickSim(); } };
    const px = Math.floor(BF.player.position.x) + 6, pz = Math.floor(BF.player.position.z) + 6;
    for (let i = 0; i < 100; i++) W.update(px, pz, 8);
    // a flat stone test bed in the air, walled in 9 blocks out
    const y = Math.max(W.heightAt(px, pz), 0) + 12;
    for (let x = px - 9; x <= px + 9; x++) for (let z = pz - 9; z <= pz + 9; z++) { W.setBlock(x, y - 1, z, B.stone); for (let k = 0; k < 4; k++) W.setBlock(x, y + k, z, 0); }
    // 1. a source with a fence line beside it
    for (let z = pz - 9; z <= pz + 9; z++) W.setBlock(px + 1, y, z, B.oak_fence);
    W.setBlock(px, y, pz, B.water);
    step(6);
    const fl = id => BF.FLUID[id] || 0;
    ok("the fence stays a fence, dry", W.getBlock(px + 1, y, pz) === B.oak_fence);
    ok("water runs on beyond the fence", fl(W.getBlock(px + 2, y, pz)) > 0 && fl(W.getBlock(px + 2, y, pz)) < 8, { beyond: BF.blocks[W.getBlock(px + 2, y, pz)].name });
    ok("one level thinner than without the fence (2, not 1, next to a source)", fl(W.getBlock(px + 2, y, pz)) === 2, fl(W.getBlock(px + 2, y, pz)));
    ok("and spreads out past it", fl(W.getBlock(px + 3, y, pz)) > 0);
    // removing the source dries it up beyond the fence too
    W.setBlock(px, y, pz, 0);
    step(8);
    let wet = 0;
    for (let x = px - 9; x <= px + 9; x++) for (let z = pz - 9; z <= pz + 9; z++) if (fl(W.getBlock(x, y, z))) wet++;
    ok("with the source gone, the water drains on both sides", wet === 0, wet);
    // 2. a closed fence gate
    const gate = BF.gateId("z", false, "oak");
    W.setBlock(px + 1, y, pz, gate);
    W.setBlock(px, y, pz, B.water);
    step(6);
    ok("water passes a closed gate too", fl(W.getBlock(px + 2, y, pz)) > 0 && W.getBlock(px + 1, y, pz) === gate);
    W.setBlock(px, y, pz, 0); step(8);
    for (let x = px - 9; x <= px + 9; x++) for (let z = pz - 9; z <= pz + 9; z++) W.setBlock(x, y, z, 0);
    // 3. a fence placed in flowing water: water carries on round it, the fence is not washed out
    W.setBlock(px - 4, y, pz, B.water); step(4);
    W.setBlock(px - 3, y, pz, B.oak_fence); step(4);
    ok("a fence set in the stream stays, the water beyond it carries on", W.getBlock(px - 3, y, pz) === B.oak_fence && fl(W.getBlock(px - 2, y, pz)) > 0);
    W.setBlock(px - 4, y, pz, 0); W.setBlock(px - 3, y, pz, 0); step(8);
    // 4. the builders' troughs: water only below ground level, dug in, with a bank all round
    for (const t of ["sty", "pasture", "pen"]) {
      for (const rot of [0, 1, 2, 3]) {
        const bp = BF.blueprints.get(t, rot, 0, 0.5, null, "oak");
        const water = bp.cells.filter(c => c.id === B.water);
        const bad = water.filter(c => c.y !== -1 || !c.dig);
        const at = new Map(bp.cells.map(c => [c.x + "," + c.y + "," + c.z, c]));
        const basin = new Set((bp.marks.basin || []).map(([u, q]) => u + "," + q));
        const open = [];
        for (const c of water) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = (c.x + dx) + "," + (c.z + dz), n = at.get((c.x + dx) + ",-1," + (c.z + dz)), up = at.get((c.x + dx) + ",0," + (c.z + dz));
          if (!(n && n.id === B.water) && !basin.has(k) && !up) open.push(k);   // another trough cell, a basin column, or a column under a fence (filled to ground level)
        }
        if (rot === 0) ok(t + ": two water cells, sunk one block into the ground (dug in)", water.length === 2 && !bad.length, water.map(c => [c.x, c.y, c.z, c.dig]));
        if (open.length) ok(t + " rot " + rot + ": every side of the trough has a bank", false, open);
        ok(t + " rot " + rot + ": no plank rim", !bp.cells.some(c => c.y === 0 && /planks$/.test(BF.blocks[c.id].name) && water.some(w => Math.abs(w.x - c.x) + Math.abs(w.z - c.z) === 1)));
      }
    }
    // 5. a sty built as the builder builds it, on the test bed (sunk into stone? no: on a dirt pad), keeps its water in
    for (let x = px - 9; x <= px + 9; x++) for (let z = pz - 9; z <= pz + 9; z++) { W.setBlock(x, y - 1, z, B.grass); W.setBlock(x, y - 2, z, B.dirt); }
    const bp = BF.blueprints.get("sty", 0, 0, 0.5, null, "oak");
    const tr = BF.builder.evalTerrain(bp, px - 3, pz - 4, BF.worldgen.palette(0).found);
    ok("a sty site on flat ground", !!tr, tr);
    if (tr) {
      const e = { id: 1, type: "sty", rot: 0, style: 0, wood: "oak", h: 0.5, ox: px - 3, oy: tr.oy, oz: pz - 4, w: bp.w, d: bp.d, prog: 0, fill: tr.fill, state: "building" };
      e.n = tr.fill.length + bp.n;
      for (let i = 0; i < e.n; i++) { const c = BF.builder.cellOf(e, i); W.setBlock(c.x, c.y, c.z, c.id); }
      step(8);
      let outside = 0, trough = 0;
      for (let x = px - 9; x <= px + 9; x++) for (let z = pz - 9; z <= pz + 9; z++) for (let yy = y - 2; yy <= y + 2; yy++) {
        const id = W.getBlock(x, yy, z);
        if (id === B.water) trough++; else if (fl(id)) outside++;
      }
      ok("the built sty's trough holds its 2 sources and nothing flows out", trough === 2 && outside === 0, { trough, outside, oy: tr.oy, y });
    }
    return R;
  });
  for (const l of res.lines) console.log(l);
};
