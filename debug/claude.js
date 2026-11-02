// The sandbox structure designer's side door to the Claude API (spec idea-051; ported from the experimental Claude villager, branch
// exp-llm-villager, without its chat, tools or mayor). debug/server.js hands it /claude/* requests on the game port. The API key stays
// here, in this Node process: the browser never sees it, it is never served as a file, and it never lives in the repo. First match wins:
//   1. the ANTHROPIC_API_KEY environment variable
//   2. the file named by BF_CLAUDE_KEY_FILE
//   3. ~/.config/blockfield/anthropic-key (outside the checkout, so it can't be committed)
// Without a key (CI, a fresh checkout) /claude/status says so and the Designer panel offers nothing else.
//   GET  /claude/status    -> { configured, sdk, error, model, models: [ids], hour, hourCap }
//   POST /claude/blueprint { request, palette: [{ name, about }], previous?: design, model? }
//                          -> { design, attempts, problems: [left after the last attempt], usage, cost, model } or { error }
// Claude draws a structure as JSON (designSchema, forced with structured outputs) from prompts/structure-designer.md; the shape is checked
// here (validateDesign) and sent back with the problems for another go, up to DESIGN_TRIES. The page turns the design into cells
// (js/housedesign.js) and stamps them into the sandbox world (js/designer.js).
// The model: BF_CLAUDE_MODEL (default claude-haiku-5-5), or the panel's setting (a request's `model`), one of PRICES only, so the cost
// shown is right. Gordon's rule for these tools: Haiku unless he picks otherwise, and $1 an hour at most.
// Guards: loopback callers only (also under --lan, unless BF_CLAUDE_LAN=1), the game's own origin, JSON only, bounded request size, a
// per-minute and per-day request cap for this process (BF_CLAUDE_PER_MIN, BF_CLAUDE_PER_DAY) and a spend cap per rolling hour
// (BF_CLAUDE_PER_HOUR_USD, default $1). Set a spend limit on the key in the Claude Console too.
// Every API call is kept here, in memory only (the last KEEP_CALLS), for the debug screen's API calls panel: the system prompt, request
// settings, every message sent and every reply, round by round, with its cost. The key is never part of a record.
// Needs the official SDK: `npm install` in debug/ (debug/package.json). The rest of the server has no dependencies and runs without it.
// Tests: setClient(fake) puts a stand-in for the SDK client (and a pretend key) in place (test/designer-api.js).
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");

// dollars per million tokens (the API reports tokens, not dollars). Haiku 5.5's price is for prompts up to 100K tokens; a design is far less.
const PRICES = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
const DEFAULT_MODEL = PRICES[process.env.BF_CLAUDE_MODEL] ? process.env.BF_CLAUDE_MODEL : "claude-haiku-5-5";
const DESIGN_TOKENS = 16000, DESIGN_TRIES = 3, DESIGN_EFFORT = process.env.BF_CLAUDE_DESIGN_EFFORT || "medium";
const MAX_W = 24, MAX_H = 24;   // largest footprint side and most layers a design may have
const MAX_BODY = 256 * 1024, MAX_CHARS = 2000;
const PER_MIN = +process.env.BF_CLAUDE_PER_MIN || 12, PER_DAY = +process.env.BF_CLAUDE_PER_DAY || 400;
const PER_HOUR_USD = process.env.BF_CLAUDE_PER_HOUR_USD != null ? +process.env.BF_CLAUDE_PER_HOUR_USD : 1;   // dollars per rolling hour
const ALLOW_LAN = process.env.BF_CLAUDE_LAN === "1";

let Anthropic = null, sdkError = null;
try { Anthropic = require("@anthropic-ai/sdk"); if (Anthropic.default) Anthropic = Anthropic.default; }
catch (e) { sdkError = "the Anthropic SDK isn't installed: run `npm install` in Blockfield's debug folder"; }

function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  const file = process.env.BF_CLAUDE_KEY_FILE || path.join(os.homedir(), ".config", "blockfield", "anthropic-key");
  try { return fs.readFileSync(file, "utf8").trim() || null; } catch (e) { return null; }
}
let KEY = readKey();
let client = null;
const getClient = () => client || (client = new Anthropic({ apiKey: KEY }));
function setClient(fake) { client = fake; KEY = fake ? "test" : readKey(); sdkError = fake ? null : sdkError; recent.length = 0; spends.length = 0; }

const recent = [];   // request times this minute
let day = "", today = 0;
function allow() {
  const now = Date.now(), d = new Date().toDateString();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (d !== day) { day = d; today = 0; }
  if (recent.length >= PER_MIN) return "Too many requests this minute: wait a moment";
  if (today >= PER_DAY) return "Daily Claude request cap reached (BF_CLAUDE_PER_DAY)";
  if (hourSpend() >= PER_HOUR_USD) return "Hourly Claude spend cap reached ($" + PER_HOUR_USD + " in the last hour, BF_CLAUDE_PER_HOUR_USD)";
  recent.push(now); today++;
  return null;
}

// ---------------------------------------------------------------- API call records (debug screen)
const KEEP_CALLS = 60, calls = [], watchers = new Set();
let callId = 0, spent = 0;   // spent: dollars for every call this server run, kept or not
const spends = [];           // [time, dollars] of each API round in the last hour (the hourly cap)
function hourSpend() {
  const now = Date.now();
  while (spends.length && now - spends[0][0] > 3600000) spends.shift();
  return spends.reduce((a, x) => a + x[1], 0);
}
const cost = (u, P) => ((u.input_tokens || 0) * P.input + (u.cache_read_input_tokens || 0) * P.input * 0.1
  + (u.cache_creation_input_tokens || 0) * P.input * 1.25 + (u.output_tokens || 0) * P.output) / 1e6;
const copy = o => JSON.parse(JSON.stringify(o));
const tell = rec => { for (const f of watchers) { try { f(rec); } catch (e) { /* a watcher's problem, not the call's */ } } };
// One record per design request, however many API rounds it takes.
function startCall(kind, model, params, system, messages) {
  const rec = { id: ++callId, kind, t: Date.now(), model, price: PRICES[model], cost: 0, spent, params, system, messages: copy(messages), earlier: 0, rounds: [], status: "running", ms: 0 };
  calls.push(rec);
  if (calls.length > KEEP_CALLS) calls.shift();
  tell(rec);
  return rec;
}
// After each API reply: the reply, then whatever goes back to the model next (the list of problems).
function roundDone(rec, r, ms, next) {
  rec.messages.push({ role: "assistant", content: copy(r.content), round: rec.rounds.length });
  const c = cost(r.usage || {}, rec.price);
  rec.rounds.push({ stop: r.stop_reason, usage: copy(r.usage || {}), cost: c, ms, id: r.id });
  rec.cost = (rec.cost || 0) + c; spent += c; rec.spent = spent; spends.push([Date.now(), c]);
  if (next) rec.messages.push(copy(next));
  tell(rec);
}
function endCall(rec, status, extra) {
  Object.assign(rec, { status, ms: Date.now() - rec.t }, extra || {});
  tell(rec);
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(obj)); }
const loopback = req => { const a = req.socket.remoteAddress || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };

function apiError(e, model) {
  const A = Anthropic || {};
  const is = k => A[k] && e instanceof A[k];
  if (is("AuthenticationError")) return [502, { error: "The API key was rejected (check it in the Claude Console)" }];
  if (is("PermissionDeniedError")) return [502, { error: "The API key isn't allowed to use " + model }];
  if (is("RateLimitError")) return [502, { error: "Claude API rate limit: try again in a moment" }];
  if (is("BadRequestError")) return [502, { error: "Claude API rejected the request: " + e.message }];
  if (is("APIConnectionError")) return [502, { error: "Couldn't reach the Claude API (network)" }];
  if (is("APIError")) return [502, { error: "Claude API error " + e.status + ": " + e.message }];
  return [500, { error: "Claude request failed: " + (e && e.message) }];
}

// ---------------------------------------------------------------- the designer
const DESIGN_PROMPT = path.resolve(__dirname, "..", "prompts", "structure-designer.md");
const AIR = new Set([".", " "]);
function designSchema(names) {
  const obj = (props, req) => ({ type: "object", properties: props, required: req || Object.keys(props), additionalProperties: false });
  return obj({
    name: { type: "string" }, summary: { type: "string" }, notes: { type: "string" },
    width: { type: "integer" }, depth: { type: "integer" },
    legend: { type: "array", items: obj({ symbol: { type: "string" }, block: { type: "string", enum: names } }) },
    layers: { type: "array", items: obj({ label: { type: "string" }, rows: { type: "array", items: { type: "string" } } }) },
  });
}
// The palette the page offers: [{ name, about }], names the game can place (js/housedesign.js), plus any kept from a capture.
function cleanPalette(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, 300).filter(p => p && /^[a-z0-9_]{1,48}$/.test(p.name)).map(p => ({ name: p.name, about: clip(p.about, 80) }));
  return out.length ? out : null;
}
function designPrompt(palette) {
  let t;
  try { t = fs.readFileSync(DESIGN_PROMPT, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch (e) { t = ""; }
  const fill = { maxw: String(MAX_W), maxh: String(MAX_H), palette: palette.map(p => "  - " + p.name + (p.about ? ": " + p.about : "")).join("\n") };
  return (t || "Design a structure as JSON. Blocks: {{palette}}").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

// The problems a builder would hit, in words the model can act on. [] = fine. A structure needn't be a house: no door is fine, but a
// door that is there must be buildable, and beds come in pairs.
function validateDesign(d) {
  const P = [];
  if (!d || typeof d !== "object") return ["the reply is not a blueprint"];
  const W = d.width, D = d.depth, layers = Array.isArray(d.layers) ? d.layers : [];
  if (!(W >= 1 && W <= MAX_W && Number.isInteger(W))) P.push(`width must be a whole number from 1 to ${MAX_W} (it is ${W})`);
  if (!(D >= 1 && D <= MAX_W && Number.isInteger(D))) P.push(`depth must be a whole number from 1 to ${MAX_W} (it is ${D})`);
  if (layers.length < 1 || layers.length > MAX_H) P.push(`a blueprint needs 1 to ${MAX_H} layers (it has ${layers.length})`);
  if (P.length) return P;
  const legend = new Map();
  for (const e of d.legend || []) {
    if (!e || typeof e.symbol !== "string" || [...e.symbol].length !== 1) { P.push(`legend symbol ${JSON.stringify(e && e.symbol)} must be exactly one character`); continue; }
    if (AIR.has(e.symbol)) { P.push(`"${e.symbol}" is air and can't be in the legend`); continue; }
    if (legend.has(e.symbol) && legend.get(e.symbol) !== e.block) P.push(`symbol "${e.symbol}" is given two different blocks`);
    legend.set(e.symbol, e.block);
  }
  const grid = [], unknown = new Set();
  layers.forEach((L, y) => {
    const rows = Array.isArray(L && L.rows) ? L.rows : [];
    if (rows.length !== D) P.push(`layer ${y} has ${rows.length} rows; every layer needs exactly depth = ${D}`);
    const g = [];
    rows.forEach((r, z) => {
      const cs = [...String(r)];
      if (cs.length !== W) P.push(`layer ${y} row ${z} is ${cs.length} characters long; every row needs exactly width = ${W}`);
      g.push(cs.map(c => { if (AIR.has(c)) return null; if (!legend.has(c)) { unknown.add(c); return null; } return legend.get(c); }));
    });
    grid.push(g);
  });
  if (unknown.size) P.push("these symbols are used but not in the legend: " + [...unknown].map(c => JSON.stringify(c)).join(", "));
  if (P.length) return P.slice(0, 12);
  const at = (x, y, z) => (grid[y] && grid[y][z] && grid[y][z][x]) || null;
  let any = 0;
  for (const g of grid) for (const r of g) for (const c of r) if (c) any++;
  if (!any) P.push("the blueprint has no blocks at all");
  for (let y = 0; y < grid.length; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    if (!/_door$/.test(at(x, y, z) || "")) continue;
    if (y > 0 && at(x, y - 1, z) == null) P.push(`the door at layer ${y}, column ${x}, row ${z} has nothing under it to stand on`);
    if (y + 1 < grid.length && at(x, y + 1, z) != null && !/_door$/.test(at(x, y + 1, z))) P.push(`the door at layer ${y}, column ${x}, row ${z} needs air on layer ${y + 1} above it (its upper half goes there)`);
  }
  for (let y = 0; y < grid.length; y++) {
    const cells = [];
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (/_bed$/.test(at(x, y, z) || "")) cells.push([x, z]);
    const used = new Set(), key = (x, z) => x + "," + z;
    for (const [x, z] of cells) {
      if (used.has(key(x, z))) continue;
      const mate = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([dx, dz]) => [x + dx, z + dz]).find(([a, b]) => cells.some(c => c[0] === a && c[1] === b) && !used.has(key(a, b)));
      if (!mate) { P.push(`the bed cell at layer ${y}, column ${x}, row ${z} has no second bed cell next to it (a bed is two cells)`); continue; }
      used.add(key(x, z)); used.add(key(mate[0], mate[1]));
    }
  }
  return P.slice(0, 12);
}

async function blueprint(body) {
  const palette = cleanPalette(body && body.palette), request = clip(body && body.request, MAX_CHARS).trim();
  if (!palette || !request) return [400, { error: "bad blueprint request" }];
  const model = body.model == null || body.model === "" ? DEFAULT_MODEL : String(body.model);
  if (!PRICES[model]) return [400, { error: "unknown model " + model + " (one of " + Object.keys(PRICES).join(", ") + ")" }];
  const limited = allow();
  if (limited) return [429, { error: limited, capped: /spend cap/.test(limited) }];
  const names = palette.map(p => p.name), system = designPrompt(palette);
  const prev = body.previous && typeof body.previous === "object" ? clip(JSON.stringify(body.previous), 120000) : null;
  const convo = [{ role: "user", content: prev ? "Here is the current blueprint (it may include changes made by hand in the world):\n" + prev + "\n\nChange it like this: " + request
    : "Design this: " + request }];
  let input = 0, output = 0, design = null, problems = [], attempts = 0;
  const schema = designSchema(names);
  const rec = startCall("design", model, { max_tokens: DESIGN_TOKENS, effort: DESIGN_EFFORT, format: { type: "json_schema", schema } }, system, convo);
  try {
    for (; attempts < DESIGN_TRIES; ) {
      attempts++;
      const t0 = Date.now();
      const r = await getClient().messages.create({
        model, max_tokens: DESIGN_TOKENS, output_config: { effort: DESIGN_EFFORT, format: { type: "json_schema", schema } },
        system, messages: convo,
      });
      input += (r.usage && r.usage.input_tokens) || 0; output += (r.usage && r.usage.output_tokens) || 0;
      if (r.stop_reason === "refusal") { roundDone(rec, r, Date.now() - t0); endCall(rec, "refused", { usage: { input, output } }); return [200, { design: null, refused: true, attempts, usage: { input, output }, cost: rec.cost, model }]; }
      const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      try { design = JSON.parse(text); } catch (e) { design = null; }
      problems = r.stop_reason === "max_tokens" ? ["the blueprint was cut off; draw a smaller structure"] : validateDesign(design);
      if (!problems.length || attempts >= DESIGN_TRIES) { roundDone(rec, r, Date.now() - t0); if (!problems.length) break; continue; }
      // show it what's wrong and ask for the whole blueprint again (its reply goes back unchanged)
      convo.push({ role: "assistant", content: r.content });
      convo.push({ role: "user", content: "A builder checked that blueprint and found these problems:\n- " + problems.join("\n- ") + "\nSend the whole corrected blueprint." });
      roundDone(rec, r, Date.now() - t0, convo[convo.length - 1]);
    }
    endCall(rec, problems.length ? "problems" : "ok", { usage: { input, output }, problems });
    return [200, { design, attempts, problems, usage: { input, output }, cost: rec.cost, model }];
  } catch (e) { const out = apiError(e, model); endCall(rec, "error", { error: out[1].error }); return out; }
}

const status = () => ({ configured: !!KEY, sdk: !sdkError, error: !KEY ? "no API key set" : sdkError, model: DEFAULT_MODEL, models: Object.keys(PRICES),
  prices: PRICES, hour: +hourSpend().toFixed(4), hourCap: PER_HOUR_USD });

// Returns true when it took the request.
function handle(req, res, pathname) {
  if (!pathname.startsWith("/claude/")) return false;
  if (!loopback(req) && !ALLOW_LAN) { json(res, 403, { error: "The designer only answers this computer (set BF_CLAUDE_LAN=1 to allow your network)" }); return true; }
  if (pathname === "/claude/status" && req.method === "GET") { json(res, 200, status()); return true; }
  if (pathname === "/claude/blueprint" && req.method === "POST") {
    if (!KEY || sdkError) { json(res, 503, { error: !KEY ? "no API key set" : sdkError }); return true; }
    // a page on another site can POST here with a simple content type; only the game's own page may spend the key
    const origin = req.headers.origin, host = req.headers.host;
    if (origin && host && origin.replace(/^https?:\/\//, "") !== host) { json(res, 403, { error: "wrong origin" }); return true; }
    if (!/^application\/json\b/.test(req.headers["content-type"] || "")) { json(res, 415, { error: "JSON only" }); return true; }
    let size = 0;
    const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { json(res, 400, { error: "bad JSON" }); return; }
      blueprint(body).then(([code, obj]) => json(res, code, obj), e => json(res, 500, { error: String(e && e.message) }));
    });
    return true;
  }
  json(res, 404, { error: "not found" });
  return true;
}

function describe() { return KEY ? (sdkError ? "key found, but " + sdkError : "on (" + DEFAULT_MODEL + ", $" + PER_HOUR_USD + "/hour cap)") : "off (no API key; see debug/claude.js)"; }

// The debug screen's view: every kept record, and a callback for each new or updated one.
const callLog = () => calls;
const onCall = f => { watchers.add(f); return () => watchers.delete(f); };

module.exports = { handle, describe, callLog, onCall, validateDesign, designSchema, blueprint, status, setClient, hourSpend, PRICES, DEFAULT_MODEL, MAX_W, MAX_H };
