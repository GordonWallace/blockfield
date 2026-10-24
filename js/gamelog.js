// Game log: one chronological, timestamped log per saved world, kept in the browser's IndexedDB next to the world's save
// (js/save.js logStore) and shown live on the debug screen (debug/index.html, the Game log button).
// Each entry has the system time, the game time, the chunk time (game days the chunk at the event's position has been loaded over
// the whole game; "-" for events with no position), a level, a kind, the village's name (village events) and the text. Levels:
//   ERROR  villager tasks cut off when their village unloads (js/villagesim.js), errors the game caught (console.error), uncaught errors
//   WARN   console warnings, a session that ended without unloading the game, game files that changed on disk mid-session
//   INFO   the game loaded and unloaded, version or commit changes, every village log entry (js/villagelog.js)
//   DEBUG  the jobs' own event lists (the LOG arrays of the miner, baker, builder... modules) and births and grow-ups (js/breeding.js)
// The file starts with a header line: world, seed, version and commit (the commit is read by the debug server, globalThis.BF_BUILD;
// a game not served by it has none). Lines are written by js/logmatch.js (gameLine), which the debug screen shares.
// Entries logged while no saved world is open are kept from the last newWorld (a world being loaded) and go to the world that opens.
// Each world keeps up to CAP entries; past that the oldest are dropped, a stored batch at a time.
// Adding something to the log: BF.glog.log(level, kind, text, { village: rec|key, at: mob|{x,y,z}|[x,y,z] }).
// API: BF.glog = { LEVELS, CAP, log(level, kind, text, opts?), job(src, e) -> e, village(rec, e), entries(), base(), world(), head(),
//                  forget(id), headLine(), recent(n) (the newest entries, also before a saved world opens), text(list?), chunkDays(x, z), chunkTimes(), loadChunkTimes(o), flush(), feed(), feedAt(n), feedReset(), setSink(fn),
//                  diskBuild(build), build, ready(), tap(fn) (fn(entry) for each new entry), remote(fn), ingest(list) }
// With the simulation in a Web Worker (spec r15-38) the worker keeps the world's log and saves it; the page's log is remote(fn): its own
// entries (its errors) go to fn (the protocol, to the worker's log) instead of being kept, and the worker's come in by ingest(list) to
// be read here (recent(), the debug overlay).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const CAP = 100000;              // entries kept per world
const FLUSH_MS = 5000;           // new entries are written this often (and whenever the world saves)
const FEED_MAX = 3000;           // entries per debug feed snapshot (a whole log reaches a fresh debug server in a few seconds)
const BUILD = Object.assign({ commit: null, branch: null }, globalThis.BF_BUILD || {});   // set by debug/server.js
const LM = () => BF.logmatch;

let world = null, wname = "", head = null, entries = [], base = 0, savedTo = 0, loading = false, pre = [];
let sentTo = 0, sentWorld = null, sendReset = true, diskSeen = null;
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);

// ---------------------------------------------------------------- chunk time
// Game days each chunk has been loaded, over the whole game (saved with the world, js/save.js chunkTime). Like the village age
// (js/villagelife.js villageAges) it counts game time only, so time spent unloaded or with the save closed doesn't count, and a
// skip while loaded (sleeping, fast-forward) does. The chunk load and unload hooks (js/world.js) give the exact times.
const ctime = new Map(), since = new Map();   // "cx,cz" -> days before its current load; loaded chunk -> game day it loaded
const ck = (cx, cz) => cx + "," + cz;
const r4 = n => Math.round(n * 1e4) / 1e4;
const CQ = {};
function chunkDays(x, z) {
  BF.planet.canon(x, z, CQ); x = CQ.x; z = CQ.z;   // a point seen across a face edge: the chunk it shows
  const cs = BF.CS || 16, k = ck(Math.floor(x / cs), Math.floor(z / cs)), t0 = since.get(k);
  return r4((ctime.get(k) || 0) + (t0 != null ? Math.max(0, dayNow() - t0) : 0));
}
function chunkTimes() {
  const out = {}, now = dayNow();
  for (const [k, d] of ctime) out[k] = d;
  for (const [k, t0] of since) out[k] = (out[k] || 0) + Math.max(0, now - t0);
  for (const k in out) { out[k] = r4(out[k]); if (!(out[k] > 0)) delete out[k]; }
  return out;
}
function loadChunkTimes(o) {
  ctime.clear();
  for (const k in o || {}) if (Number.isFinite(+o[k]) && +o[k] > 0) ctime.set(k, +o[k]);
}
const restamp = () => { const now = dayNow(); for (const k of since.keys()) since.set(k, now); };   // a restored save's clock starts now

// ---------------------------------------------------------------- entries
function posOf(at) {
  const p = at && at.position ? at.position : at;
  if (Array.isArray(p) && p.length >= 3 && Number.isFinite(p[0]) && Number.isFinite(p[2])) return [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
  if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return [Math.floor(p.x), Math.floor(p.y || 0), Math.floor(p.z)];
  return null;
}
function villageName(v) {
  const key = v && typeof v === "object" ? v.key : v;
  if (!key) return null;
  return (BF.signs && BF.signs.villageName && BF.signs.villageName(key)) || "Village " + key;
}
let sink = null;   // headless (tools/headless.js): every entry also goes to a file
let fwd = null;    // the page with the simulation in a worker: entries go there (remote)
let rlog = [];     // and the worker's newest entries come here (ingest), to read
const taps = [];   // fn(entry) for every new entry: the protocol's log messages (js/protocol.js, spec r15-36)
function add(e) {
  if (sink) { try { sink(e); } catch (err) { /* never let logging stop the game */ } }
  if (world) entries.push(e);
  else { pre.push(e); if (pre.length > 5000) pre.shift(); }
  for (const fn of taps) { try { fn(e); } catch (err) { /* never let a listener stop logging */ } }
  return e;
}
function log(level, kind, text, o) {
  o = o || {};
  const at = posOf(o.at);
  const e = { s: Date.now(), d: r4(dayNow()), c: at ? chunkDays(at[0], at[2]) : null, l: level, k: kind, v: villageName(o.village), x: String(text) };
  if (at) e.p = at;
  if (fwd) { try { fwd([e]); } catch (err) { /* never let logging stop the game */ } return e; }
  return add(e);
}
const val = v => typeof v === "number" || typeof v === "boolean" || v == null ? String(v) : typeof v === "string" && !/[\s=]/.test(v) && v ? v : JSON.stringify(v);
// A job module's own event ({kind, day, who, ...}, its LOG array): DEBUG, "kind who=... key=value ...". Returns the event, so
// a module logs with LOG.push(BF.glog.job("miner", {...})).
function job(src, e) {
  try {
    const parts = [];
    for (const k in e) if (k !== "kind" && k !== "day" && k !== "t" && k !== "village") parts.push(k + "=" + val(e[k]).slice(0, 300));
    log("DEBUG", src, (e.kind || "event") + (parts.length ? " " + parts.join(" ") : ""), { village: e.village });
  } catch (err) { /* never let logging stop a job */ }
  return e;
}
// A village log entry [t, kind, text, [x, y, z]?] (js/villagelog.js): INFO under its own kind (trade, bed, build...)
function village(rec, e) { try { log("INFO", e[1], e[2], { village: rec, at: e[3] }); } catch (err) { /* as above */ } }

// ---------------------------------------------------------------- errors the game prints
// console.error / console.warn still print as before; their text is logged too (errors with their stack's first lines).
const stackOf = err => String((err && err.stack) || err).split("\n").slice(0, 8).join("\n");
const argText = a => a instanceof Error ? stackOf(a) : typeof a === "object" && a ? (() => { try { return JSON.stringify(a).slice(0, 500); } catch (e) { return String(a); } })() : String(a);
let inLog = false;
const orig = {};
for (const [fn, level] of [["error", "ERROR"], ["warn", "WARN"]]) {
  orig[fn] = console[fn];
  console[fn] = function (...a) {
    if (!inLog) { inLog = true; try { log(level, "console", a.map(argText).join(" ")); } catch (e) { /* ignore */ } inLog = false; }
    return orig[fn].apply(this, a);
  };
}
if (BF.page) addEventListener("error", ev => { if (ev.error || ev.message) log("ERROR", "uncaught", ev.error ? stackOf(ev.error) : ev.message + (ev.filename ? " (" + ev.filename + ":" + ev.lineno + ")" : "")); });
if (BF.page) addEventListener("unhandledrejection", ev => log("ERROR", "uncaught", "unhandled promise rejection: " + stackOf(ev.reason)));

// ---------------------------------------------------------------- the world's log
const fmtBuild = (v, c, b) => v + " (commit " + (c ? c.slice(0, 10) : "unknown") + (c && b ? ", " + b : "") + ")";
function headLine() {
  if (!head) return "";
  const off = -new Date(head.created).getTimezoneOffset(), oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  return "# Blockfield game log | world \"" + head.name + "\" | seed " + head.seed + " | version " + head.version + " | commit " + (head.commit || "unknown") +
    (head.commit && head.branch ? " (" + head.branch + ")" : "") + " | started " + LM().sysStamp(head.created) + " (UTC" + (off < 0 ? "-" : "+") + String(oh).padStart(2, "0") + ":" + String(om).padStart(2, "0") + ")";
}
function newHead(m) {
  return { v: 1, name: m.name, seed: m.seed, version: BF.VERSION || "?", commit: BUILD.commit, branch: BUILD.branch, created: Date.now(),
    cur: { version: BF.VERSION || "?", commit: BUILD.commit, branch: BUILD.branch }, batches: [], nextSeq: 0, base: 0 };
}
const store = () => BF.save && BF.save.supported && BF.save.logStore;
function open(m) {
  if (fwd || world === m.id) return;   // (remote: the worker opens it)
  if (world) close("another world was opened");
  world = m.id; wname = m.name; head = null; loading = true; base = 0; savedTo = 0;
  entries = pre; pre = [];
  const fresh = entries;
  restamp();
  log("INFO", "game", "Game loaded: \"" + m.name + "\", seed " + m.seed + ", " + (m.gameMode || "survival") + ", version " + fmtBuild(BF.VERSION || "?", BUILD.commit, BUILD.branch));
  if (BF.shared) log("INFO", "game", BF.shared.text + (BF.shared.on ? " (chunk block data in SharedArrayBuffers)" : ""));   // r15-35 (js/world.js)
  const st = store();
  Promise.resolve(st ? st.read(m.id).catch(e => { orig.error.call(console, "game log: can't read", e); return null; }) : null).then(r => {
    if (world !== m.id) return;
    head = r && r.head ? r.head : newHead(m);
    head.name = m.name;
    const old = r && r.head ? r.entries : [];
    base = head.base || 0;
    const lastOld = old[old.length - 1];
    if (lastOld && !(lastOld.k === "game" && /^Game unloaded/.test(lastOld.x)))   // the last session never logged its unload: closed or crashed
      fresh.unshift({ s: Date.now(), d: lastOld.d, c: null, l: "WARN", k: "game", v: null, x: "The last session ended without unloading the game (its tab was closed or the browser stopped); its last entry was at " + LM().sysStamp(lastOld.s) });
    entries = old.concat(fresh);
    savedTo = base + old.length;
    loading = false;
    const c = head.cur || {}, nowV = BF.VERSION || "?";
    if (r && r.head && (c.version !== nowV || (c.commit || null) !== (BUILD.commit || null)))
      log("INFO", "version", "Version changed: " + fmtBuild(c.version, c.commit, c.branch) + " -> " + fmtBuild(nowV, BUILD.commit, BUILD.branch));
    head.cur = { version: nowV, commit: BUILD.commit, branch: BUILD.branch };
    flush();
  });
}
function close(why) {
  if (!world || fwd) return;
  log("INFO", "game", "Game unloaded: \"" + wname + "\"" + (why ? " (" + why + ")" : ""));
  flush();
  world = null; head = null; entries = []; base = 0; savedTo = 0; loading = false;
}
// Writes what's new as one batch; drops the oldest batches past CAP.
function flush() {
  const st = store();
  if (!world || loading || !head || !st) return Promise.resolve(false);
  const from = savedTo - base, list = entries.slice(from);
  if (!list.length) return Promise.resolve(false);
  savedTo = base + entries.length;
  const seq = head.nextSeq++, drop = [];
  head.batches.push([seq, list.length]);
  let total = head.batches.reduce((s, b) => s + b[1], 0);
  while (total > CAP && head.batches.length > 1) {
    const [s, n] = head.batches.shift();
    drop.push(s); total -= n; entries.splice(0, n); base += n;
  }
  head.base = base;
  return st.write(world, head, seq, list, drop).then(() => true, e => { orig.error.call(console, "game log: can't write", e); return false; });
}
setInterval(flush, FLUSH_MS);
// The world is being deleted (js/save.js remove): stop its log without writing anything more.
function forget(id) { if (world === id) { world = null; head = null; entries = []; base = 0; savedTo = 0; loading = false; } }
function text(list) {
  return [headLine()].concat((list || entries).map(LM().gameLine)).join("\n") + "\n";
}

// ---------------------------------------------------------------- the debug feed (js/debugfeed.js, debug/server.js)
// Each snapshot carries the entries the debug server doesn't have yet, by index in the world's log (base = the oldest one kept).
function feed() {
  if (!world || loading || !head) return undefined;
  if (sentWorld !== world || sentTo < base || sentTo > base + entries.length) { sentWorld = world; sentTo = base; sendReset = true; }
  const lines = entries.slice(sentTo - base, sentTo - base + FEED_MAX);
  if (!lines.length && !sendReset) return undefined;
  const out = { w: world, name: wname, head: headLine(), base, from: sentTo, lines, reset: sendReset };
  sentTo += lines.length; sendReset = false;
  return out;
}
const feedReset = () => { sentWorld = null; };                      // a new or restarted server: send the whole log again
const feedAt = n => { if (n >= base && n <= base + entries.length) sentTo = n; else sentWorld = null; };   // the server holds up to n
// The debug server reads the commit on disk with every snapshot; when it isn't the one running, the game's files have changed.
function diskBuild(b) {
  if (!b || !b.commit || b.commit === diskSeen || b.commit === BUILD.commit) return;
  diskSeen = b.commit;
  log("WARN", "version", "The game's files on disk changed to " + fmtBuild(b.version || "?", b.commit, b.branch) + " while " + fmtBuild(BF.VERSION || "?", BUILD.commit, BUILD.branch) + " is running; reload the page to run them");
}

// ---------------------------------------------------------------- hooks
function hook() {
  if (BF.world && BF.world.onChunkLoad) {
    BF.world.onChunkLoad((cx, cz) => since.set(ck(cx, cz), dayNow()));
    BF.world.onChunkUnload((cx, cz) => {
      const k = ck(cx, cz), t0 = since.get(k);
      if (t0 != null) { ctime.set(k, r4((ctime.get(k) || 0) + Math.max(0, dayNow() - t0))); since.delete(k); }
    });
  }
  if (BF.on) {
    BF.on("worldClosing", () => close());                           // BF.newWorld is about to replace the world (js/main.js)
    BF.on("newWorld", () => { ctime.clear(); since.clear(); pre = []; });
    BF.on("worldLoaded", m => { if (m && m.id) open(m); });          // js/save.js load and create
    BF.on("worldSaved", () => flush());
  }
  // Save and Quit to Title (js/player.js) clears save.current: the world is unloaded
  setInterval(() => { if (world && !loading && (!BF.save || !BF.save.current || BF.save.current.id !== world)) close(); }, 500);
}
if (!BF.page) BF.onLoad(hook);   // headless: once every sim file has loaded (js/env.js)
else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook); else hook();
if (BF.page) addEventListener("pagehide", () => close("the page was closed"));

BF.glog = {
  LEVELS: ["ERROR", "WARN", "INFO", "DEBUG"], CAP, log, job, village, build: BUILD,
  entries: () => (fwd ? rlog : entries), recent: (n = 50) => (fwd ? rlog : world ? entries : pre).slice(-n), base: () => base, world: () => world, head: () => head, headLine, text,
  chunkDays, chunkTimes, loadChunkTimes, flush, forget, feed, feedAt, feedReset, diskBuild, ready: () => !!world && !loading, tap: fn => taps.push(fn),
  setSink: fn => { sink = typeof fn === "function" ? fn : null; },   // fn(entry) for every entry from now on (headless: the log file)
  remote: fn => { fwd = typeof fn === "function" ? fn : null; },   // fn(entries) takes this page's entries (r15-38); null: kept here again
  ingest: list => { for (const e of list || []) rlog.push(e); if (rlog.length > 5000) rlog.splice(0, rlog.length - 5000); },   // the worker's entries, to read here
};
})();
