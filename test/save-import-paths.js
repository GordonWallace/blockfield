// @ci baseline suite=world
// A world file can't write outside its own world's folder (bug-070). Plain node, no browser: node test/save-import-paths.js
// Starts debug/server.js on spare ports with its saves in a temp folder, and checks:
//   - a .bfworld whose game log names a batch "../../Victim/save" (or a path out of the saves folder) is refused with a reason, and
//     the other world's save and the folder outside are untouched (js/savefile.js checkLog, on the server and in the browser);
//   - server/savedir.js refuses any part that isn't a world part (put and get), so nothing else can name a file through it;
//   - a world imported with a proper log exports with the same log; a world whose log head on disk names a bad batch (one imported
//     before the fix) still exports, with that batch left out.
"use strict";
const { spawn } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), v8 = require("v8");
const SaveFile = require("../js/savefile.js"), SaveDir = require("../server/savedir.js");
const saves = fs.mkdtempSync(path.join(os.tmpdir(), "bf-paths-")), outside = fs.mkdtempSync(path.join(os.tmpdir(), "bf-outside-"));
const GAME = 18500 + Math.floor(Math.random() * 1000), DEBUG = GAME + 1000;
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const call = (method, p, body) => new Promise((res, rej) => {
  const r = http.request({ host: "127.0.0.1", port: GAME, path: p, method, headers: { "X-Blockfield": "saves", "Content-Length": body ? body.length : 0 } }, rs => {
    const parts = []; rs.on("data", d => parts.push(d)); rs.on("end", () => res({ status: rs.statusCode, body: Buffer.concat(parts) }));
  });
  r.on("error", rej); r.end(body || undefined);
});
const json = r => { try { return JSON.parse(r.body.toString("utf8")); } catch (e) { return {}; } };
const meta = (id, name) => ({ id, name, seed: 3, version: 3, gen: 4, gameMode: "survival", lastPlayed: 1 });

(async () => {
  // savedir on its own
  const sd = SaveDir.open(saves);
  sd.put("wunit", "meta", meta("wunit", "Unit"));
  for (const part of ["log:../../Unit/save", "log:../x", "log:1/../../x", "log:", "log:12a", "bogus", "log:0000000001"]) {
    let threw = null;
    try { sd.put("wunit", part, ["x"]); } catch (e) { threw = e; }
    check(threw && threw.code === "EBADPART", "savedir refuses to write part " + JSON.stringify(part));
    threw = null;
    try { sd.get("wunit", part); } catch (e) { threw = e; }
    check(threw && threw.code === "EBADPART", "savedir refuses to read part " + JSON.stringify(part));
  }
  sd.put("wunit", "log:000000007", ["fine"]);
  check(JSON.stringify(sd.get("wunit", "log:000000007")) === '["fine"]', "savedir still writes and reads a proper log batch");
  sd.remove("wunit");

  // the file check on its own (the browser's import uses it too)
  const bad = (seq, what) => { let threw = null; try { SaveFile.decode(SaveFile.encode({ meta: meta("w", "W"), data: { version: 3 }, log: { head: { batches: [[seq, 1]] }, lists: [[]] } })); } catch (e) { threw = e; } check(!!threw, "a world file is refused with a log batch numbered " + what); };
  bad("../../Victim/save", "a path"); bad(-1, "-1"); bad(1.5, "1.5"); bad("1", "\"1\" (a string)"); bad(1e12, "1e12"); bad(null, "null");

  const srv = spawn(process.execPath, [path.join(__dirname, "..", "debug", "server.js"), "--game", String(GAME), "--debug", String(DEBUG), "--saves", saves], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
  for (let i = 0; i < 200 && !/Ctrl\+C/.test(out); i++) await new Promise(r => setTimeout(r, 100));
  check(/Ctrl\+C/.test(out), "debug/server.js started");
  try {
    const victim = { version: 3, seed: 3, precious: "my 100 hours" };
    let r = await call("POST", "/saves/import", SaveFile.packSync({ meta: meta("wvictim", "Victim"), data: victim, log: null }));
    check(r.status === 200 && json(r).ok, "a good world imports");
    const rel = path.relative(path.join(saves, "Evil", "log"), path.join(outside, "planted"));
    for (const seq of ["../../Victim/save", rel]) {
      r = await call("POST", "/saves/import", SaveFile.packSync({ meta: meta("wevil", "Evil"), data: { version: 3, seed: 3 },
        log: { head: { name: "Evil", batches: [[seq, 1]], nextSeq: 2 }, lists: [["OVERWRITTEN"]] } }));
      check(r.status === 400 && /game log is damaged/.test(json(r).why || ""), "a file naming log batch " + JSON.stringify(seq).slice(0, 40) + " is refused: " + (json(r).why || r.status));
    }
    check(JSON.stringify(v8.deserialize(fs.readFileSync(path.join(saves, "Victim", "save.v8")))) === JSON.stringify(victim), "the other world's save is untouched");
    check(fs.readdirSync(outside).length === 0, "nothing was written outside the saves folder");
    check(!fs.readdirSync(saves).some(n => n.startsWith("Evil")), "no half-imported world is left behind");

    // a proper log round-trips
    const lists = [[{ t: 1, level: "INFO", text: "a" }], [{ t: 2, level: "INFO", text: "b" }]];
    r = await call("POST", "/saves/import", SaveFile.packSync({ meta: meta("wlog", "Logged"), data: { version: 3, seed: 3 }, log: { head: { name: "Logged", batches: [[0, 1], [1, 1]], nextSeq: 2 }, lists } }));
    const id = json(r).meta && json(r).meta.id;
    check(r.status === 200 && id, "a world with a proper game log imports");
    r = await call("GET", "/saves/" + id + "/export");
    const back = r.status === 200 ? SaveFile.unpackSync(r.body) : null;
    check(back && JSON.stringify(back.log.lists) === JSON.stringify(lists), "it exports with the same game log");

    // a log head on disk that names a bad batch (imported before the fix): export leaves it out
    const f = path.join(saves, "Logged", "log", "head.v8"), head = v8.deserialize(fs.readFileSync(f));
    head.batches.push(["../../Victim/save", 1]);
    fs.writeFileSync(f, v8.serialize(head));
    r = await call("GET", "/saves/" + id + "/export");
    const back2 = r.status === 200 ? SaveFile.unpackSync(r.body) : null;
    check(back2 && back2.log.head.batches.length === 2 && back2.log.lists.length === 2 && !JSON.stringify(back2).includes("100 hours"),
      "a world whose log names a bad batch exports without it (and without the other world's save): " + r.status);
  } catch (e) { check(false, "threw " + (e && e.stack || e)); }
  srv.kill("SIGINT");
  await new Promise(r => { srv.on("exit", r); setTimeout(r, 5000); });
  fs.rmSync(saves, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  if (fails) console.log(out);
  console.log(fails ? fails + " failed" : "all passed");
  process.exit(fails ? 1 : 0);
})();
