// The sandbox's files on the local server (spec idea-050; the structure and texture libraries of idea-051 / idea-052 add to it): the
// game port answers /sandbox/api/... with what the page can't do itself (list a folder of the checkout, write a file into it).
//   GET  /sandbox/api/list?dir=scenes|structures|textures  -> {names: [...]}  (the .json files there, without the extension)
//   POST /sandbox/api/save {dir, name, data}               -> {ok, path}  writes sandbox/<dir>/<name>.json (structures, textures; spec
//        idea-051's Save). This computer only (also under --lan, unless BF_SANDBOX_LAN=1), the game's own origin, JSON, 1 MB at most.
//        The files are then served as any file of the checkout (sandbox/structures/<name>.json).
// Everything stays inside sandbox/<dir>/ of this checkout; names are letters, digits, - and _ only. Node's built-in modules only.
// API: http(req, res, rel) -> true when it answered; DIRS; root
"use strict";
const fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "..", "sandbox");
const DIRS = ["scenes", "structures", "textures"];
const NAME = /^[\w-]{1,64}$/;
const json = (res, code, o) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(JSON.stringify(o));
const SAVE_DIRS = ["structures", "textures"], MAX_SAVE = 1024 * 1024, ALLOW_LAN = process.env.BF_SANDBOX_LAN === "1";
const loopback = req => { const a = req.socket.remoteAddress || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };
const extra = [];   // more routes: (req, res, rel, url) -> true when answered (debug/claude.js, debug/texture.js)

function list(dir) {
  try { return fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith(".json") && f !== "index.json").map(f => f.slice(0, -5)).filter(n => NAME.test(n)).sort(); }
  catch (e) { return []; }
}
function http(req, res, rel) {
  if (!rel.startsWith("/sandbox/api/")) return false;
  const url = new URL(req.url, "http://x");
  for (const r of extra) if (r(req, res, rel, url)) return true;
  if (rel === "/sandbox/api/list" && req.method === "GET") {
    const dir = url.searchParams.get("dir");
    if (!DIRS.includes(dir)) { json(res, 400, { error: "dir is one of " + DIRS.join(", ") }); return true; }
    json(res, 200, { names: list(dir) });
    return true;
  }
  if (rel === "/sandbox/api/save" && req.method === "POST") { save(req, res); return true; }
  json(res, 404, { error: "no such sandbox call" });
  return true;
}
function save(req, res) {
  if (!loopback(req) && !ALLOW_LAN) { json(res, 403, { error: "saving only works from this computer (BF_SANDBOX_LAN=1 allows your network)" }); return; }
  const origin = req.headers.origin, host = req.headers.host;
  if (origin && host && origin.replace(/^https?:\/\//, "") !== host) { json(res, 403, { error: "wrong origin" }); return; }
  if (!/^application\/json\b/.test(req.headers["content-type"] || "")) { json(res, 415, { error: "JSON only" }); return; }
  let size = 0;
  const chunks = [];
  req.on("data", c => { size += c.length; if (size > MAX_SAVE) { req.destroy(); return; } chunks.push(c); });
  req.on("end", () => {
    let b;
    try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { json(res, 400, { error: "bad JSON" }); return; }
    if (!b || !SAVE_DIRS.includes(b.dir)) { json(res, 400, { error: "dir is one of " + SAVE_DIRS.join(", ") }); return; }
    if (!NAME.test(String(b.name || "")) || b.name === "index") { json(res, 400, { error: "a name is letters, digits, - and _ (64 at most)" }); return; }
    if (!b.data || typeof b.data !== "object") { json(res, 400, { error: "nothing to save" }); return; }
    const dir = path.join(ROOT, b.dir), file = path.join(dir, b.name + ".json");
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(b.data, null, 1) + "\n"); }
    catch (e) { json(res, 500, { error: "couldn't write " + b.dir + "/" + b.name + ".json: " + e.message }); return; }
    json(res, 200, { ok: true, path: "sandbox/" + b.dir + "/" + b.name + ".json" });
  });
}
module.exports = { http, list, DIRS, ROOT, NAME, json, route: fn => extra.push(fn) };
