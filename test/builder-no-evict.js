// @ci integration suite=jobs
// A builder never takes a bed another villager holds: a villager asleep in a borrowed bed keeps it (and stays in the world) when a builder
// claims that house; a builder takes a bed nobody holds as its own (bug-027).
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/bne test/builder-no-evict.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const M = BF.mobs, Bd = BF.builder, r = {};
    M.spawning = false; for (let i = 0; i < 100; i++) { BF.sky.setTime(0.2); M.update(0.05); }
    const vs = M.list.filter(m => m.type === "villager" && !m.dead && !m.child && m.village);
    const A = vs.find(m => m.profession === "builder"), O = A && vs.find(m => m !== A && m.village === A.village);
    if (!A || !O) return { err: "no builder and neighbour" };
    // a small house whose first bed is the bed O borrowed and is asleep in
    const e = { type: "small_house", rot: 0, style: A.village.style || "oak", h: 0.5, state: "done", ox: 0, oy: 0, oz: 0 };
    const b0 = Bd.bpOf(e).beds[0];
    e.ox = Math.floor(O.position.x) - b0.x; e.oy = Math.floor(O.position.y) - b0.y; e.oz = Math.floor(O.position.z) - b0.z;
    const bed = { x: e.ox + b0.x, y: e.oy + b0.y, z: e.oz + b0.z, f: b0.f, claimed: true };
    O.bed = bed; O.sleeping = true; A.bed = null;
    r.claimed = Bd.claimHome(A, e);
    r.Obed = !!O.bed && O.bed.x === bed.x && O.bed.z === bed.z; r.Abed = A.bed ? [A.bed.x, A.bed.y, A.bed.z] : null;
    for (let i = 0; i < 40; i++) { BF.sky.setTime(0.9); M.update(0.05); }
    r.Oalive = M.list.includes(O) && !O.removed;
    // a bed nobody holds: the builder takes it as its own
    const e2 = Object.assign({}, e, { ox: e.ox + 40, _bp: null });
    r.claimed2 = Bd.claimHome(A, e2);
    r.A2 = A.bed ? { own: !A.bed.claimed, x: A.bed.x } : null; r.e2claim = e2.claim === A.slot.idx;
    return r;
  });
  console.log(JSON.stringify(r));
  const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
  if (r.err) return ok("setup: " + r.err, false);
  ok("the builder does not take the sleeper's bed", !r.Abed && r.claimed === false);
  ok("the sleeper keeps its bed", r.Obed);
  ok("the sleeper is still in the world", r.Oalive);
  ok("the builder takes a bed nobody holds as its own", r.claimed2 === true && r.A2 && r.A2.own && r.e2claim);
};
