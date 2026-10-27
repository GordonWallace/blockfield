// @ci integration suite=village
// Villagers and wells (bug-061): node test/run.js /tmp/wp test/well-pit.js
// The plaza well's water lies a block below its rim, too far down to climb out of from swimming: a villager that fell in stayed in for good.
// 1. A villager put in the well's water swims to a bank it can jump from (not under the bell) and climbs out, with an ERROR and an INFO
//    line in the game log.
// 2. Four villagers on the rim run from the player standing on the far side: none goes over the edge into the water.
// 3. A builder at work on its own site (here one round the well) is in its dig on purpose: no ERROR, and it isn't pulled out of it.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const P = BF.player.position, W = BF.world, V = BF.worldgen.villagesNear(P.x, P.z, 300).sort((a, b) => BF.planet.distance(P, a) - BF.planet.distance(P, b))[0];   // the village the player was taken to
    if (!(BF.RENDER[W.getBlock(V.x, V.y, V.z)] === 3)) return { error: "no well water at the plaza" };
    const inWell = m => { const x = Math.floor(m.position.x), z = Math.floor(m.position.z); return x >= V.x && x <= V.x + 1 && z >= V.z && z <= V.z + 1 && m.position.y < V.y + 1.5; };
    const vs = BF.mobs.list.filter(v => v.type === "villager" && !v.child && !v.dead).slice(0, 5);
    if (vs.length < 5) return { error: "not enough villagers" };
    const old = new Set(BF.glog ? BF.glog.recent(400) : []);
    let T = 0;
    const step = () => { BF.sky.setTime(0.2); BF.mobs.update(0.05); T += 0.05; };
    const m = vs[0];
    m.position.set(V.x + 0.5, V.y + 0.5, V.z + 0.5); m.vel.set(0, 0, 0); m.ai.mode = "idle"; m.ai.t = 0; m.ai.route = null;
    let outAt = null;
    while (T < 40 && outAt == null) { P.set(V.x + 12, V.y + 30, V.z + 12); step(); if (!m.inWater && m.onGround && m.position.y >= V.y + 1.9) outAt = +T.toFixed(1); }
    for (let k = 0; k < 20; k++) { P.set(V.x + 12, V.y + 30, V.z + 12); step(); }
    const log = (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !old.has(e)).map(e => e.l + " " + e.x);
    const ms = vs.slice(1);
    ms.forEach((v, i) => { v.position.set(V.x - 0.5, V.y + 2, V.z + 0.2 + i * 0.4); v.vel.set(0, 0, 0); v.ai.route = null; });
    const fell = new Set(), t0 = T;
    while (T < t0 + 10) {
      P.set(V.x - 5, V.y + 2, V.z + 1);
      for (const v of ms) v.ai.fleeT = Math.max(v.ai.fleeT || 0, 1);
      step();
      ms.forEach((v, i) => { if (inWell(v)) fell.add(i); });
    }
    // 3: a builder whose site takes in the well, its own job put off so it keeps that site for the test
    const b = BF.mobs.list.find(v => v.type === "villager" && v.profession === "builder" && !v.dead && !vs.includes(v));
    let site = null;
    if (b) {
      const hooks = [];
      for (const k of Object.keys(BF)) {
        const o = BF[k];
        if (o && typeof o === "object" && typeof o.ai === "function" && o !== BF.mobs) { const f = o.ai; hooks.push([o, f]); o.ai = function (x) { return x === b ? false : f.apply(this, arguments); }; }
      }
      const bs0 = b.bs, seen = new Set(BF.glog ? BF.glog.recent(400) : []), t1 = T;
      const fake = { mode: "build", entry: { type: "well", ox: V.x - 1, oy: V.y, oz: V.z - 1, w: 3, d: 3 } };
      b.position.set(V.x + 0.5, V.y + 0.5, V.z + 0.5); b.vel.set(0, 0, 0); b.ai.mode = "idle"; b.ai.t = 0; b.ai.route = null; b.ai.pitOut = null; b.ai.pitLogged = false;
      let pulled = false;
      try {
        while (T < t1 + 4) { b.bs = fake; P.set(V.x + 12, V.y + 30, V.z + 12); step(); if (b.ai.pitOut) pulled = true; }
      } finally { b.bs = bs0; for (const [o, f] of hooks) o.ai = f; }
      const name = BF.vlog ? BF.vlog.nameOf(b) : "";
      site = { pulled, errors: (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !seen.has(e) && e.l === "ERROR" && (!name || (e.x || "").includes(name))).map(e => e.x) };
    }
    return { outAt, log: log.filter(t => /well|climbed/.test(t)), fell: [...fell], site };
  });
  console.log(JSON.stringify(r));
  let fails = 0;
  const fail = s => { console.log("FAIL " + s); fails++; };
  if (r.error) fail(r.error);
  else {
    if (r.outAt == null) fail("the villager never climbed out of the well");
    if (!r.log.some(t => /^ERROR .*fell into a well/.test(t))) fail("no ERROR line for the fall");
    if (!r.log.some(t => /^INFO .*climbed out/.test(t))) fail("no INFO line for the climb out");
    if (r.fell.length) fail(r.fell.length + " fleeing villagers went over the rim into the well");
    if (!r.site) fail("no builder in the village for the site check");
    else {
      if (r.site.errors.length) fail("a builder in its own dig was logged: " + r.site.errors.join(" | "));
      if (r.site.pulled) fail("a builder in its own dig was steered out of it");
    }
  }
  console.log(fails ? "well-pit: " + fails + " failures" : "well-pit: ok");
};
