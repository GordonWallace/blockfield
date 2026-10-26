// Bridges over rivers (idea-030). A village counts the trips its villagers make across water: a villager swimming, or a route that has to go a long
// way round (or finds none) because water is in the way. Counts are kept per village on an 8-block grid and only the last 3 game days count. When a
// cell has been crossed often enough, the builder's weights offer a "bridge" (js/builder.js weighTypes) at the narrowest crossing near that cell.
// Built bridges are walkable: nav.findPath (js/mobs.js) sends a walk that would swim or detour over the nearest bridge instead.
// API: BF.bridges = { CELL, NEED, BUSY, MAXBUILT, noteSwim(m), record(x, z, rec), count(rec, gx, gz), heat(rec), plan(R, fresh), weight(R), route(fp, sx, sy, sz, goal, max),
//   deck(e, reverse), exportAll(out), importAll(o), reset() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const CELL = 8, RANGE = 64, WINDOW = 3, NEED = 12, BUSY = 30, WMIN = 3, WMAX = 24, SPACING = 32, MAXBUILT = 3, ROUTE_R = 48, MAXRAMP = 3, MAXPOST = 14;
const W = () => BF.world;
const dayNow = () => (BF.sky ? BF.sky.day + BF.sky.time : 0);
const counts = new Map();   // village key -> Map("gx,gz" -> [game days of each crossing, newest last])
const isWater = id => BF.RENDER[id] === 3;

// A water column: {ws: top water y, bed: the solid block under it}; null on land; undefined when its chunk is not loaded.
function wcol(x, z) {
  const w = W();
  if (!w.isLoaded(x, z)) return undefined;
  const g = w.heightAt(x, z);
  if (!isWater(w.getBlock(x, g + 1, z))) return null;
  let y = g + 1;
  while (isWater(w.getBlock(x, y + 1, z))) y++;
  return { ws: y, bed: g };
}
// Height of the ground at a land column (a plain block, not water, a tree or ice), else null.
function landY(x, z) {
  const w = W();
  if (!w.isLoaded(x, z)) return null;
  const g = w.heightAt(x, z), b = BF.blocks[w.getBlock(x, g, z)];
  if (!b || isWater(w.getBlock(x, g + 1, z)) || /leaves|_log$|ice/.test(b.name)) return null;
  return g;
}

// ---------------------------------------------------------------- counting crossings
function nearestRec(x, z) {
  const vs = BF.mobs && BF.mobs.villages;
  let best = null, bd = RANGE + 1;
  if (!vs) return null;
  for (const r of vs.values()) {
    const wg = r.wg, x0 = wg ? wg.minX : r.x - 20, x1 = wg ? wg.maxX : r.x + 20, z0 = wg ? wg.minZ : r.z - 20, z1 = wg ? wg.maxZ : r.z + 20;
    const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
const recent = arr => { const t = dayNow() - WINDOW; let n = 0; for (const d of arr) if (d >= t) n++; return n; };
function record(x, z, rec) {
  rec = rec || nearestRec(x, z);
  if (!rec || !rec.key) return;
  let cells = counts.get(rec.key);
  if (!cells) counts.set(rec.key, cells = new Map());
  const k = Math.floor(x / CELL) + "," + Math.floor(z / CELL);
  let arr = cells.get(k);
  if (!arr) cells.set(k, arr = []);
  const now = dayNow();
  if (arr.length && now - arr[arr.length - 1] < 0.0015) return;   // one trip is one crossing, not one per frame
  arr.push(+now.toFixed(4));
  if (arr.length > 80) arr.splice(0, arr.length - 80);
  if (BF.rworkers) BF.rworkers.touch("cross", [rec.key, k]);   // (a villager crossing while it thinks: the other region workers count it too, js/rworkers.js)
}
// A villager in the water: a crossing at most every few seconds.
function noteSwim(m) {
  const t = dayNow();
  if (m._swT !== undefined && t - m._swT < 0.003) return;
  m._swT = t;
  record(m.position.x, m.position.z, m.village);
}
const count = (rec, gx, gz) => { const cells = rec && counts.get(rec.key), arr = cells && cells.get(gx + "," + gz); return arr ? recent(arr) : 0; };
// [[x, z, crossings]] for the debug screen's heat layer: the cells with crossings in the window.
function heat(rec) {
  const cells = rec && counts.get(rec.key), out = [];
  if (cells) for (const [k, arr] of cells) { const n = recent(arr); if (n > 0) { const [gx, gz] = k.split(",").map(Number); out.push([gx * CELL, gz * CELL, n]); } }
  return out;
}

// ---------------------------------------------------------------- where a bridge goes
// Checks a straight crossing: water columns a..b along `axis` on the line f. Returns the span (with the ramps each bank needs) or null.
function evalSpan(axis, f, a, b) {
  const w = W(), L = b - a + 1;
  if (L < WMIN || L > WMAX) return null;
  const at = (p, q) => (axis === "x" ? [p, f + q] : [f + q, p]);
  let ws = -1e9;
  for (let p = a; p <= b; p++) for (let q = -1; q <= 1; q++) {
    const [x, z] = at(p, q), c = wcol(x, z);
    if (c === undefined) return null;
    if (c && c.ws > ws) ws = c.ws;
  }
  if (ws < -1e8) return null;
  const Dy = ws + 3;   // the deck: two clear blocks over the water, so a boat with a rider passes under it
  const ramp = dir => {   // planks a bank needs, each one lower than the last, until the ground is within a step of the walk
    let F = Dy + 1, n = 0;
    for (let i = 1; i <= MAXRAMP + 1; i++) {
      const [x, z] = at(dir < 0 ? a - i : b + i, 0), g = landY(x, z);
      if (g == null) return null;
      const G = g + 1;
      if (G > F + 1) return null;
      if (G >= F - 1) return n;
      if (++n > MAXRAMP) return null;
      F -= 1;
    }
    return null;
  };
  const r0 = ramp(-1), r1 = ramp(1);
  if (r0 == null || r1 == null) return null;
  // the footprint must be free where it is built
  for (let p = a - r0; p <= b + r1; p++) {
    const i = p < a ? a - p : p > b ? p - b : 0, lo = i ? -i : -2;
    for (let q = -1; q <= 1; q++) {
      const [x, z] = at(p, q);
      for (let rel = lo; rel <= 3; rel++) {
        const cur = w.getBlock(x, Dy + rel, z);
        if (BF.SOLID[cur] && !BF.REPLACEABLE[cur]) return null;
      }
    }
  }
  return { axis, f, a, b, L, ws, Dy, r0, r1 };
}
// The narrowest crossing within reach of cell centre (cx, cz): lines in both directions, up to 8 blocks either side.
function findSpan(cx, cz) {
  let best = null;
  for (const axis of ["x", "z"]) for (let o = -8; o <= 8; o++) {
    const f = (axis === "x" ? cz : cx) + o, c0 = axis === "x" ? cx : cz;
    let start = null;
    for (let p = c0 - 18; p <= c0 + 19; p++) {
      const [x, z] = axis === "x" ? [p, f] : [f, p], c = wcol(x, z);
      if (c === undefined) { start = null; continue; }
      if (c) { if (start == null) start = p; continue; }
      if (start != null) {
        const sp = evalSpan(axis, f, start, p - 1);
        if (sp) {
          sp.score = sp.L * 2 + Math.abs((start + p - 1) / 2 - c0) + Math.abs(o) * 0.5;
          if (!best || sp.score < best.score) best = sp;
        }
        start = null;
      }
    }
  }
  return best;
}
// A walkable crossing already stands within SPACING of (x, z): solid blocks just above the water, whoever put them there.
function crossingNear(x, z) {
  const w = W();
  for (let dz = -SPACING; dz <= SPACING; dz += 2) for (let dx = -SPACING; dx <= SPACING; dx += 2) {
    const c = wcol(x + dx, z + dz);
    if (!c) continue;
    for (let y = c.ws + 1; y <= c.ws + 4; y++) if (BF.SOLID[w.getBlock(x + dx, y, z + dz)]) return true;
  }
  return false;
}
// Where the posts go and how deep: both ends, and on spans of 11 or more evenly between them, at least 5 apart (a boat is under 1.4 wide). Each post
// runs from under the deck down to the bed on the two outer lanes. "u:d0:d2;..." for the blueprint (js/blueprints.js bridge).
function postsFor(sp) {
  const L = sp.L, k = Math.max(0, Math.floor((L - 1) / 5) - 1), us = [0];
  for (let i = 1; i <= k; i++) us.push(Math.round(i * (L - 1) / (k + 1)));
  us.push(L - 1);
  const lane = (u, q) => {   // world column of deck block u, lane q (rot 0 runs along x with q = z - (f - 1); rot 1 along z with q = (f + 1) - x)
    const p = sp.a + u, [x, z] = sp.axis === "x" ? [p, sp.f - 1 + q] : [sp.f + 1 - q, p], c = wcol(x, z);
    const g = c ? c.bed : c === null ? W().heightAt(x, z) : sp.Dy - 2;
    return Math.max(0, Math.min(MAXPOST, sp.Dy - 1 - g));
  };
  return us.map(u => u + ":" + lane(u, 0) + ":" + lane(u, 2)).join(";");
}
const bridgesOf = R => (BF.builder ? BF.builder.builtOf(R) : []).filter(e => e.type === "bridge" && e.state !== "abandoned");
// The bridge this village wants now: {n (crossings in the busiest cell), rot, ox, oz, oy, opts, span} or null. Kept for a quarter of a game day.
function plan(R, fresh) {
  if (!R || !R.key) return null;
  if (!fresh && R._bridgePlan && dayNow() - R._bridgePlan.t < 0.25) return R._bridgePlan.plan;
  let found = null;
  const cells = counts.get(R.key), have = bridgesOf(R);
  if (cells && have.length < MAXBUILT && W()) {
    const list = [];
    for (const [k, arr] of cells) { const n = recent(arr); if (n >= NEED) list.push({ k, n }); }
    list.sort((a, b) => b.n - a.n);
    for (const c of list.slice(0, 3)) {
      const [gx, gz] = c.k.split(",").map(Number), cx = gx * CELL + CELL / 2, cz = gz * CELL + CELL / 2;
      if (have.some(e => Math.hypot(e.ox + e.w / 2 - cx, e.oz + e.d / 2 - cz) < SPACING)) continue;
      const sp = findSpan(cx, cz);
      if (!sp) continue;
      const mx = sp.axis === "x" ? (sp.a + sp.b) >> 1 : sp.f, mz = sp.axis === "x" ? sp.f : (sp.a + sp.b) >> 1;
      if (crossingNear(mx, mz)) continue;
      const opts = { len: sp.L, r0: sp.r0, r1: sp.r1, posts: postsFor(sp) };
      found = {
        n: c.n, rot: sp.axis === "x" ? 0 : 1, oy: sp.Dy, opts,
        ox: sp.axis === "x" ? sp.a - sp.r0 : sp.f - 1, oz: sp.axis === "x" ? sp.f - 1 : sp.a - sp.r0,
        span: { axis: sp.axis, f: sp.f, a: sp.a, b: sp.b, dy: sp.Dy },
      };
      break;
    }
  }
  R._bridgePlan = { t: dayNow(), plan: found };
  return found;
}
// The builder's weight for a bridge (js/builder.js weighTypes): 1.2, or 2 once the busiest cell has 30 crossings; 0 with nothing to bridge.
function weight(R) {
  const p = plan(R);
  return p ? (p.n >= BUSY ? 2 : 1.2) : 0;
}

// ---------------------------------------------------------------- walking over them
// The cells a villager walks over a finished bridge entry, centre lane, from the first ramp or deck block to the last: [[x, y(feet), z]].
function deck(e, reverse) {
  const s = e.span, o = e.opts || {}, n0 = o.r0 | 0, n1 = o.r1 | 0, out = [];
  if (!s) return out;
  for (let p = s.a - n0; p <= s.b + n1; p++) {
    const i = p < s.a ? s.a - p : p > s.b ? p - s.b : 0, y = s.dy + 1 - i;
    out.push(s.axis === "x" ? [p, y, s.f] : [s.f, y, p]);
  }
  return reverse ? out.reverse() : out;
}
function doneBridges() {
  const out = [], vs = BF.mobs && BF.mobs.villages;
  if (vs) for (const r of vs.values()) for (const e of r.built || []) if (e.type === "bridge" && e.state === "done" && e.span) out.push(e);
  return out;
}
// The first water on the straight line between two points, or null.
function waterBetween(sx, sz, gx, gz) {
  const d = Math.hypot(gx - sx, gz - sz), n = Math.min(80, Math.ceil(d / 2));
  for (let i = 1; i < n; i++) {
    const x = Math.floor(sx + (gx - sx) * i / n), z = Math.floor(sz + (gz - sz) * i / n);
    if (wcol(x, z)) return { x, z };
  }
  return null;
}
// nav.findPath with bridges: `fp` is the plain A*. A walk with water in the way and no short way round counts as a crossing; when a bridge near the
// start gives a shorter route (or the only one), the route goes to one end, over the deck, and on from the other end.
function route(fp, sx, sy, sz, goal, max) {
  const direct = fp(sx, sy, sz, goal, max);
  if (!goal || goal.x == null || goal.z == null) return direct;
  const straight = Math.hypot(goal.x - sx, goal.z - sz);
  if (straight < 10 || straight > 160) return direct;
  if (direct && direct.length <= 2 * straight + 6) return direct;
  const wet = waterBetween(sx, sz, goal.x, goal.z);
  if (!wet) return direct;
  record(wet.x, wet.z);
  let best = null;
  for (const e of doneBridges()) for (const rev of [false, true]) {
    const cells = deck(e, rev), A = cells[0], B = cells[cells.length - 1];
    if (!A) continue;
    const da = Math.hypot(A[0] - sx, A[2] - sz);
    if (da > ROUTE_R) continue;
    const cost = da + cells.length + Math.hypot(goal.x - B[0], goal.z - B[2]);
    if (!best || cost < best.cost) best = { cost, cells, A, B };
  }
  if (!best || (direct && best.cost >= direct.length)) return direct;
  const A = best.A, B = best.B;
  const p1 = fp(sx, sy, sz, { x: A[0], z: A[2], at: (x, y, z) => x === A[0] && z === A[2] && y === A[1] }, max);
  if (!p1) return direct;
  const p2 = fp(B[0], B[1], B[2], goal, max);
  if (!p2) return direct;
  return p1.concat(best.cells.slice(1), p2);
}

// ---------------------------------------------------------------- persistence (mobs.js exportVillagers / importVillagers: "cross:<village key>")
function exportAll(out) {
  const t = dayNow() - WINDOW;
  for (const [key, cells] of counts) {
    const c = {};
    for (const [k, arr] of cells) { const keep = arr.filter(d => d >= t); if (keep.length) c[k] = keep; }
    if (Object.keys(c).length) out["cross:" + key] = { c };
  }
  return out;
}
function importAll(o) {
  counts.clear();
  for (const k in o || {}) {
    if (k.slice(0, 6) !== "cross:" || !o[k] || typeof o[k].c !== "object") continue;
    const cells = new Map();
    for (const g in o[k].c) if (Array.isArray(o[k].c[g])) cells.set(g, o[k].c[g].filter(Number.isFinite));
    counts.set(k.slice(6), cells);
  }
}
const reset = () => counts.clear();
// Several workers (spec r15-39): a villager's crossings are counted on the worker that thinks for it; this sends each changed cell's count on
// (bug-083: the state hash's villagers part showed the copies' counts drifting apart, and they decide where builders put bridges).
if (BF.rworkers) BF.rworkers.channel("cross", { key: o => o, get: k => k,
  state: k => { const cells = counts.get(k[0]), arr = cells && cells.get(k[1]); return arr ? arr.slice() : []; },
  set: (k, arr) => { if (!k || !Array.isArray(arr)) return; let cells = counts.get(k[0]); if (!cells) counts.set(k[0], cells = new Map()); cells.set(k[1], arr.slice()); } });

BF.bridges = { CELL, NEED, BUSY, MAXBUILT, WINDOW, noteSwim, record, count, heat, plan, weight, route, deck, exportAll, importAll, reset, _find: findSpan };
})();
