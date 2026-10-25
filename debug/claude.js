// Claude villager chat (experimental, branch exp-llm-villager): the game's side door to the Claude API.
// debug/server.js hands it /claude/* requests on the game port. The API key stays here, in this Node process: the browser
// never sees it, it is never served as a file, and it never lives in the repo. The key comes from, first match wins:
//   1. the ANTHROPIC_API_KEY environment variable
//   2. the file named by BF_CLAUDE_KEY_FILE
//   3. ~/.config/blockfield/anthropic-key (outside the checkout, so it can't be committed)
// Without a key (CI, a fresh checkout) /claude/status says so and the game spawns no Claude villager.
//   GET  /claude/status  -> { configured, sdk, model }
//   POST /claude/chat    { villager: { name, world, surroundings, start: [{item, count}] }, messages: [{ role, content }] }
//                        -> { reply, stop, tools: [names called], usage }, or { pending: { turn, calls: [{ id, name, input }] } } when
//                           the model calls a tool, or { error }
//   POST /claude/chat    { turn, results: [{ id, content, is_error? }] } -> the same: the game's answers to those calls
// The model's tools (check_inventory, look_around, move_to) are answered by the game (js/claudevillager.js, js/claudesight.js), live.
//   POST /claude/blueprint { villager: { name }, request, palette: [{ name, about }], previous?: design }
//                        -> { design, attempts, problems: [left after the last attempt], usage } or { error }
//   POST /claude/mayor   { mayor: { name, village }, wake, briefing } -> as /claude/chat (a village mayor's review, js/mayor.js; docs/MAYOR.md)
//   POST /claude/mayor   { turn, results } -> the same
// The house designer: Claude draws a house as JSON (DESIGN_SCHEMA, forced with structured outputs) from prompts/house-designer.md;
// the shape is checked here (validateDesign) and sent back with the problems for another go, up to DESIGN_TRIES. The page turns
// the design into a builder blueprint (js/housedesign.js).
// Guards: loopback callers only (also under --lan, unless BF_CLAUDE_LAN=1), bounded request size and history, a per-minute
// and per-day request cap for this process (BF_CLAUDE_PER_MIN, BF_CLAUDE_PER_DAY) and a spend cap per rolling hour, every kind of
// call together (BF_CLAUDE_PER_HOUR_USD, default $1). Set a spend limit on the key in the Console too.
// Every API call is also kept here, in memory only (the last KEEP_CALLS), for the debug screen's API calls panel: the system
// prompt, request settings, every message sent and every reply, round by round. The key is never part of a record.
// Needs the official SDK: `npm install` in debug/ (debug/package.json). The rest of the server has no dependencies and runs without it.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 1024;
const DESIGN_TOKENS = 16000, DESIGN_TRIES = 3, DESIGN_EFFORT = process.env.BF_CLAUDE_DESIGN_EFFORT || "medium";
const MAX_W = 15, MAX_H = 14;   // largest footprint side and most layers a design may have
const MAX_BODY = 128 * 1024, MAX_TURNS = 40, MAX_CHARS = 2000;
const PER_MIN = +process.env.BF_CLAUDE_PER_MIN || 12, PER_DAY = +process.env.BF_CLAUDE_PER_DAY || 400;
const PER_HOUR_USD = process.env.BF_CLAUDE_PER_HOUR_USD != null ? +process.env.BF_CLAUDE_PER_HOUR_USD : 1;   // dollars per rolling hour, every kind of call together
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
// The API reports tokens, not dollars, so the cost is worked out here from MODEL's price list (dollars per million tokens).
// Cache reads cost a tenth of input and 5-minute cache writes a quarter more (mayor reviews cache their prompt; chat doesn't).
const PRICE = { input: 0.10, output: 0.50 };
const cost = u => ((u.input_tokens || 0) * PRICE.input + (u.cache_read_input_tokens || 0) * PRICE.input * 0.1
  + (u.cache_creation_input_tokens || 0) * PRICE.input * 1.25 + (u.output_tokens || 0) * PRICE.output) / 1e6;
const copy = o => JSON.parse(JSON.stringify(o));
const tell = rec => { for (const f of watchers) { try { f(rec); } catch (e) { /* a watcher's problem, not the call's */ } } };
// One record per player action (a chat message, a design request), however many API rounds it takes.
function startCall(kind, params, system, messages) {
  const rec = { id: ++callId, kind, t: Date.now(), model: MODEL, price: PRICE, cost: 0, spent, params, system, messages: copy(messages), earlier: messages.length - 1, rounds: [], status: "running", ms: 0 };   // earlier: chat turns the page sent as history
  calls.push(rec);
  if (calls.length > KEEP_CALLS) calls.shift();
  tell(rec);
  return rec;
}
// After each API reply: the reply, then whatever goes back to the model next (tool results, a builder's list of problems).
function roundDone(rec, r, ms, next) {
  rec.messages.push({ role: "assistant", content: copy(r.content), round: rec.rounds.length });
  const c = cost(r.usage);
  rec.rounds.push({ stop: r.stop_reason, usage: copy(r.usage), cost: c, ms, id: r.id });
  rec.cost = (rec.cost || 0) + c; spent += c; rec.spent = spent; spends.push([Date.now(), c]);
  if (next) rec.messages.push(copy(next));
  tell(rec);
}
function endCall(rec, status, extra) {
  Object.assign(rec, { status, ms: Date.now() - rec.t }, extra || {});
  tell(rec);
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
// The villager's instructions live in prompts/villager-system.md, read for every message so edits apply right away.
const PROMPT_FILE = path.resolve(__dirname, "..", "prompts", "villager-system.md");
const FALLBACK = "You are {{name}}, a villager in Blockfield, a blocky voxel world like Minecraft. Stay in character, help honestly, and keep replies short and plain.";
function systemPrompt(v) {
  let t;
  try { t = fs.readFileSync(PROMPT_FILE, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch (e) { t = ""; }
  const fill = { name: clip(v && v.name, 60) || "the Sage", world: clip(v && v.world, 300) || "nothing special.",
    surroundings: clip(v && v.surroundings, 1500) || "somewhere in the wide world.",
    inventory: itemsText(v && v.start) || "nothing at all" };
  return (t || FALLBACK).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

// An inventory the page sent: [{ item, count }] -> "3 Bread, 5 Torch"
function itemsText(list) {
  if (!Array.isArray(list)) return "";
  return list.slice(0, 40).filter(e => e && e.count > 0).map(e => Math.floor(+e.count) + " " + clip(e.item, 40)).join(", ");
}

// The villager's tools. The game answers them, not this server: when the model calls one, /claude/chat hands the call back to the
// page, which looks at the world as it is at that moment (the Sage's bag, what it can see from where it stands) and posts the result
// to carry on. So the answers are live whether or not the game is paused, and the game can later start conversations of its own.
const NO_INPUT = { type: "object", properties: {}, required: [], additionalProperties: false };
const TOOLS = [{
  name: "check_inventory", strict: true,
  description: "Look in your bag: returns every item you are carrying right now, with counts. Your starting inventory in the instructions " +
    "may be out of date, so use this whenever the traveller asks what you have, or before you mention or offer a specific item.",
  input_schema: NO_INPUT,
}, {
  name: "look_around", strict: true,
  description: "Look around from where you stand: returns the creatures, people, plants, trees, crops, buildings, workstations and land you " +
    "can see right now, each with a compass direction and distance. Only what is in your line of sight is listed (nothing behind walls, " +
    "hills or trees), and you see less far in the dark. Use it whenever the traveller asks what is around, about something nearby, or " +
    "before you describe your surroundings; don't guess.",
  input_schema: NO_INPUT,
}, {
  name: "move_to",
  description: "Walk somewhere. Use it when you have a reason to go: the traveller asks you to come along, to go and look at something, or " +
    "to fetch news from a place. It returns at once; you walk like any villager (around walls and water, through doors), and the game " +
    "tells you in a later message when you arrive or if you can't get there. Then look_around and report back: your words still reach " +
    "the traveller from afar. Targets: \"traveller\" (go to them), \"home\" (your usual spot by the world spawn), \"village\" (the nearest " +
    "village), \"direction\" (some blocks off toward a compass point, e.g. something you saw with look_around), \"stop\" (stay where you are).",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["traveller", "home", "village", "direction", "stop"] },
      direction: { type: "string", enum: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"], description: "For target direction: which way." },
      distance: { type: "integer", description: "For target direction: how many blocks, 3 to 100." },
      reason: { type: "string", description: "A few words on why you are going, for the game's log." },
    },
    required: ["target"],
    additionalProperties: false,
  },
}];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
const MAX_RESULT = 12000;   // characters of one tool result
const PENDING_MS = 120000;  // a tool call the page hasn't answered in this long is dropped
const MAX_ROUNDS = 6;   // model rounds per player message (each tool call adds one)

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

// POST /claude/chat with { villager, messages } starts a reply; with { turn, results: [{ id, content, is_error? }] } it answers the tool calls
// of a reply in progress. Either way the answer is the reply ({ reply, stop, tools, usage }) or, when the model calls tools,
// { pending: { turn, calls: [{ id, name, input }] } } for the page to answer.
const pending = new Map();   // turn -> { rec, convo, system, used, input, output, round, calls, t }
let turnId = 0;
async function chat(body) {
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.t > PENDING_MS) { pending.delete(k); endCall(p.rec, "error", { error: "the game never answered the tool call" }); }
  if (body && body.turn != null) return toolResults(body);
  const messages = cleanMessages(body && body.messages);
  if (!messages) return [400, { error: "bad conversation" }];
  const limited = allow();
  if (limited) return [429, { error: limited }];
  const system = systemPrompt(body.villager);
  const rec = startCall("chat", { max_tokens: MAX_TOKENS, effort: "low", tools: TOOLS, tool_choice: "auto" }, system, messages);
  return step({ rec, convo: messages.slice(), system, used: [], input: 0, output: 0, round: 0, cfg: CHAT });
}
// How each kind of conversation is run: its tools, reply size, effort, rounds, and whether its prompt is cached.
const CHAT = { tools: TOOLS, names: TOOL_NAMES, maxTokens: MAX_TOKENS, effort: "low", rounds: MAX_ROUNDS, cache: false };
function toolResults(body) {
  const p = pending.get(String(body.turn));
  if (!p) return [404, { error: "that reply is no longer waiting for a tool result" }];
  const got = Array.isArray(body.results) ? body.results : [];
  const results = p.calls.map(c => {
    const r = got.find(x => x && x.id === c.id);
    if (!p.cfg.names.has(c.name)) return { type: "tool_result", tool_use_id: c.id, content: "Unknown tool", is_error: true };
    if (!r) return { type: "tool_result", tool_use_id: c.id, content: "No answer from the game", is_error: true };
    const out = { type: "tool_result", tool_use_id: c.id, content: clip(r.content, MAX_RESULT) || "(nothing)" };
    if (r.is_error) out.is_error = true;
    return out;
  });
  pending.delete(String(body.turn));
  p.convo.push({ role: "user", content: results });
  p.rec.messages.push(copy(p.convo[p.convo.length - 1])); tell(p.rec);
  return step(p);
}
// One model round, then either the reply, or the tool calls handed to the page (the state waits in `pending`).
async function step(p) {
  const { rec } = p;
  try {
    const t0 = Date.now();
    const C = p.cfg;
    if (p.round && hourSpend() >= PER_HOUR_USD) throw new Error("hourly spend cap reached mid-conversation ($" + PER_HOUR_USD + ")");
    const req = { model: MODEL, max_tokens: C.maxTokens, output_config: { effort: C.effort }, system: p.system, tools: C.tools, tool_choice: { type: "auto" }, messages: p.convo };
    if (C.cache) req.cache_control = { type: "ephemeral" };   // the shared prompt and tools, then each round of the review, read back at a tenth of the price
    const r = await getClient().messages.create(req);
    p.input += r.usage.input_tokens; p.output += r.usage.output_tokens; p.round++;
    p.cacheRead = (p.cacheRead || 0) + (r.usage.cache_read_input_tokens || 0);
    roundDone(rec, r, Date.now() - t0);
    if (r.stop_reason === "tool_use" && p.round < C.rounds) {
      // every block goes back as it came (thinking included); the page answers each call
      p.convo.push({ role: "assistant", content: r.content });
      p.calls = r.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, input: b.input || {} }));
      for (const c of p.calls) p.used.push(c.name);
      const unknown = p.calls.filter(c => !C.names.has(c.name));
      if (unknown.length) return toolResults(Object.assign({ turn: park(p) }, { results: [] }));   // answered as errors here
      return [200, { pending: { turn: park(p), calls: p.calls } }];
    }
    const reply = r.stop_reason === "refusal" ? "" : r.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    const usage = { input: p.input, output: p.output, cacheRead: p.cacheRead || 0, cost: +rec.cost.toFixed(6) };
    endCall(rec, r.stop_reason === "refusal" ? "refused" : "ok", { usage });
    return [200, { reply, stop: r.stop_reason, tools: p.used, usage, hour: +hourSpend().toFixed(4) }];
  } catch (e) { const out = apiError(e); endCall(rec, "error", { error: out[1].error }); return out; }
}
function park(p) {
  const turn = String(++turnId);
  p.t = Date.now(); pending.set(turn, p);
  while (pending.size > 8) { const [k, o] = pending.entries().next().value; pending.delete(k); endCall(o.rec, "error", { error: "dropped: too many replies waiting" }); }
  return turn;
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

// ---------------------------------------------------------------- village mayors (js/mayor.js)
// A mayor's review: the game wakes it (each morning, and on events), sends the reason and a briefing it wrote from the village's own numbers
// and the mayor's saved records, and answers its tools live, like the Sage's. Every review starts fresh (no chat history): what the mayor
// remembers is what it wrote into its records with the tools. The prompt (prompts/mayor-system.md) and the tools are the same for every
// mayor, so they are cached and shared; the village's own text comes after them.
//   POST /claude/mayor { mayor: { name, village }, wake, briefing } -> as /claude/chat: { reply, ... } or { pending: { turn, calls } }
//   POST /claude/mayor { turn, results } -> the same
const MAYOR_PROMPT = path.resolve(__dirname, "..", "prompts", "mayor-system.md");
const STRUCTS = ["small_house", "medium_house", "cottage", "veg_farm", "pen", "pasture", "coop", "sty", "well", "lamp_posts", "market_stall", "workshop",
  "bakehouse", "glassworks", "apiary", "stable", "bridge"];
const METRICS = ["population", "free_beds", "homeless", "starving", "food_days", "happiness", "unemployed", "structures", "births_week", "deaths_week"];
const obj = (props, req) => ({ type: "object", properties: props, required: req || Object.keys(props), additionalProperties: false });
const MAYOR_TOOLS = [{
  name: "check_structure",
  description: "Ask whether a structure can actually be built here now, the same checks a builder makes before it starts: the village's land " +
    "and surroundings (horses, animals, sand, grass, a busy river crossing), the materials (what each builder holds, what is missing, and whether " +
    "anyone in the village sells it right now), recent failures, and whether there is room for it. Use it before you order something you aren't sure of.",
  input_schema: obj({ type: { type: "string", enum: STRUCTS }, builder: { type: "string", description: "A builder's name, to check against that builder's own bag; leave empty for every builder." } }, ["type"]),
}, {
  name: "list_villagers", strict: true,
  description: "Every villager in the village now: name, job, what they are doing, whether they are hungry or starving, have a bed, and food on hand (in bread).",
  input_schema: NO_INPUT,
}, {
  name: "market_report", strict: true,
  description: "What villagers wanted and couldn't buy in the last two game days (hours waited), and what they hold for sale that isn't selling.",
  input_schema: NO_INPUT,
}, {
  name: "give_orders",
  description: "Decide what a builder should build next. You then walk over and tell them yourself; the orders only apply once you have talked to " +
    "them, and they finish the structure they are on (or buying for) first. `build` is a queue taken first to last; `avoid` lists types they should " +
    "not start on their own. Each queued type is checked as with check_structure and any that can't be built now is refused (the result says why); " +
    "only the rest are queued. An empty build list and empty avoid list releases the builder to choose for themselves. New orders replace earlier ones.",
  input_schema: obj({
    builder: { type: "string", description: "The builder's name, or \"all\" for every builder." },
    build: { type: "array", items: obj({ type: { type: "string", enum: STRUCTS }, why: { type: "string" } }), description: "Up to 5 structures, in order." },
    avoid: { type: "array", items: { type: "string", enum: STRUCTS } },
    reason: { type: "string", description: "One sentence: why, for your records and the village log." },
  }),
}, {
  name: "set_goal",
  description: "Add a goal the game will measure for you: a metric, the target, and the game day to judge it on. You will see its progress in every " +
    "briefing and the result on that day. Keep at most 5 open goals.",
  input_schema: obj({
    text: { type: "string", description: "The goal in a few words." },
    metric: { type: "string", enum: METRICS },
    structure: { type: "string", enum: STRUCTS, description: "For metric \"structures\": which kind to count (finished ones)." },
    op: { type: "string", enum: [">=", "<="] },
    target: { type: "number" },
    by_day: { type: "integer", description: "The game day to judge it on." },
  }, ["text", "metric", "op", "target", "by_day"]),
}, {
  name: "close_goal",
  description: "Close an open goal early (met, no longer wanted, or replaced), with a short reason.",
  input_schema: obj({ id: { type: "integer" }, reason: { type: "string" } }),
}, {
  name: "update_strategy",
  description: "Replace your strategy: your current read of the village and plan, in your own words (at most 800 characters). It is shown to you at the top of every briefing.",
  input_schema: obj({ text: { type: "string" } }),
}, {
  name: "write_journal",
  description: "Add a dated entry to your journal: a decision and why, or what you noticed (at most 300 characters). The last 15 entries are in every briefing.",
  input_schema: obj({ text: { type: "string" } }),
}, {
  name: "update_lessons",
  description: "Replace your lessons: what you have learned works or doesn't in this village (at most 600 characters). Briefings show it; update it when old journal entries are about to roll off.",
  input_schema: obj({ text: { type: "string" } }),
}];
const MAYOR = { tools: MAYOR_TOOLS, names: new Set(MAYOR_TOOLS.map(t => t.name)), maxTokens: 4096, effort: "medium", rounds: 10, cache: true };
function mayorPrompt() {
  try { return fs.readFileSync(MAYOR_PROMPT, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch (e) { return "You are the mayor of a village in Blockfield. Use the tools to look after it."; }
}
async function mayor(body) {
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.t > PENDING_MS) { pending.delete(k); endCall(p.rec, "error", { error: "the game never answered the tool call" }); }
  if (body && body.turn != null) return toolResults(body);
  const m = body && body.mayor, briefing = clip(body && body.briefing, 24000).trim(), wake = clip(body && body.wake, 600).trim();
  if (!m || !briefing || !wake) return [400, { error: "bad mayor review" }];
  const limited = allow();
  if (limited) return [429, { error: limited }];
  const system = mayorPrompt();
  const messages = [{ role: "user", content: "Why you were woken: " + wake + "\n\n" + briefing }];
  const rec = startCall("mayor", { max_tokens: MAYOR.maxTokens, effort: MAYOR.effort, tools: MAYOR_TOOLS, tool_choice: "auto", cache_control: "ephemeral", mayor: clip(m.name, 60) + " of " + clip(m.village, 60) }, system, messages);
  return step({ rec, convo: messages.slice(), system, used: [], input: 0, output: 0, round: 0, cfg: MAYOR });
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
  const schema = designSchema(names);
  const rec = startCall("design", { max_tokens: DESIGN_TOKENS, effort: DESIGN_EFFORT, format: { type: "json_schema", schema } }, system, convo);
  try {
    for (; attempts < DESIGN_TRIES; ) {
      attempts++;
      const t0 = Date.now();
      const r = await getClient().messages.create({
        model: MODEL, max_tokens: DESIGN_TOKENS, output_config: { effort: DESIGN_EFFORT, format: { type: "json_schema", schema } },
        system, messages: convo,
      });
      input += r.usage.input_tokens; output += r.usage.output_tokens;
      if (r.stop_reason === "refusal") { roundDone(rec, r, Date.now() - t0); endCall(rec, "refused", { usage: { input, output } }); return [200, { design: null, refused: true, attempts, usage: { input, output } }]; }
      const text = r.content.filter(b => b.type === "text").map(b => b.text).join("");
      try { design = JSON.parse(text); } catch (e) { design = null; }
      problems = r.stop_reason === "max_tokens" ? ["the blueprint was cut off; draw a smaller house"] : validateDesign(design);
      if (!problems.length || attempts >= DESIGN_TRIES) { roundDone(rec, r, Date.now() - t0); if (!problems.length) break; continue; }
      // show it what's wrong and ask for the whole blueprint again (every block of its reply goes back unchanged)
      convo.push({ role: "assistant", content: r.content });
      convo.push({ role: "user", content: "A builder checked that blueprint and found these problems:\n- " + problems.join("\n- ") + "\nSend the whole corrected blueprint." });
      roundDone(rec, r, Date.now() - t0, convo[convo.length - 1]);
    }
    endCall(rec, problems.length ? "problems" : "ok", { usage: { input, output }, problems });
    return [200, { design, attempts, problems, usage: { input, output } }];
  } catch (e) { const out = apiError(e); endCall(rec, "error", { error: out[1].error }); return out; }
}

// Returns true when it took the request.
function handle(req, res, pathname) {
  if (!pathname.startsWith("/claude/")) return false;
  if (!loopback(req) && !ALLOW_LAN) { json(res, 403, { error: "Claude chat only answers this computer (set BF_CLAUDE_LAN=1 to allow your network)" }); return true; }
  if (pathname === "/claude/status" && req.method === "GET") {
    json(res, 200, { configured: !!KEY, sdk: !sdkError, error: !KEY ? "no API key set" : sdkError, model: MODEL, hour: +hourSpend().toFixed(4), hourCap: PER_HOUR_USD });
    return true;
  }
  const run = { "/claude/chat": chat, "/claude/blueprint": blueprint, "/claude/mayor": mayor }[pathname];
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

// The debug screen's view: every kept record, and a callback for each new or updated one.
const callLog = () => calls;
const onCall = f => { watchers.add(f); return () => watchers.delete(f); };

module.exports = { handle, describe, callLog, onCall, cleanMessages, validateDesign, designSchema, MODEL, MAYOR_TOOLS, hourSpend };
