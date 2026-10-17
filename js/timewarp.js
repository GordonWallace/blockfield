// Fast-forward. Right arrow steps the simulation speed up (1x -> 3x -> 5x -> 10x -> 100x -> 1000x), Left arrow steps it down; both stop at the ends. (F no longer does anything.)
// The game loop (main.js) runs its whole simulation step BF.warp.speed times per frame instead of scaling dt, so
// the day/night cycle, mobs, villagers, crops, weather and animations all stay consistent, like a sped-up recording.
// The player is not stepped: it keeps normal speed so you can still move around and observe.
// BF.simNow() is the simulation clock in seconds: it advances only by simulated steps (not while paused), and every
// cooldown / scan timer in the sim modules reads it instead of performance.now(), so they speed up with everything else.
// API: BF.warp = { speed, plan(dt) -> {n, h}, advance(h), done(n, simSec, dt), last, reset(), set(i), cycle(), faster(), slower(), BUDGET_MS, SPEEDS }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SPEEDS = [1, 3, 5, 10, 100, 1000];
const MAX_STEP = 0.05, MAX_STEPS = 1000;   // from 100x one step covers up to 0.05 s of game time; never more than 1000 steps in a frame
let idx = 0, clock = 0, eff = 1, last = 1, shown = null;

BF.simNow = () => clock;

// Indicator (hidden at 1x).
let el = null;
function ui() {
  if (el || !document.body) return el;
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
  const s = SPEEDS[idx];
  e.hidden = s === 1;
  if (s === 1) return;
  // when the frame can't fit all the steps, also show the speed actually achieved
  const slow = eff < s * 0.9;
  e.textContent = "▶▶ " + s + "×" + (slow ? " (" + (eff < 10 ? eff.toFixed(1) : Math.round(eff)) + "×)" : "");
}

BF.warp = {
  SPEEDS,
  BUDGET_MS: 40,                       // max simulation time per frame; the speed degrades gracefully past this
  get speed() { return SPEEDS[idx]; },
  get last() { return last; },         // achieved speed in the latest frame (game seconds simulated / real seconds)
  // Steps for a frame of real length dt: n steps of length h. Up to 10x that's `speed` steps of dt; above, as few steps as keep h <= MAX_STEP.
  plan(dt) {
    const sp = SPEEDS[idx];
    if (sp <= 10) return { n: sp, h: dt };
    const S = sp * dt, n = Math.min(MAX_STEPS, Math.max(1, Math.ceil(S / MAX_STEP)));
    return { n, h: Math.min(MAX_STEP, S / n) };   // past the cap the frame simulates less than S and the indicator shows the shortfall
  },
  advance(dt) { clock += dt; },
  done(n, simSec, dt) {
    last = dt > 0 ? simSec / dt : 1;
    eff = idx === 0 ? 1 : eff + (last - eff) * 0.2;   // smoothed game seconds per real second = achieved speed
    const key = idx + ":" + Math.round(eff * 10);
    if (key !== shown) { shown = key; show(); }
  },
  set(i) { idx = Math.max(0, Math.min(SPEEDS.length - 1, i | 0)); eff = SPEEDS[idx]; last = 1; shown = null; show(); },
  cycle() { this.set((idx + 1) % SPEEDS.length); },
  faster() { this.set(Math.min(SPEEDS.length - 1, idx + 1)); },   // Right arrow: one step up, stops at 1000x
  slower() { this.set(Math.max(0, idx - 1)); },                    // Left arrow: one step down, stops at 1x
  reset() { this.set(0); },
};

addEventListener("keydown", e => {
  if ((e.code !== "ArrowLeft" && e.code !== "ArrowRight") || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
  if (BF.state && BF.state.paused) return;   // menus, inventory, chat, death screen
  if (BF.player && BF.player.menu && BF.player.menu()) return;   // the title screen (not paused, but no game yet)
  e.preventDefault();
  if (e.code === "ArrowRight") BF.warp.faster(); else BF.warp.slower();
});
if (document.body) ui(); else addEventListener("DOMContentLoaded", ui);
})();
