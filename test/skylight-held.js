// @ci integration suite=world timeout=900
// Sky light of chunks held for a cluster meeting (r15-95, js/skylight.js prepare): a held chunk's own light is worked out while it is
// held, and installing it only seeds what crosses its borders. That must come out the same as working a chunk out all at once when it
// loads, in any order (the light keeps the brightest level each cell can get). Plain node, no browser: node test/skylight-held.js [seed=3]
//  - round the spawn's village (trees, houses, caves, water), a 9 x 9 block of chunks loads in a shuffled order, every other chunk held
//    first (built and prepared) and installed later, the rest loaded at once;
//  - then every loaded chunk's sky light is thrown away and worked out again the plain way (BF.skyLight.recomputeAll): every level of
//    every chunk must be the same;
//  - the same with every chunk of the block held.
const { load } = require('../tools/headless.js');
for (const k of ['log', 'info', 'debug', 'warn']) console[k] = () => {};
const { BF } = load();
const out = s => process.stdout.write(s + '\n');
const seed = +(process.argv[2] || 3);
let fails = 0;
const check = (ok, what) => { out((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

BF.boot.headless({ seed });
const W = BF.world, S = BF.skyLight;
const v = BF.worldgen.villagesNear(BF.player.position.x, BF.player.position.z, 3000)[0];
const at = v ? { x: v.x, z: v.z } : { x: BF.player.position.x, z: BF.player.position.z };
let rnd = seed * 7919 + 13;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
const levels = () => {
  const m = new Map();
  for (const c of W.chunks.values()) m.set(c.key, c.sky.map(s => (typeof s === 'number' ? s : Array.from(s).join(','))).join('|'));
  return m;
};
function run(name, off, heldShare) {
  const cx0 = Math.floor(at.x / 16) + off, cz0 = Math.floor(at.z / 16);
  const cells = [];
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) cells.push([cx0 + dx, cz0 + dz]);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const held = [];
  let n = 0;
  for (const [cx, cz] of cells) {
    if (W.chunks.has(cx + ',' + cz)) continue;
    if (rand() < heldShare) { W.replay.hold(cx, cz); held.push([cx, cz]); }
    else W.loadAt(cx * 16 + 8, cz * 16 + 8);
    n++;
    if (held.length && rand() < 0.3) { const [hx, hz] = held.shift(); W.replay.create(hx, hz); }   // (installed later, others meanwhile)
  }
  for (const [hx, hz] of held) W.replay.create(hx, hz);
  W.replay.heldDone();
  const a = levels();
  S.recomputeAll();
  const b = levels();
  let differ = 0, eg = null;
  for (const [k, s] of a) if (b.get(k) !== s) { differ++; eg = eg || k; }
  check(n > 40 && differ === 0, name + ': ' + n + ' chunks loaded, ' + a.size + ' in the world; sky light the same as worked out the plain way in every one' + (differ ? ' (differs in ' + differ + ', e.g. chunk ' + eg + ')' : ''));
}
run('half held', 0, 0.5);
run('all held', 12, 1);
// a held chunk edited while held is built again at installing (js/world.js heldFresh), and lit the plain way
{
  const cx = Math.floor(at.x / 16) - 14, cz = Math.floor(at.z / 16);
  W.replay.hold(cx, cz);
  const key = cx + ',' + cz;
  if (!W.edits.has(key)) W.edits.set(key, new Map());
  W.edits.get(key).set((70 - BF.MIN_Y) << 8, BF.B.stone);
  const c = W.replay.create(cx, cz);
  check(c && c.secs && W.chunks.get(key) === c, 'a chunk edited while held is installed');
  const a = levels(); S.recomputeAll(); const b = levels();
  check(a.get(key) === b.get(key), 'and its sky light is the same as worked out the plain way');
}
out(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
