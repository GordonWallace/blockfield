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
//                  history() (V·s/s once a real second, the last 2 minutes), totals() (since reset), reset(), laps (timing points run),
//                  stateOf(m), mobLap(m, st), count {paths, trades}, byState(), activity(), villageSpeed(), census() }
// Activity and cost (spec r15-60), all since reset() (or since the meter came on), for the work that makes villagers cheaper (r15-61 on):
//   byState(): mob updates and µs per update by class (villager, village animal, wild, hostile, golem) and by the state the mob was in
//     before its update (idle, route, wander, work, sleep; stateOf). The mob loop (js/mobs.js update) times each update with mobLap.
//   activity(): what villagers got done per villager-second: requests sent by kind (BF.req.stats()), path searches, trades, items gained
//     and spent by name (the world's census at reset() against now, js/headless.js census). A cheaper villager must keep these.
//   villageSpeed(): each village's own cost, ms per tick: its mobs' updates (villagers, its animals and golems; another mob counts for
//     the village whose region it is in) plus the village systems (builder, jobs, pens, bees... the laps charged to villagers or village
//     animals outside the mob loop), shared out by villager count. The top fast-forward that allows is 50 ms (a tick at 1x) / ms per tick;
//     the busiest village (over the window) is the second F3 line.
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
const bucket = t0 => ({ t0, steps: 0, game: 0, vs: 0, mobs: 0, ms: 0, t: new Float64Array(N), v: 0, m: 0, vil: new Map(), vv: new Map(), sys: 0 });
// r15-60: mob classes and states (byState), and the running sums since reset (or the meter coming on)
const CLASSES = ["villager", "village animal", "wild", "hostile", "golem"], STATES = ["idle", "route", "wander", "work", "sleep"];
const NS = STATES.length, CAT_OF = [C.villagers, C.vanimals, C.wild, C.monsters, C.vanimals];
let acc = null;   // {n, ms (Float64Array class * NS + state), vil Map rec -> mob ms, vv Map rec -> villager-steps, sys, steps, vs, real0, req, paths, trades, items}
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
    if (c === C.villagers || c === C.vanimals) { cur.sys += n - last; acc.sys += n - last; }   // the village systems (villageSpeed)
    if (c === C.stream) { streamB = cur; streamMs = n - last; streamAt = nSteps; }
    last = n;
  },
  mark() { if (P.on) last = now(); },
  // r15-60: what a mob is doing before its update, as an index into STATES: asleep; following a route; walking somewhere off a route
  // (wandering, a target); at a task (a jobsite's work spell, a villager task); else idle
  stateOf(m) {
    if (m.sleeping) return 4;
    const ai = m.ai;
    if (ai && ai.route && ai.ri < ai.route.length) return 1;
    if (m.vtask || (m.job && m.job.mode === "work")) return 3;
    return ai && (ai.mode === "walk" || ai.target) ? 2 : 0;
  },
  classOf(m) {
    if (m.type === "villager") return 0;
    if (m.def && m.def.golem) return 4;
    if (m.hostile || (m.def && m.def.hostile)) return 3;
    if ((BF.mobs.isWild && BF.mobs.isWild(m)) || (m.type === "horse" && m.horse && !m.horse.owner && !m.horse.tamed)) return 2;
    return 1;
  },
  // the mob loop's point after each update (only while on): the time since the last point is mob m's update, in state st (stateOf
  // before the update), charged to its category and counted by class and state and for its village
  mobLap(m, st) {
    const n = now(), d = n - last, k = P.classOf(m);
    cur.t[CAT_OF[k]] += d; P.laps++; last = n;
    acc.n[k * NS + st]++; acc.ms[k * NS + st] += d;
    const r = villageOf(m);
    if (r) { cur.vil.set(r, (cur.vil.get(r) || 0) + d); acc.vil.set(r, (acc.vil.get(r) || 0) + d); }
  },
  count: { paths: 0, trades: 0, deaths: {} },   // path searches (js/mobs.js findPath), trades (js/villagelog.js trade) and deaths by "type:cause" (js/mobs.js kill), on or off: a count costs nothing
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
    for (const x of BF.mobs.list) if (!x.dead && !x.removed) {
      m++;
      if (x.type === "villager") { v++; const r = x.villageId != null && BF.ids.get(x.villageId); if (r) { cur.vv.set(r, (cur.vv.get(r) || 0) + 1); acc.vv.set(r, (acc.vv.get(r) || 0) + 1); } }
    }
    P.lap(C.other);
    acc.steps++; acc.vs += v * h;
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
      // a slice leaving the window keeps counting in the totals (totals() reads allT plus the window: dropped slices were lost, so a
      // harness run longer than the window got a split that covered only its last 5 s, r15-50)
      while (buckets.length && buckets[0].t0 < t - WINDOW_MS) { const o = buckets.shift(); for (let i = 0; i < N; i++) allT[i] += o.t[i]; }
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
    const vil = new Map(), vv = new Map();
    let sys = 0;
    for (const b of buckets) { sys += b.sys; for (const [r, x] of b.vil) vil.set(r, (vil.get(r) || 0) + x); for (const [r, x] of b.vv) vv.set(r, (vv.get(r) || 0) + x); }
    const busiest = speeds(vil, vv, sys, steps)[0] || null;
    const far = BF.mobs && BF.mobs.coarse ? BF.mobs.coarse() : null;   // far villages (spec r15-64)
    lastLive = { vss: vs / real, mobss: mobs / real, msPerStep: (ms + tt[C.stream]) / steps, split, villagers: lastB.v, mobs: lastB.m, speed: game / real, busiest, far, stale: false };
    return lastLive;
  },
  vss: () => (P.stats() || {}).vss || 0,
  mobss: () => (P.stats() || {}).mobss || 0,
  msPerStep: () => (P.stats() || {}).msPerStep || 0,
  split: () => (P.stats() || {}).split || zeroSplit(),
  history: () => hist.slice(),
  // running totals since reset(), for harnesses: real s, game s, villager-s, mob-s, steps, step ms and ms by category
  reset() {
    acc = newAcc();
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
  if (!on) { for (const b of buckets) for (let i = 0; i < N; i++) allT[i] += b.t[i]; buckets = []; }
  if (BF.glog) {
    const why = BF.debugOn ? "F3 overlay" : asks > 0 ? "a harness" : "debug screen";
    if (on) BF.glog.log("INFO", "perf", "Performance meter on (" + why + ")");
    else if (s && !s.stale) BF.glog.log("INFO", "perf", `Performance meter off: ${Math.round(s.vss)} V·s/s, ${Math.round(s.mobss)} mob-s/s, ${s.msPerStep.toFixed(2)} ms/step, ${s.villagers} villagers (last ${WINDOW_MS / 1000} s)`);
    else BF.glog.log("INFO", "perf", "Performance meter off");
  }
  // the window starts after the log line (off the page writing it can take tens of ms, which would count as real time with no steps)
  if (on) { buckets = [cur = bucket(now())]; last = now(); histT = 0; acc = newAcc(); }
}

// ---------------------------------------------------------------- activity and cost (spec r15-60)
// The village a mob's time counts for: its own (villagers, golems), its pen's (village animals), else the one whose region it is in.
function villageOf(m) {
  const id = m.villageId != null ? m.villageId : m.penVillageId;
  const r = id != null ? BF.ids.get(id) : null;
  if (r) return r;
  const R = BF.regions, k = R ? R.regionOf(m) : -1;
  if (k == null || k < 0) return null;
  const vs = R.villagesIn(k);
  if (vs) for (const v of vs) return v;
  return null;
}
const newAcc = () => ({ n: new Float64Array(CLASSES.length * NS), ms: new Float64Array(CLASSES.length * NS), vil: new Map(), vv: new Map(), sys: 0, steps: 0, vs: 0,
  req: BF.req ? BF.req.stats() : null, paths: P.count.paths, trades: P.count.trades, items: census().items });
// villages by cost, busiest first: [{key, name, villagers (average), ms (per tick: own mobs + its share of the systems), max (x)}]; a
// village with no villagers (a far extra before #564) is left out
function speeds(vil, vv, sys, steps) {
  if (!steps) return [];
  let all = 0;
  for (const x of vv.values()) all += x;
  const out = [];
  for (const [r, x] of vv) {
    if (!x) continue;
    const ms = ((vil.get(r) || 0) + (all ? sys * x / all : 0)) / steps;
    out.push({ key: r.key, name: (BF.signs && BF.signs.villageName && BF.signs.villageName(r.key)) || "Village", villagers: +(x / steps).toFixed(1), ms: +ms.toFixed(3), max: ms > 0 ? +(50 / ms).toFixed(1) : Infinity });
  }
  return out.sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : 1));
}
// Every item stack in the world by name: mobs' inventories, chests, furnaces, the player's slots, drops (js/headless.js census uses it).
function census() {
  const items = {}, I = BF.items, add = s => { if (s && s.count > 0 && I && I[s.id]) { const k = I[s.id].name; items[k] = (items[k] || 0) + s.count; } };
  if (BF.mobs) for (const m of BF.mobs.list) if (!m.removed && Array.isArray(m.inv)) m.inv.forEach(add);
  const V = BF.inventory;
  if (V && V.chests) for (const c of V.chests.values()) c.slots.forEach(add);
  if (V && V.furnaces) for (const f of V.furnaces.values()) f.slots.forEach(add);
  if (V && V.slots) V.slots.forEach(add);
  if (BF.drops && BF.drops.list) for (const d of BF.drops.list) add(d);
  const sorted = {};
  for (const k of Object.keys(items).sort()) sorted[k] = items[k];
  return { items: sorted, coins: items.emerald || 0 };
}
P.census = census;
// {class: {state: {n, us}}, total {n, us}}: updates and µs per update since reset
P.byState = () => {
  const o = {}, a = acc;
  let n = 0, ms = 0;
  if (!a) return { total: { n: 0, us: 0 } };
  CLASSES.forEach((c, k) => {
    const row = {};
    STATES.forEach((s, j) => { const i = k * NS + j; row[s] = { n: a.n[i], us: a.n[i] ? +(a.ms[i] * 1000 / a.n[i]).toFixed(2) : 0 }; n += a.n[i]; ms += a.ms[i]; });
    o[c] = row;
  });
  o.total = { n, us: n ? +(ms * 1000 / n).toFixed(2) : 0 };
  return o;
};
// per villager-second since reset: {villagerSeconds, steps, requests {sent, applied, refused, byKind {kind: sent}}, paths, trades,
// gained {item: n}, spent {item: n}}, each a rate; counts: the same as plain totals
P.activity = () => {
  const a = acc;
  if (!a) return null;
  const vs = a.vs, rate = x => (vs > 0 ? +(x / vs).toPrecision(4) : 0);
  const r1 = BF.req ? BF.req.stats() : null, r0 = a.req || { sent: 0, applied: 0, refused: 0, byKind: {} };
  const req = { sent: 0, applied: 0, refused: 0, byKind: {} };
  if (r1) {
    for (const k of ["sent", "applied", "refused"]) req[k] = r1[k] - (r0[k] || 0);
    for (const k of Object.keys(r1.byKind).sort()) { const d = r1.byKind[k].sent - ((r0.byKind[k] && r0.byKind[k].sent) || 0); if (d) req.byKind[k] = d; }
  }
  const i0 = a.items, i1 = census().items, gained = {}, spent = {};
  for (const k of new Set([...Object.keys(i0), ...Object.keys(i1)])) { const d = (i1[k] || 0) - (i0[k] || 0); if (d > 0) gained[k] = d; else if (d < 0) spent[k] = -d; }
  const counts = { requests: req, paths: P.count.paths - a.paths, trades: P.count.trades - a.trades, gained, spent };
  const per = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, rate(o[k])]));
  return { villagerSeconds: +vs.toFixed(1), steps: a.steps, counts,
    perVillagerSecond: { requests: rate(req.sent), applied: rate(req.applied), byKind: per(req.byKind), paths: rate(counts.paths), trades: rate(counts.trades),
      events: rate(req.sent + counts.paths), gained: per(gained), spent: per(spent) } };
};
// each village's ms per tick and top speed since reset, busiest first (speeds)
P.villageSpeed = () => (acc ? speeds(acc.vil, acc.vv, acc.sys, acc.steps) : []);
P.CLASSES = CLASSES; P.STATES = STATES;

// "Sim 1234 V·s/s  2.9 ms/step  (villagers 0.8, monsters 0.6, ...)": the F3 line (also the debug screen's raw F3 text)
P.text = s => {
  if (!s) return "";
  const parts = CATS.map(k => `${k} ${s.split[k].toFixed(2)}`).join(", ");
  const b = s.busiest;   // r15-60: "Busiest village: Oakbrook 2.8 ms/tick, max 18x"
  return `Sim ${Math.round(s.vss)} V·s/s  ${Math.round(s.mobss)} mob-s/s  ${s.msPerStep.toFixed(1)} ms/step  (${parts})${s.stale ? "  (paused)" : ""}` +
    (b ? `\nBusiest village: ${b.name} ${b.ms.toFixed(1)} ms/tick, max ${isFinite(b.max) ? Math.floor(b.max) : "∞"}x` : "") +
    (s.far ? `\nFar villages: ${s.far.on ? "coarse (" + s.far.n + " mobs)" : "full detail"}` : "");
};

BF.perf = P;
})();
