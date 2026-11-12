// Blockfield 1.6, the realistic look: the switch, the lights, the shared uniforms and the lit-material patch
// (docs/REALISTIC_CONTRACT.md sections 1 to 3). Drawing only. With the look off (the default, and always headless) this file
// only defines BF.real with on = false and nothing else in the game changes.
(() => {
"use strict";
const G = globalThis;
const BF = (G.BF = G.BF || {});
const T = G.THREE;

function wanted() {
  if (typeof document === "undefined" || !T) return false;
  let v = null;
  try { v = new URLSearchParams(location.search).get("look"); } catch (_) { /* none */ }
  try {
    if (v === "real" || v === "blocks") localStorage.setItem("bf.look", v);
    else v = localStorage.getItem("bf.look");
  } catch (_) { /* no storage */ }
  return v === "real";
}

const real = (BF.real = BF.real || {});
real.on = wanted();
real.quality = { level: 2, shadows: false, auto: true };
real.modules = [];
real.module = m => { real.modules.push(m); return m; };
real.assets = { species: [], cover: [], ground: [], rocks: [] };
real.flora = real.flora || { place() {}, remove() {} };
real.water = real.water || null;
real.splash = real.splash || (() => {});
// How a flora record sits on the smooth ground (js/real/mesh.js writes it into the record's `extra`, contract section 4):
// out[0] how far the ground under the plant is above the record's y, out[1] and out[2] its rise per block along x and z.
real.seat = (extra, out) => {
  const s = Math.floor(extra / 256), d = s & 63, tx = (s >> 6) & 31, tz = (s >> 11) & 31;
  out[0] = d ? (d - 32) / 31 : 0; out[1] = tx ? (tx - 16) / 15 : 0; out[2] = tz ? (tz - 16) / 15 : 0;
  return out;
};
if (!T) return;

// ---------- shared uniforms and the air ----------
const V3 = () => ({ value: new T.Vector3() });
const U = (real.U = {
  uSunDir: { value: new T.Vector3(0.4, 0.8, 0.3).normalize() }, uSunCol: V3(), uSkyCol: V3(), uGroundCol: V3(), uFogCol: V3(),
  uFogNear: { value: 50 }, uFogFar: { value: 100 }, uTime: { value: 0 }, uWind: { value: new T.Vector3(1, 0, 0.3) }, uWet: { value: 0 },
  uDay: { value: 1 }, uEye: V3(),
});

const atmos = (BF.atmos = BF.atmos || {});
Object.assign(atmos, {
  sunDir: new T.Vector3(0.4, 0.8, 0.3).normalize(), sunColor: new T.Color(1, 0.96, 0.88), sunIntensity: 2.2,
  skyColor: new T.Color(0.55, 0.7, 1), groundColor: new T.Color(0.32, 0.28, 0.2), hemiIntensity: 0.9,
  fogColor: new T.Color(0.7, 0.8, 0.95), fogNear: 50, fogFar: 100, dayness: 1, wetness: 0,
  wind: { x: 1, z: 0.3, strength: 0.3 }, flash: 0,
});
// Plain day and night from js/sky.js, until the atmosphere module replaces this function.
const DAY_SUN = new T.Color(1, 0.95, 0.86), LOW_SUN = new T.Color(1, 0.55, 0.3), MOON = new T.Color(0.45, 0.55, 0.8);
atmos.update = atmos.update || function () {
  const sky = BF.sky; if (!sky) return;
  const a = sky.time * Math.PI * 2, yaw = sky.sunYaw || 0.35;
  let x = Math.cos(a), y = Math.sin(a);
  const night = y < 0; if (night) { x = -x; y = -y; }
  y = Math.max(y, 0.08);
  atmos.sunDir.set(x * Math.cos(yaw), y, -x * Math.sin(yaw)).normalize();
  const h = Math.min(1, Math.abs(Math.sin(a)) * 2.5), day = sky.light != null ? sky.light : 1;
  atmos.dayness = night ? 0 : h;
  if (night) { atmos.sunColor.copy(MOON); atmos.sunIntensity = 0.25 * h; }
  else { atmos.sunColor.copy(LOW_SUN).lerp(DAY_SUN, h); atmos.sunIntensity = 2.4 * h * (0.4 + 0.6 * day); }
  atmos.hemiIntensity = 0.12 + 0.85 * day;
  const f = real.scene && real.scene.fog;
  if (f) { atmos.fogColor.copy(f.color); atmos.fogNear = f.near; atmos.fogFar = f.far; atmos.skyColor.copy(f.color).lerp(new T.Color(0.45, 0.62, 1), 0.5); }
};

// ---------- setup and the frame ----------
real.setup = function (renderer, scene, camera) {
  if (!real.on) return;
  real.renderer = renderer; real.scene = scene; real.camera = camera;
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !!real.quality.shadows;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const sun = new T.DirectionalLight(0xffffff, 2), hemi = new T.HemisphereLight(0xffffff, 0x444444, 0.9);
  for (const l of [sun, hemi]) { l.userData.renderSpace = true; l.matrixAutoUpdate = true; scene.add(l); }
  real.lights = { sun, hemi };
};
real.start = function () {   // after the sky exists (js/main.js)
  if (!real.on) return;
  const ctx = { THREE: T, renderer: real.renderer, scene: real.scene, camera: real.camera, U, atmos, lights: real.lights, quality: real.quality };
  for (const m of real.modules) {
    try { if (m.init) m.init(ctx); } catch (e) { console.error("BF.real module " + m.name + " init failed", e); m.dead = true; }
  }
};
let clock = 0, slow = 0;
real.frame = function (dt) {
  if (!real.on) return;
  clock = (clock + dt) % 3600;
  atmos.update(dt, clock);
  const L = real.lights;
  L.sun.position.copy(atmos.sunDir).multiplyScalar(200); L.sun.updateMatrix();
  L.sun.color.copy(atmos.sunColor); L.sun.intensity = atmos.sunIntensity * (1 + 4 * atmos.flash);
  L.hemi.color.copy(atmos.skyColor); L.hemi.groundColor.copy(atmos.groundColor); L.hemi.intensity = atmos.hemiIntensity;
  const f = real.scene.fog;
  if (f) { f.color.copy(atmos.fogColor); if (f.near !== undefined) { f.near = atmos.fogNear; f.far = atmos.fogFar; } }
  U.uSunDir.value.copy(atmos.sunDir);
  U.uSunCol.value.set(atmos.sunColor.r, atmos.sunColor.g, atmos.sunColor.b).multiplyScalar(atmos.sunIntensity);
  U.uSkyCol.value.set(atmos.skyColor.r, atmos.skyColor.g, atmos.skyColor.b).multiplyScalar(atmos.hemiIntensity);
  U.uGroundCol.value.set(atmos.groundColor.r, atmos.groundColor.g, atmos.groundColor.b).multiplyScalar(atmos.hemiIntensity);
  U.uFogCol.value.set(atmos.fogColor.r, atmos.fogColor.g, atmos.fogColor.b);
  U.uFogNear.value = atmos.fogNear; U.uFogFar.value = atmos.fogFar;
  U.uTime.value = clock; U.uWet.value = atmos.wetness;
  U.uWind.value.set(atmos.wind.x, atmos.wind.z, atmos.wind.strength);
  if (BF.world && BF.world.dayUniform) U.uDay.value = BF.world.dayUniform.value;
  const p = BF.player && BF.player.position;
  if (p) U.uEye.value.set(((p.x % 4096) + 4096) % 4096, p.y, ((p.z % 4096) + 4096) % 4096);
  for (const m of real.modules) {
    if (m.dead || !m.frame) continue;
    try { m.frame(dt, clock); } catch (e) { console.error("BF.real module " + m.name + " frame failed", e); m.dead = true; }
  }
  // quality: drop a level after two seconds of slow frames (never raised again in a session)
  if (dt > 1 / 28) slow += dt; else slow = Math.max(0, slow - dt * 0.5);
  if (real.quality.auto && slow > 2 && real.quality.level > 0) { real.quality.level--; slow = 0; }
};

// Sky and block light of the cell at an atlas position, as lit() expects it: out.x sky 0..1, out.y block 0..1.
real.cellLight = function (x, y, z, out) {
  out = out || new T.Vector2();
  const w = BF.world;
  let s = 1, b = 0;
  try {
    const SL = BF.skyLight;
    if (SL && SL.get) { const l = SL.get(Math.floor(x), Math.floor(y), Math.floor(z)); s = SL.bright ? SL.bright(l) : SL.BRIGHT ? SL.BRIGHT[l] : l / 15; }
    if (w && w.getBlockLight) b = w.getBlockLight(Math.floor(x), Math.floor(y), Math.floor(z)) / 15;
  } catch (_) { /* not loaded: open sky */ }
  return out.set(s, b);
};

// ---------- the lit-material patch ----------
// Makes a three.js lit material (Standard or Phong: r128's Lambert lights per vertex and has no hook) agree with Blockfield's light: sun and sky light are scaled by how much
// open sky reaches the surface, block light (torches) is added as a warm term the sun doesn't touch. opts: light "vertex" | "cell" |
// "open", round (a chunk mesh bent to the planet: js/world.js adds uK and sphM itself), wind (foliage sway).
real.lit = function (mat, opts) {
  opts = opts || {};
  const mode = opts.light || "open";
  if (mode === "cell") mat.userData.cell = { value: new T.Vector2(1, 0) };
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    if (inner) inner.call(mat, sh, r);
    sh.uniforms.uDay = U.uDay; sh.uniforms.uTime = U.uTime; sh.uniforms.uWind = U.uWind;
    if (mode === "cell") sh.uniforms.uCell = mat.userData.cell;
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    if (mode === "vertex") {
      vs = "attribute float skyl;\nattribute float bl;\nvarying vec2 vBFL;\n" + vs.replace("#include <begin_vertex>", "#include <begin_vertex>\nvBFL = vec2(skyl, bl);");
      fs = "varying vec2 vBFL;\n" + fs;
    } else if (mode === "cell") fs = "uniform vec2 uCell;\n#define vBFL uCell\n" + fs;
    else fs = "#define vBFL vec2(1.0, 0.0)\n" + fs;
    if (opts.wind) {
      vs = "uniform float uTime;\nuniform vec3 uWind;\nattribute float sway;\n" + vs.replace("#include <begin_vertex>", `#include <begin_vertex>
{
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  #endif
  float ph = wp.x * 0.35 + wp.z * 0.27;
  float g = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.9 + ph * 2.3) * 0.25 + sin(uTime * 7.0 + ph * 5.0 + transformed.y) * 0.1;
  transformed.xz += uWind.xy * (uWind.z * sway * g * 0.35);
}`);
    }
    // sky visibility scales everything the sky gives; block light is added after the lights are summed
    fs = fs.replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
{
  float bfSky = clamp(vBFL.x, 0.0, 1.0); bfSky = max(0.06, bfSky * (0.6 + 0.4 * smoothstep(0.3, 0.7, bfSky)));
  reflectedLight.directDiffuse *= bfSky; reflectedLight.directSpecular *= bfSky;
  reflectedLight.indirectDiffuse *= bfSky; reflectedLight.indirectSpecular *= bfSky;
  #ifdef ALPHATEST
    // leaves and grass blades (alpha-tested cards with bent normals): the sun's highlight on them burnt out to white patches
    reflectedLight.directSpecular *= 0.06;
  #endif
  float bfB = min(1.0, 1.1 * pow(clamp(vBFL.y, 0.0, 1.0), 1.25));
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.72, 0.42) * bfB * 0.9;
}`);
    sh.vertexShader = vs; sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => "bfreal:" + mode + ":" + (opts.wind ? 1 : 0) + ":" + (opts.key || "");
  return mat;
};
})();
