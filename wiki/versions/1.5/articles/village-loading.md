---
title: Village loading
category: Villagers
---
Villagers only exist while the ground under them is loaded. To keep villages alive when you are not beside them, the game runs the nearest few villages in the background, without drawing them, and shuts each one down cleanly when you are far away. This page describes what runs, when a village stops, and what happens when you come back.

## Which villages run
- A village **turns on** when you come within 200 blocks of its edge. Distances are measured from the edge of the village, not its centre, so a big village starts earlier.
- It **keeps running** until you are 216 blocks from its edge. The 16 blocks of slack stop a village from flickering on and off as you walk along the boundary.
- At most the nearest 4 villages run, and together they may hold at most 640 chunks of terrain. A very large village can therefore push the others out.
- A village whose edge is within 100 blocks of you **always** runs, whatever the limits.
- A village that a [[page:caravans|caravan]] is travelling to or from also runs until the trip is over.

These rules are the **minimum**. Villages beyond the nearest four stay simulated when the computer has time to spare (see "More villages when the computer has time to spare" below).

A running village keeps the terrain of its area and 16 blocks around it loaded as data only. Its villagers follow their normal day: [[villager:farmer|farmers]] farm, [[villager:builder|builders]] build, everybody eats, trades and sleeps. A villager who walks out of the village, such as a [[villager:forester]] or a [[villager:shepherd]] leading a sheep, keeps a window of 5 by 5 chunks around itself loaded, so it always has ground to walk on.

On the [[page:the-planet|planet]] these distances are measured on the planet itself, across the edges between the cube's faces. A villager who walks over an edge keeps its ground loaded on the far side, and a caravan's road is kept loaded the whole way, whichever faces it crosses. Villages always sit several hundred blocks from a face edge (see [[page:villages]]), so the 200 and 216 block limits are always reached on the village's own face.

## More villages when the computer has time to spare
Beyond the nearest villages, the game keeps adding villages, nearest first, as long as the simulation keeps up at normal speed. The pause menu's **Distant villages** button shows how many villages are running, for example "Distant villages: 14 simulated (up to 80% of each second)". Click it to open the settings. Click a line to move it to its next choice. Your choices are remembered.

- **Villages**: *Automatic* (the default) runs as many villages as your computer can at normal speed, nearest first. *Nearest only* keeps just the nearest villages from the rules above.
- **Time limit**: the most of each real second the simulation may take. *Automatic* (the default) is 80% when the simulation has a thread of its own (the [[page:world-server]] or a worker in the browser) and 40% when it runs in the page, which also has to draw the frames. You can also pick 20%, 40%, 60%, 80% or 100%.
- **Distance limit**: *None* (the default), or 500, 1000, 2000, 4000 or 8000 blocks. With no limit, the game looks farther out whenever the nearer villages are all running.
- **Memory limit**: the most memory the extra villages' terrain may take between them (a village holds about 5 to 7 MB). *Automatic* (the default) is a quarter of the computer's memory, between 500 MB and 8000 MB (at most 2000 MB in a browser). You can also pick 250 MB up to 8000 MB.
- **Cluster workers**: see [[page:several-cores]]. This one applies from the next world you start; the others apply at once.

The time limit is measured as the time the simulation would need at normal speed, so fast-forwarding doesn't push villages out: the set stays the one your computer runs at 1x, and fast-forward just runs slower than asked if it doesn't fit.

- If the simulation has needed less than the limit for 10 seconds in a row, the next nearest village that is not running yet starts running too. If there is room for several, up to 3 join at once. A village loads exactly as a nearby village does, and its villagers come out and carry on with their day. Villages are only added if the time they are expected to take still fits within the limit.
- If the simulation has needed more than the limit for 10 seconds in a row, the farthest of these extra villages stops, through the usual countdown below, so its villagers finish their tasks first. It is not picked again for 5 minutes.
- Nothing is stopped within 60 seconds of a village being added, and no village is added while the game runs under 30 frames a second at normal speed. This keeps the set from flickering.
- An extra village beyond the distance limit stops the same way.
- On a slow computer the game never runs fewer villages than the minimum rules above.
- Extra villages do not count toward the safety valve's limits below. While any are running, the limit sheds them instead of the safety valve stopping villages.

Each change to these settings, and each village that joins or leaves, with the reason, is an INFO line in the world's [[page:game-log]] (kind *budget*). So is reaching the memory limit or running out of villages within reach. The debug screen's Simulation budget card shows how many villages are simulated (the nearest ones the rule above keeps, plus the extras), the share of each second the simulation needs at normal speed against the limit, the extra villages and the latest decisions.

## The countdown before a village stops
When a village would stop, because you moved away, because other villages pushed it out of the nearest four, or because the simulation went over its budget, it does not stop at once. It counts down.

1. Each villager works out how long it needs to finish what it is doing: the walk there and back and the work itself, plus a 25% margin. A [[villager:builder]] times its own pace while it builds and bases the estimate for the rest of the structure on it. A [[villager:forester]] uses the time limit it sets each task instead, because it gives a task up once that limit has passed.
2. The longest estimate sets the village's timer. It is never longer than 2 game days.
3. While the timer runs, a villager that finishes a task only starts a new one if the new one will end before the timer does. Otherwise it idles near home. Short jobs still start.
4. Waiting does not count as a task, such as a villager with nobody to trade with. A villager asleep in bed or a child holds nothing up. Nor does leisure: strolling around the village, relaxing, loafing or wandering about, winding down for the evening, looking for work, heading out for the day or to bed, having no bed, being in love, running from a zombie, a [[villager:forester]] between tasks (looking for saplings or holding saplings to plant) and a [[villager:builder]] planning its next structure, admiring the one it just finished, or waiting for materials nobody sells yet ("Looking for"). Leisure just ends when the village unloads; a villager at leisure outside the village is put back home, and the village log says so.
5. If you come back within range, the countdown is cancelled and the village carries on.
6. When the timer reaches zero, the village unloads **together with all its villagers**, its iron golems and the animals that belong to its pens, coops, pastures and paddocks. Nobody is ever unloaded without their village.

If a villager is still out on an errand when the timer ends, the game logs a loading error, with the task's own estimate and how long it had been running, and unloads the village anyway. [[villager:explorer|Explorers]] do not hold up the timer: they unload with their village wherever they are, and are put back exactly where they stood when it returns. A [[villager:merchant]] on a caravan trip counts as one long task, and no merchant starts a long trip while its village is counting down.

On the debug screen each village shows how long it has before it unloads, a list of what each villager is doing with its estimate, and the list of loading errors. Each loading error is also an ERROR line in the world's [[page:game-log]].

## When the game gets heavy
A safety valve stops villages early if the game would otherwise slow down. It acts when any one of these is over its limit:

- more than 1500 chunks held for villages beyond your view distance;
- more than 300 villager thinking updates a game step, averaged over about 5 game seconds (about 6 milliseconds of thinking). It counts work rather than measuring time, so the same villages stop on a fast computer and a slow one;
- more than 10 villages running or counting down.

Extra villages running for the budget are left out of these counts, and the second limit is not checked while any of them run: the budget takes them off gracefully first.

Villages are then stopped one at a time until all three are under their limits, in this order: villages counting down (farthest first), then villages a merchant is travelling to and has not yet reached, then running villages beyond 100 blocks of you (farthest first). A village within 100 blocks is never stopped this way.

Each villager stopped in the middle of a job is dealt with so that nothing is lost or made from nothing:

- A merchant on a trip goes home with its cargo; the trip ends, and what it could not sell becomes ordinary spare goods.
- A villager at a furnace or oven, such as a toolsmith smelting ore, takes out the product, all the fuel left and the input it put in.
- A villager leading an animal lets it go.
- A trade in progress is cancelled before anything changes hands.
- Any other villager who is out beyond the edge of the village on an errand, such as felling a tree or mining, is put back at its bed with whatever it has gathered.
- A builder inside the village simply stops: the structure's progress is saved and it carries on later.

Each forced stop is written to the loading errors, with the reason.

## Far villages: full detail or coarse
Each world has a game option, **Far villages**, that sets how villages beyond your view distance are simulated. It is *Full detail* unless you change it. Set it when creating a world, from *Options* on a world's row on the title screen, or in game from *Game options* in the pause menu (see [[page:mob-spawning|game options]]). It is saved with the world, and a change in game applies from the next tick.

- **Full detail**: every running village is simulated the same way, wherever you are.
- **Coarse (faster)**: villagers, golems and village animals farther away than your view distance think 4 times a game second instead of 20. A villager walking somewhere follows its route cell by cell at its usual speed, still opening doors and gates, instead of moving with full physics. Idle strolls about the village that achieve nothing are skipped. They do the same work as at full detail: the same jobs, trades, items made and used, births and deaths, to within a few percent, for less computer time, so more villages fit in the simulation budget.
- Anything in a fight is always simulated in full: a villager fleeing a zombie it can see, a golem with a foe or a villager to rescue, and any mob that was just hit, until a few seconds after it ends. A zombie that only wanders past a village doesn't change anything. Monsters and wild animals far away already think 4 times a game second either way.
- When you come within view distance of a coarse village, its mobs go back to full detail at the spot they had reached on their way. That happens out of sight, so nothing jumps.

The F3 overlay shows the mode on its own line: `Far villages: coarse (120 mobs)` or `Far villages: full detail`. The [[page:game-log]] notes each village switching (kind *coarse*).

Working out a new route is the costliest thing a mob does, so the game rations it: each tick hands out 2 route searches for every running village (at least 2), to the mobs that have waited longest. Before, the whole world shared 2 a tick, so with many villages running, villagers far away could wait many seconds for a route and stood idle meanwhile. Now every running village does its share of work wherever it is.

## Quitting and loading again
If you save, quit and load straight away, no game time has passed, so everything that was loaded comes back as it was: villagers, golems, wild and hostile mobs, each in the same place, facing the same way, with the same health and the same job. A village with several golems gets each of them back at its own spot. If more than about 24 seconds of game time have passed, villagers return to the usual places instead.

## Coming back to a village
- **Short absence.** If the village was unloaded for less than a game hour and bedtime did not come in between, everyone is exactly where they were.
- **A longer absence, by day.** Each villager appears at a random spot in the village within 40 blocks of its bed, or near the village centre if it has none. Explorers always appear at their saved spot.
- **At night.** Villagers with a bed appear in it. A villager with no bed appears inside a building.
- Animals appear in their pens, and golems somewhere in the village.
- The first time a village is ever loaded is unchanged: its villagers start at home.

## What happens while a village is away
While a village is unloaded, time still passes for it where that is cheap to work out. When it is next loaded:

- young crops on its farmland have grown with the chance they would have had over the days away;
- villagers' meals and daily restocks count the game days that passed;
- its prices are written down when it first loads and again as it unloads, so that merchants elsewhere can plan trips to it.

Not caught up: building progress, farmers' harvests and explorers' trips. Those only happen while the village is running. See [[page:villager-life]] and [[page:village-economy]].
