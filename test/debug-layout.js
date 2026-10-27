// @ci integration suite=ui timeout=300
// The debug screen's status cards and what it keeps between worlds (Gordon 2026-10-27):
//   - the cards sit at most 8 across, spread evenly over the rows they need (16 cards: 8 x 2; 17: 6 x 3 with a gap), and a card
//     taller than its cap scrolls inside instead of stretching its row;
//   - a new world (another seed, or another saved world with the same seed) never shows the last world's village data: the screen
//     drops its villages' layouts, logs and Economy tallies, and the server's cache (what a reloaded screen gets) holds only the new
//     world's.
// Synthetic snapshots POSTed to /push; no game needed (--no-game). Screenshot: <out>.png
// Usage: NODE_PATH=$(npm root -g) node test/debug-layout.js [out]
"use strict";
const { spawn } = require("child_process"), http = require("http"), path = require("path");
const { chromium } = require(process.env.PW || "playwright");
const out = process.argv[2] || "/tmp/debug-layout";
const GAME = 21000 + Math.floor(Math.random() * 1000), DEBUG = GAME + 1000;
const srv = spawn(process.execPath, [path.join(__dirname, "..", "debug", "server.js"), "--no-game", "--game", String(GAME), "--debug", String(DEBUG),
  "--alerts", path.join(require("os").tmpdir(), "debug-layout-alerts-" + process.pid + ".json")], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);
const req = (method, p, body) => new Promise(res => {
  const r = http.request({ host: "127.0.0.1", port: DEBUG, method, path: p, headers: body ? { "Content-Type": "application/json" } : {} }, x => {
    let t = ""; x.on("data", d => t += d); x.on("end", () => res({ status: x.statusCode, body: t }));
  });
  r.on("error", e => res({ status: "error " + e.code }));
  if (body != null) r.write(JSON.stringify(body));
  r.end();
});
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? "ok   " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); if (!ok) fails++; };

// one village's Economy tallies (js/economy.js view): today's flows [seller, buyer, item, group, n, emeralds, trades]
const econOf = item => ({ today: 1, days: { 1: { f: [["Farmer", "Baker", item, "food", 4, 2, 3]], w: [], s: [] } } });
const snapOf = (seed, wid, key, item) => ({ wid, info: { seed, fps: 60, chunksQueued: 0 }, text: "", villages: key ? [{ key, name: "Village " + key, loaded: true, dist: 10 }] : [],
  econ: key ? { [key]: econOf(item) } : {}, logs: key ? { [key]: { cap: 300, entries: [[1, "trade", "sold " + item]] } } : {} });

(async () => {
  for (let i = 0; i < 50 && String((await req("GET", "/state")).status)[0] !== "2"; i++) await wait(100);
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 2000, height: 1100 } });
  await pg.route("https://fonts.**", r => r.abort());
  const errs = [];
  pg.on("pageerror", e => errs.push(e.message));
  pg.on("console", m => { if (m.type() === "error" && !/at renderTop/.test(m.text())) errs.push(m.text()); });   // (see econText)
  await pg.goto(`http://127.0.0.1:${DEBUG}/`);
  await pg.waitForFunction(() => !!window.BFWorld && !!document.querySelector(".cards").style.gridTemplateColumns);

  // ---- layout: at most 8 across, rows even
  const grid = () => pg.evaluate(() => { const el = document.querySelector(".cards"); return { n: [...el.children].filter(c => !c.hidden).length, cols: getComputedStyle(el).gridTemplateColumns.split(" ").length }; });
  const expect = n => { const rows = Math.ceil(n / 8); return Math.ceil(n / rows); };
  let g = await grid();
  check(g.cols === expect(g.n) && g.cols <= 8, `${g.n} cards: ${expect(g.n)} across`, g);
  for (const n of [16, 17, 9, 24, 25]) {
    await pg.evaluate(n => {
      const el = document.querySelector(".cards");
      el.querySelectorAll(".tcard").forEach(c => c.remove());
      for (let have = [...el.children].filter(c => !c.hidden).length; have < n; have++) { const c = document.createElement("div"); c.className = "card tcard"; c.innerHTML = "<h3>Test</h3>"; el.appendChild(c); }
      for (const c of [...el.children].filter(c => !c.hidden)) if ([...el.children].filter(c => !c.hidden).length > n) c.hidden = true;
    }, n);
    await pg.waitForTimeout(50);
    g = await grid();
    check(g.n === n && g.cols === expect(n), `${n} cards: ${expect(n)} across (${Math.ceil(n / Math.ceil(n / 8))}x${Math.ceil(n / 8)})`, g);
  }
  await pg.reload(); await pg.waitForFunction(() => !!window.BFWorld && !!document.querySelector(".cards").style.gridTemplateColumns);
  // a tall card scrolls; its row stays at the cap
  const tall = await pg.evaluate(() => {
    const c = document.getElementById("c-thcard"), body = document.createElement("div");
    body.style.height = "900px"; c.appendChild(body);
    const r = c.getBoundingClientRect(), first = document.querySelector(".cards > .card").getBoundingClientRect();
    return { h: Math.round(r.height), scrolls: c.scrollHeight > c.clientHeight, overflow: getComputedStyle(c).overflowY, row: Math.round(first.height) };
  });
  check(tall.h <= 300 && tall.scrolls && tall.overflow === "auto", "a tall card scrolls inside, 300px at most", tall);
  check(tall.row <= 300, "and doesn't stretch its row", tall);
  await pg.screenshot({ path: out + ".png" });

  // ---- worlds: nothing from the last one
  await pg.evaluate(() => { document.querySelector('#l-tabs [data-tab="econ"]').click(); document.querySelector('#e-scope [data-v="all"]').click(); });
  const econKeys = () => pg.evaluate(() => Object.keys(BFWorld.econ).sort());
  // (the synthetic snapshots carry too little for the top cards, which stop onSnap before it redraws: draw the Economy view here)
  const econText = () => pg.evaluate(() => { BFWorld.renderEcon(); return document.getElementById("econ").textContent; });
  await req("POST", "/push", snapOf(1, "w-a", "a1", "bread"));
  await pg.waitForFunction(() => !!BFWorld.econ.a1);
  check(/3 trades/.test(await econText()), "world A: its trades show", (await econText()).slice(0, 200));
  await req("POST", "/push", snapOf(2, "w-b", null));
  await pg.waitForFunction(() => BFWorld.snap() && BFWorld.snap().info.seed === 2);
  check((await econKeys()).length === 0, "a new world (another seed): the last world's tallies are gone", await econKeys());
  check(!/trades/.test(await econText()), "and the Economy view shows none of its trades", (await econText()).slice(0, 80));
  check(await pg.evaluate(() => Object.keys(BFWorld.logs).length === 0 && Object.keys(BFWorld.layouts).length === 0), "nor its logs or layouts");
  // another saved world with the same seed
  await req("POST", "/push", snapOf(2, "w-c", "c1", "carrot"));
  await pg.waitForFunction(() => !!BFWorld.econ.c1);
  await req("POST", "/push", snapOf(2, "w-d", "d1", "melon"));
  await pg.waitForFunction(() => !!BFWorld.econ.d1);
  check(JSON.stringify(await econKeys()) === '["d1"]', "another saved world, same seed: only its own tallies", await econKeys());
  check(/All villages \(1\) · last 3 game days: 3 trades/.test(await econText()), "and none of the other's trades show", (await econText()).slice(0, 80));
  // the server's cache: a screen opened (or reloaded) now gets this world only
  const c = await req("GET", "/state");
  check(c.status === 200, "server state", c.status);
  await pg.reload(); await pg.waitForFunction(() => !!window.BFWorld && !!BFWorld.snap());
  await pg.waitForTimeout(300);
  check(JSON.stringify(await econKeys()) === '["d1"]', "reloaded screen: the server's cache holds this world's only", await econKeys());
  check(/another world/.test(log), "the server logs that it dropped the last world's data");
  // a stray key arriving outside the village list never shows under All villages
  await pg.evaluate(() => { BFWorld.econ.zz = { today: 1, days: { 1: { f: [["Farmer", "Baker", "stray_item", "food", 1, 1, 1]], w: [], s: [] } } }; BFWorld.renderEcon(); });
  check(/All villages \(1\) · last 3 game days: 3 trades/.test(await econText()), "All villages counts only this world's villages", (await econText()).slice(0, 80));
  check(!errs.length, "no page errors", errs);
  await b.close();
  srv.kill();
  console.log(fails ? `${fails} FAILED` : "all ok");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
