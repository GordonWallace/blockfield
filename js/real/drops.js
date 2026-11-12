// Blockfield 1.6, the realistic look: js/real/drops.js. Dropped items as the look draws them (docs/REALISTIC_CONTRACT.md).
// 1.5 draws a dropped item as an unlit sprite of its inventory icon. Under the look's renderer (sRGB output, tone mapping) that
// sprite came out washed pale, because the icon's colours were taken as linear light, and it did not darken with the scene: a
// dropped dirt block was light tan on dark earth. Here:
// - an item that is a block of natural ground (dirt, sand, gravel, clay, stone, snow: the ground table of js/real/terrain.js) is a
//   small lump of that ground, in the ground's own colour, lit like the terrain around it;
// - every other item keeps its icon, with its colours read as sRGB and lit by the sun, the sky and the cell's light.
// js/entityview.js asks make(item) for the object to draw and light(obj, x, y, z, age) once a frame. Drawing only.
// API: BF.real.drops = { make(itemId) -> Object3D, light(obj, x, y, z, age), stats() -> { lumps, icons } }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on || typeof THREE === "undefined") return;
const T = THREE, real = BF.real;
const config = { size: 0.17, lumpShade: 1.05, iconAlbedo: 0.5, sun: 0.55, turn: 0.6 };
let made = { lumps: 0, icons: 0 };

let tab = null;
const tables = () => tab || (tab = real.meshTables ? real.meshTables() : null);
// the ground index of an item that is a block of natural ground, or -1 (turf gives soil, as the chips of js/real/dig.js)
function groundOf(id) {
  const t = tables(), it = BF.items[id];
  if (!t || !it || !it.isBlock || id > BF.MAX_BLOCK || !t.NAT[id]) return -1;
  let k = t.NAT[id] - 1;
  if (t.GTINT[k] && BF.B.dirt != null && t.NAT[BF.B.dirt]) k = t.NAT[BF.B.dirt] - 1;
  return k;
}

// ---------- lumps of ground ----------
// One shape per ground: an icosphere with its corners pushed in and out, flat faces, each face a little lighter or darker.
// Soil is a rounded clod with a few small stones, rock an angular piece, sand and gravel a low heap, snow a soft ball.
const hash = (a, b, c) => { let h = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2147483647)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const geos = new Map();
function lumpGeo(gi) {
  let g = geos.get(gi);
  if (g) return g;
  const t = tables(), layer = t.GLAY[gi];
  const rough = layer === 1 ? 0.3 : layer === 3 ? 0.08 : 0.2, flat = layer === 2 ? 0.6 : layer === 1 ? 0.8 : 0.78;
  g = new T.IcosahedronGeometry(1, layer === 1 ? 0 : 1);
  if (g.index) g = g.toNonIndexed();
  const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3);
  const base = [Math.pow(t.GCOL[gi * 3], 2.2) * 0.5, Math.pow(t.GCOL[gi * 3 + 1], 2.2) * 0.5, Math.pow(t.GCOL[gi * 3 + 2], 2.2) * 0.5];   // (as the terrain shader takes it)
  for (let i = 0; i < n; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (hash(Math.round(x * 1000) + gi * 7919, Math.round(y * 1000), Math.round(z * 1000)) - 0.5) * 2 * rough;   // (by position: a corner shared by faces moves as one)
    p.setXYZ(i, x * k, y * k * flat, z * k);
  }
  for (let f = 0; f < n / 3; f++) {
    const r = hash(f, gi, 17), stone = layer === 0 && hash(f, gi, 91) > 0.9;
    const s = config.lumpShade * (stone ? 1 : 0.72 + 0.5 * r);
    for (let j = 0; j < 3; j++) {
      const o = (f * 3 + j) * 3;
      if (stone) { col[o] = 0.17 * s; col[o + 1] = 0.16 * s; col[o + 2] = 0.15 * s; }
      else { col[o] = base[0] * s; col[o + 1] = base[1] * s; col[o + 2] = base[2] * s; }
    }
  }
  g.setAttribute("color", new T.BufferAttribute(col, 3));
  g.computeVertexNormals();
  geos.set(gi, g);
  return g;
}
function lump(gi) {
  const m = real.lit(new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true }), { light: "cell", key: "drop" });
  const o = new T.Mesh(lumpGeo(gi), m);
  o.scale.setScalar(config.size);
  o.userData.lump = true;
  made.lumps++;
  return o;
}

// ---------- icons ----------
const texs = new Map(), loader = new T.TextureLoader();
function iconTex(id) {
  let t = texs.get(id);
  if (!t) {
    t = loader.load(BF.textures.icon(id));
    t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter; t.generateMipmaps = false;
    t.encoding = T.sRGBEncoding;   // (the icon is a picture: without this its colours were lifted twice, hence the pale drops)
    texs.set(id, t);
  }
  return t;
}
function icon(id) {
  const o = new T.Sprite(new T.SpriteMaterial({ map: iconTex(id), transparent: true, alphaTest: 0.1 }));   // (a material each: each is lit by its own cell)
  o.scale.set(0.38, 0.38, 0.38);
  made.icons++;
  return o;
}

const cell = new T.Vector2(), WARM = [1, 0.72, 0.42];
real.drops = {
  config,
  make(id) { const gi = groundOf(id); return gi >= 0 ? lump(gi) : icon(id); },
  // Once a frame for a drawn item at (x, y, z): the light of its cell, and a lump turns slowly as it lies.
  light(o, x, y, z, age) {
    real.cellLight(x, y + 0.2, z, cell);
    if (o.userData.lump) {
      o.material.userData.cell.value.copy(cell);
      o.rotation.y = (age || 0) * config.turn;
      return;
    }
    // an icon has no faces to light: it takes what a matte surface facing the sky would get (BF.real.lit's rule, by hand)
    const U = real.U, s = Math.max(0.06, cell.x * (0.6 + 0.4 * Math.min(1, Math.max(0, (cell.x - 0.3) / 0.4)))), b = Math.min(1, 1.1 * Math.pow(Math.min(1, cell.y), 1.25)) * 0.9, a = config.iconAlbedo;
    const c = i => a * (s * (U.uSunCol.value.getComponent(i) * config.sun + (U.uSkyCol.value.getComponent(i) + U.uGroundCol.value.getComponent(i)) * 0.5) + WARM[i] * b);
    o.material.color.setRGB(c(0), c(1), c(2));
  },
  stats: () => ({ lumps: made.lumps, icons: made.icons }),
};
})();
