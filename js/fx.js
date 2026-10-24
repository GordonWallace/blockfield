// Effect events (spec r15-12): the simulation's little visual effects (a mob's puff of smoke, breeding hearts, a villager's eating
// crumbs, a builder's dust) are plain events it emits here; the render layer (js/entityview.js) takes them each frame and plays them.
// Where nothing draws (a worker or a server, specs r15-36 / r15-40) they are dropped: the queue keeps only the newest MAX.
// An event is {kind, x, y, z, ...}:
//   puff   {n, spread, dark, speed}   smoke cubes (mob deaths, explosions, trades)
//   heart  {}                         one heart rising (breeding)
//   crumbs {color, n, spread}         small bits flying out and falling (eating, farm work)
//   dust   {block}                    a builder's block dust: 5 bits of the block's colour from the cell at (x, y, z)
// API: BF.fx = { emit(e), take() -> events since the last take, clear() (a new world: drops the queue and what is playing), gen, MAX,
//   tap(fn) (fn(e) for every event emitted) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const MAX = 600;
let q = [];
const taps = [];   // fn(e) for every event emitted: the protocol's events messages (js/protocol.js, spec r15-36)

BF.fx = {
  MAX,
  emit(e) {
    for (const fn of taps) fn(e);
    q.push(e);
    if (q.length > MAX) q.splice(0, q.length - MAX);
  },
  take() { const a = q; q = []; return a; },
  gen: 0,
  tap(fn) { taps.push(fn); },
  clear() { q = []; BF.fx.gen++; },
};
})();
