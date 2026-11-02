// @ci baseline suite=ui,world timeout=120
// The structure designer's server side and drawings (spec idea-051), with a stand-in for the Claude API (no key, no network; the live
// model is never called in CI): validateDesign's problems; /claude/blueprint's validate-and-retry loop (a bad first reply goes back with
// its problems, the second is kept), its call records and their cost, an unknown model refused, the hourly spend cap; /claude/status
// without a key; /sandbox/api/save then list (a structure written and listed, then removed); a drawing -> cells -> Capture -> drawing
// round trip keeps every block (js/housedesign.js), blocks outside the palette are kept and flagged, and an empty capture warns.
// Usage: node test/designer-api.js
"use strict";
process.env.BF_CLAUDE_PER_HOUR_USD = "0.05";
delete process.env.ANTHROPIC_API_KEY;
process.env.BF_CLAUDE_KEY_FILE = "/nonexistent/key";
const fs = require("fs"), path = require("path"), http = require("http"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const claude = require(path.join(ROOT, "debug", "claude.js")), sandbox = require(path.join(ROOT, "debug", "sandbox.js"));
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

const good = { name: "Hut", summary: "A hut.", notes: "", width: 3, depth: 3, legend: [{ symbol: "P", block: "oak_planks" }, { symbol: "D", block: "oak_door" }],
  layers: [{ label: "floor", rows: ["PPP", "PPP", "PPP"] }, { label: "walls", rows: ["PPP", "P.P", "PDP"] }, { label: "top", rows: ["PPP", "P.P", "P.P"] }, { label: "roof", rows: ["PPP", "PPP", "PPP"] }] };
const bad = { ...good, layers: [{ label: "floor", rows: ["PPP", "PPP"] }] };

(async () => {
  // ---- validateDesign
  check(claude.validateDesign(good).length === 0, "a good drawing has no problems");
  check(claude.validateDesign(bad).some(p => /rows/.test(p)), "a layer with too few rows is a problem");
  check(claude.validateDesign({ ...good, legend: [{ symbol: "P", block: "oak_planks" }] }).some(p => /not in the legend/.test(p)), "a symbol missing from the legend is a problem");
  const bed = { ...good, legend: good.legend.concat([{ symbol: "B", block: "red_bed" }]), layers: [good.layers[0], { rows: ["PPP", "PBP", "PDP"] }] };
  check(claude.validateDesign(bed).some(p => /bed/.test(p)), "half a bed is a problem");
  check(claude.validateDesign({ ...good, legend: [], layers: [{ rows: ["...", "...", "..."] }] }).some(p => /no blocks/.test(p)), "a drawing with no blocks is a problem");

  // ---- status without a key
  check(claude.status().configured === false, "no key: /claude/status says it isn't configured");

  // ---- the retry loop with a stand-in client
  const sent = [];
  let replies = [];
  const reply = d => ({ id: "msg_" + sent.length, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 2000 }, content: [{ type: "text", text: JSON.stringify(d) }] });
  claude.setClient({ messages: { create: async p => { sent.push(JSON.parse(JSON.stringify(p))); return replies.shift(); } } });
  check(claude.status().configured === true, "with a client: configured");
  replies = [reply(bad), reply(good)];
  const palette = [{ name: "oak_planks", about: "planks" }, { name: "oak_door", about: "door" }];
  let [code, out] = await claude.blueprint({ request: "a hut", palette });
  check(code === 200 && out.design && out.design.name === "Hut", `the second, good reply is kept (${code})`);
  check(out.attempts === 2 && out.problems.length === 0, `two attempts, no problems left (${out.attempts}, ${JSON.stringify(out.problems)})`);
  check(sent.length === 2 && sent[1].messages.length === 3 && /problems/.test(sent[1].messages[2].content), "the problems go back to the model with its reply");
  check(sent[0].model === claude.DEFAULT_MODEL && sent[0].output_config.format.type === "json_schema", `default model ${sent[0].model}, structured output`);
  check(JSON.stringify(sent[0].output_config.format.schema).includes("oak_door"), "the schema's block names are the palette");
  const P = claude.PRICES[claude.DEFAULT_MODEL], want = 2 * (1000 * P.input + 2000 * P.output) / 1e6;
  check(Math.abs(out.cost - want) < 1e-9, `the cost is worked out from the price table ($${out.cost} = $${want})`);
  const recs = claude.callLog();
  check(recs.length === 1 && recs[0].rounds.length === 2 && recs[0].status === "ok", "one call record with two rounds");

  // a revision sends the previous design; an unknown model is refused
  replies = [reply(good)];
  [code, out] = await claude.blueprint({ request: "taller", palette, previous: good, model: "claude-sonnet-5-5" });
  check(code === 200 && /current blueprint/.test(sent[2].messages[0].content) && sent[2].model === "claude-sonnet-5-5", "a revision sends the earlier drawing, with the chosen model");
  [code, out] = await claude.blueprint({ request: "x", palette, model: "gpt-9" });
  check(code === 400 && /unknown model/.test(out.error), "an unknown model is refused");
  // problems left after the last try: the design still comes back, with them
  replies = [reply(bad), reply(bad), reply(bad)];
  claude.setClient({ messages: { create: async p => { sent.push(p); return replies.shift(); } } });
  [code, out] = await claude.blueprint({ request: "a hut", palette });
  check(code === 200 && out.attempts === 3 && out.problems.length > 0 && out.design, "after three bad replies the last design comes back with its problems");
  // the spend cap ($0.05 here): expensive rounds use it up, then requests are refused with capped
  const dear = { ...reply(good), usage: { input_tokens: 10e6, output_tokens: 0 } };
  replies = [dear];
  await claude.blueprint({ request: "a hut", palette });
  [code, out] = await claude.blueprint({ request: "again", palette });
  check(code === 429 && out.capped === true, `over the hourly cap: refused (${code} ${out.error})`);

  // ---- the HTTP side: status, save, list
  const srv = http.createServer((req, res) => {
    const rel = new URL(req.url, "http://x").pathname;
    if (rel.startsWith("/sandbox/api/") && sandbox.http(req, res, rel)) return;
    if (claude.handle(req, res, rel)) return;
    res.writeHead(404).end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const get = (p, body, hdr) => new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request({ host: "127.0.0.1", port, path: p, method: body ? "POST" : "GET", headers: Object.assign(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}, hdr || {}) },
      r => { let s = ""; r.on("data", c => (s += c)); r.on("end", () => res({ code: r.statusCode, j: JSON.parse(s || "{}") })); });
    rq.on("error", rej); if (data) rq.write(data); rq.end();
  });
  let r = await get("/claude/status");
  check(r.code === 200 && r.j.configured === true && r.j.models.includes("claude-haiku-5-5"), "GET /claude/status");
  r = await get("/claude/blueprint", { request: "x", palette }, { Origin: "http://evil.example" });
  check(r.code === 403, "another site's page can't spend the key");
  const name = "ci-designer-test-" + process.pid, file = path.join(ROOT, "sandbox", "structures", name + ".json");
  try {
    r = await get("/sandbox/api/save", { dir: "structures", name, data: { format: "bf-structure-1", ...good } });
    check(r.code === 200 && r.j.ok && fs.existsSync(file), `save writes sandbox/structures/${name}.json`);
    r = await get("/sandbox/api/list?dir=structures");
    check(r.j.names.includes(name), "the library lists it");
    r = await get("/sandbox/api/save", { dir: "scenes", name, data: good });
    check(r.code === 400, "saving into scenes is refused");
    r = await get("/sandbox/api/save", { dir: "structures", name: "../x", data: good });
    check(r.code === 400, "a name with a path is refused");
  } finally { try { fs.unlinkSync(file); } catch (e) { /* not written */ } srv.close(); }

  // ---- drawings and Capture (js/housedesign.js in a bare context)
  global.window = global; global.THREE = {}; global.document = {};
  const load = f => vm.runInThisContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), { filename: f });
  load("blocks.js"); load("noise.js"); BF.CS = 16; load("planet.js"); load("planetgen.js"); load("planetrivers.js"); load("flatgen.js"); load("worldgen.js");
  BF.state = { gen: 4, seed: 1 }; BF.worldgen.init(BF.makeNoise(1), { villages: 10 }); load("blueprints.js"); load("housedesign.js");
  const Hd = BF.houseDesign, t = Hd.toBlueprint(good);
  check(!t.error && t.bp.door && Hd.frontOf(t) === 2, `the hut's door faces south in its grid (front ${Hd.frontOf(t)})`);
  const back = Hd.fromCells(t.cells.map(c => [c[0] + 5, c[1], c[2] - 9, c[3]]), "Hut");
  const t2 = Hd.toBlueprint(back.design), key = c => c.slice(0, 4).join(",");
  const a = new Set(t.cells.map(key)), b = new Set(t2.cells.map(key));
  check(a.size === b.size && [...a].every(k => b.has(k)), `drawing -> blocks -> capture -> drawing keeps every block (${a.size} / ${b.size})`);
  const edit = t.cells.concat([[1, 4, 1, BF.B.diamond_block]]), cap = Hd.fromCells(edit, "Hut");
  check(cap.design.legend.some(e => e.block === "diamond_block") && cap.warnings.some(w => /diamond_block/.test(w)), "a block outside the palette is kept by name and flagged");
  const t3 = Hd.toBlueprint(cap.design);
  check(t3.cells.some(c => c[3] === BF.B.diamond_block && c[1] === 4), "and placed again from the drawing");
  const empty = Hd.fromCells([], "x");
  check(empty.warnings.some(w => /empty/.test(w)) && empty.design.width === 1, "an empty capture gives an empty design and a warning");

  console.log(fails ? `FAIL ${fails} check(s)` : "PASS");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FAIL " + (e && e.stack || e)); process.exit(1); });
