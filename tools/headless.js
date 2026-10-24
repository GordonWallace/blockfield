// Headless simulation (spec r15-40): loads the simulation's files (js/simfiles.js) into one vm context with no document, canvas,
// WebGL or Three.js scene, boots a seed (or a save) with BF.boot.headless (js/boot.js) and ticks N game seconds, then prints the
// villager-seconds per second (js/perf.js) and the world state hash (js/statehash.js). The fast CI path, and the base of the Node
// world server (r15-41).
// Usage: node tools/headless.js [--seed 3] [--seconds 600] [--at village|spawn] [--villages 10] [--view 8] [--log file.log]
//                               [--save out.json] [--load save.json] [--json] [--every s]
//   --at village (default): the player moves to the village nearest the spawn first, so villagers are simulated; spawn: stays there.
//   --log: the game log, one line an entry (js/logmatch.js gameLine), as the debug screen's download writes it.
//   --save / --load: the save data as js/save.js stores it (snapshot / restore), as JSON. --every: print the hash every s game seconds.
//   --json: one JSON line at the end ({seed, seconds, ticks, vss, mobss, msPerTick, real, villagers, mobs, chunks, hash, parts}).
// As a module: const { load } = require('./tools/headless.js'); const { BF, ctx } = load(); BF.boot.headless({seed: 3}).tick(20);
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');

// A fresh context with the simulation loaded. opts.log: a file path for the game log. Returns { BF, ctx, ms } (ms: load time).
function load(opts = {}) {
  const t0 = performance.now();
  const con = {};   // the game wraps console.error / warn (js/gamelog.js): its own copy, so Node's console is left alone
  for (const k of Object.keys(console)) con[k] = typeof console[k] === 'function' ? console[k].bind(console) : console[k];
  // timers that don't keep Node running (the game log flushes on an interval)
  const unref = f => (...a) => { const t = f(...a); if (t && t.unref) t.unref(); return t; };
  const ctx = {
    console: con, performance, TextEncoder, TextDecoder, structuredClone, queueMicrotask, URL, btoa, atob,
    setTimeout: unref(setTimeout), setInterval: unref(setInterval), clearTimeout, clearInterval,
  };
  vm.createContext(ctx);
  const run = f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: path.join(root, f) });
  run('.three-test.min.js');   // three.js r128 (the copy the tests serve for the CDN's): its maths only, no renderer
  for (const f of require('../js/simfiles.js')) run(f);
  const BF = ctx.BF;
  if (opts.log) {
    const fd = fs.openSync(opts.log, 'w');
    const LM = BF.logmatch;
    fs.writeSync(fd, 'Blockfield ' + BF.VERSION + ' headless (tools/headless.js)\n');
    BF.glog.setSink(e => fs.writeSync(fd, LM.gameLine(e) + '\n'));
  }
  return { BF, ctx, ms: performance.now() - t0 };
}

// JSON for the save data: typed arrays (the block edits) as plain arrays, which js/save.js restore reads the same way.
const saveJSON = data => JSON.stringify(data, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));

function main(argv) {
  const a = {}, flags = new Set(['json']);
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
    settings: { at: a.at || 'village', villages: a.villages != null ? +a.villages : undefined, viewDist: a.view != null ? +a.view : undefined },
  });
  const p = BF.player.position;
  say(`booted ${a.load ? a.load : 'seed ' + BF.state.seed} in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${BF.world.chunks.size} chunks, ` +
    `${BF.mobs.list.length} mobs, player at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${h.village ? ' (nearest village)' : ''}`);
  const H0 = h.stateHash();
  say(`hash at the start ${H0.hash}`);
  // the villager-seconds meter, on for the run (a harness asks for it: js/perf.js)
  BF.perf.ask(true); BF.perf.reset();
  const ticks = Math.round(seconds / BF.warp.TICK), every = a.every ? Math.max(1, Math.round(+a.every / BF.warp.TICK)) : 0;
  for (let i = 1; i <= ticks; i++) {
    h.tick(1);
    if (i % 20 === 0) BF.perf.frame();   // the meter's window moves on about once a game second
    if (every && i % every === 0) say(`t ${(i * BF.warp.TICK).toFixed(0)} s  ${h.stateHash().hash}  mobs ${BF.mobs.list.length}`);
  }
  const T = BF.perf.totals();
  BF.perf.ask(false);
  const H = h.stateHash();
  const villagers = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed).length;
  const r = {
    seed: BF.state.seed, seconds: h.seconds, ticks: h.ticks, real: +T.real.toFixed(2),
    vss: Math.round(T.vs / T.real), mobss: Math.round(T.mobs / T.real), msPerTick: +(T.stepMs / Math.max(1, T.steps)).toFixed(3),
    speed: +(T.game / T.real).toFixed(2), villagers, mobs: BF.mobs.list.length, chunks: BF.world.chunks.size, hash: H.hash, parts: H.parts,
  };
  if (a.save) fs.writeFileSync(a.save, saveJSON(h.save()));
  BF.glog.log('INFO', 'headless', `Headless run ended: ${r.seconds.toFixed(0)} game s in ${r.real} s, ${r.vss} V·s/s, hash ${r.hash}`);
  if (a.json) console.log(JSON.stringify(r));
  else {
    say(`ticked ${r.seconds.toFixed(0)} game s (${r.ticks} ticks) in ${r.real} s: ${r.speed}x real time`);
    say(`${r.vss} V·s/s  ${r.mobss} mob-s/s  ${r.msPerTick} ms/tick  ${villagers} villagers, ${r.mobs} mobs, ${r.chunks} chunks`);
    say(`hash ${r.hash}`);
    if (a.save) say(`saved to ${a.save}`);
  }
  return r;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); process.exit(0); }
  catch (e) { console.log('FAIL ' + (e.stack || e)); process.exit(1); }
}
module.exports = { load, main, saveJSON };
