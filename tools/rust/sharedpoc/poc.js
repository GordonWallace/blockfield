// Shared-memory proof of concept (prototype only, never merged): does sharing one copy of the world between threads beat copying it
// between workers? A toy of the cluster split, not the game.
//
// Model: N villager-like objects, W u32 words of state each, in groups of 20 (N/20 groups). Every tick each object
//   - reads one word of each of its 20 group-mates' state as it was at the start of the tick (exchange within the group, every tick);
//   - reads 2 objects of any group from the snapshot (exchange across groups: the snapshot is retaken every 20 ticks = once a game second);
//   - does K rounds of mixing (its "thinking", sized so one object costs about what a real villager does, ~18 us in JS);
//   - writes its new state.
// State is double-buffered (read cur, write nxt, swap), so the result can't depend on thread timing: every mode must end on the same
// checksum (the ordered-apply rule). Integer maths only (Math.imul), so Rust gets the same bits.
//
// Modes (node poc.js <mode> <N> <threads> <K> <ticks> [W=64]):
//   single  one thread
//   msgobj  workers own whole groups; per tick a barrier by message; every 20 ticks each worker posts its objects as JS objects
//           ({id, w: [..]}) and the main thread sends every worker the whole world (like today's clusters copying mobs)
//   msgbuf  the same, posting raw Uint32Array copies instead of objects
//   sab     workers share cur / nxt / snap in SharedArrayBuffers; an Atomics barrier per tick (two on snapshot ticks)
// Prints one JSON line: mode, N, threads, K, ticks, ms/tick, us/object-tick, checksum.
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const GROUP = 20, SNAP_EVERY = 20;
function mix(a, b) {
  a = (a ^ b) >>> 0;
  a = Math.imul(a, 0x85ebca6b); a ^= a >>> 13;
  a = Math.imul(a, 0xc2b2ae35); a ^= a >>> 16;
  return a >>> 0;
}
function init(N, W) { const s = new Uint32Array(N * W); for (let i = 0; i < s.length; i++) s[i] = mix(i, 0x9e3779b9); return s; }
// One object's tick: reads cur (and snap), writes its row of nxt.
function step(i, t, cur, nxt, snap, N, W, K) {
  const base = i - (i % GROUP), m = W - 1, row = i * W;
  let h = mix(i, Math.imul(t, 0x9e3779b9));
  for (let j = 0; j < GROUP; j++) h = mix(h, cur[(base + j) * W + ((t + j) & m)]);
  for (let q = 0; q < 2; q++) { const o = h % N; h = mix(h, snap[o * W + ((q + t) & m)]); }
  for (let r = 0; r < K; r++) h = mix(h, cur[row + (r & m)] + r);
  for (let k = 0; k < W; k++) nxt[row + k] = mix(cur[row + k], (h + k) >>> 0);
}
function checksum(s) { let h = 0; for (let i = 0; i < s.length; i++) h = mix(h, s[i]); return h; }
// The objects worker w of n owns: whole groups, contiguous.
function range(N, n, w) { const G = N / GROUP, g0 = Math.floor(G * w / n), g1 = Math.floor(G * (w + 1) / n); return [g0 * GROUP, g1 * GROUP]; }

if (!isMainThread) {
  const d = workerData;
  const { N, W, K, ticks, mode } = d;
  const [a, b] = range(N, d.n, d.w);
  if (mode === 'sab') {
    const bufs = [new Uint32Array(d.s0), new Uint32Array(d.s1)], snap = new Uint32Array(d.snap), bar = new Int32Array(d.bar);
    // sense-reversing barrier: bar[0] = arrivals, bar[1] = generation
    const barrier = () => {
      const gen = Atomics.load(bar, 1);
      if (Atomics.add(bar, 0, 1) === d.n - 1) { Atomics.store(bar, 0, 0); Atomics.add(bar, 1, 1); Atomics.notify(bar, 1); }
      else while (Atomics.load(bar, 1) === gen) Atomics.wait(bar, 1, gen);
    };
    while (Atomics.load(bar, 2) === 0) Atomics.wait(bar, 2, 0);   // the main thread's start signal (bar[2])
    for (let t = 0; t < ticks; t++) {
      const cur = bufs[t & 1], nxt = bufs[(t + 1) & 1];
      for (let i = a; i < b; i++) step(i, t, cur, nxt, snap, N, W, K);
      barrier();
      if ((t + 1) % SNAP_EVERY === 0) { snap.set(nxt.subarray(a * W, b * W), a * W); barrier(); }
    }
    parentPort.postMessage({ done: true });
  } else {
    // message modes: a full private copy of the world; own rows computed here, the rest only refreshed through the snapshot
    let cur = init(N, W), nxt = new Uint32Array(N * W);
    const snap = cur.slice();
    let t = 0;
    const run = () => {
      for (let i = a; i < b; i++) step(i, t, cur, nxt, snap, N, W, K);
      [cur, nxt] = [nxt, cur];
      t++;
      if (t % SNAP_EVERY === 0) {
        if (mode === 'msgobj') {
          const out = [];
          for (let i = a; i < b; i++) out.push({ id: i, w: Array.from(cur.subarray(i * W, (i + 1) * W)) });
          parentPort.postMessage({ t, objs: out });
        } else parentPort.postMessage({ t, buf: cur.slice(a * W, b * W), a });
      } else parentPort.postMessage({ t });
    };
    parentPort.on('message', m => {
      if (m.world) {   // the whole world as of the snapshot: other workers' rows into cur and snap, every row into snap
        if (mode === 'msgobj') for (const o of m.world) { const r = o.id * W; for (let k = 0; k < W; k++) snap[r + k] = o.w[k]; if (o.id < a || o.id >= b) cur.set(snap.subarray(r, r + W), r); }
        else { snap.set(m.world); for (let i = 0; i < N; i++) if (i < a || i >= b) cur.set(snap.subarray(i * W, (i + 1) * W), i * W); }
      }
      if (m.stop) { parentPort.postMessage({ final: cur.slice(a * W, b * W), a }); return; }
      run();
    });
  }
  return;
}

const [mode, Ns, ns, Ks, ticksS, Ws] = process.argv.slice(2);
const N = +Ns, n = +ns, K = +Ks, ticks = +ticksS, W = +(Ws || 64);
if (N % GROUP || W & (W - 1)) throw new Error('N must be a multiple of 20 and W a power of 2');
const done = (ms, sum) => { console.log(JSON.stringify({ lang: 'js', mode, N, threads: n, K, W, ticks, msTick: +(ms / ticks).toFixed(3), usObj: +(ms * 1000 / ticks / N).toFixed(3), checksum: sum })); process.exit(0); };

if (mode === 'single') {
  let cur = init(N, W), nxt = new Uint32Array(N * W);
  const snap = cur.slice();
  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < N; i++) step(i, t, cur, nxt, snap, N, W, K);
    [cur, nxt] = [nxt, cur];
    if ((t + 1) % SNAP_EVERY === 0) snap.set(cur);
  }
  done(performance.now() - t0, checksum(cur));
} else if (mode === 'sab') {
  const mk = () => new SharedArrayBuffer(N * W * 4);
  const s0 = mk(), s1 = mk(), sn = mk(), bar = new SharedArrayBuffer(12);
  new Uint32Array(s0).set(init(N, W)); new Uint32Array(sn).set(new Uint32Array(s0));
  const ws = [];
  let left = n, t0;
  for (let w = 0; w < n; w++) ws.push(new Worker(__filename, { workerData: { mode, N, W, K, ticks, n, w, s0, s1, snap: sn, bar } }));
  Promise.all(ws.map(w => new Promise(r => w.once('online', r)))).then(() => {
    for (const w of ws) w.on('message', () => { if (--left === 0) done(performance.now() - t0, checksum(new Uint32Array(ticks & 1 ? s1 : s0))); });
    const b = new Int32Array(bar);
    t0 = performance.now();
    Atomics.store(b, 2, 1); Atomics.notify(b, 2);
  });
} else if (mode === 'msgobj' || mode === 'msgbuf') {
  const ws = [];
  for (let w = 0; w < n; w++) ws.push(new Worker(__filename, { workerData: { mode, N, W, K, ticks, n, w } }));
  let got = 0, parts = [], t0, finals = new Uint32Array(N * W), fin = 0;
  const onMsg = m => {
    if (m.final) { finals.set(m.final, m.a * W); if (++fin === n) done(performance.now() - t0, checksum(finals)); return; }
    if (m.objs) parts.push(...m.objs); else if (m.buf) parts.push(m);
    if (++got < n) return;
    got = 0;
    const t = m.t;
    let world = null;
    if (t % SNAP_EVERY === 0) {
      if (mode === 'msgobj') world = parts;
      else { world = new Uint32Array(N * W); for (const p of parts) world.set(p.buf, p.a * W); }
      parts = [];
    }
    const msg = t >= ticks ? { stop: true, world } : { world };
    for (const w of ws) w.postMessage(msg);
  };
  Promise.all(ws.map(w => new Promise(r => w.once('online', r)))).then(() => {
    for (const w of ws) w.on('message', onMsg);
    t0 = performance.now();
    for (const w of ws) w.postMessage({});
  });
} else throw new Error('mode: single, msgobj, msgbuf or sab');
