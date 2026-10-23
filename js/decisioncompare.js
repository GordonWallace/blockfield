// Decision comparison mode (r15-07). The villager decision speed-ups (chunk-version caches of block scans, see js/world.js chunk.ver)
// keep the old way of working each answer out. With BF.debug.decisionCompare = true every cached answer is also worked out the old way
// and any difference is logged (game log ERROR "decision-diff", at most 20 a game, then counted only) and counted in BF.dcmp.stats,
// so a soak (test/decision-compare.js) can show the speed-ups decide exactly what the old code did. Off (the default) it costs nothing.
// API: BF.debug.decisionCompare (the switch), BF.dcmp = { on() -> bool, check(kind, oldValue, newValue, at?) -> newValue, stats, reset() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
BF.debug = BF.debug || {};
if (BF.debug.decisionCompare == null) BF.debug.decisionCompare = false;

const LOG_MAX = 20;
const stats = { checks: 0, diffs: 0, byKind: {}, first: [] };
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
let started = false;
function check(kind, oldV, newV, at) {
  if (!started) { started = true; if (BF.glog) BF.glog.log("INFO", "decision-compare", "decision comparison mode on: cached villager decisions are checked against the old scans"); }
  stats.checks++;
  const k = stats.byKind[kind] || (stats.byKind[kind] = { checks: 0, diffs: 0 });
  k.checks++;
  if (same(oldV, newV)) return newV;
  stats.diffs++; k.diffs++;
  if (stats.first.length < LOG_MAX) {
    const text = kind + ": old " + String(JSON.stringify(oldV)).slice(0, 300) + " new " + String(JSON.stringify(newV)).slice(0, 300);
    stats.first.push(text);
    if (BF.glog) BF.glog.log("ERROR", "decision-diff", text, at ? { at } : undefined);
  }
  return newV;
}
BF.dcmp = {
  on: () => BF.debug.decisionCompare === true,
  check,
  stats,
  reset() { stats.checks = 0; stats.diffs = 0; stats.byKind = {}; stats.first.length = 0; started = false; },
};
})();
