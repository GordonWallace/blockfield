// Rivers for generator v2: long channels that start in the uplands and run downhill to the sea.
// The world is covered by a jittered node lattice (NS blocks apart). Each node has a smooth "macro" potential (terrain without
// local hills + a bias toward the open ocean), and flows to its lowest neighbour, so chains of nodes always descend and
// merge into trunk rivers. A node is a river source with a probability that grows with its elevation; a source's river is the first
// NMAX links of its chain. Everything is a pure function of the seed (sources within reach of a query are traced on demand and
// cached), so chunks generated in any order agree. The water surface of a node is its macro height, never rising downstream.
// API: BF.rivers = { init(noise, macro, opts), at(x, z, out) -> bool }; macro(x, z, o) must fill o.p (height) and o.c (continentalness).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SPILL_R = 6, RAD = 2, JIT = 0.34, SUPER = 8, CELL = 192, MARG = 74;
// Per-world scale constants (init opts override; the defaults are generator v2's). Generator v3 stretches heights to 0..~1000.
let NS = 96, NMAX = 80, REACH = 34, HS = 1, W0 = 1.6, W1 = 4.6, WLO = 2, WHI = 95, SLO = 15, SHI = 85, RANGE = 16;
const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

let noise, macro, SEA = 48, density = 0.03, enabled = true;
let nodes, edges, cells, traced, ensured, tmp;

function init(n, macroFn, opts) {
  const o = opts || {};
  noise = n; macro = macroFn; SEA = o.sea != null ? o.sea : (BF.SEA != null ? BF.SEA : 48); density = o.density != null ? o.density : 0.03;
  NS = o.ns || 96; NMAX = o.nmax || 80; REACH = o.reach || 34; W0 = o.w0 != null ? o.w0 : 1.6; W1 = o.w1 != null ? o.w1 : 4.6;
  WLO = o.wlo != null ? o.wlo : 2; WHI = o.whi || 95; SLO = o.slo != null ? o.slo : 15; SHI = o.shi || 85; HS = o.hs || 1;
  RANGE = Math.ceil(NMAX * 1.42 / SUPER) + 1;
  BF.rivers.REACH = REACH;
  nodes = new Map(); edges = new Map(); cells = new Map(); traced = new Set(); ensured = new Set(); tmp = { p: 0, c: 0 };
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
  let best = null, bs = 0.002;
  if (nd.p > SEA + 1.5 && nd.c > -0.02) {
    for (let dj = -RAD; dj <= RAD; dj++) for (let di = -RAD; di <= RAD; di++) {
      if (!di && !dj) continue;
      const m = node(nd.i + di, nd.j + dj), dx = m.x - nd.x, dz = m.z - nd.z, sl = (nd.phi - m.phi) / Math.sqrt(dx * dx + dz * dz);
      if (sl > bs) { bs = sl; best = m; }
    }
  }
  if (!best && nd.p > SEA + 1.5 && nd.c > -0.02) best = spill(nd);
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
    if (m.phi < nd.phi - 0.01 || m.p <= SEA + 1.5 || m.c <= -0.02) {
      const route = [];
      for (let q = m; q; q = seen.get(q.k)) route.push(q);
      nd.route = route.reverse();
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
    const n = chain[k], mouth = nextOf(n) === null && n.p <= SEA + 1.5;
    below = n.rs = mouth ? SEA : Math.max(SEA, n.p - 3, below);
  }
  return nd.rs;
}
const widthAt = rs => W0 + W1 * (1 - smooth(SEA + WLO, SEA + WHI, rs));

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
    seg({ ax: u.x, az: u.z, bx: v.x, bz: v.z, ra: r0, rb: r1, wa: widthAt(r0), wb: widthAt(r1) });
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
  const sea = nextOf(cur) === null && (cur.p <= SEA + 1.5 || cur.c <= -0.02);
  const end = sea ? "sea" : chain.length > NMAX ? "cap" : "basin";
  STATS[end] = (STATS[end] || 0) + 1; if (sea) STATS.len = (STATS.len || 0) + chain.length;
  if (!sea) return;
  for (let k = 0; k + 1 < chain.length; k++) addEdge(chain[k], chain[k + 1]);
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

// Nearest river influence at (x, z). out: d (distance from the centre line), w (half width), rs (water surface), sd = d - w.
// Returns false when no river is within REACH blocks of the bank.
function at(x, z, out) {
  if (!enabled) return false;
  ensure(x, z);
  const l = cells.get(Math.floor(x / CELL) * 4194304 + Math.floor(z / CELL));
  if (!l) return false;
  // meanders: the query point is displaced by a slow noise, so channels wind around their polyline
  const qx = x + noise.n2(x / 170 + 5.1, z / 170 - 2.2) * 24 + noise.n2(x / 53 - 1.3, z / 53 + 8.1) * 5;
  const qz = z + noise.n2(x / 170 - 9.4, z / 170 + 3.7) * 24 + noise.n2(x / 53 + 4.4, z / 53 - 6.6) * 5;
  let best = 1e9, bd = 0, bw = 0, brs = 0;
  for (let k = 0; k < l.length; k++) {
    const e = l[k], dx = e.bx - e.ax, dz = e.bz - e.az;
    let t = ((qx - e.ax) * dx + (qz - e.az) * dz) / (dx * dx + dz * dz);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = e.ax + dx * t - qx, pz = e.az + dz * t - qz, d = Math.sqrt(px * px + pz * pz), w = e.wa + (e.wb - e.wa) * t, sd = d - w;
    if (sd < best) { best = sd; bd = d; bw = w; brs = e.ra + (e.rb - e.ra) * t; }
  }
  if (best > REACH) return false;
  out.d = bd; out.w = bw; out.rs = brs; out.sd = best;
  return true;
}

// setEnabled(false) makes at() report no river (used by overview maps wider than a few km, where a river is under a pixel and tracing the whole
// network would cost seconds and hundreds of MB); it does not change what is cached, so chunk generation is unaffected.
BF.rivers = { init, at, setEnabled(v) { enabled = !!v; }, REACH, _debug: () => ({ stats: STATS, nodes: nodes.size, edges: edges.size, cells: cells.size }) };
})();
