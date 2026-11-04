// @ci integration suite=world timeout=300
// The page's drawing clock through cluster workers' meetings (r15-95, js/protocol.js world.draw / place, js/mobview.js settle). Gordon,
// 2026-11-04: at 1x the mobs visibly stop at every meeting. Plain node: a client end of the protocol gets the entities of mobs walking
// at a steady 1 block a second, one tick per tick length (50 ms at 0.05 s ticks), except that every 8 game seconds (a meeting) no tick comes for STALL ms and the ticks
// then go on from there (the time is lost: no catch-up), and the page draws 60 frames a second, as js/main.js does. Checks:
//  - a mob walking straight is never drawn standing still for more than 2 frames in a row (before: about 400 ms at each meeting);
//  - it is never drawn moving faster than 1.6 times its speed, or backwards;
//  - the drawing clock stays at most 0.65 s behind the newest tick (just before a meeting; about 0.4 s on average);
//  - a mob that turns back during a meeting is drawn without a jump (no frame step over 0.2 blocks);
//  - fast-forward (10x): the clock never goes past the newest tick (no drawing on along a step there).
// Usage: node test/draw-meeting-stall.js [stall ms = 500]
const { load } = require('../tools/headless.js');
for (const k of ['log', 'info', 'debug', 'warn']) console[k] = () => {};
const { BF } = load();
const out = s => process.stdout.write(s + '\n');
const STALL = +(process.argv[2] || 500);
const TK = BF.warp && BF.warp.TICK > 0 ? BF.warp.TICK : 0.05;   // the simulation's tick length (s)
let fails = 0;
const check = (ok, what) => { out((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const P = BF.proto;
const mix = (a, b, k) => a + (b - a) * k;
// where js/mobview.js draws entity r's position (drawState, without the model): the same arithmetic
function drawn(M, r, o) {
  const p = r.prev, k = !p ? 1 : M.k(r, 1), T = k < 1 && r.to || r;
  if (k > 1) { o.x = mix(p.x, r.x, k); o.z = mix(p.z, r.z, k); }
  else if (k >= 1) { o.x = r.x; o.z = r.z; }
  else { o.x = mix(p.x, T.x, k); o.z = mix(p.z, T.z, k); }
  if (r.ox) { o.x += r.ox; o.z += r.oz; }
  return o;
}
// fake real time: protocol.js reads performance.now() when the entities arrive
let fake = 0;
performance.now = () => fake;
function runFake(speed, seconds, turnBack) {
  const C = P.connect(() => {}), M = C.world;
  const send = m => C.receive(P.encode(m));
  send({ t: 'hello', version: P.VERSION, tickLen: TK });
  let tick = 0, x = 0, dir = 1, simAt = 0;
  const tickMs = TK * 1000 / speed, PER_S = Math.round(1 / TK), MEET = Math.round(8 / TK);   // (this build's tick length, idea-049)
  send({ t: 'clock', tick, day: 0, time: 0.3, speed, frozen: false, achieved: speed });
  send({ t: 'entities', tick, add: [{ n: 1, kind: 'mob', s: { type: 'villager', x, y: 64, z: 0, yaw: 0, headYaw: 0, headPitch: 0, walkPhase: 0, walkAmt: 1, age: 0, deathT: 0, fuse: 0, swingT: 0, doorT: 0 } }], set: [], gone: [] });
  const r1 = M.entities.get(1), o = { x: 0, z: 0 }, xs = [];
  let maxBehind = 0, sumBehind = 0, nb = 0, past = 0, meetings = 0;
  const FR = 1000 / 60;
  for (let now = 0; now < seconds * 1000; now += FR) {
    while (simAt <= now) {
      fake = simAt;
      tick++; x += TK * dir;
      send({ t: 'entities', tick, add: [], set: [{ n: 1, s: { x, walkPhase: tick * 0.3, age: tick } }], gone: [] });
      if (tick % PER_S === 0) send({ t: 'clock', tick, day: 0, time: 0.3, speed, frozen: false, achieved: speed * 0.92 });
      simAt += tickMs;
      if (tick % MEET === 0) { simAt += STALL * (speed > 2 ? 0.1 : 1); meetings++; if (turnBack && meetings === turnBack) dir = -1; }
    }
    fake = now;
    M.draw(FR / (TK * 1000) * speed, FR / 1000);
    drawn(M, r1, o);
    xs.push([now, o.x]);
    const behind = (M.tick - M.rt) * tickMs;
    if (now > 10000) { maxBehind = Math.max(maxBehind, behind); sumBehind += behind; nb++; }
    if (M.rt > M.tick + 1e-9) past++;
  }
  return { xs, maxBehind, avgBehind: sumBehind / Math.max(1, nb), past, meetings };
}
const a = runFake(1, 60);
let still = 0, maxStill = 0, fast = 0, back = 0;
for (let i = 1; i < a.xs.length; i++) {
  if (a.xs[i][0] < 10000) continue;
  const d = a.xs[i][1] - a.xs[i - 1][1];
  if (Math.abs(d) < 1e-6) { still++; maxStill = Math.max(maxStill, still); } else still = 0;
  if (d > 1.6 / 60) fast++;
  if (d < -1e-6) back++;
}
out('1x, ' + a.meetings + ' meetings of ' + STALL + ' ms: longest standstill ' + maxStill + ' frames, frames too fast ' + fast + ', backwards ' + back + ', behind max ' + a.maxBehind.toFixed(0) + ' ms avg ' + a.avgBehind.toFixed(0) + ' ms, frames past the newest tick ' + a.past);
check(maxStill <= 2, 'a walking mob is never drawn standing still for more than 2 frames (' + maxStill + ')');
check(fast === 0 && back === 0, 'never drawn faster than 1.6 times its speed or backwards (' + fast + ', ' + back + ')');
check(a.maxBehind <= 650, 'the drawing clock at most 0.65 s behind the newest tick (' + a.maxBehind.toFixed(0) + ' ms)');
const b = runFake(1, 30, 2);
let jump = 0;
for (let i = 1; i < b.xs.length; i++) jump = Math.max(jump, Math.abs(b.xs[i][1] - b.xs[i - 1][1]));
out('turning back at a meeting: largest frame step ' + jump.toFixed(3) + ' blocks');
check(jump <= 0.2, 'a mob that turns back during a meeting is drawn without a jump (' + jump.toFixed(3) + ' blocks)');
const c = runFake(10, 20);
check(c.past === 0, '10x: the clock never goes past the newest tick (' + c.past + ' frames)');
out(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
