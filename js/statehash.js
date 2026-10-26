// World state hash (spec r15-24, release 1.5). A cheap, complete fingerprint of the simulated world, for the determinism test
// (test/determinism.js: the same seed, and later the same recorded inputs, must give the same hash) and for bug reports ("the hash
// at day 3 was ...", shown on the debug screen and written to the game log once a game day).
// The world is hashed in parts, each in a canonical order, so a mismatch points at the part that differs:
//   edits     block edits (BF.world.edits), by chunk key and cell
//   mobs      every loaded mob's plain state (type, position to 1/1024, hp, ai, inventory, job fields...), sorted, render state left out
//   villages  village records (members as references, the generated layout left out: it comes from the seed)
//   player    the player's saved state and inventory
//   chests, furnaces, signs   block-entity contents
//   drops, clock, weather, wildlife (wild mobs stored with unloaded chunks), boats, horses, bees, farmland
// Numbers that aren't whole are rounded to 1/1024 before hashing; render-only fields (meshes, animation phases, prevPos) are skipped.
// Mobs have no stable ids yet (r15-13): a reference to a mob is its id when it has one, else its type and name (villagers have names).
// Hashing only reads: it never draws random numbers or changes the world.
// API: BF.stateHash() -> hex (16 digits); BF.stateHash.parts() -> { part: hex }; BF.stateHash.full() -> { hash, parts, day, ms };
//      BF.stateHash.PARTS; BF.stateHash.text(part) (a part's canonical text, to find where two worlds differ); BF.stateHash.canon(v) (the canonical text of a value, for tests); BF.stateHash.last (the newest full());
//      BF.stateHash.update() (the main loop: logs the hash when a game day starts)
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

// ---------------------------------------------------------------- the hash: two 32-bit lanes over a string (cyrb53-style), 16 hex digits
function hashStr(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- canonical text of a value
const MAX_DEPTH = 9;
const num = v => Number.isInteger(v) ? String(v) : Number.isFinite(v) ? "f" + Math.round(v * 1024) : String(v);
// Fields that are drawing, animation or static definitions, never simulation state; and caches (_res: a villager's reserve, js/market.js,
// worked out by whoever asks first in a tick, so its time stamp depends on the order mobs think in, spec r15-33).
const SKIP = new Set(["def", "root", "model", "meshes", "material", "mesh", "geo", "geometry", "walkPhase", "walkAmt", "headYaw", "headPitch",
  "prevPos", "prevYaw", "lerp", "badgeMesh", "label", "sprite", "particles", "puffs", "fx", "wg", "_ri", "_rs", "_res",
  "_lvK", "_lvV", "_lvG", "_lsK", "_lsV", "_lsG", "_lhK", "_lhV", "_lhG", "_laK", "_laV", "_laG", "_idK", "_idN",   // caches on mobs (r15-61: js/ids.js links, js/regiontick.js ids)
  "swingT", "cl"]);   // ai.swingT: the arm swing, drawn and heard only, set by the professions' unseeded "visual" rolls (r15-20 report)
// cl: a mob's cluster (js/clusters.js, spec r15-39b), worked out from the rest of the world at each meeting.
// Fields named _snd...: mobs' sound timers (js/audio.js), heard only.
const skipKey = k => SKIP.has(k) || k.startsWith("_snd");
let mobSet = new Set(), dropSet = new Set();
const mobRef = m => m.id != null ? "#" + m.id : m.type + (m.name ? ":" + m.name : "");
const isMob = v => mobSet.has(v) || (v.def && v.position && v.type && v.ai);   // (a mob: js/mobs.js createMob)

function canon(v, out, d, seen) {
  if (v === null) { out.push("N"); return; }
  const t = typeof v;
  if (t === "number") { out.push(num(v)); return; }
  if (t === "string") { out.push(JSON.stringify(v)); return; }
  if (t === "boolean") { out.push(v ? "T" : "F"); return; }
  if (t !== "object") { out.push("U"); return; }   // undefined, functions
  if (v.isVector3) { out.push("v" + num(v.x) + "," + num(v.y) + "," + num(v.z)); return; }
  if (v.isObject3D || v.isMaterial || v.isBufferGeometry || v.isTexture || v.nodeType) { out.push("R"); return; }
  if (d > 0 && isMob(v)) { out.push("@" + mobRef(v)); return; }
  if (d > 0 && v.members && v.key != null) { out.push("V" + v.key); return; }   // a village record
  if (d > 0 && dropSet.has(v)) { out.push("D" + v.key); return; }   // a dropped item (the drops part has its state; its bob phase is drawn only)
  if (d > MAX_DEPTH) { out.push("…"); return; }
  if (seen.has(v)) { out.push("~"); return; }
  seen.add(v);
  if (ArrayBuffer.isView(v)) out.push("[" + Array.prototype.map.call(v, num).join(",") + "]");
  else if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) { if (i) out.push(","); canon(v[i], out, d + 1, seen); }
    out.push("]");
  } else if (v instanceof Map || v instanceof Set) {
    const e = [];
    for (const x of v) {
      const o = [];
      if (v instanceof Map) { canon(x[0], o, d + 1, seen); o.push(":"); canon(x[1], o, d + 1, seen); } else canon(x, o, d + 1, seen);
      e.push(o.join(""));
    }
    e.sort();
    out.push((v instanceof Map ? "M{" : "S{") + e.join(",") + "}");
  } else {
    out.push("{");
    const keys = Object.keys(v).filter(k => !skipKey(k)).sort();
    for (const k of keys) {
      const x = v[k];
      if (x === undefined || typeof x === "function") continue;
      out.push(k, "=");
      canon(x, out, d + 1, seen);
      out.push(";");
    }
    out.push("}");
  }
  seen.delete(v);
}
const text = v => { const o = []; canon(v, o, 0, new Set()); return o.join(""); };
const call = (mod, fn) => (mod && typeof mod[fn] === "function" ? mod[fn]() : null);

// ---------------------------------------------------------------- the parts
function editsText() {
  const W = BF.world, keys = W && W.edits ? [...W.edits.keys()].sort() : [], o = [];
  for (const k of keys) {
    const m = W.edits.get(k);
    if (!m || !m.size) continue;
    const cells = [...m].sort((a, b) => a[0] - b[0]);
    o.push(k + ":" + cells.map(c => c[0] + "=" + c[1]).join(","));
  }
  return o.join("|");
}
function mobsText() {
  const L = BF.mobs ? BF.mobs.list : [];
  return L.filter(m => !m.removed).map(m => {
    const o = [m.type, "@", num(m.position.x), ",", num(m.position.y), ",", num(m.position.z)];
    canon(m.horse ? Object.assign({}, m, { horse: "H" + m.horse.hid }) : m, o, 0, new Set());   // a horse's record is in the horses part
    return o.join("");
  }).sort().join("\n");
}
function villagesText() {
  const V = BF.mobs && BF.mobs.villages, o = [];
  if (V) for (const k of [...V.keys()].sort()) o.push(k + ":" + text(V.get(k)));
  return o.join("\n");
}
// Horse records, with a loaded horse's position and health read from its mob: BF.horses.serialize() would copy them into the record
// first (js/horses.js store), and hashing must not change the world.
function horsesText() {
  const H = BF.horses;
  if (!H || !H.records) return "";
  const recs = [...H.records.values()].sort((a, b) => a.hid - b.hid).map(r => {
    const m = r.mob, c = Object.assign({}, r);
    if (m) Object.assign(c, { x: m.position.x, y: m.position.y, z: m.position.z, yaw: m.yaw, hp: m.hp });
    return c;
  });
  return text({ recs, herds: H.herds });
}
function inv() { return call(BF.inventory, "serialize") || {}; }
const byPos = a => (a || []).map(text).sort().join("\n");

const PARTS = {
  edits: editsText,
  mobs: mobsText,
  villages: villagesText,
  player: () => { const i = inv(); return text({ player: call(BF.player, "serialize"), slots: i.slots, selected: i.selected, held: i.held }); },
  chests: () => byPos(inv().chests),
  furnaces: () => byPos(inv().furnaces),
  signs: () => text(call(BF.signs, "serialize")),
  drops: () => (call(BF.drops, "serialize") || []).map(text).sort().join("\n"),
  // (with the cluster tick on, each cluster's own tick too: js/ctick.js)
  clock: () => text(Object.assign({ day: BF.sky ? BF.sky.day : 0, t: BF.sky ? BF.sky.time : 0, time: BF.state ? BF.state.time : 0 },
    BF.ctick && BF.ctick.on ? { clusters: BF.ctick.clocks() } : {})),
  weather: () => text(call(BF.weather, "serialize")),
  wildlife: () => text(call(BF.wildlife, "serialize")),
  boats: () => text(call(BF.boats, "serialize")),
  horses: horsesText,
  bees: () => text(call(BF.bees, "serialize")),
  farmland: () => text(call(BF.farmland, "serialize")),
};

// A part's canonical text (what its hash is taken of), to find where two worlds differ.
function refsOn() { mobSet = new Set(BF.mobs ? BF.mobs.list : []); dropSet = new Set(BF.drops && BF.drops.list ? BF.drops.list : []); }
function refsOff() { mobSet = new Set(); dropSet = new Set(); }
function partText(k) {
  refsOn();
  try { return PARTS[k](); } finally { refsOff(); }
}

// Every part's hash, and the whole world's (the hash of the part hashes in PARTS order).
function full() {
  const t0 = performance.now(), parts = {};
  refsOn();
  for (const k in PARTS) {
    let s;
    try { s = PARTS[k](); } catch (e) { s = "error:" + e.message; }
    parts[k] = hashStr(s);
  }
  refsOff();
  const hash = hashStr(Object.keys(parts).map(k => k + "=" + parts[k]).join(";"));
  const r = { hash, parts, day: BF.sky ? +((BF.sky.day || 0) + (BF.sky.time || 0)).toFixed(4) : 0, ms: +(performance.now() - t0).toFixed(1) };
  stateHash.last = r;
  return r;
}

// ---------------------------------------------------------------- the game log: the hash as each game day starts
let lastDay = null, hooked = false;
function update() {
  if (!hooked && BF.on) { hooked = true; BF.on("newWorld", () => { lastDay = null; }); }   // main.js (which defines BF.on) loads after this file
  if (!BF.sky || !BF.glog || BF.preparing) return;
  const day = BF.sky.day | 0;
  if (lastDay === null || day < lastDay) { lastDay = day; return; }   // a world just opened (or an earlier one): from its next day on
  if (day === lastDay) return;
  lastDay = day;
  const r = full();
  BF.glog.log("INFO", "statehash", `State hash at the start of day ${day}: ${r.hash} (${r.ms} ms)`);
}

const stateHash = () => full().hash;
Object.assign(stateHash, { PARTS: Object.keys(PARTS), parts: () => full().parts, full, text: partText, canon: text, hashStr, update, last: null });
BF.stateHash = stateHash;
})();
