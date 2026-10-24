// @ci integration suite=world timeout=420 hosts=worker,server
// Fixed simulation tick (spec r15-10): NODE_PATH=$(npm root -g) node test/run.js /tmp/ft test/fixed-tick.js [--host page|worker|server]
// (the ticks are run where the simulation is, spec r15-43; the drawing between them is the page's, from the protocol's mirror)
// The world simulation runs in ticks of exactly 0.05 s at every speed and frame rate, and mobs are drawn between the last two ticks:
// - at 1x for 10 real seconds the sim clock advances 10 s (± 0.1) in ticks of exactly 0.05;
// - forced 30 fps and 120 fps frames give the same world after 200 ticks (mob position checksum, from the same start, seeded random);
// - frames at 1000x never run a tick of any other size, and drop (not owe) the ticks the budget can't fit;
// - a mob is drawn between where the previous tick and the latest left it.
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

  // ---- 1x for 10 real seconds: ticks of exactly 0.05, the clock keeps real time. Headless frames can be slower than the
  // accumulator's 0.25 s cap per frame (MAX_FRAME), so the clock is compared with the real time the frames counted.
  const t0 = await lib.sim(pg, () => {
    BF.warp.reset();
    const hs = (globalThis.__ftH = []), fr = (globalThis.__ftF = []);
    const up = BF.mobs.update, plan = BF.warp.plan;
    globalThis.__ftUp = up; globalThis.__ftPlan = plan;
    BF.mobs.update = function (h) { hs.push(h); return up.apply(this, arguments); };
    BF.warp.plan = function (dt) { fr.push(dt); return plan.apply(this, arguments); };
    return { sim: BF.simNow(), real: performance.now(), dropped: BF.warp.dropped };
  });
  await pg.waitForTimeout(10000);
  const t1 = await lib.sim(pg, () => {
    BF.mobs.update = __ftUp; BF.warp.plan = __ftPlan;
    const cap = BF.warp.MAX_FRAME;
    return { sim: BF.simNow(), real: performance.now(), n: __ftH.length, bad: __ftH.filter(h => h !== BF.warp.TICK).length,
      dropped: BF.warp.dropped, frames: __ftF.length, counted: __ftF.reduce((a, d) => a + Math.min(cap, d), 0), slow: __ftF.filter(d => d > cap).length, alpha: BF.warp.alpha };
  });
  const simS = t1.sim - t0.sim, realS = (t1.real - t0.real) / 1000;
  console.log(JSON.stringify({ dropped: t1.dropped - t0.dropped, simS: +simS.toFixed(3), realS: +realS.toFixed(3), counted: +t1.counted.toFixed(3), frames: t1.frames, slowFrames: t1.slow, ticks: t1.n, badTicks: t1.bad }));
  check(t1.bad === 0 && t1.n > 0, "every mob update at 1x is one 0.05 s tick (" + t1.n + " ticks)");
  check(Math.abs(simS - t1.n * 0.05) < 1e-6, "the clock moved by exactly the ticks run");
  const lostS = (t1.dropped - t0.dropped) * 0.05;   // ticks the 40 ms frame budget couldn't fit (headless software rendering is slow)
  check(Math.abs(simS + lostS - t1.counted) <= 0.1, "at 1x the sim clock keeps the frames' real time: " + simS.toFixed(3) + " s run + " + lostS.toFixed(2) + " s dropped for " + t1.counted.toFixed(3) + " s counted (" + realS.toFixed(3) + " s real, " + t1.slow + " of " + t1.frames + " frames over the 0.25 s cap)");
  if (!t1.slow && !lostS) check(Math.abs(simS - realS) <= 0.1, "with no frame over the cap and none dropped, it keeps real time");

  // ---- the same 200 ticks at 30 fps and at 120 fps (forced frame times, each run synchronous so no real frame interleaves).
  // The world as a whole can't be put back to the same start between two runs yet (villages, wildlife, horse herds and the job modules
  // keep their own state and timers, and draw from Math.random: seeded randomness is r15-14, the world hash and replay test r15-24),
  // so this checks what the fixed tick is responsible for: (1) every frame rate makes exactly the same sequence of simulation calls,
  // all with h = 0.05; (2) mobs moved by physics alone (thrown, falling, knocked back; no AI steering) end up identical, to the bit.
  // Away from any village, on dry land.
  const spot = await lib.sim(pg, () => {
    const s0 = BF.spawnPoint || BF.player.position, s = { x: Math.floor(s0.x), z: Math.floor(s0.z) };
    for (let k = 1; k < 40; k++) for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const x = s.x + dx * k * 400, z = s.z + dz * k * 400, h = BF.worldgen.heightAt(x, z);
      if (h <= BF.SEA + 2 || BF.worldgen.villagesNear(x, z, 450).length) continue;
      return { x, z, h };
    }
    return null;
  });
  console.log("test spot " + JSON.stringify(spot));
  await pg.evaluate(s => BF.player.position.set(s.x + 0.5, s.h + 1.01, s.z + 0.5), spot);   // (the page moves its player: the simulation follows)
  await lib.sim(pg, async s => {
    const W = BF.world, near = () => Math.abs(BF.player.position.x - s.x - 0.5) < 1 && W.isLoaded(s.x + 24, s.z + 24) && W.isLoaded(s.x - 24, s.z - 24);
    for (let i = 0; i < 1200 && !near(); i++) await new Promise(r => setTimeout(r, 100));
  }, spot);
  await pg.waitForTimeout(5000);
  const det = await lib.sim(pg, () => {
    BF.state.paused = true;   // the real frame loop runs no ticks meanwhile
    const P = BF.player.position, gy = (x, z) => BF.world.heightAt(Math.floor(x), Math.floor(z)) + 1;
    const clock0 = BF.simNow(), TYPES = ["cow", "pig", "sheep", "zombie", "skeleton", "spider", "iron_golem", "horse"];
    // the calls the game loop makes into the simulation, in order, with their step
    const SYS = [[BF.sky, "advance"], [BF.mobs, "update"], [BF.drops, "update"], [BF.boats, "update"], [BF.inventory, "simTick"], [BF.world, "tickSim"], [BF.dayTimeline, "update"]].filter(([o, k]) => o && o[k]);
    let trace = null;
    const orig = SYS.map(([o, k]) => o[k]);
    SYS.forEach(([o, k], i) => { const f = orig[i]; o[k] = function (h) { if (trace) trace.push(k + ":" + h); return f.apply(this, arguments); }; });
    function calls(fps) {
      BF.warp.reset();
      trace = [];
      let ticks = 0, frames = 0;
      while (ticks < 200 && frames < 10000) { ticks += BF.simFrame(1 / fps); frames++; }
      const t = trace; trace = null;
      return { fps, ticks, frames, trace: t };
    }
    // physics only: each mob thrown up and sideways, its AI held off (knockT) for the whole run
    // run on their own: every other mob is set aside (their moves in the first run would push these differently in the second), and
    // the modules that bring mobs back on their own (wildlife, horse herds, monster spawning) are off
    function thrown(fps) {
      const others = BF.mobs.list.splice(0), WL = BF.wildlife, HO = BF.horses, sp = BF.mobs.spawning;
      BF.wildlife = undefined; BF.horses = undefined; BF.mobs.spawning = false;
      try { return thrownRun(fps); }
      finally {
        for (const m of BF.mobs.list.slice()) BF.mobs.discard(m);
        BF.mobs.list.push(...others); BF.wildlife = WL; BF.horses = HO; BF.mobs.spawning = sp;
      }
    }
    function thrownRun(fps) {
      BF.warp.advance(clock0 - BF.simNow());
      const ms = TYPES.map((t, i) => {
        const a = i / TYPES.length * Math.PI * 2, x = P.x + Math.cos(a) * 7 + 0.31, z = P.z + Math.sin(a) * 7 + 0.17;
        const m = BF.mobs.spawn(t, x, gy(x, z) + 6, z);
        m.vel.set(Math.cos(a) * 2.7, 5.5, Math.sin(a) * 2.7); m.yaw = a; return m;
      }).filter(Boolean);
      BF.warp.reset();
      let ticks = 0;
      const dt = 1 / fps;
      while (ticks < 200) { for (const m of ms) { m.knockT = 1; m.ai.fleeT = 0; m.invuln = 99; } ticks += BF.simFrame(dt); }
      const pos = ms.map(m => [m.type, m.position.x, m.position.y, m.position.z, m.vel.x, m.vel.y, m.vel.z, !!m.onGround]);
      for (const m of ms) BF.mobs.discard(m);
      return pos;
    }
    try {
      const a = calls(30), b = calls(120), c = calls(144);
      const pa = thrown(30), pb = thrown(120);
      return { a: { ...a, trace: a.trace.length }, b: { ...b, trace: b.trace.length }, c: { ...c, trace: c.trace.length },
        sameCalls: a.trace.join() === b.trace.join() && a.trace.join() === c.trace.join(), allTick: a.trace.every(x => /:0\.05$|:undefined$/.test(x)),
        first: a.trace.slice(0, SYS.length), pa, pb, samePos: JSON.stringify(pa) === JSON.stringify(pb), simEnd: BF.simNow() - clock0 };
    } finally {
      SYS.forEach(([o, k], i) => { o[k] = orig[i]; });
      BF.state.paused = false;
    }
  });
  console.log(JSON.stringify({ a: det.a, b: det.b, c: det.c, first: det.first, pa: det.pa.slice(0, 3), pb: det.pb.slice(0, 3) }));
  check(det.a.ticks === 200 && det.b.ticks === 200 && det.c.ticks === 200, "30, 120 and 144 fps all ran exactly 200 ticks (" + det.a.frames + ", " + det.b.frames + ", " + det.c.frames + " frames)");
  check(det.sameCalls && det.allTick && det.a.trace > 200, "every frame rate makes the same " + det.a.trace + " simulation calls in the same order, each with h = 0.05");
  const firstDiff = det.pa.findIndex((p, i) => JSON.stringify(p) !== JSON.stringify(det.pb[i]));
  check(det.pa.length === 8 && det.samePos && det.pa.some(p => p[7]), "thrown mobs end up exactly where they were at the other frame rate after 200 ticks (" + det.pa.length + " mobs, " +
    det.pa.filter(p => p[7]).length + " landed" + (firstDiff >= 0 ? ", first difference " + JSON.stringify(det.pa[firstDiff]) + " vs " + JSON.stringify(det.pb[firstDiff]) : "") + ")");
  if (!det.samePos) for (let i = 0; i < det.pa.length; i++) if (JSON.stringify(det.pa[i]) !== JSON.stringify(det.pb[i])) console.log("  differs:", JSON.stringify(det.pa[i]), JSON.stringify(det.pb[i]));

  // ---- 1000x: still only 0.05 s ticks; a slow frame drops what it can't fit instead of owing it
  const ff = await lib.sim(pg, () => {
    BF.state.paused = true;
    const W = BF.warp, hs = [], up = BF.mobs.update;
    BF.mobs.update = function (h) { hs.push(h); return up.apply(this, arguments); };
    try {
      W.set(W.SPEEDS.indexOf(1000));
      const n1 = BF.simFrame(0.1), a1 = W.alpha;   // asks for 100 s = 2000 ticks: at most 1000, within the budget
      const n2 = BF.simFrame(0.001);               // 1 s more: up to 20 ticks, nothing owed from the frame before
      W.reset();
      const a0 = W.alpha, n3 = BF.simFrame(0.01), n4 = BF.simFrame(0.04);   // 1x: whatever fraction was left, plus 0.01 s, then 0.04 s
      const want3 = Math.floor((a0 * 0.05 + 0.01) / 0.05 + 1e-9), want4 = Math.floor((a0 * 0.05 + 0.05) / 0.05 + 1e-9) - want3;
      const wantAlpha = ((a0 * 0.05 + 0.05) - (want3 + want4) * 0.05) / 0.05;
      return { n1, a1, n2, a0, n3, n4, want3, want4, alpha: W.alpha, wantAlpha, bad: hs.filter(h => h !== W.TICK).length, last: W.last };
    } finally { BF.mobs.update = up; W.reset(); BF.state.paused = false; }
  });
  console.log(JSON.stringify(ff));
  check(ff.bad === 0, "fast-forward ticks are 0.05 s too");
  check(ff.n1 >= 1 && ff.n1 <= 1000 && ff.a1 < 1, "a 1000x frame runs at most 1000 ticks and drops the rest (" + ff.n1 + " ran)");
  check(ff.n2 >= 1 && ff.n2 <= 20, "the next frame runs only its own ticks, at most 20 (" + ff.n2 + ")");
  check(ff.n3 === ff.want3 && ff.n4 === ff.want4 && Math.abs(ff.alpha - ff.wantAlpha) < 1e-6, "at 1x the accumulator carries the fraction of a tick (" + ff.n3 + " + " + ff.n4 + " ticks, alpha " + ff.alpha.toFixed(3) + ")");

  // ---- drawing between ticks: a walking mob is drawn between prev and cur, and at cur when alpha is 1
  // (paused from the page, as the pause menu does, so the simulation runs no tick of its own until the drawing is checked)
  await pg.evaluate(() => { BF.state.paused = true; });
  const mv = await lib.sim(pg, () => {
    BF.state.paused = true;
    const P = BF.player.position, x = P.x + 5, z = P.z + 5, y = BF.world.heightAt(Math.floor(x), Math.floor(z)) + 1;
    const m = BF.mobs.spawn("cow", x, y, z);
    globalThis.__ftCow = m;
    m.vel.set(3, 0, 0);
    m.knockT = 1;   // keep the push for this tick (no AI steering)
    BF.proto.flush(true);   // the page draws from the protocol's mirror (r15-37): send the mob before and after its tick
    BF.rand.step();         // (one simulation step, as js/main.js counts them: the mirror interpolates across exactly one tick)
    BF.mobs.update(BF.warp.TICK);
    BF.proto.flush(true);
    return { n: BF.proto.numberOf(m), q: { x: m.prev.x, y: m.prev.y, z: m.prev.z }, c: { x: m.position.x, y: m.position.y, z: m.position.z } };
  });
  // the page's mirror has the cow's latest tick and the one before it
  await pg.waitForFunction(mv => { const M = BF.client.world, e = M.entities.get(mv.n); return e && Math.abs(e.x - mv.c.x) < 1e-9 && M.k(e, 0.5) === 0.5; }, mv, { timeout: 20000 }).catch(() => {});
  console.log("mirror " + JSON.stringify(await pg.evaluate(mv => { const M = BF.client.world, e = M.entities.get(mv.n); return { mv, tick: M.tick, e: e && { x: e.x, z: e.z, prev: e.prev, ct: e.ct, pt: e.pt } }; }, mv)));
  const drawn = await pg.evaluate(mv => {
    // drawn by js/mobview.js at BF.warp.alpha, held here at 0.5 and then 1
    const W = BF.warp, desc = Object.getOwnPropertyDescriptor(W, "alpha"), V = BF.mobView, e = BF.client.world.entities.get(mv.n);
    if (!e) return null;
    let A = 0.5;
    Object.defineProperty(W, "alpha", { get: () => A, configurable: true });
    try {
      V.render(0);
      const d = V.drawPos(e), v = V.viewOf(mv.n), mid = { x: d.x, y: d.y, z: d.z }, model = v ? { x: v.root.position.x, z: v.root.position.z } : null;
      A = 1;
      V.render(0);
      const f = V.drawPos(e), end = { x: f.x, y: f.y, z: f.z };
      return { mid, model, end };
    } finally { Object.defineProperty(W, "alpha", desc); }
  }, mv);
  const still = await lib.sim(pg, c => { const m = globalThis.__ftCow, r = m.position.x === c.x && m.position.z === c.z; BF.mobs.discard(m); delete globalThis.__ftCow; BF.state.paused = false; return r; }, mv.c);
  await pg.evaluate(() => { BF.state.paused = false; });
  const dr = Object.assign({ q: mv.q, c: mv.c, simUntouched: still }, drawn || { mid: { x: NaN, z: NaN }, model: null, end: { x: NaN, z: NaN } });
  console.log(JSON.stringify(dr));
  const between = (v, a, b) => v >= Math.min(a, b) - 1e-9 && v <= Math.max(a, b) + 1e-9;
  check(Math.abs(dr.c.x - dr.q.x) > 0.05, "the test mob moved in its tick (" + (dr.c.x - dr.q.x).toFixed(3) + " blocks)");
  check(between(dr.mid.x, dr.q.x, dr.c.x) && between(dr.mid.z, dr.q.z, dr.c.z) && Math.abs(dr.mid.x - (dr.q.x + dr.c.x) / 2) < 1e-6, "at alpha 0.5 the mob is drawn halfway between prev and cur");
  check(dr.model && Math.abs(dr.model.x - dr.mid.x) < 1e-6 && Math.abs(dr.model.z - dr.mid.z) < 1e-6, "and its model is placed there (" + JSON.stringify(dr.model) + ")");
  check(Math.abs(dr.end.x - dr.c.x) < 1e-9 && Math.abs(dr.end.z - dr.c.z) < 1e-9, "at alpha 1 it is drawn where the sim has it");
  check(dr.simUntouched, "drawing doesn't move the simulated mob");

  await pg.waitForTimeout(500);
  await pg.screenshot({ path: out + "-end.png" });
  console.log(fails.length ? "FAILED " + fails.length + ": " + fails.join("; ") : "fixed tick: all ok");
};
