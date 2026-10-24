// The part of IndexedDB that js/save.js and the game log (js/gamelog.js) use, kept in files, so the simulation's own saving code runs
// unchanged in the world server (spec r15-41). One folder per database (<root>/<name>/), one per object store, one file per record:
// the record's key (URI-encoded) + ".v8", its value in V8's structured-clone format (typed arrays, Maps and the rest come back as they
// went in, as IndexedDB's own clone does). A write goes to a temp file first and is renamed over the old one, so a failed write keeps
// the previous record. Transactions run their requests in order, one after another, then fire complete; they are not atomic across
// records (a crash between two puts keeps the first), which is as much as a world's save needs (its meta and its data go in one tx).
// The game's own database ("blockfield": its stores worlds and data) is kept a folder per world instead (spec r15-42, server/savedir.js):
// "worlds" <id> is the world's world.json, "data" <id> its save.v8, "<id>#loghead" and "<id>#log:<seq>" its log/ folder.
// API: open(root) -> { indexedDB, IDBKeyRange, store, worlds } (store: { get, put, del, all(storeName, range?), keys } for the server
//   itself; worlds: the server/savedir.js folders)
"use strict";
const fs = require("fs"), path = require("path"), v8 = require("v8");
const SaveDir = require("./savedir.js");
const GAME_DB = "blockfield";

const enc = k => encodeURIComponent(String(k)).replace(/\*/g, "%2A") + ".v8";
const dec = f => decodeURIComponent(f.slice(0, -3));

const IDBKeyRange = {
  bound(lower, upper, lo = false, uo = false) {
    return { lower, upper, includes: k => (lo ? k > lower : k >= lower) && (uo ? k < upper : k <= upper) };
  },
  only(v) { return { lower: v, upper: v, includes: k => k === v }; },
};
const isRange = k => k && typeof k === "object" && typeof k.includes === "function";

// a game database record's key -> [world id, part] (server/savedir.js)
function part(s, key) {
  key = String(key);
  if (s === "worlds") return [key, "meta"];
  const m = /^(.*)#(loghead|log:\d+)$/.exec(key);
  return m ? [m[1], m[2]] : [key, "data"];
}
const keyOf = (s, id, p) => s === "worlds" ? id : p === "data" ? id : id + "#" + p;

function open(root) {
  // other databases: a folder each under <root>/.idb/ (only the game's is used today)
  const dbDir = name => path.join(root, ".idb", encodeURIComponent(name));
  const worlds = SaveDir.open(root);
  const game = (db, s) => db === GAME_DB && (s === "worlds" || s === "data");
  // ---- records, synchronously
  function storeOf(db, s) { return path.join(dbDir(db), encodeURIComponent(s)); }
  const store = {
    get(db, s, key) {
      if (game(db, s)) { const [id, p] = part(s, key); return worlds.get(id, p); }
      try { return v8.deserialize(fs.readFileSync(path.join(storeOf(db, s), enc(key)))); }
      catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
    },
    put(db, s, key, value) {
      if (game(db, s)) { const [id, p] = part(s, key); worlds.put(id, p, value); return; }
      const dir = storeOf(db, s), f = path.join(dir, enc(key)), tmp = f + ".tmp" + process.pid + "_" + Math.random().toString(36).slice(2);
      fs.mkdirSync(dir, { recursive: true });
      try { fs.writeFileSync(tmp, v8.serialize(value)); fs.renameSync(tmp, f); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* never written */ } throw e; }
    },
    del(db, s, key) {
      if (game(db, s)) { const [id, p] = part(s, key); worlds.del(id, p); return; }
      try { fs.unlinkSync(path.join(storeOf(db, s), enc(key))); } catch (e) { if (e.code !== "ENOENT") throw e; }
    },
    keys(db, s, range) {
      if (game(db, s)) {
        let ks;
        if (s === "worlds") ks = worlds.list().map(m => m.id);
        else {   // (a range within one world, as the game log's: only that world's folder is read)
          const one = range && typeof range.lower === "string" && range.lower.includes("#") ? [range.lower.split("#")[0]] : worlds.list().map(m => m.id);
          ks = [].concat(...one.map(id => worlds.parts(id).map(p => keyOf(s, id, p))));
        }
        ks.sort();
        return range ? ks.filter(k => range.includes(k)) : ks;
      }
      let names;
      try { names = fs.readdirSync(storeOf(db, s)); } catch (e) { return []; }
      const ks = names.filter(f => f.endsWith(".v8")).map(dec).sort();
      return range ? ks.filter(k => range.includes(k)) : ks;
    },
    all(db, s, range) { return store.keys(db, s, range).map(k => store.get(db, s, k)); },
  };

  // ---- the IndexedDB shapes: requests with onsuccess / onerror, transactions with complete / error / abort
  const later = fn => setImmediate(fn);
  function request() { return { result: undefined, error: null, onsuccess: null, onerror: null }; }
  function meta(name) { try { return JSON.parse(fs.readFileSync(path.join(dbDir(name), "stores.json"), "utf8")); } catch (e) { return null; } }

  function database(name, stores) {
    const names = () => Object.keys(stores);
    return {
      name,
      get objectStoreNames() { const n = names(); return { contains: s => n.includes(s), length: n.length, item: i => n[i] }; },
      createObjectStore(s, o) {
        stores[s] = { keyPath: o && o.keyPath || null };
        fs.mkdirSync(storeOf(name, s), { recursive: true });
        fs.writeFileSync(path.join(dbDir(name), "stores.json"), JSON.stringify(stores));
      },
      close() {},
      transaction(list, mode) {
        const t = { oncomplete: null, onerror: null, onabort: null, error: null, mode: mode || "readonly" };
        const queue = [];
        let pumping = false, done = false;
        const pump = () => {
          if (pumping || done) return;
          pumping = true;
          later(() => {
            while (queue.length) {
              const [r, op] = queue.shift();
              try { r.result = op(); } catch (e) {
                r.error = e; t.error = e; done = true;
                if (r.onerror) r.onerror({ target: r });
                if (t.onerror) t.onerror({ target: t });
                if (t.onabort) t.onabort({ target: t });
                return;
              }
              if (r.onsuccess) r.onsuccess({ target: r });   // (may queue more requests: they run in this same pass)
            }
            pumping = false; done = true;
            later(() => { if (t.oncomplete) t.oncomplete({ target: t }); });
          });
        };
        const ro = () => { if (t.mode !== "readwrite") throw new Error("ReadOnlyError: the transaction is read-only"); };
        const add = op => { const r = request(); queue.push([r, op]); if (!pumping) pump(); return r; };
        t.objectStore = s => {
          if (!stores[s]) throw new Error("NotFoundError: no object store " + s);
          const kp = stores[s].keyPath;
          return {
            get: key => add(() => store.get(name, s, key)),
            getAll: range => add(() => store.all(name, s, range || null)),
            getAllKeys: range => add(() => store.keys(name, s, range || null)),
            put: (value, key) => add(() => { ro(); const k = kp ? value[kp] : key; store.put(name, s, k, value); return k; }),
            delete: key => add(() => { ro(); if (isRange(key)) for (const k of store.keys(name, s, key)) store.del(name, s, k); else store.del(name, s, key); }),
          };
        };
        pump();   // (a transaction with no requests completes too)
        return t;
      },
    };
  }

  const indexedDB = {
    open(name /* , version */) {
      const r = request();
      r.onupgradeneeded = null;
      later(() => {
        try {
          fs.mkdirSync(dbDir(name), { recursive: true });
          const had = meta(name), stores = had || {};
          r.result = database(name, stores);
          if (!had && r.onupgradeneeded) r.onupgradeneeded({ target: r });
          if (!had) fs.writeFileSync(path.join(dbDir(name), "stores.json"), JSON.stringify(stores));
        } catch (e) { r.error = e; if (r.onerror) r.onerror({ target: r }); return; }
        if (r.onsuccess) r.onsuccess({ target: r });
      });
      return r;
    },
  };
  return { indexedDB, IDBKeyRange, store, worlds };
}

module.exports = { open, IDBKeyRange };
