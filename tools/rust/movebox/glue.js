// r15-50 experiment: switches world.moveBox (js/world.js) between the JavaScript version and the Rust slice (tools/rust/movebox),
// as WebAssembly or as a Node N-API addon. Not a sim file: a harness (tools/rust/movebox/bench.js) or a page loads it on purpose.
// install(BF, backend) -> ctl, where backend is
//   { kind: "wasm", exports }  (instance.exports of movebox.wasm: browser or Node)
//   { kind: "napi", exports }  (require of libmovebox.node)
// ctl.mode: "js" (the original), "rust" (the slice), "compare" (both on every call; the JavaScript result is used, any difference is
// counted and the first few kept). ctl.stats: calls, rust, fallbacks (margin cells or panes: JavaScript did it), misses (chunks
// uploaded or marked absent), uploadMs, sections copied, cells written through, diffs.
// The mirror: Rust keeps its own copy of the loaded chunks' block sections, filled lazily (a chunk is uploaded the first time a call
// needs it) and kept current through world.mirror hooks (js/world.js: every secSet, a band growing, a chunk added or removed).
(function (root) {
"use strict";
function install(BF, backend) {
  const W = BF.world, jsMove = W.jsMoveBox || (W.jsMoveBox = W.moveBox);
  if (backend.kind === "jsfast") return wrap(BF, W, jsMove, backend.make(BF), "jsfast");
  const X = backend.exports, wasm = backend.kind === "wasm";
  let mem = null, io, stage;
  const ioN = 40;
  if (wasm) {
    mem = X.memory;
    const views = () => { const a = X.mb_io(), b = X.mb_stage(); io = new Float64Array(mem.buffer, a, ioN); stage = new Uint16Array(mem.buffer, b, 4096); };
    views();
    var fresh = () => { if (io.buffer !== mem.buffer) views(); };
  } else {
    io = new Float64Array(ioN);
    X.mb_init(io);
    var fresh = () => {};
  }

  // ---- block tables
  const n = Math.max(BF.SOLID.length, BF.RENDER.length, BF.TALLBOX.length, BF.blocks.length);
  const off = new Uint32Array(n + 1), boxes = [], nul = new Uint8Array(n), dyn = new Uint8Array(n);
  const u8 = A => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = A[i] | 0; return a; };
  for (let id = 0; id < n; id++) {
    off[id] = boxes.length / 6;
    if (BF.DYNBOXES[id]) dyn[id] = 1;
    const list = BF.CBOXES[id] || (BF.CBOX[id] ? [BF.CBOX[id]] : null);
    if (!list) nul[id] = 1; else for (const b of list) for (let k = 0; k < 6; k++) boxes.push(b[k]);
  }
  off[n] = boxes.length / 6;
  const tabs = [u8(BF.SOLID), u8(BF.TALLBOX), u8(BF.RENDER), dyn, nul];
  if (wasm) {
    X.mb_tables(n, boxes.length / 6);
    const ptr = [0, 1, 2, 3, 4, 5, 6].map(i => X.mb_table(i));
    tabs.forEach((t, i) => new Uint8Array(mem.buffer, ptr[i], n).set(t));
    new Uint32Array(mem.buffer, ptr[5], n + 1).set(off);
    new Float64Array(mem.buffer, ptr[6], boxes.length).set(boxes);
    fresh();
  } else X.mb_tables(...tabs, off, Float64Array.from(boxes));
  const PN = BF.planet.N;
  X.mb_consts(BF.MIN_Y, BF.H, PN, 3 * PN, BF.B.stone, BF.B.bedrock);

  const st = newStats();

  // ---- the mirror
  function upload(c) {
    const t0 = performance.now();
    const slot = X.mb_chunk_put(c.cx, c.cz, c.lo, c.hi, 0);
    for (let i = 0; i < c.secs.length; i++) {
      const s = c.secs[i];
      if (typeof s === "number") X.mb_sec_uni(slot, i, s);
      else if (wasm) { fresh(); stage.set(s); X.mb_sec_stage(slot, i); st.sections++; }
      else { X.mb_sec(slot, i, s); st.sections++; }
    }
    st.uploads++; st.uploadMs += performance.now() - t0;
  }
  const hooks = {
    cell(c, si, li, id) { X.mb_cell(c.cx, c.cz, si, li, id); st.cells++; },
    drop(c) { X.mb_drop(c.cx, c.cz); },      // the band changed: uploaded again when next needed
    added(c) { X.mb_drop(c.cx, c.cz); },     // (it may have been marked absent)
    removed(c) { X.mb_drop(c.cx, c.cz); },
  };

  function rustMove(pos, vel, hw, h, dt, opts) {
    fresh();
    io[0] = pos.x; io[1] = pos.y; io[2] = pos.z; io[3] = vel.x; io[4] = vel.y; io[5] = vel.z; io[6] = hw; io[7] = h; io[8] = dt;
    io[9] = (opts && opts.stepUp) || 0; io[10] = opts && opts.swim ? 1 : 0; io[11] = opts && opts.firm ? 1 : 0; io[12] = W.high ? 1 : 0;
    for (;;) {
      const r = X.mb_move();
      if (r === 0) break;
      if (r === 1) { st.fallbacks++; return null; }
      fresh();
      const cx = io[24], cz = io[25], c = W.chunks.get(cx + "," + cz);
      st.misses++;
      if (c) upload(c); else { X.mb_chunk_put(cx, cz, 0, 0, 1); }
      fresh();
    }
    fresh();
    pos.x = io[0]; pos.y = io[1]; pos.z = io[2]; vel.x = io[3]; vel.y = io[4]; vel.z = io[5];
    return { onGround: io[16] === 1, hitX: io[17] === 1, hitZ: io[18] === 1, hitCeil: io[19] === 1, inWater: io[20] === 1, headInWater: io[21] === 1 };
  }
  return wrap(BF, W, jsMove, { move: rustMove, hooks, clear: () => X.mb_clear(), count: () => X.mb_count(), bytes: () => X.mb_bytes() }, backend.kind, st);
}
const newStats = () => ({ calls: 0, rust: 0, fallbacks: 0, misses: 0, uploads: 0, sections: 0, cells: 0, uploadMs: 0, diffs: 0, diffList: [] });
// world.moveBox switched between the original and impl.move (null: the original does the call)
function wrap(BF, W, jsMove, impl, kind, st) {
  st = st || newStats();
  const ctl = { mode: "rust", stats: st, jsMove, kind,
    reset() { for (const k in st) st[k] = Array.isArray(st[k]) ? [] : 0; },
    chunks: () => impl.count(), bytes: () => (impl.bytes ? impl.bytes() : 0), clear: () => impl.clear() };
  W.mirror = impl.hooks;
  const same = (a, b) => Object.is(a, b);
  const fast = (pos, vel, hw, h, dt, opts) => { const r = impl.move(pos, vel, hw, h, dt, opts); if (r) st.rust++; else if (kind === "jsfast") st.fallbacks++; return r; };
  W.moveBox = function (pos, vel, hw, h, dt, opts) {
    st.calls++;
    if (ctl.mode === "js") return jsMove(pos, vel, hw, h, dt, opts);
    if (ctl.mode === "rust") return fast(pos, vel, hw, h, dt, opts) || jsMove(pos, vel, hw, h, dt, opts);
    // compare
    const p2 = { x: pos.x, y: pos.y, z: pos.z }, v2 = { x: vel.x, y: vel.y, z: vel.z };
    const r2 = fast(p2, v2, hw, h, dt, opts);
    const r = jsMove(pos, vel, hw, h, dt, opts);
    if (r2) {
      const bad = [];
      for (const k of ["x", "y", "z"]) { if (!same(p2[k], pos[k])) bad.push("pos." + k); if (!same(v2[k], vel[k])) bad.push("vel." + k); }
      for (const k in r) if (r[k] !== r2[k]) bad.push(k);
      if (bad.length) { st.diffs++; if (st.diffList.length < 10) st.diffList.push({ bad, js: [pos.x, pos.y, pos.z, r], rs: [p2.x, p2.y, p2.z, r2] }); }
    }
    return r;
  };
  return ctl;
}
if (typeof module !== "undefined" && module.exports) module.exports = { install };
else root.BFMoveBoxRust = { install };
})(typeof globalThis !== "undefined" ? globalThis : this);
