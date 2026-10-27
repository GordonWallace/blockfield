// The debug screen's fast-forward controls (debug/index.html loads this file): the game's speed as asked and as reached, the same as the
// game's own indicator ("▶▶ 1000x (14.8x)", "❚❚ 0x (frozen)"), with a button for each speed and ◀ / ▶ to step it. The Left and Right
// arrow keys step it as they do in the game (Right from 0x goes to 1x, Left from 1x freezes at 0x), except while a text field or a
// dropdown has the focus. Each step goes to the debug server (POST /warp), which passes it to the game with its answer to the game's next
// snapshot (js/debugfeed.js); the game's clock steps and sends the speed on to the simulation wherever it runs (page, worker or world server).
// The speed shown comes from GET /warp, the game's latest snapshot, polled 4 times a second.
(() => {
"use strict";
const SPEEDS = [0, 1, 3, 5, 10, 100, 1000];   // js/timewarp.js SPEEDS, with 0x (frozen) below 1x
const st = document.createElement("style");
st.textContent = `
  #h-warp { display: none !important; }   /* (the target-only badge: this bar shows it, with the speed reached) */
  .ffbar { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .ffbar button { background: transparent; border: 1px solid var(--edge2); border-radius: 5px; padding: 2px 7px; font: 12px var(--mono); color: var(--muted); cursor: pointer; }
  .ffbar button:hover { color: var(--ink); border-color: var(--accent); }
  .ffbar button.on { color: #10140f; background: var(--warn); border-color: var(--warn); font-weight: 600; }
  .ffbar.off button { opacity: 0.45; }
  .ffbar .ffnow { min-width: 128px; margin-left: 4px; color: var(--ink); }
  .ffbar .ffnow.slow { color: var(--warn); } .ffbar .ffnow.frozen { color: var(--info); }`;
document.head.appendChild(st);

const bar = document.createElement("div");
bar.className = "ffbar off";
bar.id = "ff";
bar.title = "Fast-forward: Left / Right arrow keys step it, as in the game. The speed asked for, and in brackets the speed the simulation reaches when it falls short";
bar.innerHTML = `<button data-op="slower" title="Slower (Left arrow)">◀</button>` +
  SPEEDS.map(v => `<button data-speed="${v}">${v}x</button>`).join("") +
  `<button data-op="faster" title="Faster (Right arrow)">▶</button><span class="ffnow" id="ff-now">-</span>`;
const anchor = document.getElementById("h-warp");
if (anchor) anchor.after(bar); else (document.querySelector("header") || document.body).appendChild(bar);
const now = bar.querySelector("#ff-now");

let ff = null, want = null, wantAt = 0;   // want: a speed just asked for by a button, shown until the game has it (or 2 s pass)
function render() {
  bar.classList.toggle("off", !ff);
  const sp = want != null && Date.now() - wantAt < 2000 ? want : ff ? ff.speed : null;
  for (const b of bar.querySelectorAll("[data-speed]")) b.classList.toggle("on", sp != null && +b.dataset.speed === sp);
  now.classList.remove("slow", "frozen");
  if (!ff) { now.textContent = "no game"; return; }
  if (ff.speed === 0) { now.textContent = "❚❚ 0x (frozen)"; now.classList.add("frozen"); return; }
  // as the game's indicator: the speed reached in brackets when it is under 90% of the speed asked for
  const slow = ff.speed > 1 && ff.real < ff.speed * 0.9;
  now.textContent = "▶▶ " + ff.speed + "x" + (slow ? " (" + (ff.real < 10 ? ff.real.toFixed(1) : Math.round(ff.real)) + "x)" : "");
  if (slow) now.classList.add("slow");
}
function poll() {
  fetch("warp", { cache: "no-store" }).then(r => r.json()).then(o => {
    ff = o && o.ff && o.age != null && o.age < 5000 ? o.ff : null;   // (no snapshot for 5 s: no game to control)
    if (ff && want != null && ff.speed === want) want = null;
    render();
  }).catch(() => { ff = null; render(); }).finally(() => setTimeout(poll, 250));
}

function step(o) {
  if (o.op === "set") { want = o.speed; wantAt = Date.now(); render(); }
  fetch("warp", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(o) }).catch(() => { want = null; render(); });
}
bar.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  step(b.dataset.op ? { op: b.dataset.op } : { op: "set", speed: +b.dataset.speed });
  b.blur();
});
addEventListener("keydown", e => {
  if ((e.code !== "ArrowLeft" && e.code !== "ArrowRight") || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target;   // typing in a field, or choosing in a dropdown: the keys are theirs
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  e.preventDefault();
  step({ op: e.code === "ArrowRight" ? "faster" : "slower" });
});
render();
poll();
})();
