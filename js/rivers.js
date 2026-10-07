// Rivers for generator v2: long channels that start in the uplands and run downhill to the sea.
// The world is covered by a jittered node lattice (NS blocks apart). Each node has a smooth "macro" potential (terrain without
// local hills + a bias toward the open ocean), and flows to its lowest neighbour, so chains of nodes always descend and
// merge into trunk rivers. A node is a river source with a probability that grows with its elevation; a source's river is the first
// NMAX links of its chain. Everything is a pure function of the seed (sources within reach of a query are traced on demand and
// cached), so chunks generated in any order agree. The water surface of a node is its macro height, never rising downstream.
// Generator 3 (opts.planar, opts.wcap) keeps the network free of downstream splits: links never cross, and nodes on a lake's spill route
// follow it; a river's width is the sum of the widths of the sources above it (so it widens at each confluence), up to wcap.
// API: BF.rivers = { init(noise, macro, opts), at(x, z, out) -> bool }; macro(x, z, o) must fill o.p (height) and o.c (continentalness).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SPILL_R = 6, RAD = 2, JIT = 0.34, SUPER = 8, CELL = 192;
// Per-world scale constants (init opts override; the defaults are generator v2's). Generator v3 stretches heights to 0..~1000.
let NS = 96, NMAX = 80, REACH = 34, HS = 1, W0 = 1.6, W1 = 4.6, WLO = 2, WHI = 95, SLO = 15, SHI = 85, RANGE = 16;
// MARG: how far around a segment its cells list it; must cover REACH + half width + the meander displacement (~29)
let MARG = 74;
const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

let noise, macro, SEA = 48, density = 0.03, enabled = true, OUTLET = 0, MOUTH = 49.5;
// Generator 3: PLANAR (flow never crosses itself, lake spill routes are followed by every node on them, so rivers never split downstream),
// width summed over the sources upstream (a river below a confluence is about as wide as the two above it, see flowW);
// LIM: a source whose river strays further than this from it (per axis) is dropped, so every source upstream of a queried point is traced
let PLANAR = false, WCAP = 0, LIM = Infinity;
let nodes, edges, cells, traced, ensured, tmp;

function init(n, macroFn, opts) {
  const o = opts || {};
  noise = n; macro = macroFn; SEA = o.sea != null ? o.sea : (BF.SEA != null ? BF.SEA : 48); density = o.density != null ? o.density : 0.03;
  NS = o.ns || 96; NMAX = o.nmax || 80; REACH = o.reach || 34; W0 = o.w0 != null ? o.w0 : 1.6; W1 = o.w1 != null ? o.w1 : 4.6;
  WLO = o.wlo != null ? o.wlo : 2; WHI = o.whi || 95; SLO = o.slo != null ? o.slo : 15; SHI = o.shi || 85; HS = o.hs || 1; MARG = o.marg || 74;
  RANGE = Math.ceil(NMAX * 1.42 / SUPER) + 1;
  OUTLET = o.outlet || 0;   // blocks the channel runs on past the mouth node (through shore ridges into open water); 0 = none (generator 2)
  MOUTH = SEA + (o.mouth != null ? o.mouth : 1.5);   // a node this low (macro height) is the sea: the river ends there
  PLANAR = !!o.planar; WCAP = o.wcap || 0;
  if (WCAP) MARG += WCAP - W0 - W1;   // cells must cover the widest a segment can get once all its sources are traced
  // ensure() traces RANGE supercells around the query's supercell; a segment's start node is within MARG + CELL + one link of the query
  LIM = PLANAR ? (RANGE - 1) * SUPER * NS - MARG - CELL - RAD * 1.42 * NS * (1 + 2 * JIT) - OUTLET : Infinity;
  BF.rivers.REACH = REACH;
  tiles = new Map(); nodes = new Map(); edges = new Map(); cells = new Map(); traced = new Set(); ensured = new Set(); tmp = { p: 0, c: 0 };
}

const nkey = (i, j) => i * 4194304 + j;
function node(i, j) {
  const k = nkey(i, j);
  let nd = nodes.get(k);
  if (nd) return nd;
  const x = (i + (noise.hash(i, j, 3101) - 0.5) * 2 * JIT) * NS, z = (j + (noise.hash(i, j, 3102) - 0.5) * 2 * JIT) * NS;
  macro(x, z, tmp);
  nd = { k, i, j, x, z, p: tmp.p, c: tmp.c, phi: tmp.p + 150 * tmp.c, next: undefined, rs: undefined };
  nodes.set(k, nd);
  return nd;
}
// Lowest neighbour, or null at a river mouth (reached the sea) or a basin (no lower neighbour).
function nextOf(nd) {
  if (nd.next !== undefined) return nd.next;
  if (PLANAR) return planarNext(nd);
  let best = null, bs = 0.002;
  if (nd.p > MOUTH && nd.c > -0.02) {
    for (let dj = -RAD; dj <= RAD; dj++) for (let di = -RAD; di <= RAD; di++) {
      if (!di && !dj) continue;
      const m = node(nd.i + di, nd.j + dj), dx = m.x - nd.x, dz = m.z - nd.z, sl = (nd.phi - m.phi) / Math.sqrt(dx * dx + dz * dz);
      if (sl > bs) { bs = sl; best = m; }
    }
  }
  if (!best && nd.p > MOUTH && nd.c > -0.02) best = spill(nd);
  return (nd.next = best);
}
// A basin (no lower neighbour): flood outward, lowest node first, until a node below the basin floor is reached (the spill point).
// The river then runs on to it along the flooded route, cutting through the rim. nd.route lists the vertices from nd to the spill point.
function spill(nd) {
  const seen = new Map([[nd.k, null]]), open = [];
  const push = n => { for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue;
    const m = node(n.i + di, n.j + dj);
    if (seen.has(m.k) || Math.abs(m.i - nd.i) > SPILL_R || Math.abs(m.j - nd.j) > SPILL_R) continue;
    seen.set(m.k, n); open.push(m);
  } };
  push(nd);
  for (let it = 0; it < 220 && open.length; it++) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k].phi < open[bi].phi) bi = k;
    const m = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    if (m.phi < nd.phi - 0.01 || m.p <= MOUTH || m.c <= -0.02) {
      const route = [];
      for (let q = m; q; q = seen.get(q.k)) route.push(q);
      route.reverse();
      if (PLANAR) return route;
      nd.route = route;
      return m;
    }
    push(m);
  }
  return null;
}
// Water surface: never rises downstream, and sits a little under the macro height.
function surface(nd) {
  if (nd.rs !== undefined) return nd.rs;
  const chain = [];
  let cur = nd;
  while (cur && cur.rs === undefined) { chain.push(cur); cur = nextOf(cur); }
  let below = cur ? cur.rs : SEA;
  for (let k = chain.length - 1; k >= 0; k--) {
    const n = chain[k], mouth = nextOf(n) === null && n.p <= MOUTH;
    below = n.rs = mouth ? SEA : Math.max(SEA, n.p - 3, below);
  }
  return nd.rs;
}
const widthAt = rs => W0 + W1 * (1 - smooth(SEA + WLO, SEA + WHI, rs));


// ---- generator 3: a crossing-free flow field ----
const lower = (m, n) => m.phi < n.phi || (m.phi === n.phi && m.k < n.k);
const open = n => n.p > MOUTH && n.c > -0.02;
// steepest descent among the neighbours within RAD (null: the sea or a basin)
function localNext(nd) {
  if (nd.ln !== undefined) return nd.ln;
  let best = null, bs = 0.002;
  if (open(nd)) for (let dj = -RAD; dj <= RAD; dj++) for (let di = -RAD; di <= RAD; di++) {
    if (!di && !dj) continue;
    const m = node(nd.i + di, nd.j + dj), dx = m.x - nd.x, dz = m.z - nd.z, sl = (nd.phi - m.phi) / Math.sqrt(dx * dx + dz * dz);
    if (sl > bs) { bs = sl; best = m; }
  }
  return (nd.ln = best);
}
// A node on the spill route of a basin within SPILL_R follows that route (the lowest such basin wins), so water entering the route
// anywhere goes the same way instead of forking off it. Returns the route successor, or undefined.
const TILE = 8;
let tiles;
// the basins (open nodes without a lower neighbour) of a TILE x TILE block of nodes
function basinsIn(ti, tj) {
  const k = ti * 4194304 + tj;
  let l = tiles.get(k);
  if (l) return l;
  tiles.set(k, l = []);
  for (let j = tj * TILE; j < (tj + 1) * TILE; j++) for (let i = ti * TILE; i < (ti + 1) * TILE; i++) {
    const b = node(i, j);
    if (open(b) && !localNext(b)) l.push(b);
  }
  return l;
}
function routeNext(nd) {
  if (nd.rn !== undefined) return nd.rn || undefined;
  let best = null, succ = null;
  const t0 = Math.floor((nd.i - SPILL_R) / TILE), t1 = Math.floor((nd.i + SPILL_R) / TILE), u0 = Math.floor((nd.j - SPILL_R) / TILE), u1 = Math.floor((nd.j + SPILL_R) / TILE);
  for (let tj = u0; tj <= u1; tj++) for (let ti = t0; ti <= t1; ti++) for (const b of basinsIn(ti, tj)) {
    if (Math.abs(b.i - nd.i) > SPILL_R || Math.abs(b.j - nd.j) > SPILL_R) continue;
    if (best && !lower(b, best)) continue;
    if (b.sp === undefined) b.sp = spill(b);
    const r = b.sp;
    if (!r) continue;
    for (let k = 0; k + 1 < r.length; k++) if (r[k] === nd) { best = b; succ = r[k + 1]; break; }
  }
  nd.rn = succ || null;
  return succ || undefined;
}
// distance from node p to the link (u, v)
const pd = (p, u, v) => {
  const dx = v.x - u.x, dz = v.z - u.z;
  let t = ((p.x - u.x) * dx + (p.z - u.z) * dz) / (dx * dx + dz * dz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(u.x + dx * t - p.x, u.z + dz * t - p.z);
};
let JOIN = null;
// segments (a, b) and (c, d) cross or pass within CLR blocks of each other (callers skip pairs that share an end)
const CLR = 80;
function near(a, b, c, d) {
  if (Math.max(a.x, b.x) + CLR < Math.min(c.x, d.x) || Math.max(c.x, d.x) + CLR < Math.min(a.x, b.x) ||
      Math.max(a.z, b.z) + CLR < Math.min(c.z, d.z) || Math.max(c.z, d.z) + CLR < Math.min(a.z, b.z)) return false;
  const o = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true;
  return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b)) < CLR;
}
// Each node flows to its steepest lower neighbour whose link stays clear of the planned links (route successor or steepest descent) of the
// lower nodes around it. Planned links are pure functions of the terrain, so the choice doesn't depend on the order nodes are visited in.
const WIN = 2 * RAD;
const plan = m => open(m) ? routeNext(m) || localNext(m) : null;
function planarNext(t) {
  if (!open(t)) return (t.next = null);
  const r = routeNext(t);
  if (r) return (t.next = r);
  const first = localNext(t);
  if (!first) return (t.next = null);   // a basin without a spill point within reach
  const cand = [];
  for (let dj = -RAD; dj <= RAD; dj++) for (let di = -RAD; di <= RAD; di++) {
    if (!di && !dj) continue;
    const m = node(t.i + di, t.j + dj), dx = m.x - t.x, dz = m.z - t.z, sl = (t.phi - m.phi) / Math.sqrt(dx * dx + dz * dz);
    if (sl > 0.002) cand.push([sl, m]);
  }
  cand.sort((a, b) => b[0] - a[0] || a[1].k - b[1].k);
  const ok = c => {
    for (let dj = -WIN; dj <= WIN; dj++) for (let di = -WIN; di <= WIN; di++) {
      if (!di && !dj) continue;
      const m = node(t.i + di, t.j + dj);
      if (m === c || !lower(m, t)) continue;
      const n = plan(m);
      if (!n || n === t) continue;
      if (n === c) {
        // two links into the same node: fine when they arrive from well apart, but when one starts close beside the other they run side
        // by side down to the junction (two streams on separate ledges); join the lower one's start instead, an earlier confluence
        if (pd(m, t, c) < CLR || pd(t, m, c) < CLR) { JOIN = m; return false; }
        continue;
      }
      if (near(t, c, m, n)) return false;
    }
    return true;
  };
  for (const [, c] of cand) {
    JOIN = null;
    if (ok(c)) return (t.next = c);
    const j = JOIN;
    if (j && Math.abs(j.i - t.i) <= RAD && Math.abs(j.j - t.j) <= RAD && ok(j)) return (t.next = j);
  }
  return (t.next = first);
}
// summed width s of the sources above: the half width is s up to KNEE (two rivers merge into one as wide as both), then grows as a square
// root (a big trunk still widens visibly at each confluence without reaching absurd widths), up to WCAP
const KNEE = 16;
const flowW = (n, rs) => { const s = (n.f || 1) * widthAt(rs); return Math.min(WCAP, s <= KNEE ? s : KNEE * Math.sqrt(s / KNEE)); };

function addEdge(a, b) {
  if (edges.has(a.k)) return;
  const ra = surface(a), rb = surface(b);
  edges.set(a.k, true);
  const route = a.route || [a, b];
  let len = 0;
  const cum = [0];
  for (let k = 1; k < route.length; k++) cum.push(len += Math.hypot(route[k].x - route[k - 1].x, route[k].z - route[k - 1].z));
  for (let k = 0; k + 1 < route.length; k++) {
    const u = route[k], v = route[k + 1], r0 = ra + (rb - ra) * (cum[k] / len), r1 = ra + (rb - ra) * (cum[k + 1] / len);
    seg({ ax: u.x, az: u.z, bx: v.x, bz: v.z, ra: r0, rb: r1, wa: widthAt(r0), wb: widthAt(r1), n: WCAP ? a : null });
  }
}
function seg(e) {
  const x0 = Math.min(e.ax, e.bx) - MARG, x1 = Math.max(e.ax, e.bx) + MARG, z0 = Math.min(e.az, e.bz) - MARG, z1 = Math.max(e.az, e.bz) + MARG;
  for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    const k = cx * 4194304 + cz;
    let l = cells.get(k);
    if (!l) cells.set(k, l = []);
    l.push(e);
  }
}
function trace(i, j) {
  const nd = node(i, j);
  if (nd.p < SEA + 8 || nd.c < 0.2) return;
  if (noise.hash(i, j, 3103) >= density * smooth(0.2, 0.8, nd.c) * (0.4 + 0.6 * smooth(SEA + SLO, SEA + SHI, nd.p))) return;
  // only rivers that really reach the sea within NMAX links exist (a chain that dies in a basin or is too long is dropped)
  const chain = [nd];
  let cur = nd;
  for (let n = 0; n < NMAX; n++) {
    const nx = nextOf(cur);
    if (!nx) break;
    chain.push(nx); cur = nx;
  }
  const sea = nextOf(cur) === null && (cur.p <= MOUTH || cur.c <= -0.02);
  const end = sea ? "sea" : chain.length > NMAX ? "cap" : "basin";
  STATS[end] = (STATS[end] || 0) + 1; if (sea) STATS.len = (STATS.len || 0) + chain.length;
  if (!sea) return;
  if (LIM < Infinity) for (const n of chain) if (Math.abs(n.x - nd.x) > LIM || Math.abs(n.z - nd.z) > LIM) { STATS.far = (STATS.far || 0) + 1; return; }
  if (WCAP) for (const n of chain) n.f = (n.f || 0) + 1;
  for (let k = 0; k + 1 < chain.length; k++) addEdge(chain[k], chain[k + 1]);
  // outlet: carry the channel on past the mouth node in the flow direction, so a coastal ridge or shore hills between the mouth node
  // and open water can't dam it (the mouth node lies on the smooth macro coast, the real shore wanders a little around it)
  if (OUTLET > 0 && chain.length > 1 && !edges.has("o" + cur.k)) {
    edges.set("o" + cur.k, true);
    const pv = chain[chain.length - 2], dx = cur.x - pv.x, dz = cur.z - pv.z, l = Math.hypot(dx, dz) || 1, w = widthAt(SEA);
    seg({ ax: cur.x, az: cur.z, bx: cur.x + dx / l * OUTLET, bz: cur.z + dz / l * OUTLET, ra: SEA, rb: SEA, wa: w, wb: w, n: WCAP ? cur : null });
  }
}
const STATS = {};
// Traces every source that could reach (x, z): sources within NMAX links, i.e. NMAX * NS * sqrt2 blocks.
function ensure(x, z) {
  const si = Math.floor(x / NS / SUPER), sj = Math.floor(z / NS / SUPER), key = si * 4194304 + sj;
  if (ensured.has(key)) return;
  ensured.add(key);
  for (let b = sj - RANGE; b <= sj + RANGE; b++) for (let a = si - RANGE; a <= si + RANGE; a++) {
    const k = a * 4194304 + b;
    if (traced.has(k)) continue;
    traced.add(k);
    for (let j = b * SUPER; j < (b + 1) * SUPER; j++) for (let i = a * SUPER; i < (a + 1) * SUPER; i++) trace(i, j);
  }
}

// meanders: the query point is displaced by a slow noise, so channels wind around their polyline
const warpX = (x, z) => x + noise.n2(x / 170 + 5.1, z / 170 - 2.2) * 24 + noise.n2(x / 53 - 1.3, z / 53 + 8.1) * 5;
const warpZ = (x, z) => z + noise.n2(x / 170 - 9.4, z / 170 + 3.7) * 24 + noise.n2(x / 53 + 4.4, z / 53 - 6.6) * 5;
// Exact distance from (x, z) to the meandering centre line C(s) = P(s) - D(P(s)) of segment e (P: the segment, D: the warp), which is
// kept as a polyline sampled every ~6 blocks. Distances measured in the warped space stretch and squeeze across the channel (up to about
// 2x either way), so a river's width would wander independently of its flow; on the curve a river is as wide as its flow says around bends.
const CAND = [], BLEND = 10, EX = { d: 0, w: 0, rs: 0, sd: 0 };
function curve(e) {
  const L = Math.hypot(e.bx - e.ax, e.bz - e.az), n = Math.max(1, Math.ceil(L / 6)), c = e.c = new Float64Array(2 * n + 2);
  for (let k = 0; k <= n; k++) {
    const px = e.ax + (e.bx - e.ax) * k / n, pz = e.az + (e.bz - e.az) * k / n;
    c[2 * k] = 2 * px - warpX(px, pz); c[2 * k + 1] = 2 * pz - warpZ(px, pz);
  }
  return c;
}
function exact(e, tw, x, z) {
  const c = e.c || curve(e), n = c.length / 2 - 1;
  let bd = 1e18, bt = 0;
  for (let k = 0; k < n; k++) {
    const ax = c[2 * k], az = c[2 * k + 1], dx = c[2 * k + 2] - ax, dz = c[2 * k + 3] - az;
    let u = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = ax + dx * u - x, qz = az + dz * u - z, d2 = qx * qx + qz * qz;
    if (d2 < bd) { bd = d2; bt = (k + u) / n; }
  }
  // the water surface follows the (smooth) warped position tw along the segment, not the nearest point of the curve, which jumps across
  // the inside of a bend: on a steep river that jump would be a step of several blocks in the water across the channel
  EX.rs = e.ra + (e.rb - e.ra) * tw;
  EX.w = e.n ? flowW(e.n, e.ra + (e.rb - e.ra) * bt) : e.wa + (e.wb - e.wa) * bt;
  EX.d = Math.sqrt(bd); EX.sd = EX.d - EX.w;
  return EX;
}
// Nearest river influence at (x, z). out: d (distance from the centre line), w (half width), rs (water surface), sd = d - w.
// Returns false when no river is within REACH blocks of the bank.
function at(x, z, out) {
  if (!enabled) return false;
  ensure(x, z);
  const l = cells.get(Math.floor(x / CELL) * 4194304 + Math.floor(z / CELL));
  if (!l) return false;
  const qx = warpX(x, z), qz = warpZ(x, z);
  let best = 1e9, bd = 0, bw = 0, brs = 0;
  // generator 3 refines every segment that could be nearest once the meanders are measured exactly (they move a bank by up to ~2x the
  // warped estimate), so the nearest one is picked on true distances and no seam is left where the warped pick changes
  const cand = PLANAR ? CAND : null;
  if (cand) cand.length = 0;
  for (let k = 0; k < l.length; k++) {
    const e = l[k], dx = e.bx - e.ax, dz = e.bz - e.az;
    let t = ((qx - e.ax) * dx + (qz - e.az) * dz) / (dx * dx + dz * dz);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = e.ax + dx * t - qx, pz = e.az + dz * t - qz, d = Math.sqrt(px * px + pz * pz), rs = e.ra + (e.rb - e.ra) * t;
    const w = e.n ? flowW(e.n, rs) : e.wa + (e.wb - e.wa) * t, sd = d - w;
    if (cand) cand.push(sd, k, t);
    if (sd < best) { best = sd; bd = d; bw = w; brs = rs; }
  }
  if (cand && best < REACH + 70) {
    const lim = best + 70;
    best = 1e9;
    for (let c = 0; c < cand.length; c += 3) if (cand[c] <= lim) {
      const r = exact(l[cand[c + 1]], cand[c + 2], x, z);
      cand[c] = r.sd; cand[c + 2] = r.rs;   // reused below
      if (r.sd < best) { best = r.sd; bd = r.d; bw = r.w; brs = r.rs; }
    }
    // where the nearest segment changes (a bend at a node, a confluence) the surfaces of the two blend over a few blocks instead of
    // stepping, so water never stands in a ledge across the channel
    let sw = 0, sr = 0;
    for (let c = 0; c < cand.length; c += 3) if (cand[c] <= lim && cand[c] < best + BLEND) { const wgt = 1 - (cand[c] - best) / BLEND; sw += wgt; sr += wgt * cand[c + 2]; }
    if (sw > 0) brs = sr / sw;
  }
  if (best > REACH) return false;
  out.d = bd; out.w = bw; out.rs = brs; out.sd = best;
  return true;
}

// setEnabled(false) makes at() report no river (used by overview maps wider than a few km, where a river is under a pixel and tracing the whole
// network would cost seconds and hundreds of MB); it does not change what is cached, so chunk generation is unaffected.
BF.rivers = { init, at, setEnabled(v) { enabled = !!v; }, REACH, _debug: () => ({ stats: STATS, nodes: nodes.size, edges: edges.size, cells: cells.size }), _internals: () => ({ nodes, cells }) };
})();
