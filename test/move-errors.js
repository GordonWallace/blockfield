// @ci integration suite=village hosts=worker,server
// Move errors (r15-70): node test/run.js /tmp/me test/move-errors.js [--host page|worker|server]
// On a test floor 12 blocks above the ground at the edge of the village:
// 1. A villager pottering about a small room with an open doorway walks only to spots it can reach in a straight line: in 60 s it walks
//    into the walls for under 1 s in all (it used to walk into them every few seconds: 3.7 s) and the game log has no stuck ERROR for it.
// 2. A pen of fences with its gate open: a golem's route (three blocks high) never goes through the gate, as it can't open one and could be
//    shut in; a villager's route does.
// 3. A stonecutter in a trench beside a bank whose path is a block higher: no route climbs from the stonecutter's top onto the path (1.4
//    blocks up, more than a jump), one does from a full block; a villager standing on the stonecutter stands in the cell above it.
module.exports = async (pg, out) => {
  const lib = require('./lib');
  await pg.evaluate(() => BF.player.start());
  await lib.toVillage(pg);
  const A = await lib.sim(pg, () => {
    const m = BF.mobs.list.find(v => v.type === "villager" && !v.child && v.village && !v.dead), V = m && m.village;
    return V ? { X0: Math.floor(V.x) + 14, Z0: Math.floor(V.z) - 12 } : null;   // (within 40 blocks: the villager wanders here, not heading home)
  });
  if (A) await pg.evaluate(A => BF.player.position.set(A.X0 + 12, BF.player.position.y, A.Z0 + 12), A);
  for (let i = 0; A && i < 90; i++) {
    if (await lib.sim(pg, A => [[-2, -2], [-2, 26], [26, -2], [26, 26]].every(([x, z]) => BF.world.isLoaded(A.X0 + x, A.Z0 + z)), A)) break;
    await pg.waitForTimeout(1000);
  }
  const r = await lib.sim(pg, A => {
    if (!A) return { error: "no village" };
    const W = BF.world, M = BF.mobs, B = BF.B, P = BF.player.position, { X0, Z0 } = A, N = 24;
    let top = 0;
    for (let x = -2; x < N + 2; x += 2) for (let z = -2; z < N + 2; z += 2) top = Math.max(top, W.heightAt(X0 + x, Z0 + z));
    const Y0 = top + 12;
    if (!W.isLoaded(X0 - 2, Z0 - 2) || !W.isLoaded(X0 + N + 2, Z0 + N + 2)) return { error: "test floor not loaded" };
    for (let x = -2; x < N + 2; x++) for (let z = -2; z < N + 2; z++) for (let y = Y0 - 1; y < Y0 + 6; y++) W.setBlock(X0 + x, y, Z0 + z, y === Y0 - 1 ? B.stone : 0);
    const res = {};
    // 1. a room, 4 by 3 inside (x 1..4, z 1..3), walls 3 high with a bed and a lectern, a roof, and a doorway on the east side
    for (let x = 0; x <= 5; x++) for (let z = 0; z <= 4; z++) for (let y = Y0; y <= Y0 + 3; y++) {
      const wall = x === 0 || x === 5 || z === 0 || z === 4 || y === Y0 + 3;
      if (wall && !(x === 5 && z === 2 && y < Y0 + 2)) W.setBlock(X0 + x, y, Z0 + z, B.planks);
    }
    W.setBlock(X0 + 1, Y0, Z0 + 1, B.lectern != null ? B.lectern : B.crafting_table);
    // a villager whose day has no errands of its own to steer it (a toolsmith's or a builder's walks are their own: not what this measures),
    // living near the centre (one whose house is far out keeps to it, and from this floor it would try to walk back to it)
    const ok = v => v.type === "villager" && !v.child && v.village && !v.dead && !(v.home && v.home.x != null && Math.hypot(v.home.x - v.village.x, v.home.z - v.village.z) > 25);
    const m = ["nitwit", "librarian", "cleric", "mason", "fisherman", "armorer", "weaponsmith"].map(p => M.list.find(v => ok(v) && v.profession === p)).find(v => v) || M.list.find(ok);
    if (!m) return { error: "no villager" };
    m.position.set(X0 + 2.5, Y0, Z0 + 2.5); m.vel.set(0, 0, 0); m.ai.route = null; m.ai.mode = "idle"; m.ai.t = 0; m.ai.held = null; m.ai.detour = null;
    const mb = W.moveBox, by = {}; let push = 0;
    // walking into a block (a hit while it means to move, sliding along a wall too)
    W.moveBox = function (pos, vel, hw, h, dt) {
      const x0 = pos.x, z0 = pos.z, v = Math.hypot(vel.x, vel.z), o = mb.apply(this, arguments);
      if (pos === m.position && (o.hitX || o.hitZ) && v > 0.1) { push += dt; const k = m.ai.mode + (m.ai.route ? "/" + m.ai.routeKind : "") + (m.ai.detour ? "/detour" : ""); by[k] = +((by[k] || 0) + dt).toFixed(2); }
      return o;
    };
    const old = new Set(BF.glog ? BF.glog.recent(400) : []);
    const mine = () => (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !old.has(e) && e.p && e.p[0] >= X0 - 2 && e.p[0] <= X0 + N && e.p[2] >= Z0 - 2 && e.p[2] <= Z0 + N).map(e => e.l + " " + e.x);
    let T = 0;
    try {
      while (T < 60) { BF.sky.setTime(0.1); M.update(0.05); BF.world.tickSim(); P.set(X0 + 12, Y0 + 1, Z0 + 20); T += 0.05; }
    } finally { W.moveBox = mb; }
    res.room = { push: +push.toFixed(2), by, who: m.profession, log: mine(), at: [m.position.x - X0, m.position.z - Z0].map(v => +v.toFixed(1)) };
    m.position.set(X0 + 12.5, Y0, Z0 + 20.5); m.vel.set(0, 0, 0);
    // 2. a pen, fences round x 8..12, z 1..5, its gate (west side, z 3) open
    for (let x = 8; x <= 12; x++) for (let z = 1; z <= 5; z++) if (x === 8 || x === 12 || z === 1 || z === 5) W.setBlock(X0 + x, Y0, Z0 + z, B.oak_fence);
    W.setBlock(X0 + 8, Y0, Z0 + 3, BF.gateId("z", true));
    const outGoal = { x: X0 + 5, z: Z0 + 9, at: (x, y, z) => x === X0 + 5 && z === Z0 + 9 };
    const tallR = M.findPath(X0 + 10, Y0, Z0 + 3, outGoal, 3000, true), lowR = M.findPath(X0 + 10, Y0, Z0 + 3, outGoal, 3000, false);
    res.pen = { tall: tallR ? tallR.length : null, villager: lowR ? lowR.length : null, viaGate: !!(lowR && lowR.some(c => c[0] === X0 + 8 && c[2] === Z0 + 3)) };
    // 3. a trench: a bank 2 high (x 15, dirt with a path on top) beside a stonecutter (x 16), a wall beyond (x 17)
    for (let z = 10; z <= 16; z++) {
      W.setBlock(X0 + 15, Y0, Z0 + z, B.dirt); W.setBlock(X0 + 15, Y0 + 1, Z0 + z, B.dirt_path);
      for (let y = Y0; y <= Y0 + 3; y++) W.setBlock(X0 + 17, y, Z0 + z, B.planks);
    }
    W.setBlock(X0 + 16, Y0, Z0 + 13, B.stonecutter);
    const bank = { x: X0 + 15, z: Z0 + 13, at: (x, y, z) => x === X0 + 15 && y === Y0 + 2 };
    const fromCutter = M.findPath(X0 + 16, Y0 + 1, Z0 + 13, bank, 500);
    W.setBlock(X0 + 16, Y0, Z0 + 13, B.stone);
    const fromStone = M.findPath(X0 + 16, Y0 + 1, Z0 + 13, bank, 500);
    W.setBlock(X0 + 16, Y0, Z0 + 13, B.stonecutter);
    m.position.set(X0 + 16.5, Y0 + 9 / 16, Z0 + 13.5); m.vel.set(0, 0, 0);
    res.trench = { fromCutter: fromCutter ? fromCutter.length : null, fromStone: fromStone ? fromStone.length : null, feetY: M.nav.feetCell(m)[1] - Y0 };
    m.position.set(X0 + 12.5, Y0, Z0 + 20.5);
    return res;
  }, A);
  console.log(JSON.stringify(r));
  let bad = 0;
  const fail = s => { console.log("FAIL " + s); bad++; };
  if (r.error) fail(r.error);
  else {
    if (r.room.push >= 1) fail("the villager walked into the room's walls for " + r.room.push + " s in 60 s");
    if (r.room.log.some(t => /^ERROR/.test(t))) fail("stuck ERROR for the villager in the room: " + r.room.log.join(" | "));
    if (r.pen.tall != null) fail("a golem's route went out of the pen (through the open gate)");
    if (r.pen.villager == null || !r.pen.viaGate) fail("a villager's route did not go out through the open gate");
    if (r.trench.fromCutter != null) fail("a route climbed from the stonecutter onto the bank, 1.4 blocks up");
    if (r.trench.fromStone == null) fail("no route up the bank from a full block");
    if (r.trench.feetY !== 1) fail("a villager on the stonecutter is not in the cell above it (" + r.trench.feetY + ")");
  }
  console.log(bad ? "move-errors: " + bad + " failed" : "move-errors: ok");
  if (bad) process.exitCode = 1;
};
