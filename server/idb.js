// The part of IndexedDB that js/save.js and the game log (js/gamelog.js) use, kept in files, so the simulation's own saving code runs
// unchanged in the world server (spec r15-41). One folder per database (<root>/<name>/), one per object store, one file per record:
// the record's key (URI-encoded) + ".v8", its value in V8's structured-clone format (typed arrays, Maps and the rest come back as they
// went in, as IndexedDB's own clone does). A write goes to a temp file first and is renamed over the old one, so a failed write keeps
// the previous record. Transactions run their requests in order, one after another, then fire complete; they are not atomic across
// records (a crash between two puts keeps the first), which is as much as a world's save needs (its meta and its data go in one tx).
// Spec r15-42 replaces this layout with a folder per world.
// API: open(root) -> { indexedDB, IDBKeyRange, store } (store: { get, put, del, all(storeName, range?), keys } for the server itself)
"use strict";
const fs = require("fs"), path = require("path"), v8 = require("v8");

const enc = k => encodeURIComponent(String(k)).replace(/\*/g, "%2A") + ".v8";
const dec = f => decodeURIComponent(f.slice(0, -3));

const IDBKeyRange = {
  bound(lower, upper, lo = false, uo = false) {
    return { lower, upper, includes: k => (lo ? k > lower : k >= lower) && (uo ? k < upper : k <= upper) };
  },
  only(v) { return { lower: v, upper: v, includes: k => k === v }; },
};
const isRange = k => k && typeof k === "object" && typeof k.includes === "function";

function open(root) {
  const dbDir = name => path.join(root, encodeURIComponent(name));
  // ---- records, synchronously
  function storeOf(db, s) { return path.join(dbDir(db), encodeURIComponent(s)); }
  const store = {
    get(db, s, key) {
      try { return v8.deserialize(fs.readFileSync(path.join(storeOf(db, s), enc(key)))); }
      catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
    },
    put(db, s, key, value) {
      const dir = storeOf(db, s), f = path.join(dir, enc(key)), tmp = f + ".tmp" + process.pid + "_" + Math.random().toString(36).slice(2);
      fs.mkdirSync(dir, { recursive: true });
      try { fs.writeFileSync(tmp, v8.serialize(value)); fs.renameSync(tmp, f); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* never written */ } throw e; }
    },
    del(db, s, key) { try { fs.unlinkSync(path.join(storeOf(db, s), enc(key))); } catch (e) { if (e.code !== "ENOENT") throw e; } },
    keys(db, s, range) {
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
  return { indexedDB, IDBKeyRange, store };
}

module.exports = { open, IDBKeyRange };
