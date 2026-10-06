// Weather: clear / rain / thunder spells (seeded schedule, saved), per-biome precipitation (rain, snow, dry),
// GPU-animated rain streaks and snow flakes around the camera that stop at each column's top blocking block,
// lightning (sky flash + bolt mesh + 'lightning' event). sky.js reads intensity / thunder / flash to grey the sky,
// thicken the clouds, hide sun/moon/stars, shorten fog and dim BF.sky.light (and so terrain via uDay).
// API: BF.weather = { type, intensity, thunder, flash, set(type, sec?), update(dt), serialize(), deserialize(o),
//                     precipAt(x, z, y?) -> 0 none | 1 rain | 2 snow, rainingAt(x, y, z), remaining, ms }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const DAY = 600;                               // seconds per in-game day (sky.dayLength)
const RAMP = 15;                               // seconds for intensity 0 -> 1
const R = 20, BAND = 44, BAND_LO = 16;         // particle cylinder radius, vertical band (cam.y - 16 .. cam.y + 28)
const N = 4000;                                // particles
const HM = 64;                                 // height-map window (HM x HM columns around the camera)
const BOLT_SEGS = 64, BOLT_LIFE = 0.32;
const ORDER = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];   // (side, t) of a segment quad's 6 vertices

// ---------- seeded RNG (mulberry32; state saved) ----------
let rngState = 1;
function rnd() {
  let t = (rngState = (rngState + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const range = (a, b) => a + (b - a) * rnd();
// spell lengths (vanilla proportions compressed to the 600 s day)
const clearSpell = () => range(1, 3) * DAY;
const rainSpell = () => range(0.3, 1) * DAY;

// ---------- biome classification (cached per 4x4 column cell) ----------
// kind: 0 dry, 1 rain, 2 snow, 3 snow at y >= 90 (cold), 4 snow at y >= 100 (cool)
const SNOW_IDS = new Set([2, 19, 20, 21, 25, 26]);   // snowy beach/plains, ice spikes, snowy taiga/slopes, jagged peaks
const DRY_IDS = new Set([12, 13, 14]);               // desert, badlands, savanna
const biomeCache = new Map();
function biomeKind(x, z) {
  const cx = x >> 2, cz = z >> 2, key = (cx + 40000) * 80000 + (cz + 40000);
  let k = biomeCache.get(key);
  if (k !== undefined) return k;
  const b = BF.worldgen && BF.worldgen.biomeAt ? BF.worldgen.biomeAt(cx * 4 + 2, cz * 4 + 2) : null;
  if (!b) k = 1;
  else if (DRY_IDS.has(b.id)) k = 0;
  else if (SNOW_IDS.has(b.id) || b.temperature < -0.3) k = 2;
  else if (b.temperature < -0.1) k = 3;
  else if (b.temperature < 0.12) k = 4;
  else k = 1;
  if (biomeCache.size > 60000) biomeCache.clear();
  biomeCache.set(key, k);
  return k;
}
function kindToPrecip(k, y) {
  if (k === 0) return 0;
  if (k === 2) return 2;
  if (k === 3) return y >= BF.SEA + 42 ? 2 : 1;
  if (k === 4) return y >= BF.SEA + 52 ? 2 : 1;
  return 1;
}

// ---------- column height map (top light-blocking block, + liquid surface) ----------
let hmData, hmTex, hmOX = 1e9, hmOZ = 1e9, hmDirty = true, hmAge = 0;
function columnTop(c, lx, lz) {
  const CS = BF.CS;
  let y = c.top ? c.top[lz * CS + lx] : BF.MIN_Y - 1;
  // rain also stops on water / lava surfaces (not light-blocking for the sky shade)
  while (y + 1 < c.y1 && BF.RENDER[BF.world.chunkBlock(c, lx, y + 1, lz)] === 3) y++;
  return y;
}
function rebuildHeightMap(ox, oz) {
  const CS = BF.CS, w = BF.world;
  hmOX = ox; hmOZ = oz;
  const cx0 = Math.floor(ox / CS), cz0 = Math.floor(oz / CS), cx1 = Math.floor((ox + HM - 1) / CS), cz1 = Math.floor((oz + HM - 1) / CS);
  for (let ccz = cz0; ccz <= cz1; ccz++) for (let ccx = cx0; ccx <= cx1; ccx++) {
    const c = w.chunks.get(ccx + "," + ccz);
    const x0 = Math.max(ox, ccx * CS), x1 = Math.min(ox + HM, ccx * CS + CS);
    const z0 = Math.max(oz, ccz * CS), z1 = Math.min(oz + HM, ccz * CS + CS);
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const o = ((z - oz) * HM + (x - ox)) * 4;
      if (!c) { hmData[o] = 0; hmData[o + 1] = 0; hmData[o + 2] = 0; continue; }   // unloaded: no precipitation
      const top = columnTop(c, x - ccx * CS, z - ccz * CS), sv = Math.max(0, top + 1 - BF.MIN_Y);
      hmData[o] = sv & 255; hmData[o + 2] = sv >> 8;              // surface y - MIN_Y, 16 bits in r + b (particles stop here)
      hmData[o + 1] = kindToPrecip(biomeKind(x, z), top + 1);
    }
  }
  hmTex.needsUpdate = true;
  hmDirty = false; hmAge = 0;
}

// ---------- particles ----------
let points, pMat;
function makeParticles() {
  // 4 vertices per particle (quad), per-vertex copy of the particle seed; animation is all in the vertex shader
  const seed = new Float32Array(N * 4 * 4), corner = new Float32Array(N * 4 * 2), index = new Uint32Array(N * 6);
  let s = 9127;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const CORNERS = [-1, 0, 1, 0, 1, 1, -1, 1];
  for (let i = 0; i < N; i++) {
    const a = r(), b = r(), c = r(), d = (i + r()) / N;   // d: density rank (shown when d < intensity)
    for (let v = 0; v < 4; v++) {
      const o = (i * 4 + v) * 4;
      seed[o] = a; seed[o + 1] = b; seed[o + 2] = c; seed[o + 3] = d;
      corner[(i * 4 + v) * 2] = CORNERS[v * 2]; corner[(i * 4 + v) * 2 + 1] = CORNERS[v * 2 + 1];
    }
    const q = i * 4, o = i * 6;
    index[o] = q; index[o + 1] = q + 1; index[o + 2] = q + 2; index[o + 3] = q; index[o + 4] = q + 2; index[o + 5] = q + 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 4 * 3), 3)); // unused (shader computes)
  g.setAttribute("seed", new THREE.BufferAttribute(seed, 4));
  g.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  hmData = new Uint8Array(HM * HM * 4);
  hmTex = new THREE.DataTexture(hmData, HM, HM, THREE.RGBAFormat, THREE.UnsignedByteType);
  hmTex.magFilter = THREE.NearestFilter; hmTex.minFilter = THREE.NearestFilter; hmTex.generateMipmaps = false;
  pMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uIntensity: { value: 0 }, uLight: { value: 1 },
      uHeight: { value: hmTex }, uOrigin: { value: new THREE.Vector2() }, uHide: { value: 0 }, uMinY: { value: 0 },
    },
    vertexShader: `
      attribute vec4 seed; attribute vec2 corner;
      uniform float uTime, uIntensity, uHide, uMinY; uniform sampler2D uHeight; uniform vec2 uOrigin;
      varying vec2 vUv; varying float vA; varying float vSnow;
      const float R = ${R.toFixed(1)}, BAND = ${BAND.toFixed(1)}, LO = ${BAND_LO.toFixed(1)}, HM = ${HM.toFixed(1)};
      void main() {
        vec3 cam = cameraPosition;
        float span = 2.0 * R;
        float x = cam.x + mod(seed.x * span - cam.x, span) - R;
        float z = cam.z + mod(seed.y * span - cam.z, span) - R;
        vec2 cell = floor(vec2(x, z)) - uOrigin;
        vec4 h = texture2D(uHeight, (cell + 0.5) / HM);
        float top = floor(h.r * 255.0 + 0.5) + 256.0 * floor(h.b * 255.0 + 0.5) + uMinY, kind = floor(h.g * 255.0 + 0.5);
        float snow = step(1.5, kind);
        float speed = mix(11.0 + seed.w * 4.0, 1.4 + seed.z * 0.9, snow);
        float base = cam.y - LO;
        float y = base + mod(seed.z * BAND * 7.0 - uTime * speed - base, BAND);
        // snow drifts sideways
        float ph = seed.x * 37.0 + seed.y * 53.0;
        x += snow * sin(uTime * 0.7 + ph) * 0.45;
        z += snow * cos(uTime * 0.6 + ph * 1.3) * 0.45;
        float dist = length(vec2(x, z) - cam.xz);
        float len = mix(1.0, 0.0, snow), wid = mix(0.03, 0.06, snow);
        if (kind < 0.5 || y < top || seed.w > uIntensity || dist > R || uHide > 0.5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vUv = vec2(0.0); vSnow = 0.0; return;
        }
        vec4 mv;
        if (snow > 0.5) {
          mv = viewMatrix * vec4(x, y, z, 1.0);
          mv.xy += corner.xy * 2.0 * wid - vec2(0.0, wid);
        } else {
          // cylindrical billboard: vertical streak facing the camera around the y axis
          vec2 side = normalize(vec2(-(z - cam.z), x - cam.x) + 1e-4);
          vec3 p = vec3(x + side.x * corner.x * wid, y + corner.y * len, z + side.y * corner.x * wid);
          mv = viewMatrix * vec4(p, 1.0);
        }
        gl_Position = projectionMatrix * mv;
        vUv = corner; vSnow = snow;
        float yy = y - base;
        vA = (1.0 - smoothstep(R * 0.6, R, dist)) * mix(smoothstep(1.2, 3.5, dist), smoothstep(1.5, 5.0, dist), snow) * smoothstep(0.0, 4.0, yy) * (1.0 - smoothstep(BAND - 6.0, BAND, yy));
      }`,
    fragmentShader: `
      uniform float uLight;
      varying vec2 vUv; varying float vA; varying float vSnow;
      void main() {
        if (vA <= 0.0) discard;
        float a;
        vec3 col;
        if (vSnow > 0.5) {
          vec2 q = vec2(vUv.x, vUv.y * 2.0 - 1.0);
          float r2 = dot(q, q);
          if (r2 > 1.0) discard;
          a = 0.9 * (1.0 - r2 * 0.5);
          col = vec3(1.0);
        } else {
          a = 0.55 * (1.0 - abs(vUv.x) * 0.6) * smoothstep(0.0, 0.35, vUv.y);
          col = vec3(0.62, 0.70, 0.86);
        }
        gl_FragColor = vec4(col * uLight, a * vA);
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  points = new THREE.Mesh(g, pMat);
  points.frustumCulled = false;
  points.renderOrder = 6;
  return points;
}

// ---------- lightning bolt ----------
let bolt, boltGlow, boltMat, glowMat, boltA, boltB, boltC, boltT = 0, flashT = 9, strikeT = 20;
function makeBolt() {
  const nv = BOLT_SEGS * 6;
  boltA = new Float32Array(nv * 3); boltB = new Float32Array(nv * 3); boltC = new Float32Array(nv * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  g.setAttribute("pa", new THREE.BufferAttribute(boltA, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("pb", new THREE.BufferAttribute(boltB, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("cr", new THREE.BufferAttribute(boltC, 3).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  const mk = (width, col, alpha) => new THREE.ShaderMaterial({
    uniforms: { uW: { value: width }, uCol: { value: new THREE.Color(col) }, uA: { value: alpha }, uO: { value: 0 } },
    vertexShader: `attribute vec3 pa; attribute vec3 pb; attribute vec3 cr; uniform float uW; varying float vE;
      void main() {
        vec3 p = mix(pa, pb, cr.y);
        vec3 d = normalize(pb - pa + 1e-5), v = normalize(cameraPosition - p);
        vec3 s = normalize(cross(d, v) + 1e-5);
        float w = uW * cr.z * max(1.0, length(cameraPosition - p) * 0.012);
        vE = cr.x;
        gl_Position = projectionMatrix * viewMatrix * vec4(p + s * cr.x * w, 1.0);
      }`,
    fragmentShader: `uniform vec3 uCol; uniform float uA; uniform float uO; varying float vE;
      void main() { gl_FragColor = vec4(uCol, uA * uO * (1.0 - vE * vE)); }`,
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  boltMat = mk(0.22, "#f4f8ff", 1.0); glowMat = mk(1.6, "#8fb4ff", 0.45);
  bolt = new THREE.Mesh(g, boltMat); boltGlow = new THREE.Mesh(g, glowMat);
  for (const m of [bolt, boltGlow]) { m.frustumCulled = false; m.renderOrder = 7; m.visible = false; }
  bolt.renderOrder = 8;
}
let segN = 0;
function seg(ax, ay, az, bx, by, bz, wa) {
  if (segN >= BOLT_SEGS) return;
  for (let v = 0; v < 6; v++) {
    const o = (segN * 6 + v) * 3;
    boltA[o] = ax; boltA[o + 1] = ay; boltA[o + 2] = az; boltB[o] = bx; boltB[o + 1] = by; boltB[o + 2] = bz;
    boltC[o] = ORDER[v][0]; boltC[o + 1] = ORDER[v][1]; boltC[o + 2] = wa;
  }
  segN++;
}
function buildBolt(x, y, z) {
  segN = 0;
  const y0 = Math.max(BF.H > 192 ? (BF.sky ? BF.sky.cloudY : 0) + 4 : BF.H + 4, y + 30), n = 26, M = Math.random;
  let px = x + (M() - 0.5) * 8, pz = z + (M() - 0.5) * 8, py = y0;
  let ox = px - x, oz = pz - z;
  const branches = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    ox = ox * 0.6 + (M() - 0.5) * 4.5; oz = oz * 0.6 + (M() - 0.5) * 4.5;
    const k = i === n ? 0 : 1 - t * t * t;
    const nx = x + 0.5 + ox * k, nz = z + 0.5 + oz * k, ny = y0 + (y - y0) * t;
    seg(px, py, pz, nx, ny, nz, 1);
    if (i > 2 && i < n - 4 && M() < 0.16 && branches.length < 3) branches.push([nx, ny, nz]);
    px = nx; py = ny; pz = nz;
  }
  for (const [bx0, by0, bz0] of branches) {
    let bx = bx0, by = by0, bz = bz0;
    const dx = (M() - 0.5) * 2.5, dz = (M() - 0.5) * 2.5, steps = 5 + (M() * 4 | 0), dy = Math.min(4, (by - y) / steps + 1.2);
    for (let i = 0; i < steps; i++) {
      const nx = bx + dx + (M() - 0.5) * 1.6, nz = bz + dz + (M() - 0.5) * 1.6, ny = Math.max(y, by - dy);
      seg(bx, by, bz, nx, ny, nz, 0.55 * (1 - i / steps) + 0.15);
      bx = nx; by = ny; bz = nz;
    }
  }
  const g = bolt.geometry;
  g.attributes.pa.needsUpdate = g.attributes.pb.needsUpdate = g.attributes.cr.needsUpdate = true;
  g.setDrawRange(0, segN * 6);
}

// ---------- state ----------
const weather = {
  type: "clear",
  remaining: DAY,        // seconds left in the current spell
  intensity: 0,          // 0..1 overcast / precipitation level (ramps over RAMP seconds)
  thunder: 0,            // 0..1 thunderstorm level (subset of intensity)
  flash: 0,              // 0..1 lightning flash envelope (sky/terrain brightness spike)
  ms: 0,                 // smoothed cost of update() in ms
  strikes: 0,
  lastStrike: null,

  precipAt(x, z, y) {
    x = Math.floor(x); z = Math.floor(z);
    if (y === undefined) { const h = BF.world && BF.world.heightAt ? BF.world.heightAt(x, z) : -1; y = h + 1; }
    return kindToPrecip(biomeKind(x, z), y);
  },
  // true when rain or snow is falling on (x, y, z) right now: weather active, wet biome, open sky above
  rainingAt(x, y, z) {
    if (weather.intensity < 0.2) return false;
    if (!weather.precipAt(x, z, y)) return false;
    const c = BF.world.chunkAt ? BF.world.chunkAt(Math.floor(x), Math.floor(z)) : null;
    if (!c) return true;
    const lx = Math.floor(x) - c.cx * BF.CS, lz = Math.floor(z) - c.cz * BF.CS;
    return columnTop(c, lx, lz) < y;
  },
  get raining() { return weather.type !== "clear" && weather.intensity > 0.2; },

  set(type, sec) {
    if (type !== "clear" && type !== "rain" && type !== "thunder") throw new Error("weather type must be clear, rain or thunder");
    const prev = weather.type;
    weather.type = type;
    weather.remaining = sec > 0 ? +sec : type === "clear" ? clearSpell() : rainSpell();
    if (type === "thunder") strikeT = range(4, 12);
    if (prev !== type) BF.emit && BF.emit("weatherChanged", type);
    return weather.remaining;
  },

  reset(seed) {
    rngState = ((seed >>> 0) ^ 0x5eed7a11) >>> 0;
    weather.type = "clear"; weather.intensity = 0; weather.thunder = 0; weather.flash = 0;
    weather.remaining = range(0.5, 1.5) * DAY;
    flashT = 9; boltT = 0; strikeT = 20; hmDirty = true;
    biomeCache.clear();
  },

  serialize() {
    return { type: weather.type, remaining: +weather.remaining.toFixed(2), rng: rngState >>> 0,
      intensity: +weather.intensity.toFixed(3), thunder: +weather.thunder.toFixed(3) };
  },
  deserialize(o) {
    if (!o || typeof o !== "object") return;
    const t = o.type === "rain" || o.type === "thunder" ? o.type : "clear";
    const prev = weather.type;
    weather.type = t;
    if (o.remaining > 0) weather.remaining = +o.remaining;
    if (o.rng != null) rngState = o.rng >>> 0;
    weather.intensity = o.intensity != null ? Math.max(0, Math.min(1, +o.intensity)) : t === "clear" ? 0 : 1;
    weather.thunder = o.thunder != null ? Math.max(0, Math.min(1, +o.thunder)) : t === "thunder" ? 1 : 0;
    if (prev !== t) BF.emit && BF.emit("weatherChanged", t);
  },

  // scheduling only (no visuals): used by update and by tests to simulate days quickly
  tick(dt) {
    weather.remaining -= dt;
    if (weather.remaining <= 0) {
      if (weather.type === "clear") weather.set(rnd() < 0.25 ? "thunder" : "rain");
      else weather.set("clear");
    }
    const target = weather.type === "clear" ? 0 : 1, tt = weather.type === "thunder" ? 1 : 0, k = dt / RAMP;
    weather.intensity += Math.max(-k, Math.min(k, target - weather.intensity));
    weather.thunder += Math.max(-k, Math.min(k, Math.min(tt, weather.intensity) - weather.thunder));
  },

  debugText() {
    const p = BF.player && BF.player.position;
    const here = p ? ["dry", "rain", "snow"][weather.precipAt(p.x, p.z, p.y)] : "?";
    return `Weather ${weather.type} ${weather.intensity.toFixed(2)}${weather.thunder > 0 ? " th " + weather.thunder.toFixed(2) : ""}` +
      ` (${Math.round(weather.remaining)}s left, ${here} here)  ${weather.ms.toFixed(2)}ms`;
  },

  update(dt) {
    const t0 = performance.now();
    if (!points) init();
    if (dt > 0) {
      weather.tick(dt);
      // lightning
      if (weather.type === "thunder" && weather.thunder > 0.5) {
        strikeT -= dt;
        if (strikeT <= 0) { strikeT = 10 + Math.random() * 30; strike(); }
      }
      flashT += dt; boltT -= dt;
    }
    // flash envelope: bright strike plus a weaker second flash ~0.13 s later
    const f1 = Math.exp(-flashT / 0.05), f2 = flashT > 0.13 ? 0.7 * Math.exp(-(flashT - 0.13) / 0.06) : 0;
    weather.flash = flashT < 0.6 ? Math.min(1, f1 + f2) : 0;
    const bo = boltT > 0 ? Math.min(1, boltT / BOLT_LIFE * 2.2) * (0.75 + 0.25 * Math.sin(boltT * 90)) : 0;
    bolt.visible = boltGlow.visible = bo > 0;
    boltMat.uniforms.uO.value = glowMat.uniforms.uO.value = bo;

    // precipitation particles
    const show = weather.intensity > 0.005;
    points.visible = show;
    if (show) {
      const cam = BF.camera.position;
      const ox = Math.floor(cam.x) - HM / 2, oz = Math.floor(cam.z) - HM / 2;
      hmAge += dt;
      if (hmDirty || ox !== hmOX || oz !== hmOZ || hmAge > 1.5) rebuildHeightMap(ox, oz);
      const u = pMat.uniforms;
      u.uTime.value = (u.uTime.value + dt) % 7200;
      u.uIntensity.value = weather.intensity;
      u.uOrigin.value.set(hmOX, hmOZ);
      u.uMinY.value = BF.MIN_Y;
      u.uLight.value = Math.min(1.3, 0.22 + 0.85 * (BF.sky ? BF.sky.light : 1));
      u.uHide.value = BF.player && BF.player.headInWater ? 1 : 0;
    }
    const ms = performance.now() - t0;
    weather.ms = weather.ms * 0.95 + ms * 0.05;
  },
};

function strike() {
  const p = BF.player && BF.player.position;
  if (!p) return;
  for (let tries = 0; tries < 8; tries++) {
    const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * 58;
    const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
    const c = BF.world.chunkAt(x, z);
    let y;
    if (c) y = columnTop(c, x - c.cx * BF.CS, z - c.cz * BF.CS) + 1;
    else y = Math.floor(BF.worldgen.heightAt(x, z)) + 1;
    if (!kindToPrecip(biomeKind(x, z), y)) continue;      // no lightning over dry biomes
    weather.strikeAt(x, y, z);
    return;
  }
}
weather.strikeAt = function (x, y, z) {
  if (!bolt) init();
  buildBolt(x, y, z);
  boltT = BOLT_LIFE; flashT = 0;
  weather.strikes++;
  const p = BF.player.position;
  const dist = Math.hypot(x + 0.5 - p.x, y - p.y, z + 0.5 - p.z);
  weather.lastStrike = { x: x + 0.5, y, z: z + 0.5, dist };
  // small damage only right next to the strike
  if (dist < 2.5 && BF.player.damage) BF.player.damage(5, null, "lightning");
  if (BF.mobs && BF.mobs.list) for (const m of BF.mobs.list) {
    if (m.dead || m.removed) continue;
    if (Math.hypot(m.position.x - x - 0.5, m.position.y - y, m.position.z - z - 0.5) < 2.5) BF.mobs.hit(m, 5, null);
  }
  BF.emit("lightning", { x: x + 0.5, y, z: z + 0.5, dist });
};

let inited = false;
function init() {
  if (inited) return;
  inited = true;
  BF.scene.add(makeParticles());
  makeBolt();
  BF.scene.add(bolt, boltGlow);
  if (BF.world && BF.world.onChunkLoad) BF.world.onChunkLoad(() => { hmDirty = true; });
  if (BF.on) {
    BF.on("blockPlaced", () => { hmDirty = true; });
    BF.on("blockBroken", () => { hmDirty = true; });
    BF.on("newWorld", seed => weather.reset(seed));
    BF.on("playerSlept", () => { if (weather.type !== "clear") weather.set("clear"); weather.intensity = 0; weather.thunder = 0; });
  }
}
// newWorld runs before the first sky.update, so register the reset listener as soon as the event bus exists
weather.reset(1337);
setTimeout(() => { if (BF.scene && !inited) init(); }, 0);

BF.weather = weather;
})();
