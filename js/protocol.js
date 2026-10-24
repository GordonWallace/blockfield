// Simulation/client protocol (spec r15-36, release 1.5). The messages between the simulation and what draws it, so the same protocol
// can carry the in-page game, the simulation in a Web Worker (r15-38), the Node world server (r15-41) and later multiplayer. The message
// list, fields and encodings are written up in docs/protocol.md.
//   sim -> client: hello, chunk, unload, blockChanges, edits, entities, events, village, clock, log, self (r15-44: inv, cursor, screen in every mode), result
//   client -> sim: request, view, query, speed, save, player, world, meta, clientLog
// Every message is a plain object {t: type, ...}. encode(msg) turns it into a packet {h, b}: h a JSON string, b an ArrayBuffer or null
// (bulk data: chunk sections, block changes, entity updates); decode(packet) turns it back. Packets are what crosses a thread or a
// socket (b can be transferred); their size is what bytes() counts.
// Interest: the sim side sends only what the client's view (position and view distance) covers: loaded chunks within the view distance,
// and the entities, effects and changes in them. Rate: everything is sent by flush(), once a drawn frame after the frame's ticks, and
// entities only when a tick ran since the last flush: every tick at 1x (a frame holds at most one), the latest state at fast-forward.
// In-page transport (BF.proto.local, on from the boot): the game is still one thread; the two ends are joined by a direct queue that
// encodes and decodes every message, and the client keeps a mirror of what it was sent (BF.client.world). Player requests (r15-20) go
// through it: BF.req.player sends a request message, the sim applies it at once (js/requests.js), and its block changes and result come
// straight back, so the client's own edit is in the mirror before the call returns.
// Worker transport (BF.proto.worker, r15-38): the simulation runs in js/simworker.js and the page is a client that keeps its own copy
// of the world (serve's replica option): every block edit goes to it, not only those in view, and all of them when it joins (edits),
// so the page generates and lights its chunks itself and only the edits cross. The page owns the player's body (position, look,
// health, hunger: player messages); the simulation sends back what it does to the player (self: hurts, inventory, food, teleports).
// Game log: INFO "protocol" when the in-page transport connects and once a game hour while the debug overlay or screen is on (bytes per
// second by type), ERROR for a message the other end can't take (bad packet, unknown type, a failed query or encoding).
// API: BF.proto = { VERSION, TYPES, encode(msg) -> packet, decode(packet) -> msg, bytes(packet), serve(send, opts?) -> sim end, connect(send) -> client end,
//        local: { connect(), disconnect(), on, sim, client }, worker: { connect(worker, via?) -> client, disconnect() }, host(send, opts) -> sim end (in the worker), hosted() -> it,
//        flush(), stats(), resetStats(), check() -> {ok, diffs, ...}, mirrorHash(), simHash(keys),
//        queries (what -> fn(args)), HOT, COLD }
//      BF.client = the client end once connected: { world: {chunks, entities, villages, clock, getBlock(x, y, z)}, mode, request(kind, target, data) -> req,
//        query(what, args, fn), view(x, y, z, dist), speed(s, pause), save(), receive(packet), hello, player(state), worldOp(op, args, fn), meta(m),
//        log(entries), self (the latest self fields), onEdits(chunks, full), onSelf(m), onLog(list), onEvents(list) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const VERSION = 1;
const TYPES = { out: ["hello", "chunk", "unload", "blockChanges", "edits", "entities", "events", "village", "clock", "log", "self", "result"],
  in: ["request", "view", "query", "speed", "save", "player", "world", "meta", "clientLog"] };
const SECN = 4096;
const glog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "protocol", text); };
const errOnce = new Set();
const errorOnce = (key, text) => { if (!errOnce.has(key)) { errOnce.add(key); glog("ERROR", text); } };

// ---------------------------------------------------------------- entity fields
// Per kind: HOT fields change most ticks and go in the binary part of an entities message, with a bitmask of which changed: positions
// (x, y, z) as float64 (float32 resolves only 0.25 of a block at planet coordinates, about 2.2 million), the rest as float32;
// COLD fields change rarely and go as JSON. A new entity is sent whole (every field, JSON).
const HOT = {
  mob: ["x", "y", "z", "yaw", "headYaw", "headPitch", "walkPhase", "walkAmt", "age", "deathT", "fuse", "swingT", "doorT"],
  drop: ["x", "y", "z", "age"],
  arrow: ["x", "y", "z", "lx", "ly", "lz"],
  boat: ["x", "y", "z", "yaw", "hurtT"],
  bee: ["x", "y", "z", "yaw"],
};
const COLD = {
  mob: ["type", "sid", "look", "scale", "headScale", "partVis", "tint", "held", "onFire", "sleeping", "bedF", "crackStage", "badgeLevel", "dead",
    "onGround", "riding", "rider", "child", "hw", "h", "k", "golem", "aiming", "trading", "doorAt", "name", "prof", "lead"],
  drop: ["item", "count", "phase", "pulled"],
  arrow: ["stuck"],
  boat: ["wood", "row", "rowing", "mob", "rider", "sid"],
  bee: ["phase", "mode", "land", "landYaw"],
};
const KINDS = Object.keys(HOT);
const POS = { x: 1, y: 1, z: 1 };   // hot fields sent as float64
const KIND_N = Object.fromEntries(KINDS.map((k, i) => [k, i]));

// ---------------------------------------------------------------- encoding
// Cells of chunks, [[key, [[index, id], ...]], ...]: Uint32 indices then Uint16 ids in b, keys and counts in h (blockChanges, edits).
function cellsCodec(t) {
  return {
    pack(m) {
      let n = 0;
      for (const [, cells] of m.chunks) n += cells.length;
      const buf = new ArrayBuffer(n * 4 + n * 2), I = new Uint32Array(buf, 0, n), D = new Uint16Array(buf, n * 4, n);
      let j = 0;
      const keys = [], counts = [];
      for (const [k, cells] of m.chunks) { keys.push(k); counts.push(cells.length); for (const c of cells) { I[j] = c[0]; D[j] = c[1]; j++; } }
      return [{ t, tick: m.tick, keys, counts }, buf];
    },
    unpack(h, buf) {
      const n = h.counts.reduce((a, b) => a + b, 0), I = new Uint32Array(buf, 0, n), D = new Uint16Array(buf, n * 4, n), chunks = [];
      let j = 0;
      h.keys.forEach((k, ci) => { const cells = []; for (let q = 0; q < h.counts[ci]; q++, j++) cells.push([I[j], D[j]]); chunks.push([k, cells]); });
      return { t, tick: h.tick, chunks };
    },
  };
}
// A packet is {h: JSON text, b: ArrayBuffer | null}. Types with bulk data pack it into b; the rest are JSON only.
const CODEC = {
  // chunk {key, cx, cz, lo, hi, secs: [number (the whole section is that id) | Uint16Array(4096)]}
  // b: Uint16 stream, per section: [0, id] uniform, [1, 4096 ids] raw, [2, runs lo, runs hi, (count - 1, id) * runs] run-length
  chunk: {
    pack(m) {
      const parts = [];
      let n = 0;
      for (const s of m.secs) {
        if (typeof s === "number") { parts.push([0, s]); n += 2; continue; }
        let runs = 1;
        for (let i = 1; i < SECN; i++) if (s[i] !== s[i - 1]) runs++;
        if (runs * 2 + 3 < SECN + 1) {
          const a = new Uint16Array(3 + runs * 2);
          a[0] = 2; a[1] = runs & 0xffff; a[2] = runs >>> 16;
          let j = 3, start = 0;
          for (let i = 1; i <= SECN; i++) if (i === SECN || s[i] !== s[start]) { a[j++] = i - start - 1; a[j++] = s[start]; start = i; }
          parts.push(a); n += a.length;
        } else { const a = new Uint16Array(1 + SECN); a[0] = 1; a.set(s, 1); parts.push(a); n += a.length; }
      }
      const b = new Uint16Array(n);
      let o = 0;
      for (const p of parts) { b.set(p, o); o += p.length; }
      return [{ t: "chunk", key: m.key, cx: m.cx, cz: m.cz, lo: m.lo, hi: m.hi, n: m.secs.length }, b.buffer];
    },
    unpack(h, buf) {
      const b = new Uint16Array(buf), secs = [];
      let o = 0;
      for (let k = 0; k < h.n; k++) {
        const tag = b[o];
        if (tag === 0) { secs.push(b[o + 1]); o += 2; }
        else if (tag === 1) { secs.push(b.slice(o + 1, o + 1 + SECN)); o += 1 + SECN; }
        else {
          const runs = b[o + 1] | (b[o + 2] << 16), s = new Uint16Array(SECN);
          let j = o + 3, i = 0;
          for (let r = 0; r < runs; r++) { const c = b[j++] + 1, id = b[j++]; s.fill(id, i, i + c); i += c; }
          secs.push(s); o = j;
        }
      }
      return { t: "chunk", key: h.key, cx: h.cx, cz: h.cz, lo: h.lo, hi: h.hi, secs };
    },
  },
  // blockChanges {tick, chunks: [[key, [[index, id], ...]], ...]}: index is the chunk's edit index (((y - MIN_Y) * 16 + lz) * 16 + lx, as
  // world.edits). b: Uint32 indices, then Uint16 ids, in chunk order; h: keys and counts.
  blockChanges: cellsCodec("blockChanges"),
  // edits {chunks}: every block edit the world holds (world.edits), the same encoding; the page's copy of the world (r15-38) starts from it
  edits: cellsCodec("edits"),
  // entities {tick, add: [{n, kind, s: {every field}}], set: [{n, s: {changed fields}}], gone: [n]}
  // b: per set entry with hot changes: Uint32 n, Uint32 mask (bit i = HOT[kind][i]), per set bit a Float64 (x, y, z) or Float32 (the rest),
  // little-endian; its cold changes go in h.cold.
  entities: {
    pack(m) {
      const hot = [], cold = [];
      let words = 0;
      for (const e of m.set) {
        const H = HOT[e.kind] || [];
        let mask = 0, nh = 0, c = null;
        for (const f in e.s) {
          const i = H.indexOf(f);
          if (i >= 0) { mask |= 1 << i; nh += POS[f] ? 2 : 1; } else (c || (c = {}))[f] = e.s[f];
        }
        if (mask) { hot.push([e, mask, H]); words += 2 + nh; }
        if (c) cold.push([e.n, KIND_N[e.kind], c]);
      }
      const buf = new ArrayBuffer(words * 4), V = new DataView(buf);
      let o = 0;
      for (const [e, mask, H] of hot) {
        V.setUint32(o, e.n, true); V.setUint32(o + 4, (mask | (KIND_N[e.kind] << 24)) >>> 0, true); o += 8;
        for (let i = 0; i < H.length; i++) if (mask & (1 << i)) {
          if (POS[H[i]]) { V.setFloat64(o, e.s[H[i]], true); o += 8; } else { V.setFloat32(o, e.s[H[i]], true); o += 4; }
        }
      }
      return [{ t: "entities", tick: m.tick, add: m.add, cold, gone: m.gone }, buf];
    },
    unpack(h, buf) {
      const V = new DataView(buf), set = new Map();
      let o = 0;
      while (o < buf.byteLength) {
        const n = V.getUint32(o, true), w = V.getUint32(o + 4, true), kind = KINDS[w >>> 24], mask = w & 0xffffff, H = HOT[kind], s = {};
        o += 8;
        for (let i = 0; i < H.length; i++) if (mask & (1 << i)) {
          if (POS[H[i]]) { s[H[i]] = V.getFloat64(o, true); o += 8; } else { s[H[i]] = V.getFloat32(o, true); o += 4; }
        }
        set.set(n, { n, kind, s });
      }
      for (const [n, k, c] of h.cold) {
        const e = set.get(n);
        if (e) Object.assign(e.s, c); else set.set(n, { n, kind: KINDS[k], s: Object.assign({}, c) });
      }
      return { t: "entities", tick: h.tick, add: h.add, set: [...set.values()], gone: h.gone };
    },
  },
};
function encode(msg) {
  const c = CODEC[msg.t];
  if (c) { const [h, b] = c.pack(msg); return { h: JSON.stringify(h), b }; }
  return { h: JSON.stringify(msg), b: null };
}
function decode(p) {
  const h = JSON.parse(p.h), c = CODEC[h.t];
  return c ? c.unpack(h, p.b) : h;
}
// UTF-8 length of the JSON part plus the binary part
function bytes(p) {
  let n = p.b ? p.b.byteLength : 0;
  const s = p.h;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3; }
  return n;
}

// ---------------------------------------------------------------- statistics: messages and bytes by type, each direction
const ST = { since: 0, sim: 0, flushes: 0, out: {}, in: {} };
const HR = { out: {}, in: {} };
let hourAt = null;
function count(dir, t, n) {
  for (const o of [ST[dir], HR[dir]]) { const r = o[t] || (o[t] = { msgs: 0, bytes: 0 }); r.msgs++; r.bytes += n; }
}
const simNow = () => (BF.simNow ? BF.simNow() : 0);
function stats() {
  const tot = d => Object.values(ST[d]).reduce((a, r) => a + r.bytes, 0);
  const copy = d => Object.fromEntries(Object.entries(ST[d]).map(([k, r]) => [k, Object.assign({}, r)]));
  return { out: copy("out"), in: copy("in"), bytesOut: tot("out"), bytesIn: tot("in"), realSeconds: (now() - ST.since) / 1000, gameSeconds: simNow() - ST.sim, flushes: ST.flushes };
}
function resetStats() { ST.out = {}; ST.in = {}; ST.flushes = 0; ST.since = now(); ST.sim = simNow(); }
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
ST.since = now();
function hourly() {
  const t = simNow();
  if (hourAt == null || t < hourAt) { hourAt = t; HR.real = now(); return; }
  if (t - hourAt < 50) return;   // a game hour (js/sky.js: a 1200 s day)
  const real = (now() - (HR.real || now())) / 1000;
  hourAt = t; HR.real = now();
  const live = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (live && real > 0) {
    const sum = d => Object.values(HR[d]).reduce((a, r) => a + r.bytes, 0);
    const top = Object.entries(HR.out).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 4).map(([k, r]) => k + " " + kb(r.bytes / real));
    glog("INFO", "Protocol in the last game hour: " + kb(sum("out") / real) + "/s to the client (" + top.join(", ") + "), " + kb(sum("in") / real) + "/s to the simulation");
  }
  HR.out = {}; HR.in = {};
}
const kb = n => (n >= 1024 ? (n / 1024).toFixed(1) + " KB" : Math.round(n) + " B");

// ---------------------------------------------------------------- the sim end
// serve(send, opts): send(packet) delivers to the client. Returns { receive(packet), flush(force), reset(), view, sent }.
// opts.replica (r15-38): the client keeps its own copy of the world and owns the player's body: every block edit is sent (not only those in
// chunks the client has), all of them (edits) at the first flush after each hello, its player messages move the player here, and what the
// simulation does to the player goes back in self messages. opts.world(op, args) -> Promise: the world message's handler (the host's).
const ckey = (cx, cz) => cx + "," + cz;
const sectionsOf = c => c.secs.map(s => (typeof s === "number" ? s : s.slice()));
let liveSim = null;   // the sim end the world's block hook reports to
function serve(send, opts) {
  opts = opts || {};
  const R = !!opts.replica;
  const ids = new WeakMap();   // entity object -> protocol number
  let nextN = 1;
  const S = {
    view: null,               // {x, y, z, dist}
    chunks: new Map(),        // key -> {c, lo, hi}: chunks the client has
    cells: new Map(),         // key -> Map(index -> id): changes since the last flush, for chunks the client has
    ents: new Map(),          // n -> {kind, o, s}: entities the client has, with the state it was sent
    villages: new Map(),      // key -> summary text sent
    fx: [], logs: [],
    tick: -1, clockKey: "", clockTick: -1e9, weather: null, villageT: 0, inRequest: false, flushes: 0,
    editsDue: false,          // replica: all edits go at the next flush (after a hello: a save's edits are restored after newWorld)
    hurts: [], rep: null, invSent: null, spawnSent: null, mountSent: "null",   // replica: hurts to send, the player as the client last reported it, what self last sent
    cursorSent: null, screenSent: null,   // (r15-44: the held stack and the open screen, in every mode)
  };
  const out = msg => {
    let p;
    try { p = encode(msg); } catch (e) { errorOnce("enc " + msg.t, "Could not encode a " + msg.t + " message: " + (e && e.message)); return; }
    count("out", msg.t, bytes(p));
    send(p);
  };
  const nOf = o => { let n = ids.get(o); if (!n) { n = nextN++; ids.set(o, n); } return n; };
  const tickNow = () => (BF.rand ? BF.rand.tick : 0);

  function hello() {
    const St = BF.state || {};
    out({ t: "hello", v: VERSION, version: BF.VERSION || null, seed: St.seed >>> 0, tick: tickNow(),
      settings: { gen: St.gen, villages: St.villages, biomeScale: St.biomeScale, gameMode: BF.player && BF.player.gameMode || null } });
    S.invSent = S.cursorSent = S.screenSent = null;   // (self sends the inventory and the screen again)
    if (R) { S.editsDue = true; S.spawnSent = null; S.hurts = []; S.mountSent = "null"; S.signsVer = -1; }
  }
  function reset() {
    S.chunks.clear(); S.cells.clear(); S.ents.clear(); S.villages.clear(); S.fx = []; S.logs = []; S.tick = -1; S.clockKey = ""; S.clockTick = -1e9; S.weather = null; S.villageT = 0;
    hello();
  }

  // ---- chunks: the loaded ones within the view distance (canonical chunks round the view's chunk, across face edges)
  function wanted() {
    const W = BF.world, want = new Map();
    if (!S.view || !W) return want;
    const R = S.view.dist, pcx = Math.floor(S.view.x / 16), pcz = Math.floor(S.view.z / 16);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
      const c = W.chunkC ? W.chunkC(pcx + dx, pcz + dz) : W.chunks.get(ckey(pcx + dx, pcz + dz));
      if (c && !want.has(c.key)) want.set(c.key, c);
    }
    return want;
  }
  function flushChunks(want, budget) {
    const gone = [];
    for (const [k, r] of S.chunks) {
      const c = want.get(k);
      if (!c) { S.chunks.delete(k); S.cells.delete(k); gone.push(k); }
      else if (c !== r.c || c.lo !== r.lo || c.hi !== r.hi) { S.chunks.delete(k); S.cells.delete(k); }   // reloaded or its band grew: sent again whole
    }
    if (gone.length) out({ t: "unload", keys: gone });
    for (const [k, c] of want) {
      if (S.chunks.has(k)) continue;
      if (budget-- <= 0) break;   // the rest on the next flushes
      out({ t: "chunk", key: k, cx: c.cx, cz: c.cz, lo: c.lo, hi: c.hi, secs: sectionsOf(c) });
      S.chunks.set(k, { c, lo: c.lo, hi: c.hi });
    }
  }
  function flushCells() {
    if (!S.cells.size) return;
    const chunks = [];
    for (const [k, m] of S.cells) if (R || S.chunks.has(k)) chunks.push([k, [...m]]);
    S.cells.clear();
    if (chunks.length) out({ t: "blockChanges", tick: tickNow(), chunks });
  }

  // ---- entities: what the render layers draw, in chunks the client has
  const inView = (x, z) => { const c = BF.world.chunkAt(x, z); return !!c && S.chunks.has(c.key); };
  const nOrNull = o => (o && typeof o === "object" ? nOf(o) : null);
  const pvText = pv => { let s = ""; if (pv) for (const k in pv) s += k + (pv[k] ? "1" : "0"); return s; };
  function stateOf(kind, o) {
    if (kind === "mob") {
      const p = o.position;
      return { x: p.x, y: p.y, z: p.z, yaw: o.yaw || 0, headYaw: o.headYaw || 0, headPitch: o.headPitch || 0, walkPhase: o.walkPhase || 0, walkAmt: o.walkAmt || 0,
        age: o.age || 0, deathT: o.deathT || 0, fuse: (o.ai && o.ai.fuse) || 0,
        type: o.type, sid: o.id != null ? o.id : null, look: o.look == null ? null : o.look, scale: o.scale == null ? 1 : o.scale, headScale: o.headScale == null ? 1 : o.headScale,
        partVis: pvText(o.partVis), tint: o.tint || null, held: o.held == null ? null : o.held, onFire: !!o.onFire, sleeping: !!o.sleeping,
        bedF: o.sleeping && o.bed ? o.bed.f : null, crackStage: o.crackStage || 0, badgeLevel: o.badgeLevel || 0, dead: !!o.dead, onGround: !!o.onGround,
        riding: nOrNull(o.riding), rider: nOrNull(o.rider), child: !!o.child,
        // r15-37: what the render layer, sounds and labels read besides
        swingT: o.ai && o.ai.swingT > 0 ? o.ai.swingT : 0, doorT: o.ai && o.ai.doorAt ? o.ai.doorT || 0 : 0,
        hw: o.halfWidth || 0, h: o.height || 0, k: o._k || 1, golem: !!(o.def && o.def.golem), aiming: !!(o.ai && o.ai.aiming), trading: !!o.tradingWith,
        doorAt: o.ai && o.ai.doorAt ? o.ai.doorAt.slice() : null,
        name: o.type === "villager" && BF.vlog ? BF.vlog.nameOf(o) : null, prof: o.type === "villager" ? (o.child ? "child" : o.profession || "villager") : null,
        lead: leadOf(o) };
    }
    if (kind === "drop") return { x: o.pos.x, y: o.pos.y, z: o.pos.z, age: o.age || 0, item: o.id, count: o.count, phase: o.phase || 0, pulled: !!o.pulled };
    if (kind === "arrow") { const l = o.stuck ? o.look || o.vel : o.vel || o.look; return { x: o.pos.x, y: o.pos.y, z: o.pos.z, lx: l ? l.x : 0, ly: l ? l.y : 0, lz: l ? l.z : 0, stuck: !!o.stuck }; }
    if (kind === "boat") return { x: o.pos.x, y: o.pos.y, z: o.pos.z, yaw: o.yaw || 0, hurtT: o.hurtT || 0, wood: o.wood, row: (o.row || [0, 0]).slice(), rowing: (o.rowing || [0, 0]).slice(), mob: nOrNull(o.mob), rider: !!o.rider, sid: BF.ids ? BF.ids.idOf(o) : null };   // (a boat has an id once something names it: the mirror's requests do)
    const L = o.land;   // bee: landed at a point on a surface, with the surface's normal
    return { x: o.x, y: o.y, z: o.z, yaw: o.yaw || 0, phase: o.phase || 0, mode: o.mode, land: L ? [L.x, L.y, L.z, L.nx || 0, L.ny || 0, L.nz || 0] : null, landYaw: o.landYaw || 0 };
  }
  // A horse's lead (js/horses.js leads()): "player", the protocol number of the mob holding it, or the fence post [x, y, z]; null for none.
  let leads = null;
  function leadOf(m) {
    if (!leads || m.type !== "horse") return null;
    const L = leads.get(m);
    if (!L) return null;
    return L.kind === "player" ? "player" : L.kind === "mob" ? nOrNull(L.mob) : [L.x, L.y, L.z];
  }
  function readLeads() {
    leads = null;
    if (!BF.horses || !BF.horses.leads) return;
    for (const L of BF.horses.leads()) (leads || (leads = new Map())).set(L.mob, L.lead);
  }
  const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));
  function each(fn) {
    if (BF.mobs) for (const m of BF.mobs.list) if (!m.removed) fn("mob", m, m.position.x, m.position.z);
    if (BF.drops) for (const d of BF.drops.list) fn("drop", d, d.pos.x, d.pos.z);
    if (BF.mobs && BF.mobs.arrowList) for (const a of BF.mobs.arrowList()) fn("arrow", a, a.pos.x, a.pos.z);
    if (BF.boats) for (const b of BF.boats.list) fn("boat", b, b.pos.x, b.pos.z);
    if (BF.bees && BF.bees.list) for (const b of BF.bees.list) fn("bee", b, b.x, b.z);
  }
  function flushEntities(ticked) {
    const add = [], set = [], seen = new Set();
    readLeads();
    each((kind, o, x, z) => {
      if (!inView(x, z)) return;
      const n = nOf(o), s = stateOf(kind, o), had = S.ents.get(n);
      seen.add(n);
      if (!had) { add.push({ n, kind, s }); S.ents.set(n, { kind, o, s }); return; }
      let d = null;
      for (const f in s) if (!same(s[f], had.s[f])) (d || (d = {}))[f] = s[f];
      if (d) { set.push({ n, kind, s: d }); had.s = s; }
    });
    const gone = [];
    for (const n of S.ents.keys()) if (!seen.has(n)) { gone.push(n); S.ents.delete(n); }
    // sent after every tick even when nothing changed, so the client knows which tick its entities are from (r15-37: an entity not in
    // a tick's message stood still in it, and is drawn where it is)
    if (ticked || add.length || set.length || gone.length) out({ t: "entities", tick: tickNow(), add, set, gone });
  }

  // ---- villages: the summaries the UI needs (names, centre, people), sent when they change
  function flushVillages() {
    const V = BF.mobs && BF.mobs.villages;
    if (!V) return;
    const list = [], seen = new Set();
    for (const [k, r] of V) {
      seen.add(k);
      const v = { key: k, name: (BF.signs && BF.signs.villageName && BF.signs.villageName(k)) || null, x: r.x, z: r.z, people: r.members ? r.members.length : 0 };
      const txt = JSON.stringify(v);
      if (S.villages.get(k) !== txt) { S.villages.set(k, txt); list.push(v); }
    }
    const gone = [...S.villages.keys()].filter(k => !seen.has(k));
    for (const k of gone) S.villages.delete(k);
    if (list.length || gone.length) out({ t: "village", list, gone });
  }

  // the clock once a game second (and on a speed change); the weather's state only when it changed
  function flushClock(t, force) {
    const W = BF.warp, sky = BF.sky || {}, speed = W ? W.speed : 1, frozen = !!(W && W.frozen);
    const key = speed + "|" + frozen;
    if (!force && key === S.clockKey && t - S.clockTick < 20) return;
    S.clockKey = key; S.clockTick = t;
    const m = { t: "clock", tick: t, day: sky.day || 0, time: sky.time || 0, speed, frozen, achieved: W ? W.last : 1 };
    const w = BF.weather && BF.weather.serialize ? JSON.stringify(BF.weather.serialize()) : "null";
    if (w !== S.weather) { S.weather = w; m.weather = JSON.parse(w); }
    out(m);
  }

  // flush(force): everything due since the last flush (js/main.js frame; tests). force sends entities even with no new tick.
  // replica: every edit the world holds, replacing the client's (the pending cells are in them)
  function flushEdits() {
    S.editsDue = false; S.cells.clear();
    const chunks = [];
    for (const [k, m] of BF.world.edits) if (m.size) chunks.push([k, [...m]]);
    out({ t: "edits", tick: tickNow(), chunks });
  }
  // The player's items and screens, in every mode (r15-44: js/invscreen.js draws from them): the 36 slots, the held stack and the open
  // screen, when they changed. Replica: also what the simulation did to the player since the last self (hurts; food, health and game mode
  // it changed; a teleport; the spawn point when it changed). The client reports its own changes in player messages, which set the baseline.
  function flushSelf() {
    const P = BF.player, I = BF.inventory;
    const m = { t: "self", tick: tickNow() }, r = S.rep;
    let any = false;
    if (I && I.own) {
      const inv = JSON.stringify(I.own());
      if (inv !== S.invSent) { S.invSent = inv; m.inv = JSON.parse(inv); any = true; }
      const cur = JSON.stringify(I.cursorView ? I.cursorView() : null);
      if (cur !== S.cursorSent) { S.cursorSent = cur; m.cursor = JSON.parse(cur); any = true; }
      const sc = JSON.stringify(I.screenView ? I.screenView() : null);
      if (sc !== S.screenSent) { S.screenSent = sc; m.screen = JSON.parse(sc); any = true; }
    }
    if (!R || !P) { if (any) out(m); return; }
    if (S.hurts.length) { m.hurt = S.hurts; S.hurts = []; any = true; }
    if (r) {
      if (P.health !== r.health) { m.health = r.health = P.health; any = true; }
      if (P.hunger !== r.hunger) { m.hunger = r.hunger = P.hunger; any = true; }
      if (P.saturation !== r.saturation) { m.saturation = r.saturation = P.saturation; any = true; }
      if (P.gameMode !== r.gameMode) { m.gameMode = r.gameMode = P.gameMode; any = true; }
      const p = P.position;
      if (P.vehicle) { r.x = p.x; r.y = p.y; r.z = p.z; }   // riding: the page seats the player itself (js/player.js rideSelf)
      else if (Math.abs(p.x - r.x) > 1e-6 || Math.abs(p.y - r.y) > 1e-6 || Math.abs(p.z - r.z) > 1e-6) { m.pos = [p.x, p.y, p.z]; r.x = p.x; r.y = p.y; r.z = p.z; any = true; }
    }
    // riding (r15-44 part 2): the boat or horse the player is on, when that changed (getting on or off here, its health); the pose goes along
    const ride = P.rideState ? P.rideState() : null, rk = JSON.stringify(ride);
    if (rk !== S.mountSent) { S.mountSent = rk; m.mount = ride && Object.assign(ride, { pose: P.ridePose() }); any = true; }
    const sp = JSON.stringify(BF.spawnPoint || null);
    if (sp !== S.spawnSent) { S.spawnSent = sp; m.spawn = JSON.parse(sp); any = true; }
    if (any) out(m);
  }
  // replica: the client's player (a player message): its body moves here, and becomes the baseline flushSelf compares against
  function playerIn(m) {
    const P = BF.player;
    if (!P || !P.position) return;
    P.position.set(m.x, m.y, m.z);
    if (P.setLook) P.setLook(m.yaw || 0, m.pitch || 0);
    if (m.gameMode && m.gameMode !== P.gameMode && P.setGameMode) P.setGameMode(m.gameMode);
    if (m.health != null) P.health = m.health;
    if (m.hunger != null) P.hunger = m.hunger;
    P.dead = !!m.dead;
    if (m.sel != null && BF.inventory && BF.inventory.selectedIndex !== m.sel) BF.inventory.select(m.sel);   // the hotbar slot (r15-44: the page's)
    if (m.ride && P.rideIn) P.rideIn(m.ride);   // the boat or horse the page steers (r15-44 part 2)
    if (m.saturation != null) P.saturation = m.saturation;   // (r15-43: the page drains it; eating here raises it, flushSelf)
    S.rep = { x: m.x, y: m.y, z: m.z, health: P.health, hunger: P.hunger, saturation: P.saturation, gameMode: P.gameMode };
  }
  // replica: the player's body is the client's, so what would change it here goes to the client instead (mobs, bees and lightning
  // hurting the player, js/mobs.js, js/bees.js, js/weather.js)
  if (R && BF.player) {
    BF.player.damage = (amount, from, cause) => { if (amount > 0) S.hurts.push({ a: amount, from: from ? [from.x, from.y, from.z] : null, cause: cause || null }); };
    BF.player.kill = () => S.hurts.push({ kill: true });
  }

  function flush(force) {
    if (!BF.world) return;
    S.flushes++; ST.flushes++;
    if (S.editsDue) flushEdits();
    const want = wanted();
    flushChunks(want, S.view && S.view.budget != null ? S.view.budget : 16);
    flushCells();
    const t = tickNow(), ticked = t !== S.tick;
    // entities: after a tick; after a request applied (changed); and every flush while the world is frozen or paused, when nothing ticks
    // but a request, a command or a test can still move things (no ticks then, so the diff is the only cost)
    const still = !!((BF.warp && BF.warp.frozen) || (BF.state && BF.state.paused));
    if (ticked || force || S.changed || still) flushEntities(ticked);
    S.changed = false;
    // replica (r15-43): the sign text store whenever it changed (a few entries; the page draws sign texts from it)
    if (R && BF.signs && BF.signs.ver !== S.signsVer) { S.signsVer = BF.signs.ver; S.fx.push({ kind: "signs", store: BF.signs.serialize() }); }
    if (S.fx.length) {
      const list = S.fx.filter(e => e.x == null || inView(e.x, e.z));
      S.fx = [];
      if (list.length) out({ t: "events", tick: t, list });
    }
    flushClock(t, force);
    if ((ticked || force) && --S.villageT <= 0) { S.villageT = 20; flushVillages(); }
    S.tick = t;
    if (S.logs.length) { out({ t: "log", list: S.logs }); S.logs = []; }
    flushSelf();
    hourly();
  }

  // ---- client -> sim
  function receive(p) {
    let m;
    try { m = decode(p); } catch (e) { errorOnce("bad", "The simulation got a packet it could not read: " + (e && e.message)); return; }
    count("in", m.t, bytes(p));
    const fn = IN[m.t];
    if (!fn) { errorOnce("type " + m.t, "The simulation got a message of unknown type \"" + m.t + "\""); return; }
    fn(m);
  }
  const IN = {
    // a player request (r15-20): applied at once at this tick boundary; its block changes go first, then its result
    request(m) {
      S.inRequest = true;
      let r;
      try { r = BF.req.applyPlayer(m.kind, m.target, m.data).result; } finally { S.inRequest = false; S.changed = true; }
      flushCells();
      flushSelf();   // (replica: what the request did to the player arrives with its result)
      out({ t: "result", rid: m.rid, tick: tickNow(), result: r });
    },
    view(m) {
      const first = !S.view;
      S.view = { x: m.x, y: m.y, z: m.z, dist: m.dist | 0, budget: m.budget };
      if (opts.onView) opts.onView(S.view);   // (the worker loads chunks to the page's view distance, as the page did)
      if (first) flush(true);
    },
    query(m) {
      const q = QUERIES[m.what];
      let r;
      if (!q) r = { ok: false, why: "unknown query" };
      else try { r = q(m.args || {}); } catch (e) { r = { ok: false, why: "error", error: String(e && e.message || e) }; errorOnce("query " + m.what, "Query " + m.what + " failed: " + (e && e.message)); }
      if (r && typeof r.then === "function") { r.then(v => out({ t: "result", qid: m.qid, result: v }), e => out({ t: "result", qid: m.qid, result: { ok: false, why: "error", error: String(e && e.stack || e) } })); return; }   // (eval)
      out({ t: "result", qid: m.qid, result: r });
    },
    // speed 0 freezes (0x); pause (the page's menus, r15-38) stops the ticks without changing the speed
    speed(m) {
      if ("pause" in m && BF.state) BF.state.paused = !!m.pause;
      const W = BF.warp;
      if (!W || m.speed == null) return;
      if (!m.speed) W.freeze();
      else if (m.speed !== W.speed) { const i = W.SPEEDS.indexOf(m.speed); if (i >= 0) W.set(i); }
    },
    save(m) {
      const done = ok => out({ t: "result", sid: m.sid, result: ok ? { ok: true } : { ok: false, why: BF.save && BF.save.lastError || null } });
      if (!BF.save || !BF.save.saveNow) { done(false); return; }
      BF.save.saveNow().then(done, () => done(false));
    },
    player: playerIn,
    // start a world (the host's handler: create, load or the title screen's world), answered with a result when it's ready
    world(m) {
      const done = r => out({ t: "result", wid: m.wid, result: r });
      if (!opts.world) { done({ ok: false, why: "no worlds here" }); return; }
      let p;
      try { p = Promise.resolve(opts.world(m.op, m.args || {})); } catch (e) { p = Promise.reject(e); }
      p.then(r => done(Object.assign({ ok: true }, r || {})), e => { glog("ERROR", "Could not " + m.op + " the world: " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n")); done({ ok: false, why: String(e && e.message || e) }); });
    },
    // the open world's name or monster options changed on the title screen (js/save.js rename, setMonsters) or its monster options in
    // the pause menu (js/player.js; id null for a world that isn't saved)
    meta(m) {
      const cur = BF.save && BF.save.current;
      if (m.id ? !cur || m.id !== cur.id : cur) return;
      if (m.name != null && cur) cur.name = m.name;
      if (m.monsters) { if (cur) cur.monsters = m.monsters; if (BF.gameOpts) for (const t in m.monsters) BF.gameOpts.set(t, m.monsters[t]); }
    },
    // the client's own log entries (its errors): into this game log, which is the one saved
    clientLog(m) { if (BF.glog) for (const e of m.list || []) BF.glog.log(e.l, e.k, e.x, { at: e.p }); },
  };

  // ---- taps: block edits (js/world.js), effects (js/fx.js), the game log (js/gamelog.js)
  function onBlock(c, i, id) {
    if (!R && !S.chunks.has(c.key)) return;
    let m = S.cells.get(c.key);
    if (!m) S.cells.set(c.key, (m = new Map()));
    m.set(i, id);   // a cell changed several times since the last flush goes once, with its last id
  }
  // what the client should have now: the live state of every entity in view (n -> {kind, s}), and the loaded chunks in view
  function interest() {
    const m = new Map();
    readLeads();
    each((kind, o, x, z) => { if (inView(x, z)) m.set(nOf(o), { kind, s: stateOf(kind, o) }); });
    return { entities: m, chunks: wanted() };
  }
  const sim = { receive, flush, reset, hello, onBlock, onFx: e => S.fx.push(e), onLog: e => S.logs.push(e), S, interest, nOf, replica: R };
  liveSim = sim;
  return sim;
}

// ---------------------------------------------------------------- queries (the UI asks; r15-37 adds the rest)
const QUERIES = {
  // the villager hover card (js/villagerhover.js): name, profession, what it is doing
  villager(a) {
    const m = BF.ids && BF.ids.get(a.id);
    if (!m || m.removed) return { ok: false, why: "gone" };
    return { ok: true, name: BF.vlog ? BF.vlog.nameOf(m) : "Villager", profession: m.child ? "child" : m.profession || "villager",
      status: BF.villagerStatus ? BF.villagerStatus.text(m) : "" };
  },
  // a village record's summary and its log's newest lines
  village(a) {
    const r = BF.mobs && BF.mobs.villages && BF.mobs.villages.get(a.key);
    if (!r) return { ok: false, why: "gone" };
    return { ok: true, key: a.key, name: (BF.signs && BF.signs.villageName && BF.signs.villageName(a.key)) || null, people: r.members ? r.members.length || 0 : 0, log: (r.log || []).slice(-(a.n || 20)) };
  },
  // the world state hash and its parts (js/statehash.js)
  hash() { return BF.stateHash ? Object.assign({ ok: true, tick: BF.rand ? BF.rand.tick : null }, BF.stateHash.full()) : { ok: false, why: "no state hash" }; },   // (tick: r15-41's test compares with a headless run of as many ticks)
  // the protocol's own figures
  stats() { return Object.assign({ ok: true }, stats()); },
  // a hash of the blocks of chunks {keys} and which of them aren't loaded (a client keeping its own copy checks it against this, r15-38)
  chunkHash(a) { const keys = (a.keys || []).filter(k => BF.world.chunks.has(k)); return { ok: true, keys, hash: simHash(keys) }; },

  // ---- r15-37: what the page's screens and overlays ask for
  // a chest's slots, owner and whether the player may change it ({x, y, z}; js/playerinv.js chestView)
  chest(a) { return BF.inventory && BF.inventory.chestView ? BF.inventory.chestView(a) : { ok: false, why: "no chests" }; },
  // a villager's offers (with why one can't be done now), inventory, level, xp, name and status ({id}; js/playerinv.js tradeView)
  trades(a) { return BF.inventory && BF.inventory.tradeView ? BF.inventory.tradeView(a) : { ok: false, why: "no trading" }; },
  // r15-44: a furnace's slots, burn, burnMax, cook and whether it can smelt now ({x, y, z}, or {} for the open screen's; js/playerinv.js furnaceView)
  furnace(a) { return BF.inventory && BF.inventory.furnaceView ? BF.inventory.furnaceView(a) : { ok: false, why: "no furnaces" }; },
  // a boat or mob by id as the simulation has it (tests, r15-44 part 2): where it is, whether the player rides it, a horse's state
  // (tests only, spec r15-43: BFT.sim) runs a function's source here with a.arg and answers {ok, value}; off unless the page turned it on
  // (BF.testEval: a page with BF_TEST in a Web Worker, js/simworker.js; on the world server only when started with --test)
  eval(a) {
    if (!BF.testEval) return { ok: false, why: "eval is off (tests only)" };
    return Promise.resolve().then(() => (0, eval)("(" + a.src + ")")(a.arg)).then(v => ({ ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }), e => ({ ok: false, error: String(e && e.stack || e) }));
  },
  // r15-43: the debug screen's alerts, from the page (js/alerts.js) to the simulation's half (js/alertsim.js)
  alerts(a) { if (!BF.alertSim) return { ok: false, why: "no alerts here" }; BF.alertSim.set(a.list, a.av); return { ok: true }; },
  entity(a) {
    const o = a.id != null && BF.ids ? BF.ids.get(a.id) : null;
    if (!o || o.dead || o.removed || (o.kind === "boat" && !(BF.boats && BF.boats.list.includes(o)))) return { ok: false, why: "gone" };
    const p = o.pos || o.position, r = o.horse;
    return { ok: true, kind: o.kind === "boat" ? "boat" : o.type, x: p.x, y: p.y, z: p.z, yaw: o.yaw || 0, ridden: !!(BF.player && BF.player.vehicle === o), hp: o.hp,
      horse: r ? { tamed: !!r.tamed, saddle: !!r.saddle, lead: r.lead ? r.lead.kind : null, temper: r.temper } : null };
  },
  // a mob's inventory ({id}): the slots of a villager or merchant
  inventory(a) {
    const m = BF.ids && BF.ids.get(a.id);
    if (!m || m.removed || !Array.isArray(m.inv)) return { ok: false, why: "gone" };
    return { ok: true, slots: m.inv.map(s => (s ? (s.wear > 0 ? { id: s.id, count: s.count, wear: s.wear } : { id: s.id, count: s.count }) : null)) };
  },
  // a map item's pixels ({item, ver}; js/maps.js): the map's bounds always, its pixels (RGB565, base64) only when ver is not the client's
  map(a) {
    const it = BF.items && BF.items[a.item], M = BF.maps;
    if (!it || !it.map || !M) return { ok: false, why: "not a map" };
    const d = M.dataOfItem(it), b = M.bounds(d.size, d.zx, d.zz), r = { ok: true, item: a.item, ver: d.ver, side: M.side(d.size), x0: b.x0, z0: b.z0, N: M.PX, scale: M.scale(d.size) };
    if (a.ver !== d.ver) r.px = b64(new Uint8Array(d.px.buffer, d.px.byteOffset, d.px.byteLength));
    return r;
  },
  // the F3 overlay's simulation figures (js/main.js debugInfo adds the page's own: fps, position, draw calls)
  f3(a) {
    const p = a && a.x != null ? a : BF.player && BF.player.position;
    return { ok: true, mobs: BF.mobs ? BF.mobs.list.length : 0, boats: BF.boats ? BF.boats.list.length : 0, sim: BF.villageSim ? BF.villageSim.status() : "",
      clock: BF.vlog && BF.sky ? BF.vlog.stamp(BF.sky.day + BF.sky.time) : "", weather: BF.weather && BF.weather.debugText ? BF.weather.debugText() : "",
      perf: BF.perf ? BF.perf.stats() : null, perfText: BF.perf && BF.perf.stats() ? BF.perf.text(BF.perf.stats()) : "",
      requests: BF.req ? BF.req.stats() : null, requestsText: BF.req && BF.req.stats() ? BF.req.text(BF.req.stats()) : "",
      blockLight: p && BF.world ? BF.world.getBlockLight(p.x, p.y + 0.05, p.z) : 0 };
  },
  // the F3 village panel ({x, z}): the village there, its tally, occupations, free job blocks and newest log lines (js/villagelog.js)
  vpanel(a) {
    const V = BF.vlog, rec = V && V.villageAt(a.x, a.z);
    if (!rec) return { ok: true, none: true };
    const all = V.entries(rec.key);   // log lines as [time text, kind, text, [x, y, z]?]
    return Object.assign({ ok: true, log: all.slice(-(a.n || 26)).map(e => [V.stamp(e[0]), e[1], e[2], e[3]]), total: all.length }, V.panelData(rec));
  },
};
function b64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

// r15-37: fn(list) for every events message any client end gets (effects for js/entityview.js, sounds for js/audio.js); BF.proto.listen.
const LISTEN = [];
// r15-44: fn(m) for every self message any client end gets (js/invscreen.js: the inventory, cursor and screen); BF.proto.onSelf.
const SELF = [];

// ---------------------------------------------------------------- the client end and its mirror
// connect(send): send(packet) delivers to the sim. The mirror (world) holds what the sim sent: chunks (key -> {cx, cz, key, lo, hi, secs}),
// entities (n -> {n, kind, ...fields, prev: the hot fields before the latest update}), villages (key -> summary), clock, and the log lines.
function connect(send, mode) {
  let rid = 1, qid = 1, sidN = 1, widN = 1;
  const pending = new Map(), queries = new Map(), saves = new Map(), worlds = new Map();
  const world = { chunks: new Map(), entities: new Map(), villages: new Map(), clock: null, log: [], tick: -1,
    getBlock(x, y, z) {
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      const c = world.chunks.get(ckey(Math.floor(x / 16), Math.floor(z / 16)));
      if (!c) return null;
      const sy = y >> 4;
      if (sy < c.lo) return BF.B ? BF.B.stone : 1;
      if (sy >= c.hi) return 0;
      const s = c.secs[sy - c.lo];
      return typeof s === "number" ? s : s[((y & 15) << 8) | ((z - c.cz * 16) << 4) | (x - c.cx * 16)];
    } };
  // r15-37: how far to draw entity r from prev towards its current fields, given the warp's alpha: alpha when r changed in the latest tick
  // and prev is the tick just before; else 1 (it stood still, or several ticks went by since the last message: fast-forward).
  world.k = (r, a) => (r.prev && r.ct === world.tick && r.ct - r.pt === 1 && typeof a === "number" ? Math.max(0, Math.min(1, a)) : 1);
  world.gen = 0;   // counts hello messages: a new world (the render layers drop what they were showing)
  const C = { world, mode: mode || "in page", hello: null, lastView: null };
  const out = msg => send(encode(msg));
  function clear() { world.chunks.clear(); world.entities.clear(); world.villages.clear(); world.clock = null; world.log = []; world.tick = -1; }
  const LOG_KEEP = 500;
  const ON = {
    hello(m) { C.hello = m; clear(); C.lastView = null; world.gen++; },
    chunk(m) { world.chunks.set(m.key, { cx: m.cx, cz: m.cz, key: m.key, lo: m.lo, hi: m.hi, secs: m.secs }); },
    unload(m) { for (const k of m.keys) world.chunks.delete(k); },
    blockChanges(m) {
      if (C.onEdits) C.onEdits(m.chunks, false);   // (the page's copy of the world, r15-38)
      for (const [k, cells] of m.chunks) {
        const c = world.chunks.get(k);
        if (!c) continue;
        for (const [i, id] of cells) {
          const y = (i >> 8) + BF.MIN_Y, si = (y >> 4) - c.lo, li = ((y & 15) << 8) | (i & 255);
          if (si < 0 || si >= c.secs.length) continue;
          let s = c.secs[si];
          if (typeof s === "number") { if (s === id) continue; const a = new Uint16Array(SECN); a.fill(s); c.secs[si] = s = a; }
          s[li] = id;
        }
      }
    },
    // An entity's current fields are from tick ct; prev holds its hot fields as of tick pt, the tick before (r15-37). An entity missing
    // from a tick's message stood still in it, so when the ticks come one by one its prev is its state at the tick before the change.
    // A change within the same tick (a request while frozen) only overwrites the current fields.
    entities(m) {
      const T = m.tick, step = T === world.tick + 1;
      for (const e of m.add) world.entities.set(e.n, Object.assign({ n: e.n, kind: e.kind, prev: null, pt: null, ct: T }, e.s));
      for (const e of m.set) {
        const r = world.entities.get(e.n);
        if (!r) continue;
        if (r.ct !== T) {
          const prev = r.prev || (r.prev = {});
          for (const f of HOT[r.kind]) prev[f] = r[f];
          r.pt = step ? T - 1 : r.ct; r.ct = T;
        }
        Object.assign(r, e.s);
      }
      for (const n of m.gone) world.entities.delete(n);
      world.tick = T;
    },
    events(m) {
      if (C.onEvents) C.onEvents(m.list);
      for (const fn of LISTEN) { try { fn(m.list); } catch (e) { errorOnce("cev", "An event listener failed: " + (e && e.message)); console.error(e); } }
    },
    edits(m) { if (C.onEdits) C.onEdits(m.chunks, true); },
    self(m) {
      const o = Object.assign({}, m); delete o.t; delete o.hurt; C.self = Object.assign(C.self || {}, o);
      if (C.onSelf) C.onSelf(m);
      for (const fn of SELF) { try { fn(m); } catch (e) { errorOnce("cself", "A self listener failed: " + (e && e.message)); console.error(e); } }
    },
    village(m) { for (const v of m.list) world.villages.set(v.key, v); for (const k of m.gone) world.villages.delete(k); },
    clock(m) { world.clock = m; },
    log(m) { for (const e of m.list) world.log.push(e); if (world.log.length > LOG_KEEP) world.log.splice(0, world.log.length - LOG_KEEP); if (C.onLog) C.onLog(m.list); },
    result(m) {
      const tab = m.rid != null ? pending : m.qid != null ? queries : m.wid != null ? worlds : saves, id = m.rid != null ? m.rid : m.qid != null ? m.qid : m.wid != null ? m.wid : m.sid, h = tab.get(id);
      tab.delete(id);
      if (h) h(m.result, m);
    },
  };
  C.receive = p => {
    let m;
    try { m = decode(p); } catch (e) { errorOnce("cbad", "The client got a packet it could not read: " + (e && e.message)); return; }
    const fn = ON[m.t];
    if (!fn) { errorOnce("ctype " + m.t, "The client got a message of unknown type \"" + m.t + "\""); return; }
    fn(m);
  };
  // A player request (r15-20). Returns {kind, target, data, tick, result, then(fn)}; result is set when the sim's result comes back
  // (in the page: before this returns).
  C.request = (kind, target, data) => {
    const req = { kind, target, data: data || {}, tick: BF.rand ? BF.rand.tick : 0, result: undefined, delivered: false, cbs: null };
    req.then = fn => { if (req.delivered) fn(req.result, req); else (req.cbs || (req.cbs = [])).push(fn); return req; };
    const id = rid++;
    pending.set(id, r => { req.result = r; req.delivered = true; if (req.cbs) for (const fn of req.cbs) { try { fn(r, req); } catch (e) { console.error(e); } } });
    out({ t: "request", rid: id, tick: req.tick, kind, target: target == null ? null : target, data: req.data });
    return req;
  };
  C.query = (what, args, fn) => { const id = qid++; if (fn) queries.set(id, fn); out({ t: "query", qid: id, what, args: args || {} }); return id; };
  C.view = (x, y, z, dist, budget) => { C.lastView = { x, y, z, dist }; out({ t: "view", x, y, z, dist, budget }); };
  C.speed = (s, pause) => out(pause == null ? { t: "speed", speed: s } : { t: "speed", speed: s, pause: !!pause });
  C.save = fn => { const id = sidN++; if (fn) saves.set(id, fn); out({ t: "save", sid: id }); };
  // r15-38: the player's body (replica), a world to start (op create / load / demo), the open world's name or options, the client's log lines
  C.player = st => out(Object.assign({ t: "player" }, st));
  C.worldOp = (op, args, fn) => { const id = widN++; if (fn) worlds.set(id, fn); out({ t: "world", wid: id, op, args: args || {} }); return id; };
  C.meta = m => out(Object.assign({ t: "meta" }, m));
  C.log = list => out({ t: "clientLog", list });
  // once a frame: tell the sim when the view moved to another chunk or the view distance changed
  C.frame = () => {
    const P = BF.player, W = BF.world;
    if (!P || !P.position || !W) return;
    const p = P.position, v = C.lastView, d = W.viewDist;
    if (!v || v.dist !== d || Math.floor(v.x / 16) !== Math.floor(p.x / 16) || Math.floor(v.z / 16) !== Math.floor(p.z / 16) || Math.abs(v.y - p.y) > 16)
      C.view(p.x, p.y, p.z, d);
  };
  return C;
}

// ---------------------------------------------------------------- the in-page transport
// Both ends in this page, joined by a direct queue: each packet is delivered at once (synchronously), encoded and decoded on the way.
const local = {
  on: false, sim: null, client: null,
  connect() {
    if (local.on) return local.client;
    let client = null;
    const sim = serve(p => client.receive(p));
    client = connect(p => sim.receive(p), "in page");
    local.sim = sim; local.client = client; local.on = true;
    hookUp();
    BF.client = client;
    if (BF.req) BF.req.via = (kind, target, data) => (sim.S.inRequest ? null : client.request(kind, target, data));
    sim.hello();
    glog("INFO", "Simulation and client connected in the page (protocol version " + VERSION + ")");
    return client;
  },
  disconnect() {
    if (!local.on) return;
    if (BF.req) BF.req.via = null;
    local.on = false; local.sim = null; local.client = null; liveSim = null; BF.client = null;
  },
};

// ---------------------------------------------------------------- the worker transport (r15-38)
// The page's end: the simulation runs in a Web Worker (js/simworker.js, started by js/simhost.js); packets cross by postMessage with their
// binary part transferred. Requests are answered later, when the worker's result arrives (req.then).
const worker = {
  on: false, w: null, client: null,
  connect(w, via) {   // via "server": w is the Node world server's socket (r15-41, js/simhost.js); the client's mode is "worker" all the same
    if (local.on) local.disconnect();
    const client = connect(p => { try { w.postMessage(p, p.b ? [p.b] : []); } catch (e) { errorOnce("post", "Could not send to the simulation " + (via || "worker") + ": " + (e && e.message)); } }, "worker");
    worker.w = w; worker.client = client; worker.on = true;
    BF.client = client;
    if (BF.req) BF.req.via = (kind, target, data) => client.request(kind, target, data);
    glog("INFO", "Simulation and client connected through " + (via === "server" ? "the world server's socket" : "a Web Worker") + " (protocol version " + VERSION + ")");
    return client;
  },
  receive(p) { if (worker.client) worker.client.receive(p); },
  disconnect() {
    if (!worker.on) return;
    if (BF.req) BF.req.via = null;
    worker.on = false; worker.w = null; worker.client = null; BF.client = null;
  },
};
// The worker's end: the simulation end serving one client through send, hooked to the world, effects and log like the in-page one.
let here = null;
function host(send, opts) {
  hookUp();
  here = serve(send, opts);
  liveSim = here;
  here.hello();
  return here;
}
const hosted = () => here;   // (the world server, r15-41: a new page on the same world starts its client over, reset())

// ---------------------------------------------------------------- the check: the mirror against the sim
// Right after a flush the mirror must equal the sim. Chunks: every mirrored chunk is loaded in view, with the sim's band and blocks
// (pending counts those in view not sent yet). Entities: the live set in view, cold fields equal, positions exact (float64), other hot fields within 1/256 (float32).
// Returns {ok, chunks, pending, entities, mirrorHash, simHash, diffs, ndiffs}.
function chunkText(c) {
  const o = [c.key, c.lo, c.hi];
  for (const s of c.secs) o.push(typeof s === "number" ? "u" + s : uniform(s) != null ? "u" + uniform(s) : BF.stateHash ? BF.stateHash.hashStr(String.fromCharCode.apply(null, s.subarray(0, 2048)) + String.fromCharCode.apply(null, s.subarray(2048))) : s.join(","));
  return o.join(";");
}
function uniform(s) { const v = s[0]; for (let i = 1; i < SECN; i++) if (s[i] !== v) return null; return v; }
const hashOf = s => (BF.stateHash ? BF.stateHash.hashStr(s) : String(s.length));
function mirrorHash() {
  const W = local.client && local.client.world;
  if (!W) return null;
  return hashOf([...W.chunks.keys()].sort().map(k => chunkText(W.chunks.get(k))).join("|"));
}
function simHash(keys) {
  const W = BF.world;
  return hashOf([...keys].sort().map(k => { const c = W.chunks.get(k); return c ? chunkText(c) : k + ":missing"; }).join("|"));
}
function check() {
  const sim = local.sim, cl = local.client, diffs = [];
  if (!sim || !cl) return { ok: false, diffs: ["not connected"] };
  const M = cl.world, W = BF.world;
  for (const [k, mc] of M.chunks) {
    const c = W.chunks.get(k);
    if (!c) { diffs.push("chunk " + k + " in the mirror, not loaded"); continue; }
    if (c.lo !== mc.lo || c.hi !== mc.hi) { diffs.push("chunk " + k + " band " + mc.lo + ".." + mc.hi + " vs " + c.lo + ".." + c.hi); continue; }
    for (let i = 0; i < c.secs.length; i++) {
      const a = c.secs[i], b = mc.secs[i];
      if (typeof a === "number" && typeof b === "number") { if (a !== b) diffs.push("chunk " + k + " section " + i); continue; }
      for (let j = 0; j < SECN; j++) {
        const va = typeof a === "number" ? a : a[j], vb = typeof b === "number" ? b : b[j];
        if (va !== vb) { diffs.push("chunk " + k + " section " + (c.lo + i) + " cell " + j + ": " + vb + " vs " + va); break; }
      }
    }
  }
  const I = sim.interest();
  for (const k of M.chunks.keys()) if (!I.chunks.has(k)) diffs.push("chunk " + k + " in the mirror, not in view");
  let pending = 0;
  for (const k of I.chunks.keys()) if (!M.chunks.has(k)) pending++;   // not sent yet (a flush sends at most a few chunks)
  const mh = mirrorHash(), sh = simHash(M.chunks.keys());
  let ents = 0;
  for (const [n, r] of I.entities) {
    const e = M.entities.get(n);
    ents++;
    if (!e) { diffs.push("entity " + n + " (" + r.kind + ") not in the mirror"); continue; }
    for (const f in r.s) {
      const a = r.s[f], b = e[f];
      if (HOT[r.kind].includes(f)) { if (Math.abs(a - b) > (POS[f] ? 1e-9 : Math.max(1 / 256, Math.abs(a) * 1e-6))) diffs.push("entity " + n + " " + f + " " + b + " vs " + a); }
      else if (!same(a, b) && JSON.stringify(a) !== JSON.stringify(b)) diffs.push("entity " + n + " " + f + " " + JSON.stringify(b) + " vs " + JSON.stringify(a));
    }
  }
  for (const n of M.entities.keys()) if (!I.entities.has(n)) diffs.push("entity " + n + " in the mirror only");
  return { ok: !diffs.length && mh === sh, chunks: M.chunks.size, pending, entities: ents, mirrorHash: mh, simHash: sh, diffs: diffs.slice(0, 40), ndiffs: diffs.length };
}
function same(a, b) { return a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])); }

// ---------------------------------------------------------------- sounds (r15-37)
// The game's sound cues are bus events (BF.emit) raised by the simulation; js/audio.js plays them at the client. The sim end turns each
// into a plain `sound` entry of the events message ({kind: "sound", ev, ...}): positions, block ids, and a mob's protocol number, type and
// height in place of the mob. Doors (js/world.js setDoor, which villagers and the player both use) are wrapped to raise "door".
const mobArgs = (m, o) => {
  if (!m || !m.position) return o;
  o.x = m.position.x; o.y = m.position.y; o.z = m.position.z; o.type = m.type; o.h = m.height || 1;
  if (liveSim) o.n = liveSim.nOf(m);
  return o;
};
const SOUNDS = {
  blockBroken: (x, y, z, id) => ({ x, y, z, id }),
  blockPlaced: (x, y, z, id) => ({ x, y, z, id }),
  blockHit: (x, y, z, id) => ({ x, y, z, id }),
  playerEating: () => ({}), playerAte: () => ({}), playerDamaged: () => ({}), villagerLevelUp: () => ({}), gameModeChanged: () => ({}), worldLoaded: () => ({}),
  mobHurt: m => (m && m.hp > 0 ? mobArgs(m, {}) : null),
  mobKilled: m => (m && !m.exploded ? mobArgs(m, {}) : null),
  mobExploded: (m, c) => { const p = c || (m && m.position); return p ? { x: p.x, y: p.y, z: p.z } : null; },
  arrowShot: (m, from) => { const p = from || (m && m.position); return p ? { x: p.x, y: p.y, z: p.z } : null; },
  chestOpened: (x, y, z) => ({ x, y, z }), chestClosed: (x, y, z) => ({ x, y, z }),
  doorBroken: (m, x, y, z) => ({ x, y, z }),
  villagerTrade: v => mobArgs(v, {}),
  lightning: e => (e ? { lx: e.x, lz: e.z, dist: e.dist } : null),   // (heard from far off: not limited to the view)
};
// r15-44: what the inventory screens show besides (js/invscreen.js): a toast (+n of an item), the trade screen's villager going up a
// level, the held item's name over the hotbar (a creative pick-block). Entries {kind, ...} of the events message, like the sounds.
const UI = {
  invToast: (id, n) => ({ kind: "toast", id, n }),
  villagerLevelUp: v => ({ kind: "levelUp", id: v && v.id != null ? v.id : null }),
  invFlashName: () => ({ kind: "flashName" }),
  // r15-43: a debug screen alert fired (js/alertsim.js): the page shows its notice (js/alerts.js)
  alertFired: (alert, o) => Object.assign({ kind: "alert", alert }, o),
};
function soundTap() {
  for (const ev in SOUNDS) BF.on(ev, (...a) => {
    if (!liveSim) return;
    const o = SOUNDS[ev](...a);
    if (o) { o.kind = "sound"; o.ev = ev; liveSim.onFx(o); }
  });
  for (const ev in UI) BF.on(ev, (...a) => { if (liveSim) liveSim.onFx(UI[ev](...a)); });
  const W = BF.world;
  if (W && W.setDoor && !W.setDoor._proto) {
    const orig = W.setDoor;
    W.setDoor = function (x, y, z, open) {
      const before = BF.blocks[W.getBlock(x, y, z)], was = before && before.door ? before.door.open : null;
      const res = orig.apply(this, arguments);
      if (res != null && res !== was && liveSim) liveSim.onFx({ kind: "sound", ev: "door", open: !!res, x, y, z });
      return res;
    };
    W.setDoor._proto = true;
  }
}

// ---------------------------------------------------------------- hooks
// The world's block hook (js/world.js setBlock), effects and log lines go to the live sim end; a new world starts the client over.
function hookUp() {
  if (BF.world && BF.world.onBlockSet && !hookUp.w) { hookUp.w = true; BF.world.onBlockSet((c, i, id) => { if (liveSim) liveSim.onBlock(c, i, id); }); }
  if (BF.fx && BF.fx.tap && !hookUp.f) { hookUp.f = true; BF.fx.tap(e => { if (liveSim) liveSim.onFx(e); }); }
  if (BF.glog && BF.glog.tap && !hookUp.g) { hookUp.g = true; BF.glog.tap(e => { if (liveSim) liveSim.onLog(e); }); }
  if (BF.on && !hookUp.n) { hookUp.n = true; BF.on("newWorld", () => { if (liveSim) liveSim.reset(); }); soundTap(); }
}

BF.proto = {
  VERSION, TYPES, HOT, COLD, encode, decode, bytes, serve, connect, local, worker, host, hosted, stats, resetStats, check, mirrorHash, simHash, queries: QUERIES,
  listen: fn => { LISTEN.push(fn); },
  onSelf: fn => { SELF.push(fn); },
  // (tests) the protocol number the sim end gives a simulation object (a mob, drop, arrow, boat or bee), or null: in the page, or where
  // the simulation is (the worker or the world server, through BFT.sim)
  numberOf: o => (o && typeof o === "object" && liveSim ? liveSim.nOf(o) : null),
  hookUp,
  // once a frame: the client's view (in the page, also through the worker), then the simulation end's flush (in the page, or in the worker)
  flush(force) {
    hookUp();
    if (local.client) local.client.frame();
    if (worker.client) worker.client.frame();
    if (local.sim) local.sim.flush(force);
    if (here) here.flush(force);
  },
};
})();
