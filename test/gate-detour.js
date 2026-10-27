// @ci integration suite=village
// Villagers walking out through a gate (bug-056): node test/run.js /tmp/gd test/gate-detour.js
// A villager in the poultry keeper's coop walks towards a point beyond its front fence. The fence stops it, it plans a detour round
// (wanderAI's A*) and the detour goes through the gate. Detours never opened doors or gates (only ai.route did), so it pressed against
// the closed gate until the detour gave up, stepped aside and tried again: a keeper seen "stuck behind his own gate". From two inner
// corners of the coop it must be out within 15 s, and the gate it opened must be shut again behind it.
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const k = BF.mobs.list.find(v => v.profession === "poultry_keeper" && !v.dead), C = k && BF.poultry.coopOf(k);
    if (!C || !C.gate || !C.out) return { error: "no coop with a gate" };
    const v = BF.mobs.list.find(v => v.type === "villager" && !v.child && !v.dead && v.profession !== "poultry_keeper" && v.profession !== "farmer");
    const W = BF.world, P = BF.player.position, gy = C.y + 1, res = [];
    const gate = () => (BF.blocks[W.getBlock(C.gate[0], gy, C.gate[1])].gate || {}).open;
    if (gate() == null) return { error: "the coop's gap holds no gate" };
    const inside = () => v.position.x > C.fx0 && v.position.x < C.fx1 && v.position.z > C.fz0 && v.position.z < C.fz1;
    // the point beyond the front fence, on the far side from the run
    const fx = C.out[0] + 0.5 + (C.out[0] - C.gate[0]) * 6, fz = C.out[1] + 0.5 + (C.out[1] - C.gate[1]) * 6;
    for (const [cx, cz] of [[C.fx0 + 1.5, C.fz1 - 1.5], [C.fx1 - 1.5, C.fz1 - 1.5]]) {
      v.position.set(cx, gy, cz); v.vel.set(0, 0, 0); v.ai.route = null; v.ai.detour = null; v.ai.doors = null;
      W.setGate(C.gate[0], gy, C.gate[1], false);
      let T = 0, outAt = null, shutAt = null;
      while (T < 30 && shutAt == null) {
        BF.sky.setTime(0.3); P.set(C.fx0 - 8, C.y + 20, C.fz0 - 8);
        if (outAt == null) { v.ai.leaving = false; v.ai.mode = "walk"; v.ai.t = 5; v.ai.tx = fx; v.ai.tz = fz; }
        v.holdT = 99;   // walks on past a villager coming to buy from it: otherwise it can stand in the gateway 8 s for one (seller-waits tests that)
        BF.mobs.update(0.05); BF.world.tickSim(); T += 0.05;
        if (outAt == null && !inside()) outAt = +T.toFixed(1);
        if (outAt != null && !gate()) shutAt = +T.toFixed(1);
      }
      res.push({ outAt, shutAt });
    }
    return { res };
  });
  console.log(JSON.stringify(r));
  let fails = 0;
  const fail = s => { console.log("FAIL " + s); fails++; };
  if (r.error) fail(r.error);
  else r.res.forEach((x, i) => {
    if (x.outAt == null || x.outAt > 15) fail("corner " + (i + 1) + ": not out of the coop within 15 s (" + x.outAt + ")");
    else if (x.shutAt == null) fail("corner " + (i + 1) + ": the gate was left open");
  });
  console.log(fails ? "gate-detour: " + fails + " failures" : "gate-detour: ok");
};
