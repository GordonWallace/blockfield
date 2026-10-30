// Active simulation set chosen by budget (spec r15-34). The village-loading rule in js/villagesim.js (the nearest 4 within 200 blocks,
// always within 100, trips' villages) is the guaranteed minimum; on top of it this keeps "extra" villages simulated while the machine
// has time to spare: the simulation may use up to `budget` of each real second (default 40%, the pause menu's "Simulated villages").
//  - Measuring: main.js simFrame reports each frame's simulation ms and real length (frame()); a frame at 0x or paused doesn't count.
//    This is the same time the villager-seconds meter (js/perf.js) charges to the steps, measured once a frame so it costs nothing extra
//    and runs whether or not the meter is on.
//  - (Under and over below are against the limit less and plus MARGIN of it: 75% and 85% at 80%; between them nothing changes.)
//  - Under budget for WIN real seconds (and, at 1x, at least MIN_FPS frames a second): the next nearest village not yet simulated, within
//    REACH blocks of the player, joins the set, if the time it is expected to take still fits (the current share per running village)
//    and its chunk data fits the memory budget (memMB of section arrays for the extras). It loads through the normal path: villageSim adds
//    it to the kept set, world.update generates its chunks, the villagers come out as they do for any village.
//  - Once a whole game day has been measured, a join is judged by the busiest hour of the last day instead (peak below): the share per
//    running village then, times the villages running, and one village's share then, so a set that fits at night still fits by day,
//    and villages can join at night and in the morning too (Gordon, 2026-10-30)
//  - Over budget for WIN seconds, and no load in the last HOLD seconds: the farthest extras leave the set, as many as the measure is over by
//    at the current share per running village (up to ADD_MAX, as they join), counting those still unloading as gone already; villageSim
//    unloads each with the unload countdown (its villagers finish their tasks first, as for any village the player walks away from). It
//    isn't picked again for COOL seconds. Still over after the next WIN seconds, more go (Gordon, 2026-10-30: step down in increments the
//    way it steps up; it used to wait for each one to unload, about a minute at 95% of each second).
//  - "Nearest only" lets the extras go the same way, ADD_MAX of the farthest each WIN seconds (Gordon, 2026-10-30: it dropped 27 at
//    once, and switching straight back loaded them all again); switching back keeps the rest. The budget off (tests) drops them at once.
//  - An extra past REACH (the player went away) leaves the same way; one that became part of the minimum stops being an extra.
// Where the simulation runs in a worker or on the world server (bug-081), the page's copy holds the setting (localStorage, ?budget=,
// off in automated browsers) and sends it there ({budget: {on, budget}}, js/simhost.js budget), where the decisions are made and logged;
// the pause menu's line asks the simulation for its text (the protocol's budget query).
// Real time decides here on purpose: what the machine can afford. So that the tests and the determinism checks see the distance rule,
// automated browsers start with it off (BF.active.set({ on: true }) or ?budget=N turns it on).
// The player's settings (Gordon, 2026-10-28: the pause menu's Distant villages panel, js/player.js), remembered in localStorage
// blockfield.distant and sent where the simulation is ({budget: {on, settings}}, js/simhost.js budget), which works out its own automatic
// values (its thread and machine):
//   villages  "auto": as many as the machine runs at 1x, nearest first (the default) | "nearest": the minimum rule only
//   share     "auto" | 0.2 .. 1: the most of each real second the simulation may take at 1x. Automatic is 80% where the simulation has a
//             thread of its own (a Web Worker, the world server: the rest is headroom for chunks, saves and spikes) and 40% in the page
//             (frames need the rest). Measured as simulation ms per game second (the simulation clock, BF.simNow; on a thread of its own
//             everything the thread did, streaming and messages included: js/boot.js simFrame), so the set is the one
//             that keeps 1x whatever the speed, and region workers' copies, replaying the leader's measure, decide alike
//   reach     0: no limit (the search for the next village widens as needed, up to SEARCH_MAX blocks a decision) | blocks
//   mem       "auto": a quarter of the machine's memory (the world server's, from Node; a browser's navigator.deviceMemory), 500 MB to
//             8000 MB (2000 MB in a browser) | MB
// Under budget with room for several more villages, up to ADD_MAX join in one decision (nearest first), so a fast machine fills up in
// minutes rather than one village every WIN seconds.
// API: BF.active = { frame(simMs, raw), decide(px, pz, base) -> [{key, v}], isExtra(key), extras(), set({on, budget, memMB, win, hold, morning,
//                    cool, reach, minFps, settings}, quiet), opts(), peak(), settings(), choose(field, value, quiet) -> settings, adopt(settings, quiet) -> settings, next(field) ->
//                    the value after the current one, auto() -> {share, memMB}, describe(settings) -> text, text(), feed(), log(), reset(),
//                    BUDGETS, CHOICES, DEFAULT }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const BUDGETS = [0, 0.2, 0.4, 0.6, 0.8, 1];   // the time shares to choose from (0: the minimum rule only)
const CHOICES = { villages: ["auto", "nearest"], share: ["auto", 0.2, 0.4, 0.6, 0.8, 1], reach: [0, 500, 1000, 2000, 4000, 8000], mem: ["auto", 250, 500, 1000, 2000, 4000, 8000] };
const DEFAULT = { villages: "auto", share: "auto", reach: 0, mem: "auto" };
const SEARCH_MIN = 1000, SEARCH_MAX = 12000, ADD_MAX = 3;
// The margins round the limit (Gordon, 2026-10-30): villages join only while the measure stays under the limit less a sixteenth of it
// (and one more village's share still fits under the limit) and leave only once it is over the limit plus a sixteenth (75% and 85% at
// 80%), so the set doesn't swing either way
const MARGIN = 1 / 16;
// A village's cost shows over a minute or more after it joins (its chunks, its villagers coming out and starting their day: 56% at the
// last join, 77% a minute later with none joining, Gordon's session 2026-10-30), so after a join the next waits HOLD seconds, and none
// joins in the day's first opt.morning (a fraction of the day) either
const joinAt = () => opt.budget * (1 - MARGIN), leaveAt = () => opt.budget * (1 + MARGIN);
const opt = { on: true, budget: 0.4, memMB: 500, win: 10, hold: 60, cool: 300, reach: 0, minFps: 30, fixed: 0, morning: 0.1 };   // fixed: see decide; reach 0: no limit
let S = Object.assign({}, DEFAULT);   // the player's settings (the header)
// automatic values, where the simulation is
const autoShare = () => (BF.page ? 0.4 : 0.8);
function autoMem() {
  const node = globalThis.BF_MEM_MB > 0;   // (the world server's thread: server/simthread.js, from os.totalmem)
  const total = node ? globalThis.BF_MEM_MB : typeof navigator !== "undefined" && navigator.deviceMemory > 0 ? navigator.deviceMemory * 1024 : 0;
  return total ? Math.max(500, Math.min(node ? 8000 : 2000, Math.round(total / 4 / 50) * 50)) : 1000;
}
const valid = (k, v) => CHOICES[k].some(c => c === v) || (k === "share" && v > 0 && v <= 10) || (k === "reach" && v >= 0) || (k === "mem" && v > 0);
function clean(o) {
  const out = Object.assign({}, DEFAULT);
  if (o && typeof o === "object") for (const k in DEFAULT) if (k in o) { const v = typeof o[k] === "string" && o[k] !== "auto" && o[k] !== "nearest" ? +o[k] : o[k]; if (valid(k, v)) out[k] = v; }
  return out;
}
// the settings into the figures decide() uses
function apply(s) {
  S = clean(s);
  opt.budget = S.villages === "nearest" ? 0 : S.share === "auto" ? autoShare() : +S.share;
  opt.reach = +S.reach || 0;
  opt.memMB = S.mem === "auto" ? autoMem() : +S.mem;
}
const store = {
  get() { try { const t = localStorage.getItem("blockfield.distant"); if (t) return JSON.parse(t); const b = parseFloat(localStorage.getItem("blockfield.simBudget")); return b >= 0 && b <= 1 ? (b > 0 ? { share: b } : { villages: "nearest" }) : null; } catch (_) { return null; } },   // (1.5's first setting, a share alone)
  set(s) { try { localStorage.setItem("blockfield.distant", JSON.stringify(s)); localStorage.removeItem("blockfield.simBudget"); } catch (_) {} },
};
{
  apply(store.get());
  if (typeof navigator === "undefined" || navigator.webdriver) opt.on = false;   // tests and the headless boot (no navigator, r15-40): the distance rule, unless they turn it on
  const q = typeof location !== "undefined" && /(?:^|[?&])budget=(\d+)/.exec(location.search.slice(1));
  if (q) { opt.on = true; apply(Object.assign({}, S, { villages: "auto", share: Math.min(10, +q[1] / 100) })); }
}
const lim = () => (opt.reach > 0 ? opt.reach : Infinity);

const now = () => BF.rworkers.realNow();   // (the wall clock; with region workers the leader's reading, so every worker decides alike: js/rworkers.js)
// ---- the measure: 1-second slices of real time that ran (not 0x, not paused), the last 10 kept for the figures shown
// frac: the share of each real second the simulation would take at 1x, its ms per game second (the simulation clock's advance: at 4x a
// frame runs 4 times the ticks; where ticks were dropped the clock moved less and the share comes out over 100%)
let slice = { sim: 0, real: 0, game: 0, frames: 0 }, slices = [], underMs = 0, overMs = 0, fps = 60, lastClock = null;
// The day's busiest hour (Gordon, 2026-10-30): each game hour's mean share per running village (game hour index -> {s, n}), the last
// day's kept. The load is about twice as high from a tenth of the day to the evening as at night (a fixed set of 18 villages on test4),
// so once a whole day has been measured a join is judged against what the set will need in the day's busiest hour (peak), at any
// time of day, rather than against the measure now; until then no village joins at night or in the morning (decide).
let hours = new Map();
const PEAK_HOURS = 21;   // of the last day's 23 whole hours before this one, at least this many measured before the peak is trusted
function hourly(frac) {
  const n = simulated();
  if (!(n > 0)) return;
  const hr = Math.floor(dayNow() * 24);
  let b = hours.get(hr);
  if (!b) { hours.set(hr, (b = { s: 0, n: 0 })); for (const k of [...hours.keys()]) if (k < hr - 24 || k > hr) hours.delete(k); }
  b.s += frac / n; b.n++;
}
// the share per running village in the busiest whole game hour of the last day, or null until enough of the day was measured
function peak() {
  const hr = Math.floor(dayNow() * 24);
  let best = 0, seen = 0;
  for (const [k, b] of hours) if (k >= hr - 23 && k < hr && b.n >= 3) { seen++; best = Math.max(best, b.s / b.n); }
  return seen >= PEAK_HOURS ? best : null;
}
function frame(simMs, raw) {
  const c = BF.simNow ? BF.simNow() : null, dg = c != null && lastClock != null ? Math.max(0, c - lastClock) : 0;
  lastClock = c;
  if (BF.warp && BF.warp.frozen) return;
  slice.sim += simMs; slice.real += Math.min(250, raw * 1000); slice.game += dg * 1000; slice.frames++;
  if (slice.real < 1000) return;
  const frac = slice.game > 0 ? slice.sim / slice.game : slice.sim / slice.real;
  fps = slice.frames * 1000 / slice.real;
  slices.push({ frac, fps }); if (slices.length > 10) slices.shift();
  hourly(frac);
  if (frac < joinAt()) { underMs += slice.real; overMs = 0; } else if (frac >= leaveAt()) { overMs += slice.real; underMs = 0; } else underMs = overMs = 0;
  slice = { sim: 0, real: 0, game: 0, frames: 0 };
}
const used = () => slices.length ? slices.reduce((s, x) => s + x.frac, 0) / slices.length : 0;

// ---- the extras
const extras = new Map();      // village key -> { v, t (real ms when it joined), d (edge distance at the last decision) }
const cooling = new Map();     // village key -> real ms until it may be picked again (it left for the budget)
const decisions = [];          // newest last: { day, text }
let lastLoad = -1e12, lastN = 0, stepAt = -1e12;   // (stepAt: real ms of the last "nearest only" step down)
const VS = () => BF.villageSim;
const vKey = v => Math.round(v.x) + "," + Math.round(v.z);
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const pct = f => (f > 0 && f < 0.01 ? "under 1" : Math.round(f * 100)) + "%";
function note(text, key) {
  decisions.push({ day: +dayNow().toFixed(3), text }); if (decisions.length > 40) decisions.shift();
  if (BF.glog) BF.glog.log("INFO", "budget", text, key ? { village: key } : undefined);   // js/gamelog.js
}
const vname = key => (BF.signs && BF.signs.villageName && BF.signs.villageName(key)) || "The village at " + key;
// bytes of section arrays per loaded chunk, on average (6.7 MB for a 55-villager village measured for the spec)
function chunkBytes() {
  const W = BF.world, n = W && W.chunks ? W.chunks.size : 0;
  if (!n || !BF.shared || !BF.shared.usage) return 48 * 1024;
  return Math.max(16 * 1024, BF.shared.usage().bytes / n);
}
// chunks the extras hold that the minimum set doesn't (the memory budget counts these)
function extraChunks(base, plus) {
  const own = new Set(), baseKeys = new Set();
  for (const e of base.values()) for (const k of e.keys) baseKeys.add(k);
  for (const [k] of extras) { const e = base.get(k) ? null : footprintOf(k); if (e) for (const c of e) if (!baseKeys.has(c)) own.add(c); }
  if (plus) for (const c of plus) if (!baseKeys.has(c)) own.add(c);
  return own.size;
}
const fp = new Map();   // village key -> its chunk keys (villageSim's footprint)
function footprintOf(key) {
  if (fp.has(key)) return fp.get(key);
  const x = extras.get(key);
  const keys = x ? VS().footprint(x.v) : null;
  if (keys) fp.set(key, keys);
  return keys;
}
// Extras let go, until they have unloaded (key -> why): their unload countdown is capped at WAIT_CAP game seconds (villageSim asks waitCap),
// so a village past a new distance limit, or one the time limit can't afford, goes in a minute rather than when its longest task ends
// (up to 40 minutes for a caravan trip). Their cost is still in the measure meanwhile: the time limit counts them as gone already.
const leaving = new Map();
const WAIT_CAP = 60;
const leavingNow = () => { for (const k of [...leaving.keys()]) if (extras.has(k) || !VS().isActive(k)) leaving.delete(k); return leaving.size; };
function drop(key, why) {
  const x = extras.get(key);
  if (!x) return;
  extras.delete(key); fp.delete(key); leaving.set(key, why);
  note(`${vname(key)} leaves the simulated set (${why}): it unloads once its villagers' tasks are done`, key);
}

// Called by villageSim's re-check (js/villagesim.js check) with the minimum set it has built (Map key -> {v, keys}). Returns the extras
// to simulate on top of it.
function decide(px, pz, base) {
  const t = now(), ed = VS()._edgeDist;
  for (const [k, until] of cooling) if (t >= until) cooling.delete(k);
  if (!opt.on) { for (const k of [...extras.keys()]) drop(k, "budget turned off"); return []; }
  for (const [k, x] of [...extras]) {
    if (base.has(k)) { extras.delete(k); fp.delete(k); continue; }   // part of the minimum now: nothing extra about it
    x.d = ed(x.v, px, pz);
    if (x.d > lim()) drop(k, `over ${opt.reach} blocks away`);
  }
  const listed = () => { lastN = base.size + extras.size; return [...extras].map(([key, x]) => ({ key, v: x.v })); };
  if (!(opt.budget > 0)) {   // nearest only: the farthest one each window
    if (extras.size && t - stepAt >= opt.win * 1000) { stepAt = t; drop(farthest(1)[0], "distant villages set to the nearest only"); }
    return listed();
  }
  stepAt = -1e12;
  if (opt.fixed > 0) return fixedSet(px, pz, base, t, ed);
  const f = used(), slow = BF.warp && BF.warp.speed === 1 && fps < opt.minFps;
  // at night the villagers sleep and the measure is low: no village joins for the time limit then (Gordon, 2026-10-28), and the day starts a
  // fresh window (villages still join the minimum set when the player comes near)
  // and in the first tenth of the day, while the villagers get up and the load climbs to the day's (Gordon's test4 session, 2026-10-30:
  // villages joined at 68% at 0.08 and the measure was 95% by 0.17; a fixed set took twice the night's time from about 0.1 to 0.5)
  // Once the day's busiest hour is known (peak), joins go by it at any time of day instead.
  const p = peak();
  const night = p == null && (!!(BF.sky && BF.sky.isNight && BF.sky.isNight()) || !!(BF.sky && BF.sky.time < opt.morning));
  if (night) underMs = 0;
  // the measure's share per running village (those let go and still unloading are in the measure too)
  const going = leavingNow(), running = base.size + extras.size + going, share = running ? f / running : 0;
  // what a join is judged by: the measure now, or what the set will need in the busiest hour if that's more (and a village's share then)
  const want = p != null ? Math.max(f, running * p) : f, each = p != null ? Math.max(share, p) : share;
  if (overMs >= opt.win * 1000 && t - lastLoad >= opt.hold * 1000 && extras.size) {
    overMs = 0;
    const after = f - going * share;   // (the measure once those still unloading have gone)
    if (after >= leaveAt()) {   // as many as bring it back to the limit
      const n = share > 0 ? Math.min(ADD_MAX, Math.max(1, Math.ceil((after - opt.budget) / share))) : 1;
      for (const k of farthest(n)) {
        cooling.set(k, t + opt.cool * 1000);
        drop(k, `over budget: the simulation needed ${pct(f)} of each second at 1x for ${opt.win} s, limit ${pct(opt.budget)} (leaving from ${pct(leaveAt())})`);
      }
    }
  } else if (underMs >= opt.win * 1000 && !slow && !night && t - lastLoad >= opt.hold * 1000) {   // (the last ones' cost shown first)
    underMs = 0;
    if (want < joinAt() && want + each <= opt.budget) {
      // room for this many more at the share per village, within the limit (the newcomers' cost shows in the next windows). Both: under
      // the margin, and a village's share still fitting under the limit, which is the one that holds on a small machine, where a village
      // takes more than the margin (Gordon, 2026-10-30)
      const room = each > 0 ? Math.min(ADD_MAX, Math.floor((opt.budget - want) / each)) : ADD_MAX;
      const cand = candidates(px, pz, base, t, ed);
      let added = 0;
      for (const c of cand) {
        if (added >= room) break;
        const keys = VS().footprint(c.v), mb = extraChunks(base, keys) * chunkBytes() / (1024 * 1024);
        if (mb > opt.memMB) { if (!decide.memTold) { decide.memTold = true; note(`No more villages: the extra villages' chunk data would pass ${opt.memMB} MB`); } break; }
        extras.set(c.k, { v: c.v, t, d: c.d }); fp.set(c.k, keys);
        lastLoad = t; added++;
        note(`${vname(c.k)} joins the simulated set, ${Math.round(c.d)} blocks away: the simulation needed ${pct(f)} of each second at 1x for ${opt.win} s` +
          (p != null ? `, ${pct(want)} expected in the day's busiest hour` : "") + `, limit ${pct(opt.budget)} (joining up to ${pct(joinAt())})`, c.k);
      }
    }
  }
  return listed();
}
// the n farthest extras, farthest first (by their distance at this decision)
const farthest = n => [...extras].sort((a, b) => b[1].d - a[1].d || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(e => e[0]);

// The villages that may join, nearest first: searched within a radius just past the farthest extra (at least SEARCH_MIN), widened
// (doubling) while none is found, up to the distance limit or SEARCH_MAX. A search that found nothing out to its end isn't repeated for
// COOL_EMPTY real ms unless the player moved a region's width.
const COOL_EMPTY = 60000;
let emptyAt = null;   // {x, z, t, r}
function candidates(px, pz, base, t, ed) {
  if (emptyAt && t - emptyAt.t < COOL_EMPTY && Math.abs(emptyAt.x - px) < 384 && Math.abs(emptyAt.z - pz) < 384) return [];
  let far = 0;
  for (const x of extras.values()) far = Math.max(far, x.d || 0);
  const end = Math.min(lim(), SEARCH_MAX);
  let r = Math.min(end, Math.max(SEARCH_MIN, far + 600)), cand = [];
  for (;;) {
    let near = [];
    try { near = BF.worldgen.villagesNear(px, pz, r + 200) || []; } catch (e) { near = []; }
    for (const v of near) {
      if (!v || v.minX == null) continue;
      const k = vKey(v);
      if (base.has(k) || extras.has(k) || cooling.has(k)) continue;
      const d = ed(v, px, pz);
      if (d <= Math.min(r, lim())) cand.push({ v, k, d });
    }
    if (cand.length || r >= end) break;
    r = Math.min(end, r * 2);
  }
  if (!cand.length && !emptyAt) note(`No more villages to add within ${Math.round(r)} blocks` + (r >= lim() ? " (the distance limit)" : ""));
  emptyAt = cand.length ? null : { x: px, z: pz, t, r };
  return cand.sort((a, b) => a.d - b.d || (a.k < b.k ? -1 : 1));
}

// set({fixed: n}) (measuring, tools/headless.js --extra n): the n nearest villages within reach on top of the minimum, whatever the time
// they take, so runs and workers compare alike (the budget reads real time); the memory limit still holds.
let fixedAt = null;   // [x, z, n] the fixed set was picked for (the search is wide: done again only when the player moved a chunk)
function fixedSet(px, pz, base, t, ed) {
  if (fixedAt && Math.abs(fixedAt[0] - px) < 16 && Math.abs(fixedAt[1] - pz) < 16 && fixedAt[2] === opt.fixed) { lastN = base.size + extras.size; return [...extras].map(([key, x]) => ({ key, v: x.v })); }
  fixedAt = [px, pz, opt.fixed];
  let near = [];
  try { near = BF.worldgen.villagesNear(px, pz, (opt.reach > 0 ? opt.reach : 4000) + 200) || []; } catch (e) { near = []; }
  const cand = [];
  for (const v of near) {
    if (!v || v.minX == null) continue;
    const k = vKey(v), d = ed(v, px, pz);
    if (!base.has(k) && d <= (opt.reach > 0 ? opt.reach : 4000)) cand.push({ v, k, d });
  }
  cand.sort((a, b) => a.d - b.d || (a.k < b.k ? -1 : 1));
  const want = new Set(cand.slice(0, opt.fixed).map(c => c.k));
  for (const k of [...extras.keys()]) if (!want.has(k)) { extras.delete(k); fp.delete(k); }
  for (const c of cand.slice(0, opt.fixed)) {
    if (extras.has(c.k)) continue;
    const keys = VS().footprint(c.v);
    if (extraChunks(base, keys) * chunkBytes() / (1024 * 1024) > opt.memMB) break;
    extras.set(c.k, { v: c.v, t, d: c.d }); fp.set(c.k, keys);
    note(`${vname(c.k)} joins the simulated set, ${Math.round(c.d)} blocks away (a fixed set of ${opt.fixed})`, c.k);
  }
  lastN = base.size + extras.size;
  return [...extras].map(([key, x]) => ({ key, v: x.v }));
}
// the villages simulated now (villageSim's set, extras counting down included): from the start and with the budget off too, which the last
// decision's figure (lastN, 0 before the first) was not
const simulated = () => (VS() ? VS().count() : lastN);
const text = () => `Distant villages: ${simulated()} simulated${leavingNow() ? ", " + leaving.size + " unloading" : ""} (${!opt.on ? "off" : opt.budget > 0 ? "up to " + pct(opt.budget) + " of each second" : "nearest only"})`;
// "Automatic, up to 80% of each second (automatic), no distance limit, memory 2000 MB (automatic)": the settings in words (the game log, the menu)
function describe(s) {
  s = clean(s);
  if (s.villages === "nearest") return "nearest only";
  return "Automatic (as many as run at 1x, nearest first), up to " + pct(s.share === "auto" ? autoShare() : s.share) + " of each second" + (s.share === "auto" ? " (automatic)" : "") +
    ", " + (s.reach > 0 ? "within " + s.reach + " blocks" : "no distance limit") + ", memory " + (s.mem === "auto" ? autoMem() + " MB (automatic)" : s.mem + " MB");
}
BF.active = {
  BUDGETS, CHOICES, DEFAULT, frame, decide,
  isExtra: key => extras.has(key),
  waitCap: key => (leaving.has(key) && !extras.has(key) ? WAIT_CAP : null), waitWhy: key => leaving.get(key) || null, leaving: () => (leavingNow(), [...leaving.keys()]),
  extras: () => [...extras.keys()],
  peak,
  opts: () => Object.assign({}, opt),
  // tests and the pause menu (a budget chosen there is remembered)
  // (quiet: the page's copy when the simulation is elsewhere; the simulation logs the change)
  // (settings: the player's, as the header; the figures they make are worked out here)
  set(o, quiet) {
    const was = opt.on && opt.budget > 0 ? opt.budget : 0, wasS = JSON.stringify(S);
    if (o.settings) apply(o.settings);
    for (const k in o) if (k in opt) opt[k] = k === "on" ? !!o[k] : +o[k];
    if (!quiet && o.settings && JSON.stringify(S) !== wasS && opt.on) note("Distant villages: " + describe(S));
    else if (("budget" in o || "on" in o) && !quiet) {
      const b = opt.on && opt.budget > 0 ? opt.budget : 0;
      if (b !== was) note(b ? `Simulation budget set to ${pct(b)} of each second` : "Simulation budget off: only the nearest villages are simulated");
    }
    if (o.settings) { decide.memTold = false; emptyAt = null; }
    underMs = overMs = 0;
  },
  settings: () => Object.assign({}, S),
  // the pause menu: a setting changed (remembered here; the page sends it where the simulation is with quiet, js/simhost.js budget)
  choose(field, value, quiet) {
    if (!(field in DEFAULT)) return this.settings();
    return this.adopt(Object.assign({}, S, { [field]: value }), quiet);
  },
  // the pause menu's settings as it closes (js/player.js distantApply): all of them at once, one INFO line when they changed
  adopt(s, quiet) {
    store.set(clean(s));
    this.set({ on: true, settings: s }, quiet);
    return this.settings();
  },
  next(field) { const c = CHOICES[field], i = c.indexOf(S[field]); return c[(i + 1) % c.length]; },
  auto: () => ({ share: autoShare(), memMB: autoMem() }),
  describe,
  text,
  // the debug screen's Simulation budget card
  feed: () => ({ on: opt.on, budget: opt.budget, used: used(), fps: Math.round(fps), villages: simulated(), extra: VS() && VS().extraCount ? VS().extraCount() : extras.size, extras: [...extras].map(([k, x]) => ({ key: k, name: vname(k), d: Math.round(x.d) })),
    under: Math.round(underMs / 1000), over: Math.round(overMs / 1000), memMB: opt.memMB, reach: opt.reach, peak: peak(), settings: Object.assign({}, S), log: decisions.slice(-12) }),
  log: () => decisions.slice(),
  // region workers (js/rplay.js): the leader's whole state for a follower's copy as it boots (opt alone isn't enough: the extras, the
  // measure's windows, the clock it measures by and the villages being let go all decide what happens next, and the automatic figures
  // are the leader's machine's)
  state() {
    return { opt: Object.assign({}, opt), S: Object.assign({}, S), extras: [...extras].map(([k, x]) => [k, { v: x.v, t: x.t, d: x.d }]), cooling: [...cooling], leaving: [...leaving],
      lastLoad, lastN, slices: slices.map(x => Object.assign({}, x)), slice: Object.assign({}, slice), underMs, overMs, fps, lastClock, fixedAt, emptyAt, memTold: !!decide.memTold,
      hours: [...hours].map(([k, b]) => [k, Object.assign({}, b)]) };
  },
  load(s) {
    if (!s || !s.opt) return;
    Object.assign(opt, s.opt); S = Object.assign({}, s.S);
    extras.clear(); fp.clear(); for (const [k, x] of s.extras || []) extras.set(k, Object.assign({}, x));
    cooling.clear(); for (const [k, u] of s.cooling || []) cooling.set(k, u);
    leaving.clear(); for (const [k, w] of s.leaving || []) leaving.set(k, w);
    lastLoad = s.lastLoad; lastN = s.lastN; slices = (s.slices || []).map(x => Object.assign({}, x)); slice = Object.assign({}, s.slice);
    underMs = s.underMs; overMs = s.overMs; fps = s.fps; lastClock = s.lastClock; fixedAt = s.fixedAt; emptyAt = s.emptyAt; decide.memTold = !!s.memTold;
    hours = new Map((s.hours || []).map(([k, b]) => [k, Object.assign({}, b)]));
  },
  reset() { leaving.clear(); fixedAt = null; emptyAt = null; lastClock = null; extras.clear(); fp.clear(); cooling.clear(); decisions.length = 0; underMs = overMs = 0; lastLoad = -1e12; lastN = 0; slices = []; slice = { sim: 0, real: 0, game: 0, frames: 0 }; fps = 60; decide.memTold = false; hours = new Map(); },
};
})();
