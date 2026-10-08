// Dropped item entities: items that pop out of broken blocks and killed mobs, bob on the ground,
// and fly into the player's inventory when they walk close. They despawn after 5 minutes of lying in a loaded chunk
// (in an unloaded chunk they wait, as in vanilla), and are saved with the world, keeping their age.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const HW = 0.125, H = 0.25, GRAV = 18, PICKUP_R = 1.6, PICKUP_DELAY = 0.5, LIFE = 300, MAX = 300;
const loader = new THREE.TextureLoader(), mats = new Map();
let scene = null;

function matFor(id) {
  let m = mats.get(id);
  if (!m) {
    const tex = loader.load(BF.textures.icon(id));
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    m = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
    mats.set(id, m);
  }
  return m;
}

const drops = {
  list: [],

  init(sceneRef) { scene = sceneRef; },

  // Spawns `count` of item `id` at (x, y, z) with a small random toss. opts.vel (a THREE.Vector3) replaces the toss,
  // and opts.pickupDelay (seconds) holds off the player's pickup, e.g. for items the player threw. opts.wear: uses spent on a dropped tool.
  spawn(id, count, x, y, z, opts) {
    if (!scene || id == null || !BF.items[id] || !(count > 0)) return null;
    if (drops.list.length >= MAX) drops.remove(drops.list[0]);
    const sprite = new THREE.Sprite(matFor(id));
    sprite.scale.set(0.38, 0.38, 0.38);
    scene.add(sprite);
    const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 1.5;
    const vel = opts && opts.vel ? opts.vel.clone() : new THREE.Vector3(Math.cos(a) * s, 4 + Math.random() * 2, Math.sin(a) * s);
    const d = { id, count, pos: new THREE.Vector3(x, y, z), vel, age: 0, phase: Math.random() * 6.28, sprite,
      pickupDelay: opts && opts.pickupDelay != null ? opts.pickupDelay : PICKUP_DELAY, wear: (opts && opts.wear) || 0 };
    drops.list.push(d);
    return d;
  },

  // Spawns every stack from BF.rollDrops-style [{id, count}] at the centre of block (x, y, z).
  spawnAt(list, x, y, z) { for (const s of list || []) if (s && s.count > 0) drops.spawn(s.id, s.count, x + 0.5, y + 0.3, z + 0.5); },

  remove(d) {
    const i = drops.list.indexOf(d);
    if (i >= 0) drops.list.splice(i, 1);
    if (d.sprite) scene.remove(d.sprite);
  },

  clear() { for (const d of drops.list.slice()) drops.remove(d); },

  // -> [[id, count, x, y, z, age, wear, pickupDelay]] for the save (js/save.js)
  serialize() {
    const r = v => Math.round(v * 100) / 100;
    return drops.list.map(d => [d.id, d.count, r(d.pos.x), r(d.pos.y), r(d.pos.z), r(d.age), d.wear || 0, r(Math.max(0, d.pickupDelay - d.age))]);
  },

  // Puts saved drops back where they lay, at rest and with the age they had. Old saves have none.
  deserialize(a) {
    if (!Array.isArray(a)) return;
    for (const e of a) {
      if (!Array.isArray(e)) continue;
      const [id, count, x, y, z, age, wear, delay] = e;
      if (![x, y, z].every(Number.isFinite)) continue;
      const d = drops.spawn(id, count, x, y, z, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 0, wear: wear || 0 });
      if (!d) continue;
      d.age = Math.max(0, +age || 0);
      d.pickupDelay = d.age + Math.max(0, +delay || 0);
      d.sprite.position.copy(d.pos);
    }
  },

  update(dt) {
    const P = BF.player, pp = P && P.position, alive = P && !P.dead;
    const light = BF.sky ? 0.35 + 0.65 * BF.sky.light : 1;
    for (const d of drops.list.slice()) {
      // in an unloaded chunk an item neither ages nor falls (it would drop out of the world); it waits for the chunk
      const here = BF.world.isLoaded(d.pos.x, d.pos.z);
      d.sprite.visible = here;
      if (!here) continue;
      d.age += dt;
      if (d.age > LIFE) { drops.remove(d); continue; }
      // pulled toward the player once close enough, then collected
      if (alive && d.age > d.pickupDelay && pp) {
        const dx = pp.x - d.pos.x, dy = pp.y + 0.6 - d.pos.y, dz = pp.z - d.pos.z, dist = Math.hypot(dx, dy, dz);
        if (dist < 0.6) {
          const left = BF.inventory.add(d.id, d.count, d.wear);
          if (left <= 0) { drops.remove(d); continue; }
          d.count = left;
        } else if (dist < PICKUP_R) {
          const k = 10 / dist;
          d.vel.set(dx * k * 0.6, dy * k * 0.6, dz * k * 0.6);
          d.pos.addScaledVector(d.vel, dt);
          d.sprite.position.copy(d.pos);
          continue;
        }
      }
      // merge with an identical stack lying nearby
      if (d.age > 1 && (Math.floor(d.age * 4) % 4 === 0)) {
        const o = drops.list.find(o => o !== d && o.id === d.id && o.age > 1 && o.pos.distanceToSquared(d.pos) < 1);
        if (o && o.count + d.count <= (BF.items[d.id].stack || 64)) { o.count += d.count; drops.remove(d); continue; }
      }
      d.vel.y -= GRAV * dt;
      const res = BF.world.moveBox(d.pos, d.vel, HW, H, dt);
      if (res.onGround) { d.vel.x *= Math.pow(0.02, dt); d.vel.z *= Math.pow(0.02, dt); }
      if (d.pos.y < BF.MIN_Y - 10) { drops.remove(d); continue; }
      d.sprite.position.set(d.pos.x, d.pos.y + 0.22 + Math.sin(d.age * 2.5 + d.phase) * 0.06, d.pos.z);
      d.sprite.material.color.setScalar(light);
    }
  },
};

BF.drops = drops;
})();
