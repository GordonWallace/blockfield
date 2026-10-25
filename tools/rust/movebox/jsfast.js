// r15-50 control: the Rust slice's algorithm (src/core.rs) written back in JavaScript, reading the game's own chunk objects.
// Same tables (flat typed arrays), integer chunk keys cached in a Map of numbers, no allocation per call, margin cells and panes left to
// the original. This separates what Rust buys from what the rewrite buys. make(BF) -> { move(pos, vel, hw, h, dt, opts) -> result or
// null (null: the original must do the call), hooks (world.mirror) }.
(function (root) {
"use strict";
function make(BF) {
  const W = BF.world, CS = 16, PN = BF.planet.N, PW = 3 * PN, MIN_Y = BF.MIN_Y, H = BF.H, STONE = BF.B.stone, BEDROCK = BF.B.bedrock;
  const n = Math.max(BF.SOLID.length, BF.RENDER.length, BF.TALLBOX.length, BF.blocks.length);
  const SOLID = BF.SOLID, TALL = BF.TALLBOX, RENDER = BF.RENDER;
  const off = new Uint32Array(n + 1), nul = new Uint8Array(n), dyn = new Uint8Array(n), bx = [];
  for (let id = 0; id < n; id++) {
    off[id] = bx.length / 6;
    if (BF.DYNBOXES[id]) dyn[id] = 1;
    const list = BF.CBOXES[id] || (BF.CBOX[id] ? [BF.CBOX[id]] : null);
    if (!list) nul[id] = 1; else for (const b of list) for (let k = 0; k < 6; k++) bx.push(b[k]);
  }
  off[n] = bx.length / 6;
  const BOX = Float64Array.from(bx);
  // chunks by a numeric key (cx * 2^21 + cz: canonical cx, cz are under 2^20); null = not loaded
  const byNum = new Map();
  let lastK = NaN, lastC = null;
  const ABSENT = { absent: true };
  const STOP = 1;   // thrown: a margin cell or a pane
  function chunk(cx, cz) {
    const k = cx * 2097152 + cz;
    if (k === lastK) return lastC;
    let c = byNum.get(k);
    if (c === undefined) { c = W.chunks.get(cx + "," + cz) || ABSENT; byNum.set(k, c); }
    lastK = k; lastC = c;
    return c;
  }
  const hooks = {
    cell() {}, drop() {},
    added(c) { byNum.delete(c.cx * 2097152 + c.cz); lastK = NaN; },
    removed(c) { byNum.delete(c.cx * 2097152 + c.cz); lastK = NaN; },
  };
  function cblock(c, lx, y, lz) {
    if (y < c.y0) return y < MIN_Y ? BEDROCK : STONE;
    if (y >= c.y1) return 0;
    const s = c.secs[(y >> 4) - c.lo];
    return typeof s === "number" ? s : s[((y & 15) << 8) | (lz << 4) | lx];
  }
  function getI(x, y, z) {
    if (y < MIN_Y) return BEDROCK;
    if (y >= H) return 0;
    const f = Math.floor(x / PW), u = x - PW * f - PN, v = z - PN;
    if (!(f >= 0 && f < 6 && u >= 0 && u < PN && v >= 0 && v < PN)) throw STOP;
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS), c = chunk(cx, cz);
    if (c === ABSENT) return 0;
    return cblock(c, x - cx * CS, y, z - cz * CS);
  }
  let high = false;
  function solidI(x, y, z) {
    if (y < MIN_Y) return true;
    if (y >= H) return false;
    const f = Math.floor(x / PW), u = x - PW * f - PN, v = z - PN;
    if (!(f >= 0 && f < 6 && u >= 0 && u < PN && v >= 0 && v < PN)) throw STOP;
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS), c = chunk(cx, cz);
    if (c === ABSENT) return !high;
    return SOLID[cblock(c, x - cx * CS, y, z - cz * CS)] === 1;
  }
  const getF = (x, y, z) => (y < MIN_Y ? BEDROCK : y >= H ? 0 : getI(Math.floor(x), Math.floor(y), Math.floor(z)));
  let hx0 = 0, hy0 = 0, hz0 = 0, hx1 = 0, hy1 = 0, hz1 = 0, inside = false, firm = false;
  // axis 0 none, 1 x, 2 y, 3 z
  function boxHit(px, py, pz, hw, h, axis, prev) {
    inside = false;
    const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw - 1e-6);
    const y0 = Math.floor(py), y1 = Math.floor(py + h - 1e-6);
    const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw - 1e-6);
    let hit = false;
    for (let y = y0 - 1; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (y < y0 && !TALL[getI(x, y, z)]) continue;
      if (!solidI(x, y, z)) continue;
      const bid = getI(x, y, z);
      if (dyn[bid]) throw STOP;
      const nb = nul[bid] === 1, b0 = off[bid], cnt = nb ? 1 : off[bid + 1] - b0;
      for (let bi = 0; bi < cnt; bi++) {
        let ax = x, ay = y, az = z, bx = x + 1, by = y + 1, bz = z + 1;
        if (!nb) {
          const o6 = (b0 + bi) * 6;
          ax += BOX[o6]; ay += BOX[o6 + 1]; az += BOX[o6 + 2]; bx = x + BOX[o6 + 3]; by = y + BOX[o6 + 4]; bz = z + BOX[o6 + 5];
          if (ax >= px + hw || bx <= px - hw || ay >= py + h || by <= py || az >= pz + hw || bz <= pz - hw) continue;
        }
        if (axis === 1 ? ax < prev + hw && bx > prev - hw : axis === 3 ? az < prev + hw && bz > prev - hw : axis === 2 && ay < prev + h && by > prev) {
          const qx = axis === 1 ? prev : px, qy = axis === 2 ? prev : py, qz = axis === 3 ? prev : pz;
          const ox = Math.min(bx, qx + hw) - Math.max(ax, qx - hw), oy = Math.min(by, qy + h) - Math.max(ay, qy), oz = Math.min(bz, qz + hw) - Math.max(az, qz - hw);
          const o = axis === 1 ? ox : axis === 2 ? oy : oz;
          const mv = (axis === 1 ? px : axis === 2 ? py : pz) - prev;
          const mid = axis === 1 ? (ax + bx) / 2 - prev : axis === 2 ? (ay + by) / 2 - (prev + h / 2) : (az + bz) / 2 - prev;
          if (!firm || o > Math.min(ox, oy, oz) || mv * mid <= 0) continue;
          inside = true;
        }
        if (!hit) { hx0 = ax; hy0 = ay; hz0 = az; hx1 = bx; hy1 = by; hz1 = bz; hit = true; continue; }
        hx0 = Math.min(hx0, ax); hy0 = Math.min(hy0, ay); hz0 = Math.min(hz0, az);
        hx1 = Math.max(hx1, bx); hy1 = Math.max(hy1, by); hz1 = Math.max(hz1, bz);
      }
    }
    return hit;
  }
  let px = 0, py = 0, pz = 0, top = 0, onGround = false, hitCeil = false;
  // moveAxis on (px, py, pz): a 1 x, 2 y, 3 z
  function moveAxis(a, d, hw, h) {
    const n = Math.max(1, Math.ceil(Math.abs(d) / 0.45)), step = d / n;
    for (let i = 0; i < n; i++) {
      const prev = a === 1 ? px : a === 2 ? py : pz;
      if (a === 1) px += step; else if (a === 2) py += step; else pz += step;
      if (boxHit(px, py, pz, hw, h, a, prev)) {
        if (inside) { if (a === 1) px = prev; else if (a === 2) py = prev; else pz = prev; if (a === 2 && step < 0) onGround = true; top = hy1; return true; }
        if (a === 2) { if (step < 0) { py = hy1; onGround = true; } else { py = hy0 - h - 1e-4; hitCeil = true; } }
        else if (a === 1) px = step > 0 ? hx0 - hw - 1e-4 : hx1 + hw + 1e-4;
        else pz = step > 0 ? hz0 - hw - 1e-4 : hz1 + hw + 1e-4;
        top = hy1;
        return true;
      }
    }
    return false;
  }
  function move(pos, vel, hw, h, dt, opts) {
    const stepUp = (opts && opts.stepUp) || 0, swim = !!(opts && opts.swim);
    firm = !!(opts && opts.firm); high = !!W.high;
    px = pos.x; py = pos.y; pz = pos.z; top = 0; onGround = false; hitCeil = false;
    let vx = vel.x, vy = vel.y, vz = vel.z, hitX = false, hitZ = false;
    try {
      if (moveAxis(2, vy * dt, hw, h)) vy = 0;
      const wasGround = onGround || (vy <= 0 && boxHit(px, py - 0.05, pz, hw, 0.05, 0, 0));
      for (let a = 1; a <= 3; a += 2) {
        const d = (a === 1 ? vx : vz) * dt;
        if (!d) continue;
        const sx = px, sy = py, sz = pz;
        if (moveAxis(a, d, hw, h)) {
          if (stepUp && (wasGround || swim)) {
            let lx = sx, lz = sz;
            const ly = top > sy ? top : Math.floor(sy + 1e-3) + 1;
            if (ly - sy <= stepUp && !boxHit(lx, ly, lz, hw, h, 0, 0)) {
              if (a === 1) lx += d; else lz += d;
              if (!boxHit(lx, ly, lz, hw, h, 0, 0)) { px = lx; py = ly; pz = lz; continue; }
            }
          }
          if (a === 1) { vx = 0; hitX = true; } else { vz = 0; hitZ = true; }
        }
      }
      if (!onGround && vy <= 0 && boxHit(px, py - 0.02, pz, hw, 0.02, 0, 0)) onGround = true;
      const inWater = RENDER[getF(px, py + 0.4, pz)] === 3, headInWater = RENDER[getF(px, py + h - 0.15, pz)] === 3;
      pos.x = px; pos.y = py; pos.z = pz; vel.x = vx; vel.y = vy; vel.z = vz;
      return { onGround, hitX, hitZ, hitCeil, inWater, headInWater };
    } catch (e) {
      if (e === STOP) return null;
      throw e;
    }
  }
  return { move, hooks, clear() { byNum.clear(); lastK = NaN; }, count: () => byNum.size };
}
if (typeof module !== "undefined" && module.exports) module.exports = { make };
else root.BFMoveBoxFast = { make };
})(typeof globalThis !== "undefined" ? globalThis : this);
