// The world server's saved worlds on disk (spec r15-42): one folder per world in the saves folder, named after the world.
//   <saves>/<world name>/world.json    the world's list entry (js/save.js meta: id, name, seed, game mode, version, time, last played...)
//   <saves>/<world name>/save.v8       its save data, the object js/save.js snapshot() makes, in V8's structured-clone format (typed
//                                      arrays and the rest come back as they went in, as from IndexedDB)
//   <saves>/<world name>/log/head.v8   its game log (js/gamelog.js): the head, and the numbered batches of entries
//   <saves>/<world name>/log/000000012.v8
// A world's folder is found by the id in its world.json, so folders can be renamed, copied in or backed up by hand. A folder is named
// after the world when it is made (characters a file name can't hold become "_"; a name already taken gets " (2)"), and follows a
// rename from the title screen when the world isn't being played (the server renames it then, or when it next starts).
// Every write goes to a temp file in the same folder and is renamed over the old file, so a failed write (a full disk) keeps the
// previous save whole and the error goes back to whoever saved.
// server/idb.js maps js/save.js's IndexedDB records ("worlds" id, "data" id, "<id>#loghead", "<id>#log:<seq>") onto this layout, so
// the simulation's own saving code runs unchanged; server/world.js uses it directly for the title screen, import and export.
// Folders without a world.json (the river cache, rivers/) are not worlds and are left alone.
// API: open(root) -> { list(), meta(id), folder(id), get(id, part), put(id, part, value), del(id, part), parts(id), remove(id),
//   rename(id, name) -> folder, tidy() (folder names to world names), failWrites(n, code) (tests: the next n writes fail) }
//   part: "meta" | "data" | "loghead" | "log:<seq>"
"use strict";
const fs = require("fs"), path = require("path"), v8 = require("v8");

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;   // (Windows device names)
// a world's name -> a folder name every system can hold
function slug(name) {
  let s = String(name == null ? "" : name).replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, "_").replace(/[. ]+$/, "").trim();
  if (!s || s.startsWith(".")) s = "_" + s;
  if (RESERVED.test(s)) s += "_";
  return s.slice(0, 60);
}

function open(root) {
  let index = null;   // id -> folder name
  let failing = 0, failCode = "ENOSPC";
  const dir = f => path.join(root, f);
  const readMeta = f => { try { return JSON.parse(fs.readFileSync(path.join(dir(f), "world.json"), "utf8")); } catch (e) { return null; } };
  function scan() {
    index = new Map();
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".")).map(d => d.name); } catch (e) { /* no saves yet */ }
    for (const f of names.sort()) { const m = readMeta(f); if (m && m.id && !index.has(m.id)) index.set(m.id, f); }
    return index;
  }
  // the folder holding world id (checked on disk each time: the other threads, or a person, may have moved it), or null
  function folder(id) {
    if (!index) scan();
    const f = index.get(id), m = f != null && readMeta(f);
    if (m && m.id === id) return f;
    const g = scan().get(id);
    return g == null ? null : g;
  }
  // a free folder name for a world called name
  function freeName(name, except) {
    const base = slug(name);
    let taken;
    try { taken = new Set(fs.readdirSync(root).map(n => n.toLowerCase())); } catch (e) { taken = new Set(); }
    if (except) taken.delete(except.toLowerCase());
    for (let i = 1; ; i++) { const n = i === 1 ? base : base + " (" + i + ")"; if (!taken.has(n.toLowerCase()) && n.toLowerCase() !== "rivers") return n; }
  }
  const file = (f, part) => part === "meta" ? path.join(dir(f), "world.json") : part === "data" ? path.join(dir(f), "save.v8")
    : part === "loghead" ? path.join(dir(f), "log", "head.v8") : path.join(dir(f), "log", part.slice(4) + ".v8");
  function write(target, bytes) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp" + process.pid + "_" + Math.random().toString(36).slice(2);
    try {
      if (failing > 0) { failing--; const e = new Error(failCode + ": the test made this write fail, " + target); e.code = failCode; throw e; }
      fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, target);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* never written */ } throw e; }
  }
  // a world's folder, made when it has none yet: named after it, or after its id until its list entry comes (a log batch first)
  function folderFor(id, meta) {
    const f = folder(id);
    if (f != null) {
      const m = readMeta(f);
      if (m && m.stub && meta && meta.name) {   // named after its id so far: now after the world
        const to = freeName(meta.name, f);
        if (to !== f) try { fs.renameSync(dir(f), dir(to)); index.set(id, to); return to; } catch (e) { /* stays */ }
      }
      return f;
    }
    const n = freeName(meta && meta.name || id);
    fs.mkdirSync(dir(n), { recursive: true });
    if (!meta) write(path.join(dir(n), "world.json"), JSON.stringify({ id, stub: true }));
    index.set(id, n);
    return n;
  }
  const api = {
    root, slug,
    folder,
    // every world's list entry
    list() { const out = []; for (const f of scan().values()) { const m = readMeta(f); if (m && !m.stub) out.push(m); } return out; },
    meta(id) { const f = folder(id), m = f != null ? readMeta(f) : null; return m && !m.stub ? m : undefined; },
    get(id, part) {
      if (part === "meta") return api.meta(id);
      const f = folder(id);
      if (f == null) return undefined;
      try { return v8.deserialize(fs.readFileSync(file(f, part))); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
    },
    put(id, part, value) {
      const had = folder(id) != null, f = folderFor(id, part === "meta" ? value : null);
      try { write(file(f, part), part === "meta" ? JSON.stringify(value, null, 1) : v8.serialize(value)); }
      catch (e) { if (!had && part === "meta") { try { fs.rmdirSync(dir(f)); } catch (_) { /* not empty */ } index.delete(id); } throw e; }   // (no empty folder left)
    },
    del(id, part) {
      const f = folder(id);
      if (f == null) return;
      if (part === "meta") { api.remove(id); return; }   // (js/save.js remove deletes the list entry first: the whole world goes)
      try { fs.unlinkSync(file(f, part)); } catch (e) { if (e.code !== "ENOENT") throw e; }
    },
    // the parts a world has on disk: "data", "loghead", "log:<seq>" (sorted)
    parts(id) {
      const f = folder(id), out = [];
      if (f == null) return out;
      if (fs.existsSync(file(f, "data"))) out.push("data");
      let logs = [];
      try { logs = fs.readdirSync(path.join(dir(f), "log")).filter(n => n.endsWith(".v8")).map(n => n.slice(0, -3)); } catch (e) { /* no log */ }
      if (logs.includes("head")) out.push("loghead");
      for (const n of logs.filter(n => n !== "head").sort()) out.push("log:" + n);
      return out;
    },
    remove(id) { const f = folder(id); if (f != null) { fs.rmSync(dir(f), { recursive: true, force: true }); index.delete(id); } },
    // the folder renamed after the world's name (its list entry already says it); -> the folder's name
    rename(id, name) {
      const f = folder(id);
      if (f == null) return null;
      if (slug(name).toLowerCase() === f.toLowerCase() || slug(name).toLowerCase() === f.replace(/ \(\d+\)$/, "").toLowerCase()) return f;
      const to = freeName(name, f);
      fs.renameSync(dir(f), dir(to));
      index.set(id, to);
      return to;
    },
    // every world's folder named after it (a rename made while it was being played), at the server's start
    tidy() {
      const moved = [];
      for (const [id, f] of [...scan()]) { const m = readMeta(f); if (m && !m.stub && m.name) { try { const to = api.rename(id, m.name); if (to !== f) moved.push([f, to]); } catch (e) { /* in use: next time */ } } }
      return moved;
    },
    failWrites(n, code) { failing = n | 0; failCode = code || "ENOSPC"; },
  };
  return api;
}

module.exports = { open, slug };
