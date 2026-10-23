// Sim-scaling prototype: a literal villager economy on a voxel world, split into regions that any number of worker threads own.
// Not game code. It exists to measure how a Blockfield-style simulation scales across cores, and to prove that a two-phase tick
// (read-only "think" phase, then owner-only "apply" phase) gives the same result for any worker count.
//
// Rules kept from the game: nothing comes from nothing. A villager only holds a block it mined or bought; a block only appears
// when a villager places an item it holds; coins only move between villagers and village chests. Crops and trees grow by block ticks.
"use strict";

const AIR = 0, STONE = 1, DIRT = 2, GRASS = 3, LOG = 4, COBBLE = 5, SAPLING = 6, CROP0 = 10, CROP7 = 17;
const I_COBBLE = 0, I_DIRT = 1, I_LOG = 2, I_WHEAT = 3, I_SAPLING = 4, NI = 5;
const MINER = 0, WOODCUTTER = 1, FARMER = 2, BUILDER = 3;
const M_IDLE = 0, M_WALK = 1, M_WORK = 2, M_WAIT = 3, M_REST = 4;
const A_NONE = 0, A_MINE = 1, A_PLACE = 2, A_SELL = 3, A_BUY = 4, A_HARVEST = 5, A_WAGE = 6;
const PMAX = 48;            // path cells kept per villager
const CELL = 16, CAP = 96;  // separation grid: 16-block cells, at most CAP villagers listed per cell
const DT = 0.05, SPEED = 4;
const IREC = 8;             // ints per intent record: type, region, agent, x, y, z, item, qty

const solid = b => b >= STONE && b <= COBBLE;

function hash2(a, b, s) {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
function vnoise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi, s) / 4294967296, b = hash2(xi + 1, zi, s) / 4294967296, c = hash2(xi, zi + 1, s) / 4294967296, d = hash2(xi + 1, zi + 1, s) / 4294967296;
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Shared-memory layout: every array lives in a SharedArrayBuffer so any worker can read anything; each value has exactly one writer
// per phase (see tickA / tickB).
function layout(P) {
  const N = P.agents, V = P.villages, W = P.workers, R = P.RN * P.RN, cells = (P.size / CELL) ** 2;
  return {
    blocks: ["Uint16Array", P.size * P.size * P.H],
    hm: ["Uint8Array", P.size * P.size],                 // first air above the column's top non-air block
    posX: ["Float64Array", 2 * N], posZ: ["Float64Array", 2 * N], posY: ["Int32Array", 2 * N],   // [parity * N + i]
    job: ["Int32Array", N], vil: ["Int32Array", N], mode: ["Int32Array", N], act: ["Int32Array", N], actItem: ["Int32Array", N],
    tx: ["Int32Array", N], ty: ["Int32Array", N], tz: ["Int32Array", N], timer: ["Float64Array", N], hunger: ["Float64Array", N],
    coins: ["Int32Array", N], inv: ["Int32Array", N * NI], rng: ["Uint32Array", N], pathLen: ["Int32Array", N], pathIdx: ["Int32Array", N],
    path: ["Int32Array", N * PMAX * 2], site: ["Int32Array", N * 4], lastChop: ["Int32Array", N * 2], phase: ["Int32Array", N],
    resDone: ["Int32Array", N], resOk: ["Int32Array", N], resItem: ["Int32Array", N], resQty: ["Int32Array", N], resCoins: ["Int32Array", N],
    resItem2: ["Int32Array", N], resQty2: ["Int32Array", N],
    vilX: ["Int32Array", V], vilZ: ["Int32Array", V], chestInv: ["Int32Array", V * NI], chestCoins: ["Int32Array", V],
    gridN: ["Int32Array", 2 * cells], gridIds: ["Int32Array", 2 * cells * CAP],
    // regions: villager lists (and arrivals), intent inboxes
    rN: ["Int32Array", R], rList: ["Int32Array", R * P.CAPR], rInN: ["Int32Array", R], rIn: ["Int32Array", R * P.CAPR],
    rIntN: ["Int32Array", R], rInt: ["Int32Array", R * P.CAPI * IREC],
    ctrl: ["Int32Array", 16], stats: ["Float64Array", W * 16],
  };
}
function allocate(P) {
  const L = layout(P), sabs = {};
  for (const k in L) { const [T, n] = L[k]; sabs[k] = new SharedArrayBuffer(globalThis[T].BYTES_PER_ELEMENT * n); }
  return sabs;
}
function view(P, sabs) {
  const L = layout(P), S = {};
  for (const k in L) S[k] = new globalThis[L[k][0]](sabs[k]);
  return S;
}

// ---------- world generation: every column is a pure function of (x, z), so regions generate in parallel ----------
function villageOf(P, gx, gz) {   // village in grid square (gx, gz)
  const sp = P.spacing, j = sp / 4;
  return [gx * sp + sp / 2 + (hash2(gx, gz, 7) % j) - j / 2 | 0, gz * sp + sp / 2 + (hash2(gx, gz, 8) % j) - j / 2 | 0];
}
function height(x, z) { return 24 + Math.floor(10 * vnoise(x / 48, z / 48, 1) + 4 * vnoise(x / 16, z / 16, 2)); }
function nearVillage(P, x, z) {
  const gx = Math.floor(x / P.spacing), gz = Math.floor(z / P.spacing);
  const [vx, vz] = villageOf(P, gx, gz);
  return [vx, vz, Math.max(Math.abs(x - vx), Math.abs(z - vz))];
}
function genColumn(P, S, x, z) {
  const H = P.H, base = (x * P.size + z) * H, h = height(x, z);
  const B = S.blocks;
  for (let y = 0; y < H; y++) B[base + y] = y < h - 3 ? STONE : y < h - 1 ? DIRT : y < h ? GRASS : AIR;
  const [vx, vz, d] = nearVillage(P, x, z);
  let top = h;
  if (x - vx >= 4 && x - vx < 10 && z - vz >= -3 && z - vz < 3) { B[base + h] = CROP0 + (hash2(x, z, 3) & 7); top = h + 1; }   // farm plot
  else if (d > 14 && hash2(x, z, 5) % 61 === 0) { for (let y = h; y < h + 4; y++) B[base + y] = LOG; top = h + 4; }   // trees outside the village
  S.hm[x * P.size + z] = top;
}

// ---------- block access ----------
function idx(P, x, y, z) { return (x * P.size + z) * P.H + y; }
function getB(P, S, x, y, z) {
  if (x < 0 || z < 0 || x >= P.size || z >= P.size || y < 0) return STONE;
  if (y >= P.H) return AIR;
  return S.blocks[(x * P.size + z) * P.H + y];
}
// standing level at column (x, z) reachable from height y: climb 1, drop up to 3; -1 if none
function standAt(P, S, x, z, y) {
  for (let dy = 1; dy >= -3; dy--) {
    const ny = y + dy;
    if (solid(getB(P, S, x, ny - 1, z)) && !solid(getB(P, S, x, ny, z)) && !solid(getB(P, S, x, ny + 1, z))) {
      if (dy > 0 && solid(getB(P, S, x, y + 2, z))) return -1;        // no headroom to climb
      if (dy < 0 && solid(getB(P, S, x, y + 1, z))) continue;
      return ny;
    }
  }
  return -1;
}
const regionOf = (P, x, z) => Math.floor(x / P.RS) * P.RN + Math.floor(z / P.RS);
// Workers own strips of region columns (own 0), or region columns dealt out in turn (own 1: the most borders, a stress test of
// cross-worker traffic). Either way regions are the unit of ownership, never threads: the table could be rebalanced, or a region
// handed to another machine, without changing the simulation.
const ownerOfRegion = (P, r) => P.own ? Math.floor(r / P.RN) % P.workers : Math.floor(Math.floor(r / P.RN) * P.workers / P.RN);

// ---------- per-worker context ----------
function makeCtx(P, S, w) {
  return {
    P, S, w, tick: 0, list: [], heapK: new Int32Array(8192), heapF: new Float64Array(8192),
    stats: { astar: 0, nodes: 0, intents: 0, cross: 0, fail: 0, migr: 0, overflow: 0, busyA: 0, busyB: 0, waitT: 0, scans: 0 },
    from: new Map(), gcost: new Map(),
  };
}
function rnd(S, i) {   // xorshift32 per villager: same numbers whichever worker runs it
  let x = S.rng[i]; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; S.rng[i] = x; return x / 4294967296;
}

// ---------- A*: 4-neighbour grid walk on columns (climb 1, drop 3), integer keys, binary heap ----------
function astar(C, i, sx, sy, sz, gx, gz, near, maxNodes) {
  const { P, S } = C, from = C.from, gcost = C.gcost, K = C.heapK, F = C.heapF;
  from.clear(); gcost.clear();
  let hn = 0;
  const push = (k, f) => { let j = hn++; while (j > 0) { const p = (j - 1) >> 1; if (F[p] <= f) break; K[j] = K[p]; F[j] = F[p]; j = p; } K[j] = k; F[j] = f; };
  const pop = () => { const top = K[0], k = K[--hn], f = F[hn]; let j = 0; for (;;) { let c = 2 * j + 1; if (c >= hn) break; if (c + 1 < hn && F[c + 1] < F[c]) c++; if (F[c] >= f) break; K[j] = K[c]; F[j] = F[c]; j = c; } K[j] = k; F[j] = f; return top; };
  const SZ = P.size, key = (x, z, y) => (x * SZ + z) * 64 + y;
  const k0 = key(sx, sz, sy);
  from.set(k0, -1); gcost.set(k0, 0); push(k0, Math.abs(sx - gx) + Math.abs(sz - gz));
  C.stats.astar++;
  for (let n = 0; hn && n < maxNodes; n++) {
    if (hn > 8000) break;
    const k = pop(), y = k & 63, xz = (k - y) / 64, x = Math.floor(xz / SZ), z = xz - x * SZ, g = gcost.get(k);
    C.stats.nodes++;
    const dx0 = Math.abs(x - gx), dz0 = Math.abs(z - gz);
    if (near ? dx0 <= 1 && dz0 <= 1 && (dx0 | dz0) !== 0 : dx0 === 0 && dz0 === 0) {
      let len = 0;
      for (let c = k; c !== k0; c = from.get(c)) len++;
      const L = Math.min(len, PMAX), base = i * PMAX * 2;
      let c = k;
      for (let s = len; s > 0; s--) { if (s <= L) { const cy = c & 63, cxz = (c - cy) / 64, cx = Math.floor(cxz / SZ); S.path[base + (s - 1) * 2] = cx; S.path[base + (s - 1) * 2 + 1] = cxz - cx * SZ; } c = from.get(c); }
      S.pathLen[i] = L; S.pathIdx[i] = 0;
      return true;
    }
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || nz < 0 || nx >= SZ || nz >= SZ) continue;
      const ny = standAt(P, S, nx, nz, y);
      if (ny < 0) continue;
      const nk = key(nx, nz, ny), ng = g + 1 + (ny !== y ? 0.5 : 0), old = gcost.get(nk);
      if (old !== undefined && old <= ng) continue;
      gcost.set(nk, ng); from.set(nk, k);
      push(nk, ng + Math.abs(nx - gx) + Math.abs(nz - gz));
    }
  }
  return false;
}

// ---------- intents: written in phase A to the worker's outbox, resolved in phase B by the region's owner ----------
function intent(C, type, i, x, y, z, item, qty) {
  const { P, S } = C;
  const r = type === A_SELL || type === A_BUY || type === A_WAGE ? regionOf(P, S.vilX[x], S.vilZ[x]) : regionOf(P, x, z);
  const n = Atomics.add(S.rIntN, r, 1), o = (r * P.CAPI + n) * IREC;   // into the target region's inbox (any worker may be adding)
  if (n >= P.CAPI) throw new Error("region intent inbox full");
  S.rInt[o] = type; S.rInt[o + 1] = r; S.rInt[o + 2] = i; S.rInt[o + 3] = x; S.rInt[o + 4] = y; S.rInt[o + 5] = z; S.rInt[o + 6] = item; S.rInt[o + 7] = qty;
  S.mode[i] = M_WAIT; C.stats.intents++;
  if (r !== C.region) C.stats.cross++;
}

// ---------- phase A: each worker thinks for the villagers it owns; reads anything, writes only its villagers and its outbox ----------
function cur(C) { return C.tick & 1; }
function decide(C, i) {
  const { P, S } = C, N = P.agents, c = cur(C), v = S.vil[i];
  const x = Math.floor(S.posX[c * N + i]), z = Math.floor(S.posZ[c * N + i]), y = S.posY[c * N + i];
  const inv = S.inv, ib = i * NI, vx = S.vilX[v], vz = S.vilZ[v];
  S.act[i] = A_NONE;
  // hunger: eat what you carry, else buy bread at the chest
  if (S.hunger[i] > 1) {
    if (inv[ib + I_WHEAT] > 0) { inv[ib + I_WHEAT]--; S.hunger[i] = 0; }
    else if (S.coins[i] >= 4 && S.chestInv[v * NI + I_WHEAT] >= 2) return goChest(C, i, x, y, z, A_BUY, I_WHEAT, 2);
  }
  switch (S.job[i]) {
    case MINER: {
      if (inv[ib + I_COBBLE] >= 16) return goChest(C, i, x, y, z, A_SELL, I_COBBLE, inv[ib + I_COBBLE]);
      if (inv[ib + I_DIRT] >= 8) return goChest(C, i, x, y, z, A_SELL, I_DIRT, inv[ib + I_DIRT]);
      // quarry south of the village: mine the top block of one of the highest columns (keeps the pit walkable)
      let best = -1, bx = 0, bz = 0;
      for (let qx = vx - 10; qx <= vx + 10; qx++) for (let qz = vz + 8; qz <= vz + 22; qz++) {
        if (qx < 0 || qz < 0 || qx >= P.size || qz >= P.size) continue;
        const t = S.hm[qx * P.size + qz] - 1, b = getB(P, S, qx, t, qz);
        if (b !== STONE && b !== DIRT && b !== GRASS) continue;
        const score = t * 64 + (hash2(qx, qz, S.rng[i]) & 63);
        if (score > best) { best = score; bx = qx; bz = qz; }
      }
      C.stats.scans++;
      if (best < 0) return wander(C, i, x, y, z, vx, vz);
      return goNear(C, i, x, y, z, bx, bz, A_MINE, 0, 1.0);
    }
    case WOODCUTTER: {
      if (inv[ib + I_LOG] >= 12) return goChest(C, i, x, y, z, A_SELL, I_LOG, inv[ib + I_LOG]);
      if (inv[ib + I_SAPLING] > 0 && S.lastChop[i * 2] >= 0) {   // replant where the last tree stood
        const lx = S.lastChop[i * 2], lz = S.lastChop[i * 2 + 1], t = S.hm[lx * P.size + lz];
        if (getB(P, S, lx, t - 1, lz) === GRASS || getB(P, S, lx, t - 1, lz) === DIRT) { S.actItem[i] = I_SAPLING; return goNear(C, i, x, y, z, lx, lz, A_PLACE, I_SAPLING, 0.5); }
        S.lastChop[i * 2] = -1;
      }
      let bd = 1e9, bx = -1, bz = 0;
      for (let qx = vx - 22; qx <= vx + 22; qx++) for (let qz = vz - 22; qz <= vz + 22; qz++) {
        if (qx < 0 || qz < 0 || qx >= P.size || qz >= P.size) continue;
        if (getB(P, S, qx, S.hm[qx * P.size + qz] - 1, qz) !== LOG) continue;
        const d = Math.abs(qx - x) + Math.abs(qz - z) + (hash2(qx, qz, S.rng[i]) & 7);
        if (d < bd) { bd = d; bx = qx; bz = qz; }
      }
      C.stats.scans++;
      if (bx < 0) return wander(C, i, x, y, z, vx, vz);
      return goNear(C, i, x, y, z, bx, bz, A_MINE, 0, 1.5);
    }
    case FARMER: {
      if (inv[ib + I_WHEAT] >= 10) return goChest(C, i, x, y, z, A_SELL, I_WHEAT, inv[ib + I_WHEAT] - 2);
      let bd = 1e9, bx = -1, bz = 0;
      for (let qx = vx + 4; qx < vx + 10; qx++) for (let qz = vz - 3; qz < vz + 3; qz++) {
        if (getB(P, S, qx, S.hm[qx * P.size + qz] - 1, qz) !== CROP7) continue;
        const d = Math.abs(qx - x) + Math.abs(qz - z) + (hash2(qx, qz, S.rng[i]) & 3);
        if (d < bd) { bd = d; bx = qx; bz = qz; }
      }
      if (bx < 0) return wander(C, i, x, y, z, vx + 7, vz);
      return goNear(C, i, x, y, z, bx, bz, A_HARVEST, 0, 0.5);
    }
    case BUILDER: {
      const mat = inv[ib + I_COBBLE] > 0 ? I_COBBLE : inv[ib + I_DIRT] > 0 ? I_DIRT : inv[ib + I_LOG] > 0 ? I_LOG : -1;
      if (mat < 0) {
        const ci = v * NI, want = S.chestInv[ci + I_COBBLE] >= 8 ? I_COBBLE : S.chestInv[ci + I_DIRT] >= 8 ? I_DIRT : S.chestInv[ci + I_LOG] >= 8 ? I_LOG : -1;
        if (want < 0 || S.coins[i] < 8) return wander(C, i, x, y, z, vx, vz);
        return goChest(C, i, x, y, z, A_BUY, want, 8);
      }
      // a wall 8 long and 3 high at this builder's current site; a new site when it is done
      const sb = i * 4;
      if (S.site[sb] < 0) newSite(C, i);
      for (let tries = 0; tries < 2; tries++) {
        const sx = S.site[sb], sz = S.site[sb + 1], sy = S.site[sb + 2];
        for (let h = 0; h < 3; h++) for (let k = 0; k < 8; k++) {
          const cx = sx + k;
          if (cx >= P.size || getB(P, S, cx, sy + h, sz) !== AIR) continue;
          if (h > 0 && !solid(getB(P, S, cx, sy + h - 1, sz))) continue;
          S.tx[i] = cx; S.ty[i] = sy + h; S.tz[i] = sz;
          return goNear(C, i, x, y, z, cx, sz, A_PLACE, mat, 0.5, true);
        }
        newSite(C, i);
      }
      return wander(C, i, x, y, z, vx, vz);
    }
  }
}
function newSite(C, i) {
  const { P, S } = C, v = S.vil[i], sb = i * 4, k = ++S.site[sb + 3];
  const sx = Math.min(P.size - 9, Math.max(0, S.vilX[v] - 24 + hash2(i, k, 11) % 40)), sz = Math.min(P.size - 1, Math.max(0, S.vilZ[v] - 24 + hash2(i, k, 12) % 30));
  S.site[sb] = sx; S.site[sb + 1] = sz; S.site[sb + 2] = S.hm[sx * P.size + sz];
}
function rest(C, i, t) { C.S.mode[i] = M_REST; C.S.timer[i] = t; }
function goChest(C, i, x, y, z, act, item, qty) {
  const { S } = C, v = S.vil[i];
  S.act[i] = act; S.actItem[i] = item; S.tx[i] = qty;
  if (Math.abs(x - S.vilX[v]) <= 1 && Math.abs(z - S.vilZ[v]) <= 1) return intent(C, act, i, v, 0, 0, item, qty);
  if (!astar(C, i, x, y, z, S.vilX[v], S.vilZ[v], true, 1500)) { C.stats.fail++; return rest(C, i, 2); }
  S.mode[i] = M_WALK; S.timer[i] = 0;
}
function goNear(C, i, x, y, z, bx, bz, act, item, work, keepT) {
  const { P, S } = C;
  S.act[i] = act; S.actItem[i] = item; S.timer[i] = work;
  if (!keepT) { S.tx[i] = bx; S.tz[i] = bz; S.ty[i] = S.hm[bx * P.size + bz] - (act === A_PLACE ? 0 : 1); }
  if (Math.abs(x - bx) <= 1 && Math.abs(z - bz) <= 1 && (x !== bx || z !== bz)) { S.pathLen[i] = 0; S.pathIdx[i] = 0; S.mode[i] = M_WORK; return; }
  if (!astar(C, i, x, y, z, bx, bz, true, 1500)) { C.stats.fail++; return rest(C, i, 2); }
  S.mode[i] = M_WALK;
}
function wander(C, i, x, y, z, cx, cz) {
  const { P, S } = C;
  const tx = Math.min(P.size - 1, Math.max(0, cx + Math.floor(rnd(S, i) * 13) - 6)), tz = Math.min(P.size - 1, Math.max(0, cz + Math.floor(rnd(S, i) * 13) - 6));
  S.act[i] = A_NONE;
  if (!astar(C, i, x, y, z, tx, tz, false, 400)) return rest(C, i, 1 + rnd(S, i) * 3);
  S.mode[i] = M_WALK;
}
function arrive(C, i) {
  const { S, P } = C, c = cur(C), N = P.agents, x = Math.floor(S.posX[c * N + i]), z = Math.floor(S.posZ[c * N + i]);
  const a = S.act[i];
  if (a === A_NONE) return rest(C, i, 0.5 + rnd(S, i) * 2);
  if (a === A_SELL || a === A_BUY) return intent(C, a, i, S.vil[i], 0, 0, S.actItem[i], S.tx[i]);
  if (Math.abs(x - S.tx[i]) > 1 || Math.abs(z - S.tz[i]) > 1) { S.mode[i] = M_IDLE; return; }   // path was cut short: think again
  S.mode[i] = M_WORK;
}
function applyResult(C, i) {
  const { S } = C, ib = i * NI;
  S.resDone[i] = 0;
  if (!S.resOk[i]) return rest(C, i, 2 + rnd(S, i) * 2);   // refused (someone got there first, the chest is short): wait, then think again
  {
    if (S.resQty[i]) S.inv[ib + S.resItem[i]] += S.resQty[i];
    if (S.resQty2[i]) S.inv[ib + S.resItem2[i]] += S.resQty2[i];
    S.coins[i] += S.resCoins[i];
    if (S.act[i] === A_PLACE && S.job[i] === BUILDER) { S.act[i] = A_WAGE; return intent(C, A_WAGE, i, S.vil[i], 0, 0, 0, 2); }   // paid by the village chest
    if (S.act[i] === A_MINE && S.job[i] === WOODCUTTER) {
      if (S.resItem2[i] === I_SAPLING && S.resQty2[i]) { S.lastChop[i * 2] = S.tx[i]; S.lastChop[i * 2 + 1] = S.tz[i]; }
      else if (S.resItem[i] === I_LOG) { S.ty[i]--; S.timer[i] = 1.5; S.mode[i] = M_WORK; return; }   // keep chopping down the trunk
    }
    if (S.act[i] === A_PLACE && S.actItem[i] === I_SAPLING) S.lastChop[i * 2] = -1;
  }
  S.mode[i] = M_IDLE;
}
function sepPush(C, i, c) {   // push away from villagers within 0.6 blocks, summed in fixed point so the order of the cell list doesn't matter
  const { P, S } = C, N = P.agents, px = S.posX[c * N + i], pz = S.posZ[c * N + i];
  const gs = P.size / CELL, gx = Math.floor(px / CELL), gz = Math.floor(pz / CELL), cell = gx * gs + gz;
  const n = Math.min(S.gridN[c * gs * gs + cell], CAP), base = (c * gs * gs + cell) * CAP;
  let fx = 0, fz = 0;
  for (let k = 0; k < n; k++) {
    const j = S.gridIds[base + k];
    if (j === i) continue;
    const dx = px - S.posX[c * N + j], dz = pz - S.posZ[c * N + j], d2 = dx * dx + dz * dz;
    if (d2 > 0.36 || d2 < 1e-9) continue;
    const d = Math.sqrt(d2), f = (0.6 - d) / d;
    fx += Math.round(dx * f * 256); fz += Math.round(dz * f * 256);
  }
  return [fx / 256 * 0.1, fz / 256 * 0.1];
}
function updateAgent(C, i, dt) {
  const { P, S } = C, N = P.agents, c = cur(C), n = 1 - c;
  if (S.resDone[i]) applyResult(C, i);
  let px = S.posX[c * N + i], pz = S.posZ[c * N + i], py = S.posY[c * N + i];
  S.hunger[i] += dt / 300;
  const m = S.mode[i];
  if (m === M_IDLE) decide(C, i);
  else if (m === M_REST) { S.timer[i] -= dt; if (S.timer[i] <= 0) S.mode[i] = M_IDLE; }
  else if (m === M_WORK) {
    S.timer[i] -= dt;
    if (S.timer[i] <= 0) {
      const a = S.act[i];
      if (a === A_PLACE) intent(C, A_PLACE, i, S.tx[i], S.ty[i], S.tz[i], S.actItem[i], 1);
      else intent(C, a, i, S.tx[i], S.ty[i], S.tz[i], 0, 1);
    }
  } else if (m === M_WALK) {
    let rem = SPEED * dt;
    const pb = i * PMAX * 2;
    while (rem > 0 && S.pathIdx[i] < S.pathLen[i]) {
      const k = S.pathIdx[i], cx = S.path[pb + k * 2], cz = S.path[pb + k * 2 + 1];
      const dx = cx + 0.5 - px, dz = cz + 0.5 - pz, d = Math.sqrt(dx * dx + dz * dz);
      if (d <= rem) {
        const ny = standAt(P, S, cx, cz, py);
        if (ny < 0) { S.mode[i] = M_IDLE; break; }   // the ground changed under the path: think again
        px = cx + 0.5; pz = cz + 0.5; py = ny; rem -= d; S.pathIdx[i]++;
      } else { px += dx / d * rem; pz += dz / d * rem; rem = 0; }
    }
    if (S.mode[i] === M_WALK && S.pathIdx[i] >= S.pathLen[i]) arrive(C, i);
    const [fx, fz] = sepPush(C, i, c);
    const qx = px + fx, qz = pz + fz;   // nudged only within the same cell, so a push never moves anyone into a wall
    if (Math.floor(qx) === Math.floor(px) && Math.floor(qz) === Math.floor(pz)) { px = qx; pz = qz; }
  }
  S.posX[n * N + i] = px; S.posZ[n * N + i] = pz; S.posY[n * N + i] = py;
}

// ---------- phase B: owners apply intents to their regions, grow plants, and file their villagers into the grid ----------
function resolve(C, o) {
  const { P, S } = C, O = S.rInt;
  const type = O[o], i = O[o + 2], x = O[o + 3], y = O[o + 4], z = O[o + 5], item = O[o + 6], qty = O[o + 7];
  S.resOk[i] = 0; S.resQty[i] = 0; S.resQty2[i] = 0; S.resCoins[i] = 0; S.resItem[i] = 0; S.resItem2[i] = 0; S.resDone[i] = 1;
  const PRICE = [1, 1, 1, 2, 1];
  switch (type) {
    case A_MINE: case A_HARVEST: {
      const b = getB(P, S, x, y, z);
      if (type === A_HARVEST) { if (b !== CROP7) break; setB(C, x, y, z, CROP0); S.resItem[i] = I_WHEAT; S.resQty[i] = 2; S.resOk[i] = 1; break; }
      if (!solid(b) || y !== S.hm[x * P.size + z] - 1) break;   // only the top block of a column
      setB(C, x, y, z, AIR);
      S.resItem[i] = b === STONE || b === COBBLE ? I_COBBLE : b === LOG ? I_LOG : I_DIRT; S.resQty[i] = 1; S.resOk[i] = 1;
      if (b === LOG && getB(P, S, x, y - 1, z) !== LOG) { S.resItem2[i] = I_SAPLING; S.resQty2[i] = 1; }
      break;
    }
    case A_PLACE: {
      if (getB(P, S, x, y, z) !== AIR || S.inv[i * NI + item] < 1) break;
      if (item === I_SAPLING && getB(P, S, x, y - 1, z) !== GRASS && getB(P, S, x, y - 1, z) !== DIRT) break;
      setB(C, x, y, z, item === I_COBBLE ? COBBLE : item === I_DIRT ? DIRT : item === I_LOG ? LOG : SAPLING);
      S.resItem[i] = item; S.resQty[i] = -1; S.resOk[i] = 1;
      break;
    }
    case A_SELL: {   // x = village
      const pay = qty * PRICE[item];
      if (S.inv[i * NI + item] < qty || S.chestCoins[x] < pay) break;
      S.chestCoins[x] -= pay; S.chestInv[x * NI + item] += qty;
      S.resItem[i] = item; S.resQty[i] = -qty; S.resCoins[i] = pay; S.resOk[i] = 1;
      break;
    }
    case A_BUY: {
      const cost = qty * PRICE[item];
      if (S.chestInv[x * NI + item] < qty || S.coins[i] < cost) break;
      S.chestInv[x * NI + item] -= qty; S.chestCoins[x] += cost;
      S.resItem[i] = item; S.resQty[i] = qty; S.resCoins[i] = -cost; S.resOk[i] = 1;
      break;
    }
    case A_WAGE: {
      if (S.chestCoins[x] < qty) break;
      S.chestCoins[x] -= qty; S.resCoins[i] = qty; S.resOk[i] = 1;
      break;
    }
  }
  if (!S.resOk[i]) C.stats.fail++;
}
function setB(C, x, y, z, b) {
  const { P, S } = C;
  S.blocks[idx(P, x, y, z)] = b;
  const hi = x * P.size + z;
  if (b !== AIR && y + 1 > S.hm[hi]) S.hm[hi] = y + 1;
  else if (b === AIR && y + 1 === S.hm[hi]) { let t = y; while (t > 0 && S.blocks[idx(P, x, t - 1, z)] === AIR) t--; S.hm[hi] = t; }
}
function blockTicks(C, r) {   // random ticks: crops ripen, saplings grow into trees
  const { P, S } = C, rx = Math.floor(r / P.RN) * P.RS, rz = (r % P.RN) * P.RS, n = (P.RS * P.RS) >> 8;
  for (let k = 0; k < n; k++) {
    const h = hash2(r, C.tick, k), x = rx + (h & (P.RS - 1)), z = rz + ((h >>> 8) & (P.RS - 1)), t = S.hm[x * P.size + z] - 1, b = getB(P, S, x, t, z);
    if (b >= CROP0 && b < CROP7) setB(C, x, t, z, b + 1);
    else if (b === SAPLING && ((h >>> 16) & 7) === 0) for (let y = t; y < t + 4 && y < P.H; y++) if (y === t || getB(P, S, x, y, z) === AIR) setB(C, x, y, z, LOG);
  }
}

module.exports = {
  AIR, STONE, DIRT, GRASS, LOG, COBBLE, SAPLING, CROP0, CROP7, NI, I_COBBLE, I_DIRT, I_LOG, I_WHEAT, I_SAPLING, IREC, CELL, CAP, DT, PMAX,
  MINER, WOODCUTTER, FARMER, BUILDER, M_IDLE, hash2, height, villageOf, layout, allocate, view, genColumn, regionOf, ownerOfRegion,
  makeCtx, updateAgent, resolve, blockTicks, newSite, idx,
};
