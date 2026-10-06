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
// Starts (or restarts) a world from a seed and places the player on solid ground near the origin.
BF.newWorld = function (seed, opts) {
  BF.state.seed = seed >>> 0;
  BF.state.gen = opts && opts.gen ? opts.gen | 0 : 3;                       // worldgen version: 1 = classic, 2 = continents, 3 = mile-high (default)
  BF.state.biomeScale = opts && opts.biomeScale >= 1 ? +opts.biomeScale : 1; // biome / climate size multiplier (gen 2 and 3)
  BF.noise = BF.makeNoise(BF.state.seed);
  BF.mobs.clear && BF.mobs.clear();
  BF.drops.clear();
  BF.world.reset();
  BF.worldgen.init(BF.noise, { gen: BF.state.gen, biomeScale: BF.state.biomeScale });
  // pick a dry spawn column near the origin
  let sx = 8, sz = 8;
  for (let r = 0; r < 400; r += 8) {
    const a = r * 0.7, x = Math.round(Math.cos(a) * r) + 8, z = Math.round(Math.sin(a) * r) + 8;
    if (BF.worldgen.heightAt(x, z) > BF.SEA + 1 && BF.worldgen.heightAt(x, z) > BF.worldgen.waterLevelAt(x, z)) { sx = x; sz = z; break; }
  }
  // (worldgen's findSpawn() mirrors the search above; keep them in sync.)
  BF.spawnPoint = { x: sx + 0.5, z: sz + 0.5 };
  BF.player.spawn(sx + 0.5, BF.worldgen.heightAt(sx, sz) + 1.01, sz + 0.5);
  // every world starts at sunrise on day 0; loading a save restores its own time afterwards
  BF.sky.day = 0; BF.sky.setTime(0.05);
  BF.warp.reset();
  if (opts && opts.gameMode && BF.player.setGameMode) BF.player.setGameMode(opts.gameMode);
  BF.emit("newWorld", BF.state.seed);
};

// ---------- debug overlay (F3) ----------
const dbg = document.getElementById("debug");
let showDebug = false;
addEventListener("keydown", e => { if (e.code === "F3") { e.preventDefault(); showDebug = !showDebug; dbg.hidden = !showDebug; BF.debugOn = showDebug; } });
let frames = 0, fpsT = performance.now(), fps = 0;
function updateDebug(now) {
  frames++;
  if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
  if (!showDebug) return;
  const p = BF.player.position;
  const biome = BF.worldgen.biomeAt(p.x, p.z), cc = BF.world.chunkAt(p.x, p.z);
  dbg.textContent =
    `Blockfield  ${fps} fps\n` +
    `XYZ ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}\n` +
    `Chunk ${Math.floor(p.x / BF.CS)}, ${Math.floor(p.z / BF.CS)}${cc ? `  Sections ${cc.lo}..${cc.hi - 1} (y ${cc.y0}..${cc.y1 - 1})` : ""}  Biome ${biome ? biome.name : "?"}\n` +
    `Chunks ${BF.world.meshedCount()} drawn / ${BF.world.chunks.size} loaded, ${BF.world.queueLength} queued\n` +
    `Mobs ${BF.mobs.list.length}  Seed ${BF.state.seed}  Gen ${BF.state.gen} Biomes x${BF.state.biomeScale}  ${BF.villageSim.status()}\n` +
    `${BF.vlog.stamp(BF.sky.day + BF.sky.time)}  Light ${BF.sky.light.toFixed(2)}  BL ${BF.world.getBlockLight(p.x, p.y + 0.05, p.z)}  Calls ${renderer.info.render.calls}` +
    (BF.weather && BF.weather.debugText ? "\n" + BF.weather.debugText() : "") +
    `\nClouds ${BF.sky.cloudCover < 0.06 ? "clear" : Math.round(BF.sky.cloudCover * 100) + "%"} at y${Math.round(BF.sky.cloudHeight)}`;
}

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  const p = BF.player.position;
  BF.world.update(p.x, p.z, BF.warp.speed >= 10 ? 3 : BF.player.turbo ? 14 : 8);   // turbo flight streams terrain harder; fast-forward leaves the frame to the sim
  const W = BF.warp;
  if (!BF.state.paused) {
    // Fast-forward (F, js/timewarp.js): run the world simulation W.speed times per frame with the normal step, so
    // behaviour at 10x matches 1x exactly and it plays like a sped-up recording. From 100x the step grows (up to 0.05 s, the
    // same step a slow frame already gets) so the step count stays bounded. Stops early if the frame budget runs out.
    const plan = W.plan(dt), t0 = performance.now();
    let done = 0;
    while (done < plan.n && (done === 0 || performance.now() - t0 < W.BUDGET_MS)) {
      const h = plan.h;
      W.advance(h);
      BF.state.time += h;
      BF.sky.update(h);
      BF.mobs.update(h);
      BF.drops.update(h);
      BF.world.tickSim();
      done++;
    }
    // the player stays in real time (movement, physics, mining, hunger, air): one step per frame, whatever the speed
    BF.player.update(dt);
    W.done(done, done * plan.h, dt);
  } else if (BF.player.updatePaused) {
    BF.player.updatePaused(dt);
  }
  BF.inventory.update && BF.inventory.update(dt);
  if (BF.mapview) BF.mapview.tick();   // auto-filling maps generate a few ms per frame
  BF.world.setDaylight(BF.sky.light);
  if (BF.textures.update) BF.textures.update(dt * Math.max(1, W.last));   // water animation keeps pace with the fast-forward
  if (BF.save && !BF.state.paused) BF.save.update(dt);
  renderer.render(scene, camera);
  updateDebug(now);
  BF.vlog.update(dt, showDebug);
}

// ---------- boot ----------
BF.sky.init(scene);
BF.world.init(scene);
BF.mobs.init(scene);
BF.villageSim.init();
BF.vlog.init();
BF.drops.init(scene);
BF.player.init();
BF.inventory.init();
let seed = 1337;
const m = /^#seed(\d+)(?:gen(\d))?$/.exec(location.hash);   // e.g. #seed1337gen2 starts a legacy-generator world
if (m) seed = +m[1];
BF.newWorld(seed, m && m[2] ? { gen: +m[2] } : undefined);
requestAnimationFrame(frame);
})();
