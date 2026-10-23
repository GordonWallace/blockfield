// @ci baseline suite=world,village
// No wall-clock time in simulation decisions (spec r15-16). Plain node, no browser: node test/wallclock-lint.js
// Every performance.now() / Date.now() in js/ must be on the list below: a file that never touches the simulation (UI, drawing, audio,
// saving, the debug feed, world generation at boot), or, in a file that does, one of the listed lines (a profiling measure, a streaming or
// drawing budget, the 0x fallback). Anything else is a simulation decision on real time and should use BF.simNow() (game seconds, which
// advance only by simulated steps) or a count of work done instead. The test also fails on a listed line that no longer exists, so the
// list stays true.
const fs = require("fs"), path = require("path");
const JS = path.join(__dirname, "..", "js");

// Whole files: nothing in them decides what happens in the simulation.
const FILES = {
  "audio.js": "sound",
  "commands.js": "chat lines fading out",
  "cracks.js": "block-breaking crack animation",
  "debugfeed.js": "the debug screen feed",
  "gamelog.js": "log timestamps",
  "globe.js": "globe drawing stats",
  "grid.js": "distant terrain sampling (drawing only)",
  "inventory.js": "inventory screen: tooltips, click guard",
  "lod.js": "distant terrain (drawing only)",
  "lodworker.js": "distant terrain worker (drawing only)",
  "maps.js": "held map arrow spinning",
  "mapview.js": "the player's map view and auto-map fill (drawing; explorers' maps are js/maps.js, filled by walking)",
  "planetgen.js": "world generation timing stats",
  "planetrivers.js": "river solve timing stats",
  "player.js": "input: Escape grace, touch taps, the player runs in real time",
  "save.js": "save metadata (last played, last saved)",
  "signs.js": "sign editor caret blink",
  "statehash.js": "how long hashing the world took (debug screen)",
};
// Single lines in files that also hold simulation code: [file, text on the line, why it is allowed]
const LINES = [
  ["main.js", "const t0 = performance.now();\n      let f = 0;", "boot: the river solve runs in slices until done, before the game starts"],
  ["main.js", "while (f < 1 && performance.now() - t0 < 60)", "boot: the river solve slices (above)"],
  ["main.js", "let frames = 0, fpsT = performance.now()", "fps counter"],
  ["main.js", "let last = performance.now();", "frame dt (the player and drawing)"],
  ["main.js", "const plan = W.plan(dt), t0 = performance.now();", "steps per frame within BUDGET_MS: how fast the game runs, not what happens"],
  ["main.js", "performance.now() - t0 < W.BUDGET_MS", "steps per frame within BUDGET_MS (above)"],
  ["world.js", "lastPlanT = performance.now();", "chunk streaming re-plan (drawing; villagers wait for unloaded chunks)"],
  ["world.js", "performance.now() - lastPlanT > 1000", "chunk streaming re-plan (above)"],
  ["world.js", "const t0 = performance.now();\n  let gi = 0, mi = 0;", "chunk generation and meshing budget (what is drawn; villagers wait for unloaded chunks)"],
  ["world.js", "while (performance.now() - t0 < budgetMs)", "chunk generation and meshing budget (above)"],
  ["world.js", "const now = performance.now(), st = world.lastRemesh;", "fast-forward remesh batching and its stats (drawing only, r15-02)"],
  ["world.js", "st.ms = performance.now() - now;", "remesh ms for the debug screen (r15-02)"],
  ["world.js", "c.meshT = performance.now();", "when a chunk was last meshed, for remesh batching (drawing only, r15-02)"],
  ["mobs.js", "const t0 = performance.now(), a = findPathFast(", "findPath old-vs-new timing, only with DBG.pathCompare on (r15-05)"],
  ["mobs.js", "const t0 = performance.now(); villagerAI(m, dt, _desired); aiAcc += performance.now() - t0;", "villager AI ms for the debug screen only (the force-unload limit counts updates, aiWork)"],
  ["villagesim.js", "check(px, pz, realClock, performance.now() / 1000)", "re-check on real time only while the world doesn't step (0x, paused), or for a new pin before the next step"],
  ["villagelog.js", "const t = performance.now();                  // wall clock", "village panel redraw"],
  ["weather.js", "const t0 = performance.now();\n    if (!points) init();", "weather ms for the debug line"],
  ["weather.js", "const ms = performance.now() - t0;", "weather ms for the debug line"],
  ["light.js", "const t0 = performance.now(), W = world();", "recomputeAll's ms (tests, debugging)"],
  ["light.js", "return performance.now() - t0;", "recomputeAll's ms"],
  ["skylight.js", "const t0 = performance.now(), W = world();", "recomputeAll's ms (tests, debugging)"],
  ["skylight.js", "return performance.now() - t0;", "recomputeAll's ms"],
];

const RE = /performance\.now\s*\(|Date\.now\s*\(/g;
// code only: drop whole-line comments and trailing "  // ..." comments
const code = l => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/\s.*$/, ""));
let fails = 0, uses = 0;
const used = new Set();
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
  lines.forEach((l, n) => {
    const hits = (code(l).match(RE) || []).length;
    if (!hits) return;
    uses += hits;
    if (FILES[f]) return;
    if (ok.some(([a, b]) => n >= a && n <= b)) return;
    fails++;
    console.log(`FAIL js/${f}:${n + 1} reads the wall clock: ${l.trim().slice(0, 160)}\n     use BF.simNow() or a work count, or list it in test/wallclock-lint.js if it decides nothing in the simulation`);
  });
}
LINES.forEach((e, i) => { if (!used.has(i)) { fails++; console.log(`FAIL listed line no longer in js/${e[0]}: ${JSON.stringify(e[1])} (${e[2]})`); } });
for (const f of Object.keys(FILES)) if (!fs.existsSync(path.join(JS, f))) { fails++; console.log(`FAIL listed file js/${f} is gone`); }
console.log(`${uses} wall-clock reads in js/, ${Object.keys(FILES).length} files and ${LINES.length} lines allowed`);
console.log(fails ? "FAIL wallclock-lint: " + fails + " problems" : "PASS wallclock-lint");
process.exit(fails ? 1 : 0);
