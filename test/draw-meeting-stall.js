// @ci integration suite=world timeout=300
// The page's drawing clock through cluster workers' meetings (r15-95, js/protocol.js world.draw / place, js/mobview.js settle). Gordon,
// 2026-11-04: at 1x the mobs visibly stop at every meeting. Plain node: a client end of the protocol gets the entities of mobs walking
// at a steady 1 block a second, one tick every 50 ms, except that every 160 ticks (a meeting) no tick comes for STALL ms and the ticks
// then go on from there (the time is lost: no catch-up), and the page draws 60 frames a second, as js/main.js does. Checks:
//  - a mob walking straight is never drawn standing still for more than 2 frames in a row (before: about 400 ms at each meeting);
//  - it is never drawn moving faster than 1.6 times its speed, or backwards;
//  - the drawing clock stays at most 0.65 s behind the newest tick (just before a meeting; about 0.4 s on average);
//  - a mob that turns back during a meeting is drawn without a jump (no frame step over 0.2 blocks);
//  - fast-forward (10x): the clock never goes past the newest tick (no drawing on along a step there);
//  - a mob that stepped up a block in the tick before a meeting (the one-tick step onto a block of the 1.6 slopes, js/mobs.js stepUp) is
//    never drawn above the height it stepped to, and one that dropped a block never below it: only the walk across the ground is drawn
//    on through a meeting, not the change of height (Gordon, 2026-11-12: mobs ahead were drawn about 10 blocks up in the air, then shot
//    down to the ground).
// Usage: node test/draw-meeting-stall.js [stall ms = 500]
const { load } = require('../tools/headless.js');
for (const k of ['log', 'info', 'debug', 'warn']) console[k] = () => {};
const { BF } = load();
const out = s => process.stdout.write(s + '\n');
const STALL = +(process.argv[2] || 500);
let fails = 0;
const check = (ok, what) => { out((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const P = BF.proto;
const mix = (a, b, k) => a + (b - a) * k;
// where js/mobview.js draws entity r's position (drawState, without the model): the same arithmetic
function drawn(M, r, o) {
  const p = r.prev, k = !p ? 1 : M.k(r, 1), T = k < 1 && r.to || r;
  if (k > 1) { o.x = mix(p.x, r.x, k); o.y = r.y; o.z = mix(p.z, r.z, k); }   // (the height is not drawn on along the step)
  else if (k >= 1) { o.x = r.x; o.y = r.y; o.z = r.z; }
  else { o.x = mix(p.x, T.x, k); o.y = mix(p.y, T.y, k); o.z = mix(p.z, T.z, k); }
  if (r.ox || r.oy) { o.x += r.ox; o.y += r.oy; o.z += r.oz; }
  return o;
}
// fake real time: protocol.js reads performance.now() when the entities arrive
let fake = 0;
performance.now = () => fake;
function runFake(speed, seconds, turnBack, step) {
  const C = P.connect(() => {}), M = C.world;
  const send = m => C.receive(P.encode(m));
  send({ t: 'hello', version: P.VERSION });
  let tick = 0, x = 0, y = 64, dir = 1, simAt = 0;
  const tickMs = 50 / speed;
  send({ t: 'clock', tick, day: 0, time: 0.3, speed, frozen: false, achieved: speed });
  send({ t: 'entities', tick, add: [{ n: 1, kind: 'mob', s: { type: 'villager', x, y: 64, z: 0, yaw: 0, headYaw: 0, headPitch: 0, walkPhase: 0, walkAmt: 1, age: 0, deathT: 0, fuse: 0, swingT: 0, doorT: 0 } }], set: [], gone: [] });
  const r1 = M.entities.get(1), o = { x: 0, y: 0, z: 0 }, xs = [];
  let over = 0;   // how far the mob was drawn past the height it stepped to, at most
  let maxBehind = 0, sumBehind = 0, nb = 0, past = 0, meetings = 0;
  const FR = 1000 / 60;
  for (let now = 0; now < seconds * 1000; now += FR) {
    while (simAt <= now) {
      fake = simAt;
      tick++; x += 0.05 * dir;
      const was = y;
      if (step && tick % 160 === 0) y += step;   // (the tick before the meeting: up or down a block in one tick)
      send({ t: 'entities', tick, add: [], set: [{ n: 1, s: Object.assign({ x, walkPhase: tick * 0.3, age: tick }, y !== was ? { y } : null) }], gone: [] });
      if (tick % 20 === 0) send({ t: 'clock', tick, day: 0, time: 0.3, speed, frozen: false, achieved: speed * 0.92 });
      simAt += tickMs;
      if (tick % 160 === 0) { simAt += STALL * (speed > 2 ? 0.1 : 1); meetings++; if (turnBack && meetings === turnBack) dir = -1; }
    }
    fake = now;
    M.draw(FR / 50 * speed, FR / 1000);
    drawn(M, r1, o);
    xs.push([now, o.x]);
    if (step) over = Math.max(over, step > 0 ? o.y - y : y - o.y);
    const behind = (M.tick - M.rt) * tickMs;
    if (now > 10000) { maxBehind = Math.max(maxBehind, behind); sumBehind += behind; nb++; }
    if (M.rt > M.tick + 1e-9) past++;
  }
  return { xs, maxBehind, avgBehind: sumBehind / Math.max(1, nb), past, meetings, over };
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
for (const [step, what] of [[1, 'stepped up a block'], [-1, 'dropped a block']]) {
  const d = runFake(1, 30, 0, step);
  out(what + ' in the tick before a meeting: drawn ' + d.over.toFixed(2) + ' blocks past that height at most');
  check(d.over <= 0.05, 'a mob that ' + what + ' before a meeting is not drawn on past that height (' + d.over.toFixed(2) + ' blocks)');
}
// Ticks that come slowly for a while (the world server busy loading land): the clock stays past the newest tick through several ticks, and
// a mob falling or walking down steps then must not gather a height offset (it was drawn up to 6 blocks above where it stood).
{
  const C = P.connect(() => {}), M = C.world, send = m => C.receive(P.encode(m));
  send({ t: 'hello', version: P.VERSION });
  let tick = 0, x = 0, y = 70, worst = 0;
  send({ t: 'clock', tick, day: 0, time: 0.3, speed: 1, frozen: false, achieved: 1 });
  send({ t: 'entities', tick, add: [{ n: 1, kind: 'mob', s: { type: 'villager', x, y, z: 0, yaw: 0, headYaw: 0, headPitch: 0, walkPhase: 0, walkAmt: 1, age: 0, deathT: 0, fuse: 0, swingT: 0, doorT: 0 } }], set: [], gone: [] });
  const r1 = M.entities.get(1), o = { x: 0, y: 0, z: 0 }, FR = 1000 / 60;
  let simAt = 0;
  for (let now = 0; now < 30000; now += FR) {
    while (simAt <= now) {
      fake = simAt; tick++; x += 0.05;
      const slow = tick % 200 >= 100 && tick % 200 < 130, was = y;
      if (slow && tick % 200 < 120) y -= tick % 2 ? 0.6 : 0.15;   // a fall, then on along the ground
      if (tick % 200 === 0) y = 70;
      send({ t: 'entities', tick, add: [], set: [{ n: 1, s: Object.assign({ x, walkPhase: tick * 0.3, age: tick }, y !== was ? { y } : null) }], gone: [] });
      simAt += slow ? 170 : 50;
    }
    fake = now;
    M.draw(FR / 50, FR / 1000);
    drawn(M, r1, o);
    const hs = (r1.hist || []).map(s => s.y).concat(r1.y), hi = Math.max.apply(null, hs), lo = Math.min.apply(null, hs);
    if (tick % 200 > 5) worst = Math.max(worst, o.y - hi, lo - o.y);
  }
  out('a fall while the ticks come slowly: drawn ' + worst.toFixed(2) + ' blocks outside the heights it had, at most');
  check(worst <= 1.15, 'a mob falling while the ticks come slowly is never drawn more than a block from the heights it had (' + worst.toFixed(2) + ' blocks)');
}
out(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
