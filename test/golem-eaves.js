// @ci integration suite=village
// Golems at a house wall (bug-062): node test/run.js /tmp/ge test/golem-eaves.js
// On a test floor high above the village: a closed hut (walls four blocks high, a roof one block wider than its walls all round, like
// the eaves golems were seen stuck under) with a zombie shut inside. Four golems stand outside. They used to press against the wall
// under the eaves and jump at it for as long as the zombie lived. Now a golem jumps only at a one-block step, finds no way in, logs that
// it leaves the zombie for now (INFO) and goes back to its patrol, away from the wall. Then the golems are sent to patrol round the hut:
// every patrol spot they pick is open ground they fit on, never inside the hut or under its roof.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const A = await pg.evaluate(() => {
    const m = BF.mobs.list.find(v => v.type === "villager" && !v.child && v.village && !v.dead), V = m && m.village;
    if (!V) return null;
    const X0 = Math.floor(V.x) + 60, Z0 = Math.floor(V.z) - 12;
    BF.player.position.set(X0 + 15, BF.player.position.y, Z0 + 15);
    return { X0, Z0 };
  });
  for (let i = 0; A && i < 90; i++) {
    if (await pg.evaluate(A => [[-2, -2], [-2, 32], [32, -2], [32, 32], [15, 15]].every(([x, z]) => BF.world.isLoaded(A.X0 + x, A.Z0 + z)), A)) break;
    await pg.waitForTimeout(1000);
  }
  const r = await pg.evaluate(A => {
    const W = BF.world, M = BF.mobs, P = BF.player.position;
    if (!A || !W.isLoaded(A.X0 - 2, A.Z0 - 2) || !W.isLoaded(A.X0 + 32, A.Z0 + 32)) return { error: "test floor not loaded" };
    const { X0, Z0 } = A, Y0 = W.heightAt(X0 + 15, Z0 + 15) + 20, N = 30, stone = BF.B.stone, wall = BF.B.planks, roof = BF.B.spruce_planks;
    for (let x = -2; x < N + 2; x++) for (let z = -2; z < N + 2; z++) for (let y = Y0 - 1; y < Y0 + 8; y++) {
      const edge = x < 0 || z < 0 || x >= N || z >= N;
      W.setBlock(X0 + x, y, Z0 + z, y === Y0 - 1 || (edge && y < Y0 + 4) ? stone : 0);
    }
    // the hut: walls x 12..18, z 12..18, four high; its roof at Y0 + 4, one block wider all round (just over a golem's jump)
    for (let x = 11; x <= 19; x++) for (let z = 11; z <= 19; z++) {
      W.setBlock(X0 + x, Y0 + 4, Z0 + z, roof);
      if (x >= 12 && x <= 18 && z >= 12 && z <= 18 && (x === 12 || x === 18 || z === 12 || z === 18)) for (let y = 0; y < 4; y++) W.setBlock(X0 + x, Y0 + y, Z0 + z, wall);
    }
    const zb = M.spawn("zombie", X0 + 15.5, Y0, Z0 + 15.5);
    const g0 = M.list.find(v => v.type === "iron_golem" && v.village && !v.dead), V = g0 ? g0.village : null;
    const gs = [];
    for (let i = 0; i < 4; i++) { const g = M.spawn("iron_golem", X0 + 8.5, Y0, Z0 + 13.5 + i); if (g) { g.village = V; gs.push(g); } }
    if (!zb || gs.length < 4) return { error: "spawn failed" };
    const old = new Set(BF.glog ? BF.glog.recent(400) : []);
    const logged = () => (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !old.has(e) && /golem/i.test(e.x)).map(e => e.l + " " + e.x);
    const near = g => g.position.x > X0 + 9.5 && g.position.x < X0 + 21.5 && g.position.z > Z0 + 9.5 && g.position.z < Z0 + 21.5;   // at the hut's walls, under its eaves
    let T = 0, jumps = 0, nearT = 0, lateNear = 0;
    const pv = gs.map(() => 0);
    const step = () => {
      BF.sky.setTime(0.1); zb.position.set(X0 + 15.5, Y0, Z0 + 15.5); zb.vel.set(0, 0, 0); zb.fire = 0;
      M.update(0.05); P.set(X0 + 15, Y0 + 12, Z0 + 15); T += 0.05;
      gs.forEach((g, i) => {
        if (g.vel.y > 7 && pv[i] <= 0.5) jumps++;
        pv[i] = g.vel.y;
        if (near(g)) { nearT += 0.05; if (T > 30) lateNear += 0.05; }
        if (g.position.x < X0 + 1 || g.position.x > X0 + N - 1 || g.position.z < Z0 + 1 || g.position.z > Z0 + N - 1) g.position.set(X0 + 4.5, Y0, Z0 + 4.5);   // the floor is all the world they have
      });
    };
    while (T < 60) step();
    // patrol round the hut: every target a golem picks must be open ground it fits
    let bad = 0, picks = 0;
    for (const g of gs) { g.patrol = [X0 + 15.5, Z0 + 15.5]; g.ai.giveUp = zb; g.ai.giveUpT = 999; }
    for (let k = 0; k < 400; k++) {
      step();
      for (const g of gs) if (g.ai.mode === "walk") {
        picks++;
        const x = Math.floor(g.ai.tx) - X0, z = Math.floor(g.ai.tz) - Z0;
        if (x >= 11 && x <= 19 && z >= 11 && z <= 19) bad++;
      }
    }
    return { jumps, nearT: +nearT.toFixed(1), lateNear: +lateNear.toFixed(1), log: logged().slice(0, 6), zombie: !zb.dead, bad, picks };
  }, A);
  console.log(JSON.stringify(r));
  let fails = 0;
  const fail = s => { console.log("FAIL " + s); fails++; };
  if (r.error) fail(r.error);
  else {
    if (r.jumps > 8) fail("golems jumped " + r.jumps + " times at the hut");
    if (r.lateNear > 20) fail("golems were still at the hut's walls for " + r.lateNear + " golem-seconds after the first 30 s");
    if (!r.log.some(t => /^INFO .*found no way to the zombie/.test(t))) fail("no INFO line saying a golem left the zombie");
    if (r.bad) fail(r.bad + " of " + r.picks + " patrol picks were inside or under the hut");
  }
  console.log(fails ? "golem-eaves: " + fails + " failures" : "golem-eaves: ok");
};
