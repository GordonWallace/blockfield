// The sandbox's files on the local server (spec idea-050; the structure and texture libraries of idea-051 / idea-052 add to it): the
// game port answers /sandbox/api/... with what the page can't do itself (list a folder of the checkout, write a file into it).
//   GET  /sandbox/api/list?dir=scenes|structures|textures  -> {names: [...]}  (the .json files there, without the extension)
// Everything stays inside sandbox/<dir>/ of this checkout; names are letters, digits, - and _ only. Node's built-in modules only.
// API: http(req, res, rel) -> true when it answered; DIRS; root
"use strict";
const fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "..", "sandbox");
const DIRS = ["scenes", "structures", "textures"];
const NAME = /^[\w-]{1,64}$/;
const json = (res, code, o) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(JSON.stringify(o));
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
  json(res, 404, { error: "no such sandbox call" });
  return true;
}
module.exports = { http, list, DIRS, ROOT, NAME, json, route: fn => extra.push(fn) };
