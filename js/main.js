// The page's boot: renderer and frame loop (the F3 debug overlay is js/debugoverlay.js). The event bus, BF.newWorld and the simulation tick are in js/boot.js,
// which the headless boot shares (spec r15-40). With the simulation in a Web Worker (js/simhost.js, spec r15-38)
// the frame loop runs no ticks: it draws the page's copy of the world, moves the player and keeps the page's clock for drawing.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

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

// ---------- loop ----------
const PF = BF.perf, simFrame = BF.boot.ticks, host = BF.simHost;   // the simulation's ticks for a frame (js/boot.js); its host (js/simhost.js)
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
  const W = BF.warp, drawn0 = W.renderNow(), remote = host.worker;
  if (!BF.state.paused) {
    const done = remote ? host.ticks(raw) : simFrame(raw);   // (in the worker: the page only keeps time for drawing)
    // the player stays in real time (movement, physics, mining, hunger, air): one step per frame, whatever the speed
    BF.player.update(dt);
    W.done(done, done * W.TICK, raw, remote ? host.achieved() : undefined);
  } else if (BF.player.updatePaused) {
    BF.player.updatePaused(dt);
  }
  host.frame();   // the player and the speed to the worker (js/simhost.js)
  if (BF.proto) BF.proto.flush();   // the frame's changes to the client's mirror: chunks, blocks, entities, clock (js/protocol.js, r15-36)
  // drawing between the last two ticks (r15-10): the sky at the interpolated game time, entities at lerp(prev, cur, alpha)
  const alpha = W.alpha, drawnDt = Math.max(0, W.renderNow() - drawn0);
  if (remote) host.sky(W.frozen ? 0 : drawnDt);   // the worker's clock and weather
  BF.sky.draw(alpha, drawnDt);
  BF.inventory.update && BF.inventory.update(dt);
  if (BF.mapview) BF.mapview.tick();   // auto-filling maps generate a few ms per frame
  BF.world.setDaylight(BF.sky.light);
  if (BF.textures.update) BF.textures.update(W.frozen ? 0 : BF.state.paused ? dt : drawnDt);   // water animation runs on the drawn game time (fast-forward included, stopped at 0x)
  if (BF.save && !BF.state.paused && !remote) BF.save.update(dt);   // (the worker autosaves itself)
  BF.mobView.render(BF.state.paused || W.frozen ? 0 : dt * Math.max(1, Math.min(10, W.last)));   // the mobs' models from their simulation state (js/mobview.js)
  BF.entityView.render(BF.state.paused || W.frozen ? 0 : drawnDt, dt);   // drops, arrows, boats, bees, leads and effects at BF.warp.alpha (js/entityview.js)
  BF.view.begin(scene, camera);   // floating origin and unfolded faces on the planet (js/view.js)
  if (BF.lod && BF.lod.cull) BF.lod.cull(camera);   // the distant rings' sectors in view (js/lod.js)
  renderer.render(scene, camera);
  BF.view.end();
  BF.debugOverlay.update(now);   // F3 (js/debugoverlay.js)
  BF.vlog.update();
  if (BF.villagePanel) BF.villagePanel.update(dt, !!BF.debugOn);   // F3: names over villagers and the village panel, from the protocol (js/villagepanel.js)
  if (BF.villagerHover) BF.villagerHover.update(dt);
  if (BF.stateHash && !remote) BF.stateHash.update();   // the game log's state hash as each game day starts (js/statehash.js; the worker logs its own)
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
BF.entityView.init(scene);
BF.player.init();
BF.inventory.init();
let seed = 1337;
// The boot world (behind the title screen) is a planet, seed 1337 or #seed<n> (spec r14-19); #seed<n>v9 has village generator 9. The
// old "gen4" in a test hash (#seed123gen4v10) is still accepted and changes nothing; the flat generators' gen1 to gen3 are gone (r14-24),
// so such a hash is not read and the default world boots.
const m = /^#seed(\d+)(?:gen4)?(?:v(\d+))?$/.exec(location.hash);
if (m) seed = +m[1];
const startOpts = m && m[2] ? { villages: +m[2] } : {};
// The simulation in a Web Worker where wanted and possible (js/simhost.js, spec r15-38), else here: the simulation and the client joined in
// the page (js/protocol.js, spec r15-36). Then the boot world, rivers first; with the worker, the page keeps its own copy of it.
host.start().then(mode => {
  if (mode !== "worker" && BF.proto) BF.proto.local.connect();
  BF.prepareWorld(seed).then(() => { BF.newWorld(seed, startOpts); if (mode === "worker") host.demo(seed, startOpts); requestAnimationFrame(frame); });
});
})();
