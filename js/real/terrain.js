// Blockfield 1.6, the realistic look: js/real/terrain.js. Owner: the Foundation thread (docs/REALISTIC_CONTRACT.md sections 4, 5).
// The ground table the mesher's smooth pass reads (which blocks are natural ground, their colour and detail layer) and the
// material that pass is drawn with. Drawing only. Nothing here may run unless BF.real.on.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
const T = THREE, real = BF.real;

// ---------- natural ground ----------
// layer: 0 soil and turf, 1 rock, 2 sand and gravel, 3 snow and ice. tint: the biome's grass colour multiplies the colour.
// The biome assets thread adds or replaces entries (a later entry for the same block wins).
const hex = h => { const c = new T.Color(h); return [c.r, c.g, c.b]; };
const G = real.assets.ground;
const add = (blocks, color, layer, tint) => G.push({ id: blocks[0], blocks, color: typeof color === "string" ? hex(color) : color, layer, tint: !!tint });
add(["grass"], [0.56, 0.58, 0.54], 0, true);
add(["dirt", "rooted_dirt", "farmland_soil"], "#6e4e36", 0);
add(["coarse_dirt"], "#6b523c", 2);
add(["dirt_path"], "#8a6a3e", 2);   // a village's trodden paths: part of the ground, a worn band through the turf
add(["podzol"], "#5a4126", 0);
add(["mycelium"], "#6f6470", 0);
add(["mud"], "#3c3632", 0);
add(["moss_block"], "#5a7a2e", 0);
add(["clay"], "#9aa3b0", 0);
add(["sand"], "#d6cb98", 2);
add(["red_sand"], "#b8622a", 2);
add(["gravel"], "#857f7c", 2);
add(["stone"], "#7d7d7d", 1);
add(["granite"], "#9a6b5a", 1);
add(["diorite"], "#bdbdbd", 1);
add(["andesite"], "#888888", 1);
add(["tuff"], "#6d6d62", 1);
add(["calcite"], "#dcdcd6", 1);
add(["dripstone_block"], "#866b5a", 1);
add(["deepslate"], "#505054", 1);
add(["sandstone"], "#d2c690", 1);
add(["red_sandstone"], "#b4602a", 1);
add(["terracotta"], "#98603f", 1);
add(["snow", "snow_block", "powder_snow"], "#f1f5f8", 3);
add(["snow_grass"], "#eef2f6", 3);
add(["packed_ice", "blue_ice"], "#a8c4ee", 3);
add(["bedrock"], "#333333", 1);

// The tables the mesher gets (js/world.js meshTables): NAT block -> ground index + 1, the ground's colours, layers and tints, and
// which blocks are tree logs (1), tree leaves (2) with the log they belong to, and ground plants with a registered model.
real.meshTables = function () {
  const n = BF.MAX_BLOCK + 1, NAT = new Uint8Array(n), TREE = new Uint8Array(n), SPEC = new Uint16Array(n), COVER = new Uint8Array(n);
  const B = BF.B;
  // ores take their rock's entry (the ore is found by digging, not by looking)
  const list = G.slice(0, 254);
  const GCOL = new Float32Array(list.length * 3), GLAY = new Uint8Array(list.length), GTINT = new Uint8Array(list.length);
  const GSIDE = new Uint8Array(list.length);
  list.forEach((g, i) => {
    const col = typeof g.color === "string" ? hex(g.color) : g.color || [0.5, 0.5, 0.5];
    GCOL[i * 3] = col[0]; GCOL[i * 3 + 1] = col[1]; GCOL[i * 3 + 2] = col[2]; GLAY[i] = g.layer | 0; GTINT[i] = g.tint ? 1 : 0;
    for (const name of g.blocks) if (B[name] != null) NAT[B[name]] = i + 1;
  });
  for (const b of BF.blocks) {
    if (!b || !/_ore$/.test(b.name)) continue;
    const host = /^deepslate_/.test(b.name) ? B.deepslate : B.stone;
    if (NAT[host]) NAT[b.id] = NAT[host];
  }
  for (const s of real.assets.species) {
    const log = B[s.log];
    if (log == null || s.kind === "plant") continue;
    const leaves = B[s.leaves || s.log.replace(/_log$/, "_leaves")];
    if (TREE[log]) continue;
    TREE[log] = s.leafless ? 3 : 1; SPEC[log] = log;
    if (!s.leafless && leaves != null) { TREE[leaves] = 2; SPEC[leaves] = log; }
  }
  for (const c of real.assets.cover) if (B[c.block] != null) COVER[B[c.block]] = 1;
  // Blocks that are ground in one biome and a building material everywhere else (terracotta is the badlands' rock and the savanna
  // villages' roofs; sandstone is the desert villages' walls): NATB is the table without them, used outside their home biome, so
  // what is built of them stays cubes. An entry can ask for the same with built: true.
  // GSIDE: the ground a cut through this one shows (js/real/mesh.js). Turf (a tinted entry) is green on top only: its side is the
  // soil under it. An entry can name another block with under: "name".
  list.forEach((g, i) => {
    const u = g.under || (g.tint ? "dirt" : null);
    GSIDE[i] = u && B[u] != null && NAT[B[u]] ? NAT[B[u]] - 1 : i;
  });
  const NATB = NAT.slice();
  for (const b of BF.blocks) if (b && NATB[b.id] && /terracotta|sandstone/.test(b.name)) NATB[b.id] = 0;
  list.forEach(g => { if (g.built) for (const name of g.blocks) if (B[name] != null) NATB[B[name]] = 0; });
  return { NAT, NATB, TREE, SPEC, COVER, GCOL, GLAY, GTINT, GSIDE };
};

// ---------- the detail texture ----------
// One tiling texture, a layer a channel: r soil and turf, g rock, b sand and gravel, a snow. It repeats every 4 blocks, so
// chunk-local coordinates line up across chunks.
function detailTexture() {
  const S = 256, d = new Uint8Array(S * S * 4);
  // tiling value noise
  const lat = (seed, n) => { const a = new Float32Array(n * n); let s = seed >>> 0; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; };
  const noise = (a, n, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const g = (i, j) => a[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
    return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v;
  };
  const L = [8, 16, 32, 64, 128].map((n, i) => [lat(977 + i * 131, n), n]);
  const fbm = (x, y, from, sharp) => { let s = 0, w = 0, amp = 1; for (let o = from; o < L.length; o++) { let v = noise(L[o][0], L[o][1], x * L[o][1], y * L[o][1]); if (sharp) v = 1 - Math.abs(2 * v - 1); s += v * amp; w += amp; amp *= 0.55; } return s / w; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, o = (y * S + x) * 4;
    const soil = 0.7 * fbm(u, v, 1, false) + 0.3 * fbm(u + 0.37, v + 0.11, 2, false);
    const rock = 0.6 * fbm(u, v * 1.0, 0, true) + 0.4 * fbm(u + 0.5, v + 0.2, 2, false);
    const sand = 0.6 * fbm(u, v, 2, false) + 0.4 * noise(L[4][0], 128, u * 128 + 0.5, v * 128 + 0.5);
    const snow = 0.8 * fbm(u, v, 0, false) + 0.2 * fbm(u, v, 3, false);
    d[o] = soil * 255; d[o + 1] = rock * 255; d[o + 2] = sand * 255; d[o + 3] = snow * 255;
  }
  const t = new T.DataTexture(d, S, S, T.RGBAFormat);
  t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

// ---------- the turf texture ----------
// Short grass seen from above: tens of thousands of blades, each a short stroke that is dark at its root and light at its tip, lying
// in loosely combed tufts, drawn over each other from the lowest to the highest. r: how light the blade is, g: how dry (yellow) it
// is, b: its height (0 the shaded soil between tufts .. 1 a tip). It repeats every 1.6 blocks (10 times a chunk), so chunk-local
// coordinates line up across chunks.
function turfTexture() {
  const S = 512, N = S * S, R = new Float32Array(N).fill(0.3), Gd = new Float32Array(N).fill(0.5), H = new Float32Array(N);
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  // a tiling field for the lie of the tufts and for dry patches
  const n = 16, lat = new Float32Array(n * n * 2);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const field = (x, y, c) => {
    const fx = x * n / S, fy = y * n / S, xi = Math.floor(fx), yi = Math.floor(fy), u = fx - xi, v = fy - yi;
    const g = (i, j) => lat[((((j % n) + n) % n) * n + (((i % n) + n) % n)) * 2 + c];
    return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v;
  };
  // tufts: a few blades fanning out from one root, leaning the way the field combs them
  const blades = [];
  for (let t = 0; t < 4200; t++) {
    const cx = rnd() * S, cy = rnd() * S, lean = field(cx, cy, 0) * 9 + (rnd() - 0.5) * 1.2, size = 0.55 + 0.45 * rnd(), toneT = 0.6 + 0.4 * rnd();
    const dryT = 0.5 + (field(cx, cy, 1) - 0.5) * 1.3 + (rnd() - 0.5) * 0.25, nb = 8 + Math.floor(rnd() * 7);
    for (let i = 0; i < nb; i++) {
      const hgt = size * (0.45 + 0.55 * rnd());
      blades.push([hgt, cx + (rnd() - 0.5) * 16, cy + (rnd() - 0.5) * 16, lean + (rnd() - 0.5) * 2.6, Math.max(0, Math.min(1, dryT + (rnd() - 0.5) * 0.12)), toneT * (0.88 + 0.12 * rnd()), (rnd() - 0.5) * 0.07]);
    }
  }
  blades.sort((a, b) => a[0] - b[0]);   // low blades first, so the tall ones lie over them
  for (const [hgt, x0, y0, ang, dry, tone, bend] of blades) {
    const len = 16 + 34 * hgt;
    let px = x0, py = y0, vx = Math.cos(ang), vy = Math.sin(ang);
    for (let t = 0; t <= len; t++) {
      const f = t / len, half = f < 0.45 ? 1.5 : f < 0.8 ? 1 : 0.5;   // (three pixels wide at the root, one at the tip)
      const light = tone * (0.3 + 0.7 * f), hh = 0.12 + 0.88 * hgt * (0.3 + 0.7 * f);
      for (let w = -half; w <= half; w += 0.5) {
        const qx = ((Math.round(px - vy * w) % S) + S) % S, qy = ((Math.round(py + vx * w) % S) + S) % S, o = qy * S + qx;
        if (hh < H[o]) continue;
        H[o] = hh; R[o] = light * (1 - 0.22 * Math.abs(w) / 1.5 - (w < 0 ? 0.1 : 0)); Gd[o] = dry;   // (one edge of a blade is in its own shade)
      }
      const c = Math.cos(bend), sn = Math.sin(bend), nx = vx * c - vy * sn; vy = vx * sn + vy * c; vx = nx;
      px += vx; py += vy;
    }
  }
  // soften by one pixel: a blade's edge is not a staircase
  for (const A of [R, Gd, H]) {
    const B2 = new Float32Array(N);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const xm = (x + S - 1) % S, xp = (x + 1) % S, ym = ((y + S - 1) % S) * S, yp = ((y + 1) % S) * S, y0 = y * S;
      B2[y0 + x] = 0.4 * A[y0 + x] + 0.1 * (A[y0 + xm] + A[y0 + xp] + A[ym + x] + A[yp + x]) + 0.05 * (A[ym + xm] + A[ym + xp] + A[yp + xm] + A[yp + xp]);
    }
    A.set(B2);
  }
  const d = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) { d[i * 4] = R[i] * 255; d[i * 4 + 1] = Gd[i] * 255; d[i * 4 + 2] = H[i] * 255; d[i * 4 + 3] = 255; }
  const t = new T.DataTexture(d, S, S, T.RGBAFormat);
  t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8; t.needsUpdate = true;
  return t;
}
real.turfTexture = turfTexture;   // (tests)

// ---------- the material ----------
// The mesher's mat attribute holds the 4 layers' weights, adding up to 1 + the share of turf at the vertex (js/real/mesh.js): turf is
// soil's layer, drawn as short grass.
let mat = null;
real.terrainMaterial = function () {
  if (mat) return mat;
  const detail = { value: detailTexture() }, turf = { value: turfTexture() };
  mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uDetail = detail; sh.uniforms.uTurf = turf; sh.uniforms.uWet = real.U.uWet;
    sh.vertexShader = "attribute vec4 mat;\nvarying vec4 vMat;\nvarying vec3 vLp;\nvarying vec3 vLn;\n" +
      sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvMat = mat; vLp = position; vLn = normal;");
    sh.fragmentShader = "uniform sampler2D uDetail;\nuniform sampler2D uTurf;\nuniform float uWet;\nvarying vec4 vMat;\nvarying vec3 vLp;\nvarying vec3 vLn;\n" +
      `float bfDetail(vec3 p, vec3 w, vec4 m, float s) {
        vec4 tx = texture2D(uDetail, p.zy * s), ty = texture2D(uDetail, p.xz * s), tz = texture2D(uDetail, p.xy * s);
        return dot(tx * w.x + ty * w.y + tz * w.z, m);
      }
      // how much of the ground here is turf: the vertices' share, with a ragged edge where turf meets bare ground
      float bfTurf(float share, vec4 g) { return smoothstep(0.3, 0.7, share + (g.b - 0.45) * 0.7 * step(0.001, share) * step(share, 0.999)); }\n` +
      sh.fragmentShader
        .replace("#include <color_fragment>", `#include <color_fragment>
{
  vec3 bw = pow(abs(normalize(vLn)), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
  float ms = max(1e-3, vMat.x + vMat.y + vMat.z + vMat.w);
  vec4 m = vMat / ms;
  vec4 g1 = texture2D(uTurf, vLp.xz * 0.625), g2 = texture2D(uTurf, vLp.zx * 0.3125 + 0.37);
  float turf = bfTurf(clamp(ms - 1.0, 0.0, 1.0), g1);
  // steep turf shows the rock under it; steep soil (a bank, the wall of a dug hole) stays soil
  float steep = smoothstep(0.62, 0.42, normalize(vLn).y);
  float d1 = bfDetail(vLp, bw, m, 0.25), d2 = bfDetail(vLp, bw, m, 0.031);
  vec3 c = pow(diffuseColor.rgb, vec3(2.2));
  c = mix(c, vec3(0.19, 0.18, 0.17), steep * m.x * mix(0.2, 0.75, turf));
  vec3 bare = c * 0.5 * (0.7 + 0.6 * d1) * (0.7 + 0.6 * d2);
  // short grass: blades light at the tip over dark roots, some drier than others, in patches a few blocks across
  float pch = texture2D(uDetail, vLp.xz * 0.0625).r, dry = clamp(g1.g * 0.35 + g2.g * 0.65 + (pch - 0.5) * 1.1, 0.0, 1.0);
  vec3 blade = c * mix(vec3(0.84, 1.0, 0.8), vec3(1.16, 1.08, 0.68), smoothstep(0.3, 0.95, dry));
  blade *= 0.5 * (0.2 + 0.6 * g1.r + 1.1 * g2.r) * (0.78 + 0.44 * d2);
  c = mix(bare, blade, turf * (1.0 - steep * 0.6));
  c = mix(c, c * 0.55, uWet * (1.0 - m.w));
  diffuseColor.rgb = c;
}`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
{
  vec3 bw = pow(abs(normalize(vLn)), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
  float ms = max(1e-3, vMat.x + vMat.y + vMat.z + vMat.w);
  vec4 m = vMat / ms;
  vec4 g1 = texture2D(uTurf, vLp.xz * 0.625);
  float turf = bfTurf(clamp(ms - 1.0, 0.0, 1.0), g1);
  float h = mix(bfDetail(vLp, bw, m, 0.25), g1.b * 1.6, turf);
  vec3 dp1 = dFdx(-vViewPosition), dp2 = dFdy(-vViewPosition);
  float dh1 = dFdx(h), dh2 = dFdy(h);
  vec3 r1 = cross(dp2, normal), r2 = cross(normal, dp1);
  float det = dot(dp1, r1);
  vec3 grad = sign(det) * (dh1 * r1 + dh2 * r2);
  float amt = 0.05 * (m.x + m.y * 1.8 + m.z * 0.5 + m.w * 0.2);
  normal = normalize(abs(det) * normal - amt * grad);
}`);
  };
  real.lit(mat, { light: "vertex", key: "terrain" });
  return mat;
};
})();
