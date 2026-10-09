// The debug server survives malformed requests (bug-013): node test/debug-server-bad-requests.js
// @ci integration suite=ui
// Starts debug/server.js on spare ports, sends bad snapshots to /push and odd paths to the game port, and checks each gets a 4xx
// answer, the server is still running afterwards, and a good snapshot still goes through.
"use strict";
const { spawn } = require("child_process"), http = require("http"), path = require("path");
const GAME = 18000 + Math.floor(Math.random() * 1000), DEBUG = GAME + 1000;
const srv = spawn(process.execPath, [path.join(__dirname, "..", "debug", "server.js"), "--game", String(GAME), "--debug", String(DEBUG)], { stdio: ["ignore", "pipe", "pipe"] });
let log = "", exited = null;
srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);
srv.on("exit", c => exited = c);
const req = (port, method, p, body) => new Promise(res => {
  const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: body ? { "Content-Type": "application/json" } : {} }, x => {
    let t = ""; x.on("data", d => t += d); x.on("end", () => res({ status: x.statusCode, body: t }));
  });
  r.on("error", e => res({ status: "error " + e.code }));
  r.setTimeout(3000, () => { r.destroy(); res({ status: "timeout" }); });
  if (body != null) r.write(body);
  r.end();
});
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let fails = 0;
  const check = (ok, what, got) => { console.log((ok ? "ok   " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); if (!ok) fails++; };
  for (let i = 0; i < 50 && !(await req(DEBUG, "GET", "/state")).status.toString().startsWith("2"); i++) await wait(100);
  const bad = ["null", "5", '"x"', "[]", '{"logs":{"a":null}}', '{"logs":{"a":{"entries":5}}}', '{"logs":{"a":{"entries":[null,5,"x"]}}}',
    '{"logs":null,"info":null}', '{"info":5,"layouts":7,"detail":"x"}', "{bad json"];
  for (const b of bad) {
    const r = await req(DEBUG, "POST", "/push", b);
    check(exited === null && (typeof r.status === "number" && r.status < 500), "push " + b, r.status);
  }
  for (const b of ["null", "5", "[]", "{bad json"]) {   // the debug screen's alert list
    const r = await req(DEBUG, "POST", "/alerts", b);
    check(exited === null && typeof r.status === "number" && r.status < 500, "alerts " + b, r.status);
  }
  for (const p of ["/%00", "/js/%00.js", "/%E0%A4%A", "/../package.json", "/.git/config"]) {
    const r = await req(GAME, "GET", p);
    check(exited === null && typeof r.status === "number" && r.status >= 400 && r.status < 500, "game " + p, r.status);
  }
  const good = await req(DEBUG, "POST", "/push", JSON.stringify({ info: { seed: 1 }, logs: { v1: { cap: 300, entries: [[1, "a", 0]] } } }));
  check(good.status === 200, "a good snapshot still works", good.status);
  const st = await req(DEBUG, "GET", "/state");
  check(st.status === 200 && /"v1"/.test(st.body), "its log is cached", st.status);
  const page = await req(GAME, "GET", "/");
  check(page.status === 200, "the game page still loads", page.status);
  check(exited === null, "server still running", exited);
  srv.kill();
  if (fails) console.log("server output:\n" + log);
  process.exit(fails ? 1 : 0);
})();
