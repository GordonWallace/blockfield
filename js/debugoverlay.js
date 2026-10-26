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
const F3_NONE = { mobs: 0, boats: 0, sim: "", clock: "", weather: "", perf: null, perfText: "", requests: null, requestsText: "", regionText: "", wakeText: "", workersText: "", blockLight: 0 };
function debugInfo() {
  const p = BF.player.position;
  const biome = BF.worldgen.biomeAt(p.x, p.z), cc = BF.world.chunkAt(p.x, p.z);
  if (BF.client && !f3Asking) { f3Asking = true; BF.client.query("f3", { x: p.x, y: p.y, z: p.z, shown: !!BF.debugOn }, r => { f3Asking = false; if (r && r.ok) f3 = r; }); }
  const q = f3 || F3_NONE;
  return {
    fps, x: p.x, y: p.y, z: p.z, yaw: BF.player.yaw,
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
    wakeText: q.wakeText,   // resting animals (js/mobs.js, spec r15-63)
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
    (d.wakeText ? d.wakeText + "\n" : "") +
    (d.workersText ? d.workersText + "\n" : "") +
    `${d.clock}  Light ${d.light.toFixed(2)}  BL ${d.blockLight}  Calls ${d.calls}` +
    (d.weather ? "\n" + d.weather : "") +
    `\nClouds ${d.cloudCover < 0.06 ? "clear" : Math.round(d.cloudCover * 100) + "%"} at y${Math.round(d.cloudHeight)}` +
    (d.shared ? "\n" + d.shared : "") +
    "\nSimulation: " + d.simMode +
    (d.clicks && d.clicks.length ? "\nMouse (last clicks, newest last):\n" + d.clicks.join("\n") : "");
}
BF.debugInfo = debugInfo;
BF.debugText = debugText;

BF.debugOverlay = { update: updateDebug };
})();
