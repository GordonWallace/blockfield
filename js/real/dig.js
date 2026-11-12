// Blockfield 1.6, the realistic look: digging smooth ground (docs/REALISTIC_CONTRACT.md). Drawing only; nothing here runs unless
// BF.real.on. Natural ground (BF.real.assets.ground) is drawn as one smooth surface, not as cubes, so the cube-shaped crack overlay
// of js/cracks.js has nothing to sit on. While such a block is mined this module draws the wear on the ground itself instead:
// the triangles of the smooth terrain around the block are drawn again with a shader that works a hollow into them (a darker,
// freshly turned patch that widens with progress, shaded like a dent against the sun, a pushed-up rim on loose ground, fractures
// on rock), and every hit throws up chips of the ground's own colour, lit like the ground. Blocks that are still cubes keep
// the cube overlay.
//   BF.real.dig.covers(id) -> true when block id is drawn by the smooth terrain pass
//   BF.real.dig.show(x, y, z, id, progress, normal) -> true when the effect is drawn (false: not smooth ground, or no surface found)
//   BF.real.dig.hit(normal)            a hit tick: chips off the patch and a short pulse
//   BF.real.dig.burst(x, y, z, id) -> true when it threw the breaking burst (false: not smooth ground)
//   BF.real.dig.hide()
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;
const T = THREE, real = BF.real;

const R = 0.92;             // the patch: the smooth surface inside this distance of the block's centre
const MAX_TRI = 320, POOL = 96;

// ---------- which blocks are smooth ground ----------
let tab = null;
const tables = () => tab || (tab = real.meshTables ? real.meshTables() : null);
const groundOf = id => { const t = tables(); return t && t.NAT[id] ? t.NAT[id] - 1 : -1; };

// ---------- the patch ----------
let mesh = null, geo = null, posArr = null, nrmArr = null, mat = null, scene = null;
let curKey = "", nTri = 0, pulse = 0, shown = false;
const centre = new T.Vector3(), sunL = new T.Vector3(), m3 = new T.Matrix3();

const VS = `
attribute vec3 normal0;
varying vec3 vP;
varying vec3 vN;
void main() {
  vP = position; vN = normal0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// The output is multiplied onto what is already drawn (2 x source x destination): 0.5 leaves the ground as it is.
const FS = `
uniform float uProg, uPulse, uSeed;
uniform vec4 uLayer;      // soil and turf, rock, sand and gravel, snow and ice
uniform vec3 uSun;        // towards the light, in the patch's own frame
varying vec3 vP;
varying vec3 vN;
float h13(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// distance to the nearest cell wall of a 3D cell pattern, and that cell's hash
vec2 walls(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = vec3(h13(i + g), h13(i + g + 17.3), h13(i + g + 41.7));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = o.x; } else if (d < d2) d2 = d;
  }
  return vec2(d2 - d1, id);
}
void main() {
  vec3 n = normalize(vN);
  float q = clamp((length(vP) - 0.42) / (${R.toFixed(2)} - 0.42), 0.0, 1.0);   // 0 on the block, 1 at the patch's edge
  vec3 pr = vec3(vP.x * 0.8 + vP.z * 0.6, vP.y, vP.z * 0.8 - vP.x * 0.6);   // (off the block grid, so the noise shows no lattice)
  float n1 = vnoise(pr * 3.3 + uSeed), n2 = 0.6 * vnoise(pr * 13.0 + uSeed * 1.7) + 0.4 * vnoise(pr.zxy * 23.0 + uSeed), n3 = 0.5 * vnoise(pr.yzx * 37.0 + uSeed) + 0.5 * vnoise(pr * 61.0);
  float qn = q + (n1 - 0.5) * 0.34 + (n2 - 0.5) * 0.1;
  float edge = smoothstep(1.0, 0.82, q);
  float a = mix(0.25, 0.8, sqrt(clamp(uProg, 0.0, 1.0))) + 0.04 * uPulse;      // how far the hollow reaches
  float hollow = smoothstep(a, a - 0.34, qn) * edge;
  float band = hollow * (1.0 - hollow) * 4.0;                                  // its wall
  float loose = uLayer.x + uLayer.z + uLayer.w, rock = uLayer.y;
  float depth = 0.35 + 0.65 * uProg;

  float g = 0.5;
  // freshly turned ground is darker (damp soil, shaded sand); rock only bruises
  g -= hollow * depth * (0.17 * uLayer.x + 0.07 * rock + 0.12 * uLayer.z + 0.10 * uLayer.w);
  // the hollow's wall against the light: the side nearer the sun faces away from it
  vec3 rad = vP - n * dot(vP, n); float rl = length(rad);
  vec3 sunT = uSun - n * dot(uSun, n);
  float lit = rl > 1e-4 ? dot(rad / rl, sunT) : 0.0;
  g -= band * depth * lit * (0.20 * loose + 0.10 * rock);
  g -= band * depth * 0.05;
  // loose ground: clods and pits in the hollow, and a paler pushed-up rim around it
  float pits = smoothstep(0.45, 0.75, n2) * 0.55 + smoothstep(0.5, 0.8, n3) * 0.45;
  g -= hollow * depth * (pits - 0.25) * 0.2 * loose;
  float rim = smoothstep(a - 0.06, a + 0.04, qn) * smoothstep(a + 0.3, a + 0.08, qn) * edge;
  g += rim * depth * 0.03 * loose * (0.5 + n2);
  // rock: fractures that run out from the middle as the block gives, with chipped pale edges
  if (rock > 0.01) {
    vec2 w = walls(pr * 3.3 + uSeed), w2 = walls(pr.zxy * 7.5 + uSeed);
    float born = q * 0.9 + w.y * 0.3;
    float open = smoothstep(born, born + 0.1, uProg * 1.25 + 0.05) * edge;
    float wide = 0.02 + 0.035 * uProg * (1.0 - q);                    // wider where the blows land
    float line = smoothstep(wide + 0.02, wide * 0.4, w.x) * open;
    float hair = smoothstep(0.035, 0.008, w2.x) * open * smoothstep(0.35, 0.9, uProg) * (1.0 - line);
    float chip = smoothstep(wide + 0.11, wide + 0.03, w.x) * (1.0 - line) * open;
    g -= line * (0.26 + 0.1 * n2) * rock;
    g -= hair * 0.12 * rock;
    g += chip * 0.04 * rock;
    g -= open * step(0.7, w.y) * 0.06 * rock * uProg;   // a few loosened pieces sit darker
  }
  g += 0.035 * uPulse * hollow;
  gl_FragColor = vec4(vec3(clamp(g, 0.0, 1.0)), 1.0);
}`;

function init(ctx) {
  scene = (ctx && ctx.scene) || BF.scene;
  if (mesh || !scene) return;
  geo = new T.BufferGeometry();
  posArr = new Float32Array(MAX_TRI * 9); nrmArr = new Float32Array(MAX_TRI * 9);
  geo.setAttribute("position", new T.BufferAttribute(posArr, 3).setUsage(T.DynamicDrawUsage));
  geo.setAttribute("normal0", new T.BufferAttribute(nrmArr, 3).setUsage(T.DynamicDrawUsage));
  geo.boundingSphere = new T.Sphere(new T.Vector3(), R + 0.5);
  mat = new T.ShaderMaterial({
    vertexShader: VS, fragmentShader: FS,
    uniforms: { uProg: { value: 0 }, uPulse: { value: 0 }, uSeed: { value: 0 }, uLayer: { value: new T.Vector4(1, 0, 0, 0) }, uSun: { value: new T.Vector3(0.4, 0.8, 0.3) } },
    transparent: true, depthWrite: false, fog: false, side: T.FrontSide,
    blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.DstColorFactor, blendDst: T.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  mesh = new T.Mesh(geo, mat);
  mesh.visible = false; mesh.renderOrder = 3; mesh.frustumCulled = false;
  // the light in the patch's own frame (js/view.js places the patch in render space each frame)
  mesh.onBeforeRender = () => {
    m3.setFromMatrix4(mesh.matrixWorld).transpose();
    mat.uniforms.uSun.value.copy(sunL.copy(real.U.uSunDir.value).applyMatrix3(m3).normalize());
  };
  scene.add(mesh);
}

// The smooth terrain's triangles within R of the block's centre, copied relative to that centre.
function gather(x, y, z) {
  const W = BF.world, seen = new Set();
  nTri = 0;
  const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5, R2 = (R + 0.05) * (R + 0.05);
  for (let k = 0; k < 4; k++) {
    let c = null;
    try { c = W.chunkAt(Math.floor(cx + (k & 1 ? 1.2 : -1.2)), Math.floor(cz + (k & 2 ? 1.2 : -1.2))); } catch (_) { /* not loaded */ }
    if (!c || seen.has(c) || !c.meshes) continue;
    seen.add(c);
    for (const m of c.meshes) {
      const g = m.geometry, A = g && g.attributes;
      if (!A || !A.mat || !A.normal || !g.index) continue;   // (only the ground pass carries mat)
      const lx = cx - m.position.x, ly = cy - m.position.y, lz = cz - m.position.z;
      if (lx < -4 || lx > 20 || lz < -4 || lz > 20) continue;   // (a margin copy across a face edge: not this address)
      const P = A.position.array, N = A.normal.array, I = g.index.array;
      const near = i => { const dx = P[i * 3] - lx, dy = P[i * 3 + 1] - ly, dz = P[i * 3 + 2] - lz; return dx * dx + dy * dy + dz * dz < R2; };
      for (let t = 0; t < I.length && nTri < MAX_TRI; t += 3) {
        const a = I[t], b = I[t + 1], d = I[t + 2];
        // (cheap reject on height first: most of a chunk's triangles are nowhere near)
        if (Math.abs(P[a * 3 + 1] - ly) > 2.5 || !(near(a) || near(b) || near(d))) continue;
        let o = nTri * 9;
        for (const v of [a, b, d]) {
          posArr[o] = P[v * 3] - lx; posArr[o + 1] = P[v * 3 + 1] - ly; posArr[o + 2] = P[v * 3 + 2] - lz;
          nrmArr[o] = N[v * 3]; nrmArr[o + 1] = N[v * 3 + 1]; nrmArr[o + 2] = N[v * 3 + 2];
          o += 3;
        }
        nTri++;
      }
    }
  }
  geo.setDrawRange(0, nTri * 3);
  geo.attributes.position.needsUpdate = true; geo.attributes.normal0.needsUpdate = true;
  return nTri;
}

// ---------- chips ----------
// Small faceted pieces of the ground, lit as everything else in the look (real.lit, one sky / block light value a material).
const live = [], pool = [], chipMats = new Map();
let thrown = 0;   // chips thrown since the page loaded (tests: the live ones are gone within a second)
let chipGeo = null;
const cellL = new T.Vector2();
function chipMaterial(gi, x, y, z) {
  let m = chipMats.get(gi);
  if (!m) {
    const t = tables(), c = new T.Color(0.4, 0.3, 0.22);
    if (t) {
      // turf throws soil: a tinted ground (grass) takes the soil colour under it
      let k = gi;
      if (t.GTINT[gi] && BF.B.dirt != null && t.NAT[BF.B.dirt]) k = t.NAT[BF.B.dirt] - 1;
      c.setRGB(Math.pow(t.GCOL[k * 3], 2.2) * 0.5, Math.pow(t.GCOL[k * 3 + 1], 2.2) * 0.5, Math.pow(t.GCOL[k * 3 + 2], 2.2) * 0.5);   // (as the terrain shader takes it)
    }
    m = real.lit(new T.MeshStandardMaterial({ color: c, roughness: 0.95, metalness: 0, flatShading: true }), { light: "cell", key: "chip" });
    chipMats.set(gi, m);
  }
  real.cellLight(x, y, z, cellL);
  m.userData.cell.value.copy(cellL);
  return m;
}
function chip(m, px, py, pz, vx, vy, vz, size, life) {
  if (!chipGeo) chipGeo = new T.IcosahedronGeometry(0.05, 0);
  let p = pool.pop();
  if (!p) {
    if (live.length >= POOL) return;
    p = new T.Mesh(chipGeo, m);
    p.userData = {};
  }
  p.material = m;
  p.position.set(px, py, pz);
  p.scale.set(size * (0.7 + Math.random() * 0.8), size * (0.5 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.8));
  p.rotation.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3);
  const u = p.userData;
  u.vx = vx; u.vy = vy; u.vz = vz; u.life = life; u.spin = (Math.random() - 0.5) * 14;
  scene.add(p); live.push(p); thrown++;
}
function frame(dt) {
  if (pulse > 0) { pulse = Math.max(0, pulse - dt * 7); if (mat) mat.uniforms.uPulse.value = pulse; }
  if (!live.length || (BF.state && BF.state.paused)) return;
  dt = Math.min(0.05, dt);
  for (let i = live.length - 1; i >= 0; i--) {
    const p = live[i], u = p.userData;
    u.life -= dt; u.vy -= 18 * dt;
    p.position.x += u.vx * dt; p.position.z += u.vz * dt;
    p.rotation.x += u.spin * dt; p.rotation.z += u.spin * 0.6 * dt;
    const ny = p.position.y + u.vy * dt;
    let solid = false; try { solid = BF.world.isSolid(p.position.x, ny - 0.03, p.position.z); } catch (_) { /* unloaded */ }
    if (u.vy < 0 && solid) { u.vy = 0; u.vx *= 0.4; u.vz *= 0.4; u.spin *= 0.3; } else p.position.y = ny;
    if (u.life < 0.12) p.scale.multiplyScalar(Math.max(0, 1 - dt * 9));   // (they shrink away rather than pop)
    if (u.life <= 0) { scene.remove(p); live.splice(i, 1); pool.push(p); }
  }
}

// ---------- public ----------
let cur = { x: 0, y: 0, z: 0, gi: -1 };
real.dig = {
  covers: id => groundOf(id) >= 0,
  show(x, y, z, id, progress) {
    const gi = groundOf(id);
    if (gi < 0 || !mesh) { if (shown) this.hide(); return false; }
    const key = x + "," + y + "," + z + "," + id;
    if (key !== curKey) {
      curKey = key; cur = { x, y, z, gi };
      if (!gather(x, y, z)) { curKey = ""; mesh.visible = shown = false; return false; }
      centre.set(x + 0.5, y + 0.5, z + 0.5);
      const t = tables(), lay = t.GLAY[gi], L = mat.uniforms.uLayer.value;
      L.set(lay === 0 ? 1 : 0, lay === 1 ? 1 : 0, lay === 2 ? 1 : 0, lay === 3 ? 1 : 0);
      mat.uniforms.uSeed.value = ((((x * 73856093) ^ (y * 83492791) ^ (z * 19349663)) >>> 0) % 977) / 13;
    }
    mesh.position.copy(centre);
    mat.uniforms.uProg.value = Math.max(0, Math.min(1, progress));
    mesh.visible = shown = true;
    return true;
  },
  hit(normal) {
    if (!shown) return;
    pulse = 1; mat.uniforms.uPulse.value = 1;
    gather(cur.x, cur.y, cur.z);   // (the ground may have been meshed again since: a neighbour dug or placed)
    if (!nTri) return;
    const n = normal || [0, 1, 0];
    const m = chipMaterial(cur.gi, cur.x + n[0], cur.y + n[1], cur.z + n[2]);
    // off the surface inside the block's footprint, thrown along the ground's normal
    for (let i = 0, made = 0; i < 240 && made < 5; i++) {
      // a random point of a random triangle of the patch
      const o = Math.floor(Math.random() * nTri) * 9;
      let u = Math.random(), v = Math.random(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w = 1 - u - v;
      const px = posArr[o] * w + posArr[o + 3] * u + posArr[o + 6] * v, py = posArr[o + 1] * w + posArr[o + 4] * u + posArr[o + 7] * v, pz = posArr[o + 2] * w + posArr[o + 5] * u + posArr[o + 8] * v;
      if (px * px + py * py + pz * pz > 0.55) continue;
      const nx = nrmArr[o], ny = nrmArr[o + 1], nz = nrmArr[o + 2], out = 0.8 + Math.random() * 1.3;
      chip(m, centre.x + px + nx * 0.05, centre.y + py + ny * 0.05, centre.z + pz + nz * 0.05,
        nx * out + (Math.random() - 0.5) * 1.5, ny * out + 1.3 + Math.random() * 1.6, nz * out + (Math.random() - 0.5) * 1.5,
        0.5 + Math.random() * 0.7, 0.35 + Math.random() * 0.35);
      made++;
    }
  },
  // the block gave: a burst of its ground out of the hollow it leaves
  burst(x, y, z, id) {
    const gi = groundOf(id);
    if (gi < 0 || !scene) return false;
    const m = chipMaterial(gi, x, y + 1, z);
    for (let i = 0; i < 18; i++) {
      chip(m, x + 0.15 + Math.random() * 0.7, y + 0.25 + Math.random() * 0.6, z + 0.15 + Math.random() * 0.7,
        (Math.random() - 0.5) * 3, 1.4 + Math.random() * 3, (Math.random() - 0.5) * 3, 0.7 + Math.random() * 1.1, 0.45 + Math.random() * 0.4);
    }
    return true;
  },
  hide() { curKey = ""; pulse = 0; shown = false; if (mesh) mesh.visible = false; },
  get visible() { return shown; },
  get triangles() { return shown ? nTri : 0; },
  get chips() { return live.length; },
  get thrown() { return thrown; },
  get progress() { return shown && mat ? mat.uniforms.uProg.value : -1; },
};
real.module({ name: "dig", init, frame });
})();
