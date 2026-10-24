// Regions (spec r15-30): the world divided into 64 x 64-block regions, and an index of what is in each one. Regions are the unit of work
// for threads (and later machines): r15-31 / r15-32 query the index instead of scanning every mob, r15-33 ticks a region at a time.
// A region is a cell of a cube face's own (u, v) grid, so it never spans two faces: key (f, ru, rv) with ru = floor(u / REGION), packed
// into one number (f * K + ru) * K + rv, K = N / REGION. A position is keyed by its canonical block cell (BF.planet.canonCell of the
// floored x / z, as world.js does for chunks), so a region is exactly 4 x 4 chunks and a margin address (a villager kept in its village's
// frame past a face edge) lands in the region it really stands in.
// The index holds, per region: mobs, drops (the objects; mobIdsIn gives their r15-13 ids), active
// villages (by centre) and block entities (chests, furnaces, signs, bee homes: canonical "x,y,z" keys, in loaded chunks). It is kept up
// to date by:
//   spawn / despawn (js/mobs.js createMob, removeMob), drop spawn / remove (js/drops.js), block edits (js/world.js setBlock -> onSet),
//   chunk load / unload (block entities), and tick() at the end of each simulation step (js/main.js): mobs and drops whose region changed
//   move lists, villages that started or stopped running (BF.villageSim.isActive) come and go.
// check() compares the index with a full scan (a self-check for tests and the debug console); a difference is logged as an ERROR.
// API: BF.regions = { REGION, K, setSize(n), keyOf(x, y, z) -> key or -1, parts(key) -> {f, ru, rv}, name(key) -> "f:ru:rv",
//                     bounds(key) -> {f, x0, z0, x1, z1} (canonical atlas box, x1 / z1 exclusive), neighbors(key) -> [keys],
//                     around(x, z, r) -> [keys], get(key) -> region or undefined, mobsIn(key), dropsIn(key), villagesIn(key), blockEntitiesIn(key),
//                     mobIdsIn(key) -> [mob ids], villageIdsIn(key) -> [village keys],
//                     tick(), stats() -> [{key, name, f, ru, rv, mobs, drops, villages, blockEntities}], counts(), check() -> {ok, diffs},
//                     reset(), Index (the bare per-object index, for tests and benchmarks),
//                     mobsAround(x, z, r, filter, {local}) -> [mobs], mobsInBox(x0, z0, x1, z1, filter), ofType(type) -> [mobs], villageMobs(rec, filter) -> [mobs], checkQuery(label, got, want), verifyQueries, queryStats(), resetQueryStats() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const P = () => BF.planet;

let REGION = 64, K = 0;          // block width of a region; regions along a face edge (N / REGION)
let FN = 0, FW = 0;              // BF.planet.N and .W (a face's width, and its atlas square's)
const N = () => FN, W = () => FW;
function setSize(n) {
  FN = P().N; FW = P().W;
  n = Math.floor(n);
  if (!(n > 0) || FN % n) throw new Error("region size must divide the face width " + FN);
  REGION = n; K = FN / n;
  regions.REGION = REGION; regions.K = K;
  reset();
}

// ---------------------------------------------------------------- keys
const pack = (f, ru, rv) => (f * K + ru) * K + rv;
const CC = {};
// The region of the block cell at (x, z) (any atlas address), or -1 in a corner wedge or off the atlas. y is not used (regions are columns).
function keyOf(x, y, z) {
  x = Math.floor(x); z = Math.floor(z);
  const f = Math.floor(x / FW), u = x - FW * f - FN, v = z - FN;
  if (f >= 0 && f < 6 && u >= 0 && u < FN && v >= 0 && v < FN) return (f * K + Math.floor(u / REGION)) * K + Math.floor(v / REGION);
  return keyEdge(x, z);
}
function keyEdge(x, z) {   // (a margin address: through BF.planet's canonical cell)
  const c = P().canonCell(x, z, CC);
  if (c.wedge || c.off) return -1;
  return pack(c.f, Math.floor(c.u / REGION), Math.floor(c.v / REGION));
}
const keyAt = p => keyOf(p.x, 0, p.z);
function parts(k) { const rv = k % K, r = (k - rv) / K, ru = r % K; return { f: (r - ru) / K, ru, rv }; }
const name = k => { const p = parts(k); return p.f + ":" + p.ru + ":" + p.rv; };
// The region's canonical box in atlas coordinates: x in [x0, x1), z in [z0, z1).
function bounds(k) {
  const p = parts(k), x0 = W() * p.f + N() + p.ru * REGION, z0 = N() + p.rv * REGION;
  return { f: p.f, x0, z0, x1: x0 + REGION, z1: z0 + REGION };
}
// The regions sharing an edge or a corner with k: 8, across face edges too, and 7 at a cube corner (the diagonal one past both edges
// would be in the corner wedge, where nothing is). Probes a point just past each side / corner and keys it.
function neighbors(k) {
  const b = bounds(k), out = [];
  for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
    if (!du && !dv) continue;
    const x = du < 0 ? b.x0 - 0.5 : du > 0 ? b.x1 + 0.5 : (b.x0 + b.x1) / 2, z = dv < 0 ? b.z0 - 0.5 : dv > 0 ? b.z1 + 0.5 : (b.z0 + b.z1) / 2;
    const n = keyOf(x, 0, z);
    if (n >= 0 && n !== k && !out.includes(n)) out.push(n);
  }
  return out;
}
// The regions overlapping the circle of radius r around (x, z) (any atlas address), for queries. Worked out in the point's own face
// frame (the margin holds the unfolded neighbours, whose region grid lines up with this one's), so it is exact within one face edge;
// meant for radii up to a few thousand blocks.
const GA = {};
function around(x, z, r) {
  const g = P().grid(x, z, GA), out = [];
  if (g.f < 0) return out;
  const n = N(), ox = W() * g.f + n;   // atlas x of u = 0
  r = Math.max(0, r);
  const a0 = Math.floor((g.u - r) / REGION), a1 = Math.floor((g.u + r) / REGION), b0 = Math.floor((g.v - r) / REGION), b1 = Math.floor((g.v + r) / REGION);
  const seen = new Set();
  for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) {
    const cu = Math.max(a * REGION, Math.min(g.u, (a + 1) * REGION)), cv = Math.max(b * REGION, Math.min(g.v, (b + 1) * REGION));   // nearest point of the cell
    if ((cu - g.u) ** 2 + (cv - g.v) ** 2 > r * r) continue;
    const u = a * REGION + REGION / 2, v = b * REGION + REGION / 2;
    if (u < -n || u >= 2 * n || v < -n || v >= 2 * n) continue;   // past the margin
    const k = keyOf(ox + u, 0, n + v);
    if (k >= 0 && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

// ---------------------------------------------------------------- the index
// Index: per-region sets of objects that move, kept up by a step over the index's own arrays (struct of arrays: each object's position
// object, region key and the corner of that region's canonical box), so a step reads no property of the objects themselves, only
// x / z of their positions, and works a key out again only when a position has left its box. An object moves between sets only when its
// region changes. Objects come and go by add / remove (each keeps its slot in o._ri, which js/statehash.js skips).
class Index {
  constructor(pos) {
    this.pos = pos; this.by = new Map(); this.n = 0; this.moves = 0;
    this.objs = []; this.ps = []; this.ks = new Int32Array(64); this.bx = new Float64Array(64); this.bz = new Float64Array(64);
  }
  // put o in region k (-1: nowhere, kept out of the sets until it is somewhere) and its slot's box with it
  _set(i, o, k) {
    const old = this.ks[i];
    if (old >= 0) { const s = this.by.get(old); if (s && s.delete(o)) { this.n--; if (!s.size) this.by.delete(old); } }
    this.ks[i] = k;
    if (k < 0) { this.bx[i] = this.bz[i] = NaN; return; }
    let s = this.by.get(k);
    if (!s) this.by.set(k, (s = new Set()));
    s.add(o); this.n++;
    const rv = k % K, r = (k - rv) / K, ru = r % K;
    this.bx[i] = FW * ((r - ru) / K) + FN + ru * REGION; this.bz[i] = FN + rv * REGION;
  }
  add(o) {
    if (o._ri !== undefined && this.objs[o._ri] === o) return;
    const i = this.objs.length;
    if (i >= this.ks.length) for (const f of ["ks", "bx", "bz"]) { const a = new this[f].constructor(this.ks.length * 2); a.set(this[f]); this[f] = a; }
    this.objs.push(o); this.ps.push(this.pos(o)); this.ks[i] = -1; o._ri = i;
    const p = this.ps[i];
    this._set(i, o, keyOf(p.x, 0, p.z));
  }
  remove(o) {
    const i = o._ri;
    if (i === undefined || this.objs[i] !== o) return;
    this._set(i, o, -1);
    const last = this.objs.length - 1;
    if (i !== last) {   // the last one takes the slot
      const q = this.objs[last];
      this.objs[i] = q; this.ps[i] = this.ps[last]; this.ks[i] = this.ks[last]; this.bx[i] = this.bx[last]; this.bz[i] = this.bz[last]; q._ri = i;
    }
    this.objs.pop(); this.ps.pop();
    o._ri = undefined;
  }
  has(o) { return o._ri !== undefined && this.objs[o._ri] === o; }
  keyOf(o) { return this.has(o) ? this.ks[o._ri] : undefined; }
  // The step: every object whose position left its region's box is keyed again and, when its region changed, moved.
  sync() {
    const ps = this.ps, bx = this.bx, bz = this.bz, ks = this.ks, S = REGION;
    for (let i = 0, n = ps.length; i < n; i++) {
      const p = ps[i], x = p.x, z = p.z, x0 = bx[i], z0 = bz[i];
      if (x >= x0 && x < x0 + S && z >= z0 && z < z0 + S) continue;
      const k = keyOf(x, 0, z);
      if (k !== ks[i]) { this._set(i, this.objs[i], k); this.moves++; }
    }
  }
  in(k) { return this.by.get(k); }
  clear() { for (const o of this.objs) o._ri = undefined; this.objs = []; this.ps = []; this.by.clear(); this.n = 0; }
}

const mobPos = m => m.position, dropPos = d => d.pos, vilPos = v => v;
const mobs = new Index(mobPos), drops = new Index(dropPos), villages = new Index(vilPos);
const bes = new Map(), beBy = new Map();   // block entity "x,y,z" -> region; region -> Set of "x,y,z"
const mobGone = m => m.removed;

let FLAG = null;
function flags() {
  if (FLAG || !BF.blocks || !BF.B) return FLAG;
  FLAG = new Uint8Array((BF.MAX_BLOCK || 4095) + 1);
  for (const b of BF.blocks) if (b && (BF.isChest(b.id) || BF.isFurnace(b.id) || b.sign || b.id === BF.B.bee_nest || b.id === BF.B.beehive)) FLAG[b.id] = 1;
  return FLAG;
}
const isBE = id => { const F = flags(); return !!(F && id != null && F[id]); };
const bk = (x, y, z) => x + "," + y + "," + z;
function beAdd(x, y, z) {
  const key = bk(x, y, z), k = keyOf(x, y, z);
  if (k < 0) return;
  const old = bes.get(key);
  if (old === k) return;
  if (old !== undefined) beDel(x, y, z);
  bes.set(key, k);
  let s = beBy.get(k);
  if (!s) beBy.set(k, (s = new Set()));
  s.add(key);
}
function beDel(x, y, z) {
  const key = bk(x, y, z), k = bes.get(key);
  if (k === undefined) return;
  bes.delete(key);
  const s = beBy.get(k);
  if (s && s.delete(key) && !s.size) beBy.delete(k);
}
function scanChunk(cx, cz, c) {
  const F = flags(), CS = BF.CS;
  if (F) BF.world.scanFlagged(c, F, (lx, y, lz) => beAdd(cx * CS + lx, y, cz * CS + lz));
}
function unloadChunk(cx, cz) {
  const CS = BF.CS;
  for (const [key, k] of bes) {
    const i = key.indexOf(","), x = +key.slice(0, i), z = +key.slice(key.lastIndexOf(",") + 1);
    if (Math.floor(x / CS) === cx && Math.floor(z / CS) === cz) { bes.delete(key); const s = beBy.get(k); if (s && s.delete(key) && !s.size) beBy.delete(k); }
  }
}
let hooked = false;
function hook() {
  if (hooked || !BF.world || !BF.world.onChunkLoad || !flags()) return;
  hooked = true;
  BF.world.onChunkLoad(scanChunk);
  BF.world.onChunkUnload(unloadChunk);
  for (const c of BF.world.chunks.values()) scanChunk(c.cx, c.cz, c);
  if (BF.on) BF.on("newWorld", reset);
}

// ---------------------------------------------------------------- upkeep
// world.js setBlock (canonical x / z): a block entity placed or broken.
function onSet(x, y, z, oldId, id) {
  if (!hooked) return;
  if (isBE(id)) beAdd(x, y, z); else if (isBE(oldId)) beDel(x, y, z);
}
// js/mobs.js createMob / removeMob, js/drops.js spawn / remove.
const mobAdded = m => { m._rs = ++mseq; mobs.add(m); typeAdd(m); };
const mobRemoved = m => { mobs.remove(m); typeDel(m); };
const dropAdded = d => drops.add(d);
const dropRemoved = d => drops.remove(d);

const vilSkip = v => !(BF.villageSim ? BF.villageSim.isActive(v.key) : true);
// The end of a simulation step: moved mobs and drops change region, villages that started or stopped running come and go.
function tick() {
  hook();
  mobs.sync();
  drops.sync();
  syncVillages();
}
// Villages don't move: they only start and stop running.
function syncVillages() {
  const V = BF.mobs && BF.mobs.villages;
  if (!V) return;
  for (const v of V.values()) { if (vilSkip(v)) villages.remove(v); else villages.add(v); }
  for (let i = villages.objs.length - 1; i >= 0; i--) { const v = villages.objs[i]; if (V.get(v.key) !== v) villages.remove(v); }   // records dropped (a new world)
}
// Empties the index and fills it again with what is there now (a new world, a new region size).
function reset() {
  mobs.clear(); drops.clear(); villages.clear(); bes.clear(); beBy.clear(); byType.clear();
  if (BF.mobs && BF.mobs.list) for (const m of BF.mobs.list) if (!m.removed) { m._rs = ++mseq; mobs.add(m); typeAdd(m); }
  if (BF.drops && BF.drops.list) for (const d of BF.drops.list) drops.add(d);
  syncVillages();
  if (hooked && BF.world) for (const c of BF.world.chunks.values()) scanChunk(c.cx, c.cz, c);
}

// ---------------------------------------------------------------- reading it
const sizeOf = s => (s ? s.size : 0);
function stats() {
  const keys = new Set([...mobs.by.keys(), ...drops.by.keys(), ...villages.by.keys(), ...beBy.keys()]), out = [];
  for (const k of keys) {
    const p = parts(k);
    out.push({ key: k, name: p.f + ":" + p.ru + ":" + p.rv, f: p.f, ru: p.ru, rv: p.rv, mobs: sizeOf(mobs.in(k)), drops: sizeOf(drops.in(k)), villages: sizeOf(villages.in(k)), blockEntities: sizeOf(beBy.get(k)) });
  }
  return out.sort((a, b) => a.key - b.key);
}
const counts = () => ({ regions: stats().length, mobs: mobs.n, drops: drops.n, villages: villages.n, blockEntities: bes.size, moves: mobs.moves + drops.moves });

// The self-check: the index against a full scan of the mobs, drops, running villages and the block entities of every loaded chunk.
// -> {ok, diffs: ["mob zombie at 1,2 in 0:3:4, index says 0:3:5", ...]} (at most 50 listed). Logs an ERROR when they differ.
function check() {
  hook();
  const diffs = [];
  const cmp = (what, list, idx, pos, skip, label) => {
    const want = new Map();
    for (const o of list) if (!(skip && skip(o))) want.set(o, keyAt(pos(o)));
    let n = 0;
    for (const [o, k] of want) {
      if (k < 0) continue;
      n++;
      const s = idx.in(k);
      if (!s || !s.has(o)) diffs.push(`${what} ${label(o)} in ${name(k)}, index says ${(q => q == null ? "none" : q < 0 ? "nowhere" : name(q))(idx.keyOf(o))}`);
    }
    for (const [k, s] of idx.by) for (const o of s) if (!want.has(o) || want.get(o) !== k) diffs.push(`${what} ${label(o)} indexed in ${name(k)}, ${want.has(o) ? "is in " + name(want.get(o)) : "no longer there"}`);
    if (n !== idx.n) diffs.push(`${what}: ${idx.n} indexed, ${n} found`);
    if (idx.objs.length !== want.size) diffs.push(`${what}: ${idx.objs.length} tracked, ${want.size} found`);
  };
  const at = p => Math.floor(p.x) + "," + Math.floor(p.z);
  cmp("mob", (BF.mobs && BF.mobs.list) || [], mobs, mobPos, mobGone, m => m.type + " at " + at(m.position));
  if (BF.ids) for (const s of mobs.by.values()) for (const m of s) if (BF.ids.live(m.id) !== m) diffs.push(`mob ${m.type} indexed under id ${m.id}, which is not its registered id`);
  cmp("drop", (BF.drops && BF.drops.list) || [], drops, dropPos, null, d => "at " + at(d.pos));
  cmp("village", BF.mobs && BF.mobs.villages ? [...BF.mobs.villages.values()] : [], villages, vilPos, vilSkip, v => v.key);
  const F = flags(), want = new Map(), CS = BF.CS;
  if (F && BF.world) for (const c of BF.world.chunks.values()) BF.world.scanFlagged(c, F, (lx, y, lz) => { const x = c.cx * CS + lx, z = c.cz * CS + lz; want.set(bk(x, y, z), keyOf(x, y, z)); });
  for (const [key, k] of want) if (bes.get(key) !== k) diffs.push(`block entity ${key} in ${name(k)}, index says ${bes.has(key) ? name(bes.get(key)) : "none"}`);
  for (const [key, k] of bes) if (!want.has(key)) diffs.push(`block entity ${key} indexed in ${name(k)}, no longer there`);
  const ok = !diffs.length;
  if (!ok && BF.glog) BF.glog.log("ERROR", "regions", `Region index differs from a full scan in ${diffs.length} place${diffs.length === 1 ? "" : "s"}: ${diffs.slice(0, 3).join("; ")}`);
  return { ok, diffs: diffs.slice(0, 50), count: diffs.length };
}

// ---------------------------------------------------------------- queries (r15-31 / r15-32)
// mobsAround(x, z, r, filter, {local}) -> the live mobs (not removed) within r blocks of (x, z) that pass filter(m), measured on raw
// atlas x / z as most old scans of BF.mobs.list did, or with local: true through a face edge (BF.planet.local, as mobs.js's seen()), in BF.mobs.list order (each mob carries its creation order in _rs: the list only grows at the
// end and loses mobs by splice, so that order is the list's). It reads the regions overlapping r + PAD: the index is synced at the end
// of a step, so a mob can be up to one step's walk out of the region it is filed under.
// With verifyQueries on (tests), every call also runs the old full scan with the same test and logs an ERROR when the two differ;
// checkQuery(label, got, want) does the same for scans replaced by a village's own lists. queryStats() -> {queries, checked, diffs, last}.
const PAD = 4;
let mseq = 0;
const qs = { queries: 0, checked: 0, diffs: 0, last: null };
const bySeq = (a, b) => a._rs - b._rs;
const LA = {}, LB = {};
// m within r of (x, z): on raw atlas x / z, or (local) with m's position seen from the point's frame (BF.planet.local), as scans that
// measure through a face edge do
function near(m, x, z, r2, local) {
  let mx = m.position.x, mz = m.position.z;
  if (local) { LA.x = x; LA.z = z; const l = P().local(LA, m.position, LB); mx = l.x; mz = l.z; }
  const dx = mx - x, dz = mz - z;
  return dx * dx + dz * dz <= r2;
}
function mobsAround(x, z, r, filter, opts) {
  qs.queries++;
  const out = [], r2 = r * r, local = !!(opts && opts.local);
  for (const k of around(x, z, r + PAD)) {
    const s = mobs.in(k);
    if (s) for (const m of s) if (!m.removed && near(m, x, z, r2, local) && (!filter || filter(m))) out.push(m);
  }
  if (out.length > 1) out.sort(bySeq);
  if (regions.verifyQueries) checkQuery("mobsAround", out, () => {
    const want = [];
    for (const m of (BF.mobs && BF.mobs.list) || []) if (!m.removed && near(m, x, z, r2, local) && (!filter || filter(m))) want.push(m);
    return want;
  }, x, z);
  return out;
}
// mobsInBox(x0, z0, x1, z1, filter) -> the live mobs standing in the atlas box x in [x0, x1], z in [z0, z1] (raw x / z) passing filter,
// in list order: the circle around the box, then the box.
function mobsInBox(x0, z0, x1, z1, filter) {
  return mobsAround((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 0.01, m => m.position.x >= x0 && m.position.x <= x1 && m.position.z >= z0 && m.position.z <= z1 && (!filter || filter(m)));
}
// ofType(type) -> the live mobs of one type, in BF.mobs.list order (kept by mobAdded / mobRemoved; a mob's type never changes). The
// array is the index's own: read it, don't change it (copy it first when the loop may remove mobs).
const byType = new Map();
function ofType(t) {
  let a = byType.get(t);
  if (!a) byType.set(t, (a = []));
  if (regions.verifyQueries) checkQuery("ofType " + t, a, () => ((BF.mobs && BF.mobs.list) || []).filter(m => m.type === t && !m.removed));
  return a;
}
const typeAdd = m => { let a = byType.get(m.type); if (!a) byType.set(m.type, (a = [])); if (!a.length || a[a.length - 1]._rs < m._rs) a.push(m); else if (!a.includes(m)) { a.push(m); a.sort(bySeq); } };
const typeDel = m => { const a = byType.get(m.type), i = a ? a.lastIndexOf(m) : -1; if (i >= 0) a.splice(i, 1); };
// villageMobs(rec, filter) -> the live mobs of village record rec (rec.members whose m.village is rec) that pass filter, in BF.mobs.list
// order: what a scan of BF.mobs.list for m.village === rec found.
function villageMobs(rec, filter) {
  const out = [];
  if (!rec) return out;
  for (const m of rec.members || []) if (!m.removed && m.village === rec && (!filter || filter(m))) out.push(m);
  if (out.length > 1) { out.sort(bySeq); let j = 1; for (let i = 1; i < out.length; i++) if (out[i] !== out[j - 1]) out[j++] = out[i]; out.length = j; }   // (once each)
  if (regions.verifyQueries) checkQuery("villageMobs " + rec.key, out, () => ((BF.mobs && BF.mobs.list) || []).filter(m => !m.removed && m.village === rec && (!filter || filter(m))));
  return out;
}
const who = m => (m && m.type ? m.type + (m.id ? " " + m.id : "") + (m.position ? " at " + Math.floor(m.position.x) + "," + Math.floor(m.position.z) : "") : String(m));
// Compares a query's answer with the old scan's (want: an array, or a function giving one), in order. Off unless verifyQueries.
function checkQuery(label, got, want, x, z) {
  if (!regions.verifyQueries) return true;
  qs.checked++;
  const w = typeof want === "function" ? want() : want;
  let same = got.length === w.length;
  for (let i = 0; same && i < w.length; i++) if (got[i] !== w[i]) same = false;
  if (same) return true;
  qs.diffs++;
  const miss = w.filter(m => !got.includes(m)), extra = got.filter(m => !w.includes(m));
  qs.last = { label, at: x != null ? Math.floor(x) + "," + Math.floor(z) : null, got: got.length, want: w.length, missing: miss.slice(0, 5).map(who), extra: extra.slice(0, 5).map(who), order: !miss.length && !extra.length };
  if (qs.diffs <= 20 && BF.glog) BF.glog.log("ERROR", "regions", `Region query ${label} differs from a full scan: ${got.length} found, ${w.length} expected` + (miss.length ? "; missing " + miss.slice(0, 3).map(who).join(", ") : "") + (extra.length ? "; extra " + extra.slice(0, 3).map(who).join(", ") : "") + (!miss.length && !extra.length ? " (order)" : ""));
  return false;
}
const queryStats = () => ({ queries: qs.queries, checked: qs.checked, diffs: qs.diffs, last: qs.last });
const resetQueryStats = () => { qs.queries = qs.checked = qs.diffs = 0; qs.last = null; };

// The ids (js/ids.js, r15-13) of a region's mobs and village keys, read when asked: the sets hold the objects themselves, because a
// villager's id can change after it is made (its saved id comes back with its trading state, BF.ids.reuse), and a step that read ids
// would touch every mob (see Index).
const idsOf = (s, f) => { const out = []; if (s) for (const o of s) out.push(f(o)); return out; };

const regions = {
  REGION, K, setSize, keyOf, parts, name, bounds, neighbors, around,
  get: k => ({ mobs: mobs.in(k), drops: drops.in(k), villages: villages.in(k), blockEntities: beBy.get(k) }),
  mobsIn: k => mobs.in(k), dropsIn: k => drops.in(k), villagesIn: k => villages.in(k), blockEntitiesIn: k => beBy.get(k),
  mobIdsIn: k => idsOf(mobs.in(k), m => m.id), villageIdsIn: k => idsOf(villages.in(k), v => v.key),
  onSet, mobAdded, mobRemoved, dropAdded, dropRemoved, tick, stats, counts, check, reset, Index,
  mobsAround, mobsInBox, ofType, villageMobs, checkQuery, queryStats, resetQueryStats, verifyQueries: false,
};
BF.regions = regions;
setSize(REGION);
})();
