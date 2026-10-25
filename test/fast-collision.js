// @ci baseline suite=world timeout=900
// Fast collision (r15-50 follow-up, js/world.js fastMove): world.moveBox's fast path must give exactly what moveBoxFull gives.
// Headless (tools/headless.js load), seed 3, at the village nearest the spawn, with BF.debug.collideCompare on (every call runs both and
// compares positions, velocities and flags bit for bit):
//   - shapes: each block with its own collision boxes (slabs, stairs, fences, gates, doors, beds, panes...) is placed in the open, and
//     boxes of mob, player (firm) and drop sizes are thrown at it from all sides at several speeds;
//   - live: 300 game seconds of the village (villagers, animals, monsters, drops) with the comparison on;
//   - the fast path does the great majority of the calls (moveBoxFull only for face-edge margins and panes);
//   - speed: per call, the fast path against moveBoxFull on the same recorded calls (report only).
// Usage: node test/fast-collision.js [seed=3] [seconds=300]
const path = require('path');
const { load } = require(path.join(__dirname, '..', 'tools', 'headless.js'));
const seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 300);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

const { BF } = load();
const t0 = Date.now();
const h = BF.boot.headless({ seed, settings: { at: 'village' } });
console.log(`booted seed ${seed} in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${BF.world.chunks.size} chunks, ${BF.mobs.list.length} mobs`);
const W = BF.world, D = BF.debug;
D.collideCompare = true;

// ---- shapes: every block id with collision boxes of its own, alone in a cleared spot near the player
D.collideStatsReset();
const p = BF.player.position, bx = Math.floor(p.x) + 6, bz = Math.floor(p.z) + 6;
let by = Math.floor(p.y) + 30;
const ids = [];
for (const b of BF.blocks) if (b && b.id && BF.SOLID[b.id] && (BF.CBOXES[b.id] || BF.CBOX[b.id] || BF.DYNBOXES[b.id] || BF.TALLBOX[b.id])) ids.push(b.id);
const clear = () => { for (let y = by - 2; y <= by + 4; y++) for (let z = bz - 3; z <= bz + 3; z++) for (let x = bx - 3; x <= bx + 3; x++) W.setBlock(x, y, z, 0); };
let shots = 0;
const sizes = [[0.3, 1.8, false], [0.3, 1.8, true], [0.45, 0.9, false], [0.125, 0.25, false], [0.7, 2.9, false]];   // villager, player (firm), animal, drop, golem
for (const id of ids) {
  clear();
  W.setBlock(bx, by - 1, bz, BF.B.stone);   // a floor under it
  W.setBlock(bx, by, bz, id);
  if (W.getBlock(bx, by, bz) !== id) continue;
  for (const [hw, hh, firm] of sizes) for (let k = 0; k < 24; k++) {
    const a = k * Math.PI / 12, r = 0.9 + hw, sp = [2, 5, 12][k % 3];
    for (const dy of [-0.3, 0, 0.4, 1.02]) {
      const pos = { x: bx + 0.5 + Math.cos(a) * r, y: by + dy, z: bz + 0.5 + Math.sin(a) * r };
      const vel = { x: -Math.cos(a) * sp, y: dy > 0.5 ? -8 : 0, z: -Math.sin(a) * sp };
      W.moveBox(pos, vel, hw, hh, 0.05, { stepUp: firm ? 0.6 : 1.05, firm, swim: k % 5 === 0 });
      shots++;
    }
  }
}
clear();
let S = D.collideStats;
check(S.diffs === 0, `shapes: ${ids.length} block ids, ${shots} boxes: ${S.fast} by the fast path, ${S.full} by moveBoxFull, ${S.diffs} different` + (S.diffs ? ' ' + JSON.stringify(S.list.slice(0, 3)) : ''));
check(S.fast > shots * 0.8, `shapes: the fast path did ${S.fast} of ${shots}`);

// ---- live
D.collideStatsReset();
const t1 = Date.now();
h.tick(Math.round(seconds / BF.warp.TICK));
S = D.collideStats;
check(S.diffs === 0, `live: ${seconds} game s in ${((Date.now() - t1) / 1000).toFixed(0)} s, ${S.calls} calls: ${S.fast} fast, ${S.full} by moveBoxFull, ${S.diffs} different` + (S.diffs ? ' ' + JSON.stringify(S.list.slice(0, 3)) : ''));
check(S.calls > 1000, `live: enough calls (${S.calls})`);
check(S.fast >= S.calls * 0.95, `live: the fast path did ${(100 * S.fast / Math.max(1, S.calls)).toFixed(2)}% of the calls`);

// ---- speed (report only): the same recorded calls through both
D.collideCompare = false;
const rec = [], orig = W.moveBox;
W.moveBox = (pos, vel, hw, hh, dt, o) => { rec.push([pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, hw, hh, dt, o && { stepUp: o.stepUp, swim: o.swim, firm: o.firm }]); return orig(pos, vel, hw, hh, dt, o); };
h.tick(200);
W.moveBox = orig;
const time = fn => { const a = performance.now(); for (let r = 0; r < 3; r++) for (const c of rec) fn({ x: c[0], y: c[1], z: c[2] }, { x: c[3], y: c[4], z: c[5] }, c[6], c[7], c[8], c[9]); return (performance.now() - a) * 1000 / (3 * rec.length); };
time(W.moveBox); time(W.moveBoxFull);
const fast = time(W.moveBox), full = time(W.moveBoxFull);
console.log(`speed: ${rec.length} recorded calls, fast ${fast.toFixed(2)} µs, moveBoxFull ${full.toFixed(2)} µs per call (${(full / fast).toFixed(1)}x)`);

console.log(fails ? `FAIL fast-collision (${fails})` : 'PASS fast-collision');
process.exit(fails ? 1 : 0);
