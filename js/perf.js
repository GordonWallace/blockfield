// Villager-seconds meter (spec r15-01): how much simulation the game gets through, as villager-seconds of game time simulated per
// real second (V·s/s). Speed and headcount trade 1:1 (twice the villagers at half the speed is the same work), so this is the number
// the 1.5 scaling work is measured by. Also mob-seconds per second (every loaded mob), ms per simulation step and that step split by
// subsystem, in the categories of reports/perf-mobs.md: villagers (their AI plus the village systems), monsters, wild animals, village
// animals (pens, coops, stables, golems, bees), streaming/remesh (BF.world.update, once a frame, spread over the frame's steps),
// world (sky, block ticks, furnaces, drops, boats) and other (mob bookkeeping: separation grid, arrows, despawn, mob save).
// Shown on F3 (js/main.js) and in the debug screen's Performance card (js/debugfeed.js perf, debug/index.html).
// Costs nothing while off: the step's timing points (lap) return at once. It's on while the F3 overlay is open, while the debug
// screen is receiving the feed, or while a harness asks (ask(true), tools/perf/). Timing is a performance.now() pair per point.
// Every step's time goes to some category (each lap charges the time since the last one), so the split adds up to ms per step.
// Figures are smoothed over the last WINDOW_MS of real time. Frozen (0x) or paused: stats() keeps the last live figures, stale: true.
// API: BF.perf = { on, C (category ids), CATS (names), lap(c), mark(), mobCat(m), beginStep(), endStep(h), frame(), ask(on),
//                  stats() -> {vss, mobss, msPerStep, split {name: ms}, villagers, mobs (the last step's), speed (game s per real s), stale}, vss(), mobss(), msPerStep(), split(),
//                  history() (V·s/s once a real second, the last 2 minutes), totals() (since reset), reset(), laps (timing points run) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const CATS = ["villagers", "monsters", "wild animals", "village animals", "streaming", "world", "other"];
const C = { villagers: 0, monsters: 1, wild: 2, vanimals: 3, stream: 4, world: 5, other: 6 };
const N = CATS.length;
const WINDOW_MS = 5000, BUCKET_MS = 500, HIST = 120;   // smoothing window; its slices; sparkline points (one a second: 2 minutes)
const STALE_MS = 1000;                                  // no step for this long (frozen, paused): the last live figures, greyed

const now = () => performance.now();
// a slice of the window: steps, game s, villager-s, mob-s, step ms, ms by category, and the last step's villager and mob counts
const bucket = t0 => ({ t0, steps: 0, game: 0, vs: 0, mobs: 0, ms: 0, t: new Float64Array(N), v: 0, m: 0 });
let buckets = [], cur = null, last = 0, stepT0 = 0, asks = 0, wasOn = false, lastLive = null, histT = 0;
let lastStepT = 0, nSteps = 0, streamB = null, streamMs = 0, streamAt = -1;   // the last step's time; the last frame's streaming, kept only if steps follow
let tot = null;
const hist = [];

const P = {
  on: false, C, CATS, laps: 0,
  // charge the time since the last point to category c
  lap(c) {
    if (!P.on) return;
    const n = now();
    cur.t[c] += n - last; P.laps++;
    if (c === C.stream) { streamB = cur; streamMs = n - last; streamAt = nSteps; }
    last = n;
  },
  mark() { if (P.on) last = now(); },
  // which category a mob's update counts under
  mobCat(m) {
    if (m.type === "villager") return C.villagers;
    if (m.def && m.def.golem) return C.vanimals;
    if (m.hostile || (m.def && m.def.hostile)) return C.monsters;
    if ((BF.mobs.isWild && BF.mobs.isWild(m)) || (m.type === "horse" && m.horse && !m.horse.owner && !m.horse.tamed)) return C.wild;
    return C.vanimals;
  },
  beginStep() { if (P.on) stepT0 = last = now(); },
  // one simulation step of h game seconds is done: count the villagers and mobs it simulated (charged to other), close its time
  endStep(h) {
    if (!P.on) return;
    let v = 0, m = 0;
    for (const x of BF.mobs.list) if (!x.dead && !x.removed) { m++; if (x.type === "villager") v++; }
    P.lap(C.other);
    lastStepT = last; nSteps++;
    cur.steps++; cur.game += h; cur.vs += v * h; cur.mobs += m * h; cur.ms += last - stepT0; cur.v = v; cur.m = m;
    if (tot) { tot.steps++; tot.game += h; tot.vs += v * h; tot.mobs += m * h; tot.stepMs += last - stepT0; }
  },
  // once a frame (js/main.js): on or off, a new slice of the window every BUCKET_MS, the sparkline once a second
  frame() {
    const on = !!(BF.debugOn || asks > 0 || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live()));
    if (on !== wasOn) toggle(on);
    if (!on) return false;
    // the previous frame's streaming counts toward ms per step only if that frame ran steps (frozen or paused, it ran none)
    if (streamB && streamAt === nSteps) streamB.t[C.stream] -= streamMs;
    streamB = null;
    const t = now();
    if (t - cur.t0 >= BUCKET_MS) {
      buckets.push(cur = bucket(t));
      while (buckets.length && buckets[0].t0 < t - WINDOW_MS) buckets.shift();
    }
    if (t - histT >= 1000) { histT = t; const s = P.stats(); hist.push(s.stale ? 0 : Math.round(s.vss)); if (hist.length > HIST) hist.shift(); }
    return true;
  },
  // a harness or test keeps the meter on while it measures (calls nest)
  ask(on) { asks = Math.max(0, asks + (on ? 1 : -1)); P.frame(); },
  stats() {
    if (!P.on) return lastLive ? { ...lastLive, stale: true } : null;
    // real time counts only the slices that ran steps (up to the last step), so time frozen or paused doesn't dilute the figures;
    // no step for STALE_MS: stale
    const t = now();
    let steps = 0, game = 0, vs = 0, mobs = 0, ms = 0, real = 0;
    const tt = new Float64Array(N);
    buckets.forEach((b, i) => { if (b.steps) real += (Math.min(lastStepT, i + 1 < buckets.length ? buckets[i + 1].t0 : lastStepT) - b.t0) / 1000; });
    for (const b of buckets) { steps += b.steps; game += b.game; vs += b.vs; mobs += b.mobs; ms += b.ms; for (let i = 0; i < N; i++) tt[i] += b.t[i]; }
    if (!steps || real <= 0 || t - lastStepT > STALE_MS) return lastLive ? { ...lastLive, stale: true } : { vss: 0, mobss: 0, msPerStep: 0, split: zeroSplit(), villagers: 0, mobs: 0, speed: 0, stale: true };
    const split = {};
    for (let i = 0; i < N; i++) split[CATS[i]] = tt[i] / steps;
    const lastB = buckets.slice().reverse().find(b => b.steps) || cur;
    lastLive = { vss: vs / real, mobss: mobs / real, msPerStep: (ms + tt[C.stream]) / steps, split, villagers: lastB.v, mobs: lastB.m, speed: game / real, stale: false };
    return lastLive;
  },
  vss: () => (P.stats() || {}).vss || 0,
  mobss: () => (P.stats() || {}).mobss || 0,
  msPerStep: () => (P.stats() || {}).msPerStep || 0,
  split: () => (P.stats() || {}).split || zeroSplit(),
  history: () => hist.slice(),
  // running totals since reset(), for harnesses: real s, game s, villager-s, mob-s, steps, step ms and ms by category
  reset() {
    tot = { t0: now(), steps: 0, game: 0, vs: 0, mobs: 0, stepMs: 0, t0Cat: cur ? Float64Array.from(sumCats()) : new Float64Array(N) };
  },
  totals() {
    if (!tot) return null;
    const c = sumCats(), split = {};
    for (let i = 0; i < N; i++) split[CATS[i]] = c[i] - tot.t0Cat[i];
    return { real: (now() - tot.t0) / 1000, steps: tot.steps, game: tot.game, vs: tot.vs, mobs: tot.mobs, stepMs: tot.stepMs, split };
  },
};
// ms by category over the whole time the meter has been on (totals() takes differences of it)
let allT = new Float64Array(N);
function sumCats() { const s = Float64Array.from(allT); for (const b of buckets) for (let i = 0; i < N; i++) s[i] += b.t[i]; return s; }
const zeroSplit = () => Object.fromEntries(CATS.map(k => [k, 0]));
function toggle(on) {
  const s = wasOn ? P.stats() : null;
  wasOn = P.on = on;
  if (on) { buckets = [cur = bucket(now())]; last = now(); histT = 0; }
  else { for (const b of buckets) for (let i = 0; i < N; i++) allT[i] += b.t[i]; buckets = []; }
  if (!BF.glog) return;
  const why = BF.debugOn ? "F3 overlay" : asks > 0 ? "a harness" : "debug screen";
  if (on) BF.glog.log("INFO", "perf", "Performance meter on (" + why + ")");
  else if (s && !s.stale) BF.glog.log("INFO", "perf", `Performance meter off: ${Math.round(s.vss)} V·s/s, ${Math.round(s.mobss)} mob-s/s, ${s.msPerStep.toFixed(2)} ms/step, ${s.villagers} villagers (last ${WINDOW_MS / 1000} s)`);
  else BF.glog.log("INFO", "perf", "Performance meter off");
}

// "Sim 1234 V·s/s  2.9 ms/step  (villagers 0.8, monsters 0.6, ...)": the F3 line (also the debug screen's raw F3 text)
P.text = s => {
  if (!s) return "";
  const parts = CATS.map(k => `${k} ${s.split[k].toFixed(2)}`).join(", ");
  return `Sim ${Math.round(s.vss)} V·s/s  ${Math.round(s.mobss)} mob-s/s  ${s.msPerStep.toFixed(1)} ms/step  (${parts})${s.stale ? "  (paused)" : ""}`;
};

BF.perf = P;
})();
