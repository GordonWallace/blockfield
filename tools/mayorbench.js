// Mayor benchmark (experimental, js/mayor.js): the same village run twice for the same number of game days, once with a Claude mayor
// directing its builders and once without, and the village's numbers compared day by day.
// Usage: NODE_PATH=$(npm root -g) node tools/mayorbench.js [--seeds 3,7,11] [--days 10] [--dt 0.1] [--out file.md] [--mock] [--headed]
// Needs the Claude API key where debug/claude.js looks for it (ANTHROPIC_API_KEY, BF_CLAUDE_KEY_FILE or ~/.config/blockfield/anthropic-key)
// and the SDK (`npm install` in debug/). It spends real money in the mayor runs only: roughly $0.05-0.15 per mayor run of 10 game days
// on Haiku (each review's cost is in the report). The $1 an hour cap (BF_CLAUDE_PER_HOUR_USD) still applies; reviews it refuses are
// retried later. --mock answers with a stand-in API instead (no key, no cost; for checking the bench itself).
// How a run works:
// - The two runs of a seed start close but not identical (chunks and villagers load asynchronously), so the report shows both starts.
// - debug/server.js serves the game on spare ports (so /claude/mayor works); headless Chromium opens the world `#seed<N>` with drawing
//   stopped. Math.random is seeded from the seed, so both runs of a seed start alike and differ only by what the mayor does (and the
//   chance that follows from it).
// - The village: the nearest to the spawn with 6+ buildings and a builder. The player stands in it, so it stays loaded.
// - The world is stepped by hand (dt game seconds a step, the test step: warp, sky, mobs, drops, world sim). In the mayor run the mayor
//   ticks between batches of steps, and the world waits while a review is out, so the model's thinking time costs the village nothing.
// - Numbers (BF.mayor.metrics) at the start and the end of every game day: population, free beds, homeless, starving, food days,
//   happiness, unemployed, structures built (and by type), births and deaths in the last week, deaths in all.
// Writes a Markdown report (default tools/mayorbench-<date>.md) and the raw numbers next to it (.json).
"use strict";
const path = require("path"), fs = require("fs"), http = require("http"), { spawn } = require("child_process");
const { chromium } = require(process.env.PW || "playwright");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2), has = n => args.includes(n), flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const SEEDS = String(flag("--seeds", "3,7,11")).split(",").map(Number).filter(Number.isFinite);
const DAYS = +flag("--days", 10), DT = +flag("--dt", 0.1), MOCK = has("--mock"), HEADED = has("--headed");
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const OUT = path.resolve(flag("--out", path.join(root, "tools", "mayorbench-" + stamp + ".md")));
const GAME = 8790, DBG = 8791, MOCKP = 8792, BATCH = 200;   // steps between mayor ticks (20 game seconds at dt 0.1)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --mock: a stand-in API that looks at the village and orders a small house, then sums up
function mockApi() {
  return http.createServer((req, res) => {
    let b = ""; req.on("data", c => { b += c; }); req.on("end", () => {
      const body = JSON.parse(b || "{}"), end = body.messages[body.messages.length - 1];
      const back = Array.isArray(end.content) && end.content.some(c => c.type === "tool_result");
      const content = back ? [{ type: "text", text: "Ordered a small house for the homeless." }]
        : [{ type: "tool_use", id: "t1", name: "give_orders", input: { builder: "all", build: [{ type: "small_house", why: "beds" }], avoid: [], reason: "beds" } }];
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model,
        stop_reason: back ? "end_turn" : "tool_use", stop_sequence: null, content, usage: { input_tokens: 3000, output_tokens: 200 } }));
    });
  }).listen(MOCKP);
}

async function run(browser, seed, withMayor) {
  const pg = await (await browser.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on("pageerror", e => console.log("  PAGEERROR", e.message));
  await pg.addInitScript(s => {
    let a = s >>> 0;   // mulberry32: the same chance in both runs of a seed
    Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb));
  }, seed * 2654435761);
  await pg.addInitScript({ path: path.join(root, "test", "bft.js") });   // BFT.villages (the test helpers)
  const three = path.join(root, ".three-test.min.js");
  if (fs.existsSync(three)) await pg.route("**/three.min.js", r => r.fulfill({ path: three, contentType: "text/javascript" }));
  await pg.goto(`http://localhost:${GAME}/?nolod&mayorauto=0&mayortick=0#seed${seed}`);
  await pg.waitForFunction(() => window.BF && !BF.preparing && BF.mobs && BF.mayor, null, { timeout: 240000, polling: 300 });
  await pg.waitForTimeout(3000);
  const v = await pg.evaluate(() => {
    window.__halt = true;
    BF.player.setGameMode && BF.player.setGameMode("creative");
    window.__step = (h, n) => { for (let i = 0; i < n; i++) { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); } };
    const vs = BFT.villages(3000).filter(v => v && v.pop && (v.buildings || []).length >= 6).slice(0, 8);
    for (const c of vs) {
      const key = Math.round(c.x) + "," + Math.round(c.z);
      BF.player.spawn(c.x + 0.5, (c.y || BF.worldgen.heightAt(c.x, c.z)) + 3, c.z + 0.5);
      for (let i = 0; i < 400; i++) { BF.world.update(c.x, c.z, 60); if (i % 4 === 0) window.__step(0.05, 1); }
      if (BF.mobs.list.some(m => m.type === "villager" && m.village && m.village.key === key && !m.dead && m.profession === "builder")) {
        let name = key; try { name = BF.signs.villageName(c) || key; } catch (e) { /* unnamed */ }
        return { key, name };
      }
    }
    return null;
  });
  if (!v) { await pg.close(); return { error: "no village with a builder near the spawn" }; }
  if (withMayor) {
    await pg.waitForFunction(() => BF.mayor.ready(), null, { timeout: 30000, polling: 300 }).catch(() => {});
    if (!(await pg.evaluate(k => BF.mayor.ready() && BF.mayor.appoint(k), v.key))) { await pg.close(); return { error: "no mayor (is the API key set?)" }; }
  }
  const days = [], t0 = Date.now();
  const sample = () => pg.evaluate(k => Object.assign({ day: +(BF.sky.day + BF.sky.time).toFixed(2) }, BF.mayor.metrics(k)), v.key);
  days.push(await sample());
  const start = await pg.evaluate(() => BF.sky.day + BF.sky.time);
  let next = Math.floor(start) + 1, waited = 0;
  for (;;) {
    const now = await pg.evaluate(({ dt, n, mayor }) => { window.__step(dt, n); if (mayor) BF.mayor.tick(); return BF.sky.day + BF.sky.time; }, { dt: DT, n: BATCH, mayor: withMayor });
    if (withMayor) { const w0 = Date.now(); while (await pg.evaluate(() => BF.mayor.busy())) await sleep(200); waited += Date.now() - w0; }   // the world waits for the review
    if (now >= next) { days.push(await sample()); process.stdout.write("  " + (withMayor ? "mayor" : "alone") + " day " + Math.floor(now - start) + "/" + DAYS + "\r"); next++; }
    if (now - start >= DAYS) break;
  }
  const mayor = withMayor ? await pg.evaluate(() => { const S = BF.mayor.state(); return S && { name: S.name, reviews: S.reviews, spent: S.spent, strategy: S.strategy, lessons: S.lessons, goals: S.goals, journal: S.journal, last: S.last }; }) : null;
  const log = await pg.evaluate(k => (BF.vlog.entries(k) || []).filter(e => e[1] === "mayor" || e[1] === "build").map(e => "day " + (Math.floor(e[0]) + 1) + " " + String(Math.round((e[0] % 1) * 24 + 6) % 24).padStart(2, "0") + ":00 " + e[2]), v.key);
  await pg.close();
  console.log("  " + (withMayor ? "mayor" : "alone") + " done in " + Math.round((Date.now() - t0) / 1000) + " s" + (withMayor ? " (" + Math.round(waited / 1000) + " s waiting for reviews)" : "") + "          ");
  return { village: v, days, mayor, log };
}

const KEYS = [["population", "Population"], ["free_beds", "Free beds"], ["homeless", "Homeless"], ["starving", "Starving"], ["food_days", "Food days"],
  ["happiness", "Happiness"], ["unemployed", "Unemployed"], ["built", "Structures built"], ["deaths", "Deaths (all)"]];
function report(results) {
  const L = ["# Mayor benchmark, " + stamp, "", `${DAYS} game days per run, step ${DT} s, seeds ${SEEDS.join(", ")}${MOCK ? " (MOCK API: not a real mayor)" : ""}.`, ""];
  const fin = r => r.days[r.days.length - 1];
  const avg = {};
  for (const res of results) {
    L.push("## Seed " + res.seed + (res.alone.village ? ": " + res.alone.village.name : ""));
    if (res.alone.error || res.mayor.error) { L.push("", "Skipped: " + (res.alone.error || res.mayor.error), ""); continue; }
    L.push("", "| | Start (without / with) | Without a mayor | With a mayor | Difference |", "| --- | --- | --- | --- | --- |");
    for (const [k, n] of KEYS) {
      const a = fin(res.alone)[k], m = fin(res.mayor)[k], s0 = res.alone.days[0][k] + " / " + res.mayor.days[0][k];
      L.push(`| ${n} | ${s0} | ${a} | ${m} | ${Math.round((m - a) * 10) / 10} |`);
      (avg[k] = avg[k] || []).push([a, m]);
    }
    const types = r => Object.entries(fin(r).byType || {}).map(([t, n]) => n + " " + t.replace(/_/g, " ")).join(", ") || "none";
    L.push("", "Built without a mayor: " + types(res.alone) + ".", "", "Built with a mayor: " + types(res.mayor) + ".", "");
    const M = res.mayor.mayor;
    if (M) {
      L.push(`Mayor ${M.name}: ${M.reviews} reviews, $${(M.spent || 0).toFixed(3)}.`, "", "Final strategy: " + (M.strategy || "(none)"), "", "Lessons: " + (M.lessons || "(none)"), "");
      L.push("Goals: " + (M.goals.map(g => `#${g.id} ${g.text} (${g.metric} ${g.op} ${g.target} by day ${g.by}): ${g.status}${g.result != null ? " " + g.result : ""}`).join("; ") || "none"), "");
    }
    L.push("Day by day (without / with):", "", "| Day | " + KEYS.slice(0, 6).map(k => k[1]).join(" | ") + " |", "| --- |" + " --- |".repeat(6));
    for (let i = 0; i < Math.max(res.alone.days.length, res.mayor.days.length); i++) {
      const a = res.alone.days[i] || {}, m = res.mayor.days[i] || {};
      L.push(`| ${i} | ` + KEYS.slice(0, 6).map(([k]) => (a[k] ?? "-") + " / " + (m[k] ?? "-")).join(" | ") + " |");
    }
    L.push("", "<details><summary>Village log with a mayor (builds and the mayor)</summary>", "", "```", ...res.mayor.log.slice(-120), "```", "", "</details>", "");
  }
  if (Object.keys(avg).length) {
    L.splice(4, 0, "## Average over seeds (end of run)", "", "| | Without a mayor | With a mayor |", "| --- | --- | --- |",
      ...KEYS.map(([k, n]) => { const xs = avg[k] || []; const mean = j => xs.length ? Math.round(xs.reduce((s, x) => s + x[j], 0) / xs.length * 10) / 10 : "-"; return `| ${n} | ${mean(0)} | ${mean(1)} |`; }), "");
  }
  return L.join("\n");
}

(async () => {
  const mock = MOCK ? mockApi() : null;
  const env = Object.assign({}, process.env, MOCK ? { ANTHROPIC_API_KEY: "sk-ant-mock", ANTHROPIC_BASE_URL: `http://localhost:${MOCKP}` } : {});
  const srv = spawn(process.execPath, [path.join(root, "debug/server.js"), "--game", GAME, "--debug", DBG, "--alerts", path.join(require("os").tmpdir(), "bf-mayorbench-alerts.json")], { env, stdio: "ignore" });
  process.on("exit", () => srv.kill());
  let st = null;
  for (let i = 0; i < 100 && !st; i++) { try { st = await (await fetch(`http://localhost:${GAME}/claude/status`)).json(); } catch (e) { await sleep(200); } }
  if (!st || !st.configured || !st.sdk) { console.error("The game server has no working Claude key: " + (st && st.error)); process.exit(1); }
  console.log(`Mayor benchmark: seeds ${SEEDS.join(", ")}, ${DAYS} game days each${MOCK ? ", mock API" : ", model " + st.model}`);
  const browser = await chromium.launch({ headless: !HEADED, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const results = [];
  for (const seed of SEEDS) {
    console.log("seed " + seed);
    const alone = await run(browser, seed, false), mayor = await run(browser, seed, true);
    results.push({ seed, alone, mayor });
    fs.writeFileSync(OUT, report(results)); fs.writeFileSync(OUT.replace(/\.md$/, "") + ".json", JSON.stringify(results, null, 1));
  }
  await browser.close(); srv.kill(); if (mock) mock.close();
  console.log("Report: " + OUT);
  process.exit(0);
})();
