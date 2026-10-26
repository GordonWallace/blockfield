// Mobs: blocky Minecraft-style animals and monsters built from boxes with baked per-pixel vertex colours.
// Passive: pig, cow, sheep, chicken. Hostile: zombie, skeleton, creeper, spider.
// API (CONTRACT.md): BF.mobs = { list, init, update, draw, raycast, hit, clear } plus spawn(type, x, y, z) for debugging.
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const GRAVITY = 26;
const FAR_R = 100, FAR_HZ = 4;   // wild mobs and monsters past 100 blocks (or the view distance) update 4 times a game second (BF.mobs.update)
const DESPAWN_DIST = 100;   // village stock of a stopped village only: wild mobs and horses are never removed by distance (they wait with their chunk)
const TRAVELLER_SPEED = 1.5;   // merchants and explorers walk this much faster than other villagers (village loading plan)

let ready = false;   // init has run
const list = [];
const arrows = [];

// ---------- small helpers ----------
// Simulation rolls come from seeded streams (js/rand.js): a mob's own, R(m), or a world event's, BF.rand.at(...).
const R = e => BF.rand.of(e);
const rnd = (r, a, b) => r.range(a, b);
const irnd = (r, a, b) => a + r.int(b - a + 1);
function hash(a, b, c, d) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function wrapAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

// ---------- face edges on the planet (spec r14-13) ----------
// Coordinates are kept in a frame (js/planet.js "frames"): a villager, golem or penned animal in its village's frame (so home, bed and pen
// coordinates stay plain x / z maths when it walks past a face edge; they are margin addresses there), everything else on the canonical
// square of the face it stands on. keepFrame runs after every move step. Anything compared with something that may be kept in another
// frame (the player, other mobs, arrows) is first seen from this one: seen(a, o) is o's position expressed in a's frame, so dx / dz / a
// distance are true local offsets across an edge.
const LQ = {};
function seen(a, o, out) {
  BF.planet.local(a, o, LQ);
  if (LQ.x === o.x && LQ.z === o.z) return o;
  out = out || new THREE.Vector3();
  out.set(LQ.x, o.y, LQ.z);
  return out;
}
const _pAt = new THREE.Vector3(), _sA = new THREE.Vector3(), _sB = new THREE.Vector3(), _sEye = new THREE.Vector3();
const _rHead = new THREE.Vector3();   // raycast: a sleeping mob's head end
const pAt = m => seen(m.position, player().position, _pAt);          // the player's position in m's frame
const mdist = (a, b) => seen(a.position, b.position, _sB).distanceTo(a.position);   // distance between two mobs (any frames)
// The face whose frame a mob is kept in, or -1: its own face's canonical square. Anything ridden or riding goes with its rider or boat,
// which keep to the canonical square (js/player.js crossEdge, js/boats.js).
function frameFace(m) {
  if (m.rider || m.riding) return -1;
  const V = m.village || m.penVillage || (m.coop && m.coop.rec) || (m.pen && m.pen.rec);
  if (V && typeof V.x === "number") return BF.planet.face(V.x, V.z);
  const hp = m.horse && m.horse.pen;
  return hp && typeof hp.x0 === "number" ? BF.planet.face(hp.x0, hp.z0) : -1;
}
const FR = {};
// After a move step: puts the mob back in its frame when it left it (turning its yaw and velocity) and re-expresses the points its AI
// holds (wander target, route cells) in the new frame.
function keepFrame(m) {
  if (m.rider) return;   // a ridden mob crosses with its rider (player.js crossEdge)
  const q = BF.planet.reframe(m.position, frameFace(m), m, m.vel);
  if (q == null) return;
  const P = BF.planet, F = P.face(m.position.x, m.position.z), ai = m.ai;
  if (typeof ai.tx === "number" && P.inFrame(F, ai.tx, ai.tz, FR)) { ai.tx = FR.x; ai.tz = FR.z; }
  if (ai.route) for (const c of ai.route) if (P.inFrame(F, c[0] + 0.5, c[2] + 0.5, FR)) { c[0] = Math.floor(FR.x); c[2] = Math.floor(FR.z); }
  if (BF.emit) BF.emit("mobCrossedEdge", m, q);
}
// Spatial grid key of the cell (gx, gz) of size s, seen from any frame: the canonical cell it shows (grid cells line up across edges).
const GC = {};
function gridKey(gx, gz, s) {
  const c = BF.planet.canon(gx * s + s / 2, gz * s + s / 2, GC);
  if (!c.off) { gx = Math.floor(c.x / s); gz = Math.floor(c.z / s); }
  return sepKey(gx, gz);
}
// Whether every grid cell a lookup within d blocks of (x, z) touches is already canonical: (x, z) lies at least d blocks inside the
// middle square of its face, so gridKey's canon() would hand each cell back unchanged (r15-06: most mobs are nowhere near an edge).
// A mob kept in another face's frame (keepFrame) is in the margin, so it takes the canonical path.
const GRID_EDGE = 48;   // nearestMob's 5 x 5 cells of 16 reach 40 blocks from the mob; separate's 3 x 3 cells of 2, 3
function inSquare(x, z, d) {
  const P = BF.planet, N = P.N, W = P.W;
  if (!(x >= 0 && z >= 0)) return false;
  const f = Math.floor(x / W);
  if (f >= 6) return false;
  const u = x - W * f - N, v = z - N;
  return u >= d && u < N - d && v >= d && v < N - d;
}
const player = () => BF.player;
function playerAlive() { const p = BF.player; return !!(p && p.position && !p.dead); }
function creative() { const p = BF.player; return !!(p && p.gameMode === "creative"); }
function skyLight() { return BF.sky && typeof BF.sky.light === "number" ? BF.sky.light : 1; }
function isNight() {
  if (BF.sky && typeof BF.sky.isNight === "function") return !!BF.sky.isNight();
  return skyLight() < 0.4;
}
// Sky light at a world position (js/skylight.js, the same levels the world is drawn with).
// Returns {open, level, factor}: level 0..15; open = bright enough to burn the undead (SUN_BURN or more); factor = its brightness.
const SUN_BURN = 12, CAVE_SKY = 7;
const OPEN_SKY = { open: true, level: 15, factor: 1 };
function skyAt(x, y, z) {
  if (!BF.skyLight) return OPEN_SKY;
  const l = BF.skyLight.get(x, y, z);
  return l === 15 ? OPEN_SKY : { open: l >= SUN_BURN, level: l, factor: BF.skyLight.bright(l) };
}
function isWater(id) { return BF.RENDER[id] === 3; }

// ---------- spawn darkness ----------
// A monster spawns at a spot only after the spot has been dark enough for DARK_WAIT, half an in-game hour (plus a per-cell extra of up
// to another half hour, so they trickle in): block light <= 7, and
// under open sky a sky light <= SPAWN_LIGHT (a little before full night). The sky's light curve is known for any past time, so
// "dark for half an hour" under open sky is just the light now and half an hour ago: no per-spot tracking. Spots whose sky light
// is CAVE_SKY or less (caves, deep inside dense forest or a windowless building) count as dark at any time. What the curve can't know is a local change: a light
// source removed, or a block placed that shades the ground (a new roof). Those stamp a coarse cell (CELL x CELL columns, a light
// source also the cells around it) and nothing spawns in a stamped cell until DARK_WAIT has passed.
const SPAWN_LIGHT = 0.3, DARK_WAIT = 0.5 / 24, CELL = 8;
const darkStamps = new Map();   // "cx,cz" (cells) -> game time (days) of the last darkening change
const gameNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const stormy = () => !!(BF.sky && BF.sky.stormy && BF.sky.stormy());
function skyLightAt(t) { return BF.sky && BF.sky.lightAt ? BF.sky.lightAt(t) : isNight() ? 0.18 : 1; }
function darkLongEnough(x, z, factor) {
  const t = BF.sky ? BF.sky.time || 0 : 0, cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  // Half an hour at least; each cell adds up to another half hour (varies by cell and night) so monsters trickle in over the
  // next half hour instead of all appearing the moment the wait ends.
  const wait = DARK_WAIT * (1 + hash(cx, cz, BF.sky ? BF.sky.day | 0 : 0, 7));
  // the light curve only falls then rises over the night, so its highest value over the wait is at one of the ends
  if (factor * Math.max(skyLightAt(t), skyLightAt(t - wait)) > SPAWN_LIGHT && !stormy()) return false;
  if (!darkStamps.size) return true;
  const st = darkStamps.get(cx + "," + cz);
  return st == null || gameNow() - st >= wait || st > gameNow();   // a stamp in the future: time was set back
}
function stampDark(x, z, r) {
  const now = gameNow(), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) darkStamps.set((cx + dx) + "," + (cz + dz), now);
  if (darkStamps.size > 4096) for (const [k, v] of darkStamps) if (now - v >= DARK_WAIT || v > now) darkStamps.delete(k);
}

// (The mob models, their geometry and everything else about how a mob looks are in js/mobview.js, spec r15-11.)
// Iron golem cracks show at 3 stages (below 75%, 50% and 25% health, like vanilla): m.crackStage, drawn by js/mobview.js.
const golemCrackLevel = m => { const f = m.hp / m.maxHp; return f < 0.25 ? 3 : f < 0.5 ? 2 : f < 0.75 ? 1 : 0; };


// Villager professions -> outfit. robe/trim override the biome robe; apron covers the front; sash is a belt line.
const VILLAGER_OUTFITS = {
  farmer:        { hat: { kind: "straw", color: 0xd8b45a, color2: 0xc9a24a }, sash: 0xc9a24a },
  librarian:     { robe: 0xe6e3da, trim: 0xa8322a, hat: { kind: "brim", color: 0x8a2a24, color2: 0xa8322a } },
  cleric:        { robe: 0x7a3c9c, trim: 0xd8b84a, sash: 0xd8b84a },
  armorer:       { apron: 0x1c1c1c, mask: true },
  weaponsmith:   { apron: 0x2a2a2e, eyepatch: true, sash: 0x8a6a40 },
  toolsmith:     { apron: 0x3a3a3a, sash: 0xd8b84a, trim: 0x2a2a2a },
  butcher:       { apron: 0xf2f2f2, headband: 0xc02a2a, sash: 0xc02a2a },
  fisherman:     { hat: { kind: "bucket", color: 0x4f6f7a, color2: 0x5f8590 }, sash: 0x2a6aa8 },
  shepherd:      { hat: { kind: "brim", color: 0x5a3a20, color2: 0x6b4a2a }, sash: 0xe9e9e6, trim: 0xe9e9e6 },
  fletcher:      { hat: { kind: "feather", color: 0x3f7a34, color2: 0x2e5c26 }, sash: 0x3f7a34 },
  mason:         { apron: 0x8e8e94, sash: 0x55555c, trim: 0x55555c },
  leatherworker: { apron: 0xa8642e, sash: 0x5a3216, headband: 0x8a5a2a },
  cartographer:  { monocle: true, sash: 0x2a4a9a, trim: 0x2a4a9a },
  // explorer (16th, not vanilla): khaki field robe, wide brim hat, leather strap sash; seeks maps from the cartographer (js/explorer.js)
  explorer:      { robe: 0x8c7a4c, trim: 0x4a3a20, hat: { kind: "brim", color: 0x4a3c22, color2: 0x5c4a2a }, sash: 0x3a2a14 },
  // forester (17th, not vanilla; from the villager-planter mod): forest-green robe, brown belt, leafy brim hat; plants saplings and fells trees (js/forester.js)
  forester:      { robe: 0x2f6a2c, trim: 0x1f4a1e, hat: { kind: "brim", color: 0x2a5a26, color2: 0x3a7a34 }, sash: 0x4a3220 },
  // miner (not vanilla): slate work robe, leather apron, dark hard hat with a lamp, a pickaxe in hand; mines cobblestone (js/miner.js)
  miner:         { robe: 0x4a4c54, trim: 0x2e3036, apron: 0x6b4a2a, sash: 0xd8a83a, pickaxe: true, hat: { kind: "hard", color: 0x3c3e44, color2: 0x2e3036, lamp: true } },
  // furniture maker (not vanilla): sawdust-tan apron over a wine robe, red headband; makes beds for builders from wool and boards (js/furniture.js)
  furniture_maker: { robe: 0x6a2e34, trim: 0x4a1e22, apron: 0xc8a26a, headband: 0xb02a2a, sash: 0xe8e4d8 },
  // stable hand (not vanilla): saddle-brown work coat, denim apron, rope belt, tan wide-brim hat; catches, breeds and sells horses (js/stables.js).
  // Never in the roster pool: villages only get one when a builder puts up a stable and a villager takes its tack rack
  stable_hand:   { robe: 0x7a5232, trim: 0x4a3018, apron: 0x3d5a7a, sash: 0xc9a24a, hat: { kind: "brim", color: 0xb08850, color2: 0x9a7444 } },
  // merchant (not vanilla): deep blue travelling coat with gold trim, a satchel-brown sash, a tall felt hat; carries goods between villages (js/merchant.js)
  merchant:      { robe: 0x24346a, trim: 0xc8a040, sash: 0x6b4a2a, hat: { kind: "brim", color: 0x3a2a4a, color2: 0x2a1e36 } },
  nitwit:        { robe: 0x3f8a3a, trim: 0x2e6a2a },
  // builder (15th): orange hi-vis vest with reflective band and straps, brown overalls, yellow hard hat, a hammer in hand
  builder:       { robe: 0xe8741c, trim: 0x6b4a2a, vest: true, sash: 0x4a3220, hammer: true, hat: { kind: "hard", color: 0xf5c518, color2: 0xe3b012 } },
  // no jobsite (js/jobs.js): the plain biome robe of a vanilla unemployed villager; never in the roster pool
  unemployed:    {},
  // poultry keeper (not vanilla): straw-yellow apron over a russet robe, a brim hat; keeps chickens in a coop (js/poultry.js)
  poultry_keeper: { robe: 0x8a4a2a, trim: 0x5a2e1a, apron: 0xe6cf7a, sash: 0xd8b84a, hat: { kind: "brim", color: 0xc9a24a, color2: 0xd8b45a } },
  // cowherd (not vanilla): leather apron over an olive smock, a milk-white belt and a brown brim hat; keeps cows in a pasture (js/cowherd.js)
  cowherd:       { robe: 0x6a7448, trim: 0x454c2c, apron: 0x8a5530, sash: 0xf0ece0, hat: { kind: "brim", color: 0x5e3a1e, color2: 0x74492a } },
  // baker (not vanilla): a cream robe, a flour-white apron, a brick-red belt and a tall white cap; bakes cakes and pies in its oven (js/baker.js)
  baker:         { robe: 0xd8c8a8, trim: 0x9a7a52, apron: 0xf6f4ee, sash: 0xa0523a, hat: { kind: "bucket", color: 0xf8f8f4, color2: 0xe8e6e0 } },
  // glassmaker (not vanilla): a slate-blue robe, a scorched leather apron and a pale glass-blue belt; digs sand and makes glass at its kiln (js/glassmaker.js)
  glassmaker:    { robe: 0x4e5e6e, trim: 0x2e3a46, apron: 0x7a5636, sash: 0xa8dcea },
  // beekeeper (not vanilla): a pale smock, a honey-gold apron and belt and a wide brim hat; keeps hives and makes candles (js/beekeeper.js)
  beekeeper:     { robe: 0xe8e2cc, trim: 0xb8ae90, apron: 0xd89a2a, sash: 0x8a5a1a, hat: { kind: "brim", color: 0xf0ead6, color2: 0xd8d0b8 } },
  // pig farmer (not vanilla): a muddy brown smock, a pink-stained apron, a straw belt and a straw hat; keeps pigs in a sty (js/pigfarmer.js)
  pig_farmer:    { robe: 0x7a5a3e, trim: 0x4a3420, apron: 0xc89088, sash: 0xd8c070, hat: { kind: "brim", color: 0xc8a850, color2: 0xa88a3a } },
};
const PROFESSIONS = Object.keys(VILLAGER_OUTFITS);
const PROF_ALIAS = { smith: "toolsmith" };
const VILLAGE_STYLES = ["plains", "desert", "snowy", "savanna", "taiga"];


// ---------- type table ----------
// spawns (monsters): whether the type spawns in the world being played, a plain boolean that the world's game options set (js/gameopts.js);
// false drops spawn tries that pick it and keeps stored ones from coming back. A type with no spawns flag is not switchable.
const TYPES = {
  pig:      { hostile: false, hp: 10, hw: 0.45, h: 0.9,  speed: 1.3, flee: 3.4, drops: [["raw_porkchop", 1, 3]] },
  cow:      { hostile: false, hp: 10, hw: 0.45, h: 1.4,  speed: 1.1, flee: 3.0, drops: [["raw_beef", 1, 3], ["leather", 0, 2]] },
  sheep:    { hostile: false, hp: 8,  hw: 0.45, h: 1.3,  speed: 1.2, flee: 3.2, drops: [["white_wool", 1, 1], ["raw_mutton", 1, 2]] },
  chicken:  { hostile: false, hp: 4,  hw: 0.2,  h: 0.75, speed: 1.1, flee: 3.0, drops: [["raw_chicken", 1, 1], ["feather", 0, 2]], slowFall: true },
  zombie:   { hostile: true,  spawns: true, hp: 20, hw: 0.3,  h: 1.95, speed: 2.2, attack: 3, burns: true, drops: [["rotten_flesh", 0, 2]] },
  skeleton: { hostile: true,  spawns: true, hp: 20, hw: 0.3,  h: 1.99, speed: 2.3, burns: true, drops: [["bone", 0, 2], ["arrow", 0, 2]] },
  creeper:  { hostile: true,  spawns: true, hp: 20, hw: 0.3,  h: 1.7,  speed: 1.9, drops: [["gunpowder", 0, 2]] },
  spider:   { hostile: true,  spawns: true, hp: 16, hw: 0.7,  h: 0.9,  speed: 3.4, attack: 2, climbs: true, drops: [["string", 0, 2]] },
  villager: { hostile: false, hp: 20, hw: 0.3,  h: 1.95, speed: 0.9, flee: 2.8, village: true, variants: PROFESSIONS, drops: [] },
  iron_golem: { hostile: false, hp: 100, hw: 0.7, h: 2.7, speed: 1.4, attack: 10, village: true, golem: true, noKnock: true, drops: [["iron_ingot", 3, 5]] },
  // horses (js/horses.js): spawned in herds by js/horses.js, not by the passive spawner, and not counted against its cap; hp is rolled per horse
  horse:    { hostile: false, hp: 22, hw: 0.7, h: 1.6, speed: 1.6, flee: 5.5, herd: true, drops: [["leather", 0, 2]] },
};
const PASSIVE_TYPES = ["pig", "cow", "sheep", "chicken"];
const HOSTILE_WEIGHTS = [["zombie", 0.33], ["skeleton", 0.25], ["creeper", 0.24], ["spider", 0.18]];


// ---------- audio (tiny, optional; only plays once the page has an unlocked AudioContext) ----------
let actx = null, noiseBuf = null;
function audio() {
  try {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !(navigator.userActivation && navigator.userActivation.hasBeenActive)) return null;
      actx = new AC();
      noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;   // visual
    }
    if (actx.state === "suspended") actx.resume().catch(() => {});
    return actx.state === "running" ? actx : null;
  } catch (_) { return null; }
}
function noiseSound(dur, freq, vol, pos) {
  if (BF.audio) return; // js/audio.js plays these through events
  const ac = audio(); if (!ac) return;
  let v = vol;
  if (pos && playerAlive()) { const d = seen(pos, player().position, _sA).distanceTo(pos); v *= Math.max(0, 1 - d / 24); }
  if (v <= 0.01) return;
  try {
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const filt = ac.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = freq;
    const g = ac.createGain(); g.gain.setValueAtTime(v, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    src.connect(filt); filt.connect(g); g.connect(ac.destination);
    src.start(); src.stop(ac.currentTime + dur);
  } catch (_) {}
}

// ---------- creation / removal ----------
function styleAt(x, z) {
  let name = "";
  try { const b = BF.worldgen && BF.worldgen.biomeAt ? BF.worldgen.biomeAt(x, z) : null; name = (b && b.name) || ""; } catch (_) {}
  if (/desert|badland|mesa/i.test(name)) return 1;
  if (/snow|frozen|ice/i.test(name)) return 2;
  if (/savanna/i.test(name)) return 3;
  if (/taiga/i.test(name)) return 4;
  return 0;
}
// One object layout for every mob (r15-50 follow-up). V8 keeps an object's properties in fixed slots only while it has few enough of them
// added one by one; mobs used to be built by copying a literal key by key (js/ids.js refs) and then gain fields as jobs, pens, breeding
// and the region index needed them, so every mob ended up in V8's slow dictionary mode and each property read in the mob loop was a
// hash lookup. Now a mob (and its ai table) is made by a constructor that creates every field below, undefined, in this order: one
// fast layout for all of them. undefined fields are left out of saves, snapshots and the world hash just like missing ones. A new
// field set on mobs belongs in MOB_FIELDS (AI_FIELDS for m.ai); test/mob-shape.js checks the layout and names any field missing here.
const MOB_FIELDS = [
  // made by createMob's own fields (raw link fields: js/ids.js)
  "type", "hostile", "def", "variant", "profession", "style", "tradingWithId", "level", "badgeLevel", "villageId", "homeKey", "tradeCd", "position",
  "vel", "prev", "hp", "maxHp", "halfWidth", "height", "look", "scale", "headScale", "partVis", "tint", "held", "onFire", "crackStage", "yaw", "headYaw",
  "headPitch", "lookAtId", "lookV", "walkPhase", "walkAmt", "onGround", "inWater", "headInWater", "fallStart", "hurtT", "invuln", "knockT", "dead",
  "deathT", "removed", "ai", "age", "rng",
  // set later by the game's systems
  "id", "xp", "trades", "inv", "life", "restockDay", "_res", "_rs", "_ri", "slotKey", "bedKey", "jobStocked", "jobsite", "onLadder", "starving",
  "_agePass", "_ageT", "vname", "priceDay", "store", "fshop", "eggc", "job", "idleT", "tsm", "farm", "flt", "cshop", "bs", "kitFor", "vtask", "ex",
  "fo", "shp", "pkp", "pgk", "pgc", "stb", "furn", "mi", "mc", "bkr", "beeKit", "bkp", "patrol", "_farT", "mateId", "cow", "calf", "_k", "wildB",
  "pig", "piglet", "hen", "chick", "sheep", "penKey", "penVillageId", "_shorn", "lamb", "coopKey", "styKey", "horse", "kind", "ctl", "escrow",
  "asks", "cart", "mateT", "furnWork", "mateSeek", "eatenTotal", "lastMealFx", "loveId", "breedDay", "bred", "bredKey", "child", "growing", "parents", "_swT",
  "wob", "lastHurt", "homeBedKey", "sleeping", "restored", "attackerId", "attackedAt", "boatCd", "jobPrefer", "cowKit", "cwk", "cwc", "gls", "crumb",
  "penIn", "atOut", "fall", "jobMem", "seek", "exploded", "vdenied", "vanon", "local", "otherId", "sellerId", "goalSellerId", "ledById", "ridingId",
  "pastureKey", "exitKey",
  "cl"];   // the mob's cluster (js/clusters.js, spec r15-39b): set when made, moved only at a meeting
const AI_FIELDS = [
  "t", "mode", "tx", "tz", "fleeT", "target", "losT", "los", "attackCd", "shootCd", "fuse", "strafe", "lookT", "swingT", "provoked", "burnT", "aiming",
  "leaving", "zScanT", "threat", "night", "held", "blockedT", "route", "ri", "stuckT", "routeKind", "doors", "leaveTries", "leaveEnd", "outT",
  "wanderAt", "hScanT", "rescueId", "revengeId", "foeId", "golemFoeT", "gScanT", "golemFoeId", "vScanT", "vTargetId", "doorT", "doorAt", "detour",
  "fleeJitter", "gLos", "was", "planW", "planL", "planG"];
// The constructors: named stores (the only way V8 sizes an object for all of them), generated from the lists; js/ids.js Refs is the
// prototype, so the link accessors (m.village, m.ai.foe...) work as on any refs() record and BF.ids.refs passes these through.
const shapeOf = fields => { const C = new Function(fields.map(k => "this." + k + " = undefined;").join("\n")); C.prototype = BF.ids.Refs; return C; };
const MobShape = shapeOf(MOB_FIELDS), AiShape = shapeOf(AI_FIELDS);
// A new object of that layout holding o's fields (link names go through their accessors, as in BF.ids.refs).
function fill(o, C) { const n = new C(); for (const k of Object.keys(o)) n[k] = o[k]; return n; }
// An ai table brought back from a snapshot (js/mobsave.js apply) in a new mob's layout.
const shapeAi = a => fill(a, AiShape);
function createMob(type, x, y, z, variant, style) {
  const T = TYPES[type];
  if (!T) return null;
  const st = {}, r = R(st);   // the new mob's stream, seeded from the creation counter; it becomes the mob's own below (rng)
  if (T.variants) {
    variant = PROF_ALIAS[variant] || variant;
    if (!T.variants.includes(variant)) variant = T.variants[Math.floor(r.next() * T.variants.length)];
    if (typeof style === "string") style = VILLAGE_STYLES.indexOf(style);
    if (!(style >= 0 && style <= 4)) style = styleAt(x, z);
  }
  const yaw = r.next() * Math.PI * 2 - Math.PI;
  const mob = fill({   // links to other mobs, the village and its places are ids (js/ids.js, spec r15-13)
    type, hostile: T.hostile, def: T, variant: T.variants ? variant : null, profession: T.variants ? variant : undefined,
    style: T.variants ? VILLAGE_STYLES[style] : undefined, tradingWith: null, level: T.variants ? 1 : undefined, badgeLevel: 0,
    village: null, home: null, tradeCd: 0,
    position: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), prev: null,   // plain maths objects: js/mobview.js draws the mob from these fields (between prev and cur, r15-10)
    hp: T.hp, maxHp: T.hp, halfWidth: T.hw, height: T.h,
    // how it looks, as data (js/mobview.js): look = the model variant (js/mobview.js typeParts), scale / headScale = its size, partVis =
    // parts shown or hidden by name (a horse's saddle), tint "red" = the hurt / death flash, held = item id of the tool in its hands,
    // onFire = burning in the sun, crackStage = an iron golem's cracks (0-3)
    look: T.variants ? variant + "/" + style : null, scale: 1, headScale: 1, partVis: {}, tint: null, held: null, onFire: false, crackStage: 0,
    yaw, headYaw: 0, headPitch: 0, lookAt: null,
    walkPhase: r.next() * 6, walkAmt: 0,
    onGround: false, inWater: false, headInWater: false, fallStart: y,
    hurtT: 0, invuln: 0, knockT: 0, dead: false, deathT: 0, removed: false,
    ai: fill({ t: rnd(r, 0.5, 3), mode: "idle", tx: x, tz: z, fleeT: 0, target: false, losT: 0, los: false, attackCd: 0,
          shootCd: rnd(r, 1, 2), fuse: 0, strafe: r.next() < 0.5 ? 1 : -1, lookT: 0, swingT: 0, provoked: 0, burnT: 0, aiming: false }, AiShape),
    age: 0, rng: st.rng,
  }, MobShape);
  BF.ids.put(mob);   // mob.id: a new "e<n>" (a villager's saved one comes back with its trading state, js/trading.js unpack)
  if (type === "villager" && BF.trades) BF.trades.init(mob); // level, offers, inventory with starting stock
  keepPrev(mob);
  list.push(mob);
  if (BF.regions) BF.regions.mobAdded(mob);   // the region index (js/regions.js)
  if (BF.ctick && BF.ctick.on) BF.clusters.place(mob);   // its cluster, by where it is made (js/clusters.js)
  return mob;
}

// A mob another worker made (clusters on several workers, js/cworkers.js), in two steps so new mobs can point at each other: blankMob
// puts an empty one of the type under its id in the list; filled(m, o) copies in its fields (o: the other worker's plain copy, links
// already turned back into this world's objects) and indexes it.
function blankMob(type, id) {
  const T = TYPES[type];
  if (!T) return null;
  const mob = new MobShape();
  mob.type = type; mob.def = T; mob.ai = new AiShape(); mob.position = new THREE.Vector3(); mob.vel = new THREE.Vector3(); mob.removed = false;
  BF.ids.put(mob, id);
  list.push(mob);
  return mob;
}
function filledMob(mob, o) {
  for (const k of Object.keys(o)) if (k !== "def" && k !== "type") mob[k] = k === "ai" && o.ai ? fill(o.ai, AiShape) : o[k];
  if (!mob.prev) keepPrev(mob);   // (sent with it: where it started the tick)
  if (BF.regions) BF.regions.mobAdded(mob);
}

function removeMob(m) {
  const i = list.indexOf(m);
  if (i >= 0) list.splice(i, 1);
  if (BF.regions) BF.regions.mobRemoved(m);
  if (m.type === "villager" && !m.dead) { const k = villagerKey(m); if (k && m.inv) villagerSaves.set(k, BF.trades.pack(m)); }
  if (m.sheep && m.sheep.mob === m) m.sheep.mob = null;   // pen sheep keep their state and respawn with the pen (js/shepherd.js)
  if (m.hen && m.hen.mob === m) m.hen.mob = null;   // so do coop chickens (js/poultry.js)
  if (m.cow && m.cow.mob === m) m.cow.mob = null;   // and pasture cows (js/cowherd.js)
  if (m.pig && m.pig.mob === m) m.pig.mob = null;   // and sty pigs (js/pigfarmer.js)
  m.removed = true;
  if (m.riding && BF.boats && BF.boats.onRemoved) BF.boats.onRemoved(m);   // a passenger leaving with its chunk: the boat remembers it
  if (m.bredEntry && BF.breeding && BF.breeding.onRemoved) BF.breeding.onRemoved(m);   // a newborn leaving with its village: its entry keeps its state
  BF.ids.remove(m);
}

// ---------- particles ----------
// A puff of smoke: an effect event (js/fx.js) that js/entityview.js plays.
function puff(pos, n, spread, dark, speed) { BF.fx.emit({ kind: "puff", x: pos.x, y: pos.y, z: pos.z, n, spread, dark: !!dark, speed: speed || 1 }); }

// ---------- damage ----------
// `cause` names what did it for the village log (js/villagelog.js), e.g. "a Zombie"; the player is implied by byPlayer.
// During the think phase (spec r15-23) a hit is a "damage" request from o.from (the attacker; the mob itself for falls and sunlight), applied
// in requester-id order: knockback adds up in that order, the invulnerability a hit leaves refuses the hits after it, and the kill goes to
// the request that took the mob to 0 hp. Returns whether the hit can land (think: the request, if the mob is hittable now; otherwise:
// whether it landed).
// o (optional): {from: attacker mob, force: ignores the mob's invulnerability, lift: vel.y after the hit, foe: a hostile hit turns on the
// attacker (a golem's hit, golemFight), mark: a landed hit on a villager names its attacker (golems come running), a golem's revenge,
// revenge: a golem hit takes revenge on the attacker}
function damageMob(m, amount, knockDir, byPlayer, cause, o) {
  if (!m || m.dead || m.removed || (m.invuln > 0 && !(o && o.force))) return false;
  if (inThink()) {
    return BF.req.send("damage", m.id, { amount, knock: knockDir ? { x: knockDir.x, z: knockDir.z } : null, byPlayer: !!byPlayer, cause: cause || null,
      force: !!(o && o.force), lift: (o && o.lift) || 0, foe: !!(o && o.foe), mark: !!(o && o.mark), revenge: !!(o && o.revenge) },
      o && o.from ? o.from : byPlayer ? "player" : m);   // (the request: truthy)
  }
  return hurtNow(m, amount, knockDir, byPlayer, cause, o && o.from, o);
}
function hurtNow(m, amount, knockDir, byPlayer, cause, by, o) {
  if (!m || m.dead || m.removed) return false;
  if (o && o.force) m.invuln = 0;
  const landed = m.invuln <= 0 && hitNow(m, amount, knockDir, byPlayer, cause);
  if (!o) return landed;
  if (!m.dead && o.lift) m.vel.y = o.lift;
  if (!by || by.removed) return landed;
  if (landed && o.mark) {   // golems come running (villagerInDanger); js/wildlife.js counts zombie attacks per night
    if (m.type === "villager") { m.attacker = by; m.attackedAt = m.age; if (BF.emit) BF.emit("villagerHit", m, by); }
    if (m.def.golem) m.ai.revenge = by;
  }
  if (o.revenge && m.def.golem && !by.dead) m.ai.revenge = by;
  if (o.foe && m.hostile && !m.dead) { m.ai.golemFoe = by; m.ai.golemFoeT = 12; }   // hostiles fight back (golemFight)
  return landed;
}
function hitNow(m, amount, knockDir, byPlayer, cause) {
  if (m.sleeping) wake(m);
  m.hp -= amount;
  m.lastHurt = byPlayer ? "the player" : (cause || "unknown causes");
  m.invuln = 0.45;
  m.hurtT = 0.3;
  if (m.def.golem) m.crackStage = golemCrackLevel(m);   // its cracks (js/mobview.js)
  if (BF.emit) BF.emit("mobHurt", m, amount);
  if (knockDir && !m.def.noKnock) {
    const k = new THREE.Vector3(knockDir.x, 0, knockDir.z);
    if (k.lengthSq() > 1e-6) k.normalize();
    const s = byPlayer ? 6 : 4;
    m.vel.x = k.x * s; m.vel.z = k.z * s;
    m.vel.y = Math.max(m.vel.y, 4.5);
    m.knockT = 0.3;
  }
  if (byPlayer) {
    if (m.hostile) { m.ai.target = true; m.ai.provoked = 30; }
    else if (m.def.golem) m.ai.provoked = creative() ? 0 : 60;
    else m.ai.fleeT = rnd(R(m), 3, 5);
    // hurting a villager or a golem angers the village's golems
    if (m.village && !creative()) { m.village.angryT = 60; for (const g of villageMobs(m.village)) if (g.def.golem) g.ai.provoked = 60; }
  } else if (m.type === "villager") m.ai.fleeT = rnd(R(m), 3, 5);
  if (m.hp <= 0) kill(m, byPlayer);
  return true;
}

function kill(m, byPlayer) {
  m.dead = true;
  m.deathT = 0;
  m.hp = 0;
  m.ai.fuse = 0;
  m.onFire = false;
  if (m.village) m.village.killed[m.type] = (m.village.killed[m.type] || 0) + 1;
  if (m.village && m.type === "villager" && (m.slot || m.bred)) {   // who died, for the record (newborns too: i null); age = game days loaded and active (js/villagelife.js)
    (m.village.deadInfo || (m.village.deadInfo = [])).push({ i: m.bred ? null : m.slot.idx, name: BF.vlog ? BF.vlog.nameOf(m) : null, prof: m.child ? "child" : m.profession || null,
      cause: m.lastHurt || null, day: BF.sky ? +((BF.sky.day || 0) + (BF.sky.time || 0)).toFixed(3) : null, age: m.life ? +(m.life.lived || 0).toFixed(2) : null });
  }
  if (m.type === "villager" && BF.dayTimeline) BF.dayTimeline.drop(m);   // its day timeline goes with it (js/daytimeline.js)
  if (m.village && m.type === "villager" && m.slot && !m.bred) {   // a roster villager: its slot stays empty for good (saved, see exportVillagers)
    deadSlots(m.village).add(m.slot.idx);
    const k = villagerKey(m); if (k) villagerSaves.delete(k);
  }
  if (byPlayer || (m.def.golem && BF.drops)) giveDrops(m);   // a golem drops its iron whatever killed it
  if (BF.emit) BF.emit("mobKilled", m);
}

function giveDrops(m) {
  const inv = BF.inventory;
  if (!inv || typeof inv.add !== "function") return;
  for (const [name, lo, hi] of m.def.drops || []) {
    if (m.type === "sheep" && (m.lamb || (m.sheep && m.sheep.shorn)) && (name === "white_wool" || m.lamb)) continue;   // lambs drop nothing, shorn sheep no wool
    if (m.type === "chicken" && m.chick) continue;   // nor do chicks (js/poultry.js)
    if (m.type === "cow" && m.calf) continue;   // nor do calves (js/cowherd.js)
    if (m.type === "pig" && m.piglet) continue;   // nor do piglets (js/pigfarmer.js)
    const id = (BF.I && BF.I[name] != null) ? BF.I[name] : (BF.B && BF.B[name]);
    if (id == null) continue;
    const n = irnd(R(m), lo, hi);
    if (n <= 0) continue;
    const p = m.pos || m.position;
    if (BF.drops && p) BF.drops.spawn(id, n, p.x, p.y + 0.5, p.z);
    else { try { inv.add(id, n); } catch (e) { console.error(e); } }
  }
}

// ---------- mob-on-mob effects, new mobs and claims as requests (spec r15-23, js/requests.js) ----------
// In the think phase: hits ("damage"), creeper blasts ("explode"), new mobs ("spawn": births, monster spawns, roster respawns) and claims
// on shared places ("claim": beds, jobsites) are requests, applied in requester-id order after every mob has thought. Outside it (the
// player between ticks, commands, tests that call these by hand) they happen at once, as before.
const inThink = () => !!(BF.req && BF.req.phase === "think");
const knockOf = d => d.knock ? new THREE.Vector3(d.knock.x, 0, d.knock.z) : null;
BF.req.on("damage", req => {
  const m = BF.ids.get(req.target), d = req.data, by = req.from && /^e\d+$/.test(req.from) ? BF.ids.get(req.from) : null;
  if (!m || m.dead || m.removed) return { ok: false, why: m && m.dead ? "dead" : "gone" };
  const hp = m.hp, landed = hurtNow(m, d.amount, knockOf(d), d.byPlayer, d.cause, by && by !== m ? by : null, d);
  return landed ? { ok: true, killed: m.dead, hp: m.hp, was: hp } : { ok: false, why: "invulnerable" };
});
// A blast is one request per region it reaches (spec r15-33). The creeper's own region's part applies with the tick's other requests and
// is refused if the creeper died first; it does that region's blocks and mobs, the player, and removes the creeper. The other regions'
// parts are late requests (js/requests.js: applied after every region's inbox, region by region), so they only go ahead once the own
// part has: they never depend on the order the regions apply in.
BF.req.on("explode", req => {
  const d = req.data, m = d.m || BF.ids.get(req.target);
  if (d.late) { if (!m || !m.exploded) return { ok: false, why: "gone" }; }   // the creeper's own part didn't go off
  else if (!m || m.dead || m.removed) return { ok: false, why: "gone" };   // killed (or unloaded) before its fuse ran out
  explodeNow(m, d.at ? d : null);
  return { ok: true };
});
// spawn: data.make() makes the mob (and links it) when the request applies, so ids come in requester order; it returns the mob, or
// null when what it needed is gone (a parent, its bread, the bed).
// data.maker: [name, ...args], the same make (and check) again from plain data, BF.mobs.makers[name](...args) -> [make, check]: another
// worker that files this request has no copy of the sender's make (spec r15-39, js/rworkers.js).
BF.req.on("spawn", req => {
  const d = req.data;
  let make = d.make;
  if (typeof make !== "function" && d.maker) {
    const f = makers[d.maker[0]], mc = f ? f(...d.maker.slice(1)) : null;
    if (mc) make = mc[1] ? () => (mc[1]() ? mc[0]() : null) : mc[0];
  }
  if (typeof make !== "function") return { ok: false, why: "no maker" };
  const m = make();
  return m ? { ok: true, mob: m.id } : { ok: false, why: "refused" };
}, { global: true });   // from the global inbox after the regions (spec r15-33): ids come in requester order over the whole world
const makers = {};
function spawnLater(from, what, make, check, maker) {
  if (!inThink()) return make();
  BF.req.send("spawn", what, { make: check ? () => (check() ? make() : null) : make, maker: maker || null }, from);
  return null;
}
// Claims (BF.claims): kinds register free(m, data) -> null when the claim may be taken, else why not; take(m, data); and
// result(m, ok, data, why) for the claimer once decided. ask(what, m, place, data) is a "claim" request in the think phase (returns
// "pending"; the first valid claim of a place in a tick wins, the others are refused and pick again); otherwise it is decided at once
// (returns true or false). A claim never takes a place from someone holding it: free() checks that at apply time. Game log: DEBUG
// "claims" when a claim loses to one applied before it in the same tick.
const claimKinds = {}, claimWins = new Map();   // place -> [requester, tick] of the claim that took it this tick
function decideClaim(what, m, place, data) {
  const K = claimKinds[what];
  if (!K) return { ok: false, why: "no kind" };
  if (!m || m.dead || m.removed) return { ok: false, why: "gone" };
  const why = K.free(m, data);
  if (why) return { ok: false, why };
  K.take(m, data);
  return { ok: true };
}
BF.req.on("claim", req => {
  const d = req.data, m = BF.ids.get(req.from), r = decideClaim(d.what, m, req.target, d), tick = BF.rand ? BF.rand.tick : 0;
  const won = claimWins.get(req.target);
  if (r.ok) claimWins.set(req.target, [req.from, tick]);
  else if (won && won[1] === tick && BF.glog) BF.glog.log("DEBUG", "claims", (m && BF.vlog && m.type === "villager" ? BF.vlog.nameOf(m) : req.from) + " lost the " + d.what + " at " + req.target + " to " + won[0] + ", who claimed it first this tick", { at: m || undefined });
  if (claimWins.size > 256) claimWins.clear();
  return r;
}, { onResult(m, req, r) { const K = claimKinds[req.data.what]; if (K && K.result) K.result(m, r.ok, req.data, r.why); } });
BF.claims = {
  kind(what, k) { claimKinds[what] = k; },
  ask(what, m, place, data) {
    data = Object.assign({ what }, data);
    if (inThink()) { BF.req.send("claim", place, data, m); return "pending"; }
    const r = decideClaim(what, m, place, data), K = claimKinds[what];
    if (K && K.result && m) K.result(m, r.ok, data, r.why);
    return r.ok;
  },
};

// ---------- creeper explosion ----------
// In the think phase the blast is one "explode" request that does its block changes and its damage together; refused if the creeper died first.
function explode(m) {
  if (!inThink()) { explodeNow(m); return; }
  // one "explode" request per region the blast reaches (its blocks within R, its mobs within 6), applied in region order
  const c = blastCentre(m), G = BF.regions, own = G && G.regionOf ? G.regionOf(m) : undefined;
  const at = { x: c.x, y: c.y, z: c.z }, tick = BF.rand ? BF.rand.tick : 0;
  if (!G || own == null || own < 0) { BF.req.send("explode", m.id, { m, at, tick }, m); return; }
  const keys = G.around(c.x, c.z, BLAST_MOBS + 2);
  BF.req.send("explode", m.id, { m, at, tick, region: own, own }, m);
  for (const k of keys) if (k !== own) BF.req.send("explode", m.id, { m, at, tick, region: k, own, late: true }, m);
}
const BLAST_R = 3, BLAST_MOBS = 6;
const blastCentre = m => new THREE.Vector3(m.position.x, m.position.y + 0.8, m.position.z);
// The blast, whole (outside the think phase) or one region's part of it (part: {at, tick, region, own} from explode above). The cells'
// rolls come from a stream of the blast's cell and tick, so every part rolls the same cells alike.
function explodeNow(m, part) {
  const c = part ? new THREE.Vector3(part.at.x, part.at.y, part.at.z) : blastCentre(m);
  const R = BLAST_R, G = BF.regions, rk = part && part.region != null ? part.region : null;
  const w = BF.world, bedrock = BF.B.bedrock;
  const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z);
  const r = BF.rand.at("explode", cx, cz, part ? part.tick : BF.rand.tick, cy);
  const mine = rk == null ? () => true : (x, y, z) => G.keyOf(x, y, z) === rk;
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > R - r.next() * 0.8) continue;
    const x = cx + dx, y = cy + dy, z = cz + dz;
    if (!mine(x, y, z)) continue;
    const id = w.getBlock(x, y, z);
    if (!id || id === bedrock || isWater(id)) continue;
    w.setBlock(x, y, z, 0);
    if (w.removePartner) w.removePartner(x, y, z, id);
  }
  const own = rk == null || rk === part.own;
  if (own && playerAlive()) {
    const p = player();
    const pc = new THREE.Vector3(p.position.x, p.position.y + (p.height || 1.8) / 2, p.position.z);
    const d = pc.distanceTo(c);
    if (d < 7) {
      const dmg = Math.round(22 * Math.pow(1 - d / 7, 1.3));
      if (dmg > 0 && p.damage) p.damage(dmg, c.clone());
    }
  }
  const blast = L => L.filter(o => o !== m && !o.dead && o.position.distanceTo(c) < BLAST_MOBS && (rk == null || G.regionOf(o) === rk));
  for (const o of vq("mobs.explosion", blast(nearMobs(c, BLAST_MOBS)), blast)) {
    if (o.dead) continue;
    const d = o.position.distanceTo(c);
    damageMob(o, Math.max(1, Math.round(18 * (1 - d / 6))), o.position.clone().sub(c), false, "an explosion");
  }
  if (!own) return;
  puff(c, 26, 1.6, false, 4);
  puff(c, 10, 1.0, true, 3);
  noiseSound(1.2, 500, 0.9, c);
  m.exploded = true;
  if (BF.emit) BF.emit("mobExploded", m, c);
  removeMob(m);
}

// ---------- arrows ----------
// `victim` (optional) is a mob the arrow can hit, e.g. the iron golem a skeleton is fighting.
function shootArrow(m, target, victim) {
  const from = new THREE.Vector3(m.position.x, m.position.y + 1.5, m.position.z);
  const to = target.clone();
  const dist = from.distanceTo(to);
  const speed = 22;
  const t = dist / speed;
  to.y += 0.5 * 20 * t * t; // gravity compensation
  const dir = to.sub(from).normalize();
  dir.x += rnd(R(m), -0.03, 0.03); dir.y += rnd(R(m), -0.03, 0.03); dir.z += rnd(R(m), -0.03, 0.03);
  dir.normalize();
  from.addScaledVector(dir, 0.5);
  arrows.push({ pos: from.clone(), prev: from.clone(), vel: dir.multiplyScalar(speed), look: null, life: 6, stuck: false, owner: m, victim: victim || null });
  noiseSound(0.15, 2500, 0.25, from);
  if (BF.emit) BF.emit("arrowShot", m, from);
}
// Player arrows (js/player.js bow): `vel` in blocks/s, `o` = { damage, crit, pickup } where pickup is 1 (walking over the stuck
// arrow gives it back), 2 (fired in creative: it is just removed) or 0. They hit any living mob as a player attack (BF.mobs.hit:
// knockback, hostiles turn on the player, a hurt villager or golem angers the village's golems), never the player, and stick in
// blocks for 60 s (vanilla); a stuck arrow whose block is broken falls again. Returns the arrow record.
const PLAYER_ARROW_LIFE = 60, ARROW_DRAG = 0.99;   // vanilla: stuck arrows despawn after 1200 ticks; 1% air drag per tick
function shootPlayerArrow(from, vel, o) {
  o = o || {};
  const a = { pos: from.clone(), prev: from.clone(), vel: vel.clone(), look: vel.clone(), life: PLAYER_ARROW_LIFE, stuck: false, owner: null, victim: null,
    byPlayer: true, damage: o.damage || 1, crit: !!o.crit, pickup: o.pickup | 0, cell: null, hit: null };
  arrows.push(a);
  if (BF.emit) BF.emit("arrowShot", null, from);
  return a;
}
// Damage a player arrow deals: its draw damage, plus 1..damage/2 on a critical (full-draw) arrow; so 1..6, a crit 7..9.
const playerArrowDamage = a => a.damage + (a.crit ? irnd(R(a), 1, Math.max(1, a.damage >> 1)) : 0);
function playerArrowStep(a, p) {
  if (a.stuck) {   // stuck: falls when its block goes; walking over it picks it up
    if (!BF.world.isSolid(a.cell[0] + 0.5, a.cell[1] + 0.5, a.cell[2] + 0.5)) { a.stuck = false; a.pos.addScaledVector(a.dir, -0.1); a.vel.set(0, 0, 0); return false; }   // out of the freed cell, then down
    if (!a.pickup || !p) return false;
    const pp = seen(a.pos, p.position, _sA), hw = (p.halfWidth || 0.3) + 0.6, h = p.height || 1.8;
    if (Math.abs(a.pos.x - pp.x) > hw || Math.abs(a.pos.z - pp.z) > hw || a.pos.y < pp.y - 0.6 || a.pos.y > pp.y + h + 0.3) return false;
    if (a.pickup === 1 && BF.inventory && BF.I) { try { if (BF.inventory.add(BF.I.arrow, 1) > 0) return false; } catch (e) { console.error(e); return false; } }   // a full inventory leaves it there
    if (BF.emit) BF.emit("arrowPickedUp", a.pickup === 1);
    return true;
  }
  return false;
}
// Nearest living mob whose AABB the ray hits within maxDist (BF.mobs.raycast).
function raycastIn(L, origin, dir, maxDist, skip) {
  let best = null;
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (const m of L) {
    if (m.dead || m.removed || m === skip) continue;
    const p = seen(origin, m.position, _sA), hw = m.halfWidth, bf = m.bed ? m.bed.f : m.bedF;
    if (m.sleeping && bf != null) {   // lying on the bed (sleepPose): feet at the position, head m.height along the bed's facing
      const [fx, fz] = BF.DIRS[bf], o = m.position;
      _rHead.set(o.x + fx * m.height, o.y, o.z + fz * m.height);
      const h = seen(origin, _rHead, _sB), alongX = Math.abs(h.x - p.x) > Math.abs(h.z - p.z);   // in the ray's frame (a bed over a face edge turns)
      mn[0] = Math.min(p.x, h.x) - (alongX ? 0 : hw); mn[1] = p.y - hw; mn[2] = Math.min(p.z, h.z) - (alongX ? hw : 0);
      mx[0] = Math.max(p.x, h.x) + (alongX ? 0 : hw); mx[1] = p.y + hw; mx[2] = Math.max(p.z, h.z) + (alongX ? hw : 0);
    } else {
      mn[0] = p.x - hw; mn[1] = p.y; mn[2] = p.z - hw;
      mx[0] = p.x + hw; mx[1] = p.y + m.height; mx[2] = p.z + hw;
    }
    const t = rayAABB(origin, dir, mn, mx);
    if (t != null && t <= maxDist && (!best || t < best.dist)) best = { mob: m, dist: t };
  }
  return best;
}
// Living mob whose box holds point q (player arrows).
function mobAt(q) { return vq("mobs.mobAt", mobAtIn(nearMobs(q, 2, true), q), L => mobAtIn(L, q)); }
function mobAtIn(L, q) {
  for (const m of L) {
    if (m.dead || m.removed) continue;
    const vp = seen(q, m.position, _sA), hw = m.halfWidth + 0.1;
    if (Math.abs(q.x - vp.x) < hw && Math.abs(q.z - vp.z) < hw && q.y > vp.y && q.y < vp.y + m.height) return m;
  }
  return null;
}
const _dir = new THREE.Vector3();
function updateArrows(dt) {
  const p = playerAlive() ? player() : null;
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.prev.copy(a.pos);   // drawn between this and where the tick leaves it (js/entityview.js)
    a.life -= dt;
    if (a.life <= 0) { arrows.splice(i, 1); continue; }
    if (a.byPlayer && playerArrowStep(a, p)) { arrows.splice(i, 1); continue; }
    if (a.stuck) continue;
    a.vel.y -= 20 * dt;
    if (a.byPlayer) a.vel.multiplyScalar(Math.pow(ARROW_DRAG, dt * 20));
    const steps = Math.max(1, Math.ceil(a.vel.length() * dt / 0.25));
    let hitPlayer = false;
    for (let s = 0; s < steps; s++) {
      a.pos.addScaledVector(a.vel, dt / steps);
      BF.planet.reframe(a.pos, -1, null, a.vel);   // past a face edge: back on the canonical square, turned
      if (BF.world.isSolid(a.pos.x, a.pos.y, a.pos.z)) {
        if (a.byPlayer) {   // back up and creep in 5 cm steps, so the tip sits just inside the first solid block on the path
          const sp = a.vel.length(), back = sp * dt / steps;
          _dir.copy(a.vel).divideScalar(sp || 1); a.pos.addScaledVector(_dir, -back);
          for (let d = 0; d < back && !BF.world.isSolid(a.pos.x, a.pos.y, a.pos.z); d += 0.05) a.pos.addScaledVector(_dir, 0.05);
          a.cell = [Math.floor(a.pos.x), Math.floor(a.pos.y), Math.floor(a.pos.z)]; a.dir = _dir.clone(); a.life = PLAYER_ARROW_LIFE;
          a.stuck = true;
          if (BF.emit) BF.emit("arrowStuck", a);
          break;
        }
        a.stuck = true; a.life = Math.min(a.life, 3);
        a.pos.addScaledVector(a.vel, -dt / steps * 0.3);
        break;
      }
      if (a.byPlayer) {   // player arrow: hits the first mob it enters, as a player attack
        const m = mobAt(a.pos);
        if (m) {
          const dmg = playerArrowDamage(a);
          a.hit = { mob: m, damage: dmg, landed: !!damageMob(m, dmg, a.vel, true) };   // (in the think phase: the hit is a request, r15-23)
          if (BF.emit) BF.emit("arrowHitMob", m, dmg, a.crit);
          hitPlayer = true;
          break;
        }
        continue;
      }
      const v = a.victim;
      if (v && !v.dead && !v.removed) {
        const vp = seen(a.pos, v.position, _sB), hw = v.halfWidth + 0.1;
        if (Math.abs(a.pos.x - vp.x) < hw && Math.abs(a.pos.z - vp.z) < hw && a.pos.y > vp.y && a.pos.y < vp.y + v.height) {
          const owner = a.owner && !a.owner.removed && !a.owner.dead ? a.owner : null;
          damageMob(v, irnd(R(a), GOLEM_HITS.arrow[0], GOLEM_HITS.arrow[1]), a.vel, false, "a skeleton", { from: owner, revenge: true });
          hitPlayer = true;
          break;
        }
      }
      if (p) {
        const pp = seen(a.pos, p.position, _sB), hw = (p.halfWidth || 0.3) + 0.1, h = p.height || 1.8;
        if (a.pos.x > pp.x - hw && a.pos.x < pp.x + hw && a.pos.z > pp.z - hw && a.pos.z < pp.z + hw && a.pos.y > pp.y && a.pos.y < pp.y + h) {
          if (p.damage) p.damage(irnd(R(a), 2, 4), seen(p.position, a.owner && !a.owner.removed ? a.owner.position : a.pos.clone().sub(a.vel), new THREE.Vector3()).clone());
          hitPlayer = true;
          break;
        }
      }
    }
    if (hitPlayer) { arrows.splice(i, 1); continue; }
    if (!a.stuck) { if (a.look) a.look.copy(a.vel); else a.look = a.vel.clone(); }   // the way it points (drawn by js/entityview.js)
  }
}

// ---------- AI helpers ----------
function hasLineOfSight(m, target) {
  const from = new THREE.Vector3(m.position.x, m.position.y + m.height * 0.85, m.position.z);
  const dir = target.clone().sub(from);
  const dist = dir.length();
  if (dist < 0.01) return true;
  dir.divideScalar(dist);
  const hit = BF.world.raycast(from, dir, dist);
  return !hit || hit.dist >= dist - 0.3;
}
function dropAhead(m, dx, dz) {
  const x = m.position.x + dx * (m.halfWidth + 0.6), z = m.position.z + dz * (m.halfWidth + 0.6);
  const y0 = Math.floor(m.position.y);
  for (let k = 0; k <= 4; k++) if (BF.world.isSolid(x, y0 - 1 - k, z) || BF.world.isSolid(x, y0 - k, z)) return k;
  return 5;
}
// Roofs and treetops (bug-063, bug-064): villagers, golems and animals never step, jump or walk onto an open-sky roof ledge (a built block
// with a gap under it, or leaves) two or more blocks above the natural ground there. They used to climb hay bales onto low eaves, or walk
// onto a roof level with a hillside, and spend the day up there.
// A villager following a planned route (stairs, ladders, a raised path) still goes wherever its route goes. x, y, z: the mob's feet after
// the climb; hw: its half width (a horse can stand on a ledge with its middle over air).
let naturalTop = null;
const leaves = new Set();
function roofLedge(x, y, z, hw) {
  if (!naturalTop) {
    naturalTop = new Set();
    for (const n of Object.keys(BF.B)) if (/_leaves$/.test(n)) leaves.add(BF.B[n]);
    for (const n of Object.keys(BF.B)) if (/^(grass|dirt|dirt_path|stone|sand|red_sand|sandstone|red_sandstone|gravel|snow|snow_grass|snow_block|ice|packed_ice|clay|farmland|farmland_dry|coarse_dirt|podzol|mycelium|mud|moss_block|granite|diorite|andesite|deepslate|tuff|calcite|bedrock)$|_ore$|terracotta/.test(n)) naturalTop.add(BF.B[n]);
  }
  const W = BF.world, fy = Math.floor(y + 1e-3), seen = new Set();
  for (const dx of [-hw + 0.02, 0, hw - 0.02]) for (const dz of [-hw + 0.02, 0, hw - 0.02]) {
    const bx = Math.floor(x + dx), bz = Math.floor(z + dz), k = bx + "," + bz;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!W.isSolid(bx, fy - 1, bz) || naturalTop.has(W.getBlock(bx, fy - 1, bz))) continue;
    if (W.heightAt(bx, bz) >= fy) continue;   // something over it: a floor indoors, not a roof
    const gy = BF.worldgen.heightAt(bx, bz), id = W.getBlock(bx, fy - 1, bz);
    if (fy - gy < 3) continue;
    if (leaves.has(id)) return true;
    // a roof (an eave, a roof step over the room below) has a gap under it; a foundation, a wall or a stack of hay is solid down to the
    // ground, and a bridge deck has the river under it
    let gap = false;
    for (let yy = fy - 2; yy > gy; yy--) {
      const b = W.getBlock(bx, yy, bz);
      if (isWater(b)) { gap = false; break; }
      if (!W.isSolid(bx, yy, bz)) gap = true;
    }
    if (gap) return true;
  }
  return false;
}
// Whether the mob keeps off roofs (roofLedge): everything that walks except monsters (spiders climb walls anyway).
const keepsOffRoofs = m => !m.def.hostile && !m.def.climbs && !(m.ai && m.ai.route) && !m.onLadder && !(m.horse && m.horse.lead);   // a led horse goes where it is led
function waterAhead(m, dx, dz) {
  const x = m.position.x + dx * (m.halfWidth + 0.6), z = m.position.z + dz * (m.halfWidth + 0.6);
  const y0 = Math.floor(m.position.y);
  return isWater(BF.world.getBlock(x, y0, z)) || isWater(BF.world.getBlock(x, y0 - 1, z));
}
function pickWander(m, r) {
  if (m.pen && BF.shepherd && BF.shepherd.pickPenTarget(m)) return;   // penned sheep wander inside their pen (js/shepherd.js)
  if (m.coop && BF.poultry && BF.poultry.pickCoopTarget(m)) return;   // coop chickens wander inside their run (js/poultry.js)
  if (m.pasture && BF.cowherd && BF.cowherd.pickPastureTarget(m)) return;   // pasture cows graze inside the pasture (js/cowherd.js)
  if (m.sty && BF.pigFarmer && BF.pigFarmer.pickStyTarget(m)) return;   // sty pigs root about inside the sty (js/pigfarmer.js)
  if (m.horse && m.horse.pen && BF.stables && BF.stables.pickPenTarget(m)) return;   // paddock horses wander inside the paddock (js/stables.js)
  const a =R(m).next() * Math.PI * 2, d = rnd(R(m), 3, r);
  m.ai.tx = m.position.x + Math.cos(a) * d;
  m.ai.tz = m.position.z + Math.sin(a) * d;
}

// Getting past what blocks a walk (village mobs: villagers and golems). Walks to a point (wanderAI: heading home from far off, a golem's
// patrol) go straight at it, so a tree, a wall or a ledge too low to jump under would hold them there for good. Blocked for a moment,
// it finds a route round it (A*, up to DETOUR_HOP blocks towards the point; three blocks high for a golem), and with none it steps
// aside for a few seconds. Being held in one place for STUCK_LOG seconds of pushing goes in the game log.
const DETOUR_AFTER = 1.2, DETOUR_HOP = 16, STUCK_LOG = 30;
function moveLog(m, level, text) {
  if (!BF.glog) return;
  const who = BF.vlog && m.type === "villager" ? BF.vlog.nameOf(m) + " (" + BF.vlog.pretty(m.profession || "villager") + ")" : "An " + m.type.replace(/_/g, " ");   // "Name (Job)" as in the village log
  BF.glog.log(level, "move", who + " " + text, { village: m.village, at: m });
}
// Called every physics step: `blocked` = it wanted to move and a block stopped it.
function blockedMove(m, dt, blocked) {
  const ai = m.ai, p = m.position, g = ai.held || (ai.held = { x: p.x, z: p.z, t: 0, logged: false });
  if (Math.hypot(p.x - g.x, p.z - g.z) > 3) {   // got somewhere
    if (g.logged) moveLog(m, "INFO", "got moving again at " + Math.floor(p.x) + ", " + Math.floor(p.y) + ", " + Math.floor(p.z));
    g.x = p.x; g.z = p.z; g.t = 0; g.logged = false;
  } else if (blocked && (g.t += dt) >= STUCK_LOG && !g.logged) {
    g.logged = true;
    moveLog(m, "ERROR", "stuck at " + Math.floor(p.x) + ", " + Math.floor(p.y) + ", " + Math.floor(p.z) + " for " + STUCK_LOG + " s" + (ai.mode === "walk" ? " walking towards " + Math.floor(ai.tx) + ", " + Math.floor(ai.tz) : ""));
  }
  ai.blockedT = blocked ? (ai.blockedT || 0) + dt : 0;
}
// False when this frame's A* searches are used up (busy villages): it tries again next frame instead of stepping aside at random.
function startDetour(m) {
  const ai = m.ai, px = m.position.x, pz = m.position.z, dx = ai.tx - px, dz = ai.tz - pz, d = Math.hypot(dx, dz) || 1;
  if (!takePlan()) return false;
  ai.blockedT = 0;
  const k = Math.min(1, DETOUR_HOP / d), hx = Math.floor(px + dx * k), hz = Math.floor(pz + dz * k), [fx, fy, fz] = feetCell(m);
  const route = findPath(fx, fy, fz, { x: hx, z: hz, at: (x, y, z) => Math.abs(x - hx) + Math.abs(z - hz) <= 2 }, 1500, m.height > 2);
  if (route && route.length) ai.detour = { route, ri: 0, stuckT: 0 };
  else aside(m);
  return true;
}
function aside(m) {
  const ai = m.ai, px = m.position.x, pz = m.position.z, a = Math.atan2(ai.tz - pz, ai.tx - px) + (R(m).next() < 0.5 ? 1 : -1) * (Math.PI / 2 + rnd(R(m), -0.5, 0.5));
  ai.detour = { x: px + Math.cos(a) * 5, z: pz + Math.sin(a) * 5, t: rnd(R(m), 2, 4) };
}
// Steers along a detour; false once it is over (reached, timed out, or the route itself got stuck).
function followDetour(m, dt, out, sp) {
  const D = m.ai.detour;
  if (D.route) {
    const r = followRoute(m, dt, out, sp, D);
    if (r === "stuck") { m.ai.detour = null; aside(m); return followDetour(m, dt, out, sp); }   // the route did not fit after all: try from somewhere else
    return r === "going";
  }
  const dx = D.x - m.position.x, dz = D.z - m.position.z, d = Math.hypot(dx, dz);
  if ((D.t -= dt) <= 0 || d < 0.6) return false;
  out.x = dx / d * sp; out.z = dz / d * sp;
  return true;
}

// Sets out.x/out.z to the desired horizontal velocity; sets m.lookAt.
function wanderAI(m, dt, out) {
  const ai = m.ai, T = m.def;
  if (ai.detour && (ai.mode !== "walk" || m.age - (ai.wanderAt || 0) > 0.5)) ai.detour = null;   // a detour is for the walk it was made for
  ai.wanderAt = m.age;
  ai.t -= dt;
  if (ai.t <= 0) {
    if (ai.mode === "idle" && R(m).next() < 0.6) { ai.mode = "walk"; pickWander(m, 8); ai.t = rnd(R(m), 3, 7); }
    else { ai.mode = "idle"; ai.t = rnd(R(m), 2, 6); }
  }
  ai.lookT -= dt;
  if (ai.lookT <= 0) {
    ai.lookT = rnd(R(m), 1.5, 4);
    if (playerAlive() && pAt(m).distanceTo(m.position) < 8 && R(m).next() < 0.6) m.lookAt = "player";
    else m.lookAt = { yaw: rnd(R(m), -1, 1), pitch: rnd(R(m), -0.4, 0.3) };
  }
  if (ai.mode === "walk") {
    const sp = T.hostile ? T.speed * 0.4 : T.speed;
    if (ai.detour) { if (followDetour(m, dt, out, sp)) return; ai.detour = null; }
    const dx = ai.tx - m.position.x, dz = ai.tz - m.position.z, d = Math.hypot(dx, dz);
    if (d < 0.6) { ai.mode = "idle"; ai.t = rnd(R(m), 2, 5); return; }
    const nx = dx / d, nz = dz / d;
    if (!m.inWater && (dropAhead(m, nx, nz) > 3 || (!T.hostile && waterAhead(m, nx, nz)))) { ai.mode = "idle"; ai.t = rnd(R(m), 1, 3); return; }
    if (T.village && ai.blockedT > DETOUR_AFTER && startDetour(m)) { if (followDetour(m, dt, out, sp)) return; ai.detour = null; }
    out.x = nx * sp; out.z = nz * sp;
  }
}

function hostileAI(m, dt, out) {
  const ai = m.ai, T = m.def;
  const p = playerAlive() && !creative() && !(BF.player && BF.player.hiddenInTent) ? player() : null;   // asleep in a tent: unseen
  ai.aiming = false;
  if (golemFight(m, dt, out)) { ai.fuse = 0; return; }
  if (!p) { ai.target = false; ai.fuse = Math.max(0, ai.fuse - dt); if (!zombieHuntVillagers(m, dt, out)) wanderAI(m, dt, out); return; }
  const pp = pAt(m), eye = seen(m.position, p.eyePos ? p.eyePos() : new THREE.Vector3(p.position.x, p.position.y + 1.6, p.position.z), _sEye);   // (seen from the mob's frame)
  const dx = pp.x - m.position.x, dz = pp.z - m.position.z, dy = pp.y - m.position.y;
  const hd = Math.hypot(dx, dz), dist = Math.hypot(hd, dy);
  ai.losT -= dt;
  if (ai.losT <= 0) { ai.losT = rnd(R(m), 0.25, 0.4); ai.los = dist < 24 && hasLineOfSight(m, eye); }
  ai.provoked = Math.max(0, ai.provoked - dt);
  // spiders are neutral in bright light unless provoked
  const calm = m.type === "spider" && ai.provoked <= 0 && skyLight() * skyAt(m.position.x, m.position.y + 0.5, m.position.z).factor > 0.6;
  if (!calm && dist < 16 && ai.los) ai.target = true;
  if (dist > 28 || calm) ai.target = false;
  if (!ai.target) { ai.fuse = Math.max(0, ai.fuse - dt); if (!zombieHuntVillagers(m, dt, out)) wanderAI(m, dt, out); return; }

  m.lookAt = "player";
  out.faceTarget = true;
  const nx = hd > 0.01 ? dx / hd : 0, nz = hd > 0.01 ? dz / hd : 0;
  ai.attackCd -= dt;
  const reach = m.halfWidth + (p.halfWidth || 0.3) + 0.55;

  if (m.type === "creeper") {
    if (dist < 3 && ai.los) {
      if (ai.fuse === 0) noiseSound(1.5, 1800, 0.35, m.position);
      ai.fuse += dt;
    } else if (dist > 6 || !ai.los) ai.fuse = Math.max(0, ai.fuse - dt);
    else if (ai.fuse > 0) ai.fuse += dt; // once lit, keeps hissing unless you run
    if (ai.fuse <= 0 && hd > 1.2) { out.x = nx * T.speed; out.z = nz * T.speed; }
    if (ai.fuse >= 1.5) explode(m);
    return;
  }

  if (m.type === "skeleton") {
    let sp = 0, sx = 0, sz = 0;
    if (dist > 11 || !ai.los) { sx = nx; sz = nz; sp = T.speed; }
    else if (dist < 5) { sx = -nx; sz = -nz; sp = T.speed * 0.8; }
    else { sx = -nz * ai.strafe; sz = nx * ai.strafe; sp = T.speed * 0.4; if (R(m).next() < dt * 0.3) ai.strafe *= -1; }
    if (sp && !m.inWater && dropAhead(m, sx, sz) > 3) sp = 0;
    out.x = sx * sp; out.z = sz * sp;
    ai.shootCd -= dt;
    ai.aiming = ai.los && dist < 16;
    if (ai.aiming && ai.shootCd <= 0) {
      ai.shootCd = rnd(R(m), 1.6, 2.4);
      shootArrow(m, new THREE.Vector3(pp.x, pp.y + (p.height || 1.8) * 0.6, pp.z));
    }
    return;
  }

  // melee: zombie, spider
  if (hd > reach * 0.8) { out.x = nx * T.speed; out.z = nz * T.speed; }
  if (m.type === "spider" && m.onGround && hd > 2 && hd < 4 && ai.attackCd <= 0 && R(m).next() < dt * 2) {
    m.vel.y = 5.5; m.vel.x = nx * 6; m.vel.z = nz * 6; m.knockT = 0.4; // pounce
  }
  if (hd < reach && Math.abs(dy + (p.height || 1.8) / 2 - m.height / 2) < 1.6 && ai.attackCd <= 0) {
    ai.attackCd = 1.0;
    ai.swingT = 0.35;
    if (p.damage) p.damage(T.attack || 2, seen(p.position, m.position, new THREE.Vector3()).clone());
  }
}

// ---------- region queries (spec r15-31) ----------
// A scan for mobs near a point looks only at the mobs the region index has within r blocks of it across the ground
// (BF.regions.mobsAround, dying mobs included; whole list without the index or past QR_MAX), and keeps its own exact test over them,
// so the answer is the same, in the same order. local: measured through a face edge, for scans that use seen() / mdist.
const QR_MAX = 1024, LOCAL = { local: true };
function nearMobs(p, r, local) {
  const R = BF.regions;
  return R && R.mobsAround && r <= QR_MAX ? R.mobsAround(p.x, p.z, r, null, local ? LOCAL : null) : list;
}
// With BF.regions.verifyQueries on (tests) a converted scan runs over the whole list too, and BF.regions counts and logs a different
// answer. `scan` is the scan taking a list.
const qNorm = x => (Array.isArray(x) ? x : x == null ? [] : [x && x.mob ? x.mob : x]);
function vq(label, got, scan) {
  const R = BF.regions;
  if (R && R.verifyQueries && R.checkQuery) R.checkQuery(label, qNorm(got), () => qNorm(scan(list)));
  return got;
}
// A village's mobs (BF.regions.villageMobs: its members), and the mobs of one type (a copy), both in list order.
const villageMobs = V => (BF.regions && BF.regions.villageMobs ? BF.regions.villageMobs(V) : list.filter(o => o.village === V));
const ofType = t => (BF.regions && BF.regions.ofType ? BF.regions.ofType(t).slice() : list.filter(o => o.type === t));
// Finds the nearest living mob matching pred within r blocks (horizontal + vertical box).
function nearestMob(m, r, pred) {
  let best = null, bd = r;
  if (r <= 32 && chunkCells) {   // only the 16-block cells within r (the grid is rebuilt every update)
    const gx = Math.floor(m.position.x / 16), gz = Math.floor(m.position.z / 16), n = Math.ceil(r / 16);
    const plain = gridFast && inSquare(m.position.x, m.position.z, GRID_EDGE);
    for (let cz = gz - n; cz <= gz + n; cz++) for (let cx = gx - n; cx <= gx + n; cx++) {
      const cell = chunkGrid.get(plain ? sepKey(cx, cz) : gridKey(cx, cz, 16));
      if (cell) for (let i = 0; i < cell.n; i++) {
        const o = cell.a[i];
        if (o === m || o.dead || o.removed || !pred(o)) continue;
        const d = mdist(m, o);
        if (d < bd) { bd = d; best = o; }
      }
    }
    return best;
  }
  return vq("mobs.nearestMob", nearestIn(nearMobs(m.position, r, true), m, r, pred), L => nearestIn(L, m, r, pred));
}
function nearestIn(L, m, r, pred) {
  let best = null, bd = r;
  for (const o of L) {
    if (o === m || o.dead || o.removed || !pred(o)) continue;
    const d = mdist(m, o);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
// Walks toward another mob and hits it in melee range. Returns false if the target is gone.
function chaseAndHit(m, o, dt, out, dmg, cd, speed) {
  const ai = m.ai, T = m.def;
  if (!o || o.dead || o.removed) return false;
  const op = seen(m.position, o.position, _sA), dx = op.x - m.position.x, dz = op.z - m.position.z, hd = Math.hypot(dx, dz);
  const nx = hd > 0.01 ? dx / hd : 0, nz = hd > 0.01 ? dz / hd : 0;
  const reach = m.halfWidth + o.halfWidth + 0.55;
  const sp = speed || T.speed;
  if (hd > reach * 0.8) { out.x = nx * sp; out.z = nz * sp; }
  out.faceX = op.x; out.faceZ = op.z;
  m.lookAt = o;
  ai.attackCd -= dt;
  if (hd < reach && Math.abs(op.y - m.position.y) < 1.6 && ai.attackCd <= 0) {
    ai.attackCd = cd;
    ai.swingT = 0.35;
    strike(m, o, dmg, new THREE.Vector3(nx, 0, nz));
  }
  return true;
}
// m's melee hit on o: a golem's hit ignores o's invulnerability, throws it up and turns a hostile on the golem; another mob's landed hit
// marks a villager as attacked (golems come running) and gives a golem its revenge. In the think phase it is a "damage" request (r15-23).
function strike(m, o, dmg, k, by) {
  by = by || "a" + (/^[aeiou]/i.test(m.type) ? "n " : " ") + m.type.replace(/_/g, " ");
  return m.def.golem ? damageMob(o, dmg, k, false, by, { from: m, force: true, lift: 8, foe: true }) : damageMob(o, dmg, k, false, by, { from: m, mark: true });
}
// ---------- golems vs hostiles ----------
// Golems sprint to any villager under attack within RESCUE_RANGE; hostile mobs hurt golems with GOLEM_HITS.
const RESCUE_RANGE = 64, RESCUE_SPEED = 6.0;
const GOLEM_HITS = { zombie: 4, spider: 3, arrow: [3, 5] };
// A villager is under attack when a mob hit it in the last 6 s, or a zombie hunting it is within 6 blocks.
// Returns the nearest such attacker to golem g (only its own village's villagers when it has a village).
// The attacker is within RESCUE_RANGE; the villager it hit is looked for RESCUE_RANGE further out (it was hit up to 6 s ago, maybe by an arrow).
function villagerInDanger(g) { return vq("mobs.villagerInDanger", dangerIn(nearMobs(g.position, 2 * RESCUE_RANGE, true), g), L => dangerIn(L, g)); }
function dangerIn(L, g) {
  let best = null, bd = RESCUE_RANGE;
  const consider = (v, h) => {
    if (!h || h.dead || h.removed || !h.hostile) return;
    if (g.village && v.village && v.village !== g.village) return;
    const d = mdist(g, h);
    if (d < bd) { bd = d; best = h; }
  };
  for (const o of L) {
    if (o.dead || o.removed) continue;
    if (o.type === "villager" && o.attacker && o.age - o.attackedAt < 6) consider(o, o.attacker);
    else if (o.type === "zombie" && o.ai.vTarget && !o.ai.vTarget.dead && mdist(o, o.ai.vTarget) < 6) consider(o.ai.vTarget, o);
  }
  return best;
}
// Hostiles fight a golem that hit them (for 12 s, even over the player), and zombies, spiders and skeletons that aren't
// chasing the player pick a fight with a golem within 10 blocks (zombies leave a villager for it). Creepers ignore golems. Returns true when it set this frame's movement.
function golemFight(m, dt, out) {
  const ai = m.ai, T = m.def;
  if (m.type === "creeper") return false;
  ai.golemFoeT = (ai.golemFoeT || 0) - dt;
  if (!ai.target) {
    ai.gScanT = (ai.gScanT || 0) - dt;
    if (ai.gScanT <= 0) {
      ai.gScanT = 0.8;
      const calm = m.type === "spider" && skyLight() * skyAt(m.position.x, m.position.y + 0.5, m.position.z).factor > 0.6;
      const g = calm ? null : nearestMob(m, 10, o => o.def.golem);
      if (g && ai.golemFoeT <= 0) { ai.golemFoe = g; ai.golemFoeT = 6; }
    }
  }
  const g = ai.golemFoe;
  if (!g || g.dead || g.removed || ai.golemFoeT <= 0 || mdist(m, g) > 24) { ai.golemFoe = null; return false; }
  if (m.type === "skeleton") {
    const gp = seen(m.position, g.position, new THREE.Vector3()), dx = gp.x - m.position.x, dz = gp.z - m.position.z, d = Math.hypot(dx, dz);
    const nx = dx / (d || 1), nz = dz / (d || 1);
    const chest = new THREE.Vector3(gp.x, gp.y + g.height * 0.6, gp.z);
    ai.losT -= dt;
    if (ai.losT <= 0) { ai.losT = rnd(R(m), 0.25, 0.4); ai.gLos = hasLineOfSight(m, chest); }
    let sp = 0;
    if (d > 12 || !ai.gLos) sp = T.speed; else if (d < 6) sp = -T.speed * 0.8;
    if (sp && !m.inWater && dropAhead(m, nx * Math.sign(sp), nz * Math.sign(sp)) > 3) sp = 0;
    out.x = nx * sp; out.z = nz * sp;
    out.faceX = gp.x; out.faceZ = gp.z; m.lookAt = g;
    ai.shootCd -= dt;
    ai.aiming = ai.gLos && d < 16;
    if (ai.aiming && ai.shootCd <= 0) { ai.shootCd = rnd(R(m), 1.6, 2.4); shootArrow(m, chest, g); }
    return true;
  }
  return chaseAndHit(m, g, dt, out, GOLEM_HITS[m.type] || T.attack || 2, 1.0);
}

function zombieHuntVillagers(m, dt, out) {
  if (m.type !== "zombie") return false;
  const ai = m.ai;
  ai.vScanT = (ai.vScanT || 0) - dt;
  if (ai.vScanT <= 0) { ai.vScanT = 0.6; ai.vTarget = nearestMob(m, 16, o => o.type === "villager" && !(BF.tents && BF.tents.hidden(o))); }
  if (ai.vTarget && chaseAndHit(m, ai.vTarget, dt, out, 3, 1.0)) return true;
  ai.vTarget = null;
  return false;
}

// Zombies with a target that stay pressed against a closed door for 3 s break it (both halves, one door of its wood drops).
function zombieBreakDoor(m, dt, out) {
  const ai = m.ai, W = BF.world;
  let hit = null;
  if ((ai.target || ai.vTarget) && !creative() && (out.x || out.z)) {
    const l = Math.hypot(out.x, out.z), d = m.halfWidth + 0.4;
    const y = Math.floor(m.position.y + 0.1);
    scan: for (const k of [0, d]) for (const dy of [0, 1]) {
      const x = Math.floor(m.position.x + out.x / l * k), z = Math.floor(m.position.z + out.z / l * k);
      const b = BF.blocks[W.getBlock(x, y + dy, z)];
      if (b && b.door && !b.door.open) { hit = [x, y + dy - (b.door.upper ? 1 : 0), z]; break scan; }
    }
  }
  if (!hit) { ai.doorT = 0; ai.doorAt = null; return; }
  if (!ai.doorAt || ai.doorAt.join() !== hit.join()) { ai.doorAt = hit; ai.doorT = 0; }
  ai.doorT += dt;
  if (ai.doorT < 3) return;
  const id = W.getBlock(hit[0], hit[1], hit[2]);
  ai.doorT = 0; ai.doorAt = null;
  if (!BF.blocks[id].door) return;
  // a request (spec r15-19, js/blockreqs.js): refused when the door was opened, shut by someone else or broken first this tick
  BF.req.send("doorBreak", hit.join(","), { expect: id }, m).then(r => {
    if (!r.ok || m.removed) return;
    noiseSound(0.4, 300, 0.3, m.position);
    if (BF.emit) BF.emit("doorBroken", m, hit[0], hit[1], hit[2]);
  });
}

// ---------- villager nights: walk home along a grid path, open doors on the way, sleep in their bed ----------
const bedtime = () => { const t = BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.3; return t > 0.5 && t < 0.985; };   // villagers head in at sunset, well before monsters can spawn (js/mobs.js)
const blockAt = (x, y, z) => BF.blocks[BF.world.getBlock(x, y, z)] || BF.blocks[0];
function bedOK(bed) {
  if (!bed) return false;   // no bed (a sleeper's bed taken away): not usable, rather than a throw that removes the villager
  const k = blockAt(bed.x, bed.y, bed.z);
  if (bed.tent) return !!(k.tent && k.tent.r === 0 && k.tent.l === 1 && !k.tent.up && k.tent.f === bed.f);   // an explorer's tent: its foot centre cell (js/tents.js)
  const b = k.bed; return !!(b && !b.head && b.f === bed.f);
}
// A cell a villager can stand in: solid floor (not a bed/door/fence top), feet and head free or a door it can open.
function walkCell(x, y, z) {
  const W = BF.world;
  if (!W.isLoaded(x, z) || y < BF.MIN_Y + 1 || y + 2 >= BF.H) return false;
  const fl = blockAt(x, y - 1, z), feet = blockAt(x, y, z), head = blockAt(x, y + 1, z);
  if (!fl.solid || fl.door || fl.bed || fl.model === "fence") return false;
  return (!feet.solid || !!feet.door || !!feet.gate) && (!head.solid || !!head.door) && feet.render !== "liquid";
}
// A ladder cell a villager can hang in: a ladder at the feet and room for the head. Only for route planning; standing spots stay walkCell.
const ladderAt = (x, y, z) => !!blockAt(x, y, z).ladder;
function ladderCell(x, y, z) {
  if (!BF.world.isLoaded(x, z) || y < BF.MIN_Y + 1 || y + 2 >= BF.H || !ladderAt(x, y, z)) return false;
  const head = blockAt(x, y + 1, z);
  return !head.solid || !!head.door;
}
const navCell = (x, y, z) => walkCell(x, y, z) || ladderCell(x, y, z);
// A* over walkable cells (4-way, step up 1, drop up to 3, straight up/down ladders). goal(x, y, z) -> bool. Returns cells after start, or null.
// tall: for a mob three blocks high (iron golems' detours), every cell also needs the block above its head clear, and, as it is wider than
// its cell and overhangs all eight around it, those clear above knee height too (or it would walk its head into a ledge beside the route).
let planBudget = 0;
// A* searches (spec r15-33). In the mob loop a mob may search only with a grant: PLANS grants are handed out at the start of each tick
// to the mobs that have been waiting longest (then by id), so who gets a search never depends on the order mobs think in (regions,
// later threads). A mob that asks without one joins the waiting list and searches in a later tick (one tick later when few are
// waiting); one that stopped asking for KEEP ticks leaves it, and an unused grant lapses after KEEP ticks. Outside the mob loop (the
// village ticks after it, in a fixed order) searches share planBudget as before.
// The waiting list and the grants live on the mobs (ai.planW: the tick it first asked, planL: last asked, planG: granted), not in a
// module table, so that every copy of the world (spec r15-39: several workers, each thinking some regions) hands out the same grants: a
// table here held only what this worker's own mobs asked, and still held them after their region moved to another worker. A tick number
// ahead of the counter (a save loaded after the counter restarted) counts as lapsed.
const PLANS = 2, KEEP = 20;
let curMob = null, planTick = 0;   // (counts mob updates, not BF.rand.tick: tests step BF.mobs.update on its own; with clusters, the tick)
// With clusters (spec r15-39b, js/ctick.js) the mob loop's parts run once per cluster: own(m) -> the mob is the running cluster's
// (null: every mob is)
const own = () => { const C = BF.ctick; return C && C.on ? C.filter : null; };
const idNum = m => { const id = m.id, n = typeof id === "string" && id.charCodeAt(0) === 101 ? +id.slice(1) : NaN; return n === n ? n : 1e15; };
const lapsed = (v, t) => v > t || v < t - KEEP;
function grantPlans() {
  const C = BF.ctick, t = C && C.on ? (planTick = BF.rand.tick) : ++planTick, w = [], mine = own();
  for (const m of list) {
    if (mine && !mine(m)) continue;
    const a = m.ai;
    if (!a) continue;
    if (a.planG != null && (m.removed || lapsed(a.planG, t))) a.planG = undefined;
    if (a.planW == null) continue;
    if (m.removed || m.dead || lapsed(a.planL, t) || a.planW > t) { a.planW = a.planL = undefined; continue; }
    w.push(m);
  }
  if (!w.length) return;
  w.sort((a, b) => a.ai.planW - b.ai.planW || idNum(a) - idNum(b) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  for (let i = 0; i < w.length && i < PLANS; i++) { const a = w[i].ai; a.planG = t; a.planW = a.planL = undefined; }
}
function takePlan() {
  const m = curMob;
  if (!m) { if (planBudget > 0) { planBudget--; return true; } return false; }
  const a = m.ai;
  if (!a) return false;
  if (a.planG != null) { a.planG = undefined; return true; }
  const t = planTick;
  if (a.planW != null) a.planL = t; else { a.planW = t; a.planL = t; }
  return false;
}
const AROUND = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
// The A* as it was before spec r15-05 (string keys, a linear scan of the open list): kept for BF.debug.pathCompare.
function findPathOld(sx, sy, sz, goal, maxNodes = 3000, tall = false) {
  const air = (x, y, z) => !tall || !blockAt(x, y, z).solid;
  const nav = tall ? (x, y, z) => navCell(x, y, z) && air(x, y + 2, z) && AROUND.every(([ex, ez]) => air(x + ex, y + 1, z + ez) && air(x + ex, y + 2, z + ez)) : navCell;
  const key = (x, y, z) => x + "," + y + "," + z;
  const gx = goal.x, gz = goal.z, hh = (x, z) => Math.abs(x - gx) + Math.abs(z - gz);
  const open = [[sx, sy, sz, 0, hh(sx, sz)]], from = new Map([[key(sx, sy, sz), null]]), cost = new Map([[key(sx, sy, sz), 0]]);
  for (let n = 0; open.length && n < maxNodes; n++) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][4] < open[bi][4]) bi = i;
    const [x, y, z, g] = open[bi];
    open[bi] = open[open.length - 1]; open.pop();
    if (goal.at(x, y, z)) {
      const out = [];
      for (let k = key(x, y, z), c = [x, y, z]; c; k = c && key(...c)) { out.push(c); c = from.get(k); }
      out.pop();
      return out.reverse();
    }
    if (ladderAt(x, y, z)) for (const dy of [1, -1]) {           // climb straight up to the next rung or down to the one below
      const ny = y + dy;
      if (dy > 0 ? !nav(x, ny, z) : !ladderCell(x, ny, z) || !air(x, ny + 2, z)) continue;
      const k = key(x, ny, z), ng = g + 1.5;
      if (cost.has(k) && cost.get(k) <= ng) continue;
      cost.set(k, ng); from.set(k, [x, y, z]);
      open.push([x, ny, z, ng, ng + hh(x, z)]);
    }
    for (const [dx, dz] of BF.DIRS) for (const dy of [0, 1, -1, -2, -3]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!nav(nx, ny, nz)) continue;
      if (dy > 0 && (blockAt(x, y + 2, z).solid || !air(x, y + 3, z) || (tall && BF.DIRS.some(([ex, ez]) => !air(x + ex, y + 3, z + ez))))) break;   // no room to jump (a golem is wider than its cell)
      if (dy < 0 && (blockAt(nx, y + 1, nz).solid || !air(nx, y + 2, nz))) break;        // wall: cannot step off
      const k = key(nx, ny, nz), ng = g + 1 + (dy ? 0.5 : 0) + (blockAt(nx, ny, nz).door || blockAt(nx, ny, nz).gate ? 1 : 0);
      if (cost.has(k) && cost.get(k) <= ng) break;
      cost.set(k, ng); from.set(k, [x, y, z]);
      open.push([nx, ny, nz, ng, ng + hh(nx, nz)]);
      break;
    }
  }
  return null;
}
// The same search with integer cell keys and a binary heap (spec r15-05); routes can differ from findPathOld only between equal f values
// (ties go to the larger g, then the newer entry).
// Cells are keyed relative to the start in the mob's own frame (never canonicalised across a face edge): x and z within 32767 of it
// (maxNodes is far smaller), y from MIN_Y. An open-addressing table, reused between calls (a stamp per search instead of clearing),
// holds for each cell met its node (best cost and parent, in typed arrays) and whether it is a cell the mob can be in, so each cell's
// blocks are read once a search. The heap holds (f, insertion order, node, g) entries; an entry whose g is no longer its cell's best is
// skipped when popped (but still counts toward maxNodes, as the old open list kept such duplicates).
const FP = { cap: 0, hcap: 0, x: null, y: null, z: null, g: null, p: null, hf: null, hq: null, hn: null, hg: null,
  tcap: 0, tmask: 0, tused: 0, stamp: 0, tk: null, ts: null, tn: null, tv: null };
function fpGrow(n) {
  const c = Math.max(1024, n * 2), o = FP;
  const g = (A, old) => { const a = new A(c); if (old) a.set(old.subarray(0, o.cap)); return a; };
  o.x = g(Int32Array, o.x); o.y = g(Int32Array, o.y); o.z = g(Int32Array, o.z); o.g = g(Float64Array, o.g); o.p = g(Int32Array, o.p); o.cap = c;
}
function fpGrowHeap(n) {
  const c = Math.max(1024, n * 2), o = FP;
  const g = (A, old) => { const a = new A(c); if (old) a.set(old.subarray(0, o.hcap)); return a; };
  o.hf = g(Float64Array, o.hf); o.hq = g(Int32Array, o.hq); o.hn = g(Int32Array, o.hn); o.hg = g(Float64Array, o.hg); o.hcap = c;
}
// the cell table: key (Float64), stamp of the search that wrote the slot, node index (-1 none yet), nav (0 not read, 1 yes, 2 no)
const fpHash = k => { const lo = k % 4294967296 | 0, hi = (k / 4294967296) | 0; let h = Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77); h ^= h >>> 15; return h; };
function fpTable(cap) {
  const o = FP, ok = o.tk, os = o.ts, on = o.tn, ov = o.tv, oc = o.tcap;
  o.tk = new Float64Array(cap); o.ts = new Int32Array(cap); o.tn = new Int32Array(cap); o.tv = new Uint8Array(cap); o.tcap = cap; o.tmask = cap - 1;
  for (let i = 0; i < oc; i++) if (os[i] === o.stamp) {   // the current search's cells move to the bigger table
    let j = fpHash(ok[i]) & o.tmask;
    while (o.ts[j] === o.stamp) j = (j + 1) & o.tmask;
    o.tk[j] = ok[i]; o.ts[j] = o.stamp; o.tn[j] = on[i]; o.tv[j] = ov[i];
  }
}
function fpSlot(k) {   // the table slot of key k in this search, made if new
  const o = FP;
  let i = fpHash(k) & o.tmask;
  while (o.ts[i] === o.stamp) { if (o.tk[i] === k) return i; i = (i + 1) & o.tmask; }
  if (++o.tused * 2 > o.tcap) { fpTable(o.tcap * 2); return fpSlot(k); }
  o.tk[i] = k; o.ts[i] = o.stamp; o.tn[i] = -1; o.tv[i] = 0;
  return i;
}
function findPathFast(sx, sy, sz, goal, maxNodes = 3000, tall = false) {
  const air = (x, y, z) => !tall || !blockAt(x, y, z).solid;
  const navRead = tall ? (x, y, z) => navCell(x, y, z) && air(x, y + 2, z) && AROUND.every(([ex, ez]) => air(x + ex, y + 1, z + ez) && air(x + ex, y + 2, z + ez)) : navCell;
  const Y0 = BF.MIN_Y, key = (x, y, z) => ((x - sx + 32768) * 65536 + (z - sz + 32768)) * 4096 + (y - Y0);
  const gx = goal.x, gz = goal.z, hh = (x, z) => Math.abs(x - gx) + Math.abs(z - gz);
  const S = FP;
  if (!S.cap) fpGrow(0);
  if (!S.hcap) fpGrowHeap(0);
  if (!S.tcap) fpTable(1 << 16);
  S.stamp = (S.stamp + 1) | 0; S.tused = 0;
  if (!S.stamp) { S.ts.fill(0); S.stamp = 1; }   // wrapped round: no slot may look written by this search
  // nav through the table: each cell's blocks are read once per search (they cannot change during it)
  const nav = (x, y, z) => {
    const i = fpSlot(key(x, y, z));
    if (!S.tv[i]) S.tv[i] = navRead(x, y, z) ? 1 : 2;
    return S.tv[i] === 1;
  };
  let nodes = 0, hn = 0, seq = 0;
  const node = (x, y, z, g, p) => {
    if (nodes >= S.cap) fpGrow(nodes);
    S.x[nodes] = x; S.y[nodes] = y; S.z[nodes] = z; S.g[nodes] = g; S.p[nodes] = p;
    return nodes++;
  };
  // the heap: a before b when its f is lower; at equal f, the one further along (larger g, so nearer the goal), then the newer. Oldest-first
  // fanned out wide over equal-f cells and ran out of maxNodes on long routes the old search found (a jobless villager ~100 blocks
  // from a sty's trough, test/pigfarmer-actions.js); the old linear scan tended newest-first.
  const less = (i, j) => S.hf[i] < S.hf[j] || (S.hf[i] === S.hf[j] && (S.hg[i] > S.hg[j] || (S.hg[i] === S.hg[j] && S.hq[i] > S.hq[j])));
  const swap = (i, j) => {
    let t = S.hf[i]; S.hf[i] = S.hf[j]; S.hf[j] = t;
    t = S.hq[i]; S.hq[i] = S.hq[j]; S.hq[j] = t;
    t = S.hn[i]; S.hn[i] = S.hn[j]; S.hn[j] = t;
    t = S.hg[i]; S.hg[i] = S.hg[j]; S.hg[j] = t;
  };
  const push = (f, n, g) => {
    if (hn >= S.hcap) fpGrowHeap(hn);
    let i = hn++;
    S.hf[i] = f; S.hq[i] = seq++; S.hn[i] = n; S.hg[i] = g;
    while (i > 0) { const up = (i - 1) >> 1; if (!less(i, up)) break; swap(i, up); i = up; }
  };
  const pop = () => {   // removes the top entry (read before calling)
    hn--;
    if (!hn) return;
    S.hf[0] = S.hf[hn]; S.hq[0] = S.hq[hn]; S.hn[0] = S.hn[hn]; S.hg[0] = S.hg[hn];
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1;
      let b = i;
      if (l < hn && less(l, b)) b = l;
      if (r < hn && less(r, b)) b = r;
      if (b === i) break;
      swap(i, b); i = b;
    }
  };
  // a cell reached at cost ng from node `from`: kept when it is new or cheaper than before
  const reach = (nx, ny, nz, ng, from) => {
    const i = fpSlot(key(nx, ny, nz)), at = S.tn[i];
    if (at >= 0) {
      if (S.g[at] <= ng) return;
      S.g[at] = ng; S.p[at] = from;
      push(ng + hh(nx, nz), at, ng);
      return;
    }
    const n = node(nx, ny, nz, ng, from);
    S.tn[fpSlot(key(nx, ny, nz))] = n;   // (looked up again: making the node can't move the slot, but the first lookup may have grown the table)
    push(ng + hh(nx, nz), n, ng);
  };
  const s0 = node(sx, sy, sz, 0, -1);
  S.tn[fpSlot(key(sx, sy, sz))] = s0;
  push(hh(sx, sz), s0, 0);
  for (let n = 0; hn && n < maxNodes; n++) {
    const cur = S.hn[0], g = S.hg[0];
    pop();
    if (g > S.g[cur]) continue;   // a cell since reached more cheaply
    const x = S.x[cur], y = S.y[cur], z = S.z[cur];
    if (goal.at(x, y, z)) {
      const out = [];
      for (let c = cur; S.p[c] !== -1; c = S.p[c]) out.push([S.x[c], S.y[c], S.z[c]]);
      return out.reverse();
    }
    if (ladderAt(x, y, z)) for (const dy of [1, -1]) {           // climb straight up to the next rung or down to the one below
      const ny = y + dy;
      if (dy > 0 ? !nav(x, ny, z) : !ladderCell(x, ny, z) || !air(x, ny + 2, z)) continue;
      reach(x, ny, z, g + 1.5, cur);
    }
    for (const [dx, dz] of BF.DIRS) for (const dy of [0, 1, -1, -2, -3]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!nav(nx, ny, nz)) continue;
      if (dy > 0 && (blockAt(x, y + 2, z).solid || !air(x, y + 3, z) || (tall && BF.DIRS.some(([ex, ez]) => !air(x + ex, y + 3, z + ez))))) break;   // no room to jump (a golem is wider than its cell)
      if (dy < 0 && (blockAt(nx, y + 1, nz).solid || !air(nx, y + 2, nz))) break;        // wall: cannot step off
      const b = blockAt(nx, ny, nz);
      reach(nx, ny, nz, g + 1 + (dy ? 0.5 : 0) + (b.door || b.gate ? 1 : 0), cur);
      break;
    }
  }
  return null;
}
// What a route costs under findPath's rules (the comparison below and test/findpath-compare.js): 1 a step, +0.5 up or down, +1 into a door
// or gate, 1.5 a ladder rung straight up or down.
function routeCost(sx, sy, sz, route) {
  let c = 0, px = sx, py = sy, pz = sz;
  for (const [x, y, z] of route) {
    if (x === px && z === pz) c += 1.5;
    else { const b = blockAt(x, y, z); c += 1 + (y !== py ? 0.5 : 0) + (b.door || b.gate ? 1 : 0); }
    px = x; py = y; pz = z;
  }
  return c;
}
// BF.debug.pathCompare (tests, the console): every search also runs findPathOld and tallies BF.debug.pathStats: calls, identical routes,
// other routes of equal cost, none from both, searches where only one ran out of maxNodes (the other order of equal-f cells reached the
// goal first; checked with 4x the nodes), routes whose costs differ by no more than the goal's slack (offGoal, below), differences
// (the first few kept, and logged), and the time each took.
// offGoal: a goal that accepts cells away from (goal.x, goal.z) (a jobsite's side, a bed's side, "within 8 blocks") makes the distance
// estimate overstate what is left at those cells, so neither search is sure to find the cheapest route there and the order of equal-f
// cells decides which one is found. Such a pair agrees when the costs differ by no more than how far either route ends from (goal.x, goal.z).
function pathsAgree(sx, sy, sz, goal, maxNodes, tall, a, b) {
  if (!a && !b) return "nullBoth";
  if (a && b && a.length === b.length && a.every((c, i) => c[0] === b[i][0] && c[1] === b[i][1] && c[2] === b[i][2])) return "same";
  if (a && b) {
    const ca = routeCost(sx, sy, sz, a), cb = routeCost(sx, sy, sz, b);
    if (ca === cb) return "equal";
    const slack = r => { const e = r.length ? r[r.length - 1] : [sx, sy, sz]; return Math.abs(e[0] - goal.x) + Math.abs(e[2] - goal.z); };
    if (Math.abs(ca - cb) <= Math.max(slack(a), slack(b))) return "offGoal";
    return "diff";
  }
  return (a ? findPathOld : findPathFast)(sx, sy, sz, goal, maxNodes * 4, tall) ? "cutoff" : "diff";
}
const DBG = (BF.debug = BF.debug || {});
DBG.pathCompare = DBG.pathCompare || false;
function pathStatsReset() { return (DBG.pathStats = { calls: 0, same: 0, equal: 0, offGoal: 0, cutoff: 0, diff: 0, nullBoth: 0, ms: 0, msOld: 0, diffs: [] }); }
pathStatsReset();
// findPath: the route search every caller uses (findPathFast, compared with findPathOld when asked).
function findPath(sx, sy, sz, goal, maxNodes = 3000, tall = false) {
  if (!DBG.pathCompare) return findPathFast(sx, sy, sz, goal, maxNodes, tall);
  const S = DBG.pathStats || pathStatsReset();
  const t0 = performance.now(), a = findPathFast(sx, sy, sz, goal, maxNodes, tall), t1 = performance.now(), b = findPathOld(sx, sy, sz, goal, maxNodes, tall), t2 = performance.now();
  S.calls++; S.ms += t1 - t0; S.msOld += t2 - t1;
  const v = pathsAgree(sx, sy, sz, goal, maxNodes, tall, a, b);
  S[v]++;
  if (v === "diff") {
    const d = { from: [sx, sy, sz], goal: [goal.x, goal.z], maxNodes, tall, len: a && a.length, lenOld: b && b.length, cost: a && routeCost(sx, sy, sz, a), costOld: b && routeCost(sx, sy, sz, b) };
    if (S.diffs.length < 20) S.diffs.push(d);
    if (BF.glog && S.diff <= 20) BF.glog.log("DEBUG", "pathCompare", `findPath differs from findPathOld from ${sx},${sy},${sz} toward ${goal.x},${goal.z}: ${d.len} cells cost ${d.cost} vs ${d.lenOld} cost ${d.costOld}`, { at: [sx, sy, sz] });
  }
  return a;
}
const feetCell = m => [Math.floor(m.position.x), Math.floor(m.position.y + 0.01), Math.floor(m.position.z)];
// Route to a cell beside the bed (same floor).
function pathToBed(m) {
  const b = m.bed, [fx, fz] = BF.DIRS[b.f], hx = b.x + fx, hz = b.z + fz;
  const at = (x, y, z) => y === b.y && (Math.abs(x - b.x) + Math.abs(z - b.z) === 1 || Math.abs(x - hx) + Math.abs(z - hz) === 1);
  const [x, y, z] = feetCell(m);
  return findPath(x, y, z, { x: b.x, z: b.z, at });
}
// The house a villager walks out of in the morning: its home, or for a bred child (no home of its own) the house of the bed it slept in.
const outHouse = m => m.home || (m.bed && !m.bed.tent ? homeOfBed(m.village, m.bed) : null);
function pathOut(m) {
  const H = outHouse(m);
  if (!H || H.outX == null) return null;
  const [x, y, z] = feetCell(m);
  return findPath(x, y, z, { x: H.outX, z: H.outZ, at: (cx, cy, cz) => cx === H.outX && cz === H.outZ }, 1200);
}
// Steers along ai.route. Returns "done", "stuck" or "going".
// `ai` defaults to the villager's own route state (m.ai: route, ri, stuckT); detours pass their own.
function followRoute(m, dt, out, speed, ai = m.ai) {
  const r = ai.route;
  if (!r || ai.ri >= r.length) return "done";
  const c = r[ai.ri], dx = c[0] + 0.5 - m.position.x, dz = c[2] + 0.5 - m.position.z, d = Math.hypot(dx, dz);
  // reached: within 0.3 of its centre, and on a ladder only once the feet are in that cell
  if (d < 0.3 && (m.onLadder ? Math.floor(m.position.y + 0.01) === c[1] : Math.abs(m.position.y - c[1]) < 1.1)) { ai.ri++; ai.stuckT = 0; return ai.ri >= r.length ? "done" : "going"; }
  ai.stuckT = (ai.stuckT || 0) + dt;
  if (ai.stuckT > 6) return "stuck";
  const s = Math.min(speed, d * 4 + 0.3);
  out.x = dx / d * s; out.z = dz / d * s;
  m.lookAt = null;
  return "going";
}
function isOccupied(x, y, z) {
  const hit = (p, hw, h) => p.x + hw > x && p.x - hw < x + 1 && p.z + hw > z && p.z - hw < z + 1 && p.y < y + 2 && p.y + h > y;
  const c = { x: x + 0.5, z: z + 0.5 };   // (seen from the cell's frame)
  if (playerAlive() && hit(seen(c, player().position, _sA), 0.3, 1.8)) return true;
  const any = L => L.some(o => !o.dead && !o.removed && hit(seen(c, o.position, _sB), o.halfWidth, o.height));
  return vq("mobs.isOccupied", any(nearMobs(c, 3, true)), any);
}
// Someone at a doorway: a mob (other than `but`) or the player within 1.3 of the cell's centre at its height. A villager doesn't shut a door
// while another stands in or right by it (they'd be shut out, or it would close in their face as they open it).
function atDoor(x, y, z, but) {
  const c = { x: x + 0.5, z: z + 0.5 };
  const by = (p, h) => { const dx = p.x - c.x, dz = p.z - c.z; return dx * dx + dz * dz < 1.69 && p.y < y + 2 && p.y + h > y; };
  if (playerAlive() && by(seen(c, player().position, _sA), 1.8)) return true;
  const any = L => L.some(o => o !== but && !o.dead && !o.removed && !o.sleeping && by(seen(c, o.position, _sB), o.height));
  return vq("mobs.atDoor", any(nearMobs(c, 3, true)), any);
}
// Villagers open closed doors just ahead on their route, and the one they stand in (spawned or scattered into a doorway: its panel would hold
// them there for good), and close the ones they opened once clear of them.
function villagerDoors(m) {
  const ai = m.ai, W = BF.world;
  if (ai.route && !m.sleeping) for (let k = ai.ri - 1; k < Math.min(ai.route.length, ai.ri + 2); k++) {
    const [x, y, z] = k < ai.ri ? feetCell(m) : ai.route[k], bk = blockAt(x, y, z), d = bk.door || bk.gate;   // fence gates (shepherd pens) open and close the same way
    if (d && !d.open && Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z) < 1.7) {
      BF.blockReq.door(m, x, y, z, true);   // a request (spec r15-19): the door is open from this tick's apply phase
      (ai.doors || (ai.doors = [])).push([x, y, z, BF.blockReq.tick()]);
    }
  }
  if (ai.doors && ai.doors.length) ai.doors = ai.doors.filter(c => {
    const [x, y, z] = c;
    if (c[3] === BF.blockReq.tick() || Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z) < 1.5 || atDoor(x, y, z, m)) return true;   // (asked to open this tick: not open yet)
    const bk = blockAt(x, y, z), d = bk.door || bk.gate;
    if (!d || !d.open || c[4] > 9 || Math.hypot(x + 0.5 - m.position.x, z + 0.5 - m.position.z) > 16) return false;
    // shut it; the close is refused if someone came to the doorway this tick (js/blockreqs.js), so look again next tick (a few times)
    BF.blockReq.door(m, x, y, z, false); c[3] = BF.blockReq.tick(); c[4] = (c[4] || 0) + 1;
    return true;
  });
}
// Lying on the bed, head on the pillow (re-applied every step while asleep); js/mobview.js draws it lying flat with its eyes shut.
function sleepPose(m) {
  const b = m.bed, [fx, fz] = BF.DIRS[b.f];
  m.position.set(b.x + 0.5 - fx * 0.5, b.y + 0.5625 + 0.22, b.z + 0.5 - fz * 0.5);
  m.vel.set(0, 0, 0);
}
function lieDown(m) {
  m.sleeping = true; m.tradingWith = null;
  m.headYaw = m.headPitch = 0; m.walkAmt = 0; m.ai.swingT = 0;
  sleepPose(m);
}
function wake(m) {
  const ai = m.ai, b = m.bed;
  m.sleeping = false;
  const at = ai.route && ai.route.length ? ai.route[ai.route.length - 1] : null;
  if (at) m.position.set(at[0] + 0.5, at[1], at[2] + 0.5);
  else if (b) { const s = findStand(b.x, b.y, b.z, m.def); if (s) m.position.set(s[0], s[1], s[2]); }
  ai.route = null; ai.night = null;
  ai.leaving = !bedtime() && !(b && b.tent);   // out in the field after a night in a tent: nothing to walk out of
}
// The house (village layout) whose floor holds this bed, or null.
function homeOfBed(rec, b) {
  for (const h of (rec && rec.houses) || []) if (h && h.w && b.x >= h.x && b.x < h.x + h.w && b.z >= h.z && b.z < h.z + h.d) return h;
  return null;
}
// A villager without a working bed of its own (no bed in its house, a builder or explorer before it has a home, its bed broken) claims the
// nearest free bed of the village and keeps it: it sleeps there every night and the claim is saved (trades.pack). Newborns claim theirs in js/breeding.js.
function claimBed(m, n, dt) {
  const rec = m.village, B = BF.breeding;
  if (!rec || !B || !B.freeBed || (m.slot && m.slot.bred) || (m.bed && m.bed.tent) || m.homeBed !== undefined) return;
  if (m.bed && bedOK(m.bed)) return;
  if ((n.claimT = (n.claimT || 0) - dt) > 0) return;
  n.claimT = 5;                                              // none free: look again in a few seconds
  if (!rec.beds || BF.simNow() * 1000 - (rec.bedScanAt || 0) > 3000) B.scanBeds(rec);
  const b = B.freeBed(rec, m);
  if (!b) return;
  BF.claims.ask("bed", m, "b:" + b.x + "," + b.y + "," + b.z, { bed: b });   // the first claim of a bed in a tick wins (r15-23)
}
// The "bed" claim (claimBed above; children and newborns in js/breeding.js childTick): the bed must still stand and be nobody else's.
BF.claims.kind("bed", {
  free: (m, d) => BF.breeding && BF.breeding.bedFree(m.village, d.bed, m) ? null : "taken",
  take(m, d) {
    const b = Object.assign({}, d.bed), rec = m.village;
    if (m.slot && m.slot.bred) { m.bed = b; if (m.bredEntry) m.bredEntry.bed = b; return; }   // a newborn's bed (js/breeding.js)
    m.bed = Object.assign(b, { claimed: true });
    const h = homeOfBed(rec, b);
    if (h) m.home = h;
    if (m.ai.night) m.ai.night.fails = 0;
    m.ai.route = null;
    if (BF.vlog && BF.vlog.log) BF.vlog.log(rec, "bed", BF.vlog.nameOf(m) + " (" + BF.vlog.pretty(m.child ? "child" : m.profession) + ") claimed the bed at " + b.x + ", " + b.y + ", " + b.z);
  },
  result(m, ok) { if (!ok && m.ai.night && !(m.slot && m.slot.bred)) m.ai.night.claimT = 0; },   // lost it to someone first: look again next tick
});
// Without a bed at night: walk into the nearest building (its own house first) that has room, along a path through the door. True while going.
const inHouse = (h, x, z) => x >= h.x && x <= h.x + h.w && z >= h.z && z <= h.z + h.d;
function shelterAI(m, dt0, dt, out) {
  const ai = m.ai, V = m.village, n = dt0;
  if (!V || (n.sFail || 0) >= 3) return false;
  if (!n.shelter) {
    let best = m.home, bd = 1e9;
    if (!best) for (const h of V.houses || []) {
      if (!h || !h.w || h.w * h.d < 9) continue;
      let used = 0;
      for (const o of V.members) if (o !== m && o.type === "villager" && !o.dead && inHouse(h, o.position.x, o.position.z)) used++;
      if (used >= 4) continue;                                // full: next one
      const d = Math.hypot(h.x + h.w / 2 - m.position.x, h.z + h.d / 2 - m.position.z);
      if (d < bd) { bd = d; best = h; }
    }
    if (!best) return false;
    n.shelter = best;
  }
  const h = n.shelter;
  if (inHouse(h, m.position.x, m.position.z)) return true;
  if (ai.routeKind !== "shelter") ai.route = null;
  if (!ai.route && (n.retryT -= dt) <= 0 && takePlan()) {
    const [fx, fy, fz] = feetCell(m);
    const gx = Math.floor(h.x + h.w / 2), gz = Math.floor(h.z + h.d / 2);
    ai.route = findPath(fx, fy, fz, { x: gx, z: gz, at: (x, y, z) => x >= h.x && x < h.x + h.w && z >= h.z && z < h.z + h.d }, 2500);
    ai.ri = 0; ai.stuckT = 0; ai.routeKind = "shelter";
    if (!ai.route) { n.sFail = (n.sFail || 0) + 1; n.retryT = 8; }
  }
  if (ai.route) {
    const st = followRoute(m, dt, out, m.def.speed * 1.3);
    if (st === "done") ai.route = null;
    else if (st === "stuck") { ai.route = null; n.sFail = (n.sFail || 0) + 1; n.retryT = 4; }
    return true;
  }
  return false;
}
// Night: head for bed and sleep; without a usable bed stand still indoors or by the village bell.
function nightAI(m, dt, out) {
  const ai = m.ai, T = m.def, V = m.village;
  ai.mode = "idle"; ai.t = rnd(R(m), 1, 3); ai.leaving = false;
  const n = ai.night || (ai.night = { fails: 0, retryT: 0 });
  claimBed(m, n, dt);
  const H = m.home;
  if (ai.routeKind !== "bed" && ai.routeKind !== "shelter") ai.route = null;   // a day route is dropped; the walk to bed or shelter carries on
  if (m.bed && bedOK(m.bed) && n.fails < 3) {
    if (ai.routeKind !== "bed") ai.route = null;
    if (!ai.route && (n.retryT -= dt) <= 0 && takePlan()) {
      ai.route = pathToBed(m); ai.ri = 0; ai.stuckT = 0; ai.routeKind = "bed";
      if (!ai.route) { n.fails++; n.retryT = 8; }
    }
    if (ai.route) {
      const st = followRoute(m, dt, out, T.speed * 1.3);
      if (st === "done") { ai.route = [feetCell(m)]; lieDown(m); }
      else if (st === "stuck") { ai.route = null; n.fails++; n.retryT = 1; }
    }
    return;
  }
  const inside = H && m.position.x >= H.x && m.position.x <= H.x + H.w && m.position.z >= H.z && m.position.z <= H.z + H.d;
  if (inside || !V) return;
  if (shelterAI(m, n, dt, out)) return;      // a villager without a bed goes indoors for the night
  const dx = V.x + 0.5 - m.position.x, dz = V.z + 0.5 - m.position.z, d = Math.hypot(dx, dz);
  if (d > 3.5) { out.x = dx / d * T.speed; out.z = dz / d * T.speed; }
}
// Morning: walk out of the house through the door before wandering again.
function morningAI(m, dt, out) {
  const ai = m.ai;
  if (!ai.route) {
    if (!takePlan()) return true;
    ai.route = pathOut(m); ai.ri = 0; ai.stuckT = 0; ai.routeKind = "out";
    if (!ai.route) { ai.leaving = false; ai.leaveEnd = "nopath"; return false; }
  }
  const st = followRoute(m, dt, out, m.def.speed);
  if (st === "stuck" && (ai.leaveTries = (ai.leaveTries || 0) + 1) < 3) { ai.route = null; return true; }
  if (st === "going") return true;
  ai.leaving = false; ai.route = null; ai.leaveTries = 0; ai.leaveEnd = st;
  const H = st === "done" && outHouse(m);   // (a bred child too: standing on the doorstep, its next wander could take it back in through the open door)
  if (H && H.outX != null) { // keep walking away from the door so it gets closed behind them
    ai.mode = "walk"; ai.t = 5; ai.tx = H.outX + 0.5 + (H.outX - H.doorX) * 5; ai.tz = H.outZ + 0.5 + (H.outZ - H.doorZ) * 5;
    ai.outT = 5;   // not turned back toward the village centre meanwhile (villagerAI): from a house at the edge facing away, that led back in through the open door
  }
  return false;
}

// ---------- village mobs ----------
// The jobs, in order: the first that has something to do this frame takes the villager (true). Each one says how long a task will take before
// starting it (BF.villageSim.begin); a villager none of them takes for a few seconds is idle and has no task left to wait for.
function jobsAI(m, dt, out) {
  if (m.love && BF.breeding && BF.breeding.ai(m, dt, out)) return true;   // breeding pair: stand still, face each other (js/breeding.js)
  if (BF.storage && BF.storage.ai(m, dt, out)) return true;   // full inventory: stores surplus in a chest of its house, fetches it back when low (js/storage.js)
  if (BF.eggCook && BF.eggCook.ai(m, dt, out, true)) return true;   // carries on cooking eggs it started: at the furnace, buying fuel (js/eggcook.js)
  if (m.profession === "cowherd" && BF.cowherd && BF.cowherd.cookAI(m, dt, out, true)) return true;   // carries on cooking beef it started (js/cowherd.js)
  if (m.profession === "baker" && BF.baker && BF.baker.ai(m, dt, out, true)) return true;   // carries on baking or buying it started (js/baker.js)
  if (m.profession === "glassmaker" && BF.glassmaker && BF.glassmaker.ai(m, dt, out, true)) return true;   // carries on digging, smelting or buying it started (js/glassmaker.js)
  if (m.profession === "beekeeper" && BF.beekeeper && BF.beekeeper.ai(m, dt, out, true)) return true;   // carries on harvesting, leading bees or buying it started (js/beekeeper.js)
  if (m.profession === "pig_farmer" && BF.pigFarmer && BF.pigFarmer.cookAI(m, dt, out, true)) return true;   // carries on cooking pork it started (js/pigfarmer.js)
  if (BF.villageLife && BF.villageLife.ai(m, dt, out)) return true;   // buys food when hungry, farmers farm (js/villagelife.js)
  if (m.profession === "builder" && BF.builder && BF.builder.ai(m, dt, out)) return true;   // builds / shops for materials (js/builder.js)
  if (m.profession === "shepherd" && BF.shepherd && BF.shepherd.ai(m, dt, out)) return true;   // feeds, shears and culls the pen sheep (js/shepherd.js)
  if (m.profession === "poultry_keeper" && BF.poultry && BF.poultry.ai(m, dt, out)) return true;   // collects eggs, feeds, culls and stocks the coop (js/poultry.js)
  if (m.profession === "cowherd" && BF.cowherd && BF.cowherd.ai(m, dt, out)) return true;   // milks, feeds, culls and stocks the pasture, cooks its beef (js/cowherd.js)
  if (m.profession === "baker" && BF.baker && BF.baker.ai(m, dt, out, false)) return true;   // buys ingredients and fuel, bakes cakes and pies in its oven (js/baker.js)
  if (m.profession === "glassmaker" && BF.glassmaker && BF.glassmaker.ai(m, dt, out, false)) return true;   // digs and buys sand, smelts glass, makes panes and bottles (js/glassmaker.js)
  if (m.profession === "beekeeper" && BF.beekeeper && BF.beekeeper.ai(m, dt, out, false)) return true;   // harvests hives, plants flowers, builds hives, leads bees, makes candles (js/beekeeper.js)
  if (m.profession === "pig_farmer" && BF.pigFarmer && BF.pigFarmer.ai(m, dt, out)) return true;   // feeds, culls and stocks the sty, cooks its pork (js/pigfarmer.js)
  if (m.profession === "cartographer" && BF.cartography && BF.cartography.ai(m, dt, out)) return true;   // buys compass / map ingredients (js/cartography.js)
  if (m.profession === "forester" && BF.forester && BF.forester.ai(m, dt, out)) return true;   // plants saplings, fells trees, picks up what falls (js/forester.js)
  if (m.profession === "furniture_maker" && BF.furniture && BF.furniture.ai(m, dt, out)) return true;   // sells beds to builders, buys wool and boards (js/furniture.js)
  if (m.profession === "miner" && BF.miner && BF.miner.ai(m, dt, out)) return true;
  if (m.profession === "toolsmith" && BF.toolsmith && BF.toolsmith.ai(m, dt, out)) return true;   // buys tool materials, smelts ore, puts a furnace down (js/toolsmith.js)   // quarries surface stone or digs a mineshaft, sells cobblestone to builders (js/miner.js)
  if (m.profession === "stable_hand" && BF.stables && BF.stables.ai(m, dt, out)) return true;   // catches wild horses, leads them home, breeds them, buys feed (js/stables.js)
  if (m.profession === "fletcher" && BF.fletcher && BF.fletcher.ai(m, dt, out)) return true;   // buys flint, sticks, feathers and string for arrows and bows (js/fletcher.js)
  if (m.profession === "explorer" && BF.explorer && BF.explorer.ai(m, dt, out)) return true;   // fetches a map from a cartographer, explores until it is filled (js/explorer.js)
  if (m.profession === "merchant" && BF.merchant && BF.merchant.ai(m, dt, out)) return true;   // carries surplus goods to a neighbouring village and back (js/merchant.js)
  if (BF.eggCook && BF.eggCook.ai(m, dt, out)) return true;   // nothing else to do: takes its raw eggs to a furnace (js/eggcook.js)
  if (BF.jobs && BF.jobs.ai(m, dt, out)) return true;   // daytime visits to the jobsite; villagers without a job walk to a free one (js/jobs.js)
  return false;
}
function villagerAI(m, dt, out) {
  const ai = m.ai, T = m.def, V = m.village;
  if (m.tradingWith) {
    // auto-release if the trade screen closed without telling us
    const inv = BF.inventory;
    if (m.dead || !playerAlive() || (inv && typeof inv.isOpen === "function" && !inv.isOpen()) || pAt(m).distanceTo(m.position) > 8) m.tradingWith = null;
    else { out.faceTarget = true; m.lookAt = "player"; ai.mode = "idle"; ai.t = 2; ai.fleeT = 0; return; }
  }
  // flee nearby zombies
  ai.zScanT = (ai.zScanT || 0) - dt;
  if (ai.zScanT <= 0) { ai.zScanT = 0.5; ai.threat = nearestMob(m, 8, o => o.type === "zombie" && hasLineOfSight(m, new THREE.Vector3(o.position.x, o.position.y + o.height * 0.85, o.position.z))); }   // not through rock: a miner would flee a zombie in a cave beside its tunnel all day
  if (ai.threat && !ai.threat.dead && !ai.threat.removed) ai.fleeT = Math.max(ai.fleeT, 1);
  if (ai.fleeT > 0) {
    ai.fleeT -= dt;
    const src = ai.threat && !ai.threat.removed ? seen(m.position, ai.threat.position, _sA) : (playerAlive() ? pAt(m) : null);
    let fx = Math.cos(m.yaw), fz = Math.sin(m.yaw);
    if (src) { fx = m.position.x - src.x; fz = m.position.z - src.z; }
    ai.fleeJitter = (ai.fleeJitter || R(m).next() * 6) + rnd(R(m), -3, 3) * dt;
    const a = Math.atan2(fz, fx) + Math.sin(ai.fleeJitter) * 0.6;
    out.x = Math.cos(a) * T.flee; out.z = Math.sin(a) * T.flee;
    m.lookAt = null;
    return;
  }
  if (bedtime()) { nightAI(m, dt, out); return; }
  ai.night = null;
  // an explorer out mapping and a merchant on a trip stay where they are between tasks (and before the working day) rather than walk back,
  // and have no house to walk out of in the morning
  const away = (m.profession === "explorer" && BF.explorer && BF.explorer.away && BF.explorer.away(m)) || (m.profession === "merchant" && BF.merchant && BF.merchant.away && BF.merchant.away(m));
  if (away && ai.leaving) { ai.leaving = false; if (ai.routeKind === "out") ai.route = null; }
  if (ai.leaving && morningAI(m, dt, out)) return;
  if (jobsAI(m, dt, out)) { m.idleT = 0; return; }
  m.idleT = (m.idleT || 0) + dt;
  if (m.vtask && m.idleT > 3 && BF.villageSim && BF.villageSim.done) BF.villageSim.done(m);
  // farmers sometimes go tend the village fields
  // sized villages (village generator 2) reach far beyond the plaza: villagers living out there keep to their own neighbourhood
  let ax = V ? V.x : 0, az = V ? V.z : 0;
  if (V && V.pop && m.home && m.home.x != null) {
    const hx = m.home.x + (m.home.w || 1) / 2, hz = m.home.z + (m.home.d || 1) / 2;
    if (Math.hypot(hx - V.x, hz - V.z) > 28) { ax = hx; az = hz; }
  }
  if (m.profession === "farmer" && V && ai.mode === "idle" && ai.t < 0.2 && R(m).next() < 0.5 && BF.B.farmland != null) {
    for (let k = 0; k < 12; k++) {
      const fx = Math.floor(ax + rnd(R(m), -18, 18)), fz = Math.floor(az + rnd(R(m), -18, 18));
      if (!BF.world.isLoaded(fx, fz)) continue;
      const fy = BF.world.heightAt(fx, fz);
      if (fy > 0 && (BF.world.getBlock(fx, fy, fz) === BF.B.farmland || BF.world.getBlock(fx, fy, fz) === BF.B.farmland_dry)) { ai.mode = "walk"; ai.tx = fx + 0.5; ai.tz = fz + 0.5; ai.t = rnd(R(m), 6, 10); break; }
    }
  }
  if (ai.outT > 0) ai.outT -= dt;
  if (away && ai.mode === "walk" && Math.hypot(ai.tx - m.position.x, ai.tz - m.position.z) > 12) { ai.mode = "idle"; ai.t = rnd(R(m), 1, 3); }
  if (V && !away && !(ai.outT > 0 && ai.mode === "walk")) {   // (not while walking away from the door it came out of this morning: morningAI)
    const dx = ax - m.position.x, dz = az - m.position.z, d = Math.hypot(dx, dz);
    if (d > 40) { // wandered too far: head back toward the centre (or home)
      ai.mode = "walk"; ai.tx = ax + rnd(R(m), -6, 6); ai.tz = az + rnd(R(m), -6, 6); ai.t = rnd(R(m), 5, 8);
    } else if (ai.mode === "walk" && Math.hypot(ai.tx - ax, ai.tz - az) > 36) {
      ai.tx = ax + rnd(R(m), -20, 20); ai.tz = az + rnd(R(m), -20, 20);
    }
  }
  wanderAI(m, dt, out);
  if (m.child && BF.breeding) BF.breeding.childMove(m, dt, out);   // children run about (js/breeding.js)
}

function golemAI(m, dt, out) {
  const ai = m.ai, T = m.def;
  ai.provoked = Math.max(0, ai.provoked - dt);
  ai.hScanT = (ai.hScanT || 0) - dt;
  if (ai.hScanT <= 0) {
    ai.hScanT = 0.5;
    // a villager under attack comes first (sprint), then whatever is hurting the golem, then the nearest hostile
    ai.rescue = villagerInDanger(m);
    const rv = ai.revenge && !ai.revenge.dead && !ai.revenge.removed && mdist(m, ai.revenge) < 32 ? ai.revenge : null;
    if (!rv) ai.revenge = null;
    ai.foe = ai.rescue || rv || nearestMob(m, 16, o => o.hostile);
  }
  if (ai.foe && chaseAndHit(m, ai.foe, dt, out, irnd(R(m), 7, 14), 1.2, ai.foe === ai.rescue ? RESCUE_SPEED : T.speed)) return;
  ai.foe = null; ai.rescue = null;
  if (creative()) ai.provoked = 0;
  if (ai.provoked > 0 && playerAlive()) {
    const p = player();
    const pp = pAt(m), dx = pp.x - m.position.x, dz = pp.z - m.position.z, hd = Math.hypot(dx, dz);
    if (hd < 24) {
      const nx = dx / (hd || 1), nz = dz / (hd || 1);
      const reach = m.halfWidth + (p.halfWidth || 0.3) + 0.6;
      if (hd > reach * 0.8) { out.x = nx * T.speed * 1.2; out.z = nz * T.speed * 1.2; }
      out.faceTarget = true; m.lookAt = "player";
      ai.attackCd -= dt;
      if (hd < reach && Math.abs(pp.y - m.position.y) < 2 && ai.attackCd <= 0) {
        ai.attackCd = 1.3; ai.swingT = 0.35;
        if (p.damage) p.damage(irnd(R(m), 5, 9), seen(p.position, m.position, new THREE.Vector3()).clone());
      }
      return;
    }
  }
  // patrol near the village centre, slowly
  const V = m.village;
  let px = V ? V.x : 0, pz = V ? V.z : 0;
  if (V && V.pop && V.houses && V.houses.length) {   // sized villages: each golem patrols around a house, moving on now and then
    if (!m.patrol || R(m).next() < dt / 90) { const h = V.houses[irnd(R(m), 0, V.houses.length - 1)]; m.patrol = R(m).next() < 0.3 || !h ? [V.x, V.z] : [h.x + (h.w || 1) / 2, h.z + (h.d || 1) / 2]; }
    px = m.patrol[0]; pz = m.patrol[1];
  }
  if (V && Math.hypot(px - m.position.x, pz - m.position.z) > 14) { ai.mode = "walk"; ai.tx = px + rnd(R(m), -5, 5); ai.tz = pz + rnd(R(m), -5, 5); ai.t = rnd(R(m), 5, 8); }
  wanderAI(m, dt, out);
  out.x *= 0.6; out.z *= 0.6;
}

// ---------- per-mob update ----------
const _desired = { x: 0, z: 0, faceTarget: false };
// Villagers on ladders: a ladder cell at the feet or the waist (like the player, js/player.js). Speeds in blocks/s.
const LADDER_UP = 2.35, LADDER_DOWN = 3;
function onLadder(m) {
  const x = Math.floor(m.position.x), z = Math.floor(m.position.z);
  return ladderAt(x, Math.floor(m.position.y + 0.01), z) || ladderAt(x, Math.floor(m.position.y + 0.6), z);
}
function updateMob(m, dt) {
  const T = m.def, ai = m.ai;
  m.age += dt;
  m.hurtT -= dt; m.invuln -= dt; m.knockT -= dt; ai.swingT -= dt;

  if (m.dead) {
    m.deathT += dt;   // (js/mobview.js tips it over and flushes it red)
    m.tint = "red";
    m.vel.x *= 0.8; m.vel.z *= 0.8; m.vel.y -= GRAVITY * dt;
    BF.world.moveBox(m.position, m.vel, m.halfWidth, Math.min(m.height, 0.5), dt, { stepUp: 0 });
    keepFrame(m);
    if (m.deathT > 1.0) {
      puff(new THREE.Vector3(m.position.x, m.position.y + 0.2, m.position.z), 8, 0.4, false, 1);
      removeMob(m);
    }
    return;
  }

  if (m.type === "villager") villagerDoors(m);
  if (m.sleeping) {
    if (bedtime() && bedOK(m.bed)) { sleepPose(m); m.tint = null; return; }
    wake(m);
  }

  // ---- AI ----
  _desired.x = 0; _desired.z = 0; _desired.faceTarget = false; _desired.faceX = null; _desired.faceZ = null;
  if (m.rider) { /* ridden (js/horses.js): its rider moves it */ }
  else if (T.hostile) { hostileAI(m, dt, _desired); if (m.type === "zombie") zombieBreakDoor(m, dt, _desired); }
  else if (m.type === "villager") { { const t0 = performance.now(); villagerAI(m, dt, _desired); aiAcc += performance.now() - t0; aiN++; } if (m.profession === "merchant" || m.profession === "explorer") { _desired.x *= TRAVELLER_SPEED; _desired.z *= TRAVELLER_SPEED; } }   // merchants and explorers walk 1.5x as fast
  else if (T.golem) golemAI(m, dt, _desired);
  else if (ai.fleeT > 0) {
    ai.fleeT -= dt;
    let fx = Math.cos(m.yaw), fz = Math.sin(m.yaw);
    if (playerAlive()) { const pp = pAt(m); fx = m.position.x - pp.x; fz = m.position.z - pp.z; }
    ai.fleeJitter = (ai.fleeJitter || R(m).next() * 6) + rnd(R(m), -3, 3) * dt;
    const a = Math.atan2(fz, fx) + Math.sin(ai.fleeJitter) * 0.8;
    _desired.x = Math.cos(a) * T.flee; _desired.z = Math.sin(a) * T.flee;
    m.lookAt = null;
  } else if (m.type === "sheep" && BF.shepherd && BF.shepherd.sheepAI(m, dt, _desired)) { /* walking to a mate (js/shepherd.js) */ }
  else if (m.type === "horse" && BF.horses && BF.horses.ai(m, dt, _desired)) { /* herd, lead, pen, mate (js/horses.js) */ }
  else if (m.type === "chicken" && BF.poultry && BF.poultry.chickenAI(m, dt, _desired)) { /* led home, following seeds, or to a mate (js/poultry.js) */ }
  else if (m.type === "cow" && BF.cowherd && BF.cowherd.cowAI(m, dt, _desired)) { /* led home, following wheat, or to a mate (js/cowherd.js) */ }
  // Pig breeding lives in js/pigfarmer.js (feed, mates, piglets; wild and sty pigs alike; js/wildlife.js makes wild pairs willing)
  else if (m.type === "pig" && BF.pigFarmer && BF.pigFarmer.pigAI(m, dt, _desired)) { /* led home, following feed, or to a mate (js/pigfarmer.js) */ }
  else wanderAI(m, dt, _desired);
  if (m.pen && BF.shepherd) BF.shepherd.contain(m, _desired);   // a penned sheep never walks into the fence or out of the gate gap
  if (m.coop && BF.poultry) BF.poultry.contain(m, _desired);   // nor does a coop chicken
  if (m.pasture && BF.cowherd) BF.cowherd.contain(m, _desired);   // nor a pasture cow
  if (m.sty && BF.pigFarmer) BF.pigFarmer.contain(m, _desired);   // nor a sty pig
  if (m.removed) return; // exploded

  // ---- physics ----
  if (m.rider) {   // ridden (js/horses.js moves it every real-time frame)
  } else if (m.riding && BF.boats && BF.boats.seat(m)) {   // sitting in a boat (js/boats.js): the boat carries it, no walking, falling or fall damage
    m.onGround = true; m.inWater = false; m.headInWater = false; m.onLadder = false; m.fallStart = m.position.y;
  } else {
  m.onLadder = m.type === "villager" && !m.inWater && onLadder(m);
  if (m.knockT <= 0) {
    const k = Math.min(1, dt * (m.onGround ? 10 : m.inWater ? 4 : 2.5));
    m.vel.x += (_desired.x - m.vel.x) * k;
    m.vel.z += (_desired.z - m.vel.z) * k;
  }
  if (m.inWater) {
    m.vel.y += (m.headInWater || m.type === "chicken" ? 22 : 9) * dt; // buoyancy: float up
    m.vel.y -= GRAVITY * 0.5 * dt;
    m.vel.y = Math.max(-2, Math.min(m.vel.y, 2.5));
  } else if (m.onLadder) {
    // on a ladder (villagers): climb towards the route's next cell (just clearing its floor), hold on level with it; with no route hold on while standing still (using a chest beside the ladder) and slide down slowly while walking
    const c = ai.route && ai.route[ai.ri], dy = c ? c[1] - m.position.y : null;
    m.vel.y = dy == null ? (Math.abs(_desired.x) + Math.abs(_desired.z) < 0.05 ? 0 : Math.max(m.vel.y - GRAVITY * dt, -LADDER_DOWN)) : dy > 0 ? Math.min(LADDER_UP, dy * 8 + 0.3) : dy < -0.02 ? -Math.min(LADDER_DOWN, -dy * 8) : 0;
  } else {
    m.vel.y -= GRAVITY * dt;
    if (T.slowFall && m.vel.y < -2) m.vel.y = -2;
    if (m.vel.y < -40) m.vel.y = -40;
  }
  separate(m, dt);

  // standing still on solid ground with nothing pushing it: no move to make (most grazing animals most of the time)
  const resting = m.onGround && !m.inWater && !m.onLadder && m.knockT <= 0 && !_desired.x && !_desired.z && m.vel.y <= 0 &&
    Math.abs(m.vel.x) < 0.02 && Math.abs(m.vel.z) < 0.02 && BF.world.isSolid(Math.floor(m.position.x), Math.floor(m.position.y - 0.05), Math.floor(m.position.z));
  if (resting) { m.vel.set(0, 0, 0); m.fallStart = m.position.y; ai.blockedT = 0; }
  else {
  const wasGround = m.onGround;
  const offRoofs = keepsOffRoofs(m), px = m.position.x, py = m.position.y, pz = m.position.z;
  const res = BF.world.moveBox(m.position, m.vel, m.halfWidth, m.height, dt, { stepUp: 1.05, swim: m.inWater,   // swimming, it climbs out onto a bank (world.js moveBox)
    canStep: offRoofs ? (x, y, z) => !roofLedge(x, y, z, m.halfWidth) : null });
  // nor walks onto one level from a hillside (or lands on one): back where it was, as if it hit a wall. One already up there can get down.
  if (offRoofs && (m.position.x !== px || m.position.z !== pz) && roofLedge(m.position.x, m.position.y, m.position.z, m.halfWidth) && !roofLedge(px, py, pz, m.halfWidth)) {
    m.position.x = px; m.position.z = pz; m.vel.x = 0; m.vel.z = 0; res.hitX = true; res.roof = true;
  }
  m.onGround = res.onGround; m.inWater = res.inWater; m.headInWater = !!res.headInWater;
  if (m.inWater && m.type === "villager" && BF.bridges) BF.bridges.noteSwim(m);   // a swim is a river crossing (js/bridges.js)
  const wants = Math.abs(_desired.x) + Math.abs(_desired.z) > 0.1;
  if ((res.hitX || res.hitZ) && wants) {
    if (T.climbs && (ai.target || ai.mode === "walk")) m.vel.y = 3.2;  // spiders climb walls
    else if (m.onLadder) { /* climbing: the ladder code above lifts it */ }
    else if (res.onGround && !res.roof && !BF.world.boxCollides(m.position.x, m.position.y + 1.05, m.position.z, m.halfWidth, m.height)
      && !(offRoofs && roofLedge(m.position.x + Math.sign(_desired.x) * (res.hitX ? 0.6 : 0), m.position.y + 1, m.position.z + Math.sign(_desired.z) * (res.hitZ ? 0.6 : 0), m.halfWidth))) m.vel.y = 7.6;   // jump obstacles, only with headroom to clear one: under a ledge or leaves a jump just bounces off them
    else if (m.inWater) m.vel.y = 4;
    if (!T.hostile && ai.mode === "walk" && !ai.detour && R(m).next() < 0.3) pickWander(m, 8);
  }
  if (T.village) blockedMove(m, dt, (res.hitX || res.hitZ) && wants);
  // fall damage
  const climbing = (T.climbs && (res.hitX || res.hitZ)) || m.onLadder;
  if (m.onGround || m.inWater || climbing) {
    if (m.onGround && !wasGround && !T.slowFall && !m.inWater) {
      const fall = m.fallStart - m.position.y;
      if (fall > 3.5) damageMob(m, Math.floor(fall - 3), null, false, "a fall", { force: true });
    }
    m.fallStart = m.position.y;
  } else if (m.position.y > m.fallStart) m.fallStart = m.position.y;
  }
  }
  keepFrame(m);   // (ridden and boat-borne ones are kept on the canonical square by their rider or boat; this is then a no-op)
  if (m.dead) return;

  // ---- daylight burning ----
  let burning = false;
  if (T.burns && !m.inWater && skyLight() > 0.55 && !isNight()) {
    if (skyAt(m.position.x, m.position.y + m.height - 0.1, m.position.z).open &&
        !(BF.weather && BF.weather.rainingAt && BF.weather.rainingAt(m.position.x, m.position.y + m.height, m.position.z))) { // rain/snow shields undead
      burning = true;
      ai.burnT += dt;
      if (ai.burnT >= 1) { ai.burnT = 0; damageMob(m, 1, null, false, "sunlight", { force: true }); }
    }
  }
  m.onFire = burning && !m.dead;
  if (m.dead) return;

  // ---- orientation ----
  const hs = Math.hypot(m.vel.x, m.vel.z);
  let targetYaw = m.yaw;
  if (m.rider) targetYaw = m.yaw;
  else if (_desired.faceTarget && playerAlive()) {
    const p = pAt(m);
    targetYaw = Math.atan2(p.x - m.position.x, p.z - m.position.z);
  } else if (_desired.faceX != null) targetYaw = Math.atan2(_desired.faceX - m.position.x, _desired.faceZ - m.position.z);
  else if (hs > 0.3 && m.knockT <= 0) targetYaw = Math.atan2(m.vel.x, m.vel.z);
  m.yaw = wrapAngle(m.yaw + Math.max(-7 * dt, Math.min(7 * dt, wrapAngle(targetYaw - m.yaw))));

  // head look (the angles; js/mobview.js turns the head)
  let hy = 0, hp = 0;
  if (m.rider) hp = -0.35;   // a ridden horse holds its head a little low, out of the rider's view
  else if (m.lookAt === "player" && playerAlive()) {
    const p = player(), e = seen(m.position, p.eyePos ? p.eyePos() : p.position, _sA);
    const dx = e.x - m.position.x, dz = e.z - m.position.z, dy = e.y - (m.position.y + m.height * 0.85);
    hy = wrapAngle(Math.atan2(dx, dz) - m.yaw);
    hp = Math.atan2(dy, Math.hypot(dx, dz));
  } else if (m.lookAt && m.lookAt.position) {
    const o = m.lookAt, op = seen(m.position, o.position, _sA), dx = op.x - m.position.x, dz = op.z - m.position.z;
    const dy = op.y + o.height * 0.85 - (m.position.y + m.height * 0.85);
    hy = wrapAngle(Math.atan2(dx, dz) - m.yaw);
    hp = Math.atan2(dy, Math.hypot(dx, dz));
  } else if (m.lookAt && typeof m.lookAt === "object") { hy = m.lookAt.yaw; hp = m.lookAt.pitch; }
  hy = Math.max(-1.1, Math.min(1.1, hy)); hp = Math.max(-0.7, Math.min(0.7, hp));
  const kk = Math.min(1, dt * 6);
  m.headYaw += (hy - m.headYaw) * kk; m.headPitch += (hp - m.headPitch) * kk;

  // ---- animation state (js/mobview.js draws it once per frame) ----
  const walkTarget = Math.min(1, hs / 1.4);
  m.walkAmt += (walkTarget - m.walkAmt) * Math.min(1, dt * 8);
  m.walkPhase += dt * (3 + hs * 3.2);
  m.tint = m.hurtT > 0 ? "red" : null;   // the hurt flash (a creeper's fuse flash and swell come from ai.fuse)
  if (m.type === "villager") {
    m.badgeLevel = Math.max(1, Math.min(5, m.level | 0 || 1));   // its level badge on the belt from level 2
    const f = toolHolders[m.profession];
    let id = null;
    if (f) { try { id = f(m); } catch (e) { id = null; } }
    m.held = id != null && BF.items[id] ? id : null;
  }
}

// ---------- drawing between ticks (spec r15-10) ----------
// The sim moves a mob once per 0.05 s tick. At the start of each tick keepPrev stores where it was (position, facing, head, walk
// cycle); js/mobview.js draws it every frame at lerp(prev, cur, alpha), alpha being how far the frame is into the next tick
// (BF.warp.alpha), so motion stays smooth at 60 fps or more.
// Moves wait for the end of the mob loop (spec r15-33): a mob's new position is put aside when its update ends and it stands where it
// started the tick until every mob has thought, so the others read start-of-tick positions (separation, targets, looks) whatever order
// mobs think in. A mob moved by another (a mount carrying its rider) after its own update keeps that move.
const moved = [];
function hold(m) {
  const q = m.prev, p = m.position;
  if (m.removed || !q) return;
  moved.push(m, p.x, p.y, p.z);
  p.x = q.x; p.y = q.y; p.z = q.z;
}
function commitMoves() {
  for (let i = 0; i < moved.length; i += 4) {
    const m = moved[i], p = m.position, q = m.prev;
    if (m.removed || p.x !== q.x || p.y !== q.y || p.z !== q.z) continue;
    p.x = moved[i + 1]; p.y = moved[i + 2]; p.z = moved[i + 3];
  }
  moved.length = 0;
}
function keepPrev(m) {
  const q = m.prev || (m.prev = { x: 0, y: 0, z: 0, yaw: 0, headYaw: 0, headPitch: 0, walkPhase: 0, walkAmt: 0, age: 0 });
  q.x = m.position.x; q.y = m.position.y; q.z = m.position.z;
  q.yaw = m.yaw; q.headYaw = m.headYaw; q.headPitch = m.headPitch; q.walkPhase = m.walkPhase; q.walkAmt = m.walkAmt; q.age = m.age;
}

// Held tools: a profession module registers toolHolders[profession] = m => item id (or null); the villager's `held` is set from it each
// update and js/mobview.js draws that tool in its folded hands. js/forester.js uses it for axes.
const toolHolders = {};

// Mobs bucketed in 2-block cells once per update (separate() looks at the 3 x 3 cells around a mob instead of every mob), and in
// 16-block cells (nearestMob). Keyed by the canonical cell, since mobs may be kept in other frames. A cell is { n, a }: its n mobs are
// a[0 .. n - 1]. r15-06: the grids are hash tables kept between updates (a new update bumps gen, which empties every cell at once, and
// writes over the cell arrays instead of making new ones: setting an array's length to 0 drops its storage), and only a mob near a face
// edge pays for canon().
const sepKey = (gx, gz) => (((gx & 0xffff) << 16) | (gz & 0xffff)) >>> 0;
class CellTable {
  constructor() { this.gen = 1; this.n = 0; this.size(10); }
  size(bits) { const n = 1 << bits; this.mask = n - 1; this.sh = 32 - bits; this.keys = new Int32Array(n); this.stamp = new Int32Array(n); this.cells = new Array(n).fill(null); }
  clear() { this.gen++; this.n = 0; }
  get(k) {
    k |= 0;
    const m = this.mask, g = this.gen;
    for (let i = Math.imul(k, 0x9e3779b1) >>> this.sh; ; i = (i + 1) & m) {
      if (this.stamp[i] !== g) return undefined;
      if (this.keys[i] === k) return this.cells[i];
    }
  }
  add(k, o) {
    k |= 0;
    if (this.n * 2 >= this.mask) this.grow();
    const m = this.mask, g = this.gen;
    let i = Math.imul(k, 0x9e3779b1) >>> this.sh;
    for (; this.stamp[i] === g; i = (i + 1) & m) if (this.keys[i] === k) { const c = this.cells[i]; c.a[c.n++] = o; return; }
    this.stamp[i] = g; this.keys[i] = k; this.n++;
    let c = this.cells[i];
    if (!c) c = this.cells[i] = { n: 0, a: [] };
    c.n = 0; c.a[c.n++] = o;
  }
  grow() {   // twice the slots, this update's cells carried over (arrays kept by their new slots)
    const { keys, stamp, cells, gen } = this, bits = 33 - this.sh;
    this.size(bits); this.n = 0;
    for (let i = 0; i < keys.length; i++) if (stamp[i] === gen) {
      let j = Math.imul(keys[i], 0x9e3779b1) >>> this.sh;
      while (this.stamp[j] === gen) j = (j + 1) & this.mask;
      this.stamp[j] = gen; this.keys[j] = keys[i]; this.cells[j] = cells[i]; this.n++;
    }
  }
  entries() { const out = []; for (let i = 0; i < this.keys.length; i++) if (this.stamp[i] === this.gen) out.push([this.keys[i] >>> 0, this.cells[i]]); return out; }
}
const SEP = new CellTable(), CHUNK = new CellTable();
let sepGrid = SEP, chunkGrid = CHUNK, chunkCells = 0, gridFast = true;   // (the reference grids of test/mobgrid-compare.js swap in here)
function buildSepGrid() {
  if (!gridFast) return buildSepGridRef();
  SEP.clear(); CHUNK.clear();
  const mine = own();
  for (const o of list) {
    if (o.dead || o.removed || (mine && !mine(o))) continue;
    const x = o.position.x, z = o.position.z, gx = Math.floor(x / 2), gz = Math.floor(z / 2), hx = Math.floor(x / 16), hz = Math.floor(z / 16);
    if (inSquare(x, z, GRID_EDGE)) { SEP.add(sepKey(gx, gz), o); CHUNK.add(sepKey(hx, hz), o); }
    else { SEP.add(gridKey(gx, gz, 2), o); CHUNK.add(gridKey(hx, hz, 16), o); }
  }
  chunkCells = CHUNK.n;
}
// The builder before r15-06 (fresh Maps and cells, every key through canon()), kept for test/mobgrid-compare.js only.
const REF_SEP = new Map(), REF_CHUNK = new Map();
function buildSepGridRef() {
  REF_SEP.clear(); REF_CHUNK.clear();
  for (const o of list) {
    if (o.dead || o.removed) continue;
    const k = gridKey(Math.floor(o.position.x / 2), Math.floor(o.position.z / 2), 2);
    const a = REF_SEP.get(k);
    if (a) a.a[a.n++] = o; else REF_SEP.set(k, { n: 1, a: [o] });
    const k2 = gridKey(Math.floor(o.position.x / 16), Math.floor(o.position.z / 16), 16);
    const b = REF_CHUNK.get(k2);
    if (b) b.a[b.n++] = o; else REF_CHUNK.set(k2, { n: 1, a: [o] });
  }
  chunkCells = REF_CHUNK.size;
}
function separate(m, dt) {
  const gx = Math.floor(m.position.x / 2), gz = Math.floor(m.position.z / 2);
  const plain = gridFast && inSquare(m.position.x, m.position.z, GRID_EDGE);
  for (let cz = gz - 1; cz <= gz + 1; cz++) for (let cx = gx - 1; cx <= gx + 1; cx++) {
  const cell = sepGrid.get(plain ? sepKey(cx, cz) : gridKey(cx, cz, 2));
  if (cell) for (let i = 0; i < cell.n; i++) {
    const o = cell.a[i];
    if (o === m || o.dead) continue;
    const op = seen(m.position, o.position, _sA), dx = m.position.x - op.x, dz = m.position.z - op.z;
    const min = m.halfWidth + o.halfWidth;
    if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
    if (m.position.y > o.position.y + o.height || o.position.y > m.position.y + m.height) continue;
    const d = Math.hypot(dx, dz) || 0.01;
    m.vel.x += (dx / d) * 6 * dt; m.vel.z += (dz / d) * 6 * dt;
  }
  }
  if (playerAlive()) {
    const p = player(), pp = pAt(m);
    const dx = m.position.x - pp.x, dz = m.position.z - pp.z;
    const min = m.halfWidth + (p.halfWidth || 0.3);
    if (Math.abs(dx) < min && Math.abs(dz) < min && m.position.y < p.position.y + (p.height || 1.8) && p.position.y < m.position.y + m.height) {
      const d = Math.hypot(dx, dz) || 0.01;
      m.vel.x += (dx / d) * 8 * dt; m.vel.z += (dz / d) * 8 * dt;
    }
  }
}

// ---------- spawning ----------
// Needs a solid block below and air (not water/plants) for the mob's height.
function standable(x, y, z, hw, h) {
  const w = BF.world;
  if (y < BF.MIN_Y + 1 || y + Math.ceil(h) >= BF.H) return false;
  if (!w.isSolid(x, y - 1, z)) return false;
  for (let k = 0; k < Math.max(2, Math.ceil(h)); k++) if (w.getBlock(x, y + k, z) !== 0) return false;
  return !w.boxCollides(x + 0.5, y, z + 0.5, hw, h);
}
// A wild mob: one that belongs to no village and no other module's save (not a villager or golem of a village, not pen, coop, pasture, sty or
// paddock stock, not a horse, not in a boat). Wild mobs live in the world: stored with their chunk when it unloads, never removed by
// distance (js/wildlife.js).
function isWild(m) {
  if (!m || m.dead || m.removed || m.type === "villager" || m.def.village || m.def.herd) return false;
  // links (js/ids.js accessors: a registry lookup each) only when their id field is set
  return (m.villageId == null || !m.village) && (m.penVillageId == null || !m.penVillage) && (m.penKey == null || !m.pen) && (m.coopKey == null || !m.coop) &&
    (m.pastureKey == null || !m.pasture) && (m.styKey == null || !m.sty) && (m.ridingId == null || !m.riding);
}
// A young farm animal's size (js/herd.js users: calves, piglets): k 0 = born (half size, head hs0 times bigger) .. 1 = grown.
function setYoungSize(m, k, hs0) {
  const T = m && TYPES[m.type];
  if (!T) return;
  const s = 0.5 + 0.5 * k, h0 = hs0 == null ? 1.35 : hs0, hs = h0 + (1 - h0) * k;
  m.scale = s; m.headScale = hs;
  m.halfWidth = T.hw * (0.6 + 0.4 * k); m.height = T.h * (0.5 + 0.5 * k);
}
function countMobs() {
  let p = 0, h = 0;
  for (const m of list) if (!m.dead && !m.def.village && !m.def.herd && !m.pen && !m.pasture && !m.sty) { if (m.hostile) h++; else p++; }   // pen sheep are village stock, not wildlife
  return { p, h };
}
// A group of n wild animals of one type on the grass of chunk (cx, cz): its first-generation roll (js/wildlife.js). Returns how many were placed.
// The fenced animal buildings of the village layouts near (x, z) (pens, coops, pastures, sties, stables): [x0, z0, x1, z1] footprints with a
// block of margin, inclusive. Wild animals are never placed in them: a group rolled inside a pasture would be taken into its herd, past its limit.
const PEN_TYPES = new Set(["pen", "coop", "pasture", "sty", "stable"]);
function penBoxes(x, z, r = 160) {
  const out = [];
  let vs = [];
  try { vs = BF.worldgen && BF.worldgen.villagesNear ? BF.worldgen.villagesNear(x, z, r) : []; } catch (e) { return out; }
  for (const v of vs) for (const b of (v && v.buildings) || []) {
    if (!PEN_TYPES.has(b.type) || b.bx == null || !b.w || !b.d) continue;
    const x1 = b.bx + b.ax * (b.w - 1) + b.sx * (b.d - 1), z1 = b.bz + b.az * (b.w - 1) + b.sz * (b.d - 1);
    out.push([Math.min(b.bx, x1) - 1, Math.min(b.bz, z1) - 1, Math.max(b.bx, x1) + 1, Math.max(b.bz, z1) + 1]);
  }
  return out;
}
const inPenBox = (boxes, x, z) => boxes.some(q => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]);
function spawnGroup(type, cx, cz, n, r) {
  const w = BF.world, grass = BF.B.grass, T = TYPES[type], CS = BF.CS;
  if (!T || !ready || !w.chunks.has(cx + "," + cz)) return 0;
  if (!r) r = BF.rand.at("group", cx, cz);   // (js/wildlife.js passes the chunk's roll)
  const inChunk = (x, z) => Math.floor(x / CS) === cx && Math.floor(z / CS) === cz;
  const pens = penBoxes(cx * CS + 8, cz * CS + 8);
  const ok = (x, z) => { const y = w.heightAt(x, z); return y >= BF.MIN_Y + 1 && !inPenBox(pens, x, z) && w.getBlock(x, y, z) === grass && standable(x, y + 1, z, T.hw, T.h) ? y + 1 : null; };
  let x = null, z = null;
  for (let i = 0; i < 12 && x == null; i++) { const tx = cx * CS + irnd(r, 1, 14), tz = cz * CS + irnd(r, 1, 14); if (ok(tx, tz) != null) { x = tx; z = tz; } }
  if (x == null) return 0;
  let made = 0;
  for (let i = 0; i < n * 4 && made < n; i++) {
    const sx = x + (i === 0 ? 0 : irnd(r, -3, 3)), sz = z + (i === 0 ? 0 : irnd(r, -3, 3));
    if (!inChunk(sx, sz)) continue;
    const sy = ok(sx, sz);
    if (sy == null) continue;
    const taken = L => L.some(o => Math.abs(o.position.x - sx - 0.5) < 0.9 && Math.abs(o.position.z - sz - 0.5) < 0.9 && Math.abs(o.position.y - sy) < 2);
    if (vq("mobs.spawnSpot", taken(nearMobs({ x: sx + 0.5, z: sz + 0.5 }, 2)), taken)) continue;
    if (type === "horse" ? BF.horses && BF.horses.spawn(sx + 0.5, sy, sz + 0.5) : createMob(type, sx + 0.5, sy, sz + 0.5)) made++;   // a horse gets its record (js/horses.js)
  }
  return made;
}
function pickHostileType(r) {
  let x = r.next();
  for (const [t, wgt] of HOSTILE_WEIGHTS) { if ((x -= wgt) <= 0) return t; }
  return "zombie";
}
// ---------- monster spawning ----------
// Every loaded chunk has the same odds of a spawn try, however many chunks are loaded: each update makes tries in proportion to the loaded
// chunk count (a surface try per chunk every SURFACE_EVERY s while the sky is dark, a cave try per chunk every CAVE_EVERY s) and spreads them
// over random loaded chunks. Only the spot decides (darkness, block light 7 or less, open sky or cave cover, the dark-long-enough rule);
// js/wildlife.js adds the density cap of the spot's area and the buffer around the player, villagers and golems.
const SURFACE_EVERY = 8, CAVE_EVERY = 8, MAX_TRIES = 64;
let surfAcc = 0, caveAcc = 0, chunkArr = [], chunkArrT = 0;
function spawnMonsters(dt) {
  if (!playerAlive()) return;
  const W = BF.world;
  chunkArrT -= dt;
  if (chunkArrT <= 0 || !chunkArr.length) { chunkArrT = 1; chunkArr = [...W.chunks.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz); }   // sorted: a try's chunk doesn't hang on load order
  const n = chunkArr.length;
  if (!n) return;
  const dark = skyLightAt(BF.sky ? BF.sky.time || 0 : 0) <= SPAWN_LIGHT || stormy();
  if (dark) surfAcc += dt * n / SURFACE_EVERY; else surfAcc = 0;
  caveAcc += dt * n / CAVE_EVERY;
  const s = Math.min(MAX_TRIES, Math.floor(surfAcc)), c = Math.min(MAX_TRIES, Math.floor(caveAcc));
  surfAcc -= Math.floor(surfAcc); caveAcc -= Math.floor(caveAcc);
  // each try has its own stream, keyed by the tick and the try's number, that picks its chunk, mob and spot
  for (let i = 0; i < s; i++) { const r = BF.rand.at("surface", i, 0), ch = chunkArr[r.int(n)]; if (W.chunks.get(ch.key) === ch) trySurface(ch, r); }
  for (let i = 0; i < c; i++) { const r = BF.rand.at("cave", i, 0), ch = chunkArr[r.int(n)]; if (W.chunks.get(ch.key) === ch) tryCave(ch, r); }
}
// In the think phase a "spawn" request from "world" (r15-23): the density cap is checked again when it applies, with the tick's earlier spawns in.
function spawnHostile(type, x, y, z) {
  if (BF.wildlife && !BF.wildlife.mayHostile(x, y, z)) return null;
  return spawnLater("world", "monster:" + Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z), () => {
    if (BF.wildlife && !BF.wildlife.mayHostile(x, y, z)) return null;
    const m = createMob(type, x, y, z);
    if (m && BF.wildlife) BF.wildlife.spawned(m);
    return m;
  });
}
function trySurface(c, r) {
  const w = BF.world, CS = BF.CS, type = pickHostileType(r), T = TYPES[type];
  if (!T.spawns) return;   // switched off in this world (js/gameopts.js): the try is dropped, not re-picked, so the others spawn as often as before
  const x = c.cx * CS + irnd(r, 0, CS - 1), z = c.cz * CS + irnd(r, 0, CS - 1);
  const gy = w.heightAt(x, z);
  if (gy < BF.MIN_Y + 1 || !BF.OPAQUE[w.getBlock(x, gy, z)]) return;
  if (!standable(x, gy + 1, z, T.hw, T.h)) return;
  if (w.getBlockLight(x, gy + 1, z) > 7) return; // torch/lantern-lit ground stays safe
  if (!darkLongEnough(x, z, 1)) return;
  spawnHostile(type, x + 0.5, gy + 1, z + 0.5);
}
// a dark, covered air pocket in a random column of the chunk
function tryCave(c, r) {
  const w = BF.world, CS = BF.CS, type = pickHostileType(r), T = TYPES[type];
  if (!T.spawns) return;   // (as trySurface)
  const lx = irnd(r, 0, CS - 1), lz = irnd(r, 0, CS - 1), x = c.cx * CS + lx, z = c.cz * CS + lz;
  if (!c.top) return;
  const top = c.top[lz * CS + lx];
  if (top < BF.SEA - 40) return;
  const yMin = Math.max(BF.MIN_Y + 2, c.y0 + 1), yMax = Math.min(top - 3, c.y1 - 3);
  if (yMax <= yMin) return;
  for (let tries = 0; tries < 6; tries++) {
    const y = irnd(r, yMin, yMax);
    if (!standable(x, y, z, T.hw, T.h)) continue;
    if (!BF.OPAQUE[w.getBlock(x, y - 1, z)]) continue;
    const s = skyAt(x, y, z);
    if (s.level > CAVE_SKY) continue;   // sky light 7 or less (caves, deep forest shade): dark at any time of day
    if (!darkLongEnough(x, z, 0)) continue;   // ...unless a light went out or the cover was just built
    if (w.getBlockLight(x, y, z) > 7) continue; // lit caves are safe
    spawnHostile(type, x + 0.5, y, z + 0.5);
    return;
  }
}

// ---------- villages ----------
// Villages come from BF.worldgen.villagesNear (optional). Each is tracked once by its centre so villagers are
// not duplicated; villagers/golems removed by chunk unloading are replaced when the village loads again,
// but killed ones stay dead: rec.dead holds the roster slots of killed villagers, and rec.killed.iron_golem the golems killed
// (both saved as "dead:<village key>").
const villages = new Map();
const pendingDead = new Map();   // village key -> {v: [slot idx], info: [{i, name, prof, cause, day}], g: golems killed} from a loaded save, applied when the record appears
function deadSlots(rec) { return rec.dead || (rec.dead = new Set()); }
function applyDead(rec) {
  const d = pendingDead.get(rec.key);
  if (!d) return;
  pendingDead.delete(rec.key);
  for (const i of d.v || []) if (Number.isFinite(+i)) deadSlots(rec).add(+i);
  if (d.info.length) rec.deadInfo = d.info.concat(rec.deadInfo || []);
  if (rec.dead) rec.killed.villager = Math.max(rec.killed.villager || 0, rec.dead.size);
  if (d.g > 0) rec.killed.iron_golem = Math.max(rec.killed.iron_golem || 0, d.g);
}
let villageT = 0;
// Villager trading state by stable key (village "x,z" + roster slot index): kept while unloaded and saved with the world.
const villagerSaves = new Map();
function villagerKey(m) { return m.villageId && m.slot ? m.villageId + "#" + m.slot.idx : null; }
let restockT = 0;
function restockVillagers(dt) { // once per in-game day, never while someone is trading with the villager
  restockT -= dt;
  if (restockT > 0 || !BF.trades || !BF.sky) return;
  restockT = 2;
  for (const m of list) if (m.type === "villager" && !m.dead && !m.removed && !m.tradingWith && !m.child) { BF.trades.restock(m, BF.sky.day); if (BF.prices) BF.prices.tick(m, BF.sky.day); if (BF.market) BF.market.sync(m); }
}
const VILLAGERS_PER_VILLAGE = 24;   // roster cap of classic villages; villages of village generator 2 carry their own population (rec.pop, 2-100)
const EXPLORER_CHANCE = 0.7;   // per cartographer in the roster
const FORESTER_CHANCE = [0.95, 0.4];   // the first / second forester of a village (the second only in villages with 19+ buildings)
const FURNITURE_CHANCE = 0.8;  // villages generated with both a shepherd and a forester (js/furniture.js)
const MINER_CHANCE = 0.95;     // newly generated villages (js/miner.js)
const BEE_POP = 6;              // village generator 8: grass villages of this many villagers get a beekeeper (js/beekeeper.js)
const GLASS_CHANCE = 0.8;      // village generator 7: villages with natural sand within 64 blocks (js/glassmaker.js), as FURNITURE_CHANCE
const PIG_CHANCE = 0.6;        // village generator 8: grass villages of 10+ (js/pigfarmer.js)
// A village none of whose villagers has a saved state yet is being generated now: newly generated villages may get roster slots that older
// saved villages never had (the furniture maker), without a villager appearing in a village the player already knows. `slotKey` (a
// "<village key>#<idx>" key) counts as new too: the save already holds that very villager.
function freshVillage(key, slotKey) {
  if (slotKey && villagerSaves.has(slotKey)) return true;
  const pre = key + "#";
  for (const k of villagerSaves.keys()) if (k.startsWith(pre)) return false;
  return true;
}
// Villager AI work per step, averaged over about 5 game seconds: aiN counts villager AI updates, which the force-unload limit looks at
// (js/villagesim.js), so it acts the same on any machine (spec r15-16). aiAcc/aiEma is the same in wall-clock ms, for the debug screen only.
let aiAcc = 0, aiEma = 0, aiN = 0, aiWork = 0;
function aiTick(dt) { const k = Math.min(1, dt / 5); aiEma += (aiAcc - aiEma) * k; aiWork += (aiN - aiWork) * k; aiAcc = 0; aiN = 0; }
// Puts a villager back at its bed, else at its village centre (a forced stop of an errand).
function sendHome(m) {
  const b = m.bed, rec = m.village;
  let x = b ? b.x : rec ? rec.x : m.position.x, z = b ? b.z : rec ? rec.z : m.position.z;
  let y = b ? b.y : BF.worldgen.heightAt(x, z) + 1;
  const s = findStand(x, y, z, TYPES.villager);
  if (s) m.position.set(s[0], s[1], s[2]); else m.position.set(x + 0.5, y, z + 0.5);
  m.vel.set(0, 0, 0); m.ai.route = null; m.fallStart = m.position.y;
  return true;
}
function findStand(x, y, z, T) {
  x = Math.floor(x); z = Math.floor(z);
  const base = Math.floor(y);
  const dys = [0, 1, -1, 2, -2, 3, -3, 4];
  for (let r = 0; r <= 3; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    if (!BF.world.isLoaded(x + dx, z + dz)) continue;
    for (const dy of dys) if (standable(x + dx, base + dy, z + dz, T.hw, T.h)) return [x + dx + 0.5, base + dy, z + dz + 0.5];
  }
  return null;
}
// Deterministic villager roster for a village: one slot per bed, special buildings first, each with a profession.
function seededRand(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h ^= (BF.state && BF.state.seed) | 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SPECIAL_PROF = { library: () => "librarian", church: () => "cleric", smith: r => ["armorer", "weaponsmith", "toolsmith"][Math.floor(r() * 3)] };
function villageRoster(rec) {
  const r = seededRand("village:" + rec.key);
  const slots = [];
  // one villager per bed (houses without beds hold one, big ones two)
  rec.houses.forEach((h, i) => {
    const n = h && h.beds ? Math.max(1, h.beds.length) : h && h.type === "big" ? 2 : 1;
    for (let k = 0; k < n; k++) slots.push({ house: h, idx: i * 2 + k, bed: (h && h.beds && h.beds[k]) || null, prof: null });
  });
  if (!slots.length) slots.push({ house: null, idx: 0, prof: null });
  // special buildings first so they always get their tradesperson, then a seeded shuffle of the rest
  const special = slots.filter(sl => sl.house && SPECIAL_PROF[sl.house.type]);
  const rest = slots.filter(sl => !special.includes(sl));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const cap = rec.pop || VILLAGERS_PER_VILLAGE;
  const gen10 = (BF.state && BF.state.villages | 0) >= 10 && !!rec.pop;   // village generator 10: keepers come from the paddock plan (below), shepherds included   // the village's population (worldgen draws 2-100 and lays out a bed for each), 24 for classic villages
  // village generator 3: every village has a miner, a farmer, a forester and a toolsmith (stone and ore, food, wood, and the tools for all of
  // them), so nothing stalls
  const core = (BF.state && BF.state.villages | 0) >= 3 && !!rec.pop;
  let nBuilders = BF.builder ? Math.min(rec.nb >= 19 ? 2 : rec.nb >= 6 ? 1 : 0, Math.max(0, cap - 1)) : 0;   // builders count toward the cap
  if (core) nBuilders = Math.min(nBuilders, Math.max(0, cap - 4));   // ... but never in place of the core four
  // foresters (own seeded stream, drawn first so their places are kept free: a full village used to leave none): ~95% of villages get one
  let nF = 0;
  if (BF.forester) { const rf = seededRand("foresters:" + rec.key); for (const p of FORESTER_CHANCE.slice(0, rec.nb >= 19 ? 2 : 1)) if (rf() < p) nF++; }
  if (core && BF.forester) nF = Math.max(nF, 1);
  nF = Math.min(nF, Math.max(0, cap - nBuilders - 1));   // a tiny village still keeps one resident
  const ordered = special.concat(rest).slice(0, cap - nBuilders - nF);
  const used = {};
  for (const sl of ordered) if (sl.house && SPECIAL_PROF[sl.house.type]) { sl.prof = SPECIAL_PROF[sl.house.type](r); used[sl.prof] = (used[sl.prof] || 0) + 1; }
  // others cycle through a shuffled pool, least-used first, so nothing repeats while others are missing
  const pool = PROFESSIONS.filter(p => p !== "nitwit" && p !== "builder" && p !== "unemployed" && p !== "explorer" && p !== "forester" && p !== "furniture_maker" && p !== "miner" && p !== "stable_hand" && p !== "merchant" && p !== "poultry_keeper" && p !== "cowherd" && p !== "baker" && p !== "glassmaker" && p !== "beekeeper" && p !== "pig_farmer" && !(gen10 && p === "shepherd"));   // builders are never part of the shuffled pool: the roster of old saves must not shift
  let bag = [];
  for (const sl of ordered) {
    if (sl.prof) continue;
    if (r() < 0.1) { sl.prof = "nitwit"; continue; }
    if (!bag.length) {
      const min = Math.min(...pool.map(p => used[p] || 0));
      bag = pool.filter(p => (used[p] || 0) === min);
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    sl.prof = bag.pop();
    used[sl.prof] = (used[sl.prof] || 0) + 1;
  }
  // the core farmer and toolsmith: the last plain resident (a nitwit first) takes up the trade when the shuffle gave the village none
  const CORE_RES = ["farmer", "toolsmith"];
  if (core) for (const p of CORE_RES) {
    if (ordered.some(sl => sl.prof === p)) continue;
    const free = sl => !CORE_RES.includes(sl.prof), plain = sl => free(sl) && !(sl.house && SPECIAL_PROF[sl.house.type]);
    const back = ordered.slice().reverse();
    const sl = back.find(x => x.prof === "nitwit") || back.find(plain) || back.find(free);
    if (sl) sl.prof = p;
  }
  const loneCore = sl => core && CORE_RES.includes(sl.prof) && ordered.filter(x => x.prof === sl.prof).length < 2;   // the only farmer / toolsmith stays
  // builder slots go at the END with their own key range (<village key>#1000+n): other slots keep their persistence keys
  for (let k = 0; k < nBuilders; k++) ordered.push({ house: null, idx: 1000 + k, bed: null, prof: "builder" });
  // explorers: a village that has cartographers gets an explorer for each of them with 70% probability (own seeded stream, so nothing else shifts);
  // never in a village without a cartographer, never beyond the village cap. Own key range <village key>#1100+n.
  if (BF.explorer) {
    const re = seededRand("explorers:" + rec.key);
    let nE = 0;
    for (const sl of ordered) if (sl.prof === "cartographer" && re() < EXPLORER_CHANCE) nE++;
    if (rec.pop) {
      // a sized village has a bed for every villager, so the cap is always full: an explorer takes the place of the last shuffled
      // resident who is not a cartographer or a special-building tradesperson (explorers sleep in their tents), keeping the 70%
      for (let need = nE - (cap - nF - ordered.length), i = ordered.length - 1; need > 0 && i >= 0; i--) {
        const sl = ordered[i];
        if (sl.prof === "cartographer" || sl.prof === "builder" || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); need--;
      }
    }
    nE = Math.min(nE, Math.max(0, cap - nF - ordered.length));
    for (let k = 0; k < nE; k++) ordered.push({ house: null, idx: 1100 + k, bed: null, prof: "explorer" });
  }
  // foresters: key range <village key>#1200+n (their places were reserved above, so the village never exceeds its cap)
  for (let k = 0; k < nF; k++) ordered.push({ house: null, idx: 1200 + k, bed: null, prof: "forester" });
  // paddock keepers (village generator 10, idea-044): one per paddock of the village's plan (worldgen paddockPlan: count from size and native
  // animals, a weighted roll per paddock), keys <village key>#1970+k (js/jobs.js KEEPER_IDX). Each takes the place of the last plain resident,
  // never one of the core four or a special-building tradesperson; when none can make way, that paddock and its keeper are left out.
  if (gen10 && BF.worldgen && BF.worldgen.paddockPlan) {
    const kxz = String(rec.key || "").split(",").map(Number);
    const plan = kxz.length === 2 ? BF.worldgen.paddockPlan(kxz[0], kxz[1], rec.pop, rec.biomeId != null ? rec.biomeId : rec.wg ? rec.wg.biomeId : null) : [];
    plan.forEach((a, k) => {
      if (ordered.length >= cap) {
        let gone = false;
        for (let i = ordered.length - 1; i >= 0 && !gone; i--) {
          const sl = ordered[i];
          if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
          ordered.splice(i, 1); gone = true;
        }
        if (!gone) return;
      }
      ordered.push({ house: null, idx: 1970 + k, bed: null, prof: BF.worldgen.KEEPER_OF[a] });
    });
  }
  // furniture maker: a newly generated village with both a shepherd and a forester gets one with 80% probability (own seeded stream and key
  // <village key>#1300, so nothing else shifts). In a classic village it may take the village one past the cap of 24; in a sized village
  // it takes the place of the last plain resident (never the only shepherd), so the village keeps its size.
  if (BF.furniture && ordered.some(sl => sl.prof === "shepherd") && ordered.some(sl => sl.prof === "forester") && freshVillage(rec.key, rec.key + "#1300")
    && seededRand("furniture:" + rec.key)() < FURNITURE_CHANCE) {
    if (rec.pop && ordered.length >= cap) {
      const nShep = ordered.filter(sl => sl.prof === "shepherd").length;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && nShep < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); break;
      }
    }
    if (!rec.pop || ordered.length < cap) ordered.push({ house: null, idx: 1300, bed: null, prof: "furniture_maker" });
  }
  // miner: ~95% of newly generated villages (own seeded stream and key <village key>#1400, so nothing else shifts; villages the player already
  // knows keep their people). In a classic village it may take the village one past the cap; in a sized village it takes the place of the
  // last plain resident, so the village keeps its size.
  if (BF.miner && freshVillage(rec.key, rec.key + "#1400") && (seededRand("miner:" + rec.key)() < MINER_CHANCE || core) && cap >= 3) {
    if (rec.pop && ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      let gone = false;
      for (let i = ordered.length - 1; i >= 0 && !gone; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); gone = true;
      }
      // core: the miner may take any resident's place but the farmer's or toolsmith's, then the furniture maker's (a tiny village: miner, farmer, forester, toolsmith)
      for (let i = ordered.length - 1; core && i >= 0 && !gone; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || loneCore(sl)) continue;
        ordered.splice(i, 1); gone = true;
      }
      const fm = core && !gone ? ordered.findIndex(sl => sl.idx === 1300) : -1;
      if (fm >= 0) ordered.splice(fm, 1);
    }
    if (!rec.pop || ordered.length < cap) ordered.push({ house: null, idx: 1400, bed: null, prof: "miner" });
  }
  // poultry keeper: village generator 4 gives every village of 8 or more villagers one, with a coop beside its nesting box (js/poultry.js,
  // worldgen layoutVillage). Own key <village key>#1500, so nothing else shifts; it takes the place of the last plain resident, so the village keeps its size.
  if (!gen10 && (BF.state && BF.state.villages | 0) >= 4 && (rec.pop || 0) >= 8) {
    if (ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); break;
      }
    }
    if (ordered.length < cap) ordered.push({ house: null, idx: 1500, bed: null, prof: "poultry_keeper" });
  }
  // merchants (js/merchant.js): newly generated villages of 8 or more get one per 20 villagers, at least one (key range <village key>#1600+n,
  // so nothing else shifts; villages the player already knows keep their people). In a sized village each takes the place of the last plain
  // resident, so the village keeps its size; a classic village may go one past its cap.
  const nM = BF.merchant && cap >= 8 && freshVillage(rec.key, rec.key + "#1600") ? Math.max(1, Math.floor(cap / 20)) : 0;
  for (let k = 0; k < nM; k++) {
    if (rec.pop && ordered.length >= cap) {
      let gone = false;
      for (let i = ordered.length - 1; i >= 0 && !gone; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || sl.prof === "shepherd" || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); gone = true;
      }
      if (!gone) break;
    }
    ordered.push({ house: null, idx: 1600 + k, bed: null, prof: "merchant" });
  }
  // cowherd: village generator 5 gives every village of COWHERD_POP (10) or more villagers on grass (cows spawn only on grass) one, with a pasture
  // beside its milk churn (js/cowherd.js, worldgen layoutVillage). Own key <village key>#1700 (#1600+k are the trading caravans' merchants); it takes the place of the last plain resident.
  const ground = rec.ground != null ? rec.ground : rec.wg ? rec.wg.ground : null;
  if (!gen10 && (BF.state && BF.state.villages | 0) >= 5 && (rec.pop || 0) >= ((BF.worldgen && BF.worldgen.COWHERD_POP) || 10) && ground === 0) {
    if (ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); break;
      }
    }
    if (ordered.length < cap) ordered.push({ house: null, idx: 1700, bed: null, prof: "cowherd" });
  }
  // bakers: village generator 6 gives a village of BAKER_POP (15) or more villagers a baker per 15 villagers, each with a baker's oven placed by the
  // jobs plan (js/baker.js, js/jobs.js planVillage). Own keys <village key>#1800+k; each takes the place of the last plain resident.
  const BP = (BF.worldgen && BF.worldgen.BAKER_POP) || 15;
  const nB = (BF.state && BF.state.villages | 0) >= 6 && (rec.pop || 0) >= BP ? Math.floor(rec.pop / BP) : 0;
  for (let k = 0; k < nB; k++) {
    if (ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      let gone = false;
      for (let i = ordered.length - 1; i >= 0 && !gone; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); gone = true;
      }
      if (!gone) break;
    }
    ordered.push({ house: null, idx: 1800 + k, bed: null, prof: "baker" });
  }
  // glassmaker: village generator 7 gives a newly generated village with natural sand within 64 blocks (worldgen sandNear) a glassmaker 80% of
  // the time (own seeded stream and key <village key>#1900, so nothing else shifts), its glass kiln and a furnace placed by the jobs plan
  // (js/glassmaker.js, js/jobs.js planVillage). It takes the place of the last plain resident.
  const kxz = String(rec.key || "").split(",").map(Number);
  if ((BF.state && BF.state.villages | 0) >= 7 && BF.glassmaker && (rec.pop || 0) >= 4 && kxz.length === 2 && freshVillage(rec.key, rec.key + "#1900")
    && seededRand("glass:" + rec.key)() < GLASS_CHANCE && BF.worldgen && BF.worldgen.sandNear && BF.worldgen.sandNear(kxz[0], kxz[1], 64)) {
    if (ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); break;
      }
    }
    if (ordered.length < cap) ordered.push({ house: null, idx: 1900, bed: null, prof: "glassmaker" });
  }
  // beekeeper: village generator 8 gives a village of BEE_POP (6) or more villagers on grass a beekeeper (own key <village key>#1950; not #2000, where js/breeding.js keys its newborns), its honey
  // extractor, 2 beehives and a flower bed placed by the jobs plan by the farms (js/beekeeper.js, js/jobs.js planVillage). It takes the place of
  // the last plain resident.
  if ((BF.state && BF.state.villages | 0) >= 8 && BF.beekeeper && (rec.pop || 0) >= BEE_POP && ground === 0) {
    if (ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); break;
      }
    }
    if (ordered.length < cap) ordered.push({ house: null, idx: 1950, bed: null, prof: "beekeeper" });
  }
  // pig farmer: village generator 9 gives a village of PIG_POP (10) or more villagers on grass (forest and taiga villages are on grass too) a
  // pig farmer PIG_CHANCE (60%) of the time, drawn from the village key (own seeded stream, so nothing else shifts), with a sty beside its feed
  // trough (js/pigfarmer.js, worldgen layoutVillage, js/jobs.js planVillage). Own key <village key>#1960 (keys #2000 and up are newborns, js/breeding.js);
  // it takes the place of the last plain resident.
  if (!gen10 && (BF.state && BF.state.villages | 0) >= 9 && BF.pigFarmer && (rec.pop || 0) >= ((BF.worldgen && BF.worldgen.PIG_POP) || 10) && ground === 0
    && seededRand("pigs:" + rec.key)() < PIG_CHANCE) {
    if (ordered.length >= cap) {
      const count = p => ordered.filter(sl => sl.prof === p).length;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const sl = ordered[i];
        if (sl.idx >= 1000 || sl.prof === "cartographer" || (sl.prof === "shepherd" && count("shepherd") < 2) || (sl.house && SPECIAL_PROF[sl.house.type]) || loneCore(sl)) continue;
        ordered.splice(i, 1); break;
      }
    }
    if (ordered.length < cap) ordered.push({ house: null, idx: 1960, bed: null, prof: "pig_farmer" });
  }
  return ordered;
}

// Where a villager appears when its village loads and it is not restored exactly: by day a random spot inside the village within the leash of its
// bed (the village centre without one); at bedtime in its bed. null: no spot found (the house is used).
const LEASH = 40;
function scatterAt(rec, sl, v) {
  const b = sl.bed;
  if (bedtime()) return b ? findStand(b.x, b.y, b.z, TYPES.villager) : null;
  const cx = b ? b.x : v.x, cz = b ? b.z : v.z, r = BF.rand.at("scatter", cx, cz, null, sl.idx);
  for (let i = 0; i < 14; i++) {
    const a = r.next() * Math.PI * 2, d = LEASH * Math.sqrt(r.next());
    const x = Math.floor(cx + Math.cos(a) * d), z = Math.floor(cz + Math.sin(a) * d);
    if (v.minX != null && (x < v.minX || x > v.maxX || z < v.minZ || z > v.maxZ)) continue;
    if (!BF.world.isLoaded(x, z)) continue;
    const top = BF.world.heightAt(x, z);
    if (top - BF.worldgen.heightAt(x, z) >= 2) continue;   // a house (or a tree) stands there: not on its roof (bug-063)
    const at = findStand(x, top + 1, z, TYPES.villager);
    if (at && !roofLedge(at[0], at[1], at[2], TYPES.villager.hw)) return at;
  }
  return null;
}
const VQ = {};
// A village record, registered under its key (js/ids.js). members (its loaded villagers, golems and newborns) is an index for quick
// lookups, not part of the record: it isn't enumerable, so a copy of the record (a save, a worker) doesn't hold the mobs. A mob's own
// villageId says which village it belongs to.
function newVillageRec(key, v) {
  const rec = { key, x: v.x, y: v.y, z: v.z, biome: v.biome, houses: v.houses || [], killed: {}, angryT: 0, wg: v, nb: v.nb0 != null ? v.nb0 : (v.buildings || []).length, pop: v.pop || 0 };
  Object.defineProperty(rec, "members", { value: [], writable: true, enumerable: false, configurable: true });
  BF.ids.put(rec, key);
  return rec;
}
function updateVillages(dt) {
  for (const rec of villages.values()) rec.angryT = Math.max(0, rec.angryT - dt);
  villageT -= dt;
  if (villageT > 0) return;
  villageT = 1;
  const wg = BF.worldgen;
  if (!wg || typeof wg.villagesNear !== "function" || !playerAlive()) return;
  const pp = player().position;
  let vs;
  try { vs = wg.villagesNear(pp.x, pp.z, BF.villageSim ? BF.villageSim.RADIUS + 16 + 150 : 96) || []; } catch (e) { return; }   // by centre: sized villages are measured from their edge (js/villagesim.js)
  if (BF.villageSim && BF.villageSim.simulated) { const ks = new Set(vs.map(v => v && Math.round(v.x) + "," + Math.round(v.z))); for (const v of BF.villageSim.simulated()) if (!ks.has(Math.round(v.x) + "," + Math.round(v.z))) { ks.add(Math.round(v.x) + "," + Math.round(v.z)); vs.push(v); } }   // villages a merchant's trip keeps loaded (js/merchant.js) and the budget's extras (js/active.js), however far
  for (const v of vs) {
    if (!v || v.x == null) continue;
    const key = Math.round(v.x) + "," + Math.round(v.z);
    let rec = villages.get(key);
    if (!rec) { rec = newVillageRec(key, v); villages.set(key, rec); applyDead(rec); }
    const lp = BF.planet.local(v, pp, VQ);   // (the player seen from the village, across a face edge)
    const away = v.pop ? Math.hypot(Math.max(0, v.minX - lp.x, lp.x - v.maxX), Math.max(0, v.minZ - lp.z, lp.z - v.maxZ)) > 24   // sized villages: near any part of it
      : Math.hypot(v.x - lp.x, v.z - lp.z) > 80;
    if (away && !(BF.villageSim && BF.villageSim.isActive(key))) continue;   // far villages run while their chunks are kept (villagesim.js)
    if (!BF.world.isLoaded(v.x, v.z)) continue;
    const loadedHouse = h => BF.world.isLoaded(h.x, h.z) && BF.world.isLoaded(h.x + (h.w || 1), h.z + (h.d || 1));
    rec.members = rec.members.filter(m => !m.removed);
    const alive = t => rec.members.filter(m => m.type === t && !m.dead && !m.bred).length;   // newborns (js/breeding.js) are not roster slots
    if (!rec.roster) rec.roster = villageRoster(rec);
    const dead = deadSlots(rec);
    const wantV = rec.roster.filter(sl => !dead.has(sl.idx)).length;
    let haveV = alive("villager");
    if (rec.style == null) rec.style = typeof v.style === "number" ? v.style : styleAt(v.x, v.z);
    const taken = new Set(rec.members.filter(m => m.type === "villager" && !m.dead).map(m => m.slot));
    for (const sl of rec.roster) {
      if (haveV >= wantV) break;
      if (taken.has(sl) || dead.has(sl.idx)) continue;   // never respawn a killed villager in place of a living one
      const H = sl.house;
      const snap = BF.mobSave ? BF.mobSave.peek(rec.key + "#" + sl.idx) : null;   // quit and reload: back exactly where it was (js/mobsave.js)
      if (snap === "wait") continue;
      let at = null, offRoof = false;
      if (snap) at = standable(Math.floor(snap.p[0]), Math.floor(snap.p[1]), Math.floor(snap.p[2]), TYPES.villager.hw, TYPES.villager.h) ? snap.p.slice() : findStand(snap.p[0], snap.p[1], snap.p[2], TYPES.villager);
      // saved up on a roof (before bug-063): back on the ground instead. The saved spot itself, not the stand found near it: the snapshot
      // puts the villager back on its saved spot anyway, and one saved in a doorway can have its nearest stand up on the roof above.
      if (at && roofLedge(snap.p[0], snap.p[1], snap.p[2], TYPES.villager.hw)) {
        if (BF.glog) BF.glog.log("INFO", "mobs", "villager " + sl.prof + " saved on a roof: placed on the ground instead", { village: rec, at: snap.p });
        at = null; offRoof = true;
      }
      let scattered = false;
      if (!at && villagerSaves.has(rec.key + "#" + sl.idx) && (at = scatterAt(rec, sl, v))) scattered = !bedtime();   // (a village's first load is not a return: its villagers start at home)
        // otherwise: by day a random spot within the leash of its bed, at night in the bed
      if (!at) {
        if (H && !loadedHouse(H)) continue;
        const r = BF.rand.at("vspawn", v.x, v.z, null, sl.idx);
        const sx = H ? H.x + (H.w || 1) / 2 : v.x + rnd(r, -6, 6), sz = H ? H.z + (H.d || 1) / 2 : v.z + rnd(r, -6, 6);
        const sy = H && H.y != null ? H.y : (v.y != null ? v.y : BF.world.heightAt(sx, sz) + 1);
        at = findStand(sx, sy, sz, TYPES.villager);
        if (!at && H && H.doorX != null) at = findStand(H.doorX, sy, H.doorZ, TYPES.villager);
      }
      if (!at) continue;
      haveV++;
      spawnLater(rec.key, "s:" + rec.key + "#" + sl.idx, () => {   // a "spawn" request from the village in the think phase (r15-23)
        if (rec.members.some(o => o.slot === sl && !o.dead && !o.removed)) return null;
        const m = createMob("villager", at[0], at[1], at[2], sl.prof, rec.style);
        m.village = rec; m.home = H; m.slot = sl; m.bed = sl.bed; rec.members.push(m);
        BF.rand.seed(m, "villager:" + rec.key + "#" + sl.idx + ":" + (rec.killed.villager || 0));   // its slot's stream (a death in the village moves it on); a saved one wins (js/trading.js unpack)
        m.ai.leaving = !bedtime() && !scattered; // spawned indoors by day: walk out through the door
        const sv = villagerSaves.get(villagerKey(m));
        if (sv) BF.trades.unpack(m, sv); // inventory/level/xp survive unload/reload and saved games
        if (m.bed && m.bed.claimed) m.home = homeOfBed(rec, m.bed) || m.home;   // a bed it claimed (saved): that house is home now
        if (BF.jobs) BF.jobs.onSpawn(m, rec, sv);   // jobsite claim / saved profession (js/jobs.js)
        if (sl.prof === "builder" && BF.builder) BF.builder.onSpawn(m, rec, sv);
        if (snap && snap.p) { BF.mobSave.apply(m, snap); BF.mobSave.done(rec.key + "#" + sl.idx); if (offRoof) { m.position.set(at[0], at[1], at[2]); m.fallStart = at[1]; m.ai.route = null; } }
        if (BF.explorer && BF.explorer.onSpawn) BF.explorer.onSpawn(m);   // back in its tent for the rest of the night, or the tent back in its pack
        return m;
      });
    }
    const wantG = (rec.pop ? Math.max(1, Math.round(rec.pop / 15)) : rec.houses.length >= 12 ? 2 : 1) - (rec.killed.iron_golem || 0);   // sized villages: a golem per ~15 villagers
    if (alive("iron_golem") < wantG) {
      const gy = v.y != null ? v.y : BF.world.heightAt(v.x, v.z) + 1;
      const gs = BF.mobSave ? BF.mobSave.golem(rec.key) : null;
      const at = (gs && findStand(gs.p[0], gs.p[1], gs.p[2], TYPES.iron_golem)) || findStand(v.x, gy, v.z, TYPES.iron_golem) || findStand(v.x + 3, BF.world.heightAt(v.x + 3, v.z) + 1, v.z, TYPES.iron_golem);
      if (at) spawnLater(rec.key, "golem:" + rec.key, () => { const g = createMob("iron_golem", at[0], at[1], at[2]); g.village = rec; rec.members.push(g); if (gs) BF.mobSave.apply(g, gs); return g; });
    }
  }
}

function despawn(dt) {
  if (!BF.player || !BF.player.position) return;
  const pp = BF.player.position;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.riding && BF.world.isLoaded(m.position.x, m.position.z)) continue;   // a mob in a boat stays with it (js/boats.js stows it when its chunk unloads)
    const wild = isWild(m);
    if (!BF.world.isLoaded(m.position.x, m.position.z)) { if (wild && BF.wildlife) BF.wildlife.stow(m); removeMob(m); continue; }   // a wild mob that walked off the loaded land waits with its chunk
    const d = seen(m.position, pp, _sA).distanceTo(m.position);
    const vv = m.village || m.penVillage, simmed = !!(vv && BF.villageSim && BF.villageSim.isActive(vv.key));   // villagers of a far simulated village stay
    if (d > DESPAWN_DIST && !simmed && !m.village && !wild && !m.def.herd) { removeMob(m); continue; }   // a village's own mobs go with the village (BF.mobs.unloadVillage), wild ones with their chunk, not by distance
  }
}

// ---------- ray vs mobs ----------
function rayAABB(o, d, mn, mx) {
  let t0 = 0, t1 = Infinity;
  const os = [o.x, o.y, o.z], ds = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-9) { if (os[a] < mn[a] || os[a] > mx[a]) return null; continue; }
    let ta = (mn[a] - os[a]) / ds[a], tb = (mx[a] - os[a]) / ds[a];
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

// ---------- public API ----------
BF.mobs = {
  shapeAi, MOB_FIELDS, AI_FIELDS,   // one mob layout (test/mob-shape.js, js/mobsave.js)
  list,
  toolHolders,   // profession -> (villager => item id of the tool drawn in its hands, or null): sets the villager's `held`
  types: Object.keys(TYPES),
  isHostile: t => !!(TYPES[t] && TYPES[t].hostile),   // the type table's flag (js/player.js on the client's mirror, r15-38)
  // spec r15-31, for the animal modules: near(p, r, local) -> the mobs a scan within r blocks of p must look at (see nearMobs);
  // checkScan(label, got, scan) -> got, checked against scan(BF.mobs.list) when BF.regions.verifyQueries is on (see vq);
  // ofType(type) -> the mobs of one type, in list order (a copy).
  near: (p, r, local) => nearMobs(p, r, local),
  checkScan: (label, got, scan) => vq(label, got, scan),
  ofType: t => ofType(t),
  // The mob grids for test/mobgrid-compare.js (r15-06): ref(true) switches buildSepGrid and the lookups to the pre-r15-06 builder.
  // cells() lists each grid's non-empty cells (key -> mobs); separate(m, dt) returns the push it gives m's velocity (m.vel is restored).
  grid: {
    ref(on) { gridFast = !on; sepGrid = on ? REF_SEP : SEP; chunkGrid = on ? REF_CHUNK : CHUNK; },
    build: () => buildSepGrid(),
    cells() { const f = g => (g instanceof Map ? [...g] : g.entries()).map(([k, c]) => [k, c.a.slice(0, c.n)]); return { sep: f(sepGrid), chunk: f(chunkGrid) }; },
    nearest: (m, r, pred) => nearestMob(m, r, pred),
    separate(m, dt) { const x = m.vel.x, z = m.vel.z; separate(m, dt); const d = [m.vel.x - x, m.vel.z - z]; m.vel.x = x; m.vel.z = z; return d; },
  },
  init(sceneRef) {
    ready = true;   // (mobs, arrows and effects are drawn by js/mobview.js and js/entityview.js)
    if (BF.mobView) BF.mobView.init(sceneRef);
    BF.world.onChunkUnload((cx, cz) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        let mx = m.position.x, mz = m.position.z;   // (by its canonical cell: it may be kept in another face's frame)
        { const c = BF.planet.canon(mx, mz, GC); if (!c.off) { mx = c.x; mz = c.z; } }
        if (Math.floor(mx / BF.CS) === cx && Math.floor(mz / BF.CS) === cz) { if (BF.wildlife && isWild(m)) BF.wildlife.stow(m); removeMob(m); }   // a wild mob is stored with its chunk (js/wildlife.js)
      }
      for (let i = arrows.length - 1; i >= 0; i--) {
        const a = arrows[i];
        if (Math.floor(a.pos.x / BF.CS) === cx && Math.floor(a.pos.z / BF.CS) === cz) arrows.splice(i, 1);
      }
    });
    if (BF.wildlife) BF.wildlife.init();
  },
  update(dt) {
    if (!ready) return;
    dt = Math.min(dt, 0.05);
    planBudget = 2; // A* searches per frame outside the mob loop
    grantPlans();   // and the mob loop's (spec r15-33)
    // the region index (r15-30) up to date before the mobs query it (spec r15-31): main.js syncs it after each step, but tests and tools
    // step BF.mobs.update on its own, and move mobs between steps
    if (BF.regions) BF.regions.tick();
    // the villager-seconds meter (js/perf.js): each lap charges the time since the last to a category; nothing while it's off
    const PF = BF.perf, PC = PF.C, pon = PF.on;
    buildSepGrid();
    PF.lap(PC.other);
    // wild mobs and monsters beyond FAR_R blocks (or the view distance, if nearer) think FAR_HZ times a game second, each update covering the
    // time since the last one (idea-037: mobs live in the whole loaded world); spread out so they don't all update on the same frame
    const pp = BF.player && BF.player.position, farR = Math.min(FAR_R, BF.world.viewDist * BF.CS), far2 = farR * farR;
    const mine = own();
    for (const m of list) if (!mine || mine(m)) keepPrev(m);   // where each mob was before this tick, for drawing between ticks (js/mobview.js)
    // region by region from the shared queue, each region's mobs in id order (spec r15-33, js/regiontick.js); "list" order on request
    // with several workers (spec r15-39, js/rworkers.js) this worker thinks only the regions it owns; the others' changes come after the loop
    // with clusters (spec r15-39b, js/ctick.js) only the running cluster's mobs
    const RW = BF.rworkers;
    let order = BF.rtick ? BF.rtick.plan(list) : list.slice();
    if (mine) order = order.filter(mine);
    for (const m of RW && RW.active ? RW.beginThink(order) : order) {
      if (RW && RW.active) RW.thinking(m);
      if (m.removed) continue;
      let h = dt;
      if (pp && !m.riding && !m.rider && (m.hostile || isWild(m) || (m.horse && !m.horse.owner))) {
        const q = seen(m.position, pp, _sA), dx = m.position.x - q.x, dz = m.position.z - q.z;
        if (dx * dx + dz * dz > far2) {
          if (m._farT == null) m._farT = R(m).next() / FAR_HZ;
          m._farT += dt;
          if (m._farT < 1 / FAR_HZ) continue;
          h = m._farT; m._farT = 0;
        } else m._farT = null;
      }
      curMob = BF.rand.thinker = m;
      try { updateMob(m, h); } catch (e) { console.error(e); removeMob(m); }
      curMob = BF.rand.thinker = null;
      hold(m);
      if (pon) PF.lap(PF.mobCat(m));
    }
    commitMoves();
    if (RW && RW.active) RW.afterThink();   // the other workers' mobs and requests (js/rworkers.js)
    // the systems after the loop, each by name (clusters, js/ctick.js: per cluster once converted, else once a tick)
    const C = BF.ctick, sys = C && C.on ? C.sys : (n, f) => f();
    sys("arrows", () => updateArrows(dt));
    PF.lap(PC.other);
    if (BF.builder) sys("builder", () => BF.builder.tick(dt));
    if (BF.villageLife) sys("villageLife", () => BF.villageLife.tick(dt));   // villager meals, farm scans (js/villagelife.js)
    if (BF.jobs) sys("jobs", () => BF.jobs.tick(dt));   // jobsite validation, unemployed villagers look for work (js/jobs.js)
    if (BF.breeding) sys("breeding", () => BF.breeding.tick(dt));   // encounters, hearts, children (js/breeding.js)
    if (BF.storage) sys("storage", () => BF.storage.tick(dt));   // chest owners: empty chests and those of dead villagers are freed (js/storage.js)
    PF.lap(PC.villagers);
    if (BF.shepherd) sys("shepherd", () => BF.shepherd.tick(dt));   // sheep feeding, breeding, wool regrowth, pen stock (js/shepherd.js)
    if (BF.horses) sys("horses", () => BF.horses.tick(dt));   // herds, foals, horses waiting in unloaded chunks (js/horses.js)
    if (BF.stables) sys("stables", () => BF.stables.tick(dt));   // stable hands' horse offers, foal log lines (js/stables.js)
    if (BF.poultry) sys("poultry", () => BF.poultry.tick(dt));   // chickens growing up, laying, coop stock (js/poultry.js)
    if (BF.cowherd) sys("cowherd", () => BF.cowherd.tick(dt));   // calves growing up, pasture stock (js/cowherd.js)
    if (BF.pigFarmer) sys("pigFarmer", () => BF.pigFarmer.tick(dt));   // piglets growing up, sty stock (js/pigfarmer.js)
    PF.lap(PC.vanimals);
    if (BF.baker) sys("baker", () => BF.baker.tick(dt));   // event hooks (js/baker.js)
    if (BF.explorer && BF.explorer.tick) sys("explorer", () => BF.explorer.tick(dt));   // tents of explorers that unloaded while camping (js/explorer.js)
    PF.lap(PC.villagers);
    if (BF.mobs.spawning !== false) sys("spawn", () => spawnMonsters(dt));   // animals are never spawned around the player: chunks roll them once and they breed (js/wildlife.js)
    PF.lap(PC.monsters);
    if (BF.wildlife) sys("wildlife", () => BF.wildlife.update(dt));
    PF.lap(PC.wild);
    sys("villages", () => { try { updateVillages(dt); } catch (e) { console.error(e); } });
    sys("restock", () => { try { restockVillagers(dt); } catch (e) { console.error(e); } });
    if (BF.merchant) sys("merchant", () => { try { BF.merchant.tick(dt); } catch (e) { console.error(e); } });
    PF.lap(PC.villagers);
    sys("despawn", () => despawn(dt));
    sys("aiTick", () => aiTick(dt));
    if (BF.mobSave) sys("mobSave", () => BF.mobSave.update(dt));
    PF.lap(PC.other);
  },
  // Nearest living mob whose AABB the ray hits within maxDist: {mob, dist} or null.
  raycast(origin, dir, maxDist, skip) { return vq("mobs.raycast", raycastIn(nearMobs(origin, maxDist + 2, true), origin, dir, maxDist, skip), L => raycastIn(L, origin, dir, maxDist, skip)); },
  // Player attack. Returns true if the hit landed (false while the mob is briefly invulnerable).
  hit(mob, damage, knockDir) { return damageMob(mob, damage, knockDir, true); },
  // Player bow shot (js/player.js): see shootPlayerArrow. arrows() lists the player's arrows in flight or stuck (tests, debug).
  shootArrow(from, vel, opts) { return ready ? shootPlayerArrow(from, vel, opts) : null; },
  playerArrows() { return arrows.filter(a => a.byPlayer); },
  arrowList() { return arrows; },   // every arrow in flight or stuck: {pos, vel, look, stuck, ...} (js/entityview.js draws them)
  hurt(mob, damage, cause, by) { return damageMob(mob, damage, null, false, cause, { force: true, from: by }); },   // non-player damage with a cause (tests, commands; by = the mob doing it)
  // A villager killing its own stock (shepherd, poultry keeper, cowherd, pig farmer): then() (its loot) runs once the kill has happened, at
  // once outside the think phase, else when the request's result is delivered (r15-23). Returns false if the mob can't be hurt now.
  cull(mob, cause, by, then) {
    const r = damageMob(mob, 999, null, false, cause, { force: true, from: by });
    if (!r) return false;
    if (r === true) { if (mob.dead && then) then(); return mob.dead; }
    if (then) r.then(x => { if (x && x.killed) then(); });
    return true;
  },
  strike,   // strike(m, o, dmg, knockDir?): m's melee hit on o (tests)
  // /kill (commands.js): kills outright, no knockback, no golem anger; drops as a normal death. Returns false if already dead.
  kill(mob) { if (!mob || mob.dead || mob.removed) return false; kill(mob, true); return true; },
  // Debug helper: spawn a mob with its feet at (x, y, z). Villagers take a profession and a style
  // ("plains" | "desert" | "snowy" | "savanna" | "taiga" or 0..4; default from the biome).
  spawn(type, x, y, z, variant, style) { return ready ? createMob(type, x, y, z, variant, style) : null; },
  makers, maker: (name, fn) => { makers[name] = fn; },   // maker(name, (...args) -> [make, check]): a spawnLater's make from plain data (r15-39)
  spawnLater,   // spawnLater(from, place, make, check?, maker?): make() now, or as a "spawn" request in the think phase (r15-23) that runs make() if check()
                // still holds when it applies; returns the mob, or null when queued
  // Removes a mob quietly: no death, no drops (js/gameopts.js: monsters switched off in the world).
  discard(m) { if (m && !m.removed) removeMob(m); },
  blank: blankMob, filled: filledMob,   // (several workers, js/cworkers.js)
  explode(m) { if (m && !m.removed && !m.dead) explode(m); },   // a creeper's blast now (tests): in the think phase, one request per region it reaches
  // The share of monster spawn weight whose type spawns (1 with all on): js/wildlife.js scales its area caps by it.
  spawnTypes: () => Object.keys(TYPES).filter(t => typeof TYPES[t].spawns === "boolean"),   // the switchable monsters (js/gameopts.js)
  spawnShare() { let all = 0, on = 0; for (const [t, w] of HOSTILE_WEIGHTS) { all += w; if (TYPES[t].spawns) on += w; } return all ? on / all : 1; },
  // Wild mobs (js/wildlife.js): which mobs count as wild, a first-generation group, a standable spot near (x, y, z), the sky over a spot.
  isWild, spawnGroup, penBoxes, inPenBox, standable, roofLedge, findPath, findPathFast, findPathOld, routeCost, pathsAgree, pathStatsReset,   // findPath(sx, sy, sz, {x, z, at(x, y, z)}, maxNodes, tall): A* route cells (tests); the Fast/Old pair and routeCost for test/findpath-compare.js
  findStand(x, y, z, type) { return TYPES[type] ? findStand(x, y, z, TYPES[type]) : null; },
  skyOpen(x, y, z) { return !!skyAt(x, y, z).open; }, skyDark(x, y, z) { return skyAt(x, y, z).level <= CAVE_SKY; }, typeDef: type => TYPES[type] || null, passiveTypes: PASSIVE_TYPES,
  villages,
  // A mob's links, read from its ids (js/ids.js): work on a plain copy of a mob too (a save, a worker), where m.village is not there.
  villageOf: m => m ? BF.ids.get(m.villageId) : undefined,
  homeOf: m => m ? BF.ids.get(m.homeKey) : undefined,
  bedOf: m => m ? BF.ids.get(m.bedKey) : undefined,
  slotOf: m => m ? BF.ids.get(m.slotKey) : undefined,
  penOf: m => m ? BF.ids.get(m.penKey || m.styKey || m.coopKey || m.pastureKey) : undefined,
  byId: id => BF.ids.get(id),
  newVillageRec,
  // A village that stops (js/villagesim.js): all its villagers, golems and owned animals leave together (their trading state is kept).
  aiTime: () => aiEma,
  aiWork: () => aiWork,
  sendHome,
  unloadVillage(key) {
    const rec = villages.get(key);
    if (!rec) return 0;
    let n = 0;
    for (const m of list.slice()) if (m.villageId === key || m.penVillageId === key) { if (BF.mobSave && BF.mobSave.stash && m.village === rec) BF.mobSave.stash(m); removeMob(m); n++; }   // written down where it stands: back exactly after a short absence
    rec.members = [];
    return n;
  },
  // Villager trading state for saved games: {key -> {inv, level, xp, day}} (see CONTRACT.md); loaded ones override stored.
  exportVillagers() {
    const out = {};
    for (const [k, v] of villagerSaves) out[k] = v;
    for (const m of list) if (m.type === "villager" && !m.dead && m.inv) { const k = villagerKey(m); if (k) out[k] = BF.trades.pack(m); }
    if (BF.bridges) BF.bridges.exportAll(out);   // "cross:<village key>" -> river crossings counted in the last 3 days (js/bridges.js)
    if (BF.builder) BF.builder.exportAll(out);   // "built:<village key>" -> structures the builders have placed (progress included)
    if (BF.villageLife) BF.villageLife.exportAll(out);   // "farmbeds:<village key>" -> beds the farmers are making or growing
    if (BF.breeding) BF.breeding.exportAll(out);   // newborns "<village key>#2000+k" (+ .bred), "breeding:cd"
    if (BF.shepherd) BF.shepherd.exportAll(out);   // "pens:<village key>" -> the sheep of each village pen
    if (BF.poultry) BF.poultry.exportAll(out);   // "coops:<village key>" -> the chickens and nest eggs of each coop
    if (BF.cowherd) BF.cowherd.exportAll(out);   // "pastures:<village key>" -> the cows of each pasture
    if (BF.pigFarmer) BF.pigFarmer.exportAll(out);   // "sties:<village key>" -> the pigs of each sty
    if (BF.stables && BF.stables.exportAll) BF.stables.exportAll(out);   // "stables:stocked" -> villages whose generated stable got its starting horses
    if (BF.baker) BF.baker.exportAll(out);   // "ovens" -> what each baker's oven holds
    if (BF.villageSim) BF.villageSim.exportSeen(out);   // "seen:<village key>" -> game day it was last simulated, "pin:<trip>" -> trips on the road
    if (BF.merchant) BF.merchant.exportAll(out);   // "caravans" -> routes and path wear (js/merchant.js)
    if (BF.explorer && BF.explorer.exportAll) BF.explorer.exportAll(out);   // "explorer:camps" -> camps and tents left behind (js/explorer.js)
    for (const [k, d] of pendingDead) out["dead:" + k] = d;   // "dead:<village key>" -> {v: roster slots of killed villagers, info: who they were}
    for (const rec of villages.values()) {
      const v = rec.dead ? [...rec.dead] : [];
      const g = rec.killed.iron_golem || 0;
      if (v.length || g || (rec.deadInfo && rec.deadInfo.length)) out["dead:" + rec.key] = g ? { v, info: rec.deadInfo || [], g } : { v, info: rec.deadInfo || [] };
      for (const i of v) delete out[rec.key + "#" + i];
    }
    return out;
  },
  importVillagers(o) {
    villagerSaves.clear();
    if (o && typeof o === "object") for (const k in o) if (k.slice(0, 6) !== "built:" && k.slice(0, 6) !== "cross:" && k.slice(0, 5) !== "seen:" && k.slice(0, 5) !== "pens:" && k.slice(0, 9) !== "farmbeds:" && k.slice(0, 8) !== "farmdig:" && k.slice(0, 5) !== "dead:" && k.slice(0, 4) !== "pin:" && k !== "caravans" && k !== "ovens" && k !== "stables:stocked" && k !== "explorer:camps") villagerSaves.set(k, o[k]);
    for (const v of villagerSaves.values()) if (v && v.id) BF.ids.seen(v.id);   // new ids start past the saved villagers
    pendingDead.clear();
    if (o && typeof o === "object") for (const k in o) if (k.slice(0, 5) === "dead:" && o[k] && typeof o[k] === "object") pendingDead.set(k.slice(5), { v: Array.isArray(o[k].v) ? o[k].v : [], info: Array.isArray(o[k].info) ? o[k].info.filter(e => e && typeof e === "object") : [], g: Math.max(0, Math.floor(+o[k].g || 0)) });
    for (const rec of villages.values()) applyDead(rec);
    if (BF.villageSim) BF.villageSim.importSeen(o);
    if (BF.bridges) BF.bridges.importAll(o);
    if (BF.builder) BF.builder.importAll(o);
    if (BF.villageLife) BF.villageLife.importAll(o);
    if (BF.jobs) BF.jobs.importAll(o);   // jobsite claims of saved villagers
    if (BF.breeding) BF.breeding.importAll(o);
    if (BF.explorer && BF.explorer.importAll) BF.explorer.importAll(o);
    if (BF.shepherd) BF.shepherd.importAll(o);
    if (BF.poultry) BF.poultry.importAll(o);
    if (BF.cowherd) BF.cowherd.importAll(o);
    if (BF.pigFarmer) BF.pigFarmer.importAll(o);
    if (BF.stables && BF.stables.importAll) BF.stables.importAll(o);
    if (BF.baker) BF.baker.importAll(o);
    if (BF.merchant) BF.merchant.importAll(o);
  },
  // Right-click on a mob (called by the player module). Opens the trade screen when the inventory module has one
  // (returns null); otherwise falls back to a simple 3 wheat -> 1 emerald trade and returns a message string.
  interact(mob) {
    if (!mob || mob.dead || mob.removed || mob.type !== "villager") return null;
    if (mob.sleeping) return "Villager is sleeping";
    if (mob.child) { mob.lookAt = "player"; mob.ai.lookT = 1.5; return "The child is too young to trade"; }
    if (mob.profession === "stable_hand" && BF.stables) { const msg = BF.stables.playerSells(mob); if (msg) return msg; }   // the player leading a tamed horse sells it to the stable (js/stables.js)
    mob.ai.was = { mode: mob.ai.mode, flee: mob.ai.fleeT > 0 };   // what it was doing, for the trade screen's status line (js/villagerstatus.js)
    mob.lookAt = "player"; mob.ai.lookT = 3; mob.ai.mode = "idle"; mob.ai.t = 3;
    const inv = BF.inventory, I = BF.I || {};
    if (inv && typeof inv.openTrade === "function") {
      try { inv.openTrade(mob); } catch (e) { console.error(e); }
      return null;
    }
    const now = BF.simNow();
    if (now < mob.tradeCd) return null;
    mob.tradeCd = now + 0.6;
    if (!inv || typeof inv.remove !== "function" || I.wheat_item == null || I.emerald == null) return "The villager has nothing to trade";
    if (typeof inv.count === "function" && inv.count(I.wheat_item) < 3) return "The " + mob.profession + " wants 3 wheat for an emerald";
    const got = inv.remove(I.wheat_item, 3);
    if (got !== 3) { if (got > 0) inv.add(I.wheat_item, got); return "The " + mob.profession + " wants 3 wheat for an emerald"; }
    const left = inv.add(I.emerald, 1);
    if (left > 0) { inv.add(I.wheat_item, 3); inv.remove(I.emerald, 1 - left); return "Your inventory is full"; }
    puff(new THREE.Vector3(mob.position.x, mob.position.y + 2.1, mob.position.z), 4, 0.2, false, 0.6);
    return "Traded 3 wheat for 1 emerald";
  },
  // Called by the trade screen: while trading the villager stands still and faces the player.
  setTrading(mob, on) {
    if (!mob || mob.removed) return;
    mob.tradingWith = on ? BF.player : null;
    if (!on) mob.ai.was = null;
    if (on) { mob.vel.x = mob.vel.z = 0; mob.ai.mode = "idle"; mob.ai.t = 2; mob.lookAt = "player"; }
  },
  professions: PROFESSIONS,
  outfits: VILLAGER_OUTFITS,   // profession -> outfit colours, for its model (js/mobview.js)
  // js/shepherd.js: swaps a sheep between its woolly and shorn model, and between lamb and adult size (k: 0 = newborn .. 1 = grown)
  setSheepLook(m, shorn) {
    if (!m || m.type !== "sheep") return;
    m.look = shorn ? "shorn" : null;
  },
  setSheepSize(m, k) {
    if (!m || m.type !== "sheep") return;
    const s = 0.55 + 0.45 * k, hs = 1.35 + (1 - 1.35) * k;
    m.scale = s; m.headScale = hs;
    m.halfWidth = TYPES.sheep.hw * (0.5 + 0.5 * k); m.height = TYPES.sheep.h * (0.55 + 0.45 * k);
  },
  // js/horses.js: swaps every part to the model of another variant (coat / marking) and shows or hides one part (the saddle)
  setLook(m, variant) {
    if (!m) return;
    m.look = variant || null;
    m.variant = variant;
  },
  showPart(m, name, on) { if (m && m.partVis) m.partVis[name] = !!on; },
  // js/poultry.js: chick to adult size (k: 0 = hatched .. 1 = grown)
  setChickenSize(m, k) {
    if (!m || m.type !== "chicken") return;
    const s = 0.5 + 0.5 * k, hs = 1.3 + (1 - 1.3) * k;
    m.scale = s; m.headScale = hs;
    m.halfWidth = TYPES.chicken.hw * (0.6 + 0.4 * k); m.height = TYPES.chicken.h * (0.5 + 0.5 * k);
  },
  // js/cowherd.js: calf to adult size (k: 0 = born .. 1 = grown)
  setCowSize(m, k) { if (m && m.type === "cow") setYoungSize(m, k, 1.35); },
  // js/herd.js users (cows, pigs): a young animal's size (k: 0 = born .. 1 = grown), half size at birth with a bigger head (hs0 at birth)
  setYoungSize,
  // js/jobs.js: the deterministic roster of a village record ({key, houses, nb}) and in-place profession change (rebuilds the outfit)
  roster: villageRoster,
  setProfession(m, prof) {
    prof = PROF_ALIAS[prof] || prof;
    if (!m || m.type !== "villager" || !PROFESSIONS.includes(prof)) return false;
    const style = Math.max(0, VILLAGE_STYLES.indexOf(m.style));
    m.look = prof + "/" + style;   // js/mobview.js rebuilds the outfit
    m.variant = prof; m.profession = prof;
    return true;
  },
  // Navigation helpers for js/builder.js (A* over walkable cells, route following, per-frame search budget).
  isOccupied,
  nav: { findPath: (sx, sy, sz, goal, max) => (BF.bridges ? BF.bridges.route(findPath, sx, sy, sz, goal, max) : findPath(sx, sy, sz, goal, max)), followRoute, feetCell, walkCell, blockAt, bedOK, bedtime, takePlan },
  spawning: true,
  // world.setBlock hook: a light source going out or a block that can shade the ground restarts the spawn wait around it
  onSet(x, y, z, oldId, id) {
    const E = BF.EMIT;
    if (E && E[oldId] > E[id]) stampDark(x, z, 2);
    else if (BF.OPAQUE[id] && !BF.OPAQUE[oldId]) stampDark(x, z, 0);
  },
  darkLongEnough,
  clear() {
    for (const m of list.slice()) removeMob(m);
    list.length = 0;
    arrows.length = 0;
    BF.fx.clear();   // and the effects playing
    villages.clear();
    villagerSaves.clear();
    pendingDead.clear();
    BF.ids.reset();
    villageT = restockT = 0;   // (and the counters and timers below, so a world started after another plays as in a fresh page: spec r15-39)
    surfAcc = caveAcc = chunkArrT = 0; chunkArr = [];
    planTick = planBudget = 0;
    aiAcc = aiEma = aiN = aiWork = 0;
    if (BF.builder) BF.builder.reset();
    if (BF.bridges) BF.bridges.reset();
    if (BF.villageLife) BF.villageLife.reset();
    if (BF.jobs) BF.jobs.reset();
    if (BF.villageSim) BF.villageSim.reset();
    if (BF.shepherd) BF.shepherd.reset();
    if (BF.stables) BF.stables.reset();
    if (BF.poultry) BF.poultry.reset();
    if (BF.cowherd) BF.cowherd.reset();
    if (BF.pigFarmer) BF.pigFarmer.reset();
    if (BF.baker) BF.baker.reset();
    if (BF.merchant) BF.merchant.reset();   // (caravan routes, path wear, prices and timers of the world before: spec r15-39 found them carried over)
    if (BF.bees) BF.bees.reset();
    if (BF.blockReq) BF.blockReq.reset();
    if (BF.storage) BF.storage.reset();
  },
};
})();
