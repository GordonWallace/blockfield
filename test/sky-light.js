// @ci integration suite=world
// Sky light spreads (js/skylight.js): open sky is 15, the spot under a floating pillar is lit from the side (14), a closed room
// is dark and a doorway grades it, leaves take sunlight to 14, and the values kept up block by block match a full recompute.
// NODE_PATH=$(npm root -g) node test/run.js /tmp/sky test/sky-light.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); });
  await pg.waitForTimeout(4000);
  const fails = [];
  const check = (ok, what, info) => { console.log((ok ? "ok   " : "FAIL ") + what + (info !== undefined ? "  " + JSON.stringify(info) : "")); if (!ok) fails.push(what); };
  const r = await pg.evaluate(() => {
    const W = BF.world, S = BF.skyLight, p = BF.player.position, B = BF.B;
    for (let i = 0; i < 400 && W.queueLength > 0; i++) W.update(p.x, p.z, 40);
    const snap = () => {
      const m = new Map();
      for (const c of W.chunks.values()) m.set(c.key, c.sky.map(s => typeof s === "number" ? s : Array.from(s).join(",")).join("|"));
      return m;
    };
    const diff = (a, b) => { let n = 0; for (const [k, v] of a) if (b.get(k) !== v) n++; return n; };
    const r = { chunks: W.chunks.size };
    // loaded chunk by chunk (any order) = computed all at once
    const loaded = snap();
    r.recomputeMs = +S.recomputeAll().toFixed(1);
    r.msPerChunk = +(r.recomputeMs / W.chunks.size).toFixed(2);
    r.loadDiff = diff(loaded, snap());
    // a flat spot near the player
    const x0 = Math.floor(p.x) + 6, z0 = Math.floor(p.z) + 6, g = W.heightAt(x0, z0);
    for (let x = x0 - 6; x <= x0 + 6; x++) for (let z = z0 - 6; z <= z0 + 6; z++) {
      for (let y = g + 1; y < g + 14; y++) W.setBlock(x, y, z, 0);
      W.setBlock(x, g, z, B.stone);
    }
    r.open = S.get(x0, g + 1, z0);
    // a floating pillar 3 blocks up: the ground under it is lit from the side
    for (let y = g + 4; y < g + 10; y++) W.setBlock(x0, y, z0, B.stone);
    r.underPillar = [S.get(x0, g + 1, z0), S.get(x0, g + 3, z0)];
    for (let y = g + 4; y < g + 10; y++) W.setBlock(x0, y, z0, 0);
    r.pillarGone = S.get(x0, g + 1, z0);
    // a leaf over open ground
    W.setBlock(x0, g + 5, z0, B.oak_leaves);
    r.underLeaf = [S.get(x0, g + 4, z0), S.get(x0, g + 1, z0)];
    W.setBlock(x0, g + 5, z0, 0);
    // a closed 5x5 room (inside 3x3, 3 high), then a doorway
    const rx = x0 - 4, rz = z0 - 4;
    for (let x = rx; x < rx + 5; x++) for (let z = rz; z < rz + 5; z++) for (let y = g + 1; y <= g + 4; y++) {
      const wall = x === rx || x === rx + 4 || z === rz || z === rz + 4 || y === g + 4;
      W.setBlock(x, y, z, wall ? B.stone : 0);
    }
    r.closed = S.get(rx + 2, g + 1, rz + 2);
    W.setBlock(rx + 2, g + 1, rz, 0); W.setBlock(rx + 2, g + 2, rz, 0);   // doorway on the north wall
    r.door = [S.get(rx + 2, g + 1, rz - 1), S.get(rx + 2, g + 1, rz), S.get(rx + 2, g + 1, rz + 1), S.get(rx + 2, g + 1, rz + 3)];
    // kept up block by block = recomputed from scratch
    const inc = snap(); S.recomputeAll(); r.editDiff = diff(inc, snap());
    W.setBlock(rx + 2, g + 1, rz, B.stone); W.setBlock(rx + 2, g + 2, rz, B.stone);
    r.closedAgain = S.get(rx + 2, g + 1, rz + 2);
    const inc2 = snap(); S.recomputeAll(); r.editDiff2 = diff(inc2, snap());
    // across a chunk border: a roof over the border shades both sides
    const bx = Math.floor(p.x / 16) * 16 + 16, bz = Math.floor(p.z) - 10, bg = Math.max(W.heightAt(bx - 1, bz), W.heightAt(bx, bz));
    for (let x = bx - 3; x < bx + 3; x++) for (let z = bz - 3; z < bz + 3; z++) W.setBlock(x, bg + 4, z, B.stone);
    r.borderRoof = [S.get(bx - 1, bg + 3, bz - 1), S.get(bx, bg + 3, bz - 1)];
    const inc3 = snap(); S.recomputeAll(); r.editDiff3 = diff(inc3, snap());
    return r;
  });
  console.log(JSON.stringify(r));
  check(r.loadDiff === 0, "sky light loaded chunk by chunk matches a full recompute", r.loadDiff);
  check(r.open === 15, "open ground is 15", r.open);
  check(r.underPillar[0] === 14 && r.underPillar[1] === 14, "under a floating pillar the ground is lit from the side (14)", r.underPillar);
  check(r.pillarGone === 15, "removing the pillar brings back full sky", r.pillarGone);
  check(r.underLeaf[0] === 14 && r.underLeaf[1] === 14, "a single leaf over open ground leaves 14 under it", r.underLeaf);
  check(r.closed === 0, "a closed room is dark", r.closed);
  check(r.door[0] === 15 && r.door[1] === 14 && r.door[2] === 13 && r.door[3] === 11, "a doorway lights the room in steps of 1", r.door);
  check(r.closedAgain === 0, "closing the doorway darkens the room again", r.closedAgain);
  check(r.editDiff === 0 && r.editDiff2 === 0 && r.editDiff3 === 0, "after edits, kept-up values match a full recompute", [r.editDiff, r.editDiff2, r.editDiff3]);
  check(r.borderRoof[0] < 15 && r.borderRoof[1] < 15, "a roof across a chunk border shades both sides", r.borderRoof);
  check(r.msPerChunk < 4, "computing a chunk's sky light takes under 4 ms", r.msPerChunk);
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
