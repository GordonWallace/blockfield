// The world server (spec r15-41): the game's simulation in this Node process, the page only drawing, like Minecraft's integrated
// server. Started by debug/server.js (so ./run.sh and run.cmd start everything); serves the simulation/client protocol (r15-36) on
// ws://<game host>:<game port>/sim (server/ws.js), bound like the game port (localhost unless --lan).
// The simulation runs in worker_threads (server/simthread.js), each the Web Worker's simulation (js/simworker.js, r15-38) unchanged:
// one thread per world, which starts its region workers (r15-39, js/rplay.js: --workers N, else none).
// One page plays at a time (a second one is refused and runs its own simulation); the world it plays is the one it picks on the title
// screen (its world message: demo, create, load). Saves are on disk, a folder per world (spec r15-42: <saves>/<world name>/, see
// server/savedir.js; the simulation writes them through server/idb.js), listed to the page instead of its IndexedDB ones (the saves
// message below). Over http on the game port (debug/server.js passes /saves/ here):
//   GET /saves/<id>/export   the world as a .bfworld file (js/savefile.js), saved first if it is being played or held
//   POST /saves/import[?keep=1]   a .bfworld file's world added to the saves (a new id if one has its id; keep=1: left as it is,
//                            {skipped}); -> {ok, meta, skipped} or {ok: false, why}. Needs the header X-Blockfield (no other site's page
//                            can send it without asking first).
// On the socket: binary frames are protocol packets ([header length u32 LE][1 if a binary part follows, u8][header JSON, UTF-8][binary part]); text frames are JSON
// for everything else, the same messages the page and a Web Worker exchange ({boot}, {ready}, {crash}, {failed}, {errorLine},
// {test}), plus the server's own:
//   server -> page: {hello: {server, version, held}} first (the page knows the server is there), {saves: {rid, ...}} answers,
//                   {feedAck: {...}} the debug server's answers that are the page's (alerts, planet toggles, screens, icons wanted)
//   page -> server: {saves: {rid, op: list | get | remove | rename | monsters, ...}}, {feedPage: {...}} the page's part of the debug
//                   feed (F3 numbers, alerts, planet toggles), {feedIcons: {id: {url, name}}} item icons the debug screen asked for
// The page closes (the socket closes): its world pauses at once and saves (Gordon, 2026-10-23), and stays in memory, held; a page that
// picks it again goes on with it at the speed it had. A page that picks another world: the held one is let go.
// The debug screen: this process reads the simulation's part of each snapshot from the thread itself (js/debugfeed.js simPart) and adds
// the page's latest part, so the screen keeps going with no page open.
// Game log (the simulation thread's, which is the world's): INFO "server" for a page connecting, refused, closing, picking a held world
// up; ERROR when a simulation thread stops on its own. Imports and exports go in the page's log (js/save.js) and this one's output.
// API: start({ servers (http servers to hook /sim on), saves (folder), build ({commit, branch}: the game log's), workers (region workers per
//   world, r15-39), split ("always" | "never"), verify (tests: split ticks between the copies' checks), debug: { push(snapshot) -> answer, screens() } }) -> world server
//   { stop() -> Promise (saves every world), status(), http(req, res, path) -> true when it answered (/saves/...) }
"use strict";
const { Worker } = require("worker_threads");
const path = require("path"), fs = require("fs"), v8 = require("v8");
const WS = require("./ws.js"), IDB = require("./idb.js"), SaveFile = require("../js/savefile.js");

const SIMTHREAD = path.join(__dirname, "simthread.js"), FEED_MS = 250, IMPORT_MAX = SaveFile.MAX;   // (bytes sent; unpacked it is held to SaveFile.MAX too: bug-071)
const SAVE_VERSION = 3;   // (js/save.js VERSION: the worlds this release opens)
const say = s => console.log("[world] " + s);

// ---- packets on the socket
function packetOut(p) {   // {h, b} -> one binary frame
  const h = Buffer.from(p.h, "utf8"), b = p.b ? Buffer.from(p.b) : null, out = Buffer.alloc(5 + h.length + (b ? b.length : 0));
  out.writeUInt32LE(h.length, 0); out[4] = b ? 1 : 0; h.copy(out, 5); if (b) b.copy(out, 5 + h.length);
  return out;
}
function packetIn(buf) {   // a binary frame -> {h, b} with b its own ArrayBuffer (transferred to the thread), or null
  const n = buf.readUInt32LE(0), h = buf.toString("utf8", 5, 5 + n);
  let b = null;
  if (buf[4]) { b = new ArrayBuffer(buf.length - 5 - n); Buffer.from(b).set(buf.subarray(5 + n)); }
  return { h, b };
}
// the save data for JSON: typed arrays as plain arrays (js/save.js restore reads both)
const json = o => JSON.stringify(o, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));

// ---- solved river networks (js/worldgen.js riverState), by "seed:biome size": a thread that solved one sends it here, and a world on
// the same planet starts from it (simworker.js replays it, as a Web Worker replays the page's). Kept in memory and in <saves>/rivers/,
// so a planet's network is solved once per machine, not once per world started (seed 3: about 75 s). The page doesn't send its copy
// to the server: it's tens of megabytes.
function riverCache(dir) {
  const mem = new Map(), file = k => path.join(dir, "rivers", encodeURIComponent(k) + ".v8");
  return {
    get(k) {
      if (mem.has(k)) return mem.get(k);
      try { const st = v8.deserialize(fs.readFileSync(file(k))); mem.set(k, st); return st; } catch (e) { return null; }
    },
    put(k, st) {
      if (!st || mem.has(k)) return;
      mem.set(k, st);
      while (mem.size > 4) mem.delete(mem.keys().next().value);
      try { fs.mkdirSync(path.dirname(file(k)), { recursive: true }); const t = file(k) + ".tmp"; fs.writeFileSync(t, v8.serialize(st)); fs.renameSync(t, file(k)); }
      catch (e) { say("could not keep the river network for " + k + ": " + e.message); }
    },
  };
}
const riverKey = (seed, biomeScale) => (Number(seed) >>> 0) + ":" + Math.max(1, Number(biomeScale) || 1);

// ---- a simulation thread: one world
let nextSim = 1;
class Sim {
  constructor(srv) {
    this.n = nextSim++; this.srv = srv; this.id = null; this.name = null; this.ready = false; this.dead = false; this.crashed = false;
    this.waits = {}; this.onReady = []; this.early = []; this.played = false;
    this.w = new Worker(SIMTHREAD, { workerData: { saves: srv.saves, build: srv.build, coarse: srv.coarse } });   // (coarse: --coarse on|off, js/gameopts.js)
    this.w.on("message", m => srv.fromSim(this, m));
    this.w.on("error", e => srv.simStopped(this, "it failed: " + (e && e.stack || e)));
    this.w.on("exit", code => srv.simStopped(this, "it exited (code " + code + ")"));
    this.post({ boot: { three: null, workers: srv.workers, split: srv.split, kind: srv.kind, verify: srv.verify } });   // (region workers per world: js/rplay.js)
  }
  post(m, transfer) { if (!this.dead) this.w.postMessage(m, transfer || []); }
  // a server request answered by the thread's {server: kind} (one at a time per kind); wait() only waits for it
  ask(kind, extra, ms = 10000) {
    const had = this.waits[kind], p = this.wait(kind, ms);
    if (!had && !this.dead) this.post(Object.assign({ server: kind }, extra || {}));
    return p;
  }
  wait(kind, ms = 10000) {
    if (this.dead) return Promise.resolve(null);
    if (this.waits[kind]) return this.waits[kind].p;
    let done;
    const p = new Promise(res => { done = res; });
    const t = setTimeout(() => this.answer(kind, null), ms);
    this.waits[kind] = { p, done: v => { clearTimeout(t); done(v); } };
    return p;
  }
  answer(kind, v) { const w = this.waits[kind]; if (w) { delete this.waits[kind]; w.done(v); } }
  kill() { if (this.dead) return; this.dead = true; for (const k in this.waits) this.answer(k, null); this.w.terminate(); }
}

function start(o) {
  const worlds = IDB.open(o.saves).worlds, rivers = riverCache(o.saves);
  for (const [a, b] of worlds.tidy()) say("renamed folder " + JSON.stringify(a) + " to " + JSON.stringify(b) + " (its world's name)");
  // region workers per world (spec r15-39, js/rplay.js): --workers N, else one, the simulation thread alone (while one thinks, every
  // follower still replays every tick on its own copy, about a core each, and the split hasn't paid; clusters, r15-39b, take over)
  const workers = o.workers > 0 ? Math.floor(o.workers) : 1;
  const srv = { saves: o.saves, build: o.build || null, coarse: o.coarse === "on" || o.coarse === "off" ? o.coarse : null, workers, split: o.split || null, kind: o.kind === "clusters" ? "clusters" : null, verify: o.verify || 0, client: null, active: null, held: null, spare: null, feedAck: null, page: null, icons: new Map(), wantIcons: new Map(), iconsDue: new Map(), iconsAsked: false, tests: [], stopping: false };
  const debug = o.debug || null;
  const fresh = () => { const s = srv.spare || new Sim(srv); srv.spare = null; return s; };
  const warm = () => { if (!srv.spare && !srv.stopping) srv.spare = new Sim(srv); };   // the next page's thread, loading while nobody waits
  const toPage = m => { if (srv.client) srv.client.send(typeof m === "string" ? m : JSON.stringify(m)); };
  // pacing: a page that reads slower than the world sends (a slow machine at a high speed) would leave everything after it, a query's
  // answer too, waiting behind a growing queue (minutes, in a test at 100x with clusters). Past PACE_HIGH bytes waiting, the
  // simulation sends moving things twice a second instead of every tick (protocol.js pace: each send is the change since the last),
  // until the queue is under PACE_LOW
  const PACE_HIGH = 512 * 1024, PACE_LOW = 64 * 1024;
  function pace(s) {
    const ws = srv.client;
    if (srv.paced || !ws || ws.bufferedAmount < PACE_HIGH) return;
    srv.paced = s;
    s.post({ server: "pace", behind: true });
    if (!srv.paceLogged || Date.now() - srv.paceLogged > 60000) { srv.paceLogged = Date.now(); logIn(s, "The page reads slower than the world sends (" + Math.round(ws.bufferedAmount / 1024) + " KB waiting): moving things go to it twice a second until it catches up"); }
    const t = setInterval(() => {
      if (srv.client === ws && ws.bufferedAmount > PACE_LOW && srv.active === s && !s.dead) return;
      clearInterval(t);
      if (!s.dead) s.post({ server: "pace", behind: false });
      if (srv.paced === s) srv.paced = null;
    }, 100);
  }
  const sims = () => [srv.active, srv.held, srv.spare].filter(s => s && !s.dead);
  const logIn = (s, text, lvl = "INFO") => { if (s && !s.dead) s.post({ h: JSON.stringify({ t: "clientLog", list: [{ l: lvl, k: "server", x: text }] }), b: null }); };

  // ---- from a simulation thread
  srv.fromSim = (s, m) => {
    if (m && m.h != null) {
      if (s === srv.active && srv.client) { srv.client.send(packetOut(m)); pace(s); }
      else if (!s.played && m.h.startsWith('{"t":"log"') && s.early.length < 200) s.early.push(m);   // (a fresh thread's boot lines: for its first page)
      return;
    }
    if (!m) return;
    if (m.server) {
      if (m.server === "world") { s.id = m.id; s.name = m.name || null; }
      else if (m.server === "rivers") rivers.put(m.st && m.st.seed, m.st);
      else if (m.server === "detached") { s.detachedDone = true; say("world " + JSON.stringify(s.name) + " paused" + (m.saved ? " and saved" : " (the save failed)")); s.answer("detached", m); }
      else s.answer(m.server, m);
      return;
    }
    if (m.ready) { s.ready = true; for (const f of s.onReady.splice(0)) f(); }
    if (m.crash) { s.crashed = true; say("the simulation stopped: " + String(m.crash).split("\n")[0]); }
    if (s === srv.active) toPage(m);   // ready, failed, crash, errorLine: as from a Web Worker
  };
  srv.simStopped = (s, why) => {
    if (s.dead) return;
    s.dead = true;
    for (const k in s.waits) s.answer(k, null);
    if (srv.stopping) return;
    say("a simulation thread stopped: " + why);
    if (s === srv.active) toPage({ crash: "The world server's simulation thread stopped: " + why });
    if (s === srv.held) srv.held = null;
    if (s === srv.spare) srv.spare = null;
  };

  // ---- a page
  function connected(ws, req) {
    if (srv.client || srv.stopping) {
      ws.send(JSON.stringify({ refused: srv.stopping ? "the world server is stopping" : "another page is playing on this world server" }));
      ws.close(4001, "world in use");
      logIn(srv.active, "A second page tried to connect from " + (req.socket.remoteAddress || "?") + " and was refused (one page plays at a time)", "WARN");
      return;
    }
    srv.client = ws;
    srv.page = null; srv.feedAck = null; srv.iconsAsked = false; srv.tests = []; srv.budget = null;
    say("a page connected");
    const h = srv.held;
    ws.send(JSON.stringify({ hello: { server: "blockfield", version: o.version || null, threads: srv.workers, held: h ? { id: h.id, name: h.name } : null } }));   // threads: a world's simulation threads (region workers, r15-39)
    ws.on("message", (data, binary) => { try { binary ? fromPagePacket(packetIn(data)) : fromPageText(JSON.parse(data.toString("utf8"))); } catch (e) { say("a bad message from the page: " + e.message); } });
    ws.on("close", (code, reason) => {
      if (srv.client !== ws) return;
      if (code === 1006) { say("the page's connection was lost: " + (reason || "dropped")); logIn(srv.active, "The page's connection was lost without closing (" + (reason || "dropped") + ")", "WARN"); }
      closed();
    });
    ws.on("error", () => {});
  }
  function fromPageText(m) {
    if (m.boot) {
      if (!srv.active) srv.active = fresh();
      const s = srv.active;
      const go = () => { if (s !== srv.active) return; toPage({ ready: true }); s.played = true; for (const p of s.early.splice(0)) srv.client.send(packetOut(p)); };
      if (s.ready) go(); else s.onReady.push(go);
      warm();
      return;
    }
    if (m.saves) { saves(m.saves).then(r => toPage({ saves: Object.assign({ rid: m.saves.rid }, r) }), e => toPage({ saves: { rid: m.saves.rid, ok: false, why: String(e && e.message || e) } })); return; }
    if (m.feedPage) { srv.page = m.feedPage; return; }
    if (m.feedIcons) {
      for (const id in m.feedIcons) { srv.icons.set(id, m.feedIcons[id]); if (srv.wantIcons.has(id)) { srv.iconsDue.set(id, srv.wantIcons.get(id)); srv.wantIcons.delete(id); } }
      // one asked for that the page couldn't draw isn't asked for again; one wanted since the ask went out is asked for next (clearing all
      // of them lost those: the simulation sends an item's icon once, so the debug screen never had its name or picture)
      for (const id of srv.iconsAsked || []) srv.wantIcons.delete(id);
      srv.iconsAsked = false;
      return;
    }
    if ((m.test === "eval" || m.test === "crash") && !o.test) { say("a page asked for test " + JSON.stringify(String(m.test)).slice(0, 40) + "; refused (start with --test)"); return; }
    if (m.test === "lockstep" || m.test === "eval" || m.auto) srv.tests.push(m);   // (kept for the threads this page plays on next)
    if (m.budget) srv.budget = m;   // the page's simulation budget (bug-081): the latest, for the threads this page plays on next
    if (srv.active) srv.active.post(m);   // {test: "crash"} and the like
  }
  // a protocol packet for the simulation; a world message decides which thread plays
  function fromPagePacket(p) {
    let m = null;
    if (p.h.startsWith('{"t":"world"')) {
      m = JSON.parse(p.h);
      const a = m.args || {};
      const h = srv.held;
      if (m.op === "load" && h && h.id === a.id) {   // the held world, picked again: its thread plays, the title screen's goes
        if (srv.active && srv.active !== h) srv.active.kill();
        srv.active = h; srv.held = null;
        if (srv.budget) h.post(srv.budget);   // (the setting may have changed since its page closed)
      } else {
        if (h && m.op !== "demo") { srv.held = null; letGo(h); }   // another world: the held one was saved when its page closed
        // a world to play starts in a fresh thread, so nothing of the title screen's world (its clock, counters, timers) carries over
        if (m.op !== "demo" && srv.active && srv.active.id === null && srv.active.played) {
          srv.active.kill();
          srv.active = fresh(); srv.active.played = true;
          for (const t of srv.tests) srv.active.post(t);
          if (srv.budget) srv.active.post(srv.budget);
          warm();
        }
      }
    }
    if (m && srv.active) {
      // the planet's river network, when this server has solved it before
      const a = m.args || {}, meta = m.op === "load" ? worlds.meta(a.id) : null;
      const st = meta ? rivers.get(riverKey(meta.seed, meta.biomeScale)) : rivers.get(riverKey(a.seed, (a.opts || {}).biomeScale));
      if (st) srv.active.post({ server: "rivers", st });
    }
    // Save and Quit to Title (js/save.js quit): the thread plays on as the title background, holding no saved world any more, so an
    // export or rename of that world goes to its folder, and a page closing doesn't hold it (bug-074)
    if (srv.active && p.h.startsWith('{"t":"meta"')) {
      const q = JSON.parse(p.h);
      if (q.quit && q.id && srv.active.id === q.id) { say("world " + JSON.stringify(srv.active.name) + " quit to the title screen"); srv.active.id = null; srv.active.name = null; }
    }
    if (srv.active) srv.active.post(p, p.b ? [p.b] : []);
  }
  // a held world's thread goes once its save (from the page closing) is done
  function letGo(s) { if (s.detachedDone) s.kill(); else s.wait("detached", 30000).then(() => s.kill()); }
  function closed() {
    srv.client = null;
    const s = srv.active;
    srv.active = null;
    say("the page closed");
    if (s && !s.dead) {
      if (s.id && !s.crashed) {   // a saved world: pause it at once, save, hold it for the next page
        if (srv.held && srv.held !== s) letGo(srv.held);
        srv.held = s;
        s.detachedDone = false;
        s.post({ server: "detach" });
      } else s.kill();   // the title screen's world, or a crashed one
    }
    warm();
  }

  // ---- saved worlds (the page's title screen, js/save.js): the server's, on disk
  const live = id => [srv.active, srv.held].find(s => s && !s.dead && s.id === id && s.ready);
  const inUse = id => [srv.active, srv.held, srv.spare].some(s => s && !s.dead && s.id === id);   // (a thread writing its folder)
  async function saves(q) {
    if (q.op === "list") {
      const a = worlds.list();
      return { ok: true, list: a.sort((x, y) => (y.lastPlayed || 0) - (x.lastPlayed || 0)) };
    }
    if (q.op === "get") {
      const s = live(q.id);
      if (s) { const r = await s.ask("state", { id: q.id }); if (r && r.meta) return { ok: true, meta: r.meta, data: JSON.parse(json(r.data)) }; }
      const meta = worlds.meta(q.id), data = worlds.get(q.id, "data");
      if (!meta || !data) return { ok: false, why: "World not found" };
      const d = {};
      for (const k of ["version", "gen", "seed", "biomeScale", "villages", "monsters", "spawn", "rand", "time", "player", "inventory", "weather"]) d[k] = data[k];
      return { ok: true, meta, data: JSON.parse(json(d)) };
    }
    if (q.op === "remove") {
      if (srv.held && srv.held.id === q.id) { srv.held.kill(); srv.held = null; }
      const f = worlds.folder(q.id);
      worlds.remove(q.id);
      if (f != null) say("deleted world folder " + JSON.stringify(f));
      return { ok: true };
    }
    if (q.op === "rename" || q.op === "monsters") {
      const meta = worlds.meta(q.id);
      if (!meta) return { ok: false, why: "World not found" };
      if (q.op === "rename") meta.name = SaveFile.clampName(q.name, meta.name); else meta.monsters = q.monsters;
      worlds.put(q.id, "meta", meta);
      // its folder follows the name, unless a thread is writing to it (then at the server's next start: savedir.js tidy)
      if (q.op === "rename" && !inUse(q.id)) try { const to = worlds.rename(q.id, meta.name); say("world " + q.id + " is in folder " + JSON.stringify(to)); } catch (e) { say("could not rename the folder of " + q.id + ": " + e.message); }
      const s = live(q.id);   // the world being played or held takes it too (the page sends its meta message to the one it plays)
      if (s && s !== srv.active) s.post({ h: JSON.stringify(Object.assign({ t: "meta", id: q.id }, q.op === "rename" ? { name: meta.name } : { monsters: q.monsters })), b: null });
      return { ok: true, meta };
    }
    return { ok: false, why: "unknown saves op " + q.op };
  }

  // ---- export and import (.bfworld files, js/savefile.js): http on the game port
  async function exportWorld(id) {
    const s = live(id);
    if (s) { const r = await s.ask("save", null, 30000); if (!r || !r.ok) throw new Error("it could not be saved first" + (r && r.why ? ": " + r.why : "")); }
    const meta = worlds.meta(id), data = worlds.get(id, "data");
    if (!meta || !data) throw Object.assign(new Error("World not found"), { status: 404 });
    const head = worlds.get(id, "loghead");
    // (only batches with proper numbers: a world imported before bug-070 was fixed may name others, which are left out)
    const batches = head && Array.isArray(head.batches) ? head.batches.filter(b => Array.isArray(b) && SaveFile.isSeq(b[0])) : [];
    if (head && batches.length !== (head.batches || []).length) say("export of " + JSON.stringify(meta.name) + " left out " + ((head.batches || []).length - batches.length) + " damaged game log batches");
    const log = head ? { head: Object.assign({}, head, { batches }), lists: batches.map(([seq]) => worlds.get(id, "log:" + String(seq).padStart(9, "0")) || []) } : null;
    return { meta, buf: SaveFile.packSync({ game: o.version || null, meta, data, log }) };
  }
  function importWorld(rec, keep) {   // (rec: SaveFile.unpack checked the game log's batch numbers: bug-070)
    const meta = Object.assign({}, rec.meta);
    const old = m => !m || !(m.version >= SAVE_VERSION);
    if (old(meta) || old(rec.data)) throw new Error("Made with Blockfield " + (meta.version === 2 ? "1.4" : "1.3") + ", can't be opened in " + (o.version || "1.5"));
    const had = meta.id && worlds.meta(meta.id);
    if (had && keep) return { ok: true, skipped: true, meta: had };
    if (had || !meta.id) meta.id = "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    meta.lastPlayed = Date.now();
    meta.name = SaveFile.clampName(meta.name, "Imported world");   // (as Create and Rename keep names: bug-072)
    worlds.put(meta.id, "meta", meta);
    try {
      worlds.put(meta.id, "data", rec.data);
      if (rec.log && rec.log.head) {
        const head = Object.assign({}, rec.log.head, { name: meta.name });
        (head.batches || []).forEach(([seq], i) => worlds.put(meta.id, "log:" + String(seq).padStart(9, "0"), rec.log.lists[i] || []));
        worlds.put(meta.id, "loghead", head);
      }
    } catch (e) { worlds.remove(meta.id); throw e; }   // (half a world is no world)
    say("imported world " + JSON.stringify(meta.name) + " into folder " + JSON.stringify(worlds.folder(meta.id)));
    return { ok: true, skipped: false, meta };
  }
  function http(req, res, rel) {
    if (!rel.startsWith("/saves/")) return false;
    const reply = (code, obj) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(obj));
    const ex = /^\/saves\/([^/]+)\/export$/.exec(rel);
    if (ex && req.method === "GET") {
      exportWorld(ex[1]).then(({ meta, buf }) => {
        const name = SaveFile.fileName(meta.name);
        say("exported world " + JSON.stringify(meta.name) + " (" + Math.round(buf.length / 1024) + " KB)");
        res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": buf.length, "Cache-Control": "no-store",
          "Content-Disposition": "attachment; filename=\"" + name.replace(/[^\x20-\x7e]|"/g, "_") + "\"; filename*=UTF-8''" + encodeURIComponent(name) }).end(buf);
      }, e => reply(e.status || 500, { ok: false, why: e.message }));
      return true;
    }
    if (rel === "/saves/import" && req.method === "POST") {
      if (!req.headers["x-blockfield"]) { reply(403, { ok: false, why: "missing the X-Blockfield header" }); return true; }
      const parts = [];
      let n = 0, over = false;
      req.on("data", d => { n += d.length; if (n > IMPORT_MAX) { over = true; req.destroy(); } else parts.push(d); });
      req.on("end", () => {
        if (over) return;
        // (unpacked off the main thread, so the server keeps answering while a big file unpacks)
        SaveFile.unpack(Buffer.concat(parts)).then(rec => reply(200, importWorld(rec, /[?&]keep=1\b/.test(req.url))))
          .catch(e => { say("an import failed: " + e.message); reply(400, { ok: false, why: e.message }); });
      });
      req.on("close", () => { if (over) reply(413, { ok: false, why: "that file is over " + (IMPORT_MAX >> 20) + " MB" }); });
      return true;
    }
    reply(404, { ok: false, why: "no such saves request" });
    return true;
  }

  // ---- the debug screen, read from the simulation here
  let feedN = 0, feeding = false;
  const SIM_ACK = ["glogAt", "build", "pick", "pv", "resync"];
  async function feed() {
    const s = srv.active && srv.active.ready && !srv.active.crashed ? srv.active : srv.held && srv.held.ready ? srv.held : null;
    if (!debug || feeding || !s) return;
    feeding = true;
    try {
      const r = await s.ask("feed", { ack: srv.feedAck }, 5000);
      srv.feedAck = null;
      if (r && r.error) { debug.push({ t: Date.now(), n: ++feedN, error: "in the simulation: " + String(r.error).split("\n").slice(0, 3).join("\n") }); return; }   // (the screen shows it, as a page's)
      if (!r || !r.part) return;
      const part = r.part, pg = srv.page || {};
      // item icons: the simulation names them, the page draws them (asked for once; they go in a later snapshot)
      part.icons = part.icons || {};
      for (const id in part.icons) {
        const i = part.icons[id];
        if (i && !i.url) { const c = srv.icons.get(id); if (c) i.url = c.url; else { srv.wantIcons.set(id, i.name); delete part.icons[id]; } }
      }
      for (const [id, name] of srv.iconsDue) part.icons[id] = { url: srv.icons.get(id).url, name };
      srv.iconsDue.clear();
      const snap = Object.assign({ t: Date.now(), n: ++feedN, info: pg.info || { seed: null }, text: pg.text || "(no page open: the world is paused on the server)",
        paused: srv.client ? !!pg.paused : true, hidden: srv.client ? !!pg.hidden : true }, part,
        { pt: pg.pt || null, wc: pg.wc || 0, ff: pg.ff || null, screens: pg.screens | 0, alerts: pg.alerts || null, page: srv.client ? pg.page || null : null, server: { page: !!srv.client, held: !srv.client } });
      let a = debug.push(snap);
      if (a === "resync") a = { resync: true };
      if (a && typeof a === "object") {
        const simA = {}, pageA = {};
        for (const k in a) (SIM_ACK.includes(k) ? simA : pageA)[k] = a[k];
        if (a.resync) pageA.resync = true;
        if (a.screens != null) simA.screens = a.screens;   // (both: the meter runs in the simulation while a screen is open, js/perf.js)
        if (Object.keys(simA).length) srv.feedAck = simA;
        if (Object.keys(pageA).length) toPage({ feedAck: pageA });
      }
      if (srv.wantIcons.size && srv.client && !srv.iconsAsked) { srv.iconsAsked = [...srv.wantIcons.keys()]; toPage({ feedAck: { icons: srv.iconsAsked } }); }   // (the ids asked for: false when none is out)
    } finally { feeding = false; }
  }
  const feedTimer = setInterval(() => { feed().catch(e => say("debug feed: " + e.message)); }, FEED_MS);
  feedTimer.unref();

  for (const h of o.servers) WS.attach(h, "/sim", connected);
  warm();

  return {
    // every world here saved, then the threads stopped (Ctrl+C)
    stop() {
      srv.stopping = true;
      clearInterval(feedTimer);
      if (srv.client) srv.client.close(1001, "the world server is stopping");
      const all = sims();
      return Promise.all(all.map(s => s.id ? s.ask("shutdown", null, 15000) : null)).then(r => { for (const s of all) s.kill(); return r; });
    },
    http,
    worlds,   // (tests)
    status: () => ({ page: !!srv.client, active: srv.active && { id: srv.active.id, name: srv.active.name }, held: srv.held && { id: srv.held.id, name: srv.held.name } }),
  };
}

module.exports = { start, packetIn, packetOut };
