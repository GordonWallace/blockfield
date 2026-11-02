// Saved worlds in the browser's IndexedDB: a list of worlds (name, seed, mode, last played),
// each storing block edits, player, inventory, time of day and the dropped items lying around. Autosaves while playing.
// Each world's game log (js/gamelog.js) is kept next to its save in the same "data" store: a head record ("<id>#loghead") and
// numbered batches of entries ("<id>#log:000000012"), written as the log grows (logStore).
// With the simulation in a Web Worker (spec r15-38, js/simhost.js) the worker owns the world and this file runs there too: it saves
// (autosave, saveNow) and loads there. In the page, create / load set up the page's copy of the world (restoreClient: the planet, the
// player, the inventory, the time and weather; the edits come from the worker) and ask the worker for the world; saveNow asks the worker.
// With the page a client of the Node world server (spec r15-41) the saved worlds are the server's, on its disk (server/idb.js keeps them
// in this file's own format): list, load, remove, rename and setMonsters ask the server (BF.simHost.saves), and the server's simulation
// runs this file to save and load. A world the server holds paused (its page closed) loads as it is now, not from its last save.
// On the server each world is a folder, saves/<world name>/ (spec r15-42, server/savedir.js).
// Export and import (spec r15-42): a saved world as one .bfworld file (js/savefile.js), the same file in every mode. exportFile(id)
// downloads one (from the server, or made here from IndexedDB), importFile(file) adds the world it holds (to the server, or to
// IndexedDB), and copyToServer() copies this browser's IndexedDB worlds to the server (they stay in the browser too).
// Game log: DEBUG "save" for each save (how long it took), ERROR when a save fails (the previous save is kept); INFO "save" for an
// export, an import, a copy to the server, and for a world refused as too old; ERROR "save" for an import that fails (a damaged file).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const DB_NAME = "blockfield", DB_VER = 1, AUTOSAVE_S = 30, VERSION = 3;
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
function snapshot(o) {
  // (region workers: the followers take one too, in case serializing changes anything: js/rworkers.js; o.quiet: they take this one
  // already, at a meeting of the cluster workers, js/save.js saveNow)
  if (BF.rworkers && !(o && o.quiet)) BF.rworkers.rec(["s"]);
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
    version: VERSION,                                      // 3: Blockfield 1.5; 2: a planet from 1.4; 1: a flat world from 1.3 or earlier (neither opens in 1.5)
    seed: BF.state.seed,
    gen: 4, biomeScale: BF.state.biomeScale,               // worldgen version (4: the planet, the only one since 1.4) + biome size
    villages: BF.state.villages,                           // village generator (old saves have none => 1, the classic villages)
    monsters: BF.gameOpts ? BF.gameOpts.all() : undefined,   // game options: which monsters spawn, and far villages (coarse) (js/gameopts.js; the list entry's copy is the one read)
    time: { t: BF.sky.time, day: BF.sky.day },
    rand: BF.rand ? BF.rand.save() : undefined,           // the simulation tick and creation counter of the seeded random streams (js/rand.js)
    spawn: BF.spawnPoint,
    player,
    inventory: BF.inventory.serialize ? BF.inventory.serialize() : null,
    villagers: BF.mobs && BF.mobs.exportVillagers ? BF.mobs.exportVillagers() : undefined,
    ids: BF.ids ? BF.ids.serialize() : undefined,           // the entity id counter (js/ids.js); villagers' ids are in villagers
    mobs: BF.mobSave ? BF.mobSave.serialize() : undefined,   // where every loaded mob was and what it was doing, for an exact reload (js/mobsave.js)
    wildlife: BF.wildlife ? BF.wildlife.serialize() : undefined,   // wild mobs stored with unloaded chunks, chunks that rolled their animals, village nights (js/wildlife.js)
    weather: BF.weather && BF.weather.serialize ? BF.weather.serialize() : undefined,
    signs: BF.signs && BF.signs.serialize ? BF.signs.serialize() : undefined,
    vlog: BF.vlog ? BF.vlog.serialize() : undefined,   // village action logs (js/villagelog.js)
    vstats: BF.vstats ? BF.vstats.serialize() : undefined,   // population per game day, last 7 days (js/villagestats.js)
    econ: BF.econ ? BF.econ.serialize() : undefined,   // Economy view tallies, last 7 game days (js/economy.js)
    happy: BF.happiness ? BF.happiness.serialize() : undefined,   // village happiness: last week's events + last scores (js/happiness.js)
    days: BF.dayTimeline ? BF.dayTimeline.serialize() : undefined,   // villagers' day timelines, today and yesterday (js/daytimeline.js)
    maps: BF.maps && BF.maps.serialize ? BF.maps.serialize() : undefined, // explored pixels of filled maps (js/maps.js)
    drops: BF.drops && BF.drops.serialize ? BF.drops.serialize() : undefined, // dropped items lying in the world, with their age (js/drops.js)
    boats: BF.boats ? BF.boats.serialize() : undefined, // placed boats, the player's included, with any mob passenger (js/boats.js)
    horses: BF.horses ? BF.horses.serialize() : undefined, // every horse, wild or tamed, with its stats, saddle, owner and lead (js/horses.js)
    farmland: BF.farmland ? BF.farmland.serialize() : undefined, // farmland hydration clocks + last rain (js/farmland.js)
    bees: BF.bees ? BF.bees.serialize() : undefined, // every bee nest and hive: its bee count, honey level and last growth day (js/bees.js)
    chunkTime: BF.glog ? BF.glog.chunkTimes() : undefined, // game days each chunk has been loaded, the game log's chunk time (js/gamelog.js)
    edits,
  };
}

function restore(data, meta) {
  const monsters = meta && meta.monsters || data.monsters;   // the list entry's options win: the start screen may have changed them (js/gameopts.js)
  BF.newWorld(data.seed, { gameMode: data.player && data.player.gameMode, biomeScale: data.biomeScale || 1, villages: data.villages || 1, monsters });
  for (const k in data.edits || {}) {
    const a = data.edits[k], m = new Map();
    for (let i = 0; i < a.length; i += 2) m.set(a[i], a[i + 1]);
    BF.world.edits.set(k, m);
  }
  if (data.spawn) BF.spawnPoint = data.spawn;
  if (BF.rand) BF.rand.load(data.rand);   // missing in older saves: the counters start at 0
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
  if (BF.ids) BF.ids.deserialize(data.ids); // the id counter (js/ids.js)
  if (BF.wildlife) BF.wildlife.deserialize(data.wildlife); // old saves: every chunk rolls its animals once, the first time it loads
  if (BF.mobSave) BF.mobSave.deserialize(data.mobs); // old saves: nothing to restore exactly (wild mobs go to js/wildlife.js, so after it)
  if (data.weather && BF.weather && BF.weather.deserialize) BF.weather.deserialize(data.weather); // old saves: newWorld's seeded default
  if (BF.vlog) BF.vlog.deserialize(data.vlog); // old saves: no logs
  if (BF.vstats) BF.vstats.deserialize(data.vstats); // old saves: no population history
  if (BF.econ) BF.econ.deserialize(data.econ); // old saves: empty tallies
  if (BF.happiness) BF.happiness.deserialize(data.happy || { fromLog: data.vlog }); // old saves: last week's events from the log
  if (BF.dayTimeline) BF.dayTimeline.deserialize(data.days); // old saves: empty timelines
  if (BF.maps && BF.maps.deserialize) BF.maps.deserialize(data.maps); // old saves: no maps
  if (BF.signs && BF.signs.deserialize) BF.signs.deserialize(data.signs); // sign texts + auto-sign state (old saves: none)
  if (BF.drops && BF.drops.deserialize) BF.drops.deserialize(data.drops); // dropped items (old saves: none)
  if (BF.boats) BF.boats.deserialize(data.boats); // boats, after the player: one saved with the player aboard puts them back in it (old saves: none)
  if (BF.horses) BF.horses.deserialize(data.horses); // horses come back when the player is near their chunk (old saves: none)
  if (BF.farmland) BF.farmland.deserialize(data.farmland); // farmland clocks (old saves: each block's clock starts when first seen)
  if (BF.bees) BF.bees.deserialize(data.bees); // bee homes (old saves: none)
  if (BF.glog) BF.glog.loadChunkTimes(data.chunkTime); // chunk times (old saves: every chunk starts at 0)
  if (BF.gameOpts) BF.gameOpts.purgeStored();   // monsters switched off since the save don't come back with their chunks
  BF.emit("worldRestored", data, meta);   // (js/simworker.js: region workers restore the same data, js/rplay.js)
}

// The page's copy of a saved world, when the simulation is in a worker (r15-38): what the page draws and plays with. The worker restores
// the whole of it (restore above) and sends the block edits.
function restoreClient(data, meta) {
  const monsters = meta && meta.monsters || data.monsters;
  BF.newWorld(data.seed, { gameMode: data.player && data.player.gameMode, biomeScale: data.biomeScale || 1, villages: data.villages || 1, monsters });
  if (data.spawn) BF.spawnPoint = data.spawn;
  if (BF.rand) BF.rand.load(data.rand);
  if (data.time) { BF.sky.day = data.time.day || 0; BF.sky.setTime(data.time.t); }
  if (BF.player.deserialize) BF.player.deserialize(data.player || {});
  if (data.inventory && BF.inventory.setOwn) { BF.inventory.setOwn(data.inventory.slots); BF.inventory.select(+data.inventory.selected || 0); }
  if (data.weather && BF.weather && BF.weather.deserialize) BF.weather.deserialize(data.weather);
}
const host = () => (BF.simHost && BF.simHost.worker ? BF.simHost : null);   // the page, with the simulation in a worker
// the page, a client of the world server (r15-41): the saved worlds are the server's (on its disk), not this browser's
const server = () => (BF.simHost && BF.simHost.server ? BF.simHost : null);
const asked = (q, what) => server().saves(q).then(r => { if (!r || !r.ok) throw new Error(r && r.why || "the world server could not " + what); return r; });

// A typed number seed -> world seed (the terrain noise takes 32 bits and treats 0 as 1). 1..4294967295 are used as they
// are, so those seeds keep giving the worlds they always have. 0, negative and larger numbers used to wrap onto that range
// (0 gave seed 1's terrain, 4294967297 gave 1, -1 gave 4294967295, huge numbers gave 0); they are now hashed from their digits
// instead, so different numbers give different worlds. Saved worlds store the resulting seed, so they never change.
function numberSeed(text) {
  const n = BigInt(text);
  if (n >= 1n && n <= 4294967295n) return Number(n);
  let h = 0x811c9dc5;
  for (const ch of "#" + n.toString()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);   // FNV-1a of the canonical number
  return (h >>> 0) || 0x9e3779b9;
}

// ---------- game logs (js/gamelog.js) ----------
const LOGH = id => id + "#loghead", LOGK = id => id + "#log:", logKey = (id, seq) => LOGK(id) + String(seq).padStart(9, "0");
const logRange = id => IDBKeyRange.bound(LOGK(id), LOGK(id) + "\uffff");
const logStore = {
  // -> {head, entries} (head null when the world has no log yet)
  read(id) {
    return tx(["data"], "readonly", t => { const s = t.objectStore("data"); return Promise.all([reqP(s.get(LOGH(id))), reqP(s.getAll(logRange(id)))]); })
      .then(([head, batches]) => ({ head: head || null, entries: head ? [].concat(...(batches || [])) : [] }));
  },
  // adds batch number seq and drops the batches numbered in drop, with the head that lists them
  write(id, head, seq, list, drop) {
    return tx(["data"], "readwrite", t => {
      const s = t.objectStore("data");
      s.put(list, logKey(id, seq)); s.put(head, LOGH(id));
      for (const d of drop || []) s.delete(logKey(id, d));
    });
  },
};

// ---------- export / import (spec r15-42): this browser's worlds as .bfworld files (js/savefile.js) ----------
// -> {game, meta, data, log: {head, lists} | null} of a world in this browser's IndexedDB
function exportRecord(id) {
  return tx(["worlds", "data"], "readonly", t => {
    const d = t.objectStore("data");
    return Promise.all([reqP(t.objectStore("worlds").get(id)), reqP(d.get(id)), reqP(d.get(LOGH(id))), reqP(d.getAll(logRange(id)))]);
  }).then(([meta, data, head, lists]) => {
    if (!meta || !data) throw new Error("World not found");
    return { game: BF.VERSION || null, meta, data, log: head ? { head, lists: lists || [] } : null };
  });
}
// a world from a file into this browser's IndexedDB; keepId: a world already here with its id is left as it is ({skipped: true}),
// else it gets a new id. -> {meta, skipped}
function importRecord(rec, keepId) {
  const meta = Object.assign({}, rec.meta), data = rec.data;
  if (!playable(meta) || !playable(data)) throw new Error(tooOld(meta));
  return tx(["worlds"], "readonly", t => reqP(t.objectStore("worlds").get(meta.id))).then(had => {
    if (had && keepId) return { meta: had, skipped: true };
    if (had || !meta.id) meta.id = newId();
    meta.lastPlayed = Date.now();
    meta.name = clampName(meta.name, "Imported world");   // (as Create and Rename keep names: bug-072)
    const log = rec.log;
    return tx(["worlds", "data"], "readwrite", t => {
      t.objectStore("worlds").put(meta);
      const d = t.objectStore("data");
      d.put(data, meta.id);
      if (log && log.head) {
        const head = Object.assign({}, log.head, { name: meta.name });
        d.put(head, LOGH(meta.id));
        (head.batches || []).forEach(([seq], i) => d.put(log.lists[i] || [], logKey(meta.id, seq)));
      }
    }).then(() => ({ meta, skipped: false }));
  });
}
// a world's name as kept: at most 40 characters, never half an emoji (bug-072; as js/savefile.js clampName, which the simulation
// doesn't load; the world server clamps its own renames)
const clampName = (name, dflt) => Array.from(String(name == null ? "" : name)).slice(0, 40).join("").trim() || dflt || "World";
const newId = () => "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
const download = (url, name) => { const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
// the world server's import (debug/server.js -> server/world.js): the file's bytes; keep: as importRecord's keepId
const upload = (body, keep) => fetch("/saves/import" + (keep ? "?keep=1" : ""), { method: "POST", body, headers: { "X-Blockfield": "saves" } })
  .then(r => r.json().catch(() => ({ ok: false, why: "the world server answered " + r.status })))
  .then(r => { if (!r.ok) throw new Error(r.why || "the world server could not import it"); return r; });
const slog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "save", text); };

// ---------- public API ----------
// Worlds 1.5 can open: snapshot version 3. Older worlds (version 2: the planets of 1.4; version 1: the flat worlds of 1.3 and before)
// are listed greyed with only Delete, and load() refuses them (Gordon, 2026-10-15: no old saves in 1.4; 2026-10-23: 1.5 doesn't load
// 1.4 saves).
const playable = meta => !!meta && meta.version >= VERSION;
const madeWith = meta => meta && meta.version === 2 ? "1.4" : "1.3";   // (an old world's release, for the messages)
const tooOld = meta => "Made with Blockfield " + madeWith(meta) + ", can't be opened in " + (BF.VERSION || "1.5");
const save = {
  current: null,
  playable,          // meta of the world being played, or null (unsaved demo world)
  tooOld,                 // tooOld(meta): why an old world can't be opened ("Made with Blockfield 1.4, can't be opened in 1.5")
  lastError: null,        // why the last save failed (null once one works)
  lastSaved: 0,
  supported: typeof indexedDB !== "undefined",
  numberSeed,             // exposed for tests
  snapshot,               // the save data of the world being played (the headless boot's save(), js/boot.js)
  restoreClient,          // the page's copy of a saved world (the simulation in a worker, r15-38)
  restore,                // restore(data, meta?): the world from save data (the headless boot)
  logStore,               // the game log's storage (js/gamelog.js)
  exportRecord, importRecord,   // this browser's worlds as file records (js/savefile.js), for tests

  // -> [{id, name, seed, gameMode, created, lastPlayed}] newest first; [] if storage is unavailable
  list() {
    if (server()) return asked({ op: "list" }, "list its worlds").then(r => r.list || [], () => []);
    return tx(["worlds"], "readonly", t => reqP(t.objectStore("worlds").getAll()))
      .then(p => p).then(a => (a || []).sort((x, y) => y.lastPlayed - x.lastPlayed))
      .catch(() => []);
  },

  // Starts a brand-new saved world, a planet. opts: {name, seed (number|string|blank), gameMode, biomeScale (>=1, default 1), villages, monsters}
  create(opts = {}) {
    let seed = opts.seed;
    if (seed === undefined || seed === null || seed === "") seed = 1 + Math.floor(Math.random() * 4294967295);
    else if (!/^-?\d+$/.test(String(seed).trim())) { let h = 0; for (const ch of String(seed)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; seed = h >>> 0; }
    else seed = numberSeed(String(seed).trim());
    const now = Date.now();
    const meta = { id: newId(), name: clampName(opts.name, "New World"), seed, gameMode: opts.gameMode || "survival", gen: 4, version: VERSION, game: BF.VERSION, biomeScale: Math.max(1, Number(opts.biomeScale) || 1), villages: opts.villages || 10, monsters: BF.gameOpts ? BF.gameOpts.normalize(opts.monsters) : undefined, created: now, lastPlayed: now };
    const start = () => {
      const o = { gameMode: meta.gameMode, biomeScale: meta.biomeScale, villages: meta.villages, monsters: meta.monsters };
      BF.newWorld(seed, o);
      save.current = meta;
      BF.emit("worldLoaded", meta);
      const H = host();
      if (H) return H.world("create", { seed, opts: o, meta }).then(r => { if (!r.ok) throw new Error(r.why || "the worker could not create it"); return meta; });
      return save.saveNow().then(() => meta);
    };
    return BF.prepareWorld(seed).then(start);   // (the planet works out its rivers first)
  },

  // Loads a saved world by id. Resolves to its meta; rejects a world 1.4 can't open (not playable: a 1.3 world).
  load(id) {
    return (server() ? asked({ op: "get", id }, "find it").then(r => [r.meta, r.data])   // (the world server's world: the page's part of it)
      : tx(["worlds", "data"], "readonly", t => Promise.all([reqP(t.objectStore("worlds").get(id)), reqP(t.objectStore("data").get(id))])))
      .then(([meta, data]) => {
        if (!meta || !data) throw new Error("World not found");
        if (!playable(meta) || !playable(data)) { slog("INFO", "World \"" + meta.name + "\" was not opened: " + tooOld(meta)); throw new Error(tooOld(meta)); }
        return BF.prepareWorld(data.seed).then(() => [meta, data]);   // (the planet works out its rivers first)
      })
      .then(([meta, data]) => {
        const H = host();
        if (H) {
          restoreClient(data, meta);
          save.current = meta;
          BF.emit("worldLoaded", meta);
          return H.world("load", { id }).then(r => { if (!r.ok) throw new Error(r.why || "the worker could not load it"); save.current = r.meta || meta; return save.current; });
        }
        restore(data, meta);
        meta.lastPlayed = Date.now();
        save.current = meta;
        BF.emit("worldLoaded", meta);
        return save.saveNow().then(() => meta);
      });
  },

  remove(id) {
    if (save.current && save.current.id === id) save.current = null;
    if (BF.glog) BF.glog.forget(id);   // its game log goes too, with nothing more written
    if (host() && BF.client && BF.client.meta) BF.client.meta({ id, forget: true });   // (there too: the simulation keeps the log, and would write it again)
    if (server()) return asked({ op: "remove", id }, "delete it").then(() => undefined);
    return tx(["worlds", "data"], "readwrite", t => { t.objectStore("worlds").delete(id); const d = t.objectStore("data"); d.delete(id); d.delete(LOGH(id)); d.delete(logRange(id)); });
  },

  rename(id, name) {
    if (server()) return asked({ op: "rename", id, name: String(name) }, "rename it").then(r => {
      if (save.current && save.current.id === id) { save.current.name = r.meta.name; BF.client.meta({ id, name: r.meta.name }); }
    });
    return tx(["worlds"], "readwrite", t => {
      const s = t.objectStore("worlds");
      const r = s.get(id);
      r.onsuccess = () => { if (r.result) { r.result.name = clampName(name, r.result.name); s.put(r.result); if (save.current && save.current.id === id) { save.current.name = r.result.name; if (host()) BF.client.meta({ id, name: r.result.name }); } } };
    });
  },

  // A saved world's game options (js/gameopts.js): which monsters spawn ({type: bool}), from the start screen. The world being played
  // takes them at once.
  setMonsters(id, o) {
    const m = BF.gameOpts ? BF.gameOpts.normalize(o) : o;
    if (save.current && save.current.id === id && BF.gameOpts) { for (const t in m) BF.gameOpts.set(t, m[t]); save.current.monsters = m; if (host()) BF.client.meta({ id, monsters: m }); }
    if (server()) return asked({ op: "monsters", id, monsters: m }, "change it").then(() => undefined);
    return tx(["worlds"], "readwrite", t => {
      const s = t.objectStore("worlds"), r = s.get(id);
      r.onsuccess = () => { if (r.result) { r.result.monsters = m; s.put(r.result); } };
    });
  },

  // Save and Quit to Title, after the save: the world stays as the title background, unsaved, here and where the simulation is (which
  // would otherwise go on autosaving it and keep its game log open).
  quit() {
    const cur = save.current;
    save.current = null;
    if (cur && host() && BF.client && BF.client.meta) BF.client.meta({ id: cur.id, quit: true });
  },
  // Writes the current world now. Resolves true when saved (false when there's nothing to save).
  saveNow() {
    if (!save.current || !save.supported) return Promise.resolve(false);
    const H = host();
    if (H) {   // the worker saves: the player as it is now goes first
      H.frame();
      return new Promise(resolve => BF.client.save(r => {
        const ok = !!(r && r.ok);
        if (ok) { save.lastSaved = Date.now(); save.lastError = null; BF.emit("worldSaved", save.current); }
        else if (r && r.why) { save.lastError = r.why; BF.emit("saveFailed", new Error(r.why)); }
        resolve(ok);
      }));
    }
    const t0 = performance.now();
    // cluster workers in play (js/rplay.js, js/cworkers.js): each worker's copy is current only for its own clusters, so the save waits for
    // the next meeting (at most a game second), where every worker sends its mobs and the world is taken whole (the followers alike)
    const CW = BF.cworkers;
    if (CW && CW.active && BF.rworkers && BF.rworkers.journal) {
      BF.rworkers.rec(["sm"]);
      const name = save.current.name;
      return new Promise(res => CW.whenMet(ok => {
        if (!ok) { slog("ERROR", "Saving world \"" + name + "\" failed (the cluster workers stopped first); the previous save is kept"); res(false); return; }
        let data;
        try { data = CW.gathered(() => snapshot({ quiet: true }), "save"); } catch (e) { console.error(e); res(false); return; }
        res(save.current ? write(data, performance.now()) : false);
      }));
    }
    let data0;
    try { data0 = snapshot(); } catch (e) { console.error(e); return Promise.resolve(false); }
    return write(data0, performance.now());
    function write(data, t1) {
    const meta = Object.assign({}, save.current, { lastPlayed: Date.now(), gameMode: data.player && data.player.gameMode || save.current.gameMode, seed: data.seed, gen: data.gen, biomeScale: data.biomeScale || 1, villages: data.villages || 1, monsters: data.monsters || save.current.monsters, version: data.version, game: BF.VERSION, time: data.time });
    save.current = meta;
    return tx(["worlds", "data"], "readwrite", t => { t.objectStore("worlds").put(meta); t.objectStore("data").put(data, meta.id); })
      .then(() => {
        save.lastSaved = Date.now(); save.lastError = null;
        slog("DEBUG", "Saved world \"" + meta.name + "\" in " + Math.round(performance.now() - t0) + " ms (" + Math.round(t1 - t0) + " ms to gather it)");
        BF.emit("worldSaved", meta); return true;
      })
      .catch(e => {
        const why = String(e && e.message || e);
        console.error("Save failed", e);
        save.lastError = why;
        slog("ERROR", "Saving world \"" + meta.name + "\" failed (" + why + "); the previous save is kept");
        BF.emit("saveFailed", e); return false;
      });
    }
  },

  // A saved world as a .bfworld file, downloaded (spec r15-42): the world server's copy (debug/server.js serves it), or this browser's.
  // One that can't be exported rejects with why (the title screen shows it) and is an ERROR "save" in the game log.
  exportFile(id) {
    const w = save.current && save.current.id === id ? save.current : null;
    const failed = e => { slog("ERROR", "Exporting world " + (w ? "\"" + w.name + "\"" : id) + " failed: " + (e && e.message || e)); throw e; };
    const give = (blob, name) => { const url = URL.createObjectURL(blob); download(url, name); setTimeout(() => URL.revokeObjectURL(url), 60000); };
    if (server()) {
      // fetched first, so a server that can't export it (a 404, a failed save) gives its reason instead of a junk download (bug-073)
      return fetch("/saves/" + encodeURIComponent(id) + "/export").then(r => {
        if (!r.ok) return r.json().catch(() => ({})).then(j => { throw new Error(j.why || "the world server answered " + r.status); });
        const cd = r.headers.get("Content-Disposition") || "", m = /filename\*=UTF-8''([^;]+)/.exec(cd);
        let name = BF.saveFile.fileName(w && w.name);
        if (m) try { name = decodeURIComponent(m[1]); } catch (e) { /* the default */ }
        return r.blob().then(blob => {
          give(blob, name);
          slog("INFO", "Exported world " + (w ? "\"" + w.name + "\"" : id) + " from the world server (" + Math.round(blob.size / 1024) + " KB)");
          return true;
        });
      }).catch(failed);
    }
    const first = w && save.saveNow ? save.saveNow() : Promise.resolve();
    return first.then(() => exportRecord(id)).then(rec => BF.saveFile.pack(rec).then(blob => {
      give(blob, BF.saveFile.fileName(rec.meta.name));
      slog("INFO", "Exported world \"" + rec.meta.name + "\" (" + Math.round(blob.size / 1024) + " KB)");
      return true;
    })).catch(failed);
  },
  // A .bfworld file (a File or Blob) -> the world it holds, added to the world server's saves or this browser's. -> its meta
  importFile(file) {
    return Promise.resolve(file.arrayBuffer()).then(buf => {
      if (server()) return upload(buf, false).then(r => r.meta);
      return BF.saveFile.unpack(buf).then(rec => importRecord(rec, false)).then(r => r.meta);
    }).then(meta => { slog("INFO", "Imported world \"" + meta.name + "\" from " + (file.name || "a file") + (server() ? " to the world server" : "")); return meta; },
      e => { slog("ERROR", "Importing " + (file.name || "a file") + " failed: " + (e && e.message || e)); throw e; });
  },
  // This browser's own worlds (IndexedDB), whatever the page plays on: for "Copy browser saves to the server"
  browserList() {
    return tx(["worlds"], "readonly", t => reqP(t.objectStore("worlds").getAll())).then(a => (a || []).sort((x, y) => y.lastPlayed - x.lastPlayed)).catch(() => []);
  },
  // Copies this browser's worlds to the world server (they stay here too); one copied before is skipped. -> {copied, skipped, old, failed}
  copyToServer() {
    if (!server()) return Promise.reject(new Error("no world server"));
    const out = { copied: [], skipped: [], old: [], failed: [] };
    return save.browserList().then(list => list.reduce((p, w) => p.then(() => {
      if (!playable(w)) { out.old.push(w.name); return; }
      return exportRecord(w.id).then(rec => BF.saveFile.pack(rec)).then(blob => upload(blob, true))
        .then(r => (r.skipped ? out.skipped : out.copied).push(w.name), e => out.failed.push(w.name + ": " + (e && e.message || e)));
    }), Promise.resolve())).then(() => {
      slog("INFO", "Copied browser saves to the world server: " + out.copied.length + " copied, " + out.skipped.length + " already there, " + out.old.length + " too old" + (out.failed.length ? ", " + out.failed.length + " failed (" + out.failed.join("; ") + ")" : ""));
      return out;
    });
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
if (BF.page) addEventListener("pagehide", flush);
if (BF.page) document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
})();
