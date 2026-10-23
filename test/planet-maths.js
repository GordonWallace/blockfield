// @ci baseline suite=world
// Planet maths and atlas coordinates (js/planet.js, spec r14-01). Plain node, no browser: node test/planet-maths.js
//  - edges: a straight walk across each of the 24 face edges carries on straight in the flat (unfolded) view (the prototype's
//    tools/check-edges.js)
//  - handedness: grid u, up and grid v form a right-handed frame on the sphere, as Blockfield draws x, y, z (not mirrored)
//  - atlas: canon of every edge's margin agrees with wrap, block cells map to cells and back, rel / distance agree with the great
//    circle near edges, wedges and opposite faces are flagged, lat/lon round-trips, recanon keeps a walk straight
//  - one world: the helpers' identity branches for the flat generators 1 to 3 were removed with them (r14-24); the helpers treat any
//    point as an atlas point, whatever BF.state.gen says, and isPlanet() is gone (idea-045)
global.window = {};
require(__dirname + "/../js/planet.js");
const BF = window.BF, P = BF.planet, N = P.N;
let fails = 0;
const check = (ok, what) => { if (ok) console.log("ok " + what); else { fails++; console.log("FAIL " + what); } };
BF.state = { gen: 4 }; BF.SEA = 0;

// edges
{
  let bad = 0;
  for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) {
    const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
    const start = [h[0] ? (h[0] < 0 ? 3 : N - 3) : 40000, h[1] ? (h[1] < 0 ? 3 : N - 3) : 40000];
    const pt = [start[0] + h[0] * 7, start[1] + h[1] * 7];
    const g = P.wrap(f, pt[0], pt[1], {}), e = P.UNFOLD[f][g.f], A = e.A;
    const hu = A[0] * h[0] + A[2] * h[1], hv = A[1] * h[0] + A[3] * h[1];
    const nxt = [g.u + hu * 10, g.v + hv * 10];
    const back = [A[0] * nxt[0] + A[1] * nxt[1] + e.t[0], A[2] * nxt[0] + A[3] * nxt[1] + e.t[1]];
    const want = [pt[0] + h[0] * 10, pt[1] + h[1] * 10];
    if (Math.hypot(back[0] - want[0], back[1] - want[1]) > 1e-6) { bad++; console.log("  edge", f, s, back, want); }
  }
  check(bad === 0, "all 24 edge crossings continue straight in the flat view");
  let pairs = 0;
  for (let f = 0; f < 6; f++) for (let g = 0; g < 6; g++) if (P.UNFOLD[f][g]) { pairs++; const b = P.UNFOLD[g][f]; if (!b || (b.turn + P.UNFOLD[f][g].turn) % 4) bad++; }
  check(pairs === 24 && bad === 0, "every face has 4 neighbours, unfolds are mutual and their turns cancel");
  check([0, 1, 2, 3, 4, 5].every(f => !P.UNFOLD[f][f ^ 1]), "opposite faces never share a margin");
}

// handedness: in Blockfield's view x = u, y = up, z = v, so eu x up must point along +ev
{
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let bad = 0;
  for (let f = 0; f < 6; f++) for (const [u, v] of [[N / 2, N / 2], [N * 0.1, N * 0.8], [N * 0.95, N * 0.05]]) {
    const fr = P.frame(f, u, v, 0, {}), c = cross(fr.eu, fr.up);
    if (dot(c, fr.ev) / (Math.hypot(...c) * Math.hypot(...fr.ev)) < 0.9) bad++;
  }
  check(bad === 0, "grid u, up, grid v are right-handed on every face (round view not mirrored)");
  const fr = P.frame(4, N / 2, N / 2, 0, {});
  check(Math.abs(Math.hypot(...fr.eu) - 1) < 1e-3 && Math.abs(Math.hypot(...fr.ev) - 1) < 1e-3, "a column at a face centre is one block wide");
  check(Math.abs(P.pos(4, N / 2, N / 2, 100, [0, 0, 0])[2] - (P.R + 100)) < 1e-6, "layer y sits at radius R + y (sea level 0)");
}

// atlas: canon against wrap over every edge's margin
{
  let bad = 0, n = 0;
  const c = {}, w = {};
  for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) for (const depth of [0.25, 1.5, 37, 5000, N - 0.5]) for (const along of [0.5, 2, 9000.25, N / 2, N - 1.5]) {
    const u = s === 0 ? -depth : s === 1 ? N - 1 + depth : along, v = s === 2 ? -depth : s === 3 ? N - 1 + depth : along;
    const x = P.W * f + N + u, z = N + v;
    P.canon(x, z, c); P.wrap(f, u, v, w); n++;
    if (c.wedge || c.off || c.f !== w.f || Math.abs(c.u - w.u) > 1e-6 || Math.abs(c.v - w.v) > 1e-6 || c.f !== P.face(c.x, c.z) || c.u < 0 || c.u >= N || c.v < 0 || c.v >= N) {
      bad++; if (bad < 5) console.log("  canon", f, s, u, v, JSON.stringify(c), JSON.stringify(w));
    }
  }
  check(bad === 0, "canon of " + n + " margin points agrees with wrap and lands inside a face");
  // block cells: the canonical cell, unfolded back into the margin face's frame, is the same cell
  bad = 0; n = 0;
  const r = {};
  for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) for (const depth of [0, 1, 2, 15, 16, 17, 300]) for (const along of [0, 1, 7, 15, 16, 4097, N - 1]) {
    const u = s === 0 ? -1 - depth : s === 1 ? N + depth : along, v = s === 2 ? -1 - depth : s === 3 ? N + depth : along;
    const x = P.W * f + N + u, z = N + v, cc = P.canonCell(x, z, {});
    n++;
    if (!Number.isInteger(cc.x) || !Number.isInteger(cc.z) || cc.wedge) { bad++; continue; }
    const back = P.rel({ x: P.W * f + N + N / 2, z: N + N / 2 }, { x: cc.x + 0.5, z: cc.z + 0.5 }, r);
    if (!back || Math.floor(back.x) !== x || Math.floor(back.z) !== z) { bad++; if (bad < 5) console.log("  cell", f, s, x, z, JSON.stringify(cc), JSON.stringify(back)); }
  }
  check(bad === 0, "canonCell of " + n + " margin cells is a cell that unfolds back onto the same cell");
  // corner wedges, off the atlas, opposite faces
  const wd = P.canon(P.W * 2 + N - 10, N - 10, {});
  check(wd.wedge && !wd.off && wd.u >= 0 && wd.u < N, "a point past two edges is flagged as a corner wedge and falls back onto a face");
  check(P.canon(-5, 10, {}).off && P.canon(10, 3 * N + 1, {}).off && P.canon(6 * P.W + 1, 10, {}).off && P.face(-1, 5) === -1 && P.face(6 * P.W, 5) === -1, "points outside every face square are off");
  check(P.rel(P.atlas(0, 10, 10), P.atlas(1, 10, 10)) === null, "rel across the opposite face is null");
  const at = P.atlas(3, 123.5, 456.25), g = P.grid(at.x, at.z);
  check(P.face(at.x, at.z) === 3 && g.f === 3 && g.u === 123.5 && g.v === 456.25, "atlas and grid round-trip");
}

// rel and distance near edges against the great circle
{
  let bad = 0, worst = 0, n = 0;
  for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) for (const off of [1, 30, 200, 1500]) {
    // a just inside the edge, b the same distance outside it, both on the edge's mid line (walk perpendicular to the edge)
    const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
    const au = h[0] ? (h[0] < 0 ? off : N - off) : N / 2, av = h[1] ? (h[1] < 0 ? off : N - off) : N / 2;
    const a = P.atlas(f, au, av), bm = { x: a.x + h[0] * 2 * off, z: a.z + h[1] * 2 * off };
    const b = P.canon(bm.x, bm.z, {});
    const d = P.distance(a, b), gc = P.gridDistance({ f, u: au, v: av }, b), rl = P.rel(a, b, {});
    n++; worst = Math.max(worst, Math.abs(d - gc));
    if (Math.abs(d - gc) > 1 || !rl || Math.hypot(rl.x - bm.x, rl.z - bm.z) > 1e-6) { bad++; console.log("  rel", f, s, off, d, gc, JSON.stringify(rl), JSON.stringify(bm)); }
    const tw = P.toward(a, b, {});
    if (Math.abs(tw.x - h[0] * 2 * off) > 1e-6 || Math.abs(tw.z - h[1] * 2 * off) > 1e-6) { bad++; console.log("  toward", f, s, off, JSON.stringify(tw)); }
  }
  check(bad === 0, "rel unfolds across all 24 edges and distance agrees with the great circle within a block (" + n + " pairs, worst " + worst.toFixed(3) + ")");
  // far apart: great circle, and toward points the right way
  const a = P.atlas(4, N / 2, N / 2), b = P.atlas(0, N / 2, N / 2), c = P.atlas(5, N / 2, N / 2);
  check(Math.abs(P.distance(a, b) - P.R * Math.PI / 2) < 1, "a quarter of the way round is a quarter of the equator");
  check(Math.abs(P.distance(a, c) - P.R * Math.PI) < 1, "the far side is half the equator away (across the opposite face)");
  const t = P.toward(a, b, {}), un = P.UNFOLD[4][0], cen = { x: un.A[0] * N / 2 + un.A[1] * N / 2 + un.t[0] - N / 2, z: un.A[2] * N / 2 + un.A[3] * N / 2 + un.t[1] - N / 2 };
  check((t.x * cen.x + t.z * cen.z) / (Math.hypot(t.x, t.z) * Math.hypot(cen.x, cen.z)) > 0.999 && Math.abs(t.d - P.distance(a, b)) < 1e-6, "toward a far point heads where its face unfolds and spans the great circle");
}

// lat / lon, recanon
{
  let bad = 0;
  for (const [lat, lon] of [[0, 0], [45, 45], [-60, 170], [89, -30], [10, -100], [-30, 95]]) {
    const at = P.atlasOfLatLon(lat, lon, {}), ll = P.latLonAt(at.x, at.z, {});
    if (Math.abs(ll.lat - lat) > 1e-6 || Math.abs(((ll.lon - lon + 540) % 360) - 180) > 1e-6) { bad++; console.log("  latlon", lat, lon, JSON.stringify(ll)); }
  }
  check(bad === 0, "latitude / longitude round-trip");
  check(Math.abs(P.latLon(4, N / 2, N / 2).lat) < 1e-9 && Math.abs(P.latLon(2, N / 2, N / 2).lat - 90) < 1e-9 && Math.abs(P.latLon(3, N / 2, N / 2).lat + 90) < 1e-9, "face 4 centre is on the equator, faces 2 and 3 are the poles");
  // walking forward across each edge: after recanon the walk carries on along the same great circle (one more step lands
  // where a step in the margin would have shown)
  bad = 0;
  for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) {
    const h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
    const yaw = Math.atan2(-h[0], -h[1]);      // forward = (-sin yaw, -cos yaw) = h
    const u = h[0] ? (h[0] < 0 ? -2.5 : N + 2.5) : 7000.5, v = h[1] ? (h[1] < 0 ? -2.5 : N + 2.5) : 7000.5;
    const e = { x: P.W * f + N + u, z: N + v, yaw, vx: h[0] * 3, vz: h[1] * 3 };
    const q = P.recanon(e);
    const step = P.canon(P.W * f + N + u + h[0] * 5, N + v + h[1] * 5, {});
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    if (q <= 0 && P.UNFOLD[f][P.canon(e.x, e.z, {}).f].turn !== 0) { bad++; continue; }
    if (Math.abs(e.x + fx * 5 - step.x) > 1e-6 || Math.abs(e.z + fz * 5 - step.z) > 1e-6 || Math.abs(e.vx - fx * 3) > 1e-6 || Math.abs(e.vz - fz * 3) > 1e-6) { bad++; console.log("  recanon", f, s, JSON.stringify(e), JSON.stringify(step)); }
  }
  check(bad === 0, "recanon moves a walker across all 24 edges with its yaw and velocity turned so it carries on straight");
  check(P.recanon({ x: P.W * 2 + N + 5, z: N + 5 }) === 0, "recanon leaves a canonical point alone");
}

// no flat worlds any more (r14-24): the helpers no longer read BF.state.gen
{
  BF.state.gen = 3;
  const c = P.canon(-12.5, 99, {}), m = P.canon(P.W * 4 + N - 10, N + 5, {});
  check(P.isPlanet === undefined && c.off && m.f !== 4 && !m.off, "no isPlanet(): an old generator number changes nothing, a point left of the atlas is off it and a margin point is mapped");
  BF.state.gen = 4;
}

console.log(fails ? "FAIL planet-maths: " + fails + " checks failed" : "PASS planet-maths");
process.exit(fails ? 1 : 0);
