#!/usr/bin/env node
// Blockfield debug server: the game on one port, a live debug screen on another (for a second monitor).
//   node debug/server.js                 game on http://localhost:8000, debug screen on http://localhost:8001
//   node debug/server.js --game 9000 --debug 9001 --lan
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
      const html = data.toString("utf8"), at = html.indexOf("<script");
      data = at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(data);
  });
}

// ------------------------------------------------------------------ debug relay
const clients = new Set();
let latest = null, layout = null, log = null, lastPush = 0;

function send(res, event, data) { res.write("event: " + event + "\ndata: " + data + "\n\n"); }
function broadcast(event, obj) { const d = JSON.stringify(obj); for (const c of clients) send(c, event, d); }

function push(body, res) {
  let s;
  try { s = JSON.parse(body); } catch (e) { res.writeHead(400, cors()).end("bad json"); return; }
  const fresh = !lastPush || Date.now() - lastPush > 5000;
  lastPush = Date.now();
  if (s.layout) layout = s.layout;
  if (s.log) log = s.log;
  latest = s;
  broadcast("snap", s);
  if (fresh) console.log("[debug] game connected");
  // a village snapshot whose layout/log this server never saw (it restarted, or the game reloaded mid-village): ask again
  const need = s.here && (!layout || layout.key !== s.here.key || !log || log.key !== s.here.key);
  res.writeHead(200, cors({ "Content-Type": "text/plain" })).end(need ? "resync" : "ok");
}
const cors = (h = {}) => Object.assign({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, h);

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
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors() });
    res.write("retry: 1500\n\n");
    // a new screen gets the cached layout and log first, then the latest snapshot
    if (layout) send(res, "snap", JSON.stringify({ layout, t: 0 }));
    if (log) send(res, "snap", JSON.stringify({ log, t: 0 }));
    if (latest) send(res, "snap", JSON.stringify({ ...latest, layout: undefined, log: undefined }));
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/state") { res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ latest, layout, log })); return; }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.readFile(PAGE, (err, data) => err ? res.writeHead(500).end(String(err)) : res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" }).end(data));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
}
// keep proxies and browsers from timing out an idle stream
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15000).unref();

function listen(server, port, label) {
  server.on("error", e => { console.error(`[debug] can't open ${label} on port ${port}: ${e.code === "EADDRINUSE" ? "already in use (try --" + (label === "game" ? "game" : "debug") + " <port>)" : e.message}`); process.exit(1); });
  server.listen(port, HOST);
}
const shown = HOST === "0.0.0.0" ? "<this machine's address>" : "localhost";
listen(http.createServer(serveDebug), DEBUG_PORT, "debug screen");
if (!NO_GAME) listen(http.createServer(serveGame), GAME_PORT, "game");
console.log(`Blockfield debug server
  ${NO_GAME ? `Game:         serve it yourself and open index.html?debugfeed=${DEBUG_PORT}` : `Game:         http://${shown}:${GAME_PORT}`}
  Debug screen: http://${shown}:${DEBUG_PORT}   (open this one on your second monitor)
Ctrl+C to stop.`);
