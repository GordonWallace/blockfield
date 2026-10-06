// Fast-forward. Press F to cycle the simulation speed 1x -> 2x -> 3x -> 5x -> 10x -> 1x.
// The game loop (main.js) runs its whole simulation step BF.warp.speed times per frame instead of scaling dt, so
// the day/night cycle, mobs, villagers, crops, weather and animations all stay consistent, like a sped-up recording.
// BF.simNow() is the simulation clock in seconds: it advances only by simulated steps (not while paused), and every
// cooldown / scan timer in the sim modules reads it instead of performance.now(), so they speed up with everything else.
// API: BF.warp = { speed, steps(), advance(dt), done(n), last, reset(), set(i), cycle(), BUDGET_MS, SPEEDS }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SPEEDS = [1, 2, 3, 5, 10];
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
  get last() { return last; },         // sim steps run in the latest frame
  steps() { return SPEEDS[idx]; },
  advance(dt) { clock += dt; },
  done(n) {
    last = n;
    eff = idx === 0 ? 1 : eff + (n - eff) * 0.2;   // smoothed steps per frame = achieved speed
    const key = idx + ":" + Math.round(eff * 10);
    if (key !== shown) { shown = key; show(); }
  },
  set(i) { idx = Math.max(0, Math.min(SPEEDS.length - 1, i | 0)); eff = SPEEDS[idx]; last = 1; shown = null; show(); },
  cycle() { this.set((idx + 1) % SPEEDS.length); },
  reset() { this.set(0); },
};

addEventListener("keydown", e => {
  if (e.code !== "KeyF" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
  if (BF.state && BF.state.paused) return;   // menus, inventory, chat, death screen
  BF.warp.cycle();
});
if (document.body) ui(); else addEventListener("DOMContentLoaded", ui);
})();
