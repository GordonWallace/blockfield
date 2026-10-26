---
title: Game log
category: Game rules
---
Every saved world keeps a game log: one timestamped line for each thing the game logs, in the order it happened. It is stored with the world in the browser, so it is there again when you load the world, and it is deleted with the world. Worlds that aren't saved (the title screen's world) keep no log.

## What a line says

```
2026-10-17 16:55:13.123  Day 3 07:15  chunk 1d 02:10  INFO   trade  Village of Ohope: Aroha Parata (Farmer) traded with ...
```

- **System time**: the date and time on your computer, to the millisecond.
- **Game time**: the game day and the time of day.
- **Chunk time**: how long the chunk where it happened has been loaded over the whole game, in game days, hours and minutes. Like a village's age, it counts only game time while the chunk is loaded. Lines with no place show `-`.
- **Level**: ERROR, WARN, INFO or DEBUG.
- **Kind** and, for village events, the village's name.

The first line of the file names the world, its seed, the game version and the commit it was started with. When you load the world with a different version or commit, a line says what changed.

## Levels

- **ERROR**: a villager's task cut off when its village unloaded (see [[page:village-loading]]), a villager or golem stuck in one place for 30 seconds of trying to walk (kind *move*), and any error the game caught or didn't catch.
- **WARN**: warnings the game prints, a session that ended without unloading the world (the tab was closed or the browser stopped), and the game's files changing on disk while it runs (reload to play the new version).
- **INFO**: the world loading and unloading, whether the world's block data is in shared memory (it is when the game is started with `./run.sh`, which serves it with the headers browsers need; opened from its file it isn't, and the game plays the same), version changes, a stuck villager or golem getting moving again (kind *move*), the world's game options as it opens and every change to them, with the monsters that left because their kind was turned off (kind *options*), the [[page:state-hash]] as each game day starts (kind *State hash*), the [[page:performance-meter]] turning on and off (kind *perf*), villages joining or leaving the simulated set for the [[page:village-loading|simulation budget]] and changes to the budget (kind *budget*), recording and replaying a session of your actions, and an edit of yours that came too late because something else changed the block first (kind *Request queue*, see [[page:state-hash]]), a summary once a game hour of the regions simulated and the time each part of a tick took, while the F3 overlay or the debug screen is open (kind *Regions*), the debug screen's alerts reaching the game and each alert that fires (kind *alerts*), and every entry of every village's log: trades, beds, births, deaths, jobs, building and the rest. With the simulation on its own thread (see [[page:performance-meter]]), INFO lines (kind *worker*) say where the simulation runs (the world server, a worker, or the page) and how long a world took to start there, and note a change to the pause menu's *Simulation* setting; a WARN says why a host you asked for couldn't run, and an ERROR gives the error if it ever stops. With the [[page:world-server]], the server keeps the log; INFO lines (kind *server*) say when the world paused and saved because its page closed and when a page picked it up again, a WARN notes a second page that was turned away, and the page logs an ERROR (and shows the log's last lines) if the server stops. Saving has its own kind, *save* (see [[page:saving]]): a DEBUG line for each save with how long it took, an ERROR when a save fails (the previous save is kept) or an import is refused, and INFO lines for exporting, importing and copying worlds to the server.
- **DEBUG**: each job's own record of what it decided and did, and births and children growing up.

A world keeps its newest 100,000 lines, about two weeks of game days with four villages loaded.

## Reading it

Start the game with `./run.sh` and open the debug screen. The **Game log** button at the top (it counts the errors) opens the log above everything else, newest first, and updates live. Filter it by level (DEBUG starts hidden), by kind of event, by village and by villager type, or search it. **Copy** puts the lines shown by the filters on the clipboard, oldest first, under the header; **Download** saves the same as a `.log` file named after the world.

The commit is known only when the game is served by `./run.sh`; otherwise the log says it is unknown.
