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
- **Debug screen, Threads card**: how busy each of the game's threads is: the page (drawing and input), the simulation, each region worker, and the debug server (or the world server's main thread). Each bar is the share of the last minute the thread spent working, with the last second in brackets; time a worker spends waiting for the others at the end of a split tick doesn't count. A browser can't tell which core a thread runs on, so below the threads the card draws one bar per core of the computer the debug server runs on, as the operating system reports it (green under half busy, yellow, then red over 85%), with a white tick for each core's average over the last minute.
- **Debug screen, Mobs map**: with **Regions** on, each region is coloured by the worker that thinks for its mobs, shaded darker the more mobs it holds. Workers aren't strictly split by land: a village's villagers, pen animals and golems all think on the village's worker wherever they stand, while wild animals and monsters go by the region they're in, so a region can hold mobs of more than one worker. Such a region is drawn in stripes, one band per worker, each as tall as its share of the region's mobs. Each village is outlined in its worker's colour and named with it. The legend under the map names each worker's colour, how many regions it has most of the mobs in, and how busy its thread is; the colours match the Threads card. With one worker thinking, every region is the simulation's colour.
- **[[page:world-server|Pause menu]]**: the *Simulation* button says `World server (N threads)`.
- **[[page:game-log]]**: INFO lines (kind *workers*) say how many workers a world got, when they are ready, when the thinking is split and whether the split paid. An ERROR says if a worker crashed or the copies stopped matching.

## If a worker crashes

While the thinking is split, a worker that crashes stops the simulation: the game shows the error and offers to reload from your last save, as it does for any crash of the simulation, and the error goes to the game log. While one worker is thinking, a follower that crashes is just dropped and the game goes on with one.

Saving is unchanged: the thread that leads holds the whole world between ticks, so it saves as it always did.

## Clusters (in progress)

Region workers never pay off much, because every worker has to keep its whole copy of the world in step every tick. Version 1.5 is moving to **clusters** instead: each village and the land round it (about half the way to the next village) runs on its own, and clusters only pass things to each other once a game second, at a *meeting*. Something that crosses from one cluster to another, like a request aimed at a mob over the border, waits for the next meeting, at most one game second. That happens on one worker too, so the world plays exactly the same with any number of workers.

What one cluster may know about another village comes from the *shared table*: at each meeting every simulated village publishes a summary (its prices and the goods it offers, its population), stamped with the moment it describes, and until the next meeting everyone reads that. [[page:caravans|Caravans]] already work this way: a merchant plans its trip from the other village's row in the table, is handed over to the other village's cluster at the meeting after it arrives and trades there, and goes back to its home's cluster at the meeting after it comes home (it waits at the edge of the village for up to a second until then). A new trip asks for its place on the road at the next meeting, where at most two are let out, lowest merchant first; which villages are simulated is decided at meetings too.

The groundwork is in the game but off: with it off, the world plays exactly as before. The game's systems (mobs, village life, animals, caravans, blocks) are being moved over one by one. When the clusters are turned on, the [[page:game-log]] notes it, and an ERROR names any cluster whose tick fails.

Moved over so far: the mobs' thinking, and the mobs and wild life around them. With clusters on, each cluster spawns its own monsters in its own chunks (each chunk with the same odds as before), rolls and stores the wild animals of its own chunks, and moves its own dropped items, arrows and boats (a boat goes with the cluster of the mob sitting in it). A cluster away from yours sees you where you were at the last meeting. A wild mob that wanders off the loaded land into a chunk of another cluster waits there until the next meeting, and then that cluster stores it with its chunk.

The world's own ticks already run by cluster: flowing water, crops and sugar cane, saplings, farmland drying out, grass spreading, crops catching up in reloaded chunks, and furnaces and bakers' ovens. Each cluster ticks only its own blocks. A block right at a border, whose tick would look at or change the other cluster's blocks (water flowing over the border, a tree growing across it), waits for the next meeting and is done there, so water still crosses from one cluster to the next, a second at a time. With the clusters on, chunks also arrive and leave only at meetings: a chunk generated in between waits, at most a second, before it appears.

Village life has moved over: builders, jobs, breeding, storage, bakers, explorers, restocking, the day timeline, village stats, foresters and signs each run per cluster, and a village's records belong to its own cluster. A new village is set up at a meeting, which the [[page:game-log]] notes.

The animals have moved over: sheep pens, chicken coops, cow pastures, pig sties, horses and their herds, stables and bees each run with the cluster they belong to (a pen with its village, a horse with where it is or was last seen, a herd with where it was at the last meeting, bees with their home). With the clusters on, two things play a little differently: at most 600 bees are out at once in each cluster rather than in the whole world, and only bees in the player's own cluster follow a flower the player holds (the others are too far away to see it anyway).

## What it costs

Each worker holds a full copy of the world, so each one takes about as much memory as the simulation does on its own. On a machine with little memory, `--workers 1` or a small number is the better choice.
