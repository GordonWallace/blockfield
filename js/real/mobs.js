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
// API: BF.real.mobs = { material(), part(mesh), view(v, mob), light(v, mob, x, y, z) -> albedo scale }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;

// The painted colours are bright (pure whites, pinks); under the noon sun they would burn out, so the models reflect a little less.
const ALBEDO = 0.7;
let blobGeo = null, blobTex = null;
function blobTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(0,0,0,0.85)"); gr.addColorStop(0.45, "rgba(0,0,0,0.5)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// A few shared materials, one per strength step (so a mob that goes needs nothing disposed).
const blobMats = [];
function blobMat(a) {
  const i = Math.max(0, Math.min(8, Math.round(a * 16)));
  return blobMats[i] || (blobMats[i] = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: i / 16, depthWrite: false, fog: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
}

const cell = new THREE.Vector2();
const mobs = {
  material() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    return BF.real.lit(mat, { light: "cell" });
  },
  part(mesh) { mesh.castShadow = true; mesh.receiveShadow = true; },
  view(v, m) {
    if (!blobGeo) { blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); blobTex = blobTexture(); }
    const blob = new THREE.Mesh(blobGeo, blobMat(0));
    blob.position.y = 0.03; blob.renderOrder = 2;
    v.root.add(blob);
    v.blob = blob;
  },
  light(v, m, x, y, z) {
    BF.real.cellLight(x, y, z, cell);
    if (BF.skyLight) { const l = BF.skyLight.get(x, y, z); cell.x = l === 15 ? 1 : BF.skyLight.bright(l); }   // (the sky light mobview.js lights mobs by)
    const u = v.mat.userData.cell;
    if (u) u.value.copy(cell);
    const b = v.blob;
    if (b) {
      // darkest under an open bright sky, gone in the dark, in a bed, in water and once dead; under a roof a faint one from the room's light
      const A = BF.atmos, day = A ? Math.min(1, A.hemiIntensity / 0.6 + A.sunIntensity / 1.7) : 1;
      const want = m.sleeping || m.dead || m.inWater || m.riding != null ? 0 : 0.5 * Math.min(1, day) * (0.35 + 0.65 * cell.x);
      b.material = blobMat(want);
      b.visible = want > 0.02;
      if (b.visible) { const w = ((m.hw || 0.3) * 2 + 0.25) * (m.scale || 1) * 1.5; b.scale.set(w, 1, w); }
    }
    return ALBEDO;
  },
};
BF.real.mobs = mobs;
BF.real.module({ name: "mobs" });
})();
