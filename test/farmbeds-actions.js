// Farm bed checks: node test/run.js /tmp/fb test/farmbeds-actions.js
// Builds a bed by hand next to the player, checks it is detected with its channel, the ways it can grow, and that a project survives a save round trip.
module.exports = async (pg) => {
  const r = await pg.evaluate(() => {
    const out = [], ok = (name, c) => out.push((c ? "PASS " : "FAIL ") + name);
    const B = BF.B, W = BF.world, VL = BF.villageLife, T = VL._test;
    const px = Math.floor(BF.player.position.x) + 6, pz = Math.floor(BF.player.position.z) + 6, y = W.heightAt(px, pz);
    // a 9x7 bed like the village farm: interior 7x5, channel on the middle x line
    for (let x = px; x < px + 9; x++) for (let z = pz; z < pz + 7; z++) {
      for (let yy = y + 1; yy < y + 4; yy++) W.setBlock(x, yy, z, 0);
      const ring = x === px || x === px + 8 || z === pz || z === pz + 6;
      W.setBlock(x, y, z, ring ? B.oak_log : x === px + 4 ? B.water : B.farmland);
    }
    const D = { cells: [] };
    for (let x = px + 1; x < px + 8; x++) for (let z = pz + 1; z < pz + 6; z++) if (W.getBlock(x, y, z) === B.farmland) D.cells.push([x, y, z]);
    T.detectBeds(D);
    const b = D.beds[0];
    ok("bed detected", D.beds.length === 1 && b.x0 === px + 1 && b.x1 === px + 7 && b.z0 === pz + 1 && b.z1 === pz + 5);
    ok("channel found", b && b.ax === "x" && b.ch.length === 1 && b.ch[0] === px + 4);
    const g = T.growOptions(b);
    const along = g.filter(o => o.dir === "along"), across = g.filter(o => o.dir === "across");
    ok("grows along by 2", along.length === 2 && along.every(o => o.L.z1 - o.L.z0 === 6));
    ok("grows across into a big farm (channels 4 apart)", across.length === 2 && across.every(o => o.L.x1 - o.L.x0 === 10 && o.L.ch.length === 2 && Math.abs(o.L.ch[1] - o.L.ch[0]) === 4));
    const L = across[0].L;
    ok("old edge becomes a channel", T.layoutAt(L, L.ax === "x" && L.ch[1] < L.ch[0] ? px : px + 8, pz + 3) === "water");
    ok("corner stays log", T.layoutAt(L, L.x0 - 1, L.z0 - 1) === "log");
    // a stray farmland cell outside the ring is not a bed
    W.setBlock(px - 2, y, pz + 3, B.farmland);
    D.cells.push([px - 2, y, pz + 3]);
    T.detectBeds(D);
    ok("stray farmland is no bed", D.beds.length === 1);
    // save round trip of a project
    const R = { key: "fbtest", wg: {} }, Dv = VL.vdata(R);
    Dv.projects.push({ id: "p1", kind: "grow", dir: "along", L: along[0].L, old: [b.x0, b.z0, b.x1, b.z1], owner: 3, fails: 2, started: true });
    const saved = {};
    VL.exportAll(saved);
    ok("project exported", Array.isArray(saved["farmbeds:fbtest"]) && saved["farmbeds:fbtest"].length === 1);
    VL.importAll(saved);
    const R2 = { key: "fbtest", wg: {} }, D2 = VL.vdata(R2);
    ok("project restored", D2.projects.length === 1 && D2.projects[0].L.z1 === along[0].L.z1 && D2.projects[0].started && D2.projects[0].fails === 0);
    return out;
  });
  console.log(r.join("\n"));
};
