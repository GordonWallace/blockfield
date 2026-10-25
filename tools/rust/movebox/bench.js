// r15-50 experiment harness: the headless simulation (tools/headless.js) with world.moveBox in JavaScript or in Rust.
// Build first: tools/rust/movebox/build.sh (WebAssembly and the Node addon).
//   node tools/rust/movebox/bench.js run <seed> <game s> <js|jsfast|wasm|napi|compare-jsfast|compare-wasm|compare-napi> [hash every s]
//     -> one JSON line: ms/tick, V·s/s, the slice's stats, the world state hash (and its checkpoints)
//   node tools/rust/movebox/bench.js calls <seed> [recorded ticks] [repeats]
//     -> per call: the same recorded moveBox calls replayed against the same world with each backend
const fs = require('fs'), path = require('path');
const here = __dirname, root = path.resolve(here, '../../..');
const { load } = require(path.join(root, 'tools/headless.js'));
const { install } = require('./glue.js');

function backend(kind) {
  if (kind === 'jsfast') return { kind, make: require('./jsfast.js').make };
  if (kind === 'wasm') {
    const m = new WebAssembly.Module(fs.readFileSync(path.join(here, 'target/wasm32-unknown-unknown/release/movebox.wasm')));
    return { kind, exports: new WebAssembly.Instance(m, {}).exports };
  }
  const so = path.join(here, 'target/release/libmovebox.so'), node = path.join(here, 'target/release/movebox.node');
  fs.copyFileSync(so, node);
  return { kind: 'napi', exports: require(node) };
}

function boot(seed) {
  const L = load(), BF = L.BF;
  const t0 = performance.now();
  const h = BF.boot.headless({ seed, settings: { at: 'village' } });
  return { BF, h, bootS: (performance.now() - t0) / 1000 };
}

function run(seed, secs, mode, every) {
  const { BF, h, bootS } = boot(seed);
  let ctl = null;
  if (mode !== 'js') {
    ctl = install(BF, backend(mode.replace('compare-', '')));
    ctl.mode = mode.startsWith('compare') ? 'compare' : 'rust';
  }
  BF.perf.ask(true); BF.perf.reset();
  const ticks = Math.round(secs / BF.warp.TICK), ev = every ? Math.round(every / BF.warp.TICK) : 0, checks = [];
  const t0 = performance.now();
  let hashMs = 0;
  for (let i = 1; i <= ticks; i++) {
    h.tick(1);
    if (i % 20 === 0) BF.perf.frame();
    if (ev && i % ev === 0) { const a = performance.now(); checks.push(h.stateHash().hash); hashMs += performance.now() - a; }
  }
  const real = (performance.now() - t0 - hashMs) / 1000;
  const T = BF.perf.totals();
  const out = {
    seed, mode, secs, bootS: +bootS.toFixed(1), real: +real.toFixed(2), msPerTick: +(T.stepMs / T.steps).toFixed(3), vss: Math.round(T.vs / real),
    villagers: BF.mobs.list.filter(m => m.type === 'villager' && !m.dead).length, mobs: BF.mobs.list.length, chunks: BF.world.chunks.size,
    hash: h.stateHash().hash, checks,
  };
  if (ctl) { out.stats = { ...ctl.stats, uploadMs: +ctl.stats.uploadMs.toFixed(1) }; out.mirrorChunks = ctl.chunks(); out.mirrorMB = +(ctl.bytes() / 1e6).toFixed(1); }
  console.log(JSON.stringify(out));
}

// Records the arguments of every moveBox call over `rec` ticks, then replays them (on copies of pos / vel) with each backend.
function calls(seed, rec, reps) {
  const { BF, h } = boot(seed);
  for (let i = 0; i < 600; i++) h.tick(1);   // 30 s in
  const W = BF.world, orig = W.moveBox, log = [];
  W.moveBox = function (pos, vel, hw, hh, dt, opts) {
    log.push([pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, hw, hh, dt, opts ? { stepUp: opts.stepUp, swim: opts.swim, firm: opts.firm } : undefined]);
    return orig(pos, vel, hw, hh, dt, opts);
  };
  h.tick(rec);
  W.moveBox = orig;
  // the world is now as after the last recorded call; the replays all read this same world
  const replay = fn => {
    let sink = 0;
    const t0 = performance.now();
    for (let r = 0; r < reps; r++) for (const a of log) {
      const p = { x: a[0], y: a[1], z: a[2] }, v = { x: a[3], y: a[4], z: a[5] };
      const res = fn(p, v, a[6], a[7], a[8], a[9]);
      sink += p.x + (res.onGround ? 1 : 0);
    }
    return { us: (performance.now() - t0) * 1000 / (reps * log.length), sink };
  };
  const results = { seed, calls: log.length, perTick: +(log.length / rec).toFixed(1) };
  replay(orig);   // warm
  results.js = replay(orig);
  for (const kind of ['jsfast', 'wasm', 'napi']) {
    const L2 = install(BF, backend(kind));
    L2.mode = 'rust';
    replay(W.moveBox);   // warm (fills the mirror)
    L2.reset();
    const r = replay(W.moveBox);
    r.fallbacks = L2.stats.fallbacks; r.misses = L2.stats.misses;
    // the cost of filling the mirror from nothing (every chunk the calls touch copied in)
    L2.clear(); L2.reset();
    const t0 = performance.now(); replay(W.moveBox); r.firstPassMs = +(performance.now() - t0).toFixed(1);
    r.uploads = L2.stats.uploads; r.uploadMs = +L2.stats.uploadMs.toFixed(2); r.sections = L2.stats.sections; r.mirrorMB = +(L2.bytes() / 1e6).toFixed(2);
    // the same: identical outputs?
    L2.mode = 'compare'; L2.reset(); replay(W.moveBox); r.diffs = L2.stats.diffs; r.compared = L2.stats.rust;
    results[kind] = r;
    W.moveBox = L2.jsMove; W.mirror = null;
  }
  for (const k of ['js', 'jsfast', 'wasm', 'napi']) results[k].us = +results[k].us.toFixed(3);
  console.log(JSON.stringify(results));
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'run') run(+a[0], +a[1], a[2], +a[3] || 0);
else if (cmd === 'calls') calls(+a[0], +a[1] || 400, +a[2] || 5);
else { console.log('usage: bench.js run <seed> <secs> <mode> [every] | calls <seed> [ticks] [reps]'); process.exit(1); }
process.exit(0);
