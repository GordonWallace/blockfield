// @ci integration suite=world,village timeout=900
// A world played after another is the same world a fresh copy of it plays (js/rplay.js): the leader, which played the title world or an
// earlier world before this one, against a follower, which boots fresh for each world and replays the leader's journal.
// Plain node, no browser, no threads, nothing timed: the leader and its follower are two copies of the simulation in one process
// (tools/headless.js load({ isolated: true })), joined by js/rplay.js itself (setup's spawn hands the follower's handler the leader's
// messages at once), so after every frame the follower has run the leader's ticks and the two can be compared directly:
//   - the leader plays another world for a while (seed OTHER), then makes the world under test: its follower boots it (rplay begin);
//   - frames of ticks as js/simworker.js runs them (chunks, the frame's steps, ticks, the journal out): every tick's end the copies'
//     grass samples are compared (BF.grass.stats: how many columns its random ticks looked at, and a sum of which), every CHECK ticks
//     their state hashes part by part, and the leader's own check of its follower (?verify=, js/rplay.js soloCheck) must find nothing;
//   - then the world is saved and loaded from inside itself, as test/workers-load.js does (a new follower boots the save), and the same.
// Whatever a module keeps outside the world and doesn't start over with a new one shows here on any machine, the same every run.
// Before the fix js/grass.js kept its clock reading, its carry and its list of chunks from world to world. Its samples a tick came
// from differences of the simulation clock (a float sum of 0.05 s ticks: 6 +- 1e-10 samples), so with another carry the leader looked
// at 5 or 7 columns on ticks its follower looked at 6: other columns, and now and then a dirt block turned to grass on one copy only
// (CI, test/workers-load.js, 2026-11-12: "worker 1's copy differs from the leader's in edits at tick 4700", one grass block; passed
// when run again).
// Usage: node test/second-world.js [seed=3] [ticks=1200] [other seed=7] [other ticks=333]
const { load } = require('../tools/headless.js');
const seed = +(process.argv[2] || 3), TICKS = +(process.argv[3] || 1200), OTHER = +(process.argv[4] || 7), OTHER_TICKS = +(process.argv[5] || 333), CHECK = 100;
const EVERY = +process.env.SW_EVERY || CHECK;   // (finding a difference's first tick: SW_EVERY=1 compares the copies after every tick)
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };   // (the builders' lines)
// a copy of the simulation as a world server's thread loads it (server/regionthread.js, play)
const FILES = ['js/coords.js', 'js/commands.js', 'js/threadload.js', 'js/debugfeed.js', 'js/rplay.js'];
const copy = () => load({ isolated: true, files: FILES,
  globals: { navigator: globalThis.navigator, location: { search: '', hostname: 'localhost', protocol: 'node:', href: 'node:test/second-world.js' } } }).BF;

const t0 = Date.now();
const A = copy();
let B = null, said = [];
// the leader's follower: a fresh copy for each world, its messages handed over at once, as copies (a thread's postMessage)
A.rplay.setup({ workers: 2, cores: 2, split: 'never', verify: CHECK, spawn: () => {
  const F = copy();
  let toLeader = () => {};
  const handle = F.rplay.follower(m => { if (m.error) said.push(String(m.error).split('\n').slice(0, 4).join(' | ')); toLeader(structuredClone(m)); });
  B = F;
  return { post: m => handle(structuredClone(m)), on: fn => { toLeader = fn; }, terminate() {} };
} });
const settings = { villages: 10 };

// ---- another world first, on the leader alone
quiet(() => {
  A.boot.headless({ seed: OTHER, settings: Object.assign({ at: 'village' }, settings) }).tick(OTHER_TICKS);
});
console.log(`  another world (seed ${OTHER}) played ${OTHER_TICKS} ticks: the clock reads ${A.simNow().toFixed(2)} s`);

// A frame of the leader's loop (js/simworker.js loopBody), 0.05 real seconds at a time.
function frame() {
  const p = A.player.position, raw = 0.05;
  A.rplay.loopStart();
  A.world.update(p.x, p.z, 1e9);
  if (A.rworkers.journal) A.rworkers.rec(['f', raw]);
  A.inventory.simFrame(raw); A.maps.simFrame(); A.player.simRide(raw);
  const n = A.boot.ticks(raw);
  A.warp.done(n, n * A.warp.TICK, raw);
  A.rplay.frame();
  return n;
}
const firstDiff = (p, q) => { let i = 0; while (i < p.length && p[i] === q[i]) i++; return `from character ${i}: ...${p.slice(Math.max(0, i - 160), i + 160)} / ...${q.slice(Math.max(0, i - 160), i + 160)}`; };
const logged = [];   // the leader's game log (headless no world is open to keep it)
A.glog.setSink(e => logged.push(e));
const errors = () => logged.filter(e => e.l === 'ERROR' && /^(workers|worker \d)/.test(e.k)).map(e => e.x);
// The world in hand, played `ticks` ticks on both copies.
function play(what, ticks) {
  const st = A.rplay.status();
  check(st.followers === 1 && st.ready === 1 && !said.length, `${what}: the follower booted the leader's world${said.length ? ' (' + said[0].slice(0, 300) + ')' : ''}`);
  if (st.ready !== 1) return;
  check(A.simNow() === B.simNow(), `${what}: both copies start at the same clock (${A.simNow().toFixed(2)} s)`);
  let grassAt = -1, grassWhat = '', hashAt = -1, hashWhat = '', stepAt = -1, done = 0;
  const g0 = [A.grass.stats(), B.grass.stats()], e0 = errors().length;
  quiet(() => {
    for (let i = 0; done < ticks && i < ticks * 4; i++) {
      done += frame();
      if (said.length || !A.rplay.status().followers) break;
      if (stepAt < 0 && A.rand.tick !== B.rand.tick) stepAt = done;
      const ga = A.grass.stats(), gb = B.grass.stats();
      if (grassAt < 0 && (ga.looked - g0[0].looked !== gb.looked - g0[1].looked || ((ga.sum - g0[0].sum) | 0) !== ((gb.sum - g0[1].sum) | 0))) {
        grassAt = done; grassWhat = `${ga.looked - g0[0].looked} / ${gb.looked - g0[1].looked} columns looked at so far`;
      }
      if (hashAt < 0 && done % EVERY === 0) {
        const a = A.stateHash.full(), b = B.stateHash.full();
        if (a.hash !== b.hash) {
          const parts = Object.keys(a.parts).filter(k => a.parts[k] !== b.parts[k]);
          hashAt = done; hashWhat = parts.join(', ') + '\n  ' + parts.slice(0, 3).map(k => k + ' ' + firstDiff(A.stateHash.text(k), B.stateHash.text(k))).join('\n  ');
        }
      }
    }
  });
  check(done >= ticks && !said.length, `${what}: ${done} ticks ran${said.length ? ' (the follower stopped: ' + said[0].slice(0, 400) + ')' : ''}`);
  check(stepAt < 0, `${what}: the follower had run the leader's ticks after every frame${stepAt >= 0 ? ` (not after ${stepAt})` : ''}`);
  check(grassAt < 0, `${what}: the grass's random ticks looked at the same columns on both copies${grassAt >= 0 ? ` (they differ from tick ${grassAt}: ${grassWhat})` : ` (${A.grass.stats().looked - g0[0].looked})`}`);
  check(hashAt < 0, `${what}: the copies' state hashes agree every ${EVERY} ticks${hashAt >= 0 ? ` (they differ at tick ${hashAt} in ${hashWhat})` : ''}`);
  const s = A.rplay.status(), errs = errors().slice(e0);
  check(s.followers === 1 && (A.rworkers.checks || 0) > 0 && !A.rworkers.mismatch && !errs.length,
    `${what}: the leader compared its follower's copy ${A.rworkers.checks || 0} times and found no difference${errs.length ? '\n  ' + errs.slice(0, 6).map(e => e.slice(0, 900)).join('\n  ') : ''}`);
}

// ---- the world under test, new: as js/simworker.js worldOp makes it (the player to the nearest village, before the followers start)
quiet(() => {
  A.newWorld(seed, settings);
  A.boot.toVillage();
  A.state.paused = false;
  A.rplay.begin({ op: 'create', seed, opts: settings });
});
play('a new world', TICKS);

// ---- saved and loaded from inside itself
{
  let data = null;
  quiet(() => {
    data = structuredClone(A.save.snapshot());
    A.rworkers.checks = 0;
    A.save.restore(data, null);
    A.rplay.begin({ op: 'load', data, meta: null });
  });
  play('saved and loaded', TICKS);
}

console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
