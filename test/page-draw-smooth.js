// @ci integration suite=world,ui timeout=600 hosts=worker,server
// bug-098: with the simulation off the page (a worker or the world server) mobs are drawn smoothly and rain falls. Gordon, 2026-10-28:
// "jerky mob movement" and "frozen raindrops in the air" on the world server. The page drew each mob between its last two states by its
// own clock, out of step with the ticks arriving (late, two or more at a time), so mobs snapped forward and back; and the page redrew the
// weather with a zero time step, so the drops' clock never moved. Checks, over 20 s of frames near the boot village in the rain:
//  - the drawn path of every mob in view: a step backwards against the one before, a stop in the middle of a walk and a hop (a step more
//    than 2.5 times both its neighbours) are each under 1% of the moving frames (before the fix, 3% / 4% / 1% on the world server);
//  - the drawing clock (BF.client.world.rt) stays behind the newest tick and seldom has to wait there;
//  - the rain's shader clock moves on.
// On the page host the old alpha rule still draws (no drawing clock): the rain check runs there too.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/pd test/page-draw-smooth.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await pg.setViewportSize({ width: 240, height: 140 });   // small: swiftshader is slow, and the frames are what is measured
  await lib.sim(pg, () => { BF.weather.set("rain", 600); BF.weather.intensity = 1; BF.sky.setTime(0.3); });
  await pg.waitForTimeout(6000);
  const off = await pg.evaluate(() => !!BF.simHost.worker);
  const r = await pg.evaluate(() => new Promise(res => {
    const M = BF.client.world, tracks = new Map();
    let rain = null;
    BF.scene.traverse(o => { const u = o.material && o.material.uniforms; if (u && u.uTime && u.uIntensity) rain = u; });
    const rain0 = rain ? rain.uTime.value : null;
    if (M.drawStats) M.drawStats();
    let frames = 0, behind = 0;
    const t0 = performance.now();
    const f = () => {
      frames++;
      if (M.rt != null && M.rt <= M.tick) behind++;
      for (const e of M.entities.values()) if (e.kind === "mob") {
        const p = BF.mobView.drawPos(e);
        let t = tracks.get(e.n);
        if (!t) tracks.set(e.n, t = []);
        t.push([p.x, p.z]);
      }
      if (performance.now() - t0 < 20000) { requestAnimationFrame(f); return; }
      let back = 0, stall = 0, hop = 0, moving = 0;
      for (const t of tracks.values()) for (let i = 2; i + 1 < t.length; i++) {
        const la = Math.hypot(t[i - 1][0] - t[i - 2][0], t[i - 1][1] - t[i - 2][1]), lb = Math.hypot(t[i][0] - t[i - 1][0], t[i][1] - t[i - 1][1]);
        const lc = Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]);
        if (la <= 0.02) continue;
        moving++;
        const dot = (t[i - 1][0] - t[i - 2][0]) * (t[i][0] - t[i - 1][0]) + (t[i - 1][1] - t[i - 2][1]) * (t[i][1] - t[i - 1][1]);
        if (lb > 0.005 && dot / (la * lb) < -0.5) back++;
        if (lb < 1e-6 && lc > 0.02) stall++;
        if (lc > 0.02 && lb > 2.5 * Math.max(la, lc)) hop++;
      }
      res({ fps: +(frames / 20).toFixed(1), mobs: tracks.size, moving, back, stall, hop, frames, behind, rt: M.rt != null,
        draw: M.drawStats ? M.drawStats() : null, rain: rain ? [rain0, rain.uTime.value] : null });
    };
    requestAnimationFrame(f);
  }));
  console.log("measured " + JSON.stringify(r));
  ok("rain: the drops' clock moves on", r.rain && r.rain[1] !== r.rain[0], r.rain);
  if (off) {
    ok("mobs in view, moving", r.mobs >= 10 && r.moving >= 500, { mobs: r.mobs, moving: r.moving });
    const pc = n => +(100 * n / Math.max(1, r.moving)).toFixed(2);
    ok("drawn steps backwards under 1%", pc(r.back) < 1, pc(r.back));
    ok("stops mid-walk under 1%", pc(r.stall) < 1, pc(r.stall));
    ok("hops under 1%", pc(r.hop) < 1, pc(r.hop));
    ok("the drawing clock runs, behind the newest tick", r.rt && r.behind === r.frames, { behind: r.behind, frames: r.frames });
    ok("the drawing clock seldom waits at the newest tick", r.draw && r.draw.waits <= r.draw.frames * 0.05, r.draw);
  } else ok("in the page: no drawing clock (the alpha rule)", !r.rt, r.rt);
  if (fails.length) throw new Error("FAILED: " + fails.join("; "));
  console.log("ALL PASS");
};
