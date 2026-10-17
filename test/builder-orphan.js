// A builder that leaves the trade mid-structure must not block the village: another builder takes the structure over (bug-006).
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/bo test/builder-orphan.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const M = BF.mobs, Bd = BF.builder, r = {};
    M.spawning = false; for (let i = 0; i < 200; i++) { BF.sky.setTime(0.2); M.update(0.05); }
    const vs = M.list.filter(m => m.type === "villager" && !m.dead && !m.child);
    let A = vs.find(m => m.profession === "builder");
    if (!A) return { err: "no builder" };
    const R = A.village, built = Bd.builtOf(R), out = { x: 0, z: 0 };
    const act = built.find(e => e.state === "building");
    if (act) { const o = vs.find(m => m.slot && m.slot.idx === act.owner && m.profession === "builder"); if (o) A = o; }
    for (let k = 0; k < 400 && !built.some(e => e.state === "building"); k++) { BF.sky.setTime(0.2); Bd.ai(A, 0.5, out); if (A.bs) { A.bs.cool = 0; if (A.bs.mode === "idle") A.bs.t = 0; } }
    const e = built.find(e => e.state === "building");
    if (!e) return { err: "no structure started" };
    for (let k = 0; k < 30; k++) { BF.sky.setTime(0.2); Bd.ai(A, 0.5, out); }
    r.Aslot = A.slot.idx; r.ownerBefore = e.owner;
    // the builder loses its drafting table: unemployed
    BF.jobs.release(A);
    r.Anow = A.profession;
    // another villager becomes the only builder
    const C = vs.find(m => m !== A && m.profession !== "builder" && m.profession !== "explorer");
    for (const o of vs) if (o !== A && o !== C && o.profession === "builder") BF.jobs.setProfession(o, "nitwit");
    BF.jobs.setProfession(C, "builder"); C.inv = Bd.startStock(C); C.bs = null; C.xp = 0;
    const progBefore = e.prog, modes = new Set();
    for (let k = 0; k < 600; k++) { BF.sky.setTime(0.2); Bd.ai(C, 0.5, out); if (C.bs) { C.bs.cool = 0; modes.add(C.bs.mode); } }
    Object.assign(r, { Cslot: C.slot.idx, ownerAfter: e.owner, progBefore, progAfter: e.prog, state: e.state, modes: [...modes], status: Bd.statusText(C) });
    // the old owner, hired as a builder again, does not build on the structure it lost
    BF.jobs.setProfession(A, "builder"); A.bs = { mode: "build", entry: e, t: 0, cool: 0, stage: null, fail: {}, avoid: {}, placeT: 0.6, want: null, losT: 0, losFor: -1 };
    Bd.ai(A, 0.5, out);
    r.Aafter = { mode: A.bs.mode, owner: e.owner };
    return r;
  });
  console.log(JSON.stringify(r));
  const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
  if (r.err) return ok("setup: " + r.err, false);
  ok("old builder left the trade (" + r.Anow + ")", r.Anow !== "builder");
  ok("new builder took the structure over", r.ownerAfter === r.Cslot);
  ok("building carried on (" + r.progBefore + " -> " + r.progAfter + ", " + r.state + ")", r.progAfter > r.progBefore || r.state === "done");
  ok("old owner rehired does not build on it", r.Aafter.mode !== "build" && r.Aafter.owner === r.Cslot);
};
