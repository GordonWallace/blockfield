// The round planet (generator 4): cube-sphere maths and atlas coordinates. Brought over from the round-planet prototype
// (GordonWallace/blockfield-round, js/planet.js); see /wiki "The planet" and specs r14-01 / release-1.4-plan.
//
// The planet is six square faces of N x N block columns, each projected onto a sphere. A column is addressed on its face by
// grid coordinates (f, u, v), and "up" points away from the planet's centre. Columns are radial, so a block at layer y sits at
// radius R + (y - SEA). Vertical limits are Blockfield's mile-high ones (BF.MIN_Y / BF.H / BF.SEA, read at call time).
//
// Atlas coordinates. The whole simulation works on one flat x/z plane (keys "x,z", "cx,cz", saves, tests), so instead of a face
// argument everywhere each face owns its own region of that plane: face f is the square x in [3Nf, 3Nf + 3N), z in [0, 3N). Its
// real grid is the middle N x N square (u = x - 3Nf - N, v = z - N); the band of width N around it is the face's margin, the
// unfolded continuation of the face past each edge, exactly as the flat view draws it. Stored things use canonical points
// (inside a face's middle square). canon() maps a margin point to the canonical point it shows.
//
// Every atlas helper is the identity (or plain x/z maths) when the world is not the planet (generators 1 to 3).
(() => {
"use strict";
const G = typeof window !== "undefined" ? window : self;   // self: the generator also runs in a Web Worker (r14-05)
const BF = (G.BF = G.BF || {});

const N = 163840;                // columns along a face edge; the equator is 4N = 655,360 blocks around
const R = (2 * N) / Math.PI;     // sea-level radius, so a column at a face centre is one block wide
const Q = Math.PI / 4;
const sea = () => (BF.SEA == null ? 0 : BF.SEA);

// Each face: outward normal n and grid axes a (u) and b (v). Blockfield draws x = u, y = up, z = v (the prototype drew z = -v),
// so its faces have a x n = b, i.e. a x b = -n: the prototype's b is negated. With this the round view is not mirrored against
// the flat one (test/planet-maths.js checks it). The y axis is the pole axis: faces 2 and 3 are the polar faces.
const FACES = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, -1, 0] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, -1, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, -1, 0] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, -1, 0] },
];

// Grid point (f, u, v) to a unit direction. The tan warp spaces columns by equal angle, which keeps
// cells close to square; u and v may run a little past the face, which lands on the neighbouring face.
function dir(f, u, v, out) {
  const F = FACES[f];
  const s = Math.tan((2 * u / N - 1) * Q), t = Math.tan((2 * v / N - 1) * Q);
  const x = F.n[0] + s * F.a[0] + t * F.b[0];
  const y = F.n[1] + s * F.a[1] + t * F.b[1];
  const z = F.n[2] + s * F.a[2] + t * F.b[2];
  const l = Math.sqrt(x * x + y * y + z * z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

// Direction (any length) to face and grid coordinates.
function fromDir(x, y, z, out) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let f;
  if (ax >= ay && ax >= az) f = x > 0 ? 0 : 1;
  else if (ay >= az) f = y > 0 ? 2 : 3;
  else f = z > 0 ? 4 : 5;
  const F = FACES[f];
  const d = x * F.n[0] + y * F.n[1] + z * F.n[2];
  const s = (x * F.a[0] + y * F.a[1] + z * F.a[2]) / d;
  const t = (x * F.b[0] + y * F.b[1] + z * F.b[2]) / d;
  out.f = f;
  out.u = (Math.atan(s) / Q + 1) * N / 2;
  out.v = (Math.atan(t) / Q + 1) * N / 2;
  return out;
}

// 3D position of grid point (f, u, v) at layer y.
function pos(f, u, v, y, out) {
  dir(f, u, v, out);
  const r = R + (y - sea());
  out[0] *= r; out[1] *= r; out[2] *= r;
  return out;
}

// Grid coordinates of a direction on a given face (no face choice; the direction may lie past its edge).
function onFace(f, x, y, z, out) {
  const F = FACES[f], d = x * F.n[0] + y * F.n[1] + z * F.n[2];
  out.u = (Math.atan((x * F.a[0] + y * F.a[1] + z * F.a[2]) / d) / Q + 1) * N / 2;
  out.v = (Math.atan((x * F.b[0] + y * F.b[1] + z * F.b[2]) / d) / Q + 1) * N / 2;
  return out;
}

// Unfolding. Two faces that share an edge lie flat side by side exactly: grid rows line up one to one
// along the edge, so the neighbour's grid is placed by a 90-degree rotation plus an offset.
// EDGE[f][s] for side s (0: u < 0, 1: u >= N, 2: v < 0, 3: v >= N) is { g, A, t, turn }, mapping neighbour g's
// grid into f's grid extended past that side: U = A0 u + A1 v + t0, V = A2 u + A3 v + t1. A is a rotation by turn quarter
// turns (A = [cos, -sin, sin, cos]), so a direction in f's frame becomes a direction on g by turning it back by turn quarters.
// UNFOLD[f][g] is the same map looked up by neighbour face (undefined for f itself and the opposite face).
const EDGE = [], UNFOLD = [];
(function buildEdges() {
  const d = [0, 0, 0], o = {};
  for (let f = 0; f < 6; f++) {
    EDGE[f] = []; UNFOLD[f] = [];
    for (let s = 0; s < 4; s++) {
      const out = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const edge = (k) => [out[0] ? (out[0] < 0 ? 0 : N) : k * N, out[1] ? (out[1] < 0 ? 0 : N) : k * N];
      const mid = edge(0.5);
      dir(f, mid[0] + out[0] * N * 0.1, mid[1] + out[1] * N * 0.1, d);
      const g = fromDir(d[0], d[1], d[2], {}).f;
      const p = [edge(0.25), edge(0.75)], q = p.map((e) => { dir(f, e[0], e[1], d); onFace(g, d[0], d[1], d[2], o); return [o.u, o.v]; });
      const ang = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]) - Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]);
      const c = Math.round(Math.cos(ang)), sn = Math.round(Math.sin(ang));
      const A = [c, -sn, sn, c];
      const t = [Math.round(p[0][0] - A[0] * q[0][0] - A[1] * q[0][1]), Math.round(p[0][1] - A[2] * q[0][0] - A[3] * q[0][1])];
      const turn = ((Math.round(Math.atan2(sn, c) / (Math.PI / 2)) % 4) + 4) % 4;
      EDGE[f][s] = UNFOLD[f][g] = { g, A, t, side: s, turn };
    }
  }
})();

// Puts grid coordinates that ran off a face back onto the face they belong to. Past one edge this is the
// exact unfold, so it agrees with how neighbouring faces are drawn; past two edges at once (only within
// a corner's wedge) it falls back to the nearest point by direction.
const tmp = [0, 0, 0];
function wrap(f, u, v, out, depth = 0) {
  if (u >= 0 && u < N && v >= 0 && v < N) { out.f = f; out.u = u; out.v = v; return out; }
  const offU = u < 0 || u >= N, offV = v < 0 || v >= N;
  if (offU !== offV && depth < 3) {
    const e = EDGE[f][offU ? (u < 0 ? 0 : 1) : (v < 0 ? 2 : 3)], A = e.A, x = u - e.t[0], y = v - e.t[1];
    let nu = A[0] * x + A[2] * y, nv = A[1] * x + A[3] * y;
    // a point exactly on the shared edge can land on the neighbour's far boundary line
    if (nu >= N && nu - N < 1e-6) nu = N - 1e-9;
    if (nv >= N && nv - N < 1e-6) nv = N - 1e-9;
    return wrap(e.g, nu, nv, out, depth + 1);
  }
  dir(f, u, v, tmp);
  fromDir(tmp[0], tmp[1], tmp[2], out);
  if (out.u >= N) out.u = N - 1e-9;
  if (out.v >= N) out.v = N - 1e-9;
  return out;
}

// Local frame at a grid point: up (unit), and eu / ev, the 3D vectors one grid step along u and v.
function frame(f, u, v, y, out) {
  const a = [0, 0, 0], b = [0, 0, 0];
  pos(f, u + 0.5, v, y, a); pos(f, u - 0.5, v, y, b);
  out.eu = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  pos(f, u, v + 0.5, y, a); pos(f, u, v - 0.5, y, b);
  out.ev = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  out.up = dir(f, u, v, [0, 0, 0]);
  return out;
}

// 3D tangent vector to grid steps (du, dv) in a local frame: least squares against the grid axes,
// which are not quite perpendicular away from face centres.
function toGrid(d, fr) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = dot(fr.eu, fr.eu), b = dot(fr.eu, fr.ev), c = dot(fr.ev, fr.ev);
  const x = dot(d, fr.eu), y = dot(d, fr.ev), det = a * c - b * b;
  return [(c * x - b * y) / det, (a * y - b * x) / det];
}

// Great-circle distance in blocks (at sea level) between two grid points {f, u, v}; works across faces.
function gridDistance(a, b) {
  const p = dir(a.f, a.u, a.v, [0, 0, 0]), q = dir(b.f, b.u, b.v, [0, 0, 0]);
  return Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) * R;
}

// Direction from a toward b as a 3D unit vector tangent to the ground at a (the start of the great circle).
function gridToward(a, b) {
  const p = dir(a.f, a.u, a.v, [0, 0, 0]), q = dir(b.f, b.u, b.v, [0, 0, 0]);
  const k = p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const t = [q[0] - p[0] * k, q[1] - p[1] * k, q[2] - p[2] * k], l = Math.hypot(t[0], t[1], t[2]) || 1;
  return [t[0] / l, t[1] / l, t[2] / l];
}

// Latitude and longitude in degrees (latitude from the pole axis y; longitude 0 through the centre of face 4, +90 toward face 0).
function latLon(f, u, v, out) {
  out = out || {};
  dir(f, u, v, tmp);
  out.lat = Math.asin(Math.max(-1, Math.min(1, tmp[1]))) * 180 / Math.PI;
  out.lon = Math.atan2(tmp[0], tmp[2]) * 180 / Math.PI;
  return out;
}
function fromLatLon(lat, lon, out) {
  const a = lat * Math.PI / 180, o = lon * Math.PI / 180;
  return fromDir(Math.cos(a) * Math.sin(o), Math.sin(a), Math.cos(a) * Math.cos(o), out || {});
}

// ---------- atlas coordinates ----------
const W = 3 * N;                 // width of a face's atlas square
const LOCAL = 4096;              // within this many blocks (through at most one edge) distance / toward are plain grid maths

const isPlanet = () => !!(BF.state && BF.state.gen === 4);

// Atlas x/z of grid point (f, u, v), and back. face() is -1 outside every face square.
const atlas = (f, u, v, out) => { out = out || {}; out.x = W * f + N + u; out.z = N + v; return out; };
function face(x, z) {
  if (!(z >= 0 && z < W && x >= 0)) return -1;
  const f = Math.floor(x / W);
  return f < 6 ? f : -1;
}
// Face and grid coordinates of an atlas point (u, v may lie in the margin: outside [0, N)).
function grid(x, z, out) {
  out = out || {};
  const f = face(x, z);
  out.f = f;
  out.u = f < 0 ? NaN : x - W * f - N; out.v = z - N;
  return out;
}

// The canonical point an atlas point shows: out = { x, z, f, u, v, turn, wedge, off }. turn (0 to 3) is the number of quarter
// turns from the point's own frame to the canonical one: turnVec(-turn, ...) turns a margin direction into the canonical face's
// frame. wedge: the point is past two edges at once (inside a corner's wedge, where the flat view leaves a gap); the nearest point
// by direction is returned. off: outside every face square (nothing there; x, z are returned unchanged). Identity off the planet.
const go = {};
function canon(x, z, out) {
  out = out || {};
  out.turn = 0; out.wedge = false; out.off = false;
  if (!isPlanet()) { out.x = x; out.z = z; out.f = 0; out.u = x; out.v = z; return out; }
  const f = face(x, z);
  if (f < 0) { out.x = x; out.z = z; out.f = -1; out.u = NaN; out.v = NaN; out.off = true; return out; }
  const u = x - W * f - N, v = z - N;
  if (u >= 0 && u < N && v >= 0 && v < N) { out.x = x; out.z = z; out.f = f; out.u = u; out.v = v; return out; }
  const offU = u < 0 || u >= N, offV = v < 0 || v >= N;
  if (offU !== offV) {
    const e = EDGE[f][offU ? (u < 0 ? 0 : 1) : (v < 0 ? 2 : 3)], A = e.A, px = u - e.t[0], py = v - e.t[1];
    let nu = A[0] * px + A[2] * py, nv = A[1] * px + A[3] * py;
    if (nu >= N && nu - N < 1e-6) nu = N - 1e-9;
    if (nv >= N && nv - N < 1e-6) nv = N - 1e-9;
    if (nu < 0 && nu > -1e-6) nu = 0;
    if (nv < 0 && nv > -1e-6) nv = 0;
    out.f = e.g; out.u = nu; out.v = nv; out.turn = e.turn;
  } else {
    wrap(f, u, v, go);
    out.f = go.f; out.u = go.u; out.v = go.v; out.wedge = true;
    const e = UNFOLD[f][go.f];
    out.turn = e ? e.turn : 0;
  }
  out.x = W * out.f + N + out.u; out.z = N + out.v;
  return out;
}
// Same for a block cell (integer x, z): the canonical cell that shows there (its centre is mapped, so rotations land on the
// right cell). out.x / out.z are integers.
function canonCell(x, z, out) {
  out = canon(x + 0.5, z + 0.5, out);
  out.x = Math.floor(out.x); out.z = Math.floor(out.z);
  out.u = Math.floor(out.u); out.v = Math.floor(out.v);
  return out;
}

// Turn a grid direction (dx, dz) by q quarter turns (positive: the same sense as the unfold rotations A). Returns out = [dx, dz].
function turnVec(q, dx, dz, out) {
  out = out || [0, 0];
  q = ((q % 4) + 4) % 4;
  if (q === 0) { out[0] = dx; out[1] = dz; } else if (q === 1) { out[0] = -dz; out[1] = dx; }
  else if (q === 2) { out[0] = -dx; out[1] = -dz; } else { out[0] = dz; out[1] = -dx; }
  return out;
}
// A yaw (Blockfield's: forward = (-sin yaw, -cos yaw)) turned by q quarter turns, as turnVec does to its forward vector.
function turnYaw(q, yaw) {
  q = ((q % 4) + 4) % 4;
  return yaw - q * Math.PI / 2;
}

// b's position in a's face frame: b unfolded into a's margin when it is on a face next to a's, so that b.x - a.x / b.z - a.z is a
// true local offset (exact for points within N of each other across one edge). out = { x, z, turn } where turn takes a direction
// in b's canonical frame into a's frame (turnVec(turn, ...)). Null when b is on the face opposite a's, or either point is off
// the atlas. Off the planet, b itself.
const ra = {}, rb = {};
function rel(a, b, out) {
  out = out || {};
  if (!isPlanet()) { out.x = b.x; out.z = b.z; out.turn = 0; return out; }
  canon(a.x, a.z, ra); canon(b.x, b.z, rb);
  if (ra.off || rb.off) return null;
  if (ra.f === rb.f) { out.x = rb.x; out.z = rb.z; out.turn = 0; return out; }
  const e = UNFOLD[ra.f][rb.f];
  if (!e) return null;
  const U = e.A[0] * rb.u + e.A[1] * rb.v + e.t[0], V = e.A[2] * rb.u + e.A[3] * rb.v + e.t[1];
  out.x = W * ra.f + N + U; out.z = N + V; out.turn = e.turn;
  return out;
}

// Distance in blocks between two atlas points {x, z}: plain hypot when they are close (same face, or a neighbour's unfolded into
// a's frame, within LOCAL blocks), the great-circle distance at sea level otherwise. Plain hypot off the planet.
const rr = {};
function distance(a, b) {
  if (!isPlanet()) return Math.hypot(b.x - a.x, b.z - a.z);
  const r = rel(a, b, rr);
  if (r) { const d = Math.hypot(r.x - ra.x, r.z - ra.z); if (d <= LOCAL) return d; }   // (ra: a canonical, as rel measures from it; a may be a margin address)
  if (ra.off || rb.off) return Infinity;
  return gridDistance(ra, rb);
}
// The offset from a toward b in a's grid frame: out = { x: dx, z: dz, d }. Close points: plain dx / dz (through the unfold);
// far ones: the great circle's starting direction at a, scaled to the great-circle distance. Plain dx / dz off the planet.
const fr0 = {};
function toward(a, b, out) {
  out = out || {};
  if (!isPlanet()) { out.x = b.x - a.x; out.z = b.z - a.z; out.d = Math.hypot(out.x, out.z); return out; }
  const r = rel(a, b, rr);
  if (r) {
    const dx = r.x - ra.x, dz = r.z - ra.z, d = Math.hypot(dx, dz);
    if (d <= LOCAL) { out.x = dx; out.z = dz; out.d = d; return out; }
  }
  if (ra.off || rb.off) { out.x = 0; out.z = 0; out.d = Infinity; return out; }
  const d = gridDistance(ra, rb), t = gridToward(ra, rb);
  const g = toGrid(t, frame(ra.f, ra.u, ra.v, sea(), fr0)), l = Math.hypot(g[0], g[1]) || 1;
  out.x = g[0] / l * d; out.z = g[1] / l * d; out.d = d;
  return out;
}

// Moves something that left its face's square back to the canonical point and turns its direction with it. Reads and writes
// e.x / e.z, and when present e.yaw and e.vx / e.vz. Returns the quarter turns applied (0 when nothing changed, and always off the
// planet). A point in a corner wedge or off the atlas is left where it is (-1): the caller keeps it out of there.
const rc = {}, tv = [0, 0];
function recanon(e) {
  if (!isPlanet()) return 0;
  canon(e.x, e.z, rc);
  if (rc.off || rc.wedge) return -1;
  if (rc.x === e.x && rc.z === e.z) return 0;
  e.x = rc.x; e.z = rc.z;
  const q = (4 - rc.turn) % 4;    // margin frame -> canonical frame
  if (q) {
    if (typeof e.yaw === "number") e.yaw = turnYaw(q, e.yaw);
    if (typeof e.vx === "number" && typeof e.vz === "number") { turnVec(q, e.vx, e.vz, tv); e.vx = tv[0]; e.vz = tv[1]; }
  }
  return q;
}

// ---------- frames (spec r14-13) ----------
// Every atlas point is expressed in the frame of the face whose atlas square (its grid plus the margin around it) holds it: face(x, z).
// A thing that belongs to a place (a villager to its village) keeps its coordinates in that place's frame even past an edge, where they
// are margin addresses, so the coordinates it compares itself with (home, bed, pen) stay plain x / z maths; a thing that belongs nowhere
// keeps to its own face's canonical square.

// Point (x, z) expressed in the frame of face F: out = { x, z, turn } (turn: quarter turns taking a direction in the point's own frame
// into F's, for turnVec / turnYaw). Null when the point is on the face opposite F or off the atlas. Off the planet, the point itself.
const rf = {};
function inFrame(F, x, z, out) {
  out = out || {};
  if (!isPlanet()) { out.x = x; out.z = z; out.turn = 0; return out; }
  canon(x, z, rf);
  if (rf.off || F < 0 || F > 5) return null;
  const q0 = (4 - rf.turn) % 4;    // own frame -> canonical
  if (rf.f === F) { out.x = rf.x; out.z = rf.z; out.turn = q0; return out; }
  const e = UNFOLD[F][rf.f];
  if (!e) return null;
  out.x = W * F + N + e.A[0] * rf.u + e.A[1] * rf.v + e.t[0]; out.z = N + e.A[2] * rf.u + e.A[3] * rf.v + e.t[1];
  out.turn = (q0 + e.turn) % 4;
  return out;
}
// b ({x, z}) as seen from a: b expressed in the frame a is expressed in, so b.x - a.x / b.z - a.z is a true local offset whichever
// frames the two are kept in. Far apart (b on the face opposite a's frame) it is b unchanged. out = { x, z, turn }; off the planet, b.
function local(a, b, out) {
  out = out || {};
  if (isPlanet()) { const F = face(a.x, a.z); if (F >= 0 && inFrame(F, b.x, b.z, out)) return out; }
  out.x = b.x; out.z = b.z; out.turn = 0;
  return out;
}
// Puts a moving thing into the frame of face F, or (F < 0 / undefined) back onto the canonical square of the face it stands on: moves
// p.x / p.z and turns holder.yaw and vel.x / vel.z with it. Returns the quarter turns applied (0 to 3), or null when nothing changed
// (already in that frame, off the planet, or no way to get there: F opposite, off the atlas). A point in a corner wedge is moved to the
// nearest face (as the player is). Callers re-express any points they keep in the old frame with inFrame(face(p.x, p.z), ...).
const rg = {}, tw = [0, 0];
function reframe(p, F, holder, vel) {
  if (!isPlanet()) return null;
  if (F == null || F < 0) {
    canon(p.x, p.z, rg);
    if (rg.off || (rg.x === p.x && rg.z === p.z)) return null;
    F = rg.f;
  } else if (face(p.x, p.z) === F) return null;
  if (!inFrame(F, p.x, p.z, rg)) return null;
  p.x = rg.x; p.z = rg.z;
  const q = rg.turn;
  if (q) {
    if (holder && typeof holder.yaw === "number") holder.yaw = turnYaw(q, holder.yaw);
    if (vel && typeof vel.x === "number") { turnVec(q, vel.x, vel.z, tw); vel.x = tw[0]; vel.z = tw[1]; }
  }
  return q;
}

// Latitude / longitude of an atlas point (null off the planet or off the atlas), and the atlas point of a latitude / longitude.
function latLonAt(x, z, out) {
  if (!isPlanet()) return null;
  canon(x, z, rc);
  if (rc.off) return null;
  return latLon(rc.f, rc.u, rc.v, out);
}
function atlasOfLatLon(lat, lon, out) {
  const g = fromLatLon(lat, lon, {});
  return atlas(g.f, g.u, g.v, out);
}

// ---------- geographic directions (shared with r14-17; the F3 facing, /locate and maps use these) ----------
// Grid directions at an atlas point are in that point's own frame (a margin address: the frame it is seen in). Off the planet north is
// -z, as in 1.3. At a pole north is undefined: bearing / facingBearing return null and north() returns null.
const gfr = {}, gc = {};
function geo(x, z) {   // canonical frame at (x, z): { c, east, north } as 3D unit vectors, or null (off the atlas, or at a pole)
  canon(x, z, gc);
  if (gc.off) return null;
  frame(gc.f, gc.u, gc.v, sea(), gfr);
  const up = gfr.up, el = Math.hypot(up[2], up[0]);
  if (el < 1e-9) return null;
  const east = [up[2] / el, 0, -up[0] / el];
  const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];   // up x east
  return { c: gc, east, north };
}
// Unit grid vector [dx, dz] toward the north pole at (x, z).
function north(x, z) {
  if (!isPlanet()) return [0, -1];
  const g = geo(x, z);
  if (!g) return null;
  const t = toGrid(g.north, gfr), r = turnVec(g.c.turn, t[0], t[1]), l = Math.hypot(r[0], r[1]) || 1;   // canonical frame -> the address's frame
  return [r[0] / l, r[1] / l];
}
// Bearing in degrees clockwise from north (0 to 360) of grid direction (dx, dz) at (x, z).
function bearing(x, z, dx, dz) {
  if (!isPlanet()) return ((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360;
  const g = geo(x, z);
  if (!g) return null;
  const t = turnVec((4 - g.c.turn) % 4, dx, dz), eu = gfr.eu, ev = gfr.ev;   // the address's frame -> canonical
  const d = [eu[0] * t[0] + ev[0] * t[1], eu[1] * t[0] + ev[1] * t[1], eu[2] * t[0] + ev[2] * t[1]];
  const de = d[0] * g.east[0] + d[2] * g.east[2], dn = d[0] * g.north[0] + d[1] * g.north[1] + d[2] * g.north[2];
  return ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360;
}
// The bearing the player faces with yaw `yaw` (Blockfield's: forward = (-sin yaw, -cos yaw)).
const facingBearing = (x, z, yaw) => bearing(x, z, -Math.sin(yaw), -Math.cos(yaw));
const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"], SHORT = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
// The nearest of the eight compass points: "north-east", or "NE" when short.
const compassPoint = (deg, short) => (short ? SHORT : POINTS)[((Math.round(deg / 45) % 8) + 8) % 8];

BF.planet = {
  N, R, W, LOCAL, FACES, EDGE, UNFOLD,
  dir, fromDir, onFace, pos, wrap, frame, toGrid, gridDistance, gridToward, latLon, fromLatLon,
  isPlanet, atlas, face, grid, canon, canonCell, turnVec, turnYaw, rel, distance, toward, recanon, latLonAt, atlasOfLatLon,
  inFrame, local, reframe,
  north, bearing, facingBearing, compassPoint,
};
})();
