// @ci baseline suite=world,village
// No wall-clock time in simulation decisions (spec r15-16). Plain node, no browser: node test/wallclock-lint.js
// Every performance.now() / Date.now() in js/ must be on the list below: a file that never touches the simulation (UI, drawing, audio,
// saving, the debug feed, world generation at boot), or, in a file that does, one of the listed functions or lines (a profiling measure, a streaming or
// drawing budget, the 0x fallback). Anything else is a simulation decision on real time and should use BF.simNow() (game seconds, which
// advance only by simulated steps) or a count of work done instead. The test also fails on a listed line that no longer exists, so the
// list stays true.
const fs = require("fs"), path = require("path");
const JS = path.join(__dirname, "..", "js");

// Whole files: nothing in them decides what happens in the simulation.
const FILES = {
  "active.js": "the simulation budget (spec r15-34): which villages beyond the minimum rule run is chosen by the machine's spare real time on purpose; off in automated browsers, so tests and determinism checks see the distance rule",
  "audio.js": "sound",
  "commands.js": "chat lines fading out",
  "cracks.js": "block-breaking crack animation",
  "debugfeed.js": "the debug screen feed",
  "debugoverlay.js": "the F3 overlay's fps counter (spec r15-37 moved it out of main.js)",
  "gamelog.js": "log timestamps",
  "globe.js": "globe drawing stats",
  "grid.js": "distant terrain sampling (drawing only)",
  "invscreen.js": "inventory screens: tooltips, click guard, the furnace's progress between answers, slow-answer timing",
  "lod.js": "distant terrain (drawing only)",
  "lodworker.js": "distant terrain worker (drawing only)",
  "maps.js": "held map arrow spinning",
  "mesher.js": "chunk meshing (r15-03, drawing only)",
  "meshworker.js": "chunk meshing worker (r15-03, drawing only)",
  "mapview.js": "the player's map view and auto-map fill (drawing; explorers' maps are js/maps.js, filled by walking)",
  "planetgen.js": "world generation timing stats",
  "perf.js": "the villager-seconds meter (spec r15-01): measures how long steps take, decides nothing",
  "planetrivers.js": "river solve timing stats",
  "protocol.js": "the simulation/client protocol's bytes per real second (spec r15-36): statistics, decides nothing",
  "player.js": "input: Escape grace, touch taps, the player runs in real time",
  "save.js": "save metadata (last played, last saved), how long a save took (logged), and new world and imported world ids",
  "signs.js": "sign editor caret blink",
  "simhost.js": "the page's side of the simulation worker (spec r15-38): how long the worker took to start, logged; it runs no simulation",
  "simworker.js": "the simulation worker's loop (spec r15-38): the real time between loops, which the fixed ticks turn into steps within BUDGET_MS as js/main.js frame dt does in the page (how fast the game runs, not what happens), and load times, logged",
  "villagepanel.js": "the F3 village panel's redraw (spec r15-37 moved it out of villagelog.js)",
  "statehash.js": "how long hashing the world took (debug screen)",
};
// Whole functions in files that also hold simulation code: [file, function, why]. The function is the nearest declaration above the line that
// starts at column 0 (`function name(` or `name = function`), so a new timing line inside a drawing function needs no new entry.
const FUNCS = [
  ["world.js", "plan", "chunk streaming re-plan (drawing; villagers wait for unloaded chunks)"],
  ["world.js", "world.update", "chunk streaming, generation and meshing budgets: what is drawn and when chunk data arrives, never what villagers do (they wait for unloaded chunks)"],
  ["world.js", "remeshDirty", "fast-forward remesh batching (r15-02): when chunks are redrawn, and its stats"],
  ["world.js", "ffTrack", "remesh batching stats (r15-02)"],
  ["world.js", "buildMesh", "chunk meshing: when a chunk was last drawn, mesh timing"],
  ["world.js", "pump", "mesh worker pool (r15-03): hands chunks to workers, timing stats"],
  ["ctick.js", "meet", "cluster meeting timing for the debug screen and stats (r15-39b): measures, decides nothing"],
  ["ctick.js", "pass", "ms per cluster group for the debug screen and stats (r15-39b; C7 plans owners from it, which changes who runs a group, never what happens)"],
  ["furnaceuse.js", "offersFor", "BF.debug.checkOffers timing of the offer table vs the full scan (r15-04, debug only; the answer returned doesn't depend on it)"],
];
// Single lines in files that also hold simulation code: [file, text on the line, why it is allowed]
const LINES = [
  ["cworkers.js", "const now = () => performance.now();", "cluster workers' timing (r15-39b C7): stats, and the plan of which worker runs which group, never what happens in it"],
  ["main.js", "const t0 = performance.now();\n      let f = 0;", "boot: the river solve runs in slices until done, before the game starts"],
  ["main.js", "while (f < 1 && performance.now() - t0 < 60)", "boot: the river solve slices (above)"],
  ["main.js", "let last = performance.now();", "frame dt (the player and drawing)"],
  ["requests.js", "const clock = () => (globalThis.performance ? performance.now() : Date.now());", "ms per tick phase for the debug screen and the region-tick log line (spec r15-33): measures, decides nothing"],
  ["boot.js", "const W = BF.warp, plan = W.plan(raw), t0 = performance.now(),", "ticks per frame within BUDGET_MS: how fast the game runs, not what happens"],
  ["boot.js", "const t0 = performance.now();\n  BF.world.setViewDist", "the headless boot's own timing, logged (r15-40)"],
  ["boot.js", "chunks + \" chunks loaded in \" + ((performance.now() - t0) / 1000).toFixed(1)", "the headless boot's own timing (above)"],
  ["timewarp.js", "const now = performance.now();\n  if (n > 0) droppedAll += n;", "the dropped-ticks WARN in the game log, at most once a real minute (r15-10)"],
  ["boot.js", "performance.now() - t0 < W.BUDGET_MS", "steps per frame within BUDGET_MS (above)"],
  ["boot.js", "let ms = performance.now() - t0;", "the frame's simulation ms for the budget (js/active.js, r15-34); with the thread busy time from BF.tload.total() on its own thread)"],
  ["mobs.js", "const t0 = performance.now(), a = findPathFast(", "BF.debug.pathCompare timing of findPath vs findPathOld (r15-05, debug only; the route returned doesn't depend on it)"],
  ["mobs.js", "const t0 = performance.now(); villagerAI(m, dt, _desired); aiAcc += performance.now() - t0;", "villager AI ms for the debug screen only (the force-unload limit counts updates, aiWork)"],
  ["weather.js", "const t0 = performance.now();\n    if (!inited) init();", "weather ms for the debug line"],
  ["weather.js", "weather.ms = weather.ms * 0.95 + (performance.now() - t0) * 0.05;", "weather ms for the debug line"],
  ["weather.js", "const t0 = performance.now();\n    dt = Math.max(0, dt || 0);", "weather.draw's ms for the debug line (drawing only, bug-098)"],
  ["weather.js", "weather.drawMs = weather.drawMs * 0.95 + (performance.now() - t0) * 0.05;", "weather.draw's ms (above)"],
  ["main.js", "const r0 = performance.now();\n  renderer.render", "the drawing call's ms for the debug screen's Threads card (bug-098): the page's frame, decides nothing"],
  ["main.js", "BF.tload.frame(performance.now() - r0);", "the drawing call's ms (above)"],
  ["light.js", "const t0 = performance.now(), W = world();", "recomputeAll's ms (tests, debugging)"],
  ["light.js", "return performance.now() - t0;", "recomputeAll's ms"],
  ["skylight.js", "const t0 = performance.now(), W = world();", "recomputeAll's ms (tests, debugging)"],
  ["skylight.js", "return performance.now() - t0;", "recomputeAll's ms"],
  ["rplay.js", "const now = () => performance.now();", "region workers in play (spec r15-39): ms a tick with one thinking and split, which decide whether the thinking is split (the world comes out the same either way), and F3's figures"],
  ["rworkers.js", "const now = () => performance.now();", "region workers (spec r15-39): each unit's thinking ms, which only decides which worker thinks for it (the world comes out the same on any split), the ms per phase for F3, and the barrier's crash timeout"],
];

const RE = /performance\.now\s*\(|Date\.now\s*\(/g;
// code only: drop whole-line comments and trailing "  // ..." comments
const code = l => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/\s.*$/, ""));
let fails = 0, uses = 0;
const used = new Set(), usedFn = new Set();
for (const f of fs.readdirSync(JS).filter(f => f.endsWith(".js")).sort()) {
  const src = fs.readFileSync(path.join(JS, f), "utf8"), lines = src.split("\n");
  // positions of the listed lines in this file (a listed text may span two lines)
  const ok = [];
  LINES.forEach((e, i) => {
    if (e[0] !== f) return;
    let at = src.indexOf(e[1]);
    if (at < 0) return;
    used.add(i);
    for (; at >= 0; at = src.indexOf(e[1], at + 1)) { const l0 = src.slice(0, at).split("\n").length - 1; ok.push([l0, l0 + e[1].split("\n").length - 1]); }
  });
  const fns = FUNCS.filter(e => e[0] === f);
  const DECL = /^(?:async\s+)?function\s+([\w$]+)\s*\(|^([\w$.]+)\s*=\s*(?:async\s+)?function\b/;
  const fnAt = n => { for (let i = n; i >= 0; i--) { const m = DECL.exec(lines[i]); if (m) return m[1] || m[2]; } return null; };
  lines.forEach((l, n) => {
    const hits = (code(l).match(RE) || []).length;
    if (!hits) return;
    uses += hits;
    if (FILES[f]) return;
    if (ok.some(([a, b]) => n >= a && n <= b)) return;
    if (fns.length) { const fn = fnAt(n), e = fns.find(e => e[1] === fn); if (e) { usedFn.add(e); return; } }
    fails++;
    console.log(`FAIL js/${f}:${n + 1} reads the wall clock: ${l.trim().slice(0, 160)}\n     use BF.simNow() or a work count, or list it in test/wallclock-lint.js if it decides nothing in the simulation`);
  });
}
LINES.forEach((e, i) => { if (!used.has(i)) { fails++; console.log(`FAIL listed line no longer in js/${e[0]}: ${JSON.stringify(e[1])} (${e[2]})`); } });
// (listed functions and whole files may be missing: r15-03's mesh pool (pump) and mesher files are listed ahead of their merge)
console.log(`${uses} wall-clock reads in js/, ${Object.keys(FILES).length} files, ${FUNCS.length} functions and ${LINES.length} lines allowed`);
console.log(fails ? "FAIL wallclock-lint: " + fails + " problems" : "PASS wallclock-lint");
process.exit(fails ? 1 : 0);
