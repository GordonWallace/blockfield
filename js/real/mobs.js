// Blockfield 1.6, the realistic look: js/real/mobs.js. Owner: the Atmosphere and creatures thread (docs/REALISTIC_CONTRACT.md section 7).
// Drawing only. Nothing here may run unless BF.real.on.
//
// Mobs and villagers in the realistic look. The models, the animation and everything the simulation says about a mob stay
// js/mobview.js's; with the look on its guarded hooks come here, so a mob is lit like the land it stands on:
//   - material(): one lit material per mob (vertex colours, matte) through BF.real.lit, so the sun, the sky and the moon shade its
//     faces, a roof or a cave dims it by the sky light of its cell, and a torch warms it (contract section 3). mobview.js builds
//     the geometry with normals and without the baked face shades when the look is on.
//   - part(mesh): each body part casts and takes shadows (when the renderer's shadow map is on).
//   - view(v, mob): a soft contact shadow on the ground under the mob, which keeps it planted when shadow maps are off or coarse.
//   - light(v, mob, x, y, z): once a frame: the cell's light into the material and the contact shadow's strength. Returns the
//     model's albedo scale: the colour mobview.js then sets is only that and the tint (red when hurt, white for a creeper's fuse),
//     no longer the light level.
//   - ease(v, mob, y, dt): the height the model is drawn at: it glides up and down one-block steps, which the ground draws as slopes.
// API: BF.real.mobs = { material(), part(mesh), view(v, mob), light(v, mob, x, y, z) -> albedo scale, ease(v, mob, y, dt) -> y }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;

// The painted colours are bright (pure whites, pinks); under the noon sun they would burn out, so the models reflect a little less.
const ALBEDO = 0.56;
// The contact shadows: every mob's soft dark disc on the ground, all in one mesh and one draw call (they were a mesh and a draw each:
// 170 of 1,000 draws in a village at view distance 16, Gordon's 20 fps, 2026-11-13). light() adds a mob's quad as mobview.js draws it;
// the module's frame() (after the mobs, before the picture) uploads them. The mesh sits at the chunk corner under the first mob, so
// js/view.js places it like any other object; a mob on another face of the planet than that corner gets no disc this frame.
const BLOB_VERT = `
attribute float alpha;
varying vec2 vUv; varying float vA;
void main() { vUv = uv; vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// (the old canvas gradient: 0.85 at the centre, 0.5 at 0.45 of the radius, 0 at the rim)
const BLOB_FRAG = `
varying vec2 vUv; varying float vA;
void main() {
  float r = min(1.0, length(vUv - 0.5) * 2.0);
  float g = r < 0.45 ? mix(0.85, 0.5, r / 0.45) : mix(0.5, 0.0, (r - 0.45) / 0.55);
  gl_FragColor = vec4(0.0, 0.0, 0.0, g * vA);
}`;
const blobs = { mesh: null, cap: 0, n: 0, pos: null, uv: null, al: null, ox: 0, oz: 0, face: -1, drawn: 0 };
function blobRoom(n) {
  if (n <= blobs.cap) return;
  const cap = Math.max(64, blobs.cap * 2, n), pos = new Float32Array(cap * 12), uv = new Float32Array(cap * 8), al = new Float32Array(cap * 4), ix = new Uint32Array(cap * 6);
  if (blobs.pos) { pos.set(blobs.pos); al.set(blobs.al); }
  for (let i = 0; i < cap; i++) {
    uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
    ix.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("alpha", new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(ix, 1));
  if (!blobs.mesh) {
    const mat = new THREE.ShaderMaterial({ vertexShader: BLOB_VERT, fragmentShader: BLOB_FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    blobs.mesh = new THREE.Mesh(g, mat);
    blobs.mesh.frustumCulled = false; blobs.mesh.renderOrder = 2; blobs.mesh.userData.mobBlobs = true;
    (BF.real.scene || BF.scene).add(blobs.mesh);
  } else { blobs.mesh.geometry.dispose(); blobs.mesh.geometry = g; }
  blobs.cap = cap; blobs.pos = pos; blobs.uv = uv; blobs.al = al;
}
// One mob's disc: centre (x, y, z) in atlas coordinates, w across, strength a (0..0.5, in sixteenths as the old materials were).
function blobAdd(x, y, z, w, a) {
  const P = BF.planet, f = P && P.face ? P.face(x, z) : 0;
  if (!blobs.n) { blobs.ox = Math.floor(x / 16) * 16; blobs.oz = Math.floor(z / 16) * 16; blobs.face = f; }
  else if (f !== blobs.face) return;
  blobRoom(blobs.n + 1);
  const o = blobs.n * 12, p = blobs.pos, h = w / 2, lx = x - blobs.ox, lz = z - blobs.oz;
  p[o] = lx - h; p[o + 1] = y; p[o + 2] = lz + h;
  p[o + 3] = lx + h; p[o + 4] = y; p[o + 5] = lz + h;
  p[o + 6] = lx + h; p[o + 7] = y; p[o + 8] = lz - h;
  p[o + 9] = lx - h; p[o + 10] = y; p[o + 11] = lz - h;
  blobs.al.fill(Math.round(a * 16) / 16, blobs.n * 4, blobs.n * 4 + 4);
  blobs.n++;
}
function blobFrame() {
  const m = blobs.mesh;
  blobs.drawn = blobs.n;
  if (!m) return;
  m.visible = blobs.n > 0;
  if (blobs.n) {
    const g = m.geometry;
    m.position.set(blobs.ox, 0, blobs.oz);
    g.setDrawRange(0, blobs.n * 6);
    g.attributes.position.needsUpdate = true; g.attributes.alpha.needsUpdate = true;
  }
  blobs.n = 0;
}

const cell = new THREE.Vector2();
const mobs = {
  material() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    return BF.real.lit(mat, { light: "cell" });
  },
  part(mesh) { mesh.castShadow = true; mesh.receiveShadow = true; },
  view(v, m) { v.blob = { visible: false, strength: 0 }; },   // (its contact shadow: a quad of the one mesh, see blobAdd)
  // The height a mob is drawn at. The simulation lifts it a whole block in one tick where the ground rises a block; the ground is
  // drawn as a slope there, so the model catches up over a moment instead of hopping (and the same going down).
  ease(v, m, y, dt) {
    const d = y - v.easeY;
    if (!(Math.abs(d) < 1.3) || m.sleeping || m.riding != null || m.dead) return (v.easeY = y);   // first frame, a jump, a fall, a teleport
    const s = Math.max(5, Math.abs(d) * 16) * dt;
    return (v.easeY = Math.abs(d) <= s ? y : v.easeY + Math.sign(d) * s);
  },
  light(v, m, x, y, z) {
    BF.real.cellLight(x, y, z, cell);
    if (BF.skyLight) { const l = BF.skyLight.get(x, y, z); cell.x = l === 15 ? 1 : BF.skyLight.bright(l); }   // (the sky light mobview.js lights mobs by)
    const u = v.mat.userData.cell;
    if (u) u.value.copy(cell);
    const b = v.blob;
    if (b) {
      // darkest under an open bright sky, gone in the dark, in a bed, in water and once dead; under a roof a faint one from the room's light
      const A = BF.atmos, day = A ? Math.min(1, A.hemiIntensity / 0.6 + A.sunIntensity / 1.5) : 1;
      const want = m.sleeping || m.dead || m.inWater || m.riding != null ? 0 : 0.5 * Math.min(1, day) * (0.35 + 0.65 * cell.x);
      b.strength = want;
      b.visible = want > 0.02 && v.root.visible;
      if (b.visible) blobAdd(v.root.position.x, v.root.position.y + 0.03, v.root.position.z, ((m.hw || 0.3) * 2 + 0.25) * (m.scale || 1) * 1.5, want);
    }
    return ALBEDO;
  },
};
BF.real.mobs = mobs;
mobs.blobs = blobs;
BF.real.module({ name: "mobs", frame: blobFrame });
})();
