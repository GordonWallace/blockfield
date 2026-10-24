// Claude villager chat (experimental, branch exp-llm-villager): the game's side door to the Claude API.
// debug/server.js hands it /claude/* requests on the game port. The API key stays here, in this Node process: the browser
// never sees it, it is never served as a file, and it never lives in the repo. The key comes from, first match wins:
//   1. the ANTHROPIC_API_KEY environment variable
//   2. the file named by BF_CLAUDE_KEY_FILE
//   3. ~/.config/blockfield/anthropic-key (outside the checkout, so it can't be committed)
// Without a key (CI, a fresh checkout) /claude/status says so and the game spawns no Claude villager.
//   GET  /claude/status  -> { configured, sdk, model }
//   POST /claude/chat    { villager: { name, world, start: [{item, count}], inventory: [{item, count}] }, messages: [{ role, content }] }
//                        -> { reply, stop, tools: [names called], usage } or { error }
// The model gets one tool, check_inventory, answered here from the inventory the page sent with the message.
//   POST /claude/blueprint { villager: { name }, request, palette: [{ name, about }], previous?: design }
//                        -> { design, attempts, problems: [left after the last attempt], usage } or { error }
// The house designer: Claude draws a house as JSON (DESIGN_SCHEMA, forced with structured outputs) from prompts/house-designer.md;
// the shape is checked here (validateDesign) and sent back with the problems for another go, up to DESIGN_TRIES. The page turns
// the design into a builder blueprint (js/housedesign.js).
// Guards: loopback callers only (also under --lan, unless BF_CLAUDE_LAN=1), bounded request size and history, and a per-minute
// and per-day request cap for this process (BF_CLAUDE_PER_MIN, BF_CLAUDE_PER_DAY). Set a spend limit on the key in the Console too.
// Needs the official SDK: `npm install` in debug/ (debug/package.json). The rest of the server has no dependencies and runs without it.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 1024;
const DESIGN_TOKENS = 16000, DESIGN_TRIES = 3, DESIGN_EFFORT = process.env.BF_CLAUDE_DESIGN_EFFORT || "medium";
const MAX_W = 15, MAX_H = 14;   // largest footprint side and most layers a design may have
const MAX_BODY = 128 * 1024, MAX_TURNS = 40, MAX_CHARS = 2000;
const PER_MIN = +process.env.BF_CLAUDE_PER_MIN || 12, PER_DAY = +process.env.BF_CLAUDE_PER_DAY || 400;
const ALLOW_LAN = process.env.BF_CLAUDE_LAN === "1";

let Anthropic = null, sdkError = null;
try { Anthropic = require("@anthropic-ai/sdk"); if (Anthropic.default) Anthropic = Anthropic.default; }
catch (e) { sdkError = "the Anthropic SDK isn't installed: run `npm install` in Blockfield's debug folder"; }

function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  const file = process.env.BF_CLAUDE_KEY_FILE || path.join(os.homedir(), ".config", "blockfield", "anthropic-key");
  try { return fs.readFileSync(file, "utf8").trim() || null; } catch (e) { return null; }
}
const KEY = readKey();
let client = null;
const getClient = () => client || (client = new Anthropic({ apiKey: KEY }));

const recent = [];   // request times this minute
let day = "", today = 0;
function allow() {
  const now = Date.now(), d = new Date().toDateString();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (d !== day) { day = d; today = 0; }
  if (recent.length >= PER_MIN) return "Too many messages this minute: wait a moment";
  if (today >= PER_DAY) return "Daily Claude message cap reached (BF_CLAUDE_PER_DAY)";
  recent.push(now); today++;
  return null;
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
// The villager's instructions live in prompts/villager-system.md, read for every message so edits apply right away.
const PROMPT_FILE = path.resolve(__dirname, "..", "prompts", "villager-system.md");
const FALLBACK = "You are {{name}}, a villager in Blockfield, a blocky voxel world like Minecraft. Stay in character, help honestly, and keep replies short and plain.";
function systemPrompt(v) {
  let t;
  try { t = fs.readFileSync(PROMPT_FILE, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch (e) { t = ""; }
  const fill = { name: clip(v && v.name, 60) || "the Sage", world: clip(v && v.world, 300) || "nothing special.",
    inventory: itemsText(v && v.start) || "nothing at all" };
  return (t || FALLBACK).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

// An inventory the page sent: [{ item, count }] -> "3 Bread, 5 Torch"
function itemsText(list) {
  if (!Array.isArray(list)) return "";
  return list.slice(0, 40).filter(e => e && e.count > 0).map(e => Math.floor(+e.count) + " " + clip(e.item, 40)).join(", ");
}

// The villager's one tool. The page sends what it holds now with every message; the tool answers from that, so the model looks
// only when it needs to (asked what it has, about to offer something) and sees the live contents, not the starting list.
const TOOLS = [{
  name: "check_inventory", strict: true,
  description: "Look in your bag: returns every item you are carrying right now, with counts. Your starting inventory in the instructions " +
    "may be out of date, so use this whenever the traveller asks what you have, or before you mention or offer a specific item.",
  input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
}];
const MAX_ROUNDS = 4;   // tool calls per player message

// Strict shape: alternating turns that start and end with the player, short strings only.
function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.slice(-MAX_TURNS).map(m => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: clip(m && m.content, MAX_CHARS) }));
  while (out.length && out[0].role !== "user") out.shift();
  for (let i = 0; i < out.length; i++) if (out[i].role !== (i % 2 ? "assistant" : "user") || !out[i].content.trim()) return null;
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(obj)); }
const loopback = req => { const a = req.socket.remoteAddress || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };

async function chat(body) {
  const messages = cleanMessages(body && body.messages);
  if (!messages) return [400, { error: "bad conversation" }];
  const limited = allow();
  if (limited) return [429, { error: limited }];
  try {
    const system = systemPrompt(body.villager), used = [], convo = messages.slice();
    let r = null, input = 0, output = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      r = await getClient().messages.create({
        model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: "low" },
        system, tools: TOOLS, tool_choice: { type: "auto" }, messages: convo,
      });
      input += r.usage.input_tokens; output += r.usage.output_tokens;
      if (r.stop_reason !== "tool_use") break;
      // every block goes back as it came (thinking included), then one result per tool call
      convo.push({ role: "assistant", content: r.content });
      const results = r.content.filter(b => b.type === "tool_use").map(b => {
        used.push(b.name);
        if (b.name !== "check_inventory") return { type: "tool_result", tool_use_id: b.id, content: "Unknown tool", is_error: true };
        const now = itemsText(body.villager && body.villager.inventory);
        return { type: "tool_result", tool_use_id: b.id, content: now ? "You are carrying: " + now + "." : "Your bag is empty." };
      });
      convo.push({ role: "user", content: results });
    }
    const reply = r.stop_reason === "refusal" ? "" : r.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    return [200, { reply, stop: r.stop_reason, tools: used, usage: { input, output } }];
  } catch (e) { return apiError(e); }
}

function apiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return [502, { error: "The API key was rejected (check it in the Claude Console)" }];
  if (e instanceof Anthropic.PermissionDeniedError) return [502, { error: "The API key isn't allowed to use " + MODEL }];
  if (e instanceof Anthropic.RateLimitError) return [502, { error: "Claude API rate limit: try again in a moment" }];
  if (e instanceof Anthropic.BadRequestError) return [502, { error: "Claude API rejected the request: " + e.message }];
  if (e instanceof Anthropic.APIConnectionError) return [502, { error: "Couldn't reach the Claude API (network)" }];
  if (e instanceof Anthropic.APIError) return [502, { error: "Claude API error " + e.status + ": " + e.message }];
  return [500, { error: "Claude request failed: " + (e && e.message) }];
}

// ---------------------------------------------------------------- house designer
const DESIGN_PROMPT = path.resolve(__dirname, "..", "prompts", "house-designer.md");
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
// The palette the page offers: [{ name, about }], names the game can place (js/housedesign.js PALETTE).
function cleanPalette(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, 200).filter(p => p && /^[a-z0-9_]{1,48}$/.test(p.name)).map(p => ({ name: p.name, about: clip(p.about, 80) }));
  return out.length ? out : null;
}
function designPrompt(v, palette) {
  let t;
  try { t = fs.readFileSync(DESIGN_PROMPT, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch (e) { t = ""; }
  const fill = { name: clip(v && v.name, 60) || "the Sage", maxw: String(MAX_W), maxh: String(MAX_H),
    palette: palette.map(p => "  - " + p.name + (p.about ? ": " + p.about : "")).join("\n") };
  return (t || "Design a small house as JSON. Blocks: {{palette}}").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

// The problems a builder would hit, in words the model can act on. [] = fine.
function validateDesign(d) {
  const P = [];
  if (!d || typeof d !== "object") return ["the reply is not a blueprint"];
  const W = d.width, D = d.depth, layers = Array.isArray(d.layers) ? d.layers : [];
  if (!(W >= 2 && W <= MAX_W && Number.isInteger(W))) P.push(`width must be a whole number from 2 to ${MAX_W} (it is ${W})`);
  if (!(D >= 2 && D <= MAX_W && Number.isInteger(D))) P.push(`depth must be a whole number from 2 to ${MAX_W} (it is ${D})`);
  if (layers.length < 2 || layers.length > MAX_H) P.push(`a blueprint needs 2 to ${MAX_H} layers (it has ${layers.length})`);
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
  // the floor
  let floor = 0;
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (at(x, 0, z)) floor++;
  if (floor < W * D * 0.6) P.push(`layer 0 is the floor and should be (almost) full; only ${floor} of ${W * D} cells are filled`);
  // doors: on a wall layer, at the edge or next to outside air, with room above for the upper half
  const doors = [];
  for (let y = 0; y < grid.length; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (/_door$/.test(at(x, y, z) || "")) doors.push([x, y, z]);
  if (!doors.length) P.push("there is no door: put an oak_door in an outer wall on layer 1");
  for (const [x, y, z] of doors) {
    if (y === 0) P.push(`the door at column ${x}, row ${z} is on layer 0 (the floor); doors go on layer 1`);
    else if (at(x, y - 1, z) == null) P.push(`the door at layer ${y}, column ${x}, row ${z} has nothing under it to stand on`);
    if (y + 1 < grid.length && at(x, y + 1, z) != null && !/_door$/.test(at(x, y + 1, z))) P.push(`the door at layer ${y}, column ${x}, row ${z} needs air on layer ${y + 1} above it (its upper half goes there)`);
    if (!(x === 0 || z === 0 || x === W - 1 || z === D - 1)) P.push(`the door at layer ${y}, column ${x}, row ${z} is not in an outer wall`);
  }
  // beds come in pairs of neighbouring cells on one layer
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
    if (y === 0 && cells.length) P.push("beds are on layer 0 (the floor); put them on layer 1, standing on the floor");
  }
  return P.slice(0, 12);
}

async function blueprint(body) {
  const palette = cleanPalette(body && body.palette), request = clip(body && body.request, MAX_CHARS).trim();
  if (!palette || !request) return [400, { error: "bad blueprint request" }];
  const limited = allow();
  if (limited) return [429, { error: limited }];
  const names = palette.map(p => p.name), system = designPrompt(body.villager, palette);
  const prev = body.previous && typeof body.previous === "object" ? clip(JSON.stringify(body.previous), 60000) : null;
  const convo = [{ role: "user", content: prev ? "Here is the blueprint you drew earlier:\n" + prev + "\n\nThe traveller asks for these changes: " + request
    : "The traveller wants: " + request }];
  let input = 0, output = 0, design = null, problems = [], attempts = 0;
  try {
    for (; attempts < DESIGN_TRIES; ) {
      attempts++;
      const r = await getClient().messages.create({
        model: MODEL, max_tokens: DESIGN_TOKENS, output_config: { effort: DESIGN_EFFORT, format: { type: "json_schema", schema: designSchema(names) } },
        system, messages: convo,
      });
      input += r.usage.input_tokens; output += r.usage.output_tokens;
      if (r.stop_reason === "refusal") return [200, { design: null, refused: true, attempts, usage: { input, output } }];
      const text = r.content.filter(b => b.type === "text").map(b => b.text).join("");
      try { design = JSON.parse(text); } catch (e) { design = null; }
      problems = r.stop_reason === "max_tokens" ? ["the blueprint was cut off; draw a smaller house"] : validateDesign(design);
      if (!problems.length) break;
      // show it what's wrong and ask for the whole blueprint again (every block of its reply goes back unchanged)
      convo.push({ role: "assistant", content: r.content });
      convo.push({ role: "user", content: "A builder checked that blueprint and found these problems:\n- " + problems.join("\n- ") + "\nSend the whole corrected blueprint." });
    }
    return [200, { design, attempts, problems, usage: { input, output } }];
  } catch (e) { return apiError(e); }
}

// Returns true when it took the request.
function handle(req, res, pathname) {
  if (!pathname.startsWith("/claude/")) return false;
  if (!loopback(req) && !ALLOW_LAN) { json(res, 403, { error: "Claude chat only answers this computer (set BF_CLAUDE_LAN=1 to allow your network)" }); return true; }
  if (pathname === "/claude/status" && req.method === "GET") {
    json(res, 200, { configured: !!KEY, sdk: !sdkError, error: !KEY ? "no API key set" : sdkError, model: MODEL });
    return true;
  }
  const run = { "/claude/chat": chat, "/claude/blueprint": blueprint }[pathname];
  if (run && req.method === "POST") {
    if (!KEY || sdkError) { json(res, 503, { error: !KEY ? "no API key set" : sdkError }); return true; }
    // a page on another site can POST here with a simple content type; only the game's own page may spend the key
    const origin = req.headers.origin, host = req.headers.host;
    if (origin && host && origin.replace(/^https?:\/\//, "") !== host) { json(res, 403, { error: "wrong origin" }); return true; }
    if (!/^application\/json\b/.test(req.headers["content-type"] || "")) { json(res, 415, { error: "JSON only" }); return true; }
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { json(res, 400, { error: "bad JSON" }); return; }
      run(body).then(([code, obj]) => json(res, code, obj), e => json(res, 500, { error: String(e && e.message) }));
    });
    return true;
  }
  json(res, 404, { error: "not found" });
  return true;
}

function describe() { return KEY ? (sdkError ? "key found, but " + sdkError : "on (" + MODEL + ")") : "off (no API key; see debug/claude.js)"; }

module.exports = { handle, describe, cleanMessages, validateDesign, designSchema, MODEL };
