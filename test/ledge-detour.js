// @ci integration suite=village hosts=worker,server
// Walking home under a ledge: node test/run.js /tmp/ledge test/ledge-detour.js [--host page|worker|server]
// A villager far from its village and a golem far from its patrol walk straight home. Here a one-block step stands in the way with leaves
// just above their heads (a tree's lowest leaves), so they can neither step up nor jump it, and the only way round is along the step to
// where the leaves end. They used to jump into the leaves over and over all day; now they never jump into them and find the way round.
// Then a villager boxed in on every side: after 30 s of pushing the game log says it is stuck (ERROR), and once let out, that it got moving.
module.exports = async (pg, out) => {
  const lib = require('./lib');
  await pg.evaluate(() => BF.player.start());
  await lib.toVillage(pg);
  // the test floor: 60 blocks east of the village, 20 above the ground; the player (the page's: the simulation follows it, spec r15-43)
  // stands by it until its chunks are loaded
  const A = await lib.sim(pg, () => {
    const m = BF.mobs.list.find(v => v.type === "villager" && !v.child && v.village && !v.dead), V = m && m.village;
    if (!V) return null;
    return { X0: Math.floor(V.x) + 60, Z0: Math.floor(V.z) - 12 };
  });
  if (A) await pg.evaluate(A => BF.player.position.set(A.X0 + 25, BF.player.position.y, A.Z0 + 25), A);
  for (let i = 0; A && i < 90; i++) {
    if (await lib.sim(pg, A => [[-40, -2], [-40, 32], [32, -2], [32, 32], [15, 15]].every(([x, z]) => BF.world.isLoaded(A.X0 + x, A.Z0 + z)), A)) break;
    await pg.waitForTimeout(1000);
  }
  let bad = 0;
  for (const kind of ["villager", "iron_golem", "boxed"]) {
    const r = await lib.sim(pg, ([kind, A]) => {
      const W = BF.world, P = BF.player.position, type = kind === "boxed" ? "villager" : kind;
      const m = A && BF.mobs.list.find(v => v.type === type && !v.child && v.village && !v.dead);
      if (!m) return { kind, error: "no " + type };
      const { X0, Z0 } = A, Y0 = W.heightAt(X0 + 15, Z0 + 15) + 20, N = 30;
      if (!W.isLoaded(X0 - 40, Z0) || !W.isLoaded(X0 + 32, Z0 + 32)) return { kind, error: "test floor not loaded" };
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
      const here = e => e.p && e.p[0] >= X0 - 2 && e.p[0] <= X0 + N && e.p[2] >= Z0 - 2 && e.p[2] <= Z0 + N;   // this mob's lines, not the village's own golems'
      const logged = () => (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !old.has(e) && here(e)).map(e => e.l + " " + e.x);
      let T = 0, past = null, stuckAt = null;
      // past the step: standing on top of it (its cells are x <= 15). A route may run along its edge cells (x = 15, centre 15.5) before
      // turning west, which routes of equal cost do or don't (the heap's tie order, spec r15-05), so the edge cells count.
      const isPast = () => m.position.x < X0 + 16 && m.position.y > Y0 + 0.5;
      const step = () => { BF.sky.setTime(0.1); (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver()); P.set(X0 + 25, Y0 + 1, Z0 + 25); T += 0.05; };
      try {
        if (kind !== "boxed") {
          while (T < 60 && past == null) { step(); if (isPast()) past = +T.toFixed(1); }
        } else {
          while (T < 50 && stuckAt == null) { step(); if (logged().some(t => /^ERROR .* stuck at/.test(t))) stuckAt = +T.toFixed(1); }
          for (let z = 10; z <= 11; z++) W.setBlock(X0 + 18, Y0, Z0 + z, 0), W.setBlock(X0 + 18, Y0 + 1, Z0 + z, 0);   // let it out
          var held = m.ai.held && +m.ai.held.t.toFixed(1), mode = m.ai.mode;
          const t0 = T;
          while (T < t0 + 30 && past == null) { step(); if (isPast()) past = +T.toFixed(1); }
        }
      } finally { W.moveBox = mb; }
      return { kind, ceil, past, stuckAt, held: typeof held === 'undefined' ? null : held, mode: typeof mode === 'undefined' ? null : mode, log: logged(), at: [m.position.x - X0, m.position.y - Y0, m.position.z - Z0].map(v => +v.toFixed(1)) };
    }, [kind, A]);
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
