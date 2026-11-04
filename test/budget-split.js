// @ci baseline suite=village
// The simulation budget while the clusters are split over workers (js/active.js joinBy, js/rplay.js loads; Gordon's game 2026-11-03: 60
// villages forced with the first worker at 82% and seven followers at 40%, where the busiest thread's measure held joins at 17). Split,
// a village joins by the room on the least busy follower (where it goes), while the first worker is under the limit; the busiest
// thread still decides leaves. Plain node, no browser: js/active.js runs against a stand-in world (4 villages) fed one-second measures
// at 1x by day. Usage: node test/budget-split.js
const fs = require('fs'), path = require('path'), vm = require('vm');
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); if (!cond) fails++; };

const DAY = 1200;
const ctx = { console };
ctx.globalThis = ctx;
const lines = [];
let realMs = 0, clock = 0;
const base = new Map(["0,0", "100,0", "0,100", "100,100"].map(k => [k, { v: null, keys: [] }]));
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
const fresh = () => { A.reset(); A.set({ on: true, budget: 0.8, win: 1, hold: 0, cool: 600, minFps: 0, reach: 0, morning: 0.1 }, true); };
// s seconds at 1x (four frames a second), each frame's shares as given: m (the measure: the busiest thread), and split: own, land, each
function run(secs, sh) {
  for (let i = 0; i < secs; i++) {
    for (let f = 0; f < 4; f++) {
      clock += 0.25; realMs += 250;
      const g = sky.day + sky.time + 0.25 / DAY; sky.day = Math.floor(g); sky.time = g - sky.day;
      const k = 250;
      if (sh.land != null) A.frame(sh.m * k, 0.25, sh.own * k, sh.land * k, sh.each * k);
      else A.frame(sh.m * k, 0.25);
    }
    A.decide(0, 0, base);
  }
}

fresh();
run(15, { m: 0.82 });
ok("one thread at 82%: no village joins", A.extras().length === 0, A.extras());
ok("one thread at 82%: the card says the measure holds it back", /joins only below 75%/.test(A.blocker().text), A.blocker());

fresh();
run(4, { m: 0.82, own: 0.70, land: 0.40, each: 0.06 });
const n1 = A.extras().length;
ok("split, first worker 70%, least busy follower 40%, 6% a village: villages join", n1 >= 1 && n1 <= 3, A.extras());
ok("the join's log line names the least busy worker", lines.some(l => /joins the simulated set.*least busy worker 4\d%, the first worker 7\d%/.test(l)), lines.slice(-2));
// (the first second after a reset counts three frames' game time: the averages come out a little high)
ok("split: the feed has the split figures", (() => { const s = A.feed().split; return s && Math.abs(s.land - 0.4) < 0.05 && Math.abs(s.own - 0.7) < 0.07; })(), A.feed().split);

fresh();
run(15, { m: 0.82, own: 0.82, land: 0.40, each: 0.06 });
ok("split, first worker at 82% (over the 80% limit): no village joins", A.extras().length === 0, A.extras());
ok("the card says the first worker holds it back", /first worker .*is at 82%: joins only while it is under 80%/.test(A.blocker().text), A.blocker());

fresh();
run(15, { m: 0.78, own: 0.60, land: 0.77, each: 0.06 });
ok("split, least busy follower at 77% (over the 75% join line): no village joins", A.extras().length === 0, A.extras());
ok("the card says the least busy worker holds it back", /least busy worker at 77%: joins only below 75%/.test(A.blocker().text), A.blocker());

fresh();
run(15, { m: 0.75, own: 0.60, land: 0.72, each: 0.10 });
ok("split, one more village's share would pass the limit on the least busy worker: no village joins", A.extras().length === 0, A.extras());

// leaves still go by the busiest thread
fresh();
run(4, { m: 0.70, own: 0.60, land: 0.30, each: 0.05 });
const had = A.extras().length;
run(15, { m: 0.92, own: 0.92, land: 0.30, each: 0.05 });
ok("split, the busiest thread over the leave line: extras leave", had > 0 && A.extras().length < had, { had, now: A.extras() });

// a frame that isn't split (a follower's old journal: three fields) counts as one thread
fresh();
run(15, { m: 0.82 });
ok("old journal frames: as one thread", A.splitUsed() === null && A.extras().length === 0);

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
