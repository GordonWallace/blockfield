// Runner for the sim-scaling prototype (kernel.js). Usage:
//   node sim.js [workers=4] [size=1024] [spacing=64] [perVillage=16] [ticks=2000] [far=0] [seed=1] [own=0 strips | 1 interleaved] [sched=1 dynamic | 0 static] [regionSize=64]
// size: world width in blocks (square, 64 high); spacing: blocks between villages; far > 0: villagers more than `far` blocks from
// the world centre think every 4th tick (a coarse level of detail, like the game's FAR_HZ for wild mobs).
// Prints timing, per-worker load, conservation checks and a state hash that must be the same for every worker count.
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const K = require("./kernel.js");

if (isMainThread) main(); else worker();

function params(argv) {
  const [W = 4, size = 1024, spacing = 64, per = 16, ticks = 2000, far = 0, seed = 1, own = 0, sched = 1, RS = 64] = argv.map(Number);
  const RN = size / RS, villages = (size / spacing) ** 2;
  return { workers: W, size, H: 64, spacing, per, ticks, far, seed, own, sched, CAPR: 2048, CAPI: 1024, RS, RN, villages, agents: villages * per, nVX: size / spacing };
}

function main() {
  const P = params(process.argv.slice(2));
  const sabs = K.allocate(P), S = K.view(P, sabs);
  initAgents(P, S);
  const ws = [], msgs = [];
  let phase = 0;
  const t0 = Date.now();
  for (let w = 0; w < P.workers; w++) {
    const wk = new Worker(__filename, { workerData: { P, sabs, w } });
    wk.on("message", m => { msgs.push(m); if (msgs.length === P.workers) next(); });
    wk.on("error", e => { console.error(e); process.exit(1); });
    ws.push(wk);
  }
  let before;
  function next() {
    const got = msgs.splice(0);
    if (phase === 0) {   // world generated
      before = census(P, S);
      console.log(`gen ${Date.now() - t0} ms  world ${P.size}x${P.size}x${P.H}, ${P.villages} villages, ${P.agents} villagers, ${P.RN * P.RN} regions of ${P.RS}, ${P.workers} workers`);
      phase = 1; for (const wk of ws) wk.postMessage("go");
      return;
    }
    got.sort((a, b) => a.w - b.w);
    const after = census(P, S), wall = got[0].wall;
    const sum = k => got.reduce((s, g) => s + g.stats[k], 0);
    const busy = got.map(g => g.stats.busyA + g.stats.busyB);
    const res = {
      workers: P.workers, own: P.own, sched: P.sched, RS: P.RS, agents: P.agents, ticks: P.ticks, far: P.far,
      ms_per_tick: +(wall / P.ticks).toFixed(3), us_per_agent_tick: +(wall * 1000 / P.ticks / P.agents).toFixed(3),
      speed_x: +((P.ticks * K.DT) / (wall / 1000)).toFixed(1),
      busy_ms_per_tick: busy.map(b => +(b / P.ticks).toFixed(3)), wait_after_A_ms: got.map(g => +(g.stats.waitA / P.ticks).toFixed(3)), wait_after_B_ms: got.map(g => +(g.stats.waitB / P.ticks).toFixed(3)),
      phaseB_share: +(sum("busyB") / (sum("busyA") + sum("busyB"))).toFixed(3),
      astar: sum("astar"), astar_nodes: sum("nodes"), intents: sum("intents"), cross_region_intents: sum("cross"), refused: sum("fail"),
      migrations: sum("migr"), grid_overflow: sum("overflow"), scans: sum("scans"),
      conserved: { stone_cobble: [before.cob, after.cob], dirt: [before.dirt, after.dirt], coins: [before.coins, after.coins] },
      grew: { logs: [before.log, after.log], wheat_items: [before.wheat, after.wheat] },
      placed_cobble_blocks: after.cobbleBlocks, hash: stateHash(P, S),
    };
    console.log(JSON.stringify(res));
    for (const wk of ws) wk.terminate();
  }
}

function initAgents(P, S) {
  const N = P.agents;
  let i = 0;
  for (let gx = 0; gx < P.nVX; gx++) for (let gz = 0; gz < P.nVX; gz++) {
    const v = gx * P.nVX + gz, [vx, vz] = K.villageOf(P, gx, gz);
    S.vilX[v] = vx; S.vilZ[v] = vz; S.chestCoins[v] = 5000; S.chestInv[v * K.NI + K.I_WHEAT] = 32; S.chestInv[v * K.NI + K.I_COBBLE] = 16;
    for (let k = 0; k < P.per; k++, i++) {
      const x = vx - 3 + (K.hash2(i, 1, P.seed) % 7), z = vz - 3 + (K.hash2(i, 2, P.seed) % 7);
      S.posX[i] = x + 0.5; S.posZ[i] = z + 0.5; S.posY[i] = K.height(x, z);
      S.job[i] = k % 4; S.vil[i] = v; S.mode[i] = K.M_IDLE; S.coins[i] = 50; S.rng[i] = K.hash2(i, 99, P.seed) | 1;
      S.hunger[i] = (K.hash2(i, 3, P.seed) % 1000) / 1000; S.site[i * 4] = -1; S.lastChop[i * 2] = -1;
    }
  }
  if (i !== N) throw new Error("agent count");
}

// Conservation: stone + cobble (blocks and items) never changes; neither do dirt (blocks and items) or coins.
function census(P, S) {
  const c = { cob: 0, dirt: 0, coins: 0, log: 0, wheat: 0, cobbleBlocks: 0 };
  const B = S.blocks;
  for (let k = 0; k < B.length; k++) {
    const b = B[k];
    if (b === K.STONE) c.cob++; else if (b === K.COBBLE) { c.cob++; c.cobbleBlocks++; } else if (b === K.DIRT || b === K.GRASS) c.dirt++; else if (b === K.LOG) c.log++;
  }
  const addInv = (inv, n) => { for (let i = 0; i < n; i++) { c.cob += inv[i * K.NI + K.I_COBBLE]; c.dirt += inv[i * K.NI + K.I_DIRT]; c.log += inv[i * K.NI + K.I_LOG]; c.wheat += inv[i * K.NI + K.I_WHEAT]; } };
  addInv(S.inv, P.agents); addInv(S.chestInv, P.villages);
  for (let i = 0; i < P.agents; i++) c.coins += S.coins[i];
  // results resolved in the last phase B but not yet collected by their villagers are in flight: count them
  const IT = { [K.I_COBBLE]: "cob", [K.I_DIRT]: "dirt", [K.I_LOG]: "log", [K.I_WHEAT]: "wheat" };
  for (let i = 0; i < P.agents; i++) if (S.resDone[i] && S.resOk[i]) {
    c.coins += S.resCoins[i];
    if (S.resQty[i] && IT[S.resItem[i]]) c[IT[S.resItem[i]]] += S.resQty[i];
  }
  for (let v = 0; v < P.villages; v++) c.coins += S.chestCoins[v];
  return c;
}
function stateHash(P, S) {
  let h = 0x811c9dc5 | 0;
  const mix = a => { for (let k = 0; k < a.length; k++) h = Math.imul(h ^ a[k], 0x01000193); };
  mix(S.blocks); mix(S.hm); mix(S.inv); mix(S.coins); mix(S.chestInv); mix(S.chestCoins); mix(S.mode); mix(new Int32Array(S.posX.buffer)); mix(new Int32Array(S.posZ.buffer)); mix(S.posY);
  return (h >>> 0).toString(16);
}

// ---------- worker ----------
// Every tick has two phases with a barrier after each. Work is handed out by region: with sched 0 each worker takes the regions
// ownerOfRegion gives it; with sched 1 workers take the next unclaimed region from a shared counter (dynamic load balancing).
// Neither choice changes the result: phase A only reads frozen state, and phase B only writes inside the region being processed.
function worker() {
  const { P, sabs, w } = workerData, S = K.view(P, sabs), C = K.makeCtx(P, S, w), N = P.agents, W = P.workers, ctrl = S.ctrl;
  const st = C.stats, R = P.RN * P.RN, gs = P.size / K.CELL;
  st.waitA = 0; st.waitB = 0; st.regionsA = 0;
  const mine = [];
  for (let r = 0; r < R; r++) if (K.ownerOfRegion(P, r) === w) mine.push(r);
  function barrier(key) {   // spin briefly, then sleep on the generation counter
    const t = performance.now(), g = Atomics.load(ctrl, 1);
    if (Atomics.add(ctrl, 0, 1) === W - 1) { Atomics.store(ctrl, 0, 0); Atomics.add(ctrl, 1, 1); Atomics.notify(ctrl, 1); }
    else { let s = 0; while (Atomics.load(ctrl, 1) === g) { if (++s > 20000) Atomics.wait(ctrl, 1, g, 20); } }
    const d = performance.now() - t; st.waitT += d; if (key) st[key] += d;
  }
  // regions for this phase: a fixed share, or claimed one at a time from ctrl[slot]
  function eachRegion(slot, fn) {
    if (!P.sched) { for (const r of mine) fn(r); return; }
    for (;;) { const r = Atomics.add(ctrl, slot, 1); if (r >= R) return; fn(r); }
  }
  const regionXZ = r => [Math.floor(r / P.RN) * P.RS, (r % P.RN) * P.RS];
  // world generation and the first villager lists (static share, so nothing races)
  for (const r of mine) { const [rx, rz] = regionXZ(r); for (let x = rx; x < rx + P.RS; x++) for (let z = rz; z < rz + P.RS; z++) K.genColumn(P, S, x, z); }
  const regionAt = (x, z) => K.regionOf(P, Math.floor(x), Math.floor(z));
  const file = (i, par) => {
    const cell = Math.floor(S.posX[par * N + i] / K.CELL) * gs + Math.floor(S.posZ[par * N + i] / K.CELL);
    const k = Atomics.add(S.gridN, par * gs * gs + cell, 1);
    if (k < K.CAP) S.gridIds[(par * gs * gs + cell) * K.CAP + k] = i; else st.overflow++;
  };
  if (w === 0) for (let i = 0; i < N; i++) { const r = regionAt(S.posX[i], S.posZ[i]); S.rList[r * P.CAPR + S.rN[r]++] = i; file(i, 0); }
  parentPort.postMessage({ w, gen: true });
  parentPort.once("message", () => {
    barrier();
    const T0 = performance.now(), far2 = P.far * P.far, mid = P.size / 2, picked = [];
    for (let t = 0; t < P.ticks; t++) {
      C.tick = t;
      const c = t & 1, n = 1 - c;
      // ---- phase A: think ----
      let a0 = performance.now();
      if (w === 0) Atomics.store(ctrl, 5, 0);   // phase B's counter (nobody is in phase B now)
      eachRegion(4, r => {
        C.region = r; st.regionsA++;
        const L = r * P.CAPR;
        for (let k = 0, m = S.rInN[r]; k < m; k++) S.rList[L + S.rN[r]++] = S.rIn[L + k];   // arrivals
        S.rInN[r] = 0;
        const [rx, rz] = regionXZ(r);
        for (let x = rx; x < rx + P.RS; x += K.CELL) for (let z = rz; z < rz + P.RS; z += K.CELL) S.gridN[n * gs * gs + (x / K.CELL) * gs + z / K.CELL] = 0;
        for (let k = 0, m = S.rN[r]; k < m; k++) {
          const i = S.rList[L + k];
          if (far2) {
            const dx = S.posX[c * N + i] - mid, dz = S.posZ[c * N + i] - mid;
            if (dx * dx + dz * dz > far2) {
              if ((t + i) & 3) { S.posX[n * N + i] = S.posX[c * N + i]; S.posZ[n * N + i] = S.posZ[c * N + i]; S.posY[n * N + i] = S.posY[c * N + i]; continue; }
              K.updateAgent(C, i, K.DT * 4); continue;
            }
          }
          K.updateAgent(C, i, K.DT);
        }
      });
      st.busyA += performance.now() - a0;
      barrier("waitA");
      // ---- phase B: apply, region by region ----
      a0 = performance.now();
      if (w === 0) Atomics.store(ctrl, 4, 0);
      eachRegion(5, r => {
        C.region = r;
        const m = S.rIntN[r];
        if (m) {
          picked.length = 0;
          for (let k = 0; k < m; k++) picked.push((r * P.CAPI + k) * K.IREC);
          picked.sort((p, q) => S.rInt[p + 2] - S.rInt[q + 2]);   // by villager id: the same order whoever resolves them
          for (const o of picked) K.resolve(C, o);
          S.rIntN[r] = 0;
        }
        K.blockTicks(C, r);
        const L = r * P.CAPR;
        let keep = 0;
        for (let k = 0, m2 = S.rN[r]; k < m2; k++) {
          const i = S.rList[L + k];
          file(i, n);
          const r2 = regionAt(S.posX[n * N + i], S.posZ[n * N + i]);
          if (r2 === r) S.rList[L + keep++] = i;
          else { const q = Atomics.add(S.rInN, r2, 1); S.rIn[r2 * P.CAPR + q] = i; st.migr++; }
        }
        S.rN[r] = keep;
      });
      st.busyB += performance.now() - a0;
      barrier("waitB");
    }
    const wall = performance.now() - T0;
    parentPort.postMessage({ w, wall, stats: st });
  });
}
