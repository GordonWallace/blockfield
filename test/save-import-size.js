// @ci baseline suite=world
// A small world file that unpacks to gigabytes is refused without freezing the world server (bug-071):
// NODE_PATH=$(npm root -g) node test/save-import-size.js
// Makes a ~600 KB gzip of 600 MB of zeros, and checks:
//   - js/savefile.js unpackSync and unpack (Node) refuse it as too big, and still read a normal file;
//   - debug/server.js's /saves/import answers 400 "too big", keeps answering other requests meanwhile (none slower than 2 s), and
//     doesn't grow by anything like the unpacked size;
//   - in a browser (DecompressionStream), BF.saveFile.unpack refuses it too.
"use strict";
const { spawn } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), zlib = require("zlib");
const SaveFile = require("../js/savefile.js");
const root = path.join(__dirname, "..");
const saves = fs.mkdtempSync(path.join(os.tmpdir(), "bf-size-"));
const GAME = 19500 + Math.floor(Math.random() * 1000), DEBUG = GAME + 1000;
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const call = (method, p, body) => new Promise(res => {
  const r = http.request({ host: "127.0.0.1", port: GAME, path: p, method, headers: body ? { "X-Blockfield": "saves", "Content-Length": body.length } : {} }, rs => {
    let s = ""; rs.on("data", d => s += d); rs.on("end", () => res({ status: rs.statusCode, body: s }));
  });
  r.on("error", e => res({ status: 0, body: e.message })); r.end(body || undefined);
});
const UNPACKED = 600 * 1024 * 1024;
function bomb() {   // gzip of UNPACKED zero bytes, made a MB at a time
  const z = zlib.createGzip({ level: 9 }), out = [], mb = Buffer.alloc(1 << 20);
  z.on("data", d => out.push(d));
  return new Promise(res => {
    z.on("end", () => res(Buffer.concat(out)));
    let i = 0;
    const more = () => { while (i < UNPACKED >> 20) { i++; if (!z.write(mb)) return z.once("drain", more); } z.end(); };
    more();
  });
}
const rss = pid => { try { return +/VmRSS:\s+(\d+)/.exec(fs.readFileSync("/proc/" + pid + "/status", "utf8"))[1] * 1024; } catch (e) { return -1; } };

(async () => {
  const B = await bomb();
  console.log("bomb: " + Math.round(B.length / 1024) + " KB, unpacks to " + (UNPACKED >> 20) + " MB");
  const good = SaveFile.packSync({ meta: { id: "wgood", name: "Good", version: 3 }, data: { version: 3, seed: 3 }, log: null });
  let msg = "";
  try { SaveFile.unpackSync(B); } catch (e) { msg = e.message; }
  check(/too big/.test(msg), "unpackSync refuses it: " + msg);
  msg = await SaveFile.unpack(B).then(() => "", e => e.message);
  check(/too big/.test(msg), "unpack refuses it: " + msg);
  check(SaveFile.unpackSync(good).meta.name === "Good" && (await SaveFile.unpack(good)).meta.name === "Good", "a normal file still unpacks both ways");

  const srv = spawn(process.execPath, [path.join(root, "debug", "server.js"), "--game", String(GAME), "--debug", String(DEBUG), "--saves", saves], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
  for (let i = 0; i < 200 && !/Ctrl\+C/.test(out); i++) await new Promise(r => setTimeout(r, 100));
  check(/Ctrl\+C/.test(out), "debug/server.js started");
  try {
    const before = rss(srv.pid);
    let worst = 0, peak = before, stop = false;
    const pinger = (async () => { while (!stop) { const t = Date.now(); await call("GET", "/index.html"); worst = Math.max(worst, Date.now() - t); peak = Math.max(peak, rss(srv.pid)); await new Promise(r => setTimeout(r, 50)); } })();
    await new Promise(r => setTimeout(r, 300));
    const r = await call("POST", "/saves/import", B);
    stop = true; await pinger;
    check(r.status === 400 && /too big/.test(r.body), "the server refuses it: " + r.status + " " + r.body.slice(0, 120));
    check(worst < 2000, "the server kept answering meanwhile (slowest answer " + worst + " ms)");
    const grew = before > 0 ? (peak - before) / (1 << 20) : 0;
    check(grew < 450, "the server grew by " + Math.round(grew) + " MB (not the " + (UNPACKED >> 20) + " MB it unpacks to)");
    const ok = await call("POST", "/saves/import", good);
    check(ok.status === 200 && /"ok":true/.test(ok.body), "a normal file still imports");
    check(!fs.readdirSync(saves).some(n => /^_?$/.test(n)), "no stray folder was left");

    // the browser's unpack
    const { chromium } = require(process.env.PW || "playwright");
    const browser = await chromium.launch();
    try {
      const pg = await browser.newPage();
      await pg.goto("http://127.0.0.1:" + GAME + "/index.html?nolod").catch(() => {});
      await pg.addScriptTag({ path: path.join(root, "js", "savefile.js") });
      const res = await pg.evaluate(async b64 => {
        const t = atob(b64), u = new Uint8Array(t.length);
        for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i);
        const big = await BF.saveFile.unpack(u).then(() => "", e => e.message);
        const good = await BF.saveFile.pack({ meta: { id: "w", name: "Good", version: 3 }, data: { version: 3 } }).then(b => b.arrayBuffer()).then(a => BF.saveFile.unpack(a)).then(r => r.meta.name, e => "error " + e.message);
        return { big, good };
      }, B.toString("base64"));
      check(/too big/.test(res.big), "the browser's unpack refuses it: " + res.big);
      check(res.good === "Good", "the browser's unpack still reads a normal file: " + res.good);
    } finally { await browser.close(); }
  } catch (e) { check(false, "threw " + (e && e.stack || e)); }
  srv.kill("SIGINT");
  await new Promise(r => { srv.on("exit", r); setTimeout(r, 5000); });
  fs.rmSync(saves, { recursive: true, force: true });
  if (fails) console.log(out);
  console.log(fails ? fails + " failed" : "all passed");
  process.exit(fails ? 1 : 0);
})();
