// Blockfield 1.6, the realistic look: js/real/atmos.js. Owner: the Atmosphere and creatures thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
//
// The air of the realistic look, drawn from the same clock and weather the pixel sky uses. js/sky.js still owns the time of day,
// sky.light, cloud cover / height and the fog distances, and js/weather.js the spells, the rain and the bolt. With the look on,
// sky.js hands each drawn frame's sky state to BF.atmos.sky(...) and this module
//   - hides the pixel dome, the square sun and moon, the point stars and the slab clouds, and draws one dome instead: a graded sky
//     with haze at the horizon, a sun disc with glow, a moon with phases, round stars and a milky band, and two layers of soft
//     noise clouds (cumulus at sky.cloudHeight, cirrus far above) lit from the sun or the moon;
//   - owns the values of BF.atmos (contract section 3): BF.atmos.update(dt, t) works out the light of the scene for that moment,
//     and js/real/core.js copies it into the lights, the fog and the shared uniforms;
//   - drifts dust motes in sunlight and fireflies on warm nights, and thickens the haze at dawn, in rain and inside a cloud.
//
// BF.atmos fields beyond the contract's: moonDir (towards the moon), trueSunDir (towards the sun, also at night), sunHeight (sin of
// the sun's elevation), dusk (0..1, peaks at sunrise and sunset), cover (cloud cover), rain, thunder (the weather levels drawn),
// mist (0..1 extra haze), moonFull (0 new .. 1 full), dome (the sky mesh), sky(t, day, dt, sunDir, dayness, space) (js/sky.js paint).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;

const V3 = (x, y, z) => new THREE.Vector3(x, y, z), COL = (r, g, b) => new THREE.Color(r, g, b);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------- palette (linear colours; the renderer tone-maps) ----------
const ZEN_DAY = COL(0.10, 0.27, 0.62), ZEN_NIGHT = COL(0.0035, 0.007, 0.018), ZEN_DUSK = COL(0.07, 0.11, 0.30);
const HOR_DAY = COL(0.48, 0.64, 0.86), HOR_NIGHT = COL(0.012, 0.02, 0.045), HOR_DUSK = COL(0.86, 0.50, 0.27);
const SUN_NOON = COL(1.0, 0.94, 0.84), SUN_LOW = COL(1.0, 0.42, 0.16), MOON_LIGHT = COL(0.50, 0.64, 1.0);
const GLOW_LOW = COL(1.0, 0.36, 0.10), GLOW_HIGH = COL(1.0, 0.72, 0.45);
const HEMI_SKY_DAY = COL(0.77, 0.85, 0.94), HEMI_SKY_NIGHT = COL(0.34, 0.44, 0.74);
const HEMI_GND_DAY = COL(0.23, 0.23, 0.13), HEMI_GND_NIGHT = COL(0.11, 0.13, 0.19);
const CLOUD_LIT_DAY = COL(1.08, 1.06, 1.02), CLOUD_LIT_NIGHT = COL(0.05, 0.065, 0.11), CLOUD_LIT_DUSK = COL(1.15, 0.58, 0.34);
const CLOUD_DARK_DAY = COL(0.56, 0.62, 0.73), CLOUD_DARK_NIGHT = COL(0.012, 0.016, 0.03), CLOUD_DARK_DUSK = COL(0.30, 0.25, 0.36);
const SPACE = COL(0.001, 0.0015, 0.004);
const SUN_MAX = 1.7, HEMI_MAX = 0.6, MOON_MAX = 0.55;
const CLOUD_SCALE = 0.006;       // noise units per block: the first octave's cells are about 170 blocks
const SKY_R = 420;

const tmpC = new THREE.Color();

const atmos = BF.atmos;   // made by js/real/core.js with the contract's fields; the values are ours
Object.assign(atmos, {
  moonDir: V3(0, -1, 0), trueSunDir: V3(0, 1, 0), sunHeight: 1, dusk: 0, cover: 0, rain: 0, thunder: 0, mist: 0, moonFull: 1, dome: null,
});

// ---------- the dome ----------
const NOISE = `
  float h2(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float h3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return s; }
  float fbm3(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ s += a * vn(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return s; }
`;
let scene = null, dome = null, U = null, old = null;
function makeDome() {
  U = {
    uSun: { value: V3(0, 1, 0) }, uMoon: { value: V3(0, -1, 0) }, uLight: { value: V3(0, 1, 0) },
    uZen: { value: COL(0, 0, 0) }, uHor: { value: COL(0, 0, 0) }, uHaze: { value: COL(0, 0, 0) },
    uSunCol: { value: COL(1, 1, 1) }, uGlow: { value: COL(1, 1, 1) }, uMoonCol: { value: COL(1, 1, 1) },
    uCloudLit: { value: COL(1, 1, 1) }, uCloudDark: { value: COL(0.5, 0.5, 0.5) },
    uSunVis: { value: 1 }, uMoonVis: { value: 0 }, uStars: { value: 0 }, uDusk: { value: 0 }, uPhase: { value: Math.PI },
    uCover: { value: 0 }, uOver: { value: 0 }, uCloudH: { value: 150 }, uBase: { value: new THREE.Vector2() }, uHigh: { value: new THREE.Vector2() },
    uCel: { value: new THREE.Matrix3() }, uTime: { value: 0 }, uSpace: { value: 0 }, uFlash: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uSun, uMoon, uLight, uZen, uHor, uHaze, uSunCol, uGlow, uMoonCol, uCloudLit, uCloudDark;
      uniform float uSunVis, uMoonVis, uStars, uDusk, uPhase, uCover, uOver, uCloudH, uTime, uSpace, uFlash;
      uniform vec2 uBase, uHigh; uniform mat3 uCel;
      varying vec3 vDir;
      ${NOISE}
      float stars(vec3 d){
        vec3 p = d * 80.0, ip = floor(p), fp = fract(p) - 0.5;
        float h = h3(ip);
        if (h < 0.982) return 0.0;
        vec3 o = (vec3(h3(ip + 1.3), h3(ip + 2.7), h3(ip + 4.1)) - 0.5) * 0.6;
        float b = (h - 0.982) / 0.018, tw = 0.75 + 0.25 * sin(uTime * (1.5 + 4.0 * b) + h * 900.0);
        return smoothstep(0.13, 0.0, length(fp - o)) * (0.25 + 0.75 * b * b) * tw;
      }
      void main(){
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0), sd = max(dot(d, uSun), 0.0), md = dot(d, uMoon);
        // the graded sky: zenith to horizon, a pale band of haze low down, the fog colour at and below the horizon
        vec3 col = mix(uHor, uZen, pow(h, 0.5));
        // dusk and dawn: warm light round the sun low down, a pink band opposite it
        float low = 1.0 - smoothstep(0.0, 0.5, h);
        col += uGlow * uDusk * (pow(sd, 3.0) * 0.55 * low + pow(sd, 24.0) * 0.5);
        col = mix(col, vec3(0.62, 0.36, 0.44) * (0.25 + length(uHor)), uDusk * 0.22 * pow(max(-dot(d.xz, normalize(uSun.xz + 1e-4)), 0.0), 2.0) * smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.12, 0.4, h)));
        // stars and the milky band turn with the sky
        if (uStars > 0.01 && d.y > -0.05) {
          vec3 sdir = uCel * d;
          float band = exp(-pow(sdir.y * 3.2 + 0.3 * sin(sdir.x * 3.0), 2.0));
          vec3 st = vec3(0.85, 0.9, 1.0) * stars(sdir) * 1.6 + vec3(0.018, 0.022, 0.035) * band * (0.4 + fbm3(sdir.xz * 7.0 + sdir.y * 3.0));
          col += st * uStars * smoothstep(-0.02, 0.2, d.y);
        }
        // the sun: wide scatter, tight halo, disc
        col += uSunCol * uSunVis * (pow(sd, 6.0) * 0.10 + pow(sd, 60.0) * 0.22 + pow(sd, 900.0) * 1.2);
        float disc = smoothstep(0.99955, 0.99975, sd) * uSunVis;
        // the moon: a lit sphere with dark seas, at phase uPhase (pi = full)
        float moonA = 0.0; vec3 moonC = vec3(0.0);
        if (md > 0.99 && uMoonVis > 0.0) {
          vec3 mx = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0))), my = cross(mx, uMoon);
          vec2 q = vec2(dot(d, mx), dot(d, my)) / 0.036;
          float r2 = dot(q, q);
          if (r2 < 1.0) {
            vec3 n = vec3(q, sqrt(1.0 - r2));
            float lit = smoothstep(-0.08, 0.2, dot(n, vec3(sin(uPhase), 0.0, -cos(uPhase))));
            float seas = mix(0.5, 1.0, smoothstep(0.38, 0.62, fbm3(q * 2.2 + 7.0)));
            moonC = uMoonCol * seas * (0.03 + 0.97 * lit) * (0.55 + 0.45 * n.z);
            moonA = smoothstep(1.0, 0.9, r2) * uMoonVis;
          }
          col += uMoonCol * 0.04 * uMoonVis * smoothstep(0.99, 1.0, md);
        }
        col = mix(col, moonC, moonA);
        // haze: towards the fog colour near the horizon, the fog colour below it (so far land fades into the sky)
        col = mix(uHaze, col, smoothstep(-0.02, 0.22, d.y) * 0.9 + 0.1 * smoothstep(0.0, 0.6, d.y));
        // clouds: the ray meets a flat layer uCloudH above (or below) the camera
        float dy = d.y * sign(uCloudH), ld = max(dot(d, uLight), 0.0);
        if (dy > 0.012) {
          // cirrus, six times higher: thin streaks
          float th = abs(uCloudH) * 6.0 / (dy + 0.1) + 900.0;
          vec2 hv = uHigh + d.xz * th * ${(CLOUD_SCALE * 0.22).toFixed(6)};
          float ci = fbm3(vec2(hv.x * 0.45, hv.y * 2.2) + 0.6 * fbm3(hv * 0.7));
          float ca = smoothstep(0.52, 0.85, ci) * (0.10 + 0.45 * uCover) * exp(-th * 0.00012) * smoothstep(0.012, 0.12, dy) * (1.0 - uOver) * step(0.0, uCloudH);
          col = mix(col, mix(uCloudDark, uCloudLit, 0.8) + uSunCol * uSunVis * pow(sd, 8.0) * 0.2, ca);
          if (uCover > 0.02) {
            float t = abs(uCloudH) / (dy + 0.1);   // (+0.1: the layer curves down towards the horizon, so far clouds don't stretch into streaks)
            vec2 uv = uBase + d.xz * t * ${CLOUD_SCALE.toFixed(6)};
            float n = fbm(uv) + 0.2 * (fbm3(uv * 3.7 + 11.0) - 0.5);
            float thr = mix(0.80, 0.30, uCover);
            float cov = max(smoothstep(thr, thr + 0.2, n), uOver * 0.94);
            float lit = clamp((n - fbm3(uv + uLight.xz * 0.16)) * 2.6 + 0.5, 0.0, 1.0);
            lit = mix(lit, clamp(0.1 + 1.1 * (n - 0.25), 0.0, 1.0), uOver);          // an overcast deck is lit from above, evenly
            lit = mix(lit, 1.0 - lit * 0.6, step(uCloudH, 0.0) * 0.5);   // from above: tops in full light
            vec3 cc = mix(uCloudDark, uCloudLit, lit);
            cc += uSunCol * uSunVis * pow(sd, 10.0) * 0.35 * (1.0 - cov * 0.6);   // silver lining towards the sun
            cc += vec3(0.75, 0.8, 1.0) * uFlash * (0.5 + n);
            float far = exp(-t * 0.00042);
            cc = mix(uHaze, cc, far);
            col = mix(col, cc, cov * 0.93 * smoothstep(0.012, 0.07, dy) * smoothstep(1.0, 10.0, abs(uCloudH)));
            disc *= 1.0 - cov * 0.92;
          }
        }
        col += uSunCol * disc * 14.0;
        col = mix(col, vec3(0.001, 0.0015, 0.004) + vec3(0.9, 0.95, 1.0) * stars(uCel * d) * 1.5 + uSunCol * (pow(sd, 900.0) * 1.2 + disc * 14.0), uSpace);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 32, 16), mat);
  dome.renderOrder = -1000; dome.frustumCulled = false;
  return dome;
}

// ---------- air: dust in sunlight, fireflies, mist ----------
// One Points cloud each, wrapped in a box that follows the camera; positions are kept relative to the object, which sits on a
// whole-block grid near the camera (floating origin: small numbers anywhere on the planet).
function softTex() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.35, "rgba(255,255,255,0.45)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function makeSwarm(n, box, size, color, glow) {
  const arr = new Float32Array(n * 3), seed = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = (Math.random() - 0.5) * box[0]; arr[i * 3 + 1] = (Math.random() - 0.5) * box[1]; arr[i * 3 + 2] = (Math.random() - 0.5) * box[2];
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("seed", new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: softTex() }, uCol: { value: color.clone() }, uA: { value: 0 }, uSize: { value: size }, uTime: { value: 0 }, uBlink: { value: glow ? 1 : 0 }, uPx: { value: 600 } },
    vertexShader: `attribute vec4 seed; uniform float uSize, uTime, uBlink, uPx; varying float vA;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        // a firefly glows in slow pulses, each on its own beat; dust just shimmers
        float pulse = mix(0.7 + 0.3 * sin(uTime * 2.0 + seed.x * 40.0), pow(max(sin(uTime * (0.7 + seed.y) + seed.x * 40.0), 0.0), 6.0), uBlink);
        vA = pulse * smoothstep(0.4, 1.5, d) * (1.0 - smoothstep(${(box[0] * 0.35).toFixed(1)}, ${(box[0] * 0.5).toFixed(1)}, d));
        gl_PointSize = uSize * (0.6 + 0.8 * seed.z) * uPx / max(d, 0.3);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D uMap; uniform vec3 uCol; uniform float uA; varying float vA;
      void main(){
        float a = texture2D(uMap, gl_PointCoord).a * vA * uA;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uCol * a, a);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
    transparent: true, depthWrite: false, fog: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false; p.renderOrder = 9; p.visible = false;
  p.userData.box = box; p.userData.seed = seed;
  return p;
}
function stepSwarm(p, cam, dt, time, level, move) {
  const u = p.material.uniforms;
  u.uA.value += (level - u.uA.value) * Math.min(1, dt * 0.8);
  p.visible = u.uA.value > 0.01;
  if (!p.visible) return;
  u.uTime.value = time;
  u.uPx.value = BF.renderer ? BF.renderer.domElement.height / (2 * Math.tan((cam.fov || 75) * Math.PI / 360)) : 600;
  // the object stays on a whole-block grid near the camera; when it steps, the points step back, so they stay put in the world
  const gx = Math.round(cam.position.x), gy = Math.round(cam.position.y), gz = Math.round(cam.position.z);
  const sx = gx - p.position.x, sy = gy - p.position.y, sz = gz - p.position.z;
  const jump = Math.abs(sx) + Math.abs(sy) + Math.abs(sz) > 64;
  p.position.set(gx, gy, gz);
  const a = p.geometry.attributes.position, arr = a.array, seed = p.userData.seed, box = p.userData.box, n = arr.length / 3;
  const cx = cam.position.x - gx, cy = cam.position.y - gy, cz = cam.position.z - gz;
  for (let i = 0; i < n; i++) {
    const j = i * 3, k = i * 4;
    if (!jump) { arr[j] -= sx; arr[j + 1] -= sy; arr[j + 2] -= sz; }
    move(arr, j, seed, k, dt, time);
    let d = arr[j] - cx; if (d > box[0] / 2) arr[j] -= box[0]; else if (d < -box[0] / 2) arr[j] += box[0];
    d = arr[j + 1] - cy; if (d > box[1] / 2) arr[j + 1] -= box[1]; else if (d < -box[1] / 2) arr[j + 1] += box[1];
    d = arr[j + 2] - cz; if (d > box[2] / 2) arr[j + 2] -= box[2]; else if (d < -box[2] / 2) arr[j + 2] += box[2];
  }
  a.needsUpdate = true;
}
let motes = null, flies = null, airTime = 0, probeT = 0, grassy = 0, warm = 1, covered = false;
// what kind of place the camera is in, a few times a second: grassy and warm enough for fireflies, under a roof or underground
function probePlace(cam) {
  const x = cam.position.x, z = cam.position.z;
  try {
    const b = BF.worldgen && BF.worldgen.biomeAt ? BF.worldgen.biomeAt(Math.floor(x), Math.floor(z)) : null, n = (b && b.name) || "";
    grassy = /Plains|Meadow|Forest|Birch|Savanna|Swamp|Jungle|Cherry|Taiga|Mangrove/i.test(n) && !/Snowy|Ice|Frozen/i.test(n) ? 1 : 0;
    warm = b && typeof b.temperature === "number" ? smooth(-0.05, 0.25, b.temperature) : 1;
    const top = BF.world && BF.world.heightAt ? BF.world.heightAt(x, z) : -1e9;
    covered = top > cam.position.y + 0.5;
  } catch (_) { /* before the world exists */ }
}

// ---------- rain splashes ----------
// Small rings where drops land, on the column tops of js/weather.js's height map (BF.atmos.rainMap, set while it rains). All on the
// GPU: each quad lives 0.4 s at a spot hashed from its seed and the count of lives so far. Positions are relative to the mesh,
// which sits on a whole-block grid near the camera (floating origin).
const SPLASH_N = 420, SPLASH_R = 13;
let splash = null;
function makeSplash() {
  const seed = new Float32Array(SPLASH_N * 4 * 3), corner = new Float32Array(SPLASH_N * 4 * 2), index = new Uint16Array(SPLASH_N * 6);
  const C = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < SPLASH_N; i++) {
    const a = Math.random(), b = Math.random(), c = (i + Math.random()) / SPLASH_N;
    for (let v = 0; v < 4; v++) {
      const o = (i * 4 + v);
      seed[o * 3] = a; seed[o * 3 + 1] = b; seed[o * 3 + 2] = c;
      corner[o * 2] = C[v * 2]; corner[o * 2 + 1] = C[v * 2 + 1];
    }
    const q = i * 4, o = i * 6;
    index[o] = q; index[o + 1] = q + 2; index[o + 2] = q + 1; index[o + 3] = q; index[o + 4] = q + 3; index[o + 5] = q + 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPLASH_N * 4 * 3), 3));   // unused (the shader places them)
  g.setAttribute("seed", new THREE.BufferAttribute(seed, 3));
  g.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uHeight: { value: null }, uOrigin: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() },
      uMinY: { value: 0 }, uSize: { value: 64 }, uCol: { value: COL(1, 1, 1) } },
    vertexShader: `attribute vec3 seed; attribute vec2 corner;
      uniform float uTime, uIntensity, uMinY, uSize; uniform sampler2D uHeight; uniform vec2 uOrigin; uniform vec3 uCam;
      varying vec2 vUv; varying float vA;
      float h2(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
      void main(){
        float life = uTime / 0.4 + seed.z * 97.0, k = floor(life), ph = fract(life);
        vec2 r = vec2(h2(vec2(seed.x * 91.0, k)), h2(vec2(seed.y * 57.0, k + 3.0)));
        // nearer spots are likelier: most of what the eye sees is close by
        vec2 off = (r * 2.0 - 1.0); off *= abs(off) * ${SPLASH_R.toFixed(1)};
        vec2 xz = uCam.xz + off;
        vec4 h = texture2D(uHeight, (floor(xz) - uOrigin + 0.5) / uSize);
        float top = floor(h.r * 255.0 + 0.5) + 256.0 * floor(h.b * 255.0 + 0.5) + uMinY, kind = floor(h.g * 255.0 + 0.5);
        if (kind < 0.5 || kind > 1.5 || seed.z > uIntensity || top > uCam.y + 6.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vUv = vec2(0.0); return; }
        float size = 0.04 + 0.2 * ph;
        vec3 p = vec3(xz.x + corner.x * size, top + 0.03, xz.y + corner.y * size);
        vUv = corner;
        vA = (1.0 - ph) * (1.0 - ph) * (1.0 - smoothstep(${(SPLASH_R * 0.6).toFixed(1)}, ${SPLASH_R.toFixed(1)}, length(off)));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform vec3 uCol; varying vec2 vUv; varying float vA;
      void main(){
        float r = length(vUv), a = smoothstep(0.5, 0.78, r) * (1.0 - smoothstep(0.86, 1.0, r)) * vA * 0.55;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uCol, a);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  splash = new THREE.Mesh(g, mat);
  splash.frustumCulled = false; splash.renderOrder = 6; splash.visible = false;
  return splash;
}
function stepSplash(cam, real, rain, under) {
  const m = atmos.rainMap;
  splash.visible = !!m && rain > 0.02 && !under;
  if (!splash.visible) return;
  const u = splash.material.uniforms, gx = Math.floor(cam.position.x / 32) * 32, gz = Math.floor(cam.position.z / 32) * 32;
  splash.position.set(gx, 0, gz);
  u.uTime.value = (u.uTime.value + real) % 600;
  u.uIntensity.value = rain;
  u.uHeight.value = m.tex; u.uSize.value = m.size;
  u.uOrigin.value.set(m.ox - gx, m.oz - gz);
  u.uCam.value.set(cam.position.x - gx, cam.position.y, cam.position.z - gz);
  u.uMinY.value = BF.MIN_Y;
  const l = 0.25 + 0.75 * atmos.dayness;
  u.uCol.value.setRGB(0.85 * l, 0.9 * l, 1.0 * l);
}

// ---------- the frame ----------
// js/sky.js paint leaves the sky state of the frame it drew here (one guarded line there); update() then runs from core.js.
const F = { t: 0.25, day: 0, dt: 0, sun: V3(0, 1, 0), dayness: 1, space: 0, seen: false };
atmos.sky = function (t, day, dt, sunDir, dayness, space) {
  F.t = t; F.day = day; F.dt += Math.max(0, dt || 0); F.sun.copy(sunDir); F.dayness = dayness; F.space = space || 0; F.seen = true;
};
const drift = new THREE.Vector2(), driftHigh = new THREE.Vector2(), cel = new THREE.Matrix4(), celE = new THREE.Euler(0, 0, 0, "YZX");
function init(ctx) {
  scene = ctx.scene;
  scene.add(makeDome());
  atmos.dome = dome;
  motes = makeSwarm(260, [18, 9, 18], 0.02, COL(1.0, 0.93, 0.78), false);
  flies = makeSwarm(70, [26, 6, 26], 0.11, COL(0.75, 1.0, 0.25), true);
  scene.add(motes, flies, makeSplash());
  old = atmos.old || null;   // the pixel sky's parts (js/sky.js init)
  // the dome follows the camera every frame, also while paused (as the pixel dome does)
  if (BF.view && BF.view.onBegin) BF.view.onBegin(() => { if (BF.camera && dome) dome.position.copy(BF.camera.position); });
}
atmos.update = function (real) {
  if (!dome) return;
  const cam = BF.camera, sky = BF.sky, W = BF.weather, f = F;
  const wr = W ? W.intensity || 0 : 0, wt = W ? W.thunder || 0 : 0, wf = W ? W.flash || 0 : 0;
  real = Math.min(0.1, Math.max(0, real || 0));
  const dt = f.dt, d = f.dayness, space = f.space; f.dt = 0;
  const sun = atmos.trueSunDir.copy(f.sun).normalize(), moon = atmos.moonDir.copy(sun).negate(), sh = sun.y;
  const dusk = Math.exp(-(sh * sh) / 0.03);
  if (old) for (const o of old) if (o && o.visible) o.visible = false;
  dome.position.copy(cam.position);

  // the moon's phase: full on the first night, a cycle of 8 days
  const phase = Math.PI * 2 * ((((f.day + f.t - 0.75) / 8 + 0.5) % 1 + 1) % 1), full = (1 - Math.cos(phase)) / 2;
  atmos.moonFull = full;

  // light: the sun by its height, the moon by night; one directional light, its intensity through zero as they swap
  const sunUp = smooth(-0.04, 0.25, sh), moonUp = smooth(0.04, 0.3, -sh);
  const clear = 1 - 0.88 * wr, dim = 1 - 0.25 * wr - 0.2 * wt;
  if (sh > -0.04) {
    atmos.sunDir.copy(sun);
    atmos.sunColor.copy(SUN_LOW).lerp(SUN_NOON, smooth(0.0, 0.4, sh));
    atmos.sunIntensity = SUN_MAX * sunUp * clear;
  } else {
    atmos.sunDir.copy(moon);
    atmos.sunColor.copy(MOON_LIGHT);
    atmos.sunIntensity = MOON_MAX * (0.25 + 0.75 * full) * moonUp * clear;
  }
  if (atmos.sunDir.y < 0.06) { atmos.sunDir.y = 0.06; atmos.sunDir.normalize(); }   // never from below the ground
  atmos.skyColor.copy(HEMI_SKY_NIGHT).lerp(HEMI_SKY_DAY, d).lerp(tmpC.copy(HOR_DUSK).lerp(HEMI_SKY_DAY, 0.5), dusk * 0.35 * d);
  atmos.groundColor.copy(HEMI_GND_NIGHT).lerp(HEMI_GND_DAY, d);
  if (wr > 0) { const g = 0.5 * (0.2 + 0.8 * d); atmos.skyColor.lerp(tmpC.setRGB(g * 0.92, g * 0.97, g * 1.05), wr * 0.8); }
  atmos.hemiIntensity = HEMI_MAX * (0.32 + 0.68 * d) * dim * (1 + 0.6 * wr * d) + wf * 2.2;   // overcast: less sun, more sky
  if (wf > 0) atmos.skyColor.lerp(tmpC.setRGB(0.8, 0.86, 1), Math.min(1, wf));

  // sky colours
  // (the game's light stays up for an hour and a half after sunset; the sky itself darkens sooner than the ground)
  const sd = d * (0.45 + 0.55 * smooth(-0.3, 0.05, sh));
  const zen = U.uZen.value.copy(ZEN_NIGHT).lerp(ZEN_DAY, sd).lerp(ZEN_DUSK, dusk * 0.6 * (0.3 + 0.7 * d));
  const hor = U.uHor.value.copy(HOR_NIGHT).lerp(HOR_DAY, sd).lerp(HOR_DUSK, dusk * 0.7 * (0.25 + 0.75 * d));
  const wg = (0.40 - 0.2 * wt) * (0.035 + 0.965 * d);   // overcast grey
  if (wr > 0) { zen.lerp(tmpC.setRGB(wg * 0.82, wg * 0.87, wg * 0.96), wr * 0.92); hor.lerp(tmpC.setRGB(wg * 1.12, wg * 1.15, wg * 1.2), wr * 0.9); }
  if (wf > 0) { zen.lerp(tmpC.setRGB(0.6, 0.66, 0.85), wf * 0.5); hor.lerp(tmpC.setRGB(0.75, 0.8, 0.95), wf * 0.6); }
  if (space > 0) { zen.lerp(SPACE, space); hor.lerp(SPACE, space * 0.85); }
  // the haze at the horizon is the fog colour: a touch paler than the horizon by day
  const fog = atmos.fogColor.copy(hor).lerp(tmpC.setRGB(0.80, 0.88, 0.96).multiplyScalar(d), 0.18 * (1 - wr));
  U.uSun.value.copy(sun); U.uMoon.value.copy(moon); U.uLight.value.copy(atmos.sunDir);
  U.uSunCol.value.copy(SUN_LOW).lerp(SUN_NOON, smooth(0.0, 0.4, sh));
  U.uGlow.value.copy(GLOW_LOW).lerp(GLOW_HIGH, smooth(0.0, 0.25, Math.abs(sh)));
  U.uMoonCol.value.setRGB(0.95, 0.97, 1.0).multiplyScalar(0.35 + 0.9 * (1 - d));
  U.uSunVis.value = smooth(-0.08, 0.02, sh) * (1 - wr);
  U.uMoonVis.value = (0.3 + 0.7 * smooth(-0.02, 0.15, -sh)) * (1 - wr) * (sh < 0.3 ? 1 : 0);
  U.uStars.value = (1 - smooth(0.05, 0.45, d)) * (1 - wr);
  U.uDusk.value = dusk * (1 - wr) * (0.25 + 0.75 * d) * (1 - space);
  U.uPhase.value = phase; U.uSpace.value = space; U.uFlash.value = wf;
  U.uTime.value = (U.uTime.value + real) % 3600;

  // clouds: sky.js's cover and height; the layer drifts east with the wind (js/sky.js: 1.2 blocks a second)
  const cover = sky.cloudCover || 0, cloudY = sky.cloudHeight || 200;
  U.uCover.value = cover * (1 - space); U.uOver.value = smooth(0.35, 1, wr);
  const ch = cloudY - cam.position.y;
  U.uCloudH.value = Math.abs(ch) < 0.5 ? 0.5 : ch;
  const yaw = sky.sunYaw != null ? sky.sunYaw - 0.35 : 0, ex = Math.cos(yaw), ez = -Math.sin(yaw);
  const gust = 0.5 + 0.5 * Math.sin(airTime * 0.13) * Math.sin(airTime * 0.047 + 2);
  const speed = 1.2 * (1 + 1.5 * wr + 1.5 * wt);
  drift.x -= ex * dt * speed * CLOUD_SCALE; drift.y -= ez * dt * speed * CLOUD_SCALE;
  driftHigh.x -= ex * dt * 2.5 * CLOUD_SCALE * 0.22; driftHigh.y -= ez * dt * 2.5 * CLOUD_SCALE * 0.22;
  const wrap = v => ((v % 4096) + 4096) % 4096;
  U.uBase.value.set(wrap(cam.position.x * CLOUD_SCALE + drift.x), wrap(cam.position.z * CLOUD_SCALE + drift.y));
  U.uHigh.value.set(wrap(cam.position.x * CLOUD_SCALE * 0.22 + driftHigh.x), wrap(cam.position.z * CLOUD_SCALE * 0.22 + driftHigh.y));
  cloudCol(U.uCloudLit.value, CLOUD_LIT_NIGHT, CLOUD_LIT_DAY, CLOUD_LIT_DUSK, sd, dusk, wg * 1.3, wr, full);
  cloudCol(U.uCloudDark.value, CLOUD_DARK_NIGHT, CLOUD_DARK_DAY, CLOUD_DARK_DUSK, sd, dusk, wg * 0.62, wr, full * 0.3);

  // the stars turn with the sun's path (about the same axis as js/sky.js's celestial group)
  celE.set(0, sky.sunYaw != null ? sky.sunYaw : 0.35, f.t * Math.PI * 2, "YZX");
  U.uCel.value.setFromMatrix4(cel.makeRotationFromEuler(celE).invert());

  // weather for the others
  atmos.dayness = d; atmos.sunHeight = sh; atmos.dusk = dusk; atmos.cover = cover; atmos.rain = wr; atmos.thunder = wt; atmos.flash = wf;
  atmos.wetness = clamp01(atmos.wetness + (wr > 0.3 ? dt / 40 : -dt / 240));
  const ws = clamp01(0.15 + 0.25 * gust + 0.45 * wr + 0.3 * wt);
  atmos.wind.strength = ws; atmos.wind.x = ex * (0.6 + 5 * ws); atmos.wind.z = ez * (0.6 + 5 * ws);

  // mist: at dawn, in rain, and inside the cloud layer
  const dawn = Math.exp(-Math.pow((((f.t + 0.5) % 1) - 0.5) / 0.045, 2)) * (0.35 + 0.4 * cover);
  const inCloud = cover * (1 - smooth(2, 14, Math.abs(ch)));
  atmos.mist = clamp01(Math.max(dawn * (1 - space), 0.5 * wr, inCloud));

  // fog: the distances js/sky.js set this frame, pulled in by the mist; under water its colour too
  const under = !!(BF.player && BF.player.headInWater && !BF.player.detached), sf = scene.fog;
  if (inCloud > 0) fog.lerp(tmpC.copy(U.uCloudDark.value).lerp(U.uCloudLit.value, 0.6), inCloud);
  if (under) fog.copy(sf.color);
  U.uHaze.value.copy(fog);
  if (scene.background && scene.background.isColor) scene.background.copy(fog);
  if (f.seen && sf) {
    const m = under ? 0 : atmos.mist;
    atmos.fogNear = sf.near * (1 - 0.9 * m); atmos.fogFar = Math.max(atmos.fogNear + 8, sf.far * (1 - 0.45 * m) * (1 - 0.9 * inCloud) + 24 * inCloud);
    f.seen = false;   // (a frame sky.js didn't paint keeps the last distances: core.js writes them back into the fog)
  }

  // air
  airTime += real;
  probeT -= real;
  if (probeT <= 0) { probeT = 0.5; probePlace(cam); }
  stepSplash(cam, BF.state && BF.state.paused ? 0 : real, wr, under);
  const open = covered || under ? 0 : 1, step = BF.state && BF.state.paused ? 0 : real;
  stepSwarm(motes, cam, step, airTime, open * sunUp * clear * (1 - space) * 0.12, (a, j, s, k, h, tm) => {
    const ph = s[k + 3] * 6.28 + tm * 0.5;
    a[j] += ((s[k] - 0.5) * 0.12 + Math.sin(ph) * 0.05 + atmos.wind.x * 0.05) * h;
    a[j + 1] += ((s[k + 1] - 0.6) * 0.05 + Math.cos(ph * 1.3) * 0.03) * h;
    a[j + 2] += ((s[k + 2] - 0.5) * 0.12 + Math.cos(ph * 0.8) * 0.05 + atmos.wind.z * 0.05) * h;
  });
  stepSwarm(flies, cam, step, airTime, open * grassy * warm * (1 - smooth(0.1, 0.4, d)) * (1 - wr) * (1 - space), (a, j, s, k, h, tm) => {
    const ph = s[k + 3] * 6.28 + tm * (0.4 + s[k]);
    a[j] += Math.sin(ph) * 0.55 * h; a[j + 1] += Math.sin(ph * 1.7 + 1) * 0.18 * h; a[j + 2] += Math.cos(ph * 0.8) * 0.55 * h;
  });
};
BF.real.module({ name: "atmos", init });
function cloudCol(out, night, day, duskC, d, dusk, grey, wr, moon) {
  out.copy(night).multiplyScalar(1 + 2.5 * moon).lerp(day, d).lerp(tmpC.copy(duskC).multiplyScalar(0.2 + 0.8 * d), dusk * 0.8 * (0.3 + 0.7 * d));
  if (wr > 0) out.lerp(tmpC.setRGB(grey, grey * 1.03, grey * 1.08), wr * 0.88);
}
})();
