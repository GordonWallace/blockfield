// The simulation's boot (spec r15-40): the event bus, the world's lifecycle (BF.newWorld) and the tick (BF.simStep, BF.simFrame),
// shared by the page (js/main.js adds the renderer, the frame loop and the debug overlay) and the headless boot below, which runs the
// simulation with no document, canvas, WebGL or Three.js scene: in Node (tools/headless.js), and later a worker (r15-38) and the world
// server (r15-41). The sim's files, in load order, are listed in js/simfiles.js.
// API: BF.on(name, fn), BF.emit(name, ...args), BF.state, BF.newWorld(seed, opts), BF.simStep(h), BF.simFrame(raw),
//      BF.boot = { ticks(raw) (the frame loop's ticks), headless({seed, save, settings}) -> handle, stream(budgetMs), toVillage(), initSim() }
// The handle: { tick(n = 1) (n ticks of BF.warp.TICK, streaming chunks round the player as the page does each frame), seconds (game
// seconds ticked), stateHash() (js/statehash.js: {hash, parts, ...}), save() (the save data, as js/save.js stores it), settle() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

// ---------- tiny event bus ----------
const handlers = {};
BF.on = (name, fn) => (handlers[name] = handlers[name] || []).push(fn);
BF.emit = (name, ...args) => { for (const fn of handlers[name] || []) { try { fn(...args); } catch (e) { console.error(e); } } };

// Shared game state. paused: no simulation (menus, inventory open, death screen).
BF.state = { paused: false, seed: 0, time: 0 };

// ---------- world lifecycle ----------
// Starts (or restarts) a world from a seed and places the player on solid ground at the planet's spawn. Every world is the planet
// (generator 4): the flat generators 1 to 3 were retired in 1.4 (spec r14-24), so opts.gen is not read.
BF.newWorld = function (seed, opts) {
  BF.emit("worldClosing");   // the world being replaced is unloaded (js/gamelog.js logs it while its clock still reads right)
  BF.state.seed = seed >>> 0;
  BF.state.gen = 4;                                                          // worldgen version: 4 = the planet (saves keep it)
  BF.state.biomeScale = opts && opts.biomeScale >= 1 ? +opts.biomeScale : 1; // biome / climate size multiplier
  BF.state.villages = opts && opts.villages ? opts.villages | 0 : 10;        // village generator: 1 = classic (capped at 24 villagers), 2 = 2-100 villagers, 3 = 3-100 with the core trades and desert gardens, 4 = 3 + a poultry keeper and coop in villages of 8+, 5 = 4 + a cowherd and pasture in grass villages of 10+, 6 = 5 + a baker and oven per 15 villagers, 7 = 6 + pane windows and a glassmaker near sand, 8 = 7 + bee nests in trees and a beekeeper in grass villages, 9 = 8 + a pig farmer and sty in 60% of grass villages of 10+, 10 = paddocks and keepers from village size and native animals, no spawn village (default)
  BF.noise = BF.makeNoise(BF.state.seed);
  BF.rand.reset();   // seeded random streams start over with the world (js/rand.js); a save restores its own counters afterwards
  BF.mobs.clear && BF.mobs.clear();
  if (BF.gameOpts) BF.gameOpts.setAll(opts && opts.monsters);   // which monsters spawn in this world (js/gameopts.js); none given: the defaults
  BF.drops.clear();
  if (BF.boats) BF.boats.clear();
  if (BF.horses) BF.horses.reset();
  BF.world.reset();
  BF.worldgen.init(BF.noise, { biomeScale: BF.state.biomeScale, villages: BF.state.villages });
  if (BF.lod) BF.lod.reset(BF.scene);   // distant terrain on the planet (js/lod.js): fresh rings and sampling workers for this seed
  if (BF.globe) BF.globe.reset(BF.scene);   // the whole planet as a globe (js/globe.js), sampled by the same workers
  // the spawn: dry temperate / subtropical land near 35 N on face 4, away from edges and corners (r14-19)
  const [sx, sz] = BF.planetgen.spawnSearch();
  BF.spawnPoint = { x: sx + 0.5, z: sz + 0.5 };
  BF.worldSpawn = { x: sx + 0.5, z: sz + 0.5 };   // kept apart: the fallback when a spawn point or saved position is off the world (js/player.js)
  BF.player.spawn(sx + 0.5, BF.worldgen.heightAt(sx, sz) + 1.01, sz + 0.5);
  // every world starts at sunrise on day 0; loading a save restores its own time afterwards
  BF.sky.day = 0; BF.sky.setTime(0.05);
  BF.warp.reset();
  if (opts && opts.gameMode && BF.player.setGameMode) BF.player.setGameMode(opts.gameMode);
  BF.emit("newWorld", BF.state.seed);
};

// ---------- the tick ----------
// One simulation tick of h game seconds (W.TICK in the page's frame loop through simFrame below; the headless handle, harnesses and
// tests call BF.simStep).
// The BF.perf points charge each part's time to its category of the villager-seconds meter (js/perf.js); they do nothing while it's off.
const PF = BF.perf;
function simStep(h) {
  PF.beginStep();
  BF.warp.advance(h);
  BF.rand.step();   // the tick that keys world-event rolls (js/rand.js)
  BF.req.beginTick();   // think: everything below reads the start-of-tick world and asks for changes (js/requests.js, spec r15-17)
  BF.state.time += h;
  BF.sky.advance(h);   // the clock, weather and light; the sky is drawn every frame at the interpolated time
  PF.lap(PF.C.world);
  BF.mobs.update(h);   // charges its own parts (js/mobs.js update)
  PF.lap(PF.C.vanimals);   // bees (js/bees.js runs after the mobs' update)
  if (BF.dayTimeline) BF.dayTimeline.update();   // villagers' day timelines, once a game minute (js/daytimeline.js)
  PF.lap(PF.C.villagers);
  BF.drops.update(h);
  BF.boats.update(h);   // boats without the player: drift, mob passengers (the player's own boat moves in real time, js/player.js)
  if (BF.inventory.simTick) BF.inventory.simTick(h);   // furnaces
  BF.world.tickSim();   // the think hooks, then apply the requests, block ticks, deliver results (js/world.js)
  if (BF.regions) BF.regions.tick();   // mobs and drops that changed region move in the region index (js/regions.js)
  PF.lap(PF.C.world);
  PF.endStep(h);
}
BF.simStep = simStep;

// Fixed tick (spec r15-10, js/timewarp.js): the world simulation runs in ticks of exactly W.TICK (0.05 s) of game time at every
// speed, as many as the accumulator holds after a frame of `raw` real seconds (20 a second at 1x, W.speed times that when
// fast-forwarding), so behaviour is the same at any speed and frame rate. Stops early if the frame budget runs out; those ticks are
// dropped, not owed (W.done). Returns the number of ticks run. BF.simFrame runs it on its own (tests: a forced frame rate).
function simFrame(raw) {
  const W = BF.warp, plan = W.plan(raw), t0 = performance.now();
  let done = 0;
  while (done < plan.n && !W.frozen && (done === 0 || performance.now() - t0 < W.BUDGET_MS)) {   // an alert can freeze it mid-frame (js/alerts.js)
    simStep(plan.h);
    done++;
  }
  if (BF.active) BF.active.frame(performance.now() - t0, raw);   // the simulation's share of real time, for the budget (js/active.js, spec r15-34)
  return done;
}
BF.simFrame = raw => { const n = simFrame(raw); BF.warp.done(n, n * BF.warp.TICK, raw); return n; };

// ---------- headless ----------
// Chunks round the player, as the page's frame loop streams them (js/main.js frame), but with no time budget so that the same ticks
// load the same chunks (BF.world.update stops when everything wanted is loaded). Headless nothing is meshed (js/world.js buildMesh).
const stream = (budgetMs = 1e9) => { const p = BF.player.position; BF.world.update(p.x, p.z, budgetMs); };
// Loads the chunks round the player until no more are wanted (a few rounds: villages simulated beyond view distance add theirs).
function settle(max = 20) {
  let last = -1;
  for (let i = 0; i < max; i++) {
    stream();
    const n = BF.world.chunks.size;
    if (n === last && !BF.world.queueLength) return n;
    last = n;
  }
  return last;
}
// The player to the village nearest the spawn (as test/lib.js toVillage), so a run has villagers in it. Returns the village or null.
function toVillage() {
  const P = BF.planet, p = BF.player.position;
  const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
  if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  return v || null;
}
let simInited = false;
// The page's boot (js/main.js) minus everything that draws or listens to input: the sim modules' own hooks.
function initSim() {
  if (simInited) return;
  simInited = true;
  BF.runLoadHooks();   // what the page does on its load event (js/env.js BF.onLoad)
  BF.mobs.init(null);
  BF.villageSim.init();
  BF.vlog.init();
  BF.drops.init();
  BF.boats.init();
  BF.inventory.initSim();   // the recipes (no screens)
}
// settings: what the page's start screen and options give: villages, biomeScale, monsters, gameMode, viewDist (chunks, default 8),
// at ("spawn" or "village": the player moves to the nearest village before the first tick; default "spawn").
function headless(o) {
  o = o || {};
  const s = o.settings || {};
  if (!BF.page) initSim();   // in a page (its frame loop held, as test/headless.js does) js/main.js has set the modules up already
  const t0 = performance.now();
  BF.world.setViewDist(s.viewDist > 0 ? s.viewDist | 0 : 8);
  if (o.save) BF.save.restore(o.save, o.save.meta || null);
  else BF.newWorld(o.seed != null ? +o.seed : 1337, { villages: s.villages, biomeScale: s.biomeScale, monsters: s.monsters, gameMode: s.gameMode });
  const village = !o.save && s.at === "village" ? toVillage() : null;
  const chunks = settle();
  BF.glog.log("INFO", "headless", "Headless simulation booted: " + (o.save ? "a save" : "seed " + BF.state.seed) +
    (village ? ", at the village nearest the spawn" : "") + ", " + chunks + " chunks loaded in " + ((performance.now() - t0) / 1000).toFixed(1) + " s");
  const h = {
    seconds: 0, ticks: 0, village,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        stream();
        BF.simStep(BF.warp.TICK);
        h.ticks++; h.seconds = h.ticks * BF.warp.TICK;
      }
      return h;
    },
    settle,
    stateHash: () => BF.stateHash.full(),
    save: () => BF.save.snapshot(),
  };
  return h;
}
BF.boot = { ticks: simFrame, headless, stream, settle, toVillage, initSim };   // (initSim: the sim modules' hooks, once: the worker, js/simworker.js)
})();
