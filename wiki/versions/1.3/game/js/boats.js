// Boats: one per wood (items "<wood>_boat", crafted from 5 planks of that wood in a U). Right click on water puts one down facing the
// way the player looks (on land it can be put down too but only slides slowly); right click on a boat gets in; W/S row, A/D turn,
// Shift gets out. Top speed about 8 blocks/s on open water and about 40 on ice, as in vanilla. Boats float on the water surface,
// drift with flowing water, fall down a river step going downstream but can't climb one going upstream (get out and push or carry it).
// A boat carries the player plus one mob: a mob (not an iron golem) that walks into a boat gets in; hitting the boat, or the player
// getting out with Shift, lets it out. Hitting an empty boat 3 times breaks it into its item (creative: one hit, no item).
// Boats are entities like dropped items: saved with the world (wood, position, facing, the player if aboard, the mob passenger),
// waiting in unloaded chunks and never despawning.
// API: BF.boats = { list, init, update(dt), drive(b, dt, input), raycast, place, placeFromPlayer, board, hit, seat(m), holds(m), seatOf(b, who),
//   exitSpot(b), letOut(b), remove(b), clear, serialize, deserialize, counts(), spawn(wood, x, y, z, yaw) }.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const HW = 0.6875, H = 0.5625, RIDDEN_H = 1.5;   // collision box (vanilla 1.375 wide); with the player aboard it covers the sitting player
const SINK = 0.15;                               // the hull bottom sits this far under the water surface (just under the inside floor)
const GRAV = 26, SIT_EYE = 1.2;                  // SIT_EYE: the player's eye above the boat bottom while sitting in it
const WATER = { acc: 9.6, drag: 1.2, side: 5, turn: 2.2 };    // terminal speed acc / drag = 8 blocks/s
const ICE = { acc: 8, drag: 0.2, side: 0.6, turn: 2.2 };      // 40 blocks/s
const LAND = { acc: 1.6, drag: 4, side: 8, turn: 1.0 };       // 0.4 blocks/s: slides slowly
const AIR = { acc: 0, drag: 0.05, side: 0.05, turn: 0 };
const BACK = 0.35;                               // rowing backwards is slower
const FLOW_PUSH = 2.0;                           // flowing water accelerates a boat along the flow (with water drag: ~1.7 blocks/s drift)
const HITS = 3, HIT_DECAY = 1, EJECT_CD = 4;     // hits to break (damage decays 1 per second); seconds before a let-out mob may get back in
const ICE_IDS = new Set();
let scene = null, mat0 = null;

const fwdOf = yaw => [-Math.sin(yaw), -Math.cos(yaw)];
const planksTile = wood => (wood === "oak" ? "planks" : wood + "_planks");

// ---------- items, recipes, sprite ----------
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, fuel }) => {
  const I = BF.I, all = [];
  for (const sp of BF.WOOD_SPECIES) {
    const out = I[sp + "_boat"], pl = I[sp === "oak" ? "planks" : sp + "_planks"];
    if (out == null || pl == null) continue;
    addShaped(out, 1, ["P P", "PPP"], { P: pl }, sp === "oak" ? "5 Planks of one wood (U shape) → Boat of that wood" : undefined);
    all.push(out);
  }
  fuel(all, 60, "Boats");
});
if (BF.texKit) {
  const { SPRITES, put, mul, mix, WHITE } = BF.texKit;
  SPRITES.boat = (G, m) => {   // side view: a hull with a paddle across it
    const hi = mix(m, WHITE, 0.25), lo = mul(m, 0.62), dk = mul(m, 0.45);
    for (let x = 1; x <= 14; x++) { put(G, x, 7, hi); put(G, x, 8, m); }
    for (let x = 2; x <= 13; x++) { put(G, x, 9, m); put(G, x, 10, lo); }
    for (let x = 3; x <= 12; x++) put(G, x, 11, dk);
    for (const x of [1, 14]) put(G, x, 6, hi);
    for (let i = 0; i < 9; i++) put(G, 4 + i, 12 - i, i < 2 ? mul(m, 0.8) : hi);   // paddle shaft
    put(G, 3, 13, lo); put(G, 4, 13, lo); put(G, 3, 12, lo);                          // blade
  };
}

// ---------- model ----------
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
const geoCache = new Map();
function geos(wood) {
  let g = geoCache.get(wood);
  if (!g) {
    const r = BF.textures.uv(planksTile(wood)), rs = BF.textures.uv(wood + "_log");
    g = { hull: boxesGeometry(HULL, r), paddle: boxesGeometry(PADDLE, BF.textures.has && BF.textures.has(wood + "_log") ? rs : r) };
    geoCache.set(wood, g);
  }
  return g;
}
function buildMesh(b) {
  const g = geos(b.wood);
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
  b.mesh = root; b.body = body; b.paddles = paddles; b.mat = mat;
  scene.add(root);
}

// ---------- water ----------
const FH = (x, y, z) => {   // water surface height inside cell y (as world.js draws it), or -1
  const W = BF.world, f = BF.FLUID[W.getBlock(x, y, z)];
  if (!f) return -1;
  if (BF.FLUID[W.getBlock(x, y + 1, z)]) return 1;
  return f === 8 ? 0.889 : (8 - f) / 9;
};
const SAMPLE = [[0, 0], [0.45, 0.45], [-0.45, 0.45], [0.45, -0.45], [-0.45, -0.45]];
// Highest water surface under the hull, looked for from just above the boat down to just under it (so a boat rises up a water column
// and drops down a river step going downstream); null when there is none.
function surfaceUnder(b) {
  let best = null;
  const p = b.pos, top = Math.floor(p.y + 0.95), bot = Math.floor(p.y - 0.6);
  for (const [ox, oz] of SAMPLE) {
    const x = Math.floor(p.x + ox), z = Math.floor(p.z + oz);
    for (let y = top; y >= bot; y--) {
      const h = FH(x, y, z);
      if (h >= 0) { if (best == null || y + h > best) best = y + h; break; }
    }
  }
  return best;
}
// Direction flowing water pushes at the boat's centre: from higher to lower water in the neighbouring cells, and strongly over a drop.
function flowAt(p) {
  const x = Math.floor(p.x), y = Math.floor(p.y + 0.3), z = Math.floor(p.z), W = BF.world;
  let cy = y, h = FH(x, cy, z);
  if (h < 0) { cy = y - 1; h = FH(x, cy, z); }
  if (h < 0) return null;
  let fx = 0, fz = 0;
  for (const [dx, dz] of BF.DIRS) {
    const nh = FH(x + dx, cy, z + dz);
    if (nh >= 0) { fx += dx * (h - nh); fz += dz * (h - nh); }
    else if (!BF.SOLID[W.getBlock(x + dx, cy, z + dz)] && FH(x + dx, cy - 1, z + dz) >= 0) { fx += dx; fz += dz; }   // water falls away there
  }
  const l = Math.hypot(fx, fz);
  return l > 0.01 ? [fx / Math.max(1, l), fz / Math.max(1, l)] : null;
}

// ---------- boats ----------
const list = [];
function create(wood, x, y, z, yaw) {
  if (!scene || BF.I[wood + "_boat"] == null) return null;
  const b = { kind: "boat", ctl: RIDE, wood, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), yaw: yaw || 0, damage: 0, hurtT: 0, rider: false, mob: null, stowed: null,
    stowT: 0, row: [0, 0], rowing: [0, 0], onGround: false, inWater: false, medium: "air" };
  buildMesh(b);
  list.push(b);
  syncMesh(b);
  return b;
}
const height = b => (b.rider ? RIDDEN_H : H);
const loadedAt = (x, z) => BF.world.isLoaded(x, z);
function lightAt(p) {
  const sky = BF.sky ? 0.35 + 0.65 * BF.sky.light : 1;
  let bl = 0;
  try { bl = BF.world.getBlockLight(p.x, p.y + 0.5, p.z) / 15; } catch (_) {}
  return Math.max(0.12, sky, Math.pow(bl, 1.5));
}
function syncMesh(b) {
  if (!b.mesh) return;
  const here = loadedAt(b.pos.x, b.pos.z);
  b.mesh.visible = here;
  b.mesh.position.copy(b.pos);
  b.mesh.rotation.y = b.yaw;
  b.body.rotation.z = b.hurtT > 0 ? Math.sin(b.hurtT * 30) * b.hurtT * 0.6 : 0;
  // paddles: an active one sweeps fore and aft and dips; a resting one lies along the hull
  for (let i = 0; i < 2; i++) {
    const p = b.paddles[i], side = i === 0 ? -1 : 1, ph = b.row[i];
    if (b.rowing[i]) { p.rotation.x = Math.sin(ph) * 0.75; p.rotation.z = side * (0.75 + 0.25 * Math.cos(ph)); }
    else { p.rotation.x += (1.1 - p.rotation.x) * 0.2; p.rotation.z += (side * 1.25 - p.rotation.z) * 0.2; }
  }
  b.mat.color.setScalar(lightAt(b.pos));
}
// Lifts a boat stuck in a solid block (a block put into it, water that froze around it) onto the nearest free spot above.
function unstick(b) {
  const W = BF.world, h = height(b);
  if (!W.boxCollides(b.pos.x, b.pos.y, b.pos.z, HW, h)) return;
  for (let k = 1; k <= 2; k++) {
    const y = Math.floor(b.pos.y) + k;
    if (!W.boxCollides(b.pos.x, y, b.pos.z, HW, h)) { b.pos.y = y; b.vel.y = 0; return; }
  }
}
// One physics step. input: {fwd: -1..1, turn: -1 (right) .. 1 (left)} or null for an empty boat.
function step(b, dt, input) {
  const p = b.pos, v = b.vel, W = BF.world;
  if (!loadedAt(p.x, p.z)) return;   // waits in an unloaded chunk, like a dropped item
  b.hurtT = Math.max(0, b.hurtT - dt);
  b.damage = Math.max(0, b.damage - HIT_DECAY * dt);
  unstick(b);
  const surf = surfaceUnder(b), floatY = surf != null ? surf - SINK : null;
  b.inWater = floatY != null && p.y <= floatY + 0.25;
  const under = W.getBlock(p.x, p.y - 0.05, p.z);
  const onIce = b.onGround && ICE_IDS.has(under);
  const M = b.inWater ? WATER : onIce ? ICE : b.onGround ? LAND : AIR;
  b.medium = b.inWater ? "water" : onIce ? "ice" : b.onGround ? "land" : "air";
  // vertical: float up to the surface, else fall
  if (b.inWater) v.y = Math.max(-3, Math.min(4, (floatY - p.y) * 8));
  else v.y = Math.max(-40, v.y - GRAV * dt);
  // steering and rowing
  const fwd = input ? Math.max(-1, Math.min(1, input.fwd || 0)) : 0, turn = input ? Math.max(-1, Math.min(1, input.turn || 0)) : 0;
  if (turn && M.turn) b.yaw += turn * M.turn * dt;
  const [fx, fz] = fwdOf(b.yaw), rx = -fz, rz = fx;
  let vf = v.x * fx + v.z * fz, vs = v.x * rx + v.z * rz;
  vf += fwd * (fwd < 0 ? BACK : 1) * M.acc * dt;
  vf *= Math.exp(-M.drag * dt); vs *= Math.exp(-M.side * dt);
  v.x = fx * vf + rx * vs; v.z = fz * vf + rz * vs;
  if (b.inWater) { const fl = flowAt(p); if (fl) { v.x += fl[0] * FLOW_PUSH * dt; v.z += fl[1] * FLOW_PUSH * dt; } }
  // paddles: left paddle pulls when going forward or turning right, right paddle forward or turning left
  const act = [fwd !== 0 || turn < 0, fwd !== 0 || turn > 0];
  for (let i = 0; i < 2; i++) { b.rowing[i] = input && act[i] ? (fwd < 0 ? -1 : 1) : 0; if (b.rowing[i]) b.row[i] += b.rowing[i] * dt * 7; }
  // never move into terrain that isn't loaded (it would read as air and the boat would fall out of the world)
  const ahead = 1 + Math.hypot(v.x, v.z) * dt;
  const sp = Math.hypot(v.x, v.z) || 1;
  if (!loadedAt(p.x + v.x / sp * ahead, p.z + v.z / sp * ahead)) { v.x = 0; v.z = 0; }
  const res = W.moveBox(p, v, HW, height(b), dt, { stepUp: 0 });   // no stepping: a boat never climbs onto a ledge or up a river step
  b.onGround = res.onGround;
  if (p.y < BF.MIN_Y) { p.y = BF.MIN_Y; v.y = 0; }
}
// The player pushes an empty boat by walking into it.
function pushByPlayer(b, dt) {
  const P = BF.player;
  if (!P || P.dead || P.vehicle) return;
  const pp = P.position, dx = b.pos.x - pp.x, dz = b.pos.z - pp.z, reach = HW + P.halfWidth;
  if (Math.abs(dx) > reach || Math.abs(dz) > reach || pp.y > b.pos.y + H || pp.y + P.height < b.pos.y) return;
  const d = Math.hypot(dx, dz) || 1;
  b.vel.x += dx / d * 6 * dt; b.vel.z += dz / d * 6 * dt;
}

// ---------- passengers ----------
// How high a mob's feet (its model root) sit above the boat bottom: two-legged mobs sit on the seat with their legs forward (js/mobs.js
// animate), villagers with the hem of their robe on the floor, four-legged ones and spiders stand on the floor.
function mobSeatY(m) {
  const legs = m.meshes && m.meshes.legL && !m.meshes.legFL ? m.meshes.legL : null;
  if (!legs) return 0.12;
  if (m.type === "villager") return 3 / 16 - 4 / 16;
  return 5 / 16 - legs.position.y;
}
// Where a rider sits: the player at the front of the seat when a mob shares the boat, the mob behind; alone, either sits in the middle.
function seatOf(b, who) {
  const [fx, fz] = fwdOf(b.yaw), both = b.rider && b.mob;
  const k = !both ? 0 : who === "player" ? 0.2 : -0.6;
  return { x: b.pos.x + fx * k, y: b.pos.y + (who === "player" || !b.mob ? 0 : mobSeatY(b.mob)), z: b.pos.z + fz * k };
}
function seatMob(b) {
  const m = b.mob;
  if (!m) return;
  const s = seatOf(b, "mob");
  m.position.set(s.x, s.y, s.z);
  m.vel.set(0, 0, 0);
  m.yaw = b.yaw + Math.PI;   // mob models face +z at yaw 0; the boat's bow is -z
  if (m.model) m.model.rotation.y = m.yaw;
}
function takeMob(b, m) {
  if (b.mob || !m || m.dead || m.removed || m.riding) return false;
  b.mob = m; m.riding = b; m.fallStart = null;
  if (m.ai) { m.ai.route = null; m.ai.mode = "idle"; }
  seatMob(b);
  return true;
}
function letOut(b) {
  const m = b.mob;
  if (!m) return null;
  b.mob = null; m.riding = null; m.boatCd = EJECT_CD;
  const s = exitSpot(b, m.halfWidth, m.height);
  m.position.set(s.x, s.y, s.z);
  m.fallStart = s.y;
  return m;
}
// Nearest place to step out of the boat: standing on a solid block beside it, else in the water next to it, else on top of the hull.
function exitSpot(b, hw, h) {
  const W = BF.world, p = b.pos;
  let best = null, bd = Infinity;
  const cx = Math.floor(p.x), cz = Math.floor(p.z), cy = Math.floor(p.y);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) {
    const x = cx + dx + 0.5, z = cz + dz + 0.5, y = cy + dy;
    if (!BF.SOLID[W.getBlock(x, y - 1, z)] || W.boxCollides(x, y, z, hw, h) || BF.FLUID[W.getBlock(x, y, z)]) continue;
    const d = Math.hypot(x - p.x, z - p.z) + Math.abs(y - p.y) * 0.5;
    if (d < bd) { bd = d; best = { x, y, z }; }
  }
  if (best) return best;
  const [fx, fz] = fwdOf(b.yaw);
  for (const s of [1, -1]) {   // into the water off either side
    const x = p.x - fz * s * (HW + hw + 0.05), z = p.z + fx * s * (HW + hw + 0.05);
    if (!W.boxCollides(x, p.y, z, hw, h)) return { x, y: p.y, z };
  }
  return { x: p.x, y: p.y + H, z: p.z };
}
function stow(b) {   // the mob passenger's chunk unloaded: remember it and seat it again when the boat is back
  const m = b.mob;
  b.mob = null;
  if (!m || m.dead) return;
  m.riding = null;
  b.stowed = { type: m.type, variant: m.variant || null, style: m.style || null, key: m.village && m.slot ? m.village.key + "#" + m.slot.idx : null };
  b.stowT = 0;
}
function restoreStowed(b, dt) {
  const s = b.stowed;
  if (!s || !BF.mobs) return;
  b.stowT += dt;
  if (s.key) {   // a villager: its village respawns it; take it back once it is around
    const m = BF.mobs.list.find(o => !o.dead && !o.removed && !o.riding && o.village && o.slot && o.village.key + "#" + o.slot.idx === s.key);
    if (m) { b.stowed = null; takeMob(b, m); }
    else if (b.stowT > 10) b.stowed = null;   // its village didn't bring it back (dead, or the village is far): the seat is free again
    return;
  }
  const seat = seatOf(b, "mob"), m = BF.mobs.spawn(s.type, seat.x, seat.y, seat.z, s.variant || undefined, s.style || undefined);
  b.stowed = null;
  if (m) takeMob(b, m);
}
// Mobs that walk into an empty seat get in (not iron golems, sleeping or trading villagers, or one just let out).
function pickUpMobs(b) {
  if (b.mob || b.stowed || !BF.mobs) return;
  for (const m of BF.mobs.list) {
    if (m.dead || m.removed || m.riding || m.rider || m.sleeping || m.tradingWith || (m.def && (m.def.golem || m.def.herd)) || (m.boatCd || 0) > 0) continue;
    const r = HW + m.halfWidth - 0.1;
    if (Math.abs(m.position.x - b.pos.x) > r || Math.abs(m.position.z - b.pos.z) > r) continue;
    if (m.position.y > b.pos.y + H || m.position.y + m.height < b.pos.y) continue;
    if (takeMob(b, m)) return;
  }
}

// ---------- player ----------
function rayAABB(o, d, mn, mx) {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? o.x : i === 1 ? o.y : o.z, di = i === 0 ? d.x : i === 1 ? d.y : d.z;
    if (Math.abs(di) < 1e-9) { if (oi < mn[i] || oi > mx[i]) return null; continue; }
    let ta = (mn[i] - oi) / di, tb = (mx[i] - oi) / di;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
// Ray from the player's eye: where a boat item would go. Water: on its surface; a block's top: on top of it; a block's side: beside it.
function placeSpot(origin, dir, reach) {
  const W = BF.world, hit = W.raycast(origin, dir, reach, id => id !== 0);
  if (!hit) return null;
  const x = hit.x + 0.5, z = hit.z + 0.5;
  if (BF.FLUID[hit.id]) {
    let y = hit.y;
    while (BF.FLUID[W.getBlock(x, y + 1, z)] && y < hit.y + 8) y++;   // the top of the water column
    return { x, y: y + FH(x, y, z) - SINK, z, water: true };
  }
  if (hit.normal[1] === 1) return { x, y: hit.y + 1, z, water: false };
  const nx = hit.x + hit.normal[0] + 0.5, nz = hit.z + hit.normal[2] + 0.5, ny = hit.y + hit.normal[1];
  if (BF.FLUID[W.getBlock(nx, ny, nz)]) return { x: nx, y: ny + FH(nx, ny, nz) - SINK, z: nz, water: true };
  return { x: nx, y: ny, z: nz, water: false };
}

// The player's riding interface for boats (js/player.js mount / dismount / ridePhysics).
const RIDE = {
  drive: (b, dt, input) => boats.drive(b, dt, input),
  seatOf: (b, who) => seatOf(b, who),
  sitEye: () => SIT_EYE,
  canBoard: b => boats.canBoard(b),
  exitSpot: (b, hw, h) => exitSpot(b, hw, h),
  onLeave: b => { if (b.mob) letOut(b); },   // Shift lets the mob passenger out too
};

const boats = {
  list,
  HW, H, SIT_EYE,
  init(sceneRef) {
    scene = sceneRef;
    for (const n of ["ice", "packed_ice", "blue_ice"]) if (BF.B[n] != null) ICE_IDS.add(BF.B[n]);
  },
  spawn(wood, x, y, z, yaw) { return create(wood, x, y, z, yaw); },
  // Puts a boat of `wood` down at the spot the player looks at (yaw: the player's look direction). Returns the boat or null.
  placeFromPlayer(wood, origin, dir, yaw, reach) {
    const s = placeSpot(origin, dir, reach || 5);
    if (!s || !loadedAt(s.x, s.z)) return null;
    if (BF.world.boxCollides(s.x, s.y, s.z, HW, H)) return null;
    const P = BF.player;
    if (P && !P.vehicle) {   // not into the player
      const pp = P.position, r = HW + P.halfWidth;
      if (Math.abs(pp.x - s.x) < r && Math.abs(pp.z - s.z) < r && pp.y < s.y + H && pp.y + P.height > s.y) return null;
    }
    const b = create(wood, s.x, s.y, s.z, yaw);
    if (b && BF.emit) BF.emit("boatPlaced", b);
    return b;
  },
  // Nearest boat whose box the ray hits within maxDist: {boat, dist} or null. skip: a boat to leave out (the one the player sits in).
  raycast(origin, dir, maxDist, skip) {
    let best = null;
    for (const b of list) {
      if (b === skip || !b.mesh || !b.mesh.visible) continue;
      const p = b.pos, t = rayAABB(origin, dir, [p.x - HW, p.y, p.z - HW], [p.x + HW, p.y + H, p.z + HW]);
      if (t != null && t <= maxDist && (!best || t < best.dist)) best = { boat: b, dist: t };
    }
    return best;
  },
  // Whether the player can get into b: a free seat and room for a sitting player.
  canBoard(b) { return !b.rider && !BF.world.boxCollides(b.pos.x, b.pos.y, b.pos.z, HW, RIDDEN_H); },
  // A hit from the player: lets a mob passenger out, else damages the boat; enough hits (one in creative) break it.
  // Returns "out" (mob let out), "hit", or "broken".
  hit(b, creative) {
    b.hurtT = 0.4;
    if (b.mob) { letOut(b); return "out"; }
    b.damage += 1;
    if (!creative && b.damage < HITS - 0.01) return "hit";
    boats.remove(b, !creative);
    return "broken";
  },
  // Removes a boat; drop: leave its item where it was.
  remove(b, drop) {
    const i = list.indexOf(b);
    if (i < 0) return;
    list.splice(i, 1);
    if (b.mob) letOut(b);
    if (b.rider && BF.player && BF.player.vehicle === b && BF.player.dismount) BF.player.dismount();
    if (scene && b.mesh) scene.remove(b.mesh);
    if (b.mat) b.mat.dispose();
    if (drop && BF.drops) BF.drops.spawn(BF.I[b.wood + "_boat"], 1, b.pos.x, b.pos.y + 0.3, b.pos.z);
  },
  letOut,
  exitSpot(b, hw, h) { return exitSpot(b, hw, h); },
  seatOf,
  holds(m) { return !!(m && m.riding && list.includes(m.riding) && m.riding.mob === m); },
  // js/mobs.js, each step of a mob in a boat: keep it in its seat. Returns false (and frees it) when the boat is gone or it fell asleep.
  seat(m) {
    const b = m.riding;
    if (!b || !list.includes(b) || b.mob !== m) { m.riding = null; return false; }
    if (m.sleeping) { letOut(b); return false; }
    seatMob(b);
    return true;
  },
  // The player's boat, every frame in real time (js/player.js): input {fwd, turn}. Returns the boat's yaw change.
  drive(b, dt, input) {
    const y0 = b.yaw;
    step(b, dt, input);
    if (b.mob && (b.mob.removed || b.mob.dead)) { if (b.mob.removed && !b.mob.dead) stow(b); else { b.mob.riding = null; b.mob = null; } }
    seatMob(b);
    syncMesh(b);
    return b.yaw - y0;
  },
  // World simulation step (main.js, runs with the fast-forward): boats without the player drift, pick up mobs, keep theirs seated.
  update(dt) {
    for (const b of list.slice()) {
      if (b.mob && (b.mob.removed || b.mob.dead)) { if (b.mob.removed && !b.mob.dead) stow(b); else { b.mob.riding = null; b.mob = null; } }
      if (!loadedAt(b.pos.x, b.pos.z)) { syncMesh(b); continue; }
      if (!b.rider) {
        pushByPlayer(b, dt);
        step(b, dt, null);
      }
      if (b.stowed) restoreStowed(b, dt);
      pickUpMobs(b);
      seatMob(b);
      if (!b.rider) syncMesh(b);
    }
    if (BF.mobs) for (const m of BF.mobs.list) if (m.boatCd > 0) m.boatCd -= dt;
  },
  clear() { for (const b of list.slice()) { b.rider = false; boats.remove(b, false); } },
  // Boat counts by wood for the debug screen: {oak_boat: n, ...}
  counts() { const o = {}; for (const b of list) o[b.wood + "_boat"] = (o[b.wood + "_boat"] || 0) + 1; return o; },
  // -> [[wood, x, y, z, yaw, rider (0/1), passenger | null]] for the save (js/save.js). passenger: {type, variant, style, key}.
  serialize() {
    const r = v => Math.round(v * 1000) / 1000;
    return list.map(b => {
      let pass = b.stowed;
      if (b.mob && !b.mob.dead) { const m = b.mob; pass = { type: m.type, variant: m.variant || null, style: m.style || null, key: m.village && m.slot ? m.village.key + "#" + m.slot.idx : null }; }
      return [b.wood, r(b.pos.x), r(b.pos.y), r(b.pos.z), r(b.yaw), b.rider ? 1 : 0, pass || null];
    });
  },
  // Puts saved boats back (old saves have none); the player goes back into the one they were in, a mob passenger is seated again
  // once its chunk is loaded (a villager when its village brings it back).
  deserialize(a) {
    if (!Array.isArray(a)) return;
    for (const e of a) {
      if (!Array.isArray(e)) continue;
      const [wood, x, y, z, yaw, rider, pass] = e;
      if (![x, y, z].every(Number.isFinite) || BF.I[wood + "_boat"] == null) continue;
      const b = create(wood, x, y, z, +yaw || 0);
      if (!b) continue;
      if (pass && typeof pass === "object" && typeof pass.type === "string") b.stowed = { type: pass.type, variant: pass.variant || null, style: pass.style || null, key: typeof pass.key === "string" ? pass.key : null };
      if (rider && BF.player && BF.player.mount) BF.player.mount(b, true);
    }
  },
};

BF.boats = boats;
})();
