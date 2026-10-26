#!/usr/bin/env node
// Blockfield debug server: the game on one port, a live debug screen on another (for a second monitor).
//   node debug/server.js                 game on http://localhost:8000, debug screen on http://localhost:8001
//   node debug/server.js --game 9000 --debug 9001 --lan
//   (--no-isolate serves the game without the cross-origin isolation headers, so without shared memory: see ISOLATE)
//   (--alerts <file> keeps the debug screen's alerts somewhere other than debug/.alerts.json)
//   (--saves <dir> keeps the world server's saves somewhere other than saves/; --no-world runs no world server; --test lets a test page
//   run code in the simulation, BFT.sim: tests only, never on a server others can reach; --workers N: the world server's region workers
//   per world, spec r15-39, default every core but two, at most 8; --split always|never: split the regions' thinking always / never, js/rplay.js; --verify N (tests): compare the workers' copies every N split ticks; --coarse on|off: far villages coarse or full detail whatever each world's option, js/gameopts.js)
// It also runs the world server (spec r15-41, server/world.js): the game's simulation in this process, with the page as its client
// over a WebSocket on the game port (/sim). Ctrl+C saves its worlds before stopping.
// The game page it serves gets window.BF_DEBUG_FEED set, which turns on js/debugfeed.js; the game POSTs snapshots to
// /push on the debug port and every open debug screen receives them over Server-Sent Events (/events).
// The game can also be served some other way and pointed here with index.html?debugfeed=8001.
// The game page also gets window.BF_BUILD, the commit and branch of this checkout (read from .git), for the game log (js/gamelog.js).
// No dependencies: Node's built-in modules only.
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

// ------------------------------------------------------------------ the checkout's commit
// Read from .git directly (no git needed): HEAD, then the branch's ref file or packed-refs. A worktree's .git file points at its
// own git dir, whose commondir holds the refs. Re-read at most every 2 s; the game version comes from js/version.js.
let buildAt = 0, buildCache = { commit: null, branch: null, version: null };
function readBuild() {
  if (Date.now() - buildAt < 2000) return buildCache;
  buildAt = Date.now();
  const out = { commit: null, branch: null, version: null };
  try { out.version = (/BF\.VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "js", "version.js"), "utf8")) || [])[1] || null; } catch (e) { /* none */ }
  try {
    let gd = path.join(ROOT, ".git");
    if (fs.statSync(gd).isFile()) gd = path.resolve(ROOT, fs.readFileSync(gd, "utf8").replace(/^gitdir:\s*/, "").trim());
    let common = gd;
    try { common = path.resolve(gd, fs.readFileSync(path.join(gd, "commondir"), "utf8").trim()); } catch (e) { /* not a worktree */ }
    const h = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim(), m = /^ref:\s*(\S+)/.exec(h);
    if (!m) out.commit = h;
    else {
      out.branch = m[1].replace(/^refs\/heads\//, "");
      try { out.commit = fs.readFileSync(path.join(common, m[1]), "utf8").trim(); }
      catch (e) { const l = fs.readFileSync(path.join(common, "packed-refs"), "utf8").split("\n").find(x => x.endsWith(" " + m[1])); out.commit = l ? l.split(" ")[0] : null; }
    }
    if (out.commit && !/^[0-9a-f]{7,64}$/.test(out.commit)) out.commit = null;
  } catch (e) { /* not a git checkout */ }
  return (buildCache = out);
}

// ------------------------------------------------------------------ game (static files)
// Cross-origin isolation (spec r15-35): with these two headers the game page is crossOriginIsolated, which browsers require before they
// allow SharedArrayBuffer (chunk block data in shared memory, js/world.js). COEP is "credentialless" rather than "require-corp": the
// page's other-origin files (three.js from cdnjs, Google Fonts) then load without needing a Cross-Origin-Resource-Policy header, only
// without cookies. Browsers without credentialless (Safari) leave the page unisolated and the game uses ordinary memory, as it does
// opened as a file. Sent on everything the game port serves (the page, its scripts, the workers' scripts), but not the wiki.
// --no-isolate leaves them off (tests of the fallback).
const ISOLATE = args.includes("--no-isolate") ? {} : { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };
function serveGame(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { res.writeHead(400).end(); return; }
  if (rel.includes("\0")) { res.writeHead(404).end(); return; }   // fs throws on a NUL byte (/%00)
  if (rel === "/wiki") { res.writeHead(301, { Location: "/wiki/" }).end(); return; }   // Blockfieldpedia (wiki/index.html)
  if (rel.startsWith("/saves/")) { if (!world || !world.http(req, res, rel)) res.writeHead(404, { "Content-Type": "text/plain" }).end("No world server"); return; }   // export / import (spec r15-42)
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split("/").some(p => p.startsWith(".") && p.length > 1)) { res.writeHead(404).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    if (rel === "/index.html") {
      // point the game at this server's debug port, on whatever host name the browser used to reach the game
      const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
      const b = readBuild();
      const tag = `<script>window.BF_DEBUG_FEED = ${JSON.stringify("http://" + host + ":" + DEBUG_PORT)}; window.BF_BUILD = ${JSON.stringify({ commit: b.commit, branch: b.branch }).replace(/</g, "\\u003c")};</script>\n`;
      // and stamp each script with its file's time, so a browser can't keep running an old copy it saved (from another server
      // on this port, say) next to new ones: a stale js/villagelog.js once stopped the feed with nothing on the debug screen
      const html = data.toString("utf8").replace(/(<script src="(js\/[\w.-]+\.js))"/g, (m, a, f) => {
        try { return a + "?v=" + Math.floor(fs.statSync(path.join(ROOT, f)).mtimeMs) + '"'; } catch (e) { return m; }
      }), at = html.indexOf("<script");
      data = at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
    }
    res.writeHead(200, Object.assign({ "Content-Type": type, "Cache-Control": "no-cache" }, rel.startsWith("/wiki/") ? {} : ISOLATE)).end(data);
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
// The villager picked on the debug screen (its village key#slot, js/daytimeline.js): passed to the game in the answer to its next
// snapshot, like the alerts; the game then adds that villager's day timeline to its snapshots. day: the last timeline it sent.
let pick = null, pv = "0", day = null;
// A planet debug toggle clicked on the debug screen ({tints | wedge | sphere: bool}, js/view.js setDebug): passed to the game the same
// way. The game's snapshots carry the toggles as they are (pt), which is what the screen shows.
let ptReq = null, ptv = "0";
// The open world's game log (js/gamelog.js): {w (world id), name, head (its header line), base (index of lines[0]), lines}, all of it
// once the game has sent it. Debug screens get it whole when they connect (/events cache, or /glog) and the new entries in each snap.
let glog = null;
const GLOG_CAP = 100000;
// Each village's numbers over game time (js/villagestats.js, saved with the world): the History panel (debug/vhist.js, debug/vhist-view.js).
const vhist = require("./vhist.js")();
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
  if (!s || typeof s !== "object" || Array.isArray(s)) { res.writeHead(400, cors()).end("not a snapshot"); return; }
  const o = take(s);
  res.writeHead(200, cors({ "Content-Type": "text/plain" })).end(typeof o === "string" ? o : JSON.stringify(o));
}
// A snapshot from the game (POSTed by the page, or made by the world server in this process, server/world.js): cached and relayed
// to the debug screens. Returns the answer: "ok", "resync", or an object (see below).
function take(s) {
  const fresh = !lastPush || Date.now() - lastPush > 5000;
  lastPush = Date.now();
  if (s.info && typeof s.info === "object" && s.info.seed !== seed) { if (seed !== null) { layouts.clear(); details.clear(); history.clear(); econ.clear(); day = null; } seed = s.info.seed; }
  const obj = o => (o && typeof o === "object" ? o : {});
  for (const k in obj(s.layouts)) layouts.set(k, s.layouts[k]);
  for (const k in obj(s.detail)) details.set(k, s.detail[k]);
  for (const k in obj(s.icons)) icons.set(k, s.icons[k]);
  for (const k in obj(s.econ)) econ.set(k, s.econ[k]);
  if (s.day !== undefined) day = s.day && typeof s.day === "object" ? s.day : null;
  const logs = {};
  for (const k in obj(s.logs)) {
    const l = s.logs[k], a = l && Array.isArray(l.entries) ? l.entries.filter(Array.isArray) : [];   // log entries are arrays; skip anything else
    logs[k] = { key: k, cap: l && l.cap, entries: mergeLog(k, a) };
  }
  // the game log: append when the entries follow on from what we hold; otherwise tell the game where we are (glogAt)
  let glogAt = null, gl;
  const g = s.glog && typeof s.glog === "object" && Array.isArray(s.glog.lines) ? s.glog : null;
  if (g && (g.reset || !glog || glog.w !== g.w)) {
    if (g.from === g.base) { glog = { w: g.w, name: g.name, head: g.head, base: g.base, lines: g.lines.slice() }; gl = { w: g.w, name: g.name, head: g.head, base: g.base, from: g.from, lines: g.lines, reset: true }; }
    else glogAt = g.base;
  } else if (g) {
    if (g.from === glog.base + glog.lines.length) {
      glog.lines.push(...g.lines); glog.head = g.head; glog.name = g.name;
      if (g.base > glog.base) { glog.lines.splice(0, Math.min(glog.lines.length, g.base - glog.base)); glog.base = g.base; }   // the game dropped its oldest
      if (glog.lines.length > GLOG_CAP) { const n = glog.lines.length - GLOG_CAP; glog.lines.splice(0, n); glog.base += n; }
      if (g.lines.length) gl = { w: g.w, name: g.name, head: g.head, base: glog.base, from: g.from, lines: g.lines };
    } else glogAt = glog.base + glog.lines.length;
  }
  const disk = readBuild(), build = s.build !== undefined && disk.commit && s.build !== disk.commit ? disk : null;   // the files on disk changed
  latest = { ...s, layouts: undefined, logs: undefined, econ: undefined, glog: undefined, vhist: undefined };
  broadcast("snap", { ...s, logs, glog: gl, vhist: undefined });
  let vh = null;
  try { vh = vhist.take(s); } catch (e) { console.error("[debug] village history:", e.message); }   // never in the way of the snapshot
  if (vh) broadcast("vhist", vh);
  if (fresh) console.log("[debug] game connected");
  // a fresh server holds no layouts or logs yet: ask the game to send them all again
  const resync = pushes++ === 0, stale = !s.alerts || s.alerts.av !== av;   // the game's alerts are out of date: send them along
  const staleP = !!s.pick && s.pick.pv !== pv;                                 // so is its picked villager
  const staleT = !!ptReq && !!s.pt && s.pt.tv !== ptv;                         // and a planet toggle it hasn't applied
  const staleS = (s.screens | 0) !== clients.size;                             // and how many debug screens are open (the perf meter runs while any is, js/perf.js)
  const o = stale || staleP || staleT || staleS || glogAt != null || build ? Object.assign({ resync }, stale ? { av, alerts } : {}, staleP ? { pick, pv } : {}, staleT ? { pt: ptReq, ptv } : {}, staleS ? { screens: clients.size } : {}, glogAt != null ? { glogAt } : {}, build ? { build } : {}) : null;
  return o || (resync ? "resync" : "ok");
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
  return { layouts: ls, logs, details: ds, icons: ic, econ: ec, day, glog };
};

function serveDebug(req, res) {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors({ "Access-Control-Allow-Methods": "POST, GET" })).end(); return; }
  if (url.pathname === "/push" && req.method === "POST") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on("end", () => safe(() => push(body, res))(req, res));
    return;
  }
  if (url.pathname === "/alerts" && req.method === "POST") {   // the debug screen's whole alert list, after any change
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", safe(() => {
      let o; try { o = JSON.parse(body); } catch (e) { res.writeHead(400, cors()).end("bad json"); return; }
      if (!o || typeof o !== "object" || Array.isArray(o)) { res.writeHead(400, cors()).end("not an alert list"); return; }
      setAlerts(o.alerts);
      res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ av, alerts }));
    }).bind(null, req, res));
    return;
  }
  if (url.pathname === "/pick" && req.method === "POST") {   // the debug screen picked a villager ({key}) or none ({key: null})
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", safe(() => {
      let o; try { o = JSON.parse(body); } catch (e) { res.writeHead(400, cors()).end("bad json"); return; }
      const k = o && typeof o.key === "string" ? o.key.slice(0, 80) : null;
      if (k !== pick) { pick = k; pv = String(Date.now()); if (!k) day = null; }
      res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ pick, pv }));
    }).bind(null, req, res));
    return;
  }
  if (url.pathname === "/planet" && req.method === "POST") {   // the debug screen flipped a planet toggle ({tints | wedge | sphere: bool})
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 1e3) req.destroy(); });
    req.on("end", safe(() => {
      let o; try { o = JSON.parse(body); } catch (e) { res.writeHead(400, cors()).end("bad json"); return; }
      const t = {};
      for (const k of ["tints", "wedge", "sphere"]) if (o && typeof o[k] === "boolean") t[k] = o[k];
      if (!Object.keys(t).length) { res.writeHead(400, cors()).end("no toggle"); return; }
      ptReq = t; ptv = String(Date.now());
      res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ pt: ptReq, ptv }));
    }).bind(null, req, res));
    return;
  }
  if (url.pathname === "/alerts") { res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify({ av, alerts })); return; }
  if (url.pathname === "/vhist") { res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify(vhist.cached())); return; }   // the village history as the server holds it
  if (url.pathname === "/vhist-view.js") {   // the History panel's code (kept out of index.html)
    fs.readFile(path.join(__dirname, "vhist-view.js"), (err, data) => err ? res.writeHead(404).end() : res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-cache" }).end(data));
    return;
  }
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
    send(res, "vhist", JSON.stringify({ reset: true, data: vhist.cached() }));
    if (latest) send(res, "snap", JSON.stringify({ ...latest, age: Date.now() - lastPush }));   // age: an old one isn't shown as live
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/glog") { res.writeHead(200, cors({ "Content-Type": "application/json" })).end(JSON.stringify(glog)); return; }   // the game log as the server holds it
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
// A request that still throws gets a 500 instead of stopping the server (and with it the game page and every debug screen).
const safe = handler => (req, res) => {
  try { handler(req, res); } catch (e) {
    console.error("[debug] " + req.method + " " + req.url + ": " + (e && e.message));
    try { if (!res.headersSent) res.writeHead(500, cors()); res.end(); } catch (e2) { /* the connection is gone */ }
  }
};
function listen(handler, port, label) {
  const hosts = HOST === "0.0.0.0" ? ["::"] : ["127.0.0.1", "::1"];
  return hosts.map((h, i) => {
    const server = http.createServer(safe(handler));
    server.on("error", e => {
      if (i > 0 && e.code !== "EADDRINUSE") return;   // no IPv6 on this machine: IPv4 is enough
      if (h === "::" && e.code !== "EADDRINUSE") { server.listen(port, "0.0.0.0"); return; }
      console.error(`[debug] can't open ${label} on port ${port}: ${e.code === "EADDRINUSE" ? "already in use (try --" + (label === "game" ? "game" : "debug") + " <port>)" : e.message}`);
      process.exit(1);
    });
    server.listen(port, h);
    return server;
  });
}
const shown = HOST === "0.0.0.0" ? "<this machine's address>" : "localhost";
listen(serveDebug, DEBUG_PORT, "debug screen");
const gameServers = NO_GAME ? [] : listen(serveGame, GAME_PORT, "game");
// The world server (spec r15-41, server/world.js): the simulation in this process, the page its client over ws://<game>/sim.
// --no-world leaves it out (the page then runs the simulation itself); --saves <dir> keeps its saved worlds somewhere other than saves/.
const si = args.indexOf("--saves"), SAVES = si >= 0 && args[si + 1] ? path.resolve(args[si + 1]) : path.join(ROOT, "saves");
const world = NO_GAME || args.includes("--no-world") ? null : require("../server/world.js").start({
  servers: gameServers, saves: SAVES, test: args.includes("--test"), workers: opt("workers", 0), coarse: args.includes("--coarse") ? args[args.indexOf("--coarse") + 1] : null, split: args.includes("--split") ? args[args.indexOf("--split") + 1] : null, verify: opt("verify", 0), version: readBuild().version, build: { commit: readBuild().commit, branch: readBuild().branch }, debug: { push: take, screens: () => clients.size } });
let stopping = false;
const stop = () => {
  if (stopping) process.exit(1);   // (a second Ctrl+C: at once)
  stopping = true;
  if (!world) process.exit(0);
  console.log("[world] saving and stopping...");
  world.stop().then(() => process.exit(0), () => process.exit(1));
  setTimeout(() => process.exit(1), 20000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`Blockfield debug server
  ${NO_GAME ? `Game:         serve it yourself and open index.html?debugfeed=${DEBUG_PORT}` : `Game:         http://${shown}:${GAME_PORT}`}
  Debug screen: http://${shown}:${DEBUG_PORT}   (open this one on your second monitor)${NO_GAME ? "" : `
  Blockfieldpedia: http://${shown}:${GAME_PORT}/wiki/   (the Blockfield wiki)`}${world ? `
  World server: ws://${shown}:${GAME_PORT}/sim   (the simulation runs here; saves in ${SAVES})` : ""}
Ctrl+C to stop.`);
