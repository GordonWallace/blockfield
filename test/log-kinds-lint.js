// @ci baseline suite=ui
// Every kind of village log entry the game writes is listed in js/logmatch.js KINDS. Plain node, no browser: node test/log-kinds-lint.js
// The debug screen's event filter lists KINDS; a kind missing from it only appears once logged, so "Select none" then one kind could
// still show it (a CI flake in test/debug-screen.js "births only", 2026-11-02). Reads each BF.vlog.log(rec, "kind", ...) call and each
// profession's vlog(m, "kind", ...) wrapper call in js/ (comments stripped); fails on a kind KINDS lacks.
const fs = require("fs"), path = require("path");
const JS = path.join(__dirname, "..", "js");
require(path.join(JS, "logmatch.js"));
const { KINDS } = globalThis.BFLog;
const used = new Map();   // kind -> first file:line
for (const f of fs.readdirSync(JS).filter(f => f.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(JS, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  const re = /\bvlog(?:\.log)?\(\s*[\w.]+\s*,\s*["']([a-z]+)["']\s*,/g;
  for (let m; (m = re.exec(src));) if (!used.has(m[1])) used.set(m[1], f + ":" + src.slice(0, m.index).split("\n").length);
}
let bad = 0;
for (const [k, at] of [...used].sort()) if (!KINDS[k]) { console.log("FAIL kind \"" + k + "\" (" + at + ") is not in js/logmatch.js KINDS"); bad++; }
console.log(bad ? bad + " kind(s) missing" : "ok   all " + used.size + " logged kinds are in KINDS (" + [...used.keys()].sort().join(", ") + ")");
process.exit(bad ? 1 : 0);
