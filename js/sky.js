// Day/night cycle: gradient sky dome, square sun and moon, stars, drifting 3D (slab) clouds, fog and light level.
// time in [0,1): 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. Daytime is exactly the half with the sun above the horizon
// (0..0.5), nighttime the other half. Light: full day, dipping a little in the last hour before sunset ("golden hour"); dusk is the
// first DUSK_LEN of the night, darkening gradually to full night; dawn mirrors it before sunrise. lightAt(t) is that curve
// without weather, so monster spawning (js/mobs.js) can ask how long a spot has been dark.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const C = h => new THREE.Color(h);
const DAY_TOP = C("#5d93ef"), DAY_HOR = C("#b6d2f5");
const NIGHT_TOP = C("#02040b"), NIGHT_HOR = C("#0b1328"), SPACE = C("#05070f");
const DUSK_HOR = C("#f08a50"), DUSK_GLOW = C("#ff7a3c"), DUSK_PINK = C("#d86a86");
const CLOUD_DAY = C("#ffffff"), CLOUD_NIGHT = C("#1c2234"), CLOUD_DUSK = C("#f6b49a");

// Cloud base: above the regional ground (generator samples on two rings around the camera:
// the higher of average + 110 and upper quartile + 50), so you walk under clouds on the plains and on hills, and climb above
// them only on real peaks. Teleports and big jumps re-probe at once and snap.
let cloudTarget = 196, regionGround = 64, cloudProbeT = 0, probeX = 1e9, probeZ = 1e9;
const PROBE = [[0, 0]];
for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; PROBE.push([Math.cos(a) * 96, Math.sin(a) * 96], [Math.cos(a + 0.39) * 256, Math.sin(a + 0.39) * 256]); }
function updateCloudBase(dt) {
  const cam = BF.camera;
  cloudProbeT -= dt;
  const jump = cam ? Math.abs(cam.position.x - probeX) + Math.abs(cam.position.z - probeZ) : 0, moved = jump > 64;
  let snap = false;
  if (cam && (cloudProbeT <= 0 || moved) && BF.worldgen && BF.worldgen.heightAt) {
    cloudProbeT = 1; snap = jump > 256; probeX = cam.position.x; probeZ = cam.position.z;
    const hs = [];
    try { for (const o of PROBE) hs.push(Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(probeX + o[0]), Math.floor(probeZ + o[1])))); }
    catch (_) { hs.length = 0; hs.push(BF.SEA + 30); }   // generator not ready yet
    hs.sort((a, b) => a - b);
    regionGround = hs.reduce((a, b) => a + b, 0) / hs.length;
    const q3 = hs[Math.floor(hs.length * 0.75)];
    cloudTarget = Math.round(Math.max(BF.SEA + 110, regionGround + 110, q3 + 50) / 4) * 4;
  }
  let b = sky.cloudBase;
  if (!(b > BF.MIN_Y) || snap || Math.abs(cloudTarget - b) > 150) b = cloudTarget;   // first frame and teleports snap
  else b += (cloudTarget - b) * Math.min(1, dt * 0.5);
  sky.cloudBase = b;
}
const SKY_R = 480, SUN_D = 400, CLOUD_BASE = BF.H + 4, CLOUD_H = 5, CLOUD_RISE = 70, CLOUD_CELL = 12, CLOUD_N = 64, CLOUD_R = 320;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const HOUR = 1 / 24;                     // one in-game hour as a fraction of a day
const DUSK_LEN = 1.5 * HOUR, GOLDEN_LEN = HOUR, SUNSET_DAYNESS = 0.8;
// 0 (full night) .. 1 (full day) at time of day t, from the time since sunset / until sunrise (not the sun's height).
function daynessAt(t) {
  t = ((t % 1) + 1) % 1;
  if (t < 0.5) return SUNSET_DAYNESS + (1 - SUNSET_DAYNESS) * smooth(0, GOLDEN_LEN, Math.min(t, 0.5 - t));
  return SUNSET_DAYNESS * (1 - smooth(0, DUSK_LEN, Math.min(t - 0.5, 1 - t)));
}
const lightOf = dayness => 0.18 + 0.82 * dayness;

let root, celestial, dome, sun, moon, stars, clouds, scene;
const tmpV = new THREE.Vector3(), tmpC = new THREE.Color();
const horizon = new THREE.Color(), zenith = new THREE.Color(), glow = new THREE.Color(), cloudCol = new THREE.Color();
let cloudDrift = 0, cloudY = CLOUD_BASE;

// Cloud variety: cover and height are smooth value noise over continuous game time (day + time of day), so they are
// deterministic per world seed, survive save/load and stay smooth however fast time runs (F fast-forward).
const nhash = (n, s) => { let h = Math.imul(n | 0, 374761393) ^ Math.imul(s | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const vnoise = (x, s) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return nhash(i, s) * (1 - u) + nhash(i + 1, s) * u; };

function pixelCanvas(n, draw) {
  const c = document.createElement("canvas"); c.width = c.height = n;
  draw(c.getContext("2d"));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}

function makeDome() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: new THREE.Color() }, hor: { value: new THREE.Color() },
      glowCol: { value: new THREE.Color() }, glowAmt: { value: 0 }, sunDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 glowCol; uniform float glowAmt; uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(hor, top, smoothstep(-0.02, 0.45, h));
        float g = pow(max(dot(d, sunDir), 0.0), 5.0) * glowAmt * (1.0 - smoothstep(0.0, 0.55, h)) * smoothstep(-0.25, 0.0, h);
        col = mix(col, glowCol, clamp(g, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 24, 12), mat);
  m.renderOrder = -1000; m.frustumCulled = false;
  return m;
}

function makeSun() {
  const tex = pixelCanvas(32, g => {
    g.fillStyle = "rgba(255,240,170,0.16)"; g.fillRect(2, 2, 28, 28);
    g.fillStyle = "rgba(255,240,170,0.3)"; g.fillRect(5, 5, 22, 22);
    g.fillStyle = "#ffe98a"; g.fillRect(8, 8, 16, 16);
    g.fillStyle = "#fffbd8"; g.fillRect(10, 10, 12, 12);
  });
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), mat);
  m.position.set(SUN_D, 0, 0); m.rotation.y = -Math.PI / 2;
  return m;
}

function makeMoon() {
  const tex = pixelCanvas(16, g => {
    g.fillStyle = "#d9dde6"; g.fillRect(3, 3, 10, 10);
    g.fillStyle = "#b7bcc8";
    for (const [x, y, w, h] of [[5, 4, 2, 2], [9, 6, 3, 2], [4, 9, 2, 2], [8, 10, 2, 2], [10, 4, 1, 1]]) g.fillRect(x, y, w, h);
    g.fillStyle = "#eef1f6"; g.fillRect(3, 3, 10, 1); g.fillRect(3, 3, 1, 10);
  });
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(52, 52), mat);
  m.position.set(-SUN_D, 0, 0); m.rotation.y = Math.PI / 2;
  return m;
}

function makeStars() {
  let s = 12345;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const pos = [], col = [];
  for (let i = 0; i < 700; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, q = Math.sqrt(1 - u * u);
    pos.push(Math.cos(a) * q * 440, u * 440, Math.sin(a) * q * 440);
    const b = 0.55 + r() * 0.45;
    col.push(b, b, Math.min(1, b + 0.08));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0 }, size: { value: 2 } },
    vertexShader: `attribute vec3 color; uniform float size; varying vec3 vCol; varying float vH;
      void main() {
        vCol = color; vec4 w = modelMatrix * vec4(position, 1.0);
        vH = normalize(w.xyz - cameraPosition).y;
        gl_PointSize = size; gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `uniform float opacity; varying vec3 vCol; varying float vH;
      void main() { gl_FragColor = vec4(vCol, opacity * smoothstep(-0.02, 0.2, vH)); }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

// ---------- clouds on the planet (generator 4, spec r14-20) ----------
// A cell is cloudy where 3D noise at the sphere point under it is above the cover threshold, so the pattern is one field over the
// whole planet and has no seam at a face edge. The wind turns that field about the pole axis (clouds blow east, CLOUD_WIND blocks
// a second at the equator, none at the poles); it is a pure function of game time, so clouds survive save and load.
// The cells form a lattice in the camera's face frame, offset by the sub-cell drift D (planetD). PCELL divides N and every unfold
// offset is a multiple of N, so the lattices of two faces line up exactly across their edge: crossing an edge turns D into the
// new face's frame and the rebuilt cells sit on the same ground with the same content. Between rebuilds the mesh only slides by
// the local wind (a few thousandths of a block off the true turning field across the window).
const PCELL = 10, CLOUD_WIND = 1.2;
let cloudNoise = null, cloudNoiseSeed = NaN, cloudSorted = null;
const planetD = [0, 0];
let planetFace = -1, sunYaw = 0;
const cg = {}, cq = [0, 0, 0];
function cloudField(x, y, z) {   // x, y, z: a unit direction, already turned back by the wind
  const k1 = BF.planet.R / 56, k2 = BF.planet.R / 24;
  return cloudNoise.n3(x * k1, y * k1, z * k1) + 0.4 * cloudNoise.n3(x * k2 + 71.3, y * k2, z * k2);
}
function planetClouds() {
  const seed = ((BF.state && BF.state.seed) | 0) ^ 0x3c10d5;
  if (cloudNoise && cloudNoiseSeed === seed) return;
  cloudNoise = BF.makeNoise(seed); cloudNoiseSeed = seed;
  // the field's distribution, so cover maps to a threshold (as the flat mask's quantiles do)
  let s = 4242;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  cloudSorted = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, q = Math.sqrt(1 - u * u);
    cloudSorted[i] = cloudField(Math.cos(a) * q, u, Math.sin(a) * q);
  }
  cloudSorted.sort();
  if (clouds) clouds.userData.invalidate();
}
const windAngle = () => CLOUD_WIND / BF.planet.R * (sky.day + sky.time) * sky.dayLength;

function makeClouds() {
  // Volumetric ("fancy") clouds: a periodic 64x64 cell mask (each cell = CLOUD_CELL blocks, deterministic) is meshed
  // into flat-topped slabs over a WxW window of cells around the camera. Only exposed faces are emitted (internal
  // faces culled). The mesh is rebuilt only when the window's first cell index changes (camera or drift crosses a
  // cell boundary); in between it is just translated (sub-cell scroll). Buffers are preallocated, no per-rebuild allocs.
  // On the planet the cells are PCELL blocks and their content comes from cloudField (see above).
  let s = 777;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  let f = new Float32Array(CLOUD_N * CLOUD_N).map(() => r());
  {
    const nf = new Float32Array(f.length);
    for (let y = 0; y < CLOUD_N; y++) for (let x = 0; x < CLOUD_N; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        sum += f[((y + dy + CLOUD_N) % CLOUD_N) * CLOUD_N + ((x + dx + CLOUD_N) % CLOUD_N)];
      nf[y * CLOUD_N + x] = sum / 9;
    }
    f = nf;
  }
  const sorted = Array.from(f).sort((a, b) => a - b);
  // mask[j * N + i] for cell (i, j) in world cell coordinates (x, z); row order matches the old flipY texture
  const mask = new Uint8Array(CLOUD_N * CLOUD_N);
  let coverQ = -1;
  const setMask = q => { // q = quantile threshold (0.7 = 30% sky covered); weather lowers it for overcast skies
    if (q === coverQ) return false;
    coverQ = q; const thr = sorted[Math.floor(f.length * q)];
    for (let j = 0; j < CLOUD_N; j++) for (let i = 0; i < CLOUD_N; i++) mask[j * CLOUD_N + i] = f[(CLOUD_N - 1 - j) * CLOUD_N + i] > thr ? 1 : 0;
    return true;
  };
  setMask(0.7);
  const M = CLOUD_N - 1;
  const flatCell = (i, j) => mask[(j & M) * CLOUD_N + (i & M)];

  // the planet's cells for the current window (pmask[b * W + a], with a one-cell border), filled by fillPlanet
  const W0 = Math.ceil(CLOUD_R / CLOUD_CELL) * 2 + 2, WP = Math.ceil(CLOUD_R / PCELL) * 2 + 2;
  const pmask = new Uint8Array((WP + 2) * (WP + 2));
  let planet = false, pci = 0, pcj = 0, pThr = 0;
  const cell = (i, j) => planet ? pmask[(j - pcj + 1) * (WP + 2) + (i - pci + 1)] : flatCell(i, j);
  function fillPlanet(ci, cj, f, dx, dz) {
    const P = BF.planet, N = P.N, x0 = P.W * f + N, al = windAngle(), ca = Math.cos(al), sa = Math.sin(al);
    pci = ci; pcj = cj;
    for (let b = -1; b <= WP; b++) for (let a = -1; a <= WP; a++) {
      const u = (ci + a + 0.5) * PCELL + dx - x0, v = (cj + b + 0.5) * PCELL + dz - N;
      P.wrap(f, u, v, cg);
      P.dir(cg.f, cg.u, cg.v, cq);
      const x = cq[0] * ca - cq[2] * sa, z = cq[0] * sa + cq[2] * ca;   // turned back by the wind
      pmask[(b + 1) * (WP + 2) + a + 1] = cloudField(x, cq[1], z) > pThr ? 1 : 0;
    }
  }

  let W = W0, CS = CLOUD_CELL;
  const CH = CLOUD_H;
  // worst case 6 quads per cell is impossible for neighbours; bound by cells * 6 anyway only if checkerboard (<= 5 faces)
  const maxVerts = WP * WP * 6 * 6;
  const pos = new Float32Array(maxVerts * 3), shade = new Float32Array(maxVerts);
  const geo = new THREE.BufferGeometry();
  const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const sa = new THREE.BufferAttribute(shade, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", pa); geo.setAttribute("shade", sa);
  let nv = 0;
  const quad = (sh, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    // p0,p1,p2 wound counter-clockwise seen from outside; triangles (0,1,2) (0,2,3)
    const o = nv * 3;
    pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az; pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz; pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
    pos[o + 9] = ax; pos[o + 10] = ay; pos[o + 11] = az; pos[o + 12] = cx; pos[o + 13] = cy; pos[o + 14] = cz; pos[o + 15] = dx; pos[o + 16] = dy; pos[o + 17] = dz;
    shade.fill(sh, nv, nv + 6); nv += 6;
  };
  function rebuild(ci, cj) {
    nv = 0;
    // side shades: x sides a little darker than z sides; on the planet both alike, since a face edge can turn x into z
    const SX = planet ? 0.85 : 0.8, SZ = planet ? 0.85 : 0.9;
    for (let b = 0; b < W; b++) for (let a = 0; a < W; a++) {
      const i = ci + a, j = cj + b;
      if (!cell(i, j)) continue;
      const x0 = a * CS, x1 = x0 + CS, z0 = b * CS, z1 = z0 + CS;
      quad(1.0, x0, CH, z0, x0, CH, z1, x1, CH, z1, x1, CH, z0);       // top
      quad(0.7, x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);           // bottom
      if (!cell(i + 1, j)) quad(SX, x1, 0, z0, x1, CH, z0, x1, CH, z1, x1, 0, z1);
      if (!cell(i - 1, j)) quad(SX, x0, 0, z1, x0, CH, z1, x0, CH, z0, x0, 0, z0);
      if (!cell(i, j + 1)) quad(SZ, x1, 0, z1, x1, CH, z1, x0, CH, z1, x0, 0, z1);
      if (!cell(i, j - 1)) quad(SZ, x0, 0, z0, x0, CH, z0, x1, CH, z0, x1, 0, z0);
    }
    pa.needsUpdate = true; sa.needsUpdate = true;
    geo.setDrawRange(0, nv);
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      cam: { value: new THREE.Vector2() },
      color: { value: new THREE.Color(1, 1, 1) }, fogCol: { value: new THREE.Color() },
      radius: { value: CLOUD_R }, under: { value: 0 },
    },
    vertexShader: `attribute float shade; varying vec2 vW; varying float vS;
      void main() { vW = position.xz; vS = shade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,   // cam: relative to the mesh
    fragmentShader: `uniform vec2 cam; uniform vec3 color; uniform vec3 fogCol; uniform float radius; uniform float under;
      varying vec2 vW; varying float vS;
      void main() {
        float d = length(vW - cam);
        float fade = 1.0 - smoothstep(radius * 0.45, radius, d);
        if (fade <= 0.0) discard;
        vec3 c = color * vS * (1.0 - under * 0.12);
        gl_FragColor = vec4(mix(fogCol, c, fade), 0.9 * fade);
      }`,
    transparent: true, depthWrite: false, side: THREE.FrontSide, fog: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 5;
  let kx = 1e9, kz = 1e9, kf = -1;
  m.userData.sync = (camX, camZ, drift, y) => {
    if (planet) { planet = false; W = W0; CS = CLOUD_CELL; kx = 1e9; }
    // window's first cell index; world x of cell i's left edge is i * CS - drift
    const ci = Math.floor((camX + drift) / CS) - (W >> 1), cj = Math.floor(camZ / CS) - (W >> 1);
    if (ci !== kx || cj !== kz) { kx = ci; kz = cj; rebuild(ci, cj); }
    m.position.set(ci * CS - drift, y, cj * CS);
  };
  // the planet: cell (i, j) of face f's lattice covers atlas x from i * PCELL + dx, z from j * PCELL + dz
  m.userData.syncPlanet = (camX, camZ, f, dx, dz, y) => {
    if (!planet) { planet = true; W = WP; CS = PCELL; kx = 1e9; }
    const ci = Math.floor((camX - dx) / CS) - (W >> 1), cj = Math.floor((camZ - dz) / CS) - (W >> 1);
    if (ci !== kx || cj !== kz || f !== kf) { kx = ci; kz = cj; kf = f; fillPlanet(ci, cj, f, dx, dz); rebuild(ci, cj); }
    m.position.set(ci * CS + dx, y, cj * CS + dz);
  };
  m.userData.invalidate = () => { kx = 1e9; };
  m.userData.cell = (i, j) => cell(i, j);
  m.userData.cellSize = () => CS;
  m.userData.triangles = () => nv / 3;
  m.userData.setCoverage = q => {
    q = Math.round(q * 20) / 20;
    if (setMask(q)) kx = 1e9;
    if (cloudSorted) { const t = q >= 1 ? Infinity : cloudSorted[Math.min(4095, Math.floor(4096 * q))]; if (t !== pThr) { pThr = t; if (planet) kx = 1e9; } }
  };
  return m;
}

// The sun's path on the planet: east to west in true directions (as 1.3's sun runs along +x, which is east at face 4's centre), so
// it doesn't swing round when the player crosses an edge that turns the grid. One global clock: the sun's height is the same
// everywhere at a given time of day (spec r14-20). Returns the yaw from the face's +x axis to local east.
const sf = {};
function planetSunYaw(cam) {
  const P = BF.planet;
  const f = P.face(cam.position.x, cam.position.z);
  if (f < 0) return sunYaw;
  const N = P.N, u = cam.position.x - P.W * f - N, v = cam.position.z - N;
  P.frame(f, u, v, cam.position.y, sf);
  const up = sf.up, ex = up[2], ez = -up[0];   // east = pole axis x up
  if (Math.hypot(ex, ez) < 1e-6) return sunYaw;   // at a pole: keep the last heading
  const g = P.toGrid([ex, 0, ez], sf);
  return (sunYaw = Math.atan2(-g[1], g[0]));
}
// Clouds on the planet: the drift D slides by the local wind in the camera's face frame and is turned with the frame at an edge.
const wf = {}, ws = [0, 0, 0];
function planetCloudSync(cam, dt) {
  const P = BF.planet, x = cam.position.x, z = cam.position.z, f = P.face(x, z), N = P.N, CS = PCELL;
  if (planetFace >= 0 && f !== planetFace) {
    const e = P.UNFOLD[planetFace][f];
    if (e) {   // u_g = A^T (U_f - t): directions turn by A^T
      const A = e.A, dx = planetD[0], dz = planetD[1];
      planetD[0] = A[0] * dx + A[2] * dz; planetD[1] = A[1] * dx + A[3] * dz;
    }
  }
  planetFace = f;
  if (dt > 0) {
    const u = x - P.W * f - N, v = z - N, y = cloudY;
    P.pos(f, u, v, y, ws);
    P.frame(f, u, v, y, wf);
    const w = CLOUD_WIND / P.R;   // the field's turn rate (radians a second); velocity = w (pole axis x position)
    const g = P.toGrid([w * ws[2], 0, -w * ws[0]], wf);
    planetD[0] += g[0] * dt; planetD[1] += g[1] * dt;
  }
  planetD[0] = ((planetD[0] % CS) + CS) % CS; planetD[1] = ((planetD[1] % CS) + CS) % CS;
  clouds.userData.syncPlanet(x, z, f, planetD[0], planetD[1], cloudY);
}

const sky = {
  time: 0.05,
  light: 1,
  day: 0,
  cloudBase: CLOUD_BASE, // lowest cloud altitude; terrain with taller peaks raises it (world gen sets it per world)
  cloudCover: 0,         // 0 clear .. 1 fully overcast (current, includes weather)
  cloudHeight: CLOUD_BASE, // current cloud altitude = cloudBase + variable offset (0..CLOUD_RISE)
  dayLength: 1200, // seconds per full day (20 min; was 600 until 2026-10-06)

  init(sceneRef) {
    scene = sceneRef;
    scene.background = new THREE.Color();
    scene.fog = new THREE.Fog(0xb6d2f5, 50, 100);
    root = new THREE.Group();
    celestial = new THREE.Group();
    celestial.rotation.order = "YZX";
    celestial.rotation.y = 0.35; // tilt the sun path slightly off due east-west
    dome = makeDome(); sun = makeSun(); moon = makeMoon(); stars = makeStars(); clouds = makeClouds();
    celestial.add(sun, moon, stars);
    root.add(dome, celestial);
    scene.add(root, clouds);
    // the dome follows the camera every frame, also while paused or when the camera moves fast (high up on the planet the view
    // climbs hundreds of blocks a frame, and a dome left behind shows as a sphere)
    if (BF.view) BF.view.onBegin(() => { if (BF.camera) root.position.copy(BF.camera.position); });
    sky.update(0);
  },

  setTime(t) { sky.time = ((t % 1) + 1) % 1; if (scene) sky.update(0); },

  get cloudY() { return cloudY; },   // alias of cloudHeight
  // tests and the debug screen: cloud cover at a cell of the current window, the cell size, and the planet drift
  cloudCell(i, j) { return clouds.userData.cell(i, j); },
  get cloudCellSize() { return clouds.userData.cellSize(); },
  get cloudMesh() { return clouds; },
  planetDrift: planetD,
  get sunYaw() { return celestial ? celestial.rotation.y : 0.35; },   // the sun path's heading in the face frame (0.35 at face 4's centre)

  HOUR, DUSK_LEN,
  SUNSET: 0.5,
  // Nighttime = the sun is below the horizon (half of every day). Weather never makes it night.
  isNight() { return sky.time >= 0.5; },
  // A thunderstorm darkens the day enough for monsters and sleeping, as in vanilla (js/weather.js).
  stormy() { return !!(BF.weather && BF.weather.thunder > 0.5); },
  // Light level (no weather) at time of day t; sky.light is this times the weather dimming.
  lightAt(t) { return lightOf(daynessAt(t)); },

  // A simulation step of dt game seconds: the clock and the weather move on and sky.light is worked out, then the sky is drawn for
  // that time. The game loop (main.js) splits the two (spec r15-10): advance(h) every tick, draw(alpha) every frame.
  update(dt) {
    if (!scene) return;
    sky.advance(dt);
    paint(sky.time, sky.day, dt);
  },
  // The simulation side of a tick: time of day, cloud drift, weather (js/weather.js) and the light level the sim reads.
  advance(dt) {
    if (!scene) return;
    if (dt > 0) {
      sky.time += dt / sky.dayLength;
      if (sky.time >= 1) { sky.time -= 1; sky.day++; }
      cloudDrift += dt * 1.2;
    }
    // weather: overcast greys the sky and dims light ~30% (rain) / ~60% (thunder); lightning flashes brighten it
    const W = BF.weather;
    if (W && W.update) W.update(dt);
    const wr = W ? W.intensity || 0 : 0, wt = W ? W.thunder || 0 : 0, wf = W ? W.flash || 0 : 0;
    sky.light = Math.min(1.35, lightOf(daynessAt(sky.time)) * (1 - 0.3 * wr - 0.3 * wt) + wf * 0.85);   // a lightning flash brightens terrain briefly
  },
  // Every frame: the sky drawn at the game time between the last two ticks (alpha 0..1 of the way from the previous tick to the
  // latest), so a 60 fps day / night doesn't step at the 20 ticks a second. dt: the game seconds drawn since the last frame (clouds).
  draw(alpha, dt) {
    if (!scene) return;
    const back = (1 - Math.max(0, Math.min(1, alpha))) * (BF.warp ? BF.warp.TICK : 0) / sky.dayLength;
    let t = sky.time - back, d = sky.day;
    if (t < 0) { t += 1; d--; }
    paint(t, d, dt || 0);
  },
};

// Draws the sky for time of day t on day `day` (colours, sun, moon, stars, fog, clouds). Reads the weather and sky.light as the
// latest tick left them; changes nothing the simulation reads.
function paint(t, day, dt) {
    const a = t * Math.PI * 2;
    const sh = Math.sin(a); // sun height, -1..1
    const dayness = daynessAt(t);
    const dusk = Math.exp(-(sh * sh) / 0.035); // peaks at sunrise / sunset
    const W = BF.weather;
    const wr = W ? W.intensity || 0 : 0, wt = W ? W.thunder || 0 : 0, wf = W ? W.flash || 0 : 0;

    // colours
    zenith.copy(NIGHT_TOP).lerp(DAY_TOP, dayness);
    horizon.copy(NIGHT_HOR).lerp(DAY_HOR, dayness).lerp(DUSK_HOR, dusk * 0.4);
    glow.copy(DUSK_GLOW).lerp(DUSK_PINK, smooth(0.0, 0.18, Math.abs(sh)));
    const wg = (0.6 - 0.28 * wt) * (0.06 + 0.94 * dayness); // overcast grey level
    if (wr > 0) {
      zenith.lerp(tmpC.setRGB(wg * 0.86, wg * 0.9, wg * 0.97), wr * 0.9);
      horizon.lerp(tmpC.setRGB(wg * 1.12, wg * 1.15, wg * 1.2), wr * 0.88);
    }
    if (wf > 0) { zenith.lerp(tmpC.setRGB(0.75, 0.8, 0.95), wf * 0.55); horizon.lerp(tmpC.setRGB(0.85, 0.88, 1), wf * 0.65); }
    // high above the planet the sky fades to space (js/view.js: 3,000 to 60,000 blocks above the ground)
    const space = BF.view && BF.view.spaceFade ? BF.view.spaceFade() : 0;
    if (space > 0) { zenith.lerp(SPACE, space); horizon.lerp(SPACE, space); }

    const cam = BF.camera;
    root.position.copy(cam.position);
    celestial.rotation.z = a;
    celestial.rotation.y = 0.35 + planetSunYaw(cam);
    root.updateMatrixWorld(true);
    sun.getWorldPosition(tmpV).sub(cam.position).normalize();

    const u = dome.material.uniforms;
    u.top.value.copy(zenith); u.hor.value.copy(horizon);
    u.glowCol.value.copy(glow); u.glowAmt.value = dusk * 0.85 * (1 - wr);
    u.sunDir.value.copy(tmpV);

    scene.background.copy(horizon);
    scene.fog.color.copy(horizon);
    // on the planet the distant terrain (js/lod.js) carries the view on past the loaded chunks, so the fog moves out to its edge
    const d = Math.max(((BF.world && BF.world.viewDist) || 6) * BF.CS, BF.lod ? BF.lod.radius() : 0);
    // high above the ground (peaks, flying over the mile-high plains) the fog moves out by the height above the ground, so the land below stays visible
    let above = 0;
    if (cam && BF.world && BF.world.heightAt) {
      let g = BF.world.heightAt(cam.position.x, cam.position.z);
      if (g < BF.MIN_Y && BF.worldgen && BF.worldgen.heightAt) { try { g = BF.worldgen.heightAt(Math.floor(cam.position.x), Math.floor(cam.position.z)); } catch (_) { g = BF.SEA; } }   // before the first world exists
      let ref = Math.max(g, BF.SEA);
      ref = Math.min(ref, regionGround);   // the regional ground level (see updateCloudBase): steep peaks drop away fast
      above = Math.max(0, cam.position.y - ref - 24);
    }
    scene.fog.near = d * 0.5 * (1 - 0.45 * wr - 0.15 * wt) + above; scene.fog.far = d * 0.95 * (1 - 0.25 * wr - 0.1 * wt) + above;
    if (cam && cam.far < scene.fog.far + 64) { cam.far = scene.fog.far + 64; cam.updateProjectionMatrix(); }
    if (BF.player && BF.player.headInWater) {
      // dense blue fog when the camera is underwater
      scene.fog.color.setRGB(0.08, 0.2, 0.42).multiplyScalar(0.4 + 0.6 * sky.light);
      scene.background.copy(scene.fog.color);
      scene.fog.near = 1; scene.fog.far = 18;
    }

    // sun / moon / stars
    sun.material.opacity = smooth(-0.12, 0.02, sh) * (1 - wr);
    moon.material.opacity = (0.25 + 0.75 * smooth(-0.02, 0.15, -sh)) * (1 - wr);
    moon.visible = sh < 0.25 && wr < 0.99;
    sun.visible = sh > -0.15 && wr < 0.99;
    const so = Math.max((1 - smooth(0.05, 0.45, dayness)) * (1 - wr), space);   // stars come out as dusk darkens, and in space
    stars.material.uniforms.opacity.value = so;
    stars.material.uniforms.size.value = Math.max(1, Math.round(BF.renderer.getPixelRatio() * 2));
    stars.visible = so > 0.01;

    // volumetric clouds: mesh moves in whole cells with the camera, sub-cell scroll through position (see makeClouds)
    updateCloudBase(dt);
    // Cover: clear spells to scattered to broken over a day or two; rain forces overcast. Height: base + a rise
    // (never below the base) that is mostly small and sometimes large, and rain pulls the cloud deck back down.
    const T = day + t, cs = ((BF.state && BF.state.seed) | 0);
    const wanted = smooth(0.5, 0.88, vnoise(T / 1.4, cs));               // 0 = clear sky
    const cover = wanted + (1 - wanted) * wr;
    const rise = smooth(0.4, 0.9, vnoise(T / 2.1 + 31.7, cs + 1)) * CLOUD_RISE * (1 - 0.8 * wr);
    sky.cloudCover = cover; sky.cloudHeight = cloudY = sky.cloudBase + rise;
    const onFace = BF.planet.face(cam.position.x, cam.position.z) >= 0;
    if (onFace) planetClouds();
    clouds.userData.setCoverage(cover < 0.06 ? 1 : 0.96 - 0.62 * cover);
    if (onFace) planetCloudSync(cam, dt);
    else { planetFace = -1; clouds.userData.sync(cam.position.x, cam.position.z, cloudDrift, cloudY); }
    const cu = clouds.material.uniforms;
    cu.cam.value.set(cam.position.x - clouds.position.x, cam.position.z - clouds.position.z);
    cloudCol.copy(CLOUD_NIGHT).lerp(CLOUD_DAY, dayness).lerp(tmpC.copy(CLOUD_DUSK).multiplyScalar(0.25 + 0.75 * dayness), dusk * 0.45);
    if (wr > 0) cloudCol.lerp(tmpC.setRGB(wg * 1.05, wg * 1.08, wg * 1.12), wr * 0.85);
    if (wf > 0) cloudCol.lerp(tmpC.setRGB(0.9, 0.92, 1), wf * 0.7);
    cu.color.value.copy(cloudCol);
    cu.fogCol.value.copy(horizon);
    cu.under.value = cam.position.y < cloudY ? 1 : 0;
}

BF.sky = sky;
})();
