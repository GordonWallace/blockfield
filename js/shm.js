// Shared-memory prototype (branch r15-shared-mem-proto: never merged; notes/shared-memory-prototype.md). A mob's hottest flat state
// (position, vel and prev, 15 numbers) lives in one SharedArrayBuffer that every cluster worker (js/cworkers.js) maps, instead of a
// copy on each worker that the meeting's swap diffs, sends and patches. The fields keep their names and their plain-object look: a
// bound mob's position and vel are THREE.Vector3s and its prev a plain object whose x, y, z (and prev's other fields) are enumerable
// accessors onto the buffer, so the hash, saves and every reader see the same keys in the same order.
// A mob's slot comes from its id ("e<n>") through a hash table in a second buffer, filled with Atomics.compareExchange, so every worker
// finds the same slot for the same mob whatever order they bind in. Only the worker that owns a mob's group writes its slot (between
// meetings no other group reads it: BF.ids.hidden, ctick.mobs); the meeting runs after the barrier, so every worker reads the same.
// Modes: solo (one thread, every mob bound when made: the cost of the accessors on the tick) or cluster workers (bound at meetings).
// API: BF.shm = { on, solo, make(), attach(shared, solo), detach(), bind(m, write) -> bound, bindRead(m) -> bound, bound(m), stats }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const W = 15, CAP = 1 << 17, MASK = CAP - 1;   // numbers a slot; slots (ids are never reused, so this is a prototype's ceiling)
const SM = { on: false, solo: false, stats: { binds: 0, reads: 0, missing: 0 } };
let F = null, K = null;

const make = () => ({ data: new SharedArrayBuffer(CAP * W * 8), keys: new SharedArrayBuffer(CAP * 4) });
function attach(sh, solo) { F = new Float64Array(sh.data); K = new Int32Array(sh.keys); SM.on = true; SM.solo = !!solo; SM.shared = sh; }
function detach() { SM.on = false; SM.solo = false; }

// the slot of id number n: found, or (add) taken with a compare-exchange; -1 when not there and not added
function slotOf(n, add) {
  let h = (Math.imul(n, 0x9e3779b1) >>> 15) & MASK;
  for (let i = 0; i < CAP; i++, h = (h + 1) & MASK) {
    let k = Atomics.load(K, h);
    if (k === 0) {
      if (!add) return -1;
      k = Atomics.compareExchange(K, h, 0, n);
      if (k === 0) return h;
    }
    if (k === n) return h;
  }
  throw new Error("shm: slot table full");
}
const idNum = m => { const id = m.id; if (typeof id !== "string" || id.charCodeAt(0) !== 101) return 0; const n = +id.slice(1); return n > 0 && n < 0x7fffffff && (n | 0) === n ? n : 0; };

// The accessors, one function pair a field offset, shared by every bound object ($b: its first number in F)
const getters = [], setters = [];
for (let o = 0; o < 9; o++) { getters.push(function () { return F[this.$b + o]; }); setters.push(function (v) { F[this.$b + o] = v; }); }
const PREV = ["x", "y", "z", "yaw", "headYaw", "headPitch", "walkPhase", "walkAmt", "age"], XYZ = PREV.slice(0, 3);
// A new object with o's prototype whose fields keys are accessors onto F from b (write: o's values copied in first). Made fresh, so it
// keeps one fast layout (turning o itself would delete fields, and V8 then keeps it as a slow dictionary: about 35% on the tick).
function view(o, keys, b, write) {
  const v = Object.create(Object.getPrototypeOf(o));
  Object.defineProperty(v, "$b", { value: b });
  for (let i = 0; i < keys.length; i++) {
    Object.defineProperty(v, keys[i], { get: getters[i], set: setters[i], enumerable: true, configurable: true });
    if (write) F[b + i] = o[keys[i]] === undefined ? 0 : o[keys[i]];
  }
  if (SM.poison) for (const k of keys) Object.defineProperty(o, k, { get() { throw new Error("shm: stale " + k + " read"); }, set() { throw new Error("shm: stale " + k + " write"); } });
  return v;
}
const bound = m => m.position && m.position.$b !== undefined;

// Binds m's position, vel and prev to its slot. write: this worker owns m and copies its current values in (the slot is added if new);
// else the slot must exist (its owner bound it) and m takes what is there.
function bind(m, write) {
  if (!SM.on || bound(m)) return true;
  const n = idNum(m);
  if (!n) return false;
  const s = slotOf(n, write);
  if (s < 0) { SM.stats.missing++; return false; }
  const b = s * W;
  if (!m.prev) m.prev = { x: 0, y: 0, z: 0, yaw: 0, headYaw: 0, headPitch: 0, walkPhase: 0, walkAmt: 0, age: 0 };
  m.position = view(m.position, XYZ, b, write); m.vel = view(m.vel, XYZ, b + 3, write); m.prev = view(m.prev, PREV, b + 6, write);
  if (BF.regions && BF.regions.mobMoved) BF.regions.mobMoved(m);   // (the region index holds the position object)
  if (write) SM.stats.binds++; else SM.stats.reads++;
  return true;
}
const bindRead = m => bind(m, false);

Object.assign(SM, { W, CAP, make, attach, detach, bind, bindRead, bound, slotOf, idNum });
BF.shm = SM;
})();
