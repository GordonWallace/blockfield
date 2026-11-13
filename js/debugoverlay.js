// The F3 debug overlay (moved out of js/main.js by spec r15-37, which made it read the simulation through the protocol): the numbers in
// the corner, the F3 + B / C / R planet toggles, and BF.debugInfo / BF.debugText for the second-screen feed (js/debugfeed.js). The
// page's own figures (fps, position, chunks drawn, draw calls) are read here; the simulation's come from the "f3" query.
// API: BF.debugOverlay = { update(now) (once a frame, js/main.js) }; BF.debugInfo() -> the figures; BF.debugText(info) -> the overlay's text;
//   BF.debugOn (F3 is showing)
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

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
  tallyDraws(showDebug);   // (draws are counted only while the screen is open)
  if (!showDebug) return;
  const d = debugInfo(), t = debugText(d);
  if (!d.perf || !d.perf.stale) { dbg.textContent = t; return; }
  // frozen or paused: the meter's line keeps its last figures, greyed
  const line = d.perfText, i = t.indexOf(line);
  dbg.textContent = t.slice(0, i);
  const g = document.createElement("span"); g.style.opacity = "0.45"; g.textContent = line;
  dbg.append(g, t.slice(i + line.length));
}
// The F3 numbers as data: the overlay prints them and the second-screen feed (js/debugfeed.js) sends them on. The simulation's own
// figures (mobs, villages simulated, the clock, weather, the villager-seconds meter, requests, block light) are the protocol's "f3" query
// (spec r15-37); in the page its answer comes at once, elsewhere the overlay shows the latest one.
let f3 = null, f3Asking = false;
const F3_NONE = { mobs: 0, boats: 0, sim: "", clock: "", weather: "", perf: null, perfText: "", requests: null, requestsText: "", regionText: "", workersText: "", blockLight: 0 };
// The graphics card the browser draws with (Gordon, 2026-11-13: is it the discrete GPU or the built-in one?): the unmasked WebGL renderer
// string where the browser gives it (Chrome: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Direct3D11 ...)"), else the masked one. Read once.
let gpuName = null;
function gpu() {
  if (gpuName != null) return gpuName;
  try {
    const gl = BF.renderer.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpuName = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
  } catch (e) { gpuName = ""; }
  return gpuName;
}
function debugInfo() {
  const p = BF.player.position;
  const biome = BF.worldgen.biomeAt(p.x, p.z), cc = BF.world.chunkAt(p.x, p.z);
  if (BF.client && !f3Asking) { f3Asking = true; BF.client.query("f3", { x: p.x, y: p.y, z: p.z, shown: !!BF.debugOn }, r => { f3Asking = false; if (r && r.ok) f3 = r; }); }
  const q = f3 || F3_NONE;
  return {
    fps, gpu: gpu(), draws: BF.drawTally.last, frameMs: BF.frameTimes && BF.frameTimes.last, x: p.x, y: p.y, z: p.z, yaw: BF.player.yaw,
    chunkX: Math.floor(p.x / BF.CS), chunkZ: Math.floor(p.z / BF.CS),
    sections: cc ? { lo: cc.lo, hi: cc.hi - 1, y0: cc.y0, y1: cc.y1 - 1 } : null,
    biome: biome ? biome.name : "?",
    chunksDrawn: BF.world.meshedCount(), chunksLoaded: BF.world.chunks.size, chunksQueued: BF.world.queueLength,
    mobs: q.mobs, boats: q.boats, seed: BF.state.seed, gen: BF.state.gen, biomeScale: BF.state.biomeScale, sim: q.sim,
    day: BF.sky.day + BF.sky.time, clock: q.clock, light: BF.sky.light,
    blockLight: q.blockLight, calls: BF.renderer.info.render.calls,
    weather: q.weather,
    cloudCover: BF.sky.cloudCover, cloudHeight: BF.sky.cloudHeight, warp: BF.warp.speed,
    clicks: BF.player.clickLog ? BF.player.clickLog() : [],
    perf: q.perf, perfText: q.perfText,   // villager-seconds meter (js/perf.js): null until it has been on
    requests: q.requests, requestsText: q.requestsText,   // the request queue and direct writes (js/requests.js)
    regionText: q.regionText,   // the region tick (js/regiontick.js)
    workersText: q.workersText,   // region workers (js/rplay.js, spec r15-39): in the simulation worker or on the world server
    planet: planetInfo(p),
    shared: BF.shared ? BF.shared.text : "",   // "Shared memory: on" / "...off: page not isolated" (js/world.js, r15-35)
    simMode: BF.simHost && BF.simHost.label ? BF.simHost.label() + (BF.simHost.worker || !BF.simHost.why ? "" : " (" + BF.simHost.why + ")") : "Browser (this page)",   // r15-38, r15-43
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
// "drawing 21.4, realistic look 6.2, chunks 3.0, ... (total 38.1)": the frame's steps, biggest first (js/main.js BF.frameTimes)
function frameLine(o) {
  let tot = 0;
  const rows = Object.entries(o).filter(([, v]) => (tot += v, v >= 0.05)).sort((a, b) => b[1] - a[1]);
  return rows.map(([k, v]) => k + " " + v.toFixed(1)).join(", ") + " (total " + tot.toFixed(1) + ")";
}
function debugText(d) {
  const s = d.sections, pl = d.planet;
  const n1 = v => (Math.floor(v * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `Blockfield  ${d.fps} fps\n` +
    (pl ? `Face ${pl.face}  u ${n1(pl.u)}  v ${n1(pl.v)}  y ${n1(d.y)}\n${pl.latLon}  Facing ${pl.facing}\n` + planetToggles(pl)
      : `XYZ ${d.x.toFixed(1)} / ${d.y.toFixed(1)} / ${d.z.toFixed(1)}\n`) +
    `Chunk ${pl ? Math.floor(pl.u / BF.CS) + ", " + Math.floor(pl.v / BF.CS) : d.chunkX + ", " + d.chunkZ}${s ? `  Sections ${s.lo}..${s.hi} (y ${s.y0}..${s.y1})` : ""}  Biome ${d.biome}\n` +
    `Chunks ${d.chunksDrawn} drawn / ${d.chunksLoaded} loaded, ${d.chunksQueued} queued\n` +
    `Mobs ${d.mobs}${d.boats ? `  Boats ${d.boats}` : ""}  Seed ${d.seed}  Gen ${d.gen} Biomes x${d.biomeScale}  ${d.sim}\n` +
    (d.perf ? d.perfText + "\n" : "") +
    (d.requests ? d.requestsText + "\n" : "") +
    (d.regionText ? d.regionText + "\n" : "") +
    (d.workersText ? d.workersText + "\n" : "") +
    `${d.clock}  Light ${d.light.toFixed(2)}  BL ${d.blockLight}  Calls ${d.calls}` +
    (d.weather ? "\n" + d.weather : "") +
    `\nClouds ${d.cloudCover < 0.06 ? "clear" : Math.round(d.cloudCover * 100) + "%"} at y${Math.round(d.cloudHeight)}` +
    (d.shared ? "\n" + d.shared : "") +
    (d.gpu ? "\nGPU " + d.gpu : "") +
    (d.frameMs ? "\nFrame ms: " + frameLine(d.frameMs) : "") +
    (d.draws ? "\nDraws " + drawsLine(d.draws) : "") +
    "\nSimulation: " + d.simMode +
    (d.clicks && d.clicks.length ? "\nMouse (last clicks, newest last):\n" + d.clicks.join("\n") : "");
}
// Where the page thread's frame goes (Gordon, 2026-11-13: 15 fps with the page thread at 98%): js/main.js calls start() as its frame
// begins, lap(step) after each step and end() at the end; each step's ms is averaged over a second for the "Frame ms" line.
// BF.frameTimes.last: {step: ms a frame}, frames: how many that second.
let ftAcc = {}, ftN = 0, ftT = 0, ftT0 = performance.now();
BF.frameTimes = {
  last: null, frames: 0,
  start() { ftT = performance.now(); },
  lap(k) { const t = performance.now(); ftAcc[k] = (ftAcc[k] || 0) + t - ftT; ftT = t; },
  end() {
    ftN++;
    const t = performance.now();
    if (t - ftT0 < 1000) return;
    const o = {};
    for (const k in ftAcc) o[k] = ftAcc[k] / ftN;
    BF.frameTimes.last = o; BF.frameTimes.frames = ftN;
    ftAcc = {}; ftN = 0; ftT0 = t;
  },
};
// What the frame's draw calls are (Gordon, 2026-11-13: 2,763 calls a frame, which kind?): while the F3 screen is open every draw is
// counted by what it draws, for the "Draws" line. BF.drawTally.last: {kind: draws in the last whole frame}.
const DT = (BF.drawTally = { last: null, on: false });
let dtCur = {}, dtFrame = -1, dtOrig = null;
function drawKind(o, m) {
  if (o.isSprite) return "sprites";
  const u = o.userData;
  if (u.flat) return m.isMeshStandardMaterial ? "ground" : m.userData && m.userData.realWater ? "water" : m.transparent ? "liquids" : "blocks";
  if (u.rlod) return m.isShaderMaterial ? "plant cards" : "plants";
  if (u.mobBatch) return "mobs";
  if (u.mobBlobs) return "mob shadows";
  if (u.turf) return "grass blades";
  if (u.lod || u.anchor) return "far land";
  for (let p = o.parent; p; p = p.parent) { if (p.userData.mob) return "mob extras"; if (p.userData.anchor) return "far land"; }
  return o.isPoints ? "points" : o.isLine ? "lines" : "other";
}
function tallyDraws(on) {
  const R = BF.renderer;
  if (!R || on === DT.on) return;
  DT.on = on;
  if (!on) { if (dtOrig) R.renderBufferDirect = dtOrig; dtOrig = null; DT.last = null; return; }
  dtOrig = R.renderBufferDirect;
  R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    const f = R.info.render.frame;
    if (f !== dtFrame) { if (dtFrame >= 0) DT.last = dtCur; dtCur = {}; dtFrame = f; }
    const k = drawKind(object, material);
    dtCur[k] = (dtCur[k] || 0) + 1;
    return dtOrig.call(this, camera, scene, geometry, material, object, group);
  };
}
// "2763: ground 310, blocks 290, mobs 410, ..." biggest first
function drawsLine(o) {
  let tot = 0;
  const rows = Object.entries(o).sort((a, b) => b[1] - a[1]);
  for (const [, v] of rows) tot += v;
  return tot + ": " + rows.map(([k, v]) => k + " " + v).join(", ");
}
BF.debugInfo = debugInfo;
BF.debugText = debugText;

BF.debugOverlay = { update: updateDebug };
})();
