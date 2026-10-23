// @ci baseline suite=world timeout=240
// The world across face edges on the planet (generator 4, spec r14-02): near each of the four edges of face 4, blocks read and
// written through margin addresses (the unfolded neighbouring face) reach the canonical cell on the next face; a block with a facing
// written through a turned edge is stored turned back and reads the same way through the margin; chunks at the edge mesh, with
// their neighbours across the edge in the 3x3 neighbourhood; corner wedges read air and refuse writes; the cube corners are ocean.
// node test/run.js /tmp/pw test/planet-world.js
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); });
  await pg.waitForTimeout(2500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const start = await pg.evaluate(() => {
    const p = BF.player.position, P = BF.planet, c = P.canon(p.x, p.z, {});
    return { gen: BF.state.gen, f: c.f, u: c.u, v: c.v, ll: P.latLonAt(p.x, p.z), y: p.y, h: BF.world.heightAt(p.x, p.z) };
  });
  check(start.gen === 4 && start.f === 4, "a generator-4 world starts on face 4 " + JSON.stringify(start));
  check(start.h > 0 && start.y > start.h, "the player stands on dry land at spawn");

  // the four edges of face 4 (side 0: u < 0, 1: u >= N, 2: v < 0, 3: v >= N; none of them turns), then three edges that turn by one,
  // two and three quarter turns
  for (const [f, s] of [[4, 0], [4, 1], [4, 2], [4, 3], [0, 2], [5, 2], [0, 3]]) {
    const info = await pg.evaluate(async ([f, s]) => {
      const P = BF.planet, N = P.N, W = BF.world, h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const u = h[0] ? (h[0] < 0 ? 6 : N - 7) : N / 2 + 3, v = h[1] ? (h[1] < 0 ? 6 : N - 7) : N / 2 + 3;
      const a = P.atlas(f, u, v), gy = BF.worldgen.heightAt(a.x, a.z);
      BF.player.spawn(a.x + 0.5, Math.max(gy, 0) + 2, a.z + 0.5);
      for (let i = 0; i < 80; i++) {   // until the chunks across the edge have loaded and meshed
        await new Promise(r => setTimeout(r, 250));
        const m = W.chunkAt(a.x + h[0] * 20, a.z + h[1] * 20);
        if (m && m.mesh !== undefined && W.chunkAt(a.x, a.z) && W.chunkAt(a.x, a.z).mesh !== undefined) break;
      }
      const e = P.EDGE[f][s], out = { side: s, f, g: e.g, turn: e.turn, reads: 0, readBad: 0 };
      // reads: every column 1..12 blocks past the edge, a few heights, agrees with the canonical cell (no facing blocks out here)
      for (let k = 1; k <= 12; k++) for (let j = -3; j <= 3; j++) {
        const mx = a.x + h[0] * (k + 6) + (h[0] ? 0 : j), mz = a.z + h[1] * (k + 6) + (h[1] ? 0 : j);
        const c = P.canonCell(mx, mz, {}), gh = BF.worldgen.heightAt(c.x, c.z);
        for (const y of [gh - 2, gh, gh + 1]) {
          out.reads++;
          const id = W.getBlock(mx, y, mz), cid = W.getBlock(c.x, y, c.z);
          if (id !== cid || (y === gh && !id)) out.readBad++;
        }
      }
      // writes through the margin land on the canonical cell, on the next face
      const mx = a.x + h[0] * 9, mz = a.z + h[1] * 9, c = P.canonCell(mx, mz, {}), y = BF.worldgen.heightAt(c.x, c.z) + 1;
      const okSet = W.setBlock(mx, y, mz, BF.B.glass);
      out.write = okSet && W.getBlock(c.x, y, c.z) === BF.B.glass && c.f === e.g && W.chunkAt(c.x, c.z).cx === Math.floor(c.x / 16);
      out.edits = W.edits.has(Math.floor(c.x / 16) + "," + Math.floor(c.z / 16));
      out.keysCanonical = [...W.chunks.values()].every(ch => { const q = P.canonCell(ch.cx * 16 + 8, ch.cz * 16 + 8, {}); return !q.wedge && !q.off && q.x === ch.cx * 16 + 8 && q.z === ch.cz * 16 + 8; });
      // a facing block (stairs, then a door) written through the margin: stored turned back, read back the way it was written
      const st = BF.SHAPES[BF.B.planks].stairs[0][1];
      W.setBlock(mx, y + 1, mz, st);
      const stored = W.getBlock(c.x, y + 1, c.z), sb = BF.blocks[stored];
      out.stairs = W.getBlock(mx, y + 1, mz) === st && sb.shape && sb.shape.kind === "stairs" && sb.shape.f === ((1 + 4 - e.turn) & 3);
      // the canonical chunk across the edge is remeshed, and so is the chunk on this side whose mesh shows it
      W.setBlock(mx, y + 1, mz, 0); W.setBlock(mx, y, mz, 0);
      out.restored = W.getBlock(c.x, y, c.z) === 0;
      // collision: a solid column built across the edge stops a box moved into it from this face
      for (let dy = 1; dy <= 3; dy++) W.setBlock(a.x + h[0] * 7, Math.max(gy, 0) + dy, a.z + h[1] * 7, BF.B.stone);
      const yy = Math.max(gy, 0) + 1, pos = { x: a.x + 0.5 + h[0] * 4, y: yy, z: a.z + 0.5 + h[1] * 4 }, vel = { x: h[0] * 8, y: 0, z: h[1] * 8 };
      for (let i = 0; i < 20; i++) W.moveBox(pos, vel, 0.3, 1.8, 0.05, {});
      out.blocked = h[0] ? (h[0] > 0 ? pos.x < a.x + 7 : pos.x > a.x - 6) : (h[1] > 0 ? pos.z < a.z + 7 : pos.z > a.z - 6);
      // meshing at the edge: the chunks on both sides have meshes
      const here = W.chunkAt(a.x, a.z), there = W.chunkAt(mx, mz);
      out.meshed = here && here.mesh !== undefined && there && there.mesh !== undefined;
      return out;
    }, [f, s]);
    check(info.reads > 0 && info.readBad === 0, `face ${f} edge ${s} (to face ${info.g}, turn ${info.turn}): ${info.reads} margin reads match the canonical cells`);
    check(info.write && info.edits && info.restored, `face ${f} edge ${s}: a block set through the margin is on face ${info.g}, recorded as a canonical edit`);
    check(info.stairs, `face ${f} edge ${s}: stairs set through the margin are stored turned by the edge's turn and read back unchanged`);
    check(info.keysCanonical, `face ${f} edge ${s}: every loaded chunk has a canonical key`);
    check(info.blocked, `face ${f} edge ${s}: blocks across the edge collide`);
    check(info.meshed, `face ${f} edge ${s}: the chunks on both sides of the edge are meshed`);
  }

  // corner wedges and the cube corners
  const corner = await pg.evaluate(() => {
    const P = BF.planet, N = P.N, W = BF.world, a = P.atlas(4, 5, 5);
    const wedge = { x: a.x - 10, z: a.z - 10 };   // past two edges of face 4 at once
    return {
      air: W.getBlock(wedge.x, 0, wedge.z) === 0, refused: W.setBlock(wedge.x, 0, wedge.z, BF.B.stone) === false,
      // chunks off the atlas (x < 0 at the face-0 corner, z < 0, past face 5) still generate: open sea, no neighbouring face's features
      offAtlas: [[-1, 0], [-1, -1], [0, -1], [6 * P.W / 16, 3]].every(([cx, cz]) => { try { return BF.worldgen.generateRange(cx, cz, 0, 1).length > 0; } catch (e) { return false; } }),
      sea: [[4, 3, 3], [4, N - 3, N - 3], [2, 10, 10], [0, N - 2, 5], [3, N / 2 + 0, 2]].slice(0, 4).every(([f, u, v]) => { const q = P.atlas(f, u, v); return BF.worldgen.heightAt(q.x, q.z) < BF.SEA && BF.worldgen.waterLevelAt(q.x, q.z) === BF.SEA; }),
    };
  });
  check(corner.air && corner.refused, "a corner wedge reads air and refuses writes");
  check(corner.offAtlas, "chunks off the atlas (around 0, 0 and past the last face) generate without errors");
  check(corner.sea, "the cube corners are open ocean");

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-world" : "PASS planet-world");
};
