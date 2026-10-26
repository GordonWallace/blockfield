// @ci baseline suite=world
// World names and their folders on the world server (bug-072). Plain node, no browser: node test/save-names.js
// - server/savedir.js slug: folder names cut at 60 characters never split an emoji, never end in a dot or space, and Windows device
//   names with an extension ("CON.txt") get a "_" like the bare ones;
// - js/savefile.js clampName keeps 40 characters, whole emoji;
// - debug/server.js's import keeps an imported world's name to 40 characters like Create and Rename, and its folder is a good name.
"use strict";
const { spawn } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const SaveFile = require("../js/savefile.js"), SaveDir = require("../server/savedir.js");
const saves = fs.mkdtempSync(path.join(os.tmpdir(), "bf-names-"));
const GAME = 20500 + Math.floor(Math.random() * 1000), DEBUG = GAME + 1000;
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const lone = s => /[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")) || s.includes("�");
const good = f => !lone(f) && !/[. ]$/.test(f) && Array.from(f).length <= 60 && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(f) && !/[<>:"/\\|?*\u0000-\u001f]/.test(f);
const post = body => new Promise((res, rej) => {
  const r = http.request({ host: "127.0.0.1", port: GAME, path: "/saves/import", method: "POST", headers: { "X-Blockfield": "saves", "Content-Length": body.length } },
    rs => { let s = ""; rs.on("data", d => s += d); rs.on("end", () => { try { res(JSON.parse(s)); } catch (e) { res({ ok: false, why: s }); } }); });
  r.on("error", rej); r.end(body);
});

(async () => {
  const names = ["a".repeat(59) + "\u{1F600}x", "b".repeat(59) + ". tail", "CON.txt", "lpt1.world", "nul", "日本語の世界", "...", "  ", "half \ud83d emoji", "." + "c".repeat(70), "x".repeat(58) + "\u{1F600}\u{1F600}", "trailing. . "];
  for (const n of names) { const f = SaveDir.open(saves).slug(n); check(good(f), "slug " + JSON.stringify(n).slice(0, 30) + " -> " + JSON.stringify(f)); }
  check(SaveDir.open(saves).slug("Foo") === "Foo" && SaveDir.open(saves).slug("My world 2") === "My world 2", "ordinary names are left as they are");
  const c = SaveFile.clampName("y".repeat(39) + "\u{1F600}\u{1F600}");
  check(Array.from(c).length === 40 && !lone(c), "clampName keeps 40 whole characters: " + c.length + " units");
  check(SaveFile.clampName("  ", "Dflt") === "Dflt" && SaveFile.clampName(null) === "World", "clampName gives a default for an empty name");

  const srv = spawn(process.execPath, [path.join(__dirname, "..", "debug", "server.js"), "--game", String(GAME), "--debug", String(DEBUG), "--saves", saves], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
  for (let i = 0; i < 200 && !/Ctrl\+C/.test(out); i++) await new Promise(r => setTimeout(r, 100));
  check(/Ctrl\+C/.test(out), "debug/server.js started");
  try {
    for (const n of ["z".repeat(39) + "\u{1F600}" + "more and more and more", "CON.txt", "w".repeat(59) + ". tail"]) {
      const r = await post(SaveFile.packSync({ meta: { id: "w" + Math.random().toString(36).slice(2), name: n, seed: 3, version: 3, gen: 4 }, data: { version: 3, seed: 3 }, log: null }));
      const m = r.meta || {}, f = m.id && SaveDir.open(saves).folder(m.id);
      check(r.ok && Array.from(m.name || "").length <= 40 && !lone(m.name || ""), "import keeps the name to 40 whole characters: " + JSON.stringify(m.name));
      check(f && good(f), "and its folder is a good name: " + JSON.stringify(f));
    }
  } catch (e) { check(false, "threw " + (e && e.stack || e)); }
  srv.kill("SIGINT");
  await new Promise(r => { srv.on("exit", r); setTimeout(r, 5000); });
  fs.rmSync(saves, { recursive: true, force: true });
  if (fails) console.log(out);
  console.log(fails ? fails + " failed" : "all passed");
  process.exit(fails ? 1 : 0);
})();
