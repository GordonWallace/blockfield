// Blockfield 1.6, the realistic look: the mesher's extra passes (docs/REALISTIC_CONTRACT.md section 4). Runs wherever js/mesher.js
// runs (the page and the mesher workers), only for jobs that carry J.real, and reads nothing but the job, the tables and the
// helpers the mesher hands it.
//   prepare(J, TB, h) -> R: finds the trees and the cells the cube pass must leave out
//     R.NAT[b] natural ground (drawn by the smooth pass), R.skip(b, x, y, z) -> true when the cube pass leaves this cell out
//   finish(R) -> { T, F }: T the smooth terrain pass { pos, nrm, col, sky, bl, mat, sphere, ind }, F the flora list (8 floats a record)
// h: { get, lget, skyAt, tint(vx, vz, kind, out), sphere(pos) }
(() => {
"use strict";
const G = globalThis;
const BF = (G.BF = G.BF || {});
const CS = 16, W = 20;   // the chunk and the 2-block ring around it

function prepare(J, TB, h) {
  const RT = TB.real, NAT = J.real === 2 && RT.NATB ? RT.NATB : RT.NAT, TREE = RT.TREE, COVER = RT.COVER, get = h.get;
  const ya = J.y0 - 2, yb = J.y1 + 2, NY = yb - ya;
  // the natural-ground mask over the chunk and its ring: the ground index + 1, or 0
  const mask = new Uint8Array(W * W * NY);
  const logs = [];   // candidate trunk bases
  for (let z = -2; z < CS + 2; z++) for (let x = -2; x < CS + 2; x++) {
    const o = ((z + 2) * W + x + 2) * NY;
    let below = get(x, ya - 1, z);
    for (let i = 0; i < NY; i++) {
      const b = get(x, ya + i, z);
      if (b) {
        const n = NAT[b];
        if (n) mask[o + i] = n;
        else if ((TREE[b] & 1) && NAT[below]) logs.push(x, ya + i, z, b);
      }
      below = b;
    }
  }
  // trees: a column of logs on natural ground with its own leaves at the top. Its logs (and any joined to them) leave the cube pass.
  const gone = new Set(), F = [];
  const ck = (x, y, z) => ((y - ya) * W + z + 2) * W + x + 2;
  const leafOf = (b, x, y, z) => { const n = get(x, y, z); return TREE[n] === 2 && RT.SPEC[n] === b; };
  // stumps: the low corner of the full 2 x 2 square of log b at height y that holds (x, z), or null
  const square = (x, y, z, b) => {
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const cx = x + dx, cz = z + dz;
      if (get(cx, y, cz) === b && get(cx + 1, y, cz) === b && get(cx, y, cz + 1) === b && get(cx + 1, y, cz + 1) === b) return [cx, cz];
    }
    return null;
  };
  const SOLID = TB.SOLID;
  const stump = (x, y, z, b, hgt) => {
    const top = get(x, y + hgt, z);
    if (top && TREE[top] !== 2 && SOLID[top]) return false;   // something stands on it: a post
    const sq = square(x, y, z, b);
    for (let k = 0; k < hgt; k++) for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0) - (d === 1), nz = z + (d === 2) - (d === 3), n = get(nx, y + k, nz);
      if (!n || NAT[n] || TREE[n] === 2) continue;
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
      // a stump (what a felled tree leaves, js/real/fell.js): one to three logs of a tree species standing alone on natural ground
      // with nothing on top. Its logs leave the cube pass and it is listed as kind 5. Posts and what the player builds stay cubes.
      if (TREE[b] === 1 && hgt <= 3 && q.length === hgt * 3 && x >= 0 && x < CS && z >= 0 && z < CS && stump(x, y, z, b, hgt)) {   // (a neighbour's: it hides and lists it)
        for (const k of mine) gone.add(k);
        const sq = square(x, y, z, b);
        if (sq && (sq[0] !== x || sq[1] !== z)) continue;   // listed at the square's low corner
        const hs = (((J.ox + x) * 73856093) ^ ((J.oz + z) * 19349663) ^ (y * 83492791)) >>> 0;
        F.push(x + (sq ? 1 : 0.5), y, z + (sq ? 1 : 0.5), 5, b, hgt, (hs % 65521) / 65521,
          Math.round(h.skyAt(x, y + hgt, z) * 15) + 16 * h.lget(x, y + hgt, z));
      }
      continue;
    }
    for (const k of mine) gone.add(k);
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
    J, TB, h, mask, ya, NY, F, NAT,
    skip(b, x, y, z) {
      if (NAT[b]) return true;
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
  const { J, TB, h, mask, ya, NY } = R, RT = TB.real;
  const CW = W - 1, NC = CW * CW;   // cells (i, k) from -2 .. 16, index i + 2
  const m = (x, y, z) => mask[((z + 2) * W + x + 2) * NY + y];   // y: index into the band
  // raw vertices, layer by layer (cell j spans band rows j and j + 1)
  const vid = new Int32Array(NC * (NY - 1)).fill(-1);
  const raw = [], cellOf = [];
  for (let j = 0; j < NY - 1; j++) for (let k = -2; k < CS + 1; k++) for (let i = -2; i < CS + 1; i++) {
    let bits = 0, n = 0;
    for (let c = 0; c < 8; c++) if (m(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2))) { bits |= 1 << c; n++; }
    if (n === 0 || n === 8) continue;
    let sx = 0, sy = 0, sz = 0, e = 0;
    for (let c = 0; c < 8; c++) for (let a = 0; a < 3; a++) {
      if (c & (1 << a)) continue;
      const d = c | (1 << a);
      if (((bits >> c) & 1) === ((bits >> d) & 1)) continue;
      sx += (c & 1) + (a === 0 ? 0.5 : 0); sy += ((c >> 1) & 1) + (a === 1 ? 0.5 : 0); sz += (c >> 2) + (a === 2 ? 0.5 : 0); e++;
    }
    vid[j * NC + (k + 2) * CW + i + 2] = raw.length / 3;
    raw.push(i + 0.5 + sx / e, j + 0.5 + sy / e, k + 0.5 + sz / e);
    cellOf.push(i, j, k);
  }
  const nv = raw.length / 3;
  if (!nv) return { T: null, F: R.F.length ? new Float32Array(R.F) : null };
  const at = (i, j, k) => (i < -2 || i > CS || k < -2 || k > CS || j < 0 || j >= NY - 1) ? -1 : vid[j * NC + (k + 2) * CW + i + 2];
  // the vertices the chunk's quads use (cells -1 .. 15), eased once, with normal, light and ground
  const out = new Int32Array(nv).fill(-1);
  const P = [], Nn = [], C = [], SK = [], BLt = [], MT = [], tc = [1, 1, 1];
  const SKB = TB.SKB;
  const vert = v => {
    if (out[v] >= 0) return out[v];
    const i = cellOf[v * 3], j = cellOf[v * 3 + 1], k = cellOf[v * 3 + 2];
    let x = raw[v * 3], y = raw[v * 3 + 1], z = raw[v * 3 + 2], ax = 0, ay = 0, az = 0, an = 0;
    for (let d = 0; d < 6; d++) {
      const u = at(i + (d === 0) - (d === 1), j + (d === 2) - (d === 3), k + (d === 4) - (d === 5));
      if (u >= 0) { ax += raw[u * 3]; ay += raw[u * 3 + 1]; az += raw[u * 3 + 2]; an++; }
    }
    if (an) { x = 0.5 * x + 0.5 * ax / an; y = 0.5 * y + 0.5 * ay / an; z = 0.5 * z + 0.5 * az / an; }
    // normal: away from the ground in the 4 x 4 x 4 cells around; ground: the highest natural cell of the 8; light: the open cells' mean
    let nx = 0, ny = 0, nz = 0;
    for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
      const X = i + dx, Y = j + dy, Z = k + dz;
      const solid = Y < 0 ? 1 : Y >= NY ? 0 : (X < -2 || X > CS + 1 || Z < -2 || Z > CS + 1) ? -1 : m(X, Y, Z) ? 1 : 0;
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
    const id = P.length / 3;
    P.push(x, y + ya, z); Nn.push(nx / l, ny / l, nz / l);
    SK.push(on ? sk / on : 0); BLt.push(on ? bl / on / 15 : 0);
    const gc = RT.GCOL, lay = RT.GLAY[g];
    let r = gc[g * 3], gg = gc[g * 3 + 1], b = gc[g * 3 + 2];
    if (RT.GTINT[g]) { h.tint(Math.max(0, Math.min(CS, Math.round(x))), Math.max(0, Math.min(CS, Math.round(z))), 1, tc); r *= tc[0]; gg *= tc[1]; b *= tc[2]; }
    C.push(r, gg, b);
    MT.push(lay === 0 ? 1 : 0, lay === 1 ? 1 : 0, lay === 2 ? 1 : 0, lay === 3 ? 1 : 0);
    return (out[v] = id);
  };
  const I = [];
  // edges from a cell of the chunk (x, y, z) to the next along each axis; the 4 cells of vertices around the edge
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const A = vert(a), B = vert(b), Cc = vert(c), D = vert(d);
    if (flip) I.push(A, Cc, B, A, D, Cc); else I.push(A, B, Cc, A, Cc, D);
  };
  for (let y = 1; y < NY - 1; y++) for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) {
    const s = m(x, y, z) ? 1 : 0;
    // +x edge: cells (x, y-1..y, z-1..z)
    let t = m(x + 1, y, z) ? 1 : 0;
    if (s !== t) quad(at(x, y - 1, z - 1), at(x, y, z - 1), at(x, y, z), at(x, y - 1, z), !s);
    t = m(x, y + 1, z) ? 1 : 0;
    if (s !== t) quad(at(x - 1, y, z - 1), at(x - 1, y, z), at(x, y, z), at(x, y, z - 1), !s);
    t = m(x, y, z + 1) ? 1 : 0;
    if (s !== t) quad(at(x - 1, y - 1, z), at(x, y - 1, z), at(x, y, z), at(x - 1, y, z), !s);
  }
  const F = R.F.length ? new Float32Array(R.F) : null;
  if (!I.length) return { T: null, F };
  const pos = new Float32Array(P);
  const T = {
    pos, nrm: new Float32Array(Nn), col: new Float32Array(C), sky: new Float32Array(SK), bl: new Float32Array(BLt), mat: new Float32Array(MT),
    sphere: J.sph ? h.sphere(P) : null,
    ind: P.length / 3 > 65535 ? new Uint32Array(I) : new Uint16Array(I),
  };
  return { T, F };
}

BF.realMesh = { prepare, finish };
})();
