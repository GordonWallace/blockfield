# Simulation performance harness

Measures how much simulation Blockfield gets through, with the villager-seconds meter (`js/perf.js`, `BF.perf`, spec r15-01). Every 1.5
change to how the simulation runs reports its before and after numbers from here. (`tools/perf.js`, one level up, is the older whole-game
benchmark: start-up, frame cost while flying, memory.)

All of them drive headless Chromium and need playwright: `NODE_PATH=$(npm root -g)` (or `PW=<path to playwright>`). three.js comes from
`.three-test.min.js` like the tests. Headless Chromium draws with SwiftShader (the CPU), so compare numbers from the same machine.

## The numbers

- **V·s/s**: villager-seconds of game time simulated per real second (game seconds per real second times villagers loaded). Speed and
  headcount trade 1:1, so this is the figure to compare.
- **mob-s/s**: the same over every loaded mob.
- **ms/step** and **the split**: real ms per 0.05 s simulation step, and that step by part: villagers (AI and the village systems),
  monsters, wild animals, village animals (pens, golems, bees), streaming (chunk loading and remeshing, per frame, spread over the
  frame's steps), world (sky, block ticks, furnaces, drops, boats) and other (mob bookkeeping). The parts add up to ms/step.

In the game, the F3 overlay and the debug screen's Performance card show the same figures (the meter runs while either is open).
In a page, `BF.perf.ask(true)` turns it on, `BF.perf.stats()` reads the last 5 s, and `reset()` / `totals()` count from a point.

## Scripts

- `perfmobs.js [repo=.] [variant=all] [hours=36] [seed=1] [out.json]`: simulation only. A creative player hovers over the village nearest
  spawn; the harness steps the simulation (`BF.simStep(0.05)`) for the given game hours and records, per hour, V·s/s, ms/step, the split
  and mob counts. Variants remove mobs to see what they cost: `nohostile`, `noanimals` (wild animals), `nowild` (both), `noanim` (no mob
  animation), `nowild_noanim`. `PROFILE=<hour>` also writes `<out>.cpuprofile`.
- `live.js [repo=.] [variant=all] [seed=1] [secs=60] [WxH=800x450]`: the game's own frame loop, drawing, at the top fast-forward speed
  after a warm-up; reads the meter every 5 s.
- `analyze.js run1.json run2.json ...`: averages each perfmobs run over game hours `FROM`..`TO` (default 24..48, day 2). `JSON=1` for JSON.
- `profsum.js file.cpuprofile [top=40]`: self time by file and by function.
- `activity.js [--seed 3] [--seconds 600] [--extra n] [--warm 30] [--out file.json]` (spec r15-60): headless, no browser
  (`tools/headless.js`). Prints three tables as JSON: `byState` (mob updates and µs per update by class, villager / village animal / wild /
  hostile / golem, and by the state before the update: idle, route, wander, work, sleep), `activity` (per villager-second: requests by kind,
  path searches, trades, items gained and spent; `events` = requests + path searches) and `villages` (each village's ms per tick, its mobs
  plus its share of the village systems, and the top speed that allows, 50 / ms, busiest first). `--extra 8` is the 9-village load.
  A spec that makes villagers cheaper shows `byState` and `villages` going down while `activity` stays the same. `test/perf-activity.js`
  runs it in CI (seed 3, `--extra 8`, 600 s) and writes ci-out/activity.json. In a page: `BF.perf.byState()`, `.activity()`,
  `.villageSpeed()`, all since `BF.perf.reset()`.
- `onevillage.js` (spec r15-65): whether one village could be split over cores. `--mode collide` (requests from two mobs at one target
  in one tick, over a game day), `access` (fields thinking reads and writes on other mobs and village records), `changes` (what each
  think changes on its own mob), `split` (mob loop against the rest of the tick, the best split over n cores, a shared-memory mirror's
  cost), `barrier` (an Atomics meeting between worker_threads) and `shuffle` (mobs think in a random order: the hash should not move).
  Findings: /mnt/project-files/reports/r15-65.md.
- `lib.js`: the shared harness (boot, go to the village, run steps with the meter on, averages). `test/perf-soak.js` uses it too.

Example, comparing two checkouts on one machine (seed 3 is the big village):

```
git worktree add /tmp/before origin/release-1-5
node tools/perf/perfmobs.js /tmp/before all 48 3 /tmp/before-s3.json
node tools/perf/perfmobs.js . all 48 3 /tmp/after-s3.json
node tools/perf/analyze.js /tmp/before-s3.json /tmp/after-s3.json
```

Runs side by side slow each other down (about 20% with three at once on 4 cores); run the before and after the same way.

## CI

`test/perf-soak.js` (integration, suite world, soak) runs seed 3 for 2 game days and writes `ci-out/perf.json` (day 2's V·s/s, ms/step,
split and counts, and every hour). It reports and never fails on a number: shared runners are too noisy. `test/perf-meter.js` (suite ui)
checks the meter itself.
