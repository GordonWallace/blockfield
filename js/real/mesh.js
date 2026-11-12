// Blockfield 1.6, the realistic look: the mesher's extra passes (docs/REALISTIC_CONTRACT.md section 4). Runs wherever js/mesher.js
// runs (the page and the mesher workers), only for jobs that carry J.real, and reads nothing but the job, the tables and the
// helpers the mesher hands it.
//   prepare(J, TB, h) -> R: finds the trees and the cells the cube pass must leave out
//     R.NAT[b] natural ground (drawn by the smooth pass), R.skip(b, x, y, z) -> true when the cube pass leaves this cell out
//   finish(R) -> { T, F }: T the smooth terrain pass { pos, nrm, col, sky, bl, mat, till, sphere, ind } (mat: the 4 layers' weights, adding
//     up to 1 + the share of turf; till: the share of tilled soil), F the flora list (8 floats a record)
// h: { get, lget, skyAt, tint(vx, vz, kind, out), sphere(pos) }
(() => {
"use strict";
const G = globalThis;
const BF = (G.BF = G.BF || {});
const CS = 16, W = 20;   // the chunk and the 2-block ring around it

function prepare(J, TB, h) {
  const RT = TB.real, TREE = RT.TREE, COVER = RT.COVER, get = h.get, OPAQUE = TB.OPAQUE;
  // What is ground is decided column by column: terracotta and sandstone are ground only in the columns of their home biome (J.clay,
  // js/world.js), and the chunks on both sides of a border read the same columns, so they agree and their ground meets. (A job with no
  // J.clay decides for the whole chunk: J.real 2 is "not their home".)
  const NATA = RT.NAT, NATB = RT.NATB || RT.NAT, CL = J.clay || null;
  const nat = CL ? (b, x, z) => (CL[(z + 2) * W + x + 2] ? NATA : NATB)[b] : J.real === 2 ? b => NATB[b] : b => NATA[b];
  let allClay = !CL ? J.real !== 2 : true;
  if (CL) for (let i = 0; i < CL.length && allClay; i++) if (!CL[i]) allClay = false;
  const NAT = allClay ? NATA : NATB;   // (for the cube pass's whole-section shortcut: what is ground in every column)
  // the band is the job's ring band: with the look on it covers the neighbours' bands too (js/world.js meshJob), so the chunks on both
  // sides of a border see the same cells around it and their ground meets
  const ya = J.Y0, yb = J.Y1, NY = yb - ya;
  // the natural-ground mask over the chunk and its ring: the ground index + 1, or 0
  const mask = new Uint8Array(W * W * NY);
  // built cells: full blocks the cube pass draws (planks, job sites, a log border). The ground against them stays square.
  const hard = new Uint8Array(W * W * NY);
  const logs = [];   // candidate trunk bases
  for (let z = -2; z < CS + 2; z++) for (let x = -2; x < CS + 2; x++) {
    const o = ((z + 2) * W + x + 2) * NY;
    let below = get(x, ya - 1, z);
    for (let i = 0; i < NY; i++) {
      const b = get(x, ya + i, z);
      if (b) {
        const n = nat(b, x, z);
        if (n) mask[o + i] = n;
        else {
          if (OPAQUE[b] && TREE[b] !== 2) hard[o + i] = 1;
          if ((TREE[b] & 1) && nat(below, x, z)) logs.push(x, ya + i, z, b);
        }
      }
      below = b;
    }
  }
  // trees: a column of logs on natural ground with its own leaves at the top. Its logs (and any joined to them) leave the cube pass.
  const gone = new Set(), F = [];
  const ck = (x, y, z) => ((y - ya) * W + z + 2) * W + x + 2;
  const leafOf = (b, x, y, z) => { const n = get(x, y, z); return TREE[n] === 2 && RT.SPEC[n] === b; };
  // stumps: the low corner of the full 2 x 2 square of log b at height y that holds (x, z), or null
  // a log that leaves the cube pass (a tree's, a stump's) is not a built cell: the ground around it stays smooth
  const soft = k => { const c = k % (W * W); hard[c * NY + (k - c) / (W * W)] = 0; };
  const square = (x, y, z, b) => {
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const cx = x + dx, cz = z + dz;
      if (get(cx, y, cz) === b && get(cx + 1, y, cz) === b && get(cx, y, cz + 1) === b && get(cx + 1, y, cz + 1) === b) return [cx, cz];
    }
    return null;
  };
  const SOLID = TB.SOLID;
  // J.stood: the cells (atlas x, y, z in threes) where a tree's trunk stands or stood, in and around the chunk (js/real/fell.js): only
  // there is a short leafless column of logs a stump. A log the player places anywhere else is a block.
  const ST = J.stood || null;
  const stood = (x, y, z) => {
    if (!ST) return false;
    const ax = J.ox + x, az = J.oz + z;
    for (let i = 0; i < ST.length; i += 3) if (ST[i] === ax && ST[i + 1] === y && ST[i + 2] === az) return true;
    return false;
  };
  const stump = (x, y, z, b, hgt) => {
    const top = get(x, y + hgt, z);
    if (top && TREE[top] !== 2 && SOLID[top]) return false;   // something stands on it: a post
    const sq = square(x, y, z, b);
    for (let k = 0; k < hgt; k++) for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0) - (d === 1), nz = z + (d === 2) - (d === 3), n = get(nx, y + k, nz);
      if (!n || nat(n, nx, nz) || TREE[n] === 2) continue;
      if (n === b) { if (sq && nx >= sq[0] && nx <= sq[0] + 1 && nz >= sq[1] && nz <= sq[1] + 1) continue; return false; }   // a row of logs is a wall
      if (SOLID[n]) return false;   // built against it
    }
    return true;
  };
  for (let i = 0; i < logs.length; i += 4) {
    const x = logs[i], y = logs[i + 1], z = logs[i + 2], b = logs[i + 3];
    if (gone.has(ck(x, y, z))) continue;   // (already part of a tree found before)
    let hgt = 1;
    while (get(x, y + hgt, z) === b && hgt < 64) hgt++;
    // its logs: the column and whatever touches it (a bent trunk, branches), within the ring
    const q = [], mine = [];
    for (let k = 0; k < hgt; k++) { mine.push(ck(x, y + k, z)); q.push(x, y + k, z); }
    const seen = new Set(mine);
    let top = y + hgt;
    for (let qi = 0, n = 0; qi < q.length && n < 400; qi += 3, n++) {
      const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2];
      for (let dy = 0; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy, nz = qz + dz;
        if (nx < -2 || nx > CS + 1 || nz < -2 || nz > CS + 1 || ny >= yb) continue;
        if (ny === y && (dx || dz)) continue;   // not along the ground: the next trunk is its own tree
        const k = ck(nx, ny, nz);
        if (seen.has(k) || get(nx, ny, nz) !== b) continue;
        seen.add(k); mine.push(k); q.push(nx, ny, nz);
        if (ny + 1 > top) top = ny + 1;
      }
    }
    // a tree has its own leaves against one of its logs (a leafless species needs none)
    let leafy = TREE[b] === 3;
    for (let qi = 0; qi < q.length && !leafy; qi += 3) {
      const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2];
      leafy = leafOf(b, qx, qy + 1, qz) || leafOf(b, qx + 1, qy, qz) || leafOf(b, qx - 1, qy, qz) || leafOf(b, qx, qy, qz + 1) || leafOf(b, qx, qy, qz - 1);
    }
    if (!leafy) {
      // a trunk that reaches the rim of the ring (a bent one, an acacia's) may have its crown out of sight: the chunk it stands in
      // sees it whole and takes it for a tree, so here it is not a built cell either, or the two would shape the ground around it
      // differently and it would part along their border
      if (TREE[b] === 1 && q.length >= 9) {
        let rim = false;
        for (let qi = 0; qi < q.length && !rim; qi += 3) rim = q[qi] <= -2 || q[qi] >= CS + 1 || q[qi + 2] <= -2 || q[qi + 2] >= CS + 1;
        if (rim) { for (const k of mine) soft(k); continue; }
      }
      // a stump (what a felled tree leaves, js/real/fell.js): one to three logs of a tree species standing alone on natural ground
      // with nothing on top, where a tree stood (J.stood). Its logs leave the cube pass and it is listed as kind 5. Posts and what the
      // player builds or places stay cubes.
      if (TREE[b] === 1 && hgt <= 3 && q.length === hgt * 3 && x >= -1 && x <= CS && z >= -1 && z <= CS && stood(x, y, z) && stump(x, y, z, b, hgt)) {
        for (const k of mine) soft(k);   // (a neighbour's next to the border too: both sides must shape the ground around it alike)
        if (x < 0 || x >= CS || z < 0 || z >= CS) continue;   // a neighbour's: it hides and lists it
        for (const k of mine) gone.add(k);
        const sq = square(x, y, z, b);
        if (sq && (sq[0] !== x || sq[1] !== z)) continue;   // listed at the square's low corner
        const hs = (((J.ox + x) * 73856093) ^ ((J.oz + z) * 19349663) ^ (y * 83492791)) >>> 0;
        F.push(x + (sq ? 1 : 0.5), y, z + (sq ? 1 : 0.5), 5, b, hgt, (hs % 65521) / 65521,
          Math.round(h.skyAt(x, y + hgt, z) * 15) + 16 * h.lget(x, y + hgt, z));
      }
      continue;
    }
    for (const k of mine) { gone.add(k); soft(k); }
    const ty = top; hgt = top - y;
    if (x < 0 || x >= CS || z < 0 || z >= CS) continue;   // a neighbour's tree: it lists it
    // a 2 x 2 trunk is one big tree, listed at its low corner
    if (get(x - 1, y, z) === b || get(x, y, z - 1) === b || get(x - 1, y, z - 1) === b) continue;
    const big = get(x + 1, y, z) === b && get(x, y, z + 1) === b;
    const hs = (((J.ox + x) * 73856093) ^ ((J.oz + z) * 19349663) ^ (y * 83492791)) >>> 0;
    F.push(x + (big ? 1 : 0.5), y, z + (big ? 1 : 0.5), big ? 4 : 0, b, hgt, (hs % 65521) / 65521,
      Math.round(h.skyAt(x + 1, ty, z) * 15) + 16 * h.lget(x + 1, y + 1, z));
  }
  return {
    J, TB, h, mask, hard, ya, NY, F, NAT, nat,
    skip(b, x, y, z) {
      if (nat(b, x, z)) return true;
      const t = TREE[b];
      if (t === 2) return true;
      if (t & 1) return gone.has(ck(x, y, z));
      if (COVER[b]) {
        const hs = (((J.ox + x) * 73856093) ^ ((J.oz + z) * 19349663)) >>> 0;
        F.push(x + 0.5, y, z + 0.5, 2, b, 1, (hs % 65521) / 65521, Math.round(h.skyAt(x, y, z) * 15) + 16 * h.lget(x, y, z));
        return true;
      }
      return false;
    },
  };
}

// Surface nets over the mask: one vertex in every 2 x 2 x 2 group of cells the ground's surface passes through, at the middle of the
// crossings, eased once towards its neighbours; a quad across every ground-to-open edge the chunk owns. A flat floor comes out
// exactly on the block tops, so the smooth ground agrees with the block grid the game collides with.
function finish(R) {
  const { J, TB, h, mask, hard, ya, NY } = R, RT = TB.real;
  const CW = W - 1, NC = CW * CW;   // cells (i, k) from -2 .. 16, index i + 2
  const m = (x, y, z) => mask[((z + 2) * W + x + 2) * NY + y];   // y: index into the band
  const hm = (x, y, z) => hard[((z + 2) * W + x + 2) * NY + y];
  // raw vertices, layer by layer (cell j spans band rows j and j + 1)
  const vid = new Int32Array(NC * (NY - 1)).fill(-1);
  const raw = [], cellOf = [], square = [];
  for (let j = 0; j < NY - 1; j++) for (let k = -2; k < CS + 1; k++) for (let i = -2; i < CS + 1; i++) {
    let bits = 0, n = 0, sq = 0;
    for (let c = 0; c < 8; c++) {
      const X = i + (c & 1), Y = j + ((c >> 1) & 1), Z = k + (c >> 2);
      if (m(X, Y, Z)) { bits |= 1 << c; n++; } else if (hm(X, Y, Z)) sq = 1;
    }
    if (n === 0 || n === 8) continue;
    // against a built block the vertex sits on the block grid and is not eased: the ground there is the blocks' own shape, flat under
    // a beehive and square against a wall, with no gap for the cube to hang over
    if (sq) {
      vid[j * NC + (k + 2) * CW + i + 2] = raw.length / 3;
      raw.push(i + 1, j + 1, k + 1); cellOf.push(i, j, k); square.push(1);
      continue;
    }
    let sx = 0, sy = 0, sz = 0, e = 0;
    for (let c = 0; c < 8; c++) for (let a = 0; a < 3; a++) {
      if (c & (1 << a)) continue;
      const d = c | (1 << a);
      if (((bits >> c) & 1) === ((bits >> d) & 1)) continue;
      sx += (c & 1) + (a === 0 ? 0.5 : 0); sy += ((c >> 1) & 1) + (a === 1 ? 0.5 : 0); sz += (c >> 2) + (a === 2 ? 0.5 : 0); e++;
    }
    vid[j * NC + (k + 2) * CW + i + 2] = raw.length / 3;
    raw.push(i + 0.5 + sx / e, j + 0.5 + sy / e, k + 0.5 + sz / e);
    cellOf.push(i, j, k); square.push(0);
  }
  // a wall cell: one of its 4 columns is ground at both levels and another is open at both
  const LEAN = 0.08;
  const wall = (i, j, k) => {
    if (j < 0) return false;
    let full = 0, open = 0;
    for (let c = 0; c < 4; c++) {
      const X = i + (c & 1), Z = k + (c >> 1), a = m(X, j, Z) || hm(X, j, Z), b = m(X, j + 1, Z) || hm(X, j + 1, Z);
      if (a && b) full = 1; else if (!a && !b) open = 1;
    }
    return full && open;
  };
  const nv = raw.length / 3;
  if (!nv) return { T: null, F: R.F.length ? new Float32Array(R.F) : null };
  const at = (i, j, k) => (i < -2 || i > CS || k < -2 || k > CS || j < 0 || j >= NY - 1) ? -1 : vid[j * NC + (k + 2) * CW + i + 2];
  // the vertices the chunk's quads use (cells -1 .. 15), eased once, with normal, light and ground
  // A vertex is listed once per face kind that uses it: 0 for faces that look up (the ground's top), 1 for the rest (walls, the
  // undersides of overhangs). Both have the same place, normal and light; what differs is which ground they show. A top shows the
  // ground whose top it is, so the floor of a dug hole is the soil that was dug down to, not the turf around its rim. A wall shows
  // what a cut through the ground shows: turf is green on top only, and its side is the soil under it (RT.GSIDE), unless the foot of
  // that side is turf too, which is how a grassy slope's steps look.
  const out = new Int32Array(nv * 2).fill(-1);
  const P = [], Nn = [], C = [], SK = [], BLt = [], MT = [], TL = [], tc = [1, 1, 1];
  const gc = RT.GCOL, GLAY = RT.GLAY, GTINT = RT.GTINT, GSIDE = RT.GSIDE, GTILL = RT.GTILL || GTINT.map(() => 0);
  const acc = new Float64Array(10);   // r, g, b, the 4 layers, turf, count, tilled (tops only)
  const addG = (g, x, z, w) => {
    let r = gc[g * 3], gg = gc[g * 3 + 1], b = gc[g * 3 + 2];
    if (GTINT[g]) { h.tint(Math.max(0, Math.min(CS, Math.round(x))), Math.max(0, Math.min(CS, Math.round(z))), 1, tc); r *= tc[0]; gg *= tc[1]; b *= tc[2]; acc[7] += w; }
    acc[0] += r * w; acc[1] += gg * w; acc[2] += b * w; acc[3 + GLAY[g]] += w; acc[8] += w;
  };
  // The cut edge of turf (the rim of a dug hole, the lip of a bank): the side of a turf cell at band row Y that shows soil, seen
  // from the 2 x 2 columns at (i, k). Returns the turf's ground index + 1, or 0. The line where turf ends is not drawn at the rim
  // itself: the top's rim vertices carry a little soil and the wall's top vertices are turf, so the material (js/real/terrain.js)
  // breaks the edge up, soil biting into the sward and turf hanging over the cut.
  const cutTurf = (i, Y, k) => {
    if (Y < 0 || Y >= NY) return 0;
    for (let e = 0; e < 4; e++) {
      const X0 = i + (e === 1 ? 1 : 0), Z0 = k + (e === 3 ? 1 : 0), X1 = e < 2 ? X0 : X0 + 1, Z1 = e < 2 ? Z0 + 1 : Z0;
      const a = m(X0, Y, Z0), b = m(X1, Y, Z1);
      if (!a === !b) continue;
      const g = (a || b) - 1;
      if (GSIDE[g] === g) continue;
      const ox = a ? X1 : X0, oz = a ? Z1 : Z0, sx = a ? X0 : X1, sz = a ? Z0 : Z1;
      if (hm(ox, Y, oz) || (Y + 1 < NY && m(sx, Y + 1, sz))) continue;   // against something built, or not the top of the turf
      const foot = Y > 0 ? m(ox, Y - 1, oz) : 0;
      if (!foot || GSIDE[foot - 1] === foot - 1) return g + 1;
    }
    return 0;
  };
  const vert = (v, side) => {
    const slot = v * 2 + side;
    if (out[slot] >= 0) return out[slot];
    const i = cellOf[v * 3], j = cellOf[v * 3 + 1], k = cellOf[v * 3 + 2];
    let x = raw[v * 3], y = raw[v * 3 + 1], z = raw[v * 3 + 2], ax = 0, ay = 0, az = 0, an = 0;
    if (!square[v]) for (let d = 0; d < 6; d++) {
      const u = at(i + (d === 0) - (d === 1), j + (d === 2) - (d === 3), k + (d === 4) - (d === 5));
      if (u >= 0) { ax += raw[u * 3]; ay += raw[u * 3 + 1]; az += raw[u * 3 + 2]; an++; }
    }
    if (an) { x = 0.5 * x + 0.5 * ax / an; y = 0.5 * y + 0.5 * ay / an; z = 0.5 * z + 0.5 * az / an; }
    // beside a wall two blocks high or more (a dug shaft, a trench, a cliff foot) the surface must not lean into the open cells: the
    // player stands in them against the blocks, and a wall pulled in past the eye is seen from behind, that is, not at all
    if (!square[v] && (wall(i, j, k) || wall(i, j - 1, k))) {
      const gx = i + 1, gz = k + 1, dx = x - gx, dz = z - gz;
      if (dx || dz) {
        const cx = i + (dx > 0 ? 1 : 0), cz = k + (dz > 0 ? 1 : 0);
        if (!m(cx, j, cz) && !hm(cx, j, cz) && !m(cx, j + 1, cz) && !hm(cx, j + 1, cz)) {
          x = gx + Math.max(-LEAN, Math.min(LEAN, dx)); z = gz + Math.max(-LEAN, Math.min(LEAN, dz));
        }
      }
    }
    // normal: away from the ground in the 4 x 4 x 4 cells around; light: the open cells' mean
    let nx = 0, ny = 0, nz = 0;
    for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
      const X = i + dx, Y = j + dy, Z = k + dz;
      // (a built block at or under the surface is solid too: over a floor of sandstone blocks the sand between them would otherwise
      // take its normal from the pit's walls above alone and face down, that is, be drawn black)
      const solid = Y < 0 ? 1 : Y >= NY ? 0 : (X < -2 || X > CS + 1 || Z < -2 || Z > CS + 1) ? -1 : (m(X, Y, Z) || (dy <= 0 && hm(X, Y, Z))) ? 1 : 0;
      if (solid !== 1) continue;
      nx -= dx - 0.5; ny -= dy - 0.5; nz -= dz - 0.5;
    }
    let l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) { nx = 0; ny = 1; nz = 0; l = 1; }
    let g = 0, gy = -1, sk = 0, bl = 0, on = 0;
    for (let c = 0; c < 8; c++) {
      const X = i + (c & 1), Yi = j + ((c >> 1) & 1), Z = k + (c >> 2), mv = m(X, Yi, Z);
      if (mv) { if (Yi > gy) { gy = Yi; g = mv - 1; } }
      else { sk += h.skyAt(X, ya + Yi, Z); bl += h.lget(X, ya + Yi, Z); on++; }
    }
    // ground
    acc.fill(0);
    if (!side) {
      // a top: the grounds of the (up to 4) cells of the lower level whose tops are open, mixed
      for (let c = 0; c < 4; c++) {
        const X = i + (c & 1), Z = k + (c >> 1), mv = m(X, j, Z);
        if (mv && !m(X, j + 1, Z)) { addG(mv - 1, x, z, 1); if (GTILL[mv - 1]) acc[9] += 1; }
      }
      const ct = cutTurf(i, j, k);
      if (ct && acc[8]) addG(GSIDE[ct - 1], x, z, 0.16 * acc[8]);
    } else if (cutTurf(i, j, k)) addG(cutTurf(i, j, k) - 1, x, z, 1);   // (the top of a cut through turf: the sward's own edge)
    else {
      // a wall: the sides of the cells that have an open cell beside them, mixed
      for (let Y = j; Y <= j + 1; Y++) for (let e = 0; e < 4; e++) {
        const X0 = i + (e === 1 ? 1 : 0), Z0 = k + (e === 3 ? 1 : 0), X1 = e < 2 ? X0 : X0 + 1, Z1 = e < 2 ? Z0 + 1 : Z0;
        const a = m(X0, Y, Z0), b = m(X1, Y, Z1);
        if (!a === !b) continue;
        let sg = (a || b) - 1;
        if (GSIDE[sg] !== sg) {
          const foot = Y > 0 ? (a ? m(X1, Y - 1, Z1) : m(X0, Y - 1, Z0)) : 0;
          if (!foot || GSIDE[foot - 1] === foot - 1) sg = GSIDE[sg];
        }
        addG(sg, x, z, 1);
      }
    }
    if (!acc[8]) addG(side ? GSIDE[g] : g, x, z, 1);
    const id = P.length / 3, w = 1 / acc[8], tf = 1 + acc[7] * w;   // (the layers' weights add up to 1 + the share of turf: terrain.js)
    P.push(x, y + ya, z); Nn.push(nx / l, ny / l, nz / l);
    SK.push(on ? sk / on : 0); BLt.push(on ? bl / on / 15 : 0);
    C.push(acc[0] * w, acc[1] * w, acc[2] * w);
    MT.push(acc[3] * w * tf, acc[4] * w * tf, acc[5] * w * tf, acc[6] * w * tf);
    TL.push(side ? 0 : Math.min(1, acc[9] * w));   // (the share of tilled soil, drawn in furrows: js/real/terrain.js)
    return (out[slot] = id);
  };
  const I = [];
  // edges from a cell of the chunk (x, y, z) to the next along each axis; the 4 cells of vertices around the edge
  const quad = (a, b, c, d, flip, side) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const A = vert(a, side), B = vert(b, side), Cc = vert(c, side), D = vert(d, side);
    if (flip) I.push(A, Cc, B, A, D, Cc); else I.push(A, B, Cc, A, Cc, D);
  };
  // The riser of a step one block high (ground at its foot, nothing on the cell it is the side of) is part of a slope, not a cut:
  // it takes its vertices as tops, the upper ones the ground of the upper level and the lower ones the ground of the lower level, so
  // one ground runs into the other across the step as it does on the flat, with the same rough edge, and not along a straight line.
  const step = (sx, sz, ox, oz, y) => (m(ox, y - 1, oz) && !m(sx, y + 1, sz) && !hm(sx, y + 1, sz)) ? 0 : 1;
  for (let y = 1; y < NY - 1; y++) for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const s = m(x, y, z) ? 1 : 0;
    // +x edge: cells (x, y-1..y, z-1..z)
    // (no quad against a built block: its vertices are all on the grid, so it would lie in the block's own face)
    let t = m(x + 1, y, z) ? 1 : 0;
    if (s !== t && !hm(x + s, y, z)) quad(at(x, y - 1, z - 1), at(x, y, z - 1), at(x, y, z), at(x, y - 1, z), !s, s ? step(x, z, x + 1, z, y) : step(x + 1, z, x, z, y));
    t = m(x, y + 1, z) ? 1 : 0;
    if (s !== t && !hm(x, y + s, z)) quad(at(x - 1, y, z - 1), at(x - 1, y, z), at(x, y, z), at(x, y, z - 1), !s, s ? 0 : 1);
    t = m(x, y, z + 1) ? 1 : 0;
    if (s !== t && !hm(x, y, z + s)) quad(at(x - 1, y - 1, z), at(x, y - 1, z), at(x, y, z), at(x - 1, y, z), !s, s ? step(x, z, x, z + 1, y) : step(x, z + 1, x, z, y));
  }
  const F = R.F.length ? new Float32Array(R.F) : null;
  if (!I.length) return { T: null, F };
  // seat the plants on the smooth ground: where the ground slopes, its surface under a plant is not the block top the record's y
  // names. Each record's `extra` gains 256 x (d + 64 tx + 2048 tz): d (1 .. 63) how far the surface under the plant is above y,
  // (d - 32) / 31 blocks; tx, tz (1 .. 31) the surface's rise per block along x and z, (t - 16) / 15. A trunk goes down a little
  // further so its downhill side is in the ground. y itself stays the block's (the game's logic reads it). BF.real.seat decodes it.
  if (F) {
    const sf = [0, 0, 0];
    // the ground's top face under the cell (x, y, z), as the plane through its 4 corners (eased, they are not at the block's own
    // corners: on a stair of blocks the top faces are half as long as the blocks), read at (px, pz)
    const ov = v => out[v * 2] >= 0 ? out[v * 2] : out[v * 2 + 1];   // (a vertex is listed per face kind; both are at the same place)
    const V = (v, a) => P[ov(v) * 3 + a];
    const cl = v => Math.max(-1, Math.min(1, v));
    const surf = (x, y, z, px, pz) => {
      const Y = y - 1 - ya;
      if (x < 0 || x >= CS || z < 0 || z >= CS || Y < 1 || Y >= NY - 1 || !m(x, Y, z)) return false;
      const a = at(x - 1, Y, z - 1), b = at(x, Y, z - 1), c = at(x, Y, z), d = at(x - 1, Y, z);
      if (a < 0 || b < 0 || c < 0 || d < 0 || ov(a) < 0 || ov(b) < 0 || ov(c) < 0 || ov(d) < 0) return false;
      const wx = Math.max(0.25, (V(b, 0) + V(c, 0) - V(a, 0) - V(d, 0)) / 2), wz = Math.max(0.25, (V(c, 2) + V(d, 2) - V(a, 2) - V(b, 2)) / 2);
      sf[1] = cl((V(b, 1) + V(c, 1) - V(a, 1) - V(d, 1)) / 2 / wx); sf[2] = cl((V(c, 1) + V(d, 1) - V(a, 1) - V(b, 1)) / 2 / wz);
      sf[0] = (V(a, 1) + V(b, 1) + V(c, 1) + V(d, 1)) / 4 - y
        + sf[1] * cl(px - (V(a, 0) + V(b, 0) + V(c, 0) + V(d, 0)) / 4) + sf[2] * cl(pz - (V(a, 2) + V(b, 2) + V(c, 2) + V(d, 2)) / 4);
      return true;
    };
    const code = (v, n) => n + 1 + Math.round(Math.max(-1, Math.min(1, v)) * n);
    for (let o = 0; o < F.length; o += 8) {
      const kind = F[o + 3], x = Math.floor(F[o]), y = F[o + 1], z = Math.floor(F[o + 2]);
      const big = kind === 4 || (kind === 5 && F[o] % 1 === 0);   // on a 2 x 2 trunk: x and z are its middle
      let n = 0, dy = 0, gx = 0, gz = 0, lo = 9;
      for (let c = big ? 0 : 3; c < 4; c++) {
        if (!surf(x - 1 + (c & 1), y, z - 1 + (c >> 1), F[o], F[o + 2])) continue;
        n++; dy += sf[0]; gx += sf[1]; gz += sf[2]; if (sf[0] < lo) lo = sf[0];
      }
      if (!n) continue;
      dy /= n; gx /= n; gz /= n;
      if (kind !== 2) dy = (big ? lo : dy) - 0.3 * Math.hypot(gx, gz);
      F[o + 7] += 256 * (code(dy, 31) + 64 * code(gx, 15) + 2048 * code(gz, 15));
    }
  }
  const pos = new Float32Array(P);
  const T = {
    pos, nrm: new Float32Array(Nn), col: new Float32Array(C), sky: new Float32Array(SK), bl: new Float32Array(BLt), mat: new Float32Array(MT),
    till: new Float32Array(TL),
    sphere: J.sph ? h.sphere(P) : null,
    ind: P.length / 3 > 65535 ? new Uint32Array(I) : new Uint16Array(I),
  };
  return { T, F };
}

BF.realMesh = { prepare, finish };
})();
