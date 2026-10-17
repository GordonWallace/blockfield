// A toolsmith that loses its job mid-craft gets the tool's materials back (bug-009): NODE_PATH=$(npm root -g) node test/run.js /tmp/tj test/toolsmith-job-change.js
// @ci integration suite=jobs
// Starts a craft, releases the jobsite (it becomes unemployed), and checks the iron and sticks are back in its pack, nothing more or less,
// that the craft is gone, that a save and load keeps them, and that what does not fit in a full pack drops at its feet.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(() => {
    const res = {}, I = BF.I, T = BF.trades, TS = BF.toolsmith, J = BF.jobs, inv = T.inv;
    const P = BF.player.position;
    const mk = items => {
      const m = { type: "villager", profession: "toolsmith", inv: inv.create(), trades: T.offers("toolsmith", 1), position: new THREE.Vector3(P.x, P.y, P.z), level: 1, xp: 0, ai: {} };
      for (const [n, c] of items) inv.add(m.inv, I[n], c);
      return m;
    };
    const total = m => inv.count(m.inv, I.iron_ingot) + "i " + inv.count(m.inv, I.stick) + "s";
    // a craft in progress, then the jobsite goes
    const m = mk([["iron_ingot", 3], ["stick", 2], ["shears", 1]]);
    res.before = total(m);
    const c = TS.startCraft(m, TS.plan(m));
    res.started = c ? BF.items[c.id].name : "none";
    res.during = total(m);
    m.jobsite = { x: 0, y: 0, z: 0 };
    J.release(m);
    res.profession = m.profession;
    res.after = total(m);
    res.craftLeft = m.tsm && m.tsm.craft ? "still there" : "gone";
    const saved = JSON.parse(JSON.stringify(T.pack(m)));
    const m2 = { type: "villager", profession: "unemployed" };
    T.unpack(m2, saved);
    res.afterLoad = total(m2);
    // a full pack: the materials it cannot hold drop at its feet
    const f = mk([["iron_ingot", 3], ["stick", 2], ["shears", 1]]);
    TS.startCraft(f, TS.plan(f));
    for (let i = 0; i < f.inv.length; i++) if (!f.inv[i]) f.inv[i] = { id: I.dirt, count: 64 };
    BF.drops.clear();
    J.setProfession(f, "farmer");
    const dropped = id => BF.drops.list.filter(d => d.id === id).reduce((a, d) => a + d.count, 0);
    res.fullPack = (inv.count(f.inv, I.iron_ingot) + dropped(I.iron_ingot)) + "i " + (inv.count(f.inv, I.stick) + dropped(I.stick)) + "s";
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
  const want = { during: "0i 0s", profession: "unemployed", after: "3i 2s", craftLeft: "gone", afterLoad: "3i 2s", fullPack: "3i 2s" };
  for (const [k, v] of Object.entries(want)) console.log((r[k] === v ? "ok   " : "FAIL ") + k + ": " + JSON.stringify(r[k]) + (r[k] === v ? "" : " (want " + JSON.stringify(v) + ")"));
  console.log((r.before === r.after ? "ok   " : "FAIL ") + "materials back as they were: " + r.before + " -> " + r.after);
};
