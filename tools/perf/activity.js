// Activity and cost (spec r15-60): runs a seed headless (tools/headless.js, no browser) for N game seconds with the villager-seconds meter
// on and prints, as JSON, the three tables of js/perf.js:
//   byState: mob updates and µs per update by class and by the state the mob was in (BF.perf.byState);
//   activity: requests by kind, path searches, trades and items gained and spent, per villager-second (BF.perf.activity);
//   villages: each simulated village's ms per tick and the top fast-forward that allows, busiest first (BF.perf.villageSpeed);
//   life: deaths by mob type and cause, births (young mobs that appeared) by type, and doors villagers walked through, over the run
//   (spec r15-64's bar: villager deaths and golem kills within 5% coarse against full detail; door requests depend on the tick rate,
//   passages don't).
// Later specs that make villagers cheaper (r15-61 to r15-64) quote byState and villages before and after, and must keep activity.
// Usage: node tools/perf/activity.js [--seed 3] [--seconds 600] [--extra n] [--warm s] [--coarse on|off] [--reroll 1] [--out file.json]
//   --extra n: the n nearest other villages are simulated too (the 9-village load is --extra 8; js/active.js fixed set).
//   --warm s: game seconds run before measuring (default 30), so the start (chunks loading, villagers waking) isn't counted.
//   --coarse on|off: far villages coarse or full detail (spec r15-64). --reroll 1: every villager's dice rolled once after the warm-up,
//   the same world with other luck: how far two runs differ by chance alone.
const fs = require('fs'), path = require('path');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if (!m) throw new Error('unknown argument ' + argv[i]);
    a[m[1]] = argv[++i];
  }
  return a;
}

// -> {seed, extra, seconds, ticks, real, vss, msPerTick, speed, villagers, mobs, byState, activity, villages, life, check {updates, requests}, hash}
function measure({ seed = 3, seconds = 600, extra = 0, warm = 30, coarse, reroll } = {}) {
  const { load } = require('../headless.js');
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village', extra: extra > 0 ? extra : undefined, coarse } });
  const TICK = BF.warp.TICK;
  if (warm > 0) h.tick(Math.round(warm / TICK));
  if (reroll) for (const m of BF.mobs.list) if (m.type === 'villager') BF.rand.of(m).next();   // (the same world with other dice: the noise to judge differences by)
  BF.perf.ask(true); BF.perf.reset();
  const u0 = BF.mobs.updates(), q0 = BF.req.stats(), ticks = Math.round(seconds / TICK);
  // births: the mob list looked over every 10 ticks (a young one grows for days); deaths: js/mobs.js counts them; doors: each villager's
  // feet cell every tick, a passage each time it steps into a door or gate cell
  const seen = new WeakSet(), feet = new WeakMap(), life = { deaths: {}, births: {}, doors: 0 }, d0 = Object.assign({}, BF.perf.count.deaths), N = BF.mobs.nav;
  const look = first => {
    for (const m of BF.mobs.list) if (!seen.has(m)) { seen.add(m); if (!first && (m.child || m.growing || m.lamb || m.calf || m.piglet || m.chick)) life.births[m.type] = (life.births[m.type] || 0) + 1; }
  };
  const doors = () => {
    for (const m of BF.mobs.list) {
      if (m.type !== 'villager' || m.dead) continue;
      const x = Math.floor(m.position.x), y = Math.floor(m.position.y), z = Math.floor(m.position.z), k = x * 4096 * 4096 + z * 4096 + y;
      if (feet.get(m) === k) continue;
      feet.set(m, k);
      const b = N.blockAt(x, y, z);
      if (b.door || b.gate) life.doors++;
    }
  };
  look(true);
  for (let i = 1; i <= ticks; i++) {
    h.tick(1);
    if (i % 20 === 0) BF.perf.frame();   // the meter's window moves on about once a game second
    if (i % 10 === 0) look(false);
    doors();
  }
  for (const [k, n] of Object.entries(BF.perf.count.deaths)) {
    const d = n - (d0[k] || 0), [t, c] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    if (d > 0) { const o = life.deaths[t] || (life.deaths[t] = {}); o[c] = d; }
  }
  const T = BF.perf.totals(), byState = BF.perf.byState(), activity = BF.perf.activity(), villages = BF.perf.villageSpeed();
  const updates = BF.mobs.updates() - u0, q1 = BF.req.stats();
  // what the meter's counts are checked against (test/perf-activity.js): every mob update run, and the request queue's own counts
  const requests = { sent: q1.sent - q0.sent, applied: q1.applied - q0.applied, refused: q1.refused - q0.refused, byKind: {} };
  for (const k in q1.byKind) { const d = q1.byKind[k].sent - ((q0.byKind[k] && q0.byKind[k].sent) || 0); if (d) requests.byKind[k] = d; }
  BF.perf.ask(false);
  const villagers = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed).length;
  return {
    seed, extra, seconds, ticks, real: +T.real.toFixed(2), vss: Math.round(T.vs / T.real), msPerTick: +(T.stepMs / Math.max(1, T.steps)).toFixed(3),
    speed: +(T.game / T.real).toFixed(2), villagers, mobs: BF.mobs.list.length, byState, activity, villages, life, check: { updates, requests },
    hash: h.stateHash().hash,
  };
}

if (require.main === module) {
  try {
    const a = args(process.argv.slice(2));
    const r = measure({ seed: a.seed != null ? +a.seed : 3, seconds: a.seconds != null ? +a.seconds : 600, extra: a.extra != null ? +a.extra : 0, warm: a.warm != null ? +a.warm : 30, coarse: a.coarse, reroll: a.reroll === '1' });
    const s = JSON.stringify(r, null, 1);
    // (the game prints a few console lines of its own while it runs; --out gets the JSON alone)
    if (a.out) { fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true }); fs.writeFileSync(a.out, s); }
    console.log(s);
    process.exit(0);
  } catch (e) { console.log('FAIL ' + (e.stack || e)); process.exit(1); }
}
module.exports = { measure };
