// Alerts from the debug screen, the simulation's half (spec r15-43; js/alerts.js is the page's half, which shows the notice). The page
// gets the alert list from the debug server (js/debugfeed.js) and hands it here with the protocol's alerts query, so this works the
// same with the simulation in the page, a Web Worker or the world server. Every village log entry (js/villagelog.js) is checked against
// the enabled alerts; on a match the world freezes here at once (0x, even part-way through a fast-forward frame: js/timewarp.js), and
// an "alert" entry goes to the page in the events message (js/protocol.js UI), with the village's name and the entry's time as text.
// Game log: INFO "alerts" when the list changes (how many are on), and for each alert that fires.
// API: BF.alertSim = { set(list, av), list, av, check(rec, entry), fire(alert, rec, entry) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const LM = () => BF.logmatch || globalThis.BFLog;
let list = [], av = null;

function fire(alert, rec, entry) {
  if (BF.warp) BF.warp.freeze();
  const name = (BF.signs && BF.signs.villageName && rec && BF.signs.villageName(rec.key)) || "Village";
  if (BF.glog) BF.glog.log("INFO", "alerts", "Alert \"" + (LM() ? LM().describe(alert) : alert.id) + "\" fired in " + name + ": " + entry[2] + "; the world froze at 0x");
  if (BF.emit) BF.emit("alertFired", alert, { key: rec ? rec.key : null, name, stamp: BF.vlog ? BF.vlog.stamp(entry[0]) : "", entry: entry.slice(0, 4) });
}
function check(rec, entry) {
  if (!list.length || !LM()) return;
  for (const a of list) if (a.on !== false && LM().matches(a, entry)) { fire(a, rec, entry); return; }
}

BF.alertSim = {
  // [{ id, who, act, kind, text, on }], from the page (the debug server's list)
  set(l, v) {
    const was = av;
    list = Array.isArray(l) ? l.filter(a => a && a.id) : []; av = v == null ? null : v;
    if (av !== was && BF.glog) BF.glog.log("INFO", "alerts", "Debug screen alerts: " + list.filter(a => a.on !== false).length + " on, " + list.filter(a => a.on === false).length + " off");
  },
  get list() { return list; },
  get av() { return av; },
  check, fire,
};
})();
