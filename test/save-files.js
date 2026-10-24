// @ci baseline suite=world
// Saved worlds as files (spec r15-42), no browser:
//   - the .bfworld file (js/savefile.js): typed arrays, Maps, Sets, NaN and objects with tag-like keys come back as they went in, a
//     plain JSON file reads too, and anything else is refused with a clear message;
//   - the world server's folders (server/savedir.js through server/idb.js, the IndexedDB js/save.js runs on in the server): js/save.js
//     itself, loaded here on that IndexedDB, imports a world, which lands in saves/<world name>/ as world.json + save.v8 + log/; its
//     list, rename, game log store, export and delete work on the folders; names a file system can't hold, and taken names, get a safe
//     folder; a log batch that comes before the world's list entry gets a folder that is renamed after the world once it comes; a
//     folder renamed by hand is still found; a write that fails (a full disk) keeps the previous save whole and leaves no temp file;
//   - 1.4 saves (version 2) and 1.3 saves are refused by the import with "Made with Blockfield 1.4, can't be opened in 1.5".
// Plain node: node test/save-files.js
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const SaveFile = require("../js/savefile.js"), IDB = require("../server/idb.js");
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bf-savefiles-"));

// js/save.js on the file IndexedDB, as the world server's simulation thread runs it
function loadSave(dir) {
  const idb = IDB.open(dir);
  const ctx = { BF: { VERSION: "1.5", on() {}, emit() {}, saveFile: SaveFile }, indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange, performance, console, setTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "save.js"), "utf8"), ctx, { filename: "js/save.js" });
  return { save: ctx.BF.save, idb };
}
const sameArr = (a, b) => a && b && a.constructor.name === b.constructor.name && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

(async () => {
  try {
    // ---- the file format
    const data = { version: 3, seed: 3, gen: 4, edits: { "0:1,2": new Int32Array([5, 7, -1, 2147483647]) }, maps: new Map([["a", new Uint8Array([1, 2, 255])]]),
      set: new Set(["x", "y"]), odd: { $t: "not a typed array", $m: 1 }, nan: NaN, inf: -Infinity, f64: new Float64Array([Math.PI]), list: [1, null, "s"], none: undefined };
    const meta = { id: "wtest1", name: "Test: world/1", seed: 3, version: 3, gen: 4, gameMode: "survival", lastPlayed: 1 };
    const log = { head: { name: "Test", batches: [[0, 2], [1, 1]], nextSeq: 2 }, lists: [[{ x: "a" }, { x: "b" }], [{ x: "c" }]] };
    const buf = SaveFile.packSync({ game: "1.5", meta, data, log });
    check(buf[0] === 0x1f && buf[1] === 0x8b, "a .bfworld file is gzipped (" + buf.length + " bytes)");
    const back = SaveFile.unpackSync(buf);
    check(sameArr(back.data.edits["0:1,2"], data.edits["0:1,2"]) && sameArr(back.data.f64, data.f64), "typed arrays come back as they were");
    check(back.data.maps instanceof Map && sameArr(back.data.maps.get("a"), data.maps.get("a")) && back.data.set instanceof Set && back.data.set.has("y"), "Maps and Sets come back");
    check(back.data.odd.$t === "not a typed array" && back.data.odd.$m === 1 && Number.isNaN(back.data.nan) && back.data.inf === -Infinity && !("none" in back.data), "tag-like keys, NaN and -Infinity come back; undefined is left out");
    check(back.meta.name === meta.name && back.log.lists[1][0].x === "c" && back.game === "1.5", "the list entry, the game log and the game version come back");
    check(SaveFile.unpackSync(Buffer.from(SaveFile.encode({ meta, data }))).data.edits["0:1,2"][1] === 7, "a plain JSON file is read too");
    const bad = (b, re, what) => { let msg = ""; try { SaveFile.unpackSync(b); } catch (e) { msg = e.message; } check(re.test(msg), what + " (" + msg + ")"); };
    bad(Buffer.from("hello"), /isn't a Blockfield world file/, "a file that isn't a world is refused");
    bad(Buffer.from(JSON.stringify({ blockfield: "world", format: 99, meta: {}, data: {} })), /newer Blockfield/, "a newer format is refused");
    check(SaveFile.fileName('a<b>:"c"') === "a_b___c_.bfworld", "the download's file name is safe");

    // ---- js/save.js on the world server's folders
    const { save, idb } = loadSave(root);
    const r1 = await save.importRecord(SaveFile.unpackSync(buf), false);
    const f1 = idb.worlds.folder(r1.meta.id);
    check(f1 === "Test_ world_1", "an imported world gets a folder named after it (" + f1 + ")");
    const files = d => { const out = []; (function walk(p, rel) { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name), rel + e.name + "/") : out.push(rel + e.name); })(path.join(root, d), ""); return out.sort(); };
    check(files(f1).join() === "log/000000000.v8,log/000000001.v8,log/head.v8,save.v8,world.json", "it holds world.json, save.v8 and log/ (" + files(f1).join(", ") + ")");
    const wj = JSON.parse(fs.readFileSync(path.join(root, f1, "world.json"), "utf8"));
    check(wj.id === r1.meta.id && wj.seed === 3 && wj.version === 3, "world.json is the list entry, readable as text");
    const list = await save.list();
    check(list.length === 1 && list[0].name === meta.name, "save.list lists it");
    const again = await save.importRecord(SaveFile.unpackSync(buf), true);
    check(again.skipped, "importing it again with keepId (a copy from the browser made before) is skipped");
    const dup = await save.importRecord(SaveFile.unpackSync(buf), false);
    const f2 = idb.worlds.folder(dup.meta.id);
    check(dup.meta.id !== r1.meta.id && f2 === "Test_ world_1 (2)", "importing it again otherwise makes a second world with a new id, in folder " + f2);
    const lr = await save.logStore.read(r1.meta.id);
    check(lr.head && lr.entries.map(e => e.x).join("") === "abc", "the game log reads back from log/ (" + lr.entries.map(e => e.x).join("") + ")");
    await save.logStore.write(r1.meta.id, Object.assign({}, lr.head, { batches: [[1, 1], [2, 1]], nextSeq: 3 }), 2, [{ x: "d" }], [0]);
    check(files(f1).filter(f => f.startsWith("log/")).join() === "log/000000001.v8,log/000000002.v8,log/head.v8", "a new log batch is written and the dropped one goes");
    const rec = await save.exportRecord(r1.meta.id);
    check(sameArr(rec.data.edits["0:1,2"], data.edits["0:1,2"]) && rec.log.lists.map(l => l[0].x).join("") === "cd", "save.exportRecord reads the world back from its folder");
    await save.rename(r1.meta.id, "Renamed");
    check(idb.worlds.meta(r1.meta.id).name === "Renamed" && idb.worlds.folder(r1.meta.id) === f1, "a rename changes world.json (the folder follows at the server: savedir rename)");
    check(idb.worlds.rename(r1.meta.id, "Renamed") === "Renamed" && fs.existsSync(path.join(root, "Renamed", "save.v8")), "savedir rename moves the folder to the new name");

    // names
    const names = ["con", "a.", "   ", ".hidden", "rivers", "RENAMED"].map((n, i) => { const id = "wn" + i; idb.worlds.put(id, "meta", { id, name: n, version: 3 }); return idb.worlds.folder(id); });
    check(names.join("|") === "con_|a|_|_.hidden|rivers (2)|RENAMED (2)", "names a file system can't hold, or already taken, get safe folders (" + names.join(" | ") + ")");
    for (let i = 0; i < 6; i++) idb.worlds.remove("wn" + i);

    // a log batch first, then the list entry (a new world: its log can start before its first save)
    idb.worlds.put("wlate", "log:000000000", [{ x: "early" }]);
    const stub = idb.worlds.folder("wlate");
    check(stub === "wlate" && !(await save.list()).some(w => w.id === "wlate"), "a log batch before the list entry gets a folder named after the id, not listed");
    idb.worlds.put("wlate", "meta", { id: "wlate", name: "Late", version: 3 });
    check(idb.worlds.folder("wlate") === "Late" && fs.existsSync(path.join(root, "Late", "log", "000000000.v8")), "the list entry renames it after the world, the log kept");

    // a folder renamed by hand is still found
    fs.renameSync(path.join(root, "Late"), path.join(root, "My backup"));
    check(idb.worlds.folder("wlate") === "My backup" && idb.worlds.meta("wlate").name === "Late", "a folder renamed by hand is still found by its id");
    idb.worlds.put("wlate", "meta", { id: "wlate", name: "Late again", version: 3 });
    check(fs.existsSync(path.join(root, "My backup", "world.json")) && !fs.existsSync(path.join(root, "Late again")), "and saved to where it is, not a new folder");

    // a full disk
    const before = fs.readFileSync(path.join(root, "Renamed", "save.v8"));
    idb.worlds.failWrites(1, "ENOSPC");
    let err = null;
    try { idb.store.put("blockfield", "data", r1.meta.id, { version: 3, seed: 3, edits: {} }); } catch (e) { err = e; }
    check(err && err.code === "ENOSPC", "a failed write throws its error (" + (err && err.message) + ")");
    check(before.equals(fs.readFileSync(path.join(root, "Renamed", "save.v8"))) && !fs.readdirSync(path.join(root, "Renamed")).some(f => /\.tmp/.test(f)), "the previous save is kept whole, and no temp file is left");
    idb.worlds.failWrites(1);
    const failed = await save.importRecord(SaveFile.unpackSync(buf), false).then(() => "", e => e.message);
    check(/ENOSPC/.test(failed), "js/save.js gets the error from a failed transaction (" + failed + ")");

    // older releases' saves
    const old = async (v, re) => { const m = await Promise.resolve().then(() => save.importRecord({ meta: Object.assign({}, meta, { version: v }), data: Object.assign({}, data, { version: v }) }, false)).then(() => "imported", e => e.message); check(re.test(m), "a version " + v + " save is refused (" + m + ")"); };
    await old(2, /^Made with Blockfield 1\.4, can't be opened in 1\.5$/);
    await old(1, /^Made with Blockfield 1\.3, can't be opened in 1\.5$/);
    check(save.tooOld({ version: 2 }) === "Made with Blockfield 1.4, can't be opened in 1.5" && !save.playable({ version: 2, gen: 4 }) && save.playable({ version: 3 }), "save.playable refuses 1.4 worlds (version 2, gen 4)");

    // delete
    await save.remove(r1.meta.id);
    check(!fs.existsSync(path.join(root, "Renamed")) && idb.worlds.folder(r1.meta.id) === null, "save.remove deletes the world's folder");
    check(fs.existsSync(path.join(root, f2, "save.v8")), "and leaves the other worlds alone");
  } catch (e) {
    check(false, "the test ran: " + (e && e.stack || e));
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `FAILED ${fails} check(s)` : "all checks passed");
  process.exit(fails ? 1 : 0);
})();
