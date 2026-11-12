// Blockfield 1.6, the realistic look: js/real/turf.js, the blades of short grass on turf (docs/REALISTIC_CONTRACT.md section 4).
// Drawing only; nothing here runs unless BF.real.on. The smooth terrain draws turf (the grass block's top) as a texture of short
// grass; this module stands real blades on it around the player, so the ground under the feet is grass and not a painted surface:
// tufts of a few thin blades, a sixth of a block tall, scattered over the terrain's own triangles wherever they are turf, coloured
// and lit like the ground under them, swaying a little in the wind. Further out the blades shrink into the ground and the texture
// takes over. Bare soil (a dug hole, its walls) has none, so digging takes the grass off and regrowth brings it back.
// It reads the terrain meshes js/world.js shows (the `mat` attribute: the 4 layers' weights, adding up to 1 + the share of turf,
// js/real/mesh.js) and builds one mesh per chunk near the player, again whenever that chunk's ground is meshed again.
//   BF.real.turf = { config, stats() -> { chunks, tufts, triangles, builds }, rebuild() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;
const T = THREE, real = BF.real;

const config = {
  range: [0, 11, 15],        // blocks from the eye at which the blades are gone, by BF.real.quality.level (0: none)
  density: [0, 26, 44],      // tufts per block of turf, by quality level
  blades: 3,                 // blades a tuft
  height: 0.19, width: 0.042,
  perFrame: 1,               // chunks built per frame at most
};

let scene = null, mat = null, level = -1, builds = 0;
const live = new Map();   // chunk key -> { mesh, src: the ground geometry it was built from, tufts }
const uFade = { value: new T.Vector2(8, 13) };

function material() {
  if (mat) return mat;
  mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: T.DoubleSide });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTurfFade = uFade; sh.uniforms.uWet = real.U.uWet;
    // a blade shrinks into the ground with distance: `rise` is the way from its root to this vertex
    sh.vertexShader = "attribute vec3 rise;\nuniform vec2 uTurfFade;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
{
  float bfD = length((modelViewMatrix * vec4(position - rise, 1.0)).xyz);
  transformed -= rise * smoothstep(uTurfFade.x, uTurfFade.y, bfD);
}`);
    // both sides of a blade take the ground's light (the normal is the ground's, not the blade's)
    sh.fragmentShader = "uniform float uWet;\n" + sh.fragmentShader
      .replace("#include <normal_fragment_maps>", "normal = normalize(vNormal);\n#include <normal_fragment_maps>")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.55, uWet);");
  };
  real.lit(mat, { light: "vertex", wind: true, key: "turf" });
  return mat;
}

// a small generator, seeded per chunk, so a chunk's grass is the same every time it is built
const rng = seed => { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const lin = v => Math.pow(Math.max(0, v), 2.2);

// The blades over one chunk's ground geometry (chunk-local, like the ground). Returns null when the chunk has no turf.
function build(g, ox, oz, density) {
  const A = g.attributes, P = A.position.array, N = A.normal.array, C = A.color.array, M = A.mat.array, SK = A.skyl.array, BL = A.bl.array, I = g.index.array;
  const W = BF.world, SOLID = BF.SOLID, FLUID = BF.FLUID;
  const rnd = rng(Math.imul(ox | 0, 73856093) ^ Math.imul(oz | 0, 19349663) ^ 0x51ed);
  const nb = config.blades, H = config.height, HW = config.width / 2;
  const share = v => Math.max(0, Math.min(1, M[v * 4] + M[v * 4 + 1] + M[v * 4 + 2] + M[v * 4 + 3] - 1));
  // first the triangles that are turf and how many tufts each gets, then the arrays, once, at their full size
  const nT = I.length / 3, cnt = new Uint8Array(nT);
  let most = 0;
  for (let t = 0; t < nT; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    if (share(a) + share(b) + share(c) < 0.05) continue;
    if (N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1] < 1.8) continue;   // too steep for a sward
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    // not under water, and not up through something that lies on the ground
    const over = W.getBlock(Math.floor(ox + ax + (ux + vx) / 3), Math.floor(ay + (uy + vy) / 3 + 0.3), Math.floor(oz + az + (uz + vz) / 3));
    if (over && (FLUID[over] || SOLID[over])) continue;
    const cl = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (Math.abs(uz * vx - ux * vz) < 0.8 * cl) continue;   // the face itself leans too far (the lip of turf over a cut has no blades)
    const n = 0.5 * cl * density;
    cnt[t] = Math.min(255, Math.floor(n) + (rnd() < n - Math.floor(n) ? 1 : 0));
    most += cnt[t];
  }
  if (!most) return null;
  const NV = most * nb * 3;
  const pos = new Float32Array(NV * 3), nrm = new Float32Array(NV * 3), col = new Float32Array(NV * 3), rise = new Float32Array(NV * 3);
  const sky = new Float32Array(NV), bl = new Float32Array(NV), sway = new Float32Array(NV);
  let tufts = 0, o = 0;   // o: the next vertex
  for (let t = 0; t < nT; t++) {
    let n = cnt[t];
    if (!n) continue;
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const ta = share(a), tb = share(b), tc = share(c);
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    for (; n > 0; n--) {
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const w0 = 1 - r1 - r2, turf = w0 * ta + r1 * tb + r2 * tc, thin = rnd(), size = 0.55 + 0.45 * rnd(), tone = 0.78 + 0.3 * rnd(), dry = rnd(), lean = rnd() * 6.2832;
      if (thin > turf * turf) continue;   // (sparse where turf thins out into bare ground)
      const x = ax + ux * r1 + vx * r2, y = ay + uy * r1 + vy * r2, z = az + uz * r1 + vz * r2;
      let nx = w0 * N[a * 3] + r1 * N[b * 3] + r2 * N[c * 3], ny = w0 * N[a * 3 + 1] + r1 * N[b * 3 + 1] + r2 * N[c * 3 + 1], nz = w0 * N[a * 3 + 2] + r1 * N[b * 3 + 2] + r2 * N[c * 3 + 2];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      // the ground's colour as the terrain draws it (linear, times 0.5), a little yellower on a dry tuft
      const dr = dry > 0.72 ? (dry - 0.72) / 0.28 : 0;
      const cr = lin(w0 * C[a * 3] + r1 * C[b * 3] + r2 * C[c * 3]) * 0.5 * tone * (0.9 + 0.3 * dr);
      const cg = lin(w0 * C[a * 3 + 1] + r1 * C[b * 3 + 1] + r2 * C[c * 3 + 1]) * 0.5 * tone * (1 + 0.08 * dr);
      const cb = lin(w0 * C[a * 3 + 2] + r1 * C[b * 3 + 2] + r2 * C[c * 3 + 2]) * 0.5 * tone * (0.82 - 0.2 * dr);
      const sk = w0 * SK[a] + r1 * SK[b] + r2 * SK[c], blv = w0 * BL[a] + r1 * BL[b] + r2 * BL[c];
      const hgt = H * size * (0.5 + 0.5 * turf);
      for (let k = 0; k < nb; k++) {
        const ang = lean + k * 6.2832 / nb + (rnd() - 0.5) * 1.2, dx = Math.cos(ang), dz = Math.sin(ang);
        const h = hgt * (0.65 + 0.35 * rnd()), out = h * (0.25 + 0.55 * rnd()), off = 0.03 * rnd();
        // root: two points across the blade's lean; tip: up along the ground's normal and out along the lean
        const bx = x + dx * off, by = y - 0.012, bz = z + dz * off;
        const tx = nx * h + dx * out, ty = ny * h, tz = nz * h + dz * out;
        let p = o * 3;
        pos[p] = bx - dz * HW; pos[p + 1] = by; pos[p + 2] = bz + dx * HW;
        pos[p + 3] = bx + dz * HW; pos[p + 4] = by; pos[p + 5] = bz - dx * HW;
        pos[p + 6] = bx + tx; pos[p + 7] = by + ty; pos[p + 8] = bz + tz;
        rise[p + 6] = tx; rise[p + 7] = ty + 0.012; rise[p + 8] = tz;
        for (let q = 0; q < 3; q++, p += 3, o++) {
          const f = q === 2 ? 1.25 : 0.5;   // dark at the root, light at the tip
          nrm[p] = nx; nrm[p + 1] = ny; nrm[p + 2] = nz; col[p] = cr * f; col[p + 1] = cg * f; col[p + 2] = cb * f;
          sky[o] = sk; bl[o] = blv; sway[o] = q === 2 ? h * 1.6 : 0;
        }
      }
      tufts++;
    }
  }
  if (!tufts) return null;
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new T.BufferAttribute(nrm, 3));
  geo.setAttribute("color", new T.BufferAttribute(col, 3));
  geo.setAttribute("skyl", new T.BufferAttribute(sky, 1));
  geo.setAttribute("bl", new T.BufferAttribute(bl, 1));
  geo.setAttribute("rise", new T.BufferAttribute(rise, 3));
  geo.setAttribute("sway", new T.BufferAttribute(sway, 1));
  geo.setDrawRange(0, o);
  geo.boundingSphere = g.boundingSphere ? g.boundingSphere.clone() : new T.Sphere(new T.Vector3(8, 64, 8), 200);
  geo.boundingSphere.radius += 0.5;
  return { geo, tufts };
}

function drop(key) {
  const e = live.get(key);
  if (!e) return;
  if (e.mesh) { scene.remove(e.mesh); e.mesh.geometry.dispose(); }
  live.delete(key);
}

function init(ctx) { scene = (ctx && ctx.scene) || BF.scene; }

const want = new Map();
function frame() {
  const W = BF.world, p = BF.player && BF.player.position;
  if (!scene || !W || !p || !W.chunkC) return;
  const q = Math.max(0, Math.min(2, real.quality.level | 0));
  if (q !== level) { level = q; for (const k of [...live.keys()]) drop(k); }
  const range = config.range[q], density = config.density[q];
  uFade.value.set(range * 0.55, range);
  want.clear();
  if (range > 0 && density > 0) {
    const CS = 16, c0x = Math.floor((p.x - range) / CS), c1x = Math.floor((p.x + range) / CS), c0z = Math.floor((p.z - range) / CS), c1z = Math.floor((p.z + range) / CS);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      // (only chunks the range reaches: the nearest point of the chunk's square)
      const ddx = Math.max(cx * CS - p.x, 0, p.x - (cx + 1) * CS), ddz = Math.max(cz * CS - p.z, 0, p.z - (cz + 1) * CS);
      if (ddx * ddx + ddz * ddz > range * range) continue;
      let c = null;
      try { c = W.chunkC(cx, cz); } catch (_) { /* not loaded */ }
      if (!c || !c.meshes) continue;
      let ground = null;
      for (const m of c.meshes) if (m.geometry && m.geometry.attributes.mat && m.geometry.index) { ground = m; break; }
      if (!ground) continue;
      // (the eye is rarely more than a few blocks over the grass it can see as blades)
      const g = ground.geometry;
      if (!g.boundingSphere) continue;
      const dy = p.y - g.boundingSphere.center.y;
      if (Math.abs(dy) > g.boundingSphere.radius + range) continue;
      want.set(c.key, ground);
    }
  }
  for (const k of [...live.keys()]) if (!want.has(k)) drop(k);
  let built = 0;
  for (const [key, ground] of want) {
    const e = live.get(key);
    if (e && e.src === ground.geometry) continue;
    if (built >= config.perFrame) continue;   // (a chunk meshed again keeps its old blades for a frame or two)
    built++;
    drop(key);
    const r = build(ground.geometry, ground.position.x, ground.position.z, density);
    let mesh = null;
    if (r) {
      mesh = new T.Mesh(r.geo, material());
      mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
      mesh.position.copy(ground.position); mesh.updateMatrix();
      mesh.userData.turf = true;
      scene.add(mesh);
    }
    live.set(key, { mesh, src: ground.geometry, tufts: r ? r.tufts : 0 });
    builds++;
  }
}

real.turf = {
  config,
  stats() {
    let chunks = 0, tufts = 0;
    for (const e of live.values()) if (e.mesh) { chunks++; tufts += e.tufts; }
    return { chunks, tufts, triangles: tufts * config.blades, builds };
  },
  rebuild() { for (const k of [...live.keys()]) drop(k); },
};
real.module({ name: "turf", init, frame });
})();
