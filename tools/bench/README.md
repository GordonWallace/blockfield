# 1.4 vs 1.5 benchmark

Two scripts that run the same load on a 1.4 checkout and a 1.5 checkout: the same seed (3, the big village by default) and the same
villages forced to be simulated, so villager and chunk counts match between the versions. Both versions load the extra villages the same
way (villageSim's trip pins with its limits lifted), wherever they are. 1.4 and 1.5 make the same terrain and villages from a seed.

## laptop.js: the real game on your machine

The full game in your own Chrome, drawing on your GPU, in a window placed off-screen so you don't have to watch it. It runs 1.4, then 1.5
(1.5 with its simulation in the Web Worker, as you play it), and at each speed records frame times, frames per second, the game seconds
per real second the simulation achieved, and the villagers, mobs and chunks live.

One-time setup (Ubuntu):

```
cd ~/blockfield && git fetch origin
git worktree add ~/bf-1.4 origin/release-1-4
git worktree add ~/bf-1.5 origin/release-1-5
npm i -g playwright            # uses your installed Google Chrome; without one: npx playwright install chromium
```

Run (about 15 minutes with the defaults):

```
cd ~/bf-1.5 && git pull
NODE_PATH=$(npm root -g) node tools/bench/laptop.js --b14 ~/bf-1.4 --b15 ~/bf-1.5 --villages 8 --out ~/bench-8
```

It writes `~/bench-8.md` (the comparison table) and `~/bench-8.json` (everything). Worth trying on a big machine: `--villages 16` and
`--villages 24` (the 16 or 24 villages nearest the spawn village, out to a few thousand blocks).

- Leave the window be. It can sit behind other windows or on another workspace, but don't minimise it: 1.5 pauses its simulation when the
  page is hidden. The table marks a speed where that happened.
- At start it reads the WebGL renderer. If Chrome fell back to drawing on the CPU (SwiftShader or llvmpipe) it stops, since the numbers
  wouldn't be your GPU's. `--headless` tries Chrome's headless mode instead of the off-screen window; on Linux that usually draws on the
  CPU, so the window is the default.
- Each fast-forward speed runs for one whole game day (night is much cheaper than day, and the two versions reach different speeds,
  so a fixed real time would cover different hours), at most `--maxsecs 600` real seconds; 1x runs `--secs 60`.
- Options: `--speeds 0,3,4,5` (indexes: 1x, 3x, 5x, 10x, 100x, 1000x), `--secs 60` at 1x, `--settle 60` before measuring,
  `--monsters` (off by default, since random monster spawns make the mob counts differ), `--seed 3`, `--only 1.4|1.5`,
  `--chrome <path>`.

## bench.js sim: the simulation alone

The tick cost with nothing drawn, both versions in the page on one thread (1.5 with `?sim=page`), for a list of village counts in one
world. This is the like-for-like number for "how much simulation does one core get through".

```
NODE_PATH=$(npm root -g) node tools/bench/bench.js sim ~/bf-1.4 --villages 1,4,8,16 --out ~/sim-14.json &
NODE_PATH=$(npm root -g) node tools/bench/bench.js sim ~/bf-1.5 --villages 1,4,8,16 --out ~/sim-15.json
```

Each village count is timed over a whole game day (24,000 ticks; sleeping villagers cost far less than working ones, so a shorter
slice depends on the hour). Run the two at the same time (as above) or one after the other the same way: back-to-back runs vary 10 to 25%. It prints ms per tick,
the top fast-forward the tick cost allows (game seconds per real second with a whole core), the same with the 40% budget share,
villagers, mobs and chunks. `--calm` stops monster spawns. `bench.js frames` and `bench.js budget` are the container's versions of
the frame test and of the 1.5 budget check (`?budget=40`: how many villages it keeps, at 1x or at `--speed <index>`).
