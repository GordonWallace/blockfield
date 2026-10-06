// Saved worlds in the browser's IndexedDB: a list of worlds (name, seed, mode, last played),
// each storing block edits, player, inventory and time of day. Autosaves while playing.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const DB_NAME = "blockfield", DB_VER = 1, AUTOSAVE_S = 30;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("worlds")) d.createObjectStore("worlds", { keyPath: "id" });
      if (!d.objectStoreNames.contains("data")) d.createObjectStore("data");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
function tx(stores, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(t);
  }));
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ---------- snapshot / restore ----------
function snapshot() {
  const edits = {};
  for (const [k, m] of BF.world.edits) {
    if (!m.size) continue;
    const a = new Int32Array(m.size * 2);
    let i = 0;
    for (const [idx, id] of m) { a[i++] = idx; a[i++] = id; }
    edits[k] = a;
  }
  const P = BF.player, p = P.position;
  const player = P.serialize ? P.serialize() : {
    x: p.x, y: p.y, z: p.z, yaw: P.yaw, pitch: P.pitch,
    health: P.health, hunger: P.hunger, gameMode: P.gameMode,
  };
  return {
    version: 1,
    seed: BF.state.seed,
    time: { t: BF.sky.time, day: BF.sky.day },
    spawn: BF.spawnPoint,
    player,
    inventory: BF.inventory.serialize ? BF.inventory.serialize() : null,
    villagers: BF.mobs && BF.mobs.exportVillagers ? BF.mobs.exportVillagers() : undefined,
    weather: BF.weather && BF.weather.serialize ? BF.weather.serialize() : undefined,
    signs: BF.signs && BF.signs.serialize ? BF.signs.serialize() : undefined,
    maps: BF.maps && BF.maps.serialize ? BF.maps.serialize() : undefined, // explored pixels of filled maps (js/maps.js)
    edits,
  };
}

function restore(data) {
  BF.newWorld(data.seed, { gameMode: data.player && data.player.gameMode });
  for (const k in data.edits || {}) {
    const a = data.edits[k], m = new Map();
    for (let i = 0; i < a.length; i += 2) m.set(a[i], a[i + 1]);
    BF.world.edits.set(k, m);
  }
  if (data.spawn) BF.spawnPoint = data.spawn;
  if (data.time) { BF.sky.day = data.time.day || 0; if (BF.sky.setTime) BF.sky.setTime(data.time.t); else BF.sky.time = data.time.t; }
  const pl = data.player || {};
  if (BF.player.deserialize) BF.player.deserialize(pl);
  else {
    BF.player.spawn(pl.x, pl.y, pl.z);
    if (pl.health != null) BF.player.health = pl.health;
    if (pl.hunger != null) BF.player.hunger = pl.hunger;
    if (BF.player.setLook && pl.yaw != null) BF.player.setLook(pl.yaw, pl.pitch);
  }
  if (data.inventory && BF.inventory.deserialize) BF.inventory.deserialize(data.inventory);
  if (data.villagers && BF.mobs && BF.mobs.importVillagers) BF.mobs.importVillagers(data.villagers); // old saves have none
  if (data.weather && BF.weather && BF.weather.deserialize) BF.weather.deserialize(data.weather); // old saves: newWorld's seeded default
  if (BF.maps && BF.maps.deserialize) BF.maps.deserialize(data.maps); // old saves: no maps
  if (BF.signs && BF.signs.deserialize) BF.signs.deserialize(data.signs); // sign texts + auto-sign state (old saves: none)
}

// ---------- public API ----------
const save = {
  current: null,          // meta of the world being played, or null (unsaved demo world)
  lastSaved: 0,
  supported: typeof indexedDB !== "undefined",

  // -> [{id, name, seed, gameMode, created, lastPlayed}] newest first; [] if storage is unavailable
  list() {
    return tx(["worlds"], "readonly", t => reqP(t.objectStore("worlds").getAll()))
      .then(p => p).then(a => (a || []).sort((x, y) => y.lastPlayed - x.lastPlayed))
      .catch(() => []);
  },

  // Starts a brand-new saved world. opts: {name, seed (number|string|blank), gameMode}
  create(opts = {}) {
    let seed = opts.seed;
    if (seed === undefined || seed === null || seed === "") seed = (Math.random() * 4294967296) >>> 0;
    else if (!/^-?\d+$/.test(String(seed).trim())) { let h = 0; for (const ch of String(seed)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; seed = h >>> 0; }
    else seed = Number(seed) >>> 0;
    const now = Date.now();
    const meta = { id: "w" + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36), name: (opts.name || "New World").slice(0, 40), seed, gameMode: opts.gameMode || "survival", created: now, lastPlayed: now };
    BF.newWorld(seed, { gameMode: meta.gameMode });
    save.current = meta;
    BF.emit("worldLoaded", meta);
    return save.saveNow().then(() => meta);
  },

  // Loads a saved world by id. Resolves to its meta.
  load(id) {
    return tx(["worlds", "data"], "readonly", t => Promise.all([reqP(t.objectStore("worlds").get(id)), reqP(t.objectStore("data").get(id))]))
      .then(([meta, data]) => {
        if (!meta || !data) throw new Error("World not found");
        restore(data);
        meta.lastPlayed = Date.now();
        save.current = meta;
        BF.emit("worldLoaded", meta);
        return save.saveNow().then(() => meta);
      });
  },

  remove(id) {
    if (save.current && save.current.id === id) save.current = null;
    return tx(["worlds", "data"], "readwrite", t => { t.objectStore("worlds").delete(id); t.objectStore("data").delete(id); });
  },

  rename(id, name) {
    return tx(["worlds"], "readwrite", t => {
      const s = t.objectStore("worlds");
      const r = s.get(id);
      r.onsuccess = () => { if (r.result) { r.result.name = String(name).slice(0, 40); s.put(r.result); if (save.current && save.current.id === id) save.current.name = r.result.name; } };
    });
  },

  // Writes the current world now. Resolves true when saved (false when there's nothing to save).
  saveNow() {
    if (!save.current || !save.supported) return Promise.resolve(false);
    let data;
    try { data = snapshot(); } catch (e) { console.error(e); return Promise.resolve(false); }
    const meta = Object.assign({}, save.current, { lastPlayed: Date.now(), gameMode: data.player && data.player.gameMode || save.current.gameMode, seed: data.seed });
    save.current = meta;
    return tx(["worlds", "data"], "readwrite", t => { t.objectStore("worlds").put(meta); t.objectStore("data").put(data, meta.id); })
      .then(() => { save.lastSaved = Date.now(); BF.emit("worldSaved", meta); return true; })
      .catch(e => { console.error("Save failed", e); BF.emit("saveFailed", e); return false; });
  },

  update(dt) {
    if (!save.current) return;
    acc += dt;
    if (acc >= AUTOSAVE_S) { acc = 0; save.saveNow(); }
  },
};
let acc = 0;
BF.save = save;

// save when the tab is hidden or closed, and when the game pauses
const flush = () => { if (save.current) save.saveNow(); };
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
})();
