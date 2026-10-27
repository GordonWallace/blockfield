// Fast-forward. Right arrow steps the simulation speed up (0x -> 1x -> 3x -> 5x -> 10x -> 100x -> 1000x), Left arrow steps it down; both stop at the ends. (F no longer does anything.)
// 0x (Left at 1x, or an alert from the debug screen: js/alerts.js) freezes the world: no simulation steps run at all, so mobs,
// villagers, crops, furnaces, the sky and water all stand still, while the player still moves, looks around and can teleport.
// Right from 0x always goes back to 1x, whatever speed the game ran at before.
// Fixed tick (spec r15-10): the world simulation always runs in ticks of TICK = 0.05 s of game time, 20 a second at 1x, at every
// speed and every frame rate, so the sim behaves the same at 1x and 1000x, at 30 fps and 144 fps. An accumulator collects
// real seconds x speed each frame (a frame counts at most MAX_FRAME real seconds, so a hitch doesn't cause a burst of ticks) and
// the game loop (main.js) runs the whole ticks it holds, within BUDGET_MS; the fraction left carries to the next frame, and whole
// ticks the budget (or MAX_STEPS) couldn't fit are dropped, which the indicator shows as the achieved speed. 0x runs none.
// Drawing interpolates between the last two ticks: alpha (0..1) is the accumulator's fraction of a tick, and mobs, drops, boats,
// arrows and bees are drawn at lerp(prev, cur, alpha); the sky and water use renderNow(), the game time being drawn.
// The player is not stepped: it keeps normal speed (one update per frame) so you can still move around and observe.
// BF.simNow() is the simulation clock in seconds: it advances only by simulated ticks (not while paused), and every
// cooldown / scan timer in the sim modules reads it instead of performance.now(), so they speed up with everything else.
// API: BF.warp = { speed, frozen, TICK, plan(dt) -> {n, h}, advance(h), done(n, simSec, dt, achieved?), alpha, renderNow(), last, achieved, dropped, reset(), set(i),
// freeze(), cycle(), faster(), slower(), BUDGET_MS, MAX_FRAME, SPEEDS, clock }. advance(h) moves the clock only (tests step it by hand).
// set(i) takes an index into SPEEDS (0 = 1x); speed reads 0 while frozen.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const SPEEDS = [1, 3, 5, 10, 100, 1000];
// Tick length (idea-049 prototype): 0.05 s unless asked otherwise, by ?tick= in the address, BF_TICK in Node's environment or
// globalThis.BF_TICK before this file loads (0.01 to 1 s). Read once at load: the sim modules size their tick counts from it.
const TICK = (() => {
  const g = globalThis;
  let v = g.BF_TICK;
  if (v == null && g.process && g.process.env) v = g.process.env.BF_TICK;
  if (v == null && g.location && g.location.search) try { v = new URLSearchParams(g.location.search).get("tick"); } catch (_) { /* none */ }
  const t = +v;
  return v != null && t >= 0.01 && t <= 1 ? t : 0.05;
})();
const MAX_STEPS = 1000, MAX_FRAME = 0.25;   // never more than 1000 ticks in a frame; a frame counts at most 0.25 real s
let idx = 0, clock = 0, eff = 1, last = 1, shown = null, frozen = false;
let acc = 0, acc0 = 0, planned = 0;   // game seconds collected but not yet ticked (and before the latest plan()); ticks that plan() asked for

BF.simNow = () => clock;

// Indicator (hidden at 1x).
let el = null;
function ui() {
  if (el || !BF.page || !document.body) return el;   // (headless: no badge)
  el = document.createElement("div");
  el.id = "warp";
  el.hidden = true;
  el.style.cssText = "position:fixed;top:10px;right:12px;z-index:30;padding:3px 9px;border-radius:4px;background:rgba(0,0,0,.55);" +
    "color:#fff;font:600 15px 'Courier New',monospace;letter-spacing:1px;pointer-events:none;text-shadow:1px 1px 0 #000;";
  document.body.appendChild(el);
  return el;
}
function show() {
  const e = ui();
  if (!e) return;
  if (frozen) { e.hidden = false; e.textContent = "❚❚ 0× (frozen)"; return; }
  const s = SPEEDS[idx];
  e.hidden = s === 1;
  if (s === 1) return;
  // when the frame can't fit all the steps, also show the speed actually achieved
  const slow = eff < s * 0.9;
  e.textContent = "▶▶ " + s + "×" + (slow ? " (" + (eff < 10 ? eff.toFixed(1) : Math.round(eff)) + "×)" : "");
}

// Game log (js/gamelog.js): up to 10x the sim should keep up, so ticks dropped there (the frame budget ran out) are a WARN,
// summed over a minute of real time and logged at most once a minute. Above 10x dropping is expected and the indicator shows the
// speed achieved.
let lost = 0, lostSec = 0, lostSince = 0, droppedAll = 0;   // (droppedAll: every tick dropped this session, BF.warp.dropped)
function noteDropped(n) {
  const now = performance.now();
  if (n > 0) droppedAll += n;
  if (n > 0 && SPEEDS[idx] <= 10 && !frozen) { if (!lost) lostSince = now; lost += n; lostSec += n * TICK; }
  if (lost && now - lostSince >= 60000 && BF.glog) {
    BF.glog.log("WARN", "tick", "The simulation fell behind: " + lost + " ticks (" + lostSec.toFixed(2) + " s of game time) dropped in the last minute");
    lost = 0; lostSec = 0;
  }
}

BF.warp = {
  SPEEDS,
  BUDGET_MS: 40,                       // max simulation time per frame; the speed degrades gracefully past this
  get speed() { return frozen ? 0 : SPEEDS[idx]; },
  get frozen() { return frozen; },
  get achieved() { return frozen ? 0 : eff; },   // the speed actually reached, smoothed: what the indicator shows in brackets when it falls short
  get last() { return last; },         // achieved speed in the latest frame (game seconds simulated / real seconds)
  get dropped() { return droppedAll; },   // ticks dropped so far this session (the frame budget or MAX_STEPS couldn't fit them)
  TICK, MAX_FRAME,
  // Ticks for a frame of real length dt (seconds, capped at MAX_FRAME): n ticks of TICK, the whole ticks in the accumulator.
  plan(dt) {
    acc0 = acc;
    if (frozen) { planned = 0; return { n: 0, h: TICK }; }
    acc += Math.min(MAX_FRAME, Math.max(0, dt)) * SPEEDS[idx];
    planned = Math.min(MAX_STEPS, Math.floor(acc / TICK + 1e-9));
    return { n: planned, h: TICK };
  },
  advance(dt) { clock += dt; },
  get clock() { return clock; }, set clock(c) { clock = c; },   // (clusters, js/ctick.js: each cluster runs the interval's ticks on its own clock)
  // After the frame's ticks: n ran. The ticks it ran leave the accumulator; whole ticks it couldn't fit (the budget, MAX_STEPS, a
  // freeze mid-frame) are dropped, so only the fraction of a tick carries on.
  // ach: the speed achieved, when the simulation runs elsewhere (a worker, r15-38: the page's clock only keeps time for drawing)
  done(n, simSec, dt, ach) {
    const run = Math.max(0, n | 0);
    acc -= run * TICK;
    if (acc >= TICK) acc %= TICK;
    if (acc < 0) acc = 0;
    noteDropped(planned - run);
    dt = Math.min(MAX_FRAME, dt);
    last = ach != null ? ach : dt > 0 ? Math.max(0, run * TICK + acc - acc0) / dt : 1;   // the speed this frame achieved: game seconds simulated (and carried) per real second
    eff = frozen ? 0 : idx === 0 ? 1 : eff + (last - eff) * 0.2;   // smoothed game seconds per real second = achieved speed
    const key = (frozen ? "f" : idx) + ":" + Math.round(eff * 10);
    if (key !== shown) { shown = key; show(); }
  },
  // How far drawing is between the last tick and the next one (0..1): mobs and the rest are drawn at lerp(prev, cur, alpha).
  get alpha() { return Math.max(0, Math.min(1, acc / TICK)); },
  // The game time being drawn: one tick behind the clock, plus the accumulator (so it moves smoothly every frame).
  renderNow() { return clock - TICK + Math.min(acc, TICK); },
  set(i) { const was = frozen; frozen = false; acc = Math.min(acc, TICK); idx = Math.max(0, Math.min(SPEEDS.length - 1, i | 0)); eff = SPEEDS[idx]; last = 1; shown = null; show(); if (was) BF.emit && BF.emit("warpResume"); },
  freeze() { if (frozen) return; frozen = true; idx = 0; eff = 0; last = 0; shown = null; show(); },   // 0x; set()/faster() resume at that speed
  cycle() { this.set((idx + 1) % SPEEDS.length); },
  faster() { this.set(frozen ? 0 : Math.min(SPEEDS.length - 1, idx + 1)); },   // Right arrow: one step up (0x goes to 1x), stops at 1000x
  slower() { if (idx === 0) this.freeze(); else this.set(idx - 1); },           // Left arrow: one step down, 1x goes to 0x
  reset() { this.set(0); },
};

if (BF.page) addEventListener("keydown", e => {
  if ((e.code !== "ArrowLeft" && e.code !== "ArrowRight") || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
  if (BF.state && BF.state.paused) return;   // menus, inventory, chat, death screen
  if (BF.player && BF.player.menu && BF.player.menu()) return;   // the title screen (not paused, but no game yet)
  e.preventDefault();
  if (e.code === "ArrowRight") BF.warp.faster(); else BF.warp.slower();
});
if (!BF.page) { /* headless: no speed badge */ } else if (document.body) ui(); else addEventListener("DOMContentLoaded", ui);
})();
