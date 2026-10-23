// Boot, render loop, shared event bus and debug overlay.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// ---------- tiny event bus ----------
const handlers = {};
BF.on = (name, fn) => (handlers[name] = handlers[name] || []).push(fn);
BF.emit = (name, ...args) => { for (const fn of handlers[name] || []) { try { fn(...args); } catch (e) { console.error(e); } } };

// Shared game state. paused: no simulation (menus, inventory open, death screen).
BF.state = { paused: false, seed: 0, time: 0 };

// ---------- renderer ----------
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 1000);
scene.add(camera); // so modules can attach view-model meshes (held item) to the camera
BF.renderer = renderer; BF.scene = scene; BF.camera = camera;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

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
  if (BF.lod) BF.lod.reset(scene);   // distant terrain on the planet (js/lod.js): fresh rings and sampling workers for this seed
  if (BF.globe) BF.globe.reset(scene);   // the whole planet as a globe (js/globe.js), sampled by the same workers
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

// The planet's rivers and lakes are worked out for the whole planet before its world starts (js/planetrivers.js, spec r14-10): several
// seconds, once per seed per session. prepareWorld(seed) runs that in slices behind a loading screen with progress and resolves
// when it's done; newWorld then finds the network ready. newWorld on its own still works (it solves the network in one go, as tests do).
BF.prepareWorld = function (seed) {
  BF.state.gen = 4;
  BF.worldgen.init(BF.makeNoise(seed >>> 0), { villages: BF.state.villages || 10 });
  if (BF.worldgen.riversReady()) return Promise.resolve();
  const el = document.createElement("div");
  el.id = "bf-loading";
  el.style.cssText = "position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
    "background:#0e1310;color:var(--ink);font:13px var(--mono)";
  el.innerHTML = '<div style="font:18px var(--display);color:var(--accent)">Blockfield</div><div class="t">Working out the rivers and lakes</div>' +
    '<div style="width:260px;height:8px;border:1px solid var(--panel-edge);border-radius:2px"><div class="b" style="height:100%;width:0;background:var(--accent)"></div></div>';
  document.body.appendChild(el);
  BF.preparing = true;   // the frame loop waits (the old world is gone: worldgen is the planet's now)
  const bar = el.querySelector(".b"), t = el.querySelector(".t");
  const show = f => { bar.style.width = Math.round(f * 100) + "%"; t.textContent = "Working out the rivers and lakes · " + Math.round(f * 100) + "%"; };
  // the terrain at the network's nodes (the slow first part) in a few workers at once where the page may start them (served over
  // http, as run.sh does; a page opened as a file can't), else here in slices with the rest
  return riverWorkers(seed, show).then(pre => new Promise(resolve => {
    let first = pre;
    const step = () => {
      const t0 = performance.now();
      let f = 0;
      do { f = BF.worldgen.solveRivers(first); first = null; } while (f < 1 && performance.now() - t0 < 60);
      show(pre ? 0.4 + 0.6 * f : f);
      if (f < 1) setTimeout(step, 0);
      else { el.remove(); BF.preparing = false; resolve(); }
    };
    setTimeout(step, 30);
  }));
};
function riverWorkers(seed, show) {
  const K = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1)), NN = 6 * BF.planetRivers.M * BF.planetRivers.M;
  if (typeof Worker === "undefined" || !/^https?:$/.test(location.protocol)) return Promise.resolve(null);
  return new Promise(resolve => {
    const pre = BF.planetRivers.newSamples(), workers = [];
    let left = K, done = 0, failed = false;
    const finish = ok => { workers.forEach(w => w.terminate()); resolve(ok ? pre : null); };
    for (let k = 0; k < K; k++) {
      let w;
      try { w = new Worker(BF.workerUrl("js/riverworker.js")); } catch (e) { failed = true; break; }
      workers.push(w);
      const from = Math.floor(NN * k / K), to = Math.floor(NN * (k + 1) / K);
      w.onmessage = ev => {
        const r = ev.data;
        for (const a of ["e", "p", "sea", "rain"]) pre[a].set(r[a].subarray(r.from, r.to), r.from);
        done += r.to - r.from; show(0.4 * done / NN);
        if (--left === 0) finish(true);
      };
      w.onerror = ev => { console.warn("river worker failed, working the rivers out here instead", ev.message); if (!failed) { failed = true; finish(false); } };
      w.postMessage({ seed: seed >>> 0, villages: BF.state.villages || 10, from, to });
    }
    if (failed) finish(false);
  });
}

// ---------- debug overlay (F3) ----------
const dbg = document.getElementById("debug");
let showDebug = false;
// F3 shows or hides it when released. Held with B, C or R on the planet it flips a planet debug toggle instead (js/view.js setDebug,
// spec r14-21): B face tints, C the open corner wedge (no round drawing near the cube corners), R the true sphere everywhere.
let f3Held = false, f3Combo = false;
const F3_COMBO = { KeyB: "tints", KeyC: "wedge", KeyR: "sphere" };
addEventListener("keydown", e => {
  if (e.code === "F3") { e.preventDefault(); if (!e.repeat) { f3Held = true; f3Combo = false; } return; }
  const k = f3Held && F3_COMBO[e.code];
  if (!k || !BF.view) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat) return;
  f3Combo = true;
  const on = BF.view.setDebug({ [k]: !BF.view.debug[k] })[k];
  if (BF.player.actionBar) BF.player.actionBar(PLANET_TOGGLE[k] + (on ? ": on" : ": off"));
}, true);
addEventListener("keyup", e => {
  if (e.code !== "F3") return;
  e.preventDefault();
  if (f3Held && !f3Combo) { showDebug = !showDebug; dbg.hidden = !showDebug; BF.debugOn = showDebug; }
  f3Held = false;
});
addEventListener("blur", () => { f3Held = false; });
const PLANET_TOGGLE = { tints: "Face tints", wedge: "Open corner wedge", sphere: "True sphere everywhere" };
let frames = 0, fpsT = performance.now(), fps = 0;
let screenWas = false;
function updateDebug(now) {
  frames++;
  const scr = !!(BF.player.screenOpen && BF.player.screenOpen());
  if (scr !== screenWas) { screenWas = scr; document.body.classList.toggle("bf-screen-open", scr); }
  if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
  if (!showDebug) return;
  const d = debugInfo(), t = debugText(d);
  if (!d.perf || !d.perf.stale) { dbg.textContent = t; return; }
  // frozen or paused: the meter's line keeps its last figures, greyed
  const line = BF.perf.text(d.perf), i = t.indexOf(line);
  dbg.textContent = t.slice(0, i);
  const g = document.createElement("span"); g.style.opacity = "0.45"; g.textContent = line;
  dbg.append(g, t.slice(i + line.length));
}
// The F3 numbers as data: the overlay prints them and the second-screen feed (js/debugfeed.js) sends them on.
function debugInfo() {
  const p = BF.player.position;
  const biome = BF.worldgen.biomeAt(p.x, p.z), cc = BF.world.chunkAt(p.x, p.z);
  return {
    fps, x: p.x, y: p.y, z: p.z, yaw: BF.player.yaw,
    chunkX: Math.floor(p.x / BF.CS), chunkZ: Math.floor(p.z / BF.CS),
    sections: cc ? { lo: cc.lo, hi: cc.hi - 1, y0: cc.y0, y1: cc.y1 - 1 } : null,
    biome: biome ? biome.name : "?",
    chunksDrawn: BF.world.meshedCount(), chunksLoaded: BF.world.chunks.size, chunksQueued: BF.world.queueLength,
    mobs: BF.mobs.list.length, boats: BF.boats ? BF.boats.list.length : 0, seed: BF.state.seed, gen: BF.state.gen, biomeScale: BF.state.biomeScale, sim: BF.villageSim.status(),
    day: BF.sky.day + BF.sky.time, clock: BF.vlog.stamp(BF.sky.day + BF.sky.time), light: BF.sky.light,
    blockLight: BF.world.getBlockLight(p.x, p.y + 0.05, p.z), calls: renderer.info.render.calls,
    weather: BF.weather && BF.weather.debugText ? BF.weather.debugText() : "",
    cloudCover: BF.sky.cloudCover, cloudHeight: BF.sky.cloudHeight, warp: BF.warp.speed,
    clicks: BF.player.clickLog ? BF.player.clickLog() : [],
    perf: BF.perf.stats(),   // villager-seconds meter (js/perf.js): null until it has been on
    planet: planetInfo(p),
  };
}
// The canonical face, grid position, latitude / longitude and compass facing (spec r14-18); atlas
// x / z stay internal. Null off the atlas.
function planetInfo(p) {
  const C = BF.coords, c = C && C.here();
  if (!c) return null;
  const ll = BF.planet.latLonAt(p.x, p.z, {});
  return { face: c.f, u: c.u, v: c.v, lat: ll.lat, lon: ll.lon, latLon: C.latLonText(p.x, p.z), facing: C.facing(BF.player.yaw, p.x, p.z),
    debug: BF.view && BF.view.debug ? { ...BF.view.debug } : null };
}
// "Planet debug: face tints, true sphere" when any F3 + B / C / R toggle is on
const planetToggles = pl => { const on = pl.debug ? Object.keys(PLANET_TOGGLE).filter(k => pl.debug[k]) : []; return on.length ? "Planet debug: " + on.map(k => PLANET_TOGGLE[k].toLowerCase()).join(", ") + "\n" : ""; };
function debugText(d) {
  const s = d.sections, pl = d.planet;
  const n1 = v => (Math.floor(v * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `Blockfield  ${d.fps} fps\n` +
    (pl ? `Face ${pl.face}  u ${n1(pl.u)}  v ${n1(pl.v)}  y ${n1(d.y)}\n${pl.latLon}  Facing ${pl.facing}\n` + planetToggles(pl)
      : `XYZ ${d.x.toFixed(1)} / ${d.y.toFixed(1)} / ${d.z.toFixed(1)}\n`) +
    `Chunk ${pl ? Math.floor(pl.u / BF.CS) + ", " + Math.floor(pl.v / BF.CS) : d.chunkX + ", " + d.chunkZ}${s ? `  Sections ${s.lo}..${s.hi} (y ${s.y0}..${s.y1})` : ""}  Biome ${d.biome}\n` +
    `Chunks ${d.chunksDrawn} drawn / ${d.chunksLoaded} loaded, ${d.chunksQueued} queued\n` +
    `Mobs ${d.mobs}${d.boats ? `  Boats ${d.boats}` : ""}  Seed ${d.seed}  Gen ${d.gen} Biomes x${d.biomeScale}  ${d.sim}\n` +
    (d.perf ? BF.perf.text(d.perf) + "\n" : "") +
    `${d.clock}  Light ${d.light.toFixed(2)}  BL ${d.blockLight}  Calls ${d.calls}` +
    (d.weather ? "\n" + d.weather : "") +
    `\nClouds ${d.cloudCover < 0.06 ? "clear" : Math.round(d.cloudCover * 100) + "%"} at y${Math.round(d.cloudHeight)}` +
    (d.clicks && d.clicks.length ? "\nMouse (last clicks, newest last):\n" + d.clicks.join("\n") : "");
}
BF.debugInfo = debugInfo;
BF.debugText = debugText;

// ---------- loop ----------
// One simulation tick of h game seconds (W.TICK in the frame loop, simFrame below; harnesses and tests call BF.simStep).
// The BF.perf points charge each part's time to its category of the villager-seconds meter (js/perf.js); they do nothing while it's off.
const PF = BF.perf;
function simStep(h) {
  PF.beginStep();
  BF.warp.advance(h);
  BF.rand.step();   // the tick that keys world-event rolls (js/rand.js)
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
  BF.world.tickSim();
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
  return done;
}
BF.simFrame = raw => { const n = simFrame(raw); BF.warp.done(n, n * BF.warp.TICK, raw); return n; };
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (BF.preparing) { last = now; return; }
  const raw = Math.max(0, (now - last) / 1000), dt = Math.min(0.05, raw);   // the player's step; the sim's accumulator takes up to 0.25 s (js/timewarp.js)
  last = now;
  const p = BF.player.position;
  PF.frame();
  PF.mark();
  BF.world.update(p.x, p.z, BF.warp.speed >= 10 ? 3 : BF.player.turbo ? 14 : 8);   // turbo flight streams terrain harder; fast-forward leaves the frame to the sim
  PF.lap(PF.C.stream);   // chunk streaming and remeshing, once a frame
  if (BF.lod) BF.lod.update();   // distant terrain rings on the planet (js/lod.js)
  const W = BF.warp, drawn0 = W.renderNow();
  if (!BF.state.paused) {
    const done = simFrame(raw);
    // the player stays in real time (movement, physics, mining, hunger, air): one step per frame, whatever the speed
    BF.player.update(dt);
    W.done(done, done * W.TICK, raw);
  } else if (BF.player.updatePaused) {
    BF.player.updatePaused(dt);
  }
  // drawing between the last two ticks (r15-10): the sky at the interpolated game time, entities at lerp(prev, cur, alpha)
  const alpha = W.alpha, drawnDt = Math.max(0, W.renderNow() - drawn0);
  BF.sky.draw(alpha, drawnDt);
  BF.mobs.draw(alpha);   // arrows (the mobs are drawn by BF.mobView.render below)
  BF.drops.draw(alpha);
  BF.boats.draw(alpha);
  if (BF.horses && !BF.state.paused) BF.horses.drawLeads();   // lead ropes follow the player and the horses (as drawn) every frame
  BF.inventory.update && BF.inventory.update(dt);
  if (BF.mapview) BF.mapview.tick();   // auto-filling maps generate a few ms per frame
  BF.world.setDaylight(BF.sky.light);
  if (BF.textures.update) BF.textures.update(W.frozen ? 0 : BF.state.paused ? dt : drawnDt);   // water animation runs on the drawn game time (fast-forward included, stopped at 0x)
  if (BF.save && !BF.state.paused) BF.save.update(dt);
  BF.mobView.render(BF.state.paused || W.frozen ? 0 : dt * Math.max(1, Math.min(10, W.last)));   // the mobs' models from their simulation state (js/mobview.js)
  BF.view.begin(scene, camera);   // floating origin and unfolded faces on the planet (js/view.js)
  if (BF.lod && BF.lod.cull) BF.lod.cull(camera);   // the distant rings' sectors in view (js/lod.js)
  renderer.render(scene, camera);
  BF.view.end();
  updateDebug(now);
  BF.vlog.update(dt, showDebug);
  if (BF.villagerHover) BF.villagerHover.update(dt);
  if (BF.stateHash) BF.stateHash.update();   // the game log's state hash as each game day starts (js/statehash.js)
  if (BF.debugFeed) BF.debugFeed.update();
}

// ---------- boot ----------
BF.sky.init(scene);
BF.world.init(scene);
BF.mobs.init(scene);
BF.villageSim.init();
BF.vlog.init();
BF.drops.init(scene);
BF.boats.init(scene);
BF.player.init();
BF.inventory.init();
let seed = 1337;
// The boot world (behind the title screen) is a planet, seed 1337 or #seed<n> (spec r14-19); #seed<n>v9 has village generator 9. The
// old "gen4" in a test hash (#seed123gen4v10) is still accepted and changes nothing; the flat generators' gen1 to gen3 are gone (r14-24),
// so such a hash is not read and the default world boots.
const m = /^#seed(\d+)(?:gen4)?(?:v(\d+))?$/.exec(location.hash);
if (m) seed = +m[1];
const startOpts = m && m[2] ? { villages: +m[2] } : {};
BF.prepareWorld(seed).then(() => { BF.newWorld(seed, startOpts); requestAnimationFrame(frame); });   // (rivers first)
})();
