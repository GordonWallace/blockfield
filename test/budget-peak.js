// @ci baseline suite=village
// The day's busiest hour (js/active.js peak, Gordon 2026-10-30): once a whole game day has been measured, a village joins only if the set
// would still fit in the busiest hour of the last day, and then it may join at night too. Before that, none joins at night or in the
// morning. Plain node, no browser: js/active.js runs against a stand-in world (4 villages, a quarter of the night's share per village by
// day), fed one-second measures at 1x. Usage: node test/budget-peak.js
const fs = require('fs'), path = require('path'), vm = require('vm');
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); if (!cond) fails++; };

const DAY = 1200;   // game seconds in a day (js/sky.js)
const ctx = { console };
ctx.globalThis = ctx;
const lines = [];
let realMs = 0, clock = 0;
const base = new Map(["0,0", "100,0", "0,100", "100,100"].map(k => [k, { v: null, keys: [] }]));
// villages further out to join, 300 blocks apart
const far = Array.from({ length: 12 }, (_, i) => ({ x: 2000 + i * 300, z: 0, minX: 1990 + i * 300 }));
const sky = { day: 0, time: 0.3, isNight: () => sky.time > 0.75 || sky.time < 0.02 };
ctx.BF = {
  sky,
  simNow: () => clock,
  warp: { speed: 1 },
  rworkers: { realNow: () => realMs },
  glog: { log: (l, k, x) => lines.push(l + " " + x) },
  villageSim: { count: () => base.size + A.extras().length, isActive: () => true, footprint: () => [], _edgeDist: (v, px) => v.x - px },
  worldgen: { villagesNear: (x, z, r) => far.filter(v => v.x - x <= r) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'active.js'), 'utf8'), ctx, { filename: 'js/active.js' });
const A = ctx.BF.active;
A.set({ on: true, budget: 0.8, win: 1, hold: 0, cool: 600, minFps: 0, reach: 0, morning: 0.1 }, true);

// the share of each second at 1x one village takes: 5% at night, 15% from a tenth of the day to the evening
const each = t => (t < 0.1 || t > 0.75 ? 0.05 : 0.15);
// game seconds at 1x, a second at a time (four frames each), the share as the running villages would take; decide asks after each second
let joined = [];
function run(secs, decide) {
  for (let i = 0; i < secs; i++) {
    for (let f = 0; f < 4; f++) {
      const n = base.size + A.extras().length;
      clock += 0.25; realMs += 250;
      const g = sky.day + sky.time + 0.25 / DAY; sky.day = Math.floor(g); sky.time = g - sky.day;
      A.frame(each(sky.time) * n * 250, 0.25);
    }
    if (decide) joined = joined.concat(A.decide(0, 0, base).map(x => x.key).filter(k => !joined.includes(k)));
  }
}
// the first day from 0.3 with joins off (the figures only): 4 villages
run(DAY * 0.5, false);   // to 0.8: night
ok("before a whole day has been measured there is no peak", A.peak() == null, A.peak());
const n0 = A.extras().length;
run(60, true);
ok("before a whole day has been measured, none joins at night", A.extras().length === n0, A.extras());
run(DAY * 0.2 - 60 + DAY * 0.05, false);   // to 0.05 of day 1: the morning
run(30, true);
ok("before a whole day has been measured, none joins in the morning", A.extras().length === n0, { t: sky.time, extras: A.extras() });
run(DAY * 0.73, false);   // to about 0.8 of day 1: night again, a whole day measured
const p = A.peak();
ok("after a whole day the peak is the day's share per village", p != null && Math.abs(p - 0.15) < 0.01, p);
// now at night: the measure is 4 x 5% = 20%, the busiest hour 4 x 15% = 60%; one more fits (75% <= 80%), two don't
run(30, true);
const night = A.extras().slice();
ok("at night a village joins by the busiest hour's figure: one, not as many as the night's measure would allow", night.length === 1, { t: sky.time, extras: night });
ok("its INFO line gives the busiest hour's figure", lines.some(l => /^INFO .*joins the simulated set.*60% expected in the day's busiest hour/.test(l)), lines.slice(-2));
run(DAY * 0.15, true);   // on into the morning: 5 running, 75% in the busiest hour, no more fit
ok("then no more join while the busiest hour would pass the limit", A.extras().length === 1, { t: sky.time, extras: A.extras() });
// a follower's copy (js/rplay.js world.active) carries the hours
const s = JSON.parse(JSON.stringify(A.state()));
A.reset();
ok("reset forgets the day", A.peak() == null);
A.load(s);
ok("state() and load() carry the hours", A.peak() != null && Math.abs(A.peak() - 0.15) < 0.01, A.peak());
if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
console.log("PASS budget-peak");
