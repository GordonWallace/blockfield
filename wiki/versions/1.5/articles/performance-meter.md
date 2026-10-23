---
title: Performance meter
category: Game rules
---
The performance meter measures how much simulation the game gets through. Its main number is **villager-seconds per second** (V·s/s): the game seconds simulated each real second, times the villagers loaded. Speed and headcount trade one for one, so 20 villagers at 50x and 100 villagers at 10x are the same 1,000 V·s/s. Release 1.5 uses it to measure every change to how the simulation runs.

## Where it shows

- **F3**: the second line of the overlay, for example `Sim 774 V·s/s  1488 mob-s/s  3.2 ms/step  (villagers 2.23, monsters 0.09, ...)`.
- **Debug screen** (`./run.sh`, then the debug screen on port 8001): the **Performance** card at the top shows V·s/s, the game speed it ran at, ms per step, mob-seconds per second, the villagers and mobs loaded, a bar for each part of the step and a sparkline of V·s/s over the last 2 minutes.

## What the numbers mean

- **V·s/s**: villager-seconds of game time per real second. With no villagers loaded it is 0.
- **mob-s/s**: the same for every loaded mob (villagers, golems, animals and monsters).
- **ms/step**: real milliseconds per simulation step. A step is the game's unit of simulation: 0.05 game seconds or less at 1x, and 0.05 seconds at 100x and 1000x.
- **The split**: ms per step for each part:
  - *villagers*: villagers' own updates and the village systems (building, jobs, meals, breeding, chests, trading, restocking, day timelines);
  - *monsters*: monsters' updates and monster spawning;
  - *wild animals*: wild animals' updates and the wildlife bookkeeping;
  - *village animals*: penned and village animals, iron golems, bees, and the shepherd, stable, coop, pasture and sty bookkeeping;
  - *streaming*: loading chunks and rebuilding their meshes. This happens once a frame, so it is shared out over that frame's steps;
  - *world*: sky, block ticks, furnaces, drops and boats;
  - *other*: mob bookkeeping (crowding, arrows, despawning, saving mobs).

All of them are averaged over the last 5 seconds of real time. When the game is frozen (0x) or paused, the meter keeps its last figures and greys them out.

The meter runs only while the F3 overlay or a debug screen is open (or a test asks for it), so it costs nothing in normal play. Turning it on and off writes a line to the [[page:game-log]] (kind *perf*), and the line for turning it off gives the last figures.

## Measuring on your own computer

The `tools/perf/` folder in the repository holds the harness that measures the simulation without drawing: `perfmobs.js` runs a village for some game hours and records the meter's figures each hour, `live.js` measures the real frame loop at the top fast-forward speed, `analyze.js` summarises runs and `profsum.js` reads CPU profiles. Its README says how to run them.
