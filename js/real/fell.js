// Blockfield 1.6, the realistic look: js/real/fell.js. Felled trees (docs/REALISTIC_CONTRACT.md section 4).
// Drawing only. Nothing here may run unless BF.real.on, and nothing here changes the game: the simulation fells a tree as 1.5 does
// (js/forester.js fallAbove / fell: the blocks above the cut go at once and drop their items).
//
// - The fall. This file sits in front of the flora placer (BF.real.flora.place / remove, after js/real/lod.js took them over) and
//   remembers every chunk's tree records. When a chunk is meshed again and a tree's record is gone while the blocks of its trunk
//   above the cut are gone too, the tree was felled: its own model (the registry entry, variant, size and turn the placer drew) is
//   cut at the height of the cut and tips over away from the player, lands along the ground, and breaks up in a burst of leaves.
// - The logs. The items the felled blocks dropped are hidden while the tree comes down (js/entityview.js asks hides(drop)), so the
//   logs, sticks and saplings appear where the tree lands. Only the drawing waits: the items are in the world from the start.
// - The stump. The logs below the cut stay in the world. The mesher lists such a leafless column of one to three logs as a record
//   of kind 5 (js/real/mesh.js) and leaves its cubes out; this file takes those records out of the list the placer gets and draws
//   each as the foot of its tree's trunk with a cut top.
//
// - Items on the ground. An item lying on natural ground is drawn on the smooth surface there, not on the block grid under or over
//   it (itemY, asked by js/entityview.js).
//
// API: BF.real.fell = { config, placer, hides(drop) -> bool, itemY(n, x, y, z, dt) -> y to draw at, surfaceY(x, y, z) -> y | null, stats() -> { falls, stumps, trees, felled }, _test }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
if (!BF.real || !BF.real.on) return;
if (typeof THREE === "undefined") return;
const real = BF.real, T = THREE;

const TREE = 0, BIG = 4, STUMP = 5;
const config = {
  range: 96,        // a tree felled further than this from the camera just goes
  max: 6,           // trees falling at once
  lean: 0.35,       // seconds of creak before it goes
  hold: 0.5,        // seconds it lies before it breaks up
  fade: 0.45,       // seconds of breaking up
  hideDrops: true,
  enabled: true,
};

const trees = new Map();    // chunk key -> Map("x,y,z" of the base -> record)
const grid = new Map();     // "cx,cz" (16-block cells) -> Set of records, for hides()
const stumps = new Map();   // chunk key -> Map(id -> stump object)
const known = new Map();    // "x,y,z" of a felled tree's base -> { def, variant, kind, scale }: its stump keeps its trunk
const falls = [];
let scene = null, inner = null, felled = 0;

// ---------------------------------------------------------------- the model of a record
function mulberry(a) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const own = new Map();   // registry entry -> variant -> parts built here (when the placer has not built that model's full level)
// The parts of a tree's full model as the placer draws it (js/real/lod.js: its geometry and the registry's materials), and the
// model's height: { parts: [{ geometry, material, foliage }], modelH } or null.
function modelParts(kind, def, variant) {
  const L = real.lod;
  let M = null;
  if (L && L.models) for (const m of L.models.values()) if (m.def === def && m.variant === variant && m.kind === kind) { M = m; break; }
  const modelH = (M && M.modelH) || def.modelHeight || (def.height ? (def.height[0] + def.height[1]) / 2 : 0);
  if (M && M.lods && M.lods[0]) return { parts: M.lods[0].parts.map(p => ({ geometry: p.geometry, material: p.src, foliage: p.foliage })), modelH: modelH || 1 };
  let v = own.get(def);
  if (!v) own.set(def, v = []);
  if (v[variant] === undefined) {
    v[variant] = null;
    try {
      const out = def.build(mulberry(M ? M.seed : (variant * 104729 + 17) | 0), 0), parts = [];
      const ok = g => g && g.isBufferGeometry && g.attributes.position && (g.index ? g.index.count : g.attributes.position.count) > 0;
      if (ok(out)) parts.push({ geometry: out, material: def.material ? def.material() : def.barkMaterial(), foliage: false });
      else if (out) {
        if (ok(out.bark)) parts.push({ geometry: out.bark, material: def.barkMaterial ? def.barkMaterial() : def.material(), foliage: false });
        if (ok(out.foliage)) parts.push({ geometry: out.foliage, material: def.foliageMaterial ? def.foliageMaterial() : def.material(), foliage: true });
      }
      if (parts.length) v[variant] = parts;
    } catch (e) { console.error("BF.real.fell: build failed for " + (def.id || "a tree"), e); }
  }
  if (!v[variant]) return null;
  let top = modelH;
  if (!top) for (const p of v[variant]) { if (!p.geometry.boundingBox) p.geometry.computeBoundingBox(); top = Math.max(top, p.geometry.boundingBox.max.y); }
  return { parts: v[variant], modelH: top || 1 };
}
// What draws a tree record, as the placer picks it (js/real/lod.js modelFor and scaleOf).
function lookOf(kind, block, biome, height, seed) {
  const f = real.flora, def = f && f.resolve ? f.resolve(block, biome, height, (seed * 7.13) % 1) : null;
  if (!def) return null;
  const variant = Math.floor(seed * 9973) % Math.max(1, def.variants | 0), m = modelParts(kind, def, variant);
  if (!m) return null;
  const C = (real.lod && real.lod.config) || {}, crown = C.crown != null ? C.crown : 2.5, big = C.big != null ? C.big : 1.5;
  return { def, variant, kind, scale: (height + crown) / m.modelH * (0.92 + 0.16 * ((seed * 13.7) % 1)) * (kind === BIG ? big : 1) };
}
// A plant's light as its instance colour (js/real/lod.js tintOf).
function tintOf(extra, seed, out) {
  const sky = ((extra | 0) & 15) / 15, bl = (((extra | 0) >> 4) & 15) / 15;
  const s = Math.max(0.06, sky * (0.6 + 0.4 * Math.min(1, Math.max(0, (sky - 0.3) / 0.4))));
  const b = Math.min(1, 1.1 * Math.pow(bl, 1.25)) * 0.9, v = 0.9 + 0.2 * ((seed * 5.3) % 1), w = 0.94 + 0.12 * ((seed * 9.1) % 1);
  out[0] = (s + b) * v; out[1] = (s + b * 0.72) * v * w; out[2] = (s + b * 0.42) * v;
  return out;
}

// ---------------------------------------------------------------- cutting a model
// A copy of geometry g cut level at height y (model units): the part above it (above = true) or below. Triangles wholly on the
// other side go, the ones across the cut are pulled onto it. ring (bark only): where the trunk crosses the cut, { x, z, r }.
function cutGeo(g, y, above, ring) {
  const out = g.clone(), p = out.attributes.position.array, n = p.length / 3;
  const src = g.index ? g.index.array : null, tris = (src ? src.length : n) / 3, keep = [];
  for (let t = 0; t < tris; t++) {
    const a = src ? src[t * 3] : t * 3, b = src ? src[t * 3 + 1] : t * 3 + 1, c = src ? src[t * 3 + 2] : t * 3 + 2;
    const ya = p[a * 3 + 1], yb = p[b * 3 + 1], yc = p[c * 3 + 1];
    if (above ? Math.max(ya, yb, yc) <= y : Math.min(ya, yb, yc) >= y) continue;
    keep.push(a, b, c);
  }
  if (ring) {
    // the trunk at the cut: the vertices near that height and near the model's axis
    let sx = 0, sz = 0, k = 0, band = ring.band, reach = ring.reach;
    for (let pass = 0; pass < 2 && !k; pass++, band *= 3) for (let i = 0; i < n; i++) {
      if (Math.abs(p[i * 3 + 1] - y) > band || Math.hypot(p[i * 3], p[i * 3 + 2]) > reach) continue;
      sx += p[i * 3]; sz += p[i * 3 + 2]; k++;
    }
    ring.x = k ? sx / k : 0; ring.z = k ? sz / k : 0;
    let sr = 0;
    if (k) for (let i = 0; i < n; i++) {
      if (Math.abs(p[i * 3 + 1] - y) > band / (band > ring.band ? 3 : 1) || Math.hypot(p[i * 3], p[i * 3 + 2]) > reach) continue;
      sr += Math.hypot(p[i * 3] - ring.x, p[i * 3 + 2] - ring.z);
    }
    ring.r = k ? sr / k : 0;
  }
  for (let i = 0; i < n; i++) { const v = p[i * 3 + 1]; if (above ? v < y : v > y) p[i * 3 + 1] = y; }
  out.setIndex(keep);
  out.boundingSphere = null; out.boundingBox = null;
  return out;
}
// The cut face: pale wood with rings, one texture for all.
let capTex = null, capGeo = null;
function capMesh(light) {
  if (!capTex) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"), rnd = mulberry(7);
    g.fillStyle = "#b08a5a"; g.fillRect(0, 0, 128, 128);
    for (let r = 62; r > 2; r -= 3 + rnd() * 3) {
      g.beginPath(); g.arc(64 + (rnd() - 0.5) * 2, 64 + (rnd() - 0.5) * 2, r, 0, Math.PI * 2);
      g.strokeStyle = rnd() < 0.5 ? "#8f6c41" : "#c39d6a"; g.lineWidth = 1 + rnd() * 1.5; g.stroke();
    }
    g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.strokeStyle = "#5d4630"; g.lineWidth = 5; g.stroke();
    capTex = new T.CanvasTexture(c); capTex.encoding = T.sRGBEncoding;
    capGeo = new T.CircleGeometry(1, 16); capGeo.rotateX(-Math.PI / 2);
  }
  const mat = real.lit(new T.MeshStandardMaterial({ map: capTex, color: 0x9a9a9a, roughness: 0.9, metalness: 0, side: T.DoubleSide }), { light: "cell" });
  mat.userData.cell.value.set(light[0], light[1]);
  const m = new T.Mesh(capGeo, mat);
  m.frustumCulled = false; m.receiveShadow = true;
  return m;
}
const M4 = new T.Matrix4(), Q = new T.Quaternion(), V = new T.Vector3(), S = new T.Vector3(), YA = new T.Vector3(0, 1, 0), tint = [1, 1, 1];
// One part of one tree as an InstancedMesh of one (the registry's materials are made for instances: the light is the instance colour).
function partMesh(geometry, material, m4, extra, seed, foliage) {
  const m = new T.InstancedMesh(geometry, material, 1);
  m.setMatrixAt(0, m4);
  tintOf(extra, seed, tint);
  m.instanceColor = new T.InstancedBufferAttribute(new Float32Array(tint), 3);
  m.frustumCulled = false;
  m.castShadow = !!(real.quality && real.quality.shadows); m.receiveShadow = !foliage;
  return m;
}
function dispose(root) {
  if (scene) scene.remove(root);
  for (const c of root.children) {
    if (c.userData.ownGeo) c.geometry.dispose();
    if (c.userData.ownMat) c.material.dispose();
    if (c.isInstancedMesh) c.dispose();
  }
}
const lightOf = extra => [((extra | 0) & 15) / 15, (((extra | 0) >> 4) & 15) / 15];
// The trunk of look L cut at `cut` blocks above its base, as a group at the origin: the tree above the cut (with its crown) or the
// stump below it, with the cut face. The group's origin is the middle of the cut for the tree, the base for the stump.
function build(L, rec, cut, above) {
  const m = modelParts(L.kind, L.def, L.variant);
  if (!m) return null;
  const root = new T.Group(), s = L.scale, rot = rec.seed * 6.2831853, yl = cut / s;
  M4.compose(V.set(0, above ? -cut : 0, 0), Q.setFromAxisAngle(YA, rot), S.set(s, s, s));
  const ring = { band: 0.7 / s, reach: 1.6 / s, x: 0, z: 0, r: 0 };
  let bark = false;
  for (const p of m.parts) {
    if (p.foliage && !above) continue;
    let g = p.geometry, mine = false;
    if (!p.foliage && (cut > 0 || !above)) { g = cutGeo(g, yl, above, bark ? null : ring); mine = true; bark = true; }
    if (!(g.index ? g.index.count : g.attributes.position.count)) { if (mine) g.dispose(); continue; }
    const mesh = partMesh(g, p.material, M4, rec.extra, rec.seed, p.foliage);
    mesh.userData.ownGeo = mine;
    root.add(mesh);
  }
  if (!root.children.length) return null;
  if (bark && ring.r > 0) {
    const cap = capMesh(lightOf(rec.extra)), r = Math.min(1.4, Math.max(0.12, ring.r * s * 1.02));
    V.set(ring.x * s, 0, ring.z * s).applyAxisAngle(YA, rot);
    cap.position.set(V.x, above ? -0.004 : cut + 0.004, V.z);
    cap.scale.set(r, 1, r);
    cap.userData.ownMat = true;
    root.add(cap);
    root.userData.radius = r;
  }
  return root;
}

// ---------------------------------------------------------------- the fall
const W = () => BF.world;
const blockAt = (x, y, z) => { try { return W().getBlock(x, y, z); } catch (_) { return 0; } };
// The trunk's columns of a record: one, or the four of a 2 x 2 trunk (its x and z are the middle).
function columns(rec) {
  const x = Math.floor(rec.x), z = Math.floor(rec.z);
  return rec.kind === BIG ? [[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]] : [[x, z]];
}
// A tree whose record went: how many logs are left at its foot (the stump), or -1 when the tree was not felled (logs still up
// there: it only lost its leaves, or the part above the cut is held up by something).
function cutHeight(rec) {
  const w = W(), cols = columns(rec);
  if (!w || !w.isLoaded || !w.isLoaded(cols[0][0], cols[0][1])) return -1;
  let cut = 0;
  for (const [x, z] of cols) { let k = 0; while (k < rec.height && blockAt(x, rec.y + k, z) === rec.block) k++; if (k > cut) cut = k; }
  if (cut >= rec.height) return -1;
  for (const [x, z] of cols) for (let y = rec.y + cut + 1; y < rec.y + rec.height; y++) if (blockAt(x, y, z) === rec.block) return -1;
  return cut;
}
// The ground's height near (x, z): the top of the first solid block under y + 8 that is not part of a tree.
function groundAt(x, y, z) {
  const SOLID = BF.SOLID, bx = Math.floor(x), bz = Math.floor(z);
  for (let yy = Math.floor(y) + 8; yy > y - 16; yy--) {
    const id = blockAt(bx, yy, bz), b = id ? BF.blocks[id] : null;
    if (id && SOLID && SOLID[id] && b && !/_(log|leaves)$/.test(b.name)) return yy + 1;
  }
  return y;
}
function startFall(rec, cut) {
  if (!config.enabled || !scene || falls.length >= config.max) return false;
  const cam = (BF.player && BF.player.position) || (real.camera && real.camera.position);
  const dx = rec.x - (cam ? cam.x : rec.x), dz = rec.z - (cam ? cam.z : rec.z), dist = Math.hypot(dx, dz);
  if (dist > config.range) return false;
  const L = lookOf(rec.kind, rec.block, rec.biome, rec.height, rec.seed);
  if (!L) return false;
  known.set(rec.x + "," + rec.y + "," + rec.z, L);
  if (known.size > 400) known.delete(known.keys().next().value);
  const root = build(L, rec, cut, true);
  if (!root) return false;
  // away from whoever stands at it (the player, when near); otherwise a direction of its own
  let ax, az;
  if (dist > 0.3 && dist < 12) { const a = Math.atan2(dz, dx) + (((rec.seed * 31.7) % 1) - 0.5) * 0.7; ax = Math.cos(a); az = Math.sin(a); }
  else { const a = rec.seed * 97.3; ax = Math.cos(a); az = Math.sin(a); }
  const py = rec.y + cut, len = rec.height + 2.5 - cut, d = Math.min(len * 0.7, 12);
  // it comes to rest along the ground: on its trunk where the crown is small, propped up a little by a wide crown
  const gy = groundAt(rec.x + ax * d, py, rec.z + az * d) + (root.userData.radius || 0.3) + 0.08 * len;
  const end = Math.PI / 2 + Math.max(-0.45, Math.min(0.5, Math.atan2(py - gy, d)));
  root.position.set(rec.x, py, rec.z);
  scene.add(root);
  const time = Math.min(2.6, 1.25 + 0.07 * len);
  falls.push({ root, rec, cut, t: 0, age: 0, ids: new Set(), time, end, axis: new T.Vector3(az, 0, -ax), ax, az, len, landed: false, y1: rec.y + rec.height + 4 });
  felled++;
  return true;
}
function sound(name, f, o) {
  const A = BF.audio;
  if (!A || !A.play) return;
  try { A.play(name, Object.assign({ x: f.rec.x + f.ax * f.len * 0.4, y: f.rec.y + 1, z: f.rec.z + f.az * f.len * 0.4 }, o)); } catch (_) { /* optional */ }
}
function burst(f) {
  const P = BF.player;
  if (!P || !P.spawnParticles) return;
  const name = (BF.blocks[f.rec.block] || {}).name || "", leaves = BF.B[name.replace(/_log$/, "_leaves")];
  const c = Math.cos(f.end), s = Math.sin(f.end);
  try {
    for (let i = 1; i <= 8; i++) {
      const u = i / 8 * f.len, x = f.rec.x + f.ax * u * s - 0.5, y = f.rec.y + f.cut + u * c, z = f.rec.z + f.az * u * s - 0.5;
      if (i >= 4 && leaves != null) P.spawnParticles(x, y + 0.4, z, leaves, 7);
      else P.spawnParticles(x, y, z, f.rec.block, 3);
    }
  } catch (_) { /* optional */ }
}
function frame(dt) {
  for (let i = falls.length - 1; i >= 0; i--) {
    const f = falls[i];
    f.t += dt;
    const u = (f.t - config.lean) / f.time;
    let a;
    if (u < 0) a = 0.02 * (f.t / config.lean) * (1 + 0.35 * Math.sin(f.t * 40));          // the creak
    else if (u < 1) a = 0.02 + (f.end - 0.02) * Math.pow(u, 2.4);                           // going
    else {
      if (!f.landed) { f.landed = true; sound("dig.wood", f, { pitch: 0.45, volume: 1 }); sound("dig.grass", f, { pitch: 0.6, volume: 0.9 }); }
      const v = (f.t - config.lean - f.time) / 0.4;
      a = f.end - (v < 1 ? 0.07 * Math.sin(Math.PI * v) * (1 - v) : 0);                     // one small bounce
      const k = (f.t - config.lean - f.time - config.hold) / config.fade;
      if (k > 0 && !f.burst) { f.burst = true; burst(f); }
      if (k >= 1) { dispose(f.root); falls.splice(i, 1); continue; }
      if (k > 0) { const w = 1 - k * k; f.root.scale.set(w, 1 - 0.3 * k, w); }             // breaking up: it thins away along its length
    }
    f.root.quaternion.setFromAxisAngle(f.axis, a);
  }
}

// An item drop (the client's mirror entity: x, y, z, age) that came off a tree still coming down: not drawn until it lands.
function hides(d) {
  if (!config.hideDrops || !d) return false;
  const age = d.age || 0;
  for (const f of falls) {
    if (f.landed) continue;
    if (f.ids.has(d.n)) return true;
    // its items: the young ones around it as it starts to go
    if (f.age < 1 && age < 1.5 && Math.abs(d.x - f.rec.x) < 6 && Math.abs(d.z - f.rec.z) < 6 && d.y > f.rec.y - 3 && d.y < f.y1) { f.ids.add(d.n); return true; }
  }
  // an item this young next to a tree may be the first of a tree just cut: the chunk's new mesh (which starts the fall) is a moment away
  if (age < 0.35) {
    const cx = Math.floor(d.x / 16), cz = Math.floor(d.z / 16);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const set = grid.get((cx + i) + "," + (cz + j));
      if (set) for (const r of set) if (Math.abs(d.x - r.x) < 4 && Math.abs(d.z - r.z) < 4 && d.y >= r.y && d.y < r.y + r.height + 4) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- items on the smooth ground
// The game rests an item on the block grid, and the smooth ground is drawn up to half a block above or below a block's top (a
// slope, the foot of a bank, a dug pit), so an item lying there was drawn buried in the ground or floating over it. itemY gives
// the height to draw it at: on the drawn surface while it lies on natural ground, its own height otherwise, eased between the two.
let NAT = null;
const lift = new Map();   // drop number -> { x, y, z (where it was asked), to (the offset wanted), off (the offset drawn), seen }
let liftFrame = 0, frameDt = 0.016;
// The drawn ground's height at (x, z) nearest to y (within a block and a half), or null where no smooth ground is drawn there.
function surfaceY(x, y, z) {
  const w = W(), c = w && w.chunkAt ? w.chunkAt(x, z) : null;
  if (!c || !c.meshes) return null;
  let best = null, bd = 1.5;
  for (const m of c.meshes) {
    const g = m.geometry;
    if (!g || !g.attributes.mat || !g.index) continue;
    const p = g.attributes.position.array, ix = g.index.array, lx = x - m.position.x, lz = z - m.position.z;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, cc = ix[t + 2] * 3;
      const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[cc], cz = p[cc + 2];
      if ((lx < ax && lx < bx && lx < cx) || (lx > ax && lx > bx && lx > cx) || (lz < az && lz < bz && lz < cz) || (lz > az && lz > bz && lz > cz)) continue;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const u = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / det, v = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / det, q = 1 - u - v;
      if (u < -1e-4 || v < -1e-4 || q < -1e-4) continue;
      const sy = u * p[a + 1] + v * p[b + 1] + q * p[cc + 1], d = Math.abs(sy - y);
      if (d < bd) { bd = d; best = sy; }
    }
  }
  return best;
}
function itemY(n, x, y, z, dt) {
  let e = lift.get(n);
  if (!e) lift.set(n, e = { x: NaN, y: NaN, z: NaN, to: 0, off: 0, seen: 0 });
  e.seen = liftFrame;
  if (!(Math.abs(x - e.x) <= 0.02 && Math.abs(y - e.y) <= 0.02 && Math.abs(z - e.z) <= 0.02)) {   // (moved, or new)
    e.x = x; e.y = y; e.z = z; e.to = 0;
    if (!NAT && real.meshTables) NAT = real.meshTables().NAT;
    // lying on natural ground (its feet on a block's top, that block drawn smooth)
    if (NAT && Math.abs(y - Math.round(y)) < 0.02 && NAT[blockAt(Math.floor(x), Math.round(y) - 1, Math.floor(z))]) {
      const sy = surfaceY(x, y, z);
      if (sy != null) e.to = sy - y;
    }
  }
  e.off += (e.to - e.off) * Math.min(1, (dt || frameDt) * 12);   // (eased over about a fifth of a second, whatever the frame rate)
  return y + e.off;
}
function pruneLift() {
  liftFrame++;
  if (liftFrame % 120 === 0) for (const [n, e] of lift) if (liftFrame - e.seen > 120) lift.delete(n);
}

// ---------------------------------------------------------------- stumps
function stumpObject(rec) {
  const big = rec.x % 1 === 0, kind = big ? BIG : TREE;
  // the trunk of the tree that stood here when it was seen falling; otherwise a tree of its kind as tall as they come
  let L = known.get(rec.x + "," + rec.y + "," + rec.z);
  if (!L) L = lookOf(kind, rec.block, rec.biome, big ? 20 : 6, rec.seed);
  if (!L) return null;
  const root = build(L, rec, rec.height, false);
  if (!root) return null;
  root.position.set(rec.x, rec.y, rec.z);
  scene.add(root);
  return root;
}
function setStumps(key, list) {
  const had = stumps.get(key);
  if (!list.length && !had) return;
  const now = new Map();
  for (const rec of list) {
    const id = rec.x + "," + rec.y + "," + rec.z + "," + rec.height + "," + rec.extra;
    let o = had && had.get(id);
    if (o) had.delete(id); else o = scene ? stumpObject(rec) : null;
    if (o) now.set(id, o);
  }
  if (had) for (const o of had.values()) dispose(o);
  if (now.size) stumps.set(key, now); else stumps.delete(key);
}

// ---------------------------------------------------------------- in front of the placer
const cellOf = r => Math.floor(r.x / 16) + "," + Math.floor(r.z / 16);
function forget(key) {
  const m = trees.get(key);
  if (!m) return;
  for (const r of m.values()) { const s = grid.get(cellOf(r)); if (s) { s.delete(r); if (!s.size) grid.delete(cellOf(r)); } }
  trees.delete(key);
}
function place(key, ox, oz, F) {
  const n = F ? Math.floor(F.length / 8) : 0, now = new Map(), st = [];
  let biome = "", keep = 0;
  try { const b = BF.worldgen && BF.worldgen.biomeAt && BF.worldgen.biomeAt(ox + 8, oz + 8); biome = typeof b === "string" ? b : (b && b.name) || ""; } catch (_) { /* no world yet */ }
  for (let i = 0; i < n; i++) {
    const o = i * 8, kind = F[o + 3] | 0;
    const rec = { x: ox + F[o], y: F[o + 1], z: oz + F[o + 2], kind, block: F[o + 4] | 0, height: F[o + 5], seed: F[o + 6], extra: F[o + 7], biome };
    if (kind === STUMP) st.push(rec);
    else { keep++; if (kind === TREE || kind === BIG) now.set(rec.x + "," + rec.y + "," + rec.z, rec); }
  }
  const had = trees.get(key);
  if (had) {
    for (const [k, rec] of had) {
      if (now.has(k)) continue;
      let cut = -1;
      try { cut = cutHeight(rec); if (cut >= 0) startFall(rec, cut); } catch (e) { console.error("BF.real.fell", e); }
    }
    forget(key);
  }
  if (now.size) {
    trees.set(key, now);
    for (const r of now.values()) { const c = cellOf(r); let s = grid.get(c); if (!s) grid.set(c, s = new Set()); s.add(r); }
  }
  // the placer gets the list without the stumps
  let G = F;
  if (st.length) {
    G = keep ? new Float32Array(keep * 8) : null;
    for (let i = 0, q = 0; i < n && G; i++) { if ((F[i * 8 + 3] | 0) === STUMP) continue; G.set(F.subarray(i * 8, i * 8 + 8), q); q += 8; }
  }
  inner.place.call(real.flora, key, ox, oz, G);
  try { setStumps(key, st); } catch (e) { console.error("BF.real.fell", e); }
}
function remove(key) {
  forget(key);
  setStumps(key, []);
  inner.remove.call(real.flora, key);
}
// Stands in front of whatever placer is installed (again at init: js/real/lod.js installs itself there once more).
function wrap() {
  const f = real.flora;
  if (!f || f.place === place) return;
  inner = { place: f.place, remove: f.remove };
  f.place = place; f.remove = remove;
}
wrap();

real.fell = {
  config, hides, itemY, surfaceY,
  get placer() { return inner; },   // the placer behind this one (js/real/lod.js)
  stats() { let s = 0, t = 0; for (const m of stumps.values()) s += m.size; for (const m of trees.values()) t += m.size; return { falls: falls.length, stumps: s, trees: t, felled }; },
  _test: { falls, stumps, trees, cutGeo, cutHeight },
};
real.module({
  name: "fell",
  init(ctx) { scene = ctx.scene; wrap(); },
  frame(dt) { frameDt = dt; pruneLift(); if (falls.length) { for (const f of falls) f.age += dt; frame(Math.min(dt, 0.1)); } },
});
})();
