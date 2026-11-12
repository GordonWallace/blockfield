// Distant terrain on the planet (spec r14-05): rings of height-field meshes around the player, each twice as coarse as the last, so the
// land beyond the loaded chunks shows its true shape and colours out to the horizon, at every height. Brought over from the round-planet
// prototype (GordonWallace/blockfield-round js/lod.js); see /mnt/project-files/notes/round-planet-lessons.md sections 6 and 8.
//
// - Eight rings have a cell every 4, 8, 16, ... 512 blocks, each reaching HALF = 128 cells from its own centre (its mesh reaches 136,
//   so moving rings and morph targets always have samples): ring 0 reaches 512 blocks and ring 7 65 km. A cell is 1/64 to 1/128 of
//   its distance, so every ring's cells are under 15 pixels across on a 1080p screen (r14-07 halved HALF from the 256 of r14-05: 4.1
//   million triangles took most of the frame in software rendering; now about 0.8 million, fewer once the covered middles are skipped).
// - Only the cells within a ring's disc are indexed, nearest the centre first, and the middle that the finer ring or the loaded chunks
//   certainly cover is skipped (covered()); the per-pixel cuts below do the rest.
// - From 10x fast-forward rings that are built aren't moved (the frame goes to the simulation).
// - Each ring is drawn as a disc around its own centre, minus the next finer ring's disc and the loaded chunks' disc, so a ring still
//   being rebuilt never leaves a gap: the coarser one shows there instead. The cuts are measured per pixel: the fragment shader finds the
//   pixel's own face and grid position from its direction and maps it into the grid each cut belongs to (CHARTS below). Near a cube
//   corner unfolding depends on the route round the corner, and cuts measured in each mesh's own grid left black slivers there.
// - Along a finer ring's corner wedge (where its grid has no samples) and round the corner point, the next coarser ring keeps drawing
//   in a strip 2 x cell + 8 blocks wide; strips nest down to the coarsest ring.
// - Across 60 to 95% of its radius each vertex moves to where the next coarser ring puts it (MORPH), so detail fades instead of stepping.
// - A ring is rebuilt once the player is a fifth of its radius from its centre, reusing the samples still inside (keep), and isn't moved
//   while the player outruns it. It is hidden once its cells are about two pixels across from straight above (altitude > 1,500 x cell).
// - Colours are the blocks' own (js/grid.js), with the canopy colour of the area's trees over the ground where trees grow.
// - Rivers: drawn as ribbons along their curves once the planet has a river network (r14-10; see ribbons()).
// Each ring is a top-level scene object at its centre's atlas position with userData.anchor, so js/view.js places it like a chunk mesh
// (its face's unfold near the ground, the sphere by world.roundK); the shader mixes flat and round positions the same way.
//
// API: BF.lod = { reset(scene), update(), radius(), levels, stats(), material, cuts }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const CELLS = [4, 8, 16, 32, 64, 128, 256, 512];
const HALF = 128, EXT = 136;   // cells from a ring's centre to the edge of its disc, and of its mesh
const HIDE = 1500;             // a ring is hidden above this many times its cell size (its cells are then about 2 pixels)
const MOVE = 0.2;              // a ring is rebuilt once the player is this fraction of its radius from its centre
const HOLE = 0.97, MORPH0 = 0.6, MORPH1 = 0.95;   // fractions of a ring's radius
const RIBBON_HIDE = 9000, MINW = 3;   // river ribbons: hidden above this height; half-width at least this
const STAND_LEVELS = 6;        // rings with tree and building stand-ins (cells of 4 to 128 blocks)
const STAND_MAX = 14000;       // blocks from the player: stand-ins further out are never shown (a 10-block patch is under a pixel on any
                               // screen up to 4K), so none are made past that plus how far a ring moves (MOVE)
const BOX_LEVELS = 2;          // of those, the ones drawn as boxes, out to 1 km (the rest as points drawn like small boxes)
const THIN = [0, 0, 0, 1, 2, 3];   // ring by ring: one tree cell kept in each square of 2^m x 2^m (js/grid.js): every tree out to 2 km, then
                                   // one in 4, 16 and 64 per ring, as the prototype (the ground's canopy colour stands in for the rest)
const HOUSE_LEVELS = 5;        // rings with village buildings, out to 8 km (beyond, a building is under a pixel before the ring starts)
const pxScale = { value: 900 };   // pixels per radian at the middle of the screen: drawing-buffer height / (2 tan(fov / 2))
// The chunk mask: one texel per chunk in a square of MASK_N x MASK_N chunks round the player's, 255 where the chunk has a mesh (loaded
// chunks and far meshes, js/world.js), 0 elsewhere. Stand-in boxes aren't drawn over the chunks it marks (STAND_FRAG). Meshes reach 35
// chunks from the player at most (view distance 32, dropped 3 past it), well inside its 64.
const MASK_N = 128;
const maskData = new Uint8Array(MASK_N * MASK_N), maskNext = new Uint8Array(MASK_N * MASK_N);
const chunkMask = { value: new THREE.DataTexture(maskData, MASK_N, MASK_N, THREE.LuminanceFormat, THREE.UnsignedByteType) };
chunkMask.value.magFilter = chunkMask.value.minFilter = THREE.NearestFilter;
chunkMask.value.generateMipmaps = false;
chunkMask.value.needsUpdate = true;
const maskO = { value: new THREE.Vector2() };   // its corner in the view face's grid

const lod = (BF.lod = { EXT, THIN, levels: [], active: false, eyeHole: 0, ribbon: null, scene: null, view: { f: 0, u: 0, v: 0 }, standIns: true, cap: Infinity });   // cap: rings with cells this size or wider aren't drawn (js/globe.js)

// ---- materials ----
const P = () => BF.planet;
const VERT = `
attribute vec3 sphere;
attribute vec3 col;
attribute vec3 mflat;
attribute vec3 msph;
attribute vec3 mcol;
attribute vec4 canopy;
uniform mat4 sphM;
uniform float uK;
uniform vec2 morph;    // distances from the ring's centre (in its grid) where morphing starts and ends
uniform vec3 anchor;   // what sphere positions are relative to
varying vec3 vColor;
varying vec4 vCanopy;
varying vec3 vP;       // position relative to the planet's centre
varying vec2 vG;       // grid position relative to the ring's centre
varying float vDist;
#include <fog_pars_vertex>
void main() {
  vec3 a = position, s = sphere, c = col;
#ifdef MORPH
  float m = smoothstep(morph.x, morph.y, length(position.xz));
  if (m > 0.0) { a = mix(a, mflat, m); s = mix(s, msph, m); c = mix(c, mcol, m); }
#endif
  vP = anchor + s;
  vG = position.xz;
  vec3 t = a;
  if (uK > 0.0) t = mix(a, (sphM * vec4(s, 1.0)).xyz, uK);
  vec4 mvPosition = modelViewMatrix * vec4(t, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vColor = c;
  vCanopy = canopy;
  vDist = length(mvPosition.xyz);
#include <fog_vertex>
}`;
const FRAG = `
uniform vec3 hole;     // the loaded chunks' disc: centre (view face grid) and radius
uniform vec3 hole2;    // the next finer ring's disc: centre (its grid) and radius
uniform vec3 outer;    // this ring's own disc (its grid, relative to its centre)
uniform float uDay;
uniform vec3 faceN[6];
uniform vec3 faceA[6];
uniform vec3 faceB[6];
uniform mat3 toHole[6];
uniform mat3 toHole2[6];
uniform float seam2;   // width of the strip along the finer ring's corner wedge that it leaves to this ring
uniform float stand;   // the share of tree cells this ring draws as stand-ins (0: none)
uniform vec2 edge;     // stand-ins fade out between these distances from the ring's centre (the last ring that has them)
uniform float pxScale;
varying vec3 vColor;
varying vec4 vCanopy;
varying vec3 vP;
varying vec2 vG;
varying float vDist;
// how far stand-ins show at distance d: fully while a 10-block patch is 2 pixels or more, not at all from 1 pixel
#define NEAR(d) clamp(10.0 * pxScale / (d) - 1.0, 0.0, 1.0)
#include <fog_pars_fragment>
void main() {
  // this pixel's own face and grid position (as BF.planet.fromDir), then mapped into each cut's grid
  float best = -2.0;
  int fi = 0;
  vec3 fa = faceA[0], fb = faceB[0];
  for (int i = 0; i < 6; i++) {
    float c = dot(vP, faceN[i]);
    if (c > best) { best = c; fi = i; fa = faceA[i]; fb = faceB[i]; }
  }
  vec3 g = vec3((vec2(atan(dot(vP, fa) / best), atan(dot(vP, fb) / best)) / 0.7853981633974483 + 1.0) * (FACE_N * 0.5), 1.0);
  vec2 gh = vec2(1e9), gh2 = vec2(1e9);
  for (int i = 0; i < 6; i++) if (i == fi) { gh = (toHole[i] * g).xy; gh2 = (toHole2[i] * g).xy; }
  bool inner = hole2.z > 0.0 && length(gh2 - hole2.xy) < hole2.z;
  // the finer ring can't join the two faces beyond a cube corner of its grid: the strip along its wedge and round the corner is left here
  bool nu = gh2.x < seam2 || gh2.x > FACE_N - seam2, nv = gh2.y < seam2 || gh2.y > FACE_N - seam2;
  if (nu && nv) inner = false;
  bool eye = hole.z > 0.0 && length(gh - hole.xy) < hole.z;
  if (eye || inner || (outer.z > 0.0 && length(vG - outer.xy) > outer.z)) discard;
  // tree crowns: the canopy's colour over the share of ground it covers, giving way to the stand-ins where they show (each ring draws
  // a share of the trees); daylight as on an open-sky block
  float a = vCanopy.a * (1.0 - stand * NEAR(vDist) * (1.0 - smoothstep(edge.x, edge.y, length(vG))));
  vec3 col = mix(vColor, vCanopy.rgb, a) * max(0.1, uDay);
  gl_FragColor = vec4(col, 1.0);
#include <fog_fragment>
}`;
// The realistic look (1.6, docs/REALISTIC_CONTRACT.md; js/real/lod.js is this file's other half there): the same rings and stand-ins, lit
// by the frame's sun and sky like the terrain of the loaded chunks and put through the renderer's tone mapping, so the land doesn't
// change brightness where the chunks end. The ground's normal is its samples' slope (attribute nrm, js/grid.js); the
// stand-ins' from their faces' block shades. With the look off none of this is used and the shaders are 1.5's, byte for byte.
const REAL = !!(BF.real && BF.real.on && BF.real.U);
const REAL_PARS = `
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
#include <common>
#include <fog_pars_fragment>`;
const REAL_OUT = `
  gl_FragColor = vec4(pow(alb, vec3(2.2)) * light, 1.0);
#include <tonemapping_fragment>
#include <encodings_fragment>
#include <fog_fragment>
}`;
const realUniforms = () => { const U = BF.real.U; return { uSunCol: U.uSunCol, uSunDir: U.uSunDir, uSkyCol: U.uSkyCol, uGroundCol: U.uGroundCol, uFogCol: U.uFogCol, uWet: U.uWet }; };
// (fog by the distance from the eye, not by the depth along its line of sight: far land at the side of the view is as hazy as it is
// straight ahead, and doesn't fade as the eye turns to it)
const REAL_FOG = ["#include <fog_vertex>", "#include <fog_vertex>\n#ifdef USE_FOG\n  fogDepth = length(mvPosition.xyz);\n#endif"];
const VERT_USED = !REAL ? VERT : VERT.replace("varying float vDist;", "varying float vDist;\nvarying vec3 vV;\nattribute float wat;\nattribute vec3 nrm;\nattribute vec2 gnd;\nvarying float vWat;\nvarying vec3 vN;\nvarying vec2 vGnd;")
  .replace("  vDist = length(mvPosition.xyz);", "  vDist = length(mvPosition.xyz);\n  vV = mvPosition.xyz;\n  vWat = wat;\n  vGnd = gnd;\n  vN = (modelViewMatrix * vec4(nrm, 0.0)).xyz;").replace(REAL_FOG[0], REAL_FOG[1]);
// The ground is the loaded chunks' terrain seen from afar (js/real/terrain.js: half its colour's light, its detail texture's average;
// darker when wet); water is theirs too (js/real/water.js, rwShade on a flat surface: its own dark colour, the sky by the angle it is
// seen at, the floor through the shallows). `wat` is 0 on land and 0.55 (the shore) to 1 (16 blocks deep and more) on water, whose
// vertex colour is its floor's (js/grid.js).
const FRAG_USED = !REAL ? FRAG : FRAG.replace("varying float vDist;", "varying float vDist;\nvarying vec3 vV;\nvarying float vWat;\nvarying vec3 vN;\nvarying vec2 vGnd;\nuniform sampler2D uTurf;\nuniform sampler2D uDet;\nuniform vec3 uSnowCol;\nuniform vec2 texO;\nuniform vec3 uFogCol;\nuniform float uWet;\nuniform sampler2D chunkMask;\nuniform vec2 maskO;\nuniform mat4 projectionMatrix;").replace("#include <fog_pars_fragment>", REAL_PARS)
  .replace(/  vec3 col = mix\(vColor, vCanopy\.rgb, a\) \* max\(0\.1, uDay\);[\s\S]*$/, `  vec3 alb = mix(vColor, vCanopy.rgb, a);
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vec3 n = normalize(vN);
  n = normalize(mix(n, upV, 0.5 * a));   // (a canopy is rough: its light follows the slope less)
  vec3 light = mix(uGroundCol, uSkyCol, 0.5 + 0.5 * dot(n, upV)) + uSunCol * max(dot(n, sunV), 0.0);
  // The ground as the terrain's material draws it (js/real/terrain.js), from the same textures: turf (gnd.x) is short grass, light
  // and dry in patches, so the land keeps its look where the chunks end and loses the detail with distance, as theirs does. Snow
  // (gnd.y) lies over the ground's own colour with an edge of its own: a cell's worth of blur would be a soft smear on a far peak.
  vec2 tp = vG + texO;
  vec3 gc = pow(vColor, vec3(2.2));
  float sv = vGnd.y + (texture2D(uDet, tp * 0.0131).a - 0.5) * 0.5 * step(0.001, vGnd.y) * step(vGnd.y, 0.999), sw = max(fwidth(sv), 1e-4);
  float snow = smoothstep(0.5 - sw, 0.5 + sw, sv);
  gc = mix(gc, uSnowCol, snow);
  float turf = vGnd.x * (1.0 - snow), steep = smoothstep(0.62, 0.42, dot(n, upV));
  vec4 g1 = texture2D(uTurf, tp * 0.625), g2 = texture2D(uTurf, tp * 0.3125 + 0.37);
  float d2 = texture2D(uDet, tp * 0.031).r, pch = texture2D(uDet, tp * 0.0625).r;
  float dry = clamp(g1.g * 0.35 + g2.g * 0.65 + (pch - 0.5) * 1.1, 0.0, 1.0);
  vec3 bare = mix(gc, vec3(0.19, 0.18, 0.17), steep * turf * 0.75) * 0.5;
  vec3 blade = gc * mix(vec3(0.84, 1.0, 0.8), vec3(1.16, 1.08, 0.68), smoothstep(0.3, 0.95, dry)) * 0.5 * (0.2 + 0.6 * g1.r + 1.1 * g2.r) * (0.78 + 0.44 * d2);
  vec3 ground = mix(bare, blade, turf * (1.0 - steep * 0.6));
  ground = mix(ground, ground * 0.55, uWet * (1.0 - snow));
  vec3 lin = mix(ground, pow(vCanopy.rgb, vec3(2.2)), a) * light;
  {
    // the sheen the terrain's material has (three.js' GGX highlight for roughness 0.94 and 4% reflectance): faint, but it is what
    // lifts the dark channels of a sunlit ground's colour
    vec3 Ve = normalize(-vV), Hh = normalize(Ve + sunV);
    float a2 = 0.7807, nl = max(dot(n, sunV), 0.0), nv = max(dot(n, Ve), 0.0), nh = max(dot(n, Hh), 0.0), lh = max(dot(sunV, Hh), 0.0);
    float gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv), gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl), dn = nh * nh * (a2 - 1.0) + 1.0;
    float Fr = 0.04 + 0.96 * exp2((-5.55473 * lh - 6.98316) * lh);
    lin += uSunCol * (0.35 * nl * Fr * (0.5 / max(gv + gl, 1e-6)) * a2 / (dn * dn)) * (1.0 - a);   // (0.35: js/real/core.js keeps that much of the sun's sheen)
  }
  gl_FragColor = vec4(lin, 1.0);
  float wa = smoothstep(0.0, 0.5, vWat);
#include <tonemapping_fragment>
#include <encodings_fragment>
  if (wa > 0.0) {   // (less light reaches a deeper floor, as the chunks' block light has it: none 16 blocks down)
    float sh = 1.0 - clamp((vWat - 0.55) / 0.45, 0.0, 1.0);
    gl_FragColor.rgb *= mix(1.0, sh * sh, wa);
  }
  // Where the chunks reach past the hole both are drawn: there the ring stands back (drawn a little further along the eye's ray), so
  // the chunks' own ground shows and not the two in stripes; and under the chunks' water only its floor is drawn.
  vec2 mk = (gh - maskO) / CHUNK;
  gl_FragDepthEXT = gl_FragCoord.z;
  if (all(greaterThanEqual(mk, vec2(0.0))) && all(lessThan(mk, vec2(MASK_N))) && texture2D(chunkMask, (floor(mk) + 0.5) / MASK_N).r > 0.5) {
    wa = 0.0;
    vec4 cp = projectionMatrix * vec4(vV * (1.0 + (3.0 + 0.04 * vDist) / vDist), 1.0);
    gl_FragDepthEXT = 0.5 + 0.5 * cp.z / cp.w;
  }
  if (wa > 0.0) {
    vec3 Vn = normalize(-vV);
    float cs = max(dot(upV, Vn), 0.0), F = 0.02 + 0.98 * pow(1.0 - cs, 5.0);
    float sd = max(dot(reflect(-Vn, upV), sunV), 0.0);
    vec3 refl = mix(uFogCol * 0.9, uSkyCol * vec3(0.55, 0.75, 1.1), pow(cs, 0.55)) + uSunCol * (pow(sd, 60.0) * 0.1);
    vec3 body = vec3(0.018, 0.075, 0.06) * (0.25 + 0.75 * max(uSunDir.y, 0.0)) * max(uDay, 0.04);
    vec4 w = vec4(mix(body, refl, F), 1.0);
#if defined( TONE_MAPPING )
    w.rgb = toneMapping(w.rgb);
#endif
    w = linearToOutputTexel(w);
    // (blended as the chunks' water is over its floor, on the screen's colours; 0.74: rwShade's alpha for it)
    gl_FragColor.rgb = mix(gl_FragColor.rgb, w.rgb, wa * mix(0.74, 1.0, F));
  }
#include <fog_fragment>
}`);
let shared = null;
// The ground's textures under the realistic look: the terrain's turf (js/real/terrain.js makes it) and its detail noise, which that
// file keeps to itself, so this is its detailTexture() again (the same lattices: r soil and turf's patches, a snow). They repeat every
// 1.6 and 4 blocks; a ring's texO is its centre within 1,600 blocks, a whole number of every repeat the shader reads them at.
const groundTex = { uTurf: { value: null }, uDet: { value: null }, uSnowCol: { value: new THREE.Vector3(0.9, 0.93, 0.95) } };
function detailTexture() {
  const S = 256, d = new Uint8Array(S * S * 4);
  const lat = (seed, n) => { const a = new Float32Array(n * n); let s = seed >>> 0; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; };
  const noise = (a, n, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const g = (i, j) => a[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
    return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v;
  };
  const L = [8, 16, 32, 64, 128].map((n, i) => [lat(977 + i * 131, n), n]);
  const fbm = (x, y, from) => { let s = 0, w = 0, amp = 1; for (let o = from; o < L.length; o++) { s += noise(L[o][0], L[o][1], x * L[o][1], y * L[o][1]) * amp; w += amp; amp *= 0.55; } return s / w; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, o = (y * S + x) * 4;
    d[o] = (0.7 * fbm(u, v, 1) + 0.3 * fbm(u + 0.37, v + 0.11, 2)) * 255;
    d[o + 3] = (0.8 * fbm(u, v, 0) + 0.2 * fbm(u, v, 3)) * 255;
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
function material(morph) {
  const Pl = P();
  if (!shared) {
    shared = {
      faceN: { value: Pl.FACES.map((F) => new THREE.Vector3(...F.n)) },
      faceA: { value: Pl.FACES.map((F) => new THREE.Vector3(...F.a)) },
      faceB: { value: Pl.FACES.map((F) => new THREE.Vector3(...F.b)) },
    };
  }
  const sphM = new THREE.Matrix4();
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT_USED, fragmentShader: FRAG_USED, fog: true,
    defines: Object.assign({ FACE_N: Pl.N.toFixed(1) }, morph ? { MORPH: 1 } : {}, REAL ? { MASK_N: MASK_N.toFixed(1), CHUNK: BF.CS.toFixed(1) } : {}),
    uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), shared, {
      sphM: { value: sphM }, uK: BF.world.roundK, uDay: BF.world.dayUniform,
      morph: { value: new THREE.Vector2(1e30, 2e30) }, anchor: { value: new THREE.Vector3() },
      hole: { value: new THREE.Vector3() }, hole2: { value: new THREE.Vector3() }, outer: { value: new THREE.Vector3() }, seam2: { value: 0 },
      toHole: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Matrix3()) }, toHole2: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Matrix3()) },
      stand: { value: 0 }, edge: { value: new THREE.Vector2(1e30, 2e30) }, pxScale,
    }),
  });
  if (REAL) {
    if (!groundTex.uTurf.value) { groundTex.uTurf.value = BF.real.turfTexture(); groundTex.uDet.value = detailTexture(); }
    Object.assign(m.uniforms, realUniforms(), { chunkMask, maskO, texO: { value: new THREE.Vector2() } }, groundTex);
    m.extensions.fragDepth = true; m.extensions.derivatives = true;
  }
  m.userData.sphM = sphM;   // js/view.js sets it each frame (the round placement in the mesh's own frame)
  return m;
}

// Stand-ins for trees and buildings (js/grid.js stand()): instanced, one per tree or building, as two boxes (BOXES: trunk and crown, or
// walls and roof; position is a corner of a unit box) or as one square point the crown's size. Each is placed at its foot (base: flat, in
// the ring's grid relative to its centre; sph: round, relative to its anchor) and built out along the grid axes there (frame: grid u, up
// and grid v as planet-space vectors at the ring's centre, close enough across a ring). Cut like the ring's ground (whole stand-ins: by
// their foot), so they never show over the loaded chunks or the finer ring.
// While chunks stream in, chunks past the loaded chunks' disc already have meshes (the disc only reaches the nearest chunk without one),
// so a stand-in there would show over its real building or tree. Boxes are also cut per pixel by the chunk mask (chunkMask below): no
// part of a stand-in shows over a chunk that has a mesh, and the part still over chunks without one keeps showing, so a building that
// loads in pieces is never drawn twice and never leaves a gap. Points (rings 2 on, from about 780 blocks) are past every chunk mesh: meshes
// are dropped 3 chunks past the view distance (35 chunks at most).
const STAND_VERT = `
attribute vec3 base;
attribute vec3 sph;
attribute vec3 top;
attribute vec3 low;
attribute vec4 a;   // trunk width x, z, height, crown top width (of 255, of the crown's width)
attribute vec4 b;   // crown width x, z, height, random byte
attribute float c;  // crown bottom
#ifdef BOXES
attribute float part;
attribute float shade;
#endif
uniform mat4 sphM;
uniform mat3 frame;
uniform float uK;
uniform float pxScale;
uniform vec2 edge;
uniform vec3 hole;
uniform vec3 hole2;
uniform vec3 outer;
uniform vec2 centre;   // the ring's centre in its face's grid
uniform mat3 toHole;   // the ring's face grid into the view face's (the loaded chunks' disc)
uniform mat3 toHole2;  // into the finer ring's face
uniform float seam2;
uniform vec2 maskO;    // the chunk mask's corner in the view face's grid
varying vec3 vColor;
#ifdef BOXES
varying vec2 vMask;    // the point's place in the chunk mask, in chunks from its corner
#else
varying vec3 vSide;    // the crown's (or roof's) sides, and the trunk's (or walls')
varying vec3 vLow;
varying vec4 vRows;    // where the top face, crown sides and trunk end, down the point (0 at its top)
varying vec2 vHalf;    // half-widths of the crown and the trunk, across the point
#endif
#include <fog_pars_vertex>
#define NEAR(d) clamp(10.0 * pxScale / (d) - 1.0, 0.0, 1.0)
void main() {
#ifndef BOXES
  gl_PointSize = 1.0;   // dropped points still need a size, or some drivers draw them huge
#endif
  vec3 g = vec3(base.xz + centre, 1.0);
  vec2 gh = (toHole * g).xy, gh2 = (toHole2 * g).xy;
  bool inner = hole2.z > 0.0 && length(gh2 - hole2.xy) < hole2.z;
  bool nu = gh2.x < seam2 || gh2.x > FACE_N - seam2, nv = gh2.y < seam2 || gh2.y > FACE_N - seam2;
  if (nu && nv) inner = false;
  if (inner || (hole.z > 0.0 && length(gh - hole.xy) < hole.z) || length(base.xz - outer.xy) > outer.z) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 w0 = base;
  if (uK > 0.0) w0 = mix(base, (sphM * vec4(sph, 1.0)).xyz, uK);
  float d = length((modelViewMatrix * vec4(w0, 1.0)).xyz);
  // shown while a 10-block patch is a pixel or more (the ground's canopy colour takes over beyond, and across the outer part of the last
  // ring with stand-ins); smaller than a pixel, drawn as one pixel by a share of them that keeps the covered area right. The random byte
  // decides which ones, so no line follows the player.
  float px = max(max(b.x, b.y), max(a.x, a.y)) * pxScale / d;
  float show = NEAR(d) * (1.0 - smoothstep(edge.x, edge.y, length(base.xz))) * min(1.0, px * px);
  if (b.w >= 256.0 * show) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
#ifndef BOXES
  // a point this big belongs to a finer ring still being built (the boxes come with it): not drawn meanwhile
  if (px > 24.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
#endif
#ifdef BOXES
  bool up = part > 0.5;
  vec2 wd = up ? b.xy * mix(1.0, a.w / 255.0, position.y) : a.xy;
  vec3 l = vec3(position.x * wd.x, up ? c + position.y * b.z : position.y * a.z, position.z * wd.y);
  vColor = (up ? top : low) * shade;
  vMask = ((toHole * vec3(g.xy + l.xz, 1.0)).xy - maskO) / CHUNK;
#else
  // a point drawn like the two boxes seen from here: the crown's (or roof's) top face, its sides below, then the trunk (or walls), each
  // shaded as the boxes' faces are. sn is how steeply the view looks down on it.
  bool crown = b.z > 0.0;
  float cw = crown ? max(b.x, b.y) : max(a.x, a.y), ch = crown ? b.z : 0.0, tw = max(a.x, a.y), th = crown ? c : a.z, tall = th + ch;
  vec3 upM = vec3(0.0, 1.0, 0.0);
  if (uK > 0.0) upM = normalize(mix(upM, mat3(sphM) * (frame * upM), uK));
  vec3 mid = w0 + upM * (0.5 * tall);
  vec4 mvMid = modelViewMatrix * vec4(mid, 1.0);
  float sn = clamp(dot(normalize(-mvMid.xyz), normalize((modelViewMatrix * vec4(upM, 0.0)).xyz)), 0.0, 1.0), cs = sqrt(1.0 - sn * sn);
  float k = pxScale / d, hTop = cw * sn * k, hSide = ch * cs * k, hLow = th * cs * k, wMax = max(cw, tw) * k;
  float size = clamp(max(wMax, hTop + hSide + hLow), 1.0, 64.0);
  float y0 = 0.5 - 0.5 * (hTop + hSide + hLow) / size;
  vRows = vec4(y0, y0 + hTop / size, y0 + (hTop + hSide) / size, y0 + (hTop + hSide + hLow) / size);
  vHalf = vec2(cw, tw) * k / size * 0.5;
  vec3 tc = crown ? top : low;
  vSide = tc * 0.8; vLow = low * 0.72;
  vColor = tc;
  // under about 2 pixels the shapes don't show: one colour, the faces' average by the area each covers
  float aTop = hTop * cw * k, aSide = hSide * cw * k, aLow = hLow * tw * k;
  if (size < 2.0) { vColor = (tc * aTop + vSide * aSide + vLow * aLow) / max(1e-6, aTop + aSide + aLow); vRows = vec4(0.0); }
  gl_PointSize = size;
  vec3 l = vec3(0.0, 0.5 * tall, 0.0);
#endif
  vec3 t = base + l;
  if (uK > 0.0) t = mix(t, (sphM * vec4(sph + frame * l, 1.0)).xyz, uK);
  vec4 mvPosition = modelViewMatrix * vec4(t, 1.0);
  gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`;
const STAND_FRAG = `
uniform float uDay;
uniform sampler2D chunkMask;
varying vec3 vColor;
#ifdef BOXES
varying vec2 vMask;
#else
varying vec3 vSide;
varying vec3 vLow;
varying vec4 vRows;
varying vec2 vHalf;
#endif
#include <fog_pars_fragment>
void main() {
  vec3 col = vColor;
#ifdef BOXES
  if (all(greaterThanEqual(vMask, vec2(0.0))) && all(lessThan(vMask, vec2(MASK_N))) && texture2D(chunkMask, (floor(vMask) + 0.5) / MASK_N).r > 0.5) discard;
#else
  if (vRows.w > vRows.x) {
    vec2 q = gl_PointCoord;
    float x = abs(q.x - 0.5);
    if (q.y < vRows.x || q.y > vRows.w) discard;
    if (q.y < vRows.z) { if (x > max(vHalf.x, 0.5 / 64.0)) discard; col = q.y < vRows.y ? vColor : vSide; }
    else { if (x > max(vHalf.y, 0.5 / 64.0)) discard; col = vLow; }
  }
#endif
  gl_FragColor = vec4(col * max(0.1, uDay), 1.0);
#include <fog_fragment>
}`;
// (the realistic look: a stand-in's faces carry their block shade, 1 on top, 0.8 and 0.65 on the sides, 0.72 on a point's trunk: read
// back as how much sky and sun the face gets)
const STAND_FRAG_USED = !REAL ? STAND_FRAG : STAND_FRAG.replace("#include <fog_pars_fragment>", REAL_PARS)
  .replace(/  gl_FragColor = vec4\(col \* max\(0\.1, uDay\), 1\.0\);[\s\S]*$/, `  vec3 alb = col;
  vec3 light = mix(uGroundCol, uSkyCol, 0.8) + uSunCol * 0.4;` + REAL_OUT);
// The realistic look's trees (js/real/lod.js, BF.real.lod.cards): a stand-in that is a tree with a real model (attribute card: its
// row of the impostor atlas, scale, turn and seed; row -1: none) is drawn as that model's cards instead of two boxes, the very cards
// the loaded chunks' far trees are, so a tree looks the same on either side of the chunks' edge. Among the boxes: the upright card and
// the level one (BF.real.lod.cards.quads, parts 2 and 3 of the instance; its boxes are dropped). Among the points, further out: one
// point showing the model from the side, or from above when seen from above; a flat colour, the model's average, under 4 pixels.
// Until a row is baked its trees stay boxes. Buildings stay boxes, shaded by the sun on each face as the real walls and roofs are.
let standShaders = null;
function realStandShaders() {
  if (standShaders) return standShaders;
  const C = BF.real.lod && BF.real.lod.cards;
  if (!C) return (standShaders = { vert: STAND_VERT.replace(REAL_FOG[0], REAL_FOG[1]), frag: STAND_FRAG_USED, cards: null });
  const rep = (s, a, b) => { if (!s.includes(a)) throw new Error("js/lod.js: stand-in shader changed under the realistic look's patch: " + a.slice(0, 40)); return s.replace(a, b); };
  let v = STAND_VERT.replace(REAL_FOG[0], REAL_FOG[1]), f = STAND_FRAG_USED;
  v = rep(v, "attribute float c;  // crown bottom", `attribute float c;  // crown bottom
attribute vec4 card;   // atlas row (-1: not a tree with a model), scale, turn, seed
uniform vec3 uRowCol[${C.MAXROW}];
varying float vCard;   // 0: boxes or the plain point, 1: cards or a flat point, 2: a point showing the model
varying vec3 vTint;
varying vec3 vN;
#ifdef BOXES
varying vec3 vL;       // a house: this point from its foot, in blocks
varying vec3 vHs;      // and its face (0 not a house, 1 a wall across x, 2 a wall across z, 3 a roof's slope, 4 a top), the wall's width, the eaves' height
#else
varying vec4 vCell;
varying vec2 vSpr;
#endif` + C.VERT);
  // the axes at the stand-in's foot, in view space
  const AXES = `
  vec3 upL = vec3(0.0, 1.0, 0.0), xL = vec3(1.0, 0.0, 0.0), zL = vec3(0.0, 0.0, 1.0);
  if (uK > 0.0) { mat3 fr = mat3(sphM) * frame; upL = normalize(mix(upL, fr * upL, uK)); xL = normalize(mix(xL, fr * xL, uK)); zL = normalize(mix(zL, fr * zL, uK)); }
  vec3 upV = normalize((modelViewMatrix * vec4(upL, 0.0)).xyz), xV = normalize((modelViewMatrix * vec4(xL, 0.0)).xyz), zV = normalize((modelViewMatrix * vec4(zL, 0.0)).xyz);
  vec3 footV = (modelViewMatrix * vec4(w0, 1.0)).xyz;
  vec4 rowI = uRow[int(max(card.x, 0.0) + 0.5)];
  bool tree = card.x >= 0.0 && rowI.y > 0.0;
  float tv = 0.9 + 0.2 * fract(card.w * 5.3);
  vTint = pow(vec3(tv, tv * (0.94 + 0.12 * fract(card.w * 9.1)), tv), vec3(1.0 / 2.2));
  vCard = 0.0; vN = upV;
  vec4 cardAt = vec4(0.0);`;
  v = rep(v, "#ifdef BOXES\n  bool up = part > 0.5;", AXES + `
#ifdef BOXES
  if (part > 1.5) {
    if (!tree) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    cardAt = rlCard(footV, upV, xV, zV, vec3(position.xy, part - 2.0), card.x, card.y, card.z);
    if (cardAt.w < 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vCard = 1.0;
  } else if (tree) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  bool up = part > 0.5;`);
  // (a box face's normal from its block shade: 1 the top, 0.8 the x sides, 0.65 the z sides; the colour then goes without the shade)
  v = rep(v, "  vColor = (up ? top : low) * shade;\n  vMask = ((toHole * vec3(g.xy + l.xz, 1.0)).xy - maskO) / CHUNK;", `  vColor = up ? top : low;
  if (vCard < 0.5) vN = shade > 0.9 ? upV : shade > 0.7 ? xV * sign(position.x) : zV * sign(position.z);
  vHs = vec3(0.0);
  if (card.w < -0.5) {
    vHs = vec3(shade > 0.9 ? 4.0 : shade > 0.7 ? 1.0 : 2.0, shade > 0.7 ? a.y : a.x, c + 2.0);
    // a house as worldgen.js builds it: walls to the eaves, two blocks over the stand-in's; on them a gable roof, its ridge along
    // the longer side, rising half its span and overhanging the walls on the slopes' sides only, with the gable ends wall (the
    // slopes are steps: lit mostly from above); or, where the village builds flat roofs, a slab
    float eaves = c + 2.0;
    if (!up) l.y = position.y * eaves;
    else if (card.z > 0.5) l = vec3(position.x * (b.x - 2.0), eaves + position.y, position.z * (b.y - 2.0));
    else {
      bool alongX = b.x >= b.y, xFace = shade > 0.7 && shade < 0.9, zFace = shade < 0.7;
      float span = alongX ? b.y : b.x, hR = 0.5 * span, narrow = 1.0 - position.y;
      l = alongX ? vec3(position.x * (b.x - 2.0), eaves + position.y * hR, position.z * b.y * narrow) : vec3(position.x * b.x * narrow, eaves + position.y * hR, position.z * (b.y - 2.0));
      if (alongX ? xFace : zFace) vColor = low;
      if (alongX ? zFace : xFace) { vN = normalize((alongX ? zV * sign(position.z) : xV * sign(position.x)) * 0.4 + upV); vHs.x = 3.0; }
    }
  }
  vL = l;
  vMask = ((toHole * vec3(g.xy + (vCard > 0.5 ? vec2(0.0) : l.xz), 1.0)).xy - maskO) / CHUNK;`);
  v = rep(v, "  gl_PointSize = size;\n  vec3 l = vec3(0.0, 0.5 * tall, 0.0);", `  gl_PointSize = size;
  vec3 l = vec3(0.0, 0.5 * tall, 0.0);
  if (tree) {
    float tr = rowI.x * card.y, tH = rowI.y * card.y, cells = uGrid.x + 1.0, col = mod(floor(card.x + 0.5), uGrid.y), line = floor((card.x + 0.5) / uGrid.y);
    vec3 toCam = normalize(-footV);
    bool above = dot(toCam, upV) > 0.7;
    float sz = (above ? 2.0 * tr : max(tH, 2.0 * tr)) * k;
    // (under 4 pixels a tree is a dot of its colour: smaller than its picture's square, which its crown only part fills)
    gl_PointSize = sz < 4.0 ? clamp(sz * 0.7, 1.0, 64.0) : min(sz, 64.0);
    vSpr = above ? vec2(1.0) : vec2(sz / (2.0 * tr * k), sz / (tH * k));
    float f0 = mod(floor(fract((atan(dot(toCam, xV), dot(toCam, zV)) - card.z) / 6.2831853) * uGrid.x + 0.5), uGrid.x);
    vCell = above ? vec4((col * cells + uGrid.x + 0.02) / (uGrid.y * cells), (line + 0.02 * CARD_SQUARE) / uGrid.z, 0.96 / (uGrid.y * cells), 0.96 * CARD_SQUARE / uGrid.z)
      : vec4((col * cells + f0 + 0.02) / (uGrid.y * cells), (line + 0.02) / uGrid.z, 0.96 / (uGrid.y * cells), 0.96 / uGrid.z);
    vCard = sz < 4.0 ? 1.0 : 2.0;
    vColor = pow(uRowCol[int(card.x + 0.5)], vec3(1.0 / 2.2)) * vTint;
    vRows = vec4(0.0);
    l = vec3(0.0, above ? rowI.w * card.y : (rowI.z + 0.5 * rowI.y) * card.y, 0.0);
  }`);
  v = rep(v, "  vec4 mvPosition = modelViewMatrix * vec4(t, 1.0);", "  vec4 mvPosition = modelViewMatrix * vec4(t, 1.0);\n  if (cardAt.w > 0.5) mvPosition = vec4(cardAt.xyz, 1.0);");
  f = rep(f, "uniform sampler2D chunkMask;", `uniform sampler2D chunkMask;
varying float vCard;
varying vec3 vTint;
varying vec3 vN;
#ifdef BOXES
varying vec3 vL;
varying vec3 vHs;
// A house's faces as the blocks they stand for, while those are a few pixels each (HOUSE_PX): every block a shade of its own
// between joints, posts at the walls' corners, a window by each, and a roof in steps. Under that size the plain colour.
float rlHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 rlHouse(vec3 alb) {
  if (vHs.x > 3.5) return alb;
  vec2 q = vec2((vHs.x < 1.5 ? vL.z : vL.x) + 0.5 * vHs.y, vL.y);
  if (vHs.x > 2.5) q = vec2(abs(dFdx(vL.x)) + abs(dFdy(vL.x)) > abs(dFdx(vL.z)) + abs(dFdy(vL.z)) ? vL.x : vL.z, (vL.y - vHs.z) * 2.0);
  float fw = max(fwidth(q.x), fwidth(q.y)), show = clamp(2.0 - fw * HOUSE_PX, 0.0, 1.0);
  if (show <= 0.0) return alb;
  vec2 cell = floor(q), f = q - cell;
  float k = 0.93 + 0.14 * rlHash(cell);
  if (vHs.x > 2.5) k *= mix(0.74, 1.06, smoothstep(0.0, 0.5, f.y));   // (a step's riser in the shade of the next)
  else {
    float lw = clamp(fw * 1.5, 0.04, 0.5);
    k *= 1.0 - 0.16 * max(1.0 - smoothstep(0.0, lw, min(f.y, 1.0 - f.y)), 0.6 * (1.0 - smoothstep(0.0, lw, min(f.x, 1.0 - f.x))));
    if (q.y < vHs.z && (cell.x < 0.5 || cell.x > vHs.y - 1.5)) k *= 0.62;   // (the corner posts)
    else if (vHs.y > 4.5 && cell.y > 1.5 && cell.y < 2.5 && (abs(cell.x - 1.0) < 0.5 || abs(cell.x - (vHs.y - 2.0)) < 0.5))
      return mix(alb, vec3(0.45, 0.55, 0.6), show * 0.85);   // (a window)
  }
  return alb * mix(1.0, k, show);
}
#else
varying vec4 vCell;
varying vec2 vSpr;
#endif` + C.FRAG);
  f = rep(f, "  vec3 alb = col;\n  vec3 light = mix(uGroundCol, uSkyCol, 0.8) + uSunCol * 0.4;", `  vec3 alb = col;
  vec3 light = mix(uGroundCol, uSkyCol, 0.8) + uSunCol * 0.4;
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz), upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
#ifdef BOXES
  vec3 n = normalize(vN);
  if (vCard > 0.5) {
    vec4 tc = rlCardTexel();
    if (tc.a < 0.4) discard;
    alb = tc.rgb * vTint; n = rlCardNormal(); upV = normalize(vUp);
  } else if (vHs.x > 0.5) alb = rlHouse(alb);
  light = mix(uGroundCol, uSkyCol, 0.5 + 0.5 * dot(n, upV)) + uSunCol * max(dot(n, sunV), 0.0);
  if (vCard > 0.5) light += uSunCol * (0.3 * max(-dot(n, sunV), 0.0) + rlCardGlow(sunV));   // (leaves let the sun through, as BF.real.lod's cards)
#else
  if (vCard > 1.5) {
    vec2 q = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y) * vSpr + 0.5;
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) discard;
    vec4 tc = texture2D(map, vCell.xy + q * vCell.zw);
    if (tc.a < 0.4) discard;
    alb = tc.rgb * vTint;
  }
  if (vCard > 0.5) {   // (lit as a crown seen from here: mostly from above, and the sun comes through it from behind)
    float sl = dot(normalize(upV * 0.8 + vec3(0.0, 0.0, 0.6)), sunV);
    float tb = clamp(-sunV.z, 0.0, 1.0);   // (and towards the eye, as rlCardGlow: a point has no direction of its own, the view's stands in)
    light = mix(uGroundCol, uSkyCol, 0.8) + uSunCol * (max(sl, 0.0) + 0.3 * max(-sl, 0.0) + vec3(0.45, 0.43, 0.19) * (0.3 * tb * tb));
    if (vCard < 1.5 && length(gl_PointCoord - 0.5) > 0.5) discard;
  }
#endif`);
  return (standShaders = { vert: v, frag: f, cards: C });
}
function standMaterial(boxes) {
  const sphM = new THREE.Matrix4(), SH = REAL ? realStandShaders() : null;
  const m = new THREE.ShaderMaterial({
    vertexShader: SH ? SH.vert : STAND_VERT, fragmentShader: SH ? SH.frag : STAND_FRAG_USED, fog: true,
    defines: Object.assign({ FACE_N: P().N.toFixed(1), MASK_N: MASK_N.toFixed(1), CHUNK: BF.CS.toFixed(1) }, boxes ? { BOXES: 1 } : {}, SH && SH.cards ? Object.assign({ HOUSE_PX: "4.0" }, SH.cards.defines()) : {}),
    uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
      sphM: { value: sphM }, uK: BF.world.roundK, uDay: BF.world.dayUniform, pxScale, frame: { value: new THREE.Matrix3() },
      edge: { value: new THREE.Vector2(1e30, 2e30) }, hole: { value: new THREE.Vector3() }, hole2: { value: new THREE.Vector3() },
      outer: { value: new THREE.Vector3() }, centre: { value: new THREE.Vector2() }, toHole: { value: new THREE.Matrix3() },
      toHole2: { value: new THREE.Matrix3() }, seam2: { value: 0 }, chunkMask, maskO,
    }),
  });
  if (REAL) { Object.assign(m.uniforms, realUniforms(), SH.cards ? SH.cards.uniforms : {}); m.extensions.derivatives = true; }
  m.userData.sphM = sphM;
  return m;
}
// A unit box's top and sides, twice (part 0: trunk or walls; part 1: crown or roof), each face shaded as the blocks' faces are; corners at
// x, z = -0.5 or 0.5 and y = 0 or 1.
let BOX = null;
function box() {
  if (BOX) return BOX;
  const pos = [], part = [], shade = [], idx = [];
  const face = (q, s, pt) => { const n = pos.length / 3; for (const v of q) pos.push(...v); for (let i = 0; i < 4; i++) { part.push(pt); shade.push(s); } idx.push(n, n + 1, n + 2, n, n + 2, n + 3); };
  for (const pt of [0, 1]) {
    face([[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]], 1, pt);
    // (each face counter-clockwise seen from outside, so the back faces are culled)
    for (const x of [-0.5, 0.5]) { const q = [[x, 0, -0.5], [x, 1, -0.5], [x, 1, 0.5], [x, 0, 0.5]]; face(x < 0 ? q.reverse() : q, 0.8, pt); }
    for (const z of [-0.5, 0.5]) { const q = [[-0.5, 0, z], [-0.5, 1, z], [0.5, 1, z], [0.5, 0, z]]; face(z > 0 ? q.reverse() : q, 0.65, pt); }
  }
  BOX = { pos: new THREE.Float32BufferAttribute(pos, 3), part: new THREE.Float32BufferAttribute(part, 1), shade: new THREE.Float32BufferAttribute(shade, 1), idx: new THREE.Uint16BufferAttribute(idx, 1) };
  return BOX;
}
// the stand-ins S (joined arrays, see keep) as boxes or points, one instance each
const SK = { base: 3, sph: 3, top: 3, low: 3, a: 4, b: 4, c: 1, bin: 2 };
const SA = { base: Float32Array, sph: Float32Array, bin: Uint16Array };
if (REAL) { SK.k = 4; SA.k = Float32Array; }   // (the realistic look: each tree's flora record, js/grid.js)
// The realistic look: each stand-in's card (atlas row, scale, turn, seed) from its record k, as js/real/lod.js would draw the loaded
// chunk's tree; far: rings where a tree is a few pixels (its species' first variant).
function cardsOf(S, far) {
  const n = S.c.length, out = new Float32Array(n * 4), C = realStandShaders().cards, names = BF.worldgen.NAMES || [];
  for (let i = 0; i < n; i++) {
    const o = i * 4, block = S.k ? S.k[o] : 0;
    out[o] = -1;
    if (!block && S.k) { out[o + 2] = S.k[o + 2]; out[o + 3] = S.k[o + 3]; }   // (a house: -1 last, and whether its roof is flat)
    if (!block || !C) continue;
    const logs = Math.floor(S.k[o + 2]), big = S.k[o + 2] - logs > 0.25, seed = S.k[o + 3];
    const r = C.rowOf(big ? 4 : 0, block, names[S.k[o + 1]] || "", logs, seed, far);
    if (r) { out[o] = r[0]; out[o + 1] = r[1]; out[o + 2] = seed * 6.2831853; out[o + 3] = seed; }
  }
  return out;
}
// (points as plain vertices: software rendering draws instances one by one, tens of times slower)
function standGeometry(S, boxes, far) {
  if (!boxes) {
    const g = new THREE.BufferGeometry();
    for (const k in SK) if (k !== "bin" && k !== "k") g.setAttribute(k, new THREE.BufferAttribute(S[k], SK[k], k === "top" || k === "low"));
    if (REAL && realStandShaders().cards) g.setAttribute("card", new THREE.BufferAttribute(cardsOf(S, true), 4));
    g.setAttribute("position", g.getAttribute("base"));
    return g;
  }
  const g = new THREE.InstancedBufferGeometry(), B = box();
  g.setAttribute("position", B.pos); g.setAttribute("part", B.part); g.setAttribute("shade", B.shade); g.setIndex(B.idx);
  if (REAL && realStandShaders().cards) {
    // the realistic look: the trees with a real model are their own object, two cards each (g.userData.cards; drawn with the boxes'
    // material, as the boxes' child: finish()); the boxes are the rest
    const card = cardsOf(S, !!far), n = S.c.length, boxes = [], trees = [];
    for (let i = 0; i < n; i++) (card[i * 4] >= 0 ? trees : boxes).push(i);
    const pick = (G, list) => {
      const A = Object.assign({ card }, S);
      for (const k in A) {
        if (k === "bin" || k === "k") continue;
        const m = k === "card" ? 4 : SK[k], src = A[k], a = new src.constructor(list.length * m);
        for (let p = 0; p < list.length; p++) for (let x = 0; x < m; x++) a[p * m + x] = src[list[p] * m + x];
        G.setAttribute(k, new THREE.InstancedBufferAttribute(a, m, k === "top" || k === "low"));
      }
      G.instanceCount = list.length;
    };
    pick(g, boxes);
    if (trees.length) {
      const Q = realStandShaders().cards.quads, c = new THREE.InstancedBufferGeometry();
      c.setAttribute("position", new THREE.BufferAttribute(Q.pos, 3)); c.setIndex(Q.idx);
      c.setAttribute("part", new THREE.Float32BufferAttribute([2, 2, 2, 2, 3, 3, 3, 3], 1)); c.setAttribute("shade", new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1], 1));
      pick(c, trees);
      g.userData.cards = c;
    }
    return g;
  }
  for (const k in SK) if (k !== "bin") g.setAttribute(k, new THREE.InstancedBufferAttribute(S[k], SK[k], k === "top" || k === "low"));
  g.instanceCount = S.c.length;
  return g;
}
// The stand-ins of old ring L on the samples that new ring b keeps (columns i0 to i1 and rows j0 to j1 of b, which are di and dj further
// on in L), moved to b's centre and anchor.
function keep(L, b, i0, i1, j0, j1, di, dj) {
  const S = L.stand, n = S ? S.c.length : 0, idx = [];
  for (let q = 0; q < n; q++) {
    const i = S.bin[2 * q] - di, j = S.bin[2 * q + 1] - dj;
    if (i >= i0 && i < i1 && j >= j0 && j < j1) idx.push(q);
  }
  const out = {};
  for (const k in SK) {
    const m = SK[k], src = S && S[k], a = (out[k] = new (SA[k] || Uint8Array)(idx.length * m));
    for (let p = 0; p < idx.length; p++) for (let x = 0; x < m; x++) a[p * m + x] = src[idx[p] * m + x];
  }
  if (!idx.length) return out;
  const du = L.cu - b.cu, dv = L.cv - b.cv, an = L.anchor;
  const ax = an[0] - b.anchor[0], ay = an[1] - b.anchor[1], az = an[2] - b.anchor[2];
  for (let p = 0; p < idx.length; p++) {
    out.base[3 * p] += du; out.base[3 * p + 2] += dv;
    out.sph[3 * p] += ax; out.sph[3 * p + 1] += ay; out.sph[3 * p + 2] += az;
    out.bin[2 * p] -= di; out.bin[2 * p + 1] -= dj;
  }
  return out;
}
function join(parts) {
  const out = {};
  for (const k in SK) {
    let len = 0;
    for (const p of parts) len += p[k].length;
    const a = new (SA[k] || Uint8Array)(len);
    let o = 0;
    for (const p of parts) { a.set(p[k], o); o += p[k].length; }
    out[k] = a;
  }
  return out;
}

// ---- the palette: average colour of each block's top texture (js/grid.js colours the samples with it) ----
function palette() {
  const img = BF.textures.build().texture.image, W = img.width, H = img.height, d = img.data;
  const top = [], side = [], tint = [];
  const avg = (tile, out) => {
    const r = BF.textures.uv(tile);
    const x0 = Math.round(r[0] * W), x1 = Math.round(r[2] * W), y0 = Math.round((1 - r[3]) * H), y1 = Math.round((1 - r[1]) * H);
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4, a = d[o + 3];
      if (a < 128) continue;
      sr += d[o] * a; sg += d[o + 1] * a; sb += d[o + 2] * a; sa += a;
    }
    return sa ? [sr / sa / 255, sg / sa / 255, sb / sa / 255] : out;
  };
  for (let id = 0; id <= BF.MAX_BLOCK; id++) {
    const b = BF.blocks[id];
    top[id] = [0.5, 0.5, 0.5]; side[id] = top[id]; tint[id] = 0;
    if (!b || !b.tiles) continue;
    top[id] = avg(b.tiles.top, top[id]);
    side[id] = b.tiles.side ? avg(b.tiles.side, top[id]) : top[id];   // (logs' bark, walls: the stand-ins' trunks and houses)
    const t = BF.world._faceTint ? BF.world._faceTint[id * 6] : 0;
    tint[id] = t === 4 ? 0 : t;
  }
  // the realistic look: natural ground in the colours its smooth terrain has in the loaded chunks (BF.real.assets.ground; a later
  // entry for a block wins), so the land keeps its colour where the chunks end
  if (REAL && BF.real.assets && BF.real.assets.ground) for (const g of BF.real.assets.ground) {
    const c = typeof g.color === "string" ? new THREE.Color(g.color).toArray() : g.color;
    if (c) for (const name of g.blocks || []) if (BF.B[name] != null) top[BF.B[name]] = [c[0], c[1], c[2]];
  }
  return { top, side, tint };
}

// ---- rings ----
lod.reset = function (scene) {
  lod.scene = scene || lod.scene;
  for (const L of lod.levels) { if (L.mesh) dispose(L.mesh); if (L.si) dispose(L.si); }
  if (lod.ribbon) dispose(lod.ribbon);
  lod.ribbon = null; lod.ribbonAt = null;
  lod.levels = CELLS.map((cell, lv) => ({ lv, cell, half: cell * HALF, mesh: null, raw: null, building: null, f: -1, cu: 0, cv: 0, gu0: 0, gv0: 0, buildMs: 0, meshMs: 0, show: false }));
  // off by switch: ?nolod in the page's address, or BF.lodOff set before the game starts (tests served over http that time things under
  // software rendering, where seven rings slow every frame)
  lod.active = !lod.disabled();
  last = null; speed = 0;
  if (!lod.active) { if (BF.sampler) BF.sampler.reset(null); return; }
  if (!lod.pal) lod.pal = palette();
  if (!fullIdx) { const d = BF.gridJob.discIndex(2 * EXT + 1, EXT, HALF); fullIdx = new THREE.BufferAttribute(d.idx, 1); fullCounts = d.counts; }   // made once here
  BF.gridJob.palette(lod.pal);
  if (REAL) { const W = lod.pal.top[BF.B.snow]; groundTex.uSnowCol.value.set(Math.pow(W[0], 2.2), Math.pow(W[1], 2.2), Math.pow(W[2], 2.2)); }
  // (rivers: the page's river network, for the workers' copies: js/worldgen.js riverState)
  BF.sampler.reset({ gen: BF.state.gen, seed: BF.state.seed, villages: BF.state.villages, biomeScale: BF.state.biomeScale, rivers: BF.worldgen.riverState() });
  // Without workers (a page opened as a file rather than through run.sh, where browsers refuse them) there is no distant terrain: sampling
  // in the page fills one ring in minutes, and seven rings drawn in software rendering slow every frame. BF.lodInline forces it on.
  if (BF.sampler.inline && !BF.lodInline) off();
};
lod.disabled = () => !!BF.lodOff || (typeof location !== "undefined" && /(^|[?&])nolod(=|&|$)/.test(location.search.slice(1)));
function off() {
  lod.active = false;
  for (const L of lod.levels) { if (L.mesh) { dispose(L.mesh); L.mesh = null; } if (L.si) { dispose(L.si); L.si = null; } L.stand = null; }
  if (lod.ribbon) { dispose(lod.ribbon); lod.ribbon = null; }
  BF.sampler.reset(null);
}
function dispose(m) {
  if (m.parent) m.parent.remove(m);
  for (const ch of m.children) ch.geometry.dispose();   // (the realistic look: a ring's tree cards, with its boxes)
  m.geometry.dispose(); for (const x of [].concat(m.material)) x.dispose();
}

// Starts rebuilding ring L around grid point (cu, cv) of face f: copies what the old ring already has and asks the workers for the rest.
function start(L, f, cu, cv) {
  const Pl = P(), c = L.cell, n = 2 * EXT + 1, gu0 = cu - EXT * c, gv0 = cv - EXT * c;
  const anchor = Pl.pos(f, cu, cv, BF.SEA, [0, 0, 0]);
  const stand = L.lv < STAND_LEVELS && lod.standIns ? { cu, cv, anchor, gu0, gv0, m: THIN[L.lv], max: STAND_MAX + MOVE * L.half, exact: L.lv === 0,
    houses: L.lv < HOUSE_LEVELS, villages: L.lv < HOUSE_LEVELS, real: REAL } : null;
  const b = { f, cu, cv, gu0, gv0, n, anchor, pending: 0, t0: performance.now(), raw: BF.gridJob.alloc({ nx: n, ny: n, real: REAL }), fresh: true, parts: stand ? [] : null };
  let rects = [[0, n, 0, n]];   // [j0, j1, i0, i1] still to sample
  const old = L.raw && L.f === f ? L : null;
  if (old) {
    const di = (gu0 - old.gu0) / c, dj = (gv0 - old.gv0) / c;
    if (Math.abs(di) < n && Math.abs(dj) < n) {
      const i0 = Math.max(0, -di), i1 = Math.min(n, n - di), j0 = Math.max(0, -dj), j1 = Math.min(n, n - dj);
      for (let j = j0; j < j1; j++) {
        const d = j * n, s = (j + dj) * n + di;
        b.raw.y.set(old.raw.y.subarray(s + i0, s + i1), d + i0);
        b.raw.ok.set(old.raw.ok.subarray(s + i0, s + i1), d + i0);
        b.raw.col.set(old.raw.col.subarray(3 * (s + i0), 3 * (s + i1)), 3 * (d + i0));
        b.raw.dir.set(old.raw.dir.subarray(3 * (s + i0), 3 * (s + i1)), 3 * (d + i0));
        b.raw.can.set(old.raw.can.subarray(4 * (s + i0), 4 * (s + i1)), 4 * (d + i0));
        if (b.raw.wat && old.raw.wat) b.raw.wat.set(old.raw.wat.subarray(s + i0, s + i1), d + i0);
      }
      if (stand && L.stand) b.parts.push(keep(old, b, i0, i1, j0, j1, di, dj));   // the old ring's stand-ins on the samples kept
      b.fresh = false;
      rects = [];
      if (j0 > 0) rects.push([0, j0, 0, n]);
      if (j1 < n) rects.push([j1, n, 0, n]);
      if (i0 > 0) rects.push([j0, j1, 0, i0]);
      if (i1 < n) rects.push([j0, j1, i1, n]);
    }
  }
  L.building = b;
  // a ring built from nothing (a new world, a teleport): coarse rings first, so the whole view fills in quickly and sharpens; a ring
  // moving with the player: the finest first
  const prio = b.fresh ? -1 - L.lv : L.lv;
  for (const [j0, j1, i0, i1] of rects) {
    // about 12,000 samples a job (a few hundred ms in a worker): few enough answers that a slow frame doesn't leave workers idle
    const w = i1 - i0, step = Math.max(1, Math.floor(12000 / w));
    for (let j = j0; j < j1; j += step) {
      const job = { f, u0: gu0 + i0 * c, v0: gv0 + j * c, cell: c, nx: w, ny: Math.min(step, j1 - j), stand, real: REAL };   // (real: the samples also say where water is, its colour its floor's: js/grid.js)
      b.pending++;
      BF.sampler.request(job, prio, (res) => {
        if (L.building !== b) return;
        for (let jj = 0; jj < job.ny; jj++) {
          const s = jj * w, d = (j + jj) * n + i0;
          b.raw.y.set(res.y.subarray(s, s + w), d);
          b.raw.ok.set(res.ok.subarray(s, s + w), d);
          b.raw.col.set(res.col.subarray(3 * s, 3 * (s + w)), 3 * d);
          b.raw.dir.set(res.dir.subarray(3 * s, 3 * (s + w)), 3 * d);
          b.raw.can.set(res.can.subarray(4 * s, 4 * (s + w)), 4 * d);
          if (b.raw.wat && res.wat) b.raw.wat.set(res.wat.subarray(s, s + w), d);
        }
        if (res.stand && b.parts) b.parts.push(res.stand);
        if (--b.pending === 0) build(L, b);
      }, L);
    }
  }
  if (!b.pending) build(L, b);
}

// Builds ring L's mesh from its samples (in a worker), then swaps it in.
function build(L, b) {
  const p = { n: b.n, c: L.cell, gu0: b.gu0, gv0: b.gv0, cu: b.cu, cv: b.cv, anchor: b.anchor, bridge: L.lv === CELLS.length - 1, ext: EXT, disc: HALF, real: REAL };
  const raw = b.raw;
  b.tm = performance.now();
  const copy = BF.sampler.inline ? raw : { y: raw.y.slice(), col: raw.col.slice(), can: raw.can.slice(), ok: raw.ok.slice(), dir: raw.dir.slice(), wat: raw.wat && raw.wat.slice() };
  BF.sampler.request({ mesh: true, p, raw: copy }, -100, (m) => { if (L.building === b) finish(L, b, m); }, L);
}
let fullIdx = null, fullCounts = null;
function finish(L, b, m) {
  const t0 = performance.now(), Pl = P();
  const g = new THREE.BufferGeometry();
  const attr = (a, k, norm) => { const x = new THREE.BufferAttribute(a, k, !!norm); x.onUpload(free); return x; };
  g.setAttribute("position", attr(m.pos, 3));
  g.setAttribute("sphere", attr(m.sph, 3));
  g.setAttribute("col", attr(m.col, 3, true));
  g.setAttribute("mflat", attr(m.mpos, 3));
  g.setAttribute("msph", attr(m.msph, 3));
  g.setAttribute("mcol", attr(m.mcol, 3, true));
  g.setAttribute("canopy", attr(m.can, 4, true));
  if (m.wat) g.setAttribute("wat", attr(m.wat, 1, true));
  if (m.gnd) g.setAttribute("gnd", attr(m.gnd, 2, true));
  if (m.nrm) g.setAttribute("nrm", attr(m.nrm, 3, true));
  if (m.idx) g.setIndex(attr(m.idx, 1));
  else g.setIndex(fullIdx);
  L.counts = m.idx ? m.counts : fullCounts; L.bounds = m.bounds;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), L.cell * EXT * 1.5 + 4000);
  // the ring keeps its material: freeing it would drop its shader program, compiled again for the new mesh (tens of ms). It is the only
  // entry of the mesh's material list, which lets the mesh draw just the sectors in view as groups (cull)
  if (!L.mat) L.mat = material(L.lv < CELLS.length - 1);
  const mesh = new THREE.Mesh(g, [L.mat]);
  const a = Pl.atlas(b.f, b.cu, b.cv);
  mesh.matrixAutoUpdate = false;
  mesh.position.set(a.x, 0, a.z); mesh.updateMatrix();
  mesh.userData = { anchor: b.anchor, lod: L.lv };
  L.mat.uniforms.anchor.value.set(b.anchor[0], b.anchor[1], b.anchor[2]);
  if (L.mat.uniforms.texO) L.mat.uniforms.texO.value.set(b.cu % 1600, b.cv % 1600);
  if (L.mesh) { L.mesh.parent && L.mesh.parent.remove(L.mesh); L.mesh.geometry.dispose(); }
  // the stand-ins: their own object, placed the same way (kept with their material, like the ring)
  const S = b.parts ? join(b.parts) : null;
  L.mat.uniforms.stand.value = S ? 1 / (1 << 2 * THIN[L.lv]) : 0;   // the share of tree cells drawn as stand-ins
  if (L.si) { L.si.parent && L.si.parent.remove(L.si); for (const ch of L.si.children) ch.geometry.dispose(); L.si.geometry.dispose(); }
  if (S) {
    const boxes = L.lv < BOX_LEVELS, mat = L.si ? L.si.material : standMaterial(boxes), geo = standGeometry(S, boxes, L.lv > 0);
    geo.boundingSphere = g.boundingSphere;   // (js/view.js culls by it while the view is flat)
    const si = boxes ? new THREE.Mesh(geo, mat) : new THREE.Points(geo, mat);
    const fr = Pl.frame(b.f, b.cu, b.cv, BF.SEA, {}), U = fr.eu, Up = fr.up, W = fr.ev;
    mat.uniforms.frame.value.set(U[0], Up[0], W[0], U[1], Up[1], W[1], U[2], Up[2], W[2]);
    mat.uniforms.centre.value.set(b.cu, b.cv);
    si.frustumCulled = false; si.matrixAutoUpdate = false;
    si.position.copy(mesh.position); si.updateMatrix();
    si.userData = { anchor: b.anchor, lod: L.lv, stand: true };
    si.visible = false;
    if (geo.userData.cards) {   // (the realistic look: the ring's trees as cards, placed and shown with the boxes)
      const tc = new THREE.Mesh(geo.userData.cards, mat);
      tc.frustumCulled = false; tc.matrixAutoUpdate = false; tc.matrixWorld = si.matrixWorld;
      si.add(tc);
    }
    L.si = si;
    lod.scene.add(si);
  } else L.si = null;
  L.stand = S; L.anchor = b.anchor;
  L.mesh = mesh; L.raw = b.raw; L.f = b.f; L.cu = b.cu; L.cv = b.cv; L.gu0 = b.gu0; L.gv0 = b.gv0;
  L.buildMs = performance.now() - b.t0; L.meshMs = b.tm ? t0 - b.tm : 0; L.building = null; L.builds = (L.builds || 0) + 1;
  lod.scene.add(mesh);
  lod.mainMs = Math.max(lod.mainMs || 0, performance.now() - t0);
  (lod.swaps || (lod.swaps = [])).push(Math.round(performance.now() - t0)); if (lod.swaps.length > 64) lod.swaps.shift();
}
function free() { if (this.array !== (fullIdx && fullIdx.array)) this.array = null; }

// How far point (f, u, v) is from ring L's centre, in blocks of f's grid (Infinity when L's face can't be unfolded next to f).
function offset(L, f, u, v) {
  if (L.f < 0) return Infinity;
  const e = L.f === f ? ID : P().UNFOLD[f][L.f];
  if (!e) return Infinity;
  const U = e.A[0] * L.cu + e.A[1] * L.cv + e.t[0], W = e.A[2] * L.cu + e.A[3] * L.cv + e.t[1];
  return Math.max(Math.abs(U - u), Math.abs(W - v));
}
const ID = { A: [1, 0, 0, 1], t: [0, 0] };

// Which sectors of each ring are drawn this frame (js/main.js calls it after js/view.js has placed everything for the frame): those whose
// bounds (js/grid.js sectorBounds) aren't wholly outside the view, each from where the finer ring or the loaded chunks stop covering it
// (L.skip cells out). Every vertex the shader draws lies between a point of the sector's flat box and one of its round box (mapped by
// sphM), mixed by world.roundK, so a sector is left out only when all the corners of the boxes it uses are outside one side of the view.
const cullM = new THREE.Matrix4(), cullS = new THREE.Matrix4(), cullE = new Float32Array(16 * 4);
lod.cull = function (camera) {
  if (!lod.active) return;
  const k = BF.world.roundK ? BF.world.roundK.value : 0, NS = BF.gridJob.SECTORS;
  for (const L of lod.levels) {
    const mesh = L.mesh;
    if (!mesh || !mesh.visible || !L.bounds) { L.tris = 0; continue; }
    const g = mesh.geometry, C = L.counts, K1 = (C.length - 1) / NS, b = L.bounds, skip = Math.min(K1, (L.skip || 0) + 1);
    cullM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
    cullS.multiplyMatrices(cullM, L.mat.userData.sphM);
    const m = cullM.elements, ms = cullS.elements, e = cullE;
    g.clearGroups();
    let tris = 0, open = -1, end = -1;
    for (let s = 0; s < NS; s++) {
      const a = C[s * K1 + skip], z = C[(s + 1) * K1];
      if (z <= a) continue;
      // the corners in clip space: the flat box (unless fully round) and the round box (once partly round)
      let np = 0;
      for (let h = 0; h < 2; h++) {
        if (h === 0 ? k >= 1 : k <= 0) continue;
        const M = h === 0 ? m : ms, o = s * 12 + 6 * h;
        for (let c = 0; c < 8; c++) {
          const x = b[o + (c & 1 ? 3 : 0)], y = b[o + 1 + (c & 2 ? 3 : 0)], w0 = b[o + 2 + (c & 4 ? 3 : 0)], q = 4 * np++;
          e[q] = M[0] * x + M[4] * y + M[8] * w0 + M[12]; e[q + 1] = M[1] * x + M[5] * y + M[9] * w0 + M[13];
          e[q + 2] = M[2] * x + M[6] * y + M[10] * w0 + M[14]; e[q + 3] = M[3] * x + M[7] * y + M[11] * w0 + M[15];
        }
      }
      let out = false;
      for (let pl = 0; pl < 6 && !out; pl++) {
        const ax = pl >> 1, sg = pl & 1 ? 1 : -1;
        out = true;
        for (let p = 0; p < np && out; p++) if (sg * e[4 * p + ax] <= e[4 * p + 3]) out = false;   // inside this side: -w <= x (or x <= w)
      }
      if (out) continue;
      if (a !== end) { if (open >= 0) g.addGroup(6 * open, 6 * (end - open), 0); open = a; }
      end = z; tris += 2 * (z - a);
    }
    if (open >= 0) g.addGroup(6 * open, 6 * (end - open), 0);
    // the corner bridge (the coarsest ring), after the cells: always drawn
    const cells = C[NS * K1] * 6, all = g.index.count;
    if (all > cells) { g.addGroup(cells, all - cells, 0); tris += (all - cells) / 3; }
    L.tris = tris;
  }
};

// The radius covered by the coarsest ring drawn (0 if none), for fog and the far clip plane.
lod.radius = function () {
  let r = 0;
  if (lod.active) for (const L of lod.levels) if (L.mesh && L.show) r = L.half;
  return r;
};

// Sets m to the map from face g's grid into face f's (3x3), or far away when g is opposite f.
function unfoldMatrix(m, f, g) {
  const e = f === g ? ID : P().UNFOLD[f][g];
  if (!e) m.set(0, 0, 1e9, 0, 0, 1e9, 0, 0, 1);
  else m.set(e.A[0], e.A[1], e.t[0], e.A[2], e.A[3], e.t[1], 0, 0, 1);
  return m;
}

// Called each frame on the planet, after the world update.
let last = null, speed = 0;
lod.update = function (budgetMs = 4) {
  if (!lod.active || !BF.player || !BF.player.position) return;
  if (BF.sampler.inline && !BF.lodInline) { off(); return; }   // the workers failed to load
  const t0 = performance.now();
  update(budgetMs);
  // main-thread time per frame (without inline sampling, which has its own budget): for the budget test
  const ms = performance.now() - t0 - (BF.sampler.inline ? Math.min(budgetMs, lod.sampleMs || 0) : 0);
  lod.frameMs = ms; if (ms > (lod.maxFrameMs || 0)) lod.maxFrameMs = ms;
  lod.frames = (lod.frames || 0) + 1; if (ms > 25) lod.slowFrames = (lod.slowFrames || 0) + 1;
};
function update(budgetMs) {
  const Pl = P(), pp = (BF.player.viewPos ? BF.player.viewPos() : BF.player.position), gr = Pl.grid(pp.x, pp.z);   // (round the detached view, r15-98)
  if (gr.f < 0) return;
  const V = lod.view, now = performance.now();
  V.f = gr.f; V.u = gr.u; V.v = gr.v;
  const ts = performance.now();
  BF.sampler.tick(budgetMs);
  lod.sampleMs = performance.now() - ts;
  // speed over the ground (blocks per second), to leave rings alone while the player outruns them
  if (last && last.f === V.f && now > last.t) {
    const dt = (now - last.t) / 1000, d = Math.hypot(V.u - last.u, V.v - last.v);
    if (d > 2000) speed = 0;   // a teleport, not flight
    else speed += (d / dt - speed) * Math.min(1, dt * 2);
  }
  last = { f: V.f, u: V.u, v: V.v, t: now };
  // height above the ground
  let ground = BF.SEA;
  try { ground = Math.max(BF.SEA, BF.worldgen.heightAt(Math.floor(pp.x), Math.floor(pp.z))); } catch (_) {}
  const above = Math.max(0, pp.y - ground);
  lod.above = above;
  if (BF.renderer && BF.camera) pxScale.value = BF.renderer.getDrawingBufferSize(tmpV2).y / (2 * Math.tan(BF.camera.fov * Math.PI / 360));
  const top = lod.levels[lod.levels.length - 1];
  // fast-forward from 10x: built rings stay where they are and rivers aren't re-laid, leaving the frame to the simulation (a ring the
  // player leaves behind is still drawn; the coarser rings cover beyond it)
  const ff = !!(BF.warp && BF.warp.speed >= 10);
  for (const L of lod.levels) {
    L.show = above < HIDE * L.cell;
    L.draw = L.show && L.cell < lod.cap;   // (from planet height the coarser rings are left to the globe's finer tiles: js/globe.js)
    if (!L.show) { if (L.building) { BF.sampler.cancel(L); L.building = null; } if (L.si) L.si.visible = false; continue; }
    if (L.building || (L.mesh && (ff || offset(L, V.f, V.u, V.v) <= MOVE * L.half))) continue;
    // too fast for this ring: coarser rings cover until the player slows (while the player is still over it)
    if (L.mesh && speed * L.buildMs / 1000 > 0.5 * L.half && offset(L, V.f, V.u, V.v) < L.half) continue;
    const c = L.cell * 4;
    start(L, V.f, Math.round(V.u / c) * c, Math.round(V.v / c) * c);
  }
  if (above < RIBBON_HIDE && !(ff && lod.ribbon)) ribbons(V, top);
  // cut each ring to its disc, minus the next finer ring's disc and the loaded chunks
  lod.eyeHole = Math.min(BF.world.viewDist * BF.CS, BF.world.covered || 0) * 0.95;
  if (BF.player.detached && !BF.world.replica) lod.eyeHole = 0;   // (detached in the page: the chunks load round the body, not the view; the chunk mask alone keeps the rings off them, r15-98)
  markChunks(pp, V);
  let prev = null, outer = top;   // outer: the coarsest ring drawn when the globe has taken the rest (it meets the globe as the top ring does)
  if (lod.cap < Infinity) for (const L of lod.levels) if (L.draw) outer = L;
  const lastStand = lod.levels[STAND_LEVELS - 1];
  for (const L of lod.levels) {
    if (!L.mesh) continue;
    L.mesh.visible = L.draw;
    if (!L.draw) { if (L.si) L.si.visible = false; continue; }
    const u = L.mat.uniforms, fine = prev && prev.mesh && prev.draw ? prev : null;
    cuts(u, V, lod.eyeHole, fine);
    u.outer.value.set(0, 0, L.half);
    // the middle that the finer ring or the loaded chunks certainly cover isn't drawn at all (its cells come first in the index)
    L.skip = Math.floor(covered(L, V, fine) / L.cell);
    u.morph.value.set(L === outer ? 1e30 : L.half * MORPH0, L === outer ? 2e30 : L.half * MORPH1);
    // stand-ins fade out across the outer part of the last ring that has them
    if (L === lastStand) u.edge.value.set(L.half * 0.7, L.half * 0.95);
    if (L.si) {
      // too far to show from this height (a 10-block patch under a pixel straight down), all of it beyond where any is shown (its inner
      // edge, the finer ring's disc, past 10 blocks a pixel), or all among the loaded chunks: not drawn at all
      const inner = fine ? fine.half * (HOLE - MOVE) : 0;
      L.si.visible = 10 * pxScale.value > Math.max(above, inner) && lod.eyeHole < L.half * 0.95;
      const s = L.si.material.uniforms;
      s.hole.value.copy(u.hole.value); s.hole2.value.copy(u.hole2.value); s.seam2.value = u.seam2.value; s.outer.value.copy(u.outer.value);
      unfoldMatrix(s.toHole.value, V.f, L.f);
      if (fine) unfoldMatrix(s.toHole2.value, fine.f, L.f);
      s.edge.value.copy(u.edge.value);
    }
    prev = L;
  }
  if (lod.ribbon) {
    lod.ribbon.visible = above < RIBBON_HIDE;
    const u = lod.ribbon.material.uniforms;
    cuts(u, V, lod.eyeHole, null);
    u.outer.value.set(0, 0, top.half);
  }
}
const tmpV2 = new THREE.Vector2();
// Fills the chunk mask round the player's chunk (atlas position pp, view face V) and places it in the view face's grid; uploads it only
// when it changed. A chunk with a mesh outside it would show its stand-ins over it again: logged once (it can't happen at view
// distances up to 32).
let maskWarned = false;
function markChunks(pp, V) {
  const W = BF.world, CS = BF.CS, H = MASK_N / 2;
  const ox = Math.floor(pp.x / CS) - H, oz = Math.floor(pp.z / CS) - H;
  maskNext.fill(0);
  let outside = 0;
  const mark = (cx, cz) => {
    const i = cx - ox, j = cz - oz;
    if (i < 0 || j < 0 || i >= MASK_N || j >= MASK_N) { outside++; return; }
    maskNext[j * MASK_N + i] = 255;
  };
  for (const c of W.chunks.values()) if (c.mesh === true && c.meshes && c.meshes.length) mark(c.cx, c.cz);
  for (const k of W.farMeshes.keys()) { const i = k.indexOf(","); mark(+k.slice(0, i), +k.slice(i + 1)); }
  if (outside && !maskWarned && BF.glog) {
    maskWarned = true;
    BF.glog.log("ERROR", "terrain", outside + " drawn chunk" + (outside > 1 ? "s lie" : " lies") + " outside the distant terrain's chunk mask: village and tree stand-ins may show over them");
  }
  // the mask's corner in the view face's grid (atlas x = W f + N + u, z = N + v; js/planet.js)
  const Pl = P();
  maskO.value.set(ox * CS - Pl.W * V.f - Pl.N, oz * CS - Pl.N);
  if (lod.maskOff) maskO.value.set(1e9, 1e9);   // (tests: stand-ins drawn as before the mask)
  let same = true;
  for (let i = 0; i < maskData.length; i++) if (maskData[i] !== maskNext[i]) { same = false; break; }
  if (!same) { maskData.set(maskNext); chunkMask.value.needsUpdate = true; lod.maskChanges = (lod.maskChanges || 0) + 1; }
}
// (tests) whether the chunk mask marks chunk (cx, cz) as drawn
lod.masked = (cx, cz) => {
  const pp = (BF.player.viewPos ? BF.player.viewPos() : BF.player.position), H = MASK_N / 2, i = cx - Math.floor(pp.x / BF.CS) + H, j = cz - Math.floor(pp.z / BF.CS) + H;
  return i >= 0 && j >= 0 && i < MASK_N && j < MASK_N && maskData[j * MASK_N + i] > 0;
};
// How far from ring L's centre it is certainly covered by the loaded chunks or the finer ring (blocks; 0 if unsure): measured only within
// one face's grid, and not near a cube corner, where the finer ring leaves a strip along its wedge and unfolding depends on the route.
function covered(L, V, fine) {
  const N = P().N, c = L.cell;
  let r = 0;
  if (L.f === V.f) r = lod.eyeHole - Math.hypot(V.u - L.cu, V.v - L.cv);
  if (fine && fine.f === L.f) r = Math.max(r, fine.half * HOLE - Math.hypot(fine.cu - L.cu, fine.cv - L.cv));
  r -= 2 * c;
  if (r <= 0) return 0;
  const corner = Math.hypot(Math.min(L.cu, N - L.cu), Math.min(L.cv, N - L.cv));
  return corner < r + (fine ? 2 * fine.cell + 8 : 0) + 4 * c ? 0 : r;
}
// The cuts of a ring material: the loaded chunks' disc around the player in the view face's grid, and the finer ring's disc in its grid.
function cuts(u, V, r, fine) {
  u.hole.value.set(V.u, V.v, r);
  for (let i = 0; i < 6; i++) unfoldMatrix(u.toHole.value[i], V.f, i);
  if (!fine) { u.hole2.value.set(0, 0, 0); u.seam2.value = 0; return; }
  u.hole2.value.set(fine.cu, fine.cv, fine.half * HOLE);
  for (let i = 0; i < 6; i++) unfoldMatrix(u.toHole2.value[i], fine.f, i);
  u.seam2.value = 2 * fine.cell + 8;
}

// ---- rivers as ribbons ----
// A sampled grid shows a river narrower than its cells only as a broken line, so out where the rings are, rivers are ribbons along the
// river network's own curves, at least MINW blocks either side of the centre line, at the water surface; a segment whose end lies at sea
// is dropped (the sea is drawn already). Needs the planet's river network (r14-10, the prototype's rivers.js API: link, down, rs, sea,
// geom(li), inFace(f, node, out), view(li, f)); until then there is nothing to draw.
function ribbons(V, top) {
  const RV = BF.planetRivers || null;
  if (!RV || !RV.link) return;
  const ext = top.half * EXT / HALF, c = top.cell * 4;
  if (lod.ribbon && lod.ribbonAt && offset({ f: lod.ribbonAt[0], cu: lod.ribbonAt[1], cv: lod.ribbonAt[2] }, V.f, V.u, V.v) <= top.half * MOVE) return;
  const Pl = P(), f = V.f, cu = Math.round(V.u / c) * c, cv = Math.round(V.v / c) * c;
  if (lod.ribbon) { dispose(lod.ribbon); lod.ribbon = null; }
  lod.ribbonAt = [f, cu, cv];
  const anchor = Pl.pos(f, cu, cv, BF.SEA, [0, 0, 0]), flat = [], sph = [], col = [], idx = [], g = {}, q = [0, 0, 0];
  const W = lod.pal.top[BF.B.water], wc = [W[0] * 0.85 * 255, W[1] * 0.95 * 255, W[2] * 255];
  for (let li = 0; li < RV.link.length; li++) {
    const n = RV.link[li];
    const A = RV.inFace(f, n, [0, 0]), Bq = RV.inFace(f, RV.down[n], [0, 0]);
    if (!A || !Bq || Math.min(Math.abs(A[0] - cu), Math.abs(Bq[0] - cu)) > ext + 2000 || Math.min(Math.abs(A[1] - cv), Math.abs(Bq[1] - cv)) > ext + 2000) continue;
    const cv0 = RV.view(li, f), r0 = RV.rs[n], r1 = RV.rs[RV.down[n]], hw = Math.max(MINW, cv0.w), K = cv0.xs.length - 1;
    const prof = RV.geom(li).r, mouth = RV.sea[RV.down[n]];
    let wetPrev = false;
    for (let k = 0; k <= K; k++) {
      const x = cv0.xs[k], y = cv0.ys[k];
      const k0 = Math.max(0, k - 1), k1 = Math.min(K, k + 1), tx = cv0.xs[k1] - cv0.xs[k0], ty = cv0.ys[k1] - cv0.ys[k0], tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl * hw, ny = tx / tl * hw;
      // lifted by half a ring cell at this distance, since coarse cells bridge across narrow valleys
      const h = (prof ? prof[k] : r0 + (r1 - r0) * k / K) + 0.9 + Math.hypot(x - cu, y - cv) / (2 * HALF);
      const base = flat.length / 3;
      for (const sgn of [-1, 1]) {
        const px = x + nx * sgn, py = y + ny * sgn;
        flat.push(px - cu, h, py - cv);
        Pl.wrap(f, px, py, g); Pl.dir(g.f, g.u, g.v, q);
        const rr = Pl.R + (h - BF.SEA);
        sph.push(q[0] * rr - anchor[0], q[1] * rr - anchor[1], q[2] * rr - anchor[2]);
        col.push(wc[0], wc[1], wc[2]);
      }
      let wet = false;
      if (mouth) { Pl.wrap(f, x, y, g); const a = Pl.atlas(g.f, g.u, g.v); wet = BF.worldgen.heightAt(a.x, a.z) < BF.SEA; }
      if (k > 0 && !wet && !wetPrev && Math.abs(x - cu) <= ext && Math.abs(y - cv) <= ext) idx.push(base - 2, base, base - 1, base - 1, base, base + 1);
      wetPrev = wet;
    }
  }
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry(), nv = flat.length / 3;
  geo.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  geo.setAttribute("sphere", new THREE.Float32BufferAttribute(sph, 3));
  geo.setAttribute("col", new THREE.BufferAttribute(new Uint8Array(col), 3, true));
  geo.setAttribute("canopy", new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true));
  if (REAL) {   // (a river is water, and flat: FRAG_USED)
    geo.setAttribute("wat", new THREE.BufferAttribute(new Uint8Array(nv).fill(255), 1, true));
    const up = new Int8Array(nv * 3); for (let i = 1; i < up.length; i += 3) up[i] = 127;
    geo.setAttribute("nrm", new THREE.BufferAttribute(up, 3, true));
  }
  geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  const mat = material(false);
  mat.side = THREE.DoubleSide;
  mat.uniforms.anchor.value.set(anchor[0], anchor[1], anchor[2]);
  const mesh = new THREE.Mesh(geo, mat);
  const a = Pl.atlas(f, cu, cv);
  mesh.matrixAutoUpdate = false;
  mesh.position.set(a.x, 0, a.z); mesh.updateMatrix();
  mesh.userData = { anchor, lod: "ribbon" };
  lod.ribbon = mesh;
  lod.scene.add(mesh);
}

// for the globe (js/globe.js): the same material and cuts
lod.material = material; lod.cuts = cuts; lod.HIDE = HIDE;
if (REAL) { lod.standMaterial = standMaterial; lod.standGeometry = standGeometry; }   // (test/real-lod.js)

// Numbers for tests and the debug overlay.
lod.stats = () => ({
  active: lod.active, above: lod.above, eyeHole: lod.eyeHole, pending: BF.sampler ? BF.sampler.pending(BF.globe) : 0,   // (without the globe's tiles: js/globe.js)
  inline: BF.sampler && BF.sampler.inline,
  rings: lod.levels.map((L) => ({ cell: L.cell, show: L.show, built: !!L.mesh, building: !!L.building, builds: L.builds || 0, f: L.f, cu: L.cu, cv: L.cv, buildMs: Math.round(L.buildMs), meshMs: Math.round(L.meshMs),
    stands: L.stand ? L.stand.c.length : 0, standsShown: !!(L.si && L.si.visible), tris: L.mesh && L.mesh.visible ? L.tris || 0 : 0 })),
  pxScale: pxScale.value,
  mainMs: lod.mainMs || 0, frames: lod.frames || 0, slowFrames: lod.slowFrames || 0, swaps: lod.swaps || [], maxFrameMs: lod.maxFrameMs || 0, workers: BF.sampler ? BF.sampler.workers.length : 0,
  samples: BF.sampler ? BF.sampler.samples : 0, msPerSample: BF.sampler && BF.sampler.samples ? BF.sampler.workMs / BF.sampler.samples : 0,
});
})();
