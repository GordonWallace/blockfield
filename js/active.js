// Active simulation set chosen by budget (spec r15-34). The village-loading rule in js/villagesim.js (the nearest 4 within 200 blocks,
// always within 100, trips' villages) is the guaranteed minimum; on top of it this keeps "extra" villages simulated while the machine
// has time to spare: the simulation may use up to `budget` of each real second (default 40%, the pause menu's "Simulated villages").
//  - Measuring: main.js simFrame reports each frame's simulation ms and real length (frame()); a frame at 0x or paused doesn't count.
//    This is the same time the villager-seconds meter (js/perf.js) charges to the steps, measured once a frame so it costs nothing extra
//    and runs whether or not the meter is on.
//  - Under budget for WIN real seconds (and, at 1x, at least MIN_FPS frames a second): the next nearest village not yet simulated, within
//    REACH blocks of the player, joins the set, if the time it is expected to take still fits (the current share per running village)
//    and its chunk data fits the memory budget (memMB of section arrays for the extras). It loads through the normal path: villageSim adds
//    it to the kept set, world.update generates its chunks, the villagers come out as they do for any village.
//  - Over budget for WIN seconds, and no load in the last HOLD seconds: the farthest extra leaves the set, and villageSim unloads it with the
//    unload countdown (its villagers finish their tasks first, as for any village the player walks away from). It isn't picked again
//    for COOL seconds.
//  - An extra past REACH (the player went away) leaves the same way; one that became part of the minimum stops being an extra.
// Where the simulation runs in a worker or on the world server (bug-081), the page's copy holds the setting (localStorage, ?budget=,
// off in automated browsers) and sends it there ({budget: {on, budget}}, js/simhost.js budget), where the decisions are made and logged;
// the pause menu's line asks the simulation for its text (the protocol's budget query).
// Real time decides here on purpose: what the machine can afford. So that the tests and the determinism checks see the distance rule,
// automated browsers start with it off (BF.active.set({ on: true }) or ?budget=N turns it on).
// API: BF.active = { frame(simMs, raw), decide(px, pz, base) -> [{key, v}], isExtra(key), extras(), set({on, budget, memMB, win, hold,
//                    cool, reach, minFps}, quiet), opts(), cycle(quiet) -> {on, budget}, text(), feed(), log(), reset(), BUDGETS }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const BUDGETS = [0, 0.2, 0.4, 0.6, 0.8];   // the pause menu's choices (0: the minimum rule only)
const opt = { on: true, budget: 0.4, memMB: 500, win: 10, hold: 60, cool: 300, reach: 1000, minFps: 30, fixed: 0 };   // fixed: see decide
const store = {
  get() { try { return localStorage.getItem("blockfield.simBudget"); } catch (_) { return null; } },
  set(v) { try { localStorage.setItem("blockfield.simBudget", String(v)); } catch (_) {} },
};
{
  const s = parseFloat(store.get());
  if (s >= 0 && s <= 1) opt.budget = s;
  if (typeof navigator === "undefined" || navigator.webdriver) opt.on = false;   // tests and the headless boot (no navigator, r15-40): the distance rule, unless they turn it on
  const q = typeof location !== "undefined" && /(?:^|[?&])budget=(\d+)/.exec(location.search.slice(1));
  if (q) { opt.on = true; opt.budget = Math.min(10, +q[1] / 100); }
}

const now = () => BF.rworkers.realNow();   // (the wall clock; with region workers the leader's reading, so every worker decides alike: js/rworkers.js)
// ---- the measure: 1-second slices of real time that ran (not 0x, not paused), the last 10 kept for the figures shown
let slice = { sim: 0, real: 0, frames: 0 }, slices = [], underMs = 0, overMs = 0, fps = 60;
function frame(simMs, raw) {
  if (BF.warp && BF.warp.frozen) return;
  slice.sim += simMs; slice.real += Math.min(250, raw * 1000); slice.frames++;
  if (slice.real < 1000) return;
  const frac = slice.sim / slice.real;
  fps = slice.frames * 1000 / slice.real;
  slices.push({ frac, fps }); if (slices.length > 10) slices.shift();
  if (frac < opt.budget) { underMs += slice.real; overMs = 0; } else { overMs += slice.real; underMs = 0; }
  slice = { sim: 0, real: 0, frames: 0 };
}
const used = () => slices.length ? slices.reduce((s, x) => s + x.frac, 0) / slices.length : 0;

// ---- the extras
const extras = new Map();      // village key -> { v, t (real ms when it joined), d (edge distance at the last decision) }
const cooling = new Map();     // village key -> real ms until it may be picked again (it left for the budget)
const decisions = [];          // newest last: { day, text }
let lastLoad = -1e12, lastN = 0;
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
function drop(key, why) {
  const x = extras.get(key);
  if (!x) return;
  extras.delete(key); fp.delete(key);
  note(`${vname(key)} leaves the simulated set (${why}): it unloads once its villagers' tasks are done`, key);
}

// Called by villageSim's re-check (js/villagesim.js check) with the minimum set it has built (Map key -> {v, keys}). Returns the extras
// to simulate on top of it.
function decide(px, pz, base) {
  const t = now(), ed = VS()._edgeDist;
  for (const [k, until] of cooling) if (t >= until) cooling.delete(k);
  if (!opt.on || !(opt.budget > 0)) { for (const k of [...extras.keys()]) drop(k, opt.on ? "budget set to the minimum" : "budget turned off"); return []; }
  for (const [k, x] of [...extras]) {
    if (base.has(k)) { extras.delete(k); fp.delete(k); continue; }   // part of the minimum now: nothing extra about it
    x.d = ed(x.v, px, pz);
    if (x.d > opt.reach) drop(k, `over ${opt.reach} blocks away`);
  }
  if (opt.fixed > 0) return fixedSet(px, pz, base, t, ed);
  const f = used(), slow = BF.warp && BF.warp.speed === 1 && fps < opt.minFps;
  if (overMs >= opt.win * 1000 && t - lastLoad >= opt.hold * 1000 && extras.size) {
    let far = null;
    for (const [k, x] of extras) if (!far || x.d > far[1].d) far = [k, x];
    overMs = 0;
    cooling.set(far[0], t + opt.cool * 1000);
    drop(far[0], `over budget: the simulation used ${pct(f)} of each second for ${opt.win} s, budget ${pct(opt.budget)}`);
  } else if (underMs >= opt.win * 1000 && !slow) {
    underMs = 0;
    const running = base.size + extras.size, share = running ? f / running : 0;
    if (f + share <= opt.budget) {
      let near = [];
      try { near = BF.worldgen.villagesNear(px, pz, opt.reach + 200) || []; } catch (e) { near = []; }
      const cand = [];
      for (const v of near) {
        if (!v || v.minX == null) continue;
        const k = vKey(v);
        if (base.has(k) || extras.has(k) || cooling.has(k)) continue;
        const d = ed(v, px, pz);
        if (d <= opt.reach) cand.push({ v, k, d });
      }
      cand.sort((a, b) => a.d - b.d);
      const c = cand[0];
      if (c) {
        const keys = VS().footprint(c.v), mb = extraChunks(base, keys) * chunkBytes() / (1024 * 1024);
        if (mb <= opt.memMB) {
          extras.set(c.k, { v: c.v, t, d: c.d }); fp.set(c.k, keys);
          lastLoad = t;
          note(`${vname(c.k)} joins the simulated set, ${Math.round(c.d)} blocks away: the simulation used ${pct(f)} of each second for ${opt.win} s, budget ${pct(opt.budget)}`, c.k);
        } else if (!decide.memTold) { decide.memTold = true; note(`No more villages: the extra villages' chunk data would pass ${opt.memMB} MB`); }
      }
    }
  }
  lastN = base.size + extras.size;
  return [...extras].map(([key, x]) => ({ key, v: x.v }));
}

// set({fixed: n}) (measuring, tools/headless.js --extra n): the n nearest villages within reach on top of the minimum, whatever the time
// they take, so runs and workers compare alike (the budget reads real time); the memory limit still holds.
let fixedAt = null;   // [x, z, n] the fixed set was picked for (the search is wide: done again only when the player moved a chunk)
function fixedSet(px, pz, base, t, ed) {
  if (fixedAt && Math.abs(fixedAt[0] - px) < 16 && Math.abs(fixedAt[1] - pz) < 16 && fixedAt[2] === opt.fixed) { lastN = base.size + extras.size; return [...extras].map(([key, x]) => ({ key, v: x.v })); }
  fixedAt = [px, pz, opt.fixed];
  let near = [];
  try { near = BF.worldgen.villagesNear(px, pz, opt.reach + 200) || []; } catch (e) { near = []; }
  const cand = [];
  for (const v of near) {
    if (!v || v.minX == null) continue;
    const k = vKey(v), d = ed(v, px, pz);
    if (!base.has(k) && d <= opt.reach) cand.push({ v, k, d });
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
const text = () => `Simulated villages: ${simulated()} (budget ${opt.on && opt.budget > 0 ? pct(opt.budget) : "off"})`;
BF.active = {
  BUDGETS, frame, decide,
  isExtra: key => extras.has(key),
  extras: () => [...extras.keys()],
  opts: () => Object.assign({}, opt),
  // tests and the pause menu (a budget chosen there is remembered)
  // (quiet: the page's copy when the simulation is elsewhere; the simulation logs the change)
  set(o, quiet) {
    const was = opt.on && opt.budget > 0 ? opt.budget : 0;
    for (const k in o) if (k in opt) opt[k] = k === "on" ? !!o[k] : +o[k];
    if (("budget" in o || "on" in o) && !quiet) {
      const b = opt.on && opt.budget > 0 ? opt.budget : 0;
      if (b !== was) note(b ? `Simulation budget set to ${pct(b)} of each second` : "Simulation budget off: only the nearest villages are simulated");
    }
    underMs = overMs = 0;
  },
  cycle(quiet) {
    const cur = opt.on ? opt.budget : 0, i = BUDGETS.findIndex(b => Math.abs(b - cur) < 1e-6), b = BUDGETS[(i + 1) % BUDGETS.length];
    this.set({ on: true, budget: b }, quiet);
    store.set(b);
    return { on: true, budget: b };
  },
  text,
  // the debug screen's Simulation budget card
  feed: () => ({ on: opt.on, budget: opt.budget, used: used(), fps: Math.round(fps), villages: simulated(), extra: VS() && VS().extraCount ? VS().extraCount() : extras.size, extras: [...extras].map(([k, x]) => ({ key: k, name: vname(k), d: Math.round(x.d) })),
    under: Math.round(underMs / 1000), over: Math.round(overMs / 1000), memMB: opt.memMB, log: decisions.slice(-12) }),
  log: () => decisions.slice(),
  reset() { fixedAt = null; extras.clear(); fp.clear(); cooling.clear(); decisions.length = 0; underMs = overMs = 0; lastLoad = -1e12; lastN = 0; slices = []; slice = { sim: 0, real: 0, frames: 0 }; fps = 60; decide.memTold = false; },
};
})();
