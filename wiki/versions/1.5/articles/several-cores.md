---
title: Using several cores
category: Game rules
---
From 1.5 the simulation can use several of your computer's cores at once. Besides the thread the simulation already runs on (the [[page:world-server]], or a worker in the browser: see [[page:performance-meter]]), the game starts **region workers**: more threads, each holding a whole copy of the world. When the simulation is busy, the mobs' and villagers' thinking for each tick is shared out between them, a village (with its villagers, its animals and its horses) or a region of the wild at a time, and every worker then takes in what the others decided, so all the copies stay the same.

## How many

By default the game starts one worker for every core but two (left for the page and the rest of your computer), at most 8, and at least one. A computer with 4 cores gets 2, one with 24 cores gets 8.

- `./run.sh --workers <n>` (or `run.cmd --workers <n>`) sets the number for the [[page:world-server]]. `--workers 1` turns the region workers off.
- In the browser, adding `?workers=<n>` to the game's address does the same for that visit.
- The browser needs the page served with the headers that allow shared memory (`./run.sh` and its debug server send them). A page opened as a file, or served by another web server, runs on one worker, and F3 says why.

## When it splits

Splitting a tick between threads costs time of its own: every worker sends the others what its mobs did, and waits for them. With a village or two loaded, one thread is faster, so the game only splits when it would help:

- While the simulation keeps up with the speed you chose, one worker thinks for everything and the others just follow along, replaying the same ticks to keep their copies up to date.
- When ticks have been dropped for 2 seconds (fast-forward asking for more than the machine gives), the game tries the split for 200 ticks. If ticks got at least 10% faster it keeps it; if not, it goes back to one and waits before trying again (longer each time it didn't pay).
- `?split=always` or `?split=never` on the address (`./run.sh --split always|never` for the server) overrides that, for testing and measuring.

Whether it splits or not, the world plays exactly the same: the same mobs do the same things on the same ticks with 1, 2 or 8 workers (the tests compare the [[page:state-hash]] after a game day with each). While split, the copies are compared every 5 game minutes; if they ever differ, the game logs an error and goes on with one worker.

## Where it shows

- **F3**: a line starting `Workers`. With one worker thinking it says how many follow and how far behind they are, for example `Workers 3: one thinks (2/2 followers ready, 0 ticks behind; 9.9 ms a tick, splits when ticks drop)`. Split, it gives the regions and mobs each worker had and the milliseconds of each part of a tick: `Workers 2: regions 19/1, mobs 136/71  think 4.3  exchange 11.1  rest 4.0 ms`.
- **Debug screen**: the **Workers** card shows the same, per worker.
- **[[page:world-server|Pause menu]]**: the *Simulation* button says `World server (N threads)`.
- **[[page:game-log]]**: INFO lines (kind *workers*) say how many workers a world got, when they are ready, when the thinking is split and whether the split paid. An ERROR says if a worker crashed or the copies stopped matching.

## If a worker crashes

While the thinking is split, a worker that crashes stops the simulation: the game shows the error and offers to reload from your last save, as it does for any crash of the simulation, and the error goes to the game log. While one worker is thinking, a follower that crashes is just dropped and the game goes on with one.

Saving is unchanged: the thread that leads holds the whole world between ticks, so it saves as it always did.

## Clusters (in progress)

Region workers never pay off much, because every worker has to keep its whole copy of the world in step every tick. Version 1.5 is moving to **clusters** instead: each village and the land round it (about half the way to the next village) runs on its own, and clusters only pass things to each other once a game second, at a *meeting*. Something that crosses from one cluster to another, like a request aimed at a mob over the border, waits for the next meeting, at most one game second. That happens on one worker too, so the world plays exactly the same with any number of workers.

The groundwork is in the game but off: with it off, the world plays exactly as before. The game's systems (mobs, village life, animals, caravans, blocks) are being moved over one by one. When the clusters are turned on, the [[page:game-log]] notes it, and an ERROR names any cluster whose tick fails.

## What it costs

Each worker holds a full copy of the world, so each one takes about as much memory as the simulation does on its own. On a machine with little memory, `--workers 1` or a small number is the better choice.
