// Village history for the debug screen's History panel (debug/vhist-view.js), as the debug server holds it: the game records it and
// saves it with the world (js/villagestats.js, spec r15-69) and its snapshots carry it (js/debugfeed.js vhist: all of it after a
// resync, a new world or a save loaded, then each village's new samples and its loaded spans). The server keeps the latest world's copy
// for screens that connect later and passes each change on.
// API: require("./vhist.js")() -> { take(snapshot) -> the "vhist" event to send the screens or null, cached() }
"use strict";
module.exports = function vhist() {
  let data = null;   // {wid, name, now, v: {key: {name, s: [samples], spans}}}
  function take(s) {
    const h = s.vhist;
    if (!h || typeof h !== "object" || typeof h.wid !== "string" || !h.v || typeof h.v !== "object") return null;
    if (h.full || !data || data.wid !== h.wid) {
      data = { wid: h.wid, name: h.name || "", now: +h.now || 0, v: {} };
      for (const k in h.v) { const x = h.v[k]; if (x && Array.isArray(x.s)) data.v[k] = { name: x.name || k, s: x.s.slice(), spans: Array.isArray(x.spans) ? x.spans : [] }; }
      return { reset: true, data };
    }
    data.now = +h.now || data.now;
    for (const k in h.v) {
      const x = h.v[k];
      if (!x) continue;
      const r = data.v[k] || (data.v[k] = { name: x.name || k, s: [], spans: [] });
      r.name = x.name || r.name;
      if (Array.isArray(x.s)) r.s = x.s.slice(); else if (Array.isArray(x.add)) r.s.push(...x.add);
      if (Array.isArray(x.spans)) r.spans = x.spans;
    }
    return { wid: data.wid, now: data.now, v: h.v };
  }
  return { take, cached: () => data };
};
