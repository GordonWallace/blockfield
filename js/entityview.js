// Entity drawing (spec r15-12): the render layer for everything in the world that isn't a mob or a block, after r15-11's js/mobview.js.
// Since r15-37 it draws from the client's mirror (BF.client.world.entities, js/protocol.js), never from the simulation:
//   item drops   kind "drop":  x, y, z, age, item, count, phase (the bob), pulled (flying to the player)
//   arrows       kind "arrow": x, y, z, lx, ly, lz (the way it points: its flight, or as it flew in when stuck), stuck
//   boats        kind "boat":  x, y, z, yaw, hurtT, wood, row / rowing (the paddles), mob (its passenger), rider (the player's own)
//   bees         kind "bee":   x, y, z, yaw, phase, mode, land ([x, y, z, nx, ny, nz]: where it sits and the surface's normal), landYaw
//   leads        a horse's "lead" field: "player", the number of the mob holding it, or the fence post [x, y, z]
//   effects      puff, heart, crumbs and dust entries of the protocol's events messages (js/fx.js events), played here
// Once per drawn frame render() builds, updates and removes the scene objects from that data: one gone from the mirror loses its object
// on the next frame. Drops, arrows, boats and bees are drawn between where the last two ticks left them (spec r15-10: lerp(prev, cur, k),
// k = BF.client.world.k(e, BF.warp.alpha); off the page between prev and e.to at the drawing clock, bug-098), except one that jumped (a face edge) and the player's own boat (it moves in real time), drawn
// where they are. Effects move with the drawn game time (dt, 0 while frozen); paddles settle in real time.
// API: BF.entityView = { init(scene), render(dt, realDt), viewOf(entity | protocol number | sim object (tests)) -> its scene object | undefined, count() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const vrnd = (a, b) => a + Math.random() * (b - a);   // visual
let scene = null;
const skyLight = () => (BF.sky && typeof BF.sky.light === "number" ? BF.sky.light : 1);
const loadedAt = (x, z) => BF.world.isLoaded(x, z);

// ---------------------------------------------------------------- item drops: a sprite of the item's icon, bobbing
const loader = new THREE.TextureLoader(), dropMats = new Map(), dropViews = new Map();
function dropMat(id) {
  let m = dropMats.get(id);
  if (!m) {
    const tex = loader.load(BF.textures.icon(id));
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    m = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
    dropMats.set(id, m);
  }
  return m;
}
const alphaNow = () => { const W = BF.warp, a = W && W.alpha != null ? W.alpha : 1; return Math.max(0, Math.min(1, a)); };
let M = null;   // the client's mirror (BF.client.world) this frame
const ent = n => (n != null && M ? M.entities.get(n) : null);
const d2 = (q, p) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
// entities of one kind in the mirror, in the order they came
function* ofKind(kind) { for (const e of M.entities.values()) if (e.kind === kind) yield e; }
function drawDrops(seen, a) {
  const light = BF.sky ? 0.35 + 0.65 * BF.sky.light : 1;
  for (const d of ofKind("drop")) {
    let sp = dropViews.get(d.n);
    if (!sp || sp.material !== dropMat(d.item)) {
      if (sp) scene.remove(sp);
      sp = new THREE.Sprite(dropMat(d.item));
      sp.scale.set(0.38, 0.38, 0.38);
      scene.add(sp);
      dropViews.set(d.n, sp);
    }
    seen.add(d.n);
    sp.visible = loadedAt(d.x, d.z);
    const k = M.k(d, a), j = 1 - k, q = d.prev || d, p = k < 1 && d.to || d, snap = k >= 1 || d2(q, p) > 16;
    const age = snap ? d.age : q.age * j + d.age * k, x = snap ? p.x : q.x * j + p.x * k, z = snap ? p.z : q.z * j + p.z * k;
    const y = snap ? p.y : q.y * j + p.y * k;
    sp.position.set(x, d.pulled ? y : y + 0.22 + Math.sin(age * 2.5 + d.phase) * 0.06, z);   // one flying into the player doesn't bob
    sp.material.color.setScalar(light);
  }
}

// ---------------------------------------------------------------- arrows
let arrowGeo = null, arrowMat = null;
const arrowViews = new Map(), _look = new THREE.Vector3();
function drawArrows(seen, alpha) {
  if (!arrowGeo) {
    // the arrow points along +Z (Object3D.lookAt aims +Z at the target)
    const V = BF.mobView, box = V.box;
    arrowGeo = V.buildGeometry([
      box([-0.5, -0.5, -4], [0.5, 0.5, 3], 0x8a6a40),
      box([-0.75, -0.75, 3], [0.75, 0.75, 4.5], 0x9a9a9a),
      box([-1.5, -0.25, -4.5], [1.5, 0.25, -2.5], 0xf0f0f0),
      box([-0.25, -1.5, -4.5], [0.25, 1.5, -2.5], 0xf0f0f0),
    ], 11);
    arrowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  }
  arrowMat.color.setScalar(Math.max(0.15, skyLight()));
  for (const r of ofKind("arrow")) {
    let mesh = arrowViews.get(r.n);
    if (!mesh) { mesh = new THREE.Mesh(arrowGeo, arrowMat); scene.add(mesh); arrowViews.set(r.n, mesh); }
    seen.add(r.n);
    const k = M.k(r, alpha), q = r.prev, t = r.to || r;   // (to: off the page, the state after the drawing clock's)
    if (r.stuck || k >= 1 || d2(q, t) > 64) mesh.position.set(r.x, r.y, r.z);
    else mesh.position.set(q.x + (t.x - q.x) * k, q.y + (t.y - q.y) * k, q.z + (t.z - q.z) * k);
    if (r.lx || r.ly || r.lz) { _look.copy(mesh.position); _look.x += r.lx; _look.y += r.ly; _look.z += r.lz; mesh.lookAt(_look); }   // along its flight; a stuck one as it flew in
  }
}

// ---------------------------------------------------------------- boats: hull and two paddles, in the wood's planks
// Boxes in 1/16 block, drawn facing north (bow at -z). Faces are shaded like mobs; UVs take a slice of the wood's planks tile.
const HULL = [
  [-10, 0, -14, 10, 3, 14],    // bottom
  [-12, 0, -14, -10, 9, 14],   // left side
  [10, 0, -14, 12, 9, 14],     // right side
  [-12, 0, -16, 12, 9, -14],   // bow
  [-12, 0, 14, 12, 9, 16],     // stern
  [-10, 3, 3, -10 + 20, 5, 7], // seat
];
const PADDLE = [[-0.5, -12, -0.5, 0.5, 6, 0.5], [-0.5, -13, -2.5, 0.5, -6, 2.5]];   // shaft, blade (pivot at the oarlock)
const SHADE = [0.8, 0.8, 1, 0.55, 0.68, 0.68];   // BoxGeometry face order: +x -x +y -y +z -z
const planksTile = wood => (wood === "oak" ? "planks" : wood + "_planks");
function boxesGeometry(boxes, r) {
  const P = [], U = [], C = [], I = [];
  for (const b of boxes) {
    const w = b[3] - b[0], h = b[4] - b[1], d = b[5] - b[2];
    const g = new THREE.BoxGeometry(w / 16, h / 16, d / 16);
    g.translate((b[0] + b[3]) / 32, (b[1] + b[4]) / 32, (b[2] + b[5]) / 32);
    const gp = g.attributes.position, gu = g.attributes.uv, gi = g.index;
    const v0 = P.length / 3;
    for (let i = 0; i < gp.count; i++) {
      const f = Math.floor(i / 4), fw = f < 2 ? d : w, fh = f === 2 || f === 3 ? d : h;   // the face's size in pixels
      const su = Math.min(1, fw / 16), sv = Math.min(1, fh / 16);
      P.push(gp.getX(i), gp.getY(i), gp.getZ(i));
      U.push(r[0] + (r[2] - r[0]) * gu.getX(i) * su, r[1] + (r[3] - r[1]) * gu.getY(i) * sv);
      C.push(SHADE[f], SHADE[f], SHADE[f]);
    }
    for (let k = 0; k < gi.count; k++) I.push(gi.getX(k) + v0);
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  return g;
}
const boatGeos = new Map(), boatViews = new Map();
function boatGeo(wood) {
  let g = boatGeos.get(wood);
  if (!g) {
    const r = BF.textures.uv(planksTile(wood)), rs = BF.textures.uv(wood + "_log");
    g = { hull: boxesGeometry(HULL, r), paddle: boxesGeometry(PADDLE, BF.textures.has && BF.textures.has(wood + "_log") ? rs : r) };
    boatGeos.set(wood, g);
  }
  return g;
}
function buildBoat(b) {
  const g = boatGeo(b.wood);
  const mat = new THREE.MeshBasicMaterial({ map: (BF.world.solidMat && BF.world.solidMat.map) || null, vertexColors: true, alphaTest: 0.5 });
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  body.add(new THREE.Mesh(g.hull, mat));
  const paddles = [-1, 1].map(side => {
    const p = new THREE.Group();
    p.position.set(side * 11.5 / 16, 8 / 16, -1 / 16);
    p.rotation.order = "YXZ";
    p.add(new THREE.Mesh(g.paddle, mat));
    body.add(p);
    return p;
  });
  scene.add(root);
  return { root, body, paddles, mat };
}
function boatLight(p) {
  const sky = BF.sky ? 0.35 + 0.65 * BF.sky.light : 1;
  let bl = 0;
  try { bl = BF.world.getBlockLight(p.x, p.y + 0.5, p.z) / 15; } catch (_) {}
  return Math.max(0.12, sky, Math.pow(bl, 1.5));
}
function drawBoats(seen, realDt, alpha) {
  const ease = 1 - Math.pow(0.8, Math.min(0.25, realDt) * 60);   // a resting paddle settles along the hull
  for (const b of ofKind("boat")) {
    let v = boatViews.get(b.n);
    if (!v) { v = buildBoat(b); boatViews.set(b.n, v); }
    seen.add(b.n);
    v.root.visible = loadedAt(b.x, b.z);
    const k = M.k(b, alpha), q = b.prev, t = b.to || b;
    if (b.rider || k >= 1 || d2(q, t) > 16) { v.root.position.set(b.x, b.y, b.z); v.root.rotation.y = b.yaw; }
    else {
      v.root.position.set(q.x + (t.x - q.x) * k, q.y + (t.y - q.y) * k, q.z + (t.z - q.z) * k);
      const d = t.yaw - q.yaw;
      v.root.rotation.y = q.yaw + Math.atan2(Math.sin(d), Math.cos(d)) * k;
    }
    v.body.rotation.z = b.hurtT > 0 ? Math.sin(b.hurtT * 30) * b.hurtT * 0.6 : 0;
    // paddles: an active one sweeps fore and aft and dips; a resting one lies along the hull
    for (let i = 0; i < 2; i++) {
      const p = v.paddles[i], side = i === 0 ? -1 : 1, ph = b.row[i];
      if (b.rowing[i]) { p.rotation.x = Math.sin(ph) * 0.75; p.rotation.z = side * (0.75 + 0.25 * Math.cos(ph)); }
      else { p.rotation.x += (1.1 - p.rotation.x) * ease; p.rotation.z += (side * 1.25 - p.rotation.z) * ease; }
    }
    v.mat.color.setScalar(boatLight(b));
  }
}

// ---------------------------------------------------------------- bees: one instanced mesh, wings flickering in the vertex shader
let beeMesh = null;
const BEE_CAP = BF.bees ? BF.bees.CAP : 512;   // bees drawn at most (a constant of js/bees.js)
function beeGeometry() {
  const pos = [], col = [], wing = [];
  const box = (x0, y0, z0, x1, y1, z1, c, wg) => {
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const F = [[0, 3, 2, 1, 0.7], [4, 5, 6, 7, 0.8], [0, 4, 7, 3, 0.75], [1, 2, 6, 5, 0.75], [3, 7, 6, 2, 1], [0, 1, 5, 4, 0.5]];
    for (const [a, b, cc, d, sh] of F) for (const i of [a, b, cc, a, cc, d]) { pos.push(...P[i]); col.push(c[0] * sh, c[1] * sh, c[2] * sh); wing.push(wg); }
  };
  const Y = [0.98, 0.78, 0.1], K = [0.1, 0.08, 0.06], Wg = [0.86, 0.92, 0.98];
  const L = BF.bees.BODY, w = 0.045, hgt = 0.045;   // (the bee's size: a constant of js/bees.js)
  const segs = [[-0.5, -0.38, K], [-0.38, -0.24, Y], [-0.24, -0.12, K], [-0.12, 0.04, Y], [0.04, 0.22, [0.25, 0.18, 0.08]], [0.22, 0.5, K]];
  for (const [a, b, c] of segs) { const s = a > 0.2 ? 0.8 : 1; box(-w * s, -hgt * s, a * L, w * s, hgt * s, b * L, c, 0); }
  box(0.01, hgt, -0.04, 0.11, hgt + 0.006, 0.04, Wg, 1);      // right wing (hinged at x = 0, y = hgt)
  box(-0.11, hgt, -0.04, -0.01, hgt + 0.006, 0.04, Wg, -1);   // left wing
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("wing", new THREE.Float32BufferAttribute(wing, 1));
  return g;
}
const uTime = { value: 0 };
function initBees() {
  if (beeMesh || !BF.bees || !THREE.InstancedMesh) return;
  const CAP = BEE_CAP, g = beeGeometry(), mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  g.setAttribute("bee", new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2));   // per bee: wing phase, flapping (1) or folded (0)
  mat.onBeforeCompile = sh => {
    sh.uniforms.uBeeTime = uTime;
    sh.vertexShader = "attribute float wing;\nattribute vec2 bee;\nuniform float uBeeTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      if (wing != 0.0) {
        float a = wing * mix(-0.15, 0.25 + 0.75 * abs(sin(uBeeTime * 70.0 + bee.x)), bee.y);
        vec2 r = vec2(transformed.x, transformed.y - ${(0.045).toFixed(3)});
        transformed.x = r.x * cos(a) - r.y * sin(a);
        transformed.y = r.x * sin(a) + r.y * cos(a) + ${(0.045).toFixed(3)};
      }`);
  };
  beeMesh = new THREE.InstancedMesh(g, mat, CAP);
  beeMesh.count = 0; beeMesh.frustumCulled = false; beeMesh.name = "bees";
  beeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  beeMesh.onBeforeRender = drawBees;   // after view.begin has moved the mesh for this frame
  scene.add(beeMesh);
  // floating origin (js/view.js): instance positions are stored relative to the mesh, which sits on a coarse grid near the player
  if (BF.view) BF.view.onBegin(() => {
    const p = BF.player && BF.player.position;
    if (!p) return;
    const rx = Math.floor(p.x / 256) * 256, rz = Math.floor(p.z / 256) * 256;
    if (rx !== beeMesh.position.x || rz !== beeMesh.position.z) beeMesh.position.set(rx, 0, rz);
  });
}
const _m = new THREE.Matrix4(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
const DQ = {}, DV = [0, 0], BP = { x: 0, y: 0, z: 0 }, LS = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
const beeList = [];
function drawBees() {
  if (!M) return;
  const mesh = beeMesh, Wp = BF.warp, a = alphaNow();
  beeList.length = 0;
  for (const b of ofKind("bee")) { if (beeList.length >= BEE_CAP) break; beeList.push(b); }
  const bees = beeList;
  uTime.value = Wp && Wp.renderNow ? Wp.renderNow() : BF.simNow ? BF.simNow() : 0;
  const light = BF.sky && typeof BF.sky.light === "number" ? Math.max(0.3, Math.min(1, BF.sky.light)) : 1;
  mesh.material.color.setRGB(light, light, light);
  const n = bees.length, A = mesh.geometry.getAttribute("bee");
  for (let i = 0; i < n; i++) {
    const b = bees[i], L = b.mode === "land" && b.land ? b.land : null, s = L ? (LS.x = L[0], LS.y = L[1], LS.z = L[2], LS.nx = L[3], LS.ny = L[4], LS.nz = L[5], LS) : null;
    const k = M.k(b, a), j = 1 - k, pb = b.prev, t = b.to || b, lerp = k < 1 && d2(pb, t) < 16;   // (a jump: a face edge, a new frame)
    BP.x = lerp ? pb.x * j + t.x * k : b.x; BP.y = lerp ? pb.y * j + t.y * k : b.y; BP.z = lerp ? pb.z * j + t.z * k : b.z;
    // the planet: the bee seen from the mesh (in the player's frame), its directions turned with it
    const r = BF.planet.local(mesh.position, BP, DQ), bx = r.x, bz = r.z, q = r.turn;
    if (s) {   // landed: belly on the surface, back along its normal
      let nx = s.nx, nz = s.nz;
      if (q) { BF.planet.turnVec(q, nx, nz, DV); nx = DV[0]; nz = DV[1]; }
      _u.set(nx, s.ny, nz);
      if (s.ny > 0.5) _f.set(Math.sin(b.landYaw), 0, Math.cos(b.landYaw));
      else { const a = (b.landYaw % 1.2) - 0.6; _f.set(Math.sin(a) * nz, Math.cos(a), -Math.sin(a) * nx); }   // on a wall: head up, a little askew
      _r.crossVectors(_u, _f).normalize(); _f.crossVectors(_r, _u).normalize();
      _m.makeBasis(_r, _u, _f).setPosition(bx + nx * 0.045 - mesh.position.x, BP.y + s.ny * 0.045, bz + nz * 0.045 - mesh.position.z);
    } else {
      let yaw = lerp ? pb.yaw + Math.atan2(Math.sin(b.yaw - pb.yaw), Math.cos(b.yaw - pb.yaw)) * k : b.yaw;
      if (q) { BF.planet.turnVec(q, Math.sin(yaw), Math.cos(yaw), DV); yaw = Math.atan2(DV[0], DV[1]); }
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      _f.set(sn, 0, c); _u.set(0, 1, 0); _r.set(c, 0, -sn);
      _m.makeBasis(_r, _u, _f).setPosition(bx - mesh.position.x, BP.y, bz - mesh.position.z);
    }
    mesh.setMatrixAt(i, _m);
    A.setXY(i, b.phase, s ? 0 : 1);
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  A.needsUpdate = true;
}

// ---------------------------------------------------------------- horse leads: a sagging rope of 9 points
const leadViews = new Map();   // the horse's protocol number -> THREE.Line
let leadMat = null;
const leadA = new THREE.Vector3(), leadB = new THREE.Vector3();
function drawLeads() {
  const live = new Set(), V = BF.mobView, P = BF.player;
  for (const m of ofKind("mob")) {
    const lead = m.lead;
    if (lead == null) continue;
    const holder = typeof lead === "number" ? ent(lead) : null;
    if (typeof lead === "number" && !holder) continue;   // held by a mob the client doesn't have
    live.add(m.n);
    let line = leadViews.get(m.n);
    if (!line) {
      if (!leadMat) leadMat = new THREE.LineBasicMaterial({ color: 0x6b4a2a });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(9 * 3), 3));
      line = new THREE.Line(g, leadMat);
      line.frustumCulled = false;
      scene.add(line);
      leadViews.set(m.n, line);
    }
    const fw = [Math.sin(m.yaw), Math.cos(m.yaw)], s = m.k || 1;
    const mp = V.drawPos(m, leadA);   // where the horse is drawn (js/mobview.js)
    const a = [mp.x + fw[0] * 1.0 * s, mp.y + 1.45 * s, mp.z + fw[1] * 1.0 * s];
    let b;
    if (lead === "player") { const e = P.eyePos(), d = P.lookDir(); b = [e.x + d.x * 0.4 - d.z * 0.3, e.y - 0.5, e.z + d.z * 0.4 + d.x * 0.3]; }
    else if (holder) { const hp = V.drawPos(holder, leadB); b = [hp.x, hp.y + 1.0, hp.z]; }
    else b = [lead[0] + 0.5, lead[1] + 0.75, lead[2] + 0.5];
    const arr = line.geometry.attributes.position.array;
    const sag = Math.max(0, 1.2 - Math.hypot(a[0] - b[0], a[2] - b[2]) * 0.2);
    line.position.set(a[0], 0, a[2]);   // the rope's points are relative to the horse end (floating origin, js/view.js)
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      arr[i * 3] = (b[0] - a[0]) * t; arr[i * 3 + 1] = a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * sag; arr[i * 3 + 2] = (b[2] - a[2]) * t;
    }
    line.geometry.attributes.position.needsUpdate = true;
  }
  for (const [n, line] of leadViews) if (!live.has(n)) { scene.remove(line); leadViews.delete(n); }
}

// ---------------------------------------------------------------- effects (js/fx.js events)
// Each kind keeps its own list of live bits: {obj, life, vel...}. Crumbs and dust keep at most CAP bits (the oldest go first).
let puffGeo = null, puffMat = null, puffMatDark = null, heartTex = null;
const crumbGeo = {}, crumbMats = {};
const FX = { puff: [], heart: [], crumbs: [], dust: [] }, CAP = { crumbs: 120, dust: 90 };
function heartTexture() {
  if (heartTex) return heartTex;
  const rows = [".XX.XX.", "XWXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];
  const c = document.createElement("canvas"); c.width = 9; c.height = 8;
  const g = c.getContext("2d");
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < 7; x++) {
    const ch = rows[y][x];
    if (ch === ".") continue;
    g.fillStyle = "#3a0a10"; g.fillRect(x + 1, y + 1, 1, 1);   // drop shadow outline
  }
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < 7; x++) {
    const ch = rows[y][x];
    if (ch === ".") continue;
    g.fillStyle = ch === "W" ? "#ffb8c0" : y >= 3 ? "#c41e32" : "#ec3046";
    g.fillRect(x + 1, y, 1, 1);
  }
  heartTex = new THREE.CanvasTexture(c);
  heartTex.magFilter = THREE.NearestFilter; heartTex.minFilter = THREE.NearestFilter;
  return heartTex;
}
function bit(kind, size, color) {
  const L = FX[kind];
  if (L.length > CAP[kind]) { const o = L.shift(); scene.remove(o.obj); }
  const g = crumbGeo[size] || (crumbGeo[size] = new THREE.BoxGeometry(size, size, size));
  const mat = crumbMats[color] || (crumbMats[color] = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
  const mesh = new THREE.Mesh(g, mat);
  scene.add(mesh);
  return mesh;
}
const PLAY = {
  puff(e) {
    for (let i = 0; i < e.n; i++) {
      const mesh = new THREE.Mesh(puffGeo, e.dark ? puffMatDark : puffMat);
      mesh.position.set(e.x + vrnd(-e.spread, e.spread), e.y + vrnd(0, e.spread * 1.5), e.z + vrnd(-e.spread, e.spread));
      const s = vrnd(0.6, 1.4); mesh.scale.setScalar(s);
      scene.add(mesh);
      const v = new THREE.Vector3(vrnd(-1, 1), vrnd(0.2, 1.2), vrnd(-1, 1)).multiplyScalar(e.speed || 1);
      FX.puff.push({ obj: mesh, vel: v, life: vrnd(0.4, 0.8), s });
    }
  },
  heart(e) {
    const mat = new THREE.SpriteMaterial({ map: heartTexture(), transparent: true, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.34, 0.3, 1);
    sp.position.set(e.x + (Math.random() - 0.5) * 0.5, e.y + Math.random() * 0.2, e.z + (Math.random() - 0.5) * 0.5);   // visual
    scene.add(sp);
    FX.heart.push({ obj: sp, life: 1.4, vy: 0.55 + Math.random() * 0.3, dx: (Math.random() - 0.5) * 0.2 });   // visual
  },
  crumbs(e) {
    for (let i = 0; i < e.n; i++) {
      const mesh = bit("crumbs", 0.09, e.color || "#999999");
      mesh.position.set(e.x + (Math.random() - 0.5) * e.spread, e.y + Math.random() * 0.2, e.z + (Math.random() - 0.5) * e.spread);   // visual
      FX.crumbs.push({ obj: mesh, vx: (Math.random() - 0.5) * 1.6, vy: 0.8 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 1.6, life: 0.4 + Math.random() * 0.3 });   // visual
    }
  },
  dust(e) {
    const b = BF.blocks[e.block], color = (b && b.color) || "#999999";
    for (let i = 0; i < 5; i++) {
      const mesh = bit("dust", 0.11, color);
      mesh.position.set(e.x + 0.2 + Math.random() * 0.6, e.y + 0.3 + Math.random() * 0.5, e.z + 0.2 + Math.random() * 0.6);   // visual
      FX.dust.push({ obj: mesh, vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 2, vz: (Math.random() - 0.5) * 2, life: 0.45 + Math.random() * 0.3 });   // visual
    }
  },
};
function stepEffects(dt) {
  if (dt > 0) {
    for (let i = FX.puff.length - 1; i >= 0; i--) {
      const p = FX.puff[i];
      p.life -= dt;
      p.obj.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 2));
      p.obj.scale.setScalar(Math.max(0.01, p.s * Math.min(1, p.life * 2)));
      if (p.life <= 0) { scene.remove(p.obj); FX.puff.splice(i, 1); }
    }
    for (let i = FX.heart.length - 1; i >= 0; i--) {
      const h = FX.heart[i];
      h.life -= dt;
      h.obj.position.y += h.vy * dt; h.obj.position.x += h.dx * dt;
      h.obj.material.opacity = Math.max(0, Math.min(1, h.life / 0.5));
      if (h.life <= 0) { scene.remove(h.obj); h.obj.material.dispose(); FX.heart.splice(i, 1); }
    }
    for (const [kind, grav] of [["crumbs", 12], ["dust", 14]]) {
      const L = FX[kind];
      for (let i = L.length - 1; i >= 0; i--) {
        const p = L[i];
        p.life -= dt; p.vy -= grav * dt;
        p.obj.position.x += p.vx * dt; p.obj.position.y += p.vy * dt; p.obj.position.z += p.vz * dt;
        if (p.life <= 0) { scene.remove(p.obj); L.splice(i, 1); }
      }
    }
  }
  if (puffMat) { const l = Math.max(0.25, skyLight()); puffMat.color.setRGB(0.91 * l, 0.91 * l, 0.91 * l); }
}
function clearEffects() {
  for (const L of Object.values(FX)) { for (const p of L) { scene.remove(p.obj); if (p.obj.isSprite) p.obj.material.dispose(); } L.length = 0; }
}

// ---------------------------------------------------------------- the frame
const seen = new Set();
function prune(views) {
  for (const [e, o] of views) if (!seen.has(e)) { scene.remove(o.root || o); if (o.mat) o.mat.dispose(); views.delete(e); }
}
let failed = false, fxGen = 0;
// the effect entries of the protocol's events messages, played on the next frame (js/fx.js kinds; sounds go to js/audio.js)
let fxQ = [], listening = false;
function listen() {
  if (listening || !BF.proto || !BF.proto.listen) return;
  listening = true;
  BF.proto.listen(list => { for (const e of list) if (PLAY[e.kind]) fxQ.push(e); if (fxQ.length > 600) fxQ.splice(0, fxQ.length - 600); });
}
BF.entityView = {
  init(sceneRef) {
    scene = sceneRef;
    puffGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
    puffMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8, transparent: true, opacity: 0.85, depthWrite: false });
    puffMatDark = new THREE.MeshBasicMaterial({ color: 0x4a4a4a, transparent: true, opacity: 0.85, depthWrite: false });
  },
  // Once per drawn frame (js/main.js), after the simulation steps and the player: dt is the drawn game time this frame (seconds, 0
  // while frozen or paused), realDt the frame's real seconds.
  render(dt, realDt) {
    if (!scene) return;
    try {
      seen.clear();
      listen();
      M = BF.client && BF.client.world;
      if (!M) return;
      const k = alphaNow();
      drawDrops(seen, k);
      drawArrows(seen, k);
      drawBoats(seen, realDt || 0, k);
      prune(dropViews); prune(arrowViews); prune(boatViews);
      initBees();
      drawLeads();
      if (M.gen !== fxGen) { fxGen = M.gen; clearEffects(); fxQ = []; }   // a new world: what was playing goes
      const q = fxQ; fxQ = [];
      for (const e of q) PLAY[e.kind](e);
      stepEffects(dt);
    } catch (e) {
      if (!failed && BF.glog) BF.glog.log("ERROR", "entities", "Could not draw the world's entities: " + (e && e.message));   // once a session
      failed = true;
      console.error(e);
    }
  },
  viewOf(e) {
    const n = typeof e === "number" ? e : e && e.kind ? e.n : e && BF.proto ? BF.proto.numberOf(e) : null;
    return dropViews.get(n) || arrowViews.get(n) || (boatViews.get(n) && boatViews.get(n).root);
  },
  count() {
    let effects = 0;
    for (const L of Object.values(FX)) effects += L.length;
    return { drops: dropViews.size, arrows: arrowViews.size, boats: boatViews.size, leads: leadViews.size, bees: beeMesh ? beeMesh.count : 0, effects };
  },
};
})();
