// A region worker in the browser (spec r15-39): a Web Worker the simulation worker (js/simworker.js) starts for each world it plays, holding
// a whole copy of that world. Its first message ({boot}) loads Three.js (for its maths), the simulation's files (js/simfiles.js), the
// slash commands (the client's command requests replay here too) and js/rplay.js; from then on js/rplay.js's follower takes every
// message: it makes the leader's world and replays the leader's journal, and thinks its share of the regions while the leader splits them.
// The Node twin is server/regionthread.js (the world server's followers). An error goes to the leader as {error}.
(() => {
"use strict";
const Q = self.location.search;   // the ?v= stamp, as js/simworker.js's
let handle = null;
const fail = e => { try { self.postMessage({ error: String(e && e.stack || e) }); } catch (_) { /* gone */ } };
self.onmessage = ev => {
  const d = ev.data;
  if (!handle) {
    if (!d || !d.boot) return;
    try {
      let three = false;
      for (const u of [d.boot.three, "../.three-test.min.js"]) {   // three.js r128: the page's copy (the CDN), else the repo's copy
        if (!u || three) continue;
        try { importScripts(u); three = typeof THREE !== "undefined"; } catch (e) { /* the next one */ }
      }
      if (!three) throw new Error("three.js would not load in the region worker");
      importScripts("simfiles.js" + Q);
      importScripts(...self.BF.SIM_FILES.map(f => "../" + f + Q));
      importScripts("coords.js" + Q, "commands.js" + Q, "rplay.js" + Q);
      handle = self.BF.rplay.follower(m => self.postMessage(m));
    } catch (e) { fail(e); return; }
  }
  handle(d);
};
self.addEventListener("error", ev => fail(ev.error || ev.message));
})();
