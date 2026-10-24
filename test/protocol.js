// @ci integration suite=world timeout=900
// Simulation/client protocol (spec r15-36, js/protocol.js):
// - encode/decode round-trips for every message type, both directions (chunk sections uniform, raw and run-length);
// - on seed 3, the in-page transport keeps the client's mirror equal to the simulation: chunks (blocks and bands, by a mirror hash) and
//   entities (the set in view, every field, positions within float32) after each flush, over 30 s at 1x and a game day at 100x;
// - a player request goes through the protocol and its block change is in the mirror when the call returns; a refused one comes back
//   refused; many block changes in one tick go as one blockChanges message; a query and a speed message work;
// - the bytes per second at 1x and at 100x (frames at 60 a second), printed for the report.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/proto test/protocol.js [gameSeconds=1200]
module.exports = async (pg) => {
  const daySec = +(process.argv[4] || 1200);
  let fails = 0;
  const ok = (n, c, extra) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); };

  // ---- round-trips (no world needed)
  const rt = await pg.evaluate(() => {
    const P = BF.proto, res = {};
    const eq = (a, b) => BF.stateHash.canon(a) === BF.stateHash.canon(b);
    const raw = new Uint16Array(4096); for (let i = 0; i < 4096; i++) raw[i] = (i * 7919) % 300;
    const runs = new Uint16Array(4096); runs.fill(1, 0, 1000); runs.fill(9, 1000, 4000); runs.fill(65535, 4000);
    const msgs = {
      hello: { t: "hello", v: 1, version: "1.5", seed: 3, tick: 7, settings: { gen: 4, villages: 10, biomeScale: 1, gameMode: "creative" } },
      chunk: { t: "chunk", key: "5,-2", cx: 5, cz: -2, lo: -3, hi: 1, secs: [1, raw, runs, 0] },
      unload: { t: "unload", keys: ["1,2", "3,4"] },
      blockChanges: { t: "blockChanges", tick: 9, chunks: [["1,2", [[0, 1], [70000, 65535]]], ["3,4", [[5, 0]]]] },
      events: { t: "events", tick: 9, list: [{ kind: "puff", x: 1.5, y: 2, z: 3, n: 4, spread: 0.5, dark: true, speed: 1 }, { kind: "heart", x: 0, y: 0, z: 0 }] },
      village: { t: "village", list: [{ key: "1,2", name: "Oakby", x: 10, z: 20, people: 12 }], gone: ["9,9"] },
      clock: { t: "clock", tick: 9, day: 2, time: 0.25, weather: { rain: 0.5 }, speed: 100, frozen: false, achieved: 97.5 },
      log: { t: "log", list: [{ s: 1, d: 2.5, c: null, l: "INFO", k: "game", v: null, x: "hello" }] },
      result: { t: "result", rid: 4, tick: 9, result: { ok: false, why: "changed", was: 3 } },
      request: { t: "request", rid: 4, tick: 9, kind: "player.break", target: "1,2,3", data: { id: 3, harvest: true, slot: 2 } },
      view: { t: "view", x: 1.5, y: 70, z: -3.25, dist: 6 },
      query: { t: "query", qid: 2, what: "villager", args: { id: "e12" } },
      speed: { t: "speed", speed: 100, pause: true },
      save: { t: "save", sid: 1 },
      // the simulation in a worker (r15-38)
      edits: { t: "edits", tick: 9, chunks: [["1,2", [[0, 1], [70000, 65535]]], ["-3,4", [[5, 0]]]] },
      self: { t: "self", tick: 9, health: 14, hunger: 18, gameMode: "survival", pos: [1.5, 70, -3], spawn: { x: 1, y: 70, z: 2 }, hurt: [{ a: 3, from: [1, 2, 3], cause: "zombie" }, { kill: true }], inv: [null, { id: 5, n: 3 }] },
      player: { t: "player", x: 1.5, y: 70, z: -3.25, yaw: 0.5, pitch: -0.25, gameMode: "creative", health: 20, hunger: 20, dead: false },
      world: { t: "world", wid: 2, op: "load", args: { id: "wabc", rivers: null } },
      meta: { t: "meta", id: "wabc", name: "Home", monsters: { zombie: false } },
      clientLog: { t: "clientLog", list: [{ s: 1, d: 2.5, c: null, l: "ERROR", k: "uncaught", v: null, x: "boom" }] },
    };
    for (const k in msgs) { const p = P.encode(msgs[k]); res[k] = { ok: eq(P.decode(p), msgs[k]), bytes: P.bytes(p) }; }
    // entities: positions come back exactly (float64, at planet coordinates too), other hot fields as float32, cold ones exactly
    const em = { t: "entities", tick: 5, add: [{ n: 1, kind: "mob", s: { x: 1, y: 2, z: 3, type: "villager", look: "farmer/1" } }],
      set: [{ n: 1, kind: "mob", s: { x: 2219904.7, z: -1876543.21, yaw: 0.5, look: "farmer/2" } }, { n: 2, kind: "boat", s: { row: [1, 0] } }, { n: 3, kind: "arrow", s: { lx: -0.25, stuck: true } }], gone: [7] };
    const d = P.decode(P.encode(em));
    const set = new Map(d.set.map(e => [e.n, e]));
    res.entities = { ok: eq(d.add, em.add) && eq(d.gone, em.gone) && set.size === 3 && set.get(1).s.x === 2219904.7 && set.get(1).s.z === -1876543.21 && set.get(1).s.yaw === 0.5 &&
      set.get(1).s.look === "farmer/2" && set.get(2).kind === "boat" && eq(set.get(2).s.row, [1, 0]) && set.get(3).s.lx === -0.25 && set.get(3).s.stuck === true, bytes: P.bytes(P.encode(em)) };
    res.types = P.TYPES.out.concat(P.TYPES.in).filter(t => !res[t]);
    res.rle = { raw: P.bytes(P.encode({ t: "chunk", key: "0,0", cx: 0, cz: 0, lo: 0, hi: 1, secs: [raw] })), runs: P.bytes(P.encode({ t: "chunk", key: "0,0", cx: 0, cz: 0, lo: 0, hi: 1, secs: [runs] })) };
    return res;
  });
  for (const k of Object.keys(rt)) if (rt[k] && rt[k].ok !== undefined) ok("round-trip " + k, rt[k].ok, rt[k].bytes + " bytes");
  ok("every message type has a round-trip case", rt.types.length === 0, rt.types);
  ok("a run-length section is far smaller than a raw one", rt.rle.runs < 100 && rt.rle.raw > 8000, rt.rle);

  // ---- seed 3, the village kept loaded round the player
  await pg.evaluate(async () => {
    BF.player.start();
    await BF.save.create({ name: "proto", seed: "3", gameMode: "creative", villages: 10 });
    for (let i = 0; i < 200 && !BF.glog.ready(); i++) await new Promise(r => setTimeout(r, 25));
  });
  await pg.evaluate(async () => {
    BF.state.paused = true;   // the page's own frames don't tick (they still flush: nothing to send without a tick)
    const v = BFT.village(), X = Math.round(v.x) + 12, Z = Math.round(v.z);
    BF.player.teleport(X + 0.5, BF.worldgen.heightAt(X, Z) + 2, Z + 0.5);
    window.PT = {
      sim: 0, flush: 0, frames: 0,
      times() { const r = { simMs: +(PT.sim / PT.frames).toFixed(3), flushMs: +(PT.flush / PT.frames).toFixed(3) }; PT.sim = PT.flush = PT.frames = 0; return r; },
      // one drawn frame without drawing: streaming, the frame's ticks, the player, the protocol flush
      frame(raw) {
        const p = BF.player.position;
        BF.world.update(p.x, p.z, 3);
        const t0 = performance.now(), n = BF.simFrame(raw), t1 = performance.now();
        BF.proto.flush();
        const t2 = performance.now();
        PT.sim += t1 - t0; PT.flush += t2 - t1; PT.frames++;
        return n;
      },
    };
    for (let i = 0; i < 400; i++) { PT.frame(0); await new Promise(r => setTimeout(r, 5)); if (BF.world.queueLength === 0 && i > 20) break; }
    for (let i = 0; i < 40; i++) PT.frame(0);   // every chunk in view sent
    BF.proto.flush(true);   // and the entities in them (no tick has run)
  });
  const c0 = await pg.evaluate(() => BF.proto.check());
  ok("after loading, the mirror equals the simulation", c0.ok, { chunks: c0.chunks, pending: c0.pending, entities: c0.entities, diffs: c0.diffs.slice(0, 5) });
  ok("the mirror has the chunks in view", c0.chunks > 50 && c0.pending === 0, { chunks: c0.chunks });

  // ---- 1x: 30 game seconds of 60 fps frames, checked every 50 frames
  const one = await pg.evaluate(() => {
    BF.warp.reset();
    BF.proto.resetStats(); PT.times();
    const t0 = BF.simNow(), bad = [];
    let frames = 0, checks = 0;
    while (BF.simNow() - t0 < 30) {
      PT.frame(1 / 60); frames++;
      if (frames % 50 === 0) { const c = BF.proto.check(); checks++; if (!c.ok) bad.push({ f: frames, d: c.diffs.slice(0, 3), mh: c.mirrorHash, sh: c.simHash }); }
    }
    return { frames, checks, bad: bad.slice(0, 3), nbad: bad.length, stats: BF.proto.stats(), times: PT.times(), entities: BF.proto.check().entities };
  });
  ok("1x: the mirror equals the simulation at every check", one.nbad === 0, { checks: one.checks, bad: one.bad });
  ok("1x: the mirror has the village's mobs", one.entities > 50, { entities: one.entities });
  const perSec = (st, frames) => {
    const sec = frames / 60, o = {};
    for (const [k, r] of Object.entries(st.out)) o[k] = Math.round(r.bytes / sec);
    return { total: Math.round(st.bytesOut / sec), toSim: Math.round(st.bytesIn / sec), byType: o };
  };
  const b1 = perSec(one.stats, one.frames);
  console.log("TIME 1x ms per frame: " + JSON.stringify(one.times));
  console.log("BYTES 1x per second (60 fps): " + JSON.stringify(b1));
  ok("1x: entities sent every tick", one.stats.out.entities && one.stats.out.entities.msgs >= 30 * 20 * 0.9, one.stats.out.entities);

  // ---- player requests through the protocol
  const req = await pg.evaluate(() => {
    const p = BF.player.position, x = Math.floor(p.x) + 3, z = Math.floor(p.z) + 1, y = BF.world.heightAt(x, z) + 4, cell = x + "," + y + "," + z;
    const before = BF.proto.stats().in.request ? BF.proto.stats().in.request.msgs : 0;
    const r1 = BF.req.player("setBlock", cell, { id: BF.B.stone, expect: 0 });
    const mirror1 = BF.client.world.getBlock(x, y, z), sim1 = BF.world.getBlock(x, y, z);
    const r2 = BF.req.player("setBlock", cell, { id: BF.B.dirt, expect: 0 });   // the cell isn't air any more: refused, as the sim says
    const after = BF.proto.stats().in.request.msgs;
    // a query and a speed message
    let hashQ = null;
    BF.client.query("hash", {}, r => { hashQ = r; });
    hashQ = hashQ && hashQ.ok && hashQ.hash === BF.stateHash();
    BF.client.speed(100);
    const sp = BF.warp.speed;
    BF.client.speed(1);
    // many cells in one tick: one blockChanges message
    const bc0 = BF.proto.stats().out.blockChanges ? BF.proto.stats().out.blockChanges.msgs : 0;
    for (let dx = 0; dx < 6; dx++) for (let dz = 0; dz < 6; dz++) BF.world.setBlock(x + dx - 10, y + 2, z + dz - 10, BF.B.glass || BF.B.stone);
    BF.proto.flush();
    const bc1 = BF.proto.stats().out.blockChanges.msgs;
    const c = BF.proto.check();
    return { r1: r1.result, r2: r2.result, mirror1, sim1, stone: BF.B.stone, sent: after - before, hashQ, sp, oneMsg: bc1 - bc0, check: c.ok, diffs: c.diffs.slice(0, 3) };
  });
  ok("a player request goes through the protocol and its edit is in the mirror at once", req.r1 && req.r1.ok && req.mirror1 === req.stone && req.sim1 === req.stone && req.sent === 2, req);
  ok("a refused player request comes back refused", req.r2 && !req.r2.ok && req.r2.why === "changed", req.r2);
  ok("a query answers and speed messages set the speed", req.hashQ && req.sp === 100, { hashQ: req.hashQ, sp: req.sp });
  ok("36 cells changed in one tick go as one blockChanges message", req.oneMsg === 1 && req.check, req);

  // ---- 100x: a game day of 60 fps frames, checked every 30 frames
  const ff = await pg.evaluate(async (daySec) => {
    BF.warp.set(BF.warp.SPEEDS.indexOf(100));
    BF.proto.resetStats(); PT.times();
    const t0 = BF.simNow(), bad = [], w0 = performance.now();
    let frames = 0, checks = 0, ticks = 0;
    while (BF.simNow() - t0 < daySec && frames < 20000) {
      ticks += PT.frame(1 / 60); frames++;
      if (frames % 30 === 0) {
        const c = BF.proto.check(); checks++; if (!c.ok) bad.push({ f: frames, d: c.diffs.slice(0, 3), n: c.ndiffs, mh: c.mirrorHash, sh: c.simHash });
        await new Promise(r => setTimeout(r, 0));
      }
    }
    const times = PT.times(), c = BF.proto.check();
    BF.warp.reset();
    return { times, frames, ticks, checks, bad: bad.slice(0, 3), nbad: bad.length, stats: BF.proto.stats(), game: BF.simNow() - t0, wall: (performance.now() - w0) / 1000,
      last: { ok: c.ok, chunks: c.chunks, entities: c.entities }, tracked: BF.proto.local.sim.S.ents.size };
  }, daySec);
  ok("100x: the mirror equals the simulation at every check over a game day", ff.nbad === 0 && ff.last.ok, { checks: ff.checks, game: Math.round(ff.game), bad: ff.bad, last: ff.last });
  const b100 = perSec(ff.stats, ff.frames);
  console.log("TIME 100x ms per frame: " + JSON.stringify(ff.times));
  console.log("BYTES 100x per second (60 fps frames, " + (ff.ticks / ff.frames).toFixed(1) + " ticks a frame, achieved " + (ff.game / (ff.frames / 60)).toFixed(0) + "x): " + JSON.stringify(b100));
  ok("100x: entities at most once a frame", ff.stats.out.entities && ff.stats.out.entities.msgs <= ff.stats.flushes && ff.stats.out.entities.msgs * 10 < ff.ticks,
    { msgs: ff.stats.out.entities && ff.stats.out.entities.msgs, flushes: ff.stats.flushes, ticks: ff.ticks });
  console.log("wall " + ff.wall.toFixed(0) + " s for " + Math.round(ff.game) + " game s");
  console.log(fails ? "FAILED " + fails : "ALL PASS");
};
