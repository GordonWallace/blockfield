// Headless simulation (spec r15-40): loads the simulation's files (js/simfiles.js) into this Node process with no document, canvas,
// WebGL or Three.js scene, boots a seed (or a save) with BF.boot.headless (js/boot.js) and ticks N game seconds, then prints the
// villager-seconds per second (js/perf.js) and the world state hash (js/statehash.js). The fast CI path, and the base of the Node
// world server (r15-41).
// Usage: node tools/headless.js [--seed 3] [--seconds 600] [--at village|spawn] [--villages 10] [--view 8] [--log file.log]
//                               [--save out.json] [--load save.json] [--json] [--every s] [--workers n] [--verify ticks] [--after s] [--shuffle k] [--dump file] [--extra n] [--reach blocks] [--mem MB] [--coarse on|off]
//                               [--ctick converted|full|a,b,c] [--cworkers n] [--partial] [--sizes] [--meet ticks]
//   --at village (default): the player moves to the village nearest the spawn first, so villagers are simulated; spawn: stays there.
//   --extra n: the n nearest other villages are simulated too, however far (js/active.js fixed set; a heavier load to measure with), as
//   long as they are within --reach blocks (default 4000) and their chunks fit in --mem MB (default 500); the boot line says how many came.
//   --coarse on|off: far villages coarse or full detail for this run, whatever the world's option (spec r15-64, js/gameopts.js).
//   --log: the game log, one line an entry (js/logmatch.js gameLine), as the debug screen's download writes it.
//   --save / --load: the save data as js/save.js stores it (snapshot / restore), as JSON. --every: print the hash every s game seconds.
//   --workers n: the regions' thinking split over n workers (spec r15-39: n - 1 worker_threads, server/regionthread.js); the world must
//   come out the same as with one. --verify t: the workers compare state hashes every t ticks (slow; tests). --shuffle k (tests): regions go to workers by a hash of k at every rebalance, whatever they cost, to try other splits. --after s: the
//   split starts after s game seconds that every copy plays on its own (as in play, js/rplay.js).
//   --ctick p: the cluster tick on (spec r15-39b, js/ctick.js) with the systems of profile p (BF.ctick.only: converted, the systems marked
//   converted; full, every system; or a list). --cworkers n: and the clusters split over n workers (C7, js/cworkers.js: n - 1
//   worker_threads, server/regionthread.js); the world must come out the same as with one. --order cluster (the default with
//   --cworkers: each group's interval in turn) or tick; either way the groups are planned onto workers at each meeting (js/cworkers.js
//   plan), or with --pull (cluster order) each worker takes the next group when it is free; --shuffle k: the groups change workers at
//   every meeting; --partial: partial copies (each worker's copy of a mob is current only while it runs it; the end hash gathers them);
//   --meet t (benchmarks): the clusters meet every t ticks instead of 20 (every worker the same; hashes differ from the default's).
//   --sizes: what worker 0 sends at a meeting, KB by part. --load works with --cworkers too (every worker restores the save): use a
//   settled save to measure, since a fresh world's first minutes spawn wild animals per cluster.
//   --json: one JSON line at the end ({seed, seconds, ticks, vss, mobss, msPerTick, real, villagers, mobs, chunks, hash, parts, workers,
//   census: every item in the world by name, and the emeralds}).
// As a module: const { load } = require('./tools/headless.js'); const { BF, ctx } = load(); BF.boot.headless({seed: 3}).tick(20);
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');

// The simulation loaded into this process's own global context, as the world server does (server/simthread.js), so it runs at the
// same speed as in a page or the server. (Until r15-50's follow-up it ran in a vm context; there every read of a global such as Math
// goes through the context's interceptor, and the whole simulation ran about 2.5x slower, which skewed every headless measurement.)
// Once a process: a second call throws. opts.isolated: a fresh vm context instead (the old way: slow, but several worlds in one process).
// opts.log: a file path for the game log; opts.globals: more globals for it (a region worker in play takes the simulation thread's
// navigator and location, so the files set themselves up the same: server/regionthread.js); opts.files: more files to run after the
// simulation's. Returns { BF, ctx (the global object the game sees), ms (load time) }.
function load(opts = {}) {
  const t0 = performance.now();
  let ctx, run;
  if (opts.isolated) {
    const con = {};   // the game wraps console.error / warn (js/gamelog.js): its own copy, so Node's console is left alone
    for (const k of Object.keys(console)) con[k] = typeof console[k] === 'function' ? console[k].bind(console) : console[k];
    // timers that don't keep Node running (the game log flushes on an interval)
    const unref = f => (...a) => { const t = f(...a); if (t && t.unref) t.unref(); return t; };
    ctx = {
      console: con, performance, TextEncoder, TextDecoder, structuredClone, queueMicrotask, URL, btoa, atob,
      setTimeout: unref(setTimeout), setInterval: unref(setInterval), clearTimeout, clearInterval,
    };
    vm.createContext(ctx);
    run = f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: path.join(root, f) });
  } else {
    if (globalThis.BF) throw new Error('the simulation is already loaded in this process (load({ isolated: true }) for another)');
    ctx = globalThis;
    run = f => vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: path.join(root, f) });
  }
  for (const [k, v] of Object.entries(opts.globals || {})) Object.defineProperty(ctx, k, { value: v, writable: true, configurable: true });   // (Node's own navigator is a getter)
  run('.three-test.min.js');   // three.js r128 (the copy the tests serve for the CDN's): its maths only, no renderer
  for (const f of require('../js/simfiles.js')) run(f);
  for (const f of opts.files || []) run(f);
  const BF = ctx.BF;
  if (opts.log) {
    const fd = fs.openSync(opts.log, 'w');
    const LM = BF.logmatch;
    fs.writeSync(fd, 'Blockfield ' + BF.VERSION + ' headless (tools/headless.js)\n');
    BF.glog.setSink(e => fs.writeSync(fd, LM.gameLine(e) + '\n'));
  }
  return { BF, ctx, ms: performance.now() - t0 };
}

// Every item stack in the world by item name: mobs' inventories, chests, furnaces, the player's slots and the drops lying about. Two runs
// of the same seed (test/multi-worker.js: 1, 2 and 4 workers) must come out with the same; nothing made twice or lost on the way.
// -> { items: {name: count}, coins: emeralds }
function census(BF) { return BF.perf.census(); }   // (js/perf.js, r15-60: also the base of BF.perf.activity's items gained and spent)

// JSON for the save data: typed arrays (the block edits) as plain arrays, which js/save.js restore reads the same way.
const saveJSON = data => JSON.stringify(data, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));

async function main(argv) {
  const a = {}, flags = new Set(['json', 'audit', 'partial', 'pull', 'sizes']);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if (!m) throw new Error('unknown argument ' + argv[i]);
    a[m[1]] = flags.has(m[1]) ? true : argv[++i];
  }
  const seed = a.seed != null ? +a.seed : 3, seconds = a.seconds != null ? +a.seconds : 600;
  const L = load({ log: a.log });
  const BF = L.BF;
  const say = a.json ? () => {} : s => console.log(s);
  say(`loaded ${require('../js/simfiles.js').length} sim files in ${L.ms.toFixed(0)} ms`);
  const t0 = performance.now();
  const h = BF.boot.headless({
    seed, save: a.load ? JSON.parse(fs.readFileSync(a.load, 'utf8')) : null,
    settings: { at: a.at || 'village', villages: a.villages != null ? +a.villages : undefined, viewDist: a.view != null ? +a.view : undefined, extra: a.extra != null ? +a.extra : undefined, reach: a.reach != null ? +a.reach : undefined, memMB: a.mem != null ? +a.mem : undefined, coarse: a.coarse },
  });
  const p = BF.player.position;
  say(`booted ${a.load ? a.load : 'seed ' + BF.state.seed} in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${BF.world.chunks.size} chunks, ` +
    `${BF.mobs.list.length} mobs, player at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${h.village ? ' (nearest village)' : ''}`);
  if (a.extra != null) { const o = BF.active.opts(), n = BF.active.extras().length; say(`extra villages: ${n} of the ${a.extra} asked` + (n < +a.extra ? ` (the rest are over ${o.reach} blocks away or past the ${o.memMB} MB chunk limit: --reach, --mem)` : '')); }
  const H0 = h.stateHash();
  say(`hash at the start ${H0.hash}`);
  // --workers n (spec r15-39): n - 1 followers (server/regionthread.js) boot the same world from this one's river network, then every
  // tick runs on all n with the regions' thinking split between them (js/rworkers.js)
  const nw = a.workers != null ? Math.max(1, +a.workers | 0) : 1, ncw = a.cworkers != null ? Math.max(1, +a.cworkers | 0) : 1;
  const only = a.ctick == null || a.ctick === 'full' ? null : a.ctick === 'converted' ? BF.ctick.converted() : String(a.ctick).split(',');
  let pool = null;
  if (a.meet != null) BF.ctick.setMeet(+a.meet);
  if (a.ctick != null || ncw > 1) {
    BF.ctick.only = only; BF.ctick.on = true;
    if (a.order) BF.ctick.order = a.order;
    say(`cluster tick on (${only ? only.join(', ') : 'every system'})`);
  }
  if (ncw > 1) {   // C7: n - 1 followers with the same world and the cluster tick on, every worker running its own groups
    const t1 = performance.now();
    pool = require('../server/regionthread.js').spawn(ncw);
    const rivers = BF.worldgen.riverState();
    const save = a.load ? JSON.parse(fs.readFileSync(a.load, 'utf8')) : null;   // (--load: every worker restores the same save)
    const boots = await Promise.all(pool.list.map(f => f.ask({ boot: { seed, rivers, save,
      settings: { at: a.at || 'village', villages: a.villages != null ? +a.villages : undefined, viewDist: a.view != null ? +a.view : undefined, extra: a.extra != null ? +a.extra : undefined, reach: a.reach != null ? +a.reach : undefined, memMB: a.mem != null ? +a.mem : undefined, coarse: a.coarse } } })));
    for (const [i, b] of boots.entries()) if (b.booted !== H0.hash) throw new Error(`cluster worker ${i + 1} booted a different world (${b.booted}, not ${H0.hash})`);
    const shared = BF.cworkers.makeShared(ncw), order = a.order || 'cluster';
    await Promise.all(pool.list.map(f => f.ask({ cstart: { shared, me: f.me, n: ncw, only, order, shuffle: +a.shuffle || 0, pull: !!a.pull, partial: !!a.partial, meet: a.meet != null ? +a.meet : null } })));
    BF.ctick.order = order;
    BF.cworkers.shuffle = +a.shuffle || 0;
    BF.cworkers.setup({ n: ncw, me: 0, link: BF.rworkers.attach(shared, 0, ncw), claims: shared.claims, pull: !!a.pull, partial: !!a.partial });
    BF.cworkers.prof = {}; if (a.sizes) BF.cworkers.sizes = {};
    say(`${ncw} cluster workers: ${ncw - 1} followers booted the same world in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  } else if (nw > 1) {
    const t1 = performance.now();
    pool = require('../server/regionthread.js').spawn(nw);
    const rivers = BF.worldgen.riverState();
    const boots = await Promise.all(pool.list.map(f => f.ask({ boot: { seed, save: a.load ? JSON.parse(fs.readFileSync(a.load, 'utf8')) : null, rivers,
      settings: { at: a.at || 'village', villages: a.villages != null ? +a.villages : undefined, viewDist: a.view != null ? +a.view : undefined, extra: a.extra != null ? +a.extra : undefined, reach: a.reach != null ? +a.reach : undefined, memMB: a.mem != null ? +a.mem : undefined, coarse: a.coarse } } })));
    for (const [i, b] of boots.entries()) if (b.booted !== H0.hash) throw new Error(`region worker ${i + 1} booted a different world (${b.booted}, not ${H0.hash})`);
    if (+a.after > 0) {   // --after s: every copy plays s game seconds on its own first, then the split starts mid-run (as it does in play)
      const t = Math.round(+a.after / BF.warp.TICK), wait = pool.list.map(f => f.ask({ ticks: t }));
      h.tick(t);
      await Promise.all(wait);
    }
    const shared = BF.rworkers.makeShared(nw);
    await Promise.all(pool.list.map(f => f.ask({ start: { shared, me: f.me, n: nw, verify: +a.verify || 0, audit: !!a.audit, shuffle: +a.shuffle || 0 } })));
    BF.rworkers.verify = +a.verify || 0;
    BF.rworkers.audit = !!a.audit;
    BF.rworkers.shuffle = +a.shuffle || 0;
    BF.rworkers.setup({ n: nw, me: 0, link: BF.rworkers.attach(shared, 0, nw) });
    say(`${nw} workers: ${nw - 1} followers booted the same world in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  }
  // the villager-seconds meter, on for the run (a harness asks for it: js/perf.js)
  BF.perf.ask(true); BF.perf.reset();
  // chunk churn during the run (built and unloaded keys; chunk building is outside the sim step, so it shows only in real time)
  const churn = { built: new Map(), gone: new Set(), unloaded: 0 };
  BF.world.onChunkLoad((cx, cz) => { const k = cx + ',' + cz; churn.built.set(k, (churn.built.get(k) || 0) + 1); });
  BF.world.onChunkUnload((cx, cz) => { churn.unloaded++; churn.gone.add(cx + ',' + cz); });
  const ticks = Math.round(seconds / BF.warp.TICK), every = a.every ? Math.max(1, Math.round(+a.every / BF.warp.TICK)) : 0;
  const done = pool ? pool.list.map(f => f.ask({ ticks })) : [];
  for (let i = 1; i <= ticks; i++) {
    h.tick(1);
    if (i % 20 === 0) BF.perf.frame();   // the meter's window moves on about once a game second
    if (every && i % every === 0) say(`t ${(i * BF.warp.TICK).toFixed(0)} s  ${h.stateHash().hash}  mobs ${BF.mobs.list.length}`);
  }
  const T = BF.perf.totals();
  BF.perf.ask(false);
  let H = pool ? null : h.stateHash();
  let workers = null;
  if (pool) {
    await Promise.all(done);
    const asked = Promise.all(pool.list.map(f => f.ask({ hash: true })));
    H = BF.cworkers.partial ? BF.cworkers.gathered(() => h.stateHash(), "hash") : h.stateHash();   // (partial copies: every worker sends what it runs, at once)
    const hs = await asked;
    const same = hs.every(x => x.hash.hash === H.hash);
    workers = { n: pool.list.length + 1, same, hashes: [H.hash].concat(hs.map(x => x.hash.hash)), mismatch: BF.rworkers.mismatch || hs.map(x => x.mismatch).find(Boolean) || null, stats: BF.rworkers.stats() };
    for (const [i, x] of hs.entries()) if (x.hash.hash !== H.hash) say(`worker ${i + 1}'s world differs from the leader's in ${Object.keys(H.parts).filter(k => H.parts[k] !== x.hash.parts[k]).join(', ')}`);
    if (a.audit) for (const [i, x] of [BF.rworkers.audits].concat(hs.map(x => x.audits)).entries()) for (const e of x || []) console.log(`audit worker ${i}: ${e.by} changed ${e.what} at tick ${e.tick}: ${e.ops}`);
    if (ncw > 1) {
      say(BF.cworkers.text());
      for (const [i, st] of [BF.cworkers.stats()].concat(hs.map(x => x.stats)).entries()) {
        const p = st.perMeeting, f = v => v.toFixed(2);
        say(`  worker ${i}: ms a meeting: run ${f(p.run)}, collect ${f(p.collect)}, exchange (waiting) ${f(p.exchange)}, adopt ${f(p.adopt)}, shadows ${f(p.snap)}; ${f(st.kbPerMeeting)} KB sent`);
        if (st.x) say(`    exchanges a meeting: ` + Object.entries(st.x).map(([k, x]) => `${k} ${f(x.n)}x ${f(x.ms)} ms (waiting ${f(x.wait)})`).join(', '));
      }
      if (BF.cworkers.sizes) say('  worker 0 KB a meeting by part: ' + Object.entries(BF.cworkers.sizes).filter(([k]) => !k.includes('.') || k.startsWith('table.')).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => k + ' ' + (v / 1024 / Math.max(1, BF.cworkers.stats().meetings)).toFixed(1)).join(', '));
      say('  worker 0 swap parts, ms a meeting: ' + Object.entries(BF.cworkers.prof).map(([k, v]) => k + ' ' + (v / Math.max(1, BF.cworkers.stats().meetings)).toFixed(2)).join(', '));
      say('  mobs a meeting: handed over ' + BF.cworkers.stats().moved.toFixed(1) + ', fetched ' + BF.cworkers.stats().fetched.toFixed(1));
      workers.stats = BF.cworkers.stats(); BF.cworkers.stop();
    }
    else { say(BF.rworkers.text()); BF.rworkers.stop(); }
    pool.stop();
  }
  const villagers = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed).length;
  const r = {
    seed: BF.state.seed, seconds: h.seconds, ticks: h.ticks, real: +T.real.toFixed(2),
    vss: Math.round(T.vs / T.real), mobss: Math.round(T.mobs / T.real), msPerTick: +(T.stepMs / Math.max(1, T.steps)).toFixed(3),
    speed: +(T.game / T.real).toFixed(2), villagers, mobs: BF.mobs.list.length, chunks: BF.world.chunks.size, hash: H.hash, parts: H.parts,
    workers, census: census(BF),
    churn: { built: [...churn.built.values()].reduce((x, y) => x + y, 0), unloaded: churn.unloaded, both: [...churn.built.keys()].filter(k => churn.gone.has(k)).length,
      twice: [...churn.built.values()].filter(n => n > 1).length },
  };
  if (a.save) fs.writeFileSync(a.save, saveJSON(h.save()));
  if (a.dump) { const o = {}; for (const k of BF.stateHash.PARTS) o[k] = BF.stateHash.text(k); fs.writeFileSync(a.dump, JSON.stringify(o)); }   // --dump file: every hash part's text (tests: where two runs differ)
  BF.glog.log('INFO', 'headless', `Headless run ended: ${r.seconds.toFixed(0)} game s in ${r.real} s, ${r.vss} V·s/s, hash ${r.hash}`);
  if (a.json) console.log(JSON.stringify(r));
  else {
    say(`ticked ${r.seconds.toFixed(0)} game s (${r.ticks} ticks) in ${r.real} s: ${r.speed}x real time`);
    say(`${r.vss} V·s/s  ${r.mobss} mob-s/s  ${r.msPerTick} ms/tick  ${villagers} villagers, ${r.mobs} mobs, ${r.chunks} chunks`);
    say(`chunks built ${r.churn.built}, unloaded ${r.churn.unloaded} (${r.churn.both} keys both, ${r.churn.twice} built twice)`);
    say(`hash ${r.hash}`);
    if (a.save) say(`saved to ${a.save}`);
  }
  return r;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
}
module.exports = { load, main, saveJSON, census };
