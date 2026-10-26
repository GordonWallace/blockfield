// @ci integration suite=ui timeout=600 hosts=worker,server
// Creating or loading a world never shows the start screen again (bug-092): from the Create (or Play) button until play starts, a
// loading screen covers the start screen, also while the worker or the world server starts the world after the page's river step.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/cnf test/create-no-flash.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg) => {
  const fails = [];
  const ok = (what, c, d) => { console.log((c ? "ok   " : "FAIL ") + what + (d !== undefined && !c ? " " + JSON.stringify(d) : "")); if (!c) fails.push(what); };
  const click = sel => pg.evaluate(s => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
  await lib.ready(pg);
  const toTitle = async () => {
    if (!(await pg.evaluate(() => !!document.querySelector(".bfp-start.on")))) await click('.bfp-pause [data-act="quit"]');
    await pg.waitForFunction(() => !!document.querySelector(".bfp-start.on") && document.querySelector('.bfp-start [data-act="play"]'), null, { timeout: 30000 }).catch(() => {});
  };
  // every frame from the button's click on: is the start screen showing with nothing over it?
  const watch = async (label, sel) => {
    await pg.evaluate(sel => {
      const r = window.__flash = { bare: 0, frames: 0, covered: 0, done: false };
      const tick = () => {
        const on = !!document.querySelector(".bfp-start.on"), cover = !!document.getElementById("bf-loading");
        r.frames++;
        if (on && !cover) r.bare++;
        if (cover) r.covered++;
        if (!on && !cover) { r.done = true; return; }
        requestAnimationFrame(tick);
      };
      document.querySelector(sel).click();
      tick();
    }, sel);
    await pg.waitForFunction(() => window.__flash.done, null, { timeout: 240000, polling: 200 });
    const r = await pg.evaluate(() => window.__flash);
    ok(label + ": the start screen never shows bare between the click and play", r.bare === 0 && r.covered > 0, r);
    await lib.simReady(pg);
    await pg.waitForTimeout(1500);
  };
  for (const [label, seed] of [["creating a world on a new seed", "4242"], ["creating one on the same seed again (no river step)", "4242"]]) {
    await toTitle();
    await click('.bfp-start [data-act="show-create"]');
    await pg.evaluate(s => { const f = document.querySelector(".bfp-view-create"); f.elements.name.value = "No flash"; f.elements.seed.value = s; }, seed);
    await watch(label, '.bfp-view-create button[type="submit"]');
  }
  await toTitle();
  await watch("playing a saved world", '.bfp-start [data-act="play"]');
  const log = await lib.sim(pg, () => BF.glog.recent(400).filter(e => e.k === "save" && /playing after/.test(e.x)).map(e => e.x));
  ok("the game log says when each world started playing", log.length >= 1, log);
  if (fails.length) throw new Error(fails.length + " failed: " + fails.join("; "));
};
