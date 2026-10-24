// @ci baseline suite=world timeout=420
// The switch that turns distant terrain off (js/lod.js): a page served over http (where workers start, so the rings would build) with
// ?nolod in its address has no rings and no sampling workers; without it the rings are on. Tests served over http that time things
// under software rendering use the switch (or BF.lodOff in an init script).
// node test/run.js /tmp/lodoff test/lod-off.js
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
module.exports = async (pg) => {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split(/[?#]/)[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  // (after the planet's rivers are worked out, then a ring's worth of time: the workers solve the river network first too)
  const state = async () => {
    await pg.waitForFunction(() => window.BF && BF.lod && !BF.preparing, null, { timeout: 120000 });
    await pg.evaluate(() => BF.player.start());
    // (on: until a ring is built, which takes the workers' own river solve first)
    await pg.waitForFunction(() => !BF.lod.active || BF.lod.levels.some((L) => L.mesh), null, { timeout: 240000 }).catch(() => {});
    await pg.waitForTimeout(3000);
    return pg.evaluate(() => { const s = BF.lod.stats(); return { active: s.active, workers: s.workers, built: s.rings.filter((x) => x.built).length }; });
  };
  try {
    await pg.setViewportSize({ width: 320, height: 200 });
    await pg.goto(base + "?nolod&" + require("./lib").q() + "#seed1337gen4");
    const off = await state();
    check(!off.active && off.workers === 0 && off.built === 0, `?nolod: no distant terrain (${JSON.stringify(off)})`);
    await pg.goto(base + "?" + require("./lib").q() + "#seed1337gen4");
    const on = await state();
    check(on.active && on.workers > 0 && on.built > 0, `without it: distant terrain on, sampled by workers (${JSON.stringify(on)})`);
  } finally {
    server.close();
  }
  console.log(bad ? `FAILED ${bad} check(s)` : "lod-off: all checks passed");
};
