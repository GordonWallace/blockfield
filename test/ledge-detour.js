// @ci integration suite=village
// Walking home under a ledge: node test/run.js /tmp/ledge test/ledge-detour.js
// A villager far from its village and a golem far from its patrol walk straight home. Here a one-block step stands in the way with leaves
// just above their heads (a tree's lowest leaves), so they can neither step up nor jump it, and the only way round is along the step to
// where the leaves end. They used to jump into the leaves over and over all day; now they never jump into them and find the way round.
// Then a villager boxed in on every side: after 30 s of pushing the game log says it is stuck (ERROR), and once let out, that it got moving.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  let bad = 0;
  for (const kind of ["villager", "iron_golem", "boxed"]) {
    const r = await pg.evaluate((kind) => {
      const W = BF.world, P = BF.player.position, type = kind === "boxed" ? "villager" : kind;
      const m = BF.mobs.list.find(v => v.type === type && !v.child && v.village && !v.dead);
      if (!m) return { kind, error: "no " + type };
      const V = m.village;
      const X0 = Math.floor(V.x) + 60, Z0 = Math.floor(V.z) - 12, Y0 = Math.floor(P.y) + 30, N = 30;
      const stone = BF.B.stone, leaf = BF.B.spruce_leaves != null ? BF.B.spruce_leaves : BF.B.oak_leaves;
      // a floor high above the ground, open towards the village (-x); a one-block step at x <= 15; walls on the other sides
      for (let x = -40; x < N + 2; x++) for (let z = -2; z < N + 2; z++) for (let y = Y0 - 1; y < Y0 + 8; y++) {
        const wall = x >= 0 && (z < 0 || z >= N || x >= N);
        W.setBlock(X0 + x, y, Z0 + z, y === Y0 - 1 || wall || (y === Y0 && x <= 15) ? stone : 0);
      }
      const hi = type === "iron_golem" ? 3 : 2;   // leaves just above its head along the foot of the step, for 21 blocks
      for (let x = 16; x <= 22; x++) for (let z = 0; z <= 20; z++) W.setBlock(X0 + x, Y0 + hi, Z0 + z, leaf);
      if (kind === "boxed") for (let x = 18; x <= 21; x++) for (let z = 9; z <= 12; z++) if (x === 18 || x === 21 || z === 9 || z === 12) W.setBlock(X0 + x, Y0, Z0 + z, stone), W.setBlock(X0 + x, Y0 + 1, Z0 + z, stone);
      m.position.set(X0 + 19.5, Y0, Z0 + 10.5); m.vel.set(0, 0, 0); m.ai.route = null; m.ai.mode = "idle"; m.ai.t = 0; m.ai.held = null;
      const mb = W.moveBox; let ceil = 0;
      W.moveBox = function (pos) { const res = mb.apply(this, arguments); if (pos === m.position && res.hitCeil) ceil++; return res; };
      const old = new Set(BF.glog ? BF.glog.recent(400) : []);
      const logged = () => (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !old.has(e)).map(e => e.l + " " + e.x);
      let T = 0, past = null, stuckAt = null;
      const step = () => { BF.sky.setTime(0.1); BF.mobs.update(0.05); P.set(X0 + 25, Y0 + 1, Z0 + 25); T += 0.05; };
      try {
        if (kind !== "boxed") {
          while (T < 60 && past == null) { step(); if (m.position.x < X0 + 15.5) past = +T.toFixed(1); }
        } else {
          while (T < 40 && stuckAt == null) { step(); if (logged().some(t => /^ERROR .* stuck at/.test(t))) stuckAt = +T.toFixed(1); }
          for (let z = 10; z <= 11; z++) W.setBlock(X0 + 18, Y0, Z0 + z, 0), W.setBlock(X0 + 18, Y0 + 1, Z0 + z, 0);   // let it out
          const t0 = T;
          while (T < t0 + 30 && past == null) { step(); if (m.position.x < X0 + 15.5) past = +T.toFixed(1); }
        }
      } finally { W.moveBox = mb; }
      return { kind, ceil, past, stuckAt, log: logged(), at: [m.position.x - X0, m.position.y - Y0, m.position.z - Z0].map(v => +v.toFixed(1)) };
    }, kind);
    console.log(JSON.stringify(r));
    if (r.error) { console.log("FAIL " + r.error); bad++; continue; }
    if (r.ceil > 0) { console.log("FAIL " + kind + " jumped into the leaves " + r.ceil + " times"); bad++; }
    if (r.past == null) { console.log("FAIL " + kind + " never got past the step (at " + r.at + ")"); bad++; }
    if (kind === "boxed") {
      if (r.stuckAt == null) { console.log("FAIL boxed villager: no stuck ERROR in the game log"); bad++; }
      if (!r.log.some(t => /^INFO .*got moving again/.test(t))) { console.log("FAIL boxed villager: no got-moving INFO in the game log"); bad++; }
    } else if (r.log.some(t => /^ERROR/.test(t))) { console.log("FAIL " + kind + " logged as stuck: " + r.log.join(" | ")); bad++; }
  }
  console.log(bad ? "ledge-detour: " + bad + " failures" : "ledge-detour: ok");
};
