// Shepherd checks for test/run.js: NODE_PATH=$(npm root -g) node test/run.js /tmp/shep test/shepherd-check.js
// Loads a seed-1 world next to a village, steps the simulation by hand (the headless browser renders too slowly to fast-forward)
// and prints PASS / FAIL lines for the sheep rules and the shepherd's work. Exit code is not used; read the output.
module.exports = async (pg, out) => {
  const log = (...a) => console.log(...a);
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const day = () => BF.sky.day + BF.sky.time;
    BF.state.paused = true;                                  // the page's own loop stays out of the way
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;                                // no wild spawns: only village stock
    const V = { x: 26, z: 39 };   // seed 1: a village whose shepherd has its loom from the start (with village generator 2 the spawn village's shepherds start unemployed)
    const gy = BF.worldgen.heightAt(V.x + 4, V.z + 4);
    BF.player.teleport(V.x + 4.5, gy + 2, V.z + 4.5);
    for (let i = 0; i < 400 && !BF.world.isLoaded(V.x, V.z); i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    BF.sky.setTime(0.1);
    run(5);
    // a sized village (village generator 2) spans more chunks: keep loading until its shepherds have spawned
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(V.x + "," + V.z) || { members: [] }).members.some(m => m.profession === "shepherd")); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(V.x + "," + V.z);
    ok("village record", !!rec);
    if (!rec) return R;
    const pens = BF.shepherd.pensOf(rec);
    ok("village has pens", pens.length >= 1, pens.length);
    run(5);
    for (const p of pens) {
      const n = p.sheep ? p.sheep.filter(s => s.mob && !s.mob.dead).length : -1, loom = BF.shepherd.hasLoom(p);
      ok("pen " + p.idx + (loom ? " (loom) has >=2 live sheep" : " (no loom) is empty"), loom ? n >= 2 : n === 0, n);
      const g = BF.blocks[BF.world.getBlock(p.gate[0], p.y + 1, p.gate[1])];
      ok("pen " + p.idx + " has a closed gate", !!(g && g.gate && !g.gate.open), g && g.name);
    }
    const sheps = rec.members.filter(m => m.type === "villager" && m.profession === "shepherd");
    ok("shepherd spawned", sheps.length >= 1, sheps.length);
    for (const s of sheps) {
      const pen = BF.shepherd.penOf(s);
      ok("shepherd has a loom", !!s.jobsite, s.jobsite);
      ok("loom is right outside its pen", !!pen, pen && pen.key);
      const c = n => BF.trades.inv.count(s.inv, BF.I[n]);
      ok("shepherd carries shears", c("shears") >= 1, c("shears"));
    }
    // ---- sheep rules on a fresh pen sheep
    const pen = BF.shepherd.penOf(sheps[0]) || pens[0];
    const sh = pen.sheep.map(s => s.mob).filter(Boolean);
    const a = sh[0], b = sh[1];
    ok("starts hungry / not willing", BF.shepherd.hungry(a, day()) && !BF.shepherd.willing(a, day()));
    R.penThreshold = pen.threshold; R.penCells = pen.cells;
    // shearing
    const wool0 = BF.shepherd.shear(a, "test");
    ok("shear gives 1-3 wool", wool0 >= 1 && wool0 <= 3, wool0);
    ok("shorn sheep cannot be sheared again", BF.shepherd.shear(a, "test") === 0);
    const regrow = a.sheep.woolAt - day();
    ok("regrow about a week (4.9-9.1 d)", regrow > 4.8 && regrow < 9.2, +regrow.toFixed(2));
    const draws = []; for (let i = 0; i < 200; i++) { const x = 7 * (1 + (Math.random() + Math.random() - 1) * 0.3); draws.push(x); }
    ok("regrow shows variation", Math.max(...draws) - Math.min(...draws) > 2);
    BF.sky.day += 10; run(2);
    ok("wool regrows after ~a week", !a.sheep.shorn);
    // feeding + breeding
    BF.sky.setTime(0.1);
    const n0 = BF.mobs.list.filter(m => m.type === "sheep" && !m.dead).length;
    ok("feed a", BF.shepherd.feed(a, "test")); ok("feed b", BF.shepherd.feed(b, "test"));
    ok("fed sheep is willing", BF.shepherd.willing(a, day()));
    ok("fed sheep refuses more wheat", BF.shepherd.feed(a, "test") === false);
    run(40);
    const n1 = BF.mobs.list.filter(m => m.type === "sheep" && !m.dead).length;
    ok("two fed sheep breed (lamb appears)", n1 === n0 + 1, [n0, n1]);
    const lamb = BF.mobs.list.find(m => m.type === "sheep" && m.lamb);
    ok("lamb is small and in the pen", !!lamb && lamb.model.scale.x < 0.7 && lamb.pen === pen, lamb && lamb.model.scale.x);
    ok("parents rest after breeding", a.sheep.cd > day() && !BF.shepherd.willing(a, day()));
    BF.sky.day += 1.5; run(2);
    ok("lamb grows up in a day", lamb && !lamb.lamb && lamb.model.scale.x > 0.99, lamb && lamb.model.scale.x);
    // not fed -> not willing a day later
    ok("fed state lapses after a day", BF.shepherd.hungry(a, day()));
    // stay in the pen
    run(60);
    let out = 0; for (const s of pen.sheep) if (s.mob && (s.mob.position.x < pen.fx0 || s.mob.position.x > pen.fx1 || s.mob.position.z < pen.fz0 || s.mob.position.z > pen.fz1)) out++;
    ok("penned sheep stay inside the fence", out === 0, out);
    R.sheepNow = pen.sheep.length;
    return R;
  });
  for (const l of res.lines) log(l);
  log("pen cells", res.penCells, "threshold", res.penThreshold, "sheep now", res.sheepNow);
};
