// Seeded random streams for the simulation (BF.rand). Release 1.5, spec r15-14.
// The simulation draws its random numbers from these instead of Math.random, so the same save and the same inputs give the same result.
// Audio and pure visuals keep Math.random (test/rand.js lists where it may still be used; a line marked `// visual` is allowed anywhere).
// - BF.rand.of(e): the stream of an entity (a mob, a bee). Its state is one uint32 on the entity, e.rng, a plain field saved with the mob
//   (js/mobsave.js snapshots, villagers' trading saves). An entity without one is seeded from the world seed and a creation counter.
// - BF.rand.seed(e, key): seeds e from the world seed and a stable key instead (a villager: its roster slot, js/mobs.js).
// - BF.rand.at(kind, x, z, tick, y): a stateless stream for a world event, hashed from the world seed, the kind ("grow", "spawn"...), the
//   cell (or chunk) and the tick, so a roll depends on where and when it happens, not on how many rolls came before it.
// - BF.rand.tick: the simulation step counter (js/main.js steps it), saved with the world.
// Every stream has next() (0 to 1), int(n) (0 to n-1), range(a, b) and pick(arr).
// API: BF.rand = { of, seed, at, step(), tick, made, save(), load(o), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const worldSeed = () => ((BF.state && BF.state.seed) >>> 0);
// murmur3's finaliser: a good 32-bit mix
function mix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
// mulberry32's output for an (already advanced) state
function out(s) {
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const STEP = 0x6d2b79f5;

const methods = {
  int(n) { return Math.floor(this.next() * n); },
  range(a, b) { return a + this.next() * (b - a); },
  pick(arr) { return arr && arr.length ? arr[Math.floor(this.next() * arr.length)] : undefined; },
};
// a stream whose state lives on an entity (e.rng)
function EntityStream(e) { this.e = e; }
EntityStream.prototype = Object.assign(Object.create(methods), {
  next() {
    const e = this.e;
    if (e.rng == null) seedNew(e);
    return out(e.rng = (e.rng + STEP) >>> 0);
  },
});
// a stream that owns its state (BF.rand.at)
function HashStream(s) { this.s = s; }
HashStream.prototype = Object.assign(Object.create(methods), {
  next() { return out(this.s = (this.s + STEP) >>> 0); },
});

let made = 0;   // entities seeded from the creation counter so far (saved, so a reload never hands out the same numbers again)
// r15-13 (stable entity ids) can key this by the entity's id instead of the counter once it has merged.
function seedNew(e) { e.rng = mix(worldSeed() ^ mix(++made + 0x632be5ab)); }
const streams = new WeakMap();
function of(e) {
  let s = streams.get(e);
  if (!s) { s = new EntityStream(e); streams.set(e, s); }
  return s;
}
function seed(e, key) { e.rng = mix(worldSeed() ^ hashStr(String(key))); return of(e); }

const kinds = new Map();
// With the tick left out (the current one), a key asked for again within the same tick gets the next stream of that key, not the same
// one again: code run more than once a tick (a test stepping the mobs by hand, two updates in one step) still sees fresh numbers. The
// first ask of a key in a tick always gets the same stream.
let repTick = -1;
const reps = new Map();
function at(kind, x, z, tick, y) {
  let k = kinds.get(kind);
  if (k === undefined) { k = hashStr(kind); kinds.set(kind, k); }
  const own = tick == null;
  if (own) tick = R.tick;
  let h = mix(worldSeed() ^ k);
  h = mix(h ^ Math.imul(Math.floor(x) | 0, 0x9e3779b1));
  h = mix(h ^ Math.imul(Math.floor(z) | 0, 0x85ebca77));
  h = mix(h ^ Math.imul(tick | 0, 0xc2b2ae3d));
  if (y != null) h = mix(h ^ Math.imul(Math.floor(y) | 0, 0x27d4eb2f));
  if (own) {
    if (repTick !== tick || reps.size > 100000) { repTick = tick; reps.clear(); }
    const n = reps.get(h) || 0;
    reps.set(h, n + 1);
    if (n) h = mix(h ^ Math.imul(n, 0x165667b1));
  }
  return new HashStream(h);
}

const R = BF.rand = {
  of, seed, at, tick: 0,
  get made() { return made; },
  step() { R.tick++; },
  save() { return { tick: R.tick, made }; },
  load(o) { R.tick = o && o.tick >= 0 ? Math.floor(o.tick) : 0; made = o && o.made >= 0 ? Math.floor(o.made) : 0; repTick = -1; reps.clear(); },
  reset() { R.tick = 0; made = 0; repTick = -1; reps.clear(); },
};
})();
