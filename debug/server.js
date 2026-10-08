#!/usr/bin/env node
// Blockfield debug server: the game on one port, a live debug screen on another (for a second monitor).
//   node debug/server.js                 game on http://localhost:8000, debug screen on http://localhost:8001
//   node debug/server.js --game 9000 --debug 9001 --lan
//   (--alerts <file> keeps the debug screen's alerts somewhere other than debug/.alerts.json)
// The game page it serves gets window.BF_DEBUG_FEED set, which turns on js/debugfeed.js; the game POSTs snapshots to
// /push on the debug port and every open debug screen receives them over Server-Sent Events (/events).
// The game can also be served some other way and pointed here with index.html?debugfeed=8001.
// No dependencies: Node's built-in http, fs and path only.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? +args[i + 1] : def; };
const GAME_PORT = opt("game", 8000), DEBUG_PORT = opt("debug", 8001);
const NO_GAME = args.includes("--no-game");               // only the debug screen (serve the game yourself with ?debugfeed=<port>)
const HOST = args.includes("--lan") ? "0.0.0.0" : "127.0.0.1";   // --lan: reachable from other machines on your network
const ROOT = path.resolve(__dirname, ".."), PAGE = path.join(__dirname, "index.html");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".ico": "image/x-icon" };

// ------------------------------------------------------------------ game (static files)
function serveGame(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { res.writeHead(400).end(); return; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split("/").some(p => p.startsWith(".") && p.length > 1)) { res.writeHead(404).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    if (rel === "/index.html") {
      // point the game at this server's debug port, on whatever host name the browser used to reach the game
      const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
      const tag = `<script>window.BF_DEBUG_FEED = ${JSON.stringify("http://" + host + ":" + DEBUG_PORT)};</script>\n`;
      // and stamp each script with its file's time, so a browser can't keep running an old copy it saved (from another server
      // on this port, say) next to new ones: a stale js/villagelog.js once stopped the feed with nothing on the debug screen
      const html = data.toString("utf8").replace(/(<script src="(js\/[\w.-]+\.js))"/g, (m, a, f) => {
        try { return a + "?v=" + Math.floor(fs.statSync(path.join(ROOT, f)).mtimeMs) + '"'; } catch (e) { return m; }
      }), at = html.indexOf("<script");
      data = at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(data);
  });
}

// ------------------------------------------------------------------ debug relay
// Caches what a new debug screen needs: the latest snapshot, every village layout, the last full detail of every village
// (shown greyed out once it unloads) and each village's log history. The game keeps the newest 300 log entries per village;
// the server keeps everything it has seen while it runs, so a long session's history isn't cut off.
const clients = new Set();
// Alerts set up on the debug screen, kept in debug/.alerts.json so they carry over to other games and server restarts.
// av changes with every edit; the game reports the av it holds with each snapshot and gets the list back when it differs.
const ai = args.indexOf("--alerts"), ALERTS = ai >= 0 && args[ai + 1] ? path.resolve(args[ai + 1]) : path.join(__dirname, ".alerts.json");   // --alerts <file>: tests
let alerts = [], av = "0";
try { const o = JSON.parse(fs.readFileSync(ALERTS, "utf8")); if (Array.isArray(o.alerts)) { alerts = o.alerts; av = String(o.av || Date.now()); } } catch (e) { /* none yet */ }
function setAlerts(list) {
  alerts = (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === "string").slice(0, 200).map(a => ({
    id: a.id.slice(0, 40), who: String(a.who || "").slice(0, 60), act: String(a.act || "").slice(0, 30), kind: String(a.kind || "").slice(0, 30),
    text: String(a.text || "").slice(0, 120), on: a.on !== false, created: +a.created || Date.now() }));
  av = String(Date.now());
  try { fs.writeFileSync(ALERTS, JSON.stringify({ av, alerts }, null, 1)); } catch (e) { console.error("[debug] can't save alerts:", e.message); }
  broadcast("alerts", { av, alerts });
}
let latest = null, lastPush = 0, pushes = 0, seed = null;
const layouts = new Map(), details = new Map(), history = new Map(), icons = new Map(), econ = new Map();   // econ: each village's Economy tallies (js/economy.js)   // icons: item id -> {url, name}, sent once by the game

function send(res, event, data) { res.write("event: " + event + "\ndata: " + data + "\n\n"); }
function broadcast(event, obj) { const d = JSON.stringify(obj); for (const c of clients) send(c, event, d); }

const same = (x, y) => x && y && x[0] === y[0] && x[2] === y[2];
// Adds the game's (capped) log to what the server already holds for that village; returns the full history.
function mergeLog(key, a) {
  const h = history.get(key);
  if (!h || !h.length) { history.set(key, a.slice()); return history.get(key); }
  const last = h[h.length - 1];
  let i = a.length - 1;
  while (i >= 0 && !same(a[i], last)) i--;
  if (i >= 0) h.push(...a.slice(i + 1));                        // overlap: append what's new
  else if (a.length && a[0][0] >= last[0]) h.push(...a);         // a gap (more than 300 entries since the last push): keep both
  else history.set(key, a.slice());                              // older than what we hold: a reloaded save or a new world
  return history.get(key);
}

function push(body, res) {
  let s;
  try { s = JSON.parse(body); } catch (e) { res.writeHead(400, cors()).end("bad json"); return; }
  const fresh = !lastPush || Date.now() - lastPush > 5000;
  lastPush = Date.now();
  if (s.info && s.info.seed !== seed) { if (seed !== null) { layouts.clear(); details.clear(); history.clear(); econ.clear(); } seed = s.info.seed; }
  for (const k in s.layouts || {}) layouts.set(k, s.layouts[k]);
  for (const k in s.detail || {}) details.set(k, s.detail[k]);
  for (const k in s.icons || {}) icons.set(k, s.icons[k]);
  for (const k in s.econ || {}) econ.set(k, s.econ[k]);
  const logs = {};
  for (const k in s.logs || {}) logs[k] = { key: k, cap: s.logs[k].cap, entries: mergeLog(k, s.logs[k].entries || []) };
  latest = { ...s, layouts: undefined, logs: undefined, econ: undefined };
  broadcast("snap", { ...s, logs });
  if (fresh) console.log("[debug] game connected");
  // a fresh server holds no layouts or logs yet: ask the game to send them all again
  const resync = pushes++ === 0, stale = !s.alerts || s.alerts.av !== av;   // the game's alerts are out of date: send them along
  res.writeHead(200, cors({ "Content-Type": "text/plain" })).end(stale ? JSON.stringify({ resync, av, alerts }) : resync ? "resync" : "ok");
}
// Allow-Private-Network: Chrome asks before a page from a network address (a LAN IP) talks to this machine's localhost
const cors = (h = {}) => Object.assign({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true" }, h);
const cached = () => {
  const logs = {}, ls = {}, ds = {}, ic = {}, ec = {};
  for (const [k, i] of icons) ic[k] = i;
  for (const [k, e] of econ) ec[k] = e;
  for (const [k, h] of history) logs[k] = { key: k, cap: 300, entries: h };
  for (const [k, l] of layouts) ls[k] = l;
  for (const [k, d] of details) ds[k] = d;
  return { layouts: ls, logs, details: ds, icons: ic, econ: ec };
};

function serveDebug(req, res) {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors({ "Access-Control-Allow-Methods": "POST, GET" })).end(); return; }
  if (url.pathname === "/push" && req.method === "POST") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on("end", () => push(body, res));
    return;
  }
  if (url.pathname === "/alerts" && req.method === "POST") {   // the debug screen's whole alert list, after any change
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let o; try { o = JSON.parse(body); } catch (e) { res.writeHead(400, cors()).end("bad json"); return; }
      setAlerts(o.alerts);
      res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ av, alerts }));
    });
    return;
  }
  if (url.pathname === "/alerts") { res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ av, alerts })); return; }
  if (url.pathname === "/logmatch.js") {   // the log reader the game uses too, so the screen's filters and alerts read entries the same way
    fs.readFile(path.join(ROOT, "js", "logmatch.js"), (err, data) => err ? res.writeHead(404).end() : res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-cache" }).end(data));
    return;
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors() });
    res.write("retry: 1500\n\n");
    // a new screen gets everything cached first (layouts, logs, last known detail of every village), then the latest snapshot
    send(res, "cache", JSON.stringify(cached()));
    send(res, "alerts", JSON.stringify({ av, alerts }));
    if (latest) send(res, "snap", JSON.stringify({ ...latest, age: Date.now() - lastPush }));   // age: an old one isn't shown as live
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/state") { res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ latest, ...cached() })); return; }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.readFile(PAGE, (err, data) => err ? res.writeHead(500).end(String(err)) : res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" }).end(data));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
}
// keep proxies and browsers from timing out an idle stream
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15000).unref();

// Listens on 127.0.0.1 and ::1 (browsers may reach "localhost" over either), or on every address with --lan ("::" is dual-stack).
function listen(handler, port, label) {
  const hosts = HOST === "0.0.0.0" ? ["::"] : ["127.0.0.1", "::1"];
  hosts.forEach((h, i) => {
    const server = http.createServer(handler);
    server.on("error", e => {
      if (i > 0 && e.code !== "EADDRINUSE") return;   // no IPv6 on this machine: IPv4 is enough
      if (h === "::" && e.code !== "EADDRINUSE") { server.listen(port, "0.0.0.0"); return; }
      console.error(`[debug] can't open ${label} on port ${port}: ${e.code === "EADDRINUSE" ? "already in use (try --" + (label === "game" ? "game" : "debug") + " <port>)" : e.message}`);
      process.exit(1);
    });
    server.listen(port, h);
  });
}
const shown = HOST === "0.0.0.0" ? "<this machine's address>" : "localhost";
listen(serveDebug, DEBUG_PORT, "debug screen");
if (!NO_GAME) listen(serveGame, GAME_PORT, "game");
console.log(`Blockfield debug server
  ${NO_GAME ? `Game:         serve it yourself and open index.html?debugfeed=${DEBUG_PORT}` : `Game:         http://${shown}:${GAME_PORT}`}
  Debug screen: http://${shown}:${DEBUG_PORT}   (open this one on your second monitor)
Ctrl+C to stop.`);
