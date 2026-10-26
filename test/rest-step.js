// @ci baseline suite=world,village,jobs,farming timeout=900
// Resting animals (spec r15-63): a wild sheep, chicken, cow or pig standing idle takes the rest step (js/mobs.js canRest / restStep)
// instead of the full update. It must change exactly what the full update would, so the world comes out the same. Headless, seed 3:
//   - verify: BF.mobs.wakeVerify on for a while: every rest step is checked against the full update (no differences), and animals of
//     each kind do rest;
//   - a resting chicken and a player with seeds stepping up to it, then a resting cow hit by the player: the tick each first moves is the
//     same with the rest step on as with it off (BF.mobs.wake = false: every mob takes the full update), and so is the world hash after.
// Each run is its own Node process (the simulation loads once a process).
// Usage: node test/rest-step.js [seed=3] [seconds=120]
const path = require('path'), cp = require('child_process');
const seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 120);

if (process.argv[4] === '--child') {
  const mode = process.argv[5];
  const { load } = require(path.join(__dirname, '..', 'tools', 'headless.js'));
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village' } });
  const out = { mode };
  const M = BF.mobs;
  if (mode === 'verify') {
    M.wakeVerify = true; M.resetWakeStats();
    h.tick(seconds * 20);
    out.stats = M.wakeStats(); out.diffs = M.wakeDiffs;
  } else {
    M.wake = mode === 'on';
    h.tick(200);   // (settled)
    const P = BF.player.position, near = m => Math.hypot(m.position.x - P.x, m.position.z - P.z);
    const resting = t => M.list.filter(m => m.type === t && !m.dead && !m.removed && M.canRest(m, 0.05)).sort((a, b) => near(a) - near(b))[0];
    const moves = (m, ticks) => {   // the first tick it moves
      const x = m.position.x, z = m.position.z;
      for (let t = 1; t <= ticks; t++) { h.tick(1); if (m.position.x !== x || m.position.z !== z) return t; }
      return null;
    };
    const hen = resting('chicken');
    out.hen = !!hen;
    if (hen) {
      BF.inventory.slots[0] = { id: BF.I.wheat_seeds, count: 10 };
      BF.inventory.select(0);
      const x = Math.floor(hen.position.x + 6), z = Math.floor(hen.position.z);
      BF.player.teleport(x + 0.5, BF.world.heightAt(x, z) + 1.2, z + 0.5);
      out.henMoves = moves(hen, 100);
      BF.inventory.slots[0] = null;
    }
    const cow = resting('cow');
    out.cow = !!cow;
    if (cow) {
      M.hit(cow, 1, { x: 1, z: 0 });
      out.cowMoves = moves(cow, 40);
      out.cowFlees = cow.ai.fleeT > 0;
    }
    h.tick(20 * 20);
    out.hash = h.stateHash().hash;
  }
  console.log('RESULT ' + JSON.stringify(out));
  require('process').exit();
}

let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const run = mode => {
  const r = cp.spawnSync(process.execPath, [__filename, String(seed), String(seconds), '--child', mode], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) { console.log((r.stdout || '').slice(-2000), (r.stderr || '').slice(-2000)); return null; }
  return JSON.parse(line.slice(7));
};

const v = run('verify');
check(!!v, 'verify run finished');
if (v) {
  console.log('updates: ' + JSON.stringify(v.stats));
  const kinds = ['chicken', 'cow', 'pig'];
  check(kinds.every(k => v.stats[k] && v.stats[k].rest > 0), 'animals rest: ' + kinds.map(k => k + ' ' + (v.stats[k] ? v.stats[k].rest + '/' + (v.stats[k].rest + v.stats[k].full) : 0)).join(', '));
  check(v.diffs === 0, `every rest step matches the full update (${v.diffs} differences)`);
}
const on = run('on'), off = run('off');
check(!!on && !!off, 'chicken and cow runs finished');
if (on && off) {
  console.log('rest step on: ' + JSON.stringify(on) + '\nrest step off: ' + JSON.stringify(off));
  check(on.hen && on.henMoves != null, `a resting chicken walks to a player holding seeds (tick ${on.henMoves})`);
  check(on.henMoves === off.henMoves, `on the same tick as with the full update every tick (${on.henMoves} / ${off.henMoves})`);
  check(on.cow && on.cowMoves != null && on.cowFlees, `a resting cow hit by the player moves and flees (tick ${on.cowMoves})`);
  check(on.cowMoves === off.cowMoves, `on the same tick as with the full update (${on.cowMoves} / ${off.cowMoves})`);
  check(on.hash === off.hash, `same world hash afterwards (${on.hash} / ${off.hash})`);
}
console.log(fails ? `FAILED ${fails}` : 'all ok');
process.exit(fails ? 1 : 0);
